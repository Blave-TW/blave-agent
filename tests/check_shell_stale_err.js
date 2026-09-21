// 表底那行「下單失敗」紅字:**真的跑一次 trPositions**,看它到底掛不掛(不是把判斷重寫一遍)。
// 兩個回歸一起釘:
//   ① 過期的失敗不可以留(Wei 在 Electron 44 看到:22:26 的「部位要到 110,000」掛在一張寫著 20,000、目標與實際已相符的表下面)
//   ② 一般加密列**不可以**被當成口數列(lib/portfolio.py:1119「兩側門檻都等於 flat 就不寫 gates」= 加密的常態;
//      拿「沒有 gate」當口數訊號的話,①又會被改回去)
//   ③ 口數列(群益 / futures_contracts)的失敗不可以被藏掉:機器端對它們不寫 gates、下單也沒門檻,差 1 口就真的送單
// 跑法:node tests/check_shell_stale_err.js
const fs = require("fs"), path = require("path"), vm = require("vm");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");

// trPositions 會碰 DOM 與 i18n:給它一個夠用的假環境,其餘從原文切出來的純邏輯照跑
const pure = src.slice(src.indexOf("/* ── 純邏輯("), src.indexOf("/* ── 純邏輯到此"));
const cut = (name) => { const i = src.indexOf("function " + name + "("); let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("no " + name); };

const node = (tag) => ({ tag, cls: "", kids: [], text: "", appendChild(c) { this.kids.push(c); return c; }, append(...c) { c.forEach((x) => this.kids.push(x)); },
  setAttribute() {}, get textContent() { return this.text + this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }, set textContent(v) { this.text = v; this.kids = []; } });
const flat = (n, out = []) => { if (n && n.tag) { out.push(n); (n.kids || []).forEach((k) => flat(k, out)); } return out; };

function paint(report) {
  const ctx = {
    TR: { env: "local", st: { alive: true, running: true, report } }, TR_BAGS: { local: {}, cloud: {} },
    t: (k, v) => k + (v ? JSON.stringify(v) : ""), LANG: "zh", Date, Math, Object, Array, String, Number, isFinite, JSON,
    document: { createElement: node, createDocumentFragment: () => node("frag") },
  };
  ctx.trEl = (tag, cls, text) => { const n = node(tag); n.cls = cls || ""; if (text != null) n.text = text; return n; };
  ctx.trSec = (x) => x; ctx.trTipLabel = (a2, b2) => node("span"); ctx.trHead = () => node("thead");
  ctx.trMoneyInto = (n, v) => { n.text = String(v); }; ctx.trFmt = (v) => String(v); ctx.trFmt2 = (v) => String(v);
  ctx.trUnit = () => "USDT"; ctx.trCcy = () => "USDT"; ctx.trExecState = () => "running"; ctx.TR_STALE_MS = 10 * 60 * 1000;
  ctx.trMs = (x) => (typeof x === "string" ? Date.parse(x + "Z") : null);
  ctx.trVenueIds = (r) => Object.keys((r && r.venues) || {}); ctx.trLiveEntry = (r, id) => ((r && r.account && r.account.venues) || {})[id] || null;
  ctx.trOrderErrText = (sym, err) => "ERR:" + sym + ":" + err;
  vm.createContext(ctx);
  vm.runInContext(pure.replace(/^const /gm, "var "), ctx);
  vm.runInContext(["trLivePositions", "trClientTargets", "trGateSide", "trPositions"].map(cut).join("\n").replace(/^const /gm, "var "), ctx);
  const frag = vm.runInContext("trPositions(TR.st.report, TR.st.report.config.amounts, TR.st.report.states)", ctx);
  const errRow = flat(frag).find((n) => n.cls === "pf-foot err");
  const holds = flat(frag).filter((n) => /(^| )hold( |$)/.test(n.cls)).length;
  return { red: errRow ? errRow.textContent : null, holds };
}

const ERR = { ts: "2026-09-21T14:26:00", symbol: "BTCUSDT", error: "order rejected: gross notional 110000 exceeds 10x paper equity 9945" };
const base = (o) => ({ venues: { paper: { credentials: true, pair: true, order: true, account: true } }, halt: {}, reconciler: { alive: true },
  account: { venues: { paper: { ok: true, equity: 50000, positions: {} } } }, config: { amounts: {} }, states: {}, orders: [], events: [], order_errors: [ERR], ...o });
// 一般加密列:機器端對它**不寫 gates**(兩側門檻都等於 flat),所以 last_reconcile.gates 是空的
const crypto = (target, actual) => base({ config: { amounts: { s: target } }, states: { s: { symbol: "BTCUSDT", market: "swap", position: 1 } },
  last_reconcile: { ts: "2026-09-21T14:27:00", target: { BTCUSDT: { amount: target, exchange: "binance" } }, actual: { BTCUSDT: { size: actual, side: "long" } }, orders: [], gates: {} } });

// ① + ② Wei 撞到的那個:金額改成 20,000、已成交、目標與實際相符 → 過期紅字不可以留
t("① 加密列:差額已歸零 → 過期的失敗紅字不掛(這就是 Wei 在 Electron 44 看到的那個)", paint(crypto(20000, 20000)).red === null);
t("② 加密列、沒有 gate、差額 3 → **不**算欠著(不可以拿「沒有 gate」當口數訊號,不然 ① 就被改回去了)", paint(crypto(20003, 20000)).red === null);
t("加密列差額真的過了門檻(單還沒送出去)→ 紅字照掛", /ERR:BTCUSDT/.test(paint(crypto(30000, 20000)).red || ""));

// ③ 口數列:機器端不寫 gates、下單沒門檻,差 1 口就送單
const lots = (target, actual, how) => base({ order_errors: [{ ts: "2026-09-21T14:26:00", symbol: "TXF", error: "capital rejected" }],
  config: { amounts: { s: target } }, states: { s: { symbol: "TXF", market: "swap", position: 1 } },
  last_reconcile: { ts: "2026-09-21T14:27:00", orders: [], gates: {},
    target: { TXF: { amount: target, ...(how === "spec" ? { asset_spec: { type: "futures_contracts", contract_value: 200 } } : { exchange: "capital" }) } },
    actual: { TXF: { size: actual, side: "long", ...(how === "spec" ? {} : { exchange: "capital" }) } } } });
t("③ 口數列差 1 口(asset_spec 認出來)→ 失敗紅字留得住", /ERR:TXF/.test(paint(lots(3, 2, "spec")).red || ""));
t("③ 口數列差 2 口(exchange=capital 認出來)→ 失敗紅字留得住", /ERR:TXF/.test(paint(lots(5, 3, "cap")).red || ""));
t("口數列差額歸零 → 過期紅字照樣不掛", paint(lots(3, 3, "spec")).red === null);
t("口數列的差額不被畫成灰色(hold):差 1 口是真的會送單", paint(lots(3, 2, "spec")).holds === 0 && paint(crypto(20003, 20000)).holds === 1);

console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
