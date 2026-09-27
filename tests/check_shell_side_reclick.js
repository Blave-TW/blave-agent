// 側欄已選中的那一項再點一次(Wei 09-28):沒被瀏覽器展開層蓋著 → 收掉那一頁回預設畫面(這台電腦 welcome / 雲端自動下單頁);
// 蓋著 → 只收展開層、露出那一頁;框開著 / 組字中(envCanSwitch 為假)什麼都不動。
//   ① trade.js sideReclick 本體照上面三條走
//   ② 五個入口(自動下單、策略庫、報告、這台電腦的策略列、雲端策略列)的 click handler 從原文切出來跑:沒選中 → 照舊開;選中 → 經 sideReclick
// 跑法:node tests/check_shell_side_reclick.js(不開 Electron)
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const trSrc = read("trade.js"), appSrc = read("app.js"), libSrc = read("library.js"), rptSrc = read("reports.js");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + JSON.stringify(d))); if (!c) red++; };
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
// anchor 之後那個 addEventListener("click", <這一段>) 的 handler 原文
const cutHandler = (s, anchor) => {
  const i = s.indexOf(anchor); if (i < 0) throw new Error("no " + anchor);
  const a = s.indexOf('addEventListener("click", ', i) + 'addEventListener("click", '.length;
  let d = 0; for (let k = a; k < s.length; k++) { const c = s[k]; if (c === "(" || c === "{") d++; else if (c === ")" || c === "}") { if (d === 0) return s.slice(a, k); d--; } }
  throw new Error("unbalanced " + anchor);
};

// ── ① sideReclick ──
{
  const run = ({ can = true, exp = null, bw = null }) => {
    const log = [], ctx = { log, BR: { exp, bw }, envCanSwitch: () => can, brCollapse: (u) => log.push("collapse:" + u), envShowMain: () => log.push("show") };
    vm.runInNewContext(cutFn(trSrc, "sideReclick") + "\nsideReclick(() => log.push('leave'));", ctx);
    return log.join();
  };
  ok("① 沒蓋著:先 leave 再 envShowMain(落到這一邊的預設畫面)", run({}) === "leave,show", run({}));
  ok("① 展開層蓋著(BR.exp + #bw 沒藏):只收展開層(算用戶收回),那一頁不收", run({ exp: { mode: "wall" }, bw: { hidden: false } }) === "collapse:true", run({ exp: { mode: "wall" }, bw: { hidden: false } }));
  ok("① BR.exp 殘著但 #bw 藏著 / 還沒建:不算蓋著,照 leave", run({ exp: { mode: "one" }, bw: { hidden: true } }) === "leave,show" && run({ exp: { mode: "one" } }) === "leave,show");
  ok("① 框開著 / 組字中(envCanSwitch 為假):什麼都不動,展開層蓋著也不收", run({ can: false }) === "" && run({ can: false, exp: { mode: "one" }, bw: { hidden: false } }) === "");
}

// ── ② 五個入口 ──
// sideReclick 的替身:記一筆再照真的 leave 跑(①已經驗過它本身)
const entry = (src, anchor, env) => {
  const log = [], ctx = Object.assign({ log, sideReclick: (leave) => { log.push("reclick"); leave(); } }, env(log));
  vm.runInNewContext("(" + cutHandler(src, anchor) + ")()", ctx);
  return log.join();
};
{
  const env = (open) => (log) => ({ rptBag: () => ({ open }), rptOpen: () => log.push("open"), rptLeave: (e) => log.push("leave:" + e) });
  ok("② 報告:沒開 → rptOpen;開著 → sideReclick(rptLeave)(舊的 if (!open) 擋掉那一下,展開層蓋著時沒反應)",
    entry(rptSrc, 'g("rpt-nav")', env(false)) === "open" && entry(rptSrc, 'g("rpt-nav")', env(true)) === "reclick,leave:undefined", [entry(rptSrc, 'g("rpt-nav")', env(false)), entry(rptSrc, 'g("rpt-nav")', env(true))]);
}
{
  const env = (open) => (log) => ({ libBag: () => ({ open }), libOpen: () => log.push("open"), libLeave: (e) => log.push("leave:" + e) });
  ok("② 策略庫:沒開 → libOpen;開著 → sideReclick(libLeave)",
    entry(libSrc, 'g("lib-nav")', env(false)) === "open" && entry(libSrc, 'g("lib-nav")', env(true)) === "reclick,leave:undefined", [entry(libSrc, 'g("lib-nav")', env(false)), entry(libSrc, 'g("lib-nav")', env(true))]);
}
{
  const env = (cur, current) => (log) => ({ ENV: { cur }, $: () => ({ hasAttribute: (a) => a === "aria-current" && current }), trOpen: () => log.push("open"), trLeave: () => log.push("leave") });
  const r = [entry(trSrc, '$("tr-nav")', env("local", false)), entry(trSrc, '$("tr-nav")', env("local", true)), entry(trSrc, '$("tr-nav")', env("cloud", true)), entry(trSrc, '$("tr-nav")', env("cloud", false))];
  ok("② 自動下單:沒選中 → trOpen;這台電腦選中 → sideReclick(trLeave);雲端選中(它就是雲端的預設頁)→ sideReclick 但 leave 仍是 trOpen,不去收這台電腦那一袋",
    r.join("|") === "open|reclick,leave|reclick,open|open", r);
}
{
  const env = (sel) => (log) => ({ x: { name: "a" }, RP: { name: sel }, stratSelect: (n) => log.push("select:" + n) });
  const r = [entry(appSrc, "再點一次選中的那支 = 取消選取", env("b")), entry(appSrc, "再點一次選中的那支 = 取消選取", env("a"))];
  ok("② 這台電腦的策略列:點別支 → 選它;點選中那支 → sideReclick(stratSelect(null))", r.join("|") === "select:a|reclick,select:null", r);
}
{
  const env = (sel, ae, rowAfter) => (log) => ({ x: { name: "a" }, RPC: { name: sel }, rpCloudSelect: (n) => log.push("select:" + n),
    document: { activeElement: ae, body: "BODY" }, cdelRowBtn: (n) => (rowAfter ? { focus: () => log.push("focus:" + n) } : null) });
  const r = [entry(trSrc, "再點一次選中的那支 = 收掉", env("b", "BODY", true)), entry(trSrc, "再點一次選中的那支 = 收掉", env("a", "BODY", true)),
    entry(trSrc, "再點一次選中的那支 = 收掉", env("a", "OTHER", true)), entry(trSrc, "再點一次選中的那支 = 收掉", env("a", null, false))];
  ok("② 雲端策略列:點別支 → 選它;點選中那支 → sideReclick(rpCloudSelect(null));清單重建後焦點掉到 BODY 就接回同名那一列,焦點在別處不搶",
    r.join("|") === "select:a,focus:a|reclick,select:null,focus:a|reclick,select:null|reclick,select:null", r);
}

if (red) { console.log(`\n${red} FAIL`); process.exit(1); }
console.log("\nALL PASS");
