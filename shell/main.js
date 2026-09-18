// Blave 電腦版 — Electron 主行程(v1 骨架)
// 只做三件事:開視窗、偵測本機 agent(IPC)、記住使用者的連結選擇。
// 引擎 spawn 在第 4 步接,不在這裡。
const { app, BrowserWindow, ipcMain, shell } = require("electron");
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
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => app.quit());
