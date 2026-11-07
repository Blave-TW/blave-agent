// 側欄策略列的焦點框(設計 sidebar-focus-ring-2026-11-07):
//   ① 框畫在列內(outline-offset -2px),不被 .strat-list 的 overflow-x: hidden 裁掉
//   ② 選取換列時,焦點停在同一份清單的舊列上就跟到選中那列(app.js stratFocusFollow);焦點不在清單列上不搶
//   ③ stratSelect／rpCloudSelect 都接上;雲端那支要在重建(trPaint)前搬,重建才會照新列接回
// 不起 Electron:函式從原文切出來,用最小的假 DOM 跑。只用滑鼠時不冒框靠的是 focus() 本身(舊列沒框新列也沒有),
// 那一段 Chromium 行為在開發版用除錯埠實測過(報告 0149-capital-p2-sidebar-focus),這裡不重做。
const fs = require("fs"), path = require("path"), vm = require("vm");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const R = path.join(__dirname, "..", "shell", "renderer");
const app = fs.readFileSync(path.join(R, "app.js"), "utf8"), css = fs.readFileSync(path.join(R, "app.css"), "utf8");
const cutFn = (src, name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("no " + name); };

// ① 裁切
const rule = /^([^{\n]*\.strat-row:focus-visible[^{\n]*)\{\s*outline-offset:\s*-2px;\s*\}/m.exec(css);
t("① .strat-row:focus-visible 的 outline-offset 是 -2px(跟對話列同一條)", !!rule && /\.cs-item:focus-visible/.test(rule[1]));

// ② 假 DOM:box 裡有幾個 .strat-wrap,每個一顆 .strat-row
function world(names, hiddenNames = []) {
  const doc = { activeElement: null, getElementById: (id) => (id === "list" ? box : null) };
  const mk = (cls, extra = {}) => ({ classList: { contains: (c) => cls.split(" ").includes(c) }, dataset: {}, focusCalls: 0, ...extra });
  const box = mk("strat-list"), wraps = [];
  for (const n of names) {
    const row = mk("strat-row"); row.dataset.name = n;
    row.focus = () => { row.focusCalls++; doc.activeElement = row; };
    const w = mk("strat-wrap"); w.dataset.name = n; w.hidden = hiddenNames.includes(n); w.querySelector = (s) => (s === ".strat-row" ? row : null); w.row = row;
    wraps.push(w);
  }
  box.querySelectorAll = (s) => (s === ":scope > .strat-wrap" ? wraps : []);
  const inside = new Set(wraps.map((w) => w.row));
  box.contains = (el) => inside.has(el);
  const other = mk("ta"); other.focus = () => { doc.activeElement = other; };
  return { doc, box, row: (n) => wraps.find((w) => w.dataset.name === n).row, other };
}
const ctx = { document: null }; vm.createContext(ctx);
vm.runInContext(cutFn(app, "stratFocusFollow"), ctx);
const run = (W, name) => { ctx.document = W.doc; ctx.stratFocusFollow("list", name); return W.doc.activeElement; };
{ const W = world(["a", "b", "c"]); W.doc.activeElement = W.row("a");
  t("② 焦點在舊列 a、選取換到 c → 焦點移到 c", run(W, "c") === W.row("c")); }
{ const W = world(["a", "b"]); W.doc.activeElement = W.other;
  t("② 焦點在輸入框 → 不搶", run(W, "b") === W.other && W.row("b").focusCalls === 0); }
{ const W = world(["a", "b"]); W.doc.activeElement = W.row("a");
  t("② 選取的就是焦點那列 → 不重 focus", run(W, "a") === W.row("a") && W.row("a").focusCalls === 0); }
{ const W = world(["a", "b"]); W.doc.activeElement = W.row("a");
  t("② 取消選取(null)→ 焦點不動", run(W, null) === W.row("a")); }
{ const W = world(["a", "b"]), Y = world(["b"]); W.doc.activeElement = W.row("a");
  ctx.document = { ...W.doc, getElementById: () => Y.box }; ctx.stratFocusFollow("list", "b");
  t("② 焦點在另一份清單(本機 vs 雲端)→ 不動", W.doc.activeElement === W.row("a") && Y.row("b").focusCalls === 0); }
{ const W = world(["a", "b"], ["b"]); W.doc.activeElement = W.row("a");
  t("② 選中那列在收合的資料夾裡(hidden)→ 不 focus 看不見的列", run(W, "b") === W.row("a")); }

// ③ 接線
const sel = cutFn(app, "stratSelect"), cloud = cutFn(app, "rpCloudSelect");
t("③ stratSelect 換完 aria-current、選取真的換了才叫 stratFocusFollow(\"strat-list\", name)",
  /const prev = RP\.name;\n\s*RP\.name = name;/.test(sel)
  && /removeAttribute\("aria-current"\);\n\s*\}\);\n\s*if \(name !== prev && typeof stratFocusFollow === "function"\) stratFocusFollow\("strat-list", name\);/.test(sel));
const iF = cloud.indexOf('stratFocusFollow("strat-list-cloud", name)'), iP = cloud.indexOf("trPaint()");
t("③ rpCloudSelect 在 RPC.name 換掉之後、trPaint 重建之前搬焦點", iF > cloud.indexOf("RPC.name = name") && iF > 0 && iF < iP);

t("③ rpCloudSelect 也是選取真的換了才搬(force 同名不搬)", /const prev = RPC\.name;\n\s*RPC\.name = name;/.test(cloud) && /if \(name !== prev && typeof stratFocusFollow === "function"\) stratFocusFollow\("strat-list-cloud"/.test(cloud));

// ④ 雲端回合結束(app.js onTurnEnd 的 rpCloudSelect(RPC.name, true)):選取沒換,焦點在哪就留在哪。真的 rpCloudSelect 切出來跑,
//    焦點決定之後的畫面步驟用空殼接住(丟例外也只是 rejected promise,焦點早就定了)
async function cloudSelect(focus, pick) {
  const W = world(["x", "y"]);
  W.doc.activeElement = focus === "input" ? W.other : W.row(focus);
  W.doc.getElementById = (id) => (id === "strat-list-cloud" ? W.box : null);
  const c = { document: W.doc, RPC: { name: "y", drawn: {} }, RPC_SEEN: { name: "y" }, rpcSeq: 0, rpcOwed: false, ENV: { sig: {} },
    TR_BAGS: { cloud: { st: {} } }, RPC_CACHE: new Map(), sgReveal: () => {}, rpCloudSig: () => null, envCloudList: () => [],
    trPaint: () => {}, rpPending: () => ({}), rpCloudPaint: () => {} };
  vm.createContext(c);
  vm.runInContext(cutFn(app, "stratFocusFollow") + "\nasync " + cutFn(app, "rpCloudSelect"), c);
  await c.rpCloudSelect(pick, pick === "y").catch(() => {});
  return { W, ae: W.doc.activeElement };
}
(async () => {
  { const { W, ae } = await cloudSelect("input", "y");
    t("④ 焦點在輸入框:雲端回合結束重選同一支(force)→ 焦點留在輸入框", ae === W.other); }
  { const { W, ae } = await cloudSelect("x", "y");
    t("④ 鍵盤停在沒選中的 x:回合結束重選 y(force 同名)→ 焦點留在 x,不跳到 y", ae === W.row("x") && W.row("y").focusCalls === 0); }
  { const { W, ae } = await cloudSelect("y", "x");
    t("④ 對照:焦點在 y、選取真的換到 x → 跟到 x", ae === W.row("x")); }
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
