// 左下第一格的選單(spec first-strategy-sidebar §A3–A6、§10.1):已登入六項／沒登入三項的內容與順序、每一項的動作與埋點、
// 登入在等時不出「登出」、「帳號與方案」列尾跟設定那一頁同一支 planStateOf、使用教學網址、開關與收起的時機、位置夾回視窗、Esc 在 capture 階段攔。
// 真的函式配假 DOM,不開 Electron;鍵盤實走、180 寬、亮暗、熱區要開窗(交回清單)。
// 跑法:node tests/check_shell_side_menu.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const app = read("app.js"), html = read("index.html"), slot = read("promptslot.js"), css = read("app.css");
let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || d === undefined ? "" : "  " + JSON.stringify(d))); if (!ok) red++; };
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
const STR = vm.runInNewContext(read("strings.js") + "\nSTRINGS");

// ── 選單內容:真的 amPaint ──
const mk = (tag) => { const n = { tag, className: "", textContent: "", attrs: {}, children: [], title: "", on: {}, setAttribute(k, v) { n.attrs[k] = v; }, append(...k) { n.children.push(...k); }, addEventListener(e, f) { n.on[e] = f; } }; return n; };
function paint(o) {
  const menu = mk("div"), log = [];
  menu.replaceChildren = (...k) => { menu.children = k; };
  const ctx = { $: (id) => (id === "side-menu" ? menu : { hidden: !o.rptOn }), LANG: o.lang || "zh", t: (k) => STR[o.lang || "zh"][k] || k, document: { createElement: mk },
    amSignedIn: () => !!o.inn, amMark: () => !!o.mark, rptBag: () => ({ open: !!o.rptOn }), libExtIcon: () => mk("svg"), acct: o.acct || null,
    oauthPending: !!o.pending, planLoginBusy: !!o.busy, planStateText: () => o.full || o.st || "", planStateShort: () => o.st || "", amClose: (r) => log.push("close:" + r), amAnchor: () => "ANCHOR",
    rptMenuGo: () => log.push("rpt"), setOpen: () => log.push("set"), planOpen: () => log.push("plan"), usageUrl: () => "USAGE", docsHomeUrl: () => "DOCS",
    acctOutAsk: (a) => log.push("out:" + a), trackFeature: (n) => log.push("tm:" + n), window: { blave: { openExternal: (u) => log.push("ext:" + u) } },
    upDotNow: () => ({ on: !!o.cloudDot, key: o.cloudDot ? "2026-11-23" : null }), rpWfUpdate: () => log.push("wfupd") };
  vm.runInNewContext(cutFn(app, "amPaint") + "\namPaint();", ctx);
  const rows = menu.children.map((k) => (k.className === "am-gap" ? "GAP" : k.className === "am-who" ? "who:" + k.textContent : k.children[0].textContent));
  return { menu, rows, log, items: menu.children.filter((k) => k.className === "am-i") };
}
{ const p = paint({ inn: true, acct: { email: "a@b.co" }, st: "方案有效" });
  t("§A4 已登入:email、報告、空白、設定、帳號與方案、用量與帳務、使用教學、空白、登出", p.rows.join() === "who:a@b.co,報告,GAP,設定,帳號與方案,用量與帳務,使用教學,GAP,登出", p.rows);
  t("§A4 email 那一行不能按、不進方向鍵順序(不是 .am-i、沒有 role)", p.menu.children[0].tag === "p" && !p.menu.children[0].attrs.role && p.items.length === 6);
  t("§A6 項目都是 role=menuitem、tabIndex -1、type=button", p.items.every((b) => b.attrs.role === "menuitem" && b.tabIndex === -1 && b.type === "button"));
  const plan = p.items[2], v = plan.children[1];
  t("§A4 帳號與方案列尾是狀態字(跟完整那句相同時不掛 title);用量、使用教學列尾是外連箭頭", v.className === "v" && v.textContent === "方案有效" && v.title === "" && p.items[3].children[1].tag === "svg" && p.items[4].children[1].tag === "svg");
  p.items.forEach((b) => b.on.click());
  t("§A4／§10.1 每一項先收選單(焦點回第一格)再做事,埋點各一個字面名字;登出開確認框(opener = 第一格)", p.log.join() === ["close:true", "rpt", "close:true", "tm:side_menu_set", "set", "close:true", "tm:side_menu_plan", "plan",
    "close:true", "tm:side_menu_usage", "ext:USAGE", "close:true", "tm:side_menu_docs", "ext:DOCS", "close:true", "tm:side_menu_out", "out:ANCHOR"].join(), p.log); }
{ const p = paint({ inn: true, acct: {}, st: "12 月 4 日結束", full: "已取消試用 · 12 月 4 日結束" }), v = p.items[2].children[1];
  t("0160 §2.1 列尾是短字、完整那句進 title(不同時才掛)", v.textContent === "12 月 4 日結束" && v.title === "已取消試用 · 12 月 4 日結束", [v.textContent, v.title]); }
{ // 0.1.60「雲端主機有新版」(設計師 spec cloud-update-dot-0160 §3、§4):設定列點＋值,整列 aria-label 含看得到的字;按了落在一般、焦點在〔更新雲端主機〕
  for (const [lang, name] of [["zh", "設定，雲端主機有新版"], ["en", "Settings, Cloud update"]]) {
    const p = paint({ inn: true, lang, cloudDot: true }), set = p.items[1], v = set.children[1];
    t(lang + " 雲端有新版:「設定」列尾是值(點在前、字在後),title 是全字,整列 aria-label「" + name + "」;報告列照舊沒有點", v && v.className === "v" && v.children[0].className === "nav-new" && v.children[0].attrs["aria-hidden"] === "true"
      && v.children[1] === STR[lang]["up.dot"] && v.title === STR[lang]["up.dot"] && set.attrs["aria-label"] === name && p.items[0].children.length === 1, { v, aria: set.attrs }); }
  const p = paint({ inn: true, cloudDot: true }); p.items[1].on.click();
  t("點亮著時按「設定」:記 side_menu_set 與 cloud_upd_dot_go,走 rpWfUpdate(不走 setOpen)", p.log.join() === "close:true,tm:side_menu_set,tm:cloud_upd_dot_go,wfupd", p.log);
  const q = paint({ inn: true }); q.items[1].on.click();
  t("沒亮:設定列沒有值、沒有 aria-label,照舊 setOpen", q.items[1].children.length === 1 && !q.items[1].attrs["aria-label"] && q.log.join() === "close:true,tm:side_menu_set,set", q.log); }
{ const p = paint({ inn: false });
  t("§A4 沒登入:報告、空白、設定、使用教學;沒有 email 那一行", p.rows.join() === "報告,GAP,設定,使用教學", p.rows); }
