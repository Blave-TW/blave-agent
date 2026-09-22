// 表底那行「下單失敗」:**真的跑一次 trPositions**,看它到底掛不掛、掛紅還是掛灰(不是把判斷重寫一遍)。
// 釘住的回歸:
//   ① 過期的失敗不可以留(Wei 在 Electron 44 看到:22:26 的「部位要到 110,000」掛在一張寫著 20,000、目標與實際已相符的表下面)
//   ② 一般加密列**不可以**被當成口數列(lib/portfolio.py:1119「兩側門檻都等於 flat 就不寫 gates」= 加密的常態;
//      拿「沒有 gate」當口數訊號的話,①又會被改回去)
//   ③ 口數列(群益 / futures_contracts)的失敗不可以被藏掉:機器端對它們不寫 gates、下單也沒門檻,差 1 口就真的送單
//   ④ 丙案:哪一筆要掛不看執行狀態,執行狀態只決定音量——對帳器在跑 = 紅字;沒在跑(暫停或掛掉不分)= 同一筆降灰
//      「上次下單失敗」帶 HH:mm、逾 24 小時帶日期;本機與雲端視角同一條規則,狀態來源與頁頭同一個(envHeadState)
//   ⑤ 稽核 B1:漂移容忍帶——同向且兩邊都有倉、差額在 band_usd 內 = 機器端不會下單(lib/portfolio.compute_diff 的 applied = max(該側, band_usd)),
//      這一列不畫綠、舊拒單不掛;帶外照掛;翻向不看帶;舊快照沒有 band_usd 行為不變
// 跑法:node tests/check_shell_stale_err.js
const fs = require("fs"), path = require("path"), vm = require("vm");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");

// trPositions 會碰 DOM 與 i18n:給它一個夠用的假環境,其餘從原文切出來的純邏輯照跑(狀態判定 trExecState / envHeadState 也是真的)
const cutBlock = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b); if (i < 0 || j < 0) throw new Error("找不到標記:" + a); return src.slice(i, j); };
const pure = cutBlock("/* ── 純邏輯(", "/* ── 純邏輯到此") + cutBlock("/* ── 視角純邏輯(", "/* ── 視角純邏輯到此");
const cut = (name) => { const i = src.indexOf("function " + name + "("); let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("no " + name); };

const node = (tag) => ({ tag, cls: "", kids: [], text: "", appendChild(c) { this.kids.push(c); return c; }, append(...c) { c.forEach((x) => this.kids.push(x)); },
  setAttribute() {}, get textContent() { return this.text + this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }, set textContent(v) { this.text = v; this.kids = []; } });
const flat = (n, out = []) => { if (n && n.tag) { out.push(n); (n.kids || []).forEach((k) => flat(k, out)); } return out; };

// 時鐘釘死:失敗時間與「現在」的距離決定要不要帶日期
const NOW = Date.parse("2026-09-21T14:30:00Z");
class FixedDate extends Date { static now() { return NOW; } }

// st = 本機 status() / 雲端 cloud.js status() 回的那一包({ alive, running, report, cloud? });預設本機、常駐程式在
function paint(report, st = {}) {
  const ctx = {
    TR: { env: st.cloud ? "cloud" : "local", st: { alive: true, running: true, report, ...st } }, TR_BAGS: { local: {}, cloud: {} },
    t: (k, v) => k + (v ? JSON.stringify(v) : ""), LANG: "zh", Date: FixedDate, Math, Object, Array, String, Number, isFinite, JSON,
    document: { createElement: node, createDocumentFragment: () => node("frag") },
  };
  ctx.trEl = (tag, cls, text) => { const n = node(tag); n.cls = cls || ""; if (text != null) n.text = text; return n; };
  ctx.trSec = (x) => x; ctx.trTipLabel = (a2, b2) => node("span"); ctx.trHead = () => node("thead");
  ctx.trMoneyInto = (n, v) => { n.text = String(v); }; ctx.trFmt = (v) => String(v); ctx.trFmt2 = (v) => String(v);
  ctx.trUnit = () => "USDT"; ctx.trCcy = () => "USDT"; ctx.TR_STALE_MS = 10 * 60 * 1000;
  ctx.trVenueIds = (r) => Object.keys((r && r.venues) || {}); ctx.trLiveEntry = (r, id) => ((r && r.account && r.account.venues) || {})[id] || null;
  ctx.trOrderErrText = (sym, err) => "ERR:" + sym + ":" + err;
  vm.createContext(ctx);
  vm.runInContext(pure.replace(/^const /gm, "var "), ctx);
  vm.runInContext(["trLivePositions", "trClientTargets", "trGateSide", "trPositions"].map(cut).join("\n").replace(/^const /gm, "var "), ctx);
  const frag = vm.runInContext("trPositions(TR.st.report, TR.st.report.config.amounts, TR.st.report.states)", ctx);
  const all = flat(frag), errRow = all.find((n) => n.cls === "pf-foot err"), pastRow = all.find((n) => n.cls === "pf-foot past"), gateRow = all.find((n) => n.cls === "pf-foot");
  const holds = all.filter((n) => /(^| )hold( |$)/.test(n.cls)).length;
  const stamp = pastRow ? (pastRow.kids.find((k) => k.tag === "span" && k.cls === "ts mono") || {}).text || null : null;
  return { red: errRow ? errRow.textContent : null, past: pastRow ? pastRow.textContent : null, stamp, holds, foot: gateRow ? gateRow.textContent : null };
}

