// 手機 App 跟這台電腦對話(shell/relay.js + main.js 的接線;spec mobile-agent-chat-mvp §1.3、§2.6–§2.7、§3.2、§4)。
// api 用假的 post(照 spec 端點契約),回合表與 session.db 也是假的;不開視窗、不打網路。
//   1. 總開關讀不到 / 關:不輪詢、不上傳;打開開關要總開關開著、api 記下才算開
//   2. 收件:先 ack 再交回合表(origin mobile);手機那一輪的 chunk 每 300 毫秒一批、done 立刻送;字串過遮蔽(token、.env 值不出門)
//   3. 同一條在跑:排在後面回 queued,上一輪結束才開跑並回 started;撤回 / 停止排隊中的回 canceled;停止跑中的叫 stopTurn
//   4. 更新重開收工中 → desktop_restarting;不是這台的對話 → bad_session;沒說錯就結束 → 補一則 error;結束 app → 排隊的回 not_run
//   5. 刪除:手機要刪,跑中拒刪(delete_refused);電腦上刪的先落地 relay-outbox.jsonl、送成才拿掉
//   6. 上傳舊對話:只近 30 天、一批 ≤ 100 則、單則 > 32 KB 截斷、手機送的那句 origin app、照 sync_state 只補缺的
//   7. 關掉:刪伺服器那份;沒網路記待刪、下一輪重送;總開關回 APP_CHAT_OFF 當場停
//   8. 狀態檔只有布林;給畫面的沒有憑證
//   9. main.js 接線:sendTurn 在「有沒有視窗」之前交給 relay、手機那一輪帶 BLAVE_TURN_ORIGIN=app、刪對話記待送
// 跑法:node tests/check_shell_relay.js
const fs = require("fs"), os = require("os"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const RL = require(path.join(SHELL, "relay.js"));
const main = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const API = "https://api.test", TOKEN = "tok_Abc123XyZ987qwe", SECRET = "sec_Zz99Yy88Xx77";   // gitleaks:allow (fake)
const keepAlive = setInterval(() => {}, 1000);

function rig(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-")), stateDir = path.join(dir, "state");
  const calls = [], polls = [], started = [], stopped = [], removed = [], tracked = [], origins = {};
  let flag = o.flag !== false, creds = { token: TOKEN, appSecret: SECRET }, restarting = false;
  const busy = new Set(o.busy || []);
  const resp = Object.assign({}, o.resp || {});
  const sessions = o.sessions || {};   // sid → { last, rows: [{ id, role, content, created_at }] }
  let pollWaiter = null;
  const post = async (url, body) => {
    const ep = url.slice(API.length);
    calls.push([ep, body]);
    if (ep === RL.EP.enabled) return flag ? { status: 200, body: { enabled: true } } : { status: 200, body: { enabled: false } };
    if (ep === RL.EP.poll) {
      if (polls.length) return polls.shift();
      return new Promise((res) => { pollWaiter = res; });
    }
    if (resp[ep]) { const r = typeof resp[ep] === "function" ? resp[ep](body) : resp[ep]; return r; }
    if (ep === RL.EP.syncState) return { status: 200, body: { sessions: o.serverIds || {} } };
    return { status: 200, body: { ok: true } };
  };
  const r = RL.createRelay({
    dir, stateDir, apiBase: API, post, getCreds: () => creds, installId: () => "11111111-2222-4333-8444-555555555555", ver: "0.1.37",
    startTurn: async (payload, origin) => { started.push([payload, origin]); if (o.startResult) return o.startResult(payload); busy.add(payload.sessionId); return { started: true }; },
    stopTurn: (sid) => { stopped.push(sid); return true; }, turnBusy: (sid) => busy.has(sid), isRestarting: () => restarting,
    sessions: {
      list: () => Object.entries(sessions).map(([id, s]) => ({ id, last: s.last, title: "" })),
      rowsAfter: (sid, after, limit, latest) => { const rows = ((sessions[sid] || {}).rows || []).filter((x) => x.id > after); return latest && !after ? rows.slice(-limit) : rows.slice(0, limit); },
      maxId: (sid) => { const rows = (sessions[sid] || {}).rows || []; return rows.length ? rows[rows.length - 1].id : 0; },
      exists: (sid) => !!sessions[sid], remove: (sid) => { removed.push(sid); delete sessions[sid]; return true; },
    },
    turnArgs: () => ({ model: "m1" }), known: () => ["envSecretVal99"], origins: { add: (sid, ids) => { origins[sid] = (origins[sid] || []).concat(ids); }, has: (sid, id) => (origins[sid] || []).includes(id) },
    track: (n) => tracked.push(n), now: o.now,
  });
  return { r, dir, stateDir, calls, polls, started, stopped, removed, tracked, origins, busy, sessions,
    feed: (msgs, controls) => { const v = { status: 200, body: { messages: msgs || [], controls: controls || [] } }; if (pollWaiter) { const w = pollWaiter; pollWaiter = null; w(v); } else polls.push(v); },
    setFlag: (v) => { flag = v; }, setCreds: (c) => { creds = c; }, setRestarting: (v) => { restarting = v; },
    of: (ep) => calls.filter((c) => c[0] === ep).map((c) => c[1]),
    chunks: () => calls.filter((c) => c[0] === RL.EP.report).flatMap((c) => c[1].chunks.map((x) => ({ ...x, _sid: c[1].session_id }))),
    end: async () => { await r.quit(); if (pollWaiter) { const w = pollWaiter; pollWaiter = null; w({ status: 0, body: null }); } },
  };
}
const msg = (sid, id, content) => ({ type: "user_message", message_id: id, session_id: sid, content: content || "hi", context: { origin: "app" }, timestamp: Date.now() });

(async () => {
  // ── 1 ──
  { const m = rig({ flag: false }); await m.r.tick();
    ok("1 總開關關:不輪詢、畫面不出", m.of(RL.EP.poll).length === 0 && m.r.state().visible === false);
    const r = await m.r.setOn(true);
    ok("1 總開關關時打不開(不叫 enable)", r.ok === false && m.of(RL.EP.enable).length === 0 && m.r.isOn() === false);
    await m.end(); }
  { const m = rig({ resp: { [RL.EP.enable]: { status: 500, body: {} } } }); await m.r.tick();
    const r = await m.r.setOn(true);
    ok("1 api 沒記下(enable 失敗):維持關、不輪詢", r.ok === false && m.r.isOn() === false && m.of(RL.EP.poll).length === 0);
    await m.end(); }
  { const m = rig(); await m.r.tick();
    ok("1 預設關(沒有狀態檔):總開關開也不輪詢", m.r.isOn() === false && m.of(RL.EP.poll).length === 0);
    const r = await m.r.setOn(true); await wait(20);
    const p = m.of(RL.EP.poll)[0];
    ok("1 打開:enable → 開始長輪詢(帶兩顆憑證、衍生的裝置代號、版號)", r.ok && m.r.isOn() && p && p.token === TOKEN && p.app_secret === SECRET && /^[0-9a-f]{32}$/.test(p.device) && p.ver === "0.1.37");
    ok("1 打開記 phone_chat_on", m.tracked.includes("phone_chat_on"));
    await m.end(); }

  // ── 2 ──
  { const m = rig({ sessions: { "desktop-abcd1234": { last: Date.now() / 1000, rows: [{ id: 1, role: "user", content: "x", created_at: 1 }] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.calls.length = 0;
    m.feed([msg("desktop-abcd1234", "msg00000001", "幫我看 BTC")]); await wait(30);
    const ack = m.of(RL.EP.ack)[0], ackAt = m.calls.findIndex((c) => c[0] === RL.EP.ack);
    ok("2 收件:ack 帶 message_id,先於交回合表", ack && ack.message_ids[0] === "msg00000001" && ackAt >= 0);
    ok("2 交回合表:origin mobile、sessionId、原文、電腦存的型號", m.started.length === 1 && m.started[0][1] === "mobile" && m.started[0][0].sessionId === "desktop-abcd1234" && m.started[0][0].message === "幫我看 BTC" && m.started[0][0].model === "m1");
    ok("2 真的開跑才記 phone_turn", m.tracked.includes("phone_turn"));
    m.r.onTurn("desktop-abcd1234", "turn-event", { type: "text", text: "token=" + TOKEN + " 跟 envSecretVal99 跟 " + SECRET });
    m.r.onTurn("desktop-abcd1234", "turn-event", { type: "text", text: "第二段" });
    m.r.onTurn("desktop-zzzz9999", "turn-event", { type: "text", text: "別條電腦前的回合" });
    ok("2 300 毫秒內不送", m.chunks().length === 0);
    await wait(RL.BATCH_MS + 120);
    const cs = m.chunks();
    ok("2 一批兩段、帶 message_id;別條電腦前的回合不轉", cs.length === 2 && cs.every((c) => c.message_id === "msg00000001" && c._sid === "desktop-abcd1234"));
    ok("2 字串過遮蔽:帳號 token、app_secret、.env 值都不出門", !JSON.stringify(cs).includes(TOKEN) && !JSON.stringify(cs).includes(SECRET) && !JSON.stringify(cs).includes("envSecretVal99"), cs);
    m.calls.length = 0;
    m.r.onTurn("desktop-abcd1234", "turn-event", { type: "done", awaiting: false }); await wait(10);
    ok("2 done 立刻送(不等 300 毫秒)", m.chunks().some((c) => c.type === "done"));
    await m.end(); }

  // ── 3 ──
  { const m = rig({ busy: ["desktop-q0000001"], sessions: { "desktop-q0000001": { last: Date.now() / 1000, rows: [{ id: 5, role: "user", content: "x", created_at: 1 }] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20); m.calls.length = 0;
    m.feed([msg("desktop-q0000001", "msg0000000a"), msg("desktop-q0000001", "msg0000000b")]); await wait(30);
    const q = m.chunks().filter((c) => c.type === "queued").map((c) => c.message_id);
    ok("3 同一條在跑(電腦前的人):兩句都排隊、回 queued、記 phone_turn_q、不開跑", q.join() === "msg0000000a,msg0000000b" && m.started.length === 0 && m.tracked.filter((x) => x === "phone_turn_q").length === 2);
    m.feed([], [{ type: "withdraw", session_id: "desktop-q0000001", message_id: "msg0000000b" }]); await wait(30);
    ok("3 撤回排隊中的那句:回 canceled", m.chunks().some((c) => c.type === "canceled" && c.message_id === "msg0000000b"));
    m.busy.delete("desktop-q0000001"); m.calls.length = 0;
    m.r.onTurn("desktop-q0000001", "turn-end", { code: 0, errTail: "" }); await wait(30);
    ok("3 上一輪結束:排隊的下一句開跑、回 started", m.started.length === 1 && m.started[0][0].message === "hi" && m.chunks().some((c) => c.type === "started" && c.message_id === "msg0000000a"));
    m.feed([], [{ type: "interrupt", session_id: "desktop-q0000001" }]); await wait(30);
    ok("3 停止跑中的手機那一輪:叫 stopTurn(那一條)", m.stopped.join() === "desktop-q0000001");
    m.sessions["desktop-q0000001"].rows.push({ id: 6, role: "user", content: "hi", created_at: 2 }, { id: 7, role: "assistant", content: "ok", created_at: 3 });
    m.busy.delete("desktop-q0000001"); m.calls.length = 0;
    m.r.onTurn("desktop-q0000001", "turn-end", { code: 0, errTail: "", canceled: false }); await wait(20);
    ok("3 結束時沒有 done/error:補一則 error(turn_failed)", m.chunks().some((c) => c.type === "error" && c.code === "turn_failed" && c.message_id === "msg0000000a"));
    ok("3 手機那一輪的用戶那句記成 origin(「來自手機」標籤、上傳 origin app)", JSON.stringify(m.origins["desktop-q0000001"]) === "[6]", m.origins);
    m.busy.add("desktop-q0000001");
    m.feed([msg("desktop-q0000001", "msg0000000c")]); await wait(20);
    m.feed([], [{ type: "interrupt", session_id: "desktop-q0000001" }]); await wait(20);
    ok("3 停止時那條只有排隊的手機句:取消排隊(canceled),不停電腦前的人那一輪", m.chunks().some((c) => c.type === "canceled" && c.message_id === "msg0000000c") && m.stopped.length === 1);
    await m.end(); }

  // ── 4 ──
  { const m = rig({ sessions: { "desktop-r0000001": { last: 1, rows: [{ id: 1, role: "user", content: "x", created_at: 1 }] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20); m.calls.length = 0;
    m.setRestarting(true); m.feed([msg("desktop-r0000001", "msg0000000r")]); await wait(20);
    ok("4 更新重開收工中:回 desktop_restarting、不開跑", m.chunks().some((c) => c.code === "desktop_restarting") && m.started.length === 0);
    m.setRestarting(false); m.calls.length = 0;
    m.feed([msg("desktop-notmine1", "msg0000000s"), msg("desktop-mnew0001", "msg0000000t"), { type: "user_message", message_id: "../x", session_id: "desktop-mnew0001", content: "x" }]); await wait(20);
    ok("4 不是這台的對話 → bad_session;api 開的新對話(desktop-m…)照跑;壞 message_id 整則不理", m.chunks().some((c) => c.code === "bad_session" && c.message_id === "msg0000000s") && m.started.length === 1 && m.started[0][0].sessionId === "desktop-mnew0001");
    m.r.onTurn("desktop-mnew0001", "turn-end", { code: 1, errTail: "AGENT_BIN_MISSING" }); await wait(20);
    ok("4 開跑前就失敗(引擎不見):錯誤代號照外殼的分類送", m.chunks().some((c) => c.code === "agent_bin_missing"));
    m.busy.add("desktop-r0000001"); m.feed([msg("desktop-r0000001", "msg0000000u")]); await wait(20); m.calls.length = 0;
    await m.end();
    ok("4 結束 app:排隊的那句回 not_run", m.chunks().some((c) => c.code === "not_run" && c.message_id === "msg0000000u")); }
  { const m = rig({ startResult: () => ({ blocked: "UPDATE_REQUIRED" }), sessions: { "desktop-b0000001": { last: 1, rows: [{ id: 1, role: "user", content: "x", created_at: 1 }] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.feed([msg("desktop-b0000001", "msg0000000v")]); await wait(20);
    ok("4 版本閘擋下:回 update_required", m.chunks().some((c) => c.code === "update_required"));
    await m.end(); }

  // ── 5 ──
  { const m = rig({ busy: ["desktop-d0000001"], sessions: { "desktop-d0000001": { last: 1, rows: [{ id: 1, role: "user", content: "x", created_at: 1 }] }, "desktop-d0000002": { last: 1, rows: [{ id: 1, role: "user", content: "y", created_at: 1 }] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20); m.calls.length = 0;
    m.feed([], [{ type: "session_delete", session_id: "desktop-d0000001" }, { type: "session_delete", session_id: "desktop-d0000002" }]); await wait(20);
    const cs = m.chunks();
    ok("5 手機要刪:跑中那條拒刪(delete_refused)、閒著的刪掉回 session_delete", cs.some((c) => c.type === "delete_refused" && c.session_id === "desktop-d0000001") && cs.some((c) => c.type === "session_delete" && c.session_id === "desktop-d0000002") && m.removed.join() === "desktop-d0000002");
    await m.end(); }
  { let fail = true;
    const m = rig({ resp: { [RL.EP.report]: () => (fail ? { status: 0, body: null } : { status: 200, body: {} }) } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.r.sessionDeleted("desktop-e0000001"); await wait(30);
    const ob = path.join(m.stateDir, RL.OUTBOX);
    ok("5 電腦上刪:先落地 relay-outbox.jsonl;送不出去留著", fs.existsSync(ob) && fs.readFileSync(ob, "utf8").includes("desktop-e0000001"));
    fail = false; await m.r.tick(); await wait(30);
    ok("5 連上之後送 session_delete、送成就從待送清單拿掉", m.of(RL.EP.report).some((b) => b.chunks[0].type === "session_delete" && b.session_id === "desktop-e0000001") && !fs.existsSync(ob));
    await m.end(); }

  // ── 6 ──
  { const now = Date.now(), big = "長".repeat(20000);
    const rows = []; for (let i = 1; i <= 150; i++) rows.push({ id: i, role: i % 2 ? "user" : "assistant", content: i === 1 ? "第一句 api_key=abcd1234efgh" : i === 3 ? big : "r" + i, created_at: now / 1000 });   // gitleaks:allow (fake)
    rows.push({ id: 151, role: "tool", content: "不傳", created_at: now / 1000 });
    const m = rig({ sessions: { "desktop-s0000001": { last: now / 1000, rows }, "desktop-s0000002": { last: now / 1000 - 40 * 86400, rows: [{ id: 1, role: "user", content: "舊", created_at: 1 }] },
      "desktop-s0000003": { last: now / 1000, rows: [{ id: 1, role: "user", content: "a", created_at: 1 }, { id: 2, role: "assistant", content: "b", created_at: 1 }, { id: 3, role: "user", content: "c", created_at: 1 }] } },
      serverIds: { "desktop-s0000003": 2 } });
    m.origins["desktop-s0000001"] = [5];
    await m.r.tick(); await m.r.setOn(true); await wait(2600);
    const batches = m.of(RL.EP.sync), all = batches.flatMap((b) => b.sessions);
    const s1 = all.filter((s) => s.session_id === "desktop-s0000001").flatMap((s) => s.turns);
    ok("6 只傳近 30 天的對話", !all.some((s) => s.session_id === "desktop-s0000002"));
    ok("6 一批最多 100 則", batches.every((b) => b.sessions.reduce((n, s) => n + s.turns.length, 0) <= RL.SYNC_BATCH_TURNS) && batches.length >= 2);
    ok("6 只傳 user / assistant", s1.length === 150 && s1.every((x) => x.role === "user" || x.role === "assistant"));
    ok("6 內文與標題過遮蔽", s1[0].content === "第一句 api_key=⟦R⟧" && all.find((s) => s.session_id === "desktop-s0000001").title === "第一句 api_key=⟦R⟧");
    ok("6 單則超過 32 KB 截斷加「…」", Buffer.byteLength(s1[2].content) <= RL.TURN_MAX_BYTES && s1[2].content.endsWith("…"));
    ok("6 手機送的那句 origin app,其餘 desktop", s1.find((x) => x.id === 5).origin === "app" && s1.find((x) => x.id === 1).origin === "desktop");
    const s3 = all.filter((s) => s.session_id === "desktop-s0000003").flatMap((s) => s.turns);
    ok("6 照 sync_state 只補伺服器沒有的(id > 2)", s3.map((x) => x.id).join() === "3");
    ok("6 第一次上傳完成記 phone_sync_ok、狀態寫已同步", m.tracked.includes("phone_sync_ok") && m.r.state().sync.synced === true);
    m.calls.length = 0;
    m.sessions["desktop-s0000003"].rows.push({ id: 4, role: "assistant", content: "d", created_at: 2 });
    m.r.onTurn("desktop-s0000003", "turn-end", { code: 0 }); await wait(1300);
    const inc = m.of(RL.EP.sync).flatMap((b) => b.sessions).flatMap((s) => s.turns);
    ok("6 任何一輪結束(電腦前的人那輪也算)補傳新的那幾則", inc.map((x) => x.id).join() === "4", inc);
    await m.end(); }
  { const m = rig({ resp: { [RL.EP.syncState]: { status: 500, body: {} } } });
    await m.r.tick(); await m.r.setOn(true); await wait(30);
    ok("6 同步失敗:畫面要出重試、記 phone_sync_fail", m.r.state().sync.error === true && m.tracked.includes("phone_sync_fail"));
    await m.end(); }

  // ── 7 ──
  { let dis = { status: 0, body: null };
    const m = rig({ resp: { [RL.EP.disable]: () => dis } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    const r = await m.r.setOn(false);
    ok("7 關掉:叫 disable;沒網路記待刪", r.ok && r.pending === true && m.r.state().pending === true && m.tracked.includes("phone_chat_off"));
    const st = JSON.parse(fs.readFileSync(path.join(m.dir, "relay.json"), "utf8"));
    ok("8 狀態檔只有布林", Object.values(st).every((v) => typeof v === "boolean") && !JSON.stringify(st).includes(TOKEN));
    dis = { status: 200, body: {} }; await m.r.tick();
    ok("7 下一輪重送刪除、送成就清掉待刪", m.r.state().pending === false && m.of(RL.EP.disable).length === 2);
    await m.end(); }
  { const m = rig(); await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.polls.push({ status: 403, body: { error_code: "APP_CHAT_OFF" } }); m.feed([]); await wait(30);
    const n = m.of(RL.EP.poll).length; await wait(50);
    ok("7 總開關回 APP_CHAT_OFF:當場停、畫面藏起來", m.r.state().visible === false && m.of(RL.EP.poll).length === n);
    await m.end(); }
  { const m = rig(); await m.r.tick(); await m.r.setOn(true); await wait(20);
    await m.r.signOut();
    ok("7 登出:撤銷前刪伺服器那份;之後要重新確認才開", m.of(RL.EP.disable).length === 1 && m.r.isOn() === false);
    const s = m.r.state();
    ok("8 給畫面的狀態沒有憑證", !JSON.stringify(s).includes(TOKEN) && !JSON.stringify(s).includes(SECRET));
    await m.end(); }

  // ── 9 ──
  const send = main.slice(main.indexOf("function sendTurn(sid, ch, payload) {"), main.indexOf("function turnNice("));
  ok("9 sendTurn 先交給 relay,再看有沒有視窗", send.indexOf("_relay.onTurn(sid, ch, payload)") > 0 && send.indexOf("_relay.onTurn") < send.indexOf("const w = turnWin();"));
  ok("9 手機那一輪帶 BLAVE_TURN_ORIGIN=app,其餘不帶", /\.\.\.\(rec\.origin === "mobile" \? \{ BLAVE_TURN_ORIGIN: "app" \} : \{\}\),/.test(main));
  ok("9 畫面刪對話成功才記待送;手機要刪的走 deleteSessionLocal(不再回送)", /const ok = deleteSessionLocal\(id\);\n  if \(ok && typeof _relay !== "undefined" && _relay\) \{ try \{ _relay\.sessionDeleted\(id\);/.test(main) && /remove: deleteSessionLocal/.test(main));
  ok("9 手機回合防睡:awakeWanted 認 phone、結束後再撐 2 分鐘", /if \(o\.phone\) return true;/.test(main) && /const RELAY_AWAKE_TAIL_MS = 2 \* 60 \* 1000;/.test(main));
  ok("9 開著時關視窗只收起來", /if \(quitting \|\| quitConfirmed \|\| \(!trading && !turn && !phone\)\) \{/.test(main));
  ok("9 結束 app 等 relay 回 not_run", /relayQuit \? _relay\.quit\(\)\.catch\(\(\) => false\) : null/.test(main));
  ok("9 只有拿到單一實例鎖的那份開長輪詢", /if \(app\.hasSingleInstanceLock\(\)\) startStep\("relay", \(\) => relay\(\)\.start\(\)\);/.test(main));

  clearInterval(keepAlive);
  console.log(red ? `\n${red} FAIL` : "\nall pass");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
