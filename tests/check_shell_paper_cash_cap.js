// 模擬帳戶台股的可用額度與存檔提醒(spec paper-tw-cash-short §2、§3),加真帳戶台股鎖住那一列的字(§4 A 案)。
//   trPaperCap / trPaperCapLeft:測資 tests/fixtures/paper_cash_cap.json(網頁 pfPaperCap 吃同一份)
//   接線:配置表的「可用 ≈」、確認框三句(只提醒不擋)、選擇策略框台股那列
// 跑法:node tests/check_shell_paper_cash_cap.js(不起 Electron)
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");
const a = src.indexOf("/* ── 純邏輯("), b = src.indexOf("/* ── 純邏輯到此");
if (a < 0 || b < 0) throw new Error("找不到純邏輯區塊的標記");
eval(src.slice(a, b).replace(/^const /gm, "var "));
let red = 0; const ok = (n, c, why) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || !why ? "" : "  " + why)); if (!c) red++; };
const J = JSON.stringify;
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "paper_cash_cap.json"), "utf8"));
const cut = (name) => { const i = src.indexOf("function " + name + "("); if (i < 0) return ""; let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } return ""; };

for (const c of fx.cases) {
  const r = trPaperCap(c.rows, c.entry, c.fx, c.acct), got = r && { cap: r.cap, d: r.d, over: r.over };
  ok("cap " + c.id, J(got) === J(c.expect), J(got) + " vs " + J(c.expect));
}
for (const c of fx.left) {
  const got = trPaperCapLeft(trPaperCap(c.rows, c.entry, c.fx, c.acct), c.name);
  ok("left " + c.id, got === c.expect, J(got) + " vs " + J(c.expect));
}
ok("測資涵蓋:超過、沒超過、已買滿(只用現金會誤報)、缺匯率、持股沒市值、帳戶讀失敗／沒讀到", ["under", "over", "fully_bought_not_over", "no_fx_twd", "holding_unpriced", "account_read_failed", "account_not_read_yet"].every((id) => fx.cases.some((c) => c.id === id)));
ok("缺匯率不退 1:1:同一組只拿掉 TWD 匯率就不判斷", trPaperCap(fx.cases[0].rows, fx.cases[0].entry, { USD: 1, USDT: 1, TWD: 32 }, "USDT") !== null && trPaperCap(fx.cases[0].rows, fx.cases[0].entry, { USD: 1, USDT: 1 }, "USDT") === null);
ok("trPaperCapLeft(null) = null", trPaperCapLeft(null, "x") === null);

