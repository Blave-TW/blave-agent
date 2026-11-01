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
  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
