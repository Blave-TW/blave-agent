// 策略庫(shell/renderer/library.js + main.js 的 libraryList / libraryPurchase / libraryInstalled + 接線)。
//   ① 純邏輯(從原文切出來跑,不碰 DOM):市場分段、一份清單的排序(官方 / 已驗證 → 未驗證;0.1.6 §2 平鋪)、CTA 十一態的先後與 noData 的 why、送給 agent 的那句話(逐字同 web
//      workspace_lib_msg / _paid)、價格 / 餘額的格式、購買回應的分支、曲線時間軸。
//   ② 主行程:libSanitize 壞形狀 → 整筆丟 / 清單不是陣列 → null、控制字元、spark / gate_checks;已安裝對照表的讀寫與清洗。
//   ③ 接線(原文):index.html 的入口 / chip / 視圖 / 載入順序;envShowMain 兩個分支都問 libShowMain 且原本那幾行沒動;
//      三個開別的視圖的地方都 libLeave;回合三個出口都 libSync;turn-end 等 stratRefresh 回來才 libTurnEnd;delClose 認 lock;
//      preload / main 的三支 IPC(購買只收自家頁面);字串表 zh / en 都齊;library.js 沒有 innerHTML。
//   ④ 用隨包的 Electron 開真的 index.html:清單順序與 tag、分段、詳情、CTA 閘門態、「用這支」→ 確認框 → 逐字那句話 → 進行中
//      → turn-end 記對照表 → 已安裝;沒新策略的灰字;購買框六個分支(第一段、購買中鎖框、餘額不足有卡第二段、沒卡、409、失敗行、
//      成功後本機代下載再送 lib.msgLocal);en 的價格與那句話;api 來的字只進 textContent。
// ⑥ 本機「用這支」(spec-0.1.13 §4;不起 Electron):先代下載再送 lib.msgLocal、下載中擋重入、失敗三種、雲端照舊、確認框的資料費那一行。
//    主行程的 libraryDownload 在 ② 用真的 fs 跑(0600、symlink、security.json、失敗分類)。
// ⑤ 成功筆記(spec-0.1.12-library-notes;不起 Electron):入口只認這一語言的 id / 標題、主行程收兩欄與讀筆記(匿名、200/201、30 分鐘快取、
//    回四欄)、白名單重建(錄好的 fixture + 惡意片段,用 @xmldom 解析 + 假元素工廠;第一個 <hr> 之後不畫、a 拆字、img/script/iframe 整顆丟、零屬性)、
//    回合中「點了才講」的接線(aria-disabled、清在 libSync)。讀筆記的端點每打一次就在正式站記一筆閱讀:這裡只用 tests/fixtures/success_notes.json。
// 跑法:node tests/check_shell_library.js(找不到 shell/node_modules 的 Electron 時 ④ SKIP,①②③ 照跑)
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 2000))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const src = read(path.join(R, "library.js")), appSrc = read(path.join(R, "app.js")), trSrc = read(path.join(R, "trade.js"));
const html = read(path.join(R, "index.html")), strings = read(path.join(R, "strings.js")), mainSrc = read(path.join(SHELL, "main.js")), pre = read(path.join(SHELL, "preload.js"));
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
const STR = (() => { const sb = {}; vm.runInNewContext(strings + "\nthis.S = STRINGS;", sb); return sb.S; })();

// web 的那兩句(逐字;web/app/translations/*/LC_MESSAGES/messages.po 的 workspace_lib_msg / workspace_lib_msg_paid,2026-09-25 抄下)
const WEB_MSG = {
  zh: { msg: "幫我下載官方策略「{title}」（#{id}），跑一次回測看看結果", paid: "幫我下載已購買的策略「{title}」（#{id}），跑一次回測看看結果" },
  en: { msg: "Download the official strategy \"{title}\" (#{id}) and run a backtest to see the results.", paid: "Download my purchased strategy \"{title}\" (#{id}) and run a backtest" },
};

const SPARK = Array.from({ length: 64 }, (_, i) => +(1 + i * 0.03).toFixed(4));
const S = (o) => Object.assign({ id: 1, title: "x", summary: null, description: null, price: 0, category: "Crypto", created_at: "2026-06-10 00:00:00", purchase_count: 0,
  purchased: false, is_owner: false, is_official: true, verified: true, direction: null, max_exposure: null, report: null }, o);
const EQ400 = Array.from({ length: 400 }, (_, i) => +(1 + i * 0.005).toFixed(4));
const GATES = { mcpt_status: "pass", mcpt_p: 0.0004, mcpt_n: 1000, robust: { ratio: 0.91, raw_sharpe: 1.5, plateau_sharpe: 1.37 }, fee: { rate: 0.0005, actual: 0.0004 } };
const REP = (o) => Object.assign({ total_return: 312.5, annual_return: 24.61, sharpe: 1.5, max_drawdown: -20, symbol: "BTCUSDT", interval: "5m", gate_checks: { mcpt: "pass", robust: "pass", fee: "pass" }, gates: GATES, spark: SPARK, equity_from: "2020-01-01", equity_to: "2026-06-30" }, o);
const REPORT = { strategy_id: 101, title: "x", equity: EQ400, equity_from: "2020-01-01", equity_to: "2026-06-30", backtest_start: "2019-12-02", backtest_end: "2026-06-30", created_at: "2026-06-10 00:00:00", gates: GATES };
const LIST = [
  S({ id: 101, title: "BTC 通道動能共振", summary: "通道 + 動能。", description: "第一段。\n第二段。", created_at: "2026-06-10 00:00:00", purchase_count: 7, direction: "long", max_exposure: 1, report: REP({}) }),
  S({ id: 74, title: "台指期 PCR 未平倉籌碼偏多", category: "TW Stock", created_at: "2026-06-14 00:00:00", purchase_count: 12, report: REP({ symbol: "TXF", interval: "1d", annual_return: 12.28, gate_checks: { mcpt: "na", robust: "pass", fee: "pass" }, equity_from: "2014-04-08", equity_to: "2026-08-28" }) }),
  S({ id: 72, title: "DOGE 籌碼集中度", created_at: "2026-06-10 00:00:00", purchase_count: 18, report: REP({ symbol: "DOGEUSDT", interval: "1h", equity_from: "2023-03-02", equity_to: "2026-08-31" }) }),
  S({ id: 86, title: "ETH 多空力道動能", verified: false, created_at: "2026-07-12 00:00:00", report: REP({ symbol: "ETHUSDT", interval: "1h", gate_checks: null, spark: null, equity_from: null, equity_to: null }) }),
  S({ id: 8, title: "BTC Taker Bundle", is_official: false, verified: false, price: 1200, created_at: "2026-05-16 00:00:00", report: REP({ gate_checks: null, gates: null }) }),
  // 社群、跑過關卡但兩道沒過(費率低於交易所、p 不顯著):列在社群段、詳情先講「2 道關卡未通過」
  S({ id: 12, title: "SOL 動能 二道未過", is_official: false, verified: false, price: 800, created_at: "2026-05-20 00:00:00", report: REP({ symbol: "SOLUSDT", interval: "1h", gate_checks: { mcpt: "fail", robust: "pass", fee: "fail" }, gates: { mcpt_status: "fail", mcpt_p: 0.12, mcpt_n: 1000, robust: { ratio: 0.82 }, fee: { rate: 0.0003, actual: 0.0004 } } }) }),
  S({ id: 5, title: "Cash-and-Carry <img onerror=x> Arbitrage", is_official: false, verified: true, price: 1500, created_at: "2026-05-02 00:00:00", purchase_count: 3, report: null }),
  S({ id: 9, title: "已買的社群策略", is_official: false, verified: true, price: 900, purchased: true, created_at: "2026-04-02 00:00:00", report: null }),
];

