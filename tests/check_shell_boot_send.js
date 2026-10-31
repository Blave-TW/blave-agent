// 開 app 就送出(0.1.37 對話分頁):enterWorkspace → csInit → tabsRestore 還在讀分頁記憶時送出的那句,
// 要等分頁接回才送、落在接回的那條分頁裡;不能丟、不能出「引擎準備失敗」。
// 替身的 IPC 都在 microtask 就回來,boot 會比 parser 跑完 chattabs.js 還早到 enterWorkspace——這支同時守 boot 等 DOMContentLoaded 那一行。
// 跑法:BLAVE_TEST_WINDOW=1 node tests/check_shell_boot_send.js(沒設就 SKIP)
const fs = require("fs"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + JSON.stringify(d))); if (!c) red++; };

if (!process.versions.electron) {
  const bin = GATE.bin(SHELL, "開機送出");
  if (!bin) { console.log("\nALL PASS"); process.exit(0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  process.exit(r.status === 0 ? 0 : 1);
} else {
const { app, BrowserWindow } = require("electron");
const os = require("os");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-boot-send-")));
const STUB = `window.__b = { sent: [], prefsCalls: 0, release: null };
const __fixed = {
  getLocale: async () => "zh-TW", hasBlaveToken: async () => false, loadConnection: async () => ({ kind: "claude" }),
  detectAgents: async () => ({ claude: { installed: true, loggedIn: true }, codex: { installed: false } }),
  tabsPrefs: () => { window.__b.prefsCalls++; return new Promise((res) => { window.__b.release = () => res(null); }); },
  listSessions: async () => [], loadSession: async () => [], loadSessionImages: async () => [], listStrategies: async () => [],
  updateState: async () => ({ phase: "idle", current: "0.0.0" }), ensureEngine: async () => ({}),
  sendMessage: async (p) => { window.__b.sent.push(p); return { started: true }; },
};
window.blave = new Proxy(__fixed, { get: (o, k) => (k in o ? o[k] : typeof k !== "string" ? undefined : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {} : async () => undefined) });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  逾時(60 秒)"); process.exit(1); }, 60000).unref();

app.whenReady().then(async () => {
  const preload = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(preload, STUB);
  const w = new BrowserWindow({ width: 1024, height: 760, show: false, webPreferences: { offscreen: true, preload, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(600);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const errs = `[...document.querySelectorAll("#chat-scroll .msg.sys, #chat-scroll .msg.fault")].map((e) => e.textContent)`;

  let r = await js(`({ ws: !document.getElementById("view-ws").hidden, prefs: window.__b.prefsCalls, loaded: !!CS.loaded, boot: !!CS.boot, booted: CS_BOOTED })`);
  ok("進了工作頁、tabsRestore 停在讀分頁記憶(CS.loaded 還沒有)、CS.boot 掛著", r.ws && r.prefs === 1 && !r.loaded && r.boot && !r.booted, r);

  r = await js(`(async () => { window.__p = submitMessage("開機就送的這一句", { typed: true }); window.__p.then((v) => { window.__done = v; }); await new Promise((res) => setTimeout(res, 100));
    return { sent: window.__b.sent.length, errs: ${errs}, running, done: window.__done === undefined ? "pending" : window.__done }; })()`);
  ok("分頁接回之前:還沒送、沒有錯誤行／失敗卡、沒先翻成回合中", r.sent === 0 && r.errs.length === 0 && r.running === false && r.done === "pending", r);

  r = await js(`(async () => { if (window.__b.release) window.__b.release(); await new Promise((res) => setTimeout(res, 300));
    const msgs = !CS.loaded ? [] : [...CS.loaded.el.querySelectorAll(".msg")].map((e) => e.className + ":" + e.textContent);
    const stray = [...document.getElementById("chat-scroll").children].filter((e) => e.classList.contains("msg")).length;
    return { tabs: CS.tabs.size, booted: CS_BOOTED, sent: window.__b.sent.map((p) => [p.message, p.sessionId === (CS.loaded && CS.loaded.sid)]), done: window.__done, msgs, stray, errs: ${errs} }; })()`);
  ok("接回之後:送出一次、逐字、帶接回那條分頁的 sessionId;submitMessage 回 true", r.booted && r.tabs === 1 && r.sent.length === 1 && r.sent[0][0] === "開機就送的這一句" && r.sent[0][1] === true && r.done === true, r);
  ok("泡泡在接回那條分頁的容器裡(不是裸的 #chat-scroll)、仍然沒有錯誤行／失敗卡", r.msgs.some((m) => /開機就送的這一句/.test(m)) && r.stray === 0 && r.errs.length === 0, r);

  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
}