for (const k of ["pending", "busy"]) { const p = paint({ inn: true, [k]: true });
  t("§A4 登入在等(" + (k === "pending" ? "oauthPending" : "planLoginBusy") + "):不出「登出」與它上面的空白", p.rows.join() === "報告,GAP,設定,帳號與方案,用量與帳務,使用教學", p.rows); }
{ const p = paint({ inn: true, st: "" });
  t("§A4 狀態字取不到就不畫(只有「帳號與方案」四個字)", p.items[2].children.length === 1); }
{ const p = paint({ inn: false, rptOn: true });
  t("§A4 報告頁開著:「報告」那一列 aria-current=page(字重 600 在 css)", p.items[0].attrs["aria-current"] === "page" && /\.am-i\[aria-current="page"\] \{ font-weight: 600; \}/.test(css)); }

// ── 共用的方案狀態字 ──
{ const pp = cutFn(app, "planPaint");
  t("§A4 planStateText 與設定 › 帳號與方案標頭同一支 planStateOf;planPaint 的表裡不再各寫一份 st", /const S = V\.head \? null : planStateOf\(view, v\);/.test(pp) && !/\bst: \[/.test(pp)
    && /const s = planStateOf\(view, v\); return s \? s\[1\] : "";/.test(cutFn(app, "planStateText")));
  // 設計稽核 0157 S3:主機運行中那格在選單列尾只講方案(en 帶「machine running」會截到天數看不到);其他格照 planStateOf
  const st = (view, o) => vm.runInNewContext(cutFn(app, "planStateText") + "\nplanStateText()", Object.assign({ sideBooted: true, planView: () => view, planVars: () => ({ n: 3 }),
    t: (k) => k, planTrialOn: () => !!o.on, planTrialCx: () => !!o.cx, planStateOf: (vw) => ["x", "stateOf:" + vw] }, o.ctx || {}));
  t("§A4／S3 running:試用中 pv.st.trial、試用取消 pv.st.trialCancelled、付費 pv.st.planOn(不帶主機運行中);其他格 planStateOf;還沒開機空字",
    st("running", { on: true }) === "pv.st.trial" && st("running", { on: true, cx: true }) === "pv.st.trialCancelled" && st("running", {}) === "pv.st.planOn"
    && st("stopped", {}) === "stateOf:stopped" && st("running", { ctx: { sideBooted: false } }) === "");
  // 0160 §2.1 選單短字:試用 side.trial、試用已取消 am.st.ends、停機一律 side.stopped、付費 pv.st.planOn;其他格照完整那句
  const sh = (view, o) => vm.runInNewContext(cutFn(app, "planStateShort") + "\nplanStateShort()", Object.assign({ sideBooted: true, planView: () => view, planVars: () => ({ n: 3, d: "12 月 4 日" }),
    t: (k) => k, acct: o.acct || null, planTrialOn: () => !!o.on, planTrialCx: () => !!o.cx, planStateText: () => "full:" + view }, o.ctx || {}));
  const shGot = [sh("trial", {}), sh("trial", { acct: { trial_cancel_at_end: true } }), sh("running", { on: true }), sh("running", { on: true, cx: true }), sh("running", {}), sh("stopped", {}), sh("payFail", {}), sh("running", { ctx: { sideBooted: false } })];
  t("0160 §2.1 planStateShort 照短字表", JSON.stringify(shGot) === JSON.stringify(["side.trial", "am.st.ends", "side.trial", "am.st.ends", "pv.st.planOn", "side.stopped", "full:payFail", ""]), shGot);
  t("0160 §2.1 短字 zh「{d}結束」、en「Ends {d}」", STR.zh["am.st.ends"] === "{d}結束" && STR.en["am.st.ends"] === "Ends {d}");
  const ctx = { t: (k, v) => k + (v ? "|" + JSON.stringify(v) : ""), acct: null, planVars: () => ({ m: 5 }), planTrialOn: () => false, planTrialCx: () => false, planMo: () => true, planStopKind: () => "x" };
  vm.runInNewContext(cutFn(app, "planStateOf"), ctx); const P = (view, extra) => vm.runInNewContext("planStateOf(" + JSON.stringify(view) + ")", Object.assign(ctx, extra || {}));
  const got = ["out", "revoked", "unknown", "offer", "noTrial", "plan", "included", "billed", "none", "payFail", "planOn", "starting", "running"].map((v) => { const s = P(v); return s ? s.join(":") : null; });
  t("§A4 planStateOf 照狀態表(沒有狀態列的格回 null)", JSON.stringify(got) === JSON.stringify([null, null, null, null, null, ":pv.st.noPlan", "on:pv.st.ok", "on:pv.st.ok", "bad:pv.st.noData", "bad:pv.st.payFail", "on:pv.st.planOn", "busy:pv.st.starting", "on:plan.st.running"]), got);
  const stop = ["fail", "ended", "self"].map((k) => P("stopped", { planStopKind: () => k })[1]).concat([P("stopped", { planStopKind: () => "x" })[1], P("trial", { acct: { trial_cancel_at_end: true } })[1]]);
  t("§A4 planStateOf 停機四種與已取消試用", JSON.stringify(stop) === JSON.stringify(["plan.st.stoppedPlan", "plan.st.ended", "side.stopped", "plan.st.stopped|{\"m\":5}", "pv.st.trialCancelled|{\"m\":5}"]), stop); }

// ── 網址、開關、位置、收起時機 ──
{ const u = (L) => vm.runInNewContext(cutFn(app, "docsHomeUrl") + "\ndocsHomeUrl();", { LANG: L });
  t("§A4 使用教學開 /docs/<lang>?from=desktop(沒有結尾斜線,不借 docsUrl)", u("zh") === "https://blave.org/docs/zh?from=desktop" && u("en") === "https://blave.org/docs/en?from=desktop"); }
{ const els = {}, el = (id) => els[id] || (els[id] = { id, hidden: true, attrs: {}, style: {}, offsetWidth: 240, prev: null, setAttribute(k, v) { this.attrs[k] = v; }, focus() { log.push("focus:" + id); },
    get previousElementSibling() { return this.prev; }, after(m) { m.prev = this; log.push("after:" + id); }, getBoundingClientRect: () => ({ left: this_left, top: 760 }), querySelector: () => ({ focus: () => log.push("focus:first") }) });
  let this_left = 12, rail = false; const log = [];
  const ctx = { $: el, document: { documentElement: { classList: { contains: (c) => c === "ws-sc" && rail } } }, window: { innerWidth: 400, innerHeight: 800 },
    slotPopClose: (r) => log.push("phclose:" + r), amPaint: () => log.push("paint"), amFirstPaint: () => log.push("first"), trackFeature: (n) => log.push("tm:" + n) };
  vm.runInNewContext(["amAnchor", "amIsOpen", "amOpen", "amClose"].map((f) => cutFn(app, f)).join("\n"), ctx);
  vm.runInNewContext("amOpen()", ctx);
  t("§A6 打開:手機步驟框先收、選單搬到看得到的那顆後面、畫、第一格 aria-expanded、送 side_menu_open、焦點落第一項", log.join() === "phclose:false,after:ws-conn,paint,first,tm:side_menu_open,focus:first" && el("ws-conn").attrs["aria-expanded"] === "true" && !el("side-menu").hidden, log);
  t("§A4 位置:左緣對齊第一格、往上開、間距 8(position: fixed)", el("side-menu").style.left === "12px" && el("side-menu").style.bottom === 800 - 760 + 8 + "px");
  log.length = 0; vm.runInNewContext("amClose(true)", ctx);
  t("§A6 收起:兩顆 aria-expanded=false、重畫第一格(點搬回來)、焦點回第一格", el("side-menu").hidden && el("ws-conn").attrs["aria-expanded"] === "false" && el("rail-set").attrs["aria-expanded"] === "false" && log.join() === "first,focus:ws-conn", log);
  rail = true; this_left = 300; log.length = 0; vm.runInNewContext("amOpen()", ctx);
  t("§A7 細軌:選單搬到 #rail-set 後面;右邊放不下夾回視窗、離邊 8", log[1] === "after:rail-set" && el("side-menu").style.left === 400 - 240 - 8 + "px", [log, el("side-menu").style.left]);
  vm.runInNewContext("amClose(false)", ctx); }
{ const wire = app.slice(app.indexOf('["ws-conn", "rail-set"].forEach((id) => {\n  $(id).addEventListener("click"'), app.indexOf("\n}\n", app.indexOf("new MutationObserver(() => { const now = at();")) + 3);
  t("§A6 第一格:click 開／收、↑ 開;選單 ↑↓ 循環、Home／End、Tab 收起不攔預設", /\$\(id\)\.addEventListener\("click", \(\) => \(amIsOpen\(\) \? amClose\(true\) : amOpen\(\)\)\);/.test(wire) && /e\.key === "ArrowUp" && !amIsOpen\(\)\) \{ e\.preventDefault\(\); amOpen\(\); \}/.test(wire)
    && /if \(e\.key === "Tab"\) \{ amClose\(false\); return; \}/.test(wire) && /"Home" \? 0 : e\.key === "End" \? items\.length - 1/.test(wire));
  t("§A6 Esc:capture 階段攔下並 stopPropagation(不連帶 escTop 關別的),焦點回第一格", /document\.addEventListener\("keydown", \(e\) => \{ if \(e\.key === "Escape" && amIsOpen\(\) && !e\.isComposing\) \{ e\.stopPropagation\(\); e\.preventDefault\(\); amClose\(true\); \} \}, true\);/.test(wire));
  t("§A6 收起時機:點外面、視窗失焦、resize、任何 scrim 打開、#view-ws inert／藏起來、切視角、側欄收合／展開", /pointerdown[^\n]*amClose\(false\)/.test(wire) && /window\.addEventListener\("blur", \(\) => amClose\(false\)\);/.test(wire) && /window\.addEventListener\("resize", \(\) => amClose\(false\)\);/.test(wire)
    && /observe\(\$\("view-ws"\), \{ attributes: true, attributeFilter: \["inert", "hidden"\] \}\)/.test(wire) && /querySelectorAll\("\.scrim"\)/.test(wire) && /html\.classList\.contains\("ws-sc"\) \+ "\|" \+ html\.dataset\.env/.test(wire));
  t("§A6 手機步驟框打開時選單先收(promptslot.js)", /if \(slotPopOpen\(\)\) \{ slotPopClose\(true\); return; \}\n\s*if \(typeof amClose === "function"\) amClose\(false\);/.test(slot)); }
