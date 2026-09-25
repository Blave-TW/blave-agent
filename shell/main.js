// Blave 電腦版 — Electron 主行程(v1 骨架)
// 只做三件事:開視窗、偵測本機 agent(IPC)、記住使用者的連結選擇。
// 引擎 spawn 在第 4 步接,不在這裡。
const { app, BrowserWindow, ipcMain, shell, safeStorage, Tray, Menu, Notification, dialog, nativeImage } = require("electron");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { execFile } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { createDaemonHost } = require("./daemon.js");

// 打包版的名字 = userData 目錄名(~/Library/Application Support/Blave)與 Keychain 項目名。
// electron-builder 的 productName 不會寫進 asar 裡的 package.json,不設的話打包版會跟開發版
// 共用 blave-desktop(連 single-instance lock 都撞在一起)。開發版刻意不改名:既有資料留在原地。
if (app.isPackaged) app.setName("Blave");
// Windows:NSIS 裝的 app 要有 AppUserModelId(= appId)系統通知才會出 toast;沒有這行 Notification 一則都不顯示
if (process.platform === "win32") app.setAppUserModelId("org.blave.desktop");

// 發佈版(npm run release 在 package.json 蓋 blaveRelease)拒絕 Chromium 的遠端除錯開關。fuses 只關得掉
// Node 那一側(--inspect、RUN_AS_NODE、NODE_OPTIONS);--remote-debugging-port 不歸 fuses 管(實測翻完
// 仍然開著),而接上它就等於拿到 renderer、能呼叫 preload 開出去的每一個 IPC。pack 產物不擋,測試要用。
if (app.isPackaged && require("./package.json").blaveRelease
    && ["remote-debugging-port", "remote-debugging-pipe"].some((f) => app.commandLine.hasSwitch(f))) app.exit(1);

// macOS GUI app 的 PATH 是極簡的(實測 /usr/bin:/bin 下找不到 claude),
// 所以先跑一次使用者的登入 shell 解析出真正的 PATH,偵測與之後 spawn 引擎共用。
// 見 .claude/output/desktop-v1/2026-09-18-agent-detection.md。
let resolvedPath = null;
const mergePath = (got, known, sep = path.delimiter) => got.concat(known.filter((d) => got.indexOf(d) < 0)).filter(Boolean).join(sep);
/* Windows(純函式;tests/check_shell_login_path.js):GUI app 直接繼承登錄檔的使用者 PATH,不必開登入 shell。
   補的是已知安裝位置:Claude Code 原生安裝器(~\.local\bin)、npm 全域(%APPDATA%\npm,codex.cmd 在這)、Git for Windows
   的兩種裝法(Claude Code 的 Bash 工具靠它)。環境變數缺的那項會是相對路徑,不補。 */
function winPath(env) {
  const got = String(env.PATH || env.Path || "").split(";").map((s) => s.trim());
  const known = [
    path.win32.join(env.USERPROFILE || "", ".local", "bin"),
    path.win32.join(env.APPDATA || "", "npm"),
    path.win32.join(env.LOCALAPPDATA || "", "Programs", "Git", "cmd"),
    path.win32.join(env.ProgramFiles || "", "Git", "cmd"),
  ].filter((d) => path.win32.isAbsolute(d));
  return mergePath(got, known, ";");
}
function loginShellPath() {
  return new Promise((resolve) => {
    if (resolvedPath) return resolve(resolvedPath);
    if (process.platform === "win32") { resolvedPath = winPath(process.env); return resolve(resolvedPath); }
    const sh = process.env.SHELL || "/bin/zsh";
    execFile(sh, ["-lc", "echo -n $PATH"], { timeout: 8000 }, (err, stdout) => {
      const known = [
        path.join(os.homedir(), ".local/bin"),
        "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
      ];
      // 登入 shell(-l、非互動)不讀 .zshrc,而 Claude Code 官方安裝器正是把 ~/.local/bin 寫進 .zshrc——
      // 從 Finder 開 app 的人會「未偵測到」(從終端機 npm start 會繼承 PATH,所以開發時看不到)。
      // 已知的安裝位置一律補在後面:shell 給的順序優先,補的只是它漏掉的。
      const got = !err && stdout.trim() ? stdout.trim().split(":") : [];
      resolvedPath = mergePath(got, known);
      resolve(resolvedPath);
    });
  });
}

/* Windows 的 npm 全域 CLI 是 .cmd 包裝檔,Node 不經 shell 開不了(EINVAL)。只有這種才走 shell;命令列裡只有我們寫死的字
   與 where.exe 給的路徑(引號包住,路徑含空白也行)。 */
const cmdWrap = (bin) => (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin) ? { file: `"${bin}"`, shell: true } : { file: bin, shell: false });
function run(cmd, args, envPath, timeout = 10000) {
  const w = cmdWrap(cmd);
  return new Promise((resolve) => {
    execFile(w.file, args, { timeout, shell: w.shell, windowsHide: true, env: { ...process.env, PATH: envPath } },
      (err, stdout, stderr) => resolve({
        code: err ? (err.code === undefined ? -1 : err.code) : 0,
        stdout: String(stdout || ""), stderr: String(stderr || ""),
      }));
  });
}

// where.exe 依 PATH 順序列出每個符合 PATHEXT 的檔:優先拿 .exe(原生安裝器),npm 的 .cmd 只在沒有 .exe 時拿(純函式)
function pickWinBin(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.find((l) => /\.exe$/i.test(l)) || lines[0] || null;
}
async function which(name, envPath) {
  if (process.platform === "win32") {
    const r = await run(path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe"), [name], envPath, 5000);
    return r.code === 0 ? pickWinBin(r.stdout) : null;
  }
  const r = await run("/usr/bin/env", ["sh", "-c", `command -v ${name}`], envPath, 5000);
  return r.code === 0 ? r.stdout.trim() : null;
}

// 偵測結果契約(renderer 據此畫 a/b/c 三態):
// { claude: {installed, loggedIn, authMethod, email, path}, codex: {installed, loggedIn, path} }
const CODEX_IN_CHATGPT = "/Applications/ChatGPT.app/Contents/Resources/codex";
/* Windows 的 codex.cmd 要解到真的 codex.exe:runtime/codex_engine.py 用 create_subprocess_exec 起它,吃不了 .cmd。
   npm 的 bin/codex.js(0.156.1)找的是 <平台套件>/vendor/<triple>/bin/codex.exe,退路是 @openai/codex 自己的 vendor/;
   兩個都相對於 .cmd 所在的全域 node_modules。解不到就當沒裝(留一行 log),不把 .cmd 交給 runtime 去炸。純函式。 */
const CODEX_WIN_EXE = (arch) => {
  const triple = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  return [`codex-win32-${arch === "arm64" ? "arm64" : "x64"}`, "codex"].map((pkg) => path.win32.join("node_modules", "@openai", pkg, "vendor", triple, "bin", "codex.exe"));
};
function winRealExe(bin, arch, exists = fs.existsSync) {
  if (!bin || !/\.(cmd|bat)$/i.test(bin)) return bin;
  const dir = path.win32.dirname(bin);
  return CODEX_WIN_EXE(arch).map((rel) => path.win32.join(dir, rel)).find((p) => exists(p)) || null;
}
async function codexPath(envPath) {
  const found = await which("codex", envPath);
  if (process.platform === "win32") {
    const exe = winRealExe(found, process.arch);
    if (found && !exe) console.error("[detect] codex is a .cmd shim with no codex.exe next to it: " + found);
    return exe;
  }
  return found || (fs.existsSync(CODEX_IN_CHATGPT) ? CODEX_IN_CHATGPT : null);
}
/* 這一輪要跑的 codex 執行檔。**只解路徑**,不跑 `login status`——每一則訊息都要用,detectAgents() 一次要開到四個子行程;
   連 Claude 的人一次都不必開(SDK 自己找 claude)。來源仍然是當下的偵測,不是連結紀錄裡那個 agent 寫得到的字(稽核 R4)。 */
async function codexBinNow() { return codexPath(await loginShellPath()); }
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
  // Codex 有兩種裝法:獨立 CLI(在 PATH 上),或跟著 ChatGPT 桌面版來的——後者的
  // CLI 藏在 app bundle 裡、不在 PATH 上,但就是同一顆完整的 codex(實測
  // 0.155.0-alpha:`login status`、`exec --json` 都在)。只查 PATH 的話,一大群
  // 「有 Codex」的人會看到「未偵測到」。
  const codexBin = await codexPath(envPath);
  if (codexBin) {
    out.codex.installed = true;
    out.codex.path = codexBin;
    // 官方契約:`codex login status` 登入=0、未登入=1(原始碼 cli/src/login.rs:443)
    const r = await run(codexBin, ["login", "status"], envPath);
    out.codex.loggedIn = r.code === 0;
  }
  return out;
}

/* 本機 agent 的登入不是我們的 OAuth:帳號是用戶跟 Anthropic / OpenAI 之間的事,憑證在 CLI
   自己手上(Keychain / ~/.codex),app 拿不到也不該拿。登入失效時能做的只有一件——替用戶
   跑 CLI 自己的登入指令(`claude auth login`、`codex login`),它會開瀏覽器走完官方流程,
   結束碼 0 = 成功。五分鐘沒完成就收掉,免得留一個孤兒行程佔著回呼的 port。 */
let loginChild = null;
async function agentLogin(kind) {
  if (loginChild) return { ok: false, busy: true };
  const d = await detectAgents();
  const bin = kind === "claude" ? d.claude.path : kind === "codex" ? d.codex.path : null;
  if (!bin) return { ok: false };
  const envPath = await loginShellPath();
  return new Promise((resolve) => {
    const w = cmdWrap(bin);
    const child = spawn(w.file, kind === "claude" ? ["auth", "login"] : ["login"],
      { env: { ...process.env, PATH: envPath }, stdio: "ignore", shell: w.shell, windowsHide: true });
    loginChild = child;
    const timer = setTimeout(() => child.kill(), 5 * 60 * 1000);
    // cancelled:用戶自己按了「取消等待」——不是失敗,renderer 不顯示失敗句
    const done = (ok) => { clearTimeout(timer); const cancelled = !!child.__cancelled; loginChild = null; resolve({ ok, cancelled }); };
    child.on("error", () => done(false));
    child.on("exit", (code) => done(code === 0));
  });
}

function cancelAgentLogin() {
  if (!loginChild) return false;
  loginChild.__cancelled = true; loginChild.kill();
  return true;
}

// 連的是哪個 AI(connstore.js):檔案帶 Keychain 金鑰算的 MAC,agent 改得了檔、改不了這個決定(稽核 S1)
let _conn = null;
function connStore() {
  if (!_conn) _conn = require("./connstore").createConnStore({
    dir: app.getPath("userData"),
    seal: { available: () => safeStorage.isEncryptionAvailable(), encrypt: (v) => safeStorage.encryptString(v), decrypt: (b) => safeStorage.decryptString(b) },
    tokenFp: () => { const t = loadToken(); return t ? crypto.createHash("sha256").update(t).digest("hex").slice(0, 32) : null; },
  });
  return _conn;
}
/* path 會被拿去 spawn:只收「現在偵測得到的那一個」,畫面送什麼路徑來都不算數 */
async function saveConnection(choice) {
  const kind = choice && choice.kind;
  let agentPath = null;
  if (kind === "claude" || kind === "codex") { agentPath = ((await detectAgents())[kind] || {}).path || null; if (!agentPath) return false; }
  const saved = connStore().save({ kind, path: agentPath, email: choice && choice.email });
  if (!saved) return false;
  tm().track("connect_done", { kind: saved.kind });
  return true;
}
const clearConnection = () => connStore().clear();
const loadConnection = () => connStore().load();

// ── 使用追蹤(telemetry.js:八個事件、屬性只有列舉、沒有自由文字的入口;設定裡可關)──
let _tm = null;
function tm() {
  if (!_tm) _tm = require("./telemetry").createTelemetry({
    dir: app.getPath("userData"), endpoint: `${API_BASE}/oauth/desktop/telemetry`,
    appVersion: app.getVersion(), osVersion: process.getSystemVersion(), lang: app.getLocale(),   // 契約:系統語系原值;不吃 BLAVE_LANG(任意字串會原樣離開電腦)
    getToken: () => loadToken(),
    // 開發版(npm start、測試用的 BLAVE_HOME)不送:不然每次開發重啟都在灌正式的漏斗。要實測送出設 BLAVE_TELEMETRY=1
    post: (u, b) => (app.isPackaged || process.env.BLAVE_TELEMETRY === "1" ? postJSON(u, b) : Promise.resolve()),
  });
  return _tm;
}

// ── 雲端宿主(cloud.js;線 B 第一刀:唯讀)──────────────────────
// 用帳號 token + app_secret 讀用戶雲端主機的狀態。兩顆憑證只在這個行程裡:不進 renderer、不進 agent 的環境、不寫檔。
// 回應也不落地——agent 讀得到 workspace,落地就等於把部位與權益交給它。renderer 拿到的是畫面用的狀態(沒有憑證)。
let _cloud = null;
function isOurPageUrl(u) {
  try { const x = new URL(u || ""); return x.protocol === "file:" && require("url").fileURLToPath(x.href.split(/[?#]/)[0]) === path.join(__dirname, "renderer", "index.html"); } catch (_) { return false; }
}
function cloudHost() {
  if (!_cloud) _cloud = require("./cloud").createCloudHost({
    apiBase: API_BASE, post: (u, b) => postJSON(u, b),
    getCreds: () => { const token = loadToken(); return token ? { token, appSecret: loadAppSecret() } : null; },
    // 送的是部位與權益:只送給載入自家 index.html 的視窗(今天全 app 只有一個視窗;哪天多了第二個,也不會漏過去)
    onChange: (snap) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && isOurPageUrl(w.webContents.getURL())) w.webContents.send("cloud-state", snap); },
  });
  return _cloud;
}
/* 雲端的寫入那一支(cloudcmd.js;線 B 第二刀)。跟讀那支分開:兩邊走不同的端點與速率桶,而且這支的
   owner/gen 要在登出時單獨作廢(cloudcmd.js:95)。憑證同樣只在這個行程裡。 */
let _cloudCmd = null;
function cloudCmd() {
  if (!_cloudCmd) _cloudCmd = require("./cloudcmd").createCloudCmd({
    apiBase: API_BASE, post: (u, b) => postJSON(u, b),
    getCreds: () => { const token = loadToken(); return token ? { token, appSecret: loadAppSecret() } : null; },
  });
  return _cloudCmd;
}

// ── 自動更新(updater.js;規則見 spec §13)────────────────────
// 更新來源由打包時的 BLAVE_UPDATE_URL 蓋進 package.json(blaveUpdateUrl);開發版與沒設的包 = 不更新,畫面只顯示版號。
let _up = null;
function updater() {
  if (_up) return _up;
  const feedUrl = app.isPackaged ? require("./package.json").blaveUpdateUrl || null : null;
  _up = require("./updater").createUpdater({
    autoUpdater: feedUrl ? require("electron-updater").autoUpdater : null,
    // Squirrel 暫存完成的事件只有原生這顆會發(updater.js 檔頭);Windows 是 NSIS,沒有原生這一層 → 不給,electron-updater 下載完就算 ready
    nativeUpdater: feedUrl && process.platform === "darwin" ? require("electron").autoUpdater : null,
    feedUrl, currentVersion: app.getVersion(),
    isTrading: () => !!tradeMaybeLive(),   // 保守判定:可能還在下單就不裝
    onState: (st) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("update-state", { ...st, backup: _officialBackup }); },
    log: (m) => console.error("[updater] " + m),
  });
  return _up;
}

// ── OAuth(用 Blave AI)─────────────────────────────────────
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
  libCache = null;   // 策略庫清單帶著這個帳號的 purchased:登出就丟
  clearDataKey();
  clearAppSecret();
  rptCloudInvalidate();   // 雲端報告的清單與本體是這個帳號的
}

/* app_secret:登入時 api 多發的一顆、**只有這支主行程拿得到**的憑證。帳號 token 會進 agent 的
   環境(策略碼讀得到),所以後端不准它做任何花錢的事;「啟動雲端方案」= 替帳號開一台主機,要
   token + app_secret 兩顆都對才動。這顆只存 Keychain:不進任何子行程的環境、不寫進 workspace、
   不交給 renderer(renderer 只拿得到「啟動」這個動作的結果)。 */
const appSecretPath = () => path.join(app.getPath("userData"), "blave-app.bin");
function saveAppSecret(v) {
  if (typeof v !== "string" || !v || !safeStorage.isEncryptionAvailable()) return false;
  fs.writeFileSync(appSecretPath(), safeStorage.encryptString(v), { mode: 0o600 });
  return true;
}
function loadAppSecret() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(fs.readFileSync(appSecretPath()));
  } catch (_) { return null; }
}
function clearAppSecret() {
  try { fs.unlinkSync(appSecretPath()); } catch (_) {}
}
/* 啟動雲端方案。回 { state } 或 { error }(穩定代號,畫面自己換成句子):
   APP_SECRET_REQUIRED(舊登入,沒有這顆)/ NO_CARD / NO_CREDIT / RATE_LIMITED / SERVER。
   後端是冪等的:已有主機就回現況,連點或重試不會開第二台。 */
async function planStart() {
  const token = loadToken(), secret = loadAppSecret();
  if (!token) return { error: "INVALID_CREDENTIALS" };
  if (!secret) return { error: "APP_SECRET_REQUIRED" };
  try {
    const r = await postJSON(`${API_BASE}/oauth/desktop/plan/start`, { token, app_secret: secret });
    const b = r.body || {};
    if (r.status === 200 && typeof b.state === "string") { lastAcct = null; return { state: b.state }; }
    if (r.status === 429) return { error: "RATE_LIMITED" };
    const code = b.error_code || b.error;
    return { error: ["APP_SECRET_REQUIRED", "NO_CARD", "NO_CREDIT", "INVALID_CREDENTIALS"].includes(code) ? code : "SERVER" };
  } catch (_) { return { error: "SERVER" }; }
}

/* Blave 資料 key(api-key / secret-key 一組):換 token 時 api 一併發下來,只此一次。
   跟 token 一樣進 Keychain;**登入了、而且帳號含資料**才寫進 workspace 的 `.env`
   (lib 與範例讀的就是 `blave_api_key` / `blave_secret_key` 這兩行)——不看連的是哪個 AI:用自己
   Claude Code / Codex 的人登入 Blave 之後一樣拿得到(Wei 拍板,v3)。K 線不受影響,照舊走 Binance 公開端點。 */
const dataKeyPath = () => path.join(app.getPath("userData"), "blave-data.bin");
function saveDataKey(apiKey, secretKey) {
  if (!apiKey || !secretKey || !safeStorage.isEncryptionAvailable()) return false;
  fs.writeFileSync(dataKeyPath(),
    safeStorage.encryptString(JSON.stringify({ api_key: String(apiKey), secret_key: String(secretKey) })),
    { mode: 0o600 });
  return true;
}
function loadDataKey() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const k = JSON.parse(safeStorage.decryptString(fs.readFileSync(dataKeyPath())));
    // 進 .env 的值只認 key 該有的字元:一個換行就能在 .env 裡多塞一行設定
    const ok = (v) => typeof v === "string" && /^[A-Za-z0-9_\-]{8,200}$/.test(v);
    return ok(k.api_key) && ok(k.secret_key) ? k : null;
  } catch (_) { return null; }
}
function clearDataKey() {
  try { fs.unlinkSync(dataKeyPath()); } catch (_) {}
  syncDataEnv(false);
}
/* 讓 workspace/.env 跟「現在該不該有 Blave 資料」一致。**只動外殼自己那一塊**(前後兩行
   標記包起來的兩行):用戶自己手放的 `blave_api_key`(API 方案戶用自己的 Claude Code 時靠的
   就是它——secret 在伺服器端是雜湊,刪了拿不回來)、交易所 key 等一律原樣保留。我們那塊放
   檔尾,同名時後者為準。每一輪開跑前都對一次,切換連結對象、登出之後不會留下舊 key。
   回傳這一輪 workspace 裡的 Blave 資料 key 是誰的:ours(外殼發的)/ own(用戶自己放的)/ none。 */
