// 報告頁「成交測試」分頁(shell/renderer/report-xt.js;spec .claude/output/specs/lag-test-tab-2026-10-26.md)。
//   ① 純函式(node vm 載入):挑數字的門檻、契約清洗、y 軸範圍、歸零成本位置——測資同 web tests/check_exec_test_tab.js
//   ② renderXt 用最小假 DOM 跑 spec §3.5 的兩層狀態(按了才算,10-27):xtPageOf 整頁、xtCellOf 鈕那一格;有結果(頂列 meta＋〔重新測試〕＋結論卡＋兩段)、
//      新鮮描邊／過時填色＋卡頂過時句、交易太少(只有卡)、空狀態(.rob-empty 只有〔開始測試〕那一格,沒有說明句)、
//      這頁按的那次在跑(舊結果整塊收掉、只留頂列)、別處按的在跑(結果照畫)、時光機(vpanel-note、不給鈕)、
//      主機落後(只換鈕那一格:空狀態句子在鈕上、結果頁句子在鈕下,結果照畫);
//      禁用的判讀標籤／評語字不出現在程式與兩語譯文
//   ③ 接線:分頁位置(樣本外驗證 → 成交測試 → 程式碼)、每一份分頁清單都有 xt、時光機只在重跑中停用、鈕走 perf.js(stats_refresh 帶 exec_test)
// 跑法:node tests/check_shell_xt.js
const path = require("path"), fs = require("fs"), vm = require("vm");
const SHELL = path.join(__dirname, "..", "shell"), R = (f) => fs.readFileSync(path.join(SHELL, f), "utf8");
let red = 0; const ok = (n, c, why) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || why === undefined ? "" : "\n      " + JSON.stringify(why))); if (!c) red++; };

