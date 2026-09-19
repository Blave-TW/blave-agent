// Blave 電腦版 — Electron 主行程(v1 骨架)
// 只做三件事:開視窗、偵測本機 agent(IPC)、記住使用者的連結選擇。
// 引擎 spawn 在第 4 步接,不在這裡。
const { app, BrowserWindow, ipcMain, shell, safeStorage } = require("electron");
const http = require("http");
const crypto = require("crypto");
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
function clearConnection() {
  try { fs.unlinkSync(statePath()); } catch (_) {}
  return true;
}
function loadConnection() {
  try { return JSON.parse(fs.readFileSync(statePath(), "utf8")); } catch (_) { return null; }
}

// ── OAuth(用 Blave 的 AI)─────────────────────────────────────
// RFC 8252 原生 app 的 loopback 流程:軟體開源所以沒有 client secret,
// 用 PKCE(S256)。同意頁在 blave.org,換 token 打 api.blave.org。
const WEB_BASE = "https://blave.org";
const API_BASE = "https://api.blave.org";
const CLIENT_ID = "blave-desktop";
const tokenPath = () => path.join(app.getPath("userData"), "blave-token.bin");

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// token 存 Keychain(safeStorage 背後就是它)。拿不到加密能力時不落地——
// 寧可每次重新授權,也不要在開源軟體裡留一個明文的計費憑證。
function saveToken(tok) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  fs.writeFileSync(tokenPath(), safeStorage.encryptString(tok), { mode: 0o600 });
  return true;
}
function loadToken() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(fs.readFileSync(tokenPath()));
  } catch (_) { return null; }
}
function clearToken() {
  try { fs.unlinkSync(tokenPath()); } catch (_) {}
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = require("https").request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: 20000,
    }, (res) => {
      let buf = "";
      res.on("data", (d) => { buf += d; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf || "{}") }); }
        catch (_) { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(data);
  });
}

// 主行程一律丟**穩定代號**(OAUTH_TIMEOUT / KEYCHAIN_UNAVAILABLE / …),不丟句子:
// IPC 只搬得動 message,而句子有語言。renderer 拿代號去 strings.js 查當下語系的字。
// 換 token 那支刻意不把 api 的 error_description 往外送——那是給開發者看的英文。

// 等待瀏覽器那段可以被取消(用戶關掉分頁就沒人會按「允許」,按鈕不能卡在那裡)。
let pendingOAuth = null;

function cancelOAuth() {
  if (!pendingOAuth) return false;
  const p = pendingOAuth;
  pendingOAuth = null;
  p.abort();
  return true;
}

async function startOAuth(lang) {
  cancelOAuth();
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  // 先把 server 起好才知道 port —— redirect_uri 要帶進同意頁
  const server = http.createServer();
  await new Promise((ok, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", ok);
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.close(); reject(new Error("OAUTH_TIMEOUT")); }, 300000);
    // 取消與逾時走同一個出口:關掉 server、清掉計時器,錯誤碼讓 renderer 認得出
    // 「這是我自己按的」,不要畫成失敗。
    pendingOAuth = {
      abort: () => {
        clearTimeout(timer); server.close();
        // 記號寫在 message 裡:IPC 只搬得動 message,自訂欄位到不了 renderer。
        reject(new Error("OAUTH_CANCELLED"));
      },
    };
    server.on("request", (req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
      res.writeHead(204); res.end();
      clearTimeout(timer);
      server.close();
      pendingOAuth = null;
      if (u.searchParams.get("state") !== state) return reject(new Error("OAUTH_STATE_MISMATCH"));
      const err = u.searchParams.get("error");
      if (err) return reject(new Error(err === "access_denied" ? "OAUTH_DENIED" : err));
      const c = u.searchParams.get("code");
      c ? resolve(c) : reject(new Error("OAUTH_NO_CODE"));
    });
    const q = new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: redirectUri,
      code_challenge: challenge, code_challenge_method: "S256", state,
      device_label: os.hostname().replace(/\.local$/, "").slice(0, 64),
    });
    const authUrl = `${WEB_BASE}/desktop/${lang || "zh"}/authorize?${q}`;
    // 開發時把網址印出來(challenge / state 本來就是公開值,verifier 不在裡面):
    // 授權頁一出問題,沒有這行就只能從瀏覽器網址列抄 43 字的 challenge。
    if (!app.isPackaged) console.log("[oauth] " + authUrl);
    shell.openExternal(authUrl);
  });

  const r = await postJSON(`${API_BASE}/oauth/desktop/token`, {
    grant_type: "authorization_code", client_id: CLIENT_ID,
    code, code_verifier: verifier, redirect_uri: redirectUri,
  });
  if (r.status !== 200 || !r.body.access_token) {
    throw new Error("TOKEN_EXCHANGE_FAILED");
  }
  if (!saveToken(r.body.access_token)) {
    throw new Error("KEYCHAIN_UNAVAILABLE");
  }
  // 授權是在瀏覽器完成的,焦點還在那邊 —— 自己回到前景,不要讓用戶去找視窗。
  app.focus({ steal: true });
  return { ok: true };
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
// 官方檔案清單 = README 的 "Updating an existing workspace" 那張表。
// 只覆寫這些;strategies/<name>/、state/、.env、cache/ 一律不碰,而且用 cpSync
// (覆寫但不刪除)——agent 可以合法新增 lib/order_<新交易所>.py 這種用戶自己的
// 整合(updating.md:「reference clone 裡不存在的那些完全不碰」),不能被清掉。
const OFFICIAL_DIRS = ["lib", "manager", "references", "examples"];
const OFFICIAL_FILES = [
  "strategies/TEMPLATE_A.py", "strategies/TEMPLATE_C.py",
  "AGENTS.md", "CLAUDE.md", "VERSION",
];
function copyOfficial() {
  fs.mkdirSync(path.join(WS, "strategies"), { recursive: true });
  for (const d of OFFICIAL_DIRS)
    fs.cpSync(path.join(REPO, d), path.join(WS, d), { recursive: true });
  for (const f of OFFICIAL_FILES) fs.cpSync(path.join(REPO, f), path.join(WS, f));
}

