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
  accountStatus();   // 換了 AI:現況立刻帶給 api(提醒信 K 型以它為準;沒登入就不打)
  return true;
}
const clearConnection = () => { const r = connStore().clear(); accountStatus(); return r; };
const loadConnection = () => connStore().load();

// ── 使用追蹤(telemetry.js:十八個事件、屬性只有列舉、沒有自由文字的入口;設定裡可關)──
let _tm = null;
function tm() {
  if (!_tm) _tm = require("./telemetry").createTelemetry({
    dir: app.getPath("userData"), endpoint: `${API_BASE}/oauth/desktop/telemetry`,
    appVersion: app.getVersion(), osVersion: process.getSystemVersion(), lang: app.getLocale(),   // 契約:系統語系原值;不吃 BLAVE_LANG(任意字串會原樣離開電腦)
    getToken: () => loadToken(),
    heartbeat: () => ({ live: tradeMaybeLive() ? "on" : "off" }),   // 每日在線心跳;live 同 updater 的 isTrading 判準
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
let _capital = null;   // 雲端群益開通(cloud_capital.js):選好的 pfx 只在這一份記憶體裡
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
    // Windows 包沒有 Authenticode:更新只收離線私鑰簽過的 yml(updatesig.js)。mac 由 Squirrel 驗 Developer ID,不走這條
    signed: feedUrl && process.platform === "win32" ? { keys: require("./update-keys.json") } : null,
    feedUrl, currentVersion: app.getVersion(),
    isTrading: () => !!tradeMaybeLive(),   // 保守判定:可能還在下單就不裝
    onState: (st) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("update-state", { ...st, backup: _officialBackup, restarting: !!restarting });
      // 已經為了更新收工、交給 quitAndInstall 之後 Squirrel 才失敗(它是 setImmediate 排的,restartToUpdate 早就回了):改走結束 app(稽核 P1-2)
      if (restarting === "installing" && st.phase === "error") app.quit();
    },
    log: (m) => console.error("[updater] " + m),
    onFail: (stage) => tm().track("update_failed", { stage }),
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
/* Blave 餘額(balance.js):電腦版自己的端點,帶帳號 token + app_secret;只回數字給自家畫面,憑證不出主行程。 */
let _balance = null;
function balanceHost() {
  if (!_balance) _balance = require("./balance").createBalance({ apiBase: API_BASE, post: (u, b) => postJSON(u, b),
    getCreds: () => { const token = loadToken(); return token ? { token, appSecret: loadAppSecret() } : null; } });
  return _balance;
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
  if (_capital) _capital.forget();   // 選好還沒上傳的群益憑證檔:是上一個人的
  if (_mcp) _mcp.reset();       // 接入碼也是:伺服器那邊 /revoke 會撤掉它,這裡把記憶體裡的丟掉、作廢在途的請求
  if (_balance) _balance.reset();   // 上一個帳號的餘額
  lastAcct = null;
  return { revoked };
}

function postJSON(url, body, extra) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = require("https").request(url, {
      timeout: 20000,
      ...(extra || {}),   // my_ip:{ family: 4 } 強制走 IPv4;報告分享的上傳:{ timeout } 放長
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
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
  if (_balance) _balance.reset();     // 餘額也是
  libCache = null;                    // 同理:策略庫的 purchased / is_owner 是帳號的
  accountStatus();                    // 登入完成就把 app 的現況(使用事件開關、連的 AI)帶給 api,不等畫面去問
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

// ~/Blave 的官方檔案:workspace 逐目錄從 repo 拷(照 README 的 merge 清單)。
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
  for (const f of OFFICIAL_FILES) { if (f === "VERSION") writeOfficialManifest(); fs.cpSync(path.join(REPO, f), path.join(WS, f)); }
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
function officialList() {
  const files = OFFICIAL_FILES.filter((f) => f !== "VERSION");
  for (const d of OFFICIAL_DIRS) if (fs.existsSync(path.join(REPO, d))) files.push(...listFiles(REPO, d));
  return files;
}
/* 「用戶改過」的基準是**舊的官方版**,不是新隨包(0.1.11 Windows 真機:0.1.6 → 0.1.10 把新版改到的 38 個檔全說成「你改過的」)。
   舊的官方版從兩處認,任一處認得就是原封不動的官方檔:
   ① state/official-manifest.json:copyOfficial 每次拷完記下的 {路徑: git blob sha}(0.1.11 起)——放在 workspace 外,agent 動不到;
   ② shell/official-known.json:0.1.10 以前拷進去的沒有 ①,改認這條路徑在 git 歷史裡出現過的每一版(凍結在 0.1.11 之前,
      跟雲端 manager/update_workspace.py 的 history() 同一個判準)。
   hash 用 git 的 blob sha;Windows 上被轉成 CRLF 的檔多比一次轉回 LF 的 */
const OFFICIAL_MANIFEST = path.join(BASE, "state", "official-manifest.json");
const OFFICIAL_KNOWN = path.join(__dirname, "official-known.json");
const blobSha = (buf) => crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
const relKey = (f) => f.split(path.sep).join("/");
function readJsonObj(p) { try { const v = JSON.parse(fs.readFileSync(p, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch (_) { return null; } }
function officialKnown() {
  const m = readJsonObj(OFFICIAL_MANIFEST), k = readJsonObj(OFFICIAL_KNOWN);
  const had = (m && m.files && typeof m.files === "object") ? m.files : {}, hist = (k && k.paths && typeof k.paths === "object") ? k.paths : {};
  return (f, buf) => {
    const key = relKey(f), shas = [blobSha(buf)];
    if (buf.includes(13)) shas.push(blobSha(Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1")));
    return shas.some((h) => had[key] === h || (Array.isArray(hist[key]) && hist[key].includes(h)));
  };
}
// 拷完官方檔、寫 VERSION 之前記下這一版每個檔的 blob sha(下次更新時的「舊官方版」)。記不下來不擋更新:只是退回 ② 的判準
function writeOfficialManifest() {
  try {
    const files = {};
    for (const f of officialList()) files[relKey(f)] = blobSha(fs.readFileSync(path.join(REPO, f)));
    fs.mkdirSync(path.dirname(OFFICIAL_MANIFEST), { recursive: true });
    fs.writeFileSync(OFFICIAL_MANIFEST + ".tmp", JSON.stringify({ files }));
    fs.renameSync(OFFICIAL_MANIFEST + ".tmp", OFFICIAL_MANIFEST);
  } catch (e) { console.error("[update] official manifest not written: " + (e && e.message)); }
}
function backupChangedOfficial(tag) {
  const known = officialKnown(), dest = path.join(WS, ".official-backup", tag), saved = [];
  for (const f of officialList()) {
    let mine; try { mine = fs.readFileSync(path.join(WS, f)); } catch (_) { continue; }   // workspace 沒有這個檔:沒東西可備份
    if (mine.equals(fs.readFileSync(path.join(REPO, f)))) continue;
    if (known(f, mine)) continue;   // 舊的官方版原封不動:是新版改了它,不是用戶改的——直接覆寫,不備份也不報
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

const AGENT_SDK = "claude-agent-sdk==0.2.159";
// cryptography 跟 SDK 一起釘:SDK → mcp → pyjwt[crypto] 拉進它,50.x 起 macOS 只出 arm64 wheel,Intel(含被 Rosetta
// 跑成 x64)會退到從原始碼編(要 Rust,用戶機沒有)——0.0.6 通用版在 Intel 就死在這裡。48.0.1 是最後一版 universal2 wheel,
// 兩種架構釘同一版。記號檔比的是整串,所以既有 venv 在下一則訊息(ensure-engine 每次送訊息前都跑)會重跑一次
// SDK 那條:把 50.0.1 換成 48.0.1,下載約 8 MB。
const SDK_PINS = `${AGENT_SDK} cryptography==48.0.1`;
/* 引擎安裝與它的進度快照在 enginesetup.js(建 workspace → venv + SDK → 策略套件一個一個裝)。冪等:裝過就跳過。
   開 app 就在背景跑(engineKick);送出每一句之前 ensure-engine 再確認一次,跑到一半就接上同一份 */
// 第一次要下載的量(SDK 那條 + WORKSPACE_DEPS 17 個,兩條共用的檔只算一次;pip dry-run / download 實測,SDK 的 wheel 帶 Claude CLI 就占 93–104 MB)。
// 依平台不同:macOS 13 以下拿到的 scipy / numpy 是 OpenBLAS 版、比較大。實測 macOS 14+ Apple 晶片 209、Intel 217、macOS 12/13 Apple 晶片 224、
// Intel 235、Windows 227(MB),各自往上取到 10 MB 當「約」值。量的是加了 yfinance 那一版的清單;SDK_PINS 或 WORKSPACE_DEPS 換了要重量一次。
// 更新後補裝的量每一版都不同,不寫(畫面只在第一次寫大小)。process.arch 在 Rosetta 下是 x64,挑到的正是 x64 的 wheel
function firstRunMB(platform = process.platform, arch = process.arch, darwinMajor = Number(os.release().split(".")[0])) {
  if (platform === "win32") return 230;
  if (platform === "darwin" && darwinMajor < 23) return arch === "arm64" ? 230 : 240;   // Darwin 23 = macOS 14
  return arch === "arm64" ? 210 : 220;
}
// 每一條 pip 兩道停:
//   PIP_IDLE_MS(2 分鐘):下載中多久沒有新的資料就停——斷線、被擋都會落在這裡,以網路失敗呈現。慢但一直有在動的不會被它停掉:
//   以前的固定 10 分鐘上限在 SDK 那一條(單一 wheel 93–104 MB)要約 172 KB/s 才裝得完,網速再慢就永遠失敗,重試又從 0 開始。
//   PIP_TOTAL_MS(45 分鐘):只防真的卡死。最大的一條(Windows 的 SDK wheel 103.5 MB)在 40 KB/s 下約 43 分鐘;比這更慢的網路,
//   210 MB 的第一次安裝本來就要一個半小時以上,停下來讓人知道比讓它無聲地跑更好。
// 建 venv 不用網路,只有總上限
const ENGINE_PIP_MS = 2700000, PKG_PIP_MS = 2700000, PIP_IDLE_MS = 120000, VENV_MS = 300000;
// 選用的套件組:裝不起來不擋引擎(只記 log、那個功能暫時不能用,下次開 app 再試)。點名用套件名,版本照 WORKSPACE_DEPS;
// 清單裡沒被點名的一律是核心(裝不起來就擋聊天)。美股資料(yfinance 與它的相依)只有美股功能用得到,lib 要在用到時才 import
const OPTIONAL_DEPS = [{ id: "us", names: ["yfinance", "curl_cffi", "lxml", "peewee", "protobuf", "websockets", "beautifulsoup4", "multitasking", "platformdirs", "pytz"] }];
let _engineSetup = null;
function engineSetup() {
  if (!_engineSetup) _engineSetup = require("./enginesetup").createEngineSetup({
    fs, path, spawn: require("child_process").spawn, base: BASE, ws: WS, venvPy: VENV_PY, venvBin: VENV_BIN, win: WIN,
    basePython, envPath: loginShellPath, pyEnv: { ...PY_ENV, ...(WIN ? WIN_PY_ENV : {}) }, copyOfficial, isPackaged: app.isPackaged,
    sdkPins: SDK_PINS, deps: WORKSPACE_DEPS, optional: OPTIONAL_DEPS, firstRunMB: firstRunMB(), venvMs: VENV_MS, engineMs: ENGINE_PIP_MS, pkgMs: PKG_PIP_MS, idleMs: PIP_IDLE_MS,
    onChange: (s) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && isOurPageUrl(w.webContents.getURL())) w.webContents.send("engine-state", s); },
    log: (m) => console.error(m),
    // 結果類事件由主行程送:背景安裝可能在畫面開始聽之前就跑完了
    track: (ev, props) => tm().track(ev, props),
  });
  return _engineSetup;
}
function ensureEngine() { return engineSetup().ensure(); }
// 結束 app / 為了更新重開之前收掉正在跑的 pip(最多等 5 秒);沒在裝就立刻回來,永遠不拋
function engineAbort() { return _engineSetup ? _engineSetup.abort().catch(() => false) : Promise.resolve(false); }

// 這份清單是**列舉出來的**,不是憑印象:用 AST 掃 lib/ manager/ examples/ 與兩支策略
// 模板(75 個檔)的頂層 import,扣掉標準庫與 workspace 自己的模組,再逐一實際 import。
// 第一版憑 grep 少了 python-dotenv(lib/runner.py 第一行就要它)與 scipy。
// 刻意不裝:shioaji(永豐下單 SDK,有綁該券商的人才需要)、comtypes / pythoncom
// (群益的 COM 介面,只有 Windows 有)。
// 釘版本:打包版在實機裝到、並跑過一輪回測的那組(隨包 CPython 3.12;arm64 與 x64/Rosetta 都只靠 wheel 裝得起來)。升版要重跑那輪驗證。
// yfinance(lib/data.py 美股日線的備援)連同它拉進來的九個一起釘,yfinance 排最後:一個一個裝時它那一步才不會把後面的全裝走。
// 2026-10-01 驗過:這 17 個加上依賴(34 個)在 mac arm64、mac x86_64、win amd64 都有 cp312 / abi3 / 純 Python wheel
// (pip download --only-binary=:all:),arm64 與 x64 隨包 CPython 3.12 一次全裝與一個一個 -c 裝的 pip freeze 相同。
// cffi、pycparser(curl_cffi 的)與 soupsieve、typing_extensions(bs4 的)不在清單上,跟 matplotlib 自己的依賴一樣由 pip 解
const WORKSPACE_DEPS = [
  "pandas==3.0.6", "numpy==2.5.3", "matplotlib==3.11.2", "pyarrow==25.0.1",
  "requests==2.34.2", "python-dotenv==1.2.3", "scipy==1.18.1",
  "curl_cffi==0.16.3", "lxml==6.1.3", "peewee==4.5.2", "protobuf==7.36.2", "websockets==17.1",
  "beautifulsoup4==4.15.0", "multitasking==0.0.13", "platformdirs==4.12.2", "pytz==2026.4",
  "yfinance==1.7.0",
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
  // SYMBOL / INTERVAL:轉出的貼上步驟與「加密 → XQ」判斷用(renderer/export.js)
  return { displayName: pick("DISPLAY_NAME"), description: pick("DESCRIPTION"), strategyName: pick("STRATEGY_NAME"), symbol: pick("SYMBOL"), interval: pick("INTERVAL") };
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

/* 側欄順序 = 最近被人或 agent 動過的在上面:程式碼、明確回測(stats 的 Generated At,秒)、參數掃描。
   不看 stats.json 的 mtime——上線中的策略每根 K 的 live tick 都重寫它(Generated At 不動),那一支每小時跳回第一,
   重開 app、切語言重畫時順序就跟著變。舊 stats 沒有 Generated At 才退回檔案時間;同時間照資料夾名,順序才固定 */
const stratTouchedAt = (x) => Math.max(x.codeMtime || 0, x.scanMtime || 0, x.wfMtime || 0, x.generatedAt ? x.generatedAt * 1000 : x.statsMtime || 0);
const stratOrder = (a, b) => stratTouchedAt(b) - stratTouchedAt(a) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
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
    // wf.json(樣本外驗證)同理;它不出結果卡(web 也沒有),只讓開著的那支原地重畫(renderer/app.js stratRefresh)
    let wfMtime = 0;
    try { wfMtime = fs.statSync(path.join(dir, "wf.json")).mtimeMs; } catch (_) {}
    const touched = Math.max(mtime, sMtime, scMtime, wfMtime);
    // 三個 mtime 分開交出去:聊天結果卡要分得出這一輪動的是程式碼、回測還是掃描(renderer/results.js)
    const parts = { codeMtime: mtime, statsMtime: sMtime, scanMtime: scMtime, wfMtime, version: stratVersionNow(dir) };
    const hit = stratCache.get(name);
    if (hit && hit.mtime === sMtime && hit.cMtime === mtime) return { ...hit.summary, ...parts, mtime: touched };
    let displayName = null;
    try { displayName = stratMeta(fs.readFileSync(path.join(dir, "strategy.py"), "utf8")).displayName; } catch (_) {}
    let summary = { name, displayName, hasBacktest: false, sharpe: null, totalReturn: null, maxDrawdown: null, generatedAt: null };
    if (sMtime) {
      try {
        const st = JSON.parse(fs.readFileSync(statsPath, "utf8"));
        // generatedAt:只有明確回測會重蓋(lib/runner.py _carry_over),live tick 每根 K 重寫 stats.json 但不動它——結果卡靠它認「這一輪跑了回測」
        summary = { name, displayName, hasBacktest: true, sharpe: num(st["Sharpe Ratio"]), totalReturn: num(st["Total Return [%]"]),
          maxDrawdown: num(st["Max Drawdown [%]"]), generatedAt: num(st["Generated At"]) };
        tm().track("first_backtest_done");   // 每個安裝只會送出一次(telemetry.js 自己記)
      } catch (_) { /* 寫到一半或壞掉:當成還沒有回測 */ }
    }
    stratCache.set(name, { mtime: sMtime, cMtime: mtime, summary });
    return { ...summary, ...parts, mtime: touched };
  }).sort(stratOrder);
}
// 最新定版的版號(lib/runner.py _mint_version 的 versions/index.json `current`);沒定過版 / 讀不到 = null。照 index 的 mtime 快取
const stratVerCache = new Map();
function stratVersionNow(dir) {
  const p = path.join(dir, "versions", "index.json");
  let m = 0; try { m = fs.statSync(p).mtimeMs; } catch (_) { stratVerCache.delete(p); return null; }
  const hit = stratVerCache.get(p);
  if (hit && hit.m === m) return hit.v;
  let v = null;
  try { const idx = JSON.parse(fs.readFileSync(p, "utf8")); v = Number.isInteger(idx && idx.current) && idx.current > 0 ? idx.current : null; } catch (_) { v = null; }
  stratVerCache.set(p, { m, v });
  return v;
}

/* agent 寫的結果檔(scan.json / wf.json):只讀一般檔(symlink 不跟)、有大小上限(同 RES_FILE_MAX / RPT_BYTES_MAX 的 2MB)——
   過大的檔會在主行程同步讀、卡住整個 app。沒有 / 寫到一半 / 過大 / 不是物件 → null,renderer 畫空狀態(稽核 P2-6)。
   實際大小:scan 40×40 格約 30KB;wf 上限 1000 輪 × 約 225B + 曲線 4000 點,約 350KB */
const RESULT_JSON_MAX = 2 * 1024 * 1024;
/* 開檔就不跟 symlink(O_NOFOLLOW)、不在 FIFO 上卡住(O_NONBLOCK),檢查對的是「開到的那一個檔」(fstat fd,不是先 lstat 路徑再另外讀——
   兩步之間可以被換成 symlink / FIFO / 還在長大的檔,複驗 P2-R5),讀的時候最多讀上限 + 1 byte,讀超過就當沒有。
   Windows 沒有 O_NOFOLLOW:退回先 lstat 擋 symlink(那一步之後的換檔在 Windows 上擋不到,威脅模型同樣只剩同 user 的程式) */
function readResultJson(p) {
  const C = fs.constants;
  let fd = null;
  try {
    if (C.O_NOFOLLOW === undefined && !fs.lstatSync(p).isFile()) return null;
    fd = fs.openSync(p, C.O_RDONLY | (C.O_NOFOLLOW || 0) | (C.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > RESULT_JSON_MAX) return null;
    const buf = Buffer.alloc(Math.min(st.size, RESULT_JSON_MAX) + 1);
    let n = 0, r = 0;
    while (n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, null)) > 0) n += r;
    if (n >= buf.length) return null;   // 比 fstat 說的還長 = 讀的時候還在長大(或被換掉):不收
    const v = JSON.parse(buf.toString("utf8", 0, n));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch (_) { return null; }
  finally { if (fd !== null) try { fs.closeSync(fd); } catch (_) { /* 關不掉也不影響結果 */ } }
}
function loadStrategy(name) {
  if (!stratNames().includes(name)) return null;
  const dir = path.join(STRAT_DIR(), name);
  let stats = null, code = "";
  try { stats = JSON.parse(fs.readFileSync(path.join(dir, "stats.json"), "utf8")); } catch (_) {}
  // 參數掃描(lib/param_scan.write_scan 的 scan.json)與樣本外驗證(lib/walk_forward.run_walk_forward 的 wf.json):
  // 逐欄檢查在 renderer/report-robust.js 的 sanitizeScan / report-wf.js 的 sanitizeWf
  const scan = readResultJson(path.join(dir, "scan.json")), wf = readResultJson(path.join(dir, "wf.json"));
  try { code = fs.readFileSync(path.join(dir, "strategy.py"), "utf8"); } catch (_) {}
  return { name, stats, scan, wf, code, dataSources: stratDataSources(dir), versions: stratVersions(dir), ...stratMeta(code), exports: stratExports(dir, code), cryptoKline: stratUsesKline(dir) };
}
/* 轉出檔(references/{xq-xs,multicharts-powerlanguage,tradingview-pine}.md 存的三個固定檔名)。
   讀檔規則同 runtime `_read_export`:regular file、≤256KB;讀不到那一份就當沒有(不猜、不報錯)。
   stale = 策略在轉出之後改過:有 lint 寫的 sidecar 就比 sha256(mtime 會被 git checkout / 複製資料夾誤觸),沒有才比 mtime。 */
const EXPORT_FILES = { xq: "xq.xs", mc: "mc.txt", pine: "pine.pine" };
const EXPORT_MAX = 256 * 1024;
function readExportFile(dir, target) {
  const p = path.join(dir, "exports", EXPORT_FILES[target]);
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.size > EXPORT_MAX) return null;
    const content = fs.readFileSync(p, "utf8");
    return Buffer.byteLength(content, "utf8") > EXPORT_MAX ? null : { p, content, mtime: st.mtimeMs };
  } catch (_) { return null; }
}
function stratExports(dir, code) {
  let codeMtime = 0; try { codeMtime = fs.statSync(path.join(dir, "strategy.py")).mtimeMs; } catch (_) {}
  const sha = require("crypto").createHash("sha256").update(Buffer.from(code || "", "utf8")).digest("hex");
  const out = [];
  for (const target of Object.keys(EXPORT_FILES)) {
    const f = readExportFile(dir, target); if (!f) continue;
    let meta = null;
    try { const st = fs.lstatSync(f.p + ".meta.json"); if (st.isFile() && st.size < 4096) meta = JSON.parse(fs.readFileSync(f.p + ".meta.json", "utf8")); } catch (_) {}
    const hash = meta && typeof meta.source_sha256 === "string" && /^[0-9a-f]{64}$/.test(meta.source_sha256) ? meta.source_sha256 : null;
    const at = meta && typeof meta.exported_at === "string" ? Date.parse(meta.exported_at) : NaN;
    out.push({ target, content: f.content, exportedAt: isFinite(at) ? at : f.mtime, stale: hash ? hash !== sha : codeMtime > f.mtime });
  }
  return out;
}
// 資料夾裡任一支 .py 用到 fetch_kline(Binance USDT-M)= 加密;XQ 沒有加密市場(掃法同 stratDataSources)
function stratUsesKline(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".py")).slice(0, 50); } catch (_) { return false; }
  return files.some((f) => { try { const p = path.join(dir, f); return fs.lstatSync(p).isFile() && /\bfetch_kline\b/.test(fs.readFileSync(p, "utf8")); } catch (_) { return false; } });
}
/* 「下載…」:主行程自己讀檔、自己開存檔框、自己寫。renderer 只給策略名與 target,不給內容、不給路徑
   (它會渲染 LLM 的文字,不能讓它決定寫哪個檔、寫什麼)。走存檔框而不是直接寫進「下載」:macOS 對直接寫
   ~/Downloads 會跳一次檔案存取權限,存檔框是用戶自己選的位置、不經那一關。
   回 { ok, dir, token }:token 給「在 Finder 中顯示」用,只認這裡存過的路徑。 */
const savedExports = new Map();   // token → 存好的完整路徑(只在記憶體)
/* ref = { session, id }:對話裡那張卡 → 存的是那一輪轉出時的快照(同 web:卡下載的是那則訊息帶的內容);
   ref = { strategy, target }:程式碼分頁 → 存的是 workspace 裡現在那一份 */
async function saveExport(win, ref) {
  let name, target, f;
  if (ref && typeof ref.id === "string") {
    const r = exportById(ref.session, ref.id); if (!r) return { ok: false };
    name = r.strategy; target = r.target; f = readSnap(r.snap);
  } else {
    name = String((ref && ref.strategy) || ""); target = String((ref && ref.target) || "");
    if (!stratNames().includes(name) || !EXPORT_FILES[target]) return { ok: false };
    f = readExportFile(path.join(STRAT_DIR(), name), target);
  }
  if (!f) return { ok: false };
  const ext = EXPORT_FILES[target].split(".").pop();
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("downloads"), `${name}_${target}.${ext}`) });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try { fs.writeFileSync(r.filePath, f.content, "utf8"); } catch (_) { return { ok: false }; }
  return { ok: true, ...savedRef(r.filePath) };
}
// 剛存好的那個檔 → { dir, token }:畫面只拿資料夾名與 token,「在 Finder 中顯示」憑 token 回來找路徑(轉出卡與報告 PDF 共用)
function savedRef(filePath) {
  const token = require("crypto").randomBytes(8).toString("hex");
  savedExports.set(token, filePath);
  if (savedExports.size > 50) savedExports.delete(savedExports.keys().next().value);
  const dir = path.dirname(filePath);   // 「下載」回 null:資料夾在磁碟上叫 Downloads,Finder 顯示的是系統語言的名字,由畫面翻
  return { dir: dir === app.getPath("downloads") ? null : path.basename(dir), token };
}
/* 策略版本(.claude/docs/strategy-versions.md §9):lib/runner.py 的 _mint_version 寫進 strategies/<資料夾>/versions/。
   摘要清單的形狀 = runtime strategy_reporter._read_versions(雲端視角從 /cloud/strategy 拿到的同一顆),renderer 用同一套畫。
   讀不到 / 沒定過版 = null(畫面就是沒有版本介面)。items 逐筆只驗是物件,欄位型別由 renderer 的 strategy_versions.js 驗 */