const ENV_BEGIN = "# >>> blave desktop data key (managed, do not edit) >>>";
const ENV_END = "# <<< blave desktop data key <<<";
function syncDataEnv(want) {
  const envFile = path.join(WS, ".env");
  const key = want ? loadDataKey() : null;
  let cur = "";
  try { cur = fs.readFileSync(envFile, "utf8"); }
  catch (e) {
    // 讀不到不等於沒有:權限/IO 問題時照「空檔」往下寫,會用兩行 key 蓋掉放交易所 key 的檔
    if (e.code !== "ENOENT") return "none";
    if (!key) return "none";                 // 沒檔、也沒東西要寫
  }
  const lines = cur.split(/\r?\n/);
  const kept = []; let inBlock = false;
  for (const l of lines) {
    if (l.trim() === ENV_BEGIN) { inBlock = true; continue; }
    if (l.trim() === ENV_END) { inBlock = false; continue; }
    if (!inBlock) kept.push(l);
  }
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  // 用戶自己放的 key(API 方案戶)也算「這台有 Blave 資料」:不然 prompt 會跟 agent 說沒有,
  // 而 .env 裡明明有一組能用的
  const own = kept.some((l) => /^\s*(export\s+)?blave_api_key\s*=\s*\S/.test(l));
  if (key) kept.push(ENV_BEGIN, `blave_api_key=${key.api_key}`, `blave_secret_key=${key.secret_key}`, ENV_END);
  const next = kept.length ? kept.join("\n") + "\n" : "";
  const state = key ? "ours" : own ? "own" : "none";
  if (next === cur) return state;
  try {
    if (!next) fs.unlinkSync(envFile);        // 整個檔只有我們那塊:不留空檔
    else {
      // 先寫暫存檔再 rename:背景策略可能正在讀這個檔,寫到一半 crash 也不能留半個檔
      const tmp = envFile + ".blave-tmp";
      try {
        fs.writeFileSync(tmp, next, { mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, envFile);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) {}   // rename 沒成功:暫存檔裡是明文 key,不能留著
        throw e;
      }
    }
  } catch (_) { return own ? "own" : "none"; }   // workspace 還沒建好 / 寫不進去:只剩用戶自己那組算數
  return state;
}

/* 登出 Blave:先請伺服器撤銷這顆 token(RFC 7009 的形狀:POST /oauth/desktop/revoke,持有 token
   本身就是授權),再刪本機那份。只刪本機的話伺服器上那顆還是有效的——電腦被拿走、或在共用
   電腦上登出,舊 token 還能繼續燒帳號額度。
   撤銷是 best-effort:沒網路也要登得出去。回傳 revoked 讓畫面知道伺服器那邊有沒有成功,
   沒成功就提醒用戶到網站的「裝置」頁再撤一次。 */
async function signOutBlave() {
  const tok = loadToken();
  let revoked = false;
  if (tok) {
    try { revoked = (await postJSON(`${API_BASE}/oauth/desktop/revoke`, { token: tok })).status === 200; }
    catch (_) { /* 離線 / 逾時:照樣登出本機 */ }
  }
  clearToken();
  if (_cloud) _cloud.reset();   // 登出:不留上一個帳號的部位在記憶體裡
  if (_cloudCmd) _cloudCmd.reset();   // 在途的雲端指令:回應回來時丟掉(它是上一個人的)
  if (_mcp) _mcp.reset();       // 接入碼也是:伺服器那邊 /revoke 會撤掉它,這裡把記憶體裡的丟掉、作廢在途的請求
  lastAcct = null;
  return { revoked };
}

function postJSON(url, body, extra) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = require("https").request(url, {
      ...(extra || {}),   // 目前只有 my_ip 用:{ family: 4 } 強制走 IPv4
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

function getJSON(url, headers) {
  return new Promise((resolve, reject) => {
    const req = require("https").request(url, { method: "GET", headers: headers || {}, timeout: 15000 }, (res) => {
      let buf = "";
      res.on("data", (d) => { buf += d; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf || "{}") }); }
        catch (_) { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
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
  // 重新登入(方案頁的「重新登入」、登入失效後的原地登入)時手上還有上一顆 token:新的換到手之後把舊的
  // 撤銷掉——不然伺服器上那顆連同它的資料 key 會一直活著,「已授權的電腦」也會多一列同名的裝置。
  // best-effort:撤不掉不影響這次登入。
  const prevToken = loadToken();
  if (!saveToken(r.body.access_token)) {
    throw new Error("KEYCHAIN_UNAVAILABLE");
  }
  if (prevToken && prevToken !== r.body.access_token) {
    postJSON(`${API_BASE}/oauth/desktop/revoke`, { token: prevToken }).catch(() => {});
  }
  connStore().reseal();   // 連的是 Blave AI 的人重新登入:連結紀錄綁的是 token 指紋,要跟著換到新的這一顆
  tm().track("login_done");
  // 資料 key 只在這一次回應裡出現;舊版 api 沒有這兩欄就是沒有資料權限,不算失敗
  // 先清掉上一次登入留下的那組:那顆 token 換掉之後,舊 key 可能已經被撤銷,留著會把死 key
  // 寫進 .env 還告訴 agent「你有資料」
  clearDataKey();
  saveDataKey(r.body.data_api_key, r.body.data_secret_key);
  clearAppSecret();
  saveAppSecret(r.body.app_secret);      // 舊版 api 沒有這欄:之後按「啟動方案」會被要求重新登入
  // 換了帳號:cloud.js 自己會認出 token 換了、把上一個人的東西丟掉(不靠這一行);這一行只是讓畫面不必等下一輪輪詢
  if (_cloud && _cloud.isRunning()) _cloud.refresh(true).catch(() => {});
  lastAcct = null;                    // 可能換了一個帳號:上一個帳號的「含不含資料」不能沿用
  libCache = null;                    // 同理:策略庫的 purchased / is_owner 是帳號的
  // 授權是在瀏覽器完成的,焦點還在那邊 —— 自己回到前景,不要讓用戶去找視窗。
  app.focus({ steal: true });
  return { ok: true };
}

// ── 第 4 步:引擎 ─────────────────────────────────────────────
// 官方檔案(runtime、lib、references…)從哪裡取:開發時 repo checkout 就在 shell/ 上一層;
// 打包版在 Contents/Resources/agent(extraResources,**不進 asar**——Python 要直接讀、
// fs.cpSync 也要真的目錄)。清單見 electron-builder.config.js。
const resourceRoot = () => (app.isPackaged
  ? path.join(process.resourcesPath, "agent") : path.join(__dirname, ".."));
const REPO = resourceRoot();
// BLAVE_HOME:把整個 ~/Blave 換到別處(測乾淨狀態用)。只認絕對路徑。
const BASE = path.isAbsolute(process.env.BLAVE_HOME || "")
  ? process.env.BLAVE_HOME : path.join(os.homedir(), "Blave");
const WS = path.join(BASE, "workspace");
// venv 的執行檔目錄:POSIX 是 bin/、Windows 是 Scripts\(python.exe 是 launcher,不是 symlink)
const WIN = process.platform === "win32";
const VENV_BIN = WIN ? "Scripts" : "bin";
const VENV_PY = path.join(BASE, "venv", VENV_BIN, WIN ? "python.exe" : "python");
// 乾淨的 Mac 沒有 python3(要先裝 Xcode CLT):打包版隨包(tools/fetch-python.sh),
// venv 用它建;開發時照舊用系統的。universal 包兩顆都在(python-arm64 / python-x64),
// 照 Electron 實際跑起來的架構挑——Apple Silicon 上被 Rosetta 跑成 x64 時 process.arch 也是 x64,挑到的顆才對得上 venv。
// Windows 的 python-build-standalone 沒有 bin/:python.exe 就在根目錄(python-x64\python.exe)
const BUNDLED_PY = WIN ? path.join(process.resourcesPath || "", `python-${process.arch}`, "python.exe")
  : path.join(process.resourcesPath || "", `python-${process.arch}`, "bin", "python3");
const basePython = () => (app.isPackaged && fs.existsSync(BUNDLED_PY) ? BUNDLED_PY : WIN ? "python" : "python3");
// 打包版的 runtime/ 與隨包 Python 都在 .app 裡:不讓 Python 把 __pycache__ 寫進去
// (簽章後 bundle 內容一變就驗不過;唯讀位置也寫不進)。
const PY_ENV = app.isPackaged ? { PYTHONPYCACHEPREFIX: path.join(BASE, "state", "pycache") } : {};

/* 子行程(常駐程式、agent 回合)的環境(純函式;tests/check_shell_win_env.js)。
   darwin:呼叫端手寫的白名單物件原樣回去——**不含** ...process.env,帳號憑證與用戶 shell 的雜物都進不去。
   win32:白名單起不來——Python 少了 SystemRoot 直接死,還要 USERPROFILE / APPDATA / LOCALAPPDATA / TEMP / TMP / PATHEXT /
   COMSPEC(runtime/command_listener.py 的 _launch_flatten 踩過同一個坑)。改成放行整份 process.env、拔掉敏感的
   (AI 供應商的 key、Blave 自己的、會改變 Python / Node 行為的),白名單物件蓋在最後;HOME 對映到 USERPROFILE
   (claude.exe 讀 ~/.claude 靠 USERPROFILE,HOME 只是給 POSIX 慣例的碼)。Windows 的環境變數不分大小寫:
   跟白名單同名(不分大小寫)的先拔掉,不留 Path / PATH 兩份讓 Node 自己挑。
   PYTHONUTF8=1:Windows 的 Python 接 pipe 時用的是 ANSI code page(cp950 / cp1252),agent 回合 stdout 第一個 emoji
   就 UnicodeEncodeError;UTF-8 mode 一併修 stdio 與 open() 的預設編碼,整棵子行程樹(daemon → 對帳器 → 策略)都繼承。 */
const WIN_ENV_DROP = /^(ANTHROPIC_|OPENAI_|BLAVE_|CODEX_|CLAUDE_|PYTHON|NODE_OPTIONS$|ELECTRON_)/i;
const WIN_PY_ENV = { PYTHONUTF8: "1" };
function childEnv(own, platform = process.platform, penv = process.env) {
  if (platform !== "win32") return own;
  const taken = new Set(Object.keys(own).map((k) => k.toUpperCase()));
  const env = {};
  for (const k of Object.keys(penv)) if (!WIN_ENV_DROP.test(k) && !taken.has(k.toUpperCase())) env[k] = penv[k];
  if (!env.SystemRoot && !taken.has("SYSTEMROOT")) env.SystemRoot = "C:\\Windows";
  return { ...env, ...WIN_PY_ENV, ...own, HOME: penv.USERPROFILE || own.HOME };
}

// 跑一顆 Python(建 venv、pip):argv 陣列直接交給 execFile,沒有 shell、沒有引號問題
function pyExec(bin, args, envPath, timeout = 300000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, windowsHide: true, env: { ...process.env, ...PY_ENV, ...(WIN ? WIN_PY_ENV : {}), PATH: envPath } }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout));
      // 逾時 / 輸出爆 maxBuffer 時 stderr 常是空的,err.message 是整條指令(含用戶 home 路徑)——會被畫進失敗卡,換成說得出原因的一句
      const why = err.killed && err.signal ? `timed out after ${Math.round(timeout / 1000)}s`
        : err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output too large" : "";
      reject(new Error(why || String(stderr || err)));
    });
  });
}

// 首次連結時準備 ~/Blave:workspace 逐目錄從 repo 拷(照 README 的 merge 清單),
// venv 裝 pinned SDK。冪等:存在就跳過。進度用 callback 丟回聊天欄。
// 官方檔案清單 = README 的 "Updating an existing workspace" 那張表。
// 只覆寫這些;strategies/<name>/、state/、.env、cache/ 一律不碰,而且用 cpSync
// (覆寫但不刪除)——agent 可以合法新增 lib/order_<新交易所>.py 這種用戶自己的
// 整合(updating.md:「reference clone 裡不存在的那些完全不碰」),不能被清掉。
const OFFICIAL_DIRS = ["lib", "manager", "references", "examples", "allocators"];
const OFFICIAL_FILES = [
  "strategies/TEMPLATE_A.py", "strategies/TEMPLATE_C.py",
  "AGENTS.md", "CLAUDE.md", "VERSION",
];
function copyOfficial() {
  fs.mkdirSync(path.join(WS, "strategies"), { recursive: true });
  for (const d of OFFICIAL_DIRS)
    fs.cpSync(path.join(REPO, d), path.join(WS, d), { recursive: true });
  // VERSION 必須最後寫(OFFICIAL_FILES 的最後一項):前面任何一步中途失敗,workspace 的版號還是舊的,下次啟動會整個重來
  for (const f of OFFICIAL_FILES) fs.cpSync(path.join(REPO, f), path.join(WS, f));
}
/* 覆寫之前,把「workspace 裡跟隨包不一樣的官方檔」備份起來(Wei 2026-09-21:覆寫,但先備份被改過的檔)。
   電腦版的官方檔跟著 app 走(一包一個版號),所以更新一定覆寫;但 agent 或用戶可能改過 lib/——那份改動不能無聲消失。
   備份放 workspace/.official-backup/<舊版號>-<時間>/,只收內容不同的檔;用戶自己加的檔(隨包沒有的)本來就不會被碰。 */
function listFiles(root, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (e.name === "__pycache__" || e.name === ".DS_Store") continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...listFiles(root, r)); else if (e.isFile()) out.push(r);
  }
  return out;
}
function backupChangedOfficial(tag) {
  const files = [...OFFICIAL_FILES];
  for (const d of OFFICIAL_DIRS) if (fs.existsSync(path.join(REPO, d))) files.push(...listFiles(REPO, d));
  const dest = path.join(WS, ".official-backup", tag), saved = [];
  for (const f of files) {
    if (f === "VERSION") continue;
    let mine; try { mine = fs.readFileSync(path.join(WS, f)); } catch (_) { continue; }   // workspace 沒有這個檔:沒東西可備份
    if (mine.equals(fs.readFileSync(path.join(REPO, f)))) continue;
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
    fs.writeFileSync(path.join(dest, f), mine); saved.push(f);
  }
  return { dest, saved };
}

/* app 更新之後把 workspace 的官方檔案跟上(自動更新的另一半):
   runtime/ 在 .app 裡、跟著 app 一起換;lib / manager / references / AGENTS.md 是**拷進 workspace 的副本**——
   不重拷的話,更新完是「新 runtime + 舊 lib」的混搭(雲端同樣的兩層,各有各的更新通道;電腦版是一包,所以要一起換)。
   - 只在 app 啟動時做、而且在常駐程式起來之前:這一刻沒有任何東西在下單(重開 app 後要用戶自己按啟動),
     符合「實盤中不換版」。
   - 只往上不往下:隨包的 VERSION 比 workspace 的新才拷。有人裝回舊版 app 時不把 workspace 降版
     (策略可能已經用到新 lib 的東西);VERSION 是日期字串(YYYY-MM-DD[-b]),字串比較即可。
   - 照 copyOfficial 的規則:只覆寫官方清單,strategies/<name>/、state/、.env、cache/、用戶自己加的 lib 檔都不碰。 */
const readVersion = (dir) => { try { return fs.readFileSync(path.join(dir, "VERSION"), "utf8").trim(); } catch (_) { return ""; } };
const officialStale = (bundled, ws) => !!bundled && bundled > (ws || "");
/* 這次啟動換版時被蓋掉的改動(只在記憶體;經 update-state 交給「關於」那一行)。以前只寫 log,用戶看不到自己的改動被收到哪去了 */
let _officialBackup = null;
function syncOfficialOnUpdate() {
  if (!app.isPackaged || !fs.existsSync(WS)) return false;   // 開發版每次啟動本來就重拷;還沒有 workspace = 首次連結時會拷
  const bundled = readVersion(REPO), ws = readVersion(WS);
  if (!officialStale(bundled, ws)) { if (bundled && ws && bundled < ws) console.error(`[update] workspace ${ws} is newer than this app's ${bundled} — left as is`); return false; }
  try {
    // 備份不成就不覆寫:寧可這次停在舊 lib(下次啟動再試),也不要把改動弄丟
    // 版號來自 workspace 的 VERSION(agent 寫得到):當成不可信字串,只留檔名安全的字元,免得 `../` 把備份寫到別處
    const bk = backupChangedOfficial(`${ws || "none"}-${new Date().toISOString()}`.replace(/[^A-Za-z0-9._-]/g, "_"));
    copyOfficial();
    console.error(`[update] workspace framework ${ws || "(none)"} → ${bundled}` + (bk.saved.length ? `; ${bk.saved.length} changed official file(s) backed up to ${bk.dest}` : ""));
    if (bk.saved.length) _officialBackup = { n: bk.saved.length, dir: path.relative(WS, bk.dest) + path.sep };
    return true;
  } catch (e) { console.error("[update] workspace sync failed: " + (e && e.message)); return false; }
}

const AGENT_SDK = "claude-agent-sdk==0.2.144";
// cryptography 跟 SDK 一起釘:SDK → mcp → pyjwt[crypto] 拉進它,50.x 起 macOS 只出 arm64 wheel,Intel(含被 Rosetta
// 跑成 x64)會退到從原始碼編(要 Rust,用戶機沒有)——0.0.6 通用版在 Intel 就死在這裡。48.0.1 是最後一版 universal2 wheel,
// 兩種架構釘同一版。記號檔比的是整串,所以既有 venv 在下一則訊息(ensure-engine 每次送訊息前都跑)會重跑一次
// SDK 那條:把 50.0.1 換成 48.0.1,下載約 8 MB。
const SDK_PINS = `${AGENT_SDK} cryptography==48.0.1`;
// 只收 wheel:這個架構沒有 wheel 就兩秒內大聲失敗(pip「No matching distribution」),不退到編原始碼——那條路在用戶機上
// 跑幾分鐘然後死在看不到的地方。清單裡每一個都在 arm64 與 x64 實機用這條指令裝過。
// --isolated:不吃用戶的 pip.conf 與 PIP_* 環境變數(PIP_INDEX_URL / PIP_NO_BINARY 都會讓引擎裝到別的東西)。
const PIP_INSTALL = "-m pip -q --isolated install --only-binary=:all:";
// pip 失敗的 stderr 常是整段 build / resolver log:只留 pip 自己的 ERROR 行(沒有就留最後三行)給聊天欄
function pipError(e) {
  const lines = String((e && e.message) || e).split("\n").map((l) => l.trim()).filter(Boolean);
  const err = lines.filter((l) => l.startsWith("ERROR:")).map((l) => l.replace(/ \(from versions:.*\)$/, ""));
  return (err.length ? err : lines.slice(-3)).join("\n").slice(0, 600);
}
// 引擎的 pip 都走這條。失敗先把完整 stderr 留在主行程的 stderr(沒有 log 檔,失敗卡上的字又是修剪過的),再丟修剪過的
function pip(args, envPath, timeout) {
  return pyExec(VENV_PY, [...PIP_INSTALL.split(" "), ...args.split(" ")], envPath, timeout).catch((e) => {
    console.error("[engine] pip install failed:", args, "\n" + String((e && e.message) || e));
    throw new Error(pipError(e));
  });
}
async function ensureEngine(report) {
  // 建 venv 與裝 SDK 共用「正在準備引擎」這一句:兩步都要走時別印兩次
  let said = null;
  const progress = (k) => { if (k !== said) report(k); said = k; };
  const envPath = await loginShellPath();
  const fresh = !fs.existsSync(WS);
  if (fresh) {
    progress("engine.workspace");
    // 0700:裡面有 session.db(對話)、.env(金鑰)、狀態檔,同一台電腦的其他用戶不該讀得到(稽核 R9)。
    // 只在我們自己建立的時候設;用戶既有的目錄不動他的權限。
    if (!fs.existsSync(BASE)) fs.mkdirSync(BASE, { recursive: true, mode: 0o700 });
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
    // .app 被搬走 / 改名 / 被 Gatekeeper translocate 之後,venv/bin/python* 是斷掉的連結,
    // venv 模組撞到會直接報錯(實測)。先清掉斷的,site-packages 留著,重建只要幾秒。
    // Windows 的 venv 沒有連結(Scripts\python.exe 是 launcher + pyvenv.cfg 的 home=),而且 NSIS 裝在固定位置:整段跳過
    const vbin = path.join(BASE, "venv", VENV_BIN);
    for (const n of !WIN && fs.existsSync(vbin) ? fs.readdirSync(vbin) : []) {
      const f = path.join(vbin, n);
      if (fs.lstatSync(f).isSymbolicLink() && !fs.existsSync(f)) fs.unlinkSync(f);
    }
    await pyExec(basePython(), ["-m", "venv", path.join(BASE, "venv")], envPath);
  }
  // 記號檔而不是「venv 在就當裝好了」:pip 中途失敗(斷網)時 venv 已經在,下次啟動要重試。
  const sdkMark = path.join(BASE, "venv", ".blave-sdk");
  if (!fs.existsSync(sdkMark) || fs.readFileSync(sdkMark, "utf8") !== SDK_PINS) {
    progress("engine.preparing");
    await pip(SDK_PINS, envPath, 600000);
    fs.writeFileSync(sdkMark, SDK_PINS);
  }
  // workspace 的 lib/ 與 manager/ 要的第三方套件(從它們的 import 列出來的)。原本只裝
  // SDK:agent 能聊天、能寫策略,一回測就炸(「Python 環境缺少 pandas」,實測)。
  // 用一個記號檔而不是每次都問 pip——pip 光是確認「都裝了」也要好幾秒。
  // 記號檔比內容:app 更新後清單變了(多一個套件、換版本)要重裝,只看檔案在不在會永遠跳過(稽核 S8)
  const depsMark = path.join(BASE, "venv", ".blave-deps-1");
  let depsHave = ""; try { depsHave = fs.readFileSync(depsMark, "utf8"); } catch (_) { /* 還沒裝過 */ }
  if (depsHave !== WORKSPACE_DEPS.join("\n")) {
    progress("engine.deps");
    await pip(WORKSPACE_DEPS.join(" "), envPath, 900000);
    fs.writeFileSync(depsMark, WORKSPACE_DEPS.join("\n"));
  }
}

