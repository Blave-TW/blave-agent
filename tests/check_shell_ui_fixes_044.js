// 電腦版 UI 修正(spec desktop-ui-fixes-2026-11-02,0.1.44):霧的種類、字、{pd} 守門、報告霧、下單帳戶框、量測版面。
//   純 node:字串逐字、poFog 新霧種、pvPriced、Codex 那一列的字、埋點白名單
//   Electron(隱藏視窗,BLAVE_TEST_WINDOW=1):報告霧、新增報告框、連接框、選擇框空狀態、霧到底、設定框法遵連結
// 跑法:node tests/check_shell_ui_fixes_044.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const GATE = require("./_electron_gate");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
let red = 0; const ok = (name, c, info) => { console.log((c ? "PASS  " : "FAIL  ") + name + (c || info === undefined ? "" : "\n      " + info)); if (!c) red++; };
const J = JSON.stringify;

if (!process.versions.electron) {
  const psrc = fs.readFileSync(path.join(R, "portfolio.js"), "utf8"), tsrc = fs.readFileSync(path.join(R, "trade.js"), "utf8"), asrc = fs.readFileSync(path.join(R, "app.js"), "utf8");
  const cut = (s, n) => { const i = s.indexOf("function " + n + "("); if (i < 0) throw new Error("no " + n); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error(n); };
  const STR = (() => { const ctx = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(R, "strings.js"), "utf8").replace(/^const STRINGS\s*=/m, "this.STRINGS ="), ctx); return ctx.STRINGS; })();

  // ── 字:spec 表上逐字 ──
  const COPY = {
    "po.fogNew": ["請 agent 做一支策略，回測完成就能設金額。", "Ask the agent for a strategy. Once it’s backtested, you can size it."],
    "mg.fogNew": ["請 agent 做幾支策略，回測完成就能優化。", "Ask the agent for a few strategies. Once they’re backtested, you can optimize."],
    "tr.pick.empty": ["還沒有回測完成的策略。", "No backtested strategies yet."],
    "tr.fogPosNew": ["請 agent 做一支策略，回測完成就能下單。", null],
    "tr.noStrategies": ["還沒有可以下單的策略。先請 agent 做一支，回測完就能設金額。", null],
    "tr.noAccount": ["還沒連接下單帳戶", "No trading account connected"],
    "tr.fogConnect": ["連上帳戶，策略就能自動下單。", "Connect an account and your strategies can trade on their own."],
    "tr.cloud.fogConnect": ["雲端主機要自己連一次帳戶，連上就能自動下單。", "The cloud machine needs its own account. Once connected, strategies can trade on their own."],
    "tr.onboard": ["先連接下單帳戶，再按上方「解除暫停」、設金額。", "Connect a trading account, then press Release pause above and set amounts."],
    "tr.cloud.onboardExtra": ["這台電腦連的帳戶不會帶過來，雲端要自己連一次。", "The account connected on this computer doesn’t carry over. The cloud needs its own."],
    "pv.f.out.m": ["試用結束後自動開始計費，每 {pd} 天 {p} TWD。", null],
    "pv.e.sub.m": ["試用結束自動扣第一期，每 {pd} 天 {p} TWD。試用期間取消就不扣。", null],
    "pv.d.noTrial.m": ["這個帳號沒有首次綁卡的試用。Blave 資料要開通 Blave Agent 方案（每 {pd} 天 {p} TWD 起）。", null],
    "pv.d.plan.m": ["Blave 資料要開通 Blave Agent 方案（每 {pd} 天 {p} TWD 起）。沒有的話，電腦版只用公開資料。", null],
    "lib.gate.feeActual": ["實際 {v}", "Actual {v}"],
    "lib.gate1d": ["手續費不低於實際費率、沒有假歷史", null],
    "lib.gate.naShort": ["不適用", null],
    "lib.gate.robustOver": ["鄰近參數平均比選定那組還好", null],
    "cap.group.tw": ["台灣期貨", null],
    "cx.venue": ["交易所或期貨商", null],
    "br.set.sub": ["agent 可以開網頁查資料、操作網站。", null],
    "rpt.fogNew": ["請 agent 寫第一份報告。", "Ask the agent for your first report."],
    "cx.connect": ["連接帳戶", "Connect Account"],
    "env.open.more": ["其他方案與價格", "Other Plans and Prices"],
  };
  Object.keys(COPY).forEach((k) => { const [zh, en] = COPY[k]; ok("字 " + k, STR.zh[k] === zh && (en ? STR.en[k] === en : !!STR.en[k]), J([STR.zh[k], STR.en[k]])); });
  ok("§7 方案價五句都帶 {pd}、{p},沒有「月」(zh、en 同)", ["pv.f.out.m", "pv.f.offer.m", "pv.e.sub.m", "pv.d.noTrial.m", "pv.d.plan.m"].every((k) => /\{pd\}/.test(STR.zh[k]) && /\{p\}/.test(STR.zh[k]) && !/月/.test(STR.zh[k]) && /every \{pd\} days/.test(STR.en[k]) && !/month/i.test(STR.en[k])));
  ok("§5 頁首、霧卡不再說「交易所」,霧卡是「就能」", ["tr.noAccount", "tr.fogConnect", "tr.cloud.fogConnect"].every((k) => !/交易所/.test(STR.zh[k]) && !/exchange/i.test(STR.en[k])) && !/就會/.test(STR.zh["tr.fogConnect"] + STR.zh["tr.cloud.fogConnect"]));
  { const po = fs.readFileSync(path.join(SHELL, "i18n", "zh.po"), "utf8"), hits = po.split("\n").map((l, i, a) => (/代理/.test(l) ? a[i - 1] : null)).filter(Boolean);
    ok("「代理」在 shell 的 zh.po 只剩法遵 pdf.disc1", J(hits) === J(['msgid "pdf.disc1"']), J(hits)); }

  // ── §7 pvPriced ──
  { const c = vm.createContext({}); vm.runInContext(cut(asrc, "pvPriced"), c); c.q = [["pv.f.out.m", { p: "1,440", pd: "30" }], ["pv.f.out.m", { p: "1,440", pd: "" }], ["pv.f.out.m", { p: "", pd: "30" }], ["pv.f.out", { p: "1,440", pd: "" }]];
    ok("§7 pvPriced:方案制缺 {p} 或 {pd} 不出;舊制只看 {p}", J(vm.runInContext("q.map((x) => pvPriced(x[0], x[1]))", c)) === J([true, false, false, true]));
    ok("§7 方案制的價句都過 pvPriced(未登入底列、綁卡底列、聊天卡小字、無試用、沒有方案)", /hasNum && pvPriced\(pvK\("pv\.f\.out"\), v\)/.test(asrc) && /pvPriced\(k, v\)/.test(cut(asrc, "pvCardFoot"))
      && (asrc.match(/pvPriced\(pvK\("pv\.e\.sub"\), v\)/g) || []).length === 2 && /!mo \|\| pvPriced\("pv\.d\.noTrial\.m", v\)/.test(asrc) && /pvPriced\("pv\.d\.plan\.m", v\)/.test(asrc)); }

  ok("§7 登入用戶開帳號與方案:公開價目還沒有就補抓,{pd} 才回得來(稽核 B3)", /if \(hasToken\) \{ acctCheck\(\); balLoad\(\); if \(!pub\) pubLoad\(\)\.then\(\(\) => \{ if \(!\$\("set-plan"\)\.hidden\) planPaint\(\); \}\); \}/.test(cut(asrc, "setCat")));

  // ── §1、§2 poFog ──
  { class El { constructor(tag, cls, text) { this.tag = tag; this.className = cls || ""; this.textContent = text || ""; this.kids = []; this.dataset = {}; this.on = {}; this.id = ""; this.cl = new Set(); this.classList = { add: (x) => this.cl.add(x) }; }
      setAttribute() {} appendChild(c) { this.kids.push(c); return c; } append(...c) { this.kids.push(...c); } addEventListener(e, f) { this.on[e] = f; } }
    const fx = { go: [], tm: [] };
    const c = vm.createContext({ TR: { env: "local" }, t: (k) => k, trEl: (tag, cls, text) => new El(tag, cls, text), trPickOff: () => false, psOpen: () => {}, cxModalOpen: () => {}, trZGo: (k, b) => fx.go.push([k, b.id]), trackFeature: (n) => fx.tm.push(n),
      poFogCfg: () => new El("div", "cfg-under"), poFogOver: () => new El("div", "over-under"), poFogPos: () => new El("div", "pos-under"), poFogOpt: () => new El("div", "opt-under"), mgOptBlockReason: () => null, mgMembers: () => [], mgRunOptimize: () => {} });
    vm.runInContext(cut(psrc, "poFog"), c);
    const card = (kind) => { const f = vm.runInContext(`poFog(${J(kind)})`, c); return { f, under: f.kids[0].kids[0], msg: f.kids[1].kids[0], btn: f.kids[1].kids[1] }; };
    const a = card("po-new"), b = card("mg-new"); a.btn.on.click(); b.btn.on.click();
    ok("§1 po-new:底是配置金額表、字 po.fogNew、鈕〔新增策略〕→ trZGo(noStrat)、記 po_fog_new;只有一顆鈕", a.under.className === "cfg-under" && a.msg.textContent === "po.fogNew" && a.btn.textContent === "ns.chip" && J(fx.go[0]) === J(["noStrat", a.btn.id]) && fx.tm[0] === "po_fog_new" && a.f.kids[1].kids.length === 2, J([a.under.className, a.msg.textContent, fx]));
    ok("§2 mg-new:底是權重表、加 mg-fog、字 mg.fogNew、鈕〔新增策略〕→ trZGo(noStrat)、記 mg_fog_new", b.under.className === "opt-under" && b.f.cl.has("mg-fog") && b.msg.textContent === "mg.fogNew" && b.btn.textContent === "ns.chip" && J(fx.go[1]) === J(["noStrat", b.btn.id]) && fx.tm[1] === "mg_fog_new", J([b.under.className, b.msg.textContent, fx]));
    ok("§2 mgPaint 沒有策略時走 mg-new,不再走 pick;§1 poPaintCfg 先判有沒有回測完成的", /box\.appendChild\(poFog\("mg-new"\)\); box\.dataset\.fog = LANG;/.test(cut(psrc, "mgPaint")) && !/poFog\("pick"\)/.test(psrc) && /poFog\(TR\.list\.some\(\(x\) => x\.hasBacktest\) \? "pick" : "po-new"\)/.test(cut(tsrc, "poPaintCfg"))); }

  // ── §16 ──
  { const c = vm.createContext({}); vm.runInContext(cut(asrc, "codexPkgRow"), c);
    const r = vm.runInContext('codexPkgRow({ phase: "idle", fail: null, size: 166 }, {})', c);
    ok("§16 Codex 下載列:連結畫面、額度卡照舊〔連結〕;設定 › 模型接入叫〔登入〕(抓完開登入、不換引擎),動作判斷仍看 act", r.act === "cn.connect" && r.setLabel === "cn.signIn" && /t\(o\.setLabel \|\| o\.act\)/.test(cut(asrc, "mdlPaint")) && /setLabel: pk\.setLabel, pkg: true/.test(asrc) && /if \(o\.pkg\) return codexPkgGo/.test(asrc), J(r)); }

  // ── 埋點 ──
  { const wl = (fs.readFileSync(path.join(SHELL, "telemetry.js"), "utf8").match(/feature_used: \{ name: \[([\s\S]*?)\] \}/) || [, ""])[1];
    ok("新事件名進白名單、接在 0.1.44 那一段的最後(api 同順序先上;0.1.45 的 cn_* 接在它後面)", /"po_fog_new", "mg_fog_new", "rpt_fog_new",\s*(\/\/[^\n]*\n\s*)?"cn_try", "cn_install"\s*$/.test(wl)); }

  const bin = GATE.bin(SHELL, "報告霧、連接框、版面");
  if (bin) {
    const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: process.env, cwd: SHELL });
    if (r.status !== 0) red++;
  }
  if (red) { console.log(red + " 紅"); process.exit(1); }
  console.log("全綠");
} else {
  const { app, BrowserWindow } = require("electron"), os = require("os");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-ui044-")));
  const STUB = `window.__over = {}; window.__calls = [];
window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : async (...a) => { window.__calls.push([k, a]); if (k in window.__over) return window.__over[k](...a);
      return ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
        listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" }, browserPrefs: { enabled: true } })[k]; } });`;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  app.whenReady().then(async () => {
    setTimeout(() => { console.log("FAIL  逾時(60 秒內沒跑完)"); app.exit(1); }, 60000).unref();
    const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
    const open = async (width, height) => {
      const w = new BrowserWindow({ width, height, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
      await w.loadFile(path.join(R, "index.html")); await wait(1200);
      return (s) => w.webContents.executeJavaScript(s, true);
    };
    const js = await open(1440, 900);

    // §18 霧到底:配置、優化;示意底短於主區時遮罩也要蓋到主區底
    for (const theme of ["light", "dark"]) for (const [kind, host, id] of [["po-new", "po", "po-cfg"], ["mg-new", "po", "po-opt"], ["pick", "po", "po-cfg"], ["pos-new", "tr", "tr-pos"], ["connect", "tr", "tr-over"]]) {
      const g = await js(`(() => { document.documentElement.setAttribute("data-theme", ${J(theme)}); $("view-ws").hidden = false; for (const x of ["tr", "po", "rpt", "lib", "main-empty", "rp"]) $(x).hidden = true; $(${J(host)}).hidden = false;
        for (const x of ["po-cfg", "po-opt", "tr-onboard", "tr-over", "tr-pos", "tr-assets", "tr-hist", "tr-set"]) $(x).hidden = true;
        const box = $(${J(id)}); box.hidden = false; box.textContent = ""; box.appendChild(poFog(${J(kind)}));
        const f = box.querySelector(".fog").getBoundingClientRect(), b = box.getBoundingClientRect(), o = { fb: f.bottom, bb: b.bottom, ft: f.top, bt: b.top, h: b.height, sc: box.scrollHeight - box.clientHeight }; box.textContent = ""; return o; })()`);
      ok("§18 " + theme + " " + kind + ":霧的頂、底 = 主區頂、底(±1),不捲動", g.h > 300 && Math.abs(g.fb - g.bb) <= 1 && Math.abs(g.ft - g.bt) <= 1 && g.sc <= 1, J(g));
    }
    await js(`document.documentElement.setAttribute("data-theme", "light")`);
    // 窄欄 .pf padding 收成 16:霧的負 margin 跟著收,縱橫都不能捲(走查 1024×680;padding 斷言防這條變空測)
    const jsN = await open(1024, 680);
    for (const [kind, host, id] of [["po-new", "po", "po-cfg"], ["mg-new", "po", "po-opt"], ["pick", "po", "po-cfg"], ["pos-new", "tr", "tr-pos"], ["connect", "tr", "tr-over"]]) {
      const g = await jsN(`(() => { $("view-ws").hidden = false; for (const x of ["tr", "po", "rpt", "lib", "main-empty", "rp"]) $(x).hidden = true; $(${J(host)}).hidden = false;
        for (const x of ["po-cfg", "po-opt", "tr-onboard", "tr-over", "tr-pos", "tr-assets", "tr-hist", "tr-set"]) $(x).hidden = true;
        const box = $(${J(id)}); box.hidden = false; box.textContent = ""; box.appendChild(poFog(${J(kind)}));
        const f = box.querySelector(".fog").getBoundingClientRect(), b = box.getBoundingClientRect(), o = { pad: getComputedStyle(box).paddingTop, dt: f.top - b.top, dl: f.left - b.left, dr: f.right - b.right, sy: box.scrollHeight - box.clientHeight, sx: box.scrollWidth - box.clientWidth }; box.textContent = ""; return o; })()`);
      ok("窄欄 " + kind + ":霧貼齊容器,縱橫都不捲", g.pad === "16px" && Math.abs(g.dt) <= 1 && Math.abs(g.dl) <= 1 && Math.abs(g.dr) <= 1 && g.sy <= 1 && g.sx <= 1, J(g));
    }

    // §1 選擇框空狀態:一句接〔策略庫〕,按下關框、到策略庫
    const ps = await js(`(async () => { for (const x of ["po"]) $(x).hidden = false; TR.open = true; TR.view = "po"; TR.listLoaded = true; TR.list = []; trPickOff = () => false; trLoadStrategies = async () => {}; window.__lib = 0; libOpen = () => { window.__lib++; };
      $("ps-scrim").hidden = true; await psOpen(null); const b = document.querySelector('#ps-list .ps-next [data-fk="pick-empty"]'), o = { open: !$("ps-scrim").hidden, text: (document.querySelector("#ps-list .ps-next") || {}).textContent, label: b && b.textContent, cls: b && b.className, plain: $("ps-list").querySelectorAll(".pf-state").length };
      if (b) b.click(); o.closed = $("ps-scrim").hidden; o.lib = window.__lib; return o; })()`);
    ok("§1 選擇框空清單:tr.pick.empty 接安靜鈕〔策略庫〕,按下框關、libOpen", ps.open && ps.cls === "btn-quiet" && ps.plain === 0 && ps.text === (await js(`t("tr.pick.empty") + " " + t("lib.nav")`)) && ps.closed && ps.lib === 1, J(ps));

    // §13 報告霧、§14 新增報告框
    const rptOpen = `$("view-ws").hidden = false; for (const x of ["tr", "po", "lib", "main-empty", "rp"]) $(x).hidden = true; $("rpt").hidden = false; rptBag("local").open = true; rptBag("local").reading = null; $("rpt-head-list").hidden = false; $("rpt-read").hidden = true;`;
    let v = await js(`(() => { ENV.cur = "local"; ${rptOpen} RPT.pending.local = null; running = false; RPT.data.local = []; rptPaintList();
      const f = document.querySelector("#rpt-rows .fog"), c = f && f.querySelector(".fog-card"), b = $("rpt-fog-new"), under = f && f.querySelector(".fog-under"), body = $("rpt-body").getBoundingClientRect(), fr = f && f.getBoundingClientRect();
      return { fog: !!f, ask: $("rpt-ask").hidden, sentence: c && c.querySelector("p").textContent, btn: b && b.textContent, cardBtns: c && c.querySelectorAll("button").length, rows: under && under.querySelectorAll(".rpt-row").length, inert: under && under.inert, hid: under && under.getAttribute("aria-hidden"), flat: document.querySelectorAll(".rpt-empty").length, bottom: fr && Math.abs(fr.bottom - body.bottom), width: fr && Math.abs(fr.width - body.width) }; })()`);
    ok("§13 空清單上霧:示意三列、inert、一句 rpt.fogNew＋一顆鈕;工具列那顆藏;鋪滿到底;不再是置中兩行", v.fog && v.ask && v.sentence === (await js(`t("rpt.fogNew")`)) && v.btn === (await js(`t("rpt.ask")`)) && v.cardBtns === 1 && v.rows === 3 && v.inert && v.hid === "true" && v.flat === 0 && v.bottom <= 1 && v.width <= 1, J(v));
    v = await js(`(() => { RPT.pending.local = { before: new Set() }; rptPaintHead(); const o = { fog: !!document.querySelector("#rpt-rows .fog"), ask: $("rpt-ask").hidden, flat: document.querySelectorAll(".rpt-empty .l1").length, msg: $("rpt-msg").textContent }; RPT.pending.local = null; rptPaintHead(); o.back = !!$("rpt-fog-new") && $("rpt-ask").hidden; return o; })()`);
    ok("§13 agent 寫作中:沒有第一步可做,不上霧、工具列回來;結束後霧回來", !v.fog && !v.ask && v.flat === 1 && v.back && v.msg === (await js(`t("rpt.note.pending")`)), J(v));
    v = await js(`(() => { RPT.noNew = "local"; rptSync(); const o = { fog: !!$("rpt-fog-new"), ask: $("rpt-ask").hidden, msg: $("rpt-msg").textContent, l1: document.querySelectorAll(".rpt-empty .l1").length, l2: document.querySelectorAll(".rpt-empty .l2").length }; RPT.noNew = null; rptSync(); o.back = !!$("rpt-fog-new"); return o; })()`);
    ok("§13 這一輪沒有產出新報告:不上霧,狀態句與引導不並存,只剩名詞句＋工具列鈕;清掉後霧回來(稽核 B1)", !v.fog && !v.ask && v.msg === (await js(`t("rpt.err.noNew")`)) && v.l1 === 1 && v.l2 === 0 && v.back, J(v));
    v = await js(`(() => { RPT.noNew = "cloud"; rptPaintList(); const o = { fog: !!$("rpt-fog-new") }; RPT.noNew = null; RPT.failed.local = true; rptPaintList(); o.failed = !!$("rpt-fog-new"); RPT.failed.local = false; rptPaintList(); return o; })()`);
    ok("§13 另一邊的灰字不影響這一邊;這次重讀失敗不上霧(稽核 B2)", v.fog && !v.failed, J(v));
    v = await js(`(() => { RPT.data.local = [{ id: "a", title: "A", created_at: 1 }]; rptPaintList(); const o = { fog: !!document.querySelector("#rpt-rows .fog"), ask: $("rpt-ask").hidden, padded: getComputedStyle($("rpt-body")).paddingLeft }; RPT.data.local = []; rptPaintList(); return o; })()`);
    ok("§13 有報告:霧收掉、工具列回來、列的內距照舊", !v.fog && !v.ask && v.padded === "24px", J(v));
    v = await js(`(() => { window.__t = []; window.blave.trackFeature = undefined; const keep = window.blave; libTrack = (n) => window.__t.push(n); csAnyTurn = () => false; $("rpt-fog-new").click(); const d = $("rpn-desc"), s = $("rpn-send"), o = { open: !$("rpn-scrim").hidden, tr: window.__t.slice(), empty: s.disabled, desc: s.getAttribute("aria-describedby") };
      d.value = "台股"; d.dispatchEvent(new Event("input")); o.typed = s.disabled; o.descTyped = s.getAttribute("aria-describedby"); d.value = "  "; d.dispatchEvent(new Event("input")); o.blank = s.disabled;
      document.querySelector('#rpn-modal [data-tpl="rpt.new.tpl.tw"]').click(); o.tpl = s.disabled; d.value = ""; rptNewPaint(); o.again = s.disabled; rptNewClose(); o.back = document.activeElement && document.activeElement.id; return o; })()`);
    ok("§13 霧上的鈕開新增報告框、記 rpt_fog_new;§14 描述空著送出鈕停用且 describedby 說明句,打字／點範例就能按,全空白不算", v.open && J(v.tr) === J(["rpt_fog_new"]) && v.empty && v.desc === "rpn-honest" && !v.typed && v.descTyped === null && v.blank && !v.tpl && v.again, J(v));
    for (const lang of ["zh", "en"]) {
      const m = await js(`(() => { const d = $("rpn-desc"), cs = getComputedStyle(d), c = document.createElement("canvas").getContext("2d"); c.font = cs.font; return { w: c.measureText(STRINGS[${J(lang)}]["rpt.new.descPh"]).width, room: d.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), open: 0 }; })()`);
      if (m.room <= 0) { await js(`rptNewOpen($("rpt-fog-new"))`); await wait(100); Object.assign(m, await js(`(() => { const d = $("rpn-desc"), cs = getComputedStyle(d); return { room: d.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) }; })()`)); await js(`rptNewClose()`); }
      ok("§14 " + lang + " placeholder 一行放得下", m.room > 0 && m.w <= m.room, J(m));
    }

    // §15 連接框
    await js(`(() => { trPollSoon = () => {}; trPoll = async () => {}; TR_BAGS.local.st = { alive: true, report: {} }; ENV.cur = "local"; cxModalOpen(null, null); const m = $("cx-mode-real"); m.checked = true; m.dispatchEvent(new Event("change")); })()`); await wait(100);
    v = await js(`(async () => { const go = $("cx-go"), a = () => [go.disabled, go.getAttribute("aria-describedby")]; const s = $("cx-venue"); s.value = "okx"; s.dispatchEvent(new Event("change")); CXF.apiKey = ""; CXF.secret = ""; CXF.passphrase = ""; TR_BAGS.local.sig.cxm = null; cxModalPaint();
      const fill = (id, x) => { const i = $(id); i.value = x; i.dispatchEvent(new Event("input")); }; const o = { empty: a() };
      window.__calls.length = 0; go.click(); cxConnect(); await new Promise((r) => setTimeout(r, 50)); o.sent = window.__calls.filter((c) => c[0] === "venueConnect" || c[0] === "cloudConnect").length;
      fill("cx-api", "not-a-real-key"); fill("cx-secret", "not-a-real-secret"); o.noPass = a(); const inp = $("cx-pass"); inp.focus(); fill("cx-pass", "not a real pass"); o.full = a(); o.same = $("cx-pass") === inp && document.activeElement === inp;
      go.focus(); CXF.secret = ""; TR_BAGS.local.sig.cxm = null; cxModalPaint(); o.fb = document.activeElement && document.activeElement.id; o.afterClear = a(); fill("cx-secret", "not-a-real-secret");
      fill("cx-secret", "  "); o.blank = a(); fill("cx-secret", ""); const g = [...s.querySelectorAll("optgroup")].map((x) => x.label); o.groups = g; o.fld = document.querySelector("#cx-body .cx-pick .fld-l").textContent; s.value = "binance"; s.dispatchEvent(new Event("change")); CXF.apiKey = ""; CXF.secret = ""; TR_BAGS.local.sig.cxm = null; cxModalPaint(); o.bn = a();
      CXF.venue = "president"; cxModalPaint(); o.pres = a(); CXF.venue = "binance"; TR_BAGS.local.sig.cxm = null; cxModalPaint(); o.bn2 = a();
      const r = $("cx-mode-paper"); r.checked = true; r.dispatchEvent(new Event("change")); o.paper = a(); return o; })()`);
    const dis = J([true, null]), on = J([false, null]);
    ok("§15 真實帳戶、金鑰沒填滿(含 OKX 的 Passphrase):主鈕真 disabled、沒有懸空的 describedby、按了與 Enter 都不送;填滿恢復且打字焦點不掉;焦點在鈕上時變停用退到第一個空欄;全空白不算;換到統一不帶過去;模擬不擋", J(v.empty) === dis && v.sent === 0 && J(v.noPass) === dis && J(v.full) === on && v.same && v.fb === "cx-secret" && J(v.afterClear) === dis && J(v.blank) === dis && J(v.bn) === dis && J(v.pres) === on && J(v.bn2) === dis && J(v.paper) === on, J(v));
    ok("§15 下拉標題「交易所或期貨商」,群組「台灣期貨」", v.fld === (await js(`t("cx.venue")`)) && v.groups.indexOf(await js(`t("cap.group.tw")`)) > 0 && !v.groups.includes("台股") && !v.groups.includes("Taiwan stocks"), J(v));
    await js(`cxModalClose(false)`);

    // §11、§17
    v = await js(`(async () => { const b = document.createElement("div"); document.body.appendChild(b); await brSetPaint(b); const o = { sub: (b.querySelector(".br-set-sub") || {}).textContent, order: [...b.children].map((x) => x.tagName) }; b.remove(); return o; })()`);
    ok("§17 內建瀏覽器開關下一行講開著時會怎樣", v.sub === (await js(`t("br.set.sub")`)) && J(v.order) === J(["DIV", "P", "BUTTON"]), J(v));
    ok("§11 規則空狀態的〔新增規則〕是外框,焦點退路跟著改", (() => { const s = fs.readFileSync(path.join(R, "rules.js"), "utf8"); return /rsBtn\("btn-out", t\("rules\.add"\), rulesAddRow\)/.test(s) && /\.rules-empty \.btn-out/.test(s) && !/\.rules-empty \.btn-fill/.test(s); })());

    // §8 品質關卡
    v = await js(`(() => { const s = libEl("span", "gv na", t("lib.gate.naShort")), w = libGateTip(s, t("lib.gate.na"), "x-tip"), b = w.querySelector("button"), tip = w.querySelector(".tip"); return { text: b.textContent, tip: tip.textContent, desc: b.getAttribute("aria-describedby"), id: tip.id, role: tip.getAttribute("role") }; })()`);
    ok("§8 不適用:灰字短句,原本那句進泡泡", v.text === (await js(`t("lib.gate.naShort")`)) && v.tip === (await js(`t("lib.gate.na")`)) && v.desc === v.id && v.role === "tooltip", J(v));
    ok("§8 接線:只有統計顯著的 na 上泡泡、保留率 > 100% 才上泡泡", (() => { const s = fs.readFileSync(path.join(R, "library.js"), "utf8"); return /key === "mcpt" && v !== "pass" && v !== "fail" \? libGateTip\(gv, t\("lib\.gate\.na"\)/.test(s) && /key === "robust" && rob\.ratio > 1 \? libGateTip\(gx, t\("lib\.gate\.robustOver"\)/.test(s); })());

    // §19 矮視窗:法遵連結看得到
    const js2 = await open(955, 670);
    const legal = await js2(`(async () => { await setOpen(); setCat("display"); await new Promise((r) => setTimeout(r, 200)); const c = document.querySelector("#set-modal .set-content"), l = $("set-terms").getBoundingClientRect(), cr = c.getBoundingClientRect(), m = $("set-modal").getBoundingClientRect(); c.scrollTop = 0;
      const l0 = $("set-terms").getBoundingClientRect(), o = { h: window.innerHeight, over: c.scrollHeight - c.clientHeight, bottom: l0.bottom, cbottom: cr.bottom, mb: m.bottom, top: l0.top, ctop: cr.top }; return o; })()`);
    ok("§19 955×670:框在視窗內,條款連結不被切(內容區捲到頂也看得到)", legal.mb <= legal.h && legal.bottom <= legal.cbottom + 0.5 && legal.top >= legal.ctop && legal.over > 0, J(legal));

    console.log(red ? red + " 紅(Electron 段)" : "Electron 段全綠");
    app.exit(red ? 1 : 0);
  }).catch((e) => { console.log("FAIL  " + (e && e.stack || e)); app.exit(1); });
}
