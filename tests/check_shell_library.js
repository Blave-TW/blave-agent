// 策略庫(shell/renderer/library.js + main.js 的 libraryList / libraryPurchase / libraryInstalled + 接線)。
//   ① 純邏輯(從原文切出來跑,不碰 DOM):市場分段、一份清單的排序(官方 / 已驗證 → 未驗證;0.1.6 §2 平鋪)、CTA 十一態的先後與 noData 的 why、送給 agent 的那句話(逐字同 web
//      workspace_lib_msg / _paid)、價格 / 餘額的格式、購買回應的分支、曲線時間軸。
//   ② 主行程:libSanitize 壞形狀 → 整筆丟 / 清單不是陣列 → null、控制字元、spark / gate_checks;已安裝對照表的讀寫與清洗。
//   ③ 接線(原文):index.html 的入口 / chip / 視圖 / 載入順序;envShowMain 兩個分支都問 libShowMain 且原本那幾行沒動;
//      三個開別的視圖的地方都 libLeave;回合三個出口都 libSync;turn-end 等 stratRefresh 回來才 libTurnEnd;delClose 認 lock;
//      preload / main 的三支 IPC(購買只收自家頁面);字串表 zh / en 都齊;library.js 沒有 innerHTML。
//   ④ 用隨包的 Electron 開真的 index.html:清單順序與 tag、分段、詳情、CTA 閘門態、「用這支」→ 確認框 → 逐字那句話 → 進行中
//      → turn-end 記對照表 → 已安裝;沒新策略的灰字;購買框六個分支(第一段、購買中鎖框、餘額不足有卡第二段、沒卡、409、失敗行、
//      成功後直接送 lib.msgPaid);en 的價格與那句話;api 來的字只進 textContent。
// 跑法:node tests/check_shell_library.js(找不到 shell/node_modules 的 Electron 時 ④ SKIP,①②③ 照跑)
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
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
  // ── ① 純邏輯 ──
  const a = src.indexOf("/* ── 純邏輯("), b = src.indexOf("/* ── 純邏輯到此");
  if (a < 0 || b < 0) throw new Error("找不到純邏輯區塊的標記");
  const block = src.slice(a, b);
  ok("① 純邏輯區塊不碰 DOM / i18n", !/\bdocument\b|\$\(|window\.|\bt\(/.test(block.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  const P = {}; vm.createContext(P); vm.runInContext(block.replace(/^const /gm, "var "), P);
  ok("① 市場分段:category 含 TW / 台 → 台股;否則看 symbol(TXF / 純數字代號 → 台股);其餘與空標的 → 加密", P.libMarket({ category: "TW Stock" }) === "tw" && P.libMarket({ category: "台股", report: { symbol: "BTCUSDT" } }) === "tw"
    && P.libMarket({ category: "trend", report: { symbol: "TXF" } }) === "tw" && P.libMarket({ category: "bundle", report: { symbol: "2330" } }) === "tw" && P.libMarket({ category: "Crypto", report: { symbol: "BTCUSDT" } }) === "crypto"
    && P.libMarket({ category: "network", report: { symbol: "" } }) === "crypto" && P.libMarket({}) === "crypto" && P.libMarket(null) === "crypto");
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
  ok("① 週期正規化同 web intervalKey", P.libIvKey("5min") === "5m" && P.libIvKey("60m") === "1h" && P.libIvKey("1d") === "1d" && P.libIvKey("240min") === "4h" && P.libIvKey("8h") === "8h" && P.libIvKey("480min") === "8h" && P.libIvKey("2h") === "2h" && P.libIvKey("720m") === "12h" && P.libIvKey("3m") === null && P.libIvKey(null) === null);

  // ── ② 主行程 ──
  const M = {}; vm.createContext(M);
  vm.runInContext(["LIB_TITLE_MAX", "LIB_DAY_RE", "libFin", "libDay", "libCurveOk", "LIB_NAME_RE"].map((n) => mainSrc.match(new RegExp("^const " + n + " = [^\\n]*$", "m"))[0].replace(/^const /, "var ")).join("\n") + "\n" + cutFn(mainSrc, "libSanitize") + "\n" + cutFn(mainSrc, "libInstalledClean") + "\n" + cutFn(mainSrc, "libReportSanitize"), M);
  ok("② 清單不是陣列 / body 不是物件 → null", M.libSanitize(null) === null && M.libSanitize({}) === null && M.libSanitize({ strategies: "x" }) === null && M.libSanitize([]) === null);
  const good = M.libSanitize({ strategies: LIST });
  ok("② 好的清單逐筆過、欄位齊、多出來的欄位不帶;report 多收 total_return 與 gates 的四個數字(其餘不帶)", good.length === LIST.length && good[0].id === 101 && good[0].report.spark.length === 64 && good[0].report.gate_checks.mcpt === "pass" && !("success_note_ids" in good[0]) && good[6].report === null
    && good[0].report.total_return === 312.5 && JSON.stringify(good[0].report.gates) === '{"mcpt_p":0.0004,"robust":{"ratio":0.91},"fee":{"rate":0.0005,"actual":0.0004}}' && good[4].report.gates === null);
  ok("② gates 有格壞 / 缺格 → 那格 null、其餘照收;gates 不是物件 → null;total_return 不是數 → null", JSON.stringify(M.libSanitize({ strategies: [S({ report: REP({ total_return: "9", gates: { mcpt_p: "x", robust: 5, fee: { rate: 0.0005 } } }) })] })[0].report.gates) === '{"mcpt_p":null,"robust":{"ratio":null},"fee":{"rate":0.0005,"actual":null}}'
    && M.libSanitize({ strategies: [S({ report: REP({ total_return: "9", gates: [] }) })] })[0].report.gates === null && M.libSanitize({ strategies: [S({ report: REP({ total_return: "9" }) })] })[0].report.total_return === null);
  const rep = M.libReportSanitize(REPORT);
  ok("② libReportSanitize:只留 400 點曲線 + 兩組日期、其餘欄位不帶;曲線 401 點 / 有 0 / 不是陣列 → null;日期只認 YYYY-MM-DD;body 不是物件 → null", JSON.stringify(Object.keys(rep)) === '["equity","equity_from","equity_to","backtest_start","backtest_end"]' && rep.equity.length === 400 && rep.backtest_start === "2019-12-02" && rep.equity_to === "2026-06-30"
    && M.libReportSanitize(Object.assign({}, REPORT, { equity: Array(401).fill(1) })).equity === null && M.libReportSanitize(Object.assign({}, REPORT, { equity: [1, 0] })).equity === null && M.libReportSanitize(Object.assign({}, REPORT, { equity: null, backtest_start: "2019-12-02 00:00:00" })).backtest_start === null
    && M.libReportSanitize(null) === null && M.libReportSanitize("x") === null);
  ok("② 全空的報告(200 + 全 null,S3 暫時讀不到)→ null、不進快取;只有回測期間也算有東西", M.libReportSanitize({}) === null && M.libReportSanitize({ equity: null, equity_from: null, equity_to: null, backtest_start: null, backtest_end: null }) === null
    && M.libReportSanitize({ equity: [1, 0], backtest_start: "2020-01-01", backtest_end: "2021-01-01" }).equity === null && M.libReportSanitize({ backtest_start: "2020-01-01", backtest_end: "2021-01-01" }).backtest_end === "2021-01-01");
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

  // ── ③ 接線 ──
  ok("③ index.html:側欄「策略庫」在「自動下單」後、同一個 #side-nav 裡;歡迎頁多一顆 #chat-lib 在 #chat-eg 前;#lib 在 #rp 後、#main-empty 前;library.css;library.js 在 handoff.js 後、app.js 前",
    html.indexOf('id="lib-nav"') > html.indexOf('id="tr-nav"') && html.indexOf('id="lib-nav"') < html.indexOf("</nav>") && html.indexOf('id="chat-lib"') < html.indexOf('id="chat-eg"') && html.indexOf('id="chat-lib"') > html.indexOf('class="wc-chips"')
    && html.indexOf('id="lib"') > html.indexOf('id="rp"') && html.indexOf('id="lib"') < html.indexOf('id="main-empty"') && /<link rel="stylesheet" href="library\.css">/.test(html) && /<script src="handoff\.js"><\/script>\s*<script src="library\.js"><\/script>\s*<script src="app\.js">/.test(html));
  ok("③ #lib 的骨架:region + aria-labelledby 到 h5、h5 tabindex=-1、分段 group 三顆、返回鈕、#lib-body tabindex=0、#lib-state role=status", /<div class="lib" id="lib" role="region" aria-labelledby="lib-h" hidden>/.test(html) && /<h5 class="main-head-name" id="lib-h" tabindex="-1" data-i18n="lib\.nav">/.test(html)
    && (html.match(/data-mkt="(all|crypto|tw)"/g) || []).length === 3 && /<button class="lib-back" id="lib-back" type="button" hidden>/.test(html) && /<div class="lib-body" id="lib-body" tabindex="0">/.test(html) && /<p class="lib-state" id="lib-state" role="status" hidden>/.test(html));
  ok("③ 社群段拆了(0.1.6 §2):index.html / library.js / library.css 沒有 lib-comm、字串表沒有 lib.comm.*;閘門卡的殼 #lib-gate 在 #lib-rows 之前(預設 hidden)", !/lib-comm/.test(html) && !/lib-comm|\.comm\b|library_comm/.test(src) && !/lib-comm/.test(read(path.join(R, "library.css")))
    && ["lib.comm.title", "lib.comm.sub", "lib.gate.noData"].every((k) => !(k in STR.zh) && !(k in STR.en)) && html.indexOf('id="lib-gate"') > html.indexOf('id="lib-body"') && html.indexOf('id="lib-gate"') < html.indexOf('id="lib-rows"') && /<div class="lib-gate" id="lib-gate" hidden>/.test(html));
  ok("③ 不導流:沒有 #lib-web、library.js 不 openExternal / 不寫 blave.org、lib.web / lib.hiddenNote 兩語都刪了;lib.* 裡提到網頁版的只剩投稿那句腳注(純文字)", !/lib-web|lib\.web/.test(html) && !/openExternal|blave\.org/.test(src) && ["lib.web", "lib.hiddenNote"].every((k) => !(k in STR.zh) && !(k in STR.en))
    && Object.keys(STR.zh).filter((k) => k.startsWith("lib.") && /網頁/.test(STR.zh[k])).join() === "lib.foot" && Object.keys(STR.en).filter((k) => k.startsWith("lib.") && /\bweb\b/i.test(STR.en[k])).join() === "lib.foot");
  { const esm = cutFn(trSrc, "envShowMain");
    ok("③ envShowMain:雲端分支帶 gate 問 libShowMain 再問 rptShowMain、本機分支問 libShowMain(false) 再 rptShowMain(false);原本被別支測試釘住的那幾行一字不動", /if \(typeof libShowMain === "function"\) libShowMain\(gate\);\s*\/\/[^\n]*\n\s*if \(typeof rptShowMain === "function"\) rptShowMain\(gate\);[^\n]*\n\s*return;/.test(esm) && /libShowMain\(false\);\n  if \(typeof rptShowMain === "function"\) rptShowMain\(false\);\n\}$/.test(esm)
      && /const gate = !\$\("cv-empty"\)\.hidden, rp = !gate && typeof RPC !== "undefined" && !!\(RPC\.name && RPC\.data\);/.test(esm) && /\$\("rp"\)\.hidden = !rp; \$\("main-empty"\)\.hidden = true; \$\("tr"\)\.hidden = gate \|\| rp;/.test(esm)); }
  ok("③ 開別的視圖就 libLeave:trOpen(那一邊)、stratSelect(本機,選了才)、rpCloudSelect(雲端,選了才)", /if \(typeof libLeave === "function"\) libLeave\(S\.env\);/.test(cutFn(trSrc, "trOpen"))
    && /if \(name && typeof libLeave === "function"\) libLeave\("local"\);/.test(cutFn(appSrc, "stratSelect")) && /if \(name && typeof libLeave === "function"\) libLeave\("cloud"\);/.test(cutFn(appSrc, "rpCloudSelect")));
  ok("③ 回合的三個出口(上鎖、失敗解鎖、turn-end)都叫 libSync;turn-end 等 stratRefresh(true) 回來才 libTurnEnd;trPoll 每次讀到雲端清單都叫 libCloudChanged(緊接 rpCloudPrune)", (appSrc.match(/if \(typeof libSync === "function"\) libSync\(\);/g) || []).length === 3
    && /stratRefresh\(true\)\.catch\(\(\) => \{\}\)\.then\(\(\) => \{ if \(typeof libTurnEnd === "function"\) libTurnEnd\(\); if \(typeof rptTurnEnd === "function"\) rptTurnEnd\(\); \}\);/.test(appSrc.slice(appSrc.indexOf("window.blave.onTurnEnd(")))
    && /rpCloudPrune\(C\.list\);[^\n]*\n\s*if \(typeof libCloudChanged === "function"\) libCloudChanged\(C\.list\);/.test(cutFn(trSrc, "trPoll")));
  ok("③ 快取作廢的四個事件都接了:登出 / 兩條登入路徑 → libInvalidate;設定關掉 → libRefresh;主行程登出(clearToken)與換 token 都清 libCache;購買成功後 libRefresh", (appSrc.match(/if \(typeof libInvalidate === "function"\) libInvalidate\(\);/g) || []).length === 3
    && /if \(typeof libRefresh === "function"\) libRefresh\(\);/.test(cutFn(appSrc, "setClose")) && /libCache = null;/.test(cutFn(mainSrc, "clearToken")) && (mainSrc.match(/^\s*libCache = null;/gm) || []).length === 3
    && /libSend\(s\); libRefresh\(\); return;/.test(src) && /function libRepaint\(\) \{ if \(\$\("lib"\)\.hidden\) return; LIB\.reports\.clear\(\); libPaint\(\); if \(LIB\.data && LIB\.data\.lang !== LANG\) libLoad\(false\); \}/.test(src) && /window\.addEventListener\("focus", \(\) => libRefresh\(\)\);/.test(src));
  ok("③ 每次進視圖都重問主行程;切視角時畫的是這一邊那袋;pending 記的是 name → mtime 的 Map", /envShowMain\(\);\n\s*libLoad\(false\);/.test(src) && /if \(on && \(!was \|\| LIB\.paintedEnv !== libEnv\(\)\)\) \{ libPaint\(\); if \(was\) libLoad\(false\); \}/.test(src)
    && /cl = env === "cloud" \? libCloudList\(\) : RP\.list, before = cl \? new Map\(cl\.map\(\(x\) => \[x\.name, x\.mtime\]\)\) : null;/.test(src) && /p\.before\.get\(x\.name\) !== x\.mtime/.test(src) && !/libShort/.test(src)
    && /const libCloudOk = \(\) => !!\(TR_BAGS\.cloud\.st && TR_BAGS\.cloud\.st\.cloud && TR_BAGS\.cloud\.st\.cloud\.strategies_ok === true\);/.test(src) && /function libInvalidate\(\) \{ LIB\.stale = true; LIB\.cloudInstalled = \{\}; LIB\.cloudWait = null; LIB\.cloudNames = null; libRefresh\(\); \}/.test(src));
  ok("③ applyStatic 換語言重畫;stratRefresh 重建列後 libStratChanged;delClose 認 dataset.lock(購買中 Esc / ✕ / 框外都不關)", /if \(typeof libRepaint === "function"\) libRepaint\(\);/.test(cutFn(appSrc, "applyStatic"))
    && /if \(typeof libStratChanged === "function"\) libStratChanged\(\);/.test(cutFn(appSrc, "stratRefresh")) && /if \(sc\.hidden \|\| sc\.dataset\.lock\) return;/.test(cutFn(appSrc, "delClose")));
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

  // ── ④ 交給 Electron ──
  const bin = path.join(SHELL, "node_modules", ".bin", "electron");
  if (!fs.existsSync(bin)) { console.log("SKIP  ④ 找不到 shell/node_modules 的 Electron(先 cd shell && npm install)"); console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  const sub = r.status == null ? 1 : r.status;
  console.log(red || sub ? `\n${red + sub} 紅` : "\nALL PASS");
  process.exit(red || sub ? 1 : 0);
}

const { app, BrowserWindow } = require("electron");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-library-")));
const STUB = `window.__lib = { calls: [], list: ${JSON.stringify({ strategies: LIST, signedIn: true, dataAccess: "included" })}, patches: [], installed: {}, sent: [], sendResult: { started: true }, strats: [], buys: [], buyResult: { status: 0, body: null }, buyRelease: null, hasToken: true,
  reportCalls: [], report: ${JSON.stringify(REPORT)} };
const __fixed = {
  getLocale: async () => "zh-TW", loadConnection: async () => ({ kind: "claude" }), detectAgents: async () => ({ claude: { installed: true, loggedIn: true }, codex: { installed: false } }),
  listStrategies: async () => window.__lib.strats, listSessions: async () => [], loadSession: async () => [], loadSessionImages: async () => [], updateState: async () => ({ phase: "idle", current: "0.0.0" }),
  hasBlaveToken: async () => window.__lib.hasToken, ensureEngine: async () => ({}), loadStrategy: async (n) => ({ name: n, stats: null, code: "x", scan: null }),
  libraryList: async (lang) => { window.__lib.calls.push(lang); return window.__lib.list; }, libraryInstalled: async (p) => { if (p) { window.__lib.patches.push(p); if (p.name === null) delete window.__lib.installed[String(p.id)]; else window.__lib.installed[String(p.id)] = p.name; } return Object.assign({}, window.__lib.installed); },
  sendMessage: async (p) => { window.__lib.sent.push(p); return window.__lib.sendResult; },
  libraryPurchase: (id, c) => new Promise((res) => { window.__lib.buys.push([id, c]); window.__lib.buyRelease = () => res(window.__lib.buyResult); }),
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
      ids: q("#lib-rows .lib-row").map((b) => b.dataset.id).join(), foot: document.getElementById("lib-foot").textContent, hiddenFoot: document.getElementById("lib-foot").hidden, footLinks: q("#lib-foot a, #lib-foot button").length, web: document.getElementById("lib-web"),
      gate: document.getElementById("lib-gate").hidden, comm: document.getElementById("lib-comm"), chev: q("#lib [aria-expanded]").length,
      tags12: q('#lib-rows .lib-row[data-id="12"] .tag').map((x) => x.textContent).join("|"), tags8: q('#lib-rows .lib-row[data-id="8"] .tag').map((x) => x.textContent + ":" + x.className).join("|"), l2_12: q('#lib-rows .lib-row[data-id="12"] .l2')[0].textContent,
      tags101: q('#lib-rows .lib-row[data-id="101"] .tag').map((x) => x.textContent).join("|"), tags5: q('#lib-rows .lib-row[data-id="5"] .tag').map((x) => x.textContent).join("|"), tags9: q('#lib-rows .lib-row[data-id="9"] .tag').map((x) => x.textContent).join("|"), tag5gap: (() => { const p = q('#lib-rows .lib-row[data-id="5"] .tag.is-price')[0]; const a = p.children[0].getBoundingClientRect(), b = p.children[1].getBoundingClientRect(); return p.children.length === 2 && p.children[1].textContent === "TWD" && b.left - a.right >= 3; })(),
      l2: q('#lib-rows .lib-row[data-id="101"] .l2')[0].textContent, ann: q('#lib-rows .lib-row[data-id="101"] .num .v')[0].textContent, annCls: q('#lib-rows .lib-row[data-id="101"] .num .v')[0].className, annColor: getComputedStyle(q('#lib-rows .lib-row[data-id="101"] .num .v')[0]).color, inkColor: getComputedStyle(q('#lib-rows .lib-row[data-id="101"] .t')[0]).color, greenText: getComputedStyle(document.documentElement).getPropertyValue("--color-greenText").trim(),
      imgs: q("#lib img").length, title5: q('#lib-rows .lib-row[data-id="5"] .t')[0].textContent, tags86: q('#lib-rows .lib-row[data-id="86"] .tag').map((x) => x.textContent).join("|"), focus: document.activeElement && document.activeElement.id }; })()`);
  ok("④ 開策略庫:#lib 出、入口 aria-current、歡迎頁與自動下單收;一份清單 8 列照推薦排序(未驗證的兩支在尾);焦點在 h5;沒有「在網頁版看」鈕;清單底只有投稿那句純文字腳注(沒有連結 / 鈕);有資料時閘門卡不出", r.on && r.cur === "page" && r.empty && r.tr && r.ids === "74,101,72,5,9,86,12,8" && r.focus === "lib-h"
    && r.web === null && !r.hiddenFoot && r.foot === (await T("lib.foot")) && r.footLinks === 0 && r.gate === true, JSON.stringify(r));
  ok("④ 社群平鋪(0.1.6 §2):未驗證的兩支直接列在清單尾(新的先)、tag 順序「未驗證」(單層灰、沒有 is-verified)→ 價格、第二行「社群作者」;沒有 disclosure 列、沒有 chevron", r.comm === null && r.chev === 0 && r.tags12 === (await T("lib.unverified")) + "|800TWD" && /^未驗證:tag\|1,200TWD:tag is-price$/.test(r.tags8) && r.l2_12.startsWith((await T("lib.community")) + " · "), JSON.stringify(r));
  ok("④ 列:tag(已驗證 + 免費 / 價格 1,500 TWD / 已購買)、第二行「Blave 官方 · BTC/USDT 永續 · 5 分 K · 樣本 6.5 年」、年化 +24.61% 綠字;api 來的字只進 textContent(沒有 img)",
    r.tags101 === (await T("lib.verified")) + "|" + (await T("lib.free")) && r.tags5 === (await T("lib.verified")) + "|1,500TWD" && r.tag5gap && r.tags9 === (await T("lib.verified")) + "|" + (await T("lib.owned"))
    && r.l2 === "Blave 官方 · BTC/USDT 永續 · 5 分 K · 樣本 6.5 年" && r.ann === "+24.61%" && /\bup\b/.test(r.annCls) && r.annColor !== r.inkColor && r.imgs === 0 && r.title5 === "Cash-and-Carry <img onerror=x> Arbitrage"
    && r.tags86 === (await T("lib.free")), JSON.stringify(r));   // 官方但未驗證(#86):既無「已驗證」也無「未驗證」
  r = await js(`(() => { const q = (x) => [...document.querySelectorAll(x)]; q('#lib-seg button[data-mkt="tw"]')[0].click(); const tw = q("#lib-rows .lib-row").map((b) => b.dataset.id).join(), twState = document.getElementById("lib-state").hidden;
    q('#lib-seg button[data-mkt="crypto"]')[0].click(); const cr = q("#lib-rows .lib-row").map((b) => b.dataset.id).join(), foot = document.getElementById("lib-foot").textContent; const pressed = q("#lib-seg button").map((b) => b.getAttribute("aria-pressed")).join();
    q('#lib-seg button[data-mkt="all"]')[0].click(); return { tw, twState, cr, foot, pressed, all: q("#lib-rows .lib-row").length }; })()`);
  ok("④ 分段:台股 1 支;加密 7 支(未驗證的兩支在尾);腳注照在;按下的那格 aria-pressed;回全部 8", r.tw === "74" && r.twState && r.cr === "101,72,5,9,86,12,8" && r.foot === (await T("lib.foot")) && r.pressed === "false,true,false" && r.all === 8, JSON.stringify(r));
  // 只有未驗證的社群策略:照列(不再有「主段空」這回事);切到台股 0 列 → lib.emptyMkt
  r = await js(`(async () => { const q = (x) => [...document.querySelectorAll(x)]; const keep = window.__lib.list; window.__lib.list = { strategies: ${JSON.stringify([LIST[4], LIST[5]])}, signedIn: true, dataAccess: "included" }; await libLoad(true);
    const a = { state: document.getElementById("lib-state").hidden, ids: q("#lib-rows .lib-row").map((b) => b.dataset.id).join(), foot: document.getElementById("lib-foot").hidden };
    q('#lib-seg button[data-mkt="tw"]')[0].click(); const b = { state: document.getElementById("lib-state").hidden, text: document.getElementById("lib-state").textContent, n: q("#lib-rows .lib-row").length };
    q('#lib-seg button[data-mkt="all"]')[0].click(); window.__lib.list = keep; await libLoad(true); return { a, b, back: q("#lib-rows .lib-row").length }; })()`);
  ok("④ 只有未驗證的社群策略時:兩支照列(新的先)、不出空狀態;切到台股 0 列 → lib.emptyMkt", r.a.state && r.a.ids === "12,8" && !r.a.foot && !r.b.state && r.b.text === (await T("lib.emptyMkt")) && r.b.n === 0 && r.back === 8, JSON.stringify(r));
  // 詳情
  const gatesOf = `q("#lib-det .gates li").map((li) => li.querySelector(".gn").textContent + "=" + li.querySelector(".gr > .gv").textContent + "[" + [...li.querySelectorAll(".gr > .gx")].map((x) => x.textContent).join(";") + "]").join("|")`;
  r = await js(`(async () => { const q = (x) => [...document.querySelectorAll(x)]; window.__lib.reportCalls = []; q('#lib-rows .lib-row[data-id="101"]')[0].click(); const c0 = LIB.chart;
    const sync = { back: !document.getElementById("lib-back").hidden, headList: document.getElementById("lib-head-list").hidden, rows: q("#lib-rows .lib-row").length, gate: document.getElementById("lib-gate").hidden, foot: document.getElementById("lib-foot").hidden, h5: q("#lib-det h5")[0].textContent, meta: q("#lib-det .lib-meta")[0].textContent, sum: q("#lib-det .lib-sum")[0].textContent,
      chart: q("#lib-det .lib-card .chart").length, chartH: q("#lib-det .lib-card .chart")[0].getBoundingClientRect().height, canvas: q("#lib-det .lib-card .chart canvas").length, kv: q("#lib-det .lib-kv .k").map((x) => x.textContent).join("|") + " / " + q("#lib-det .lib-kv .v").map((x) => x.textContent).join("|"), gates: ${gatesOf}, lead: q("#lib-det .lib-card")[1].querySelector(".lib-p"),
      how: q("#lib-det .lib-p")[0].textContent, dl: q("#lib-det .lib-dl dd").map((x) => x.textContent).join("|"), period: document.getElementById("lib-period").textContent, steps: q("#lib-det .steps li").length, cta: q("#lib-cta .btn-fill")[0].textContent, note: q("#lib-cta .note")[0].textContent, focus: document.activeElement && document.activeElement.id, c0: !!c0 };
    await new Promise((r) => setTimeout(r, 80));
    const after = { calls: window.__lib.reportCalls, swapped: LIB.chart !== c0 && !!LIB.chart, chart: q("#lib-det #lib-chart").length, canvas: q("#lib-det #lib-chart canvas").length, period: document.getElementById("lib-period").textContent, periodMono: q("#lib-period .mono").length, focus: document.activeElement && document.activeElement.id, h5: q("#lib-det h5").length, cta: q("#lib-cta .btn-fill")[0].textContent };
    return { sync, after }; })()`);
  { const s = r.sync;
    ok("④ 詳情:返回鈕出、清單頭 / 閘門卡 / 腳注收;標題 / meta(7 人安裝)/ 摘要;曲線先用 spark 畫出來(canvas、圖高 200);回測欄總報酬在第一列 + 四個數字 + 上架兩格;三道關卡都通過、右欄帶數值(費率兩行、p < 0.001、鄰域 91%);官方不出結論段;說明留換行;dl 回測期間先用曲線區間 / 標的 / 方向 / 曝險;沒有「用了之後」卡;焦點在返回鈕",
      s.back && s.headList && s.rows === 0 && s.gate && s.foot && s.h5 === "BTC 通道動能共振" && s.meta === "Blave 官方 · BTC/USDT 永續 · 5 分 K · 7 人安裝" && s.sum === "通道 + 動能。" && s.chart === 1 && s.chartH === 200 && s.canvas >= 1 && s.c0
      && s.kv === "總報酬|年化|Sharpe|最大回撤|樣本|上架天數|安裝 / +312.50%|+24.61%|1.50|−20.00%|6.5 年|107|7".replace("107", String(Math.max(0, Math.floor((Date.now() - Date.parse("2026-06-10T00:00:00")) / 86400000))))
      && s.gates === "誠實回測=通過[假設 0.05%;交易所 0.04%]|統計顯著=通過[p < 0.001]|參數穩健=通過[鄰域保留 91%]" && s.lead === null
      && s.how === "第一段。\n第二段。" && s.dl === "2020-01-01 — 2026-06-30|BTC/USDT 永續 · 5 分 K|純做多|1 倍" && s.period === "2020-01-01 — 2026-06-30" && s.steps === 0 && s.focus === "lib-back", JSON.stringify(s));
    ok("④ 免費態:主鈕「用這支」、說明句只講價格", s.cta === (await T("lib.use")) && s.note === (await T("lib.note.free")), JSON.stringify(s.note)); }
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
  ok("④ #8(沒 gate_checks):badge「未驗證」在最前、關卡卡只有一句 lib.gates.community、不列三道、CTA 仍「購買並使用 1,200 TWD」;返回焦點回那一列", r.a.tags === (await T("lib.unverified")) + "|1,200TWD" && r.a.card === (await T("lib.gates.title")) && r.a.p === (await T("lib.gates.community")) && r.a.lis === 0 && r.a.cta === (await T("lib.buy", { price: "1,200 TWD" })) && r.focus8 === "8", JSON.stringify(r));
  ok("④ #12(兩道 fail):關卡卡第一段「未驗證：2 道關卡未通過…」(2 進 .mono、在 ul 之前),兩道「未通過」紅字 + 數值(假設 0.03% / 交易所 0.04%、p = 0.1200、鄰域 82%);CTA「購買並使用 800 TWD」、說明句沒有恐嚇語", r.b.tags === (await T("lib.unverified")) + "|800TWD" && r.b.p === (await T("lib.gates.failed", { k: 2 })) && r.b.k === "2" && r.b.first === "lib-p"
    && r.b.gates === "誠實回測=未通過[假設 0.03%;交易所 0.04%]|統計顯著=未通過[p = 0.1200]|參數穩健=通過[鄰域保留 82%]" && r.b.down === "未通過|未通過" && r.b.downColor !== r.b.gxColor && r.b.cta === (await T("lib.buy", { price: "800 TWD" })) && r.b.note === (await T("lib.note.paid")), JSON.stringify(r));
  // 閘門態
  const cta = () => js(`(() => { const q = (x) => [...document.querySelectorAll(x)]; const b = q("#lib-cta .btn-fill")[0], qb = q("#lib-cta .btn-quiet"); return { btn: b ? b.textContent : null, dis: b ? b.disabled : null, quiet: qb.map((x) => x.textContent).join("|"), note: q("#lib-cta .note")[0].textContent, up: q("#lib-cta .note")[0].classList.contains("up"), err: q("#lib-cta .err").map((x) => x.textContent).join() }; })()`);
  await js(`hasToken = false; libSync();`); r = await cta();
  ok("④ 未登入(0.1.6 §3.2 末):主鈕「登入 Blave」、閘門句升一階、沒有文字鈕", r.btn === (await T("cn.blave.btn")) && r.dis === false && r.up && r.quiet === "" && r.note === (await T("lib.gate.signedOut")), JSON.stringify(r));
  r = await js(`(async () => { const q = (x) => [...document.querySelectorAll(x)]; q("#lib-cta .btn-fill")[0].click(); await new Promise((r) => setTimeout(r, 60)); const out = { set: !document.getElementById("set-scrim").hidden, cat: (document.querySelector('.set-cat[aria-current="true"]') || { dataset: {} }).dataset.setCat }; setClose(); return out; })()`);
  ok("④ 「登入 Blave」→ 設定 › 帳號", r.set && r.cat === "acct", JSON.stringify(r));
  // 付不出資料費(0.1.6 §3.2):主鈕照 why 分流、鈕下說明升一階;試用天數來自 planVars().t(acct.trial_days),不寫死
  await js(`hasToken = true; LIB.data.dataAccess = "none"; LIB.data.why = "no_card"; acct = { trial_eligible: true, trial_days: 14 }; libSync();`); r = await cta();
  ok("④ no_card 有試用:主鈕「綁卡，送 14 天資料」、說明只有「還沒綁卡…」(天數鈕字已講,不接 data.noCardSub);沒有文字鈕", r.btn === (await T("lib.gate.bindCard", { t: 14 })) && r.dis === false && r.up && r.quiet === "" && r.note === (await T("lib.gate.noCard")), JSON.stringify(r));
  await js(`acct = { trial_eligible: false, trial_days: 14 }; libSync();`); r = await cta();
  ok("④ no_card 沒試用:「前往綁卡」、說明只有第一句", r.btn === (await T("plan.addCard")) && r.note === (await T("lib.gate.noCard")), JSON.stringify(r));
  await js(`acct = { trial_eligible: true }; pub = null; libSync();`); r = await cta();
  ok("④ no_card 但天數查不到(t 空):也退到「前往綁卡」", r.btn === (await T("plan.addCard")) && r.note === (await T("lib.gate.noCard")), JSON.stringify(r));
  await js(`LIB.data.why = "no_balance"; libSync();`); r = await cta();
  ok("④ no_balance:「儲值」+ 說明「這一小時付不出…儲值後馬上恢復」", r.btn === (await T("lib.gate.topup")) && r.note === (await T("lib.gate.noBalance")), JSON.stringify(r));
  await js(`LIB.data.why = "unknown"; libSync();`); r = await js(`(() => { const q = (x) => [...document.querySelectorAll(x)]; return { fill: q("#lib-cta .btn-fill").length, out: q("#lib-cta .btn-out").map((b) => b.textContent).join(), note: q("#lib-cta .note")[0].textContent }; })()`);
  ok("④ unknown:描邊「資料與雲端方案」(查不到狀態不擺要錢的主鈕)+ 說明「現在查不到…」", r.fill === 0 && r.out === (await T("set.cat.plan")) && r.note === (await T("lib.gate.unknown")), JSON.stringify(r));
  r = await js(`(async () => { const q = (x) => [...document.querySelectorAll(x)]; q("#lib-cta .btn-out")[0].click(); await new Promise((r) => setTimeout(r, 60)); const a = { set: !document.getElementById("set-scrim").hidden, cat: (document.querySelector('.set-cat[aria-current="true"]') || { dataset: {} }).dataset.setCat }; setClose();
    document.getElementById("lib-back").click(); LIB.data.why = "no_balance"; document.getElementById("lib-h").focus(); libPaintList(); const g = document.getElementById("lib-gate");
    const b = { hidden: g.hidden, text: g.querySelector("p") && g.querySelector("p").textContent, btn: g.querySelector("button") && g.querySelector("button").textContent + ":" + g.querySelector("button").className, rows: q("#lib-rows .lib-row").length, focus: document.activeElement && document.activeElement.id, above: g.getBoundingClientRect().bottom <= q("#lib-rows .lib-row")[0].getBoundingClientRect().top };
    LIB.data.signedIn = false; libPaintList(); const c = { hidden: g.hidden }; LIB.data.signedIn = true;
    LIB.bags.cloud.open = true; document.getElementById("cv-empty").hidden = true; ENV.cur = "cloud"; envShowMain(); await new Promise((r) => setTimeout(r, 60)); const d = { hidden: g.hidden, lib: !document.getElementById("lib").hidden }; ENV.cur = "local"; LIB.bags.cloud.open = false; envShowMain(); await new Promise((r) => setTimeout(r, 60));
    LIB.data.dataAccess = "included"; LIB.data.why = null; libPaintList(); const e = { hidden: g.hidden }; q('#lib-rows .lib-row[data-id="101"]')[0].click(); return { a, b, c, d, e }; })()`);
  ok("④ 鈕開到 設定 › 資料與雲端方案;清單頂端閘門卡(§3.3):本機 none 才出——一句(同鈕下說明第一句)+ 同一顆主鈕、在第一列上方、列照樣列出、焦點不被搶;沒登入不出;雲端視角不出;有資料不出", r.a.set && r.a.cat === "plan"
    && !r.b.hidden && r.b.text === (await T("lib.gate.noBalance")) && r.b.btn === (await T("lib.gate.topup")) + ":btn-fill" && r.b.rows === 8 && r.b.focus === "lib-h" && r.b.above && r.c.hidden && r.d.lib && r.d.hidden && r.e.hidden, JSON.stringify(r));
  await js(`LIB.data.dataAccess = "billed"; libSync();`); r = await cta();
  let a = await js(`(async () => { const q = (x) => [...document.querySelectorAll(x)]; q("#lib-cta .btn-fill")[0].click(); const o = { lines: q("#del-body p").map((p) => p.textContent), where: document.getElementById("del-where").hidden }; document.getElementById("del-cancel").click(); await new Promise((r) => setTimeout(r, 40)); return o; })()`);
  ok("④ 按小時付資料費的帳號:鈕下只有「免費。」;lib.note.billed 在確認框第三行、本機不出腳的目的地句", r.btn === (await T("lib.use")) && r.note === (await T("lib.note.free")) && a.lines.length === 3 && a.lines[2] === (await T("lib.note.billed")) && a.where, JSON.stringify([r, a]));
  a = await js(`(async () => { const q = (x) => [...document.querySelectorAll(x)]; ENV.cur = "cloud"; libAsk({ id: 101, title: "BTC 通道動能共振" }); const o = { lines: q("#del-body p").map((p) => p.textContent), notes: q("#del-body .cf-note").length, where: document.getElementById("del-where").hidden ? null : document.getElementById("del-where").textContent, env: !document.getElementById("del-env").hidden }; document.getElementById("del-cancel").click(); ENV.cur = "local"; await new Promise((r) => setTimeout(r, 40)); return o; })()`);
  ok("④ 雲端視角的下載確認框:內文兩段(l1 不帶目的地、雲端不出 billed)、lib.cf.cloudNote 在腳的 .del-where(不在內文 .cf-note)、「雲端」記號", a.lines.length === 2 && a.lines[0] === (await T("lib.cf.l1")) && a.notes === 0 && a.where === (await T("lib.cf.cloudNote")) && a.env, JSON.stringify(a));
  await js(`LIB.data.dataAccess = "included"; running = true; libSync();`); r = await cta();
  ok("④ 回合中:主鈕 disabled、說明句 turn.busy", r.btn === (await T("lib.use")) && r.dis === true && r.note === (await T("turn.busy")), JSON.stringify(r));
  // 用這支
  r = await js(`(async () => { running = false; libSync(); const q = (x) => [...document.querySelectorAll(x)]; q("#lib-cta .btn-fill")[0].click();
    const open = !document.getElementById("del-scrim").hidden, title = document.getElementById("del-title").textContent, full = document.getElementById("del-title").title, lines = q("#del-body p").map((p) => p.textContent), okTxt = document.getElementById("del-ok").textContent, env = document.getElementById("del-env").hidden, focus = document.activeElement && document.activeElement.id;
    document.getElementById("del-ok").click(); await new Promise((r) => setTimeout(r, 60));
    const b = q("#lib-cta .btn-fill")[0]; return { open, title, full, lines, okTxt, env, focus, sent: window.__lib.sent.map((p) => [p.message, p.viewing && p.viewing.env, p.sessionId && /^desktop-/.test(p.sessionId)]), pending: LIB.pending && LIB.pending.id, btn: b.textContent, dis: b.disabled, note: q("#lib-cta .note")[0].textContent, running }; })()`);
  ok("④ 「用這支」→ 確認框(標題帶策略名、兩段、「下載並回測」、焦點在取消、本機不掛雲端記號)→ 確認 → 送出的就是 web 那一句(逐字)、viewing.env=local → 進行中態",
    r.open && r.title === (await T("lib.cf.title", { title: "BTC 通道動能共振" })) && r.full === r.title && !/…/.test(r.title) && r.lines.length === 2 && r.lines[0] === (await T("lib.cf.l1")) && r.okTxt === (await T("lib.cf.ok")) && r.env && r.focus === "del-cancel"
    && r.sent.length === 1 && r.sent[0][0] === "幫我下載官方策略「BTC 通道動能共振」（#101），跑一次回測看看結果" && r.sent[0][1] === "local" && r.sent[0][2] && r.pending === 101 && r.btn === (await T("lib.pending")) && r.dis && r.note === (await T("lib.note.pending")) && r.running, JSON.stringify(r));
  // turn-end:本機多了一支 → 記對照表;stratRefresh(true) 選中新策略(策略庫收起)
  r = await js(`(async () => { window.__lib.strats = [{ name: "btc_channel", displayName: "BTC 通道", mtime: 5, hasBacktest: true }]; running = false;
    await stratRefresh(true); libTurnEnd(); await new Promise((r) => setTimeout(r, 40));
    const libHidden = document.getElementById("lib").hidden, rp = document.getElementById("rp").hidden, sel = RP.name;
    await libOpen(); await new Promise((r) => setTimeout(r, 40)); const q = (x) => [...document.querySelectorAll(x)]; const b = q("#lib-cta .btn-fill")[0];
    return { patches: window.__lib.patches, installed: LIB.installed, libHidden, rp, sel, pending: LIB.pending, btn: b.textContent, quiet: q("#lib-cta .btn-quiet").map((x) => x.textContent).join(), note: q("#lib-cta .note")[0].textContent, detail: libBag().detail }; })()`);
  ok("④ turn-end:本機清單多了 btc_channel → 對照表記 101 → btc_channel(寫進主行程)、報告頁蓋掉策略庫;再開回到同一支詳情 → 已安裝態(打開這支策略 + 再下載一份)",
    JSON.stringify(r.patches) === '[{"id":101,"name":"btc_channel"}]' && r.installed["101"] === "btc_channel" && r.libHidden && !r.rp && r.sel === "btc_channel" && r.pending === null && r.detail === 101
    && r.btn === (await T("lib.open")) && r.quiet === (await T("lib.again")) && r.note === (await T("lib.note.installed", { where: await T("lib.where.local") })), JSON.stringify(r));
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
  ok("④ 成功 → 關框、不再開下載框、直接送 lib.msgPaid(逐字)、進行中態、purchased=true", r.del && r.sent.length === 2 && r.sent[1] === "幫我下載已購買的策略「Cash-and-Carry <img onerror=x> Arbitrage」（#5），跑一次回測看看結果" && r.pending === 5 && r.purchased === true && r.btn === (await T("lib.pending")) && r.buys === 5, JSON.stringify(r));
  // 已購:用這支 → msgPaid,不開購買框
  r = await js(`(async () => { running = false; LIB.pending = null; libSync(); document.getElementById("lib-back").click(); const q = (x) => [...document.querySelectorAll(x)]; q('#lib-rows .lib-row[data-id="9"]')[0].click();
    const btn = q("#lib-cta .btn-fill")[0].textContent, note = q("#lib-cta .note")[0].textContent; q("#lib-cta .btn-fill")[0].click(); const title = document.getElementById("del-title").textContent; document.getElementById("del-ok").click(); await new Promise((r) => setTimeout(r, 60));
    return { btn, note, title, last: window.__lib.sent[window.__lib.sent.length - 1].message, buys: window.__lib.buys.length }; })()`);
  ok("④ 已購的付費策略:主鈕「用這支」、說明 lib.note.owned、走下載框(不是購買框)、送 lib.msgPaid", r.btn === (await T("lib.use")) && r.note === (await T("lib.note.owned")) && r.title === (await T("lib.cf.title", { title: "已買的社群策略" })) && r.last === "幫我下載已購買的策略「已買的社群策略」（#9），跑一次回測看看結果" && r.buys === 5, JSON.stringify(r));
  // en
  r = await js(`(async () => { running = false; LIB.pending = null; libFind(5).purchased = false; setLang("en"); applyStatic(); await new Promise((r) => setTimeout(r, 30)); const q = (x) => [...document.querySelectorAll(x)];
    const h = document.getElementById("lib-h").textContent; document.getElementById("lib-back").click(); q('#lib-rows .lib-row[data-id="5"]')[0].click(); const tag5 = q('#lib-cta').length;
    const note = q("#lib-cta .note")[0].textContent; document.getElementById("lib-back").click(); const priceTag = q('#lib-rows .lib-row[data-id="8"] .tag').length; const l2 = q('#lib-rows .lib-row[data-id="101"] .l2')[0].textContent;
    q('#lib-rows .lib-row[data-id="72"]')[0].click(); q("#lib-cta .btn-fill")[0].click(); document.getElementById("del-ok").click(); await new Promise((r) => setTimeout(r, 60));
    const out = { h, note, l2, last: window.__lib.sent[window.__lib.sent.length - 1].message, priceTag, owned5: q("#lib-cta .btn-fill")[0].textContent };
    setLang("zh"); applyStatic(); return out; })()`);
  ok("④ en:頁首換字、付費說明多 fx 註(en 兩句之間一個空格)、列第二行 en、送出的 en 那句逐字同 web", r.h === "Strategy Library" && r.note.endsWith(" " + STR.en["lib.fxNote"]) && r.l2 === "Blave Official · BTC/USDT Perp · 5m · 6.5-yr sample"
    && r.last === "Download the official strategy \"DOGE 籌碼集中度\" (#72) and run a backtest to see the results." && r.priceTag === 2, JSON.stringify(r));   // #8 平鋪在清單裡:「未驗證」+ 價格兩個 tag
  // 快取:每次進視圖重問主行程(綁卡 / 換帳號後閘門與 purchased 才會跟上);登出 / 登入 / 換語言 / 設定關掉 / 回前景都重問
  r = await js(`(async () => { running = false; LIB.pending = null; const n0 = window.__lib.calls.length; document.getElementById("lib-back").click();
    window.__lib.list = { strategies: ${JSON.stringify(LIST)}, signedIn: true, dataAccess: "none" }; await trOpen("over"); await libOpen(); await new Promise((r) => setTimeout(r, 60));
    const q = (x) => [...document.querySelectorAll(x)]; q('#lib-rows .lib-row[data-id="101"]')[0].click(); const gated = q("#lib-cta .btn-fill").length === 0 && q("#lib-cta .btn-out").length === 1 && q("#lib-cta .note")[0].textContent === t("lib.gate.unknown");
    window.__lib.list = { strategies: ${JSON.stringify(LIST)}, signedIn: true, dataAccess: "included" }; window.dispatchEvent(new Event("focus")); await new Promise((r) => setTimeout(r, 60)); const unGated = q("#lib-cta .btn-fill").length === 1 && q("#lib-cta .btn-fill")[0].textContent === t("lib.use");
    const n1 = window.__lib.calls.length; await setOpen(); setClose(); await new Promise((r) => setTimeout(r, 40)); const n2 = window.__lib.calls.length;
    libInvalidate(); await new Promise((r) => setTimeout(r, 40)); const n3 = window.__lib.calls.length;
    setLang("en"); applyStatic(); await new Promise((r) => setTimeout(r, 40)); const langCall = window.__lib.calls[window.__lib.calls.length - 1]; setLang("zh"); applyStatic(); await new Promise((r) => setTimeout(r, 40));
    return { n0, n1, n2, n3, gated, unGated, langCall, last: window.__lib.calls[window.__lib.calls.length - 1], detail: libBag().detail }; })()`);
  ok("④ 進視圖重問 → 主行程說付不出資料費(沒帶 why → unknown → 描邊鈕)就擋;回前景重問 → 解;設定關掉、libInvalidate、換語言各再問一次(語言帶 en);詳情那支留著", r.n1 > r.n0 && r.gated && r.unGated && r.n2 === r.n1 + 1 && r.n3 === r.n2 + 1 && r.langCall === "en" && r.last === "zh" && r.detail === 101, JSON.stringify(r));
  // 兩邊都開著時切視角:畫的是這一邊那袋(雲端沒有對照表、{where} 是雲端主機)
  r = await js(`(async () => { LIB.bags.cloud.open = true; LIB.bags.cloud.detail = 72; document.getElementById("cv-empty").hidden = true; ENV.cur = "cloud"; envShowMain(); await new Promise((r) => setTimeout(r, 60)); const q = (x) => [...document.querySelectorAll(x)];
    const c = { lib: !document.getElementById("lib").hidden, h5: q("#lib-det h5")[0] && q("#lib-det h5")[0].textContent, where: q("#lib-cta .note")[0].textContent, painted: LIB.paintedEnv };
    ENV.cur = "local"; envShowMain(); await new Promise((r) => setTimeout(r, 60)); const l = { h5: q("#lib-det h5")[0] && q("#lib-det h5")[0].textContent, where: q("#lib-cta .note")[0].textContent, painted: LIB.paintedEnv };
    LIB.bags.cloud.open = false; LIB.bags.cloud.detail = null; return { c, l }; })()`);
  ok("④ 兩邊都開著策略庫:切到雲端畫雲端那袋的詳情(#72、說明句講雲端主機、停機 / 讀不到那句);切回本機回到 #101、說明句講這台電腦", r.c.lib && r.c.h5 === "DOGE 籌碼集中度" && r.c.painted === "cloud" && (r.c.where === (await T("ho.gate.stale")) || r.c.where === (await T("ho.gate.stopped")))
    && r.l.h5 === "BTC 通道動能共振" && r.l.painted === "local" && r.l.where === (await T("lib.note.free")), JSON.stringify(r));
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
    const err = { state: document.getElementById("lib-state").textContent, hidden: document.getElementById("lib-state").hidden, retry: q("#lib-state .btn-out").length, rows: q("#lib-rows .lib-row").length, foot: document.getElementById("lib-foot").hidden };
    LIB.skel = true; libPaintList(); err.skFoot = document.getElementById("lib-foot").hidden; err.sk = q("#lib-rows .sk-row").length; LIB.skel = false; libPaintList();
    window.__lib.list = { strategies: [], signedIn: true, dataAccess: "included" }; q("#lib-state .btn-out")[0].click(); await new Promise((r) => setTimeout(r, 400));
    return { err, empty: document.getElementById("lib-state").textContent, rows: q("#lib-rows .lib-row").length }; })()`);
  ok("④ 讀不到 → 「讀不到策略庫。」+ 重試鈕、沒有列、腳注不出;skeleton 時腳注也不出;重試成功但整庫空 → lib.empty", !r.err.hidden && r.err.state.startsWith(await T("lib.error")) && r.err.retry === 1 && r.err.rows === 0 && r.err.foot === true && r.err.skFoot === true && r.err.sk === 5 && r.empty === (await T("lib.empty")) && r.rows === 0, JSON.stringify(r));
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
