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

// 發佈版(npm run release 在 package.json 蓋 blaveRelease)拒絕 Chromium 的遠端除錯開關。fuses 只關得掉
// Node 那一側(--inspect、RUN_AS_NODE、NODE_OPTIONS);--remote-debugging-port 不歸 fuses 管(實測翻完
// 仍然開著),而接上它就等於拿到 renderer、能呼叫 preload 開出去的每一個 IPC。pack 產物不擋,測試要用。
if (app.isPackaged && require("./package.json").blaveRelease
    && ["remote-debugging-port", "remote-debugging-pipe"].some((f) => app.commandLine.hasSwitch(f))) app.exit(1);

// macOS GUI app 的 PATH 是極簡的(實測 /usr/bin:/bin 下找不到 claude),
// 所以先跑一次使用者的登入 shell 解析出真正的 PATH,偵測與之後 spawn 引擎共用。
// 見 .claude/output/desktop-v1/2026-09-18-agent-detection.md。
let resolvedPath = null;
const mergePath = (got, known) => got.concat(known.filter((d) => got.indexOf(d) < 0)).filter(Boolean).join(":");
function loginShellPath() {
  return new Promise((resolve) => {
    if (resolvedPath) return resolve(resolvedPath);
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
  // Codex 有兩種裝法:獨立 CLI(在 PATH 上),或跟著 ChatGPT 桌面版來的——後者的
  // CLI 藏在 app bundle 裡、不在 PATH 上,但就是同一顆完整的 codex(實測
  // 0.155.0-alpha:`login status`、`exec --json` 都在)。只查 PATH 的話,一大群
  // 「有 Codex」的人會看到「未偵測到」。
  const CODEX_IN_CHATGPT = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const codexBin = (await which("codex", envPath))
    || (fs.existsSync(CODEX_IN_CHATGPT) ? CODEX_IN_CHATGPT : null);
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
    const child = spawn(bin, kind === "claude" ? ["auth", "login"] : ["login"],
      { env: { ...process.env, PATH: envPath }, stdio: "ignore" });
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

// v1:連結選擇只落在本機設定檔,引擎接線是第 4 步
const statePath = () => path.join(app.getPath("userData"), "connect.json");
function saveConnection(choice) {
  fs.writeFileSync(statePath(), JSON.stringify({ ...choice, at: new Date().toISOString() }));
  tm().track("connect_done", { kind: choice && choice.kind });   // kind 不在列舉內(blave/claude/codex)track 自己會丟掉
  return true;
}
function clearConnection() {
  try { fs.unlinkSync(statePath()); } catch (_) {}
  return true;
}
function loadConnection() {
  try { return JSON.parse(fs.readFileSync(statePath(), "utf8")); } catch (_) { return null; }
}

// ── 使用追蹤(telemetry.js:七個事件、屬性只有列舉、沒有自由文字的入口;設定裡可關)──
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

// ── 自動更新(updater.js;規則見 spec §13)────────────────────
// 更新來源由打包時的 BLAVE_UPDATE_URL 蓋進 package.json(blaveUpdateUrl);開發版與沒設的包 = 不更新,畫面只顯示版號。
let _up = null;
function updater() {
  if (_up) return _up;
  const feedUrl = app.isPackaged ? require("./package.json").blaveUpdateUrl || null : null;
  _up = require("./updater").createUpdater({
    autoUpdater: feedUrl ? require("electron-updater").autoUpdater : null,
    nativeUpdater: feedUrl ? require("electron").autoUpdater : null,   // Squirrel 暫存完成的事件只有原生這顆會發(updater.js 檔頭)
    feedUrl, currentVersion: app.getVersion(),
    isTrading: () => !!tradeMaybeLive(),   // 保守判定:可能還在下單就不裝
    onState: (st) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("update-state", st); },
    log: (m) => console.error("[updater] " + m),
  });
  return _up;
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
  clearDataKey();
  clearAppSecret();
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
  lastAcct = null;
  return { revoked };
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
  tm().track("login_done");
  // 資料 key 只在這一次回應裡出現;舊版 api 沒有這兩欄就是沒有資料權限,不算失敗
  // 先清掉上一次登入留下的那組:那顆 token 換掉之後,舊 key 可能已經被撤銷,留著會把死 key
  // 寫進 .env 還告訴 agent「你有資料」
  clearDataKey();
  saveDataKey(r.body.data_api_key, r.body.data_secret_key);
  clearAppSecret();
  saveAppSecret(r.body.app_secret);      // 舊版 api 沒有這欄:之後按「啟動方案」會被要求重新登入
  lastAcct = null;                    // 可能換了一個帳號:上一個帳號的「含不含資料」不能沿用
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
const VENV_PY = path.join(BASE, "venv", "bin", "python");
// 乾淨的 Mac 沒有 python3(要先裝 Xcode CLT):打包版隨包一顆(tools/fetch-python.sh),
// venv 用它建;開發時照舊用系統的。
const BUNDLED_PY = path.join(process.resourcesPath || "", "python", "bin", "python3");
const basePython = () => (app.isPackaged && fs.existsSync(BUNDLED_PY) ? BUNDLED_PY : "python3");
// 打包版的 runtime/ 與隨包 Python 都在 .app 裡:不讓 Python 把 __pycache__ 寫進去
// (簽章後 bundle 內容一變就驗不過;唯讀位置也寫不進)。
const PY_ENV = app.isPackaged ? { PYTHONPYCACHEPREFIX: path.join(BASE, "state", "pycache") } : {};

function sh(cmd, envPath, timeout = 300000) {
  return new Promise((resolve, reject) => {
    execFile("/bin/sh", ["-c", cmd], { timeout, env: { ...process.env, ...PY_ENV, PATH: envPath } },
      (err, stdout, stderr) => err ? reject(new Error(String(stderr || err))) : resolve(String(stdout)));
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
function syncOfficialOnUpdate() {
  if (!app.isPackaged || !fs.existsSync(WS)) return false;   // 開發版每次啟動本來就重拷;還沒有 workspace = 首次連結時會拷
  const bundled = readVersion(REPO), ws = readVersion(WS);
  if (!officialStale(bundled, ws)) { if (bundled && ws && bundled < ws) console.error(`[update] workspace ${ws} is newer than this app's ${bundled} — left as is`); return false; }
  try {
    // 備份不成就不覆寫:寧可這次停在舊 lib(下次啟動再試),也不要把改動弄丟
    const bk = backupChangedOfficial(`${ws || "none"}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    copyOfficial();
    console.error(`[update] workspace framework ${ws || "(none)"} → ${bundled}` + (bk.saved.length ? `; ${bk.saved.length} changed official file(s) backed up to ${bk.dest}` : ""));
    return true;
  } catch (e) { console.error("[update] workspace sync failed: " + (e && e.message)); return false; }
}

const AGENT_SDK = "claude-agent-sdk==0.2.144";
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
    // .app 被搬走 / 改名 / 被 Gatekeeper translocate 之後,venv/bin/python* 是斷掉的連結,
    // venv 模組撞到會直接報錯(實測)。先清掉斷的,site-packages 留著,重建只要幾秒。
    const vbin = path.join(BASE, "venv", "bin");
    for (const n of fs.existsSync(vbin) ? fs.readdirSync(vbin) : []) {
      const f = path.join(vbin, n);
      if (fs.lstatSync(f).isSymbolicLink() && !fs.existsSync(f)) fs.unlinkSync(f);
    }
    await sh(`"${basePython()}" -m venv "${path.join(BASE, "venv")}"`, envPath);
  }
  // 記號檔而不是「venv 在就當裝好了」:pip 中途失敗(斷網)時 venv 已經在,下次啟動要重試。
  const sdkMark = path.join(BASE, "venv", ".blave-sdk");
  if (!fs.existsSync(sdkMark) || fs.readFileSync(sdkMark, "utf8") !== AGENT_SDK) {
    progress("engine.preparing");
    await sh(`"${VENV_PY}" -m pip -q install ${AGENT_SDK}`, envPath, 600000);
    fs.writeFileSync(sdkMark, AGENT_SDK);
  }
  // workspace 的 lib/ 與 manager/ 要的第三方套件(從它們的 import 列出來的)。原本只裝
  // SDK:agent 能聊天、能寫策略,一回測就炸(「Python 環境缺少 pandas」,實測)。
  // 用一個記號檔而不是每次都問 pip——pip 光是確認「都裝了」也要好幾秒。
  // 記號檔比內容:app 更新後清單變了(多一個套件、換版本)要重裝,只看檔案在不在會永遠跳過(稽核 S8)
  const depsMark = path.join(BASE, "venv", ".blave-deps-1");
  let depsHave = ""; try { depsHave = fs.readFileSync(depsMark, "utf8"); } catch (_) { /* 還沒裝過 */ }
  if (depsHave !== WORKSPACE_DEPS.join("\n")) {
    progress("engine.deps");
    await sh(`"${VENV_PY}" -m pip -q install ${WORKSPACE_DEPS.join(" ")}`, envPath, 900000);
    fs.writeFileSync(depsMark, WORKSPACE_DEPS.join("\n"));
  }
}

// 這份清單是**列舉出來的**,不是憑印象:用 AST 掃 lib/ manager/ examples/ 與兩支策略
// 模板(75 個檔)的頂層 import,扣掉標準庫與 workspace 自己的模組,再逐一實際 import。
// 第一版憑 grep 少了 python-dotenv(lib/runner.py 第一行就要它)與 scipy。
// 刻意不裝:shioaji(永豐下單 SDK,有綁該券商的人才需要)、comtypes / pythoncom
// (群益的 COM 介面,只有 Windows 有)。
// 釘版本:打包版在實機裝到、並跑過一輪回測的那組(隨包 CPython 3.12、arm64)。升版要重跑那輪驗證。
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
    const m = new RegExp(`^${k}\\s*=\\s*(["'])(.*?)\\1\\s*$`, "m").exec(code || "");
    return m && m[2].trim() ? m[2].trim().slice(0, 200) : null;
  };
  return { displayName: pick("DISPLAY_NAME"), description: pick("DESCRIPTION") };
}

function listStrategies() {
  return stratNames().map((name) => {
    const dir = path.join(STRAT_DIR(), name);
    const statsPath = path.join(dir, "stats.json");
    let mtime = 0;
    try { mtime = fs.statSync(path.join(dir, "strategy.py")).mtimeMs; } catch (_) {}
    let sMtime = 0;
    try { sMtime = fs.statSync(statsPath).mtimeMs; } catch (_) {}
    const hit = stratCache.get(name);
    if (hit && hit.mtime === sMtime && hit.cMtime === mtime) return { ...hit.summary, mtime: Math.max(mtime, sMtime) };
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
    return { ...summary, mtime: Math.max(mtime, sMtime) };
  }).sort((a, b) => b.mtime - a.mtime);      // 最近動過的在上面
}

function loadStrategy(name) {
  if (!stratNames().includes(name)) return null;
  const dir = path.join(STRAT_DIR(), name);
  let stats = null, code = "";
  try { stats = JSON.parse(fs.readFileSync(path.join(dir, "stats.json"), "utf8")); } catch (_) {}
  try { code = fs.readFileSync(path.join(dir, "strategy.py"), "utf8"); } catch (_) {}
  return { name, stats, code, ...stratMeta(code) };
}

// 刪策略 = 整個資料夾丟進系統的垃圾桶(shell.trashItem),不是 rm:裡面有用戶的程式碼
// 與回測結果,誤刪要救得回來。回合進行中不給刪——agent 可能正在寫那個資料夾。
async function deleteStrategy(name) {
  if (activeTurn || !stratNames().includes(name)) return false;
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
/* 帳號能不能用 Blave 的 AI(綁卡流程用)。回 api 的 account_status 原樣,或 null(沒 token / 打不到 /
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
async function publicPricing() {
  if (pubCache && Date.now() - pubCache.at < 3600000) return pubCache.body;
  try {
    const r = await getJSON(`${API_BASE}/openclaw/public_tiers`, {});
    const b = r.status === 200 && r.body && (r.body.data || r.body);
    if (!(b && b.trial && Number(b.trial.days) > 0)) return null;
    const st = (Array.isArray(b.linux) ? b.linux : []).find((x) => x && x.label === "Starter");
    const hr = st && Number(st.twd_per_hour) > 0 ? Number(st.twd_per_hour) : null;
    const body = { trial: b.trial, starter_hourly: hr, starter_monthly: hr ? Math.round(hr * 720) : null };
    pubCache = { at: Date.now(), body };
    return body;
  } catch (_) { return null; }
}
/* 這個帳號現在含不含 Blave 資料(試用中 / 名下有主機 / API 方案)。畫面的預檢與回前景重查
   都會打 account_status,這裡吃它最後一次的結果;太舊(或還沒打過)才自己補打一次——這支跟
   LLM 共用每分鐘 30 次的桶,不能每一輪都打。查不到就當沒有:寧可這一輪少資料,也不要把 key
   寫給一個已經不含資料的帳號(伺服器那邊對不含資料的桌面 key 本來就回 403)。 */
let lastAcct = null;
const ACCT_FRESH_MS = 5 * 60 * 1000;
async function dataIncluded() {
  const fresh = () => lastAcct && Date.now() - lastAcct.at <= ACCT_FRESH_MS;
  if (!fresh()) await accountStatus();
  return !!(fresh() && lastAcct.body.data_included === true);   // 補打失敗就是查不到:舊答案不沿用
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
      env: { PATH: path.join(BASE, "venv", "bin") + path.delimiter + (process.env.PATH || "/usr/bin:/bin"), HOME: os.homedir(),
        USER: process.env.USER || os.userInfo().username, LANG: process.env.LANG || "en_US.UTF-8",
        TMPDIR: process.env.TMPDIR || os.tmpdir(), BLAVE_KLINE_SOURCE: "binance",
        BLAVE_AGENT_HOME: BASE, BLAVE_AGENT_STATE: path.join(BASE, "state"),
        ...PY_ENV },   // 打包版不讓 Python 把 __pycache__ 寫進 .app(簽章後 bundle 一變 codesign --verify 就不過)
      log: (m) => console.error("[trade]", m),
    });
  }
  return _tradeHost;
}
function tradeStartIfReady() {
  try { if (fs.existsSync(VENV_PY) && fs.existsSync(WS)) tradeHost().start(); } catch (e) { console.error("[trade] start failed", e && e.message); }
}
async function runTurn(win, { sessionId, message, model: rawModel, effort: rawEffort }) {
  const model = safeId(rawModel), effort = safeId(rawEffort);
  // 這個值會進命令列、SQL 參數與圖檔目錄名,只認外殼自己發的格式
  if (!okSessionId(sessionId)) throw new Error("bad session id");
  imgWin = win;
  const envPath = await loginShellPath();
  // 用戶連的是哪一個,引擎就跑哪一個。原本這裡完全不看 kind,一律 spawn Claude
  // 那條路——選了 Codex 的人第一句話就失敗(引擎去找 `claude`)。
  const conn = loadConnection() || {};
  const useCodex = conn.kind === "codex" && conn.path;
  // 本機模式契約(runtime CHANGELOG Unreleased):不帶 BLAVE_PROXY_TOKEN、
  // 不帶 ANTHROPIC_*;PATH/HOME 必帶(GUI app 的 PATH 極簡)。
  // **看連的是誰,不是看手上有沒有 token**:登入過 Blave、後來改連自己的 Claude Code 的人,
  // token 還在 Keychain 裡——照「有 token 就帶」會讓他以為在用自己的訂閱、實際上燒 Blave 額度
  // 資料則相反——**看有沒有登入,不看連的是誰**:登入 Blave 是帳號的事,資料 key 是另一把縮權的 key
  // (不能呼叫 LLM、不產生 usage_blave),給自帶 CLI 的人不會燒到他的 AI 額度。
  const useBlave = conn.kind === "blave";
  const signedIn = !!loadToken();
  const acct = useBlave ? loadToken() : null;
  const dataAccess = syncDataEnv(signedIn && await dataIncluded());
  const env = {
    // venv/bin 放最前面:Claude Code 的 Bash 直接繼承這個 PATH,`python3` 就是我們的。
    // 但這對 Codex 無效——它用登入 shell(`zsh -lc`)跑指令,profile 會把 PATH 重排
    // (實測:前置的路徑被擠到 Homebrew 後面)。所以另外給 BLAVE_PYTHON,runtime 會把
    // 「這個 workspace 的 python 是哪一顆」明寫進 prompt——環境變數不會被重排。
    PATH: path.join(BASE, "venv", "bin") + path.delimiter + envPath, HOME: os.homedir(),
    BLAVE_PYTHON: VENV_PY,
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
    // runtime 依這個在 prompt 裡明講「這台有/沒有 Blave 資料」(變數不存在 = 雲端機,行為不變)
    // 用戶自己放的完整 key:不設這個變數,runtime 不加那段——「桌面 key 只能讀策略庫」對它不成立
    ...(dataAccess === "own" ? {} : { BLAVE_DATA_ACCESS: dataAccess === "ours" ? "1" : "0" }),
    // 聊天裡的圖:見上面「聊天裡的圖」。接收端還沒起來(port 0)就不帶,notify 那邊會 no-op
    ...(imgPort ? { BLAVE_WEB_REPORT_URL: `http://127.0.0.1:${imgPort}/chat-image`,
                    BLAVE_WEB_REPORT_TOKEN: imgToken, BLAVE_WEB_SESSION: sessionId } : {}),
    LANG: process.env.LANG || "zh_TW.UTF-8",
    ...PY_ENV,
  };
  const child = spawn(VENV_PY, [
    path.join(REPO, "runtime", "agent_turn.py"),
    sessionId, message, "--delivery", "local",
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
    ...(useCodex ? ["--engine", "codex", "--codex-bin", conn.path] : []),
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

/* 這個視窗只顯示我們自己的 index.html,永遠不該被導去別的地方。頁面裡有第三方畫的
   連結(K 線圖左下角的 TradingView 標誌是 lightweight-charts 依授權放的 <a>),沒有
   這兩道的話,點它會在 app 裡開一個沒有 preload 隔離設定的新視窗、或把整個 app 導走。
   https 的交給系統瀏覽器開,其餘一律擋。 */
function guardNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    // 自己重載自己要放行:「重新登入」那顆鈕用的是 location.reload()
    if (url.split("#")[0] === win.webContents.getURL().split("#")[0]) return;
    e.preventDefault();
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1024, minHeight: 680,
    titleBarStyle: "hiddenInset",
    // 燈的中心對到 44px 標題帶的中線(= 對話列中心 y=22)
    trafficLightPosition: { x: 12, y: 15 },
    // Electron 讀不到 CSS 變數,所以這裡鏡射 `--color-darkBody`(tokens.css)。
    // 改那顆就要改這裡。原本寫 #10151c —— H≈215,正是 canon › 色溫 點名要避開的
    // Tailwind slate 地帶,開窗與 resize 的瞬間看得到。
    backgroundColor: "#0f161a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  guardNavigation(win);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  startImageServer();
  ipcMain.handle("detect-agents", () => detectAgents());
  ipcMain.handle("save-connection", (_e, choice) => saveConnection(choice));
  ipcMain.handle("load-connection", () => loadConnection());
  ipcMain.handle("open-external", (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle("ensure-engine", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    // 引擎裝好(或本來就在)之後才起本機常駐程式
    return ensureEngine((t) => win.webContents.send("engine-progress", t)).then((r) => { tradeStartIfReady(); return r; });
  });
  // app.getLocale() 是**系統**語系(macOS 偏好設定),不吃 LANG 環境變數。
  // BLAVE_LANG 是覆蓋用的:開發要看英文版、或用戶的系統是中文但想用英文介面。
  ipcMain.handle("get-locale", () => process.env.BLAVE_LANG || app.getLocale());
  ipcMain.handle("delete-strategy", (_e, name) => deleteStrategy(String(name || "")));
  ipcMain.handle("list-sessions", () => listSessions());
  ipcMain.handle("load-session-images", (_e, id) => loadSessionImages(id));
  ipcMain.handle("load-session", (_e, id) => loadSession(id));
  ipcMain.handle("delete-session", (_e, id) => deleteSession(id));
  ipcMain.handle("list-strategies", () => listStrategies());
  ipcMain.handle("load-strategy", (_e, name) => loadStrategy(String(name || "")));
  ipcMain.handle("model-options", (_e, kind) => modelOptions(kind));
  ipcMain.handle("account-status", () => accountStatus());
  ipcMain.handle("public-pricing", () => publicPricing());
  // 花錢的動作只收自家畫面發的:renderer 會渲染 LLM 的文字,萬一有別的 frame 被帶進來,它不能替用戶開機
  // 只認我們自己那一頁的主 frame:花錢(plan-start)與動交易(trade-send)的 IPC 共用這道
  const fromOurPage = (e) => {
    // 比「解出來的檔案路徑」而不是比字串:安裝路徑含 & + , = @ 時 encodeURIComponent 拼出來的 URL 跟
    // Chromium 給的不相等,會連 halt 都被拒(稽核 S7)
    let file = null;
    try { const u = new URL((e.senderFrame && e.senderFrame.url) || ""); if (u.protocol === "file:") file = require("url").fileURLToPath(u.href.split(/[?#]/)[0]); } catch (_) { /* 不是我們的頁 */ }
    return file === path.join(__dirname, "renderer", "index.html") && e.senderFrame === e.sender.mainFrame;
  };
  ipcMain.handle("plan-start", (e) => (fromOurPage(e) ? planStart() : { error: "SERVER" }));
  /* 本機交易:狀態是唯讀的檔案內容;指令由 daemon.js 簽章後寫進佇列(secret 不出主行程)。
     daemon 在引擎裝好之後才起(它要 workspace 與 venv),而且**不會自己啟動對帳器**——要用戶按「啟動下單」。 */
  ipcMain.handle("trade-status", () => tradeHost().status());
  ipcMain.handle("trade-events", (_e, q) => tradeHost().events({ days: q && Number(q.days) }));
  ipcMain.handle("trade-equity", (_e, q) => tradeHost().equity({ days: q && Number(q.days) }));
  ipcMain.handle("trade-send", (e, cmd, args) => {
    if (!fromOurPage(e) || typeof cmd !== "string") return { ok: false, error: "NOT_ALLOWED" };
    const out = tradeHost().send(cmd, args && typeof args === "object" ? args : {});
    if (cmd === "resume" || cmd === "resume_wait") Promise.resolve(out).then((r) => {
      if (!r || !r.ok) return;
      const v = (_tradeHost && _tradeHost.status().report || {}).venues || {}, ids = Object.keys(v).filter((k) => venueReady(v[k]));
      if (ids.length) tm().track("trade_started", { venue_kind: ids.every((k) => k === "paper") ? "paper" : "real" });
    }).catch(() => {});
    return out;
  });
  // 告知畫面顯示過才開始送(稽核 M2'):在那之前 start()/track() 一則都不出門。由 renderer 在告知真的畫出來之後叫這支
  ipcMain.handle("telemetry-noticed", (e) => { if (!fromOurPage(e)) return false; tm().setNoticed(); return true; });
  ipcMain.handle("update-state", () => updater().state());
  ipcMain.handle("update-check", (e) => (fromOurPage(e) ? updater().check() : false));
  ipcMain.handle("update-install", (e) => (fromOurPage(e) ? updater().install() : { ok: false, error: "NOT_ALLOWED" }));
  ipcMain.handle("telemetry-get", () => tm().isEnabled());
  ipcMain.handle("telemetry-set", (e, on) => { if (!fromOurPage(e)) return false; tm().setEnabled(on === true); return tm().isEnabled(); });
  ipcMain.handle("load-model-prefs", () => loadModelPrefs());
  ipcMain.handle("save-model-prefs", (_e, prefs) => saveModelPrefs(prefs));
  ipcMain.handle("start-oauth", (_e, lang) => startOAuth(lang));
  ipcMain.handle("cancel-oauth", () => cancelOAuth());
  ipcMain.handle("clear-connection", () => clearConnection());
  ipcMain.handle("has-blave-token", () => !!loadToken());
  ipcMain.handle("sign-out-blave", () => signOutBlave());
  ipcMain.handle("agent-login", (_e, kind) => agentLogin(String(kind || "")));
  ipcMain.handle("cancel-agent-login", () => cancelAgentLogin());
  ipcMain.handle("send-message", (e, payload) => {
    if (activeTurn || turnStarting) return { busy: true };
    const win = BrowserWindow.fromWebContents(e.sender);
    // runTurn 要先 await 登入 shell 的 PATH 與 account_status 才 spawn;這段期間 activeTurn 還是 null,
    // 不另外立旗標的話連按兩下會 spawn 兩顆 agent 搶同一個 session.db
    turnStarting = true;
    runTurn(win, payload).catch((err) => {
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
  app.on("browser-window-focus", () => { lastAcct = null; p1Badge = 0; if (app.dock) app.dock.setBadge(""); });
  app.on("activate", () => showMain());   // 點 Dock:視窗被紅燈收起來的話把它叫回來
  trayStart();
  tm().start();
  updater().start();
  ipcMain.on("trade-labels", (e, labels) => {
    if (!fromOurPage(e) || !labels || typeof labels !== "object") return;
    for (const k of Object.keys(tmLabels)) if (typeof labels[k] === "string" && labels[k] && labels[k].length <= 400) tmLabels[k] = labels[k];
    traySync();
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
let tray = null, trayTimer = null, quitConfirmed = false, quitAsking = false, hiddenSaid = false, lastVenue = null, trayKey = "";
let tmLabels = { running: "Auto trading is running", paperVenue: "Paper trading", pause: "Pause trading (keep positions)", open: "Open Blave", quit: "Quit Blave…",
  notifTitle: "Trading paused", notifBody: "Positions were not touched.", pauseFail: "The pause command didn’t go through. Trading may still be running.",
  pauseUnknown: "The pause command was sent, but this computer hasn’t reported the result yet. Check the status on this page.",
  quitTitle: "Auto trading is still running", quitBody: "After you quit Blave, this computer stops placing orders. Positions are not closed.", quitGo: "Quit Blave", quitStay: "Cancel",
  hidden: "Blave is still running in the menu bar.",
  ev_halt: "Trading was paused automatically", ev_halt_n: "No new positions are opened. Open Blave to check.",
  ev_order_error: "Order failed", ev_order_error_n: "The exchange rejected an order. Open Blave to check.",
  ev_execution_interrupted: "Last execution was interrupted", ev_execution_interrupted_n: "A fill may be missing from the ledger. Check positions before restarting.",
  ev_execution_fallback_market: "Switched to a market order", ev_execution_fallback_market_n: "The configured order style could not run; the fill price may differ.",
  ev_execution_stuck: "Execution is stuck", ev_execution_stuck_n: "Later orders for this symbol are waiting on it.",
  ev_downtime_paused: "Trading was paused automatically", ev_downtime_paused_n: "Everything is frozen after the downtime. Press Start trading to resume." };
const venueReady = (v) => !!(v && v.credentials && v.pair && v.order && v.account);   // 同 renderer:四個都在才算連上的帳戶
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
const venueName = (id) => (!id ? "" : id === "paper" ? tmLabels.paperVenue : id.charAt(0).toUpperCase() + id.slice(1));
function showMain() {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) { createWindow(); return; }
  if (w.isMinimized()) w.restore(); w.show(); w.focus();
}
async function pauseFromMenu() {
  let r = null;
  try { r = await tradeHost().send("halt", { reason: "menu bar" }); } catch (_) { /* 當成沒送到 */ }
  traySync();
  if (r && r.ok) { if (Notification.isSupported()) new Notification({ title: tmLabels.notifTitle, body: tmLabels.notifBody }).show(); return; }
  // 沒成功不能只靠系統通知(權限關掉 / 專注模式會被吞):把視窗叫出來、掛一個框講清楚(稽核 M1)
  showMain();
  dialog.showMessageBox(BrowserWindow.getAllWindows()[0] || undefined, { type: "warning", message: tmLabels.pause,
    detail: r && r.error === "UNKNOWN_RESULT" ? tmLabels.pauseUnknown : tmLabels.pauseFail, buttons: ["OK"] });
}
function trayMenu(live) {
  return Menu.buildFromTemplate([
    { label: tmLabels.running, enabled: false },
    { label: venueName(live.venue), enabled: false },   // 模擬帳戶的名字本身就寫著「模擬交易」,不再疊一個「模擬」記號
    { type: "separator" },
    { label: tmLabels.pause, click: pauseFromMenu },
    { type: "separator" },
    { label: tmLabels.open, click: showMain },
    { label: tmLabels.quit, click: () => app.quit() },
  ]);
}
function traySync() {
  const live = tradeLive();
  if (live) lastVenue = live.venue;
  const key = live ? live.venue + "|" + tmLabels.running + "|" + tmLabels.pause : "";
  if (key === trayKey) return;   // 每 5 秒叫一次:沒變就不重建選單
  trayKey = key;
  if (!live) {
    if (tray) { tray.destroy(); tray = null; }
    if (app.dock) app.dock.setMenu(Menu.buildFromTemplate([]));
    return;
  }
  if (!tray) {
    const img = nativeImage.createFromPath(path.join(__dirname, "assets", "trayTemplate.png"));   // 檔名結尾 Template = macOS 自動依選單列明暗上色
    if (img.isEmpty()) console.error("tray icon missing: shell/assets/trayTemplate.png");   // 空圖 = 看不見的圖示;選單還在,但要留下痕跡(稽核 M4)
    tray = new Tray(img);
  }
  tray.setToolTip(tmLabels.running);
  tray.setContextMenu(trayMenu(live));
  if (app.dock) app.dock.setMenu(Menu.buildFromTemplate([{ label: tmLabels.pause, click: pauseFromMenu }]));
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
const P1_TYPES = ["halt", "order_error", "execution_interrupted", "execution_fallback_market", "execution_stuck", "downtime_paused"];   // 全部六型(標籤用)
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
    const n = new Notification({ title: tmLabels["ev_" + e.type] + (sym ? " · " + sym : ""), body: tmLabels["ev_" + e.type + "_n"] });
    p1Alive.add(n); const drop = () => p1Alive.delete(n);
    n.on("click", () => { drop(); showMain(); }); n.on("close", drop); n.on("failed", drop);
    if (p1Alive.size > 20) p1Alive.delete(p1Alive.values().next().value);
    n.show();
  }
  if (show.length && app.dock) { if (!BrowserWindow.getFocusedWindow()) app.dock.setBadge(String(p1Badge)); else p1Badge = 0; }
}
function trayStart() { if (!trayTimer) { trayTimer = setInterval(() => { traySync(); p1Sync(); }, 5000); if (trayTimer.unref) trayTimer.unref(); } }
app.on("browser-window-created", (_e, win) => {
  win.on("close", (e) => {
    if (quitting || quitConfirmed || !tradeMaybeLive()) return;
    e.preventDefault(); win.hide();
    if (!hiddenSaid && tmLabels.hidden && Notification.isSupported()) { hiddenSaid = true; new Notification({ title: tmLabels.running, body: tmLabels.hidden }).show(); }
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
      detail: tmLabels.quitBody.replace("{venue}", () => venueName(live.venue)), buttons: [tmLabels.quitStay, tmLabels.quitGo], defaultId: 0, cancelId: 0 })
      .then((r) => { quitAsking = false; if (r.response === 1) { quitConfirmed = true; app.quit(); } }, () => { quitAsking = false; });
    return;
  }
  if (quitting || !_tradeHost || !_tradeHost.isRunning()) return;
  e.preventDefault(); quitting = true;
  _tradeHost.stop().finally(() => app.quit());
});