// ── 接線 ──
const capOf = cut("trPaperCapOf"), tbl = cut("trAmountTable"), cf = cut("trCfOpen");
ok("trPaperCapOf:照存檔後路由(trAsSaved + trPaperOf)、can_paper_twstock 才判、匯率走 trFxView(過期 = fx null)、讀模擬帳戶那一筆(不是畫面第一家)",
  /return trAsSaved\(\(\) => \{/.test(capOf) && /filter\(\(n\) => trPaperOf\(n\)\)/.test(capOf) && /r\.can_paper_twstock !== true\) return null/.test(capOf)
  && /const fv = trFxView\(\); if \(!fv\.fx\) return null;/.test(capOf) && /trLiveEntry\(r, PAPER\)/.test(capOf) && /mk !== "tw_stock_futures"/.test(capOf));
ok("配置表:TWD 區標題列掛「可用」(小計左邊),只有 TWD 一區時放合計列;打字時跟合計一起重畫",
  /const avail = z === TR_TXF_CCY \? trPaperAvailEl\(\) : null;\n\s*if \(avail\) c3\.appendChild\(avail\.el\);\n\s*c3\.appendChild\(sub\);/.test(tbl)
  && /const pc = trPaperCapOf\(am\);/.test(tbl) && /if \(g\.avail\) g\.avail\.set\(pc\);/.test(tbl)
  && /if \(!Object\.keys\(grpCells\)\.length && zt\.order\.length === 1 && zt\.order\[0\] === TR_TXF_CCY && pc\) \{ const av = trPaperAvailEl\(\); av\.set\(pc\); total\.appendChild\(av\.el\); \}/.test(tbl));
const av = cut("trPaperAvailEl");
ok("「可用」是 tooltip 鈕(鍵盤到得了、aria-describedby 指口徑),超過加 .over 與讀屏「超過」;pc null 整段藏起",
  /trEl\("button", "tr-tipb pf-avail"\)/.test(av) && /setAttribute\("aria-describedby", tip\.id\)/.test(av) 
  && /el\.hidden = !pc; b\.textContent = ""; tip\.textContent = pc \? t\("tr\.paperAvailTip"\) : ""; if \(!pc\) return;/.test(av) && /b\.classList\.toggle\("over", pc\.over\)/.test(av) && /t\("tr\.paperAvailOver"\)/.test(av));
ok("確認框:三句放 .cf-extra、在 saveBlankLots 之後;輸入格只有台股那一支講 left／none,其餘講 over;不動 blocked(只提醒)、有這句就開框",
  /tr\.saveBlankLots[^\n]*\n\s*\/\/[^\n]*\n\s*\{ const pc = trPaperCapOf\(sending\), left = inp \? \(inp\.tw \? trPaperCapLeft\(pc, inp\.name\) : null\) : null;/.test(cf)
  && /paperCashKey = inp \? \(left == null \? null : left > 0 \? "tr\.cfPaperCashLeft" : "tr\.cfPaperCashNone"\) : pc && pc\.over \? "tr\.cfPaperCashOver" : null;/.test(cf)
  && /\n  blocked = badStored\.length > 0 \|\| paperTw\.length > 0;/.test(cf) && !/\n  blocked = [^\n]*paperCash/.test(cf) && !/okDisabled: [^\n]*paperCash/.test(cf)
  && /const anyChange = [^\n]*!!paperCashKey/.test(cf) && /"cf-zeroed cf-paper-cash"/.test(cf));
const css = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.css"), "utf8"), acss = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.css"), "utf8");
ok("CSS:可用 12px ink-3;超過亮色 redText、暗色 redBlack;確認框那句字色 ink(比註記深一階、不用紅)",
  /\.tr-tipb\.pf-avail \{ font: 400 12px\/1\.4 var\(--font-sans\); color: var\(--ink-3\); \}/.test(css) && /\.tr-tipb\.pf-avail\.over[^{]*\{ color: var\(--color-redText\); \}/.test(css)
  && /\[data-theme="dark"\] \.tr-tipb\.pf-avail\.over[^{]*\{ color: var\(--color-redBlack\); \}/.test(css) && /\.del-body\.lines p\.cf-zeroed\.cf-paper-cash \{ color: var\(--ink\); \}/.test(acss));

// ── 真帳戶台股(§4 A 案):鎖照舊,只換那一列的字 ──
{ const L = [{ name: "tws", symbol: "2330", twd: true, hasBacktest: true }, { name: "txf", symbol: "TXF", twd: true, hasBacktest: true }, { name: "btc", symbol: "BTCUSDT", hasBacktest: true }, { name: "kept", symbol: "2454", twd: true, hasBacktest: true }];
  const isTw = (n) => n === "tws" || n === "kept" || n === "txf";   // twdVenue:台幣標的
  const twStock = (n) => n === "tws" || n === "kept";                // 策略市場 tw_stock
  const by = (rows) => Object.fromEntries(rows.map((r) => [r.name, r]));
  const crypto = by(trPickRows(L, ["kept"], true, false, false, {}, isTw, twStock));
  ok("綁加密所:台股策略鎖住、字換 twStockSelf;台指期策略照舊 twdVenue;已勾的台股照舊不鎖、字照舊(twdVenue)",
    crypto.tws.locked && crypto.tws.note === "twStockSelf" && crypto.txf.locked && crypto.txf.note === "twdVenue" && !crypto.kept.locked && crypto.kept.note === "twdVenue" && !crypto.btc.locked, J(crypto));
  const broker = by(trPickRows(L, ["kept"], true, false, true, {}, null, twStock));
  ok("綁台灣期貨券商:台股策略鎖住、字換 twStockSelf;台指期不鎖;已勾的台股照舊 txfKeep",
    broker.tws.locked && broker.tws.note === "twStockSelf" && !broker.txf.locked && broker.kept.note === "txfKeep" && broker.btc.note === "txf", J(broker));
  const none = by(trPickRows(L, [], true, false, false, {}, isTw, null));
  ok("沒給判斷函式(模擬交易、市場讀不到)= 照舊那句", none.tws.note === "twdVenue");
  const sel = cut("trTwStockSelf");
  ok("trTwStockSelf:綁加密所或台灣期貨券商才回函式,判斷是策略市場 === tw_stock;選擇策略框、候選清單、策略頁原因都帶它;psRow 畫 tr.pick.twStockSelf",
    /k === "crypto" \|\| k === "tw" \? \(n\) => trSrcMarket\(trReport\(\), n\) === "tw_stock" : null/.test(sel)
    && (src.match(/trTwdVenueLock\(\), trTwStockSelf\(\)\)/g) || []).length === 2
    && /trTwdVenueLock\(\), trTwStockSelf\(\)\);\n\s*const n = [^\n]*\n\s*if \(n === "twStockSelf"\) return \{ key: "tr\.pick\.twStockSelf" \};/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "portfolio.js"), "utf8"))
    && /else if \(r\.note === "twStockSelf"\) note = nm\.appendChild\(trEl\("span", "ps-note", t\("tr\.pick\.twStockSelf"\)\)\);/.test(src)); }

// ── 字串:spec 定稿逐字 ──
{ const S = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "strings.js"), "utf8");
  const has = (k, v) => S.includes(JSON.stringify(k) + ": " + JSON.stringify(v));
  ok("zh 逐字", has("tr.err.paperCash", "{sym} 沒有下單：模擬帳戶的現金不夠買這一檔。調低策略金額。") && has("tr.paperAvail", "可用 ≈ {amt}")
    && has("tr.paperAvailTip", "模擬帳戶的現金加上現貨持股市值，扣掉其他現貨策略的金額。") && has("tr.cfPaperCashOver", "台股合計超過可用的約 {cap} TWD，會買不滿。")
    && has("tr.cfPaperCashLeft", "這一支填到約 {left} TWD 以內才買得滿。") && has("tr.cfPaperCashNone", "其他台股已用完可用金額，這一支會買不到。")
    && has("tr.pick.twStockSelf", "台股不自動下單，要自己到券商下單"));
  ok("en 逐字", has("tr.err.paperCash", "{sym} order not placed: the paper account doesn't have enough cash to buy it. Lower the strategy amount.") && has("tr.paperAvail", "Available ≈ {amt}")
    && has("tr.paperAvailTip", "Paper cash plus spot holdings, minus other spot strategies' amounts.") && has("tr.cfPaperCashOver", "Taiwan stocks total more than the ≈ {cap} TWD available, so not all will be bought.")
    && has("tr.cfPaperCashLeft", "Keep this under about {left} TWD to buy it all.") && has("tr.cfPaperCashNone", "Other Taiwan stocks already use up what's available, so this one won't be bought.")
    && has("tr.pick.twStockSelf", "Taiwan stocks aren't auto-traded. Place orders with your broker yourself")); }

console.log(red ? `${red} FAILED` : "ALL OK");
process.exit(red ? 1 : 0);
