// 部位分頁在「只管自己的部位」(回報 self_ledger === true)時:「實際」是 Blave 的帳本(對帳器拿它比目標),
// 帳本上完全沒有的帳戶部位畫成中性的「不歸 Blave 管」列,不上買 / 賣色(lib/portfolio.own_positions_only、_auto_baseline)。
// 跑法:node tests/check_shell_own_positions.js
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");
let red = 0; const ok = (name, c) => { console.log((c ? "PASS  " : "FAIL  ") + name); if (!c) red++; };
const J = JSON.stringify;
const cut = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a + from.length); if (a < 0 || b < 0) throw new Error("找不到 " + from); return src.slice(a, b); };
const fnSrc = (name) => {
  const a = src.indexOf("function " + name + "(");
  if (a < 0) throw new Error("找不到 " + name);
  let i = src.indexOf("{", a), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
  return src.slice(a, i + 1);
};

class N {
  constructor(tag) { this.tag = tag; this.children = []; this._t = ""; this.attrs = {}; this.dataset = {}; this.className = ""; this.title = ""; this.classList = { add() {} }; }
  addEventListener() {}
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get parentNode() { return this; }
  insertBefore(c) { this.children.push(c); return c; }
  set textContent(v) { this._t = v == null ? "" : String(v); this.children = []; }
  get textContent() { return this._t + this.children.map((c) => c.textContent).join(""); }
  appendChild(c) { if (c.frag) { this.children.push(...c.children); c.children = []; } else this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(typeof c === "string" ? document.createTextNode(c) : c)); }
  setAttribute(k, v) { this.attrs[k] = v; }
  tags(tag) { const out = []; const walk = (n) => { n.children.forEach((c) => { if (c.tag === tag) out.push(c); walk(c); }); }; walk(this); return out; }
}
var document = { createElement: (t) => new N(t), createDocumentFragment: () => { const n = new N("#frag"); n.frag = true; return n; }, createTextNode: (s) => { const n = new N("#text"); n._t = String(s); return n; } };
var t = (k) => k, LANG = "en", TR = { st: { alive: true, report: null } };
eval(cut("/* ── 純邏輯(", "/* ── 純邏輯到此").replace(/^const /gm, "var ") + "\n" + cut("/* ── 視角純邏輯(", "/* ── 視角純邏輯到此").replace(/^const /gm, "var ") + "\n"
  + ["trEl", "trSec", "trHead", "trTipLabel", "trMoneyInto", "trFmt", "trFmt2", "trFmtPrice", "trLotsFmt", "trLotsTgtFmt", "trUnit", "trCcy", "trReport", "trContracts", "trVenueId", "trQuoteMap", "trZoneLabel", "trZoneUnit",
    "trLivePositions", "trTwBroker", "trBook", "poPartStates", "poSigTable", "trPosDetail", "trManualPart", "trStored", "trEquity", "trTxfPrice", "trNoSignalYet", "trVenueLabel"].map(fnSrc).join("\n"));
var trTipSeq = 0;
var trVenueKind = (id) => (id === "binance" ? "crypto" : id === "capital" ? "tw" : null);
TR.list = []; TR.just = null; TR.env = "local";
var PAPER = "paper", CX_VENUES = { binance: { label: "Binance" } };
var envHeadState = () => "running", trPlanTotal = () => ({ text: "x", ccy: null, mult: "", n: 1 }), trRowTxf = () => null, trDisplay = (n) => n, poOpen = () => {};

const V = { binance: { credentials: true, pair: true, order: true, account: true } };
const NOW = new Date().toISOString().replace("Z", "");
// 每一個數字都是編的;形狀照 portfolio_reporter 的回報
function report(ownOnly, ledger, account, amounts) {
  const last = { ts: NOW, target: {}, actual: {}, orders: [], gates: {} };
  if (ledger) last.ledger = ledger;
  return { venues: V, self_ledger: ownOnly, last_reconcile: last, config: { amounts: amounts || {} }, states: STATES,
    account: { read_at: Math.floor(Date.now() / 1000) + 60, venues: { binance: { ok: true, equity: 10, currency: "USDT", positions: account } } } };
}
const STATES = { btc_trend: { symbol: "BTCUSDT", position: 1, market: "swap" } };
const cells = (box, n) => box.tags("tbody").flatMap((tb) => tb.tags("tr")).filter((tr) => tr.tags("td").length === n).map((tr) => tr.tags("td").map((td) => ({ text: td.textContent, cls: td.className })));
// 0.1.24 分工(split-positions spec):目標／實際／差額在策略組合 › 配置的總訊號部位表(poSigTable);帳戶持倉與「策略外」在自動下單 › 部位(trHoldings)
// 0.1.24 A 案:自動下單 › 部位一張表(poSigTable "trade"):Blave 的列是目標／帳上／差額,帳上有、帳本沒有的在區尾另一列「策略外」
function rows(r, amounts) { r.config.amounts = amounts; TR.st.report = r; const box = new N("div"); box.appendChild(poSigTable(r, amounts, STATES, "trade")); return cells(box, 4).filter((x) => !/tr\.unmanagedTag/.test(x[0].text)); }
function hold(r) { TR.st.report = r; const box = new N("div"); box.appendChild(poSigTable(r, r.config.amounts, STATES, "trade")); return { rows: cells(box, 4), foot: box.tags("div").filter((d) => /pf-foot/.test(d.className)).map((d) => d.textContent) }; }
const MANUAL = { BTCUSDT: { side: "long", size: 71.3 }, DOGEUSDT: { side: "long", size: 27.4 } };
// 策略要的標的不另列「策略外」(同網頁 00825f03):帳本沒有、帳戶有的那一份寫在那一列底下「另有手動 N」
const notes = (r) => { TR.st.report = r; const box = new N("div"); box.appendChild(poSigTable(r, r.config.amounts, STATES, "trade")); return cells(box, 1).map((x) => x[0].text); };
const tagged = (h, sym) => h.rows.some((r) => r[0].text.startsWith(sym) && /tr\.unmanagedTag/.test(r[0].text));

