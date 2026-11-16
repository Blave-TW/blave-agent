// 台指期休市時全部平倉照送、被拒就是失敗(spec txf-close-or-fail,Wei 11-15/16)在電腦版畫面上的樣子:
//   trade.js:延後列只剩 0.1.53 雲端 lib 會寫的那兩種(trCloseDeferred)、拒單 token market_closed 換白話句、
//            停止框與啟動框不再講台指期休市、新 lib(txf_close_refuses)解除連接照樣給平倉鈕
//   main.js:統一回休市(broker_session_closed)不叫本機 P1;休市平不了是一般拒單,照叫
//   字串:定稿句逐字(designer txf-close-or-fail-copy-2026-11-16)
// 不開視窗。跑法:node tests/check_shell_txf_close_or_fail.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const trade = fs.readFileSync(path.join(R, "trade.js"), "utf8"), strings = fs.readFileSync(path.join(R, "strings.js"), "utf8");
const main = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const cut = (src, name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0; for (let k = src.indexOf("{", src.indexOf(")", i)); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("切不出 " + name); };
const fn = (name) => cut(trade, name);
const line = (re) => { const m = re.exec(trade); if (!m) throw new Error("找不到 " + re); return m[0]; };

// 留著、延後的畫面都拿掉了;0.1.53 雲端 lib 的延後列照認
{ const M = new Function([line(/^const TR_TWFUT_RE = .*$/m), line(/^const TR_DEFER_CANCEL_RE = .*$/m), line(/^const TR_CAPITAL_PREFIX = .*$/m),
    ...["trCanonSym", "trCapitalCanon", "trCloseDeferred"].map(fn), "return { trCloseDeferred };"].join("\n"))();
  ok("kept 那一套與停止框／啟動框的台指期句都拿掉了",
    !/market_closed_kept|trFlattenKeptOnly|trKeptRel|trTxfPaperLots|trStopTxfLines|trTxfBrokerLots|txf_close_keeps|stopTxfClosed|means\.txfClose|evKept/.test(trade)
    && !/market_closed_kept/.test(main));
  ok("kind market_closed_kept 不再被認成延後列(機器不會再寫,認了會講錯)", M.trCloseDeferred({ symbol: "TXF", exchange: "president", kind: "market_closed_kept" }) === null);
  ok("延後列照舊(0.1.53 雲端 lib):標題、時鐘附註、雲端換「主機」那組", (() => {
    const d = (clock, cloud) => M.trCloseDeferred({ symbol: "TXF", exchange: "president", kind: "market_closed_deferred", clock }, cloud);
    return d("far").title === "tr.ov.evDeferFut" && d("far").note === "tr.ov.evDeferClockFarNote" && d("far").rowNote === d("far").note
      && d("unmeasured", true).note === "tr.cloud.ov.evDeferClockNote" && d("far", true).note === "tr.cloud.ov.evDeferClockFarNote" && d(undefined, true).note === "tr.ov.evDeferNote"; })());
  ok("新機器的拒單列不會被認成延後或取消", M.trCloseDeferred({ symbol: "TXF", exchange: "president",
    error: "[order_reject:market_closed] close-all: 休市中沒有平倉，部位還在、沒有停損，開盤後要自己平" }) === null
    && M.trCloseDeferred({ symbol: "TXF", exchange: "president", error: "close-all: 更新後取消等開盤的平倉，部位還在、沒有停損，要自己平" }) === null); }

// token market_closed → tr.err.marketClosed(同其他拒單 token)
ok("拒單 token market_closed 換 tr.err.marketClosed", /market_closed: "tr\.err\.marketClosed"/.test(line(/^const TR_REJECT_TEXT = [\s\S]*?};$/m)));
// 真的一列走 trOrderErrText:token 要認得到;列上 halt_lifted(平倉並解除被休市拒、這次的暫停撤回了)換不講「沒有停損」那句
{ const T = new Function("t", [line(/^const BITGET_VERIFIED_MODES = .*$/m), line(/^const TR_REJECT_TEXT = [\s\S]*?};$/m),
    ...["trErrToken", "trPaperTwCashRow", "trPaperSellRow", "trOrderErrParse", "trOrderErrText"].map(fn), "return trOrderErrText;"].join("\n"))((k) => k);
  const err = "[order_reject:market_closed] close-all: 休市中沒有平倉，部位還在、沒有停損，開盤後要自己平";
  ok("休市拒單列(暫停中)→ tr.err.marketClosed", T("TXF", err, { symbol: "TXF", exchange: "president", error: err }) === "tr.err.marketClosed");
  ok("休市拒單列帶 halt_lifted → tr.err.marketClosedRun(群益也是)", ["president", "capital"].every((ex) =>
    T("TXF", err, { symbol: "TXF", exchange: ex, error: err, halt_lifted: true }) === "tr.err.marketClosedRun"));
  ok("halt_lifted 不是 true(舊列、亂值)→ 照舊暫停那句", T("TXF", err, { symbol: "TXF", exchange: "capital", halt_lifted: "yes" }) === "tr.err.marketClosed"
    && T("TXF", err) === "tr.err.marketClosed"); }

