// Blave 電腦版 — Electron 主行程(v1 骨架)
// 只做三件事:開視窗、偵測本機 agent(IPC)、記住使用者的連結選擇。
// 引擎 spawn 在第 4 步接,不在這裡。
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn } = require("child_process");
const { execFile } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

// macOS GUI app 的 PATH 是極簡的(實測 /usr/bin:/bin 下找不到 claude),
// 所以先跑一次使用者的登入 shell 解析出真正的 PATH,偵測與之後 spawn 引擎共用。
// 見 .claude/output/desktop-v1/2026-09-18-agent-detection.md。
let resolvedPath = null;
function loginShellPath() {
  return new Promise((resolve) => {
    if (resolvedPath) return resolve(resolvedPath);
    const sh = process.env.SHELL || "/bin/zsh";
    execFile(sh, ["-lc", "echo -n $PATH"], { timeout: 8000 }, (err, stdout) => {
      const fallback = [
        path.join(os.homedir(), ".local/bin"),
        "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
      ].join(":");
      resolvedPath = !err && stdout.trim() ? stdout.trim() : fallback;
      resolve(resolvedPath);
    });
  });
}

function run(cmd, args, envPath, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, env: { ...process.env, PATH: envPath } },
      (err, stdout, stderr) => resolve({
        code: err ? (err.code === undefined ? -1 : err.code) : 0,
        stdout: String(stdout || ""), stderr: String(stderr || ""),
      }));
  });
}

async function which(name, envPath) {
  const r = await run("/usr/bin/env", ["sh", "-c", `command -v ${name}`], envPath, 5000);
  return r.code === 0 ? r.stdout.trim() : null;
}

// 偵測結果契約(renderer 據此畫 a/b/c 三態):
// { claude: {installed, loggedIn, authMethod, email, path}, codex: {installed, loggedIn, path} }
async function detectAgents() {
  const envPath = await loginShellPath();
  const out = {
    claude: { installed: false, loggedIn: false, authMethod: null, email: null, path: null },
    codex: { installed: false, loggedIn: false, path: null },
  };
  const claudeBin = await which("claude", envPath);
  if (claudeBin) {
    out.claude.installed = true;
    out.claude.path = claudeBin;
    // 官方判定:`claude auth status` 非互動輸出 JSON,以 loggedIn 欄位為準
    const r = await run(claudeBin, ["auth", "status"], envPath);
    try {
      const j = JSON.parse(r.stdout);
      out.claude.loggedIn = !!j.loggedIn;
      out.claude.authMethod = j.authMethod || null;
      out.claude.email = j.email || null;
    } catch (_) { /* 舊版沒有這個子指令:當成未知,顯示成未登入 */ }
  }
  const codexBin = await which("codex", envPath);
  if (codexBin) {
    out.codex.installed = true;
    out.codex.path = codexBin;
    // 官方契約:`codex login status` 登入=0、未登入=1(原始碼 cli/src/login.rs:443)
    const r = await run(codexBin, ["login", "status"], envPath);
    out.codex.loggedIn = r.code === 0;
  }
  return out;
}

// v1:連結選擇只落在本機設定檔,引擎接線是第 4 步
const statePath = () => path.join(app.getPath("userData"), "connect.json");
function saveConnection(choice) {
  fs.writeFileSync(statePath(), JSON.stringify({ ...choice, at: new Date().toISOString() }));
  return true;
}
function loadConnection() {
  try { return JSON.parse(fs.readFileSync(statePath(), "utf8")); } catch (_) { return null; }
}

// ── 第 4 步:引擎 ─────────────────────────────────────────────
// dev 佈局:repo checkout 就在 shell/ 上一層;打包版之後改成 app 資源路徑。
const REPO = path.join(__dirname, "..");
const BASE = path.join(os.homedir(), "Blave");
const WS = path.join(BASE, "workspace");
const VENV_PY = path.join(BASE, "venv", "bin", "python");