ok("trOwnBook 存在", typeof trOwnBook === "function");
// 1. 帳本在快照裡:Blave 那一份是「實際」;帳本沒有的 DOGE 不進總訊號部位表,在帳戶持倉標「策略外」
{ const r = report(true, { BTCUSDT: { side: "long", size: 50, qty: 0.0007 } }, { BTCUSDT: { side: "long", size: 121.3 }, DOGEUSDT: MANUAL.DOGEUSDT });
  const R = rows(r, { btc_trend: 50 }), btc = R.find((x) => x[0].text.startsWith("BTCUSDT"));
  ok("帳本在:BTC 的「實際」是 Blave 的 50(不是帳戶的 121.3),差額 0、不上色", btc && btc[2].text.startsWith("+50") && btc[3].text.startsWith("0") && !/buy|sell/.test(btc[3].cls));
  ok("帳本沒有的 DOGE:總訊號部位表不列", !R.some((x) => x[0].text.startsWith("DOGEUSDT")));
  const h = hold(r);
  ok("策略外:DOGE 在區尾另一列標「策略外」、帳上 +27.4、目標與差額「—」;BTC 不標;表底一行 tr.unmanagedTip", (() => { const d = h.rows.find((x) => /tr\.unmanagedTag/.test(x[0].text)); return tagged(h, "DOGEUSDT") && !tagged(h, "BTCUSDT") && d[1].text === "—" && d[2].text.startsWith("+27.4") && d[3].text === "—" && h.foot.includes("tr.unmanagedTip"); })());
  const h2 = hold(report(true, { BTCUSDT: { side: "long", size: 50, qty: 0.0007 } }, { BTCUSDT: { side: "long", size: 50 } }));
  ok("沒有策略外的列:不出那一行", !h2.foot.includes("tr.unmanagedTip") && !tagged(h2, "BTCUSDT")); }
// 2. 帳本是空的、有金額的策略在交易 BTC、帳戶上有手動 BTC:Blave 那一份 0 → 買 50;手動那一整份是策略外
{ const r = report(true, {}, MANUAL), R = rows(r, { btc_trend: 50 }), btc = R.filter((x) => x[0].text.startsWith("BTCUSDT"));
  ok("帳本 0:BTC 一列(Blave 的):實際 0、買 50", btc.length === 1 && btc[0][2].text.startsWith("0") && /buy/.test(btc[0][3].cls) && btc[0][3].text.startsWith("+50"));
  ok("沒有任何一列是紅色的「賣」(Wei 的手動多單不會被畫成要平)", R.every((x) => !/sell/.test(x[3].cls)));
  ok("手動的 BTC(策略也要這個標的)不另列策略外,那一列底下寫「另有手動 +71.30」;DOGE(沒有策略)照舊標「策略外」",
    !tagged(hold(r), "BTCUSDT") && tagged(hold(r), "DOGEUSDT") && notes(r).some((x) => /po\.manualPart/.test(x)), JSON.stringify(notes(r))); }
// 3. 新規則的第一輪還沒跑(快照沒有 ledger):照機器端那條規則先算——同方向取 min(|帳戶|, |目標|)
{ const r = report(true, null, MANUAL), R = rows(r, { btc_trend: 50 }), btc = R.filter((x) => x[0].text.startsWith("BTCUSDT"));
  ok("快照沒有帳本:BTC 先算 min(71.3, 50) = 50 是 Blave 的,差額 0", btc.length === 1 && btc[0][2].text.startsWith("+50") && btc[0][3].text.startsWith("0"));
  ok("…DOGE(沒有策略)在帳戶持倉是策略外、BTC 不是", tagged(hold(r), "DOGEUSDT") && !tagged(hold(r), "BTCUSDT"));
  const ro = report(true, null, { BTCUSDT: { side: "short", size: 40 } }), opp = rows(ro, { btc_trend: 50 }).filter((x) => x[0].text.startsWith("BTCUSDT"));
  ok("…反方向(空 40、目標多 50):Blave 的是 0、買 50;不另列策略外(快照沒有帳本,手動量判不出來)", opp.length === 1 && opp[0][2].text.startsWith("0") && /buy/.test(opp[0][3].cls) && !tagged(hold(ro), "BTCUSDT") && !notes(ro).some((x) => /po\.manualPart/.test(x)));   // 快照沒有帳本:手動量判不出來,不畫
  const re = report(true, null, MANUAL);
  ok("…空的組合(Wei):總訊號部位表整段不出;帳戶持倉兩列都是策略外", rows(re, {}).length === 0 && tagged(hold(re), "BTCUSDT") && tagged(hold(re), "DOGEUSDT")); }