// 部位表掛不掛(trLiveOrderErrs)與原文退路(trOrderErrRaw):列照 lib/portfolio._record_order_error 實際存進 order_errors.json 的樣子
// (flatten 傳「close-all: [order_reject:market_closed] …」,存檔時 token 搬到最前面;rel-0155 跑一次 _record_order_error 取得)
{ const L = new Function([line(/^const TR_CAPITAL_PREFIX = .*$/m), line(/^const TR_CLOSE_ALL_RE = .*$/m),
    ...["trCanonSym", "trCanonKey", "trCapitalCanon", "trTwFutCanon", "trMs", "trIsCloseAll", "trLiveOrderErrs", "trOrderErrRaw"].map(fn),
    "return { trLiveOrderErrs, trOrderErrRaw, trIsCloseAll };"].join("\n"))();
  const STORED = [
    { ts: "2026-11-16T06:38:49.443015", symbol: "TXF", exchange: "president", error: "[order_reject:market_closed] close-all: 休市中沒有平倉，部位還在、沒有停損，開盤後要自己平" },
    { halt_lifted: true, ts: "2026-11-16T06:38:49.443675", symbol: "TXF", exchange: "capital", error: "[order_reject:market_closed] close-all: 休市中沒有平倉，部位還在、沒有解除連接，開盤後要再平一次" }];
  const ctx = (running) => ({ open: new Set(["TXF"]), twOpen: true, running, orders: [] });
  ok("存檔的休市拒單列(token 在前)= 平倉失敗列:暫停中、沒有待下單差額也掛在 TXF 那列", STORED.every((row) => {
    const m = L.trLiveOrderErrs([row], new Set(), ctx(false)); return m.size === 1 && m.get("TXF") === row; }));
  ok("存檔的休市拒單列:執行中＋有待下單差額不被當一般拒單掛(不給「請 agent 查原因」)", STORED.every((row) =>
    L.trLiveOrderErrs([row], new Set(["TXF"]), ctx(true)).size === 0));
  ok("token 在後(沒有 lib/reject_token 的工作區)也認;不是 close-all 的拒單不算", L.trIsCloseAll("close-all: [order_reject:market_closed] x") && L.trIsCloseAll("close-all: x")
    && !L.trIsCloseAll("[order_reject:insufficient_margin] margin") && !L.trIsCloseAll("x close-all: y") && !L.trIsCloseAll(null));
  ok("原文退路:兩種順序都拿掉 token 與 close-all 前綴", L.trOrderErrRaw("[order_reject:stock_agreement] close-all: boom") === "boom"
    && L.trOrderErrRaw("close-all: [order_reject:stock_agreement] boom") === "boom" && L.trOrderErrRaw("close-all: boom") === "boom");
  ok("trade.js 不再用開頭比對 close-all:(部位表兩處都走 trIsCloseAll)", !/indexOf\("close-all:"\) === 0/.test(trade) && (trade.match(/closeAll = trIsCloseAll\(/g) || []).length === 2); }

// 停止框:沒有台指期那一句;解除連接:新 lib 休市照樣給平倉鈕,舊 lib 照舊畫休市框
{ const stop = fn("trAskStop");
  ok("停止框的句子:選句、凍結第二行、後果句,沒有台指期休市句", /lines: \[t\(choice\), \.\.\.\(freeze \? \[t\(choice \+ "2"\)\] : \[\]\), trRestartUnconfirmed\(r\)/.test(stop));
  const U = new Function("trUbPositions", "trTwBroker", "PAPER", fn("trUbKind") + "\nreturn trUbKind;")(() => ({ n: 1 }), (id) => id === "president" || id === "capital", "paper");
  const base = { can_close_unbind: true, txf_session: { open: false, next_open: 1800000000 } };
  ok("解除連接:新 lib(txf_close_refuses)休市 → 一般平倉框(有平倉鈕)", U(Object.assign({ txf_close_refuses: true }, base), "president").kind === "ask");
  ok("解除連接:舊 lib 休市 → 休市框(機器會回 market_closed)", U(base, "president").kind === "closed" && U(Object.assign({ txf_close_refuses: "yes" }, base), "capital").kind === "closed"); }

// 解除連接失敗框:機器撤回了這次的暫停就不講「下單維持暫停」(Wei 11-16);照回報的停止狀態選句
{ const restart = { v: null };
  const F = new Function("trRestartKind", fn("trUbFailStateKey") + "\nreturn trUbFailStateKey;")(() => restart.v);
  ok("失敗框:還暫停著 → 下單維持暫停", F({ halt: { halted: true } }) === "tr.ub.failState");
  ok("失敗框:暫停撤回了(沒有 HALT)→ 下單沒有暫停", F({ halt: { halted: false } }) === "tr.ub.failStateRun" && F({}) === "tr.ub.failStateRun");
  restart.v = "machine";
  ok("失敗框:重開停住(沒有 HALT 也停著)→ 下單維持暫停", F({}) === "tr.ub.failState");
  ok("trUbShow 用這一條選句", /lines\.push\(t\(trUbFailStateKey\(trReport\(\) \|\| \{\}\)\)\)/.test(fn("trUbShow"))); }

// main.js:統一回休市是 P3;全部平倉休市平不了是一般拒單 → P1
{ const a = main.indexOf("const P1_TYPES"), b = main.indexOf("function p1Sync()");
  const S = new Function("path", "app", main.slice(a, b).replace(/^const /gm, "var ").replace(/^let /gm, "var ") + "\nreturn { p1FromState };")(path, { getPath: () => "/nonexistent" });
  const NOW = 1_800_000_000;
  const st = (kind, ex, error) => S.p1FromState({ halt: {}, order_errors: [{ ts: NOW - 5, symbol: "TXF", exchange: ex || "president", kind, error: error || "close-all: x" }] }, { halt: 0, err: 0, unx: [] }, NOW);
  ok("統一回休市(broker_session_closed)是 P3:本機 P1 不叫;水位線照推", st("broker_session_closed").show.length === 0 && st("broker_session_closed").err === NOW - 5);
  ok("…只認統一(同 api):別家帶這個 kind 照舊叫拒單", st("broker_session_closed", "capital").show.length === 1 && st("broker_session_closed", "binance").show[0].type === "order_error");
  ok("全部平倉休市平不了(沒有 kind、帶 market_closed token)照叫拒單 P1,群益也是", ["president", "capital"].every((ex) => {
    const s = st(undefined, ex, "[order_reject:market_closed] close-all: 休市中沒有平倉，部位還在、沒有停損，開盤後要自己平");
    return s.show.length === 1 && s.show[0].type === "order_error"; }));
  ok("升級時丟掉的延後(真帳戶)照叫拒單 P1", st(undefined, "president", "close-all: 更新後取消等開盤的平倉，部位還在、沒有停損，要自己平").show.length === 1);
  const lifted = (ex, v) => S.p1FromState({ halt: {}, order_errors: [{ ts: NOW - 5, symbol: "TXF", exchange: ex, halt_lifted: v,
    error: "[order_reject:market_closed] close-all: 休市中沒有平倉" }] }, { halt: 0, err: 0, unx: [] }, NOW);
  ok("休市被拒、暫停已撤回(halt_lifted)降 P2:真帳戶本機也不叫,水位線照推", ["president", "capital", "paper"].every((ex) => {
    const s = lifted(ex, true); return s.show.length === 0 && s.err === NOW - 5; }));
  ok("halt_lifted 不是 true:真帳戶照叫 P1、模擬照舊不叫", ["president", "capital"].every((ex) => lifted(ex, false).show.length === 1 && lifted(ex, "true").show.length === 1)
    && lifted("paper", false).show.length === 0); }

// 字串逐字
{ const zh = strings.slice(strings.indexOf("\n  zh: {")), en = strings.slice(strings.indexOf("\n  en: {"), strings.indexOf("\n  zh: {"));
  const g = (s, k) => (s.match(new RegExp('"' + k.replace(/\./g, "\\.") + '": "((?:[^"\\\\]|\\\\.)*)"')) || [])[1];
  const SPEC = {
    "tr.err.marketClosed": ["{sym} 沒有平倉：休市中。部位還在、沒有停損，開盤後要自己平。", "{sym} not closed: the market is shut. The position stays open with no stop until you close it after the open."],
    "tr.err.marketClosedRun": ["{sym} 沒有平倉：休市中。部位還在、沒有解除連接，開盤後要再平一次。", "{sym} not closed: the market is shut. The position and the connection stay until you close it after the open."],
    "tr.ov.evBrokerShut": ["統一回覆休市，下個時段再送", "President says closed. Sending next session"],
    "tr.ub.failTitleN": ["平倉沒有完成，還沒解除連接", "The close didn’t finish. Still connected."],
    "tr.ub.failState": ["下單維持暫停，沒平的部位還在帳上。", "Trading stays paused. Unclosed positions are still open."],
    "tr.ub.failStateRun": ["下單沒有暫停，沒平的部位還在帳上。", "Trading isn’t paused. Unclosed positions are still open."],
    "tr.cloud.ov.evDeferClockNote": ["時鐘量不到，照主機的時間開盤後平倉", "Clock unverified, so it closes after the open by the server’s clock"],
    "tr.cloud.ov.evDeferClockFarNote": ["時鐘差超過一小時，照主機的時間開盤後平倉", "Clock over an hour off, so it closes after the open by the server’s clock"],
  };
  const off = Object.keys(SPEC).filter((k) => g(zh, k) !== SPEC[k][0] || g(en, k) !== SPEC[k][1]);
  ok("定稿句、統一回休市、延後雲端時鐘句 zh / en 逐字(" + Object.keys(SPEC).length + " 個)", off.length === 0, off.map((k) => k + ": " + g(zh, k) + " / " + g(en, k)));
  ok("解除連接的失敗與休市框不再說「解除綁定」", ["tr.ub.failTitle", "tr.ub.failTitle1", "tr.ub.failTitleN", "tr.ub.closedTitle", "tr.ub.closedTitle1", "tr.ub.closedTitleN"]
    .every((k) => g(zh, k) && g(zh, k).indexOf("解除綁定") < 0 && g(zh, k).indexOf("解除連接") >= 0));
  const GONE = ["tr.stopTxfClosed", "tr.stopTxfClosedN", "tr.stopTxfClosedOld", "tr.stopTxfClosedOldN", "tr.means.txfClose", "tr.means.txfCloseOld",
    "tr.ov.evKeptFut", "tr.ov.evKeptNote", "tr.ov.evKeptNoteRel", "tr.ov.evKeptClockNote", "tr.ov.evKeptClockFarNote", "tr.cloud.ov.evKeptClockNote", "tr.cloud.ov.evKeptClockFarNote",
    "tr.closePos", "tr.closeTitle", "tm.txfOpenKept2", "tr.ov.evTxfOpenKept", "tr.ov.evCloseFromPaused"];
  ok("拿掉的句子兩語都不在", GONE.every((k) => g(zh, k) === undefined && g(en, k) === undefined), GONE.filter((k) => g(zh, k) !== undefined || g(en, k) !== undefined));
  const SIX = ["tr.ov.evManualCloseLag", "tr.ov.evManualCloseQueued", "tr.ov.evManualCloseQueuedSoon", "tm.evCloseLagNote", "tm.evCloseQueuedNote", "tm.evCloseQueuedSoonNote"];
  ok("六句手動平倉點名停止框那顆「暫停並關閉部位」", SIX.every((k) => g(zh, k).indexOf("「暫停並關閉部位」") >= 0 && g(en, k).indexOf("“Pause and close positions”") >= 0), SIX.map((k) => g(zh, k)));
  ok("結果不明的全部平倉那句仍點名停止框那顆", g(zh, "tr.ov.evUnconfirmedCloseAllNote").indexOf("暫停並關閉部位") >= 0); }
console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