function sh(cmd, envPath, timeout = 300000) {
  return new Promise((resolve, reject) => {
    execFile("/bin/sh", ["-c", cmd], { timeout, env: { ...process.env, PATH: envPath } },
      (err, stdout, stderr) => err ? reject(new Error(String(stderr || err))) : resolve(String(stdout)));
  });
}

// 首次連結時準備 ~/Blave:workspace 逐目錄從 repo 拷(照 README 的 merge 清單),
// venv 裝 pinned SDK。冪等:存在就跳過。進度用 callback 丟回聊天欄。
async function ensureEngine(progress) {
  const envPath = await loginShellPath();
  if (!fs.existsSync(WS)) {
    progress("建立工作區 ~/Blave/workspace …");
    fs.mkdirSync(WS, { recursive: true });
    for (const d of ["lib", "manager", "references", "examples"])
      fs.cpSync(path.join(REPO, d), path.join(WS, d), { recursive: true });
    fs.mkdirSync(path.join(WS, "strategies"), { recursive: true });
    for (const f of ["strategies/TEMPLATE_A.py", "strategies/TEMPLATE_C.py", "AGENTS.md", "CLAUDE.md", "VERSION"])
      fs.cpSync(path.join(REPO, f), path.join(WS, f));
  }
  for (const d of ["state", "config"]) fs.mkdirSync(path.join(BASE, d), { recursive: true });
  if (!fs.existsSync(VENV_PY)) {
    progress("準備引擎環境(首次,約一分鐘)…");
    await sh(`python3 -m venv "${path.join(BASE, "venv")}"`, envPath);
    await sh(`"${VENV_PY}" -m pip -q install claude-agent-sdk==0.2.144`, envPath, 600000);
  }
}

let activeTurn = null;
async function runTurn(win, { sessionId, message, model }) {
  const envPath = await loginShellPath();
  // 本機模式契約(runtime CHANGELOG Unreleased):不帶 BLAVE_PROXY_TOKEN、
  // 不帶 ANTHROPIC_*;PATH/HOME 必帶(GUI app 的 PATH 極簡)。
  const env = {
    PATH: envPath, HOME: os.homedir(),
    // Keychain/暫存都認人:少了 USER,claude CLI 會回「Not logged in」(實測 repro-2/3)
    USER: process.env.USER || os.userInfo().username,
    LOGNAME: process.env.LOGNAME || os.userInfo().username,
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    BLAVE_AGENT_BASE: BASE, BLAVE_AGENT_WORKSPACE: WS, BLAVE_AGENT_HOME: BASE,
    BLAVE_AGENT_STATE: path.join(BASE, "state"),
    BLAVE_AGENT_DB: path.join(BASE, "state", "session.db"),
    LANG: process.env.LANG || "zh_TW.UTF-8",
  };
  const child = spawn(VENV_PY, [
    path.join(REPO, "runtime", "agent_turn.py"),
    sessionId, message, "--delivery", "local", "--model", model || "sonnet",
  ], { env, cwd: WS });
  activeTurn = child;
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.startsWith("@@BLAVE@@")) {
        try { win.webContents.send("turn-event", JSON.parse(line.slice(9))); } catch (_) {}
      }
    }
  });
  let errTail = "";
  child.stderr.on("data", (d) => { errTail = (errTail + d.toString()).slice(-2000); });
  child.on("close", (code) => {
    activeTurn = null;
    win.webContents.send("turn-end", { code, errTail: code === 0 ? "" : errTail });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1024, minHeight: 680,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#10151c",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  ipcMain.handle("detect-agents", () => detectAgents());
  ipcMain.handle("save-connection", (_e, choice) => saveConnection(choice));
  ipcMain.handle("load-connection", () => loadConnection());
  ipcMain.handle("open-external", (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle("ensure-engine", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return ensureEngine((t) => win.webContents.send("engine-progress", t));
  });
  ipcMain.handle("send-message", (e, payload) => {
    if (activeTurn) return { busy: true };
    const win = BrowserWindow.fromWebContents(e.sender);
    runTurn(win, payload);
    return { started: true };
  });
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => app.quit());