// 4. 舊 lib(回報 self_ledger 不是 true):照舊把整個帳戶當成 Blave 的——對帳器真的會平,目標 0、差額紅字是實話
{ const r = report(false, null, MANUAL), R = rows(r, {});
  ok("舊 lib:帳戶上的部位列成目標 0、差額賣(對帳器會平掉);帳戶持倉不標策略外", R.length === 2 && R.every((x) => /sell/.test(x[3].cls) && x[1].text.startsWith("0")) && !tagged(hold(r), "BTCUSDT")); }
// 投資組合(Type C):目標 = 金額 × 每個資產的權重;現貨負權重壓 0(同 lib/portfolio.aggregate_portfolio)
{ const tg = trClientTargets({ basket: 1000, btc: 200 }, { basket: { weights: { BTCUSDT: 0.5, "ETH-USDT": 0.3, SOLUSDT: 0 }, market: "swap" },
    btc: { symbol: "BTCUSDT", position: -1, market: "swap" } });
  // 權重 0 的候選不開一列(units spec §8.3:上表「N 檔」只數持有的,下表列數同一個篩選)
  ok("Type C 目標:每個持有的資產各自一列,跟同標的的單一策略淨額相加;權重 0 的不出列", tg.BTCUSDT === 300 && tg.ETHUSDT === 300 && !("SOLUSDT" in tg));
  const sp = trClientTargets({ sb: 1000, s1: 100 }, { sb: { weights: { BTCUSDT: -0.5, ETHUSDT: 0.5 }, market: "spot" },
    s1: { symbol: "BTCUSDT", position: 1, market: "spot" } });
  ok("Type C 現貨:這支策略的負權重先壓 0,不去抵別的策略的多單", sp["BTCUSDT@spot"] === 100 && sp["ETHUSDT@spot"] === 500);
  const x = { portfolio: true }, lockedSrc = /const locked = !!x\.portfolio && !\(stored\[n\] > 0\) && !\(\(trReport\(\) \|\| \{\}\)\.can_trade_portfolio === true\);/.test(src);
  ok("投資組合策略:機器回報 can_trade_portfolio 時不鎖撥款", lockedSrc && !!x); }
ok("字串表有兩個 key(策略外小標、表底說明)", /"tr\.unmanagedTag":/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "strings.js"), "utf8"))
  && /"tr\.unmanagedTip":/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "strings.js"), "utf8")));

// 稽核 P1-1:群益讀帳回的是解析後的合約代碼(TM2608),要轉回 TMF 才對得上帳本——同口數、沒有手動單時不能出「另有手動」,也不能多一列「策略外」
{ const VC = { capital: { credentials: true, pair: true, order: true, account: true } }, ST = { txf: { symbol: "TXF", position: 1, market: "swap" } };
  const r = { venues: VC, self_ledger: true, last_reconcile: { ts: NOW, target: {}, actual: {}, orders: [], gates: {}, ledger: { TMF: { side: "long", size: 2 } } }, config: { amounts: { txf: 2 }, contracts: { txf: "TMF" } }, states: ST,
    account: { read_at: Math.floor(Date.now() / 1000) + 60, venues: { capital: { ok: true, equity: 10, currency: "TWD", positions: { TM2608: { side: "long", size: 2 } } } } } };
  TR.st.report = r; TR.list = [{ name: "txf", symbol: "TXF" }];
  const box = new N("div"); box.appendChild(poSigTable(r, r.config.amounts, ST, "trade"));
  const rs = cells(box, 4).map((x) => x.map((c) => c.text)), one = cells(box, 1).map((x) => x[0].text);
  ok("群益:讀帳 TM2608 多 2、帳本 TMF 多 2 → 一列、帳上 +2、差額 0;沒有「另有手動」、沒有「策略外」列", rs.length === 1 && rs[0][2].startsWith("+2") && rs[0][3].startsWith("0") && !one.some((x) => /po\.manualPart/.test(x)) && !rs.some((x) => /tr\.unmanagedTag/.test(x[0])), JSON.stringify([rs, one]));
  ok("trLivePositions:台灣期貨券商走 trTwFutCanon(TM2608 → TMF、TX2608 → TXF、MTX2608 → MXF);其他照舊", JSON.stringify(trLivePositions({ venues: VC, account: { venues: { capital: { ok: true, positions: { TM2608: { side: "long", size: 2 }, TX2608: { side: "short", size: 1 }, MTX2608: { side: "long", size: 3 } } } } } })) === JSON.stringify({ TMF: 2, TXF: -1, MXF: 3 }));
  TR.list = []; }
console.log(red ? `\n${red} 項沒過` : "\n全部通過");
process.exit(red ? 1 : 0);
