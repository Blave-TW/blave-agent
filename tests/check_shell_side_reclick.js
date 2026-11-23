// 側欄已選中的那一項再點一次(Wei 09-28):沒被瀏覽器展開層蓋著 → 收掉那一頁回預設畫面(這台電腦 welcome / 雲端自動下單頁);
// 0.1.60(spec p3-0160 R5-11):策略庫、策略組合、自動下單三個導覽項改成冪等——詳情先回列表、已在列表什麼都不做(leave 傳 null),不再回歡迎頁;策略列與報告照舊;
// 蓋著 → 只收展開層、露出那一頁;框開著 / 組字中(envCanSwitch 為假)什麼都不動。
//   ① trade.js sideReclick 本體照上面三條走
//   ② 四個側欄入口(自動下單、策略庫、這台電腦的策略列、雲端策略列)與左下選單「報告」(0.1.57,rptMenuGo)的 click handler 從原文切出來跑:沒選中 → 照舊開;選中 → 經 sideReclick
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
  const runNull = (back) => { const log = [], ctx = { log, BR: {}, envCanSwitch: () => true, brCollapse: () => log.push("collapse"), envShowMain: () => log.push("show"), back: back ? () => log.push("back") : null };
    vm.runInNewContext(cutFn(trSrc, "sideReclick") + "\nsideReclick(null, back);", ctx); return log.join(); };
  ok("① leave 是 null(導覽項,R5-11):已在列表什麼都不做、不回歡迎頁;在詳情照舊先回列表", runNull(false) === "" && runNull(true) === "back", [runNull(false), runNull(true)]);
  ok("① 沒蓋著:先 leave 再 envShowMain(落到這一邊的預設畫面)", run({}) === "leave,show", run({}));
  ok("① 展開層蓋著(BR.exp + #bw 沒藏):只收展開層(算用戶收回),那一頁不收", run({ exp: { mode: "wall" }, bw: { hidden: false } }) === "collapse:true", run({ exp: { mode: "wall" }, bw: { hidden: false } }));
  ok("① BR.exp 殘著但 #bw 藏著 / 還沒建:不算蓋著,照 leave", run({ exp: { mode: "one" }, bw: { hidden: true } }) === "leave,show" && run({ exp: { mode: "one" } }) === "leave,show");
  ok("① 框開著 / 組字中(envCanSwitch 為假):什麼都不動,展開層蓋著也不收", run({ can: false }) === "" && run({ can: false, exp: { mode: "one" }, bw: { hidden: false } }) === "");
}