// 這份清單是**列舉出來的**,不是憑印象:用 AST 掃 lib/ manager/ examples/ 與兩支策略
// 模板(75 個檔)的頂層 import,扣掉標準庫與 workspace 自己的模組,再逐一實際 import。
// 第一版憑 grep 少了 python-dotenv(lib/runner.py 第一行就要它)與 scipy。
// 刻意不裝:shioaji(永豐下單 SDK,有綁該券商的人才需要)、comtypes / pythoncom
// (群益的 COM 介面,只有 Windows 有)。
// 釘版本:打包版在實機裝到、並跑過一輪回測的那組(隨包 CPython 3.12;arm64 與 x64/Rosetta 都只靠 wheel 裝得起來)。升版要重跑那輪驗證。
const WORKSPACE_DEPS = [
  "pandas==3.0.6", "numpy==2.5.3", "matplotlib==3.11.2", "pyarrow==25.0.1",
  "requests==2.34.2", "python-dotenv==1.2.3", "scipy==1.18.1",
];


// ── 策略(sidebar + 報告)────────────────────────────────────
// 雲端版是機器把回測結果上傳到 api、網頁再拉回來;桌面版資料就在本機,直接讀資料夾:
//   ~/Blave/workspace/strategies/<name>/{strategy.py, stats.json, …}
// stats.json 是 lib/runner 寫的,一支 1MB 上下(含 K 線與指標線),所以清單只回摘要、
// 並用 mtime 快取——sidebar 每輪結束都會重讀,不能每次都把每支 parse 一遍。
const STRAT_DIR = () => path.join(WS, "strategies");
const stratCache = new Map();   // name → { mtime, summary }

// 名字只能是「strategies/ 底下真的存在的資料夾」。renderer 傳什麼都先過這關,
// `../../.ssh` 之類的根本不會進到 path.join。
function stratNames() {
  try {
    return fs.readdirSync(STRAT_DIR(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
      .filter((d) => fs.existsSync(path.join(STRAT_DIR(), d.name, "strategy.py")))
      .map((d) => d.name);
  } catch (_) { return []; }
}
const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);

// strategy.py 的頂層常數 DISPLAY_NAME / DESCRIPTION(模板規定的欄位)= 給人看的名字與
// 一句說明;資料夾名是 snake_case 的識別字。只認「行首、雙引號或單引號、單行」的寫法,
// 認不到就回 null,呼叫端退回資料夾名。
function stratMeta(code) {
  const pick = (k) => {
    const m = new RegExp(`^${k}\\s*=\\s*(["'])(.*?)\\1\\s*(#.*)?$`, "m").exec(code || "");   // 行尾註解照收(runtime 用 ast 讀得到)
    return m && m[2].trim() ? m[2].trim().slice(0, 200) : null;
  };
  // STRATEGY_NAME:組合的 key 是它(不一定等於資料夾名,runtime `_cmd_delete_strategy` 也照它比)
  return { displayName: pick("DISPLAY_NAME"), description: pick("DESCRIPTION"), strategyName: pick("STRATEGY_NAME") };
}

/* 這支策略程式會不會自己下單(Type B 那一種:AGENTS.md 規定交易所下單一律走 lib/order_*、執行走 lib/execute,
   Type A/C 只 import lib.runner / lib.data,單由對帳器下)。看的是 import 與 `lib.order_x` / `lib.execute` 的點呼叫,
   註解剝掉再比。只回布林,不執行任何東西。 */
const SELF_ORDER_RE = /\bfrom\s+lib\.(?:order_[a-z0-9_]+|execute)\s+import\b|\bimport\s+lib\.(?:order_[a-z0-9_]+|execute)\b|\blib\.(?:order_[a-z0-9_]+|execute)\.|\bfrom\s+lib\s+import\s+[^\n]*\b(?:execute|order_[a-z0-9_]+)\b/;
function stratSelfOrdering(code) {
  // 先剝註解,再把 `\` 續行與 `import (\n execute,\n)` 這種 black 排的多行 import 收成一行,regex 才對得到
  const src = String(code || "").replace(/#[^\n]*/g, "").replace(/\\\n/g, " ").replace(/\bimport\s*\(([^)]*)\)/g, (_m, inner) => "import " + inner.replace(/\s+/g, " "));
  return SELF_ORDER_RE.test(src);
}
// 全部策略資料夾(strategies/<name>/*.py,含 helper 檔——同 stratDataSources 掃整個資料夾)有沒有任何一支自己下單。
// 每輪狀態輪詢(4–15 秒)都會問:按檔案 mtime 快取,沒改就不重讀
const selfOrdCache = new Map();   // 檔案路徑 → { mtime, hit }
function stratSelfOrderingAny() {
  for (const name of stratNames()) {
    const dir = path.join(STRAT_DIR(), name);
    let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".py")); } catch (_) { continue; }
    for (const f of files) {
      const p = path.join(dir, f);
      let mtime = 0; try { mtime = fs.statSync(p).mtimeMs; } catch (_) { continue; }
      const c = selfOrdCache.get(p);
      if (c && c.mtime === mtime) { if (c.hit) return true; continue; }
      let code; try { code = fs.readFileSync(p, "utf8"); } catch (_) { return true; }   // 讀不到就當「有」、也不快取:偏向藏鈕會把最需要「解除暫停」的 Type B 用戶的出口藏掉
      const hit = stratSelfOrdering(code);
      selfOrdCache.set(p, { mtime, hit });
      if (hit) return true;
    }
  }
  return false;
}

function listStrategies() {
  return stratNames().map((name) => {
    const dir = path.join(STRAT_DIR(), name);
    const statsPath = path.join(dir, "stats.json");
    let mtime = 0;
    try { mtime = fs.statSync(path.join(dir, "strategy.py")).mtimeMs; } catch (_) {}
    let sMtime = 0;
    try { sMtime = fs.statSync(statsPath).mtimeMs; } catch (_) {}
    // scan.json 只影響「最近動過」的時間(renderer 靠 mtime 變了才重載):只掃參數、沒重跑回測的那一輪也要算動過
    let scMtime = 0;
    try { scMtime = fs.statSync(path.join(dir, "scan.json")).mtimeMs; } catch (_) {}
    const touched = Math.max(mtime, sMtime, scMtime);
    const hit = stratCache.get(name);
    if (hit && hit.mtime === sMtime && hit.cMtime === mtime) return { ...hit.summary, mtime: touched };
    let displayName = null;
    try { displayName = stratMeta(fs.readFileSync(path.join(dir, "strategy.py"), "utf8")).displayName; } catch (_) {}
    let summary = { name, displayName, hasBacktest: false, sharpe: null, totalReturn: null };
    if (sMtime) {
      try {
        const st = JSON.parse(fs.readFileSync(statsPath, "utf8"));
        summary = { name, displayName, hasBacktest: true, sharpe: num(st["Sharpe Ratio"]), totalReturn: num(st["Total Return [%]"]) };
        tm().track("first_backtest_done");   // 每個安裝只會送出一次(telemetry.js 自己記)
      } catch (_) { /* 寫到一半或壞掉:當成還沒有回測 */ }
    }
    stratCache.set(name, { mtime: sMtime, cMtime: mtime, summary });
    return { ...summary, mtime: touched };
  }).sort((a, b) => b.mtime - a.mtime);      // 最近動過的在上面
}

function loadStrategy(name) {
  if (!stratNames().includes(name)) return null;
  const dir = path.join(STRAT_DIR(), name);
  let stats = null, scan = null, code = "";
  try { stats = JSON.parse(fs.readFileSync(path.join(dir, "stats.json"), "utf8")); } catch (_) {}
  // 參數掃描(lib/param_scan.write_scan 的 scan.json):沒掃過 / 寫到一半 / 不是物件 → null,renderer 畫空狀態
  try { scan = JSON.parse(fs.readFileSync(path.join(dir, "scan.json"), "utf8")); } catch (_) {}
  if (!scan || typeof scan !== "object" || Array.isArray(scan)) scan = null;
  try { code = fs.readFileSync(path.join(dir, "strategy.py"), "utf8"); } catch (_) {}
  return { name, stats, scan, code, dataSources: stratDataSources(dir), ...stratMeta(code) };
}
/* 這支策略用到哪些自帶資料來源(`DATA_<來源>_<欄位>`)。掃的是資料夾內**所有 .py**,對齊 references/cloud-handoff.md §5 的
   `grep -oE "DATA_[A-Z0-9]+_" strategies/<name>/*.py` —— 只掃 strategy.py 的話,helper 檔用到的來源會被漏講(稽核 C1)。
   只回**來源名**,永遠不碰值。名字要過 datasrc.js 的白名單(同 §5 的 name_ok):`DATA_API_KEY` / `DATA_SECRET_KEY` 這種
   交易所形狀的名字機器端不會搬(handoff_env_merge 的 name_ok 拒掉),確認框列出來就是講出做不到的事。 */
function stratDataSources(dir) {
  const { checkName, checkField } = require("./datasrc");
  const out = new Set();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".py")).slice(0, 50); } catch (_) { return []; }
  for (const f of files) {
    let src = "";
    try { const p = path.join(dir, f); if (!fs.lstatSync(p).isFile()) continue; src = fs.readFileSync(p, "utf8"); } catch (_) { continue; }
    for (const m of src.matchAll(/\bDATA_([A-Z0-9]{1,24})_([A-Z][A-Z0-9_]{0,31})\b/g)) if (!checkName(m[1]) && !checkField(m[1], m[2])) out.add(m[1]);
  }
  return [...out].sort();
}

// 刪策略 = 整個資料夾丟進系統的垃圾桶(shell.trashItem),不是 rm:裡面有用戶的程式碼
// 與回測結果,誤刪要救得回來。回合進行中不給刪——agent 可能正在寫那個資料夾。
/* 這支策略還在下單設定的組合裡嗎(規則同機器端 `_cmd_delete_strategy`:amounts / weights / exchanges 三張表的 key 聯集,
   金額 0 也算——選到就跑)。回 true / false / null(檔案在但讀不懂:可能寫到一半,當成「不能確定」→ 不給刪)。
   沒有這個檔 = 從來沒設過組合 = false。 */
function inPortfolio(names) {
  const want = (Array.isArray(names) ? names : [names]).filter((n) => typeof n === "string" && n);   // 資料夾名 + 檔案裡的 STRATEGY_NAME,任一個在組合裡都算
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(WS, "manager", "portfolio_config.json"), "utf8")); }
  catch (e) { return e && e.code === "ENOENT" ? false : null; }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null;
  return ["amounts", "weights", "exchanges"].some((k) => cfg[k] && typeof cfg[k] === "object" && want.some((n) => Object.prototype.hasOwnProperty.call(cfg[k], n)));
}
/* 回 true(進垃圾桶了)或 { ok:false, code }:IN_PORTFOLIO(還在組合裡:對帳器照這個名字在下單,刪了訊號就凍住)/
   CONFIG_UNREADABLE(讀不到下單設定,寧可等一下)/ 其餘失敗 false */
async function deleteStrategy(name) {
  if (activeTurn || turnStarting || !stratNames().includes(name)) return false;   // 回合正要開始也不刪(agent 可能正要讀它)
  let sn = null; try { sn = stratMeta(fs.readFileSync(path.join(STRAT_DIR(), name, "strategy.py"), "utf8")).strategyName; } catch (_) { /* 讀不到檔:只比資料夾名 */ }
  const inPf = inPortfolio([name, sn]);
  if (inPf === true) return { ok: false, code: "IN_PORTFOLIO" };
  if (inPf === null) return { ok: false, code: "CONFIG_UNREADABLE" };
  try { await shell.trashItem(path.join(STRAT_DIR(), name)); stratCache.delete(name); return true; }
  catch (_) { return false; }
}

// ── 對話(session)─────────────────────────────────────────
// 逐字稿本來就由 runtime 存在 state/session.db(turns 表,長了會自己摘要壓縮)——外殼
// 只讀它來列清單、把舊對話畫回畫面,不另存一份。寫入只有「刪除」一種,而且 renderer
// 在回合進行中不給刪,不會跟 runtime 搶同一列。
// 只認外殼自己發的 id(desktop-xxxx):這個值會進 SQL 參數與 runtime 的命令列。
const SESSION_DB = path.join(BASE, "state", "session.db");
const okSessionId = (id) => typeof id === "string" && /^desktop-[a-z0-9]{4,16}$/.test(id);
function sessionDb(readOnly) {
  if (!fs.existsSync(SESSION_DB)) return null;      // 還沒跑過任何回合
  try { return new (require("node:sqlite").DatabaseSync)(SESSION_DB, { readOnly }); }
  catch (_) { return null; }
}
function listSessions() {
  const db = sessionDb(true); if (!db) return [];
  try {
    // 標題 = 第一句用戶的話(同雲端的預設標題);排序 = 最後活動時間
    return db.prepare(`
      SELECT s.session_id AS id, s.last AS last,
             (SELECT content FROM turns f WHERE f.session_id = s.session_id AND f.role = 'user'
              ORDER BY f.id LIMIT 1) AS title
      FROM (SELECT session_id, MAX(created_at) AS last FROM turns
            WHERE session_id LIKE 'desktop-%' GROUP BY session_id) s
      ORDER BY s.last DESC LIMIT 200`).all()
      .map((r) => ({ id: r.id, last: r.last, title: String(r.title || "").slice(0, 120) }));
  } catch (_) { return []; } finally { db.close(); }
}
function loadSession(id) {
  if (!okSessionId(id)) return [];
  const db = sessionDb(true); if (!db) return [];
  try {
    return db.prepare("SELECT role, content, created_at FROM turns WHERE session_id = ? ORDER BY id").all(id)
      .map((r) => ({ role: r.role, content: r.content, ts: r.created_at }));
  } catch (_) { return []; } finally { db.close(); }
}
function deleteSession(id) {
  if (!okSessionId(id) || activeTurn) return false;
  const db = sessionDb(false); if (!db) return false;
  try {
    db.prepare("DELETE FROM turns WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM session_meta WHERE session_id = ?").run(id);
    try { fs.rmSync(path.join(IMG_DIR, id), { recursive: true, force: true }); } catch (_) { /* 圖刪不掉不擋 */ }
    return true;
  } catch (_) { return false; } finally { db.close(); }
}

// ── 聊天裡的圖 ─────────────────────────────────────────
// agent 畫的圖怎麼進聊天欄:沿用雲端那條契約,不動 lib/。雲端是 `lib/notify.report_photo_web`
// 把圖 base64 POST 到 BLAVE_WEB_REPORT_URL(帶 x-api-key: proxy-<token>);電腦版在這裡開一個
// **只聽 127.0.0.1** 的接收端,把同樣三個環境變數指過來——`run()` 自動送的 pnl.png、
// 參數掃描的熱圖、agent 自己 savefig 的圖,全部不用改一行就會出現。
// 圖落地在 state/chat-images/<session>/,旁邊一份 index.jsonl(時間、檔名、說明):重開 app、
// 切回舊對話時照時間插回逐字稿中間。token 每次啟動重抽,只活在記憶體與子行程的環境變數裡。
const IMG_DIR = path.join(BASE, "state", "chat-images");
const IMG_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const IMG_MAX_BODY = 6 * 1024 * 1024;       // notify 那邊自己擋 3MB 原檔,base64 後約 4MB
const imgToken = crypto.randomBytes(24).toString("hex");
let imgPort = 0, imgWin = null, imgSeq = 0;
function imgAuthOk(h) {
  const a = Buffer.from(String(h || "")), b = Buffer.from("proxy-" + imgToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function startImageServer() {
  const srv = http.createServer((req, res) => {
    const end = (code) => { res.writeHead(code); res.end(); };
    if (req.method !== "POST" || req.url !== "/chat-image") return end(404);
    if (!imgAuthOk(req.headers["x-api-key"])) return end(403);
    const bufs = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > IMG_MAX_BODY) { req.destroy(); return; } bufs.push(c); });
    req.on("end", () => {
      try {
        const j = JSON.parse(Buffer.concat(bufs).toString("utf8"));
        const ext = IMG_EXT[j.mime];
        if (j.type !== "image" || !ext || !okSessionId(j.session_id) || typeof j.b64 !== "string") return end(400);
        const dir = path.join(IMG_DIR, j.session_id);
        fs.mkdirSync(dir, { recursive: true });
        const ts = Date.now() / 1000;
        const file = `${Math.round(ts * 1000)}-${++imgSeq}.${ext}`;   // 檔名我們自己取,不用對方給的
        fs.writeFileSync(path.join(dir, file), Buffer.from(j.b64, "base64"), { mode: 0o600 });
        const caption = typeof j.caption === "string" ? j.caption.slice(0, 500) : "";
        fs.appendFileSync(path.join(dir, "index.jsonl"), JSON.stringify({ ts, file, mime: j.mime, caption }) + "\n");
        if (imgWin && !imgWin.isDestroyed())
          imgWin.webContents.send("turn-event", { type: "image", session_id: j.session_id,
            src: `data:${j.mime};base64,${j.b64}`, caption });
        end(200);
      } catch (_) { end(400); }
    });
  });
  srv.listen(0, "127.0.0.1", () => { imgPort = srv.address().port; });
}
// 舊對話的圖:回傳 [{ts, src, caption}],renderer 照 ts 跟逐字稿交錯
function loadSessionImages(id) {
  if (!okSessionId(id)) return [];
  const dir = path.join(IMG_DIR, id);
  let lines = [];
  try { lines = fs.readFileSync(path.join(dir, "index.jsonl"), "utf8").split("\n").filter(Boolean); } catch (_) { return []; }
  const out = [];
  for (const l of lines) {
    try {
      const r = JSON.parse(l);
      if (!/^[0-9]+-[0-9]+\.(png|jpg|webp|gif)$/.test(r.file) || !IMG_EXT[r.mime]) continue;
      const b64 = fs.readFileSync(path.join(dir, r.file)).toString("base64");
      out.push({ ts: r.ts, src: `data:${r.mime};base64,${b64}`, caption: r.caption || "" });
    } catch (_) { /* 壞掉的一列跳過 */ }
  }
  return out;
}

/* ── 報告(renderer/reports.js;spec-desktop-0.1.6 §1.1)────────────────────────────
   本機視角的「袋」就是檔案系統:agent 照 references/reports.md 把報告寫進 <WS>/reports/<id>.json、圖放 <id>.files/。
   電腦版的 local_daemon 沒有起 report_uploader,所以報告永遠留在 drop dir、image block 永遠是 file 不是 sha256;
   reports/sent/ 今天是空的,但 uploader 哪天上桌面也不用改。renderer 不碰 fs:這裡讀好信封 / 本體 / 圖(data URI)才交過去。
   檔名 regex、2 MB 上限、mime 白名單都在這一層;block 內容不驗(那是 api 的事,渲染器對不認得的 block 本來就跳過)。 */