if (!process.versions.electron) {
  const ASYNC = [];   // 要 await 的段落(代下載):全部跑完才收尾
  // ── ① 純邏輯 ──
  const a = src.indexOf("/* ── 純邏輯("), b = src.indexOf("/* ── 純邏輯到此");
  if (a < 0 || b < 0) throw new Error("找不到純邏輯區塊的標記");
  const block = src.slice(a, b);
  ok("① 純邏輯區塊不碰 DOM / i18n", !/\bdocument\b|\$\(|window\.|\bt\(/.test(block.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  const P = {}; vm.createContext(P); vm.runInContext(block.replace(/^const /gm, "var "), P);
  ok("① 市場分段:category 正好是 Crypto → 加密、TW Stock → 台股;其餘(US Stock / Forex / Other / 未知 / 缺)只在全部", P.libMarket({ category: "TW Stock" }) === "tw" && P.libMarket({ category: "Crypto", report: { symbol: "TXF" } }) === "crypto"
    && ["US Stock", "Forex", "Other", "台股", "trend", "crypto", ""].every((c) => P.libMarket({ category: c, report: { symbol: "TXF" } }) === "other") && P.libMarket({}) === "other" && P.libMarket(null) === "other"
    && P.libVisible([{ id: 1, category: "Forex" }, { id: 2, category: "Crypto" }], "crypto").map((s) => s.id).join() === "2"
    && P.libVisible([{ id: 1, category: "Forex" }, { id: 2, category: "Crypto" }], "all").length === 2);
  const v = P.libVisible(LIST, "all");
  ok("① 一份清單(0.1.6 §2.1):官方或已驗證在前(其中已驗證 → 樣本長 → 新;官方但未驗證的 #86 墊在這一段尾)、未驗證的社群策略在最後(同一套排序:樣本同長就新的先);回的是陣列", Array.isArray(v) && v.map((s) => s.id).join() === "74,101,72,5,9,86,12,8");
  ok("① 分段:台股 1 支;加密 7 支(2 支未驗證在尾);沒有的市場空陣列", P.libVisible(LIST, "tw").map((s) => s.id).join() === "74" && P.libVisible(LIST, "crypto").map((s) => s.id).join() === "101,72,5,9,86,12,8"
    && P.libVisible([], "tw").length === 0 && P.libVisible(null, "all").length === 0);
  ok("① 關卡數值的字:費率 0.0005 → 0.05%、0.001 → 0.10%、0.00125 → 0.125%、壞值 —;p 照範本四位小數、< 0.001 整段換成 p < 0.001、壞值 —;fail 計數", P.libRate(0.0005) === "0.05%" && P.libRate(0.001) === "0.10%" && P.libRate(0.00125) === "0.125%" && P.libRate(0) === "0.00%" && P.libRate(null) === "—" && P.libRate("x") === "—"
    && P.libP("p = {p}", 0.0012) === "p = 0.0012" && P.libP("p = {p}", 0.0004) === "p < 0.001" && P.libP("p = {p}", null) === "—" && P.libGateFails({ mcpt: "fail", robust: "pass", fee: "fail" }) === 2 && P.libGateFails({ mcpt: "na", robust: "pass", fee: "pass" }) === 0 && P.libGateFails(null) === 0);
  ok("① 樣本年數一位小數;沒有區間 → null;上架天數", P.libYears(LIST[0]) === 6.5 && P.libYears(LIST[1]) === 12.4 && P.libYears(LIST[3]) === null && P.libListedDays(LIST[0], Date.parse("2026-09-25T00:00:00Z")) === 107 && P.libListedDays({}, 0) === null);
  const C = (s, c) => P.libCta(s, Object.assign({ running: false, env: "local", signedIn: true, dataAccess: "included", cloud: null, pending: null, noNew: null, buying: null, installedName: null }, c));
  const free = LIST[0], paid = LIST[6], owned = LIST[7];
  ok("① CTA 先後:進行中(那支自己)> 回合中 > 未登入 > 付不出 > 購買中 > 已安裝 > 付費 > 已購 > 免費", C(free, { running: true, pending: 101 }).state === "pending" && C(free, { running: true, pending: 72 }).state === "busy" && C(free, { running: true, signedIn: false }).state === "busy" && C(free, { signedIn: false, dataAccess: "none" }).state === "signedOut"
    && C(free, { dataAccess: "none", pending: 72 }).state === "noData" && C(free, { pending: 101, installedName: "a" }).state === "pending" && C(paid, { buying: 5, installedName: "a" }).state === "buying"
    && C(free, { installedName: "btc" }).state === "installed" && C(free, { installedName: "btc" }).name === "btc" && C(paid, {}).state === "paid" && C(owned, {}).state === "owned" && C(free, {}).state === "free");
  ok("① noData 的 why(0.1.6 §3.1):只認 no_card / no_balance,其餘(含缺席、signed_out)→ unknown;別的態 why 是 null", C(free, { dataAccess: "none", why: "no_card" }).why === "no_card" && C(free, { dataAccess: "none", why: "no_balance" }).why === "no_balance"
    && C(free, { dataAccess: "none", why: "signed_out" }).why === "unknown" && C(free, { dataAccess: "none" }).why === "unknown" && C(free, { why: "no_card" }).why === null && C(free, { signedIn: false, dataAccess: "none", why: "no_card" }).why === null);
  ok("① 付費旗標只在「付費且沒買」;未登入時 paid 決定講哪一句", C(paid, { signedIn: false }).paid === true && C(owned, { signedIn: false }).paid === false && C(free, {}).paid === false && C(Object.assign({}, paid, { is_owner: true }), {}).state === "owned");
  ok("① 雲端視角:不看登入 / 資料費;停機 → stopped、逾時 → stale、活著才往下;雲端清單多出來的那支 → installed(名字帶著);已購沒裝過是 owned", C(free, { env: "cloud", signedIn: false, dataAccess: "none", cloud: "live" }).state === "free"
    && C(free, { env: "cloud", cloud: "stopped" }).state === "stopped" && C(free, { env: "cloud", cloud: "stale" }).state === "stale" && C(free, { env: "cloud", cloud: null }).state === "stale" && C(free, { env: "cloud", cloud: "stale", installedName: "x" }).state === "stale"
    && C(free, { env: "cloud", cloud: "live", installedName: "x" }).state === "installed" && C(free, { env: "cloud", cloud: "live", installedName: "x" }).name === "x" && C(owned, { env: "cloud", cloud: "live" }).state === "owned");
  ok("① 剛跑完沒新策略:只在免費 / 已購 / 已安裝態上加 err,別支不算", C(free, { noNew: 101 }).err === true && C(free, { noNew: 72 }).err === false && C(owned, { noNew: 9 }).err === true && C(paid, { noNew: 5 }).err === false && C(free, { noNew: 101, running: true }).err === false);
  ["zh", "en"].forEach((L) => {
    ok(`① ${L} lib.msg / lib.msgPaid 逐字同 web 的 workspace_lib_msg / _paid`, STR[L]["lib.msg"] === WEB_MSG[L].msg && STR[L]["lib.msgPaid"] === WEB_MSG[L].paid, STR[L]["lib.msg"]);
  });
  ok("① 那句話:id 先代、標題後代(標題裡的 {id} 不會被再代掉)、控制字元與多餘空白拿掉、截 120", P.libMsg({ id: 101, title: "BTC 通道動能共振" }, STR.zh["lib.msg"]) === "幫我下載官方策略「BTC 通道動能共振」（#101），跑一次回測看看結果"
    && P.libMsg({ id: 7, title: "a {id} b\n\tc" }, "x{id}:{title}") === "x7:a {id} b c" && P.libMsg({ id: 7, title: "y".repeat(200) }, "{id}{title}").length === 121);
  ok("① 那句話壞輸入 → null(壞 id、空標題、範本沒有槽 / 兩個槽 / 不是字串)", [P.libMsg({ id: 0, title: "a" }, "{id}{title}"), P.libMsg({ id: "5", title: "a" }, "{id}{title}"), P.libMsg({ id: 5, title: "  " }, "{id}{title}"), P.libMsg({ id: 5, title: "a" }, "{id}"), P.libMsg({ id: 5, title: "a" }, "{id}{title}{title}"), P.libMsg({ id: 5, title: "a" }, null)].every((x) => x === null));
  ok("① 價格:zh 原值千分位 + TWD;en ÷30 無條件進位到分 + USD;餘額不進位;壞值 null", P.libAmount(1200, "1", "TWD", "zh", true) === "1,200 TWD" && P.libAmount(1200, "30", "USD", "en", true) === "40 USD"
    && P.libAmount(350, "30", "USD", "en", true) === "11.67 USD" && P.libAmount(100, "30", "USD", "en", false) === "3.33 USD" && P.libAmount(100.5, "1", "TWD", "zh", false) === "100.5 TWD"
    && P.libAmount(1500, "30", "USD", "en", true) === "50 USD" && P.libAmount("x", "1", "TWD", "zh", true) === null && P.libAmount(10, "0", "TWD", "zh", true) === "10 TWD");
  ok("① 年化 / 數字:帶正負號、兩位小數、缺值 —(負號 U+2212)", P.libPct(24.61) === "+24.61%" && P.libPct(-7.6368) === "−7.64%" && P.libPct(0) === "0.00%" && P.libPct(null) === "—" && P.libFixed(1.3835, 2) === "1.38" && P.libFixed(undefined, 2) === "—");
  ok("① 購買分支:200 ok / 400 already purchased → ok;409 → inProgress;402 needs_topup 有卡 → topup、沒卡 → noCard;402 no card bound → noCard;其餘 → failed",
    P.libBuyBranch(200, { status: "ok" }) === "ok" && P.libBuyBranch(400, { error: "already purchased" }) === "ok" && P.libBuyBranch(409, {}) === "inProgress"
    && P.libBuyBranch(402, { needs_topup: true, has_card: true }) === "topup" && P.libBuyBranch(402, { needs_topup: true, has_card: false }) === "noCard" && P.libBuyBranch(402, { error: "no card bound", has_card: false }) === "noCard"
    && P.libBuyBranch(402, { error: "card charge failed" }) === "failed" && P.libBuyBranch(402, { error: "insufficient credits" }) === "failed" && P.libBuyBranch(0, null) === "failed" && P.libBuyBranch(200, { status: "nope" }) === "failed" && P.libBuyBranch(401, { error_code: "INVALID_CREDENTIALS" }) === "failed");
  const cv = P.libCurve(SPARK, "2020-01-01", "2026-06-30");
  ok("① 曲線:64 點均勻落在區間、時間嚴格遞增、首尾對齊;區間太短就併點;壞輸入 null", cv && cv.length === 64 && cv[0].time === "2020-01-01" && cv[63].time === "2026-06-30" && cv.every((p, i) => !i || p.time > cv[i - 1].time)
    && P.libCurve(SPARK, "2026-01-01", "2026-01-10").length === 10 && P.libCurve(SPARK, "2026-01-10", "2026-01-01") === null && P.libCurve([1], "2020-01-01", "2021-01-01") === null && P.libCurve([1, 0], "2020-01-01", "2021-01-01") === null && P.libCurve(SPARK, null, "2021-01-01") === null);
  ok("① libNeeds:只認 api 的 none / required,其餘(缺、舊 api、壞值)→ null", P.libNeeds({ blave_data: "none" }) === "none" && P.libNeeds({ blave_data: "required" }) === "required"
    && P.libNeeds({}) === null && P.libNeeds({ blave_data: true }) === null && P.libNeeds({ blave_data: "None" }) === null && P.libNeeds(null) === null);
  ok("① libFeeLine(確認框 / 購買框的資料費那一行):只在本機 × billed × 不是 none;未標(null)照出、雲端與其他帳號狀態不出",
    P.libFeeLine("local", "billed", "required") && P.libFeeLine("local", "billed", null) && !P.libFeeLine("local", "billed", "none") && !P.libFeeLine("cloud", "billed", "required")
    && !P.libFeeLine("local", "included", "required") && !P.libFeeLine("local", "none", null) && !P.libFeeLine("local", null, null));
  ok("① lib.msgLocal(本機,外殼已代下載):zh / en 各帶一次 {title} {id},libMsg 代得出來", P.libMsg({ id: 102, title: "Supertrend 趨勢（SOL）" }, STR.zh["lib.msgLocal"]) === "策略庫的「Supertrend 趨勢（SOL）」（#102）已經下載好了，幫我安裝並跑一次回測看看結果"
    && P.libMsg({ id: 102, title: "SOL" }, STR.en["lib.msgLocal"]) === "The library strategy \"SOL\" (#102) is downloaded. Install it and run a backtest to see the results.");
  // ── spec-0.1.13 §1:免登入策略、分組、詳情主鈕分流、找點子入口條件 ──
  const pubOff = S({ id: 102, title: "pub", blave_data: "none" }), reqOff = S({ id: 88, title: "req", blave_data: "required" }), nullOff = S({ id: 124, title: "null" });
  const pubComm = S({ id: 130, title: "comm", is_official: false, verified: false, blave_data: "none" }), pubPaid = S({ id: 131, title: "paid", price: 500, blave_data: "none" });
  ok("① libAnonOk(§1.1b):官方 × 免費 × none 三個缺一不可;未標不算", P.libAnonOk(pubOff) && !P.libAnonOk(reqOff) && !P.libAnonOk(nullOff) && !P.libAnonOk(pubComm) && !P.libAnonOk(pubPaid)
    && !P.libAnonOk(Object.assign({}, pubOff, { is_official: "true" })) && !P.libAnonOk(null));
  ok("① libPickData(§8):none / required / 未標 → unknown", P.libPickData(pubOff) === "none" && P.libPickData(reqOff) === "required" && P.libPickData(nullOff) === "unknown" && P.libPickData({ blave_data: "x" }) === "unknown");
  const G = (c) => P.libGrouping(Object.assign({ env: "local", signedIn: true, dataAccess: "included", why: null }, c));
  ok("① libGrouping(§1.2):雲端 null > 沒登入 signedOut > 有卡(included / billed)null > none 照 why(壞值 unknown)> 登入但查不到 unknown",
    G({ env: "cloud", signedIn: false, dataAccess: "none" }) === null && G({ signedIn: false, dataAccess: "included" }) === "signedOut" && G({}) === null && G({ dataAccess: "billed" }) === null
    && G({ dataAccess: "none", why: "no_card" }) === "no_card" && G({ dataAccess: "none", why: "no_balance" }) === "no_balance" && G({ dataAccess: "none", why: "signed_out" }) === "unknown" && G({ dataAccess: "none" }) === "unknown"
    && G({ dataAccess: null }) === "unknown" && G({ dataAccess: undefined }) === "unknown");
  const SPL = [reqOff, pubOff, nullOff, pubComm, pubPaid];
  ok("① libSplit(§2.2):已登入第一組 = none(含社群 / 付費),沒登入第一組 = 免登入策略;兩組保持原順序", P.libSplit(SPL, "no_card").now.map((s) => s.id).join() === "102,130,131" && P.libSplit(SPL, "no_card").later.map((s) => s.id).join() === "88,124"
    && P.libSplit(SPL, "signedOut").now.map((s) => s.id).join() === "102" && P.libSplit(SPL, "signedOut").later.map((s) => s.id).join() === "88,124,130,131" && P.libSplit(null, "unknown").now.length === 0);
  ok("① libCta 沒登入(§1.3 第 3 條):免登入策略照常「用這支」並帶 pub、已安裝照已安裝;其他(含社群免資料)只講登入;雲端不看登入",
    C(pubOff, { signedIn: false, dataAccess: null }).state === "free" && C(pubOff, { signedIn: false, dataAccess: null }).pub === true && C(pubOff, { signedIn: false, dataAccess: null, installedName: "sol" }).state === "installed"
    && C(pubComm, { signedIn: false, dataAccess: null }).state === "signedOut" && C(reqOff, { signedIn: false, dataAccess: null }).state === "signedOut" && C(pubPaid, { signedIn: false }).state === "signedOut" && C(pubPaid, { signedIn: false }).paid === true
    && C(pubOff, { env: "cloud", signedIn: false, cloud: "live" }).pub === false);
  ok("① libCta 資料牆(§1.3 第 4 條):只擋要資料與未標的;免資料的照常用並帶 pub;登入但查不到(dataAccess null)也算牆、why = unknown;有卡不分組、不帶 pub",
    ["no_card", "no_balance"].every((w) => C(reqOff, { dataAccess: "none", why: w }).state === "noData" && C(reqOff, { dataAccess: "none", why: w }).why === w && C(pubOff, { dataAccess: "none", why: w }).state === "free" && C(pubOff, { dataAccess: "none", why: w }).pub === true)
    && C(nullOff, { dataAccess: "none", why: "no_card" }).state === "noData" && C(reqOff, { dataAccess: null }).state === "noData" && C(reqOff, { dataAccess: null }).why === "unknown" && C(pubOff, { dataAccess: null }).state === "free"
    && C(pubComm, { dataAccess: "none", why: "no_card" }).state === "free" && C(pubPaid, { dataAccess: "none", why: "no_card" }).state === "paid" && C(pubPaid, { dataAccess: "none", why: "no_card" }).pub === true
    && C(pubOff, { dataAccess: "billed" }).pub === false && C(reqOff, { dataAccess: "billed" }).state === "free" && C(reqOff, { dataAccess: "none", why: "no_card", running: true }).state === "busy");
  const I8 = (c) => P.libIdeaOn(Object.assign({ env: "local", browserOn: true, engine: "claude", signedIn: true, canRun: true }, c));
  ok("① libIdeaOn(§1.4):本機 × 瀏覽器開著 × 引擎跑得動;Claude Code / Codex 不看帳號;Blave AI 要登入且不是不能跑(查不到不擋);沒連引擎不出",
    I8({}) && I8({ engine: "codex", signedIn: false, canRun: false }) && !I8({ env: "cloud" }) && !I8({ browserOn: false }) && !I8({ browserOn: "true" }) && !I8({ engine: null })
    && I8({ engine: "blave" }) && I8({ engine: "blave", canRun: null }) && !I8({ engine: "blave", canRun: false }) && !I8({ engine: "blave", signedIn: false }));
  ok("① 週期正規化同 web intervalKey", P.libIvKey("5min") === "5m" && P.libIvKey("60m") === "1h" && P.libIvKey("1d") === "1d" && P.libIvKey("240min") === "4h" && P.libIvKey("8h") === "8h" && P.libIvKey("480min") === "8h" && P.libIvKey("2h") === "2h" && P.libIvKey("720m") === "12h" && P.libIvKey("3m") === null && P.libIvKey(null) === null);

  // ── ② 主行程 ──
  const M = {}; vm.createContext(M);
  vm.runInContext(["LIB_TITLE_MAX", "LIB_DAY_RE", "libFin", "libDay", "libCurveOk", "LIB_NAME_RE"].map((n) => mainSrc.match(new RegExp("^const " + n + " = [^\\n]*$", "m"))[0].replace(/^const /, "var ")).join("\n") + "\n" + cutFn(mainSrc, "libSanitize") + "\n" + cutFn(mainSrc, "libNoteLangs") + "\n" + cutFn(mainSrc, "libInstalledClean") + "\n" + cutFn(mainSrc, "libReportSanitize")
  + "\n" + mainSrc.match(/^const LIB_NOTE_HTML_MAX = [^\n]*$/m)[0].replace(/^const /, "var ") + "\n" + cutFn(mainSrc, "libNoteSanitize"), M);
  ok("② 清單不是陣列 / body 不是物件 → null", M.libSanitize(null) === null && M.libSanitize({}) === null && M.libSanitize({ strategies: "x" }) === null && M.libSanitize([]) === null);
  const good = M.libSanitize({ strategies: LIST });
  ok("② 好的清單逐筆過、欄位齊、多出來的欄位不帶(沒有筆記兩欄 → null);report 多收 total_return 與 gates 的四個數字(其餘不帶)", good.length === LIST.length && good[0].id === 101 && good[0].report.spark.length === 64 && good[0].report.gate_checks.mcpt === "pass" && good[0].success_note_ids === null && good[0].success_note_titles === null && good[6].report === null
    && good[0].report.total_return === 312.5 && JSON.stringify(good[0].report.gates) === '{"mcpt_p":0.0004,"robust":{"ratio":0.91},"fee":{"rate":0.0005,"actual":0.0004}}' && good[4].report.gates === null);
  ok("② gates 有格壞 / 缺格 → 那格 null、其餘照收;gates 不是物件 → null;total_return 不是數 → null", JSON.stringify(M.libSanitize({ strategies: [S({ report: REP({ total_return: "9", gates: { mcpt_p: "x", robust: 5, fee: { rate: 0.0005 } } }) })] })[0].report.gates) === '{"mcpt_p":null,"robust":{"ratio":null},"fee":{"rate":0.0005,"actual":null}}'
    && M.libSanitize({ strategies: [S({ report: REP({ total_return: "9", gates: [] }) })] })[0].report.gates === null && M.libSanitize({ strategies: [S({ report: REP({ total_return: "9" }) })] })[0].report.total_return === null);
  const rep = M.libReportSanitize(REPORT);
  ok("② libReportSanitize:只留 400 點曲線 + 兩組日期、其餘欄位不帶;曲線 401 點 / 有 0 / 不是陣列 → null;日期只認 YYYY-MM-DD;body 不是物件 → null", JSON.stringify(Object.keys(rep)) === '["equity","equity_from","equity_to","backtest_start","backtest_end"]' && rep.equity.length === 400 && rep.backtest_start === "2019-12-02" && rep.equity_to === "2026-06-30"
    && M.libReportSanitize(Object.assign({}, REPORT, { equity: Array(401).fill(1) })).equity === null && M.libReportSanitize(Object.assign({}, REPORT, { equity: [1, 0] })).equity === null && M.libReportSanitize(Object.assign({}, REPORT, { equity: null, backtest_start: "2019-12-02 00:00:00" })).backtest_start === null
    && M.libReportSanitize(null) === null && M.libReportSanitize("x") === null);
  ok("② 全空的報告(200 + 全 null,S3 暫時讀不到)→ null、不進快取;只有回測期間也算有東西", M.libReportSanitize({}) === null && M.libReportSanitize({ equity: null, equity_from: null, equity_to: null, backtest_start: null, backtest_end: null }) === null
    && M.libReportSanitize({ equity: [1, 0], backtest_start: "2020-01-01", backtest_end: "2021-01-01" }).equity === null && M.libReportSanitize({ backtest_start: "2020-01-01", backtest_end: "2021-01-01" }).backtest_end === "2021-01-01");
  ok("② blave_data:只收 none / required,其餘(缺、布林、大小寫錯)一律 null", M.libSanitize({ strategies: [S({ id: 1, blave_data: "none" }), S({ id: 2, blave_data: "required" }), S({ id: 3 }), S({ id: 4, blave_data: true }), S({ id: 5, blave_data: "None" })] }).map((x) => x.blave_data).join() === "none,required,,,");
  const bad = M.libSanitize({ strategies: [null, 5, "x", { id: "101", title: "a", price: 0 }, { id: 101, title: "", price: 0 }, { id: 101, title: "a", price: -1 }, { id: 101, title: "a", price: "0" }, { id: 1.5, title: "a", price: 0 }, { id: true, title: "a", price: 0 }, LIST[0]] });
  ok("② 壞的那一筆整筆丟掉(id 不是正整數 / 標題空 / 價格負或不是數字),好的照留", bad.length === 1 && bad[0].id === 101);
  const ctl = M.libSanitize({ strategies: [S({ id: 3, title: "a\u0000b\nc\u007fd", description: "l1\nl2\u0000x", summary: "s\ts", category: 7, created_at: 9, purchase_count: -2, purchased: "yes", is_official: 1, verified: "true", direction: 3, max_exposure: "1",
    report: { annual_return: "9", sharpe: NaN, max_drawdown: null, symbol: 5, interval: "5m", gate_checks: { mcpt: "pass", robust: "meh", fee: "pass" }, spark: [1, "2", 3], equity_from: "2020-1-1", equity_to: "2021-01-01" } })] })[0];
  ok("② 控制字元:標題連換行都拿掉、說明留換行;布林只認 true;數字只認有限數;整數只認 ≥0;gate_checks 有一格壞 → 整組 null;spark 有非數 → null;日期只認 YYYY-MM-DD",
    ctl.title === "a b c d" && ctl.description === "l1\nl2 x" && ctl.summary === "s s" && ctl.category === null && ctl.created_at === null && ctl.purchase_count === 0 && ctl.purchased === false && ctl.is_official === false && ctl.verified === false
    && ctl.direction === null && ctl.max_exposure === null && ctl.report.annual_return === null && ctl.report.sharpe === null && ctl.report.symbol === null && ctl.report.gate_checks === null && ctl.report.spark === null && ctl.report.equity_from === null && ctl.report.equity_to === "2021-01-01");
  ok("② spark 太長 / 有 0 或負值 / 少於 2 點 → null", M.libSanitize({ strategies: [S({ report: REP({ spark: Array(513).fill(1) }) })] })[0].report.spark === null && M.libSanitize({ strategies: [S({ report: REP({ spark: [1, 0] }) })] })[0].report.spark === null && M.libSanitize({ strategies: [S({ report: REP({ spark: [1] }) })] })[0].report.spark === null);
  ok("② 標題截 200、說明截 5000", M.libSanitize({ strategies: [S({ title: "t".repeat(300), description: "d".repeat(6000) })] })[0].title.length === 200 && M.libSanitize({ strategies: [S({ description: "d".repeat(6000) })] })[0].description.length === 5000);
  ok("② 已安裝表清洗:key 只認正整數、值只認合法資料夾名(不以 . 開頭、不含 / \\ 控制字元、≤128);不是物件 → 空表",
    JSON.stringify(M.libInstalledClean({ 101: "btc_channel", "0": "a", "x": "b", 102: ".hidden", 103: "a/b", 104: "a\\b", 105: 5, 106: "", 107: "中文 名稱-1" })) === JSON.stringify({ 101: "btc_channel", 107: "中文 名稱-1" })
    && JSON.stringify(M.libInstalledClean([1])) === "{}" && JSON.stringify(M.libInstalledClean(null)) === "{}");
  { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blave-lib-"));
    const I = {}; vm.createContext(I);
    vm.runInContext("var fs = require('fs'), path = require('path'), app = { getPath: () => " + JSON.stringify(dir) + " };\n" + mainSrc.match(/^const libInstalledPath = [^\n]*$/m)[0].replace(/^const /, "var ") + "\n" + mainSrc.match(/^const LIB_NAME_RE = [^\n]*$/m)[0].replace(/^const /, "var ") + "\n" + cutFn(mainSrc, "libInstalledClean") + "\n" + cutFn(mainSrc, "libraryInstalled"), Object.assign(I, { require }));
    const r1 = I.libraryInstalled(), r2 = I.libraryInstalled({ id: 101, name: "btc_channel" }), r3 = I.libraryInstalled({ id: 101, name: "../x" }), r4 = I.libraryInstalled({ id: 102, name: "eth" }), r5 = I.libraryInstalled({ id: 101, name: null }), r6 = I.libraryInstalled("junk");
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "library-installed.json"), "utf8")), mode = fs.statSync(path.join(dir, "library-installed.json")).mode & 0o777;
    fs.rmSync(dir, { recursive: true, force: true });
    ok("② 已安裝表:沒有檔 = 空表;記一筆 → 寫檔 0600;壞名字不寫;拿掉一筆;patch 壞形狀只讀", JSON.stringify(r1) === "{}" && JSON.stringify(r2) === '{"101":"btc_channel"}' && JSON.stringify(r3) === '{"101":"btc_channel"}'
      && JSON.stringify(r4) === '{"101":"btc_channel","102":"eth"}' && JSON.stringify(r5) === '{"102":"eth"}' && JSON.stringify(r6) === '{"102":"eth"}' && JSON.stringify(onDisk) === '{"102":"eth"}' && mode === 0o600); }
  ASYNC.push((async () => { // 代下載(§4.2 / D1):真的 fs、假的 getJSON;workspace 是暫存目錄
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "blave-dl-")), WSd = path.join(base, "workspace"), outside = path.join(base, "outside");
    fs.mkdirSync(WSd); fs.mkdirSync(outside);
    const refs = path.join(WSd, "references"), mkt = path.join(refs, "marketplace.md");
    fs.mkdirSync(refs); fs.writeFileSync(mkt, "# Strategy Library API\n\n## Desktop-downloaded picks\n\n…");
    const D = { require, Buffer, WS: WSd, API_BASE: "https://api.test", calls: [], next: null, token: "t", key: { api_key: "k1", secret_key: "s1" } };
    vm.createContext(D);
    vm.runInContext("var fs = require('fs'), path = require('path'), crypto = require('crypto'), wsfile = require(" + JSON.stringify(path.join(__dirname, "..", "shell", "wsfile.js")) + ");\n" + ["LIB_CODE_MAX", "LIB_CONTRACT_ANCHOR"].map((n) => mainSrc.match(new RegExp("^const " + n + " = [^\\n]*$", "m"))[0].replace(/^const /, "var ")).join("\n")
      + "\n" + cutFn(mainSrc, "libContractReady")
      + "\nvar libCache = null, tmOn = true, live = true;\nfunction telemetryLive() { return live; }\nfunction tm() { return { isEnabled: () => tmOn, installId: () => '3f2a9c1e-7b04-4d6e-9e21-5c0b8d4f1a77' }; }\nfunction loadToken() { return token; }\nfunction loadDataKey() { return key; }\nasync function getJSON(url, headers) { calls.push([url, headers]); const n = Array.isArray(next) ? next.shift() : next; if (n === 'throw') throw new Error('net'); return n; }\n"
      + cutFn(mainSrc, "libAnonOk") + "\n"
      + cutFn(mainSrc, "libWriteWs") + "\nasync " + cutFn(mainSrc, "libraryDownload"), D);
    const dl = async (id, resp) => { D.next = resp; return D.libraryDownload(id); };
    const file = path.join(WSd, "tmp", "library_102.py"), sec = path.join(WSd, "tmp", "library_102.security.json"), J = (x) => JSON.stringify(x);
    const r1 = await dl(102, { status: 200, body: { code: "print(1)\n" } });
    const a1 = { r: J(r1), body: fs.readFileSync(file, "utf8"), mode: fs.statSync(file).mode & 0o777, url: D.calls[0][0], hdr: J(D.calls[0][1]), stray: fs.readdirSync(path.join(WSd, "tmp")).join() };
    const r2 = await dl(102, { status: 200, body: { code: "x = 2\n", security: { blocked: false, findings: [{ level: "WARNING" }] } } });
    const a2 = { r: J(r2), sec: JSON.parse(fs.readFileSync(sec, "utf8")).findings.length, body: fs.readFileSync(file, "utf8") };
    const r3 = await dl(102, { status: 200, body: { code: "x = 3\n" } });
    const a3 = { r: J(r3), secGone: !fs.existsSync(sec) };
    // 碼寫不進去(同名的是一個資料夾):失敗,而且不留一份對不上的掃描結果
    await dl(102, { status: 200, body: { code: "x\n", security: { blocked: false, findings: [] } } });
    fs.rmSync(file); fs.mkdirSync(file);
    const r3b = await dl(102, { status: 200, body: { code: "x = 9\n", security: { blocked: false, findings: [] } } });
    const a3b = { r: J(r3b), sec: fs.existsSync(sec) };
    fs.rmSync(file, { recursive: true }); fs.writeFileSync(file, "x = 3\n");
    const kinds = [];
    for (const resp of [{ status: 403, body: { error: "blocked", security: { blocked: true } } }, { status: 404, body: { error: "strategy not found" } }, { status: 403, body: { error: "not purchased" } },
      { status: 403, body: { error_code: "ERR005" } }, { status: 401, body: {} }, { status: 500, body: {} }, { status: 200, body: { code: 5 } }, { status: 200, body: { code: "  " } }, { status: 200, body: { code: "x".repeat(1024 * 1024 + 1) } }, "throw", { status: 200, body: null }])
      kinds.push((await dl(102, resp)).kind);
    const keptAfterFail = fs.readFileSync(file, "utf8");
    const n0 = D.calls.length; const badIds = [];
    for (const id of [0, -1, 1.5, "102", null]) badIds.push((await dl(id, { status: 200, body: { code: "y" } })).kind);
    D.token = null; const noTok = await dl(102, { status: 200, body: { code: "y" } }); D.token = "t";
    D.key = null; const noKey = await dl(102, { status: 200, body: { code: "y" } }); D.key = { api_key: "k1", secret_key: "s1" };
    const noReq = D.calls.length === n0;
    // P1-2:workspace 的 marketplace.md 還是舊的(沒有新契約錨點)/ 不存在 → 不下載、回 legacy,畫面改送舊句
    fs.writeFileSync(mkt, "# Strategy Library API\n\n## My accessible strategies\n");
    const n1 = D.calls.length, leg1 = await dl(102, { status: 200, body: { code: "q" } });
    fs.rmSync(mkt); const leg2 = await dl(102, { status: 200, body: { code: "q" } });
    // 舊契約 × 沒有 key(稽核 0.1.13 UI S1):不退回舊句(舊 agent 會叫人登入);免登入策略回 fail、其餘 signin,都不送請求
    vm.runInContext(`libCache = { strategies: [{ id: 102, is_official: true, price: 0, blave_data: "none" }] };`, D);
    D.token = null; const leg3 = await dl(102, { status: 200, body: { code: "q" } }), leg4 = await dl(88, { status: 200, body: { code: "q" } }); D.token = "t";
    vm.runInContext("libCache = null;", D);
    fs.writeFileSync(mkt, "## Desktop-downloaded picks\n");
    const legacy = { a: J(leg1), b: J(leg2), c: J(leg3), d: J(leg4), noReq: D.calls.length === n1, kept: fs.readFileSync(file, "utf8") };
    // Wei 10-02:官方 × 免費 × 不用 Blave 資料 → 沒有 key 也能下載(匿名 /public_code);其餘照舊要登入
    vm.runInContext(`libCache = { strategies: [
      { id: 102, is_official: true, price: 0, blave_data: "none" }, { id: 88, is_official: true, price: 0, blave_data: "required" },
      { id: 125, is_official: true, price: 0, blave_data: null }, { id: 124, is_official: false, price: 0, blave_data: "none" },
      { id: 500, is_official: true, price: 99, blave_data: "none" } ] };`, D);
    const anonURL = (id) => "https://api.test/openclaw/marketplace/strategies/" + id + "/public_code";
    const A = {};
    D.token = null; let c0 = D.calls.length;
    A.ok = J(await dl(102, { status: 200, body: { code: "anon = 1\n" } })); A.okCall = J(D.calls.slice(c0)); A.okBody = fs.readFileSync(file, "utf8");
    vm.runInContext("tmOn = false;", D); c0 = D.calls.length; A.off = J(await dl(102, { status: 200, body: { code: "anon = 1\n" } })); A.offCall = J(D.calls.slice(c0)); vm.runInContext("tmOn = true;", D);
    vm.runInContext("live = false;", D); c0 = D.calls.length; A.dev = J(await dl(102, { status: 200, body: { code: "anon = 1\n" } })); A.devCall = J(D.calls.slice(c0)); vm.runInContext("live = true;", D);
    c0 = D.calls.length; A.denied = [];
    for (const id of [88, 125, 124, 500, 777]) A.denied.push((await dl(id, { status: 200, body: { code: "x" } })).kind);
    A.deniedNoReq = D.calls.length === c0;
    A.srv = [];
    const cache0 = vm.runInContext("libCache", D);   // 404 會把快取作廢(M1):每一筆前放回去
    for (const resp of [{ status: 404, body: {} }, { status: 429, body: {} }, { status: 503, body: {} }, "throw"]) {
      D.cache0 = cache0; vm.runInContext("libCache = cache0;", D); A.srv.push((await dl(102, resp)).kind); }
    vm.runInContext("libCache = cache0;", D);
    D.token = "t"; D.key = { api_key: "k1", secret_key: "s1" };
    A.revoked404 = (await dl(102, [{ status: 403, body: { error_code: "ERR005" } }, { status: 404, body: {} }])).kind;   // key 被撤改走匿名、匿名那條 404:也是 anonGone
    vm.runInContext("libCache = cache0;", D);
    // 稽核 0.1.13 UI M1:404 之後主行程的清單快取要作廢(畫面接著重拉才拿得到新清單);其他失敗不動快取
    const keepCache = 'libCache = { strategies: [{ id: 102, is_official: true, price: 0, blave_data: "none" }] };';
    vm.runInContext(keepCache, D); D.token = null; D.key = null; await dl(102, { status: 404, body: {} }); A.cacheAfterAnon404 = vm.runInContext("libCache", D);
    vm.runInContext(keepCache, D); D.token = "t"; D.key = { api_key: "k1", secret_key: "s1" }; await dl(102, { status: 404, body: {} }); A.cacheAfterGone = vm.runInContext("libCache", D);
    vm.runInContext(keepCache, D); A.rl = [(await dl(102, { status: 429, body: {} })).kind]; await dl(102, { status: 500, body: {} }); A.cacheAfter500 = !!vm.runInContext("libCache", D);
    D.token = null; D.key = null; A.rl.push((await dl(102, { status: 429, body: {} })).kind);
    D.token = null; D.key = null;
    D.token = "t"; D.key = null; c0 = D.calls.length;
    A.noKey = J(await dl(102, { status: 200, body: { code: "anon = 2\n" } })); A.noKeyUrl = D.calls.slice(c0).map((c) => c[0]).join();
    D.key = { api_key: "k1", secret_key: "s1" }; c0 = D.calls.length;
    A.revoked = J(await dl(102, [{ status: 403, body: { error_code: "ERR005" } }, { status: 200, body: { code: "anon = 3\n" } }])); A.revokedUrls = D.calls.slice(c0).map((c) => c[0]).join(); A.revokedHdr = J(D.calls.slice(c0).map((c) => c[1]));
    c0 = D.calls.length; A.revokedReq = (await dl(88, [{ status: 401, body: {} }])).kind; A.revokedReqCalls = D.calls.length - c0;
    c0 = D.calls.length; A.withKey = J(await dl(102, { status: 200, body: { code: "k = 1\n" } })); A.withKeyUrls = D.calls.slice(c0).map((c) => c[0]).join();
    vm.runInContext("libCache = null;", D);
    // 預先放一個指向 workspace 外的同名 symlink:寫入要換掉 symlink 本身,外面那個檔不能被改
    const victim = path.join(outside, "victim.txt"); fs.writeFileSync(victim, "keep");
    fs.rmSync(file); fs.symlinkSync(victim, file);
    const r4 = await dl(102, { status: 200, body: { code: "z = 4\n" } });
    const a4 = { r: J(r4), victim: fs.readFileSync(victim, "utf8"), isLink: fs.lstatSync(file).isSymbolicLink(), body: fs.readFileSync(file, "utf8") };
    // tmp 本身被換成指向外面的 symlink:不寫
    fs.rmSync(path.join(WSd, "tmp"), { recursive: true }); fs.symlinkSync(outside, path.join(WSd, "tmp"));
    const r5 = await dl(102, { status: 200, body: { code: "w = 5\n" } });
    const a5 = { r: J(r5), wrote: fs.readdirSync(outside).join() };
    fs.rmSync(base, { recursive: true, force: true });
    ok("② 代下載:用桌面 key 打 /code、寫 workspace/tmp/library_<id>.py(0600、不留暫存檔)、回 { ok: true }", a1.r === '{"ok":true}' && a1.body === "print(1)\n" && a1.mode === 0o600 && a1.url === "https://api.test/openclaw/marketplace/strategies/102/code"
      && a1.hdr === '{"api-key":"k1","secret-key":"s1"}' && a1.stray === "library_102.py", J(a1));
    ok("② 代下載:回應帶 security → 另存 .security.json;下一次沒帶 → 刪掉舊的那份;碼寫不進去 → fail 且不留掃描結果", a2.r === '{"ok":true}' && a2.sec === 1 && a2.body === "x = 2\n" && a3.r === '{"ok":true}' && a3.secGone
      && a3b.r === '{"ok":false,"kind":"fail"}' && a3b.sec === false, J([a2, a3, a3b]));
    ok("② 代下載失敗分四種:掃描擋下 blocked、404 gone、key 被撤(403 ERR005 / 401)signin、其餘(403 未購、5xx、code 不是字串 / 空白 / 超過 1 MB、打不到、body 壞)fail;失敗不動上一份檔",
      kinds.join() === "blocked,gone,fail,signin,signin,fail,fail,fail,fail,fail,fail" && keptAfterFail === "x = 3\n", kinds.join());
    ok("② 代下載:id 不是正整數 → fail;登入了卻沒有桌面 key(或沒登入)→ signin;都不送請求", badIds.every((k) => k === "fail") && noTok.kind === "signin" && noKey.kind === "signin" && noReq, J([badIds, noTok, noKey]));
    ok("② 匿名下載:沒登入 × 官方免費且不用 Blave 資料 → 打 /public_code、不帶任何憑證(只帶埋點 install_id 計安裝數)、寫檔;關掉使用事件就連 install_id 都不帶",
      A.ok === '{"ok":true}' && A.okCall === J([[anonURL(102), { "X-Install-Id": "3f2a9c1e-7b04-4d6e-9e21-5c0b8d4f1a77" }]]) && A.okBody === "anon = 1\n" && A.off === '{"ok":true}' && A.offCall === J([[anonURL(102), {}]]), J(A));
    ok("② 匿名下載:要資料 / 未標(null)/ 社群 / 付費 / 清單裡沒有 → signin,一次請求都不送", A.denied.join() === "signin,signin,signin,signin,signin" && A.deniedNoReq, J(A.denied));
    ok("② 404(gone / anonGone)回之前先作廢主行程的清單快取(之後的 libraryList 真的重打);429 / 500 不動快取", A.cacheAfterAnon404 === null && A.cacheAfterGone === null && A.cacheAfter500 === true, J([A.cacheAfterAnon404, A.cacheAfterGone, A.cacheAfter500]));
    ok("② 429(兩條都算)→ rateLimited(講「稍後」,不講「再試一次」;稽核 0.1.13 UI S5)", A.rl.join() === "rateLimited,rateLimited" && /稍後/.test(STR.zh["lib.dl.rateLimited"]) && /later/.test(STR.en["lib.dl.rateLimited"]) && !/再試一次/.test(STR.zh["lib.dl.rateLimited"]), A.rl.join());
    ok("② 匿名下載:伺服器不給(404)→ anonGone(下架或已不符合免登入,分不出來;spec-0.1.13-smallfixes #10),key 被撤改走匿名的 404 也是;/code 的 404 照舊 gone;429 rateLimited;503 / 打不到 fail", A.srv.join() === "anonGone,rateLimited,fail,fail" && A.revoked404 === "anonGone" && kinds[1] === "gone", J([A.srv, A.revoked404, kinds[1]]));
    ok("② 匿名下載:登入了但沒 key → 走匿名;key 被撤(ERR005)→ 改走匿名;被撤 × 要資料 → signin(不試匿名)", A.noKey === '{"ok":true}' && A.noKeyUrl === anonURL(102)
      && A.revoked === '{"ok":true}' && A.revokedUrls === "https://api.test/openclaw/marketplace/strategies/102/code," + anonURL(102) && A.revokedReq === "signin" && A.revokedReqCalls === 1, J(A));
    ok("② key 被撤改走匿名:第一個請求帶那把 key,第二個(匿名)只帶 install_id、被撤的 key 不跟著送", A.revokedHdr === J([{ "api-key": "k1", "secret-key": "s1" }, { "X-Install-Id": "3f2a9c1e-7b04-4d6e-9e21-5c0b8d4f1a77" }]), A.revokedHdr);
    ok("② 開發版 / e2e(非打包、沒設 BLAVE_TELEMETRY=1)不帶 install_id,匿名照樣下載(不灌正式安裝數)", A.dev === '{"ok":true}' && A.devCall === J([[anonURL(102), {}]]), J([A.dev, A.devCall]));
    ok("② install_id 的閘跟 tm 的 post 同一支 telemetryLive(打包版或 BLAVE_TELEMETRY=1)", /^const telemetryLive = \(\) => app\.isPackaged \|\| process\.env\.BLAVE_TELEMETRY === "1";$/m.test(mainSrc)
      && /post: \(u, b\) => \(telemetryLive\(\) \? postJSON\(u, b\) : Promise\.resolve\(\)\)/.test(mainSrc));
    ok("② 有能用的 key:只打 /code,不碰匿名那條", A.withKey === '{"ok":true}' && A.withKeyUrls === "https://api.test/openclaw/marketplace/strategies/102/code", A.withKeyUrls);
    ok("② 代下載:workspace 還沒有新契約(錨點不在 / 檔不在)→ { ok: true, legacy: true }、不送請求、不動 tmp", legacy.a === '{"ok":true,"legacy":true}' && legacy.b === legacy.a && legacy.c === '{"ok":false,"kind":"fail"}' && legacy.d === '{"ok":false,"kind":"signin"}' && legacy.noReq && legacy.kept === "x = 3\n", J(legacy));
    ok("② 代下載:同名檔是指向 workspace 外的 symlink → 換掉 symlink 本身,外面的檔不變", a4.r === '{"ok":true}' && a4.victim === "keep" && !a4.isLink && a4.body === "z = 4\n", J(a4));
    ok("② 代下載:tmp 是指向 workspace 外的 symlink → fail、外面什麼都沒寫", a5.r === '{"ok":false,"kind":"fail"}' && a5.wrote === "victim.txt", J(a5));
  })());
  ok("② libraryList:登入才帶桌面資料 key、key 被拒(403)退成匿名、非 200 → null、快取看語言 + 身分、閘門用的 dataAccess 走 hasBlaveData 那一份",
    /const key = signedIn \? loadDataKey\(\) : null;/.test(cutFn(mainSrc, "libraryList")) && /if \(key && r\.status === 403\) r = await getJSON\(url, \{\}\);/.test(cutFn(mainSrc, "libraryList")) && /if \(r\.status !== 200\) return null;/.test(cutFn(mainSrc, "libraryList"))
    && /libCache\.lang === lang && libCache\.signedIn === signedIn/.test(cutFn(mainSrc, "libraryList")) && /await hasBlaveData\(\); dataAccess = /.test(cutFn(mainSrc, "libraryList")));
  ok("② libraryPurchase:帳號 token + app_secret 都在 body、沒 token / 沒 secret 各回 401 代號、打不到 { status: 0, body: null }、回應只留幾欄、之後作廢清單快取",
    /postJSON\(`\$\{API_BASE\}\/oauth\/desktop\/marketplace\/purchase`, \{ token, app_secret: secret, strategy_id: strategyId, confirm_topup: confirmTopup === true \}\)/.test(cutFn(mainSrc, "libraryPurchase"))
    && /if \(!token\) return \{ status: 401/.test(cutFn(mainSrc, "libraryPurchase")) && /if \(!secret\) return \{ status: 401/.test(cutFn(mainSrc, "libraryPurchase")) && /catch \(_\) \{ return \{ status: 0, body: null \}; \}/.test(cutFn(mainSrc, "libraryPurchase"))
    && /libCache = null;/.test(cutFn(mainSrc, "libraryPurchase")) && /return \{ status: r\.status, body: libPurchaseBody\(r\.body\) \};/.test(cutFn(mainSrc, "libraryPurchase")));
  { const lr = cutFn(mainSrc, "libraryReport");
    ok("② libraryReport:id 要正整數、打 /strategies/<id>/report?lang=、登入才帶桌面資料 key、403 退匿名、非 200 / 打不到 / 形狀不對 → null、快取 5 分鐘 per id:lang", /if \(!Number\.isInteger\(id\) \|\| id <= 0\) return null;/.test(lr) && /\/openclaw\/marketplace\/strategies\/\$\{id\}\/report\?lang=\$\{lang\}/.test(lr)
      && /const key = loadToken\(\) \? loadDataKey\(\) : null;/.test(lr) && /if \(key && r\.status === 403\) r = await getJSON\(url, \{\}\);/.test(lr) && /catch \(_\) \{ return null; \}/.test(lr) && /if \(r\.status !== 200\) return null;/.test(lr)
      && /const report = libReportSanitize\(r\.body\);\s*if \(!report\) return null;/.test(lr) && /ck = `\$\{id\}:\$\{lang\}`/.test(lr) && /Date\.now\(\) - hit\.at < ACCT_FRESH_MS/.test(lr)); }

  // ── ⑤ 成功筆記 ──
  { const FX = JSON.parse(read(path.join(__dirname, "fixtures", "success_notes.json")));
    const N = (ids, titles) => S({ success_note_ids: ids, success_note_titles: titles });
    ok("⑤ 入口:只認這一語言的正整數 id、不拿另一語言頂;標題空白 / 非字串 → null", P.libNoteId(N({ zh: 116, en: 117 }), "zh") === 116 && P.libNoteId(N({ zh: 116 }), "en") === null && P.libNoteId(N({ zh: "116" }), "zh") === null
      && P.libNoteId(N({ zh: 0 }), "zh") === null && P.libNoteId(N(null), "zh") === null && P.libNoteId(null, "zh") === null && P.libNoteTitle(N(null, { zh: " T " }), "zh") === "T" && P.libNoteTitle(N(null, { zh: "  " }), "zh") === null
      && P.libNoteTitle(N(null, { en: "E" }), "zh") === null && P.libNoteTitle(N(null, { zh: 5 }), "zh") === null);
    const sn = M.libSanitize({ strategies: [S({ id: 125, success_note_ids: { zh: 116, en: 117, ja: 9 }, success_note_titles: { zh: "a\u0000b\nc", en: "t".repeat(300), ja: "x" } }),
      S({ id: 126, success_note_ids: { zh: "116", en: -1 }, success_note_titles: { zh: "  " } }), S({ id: 127, success_note_ids: [116], success_note_titles: "x" }), S({ id: 128, success_note_ids: { zh: true, en: 1.5 } })] });
    ok("⑤ libSanitize 收兩欄:只留 zh / en、id 正整數、標題去控制字元截 200;壞值丟、整欄壞 / 不是物件 → null", JSON.stringify(sn[0].success_note_ids) === '{"zh":116,"en":117}' && sn[0].success_note_titles.zh === "a b c" && sn[0].success_note_titles.en.length === 200 && !("ja" in sn[0].success_note_titles)
      && sn[1].success_note_ids === null && sn[1].success_note_titles === null && sn[2].success_note_ids === null && sn[2].success_note_titles === null && sn[3].success_note_ids === null, JSON.stringify(sn));
    const nz = M.libNoteSanitize(FX.zh.body || FX.zh, 116), ne = M.libNoteSanitize(FX.en, 117);
    ok("⑤ libNoteSanitize(錄好的 116 / 117):只回 id / title / html / date 四欄(images、tags、author、price 不帶);日期取 UTC 年月日", JSON.stringify(Object.keys(nz)) === '["id","title","html","date"]' && nz.id === 116 && nz.date === "2026-10-01" && ne.date === "2026-10-01"
      && nz.title === FX.zh.note.title && nz.html === FX.zh.note.content && ne.title.startsWith("TXF Long-Only"), JSON.stringify(nz && { t: nz.title, d: nz.date }));
    ok("⑤ libNoteSanitize 讀不到:付費筆記(success:false、空 content)/ 不存在 / 空白內文 / 形狀不對 → null;title 去控制字元、html 截 50000;日期壞 → null",
      M.libNoteSanitize({ success: false, error: "Note is locked", note: { content: "", title: "x" } }, 1) === null && M.libNoteSanitize({ success: false, error: "Note not found" }, 1) === null && M.libNoteSanitize({ success: true, note: { content: "  " } }, 1) === null
      && M.libNoteSanitize({ success: true, note: { content: 5 } }, 1) === null && M.libNoteSanitize(null, 1) === null && M.libNoteSanitize({ success: "true", note: { content: "x" } }, 1) === null
      && M.libNoteSanitize({ success: true, note: { content: "y".repeat(60000), title: "a\tb", created_at: "nope" } }, 1).html.length === 50000 && M.libNoteSanitize({ success: true, note: { content: "x", title: "a\tb" } }, 1).title === "a b"
      && M.libNoteSanitize({ success: true, note: { content: "x", created_at: "nope" } }, 1).date === null && M.libNoteSanitize({ success: true, note: { content: "x", created_at: "Wed, 30 Sep 2026 23:59:59 GMT" } }, 1).date === "2026-09-30");
    const ln = cutFn(mainSrc, "libraryNote");
    ok("⑤ libraryNote:id 要正整數、打 /studio/success_notes/read_note?note_id=、匿名(headers 是空物件,不帶桌面資料 key / cookie)、200 與 201 都收、打不到 null、成功才進 30 分鐘快取;IPC library-note 經 handle()",
      /if \(!Number\.isInteger\(id\) \|\| id <= 0\) return null;/.test(ln) && /getJSON\(`\$\{API_BASE\}\/studio\/success_notes\/read_note\?note_id=\$\{id\}`, \{\}\)/.test(ln) && !/loadDataKey|loadToken|api-key|cookie/i.test(ln)
      && /if \(r\.status !== 200 && r\.status !== 201\) return null;/.test(ln) && /catch \(_\) \{ return null; \}/.test(ln) && /if \(!note\) return null;\s*libNoteCache\.set\(id/.test(ln) && /LIB_NOTE_TTL_MS = 30 \* 60 \* 1000/.test(mainSrc)
      && /handle\("library-note", \(_e, id\) => libraryNote\(id\), null\);/.test(mainSrc) && /libraryNote: \(id\) => ipcRenderer\.invoke\("library-note", id\)/.test(pre));
    // 白名單重建:@xmldom 解析(text/html)+ 假元素工廠——假元素沒有 setAttribute / innerHTML,重建時若想搬屬性就直接丟例外
    let XD = null; try { XD = require(path.join(SHELL, "node_modules", "@xmldom", "xmldom")).DOMParser; } catch (_) { XD = null; }
    if (!XD) console.log("SKIP  ⑤ 白名單重建(找不到 shell/node_modules 的 @xmldom)");
    else {
      const parse = (h) => new XD({ onError: () => {} }).parseFromString("<html><body>" + h + "</body></html>", "text/html").getElementsByTagName("body")[0];
      const mk = (tag, cls) => ({ tag, cls: cls || null, kids: [], append(...xs) { xs.forEach((x) => this.kids.push(x)); } });
      const ser = (e) => (typeof e === "string" ? e : "<" + e.tag + (e.cls ? "." + e.cls : "") + ">" + e.kids.map(ser).join("") + "</" + e.tag + ">");
      const tags = (e, acc) => { if (typeof e !== "string") { acc.add(e.tag); e.kids.forEach((k) => tags(k, acc)); } return acc; };
      const build = (h) => P.libNoteBuild(parse(h), mk), txt = (e) => (typeof e === "string" ? e : e.kids.map(txt).join(""));
      const ALLOWED = new Set(["div", "p", "h3", "ul", "ol", "li", "strong", "em", "br", "table", "tr", "th", "td"]);
      const zh = build(FX.zh.note.content), en = build(FX.en.note.content), zt = txt(zh);
      ok("⑤ 錄好的 zh 筆記:到第一個 <hr> 為止(導流段、到策略庫的連結字都沒有)、blockquote → .nt-lead、表格包 .nt-tw、標籤全在白名單", zt.includes("Supertrend 是很多看盤軟體") && zt.includes("2015–2016 年資料只有日盤") && !zt.includes("規則很簡單") && !zt.includes("到策略庫看這支")
        && zh.kids[0].cls === "nt-lead" && zh.kids.some((k) => k.cls === "nt-tw" && k.kids[0].tag === "table") && [...tags(zh, new Set())].every((x) => ALLOWED.has(x)), [...tags(zh, new Set())].join());
      ok("⑤ 錄好的 en 筆記:同樣停在 <hr> 前", txt(en).includes("Four things to know") && !txt(en).includes("Running it every hour is the work"));
      const evil = build('<p onclick="x()">a<a href="javascript:alert(1)" onmouseover="y()">連結字</a><img src="https://e/x.png" onerror="z()"><script>steal()</script><style>p{}</style>'
        + '<iframe src="https://e">i</iframe><svg><text>s</text></svg><textarea>t</textarea><noscript>n</noscript><span style="color:red">留字</span></p><h2 id="x">h2字</h2>'
        + '<table><thead><tr><th>k</th></tr></thead><tbody><tr><td>v</td></tr></tbody></table><div><hr></div><p>導流</p>');
      const es = ser(evil);
      ok("⑤ 惡意片段:a 拆成純字、img / script / style / iframe / svg / textarea / noscript 整顆丟(連內容)、未知容器留字、thead / tbody 拆掉、巢狀的 <hr> 也截斷;輸出沒有任何屬性",
        es === "<div.nt-body><p>a連結字留字</p><p>h2字</p><div.nt-tw><table><tr><th>k</th></tr><tr><td>v</td></tr></table></div></div>", es);
      ok("⑤ <hr> 藏在引言 / 表格裡也截斷(之後的整段都不畫)", ser(build("<p>a</p><blockquote>引言<hr>尾</blockquote><p>導流</p>")) === "<div.nt-body><p>a</p><div.nt-lead>引言</div></div>"
        && ser(build("<table><tr><td>1<hr></td></tr></table><p>導流</p>")) === "<div.nt-body><div.nt-tw><table><tr><td>1</td></tr></table></div></div>", ser(build("<p>a</p><blockquote>引言<hr>尾</blockquote><p>導流</p>")));
      ok("⑤ 沒有 <hr> 全部畫;頂層裸字包成 <p>;空白文字不進表格", ser(build("前言<p>x</p><table> <tr> <td>1</td> </tr> </table>")) === "<div.nt-body><p>前言</p><p>x</p><div.nt-tw><table><tr><td>1</td></tr></table></div></div>", ser(build("前言<p>x</p><table> <tr> <td>1</td> </tr> </table>")));
    }
    const pc = cutFn(src, "libPaintCta"), sy = cutFn(src, "libSync"), pn = cutFn(src, "libNoteLoad");
    ok("⑤ 回合中「點了才講」:busy 主鈕 aria-disabled + title、那一格空著也不 hidden(live region 先在樹裡)、點了叫 libBusyTell(不 libAsk / libBuyBox)、只有講過才補那句;清在 libSync 開頭(不在 libPaintCta)",
      /case "busy": \{[\s\S]*?btn\("btn-fill", c\.paid \? buyLabel\(\) : t\("lib\.use"\), \(\) => libBusyTell\(s\)\);[\s\S]*?setAttribute\("aria-disabled", "true"\); b\.title = t\("turn\.busy"\);[\s\S]*?if \(LIB\.busyTold === s\.id\) \{ note\.textContent = t\("turn\.busy"\);/.test(pc)
      && !/busyTold = null/.test(pc) && /^function libSync\(\) \{\n  if \(!\(typeof running !== "undefined" && running === true\)\) LIB\.busyTold = null;/.test(sy)
      && /libBusyTell\(s\) \{\n  LIB\.busyTold = s\.id;/.test(src) && /note\.hidden = !note\.textContent && c\.state !== "busy";/.test(pc) && /\.lib-cta \.btn-fill\[aria-disabled="true"\]/.test(read(path.join(R, "app.css"))));
    ok("⑤ 閱讀頁:內文只經 DOMParser + libNoteBuild(不 innerHTML);重試先把焦點交給 #lib-nt-title 才清掉內容(按下的鈕被拿掉不會把焦點丟到 BODY);成功才送 library_note;讀不到給 lib.note.err + lib.retry;入口卡在回測卡之後、關卡卡之前,沒有筆記不出",
      /libNoteBuild\(new DOMParser\(\)\.parseFromString\(n\.html, "text\/html"\)\.body, /.test(pn) && /libTrack\("library_note"\);\n\}$/.test(pn) && /t\("lib\.note\.err"\)/.test(pn) && /t\("lib\.retry"\)/.test(pn)
      && /b\.addEventListener\("click", \(\) => \{ h\.focus\(\); slot\.textContent = ""; libNoteLoad\(s, id\); \}\);/.test(pn) && /const h = \$\("lib-nt-title"\)/.test(pn)
      && /det\.appendChild\(c1\);\n[^\n]*\n  if \(libNoteId\(s, LANG\)\) det\.appendChild\(libNoteLink\(s\)\);\n[^\n]*\n  const gc = r && r\.gate_checks;/.test(cutFn(src, "libPaintDetail"))
      && require(path.join(SHELL, "telemetry.js")).EVENTS.feature_used.name.includes("library_note"));
    ok("⑤ 四句文案逐字(spec §2.6)", STR.zh["lib.note.k"] === "成功筆記" && STR.en["lib.note.k"] === "Success Note" && STR.zh["lib.note.fallback"] === "讀這篇筆記" && STR.en["lib.note.fallback"] === "Read the Note"
      && STR.zh["lib.note.back"] === "回到策略" && STR.en["lib.note.back"] === "Back to Strategy" && STR.zh["lib.note.err"] === "讀不到這篇筆記。" && STR.en["lib.note.err"] === "Couldn't load this note."); }

  // ── ③ 接線 ──
  ok("③ index.html:側欄「策略庫」在「自動下單」後、同一個 #side-nav 裡;歡迎頁多一顆 #chat-lib 是籤的第一顆(0.1.17 起起手籤 #chat-eg 退役,籤下面是資料清單 #wl);#lib 在 #rp 後、#main-empty 前;library.css;library.js 在 handoff.js 後(中間只許 export.js)、app.js 前",
    html.indexOf('id="lib-nav"') > html.indexOf('id="tr-nav"') && html.indexOf('id="lib-nav"') < html.indexOf("</nav>") && html.indexOf('id="chat-lib"') < html.indexOf('id="wl"') && !html.includes('id="chat-eg"') && html.indexOf('id="chat-lib"') > html.indexOf('class="wc-chips"')
    && html.indexOf('id="lib"') > html.indexOf('id="rp"') && html.indexOf('id="lib"') < html.indexOf('id="main-empty"') && /<link rel="stylesheet" href="library\.css">/.test(html) && /<script src="handoff\.js"><\/script>\s*(?:<script src="export\.js"><\/script>\s*)?<script src="library\.js"><\/script>\s*<script src="app\.js">/.test(html));
  ok("③ #lib 的骨架:region + aria-labelledby 到 h5、h5 tabindex=-1、分段 group 三顆、返回鈕、#lib-body tabindex=0、#lib-state role=status", /<div class="lib" id="lib" role="region" aria-labelledby="lib-h" hidden>/.test(html) && /<h5 class="main-head-name" id="lib-h" tabindex="-1" data-i18n="lib\.nav">/.test(html)
    && (html.slice(html.indexOf('id="lib-seg"'), html.indexOf("</div>", html.indexOf('id="lib-seg"'))).match(/data-mkt="(all|crypto|tw)"/g) || []).length === 3 && /<button class="lib-back" id="lib-back" type="button" hidden>/.test(html) && /<div class="lib-body" id="lib-body" tabindex="0">/.test(html) && /<p class="lib-state" id="lib-state" role="status" hidden>/.test(html));
  ok("③ 社群段拆了(0.1.6 §2):index.html / library.js / library.css 沒有 lib-comm、字串表沒有 lib.comm.*;清單頂端的 #lib-gate 拿掉(spec-0.1.13 §2.2:閘門卡搬進第二組),兩組的殼 #lib-grps 在 #lib-rows 之前;退役的 lib.gate.noCard / noBalance / unknown 兩語都刪了", !/lib-comm/.test(html) && !/lib-comm|\.comm\b|library_comm/.test(src) && !/lib-comm/.test(read(path.join(R, "library.css")))
    && ["lib.comm.title", "lib.comm.sub", "lib.gate.noData", "lib.gate.noCard", "lib.gate.noBalance", "lib.gate.unknown"].every((k) => !(k in STR.zh) && !(k in STR.en)) && !/lib\.gate\.(noCard|noBalance|unknown)"/.test(src)
    && !/id="lib-gate"/.test(html) && !/\$\("lib-gate"\)/.test(src) && html.indexOf('id="lib-grps"') > html.indexOf('id="lib-body"') && html.indexOf('id="lib-grps"') < html.indexOf('id="lib-rows"'));
  { const brSrc = read(path.join(R, "browser.js"));
    ok("③ 找點子入口(spec-0.1.13 §1.4 / §5.1):歡迎頁 #chat-idea 是第二顆籤(看現成策略之後、新增策略之前)、預設 hidden;頁首說明句 #lib-desc 沒有 data-i18n(由 libPaintDesc 畫,換語言才不會洗掉文字鈕)",
      html.indexOf('id="chat-idea"') > html.indexOf('id="chat-lib"') && html.indexOf('id="chat-idea"') < html.indexOf('id="chat-ns"') && /<button class="wc-chip" id="chat-idea" type="button" data-i18n="idea\.chip" hidden><\/button>/.test(html)
      && /<p class="lib-desc" id="lib-desc"><\/p>/.test(html) && !/data-i18n="lib\.desc"/.test(html));
    ok("③ 四個入口共用 libIdeaNow;開關在開機、libOpen、回前景、設定裡切內建瀏覽器時重問(libIdeaSync),切視角 / 帳號狀態變了重畫(libIdeaPaint),換引擎(enterWorkspace)重問",
      /\n  libIdeaSync\(\);\n/.test(src.slice(src.indexOf("(function libWire()"))) && /envShowMain\(\);\n\s*libIdeaSync\(\);/.test(cutFn(src, "libOpen")) && /libIdeaPaint\(\);/.test(cutFn(src, "libShowMain"))
      && /if \(typeof libIdeaSync === "function"\) libIdeaSync\(\);/.test(cutFn(appSrc, "enterWorkspace")) && /if \(typeof libIdeaPaint === "function"\) libIdeaPaint\(\);/.test(cutFn(appSrc, "acctPaint"))
      && /tvPrefs\(\); if \(typeof libIdeaSync === "function"\) libIdeaSync\(\); \}\);/.test(brSrc) && (src.match(/libIdeaNow\(\)/g) || []).length === 5 && !/libIdeaOn\(/.test(src.slice(src.indexOf("/* ── 純邏輯到此")).replace(/return libIdeaOn\(\{/, "")));
    ok("③ 頁首說明句(§2.7):找點子開著才接 idea.descLead + 文字鈕 + 句號,文字鈕與句號同一個 .nw;拿掉「官方策略免費…」", /const nw = libEl\("span", "nw"\);\s*nw\.append\(libIdeaBtn\("btn-quiet", "idea\.link", "lib_head"\), LANG === "zh" \? "\\u3002" : "\."\);/.test(cutFn(src, "libPaintDesc"))
      && STR.zh["lib.desc"] === "已驗證優先，再看樣本期長短。" && STR.en["lib.desc"] === "Verified first, then longest backtest.");
    ok("③ 找點子開關切換時重畫清單:焦點在列上 → 回同一列;在被拿掉的文字鈕上 → 交給 #lib-h(不掉到 body)", /if \(r\) r\.focus\(\); else if \(inList && !a\.isConnected\) \$\("lib-h"\)\.focus\(\);/.test(cutFn(src, "libPaintListKeep")) && /libPaintDesc\(\); libPaintList\(\);/.test(cutFn(src, "libPaintListKeep")));
  ok("③ 市場空(§2.5):找點子開著 → 描邊「請 agent 上網找點子」(lib_empty),否則描邊「新增策略」開 nsOpen;第一組空 → lib.grp.empty + 文字鈕(lib_empty)",
      /if \(libIdeaNow\(\)\) state\.appendChild\(libIdeaBtn\("btn-out", "idea\.btn", "lib_empty"\)\);/.test(cutFn(src, "libPaintList")) && /t\("ns\.chip"\)\); b\.type = "button"; b\.addEventListener\("click", \(\) => \{ if \(typeof nsOpen === "function"\) nsOpen\(b\); \}\);/.test(cutFn(src, "libPaintList"))
      && /libIdeaBtn\("btn-quiet", "idea\.link", "lib_empty"\)/.test(cutFn(src, "libPaintList"))); }
  ok("③ 不導流:沒有 #lib-web、library.js 不 openExternal / 不寫 blave.org、lib.web / lib.hiddenNote 兩語都刪了;lib.* 沒有任何一句提到網頁版(投稿腳注 lib.foot 也刪了)", !/lib-web|lib\.web/.test(html) && !/openExternal|blave\.org/.test(src) && ["lib.web", "lib.hiddenNote"].every((k) => !(k in STR.zh) && !(k in STR.en))
    && Object.keys(STR.zh).filter((k) => k.startsWith("lib.") && /網頁/.test(STR.zh[k])).join() === "" && Object.keys(STR.en).filter((k) => k.startsWith("lib.") && /\bweb\b/i.test(STR.en[k])).join() === "");
  { const esm = cutFn(trSrc, "envShowMain");
    ok("③ envShowMain:雲端分支帶 gate 問 libShowMain 再問 rptShowMain、本機分支問 libShowMain(false) 再 rptShowMain(false);原本被別支測試釘住的那幾行一字不動", /if \(typeof libShowMain === "function"\) libShowMain\(gate\);\s*\/\/[^\n]*\n\s*if \(typeof rptShowMain === "function"\) rptShowMain\(gate\);[^\n]*\n\s*return;/.test(esm) && /libShowMain\(false\);\n  if \(typeof rptShowMain === "function"\) rptShowMain\(false\);\n\}$/.test(esm)
      && /const gate = !\$\("cv-empty"\)\.hidden, rp = !gate && typeof RPC !== "undefined" && !!\(RPC\.name && RPC\.data\);/.test(esm) && /\$\("rp"\)\.hidden = !rp; \$\("main-empty"\)\.hidden = true; \$\("tr"\)\.hidden = gate \|\| rp;/.test(esm)); }
  ok("③ 開別的視圖就 libLeave:trOpen(那一邊)、stratSelect(本機,選了才)、rpCloudSelect(雲端,選了才)", /if \(typeof libLeave === "function"\) libLeave\(S\.env\);/.test(cutFn(trSrc, "trOpen"))
    && /if \(name && typeof libLeave === "function"\) libLeave\("local"\);/.test(cutFn(appSrc, "stratSelect")) && /if \(name && typeof libLeave === "function"\) libLeave\("cloud"\);/.test(cutFn(appSrc, "rpCloudSelect")));
  ok("③ 回合的三個出口(上鎖、失敗解鎖、turn-end)都叫 libSync;turn-end 等 stratRefresh(true) 回來才 libTurnEnd;trPoll 每次讀到雲端清單都叫 libCloudChanged(緊接 rpCloudPrune)", (appSrc.match(/if \(typeof libSync === "function"\) libSync\(\);/g) || []).length === 3
    && /stratRefresh\(true\)\.catch\(\(\) => \{\}\)\.then\(\(\) => \{ if \(typeof libTurnEnd === "function"\) libTurnEnd\(\);/.test(appSrc.slice(appSrc.indexOf("window.blave.onTurnEnd(")))
    && /rpCloudPrune\(C\.list\);[^\n]*\n\s*if \(typeof libCloudChanged === "function"\) libCloudChanged\(C\.list\);/.test(cutFn(trSrc, "trPoll")));
  ok("③ 已購:鈕下不寫說明句(lib.note.owned 連字串一起拿掉);未購的付費策略照舊 lib.note.paid", !/lib\.note\.owned/.test(src) && !("lib.note.owned" in STR.zh) && !("lib.note.owned" in STR.en) && /case "owned": [^\n]*libAsk\(s, b\)\)\); if \(c\.pub\) note\.textContent = t\("lib\.pub"\); break;/.test(src) && STR.zh["lib.note.paid"] === "從 Blave Agent 餘額扣款。");
  ok("③ 已安裝:頁首只有「打開這支策略」+「再下載一份」、鈕下不寫說明句(lib.note.installed 連字串一起拿掉,覆蓋說明搬進確認框)", !/lib\.note\.installed/.test(src) && !("lib.note.installed" in STR.zh) && !("lib.note.installed" in STR.en)
    && /case "installed":\n\s*row\.append\(btn\("btn-fill", t\("lib\.open"\)[^\n]*btn\("btn-quiet", t\("lib\.again"\), \(b\) => libAsk\(s, b\)\)\);\n\s*break;/.test(src));
  { const css = read(path.join(R, "library.css")), at = css.indexOf("@container (min-width: 640px)"), wide = css.slice(at, css.indexOf("\n}", at));
    ok("③ 寬版 @container 寫在基礎 .lib-cta 之後(權重一樣、後寫的贏;寫在前面 flex-end 永遠被 flex-start 蓋掉)", at > css.indexOf(".lib-cta { display: flex;") && at > css.indexOf(".lib-cta .err {") && css.indexOf(".lib-cta { display: flex;") >= 0);
    ok("③ 寬版頁首:.lib-cta 靠右(flex-end、280px)但不 text-align: right;說明句 / 錯誤行撐滿、靠左", /\.lib-cta \{ align-items: flex-end; max-width: 280px; \}/.test(wide) && !/text-align: right/.test(wide) && /\.lib-cta \.note, \.lib-cta \.err \{ align-self: stretch; text-align: left; \}/.test(wide)); }
  ok("③ 快取作廢的四個事件都接了:登出 / 五條登入路徑(設定兩條、連結畫面兩條、重新登入一條) → libInvalidate;設定關掉 → libRefresh;主行程登出(clearToken)、換 token、下載 404 都清 libCache;購買成功後 libRefresh", (appSrc.match(/if \(typeof libInvalidate === "function"\) libInvalidate\(\);/g) || []).length === 6
    && /if \(typeof libRefresh === "function"\) libRefresh\(\);/.test(cutFn(appSrc, "setClose")) && /libCache = null;/.test(cutFn(mainSrc, "clearToken")) && (mainSrc.match(/^\s*libCache = null;/gm) || []).length === 4
    && /libSend\(s\); libRefresh\(\); return;/.test(src) && /function libRepaint\(\) \{ if \(\$\("lib"\)\.hidden\) return; LIB\.reports\.clear\(\); libPaint\(\); if \(LIB\.data && LIB\.data\.lang !== LANG\) libLoad\(false\); \}/.test(src) && /window\.addEventListener\("focus", \(\) => \{ libRefresh\(\); libIdeaSync\(\); \}\);/.test(src));
  ok("③ 每次進視圖都重問主行程;切視角時畫的是這一邊那袋;pending 記的是 name → mtime 的 Map", /envShowMain\(\);\n\s*libIdeaSync\(\);\n\s*libLoad\(false\);/.test(src) && /if \(on && \(!was \|\| LIB\.paintedEnv !== libEnv\(\)\)\) \{ libPaint\(\); if \(was\) libLoad\(false\); \}/.test(src)
    && /cl = env === "cloud" \? libCloudList\(\) : RP\.list, before = cl \? new Map\(cl\.map\(\(x\) => \[x\.name, x\.mtime\]\)\) : null;/.test(src) && /p\.before\.get\(x\.name\) !== x\.mtime/.test(src) && !/libShort/.test(src)
    && /const libCloudOk = \(\) => !!\(TR_BAGS\.cloud\.st && TR_BAGS\.cloud\.st\.cloud && TR_BAGS\.cloud\.st\.cloud\.strategies_ok === true\);/.test(src) && /function libInvalidate\(\) \{ LIB\.stale = true; LIB\.dlFail = null; LIB\.cloudInstalled = \{\}; LIB\.cloudWait = null; LIB\.cloudNames = null; libRefresh\(\); \}/.test(src));
  ok("③ applyStatic 換語言重畫;stratRefresh 重建列後 libStratChanged;delClose 認 dataset.lock(購買中 Esc / ✕ / 框外都不關)", /if \(typeof libRepaint === "function"\) libRepaint\(\);/.test(cutFn(appSrc, "applyStatic"))
    && /if \(typeof libStratChanged === "function"\) libStratChanged\(\);/.test(cutFn(appSrc, "stratRefresh")) && /if \(sc\.hidden \|\| sc\.dataset\.lock\) return;/.test(cutFn(appSrc, "delClose")));
  { const anchor = mainSrc.match(/^const LIB_CONTRACT_ANCHOR = "([^"]+)";$/m);
    ok("③ 外殼認的契約錨點就是 references/marketplace.md 裡那一節的標題(改了其中一邊這裡就紅)", !!anchor && read(path.join(__dirname, "..", "references", "marketplace.md")).split("\n").includes(anchor[1]), anchor && anchor[1]); }
  ok("③ 代下載的 IPC:preload libraryDownload、main 走 handle()(只收自家頁面,拒絕回 fail)", /libraryDownload: \(id\) => ipcRenderer\.invoke\("library-download", id\)/.test(pre)
    && /handle\("library-download", \(_e, id\) => libraryDownload\(id\), \{ ok: false, kind: "fail" \}\);/.test(mainSrc));
  ok("③ preload 四支;main:清單、報告與已安裝走 handle()(只收自家頁面)、購買用 ipcMain.handle + fromOurPage、拒絕回打不到的形狀", /libraryList: \(lang, force\) => ipcRenderer\.invoke\("library-list", lang, force\)/.test(pre) && /libraryReport: \(id, lang\) => ipcRenderer\.invoke\("library-report", id, lang\)/.test(pre) && /libraryPurchase: \(id, confirmTopup\) => ipcRenderer\.invoke\("library-purchase", id, confirmTopup\)/.test(pre) && /libraryInstalled: \(patch\) => ipcRenderer\.invoke\("library-installed", patch\)/.test(pre)
    && /handle\("library-list", \(_e, lang, force\) => libraryList\(lang, force === true\), null\);/.test(mainSrc) && /handle\("library-report", \(_e, id, lang\) => libraryReport\(id, lang\), null\);/.test(mainSrc) && /ipcMain\.handle\("library-purchase", \(e, id, confirmTopup\) => \(fromOurPage\(e\) \? libraryPurchase\(id, confirmTopup\) : \{ status: 0, body: null \}\)\);/.test(mainSrc) && /handle\("library-installed", \(_e, patch\) => libraryInstalled\(patch\), \{\}\);/.test(mainSrc));
  ok("③ library.js 只走 textContent / DOM,沒有 innerHTML;埋點只在 trackFeature 存在時叫(library_open / library_use 在 telemetry.js 白名單;library_comm 沒送出點了,白名單留給 0.1.5 舊外殼);不寫 localStorage", !/innerHTML/.test(src) && /libTrack\("library_open"\)/.test(src) && /libTrack\("library_use"\)/.test(src) && /typeof window\.blave\.trackFeature === "function"/.test(src) && !/Storage/.test(src)
    && ["library_open", "library_use", "library_comm"].every((n) => require(path.join(SHELL, "telemetry.js")).EVENTS.feature_used.name.includes(n)) && !/library_comm/.test(src));
  { const keys = [...new Set([...src.matchAll(/\bt\("(lib\.[^"]+)"/g)].map((m) => m[1]).concat([...html.matchAll(/data-i18n(?:-aria)?="(lib\.[^"]+)"/g)].map((m) => m[1])))];
    const missing = keys.filter((k) => !(k in STR.zh) || !(k in STR.en));
    ok("③ 用到的 " + keys.length + " 個 lib.* key zh / en 都齊;lib.fxRate zh 1 / en 30、幣別 TWD / USD", missing.length === 0 && STR.zh["lib.fxRate"] === "1" && STR.en["lib.fxRate"] === "30" && STR.zh["lib.currency"] === "TWD" && STR.en["lib.currency"] === "USD", missing);
    ok("③ zh 全形標點:lib.* 的 zh 字串沒有半形逗號 / 句號 / 問號 / 冒號接在漢字後", Object.keys(STR.zh).filter((k) => k.startsWith("lib.")).every((k) => !/[一-鿿][,.?:;!]/.test(STR.zh[k])), Object.keys(STR.zh).filter((k) => k.startsWith("lib.") && /[一-鿿][,.?:;!]/.test(STR.zh[k]))); }
  ok("③ 曲線:頂端軸標不裁(entireTextOnly + scaleMargins)、軸標去尾零(1× / 1.5× / 2× / 4×)", /entireTextOnly: true, scaleMargins: \{ top: 0\.08, bottom: 0\.06 \}/.test(src) && /priceFormatter: \(v\) => \+v\.toFixed\(v >= 10 \? 0 : v >= 2 \? 1 : 2\) \+ "×"/.test(src)
    && [[1, "1×"], [1.5, "1.5×"], [2, "2×"], [4, "4×"], [12.4, "12×"], [1.25, "1.25×"]].every(([v, s]) => +v.toFixed(v >= 10 ? 0 : v >= 2 ? 1 : 2) + "×" === s));
  ok("③ tokens.css 多綠 tag 那一對(亮暗各一組);library.css 只引變數、沒有 hex", (read(path.join(R, "tokens.css")).match(/--color-greenLight:/g) || []).length === 2 && (read(path.join(R, "tokens.css")).match(/--color-greenBlack:/g) || []).length === 2 && !/#[0-9a-fA-F]{3,6}\b/.test(read(path.join(R, "library.css"))));

  // ── ⑥ 本機「用這支」的流程(spec-0.1.13 §4;不起 Electron:libAsk / libSend / libTurnEnd 切出來,四周全是替身)──
  ASYNC.push((async () => {
    const F = { STR: STR.zh, calls: { dl: [], sent: [], track: [], inval: 0, box: [], opts: [], events: [], inst: [] }, dlNext: null, subOk: true, env: "local", settle: false };
    vm.createContext(F);
    vm.runInContext(block.replace(/^const /gm, "var ") + `
      var LIB = { pending: null, noNew: null, dlFail: null, data: { dataAccess: "billed" }, installed: {} }, running = false, csTitle = "", RP = { list: [{ name: "old", mtime: 1 }] }, paneSt = { chat: { off: false } };
      var t = (k, p) => STR[k].replace(/[{]([a-z]+)[}]/g, (m, n) => (p && n in p ? p[n] : m)), libEnv = () => env, ctaState = "free", libCtaOf = () => ({ state: ctaState }), libWhere = () => STR["lib.where." + (env === "cloud" ? "cloud" : "local")], envCanSwitch = () => true, paneToggle = () => {}, csStartNew = () => {}, libSync = () => {}, libCtaMain = () => null, libCloudList = () => [];
      var libTrack = (n) => calls.track.push(n), libBlocked = () => {}, libInvalidate = () => { calls.inval++; LIB.dlFail = null; }, $ = () => ({ title: "", textContent: "" });
      var confirmBox = (o) => calls.box.push(o), submitMessage = async (m, o) => { calls.sent.push(m); calls.opts.push(o); return subOk; };
      var chatViewing = () => ({ env: env === "cloud" ? "cloud" : "local", strategy: "seen" });
      var window = { blave: { libraryDownload: (id) => { calls.dl.push(id); return new Promise((res, rej) => { dlNext = { res, rej }; }); }, trackEvent: (e, p) => calls.events.push(e + ":" + JSON.stringify(p)) } };
      var libInstalledSet = (id, n) => calls.inst.push(id + "=" + n), libCloudSettle = () => settle, libCloudRepaintList = () => {}, LIB_CLOUD_WAIT_MS = 1000;
      ` + cutFn(src, "libDlKey") + "\n" + cutFn(src, "libAsk") + "\nasync " + cutFn(src, "libSend") + "\n" + cutFn(src, "libTurnEnd"), F);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const s101 = { id: 101, title: "BTC 通道動能共振", price: 0, blave_data: "none" }, s72 = { id: 72, title: "DOGE 籌碼集中度", price: 0, blave_data: "required" }, s9 = { id: 9, title: "已買", price: 900, purchased: true };
    // A. 成功:下載中是 pending/dl、擋重入;下載完才送 lib.msgLocal
    F.libSend(s101); await tick();
    const dl = { stage: F.LIB.pending && F.LIB.pending.stage, id: F.LIB.pending && F.LIB.pending.id, sent: F.calls.sent.length };
    F.libSend(s72); F.libAsk(s72); F.libTurnEnd(); await tick();
    const reent = { dls: F.calls.dl.join(), box: F.calls.box.length, still: F.LIB.pending && F.LIB.pending.id, noNew: F.LIB.noNew };
    F.dlNext.res({ ok: true }); await tick(); await tick();
    const done = { sent: F.calls.sent.join("|"), pending: F.LIB.pending && [F.LIB.pending.id, F.LIB.pending.stage === undefined, F.LIB.pending.env].join(), track: F.calls.track.join() };
    ok("⑥ 本機用這支:先代下載(pending=101、stage=dl、還沒送訊息)", dl.stage === "dl" && dl.id === 101 && dl.sent === 0, JSON.stringify(dl));
    ok("⑥ 下載中擋重入:切到另一支 libSend / libAsk 都不動(只有一次下載、不開確認框);期間結束的別的回合不算這支的", reent.dls === "101" && reent.box === 0 && reent.still === 101 && reent.noNew === null, JSON.stringify(reent));
    ok("⑥ 下載成功才送 lib.msgLocal(逐字)→ 進行中、library_use", done.sent === "策略庫的「BTC 通道動能共振」（#101）已經下載好了，幫我安裝並跑一次回測看看結果" && done.pending === "101,true,local" && done.track === "library_use", JSON.stringify(done));
    ok("⑥ 回合跑起來才送 lib_pick,data = 這支的資料需求(spec-0.1.13 §8);下載中不送", dl.sent === 0 && F.calls.events.join() === 'lib_pick:{"data":"none"}', F.calls.events.join());
    F.calls.events.length = 0;
    // B. 失敗三種:不送訊息、pending 清掉、dlFail 記 kind;gone 重拉清單、dlFail 留著
    const fails = [];
    for (const [resp, rej] of [[{ ok: false, kind: "blocked" }], [{ ok: false, kind: "gone" }], [{ ok: false, kind: "anonGone" }], [{ ok: false, kind: "signin" }], [{ ok: false, kind: "rateLimited" }], [{ ok: false, kind: "fail" }], [{ ok: false, kind: "weird" }], [null], [undefined, true]]) {
      F.LIB.pending = null; F.calls.sent.length = 0; const inval0 = F.calls.inval;
      F.libSend(s72); await tick(); if (rej) F.dlNext.rej(new Error("ipc")); else F.dlNext.res(resp); await tick(); await tick();
      fails.push([F.LIB.dlFail && F.LIB.dlFail.id, F.LIB.dlFail && F.LIB.dlFail.kind, F.LIB.pending, F.calls.sent.length, F.calls.inval - inval0].join("/"));
    }
    ok("⑥ 下載失敗:blocked / gone / anonGone / fail(認不得的 kind、null、IPC 丟例外都算 fail);不送訊息、pending 清掉;gone 與 anonGone 重拉清單、dlFail 留著", fails.join() === "72/blocked//0/0,72/gone//0/1,72/anonGone//0/1,72/signin//0/0,72/rateLimited//0/0,72/fail//0/0,72/fail//0/0,72/fail//0/0,72/fail//0/0", fails.join());
    ok("⑥ 下載失敗不送 lib_pick / library_use", F.calls.events.length === 0 && !F.calls.track.slice(1).includes("library_use"), JSON.stringify([F.calls.events, F.calls.track]));
    ok("⑥ 下載沒成的那句:kind → 字串 key,六種都有 zh / en,認不得的當 fail;anonGone 只講登入、不提卡", ["blocked", "gone", "anonGone", "signin", "rateLimited", "unsent", "fail"].every((k) => P.libDlKey(k) === "lib.dl." + k && STR.zh["lib.dl." + k] && STR.en["lib.dl." + k]) && !/卡|card/i.test(STR.zh["lib.dl.anonGone"] + STR.en["lib.dl.anonGone"]) && P.libDlKey("weird") === "lib.dl.fail" && P.libDlKey(undefined) === "lib.dl.fail");
    F.libSend(s72); await tick();
    ok("⑥ 再按一次:那句錯誤清掉", F.LIB.dlFail === null && F.LIB.pending && F.LIB.pending.stage === "dl"); F.dlNext.res({ ok: true }); await tick(); await tick();
    // C. 下載好了但訊息送不出去(下載中用戶自己先送了一句,回合在跑):pending 清掉,而且講出來
    F.LIB.pending = null; F.LIB.dlFail = null; F.subOk = false; F.libSend(s9); await tick(); F.dlNext.res({ ok: true }); await tick(); await tick();
    ok("⑥ 送不出去(unsent)不送 lib_pick;再下載成功的那一次(#72 要資料)送 lib_pick{required}", F.calls.events.join() === 'lib_pick:{"data":"required"}', F.calls.events.join());
    F.calls.events.length = 0;
    ok("⑥ 付費已購的本機也送 lib.msgLocal;送不出去 → pending 清掉、dlFail = unsent(不靜默)", F.calls.sent[F.calls.sent.length - 1] === "策略庫的「已買」（#9）已經下載好了，幫我安裝並跑一次回測看看結果" && F.LIB.pending === null
      && F.LIB.dlFail && F.LIB.dlFail.id === 9 && F.LIB.dlFail.kind === "unsent", JSON.stringify(F.LIB.dlFail));
    F.subOk = true; F.LIB.dlFail = null;
    // P2-3:下載中切到雲端視角 → 這句仍釘在本機(viewing 在按下去那一刻定案)
    F.libSend(s101); await tick(); F.env = "cloud"; F.dlNext.res({ ok: true }); await tick(); await tick();
    const pin = F.calls.opts[F.calls.opts.length - 1];
    ok("⑥ 下載那一兩秒切到雲端視角:lib.msgLocal 仍帶 viewing.env=local(按下去那一刻的),不會送給雲端主機", pin && pin.viewing && pin.viewing.env === "local" && pin.viewing.strategy === "seen"
      && F.calls.sent[F.calls.sent.length - 1].startsWith("策略庫的「BTC 通道動能共振」"), JSON.stringify(pin));
    F.env = "local"; F.LIB.pending = null;
    // P1-2:workspace 還是舊契約 → 送舊句(官方 lib.msg、已購 lib.msgPaid)
    F.libSend(s101); await tick(); F.dlNext.res({ ok: true, legacy: true }); await tick(); await tick(); const lg1 = F.calls.sent[F.calls.sent.length - 1]; F.LIB.pending = null;
    F.libSend(s9); await tick(); F.dlNext.res({ ok: true, legacy: true }); await tick(); await tick(); const lg2 = F.calls.sent[F.calls.sent.length - 1]; F.LIB.pending = null;
    ok("⑥ 本機舊契約那條也是回合跑起來:lib_pick 照送(#101 none、#9 未標 → unknown)", F.calls.events.slice(-2).join() === 'lib_pick:{"data":"none"},lib_pick:{"data":"unknown"}', F.calls.events.join());
    F.calls.events.length = 0;
    ok("⑥ workspace 還沒有新契約(legacy)→ 退回舊句 lib.msg / lib.msgPaid", lg1 === "幫我下載官方策略「BTC 通道動能共振」（#101），跑一次回測看看結果" && lg2 === "幫我下載已購買的策略「已買」（#9），跑一次回測看看結果", JSON.stringify([lg1, lg2]));
    // D. 雲端:不代下載,照舊 lib.msg / lib.msgPaid
    F.subOk = true; F.env = "cloud"; const n0 = F.calls.dl.length;
    F.libSend(s101); await tick(); const c1 = F.calls.sent[F.calls.sent.length - 1]; F.LIB.pending = null;
    F.libSend(s9); await tick(); const c2 = F.calls.sent[F.calls.sent.length - 1]; F.LIB.pending = null;
    ok("⑥ 雲端不送 lib_pick(雲端沒有資料牆)", F.calls.events.length === 0, F.calls.events.join());
    // F. 回合結束(spec-0.1.13 §8):本機多了一支 → lib_installed;沒多 → library_no_new;雲端認到 → lib_installed,還沒跟上 → 不送
    F.env = "local"; F.calls.track.length = 0; F.RP.list = [{ name: "old", mtime: 1 }, { name: "new1", mtime: 3 }];
    F.LIB.pending = { id: 101, env: "local", before: new Map([["old", 1]]) }; F.libTurnEnd(); const te1 = F.calls.track.join() + "/" + F.calls.inst.join();
    F.LIB.pending = { id: 72, env: "local", before: new Map([["old", 1], ["new1", 3]]) }; F.libTurnEnd(); const te2 = F.calls.track.join() + "/" + F.LIB.noNew;
    F.calls.track.length = 0; F.settle = true; F.LIB.pending = { id: 9, env: "cloud", before: new Map() }; F.libTurnEnd(); const te3 = F.calls.track.join();
    F.calls.track.length = 0; F.settle = false; F.LIB.pending = { id: 9, env: "cloud", before: new Map() }; F.libTurnEnd(); const te4 = F.calls.track.join() + "/" + !!F.LIB.cloudWait;
    F.LIB.pending = { id: 9, env: "local", before: new Map(), stage: "dl" }; F.calls.track.length = 0; F.libTurnEnd(); const te5 = F.calls.track.join() + "/" + (F.LIB.pending && F.LIB.pending.id);
    F.LIB.pending = null; F.LIB.cloudWait = null; F.RP.list = [{ name: "old", mtime: 1 }];
    ok("⑥ 回合結束的埋點:本機新的一支 → lib_installed(記對照表)、沒新的 → library_no_new;雲端認到 → lib_installed、清單還沒跟上 → 不送(掛著等);代下載中結束的別的回合不送",
      te1 === "lib_installed/101=new1" && te2 === "lib_installed,library_no_new/72" && te3 === "lib_installed" && te4 === "/true" && te5 === "/9", JSON.stringify([te1, te2, te3, te4, te5]));
    ok("⑥ 雲端清單晚到、libCloudChanged 那邊認到也送 lib_installed", /if \(libCloudSettle\(w, list\)\) \{ LIB\.cloudWait = null; changed = true; libTrack\("lib_installed"\); libSync\(\); \}/.test(cutFn(src, "libCloudChanged")));
    ok("⑥ 雲端視角不代下載(外殼寫不進雲端主機),照舊送 lib.msg / lib.msgPaid", F.calls.dl.length === n0 && c1 === "幫我下載官方策略「BTC 通道動能共振」（#101），跑一次回測看看結果" && c2 === "幫我下載已購買的策略「已買」（#9），跑一次回測看看結果", JSON.stringify([c1, c2]));
    // E. 確認框:本機用 l1Local;資料費那一行只在 billed × 不是 none
    const lines = () => F.calls.box[F.calls.box.length - 1].lines.join("|");
    F.env = "local"; F.libAsk(s72); const L72 = lines(); F.libAsk(s101); const L101 = lines(); F.libAsk({ id: 5, title: "x", price: 0 }); const Lnull = lines();
    F.env = "cloud"; F.libAsk(s72); const Lcloud = lines(); F.env = "local";
    const z = STR.zh;
    ok("⑥ 確認框:本機第一段是 lib.cf.l1Local;billed 時 required / 未標出資料費那一行、none 不出;雲端用 lib.cf.l1、不出資料費", L72 === [z["lib.cf.l1Local"], z["lib.cf.l2"], z["lib.note.billed"]].join("|") && L101 === [z["lib.cf.l1Local"], z["lib.cf.l2"]].join("|")
      && Lnull === L72 && Lcloud === [z["lib.cf.l1"], z["lib.cf.l2"]].join("|"), JSON.stringify([L72, L101, Lnull, Lcloud]));
    { const box = () => F.calls.box[F.calls.box.length - 1], pick = () => ({ title: box().title, lines: box().lines.join("|"), ok: box().ok });
      F.libAsk(s101); const fresh = pick();
      F.ctaState = "installed"; F.libAsk(s101); const again = pick(); F.libAsk(s72); const againFee = pick(); F.env = "cloud"; F.libAsk(s101); const againCloud = pick(); F.env = "local"; F.ctaState = "free";
      ok("⑥ 確認框(未安裝):標題 lib.cf.title、內文不帶覆蓋那句、鈕 lib.cf.ok", fresh.title === "下載「BTC 通道動能共振」？" && fresh.lines === [z["lib.cf.l1Local"], z["lib.cf.l2"]].join("|") && fresh.ok === z["lib.cf.ok"], JSON.stringify(fresh));
      ok("⑥ 確認框(已安裝 → 再下載一份):標題 lib.cf.titleAgain、第一行 lib.cf.l0Again 帶 libWhere(本機 / 雲端各自)、其餘照舊(資料費那行照出)、鈕 lib.cf.okAgain",
        again.title === "再下載一份「BTC 通道動能共振」？" && again.ok === "覆蓋並回測"
        && again.lines === ["會整份覆蓋" + z["lib.where.local"] + "的策略清單裡同名的那支，並重跑回測。", z["lib.cf.l1Local"], z["lib.cf.l2"]].join("|")
        && againFee.lines === ["會整份覆蓋" + z["lib.where.local"] + "的策略清單裡同名的那支，並重跑回測。", z["lib.cf.l1Local"], z["lib.cf.l2"], z["lib.note.billed"]].join("|")
        && againCloud.lines === ["會整份覆蓋" + z["lib.where.cloud"] + "的策略清單裡同名的那支，並重跑回測。", z["lib.cf.l1"], z["lib.cf.l2"]].join("|"), JSON.stringify([again, againFee, againCloud]));
      ok("⑥ Again 三個 key zh / en 都有;en 帶 {title} / {where}", ["lib.cf.titleAgain", "lib.cf.l0Again", "lib.cf.okAgain"].every((k) => STR.zh[k] && STR.en[k]) && STR.en["lib.cf.titleAgain"].includes("{title}") && STR.en["lib.cf.l0Again"].includes("{where}")); }
    ok("⑥ 代下載中不開購買框(買完接著的 libSend 會被擋,變成付了錢沒裝)", /if \(LIB\.buying !== null \|\| LIB\.pending\) return;/.test(cutFn(src, "libBuyBox")));
    ok("⑥ 購買框的資料費那一行跟確認框用同一支 libFeeLine", /if \(libFeeLine\(libEnv\(\), LIB\.data \? LIB\.data\.dataAccess : null, libNeeds\(s\)\)\) extra\.appendChild\(libEl\("p", "cf-note", t\("lib\.note\.billed"\)\)\);/.test(cutFn(src, "libBuyBox")));
  })());

  // ── ④ 交給 Electron ──
  Promise.all(ASYNC).catch((e) => ok("非同步段落丟例外", false, e && e.stack)).then(() => {
    const bin = GATE.bin(SHELL, "④");
    if (!bin) { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
    const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
    const sub = r.status == null ? 1 : r.status;
    console.log(red || sub ? `\n${red + sub} 紅` : "\nALL PASS");
    process.exit(red || sub ? 1 : 0);
  });
  return;   // CommonJS 模組本身是函式:以下是 Electron 那一段,node 這邊不往下走
}

const { app, BrowserWindow } = require("electron");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-library-")));
const STUB = `window.__lib = { calls: [], list: ${JSON.stringify({ strategies: LIST, signedIn: true, dataAccess: "included" })}, patches: [], installed: {}, sent: [], sendResult: { started: true }, strats: [], buys: [], buyResult: { status: 0, body: null }, buyRelease: null, hasToken: true,
  downloads: [], dlResult: { ok: true }, reportCalls: [], report: ${JSON.stringify(REPORT)} };
const __fixed = {
  getLocale: async () => "zh-TW", loadConnection: async () => ({ kind: "claude" }), detectAgents: async () => ({ claude: { installed: true, loggedIn: true }, codex: { installed: false } }),
  listStrategies: async () => window.__lib.strats, listSessions: async () => [], loadSession: async () => [], loadSessionImages: async () => [], updateState: async () => ({ phase: "idle", current: "0.0.0" }),
  hasBlaveToken: async () => window.__lib.hasToken, ensureEngine: async () => ({}), loadStrategy: async (n) => ({ name: n, stats: null, code: "x", scan: null }),
  libraryList: async (lang, force) => { window.__lib.calls.push(lang); window.__lib.forces = (window.__lib.forces || []).concat([force === true]); return window.__lib.list; }, libraryInstalled: async (p) => { if (p) { window.__lib.patches.push(p); if (p.name === null) delete window.__lib.installed[String(p.id)]; else window.__lib.installed[String(p.id)] = p.name; } return Object.assign({}, window.__lib.installed); },
  sendMessage: async (p) => { window.__lib.sent.push(p); return window.__lib.sendResult; },
  libraryPurchase: (id, c) => new Promise((res) => { window.__lib.buys.push([id, c]); window.__lib.buyRelease = () => res(window.__lib.buyResult); }),
  libraryDownload: async (id) => { window.__lib.downloads.push(id); return window.__lib.dlResult; },
  // 報告:report 是物件就回它、"throw" 就丟例外(打不到)、函式就依 id 決定;主行程失敗回 null
  libraryReport: async (id, lang) => { window.__lib.reportCalls.push([id, lang]); const r = window.__lib.report; if (r === "throw") throw new Error("x"); return typeof r === "function" ? r(id) : r; },
  openExternal: async (u) => { window.__lib.opened = u; return true; },
};
window.blave = new Proxy(__fixed, { get: (o, k) => (k in o ? o[k] : typeof k !== "string" ? undefined : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {} : async () => undefined) });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  ④ 逾時(90 秒)"); process.exit(1); }, 90000).unref();

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const preload = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(preload, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1200);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const T = (k, v) => js(`t(${JSON.stringify(k)}, ${JSON.stringify(v || {})})`);
  const Q = (s) => js(`(() => { const q = (x) => [...document.querySelectorAll(x)]; return (${s}); })()`);

  // 開
  let r = await js(`(async () => { await libOpen(); await new Promise((r) => setTimeout(r, 80)); const q = (x) => [...document.querySelectorAll(x)];
    return { on: !document.getElementById("lib").hidden, cur: document.getElementById("lib-nav").getAttribute("aria-current"), empty: document.getElementById("main-empty").hidden, tr: document.getElementById("tr").hidden,
      ids: q("#lib-rows .lib-row").map((b) => b.dataset.id).join(), foot: document.getElementById("lib-foot"), web: document.getElementById("lib-web"),
      gate: q("#lib-grps > *").length === 0 && q("#lib .lib-grp, #lib .lib-gate").length === 0, comm: document.getElementById("lib-comm"), chev: q("#lib [aria-expanded]").length,
      tags12: q('#lib-rows .lib-row[data-id="12"] .tag').map((x) => x.textContent).join("|"), tags8: q('#lib-rows .lib-row[data-id="8"] .tag').map((x) => x.textContent + ":" + x.className).join("|"), l2_12: q('#lib-rows .lib-row[data-id="12"] .l2')[0].textContent,
      tags101: q('#lib-rows .lib-row[data-id="101"] .tag').map((x) => x.textContent).join("|"), tags5: q('#lib-rows .lib-row[data-id="5"] .tag').map((x) => x.textContent).join("|"), tags9: q('#lib-rows .lib-row[data-id="9"] .tag').map((x) => x.textContent).join("|"), tag5gap: (() => { const p = q('#lib-rows .lib-row[data-id="5"] .tag.is-price')[0]; const a = p.children[0].getBoundingClientRect(), b = p.children[1].getBoundingClientRect(); return p.children.length === 2 && p.children[1].textContent === "TWD" && b.left - a.right >= 3; })(),
      l2: q('#lib-rows .lib-row[data-id="101"] .l2')[0].textContent, ann: q('#lib-rows .lib-row[data-id="101"] .num .v')[0].textContent, annCls: q('#lib-rows .lib-row[data-id="101"] .num .v')[0].className, annColor: getComputedStyle(q('#lib-rows .lib-row[data-id="101"] .num .v')[0]).color, inkColor: getComputedStyle(q('#lib-rows .lib-row[data-id="101"] .t')[0]).color, greenText: getComputedStyle(document.documentElement).getPropertyValue("--color-greenText").trim(),
      imgs: q("#lib img").length, title5: q('#lib-rows .lib-row[data-id="5"] .t')[0].textContent, tags86: q('#lib-rows .lib-row[data-id="86"] .tag').map((x) => x.textContent).join("|"), focus: document.activeElement && document.activeElement.id }; })()`);
  ok("④ 開策略庫:#lib 出、入口 aria-current、歡迎頁與自動下單收;一份清單 8 列照推薦排序(未驗證的兩支在尾);焦點在 h5;沒有「在網頁版看」鈕;清單底沒有投稿腳注(#lib-foot 不存在);有資料時閘門卡不出", r.on && r.cur === "page" && r.empty && r.tr && r.ids === "74,101,72,5,9,86,12,8" && r.focus === "lib-h"
    && r.web === null && r.foot === null && r.gate === true, JSON.stringify(r));
  ok("④ 社群平鋪(0.1.6 §2):未驗證的兩支直接列在清單尾(新的先)、沒有「未驗證」標籤、只有價格 tag(沒有 is-verified)、第二行「社群作者」;沒有 disclosure 列、沒有 chevron", r.comm === null && r.chev === 0 && r.tags12 === "800TWD" && /^1,200TWD:tag is-price$/.test(r.tags8) && !("lib.unverified" in STR.zh) && !("lib.unverified" in STR.en) && r.l2_12.startsWith((await T("lib.community")) + " · "), JSON.stringify(r));
  ok("④ 列:tag(已驗證 + 免費 / 價格 1,500 TWD / 已購買)、第二行「Blave 官方 · BTC/USDT 永續 · 5 分 K · 樣本 6.5 年」、年化 +24.61% 綠字;api 來的字只進 textContent(沒有 img)",
    r.tags101 === (await T("lib.verified")) + "|" + (await T("lib.free")) && r.tags5 === (await T("lib.verified")) + "|1,500TWD" && r.tag5gap && r.tags9 === (await T("lib.verified")) + "|" + (await T("lib.owned"))
    && r.l2 === "Blave 官方 · BTC/USDT 永續 · 5 分 K · 樣本 6.5 年" && r.ann === "+24.61%" && /\bup\b/.test(r.annCls) && r.annColor !== r.inkColor && r.imgs === 0 && r.title5 === "Cash-and-Carry <img onerror=x> Arbitrage"
    && r.tags86 === (await T("lib.free")), JSON.stringify(r));   // 官方但未驗證(#86):既無「已驗證」也無「未驗證」
  r = await js(`(() => { const q = (x) => [...document.querySelectorAll(x)]; q('#lib-seg button[data-mkt="tw"]')[0].click(); const tw = q("#lib-rows .lib-row").map((b) => b.dataset.id).join(), twState = document.getElementById("lib-state").hidden;
    q('#lib-seg button[data-mkt="crypto"]')[0].click(); const cr = q("#lib-rows .lib-row").map((b) => b.dataset.id).join(); const pressed = q("#lib-seg button").map((b) => b.getAttribute("aria-pressed")).join();
    q('#lib-seg button[data-mkt="all"]')[0].click(); return { tw, twState, cr, pressed, all: q("#lib-rows .lib-row").length }; })()`);
  ok("④ 分段:台股 1 支;加密 7 支(未驗證的兩支在尾);按下的那格 aria-pressed;回全部 8", r.tw === "74" && r.twState && r.cr === "101,72,5,9,86,12,8" && r.pressed === "false,true,false" && r.all === 8, JSON.stringify(r));
  // 只有未驗證的社群策略:照列(不再有「主段空」這回事);切到台股 0 列 → lib.emptyMkt
  r = await js(`(async () => { const q = (x) => [...document.querySelectorAll(x)]; const keep = window.__lib.list; window.__lib.list = { strategies: ${JSON.stringify([LIST[4], LIST[5]])}, signedIn: true, dataAccess: "included" }; await libLoad(true);
    const a = { state: document.getElementById("lib-state").hidden, ids: q("#lib-rows .lib-row").map((b) => b.dataset.id).join() };
    q('#lib-seg button[data-mkt="tw"]')[0].click(); const st = document.getElementById("lib-state"), b = { state: st.hidden, text: st.firstChild && st.firstChild.textContent, btn: q("#lib-state button").map((x) => x.textContent + ":" + x.className).join(), n: q("#lib-rows .lib-row").length };
    q('#lib-seg button[data-mkt="all"]')[0].click(); window.__lib.list = keep; await libLoad(true); return { a, b, back: q("#lib-rows .lib-row").length }; })()`);
  ok("④ 只有未驗證的社群策略時:兩支照列(新的先)、不出空狀態;切到台股 0 列 → lib.emptyMkt + 一顆描邊「新增策略」(內建瀏覽器關著,找點子不出;spec-0.1.13 §2.5)", r.a.state && r.a.ids === "12,8" && !r.b.state && r.b.text === (await T("lib.emptyMkt")) && r.b.btn === (await T("ns.chip")) + ":btn-out" && r.b.n === 0 && r.back === 8, JSON.stringify(r));
  // 詳情
  const gatesOf = `q("#lib-det .gates li").map((li) => li.querySelector(".gn").textContent + "=" + li.querySelector(".gr > .gv").textContent + "[" + [...li.querySelectorAll(".gr > .gx")].map((x) => x.textContent).join(";") + "]").join("|")`;
  r = await js(`(async () => { const q = (x) => [...document.querySelectorAll(x)]; window.__lib.reportCalls = []; q('#lib-rows .lib-row[data-id="101"]')[0].click(); const c0 = LIB.chart;
    const sync = { back: !document.getElementById("lib-back").hidden, headList: document.getElementById("lib-head-list").hidden, rows: q("#lib-rows .lib-row").length, gate: q("#lib-grps > *").length === 0, h5: q("#lib-det h5")[0].textContent, meta: q("#lib-det .lib-meta")[0].textContent, sum: q("#lib-det .lib-sum")[0].textContent,
      chart: q("#lib-det .lib-card .chart").length, chartH: q("#lib-det .lib-card .chart")[0].getBoundingClientRect().height, canvas: q("#lib-det .lib-card .chart canvas").length, kv: q("#lib-det .lib-kv .k").map((x) => x.textContent).join("|") + " / " + q("#lib-det .lib-kv .v").map((x) => x.textContent).join("|"), gates: ${gatesOf}, lead: q("#lib-det .lib-card")[1].querySelector(".lib-p"),
      how: q("#lib-det .lib-p")[0].textContent, dl: q("#lib-det .lib-dl dd").map((x) => x.textContent).join("|"), period: document.getElementById("lib-period").textContent, steps: q("#lib-det .steps li").length, cta: q("#lib-cta .btn-fill")[0].textContent, note: q("#lib-cta .note")[0].textContent, focus: document.activeElement && document.activeElement.id, c0: !!c0 };
    await new Promise((r) => setTimeout(r, 80));
    const after = { calls: window.__lib.reportCalls, swapped: LIB.chart !== c0 && !!LIB.chart, chart: q("#lib-det #lib-chart").length, canvas: q("#lib-det #lib-chart canvas").length, period: document.getElementById("lib-period").textContent, periodMono: q("#lib-period .mono").length, focus: document.activeElement && document.activeElement.id, h5: q("#lib-det h5").length, cta: q("#lib-cta .btn-fill")[0].textContent };
    return { sync, after }; })()`);
  { const s = r.sync;
    ok("④ 詳情:返回鈕出、清單頭 / 閘門卡收;標題 / meta(7 人安裝)/ 摘要;曲線先用 spark 畫出來(canvas、圖高 200);回測欄總報酬在第一列 + 四個數字 + 上架兩格;三道關卡都通過、右欄帶數值(費率兩行、p < 0.001、鄰域 91%);官方不出結論段;說明留換行;dl 回測期間先用曲線區間 / 標的 / 方向 / 曝險;沒有「用了之後」卡;焦點在返回鈕",
      s.back && s.headList && s.rows === 0 && s.gate && s.h5 === "BTC 通道動能共振" && s.meta === "Blave 官方 · BTC/USDT 永續 · 5 分 K · 7 人安裝" && s.sum === "通道 + 動能。" && s.chart === 1 && s.chartH === 200 && s.canvas >= 1 && s.c0
      && s.kv === "總報酬|年化|Sharpe|最大回撤|樣本|上架天數|安裝 / +312.50%|+24.61%|1.50|−20.00%|6.5 年|107|7".replace("107", String(Math.max(0, Math.floor((Date.now() - Date.parse("2026-06-10T00:00:00")) / 86400000))))
      && s.gates === "誠實回測=通過[假設 0.05%;交易所 0.04%]|統計顯著=通過[p < 0.001]|參數穩健=通過[鄰域保留 91%]" && s.lead === null
      && s.how === "第一段。\n第二段。" && s.dl === "2020-01-01 — 2026-06-30|BTC/USDT 永續 · 5 分 K|純做多|1 倍" && s.period === "2020-01-01 — 2026-06-30" && s.steps === 0 && s.focus === "lib-back", JSON.stringify(s));
    ok("④ 免費態:主鈕「用這支」、沒有說明句(免費不寫)", s.cta === (await T("lib.use")) && s.note === "", JSON.stringify(s.note)); }
  ok("④ /report 回來(問一次、帶語言):只換曲線(#lib-chart 還在、LIB.chart 換新、canvas 在)與回測期間(backtest_start — backtest_end、.mono);頭部 / CTA / 焦點都沒重畫", JSON.stringify(r.after.calls) === "[[101,\"zh\"]]" && r.after.swapped && r.after.chart === 1 && r.after.canvas >= 1
    && r.after.period === "2019-12-02 — 2026-06-30" && r.after.periodMono === 1 && r.after.focus === "lib-back" && r.after.h5 === 1 && r.after.cta === (await T("lib.use")), JSON.stringify(r.after));
  // 降級:主行程回 null / 打不到 → 停在 spark、回測期間留曲線區間、不出任何錯誤字;下次進詳情再問(失敗不記)
  r = await js(`(async () => { const q = (x) => [...document.querySelectorAll(x)]; document.getElementById("lib-back").click(); window.__lib.report = null; window.__lib.reportCalls = []; q('#lib-rows .lib-row[data-id="72"]')[0].click(); const c0 = LIB.chart;
    await new Promise((r) => setTimeout(r, 80)); const a = { same: LIB.chart === c0 && !!c0, canvas: q("#lib-det #lib-chart canvas").length, period: document.getElementById("lib-period").textContent, err: q("#lib-det .err, #lib-det .plan-err, #lib-det [role=alert]").length, none: q("#lib-det .chart-none").length, cached: LIB.reports.has(72) };
    document.getElementById("lib-back").click(); window.__lib.report = "throw"; q('#lib-rows .lib-row[data-id="72"]')[0].click(); const c1 = LIB.chart;
    await new Promise((r) => setTimeout(r, 80)); const b = { same: LIB.chart === c1 && !!c1, canvas: q("#lib-det #lib-chart canvas").length, period: document.getElementById("lib-period").textContent, calls: window.__lib.reportCalls.length, cached: LIB.reports.has(72) };
    document.getElementById("lib-back").click(); return { a, b }; })()`);
  ok("④ 降級:report 為 null → spark 曲線留著、期間 2023-03-02 — 2026-08-31、沒有錯誤字、不記快取;打不到(例外)→ 同樣;兩次進詳情各問一次", r.a.same && r.a.canvas >= 1 && r.a.period === "2023-03-02 — 2026-08-31" && r.a.err === 0 && r.a.none === 0 && !r.a.cached
    && r.b.same && r.b.canvas >= 1 && r.b.period === "2023-03-02 — 2026-08-31" && r.b.calls === 2 && !r.b.cached, JSON.stringify(r));
  // M1:/report 回來時已經換看別支 → 不套(守門 libBag().detail === s.id);M3:MCPT 不適用那列右欄只留狀態、不印 —
  r = await js(`(async () => { const q = (x) => [...document.querySelectorAll(x)]; let rel = null; window.__lib.report = (id) => (id === 101 ? new Promise((res) => { rel = () => res(${JSON.stringify(REPORT)}); }) : null); LIB.reports.clear();
    q('#lib-rows .lib-row[data-id="101"]')[0].click(); document.getElementById("lib-back").click(); q('#lib-rows .lib-row[data-id="72"]')[0].click(); const c0 = LIB.chart; rel(); await new Promise((r) => setTimeout(r, 60));
    const a = { same: LIB.chart === c0 && !!c0, period: document.getElementById("lib-period").textContent, detail: libBag().detail, h5: q("#lib-det h5")[0].textContent };
    document.getElementById("lib-back").click(); q('#lib-rows .lib-row[data-id="74"]')[0].click(); const b = { gates: ${gatesOf}, na: q("#lib-det .gates .gv.na").length };
    document.getElementById("lib-back").click(); LIB.reports.clear(); window.__lib.report = ${JSON.stringify(REPORT)}; return { a, b }; })()`);
  ok("④ #101 的 /report 晚到、人已在 #72 → #72 的曲線與期間不被動到;#74(MCPT 不適用)右欄只有狀態那一行、沒有 —", r.a.same && r.a.period === "2023-03-02 — 2026-08-31" && r.a.detail === 72 && r.a.h5 === "DOGE 籌碼集中度"
    && r.b.gates === "誠實回測=通過[假設 0.05%;交易所 0.04%]|統計顯著=MCPT 不適用（組合策略）[]|參數穩健=通過[鄰域保留 91%]" && r.b.na === 1, JSON.stringify(r));
  // 清單沒曲線(#86:spark null)但 /report 有:「尚未提供權益曲線」那行換成圖;報告只有壞曲線 → 留著那行
  r = await js(`(async () => { const q = (x) => [...document.querySelectorAll(x)]; window.__lib.report = (id) => (id === 86 ? ${JSON.stringify(Object.assign({}, REPORT, { equity_from: "2021-01-01", equity_to: "2026-06-30" }))} : null); q('#lib-rows .lib-row[data-id="86"]')[0].click();
    const before = { none: q("#lib-det .chart-none").length, chart: q("#lib-det #lib-chart").length, period: document.getElementById("lib-period").textContent };
    await new Promise((r) => setTimeout(r, 80)); const after = { none: q("#lib-det .chart-none").length, chart: q("#lib-det #lib-chart").length, canvas: q("#lib-det #lib-chart canvas").length, inCard1: q("#lib-det .lib-card")[0].querySelector("#lib-chart") !== null, period: document.getElementById("lib-period").textContent };
    document.getElementById("lib-back").click(); LIB.reports.clear(); window.__lib.report = (id) => (id === 86 ? { equity: [1, 2], equity_from: null, equity_to: null, backtest_start: null, backtest_end: null } : null); q('#lib-rows .lib-row[data-id="86"]')[0].click();
    await new Promise((r) => setTimeout(r, 80)); const bad = { none: q("#lib-det .chart-none").length, chart: q("#lib-det #lib-chart").length, period: document.getElementById("lib-period").textContent };
    document.getElementById("lib-back").click(); window.__lib.report = ${JSON.stringify(REPORT)}; LIB.reports.clear(); return { before, after, bad }; })()`);
  ok("④ 沒 spark 的策略:先出「尚未提供權益曲線」、期間 —;/report 有曲線 → 換成圖(在卡 1)、期間換成報告的;報告的曲線畫不出來(沒日期)→ 留著那行、期間仍 —", r.before.none === 1 && r.before.chart === 0 && r.before.period === "—"
    && r.after.none === 0 && r.after.chart === 1 && r.after.canvas >= 1 && r.after.inCard1 && r.after.period === "2019-12-02 — 2026-06-30" && r.bad.none === 1 && r.bad.chart === 0 && r.bad.period === "—", JSON.stringify(r));
  // 未驗證的詳情(規格 §13.4):沒跑過關卡 → 一句 lib.gates.community、不列三道;跑過但有 fail → 先講「k 道關卡未通過」再列三道(未通過紅字 + 數值)
  r = await js(`(() => { const q = (x) => [...document.querySelectorAll(x)]; q('#lib-rows .lib-row[data-id="8"]')[0].click();
    const a = { tags: q("#lib-det .lib-badges .tag").map((x) => x.textContent).join("|"), card: q("#lib-det .lib-card")[1].querySelector("h6").textContent, p: q("#lib-det .lib-card")[1].querySelector(".lib-p").textContent, lis: q("#lib-det .gates li").length, cta: q("#lib-cta .btn-fill")[0].textContent };
    document.getElementById("lib-back").click(); const focus8 = document.activeElement && document.activeElement.dataset.id; q('#lib-rows .lib-row[data-id="12"]')[0].click();
    const c2 = q("#lib-det .lib-card")[1]; const b = { tags: q("#lib-det .lib-badges .tag").map((x) => x.textContent).join("|"), p: c2.querySelector(".lib-p").textContent, k: c2.querySelector(".lib-p .mono") && c2.querySelector(".lib-p .mono").textContent, first: c2.children[1].className, gates: ${gatesOf},
      down: q("#lib-det .gates .gv.down").map((x) => x.textContent).join("|"), downColor: getComputedStyle(q("#lib-det .gates .gv.down")[0]).color, redText: getComputedStyle(document.documentElement).getPropertyValue("--color-redText").trim(), gxColor: getComputedStyle(q("#lib-det .gates .gx")[0]).color, cta: q("#lib-cta .btn-fill")[0].textContent, note: q("#lib-cta .note")[0].textContent };
    document.getElementById("lib-back").click(); q('#lib-rows .lib-row[data-id="101"]')[0].click(); return { a, focus8, b }; })()`);   // 後面的閘門態測試接著看 #101 的詳情
  ok("④ #8(沒 gate_checks):沒有「未驗證」badge、只有價格、關卡卡只有一句 lib.gates.community、不列三道、CTA 仍「購買並使用 1,200 TWD」;返回焦點回那一列", r.a.tags === "1,200TWD" && r.a.card === (await T("lib.gates.title")) && r.a.p === (await T("lib.gates.community")) && r.a.lis === 0 && r.a.cta === (await T("lib.buy", { price: "1,200 TWD" })) && r.focus8 === "8", JSON.stringify(r));
  ok("④ #12(兩道 fail):關卡卡第一段「2 道關卡未通過…」(句首不帶「未驗證：」)(2 進 .mono、在 ul 之前),兩道「未通過」紅字 + 數值(假設 0.03% / 交易所 0.04%、p = 0.1200、鄰域 82%);CTA「購買並使用 800 TWD」、說明句沒有恐嚇語", r.b.tags === "800TWD" && !/^未驗證/.test(r.b.p) && r.b.p === (await T("lib.gates.failed", { k: 2 })) && r.b.k === "2" && r.b.first === "lib-p"
    && r.b.gates === "誠實回測=未通過[假設 0.03%;交易所 0.04%]|統計顯著=未通過[p = 0.1200]|參數穩健=通過[鄰域保留 82%]" && r.b.down === "未通過|未通過" && r.b.downColor !== r.b.gxColor && r.b.cta === (await T("lib.buy", { price: "800 TWD" })) && r.b.note === (await T("lib.note.paid")), JSON.stringify(r));
  // 閘門態
  const cta = () => js(`(() => { const q = (x) => [...document.querySelectorAll(x)]; const b = q("#lib-cta .btn-fill")[0], qb = q("#lib-cta .btn-quiet"); return { btn: b ? b.textContent : null, dis: b ? b.disabled : null, quiet: qb.map((x) => x.textContent).join("|"), note: q("#lib-cta .note")[0].textContent, up: q("#lib-cta .note")[0].classList.contains("up"), err: q("#lib-cta .err").map((x) => x.textContent).join() }; })()`);
  await js(`hasToken = false; libSync();`); r = await cta();
  ok("④ 未登入(0.1.6 §3.2 末):主鈕「登入 Blave」、閘門句升一階、沒有文字鈕", r.btn === (await T("cn.blave.btn")) && r.dis === false && r.up && r.quiet === "" && r.note === (await T("lib.gate.signedOut")), JSON.stringify(r));
  r = await js(`(async () => { const q = (x) => [...document.querySelectorAll(x)]; q("#lib-cta .btn-fill")[0].click(); await new Promise((r) => setTimeout(r, 60)); const out = { set: !document.getElementById("set-scrim").hidden, cat: (document.querySelector('.set-cat[aria-current="true"]') || { dataset: {} }).dataset.setCat }; setClose(); return out; })()`);
  ok("④ 「登入 Blave」→ 設定 › 帳號與方案", r.set && r.cat === "plan", JSON.stringify(r));
  // 付不出資料費(0.1.6 §3.2):主鈕照 why 分流、鈕下說明升一階;試用天數來自 planVars().t(acct.trial_days),不寫死
  await js(`hasToken = true; LIB.data.dataAccess = "none"; LIB.data.why = "no_card"; acct = { trial_eligible: true, trial_days: 14 }; libSync();`); r = await cta();
  ok("④ no_card 有試用(#101 未標資料需求):主鈕「綁卡，送 14 天資料」、說明只有第一句 lib.need.unknown(no_card 不接第二句,鈕字已講);沒有文字鈕", r.btn === (await T("lib.gate.bindCard", { t: 14 })) && r.dis === false && r.up && r.quiet === "" && r.note === (await T("lib.need.unknown")), JSON.stringify(r));
  await js(`acct = { trial_eligible: false, trial_days: 14 }; libSync();`); r = await cta();
  ok("④ no_card 沒試用:「前往綁卡」、說明只有第一句", r.btn === (await T("plan.addCard")) && r.note === (await T("lib.need.unknown")), JSON.stringify(r));
  await js(`acct = { trial_eligible: true }; pub = null; libSync();`); r = await cta();
  ok("④ no_card 但天數查不到(t 空):也退到「前往綁卡」", r.btn === (await T("plan.addCard")) && r.note === (await T("lib.need.unknown")), JSON.stringify(r));
  await js(`LIB.data.why = "no_balance"; libSync();`); r = await cta();
  ok("④ no_balance:「儲值」+ 說明 lib.need.unknown 接 lib.why.noBalance", r.btn === (await T("lib.gate.topup")) && r.note === (await T("lib.need.unknown")) + (await T("lib.why.noBalance")), JSON.stringify(r));
  await js(`LIB.data.why = "unknown"; libSync();`); r = await js(`(() => { const q = (x) => [...document.querySelectorAll(x)]; return { fill: q("#lib-cta .btn-fill").length, out: q("#lib-cta .btn-out").map((b) => b.textContent).join(), note: q("#lib-cta .note")[0].textContent }; })()`);
  ok("④ unknown:描邊「帳號與方案」(鈕字是 pv.e.btn;查不到狀態不擺要錢的主鈕)+ 說明 lib.need.unknown 接 lib.why.unknown", r.fill === 0 && r.out === (await T("pv.e.btn")) && r.note === (await T("lib.need.unknown")) + (await T("lib.why.unknown")), JSON.stringify(r));
  r = await js(`(async () => { const q = (x) => [...document.querySelectorAll(x)]; q("#lib-cta .btn-out")[0].click(); await new Promise((r) => setTimeout(r, 60)); const a = { set: !document.getElementById("set-scrim").hidden, cat: (document.querySelector('.set-cat[aria-current="true"]') || { dataset: {} }).dataset.setCat }; setClose();
    document.getElementById("lib-back").click(); LIB.data.why = "no_balance"; document.getElementById("lib-h").focus(); libPaintList();
    const grp = () => { const s = q("#lib-grps .lib-grp"), gate = q("#lib-grps .lib-gate")[0]; return { n: s.length, heads: s.map((x) => { const h = x.querySelector("h6.lib-grp-h"); return h.id + "=" + h.textContent + "@" + x.getAttribute("aria-labelledby"); }).join("|"), mono: q("#lib-grps .lib-grp-h .mono").map((x) => x.textContent).join(),
      empty: (q("#lib-grps .lib-grp-empty")[0] || { textContent: null }).textContent, gateIn2: !!gate && gate.parentElement === s[1] && gate.previousElementSibling === s[1].querySelector("h6"), text: gate && gate.querySelector("p").textContent, btn: gate && gate.querySelector("button").textContent + ":" + gate.querySelector("button").className,
      now: s[0] ? [...s[0].querySelectorAll(".lib-row")].map((r) => r.dataset.id).join() : null, later: s[1] ? [...s[1].querySelectorAll(".lib-row")].map((r) => r.dataset.id).join() : null, flat: q("#lib-rows > .lib-row").length, focus: document.activeElement && document.activeElement.id }; };
    const b = grp();
    window.__lib.mark = (ids) => LIB.data.strategies.forEach((x) => { x.blave_data = ids.includes(x.id) ? "none" : x.id === 72 ? "required" : null; });
    window.__lib.mark([101, 86]); libPaintList(); const b2 = grp();
    hasToken = false; libPaintList(); const c = grp(); hasToken = true;
    LIB.bags.cloud.open = true; document.getElementById("cv-empty").hidden = true; ENV.cur = "cloud"; envShowMain(); await new Promise((r) => setTimeout(r, 60)); const d = Object.assign(grp(), { lib: !document.getElementById("lib").hidden }); ENV.cur = "local"; LIB.bags.cloud.open = false; envShowMain(); await new Promise((r) => setTimeout(r, 60));
    LIB.data.dataAccess = null; libPaintList(); const f = grp();
    LIB.data.dataAccess = "included"; LIB.data.why = null; libPaintList(); const e = grp(); window.__lib.mark([]); LIB.data.strategies.forEach((x) => { delete x.blave_data; }); q('#lib-rows .lib-row[data-id="101"]')[0].click(); return { a, b, b2, c, d, e, f }; })()`);
  ok("④ 鈕開到 設定 › 資料與雲端方案", r.a.set && r.a.cat === "plan", JSON.stringify(r.a));
  ok("④ 沒權限分兩組(spec-0.1.13 §2.2):全部未標 → 第一組 0 支 + 一行 lib.grp.empty、第二組「儲值後能用 8」;閘門卡在第二組標題正下方(lib.grp.gate.noBalance + 儲值填色鈕);組標題是 h6、section 以 aria-labelledby 指它;焦點不被搶",
    r.b.n === 2 && r.b.heads === "lib-grp-now=" + (await T("lib.grp.now")) + "0@lib-grp-now|lib-grp-later=" + (await T("lib.grp.topup")) + "8@lib-grp-later" && r.b.mono === "0,8" && r.b.empty === (await T("lib.grp.empty")) && r.b.gateIn2
    && r.b.text === (await T("lib.grp.gate.noBalance")) && r.b.btn === (await T("lib.gate.topup")) + ":btn-fill" && r.b.flat === 0 && r.b.focus === "lib-h", JSON.stringify(r.b));
  ok("④ 標了 #101 / #86 免資料:第一組 101,86(照推薦排序)、第二組其餘 6 支;沒登入 → 第一組只有免登入策略(官方免費免資料)、第二組「要先登入」+ 登入卡;雲端不分組;登入但查不到 → 「帳號狀態確認後能用」;有卡平鋪 8 列",
    r.b2.now === "101,86" && r.b2.later === "74,72,5,9,12,8" && r.c.now === "101,86" && r.c.heads.includes((await T("lib.grp.signedOut")) + "6@") && r.c.text === (await T("lib.grp.gate.signedOut")) && r.c.btn === (await T("cn.blave.btn")) + ":btn-fill"
    && r.d.lib && r.d.n === 0 && r.d.flat === 8 && r.f.heads.includes((await T("lib.grp.check")) + "6@") && r.f.text === (await T("lib.grp.gate.unknown")) && r.e.n === 0 && r.e.flat === 8, JSON.stringify([r.b2, r.c, r.d, r.e, r.f]));
  // 找點子開關切換(§1.4):入口即時出現 / 消失;焦點在被拿掉的頁首文字鈕上 → 交給 #lib-h,在列上 → 留在那一列
  r = await js(`(async () => { const q = (x) => [...document.querySelectorAll(x)]; document.getElementById("lib-back").click(); cur = "claude"; LIB.brOn = true; libIdeaPaint();
    const on = { link: q("#lib-desc .btn-quiet").length, chip: !document.getElementById("chat-idea").hidden }; q("#lib-desc .btn-quiet")[0].focus();
    LIB.brOn = false; libIdeaPaint(); const off = { link: q("#lib-desc .btn-quiet").length, chip: !document.getElementById("chat-idea").hidden, focus: document.activeElement && document.activeElement.id };
    LIB.brOn = true; libIdeaPaint(); q('#lib-body .lib-row[data-id="72"]')[0].focus(); LIB.brOn = false; libIdeaPaint(); const row = document.activeElement && document.activeElement.dataset.id;
    q('#lib-body .lib-row[data-id="101"]')[0].click(); return { on, off, row }; })()`);
  ok("④ 找點子開關切換:開 → 頁首文字鈕與歡迎頁籤出現;關 → 都不見、焦點從被拿掉的文字鈕交給 #lib-h;焦點在列上 → 留在那一列", r.on.link === 1 && r.on.chip && r.off.link === 0 && !r.off.chip && r.off.focus === "lib-h" && r.row === "72", JSON.stringify(r));
  await js(`LIB.data.dataAccess = "billed"; libSync();`); r = await cta();
  let a = await js(`(async () => { const q = (x) => [...document.querySelectorAll(x)]; q("#lib-cta .btn-fill")[0].click(); const o = { lines: q("#del-body p").map((p) => p.textContent), where: document.getElementById("del-where").hidden }; document.getElementById("del-cancel").click(); await new Promise((r) => setTimeout(r, 40)); return o; })()`);
  ok("④ 按小時付資料費的帳號:鈕下沒有說明句;lib.note.billed 在確認框第三行、本機不出腳的目的地句", r.btn === (await T("lib.use")) && r.note === "" && a.lines.length === 3 && a.lines[2] === (await T("lib.note.billed")) && a.where, JSON.stringify([r, a]));
  a = await js(`(async () => { const q = (x) => [...document.querySelectorAll(x)]; ENV.cur = "cloud"; libAsk({ id: 101, title: "BTC 通道動能共振" }); const o = { lines: q("#del-body p").map((p) => p.textContent), notes: q("#del-body .cf-note").length, where: document.getElementById("del-where").hidden ? null : document.getElementById("del-where").textContent, env: !document.getElementById("del-env").hidden }; document.getElementById("del-cancel").click(); ENV.cur = "local"; await new Promise((r) => setTimeout(r, 40)); return o; })()`);
  ok("④ 雲端視角的下載確認框:內文兩段(l1 不帶目的地、雲端不出 billed)、lib.cf.cloudNote 在腳的 .del-where(不在內文 .cf-note)、「雲端」記號", a.lines.length === 2 && a.lines[0] === (await T("lib.cf.l1")) && a.notes === 0 && a.where === (await T("lib.cf.cloudNote")) && a.env, JSON.stringify(a));
  await js(`LIB.data.dataAccess = "included"; running = true; libSync();`); r = await cta();
  { const n0 = await js(`(() => { const n = document.getElementById("lib-cta-note"), b = document.querySelector("#lib-cta .btn-fill"); return { hidden: n.hidden, role: n.getAttribute("role"), aria: b.getAttribute("aria-disabled"), title: b.title }; })()`);
    const told = await js(`(async () => { const b = document.querySelector("#lib-cta .btn-fill"); b.focus(); b.click(); await new Promise((r) => setTimeout(r, 40)); libSync(); return { note: document.getElementById("lib-cta-note").textContent, focus: document.activeElement === document.querySelector("#lib-cta .btn-fill"), box: !document.getElementById("del-scrim").hidden }; })()`);
    ok("④ 回合中(點了才講):主鈕 aria-disabled + title、不是原生 disabled;那一格空著但不 hidden、role=status;點了才寫 turn.busy、不開確認框、忙碌中重畫還在",
      r.btn === (await T("lib.use")) && r.dis === false && r.note === "" && n0.hidden === false && n0.role === "status" && n0.aria === "true" && n0.title === (await T("turn.busy")) && told.note === (await T("turn.busy")) && !told.box, JSON.stringify([r, n0, told])); }
  // 用這支
  r = await js(`(async () => { running = false; libSync(); const q = (x) => [...document.querySelectorAll(x)]; q("#lib-cta .btn-fill")[0].click();
    const open = !document.getElementById("del-scrim").hidden, title = document.getElementById("del-title").textContent, full = document.getElementById("del-title").title, lines = q("#del-body p").map((p) => p.textContent), okTxt = document.getElementById("del-ok").textContent, env = document.getElementById("del-env").hidden, focus = document.activeElement && document.activeElement.id;
    document.getElementById("del-ok").click(); await new Promise((r) => setTimeout(r, 60));
    const b = q("#lib-cta .btn-fill")[0]; return { open, title, full, lines, okTxt, env, focus, sent: window.__lib.sent.map((p) => [p.message, p.viewing && p.viewing.env, p.sessionId && /^desktop-/.test(p.sessionId)]), pending: LIB.pending && LIB.pending.id, btn: b.textContent, dis: b.disabled, note: q("#lib-cta .note")[0].textContent, running }; })()`);
  ok("④ 「用這支」→ 確認框(標題帶策略名、兩段、本機那句 l1Local、「下載並回測」、焦點在取消、本機不掛雲端記號)→ 確認 → 外殼代下載 → 送 lib.msgLocal(逐字)、viewing.env=local → 進行中態",
    r.open && r.title === (await T("lib.cf.title", { title: "BTC 通道動能共振" })) && r.full === r.title && !/…/.test(r.title) && r.lines.length === 2 && r.lines[0] === (await T("lib.cf.l1Local")) && r.okTxt === (await T("lib.cf.ok")) && r.env && r.focus === "del-cancel"
    && (await js("window.__lib.downloads.join()")) === "101" && r.sent.length === 1 && r.sent[0][0] === "策略庫的「BTC 通道動能共振」（#101）已經下載好了，幫我安裝並跑一次回測看看結果" && r.sent[0][1] === "local" && r.sent[0][2] && r.pending === 101 && r.btn === (await T("lib.pending")) && r.dis && r.note === (await T("lib.note.pending")) && r.running, JSON.stringify(r));
  // turn-end:本機多了一支 → 記對照表;回合結束不換頁(結果卡 spec §1:新策略不自動選中,由 results.js 出卡,見 check_shell_results.js)
  r = await js(`(async () => { window.__lib.strats = [{ name: "btc_channel", displayName: "BTC 通道", mtime: 5, hasBacktest: true }]; running = false;
    await stratRefresh(true); libTurnEnd(); await new Promise((r) => setTimeout(r, 40));
    const libHidden = document.getElementById("lib").hidden, rp = document.getElementById("rp").hidden, sel = RP.name;
    await libOpen(); await new Promise((r) => setTimeout(r, 40)); const q = (x) => [...document.querySelectorAll(x)]; const b = q("#lib-cta .btn-fill")[0];
    return { patches: window.__lib.patches, installed: LIB.installed, libHidden, rp, sel, pending: LIB.pending, btn: b.textContent, quiet: q("#lib-cta .btn-quiet").map((x) => x.textContent).join(), note: q("#lib-cta .note")[0].textContent, noteHidden: q("#lib-cta .note")[0].hidden, detail: libBag().detail }; })()`);
  ok("④ turn-end:本機清單多了 btc_channel → 對照表記 101 → btc_channel(寫進主行程)、不自動選中新策略(策略庫留著、報告頁不出現);同一支詳情 → 已安裝態(打開這支策略 + 再下載一份,鈕下沒有說明句)",
    JSON.stringify(r.patches) === '[{"id":101,"name":"btc_channel"}]' && r.installed["101"] === "btc_channel" && !r.libHidden && r.rp && r.sel === null && r.pending === null && r.detail === 101
    && r.btn === (await T("lib.open")) && r.quiet === (await T("lib.again")) && r.note === "" && r.noteHidden, JSON.stringify(r));
  r = await js(`(async () => { const q = (x) => [...document.querySelectorAll(x)]; document.getElementById("lib-back").click(); const tag = q('#lib-rows .lib-row[data-id="101"] .tag').map((x) => x.textContent).join("|"), focus = document.activeElement && document.activeElement.dataset.id;
    window.__lib.strats = []; await stratRefresh(false); await new Promise((r) => setTimeout(r, 40));
    return { tag, focus, after: q('#lib-rows .lib-row[data-id="101"] .tag').map((x) => x.textContent).join("|"), patches: window.__lib.patches.length, installed: Object.keys(LIB.installed).length }; })()`);
  ok("④ 返回清單:列上多「已安裝」tag、焦點回那一列;本機那支被刪 → tag 消失、對照表拿掉那一筆(主行程也拿掉)", r.tag === (await T("lib.verified")) + "|" + (await T("lib.free")) + "|" + (await T("lib.installed")) && r.focus === "101"
    && r.after === (await T("lib.verified")) + "|" + (await T("lib.free")) && r.patches === 2 && r.installed === 0, JSON.stringify(r));
  // 沒新策略
  r = await js(`(async () => { LIB.pending = { id: 72, env: "local", before: new Map([]) }; libTurnEnd(); const noNew = LIB.noNew; const q = (x) => [...document.querySelectorAll(x)]; q('#lib-rows .lib-row[data-id="72"]')[0].click();
    const err = q("#lib-cta .err").map((x) => x.textContent).join(), btn = q("#lib-cta .btn-fill")[0].textContent; document.getElementById("lib-back").click(); return { noNew, err, btn, cleared: LIB.noNew }; })()`);
  ok("④ 回合結束沒多出東西:那支的詳情出灰字 lib.err.noNew、主鈕仍是「用這支」;離開詳情就清", r.noNew === 72 && r.err === (await T("lib.err.noNew")) && r.btn === (await T("lib.use")) && r.cleared === null, JSON.stringify(r));
  // mtime:同名覆蓋(「再下載一份」/ 以前手動裝過同名)也算成功;名字與 mtime 都沒變才是沒新策略
  r = await js(`(async () => { window.__lib.strats = [{ name: "btc_channel", displayName: "BTC 通道", mtime: 5, hasBacktest: true }, { name: "other", displayName: "O", mtime: 1, hasBacktest: true }]; await stratRefresh(false); stratSelect(null);
    LIB.pending = { id: 101, env: "local", before: new Map([["btc_channel", 5], ["other", 1]]) }; window.__lib.strats = [{ name: "btc_channel", displayName: "BTC 通道", mtime: 9, hasBacktest: true }, { name: "other", displayName: "O", mtime: 1, hasBacktest: true }];
    await stratRefresh(false); libTurnEnd(); const a = { noNew: LIB.noNew, installed: LIB.installed["101"] };
    LIB.pending = { id: 72, env: "local", before: new Map([["btc_channel", 9], ["other", 1]]) }; await stratRefresh(false); libTurnEnd(); const b = { noNew: LIB.noNew, installed: LIB.installed["72"] };
    LIB.installed["101"] = "other"; LIB.pending = { id: 101, env: "local", before: new Map([["btc_channel", 9], ["other", 1]]) }; window.__lib.strats = [{ name: "btc_channel", displayName: "BTC 通道", mtime: 11, hasBacktest: true }, { name: "other", displayName: "O", mtime: 2, hasBacktest: true }];
    await stratRefresh(false); libTurnEnd(); const c = { installed: LIB.installed["101"] }; window.__lib.strats = []; await stratRefresh(false); LIB.noNew = null; return { a, b, c }; })()`);
  ok("④ mtime 比對:同名 mtime 變了 → 記進對照表、不出 noNew;名字與 mtime 都沒變 → noNew;兩支都動了時對照表已記的那支優先", r.a.noNew === null && r.a.installed === "btc_channel" && r.b.noNew === 72 && r.b.installed === undefined && r.c.installed === "other", JSON.stringify(r));
  // 購買
  const box = () => js(`(() => { const q = (x) => [...document.querySelectorAll(x)]; const sc = document.getElementById("del-scrim"); return { open: !sc.hidden, lock: !!sc.dataset.lock, title: document.getElementById("del-title").textContent, lines: q("#del-body p").map((p) => p.textContent), ok: document.getElementById("del-ok").textContent, okDis: document.getElementById("del-ok").disabled, cancelDis: document.getElementById("del-cancel").disabled, cancelHidden: document.getElementById("del-cancel").hidden, busy: q("#del-body .cf-busy .spin16").length, env: document.getElementById("del-env").hidden }; })()`);
  r = await js(`(() => { const q = (x) => [...document.querySelectorAll(x)]; q('#lib-rows .lib-row[data-id="5"]')[0].click(); const b = q("#lib-cta .btn-fill")[0]; const out = { btn: b.textContent, note: q("#lib-cta .note")[0].textContent }; b.click(); return out; })()`);
  let bx = await box();
  await js(`(() => { document.getElementById("del-cancel").click(); LIB.data.dataAccess = "billed"; document.querySelector("#lib-cta .btn-fill").click(); })()`); const bxBilled = await box();
  await js(`(() => { document.getElementById("del-cancel").click(); LIB.data.dataAccess = "included"; document.querySelector("#lib-cta .btn-fill").click(); })()`);
  ok("④ 購買框:本機按時計資料費 → 導語後接 lib.note.billed;included 不出", bxBilled.open && bxBilled.lines.length === 3 && bxBilled.lines[1] === (await T("lib.buy.lead")) && bxBilled.lines[2] === (await T("lib.note.billed")) && bx.lines.length === 2 && !bx.lines.includes(await T("lib.note.billed")), JSON.stringify([bx.lines, bxBilled.lines]));
  bx = await box();
  ok("④ 付費未購:主鈕「購買並使用 1,500 TWD」、說明 lib.note.paid(zh 沒有 fx 註);按下 → 第一段框:標題 / 價格 / .cf-note 導語 / 「確認購買」", r.btn === (await T("lib.buy", { price: "1,500 TWD" })) && r.note === (await T("lib.note.paid"))
    && bx.open && !bx.lock && bx.title === (await T("lib.buy.title", { title: "Cash-and-Carry <img onerror=x> Arbitrage" })) && bx.lines[0] === (await T("lib.buy.price", { price: "1,500 TWD" })) && bx.lines[1] === (await T("lib.buy.lead")) && bx.ok === (await T("lib.buy.ok")) && bx.env, JSON.stringify([r, bx]));
  await js(`document.getElementById("del-ok").click();`); await wait(30); bx = await box();
  r = await js(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); document.getElementById("del-scrim").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); const q = (x) => [...document.querySelectorAll(x)]; return { still: !document.getElementById("del-scrim").hidden, cta: q("#lib-cta .btn-fill")[0].textContent, dis: q("#lib-cta .btn-fill")[0].disabled, buys: window.__lib.buys, buying: LIB.buying }; })()`);
  ok("④ 購買中:框不關、兩顆鈕 disabled、圓環 + 購買中、Esc / 框外無效;詳情主鈕同步「購買中…」disabled;主行程收到 (5, false)", bx.open && bx.lock && bx.okDis && bx.cancelDis && bx.busy === 1 && bx.ok === (await T("lib.buy.busy")) && r.still && r.cta === (await T("lib.buy.busy")) && r.dis && JSON.stringify(r.buys) === "[[5,false]]" && r.buying === 5, JSON.stringify([bx, r]));
  await js(`window.__lib.buyResult = { status: 402, body: { needs_topup: true, has_card: true, balance: 100, required: 1500 } }; window.__lib.buyRelease();`); await wait(60); bx = await box();
  ok("④ 402 有卡 → 第二段:餘額 100 TWD、扣整個價格 1,500 TWD、鈕「扣款並購買」、鎖解開、cancel 可按", bx.open && !bx.lock && !bx.okDis && !bx.cancelDis && bx.lines.join("|") === (await T("lib.buy.topup", { balance: "100 TWD", price: "1,500 TWD" })) && bx.ok === (await T("lib.buy.charge")) && (await js("LIB.buying")) === null, JSON.stringify(bx));
  await js(`document.getElementById("del-ok").click();`); await wait(30);
  await js(`window.__lib.buyResult = { status: 402, body: { needs_topup: true, has_card: false, balance: 100, required: 1500 } }; window.__lib.buyRelease();`); await wait(60); bx = await box();
  ok("④ 第二段確認 → 帶 confirm_topup:true;這次回沒卡 → 框講沒綁卡、鈕「前往綁卡」", JSON.stringify(await js("window.__lib.buys")) === "[[5,false],[5,true]]" && bx.open && bx.lines.join() === (await T("lib.buy.noCard")) && bx.ok === (await T("acct.addCard")), JSON.stringify(bx));
  await js(`document.getElementById("del-ok").click();`);
  await wait(60);
  r = await js(`(() => ({ set: document.getElementById("set-scrim").hidden, cat: (document.querySelector('.set-cat[aria-current="true"]') || { dataset: {} }).dataset.setCat }))()`);
  ok("④ 「前往綁卡」→ 關框、設定開到「資料與雲端方案」", r.set === false && r.cat === "plan", JSON.stringify(r));
  await js(`setClose();`); await wait(30);
  await js(`(() => { const q = (x) => [...document.querySelectorAll(x)]; q("#lib-cta .btn-fill")[0].click(); document.getElementById("del-ok").click(); })()`); await wait(30);
  await js(`window.__lib.buyResult = { status: 409, body: { error: "purchase already in progress" } }; window.__lib.buyRelease();`); await wait(60); bx = await box();
  ok("④ 409 → 單鈕「知道了」+ lib.buy.inProgress;清單快取作廢(LIB.stale)", bx.open && bx.cancelHidden && bx.ok === (await T("cdel.gotIt")) && bx.lines.join() === (await T("lib.buy.inProgress")) && (await js("LIB.stale")) === true, JSON.stringify(bx));
  await js(`document.getElementById("del-ok").click();`); await wait(30);
  await js(`(() => { const q = (x) => [...document.querySelectorAll(x)]; q("#lib-cta .btn-fill")[0].click(); document.getElementById("del-ok").click(); })()`); await wait(30);
  await js(`window.__lib.buyResult = { status: 0, body: null }; window.__lib.buyRelease();`); await wait(60); bx = await box();
  r = await js(`(() => ({ err: [...document.querySelectorAll("#del-body .plan-err")].map((x) => x.textContent).join(), mark: document.querySelectorAll("#del-body .plan-err.is-calm .fault-mark").length }))()`);
  ok("④ 打不到 → 回第一段 + 灰記號錯誤行「購買失敗，請再試一次。」、鈕回「確認購買」;錢沒送出去", bx.open && bx.ok === (await T("lib.buy.ok")) && r.err === (await T("lib.buy.failed")) && r.mark === 1 && (await js("window.__lib.sent.length")) === 1, JSON.stringify([bx, r]));
  await js(`document.getElementById("del-ok").click();`); await wait(30);
  r = await js(`(async () => { window.__lib.buyResult = { status: 200, body: { status: "ok", strategy_id: 5 } }; window.__lib.buyRelease(); await new Promise((r) => setTimeout(r, 120));
    const q = (x) => [...document.querySelectorAll(x)]; return { del: document.getElementById("del-scrim").hidden, sent: window.__lib.sent.map((p) => p.message), pending: LIB.pending && LIB.pending.id, purchased: libFind(5).purchased, btn: q("#lib-cta .btn-fill")[0].textContent, buys: window.__lib.buys.length }; })()`);
  ok("④ 成功 → 關框、不再開下載框、本機代下載後直接送 lib.msgLocal(逐字)、進行中態、purchased=true", r.del && r.sent.length === 2 && r.sent[1] === "策略庫的「Cash-and-Carry <img onerror=x> Arbitrage」（#5）已經下載好了，幫我安裝並跑一次回測看看結果" && r.pending === 5 && r.purchased === true && r.btn === (await T("lib.pending")) && r.buys === 5, JSON.stringify(r));
  // 已購:用這支 → msgPaid,不開購買框
  r = await js(`(async () => { running = false; LIB.pending = null; libSync(); document.getElementById("lib-back").click(); const q = (x) => [...document.querySelectorAll(x)]; q('#lib-rows .lib-row[data-id="9"]')[0].click();
    const btn = q("#lib-cta .btn-fill")[0].textContent, note = q("#lib-cta .note")[0].textContent, noteHidden = q("#lib-cta .note")[0].hidden; q("#lib-cta .btn-fill")[0].click(); const title = document.getElementById("del-title").textContent; document.getElementById("del-ok").click(); await new Promise((r) => setTimeout(r, 60));
    return { btn, note, noteHidden, title, last: window.__lib.sent[window.__lib.sent.length - 1].message, buys: window.__lib.buys.length }; })()`);
  ok("④ 已購的付費策略:主鈕「用這支」、鈕下沒有說明句(那一段收著)、走下載框(不是購買框)、本機送 lib.msgLocal", r.btn === (await T("lib.use")) && r.note === "" && r.noteHidden && r.title === (await T("lib.cf.title", { title: "已買的社群策略" })) && r.last === "策略庫的「已買的社群策略」（#9）已經下載好了，幫我安裝並跑一次回測看看結果" && r.buys === 5, JSON.stringify(r));
  // en
  r = await js(`(async () => { running = false; LIB.pending = null; libFind(5).purchased = false; setLang("en"); applyStatic(); await new Promise((r) => setTimeout(r, 30)); const q = (x) => [...document.querySelectorAll(x)];
    const h = document.getElementById("lib-h").textContent; document.getElementById("lib-back").click(); q('#lib-rows .lib-row[data-id="5"]')[0].click(); const tag5 = q('#lib-cta').length;
    const note = q("#lib-cta .note")[0].textContent; document.getElementById("lib-back").click(); const priceTag = q('#lib-rows .lib-row[data-id="8"] .tag').length; const l2 = q('#lib-rows .lib-row[data-id="101"] .l2')[0].textContent;
    q('#lib-rows .lib-row[data-id="72"]')[0].click(); q("#lib-cta .btn-fill")[0].click(); document.getElementById("del-ok").click(); await new Promise((r) => setTimeout(r, 60));
    const out = { h, note, l2, last: window.__lib.sent[window.__lib.sent.length - 1].message, priceTag, owned5: q("#lib-cta .btn-fill")[0].textContent };
    setLang("zh"); applyStatic(); return out; })()`);
  ok("④ en:頁首換字、付費說明多 fx 註(en 兩句之間一個空格)、列第二行 en、本機送出的是 en 的 lib.msgLocal", r.h === "Strategy Library" && r.note.endsWith(" " + STR.en["lib.fxNote"]) && r.l2 === "Blave Official · BTC/USDT Perp · 5m · 6.5-yr sample"
    && r.last === "The library strategy \"DOGE 籌碼集中度\" (#72) is downloaded. Install it and run a backtest to see the results." && r.priceTag === 1, JSON.stringify(r));   // #8 平鋪在清單裡:只有價格一個 tag(未驗證不標)
  // 快取:每次進視圖重問主行程(綁卡 / 換帳號後閘門與 purchased 才會跟上);登出 / 登入 / 換語言 / 設定關掉 / 回前景都重問
  r = await js(`(async () => { running = false; LIB.pending = null; const n0 = window.__lib.calls.length; document.getElementById("lib-back").click();
    window.__lib.list = { strategies: ${JSON.stringify(LIST)}, signedIn: true, dataAccess: "none" }; await trOpen("over"); await libOpen(); await new Promise((r) => setTimeout(r, 60));
    const q = (x) => [...document.querySelectorAll(x)]; q('#lib-body .lib-row[data-id="101"]')[0].click(); const gated = q("#lib-cta .btn-fill").length === 0 && q("#lib-cta .btn-out").length === 1 && q("#lib-cta .note")[0].textContent === t("lib.need.unknown") + t("lib.why.unknown");
    window.__lib.list = { strategies: ${JSON.stringify(LIST)}, signedIn: true, dataAccess: "included" }; window.dispatchEvent(new Event("focus")); await new Promise((r) => setTimeout(r, 60)); const unGated = q("#lib-cta .btn-fill").length === 1 && q("#lib-cta .btn-fill")[0].textContent === t("lib.use");
    const n1 = window.__lib.calls.length; await setOpen(); setClose(); await new Promise((r) => setTimeout(r, 40)); const n2 = window.__lib.calls.length;
    libInvalidate(); await new Promise((r) => setTimeout(r, 40)); const n3 = window.__lib.calls.length, f3 = window.__lib.forces[window.__lib.forces.length - 1];
    libRefresh(); await new Promise((r) => setTimeout(r, 40)); const f4 = window.__lib.forces[window.__lib.forces.length - 1];
    setLang("en"); applyStatic(); await new Promise((r) => setTimeout(r, 40)); const langCall = window.__lib.calls[window.__lib.calls.length - 1]; setLang("zh"); applyStatic(); await new Promise((r) => setTimeout(r, 40));
    return { n0, n1, n2, n3, f3, f4, gated, unGated, langCall, last: window.__lib.calls[window.__lib.calls.length - 1], detail: libBag().detail }; })()`);
  ok("④ 進視圖重問 → 主行程說付不出資料費(沒帶 why → unknown → 描邊鈕)就擋;回前景重問 → 解;設定關掉、libInvalidate、換語言各再問一次(語言帶 en);詳情那支留著", r.n1 > r.n0 && r.gated && r.unGated && r.n2 === r.n1 + 1 && r.n3 === r.n2 + 1 && r.f3 === true && r.f4 === false && r.langCall === "en" && r.last === "zh" && r.detail === 101, JSON.stringify(r));
  // 兩邊都開著時切視角:畫的是這一邊那袋(雲端沒有對照表、{where} 是雲端主機)
  r = await js(`(async () => { LIB.bags.cloud.open = true; LIB.bags.cloud.detail = 72; document.getElementById("cv-empty").hidden = true; ENV.cur = "cloud"; envShowMain(); await new Promise((r) => setTimeout(r, 60)); const q = (x) => [...document.querySelectorAll(x)];
    const c = { lib: !document.getElementById("lib").hidden, h5: q("#lib-det h5")[0] && q("#lib-det h5")[0].textContent, where: q("#lib-cta .note")[0].textContent, painted: LIB.paintedEnv };
    ENV.cur = "local"; envShowMain(); await new Promise((r) => setTimeout(r, 60)); const l = { h5: q("#lib-det h5")[0] && q("#lib-det h5")[0].textContent, where: q("#lib-cta .note")[0].textContent, painted: LIB.paintedEnv };
    LIB.bags.cloud.open = false; LIB.bags.cloud.detail = null; return { c, l }; })()`);
  ok("④ 兩邊都開著策略庫:切到雲端畫雲端那袋的詳情(#72、說明句講雲端主機、停機 / 讀不到那句);切回本機回到 #101、說明句講這台電腦", r.c.lib && r.c.h5 === "DOGE 籌碼集中度" && r.c.painted === "cloud" && (r.c.where === (await T("ho.gate.stale")) || r.c.where === (await T("ho.gate.stopped")))
    && r.l.h5 === "BTC 通道動能共振" && r.l.painted === "local" && r.l.where === "", JSON.stringify(r));
  // 雲端視角的「已安裝」(Windows 真機補測):送出時記雲端清單(名字 → mtime)、回合結束比不到就掛著等、輪詢帶新清單來才記;不寫檔、不打端點;那支從雲端消失就拿掉;等太久就放掉。
  // 清單「缺席」(strategies_ok 不為 true)那一輪:不刪、不記、不動;等待中再送第二支 → 第一支的等待放掉;回合結束當場比到 → 清單當場重畫;同名 mtime 變了(再下載一份)→ 也算、也重畫;登出清掉
  r = await js(`(async () => { const q = (x) => [...document.querySelectorAll(x)]; running = false; LIB.pending = null; LIB.bags.cloud.open = true; LIB.bags.cloud.detail = null; document.getElementById("cv-empty").hidden = true; ENV.cur = "cloud";
    const st = (ok, list) => ({ cloud: { strategies_ok: ok, strategies: list || [{ name: "old", updated_at: 1 }] } }); const tag = (id) => q('#lib-rows .lib-row[data-id="' + id + '"] .tag').map((x) => x.textContent).join("|"); const ch = (x) => libCloudChanged(envCloudList(TR_BAGS.cloud.st = x));
    TR_BAGS.cloud.st = st(true); envShowMain(); await new Promise((r) => setTimeout(r, 60));
    const n0 = window.__lib.sent.length, p0 = window.__lib.patches.length; TR_BAGS.cloud.st = st(true); libSend(libFind(101)); await new Promise((r) => setTimeout(r, 60));
    const a = { env: LIB.pending && LIB.pending.env, before: LIB.pending && [...LIB.pending.before.entries()].join(), viewing: window.__lib.sent[n0] && window.__lib.sent[n0].viewing && window.__lib.sent[n0].viewing.env };
    TR_BAGS.cloud.st = st(true); libTurnEnd(); const b = { pending: LIB.pending, wait: LIB.cloudWait && LIB.cloudWait.id, installed: LIB.cloudInstalled["101"] };
    ch(st(true)); const c = { wait: LIB.cloudWait && LIB.cloudWait.id, tag: tag(101) };
    ch(st(false, [])); const absent = { wait: LIB.cloudWait && LIB.cloudWait.id, installed: LIB.cloudInstalled["101"], names: LIB.cloudNames };   // 缺席那一輪:等待還掛著、不猜
    ch(st(true, [{ name: "old", updated_at: 1 }, { name: "btc_cloud", updated_at: 2 }]));
    const d = { wait: LIB.cloudWait, installed: LIB.cloudInstalled["101"], tag: tag(101), cta: libInstalledOf(libFind(101)), patches: window.__lib.patches.length - p0 };
    q('#lib-rows .lib-row[data-id="101"]')[0].focus(); ch(st(true, [{ name: "old", updated_at: 1 }, { name: "btc_cloud", updated_at: 2 }])); const same = { focus: document.activeElement && document.activeElement.dataset.id };
    ch(st(false, [])); const keep = { installed: LIB.cloudInstalled["101"], tag: tag(101), name: libInstalledOf(libFind(101)) };   // 缺席:已安裝不掉
    ch(st(true)); const e = { installed: LIB.cloudInstalled["101"], tag: tag(101) };
    LIB.cloudWait = { id: 72, before: new Map([["old", 1]]), until: Date.now() - 1 }; ch(st(true)); const f = { wait: LIB.cloudWait };
    // 送出當下缺席 → before 不記;清單回來也不猜
    running = false; TR_BAGS.cloud.st = st(false, []); libSend(libFind(72)); await new Promise((r) => setTimeout(r, 60)); const g0 = { before: LIB.pending && LIB.pending.before };
    TR_BAGS.cloud.st = st(true); libTurnEnd(); ch(st(true, [{ name: "old", updated_at: 1 }, { name: "x72", updated_at: 3 }])); const g = { before: g0.before, wait: LIB.cloudWait && LIB.cloudWait.id, installed: LIB.cloudInstalled["72"] };
    LIB.cloudWait = null;
    // 等待中再送第二支 → 第一支的等待放掉、不會被第二支的資料夾記走
    running = false; TR_BAGS.cloud.st = st(true); libSend(libFind(101)); await new Promise((r) => setTimeout(r, 60)); TR_BAGS.cloud.st = st(true); libTurnEnd(); const h0 = LIB.cloudWait && LIB.cloudWait.id;
    running = false; libSend(libFind(72)); await new Promise((r) => setTimeout(r, 60)); const h1 = LIB.cloudWait; TR_BAGS.cloud.st = st(true, [{ name: "old", updated_at: 1 }, { name: "s72", updated_at: 4 }]); libTurnEnd();
    const h = { h0, h1, i101: LIB.cloudInstalled["101"], i72: LIB.cloudInstalled["72"], tag72: tag(72), tag101: tag(101) };   // turn-end 當場比到 → 列當場重畫
    // 舊策略只有 mtime 變 → 不記、等待繼續掛著(雲端 updated_at 會因內容 hash / 索引重報而動);對照表已記的那支同名 mtime 變(再下載一份)→ 算、成員沒變也重畫
    LIB.cloudInstalled = {}; LIB.cloudWait = { id: 72, before: new Map([["old", 1], ["s72", 4]]), until: Date.now() + 60000 }; LIB.cloudNames = "old\\ns72"; libPaintList(); const m0 = tag(72);
    ch(st(true, [{ name: "old", updated_at: 7 }, { name: "s72", updated_at: 4 }])); const m1 = { wait: LIB.cloudWait && LIB.cloudWait.id, installed: Object.keys(LIB.cloudInstalled).length, tag: tag(72) };
    LIB.cloudInstalled["72"] = "s72"; ch(st(true, [{ name: "old", updated_at: 7 }, { name: "s72", updated_at: 9 }])); const m = { m0, m1, wait: LIB.cloudWait, installed: LIB.cloudInstalled["72"], tag: tag(72) };
    running = false; libInvalidate(); await new Promise((r) => setTimeout(r, 60)); const inv = { installed: Object.keys(LIB.cloudInstalled).length, wait: LIB.cloudWait, names: LIB.cloudNames };
    LIB.pending = null; ENV.cur = "local"; LIB.bags.cloud.open = false; TR_BAGS.cloud.st = null; envShowMain(); return { a, b, c, absent, d, same, keep, e, f, g, h, m, inv }; })()`);
  { const V = await T("lib.verified"), F = await T("lib.free"), I = await T("lib.installed");
    ok("④ 雲端「用這支」:pending 記 env=cloud + 雲端清單(old→1)、送到雲端;turn-end → pending 收掉、比不到就掛 cloudWait;清單沒變 → 還掛著、列沒「已安裝」;缺席那一輪 → 不動;清單多了 btc_cloud → 記下(不寫檔)、列上「已安裝」、CTA 拿到名字;成員沒變不重畫(焦點留著)",
      r.a.env === "cloud" && r.a.before === "old,1" && r.a.viewing === "cloud" && r.b.pending === null && r.b.wait === 101 && r.b.installed === undefined && r.c.wait === 101 && r.c.tag === V + "|" + F
      && r.absent.wait === 101 && r.absent.installed === undefined && r.absent.names === "old" && r.d.wait === null && r.d.installed === "btc_cloud" && r.d.tag === V + "|" + F + "|" + I && r.d.cta === "btc_cloud" && r.d.patches === 0 && r.same.focus === "101", JSON.stringify(r));
    ok("④ 雲端已安裝:缺席那一輪不刪(tag 與名字都留著);那支真的消失 → 拿掉;等過期 → 放掉;送出當下缺席 → before=null、清單回來不猜;等待中再送第二支 → 第一支放掉、第二支 turn-end 當場比到 → 只記第二支、列當場重畫;舊策略只有 mtime 變 → 不記、繼續等;已記的那支同名 mtime 變 → 算、成員沒變也重畫;登出全清",
      r.keep.installed === "btc_cloud" && r.keep.tag === V + "|" + F + "|" + I && r.keep.name === "btc_cloud" && r.e.installed === undefined && r.e.tag === V + "|" + F && r.f.wait === null
      && r.g.before === null && r.g.wait === 72 && r.g.installed === undefined && r.h.h0 === 101 && r.h.h1 === null && r.h.i101 === undefined && r.h.i72 === "s72" && r.h.tag72 === V + "|" + F + "|" + I && r.h.tag101 === V + "|" + F
      && r.m.m0 === V + "|" + F && r.m.m1.wait === 72 && r.m.m1.installed === 0 && r.m.m1.tag === V + "|" + F && r.m.wait === null && r.m.installed === "s72" && r.m.tag === V + "|" + F + "|" + I && r.inv.installed === 0 && r.inv.wait === null && r.inv.names === null, JSON.stringify(r)); }
  // 讀不到 / 重試
  r = await js(`(async () => { running = false; LIB.pending = null; LIB.data = null; LIB.stale = true; window.__lib.list = null; document.getElementById("lib-back").click(); await libLoad(true); const q = (x) => [...document.querySelectorAll(x)];
    const err = { state: document.getElementById("lib-state").textContent, hidden: document.getElementById("lib-state").hidden, retry: q("#lib-state .btn-out").length, rows: q("#lib-rows .lib-row").length };
    LIB.skel = true; libPaintList(); err.sk = q("#lib-rows .sk-row").length; LIB.skel = false; libPaintList();
    window.__lib.list = { strategies: [], signedIn: true, dataAccess: "included" }; q("#lib-state .btn-out")[0].click(); await new Promise((r) => setTimeout(r, 400));
    return { err, empty: document.getElementById("lib-state").firstChild.textContent, emptyBtn: q("#lib-state .btn-out").length, rows: q("#lib-rows .lib-row").length }; })()`);
  ok("④ 讀不到 → 「讀不到策略庫。」+ 重試鈕、沒有列;skeleton 五列;重試成功但整庫空 → lib.empty + 一顆描邊填充鈕", !r.err.hidden && r.err.state.startsWith(await T("lib.error")) && r.err.retry === 1 && r.err.rows === 0 && r.err.sk === 5 && r.empty === (await T("lib.empty")) && r.emptyBtn === 1 && r.rows === 0, JSON.stringify(r));
  r = await js(`(async () => { LIB.data = null; window.__lib.list = { strategies: ${JSON.stringify(LIST)}, signedIn: true, dataAccess: "included" }; const p = libLoad(true); await new Promise((r) => setTimeout(r, 40)); const q = (x) => [...document.querySelectorAll(x)];
    const early = q("#lib-rows .sk-row").length; await p; return { early, rows: q("#lib-rows .lib-row").length, sk: q("#lib-rows .sk-row").length }; })()`);
  ok("④ 200ms 內回來:不畫 skeleton 就直接換清單", r.early === 0 && r.rows === 8 && r.sk === 0, JSON.stringify(r));
  // 視圖互斥
  r = await js(`(async () => { await trOpen("over"); const a = { lib: document.getElementById("lib").hidden, tr: document.getElementById("tr").hidden, cur: document.getElementById("lib-nav").getAttribute("aria-current"), open: libBag().open };
    await libOpen(); const b = { lib: document.getElementById("lib").hidden, tr: document.getElementById("tr").hidden, trOpen: TR_BAGS.local.open }; return { a, b }; })()`);
  ok("④ 互斥:開自動下單 → 策略庫收(入口 aria-current 拿掉);再開策略庫 → 自動下單收", r.a.lib && !r.a.tr && r.a.cur === null && r.a.open === false && !r.b.lib && r.b.tr && r.b.trOpen === false, JSON.stringify(r));
  r = await js(`(() => { document.getElementById("chat-lib").click(); return { sent: window.__lib.sent.length, opened: window.__lib.opened, tools: [...document.querySelectorAll("#lib-head-list .lib-tools > *")].map((x) => x.id || x.className).join() }; })()`);
  await wait(30);
  ok("④ 歡迎頁 chip 只開策略庫不送訊息;整個流程沒有開過外部瀏覽器;工具列只剩市場分段", r.opened === undefined && r.sent === (await js("window.__lib.sent.length")) && r.tools === "lib-seg", JSON.stringify(r));

  console.log(red ? `\n④ ${red} 紅` : "\n④ ALL PASS");
  app.exit(red ? 1 : 0);
});
