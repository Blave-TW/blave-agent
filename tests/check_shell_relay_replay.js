// 電腦版 relay 的重播 fixture(tests/fixtures/relay_shell_replay.json):從 shell/relay.js 真正的 onTurn／launch／control 路徑
// 跑出幾個情境,記下外殼依序送給 api 的 ack／report 請求 body(憑證與裝置代號拿掉)。api 那邊拿同一份重播,兩份逐字相同。
//   跑法:node tests/check_shell_relay_replay.js           比對 fixture(relay.js 行為一變就紅,要重產並同步 api 那份)
//        node tests/check_shell_relay_replay.js --write   重產 fixture
//   api 那份:BLAVE_RELAY_API_DIR 或 ../api 底下的 tests/fixtures/relay_shell_replay.json,找不到就 SKIP
const fs = require("fs"), os = require("os"), path = require("path");
const RL = require(path.join(__dirname, "..", "shell", "relay.js"));
const FIX = path.join(__dirname, "fixtures", "relay_shell_replay.json");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const API = "https://api.test";
const SID = "desktop-mreplay0001", SID_BUSY = "desktop-busy0001";

function rig(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-replay-"));
  const reqs = [], busy = new Set(o.busy || []);
  let pollWaiter = null;
  const answer = (ep, body) => {
    if (ep === RL.EP.enabled) return { status: 200, body: { enabled: true, on: true } };
    if (ep === RL.EP.ack) return o.noAck ? { status: 0, body: null } : { status: 200, body: { acked: body.message_ids, rejected: [] } };
    if (ep === RL.EP.report) return { status: 200, body: { results: body.chunks.map(() => ({ status: "ok" })), interrupt: [], cancel: [] } };
    if (ep === RL.EP.syncState) return { status: 200, body: { sessions: [], tombstones: [] } };
    return { status: 200, body: {} };
  };
  const post = async (url, body) => {
    const ep = url.slice(API.length);
    if (ep === RL.EP.poll) return new Promise((res) => { pollWaiter = res; });
    const resp = answer(ep, body);
    // 在回應回到外殼的那一刻記(實際發生的順序)
    if (ep === RL.EP.ack || ep === RL.EP.report) { const { token, app_secret, device, ...rest } = body; reqs.push({ endpoint: ep, body: rest }); }   // eslint-disable-line no-unused-vars
    return resp;
  };

  const r = RL.createRelay({
    dir, stateDir: path.join(dir, "state"), apiBase: API, post, getCreds: () => ({ token: "t-replay", appSecret: "s-replay" }),
    installId: () => "11111111-2222-4333-8444-555555555555", ver: "0.1.37", engineKind: () => "blave",
    startTurn: async (p) => { busy.add(p.sessionId); return { started: true }; },
    stopTurn: (sid) => { if (o.onStop) o.onStop(sid); return true; }, turnBusy: (sid) => busy.has(sid), isRestarting: () => false,
    sessions: { list: () => [], rowsAfter: () => [], maxId: () => 0, exists: () => true, remove: () => true },
    turnArgs: () => ({}), known: () => [], origins: { add: () => {}, get: () => new Map() },
  });
  return { r, reqs, busy,
    feed: (messages, controls) => { const w = pollWaiter; pollWaiter = null; if (w) w({ status: 200, body: { enabled: true, messages: messages || [], controls: controls || [], server_time: 1 } }); },
    end: async () => { await r.quit(); const w = pollWaiter; pollWaiter = null; if (w) w({ status: 0, body: null }); } };
}
const msg = (sid, id, content) => ({ message_id: id, session_id: sid, content, timestamp: 1, origin: "app", device_label: "iPhone 15" });
const settle = () => wait(RL.BATCH_MS + 80);