const RPT_DIR = () => path.join(WS, "reports");
const RPT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/, RPT_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const RPT_BYTES_MAX = 2 * 1024 * 1024, RPT_MAX = 200, RPT_IMAGES_MAX = 20, RPT_TITLE_MAX = 200, RPT_TYPE_MAX = 32;
const RPT_TS_MIN = 946684800, RPT_TS_MAX = 4102444800;   // created_at 只認 2000–2100 年的 unix 秒:agent 寫的 1e13 會讓 renderer 畫出 NaN
const RPT_IMAGES_BUDGET_MS = 60 * 1000, RPT_CLOUD_DOCS_MAX = 8;   // 雲端一份報告的圖加總最多等 60 秒(postJSON 單張 20 秒逾時 × 20 張太久);本體快取留 8 份(每份含 base64 圖)
const RPT_EXT_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
// 一份報告的信封(清單只讀這幾欄):id 缺就用檔名、有且不同 → 略過(同 uploader 的立場);標題 1–200 字,缺 → 略過;created_at 不是合理範圍的整數 → 檔案 mtime。
// mtime(ms)一併交出:同 id 覆寫(lib/report.py 明寫重用 id = 覆蓋)renderer 靠它認出「這份換過了」——本體快取與「有沒有新報告」都比它
function rptEnvelope(fileId, doc, mtimeMs) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  if (doc.id !== undefined && doc.id !== fileId) return null;
  const title = typeof doc.title === "string" ? doc.title.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, RPT_TITLE_MAX) : "";
  if (!title) return null;
  const created = Number.isInteger(doc.created_at) && doc.created_at >= RPT_TS_MIN && doc.created_at <= RPT_TS_MAX ? doc.created_at : Math.floor(mtimeMs / 1000);
  return { id: fileId, title, type: typeof doc.type === "string" ? doc.type.slice(0, RPT_TYPE_MAX) : null, created_at: created, mtime: Math.floor(mtimeMs) };
}
// 讀一份 <dir>/<id>.json:不是普通檔 / 超過 2 MB / JSON 壞 → null
function rptReadDoc(dir, id) {
  const f = path.join(dir, id + ".json");
  let st = null;
  try { st = fs.statSync(f); } catch (_) { return null; }
  if (!st.isFile() || st.size > RPT_BYTES_MAX) return null;
  try { const doc = JSON.parse(fs.readFileSync(f, "utf8")); return doc && typeof doc === "object" && !Array.isArray(doc) ? { doc, mtimeMs: st.mtimeMs } : null; } catch (_) { return null; }
}
const rptDirs = () => [RPT_DIR(), path.join(RPT_DIR(), "sent")];   // 同 id 以 drop dir 那份為準(先掃)
function reportsList() {
  const out = [], seen = new Set();
  for (const dir of rptDirs()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }   // 沒有目錄 / 讀不到 = 沒有報告,不畫錯誤
    for (const name of names) {
      if (!name.endsWith(".json")) continue;   // .json.tmp(半寫檔)、<id>.files/(sidecar)、failed/ 都不是報告
      const id = name.slice(0, -5);
      if (!RPT_ID_RE.test(id) || seen.has(id)) continue;
      const r = rptReadDoc(dir, id);
      const env = r ? rptEnvelope(id, r.doc, r.mtimeMs) : null;
      if (!env) continue;
      seen.add(id); out.push(env);
    }
  }
  out.sort((a, b) => b.created_at - a.created_at);
  return { reports: out.slice(0, RPT_MAX) };
}
// 本機一張圖 → data URI:file 只能是檔名(不含路徑)、副檔名決定 mime、≤ 2 MB;任一條不合就當沒有這張(渲染器畫失敗框)
function rptImageUri(dir, id, file) {
  if (typeof file !== "string" || !RPT_FILE_RE.test(file)) return null;
  const mime = RPT_EXT_MIME[file.slice(file.lastIndexOf(".") + 1).toLowerCase()];
  if (!mime || file.indexOf(".") < 0) return null;
  try {
    const f = path.join(dir, id + ".files", file), st = fs.statSync(f);
    if (!st.isFile() || st.size === 0 || st.size > RPT_BYTES_MAX) return null;
    return `data:${mime};base64,${fs.readFileSync(f).toString("base64")}`;
  } catch (_) { return null; }
}
function reportLoad(id) {
  if (typeof id !== "string" || !RPT_ID_RE.test(id)) return null;
  for (const dir of rptDirs()) {
    const r = rptReadDoc(dir, id);
    if (!r || !rptEnvelope(id, r.doc, r.mtimeMs)) continue;
    const images = {};
    let n = 0;
    for (const b of Array.isArray(r.doc.blocks) ? r.doc.blocks : []) {
      if (!b || typeof b !== "object" || b.type !== "image" || typeof b.file !== "string" || b.sha256 !== undefined || images[b.file] !== undefined) continue;   // 有 sha256 的不解析(本機不會有,防呆)
      if (++n > RPT_IMAGES_MAX) break;
      const uri = rptImageUri(dir, id, b.file);
      if (uri) images[b.file] = uri;
    }
    return { report: r.doc, images, mtime: Math.floor(r.mtimeMs) };
  }
  return null;
}
/* 雲端視角:平台的索引與 S3 本體(停機也讀得到)。兩支各快取 5 分鐘(清單 per 帳號、本體 per id),綁著拿到它的那顆 token——
   換帳號就對不上、登出時 clearToken 整組清掉;「新增報告」送出後的等待期間 renderer 帶 force 重問。
   圖:對 image block 的每個 sha256 打一次 /cloud/strategy_image(同一份去重、逐張、最多 20 張——超過的留給渲染器畫失敗框),
   單張失敗不擋整份。回 { code, report, images };report: null = 平台沒這份 */
let rptCloudList = null;   // { owner, at, r }
const rptCloudDocs = new Map();   // id → { owner, at, r }
function rptCloudInvalidate() { rptCloudList = null; rptCloudDocs.clear(); }
async function cloudReports(force) {
  const token = loadToken();
  if (!token) return { code: "UNREACH", reports: [] };
  if (!force && rptCloudList && rptCloudList.owner === token && Date.now() - rptCloudList.at < ACCT_FRESH_MS) return rptCloudList.r;
  const r = await cloudHost().reports();
  if (r.code === "OK") rptCloudList = { owner: token, at: Date.now(), r };
  return r;
}
// ver = renderer 從清單拿到的 stored_at(同 id 覆寫後索引會換),進快取 key:沒帶就只以 id 快取
async function cloudReport(id, ver) {
  const miss = { code: "UNREACH", report: null, images: {} };
  if (typeof id !== "string" || !RPT_ID_RE.test(id)) return miss;
  const token = loadToken();
  if (!token) return miss;
  const ck = id + "|" + (Number.isInteger(ver) ? ver : ""), hit = rptCloudDocs.get(ck);
  if (hit && hit.owner === token && Date.now() - hit.at < ACCT_FRESH_MS) return hit.r;
  const r = await cloudHost().report(id);
  if (r.code !== "OK") return miss;
  const images = {};
  if (r.report) {
    const shas = [];
    for (const b of r.report.blocks) {
      if (b && typeof b === "object" && b.type === "image" && typeof b.sha256 === "string" && /^[0-9a-f]{64}$/.test(b.sha256) && shas.indexOf(b.sha256) < 0) shas.push(b.sha256);
      if (shas.length >= RPT_IMAGES_MAX) break;
    }
    const t0 = Date.now();
    for (const sha of shas) {
      if (Date.now() - t0 > RPT_IMAGES_BUDGET_MS) break;   // 預算用完:剩下的留給渲染器畫失敗框,閱讀頁不能只掛著 spinner
      const im = await cloudHost().image(sha);
      if (im.code === "OK" && im.image) images[sha] = `data:${im.image.mime};base64,${im.image.b64}`;
    }
  }
  const out = { code: "OK", report: r.report, images };
  if (r.report) {   // 「平台沒這份」不記 5 分鐘:uploader 下一輪就可能把它送上去
    rptCloudDocs.set(ck, { owner: token, at: Date.now(), r: out });
    while (rptCloudDocs.size > RPT_CLOUD_DOCS_MAX) rptCloudDocs.delete(rptCloudDocs.keys().next().value);
  }
  return out;
}

// ── model / effort ─────────────────────────────────────────
// 三個引擎的選項來源不同,但交給 renderer 的形狀一樣:
//   { models: [{ id, name, efforts: [level…], defaultEffort }], defaultModel }
// efforts 是空陣列 = 這個 model 沒有 effort 可選,renderer 就不畫那條軌。
// **effort 的集合永遠跟著 model 走**——選不到不存在的組合,不必事後驗。
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// Claude Code 沒有本機型錄可讀,別名清單我們自己維護。
// haiku 的 efforts 是空的:實測(把 CLI 指到 mock upstream 看它送什麼)CLI 對 haiku
// 完全不送 output_config,`--effort` 不報錯但沒有任何作用——放一個按了沒反應的控件
// 比藏掉它更糟。
// 順序 = 模型強度,最強的在上面(三個引擎同一個規則)。預設不是第一個:預設跟著
// `defaultModel` 走(sonnet——每個方案都有、速度與能力的平衡點),「預設」徽章也是。
const CLAUDE_MODELS = [
  { id: "fable", name: "Fable", efforts: CLAUDE_EFFORTS, defaultEffort: "high" },
  { id: "opus", name: "Opus", efforts: CLAUDE_EFFORTS, defaultEffort: "high" },
  { id: "sonnet", name: "Sonnet", efforts: CLAUDE_EFFORTS, defaultEffort: "high" },
  { id: "haiku", name: "Haiku", efforts: [], defaultEffort: null },
];

// Codex 自己維護一份型錄(伺服器下發、帶 etag,會變):每個 model 的 effort 集合與
// 預設值都在裡面,`visibility: "hide"` 的(gpt-reserve、codex-auto-review)它自己
// 就標了,不必我們寫排除名單。
/* 用戶自己在 ~/.codex/config.toml 設的 model 與 effort。沒有 TOML parser 可用,也不值得
   為兩個頂層字串鍵裝一個:只讀第一個 [section] 之前的 `key = "value"`。
   讀不到就回空物件,下游退回型錄的預設。 */
function codexUserConfig() {
  try {
    const top = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8").split(/^\s*\[/m)[0];
    const pick = (k) => (new RegExp(`^\\s*${k}\\s*=\\s*"([^"\\n]+)"`, "m").exec(top) || [])[1] || null;
    return { model: pick("model"), effort: pick("model_reasoning_effort") };
  } catch (_) { return {}; }
}

function codexModels() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codex", "models_cache.json"), "utf8"));
    return (raw.models || [])
      .filter((m) => m.visibility === "list")
      .sort((a, b) => (a.priority || 0) - (b.priority || 0))
      .map((m) => ({
        id: m.slug, name: m.display_name || m.slug,
        efforts: (m.supported_reasoning_levels || []).map((e) => e.effort).filter(Boolean),
        defaultEffort: m.default_reasoning_level || null,
      }));
  } catch (_) { return []; }
}

// Blave AI:型錄來自 proxy 的 /v1/models(不花錢)。只拿 id——這個選擇器刻意不列
// 價格(Wei 拍板),所以也沒有「DeepSeek 尖峰 ×2 必標」的義務(那條只在列價時成立)。
// DeepSeek 的 effort 軌只有三格。它的 Anthropic 相容端點收 output_config.effort,但實際
// 只有三檔(官方 thinking_mode 文件:medium/xhigh 併進 high、ultra 併進 max)——五格裡
// 有兩格按了跟隔壁一樣,所以只列真的不同的三個。實測過:CLI 對 deepseek/* 照送 effort、
// proxy 原樣轉發、亂填的值 DeepSeek 回 422;Pro 同一題 low/high/max 輸出 151/283/354 token。
const DEEPSEEK_EFFORTS = ["low", "high", "max"];
const BLAVE_NAMES = {
  "anthropic/claude-haiku-4-5-20251001": "Haiku 4.5", "anthropic/claude-sonnet-5": "Sonnet 5",
  "anthropic/claude-opus-4-8": "Opus 4.8", "anthropic/claude-fable-5": "Fable 5",
  "deepseek/deepseek-v4-flash": "DeepSeek V4 Flash", "deepseek/deepseek-v4-pro": "DeepSeek V4 Pro",
};
const BLAVE_STRENGTH = [/fable/, /opus/, /sonnet/, /haiku/, /deepseek.*pro/, /deepseek.*flash/];
/* 帳號能不能用 Blave AI(綁卡流程用)。回 api 的 account_status 原樣,或 null(沒 token / 打不到 /
   舊 api)。null 時 renderer 不猜——沿用「沒額度 → 儲值」那組舊文案。 */
async function accountStatus() {
  const acct = loadToken();
  if (!acct) return null;
  try {
    const r = await getJSON(`${API_BASE}/openclaw/proxy/v1/account_status`, { "x-api-key": `proxy-${acct}` });
    if (r.status !== 200) return null;
    const b = r.body && (r.body.data || r.body);
    if (!(b && typeof b.can_run === "boolean")) return null;
    if (loadToken() !== acct) return null;          // 在途時登出 / 換了帳號:舊帳號的答案不寫回、不回給畫面
    lastAcct = { at: Date.now(), body: b };
    return b;
  } catch (_) { return null; }
}
/* 沒登入時方案頁要的數字(試用天數 / AI 額度 / 驗證金 / 自動儲值 / Starter 月價)。公開端點、不帶任何
   憑證;月價 = Starter 時價 × 720(跟 api 的 plan.monthly 同一個算法)。舊 api 沒有 trial 欄 → 回 null,
   畫面用不帶數字的退化句。 */
let pubCache = null;
/* public_tiers 的原始回應(匿名端點)。方案頁的數字與最低版本閘讀的是同一支:只有這一條讀取、這一份一小時的快取。
   回 body 或 null(打不到 / 不是 200 / 不是物件)。force = 不看快取(版本閘在動作前補問用);問不到時舊快取不動。 */
async function publicTiers(force) {
  if (!force && pubCache && Date.now() - pubCache.at < 3600000) return pubCache.body;
  try {
    const r = await getJSON(`${API_BASE}/openclaw/public_tiers`, {});
    const b = r.status === 200 && r.body && (r.body.data || r.body);
    if (!b || typeof b !== "object" || Array.isArray(b)) return null;
    pubCache = { at: Date.now(), body: b };
    return b;
  } catch (_) { return null; }
}
async function publicPricing() {
  const b = await publicTiers(false);
  if (!(b && b.trial && Number(b.trial.days) > 0)) return null;
  const st = (Array.isArray(b.linux) ? b.linux : []).find((x) => x && x.label === "Starter");
  const hr = st && Number(st.twd_per_hour) > 0 ? Number(st.twd_per_hour) : null;
  return { trial: b.trial, starter_hourly: hr, starter_monthly: hr ? Math.round(hr * 720) : null };
}
// ── 最低版本閘(minversion.js;spec §13 第 4 點)──────────────────
// 安全事故用:api 說這個版本已停用 → 擋新的下單啟動與 Blave AI,只留更新。失敗方向一律放行(檔頭有完整規則)。
let _gate = null;
function minGate() {
  if (_gate) return _gate;
  _gate = require("./minversion").createGate({
    currentVersion: app.getVersion(), fetchTiers: (force) => publicTiers(force),
    onChange: (st) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && isOurPageUrl(w.webContents.getURL())) w.webContents.send("min-version-state", st); },
    onBlocked: () => { try { updater().check(); } catch (_) { /* 沒有更新來源的包:畫面只會說需要更新 */ } },   // 被擋的那一刻就去找新版,不等 4 小時的節拍
    log: (m) => console.error("[min-version] " + m),
  });
  return _gate;
}
/* account_status 的資料狀態:"included"(試用 / 名下有主機 / API 方案,免費)、"billed"(按有用到的整點小時收)、
   "none"(這一小時付不出來),或 null。舊 api 沒有 data_access(外殼比 api 先出)、或值認不得:退回布林 data_included,
   跟以前一模一樣——讀不到新欄位就照舊,不自己發明狀態(同 desktop.min_version 契約的失敗方向)。renderer 有同一支 */
function dataAccessOf(b) {
  if (!b) return null;
  return ["included", "billed", "none"].includes(b.data_access) ? b.data_access : b.data_included === true ? "included" : null;
}
/* 這個帳號現在拿不拿得到 Blave 資料:免費含在裡面、或按小時付得起,都算。畫面的預檢與回前景重查
   都會打 account_status,這裡吃它最後一次的結果;太舊(或還沒打過)才自己補打一次——這支跟
   LLM 共用每分鐘 30 次的桶,不能每一輪都打。查不到就當沒有:寧可這一輪少資料,也不要把 key
   寫給一個拿不到資料的帳號。 */
let lastAcct = null;
const ACCT_FRESH_MS = 5 * 60 * 1000;
async function hasBlaveData() {
  const fresh = () => lastAcct && Date.now() - lastAcct.at <= ACCT_FRESH_MS;
  if (!fresh()) await accountStatus();
  const a = fresh() ? dataAccessOf(lastAcct.body) : null;   // 補打失敗就是查不到:舊答案不沿用
  return a === "included" || a === "billed";
}
/* BLAVE_DATA_ACCESS=0 的**原因**(BLAVE_DATA_ACCESS_WHY;hasBlaveData 之後叫):signed_out / no_card / no_balance / unknown。
   runtime 那段規則只知道「沒資料」時,agent 會對登入著、只是餘額不夠的人說「要先登入」(09-24 真機)——外殼明明知道原因。
   account_status 的 reason 只在 can_run=false 時有值(NO_CARD / NO_CREDIT);data_access=none 而 reason 空的組合
   (api 沒禁)當餘額不夠。查不到(沒打到 / 太舊)就 unknown,不沿用舊答案,同 hasBlaveData。
   舊 api 只有 data_included:false、沒有 data_access:那個布林是「不含資料」不是「餘額不夠」,也 unknown。 */
function dataAccessWhy(signedIn) {
  if (!signedIn) return "signed_out";
  const b = lastAcct && Date.now() - lastAcct.at <= ACCT_FRESH_MS ? lastAcct.body : null;
  if (!b) return "unknown";
  // 帳號有資料、本機卻沒有 key 檔(syncDataEnv 回 none):不是錢的問題,也講不出是什麼,只能說讀不到
  if (dataAccessOf(b) !== "none") return "unknown";
  return b.reason === "NO_CARD" ? "no_card" : "no_balance";
}

/* ── 策略庫(renderer/library.js)──────────────────────────────
   清單 = GET /openclaw/marketplace/strategies(公開端點,renderer 的 CSP 不外連,所以在這裡打)。登入了就帶桌面資料 key
   (token_optional 認它、GET 一律放行)才拿得到 purchased / is_owner;沒有 key 就匿名。回應當不可信輸入:逐欄驗型別、
   壞的那一筆整筆丟掉、清單不是陣列 → null(畫面畫「讀不到」)。快取 5 分鐘(同 ACCT_FRESH_MS);身分或語言換了就重打。 */
const LIB_TITLE_MAX = 200, LIB_TEXT_MAX = 5000, LIB_STR_MAX = 60, LIB_SPARK_MAX = 512, LIB_EQUITY_MAX = 400;
const LIB_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const libFin = (v) => (typeof v === "number" && isFinite(v) ? v : null);
const libDay = (v) => (typeof v === "string" && LIB_DAY_RE.test(v) ? v : null);
// 權益曲線:2 點起、上限給定、全部有限正數(累積報酬倍數)
const libCurveOk = (v, max) => (Array.isArray(v) && v.length >= 2 && v.length <= max && v.every((x) => typeof x === "number" && isFinite(x) && x > 0) ? v.slice() : null);
function libSanitize(body) {
  const list = body && typeof body === "object" && Array.isArray(body.strategies) ? body.strategies : null;
  if (!list) return null;
  // 控制字元一律拿掉;multi = 保留換行(說明要分段),否則連換行都拿掉(標題會進送給 agent 的那句話)
  const str = (v, max, multi) => (typeof v === "string" ? v.replace(multi ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, " ").slice(0, max) : null);
  const fin = libFin, day = libDay;
  const gate = (v) => (v === "pass" || v === "fail" || v === "na" ? v : null);
  const out = [];
  for (const s of list) {
    if (!s || typeof s !== "object") continue;
    const id = Number.isInteger(s.id) && s.id > 0 ? s.id : null, title = (str(s.title, LIB_TITLE_MAX) || "").trim();
    const price = fin(s.price);
    if (!id || !title || price === null || price < 0) continue;
    let report = null;
    if (s.report && typeof s.report === "object") {
      const r = s.report, g = r.gate_checks && typeof r.gate_checks === "object" ? r.gate_checks : null;
      const gc = g ? { mcpt: gate(g.mcpt), robust: gate(g.robust), fee: gate(g.fee) } : null;
      // 關卡的原始數值只收畫面要印的四個(p 值、鄰域保留比、假設 / 交易所費率);判定仍只認 api 的 gate_checks
      const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
      const gw = obj(r.gates), rob = (gw && obj(gw.robust)) || {}, fee = (gw && obj(gw.fee)) || {};
      report = { total_return: fin(r.total_return), annual_return: fin(r.annual_return), sharpe: fin(r.sharpe), max_drawdown: fin(r.max_drawdown), symbol: str(r.symbol, LIB_STR_MAX), interval: str(r.interval, LIB_STR_MAX),
        gate_checks: gc && gc.mcpt && gc.robust && gc.fee ? gc : null, gates: gw ? { mcpt_p: fin(gw.mcpt_p), robust: { ratio: fin(rob.ratio) }, fee: { rate: fin(fee.rate), actual: fin(fee.actual) } } : null,
        spark: libCurveOk(r.spark, LIB_SPARK_MAX), equity_from: day(r.equity_from), equity_to: day(r.equity_to) };
    }
    out.push({ id, title, summary: str(s.summary, LIB_TEXT_MAX, true), description: str(s.description, LIB_TEXT_MAX, true), price, category: str(s.category, LIB_STR_MAX),
      created_at: str(s.created_at, LIB_STR_MAX), purchase_count: Number.isInteger(s.purchase_count) && s.purchase_count >= 0 ? s.purchase_count : 0,
      purchased: s.purchased === true, is_owner: s.is_owner === true, is_official: s.is_official === true, verified: s.verified === true,
      direction: str(s.direction, LIB_STR_MAX), max_exposure: fin(s.max_exposure), report });
  }
  return out;
}
let libCache = null;   // { at, lang, signedIn, strategies }
async function libraryList(langRaw, force) {
  const lang = langRaw === "en" ? "en" : "zh";
  const signedIn = !!loadToken();
  let dataAccess = null;
  // 閘門要的「含不含資料」跟每一輪開跑前問的是同一份(hasBlaveData 太舊才補打);查不到就 null,畫面不猜
  if (signedIn) { await hasBlaveData(); dataAccess = lastAcct && Date.now() - lastAcct.at <= ACCT_FRESH_MS ? dataAccessOf(lastAcct.body) : null; }
  // why:付不出資料費的原因(no_card / no_balance / unknown)——renderer 的 CTA 照它分流,不自己從 acct 再算一套
  const why = dataAccess === "none" ? dataAccessWhy(signedIn) : null;
  if (!force && libCache && libCache.lang === lang && libCache.signedIn === signedIn && Date.now() - libCache.at < ACCT_FRESH_MS) return { strategies: libCache.strategies, signedIn, dataAccess, why };
  const url = `${API_BASE}/openclaw/marketplace/strategies?lang=${lang}`;
  const key = signedIn ? loadDataKey() : null;
  let r = null;
  try {
    r = await getJSON(url, key ? { "api-key": key.api_key, "secret-key": key.secret_key } : {});
    if (key && r.status === 403) r = await getJSON(url, {});   // key 被撤了(別台登出、換帳號):退成匿名清單,purchased 一律 false
  } catch (_) { return null; }
  if (r.status !== 200) return null;
  const strategies = libSanitize(r.body);
  if (!strategies) return null;
  libCache = { at: Date.now(), lang, signedIn, strategies };
  return { strategies, signedIn, dataAccess, why };
}
/* 詳情的完整報告:GET /openclaw/marketplace/strategies/<id>/report——只取 400 點權益曲線與回測期間(總報酬、關卡數值走清單:
   一支資料一個來源)。公開策略匿名也拿得到;內容不隨身分變,快取 5 分鐘 per (id, lang)、登出 / 購買不用清。非 200 / 形狀不對 → null。 */
