// shell/cloudcmd.js:對雲端主機下指令(寫入)。不打真的 api、不用真的時鐘(post 與 setTimer 都是假的)。
// 釘住:body 的鍵恰好是契約那五個、金鑰只隨 credentials、重試沿用同一顆 request_id、每個錯誤碼落在對的桶、
// ack pending→done、逾時是「結果不明」不是「沒送到」、憑證與金鑰不出現在回傳、換帳號丟棄在途、ack 輪詢真的有退避。
// 跑法:node tests/check_shell_cloud_cmd.js
const fs = require("fs"), path = require("path");
const M = require("../shell/cloudcmd.js");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const TOKEN = "acct-TTTT", SECRET = "appsec-SSSS", KEY = "BNKEY-aaaaaaaa", SKEY = "BNSECRET-bbbbbbbb";
const QID = "9b1c" + "0".repeat(28);
const queued = (o = {}) => ({ status: 200, body: { status: "queued", id: QID, ...o } });
const ackDone = (o = {}) => ({ status: 200, body: { status: "done", cmd: "halt", ok: true, result: { halted: true }, ts: 1, ...o } });

/* 假世界:時鐘只由 setTimer 推進(所以 ack 退避的每一段都看得到),post 依路徑取回應 */
function world(o = {}) {
  const w = { clock: 1e12, posts: [], waits: [], creds: "creds" in o ? o.creds : { token: TOKEN, appSecret: SECRET },
    cmdRes: o.cmdRes === undefined ? queued() : o.cmdRes, ackRes: o.ackRes === undefined ? { status: 200, body: { status: "pending" } } : o.ackRes };
  w.cmd = M.createCloudCmd({ apiBase: "https://x", now: () => w.clock, getCreds: () => w.creds,
    setTimer: (fn, ms) => { w.waits.push(ms); w.clock += ms; fn(); return 0; },
    post: async (u, b) => {
      w.posts.push({ u, b });
      if (w.onPost) await w.onPost(w.posts.length);
      const r = u.indexOf("/ack") >= 0 ? w.ackRes : w.cmdRes;
      if (r === "throw") throw new Error("net");
      return typeof r === "function" ? r(w.posts.length) : r;
    } });
  return w;
}
const ackCalls = (w) => w.posts.filter((p) => p.u.indexOf("/ack") >= 0).length;

