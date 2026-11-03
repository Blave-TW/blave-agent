// 電腦版 UI 修正第二批(spec desktop-ui-fixes-2026-11-02 第 3、4 條,Wei 拍板):雲端沒開好停用輸入框、不插切換行;詳情點側欄先回列表。
// 跑法:node tests/check_shell_ui_fixes_044b.js(純 node);BLAVE_TEST_WINDOW=1 另跑隱藏視窗那段
const fs = require("fs"), path = require("path");
const GATE = require("./_electron_gate");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
let red = 0; const ok = (name, c, info) => { console.log((c ? "PASS  " : "FAIL  ") + name + (c || info === undefined ? "" : "\n      " + info)); if (!c) red++; };
const J = JSON.stringify;

if (!process.versions.electron) {
  const po = (l) => fs.readFileSync(path.join(SHELL, "i18n", l + ".po"), "utf8");
  ok("字逐字", po("zh").includes('msgid "chat.ph.cloudGate"\nmsgstr "雲端主機開好後才能在這裡下指示"') && po("zh").includes('msgid "chat.ph.cloudUnreach"\nmsgstr "連不上雲端主機"')
    && po("en").includes('msgid "chat.ph.cloudGate"\nmsgstr "Set up the cloud machine to send it instructions"') && po("en").includes('msgid "chat.ph.cloudUnreach"\nmsgstr "Can’t reach the cloud machine"'));
  const bin = GATE.bin(SHELL, "輸入框、切換行、側欄");
  if (bin) { const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: process.env, cwd: SHELL }); if (r.status !== 0) red++; }
  if (red) { console.log(red + " 紅"); process.exit(1); }
  console.log("全綠");
} else {
  const { app, BrowserWindow } = require("electron"), os = require("os");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-ui044b-")));
  const STUB = `window.__over = {}; window.__calls = [];
window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : async (...a) => { window.__calls.push([k, a]); if (k in window.__over) return window.__over[k](...a);
      return ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
        listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" } })[k]; } });`;
  app.whenReady().then(async () => {
    setTimeout(() => { console.log("FAIL  逾時(60 秒內沒跑完)"); app.exit(1); }, 60000).unref();
    const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
    const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
    await w.loadFile(path.join(R, "index.html")); await new Promise((r) => setTimeout(r, 1200));
    const js = (s) => w.webContents.executeJavaScript(s, true);
    await js(`trPollSoon = () => {}; trPoll = async () => {}; $("view-ws").hidden = false; 0`);
    const setCloud = (c) => `TR_BAGS.cloud.st = { alive: true, cloud: ${J(c)}, report: {} };`;
    const STATES = { signedOut: { code: "NO_LOGIN" }, none: { code: "OK", machine: { state: "none" } }, starting: { code: "OK", machine: { state: "starting" } }, unreach: { code: "NET" }, loading: {} };
    const look = `({ dis: $("ta").disabled, send: $("btn-send").disabled, ph: $("ta").placeholder, desc: $("ta").getAttribute("aria-describedby"), val: $("ta").value })`;
    const T = (k) => js(`t(${J(k)})`);

    // ── §3 ──
    for (const [k, c] of Object.entries(STATES)) {
      const v = await js(`(() => { ENV.cur = "cloud"; ${setCloud(c)} running = false; $("ta").value = "還沒打完"; envPaint(); return ${look}; })()`);
      const want = k === "unreach" ? "chat.ph.cloudUnreach" : k === "loading" ? "chat.ph.cloud" : "chat.ph.cloudGate";
      ok("§3 " + k + ":輸入框、送出鈕停用,placeholder " + want + ",describedby 開通卡標題,字留著", v.dis && v.send && v.ph === (await T(want)) && v.desc === "cv-h" && v.val === "還沒打完", J(v));
    }
    let v = await js(`(() => { const b = $("btn-send"); b.style.transition = "none"; const cs = getComputedStyle(b), root = getComputedStyle(document.documentElement), c = document.createElement("div"); c.style.cssText = "background: var(--surface-muted); color: var(--ink-3); border: 1px solid var(--color-greyMedium)"; document.body.appendChild(c); const w = getComputedStyle(c), o = { dis: b.disabled, op: cs.opacity, bg: cs.backgroundColor === w.backgroundColor, fg: cs.color === w.color, bd: cs.borderTopColor === w.borderTopColor && cs.borderTopWidth === "1px", cur: cs.cursor, w: b.offsetWidth }; c.remove(); b.style.transition = ""; return o; })()`);
    ok("§3 送出鈕停用:不用 opacity,同 .btn-fill:disabled 的灰階;尺寸不變(稽核 B5)", v.dis && v.op === "1" && v.bg && v.fg && v.bd && v.cur === "not-allowed" && v.w === 32, J(v));
    v = await js(`(() => { ENV.cur = "local"; envPaint(); return ${look}; })()`);
    ok("§3 切回這台電腦:恢復、字還在、placeholder 回本機", !v.dis && !v.send && v.val === "還沒打完" && v.ph === (await T("ws.placeholder")) && v.desc === null, J(v));
    v = await js(`(() => { ENV.cur = "cloud"; ${setCloud(STATES.none)} envPaint(); running = true; sendBtnSync(); const o = ${look}; running = false; sendBtnSync(); o.after = $("btn-send").disabled; return o; })()`);
    ok("§3 這台電腦有回合在跑時切到雲端:輸入框停用,停止鈕能按", v.dis && !v.send && v.after, J(v));
    for (const st of ["running", "stopped"]) {
      v = await js(`(() => { ENV.cur = "cloud"; ${setCloud({ code: "OK", machine: { state: st } })} envPaint(); return ${look}; })()`);
      ok("§3 主機 " + st + ":輸入框恢復、placeholder 回 chat.ph.cloud", !v.dis && !v.send && v.ph === (await T("chat.ph.cloud")) && v.desc === null, J(v));
    }
    v = await js(`(async () => { ENV.cur = "cloud"; ${setCloud(STATES.none)} envPaint(); window.__calls.length = 0; const box = chatEl(), n = box.children.length; const r = await submitMessage("問一句", {}); $("ta").value = "還在"; await sendDraft(); return { r, value: $("ta").value, started: window.__calls.filter((c) => /turn|send/i.test(c[0])).length, added: box.children.length - n, running }; })()`);
    ok("§3 重送等不經輸入框的入口也不跑一輪;sendDraft 不吃字", v.r === false && v.value === "還在" && v.started === 0 && v.added === 0 && !v.running, J(v));

    // 引擎重試撞到擋送:句子還等著,泡泡不孤兒(稽核 B6)
    v = await js(`(async () => { ENV.cur = "cloud"; ${setCloud(STATES.none)} envPaint(); running = false; const bub = document.createElement("div"); chatEl().appendChild(bub); ENG.held = { msg: "等引擎的那句", opts: {}, bubble: bub, sessionId }; window.__calls.length = 0; engRetry(); await new Promise((r) => setTimeout(r, 30)); const o = { held: !!ENG.held, conn: bub.isConnected, ens: window.__calls.filter((c) => c[0] === "ensureEngine").length }; ENG.held = null; bub.remove(); ENV.cur = "local"; envPaint(); return o; })()`);
    ok("§3 引擎卡重試時雲端沒開好:句子留著等、泡泡留著、只重裝引擎", v.held && v.conn && v.ens === 1, J(v));

    // 切換行
    const lines = `[...chatEl().querySelectorAll(".sysline")].filter((x) => /^chat\\.sw\\./.test(x.dataset.i18n || "")).length`;
    v = await js(`(() => { const box = chatEl(); box.textContent = ""; swLine = null; swHeld = null; running = false; const m = document.createElement("div"); m.className = "msg you"; box.appendChild(m); ${setCloud(STATES.none)}
      for (let i = 0; i < 5; i++) { ENV.cur = "cloud"; chatSwitched("local", "cloud"); ENV.cur = "local"; chatSwitched("cloud", "local"); } return ${lines}; })()`);
    ok("§3 沒主機來回切 5 次:一條切換行都沒有", v === 0, v);
    v = await js(`(() => { ${setCloud({ code: "OK", machine: { state: "running" } })} for (let i = 0; i < 5; i++) { ENV.cur = "cloud"; chatSwitched("local", "cloud"); const b = document.createElement("div"); b.className = "busy-row"; chatEl().appendChild(b); ENV.cur = "local"; chatSwitched("cloud", "local"); } return ${lines}; })()`);
    ok("§3 有主機來回切 5 次、中間插了非泡泡節點:最多一條", v === 1, v);
    v = await js(`(() => { const m = document.createElement("div"); m.className = "msg ai"; chatEl().appendChild(m); ENV.cur = "cloud"; chatSwitched("local", "cloud"); return ${lines}; })()`);
    ok("§3 舊行後面有新對話泡泡:舊行留著、再加一條", v === 2, v);
    await js(`chatEl().textContent = ""; swLine = null; ENV.cur = "local"; envPaint(); 0`);

    // ── §4 ──
    const libS = `(() => ({ open: libBag().open, detail: libBag().detail, lib: !$("lib").hidden, main: !$("main-empty").hidden, focus: document.activeElement && document.activeElement.dataset.id }))()`;
    v = await js(`(async () => { const leave = window.__l = []; envCanSwitch = () => true; envShowMain(); const B = libBag(); B.open = true; B.detail = "7"; B.row = "7"; libPaint = () => leave.push("paint"); const nav = $("lib-nav"); nav.click(); const a = { detail: B.detail, open: B.open, paint: leave.length }; nav.click(); const b = { open: B.open }; B.detail = "7"; await libOpen(); const c = { detail: B.detail, open: B.open }; B.detail = "7"; B.open = false; await libOpen({ silent: true }); const d = { detail: B.detail }; libLeave(); return { a, b, c, d }; })()`);
    ok("§4 策略庫:詳情點側欄 = 回列表、還開著;列表再點 = 回歡迎頁;再進來落列表;歡迎頁卡(silent)照舊留詳情", v.a.detail === null && v.a.open === true && v.a.paint === 1 && v.b.open === false && v.c.detail === null && v.c.open === true && v.d.detail === "7", J(v));
    v = await js(`(async () => { const B = rptBag(); B.open = true; B.reading = "r1"; B.row = "r1"; RPT.data.local = [{ id: "r1", title: "A", created_at: 1 }]; rptFetch = async () => {}; const nav = $("rpt-nav"); nav.click(); const a = { reading: B.reading, open: B.open }; nav.click(); const b = { open: B.open }; B.reading = "r1"; await rptOpen(); const c = { reading: B.reading, open: B.open }; rptLeave(); return { a, b, c }; })()`);
    ok("§4 報告:閱讀層點側欄 = 回清單;清單再點 = 回歡迎頁;再進來落清單", v.a.reading === null && v.a.open === true && v.b.open === false && v.c.reading === null && v.c.open === true, J(v));
    v = await js(`(() => { const B = libBag(); B.open = true; B.detail = "7"; const keep = BR.exp, kb = BR.bw; let col = 0; brCollapse = () => col++; BR.exp = { mode: "one" }; BR.bw = { hidden: false }; $("lib-nav").click(); const o = { col, detail: B.detail, open: B.open }; BR.exp = keep; BR.bw = kb; B.detail = null; libLeave(); return o; })()`);
    ok("§4 展開層蓋著:只收展開層,詳情不動", v.col === 1 && v.detail === "7" && v.open === true, J(v));

    console.log(red ? red + " 紅(Electron 段)" : "Electron 段全綠");
    app.exit(red ? 1 : 0);
  }).catch((e) => { console.log("FAIL  " + (e && e.stack || e)); app.exit(1); });
}
