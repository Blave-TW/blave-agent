// 手機暫停這台電腦的自動下單(App Agent 頁第 3 步;api openclaw/relay.py push_halt／halt_result,契約見 .claude/output/backend/app-halt-api-2026-11-05.md)。
// 假的 post 與假的 daemon 子行程,不開視窗、不打網路、不碰 ~/Blave。
//   1. relay:poll 的 controls 裡沒有 session 的 {type: "halt", id} 交給 opts.halt 一次,馬上回 halt_result{id, ok, error?}
//   2. id 形狀不對不動作、不回報;同一個 id 只做一次
//   3. 失敗回 ok:false,error 只回代碼(runtime 原文換成 FAILED);halt 拋錯或沒接也回報
//   4. 總開關關(403 APP_CHAT_OFF、enabled:false reason off)body 裡的暫停照做、照回報
//   5. daemon:主行程帶 by: "phone" 的暫停在 ui_events 記 by,events() 交給畫面;參數裡的 reason 不算
//   6. main.js 接線、畫面換字、兩語字串
// 跑法:node tests/check_shell_phone_halt.js
const fs = require("fs"), os = require("os"), path = require("path");
const { EventEmitter } = require("events");
const SHELL = path.join(__dirname, "..", "shell");
const RL = require(path.join(SHELL, "relay.js"));
const { createDaemonHost } = require(path.join(SHELL, "daemon.js"));
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const guard = async (name, fn) => { try { await fn(); } catch (e) { ok(name + " 跑不起來", false, String((e && e.message) || e)); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const API = "https://api.test", HID = "0123456789abcdef0123456789abcdef", HID2 = "fedcba9876543210fedcba9876543210";
const keepAlive = setInterval(() => {}, 1000);
const TMP = [];   // 跑完刪掉
const tmpDir = (pre) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), pre)); TMP.push(d); return d; };

function rig(o = {}) {
  const dir = tmpDir("phalt-"), calls = [], polls = [], halts = [];
  let pollWaiter = null;
  const post = async (url, body) => {
    const ep = url.slice(API.length);
    calls.push([ep, body]);
    if (ep === RL.EP.enabled) return { status: 200, body: { enabled: true, on: true } };
    if (ep === RL.EP.poll) { if (polls.length) return polls.shift(); return new Promise((res) => { pollWaiter = res; }); }
    if (ep === RL.EP.report) return { status: 200, body: { results: body.chunks.map(() => ({ status: "ok" })), interrupt: [], cancel: [] } };
    return { status: 200, body: { ok: true } };
  };
  const opts = {
    dir, stateDir: path.join(dir, "state"), apiBase: API, post, getCreds: () => ({ token: "tok_x", appSecret: "sec_x" }), // gitleaks:allow (fake)
    installId: () => "11111111-2222-4333-8444-555555555555", ver: "0.1.47", engineKind: () => "claude",
    startTurn: async () => ({ started: true }), stopTurn: () => true, turnBusy: () => false, isRestarting: () => false,
    sessions: { list: () => [], rowsAfter: () => [], maxId: () => 0, exists: () => false, remove: () => false },
    turnArgs: () => ({}), known: () => [], origins: { add: () => {}, get: () => new Map() }, track: () => {},
  };
  if (o.halt !== null) opts.halt = async () => { halts.push(Date.now()); if (o.halt) return o.halt(); return { ok: true }; };
  const r = RL.createRelay(opts);
  return { r, calls, polls, halts,
    feed: (body, status) => { const v = { status: status || 200, body }; if (pollWaiter) { const w = pollWaiter; pollWaiter = null; w(v); } else polls.push(v); },
    results: () => calls.filter((c) => c[0] === RL.EP.report).flatMap((c) => c[1].chunks).filter((c) => c.type === "halt_result"),
    end: async () => { await r.quit(); if (pollWaiter) { const w = pollWaiter; pollWaiter = null; w({ status: 0, body: null }); } } };
}
const live = (controls) => ({ enabled: true, messages: [], controls, server_time: 1 });
async function on(m) { await m.r.tick(); await m.r.setOn(true); await wait(20); }

