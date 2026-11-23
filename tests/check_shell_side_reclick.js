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
  // ── ③ 中欄頂列首頁鈕(spec home-button-0160;Wei 裁 A:已在歡迎頁外觀不變、只標 aria-current)──
  { const html = fs.readFileSync(path.join(R, "index.html"), "utf8"), css = fs.readFileSync(path.join(R, "trade.css"), "utf8");
    const S = (() => { const sb = {}; vm.runInNewContext(fs.readFileSync(path.join(R, "strings.js"), "utf8") + "\nthis.S = STRINGS;", sb); return sb.S; })();
    const home = async (o) => {
      const node = (hidden) => { const n = { hidden, attrs: {}, setAttribute: (k, v) => { n.attrs[k] = String(v); }, removeAttribute: (k) => { delete n.attrs[k]; } }; return n; };
      const dom = { "main-empty": node(!o.atHome), "cv-empty": node(!o.gated), "tr-home": node(false), "po-nav": node(false), "tr-nav": node(false), "lib-nav": node(false) };
      (o.marked || []).forEach((id) => dom[id].setAttribute("aria-current", "page"));
      const log = [], bags = { local: { env: "local" }, cloud: { env: "cloud" } }, ENV = { cur: o.env || "local" };
      const ctx = { log, ENV, TR: bags[ENV.cur], TR_BAGS: bags, $: (id) => dom[id], BR: o.br ? { exp: { mode: "one" }, bw: { hidden: false } } : {},
        envCanSwitch: () => o.can !== false, brCollapse: (u) => log.push("collapse:" + u), stratSelect: async (n) => log.push("select:" + n), rpCloudSelect: async (n) => log.push("cselect:" + n),
        libLeave: (e) => log.push("libLeave:" + e), rptLeave: (e) => log.push("rptLeave:" + e), trLeave: (e) => log.push("trLeave:" + e),
        envShowMain: () => { log.push("show"); dom["main-empty"].hidden = false; }, envSwitch: () => log.push("SWITCH"), trackFeature: (n) => log.push("tm:" + n) };
      await vm.runInNewContext("(async () => { " + cutFn(trSrc, "envAtHome") + "\n" + cutFn(trSrc, "envHomeSync") + "\n async " + cutFn(trSrc, "envGoHome") + "\n await envGoHome(); })()", ctx);
      return { log: log.join(), cur: ENV.cur, aria: dom["tr-home"].attrs["aria-current"] || null, navs: ["po-nav", "tr-nav", "lib-nav"].filter((id) => dom[id].attrs["aria-current"]) };
    };
    const a = await home({ marked: ["lib-nav"] });
    ok("③ 這台電腦、在策略庫(詳情)/報告/組合/自動下單:收掉策略選取、策略庫、報告、自動下單,落到歡迎頁;記 top_home;首頁鈕 aria-current=page、側欄三項都不亮;不換視角",
      a.log === "select:null,libLeave:local,rptLeave:local,trLeave:local,show,tm:top_home" && a.aria === "page" && a.navs.length === 0 && a.cur === "local", a);
    const c = await home({ env: "cloud", marked: ["tr-nav"] });
    ok("③ 雲端視角:收的是雲端那一袋(rpCloudSelect(null)…trLeave(cloud)),視角維持雲端、不呼叫 envSwitch", c.log === "cselect:null,libLeave:cloud,rptLeave:cloud,trLeave:cloud,show,tm:top_home" && c.cur === "cloud" && c.aria === "page", c);
    const h = await home({ atHome: true });
    ok("③ 已在歡迎頁:什麼都不做、不記埋點(Wei 裁 A:外觀不變,只標 aria-current)", h.log === "" && h.aria === null, h);
    const g = await home({ env: "cloud", gated: true });
    ok("③ 雲端被擋住(開通頁 #cv-empty 開著):點了沒反應、不記", g.log === "", g);
    const b = await home({ atHome: true, br: true });
    ok("③ 在歡迎頁但瀏覽器展開層蓋著:一下收掉展開層並落回歡迎頁,記 top_home", b.log === "collapse:true,select:null,libLeave:local,rptLeave:local,trLeave:local,show,tm:top_home", b);
    const x = await home({ can: false });
    ok("③ 框開著／組字中(envCanSwitch 為假):什麼都不動", x.log === "", x);
    { const node = (hidden) => ({ hidden, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } });
      const dom = { "main-empty": node(false), "cv-empty": node(true), "tr-home": node(false), "po-nav": node(false), "tr-nav": node(false), "lib-nav": node(false) };
      dom["lib-nav"].setAttribute("aria-current", "page"); dom["po-nav"].setAttribute("aria-current", "page");
      vm.runInNewContext(cutFn(trSrc, "envAtHome") + "\n" + cutFn(trSrc, "envHomeSync") + "\nenvHomeSync();", { ENV: { cur: "local" }, $: (id) => dom[id] });
      const on = dom["tr-home"].attrs["aria-current"], navs = ["po-nav", "tr-nav", "lib-nav"].filter((id) => dom[id].attrs["aria-current"]);
      dom["main-empty"].hidden = true; vm.runInNewContext(cutFn(trSrc, "envAtHome") + "\n" + cutFn(trSrc, "envHomeSync") + "\nenvHomeSync();", { ENV: { cur: "local" }, $: (id) => dom[id] });
      ok("③ 中欄是歡迎頁時側欄不得還亮著(sidebar-reclick §4):envHomeSync 清掉三個導覽項的 aria-current、首頁鈕標 page;離開歡迎頁拿掉 page",
        on === "page" && navs.length === 0 && !("aria-current" in dom["tr-home"].attrs), [on, navs]); }
    ok("③ 接線:#main-empty／#cv-empty 的 hidden 一變就 envHomeSync(不論哪條路翻 DOM);#tr-home click → envGoHome",
      /const mo = new MutationObserver\(\(\) => envHomeSync\(\)\); \["main-empty", "cv-empty"\]\.forEach\(\(id\) => mo\.observe\(\$\(id\), \{ attributes: true, attributeFilter: \["hidden"\] \}\)\);/.test(trSrc)
      && /\$\("tr-home"\)\.addEventListener\("click", \(\) => envGoHome\(\)\);/.test(trSrc));
    const tb = html.slice(html.indexOf('<div class="tb" id="tr-tb">'), html.indexOf('</div>', html.indexOf('id="envsw"')));
    ok("③ DOM:#tr-home 是 #tr-tb 第一個子元素、在切換器前;讀屏名稱 nav.home(data-i18n-aria)、沒有 title／tooltip;lucide house 兩段 path、aria-hidden",
      /^<div class="tb" id="tr-tb">\s*<!--[^>]*-->\s*<button type="button" class="tb-home" id="tr-home" data-i18n-aria="nav\.home"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"\/><path d="M3 10a2 2 0 0 1 \.709-1\.528l7-6a2 2 0 0 1 2\.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"\/><\/svg><\/button>\s*<div class="envsw"/.test(tb) && !/title=/.test(tb.slice(0, tb.indexOf('class="envsw"'))));
    ok("③ CSS:本體 28×28、--radius-sm、--ink-3;熱區 ::before inset -8 -3 -8 -13(44×44);圖示 16／線寬 1.75;滑過 --surface-muted、雲端改 --bg-body;no-drag;沒有選中態外觀",
      /\.tb-home \{[^}]*-webkit-app-region: no-drag;[^}]*width: 28px; height: 28px;[^}]*border-radius: var\(--radius-sm\); color: var\(--ink-3\);/.test(css)
      && /\.tb-home::before \{ content: ""; position: absolute; inset: -8px -3px -8px -13px;/.test(css) && /\.tb-home \.ic \{ width: 16px; height: 16px;[^}]*stroke-width: 1\.75;/.test(css)
      && /\.tb-home:hover \{ background: var\(--surface-muted\); color: var\(--ink\); \}/.test(css) && /html\[data-env="cloud"\] \.tb-home:hover \{ background: var\(--bg-body\); \}/.test(css) && !/\.tb-home\[aria-current/.test(css));
    ok("③ 字:nav.home zh「首頁」、en「Home」", S.zh["nav.home"] === "首頁" && S.en["nav.home"] === "Home"); }
  if (red) { console.log(`\n${red} FAIL`); process.exit(1); }
  console.log("\nALL PASS");
})();