(async () => {
  // ── interpret:指令那一段 ──
  t("200 queued → QUEUED,帶佇列 id;duplicate 原樣往上交", (() => { const a = M.interpret(queued()), b = M.interpret(queued({ duplicate: true }));
    return a.code === "QUEUED" && a.id === QID && a.duplicate === false && b.duplicate === true; })());
  t("401 兩種、409(+machine_state)、429、413、503 稽核、5xx、連不上",
    M.interpret({ status: 401, body: { error_code: "INVALID_CREDENTIALS" } }).code === "INVALID_CREDENTIALS"
    && M.interpret({ status: 401, body: { error_code: "APP_SECRET_REQUIRED" } }).code === "APP_SECRET_REQUIRED"
    && M.interpret({ status: 409, body: { error_code: "MACHINE_NOT_RUNNING", machine_state: "starting" } }).machineState === "starting"
    && M.interpret({ status: 409, body: { machine_state: "weird" } }).machineState === null
    && M.interpret({ status: 429, body: {} }).code === "RATE_LIMITED" && M.interpret({ status: 413, body: {} }).code === "BODY_TOO_LARGE"
    && M.interpret({ status: 503, body: { error_code: "AUDIT_UNAVAILABLE" } }).code === "AUDIT_UNAVAILABLE"
    && M.interpret({ status: 503, body: {} }).code === "OFFLINE" && M.interpret({ status: 500, body: {} }).code === "OFFLINE" && M.interpret(null).code === "OFFLINE");
  t("400 只認契約那三個代號,別的字串不往畫面帶(一律 BAD_COMMAND)",
    ["UNKNOWN_COMMAND", "REQUEST_ID_REQUIRED", "BAD_COMMAND"].every((e) => M.interpret({ status: 400, body: { error_code: e } }).code === e)
    && M.interpret({ status: 400, body: { error_code: "SOMETHING ELSE " + SKEY } }).code === "BAD_COMMAND");
  t("端點不見了(404)= 確定沒排進去;2xx 但拿不到佇列 id = 跟逾時一樣不可知",
    M.interpret({ status: 404, body: {} }).code === "BAD_RESPONSE" && M.interpret({ status: 200, body: {} }).code === "UNKNOWN_RESULT"
    && M.interpret({ status: 200, body: { status: "queued", id: "短" } }).code === "UNKNOWN_RESULT");

  // ── 三桶(實作地圖 §7):409 必須是 undelivered,不可沿用本機「已排隊」 ──
  t("undelivered 那一桶的每個代號都在表裡", ["MACHINE_NOT_RUNNING", "BAD_COMMAND", "UNKNOWN_COMMAND", "REQUEST_ID_REQUIRED",
    "BODY_TOO_LARGE", "AUDIT_UNAVAILABLE", "RATE_LIMITED", "OFFLINE", "INVALID_CREDENTIALS", "APP_SECRET_REQUIRED"].every((c) => M.KIND[c] === "undelivered"));
  t("ack 逾時是 unknown;表裡沒有任何 rejected(它只來自機器的 ok:false)",
    M.KIND.UNKNOWN_RESULT === "unknown" && !Object.keys(M.KIND).some((k) => M.KIND[k] === "rejected"));

  // ── body 的鍵 ──
  { const w = world({ ackRes: ackDone() }); const r = await w.cmd.send("halt", { reason: "user" });
    const b = w.posts[0].b;
    t("指令:POST 契約那支端點,鍵恰為 token / app_secret / request_id / cmd / args", w.posts[0].u === "https://x" + M.ENDPOINT
      && JSON.stringify(Object.keys(b).sort()) === '["app_secret","args","cmd","request_id","token"]'
      && b.cmd === "halt" && JSON.stringify(b.args) === '{"reason":"user"}' && M.REQUEST_ID_RE.test(b.request_id));
    t("ack:另一支端點,鍵恰為 token / app_secret / id,問的是指令回來的那個 id", w.posts[1].u === "https://x" + M.ACK_ENDPOINT
      && JSON.stringify(Object.keys(w.posts[1].b).sort()) === '["app_secret","id","token"]' && w.posts[1].b.id === QID);
    t("機器回條 ok → ok:true + result", r.ok === true && r.result.halted === true && r.id === QID);
  }
  { const w = world({ ackRes: ackDone() }); await w.cmd.send("resume");
    t("沒帶 args:body 仍有 args = {}", JSON.stringify(w.posts[0].b.args) === "{}"); }

  // ── secrets 只隨 credentials ──
  { const w = world({ ackRes: ackDone({ cmd: "credentials", result: "credentials=2" }) });
    await w.cmd.send("credentials", { venue: "binance" }, { BINANCE_API_KEY: KEY, BINANCE_SECRET_KEY: SKEY });
    const b = w.posts[0].b;
    t("credentials:secrets 在 body 頂層(不是 args.env,那個 api 一律 400)", JSON.stringify(Object.keys(b).sort()) === '["app_secret","args","cmd","request_id","secrets","token"]'
      && b.secrets.BINANCE_API_KEY === KEY && !("env" in b.args)); }
  { const w = world({ ackRes: ackDone() }); await w.cmd.send("halt", {}, { BINANCE_API_KEY: KEY });
    t("別的指令帶了 secrets:丟掉,不讓金鑰白跑一趟", !("secrets" in w.posts[0].b) && !JSON.stringify(w.posts).includes(KEY)); }

  // ── 重試沿用同一顆 request_id(冪等:close_all 兩次、amounts 舊值蓋新值) ──
  { const w = world({ cmdRes: { status: 503, body: { error_code: "AUDIT_UNAVAILABLE" } } });
    const a = await w.cmd.send("close_all", {});
    t("503 稽核 → 沒送出(undelivered),回傳帶著這次的 request_id", a.ok === false && a.error === "AUDIT_UNAVAILABLE" && a.kind === "undelivered" && M.REQUEST_ID_RE.test(a.requestId));
    w.cmdRes = queued({ duplicate: true }); w.ackRes = ackDone({ cmd: "close_all", result: { started: true } });
    const b = await w.cmd.send("close_all", {}, null, { requestId: a.requestId });
    t("重試沿用同一顆 request_id;api 回 duplicate 照樣去問 ack", w.posts[1].b.request_id === a.requestId && b.ok === true && b.duplicate === true);
    t("兩次是不同動作時才是不同顆", (await w.cmd.send("close_all", {})).requestId !== a.requestId);
    const bad = await w.cmd.send("halt", {}, null, { requestId: "短的" });
    t("呼叫端給了壞形狀的 request_id:不偷偷換一顆新的(那等於毀掉冪等)", bad.ok === false && bad.error === "BAD_ARGS" && bad.requestId === null); }

  // ── 各錯誤碼各自的桶 ──
  for (const [name, res, code, ms] of [
    ["409 沒主機", { status: 409, body: { error_code: "MACHINE_NOT_RUNNING", machine_state: "stopped" } }, "MACHINE_NOT_RUNNING", "stopped"],
    ["429 太快", { status: 429, body: { error_code: "ERR429" } }, "RATE_LIMITED", null],
    ["503 稽核寫不進去", { status: 503, body: { error_code: "AUDIT_UNAVAILABLE" } }, "AUDIT_UNAVAILABLE", null],
    ["401 憑證被撤", { status: 401, body: { error_code: "INVALID_CREDENTIALS" } }, "INVALID_CREDENTIALS", null],
    ["連不上", "throw", "OFFLINE", null]]) {
    const w = world({ cmdRes: res }); const r = await w.cmd.send("halt", {});
    t(name + " → " + code + " / undelivered,而且不去問 ack", r.ok === false && r.error === code && r.kind === "undelivered"
      && r.machineState === ms && ackCalls(w) === 0); }
  { const w = world({ ackRes: ackDone({ ok: false, error: "unknown command foo", result: undefined }) });
    const r = await w.cmd.send("retest_accounts", {});
    t("機器回 ok:false → rejected(機器上的字串原樣往上交,畫面自己截斷)", r.ok === false && r.kind === "rejected" && r.error === "unknown command foo"); }

  // ── ack:pending → done、逾時、退避 ──
  { const w = world({ ackRes: (n) => (n >= 4 ? ackDone() : { status: 200, body: { status: "pending" } }) });
    const r = await w.cmd.send("resume", {});
    t("ack pending → done:問到有回條為止", r.ok === true && ackCalls(w) === 3); }
  { const w = world();   // 一直 pending
    const r = await w.cmd.send("amounts", { amounts: { momo: 1500 } });
    t("問滿 20 秒還沒回條 → UNKNOWN_RESULT(不是失敗,不可說沒送到)", r.ok === false && r.error === "UNKNOWN_RESULT" && r.kind === "unknown" && r.id === QID);
    // 字面值:拿模組自己的常數當標準的話,把上限改成 10 秒也會全綠
    t("ack 退避就是這一條序列(500 起、×1.6、封頂 3000、總窗 20000 → 10 次,固定每秒是 20 次)",
      w.waits.join(" ") === "500 800 1280 2048 3000 3000 3000 3000 3000 372" && ackCalls(w) === 10, JSON.stringify(w.waits));
    t("常數沒有被偷偷放寬", M.ACK_FIRST_MS === 500 && M.ACK_FACTOR === 1.6 && M.ACK_MAX_MS === 3000 && M.ACK_WINDOW_MS === 20000
      && w.waits.reduce((a, b) => a + b, 0) === 20000); }
  { const w = world({ ackRes: (n) => (n === 2 ? { status: 429, body: {} } : n === 3 ? "throw" : n === 4 ? { status: 503, body: {} } : ackDone()) });
    const r = await w.cmd.send("halt", {});
    t("ack 階段的 429 / 連不上 / 5xx 只是這次沒問到:繼續問,不會變成 undelivered", r.ok === true && ackCalls(w) === 4); }
  { const w = world({ ackRes: { status: 401, body: {} } }); const r = await w.cmd.send("halt", {});
    t("ack 401(憑證被撤):提早停,但指令已經在佇列裡 → 結果不明,不是沒送到", r.error === "UNKNOWN_RESULT" && r.kind === "unknown" && ackCalls(w) === 1); }

  // ── 憑證與金鑰不出現在任何回傳 ──
  { const w = world({ ackRes: ackDone({ cmd: "credentials", result: "credentials=2" }) });
    const r = await w.cmd.send("credentials", { venue: "binance" }, { BINANCE_API_KEY: KEY, BINANCE_SECRET_KEY: SKEY });
    const s = JSON.stringify(r);
    t("回傳裡沒有 token / app_secret / 金鑰值", !s.includes(TOKEN) && !s.includes(SECRET) && !s.includes(KEY) && !s.includes(SKEY) && r.ok === true); }

  // ── 這一份是誰的 ──
  { const w = world({ ackRes: ackDone() }); w.onPost = async () => { w.creds = { token: "acct-B", appSecret: "sb" }; };
    const r = await w.cmd.send("close_all", {});
    t("指令已經上線、api 也回了 queued,途中換帳號:丟掉,但桶是 unknown(它會執行,不可叫人重按)",
      r.ok === false && r.error === "ACCOUNT_CHANGED" && r.kind === "unknown" && ackCalls(w) === 0); }
  { const w = world({ cmdRes: "throw", ackRes: ackDone() }); w.onPost = async () => { w.creds = { token: "acct-B", appSecret: "sb" }; };
    const r = await w.cmd.send("close_all", {});
    t("陽性對照:網路斷(post 拋例外)時換帳號 → undelivered,那才是真的沒送出", r.error === "ACCOUNT_CHANGED" && r.kind === "undelivered"); }
  { const w = world({ ackRes: ackDone() }); w.onPost = async (n) => { if (n === 2) w.creds = { token: "acct-B", appSecret: "sb" }; };
    const r = await w.cmd.send("close_all", {});
    t("ack 途中換帳號:丟掉,桶是 unknown", r.error === "ACCOUNT_CHANGED" && r.kind === "unknown"); }
  { const w = world({ ackRes: ackDone() }); w.onPost = async (n) => { if (n === 1) w.cmd.reset(); };
    const r = await w.cmd.send("halt", {});
    t("在途登出(reset):同樣丟掉", r.error === "ACCOUNT_CHANGED" && ackCalls(w) === 0); }
  // 讀不到憑證(safeStorage 暫時不可用、鑰匙圈被鎖)不是換帳號:在途那一顆不可以被作廢成「結果不明」
  { const w = world({ ackRes: (n) => (n >= 3 ? ackDone() : { status: 200, body: { status: "pending" } }) });
    w.onPost = async (n) => { w.creds = n <= 2 ? null : { token: TOKEN, appSecret: SECRET }; };
    const r = await w.cmd.send("halt", {});
    t("ack 途中憑證一時讀不到:照樣問完、照樣收得到回條(不當成登出)", r.ok === true && ackCalls(w) === 2); }
  { let reads = 0; const w = world({ ackRes: (n) => (n >= 4 ? ackDone() : { status: 200, body: { status: "pending" } }) });
    const real = w.creds; w.creds = real; const cmd2 = M.createCloudCmd({ apiBase: "https://x", now: () => w.clock,
      getCreds: () => { reads++; return real; }, setTimer: (fn, ms) => { w.clock += ms; fn(); return 0; },
      post: async (u) => { w.posts.push({ u, b: {} }); return u.indexOf("/ack") >= 0 ? (w.posts.length >= 5 ? ackDone() : { status: 200, body: { status: "pending" } }) : queued(); } });
    await cmd2.send("halt", {});
    t("憑證一輪只讀一次(safeStorage 解密 + 讀檔):四個請求讀不超過 6 次", reads <= 6, "reads=" + reads); }
  { const w = world({ creds: null }); const r = await w.cmd.send("halt", {});
    t("沒登入 / 舊登入沒有 app_secret:不發請求", r.error === "NO_LOGIN" && w.posts.length === 0
      && (await world({ creds: { token: TOKEN, appSecret: null } }).cmd.send("halt", {})).error === "NO_LOGIN"); }
  { const w = world({ ackRes: ackDone() });   // 啟動 = resume + restart_reconciler:同一個人的並行指令不可以互相作廢
    const [a, b] = await Promise.all([w.cmd.send("resume", {}), w.cmd.send("restart_reconciler", {})]);
    t("同一個人同時送兩個指令:兩個都正常收到回條,各自一顆 request_id", a.ok === true && b.ok === true
      && w.posts[0].b.request_id !== w.posts[1].b.request_id); }

  // ── POST 照按下順序排隊、ack 照舊並行(start-pending-stop §1.1) ──
  { let release = null; const hold = new Promise((r) => { release = r; });
    const w = world({ ackRes: (n) => (n >= 1 ? ackDone() : null) });
    // 第一個 POST(resume)卡在網路上,直到放行
    w.onPost = async (n) => { if (n === 1) await hold; };
    const pa = w.cmd.send("resume", {});
    await new Promise((r) => setImmediate(r));
    const pb = w.cmd.send("halt", { reason: "x" });
    await new Promise((r) => setImmediate(r));
    t("前一個 POST 還在路上時,下一個 POST 不出門", w.posts.length === 1 && w.posts[0].b.cmd === "resume");
    release();
    const [a, b] = await Promise.all([pa, pb]);
    const cmds = w.posts.filter((p) => p.u.indexOf("/ack") < 0).map((p) => p.b.cmd);
    t("api 收到的順序 = 按下的順序(resume 然後 halt)", cmds.join(",") === "resume,halt" && a.ok && b.ok, cmds.join(",")); }
  { // 計時器全部攔下不跑:第一個指令會停在 ack 的第一段等待裡
    const timers = [], posts = [];
    const cmd = M.createCloudCmd({ apiBase: "https://x", now: () => 1e12, getCreds: () => ({ token: TOKEN, appSecret: SECRET }),
      setTimer: (fn) => { timers.push(fn); return 0; },
      post: async (u, b) => { posts.push({ u, b }); return u.indexOf("/ack") >= 0 ? ackDone() : queued(); } });
    let firstDone = false;
    cmd.send("resume", {}).then(() => { firstDone = true; });
    const pb = cmd.send("halt", {});
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    t("第二個 POST 不等第一個的 ack(第一個還卡在 ack 等待裡,第二個已經出門)",
      !firstDone && posts.filter((p) => p.u.indexOf("/ack") < 0).map((p) => p.b.cmd).join(",") === "resume,halt");
    while (timers.length) timers.shift()();
    await pb; }
  { let release = null; const hold = new Promise((r) => { release = r; });
    const w = world({ ackRes: ackDone() }); w.onPost = async (n) => { if (n === 1) await hold; };
    const pa = w.cmd.send("resume", {}); await new Promise((r) => setImmediate(r));
    const pb = w.cmd.send("halt", {}); await new Promise((r) => setImmediate(r));
    w.cmd.reset(); release();
    const b = await pb; await pa;
    t("排隊中登出:後面那個不打上線,算確定沒送出", b.error === "ACCOUNT_CHANGED" && b.kind === "undelivered"
      && w.posts.filter((p) => p.u.indexOf("/ack") < 0).length === 1); }

  { // 登出再登入(同一顆 token):登出前還在路上的啟動 POST,登入後按的暫停仍然要排在它後面
    let release = null; const hold = new Promise((r) => { release = r; });
    const w = world({ ackRes: ackDone() }); w.onPost = async (n) => { if (n === 1) await hold; };
    const pa = w.cmd.send("resume", {}); await new Promise((r) => setImmediate(r));
    w.cmd.reset();
    const pb = w.cmd.send("halt", {}); await new Promise((r) => setImmediate(r));
    t("登出再登入後的暫停不插隊:前一個 POST 還在路上時不出門", w.posts.filter((p) => p.u.indexOf("/ack") < 0).length === 1);
    release(); await pa; const b = await pb;
    t("…放行後照順序出門、照樣收得到回條", w.posts.filter((p) => p.u.indexOf("/ack") < 0).map((p) => p.b.cmd).join(",") === "resume,halt" && b.ok === true); }

  // ── 只給雲端的指令的參數(delete_strategy / update)──
  t("delete_strategy 只收 {name},name 過機器端那條 regex;update 不再是這個 app 送的指令(用本機 app 不觸發雲端 agent 回合)",
    M.cloudArgsOk("delete_strategy", { name: "btc_4h-v2" }) && !M.cloudArgsOk("delete_strategy", { name: "../x" }) && !M.cloudArgsOk("delete_strategy", { name: "a".repeat(65) })
    && !M.cloudArgsOk("delete_strategy", { name: "a", x: 1 }) && !M.cloudArgsOk("delete_strategy", {}) && !M.cloudArgsOk("delete_strategy", { name: 3 })
    && !M.cloudArgsOk("update", {}) && !M.cloudArgsOk("halt", {}) && !M.cloudArgsOk("delete_strategy", null) && JSON.stringify(M.CLOUD_ONLY_COMMANDS) === '["delete_strategy"]');

  // ── 雲端連交易所(S5)──
  { const shape = (k, s) => /^[A-Za-z0-9]{8,}$/.test(k) && /^[A-Za-z0-9]{8,}$/.test(s);
    const p = M.connectSecrets({ venue: "paper", apiKey: "x", secret: "y", env: { BLAVE_X: "1" } }, shape, 1700000000.7);
    t("連接:模擬交易的名字由主行程決定(renderer 帶什麼都不影響),只有三個 PAPER_*", JSON.stringify(p) === JSON.stringify({ venue: "paper", secrets: { PAPER_API_KEY: "paper", PAPER_SECRET_KEY: "paper", PAPER_BOUND_TS: "1700000000" } }));
    const b = M.connectSecrets({ venue: "binance", apiKey: " KEYaaaaaaaa ", secret: "SECbbbbbbbb", BLAVE_TOKEN: "evil", env: { BLAVE_X: "1" } }, shape, 1);
    t("連接:Binance 只放兩個 BINANCE_*,值 trim 過;renderer 多塞的鍵不會進 secrets", JSON.stringify(b.secrets) === JSON.stringify({ BINANCE_API_KEY: "KEYaaaaaaaa", BINANCE_SECRET_KEY: "SECbbbbbbbb" }));
    t("連接:形狀不對 / 少一欄 / 不認得的交易所 → 不送出", M.connectSecrets({ venue: "binance", apiKey: "k", secret: "" }, shape, 1).error === "BAD_KEY_FORMAT"
      && M.connectSecrets({ venue: "binance", apiKey: "short", secret: "SECbbbbbbbb" }, shape, 1).error === "BAD_KEY_FORMAT"
      && M.connectSecrets({ venue: "okx" }, shape, 1).error === "BAD_ARGS" && M.connectSecrets(null, shape, 1).error === "BAD_ARGS"); }
  { const R = (e) => M.interpretConnect({ ok: false, kind: "rejected", error: e });
    t("連接結果:ok + binance dict → OK / NO_IP_RESTRICT,帶 spot / futures", (() => { const a = M.interpretConnect({ ok: true, result: { credentials: 2, binance: { checked: true, code: "NO_IP_RESTRICT", spot: false, futures: true } } });
      return a.ok && a.code === "NO_IP_RESTRICT" && a.detail.spot === false && a.detail.futures === true && M.interpretConnect({ ok: true, result: { credentials: 3, binance: null } }).code === "OK"; })());
    t("連接結果:舊 runtime 回字串也算 OK(Wei:這版不撤 key)", M.interpretConnect({ ok: true, result: "credentials=2" }).ok === true);
    t("連接結果:認得的拒絕碼原樣往上交;限速依說明字串分三種",
      R("ValueError: IP_OR_KEY: rejected by binance").code === "IP_OR_KEY" && R("ValueError: BAD_SECRET: x").code === "BAD_SECRET"
      && R("ValueError: RATE_LIMITED: HTTPError 429").code === "RATE_LIMITED" && R("ValueError: RATE_LIMITED: HTTPError 418 banned").code === "RATE_BANNED"
      && R("ValueError: RATE_LIMITED: backing off 40s").code === "RATE_BACKOFF");
    t("連接結果:MVP 不查提領——WITHDRAW_ENABLED 不是認得的代號,走一般拒絕(原文截 200)", R("ValueError: WITHDRAW_ENABLED: x").code === "REJECTED" && !M.CONNECT_CODES.includes("WITHDRAW_ENABLED")
      && R("ValueError: EVIL_CODE: " + "z ".repeat(500)).code === "REJECTED" && R("boom " + "z ".repeat(500)).detail.error.length === 200);
    t("連接結果:被拒原文用這一次送出的金鑰值再遮一次(模擬那三個不是祕密,不遮)", (() => {
      const r = M.interpretConnect({ ok: false, kind: "rejected", error: "boom KEYaaaaaaaa / SECbbbbbbbb paper" }, { BINANCE_API_KEY: "KEYaaaaaaaa", BINANCE_SECRET_KEY: "SECbbbbbbbb", PAPER_API_KEY: "paper" });
      return r.code === "REJECTED" && !/KEYaaaaaaaa|SECbbbbbbbb/.test(r.detail.error) && /paper/.test(r.detail.error); })()
      && (() => { const K = "Ab1CdE2fGh3IjK4lMn5OpQ6rSt7UvW8x";   // 真的金鑰英數混雜(規則只遮混合的片段)
        const low = M.interpretConnect({ ok: false, kind: "rejected", error: "x " + K.toLowerCase() + " y" }, { BINANCE_API_KEY: K }).detail.error;
        const part = M.interpretConnect({ ok: false, kind: "rejected", error: "key " + K.slice(0, 20) + "..." }, { BINANCE_API_KEY: K }).detail.error;
        const edge = M.interpretConnect({ ok: false, kind: "rejected", error: "q ".repeat(95) + K }, { BINANCE_API_KEY: "zz" + K }).detail.error;   // 跨在第 200 字上:先遮再截
        const code = M.interpretConnect({ ok: false, kind: "rejected", error: "ValueError: SOMETHING_ODD: HTTPError 418" }, {}).detail.error;
        const cls = M.interpretConnect({ ok: false, kind: "rejected", error: "BinanceAPIExceptionWrapper: APIErrorCodeUnauthorized" }, {}).detail.error;
        if (cls !== "BinanceAPIExceptionWrapper: APIErrorCodeUnauthorized") return false;   // 只遮字母數字混合的:例外類名照原樣
        return !/ab1cde2fgh3/i.test(low) && !/Ab1CdE2fGh3IjK4/.test(part) && !/Ab1CdE2f/.test(edge) && code === "ValueError: SOMETHING_ODD: HTTPError 418"; })()
      && /CC\.interpretConnect\(r, built\.secrets\)/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8")));
    t("連接結果:沒送到 / 結果不明分開,帶 machineState 給畫面選句",
      M.interpretConnect({ ok: false, kind: "undelivered", error: "MACHINE_NOT_RUNNING", machineState: "stopped" }).detail.machineState === "stopped"
      && M.interpretConnect({ ok: false, kind: "undelivered", error: "RATE_LIMITED" }).code === "UNDELIVERED"
      && M.interpretConnect({ ok: false, kind: "unknown", error: "UNKNOWN_RESULT" }).code === "CMD_UNKNOWN" && M.interpretConnect(null).code === "UNDELIVERED"); }
  { const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
    const h = (mainSrc.match(/\n  handle\("cloud-connect"[\s\S]*?\n  \}, cxDenied\);/) || [""])[0];
    t("main.js:cloud-connect 走 handle()(只收自家頁面)、送的是 credentials + connectSecrets 的 secrets、每次新的 request_id(不帶第四個參數)、不跑本機 Binance 檢查",
      h.length > 100 && /cloudCmd\(\)\.send\("credentials", \{\}, built\.secrets\);/.test(h) && !/binanceLink|binance_check|requestId/.test(h.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""))
      && /cloudConnect: \(a\) => ipcRenderer\.invoke\("cloud-connect", \{ venue: a && a\.venue, apiKey: a && a\.apiKey, secret: a && a\.secret \}\)/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "preload.js"), "utf8"))); }

  // ── 原文:不 require electron、不 log、不落地 ──
  const src = fs.readFileSync(path.join(__dirname, "..", "shell", "cloudcmd.js"), "utf8");
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  t("這個檔不 require electron / fs、不寫檔、不 log(body 裡有金鑰與兩顆憑證)",
    !/require\("electron"\)|require\("fs"\)/.test(code) && !/console\.|writeFile|appendFile/.test(code));
  t("打包清單帶 cloudcmd.js(S2 接線後沒有它,發佈版一 require 就整個當掉)",
    /"cloudcmd\.js"/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "electron-builder.config.js"), "utf8")));
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
