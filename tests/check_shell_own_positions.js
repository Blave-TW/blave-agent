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
  constructor(tag) { this.tag = tag; this.children = []; this._t = ""; this.attrs = {}; this.className = ""; this.title = ""; }
  set textContent(v) { this._t = v == null ? "" : String(v); this.children = []; }
  get textContent() { return this._t + this.children.map((c) => c.textContent).join(""); }
  appendChild(c) { if (c.frag) { this.children.push(...c.children); c.children = []; } else this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(typeof c === "string" ? document.createTextNode(c) : c)); }
  setAttribute(k, v) { this.attrs[k] = v; }
  tags(tag) { const out = []; const walk = (n) => { n.children.forEach((c) => { if (c.tag === tag) out.push(c); walk(c); }); }; walk(this); return out; }
}
var document = { createElement: (t) => new N(t), createDocumentFragment: () => { const n = new N("#frag"); n.frag = true; return n; }, createTextNode: (s) => { const n = new N("#text"); n._t = String(s); return n; } };
var t = (k) => k, LANG = "en", TR = { st: { alive: true, report: null } };
eval(cut("/* ── 純邏輯(", "/* ── 純邏輯到此").replace(/^const /gm, "var ") + "\n"
  + ["trEl", "trSec", "trHead", "trTipLabel", "trMoneyInto", "trFmt", "trUnit", "trCcy", "trReport", "trVenueId", "trLivePositions", "trPositions"].map(fnSrc).join("\n"));
var trTipSeq = 0;

const V = { binance: { credentials: true, pair: true, order: true, account: true } };
const NOW = new Date().toISOString().replace("Z", "");
// 每一個數字都是編的;形狀照 portfolio_reporter 的回報
function report(ownOnly, ledger, account) {
  const last = { ts: NOW, target: {}, actual: {}, orders: [], gates: {} };
  if (ledger) last.ledger = ledger;
  return { venues: V, self_ledger: ownOnly, last_reconcile: last,
    account: { read_at: Math.floor(Date.now() / 1000) + 60, venues: { binance: { ok: true, equity: 10, currency: "USDT", positions: account } } } };
}
const STATES = { btc_trend: { symbol: "BTCUSDT", position: 1, market: "swap" } };
function rows(r, amounts) {
  TR.st.report = r;
  const box = new N("div"); box.appendChild(trPositions(r, amounts, STATES));
  return box.tags("tbody")[0] ? box.tags("tbody")[0].tags("tr").map((tr) => tr.tags("td").map((td) => ({ text: td.textContent, cls: td.className }))) : [];
}
const MANUAL = { BTCUSDT: { side: "long", size: 71.3 }, DOGEUSDT: { side: "long", size: 27.4 } };

ok("trOwnBook 存在", typeof trOwnBook === "function");
// 1. 帳本在快照裡:Blave 那一份是「實際」,帳本沒有的 DOGE 是不歸 Blave 管的中性列
{ const R = rows(report(true, { BTCUSDT: { side: "long", size: 50, qty: 0.0007 } }, { BTCUSDT: { side: "long", size: 121.3 }, DOGEUSDT: MANUAL.DOGEUSDT }), { btc_trend: 50 });
  const btc = R.find((x) => x[0].text.startsWith("BTCUSDT")), doge = R.find((x) => x[0].text.startsWith("DOGEUSDT"));
  ok("帳本在:BTC 的「實際」是 Blave 的 50(不是帳戶的 121.3),差額 0", btc && btc[2].text.startsWith("+50") && btc[3].text.startsWith("0") && !/buy|sell/.test(btc[3].cls));
  ok("帳本沒有的 DOGE:一列「不歸 Blave 管」,不上買 / 賣色,目標欄是「—」", doge && doge[3].text === "tr.unmanaged" && !/buy|sell/.test(doge[3].cls) && doge[1].text === "—" && doge[2].text.startsWith("+27.4")); }
// 1b. 設計稽核 005 第 4 條:說明不只在 title(表底一行 pf-foot);不歸 Blave 管那一列的標的欄退一階、目標缺值是 na;沒有這種列就不出那行
{ const foot = (r, am) => { TR.st.report = r; const box = new N("div"); box.appendChild(trPositions(r, am, STATES)); return box.tags("div").filter((d) => /pf-foot/.test(d.className)).map((d) => d.textContent); };
  const R = rows(report(true, { BTCUSDT: { side: "long", size: 50, qty: 0.0007 } }, { BTCUSDT: { side: "long", size: 50 }, DOGEUSDT: MANUAL.DOGEUSDT }), { btc_trend: 50 });
  const doge = R.find((x) => x[0].text.startsWith("DOGEUSDT")), btc = R.find((x) => x[0].text.startsWith("BTCUSDT"));
  ok("不歸 Blave 管那一列:標的欄 hold(退一階)、目標欄 na;Blave 那一列的標的欄不退", doge && /\bhold\b/.test(doge[0].cls) && /\bna\b/.test(doge[1].cls) && !/\bhold\b/.test(btc[0].cls));
  ok("有不歸 Blave 管的列:表底一行寫說明句(tr.unmanagedTip)", foot(report(true, {}, MANUAL), { btc_trend: 50 }).includes("tr.unmanagedTip"));
  ok("沒有那種列:不出那一行", !foot(report(true, { BTCUSDT: { side: "long", size: 50, qty: 0.0007 } }, { BTCUSDT: { side: "long", size: 50 } }), { btc_trend: 50 }).includes("tr.unmanagedTip")); }
