// 0.1.29 e2e 設計稽核(.claude/output/designer/v029-e2e-2026-10-22.md)修的五條。不起 Electron。
//   必修 2  雲端側欄列停上去時狀態字讓位(trade.css),字留在讀屏名稱裡
//   建議 1  中欄窄到 520 那一階,「暫停下單」不跟兩顆框線鈕均分
//   建議 3  旗標面板從旗標鈕下方往右長(sfPopPlace);沒旗標不出「移除旗標」
//   建議 4  優化分頁只有一顆實心鈕(mgPrimary)
//   建議 5  選擇策略框沒有可勾的策略時只留「關閉」
// 排版實寬另用 headless Chromium 量過(見 commit 說明);這支鎖邏輯與規則本身。
// 跑法:node tests/check_shell_v029_e2efix.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 400))); if (!c) red++; };
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
const block = (css, head) => { const i = css.indexOf(head); if (i < 0) return ""; let d = 0; for (let k = css.indexOf("{", i); k < css.length; k++) { if (css[k] === "{") d++; else if (css[k] === "}" && --d === 0) return css.slice(i, k + 1); } return ""; };
const trCss = read("trade.css"), appCss = read("app.css"), sf = read("stratflags.js"), po = read("portfolio.js"), tr = read("trade.js");

// ── 必修 2 ──
{ const m = trCss.match(/^\.strat-wrap:is\(:hover, :has\(:focus-visible\), \.flag-open\) \.strat-row \.stx \{([^}]*)\}/m);
  ok("必修 2:hover／聚焦／面板開著時 .stx 收成 1px(版面讓位),不是 display:none(讀屏名稱照念「已暫停」)",
    !!m && /position: absolute;/.test(m[1]) && /width: 1px;/.test(m[1]) && /clip-path: inset\(50%\);/.test(m[1]) && !/display:\s*none|visibility:\s*hidden/.test(m[1]), m && m[1]);
  ok("必修 2:本機側欄沒有狀態字(stratRefresh 不畫 .stx),同一個問題不存在", !/"stx"/.test(cutFn(read("app.js"), "stratRefresh"))); }

// ── 建議 1 ──
{ const b = block(trCss, "@container (max-width: 520px)");
  ok("建議 1:520 那一階兩顆以上鈕各佔一半,但 .tr-go-stop 是 flex: none(權重高過 .act > button 的 flex: 1)",
    /\.main-head:has\(\.act button \+ button\) \.act > button \{ flex: 1; \}/.test(b) && /\.main-head:has\(\.act button \+ button\) \.act > \.tr-go-stop \{ flex: none; \}/.test(b)); }

