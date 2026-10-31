/* 手機 App 跟這台電腦的 agent 對話(主行程用;spec mobile-agent-chat-mvp §1.3、§2.6–§2.7、§3.2、§4)。
 *
 *   - 收件:25 秒長輪詢 /relay/poll(同雲端 web_bridge 的 poll／ack／report)。收件就 ack,ack 回 rejected 的不跑;
 *     交給回合表(startTurn(…, "mobile"))。回合跑到一半掛掉不重送。同一條對話在跑就排在它後面(只放記憶體),
 *     回報 queued;每一輪手機的回合真的開跑時回報 started(api 靠它把那句從「收下了」移到「在跑」)。
 *   - 回傳:手機那一輪的 chunk 每 300 毫秒一批 /relay/report(一個 POST 可含多條對話,≤ 50 段),文字欄位先過 redact.js(§4.3)。
 *     回應的 interrupt(對話 id)要停那一輪、cancel(訊息 id)那一句不得跑或立刻停。
 *   - 對話紀錄:開著時把這台近 30 天的對話遮蔽後上傳(/relay/sync_state → /relay/sync,一批 ≤ 100 則／512 KB、每秒一批),
 *     每一輪結束先送完 done 再補新的那幾則;手機那一輪的用戶那句帶它的 message_id。墓碑裡的對話不傳。
 *     電腦上刪的對話寫進 state/relay-outbox.jsonl,連上時送 session_delete。
 *   - 兩顆憑證只在主行程:不寫檔、不 log;第 1 條遮蔽要比對的值也只在記憶體。
 *   - 平台總開關不是開(/relay/enabled、poll 的 enabled:false reason off、任何 403 APP_CHAT_OFF):不收、不傳、設定頁不出這一區。
 *     api 說這台沒開(reason not_enabled、409 RELAY_NOT_ENABLED)而本機開著:重打 /relay/enable;401／409 時手機的回合一律停、排隊清空。
 *   - 那一句還沒開跑就不會跑的(not_run／desktop_restarting／bad_session／bad_message)送 message_failed;開跑之後的失敗走回合的 error。
 *
 * 不 require electron;HTTP、時鐘、回合表、session.db 都由呼叫端注入(tests/check_shell_relay.js 用假的)。
 * 契約:api openclaw/desktop_auth.py 的 relay 段與 openclaw/relay.py;端點都在下面 EP。
 */
const fs = require("fs");
const path = require("path");
const { redact } = require("./redact");
const { deviceOf } = require("./mobileview");

const EP = {
  enabled: "/oauth/desktop/relay/enabled",   // → { enabled, on }
  enable: "/oauth/desktop/relay/enable",
  disable: "/oauth/desktop/relay/disable",   // 同時刪伺服器上這台的對話(§4.4)
  poll: "/oauth/desktop/relay/poll",         // + ver, restarting → { enabled, messages, controls, server_time } | { enabled:false, reason }
  ack: "/oauth/desktop/relay/ack",           // + message_ids → { acked, rejected }
  report: "/oauth/desktop/relay/report",     // + chunks(每段帶 session_id)→ { results, interrupt, cancel }
  image: "/oauth/desktop/relay/image",       // + session_id, message_id, mime, b64, caption?(只限手機那一輪)
  syncState: "/oauth/desktop/relay/sync_state",   // → { sessions: [{ session_id, last_id }], tombstones: [sid] }
  sync: "/oauth/desktop/relay/sync",         // + sessions: [{ session_id, title, last_at(ms), turns: [{ id, role, content, created_at(ms), origin?, message_id? }] }]
  pairCode: "/oauth/desktop/relay/pair_code",   // → { code, expires_in }
  phones: "/oauth/desktop/relay/phones",     // → { max, phones: [{ device_id, platform, label, paired_via, created_at, last_used_at, granted }] }
  grant: "/oauth/desktop/relay/phones/grant",   // + device_id, granted
  revoke: "/oauth/desktop/relay/phones/revoke", // + device_id, lang
  actions: "/oauth/desktop/relay/phones/actions",   // + device_id? → { actions: [{ ts, action, device, ip }] }
};
const OFF_CODE = "APP_CHAT_OFF", NOT_ENABLED_CODE = "RELAY_NOT_ENABLED";
const POLL_HOLD_MS = 25000, POLL_TIMEOUT_MS = 40000, REQUEST_TIMEOUT_MS = 10000, QUIT_TIMEOUT_MS = 3000;
const FLAG_TICK_MS = 2 * 60 * 1000;
const BATCH_MS = 300;
const REPORT_MAX_CHUNKS = 50, REPORT_MAX_BYTES = 1536 * 1024;   // api REPORT_CHUNKS_MAX = 50、body 上限 2 MB(留給憑證與 JSON 外殼)
// 手機那一輪跑著、沒有輸出時(一個工具跑很久)的存活訊號:api 在線時 TURN_MAX_S 沒聽到任何東西就當收尾丟了
const PING_MS = 60000;
const CLAIM_RETRY_MS = 500, CLAIM_DEADLINE_MS = 15000;   // started 沒回應:重送到 15 秒,之後 start_aborted
const BACKOFF_MIN_MS = 2000, BACKOFF_MAX_MS = 60000, REENABLE_GAP_MS = 30000;
const SYNC_DAYS = 30, SYNC_MAX_SESSIONS = 200, SYNC_PER_SESSION = 500;
const SYNC_BATCH_TURNS = 100, SYNC_BATCH_BYTES = 512 * 1024, SYNC_GAP_MS = 1000, TURN_MAX_BYTES = 32 * 1024;
const MESSAGE_MAX_BYTES = 1024 * 1024;   // = main.js / runtime 的 stdin 上限
const MSG_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const NEW_SID_RE = /^desktop-m[a-z0-9]{3,15}$/;   // api 替手機開的新對話(§3.2);其他的必須是這台已經有的
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TITLE_MAX = 60;
const OUTBOX = "relay-outbox.jsonl";
// LocalSink 會送、api 會轉給手機的 chunk(= api relay.TURN_TYPES);image 走 /relay/image,其他(strategies…)不送
const TURN_TYPES = ["text", "thinking", "tool", "tool_prep", "done", "error", "export", "text_replace", "suggestions", "ui_nav", "withdraw_result", "ping"];
// 那一句還沒開跑就不會跑了(message_failed 的 code);開跑之後的失敗走回合的 error chunk
const NOT_RUN = "not_run", DESKTOP_RESTARTING = "desktop_restarting", BAD_SESSION = "bad_session", BAD_MESSAGE = "bad_message";

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
const toMs = (sec) => Math.round(Number(sec) * 1000);   // session.db 的時間是秒(REAL);api 收 ms 整數

