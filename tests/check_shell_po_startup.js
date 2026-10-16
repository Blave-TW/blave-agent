// 開 app 立刻點側欄「策略組合」(0.1.25 Mac 實測:側欄看起來選中、中欄停在歡迎頁)。
// 從原文切出啟動後真的會走的那幾支(po-nav 的 click handler、poOpen、stratSelect、envShowMain、envNavMark、libShowMain、rptShowMain),
// 用啟動當下的初始狀態(index.html 的 hidden、trNewBag 的預設、RP 的預設)跑一次點擊,斷言中欄換成策略組合頁、歡迎頁收起、側欄標記與畫面一致。
// 跑法:node tests/check_shell_po_startup.js(不開 Electron)
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const trSrc = read("trade.js"), poSrc = read("portfolio.js"), appSrc = read("app.js"), libSrc = read("library.js"), rptSrc = read("reports.js"), html = read("index.html");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + JSON.stringify(d))); if (!c) red++; };
const cutFn = (s, name) => { const i = s.search(new RegExp("(async )?function " + name + "\\(")); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
const cutHandler = (s, anchor) => {
  const i = s.indexOf(anchor); if (i < 0) throw new Error("no " + anchor);
  const a = s.indexOf('addEventListener("click", ', i) + 'addEventListener("click", '.length;
  let d = 0; for (let k = a; k < s.length; k++) { const c = s[k]; if (c === "(" || c === "{") d++; else if (c === ")" || c === "}") { if (d === 0) return s.slice(a, k); d--; } }
  throw new Error("unbalanced " + anchor);
};
// 初始 hidden 照 index.html(不自己猜):中欄各視圖、側欄入口
const IDS = ["main-empty", "tr", "po", "rp", "lib", "rpt", "cv-empty", "po-nav", "tr-nav", "lib-nav", "rpt-nav", "strat-list", "view-ws"];
const initHidden = (id) => new RegExp('id="' + id + '"[^>]*\\shidden[\\s>]').test(html);
const mkEl = (id) => { const attrs = {}; return { id, hidden: initHidden(id), attrs, setAttribute: (k, v) => { attrs[k] = String(v); }, removeAttribute: (k) => { delete attrs[k]; }, hasAttribute: (k) => k in attrs, querySelectorAll: () => [], focus() {}, offsetParent: null }; };

async function boot() {
  const els = {}; IDS.forEach((id) => { els[id] = mkEl(id); });
  const ctx = { console, els, $: (id) => els[id] || (els[id] = mkEl(id)) };
  vm.createContext(ctx);
  vm.runInContext([
    cutFn(trSrc, "trNewBag"),
    "var TR = trNewBag('local'); var TR_BAGS = { local: TR, cloud: trNewBag('cloud') };",
    "var ENV = { cur: 'local', sig: {} }; var RP = { list: [], name: null, data: null, tab: 'bt', drawn: {} };",
    "var LIB = { bags: { local: { open: false }, cloud: { open: false } } }; var RPT = { bags: { local: { open: false }, cloud: { open: false } } };",
    "var libEnv = () => 'local', libBag = (e) => LIB.bags[(e || libEnv())], rptBag = (e) => RPT.bags[(e || libEnv())];",
    "function libIdeaPaint() {} function libChartDrop() {} function libPaint() {} function rptPaint() {} function trackFeature() {} function trPollSoon() {} function trPaint() {}",
    "function envCanSwitch() { return true; } var BR = { exp: null, bw: null };",
    cutFn(trSrc, "envShowMain"), cutFn(trSrc, "envNavMark"), cutFn(trSrc, "trLeave"), cutFn(trSrc, "sideReclick"), "function trPaintHead() {}",
    cutFn(libSrc, "libShowMain"), cutFn(libSrc, "libLeave"), cutFn(rptSrc, "rptShowMain"), cutFn(rptSrc, "rptLeave"),
    cutFn(appSrc, "stratSelect"), cutFn(poSrc, "poOpen"), cutFn(trSrc, "trOpen"),
    "var poNavClick = " + cutHandler(trSrc, '$("po-nav")') + ";",
    "var trNavClick = " + cutHandler(trSrc, '$("tr-nav")') + ";",
  ].join("\n"), ctx);
  return ctx;
}
const view = (ctx) => ["main-empty", "tr", "po", "rp", "lib", "rpt"].filter((id) => !ctx.els[id].hidden).join(",");
const marked = (ctx) => ["po-nav", "tr-nav", "lib-nav", "rpt-nav"].filter((id) => ctx.els[id].hasAttribute("aria-current")).join(",");
const flush = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  { const c = await boot();
    ok("初始狀態(index.html):中欄只有歡迎頁、側欄沒有選中", view(c) === "main-empty" && marked(c) === "", [view(c), marked(c)]);
    c.poNavClick(); await flush();
    ok("啟動後立刻點「策略組合」:中欄換成策略組合頁、歡迎頁收起,側欄只標策略組合", view(c) === "po" && marked(c) === "po-nav", [view(c), marked(c)]);
    ok("同一袋狀態也對上:這台電腦那一袋 open、view = po", c.TR.open === true && c.TR.view === "po"); }
  { const c = await boot();
    c.trNavClick(); await flush(); c.poNavClick(); await flush();
    ok("先點自動下單再點策略組合(實測的繞路):一樣落在策略組合頁", view(c) === "po" && marked(c) === "po-nav", [view(c), marked(c)]); }
  { const c = await boot();
    c.poNavClick(); await flush(); c.poNavClick(); await flush();
    ok("選中後再點一次:回歡迎頁,側欄標記一起拿掉(標記與畫面不會分家)", view(c) === "main-empty" && marked(c) === "", [view(c), marked(c)]); }
  console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
})();
