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
  // workspace 的 lib/ 與 manager/ 要的第三方套件(從它們的 import 列出來的)。原本只裝
  // SDK:agent 能聊天、能寫策略,一回測就炸(「Python 環境缺少 pandas」,實測)。
  // 用一個記號檔而不是每次都問 pip——pip 光是確認「都裝了」也要好幾秒。
  const depsMark = path.join(BASE, "venv", ".blave-deps-1");
  if (!fs.existsSync(depsMark)) {
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
const WORKSPACE_DEPS = [
  "pandas", "numpy", "matplotlib", "pyarrow", "requests", "python-dotenv", "scipy",
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
const SESSION_DB = path.join(os.homedir(), "Blave", "state", "session.db");
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
const IMG_DIR = path.join(os.homedir(), "Blave", "state", "chat-images");
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

let activeTurn = null;
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
  const acct = loadToken();
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
    // 聊天裡的圖:見上面「聊天裡的圖」。接收端還沒起來(port 0)就不帶,notify 那邊會 no-op
    ...(imgPort ? { BLAVE_WEB_REPORT_URL: `http://127.0.0.1:${imgPort}/chat-image`,
                    BLAVE_WEB_REPORT_TOKEN: imgToken, BLAVE_WEB_SESSION: sessionId } : {}),
    LANG: process.env.LANG || "zh_TW.UTF-8",
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
    return ensureEngine((t) => win.webContents.send("engine-progress", t));
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
  ipcMain.handle("load-model-prefs", () => loadModelPrefs());
  ipcMain.handle("save-model-prefs", (_e, prefs) => saveModelPrefs(prefs));
  ipcMain.handle("start-oauth", (_e, lang) => startOAuth(lang));
  ipcMain.handle("cancel-oauth", () => cancelOAuth());
  ipcMain.handle("clear-connection", () => clearConnection());
  ipcMain.handle("has-blave-token", () => !!loadToken());
  ipcMain.handle("clear-blave-token", () => { clearToken(); return true; });
  ipcMain.handle("sign-out-blave", () => signOutBlave());
  ipcMain.handle("agent-login", (_e, kind) => agentLogin(String(kind || "")));
  ipcMain.handle("cancel-agent-login", () => cancelAgentLogin());
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