/* opts:{ dir(userData), stateDir(BASE/state), apiBase, post(url, body, extra), getCreds(), installId(), ver, now?, log?,
          startTurn(payload, origin) → { started|queued|busy|blocked }, stopTurn(sid), turnBusy(sid), isRestarting(),
          sessions: { list() → [{ id, last, title }], rowsAfter(sid, afterId, limit, latest) → [{ id, role, content, created_at }], maxId(sid),
                      exists(sid), remove(sid) → bool },
          turnArgs() → { model, effort }(電腦當下存的那一組), known() → [值](第 1 條),
          origins: { add(sid, [{ id, mid }]), get(sid) → Map(turn id → message_id) },
          track(name), onChange(state), onMobileActive(bool) } */
function createRelay(opts) {
  const file = path.join(opts.dir, "relay.json");
  const outboxFile = path.join(opts.stateDir, OUTBOX);
  const clock = opts.now || (() => Date.now());
  const log = opts.log || (() => {});
  let st = null, flag = false, polling = false, pollGen = 0, flagTimer = null, stopped = false, quitting = false, reenableAt = 0, reenabling = null;
  let seenToken = null, lastToken = null;   // 上一顆帳號 token(輪替後幾秒內的輸出可能還帶著它):第 1 條也比對
  const queue = new Map();   // sid → [{ message_id, content }]:同一條在跑時排在後面
  const active = new Map();  // sid → { message_id, ended, idBefore }:正在跑的手機那一輪
  let pending = [];          // 待送的 chunk(每段帶 session_id),照收到的順序
  let batchTimer = null, reporting = null, retryTimer = null, flushBackoff = BACKOFF_MIN_MS, pingTimer = null;
  let inflight = null;       // 在路上那一批:{ sids, p }(認領只等自己那條的)
  const tombstones = new Set();
  const sync = { running: false, done: 0, total: 0, error: false, lastIds: null, again: new Set() };

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
    const code = r && r.body && r.body.error_code;
    if (r && r.status === 403 && code === OFF_CODE) { dropMobile(); setFlag(false); }   // 總開關關:手機的都停、排隊的回 not_run、relay 停
    // 憑證失效或 api 說這台沒開:手機的回合一律停、排隊清空(再跑下去回報也送不到,手機會以為還在等)
    if (r && (r.status === 401 || (r.status === 409 && code === NOT_ENABLED_CODE))) { dropMobile(); if (r.status === 409) reenable(); }
    return r || { status: 0, body: null };
  }
  function changed() { try { if (opts.onChange) opts.onChange(state()); } catch (_) { /* 畫面壞掉不擋 */ } }
  function setFlag(v) { if (flag === v) return; flag = v; if (!v) stopPoll(); changed(); }
  const live = () => flag && load().on && !load().pendingDisable && !!creds() && !stopped;
  // 也通知畫面:分頁上的手機記號跟著每條對話的手機回合數(state().phoneSids)
  function mobileActiveSync() { pingSync(); try { if (opts.onMobileActive) opts.onMobileActive(active.size > 0 || [...queue.values()].some((q) => q.length)); } catch (_) { /* 防睡壞掉不擋 */ } changed(); }
  function pingSync() {
    const need = !stopped && [...active.values()].some((a) => !a.claiming);
    if (need && !pingTimer) {
      pingTimer = setInterval(() => { if (!live()) return; for (const [sid, a] of active) if (!a.claiming && !a.ended) enqueueChunk({ type: "ping", session_id: sid, message_id: a.message_id }, false); }, opts.pingMs || PING_MS);
      if (pingTimer.unref) pingTimer.unref();
    } else if (!need && pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }
  const track = (n) => { try { if (opts.track) opts.track(n); } catch (_) { /* 追蹤不擋 */ } };
  /* api 那邊這台沒記成開著(換了 token、伺服器清過)而本機開著:補打 enable,30 秒內只打一次 */
  function reenable() {
    if (!load().on || load().pendingDisable) return Promise.resolve(false);
    if (clock() - reenableAt < REENABLE_GAP_MS) return reenabling || Promise.resolve(false);   // 30 秒內同一次的結果
    reenableAt = clock();
    reenabling = call(EP.enable).then((r) => (r.status === 200 ? true : (log("relay: re-enable " + (r.status || "offline")), false)));
    return reenabling;
  }

  async function refreshFlag() {
    const r = await call(EP.enabled);
    if (r.noCreds) { setFlag(false); return false; }
    if (r.status !== 200 || !r.body) { setFlag(false); return false; }
    setFlag(r.body.enabled === true);
    if (flag && r.body.on === false) await reenable();
    return flag;
  }

  /* ── 回報 ─────────────────────────────────────────── */
  function enqueueChunk(chunk, now) {
    pending.push(chunk);
    if (now) return flush();
    if (!batchTimer) { batchTimer = setTimeout(() => { batchTimer = null; flush(); }, BATCH_MS); if (batchTimer.unref) batchTimer.unref(); }
    return reporting || Promise.resolve();
  }
  const shellEvent = (type, sid, mid) => enqueueChunk({ type, session_id: sid, message_id: mid }, true);
  const msgFailed = (sid, mid, code) => enqueueChunk({ type: "message_failed", session_id: sid, message_id: mid, code }, true);
  /* 一次只有一筆在路上,順序照收到的;送不出去的放回最前面下一批再送(總量有上限,不會無限長) */
  function flush() {
    if (reporting) return reporting.then(() => (pending.length ? flush() : undefined));
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    if (!pending.length && !outboxRead().length) return Promise.resolve();
    reporting = (async () => {
      try {
        while (pending.length) {
          const take = [];
          let bytes = 0;
          while (pending.length && take.length < REPORT_MAX_CHUNKS) {
            const b = Buffer.byteLength(JSON.stringify(pending[0]));
            if (take.length && bytes + b > REPORT_MAX_BYTES) break;
            take.push(pending.shift()); bytes += b;
          }
          const p = call(EP.report, { chunks: take }, quitting ? QUIT_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
          inflight = { sids: new Set(take.map((c) => c.session_id)), p };
          const r = await p;
          inflight = null;
          if (r.status === 200 && r.body) { flushBackoff = BACKOFF_MIN_MS; reportAnswer(r.body); continue; }
          // 斷線、限流、部署中的 5xx:放回最前面、過一下再送(同 claimStart)。done／start_aborted 丟了,api 那條會一直停在回覆中
          if ((r.status === 0 || r.status === 429 || r.status >= 500) && !r.noCreds && !quitting) {
            if (pending.length + take.length <= 2000) pending = take.concat(pending);
            log("relay: report not sent (" + (r.status || "offline") + "), retry in " + flushBackoff + " ms");
            // 退避只在排定的那次重送也失敗時翻倍:已經排著一次時,中途硬送(馬上要送的事件、認領)失敗不累加
            if (!retryTimer) {
              retryTimer = setTimeout(() => { retryTimer = null; flush(); }, flushBackoff); if (retryTimer.unref) retryTimer.unref();
              flushBackoff = Math.min(flushBackoff * 2, BACKOFF_MAX_MS);
            }
            break;
          }
          log("relay: report rejected (" + (r.status || "no creds") + ")");   // 400／401／403／409:這批不重送
        }
        await outboxFlush();
      } finally { reporting = null; inflight = null; }
    })();
    return reporting;
  }
  /* 認領放棄時:它在等的那段裡重送失敗累加的退避歸零,上一句的 done 不會因此晚一分鐘才再送 */
  function resetFlushBackoff() {
    flushBackoff = BACKOFF_MIN_MS;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = setTimeout(() => { retryTimer = null; flush(); }, BACKOFF_MIN_MS); if (retryTimer.unref) retryTimer.unref(); }
  }
  /* report 回應:interrupt = 手機按了停止的那幾條;cancel = api 已經告訴手機「沒跑」的那幾句,不得跑、跑了就停 */
  function reportAnswer(b) {
    // cancel 那幾句的對話也會出現在 interrupt:同一輪只停一次
    const stops = new Set();
    for (const mid of Array.isArray(b.cancel) ? b.cancel : []) if (typeof mid === "string") cancelMessage(mid, false, stops);
    for (const sid of Array.isArray(b.interrupt) ? b.interrupt : []) if (typeof sid === "string" && active.has(sid) && !stops.has(sid)) { stops.add(sid); stopActive(sid); }
  }
  function stopActive(sid) { try { opts.stopTurn(sid); } catch (_) { /* 已經結束 */ } }
  /* 一句不得跑:還在排隊就拿掉(report = 要不要回報 cancelled;api 自己判的不用回),已經開跑就停 */
  function cancelMessage(mid, report, stops) {
    for (const [sid, q] of queue) {
      const i = q.findIndex((x) => x.message_id === mid);
      if (i < 0) continue;
      q.splice(i, 1); if (!q.length) queue.delete(sid);
      if (report) enqueueChunk({ type: "cancelled", session_id: sid, message_ids: [mid] }, true);
      mobileActiveSync();
      return true;
    }
    for (const [sid, a] of active) if (a.message_id === mid) { if (!stops || !stops.has(sid)) { if (stops) stops.add(sid); stopActive(sid); } return true; }
    return false;
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
  /* 電腦上刪了一條:先落地,再送 */
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
    const items = outboxRead().slice(0, REPORT_MAX_CHUNKS); if (!items.length) return;
    const r = await call(EP.report, { chunks: items.map((x) => ({ type: "session_delete", session_id: x.session_id })) });
    if (r.status !== 200 && r.status !== 400) return;
    if (r.status === 200 && r.body) reportAnswer(r.body);
    const sent = new Set(items.map((x) => x.session_id));
    outboxWrite(outboxRead().filter((x) => !sent.has(x.session_id)));
  }

  /* ── 回合 ─────────────────────────────────────────── */
  function sidOk(sid) {
    if (typeof sid !== "string" || !/^desktop-[a-z0-9]{4,16}$/.test(sid)) return false;
    if (NEW_SID_RE.test(sid)) return true;
    try { return !!opts.sessions.exists(sid); } catch (_) { return false; }
  }
  /* 一句手機的話(已經 ack 過、沒被 rejected)。不跑的一律回訊息層級的 error:code 只有 not_run／desktop_restarting 兩種 */
  async function route(m) {
    const sid = m.session_id, mid = m.message_id;
    if (!sidOk(sid)) { if (typeof sid === "string") msgFailed(sid, mid, BAD_SESSION); return; }
    if (typeof m.content !== "string" || !m.content.trim() || Buffer.byteLength(m.content, "utf8") > MESSAGE_MAX_BYTES) { msgFailed(sid, mid, BAD_MESSAGE); return; }
    if (opts.isRestarting()) { msgFailed(sid, mid, DESKTOP_RESTARTING); return; }
    const q = queue.get(sid) || [];
    if (active.has(sid) || q.length || opts.turnBusy(sid)) {
      q.push({ message_id: mid, content: m.content }); queue.set(sid, q);
      track("phone_turn_q");
      shellEvent("queued", sid, mid);
      mobileActiveSync();
      return;
    }
    await launch(sid, mid, m.content);
  }
  /* 先認領、後開跑(直接開跑與排隊叫出都一樣):單獨回報 started,api 回 ok 才 startTurn。那段時間 api 可能已經判它沒跑、
     手機撤回或被撤銷。started 沒回應就重送(api 對已經 STARTED 的冪等回 ok),期限到了還是沒回應 → "lost"。
     → "ok" | "cancel"(api 說不得跑,或 401／409 已收掉)| "off"(總開關關了)| "rejected"(api 拒收這筆 started)| "lost"(一直沒回應) */
  async function claimStart(sid, mid) {
    const until = clock() + (opts.claimDeadlineMs || CLAIM_DEADLINE_MS);
    let gap = CLAIM_RETRY_MS, kick = true;
    for (;;) {
      // started 不准超車同一條還沒送到的 chunk(上一輪的 done 斷線退回 pending、或還在路上):先到的 started 會讓 api 把那條
      // 換成這句,上一輪的 done 之後只會被丟掉、它的字併進這一輪。只等這一條的:別條一直在吐字不能把認領拖過期限。
      // 不併進 flush 的佇列:這裡要拿這一筆自己的結果,也不能等 flush 最長 60 秒的退避;代價是認領期間 flush 照認領的間隔重送
      const onWire = () => !!(inflight && inflight.sids.has(sid));
      if (pending.some((c) => c.session_id === sid) || onWire()) {
        if (stopped) return "cancel";
        if (kick && !onWire() && !reporting) flush();   // 送不出去、在等退避:認領這邊先重送(每個間隔一次)
        kick = false;
        if (onWire()) {
          await inflight.p;
          if (clock() > until) { resetFlushBackoff(); return "lost"; }
          if (!pending.some((c) => c.session_id === sid) && !onWire()) continue;
        }
        if (clock() + gap > until) { resetFlushBackoff(); return "lost"; }
        await pause(gap); gap = Math.min(gap * 2, 4000); kick = true;
        continue;
      }
      const r = await call(EP.report, { chunks: [{ type: "started", session_id: sid, message_id: mid }] });
      if (r.status === 200 && r.body) {
        const res = Array.isArray(r.body.results) ? r.body.results[0] : null;
        const go = !!res && res.status === "ok" && !(Array.isArray(r.body.cancel) && r.body.cancel.includes(mid));
        // 這一句還沒開跑:先從 active 拿掉,回應裡對它的 cancel 才不會去停一輪不存在的回合
        if (!go && active.get(sid) && active.get(sid).message_id === mid) active.delete(sid);
        reportAnswer(r.body);
        return go ? "ok" : "cancel";
      }
      // 總開關在重送途中關了:api 可能已經記成開跑(前一次的回應掉了),補 start_aborted(它在總開關關時照收)
      if (r.status === 403 && r.body && r.body.error_code === OFF_CODE) return "off";
      if (r.noCreds || stopped || r.status === 401 || r.status === 403 || r.status === 409) return "cancel";   // 這台沒開／憑證失效:call 已經收掉
      const retry = r.status === 0 || r.status === 429 || r.status >= 500;   // 斷線、限流、部署中的 5xx:重送
      if (!retry) return "rejected";   // 其他 4xx:api 沒收下這筆 started
      // 同上面兩處:斷線這段別條排定的重送失敗會把退避疊高,接著補送的 start_aborted／message_failed 不該再等那麼久
      if (clock() + gap > until) { resetFlushBackoff(); return "lost"; }
      await pause(gap); gap = Math.min(gap * 2, 4000);
    }
  }
  /* 認領之後、沒開跑成:api 那邊這句已經 STARTED 但沒有任何輸出,start_aborted 讓它改回沒跑 */
  const startAborted = (sid, mid) => enqueueChunk({ type: "start_aborted", session_id: sid, message_id: mid }, true);
  /* 一句撤回處理完的答覆(照 webchat withdraw_result:withdrawn／running／not_found;已經開跑的不停) */
  const withdrawResult = (sid, mid, result) => enqueueChunk({ type: "withdraw_result", session_id: sid, message_id: mid, result }, true);
  async function launch(sid, mid, content) {
    let idBefore = 0; try { idBefore = opts.sessions.maxId(sid) || 0; } catch (_) { idBefore = 0; }
    const rec = { message_id: mid, ended: false, idBefore, claiming: true, abort: null };   // abort:認領途中手機撤回(withdraw)或停止(interrupt)
    active.set(sid, rec);
    mobileActiveSync();
    const claim = await claimStart(sid, mid);
    const mine = active.get(sid) === rec;
    if (claim !== "ok" || !mine || rec.abort || !live()) {
      if (mine) active.delete(sid);
      // 告訴 api 這句沒跑:記成開跑了(ok)→ start_aborted;拒收(rejected)→ message_failed;不知道有沒有記到(lost、off:
      // 第一次 started 就被總開關擋下時根本沒記到)→ 兩個都送,api 照它手上的狀態認其中一個。cancel 的那句 api 自己判過了
      if (claim === "ok" || claim === "lost" || claim === "off") startAborted(sid, mid);
      if (claim === "rejected" || claim === "lost" || claim === "off") msgFailed(sid, mid, NOT_RUN);
      if (rec.abort) enqueueChunk({ type: "cancelled", session_id: sid, message_ids: [mid] }, true);
      if (rec.abort === "withdraw") withdrawResult(sid, mid, "withdrawn");
      mobileActiveSync(); pump(sid);
      return;
    }
    rec.claiming = false;
    pingSync();
    let r = null;
    try { r = await opts.startTurn({ sessionId: sid, message: content, ...(opts.turnArgs ? opts.turnArgs() : {}) }, "mobile"); }
    catch (_) { r = { failed: true }; }
    if (r && (r.started || r.queued)) {   // queued = 回合表為了雲端名額排著,它自己會開跑(手機的回合不帶雲端視角,實際不會走到)
      track("phone_turn");
      return;
    }
    if (active.get(sid) === rec) active.delete(sid);
    // 認領之後沒開跑成(電腦前的人同一瞬間按了送出、版本閘、引擎起不來):還沒有任何輸出,改回沒跑
    startAborted(sid, mid);
    mobileActiveSync(); pump(sid);
  }
  /* 那條的上一輪(手機或電腦前的人)結束:排在後面的下一句開跑 */
  function pump(sid) {
    const q = queue.get(sid);
    if (!q || !q.length || active.has(sid) || opts.turnBusy(sid) || stopped || !live()) return;
    if (opts.isRestarting()) {
      queue.delete(sid);
      for (const x of q) msgFailed(sid, x.message_id, DESKTOP_RESTARTING);
      mobileActiveSync();
      return;
    }
    const next = q.shift(); if (!q.length) queue.delete(sid);
    launch(sid, next.message_id, next.content);
  }
  /* main.js sendTurn 的每一則都經過這裡(視窗關著也是):只轉手機那一輪的。回合的 chunk 帶那一輪的 message_id 當關聯
     (「那一句沒跑」另外有 message_failed,api 不拿回合的 chunk 判) */
  function onTurn(sid, ch, payload) {
    const a0 = active.get(sid);
    // 認領中(started 還在路上、手機那一輪還沒開跑):這條上的回合事件都不是手機的——電腦前的人那輪不轉給手機,它的 turn-end 也不收掉認領中那筆
    if (a0 && a0.claiming) return;
    const a = a0;
    if (ch === "turn-event" && a && payload && typeof payload === "object") {
      if (!TURN_TYPES.includes(payload.type)) return;
      // 轉出卡帶的是策略程式全文:策略程式不出這台電腦(§4.1),手機只畫一行「到電腦上看」
      const src = payload.type === "export" ? { type: "export", target: payload.target, strategy: payload.strategy } : payload;
      const c = scrubDeep({ ...src, session_id: sid, message_id: a.message_id }, known());
      if (payload.type === "done" || payload.type === "error") a.ended = true;
      enqueueChunk(c, payload.type === "done" || payload.type === "error");
      return;
    }
    if (ch !== "turn-end") return;
    let sent = Promise.resolve();
    if (a) {
      active.delete(sid);
      if (!a.ended) {
        // 回合沒說結果就結束(停止、spawn 前就失敗、行程掛掉):補一則回合的 error,手機不會一直停在回覆中
        const tail = payload && typeof payload.errTail === "string" ? payload.errTail.trim().slice(-200) : "";
        sent = enqueueChunk({ type: "error", session_id: sid, message_id: a.message_id, message: redact(tail || (payload && payload.canceled ? "stopped" : "turn_failed"), known()) }, true);
      } else sent = flush();
      try {
        const rows = opts.sessions.rowsAfter(sid, a.idBefore, 50) || [];
        const u = rows.find((x) => x.role === "user");
        if (u) opts.origins.add(sid, [{ id: u.id, mid: a.message_id }]);
      } catch (_) { /* 標不到「來自手機」:只少一個標籤 */ }
      mobileActiveSync();
    }
    pump(sid);
    // 先送完 done 再上傳這一輪:api 用 done 重建的暫存歷史要等同步那份來取代
    if (live()) sent.then(() => syncSoon(sid), () => syncSoon(sid));
  }
  /* 手機那一輪回覆裡的圖(lib notify 送到本機接收端的那一份);舊對話的圖不傳 */
  function image(sid, mime, b64, caption) {
    const a = active.get(sid);
    // 認領中:這條上跑的是電腦前那個人的回合(同 onTurn)
    if (!a || a.claiming || !live() || typeof b64 !== "string") return Promise.resolve(false);
    const cap = typeof caption === "string" && caption.trim() ? redact(caption.slice(0, 500), known()) : "";
    // 帶呼叫當下那一句:圖跟 report 不同路,可能在這一輪收尾、下一句開跑之後才到,api 對不上就丟,不掛到下一句
    return call(EP.image, { session_id: sid, message_id: a.message_id, mime, b64, ...(cap && cap !== "⟦R:msg⟧" ? { caption: cap } : {}) }).then((r) => r.status === 200);
  }

  /* ── controls ─────────────────────────────────────── */
  function control(c) {
    if (!c || typeof c !== "object" || typeof c.session_id !== "string") return;
    const sid = c.session_id;
    if (c.type === "interrupt") {
      // 停的是那一條:跑中的停、排在後面的手機句一起取消(不然停完下一句「下單」就自己開跑)
      const a = active.get(sid);
      if (a) { if (a.claiming) a.abort = a.abort || "interrupt"; else stopActive(sid); }
      const q = queue.get(sid) || []; queue.delete(sid);
      if (q.length) enqueueChunk({ type: "cancelled", session_id: sid, message_ids: q.map((x) => x.message_id) }, true);
      mobileActiveSync();
      return;
    }
    if (c.type === "withdraw") {
      const mid = c.message_id; if (typeof mid !== "string") return;
      const a = active.get(sid);
      if (a && a.message_id === mid) {
        if (a.claiming) { a.abort = "withdraw"; return; }   // started 還在路上:認領回來後不跑,那時才回 withdrawn
        withdrawResult(sid, mid, "running"); return;      // 已經開跑:不停(要停按停止)
      }
      withdrawResult(sid, mid, cancelMessage(mid, true) ? "withdrawn" : "not_found");
      return;
    }
    if (c.type === "session_delete") {
      let ok = false;
      if (!opts.turnBusy(sid) && !active.has(sid) && !(queue.get(sid) || []).length) { try { ok = opts.sessions.remove(sid) === true; } catch (_) { ok = false; } }
      if (ok && sync.lastIds) delete sync.lastIds[sid];
      enqueueChunk({ type: ok ? "session_delete" : "delete_refused", session_id: sid }, true);
    }
  }

  /* ── 長輪詢 ───────────────────────────────────────── */
  function stopPoll() { pollGen++; polling = false; }
  const pause = (ms) => new Promise((res) => { const t = setTimeout(res, ms); if (t.unref) t.unref(); });
  /* 收件就 ack,等回應:只跑 acked 裡的;rejected 的不跑(已經在跑的停);沒回應一句都不跑 */
  async function ackAll(msgs) {
    const ids = msgs.map((m) => m.message_id);
    if (!ids.length) return [];
    let r = await call(EP.ack, { message_ids: ids });
    if (r.status === 409 && r.body && r.body.error_code === NOT_ENABLED_CODE && (await reenable())) r = await call(EP.ack, { message_ids: ids });
    if (r.status === 403 || r.status === 401 || r.status === 409) return [];   // 總開關關／憑證失效／這台沒開:call 已經收掉,不另外回
    const acked = new Set(r.status === 200 && r.body && Array.isArray(r.body.acked) ? r.body.acked : []);
    const rejected = new Set(r.status === 200 && r.body && Array.isArray(r.body.rejected) ? r.body.rejected : []);
    for (const mid of rejected) cancelMessage(mid, false);
    // ack 沒回來(網路、逾時)、或回應裡沒提到的那幾句:不跑,而且明講沒跑(api 那邊可能已經記成收下了)
    for (const m of msgs) if (!acked.has(m.message_id) && !rejected.has(m.message_id)) msgFailed(m.session_id, m.message_id, NOT_RUN);
    return msgs.filter((m) => acked.has(m.message_id));
  }
  function startPoll() {
    if (polling || !live()) return;
    polling = true;
    const gen = ++pollGen;
    (async () => {
      let backoff = BACKOFF_MIN_MS;
      while (gen === pollGen && live()) {
        const fired0 = reenableAt;
        const r = await call(EP.poll, { ver: opts.ver || "", restarting: !!opts.isRestarting() }, POLL_TIMEOUT_MS);
        const code = r.body && r.body.error_code;
        // 總開關關:body 帶的停止與撤回照做,然後停。排在世代檢查前面:call 裡的 setFlag(false) 已經換掉世代
        if (r.status === 403 && code === OFF_CODE) {
          for (const c of Array.isArray(r.body.controls) ? r.body.controls : []) control(c);
          break;
        }
        if (gen !== pollGen) break;
        if (r.status === 409 && code === NOT_ENABLED_CODE) {
          // 這台在 api 那邊沒記成開著:call 已經補打 enable;這一次真的打了而且成功才再輪,否則停、等 2 分鐘那一輪(不空轉)
          if (reenableAt !== fired0 && reenabling && (await reenabling)) continue;
          break;
        }
        const b = r.status === 200 ? r.body : null;
        if (b && b.enabled === false) {
          for (const c of Array.isArray(b.controls) ? b.controls : []) control(c);   // 停止與撤回照收
          if (b.reason === "off") { setFlag(false); break; }
          // 這一次真的補打了 enable 而且成功才再輪一次;30 秒內打過(拿到的是上一次的結果)就停,不空轉
          if (b.reason === "not_enabled" && clock() - reenableAt >= REENABLE_GAP_MS && (await reenable())) continue;
          break;   // 打不開或認不得的 reason:停輪詢,等下一輪 tick 重新判斷(不空轉)
        }
        if (b) {
          backoff = BACKOFF_MIN_MS;
          const msgs = (Array.isArray(b.messages) ? b.messages : []).filter((m) => m && typeof m.message_id === "string" && MSG_ID_RE.test(m.message_id) && typeof m.session_id === "string");
          for (const c of Array.isArray(b.controls) ? b.controls : []) control(c);
          // 不等開跑:認領(started)可能重送到 15 秒,卡在這裡別條的停止、撤回就收不到。active 在 launch 第一個 await 之前
          // 就記上,同一條後面的照樣排隊
          for (const m of await ackAll(msgs)) route(m).catch((e) => log("relay: route " + ((e && e.message) || e)));
          continue;
        }
        if (r.status === 401 || r.noCreds) break;   // 憑證失效:等下一輪 tick 重新判斷
        if (r.status === 403) break;   // 總開關關(setFlag 已處理)
        await pause(backoff);
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
    const s = String(raw || "").split("\n").filter((l) => !/^\s*\[(附件|attachment|用戶傳了檔案|用戶附了)/i.test(l)).join(" ").trim();
    const t = Array.from(s); const cut = t.length > TITLE_MAX ? t.slice(0, TITLE_MAX).join("") + "…" : s;
    const out = redact(cut, k) || "";
    return out === "⟦R:msg⟧" ? "" : out;
  }
  function turnOut(row, k, mids) {
    const content = clipBytes(redact(String(row.content || ""), k), TURN_MAX_BYTES);
    const mid = row.role === "user" ? mids.get(row.id) : undefined;
    return { id: row.id, role: row.role, content, created_at: toMs(row.created_at), origin: mid ? "app" : "local", ...(mid ? { message_id: mid } : {}) };
  }
  async function syncSessions(sids, progress) {
    const k = known(), cutoff = clock() / 1000 - SYNC_DAYS * 86400;
    let list = [];
    try { list = (opts.sessions.list() || []).filter((s) => s && typeof s.id === "string" && Number(s.last) >= cutoff && !tombstones.has(s.id)).slice(0, SYNC_MAX_SESSIONS); } catch (_) { list = []; }
    if (sids) list = list.filter((s) => sids.includes(s.id));
    if (progress) { sync.total = list.length; sync.done = 0; changed(); }
    let batch = [], nTurns = 0, nBytes = 0;
    const send = async () => {
      if (!batch.length) return true;
      const r = await call(EP.sync, { sessions: batch });
      if (r.status !== 200) { log("relay: sync not sent (" + (r.status || "offline") + ")"); return false; }
      const res = (r.body && r.body.sessions) || {};
      for (const s of batch) {
        if (res[s.session_id] === "tombstone") { tombstones.add(s.session_id); continue; }
        if (s.turns.length) sync.lastIds[s.session_id] = s.turns[s.turns.length - 1].id;
      }
      batch = []; nTurns = 0; nBytes = 0;
      await pause(SYNC_GAP_MS);
      return true;
    };
    for (const s of list) {
      if (!live()) return false;
      const after = Number(sync.lastIds[s.id]) || 0;
      let rows = [];
      try { rows = (opts.sessions.rowsAfter(s.id, after, SYNC_PER_SESSION, true) || []).filter((x) => x.role === "user" || x.role === "assistant"); } catch (_) { rows = []; }
      if (!rows.length && after) { if (progress) { sync.done++; changed(); } continue; }
      let mids = new Map(); try { mids = opts.origins.get(s.id) || new Map(); } catch (_) { mids = new Map(); }
      const head = { session_id: s.id, title: cleanTitle(titleOf(s.id), k), last_at: toMs(s.last) };
      let entry = { ...head, turns: [] };
      if (!rows.length) { batch.push(entry); nBytes += Buffer.byteLength(JSON.stringify(entry)); }
      for (const row of rows) {
        const t = turnOut(row, k, mids), b = Buffer.byteLength(JSON.stringify(t));
        if (nTurns >= SYNC_BATCH_TURNS || nBytes + b > SYNC_BATCH_BYTES) {
          if (!(await send())) return false;
          entry = { ...head, turns: [] };
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
      const b = r.status === 200 ? r.body : null;
      if (!b || !Array.isArray(b.sessions)) throw new Error("sync_state " + (r.status || "offline"));
      sync.lastIds = {};
      for (const x of b.sessions) if (x && typeof x.session_id === "string") sync.lastIds[x.session_id] = Number(x.last_id) || 0;
      for (const sid of Array.isArray(b.tombstones) ? b.tombstones : []) if (typeof sid === "string") tombstones.add(sid);
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
      if (sync.again.size && live() && sync.lastIds) { const ids = [...sync.again]; sync.again.clear(); syncSessions(ids, false).catch(() => {}); }
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
      s.on = true; s.synced = false; save(); outboxWrite([]); tombstones.clear();
      track("phone_chat_on");
      stopped = false; startPoll(); syncAll();
      changed();
      return { ok: true };
    }
    if (!s.on && !s.pendingDisable) return { ok: true };
    const wasOn = s.on;
    s.on = false; stopPoll();
    dropMobile();
    await withTimeout(flush(), QUIT_TIMEOUT_MS);
    const r = await call(EP.disable);
    s.pendingDisable = !(r.status === 200 || r.status === 401);   // 401 = 這組憑證已失效,伺服器那份跟著這顆 token 藏起來
    s.synced = false; save(); outboxWrite([]);
    sync.lastIds = null; sync.error = false; sync.done = 0; sync.total = 0;
    if (wasOn) track("phone_chat_off");
    changed();
    return { ok: true, pending: s.pendingDisable };
  }
  /* 手機那一輪停下、排隊的不跑(關開關、登出)。排隊的回 not_run,跑到一半的照「已停止」收尾 */
  function dropMobile() {
    for (const [sid, q] of queue) for (const x of q) enqueueChunk({ type: "message_failed", session_id: sid, message_id: x.message_id, code: NOT_RUN }, false);
    queue.clear();
    for (const sid of active.keys()) stopActive(sid);
    active.clear();   // 停下來的那幾輪之後的輸出不再轉、不再補回報(401／409 時本來也送不到)
    mobileActiveSync();
  }
  async function retry() { if (!live()) return false; return syncAll(); }
  /* 登出:撤銷 token 之前叫(之後這對憑證就刪不了伺服器那份)。之後要再打開得重新確認 */
  async function signOut() {
    const s = load();
    if (!s.on && !s.pendingDisable) return;
    stopPoll(); dropMobile();
    await withTimeout(flush(), QUIT_TIMEOUT_MS);
    await call(EP.disable, null, QUIT_TIMEOUT_MS);
    s.on = false; s.pendingDisable = false; s.synced = false; save(); outboxWrite([]);
    sync.lastIds = null; seenToken = null; lastToken = null; changed();
  }
  /* app 結束:排隊的那幾句回 not_run(最多等 3 秒),之後不再收 */
  async function quit() {
    quitting = true; stopped = true; stopPoll();
    if (flagTimer) { clearInterval(flagTimer); flagTimer = null; }
    for (const [sid, q] of queue) for (const x of q) enqueueChunk({ type: "message_failed", session_id: sid, message_id: x.message_id, code: NOT_RUN }, false);
    queue.clear(); mobileActiveSync();
    if (pending.length) await withTimeout(flush(), QUIT_TIMEOUT_MS);
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

  /* ── 設定頁:配對碼、授權手機清單、勾選、撤銷、最近操作(回給畫面的只有 api 回的欄位,沒有憑證)── */
  // api 的回應只在 relay.js 裡讀;回給畫面的一律另外組白名單欄位
const okBody = (r) => (r.status === 200 && r.body ? { ok: true, ...r.body } : { ok: false, code: /^[A-Z_]{2,40}$/.test((r.body && r.body.error_code) || "") ? r.body.error_code : r.status ? "FAILED" : "OFFLINE" });
  /* 出碼之後 10 分鐘內每 5 秒看一次清單,多出一支就是配對完成(埋點 phone_pair;api 不推通知過來) */
  let pairWatch = null, pairSeq = 0;   // pairSeq:配對成功一次加一,畫面靠它收起配對面板
  async function pairCode() {
    const before = await phones();
    const r = okBody(await call(EP.pairCode));
    if (!r.ok || typeof r.code !== "string" || !/^[0-9A-Z]{8}$/.test(r.code)) return { ok: false, code: r.ok ? "FAILED" : r.code };
    if (pairWatch) clearInterval(pairWatch);
    const had = new Set(before.ok ? before.phones.map((p) => p.device_id) : []), until = clock() + (Number(r.expires_in) || 600) * 1000;
    pairWatch = setInterval(async () => {
      if (clock() > until || stopped) { clearInterval(pairWatch); pairWatch = null; return; }
      const now = await phones();
      if (now.ok && now.phones.some((p) => !had.has(p.device_id))) { clearInterval(pairWatch); pairWatch = null; pairSeq++; track("phone_pair"); changed(); }
    }, 5000);
    if (pairWatch.unref) pairWatch.unref();
    return { ok: true, code: r.code, expires_in: Number(r.expires_in) || 600 };
  }
  async function phones() {
    const r = okBody(await call(EP.phones));
    if (!r.ok) return r;
    return { ok: true, max: r.max, phones: (Array.isArray(r.phones) ? r.phones : []).filter((p) => p && DEVICE_ID_RE.test(p.device_id || "")).map((p) => ({
      device_id: p.device_id, platform: p.platform === "android" ? "android" : "ios", label: String(p.label || "").slice(0, 64), paired_via: p.paired_via === "web" ? "web" : "desktop",
      created_at: p.created_at || null, last_used_at: p.last_used_at || null, granted: p.granted === true })) };
  }
  async function grant(deviceId, granted) {
    if (!DEVICE_ID_RE.test(deviceId || "") || typeof granted !== "boolean") return { ok: false, code: "BAD_REQUEST" };
    const r = okBody(await call(EP.grant, { device_id: deviceId, granted }));
    return r.ok ? { ok: true, device_id: deviceId, granted: r.granted === true } : { ok: false, code: r.code };
  }
  async function revoke(deviceId, lang) {
    if (!DEVICE_ID_RE.test(deviceId || "")) return { ok: false, code: "BAD_REQUEST" };
    const r = okBody(await call(EP.revoke, { device_id: deviceId, lang: ["zh", "cn", "en"].includes(lang) ? lang : "zh" }));
    if (r.ok && r.revoked) track("phone_revoke");
    return r.ok ? { ok: true, revoked: r.revoked === true } : { ok: false, code: r.code };
  }
  async function actions(deviceId) {
    if (deviceId != null && !DEVICE_ID_RE.test(deviceId)) return { ok: false, code: "BAD_REQUEST" };
    const r = okBody(await call(EP.actions, deviceId ? { device_id: deviceId } : {}));
    if (!r.ok) return r;
    return { ok: true, actions: (Array.isArray(r.actions) ? r.actions : []).slice(0, 50).map((a) => ({ ts: a.ts || null, action: String(a.action || ""), device: String(a.device || ""), ip: String(a.ip || "") })) };
  }

  function state() {
    const s = load();
    return { visible: flag, on: s.on, pending: s.pendingDisable, signedIn: !!creds(),
      sync: { running: sync.running, done: sync.done, total: sync.total, error: sync.error, synced: s.synced },
      mobileTurns: active.size, queued: [...queue.values()].reduce((n, q) => n + q.length, 0), phoneSids: phoneSids(), pairSeq };
  }
  // 每條對話有幾句手機的話在跑或排隊(sid → 數);只有 sid 與數字,沒有內容
  function phoneSids() {
    const out = {};
    for (const sid of active.keys()) out[sid] = 1;
    for (const [sid, q] of queue) if (q.length) out[sid] = (out[sid] || 0) + q.length;
    return out;
  }
  return { start, tick, setOn, retry, signOut, quit, onTurn, image, sessionDeleted, state, pairCode, phones, grant, revoke, actions,
    isOn: () => load().on, isVisible: () => flag, mobileLive: () => active.size > 0,
    isMobile: (sid) => active.has(sid) || (queue.get(sid) || []).length > 0,
    claiming: (sid) => !!(active.get(sid) && active.get(sid).claiming),
    _internals: { route, control, flush, syncAll, queue, active } };
}

module.exports = { createRelay, scrubDeep, clipBytes, EP, POLL_HOLD_MS, BATCH_MS, SYNC_BATCH_TURNS, SYNC_BATCH_BYTES, TURN_MAX_BYTES, OUTBOX, TURN_TYPES, REPORT_MAX_CHUNKS };