// 2. 帳本是空的、有金額的策略在交易 BTC、帳戶上有手動 BTC:Blave 那一列 0 → 買 50;手動那一整份另列中性
{ const R = rows(report(true, {}, MANUAL), { btc_trend: 50 });
  const btc = R.filter((x) => x[0].text.startsWith("BTCUSDT"));
  ok("帳本 0:BTC 有兩列——Blave 的(實際 0、買 50)與手動的(不歸 Blave 管)", btc.length === 2 && btc[0][2].text.startsWith("0") && /buy/.test(btc[0][3].cls) && btc[0][3].text.startsWith("+50")
    && btc[1][3].text === "tr.unmanaged" && btc[1][2].text.startsWith("+71.3"));
  ok("沒有任何一列是紅色的「賣」(Wei 的手動多單不會被畫成要平)", R.every((x) => !/sell/.test(x[3].cls))); }
// 3. 新規則的第一輪還沒跑(快照沒有 ledger):照機器端那條規則先算——同方向取 min(|帳戶|, |目標|)
{ const R = rows(report(true, null, MANUAL), { btc_trend: 50 });
  const btc = R.filter((x) => x[0].text.startsWith("BTCUSDT"));
  ok("快照沒有帳本:BTC 先算 min(71.3, 50) = 50 是 Blave 的,差額 0、沒有另一列", btc.length === 1 && btc[0][2].text.startsWith("+50") && btc[0][3].text.startsWith("0"));
  ok("…DOGE(沒有策略)是不歸 Blave 管", R.some((x) => x[0].text.startsWith("DOGEUSDT") && x[3].text === "tr.unmanaged"));
  const opp = rows(report(true, null, { BTCUSDT: { side: "short", size: 40 } }), { btc_trend: 50 }).filter((x) => x[0].text.startsWith("BTCUSDT"));
  ok("…反方向(空 40、目標多 50):Blave 的是 0、買 50;空單是用戶的", opp.length === 2 && opp[0][2].text.startsWith("0") && /buy/.test(opp[0][3].cls) && opp[1][3].text === "tr.unmanaged" && opp[1][2].text.startsWith("-40"));
  ok("…空的組合(Wei):兩列都是不歸 Blave 管,沒有買賣", rows(report(true, null, MANUAL), {}).every((x) => x[3].text === "tr.unmanaged")); }
// 4. 舊 lib(回報 self_ledger 不是 true):照舊把整個帳戶當成 Blave 的——那時對帳器真的會平,紅字是實話
{ const R = rows(report(false, null, MANUAL), {});
  ok("舊 lib:照舊,帳戶上的部位畫成要平(賣)", R.length === 2 && R.every((x) => /sell/.test(x[3].cls))); }
// 投資組合(Type C):目標 = 金額 × 每個資產的權重;現貨負權重壓 0(同 lib/portfolio.aggregate_portfolio)
{ const tg = trClientTargets({ basket: 1000, btc: 200 }, { basket: { weights: { BTCUSDT: 0.5, "ETH-USDT": 0.3, SOLUSDT: 0 }, market: "swap" },
    btc: { symbol: "BTCUSDT", position: -1, market: "swap" } });
  ok("Type C 目標:每個資產各自一列,跟同標的的單一策略淨額相加", tg.BTCUSDT === 300 && tg.ETHUSDT === 300 && tg.SOLUSDT === 0);
  const sp = trClientTargets({ sb: 1000, s1: 100 }, { sb: { weights: { BTCUSDT: -0.5, ETHUSDT: 0.5 }, market: "spot" },
    s1: { symbol: "BTCUSDT", position: 1, market: "spot" } });
  ok("Type C 現貨:這支策略的負權重先壓 0,不去抵別的策略的多單", sp["BTCUSDT@spot"] === 100 && sp["ETHUSDT@spot"] === 500);
  const x = { portfolio: true }, lockedSrc = /const locked = !!x\.portfolio && !\(stored\[n\] > 0\) && !\(\(trReport\(\) \|\| \{\}\)\.can_trade_portfolio === true\);/.test(src);
  ok("投資組合策略:機器回報 can_trade_portfolio 時不鎖撥款", lockedSrc && !!x); }
ok("字串表有兩個新 key", /"tr\.unmanaged":/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "strings.js"), "utf8"))
  && /"tr\.unmanagedTip":/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "strings.js"), "utf8")));

console.log(red ? `\n${red} 項沒過` : "\n全部通過");
process.exit(red ? 1 : 0);
