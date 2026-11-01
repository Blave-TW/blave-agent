// Blave 自己畫、留在聊天欄的系統行(不是 agent 回覆、不是用戶打的字):
//   ① 安裝完成那一行「這台電腦準備好了 · {t}」只出現在安裝時正在看的那個分頁、只一行;開新分頁、切回原分頁都不重複
//   ② 選用套件沒裝好的卡(engWarn)同樣只在那一格、不跨分頁重複
//   ③ 換語言:列舉聊天欄裡每一個 Blave 畫的系統行(.msg.sys / .msg.fault / 安裝進度卡…),切到 en 後逐一斷言換過語言
// 用隨包 Electron 開真的 index.html(offscreen、不顯示),window.blave 換成假的。跑法:BLAVE_TEST_WINDOW=1 node tests/check_shell_sys_lines.js
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");

if (!process.versions.electron) {
  const bin = GATE.bin(SHELL);
  if (!bin) { process.exit(0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  process.exit(r.status == null ? 1 : r.status);
}
const { app, BrowserWindow } = require("electron");
const os = require("os");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-syslines-")));
const STUB = `window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" },
      telemetryGet: true, telemetryInstallId: "a3f9c2e1-7b04-4d6e-9e21-5c0b8d4f1a77" })[k] });`;
let red = 0; const ok = (n, c, why) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || !why ? "" : "  ← " + why)); if (!c) red++; };

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  const X = (s) => w.webContents.executeJavaScript(s, true), nap = (ms) => new Promise((r) => setTimeout(r, ms));
  await X(`(async () => { await (CS.boot || Promise.resolve()); })()`); await nap(800);
  const probe = await X(`JSON.stringify({ cur: !!CS.cur, loaded: !!CS.loaded, tabs: CS.tabs.size, rootKids: [...$("chat-scroll").children].map((n) => n.className) })`);
  console.log("boot " + probe);
  const SNAP = `const t0 = Date.now() - 15000, run = { show: true, kind: "first", phase: "run", sizeMB: 300, acc: 0, t0, steps: [{ k: "engine", st: "done", ms: 5000 }, { k: "pkgs", st: "run", ms: 0, t0: t0 + 5000 }], cur: { step: "pkgs", name: "pandas", t0: Date.now() }, dl: { done: 1e6 } };
    const done = (warn) => Object.assign({}, run, { phase: "done", tEnd: Date.now(), steps: run.steps.map((x) => Object.assign({}, x, { st: "done" })), warn: warn || null });`;
  const count = `const cnt = (T) => ({ ready: [...T.el.querySelectorAll(".msg.sys")].filter((n) => /eng\\.ready|準備好了|ready/i.test(n.textContent)).length, warn: [...T.el.querySelectorAll(".msg.fault")].length, card: T.el.querySelectorAll(".eng-card").length });
    const root = () => [...$("chat-scroll").children].filter((n) => !n.classList.contains("chat-thread")).map((n) => n.className);`;
  // 每個情境自己開一個乾淨分頁當「安裝時正在看的那一格」;pre = 完成那一刻還沒有分頁(CS.loaded 是 null,開機接回分頁之前)
  for (const [label, warn, pre] of [["① 分頁裡裝完", false, false], ["① 還沒接回分頁就裝完", false, true], ["② 美股那組沒裝好(分頁裡)", true, false], ["② 美股那組沒裝好(還沒接回分頁)", true, true]]) {
    const r = await X(`(async () => { ${SNAP} ${count} ENG.warned = false; ENG.card = null; if (ENG.sys) ENG.sys.length = 0;
      csStartNew({ force: true }); const A = CS.cur;
      if (${pre}) { A.el.hidden = true; CS.cur = null; CS.loaded = null; }
      engOnState(run); await new Promise((r) => setTimeout(r, 50));
      engOnState(done(${warn} ? { msg: "pip failed: yfinance" } : null)); await new Promise((r) => setTimeout(r, 600));
      const rootAtDone = root();
      if (${pre}) tabShow(A);
      await new Promise((r) => setTimeout(r, 50));
      const afterA = cnt(A); csStartNew({ force: true }); const B = CS.cur; const inB = cnt(B);
      tabShow(A); const backA = cnt(A); tabShow(B); const B2 = cnt(B);
      csStartNew({ force: true }); const C = CS.cur; const inC = cnt(C); tabShow(A); const A3 = cnt(A);
      return { rootAtDone, afterA, inB, backA, B2, inC, A3, root: root() }; })()`);
    const want = warn ? 1 : 0;
    ok(label + ":原分頁剛好一行「準備好了」" + (warn ? "、一張美股沒裝好的卡" : "") + ";新分頁、再開的分頁都沒有;切回原分頁還是剛好一份;不掛在所有分頁共用的 #chat-scroll 上",
      r.afterA.ready === 1 && r.afterA.card === 0 && r.afterA.warn === want && [r.inB, r.B2, r.inC].every((x) => x.ready === 0 && x.warn === 0) && r.backA.ready === 1 && r.backA.warn === want && r.A3.ready === 1 && r.A3.warn === want && r.root.length === 0,
      JSON.stringify(r));
  }
  // ③ 列舉:原始碼裡每一處畫聊天系統行／卡的地方(EMIT 表)都要有一個情境;新增一處、表沒跟上就紅
  const R = path.join(SHELL, "renderer"), srcOf = (f) => fs.readFileSync(path.join(R, f), "utf8");
  const sites = [];
  for (const f of fs.readdirSync(R).filter((x) => x.endsWith(".js") && x !== "strings.js")) {
    srcOf(f).split("\n").forEach((l) => { const code = l.replace(/\/\/.*$/, "");
      for (const m of code.matchAll(/addMsg\("sys", (?:t\([^)]*\)|\w+\(\)|\w+)|className = "msg sys"|(?<!function )sysLine\(([a-zA-Z]+)\)|faultCard\(\)\.set|(\w+) = faultCard\(\)/g)) sites.push(f + ": " + m[0]); }); }
  const EMIT = { "engine.js: className = \"msg sys\"": "engDone", "app.js: className = \"msg sys\"": "upSayLine", "app.js: sysLine(line)": "turn.error", "app.js: sysLine(exitLine)": "turn.exit", "app.js: sysLine(x)": "pendingErr",
    "app.js: addMsg(\"sys\", fn()": "sysLine", "app.js: addMsg(\"sys\", t(say)": "attach", "app.js: addMsg(\"sys\", t(\"ws.attachReadFail\")": "attachRead", "app.js: addMsg(\"sys\", t(\"turn.busy\")": "busy",
    "app.js: faultCard().set": "engineFailed／minv", "engine.js: c = faultCard()": "engWarn", "app.js: dataCard = faultCard()": "dataCard", "app.js: c = faultCard()": "plan.done", "app.js: acctCard = faultCard()": "acctCard", "app.js: card = faultCard()": "addFault" };
  const unknown = [...new Set(sites)].filter((x) => !EMIT[x]), gone = Object.keys(EMIT).filter((x) => !sites.includes(x));
  ok("③ 每一處畫聊天系統行／卡的原始碼都在 EMIT 表、都有情境(" + new Set(sites).size + " 處)", !unknown.length && !gone.length, JSON.stringify({ unknown, gone }));
  const bareSet = [];
  for (const f of ["app.js", "engine.js"]) srcOf(f).split("\n").forEach((l, i) => { if (/\b(card|acctCard|dataCard|c)\.set\(\{|faultCard\(\)\.set\(\{|\b(card|c)\.set\(resendState/.test(l.replace(/\/\/.*$/, ""))) bareSet.push(f + ":" + (i + 1)); });
  ok("③ 卡的內容一律經 sysLz 包起來(寫死字的 set 換語言不會跟著換)", !bareSet.length, JSON.stringify(bareSet));

  // 畫一輪:每一種系統行各一則,全在 zh;agent 回覆與用戶的字各一則當對照組
  const YOU = "用戶打的中文", AI = "agent 回的中文";
  const r3 = await X(`(async () => { ${SNAP} setLang("zh"); ENG.warned = false; ENG.card = null; ENG.sys.length = 0;
    csStartNew({ force: true }); const A = CS.cur;
    addMsg("you", ${JSON.stringify(YOU)}); addMsg("ai", ${JSON.stringify(AI)});
    const list = {};
    const mark = (k, el) => { el.dataset.sysCase = k; list[k] = 1; return el; };
    const lastOf = () => chatEl().lastElementChild;
    engOnState(run); await new Promise((r) => setTimeout(r, 30)); engOnState(done({ msg: "pip failed: yfinance" })); await new Promise((r) => setTimeout(r, 500));
    mark("engDone", [...A.el.querySelectorAll(".msg.sys")].pop()); mark("engWarn", [...A.el.querySelectorAll(".msg.fault")].pop());
    upSayLine({ head: ["up.done.cloud", { cv: "2026-11-01-b" }] }); mark("upSayLine", lastOf());
    mark("sysLine", sysLine(() => t("turn.error", { msg: "boom" })));
    mark("turn.exit", sysLine(() => t("turn.exit", { code: 3 }) + ": tail"));
    addMsg("sys", t("turn.busy")).dataset.i18n = "turn.busy"; mark("busy", lastOf());
    addMsg("sys", t("ws.attachReadFail")).dataset.i18n = "ws.attachReadFail"; mark("attachRead", lastOf());
    addMsg("sys", t("ws.attachTooMany")).dataset.i18n = "ws.attachTooMany"; mark("attach", lastOf());
    faultCard().set(sysLz(() => ({ text: t("turn.engineFailed", { msg: "x" }) }))); mark("engineFailed", lastOf());
    planDonePending = false; planSayDone(); mark("plan.done", lastOf());
    addFault({ flow: "local", kind: "claude" }); mark("addFault.local", lastOf());
    addFault({ flow: "blave" }); mark("addFault.blave", lastOf());
    acct = { can_run: false, reason: "NO_CARD" }; const was = cur; cur = "blave";
    addFault({ flow: "credit" }); mark("addFault.credit", lastOf());
    acct = { can_run: false, reason: "NO_CARD" }; acctCard = faultCard(); acctPaint(); mark("acctCard", acctCard.el);
    { const LIM = "You've hit your session limit"; const f = classifyFault(LIM); addFault(f || { text: t("fault.authInvalid") }, f ? () => classifyFault(LIM, { again: true }) : () => ({ text: t("fault.authInvalid") })); mark("addFault.text", lastOf()); }
    dataCard = faultCard(); dataCardSync({ can_run: true, data_access: "none" }); mark("dataCard", lastOf());
    addHistoryYou("手機來的", "mobile"); mark("fromPhone", lastOf());
    addHistoryAi("回覆\\n[中斷前已執行:Bash strategies/、Read lib/x.py、…另有 2 步]"); 
    const zh = {}; for (const k of Object.keys(list)) zh[k] = A.el.querySelector('[data-sys-case="' + k + '"]').textContent;
    applyLangChoice("en"); await new Promise((r) => setTimeout(r, 50));
    const CJK = /[\u4e00-\u9fff]/, strip = (s) => s.replace(/手機來的/g, ""), left = [], en = {};
    for (const k of Object.keys(list)) { const e = A.el.querySelector('[data-sys-case="' + k + '"]').cloneNode(true); e.querySelectorAll(".bubble").forEach((b) => b.remove()); en[k] = e.textContent; if (CJK.test(strip(e.textContent)) || !e.textContent.trim()) left.push(k + ": " + e.textContent.slice(0, 60)); }
    const walk = []; const tw = document.createTreeWalker(A.el, NodeFilter.SHOW_TEXT); let n;
    while ((n = tw.nextNode())) { if (!CJK.test(n.data) || n.parentElement.closest(".msg.ai, .msg.you .bubble")) continue; walk.push(n.data.slice(0, 40) + " @" + n.parentElement.className); }
    const you = [...A.el.querySelectorAll(".msg.you .bubble")].some((b) => b.textContent === ${JSON.stringify(YOU)}), ai = [...A.el.querySelectorAll(".msg.ai")].some((b) => b.textContent.includes(${JSON.stringify(AI)}));
    applyLangChoice("zh"); await new Promise((r) => setTimeout(r, 50));
    const back = Object.keys(list).filter((k) => A.el.querySelector('[data-sys-case="' + k + '"]').textContent !== zh[k]);
    cur = was; acctCard = null; creditCards = []; dataCard = null; acct = null;
    return { cases: Object.keys(list), left, walk, you, ai, back, sample: { engDone: en.engDone, engWarn: en.engWarn, turnExit: en["turn.exit"] } }; })()`);
  console.log("      ③ " + JSON.stringify(r3.sample));
  ok("③ 切到 en:" + r3.cases.length + " 種系統行／卡全換了語言", r3.cases.length >= 16 && !r3.left.length, JSON.stringify(r3.left));
  ok("③ 掃整格聊天的每個文字節點:除了 agent 回覆與用戶的字,沒有中文留下", !r3.walk.length, JSON.stringify(r3.walk));
  ok("③ agent 回覆與用戶打的字維持原文", r3.you && r3.ai);
  ok("③ 切回 zh 每一種都還原", !r3.back.length, JSON.stringify(r3.back));
  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + String((e && e.stack) || e).slice(0, 800)); app.exit(1); });