// ── 建議 3 ──
{ const C = {}; vm.runInNewContext(cutFn(sf, "sfPopPlace") + "\nthis.f = sfPopPlace;", C);
  const btn = { left: 172, right: 196, top: 400, bottom: 424 };
  const a = C.f(btn, 120, 110, 1280, 800);
  ok("建議 3:面板左緣 = 旗標鈕左緣、在鈕下 8(往右長,不再蓋住下一列的名字)", a.left === 172 && a.top === 432 && a.up === false, JSON.stringify(a));
  const b = C.f({ left: 1250, right: 1274, top: 400, bottom: 424 }, 120, 110, 1280, 800);
  ok("建議 3:右邊放不下 → 夾回視窗內(右緣留 8)", b.left === 1280 - 8 - 120, JSON.stringify(b));
  const c = C.f({ left: 172, right: 196, top: 740, bottom: 764 }, 120, 110, 1280, 800);
  ok("建議 3:下方放不下 → 翻到鈕上方", c.up === true && c.top === 740 - 8 - 110, JSON.stringify(c));
  const open = cutFn(sf, "sfPopOpen");
  ok("建議 3:sfPopOpen 用 sfPopPlace 定位,而且在量尺寸之前就照目前旗標藏「移除旗標」與它上面那條線",
    /sfPopPlace\(anchor\.getBoundingClientRect\(\)/.test(open) && open.indexOf('querySelectorAll("[data-rm]").forEach((n) => { n.hidden = !cur; })') > 0
    && open.indexOf("[data-rm]") < open.indexOf("sfPop.offsetWidth"));
  ok("建議 3:data-rm 只掛在第一條線與「移除旗標」", /const d1 = sep\(\); d1\.dataset\.rm = "1"; rm\.dataset\.rm = "1";/.test(sf) && (sf.match(/dataset\.rm =/g) || []).length === 2);
  ok("建議 3:開閉動效的原點跟著改到左側(面板從鈕往右長)", /\.flag-pop \{[^}]*transform-origin: top left;/.test(appCss) && /\.flag-pop\.up \{ transform: translateY\(2px\); transform-origin: bottom left; \}/.test(appCss)); }

// ── 建議 4 ──
{ const C = {}; vm.runInNewContext(cutFn(po, "mgPrimary") + "\nthis.f = mgPrimary;", C);
  const btn = (cls, disabled) => { const s = new Set(cls.split(" ")); return { disabled, classList: { toggle: (c, on) => (on ? s.add(c) : s.delete(c)), has: (c) => s.has(c) } }; };
  const box = (opt, ap) => ({ querySelector: (q) => (q === ".tb-run" ? opt : q === "#mg-apply" ? ap : null) });
  const fills = (...bs) => bs.filter((b) => b && b.classList.has("btn-fill")).length;
  let opt = btn("btn-fill tb-run", false), ap = btn("btn-fill", false); C.f(box(opt, ap));
  ok("建議 4:有新權重可套用 → 套用金額實心、跑優化框線", ap.classList.has("btn-fill") && !ap.classList.has("btn-out") && opt.classList.has("btn-out") && fills(opt, ap) === 1);
  opt = btn("btn-fill tb-run", false); ap = btn("btn-fill", true); C.f(box(opt, ap));
  ok("建議 4:套用停用(沒有新權重／缺報價…) → 跑優化實心、套用框線", opt.classList.has("btn-fill") && ap.classList.has("btn-out") && fills(opt, ap) === 1);
  opt = btn("btn-out tb-run", false); C.f(box(opt, null));
  ok("建議 4:還沒有建議(沒有套用鈕) → 跑優化實心", opt.classList.has("btn-fill") && !opt.classList.has("btn-out"));
  ap = btn("btn-fill", false); C.f(box(null, ap));
  ok("建議 4:工具列不在也不炸,套用照可不可按定", ap.classList.has("btn-fill"));
  const paint = cutFn(po, "mgPaint");
  ok("建議 4:mgPaint 在兩顆鈕都畫完之後才判(套用的停用條件在 mgSuggestTable 裡算)", paint.indexOf("mgPrimary(box);") > paint.indexOf("mgSuggest()")); }

// ── 建議 5 ──
{ const run = (rows) => {
    const el = (id) => ({ id, hidden: false, dataset: {}, textContent: "", kids: [], classList: { add() {}, remove() {}, toggle() {} }, focus() { C.focused = id; },
      appendChild(x) { this.kids.push(x); return x; }, querySelector: () => null, querySelectorAll: () => [] });
    const els = { "ps-scrim": Object.assign(el("ps-scrim"), { hidden: true }), "ps-modal": Object.assign(el("ps-modal"), { querySelector: () => el("head") }), "ps-env": el("ps-env"), "ps-list": el("ps-list"), "ps-cancel": el("ps-cancel"), "ps-ok": el("ps-ok"), "view-ws": el("view-ws") };
    const S = { env: "cloud", list: [], open: true, view: "po", st: null, just: null };
    var C = { TR: S, TR_BAGS: { cloud: S }, ENV: { cur: "cloud" }, $: (id) => els[id], t: (k) => "«" + k + "»", requestAnimationFrame: (f) => f(), trackFeature() {}, trPickOff: () => false,
      trNames: () => [], trReport: () => ({}), trVenueId: () => null, trPaperTwOk: () => true, trTwBroker: () => false, PAPER: "paper", trPickPrefs: () => ({ order: [], flags: {} }),
      trPickRows: () => rows, envDotsUp: () => false, envRunDot: () => false, mgMembers: () => [], psRow: (r) => ({ row: r.name }), psLoading: false, psOpener: null, psMode: "",
      trEl: (tag, cls, txt) => ({ tag, cls, txt, kids: [], dataset: {}, setAttribute() {}, appendChild(x) { this.kids.push(x); return x; } }) };
    vm.createContext(C);
    vm.runInContext("var psLoading = false, psOpener = null, psMode = '';\nvar psOpen = async " + cutFn(tr, "psOpen"), C);
    return C.psOpen(null).then(() => ({ els, focused: C.focused }));
  };
  Promise.resolve().then(async () => {
    const e = await run([]);
    ok("建議 5:沒有可勾的策略 → 「確定」藏起來、取消鈕改寫「關閉」(既有 set.close)、焦點在它身上",
      e.els["ps-ok"].hidden === true && e.els["ps-cancel"].textContent === "«set.close»" && e.els["ps-cancel"].dataset.i18n === "set.close" && e.focused === "ps-cancel" && !e.els["ps-scrim"].hidden, JSON.stringify({ ok: e.els["ps-ok"].hidden, c: e.els["ps-cancel"].textContent, f: e.focused }));
    const f = await run([{ name: "a", checked: false }]);
    ok("建議 5:有策略 → 「取消／確定」都在(換語言時照 data-i18n 重套的也是「取消」)",
      f.els["ps-ok"].hidden === false && f.els["ps-cancel"].textContent === "«del.cancel»" && f.els["ps-cancel"].dataset.i18n === "del.cancel");
  }).catch((e) => ok("建議 5:psOpen 跑得起來", false, e && e.stack)).then(() => {
    console.log(red ? red + " FAILED" : "ALL PASS"); process.exit(red ? 1 : 0);
  });
}