function libReportSanitize(body) {
  if (!body || typeof body !== "object") return null;
  const r = { equity: libCurveOk(body.equity, LIB_EQUITY_MAX), equity_from: libDay(body.equity_from), equity_to: libDay(body.equity_to), backtest_start: libDay(body.backtest_start), backtest_end: libDay(body.backtest_end) };
  return r.equity || r.backtest_start || r.backtest_end ? r : null;   // 全空(S3 暫時讀不到時 api 回 200 + 全 null)= 沒東西可套:當失敗、不進快取,下次再問
}
const libReportCache = new Map();   // `${id}:${lang}` → { at, report }
async function libraryReport(id, langRaw) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const lang = langRaw === "en" ? "en" : "zh", ck = `${id}:${lang}`, hit = libReportCache.get(ck);
  if (hit && Date.now() - hit.at < ACCT_FRESH_MS) return hit.report;
  const url = `${API_BASE}/openclaw/marketplace/strategies/${id}/report?lang=${lang}`;
  const key = loadToken() ? loadDataKey() : null;
  let r = null;
  try {
    r = await getJSON(url, key ? { "api-key": key.api_key, "secret-key": key.secret_key } : {});
    if (key && r.status === 403) r = await getJSON(url, {});
  } catch (_) { return null; }
  if (r.status !== 200) return null;
  const report = libReportSanitize(r.body);
  if (!report) return null;
  libReportCache.set(ck, { at: Date.now(), report });
  return report;
}
/* 購買付費策略:POST /oauth/desktop/marketplace/purchase,帶帳號 token + app_secret(同 planStart:會動餘額與信用卡,
   帳號 token 單獨不准)。回 { status, body }:body 只留畫面分支要的幾欄;打不到 → { status: 0, body: null }。 */
function libPurchaseBody(b) {
  if (!b || typeof b !== "object") return null;
  const s = (v) => (typeof v === "string" ? v.slice(0, 200) : null), n = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  return { status: s(b.status), error: s(b.error), error_code: s(b.error_code), needs_topup: b.needs_topup === true, has_card: b.has_card === true, balance: n(b.balance), required: n(b.required) };
}
async function libraryPurchase(strategyId, confirmTopup) {
  if (!Number.isInteger(strategyId) || strategyId <= 0) return { status: 400, body: { error_code: "STRATEGY_ID_REQUIRED" } };
  const token = loadToken(), secret = loadAppSecret();
  if (!token) return { status: 401, body: libPurchaseBody({ error_code: "INVALID_CREDENTIALS" }) };
  if (!secret) return { status: 401, body: libPurchaseBody({ error_code: "APP_SECRET_REQUIRED" }) };
  let r = null;
  try { r = await postJSON(`${API_BASE}/oauth/desktop/marketplace/purchase`, { token, app_secret: secret, strategy_id: strategyId, confirm_topup: confirmTopup === true }); }
  catch (_) { return { status: 0, body: null }; }
  libCache = null;   // 買了(或另一台正在買)之後 purchased 會變:下次開清單重打
  return { status: r.status, body: libPurchaseBody(r.body) };
}
/* 「已安裝」對照表(規格 §1.2):{ marketplace id → 本機策略資料夾名 },只有這台電腦視角在用。存 userData、不進 workspace
   (agent 讀得到 workspace;這張表是外殼自己的記憶)。patch = { id, name } 記一筆、{ id, name: null } 拿掉一筆、不給只讀。 */
const libInstalledPath = () => path.join(app.getPath("userData"), "library-installed.json");
const LIB_NAME_RE = /^[^./\\\u0000-\u001f][^/\\\u0000-\u001f]{0,127}$/;   // 資料夾名:同 stratNames 的排除(不以 . 開頭)、不含路徑分隔
function libInstalledClean(m) {
  const out = {};
  if (!m || typeof m !== "object" || Array.isArray(m)) return out;
  for (const k of Object.keys(m)) if (/^[1-9]\d{0,9}$/.test(k) && typeof m[k] === "string" && LIB_NAME_RE.test(m[k])) out[k] = m[k];
  return out;
}
function libraryInstalled(patch) {
  let m = {};
  try { m = libInstalledClean(JSON.parse(fs.readFileSync(libInstalledPath(), "utf8"))); } catch (_) { /* 沒有檔 / 壞掉:當空表 */ }
  if (!patch || typeof patch !== "object" || !Number.isInteger(patch.id) || patch.id <= 0) return m;
  if (patch.name === null) delete m[String(patch.id)];
  else if (typeof patch.name === "string" && LIB_NAME_RE.test(patch.name)) m[String(patch.id)] = patch.name;
  else return m;
  try { fs.writeFileSync(libInstalledPath(), JSON.stringify(m), { mode: 0o600 }); } catch (_) { /* 寫不進去:這一次的記憶只在畫面上 */ }
  return m;
}

async function blaveModels() {
  const acct = loadToken();
  if (!acct) return [];
  try {
    const r = await getJSON(`${API_BASE}/openclaw/proxy/v1/models`, { "x-api-key": `proxy-${acct}` });
    if (r.status !== 200) return [];
    // proxy 的型錄順序是 haiku→sonnet→opus→fable→deepseek,照強度重排;
    // 不認得的新 model 排最後(不擋,它會照 API 給的順序出現)。
    const rank = (id) => { const i = BLAVE_STRENGTH.findIndex((re) => re.test(id)); return i < 0 ? 99 : i; };
    return (r.body.data || []).map((m) => {
      const claude = /^anthropic\//.test(m.id) && !/haiku/.test(m.id);
      const efforts = claude ? CLAUDE_EFFORTS : /^deepseek\//.test(m.id) ? DEEPSEEK_EFFORTS : [];
      return { id: m.id, name: BLAVE_NAMES[m.id] || m.id,
               efforts, defaultEffort: efforts.length ? "high" : null };
    }).sort((a, b) => rank(a.id) - rank(b.id));
  } catch (_) { return []; }
}

async function modelOptions(kind) {
  if (kind === "codex") {
    const models = codexModels();
    // 起始值 = 用戶自己在 config.toml 設的(而且型錄裡真的有),不然才是型錄第一個。
    // 少了這段,一個設了 gpt-5.5 + high 的人從沒碰過選擇器,卻每輪被換成型錄的第一個。
    const mine = codexUserConfig();
    const d = models.find((m) => m.id === mine.model) || models[0];
    if (d && mine.effort && d.efforts.includes(mine.effort)) d.defaultEffort = mine.effort;
    return { models, defaultModel: d ? d.id : null };
  }
  if (kind === "blave") {
    const models = await blaveModels();
    // Blave 線的預設是 DeepSeek V4 Pro(Wei 指定);型錄裡沒有才退 sonnet
    const d = models.find((m) => /deepseek.*pro/.test(m.id)) || models.find((m) => /sonnet/.test(m.id)) || models[0];
    return { models, defaultModel: d ? d.id : null };
  }
  return { models: CLAUDE_MODELS, defaultModel: "sonnet" };
}

// 選擇按引擎各記一組,跨重啟保留:{ codex: { model, efforts: { <model>: <level> } }, … }
const prefsPath = () => path.join(app.getPath("userData"), "model-prefs.json");
function loadModelPrefs() {
  try { return JSON.parse(fs.readFileSync(prefsPath(), "utf8")); } catch (_) { return {}; }
}
function saveModelPrefs(prefs) {
  fs.writeFileSync(prefsPath(), JSON.stringify(prefs || {}));
  return true;
}

// 縱深防禦:這兩個值最後會進 `codex exec` 的 argv。全程沒有經過 shell、Codex 的
// `-c k=v` 也只取我們寫死的那個 key,所以打不穿;但以 `-` 開頭或夾空白的值會讓該輪
// 直接 exit 2,而 model-prefs.json 是磁碟上的檔案、內容不可信。形狀不對就當沒帶。
const SAFE_ID = /^[A-Za-z0-9][\w.:\/-]{0,127}$/;
const safeId = (v) => (typeof v === "string" && SAFE_ID.test(v) ? v : null);

let activeTurn = null, turnStarting = false;
/* 本機常駐程式的宿主(daemon.js)。環境只給 daemon 需要的:路徑、PATH、K 線來源——**不含**帳號 token
   與任何 Blave 憑證(策略碼跑在它底下)。引擎還沒裝好(沒有 venv)就不起。 */
let _tradeHost = null;
function tradeHost() {
  if (!_tradeHost) {
    _tradeHost = createDaemonHost({
      python: VENV_PY, script: path.join(REPO, "runtime", "local_daemon.py"), base: BASE, workspace: WS,
      env: childEnv({ PATH: path.join(BASE, "venv", VENV_BIN) + path.delimiter + (process.env.PATH || "/usr/bin:/bin"), HOME: os.homedir(),
        USER: process.env.USER || os.userInfo().username, LANG: process.env.LANG || "en_US.UTF-8",
        TMPDIR: process.env.TMPDIR || os.tmpdir(), BLAVE_KLINE_SOURCE: "binance",
        BLAVE_AGENT_HOME: BASE, BLAVE_AGENT_STATE: path.join(BASE, "state"),
        ...PY_ENV }),   // 打包版不讓 Python 把 __pycache__ 寫進 .app(簽章後 bundle 一變 codesign --verify 就不過)
      log: (m) => console.error("[trade]", m),
    });
  }
  return _tradeHost;
}
function tradeStartIfReady() {
  try { if (fs.existsSync(VENV_PY) && fs.existsSync(WS)) { tradeHost().start(); binanceLink().start(); } } catch (e) { console.error("[trade] start failed", e && e.message); }
}
/* Binance 真錢連接(binance_link.js)。金鑰只從 renderer 的表單經過這裡一次:查過權限 → 用 trusted 的路交給 daemon 寫進 workspace 的 .env。
   這裡不 log 金鑰、不另存;落地的 state 檔只有檢查結果與當時的對外 IP。my_ip 要帳號 token(沒登入 Blave 的人查不到 IP,表單照樣能用)。 */
let _binanceLink = null, binanceStarted = false;
const binanceStatePath = () => path.join(app.getPath("userData"), "binance-link.json");
// 真實交易所的金鑰只從這裡進 daemon(trusted:daemon.js TRUSTED_SETS 一家一組);renderer 的 trade-send 只收模擬交易
const sendTrustedCreds = (env) => tradeHost().send("credentials", { env }, { trusted: true });
function binanceLink() {
  if (!_binanceLink) {
    _binanceLink = require("./binance_link").createBinanceLink({
      http: (u, h) => getJSON(u, h),
      myIp: () => { const tok = loadToken(); if (!tok) return Promise.resolve(null); return postJSON(`${API_BASE}/oauth/desktop/my_ip`, { token: tok }, { family: 4 }); },
      send: sendTrustedCreds,
      readEnv: () => { try { return fs.readFileSync(path.join(WS, ".env"), "utf8"); } catch (_) { return null; } },
      loadState: () => JSON.parse(fs.readFileSync(binanceStatePath(), "utf8")),
      saveState: (o) => fs.writeFileSync(binanceStatePath(), JSON.stringify(o), { mode: 0o600 }),
      notify: (v) => binanceNotify(v),
      onChange: (st) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && isOurPageUrl(w.webContents.getURL())) w.webContents.send("binance-state", st); },
    });
  }
  return { ..._binanceLink, start() {
    if (binanceStarted) return; binanceStarted = true; _binanceLink.start();
    // 睡眠時 24 小時的 timer 不走:醒來時過期了才補查(binance_link.recheckIfDue)
    try { require("electron").powerMonitor.on("resume", () => _binanceLink.recheckIfDue()); } catch (_) { /* 沒有 powerMonitor 就只靠 timer */ }
  } };
}
/* 用戶送出當下畫面上開著什麼(runtime 的 --viewing-*,跟雲端工作頁同一份契約):只用來釐清「這支 / 這裡」指的是誰,
   不是工作指令。值來自 renderer,會進命令列與 prompt:策略名只認沒有控制字元與方括號的短字串(方括號是 runtime 包這段
   脈絡用的界線),tab / view 只認白名單。tests/check_shell_viewing.js 從原文切出來跑。
   `--viewing-env=cloud`(A′:操作對象隨視角走):用戶送出時看的是雲端視角 → 這一句要做在雲端主機上,而且
   --viewing-strategy 指的是**雲端那一份**同名策略,不是這台電腦的。只送 cloud;這台電腦是預設、不送(舊 runtime 的行為
   逐位元組不變)。**runtime 那半(agent_turn.py 認這個旗標、進 prompt)由另一批接**——它落地之前 argparse 會把這個旗標當
   未知選項、整輪 exit 2,所以 check_shell_viewing.js 釘著「runtime 認得 --viewing-env」,兩半沒接齊就紅。 */
function viewingArgs(v) {
  if (!v || typeof v !== "object") return [];
  const env = v.env === "cloud" ? ["--viewing-env=cloud"] : [];
  const name = typeof v.strategy === "string" && /^[^\u0000-\u001f\u007f\[\]「」\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]{1,200}$/.test(v.strategy) ? v.strategy : null;
  // 一律 --flag=value 單一 argv(同雲端的 runtime/web_bridge.py):分開寫的話,目錄名以 - 開頭的策略會被 argparse 當成旗標,整輪 exit 2
  if (name) return ["--viewing-strategy=" + name, ...(v.tab === "code" || v.tab === "data" ? ["--viewing-tab=" + v.tab] : []), ...env];
  return [...(v.view === "portfolio" ? ["--viewing-view=portfolio"] : []), ...env];
}
/* 自動掛上 `blave` MCP(agent 經它拿得到用戶雲端主機的 SSH)+ 畫面上的「送上雲端 / 拉回這台電腦」。
   **2026-09-22 Wei 拍板打開**:三個前置都完成了——sshd 方案 A 已推上全機隊 20 台(憑證只登得進 blaveagent、root 被 Match 擋掉)、
   接入碼撤銷端點上線、確認框只列真正會搬的資料來源金鑰。發佈版一律是這個常數;開發版另可用 BLAVE_CLOUD_HANDOFF=1
   (主行程自己的環境,agent 設不到;發佈版不看它)。 */
const CLOUD_HANDOFF = true;
function cloudHandoffOn() { return CLOUD_HANDOFF || (!(app.isPackaged && require("./package.json").blaveRelease) && process.env.BLAVE_CLOUD_HANDOFF === "1"); }
/* 接入碼(mcpcode.js):只在主行程的記憶體裡。用帳號 token + app_secret 去換——那兩顆都不進 agent;換出來的碼只經由單次設定檔交給 CLI。 */
let _mcp = null;
const mcpDir = () => path.join(app.getPath("userData"), "mcp");   // workspace 以外:agent 的工作目錄裡看不到它
function mcpCode() {
  if (!_mcp) _mcp = require("./mcpcode").createMcpCode({ apiBase: API_BASE, post: (u, b) => postJSON(u, b),
    getCreds: () => { const token = loadToken(); return token ? { token, appSecret: loadAppSecret() } : null; } });
  return _mcp;
}
/* 這一輪帶哪些憑證(純函式;tests/check_shell_data_env.js 從原文切出來跑)。三顆各看各的:
     proxyToken(帳號 token,會燒 Blave AI 額度)= **連的是 Blave AI** 而且有登入;
     dataKey(縮權的資料 key,不能呼叫 LLM)= **有登入而且帳號含資料**,不看連的是誰——自帶 Claude Code / Codex 的人登入後也拿得到資料。
     mcp(要不要去換接入碼、掛上 `blave` MCP)= **功能開著而且有登入**,一樣不看連的是誰(MCP 呼叫不經 LLM proxy、不計費);
       有沒有雲端主機由換碼的端點回答(沒有 = 409 = 不掛),所以不在這裡判。它開著**不會**讓帳號 token 進環境。
   沒登入三個都沒有;included 查不到(null / undefined)當沒有。 */
