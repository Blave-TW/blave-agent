/* 手機 App 跟這台電腦的 agent 對話(主行程用;spec mobile-agent-chat-mvp §1.3、§2.6–§2.7、§3.2、§4)。
 *
 *   - 收件:25 秒長輪詢 /relay/poll(同雲端 web_bridge 的 poll／ack／report),交給回合表(startTurn(…, "mobile"))就 ack;
 *     回合跑到一半掛掉不重送。同一條對話在跑就排在它後面(只放記憶體),回報 queued、輪到時回報 started。
 *   - 回傳:手機那一輪的 chunk 每 300 毫秒一批 /relay/report,文字欄位先過 redact.js(§4.3)。
 *   - 對話紀錄:開著時把這台近 30 天的對話遮蔽後上傳(/relay/sync_state → /relay/sync,一批 ≤ 100 則／512 KB、每秒一批),
 *     每一輪結束補新的那幾則。電腦上刪的對話寫進 state/relay-outbox.jsonl,連上時送 session_delete。
 *   - 兩顆憑證只在主行程:不寫檔、不 log;第 1 條遮蔽要比對的值也只在記憶體。
 *   - 平台總開關(/relay/enabled)不是開:不收、不傳、設定頁不出這一區。讀不到 = 關。
 *
 * 不 require electron;HTTP、時鐘、回合表、session.db 都由呼叫端注入(tests/check_shell_relay.js 用假的)。
 * 端點路徑與 body 鍵全在下面這一塊:api 那邊照 spec 契約做,對不上就改這裡。
 */
const fs = require("fs");
const path = require("path");
const { redact } = require("./redact");
const { deviceOf } = require("./mobileview");

const EP = {
  enabled: "/oauth/desktop/relay/enabled",   // → { enabled }
  enable: "/oauth/desktop/relay/enable",
  disable: "/oauth/desktop/relay/disable",   // 同時刪伺服器上這台的對話(§4.4)
  poll: "/oauth/desktop/relay/poll",         // body + ver → { messages: [webchat inbox 訊息], controls: [...] }
  ack: "/oauth/desktop/relay/ack",           // body + message_ids
  report: "/oauth/desktop/relay/report",     // body + session_id + chunks
  syncState: "/oauth/desktop/relay/sync_state",   // → { sessions: { <sid>: <最後一則的 id> } }
  sync: "/oauth/desktop/relay/sync",         // body + sessions: [{ session_id, title, last_at, turns: [{ id, role, origin, content, created_at }] }]
};
const OFF_CODE = "APP_CHAT_OFF";
const POLL_HOLD_MS = 25000, POLL_TIMEOUT_MS = 40000, REQUEST_TIMEOUT_MS = 10000, QUIT_TIMEOUT_MS = 3000;
const FLAG_TICK_MS = 2 * 60 * 1000;
const BATCH_MS = 300;
const BACKOFF_MIN_MS = 2000, BACKOFF_MAX_MS = 60000;
const SYNC_DAYS = 30, SYNC_MAX_SESSIONS = 200, SYNC_PER_SESSION = 500;
const SYNC_BATCH_TURNS = 100, SYNC_BATCH_BYTES = 512 * 1024, SYNC_GAP_MS = 1000, TURN_MAX_BYTES = 32 * 1024;
const MESSAGE_MAX_BYTES = 1024 * 1024;   // = main.js / runtime 的 stdin 上限
const MSG_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const NEW_SID_RE = /^desktop-m[a-z0-9]{3,15}$/;   // api 替手機開的新對話(§3.2);其他的必須是這台已經有的
const TITLE_MAX = 60;
const OUTBOX = "relay-outbox.jsonl";
const ERR_CODE_RE = /^[A-Z][A-Z0-9_]{2,39}$/;

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((resolve) => { const t = setTimeout(() => resolve(null), ms); if (t.unref) t.unref(); })]);
}
/* 字串一律過遮蔽:不猜哪些欄位是文字(chunk 的形狀 runtime 會加),數字、布林原樣 */
function scrubDeep(v, known) {
  if (typeof v === "string") return redact(v, known);
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, known));
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = k === "session_id" || k === "type" || k === "message_id" ? v[k] : scrubDeep(v[k], known); return o; }
  return v;
}
/* 截到 maxBytes 以內(按字,不切半個字)再加「…」 */
function clipBytes(s, maxBytes) {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let out = "", n = 0;
  for (const ch of s) { const b = Buffer.byteLength(ch, "utf8"); if (n + b > maxBytes - 3) break; out += ch; n += b; }
  return out + "…";
}