(async () => {
  // ── 1 ──
  await guard("1", async () => {
    const m = rig(); await on(m);
    m.feed(live([{ type: "halt", id: HID, reason: "phone" }])); await wait(60);
    const res = m.results();
    ok("1 halt 控制交給 opts.halt 一次", m.halts.length === 1, m.halts.length);
    ok("1 回 halt_result{id, ok:true},沒有 error、不用等 300 毫秒那一批", res.length === 1 && res[0].id === HID && res[0].ok === true && !("error" in res[0]), res);
    await m.end();
  });
  // ── 2 ──
  await guard("2", async () => {
    const m = rig(); await on(m);
    m.feed(live([{ type: "halt", id: HID.toUpperCase() }, { type: "halt", id: "abc" }, { type: "halt" }, { type: "halt", id: 5 }, { type: "halt", id: HID + "0" }, null, "halt"])); await wait(60);
    ok("2 id 不是 32 位小寫 hex:不暫停、不回報", m.halts.length === 0 && m.results().length === 0, m.results());
    m.feed(live([{ type: "halt", id: HID }, { type: "halt", id: HID }])); await wait(60);
    m.feed(live([{ type: "halt", id: HID }])); await wait(60);
    ok("2 同一個 id 不論同一批或下一輪,只暫停一次、只回報一次", m.halts.length === 1 && m.results().length === 1, [m.halts.length, m.results()]);
    m.feed(live([{ type: "halt", id: HID2, session_id: "desktop-abcd1234" }])); await wait(60);
    ok("2 帶了 session_id 的 halt 照樣是暫停(不落到對話控制)", m.halts.length === 2 && m.results().some((c) => c.id === HID2 && c.ok === true));
    await m.end();
  });
  // ── 3 ──
  await guard("3", async () => {
    const cases = [
      [{ ok: false, error: "TIMEOUT" }, "TIMEOUT"],
      [{ ok: false, error: "UNKNOWN_RESULT" }, "UNKNOWN_RESULT"],
      [{ ok: false, error: "BAD_ROUTE: 「btc_trend」 /Users/x/Blave" }, "FAILED"],
      [{ ok: false }, "FAILED"],
      [null, "FAILED"],
      ["throw", "FAILED"],
    ];
    for (const [ret, want] of cases) {
      const m = rig({ halt: () => { if (ret === "throw") throw new Error("boom /Users/x"); return ret; } }); await on(m);
      m.feed(live([{ type: "halt", id: HID }])); await wait(60);
      const res = m.results();
      ok("3 結果 " + JSON.stringify(ret) + " → ok:false error " + want, res.length === 1 && res[0].ok === false && res[0].error === want, res);
      await m.end();
    }
    const m = rig({ halt: null }); await on(m);
    m.feed(live([{ type: "halt", id: HID }])); await wait(60);
    ok("3 沒接 opts.halt:照樣回 ok:false(不讓 api 停在 delivered)", m.results().length === 1 && m.results()[0].ok === false && m.results()[0].error === "FAILED", m.results());
    await m.end();
  });
  // ── 4 ──
  await guard("4", async () => {
    const m = rig(); await on(m);
    m.feed({ error_code: "APP_CHAT_OFF", controls: [{ type: "halt", id: HID }] }, 403); await wait(60);
    ok("4 poll 403 APP_CHAT_OFF 帶的暫停照做、照回報", m.halts.length === 1 && m.results().length === 1 && m.results()[0].ok === true, m.results());
    await m.end();
    const n = rig(); await on(n);
    n.feed({ enabled: false, reason: "off", messages: [], controls: [{ type: "halt", id: HID2 }] }); await wait(60);
    ok("4 poll enabled:false reason off 帶的暫停照做、照回報", n.halts.length === 1 && n.results().length === 1 && n.results()[0].id === HID2, n.results());
    await n.end();
  });
  // ── 5 ──
  await guard("5", async () => {
    const ws = tmpDir("phalt-ws-"), inDir = path.join(ws, "state", "local_cmd", "in"), ackDir = path.join(ws, "state", "local_cmd", "ack");
    const spawnFn = () => { const c = new EventEmitter(); c.stdin = new EventEmitter(); c.stdin.write = () => true; c.stdin.end = () => {}; c.stderr = new EventEmitter(); c.kill = () => { setTimeout(() => c.emit("exit", 0, null), 5); return true; }; return c; };
    const host = createDaemonHost({ python: "x", script: "x.py", base: ws, workspace: ws, env: {}, spawnFn });
    host.start();
    // 假 daemon:收到指令檔就回 ack
    const acker = setInterval(() => { let fsn = []; try { fsn = fs.readdirSync(inDir); } catch (_) { return; }
      for (const f of fsn) if (f.endsWith(".json")) { fs.unlinkSync(path.join(inDir, f)); fs.writeFileSync(path.join(ackDir, f), JSON.stringify({ ok: true, result: "halted" })); } }, 20);
    const a = await host.send("halt", { reason: "phone" }, { by: "phone" });
    const b = await host.send("halt", { reason: "phone" });
    clearInterval(acker);
    const ev = host.events({ days: 1 }).filter((e) => e.type === "halt");
    ok("5 主行程帶 by phone 的暫停:ui_events 記 by phone,events() 交出來", a.ok && ev.length === 2 && ev[0].by === "phone", ev);
    ok("5 只有參數 reason phone(畫面送得出來的)不算手機:不帶 by", b.ok && ev[1] && !("by" in ev[1]), ev);
    await host.stop().catch(() => {});
  });
  // ── 6 ──
  await guard("6", async () => {
    const main = fs.readFileSync(path.join(SHELL, "main.js"), "utf8"), trade = fs.readFileSync(path.join(SHELL, "renderer", "trade.js"), "utf8");
    const fn = (main.match(/async function haltFromPhone\(\) \{[\s\S]*?\n\}/) || [""])[0];
    ok("6 main.js:relay 的 halt 接 haltFromPhone", /createRelay\(\{[\s\S]*?\bhalt: \(\) => haltFromPhone\(\),[\s\S]*?\}\);/.test(main));
    ok("6 haltFromPhone 走跟畫面暫停同一個指令(halt,reason phone,by phone),收尾防睡與選單列、發通知、回 {ok, error}",
      /tradeHost\(\)\.send\("halt", \{ reason: "phone" \}, \{ by: "phone" \}\)/.test(fn) && /awakeStartAt = 0; startStep\("awake", awakeSync\); traySync\(\);/.test(fn)
      && /tmLabels\.phoneHalt\b/.test(fn) && /tmLabels\.phoneHaltFail\b/.test(fn) && /!\(r && r\.ok && r\.result && r\.result\.queued\)/.test(fn) && /return r && r\.ok \? \{ ok: true \} : \{ ok: false, error:/.test(fn), fn.slice(0, 200));
    ok("6 通知字有英文退路、畫面交得過去(tmLabels 預設有這兩個 key、trPushLabels 有送)",
      /\n  phoneHalt: "[^"]+", phoneHaltFail: "[^"]+",\n/.test(main) && /phoneHalt: t\("tm\.phoneHalt"\), phoneHaltFail: t\("tm\.phoneHaltFail"\)/.test(trade));
    ok("6 事件列:這台記的 by phone 那筆寫 evHaltPhone;狀態列 source web + reason phone 也換字",
      /d\.by === "phone" \? "tr\.ov\.evHaltPhone"/.test(trade) && /trHaltByPhone\(halt\) \? "tr\.ov\.evHaltPhone"/.test(trade)
      && /function trHaltByPhone\(h\) \{ return !!h && h\.source === "web" && h\.reason === "phone"; \}/.test(trade));
    const src = fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8");
    const S = new Function(src + "; return STRINGS;")();
    ok("6 兩語都有五個新字", ["en", "zh"].every((l) => ["tr.ov.evHaltPhone", "tm.phoneHalt", "tm.phoneHaltFail", "tm.phoneHaltUnsure", "tm.phoneHaltUnsureBody"].every((k) => typeof S[l][k] === "string" && S[l][k].length > 0)));
    ok("6 不確定那則不講沒生效", ["zh", "en"].every((l) => S[l]["tm.phoneHaltUnsure"] !== S[l]["tm.phoneHaltFail"]) && !/沒有生效/.test(S.zh["tm.phoneHaltUnsure"]) && /結果不明/.test(S.zh["tm.phoneHaltUnsure"]));
    // 通知照 notifications §8.1:視窗在前景不發;背景才發,成功／不確定／失敗三種標題;常駐程式沒在跑(queued)不發
    const shown = [];
    class N { static isSupported() { return true; } constructor(o) { this.o = o; } on() { return this; } show() { shown.push(this.o); } }
    const run = async (focused, res) => {
      shown.length = 0;
      const F = new Function("tradeHost", "BrowserWindow", "Notification", "TT", "tmLabels", "notifWatch", "showMain", "startStep", "awakeSync", "traySync",
        "let awakeStartAt = 1;\n" + fn + "\nreturn haltFromPhone;");
      const h = F(() => ({ send: async () => res }), { getFocusedWindow: () => (focused ? {} : null) }, N, { notifTitle: (_p, x) => x },
        { phoneHalt: "OK", phoneHaltFail: "FAIL", phoneHaltUnsure: "UNSURE", phoneHaltUnsureBody: "UB", notifBody: "B", pauseFail: "PF" }, (n) => n, () => {}, () => {}, () => {}, () => {});
      const back = await h();
      return { back, shown: shown.map((o) => o.title + "/" + o.body).join() };
    };
    const fg = await run(true, { ok: true }), ok1 = await run(false, { ok: true }), un = await run(false, { ok: false, error: "UNKNOWN_RESULT" }),
      bad = await run(false, { ok: false, error: "TIMEOUT" }), q = await run(false, { ok: true, result: { queued: true } });
    ok("6 前景不發、照回手機", fg.shown === "" && fg.back.ok === true, fg);
    ok("6 背景:成功／不確定／失敗各自的標題與內文;queued 不發", ok1.shown === "OK/B" && un.shown === "UNSURE/UB" && un.back.error === "UNKNOWN_RESULT" && bad.shown === "FAIL/PF" && q.shown === "", [ok1, un, bad, q]);
    ok("6 中文寫「已從手機暫停下單」(同組兄弟句都是完成式)", S.zh["tr.ov.evHaltPhone"] === "已從手機暫停下單" && S.zh["tm.phoneHalt"] === "已從手機暫停下單");
  });
  clearInterval(keepAlive);
  for (const d of TMP) try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 刪不掉不算紅 */ }
  console.log(red ? `\n${red} FAIL` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})();
