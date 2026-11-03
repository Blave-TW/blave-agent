// 連結畫面的偵測永不卡在「偵測中…」(spec codex-detect-gaps §3.4 D):renderer 的 detect() 在 IPC reject 時自己組一份
// 主行程超時那份形狀,照「沒有回應」畫;本機登入流程遇例外也要走完收尾,鈕不會永遠鎖住。
// renderer/app.js 原文切出來配假的 DOM／IPC 跑;不起 Electron、不跑真的 CLI。跑法:node tests/check_shell_detect_guard.js
const fs = require("fs"), path = require("path");
const app = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const cut = (a, b) => { const i = app.indexOf(a), j = app.indexOf(b, i); if (i < 0 || j < 0) { console.log("FAIL  app.js 裡找不到標記:" + (i < 0 ? a : b)); process.exit(1); } return app.slice(i, j); };
const fn = (name) => { const i = app.indexOf("function " + name + "("); if (i < 0) { console.log("FAIL  找不到 " + name); process.exit(1); } let d = 0; for (let k = app.indexOf("{", app.indexOf(")", i)); k < app.length; k++) { if (app[k] === "{") d++; else if (app[k] === "}" && --d === 0) return app.slice(i, k + 1); } throw new Error("切不出 " + name); };
const whyState = eval("(" + app.match(/^const whyState = (.*);$/m)[1] + ")");
const authUnknown = eval("(" + app.match(/^const authUnknown = (.*);$/m)[1] + ")");

