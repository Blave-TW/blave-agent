// 報告頁「成交測試」分頁(shell/renderer/report-xt.js;spec .claude/output/specs/lag-test-tab-2026-10-26.md)。
//   ① 純函式(node vm 載入):挑數字的門檻、契約清洗、y 軸範圍、歸零成本位置——測資同 web tests/check_exec_test_tab.js
//   ② renderXt 用最小假 DOM 跑四態:有結果(結論卡＋兩段)、交易太少(只有卡)、舊回測(霧＋更新績效那一格)、
//      時光機(霧、不給鈕)、雲端主機落後(先更新);禁用的判讀標籤／評語字不出現在程式與兩語譯文
//   ③ 接線:分頁位置(樣本外驗證 → 成交測試 → 程式碼)、每一份分頁清單都有 xt、時光機只在重跑中停用、霧上的鈕走 perf.js(stats_refresh)
// 跑法:node tests/check_shell_xt.js
const path = require("path"), fs = require("fs"), vm = require("vm");
const SHELL = path.join(__dirname, "..", "shell"), R = (f) => fs.readFileSync(path.join(SHELL, f), "utf8");
let red = 0; const ok = (n, c, why) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || why === undefined ? "" : "\n      " + JSON.stringify(why))); if (!c) red++; };

// ── 最小假 DOM:renderXt 只用到 createElement / 文字節點 / fragment / dataset / querySelector(依 data 屬性找鈕) ──
class Node {
  constructor(tag) { this.tag = tag; this.kids = []; this.parentNode = null; this.attrs = {}; this.dataset = {}; this.style = {}; this.on = {}; this._t = ""; this.className = ""; this.hidden = false; this.disabled = false; this.type = ""; this.id = ""; }
  appendChild(c) { if (c instanceof Frag) { c.kids.slice().forEach((k) => this.appendChild(k)); c.kids = []; return c; } c.parentNode = this; this.kids.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(typeof c === "string" ? new Text(c) : c)); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { this.on[t] = f; }
  get textContent() { return this._t + this.kids.map((k) => k.textContent).join(""); }
  set textContent(v) { this._t = String(v); this.kids = []; }
  all() { return [this].concat(...this.kids.map((k) => (k.all ? k.all() : []))); }
  has(cls) { return (" " + this.className + " ").includes(" " + cls + " "); }
  querySelector(sel) { const m = /data-xt-sec="(\w+)"\]\[data-xt-key="(\w+)"/.exec(sel); return m ? this.all().find((n) => n.dataset.xtSec === m[1] && n.dataset.xtKey === m[2]) || null : null; }
  focus() { FOCUS.at = this; }
}
class Text { constructor(s) { this.s = s; } get textContent() { return this.s; } }
class Frag extends Node {}
const FOCUS = { at: null };
const document = { createElement: (t) => new Node(t), createDocumentFragment: () => new Frag("#frag"), createTextNode: (s) => new Text(s) };
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
  const opts = Object.assign({ t, buildMeta: (o) => { metaSeen.push(o); const n = new Node("div"); n.className = "bt-meta"; return n; }, rerun: () => { const n = new Node("div"); n.className = "SLOT"; slots.push(n); return n; } }, extra || {});
  window.BlaveReport.renderXt(box, { stats, name: "s1", market: "crypto" }, opts);
  const nodes = box.all();
  return { box, nodes, text: box.textContent, slots, cls: (c) => nodes.filter((n) => n.has && n.has(c)) };
};
const full = run({ ...STATS, exec_test: A });
ok("② 有結果:meta → 結論卡(判讀句兩句、晚一根掉 24%、+0.02%)→ 晚幾根成交 → 成本高一點;沒有霧也沒有更新績效",
  full.cls("rob-verdict").length === 1 && full.cls("rob-verdict")[0].textContent === "晚一根 Sharpe 掉 24%。每邊成本多 0.02%，Sharpe 從 1.62 掉到 1.06。"
  && full.cls("xt-sec").length === 2 && full.text.includes("晚幾根成交") && full.text.includes("成本高一點") && full.cls("xt-fog").length === 0 && full.slots.length === 0,
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
const few = run({ ...STATS, exec_test: mk([1, 1, 1, 1, 1, 1], flat7, { position_changes: 7 }) });
ok("② 交易太少:只有結論卡那一句,兩段不畫", few.cls("rob-verdict")[0].textContent === "交易太少（回測期間換倉 7 次），延遲和成本都測不出東西。" && few.cls("xt-sec").length === 0);
const fog = run({ ...STATS });
ok("② 舊回測(沒有 exec_test):霧＋霧卡句＋更新績效那一格(perf.js 給)", fog.cls("xt-fog").length === 1 && fog.text.includes("看晚幾根、成本高一點還撐不撐得住。") && fog.slots.length === 1 && fog.cls("SLOT").length === 1);
const nos = run({ ...STATS }, { rerun: () => null });
ok("② 不能更新績效(perfShown 假):只有霧與句子", nos.cls("xt-fog").length === 1 && nos.cls("fog-card")[0].kids.length === 1);
const old = run(null, { old: true });
ok("② 時光機看舊版本:霧、「舊版本沒存這一頁的數字。」、不給鈕(rerun 不被叫)", old.cls("xt-fog").length === 1 && old.text.includes("舊版本沒存這一頁的數字。") && old.slots.length === 0 && old.nodes.every((n) => n.tag !== "button"));
const beh = run({ ...STATS }, { behind: true, onUpdate: () => { beh.updated = true; } });
const go = beh.nodes.find((n) => n.tag === "button");
ok("② 雲端主機落後:先更新那句＋更新鈕(onUpdate),不給更新績效", beh.text.includes("先更新主機程式，才能跑成交測試。") && beh.slots.length === 0 && !!go && (go.on.click(), beh.updated === true));

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
ok("③ 雲端落後只認 config_supports_exec_test === false(null = api 還沒回這欄,照給更新績效);cloud.js 留這欄、進 summaryKey",
  /behind: cloud && rpWfCloud\(\)\.config_supports_exec_test === false/.test(app) && /config_supports_exec_test: typeof b\.config_supports_exec_test === "boolean" \? b\.config_supports_exec_test : null,/.test(cloud)
  && /s\.config_supports_wf, s\.config_supports_exec_test,/.test(cloud));
ok("③ 時光機:看舊版本 xt 點得開、畫霧不給鈕;重跑中跟其他三個一起停用",
  /const cur = tab === "code" \? "code" : tab === "xt" && S\.open !== null \? "xt" : "bt";/.test(ver) && /\|\| \(b\.dataset\.tab === "xt" && S\.open === null\);/.test(ver)
  && /renderXt\(\$\("rp-xt"\), null, \{ t, old: true \}\)/.test(ver));
ok("③ 霧上的鈕 = 更新績效同一條路(perfClick → stats_refresh、ack 才記 perf_update_xt),不開確認框、不送對話;回合中一起 aria-disabled",
  /btn\.addEventListener\("click", \(\) => perfClick\(B, btn\)\);/.test(perf) && /function perfXtSlot\(B\)/.test(perf) && !/confirmBox|submitMessage/.test(perf)
  && /\[\$\("perf-btn"\)\]\.concat\(xt \? \[\.\.\.xt\.querySelectorAll\("\[data-perf-btn\]"\)\] : \[\]\)/.test(perf) && /tradeSend\("stats_refresh", \{ names: \[name\] \}\)/.test(perf) && /perfXtSlot\(B\) : null/.test(app) && /onMetric: \(\) => \{ trackFeature\("xt_metric"\); \},/.test(app));
ok("③ 霧卡失敗句用 xt.updFail(霧上沒有數字,不講「數字是舊的」)", /perfFailLine\(side, st, "xt\.updFail"\)/.test(perf) && zh["xt.updFail"] === "沒更新成功");

console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