function turnCreds(kind, signedIn, included, handoffOn) {
  return { proxyToken: kind === "blave" && signedIn === true, dataKey: signedIn === true && included === true, mcp: handoffOn === true && signedIn === true };
}
const MESSAGE_MAX_BYTES = 1024 * 1024;   // 同 runtime/agent_turn.py 的 MESSAGE_STDIN_MAX
async function runTurn(win, { sessionId, message, model: rawModel, effort: rawEffort, viewing }) {
  const model = safeId(rawModel), effort = safeId(rawEffort);
  // 這個值會進命令列、SQL 參數與圖檔目錄名,只認外殼自己發的格式
  if (!okSessionId(sessionId)) throw new Error("bad session id");
  // 訊息走 stdin:不是字串的話 stdin.end() 會拋、留下一支等不到 EOF 的子行程(稽核 R4)。上限同 runtime 的 --message-stdin
  if (typeof message !== "string" || Buffer.byteLength(message, "utf8") > MESSAGE_MAX_BYTES) throw new Error("bad message");
  imgWin = win;
  const envPath = await loginShellPath();
  // 用戶連的是哪一個,引擎就跑哪一個。原本這裡完全不看 kind,一律 spawn Claude
  // 那條路——選了 Codex 的人第一句話就失敗(引擎去找 `claude`)。
  const conn = loadConnection() || {};
  // codex 的執行檔一律用**當下偵測到的**,不用連結紀錄裡那個路徑:舊版明文檔遷移過來的 path 是 agent 寫得到的字(稽核 R4)。
  // 偵測不到就**整輪失敗**,絕不退回去跑 Claude(稽核 ①):用戶連的是 Codex,靜默換一家供應商 = 換一條帳、換一個模型,
  // 而畫面上的連線狀態還寫著 Codex。畫面會請他重新偵測 / 重連。
  const codexBin = conn.kind === "codex" ? await codexBinNow() : null;
  if (conn.kind === "codex" && !codexBin) throw new Error("AGENT_BIN_MISSING");
  const useCodex = !!codexBin;
  // 本機模式契約(runtime CHANGELOG Unreleased):不帶 BLAVE_PROXY_TOKEN、
  // 不帶 ANTHROPIC_*;PATH/HOME 必帶(GUI app 的 PATH 極簡)。
  // **看連的是誰,不是看手上有沒有 token**:登入過 Blave、後來改連自己的 Claude Code 的人,
  // token 還在 Keychain 裡——照「有 token 就帶」會讓他以為在用自己的訂閱、實際上燒 Blave 額度
  // 資料則相反——**看有沒有登入,不看連的是誰**:登入 Blave 是帳號的事,資料 key 是另一把縮權的 key
  // (不能呼叫 LLM),給自帶 CLI 的人不會燒到他的 AI 額度;沒有主機 / 試用 / 方案時它按小時收資料費,不碰 AI 額度。
  const signedIn = !!loadToken();
  const plan = turnCreds(conn.kind, signedIn, signedIn && await hasBlaveData(), cloudHandoffOn());
  const useBlave = conn.kind === "blave";
  const acct = plan.proxyToken ? loadToken() : null;
  const dataAccess = syncDataEnv(plan.dataKey);
  // `blave` MCP:拿得到碼才掛;拿不到(沒主機、端點還沒上線、被限速、連不上)= 這一輪不掛,回合照常。
  // 兩條引擎都寫同一份單次設定檔(0600、workspace 以外、回合結束就刪),runtime 用 --mcp-config 判「這一輪有沒有掛」。
  // Claude 經那份檔吃 MCP;Codex 不吃檔——吃 `-c mcp_servers.blave.*`(runtime/codex_engine.py 組)+ 只給 codex 子行程的
  // 環境變數 BLAVE_MCP_TOKEN,碼連路徑都不上 argv。撞名、版本 < 0.146.0、shell_snapshot 關不掉由
  // codex_engine 判,不掛就把變數拔掉再 spawn。
  // 登記(blave-canon output/research/2026-09-22-codex-cli-mcp-support.md §四):Codex 沒有等價 Claude 的
  // strict_mcp_config + setting_sources=[],用戶全域與 <workspace>/.codex/config.toml 的 MCP 照樣載入——後者 agent 寫得到,
  // 等於能替自己加掛 MCP server。本案不改變這點,另案處理。
  let mcpFile = null, mcpMount = null;
  if (plan.mcp) { mcpMount = await mcpCode().get(); if (mcpMount) mcpFile = require("./mcpcode").writeConfig(mcpDir(), mcpMount); }
  const env = {
    // venv/bin 放最前面:Claude Code 的 Bash 直接繼承這個 PATH,`python3` 就是我們的。
    // 但這對 Codex 無效——它用登入 shell(`zsh -lc`)跑指令,profile 會把 PATH 重排
    // (實測:前置的路徑被擠到 Homebrew 後面)。所以另外給 BLAVE_PYTHON,runtime 會把
    // 「這個 workspace 的 python 是哪一顆」明寫進 prompt——環境變數不會被重排。
    PATH: path.join(BASE, "venv", VENV_BIN) + path.delimiter + envPath, HOME: os.homedir(),
    BLAVE_PYTHON: VENV_PY,
    // 有帳號 token = 用 Blave AI:runtime 照舊送 proxy-{BLAVE_PROXY_TOKEN},
    // 自然變成 proxy-acct-…,runtime 一行都不用改。沒有就什麼都不設,
    // runtime 的本機分支會把 ANTHROPIC_* 拔掉、用戶自己的 CLI 登入生效。
    ...(acct ? { BLAVE_PROXY_TOKEN: acct } : {}),
    // 接入碼只在 Codex 引擎進環境(Claude 走 --mcp-config 的檔)。Codex 預設會把整份環境(含 *TOKEN*)傳給 agent 跑的
    // shell,codex_engine 掛上時用 filters 只拔這一個、並關掉會繞過 filters 的 shell_snapshot
    ...(useCodex && mcpFile ? { BLAVE_MCP_TOKEN: mcpMount.accessCode, BLAVE_MCP_URL: mcpMount.url } : {}),
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
    // runtime 依這個在 prompt 裡明講「這台有/沒有 Blave 資料」(變數不存在 = 雲端機,行為不變)
    // 用戶自己放的完整 key:不設這個變數,runtime 不加那段——「桌面 key 只能讀策略庫」對它不成立
    ...(dataAccess === "own" ? {} : { BLAVE_DATA_ACCESS: dataAccess === "ours" ? "1" : "0" }),
    // =0 時多帶原因,runtime 才講得出「登入著但餘額不夠」而不是一律「要先登入」
    ...(dataAccess === "none" ? { BLAVE_DATA_ACCESS_WHY: dataAccessWhy(signedIn) } : {}),
    // 聊天裡的圖:見上面「聊天裡的圖」。接收端還沒起來(port 0)就不帶,notify 那邊會 no-op
    ...(imgPort ? { BLAVE_WEB_REPORT_URL: `http://127.0.0.1:${imgPort}/chat-image`,
                    BLAVE_WEB_REPORT_TOKEN: imgToken, BLAVE_WEB_SESSION: sessionId } : {}),
    LANG: process.env.LANG || "zh_TW.UTF-8",
    ...PY_ENV,
  };
  let child;
  try { child = spawn(VENV_PY, [
    path.join(REPO, "runtime", "agent_turn.py"),
    "--delivery", "local",
    // 選擇器畫得出來時,model / effort **一律明確指定**:輸入框上寫的就是送出去的,
    // 不靠引擎那邊看不見的預設。只有型錄拿不到(沒畫選擇器)時兩個才是 null——
    // 那時 Claude / Blave AI 照舊送 sonnet,Codex 什麼都不帶(runtime 用「有沒有明確
    // 帶旗標」判斷,帶了 Claude 的名字過去會被轉成 `codex -m sonnet`)。
    ...(model ? ["--model", model] : useCodex ? [] : ["--model", "sonnet"]),
    ...(effort ? ["--effort", effort] : []),
    // 回覆語言跟著用戶打的字走,不跟介面(Wei):刻意**不帶** --ui-lang。runtime 的順序是
    // 「機器設定 > ui_lang > 看訊息猜」,電腦版沒有機器設定,不帶就落到最後一項。
    // 帶的那一版:介面切英文的人用中文問,拿到英文回覆。
    // 契約(runtime 那邊同一份):不帶 --engine = claude,行為跟以前一模一樣;
    // codex 要連執行檔的絕對路徑一起給,因為它多半不在 PATH 上。
    ...(useCodex ? ["--engine", "codex", "--codex-bin", codexBin] : []),
    ...viewingArgs(viewing),
    // argv 上只有設定檔的**路徑**(碼在檔案裡,0600、workspace 以外、這一輪結束就刪);runtime 只在電腦版(LocalSink)認這個旗標
    ...(mcpFile ? ["--mcp-config=" + mcpFile] : []),
    // 用戶打的字**不進 argv**(稽核 S5):同一台電腦上任何人 `ps` 都看得到命令列,而聊天貼 key 是支援的流程。走 stdin。
    // runtime 往下那一段本來就不走 argv(Claude 走 SDK 的 stream-json stdin、Codex 走 `exec -`)。
    "--message-stdin", "--", sessionId,
  ], { env: childEnv(env), cwd: WS, windowsHide: true }); } catch (err) { require("./mcpcode").removeConfig(mcpFile); throw err; }
  child.on("error", () => require("./mcpcode").removeConfig(mcpFile));
  child.stdin.on("error", () => { /* 子行程一起來就死(EPIPE):close 事件會把失敗交給畫面 */ });
  try { child.stdin.end(message); } catch (err) { try { child.kill(); } catch (_) { /* 已經不在了 */ } require("./mcpcode").removeConfig(mcpFile); throw err; }   // 不留一支卡在讀 stdin 的子行程
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
    require("./mcpcode").removeConfig(mcpFile);   // 這一輪結束:設定檔(裡面是接入碼)立刻刪
    activeTurn = null;
    // 視窗可能已經關掉了(結束時回合才收尾):送到已銷毀的 webContents 會丟例外
    if (!win.isDestroyed()) win.webContents.send("turn-end", { code, errTail: code === 0 ? "" : errTail });
  });
}

/* 這個視窗只顯示我們自己的 index.html,永遠不該被導去別的地方。頁面裡有第三方畫的
   連結(K 線圖左下角的 TradingView 標誌是 lightweight-charts 依授權放的 <a>),沒有
   這兩道的話,點它會在 app 裡開一個沒有 preload 隔離設定的新視窗、或把整個 app 導走。
   https 的交給系統瀏覽器開,其餘一律擋。 */
/* 交給系統瀏覽器開的網址分兩條(稽核 R4):
   ① 瀏覽器自己要導的(window.open、will-navigate;K 線圖那顆 TradingView 標誌走這裡)只認白名單——畫面上有 LLM 與
      雲端主機寫的字,哪天有一段不經我們的手變成了連結,也不能把用戶帶到任意網站。清單 = 程式裡實際用到的:
      blave.org(綁卡、方案、官網)與那顆標誌。
   ② 畫面自己的程式碼明確要開的(open-external IPC:帳務頁、條款,和對話裡用戶點的 markdown 連結——新聞 Sources 那種
      本來就是任意網站)只認 http(s)、不帶帳密;別的 scheme(file:、javascript:、能拉起別的程式的自訂 scheme)不開。 */