function stratVersions(dir) {
  const vdir = path.join(dir, "versions");
  let idx = null;
  try { idx = JSON.parse(fs.readFileSync(path.join(vdir, "index.json"), "utf8")); } catch (_) { return null; }
  if (!idx || typeof idx !== "object" || !Array.isArray(idx.items)) return null;
  const out = { counter: idx.counter, current: idx.current, items: idx.items.filter((i) => i && typeof i === "object" && !Array.isArray(i)),
    drift: fs.existsSync(path.join(vdir, "drift.json")) };
  if (libRestoreInPlace(path.dirname(path.dirname(dir)))) out.inplace = true;
  const rerun = stratRerun(vdir);
  if (rerun) out.rerun = rerun;
  return out;
}
/* 就地還原的兩個欄位(canon §9),規則同 runtime strategy_reporter 的 lib_restore_in_place / _read_rerun:
   inplace = workspace 的 lib/strategy.py 有 `RESTORE_IN_PLACE = 1` 那一行(文字比對、照 mtime 快取);
   rerun = versions/rerun.json 的 {n, status, at, err?},每個欄位驗型別,壞掉就當沒有 */
const RERUN_ERRS = ["REFUSED", "DATA", "TIMEOUT", "EXIT"];
const libRestoreCache = new Map();
function libRestoreInPlace(ws) {
  const p = path.join(ws, "lib", "strategy.py");
  let st = null; try { st = fs.statSync(p); } catch (_) { libRestoreCache.delete(p); return false; }
  const key = st.mtimeMs + ":" + st.size, hit = libRestoreCache.get(p);
  if (hit && hit.key === key) return hit.ok;
  let ok = false; try { ok = /^RESTORE_IN_PLACE\s*=\s*1\b/m.test(fs.readFileSync(p, "utf8")); } catch (_) { ok = false; }
  libRestoreCache.set(p, { key, ok });
  return ok;
}
function stratRerun(vdir) {
  let d = null; try { d = JSON.parse(fs.readFileSync(path.join(vdir, "rerun.json"), "utf8")); } catch (_) { return null; }
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  if (!Number.isInteger(d.n) || d.n <= 0 || (d.status !== "running" && d.status !== "failed") || !Number.isInteger(d.at)) return null;
  const out = { n: d.n, status: d.status, at: d.at };
  if (d.status === "failed") out.err = RERUN_ERRS.indexOf(d.err) >= 0 ? d.err : "EXIT";
  return out;
}
// 版號只收正整數(api agent_strategy_versions.MAX_VERSION_N 同一個上限):renderer 給的東西進 path.join 之前先過這關
const versionN = (n) => (Number.isInteger(n) && n > 0 && n <= 1000000 ? n : null);
/* 單版 blob(v<N>.json)。回 { code: "OK", blob } | { code: "ERROR" }:這台電腦沒有「還在同步」這一態——
   檔案就在磁碟上,讀不到只會是寫到一半、壞掉,或已經被 20 版的保留砍掉 */
function loadVersion(name, n) {
  const v = versionN(n);
  if (v === null || !stratNames().includes(name)) return { code: "ERROR" };
  try {
    const b = JSON.parse(fs.readFileSync(path.join(STRAT_DIR(), name, "versions", `v${v}.json`), "utf8"));
    return b && typeof b === "object" && !Array.isArray(b) ? { code: "OK", blob: b } : { code: "ERROR" };
  } catch (_) { return { code: "ERROR" }; }
}
/* 兩版的程式碼差異:跑 Python 的 difflib,跟 api 的 compare 端點(agent_strategy_versions._code_lines / _hunks)同演算法、
   同上限——兩個視角比同一對碼,差異行才一樣。-I:不讀環境變數與 user site;碼走 stdin,輸出 ensure_ascii(Windows 的 stdout 編碼不影響) */