// ── 最小假 DOM:renderXt 只用到 createElement / 文字節點 / fragment / dataset / querySelector(依 data 屬性找鈕) ──
class Node {
  constructor(tag) { this.tag = tag; this.kids = []; this.parentNode = null; this.attrs = {}; this.dataset = {}; this.style = {}; this.on = {}; this._t = ""; this.className = ""; this.hidden = false; this.disabled = false; this.type = ""; this.id = ""; }
  appendChild(c) { if (c instanceof Frag) { c.kids.slice().forEach((k) => this.appendChild(k)); c.kids = []; return c; } if (c.parentNode && c.parentNode.kids) c.parentNode.kids.splice(c.parentNode.kids.indexOf(c), 1); c.parentNode = this; this.kids.push(c); return c; }
  contains(n) { return this.all().includes(n); }
  closest(sel) { const m = /^\[data-([\w-]+)\]$/.exec(sel), key = m && m[1].replace(/-(\w)/g, (_, c) => c.toUpperCase()); let n = this; while (n) { if (key && n.dataset && key in n.dataset) return n; n = n.parentNode; } return null; }
  append(...cs) { cs.forEach((c) => this.appendChild(typeof c === "string" ? new Text(c) : c)); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { this.on[t] = f; }
  get textContent() { return this._t + this.kids.map((k) => k.textContent).join(""); }
  set textContent(v) { this._t = String(v); this.kids = []; }
  all() { return [this].concat(...this.kids.map((k) => (k.all ? k.all() : []))); }
  has(cls) { return (" " + this.className + " ").includes(" " + cls + " "); }
  querySelector(sel) {
    const m = /data-xt-sec="(\w+)"\]\[data-xt-key="(\w+)"/.exec(sel);
    if (m) return this.all().find((n) => n.dataset && n.dataset.xtSec === m[1] && n.dataset.xtKey === m[2]) || null;
    const d = /^\[data-([\w-]+)\]$/.exec(sel), key = d && d[1].replace(/-(\w)/g, (_, c) => c.toUpperCase());
    return key ? this.all().find((n) => n !== this && n.dataset && key in n.dataset) || null : null;
  }
  focus() { FOCUS.at = this; }
}
class Text { constructor(s) { this.s = s; } get textContent() { return this.s; } }
class Frag extends Node {}
const FOCUS = { at: null };
const document = { createElement: (t) => new Node(t), createDocumentFragment: () => new Frag("#frag"), createTextNode: (s) => new Text(s), get activeElement() { return FOCUS.at; } };
const window = {};
const sb = { window, document, Node, console };
vm.createContext(sb);
for (const f of ["report-backtest.js", "report-xt.js"]) vm.runInContext(R("renderer/" + f), sb);
window.renderReportLevels = (sp) => { const n = new Node("div"); n.className = "levels"; n.spec = sp; return n; };
const X = window.BlaveReport._xt;

// ── ① 純函式 ──
ok("① 門檻常數照 spec §3.1", JSON.stringify(X.XT_TH) === JSON.stringify({ flat: 0.12, oneBig: 0.15, oneSmall: 0.05, costDrop: 0.25, lowSharpe: 0.3, fewChanges: 20, closeFill: 0.02 }), X.XT_TH);
const T = (s, a, m) => [s, a, m];
const mk = (lag, cost, o) => Object.assign({
  lag: { "0": T(lag[0], 10, -10), "1": T(lag[1], 9, -11), "2": T(lag[2], 9, -11), "3": T(lag[3], 9, -11), "5": T(lag[4], 9, -11), "10": T(lag[5], 8, -12) },
  close_fill: T(lag[0], 10, -10),
  cost: { free: T(cost[0], 11, -9), "0.01": T(cost[1], 9, -10), "0.02": T(cost[2], 9, -10), "0.05": T(cost[3], 8, -10), "0.1": T(cost[4], 7, -11), "0.2": T(cost[5], 6, -12), "0.5": T(cost[6], 1, -20) },
  fee_per_side_pct: 0.005, breakeven_pct_per_side: 0.063, turnover_per_year: 510.7, position_changes: 18556,
}, o || {});
const A = mk([1.618, 1.237, 1.133, 0.903, 0.663, 0.565], [1.757, 1.338, 1.058, 0.22, -1.161, -3.777, -9.641], { close_fill: T(1.799, 35.7, -16.7) });
const a = X.xtSanitize(A), va = X.xtVerdict(a);
ok("① Type A:晚一根掉 24% → 只講晚一根;成本講 +0.02%、掉到 1.058", va.lag.k === "one" && Math.round(Math.abs(va.lag.r1) * 100) === 24 && va.cost.k === "down" && va.cost.x === "0.02" && va.cost.s1 === 1.058, va);
ok("① 收盤成交差 11% → 講;歸零 0.063 落在 +0.05 與 +0.1 之間", Math.round(X.xtCloseFill(a).d * 100) === 11 && (() => { const b = X.xtBreakeven(a); return !b.out && b.at > 4 && b.at < 5; })());
const C = mk([0.887, 0.943, 0.92, 0.893, 0.942, 0.92], [1.176, 0.878, 0.872, 0.855, 0.826, 0.768, 0.595], { fee_per_side_pct: 0.5, breakeven_pct_per_side: 2.043 });
const vc = X.xtVerdict(X.xtSanitize(C));
ok("① Type C:晚 10 根內 ±12% → 講區間 0.887–0.943;成本都沒掉 25% → 講 +0.05%;歸零在軸外", vc.lag.k === "flat" && vc.lag.lo === 0.887 && vc.lag.hi === 0.943 && vc.cost.x === "0.05" && X.xtBreakeven(X.xtSanitize(C)).out === true, vc);
const flat7 = [1, 1, 1, 1, 1, 1, 1];
ok("① 晚一根 10% → oneFive;晚一根 2%、晚 10 根掉 40% → mixed;正好 15% → one",
  X.xtVerdict(X.xtSanitize(mk([1, 0.9, 0.9, 0.9, 0.8, 0.5], flat7))).lag.k === "oneFive" && X.xtVerdict(X.xtSanitize(mk([1, 0.98, 1.0, 0.95, 1.1, 0.6], flat7))).lag.k === "mixed"
  && X.xtVerdict(X.xtSanitize(mk([1, 0.85, 1, 1, 1, 1], flat7))).lag.k === "one");
const low = X.xtSanitize(mk([0.178, 0.139, 0.166, 0.24, 0.174, -0.206], [0.193, 0.175, 0.172, 0.162, 0.147, 0.117, 0.026], { close_fill: T(0.25, 0, 0) }));
ok("① 現行 Sharpe <0.3:只列數值、成本講 +0.05%、不畫歸零、不講收盤成交", (() => { const v = X.xtVerdict(low); return v.lag.k === "low" && v.cost.k === "to" && v.cost.x === "0.05" && X.xtBreakeven(low) === null && X.xtCloseFill(low) === null; })());
ok("① 換倉 19 次 → 只出交易太少;20 次照常", X.xtVerdict(X.xtSanitize(mk([1, 1, 1, 1, 1, 1], flat7, { position_changes: 19 }))).few === 19 && X.xtVerdict(X.xtSanitize(mk([1, 1, 1, 1, 1, 1], flat7, { position_changes: 20 }))).few === undefined);
const broken = mk([1, 1, 1, 1, 1, 1], flat7); delete broken.lag["10"];
ok("① 契約清洗:沒有 / 少一個 k / 缺 free / 換倉不是整數 → null;格子 null 退回只列數值;breakeven null → null",
  X.xtSanitize(undefined) === null && X.xtSanitize(broken) === null && X.xtSanitize({ ...mk([1, 1, 1, 1, 1, 1], flat7), cost: {} }) === null
  && X.xtSanitize(mk([1, 1, 1, 1, 1, 1], flat7, { position_changes: "9" })) === null && X.xtVerdict(X.xtSanitize(mk([1, null, 1, 1, 1, 1], flat7))).lag.k === "low"
  && X.xtSanitize(mk([1, 1, 1, 1, 1, 1], flat7, { breakeven_pct_per_side: null })).be === null);
ok("① y 軸:晚幾根 Sharpe ±30%、年化含 0、回撤到 1.3 倍;成本 Sharpe 下限 −max(現行, 0.5)、年化至少 −10%、回撤 −100%;費率位數",
  Math.abs(X.xtLagRange(0, 1).lo - 0.7) < 1e-9 && X.xtLagRange(1, 20).lo === 0 && X.xtLagRange(2, -20).lo === -26 && X.xtCostRange(0, 1.6).floor === -1.6 && X.xtCostRange(0, 0.2).floor === -0.5
  && X.xtCostRange(1, 5).floor === -10 && X.xtCostRange(2, -16).floor === -100 && X.xtFeeDp(0.005) === 3 && X.xtFeeDp(0.05) === 2);

// ── ② renderXt 四態 ──
const zh = {}; for (const m of R("i18n/zh.po").matchAll(/^msgid "([^"]+)"\nmsgstr "((?:[^"\\]|\\.)*)"$/gm)) zh[m[1]] = JSON.parse('"' + m[2] + '"');
const t = (k, vars) => { let s = zh[k] || k; if (vars) for (const v in vars) s = s.split("{" + v + "}").join(vars[v]); return s; };
const STATS = { symbol: "BTCUSDT", interval: "1h", start: "2023-01-01", end: "2024-01-01", "fee [%]": 0.005 };
const metaSeen = [];
const run = (stats, extra) => {
  const box = new Node("div"), slots = [];
  const opts = Object.assign({ t, buildMeta: (o) => { metaSeen.push(o); const n = new Node("div"); n.className = "bt-meta"; return n; }, rerun: (kind) => { const n = new Node("div"); n.className = "SLOT"; n.kind = kind; slots.push(n); return n; } }, extra || {});
  window.BlaveReport.renderXt(box, { stats, name: "s1", market: "crypto" }, opts);
  const nodes = box.all();
  return { box, nodes, text: box.textContent, slots, cls: (c) => nodes.filter((n) => n.has && n.has(c)) };
};
const fresh = { ...STATS, "Sharpe Ratio": 1.618, exec_test: A };
const full = run(fresh);
ok("② 有結果、新鮮:頂列(meta＋〔重新測試〕描邊那格)→ 結論卡(判讀句兩句、晚一根掉 24%、+0.02%、沒有過時句)→ 晚幾根成交 → 成本高一點",
  full.cls("rob-top").length === 1 && full.cls("rob-top")[0].kids.map((k) => k.className).join() === "bt-meta,SLOT" && full.slots.length === 1 && full.slots[0].kind === "fresh"
  && full.cls("rob-verdict").length === 1 && full.cls("rob-verdict")[0].textContent === "晚一根 Sharpe 掉 24%。每邊成本多 0.02%，Sharpe 從 1.62 掉到 1.06。"
  && full.cls("xt-sec").length === 2 && full.text.includes("晚幾根成交") && full.text.includes("成本高一點") && full.cls("xt-stale").length === 0 && full.box.kids[0].dataset.xtMineRun === "false",
  full.cls("rob-verdict").map((n) => n.textContent));
ok("② meta 只交標的／週期／期間(全頁叫交易成本,費率由成本段標題列講)", JSON.stringify(Object.keys(metaSeen[0])) === '["symbol","interval","start","end"]' && full.text.includes("現行每邊 0.005%・年換手 511 倍"));
ok("② 晚幾根的圖:橫軸 現行 +1…+10、Sharpe 不帶單位、虛線在現行;1 根＝1 小時", (() => { const s = full.cls("levels")[0].spec; return s.labels.join() === "現行,+1,+2,+3,+5,+10" && s.unit === "" && s.base === 1.618 && s.cur === 0; })() && full.text.includes("1 根＝1 小時，晚 10 根＝10 小時"));
ok("② 收盤成交差 ≥2%:講一句(吃掉 11%)", full.text.includes("訊號那根收盤就成交：Sharpe 1.80（現行 1.62）。開盤跳空吃掉 11%。"));
const pick = full.box.querySelector('button[data-xt-sec="lag"][data-xt-key="ann"]');
ok("② 表頭鈕 aria-pressed、指向說明句;點年化 → 只換晚幾根那段的圖(成本段仍是 Sharpe),焦點留在新的那顆",
  !!pick && pick.getAttribute("aria-pressed") === "false" && pick.getAttribute("aria-describedby") === "xt-lag-how" && !pick.getAttribute("aria-label") && (() => {
    pick.on.click(); const lv = full.box.all().filter((n) => n.has && n.has("levels"));
    return lv[0].spec.unit === "%" && lv[1].spec.unit === "" && FOCUS.at && FOCUS.at.dataset.xtKey === "ann" && FOCUS.at.getAttribute("aria-pressed") === "true";
  })());
window.BlaveReport.renderXt(new Node("div"), { stats: { ...STATS, exec_test: A } }, { t });   // 下一個測試從 Sharpe 起
full.box.querySelector('button[data-xt-sec="lag"][data-xt-key="sharpe"]').on.click();
{ let n = 0; const m = run({ ...STATS, exec_test: A }, { onMetric: () => { n++; } }), q = (k) => m.box.querySelector('button[data-xt-sec="cost"][data-xt-key="' + k + '"]');
  q("mdd").on.click(); const a = n; q("mdd").on.click(); const b = n; q("sharpe").on.click();
  ok("② 換指標才叫 onMetric(埋點 xt_metric 在 app.js):換一次一次、點已選的那顆不叫", a === 1 && b === 1 && n === 2, String([a, b, n])); }
const few = run({ ...STATS, "Sharpe Ratio": 1, exec_test: mk([1, 1, 1, 1, 1, 1], flat7, { position_changes: 7 }) });
ok("② 交易太少:只有結論卡那一句,兩段不畫", few.cls("rob-verdict")[0].textContent === "交易太少（回測期間換倉 7 次），延遲和成本都測不出東西。" && few.cls("xt-sec").length === 0);
const stale = run({ ...STATS, "Sharpe Ratio": 1.7, exec_test: A });
ok("② 有結果、過時(現行 1.618 ≠ Sharpe Ratio 1.7):卡頂先一句過時句、判讀句照出、〔重新測試〕那格是 stale(填色)、兩段照畫",
  stale.cls("xt-stale").length === 1 && stale.cls("rob-card")[0].kids[0].textContent === "績效更新過，重新測試後才會更新。" && stale.cls("rob-verdict").length === 2
  && stale.slots[0].kind === "stale" && stale.cls("xt-sec").length === 2);
const empty = run({ ...STATS });
ok("② 空狀態(沒有 exec_test):.rob-empty 裡只有〔開始測試〕那一格(empty),沒有說明句、沒有霧、沒有 meta", empty.cls("rob-empty").length === 1 && empty.cls("rob-empty")[0].kids.length === 1
  && empty.slots.length === 1 && empty.slots[0].kind === "empty" && empty.cls("rob-empty-txt").length === 0 && empty.cls("xt-fog").length === 0 && empty.cls("bt-meta").length === 0 && !empty.text.includes("看晚幾根"));
const bad = run({ ...STATS, exec_test: { lag: {} } });
ok("② exec_test 壞形狀(xtSanitize 不過)= 空狀態", bad.cls("rob-empty").length === 1 && bad.slots[0].kind === "empty");
const nos = run({ ...STATS }, { rerun: () => null });
ok("② 不能更新績效(perfShown 假):空的 .rob-empty,沒有鈕", nos.cls("rob-empty").length === 1 && nos.cls("rob-empty")[0].kids.length === 0);
const mineRun = run(fresh, { ui: () => ({ perf: "running", mine: "run" }) });
ok("② 這頁按的那次在跑(#5):只留頂列(meta＋鈕那格),結論卡與兩段整塊收掉,不淡化", mineRun.cls("rob-top").length === 1 && mineRun.cls("rob-card").length === 0 && mineRun.cls("xt-sec").length === 0
  && mineRun.box.kids[0].dataset.xtMineRun === "true");
const otherRun = run(fresh, { ui: () => ({ perf: "running", mine: null }) }), busyRun = run(fresh, { ui: () => ({ perf: "running", mine: "busy" }) });
ok("② 別處按的在跑、或這頁按的那次 BUSY:結果照畫(那次不會算 exec_test)", otherRun.cls("xt-sec").length === 2 && busyRun.cls("xt-sec").length === 2
  && otherRun.box.kids[0].dataset.xtMineRun === "false" && busyRun.box.kids[0].dataset.xtMineRun === "false");
const failRun = run(fresh, { ui: () => ({ perf: "failed", mine: "fail" }) });
ok("② 這頁按的那次失敗(#8):有結果時結果不收", failRun.cls("xt-sec").length === 2 && failRun.slots.length === 1);
const old = run(null, { old: true });
ok("② 時光機看舊版本(#1):只有一句 vpanel-note「舊版本沒存這一頁的數字。」、不給鈕(rerun 不被叫)", old.cls("vpanel-note").length === 1 && old.text === "舊版本沒存這一頁的數字。" && old.slots.length === 0 && old.nodes.every((n) => n.tag !== "button"));
const beh = run({ ...STATS }, { behind: true, onUpdate: () => { beh.updated = true; } });
const go = beh.nodes.find((n) => n.tag === "button"), bcell = beh.cls("rob-empty")[0].kids[0];
ok("② 主機落後、空狀態(#3):.rob-empty 裡那一格 = 先更新那句(lead,在鈕上)＋〔去更新〕(onUpdate),不給開始測試", beh.cls("rob-empty").length === 1 && bcell.kids[0].textContent === "先更新主機程式，才能跑成交測試。"
  && bcell.kids[1] === go && beh.slots.length === 0 && !!go && (go.on.click(), beh.updated === true));
const behRes = run(fresh, { behind: true });
const rcell = behRes.cls("rob-top")[0].kids[1], rlines = behRes.cls("xt-lines")[0];
ok("② 主機落後而且有結果:頂列那一格只換成〔去更新〕(格裡只有鈕,meta 不被推);句子在頂列後面那一列(灰記號 .upd-fail.is-calm,同 web);結論卡與兩段照畫",
  rcell.has("xt-upd") && rcell.kids.length === 1 && rcell.kids[0].tag === "button" && behRes.box.kids[0].kids[1] === rlines && rlines.id === "xt-lines"
  && rlines.kids.some((n) => n.has && n.has("upd-fail") && n.has("is-calm") && n.textContent === "先更新主機程式，才能跑成交測試。") && behRes.cls("xt-sec").length === 2 && behRes.slots.length === 0);
{ const line = run(fresh, { rerun: (kind) => { const n = new Node("div"); n.className = "SLOT"; n.dataset.xtUpd = "1"; const b = new Node("button"); const l = new Node("p"); l.className = "upd-fail"; l.dataset.xtLine = "1"; l._t = "沒測成功"; n.append(b, l); return n; } });
  const top = line.cls("rob-top")[0], row = line.cls("xt-lines")[0];
  ok("② 結果頁:perf.js 給的那一格裡帶 data-xt-line 的那一行搬到頂列後面那一列,格裡只留鈕;那一列先有錨點(回合中的原因句接在它後面)",
    top.kids[1].kids.length === 1 && row.kids[0].id === "xt-lines-anchor" && row.kids[0].hidden === true && row.kids[1].textContent === "沒測成功"); }
{ const empty2 = run({ ...STATS }, { rerun: () => { const n = new Node("div"); n.dataset.xtUpd = "1"; const l = new Node("p"); l.dataset.xtLine = "1"; n.append(new Node("button"), l); return n; } });
  ok("② 空狀態:那一行留在那一格裡(鈕下置中),沒有頂列後那一列", empty2.cls("xt-lines").length === 0 && empty2.cls("rob-empty")[0].kids[0].kids.length === 2); }
// 整片重畫時焦點:表頭切指標鈕交還同一顆(不被搶、也不掉到 body);焦點在鈕那一格裡就交還新的鈕,停用時交給那一格
{ const box = new Node("div"), mkSlot = (dis) => () => { const n = new Node("div"); n.dataset.xtUpd = "1"; const b = new Node("button"); b.dataset.perfBtn = "1"; b.disabled = dis; n.appendChild(b); return n; };
  window.BlaveReport.renderXt(box, { stats: fresh }, { t, rerun: mkSlot(false) });
  const ann = box.querySelector('button[data-xt-sec="lag"][data-xt-key="ann"]'); FOCUS.at = ann;
  window.BlaveReport.renderXt(box, { stats: fresh }, { t, rerun: mkSlot(false) });
  const ann2 = box.querySelector('button[data-xt-sec="lag"][data-xt-key="ann"]');
  ok("② 整片重畫(資料推來):焦點在表頭「年化」→ 交還新畫的同一顆,不搶到〔重新測試〕", ann2 && ann2 !== ann && FOCUS.at === ann2);
  FOCUS.at = box.querySelector("[data-perf-btn]");
  window.BlaveReport.renderXt(box, { stats: fresh }, { t, rerun: mkSlot(true) });
  ok("② 整片重畫:焦點在鈕那一格、新鈕停用(這頁按的那次開始跑)→ 交給那一格(role=status 的狀態節點),不帶回分頁列", FOCUS.at === box.querySelector("[data-xt-upd]"));
  window.BlaveReport.renderXt(box, { stats: fresh }, { t, rerun: mkSlot(false) });
  ok("② 整片重畫:焦點在那一格、新鈕可按 → 交給新鈕", FOCUS.at === box.querySelector("[data-perf-btn]"));
  FOCUS.at = null; }
const behRun = run(fresh, { behind: true, ui: () => ({ perf: "running", mine: "run" }) });
ok("② 主機落後時不收結果(落後那格蓋過測試中);perfXtSync 比的旗標仍是「這頁按的那次在跑」= true(跟 perf.js 同一個量,不會一直重畫)", behRun.cls("xt-sec").length === 2 && behRun.box.kids[0].dataset.xtMineRun === "true");
// 兩層狀態(parity 測試另比兩邊同一組情境)
{ const P = X.xtPageOf, C = X.xtCellOf, x0 = X.xtSanitize(A);
  const pages = [P({ verActive: true, x: x0 }), P({ restoring: true }), P({ x: null }), P({ x: x0, sharpe: 1.618 }), P({ x: x0, sharpe: 1.6 }), P({ cfg: false, perf: "running", x: x0, sharpe: 1.618 })];
  const cells = [C({ cfg: false, perf: "running" }), C({ cfg: null }), C({ cfg: true, perf: "running", mine: "busy" }), C({ cfg: true, perf: "failed", mine: "fail", turn: true }),
    C({ cfg: true, perf: "failed", mine: "busy" }), C({ cfg: true, perf: "failed", mine: null }), C({ cfg: true, turn: true }), C({ cfg: true })];
  ok("② xtPageOf:1 時光機、2 還原重跑、4 空、6 新鮮、7 過時(落後、在跑都不影響整頁)", pages.join() === "1,2,4,6,7,6", pages.join());
  ok("② xtCellOf:3 落後(蓋過在跑、null 也算)、5 在跑(BUSY 也是)、8 這頁按的失敗(蓋過回合中)、BUSY／別處的失敗不算 8、9 回合中、0 一般鈕", cells.join() === "3,3,5,8,0,0,9,0", cells.join()); }

// 禁用字:判讀標籤與評語(spec §1、§3.1)不准出現在這頁的程式與兩語譯文
const FORBID = ["緩坡", "斷崖", "完全不動", "越晚越高", "看不出方向", "敏感", "下單要快", "不怕慢", "可疑"];
const xtPo = ["zh", "en"].map((l) => R("i18n/" + l + ".po").split("\n\n").filter((e) => /msgid "(xt\.|rp\.tab\.xt")/.test(e)).join("\n"));
const hit = FORBID.filter((w) => R("renderer/report-xt.js").includes(w) || xtPo.some((p) => p.includes(w)));
ok("② 沒有判讀標籤或評語字;判讀模板兩句、沒有分號", hit.length === 0 && /^\{lag\}。\{cost\}。$/.test(zh["xt.verdict"]) && /msgid "xt\.verdict"\nmsgstr "\{lag\}\. \{cost\}\."/.test(xtPo[1]), hit);

// ── ③ 接線 ──
const html = R("renderer/index.html"), app = R("renderer/app.js"), ver = R("renderer/versions.js"), perf = R("renderer/perf.js"), cloud = R("cloud.js");
const tabs = [...html.matchAll(/class="rp-tab"[^>]*data-tab="(\w+)"/g)].map((m) => m[1]);
ok("③ 分頁順序:樣本外驗證 → 成交測試 → 程式碼;面板、css、js(在 report-backtest.js 之後:借 fmtFixed)", tabs.indexOf("xt") === tabs.indexOf("wf") + 1 && tabs.indexOf("code") === tabs.indexOf("xt") + 1
  && /data-tab="xt" data-i18n="rp\.tab\.xt"/.test(html) && /id="rp-xt" role="tabpanel" hidden/.test(html) && /report-xt\.css/.test(html) && html.indexOf('src="report-xt.js"') > html.indexOf('src="report-backtest.js"'), tabs);
const lists = [app, ver].map((s) => [...s.matchAll(/for \(const k of (\[[^\]]*\])\) \$\("rp-" \+ k\)/g)].map((m) => m[1])).flat();
ok("③ 每一份「藏面板」清單都有 xt(app.js 兩處、versions.js 一處)", lists.length === 3 && lists.every((l) => l === '["bt", "tr", "rob", "wf", "xt", "code"]'), lists);
ok("③ rpShowTab 把 xt 交給 renderXt(落後旗標記在面板上)並叫 perfPaint 接上疊層;雲端狀態輪詢叫 rpXtSync",
  /R\.renderXt\(\$\("rp-xt"\), rpXtData\(B\), o\); if \(typeof perfPaint === "function"\) perfPaint\(B\);/.test(app) && /if \(typeof rpXtSync === "function"\) rpXtSync\(\);/.test(R("renderer/trade.js")));