const SCENARIOS = [
  ["direct_start", "那條沒在跑:ack → started → 回合輸出 → done", async (m) => {
    m.feed([msg(SID, "msgreplay0001", "幫我看 BTC")]); await wait(30);
    m.r.onTurn(SID, "turn-event", { type: "text", text: "BTC 現在" });
    m.r.onTurn(SID, "turn-event", { type: "tool", tool: "Bash", status: "running", where: "local" }); await settle();
    m.r.onTurn(SID, "turn-event", { type: "done", awaiting: false }); m.busy.delete(SID);
    m.r.onTurn(SID, "turn-end", { code: 0, errTail: "" }); await settle();
  }],
  ["fault_code", "引擎的錯誤字:text 不送,代碼放回合的 error", async (m) => {
    m.feed([msg(SID, "msgreplay0040", "跑回測")]); await wait(30);
    m.r.onTurn(SID, "turn-event", { type: "text", text: "API Error: 402 insufficient credit" }); await settle();
    m.r.onTurn(SID, "turn-event", { type: "error", message: "這一輪沒有跑起來", code: "not_started" }); m.busy.delete(SID);
    m.r.onTurn(SID, "turn-end", { code: 1, errTail: "" }); await settle();
  }],
  ["error_after_start", "開跑之後出錯:回合的 error chunk(不是 message_failed)", async (m) => {
    m.feed([msg(SID, "msgreplay0002", "跑回測")]); await wait(30);
    m.r.onTurn(SID, "turn-event", { type: "error", message: "boom" }); m.busy.delete(SID);
    m.r.onTurn(SID, "turn-end", { code: 1, errTail: "boom" }); await settle();
  }],
  ["stop", "手機按停止:controls interrupt → 外殼停那一輪 → runtime 照「已停止」收尾送 done", async (m) => {
    m.feed([msg(SID, "msgreplay0003", "掃參數")]); await wait(30);
    m.feed([], [{ type: "interrupt", session_id: SID }]); await wait(30);
    m.r.onTurn(SID, "turn-event", { type: "done", awaiting: false, interrupted: true }); m.busy.delete(SID);
    m.r.onTurn(SID, "turn-end", { code: 0, errTail: "" }); await settle();
  }],
  ["withdraw_queued", "同一條在跑(電腦前的人):排隊回 queued → 手機撤回 → cancelled＋withdraw_result withdrawn", async (m) => {
    m.feed([msg(SID_BUSY, "msgreplay0004", "再看一次")]); await wait(30);
    m.feed([], [{ type: "withdraw", session_id: SID_BUSY, message_id: "msgreplay0004" }]); await settle();
  }, { busy: [SID_BUSY] }],
  ["queued_then_started", "排在電腦前的人那一輪後面:queued → 那輪結束 → 單獨回報 started、回 ok 才開跑 → done", async (m) => {
    m.feed([msg(SID_BUSY, "msgreplay0005", "接著做")]); await wait(30);
    m.busy.delete(SID_BUSY); m.r.onTurn(SID_BUSY, "turn-end", { code: 0, errTail: "" }); await wait(30);
    m.r.onTurn(SID_BUSY, "turn-event", { type: "done", awaiting: false }); m.busy.delete(SID_BUSY);
    m.r.onTurn(SID_BUSY, "turn-end", { code: 0, errTail: "" }); await settle();
  }, { busy: [SID_BUSY] }],
  ["no_ack", "送出當下 ack 沒回應(60 秒內沒 ack):外殼不跑、不回 started,回 message_failed not_run", async (m) => {
    m.feed([msg(SID, "msgreplay0006", "下單")]); await settle();
  }, { noAck: true }],
];

(async () => {
  const out = { spec: "mobile-agent-chat-mvp §1.3", source: "blave-agent shell/relay.js via tests/check_shell_relay_replay.js",
    note: "每個情境:外殼依序送出的 ack / report 請求 body(token、app_secret、device 已拿掉)。改 relay.js 的回報行為要重產並同步 api 那份", scenarios: [] };
  for (const [name, desc, run, o] of SCENARIOS) {
    const m = rig(o || {});
    await m.r.tick(); await m.r.setOn(true); await wait(20);
    await run(m);
    await m.end();
    out.scenarios.push({ name, desc, requests: m.reqs });
  }
  const text = JSON.stringify(out, null, 2) + "\n";
  if (process.argv.includes("--write")) { fs.writeFileSync(FIX, text); console.log("wrote " + FIX); process.exit(0); }
  ok("fixture 等於 relay.js 現在跑出來的(不等就重產:--write)", fs.existsSync(FIX) && fs.readFileSync(FIX, "utf8") === text);
  const sc = (n) => out.scenarios.find((s) => s.name === n).requests;
  const types = (n) => sc(n).flatMap((r) => (r.endpoint === RL.EP.ack ? ["ack"] : r.body.chunks.map((c) => c.type)));
  ok("直接開跑:ack → started(單獨一筆,回 ok 才開跑)→ 輸出 → done", types("direct_start").join() === "ack,started,text,tool,done" && sc("direct_start")[1].body.chunks.length === 1, types("direct_start"));
  ok("開跑後出錯:error 不是 message_failed", types("error_after_start").includes("error") && !types("error_after_start").includes("message_failed"));
  ok("撤回排隊中:queued → cancelled{message_ids} → withdraw_result", types("withdraw_queued").join() === "ack,queued,cancelled,withdraw_result" && JSON.stringify(sc("withdraw_queued").find((r) => r.body.chunks && r.body.chunks[0].type === "cancelled").body.chunks[0].message_ids) === '["msgreplay0004"]');
  ok("排隊叫出:started 單獨一筆、在 done 之前", (() => { const r = sc("queued_then_started").filter((x) => x.endpoint === RL.EP.report); const i = r.findIndex((x) => x.body.chunks.some((c) => c.type === "started")); return i >= 0 && r[i].body.chunks.length === 1 && types("queued_then_started").indexOf("started") < types("queued_then_started").indexOf("done"); })());
  ok("沒 ack:ack 之後只回 message_failed not_run,不跑", types("no_ack").join() === "ack,message_failed" && sc("no_ack")[1].body.chunks[0].code === "not_run");
  ok("fixture 裡沒有憑證", !/t-replay|s-replay/.test(text));
  const apiCopy = path.join(process.env.BLAVE_RELAY_API_DIR || path.join(__dirname, "..", "..", "api"), "tests", "fixtures", "relay_shell_replay.json");
  if (!fs.existsSync(apiCopy)) console.log("SKIP  api 那份逐字比對(設 BLAVE_RELAY_API_DIR 指到 api checkout)");
  else ok("與 api 那份逐字相同", fs.readFileSync(apiCopy).equals(fs.readFileSync(FIX)), apiCopy);
  console.log(red ? `\n${red} FAIL` : "\nall pass");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