(async () => {
  // ── detect():detectAgents reject → 不丟、paintRows 拿到「沒有回應」的完整形狀、akSetInfo 沒被叫 ──
  const DETECT = cut("let lastDetect = null", "/* 從瀏覽器");
  const mk = (ipc, akInfo) => {
    const log = { paint: [], ak: 0, ev: [] };
    const R = new Function("ctx", `with (ctx) { ${DETECT}\nreturn { detect, get: () => lastDetect, PKG }; }`)({
      $: (id) => ({ hidden: id !== "view-connect" ? false : false }), localReady: false, AK: { info: akInfo }, detectingRows: () => {}, setHint: () => {}, loginPending: null, document: { activeElement: null },
      paintRows: (d) => log.paint.push(d), akSetInfo: () => { log.ak++; }, trackEvent: (e, p) => log.ev.push(e + ":" + JSON.stringify(p)), t: (k) => k, MDL: { busy: true },
      window: { blave: { detectAgents: ipc } } });
    return { R, log };
  };
  const AKI = { saved: "deepseek", presets: [{ id: "deepseek", name: "DeepSeek" }] };
  const a = mk(() => Promise.reject(new Error("ipc gone")), AKI);
  let threw = false; try { await a.R.detect(); } catch (_) { threw = true; }
  const d = a.log.paint[0] || {};
  ok("detectAgents reject → detect() 不丟、paintRows 被叫一次", !threw && a.log.paint.length === 1, { threw, n: a.log.paint.length });
  ok("…傳進 paintRows 的兩列都是 installed && whyState === st.noResp(畫「沒有回應」,不是「未偵測到」)",
    ["claude", "codex"].every((k) => d[k] && d[k].installed && whyState(d[k]) === "st.noResp" && d[k].path === null && d[k].loggedIn === false), d);
  ok("…apikey 帶上一次知道的(AK.info),不是 undefined;akSetInfo 沒被叫", d.apikey === AKI && a.log.ak === 0, { apikey: d.apikey, ak: a.log.ak });
  ok("…lastDetect 就是那一份(換語言重畫、focusRedetect 讀的是它);codex via=null、claude how=null", a.R.get() === d && d.codex.via === null && d.claude.how === null);
  ok("…連結畫面上照舊送 detect_fail(兩條 *_timeout)", a.log.ev.includes('detect_fail:{"why":"claude_timeout"}') && a.log.ev.includes('detect_fail:{"why":"codex_timeout"}'), a.log.ev);
  const b = mk(() => Promise.reject(new Error("x")), undefined);
  await b.R.detect();
  ok("AK.info 還沒有 → apikey 是 null(不是 undefined)", b.log.paint[0].apikey === null, b.log.paint[0].apikey);
  const GOOD = { claude: { installed: true, loggedIn: true }, codex: { installed: false }, apikey: { saved: null } }, c = mk(async () => GOOD, AKI);
  await c.R.detect();
  ok("detectAgents 正常 → 原樣畫、akSetInfo 叫一次", c.log.paint.length === 1 && c.log.paint[0] === GOOD && c.log.ak === 1);
  // detect_fail:隨包還沒抓是正常狀態,每個還沒連 Codex 的人開這個畫面都會有;機器不支援隨包的留在埋點裡;真的壞掉的照送
  { const ev = async (codex, snap) => { const x = mk(async () => ({ claude: { installed: true, loggedIn: true }, codex, apikey: null }), AKI); x.R.PKG.snap = snap || null; await x.R.detect(); return x.log.ev.filter((e) => e.startsWith("detect_fail:")).join(); };
    const NONE = { installed: false, why: "codex_none" }, SENT = 'detect_fail:{"why":"codex_none"}', NZ = 'detect_fail:{"why":"codex_nonzero"}';
    const none = await ev(NONE, { phase: "idle", fail: null }), snapless = await ev(NONE), arch = await ev(NONE, { phase: "idle", unsupported: "arch" }), tar = await ev(NONE, { phase: "idle", unsupported: "tar" });
    const slow = await ev({ installed: true, why: "codex_timeout" }), no = await ev({ installed: true, why: "codex_nonzero" }), bad = await ev({ installed: true, why: "codex_cantrun" });
    const cl = mk(async () => ({ claude: { installed: false, why: "claude_none" }, codex: NONE, apikey: null }), AKI); await cl.R.detect();
    ok("detect_fail:codex_none 只在 PKG.snap.unsupported 時送(arch／tar);一般機器與快照還沒到不送;codex_timeout／codex_nonzero／cantrun→nonzero 照送;claude_none 照送",
      none === "" && snapless === "" && arch === SENT && tar === SENT && slow === 'detect_fail:{"why":"codex_timeout"}' && no === NZ && bad === NZ
      && cl.log.ev.filter((e) => e.startsWith("detect_fail:")).join() === 'detect_fail:{"why":"claude_none"}', { none, snapless, arch, tar, slow, no, bad, cl: cl.log.ev }); }
  ok("catch 分支不另外重畫(paintRows 自己放開 MDL.busy 並 mdlPaint;不加 finally 連畫兩遍)", !/finally/.test(fn("detectRun")) && (fn("detectRun").match(/paintRows\(/g) || []).length === 1);

  // ── localLogin／localLoginFlow:agentLoginRun 丟例外 → 收尾照跑(detect 重畫、loginPending 清掉) ──
  const LL = "async " + fn("localLogin"), LF = fn("localLoginFlow");
  ok("localLogin:agentLoginRun 包在 try/catch,catch 給失敗的結果物件再走原本的收尾(await detect())",
    /let r;\n  try \{\n    r = await agentLoginRun\(kind, /.test(LL) && /\} catch \(_\) \{[\s\S]*?r = \{ ok: false, cancelled: false, busy: false, cantRun: false \};\n  \}/.test(LL)
    && LL.indexOf("r = { ok: false") < LL.indexOf("loginPending = null;") && LL.indexOf("loginPending = null;") < LL.indexOf("await detectFresh();"));
  { // 真的跑一次 localLogin(連結畫面那一列):例外之後 loginPending 清掉、detect 被叫、那一列畫成登入沒完成
    const log = { detect: 0, paints: 0 };
    const ctx = { loginPending: null, oauthPending: false, ROWMSG: { claude: null, codex: null }, LAI: { msg: {} }, lastDetect: null, LANG: "zh",
      $: () => ({ querySelector: () => null, focus: () => {} }), setHint: () => {}, paintRows: () => { log.paints++; }, laiPaint: () => {}, laiOn: () => false, srSay: () => {}, t: (k) => k, trackEvent: () => {}, trackFeature: () => {},
      rowMsgText: () => "", whyState, connect: () => {},
      agentLoginRun: async () => { throw new Error("spawn EBADF"); },
      detectFresh: async () => { log.detect++; ctx.lastDetect = { codex: { installed: true, loggedIn: false, why: "codex_nonzero" } }; } };
    const run = new Function("ctx", `with (ctx) { ${LL}\nreturn localLogin; }`)(ctx);
    const b = { closest: (q) => (q === "#lai-rows" || q === ".cn-opts" ? null : {}) };
    let threw = false; try { await run("codex", b); } catch (_) { threw = true; }
    ok("…實跑:例外不往外丟、loginPending 清成 null、detect() 叫了、那一列寫「登入沒完成」", !threw && ctx.loginPending === null && log.detect === 1 && ctx.ROWMSG.codex === "failed", { threw, lp: ctx.loginPending, ...log, msg: ctx.ROWMSG.codex });
  }
  { // localLoginFlow(工作頁的登入失效卡):例外 → fault(true),鈕回〔再試一次〕
    const sets = [];
    const ctx = { loginPending: null, oauthPending: false, LOCAL_FAULTS: [], t: (k) => k, trackEvent: () => {}, trackFeature: () => {}, cmdLine: () => "cmd", resendState: () => ({}),
      agentLoginRun: async () => { throw new Error("x"); }, window: { blave: { cancelAgentLogin: () => {} } } };
    const card = { set: (s) => sets.push(s) };
    new Function("ctx", `with (ctx) { ${fn("sysLz")}\n${LF}\nlocalLoginFlow(ctx.card, "codex"); }`)(Object.assign(ctx, { card }));
    let threw = false; try { await sets[0].on(); } catch (_) { threw = true; }
    const last = sets[sets.length - 1];
    ok("localLoginFlow:例外不往外丟、loginPending 清掉、卡片回「登入沒有完成」+〔再試一次〕", !threw && ctx.loginPending === null && last.label === "login.retry" && last.text === "login.failed", { threw, last });
  }
  // ── Codex 引擎隨包裝好的那一刻(spec codex-bundled-engine §4.3):正在偵測／等登入時記 PKG.redetect,detect() 收尾時補偵測 ──
  { // 假 DOM:#agent-rows 裡兩列各一顆鈕;paintRows 會整份重建(舊鈕換成新鈕),看焦點有沒有還回同一列
    const mkBtn = (kind) => ({ kind, disabled: false, focus() { doc.activeElement = this; }, closest: () => ({ dataset: { kind } }) });
    const box = { btns: [mkBtn("claude"), mkBtn("codex")], contains(x) { return this.btns.includes(x); }, querySelector(q) { const k = (q.match(/data-kind="([^"]+)"/) || [])[1]; return this.btns.find((b) => b.kind === k) || null; } };
    const doc = { activeElement: null };
    const ctx = { PKG: { snap: null, redetect: false }, loginPending: null, detectP: null, MDL: { busy: false }, lastDetect: { claude: {}, codex: { installed: false } }, calls: [], document: doc, $: () => box };
    Object.assign(ctx, { detect: () => ctx.calls.push("detect"), paintRows: () => { ctx.calls.push("paint"); box.btns = [mkBtn("claude"), mkBtn("codex")]; doc.activeElement = null; } });
    const onState = new Function("ctx", `with (ctx) { ${fn("codexPkgOnState")}\nreturn codexPkgOnState; }`)(ctx);
    const DL = { phase: "download", bytes: 1, total: 2, fail: null }, DONE = { phase: "idle", fail: null }, FAIL = { phase: "idle", fail: { kind: "net" } };
    onState(DL); onState(DONE);
    ok("下載完成(非 idle → idle、沒有 fail)而且閒著 → 直接 detect()", ctx.calls.join() === "paint,detect" && ctx.PKG.redetect === false, ctx.calls);
    ctx.calls.length = 0; ctx.MDL.busy = true; onState(DL); onState(DONE);
    ok("…完成那一刻正在偵測(MDL.busy)→ 不疊一次偵測、記 PKG.redetect;進度也不重畫(偵測中的列不蓋掉)", ctx.calls.length === 0 && ctx.PKG.redetect === true, ctx.calls);
    ctx.MDL.busy = false; ctx.PKG.redetect = false; ctx.loginPending = "claude"; onState(DL); onState(DONE);
    ok("…完成那一刻在等登入 → 記 PKG.redetect", ctx.PKG.redetect === true && !ctx.calls.includes("detect"));
    ctx.loginPending = null; ctx.PKG.redetect = false; ctx.calls.length = 0; ctx.detectP = Promise.resolve(); onState(DL); onState(DONE); ctx.detectP = null;
    ok("…完成那一刻有一輪偵測在飛(回前景那種不立 MDL.busy)→ 記 PKG.redetect,不共用裝之前那一輪(稽核 v043-focus-redetect P2-1)", ctx.PKG.redetect === true && !ctx.calls.includes("detect"), ctx.calls);
    ctx.loginPending = null; ctx.PKG.redetect = false; ctx.calls.length = 0; onState(DL); onState(FAIL);
    ok("下載失敗(idle + fail)→ 不偵測,重畫列(寫原因、給〔再試一次〕)", ctx.calls.join() === "paint,paint" && !ctx.PKG.redetect, ctx.calls);
    ctx.calls.length = 0; box.btns[0].focus(); onState({ phase: "download", bytes: 5, total: 9, fail: null });
    ok("下載中重畫列(每 250 ms):焦點原本在 Claude 那列的鈕 → 畫完還在 Claude 那列(新的那顆鈕)", ctx.calls.join() === "paint" && doc.activeElement === box.btns[0] && doc.activeElement.kind === "claude", { calls: ctx.calls, focus: doc.activeElement && doc.activeElement.kind });
    doc.activeElement = null; onState({ phase: "download", bytes: 6, total: 9, fail: null });
    ok("…焦點不在列上 → 不搶焦點", doc.activeElement === null);
    ctx.calls.length = 0; ctx.PKG.snap = null; onState(undefined);
    ok("拉到的快照是 undefined(舊主行程／測試替身)→ snap 為 null、不偵測", ctx.PKG.snap === null && !ctx.calls.includes("detect")); }
  { // 按〔連結〕抓完接登入:原文跑 codexPkgGo／codexPkgOnState／codexAutoLogin,detect 用假的(接原文那一行)
    const mkA = (o = {}) => { const login = [], ensure = [], btnEl = { disabled: false };
      const panes = { "agent-rows": { querySelector: () => (o.noBtn ? null : btnEl) }, "set-model": { hidden: false, querySelector: () => btnEl }, "lai-rows": { querySelector: () => btnEl }, "view-connect": { hidden: !!o.closed }, "set-scrim": { hidden: false } };
      const ctx = { PKG: { snap: null, redetect: false, auto: null, done: false }, MDL: { busy: false }, detectP: null, loginPending: o.loginPending || null, oauthPending: false, lastDetect: null, whyState, laiOn: () => !o.closed,
        $: (id) => panes[id], localLogin: (k, b) => login.push(k), paintRows: () => {}, document: { activeElement: null },
        detect() { ctx.lastDetect = o.detected || { codex: { installed: true, loggedIn: false, why: "codex_nonzero" } }; if (ctx.PKG.auto) ctx.codexAutoLogin(); },
        window: { blave: { codexPkgEnsure: (a) => { ensure.push(a); return o.ensure || Promise.resolve({ ok: true }); } } } };
      const f = new Function("ctx", `with (ctx) { ${fn("codexPkgGo")}\n${fn("codexAutoLogin")}\n${fn("codexPkgOnState")}\nctx.codexAutoLogin = codexAutoLogin; return { go: codexPkgGo, on: codexPkgOnState }; }`)(ctx);
      return { ctx, login, ensure, f }; };
    const DL = { phase: "download", bytes: 1, total: 2, fail: null }, DONE = { phase: "idle", fail: null }, FAIL = { phase: "idle", fail: { kind: "net" } };
    const run = async (o, from, end = DONE) => { const m = mkA(o); m.f.go(false, from); await Promise.resolve(); m.f.on(DL); m.f.on(end); await Promise.resolve(); return m; };
    for (const box of ["agent-rows", "set-model", "lai-rows"]) { const m = await run({}, box); ok("按〔連結〕抓完、沒登入(" + box + ")→ 自動開登入,只一次", m.login.join() === "codex" && m.ctx.PKG.auto === null, m.login); }
    let m = await run({}, null);
    ok("背景補抓(沒有 from)→ 不接", m.login.length === 0, m.login);
    m = await run({ detected: { codex: { installed: true, loggedIn: true } } }, "agent-rows");
    ok("抓完已登入 → 不接", m.login.length === 0, m.login);
    m = await run({ detected: { codex: { installed: true, loggedIn: false, why: "codex_timeout", path: "/x" } } }, "agent-rows");
    ok("抓完查不出登入狀態 → 不接", m.login.length === 0, m.login);
    m = await run({ detected: { codex: { installed: true, loggedIn: false, why: "codex_cantrun" } } }, "agent-rows");
    ok("抓完跑不起來 → 不接", m.login.length === 0, m.login);
    m = await run({}, "agent-rows", FAIL);
    ok("下載失敗 → 不接,也不留著等下一次", m.login.length === 0 && m.ctx.PKG.auto === null, m.ctx.PKG);
    m.f.on(DL); m.f.on(DONE);
    ok("…之後別的下載完成也不接", m.login.length === 0, m.login);
    m.f.go(false, "agent-rows"); await Promise.resolve(); m.f.on(DL); m.f.on(DONE); await Promise.resolve();
    ok("失敗後用戶按〔再試一次〕、這次成功 → 接登入", m.login.join() === "codex", m.login);
    ok("…連結畫面那顆鈕不分〔連結〕〔再試一次〕都帶表面", /codexPkgGo\(pk\.reinstall, "agent-rows"\)/.test(fn("paintRows")));
    m = mkA(); m.f.go(true, "set-model"); await Promise.resolve(); m.f.on(DL); m.f.on(DONE); await Promise.resolve();
    ok("跑不起來按〔再試一次〕(reinstall)重抓成功、沒登入 → 接登入;ensure 帶 reinstall", m.login.join() === "codex" && m.ensure[0].reinstall === true, m.login);
    m = await run({ detected: { codex: { installed: true, loggedIn: true } } }, "set-model");
    ok("重抓成功、本來就登入 → 不接", m.login.length === 0, m.login);
    m = await run({}, "agent-rows", FAIL); m.f.go(false, "agent-rows"); await Promise.resolve(); m.f.on(DL); m.f.on(FAIL);
    ok("〔再試一次〕又失敗 → 不接、不自己重抓", m.login.length === 0 && m.ensure.length === 2 && m.ctx.PKG.auto === null, m.ctx.PKG);
    m = mkA({ ensure: Promise.resolve({ ok: false }) }); m.f.go(false, "agent-rows"); await Promise.resolve(); await Promise.resolve();
    ok("ensure 回 ok:false → 清掉", m.ctx.PKG.auto === null, m.ctx.PKG);
    m = mkA({ ensure: Promise.reject(new Error("x")) }); m.f.go(false, "agent-rows"); await Promise.resolve(); await Promise.resolve();
    ok("ensure reject → 清掉", m.ctx.PKG.auto === null, m.ctx.PKG);
    m = await run({ closed: true }, "agent-rows");
    ok("抓的途中離開那個表面 → 不接", m.login.length === 0, m.login);
    m = await run({ loginPending: "claude" }, "agent-rows");
    ok("別的登入等待中 → 不搶(補偵測排給 paintRows)", m.login.length === 0 && m.ctx.PKG.redetect === true, m.ctx.PKG);
    m = mkA(); m.f.go(false, "agent-rows"); m.f.on(DL); m.ctx.lastDetect = { codex: { installed: false } }; m.ctx.PKG.done = true; m.ctx.codexAutoLogin();
    ok("裝好之前開跑的偵測先回來(還沒裝)→ 不消耗這次機會", m.login.length === 0 && m.ctx.PKG.auto === "agent-rows", m.ctx.PKG); }
  { // paintRows 真的跑一次:不碰 PKG.redetect(補偵測在 detect() 收尾;偵測途中換語言、推快照的重畫不能用掉它,check_shell_focus_redetect ④b)
    const el = () => { const n = { children: [], innerHTML: "", appendChild: (c) => { n.children.push(c); return c; }, querySelectorAll: () => [] }; return n; };
    const rowsEl = el(), calls = [];
    const ctx = { PKG: { snap: null, redetect: true }, loginPending: null, MDL: { busy: true }, ROWMSG: { claude: null, codex: null }, cur: null, localReady: false,
      $: () => rowsEl, row: (o) => o, btn: () => ({}), t: (k) => k, paintBlaveBtn: () => {}, mdlPaint: () => calls.push("mdlPaint"), detect: () => calls.push("detect"),
      rowMsg: () => "", rowVars: () => ({}), connect: () => {}, localLogin: () => {}, codexPkgGo: () => {}, window: { blave: {} }, whyState, authUnknown };
    const paint = new Function("ctx", `with (ctx) { ${fn("codexPkgRow")}\n${fn("paintRows")}\nreturn paintRows; }`)(ctx);
    const D0 = { claude: { installed: false }, codex: { installed: false } };
    ctx.loginPending = "claude"; paint(D0); ctx.loginPending = null; paint(D0);
    ok("paintRows:等登入中、沒在等都不偵測、PKG.redetect 留著;收尾放開 MDL.busy、mdlPaint", ctx.PKG.redetect === true && !calls.includes("detect") && calls.join() === "mdlPaint,mdlPaint" && ctx.MDL.busy === false, calls);
    ok("…補偵測在 detect() 收尾(.finally),沒在等登入才補", /\.finally\([\s\S]*?if \(PKG\.redetect && !loginPending\) \{ PKG\.redetect = false; detect\(\); \}/.test(fn("detect")) && !/PKG\.redetect/.test(fn("paintRows")));
    ctx.PKG.snap = { phase: "idle", fail: null, size: 203 }; paint(D0);
    const cx = rowsEl.children.filter((r) => r.kind === "codex").pop();
    ok("paintRows:Codex 沒偵測到、有快照 → 那一列是下載列(說明 cn.pkgSize、有鈕),不是「未偵測到」", cx && cx.sub === "cn.pkgSize" && !!cx.action && cx.st === null, cx);
    ctx.PKG.snap = { phase: "idle", unsupported: "arch", fail: null }; paint(D0);
    const ax = rowsEl.children.filter((r) => r.kind === "codex").pop();
    ok("paintRows:架構不支援 → 說明 cn.pkgArch、沒有鈕、列灰,不是「未偵測到」", ax && ax.sub === "cn.pkgArch" && !ax.action && ax.st === null && ax.stClass === "", ax);
    ctx.PKG.snap = { phase: "idle", fail: null, size: 203 }; paint({ claude: { installed: false }, codex: { installed: true, loggedIn: false, why: "codex_cantrun" } });
    const bx = rowsEl.children.filter((r) => r.kind === "codex").pop();
    ok("paintRows:裝好、跑不起來(不帶 via)→ cn.pkgBad +〔再試一次〕", bx && bx.sub === "cn.pkgBad" && !!bx.action, bx);
    paint({ claude: { installed: false }, codex: { installed: true, loggedIn: false, why: "codex_timeout", via: "pkg" } });
    const tx = rowsEl.children.filter((r) => r.kind === "codex").pop();
    ok("paintRows:裝好、沒回應 → 「沒有回應」、沒有鈕", tx && tx.st === "st.noResp" && !tx.action, tx); }
  // ── 回合缺執行檔的兩碼都算 engine_missing(turn_failed 白名單不動)──
  { const tr = new Function(fn("turnReasonOf") + "\nreturn turnReasonOf;")();
    ok("turnReasonOf:AGENT_BIN_MISSING、AGENT_BIN_DOWNLOADING、AGENT_BIN_BROKEN 都是 engine_missing;沒有就照 fail", tr("x AGENT_BIN_MISSING", "auth") === "engine_missing" && tr("Error: AGENT_BIN_BROKEN", "auth") === "engine_missing" && tr("Error: AGENT_BIN_DOWNLOADING", "auth") === "engine_missing" && tr("", "auth") === "auth" && tr(undefined, null) === "other"); }
  { const src = fn("turnEventIn");
    ok("error chunk code=needs_login:直接畫 Codex 登入卡、turn_failed 記 auth、不再等回合結束(排在 pendingErr 之前)", /if \(c\.code === "needs_login" && !turnFaulted\) \{ turnFaulted = true; turnFail = "auth"; addFault\(localAuthFault\("codex"\)\); return; \}/.test(src) && src.indexOf("needs_login") < src.indexOf("pendingErr.push")); }
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