const EXTERNAL_HOSTS = ["blave.org", "www.tradingview.com"];
function externalUrl(raw) {
  let u; try { u = new URL(String(raw)); } catch (_) { return null; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  const h = u.hostname.toLowerCase();
  return EXTERNAL_HOSTS.indexOf(h) >= 0 || h.endsWith(".blave.org") ? u.href : null;
}
function openExternalSafe(raw) { const u = externalUrl(raw); if (u) shell.openExternal(u); return !!u; }
function webUrl(raw) {
  let u; try { u = new URL(String(raw)); } catch (_) { return null; }
  return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password ? u.href : null;
}
function openWebSafe(raw) { const u = webUrl(raw); if (u) shell.openExternal(u); return !!u; }

function guardNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    // 自己重載自己要放行:「重新登入」那顆鈕用的是 location.reload()
    if (url.split("#")[0] === win.webContents.getURL().split("#")[0]) return;
    e.preventDefault();
    openExternalSafe(url);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1024, minHeight: 680,
    titleBarStyle: "hiddenInset",
    // 燈的中心對到 52px 標題帶的中線(= 對話列中心 y=26);帶子長 8,中線只移 4,所以燈是 +4 不是 +8
    trafficLightPosition: { x: 12, y: 19 },
    // Electron 讀不到 CSS 變數,所以這裡鏡射 `--color-darkBody`(tokens.css)。
    // 改那顆就要改這裡。原本寫 #10151c —— H≈215,正是 canon › 色溫 點名要避開的
    // Tailwind slate 地帶,開窗與 resize 的瞬間看得到。
    backgroundColor: "#0f161a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      // 發佈版連 DevTools 本身都關掉(選單已經不放;這是縱深:哪天有人加回快捷鍵或 openDevTools 也開不起來)
      devTools: !(app.isPackaged && require("./package.json").blaveRelease),
    },
  });
  guardNavigation(win);
  win.on("enter-full-screen", appMenuSync); win.on("leave-full-screen", appMenuSync);   // 全螢幕那一格的字跟著換
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  startImageServer();
  // 上一次回合中途 crash 留下的 MCP 設定檔(裡面是一顆可能還沒過期的接入碼):開 app 就清。
  // 只有拿到單一實例鎖的那一份做(稽核 S1,同 :syncOfficialOnUpdate):第二份 app 在結束前也會走到這裡,
  // 不擋的話它會刪掉第一份**正在跑那一輪**的設定檔,那一輪的 MCP 當場失效
  if (app.hasSingleInstanceLock()) require("./mcpcode").sweep(mcpDir());
  // 這個 app 的網頁不需要任何瀏覽器權限(相機、麥克風、定位、通知…):Electron 預設是全部允許,這裡全部拒絕(稽核 R5)。
  // 唯一的例外是自家頁面寫剪貼簿——「複製」IP / 安裝識別碼那幾顆鈕靠它。
  const ses = require("electron").session.defaultSession;
  const permOk = (wc, perm, url) => perm === "clipboard-sanitized-write" && isOurPageUrl(url || (wc && wc.getURL()));
  ses.setPermissionRequestHandler((wc, perm, cb, details) => cb(permOk(wc, perm, details && details.requestingUrl)));
  ses.setPermissionCheckHandler((wc, perm, origin, details) => permOk(wc, perm, details && details.requestingUrl));
  // 只認我們自己那一頁的主 frame。**每一支 IPC 預設都過這道**(稽核 R3:原本是「記得的才驗」):用 handle() 註冊的不必自己寫;
  // 下面直接用 ipcMain.handle 的那幾支是因為拒絕時要回特定形狀,它們自己驗。
  const fromOurPage = (e) => {
    // 比「解出來的檔案路徑」而不是比字串:安裝路徑含 & + , = @ 時 encodeURIComponent 拼出來的 URL 跟
    // Chromium 給的不相等,會連 halt 都被拒(稽核 S7)
    let file = null;
    try { const u = new URL((e.senderFrame && e.senderFrame.url) || ""); if (u.protocol === "file:") file = require("url").fileURLToPath(u.href.split(/[?#]/)[0]); } catch (_) { /* 不是我們的頁 */ }
    return file === path.join(__dirname, "renderer", "index.html") && e.senderFrame === e.sender.mainFrame;
  };
  const handle = (channel, fn, denied = null) => ipcMain.handle(channel, (e, ...a) => (fromOurPage(e) ? fn(e, ...a) : denied));
  handle("detect-agents", () => detectAgents());
  handle("feature-flags", () => ({ cloudHandoff: cloudHandoffOn() }), { cloudHandoff: false });   // 畫面只拿得到開關,拿不到碼
  handle("save-connection", (_e, choice) => saveConnection(choice), false);
  handle("load-connection", () => loadConnection());
  handle("open-external", (_e, url) => openWebSafe(url), false);
  handle("ensure-engine", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    // 引擎裝好(或本來就在)之後才起本機常駐程式
    return ensureEngine((t) => win.webContents.send("engine-progress", t)).then((r) => { tradeStartIfReady(); return r; });
  });
  // app.getLocale() 是**系統**語系(macOS 偏好設定),不吃 LANG 環境變數。
  // BLAVE_LANG 是覆蓋用的:開發要看英文版、或用戶的系統是中文但想用英文介面。
  handle("get-locale", () => process.env.BLAVE_LANG || app.getLocale());
  handle("delete-strategy", (_e, name) => deleteStrategy(String(name || "")));
  handle("list-sessions", () => listSessions());
  handle("load-session-images", (_e, id) => loadSessionImages(id));
  handle("load-session", (_e, id) => loadSession(id));
  handle("delete-session", (_e, id) => deleteSession(id));
  handle("list-strategies", () => listStrategies());
  handle("load-strategy", (_e, name) => loadStrategy(String(name || "")));
  handle("model-options", (_e, kind) => modelOptions(kind));
  handle("account-status", () => accountStatus());
  handle("public-pricing", () => publicPricing());
  // 花錢的動作只收自家畫面發的:renderer 會渲染 LLM 的文字,萬一有別的 frame 被帶進來,它不能替用戶開機
  ipcMain.handle("plan-start", (e) => (fromOurPage(e) ? planStart() : { error: "SERVER" }));
  /* 本機交易:狀態是唯讀的檔案內容;指令由 daemon.js 簽章後寫進佇列(secret 不出主行程)。
     daemon 在引擎裝好之後才起(它要 workspace 與 venv),而且**不會自己啟動對帳器**——要用戶按「啟動下單」。 */
  handle("trade-status", () => { const st = tradeHost().status(); if (st.report && typeof st.report === "object") st.report.selfOrdering = stratSelfOrderingAny(); return st; });
  handle("trade-events", (_e, q) => tradeHost().events({ days: q && Number(q.days) }));
  handle("trade-equity", (_e, q) => tradeHost().equity({ days: q && Number(q.days) }));
  ipcMain.handle("trade-send", async (e, cmd, args, _requestId, intent) => {   // _requestId 只有雲端那條路在用(cloudcmd.js),本機忽略
    if (!fromOurPage(e) || typeof cmd !== "string") return { ok: false, error: "NOT_ALLOWED" };
    // 最低版本閘:只擋啟動類(resume / resume_wait);暫停、改金額、移除金鑰永遠放行,已在跑的下單不主動停
    if (require("./minversion").START_CMDS.has(cmd)) { await minGate().ensureFresh(); if (!minGate().tradeAllowed(cmd)) return { ok: false, error: "UPDATE_REQUIRED" }; }
    const out = tradeHost().send(cmd, args && typeof args === "object" ? args : {});
    if (cmd === "credentials_remove" || cmd === "credentials") Promise.resolve(out).then((r) => { if (r && r.ok) binanceLink().recheck(); }).catch(() => {});   // 解除綁定、或改綁模擬交易把 Binance 擠掉:.env 沒有金鑰了 → 重查那一輪會把比對基準清掉
    // 「解除暫停」(§8)送的也是 resume,但它不啟動對帳器、也不照策略下單:不可以記成開始下單(稽核 B1)
    if ((cmd === "resume" || cmd === "resume_wait") && intent !== "release") Promise.resolve(out).then((r) => {
      if (!r || !r.ok) return;
      const v = (_tradeHost && _tradeHost.status().report || {}).venues || {}, ids = Object.keys(v).filter((k) => venueReady(v[k]));
      if (ids.length) tm().track("trade_started", { venue_kind: ids.every((k) => k === "paper") ? "paper" : "real" });
    }).catch(() => {});
    return out;
  });
  // 告知畫面顯示過才開始送(稽核 M2'):在那之前 start()/track() 一則都不出門。由 renderer 在告知真的畫出來之後叫這支
  // 雲端(唯讀):畫面要的狀態。只收自家頁面——回的是部位與權益
  // 懶啟動:第一次有人要雲端狀態才開始輪詢。refresh 有最小間隔,renderer 寫壞的迴圈打不爆帳號的速率桶
  ipcMain.handle("cloud-status", (e) => { if (!fromOurPage(e)) return null; cloudHost().start(); return cloudHost().status(); });
  ipcMain.handle("cloud-refresh", (e) => { if (!fromOurPage(e)) return null; cloudHost().start(); return cloudHost().refresh().then(() => cloudHost().status()); });
  // 雲端的事件清單:點擊驅動的另一支(另一個速率桶),不啟動輪詢、不留在主行程、不落地。
  // 回 { code: "OK" | "UNREACH", events }——讀不到與「真的沒有事件」是兩件事,畫面要講得出是哪一種
  handle("cloud-events", (_e, q) => cloudHost().events(q && q.days), { code: "UNREACH", events: [] });
  // 雲端的權益曲線與當日損益(總覽分頁;同事件清單:另一個速率桶、不留在主行程、不落地)。回 { code: "OK" | "UNREACH", curve }
  handle("cloud-overview", (_e, q) => cloudHost().overview(q && q.days, q && q.currency), { code: "UNREACH", curve: null });
  handle("cloud-performance", (_e, q) => cloudHost().performance(q && q.days, q && q.currency), { code: "UNREACH", perf: null });
  // 雲端單支策略的報告(側欄點一支打一次;同事件清單:不留在主行程、不落地)。回 { code: "OK" | "UNREACH", strategy }——OK + null = 雲端現在沒有這一份
  handle("cloud-strategy", (_e, q) => cloudHost().strategy(q && q.name), { code: "UNREACH", strategy: null });
  // 雲端的報告清單與本體(renderer/reports.js;同單支策略:不啟動輪詢、憑證只在主行程)。OK + report: null = 平台現在沒有這一份
  handle("cloud-reports", (_e, force) => cloudReports(force === true), { code: "UNREACH", reports: [] });
  handle("cloud-report", (_e, id, ver) => cloudReport(id, ver), { code: "UNREACH", report: null, images: {} });
  /* 雲端(寫入):renderer 只說「送哪個指令」,憑證與 request_id 都在主行程(cloudcmd.js)。
     **這一支拒收 secrets**(cloudcmd.js 檔頭契約 ①:那個檔不是信任邊界,閘門在這裡):白名單直接砍掉 credentials,
     金鑰只由日後專用的連接 IPC 供應——renderer 被攻破也塞不進任意 ENV 名。
     白名單的來源仍是 daemon.js 的 UI_COMMANDS(= api 的 CLOUD_COMMANDS,api/tests/check_desktop_cloud_command.py 直接讀那個檔比對),
     不另抄一份;但**再交集一次「真的有 UI 在用的」**(稽核 S-2)。
     `delete_strategy` 只給雲端(= api 的 CLOUD_MACHINE_ONLY_COMMANDS):**不可以**加進 daemon.js 的
     UI_COMMANDS(那是本機 daemon 也收的那一份,api 的測試釘住它的長度),參數由 cloudcmd.cloudArgsOk 驗。
     requestId 由畫面帶回上一趟那顆(冪等;形狀不對就當沒帶,由 cloudcmd 重鑄)。
     最低版本閘不套在這裡:它擋的是**這台電腦**的下單碼,雲端跑的是主機上的 runtime(規格 §4.2-1)。 */
  const cloudDenied = { ok: false, error: "NOT_ALLOWED", kind: "undelivered" };
  const CLOUD_ONLY = require("./cloudcmd").CLOUD_ONLY_COMMANDS;
  // 沒有 update:用本機 app 不觸發雲端 agent 回合(Wei 09-22),雲端更新改由本機 agent 經 MCP 去做。
  // 沒有 restart_reconciler:主機重開後對帳器停著的情況,機器端的 resume / resume_wait 自己會把它起來(command_listener._start_after_restart_stop)
  const CLOUD_SHIPPED = ["halt", "close_all", "resume", "resume_wait", "amounts", "delete_strategy", "credentials_remove", "retest_accounts", "book_account_confirm"];
  handle("cloud-send", async (_e, cmd, args, requestId) => {
    if (typeof cmd !== "string" || cmd === "credentials" || !(require("./daemon").UI_COMMANDS.has(cmd) || CLOUD_ONLY.indexOf(cmd) >= 0) || CLOUD_SHIPPED.indexOf(cmd) < 0) return cloudDenied;
    const rid = typeof requestId === "string" && require("./cloudcmd").REQUEST_ID_RE.test(requestId) ? requestId : null;
    const argsSafe = !args || typeof args !== "object" || Array.isArray(args) ? {} : args;
    // 形狀先在這裡驗一次(同本機 daemon 那一道):renderer 被攻破時塞不進奇形怪狀的參數,也不白吃一格 api 的速率桶
    if (CLOUD_ONLY.indexOf(cmd) >= 0 ? !require("./cloudcmd").cloudArgsOk(cmd, argsSafe) : !require("./daemon").argsOk(cmd, argsSafe)) return { ok: false, error: "BAD_ARGS", kind: "undelivered" };
    const r = await cloudCmd().send(cmd, argsSafe, null, { requestId: rid });
    // 機器收下了:立刻要一份新狀態(refresh 自己有節流)。不等它——回應不該被多一趟網路拖住
    if (r && r.ok) { cloudHost().start(); cloudHost().refresh(true).catch(() => {}); }
    return r;
  }, cloudDenied);
  /* 雲端連交易所(S5):**金鑰只走這一條**(cloud-send 永遠拒收 credentials)。形狀在這裡驗、環境變數名在這裡決定;
     不從這台電腦查 Binance(白名單設成雲端 IP 的好金鑰從這裡查必定被拒)——權限由雲端主機寫入前自己查。
     每按一次新的 request_id:重送同一把只是主機多查一次。回應只有代號,金鑰值不回傳、不 log。 */
  const cxDenied = { ok: false, code: "NOT_ALLOWED", detail: {} };
  handle("cloud-connect", async (_e, a) => {
    const CC = require("./cloudcmd");
    const built = CC.connectSecrets(a, require("./binance_link").keyShapeOk, Date.now() / 1000);
    if (built.error) return { ok: false, code: built.error, detail: {} };
    const r = await cloudCmd().send("credentials", {}, built.secrets);
    const out = CC.interpretConnect(r, built.secrets);
    if (out.ok) { cloudHost().start(); cloudHost().refresh(true).catch(() => {}); }
    return out;
  }, cxDenied);
  /* OKX / BingX / Gate.io / Bybit 綁在這台電腦:金鑰只在這裡經過一次(形狀與 env 名同雲端那條:cloudcmd.connectSecrets),
     不回傳、不 log。寫入前 runtime(_local_real_key_gate)用那一家的 lib/account_* 讀一次帳戶,讀不到就不寫;
     回覆怎麼對到畫面的代號、怎麼遮金鑰,在 cloudcmd.interpretVenueBind */
  handle("venue-connect", async (_e, a) => {
    const CC = require("./cloudcmd");
    if (!a || typeof a !== "object" || a.venue === "binance" || a.venue === "paper") return { ok: false, code: "BAD_ARGS", detail: {} };
    const built = CC.connectSecrets(a, () => false, Date.now() / 1000);
    if (built.error) return { ok: false, code: built.error, detail: {} };
    let r = null; try { r = await sendTrustedCreds(built.secrets); } catch (_) { /* 當沒送到 */ }
    return CC.interpretVenueBind(r, built.secrets);
  }, { ok: false, code: "NOT_ALLOWED", detail: {} });
  // Binance 真錢連接:四支都只收自家頁面。金鑰只在 binance-connect 經過一次,形狀先驗(binance_link.keyShapeOk),不回傳、不 log
  ipcMain.handle("binance-ip", (e) => (fromOurPage(e) ? binanceLink().ip() : null));
  ipcMain.handle("binance-state", (e) => (fromOurPage(e) ? binanceLink().state() : null));
  ipcMain.handle("binance-recheck", (e) => (fromOurPage(e) ? binanceLink().recheck(true) : null));
  ipcMain.handle("binance-connect", async (e, a) => {
    if (!fromOurPage(e) || !a || typeof a !== "object" || Array.isArray(a)) return { ok: false, code: "NOT_ALLOWED", detail: {} };
    return binanceLink().connect(a.apiKey, a.secret);
  });
  handle("min-version-state", () => minGate().state());
  handle("update-state", () => ({ ...updater().state(), backup: _officialBackup }));
  ipcMain.handle("update-check", (e) => (fromOurPage(e) ? updater().check() : false));
  // 本機有 agent 回合在跑(可能正在更新雲端):不重開,重開會把它斷掉(畫面那一道之外再擋一次)
  ipcMain.handle("update-install", (e) => (!fromOurPage(e) ? { ok: false, error: "NOT_ALLOWED" } : activeTurn || turnStarting ? { ok: false, error: "TURN_BUSY" } : updater().install()));
  // 換版時備份的資料夾:在 Finder 裡選起來。路徑由主行程自己算(畫面不交路徑),沒有備份就什麼都不做
  handle("update-show-backup", () => { if (!_officialBackup) return false; shell.showItemInFolder(path.join(WS, _officialBackup.dir)); return true; }, false);
  ipcMain.handle("telemetry-get", (e) => (fromOurPage(e) ? tm().isEnabled() : null));
  // 安裝識別碼:用戶來信要求刪除使用資料時要附的那一組(隱私權政策)。追蹤關掉也照給——關掉之前送出的紀錄還在
  handle("telemetry-install-id", () => tm().installId());
  ipcMain.handle("telemetry-set", (e, on) => { if (!fromOurPage(e)) return false; tm().setEnabled(on === true); return tm().isEnabled(); });
  // 功能被使用(renderer 的 trackFeature):name 由 telemetry.js 對 feature_used 白名單驗,renderer 給的字不可信、不在表上就整則不送
  ipcMain.on("track-feature", (e, name) => { if (fromOurPage(e)) tm().track("feature_used", { name }); });
  /* 自帶資料來源(datasrc.js;設定 › 資料來源)。金鑰的值只從 renderer 的表單經過 datasrc-save 一次,寫進 workspace 的 .env(拿 .env.lock);
     之後任何一支都不把值交回去——list 只有名稱與欄位名。四支都走 handle()(只收自家頁面,拒絕時回各自的形狀);參數在 datasrc.js 裡驗(名稱白名單、值不含換行與引號)。
     不 log、不進 argv / 環境、不寫 userData。這些名字都在 DATA_ 命名空間,機器端不把它們當交易所:永遠不會拿去下單。 */
  const dataSrc = require("./datasrc").createDataSrc({
    envFile: path.join(WS, ".env"),
    lock: require("./datasrc").pyLock({ python: VENV_PY, lockFile: path.join(WS, ".env.lock") }),
    strategies: () => listStrategies().map((s) => ({ name: s.name, displayName: s.displayName, file: path.join(STRAT_DIR(), s.name, "strategy.py") })),
    // cfgNull:下單中但回報讀不到設定檔(config: null)——擋刪清單不能當空的(datasrc.js)
    trading: () => { const r = tradeLive() && tradeHost().status().report; return { live: !!r, amounts: r && r.config && r.config.amounts, cfgNull: !!r && r.config === null }; },
  });
  handle("datasrc-list", () => dataSrc.list(), { ok: false, error: "NOT_ALLOWED", sources: [] });
  handle("datasrc-save", (_e, input) => (fs.existsSync(WS) ? dataSrc.save(input) : { ok: false, error: "NO_WORKSPACE" }), { ok: false, error: "NOT_ALLOWED" });
  handle("datasrc-blockers", (_e, name) => dataSrc.blockers(name), []);
  handle("datasrc-remove", (_e, name) => dataSrc.remove(name), { ok: false, error: "NOT_ALLOWED" });
  handle("load-model-prefs", () => loadModelPrefs());
  handle("save-model-prefs", (_e, prefs) => saveModelPrefs(prefs));
  handle("start-oauth", (_e, lang) => startOAuth(lang === "en" ? "en" : "zh"));   // 語言段會拼進同意頁的路徑:只認兩個值(稽核 R6)
  handle("cancel-oauth", () => cancelOAuth());
  handle("clear-connection", () => clearConnection());
  handle("has-blave-token", () => !!loadToken());
  // 策略庫(renderer/library.js):清單與已安裝表只收自家頁面;購買會動到餘額與信用卡,拒絕時回「打不到」的形狀
  handle("library-list", (_e, lang, force) => libraryList(lang, force === true), null);
  handle("library-report", (_e, id, lang) => libraryReport(id, lang), null);
  ipcMain.handle("library-purchase", (e, id, confirmTopup) => (fromOurPage(e) ? libraryPurchase(id, confirmTopup) : { status: 0, body: null }));
  handle("library-installed", (_e, patch) => libraryInstalled(patch), {});
  // 本機報告(renderer/reports.js):讀 <WS>/reports 的信封 / 本體 + sidecar 圖(data URI);renderer 不碰 fs
  handle("reports-list", () => reportsList(), { reports: [] });
  handle("report-load", (_e, id) => reportLoad(id), null);
  handle("sign-out-blave", () => signOutBlave());
  handle("agent-login", (_e, kind) => agentLogin(String(kind || "")));
  handle("cancel-agent-login", () => cancelAgentLogin());
  ipcMain.handle("send-message", async (e, payload) => {
    if (!fromOurPage(e)) return { busy: true };   // 會 spawn agent、花 AI 額度:只收自家頁面
    if (activeTurn || turnStarting) return { busy: true };
    const win = BrowserWindow.fromWebContents(e.sender);
    // 使用追蹤「上雲端運行」:只認「送上雲端」確認框送的那句(payload.handoff === "up";拉回不算),而且旗標要開——關著時畫面到不了那條路,標記也不認
    const cloudUp = cloudHandoffOn() && payload && payload.handoff === "up";
    // runTurn 要先 await 登入 shell 的 PATH 與 account_status 才 spawn;這段期間 activeTurn 還是 null,
    // 不另外立旗標的話連按兩下會 spawn 兩顆 agent 搶同一個 session.db(下面補問版本閘的那段 await 也算在內)
    turnStarting = true;
    // 最低版本閘:只擋 Blave AI;連自己 CLI 的人照常聊
    try {
      const kind = (loadConnection() || {}).kind;
      if (kind === "blave") {
        try { await minGate().ensureFresh(); } catch (_) { /* 問不到 = 照手上的答案 */ }
        if (!minGate().turnAllowed(kind)) { turnStarting = false; return { blocked: "UPDATE_REQUIRED" }; }
      }
    } catch (err) { turnStarting = false; throw err; }   // 這一段拋了不還原的話,之後每一次送出都回 busy(稽核 R1)
    runTurn(win, payload).then(() => { if (cloudUp) tm().track("cloud_started"); }).catch((err) => {   // resolve = spawn 與 stdin 都成功、話交到 agent 手上;失敗那條不送
      if (win && !win.isDestroyed()) win.webContents.send("turn-end", { code: 1, errTail: String((err && err.message) || err) });
    }).finally(() => { turnStarting = false; });
    return { started: true };
  });
  createWindow();
  // 要在常駐程式起來之前:它 import 的就是 workspace 裡的 lib。只有拿到單一實例鎖的那一份才做——
  // 第二份 app 在結束前也會走到 whenReady,不能讓它把新 lib 拷進第一份正在下單的 workspace(稽核 S7)
  if (app.hasSingleInstanceLock()) syncOfficialOnUpdate();
  tradeStartIfReady();   // 引擎早就裝好的人:一開 app 就有狀態可看(對帳器仍要他自己按啟動)
  // 視窗回前景 = 用戶可能剛在瀏覽器綁完卡、開完主機:「含不含資料」的答案作廢,下一輪重查
  // (不在這裡打 api——跟 LLM 共用每分鐘 30 次的桶,而且畫面那邊有卡片時本來就會重查)
  app.on("browser-window-focus", () => { lastAcct = null; p1Badge = 0; if (app.dock) app.dock.setBadge(""); cloudHost().setForeground(true); });
  app.on("browser-window-blur", () => cloudHost().setForeground(false));   // 背景時輪詢放慢到 60 秒
  app.on("activate", () => showMain());   // 點 Dock:視窗被紅燈收起來的話把它叫回來
  trayStart();
  tm().start();
  updater().start();
  minGate().start();
  appMenuSync();
  ipcMain.on("trade-labels", (e, labels) => {
    if (!fromOurPage(e) || !labels || typeof labels !== "object") return;
    for (const k of Object.keys(tmLabels)) if (typeof labels[k] === "string" && labels[k] && labels[k].length <= 400) tmLabels[k] = labels[k];
    if (labels.lang === "zh" || labels.lang === "en") uiLang = labels.lang;   // 只拿來組官網網址的語言段:白名單兩個值
    traySync(); appMenuSync();
  });
});
// 一次只跑一份:第二份會跟第一份搶同一個 workspace 與 session.db,也讓「用同一顆 binary 再開一份」這條
// 旁路少一點(稽核 M1)
if (!app.requestSingleInstanceLock()) app.quit();
else app.on("second-instance", () => showMain());   // 視窗可能被紅燈收起來了:show 也要做
app.on("window-all-closed", () => app.quit());

/* ── 視窗之外的暫停(設計師提案 §3-6)─────────────────────────────
   自動下單在跑的時候,用戶不一定在看這個視窗:選單列圖示(只在執行中出現)、Dock 右鍵、結束攔截。
   - 「執行中」由主行程自己看狀態檔判定(renderer 在背景會被節流,不能靠它):tradeLive() = renderer trExecState 的 running。
   - 「結束 / 關窗前要不要攔」走保守方向(tradeMaybeLive):狀態檔這輪 build 失敗、睡眠醒來心跳還沒更新時 tradeLive() 是 null,
     但可能還在下單——這時不攔就是沒問一聲就停止下單(稽核 M3)。
   - 從選單暫停 = 直接送 halt、不跳框(暫停是安全方向),事後一則系統通知;沒送到也要講,不能讓人以為停了。
   - 執行中按紅燈只收視窗、不結束 app(app 結束 = 停止下單);Cmd+Q 先問一次。
   - 字由 renderer 依目前語言交過來(.po 是唯一的字串來源);還沒交之前用英文退路。 */
/* app 選單的英文退路(renderer 還沒交字之前,不到一秒)。字串表 menu.* 是唯一來源,這裡只是退路 */
const MENU_EN = { menuAbout: "About Blave", menuServices: "Services", menuHide: "Hide Blave", menuHideOthers: "Hide Others", menuShowAll: "Show All",
  menuQuit: "Quit Blave", menuFile: "File", menuClose: "Close Window", menuEdit: "Edit", menuUndo: "Undo", menuRedo: "Redo", menuCut: "Cut",
  menuCopy: "Copy", menuPaste: "Paste", menuPasteStyle: "Paste and Match Style", menuDelete: "Delete", menuSelectAll: "Select All",
  menuView: "View", menuLocal: "This Computer", menuCloud: "Cloud", menuActualSize: "Actual Size", menuZoomIn: "Zoom In", menuZoomOut: "Zoom Out",
  menuFullEnter: "Enter Full Screen", menuFullExit: "Exit Full Screen", menuWindow: "Window", menuMinimize: "Minimize", menuZoom: "Zoom",
  menuFront: "Bring All to Front", menuHelp: "Help", menuSite: "Blave Website" };
let tray = null, trayTimer = null, quitConfirmed = false, quitAsking = false, hiddenSaid = false, lastVenue = null, trayKey = "";
let tmLabels = { running: "Auto trading is running", paperVenue: "Paper trading", pause: "Pause trading (keep positions)", open: "Open Blave", quit: "Quit Blave…",
  notifTitle: "Trading paused", notifBody: "Positions were not touched.", pauseFail: "The pause command didn’t go through. Trading may still be running.",
  pauseUnknown: "The pause command was sent, but this computer hasn’t reported the result yet. Check the status on this page.",
  quitTitle: "Auto trading is still running", quitBody: "After you quit Blave, this computer stops placing orders. Positions are not closed.", quitGo: "Quit Blave", quitStay: "Cancel",
  // 畫面還沒交字之前就按結束:回合中那一道也要有字(不然 message 退回下單那句、detail 是空的)
  quitTurnTitle: "The agent is still replying", quitTurnBody: "Quitting Blave now cuts off this turn, including any cloud update in progress. It's safer to wait until it finishes.",
  hidden: "Blave is still running in the menu bar.",
  updateReady: "Restart to finish updating",
  ev_halt: "Trading was paused automatically", ev_halt_n: "No new positions are opened. Open Blave to check.",
  ev_order_error: "Order failed", ev_order_error_n: "The exchange rejected an order. Open Blave to check.",
  ev_execution_interrupted: "Last execution was interrupted", ev_execution_interrupted_n: "A fill may be missing from the ledger. Check positions before restarting.",
  ev_execution_fallback_market: "Switched to a market order", ev_execution_fallback_market_n: "The configured order style could not run; the fill price may differ.",
  ev_execution_stuck: "Execution is stuck", ev_execution_stuck_n: "Later orders for this symbol are waiting on it.",
  ev_machine_restart_stopped: "Machine restarted — trading paused", ev_machine_restart_stopped_n: "No orders are going out — nothing is managing your positions, and exits and stops won't run. Press Start trading to resume.",
  // 有了雲端視角之後的字(字串表 tm.*)。**預設是空的 = renderer 還沒交**:空的時候相關的那一行 / 那一句 / 那個前綴整個不出現,
  // 行為跟以前一樣——不拿英文退路硬塞進中文的選單列。app 選單(menu*)例外:退路是 MENU_EN。
  // Binance 金鑰重查(tm.key.*):空的 = renderer 還沒交,那一則通知不發(不拿英文退路塞給中文用戶;下一輪 24 小時重查 verdict 還在,畫面上看得到)
  key_ipTitle: "", key_ipBody: "", key_rejTitle: "", key_rejSameIpBody: "", key_rejUnknownBody: "", key_permTitle: "", key_permBody: "",
  stLocal: "", stCloud: "", stOn: "", stPaused: "", stUnknown: "", stMayTrade: "", stNotStarted: "", moneyPaper: "", moneyReal: "",
  pauseLocal: "", quitCloudNote: "", notifPrefixLocal: "", notifPrefixCloud: "", ...Object.fromEntries(Object.keys(MENU_EN).map((k) => [k, ""])) };
const TT = require("./traytext");
let uiLang = null, appMenuKey = "";   // renderer 交過來之前用系統語系猜(app.getLocale() 要等 ready 之後才有值,所以用的時候才算)
const siteLang = () => uiLang || (/^zh/i.test(app.getLocale() || "") ? "zh" : "en");
const pauseLabel = () => tmLabels.pauseLocal || tmLabels.pause;   // 有雲端之後「暫停下單」不夠明確:講清楚是這台電腦
/* 雲端那一行:**不為了選單列去啟動雲端輪詢**——雲端宿主是懶啟動的(沒打開過雲端視角的人不該每分鐘打 api),
   沒啟動過就沒有這一行。啟動過之後吃它手上那份(主行程自己的輪詢,不靠 renderer)。 */
const cloudSt = () => (_cloud && _cloud.isRunning() ? _cloud.status() : null);
function envSwitchFromMenu(env) {
  showMain();
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && isOurPageUrl(w.webContents.getURL())) w.webContents.send("env-switch", env);
}
/* app 選單。Electron 內建 role 的預設字是寫死的英文(electron_api_menu_roles.cc),不跟系統語言翻,
   所以每一個 role 項目都帶 label,字跟 **app 的語言**走(renderer 交過來;字照 macOS zh_TW 系統用字,設計師 spec §1.2)。
   編輯選單逐項列:editMenu 整包會帶「Substitutions」「Speech」兩個寫死英文、聊天輸入用不到的子選單。
   系統自己插的項目(服務的內容、聽寫、表情符號、視窗清單、說明搜尋)跟**系統**語言走,不歸這裡管。
   全螢幕那一格的字跟著視窗狀態換(進入 / 離開),視窗的 enter/leave-full-screen 會叫 appMenuSync 重建。
   全螢幕**不用 role**:帶 togglefullscreen role(= toggleFullScreen: selector)時,macOS 26 會在同一個選單再插一份自己的
   (🌐F 那一格,字照抄我們的),0.0.4 上實際看到兩個「Toggle Full Screen」(Electron 44.4.3 的修正沒蓋到)。
   改成自己的 click + ⌃⌘F,實測選單裡只剩一格;系統那份 🌐F 快捷鍵跟著不見,⌃⌘F 與視窗綠燈照常。
   ⌘1 / ⌘2 在 renderer 也有 keydown:macOS 上選單的快捷鍵先吃,頁面多半收不到;就算兩邊都觸發,切到「已經在的那一邊」
   是 no-op(renderer 的 envSwitch 開頭就擋),不會切兩次。確認框開著時該不該切由 renderer 收到 env-switch 後自己判(同 keydown 的規則)。 */