// ── ② 五個入口 ──
// sideReclick 的替身:記一筆再照真的 leave 跑(①已經驗過它本身)
const entry = (src, anchor, env) => {
  const log = [], ctx = Object.assign({ log, sideReclick: (leave, back) => { log.push("reclick"); if (back) back(); else if (leave) leave(); else log.push("stay"); } }, env(log));
  vm.runInNewContext("(" + cutHandler(src, anchor) + ")()", ctx);
  return log.join();
};
{
  const env = (open, detail) => (log) => ({ libBag: () => ({ open, detail }), libOpen: () => log.push("open"), libLeave: (e) => log.push("leave:" + e), libBack: () => log.push("back") });
  const r = [entry(libSrc, 'g("lib-nav")', env(false)), entry(libSrc, 'g("lib-nav")', env(true)), entry(libSrc, 'g("lib-nav")', env(true, true))];
  ok("② 策略庫:沒開 → libOpen;開著在列表 → 不動(R5-11);在詳情 → 回列表", r.join("|") === "open|reclick,stay|reclick,back", r);
}
{
  const env = (cur, current) => (log) => ({ ENV: { cur }, $: () => ({ hasAttribute: (a) => a === "aria-current" && current }), trOpen: () => log.push("open"), trLeave: (e) => log.push("leave:" + e) });
  const r = [entry(trSrc, '$("tr-nav")', env("local", false)), entry(trSrc, '$("tr-nav")', env("local", true)), entry(trSrc, '$("tr-nav")', env("cloud", true)), entry(trSrc, '$("tr-nav")', env("cloud", false))];
  ok("② 自動下單:沒選中 → trOpen;選中 → 不動(R5-11:不再回歡迎頁,只收展開層)",
    r.join("|") === "open|reclick,stay|reclick,stay|open", r);
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

// 報告的入口 0.1.57 搬進左下選單(spec first-strategy-sidebar §A2):reports.js rptMenuGo 先判擋不擋、再判開沒開,命中就停
const menuGo = async (o) => {
  const log = [], bag = { open: !!o.open, reading: o.reading || null };
  const ctx = { log, envGated: () => o.gate || null, hoPendingId: () => o.pid || null, envSwitchGuarded: (e) => { log.push("switch:" + e); return o.canSwitch !== false; },
    rptBag: () => bag, rptOpen: async () => { log.push("open"); return o.opened !== false; }, rptLeave: (e) => log.push("leave:" + e), rptBack: () => log.push("back"),
    sideReclick: (leave, back) => { log.push("reclick"); if (back) back(); else leave(); }, trackFeature: (n) => log.push("tm:" + n) };
  await vm.runInNewContext("(async () => { async " + cutFn(rptSrc, "rptMenuGo") + "\n await rptMenuGo(); })()", ctx);
  return log.join();
};
const MENU_CASES = [
  ["「準備好了」那一態:什麼都不做、不切視角", { gate: "ready", pid: "s1", open: true }, ""],
  // 稽核 release-0157 M1:主機還沒好(沒主機／啟動中／沒登入)時 hoAsk 已經記下等著送的那支,切視角會清掉它
  ["其餘擋著、有一支等著送上雲端:什麼都不做、不切視角(pending 留著)", { gate: "gate", pid: "s1", open: true }, ""],
  ["其餘擋著、切得過去:切回這台電腦再開,雲端那袋標成開著也一樣先切", { gate: "gate", open: true }, "switch:local,open,tm:side_menu_rpt"],
  ["其餘擋著、切不了(框開著／組字中):什麼都不變、不開、不記", { gate: "gate", canSwitch: false }, "switch:local"],
  ["沒擋、報告頁沒開:rptOpen,真的開了才記 side_menu_rpt", { open: false }, "open,tm:side_menu_rpt"],
  ["沒擋、rptOpen 途中被切走(回 false):不記", { open: false, opened: false }, "open"],
  ["沒擋、閱讀層:先回清單", { open: true, reading: "r1" }, "reclick,back"],
  ["沒擋、清單:再按回首頁(rptLeave),不記", { open: true }, "reclick,leave:undefined"],
];
(async () => {
  for (const [name, o, want] of MENU_CASES) { const got = await menuGo(o); ok("② 選單「報告」:" + name, got === want, got); }
  ok("② 選單「報告」的 gate 跟 envPaint 同一支 envGated(trade.js),「準備好了」分得出來", /const gk = envGated\(\), ready = gk === "ready", gate = !!gk;/.test(cutFn(trSrc, "envPaint"))
    && /if \(kind === "running" && typeof hoPendingId === "function" && hoPendingId\(\)\) return "ready";/.test(cutFn(trSrc, "envGated")) && /return kind !== "running" && kind !== "stopped" \? "gate" : null;/.test(cutFn(trSrc, "envGated")));
  const eg = (cur, kind, pid) => vm.runInNewContext(cutFn(trSrc, "envGated") + "\nenvGated();", { ENV: { cur }, TR_BAGS: { cloud: { st: {} } }, envCloudKind: () => kind, hoPendingId: () => pid });
  const r = [eg("local", "none", null), eg("cloud", "running", "s1"), eg("cloud", "running", null), eg("cloud", "stopped", null), eg("cloud", "none", null), eg("cloud", "loading", "s1")];
  ok("② envGated:這台電腦 null;雲端 running 有等著送的 ready;running／stopped null;其餘 gate", r.join() === ",ready,,,gate,gate", r);
  // M1:啟動中＋等著送的那支(envGated 回 gate,不是 ready)→ rptMenuGo 不走 envSwitch,HO.pending 留著。用真的 envSwitchGuarded／envSwitch 開頭那幾行
  { const HO = { pending: { id: "s1" } }, log = [];
    const ctx = { log, HO, ENV: { cur: "cloud" }, TR_BAGS: { cloud: { st: {} } }, envCloudKind: () => "loading", hoPendingId: () => (HO.pending ? HO.pending.id : null),
      envSwitchGuarded: (e) => { log.push("switch:" + e); HO.pending = null; return true; }, rptBag: () => ({ open: false }), rptOpen: async () => { log.push("open"); return true; },
      rptLeave: () => {}, rptBack: () => {}, sideReclick: () => {}, trackFeature: (n) => log.push("tm:" + n) };
    await vm.runInNewContext("(async () => { " + cutFn(trSrc, "envGated") + "\n async " + cutFn(rptSrc, "rptMenuGo") + "\n await rptMenuGo(); })()", ctx);
    ok("② M1 雲端啟動中、有一支等著送上雲端:按選單「報告」不切視角、不開、不記,HO.pending 還在", log.length === 0 && !!HO.pending && HO.pending.id === "s1", [log, HO.pending]);
    ok("② M1 rptMenuGo 先判 hoPendingId 再 envSwitchGuarded", /if \(gate && typeof hoPendingId === "function" && hoPendingId\(\)\) return;\n\s*if \(gate\) \{ if \(!envSwitchGuarded\("local"\)\) return; \}/.test(cutFn(rptSrc, "rptMenuGo"))); }
  if (red) { console.log(`\n${red} FAIL`); process.exit(1); }
  console.log("\nALL PASS");
})();