const ERR = { ts: "2026-09-21T14:26:00", symbol: "BTCUSDT", exchange: "binance", error: "order rejected: gross notional 110000 exceeds 10x paper equity 9945" };
/* halt / reconciler 照 runtime/portfolio_reporter.py 的形狀:halt_state() 沒 HALT 檔 = { halted: false },有 = { halted, at, reason, source, blocked };
   reconciler = { heartbeat_at: 心跳檔 mtime(epoch 秒), alive: 300 秒內 } */
const HB = NOW / 1000 - 3;
const base = (o) => ({ venues: { paper: { credentials: true, pair: true, order: true, account: true } }, halt: { halted: false }, reconciler: { heartbeat_at: HB, alive: true },
  account: { venues: { paper: { ok: true, equity: 50000, positions: {} } } }, config: { amounts: {} }, states: {}, orders: [], events: [], order_errors: [ERR], ...o });

/* 下面兩個 fixture 的欄位**照真的快照**,不是手寫的模型:在暫存 workspace 用真的 portfolio_config + state.json
   跑了一次 lib.portfolio.reconcile(假的 place_order_fn、不連交易所),dump 出來的 manager/last_reconcile.json 長這樣——
     target[sym] = { side, size, exchange, asset_spec, market, contributors, gated }
     actual[sym] = { side, size, exchange }
     加密列 exchange="binance"、asset_spec=null;口數列 exchange="capital"、asset_spec.type="futures_contracts"
     **gates 兩邊都是 {}** ← 這就是為什麼不能拿「沒有 gate」當口數訊號
   那一輪也證實了口數列差 1 口真的會送單(place_order_fn 收到 ("TXF", 1.0, {...futures_contracts...}, False))。 */
const tRow = (size, exchange, spec) => ({ side: "long", size, exchange, asset_spec: spec || null, market: "swap",
  contributors: [{ strategy: "s", position: 1, amount: size, contribution: size }], gated: false });
const aRow = (size, exchange) => ({ side: "long", size, exchange });
// 一般加密列:機器端對它**不寫 gates**(兩側門檻都等於 flat),所以 gates 是 {}
const crypto = (target, actual, o) => base({ config: { amounts: { s: target } }, states: { s: { symbol: "BTCUSDT", market: "swap", position: 1 } },
  last_reconcile: { ts: "2026-09-21T14:27:00", target: { BTCUSDT: tRow(target, "binance", null) }, actual: { BTCUSDT: aRow(actual, "binance") }, orders: [], gates: {} }, ...o });

// ① + ② Wei 撞到的那個:金額改成 20,000、已成交、目標與實際相符 → 過期紅字不可以留
t("① 加密列:差額已歸零 → 過期的失敗紅字不掛(這就是 Wei 在 Electron 44 看到的那個)", paint(crypto(20000, 20000)).red === null);
t("② 加密列、沒有 gate、差額 3 → **不**算欠著(不可以拿「沒有 gate」當口數訊號,不然 ① 就被改回去了)", paint(crypto(20003, 20000)).red === null);
t("加密列差額真的過了門檻(單還沒送出去)→ 紅字照掛", /ERR:BTCUSDT/.test(paint(crypto(30000, 20000)).red || ""));

