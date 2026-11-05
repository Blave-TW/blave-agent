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
//   7. 關掉刪伺服器那份、沒網路記待刪;poll reason off → 停、藏起來;reason not_enabled／409 → 重打 enable;登出收尾丟掉沒送完的回報、等 disable 時不重開輪詢、不撿回上一個帳號的配對確認框、同步到一半不換 token 接著傳
//   8. 狀態檔只有布林;給畫面的沒有憑證;圖只送手機那一輪;帳號下的手機清單(唯讀,只回四個欄位)
//   9. main.js 接線
//  10. 打開只有同意框(mobile-pairing-v2-api-2026-11-02 §2):enable 不帶驗證碼、200 就開;配對確認框(§4):/relay/enabled 的 prompt、本機只問一次、〔不用〕打 prompt/seen
//  12. 換帳號(OAuth 重新登入):換 token 前照登出關掉,不帶著開關換身分
//  11. 手機回合的 fault code(mobile-chat-shell-fault-code):主行程分類、暫扣、代碼放回合的 error;沒有視窗也一樣;跟 renderer 的 regex 同一份
// 跑法:node tests/check_shell_relay.js
const fs = require("fs"), os = require("os"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const RL = require(path.join(SHELL, "relay.js"));
const main = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
// 一段跑不起來(舊碼沒有那支函式)記成一條 FAIL,後面照跑:紅要紅在斷言上,不是整支 crash
const guard = async (name, fn) => { try { await fn(); } catch (e) { ok(name + " 跑不起來", false, String((e && e.message) || e)); } };
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
    dir, stateDir, apiBase: API, post, getCreds: o.getCreds || (() => ({ token: TOKEN, appSecret: SECRET })), installId: () => "11111111-2222-4333-8444-555555555555", ver: "0.1.37", engineKind: () => o.kind,
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
    m.r.onTurn("desktop-abcd1234", "turn-event", { type: "form", id: "txf_backtest", questions: [] });   // api relay.TURN_TYPES 沒有 form:手機那邊沒有表單可畫
    m.r.onTurn("desktop-zzzz9999", "turn-event", { type: "text", text: "別條電腦前的回合" });
    ok("2 300 毫秒內不送", m.chunks().length === 0);
    await wait(RL.BATCH_MS + 120);
    const cs = m.chunks();
    ok("2 一批送兩段;每段帶 session_id 與那一輪的 message_id;strategies、form 與別條電腦前的回合不轉", cs.length === 2 && cs.every((c) => c.session_id === "desktop-abcd1234" && c.message_id === "msg00000001") && m.of(RL.EP.report).length === 1, cs);
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
    ok("8 狀態檔只有布林、問過的配對(asked:device_id:配對時間)、待補送的 seen(只有 device_id、answer)與還沒關的剛配對那一行(null 或手機的機型與時間)", Object.entries(st).every(([k, v]) => (k === "asked" ? Array.isArray(v) && v.every((x) => /^[A-Za-z0-9_-]{8,64}:\d*$/.test(x)) : k === "seenOut" ? Array.isArray(v) && v.every((x) => /^[A-Za-z0-9_-]{8,64}$/.test(x.device_id))
      : k === "notice" ? v === null || (Object.keys(v).sort().join() === "at,device,id,label,marked,more,platform,shown") : typeof v === "boolean")) && !JSON.stringify(st).includes(TOKEN));
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
  // 登出時還在路上／沒送完的回報:收尾整批丟掉,換成下一個帳號後不帶新 token 送(release = 在路上那批回來的結果)
  const signOutLeak = async (release, waitMs) => {
    let creds = { token: "tok-acct-A", appSecret: "sec-A" }, open;
    const gate = new Promise((res) => { open = res; });
    const m = rig({ getCreds: () => creds, sessions: { "desktop-l0000001": { last: 1, rows: [row(1, "user", "x")] } } });
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.feed([msg("desktop-l0000001", "msg0000000l")]); await wait(30);
    m.resp[RL.EP.report] = () => gate;
    for (let i = 0; i < 120; i++) m.r.onTurn("desktop-l0000001", "turn-event", { type: "text", text: "t" + i });
    await wait(RL.BATCH_MS + 50);
    await m.r.signOut();
    creds = { token: "tok-acct-B", appSecret: "sec-B" }; delete m.resp[RL.EP.report];
    open(release); await wait(waitMs);
    const leaked = m.calls.filter((c) => c[1].token === "tok-acct-B").map((c) => c[0]);
    await m.end();
    return leaked;
  };
  { const [ok200, off] = await Promise.all([signOutLeak({ status: 200, body: { results: [], interrupt: [], cancel: [] } }, 100), signOutLeak({ status: 0, body: null }, 2400)]);
    ok("7 登出:flush 逾時後在路上那批送成,剩下的不換成下一個帳號的 token 接著送", ok200.length === 0, ok200);
    ok("7 登出:在路上那批斷線回來,不放回、不排重送(不帶下一個帳號的 token)", off.length === 0, off); }
  { const m = rig(); await m.r.tick(); await m.r.setOn(true); await wait(20);
    let open; m.resp[RL.EP.disable] = () => new Promise((res) => { open = res; });
    const out = m.r.signOut(); await wait(10);
    const n = m.of(RL.EP.poll).length; await m.r.tick(); await wait(30);
    ok("7 登出等 disable 的那幾秒:tick 不重開輪詢", m.of(RL.EP.poll).length === n, [n, m.of(RL.EP.poll).length]);
    open({ status: 200, body: {} }); await out; await wait(20);
    ok("7 登出收尾:不再輪詢", m.of(RL.EP.poll).length === n);
    await m.end(); }
  // 登出那幾秒、與登出前就送出的 /relay/enabled:上一個帳號的配對確認框不撿回來
  const promptA = { enabled: true, on: true, prompt: { device_id: "phoneAAAA1111", label: "A's iPhone", platform: "ios", paired_at: Math.floor(Date.now() / 1000) } };
  { const m = rig(); await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.resp[RL.EP.enabled] = { status: 200, body: promptA };
    let open; m.resp[RL.EP.disable] = () => new Promise((res) => { open = res; });
    const out = m.r.signOut(); await wait(10);
    await m.r.focusTick(); await wait(10);
    open({ status: 200, body: {} }); await out;
    ok("7 登出等 disable 時視窗取得焦點:上一個帳號的配對確認框不撿回來", m.r.state().ask === null, m.r.state().ask);
    await m.end(); }
  { const m = rig(); await m.r.tick(); await m.r.setOn(true); await wait(20);
    let open; m.resp[RL.EP.enabled] = () => new Promise((res) => { open = res; });
    const t = m.r.tick(); await wait(10);
    await m.r.signOut();
    open({ status: 200, body: promptA }); await t;
    ok("7 登出前送出的 /relay/enabled 登出後才回來(還是同一顆 token):配對確認框不撿回來", m.r.state().ask === null, m.r.state().ask);
    await m.end(); }
  // 單一對話超過一批(> 100 則):兩批中間那 1 秒登出並換帳號,下一批不帶下一個帳號的 token 送
  { let creds = { token: "tok-acct-A", appSecret: "sec-A" };
    const rows = Array.from({ length: 250 }, (_, i) => row(i + 1, i % 2 ? "assistant" : "user", "x" + i));
    const m = rig({ getCreds: () => creds, sessions: { "desktop-s0000001": { last: Date.now() / 1000, rows } } });
    await m.r.tick(); await m.r.setOn(true); await wait(30);
    await m.r.signOut(); creds = { token: "tok-acct-B", appSecret: "sec-B" };
    await wait(1500);
    const leaked = m.calls.filter((c) => c[1].token === "tok-acct-B").map((c) => c[0]);
    ok("7 登出:同步到一半(同一條分好幾批)不換成下一個帳號的 token 接著傳", m.of(RL.EP.sync).length >= 1 && leaked.length === 0, [m.of(RL.EP.sync).length, leaked]);
    await m.end(); }

  // ── 8 圖、手機清單 ──
  { const m = rig({ sessions: { "desktop-i0000001": { last: 1, rows: [row(1, "user", "x")] } },
      resp: { [RL.EP.phones]: { status: 200, body: { max: 5, phones: [{ device_id: "devA0000001", platform: "ios", label: "iPhone 15", paired_via: "app", created_at: "2026-10-01T00:00:00Z", last_used_at: "2026-10-30T00:00:00Z", granted: true, extra: "x" }, { device_id: "../bad" }] } } } });
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
    ok("8 帳號下的手機(唯讀):只回 device_id／platform／label／last_used_at、壞 device_id 丟掉", ph.ok && ph.phones.length === 1 && JSON.stringify(Object.keys(ph.phones[0]).sort()) === '["device_id","label","last_used_at","platform"]' && ph.phones[0].label === "iPhone 15" && ph.phones[0].last_used_at === "2026-10-30T00:00:00Z", ph);
    ok("8 配對、勾選、撤銷、最近操作都不在電腦版:沒有那幾支端點與函式", !["pairCode", "grant", "revoke", "actions"].some((k) => k in RL.EP || typeof m.r[k] === "function"));
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

  // ── 10 ──
  { const m = rig(); await m.r.tick();
    const r = await m.r.setOn(true); await wait(20);
    const b = m.of(RL.EP.enable)[0];
    ok("10 打開:enable 不帶驗證碼欄位(send_code／enable_code／lang),200 就寫 on、開輪詢、記 phone_chat_on", r.ok === true && m.r.isOn() === true && !("send_code" in b) && !("enable_code" in b) && !("lang" in b)
      && JSON.parse(fs.readFileSync(path.join(m.dir, "relay.json"), "utf8")).on === true && m.of(RL.EP.poll).length >= 1 && m.tracked.includes("phone_chat_on"));
    await m.end(); }
  { const m = rig({ resp: { [RL.EP.enable]: { status: 403, body: { error_code: "RELAY_ENABLE_VERIFY", sent: true } } } }); await m.r.tick();
    const r = await m.r.setOn(true);
    ok("10 舊 api 還在要驗證碼(403):就是沒開成,不進驗證碼、不帶關卡明細", r.ok === false && r.code === "FAILED" && !("gate" in r) && m.r.isOn() === false);
    await m.end(); }
  { let T = Date.now(); const m = rig({ now: () => T }); await m.r.tick(); await m.r.setOn(true); await wait(20); m.setServerOn(false);
    m.resp[RL.EP.enable] = { status: 403, body: { error_code: "RELAY_ENABLE_VERIFY" } };
    const en0 = m.of(RL.EP.enable).length; await m.r.tick(); T += 60000; await m.r.tick();
    ok("10 自動重打被擋:本機開關不動,30 秒後照樣再打(沒有 needVerify 停打)", m.r.isOn() === true && m.of(RL.EP.enable).length === en0 + 2 && !("needVerify" in m.r.state()));
    await m.end(); }
  { const m = rig({ resp: { [RL.EP.enabled]: { status: 404, body: null } } }); await m.r.tick();
    const r = await m.r.setOn(true);
    ok("10 api 還沒上這條路由(/relay/enabled 404):設定區不出現、打不開、不輪詢", m.r.state().visible === false && r.ok === false && r.code === "OFF" && m.of(RL.EP.enable).length === 0 && m.of(RL.EP.poll).length === 0);
    await m.end(); }
  // 配對確認框:prompt 走 /relay/enabled(開關關著也打);本機記「問過」= device_id:配對時間
  const DEV = "devA0000001", NOW = Date.now(), PROMPT = (o) => ({ device_id: DEV, label: "iPhone 15", platform: "ios", paired_at: Math.floor(NOW / 1000) - 3600, ...(o || {}) });
  const askRig = (prompt, o) => { let p = prompt, on = false; const m = rig(Object.assign({ resp: { [RL.EP.enabled]: () => ({ status: 200, body: { enabled: true, on, prompt: p } }), [RL.EP.enable]: () => { on = true; return { status: 200, body: { enabled: true } }; } } }, o || {}));
    m.setPrompt = (x) => { p = x; }; return m; };
  { const m = askRig(PROMPT()); await m.r.tick();
    const a = m.r.state().ask;
    ok("10 prompt:開關關著、總開關開 → state.ask 帶機型、平台、配對時間(秒→ms),配對距今超過 LATE_MS = late(標題帶時間)", !!a && a.label === "iPhone 15" && a.platform === "ios" && a.at === (Math.floor(NOW / 1000) - 3600) * 1000 && a.late === true && a.id === DEV + ":" + a.at && m.changes.at(-1).ask && m.changes.at(-1).ask.id === a.id, a);
    ok("10 prompt:給畫面的 ask 沒有 device_id 以外的憑證", !JSON.stringify(m.r.state()).includes(TOKEN));
    ok("10 askShown:本機記成問過(落檔),state.ask 清掉;同一個 prompt 下一輪不再出", m.r.askShown(a.id) === true && m.r.state().ask === null && JSON.parse(fs.readFileSync(path.join(m.dir, "relay.json"), "utf8")).asked.includes(a.id));
    await m.r.tick();
    ok("10 問過的那一次:api 再給也不出", m.r.state().ask === null);
    await wait(10);
    const s0 = m.of(RL.EP.promptSeen);
    ok("10 框一出現就打 prompt/seen(device_id、不帶 answer;by = shown)", s0.length === 1 && s0[0].device_id === DEV && !("answer" in s0[0]) && s0[0].token === TOKEN, s0);
    const seen = await m.r.askNo(a.id);
    const s1 = m.of(RL.EP.promptSeen);
    ok("10 〔不用〕:再打一次帶 answer no(多台各記各的,api 用 device 分)", seen === true && s1.length === 2 && s1[1].device_id === DEV && s1[1].answer === "no");
    ok("10 〔不用〕同一次只送一次;沒跳過的 id 不送", (await m.r.askNo(a.id)) === false && (await m.r.askNo("x")) === false && m.of(RL.EP.promptSeen).length === 2);
    m.setPrompt(PROMPT({ paired_at: Math.floor(NOW / 1000) + 60 })); await m.r.tick();
    const b = m.r.state().ask;
    ok("10 同一支撤銷後重配(配對時間不同):再問一次;配對時間距今很近 = 不帶時間", !!b && b.id !== a.id && b.late === false, b);
    await m.end(); }
  { const m = askRig(PROMPT()); await m.r.tick(); const a = m.r.state().ask;
    const r = await m.r.setOn(true); await wait(20);
    ok("10 〔打開〕(setOn):開了就記成問過、ask 清掉;不另打 seen(enable 會記)", r.ok && m.r.state().ask === null && JSON.parse(fs.readFileSync(path.join(m.dir, "relay.json"), "utf8")).asked.includes(a.id) && m.of(RL.EP.promptSeen).length === 0);
    await m.end(); }
  { const m = askRig(null); await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.setPrompt(PROMPT()); await m.r.tick();
    ok("10 開關開著:prompt 不出,直接記成問過", m.r.state().ask === null && JSON.parse(fs.readFileSync(path.join(m.dir, "relay.json"), "utf8")).asked.length === 1);
    await m.end(); }
  { const m = askRig(PROMPT({ device_id: "../bad" })); await m.r.tick();
    ok("10 prompt 的 device_id 不合格:不出", m.r.state().ask === null);
    m.setPrompt(PROMPT()); await m.r.tick();
    const had = !!m.r.state().ask; await m.r.signOut();
    ok("10 登出(換帳號):還沒跳的那一次丟掉", had && m.r.state().ask === null);
    await m.end(); }
  { let flagOn = true; const m = rig({ resp: { [RL.EP.enabled]: () => ({ status: 200, body: { enabled: flagOn, on: false, prompt: PROMPT() } }) } }); await m.r.tick();
    const had = !!m.r.state().ask; flagOn = false; await m.r.tick();
    ok("10 總開關關:畫面不出 ask", had && m.r.state().ask === null);
    await m.end(); }
  { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ask-")); fs.writeFileSync(path.join(dir, "relay.json"), JSON.stringify({ on: false, asked: [DEV + ":" + (Math.floor(NOW / 1000) - 3600) * 1000] }));
    const R3 = RL.createRelay({ dir, stateDir: path.join(dir, "state"), apiBase: API, post: async (u) => (u.endsWith(RL.EP.enabled) ? { status: 200, body: { enabled: true, on: false, prompt: PROMPT() } } : { status: 200, body: {} }),
      getCreds: () => ({ token: TOKEN, appSecret: SECRET }), installId: () => "11111111-2222-4333-8444-555555555555", ver: "x", startTurn: async () => ({}), stopTurn: () => true, turnBusy: () => false, isRestarting: () => false,
      sessions: { list: () => [], rowsAfter: () => [], maxId: () => 0, exists: () => false, remove: () => false }, turnArgs: () => ({}), known: () => [], origins: { add() {}, get: () => new Map() } });
    await R3.tick();
    ok("10 重開 app:落檔的「問過」照算,不再跳", R3.state().ask === null); await R3.quit(); }
  { let T = NOW; const pr = PROMPT({ paired_at: Math.floor(NOW / 1000) }); const m = askRig(pr, { now: () => T }); await m.r.tick();
    const fresh = m.r.state().ask.late;
    T += RL.LATE_MS + 1000; m.setPrompt(PROMPT({ paired_at: Math.floor(NOW / 1000) + 1 })); await m.r.tick();
    ok("10 late 看配對時間距今,不看啟動時間:app 開著但睡著、隔很久才跳的也帶時間", fresh === false && m.r.state().ask.late === true);
    await m.end(); }
  { const m = askRig(PROMPT()); await m.r.tick(); const a = m.r.state().ask;
    m.resp[RL.EP.promptSeen] = { status: 0, body: null };
    m.r.askShown(a.id); await wait(10); await m.r.askNo(a.id);
    const out = JSON.parse(fs.readFileSync(path.join(m.dir, "relay.json"), "utf8")).seenOut;
    ok("10 seen 送不到(離線):落檔留著,兩筆照順序", out.length === 2 && out[0].device_id === DEV && !out[0].answer && out[1].answer === "no", out);
    m.resp[RL.EP.promptSeen] = { status: 503, body: {} }; await m.r.tick(); await wait(10);
    ok("10 下一輪 tick 補送;5xx 照樣留著", JSON.parse(fs.readFileSync(path.join(m.dir, "relay.json"), "utf8")).seenOut.length === 2);
    delete m.resp[RL.EP.promptSeen]; const n0 = m.of(RL.EP.promptSeen).length; await m.r.tick(); await wait(10);
    const sent = m.of(RL.EP.promptSeen).slice(n0);
    ok("10 送到了才拿掉,照順序(shown 再 no)", JSON.parse(fs.readFileSync(path.join(m.dir, "relay.json"), "utf8")).seenOut.length === 0 && sent.length === 2 && !sent[0].answer && sent[1].answer === "no", sent);
    m.resp[RL.EP.promptSeen] = { status: 404, body: { error_code: "DEVICE_NOT_FOUND" } }; m.setPrompt(PROMPT({ paired_at: Math.floor(NOW / 1000) - 60 })); await m.r.tick();
    m.r.askShown(m.r.state().ask.id); await wait(10);
    ok("10 404 DEVICE_NOT_FOUND(手機已撤銷):不重送", JSON.parse(fs.readFileSync(path.join(m.dir, "relay.json"), "utf8")).seenOut.length === 0);
    m.resp[RL.EP.promptSeen] = { status: 0, body: null }; m.setPrompt(PROMPT({ paired_at: Math.floor(NOW / 1000) - 30 })); await m.r.tick();
    m.r.askShown(m.r.state().ask.id); await wait(10); await m.r.signOut();
    ok("10 登出(換帳號):沒送到的 seen 丟掉", JSON.parse(fs.readFileSync(path.join(m.dir, "relay.json"), "utf8")).seenOut.length === 0);
    await m.end(); }
  { let n = 0; const m = rig({ resp: { [RL.EP.enabled]: () => (n++ === 0 ? { status: 200, body: { enabled: true, on: false, prompt: PROMPT() } } : { status: 429, body: { error_code: "ERR429", message: "Too many requests" } }) } });
    await m.r.tick(); const a = m.r.state().ask; await m.r.tick();
    ok("10 /relay/enabled 429:總開關、確認框照上一次,設定區不收起", m.r.state().visible === true && !!m.r.state().ask && m.r.state().ask.id === a.id);
    await m.end(); }
  { let T = 1e12; const m = askRig(null, { now: () => T }); await m.r.tick(); const c0 = m.of(RL.EP.enabled).length;
    const f1 = await m.r.focusTick(); T += 5000; const f2 = await m.r.focusTick(); T += RL.FOCUS_TICK_GAP_MS; const f3 = await m.r.focusTick();
    ok("10 視窗取得焦點:開關關著時加打 /relay/enabled,20 秒內只一次", f1 === true && f2 === false && f3 === true && m.of(RL.EP.enabled).length === c0 + 2 && RL.FOCUS_TICK_GAP_MS === 20000);
    await m.r.setOn(true); await wait(20); T += 60000; const c1 = m.of(RL.EP.enabled).length;
    ok("10 開關開著:焦點不加打", (await m.r.focusTick()) === false && m.of(RL.EP.enabled).length === c1);
    await m.end(); }
  { let creds = { token: TOKEN, appSecret: SECRET }, release; const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tok-"));
    const R4 = RL.createRelay({ dir, stateDir: path.join(dir, "state"), apiBase: API, getCreds: () => creds, installId: () => "11111111-2222-4333-8444-555555555555", ver: "x",
      post: async (u) => (u.endsWith(RL.EP.enabled) ? new Promise((res) => { release = () => res({ status: 200, body: { enabled: true, on: false, prompt: PROMPT() } }); }) : { status: 200, body: {} }),
      startTurn: async () => ({}), stopTurn: () => true, turnBusy: () => false, isRestarting: () => false,
      sessions: { list: () => [], rowsAfter: () => [], maxId: () => 0, exists: () => false, remove: () => false }, turnArgs: () => ({}), known: () => [], origins: { add() {}, get: () => new Map() } });
    const p = R4.tick(); await wait(5); creds = { token: "tok-other-B", appSecret: "sec-B" }; release(); await p;
    ok("10 /relay/enabled 在路上時換了帳號:回來的 prompt 是上一個帳號的,不收", R4.state().ask === null); await R4.quit(); }
  ok("10 契約:prompt/seen 路徑、PAIR_SRC 讀 prompt 與 phones", RL.EP.promptSeen === "/oauth/desktop/relay/prompt/seen" && RL.PAIR_SRC.askOf({ prompt: null }) === null && RL.PAIR_SRC.askOf({ prompt: { device_id: "d", paired_at: 2 } }).paired_at === 2000);
  { const pre = fs.readFileSync(path.join(SHELL, "preload.js"), "utf8");
    ok("10 接線:畫面收得到 ask、沒有 needVerify;relay-set 只收布林;跳出來／〔不用〕兩支 IPC;preload 沒有配對碼、勾選、撤銷、最近操作", /ask: st\.ask, notice: st\.notice \}\);/.test(main) && !/needVerify|pairSeq/.test(main)
      && /handle\("relay-set", async \(_e, on\) => \(typeof on === "boolean" \? \{ \.\.\.\(await relay\(\)\.setOn\(on\)\)/.test(main) && /handle\("relay-ask-shown"/.test(main) && /handle\("relay-ask-no"/.test(main) && /win\.on\("focus", \(\) => \{ if \(app\.hasSingleInstanceLock\(\)\) relay\(\)\.focusTick\(\)\.catch\(\(\) => \{\}\); \}\);/.test(main)
      && /relaySet: \(on\) => ipcRenderer\.invoke\("relay-set", on === true\),/.test(pre) && !/relayPairCode|relayGrant|relayRevoke|relayActions|relay-pair-code|relay-grant|relay-revoke|relay-actions/.test(pre + main)); }

  // ── 10b 開關開著、帳號下剛配對了手機:/relay/enabled 的 paired_notice(account-session-revoke §3.3)→ 一行提示,不自動消失、可關 ──
  { const PN = (o) => ({ device_id: "devN0000001", label: "Pixel 9", platform: "android", paired_at: Math.floor(NOW / 1000) - 120, more: 0, ...(o || {}) });
    const nRig = (pn, o) => { let p = pn; const m = rig(Object.assign({ resp: { [RL.EP.enabled]: () => ({ status: 200, body: { enabled: true, on: true, prompt: null, paired_notice: p } }) } }, o || {})); m.setNotice = (x) => { p = x; }; return m; };
    const disk = (m) => JSON.parse(fs.readFileSync(path.join(m.dir, "relay.json"), "utf8"));
    await guard("10b", async () => { const m = nRig(PN()); await m.r.tick();
      ok("10b 開關關著:paired_notice 不收(關著的走 prompt)", m.r.state().notice === null && !fs.existsSync(path.join(m.dir, "relay.json")));
      await m.r.setOn(true); await wait(20); await m.r.tick();
      const n = m.r.state().notice;
      ok("10b 開著:state.notice 帶機型、平台、配對時間(秒→ms)、more;推給畫面", !!n && n.label === "Pixel 9" && n.platform === "android" && n.at === (Math.floor(NOW / 1000) - 120) * 1000 && n.more === 0 && n.id === "devN0000001:" + n.at && !!m.changes.at(-1).notice, n);
      ok("10b 給畫面的 notice 沒有憑證、沒有 device_id 以外的東西", !JSON.stringify(m.r.state()).includes(TOKEN) && Object.keys(n).sort().join() === "at,id,label,more,platform");
      ok("10b 還沒出現過:不打 prompt/seen", m.of(RL.EP.promptSeen).length === 0);
      const first = m.r.noticeShown(n.id), again = m.r.noticeShown(n.id); await wait(10);
      const s0 = m.of(RL.EP.promptSeen);
      ok("10b 一出現就打 prompt/seen(device_id、不帶 answer);只有第一次回 true", first === true && again === false && m.r.noticeShown("x") === false && s0.length === 1 && s0[0].device_id === "devN0000001" && !("answer" in s0[0]) && s0[0].token === TOKEN, s0);
      m.setNotice(null); await m.r.tick();
      ok("10b 不自動消失:api 收到 seen 後不再給,那一行照樣留著", !!m.r.state().notice && m.r.state().notice.id === n.id && disk(m).notice.shown === true);
      const dir = m.dir;
      const R5 = RL.createRelay({ dir, stateDir: path.join(dir, "state"), apiBase: API, post: async (u) => (u.endsWith(RL.EP.enabled) ? { status: 200, body: { enabled: true, on: true, prompt: null, paired_notice: null } } : { status: 200, body: {} }),
        getCreds: () => ({ token: TOKEN, appSecret: SECRET }), installId: () => "11111111-2222-4333-8444-555555555555", ver: "x", startTurn: async () => ({}), stopTurn: () => true, turnBusy: () => false, isRestarting: () => false,
        sessions: { list: () => [], rowsAfter: () => [], maxId: () => 0, exists: () => false, remove: () => false }, turnArgs: () => ({}), known: () => [], origins: { add() {}, get: () => new Map() } });
      await R5.tick();
      ok("10b 重開 app:還沒關的那一行照出(落檔)", !!R5.state().notice && R5.state().notice.id === n.id && R5.noticeShown(n.id) === false); await R5.quit();
      const c0 = m.of(RL.EP.promptSeen).length, closed = m.r.noticeClose(n.id);
      ok("10b 關掉:那一行收掉、落檔清掉、不另打 api;關別的 id 不動", closed === true && m.r.state().notice === null && disk(m).notice === null && m.of(RL.EP.promptSeen).length === c0 && m.r.noticeClose(n.id) === false);
      await m.end(); });
    await guard("10b", async () => { const m = nRig(PN({ more: 2 })); await m.r.tick(); await m.r.setOn(true); await wait(20); await m.r.tick();
      const a = m.r.state().notice; m.r.noticeShown(a.id); await wait(10);
      m.setNotice(PN({ device_id: "devN0000002", label: "iPhone 16", platform: "ios", paired_at: Math.floor(NOW / 1000) - 10, more: 0 })); await m.r.tick();
      const b = m.r.state().notice;
      ok("10b 那一行還開著又配了一支:換成最新那支,more 加回前一行那幾支(1 + 2)", !!b && b.label === "iPhone 16" && b.platform === "ios" && b.more === 3 && b.id !== a.id, b);
      await m.end(); });
    await guard("10b", async () => { const m = nRig(PN({ more: 1 })); await m.r.tick(); await m.r.setOn(true); await wait(20); await m.r.tick();
      const a = m.r.state().notice; m.resp[RL.EP.promptSeen] = { status: 0, body: null }; m.r.noticeShown(a.id); await wait(10);
      const rEnabled = m.resp[RL.EP.enabled];
      m.resp[RL.EP.enabled] = () => ({ status: 200, body: { enabled: true, on: true, prompt: null, paired_notice: PN({ device_id: "devN0000002", label: "iPhone 16", platform: "ios", more: 2 }) } });
      await m.r.tick();
      ok("10b seen 還沒送到時又來一支:api 的 more 已經算進前一行那幾支,不重複加", m.r.state().notice.more === 2 && m.r.state().notice.label === "iPhone 16", m.r.state().notice);
      m.resp[RL.EP.enabled] = rEnabled; await m.end(); });
    await guard("10b", async () => { const m = nRig(PN({ more: 1 })); await m.r.tick(); await m.r.setOn(true); await wait(20); await m.r.tick();
      const a = m.r.state().notice; m.resp[RL.EP.promptSeen] = { status: 404, body: { error_code: "DEVICE_NOT_FOUND" } }; m.r.noticeShown(a.id); await wait(10);
      m.setNotice(PN({ device_id: "devN0000002", label: "iPhone 16", platform: "ios", more: 1 })); await m.r.tick();
      ok("10b seen 回 404(api 記號沒推):又來一支時 api 的 more 已經算進前一行,不重複加", m.r.state().notice.more === 1 && m.r.state().notice.label === "iPhone 16", m.r.state().notice);
      await m.end(); });
    await guard("10b", async () => { const m = nRig(PN({ more: 1 })); await m.r.tick(); await m.r.setOn(true); await wait(20); await m.r.tick();
      const a = m.r.state().notice; let release; m.resp[RL.EP.promptSeen] = () => new Promise((res) => { release = () => res({ status: 200, body: { ok: true } }); });
      m.r.noticeShown(a.id); await wait(5);
      // api 先處理了 seen(記號推到 A)才回 /relay/enabled:more 只算 A 之後的
      m.setNotice(PN({ device_id: "devN0000002", label: "iPhone 16", platform: "ios", more: 0 }));
      const p = m.r.tick(); await wait(5); release(); await p;
      ok("10b seen 還在路上就到了下一輪:先等 seen 落地(200)再問 /relay/enabled,more 加回前一行(1 + 1)", m.r.state().notice.more === 2 && m.r.state().notice.label === "iPhone 16", m.r.state().notice);
      await m.end(); });
    await guard("10b", async () => { const m = nRig(PN()); await m.r.tick(); await m.r.setOn(true); await wait(20); await m.r.tick();
      const had = !!m.r.state().notice; m.setNotice(null); await m.r.tick();
      ok("10b 還沒出現過、api 不再給(手機撤了、超過期限):收掉", had && m.r.state().notice === null);
      const nChanges = m.changes.length; await m.r.tick();
      ok("10b prompt 與 paired_notice 都是 null:狀態不變、不推畫面", m.r.state().notice === null && m.changes.length === nChanges);
      m.setNotice(PN({ device_id: "../bad" })); await m.r.tick();
      ok("10b device_id 不合格:不出", m.r.state().notice === null);
      m.setNotice(PN({ more: "lots" })); await m.r.tick();
      ok("10b more 不是整數:當 0", m.r.state().notice && m.r.state().notice.more === 0);
      m.setNotice(PN({ more: 1e9 })); await m.r.tick();
      ok("10b more 上限 99", m.r.state().notice.more === 99);
      await m.r.setOn(false);
      ok("10b 關開關:那一行收掉(手機已經叫不動這台)", m.r.state().notice === null && disk(m).notice === null);
      await m.end(); });
    await guard("10b", async () => { const m = nRig(PN()); await m.r.tick(); await m.r.setOn(true); await wait(20); await m.r.tick();
      const had = !!m.r.state().notice; m.r.noticeShown(m.r.state().notice.id); await m.r.signOut();
      ok("10b 登出(換帳號):那一行丟掉", had && m.r.state().notice === null && disk(m).notice === null);
      await m.end(); });
    await guard("10b", async () => { const m = nRig(PN()); await m.r.tick(); await m.r.setOn(true); await wait(20); await m.r.tick();
      const had = !!m.r.state().notice; m.resp[RL.EP.enabled] = { status: 401, body: { error_code: "INVALID_CREDENTIALS" } }; await m.r.tick();
      ok("10b token 失效(401):設定區收起,那一行也不出", had && m.r.state().visible === false && m.r.state().notice === null);
      await m.end(); });
    ok("10b 契約:PAIR_SRC.noticeOf 讀 paired_notice(秒→ms、more)", typeof RL.PAIR_SRC.noticeOf === "function" && RL.PAIR_SRC.noticeOf({ paired_notice: null }) === null && RL.PAIR_SRC.noticeOf({ paired_notice: { device_id: "d", paired_at: 2, more: 3 } }).paired_at === 2000 && RL.PAIR_SRC.noticeOf({ paired_notice: { device_id: "d", more: 3 } }).more === 3);
    const pre = fs.readFileSync(path.join(SHELL, "preload.js"), "utf8");
    ok("10b 接線:畫面收得到 notice;出現／關掉兩支 IPC 只收字串", /notice: st\.notice \}\);/.test(main) && /handle\("relay-notice-shown", \(_e, id\) => relay\(\)\.noticeShown\(typeof id === "string" \? id : ""\), false\);/.test(main)
      && /handle\("relay-notice-close", \(_e, id\) => relay\(\)\.noticeClose\(typeof id === "string" \? id : ""\), false\);/.test(main) && /relayNoticeShown: \(id\) => ipcRenderer\.invoke\("relay-notice-shown", String\(id \|\| ""\)\),/.test(pre) && /relayNoticeClose: \(id\) => ipcRenderer\.invoke\("relay-notice-close", String\(id \|\| ""\)\),/.test(pre)); }

  // ── 11 ──
  const SF = "desktop-f1000001";
  const turn = async (kind, events, end, n) => {
    const m = rig({ kind, sessions: { [SF]: { last: Date.now() / 1000, rows: [row(1, "user", "x")] } } }); await m.r.tick(); await m.r.setOn(true); await wait(20);
    m.feed([msg(SF, "msg000fault" + (n || 1))]); await wait(40);
    for (const e of events) m.r.onTurn(SF, "turn-event", e);
    if (end) m.r.onTurn(SF, "turn-end", end);
    await wait(RL.BATCH_MS + 60);
    const out = m.chunks().filter((c) => !["started", "ping"].includes(c.type));
    await m.end(); return out;
  };
  const types = (cs) => cs.map((c) => c.type).join();
  const texts = (cs) => cs.filter((c) => c.type === "text").map((c) => c.text).join("");
  const code = (cs) => (cs.find((c) => c.type === "error") || {}).code;
  const ERR = { type: "error", message: "turn failed", code: "not_started" }, END = { code: 1, errTail: "" };
  const T = (text) => ({ type: "text", text });
  const cases = [
    ["blave", "API Error: 402 insufficient credit", "no_credit"], ["blave", "Failed to authenticate. API Error: 401 bad", "auth_invalid"], ["blave", "API Error: 403 forbidden", "auth_invalid"],
    ["claude", "API Error: 401 invalid", "engine_signed_out"], ["codex", "API Error: 403 denied", "engine_signed_out"], ["claude", "Not logged in · Please run /login", "engine_signed_out"],
    ["claude", "Login expired · Please run /login", "engine_signed_out"], ["claude", "OAuth token revoked · Please run /login", "engine_signed_out"], ["claude", "Invalid API key · Please run /login", "engine_signed_out"], ["claude", "Please run /login · API Error: 401 bad", "engine_signed_out"],
    ["claude", "You've hit your session limit · resets 1:50pm (Asia/Taipei)", "usage_limit"], ["claude", "You’ve hit your weekly limit · resets Oct 3, 9am", "usage_limit"],
  ];
  for (const [kind, text, want] of cases) {
    const cs = await turn(kind, [T(text), ERR], END);
    ok("11 " + kind + " 「" + text.slice(0, 30) + "」→ " + want + ":字不送、代碼換掉 error 的、沒有 done", code(cs) === want && !texts(cs) && types(cs) === "error" && cs[0].message === "turn failed", cs);
  }
  { const cs = await turn("blave", [T("API "), T("Err"), T("or: 40"), T("2 no credit"), ERR], END);
    ok("11 錯誤字分幾段來:一樣扣住、一樣判到", code(cs) === "no_credit" && !texts(cs), cs); }
  { const cs = await turn("blave", [T("API Error: 402 no credit"), { type: "done", awaiting: false }], { code: 0, errTail: "" });
    ok("11 後面沒有 error(只有 done):補一則帶代碼的 error,不送 done,message 是遮過的字", types(cs) === "error" && code(cs) === "no_credit" && cs[0].message === "API Error: 402 no credit", cs); }
  { const cs = await turn("blave", [T("API Error: 402 no credit")], END);
    ok("11 後面什麼都沒有(行程掛掉):turn-end 補的 error 帶代碼", types(cs) === "error" && code(cs) === "no_credit", cs); }
  { const cs = await turn("blave", [T("先查一下"), { type: "tool", tool: "Bash", status: "running" }, T("API Error: 402 x"), ERR], END);
    ok("11 工具開跑過才出錯:前面的字照送,錯誤字不送,代碼 partial 優先於原因碼", texts(cs) === "先查一下" && code(cs) === "partial", cs); }
  { const cs = await turn("blave", [T("先想一下"), { type: "thinking", text: "..." }, T("。"), { type: "done" }], { code: 0, errTail: "" });
    ok("11 沒動工具的一般回覆不受影響", code(cs) === undefined && types(cs).endsWith("done"), cs); }
  for (const [kind, text] of [["blave", "API Error: 402 x"], ["blave", "API Error: 401 x"], ["claude", "Login expired · Please run /login"], ["claude", "You've hit your session limit · resets 1:50pm (Asia/Taipei)"]]) {
    const before = await turn(kind, [T(text), { type: "error", message: "m", code: "not_started" }], END);
    const after = await turn(kind, [{ type: "tool", tool: "Bash", status: "running" }, { type: "tool", tool: "Bash", status: "done" }, T(text), { type: "error", message: "m", code: "partial" }], END);
    ok("11 " + kind + " 「" + text.slice(0, 20) + "」:還沒動工具送原因碼;工具開跑過維持 partial;字都不送", !["partial", undefined, "not_started"].includes(code(before)) && code(after) === "partial" && !texts(after) && !texts(before), [before, after]);
  }
  { const cs = await turn("blave", [{ type: "tool", tool: "Bash", status: "running" }, T("API Error: 402 x"), { type: "done" }], { code: 0, errTail: "" });
    ok("11 工具開跑過、只有 done:補的 error 是 partial,不送 done", types(cs).endsWith("error") && !/done/.test(types(cs)) && code(cs) === "partial", cs); }
  { const cs = await turn("blave", [{ type: "tool", tool: "Bash", status: "running" }, T("API Error: 402 x")], END);
    ok("11 工具開跑過、行程掛掉:turn-end 補的 error 是 partial", code(cs) === "partial", cs); }
  { const cs = await turn("claude", [{ type: "tool", tool: "Bash", status: "running" }], { code: 1, errTail: "AGENT_BIN_MISSING" });
    ok("11 工具開跑過、errTail 帶 AGENT_BIN:一樣 partial", code(cs) === "partial", cs); }
  { const cs = await turn("blave", [T("BTC 現在"), T(" API Error: 402"), { type: "done" }], { code: 0, errTail: "" });
    ok("11 一般回覆:第一段就放行(內文提到 API Error 不算),done 照送", texts(cs) === "BTC 現在 API Error: 402" && types(cs) === "text,text,done", cs); }
  { const cs = await turn("blave", [T("API Error: 500 upstream"), ERR], END);
    ok("11 5xx 不在表上:字照送,error 的代碼不動", texts(cs) === "API Error: 500 upstream" && code(cs) === "not_started", cs); }
  { const cs = await turn("claude", [T("You've hit your stop loss at 63000, so the position closed."), { type: "done" }], { code: 0, errTail: "" });
    ok("11 開頭像上限句的真回覆:放行", /stop loss/.test(texts(cs)) && types(cs).endsWith("done"), cs); }
  { const cs = await turn("blave", [T("API Error: 402 means payment required, here is why"), { type: "tool", tool: "Bash", status: "running" }, T("done"), { type: "done" }], { code: 0, errTail: "" });
    ok("11 開頭一樣但後面接工具:不是錯誤,字放行、順序不亂", types(cs).startsWith("text,tool") && /payment required/.test(texts(cs)), cs); }
  { const cs = await turn("blave", [T("API Error: 402 " + "x".repeat(5000)), T("y"), { type: "done" }], { code: 0, errTail: "" });
    ok("11 超過暫扣上限:放行、不判錯誤", /y$/.test(texts(cs)) && types(cs).endsWith("done"), cs.map((c) => c.type)); }
  for (const [kind, text] of [["apikey", "API Error: 402 billing"], ["apikey", "API Error: 401 bad key"], ["claude", "API Error: 402 x"], ["blave", "Not logged in · Please run /login"], ["blave", "You've hit your session limit · resets 1:50pm"]]) {
    const cs = await turn(kind, [T(text), ERR], END);
    ok("11 " + kind + " 「" + text.slice(0, 22) + "」:不帶 fault code,字照送", texts(cs) === text && code(cs) === "not_started", cs);
  }
  { const cs = await turn("codex", [{ type: "error", message: "login", code: "needs_login" }], END);
    ok("11 Codex 401(runtime needs_login):engine_signed_out", code(cs) === "engine_signed_out", cs); }
  for (const c of ["MISSING", "DOWNLOADING"]) {
    const cs = await turn("codex", [], { code: 1, errTail: "Error: AGENT_BIN_" + c });
    ok("11 AGENT_BIN_" + c + ":turn-end 補的 error 帶 engine_missing", types(cs) === "error" && code(cs) === "engine_missing", cs);
  }
  { const cs = await turn("blave", [T("API Error: 402 x")], { code: 0, errTail: "", canceled: true });
    ok("11 用戶按停止:不帶 code,照「已停止」收尾,錯誤字一樣不送", code(cs) === undefined && cs.at(-1).message === "stopped" && !texts(cs), cs); }
  { const cs = await turn("codex", [], { code: 1, errTail: "Error: AGENT_BIN_BROKEN" });
    ok("11 AGENT_BIN_BROKEN:不帶 code(spec 只列 MISSING、DOWNLOADING)", code(cs) === undefined, cs); }
  { const cs = await turn("blave", [T("API Error: 402 x"), { type: "thinking", text: "..." }, { type: "suggestions", items: ["a"] }, ERR], END);
    ok("11 錯誤字和 error 中間夾 thinking、suggestions:一樣判到(同 renderer 不動草稿)", code(cs) === "no_credit" && !texts(cs), cs); }
  { const cs = await turn("blave", [T("API Error: 402 " + "x".repeat(1000)), { type: "done" }], { code: 0, errTail: "" });
    ok("11 補的 error:message 截短", cs[0].message.length <= 200 && code(cs) === "no_credit", cs[0].message.length); }
  { const cs = await turn("codex", [T("API"), { type: "error", message: "login", code: "needs_login" }], END);
    ok("11 needs_login:手上不是錯誤的字不丟", texts(cs) === "API" && code(cs) === "engine_signed_out", cs); }
  { const cs = await turn("blave", [T("API Error: "), { type: "text_replace", text: "乾淨的回覆" }, { type: "done" }], { code: 0, errTail: "" });
    ok("11 暫扣中 text_replace:換成新的字放行", texts(cs) === "乾淨的回覆" && types(cs) === "text,done", cs); }
  { const cs = await turn("blave", [T("API Error: 402 key sec_Zz99Yy88Xx77"), { type: "done" }], { code: 0, errTail: "" });
    ok("11 補的 error:message 過遮蔽", !JSON.stringify(cs).includes(SECRET) && code(cs) === "no_credit", cs); }
  { const app = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
    const lim = /\{ engine: "claude", re: (\/.*\/i) \}/.exec(app), api = /const m = (\/\^\(\?:Failed to authenticate.*?\/)\.exec\(text \|\| ""\);\n  if \(!m\) return null;/.exec(app);
    ok("11 判定跟 renderer 同一份:上限句、API Error 的 regex 逐字相同", !!lim && !!api && lim[1] === String(RL.USAGE_LIMIT_RE) && api[1] === String(RL.API_ERROR_RE), [lim && lim[1], api && api[1]]);
    ok("11 登入句:renderer 還認得的兩段,主行程開頭錨定", /\/\^Not logged in\\b\|Please run \\\/login\/\.test\(text \|\| ""\)\) return localAuthFault\("claude"\)/.test(app)); }
  ok("11 接線:engineKind 取連線種類", /engineKind: \(\) => \(loadConnection\(\) \|\| \{\}\)\.kind/.test(main));

  // ── 12 換帳號:OAuth 重新登入換 token 之前照登出關掉手機對話(main.js startOAuth 那一段原文切出來跑) ──
  { const oa = main.slice(main.indexOf("async function startOAuth("), main.indexOf("\n}\n", main.indexOf("async function startOAuth(")));
    const seg = oa.slice(oa.indexOf("  await rotator().settle();\n  const phoneOff"), oa.indexOf("  if (!saveToken(r.body.access_token)) {"));
    const SA = "desktop-a1000001";
    let creds = { token: "tok-account-A", appSecret: "sec-A" }, onFor = null;
    const calls = [];
    const post = async (u, b) => { const ep = u.slice(API.length); calls.push([ep, b.token]);
      if (ep === RL.EP.enabled) return { status: 200, body: { enabled: true, on: onFor === b.token } };
      if (ep === RL.EP.enable) { onFor = b.token; return { status: 200, body: { enabled: true } }; }
      if (ep === RL.EP.disable) { if (onFor === b.token) onFor = null; return { status: 200, body: {} }; }
      if (ep === RL.EP.poll) return new Promise(() => {});
      if (ep === RL.EP.syncState) return { status: 200, body: { sessions: [], tombstones: [] } };
      if (ep === RL.EP.sync) return { status: 200, body: { sessions: {} } };
      return { status: 200, body: {} }; };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-acct-"));
    const R2 = RL.createRelay({ dir, stateDir: path.join(dir, "state"), apiBase: API, post, getCreds: () => creds, installId: () => "11111111-2222-4333-8444-555555555555", ver: "x",
      startTurn: async () => ({ started: true }), stopTurn: () => true, turnBusy: () => false, isRestarting: () => false,
      sessions: { list: () => [{ id: SA, last: Date.now() / 1000 }], rowsAfter: (s, a0) => [row(1, "user", "A 帳號的對話")].filter((x) => x.id > a0), maxId: () => 1, exists: () => true, remove: () => true },
      turnArgs: () => ({}), known: () => [], origins: { add() {}, get: () => new Map() } });
    await R2.tick(); await R2.setOn(true); await wait(1300);
    const wasOn = R2.isOn();
    // 原文那一段:relay() 換成這一個、loadToken 是 A 的;跑完才換成 B 的 token(= saveToken)
    const settles = [];
    const phoneOff = !/const phoneOff/.test(seg) ? null : await new Function("relay", "loadToken", "rotator", "return (async () => {\n" + seg + "\nreturn phoneOff;\n})();")(() => R2, () => { settles.push("read"); return creds.token; }, () => ({ settle: async () => { settles.push("settle"); } }));
    creds = { token: "tok-account-B", appSecret: "sec-B" };
    const n = calls.length;
    await R2.tick(); await wait(50);
    const st = R2.state(), after = calls.slice(n);
    ok("12 A 同意並開啟後,OAuth 換成 B:換之前用 A 的憑證關掉(disable 帶 A)、本機開關關", wasOn && calls.some((c) => c[0] === RL.EP.disable && c[1] === "tok-account-A") && st.on === false && st.pending === false, [st, calls.slice(-4)]);
    ok("12 B 登入後:不自動重打 enable、不用 B 的 token 同步任何對話;要開得重走同意框", !after.some((c) => c[0] === RL.EP.enable || c[0] === RL.EP.sync || c[0] === RL.EP.poll), after);
    ok("12 接線:startOAuth 在 saveToken 之前叫 relay().signOut()", /try \{ await relay\(\)\.signOut\(\); \}/.test(seg));
    ok("12 回給畫面 phoneOff(原本開著);登入完成回傳帶它", phoneOff === true && /return \{ ok: true, phoneOff \};/.test(oa));
    ok("12 signOut 之後再等一次輪替才讀舊 token,讀舊值到 saveToken 之間沒有 await", settles.join() === "settle,settle,read" && !/await/.test(oa.slice(oa.indexOf("const prevToken = loadToken();"), oa.indexOf("if (!saveToken(r.body.access_token))"))));
    ok("12 新 app_secret 存好之後才 tick 一次(設定 › 連結不用等 2 分鐘;新 token 配舊 secret 會 401)", /saveAppSecret\(r\.body\.app_secret\);[^\n]*\n(?:  \/\/[^\n]*\n)*  relay\(\)\.tick\(\)\.catch\(\(\) => \{\}\);/.test(oa) && oa.indexOf("relay().tick()") > oa.indexOf("saveAppSecret(r.body.app_secret)"));
    ok("12 phoneOff 也看平台旗標(區塊看得到才講;401 收起來的照講)", /const phoneOff = relay\(\)\.isOn\(\) && \(relay\(\)\.isVisible\(\) \|\| relay\(\)\.authLost\(\)\);/.test(oa));
    // 帳號被重設密碼／全部撤銷(account-session-revoke §1.8 第 3 步撤電腦版 token):之後每一支都 401,設定區收起;重新登入時仍要講「關了」
    let dead = false; const calls3 = [];
    const post3 = async (u, b) => { const ep = u.slice(API.length); calls3.push(ep);
      if (dead) return { status: 401, body: { error: "unauthorized", error_code: "INVALID_CREDENTIALS" } };
      if (ep === RL.EP.poll) return new Promise(() => {});
      if (ep === RL.EP.syncState) return { status: 200, body: { sessions: [], tombstones: [] } };
      return { status: 200, body: ep === RL.EP.enabled ? { enabled: true, on: true } : {} }; };
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dead-"));
    const R3 = RL.createRelay({ dir: dir3, stateDir: path.join(dir3, "state"), apiBase: API, post: post3, getCreds: () => ({ token: "tok-account-A", appSecret: "sec-A" }), installId: () => "11111111-2222-4333-8444-555555555555", ver: "x",
      startTurn: async () => ({ started: true }), stopTurn: () => true, turnBusy: () => false, isRestarting: () => false,
      sessions: { list: () => [], rowsAfter: () => [], maxId: () => 0, exists: () => true, remove: () => true }, turnArgs: () => ({}), known: () => [], origins: { add() {}, get: () => new Map() } });
    await R3.tick(); await R3.setOn(true); await wait(20);
    dead = true; await R3.tick();
    const hidden = R3.state().visible === false && R3.isOn() === true && typeof R3.authLost === "function" && R3.authLost() === true;
    const n3 = calls3.length; await R3.tick(); await wait(20);
    ok("12 token 被撤:/relay/enabled 401 → 設定區收起、不再輪詢、不卡(下一輪 tick 照樣跑完)", hidden && calls3.slice(n3).every((ep) => ep === RL.EP.enabled), calls3.slice(n3));
    let off3 = null; try { off3 = await new Function("relay", "loadToken", "rotator", "return (async () => {\n" + seg + "\nreturn phoneOff;\n})();")(() => R3, () => "tok-account-A", () => ({ settle: async () => {} })); } catch (_) { off3 = null; }
    ok("12 token 被撤後重新登入:phoneOff 照講(那一區是 401 收起來的,不是平台關了);本機開關關、不留待刪", off3 === true && R3.isOn() === false && R3.state().pending === false && typeof R3.authLost === "function" && R3.authLost() === false, [off3, R3.state()]);
    await R3.quit(); }
  { const app2 = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
    ok("12 畫面:四個登入入口都走 oauthStart,原本開著才出 ph.offRelogin;登出框開著時多 acct.out.6", (app2.match(/await oauthStart\(/g) || []).length === 4 && !/window\.blave\.startOAuth\(/.test(app2.replace(/async function oauthStart[\s\S]*?\n\}/, ""))
      && /const okText = \(\) => \{ const a = t\("fault\.authOk"\); return lr && lr\.phoneOff \? a \+ \(\/\[。！？\]\$\/\.test\(a\) \? "" : " "\) \+ t\("ph\.offRelogin"\) : a; \};\n      card\.set\(sysLz\(\(\) => \(resendState\(card, okText\)\)\)\);/.test(app2)
      && /if \(r && r\.phoneOff\) setHint\(\{ text: t\("ph\.offRelogin"\) \}\);/.test(app2) && /mvOn \? \[t\("acct\.out\.5"\)\] : \[\], phShown\(\) && PH\.signedIn && PH\.on \? \[t\("acct\.out\.6"\)\] : \[\]/.test(app2)); }

  // ── 9 ──
  const send = main.slice(main.indexOf("function sendTurn(sid, ch, payload) {"), main.indexOf("function turnNice("));
  ok("9 sendTurn 先交給 relay,再看有沒有視窗", send.indexOf("_relay.onTurn(sid, ch, payload)") > 0 && send.indexOf("_relay.onTurn") < send.indexOf("const w = turnWin();"));
  ok("9 手機那一輪帶 BLAVE_TURN_ORIGIN=app,其餘不帶", /\.\.\.\(rec\.origin === "mobile" \? \{ BLAVE_TURN_ORIGIN: "app" \} : \{\}\),/.test(main));
  ok("9 畫面刪對話成功才記待送;手機要刪的走 deleteSessionLocal(不再回送)", /const ok = deleteSessionLocal\(id\);\n  if \(ok && typeof _relay !== "undefined" && _relay\) \{ try \{ _relay\.sessionDeleted\(id\);/.test(main) && /remove: deleteSessionLocal/.test(main));
  ok("9 手機回合防睡:awakeWanted 認 phone、結束後再撐 2 分鐘", /if \(o\.phone\) return true;/.test(main) && /const RELAY_AWAKE_TAIL_MS = 2 \* 60 \* 1000;/.test(main));
  ok("9 開著時關視窗只收起來", /if \(quitting \|\| quitConfirmed \|\| restarting === "installing" \|\| \(!trading && !turn && !phone\)\) \{/.test(main) && /const phoneOn = \(\) => !!\(typeof _relay !== "undefined" && _relay && _relay\.isOn\(\) && _relay\.isVisible\(\)\);/.test(main));
  ok("9 結束 app 等 relay 回 not_run", /relayQuit \? _relay\.quit\(\)\.catch\(\(\) => false\) : null/.test(main));
  ok("9 只有拿到單一實例鎖的那份開長輪詢", /if \(app\.hasSingleInstanceLock\(\)\) startStep\("relay", \(\) => relay\(\)\.start\(\)\);/.test(main));
  ok("9 本機收圖的接收端也交給 relay(只限手機那一輪由 relay 判)", /_relay\.image\(j\.session_id, j\.mime, j\.b64, caption\)/.test(main));

  clearInterval(keepAlive);
  console.log(red ? `\n${red} FAIL` : "\nall pass");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
