// 手機 App 跟這台電腦對話(shell/relay.js + main.js 的接線;spec mobile-agent-chat-mvp §1.3、§2.6–§2.7、§3.2、§4)。
// api 用假的 post,形狀照 api openclaw/relay.py(poll／ack／report／sync_state／sync／phones);回合表與 session.db 也是假的。不開視窗、不打網路。
//   1. 總開關讀不到 / 關:不輪詢;打開要總開關開著、api 記下才算開
//   2. 收件:ack 完才交回合表(origin mobile),rejected 的不跑;開跑回 started{message_id};chunk 300 毫秒一批、一個 POST 多條對話;
//      回合的 chunk 帶那一輪的 message_id(關聯);字串過遮蔽
//   3. 同一條在跑:排隊回 queued,上一輪結束才開跑;撤回／停止排隊回 cancelled{message_ids};report 回應的 interrupt／cancel 照停
//   4. 還沒開跑就不跑的送 message_failed(not_run／desktop_restarting／bad_session／bad_message);開跑後沒說結果就結束補回合的 error;
//      排隊叫出的那句先回報 started、api 回 ok 才開跑;401／409 停掉手機的回合、清空排隊;結束 app 排隊的回 not_run
//   5. 刪除:跑中拒刪;電腦上刪的先落地 relay-outbox.jsonl、送成才拿掉
//   6. 上傳:近 30 天、≤ 100 則一批、32 KB 截斷、時間是 ms、手機那句 origin app＋message_id、照 sync_state 補缺的、墓碑不傳、先送 done 再同步
//   7. 關掉刪伺服器那份、沒網路記待刪;poll reason off → 停、藏起來;reason not_enabled／409 → 重打 enable
//   8. 狀態檔只有布林;給畫面的沒有憑證;圖只送手機那一輪;手機清單／勾選／撤銷／最近操作
//   9. main.js 接線
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
  const calls = [], polls = [], started = [], stopped = [], removed = [], tracked = [], changes = [], origins = {};
  let flag = o.flag !== false, serverOn = o.serverOn !== false, restarting = false;
  const busy = new Set(o.busy || []);
  const resp = Object.assign({}, o.resp || {});
  const sessions = o.sessions || {};   // sid → { last, rows: [{ id, role, content, created_at }] }
  let pollWaiter = null;
  const post = async (url, body) => {
    const ep = url.slice(API.length);
    calls.push([ep, body]);
    if (resp[ep]) return typeof resp[ep] === "function" ? resp[ep](body) : resp[ep];
    if (ep === RL.EP.enabled) return { status: 200, body: { enabled: flag, on: serverOn } };
    if (ep === RL.EP.enable) { serverOn = true; return { status: 200, body: { enabled: true } }; }
    if (ep === RL.EP.poll) { if (polls.length) return polls.shift(); return new Promise((res) => { pollWaiter = res; }); }
    if (ep === RL.EP.ack) return { status: 200, body: { acked: body.message_ids.filter((m) => !(o.reject || []).includes(m)), rejected: body.message_ids.filter((m) => (o.reject || []).includes(m)) } };
    if (ep === RL.EP.syncState) return { status: 200, body: { sessions: o.serverIds || [], tombstones: o.tombstones || [], server_time: 1 } };
    if (ep === RL.EP.report) return { status: 200, body: { results: body.chunks.map(() => ({ status: "ok" })), interrupt: [], cancel: [] } };
    return { status: 200, body: { ok: true } };
  };
  const r = RL.createRelay({
    dir, stateDir, apiBase: API, post, getCreds: () => ({ token: TOKEN, appSecret: SECRET }), installId: () => "11111111-2222-4333-8444-555555555555", ver: "0.1.37",
    startTurn: async (payload, origin) => { started.push([payload, origin]); if (o.startResult) return o.startResult(payload); busy.add(payload.sessionId); return { started: true }; },
    stopTurn: (sid) => { stopped.push(sid); return true; }, turnBusy: (sid) => busy.has(sid), isRestarting: () => restarting,
    sessions: {
      list: () => Object.entries(sessions).map(([id, s]) => ({ id, last: s.last, title: "" })),
      rowsAfter: (sid, after, limit, latest) => { const rows = ((sessions[sid] || {}).rows || []).filter((x) => x.id > after); return latest && !after ? rows.slice(-limit) : rows.slice(0, limit); },
      maxId: (sid) => { const rows = (sessions[sid] || {}).rows || []; return rows.length ? rows[rows.length - 1].id : 0; },
      exists: (sid) => !!sessions[sid], remove: (sid) => { removed.push(sid); delete sessions[sid]; return true; },
    },
    turnArgs: () => ({ model: "m1" }), known: () => ["envSecretVal99"],
    origins: { add: (sid, rows) => { origins[sid] = (origins[sid] || []).concat(rows); }, get: (sid) => new Map((origins[sid] || []).map((x) => [x.id, x.mid])) },
    track: (n) => tracked.push(n), onChange: (st) => changes.push(st), now: o.now, pingMs: o.pingMs, claimDeadlineMs: o.claimDeadlineMs,
  });
  return { r, changes, dir, stateDir, calls, polls, started, stopped, removed, tracked, origins, busy, sessions, resp,
    feed: (msgs, controls, extra) => { const v = { status: 200, body: Object.assign({ enabled: true, messages: msgs || [], controls: controls || [], server_time: 1 }, extra || {}) }; if (pollWaiter) { const w = pollWaiter; pollWaiter = null; w(v); } else polls.push(v); },
    setFlag: (v) => { flag = v; }, setServerOn: (v) => { serverOn = v; }, setRestarting: (v) => { restarting = v; },
    of: (ep) => calls.filter((c) => c[0] === ep).map((c) => c[1]),
    chunks: () => calls.filter((c) => c[0] === RL.EP.report).flatMap((c) => c[1].chunks),
    end: async () => { await r.quit(); if (pollWaiter) { const w = pollWaiter; pollWaiter = null; w({ status: 0, body: null }); } },
  };
}
// api relay._message_shape:沒有 type
const msg = (sid, id, content) => ({ message_id: id, session_id: sid, content: content || "hi", timestamp: Date.now(), origin: "app", device_label: "iPhone 15" });
const row = (id, role, content, sec) => ({ id, role, content, created_at: sec || 1700000000.5 });

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
    ok("1 打開:enable → 長輪詢(兩顆憑證、衍生裝置代號、版號、restarting false)", r.ok && m.r.isOn() && p && p.token === TOKEN && p.app_secret === SECRET && /^[0-9a-f]{32}$/.test(p.device) && p.ver === "0.1.37" && p.restarting === false);
    ok("1 打開記 phone_chat_on", m.tracked.includes("phone_chat_on"));
    await m.end(); }

  // ── 2 ──
  { const m = rig({ reject: ["msg0000000x"], sessions: { "desktop-abcd1234": { last: Date.now() / 1000, rows: [row(1, "user", "x")] }, "desktop-efgh5678": { last: Date.now() / 1000, rows: [row(1, "user", "y")] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20); m.calls.length = 0;
    m.feed([msg("desktop-abcd1234", "msg00000001", "幫我看 BTC"), msg("desktop-efgh5678", "msg0000000x")]); await wait(40);
    const ackAt = m.calls.findIndex((c) => c[0] === RL.EP.ack);
    ok("2 收件先 ack(一次帶全部 id)", ackAt >= 0 && m.calls[ackAt][1].message_ids.join() === "msg00000001,msg0000000x");
    ok("2 ack 回 rejected 的那句不跑;其他交回合表(origin mobile、電腦存的型號)", m.started.length === 1 && m.started[0][1] === "mobile" && m.started[0][0].sessionId === "desktop-abcd1234" && m.started[0][0].message === "幫我看 BTC" && m.started[0][0].model === "m1");
    ok("2 開跑就回 started{session_id, message_id}、記 phone_turn", m.chunks().some((c) => c.type === "started" && c.session_id === "desktop-abcd1234" && c.message_id === "msg00000001") && m.tracked.includes("phone_turn"));
    m.calls.length = 0;
    m.r.onTurn("desktop-abcd1234", "turn-event", { type: "text", text: "token=" + TOKEN + " 跟 envSecretVal99 跟 " + SECRET });
    m.r.onTurn("desktop-abcd1234", "turn-event", { type: "text", text: "第二段" });
    m.r.onTurn("desktop-abcd1234", "turn-event", { type: "strategies", items: [] });
    m.r.onTurn("desktop-zzzz9999", "turn-event", { type: "text", text: "別條電腦前的回合" });
    ok("2 300 毫秒內不送", m.chunks().length === 0);
    await wait(RL.BATCH_MS + 120);
    const cs = m.chunks();
    ok("2 一批送兩段;每段帶 session_id 與那一輪的 message_id;strategies 與別條電腦前的回合不轉", cs.length === 2 && cs.every((c) => c.session_id === "desktop-abcd1234" && c.message_id === "msg00000001") && m.of(RL.EP.report).length === 1, cs);
    ok("2 字串過遮蔽:帳號 token、app_secret、.env 值都不出門", !JSON.stringify(cs).includes(TOKEN) && !JSON.stringify(cs).includes(SECRET) && !JSON.stringify(cs).includes("envSecretVal99"), cs);
    m.r.onTurn("desktop-abcd1234", "turn-event", { type: "export", target: "pine", strategy: "btc_trend", content: "SECRET_STRATEGY_BODY = 42" });
    await wait(RL.BATCH_MS + 120);
    const xp = m.chunks().find((c) => c.type === "export");
    ok("2 轉出卡:策略程式全文不出門", xp && xp.strategy === "btc_trend" && !JSON.stringify(m.of(RL.EP.report)).includes("SECRET_STRATEGY_BODY"), xp);
    m.calls.length = 0;
    m.r.onTurn("desktop-abcd1234", "turn-event", { type: "done", awaiting: false }); await wait(10);
    ok("2 done 立刻送(不等 300 毫秒)", m.chunks().some((c) => c.type === "done"));
    await m.end(); }
  { const m = rig({ sessions: { "desktop-a0000001": { last: 1, rows: [row(1, "user", "x")] }, "desktop-a0000002": { last: 1, rows: [row(1, "user", "x")] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.feed([msg("desktop-a0000001", "msg000000a1"), msg("desktop-a0000002", "msg000000a2")]); await wait(30); m.calls.length = 0;
    m.r.onTurn("desktop-a0000001", "turn-event", { type: "text", text: "a" });
    m.r.onTurn("desktop-a0000002", "turn-event", { type: "text", text: "b" });
    await wait(RL.BATCH_MS + 120);
    ok("2 兩條對話的 chunk 同一個 POST", m.of(RL.EP.report).length === 1 && new Set(m.chunks().map((c) => c.session_id)).size === 2);
    for (let i = 0; i < 120; i++) m.r.onTurn("desktop-a0000001", "turn-event", { type: "text", text: "t" + i });
    m.calls.length = 0; await wait(RL.BATCH_MS + 200);
    ok("2 一個 POST 最多 50 段", m.of(RL.EP.report).length === 3 && m.of(RL.EP.report).every((b) => b.chunks.length <= RL.REPORT_MAX_CHUNKS));
    m.resp[RL.EP.report] = { status: 200, body: { results: [], interrupt: ["desktop-a0000001"], cancel: ["msg000000a2"] } };
    m.r.onTurn("desktop-a0000001", "turn-event", { type: "text", text: "x" }); await wait(RL.BATCH_MS + 120);
    ok("2 report 回 interrupt(對話)、cancel(訊息):兩條手機的回合都停", m.stopped.includes("desktop-a0000001") && m.stopped.includes("desktop-a0000002"), m.stopped);
    delete m.resp[RL.EP.report];
    await m.end(); }

  // ── 3 ──
  { const m = rig({ busy: ["desktop-q0000001"], sessions: { "desktop-q0000001": { last: Date.now() / 1000, rows: [row(5, "user", "x")] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20); m.calls.length = 0;
    m.feed([msg("desktop-q0000001", "msg0000000a"), msg("desktop-q0000001", "msg0000000b"), msg("desktop-q0000001", "msg0000000c")]); await wait(30);
    const q = m.chunks().filter((c) => c.type === "queued").map((c) => c.message_id);
    ok("3 同一條在跑(電腦前的人):三句都排隊、回 queued、記 phone_turn_q、不開跑", q.join() === "msg0000000a,msg0000000b,msg0000000c" && m.started.length === 0 && m.tracked.filter((x) => x === "phone_turn_q").length === 3);
    const sids3 = JSON.stringify(m.r.state().phoneSids), seen3 = m.changes.length;
    m.feed([], [{ type: "withdraw", session_id: "desktop-q0000001", message_id: "msg0000000b" }]); await wait(30);
    ok("3 分頁上的手機記號:state().phoneSids 是每條對話手機那幾句(排隊三句 → 3,撤回一句 → 2),只有 sid 與數字;排隊變了就通知畫面(onChange)", sids3 === '{"desktop-q0000001":3}' && JSON.stringify(m.r.state().phoneSids) === '{"desktop-q0000001":2}' && seen3 > 0 && m.changes.length > seen3);
    ok("3 撤回排隊中的那句:回 cancelled{message_ids}", m.chunks().some((c) => c.type === "cancelled" && JSON.stringify(c.message_ids) === '["msg0000000b"]'));
    m.resp[RL.EP.report] = { status: 200, body: { results: [], interrupt: [], cancel: ["msg0000000c"] } };
    m.r.onTurn("desktop-q0000001", "turn-event", { type: "text", text: "電腦前的人那一輪" });   // 不是手機的那輪:不轉
    m.feed([], [{ type: "withdraw", session_id: "desktop-q0000001", message_id: "nothing-here" }]); await wait(20);
    m.r.sessionDeleted("desktop-unrelated1"); await wait(40);   // 觸發一次 report,讓假 api 回 cancel
    delete m.resp[RL.EP.report];
    ok("3 report 回 cancel 的那句(排隊中):直接拿掉", !(m.r._internals.queue.get("desktop-q0000001") || []).some((x) => x.message_id === "msg0000000c"));
    m.busy.delete("desktop-q0000001"); m.calls.length = 0;
    m.r.onTurn("desktop-q0000001", "turn-end", { code: 0, errTail: "" }); await wait(30);
    ok("3 上一輪結束:排隊的下一句開跑、回 started", m.started.length === 1 && m.started[0][0].message === "hi" && m.chunks().some((c) => c.type === "started" && c.message_id === "msg0000000a"));
    m.feed([], [{ type: "interrupt", session_id: "desktop-q0000001" }]); await wait(30);
    ok("3 停止跑中的手機那一輪:叫 stopTurn(那一條)", m.stopped.join() === "desktop-q0000001");
    m.sessions["desktop-q0000001"].rows.push(row(6, "user", "hi"), row(7, "assistant", "ok"));
    m.busy.delete("desktop-q0000001"); m.calls.length = 0;
    m.r.onTurn("desktop-q0000001", "turn-end", { code: 0, errTail: "", canceled: false }); await wait(20);
    const tail = m.chunks().find((c) => c.type === "error");
    ok("4 回合沒有 done/error 就結束:補一則回合的 error(type error,不是 message_failed)", tail && tail.session_id === "desktop-q0000001" && !m.chunks().some((c) => c.type === "message_failed"), tail);
    ok("3 手機那一輪的用戶那句記下 turn id＋message_id", JSON.stringify(m.origins["desktop-q0000001"]) === JSON.stringify([{ id: 6, mid: "msg0000000a" }]), m.origins);
    m.busy.add("desktop-q0000001");
    m.feed([msg("desktop-q0000001", "msg0000000d")]); await wait(20);
    m.feed([], [{ type: "interrupt", session_id: "desktop-q0000001" }]); await wait(20);
    ok("3 停止時只有排隊的手機句:取消排隊(cancelled),不停電腦前的人那一輪", m.chunks().some((c) => c.type === "cancelled" && c.message_ids.includes("msg0000000d")) && m.stopped.length === 1);
    await m.end(); }

  // ── 4 ──
  { const m = rig({ sessions: { "desktop-r0000001": { last: 1, rows: [row(1, "user", "x")] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20); m.calls.length = 0;
    m.setRestarting(true); m.feed([msg("desktop-r0000001", "msg0000000r")]); await wait(20);
    ok("4 更新重開收工中:回 message_failed{message_id, code: desktop_restarting}、不開跑", m.chunks().some((c) => c.type === "message_failed" && c.message_id === "msg0000000r" && c.code === "desktop_restarting") && m.started.length === 0);
    ok("4 poll 帶 restarting true", m.of(RL.EP.poll).some((b) => b.restarting === true));
    m.setRestarting(false); m.calls.length = 0;
    m.feed([msg("desktop-notmine1", "msg0000000s"), msg("desktop-mnew0001", "msg0000000t"), { message_id: "../x", session_id: "desktop-mnew0001", content: "x" }]); await wait(20);
    ok("4 不是這台的對話 → bad_session;api 開的新對話(desktop-m…)照跑;壞 message_id 整則不理", m.chunks().some((c) => c.type === "message_failed" && c.code === "bad_session" && c.message_id === "msg0000000s") && m.started.length === 1 && m.started[0][0].sessionId === "desktop-mnew0001" && !m.of(RL.EP.ack).some((b) => b.message_ids.includes("../x")));
    ok("4 message_failed 的 code 只有四種;回合的 error 不帶 code", m.chunks().filter((c) => c.type === "message_failed").every((c) => ["not_run", "desktop_restarting", "bad_session", "bad_message"].includes(c.code)) && m.chunks().filter((c) => c.type === "error").every((c) => !("code" in c)));
    m.busy.add("desktop-r0000001"); m.feed([msg("desktop-r0000001", "msg0000000u")]); await wait(20); m.calls.length = 0;
    await m.end();
    ok("4 結束 app:排隊的那句回 message_failed not_run", m.chunks().some((c) => c.type === "message_failed" && c.code === "not_run" && c.message_id === "msg0000000u")); }
  { const m = rig({ startResult: () => ({ blocked: "UPDATE_REQUIRED" }), sessions: { "desktop-b0000001": { last: 1, rows: [row(1, "user", "x")] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.feed([msg("desktop-b0000001", "msg0000000v")]); await wait(20);
    ok("4 版本閘擋下(認領之後):回 start_aborted,api 改回沒跑", m.chunks().some((c) => c.type === "started" && c.message_id === "msg0000000v") && m.chunks().some((c) => c.type === "start_aborted" && c.message_id === "msg0000000v"));
    await m.end(); }

  { // 排隊叫出:先 started、api 回 ok 才開跑;回 cancel 就不跑
    const m = rig({ busy: ["desktop-p0000001"], sessions: { "desktop-p0000001": { last: 1, rows: [row(1, "user", "x")] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.feed([msg("desktop-p0000001", "msg000000p1"), msg("desktop-p0000001", "msg000000p2")]); await wait(30);
    m.resp[RL.EP.report] = (b) => ({ status: 200, body: { results: b.chunks.map((c) => (c.message_id === "msg000000p1" ? { status: "cancel", message_id: c.message_id } : { status: "ok" })), interrupt: [], cancel: b.chunks.some((c) => c.message_id === "msg000000p1") ? ["msg000000p1"] : [] } });
    m.busy.delete("desktop-p0000001"); m.calls.length = 0;
    m.r.onTurn("desktop-p0000001", "turn-end", {}); await wait(60);
    const firstStart = m.calls.findIndex((c) => c[0] === RL.EP.report && c[1].chunks.some((x) => x.type === "started"));
    ok("4 排隊叫出的那句先回報 started(單獨一筆)、api 回 cancel 就不跑(也沒有去停一輪沒開跑的);接著下一句", m.stopped.length === 0 && firstStart >= 0 && m.calls[firstStart][1].chunks.length === 1 && m.started.length === 1 && m.started[0][0].message === "hi" && m.calls.filter((c) => c[0] === RL.EP.report && c[1].chunks.some((x) => x.type === "started" && x.message_id === "msg000000p2")).length === 1, m.started);
    delete m.resp[RL.EP.report];
    await m.end(); }
  { // 401／409:停掉手機的回合、清空排隊
    const m = rig({ busy: ["desktop-z0000002"], sessions: { "desktop-z0000001": { last: 1, rows: [row(1, "user", "x")] }, "desktop-z0000002": { last: 1, rows: [row(1, "user", "x")] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.feed([msg("desktop-z0000001", "msg000000z1"), msg("desktop-z0000002", "msg000000z2")]); await wait(30);
    m.resp[RL.EP.report] = { status: 409, body: { error_code: "RELAY_NOT_ENABLED" } };
    m.r.onTurn("desktop-z0000001", "turn-event", { type: "text", text: "x" }); await wait(RL.BATCH_MS + 120);
    ok("4 report 回 409 RELAY_NOT_ENABLED:手機那一輪停、排隊清空", m.stopped.includes("desktop-z0000001") && !(m.r._internals.queue.get("desktop-z0000002") || []).length);
    delete m.resp[RL.EP.report];
    await m.end(); }
  { // 401:同樣停掉手機的回合、清空排隊
    const m = rig({ busy: ["desktop-y0000002"], sessions: { "desktop-y0000001": { last: 1, rows: [row(1, "user", "x")] }, "desktop-y0000002": { last: 1, rows: [row(1, "user", "x")] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.feed([msg("desktop-y0000001", "msg000000y1"), msg("desktop-y0000002", "msg000000y2")]); await wait(30);
    m.resp[RL.EP.report] = { status: 401, body: {} };
    m.r.onTurn("desktop-y0000001", "turn-event", { type: "text", text: "x" }); await wait(RL.BATCH_MS + 120);
    ok("4 report 回 401:手機那一輪停、排隊清空", m.stopped.includes("desktop-y0000001") && !(m.r._internals.queue.get("desktop-y0000002") || []).length && m.r.state().mobileTurns === 0);
    delete m.resp[RL.EP.report];
    await m.end(); }
  { // poll 回 403 APP_CHAT_OFF(body 帶 controls):停止與撤回照做,然後停
    const m = rig({ busy: ["desktop-o0000002"], sessions: { "desktop-o0000001": { last: 1, rows: [row(1, "user", "x")] }, "desktop-o0000002": { last: 1, rows: [row(1, "user", "x")] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.feed([msg("desktop-o0000001", "msg000000o1"), msg("desktop-o0000002", "msg000000o2")]); await wait(30);
    m.polls.push({ status: 403, body: { error_code: "APP_CHAT_OFF", controls: [{ type: "interrupt", session_id: "desktop-o0000001" }, { type: "withdraw", session_id: "desktop-o0000002", message_id: "msg000000o2" }] } });
    m.feed([]); await wait(60);
    const n = m.of(RL.EP.poll).length; await wait(50);
    ok("7 poll 回 403 APP_CHAT_OFF:跑中的停、排隊的回 message_failed not_run、停輪詢、畫面藏起來", m.stopped.includes("desktop-o0000001") && m.chunks().some((c) => c.type === "message_failed" && c.code === "not_run" && c.message_id === "msg000000o2") && m.r.state().visible === false && m.of(RL.EP.poll).length === n && m.r.state().mobileTurns === 0);
    await m.end(); }
  { // poll 回 409 RELAY_NOT_ENABLED:補打 enable 再輪;一直 409 就停
    const m = rig(); await m.r.tick(); await m.r.setOn(true); await wait(20);
    const en0 = m.of(RL.EP.enable).length, p0 = m.of(RL.EP.poll).length;
    m.polls.push({ status: 409, body: { error_code: "RELAY_NOT_ENABLED" } });
    m.feed([]); await wait(60);
    ok("7 poll 回 409 RELAY_NOT_ENABLED:補打 enable、再輪一次", m.of(RL.EP.enable).length === en0 + 1 && m.of(RL.EP.poll).length >= p0 + 2);
    await m.end(); }
  { const m = rig(); await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.polls.push({ status: 409, body: { error_code: "RELAY_NOT_ENABLED" } }, { status: 409, body: { error_code: "RELAY_NOT_ENABLED" } }, { status: 409, body: { error_code: "RELAY_NOT_ENABLED" } });
    const p0 = m.of(RL.EP.poll).length, en0 = m.of(RL.EP.enable).length;
    m.feed([]); await wait(80);
    ok("7 poll 一直回 409:enable 只補打一次、輪詢停下(不空轉)", m.of(RL.EP.enable).length === en0 + 1 && m.of(RL.EP.poll).length - p0 <= 3, [m.of(RL.EP.poll).length - p0]);
    await m.end(); }
  { // report 回 cancel＋同一條的 interrupt:只停一次
    const m = rig({ sessions: { "desktop-w0000001": { last: 1, rows: [row(1, "user", "x")] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.feed([msg("desktop-w0000001", "msg000000w1")]); await wait(30);
    m.resp[RL.EP.report] = { status: 200, body: { results: [], interrupt: ["desktop-w0000001"], cancel: ["msg000000w1"] } };
    m.r.onTurn("desktop-w0000001", "turn-event", { type: "text", text: "x" }); await wait(RL.BATCH_MS + 120);
    ok("2 report 回 cancel 與同一條的 interrupt:stopTurn 只叫一次", m.stopped.filter((s) => s === "desktop-w0000001").length === 1, m.stopped);
    delete m.resp[RL.EP.report];
    await m.end(); }
  { // poll 連續回 not_enabled、enable 卻回 200:補打一次,第二次就停(不在 30 秒內空轉)
    const m = rig(); await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.polls.push({ status: 200, body: { enabled: false, reason: "not_enabled", messages: [], controls: [] } }, { status: 200, body: { enabled: false, reason: "not_enabled", messages: [], controls: [] } });
    const p0 = m.of(RL.EP.poll).length, en0 = m.of(RL.EP.enable).length;
    m.feed([], [], { enabled: false, reason: "not_enabled" }); await wait(80);
    ok("7 not_enabled 一直回來:enable 只補打一次、輪詢停下", m.of(RL.EP.enable).length === en0 + 1 && m.of(RL.EP.poll).length - p0 <= 2, [m.of(RL.EP.poll).length - p0, m.of(RL.EP.enable).length - en0]);
    await m.end(); }
  { // ack 沒回應:一句都不跑
    const m = rig({ sessions: { "desktop-t0000001": { last: 1, rows: [row(1, "user", "x")] } }, resp: { [RL.EP.ack]: { status: 0, body: null } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.feed([msg("desktop-t0000001", "msg000000t1")]); await wait(40);
    ok("4 ack 沒回應:不跑、不回 started", m.started.length === 0 && !m.chunks().some((c) => c.type === "started"));
    await m.end(); }

  // ── 5 ──
  { const m = rig({ busy: ["desktop-d0000001"], sessions: { "desktop-d0000001": { last: 1, rows: [row(1, "user", "x")] }, "desktop-d0000002": { last: 1, rows: [row(1, "user", "y")] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20); m.calls.length = 0;
    m.feed([], [{ type: "session_delete", session_id: "desktop-d0000001" }, { type: "session_delete", session_id: "desktop-d0000002" }]); await wait(20);
    const cs = m.chunks();
    ok("5 手機要刪:跑中那條拒刪(delete_refused)、閒著的刪掉回 session_delete", cs.some((c) => c.type === "delete_refused" && c.session_id === "desktop-d0000001") && cs.some((c) => c.type === "session_delete" && c.session_id === "desktop-d0000002") && m.removed.join() === "desktop-d0000002");
    await m.end(); }
  { let fail = true;
    const m = rig({ resp: { [RL.EP.report]: () => (fail ? { status: 0, body: null } : { status: 200, body: { results: [], interrupt: [], cancel: [] } }) } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.r.sessionDeleted("desktop-e0000001"); await wait(30);
    const ob = path.join(m.stateDir, RL.OUTBOX);
    ok("5 電腦上刪:先落地 relay-outbox.jsonl;送不出去留著", fs.existsSync(ob) && fs.readFileSync(ob, "utf8").includes("desktop-e0000001"));
    fail = false; await m.r.tick(); await wait(30);
    ok("5 連上之後送 session_delete、送成就從待送清單拿掉", m.of(RL.EP.report).some((b) => b.chunks[0].type === "session_delete" && b.chunks[0].session_id === "desktop-e0000001") && !fs.existsSync(ob));
    await m.end(); }

  // ── 6 ──
  { const now = Date.now(), big = "長".repeat(20000);
    const rows = []; for (let i = 1; i <= 150; i++) rows.push(row(i, i % 2 ? "user" : "assistant", i === 1 ? "第一句 api_key=abcd1234efgh" : i === 3 ? big : "r" + i, now / 1000));   // gitleaks:allow (fake)
    rows.push(row(151, "tool", "不傳", now / 1000));
    const m = rig({ sessions: { "desktop-s0000001": { last: now / 1000, rows }, "desktop-s0000002": { last: now / 1000 - 40 * 86400, rows: [row(1, "user", "舊")] },
      "desktop-s0000003": { last: now / 1000, rows: [row(1, "user", "a"), row(2, "assistant", "b"), row(3, "user", "c")] }, "desktop-s0000004": { last: now / 1000, rows: [row(1, "user", "刪過")] } },
      serverIds: [{ session_id: "desktop-s0000003", last_id: 2 }], tombstones: ["desktop-s0000004"] });
    m.origins["desktop-s0000001"] = [{ id: 5, mid: "msg00000005" }];
    await m.r.tick(); await m.r.setOn(true); await wait(2600);
    const batches = m.of(RL.EP.sync), all = batches.flatMap((b) => b.sessions);
    const s1 = all.filter((s) => s.session_id === "desktop-s0000001").flatMap((s) => s.turns);
    ok("6 只傳近 30 天的;墓碑那條不傳", !all.some((s) => s.session_id === "desktop-s0000002") && !all.some((s) => s.session_id === "desktop-s0000004"));
    ok("6 一批最多 100 則", batches.every((b) => b.sessions.reduce((n, s) => n + s.turns.length, 0) <= RL.SYNC_BATCH_TURNS) && batches.length >= 2);
    ok("6 只傳 user / assistant", s1.length === 150 && s1.every((x) => x.role === "user" || x.role === "assistant"));
    ok("6 內文與標題過遮蔽", s1[0].content === "第一句 api_key=⟦R⟧" && all.find((s) => s.session_id === "desktop-s0000001").title === "第一句 api_key=⟦R⟧");
    ok("6 單則超過 32 KB 截斷加「…」", Buffer.byteLength(s1[2].content) <= RL.TURN_MAX_BYTES && s1[2].content.endsWith("…"));
    ok("6 時間是 ms 整數(created_at、last_at)", Number.isInteger(s1[0].created_at) && Math.abs(s1[0].created_at - now) <= 1 && Number.isInteger(all[0].last_at), [s1[0].created_at, now]);
    const t5 = s1.find((x) => x.id === 5), t1 = s1.find((x) => x.id === 1);
    ok("6 手機送的那句 origin app＋message_id;其餘 origin local、沒有 message_id", t5.origin === "app" && t5.message_id === "msg00000005" && t1.origin === "local" && !("message_id" in t1));
    const s3 = all.filter((s) => s.session_id === "desktop-s0000003").flatMap((s) => s.turns);
    ok("6 照 sync_state(陣列)只補伺服器沒有的(id > 2)", s3.map((x) => x.id).join() === "3");
    ok("6 第一次上傳完成記 phone_sync_ok、狀態寫已同步", m.tracked.includes("phone_sync_ok") && m.r.state().sync.synced === true);
    m.feed([msg("desktop-s0000003", "msg0000000e")]); await wait(30); m.calls.length = 0;
    m.sessions["desktop-s0000003"].rows.push(row(4, "user", "hi", now / 1000), row(5, "assistant", "d", now / 1000));
    // 前一批還在路上(慢 400 毫秒)時回合結束:同步要等 done 那批真的送出去
    m.resp[RL.EP.report] = (b) => new Promise((res) => setTimeout(() => res({ status: 200, body: { results: [], interrupt: [], cancel: [] } }), 400));
    m.r.onTurn("desktop-s0000003", "turn-event", { type: "error", message: "x", message_id: "should-not-pass" }); await wait(10);
    ok("2 回合的 error:message_id 換成那一輪的,type 照舊是 error", m.chunks().find((c) => c.type === "error").message_id === "msg0000000e");
    m.r.onTurn("desktop-s0000003", "turn-event", { type: "done" });
    m.r.onTurn("desktop-s0000003", "turn-end", { code: 0 }); await wait(1300);
    const iDone = m.calls.findIndex((c) => c[0] === RL.EP.report && c[1].chunks.some((x) => x.type === "done")), iSync = m.calls.findIndex((c) => c[0] === RL.EP.sync);
    const inc = m.of(RL.EP.sync).flatMap((b) => b.sessions).flatMap((s) => s.turns);
    delete m.resp[RL.EP.report];
    ok("6 一輪結束先 report done 再 sync", iDone >= 0 && iSync > iDone, [iDone, iSync]);
    ok("6 補傳新的那幾則,手機那句帶它的 message_id", inc.map((x) => x.id).join() === "4,5" && inc[0].message_id === "msg0000000e" && inc[0].origin === "app", inc);
    m.resp[RL.EP.sync] = { status: 200, body: { accepted: 0, sessions: { "desktop-s0000003": "tombstone" } } };
    m.sessions["desktop-s0000003"].rows.push(row(6, "assistant", "e", now / 1000));
    m.r.onTurn("desktop-s0000003", "turn-end", {}); await wait(1200); m.calls.length = 0;
    m.sessions["desktop-s0000003"].rows.push(row(7, "assistant", "f", now / 1000));
    m.r.onTurn("desktop-s0000003", "turn-end", {}); await wait(1200);
    ok("6 sync 回 tombstone 的那條之後不再傳", m.of(RL.EP.sync).length === 0);
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
    m.feed([], [{ type: "interrupt", session_id: "desktop-x0000001" }], { enabled: false, reason: "off" }); await wait(30);
    const n = m.of(RL.EP.poll).length; await wait(50);
    ok("7 poll 回 enabled:false reason off(舊形狀):停輪詢、畫面藏起來", m.r.state().visible === false && m.of(RL.EP.poll).length === n);
    await m.end(); }
  { const m = rig(); await m.r.tick(); await m.r.setOn(true); await wait(20);
    const en0 = m.of(RL.EP.enable).length;
    m.feed([], [], { enabled: false, reason: "not_enabled" }); await wait(40);
    ok("7 poll 回 not_enabled 而本機開著:重打 enable、繼續輪詢", m.of(RL.EP.enable).length === en0 + 1 && m.of(RL.EP.poll).length >= 2);
    await m.end(); }
  { const m = rig(); await m.r.tick(); await m.r.setOn(true); await wait(20); m.setServerOn(false);
    const en0 = m.of(RL.EP.enable).length; await m.r.tick();
    ok("7 /relay/enabled 回 on:false 而本機開著:重打 enable", m.of(RL.EP.enable).length === en0 + 1);
    await m.end(); }
  { const m = rig({ sessions: { "desktop-k0000001": { last: 1, rows: [row(1, "user", "x")] } } });
    let first = true;
    m.resp[RL.EP.ack] = (b) => (first ? (first = false, { status: 409, body: { error_code: "RELAY_NOT_ENABLED" } }) : { status: 200, body: { acked: b.message_ids, rejected: [] } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    const en0 = m.of(RL.EP.enable).length;
    m.feed([msg("desktop-k0000001", "msg0000000k")]); await wait(40);
    ok("7 ack 回 409 RELAY_NOT_ENABLED:重打 enable、再 ack 一次、才跑", m.of(RL.EP.enable).length === en0 + 1 && m.of(RL.EP.ack).length === 2 && m.started.length === 1);
    await m.end(); }
  { const m = rig(); await m.r.tick(); await m.r.setOn(true); await wait(20);
    await m.r.signOut();
    ok("7 登出:撤銷前刪伺服器那份;之後要重新確認才開", m.of(RL.EP.disable).length === 1 && m.r.isOn() === false);
    ok("8 給畫面的狀態沒有憑證", !JSON.stringify(m.r.state()).includes(TOKEN) && !JSON.stringify(m.r.state()).includes(SECRET));
    await m.end(); }

  // ── 8 圖、手機清單 ──
  { const m = rig({ sessions: { "desktop-i0000001": { last: 1, rows: [row(1, "user", "x")] } },
      resp: { [RL.EP.phones]: { status: 200, body: { max: 5, phones: [{ device_id: "devA0000001", platform: "ios", label: "iPhone 15", paired_via: "web", created_at: "2026-10-01T00:00:00Z", last_used_at: null, granted: false, extra: "x" }, { device_id: "../bad" }] } },
        [RL.EP.revoke]: { status: 200, body: { revoked: true } }, [RL.EP.actions]: { status: 200, body: { actions: [{ ts: "2026-10-30T00:00:00Z", action: "send", device: "iPhone 15", ip: "1.2.3.4" }] } } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    ok("8 圖:不是手機那一輪不送", (await m.r.image("desktop-i0000001", "image/png", "AAAA", "x")) === false && m.of(RL.EP.image).length === 0);
    m.feed([msg("desktop-i0000001", "msg0000000i")]); await wait(30);
    await m.r.image("desktop-i0000001", "image/png", "AAAA", "說明 " + TOKEN);
    const im = m.of(RL.EP.image)[0];
    ok("8 圖:手機那一輪送 /relay/image(session_id、那一句的 message_id、mime、b64),說明過遮蔽", im && im.session_id === "desktop-i0000001" && im.message_id === "msg0000000i" && im.mime === "image/png" && im.b64 === "AAAA" && !im.caption.includes(TOKEN), im);
    m.r.onTurn("desktop-i0000001", "turn-end", { code: 0 }); m.busy.delete("desktop-i0000001"); await wait(30);
    let release; const gate = new Promise((res) => { release = res; });
    m.resp[RL.EP.report] = (b) => (b.chunks.some((c) => c.type === "started") ? gate.then(() => ({ status: 200, body: { results: [{ status: "ok" }], interrupt: [], cancel: [] } }))
      : { status: 200, body: { results: b.chunks.map(() => ({ status: "ok" })), interrupt: [], cancel: [] } });
    m.feed([msg("desktop-i0000001", "msg0000001i")]); await wait(30);
    const n0 = m.of(RL.EP.image).length;
    ok("8 圖:認領中(started 還在路上)不送——那條上跑的是電腦前那個人的回合", m.r.claiming("desktop-i0000001") && (await m.r.image("desktop-i0000001", "image/png", "AAAA", "x")) === false && m.of(RL.EP.image).length === n0);
    release(); await wait(30); delete m.resp[RL.EP.report];
    const ph = await m.r.phones();
    ok("8 手機清單:只回篩過的欄位、壞 device_id 丟掉", ph.ok && ph.phones.length === 1 && !("extra" in ph.phones[0]) && ph.phones[0].granted === false && ph.phones[0].label === "iPhone 15");
    await m.r.grant("devA0000001", true);
    ok("8 勾選:送 device_id＋granted", m.of(RL.EP.grant)[0].device_id === "devA0000001" && m.of(RL.EP.grant)[0].granted === true);
    ok("8 勾選:壞 id／非布林不送", (await m.r.grant("../x", true)).ok === false && (await m.r.grant("devA0000001", "yes")).ok === false && m.of(RL.EP.grant).length === 1);
    const rv = await m.r.revoke("devA0000001", "en");
    ok("8 撤銷:送 device_id＋lang、成功記 phone_revoke", rv.ok && m.of(RL.EP.revoke)[0].lang === "en" && m.tracked.includes("phone_revoke"));
    const ac = await m.r.actions("devA0000001");
    ok("8 最近操作:時間、操作、裝置、IP", ac.ok && ac.actions[0].action === "send" && ac.actions[0].ip === "1.2.3.4");
    await m.end(); }
  { const m = rig({ pingMs: 60, sessions: { "desktop-p0000001": { last: 1, rows: [row(1, "user", "x")] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.feed([msg("desktop-p0000001", "msg0000000p")]); await wait(600);
    const pings = m.chunks().filter((c) => c.type === "ping");
    ok("8 手機那一輪跑著沒有輸出:定時送 ping(帶那一句)", pings.length >= 2 && pings.every((c) => c.session_id === "desktop-p0000001" && c.message_id === "msg0000000p"), pings);
    m.busy.delete("desktop-p0000001"); m.r.onTurn("desktop-p0000001", "turn-event", { type: "done" }); m.r.onTurn("desktop-p0000001", "turn-end", { code: 0 }); await wait(50);
    const n = m.chunks().filter((c) => c.type === "ping").length; await wait(600);
    ok("8 那一輪結束:不再送 ping", m.chunks().filter((c) => c.type === "ping").length === n);
    await m.end(); }

  // ── 8 認領只等自己那條 ──
  { const m = rig({ sessions: { "desktop-c0000001": { last: 1, rows: [row(1, "user", "x")] }, "desktop-c0000002": { last: 1, rows: [row(1, "user", "x")] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    const okBody = (b) => ({ status: 200, body: { results: b.chunks.map(() => ({ status: "ok" })), interrupt: [], cancel: [] } });
    m.resp[RL.EP.report] = (b) => wait(120).then(() => okBody(b));
    m.feed([msg("desktop-c0000002", "msg000000c2")]); await wait(400);
    let streaming = true; (async () => { while (streaming) { m.r.onTurn("desktop-c0000002", "turn-event", { type: "text", text: "x" }); await wait(40); } })();
    await wait(300);
    const t0 = Date.now(); m.feed([msg("desktop-c0000001", "msg000000c1")]);
    while (!m.started.some((x) => x[0].sessionId === "desktop-c0000001") && Date.now() - t0 < 4000) await wait(20);
    const dt = Date.now() - t0;
    ok("8 另一條手機那一輪一直在吐字:這條的認領不用等它(2 秒內開跑)", dt < 2000, dt);
    streaming = false; await wait(300); await m.end(); }
  { let down = false, doneOkAt = 0;
    const m = rig({ claimDeadlineMs: 1500, sessions: { "desktop-d0000001": { last: 1, rows: [row(1, "user", "x")] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.resp[RL.EP.report] = (b) => {
      if (down) return { status: 502, body: null };
      if (b.chunks.some((c) => c.type === "done")) doneOkAt = Date.now();
      return { status: 200, body: { results: b.chunks.map(() => ({ status: "ok" })), interrupt: [], cancel: [] } };
    };
    m.feed([msg("desktop-d0000001", "msg000000d1")]); await wait(100);
    m.feed([msg("desktop-d0000001", "msg000000d2")]); await wait(100);
    down = true; m.busy.delete("desktop-d0000001");
    m.r.onTurn("desktop-d0000001", "turn-event", { type: "done" }); m.r.onTurn("desktop-d0000001", "turn-end", { code: 0 });
    // 斷 2.2 秒:蓋過最早排的那次重送(2 秒),沒蓋過放棄時歸零重排的那次(放棄在 0.5 秒,再 2 秒)。
    // 沒歸零時,認領那段的重送把退避疊到 32 秒,done 要半分鐘後才再送
    await wait(2200); const back = Date.now(); down = false; await wait(4000);
    ok("8 認領等到放棄(lost):重送退避歸零,網路回來後上一句的 done 幾秒內就送到", doneOkAt && doneOkAt - back < 3000, doneOkAt ? doneOkAt - back : null);
    ok("8 lost 那句沒跑", m.started.length === 1);
    await m.end(); }
  { let down = false, doneOkAt = 0;
    const m = rig({ claimDeadlineMs: 1500, sessions: { "desktop-d0000001": { last: 1, rows: [row(1, "user", "x")] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.resp[RL.EP.report] = (b) => {
      if (down) return { status: 502, body: null };
      if (b.chunks.some((c) => c.type === "done")) doneOkAt = Date.now();
      return { status: 200, body: { results: b.chunks.map(() => ({ status: "ok" })), interrupt: [], cancel: [] } };
    };
    m.feed([msg("desktop-d0000001", "msg000000d1")]); await wait(100);
    m.feed([msg("desktop-d0000001", "msg000000d2")]); await wait(100);
    down = true; m.busy.delete("desktop-d0000001");
    m.r.onTurn("desktop-d0000001", "turn-event", { type: "done" }); m.r.onTurn("desktop-d0000001", "turn-end", { code: 0 });
    // 斷 3 秒:放棄時歸零重排的那次(2.5 秒)也失敗。放棄當下補送的 start_aborted／message_failed 失敗不累加退避,
    // 下一次 2 秒後(4.5 秒);累加的話是 8 秒後
    await wait(3000); const back = Date.now(); down = false; await wait(4000);
    ok("8 認領放棄當下補送的失敗不累加退避:網路回來後上一句的 done 很快送到", doneOkAt && doneOkAt - back < 2500, doneOkAt ? doneOkAt - back : null);
        await m.end(); }

  { const m = rig({ claimDeadlineMs: 1500, sessions: { "desktop-e0000001": { last: 1, rows: [row(1, "user", "x")] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.resp[RL.EP.report] = (b) => wait(b.chunks.some((c) => c.type === "done") ? 2500 : 0).then(() => ({ status: 200, body: { results: b.chunks.map(() => ({ status: "ok" })), interrupt: [], cancel: [] } }));
    m.feed([msg("desktop-e0000001", "msg000000e1")]); await wait(100);
    m.feed([msg("desktop-e0000001", "msg000000e2")]); await wait(100);
    m.busy.delete("desktop-e0000001"); m.r.onTurn("desktop-e0000001", "turn-event", { type: "done" }); m.r.onTurn("desktop-e0000001", "turn-end", { code: 0 });
    await wait(3500);
    const st = m.chunks().filter((c) => c.type === "started" && c.message_id === "msg000000e2");
    ok("8 等自己那條在路上的那批等過了認領期限:不再送 started,走 lost(start_aborted＋message_failed)", !st.length && m.started.length === 1
      && m.chunks().some((c) => c.type === "message_failed" && c.message_id === "msg000000e2"), m.chunks().map((c) => c.type));
    await m.end(); }

  { let down = false, mfAt = 0;
    const m = rig({ claimDeadlineMs: 1500, sessions: { "desktop-f0000001": { last: 1, rows: [row(1, "user", "x")] }, "desktop-f0000002": { last: 1, rows: [row(1, "user", "x")] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.resp[RL.EP.report] = (b) => {
      if (down) return { status: 502, body: null };
      if (b.chunks.some((c) => c.type === "message_failed" && c.message_id === "msg000000f1")) mfAt = Date.now();
      return { status: 200, body: { results: b.chunks.map(() => ({ status: "ok" })), interrupt: [], cancel: [] } };
    };
    m.feed([msg("desktop-f0000002", "msg000000f2")]); await wait(100);
    down = true; const t0 = Date.now();
    m.r.onTurn("desktop-f0000002", "turn-event", { type: "text", text: "別條的字" }); await wait(400);
    m.feed([msg("desktop-f0000001", "msg000000f1")]);
    // 這條直送 started 一路 502 → 約 1 秒判 lost;歸零重排在 lost 後 2 秒(約 3 秒),沒歸零就等別條那次(2 秒失敗、再 4 秒)
    while (Date.now() - t0 < 2500) await wait(20);
    const back = Date.now(); down = false; await wait(4000);
    ok("8 直送 started 判 lost:退避歸零,補送的 message_failed 很快送到", mfAt && mfAt - back < 2000, mfAt ? mfAt - back : null);
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
  ok("9 本機收圖的接收端也交給 relay(只限手機那一輪由 relay 判)", /_relay\.image\(j\.session_id, j\.mime, j\.b64, caption\)/.test(main));

  clearInterval(keepAlive);
  console.log(red ? `\n${red} FAIL` : "\nall pass");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