async function ensureEngine(progress) {
  const envPath = await loginShellPath();
  const fresh = !fs.existsSync(WS);
  if (fresh) {
    progress("engine.workspace");
    fs.mkdirSync(WS, { recursive: true });
    copyOfficial();
  } else if (!app.isPackaged) {
    // 開發時(從原始碼跑,不是打包版)每次啟動都把官方檔案重拷一次,所以改了
    // lib/ 或 AGENTS.md 只要重啟就生效。打包版不走這條:它照版本比對更新。
    copyOfficial();
  }
  for (const d of ["state", "config"]) fs.mkdirSync(path.join(BASE, d), { recursive: true });
  if (!fs.existsSync(VENV_PY)) {
    progress("engine.preparing");
    await sh(`python3 -m venv "${path.join(BASE, "venv")}"`, envPath);
    await sh(`"${VENV_PY}" -m pip -q install claude-agent-sdk==0.2.144`, envPath, 600000);
  }
}

let activeTurn = null;
async function runTurn(win, { sessionId, message, model, uiLang }) {
  const envPath = await loginShellPath();
  // 本機模式契約(runtime CHANGELOG Unreleased):不帶 BLAVE_PROXY_TOKEN、
  // 不帶 ANTHROPIC_*;PATH/HOME 必帶(GUI app 的 PATH 極簡)。
  const acct = loadToken();
  const env = {
    PATH: envPath, HOME: os.homedir(),
    // 有帳號 token = 用 Blave 的 AI:runtime 照舊送 proxy-{BLAVE_PROXY_TOKEN},
    // 自然變成 proxy-acct-…,runtime 一行都不用改。沒有就什麼都不設,
    // runtime 的本機分支會把 ANTHROPIC_* 拔掉、用戶自己的 CLI 登入生效。
    ...(acct ? { BLAVE_PROXY_TOKEN: acct } : {}),
    // Keychain/暫存都認人:少了 USER,claude CLI 會回「Not logged in」(實測 repro-2/3)
    USER: process.env.USER || os.userInfo().username,
    LOGNAME: process.env.LOGNAME || os.userInfo().username,
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    BLAVE_AGENT_BASE: BASE, BLAVE_AGENT_WORKSPACE: WS, BLAVE_AGENT_HOME: BASE,
    BLAVE_AGENT_STATE: path.join(BASE, "state"),
    BLAVE_AGENT_DB: path.join(BASE, "state", "session.db"),
    // K 線走 Binance 公開 API(桌面版沒有 Blave 資料訂閱)。獨立、明確 opt-in 的
    // 變數,不用「有沒有 BLAVE_PROXY_TOKEN」推論——機隊上的 cron/manager 不一定
    // 帶著那顆 token,推論錯就是整支機隊無聲換資料源。
    BLAVE_KLINE_SOURCE: "binance",
    LANG: process.env.LANG || "zh_TW.UTF-8",
  };
  const child = spawn(VENV_PY, [
    path.join(REPO, "runtime", "agent_turn.py"),
    sessionId, message, "--delivery", "local", "--model", model || "sonnet",
    // agent 回覆語言跟著介面走。runtime 的順序是「機器設定 > ui_lang > 猜」,
    // 桌面版沒有機器設定,所以這個值就是結論。
    ...(uiLang ? ["--ui-lang", uiLang] : []),
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
  // app.getLocale() 是**系統**語系(macOS 偏好設定),不吃 LANG 環境變數。
  // BLAVE_LANG 是覆蓋用的:開發要看英文版、或用戶的系統是中文但想用英文介面。
  ipcMain.handle("get-locale", () => process.env.BLAVE_LANG || app.getLocale());
  ipcMain.handle("start-oauth", (_e, lang) => startOAuth(lang));
  ipcMain.handle("cancel-oauth", () => cancelOAuth());
  ipcMain.handle("clear-connection", () => clearConnection());
  ipcMain.handle("has-blave-token", () => !!loadToken());
  ipcMain.handle("clear-blave-token", () => { clearToken(); return true; });
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