// ③ 口數列:機器端不寫 gates、下單沒門檻,差 1 口就送單
// 口數列:真快照是 exchange="capital" **而且** asset_spec.type="futures_contracts" 兩個都有;分開測是為了確認兩條路各自都認得出來
const lots = (target, actual, how) => base({ order_errors: [{ ts: "2026-09-21T14:26:00", symbol: "TXF", exchange: "capital", error: "capital rejected" }],
  config: { amounts: { s: target } }, states: { s: { symbol: "TXF", market: "swap", position: 1 } },
  last_reconcile: { ts: "2026-09-21T14:27:00", orders: [], gates: {},
    target: { TXF: how === "spec" ? tRow(target, "sinopac", { type: "futures_contracts", contract_value: 200, currency: "TWD", lot_size: 1 }) : tRow(target, "capital", null) },
    actual: { TXF: aRow(actual, how === "spec" ? "sinopac" : "capital") } } });
t("③ 口數列差 1 口(asset_spec 認出來)→ 失敗紅字留得住", /ERR:TXF/.test(paint(lots(3, 2, "spec")).red || ""));
t("③ 口數列差 2 口(exchange=capital 認出來)→ 失敗紅字留得住", /ERR:TXF/.test(paint(lots(5, 3, "cap")).red || ""));
t("口數列差額歸零 → 過期紅字照樣不掛", paint(lots(3, 3, "spec")).red === null);
t("口數列的差額不被畫成灰色(hold):差 1 口是真的會送單", paint(lots(3, 2, "spec")).holds === 0 && paint(crypto(20003, 20000)).holds === 1);

// ④ 丙案:同一筆還欠著的失敗,在跑 → 紅;沒在跑 → 灰字「上次下單失敗」(不是不畫)
const HALT = { halted: true, at: "2026-09-21T14:28:00", reason: "desktop ui", source: "web", blocked: 0 };
const DEAD = { heartbeat_at: NOW / 1000 - 3600, alive: false };
const LAST = (p) => p.past != null && /tr\.orderFailedLast/.test(p.past) && /"sym":"BTCUSDT"/.test(p.past) && /gross notional 110000/.test(p.past);
{ const p = paint(crypto(30000, 20000));
  t("④ running:紅字位置與現況相同、沒有灰字變體", p.red != null && p.past === null); }
{ const p = paint(crypto(30000, 20000, { halt: HALT }));
  t("④ halted(用戶按的暫停):整格沒有 redText,同一筆降灰「上次下單失敗」帶標的與原文", p.red === null && LAST(p));
  t("④ halted:失敗在 4 分鐘前 → 只帶 HH:mm", /^\d\d:\d\d$/.test(p.stamp || "")); }
{ const p = paint(crypto(30000, 20000, { reconciler: DEAD }));
  t("④ dead(心跳過期、不是用戶按的):同樣降灰,不藏掉「為什麼」", p.red === null && LAST(p)); }
{ const p = paint(crypto(30000, 20000, { reconciler: DEAD, order_errors: [{ ...ERR, ts: "2026-09-19T14:26:00" }] }));
  t("④ 失敗逾 24 小時 → 帶日期 MM/DD HH:mm(dead 常常已隔天,沒日期會讀成今天)", /^\d\d\/\d\d \d\d:\d\d$/.test(p.stamp || "")); }
{ const p = paint(crypto(30000, 20000), { alive: false });
  t("④ 常駐程式不在(st.alive=false,狀態檔裡的「對帳器活著」不能信)→ 灰", p.red === null && LAST(p)); }
t("④ 沒在跑也**不會**把已解決的那筆撿回來:差額歸零 → 紅灰都不掛(判準沒動,只加了音量)",
  (() => { const p = paint(crypto(20000, 20000, { halt: HALT })); return p.red === null && p.past === null; })());
t("④ 口數列一樣:halted 時差 1 口的失敗降灰、不是消失", (() => { const p = paint({ ...lots(3, 2, "spec"), halt: HALT }); return p.red === null && p.past != null && /"sym":"TXF"/.test(p.past); })());