const VERSION_DIFF_PY = [
  "import difflib, json, re, sys",
  "HUNK = re.compile(r'^@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@')",
  "def lines(code):",
  "    if not isinstance(code, str): return [], False",
  "    ls = code.splitlines()",
  "    return ls[:20000], len(ls) > 20000",
  "src = json.loads(sys.stdin.buffer.read().decode('utf-8'))",
  "a, a_cut = lines(src.get('a'))",
  "b, b_cut = lines(src.get('b'))",
  "out, total, cut = [], 0, False",
  "for line in difflib.unified_diff(a, b, lineterm='', n=3):",
  "    m = HUNK.match(line)",
  "    if m:",
  "        out.append({'a_start': int(m.group(1)), 'a_count': int(m.group(2) if m.group(2) is not None else 1),",
  "                    'b_start': int(m.group(3)), 'b_count': int(m.group(4) if m.group(4) is not None else 1), 'lines': []})",
  "        continue",
  "    if not out: continue",
  "    if total >= 5000:",
  "        cut = True",
  "        break",
  "    out[-1]['lines'].append([{'+': 'add', '-': 'del'}.get(line[:1], 'ctx'), line[1:]])",
  "    total += 1",
  "print(json.dumps({'hunks': out, 'truncated': bool(a_cut or b_cut or cut)}))",
].join("\n");
const VERSION_META_KEYS = ["n", "at", "note", "code_hash", "ret", "sharpe", "sortino", "mdd", "trades", "mcpt_p", "start", "end"];
// 回 { code: "OK", data: api compare 端點同形狀 { strategy, a, b, hunks, truncated } } | { code: "ERROR" }
function compareVersions(name, a, b) {
  const A = loadVersion(name, a), B = loadVersion(name, b);
  if (A.code !== "OK" || B.code !== "OK") return Promise.resolve({ code: "ERROR" });
  const meta = (blob, n) => { const o = {}; VERSION_META_KEYS.forEach((k) => { o[k] = blob[k] === undefined ? null : blob[k]; }); o.n = n; return o; };
  const py = fs.existsSync(VENV_PY) ? VENV_PY : basePython();
  return new Promise((resolve) => {
    const cp = execFile(py, ["-I", "-c", VERSION_DIFF_PY], { timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...PY_ENV } }, (err, stdout) => {
      let d = null;
      try { d = err ? null : JSON.parse(String(stdout)); } catch (_) { d = null; }
      resolve(d && Array.isArray(d.hunks) ? { code: "OK", data: { strategy: name, a: meta(A.blob, a), b: meta(B.blob, b), hunks: d.hunks, truncated: d.truncated === true } } : { code: "ERROR" });
    });
    cp.stdin.on("error", () => {});
    cp.stdin.end(JSON.stringify({ a: A.blob.code, b: B.blob.code }));
  });
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
/* 還原的背景重跑(runtime command_listener._start_rerun,versions/rerun.json)還在跑就殺掉——同雲端的 _cmd_delete_strategy。
   身分要對上才殺:pid 可能已經換人,所以 script 必須是那支策略的兩種路徑之一、而且真的出現在那個 pid 的命令列上
   (同 runtime 的 _rerun_pid_alive)。它自己一個 session / process group,連子行程一起殺。盡力而為:殺不到也照刪,
   runner 讀不到策略檔就整輪不寫(lib/runner._superseded)。sys 可替換,給測試用 */
function stratStopRerun(names, sys) {
  const X = sys || { exec: require("child_process").execFileSync, kill: process.kill.bind(process), platform: process.platform };
  const ok = /^[A-Za-z0-9_-]{1,128}$/;
  for (const n of new Set((names || []).filter((x) => typeof x === "string" && ok.test(x)))) {
    let d = null; try { d = JSON.parse(fs.readFileSync(path.join(STRAT_DIR(), n, "versions", "rerun.json"), "utf8")); } catch (_) { continue; }
    if (!d || d.status !== "running" || !Number.isInteger(d.pid) || d.pid <= 1) continue;
    if (d.script !== "strategies/" + n + "/strategy.py" && d.script !== "strategies/" + n + ".py") continue;
    let cmd = "";
    try {
      cmd = String(X.platform === "win32"
        ? X.exec("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter 'ProcessId=" + d.pid + "').CommandLine"], { timeout: 5000, windowsHide: true })
        : X.exec("ps", ["-o", "args=", "-p", String(d.pid)], { timeout: 5000 }));
    } catch (_) { continue; }
    if (!cmd.replace(/\\/g, "/").includes(d.script)) continue;
    try {
      if (X.platform === "win32") X.exec("taskkill", ["/T", "/F", "/PID", String(d.pid)], { timeout: 10000, windowsHide: true });
      else { try { X.kill(-d.pid, "SIGKILL"); } catch (_) { X.kill(d.pid, "SIGKILL"); } }
    } catch (_) { /* 已經結束了 */ }
  }
}
/* 回 true(進垃圾桶了)或 { ok:false, code }——沒刪成的每一條路都要帶 code,畫面照它講原因(回裸 false 時畫面無從講起,
   Wei 10-01 按「移到垃圾桶？」完全沒反應):TURN_RUNNING(回合進行中或正要開始:agent 可能正在讀寫它)/ NOT_FOUND(資料夾已不在)/
   IN_PORTFOLIO(還在組合裡:對帳器照這個名字在下單,刪了訊號就凍住)/ CONFIG_UNREADABLE(讀不到下單設定,寧可等一下)/
   TRASH_FAILED(系統的垃圾桶不收) */
async function deleteStrategy(name) {
  if (activeTurn || turnStarting) return { ok: false, code: "TURN_RUNNING" };
  if (!stratNames().includes(name)) return { ok: false, code: "NOT_FOUND" };
  let sn = null; try { sn = stratMeta(fs.readFileSync(path.join(STRAT_DIR(), name, "strategy.py"), "utf8")).strategyName; } catch (_) { /* 讀不到檔:只比資料夾名 */ }
  const inPf = inPortfolio([name, sn]);
  if (inPf === true) return { ok: false, code: "IN_PORTFOLIO" };
  if (inPf === null) return { ok: false, code: "CONFIG_UNREADABLE" };
  stratStopRerun([name, sn]);   // canon §8:還原的背景重跑還活著就先停掉,不讓它寫回已丟進垃圾桶的資料夾
  try { await shell.trashItem(path.join(STRAT_DIR(), name)); stratCache.delete(name); return true; }
  catch (_) { return { ok: false, code: "TRASH_FAILED" }; }
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
      // 不截 120:固定觸發句(樣本外驗證 en 約 490 字)要整句才比對得到摘要,截斷改到 renderer 摘要之後(csRow);仍留上限
      .map((r) => ({ id: r.id, last: r.last, title: String(r.title || "").slice(0, 4000) }));
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
    try { fs.rmSync(path.join(RES_DIR, id), { recursive: true, force: true }); } catch (_) { /* 結果卡同上 */ }
    try { fs.rmSync(path.join(BASE, "state", "browser-snapshots", id), { recursive: true, force: true }); } catch (_) { /* 瀏覽器快照同上 */ }
    try { fs.rmSync(path.join(XP_DIR, id), { recursive: true, force: true }); } catch (_) { /* 轉出卡的快照同上 */ }
    return true;
  } catch (_) { return false; } finally { db.close(); }
}

/* ── 聊天結果卡(renderer/results.js;spec-desktop-result-card-0.1.8 §7)──────────────
   session.db 只存文字,同聊天圖 / 轉出卡:state/chat-results/<session>/index.jsonl,一列 = 一輪 { ts: 回合結束, items }。
   雲端報告晚到 = 同一個 ts 再 append 一列,讀的時候併回那一輪。存的是原始值(數字、時間戳、key),字由 renderer 現組。
   畫面會把這些字畫出來(標題是 agent 寫的):這裡只擋形狀與長度,畫面一律 textContent */