t("§A3／§A6 index.html:兩顆第一格 aria-haspopup=menu、aria-expanded、aria-controls=side-menu;#side-menu role=menu 緊接 #ws-conn;沒有 #rpt-nav",
  (html.match(/aria-haspopup="menu" aria-expanded="false" aria-controls="side-menu"/g) || []).length === 2 && /id="ws-conn"[^\n]*<\/button>\n[^\n]*\n\s*<div class="side-menu" id="side-menu" role="menu" hidden><\/div>/.test(html) && !/rpt-nav/.test(html));
t("§A4／0160 §2.2 長相:寬 240(跟手機步驟框同寬)、--surface-card、--shadow-md、--radius-lg、內距 6,不加 border;項目 6×10(token 組)、--radius-xs、13px、--ink-2;只轉 background／color;開著的底只加在帳號鈕與 #rail-set,不連帶細軌展開鈕",
  /\.ic-btn\.av:hover, \.ic-btn\.av\[aria-expanded="true"\], #rail-set\[aria-expanded="true"\] \{/.test(css) && !/\.rail-btn\[aria-expanded/.test(css) && !/\.am-(who|i) \{[^}]*\b10px/.test(css) &&
  /\.side-menu \{ position: fixed; z-index: 40; width: 240px; padding: var\(--space-6\); background: var\(--surface-card\); border-radius: var\(--radius-lg\); box-shadow: var\(--shadow-md\); \}/.test(css)
  && /\.am-i \{[^}]*padding: var\(--space-6\) calc\(var\(--space-4\) \+ var\(--space-6\)\); border: 0; border-radius: var\(--radius-xs\); background: none; font-size: 13px; color: var\(--ink-2\);[^}]*transition: background var\(--motion-fast\) var\(--ease-standard\), color var\(--motion-fast\) var\(--ease-standard\); \}/.test(css));
// §A9 agent 讀的三處:入口搬家了,句子要新舊兩種外殼都講得通(web 那半句不動)
{ const root = path.join(__dirname, ".."), rd = (f) => fs.readFileSync(path.join(root, f), "utf8");
  const ag = rd("AGENTS.md"), rf = rd("references/reports.md"), rp = rd("lib/report.py");
  t("§A9 AGENTS.md、references/reports.md 兩處、lib/report.py 都講電腦版在左下選單、舊版在側欄;沒有只講「left sidebar」的舊句",
    ag.includes("desktop: Reports in the bottom-left menu, older app versions: the left sidebar") && (rf.match(/desktop: Reports in the bottom-left menu, older app versions: the left sidebar/g) || []).length === 2
    && rp.includes("(web: the sidebar; desktop: the bottom-left menu, older app versions: the sidebar)") && !/desktop: Reports in the left sidebar\)/.test(ag) && !/\(Reports in the sidebar\)/.test(rp)); }
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