/* opts:{ dir(userData), stateDir(BASE/state), apiBase, post(url, body, extra), getCreds(), installId(), ver, now?, log?,
          startTurn(payload, origin) → { started|queued|busy|blocked }, stopTurn(sid), turnBusy(sid), isRestarting(),
          sessions: { list() → [{ id, last, title }], rowsAfter(sid, afterId, limit) → [{ id, role, content, created_at }], maxId(sid),
                      exists(sid), remove(sid) → bool },
          turnArgs() → { model, effort }(電腦當下存的那一組), known() → [值](第 1 條), origins: { add(sid, ids), has(sid, id) },
          track(name), onChange(state), onMobileActive(bool) } */
function createRelay(opts) {
  const file = path.join(opts.dir, "relay.json");
  const outboxFile = path.join(opts.stateDir, OUTBOX);
  const clock = opts.now || (() => Date.now());
  const log = opts.log || (() => {});
  let st = null, flag = false, polling = false, pollGen = 0, flagTimer = null, stopped = false, quitting = false;
  let seenToken = null, lastToken = null;   // 上一顆帳號 token(輪替後幾秒內的輸出可能還帶著它):第 1 條也比對
  const queue = new Map();   // sid → [{ message_id, content }]:同一條在跑時排在後面
  const active = new Map();  // sid → { message_id, ended, idBefore }:正在跑的手機那一輪
  const batches = new Map(); // sid → [chunk]
  let batchTimer = null, reporting = null;
  const sync = { running: false, done: 0, total: 0, error: false, firstOk: false, lastIds: null, again: new Set() };

  function load() {
    if (st) return st;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { /* 沒檔 = 預設關(§2.6) */ }
    st = { on: !!(raw && raw.on === true), pendingDisable: !!(raw && raw.pendingDisable === true), synced: !!(raw && raw.synced === true) };
    return st;
  }
  function save() {
    try { const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(load()), { mode: 0o600 }); fs.renameSync(tmp, file); }
    catch (_) { /* 記不住:最壞是下次啟動忘了待刪,api 30 天無活動自己清 */ }
  }
  const creds = () => { const c = opts.getCreds(); return c && c.token && c.appSecret ? c : null; };
  const device = () => deviceOf(opts.installId());
  function body(extra) {
    const c = creds(), dev = device();
    if (!c || !dev) return null;
    if (seenToken && seenToken !== c.token) lastToken = seenToken;
    seenToken = c.token;
    return { token: c.token, app_secret: c.appSecret, device: dev, ...(extra || {}) };
  }
  function known() {
    const c = creds();
    let vals = [];
    try { vals = (opts.known && opts.known()) || []; } catch (_) { vals = []; }
    return [...vals, ...(c ? [c.token, c.appSecret] : []), ...(lastToken ? [lastToken] : [])];
  }
  async function call(ep, extra, timeoutMs) {
    const b = body(extra);
    if (!b) return { status: 0, body: null, noCreds: true };
    let r = null;
    try { r = await withTimeout(opts.post(opts.apiBase + ep, b, { timeout: timeoutMs || REQUEST_TIMEOUT_MS }), (timeoutMs || REQUEST_TIMEOUT_MS) + 1000); } catch (_) { r = null; }
    if (r && r.status === 403 && r.body && r.body.error_code === OFF_CODE) { setFlag(false); }
    return r || { status: 0, body: null };
  }
  function changed() { try { if (opts.onChange) opts.onChange(state()); } catch (_) { /* 畫面壞掉不擋 */ } }
  function setFlag(v) { if (flag === v) return; flag = v; if (!v) stopPoll(); changed(); }
  const live = () => flag && load().on && !load().pendingDisable && !!creds() && !stopped;
  function mobileActiveSync() { try { if (opts.onMobileActive) opts.onMobileActive(active.size > 0 || [...queue.values()].some((q) => q.length)); } catch (_) { /* 防睡壞掉不擋 */ } }
  const track = (n) => { try { if (opts.track) opts.track(n); } catch (_) { /* 追蹤不擋 */ } };

  async function refreshFlag() {
    const r = await call(EP.enabled);
    if (r.noCreds) { setFlag(false); return false; }
    setFlag(!!(r.status === 200 && r.body && r.body.enabled === true));
    return flag;
  }

  /* ── 回報 ─────────────────────────────────────────── */
  function enqueueChunk(sid, chunk, now) {
    const arr = batches.get(sid) || []; arr.push(chunk); batches.set(sid, arr);
    if (now) return flush();
    if (!batchTimer) { batchTimer = setTimeout(() => { batchTimer = null; flush(); }, BATCH_MS); if (batchTimer.unref) batchTimer.unref(); }
    return reporting || Promise.resolve();
  }
  /* 一次只有一筆在路上,順序照收到的;送不出去的留著下一批再送(總量有上限,不會無限長) */
  function flush() {
    if (reporting) return reporting.then(() => (batches.size ? flush() : undefined));
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    if (!batches.size && !outboxRead().length) return Promise.resolve();
    reporting = (async () => {
      try {
        for (const [sid, chunks] of [...batches.entries()]) {
          batches.delete(sid);
          const r = await call(EP.report, { session_id: sid, chunks }, quitting ? QUIT_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
          if (r.status !== 200 && r.status !== 400 && r.status !== 403 && !r.noCreds && !quitting) {
            const back = batches.get(sid) || [];
            if (back.length + chunks.length <= 2000) batches.set(sid, [...chunks, ...back]);
            log("relay: report not sent (" + (r.status || "offline") + ")");
            break;
          }
        }
        await outboxFlush();
      } finally { reporting = null; }
    })();
    return reporting;
  }

  /* ── 刪除待送清單(§4.4)───────────────────────────── */
  function outboxRead() {
    try { return fs.readFileSync(outboxFile, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter((x) => x && typeof x.session_id === "string"); }
    catch (_) { return []; }
  }
  function outboxWrite(items) {
    try {
      if (!items.length) { fs.rmSync(outboxFile, { force: true }); return; }
      fs.mkdirSync(path.dirname(outboxFile), { recursive: true });
      const tmp = outboxFile + ".tmp"; fs.writeFileSync(tmp, items.map((x) => JSON.stringify(x)).join("\n") + "\n", { mode: 0o600 }); fs.renameSync(tmp, outboxFile);
    } catch (_) { /* 寫不進去:這一筆下次刪不到,api 30 天無活動自己清 */ }
  }
  /* 電腦上刪了一條:先落地,再送。開關關著也記(打開時伺服器那份本來就是空的,送了也無害) */
  function sessionDeleted(sid) {
    if (!load().on && !load().pendingDisable) return false;
    const items = outboxRead().filter((x) => x.session_id !== sid); items.push({ type: "session_delete", session_id: sid, ts: clock() });
    outboxWrite(items.slice(-500));
    if (sync.lastIds) delete sync.lastIds[sid];
    if (live()) flush();
    return true;
  }
  async function outboxFlush() {
    if (!live()) return;
    const items = outboxRead(); if (!items.length) return;
    const sent = new Set();
    for (const x of items) {
      const r = await call(EP.report, { session_id: x.session_id, chunks: [{ type: "session_delete", session_id: x.session_id }] });
      if (r.status === 200 || r.status === 400) sent.add(x.session_id); else break;
    }
    if (sent.size) outboxWrite(outboxRead().filter((x) => !sent.has(x.session_id)));
  }

  /* ── 回合 ─────────────────────────────────────────── */
  const errChunk = (sid, mid, code) => ({ type: "error", session_id: sid, message_id: mid, code });
  function sidOk(sid) {
    if (typeof sid !== "string" || !/^desktop-[a-z0-9]{4,16}$/.test(sid)) return false;
    if (NEW_SID_RE.test(sid)) return true;
    try { return !!opts.sessions.exists(sid); } catch (_) { return false; }
  }
  async function route(m) {
    if (!m || m.type !== "user_message" || typeof m.message_id !== "string" || !MSG_ID_RE.test(m.message_id)) return;
    const sid = m.session_id, mid = m.message_id;
    if (!sidOk(sid)) { enqueueChunk(typeof sid === "string" ? sid : "", errChunk(sid, mid, "bad_session"), true); return; }
    if (typeof m.content !== "string" || !m.content.trim() || Buffer.byteLength(m.content, "utf8") > MESSAGE_MAX_BYTES) { enqueueChunk(sid, errChunk(sid, mid, "bad_message"), true); return; }
    if (opts.isRestarting()) { enqueueChunk(sid, errChunk(sid, mid, "desktop_restarting"), true); return; }
    const q = queue.get(sid) || [];
    if (active.has(sid) || q.length || opts.turnBusy(sid)) {
      q.push({ message_id: mid, content: m.content }); queue.set(sid, q);
      track("phone_turn_q");
      enqueueChunk(sid, { type: "queued", session_id: sid, message_id: mid }, true);
      mobileActiveSync();
      return;
    }
    await launch(sid, mid, m.content, false);
  }
  async function launch(sid, mid, content, fromQueue) {
    let idBefore = 0; try { idBefore = opts.sessions.maxId(sid) || 0; } catch (_) { idBefore = 0; }
    active.set(sid, { message_id: mid, ended: false, idBefore, started: false });
    mobileActiveSync();
    let r = null;
    try { r = await opts.startTurn({ sessionId: sid, message: content, ...(opts.turnArgs ? opts.turnArgs() : {}) }, "mobile"); }
    catch (_) { r = { failed: true }; }
    const a = active.get(sid);
    if (r && r.started) {
      if (a) a.started = true;
      track("phone_turn");
      if (fromQueue) enqueueChunk(sid, { type: "started", session_id: sid, message_id: mid }, true);
      return;
    }
    if (a && a.message_id === mid) active.delete(sid);
    if (r && r.busy && !opts.isRestarting()) {   // 跟電腦前的人同時按下:排在後面
      const q = queue.get(sid) || []; q.unshift({ message_id: mid, content }); queue.set(sid, q);
      if (!fromQueue) { track("phone_turn_q"); enqueueChunk(sid, { type: "queued", session_id: sid, message_id: mid }, true); }
      mobileActiveSync();
      return;
    }
    const code = r && r.busy ? "desktop_restarting" : r && r.blocked ? String(r.blocked).toLowerCase() : "turn_failed";
    enqueueChunk(sid, errChunk(sid, mid, code), true);
    mobileActiveSync();
    pump(sid);
  }
  /* 那條的上一輪(手機或電腦前的人)結束:排在後面的下一句開跑 */
  function pump(sid) {
    const q = queue.get(sid);
    if (!q || !q.length || active.has(sid) || opts.turnBusy(sid) || stopped) return;
    if (opts.isRestarting()) {
      queue.delete(sid);
      for (const x of q) enqueueChunk(sid, errChunk(sid, x.message_id, "desktop_restarting"), true);
      mobileActiveSync();
      return;
    }
    const next = q.shift(); if (!q.length) queue.delete(sid);
    launch(sid, next.message_id, next.content, true);
  }
  /* main.js sendTurn 的每一則都經過這裡(視窗關著也是):只轉手機那一輪的,結束時補上一輪沒說的錯誤、補排隊的、補上傳 */
  function onTurn(sid, ch, payload) {
    const a = active.get(sid);
    if (ch === "turn-event" && a && payload && typeof payload === "object") {
      if (payload.type === "queued" || payload.type === "started") return;   // 雲端名額的排隊:手機那一輪不會走到
      const c = scrubDeep({ ...payload, session_id: sid, message_id: a.message_id }, known());
      if (payload.type === "done" || payload.type === "error") a.ended = true;
      enqueueChunk(sid, c, payload.type === "done" || payload.type === "error");
      return;
    }
    if (ch !== "turn-end") return;
    if (a) {
      active.delete(sid);
      if (!a.ended) {
        const tail = payload && typeof payload.errTail === "string" ? payload.errTail.trim() : "";
        enqueueChunk(sid, errChunk(sid, a.message_id, payload && payload.canceled ? "stopped" : ERR_CODE_RE.test(tail) ? tail.toLowerCase() : "turn_failed"), true);
      }
      try {
        const rows = opts.sessions.rowsAfter(sid, a.idBefore, 50) || [];
        const ids = rows.filter((x) => x.role === "user").map((x) => x.id);
        if (ids.length) opts.origins.add(sid, ids);
      } catch (_) { /* 標不到「來自手機」:只少一個標籤 */ }
      mobileActiveSync();
    }
    pump(sid);
    if (live()) syncSoon(sid);
  }

  /* ── controls ─────────────────────────────────────── */
  function control(c) {
    if (!c || typeof c !== "object" || typeof c.session_id !== "string") return;
    const sid = c.session_id;
    if (c.type === "interrupt") {
      if (active.has(sid)) { try { opts.stopTurn(sid); } catch (_) { /* 已經結束 */ } return; }
      const q = queue.get(sid) || []; queue.delete(sid);   // 還在排隊 = 取消排隊
      for (const x of q) enqueueChunk(sid, { type: "canceled", session_id: sid, message_id: x.message_id }, true);
      mobileActiveSync();
      return;
    }
    if (c.type === "withdraw") {
      const q = queue.get(sid) || [], i = q.findIndex((x) => x.message_id === c.message_id);
      if (i < 0) return;
      q.splice(i, 1); if (!q.length) queue.delete(sid);
      enqueueChunk(sid, { type: "canceled", session_id: sid, message_id: c.message_id }, true);
      mobileActiveSync();
      return;
    }
    if (c.type === "session_delete") {
      let ok = false;
      if (!opts.turnBusy(sid) && !active.has(sid) && !(queue.get(sid) || []).length) { try { ok = opts.sessions.remove(sid) === true; } catch (_) { ok = false; } }
      if (ok && sync.lastIds) delete sync.lastIds[sid];
      enqueueChunk(sid, { type: ok ? "session_delete" : "delete_refused", session_id: sid }, true);
    }
  }

  /* ── 長輪詢 ───────────────────────────────────────── */
  function stopPoll() { pollGen++; polling = false; }
  function startPoll() {
    if (polling || !live()) return;
    polling = true;
    const gen = ++pollGen;
    (async () => {
      let backoff = BACKOFF_MIN_MS;
      while (gen === pollGen && live()) {
        const r = await call(EP.poll, { ver: opts.ver || "" }, POLL_TIMEOUT_MS);
        if (gen !== pollGen) break;
        if (r.status === 200 && r.body) {
          backoff = BACKOFF_MIN_MS;
          const msgs = Array.isArray(r.body.messages) ? r.body.messages : [], ctl = Array.isArray(r.body.controls) ? r.body.controls : [];
          const ids = msgs.map((m) => m && m.message_id).filter((x) => typeof x === "string" && MSG_ID_RE.test(x));
          if (ids.length) call(EP.ack, { message_ids: ids });   // 收件就 ack(不等回合結束):回合跑到一半掛掉不重送
          for (const c of ctl) control(c);
          for (const m of msgs) await route(m);
          continue;
        }
        if (r.status === 401 || r.noCreds) break;   // 憑證失效:等下一輪 tick 重新判斷
        if (r.status === 403) break;   // 總開關關(setFlag 已處理)或這台沒開
        await new Promise((res) => { const t = setTimeout(res, backoff); if (t.unref) t.unref(); });
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
      if (gen === pollGen) polling = false;
    })().catch((e) => { log("relay: poll loop " + ((e && e.message) || e)); if (gen === pollGen) polling = false; });
  }

  /* ── 舊對話上傳(§4.1)─────────────────────────────── */
  function titleOf(sid) {
    try { const rows = opts.sessions.rowsAfter(sid, 0, 50) || []; const u = rows.find((x) => x.role === "user"); return u ? u.content : ""; } catch (_) { return ""; }
  }
  function cleanTitle(raw, k) {
    const s = String(raw || "").split("\n").filter((l) => !/^\s*\[(附件|attachment)/i.test(l)).join(" ").trim();
    const t = Array.from(s); const cut = t.length > TITLE_MAX ? t.slice(0, TITLE_MAX).join("") + "…" : s;
    return redact(cut, k) || "";
  }
  function turnOut(sid, row, k) {
    const content = clipBytes(redact(String(row.content || ""), k), TURN_MAX_BYTES);
    let origin = "desktop"; try { if (row.role === "user" && opts.origins.has(sid, row.id)) origin = "app"; } catch (_) { origin = "desktop"; }
    return { id: row.id, role: row.role, origin, content, created_at: row.created_at };
  }
  async function syncSessions(sids, progress) {
    const k = known(), cutoff = clock() / 1000 - SYNC_DAYS * 86400;
    let list = [];
    try { list = (opts.sessions.list() || []).filter((s) => s && typeof s.id === "string" && Number(s.last) >= cutoff).slice(0, SYNC_MAX_SESSIONS); } catch (_) { list = []; }
    if (sids) list = list.filter((s) => sids.includes(s.id));
    if (progress) { sync.total = list.length; sync.done = 0; changed(); }
    let batch = [], nTurns = 0, nBytes = 0;
    const send = async () => {
      if (!batch.length) return true;
      const r = await call(EP.sync, { sessions: batch });
      if (r.status !== 200) { log("relay: sync not sent (" + (r.status || "offline") + ")"); return false; }
      for (const s of batch) { if (s.turns.length) sync.lastIds[s.session_id] = s.turns[s.turns.length - 1].id; }
      batch = []; nTurns = 0; nBytes = 0;
      await new Promise((res) => { const t = setTimeout(res, SYNC_GAP_MS); if (t.unref) t.unref(); });
      return true;
    };
    for (const s of list) {
      if (!live()) return false;
      const after = Number(sync.lastIds[s.id]) || 0;
      let rows = [];
      try { rows = (opts.sessions.rowsAfter(s.id, after, SYNC_PER_SESSION, true) || []).filter((x) => x.role === "user" || x.role === "assistant"); } catch (_) { rows = []; }
      const title = cleanTitle(titleOf(s.id), k);
      let entry = { session_id: s.id, title, last_at: s.last, turns: [] };
      if (!rows.length && after) { if (progress) { sync.done++; changed(); } continue; }
      if (!rows.length) { batch.push(entry); nBytes += Buffer.byteLength(JSON.stringify(entry)); }
      for (const row of rows) {
        const t = turnOut(s.id, row, k), b = Buffer.byteLength(JSON.stringify(t));
        if (nTurns >= SYNC_BATCH_TURNS || nBytes + b > SYNC_BATCH_BYTES) {
          if (!(await send())) return false;
          entry = { session_id: s.id, title, last_at: s.last, turns: [] };
        }
        if (!batch.includes(entry)) batch.push(entry);
        entry.turns.push(t); nTurns++; nBytes += b;
      }
      if (progress) { sync.done++; changed(); }
    }
    return send();
  }
  async function syncAll() {
    if (sync.running || !live()) return false;
    sync.running = true; sync.error = false; changed();
    try {
      const r = await call(EP.syncState);
      if (r.status !== 200 || !r.body || typeof r.body.sessions !== "object" || !r.body.sessions) throw new Error("sync_state " + (r.status || "offline"));
      sync.lastIds = { ...r.body.sessions };
      const ok = await syncSessions(null, true);
      if (!ok && live()) throw new Error("sync");
      if (ok) {
        const s = load();
        if (!s.synced) { s.synced = true; save(); track("phone_sync_ok"); }
      }
      return ok;
    } catch (e) {
      if (live()) { sync.error = true; track("phone_sync_fail"); log("relay: " + ((e && e.message) || e)); }
      return false;
    } finally {
      sync.running = false; changed();
      if (sync.again.size && live()) { const ids = [...sync.again]; sync.again.clear(); syncSessions(ids, false).catch(() => {}); }
    }
  }
  function syncSoon(sid) {
    if (!sync.lastIds || sync.running) { sync.again.add(sid); return; }
    syncSessions([sid], false).catch(() => {});
  }

  /* ── 開關 ─────────────────────────────────────────── */
  /* 確認框按〔開啟〕之後才叫。api 記下這台開著才會收到訊息;記不成就維持關 */
  async function setOn(on) {
    const s = load();
    if (on) {
      if (!flag || !creds()) return { ok: false, code: flag ? "SIGNED_OUT" : "OFF" };
      if (s.pendingDisable) {
        const d = await call(EP.disable);
        if (d.status !== 200 && d.status !== 401) return { ok: false, code: "OFFLINE" };
        s.pendingDisable = false; save();
      }
      const r = await call(EP.enable);
      if (r.status !== 200) return { ok: false, code: r.status ? "FAILED" : "OFFLINE" };
      s.on = true; s.synced = false; save(); outboxWrite([]);
      track("phone_chat_on");
      stopped = false; startPoll(); syncAll();
      changed();
      return { ok: true };
    }
    if (!s.on && !s.pendingDisable) return { ok: true };
    const wasOn = s.on;
    s.on = false; stopPoll();
    dropMobile("not_run");
    const r = await call(EP.disable);
    s.pendingDisable = !(r.status === 200 || r.status === 401);   // 401 = 這組憑證已失效,伺服器那份跟著這顆 token 藏起來
    s.synced = false; save(); outboxWrite([]);
    sync.lastIds = null; sync.error = false; sync.done = 0; sync.total = 0;
    if (wasOn) track("phone_chat_off");
    changed();
    return { ok: true, pending: s.pendingDisable };
  }
  /* 手機那一輪停下、排隊的不跑(關開關、登出)。排隊的回 not_run,跑到一半的照「已停止」收尾 */
  function dropMobile(code) {
    for (const [sid, q] of queue) for (const x of q) enqueueChunk(sid, errChunk(sid, x.message_id, code), false);
    queue.clear();
    for (const sid of active.keys()) { try { opts.stopTurn(sid); } catch (_) { /* 已經結束 */ } }
    mobileActiveSync();
  }
  async function retry() { if (!live()) return false; return syncAll(); }
  /* 登出:撤銷 token 之前叫(之後這對憑證就刪不了伺服器那份)。之後要再打開得重新確認 */
  async function signOut() {
    const s = load();
    if (!s.on && !s.pendingDisable) return;
    stopPoll(); dropMobile("not_run");
    await withTimeout(flush(), QUIT_TIMEOUT_MS);
    await call(EP.disable, null, QUIT_TIMEOUT_MS);
    s.on = false; s.pendingDisable = false; s.synced = false; save(); outboxWrite([]);
    sync.lastIds = null; seenToken = null; lastToken = null; changed();
  }
  /* app 結束:排隊的那幾句回 not_run(最多等 3 秒),之後不再收 */
  async function quit() {
    quitting = true; stopped = true; stopPoll();
    if (flagTimer) { clearInterval(flagTimer); flagTimer = null; }
    for (const [sid, q] of queue) for (const x of q) enqueueChunk(sid, errChunk(sid, x.message_id, "not_run"), false);
    queue.clear(); mobileActiveSync();
    if (batches.size) await withTimeout(flush(), QUIT_TIMEOUT_MS);
  }
  async function tick() {
    if (stopped) return;
    await refreshFlag();
    const s = load();
    if (s.pendingDisable && creds()) {
      const r = await call(EP.disable);
      if (r.status === 200 || r.status === 401) { s.pendingDisable = false; save(); changed(); }
    }
    if (!live()) return;
    startPoll();
    flush();
    if (!sync.lastIds && !sync.running && !sync.error) syncAll();
  }
  function start() {
    if (flagTimer) return;
    tick().catch(() => {});
    flagTimer = setInterval(() => { tick().catch(() => {}); }, FLAG_TICK_MS); if (flagTimer.unref) flagTimer.unref();
  }
  function state() {
    const s = load();
    return { visible: flag, on: s.on, pending: s.pendingDisable, signedIn: !!creds(),
      sync: { running: sync.running, done: sync.done, total: sync.total, error: sync.error, synced: s.synced },
      mobileTurns: active.size, queued: [...queue.values()].reduce((n, q) => n + q.length, 0) };
  }
  return { start, tick, setOn, retry, signOut, quit, onTurn, sessionDeleted, state, isOn: () => load().on, isVisible: () => flag,
    mobileLive: () => active.size > 0, isMobile: (sid) => active.has(sid) || (queue.get(sid) || []).length > 0,
    _internals: { route, control, flush, syncAll, queue, active, batches } };
}

module.exports = { createRelay, scrubDeep, clipBytes, EP, POLL_HOLD_MS, BATCH_MS, SYNC_BATCH_TURNS, SYNC_BATCH_BYTES, TURN_MAX_BYTES, OUTBOX };