const RES_DIR = path.join(BASE, "state", "chat-results");
const RES_KINDS = ["report", "strategy"], RES_ENVS = ["local", "cloud"], RES_SUBS = ["report", "new", "backtest", "scan", "code", "cloud"];
const RES_MAX_ITEMS = 20, RES_MAX_LINES = 2000, RES_FILE_MAX = 2 * 1024 * 1024;
const resStr = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
function resItemOk(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  if (!RES_KINDS.includes(x.kind) || !RES_ENVS.includes(x.env) || !RES_SUBS.includes(x.sub) || !resStr(x.ref, 200) || !resStr(x.title, 200)) return null;
  const ver = typeof x.ver === "number" && isFinite(x.ver) ? x.ver : resStr(x.ver, 200) ? x.ver : null;
  const facts = {};
  if (x.facts && typeof x.facts === "object" && !Array.isArray(x.facts)) {
    for (const [k, v] of Object.entries(x.facts).slice(0, 16)) {
      if (!/^[a-z_]{1,24}$/.test(k)) continue;
      if (v === null || typeof v === "boolean" || (typeof v === "number" && isFinite(v)) || (typeof v === "string" && v.length <= 64)) facts[k] = v;
    }
  }
  return { kind: x.kind, env: x.env, ref: x.ref, ver, sub: x.sub, title: x.title, facts, at: typeof x.at === "number" && isFinite(x.at) ? x.at : 0 };
}
function saveTurnResults(id, entry) {
  if (!okSessionId(id) || !entry || !(Number(entry.ts) > 0) || !Array.isArray(entry.items)) return false;
  const items = entry.items.slice(0, RES_MAX_ITEMS).map(resItemOk).filter(Boolean);
  if (!items.length) return false;
  const dir = path.join(RES_DIR, id), file = path.join(dir, "index.jsonl");
  try {
    let size = 0; try { size = fs.statSync(file).size; } catch (_) { /* 還沒有 */ }
    if (size > RES_FILE_MAX) return false;   // 撐爆的對話不再記:卡這一輪照畫,只是重開不回來
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: Number(entry.ts), items }) + "\n", { mode: 0o600 });
    return true;
  } catch (_) { return false; }
}
// 舊對話的結果卡:[{ ts, items }],同一個 ts 的列併成一輪(照寫入順序)
function loadTurnResults(id) {
  if (!okSessionId(id)) return [];
  let lines = [];
  try { lines = fs.readFileSync(path.join(RES_DIR, id, "index.jsonl"), "utf8").split("\n").filter(Boolean).slice(-RES_MAX_LINES); } catch (_) { return []; }
  const by = new Map();
  for (const l of lines) {
    try {
      const r = JSON.parse(l), ts = Number(r.ts);
      if (!(ts > 0) || !Array.isArray(r.items)) continue;
      const items = r.items.slice(0, RES_MAX_ITEMS).map(resItemOk).filter(Boolean);
      if (!by.has(ts)) by.set(ts, []);
      by.get(ts).push(...items);
    } catch (_) { /* 壞掉的一列跳過 */ }
  }
  return [...by].map(([ts, items]) => ({ ts, items }));
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

/* ── 聊天裡的轉出卡(runtime 的 export chunk)──────────────────────
   web 把 export 跟那則訊息一起存(history 的 exports[]),重開照畫;session.db 是 runtime 的、只存文字,所以同聊天圖:
   state/chat-exports/<session>/ 放那一輪轉出時的快照 + index.jsonl。index 在回合結束才寫、ts = 結束時間:
   排在那一輪回覆(runtime 在結束前寫進逐字稿)之後,renderer 照時間把卡掛回那則回覆下面。
   recentExports = 這次開 app 以來每支策略每個平台最新那一份:給主行程其他地方讀(之後內建瀏覽器「裝進 TradingView」要檔案路徑)。
   路徑一律由策略名 + 固定檔名重建,不信 chunk 給的字。 */
const XP_DIR = path.join(BASE, "state", "chat-exports");
const XP_ID_RE = /^[0-9]{13}-[0-9]{1,6}$/;
const recentExports = new Map();   // `${strategy}:${target}` → { id, sessionId, strategy, target, filename, size, src(workspace 檔), snap(快照) }
let xpSeq = 0;
function noteExport(c, sid) {
  if (!c || !EXPORT_FILES[c.target] || typeof c.strategy !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(c.strategy) || typeof c.content !== "string" || !okSessionId(sid)) return null;
  const size = Buffer.byteLength(c.content, "utf8"); if (!size || size > EXPORT_MAX) return null;
  const ext = EXPORT_FILES[c.target].split(".").pop(), id = `${Date.now()}-${++xpSeq}`, dir = path.join(XP_DIR, sid);
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${id}.${ext}`), c.content, { encoding: "utf8", mode: 0o600 }); } catch (_) { return null; }
  const rec = { id, sessionId: sid, strategy: c.strategy, target: c.target, filename: `${c.strategy}_${c.target}.${ext}`, size,
    src: path.join(STRAT_DIR(), c.strategy, "exports", EXPORT_FILES[c.target]), snap: path.join(dir, `${id}.${ext}`) };
  recentExports.set(c.strategy + ":" + c.target, rec);
  return rec;
}
function flushExports(sid, recs) {
  if (!recs.length || !okSessionId(sid)) return;
  const ts = Date.now() / 1000;
  try { fs.appendFileSync(path.join(XP_DIR, sid, "index.jsonl"), recs.map((r) => JSON.stringify({ ts, id: r.id, target: r.target, strategy: r.strategy, size: r.size }) + "\n").join("")); } catch (_) { /* 寫不進去:這一輪的卡重開不會回來,檔案仍在策略資料夾 */ }
}
function sessionExports(sid) {
  if (!okSessionId(sid)) return [];
  let lines = [];
  try { lines = fs.readFileSync(path.join(XP_DIR, sid, "index.jsonl"), "utf8").split("\n").filter(Boolean); } catch (_) { return []; }
  const out = [];
  for (const l of lines) {
    try {
      const r = JSON.parse(l);
      if (!XP_ID_RE.test(r.id) || !EXPORT_FILES[r.target] || !/^[A-Za-z0-9_-]{1,64}$/.test(r.strategy) || !(Number(r.ts) > 0)) continue;
      const ext = EXPORT_FILES[r.target].split(".").pop();
      out.push({ ts: Number(r.ts), id: r.id, target: r.target, strategy: r.strategy, filename: `${r.strategy}_${r.target}.${ext}`,
        size: Number(r.size) || 0, snap: path.join(XP_DIR, sid, `${r.id}.${ext}`), src: path.join(STRAT_DIR(), r.strategy, "exports", EXPORT_FILES[r.target]) });
    } catch (_) { /* 壞掉的一列跳過 */ }
  }
  return out;
}
// 舊對話的轉出卡:[{ts, id, target, strategy, filename, size}](路徑不交給畫面)
function loadSessionExports(sid) { return sessionExports(sid).map(({ ts, id, target, strategy, filename, size }) => ({ ts, id, target, strategy, filename, size })); }
function exportById(sid, id) { return typeof id === "string" && XP_ID_RE.test(id) ? sessionExports(sid).find((r) => r.id === id) || null : null; }
// 主行程其他地方讀這一份:這支策略這個平台最近一次轉出(這次開 app 以來);沒有就回 null
function exportRef(strategy, target) { return recentExports.get(strategy + ":" + target) || null; }
/* 「送進 TradingView」要貼的那一份(renderer 只給 ref,檔案與商品週期由這裡讀):
   ref = { session, id } → 對話那張卡當時的快照;ref = { strategy } → workspace 裡現在那一份(程式碼分頁看到的)。
   SYMBOL / INTERVAL 讀 strategy.py 的頂層常數,只拿去組圖表網址 */
function pineJob(ref) {
  let name, f, filename;
  if (ref && typeof ref.id === "string") {
    const r = exportById(ref.session, ref.id); if (!r || r.target !== "pine") return null;
    name = r.strategy; f = readSnap(r.snap); filename = r.filename;
  } else {
    name = String((ref && ref.strategy) || ""); if (!stratNames().includes(name)) return null;
    const rec = exportRef(name, "pine");
    f = readExportFile(path.join(STRAT_DIR(), name), "pine"); filename = rec ? rec.filename : `${name}_pine.pine`;
  }
  if (!f) return null;
  const dir = path.join(STRAT_DIR(), name);
  let code = ""; try { code = fs.readFileSync(path.join(dir, "strategy.py"), "utf8"); } catch (_) { /* 策略刪了:不帶商品 */ }
  const meta = stratMeta(code);
  return { content: f.content, strategy: name, filename, symbol: meta.symbol, interval: meta.interval, cryptoKline: stratUsesKline(dir) };
}
function readSnap(p) {
  try { const st = fs.lstatSync(p); if (!st.isFile() || st.size > EXPORT_MAX) return null; return { p, content: fs.readFileSync(p, "utf8"), mtime: st.mtimeMs }; } catch (_) { return null; }
}

/* ── 報告(renderer/reports.js;spec-desktop-0.1.6 §1.1)────────────────────────────
   本機視角的「袋」就是檔案系統:agent 照 references/reports.md 把報告寫進 <WS>/reports/<id>.json、圖放 <id>.files/。
   電腦版的 local_daemon 沒有起 report_uploader,所以報告永遠留在 drop dir、image block 永遠是 file 不是 sha256;
   reports/sent/ 今天是空的,但 uploader 哪天上桌面也不用改。renderer 不碰 fs:這裡讀好信封 / 本體 / 圖(data URI)才交過去。
   檔名 regex、2 MB 上限、mime 白名單都在這一層;block 內容不驗(那是 api 的事,渲染器對不認得的 block 本來就跳過)。 */
const RPT_DIR = () => path.join(WS, "reports");
const RPT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/, RPT_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const RPT_BYTES_MAX = 2 * 1024 * 1024, RPT_MAX = 200, RPT_IMAGES_MAX = 20, RPT_TITLE_MAX = 200, RPT_TYPE_MAX = 32, RPT_LABEL_MAX = 40;   // label 上限同 api 驗證器給 meta.report_type 的 40
const RPT_TS_MIN = 946684800, RPT_TS_MAX = 4102444800;   // created_at 只認 2000–2100 年的 unix 秒:agent 寫的 1e13 會讓 renderer 畫出 NaN
const RPT_IMAGES_BUDGET_MS = 60 * 1000, RPT_CLOUD_DOCS_MAX = 8;   // 雲端一份報告的圖加總最多等 60 秒(postJSON 單張 20 秒逾時 × 20 張太久);本體快取留 8 份(每份含 base64 圖)
const RPT_EXT_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
// 一份報告的信封(清單只讀這幾欄):id 缺就用檔名、有且不同 → 略過(同 uploader 的立場);標題 1–200 字,缺 → 略過;created_at 不是合理範圍的整數 → 檔案 mtime。
// mtime(ms)一併交出:報告不覆寫(lib/report.py:id 已有報告就寫成 <id>-2),同一個檔只會被同一輪的 replace=True 或手寫檔案換掉——renderer 靠 mtime 認出「這份換過了」,本體快取與「有沒有新報告」都比它
// label = 閱讀頁類型標籤畫的那個字(meta.report_type,agent 寫的顯示字,如「單標的晨報」):結果卡要跟它同一個字;沒有 → null
function rptEnvelope(fileId, doc, mtimeMs) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  if (doc.id !== undefined && doc.id !== fileId) return null;
  const title = typeof doc.title === "string" ? doc.title.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, RPT_TITLE_MAX) : "";
  if (!title) return null;
  const created = Number.isInteger(doc.created_at) && doc.created_at >= RPT_TS_MIN && doc.created_at <= RPT_TS_MAX ? doc.created_at : Math.floor(mtimeMs / 1000);
  const meta = Array.isArray(doc.blocks) && doc.blocks[0] && typeof doc.blocks[0] === "object" && doc.blocks[0].type === "meta" ? doc.blocks[0] : null;
  const label = meta && typeof meta.report_type === "string" ? meta.report_type.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, RPT_LABEL_MAX) : "";
  return { id: fileId, title, type: typeof doc.type === "string" ? doc.type.slice(0, RPT_TYPE_MAX) : null, label: label || null, created_at: created, mtime: Math.floor(mtimeMs) };
}
// 讀一份 <dir>/<id>.json:不是普通檔(symlink 也不收:分享會把讀到的東西公開出去)/ 超過 2 MB / JSON 壞 → null
function rptReadDoc(dir, id) {
  const f = path.join(dir, id + ".json");
  let st = null;
  try { st = fs.lstatSync(f); } catch (_) { return null; }
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
// 本機一張圖 → { mime, b64 }:file 只能是檔名(不含路徑)、副檔名決定 mime、≤ 2 MB;任一條不合就當沒有這張(渲染器畫失敗框)
function rptImageB64(dir, id, file) {
  if (typeof file !== "string" || !RPT_FILE_RE.test(file)) return null;
  const mime = RPT_EXT_MIME[file.slice(file.lastIndexOf(".") + 1).toLowerCase()];
  if (!mime || file.indexOf(".") < 0) return null;
  try {
    // lstat:圖檔或 <id>.files 是 symlink 就當沒有這張——跟過去讀,分享時會把 workspace 外的檔公開出去(稽核 P2-5)
    const d = path.join(dir, id + ".files"), f = path.join(d, file), st = fs.lstatSync(f);
    if (!fs.lstatSync(d).isDirectory() || !st.isFile() || st.size === 0 || st.size > RPT_BYTES_MAX) return null;
    return { mime, b64: fs.readFileSync(f).toString("base64") };
  } catch (_) { return null; }
}
function rptImageUri(dir, id, file) { const im = rptImageB64(dir, id, file); return im ? `data:${im.mime};base64,${im.b64}` : null; }
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
/* 分享本機報告(reportshare.js 的 readLocal):本體原樣 + image block 引用的 sidecar 圖 { 檔名: base64 }。
   跟 reportLoad 同一套檔名 / 大小規則;缺的圖不補——api 會回 400 指名哪張,比默默少一張圖上公開頁誠實 */
function reportForShare(id) {
  if (typeof id !== "string" || !RPT_ID_RE.test(id)) return null;
  for (const dir of rptDirs()) {
    const r = rptReadDoc(dir, id);
    if (!r || !rptEnvelope(id, r.doc, r.mtimeMs)) continue;
    const images = {};
    let n = 0;
    for (const b of Array.isArray(r.doc.blocks) ? r.doc.blocks : []) {
      if (!b || typeof b !== "object" || b.type !== "image" || typeof b.file !== "string" || images[b.file] !== undefined) continue;
      if (++n > RPT_IMAGES_MAX) break;
      const im = rptImageB64(dir, id, b.file);
      if (im) images[b.file] = im.b64;
    }
    return { report: r.doc, images, mtime: Math.floor(r.mtimeMs) };
  }
  return null;
}
// 同 runtime/report_uploader.py log_error 的格式與上限:agent 用 lib.report.status(id) 讀得到同一行
const RPT_ERRLOG_MAX = 64 * 1024, RPT_ERRLOG_KEEP = 200;
function rptLogError(id, message) {
  const f = path.join(RPT_DIR(), "upload_errors.log");
  fs.mkdirSync(RPT_DIR(), { recursive: true });
  fs.appendFileSync(f, new Date().toISOString().replace(/\.\d+Z$/, "Z") + " " + id + ": " + String(message).replace(/\s+/g, " ") + "\n");
  if (fs.statSync(f).size > RPT_ERRLOG_MAX) fs.writeFileSync(f, fs.readFileSync(f, "utf8").split("\n").filter(Boolean).slice(-RPT_ERRLOG_KEEP).join("\n") + "\n");
}
const SHARE_UPLOAD_TIMEOUT_MS = 90 * 1000;   // 本機報告最多 20 張圖:api 逐張存完才回
let _share = null;
function shareClient() {
  const RS = require("./reportshare");
  if (!_share) _share = RS.createShareClient({
    apiBase: API_BASE, post: (u, b) => postJSON(u, b, /\/share\/(publish|update)$/.test(u) ? { timeout: SHARE_UPLOAD_TIMEOUT_MS } : undefined), readLocal: reportForShare,
    logError: rptLogError, log: (m) => console.error("[share] " + m), store: RS.createShareStore(path.join(BASE, "state", "report-shares.json")),
    getCreds: () => { const token = loadToken(); return token ? { token, appSecret: loadAppSecret() } : null; },
  });
  return _share;
}
/* 設定 › 公開連結(renderer/report-sharelist.js):api 的清單 + 「desktop 袋那一份在不在這台電腦」(api 不知道,這裡看檔)。 */
const rptLocalHas = (id) => typeof id === "string" && RPT_ID_RE.test(id) && rptDirs().some((dir) => { const r = rptReadDoc(dir, id); return !!(r && rptEnvelope(id, r.doc, r.mtimeMs)); });
async function shareList() {
  const r = await shareClient().list();
  if (r.code !== "OK") return r;
  return { code: "OK", limits: r.limits, shares: r.shares.map((x) => ({ ...x, local: x.origin === "desktop" && rptLocalHas(x.reportId) })) };
}
/* 報告存成 PDF(reportpdf.js;spec-report-pdf-0.1.8):看不見的視窗載 renderer/report-print.html、printToPDF、寫到用戶在存檔框選的位置。
   報告本體由主行程自己讀(renderer 只給 view / id / 語言);上次存的資料夾記在 userData 的 ui-prefs.json(只記這一條路徑)。 */
const uiPrefsPath = () => path.join(app.getPath("userData"), "ui-prefs.json");
function pdfDirGet() {
  try {
    const d = JSON.parse(fs.readFileSync(uiPrefsPath(), "utf8")).pdfDir;
    return typeof d === "string" && path.isAbsolute(d) && fs.statSync(d).isDirectory() ? d : null;
  } catch (_) { return null; }   // 沒存過 / 資料夾不在了:回「下載項目」
}
function uiPrefsPatch(patch) {
  let o = {}; try { const x = JSON.parse(fs.readFileSync(uiPrefsPath(), "utf8")); if (x && typeof x === "object" && !Array.isArray(x)) o = x; } catch (_) { /* 第一次 */ }
  // 先寫暫存檔再 rename:寫到一半當機會留下半個檔,下次讀不到就整份當空的覆寫(存過的 PDF 資料夾跟著不見)
  const tmp = uiPrefsPath() + ".blave-tmp";
  try { fs.writeFileSync(tmp, JSON.stringify({ ...o, ...patch })); fs.renameSync(tmp, uiPrefsPath()); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
}
function pdfDirSet(dir) { uiPrefsPatch({ pdfDir: dir }); }
// 雲端那一份:閱讀頁剛讀過的就在 rptCloudDocs 裡——同一個 stored_at 的本體不會變,過了 5 分鐘也照用(存檔框要馬上開);不在才重抓
async function pdfLoadDoc(view, id, ver) {
  if (view === "local") return reportLoad(id);
  const token = loadToken(), hit = rptCloudDocs.get(id + "|" + (Number.isInteger(ver) ? ver : ""));
  if (token && hit && hit.owner === token && hit.r.report) return hit.r;
  const r = await cloudReport(id, ver);
  return r.code === "OK" && r.report ? r : null;
}
function pdfOpenPage() {
  const w = new BrowserWindow({
    show: false, width: 794, height: 1123,
    webPreferences: { preload: path.join(__dirname, "print-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  w.loadFile(path.join(__dirname, "renderer", "report-print.html"));
  return w;
}
let _pdf = null;
function reportPdf() {
  if (!_pdf) _pdf = require("./reportpdf").createReportPdf({
    loadDoc: pdfLoadDoc, openPage: pdfOpenPage, getDir: pdfDirGet, setDir: pdfDirSet,
    showSave: (win, o) => dialog.showSaveDialog(win, o),
    writeFile: (p, buf) => fs.promises.writeFile(p, buf),
    downloads: () => app.getPath("downloads"),
    onSaved: () => tm().track("feature_used", { name: "report_pdf" }),   // 檔案寫成功才送(取消、失敗不送)
    savedRef,
  });
  return _pdf;
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

// Claude Code 沒有本機型錄可讀,清單我們自己維護。fable / opus / sonnet 送明確 id 而不是別名:
// 別名由 CLI 自己解析,CLI 2.1.281 的 `sonnet` 是 claude-sonnet-5 不是 5.5(29026 實測),選單寫的會跟實際跑的不一樣。
// haiku 的 efforts 是空的:實測(把 CLI 指到 mock upstream 看它送什麼)CLI 對 haiku
// 完全不送 output_config,`--effort` 不報錯但沒有任何作用——放一個按了沒反應的控件
// 比藏掉它更糟。
// 順序 = 模型強度,最強的在上面(三個引擎同一個規則)。預設不是第一個:預設跟著
// `defaultModel` 走(Sonnet——每個方案都有、速度與能力的平衡點),「預設」徽章也是。
const CLAUDE_MODELS = [
  { id: "claude-fable-5-1", name: "Fable", efforts: CLAUDE_EFFORTS, defaultEffort: "high" },
  { id: "claude-opus-5-5", name: "Opus", efforts: CLAUDE_EFFORTS, defaultEffort: "high" },
  { id: "claude-sonnet-5-5", name: "Sonnet", efforts: CLAUDE_EFFORTS, defaultEffort: "high" },
  { id: "haiku", name: "Haiku", efforts: [], defaultEffort: null },
];
const CLAUDE_DEFAULT = "claude-sonnet-5-5";
// 偏好檔裡存的舊別名對到明確 id(effort 跟著帶,renderer mpInit 讀 successors)
const CLAUDE_SUCCESSORS = { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5", fable: "claude-fable-5-1" };

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
  "anthropic/claude-haiku-4-5-20251001": "Haiku 4.5", "anthropic/claude-sonnet-5-5": "Sonnet 5.5",
  "anthropic/claude-opus-5-5": "Opus 5.5", "anthropic/claude-fable-5-1": "Fable 5.1",
  "anthropic/claude-opus-4-8": "Opus 4.8", "anthropic/claude-fable-5": "Fable 5",
  "deepseek/deepseek-v4-flash": "DeepSeek V4 Flash", "deepseek/deepseek-v4-pro": "DeepSeek V4 Pro",
};
// proxy 把舊世代留在 /v1/models(帶 legacy: true)只為了舊版 app 不斷線;這版不列,存著舊 id 的人
// 對到同家族的新型號,而不是退回預設(renderer mpInit 讀 successors)。
const BLAVE_SUCCESSORS = {
  "anthropic/claude-sonnet-5": "anthropic/claude-sonnet-5-5",
  "anthropic/claude-opus-4-8": "anthropic/claude-opus-5-5",
  "anthropic/claude-fable-5": "anthropic/claude-fable-5-1",
};
const BLAVE_STRENGTH = [/fable/, /opus/, /sonnet/, /haiku/, /deepseek.*pro/, /deepseek.*flash/];
/* 帳號能不能用 Blave AI(綁卡流程用)。回 api 的 account_status 原樣,或 null(沒 token / 打不到 /
   舊 api)。null 時 renderer 不猜——沿用「沒額度 → 儲值」那組舊文案。 */
let btSeen = false;
async function accountStatus() {
  const acct = loadToken();
  if (!acct) return null;
  try {
    // 順帶帶上 app 的現況(使用事件開關、連的是哪個 AI;見 telemetry.js statusHeaders)——提醒信靠它尊重「關掉」
    const conn = loadConnection(), on = tm().isEnabled(), T = require("./telemetry");
    if (on && !btSeen) btSeen = T.anyBacktest(STRAT_DIR());   // 回測過就不會變回沒有:找到一次之後不再掃
    const state = T.statusHeaders(on, conn && conn.kind, btSeen);
    const r = await getJSON(`${API_BASE}/openclaw/proxy/v1/account_status`, { "x-api-key": `proxy-${acct}`, ...state });
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
/* 台指期報價:雲端視角金額表的口數列換參考金額用(口 × 點值 × 指數;同網頁 loadTxfQuote)。跟網頁同一支、同一個 symbol——
   txf_summary 是匿名可讀(token_optional + IP 限流),小台／微台跟大台同一個指數。成功的值留 5 分鐘;
   問不到時照網頁回上一份(沒有就 null,畫面退回「—」),失敗後 60 秒內不再問,不拿輪詢去敲 api */
const TXF_QUOTE_MS = 300000, TXF_RETRY_MS = 60000;
let txfCache = null, txfFailAt = 0, txfInflight = null;
function txfQuote() {
  const now = Date.now();
  if (txfCache && now - txfCache.at < TXF_QUOTE_MS) return Promise.resolve(txfCache.price);
  if (now - txfFailAt < TXF_RETRY_MS) return Promise.resolve(txfCache ? txfCache.price : null);
  if (txfInflight) return txfInflight;
  txfInflight = getJSON(`${API_BASE}/studio/charts/twfutures/txf_summary?symbol=TXF`, {}).then((r) => {
    const p = r && r.status === 200 && r.body ? Number(r.body.price) : NaN;
    if (!(isFinite(p) && p > 0)) throw new Error("bad quote");
    txfCache = { at: Date.now(), price: p };
    return p;
  }).catch(() => { txfFailAt = Date.now(); return txfCache ? txfCache.price : null; }).finally(() => { txfInflight = null; });
  return txfInflight;
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
      direction: str(s.direction, LIB_STR_MAX), max_exposure: fin(s.max_exposure), report,
      success_note_ids: libNoteLangs(s.success_note_ids, (v) => (Number.isInteger(v) && v > 0 ? v : null)),
      success_note_titles: libNoteLangs(s.success_note_titles, (v) => { const x = (str(v, LIB_TITLE_MAX) || "").trim(); return x || null; }) });
  }
  return out;
}
// 成功筆記兩欄(spec-0.1.12-library-notes §2.2):只收 zh / en,值過 pick;一個都不剩 → null(舊 api 沒有 titles 那欄也是 null)
function libNoteLangs(v, pick) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = {};
  for (const k of ["zh", "en"]) { const x = pick(v[k]); if (x !== null) out[k] = x; }
  return Object.keys(out).length ? out : null;
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
/* 策略詳情的成功筆記(spec-0.1.12-library-notes §2.2):GET /studio/success_notes/read_note?note_id=——每打一次 api 就記一筆閱讀,
   所以匿名打(不帶桌面資料 key、主行程的 https 本來就沒有 cookie)、成功快取 30 分鐘、失敗不記。匿名回 201、帶 cookie 回 200,兩個都算。
   付費筆記回 success:false + 空 content:當讀不到。回給畫面只留四欄;內文是外部 HTML,畫面那一側再過白名單重建(libNoteBuild)。 */
const LIB_NOTE_HTML_MAX = 50000, LIB_NOTE_TTL_MS = 30 * 60 * 1000;
function libNoteSanitize(body, id) {
  const n = body && typeof body === "object" && body.success === true && body.note && typeof body.note === "object" ? body.note : null;
  if (!n || typeof n.content !== "string" || !n.content.trim()) return null;
  const t = Date.parse(typeof n.created_at === "string" ? n.created_at : "");
  return { id, title: typeof n.title === "string" ? n.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, LIB_TITLE_MAX) : "",
    html: n.content.slice(0, LIB_NOTE_HTML_MAX), date: isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null };   // api 的 GMT 是資料庫的裸時間:取 UTC 年月日,不轉本地時區
}
const libNoteCache = new Map();   // id → { at, note }
async function libraryNote(id) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const hit = libNoteCache.get(id);
  if (hit && Date.now() - hit.at < LIB_NOTE_TTL_MS) return hit.note;
  let r = null;
  try { r = await getJSON(`${API_BASE}/studio/success_notes/read_note?note_id=${id}`, {}); } catch (_) { return null; }
  if (r.status !== 200 && r.status !== 201) return null;
  const note = libNoteSanitize(r.body, id);
  if (!note) return null;
  libNoteCache.set(id, { at: Date.now(), note });
  return note;
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
    return (r.body.data || []).filter((m) => !m.legacy).map((m) => {
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
    return { models, defaultModel: d ? d.id : null, successors: BLAVE_SUCCESSORS };
  }
  return { models: CLAUDE_MODELS, defaultModel: CLAUDE_DEFAULT, successors: CLAUDE_SUCCESSORS };
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
/* 停止鈕:每一輪一個旗標檔(runtime/turn_stop.py 的 BLAVE_TURN_INTERRUPT_FILE)。建檔 = 要停;runtime 輪詢到就殺掉這一輪
   的工具與引擎、照「已停止」收尾。只動這一輪的子行程樹——常駐程式、策略、對帳器不是它的子行程。路徑在送出當下就定好,
   spawn 之前按停止也寫得進去(runtime 一起來就看到)。runtime 卡死時的保險:agent_turn 沉默滿 STOP_KILL_MS 才殺它。
   不看按下後過了多久——runtime 在等平倉腳本跑完(Codex 的工具寫進引擎的管線,引擎不能先死)時每秒送 ping;
   收到 done 就不殺(之後是寫歷史與壓縮摘要,砍了只會丟那一段)。 */
let turnStopFile = null, turnFinalized = false, turnLastOut = 0;
const STOP_KILL_MS = 5000;
function newTurnStop() {
  if (turnStopFile) { try { fs.rmSync(turnStopFile, { force: true }); } catch (_) { /* 換新檔名,留著也無害 */ } }
  turnStopFile = path.join(BASE, "state", "turn_stop", crypto.randomBytes(8).toString("hex"));
  turnFinalized = false;
}
function stopTurn() {
  if (!(activeTurn || turnStarting) || !turnStopFile) return false;
  try { fs.mkdirSync(path.dirname(turnStopFile), { recursive: true }); fs.writeFileSync(turnStopFile, ""); } catch (_) { return false; }
  const file = turnStopFile;
  let seen = activeTurn;
  const arm = () => setTimeout(() => {
    if (turnStopFile !== file || turnFinalized) return;   // 已經換下一輪 / runtime 已經收尾
    if (activeTurn && activeTurn === seen && Date.now() - turnLastOut >= STOP_KILL_MS) { try { activeTurn.kill(); } catch (_) { /* 已經不在了 */ } return; }
    seen = activeTurn;
    if (seen || turnStarting) arm();   // 剛起來或還沒起來:再給它一段
  }, STOP_KILL_MS);
  arm();
  return true;
}
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
/* 設定 › Agent 規則:這台電腦的常駐規則與回覆語言(agentrules.js)。讀是 runtime 的 python、寫是 daemon 的指令。 */
let _agentRules = null;
const RULES_CMDS = new Set(["preferences_set", "reply_lang_set"]);
function agentRules() {
  if (!_agentRules) {
    const AR = require("./agentrules");
    _agentRules = AR.createAgentRules({
      readLocal: () => (fs.existsSync(WS)
        ? AR.readLocal({ python: fs.existsSync(VENV_PY) ? VENV_PY : basePython(), runtimeDir: path.join(REPO, "runtime"), workspace: WS,
          env: childEnv({ PATH: process.env.PATH || "/usr/bin:/bin", HOME: os.homedir(), LANG: process.env.LANG || "en_US.UTF-8" }) })
        : Promise.resolve({ rules: null, replyLang: { lang: "", custom: "" }, langReadable: false })),
      // 只送得出這兩個設定指令:這裡不是會啟動下單的入口(tests/check_shell_minversion.js 釘住)
      writeLocal: (cmd, args) => (RULES_CMDS.has(cmd) ? tradeHost().send(cmd, args, { trusted: true }) : Promise.resolve({ ok: false, error: "NOT_ALLOWED" })),
      argsOk: require("./daemon").argsOk,
    });
  }
  return _agentRules;
}
function tradeStartIfReady() {
  try {
    if (fs.existsSync(VENV_PY) && fs.existsSync(WS)) { tradeHost().start(); binanceLink().start(); return; }
    // .app 換了位置(移到「應用程式」、改名、從 DMG 拖出來)之後 venv 的 python 是斷掉的連結:以前要等用戶送第一句話(ensure-engine)才修,
    // 這段期間 daemon 不在、交易頁講不出狀態。開機就修一次、修好再起(稽核 0.1.10 P2-4);只試一次,修不好留給送訊息那條路
    if (!venvRepairTried && fs.existsSync(WS) && venvLinkBroken()) {
      venvRepairTried = true;
      ensureEngineShared().then(() => { if (fs.existsSync(VENV_PY)) tradeStartIfReady(); }, (e) => console.error("[trade] venv repair failed", e && e.message));
    }
  } catch (e) { console.error("[trade] start failed", e && e.message); }
}
let venvRepairTried = false;
function venvLinkBroken() {
  if (WIN) return false;   // Windows 的 venv 沒有連結(Scripts\python.exe 是 launcher)
  try { return fs.lstatSync(VENV_PY).isSymbolicLink() && !fs.existsSync(VENV_PY); } catch (_) { return false; }
}
/* 同一時間只跑一份 ensureEngine:開 app 的背景安裝、開機修 venv、送第一句話的 ensure-engine 可能撞在一起(兩支 `-m venv` / pip 搶同一個資料夾)。
   後到的共用先到的那一份;進度不經這裡,是 enginesetup 的快照推給畫面 */
let _engineRun = null;
function ensureEngineShared() {
  if (!_engineRun) _engineRun = ensureEngine().finally(() => { _engineRun = null; });
  return _engineRun;
}
/* 開 app 就在背景裝(0.1.12 的 C):不等用戶選好 AI、送出第一句話。裝引擎不需要登入、不需要選定哪一種 AI——
   三種都跑同一個 venv。失敗只留 log:卡上有重試,送第一句話時也會再試一次 */
function engineKick() {
  ensureEngineShared().then(() => tradeStartIfReady(), (e) => console.error("[engine] background setup failed: " + ((e && e.message) || e)));
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
/* 內建瀏覽器(shell/browser/;spec .claude/output/specs/desktop-browser-agent-tools-2026-09-26.md)。
   agent 經本機 MCP(`blave_browser`,127.0.0.1、每回合一顆 token)操作;分頁是獨立 partition 的 WebContentsView,renderer 只收事件。
   掛不掛:電腦版本機 + 設定開著(預設開),**不看登入**;token 跟 `blave` 那顆一樣只經單次設定檔 / Codex 子行程環境交給 CLI。 */
let _browser = null;
// 開發版專用的假驗證頁(BLAVE_DEV_FAKE_VERIFY=1,實機走「搜尋驗證交給用戶」用;browser/devverify.js)。打包版沒有這支
const fakeVerify = app.isPackaged ? null : require("./browser/devverify").create({ env: process.env, isPackaged: app.isPackaged });
const BROWSER_PREFS = () => path.join(app.getPath("userData"), "browser.json");
function browser() {
  if (!_browser) _browser = require("./browser").createBrowser({
    electron: require("electron"), stateDir: path.join(BASE, "state", "browser-snapshots"), pineLog: path.join(BASE, "state", "pine-install.log"), reportsDir: RPT_DIR(), version: app.getVersion(),
    getWin: () => imgWin || BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && isOurPageUrl(w.webContents.getURL())) || null,
    uiLang: () => (/^zh/i.test(app.getLocale()) ? "zh" : "en"),
    track: (name) => tm().track("feature_used", { name }),
    reducedMotion: () => { try { return !!require("electron").systemPreferences.getAnimationSettings().prefersReducedMotion; } catch (_) { return false; } },
    loadPrefs: () => { try { return JSON.parse(fs.readFileSync(BROWSER_PREFS(), "utf8")); } catch (_) { return null; } },
    savePrefs: (p) => { try { fs.writeFileSync(BROWSER_PREFS(), JSON.stringify({ enabled: !!p.enabled }), { mode: 0o600 }); } catch (_) { /* 存不了就只在這次生效 */ } },
    notify: browserNotify,
    engines: fakeVerify ? fakeVerify.engines : undefined,
  });
  if (fakeVerify) fakeVerify.serve(require("electron").session.fromPartition(require("./browser").PARTITION)).catch(() => {});
  return _browser;
}
/* 內建瀏覽器要用戶回來操作(目前只有一種:搜尋被要求機器人驗證)。app 在前景時畫面自己會講,不發;字還沒交過來也不發
   (不拿英文退路塞給中文用戶)。點了把視窗叫到前面 */
function browserNotify(kind) {
  if (kind !== "captcha" || BrowserWindow.getFocusedWindow() || !tmLabels.br_captcha || !Notification.isSupported()) return false;
  const n = new Notification({ title: TT.notifTitle(tmLabels.notifPrefixLocal, tmLabels.br_captchaTitle || "Blave"), body: tmLabels.br_captcha });
  p1Alive.add(n); const drop = () => p1Alive.delete(n);
  n.on("click", () => { drop(); showMain(); }); n.on("close", drop); n.on("failed", drop); notifWatch(n, "browser " + kind);
  n.show();
  return true;
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
/* 外殼給這一輪的指示(renderer 只交代號,字在 runtime/agent_turn.py TURN_NOTES):跟用戶的訊息分開送,不進泡泡也不進對話存檔。
   只認這張表上的;renderer 會渲染 LLM 的文字,不能讓它把任意字串送成系統層級的規則 */
const TURN_NOTES = ["report_once", "report_recur"];
async function runTurn(win, { sessionId, message, model: rawModel, effort: rawEffort, viewing, note }) {
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
  // 內建瀏覽器:同一份單次設定檔多一個 `blave_browser`(兩個 server 可以只有其一)。runtime 靠 --mcp-servers 分別知道掛了哪幾個
  let brMount = null;
  // userSent = 這一輪是人在這台電腦上按出來的(自動交還的前提:人在、剛動手)。打字的、畫面代組的固定句(轉出、範例、新增報告、交接確認框)
  // 都算——它們都是這台電腦上的人按的;renderer 的 typed 旗標不傳過來,這裡不分。要帶 false 的是「沒有人在這台電腦按送出」的回合:
  // 排程回合、雲端主機那邊發起的回合、任何自動回合——現在沒有這種呼叫端(runTurn 只有 send-message 一個入口),
  // 加的時候就帶 false。雲端視角(viewing.env === "cloud")另外用 noUser 標:人在,但畫面上不是這台電腦的對話
  if (fakeVerify) fakeVerify.arm();   // 這一輪的第一次搜尋先去假頁
  try { brMount = await browser().beginTurn(win, sessionId, { userSent: true, noUser: !!viewing && viewing.env === "cloud" }); } catch (_) { brMount = null; }
  if (brMount) { require("./mcpcode").removeConfig(mcpFile); mcpFile = require("./mcpcode").writeConfig(mcpDir(), mcpMount, brMount); }
  const mcpServers = mcpFile ? [...(mcpMount ? ["blave"] : []), ...(brMount ? ["blave_browser"] : [])] : [];
  // 上網只有內建瀏覽器一條路(e2e 0.1.8 #125):runtime 看到這個變數就把引擎自己的 WebSearch / WebFetch 關掉,
  // 沒掛上時照 off(用戶在設定 › 隱私關的)/ unavailable(開著但這一輪起不來)給 agent 不同的說法
  let brWanted = true; try { brWanted = browser().enabled(); } catch (_) { /* 連物件都建不起來:當成起不來 */ }
  const brState = brMount && mcpFile ? "on" : brWanted ? "unavailable" : "off";
  const turnDone = () => { require("./mcpcode").removeConfig(mcpFile); if (_browser) _browser.endTurn(); };
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
    ...(useCodex && mcpFile && mcpMount ? { BLAVE_MCP_TOKEN: mcpMount.accessCode, BLAVE_MCP_URL: mcpMount.url } : {}),
    ...(useCodex && mcpFile && brMount ? { BLAVE_BROWSER_TOKEN: brMount.token, BLAVE_BROWSER_URL: brMount.url } : {}),
    // Keychain/暫存都認人:少了 USER,claude CLI 會回「Not logged in」(實測 repro-2/3)
    USER: process.env.USER || os.userInfo().username,
    LOGNAME: process.env.LOGNAME || os.userInfo().username,
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    BLAVE_AGENT_BASE: BASE, BLAVE_AGENT_WORKSPACE: WS, BLAVE_AGENT_HOME: BASE,
    BLAVE_AGENT_STATE: path.join(BASE, "state"),
    BLAVE_AGENT_DB: path.join(BASE, "state", "session.db"),
    ...(turnStopFile ? { BLAVE_TURN_INTERRUPT_FILE: turnStopFile } : {}),
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
    BLAVE_BROWSER: brState,
    ...(TURN_NOTES.indexOf(note) >= 0 ? { BLAVE_TURN_NOTE: note } : {}),
    LANG: process.env.LANG || "zh_TW.UTF-8",
    ...PY_ENV,
  };
  let child;
  try { child = spawn(VENV_PY, [
    path.join(REPO, "runtime", "agent_turn.py"),
    "--delivery", "local",
    // 選擇器畫得出來時,model / effort **一律明確指定**:輸入框上寫的就是送出去的,
    // 不靠引擎那邊看不見的預設。只有型錄拿不到(沒畫選擇器)時兩個才是 null——
    // 那時 Claude / Blave AI 照舊送 Sonnet(proxy 也認裸 id),Codex 什麼都不帶(runtime 用「有沒有明確
    // 帶旗標」判斷,帶了 Claude 的名字過去會被轉成 `codex -m <那個名字>`)。
    ...(model ? ["--model", model] : useCodex ? [] : ["--model", CLAUDE_DEFAULT]),
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
    ...(mcpServers.length ? ["--mcp-servers=" + mcpServers.join(",")] : []),
    // 用戶打的字**不進 argv**(稽核 S5):同一台電腦上任何人 `ps` 都看得到命令列,而聊天貼 key 是支援的流程。走 stdin。
    // runtime 往下那一段本來就不走 argv(Claude 走 SDK 的 stream-json stdin、Codex 走 `exec -`)。
    "--message-stdin", "--", sessionId,
  ], { env: childEnv(env), cwd: WS, windowsHide: true }); } catch (err) { turnDone(); throw err; }
  child.on("error", () => turnDone());
  child.stdin.on("error", () => { /* 子行程一起來就死(EPIPE):close 事件會把失敗交給畫面 */ });
  try { child.stdin.end(message); } catch (err) { try { child.kill(); } catch (_) { /* 已經不在了 */ } turnDone(); throw err; }   // 不留一支卡在讀 stdin 的子行程
  activeTurn = child;
  let buf = "";
  const turnXp = [];   // 這一輪的轉出卡:回合結束才寫進 index(ts 要排在回覆之後)
  child.stdout.on("data", (d) => {
    turnLastOut = Date.now();
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.startsWith("@@BLAVE@@")) {
        try {
          const c = JSON.parse(line.slice(9)); if (c && c.type === "done") turnFinalized = true;
          if (c && c.type === "export") { const rec = noteExport(c, sessionId); if (rec) { c.id = rec.id; turnXp.push(rec); } }   // 卡重開要畫回來:快照先落地,id 給卡的「下載…」
          win.webContents.send("turn-event", c);
        } catch (_) {}
      }
    }
  });
  let errTail = "";
  child.stderr.on("data", (d) => { errTail = (errTail + d.toString()).slice(-2000); });
  child.on("close", (code) => {
    turnDone();   // 這一輪結束:設定檔(裡面是接入碼 / 瀏覽器 token)立刻刪,瀏覽器 token 作廢
    activeTurn = null;
    flushExports(sessionId, turnXp);
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
  quitOnSignals(process, () => app.quit());
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
  // 引擎裝好(或本來就在)之後才起本機常駐程式
  handle("ensure-engine", () => ensureEngineShared().then((r) => { tradeStartIfReady(); return r; }));
  handle("engine-state", () => engineSetup().snapshot());
  // app.getLocale() 是**系統**語系(macOS 偏好設定),不吃 LANG 環境變數。
  // BLAVE_LANG 是覆蓋用的:開發要看英文版、或用戶的系統是中文但想用英文介面。
  handle("get-locale", () => process.env.BLAVE_LANG || app.getLocale());
  handle("delete-strategy", (_e, name) => deleteStrategy(String(name || "")));
  handle("list-sessions", () => listSessions());
  handle("load-session-images", (_e, id) => loadSessionImages(id));
  handle("save-turn-results", (_e, id, entry) => saveTurnResults(id, entry), false);
  handle("load-turn-results", (_e, id) => loadTurnResults(id), []);
  handle("load-session", (_e, id) => loadSession(id));
  handle("delete-session", (_e, id) => deleteSession(id));
  handle("list-strategies", () => listStrategies());
  handle("load-strategy", (_e, name) => loadStrategy(String(name || "")));
  handle("save-export", (e, ref) => saveExport(BrowserWindow.fromWebContents(e.sender), ref && typeof ref === "object" ? ref : null), { ok: false });
  handle("load-session-exports", (_e, id) => loadSessionExports(id));
  handle("reveal-export", (_e, token) => { const p = savedExports.get(String(token || "")); if (!p || !fs.existsSync(p)) return false; shell.showItemInFolder(p); return true; }, false);
  handle("load-version", (_e, name, n) => loadVersion(String(name || ""), n), { code: "ERROR" });
  handle("compare-versions", (_e, name, a, b) => compareVersions(String(name || ""), a, b), { code: "ERROR" });
  handle("model-options", (_e, kind) => modelOptions(kind));
  handle("account-status", () => accountStatus());
  handle("balance", () => balanceHost().read());
  handle("public-pricing", () => publicPricing());
  handle("txf-quote", () => txfQuote());
  // 花錢的動作只收自家畫面發的:renderer 會渲染 LLM 的文字,萬一有別的 frame 被帶進來,它不能替用戶開機
  ipcMain.handle("plan-start", (e) => (fromOurPage(e) ? planStart().then((r) => {
    tm().track("plan_start_res", { result: r.state ? "ok" : r.error === "NO_CARD" ? "no_card" : r.error === "NO_CREDIT" ? "no_credit" : "error" });
    return r;
  }) : { error: "SERVER" }));
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
  // 雲端策略版本的單版 / 比較(/cloud/version):同單支策略,不留在主行程、不落地。回 { code: "OK" | "SYNCING" | "UNREACH", … }
  handle("cloud-version", (_e, q) => cloudHost().version(q), { code: "UNREACH" });
  // 雲端的報告清單與本體(renderer/reports.js;同單支策略:不啟動輪詢、憑證只在主行程)。OK + report: null = 平台現在沒有這一份
  handle("cloud-reports", (_e, force) => cloudReports(force === true), { code: "UNREACH", reports: [] });
  handle("cloud-report", (_e, id, ver) => cloudReport(id, ver), { code: "UNREACH", report: null, images: {} });
  // 報告公開分享(renderer/report-share.js):憑證、聲明 / 條款版本、本機報告的全文與圖都在主行程加;畫面只給 view / id / 掛名 / 有沒有勾
  handle("share-state", (_e, view, id) => shareClient().state(view, id), { code: "UNREACH" });
  handle("share-publish", (_e, view, id, a) => shareClient().publish(view, id, { byline: a && a.byline, confirmed: !!a && a.confirmed === true, update: !!a && a.update === true }), { code: "UNREACH" });
  handle("share-revoke", (_e, view, id) => shareClient().revoke(view, id), { code: "UNREACH" });
  // 設定 › 公開連結:清單與「只憑代碼取消」(原檔不在也撤得掉);憑證照樣只在主行程
  handle("share-list", () => shareList(), { code: "UNREACH" });
  handle("share-revoke-code", (_e, code) => shareClient().revokeCode(code), { code: "UNREACH" });
  // 報告存成 PDF:畫面只給 view / id / 清單上的版本 / 介面語言;下面兩支只回應主行程自己開的那個列印視窗
  handle("report-pdf", (e, view, id, ver, lang) => reportPdf().save(BrowserWindow.fromWebContents(e.sender), view, id, ver, lang,
    () => { if (!e.sender.isDestroyed()) e.sender.send("report-pdf-saving"); }), { code: "FAIL" });
  ipcMain.handle("print-payload", (e) => (_pdf ? _pdf.payload(e.sender) : null));
  ipcMain.on("print-ready", (e, ok) => { if (_pdf) _pdf.ready(e.sender, ok); });
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
  const CLOUD_SHIPPED = ["halt", "close_all", "resume", "resume_wait", "amounts", "delete_strategy", "credentials_remove", "retest_accounts", "book_account_confirm", "version_restore"];
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
  /* 雲端主機的群益開通(cloud_capital.js;畫面 renderer/capital.js)。pfx 與匯出密碼只在這個行程裡封裝,renderer 只拿得到檔名與代號;
     指令只收固定那幾步。送完不管結果都要一份新狀態:長步驟的結果在主機回報的 capital_connect 裡,不在回條裡 */
  const capital = () => _capital || (_capital = require("./cloud_capital").createCapital({
    send: (cmd, args, secrets) => cloudCmd().send(cmd, args, secrets),
    pick: async () => { const w = BrowserWindow.getAllWindows()[0]; const r = await dialog.showOpenDialog(w, { properties: ["openFile"], filters: [{ name: "PFX", extensions: ["pfx", "p12"] }] }); return r.canceled ? null : r.filePaths[0]; },
    stat: (p) => fs.statSync(p), readFile: (p) => fs.readFileSync(p), basename: (p) => path.basename(p),
    after: () => { cloudHost().start(); cloudHost().refresh(true).catch(() => {}); },
  }));
  const capDenied = { code: "NOT_ALLOWED" };
  handle("capital-pick", () => capital().pickPfx(), capDenied);
  handle("capital-creds", (_e, a) => capital().saveCreds({ id: a && a.id, pw: a && a.pw }), capDenied);
  handle("capital-step", (_e, name) => capital().step(String(name || "")), capDenied);
  handle("capital-upload", (_e, pw) => capital().upload(pw), capDenied);
  handle("capital-unbind", () => capital().unbind(), capDenied);
  handle("capital-forget", () => { if (_capital) _capital.forget(); return true; }, false);
  // Binance 真錢連接:四支都只收自家頁面。金鑰只在 binance-connect 經過一次,形狀先驗(binance_link.keyShapeOk),不回傳、不 log
  ipcMain.handle("binance-ip", (e) => (fromOurPage(e) ? binanceLink().ip() : null));
  ipcMain.handle("binance-state", (e) => (fromOurPage(e) ? binanceLink().state() : null));
  ipcMain.handle("binance-recheck", (e) => (fromOurPage(e) ? binanceLink().recheck(true) : null));
  ipcMain.handle("binance-connect", async (e, a) => {
    if (!fromOurPage(e) || !a || typeof a !== "object" || Array.isArray(a)) return { ok: false, code: "NOT_ALLOWED", detail: {} };
    return binanceLink().connect(a.apiKey, a.secret);
  });
  handle("min-version-state", () => minGate().state());
  handle("update-state", () => ({ ...updater().state(), backup: _officialBackup, restarting: !!restarting }));
  ipcMain.handle("update-check", (e) => (fromOurPage(e) ? updater().check() : false));
  // 聊天那一格 / 關於列按的:走 restartToUpdate(回合在跑不重開、下單中先問再收工)
  ipcMain.handle("update-install", (e) => (!fromOurPage(e) ? { ok: false, error: "NOT_ALLOWED" } : restartToUpdate()));
  // 換版時備份的資料夾:在 Finder 裡選起來。路徑由主行程自己算(畫面不交路徑),沒有備份就什麼都不做
  handle("update-show-backup", () => { if (!_officialBackup) return false; shell.showItemInFolder(path.join(WS, _officialBackup.dir)); return true; }, false);
  ipcMain.handle("telemetry-get", (e) => (fromOurPage(e) ? tm().isEnabled() : null));
  // 安裝識別碼:用戶來信要求刪除使用資料時要附的那一組(隱私權政策)。追蹤關掉也照給——關掉之前送出的紀錄還在
  handle("telemetry-install-id", () => tm().installId());
  // 切換的當下打一次 account_status:它帶著開關狀態,api 的提醒信立刻知道(沒登入就不打)
  ipcMain.handle("telemetry-set", (e, on) => { if (!fromOurPage(e)) return false; tm().setEnabled(on === true); accountStatus(); return tm().isEnabled(); });
  // 功能被使用(renderer 的 trackFeature):name 由 telemetry.js 對 feature_used 白名單驗,renderer 給的字不可信、不在表上就整則不送
  ipcMain.on("track-feature", (e, name) => { if (fromOurPage(e)) tm().track("feature_used", { name }); });
  // 卡在哪一步(renderer 的 trackEvent):事件要在 FROM_RENDERER 上,屬性值再由 telemetry.js 對列舉驗
  ipcMain.on("track-event", (e, ev, props) => { if (fromOurPage(e) && require("./telemetry").FROM_RENDERER.includes(ev)) tm().track(ev, props); });
  /* 內建瀏覽器(renderer/browser.js):畫面只送分頁 id、中欄的 bounds 與用戶的動作;網址只有用戶自己在網址列打的那一條(照樣過網路層政策)。
     頁面物件、token、網頁內容都不進 renderer(縮圖與快照是圖片與文字)。 */
  handle("browser-expand", (_e, id, b) => browser().expand(id, b), null);
  ipcMain.on("browser-bounds", (e, b) => { if (fromOurPage(e) && _browser) _browser.bounds(b); });
  handle("browser-collapse", () => { if (_browser) _browser.collapse(); return true; }, false);
  handle("browser-takeover", (_e, id) => { browser().takeover(String(id)); return true; }, false);
  handle("browser-handback", (_e, id) => { browser().handback(String(id)); return true; }, false);
  handle("browser-user-done", (_e, id, choice) => { browser().userDone(id, choice); return true; }, false);
  handle("browser-navigate", (_e, id, url) => browser().navigate(id, url), { error: "NOT_ALLOWED" });
  handle("browser-reload", (_e, id) => browser().reload(id), false);
  handle("browser-open-live", (_e, sid, snap) => (okSessionId(sid) ? browser().openLive(sid, snap) : null), null);
  handle("browser-show-live", (_e, url) => browser().showLive(url), null);
  handle("browser-snapshot", (_e, sid, snap) => (okSessionId(sid) ? browser().snapshot(sid, snap) : null), null);
  handle("browser-history", (_e, sid) => (okSessionId(sid) ? browser().history(sid) : []), []);
  ipcMain.on("browser-block-visible", (e, on) => { if (fromOurPage(e) && _browser) _browser.setBlockVisible(on === true); });
  // 用系統瀏覽器開這一頁:renderer 只給分頁 id(給別的型別一律不開),網址由主行程從那個分頁自己拿;內建那一頁不關、不動
  handle("browser-open-external", (_e, id) => { const u = _browser && typeof id === "string" ? _browser.externalUrl(id) : null; return u ? openWebSafe(u) : false; }, false);
  handle("browser-prefs", () => browser().prefs(), { enabled: false });
  handle("browser-prefs-set", (_e, p) => browser().setPrefs({ enabled: !!(p && p.enabled === true) }), null);
  handle("browser-clear", () => (activeTurn ? false : browser().clearData()), false);
  // 送進 TradingView(browser/pine.js):外殼自己貼,不開 agent 回合。renderer 只給 ref。流程停在交接:貼完之後沒有任何一支 IPC 會再讀那一頁
  handle("pine-install", (_e, ref) => { const job = pineJob(ref && typeof ref === "object" ? ref : null); return job ? browser().pineInstall(job) : { state: "fail", why: "no_file" }; }, { state: "fail" });
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
  // 設定 › Agent 規則(agentrules.js):畫面只拿內容、送編輯;讀寫這台電腦的兩個檔都在主行程,形狀由 daemon.argsOk 驗
  handle("rules-state", () => agentRules().read(), null);
  handle("rules-save", (_e, a) => agentRules().save("preferences_set", { rules: a && Array.isArray(a.rules) ? a.rules : null, base: a && Array.isArray(a.base) ? a.base : null }), { ok: false, error: "NOT_ALLOWED" });
  handle("reply-lang-save", (_e, a) => agentRules().save("reply_lang_set", { lang: a && typeof a.lang === "string" ? a.lang : null, custom: a && typeof a.custom === "string" ? a.custom : "" }), { ok: false, error: "NOT_ALLOWED" });
  handle("load-model-prefs", () => loadModelPrefs());
  handle("save-model-prefs", (_e, prefs) => saveModelPrefs(prefs));
  handle("start-oauth", (_e, lang) => startOAuth(lang === "en" ? "en" : "zh"));   // 語言段會拼進同意頁的路徑:只認兩個值(稽核 R6)
  handle("cancel-oauth", () => cancelOAuth());
  handle("clear-connection", () => clearConnection());
  handle("has-blave-token", () => !!loadToken());
  // 策略庫(renderer/library.js):清單與已安裝表只收自家頁面;購買會動到餘額與信用卡,拒絕時回「打不到」的形狀
  handle("library-list", (_e, lang, force) => libraryList(lang, force === true), null);
  handle("library-report", (_e, id, lang) => libraryReport(id, lang), null);
  handle("library-note", (_e, id) => libraryNote(id), null);
  ipcMain.handle("library-purchase", (e, id, confirmTopup) => (fromOurPage(e) ? libraryPurchase(id, confirmTopup) : { status: 0, body: null }));
  handle("library-installed", (_e, patch) => libraryInstalled(patch), {});
  // 本機報告(renderer/reports.js):讀 <WS>/reports 的信封 / 本體 + sidecar 圖(data URI);renderer 不碰 fs
  handle("reports-list", () => reportsList(), { reports: [] });
  handle("report-load", (_e, id) => reportLoad(id), null);
  handle("sign-out-blave", () => signOutBlave());
  handle("agent-login", (_e, kind) => agentLogin(String(kind || "")));
  handle("cancel-agent-login", () => cancelAgentLogin());
  handle("stop-turn", () => stopTurn(), false);
  ipcMain.handle("send-message", async (e, payload) => {
    if (!fromOurPage(e)) return { busy: true };   // 會 spawn agent、花 AI 額度:只收自家頁面
    if (activeTurn || turnStarting || restarting) return { busy: true };   // 更新重開收工中:開了也會被砍掉
    const win = BrowserWindow.fromWebContents(e.sender);
    // 使用追蹤「上雲端運行」:只認「送上雲端」確認框送的那句(payload.handoff === "up";拉回不算),而且旗標要開——關著時畫面到不了那條路,標記也不認
    const cloudUp = cloudHandoffOn() && payload && payload.handoff === "up";
    // runTurn 要先 await 登入 shell 的 PATH 與 account_status 才 spawn;這段期間 activeTurn 還是 null,
    // 不另外立旗標的話連按兩下會 spawn 兩顆 agent 搶同一個 session.db(下面補問版本閘的那段 await 也算在內)
    turnStarting = true;
    newTurnStop();
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
  // 選單字由畫面交過來(trPushLabels):收件的 handler 要在視窗之前掛好,而且 app 選單先重建、再動選單列——
  // 以前掛在一串啟動步驟的最後,中間任何一步拋例外 handler 就沒掛上,app 選單停在英文(File／Edit／View…)、畫面其他都正常
  ipcMain.on("trade-labels", (e, labels) => {
    if (!fromOurPage(e) || !labels || typeof labels !== "object") return;
    for (const k of Object.keys(tmLabels)) if (typeof labels[k] === "string" && labels[k] && labels[k].length <= 400) tmLabels[k] = labels[k];
    trayLabelsIn = true;
    if (labels.lang === "zh" || labels.lang === "en") uiLang = labels.lang;   // 只拿來組官網網址的語言段:白名單兩個值
    startStep("app menu", appMenuSync);
    startStep("tray", traySync);
    // 搬到「應用程式」那一問:第一次拿到畫面的字才問(中文用戶不先看到英文),一次啟動只在這一刻判一次
    if (!moveChecked) { moveChecked = true; startStep("move to apps", () => { askMoveToApps().catch((err) => console.error("[move] " + ((err && err.message) || err))); }); }
  });
  createWindow();
  startStep("app menu", appMenuSync);
  // 要在常駐程式起來之前:它 import 的就是 workspace 裡的 lib。只有拿到單一實例鎖的那一份才做——
  // 第二份 app 在結束前也會走到 whenReady,不能讓它把新 lib 拷進第一份正在下單的 workspace(稽核 S7)
  if (app.hasSingleInstanceLock()) startStep("workspace sync", syncOfficialOnUpdate);
  startStep("trade host", tradeStartIfReady);   // 引擎早就裝好的人:一開 app 就有狀態可看(對帳器仍要他自己按啟動)
  if (app.hasSingleInstanceLock()) startStep("engine", engineKick);   // 要裝的在背景裝;已經裝好的幾毫秒就結束。第二份 app 不碰 venv
  // 視窗回前景 = 用戶可能剛在瀏覽器綁完卡、開完主機:「含不含資料」的答案作廢,下一輪重查
  // (不在這裡打 api——跟 LLM 共用每分鐘 30 次的桶,而且畫面那邊有卡片時本來就會重查)
  // 畫面自己的 blur 分不出「焦點進了內建瀏覽器那一頁」跟「整個視窗退到背景」,所以由這裡講
  const tellActive = (w, on) => { if (w && !w.isDestroyed() && isOurPageUrl(w.webContents.getURL())) w.webContents.send("window-active", on); };
  app.on("browser-window-focus", (_e, w) => { lastAcct = null; p1Badge = 0; if (app.dock) app.dock.setBadge(""); cloudHost().setForeground(true); tellActive(w, true); });
  app.on("browser-window-blur", (_e, w) => { cloudHost().setForeground(false); tellActive(w, false); });   // 背景時輪詢放慢到 60 秒
  app.on("activate", () => showMain());   // 點 Dock:視窗被紅燈收起來的話把它叫回來
  startStep("tray", trayStart);
  startStep("telemetry", () => tm().start());
  startStep("app state", () => { accountStatus(); });   // 已登入就補報一次現況:關掉開關之後沒再用的人,下次開 app 就送到(沒登入不打)
  startStep("updater", () => updater().start());
  startStep("min version gate", () => minGate().start());
});
/* 啟動步驟各自隔開:一步拋例外只記一行、不擋後面的步驟(選單、選單列、更新、遙測彼此無關) */
function startStep(what, fn) { try { return fn(); } catch (e) { console.error(`[startup] ${what} failed: ${(e && e.stack) || e}`); return undefined; } }
// 一次只跑一份:第二份會跟第一份搶同一個 workspace 與 session.db,也讓「用同一顆 binary 再開一份」這條
// 旁路少一點(稽核 M1)
if (!app.requestSingleInstanceLock()) app.quit();
else app.on("second-instance", () => showMain());   // 視窗可能被紅燈收起來了:show 也要做
app.on("window-all-closed", () => app.quit());

/* ── 視窗之外的暫停(設計師提案 §3-6)─────────────────────────────
   自動下單在跑的時候,用戶不一定在看這個視窗:選單列圖示(0.1.9 起常駐;可能在下單時才有暫停)、Dock 右鍵、結束攔截。
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
/* 為了更新而重開(restartToUpdate)確認之後的那一段:null | "stopping"(收工中,最多 11 秒)| "installing"(已交給 quitAndInstall)。
   stopping 期間:入口再按不跳第二個框、選單列那一行停用、不開新回合、紅燈只收視窗、Cmd+Q 等它自己結束(稽核 0.1.10 P1-1 / P2-8) */
let restarting = null;
/* 設 restarting 一律走這支:狀態一變就推給畫面(聊天那一格、關於列換「重新啟動中…」)並重建選單列,不等 5 秒那一輪 */
function setRestarting(v) {
  restarting = v;
  try { const st = { ...updater().state(), backup: _officialBackup, restarting: !!v }; for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("update-state", st); } catch (_) { /* 畫面壞掉不擋重開 */ }
  startStep("tray", traySync);
}
let tmLabels = { running: "Auto trading is running", paperVenue: "Paper trading", pause: "Pause trading (keep positions)", open: "Open Blave", quit: "Quit Blave…",
  notifTitle: "Trading paused", notifBody: "Positions were not touched.", pauseFail: "The pause command didn’t go through. Trading may still be running.",
  pauseUnknown: "The pause command was sent, but this computer hasn’t reported the result yet. Check the status on this page.",
  quitTitle: "Auto trading is still running", quitBody: "After you quit Blave, this computer stops placing orders. Positions are not closed.", quitGo: "Quit Blave", quitStay: "Cancel", ok: "OK",
  // 畫面還沒交字之前就按結束:回合中那一道也要有字(不然 message 退回下單那句、detail 是空的)
  quitTurnTitle: "The agent is still replying", quitTurnBody: "Quitting Blave now cuts off this turn, including any cloud update in progress. It's safer to wait until it finishes.",
  hidden: WIN ? "Blave is still running in the system tray." : "Blave is still running in the menu bar.",
  updateReady: "Restart to finish updating", restarting: "Restarting…",
  updateBody: "After the restart, this computer places no more orders and closes nothing; positions stay at {venue}. Press Start trading to resume.",
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
  stLocalOnly: "", noAccount: "", runningZ: "",   // 選單列這台電腦那一行沒在下單也講(0.1.9):「這台電腦：還沒連接交易所」、沒設金額的那一態
  br_captchaTitle: "", br_captcha: "",   // 內建瀏覽器:搜尋要用戶過驗證(browserNotify);空的 = 還沒交字 = 不發
  moveTitle: "", moveBody: "", moveGo: "", moveNo: "",   // 搬到「應用程式」那一問(askMoveToApps):空的 = 還沒交字 = 不問
  pauseLocal: "", quitCloudNote: "", notifPrefixLocal: "", notifPrefixCloud: "", ...Object.fromEntries(Object.keys(MENU_EN).map((k) => [k, ""])) };
const TT = require("./traytext");
const { planRestart, shouldAskMove } = require("./updater");
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
// st:呼叫端已經讀過一次狀態檔就傳進來(traySync 一輪只讀一次,不同步驟不會看到前後兩份快照);沒傳就自己讀
function tradeLive(st = _tradeHost ? _tradeHost.status() : null) {
  if (!st) return null;
  const r = st.report;
  if (!st.alive || !r || r.error || !r.venues || (r.halt && r.halt.halted) || !(r.reconciler && r.reconciler.alive)) return null;
  // 心跳檔的新鮮期是 300 秒:app 重開後那 5 分鐘,上一次的心跳還「新鮮」但對帳器根本沒起來。監督者說沒在跑就是沒在跑。
  if (r.daemon && r.daemon.reconciler && r.daemon.reconciler.running === false) return null;
  const id = Object.keys(r.venues).filter((k) => venueReady(r.venues[k])).sort()[0];
  return id ? { venue: id } : null;
}
function tradeMaybeLive(st = _tradeHost ? _tradeHost.status() : null) {
  const live = tradeLive(st);
  if (live) return live;
  if (!st) return null;
  const r = st.report;
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
  dialog.showMessageBox(BrowserWindow.getAllWindows()[0] || undefined, { type: "warning", noLink: true, message: pauseLabel(),
    detail: r && r.error === "UNKNOWN_RESULT" ? tmLabels.pauseUnknown : tmLabels.pauseFail, buttons: [tmLabels.ok] });
}
// 新版已經暫存好、但因為正在下單而沒裝:桌機用戶的 app 常常整天開著,不講的話他們不會知道有新版在等
const updateWaiting = () => { try { const p = updater().state().phase; return p === "blocked" || p === "ready"; } catch (_) { return false; } };
/* 「重新啟動以完成更新」的唯一一條路(聊天那一格、關於列、選單列都叫這支;spec-desktop-update-prompt-0.1.10 §0)。
   下單中:先問(同結束攔截的框,共用 quitAsking);確認後走結束 app 同一條收工(noteQuit → stop:對帳器先撤自己掛的限價單),
   收完才 install。先設 quitConfirmed:quitAndInstall 關視窗、before-quit 兩道攔截都直接放行,不會再問一次。
   重開之後**不自動接回下單**(Wei 拍板):對帳器照規矩停著,等用戶自己按啟動。
   stop 放棄等待、狀態還說在下單 → install 回 TRADING:改走 app.quit(),autoInstallOnAppQuit 照樣裝,只是不自己重開 */
// 埋點:feature_used 的 update_restart(隱私頁「分頁與按鈕的名稱」那一類),只在真的走下去時送——直接裝、或下單中按了確認
async function restartToUpdate() {
  const used = () => { try { tm().track("feature_used", { name: "update_restart" }); } catch (_) { /* 追蹤不擋更新 */ } };
  const phase = () => updater().state().phase, turnBusy = () => !!(activeTurn || turnStarting);
  const live = tradeMaybeLive();
  // 已經在收工 / 結束(restarting、quitConfirmed、quitting)跟「框開著」同一種:不再問、不再收一次工
  const step = planRestart({ phase: phase(), turn: turnBusy(), asking: quitAsking || !!restarting || quitConfirmed || quitting, trading: !!live });
  if (step === "not_ready") return { ok: false, error: "NOT_READY" };
  if (step === "busy") return { ok: false, error: "TURN_BUSY" };
  if (step === "asking") return { ok: false, error: "ASKING" };
  // 安裝程式不能留著:結束後它還在寫 venv,下次開 app 就是兩支 pip 寫同一個資料夾(Windows 上它還握著隨包 Python 的 DLL)
  if (step === "install") { await engineAbort(); const res = updater().install(); if (res.ok) used(); return res; }
  let r = null;
  try { showMain(); } catch (_) { /* 叫不出視窗也照問;先叫再立旗標,拋例外不會把 quitAsking 卡在 true(稽核 P2-1) */ }
  quitAsking = true;
  const sg = TT.stayGo(process.platform, tmLabels.quitStay, tmLabels.updateReady);
  try {
    r = await dialog.showMessageBox(BrowserWindow.getAllWindows()[0] || undefined, { type: "warning", noLink: true, message: tmLabels.quitTitle,
      detail: TT.quitDetail(tmLabels.updateBody.replace("{venue}", () => venueName(live.venue)), TT.cloudTrading(cloudSt()) ? tmLabels.quitCloudNote : ""),
      buttons: sg.buttons, defaultId: sg.defaultId, cancelId: sg.cancelId });
  } catch (_) { r = null; } finally { quitAsking = false; }
  if (!r || r.response !== sg.goIndex) return { ok: false, error: "CANCELED" };
  // 框開著的時候可能變了:回合開始了(程式觸發的)、updater 自己出錯了 → 不收工,什麼都沒動
  if (turnBusy()) return { ok: false, error: "TURN_BUSY" };
  const ph = phase();
  if (ph !== "ready" && ph !== "blocked") return { ok: false, error: "NOT_READY" };
  used();
  setRestarting("stopping"); quitConfirmed = true;
  try {
    if (_tradeHost) { _tradeHost.noteQuit(); await _tradeHost.stop(); }
    await engineAbort();
    setRestarting("installing");
    const res = updater().install();
    if (res.ok) return res;
    console.error("[updater] install after stop: " + res.error);
  } catch (e) { console.error("[updater] restart failed: " + ((e && e.message) || e)); }
  // 已經收工(用戶同意停單)卻沒裝成:改走結束 app,不留「停了一半、app 沒重開」。Squirrel 暫存好的話結束時照樣裝上(autoInstallOnAppQuit)
  setRestarting("installing");
  app.quit();
  return { ok: true, quit: true };
}
/* 啟動時不在「應用程式」資料夾就問一次(§4)。「不要移」寫一個記號、之後永遠不問;授權框取消(false)或搬移出錯不記,下次啟動再問。
   搬移成功 app 會自己結束再重開。app.isInApplicationsFolder / moveToApplicationsFolder 只有 macOS 有,shouldAskMove 先擋平台 */
const moveDeclinedPath = () => path.join(app.getPath("userData"), "move-declined.json");
let moveChecked = false, moveAsked = false;
async function askMoveToApps() {
  const L = tmLabels;
  if (!(L.moveTitle && L.moveBody && L.moveGo && L.moveNo)) return false;
  const mac = process.platform === "darwin" && app.isPackaged;
  if (!shouldAskMove({ platform: process.platform, packaged: app.isPackaged, inApps: !mac || app.isInApplicationsFolder(), declined: fs.existsSync(moveDeclinedPath()),
    trading: !!tradeMaybeLive(), askedThisRun: moveAsked })) return false;
  moveAsked = true;
  const parent = BrowserWindow.getAllWindows()[0] || undefined;
  const r = await dialog.showMessageBox(parent, { type: "question", noLink: true, message: L.moveTitle, detail: L.moveBody,
    buttons: [L.moveNo, L.moveGo], defaultId: 1, cancelId: 0 });
  if (r.response !== 1) {
    // 框是因為 app 在結束、視窗被關掉才回來的:用戶沒選,不記成「不要」(稽核 P2-5)
    if (quitting || quitConfirmed || (parent && parent.isDestroyed())) return false;
    try { fs.writeFileSync(moveDeclinedPath(), JSON.stringify({ declined: true }), { mode: 0o600 }); } catch (_) { /* 寫不進去:下次啟動再問一次 */ }
    return false;
  }
  // 框開著的時候開始下單 / 開始回合:搬移成功會走 before-quit,被結束攔截擋下的話 app 會從垃圾桶裡的 bundle 繼續跑。這次不搬,也不記(稽核 P2-2)
  if (tradeMaybeLive() || activeTurn || turnStarting) return false;
  // 埋點 feature_used 的 app_move = 按了「移」(不是搬成功:成功 app 會立刻結束重開,事後送不出去;授權框取消也算按過)
  try { tm().track("feature_used", { name: "app_move" }); } catch (_) { /* 追蹤不擋 */ }
  try { return app.moveToApplicationsFolder(); } catch (e) { console.error("[move] " + ((e && e.message) || e)); return false; }
}
/* 選單列 / Dock 的狀態行(設計 spec-desktop-tray-resident-0.1.9 §2)。這台電腦那一行永遠講,沒在下單也講(TT.localLine);
   沒有交易所名可填的那幾態(還沒連接交易所…)換不帶 {money} 的樣板。字還沒交 → null;那時只有確定在下單才退回英文那一句 */
function trayLocalLine(live, st) {
  const l = TT.localLine(st, lastVenue);
  return (l && TT.statusLine(l.money ? tmLabels.stLocal : tmLabels.stLocalOnly, l, tmLabels)) || (live ? tmLabels.running : null);
}
const trayCloudLine = () => TT.statusLine(tmLabels.stCloud, TT.cloudLine(cloudSt()), tmLabels);
// 「…」= 按了會先跳確認框(before-quit 那兩道:可能在下單、回合在跑);不會跳的時候用不帶「…」的那一句(同 app 選單;HIG)
const trayQuitLabel = (maybe) => (maybe || activeTurn || turnStarting ? tmLabels.quit : tmLabels.menuQuit || MENU_EN.menuQuit);
// 一組一組排,組跟組之間一條分隔線:缺席的組連它上面那條一起不出(不會兩條疊在一起、不會以分隔線開頭或結尾)
const trayGroups = (groups) => groups.filter((g) => g.length).flatMap((g, i) => (i ? [{ type: "separator" }, ...g] : g));
/* m = traySync 算好的那一份:{ local, cloud, update, pause, quit }。
   狀態行 → 更新行(app 新版已暫存好:「重新啟動以完成更新」,不可點;雲端的更新不進選單列,v4 §4)→ 暫停(可能在下單時才出)→ 打開 / 結束。
   只放安全方向的動作:不給啟動下單;暫停只給這台電腦,雲端的暫停要用戶在雲端視角親手做 */
function trayMenu(m) {
  return Menu.buildFromTemplate(trayGroups([
    [m.local, m.cloud].filter(Boolean).map((label) => ({ label, enabled: false })),
    // 可以按(0.1.10):下單中會先問,字尾「…」;回合在跑停用、不帶「…」(選單列沒有 tooltip 講原因,同聊天那一格只停用)
    // 為了更新正在重開(收工中 / 安裝中):字換「重新啟動中…」、停用
    m.update ? [{ label: m.update.restarting ? tmLabels.restarting : tmLabels.updateReady + (m.update.ask && !m.update.busy ? "…" : ""), enabled: !m.update.busy, click: () => { restartToUpdate().catch((e) => console.error("[updater] restart: " + ((e && e.message) || e))); } }] : [],
    m.pause ? [{ label: pauseLabel(), click: pauseFromMenu }] : [],
    [{ label: tmLabels.open, click: showMain }, { label: m.quit, click: () => app.quit() }],
  ]));
}
// Dock 選單 = 同一組狀態行 + 暫停(打開、結束 Dock 本來就有)。選單列圖示可能被系統藏掉(瀏海、macOS 26 的允許清單),Dock 是一定在的那條路(HIG)
function trayDockMenu(m) {
  return Menu.buildFromTemplate(trayGroups([[m.local, m.cloud].filter(Boolean).map((label) => ({ label, enabled: false })), m.pause ? [{ label: pauseLabel(), click: pauseFromMenu }] : []]));
}
/* 選單列圖示常駐(0.1.9,Wei):app 開著就在,沒有開關。關視窗後留不留在背景照舊由 close 那一道決定,跟圖示無關。
   等畫面第一次交字才建(trayLabelsIn):中文用戶不會先看到英文退路的選單;可能在下單時不等(暫停的路優先) */
let trayLabelsIn = false;
function traySync() {
  const st = _tradeHost ? _tradeHost.status() : null, live = tradeLive(st);
  if (live) lastVenue = live.venue;
  const maybe = live || tradeMaybeLive(st), show = !!maybe || trayLabelsIn;
  const m = { local: trayLocalLine(live, st), cloud: trayCloudLine(), update: updateWaiting() || restarting ? { ask: !!maybe, busy: !!(activeTurn || turnStarting || restarting), restarting: !!restarting } : null, pause: !!maybe, quit: trayQuitLabel(maybe) };
  // 每一行的字、暫停有沒有出都進 key:少一樣,換語言之後要等別的欄位變了才會重建
  const key = JSON.stringify([show, m, pauseLabel(), tmLabels.open, m.update ? tmLabels.updateReady : "", m.update && m.update.restarting ? tmLabels.restarting : ""]);
  if (key === trayKey) return;   // 每 5 秒叫一次:沒變就不重建選單
  // trayKey 等副作用都做完才記:中途拋例外的話下一輪 key 相同也會重做,圖示與暫停項不會卡在舊狀態
  if (app.dock) app.dock.setMenu(trayDockMenu(m));
  if (!show) {
    if (tray) { tray.destroy(); tray = null; }
    trayKey = key;
    return;
  }
  if (!tray) {
    // Windows 不認 Template 命名(黑色單色圖在深色工作列看不見),給彩色的 .ico(16 / 24 / 32)
    const img = WIN ? nativeImage.createFromPath(path.join(__dirname, "assets", "tray.ico"))
      : nativeImage.createFromPath(path.join(__dirname, "assets", "trayTemplate.png"));   // 檔名結尾 Template = macOS 自動依選單列明暗上色
    if (img.isEmpty()) console.error("tray icon missing: shell/assets/" + (WIN ? "tray.ico" : "trayTemplate.png"));   // 空圖 = 看不見的圖示;選單還在,但要留下痕跡(稽核 M4)
    tray = new Tray(img);
    if (WIN) tray.on("click", showMain);   // Windows 系統匣慣例:左鍵打開、右鍵選單。macOS 設了 context menu 點一下就是開選單,不掛
  }
  tray.setToolTip(m.update ? (m.update.restarting ? tmLabels.restarting : tmLabels.updateReady) : m.local || app.name);
  tray.setContextMenu(trayMenu(m));
  trayKey = key;
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
// updater().poll():ready ↔ blocked 只跟著下單狀態變、沒有事件,靠這 5 秒那一輪補推(聊天那一格的「…」跟著暫停 / 開始下單換)
function trayStart() { if (!trayTimer) { trayTimer = setInterval(() => { startStep("tray", traySync); startStep("p1", p1Sync); startStep("update poll", () => updater().poll()); }, 5000); if (trayTimer.unref) trayTimer.unref(); traySync(); } }   // 可能在下單的話一開就出,不等第一個 5 秒(常駐的那顆等畫面交字)
app.on("browser-window-created", (_e, win) => {
  win.on("close", (e) => {
    // 關視窗不等於結束:自動下單在跑、或本機 agent 回合在跑(可能正在更新雲端)時只把視窗藏起來,回合 / 下單照走
    // 更新重開收工中:紅燈只收視窗(放行會變成走結束 app → 裝了但不重開);交給 quitAndInstall 之後就放行,它要關視窗才能重開
    if (restarting === "stopping") { e.preventDefault(); win.hide(); return; }
    const trading = tradeMaybeLive(), turn = !!(activeTurn || turnStarting);
    if (quitting || quitConfirmed || (!trading && !turn)) return;
    e.preventDefault(); win.hide();
    // 「背景照常下單」那則只在真的在下單時講(字寫的是下單)
    if (trading && !hiddenSaid && tmLabels.hidden && Notification.isSupported()) { hiddenSaid = true; notifWatch(new Notification({ title: tmLabels.running, body: tmLabels.hidden }), "hidden").show(); }
  });
});
/* 結束訊號(SIGTERM / SIGINT / SIGHUP:kill、登出與關機、終端機 Ctrl+C)每一次都走 app.quit(),也就是每一次都過 before-quit 的攔截。
   不自己接的話 Chromium 的處理只管第一次:它收到一次訊號就把處理還原成系統預設,第一次被攔下(用戶按了取消)之後,
   第二次訊號直接殺掉行程——沒有框、daemon 沒收工、事件清單也沒記(實測 09-28)。要在 ready 之後掛:Chromium 的處理是啟動時裝的,
   後掛的才算數。Windows 沒有這幾個訊號的同等語意,不掛。tests/check_shell_quit_again.js 從原文切出來跑 */
function quitOnSignals(proc, quit) {
  if (proc.platform === "win32") return [];
  const sigs = ["SIGTERM", "SIGINT", "SIGHUP"];
  for (const s of sigs) proc.on(s, () => quit());
  return sigs;
}
// 結束前先讓 daemon 收工(對帳器要先撤掉自己掛在交易所的限價單);最多等 9 秒,之後不管怎樣都走。
// 就算這段沒跑到(當機、被強殺),daemon 讀到 stdin EOF 也會自己收。
let quitting = false;
app.on("before-quit", (e) => {
  // 更新重開正在收工:它收完會自己裝 / 結束;這時再跑一次下面的 stop 只會多送一次 SIGTERM、跟 quitAndInstall 搶(稽核 P2-8)
  if (restarting === "stopping") { e.preventDefault(); return; }
  // 自動下單還在跑:結束 = 停止下單、部位留著不平——先問一次(從選單列「結束 Blave…」、Cmd+Q、Dock 結束都走這裡)
  const live = !quitting && !quitConfirmed && tradeMaybeLive();
  if (live) {
    e.preventDefault();
    if (quitAsking) return;   // 框還開著又按一次 Cmd+Q:不疊第二個(稽核 M2)
    try { showMain(); } catch (_) { /* 叫不出視窗也照問;先叫再立旗標,拋例外不會把 quitAsking 卡在 true(稽核 P2-1) */ }
    quitAsking = true;
    const sg = TT.stayGo(process.platform, tmLabels.quitStay, tmLabels.quitGo);
    dialog.showMessageBox(BrowserWindow.getAllWindows()[0] || undefined, { type: "warning", noLink: true, message: tmLabels.quitTitle,
      // 雲端也「確定在下單」時多一句:結束這個 app 不影響雲端。不確定就不說(那一句是在替雲端做保證)
      detail: TT.quitDetail(tmLabels.quitBody.replace("{venue}", () => venueName(live.venue)), TT.cloudTrading(cloudSt()) ? tmLabels.quitCloudNote : ""), buttons: sg.buttons, defaultId: sg.defaultId, cancelId: sg.cancelId })
      .then((r) => { quitAsking = false; if (r.response === sg.goIndex) { quitConfirmed = true; if (_tradeHost) _tradeHost.noteQuit(); app.quit(); } }, () => { quitAsking = false; });
    return;
  }
  // 本機 agent 回合還在跑(可能正在更新雲端主機):結束會把它斷掉,先問一次(同自動下單那一道;已經確認過就不再問)
  if (!quitting && !quitConfirmed && (activeTurn || turnStarting)) {
    e.preventDefault();
    if (quitAsking) return;
    try { showMain(); } catch (_) { /* 同上 */ }
    quitAsking = true;
    const sg = TT.stayGo(process.platform, tmLabels.quitStay, tmLabels.quitGo);
    dialog.showMessageBox(BrowserWindow.getAllWindows()[0] || undefined, { type: "warning", noLink: true, message: tmLabels.quitTurnTitle,
      detail: tmLabels.quitTurnBody, buttons: sg.buttons, defaultId: sg.defaultId, cancelId: sg.cancelId })
      .then((r) => { quitAsking = false; if (r.response === sg.goIndex) { quitConfirmed = true; app.quit(); } }, () => { quitAsking = false; });
    return;
  }
  // 常駐程式在跑、或背景安裝的 pip 還在跑:先收掉再結束(pip 不收會變孤兒,下次開 app 跟新的那支一起寫 venv)
  const daemon = !!(_tradeHost && _tradeHost.isRunning()), installing = !!(_engineSetup && _engineSetup.busy());
  if (quitting || (!daemon && !installing)) return;
  e.preventDefault(); quitting = true;
  Promise.all([daemon ? _tradeHost.stop() : null, engineAbort()]).finally(() => app.quit());
});