ok("③ 雲端落後 = config_supports_exec_test 不是 true(spec §3.5 #3);cloud.js 留這欄與 can_exec_test(只認 true)、兩個都進 summaryKey",
  /behind: cloud && rpWfCloud\(\)\.config_supports_exec_test !== true/.test(app) && /config_supports_exec_test: typeof b\.config_supports_exec_test === "boolean" \? b\.config_supports_exec_test : null,/.test(cloud)
  && /can_exec_test: b\.can_exec_test === true,/.test(cloud) && /s\.config_supports_wf, s\.config_supports_exec_test, s\.can_exec_test,/.test(cloud));
ok("③ 時光機:看舊版本 xt 點得開、只有 vpanel-note 不給鈕;重跑中跟其他三個一起停用(同一句 ver.frozenRerun)",
  /const cur = tab === "code" \? "code" : tab === "xt" && S\.open !== null \? "xt" : "bt";/.test(ver) && /\|\| \(b\.dataset\.tab === "xt" && S\.open === null\);/.test(ver)
  && /renderXt\(\$\("rp-xt"\), null, \{ t, old: true \}\)/.test(ver));
ok("③ 鈕 = 更新績效同一條路(perfClick → stats_refresh、ack 才記 perf_update_xt),不開確認框、不送對話;回合中一起 aria-disabled",
  /btn\.addEventListener\("click", \(\) => perfClick\(B, btn\)\);/.test(perf) && /function perfXtSlot\(B, kind\)/.test(perf) && !/confirmBox|submitMessage/.test(perf)
  && /\[\$\("perf-btn"\)\]\.concat\(xt \? \[\.\.\.xt\.querySelectorAll\("\[data-perf-btn\]"\)\] : \[\]\)/.test(perf) && /tradeSend\("stats_refresh", args\)/.test(perf)
  && /perfXtSlot\(B, kind\) : null/.test(app) && /perfXtInfo\(B\) : null/.test(app) && /onMetric: \(\) => \{ trackFeature\("xt_metric"\); \},/.test(app));
ok("③ 失敗句 xt.updFail = 「沒測成功」;§3.6 新字都在", /perfFailLine\(side, st, "xt\.updFail"\)/.test(perf) && zh["xt.updFail"] === "沒測成功"
  && zh["xt.btnRun"] === "開始測試" && zh["xt.btnRerun"] === "重新測試" && zh["xt.btnBusy"] === "測試中" && zh["xt.btnTip"] === "用最新資料重跑回測，績效會一起更新。"
  && zh["xt.verdictStale"] === "績效更新過，重新測試後才會更新。" && zh["xt.busyRefresh"] === "績效正在更新，跑完再按一次。" && zh["xt.busyTurn"] === "agent 正在回覆，可能還在改策略，回覆完再測。"
  && !("xt.fog" in zh) && !/xt\.fog"/.test(R("renderer/report-xt.js")));

console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