// 雲端視角:狀態來源跟頁頭同一個(envHeadState)。連不上但上一份回報 1 小時內說在跑 → 頁頭寫「執行中」,這裡就得是紅;
// 回報太舊(頁頭寫「讀不到」)→ 不能肯定它會再送,降灰
const CLOUD = (extra) => ({ alive: false, cloud: { code: "OK", machine: { state: "running" }, strategies: [], stale: false, ...extra } });
{ const p = paint(crypto(30000, 20000), CLOUD({ last_ok_at: NOW - 40000 }));
  t("④ 雲端:連不上、上一份回報(1 小時內)說在下單 → 跟頁頭一致,紅", p.red != null && p.past === null); }
{ const p = paint(crypto(30000, 20000), CLOUD({ last_ok_at: NOW - 2 * 3600000 }));
  t("④ 雲端:回報過舊、頁頭已退成「讀不到」→ 降灰", p.red === null && LAST(p)); }
{ const p = paint(crypto(30000, 20000, { halt: HALT }), { alive: true, cloud: { code: "OK", machine: { state: "running" }, strategies: [], stale: false, last_ok_at: NOW - 5000 } });
  t("④ 雲端:主機說已暫停 → 降灰(halted / dead 不分)", p.red === null && LAST(p)); }

// ⑤ 漂移容忍帶。gates 列照 lib/portfolio.compute_diff 寫出的形狀:{ usd, diff, entry_usd, reduce_usd, close_usd[, side: "reduce"][, band_usd] };
//    一般加密列兩側門檻都是 flat 10,只因 band_usd > flat 才被記下來,所以 usd === band_usd
const banded = (target, actual, band, o) => { const diff = target - actual, g = { usd: Math.max(10, band || 0), diff, entry_usd: 10, reduce_usd: 10, close_usd: 10 };
  if (Math.abs(target) < Math.abs(actual)) g.side = "reduce"; if (band) g.band_usd = band;
  return base({ config: { amounts: { s: Math.abs(target) } }, states: { s: { symbol: "BTCUSDT", market: "swap", position: target < 0 ? -1 : 1 } },
    last_reconcile: { ts: "2026-09-21T14:27:00", target: { BTCUSDT: { ...tRow(Math.abs(target), "binance", null), side: target < 0 ? "short" : "long" } },
      actual: { BTCUSDT: { ...aRow(Math.abs(actual), "binance"), side: actual < 0 ? "short" : "long" } }, orders: [], gates: { BTCUSDT: g } }, ...o }); };
{ const p = paint(banded(20300, 20000, 1015));
  t("⑤ 同向加倉、差額 300 在帶(1,015)內 → 不畫綠、舊拒單不掛(這就是 B1 那格)", p.red === null && p.holds === 1);
  t("⑤ 帶內那列的腳注講「在容忍帶內」,不是「差額不到 10」也不是「超出不到半口」", /tr\.gateFootBand/.test(p.foot || "") && /"m":"1015"/.test(p.foot || "") && !/gateFootEntry|gateFootReduce/.test(p.foot || "")); }
{ const p = paint(banded(19800, 20000, 1000));
  t("⑤ 同向減倉、差額 200 在帶內 → 同樣不掛、腳注是帶(不是半口)", p.red === null && p.holds === 1 && /tr\.gateFootBand/.test(p.foot || "") && !/gateFootReduce/.test(p.foot || "")); }
t("⑤ 差額 1,500 超出帶(1,000)→ 綠字、紅字照掛", (() => { const p = paint(banded(21500, 20000, 1000)); return /ERR:BTCUSDT/.test(p.red || "") && p.holds === 0; })());
t("⑤ 翻向(多 → 空)不看帶:快照那輪同向留下的 band_usd 不能把翻向畫成不會動", (() => { const p = paint(banded(-20000, 20000, 1000)); return /ERR:BTCUSDT/.test(p.red || "") && p.holds === 0; })());
t("⑤ 舊快照沒有 band_usd(gates 只有兩側 10):差額 300 照舊會下單、紅字照掛", (() => { const p = paint(banded(20300, 20000, 0)); return /ERR:BTCUSDT/.test(p.red || "") && p.holds === 0; })());
t("⑤ 帶內、對帳器沒在跑 → 也不會把舊拒單撿回來當灰字(判準先於音量)", (() => { const p = paint(banded(20300, 20000, 1015, { halt: HALT })); return p.red === null && p.past === null; })());

console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