function appMenuTemplate(L, dev, full, onEnv, onSite, onFull) {
  const l = (k) => L[k] || MENU_EN[k], sep = { type: "separator" }, r = (role, k, extra) => ({ role, label: l(k), ...extra });
  return [
    { label: app.name, submenu: [r("about", "menuAbout"), sep, r("services", "menuServices"), sep,
      r("hide", "menuHide"), r("hideOthers", "menuHideOthers"), r("unhide", "menuShowAll"), sep, r("quit", "menuQuit")] },
    { label: l("menuFile"), submenu: [r("close", "menuClose")] },
    { label: l("menuEdit"), submenu: [r("undo", "menuUndo"), r("redo", "menuRedo"), sep, r("cut", "menuCut"), r("copy", "menuCopy"), r("paste", "menuPaste"),
      r("pasteAndMatchStyle", "menuPasteStyle"), r("delete", "menuDelete"), r("selectAll", "menuSelectAll")] },
    { label: l("menuView"), submenu: [
      { label: l("menuLocal"), accelerator: "Cmd+1", click: () => onEnv("local") },
      { label: l("menuCloud"), accelerator: "Cmd+2", click: () => onEnv("cloud") },
      sep,
      ...(dev ? [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, sep] : []),   // 開發版才有,維持英文
      r("resetZoom", "menuActualSize"), r("zoomIn", "menuZoomIn"), r("zoomOut", "menuZoomOut"), sep,
      { label: l(full ? "menuFullExit" : "menuFullEnter"), accelerator: "Ctrl+Cmd+F", click: onFull },
    ] },
    r("window", "menuWindow", { submenu: [r("minimize", "menuMinimize"), r("zoom", "menuZoom"), sep, r("front", "menuFront")] }),
    r("help", "menuHelp", { submenu: [{ label: l("menuSite"), click: onSite }] }),
  ];
}
function appMenuSync() {
  const w = BrowserWindow.getAllWindows()[0], full = !!(w && !w.isDestroyed() && w.isFullScreen());
  const key = JSON.stringify([uiLang, full, Object.keys(MENU_EN).map((k) => tmLabels[k])]);   // 換語言、進出全螢幕都重建
  if (key === appMenuKey && Menu.getApplicationMenu()) return;
  appMenuKey = key;
  const dev = !(app.isPackaged && require("./package.json").blaveRelease);   // 發佈版的選單不放重新載入與開發者工具
  const onFull = () => { const f = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]; if (f && !f.isDestroyed()) f.setFullScreen(!f.isFullScreen()); };
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(tmLabels, dev, full, envSwitchFromMenu, () => shell.openExternal(SITE_URL[siteLang()]), onFull)));
}
const SITE_URL = { zh: "https://blave.org/zh", en: "https://blave.org/en" };   // 固定常數(結尾不加斜線:/zh/ 是 404);語言段只有這兩個值
const venueReady = (v) => !!(v && v.credentials && v.pair && v.order && v.account);   // 同 renderer trVenueIds:四個都在才算連上的帳戶
function tradeLive() {
  if (!_tradeHost) return null;
  const st = _tradeHost.status(), r = st.report;
  if (!st.alive || !r || r.error || !r.venues || (r.halt && r.halt.halted) || !(r.reconciler && r.reconciler.alive)) return null;
  // 心跳檔的新鮮期是 300 秒:app 重開後那 5 分鐘,上一次的心跳還「新鮮」但對帳器根本沒起來。監督者說沒在跑就是沒在跑。
  if (r.daemon && r.daemon.reconciler && r.daemon.reconciler.running === false) return null;
  const id = Object.keys(r.venues).filter((k) => venueReady(r.venues[k])).sort()[0];
  return id ? { venue: id } : null;
}
function tradeMaybeLive() {
  const live = tradeLive();
  if (live) return live;
  if (!_tradeHost) return null;
  const st = _tradeHost.status(), r = st.report;
  if (!st.running || !r || (r.halt && r.halt.halted)) return null;   // 子行程不在 = 沒有東西在下單;已暫停 = 不必攔
  // 對帳器有沒有在跑,問 daemon 的監督者(daemon 區塊在 build 失敗那一輪也照寫、不看心跳新不新):
  // 沒在跑就是沒在下單——這時攔下來說「自動下單還在執行」是假話
  if (!(r.daemon && r.daemon.reconciler && r.daemon.reconciler.running)) return null;
  return { venue: lastVenue };
}
// 結束確認框的 {venue};選單列那一行已經寫交易所名,不再另列一行。id 長得不像 id 時退回首字大寫的原字,不能讓那句變成「部位留在。」
const venueName = (id) => (!id ? "" : id === "paper" ? tmLabels.paperVenue : TT.venueLabel(id) || String(id).charAt(0).toUpperCase() + String(id).slice(1));
function showMain() {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) { createWindow(); return; }
  if (w.isMinimized()) w.restore(); w.show(); w.focus();
}
async function pauseFromMenu() {
  let r = null;
  try { r = await tradeHost().send("halt", { reason: "menu bar" }); } catch (_) { /* 當成沒送到 */ }
  traySync();
  if (r && r.ok) { if (Notification.isSupported()) notifWatch(new Notification({ title: TT.notifTitle(tmLabels.notifPrefixLocal, tmLabels.notifTitle), body: tmLabels.notifBody }), "paused").show(); return; }
  // 沒成功不能只靠系統通知(權限關掉 / 專注模式會被吞):把視窗叫出來、掛一個框講清楚(稽核 M1)
  showMain();
  dialog.showMessageBox(BrowserWindow.getAllWindows()[0] || undefined, { type: "warning", message: pauseLabel(),
    detail: r && r.error === "UNKNOWN_RESULT" ? tmLabels.pauseUnknown : tmLabels.pauseFail, buttons: ["OK"] });
}
// 新版已經暫存好、但因為正在下單而沒裝:桌機用戶的 app 常常整天開著,不講的話他們不會知道有新版在等
const updateWaiting = () => { try { const p = updater().state().phase; return p === "blocked" || p === "ready"; } catch (_) { return false; } };
// 選單列的狀態行。這台電腦那一行:選單列只在這台電腦「確定在下單」時出現,所以狀態一定是 on。字還沒交 → null,退回舊的那一句
const trayLocalLine = (live) => TT.statusLine(tmLabels.stLocal, { money: live.venue === "paper" ? "paper" : "real", venue: live.venue, state: "on" }, tmLabels);
const trayCloudLine = () => TT.statusLine(tmLabels.stCloud, TT.cloudLine(cloudSt()), tmLabels);
// 選單列只有一行更新的字(app 新版已暫存好:「重新啟動以完成更新」,不可點、沒有點、沒有徽章);雲端的更新不進選單列(v4 §4)
function trayMenu(live) {
  const cloud = trayCloudLine();
  return Menu.buildFromTemplate([
    { label: trayLocalLine(live) || tmLabels.running, enabled: false },
    ...(cloud ? [{ label: cloud, enabled: false }] : []),
    ...(updateWaiting() ? [{ type: "separator" }, { label: tmLabels.updateReady, enabled: false }] : []),
    { type: "separator" },
    { label: pauseLabel(), click: pauseFromMenu },   // 暫停只給這台電腦:雲端的暫停要用戶在雲端視角親手做
    { type: "separator" },
    { label: tmLabels.open, click: showMain },
    { label: tmLabels.quit, click: () => app.quit() },
  ]);
}
function traySync() {
  const live = tradeLive();
  if (live) lastVenue = live.venue;
  const key = live ? [live.venue, trayLocalLine(live) || tmLabels.running, pauseLabel(), updateWaiting() ? tmLabels.updateReady : "", trayCloudLine() || ""].join("|") : "";
  if (key === trayKey) return;   // 每 5 秒叫一次:沒變就不重建選單
  trayKey = key;
  if (!live) {
    if (tray) { tray.destroy(); tray = null; }
    if (app.dock) app.dock.setMenu(Menu.buildFromTemplate([]));
    return;
  }
  if (!tray) {
    // Windows 不認 Template 命名(黑色單色圖在深色工作列看不見),給彩色的 .ico(16 / 24 / 32)
    const img = WIN ? nativeImage.createFromPath(path.join(__dirname, "assets", "tray.ico"))
      : nativeImage.createFromPath(path.join(__dirname, "assets", "trayTemplate.png"));   // 檔名結尾 Template = macOS 自動依選單列明暗上色
    if (img.isEmpty()) console.error("tray icon missing: shell/assets/" + (WIN ? "tray.ico" : "trayTemplate.png"));   // 空圖 = 看不見的圖示;選單還在,但要留下痕跡(稽核 M4)
    tray = new Tray(img);
  }
  tray.setToolTip(updateWaiting() ? tmLabels.updateReady : tmLabels.running);
  tray.setContextMenu(trayMenu(live));
  if (app.dock) app.dock.setMenu(Menu.buildFromTemplate([{ label: pauseLabel(), click: pauseFromMenu }]));
}
/* ── 本機 P1 通知(canon notifications.md 的 P1 清單;電腦版沒有平台那一層,這是唯一會叫人的出口)──────
   來源有兩個(稽核 M1),跟選單列共用 5 秒那個 timer:
     · 狀態檔的 events(daemon 把 state/events.jsonl 水位線以上的原樣放進去)——執行類四型;
     · 狀態檔的現況——halt 與 order_error **從來不寫進 events.jsonl**(lib/events.py 明文禁寫;雲端是平台拿回報 diff 出來的),
       這裡照同一個做法:halt 看 r.halt.at、拒單看 r.order_errors[].ts,各記一條水位線。
   - 只發 P1:halt 只算自動觸發的(source 在白名單;用戶自己按的不是 P1)。
   - 水位線存 userData:同一則不發第二次;第一次跑(沒有水位線)只記不發,不把舊事件倒出來。
   - 超過 15 分鐘的舊事件只推水位線不發;同型別 60 秒內只發一則(拒單會每輪每筆一則),其餘靠 Dock 紅點數字。
   - 點通知 = 把視窗叫出來;視窗回前景就清紅點。 */
// machine_restart_stopped 取代 downtime_paused(api 已改;設計定稿:不講時間,講部位沒人管、平倉停損不會執行、按啟動下單)
const P1_TYPES = ["halt", "order_error", "execution_interrupted", "execution_fallback_market", "execution_stuck", "machine_restart_stopped"];   // 全部六型(標籤用)
const P1_EVENT_TYPES = P1_TYPES.filter((ty) => ty !== "halt" && ty !== "order_error");   // 會出現在 events 裡的四型
const HALT_AUTO_SOURCES = ["reconciler", "portfolio"];   // 同 api openclaw/agent_events._HALT_AUTO_SOURCES
const notifiedPath = () => path.join(app.getPath("userData"), "p1-notified.json");
let p1Marks = undefined, p1Badge = 0; const p1LastShown = {}, p1Alive = new Set();   // p1Alive:Notification 沒人持有會被 GC,click 就不觸發
const p1Num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
function p1Load() { try { const j = JSON.parse(fs.readFileSync(notifiedPath(), "utf8")); return { id: p1Num(j.id), halt: p1Num(j.halt), err: p1Num(j.err) }; } catch (_) { return { id: null, halt: null, err: null }; } }
function p1Save(m) { try { fs.writeFileSync(notifiedPath(), JSON.stringify(m), { mode: 0o600 }); } catch (_) { /* 最壞=重開後同一則再發一次 */ } }
// 時間 → epoch 秒(保留小數:解除後同秒再 HALT 靠微秒分得開)。真實格式是 ISO 字串(稽核 M1'):halt.at 帶時區
// (lib/guard.py),拒單的 ts 是**不帶時區的 UTC**(lib/portfolio.py 的 utcnow().isoformat())——沒有時區尾碼要先補 Z,
// 直接 Date.parse 會被當成本地時間(台北 = 差 8 小時,超過 900 秒門檻,一樣不發)。同 renderer 的 trMs。
const p1Sec = (v) => {
  if (typeof v === "number") return !Number.isFinite(v) ? NaN : v > 1e12 ? v / 1000 : v;
  if (typeof v !== "string" || !v) return NaN;
  if (/^[0-9.]+$/.test(v)) return p1Sec(Number(v));
  const us = (v.match(/\.(\d{4,6})/) || [])[1];   // Date 只到毫秒:微秒那截自己補回去
  const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(v) ? v : v + "Z");
  return !Number.isFinite(ms) ? NaN : ms / 1000 + (us ? Number("0." + us) - Number("0." + us.slice(0, 3)) : 0);
};
function p1FromState(r, mark, nowS) {   // 純函式:halt / 拒單從狀態檔現況推導。mark = { halt, err }(null = 第一次,只記不發)
  const out = { halt: mark.halt, err: mark.err, show: [] }, h = r && r.halt;
  const at = h && h.halted ? p1Sec(h.at) : NaN;
  if (at > (mark.halt == null ? -1 : mark.halt)) {
    out.halt = at;
    if (mark.halt != null && HALT_AUTO_SOURCES.indexOf(h.source) >= 0 && nowS - at <= 900) out.show.push({ type: "halt", ts: at, payload: {} });
  } else if (mark.halt == null) out.halt = 0;
  let top = mark.err == null ? -1 : mark.err;
  for (const e of r && Array.isArray(r.order_errors) ? r.order_errors : []) {
    const ts = e && typeof e === "object" ? p1Sec(e.ts) : NaN;
    if (!(ts > (mark.err == null ? -1 : mark.err))) continue;
    if (ts > top) top = ts;
    if (mark.err != null && nowS - ts <= 900) out.show.push({ type: "order_error", ts, payload: { symbol: typeof e.symbol === "string" ? e.symbol : "" } });
  }
  out.err = top < 0 ? 0 : top;
  return out;
}
function p1Pick(events, mark, nowS) {   // 純函式(tests/check_shell_p1_notify.js):回 { mark, show:[事件] }
  let top = mark == null ? -1 : mark; const show = [];
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev.id !== "number" || typeof ev.type !== "string" || ev.id <= (mark == null ? -1 : mark)) continue;
    if (ev.id > top) top = ev.id;
    if (mark == null || P1_EVENT_TYPES.indexOf(ev.type) < 0 || !(nowS - Number(ev.ts) <= 900)) continue;
    show.push(ev);
  }
  return { mark: top < 0 ? (mark == null ? 0 : mark) : top, show };
}
/* Electron 42 起 macOS 通知走 UNNotification:**沒簽章的 app(npm start、不簽的 pack)一則都不會出現**,只會收到 failed。
   使用者關掉通知權限時也是。通知是 P1 的唯一出口,失敗至少留一行 log——不然「沒收到」查不出是沒發還是被系統吃掉。 */
function notifWatch(n, what) { n.on("failed", (_e, err) => console.error("[notify] " + what + " failed: " + String(err || "").slice(0, 200))); return n; }
function p1Sync() {
  if (!_tradeHost) return;
  const r = _tradeHost.status().report; if (!r) return;
  if (p1Marks === undefined) p1Marks = p1Load();
  const now = Date.now() / 1000, ev = p1Pick(r.events, p1Marks.id, now);
  // 狀態檔這輪 build 失敗(只有 error)時沒有 halt / order_errors:那一輪不動這兩條水位線
  const stt = r.error ? { halt: p1Marks.halt, err: p1Marks.err, show: [] } : p1FromState(r, p1Marks, now);
  if (ev.mark !== p1Marks.id || stt.halt !== p1Marks.halt || stt.err !== p1Marks.err) { p1Marks = { id: ev.mark, halt: stt.halt, err: stt.err }; p1Save(p1Marks); }
  const show = stt.show.concat(ev.show);
  for (const e of show) {
    p1Badge++;
    if (Date.now() - (p1LastShown[e.type] || 0) < 60000) continue;
    p1LastShown[e.type] = Date.now();
    const sym = e.payload && typeof e.payload.symbol === "string" ? e.payload.symbol.replace(/@spot$/, "").slice(0, 24) : "";
    if (!Notification.isSupported()) continue;
    // 這裡的事件全部來自這台電腦的狀態檔:標題第一個詞講是哪一邊(雲端的通知之後由它自己的來源加 notifPrefixCloud)
    const n = new Notification({ title: TT.notifTitle(tmLabels.notifPrefixLocal, tmLabels["ev_" + e.type] + (sym ? " · " + sym : "")), body: tmLabels["ev_" + e.type + "_n"] });
    p1Alive.add(n); const drop = () => p1Alive.delete(n);
    n.on("click", () => { drop(); showMain(); }); n.on("close", drop); n.on("failed", drop); notifWatch(n, "p1 " + e.type);
    if (p1Alive.size > 20) p1Alive.delete(p1Alive.values().next().value);
    n.show();
  }
  if (show.length && app.dock) { if (!BrowserWindow.getFocusedWindow()) app.dock.setBadge(String(p1Badge)); else p1Badge = 0; }
}
/* Binance 金鑰重查出事(binance_link 兩次確認之後才叫):P1 / P2 都走這條本機通知,跟 p1Sync 同一套呈現。只通知、不自動停單、不移除金鑰。
   {where} 由 renderer 交字時就填好(這裡的事件只會來自這台電腦);{ip} 只會是 binance_link 驗過的 IPv4。 */
function binanceNotify(v) {
  // 每一個 binance_check.VERDICT_LEVEL 的 reason 都要在這張表上(tests/check_shell_binance_link 列舉):對不到就回 false = 每 5 分鐘重試到永遠
  const map = { IP_CHANGED: ["key_ipTitle", "key_ipBody"], KEY_REJECTED: ["key_rejTitle", "key_rejSameIpBody"], REJECTED: ["key_rejTitle", "key_rejUnknownBody"],
    TRADING_LOST: ["key_permTitle", "key_permBody"] };
  // 回 true = 真的交給系統了。字還沒交過來 / 系統不支援 → false,binance_link 不會記成已通知,下一輪再試
  const k = map[v && v.reason]; if (!k || !tmLabels[k[0]] || !tmLabels[k[1]] || !Notification.isSupported()) return false;
  const n = new Notification({ title: tmLabels[k[0]], body: tmLabels[k[1]].replace("{ip}", () => v.ip || "—") });
  p1Alive.add(n); const drop = () => p1Alive.delete(n);
  n.on("click", () => { drop(); showMain(); }); n.on("close", drop); n.on("failed", drop); notifWatch(n, "binance " + v.reason);
  n.show();
  // 這幾種全是 P2(binance_check.VERDICT_LEVEL):只發系統通知,**不亮 Dock 紅點**(紅點留給 P1)
  return true;
}
function trayStart() { if (!trayTimer) { trayTimer = setInterval(() => { traySync(); p1Sync(); }, 5000); if (trayTimer.unref) trayTimer.unref(); } }
app.on("browser-window-created", (_e, win) => {
  win.on("close", (e) => {
    // 關視窗不等於結束:自動下單在跑、或本機 agent 回合在跑(可能正在更新雲端)時只把視窗藏起來,回合 / 下單照走
    const trading = tradeMaybeLive(), turn = !!(activeTurn || turnStarting);
    if (quitting || quitConfirmed || (!trading && !turn)) return;
    e.preventDefault(); win.hide();
    // 「背景照常下單」那則只在真的在下單時講(字寫的是下單)
    if (trading && !hiddenSaid && tmLabels.hidden && Notification.isSupported()) { hiddenSaid = true; notifWatch(new Notification({ title: tmLabels.running, body: tmLabels.hidden }), "hidden").show(); }
  });
});
// 結束前先讓 daemon 收工(對帳器要先撤掉自己掛在交易所的限價單);最多等 9 秒,之後不管怎樣都走。
// 就算這段沒跑到(當機、被強殺),daemon 讀到 stdin EOF 也會自己收。
let quitting = false;
app.on("before-quit", (e) => {
  // 自動下單還在跑:結束 = 停止下單、部位留著不平——先問一次(從選單列「結束 Blave…」、Cmd+Q、Dock 結束都走這裡)
  const live = !quitting && !quitConfirmed && tradeMaybeLive();
  if (live) {
    e.preventDefault();
    if (quitAsking) return;   // 框還開著又按一次 Cmd+Q:不疊第二個(稽核 M2)
    quitAsking = true;
    showMain();
    dialog.showMessageBox(BrowserWindow.getAllWindows()[0] || undefined, { type: "warning", message: tmLabels.quitTitle,
      // 雲端也「確定在下單」時多一句:結束這個 app 不影響雲端。不確定就不說(那一句是在替雲端做保證)
      detail: TT.quitDetail(tmLabels.quitBody.replace("{venue}", () => venueName(live.venue)), TT.cloudTrading(cloudSt()) ? tmLabels.quitCloudNote : ""), buttons: [tmLabels.quitStay, tmLabels.quitGo], defaultId: 0, cancelId: 0 })
      .then((r) => { quitAsking = false; if (r.response === 1) { quitConfirmed = true; app.quit(); } }, () => { quitAsking = false; });
    return;
  }
  // 本機 agent 回合還在跑(可能正在更新雲端主機):結束會把它斷掉,先問一次(同自動下單那一道;已經確認過就不再問)
  if (!quitting && !quitConfirmed && (activeTurn || turnStarting)) {
    e.preventDefault();
    if (quitAsking) return;
    quitAsking = true;
    showMain();
    dialog.showMessageBox(BrowserWindow.getAllWindows()[0] || undefined, { type: "warning", message: tmLabels.quitTurnTitle,
      detail: tmLabels.quitTurnBody, buttons: [tmLabels.quitStay, tmLabels.quitGo], defaultId: 0, cancelId: 0 })
      .then((r) => { quitAsking = false; if (r.response === 1) { quitConfirmed = true; app.quit(); } }, () => { quitAsking = false; });
    return;
  }
  if (quitting || !_tradeHost || !_tradeHost.isRunning()) return;
  e.preventDefault(); quitting = true;
  _tradeHost.stop().finally(() => app.quit());
});
