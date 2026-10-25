// 本機 AI「偵測說已登入、送出說沒登入」(0.1.32;spec desktop-claude-env-auth §2、§4.1):偵測與替用戶登入給 CLI 的憑證環境與設定來源,
// 要跟 agent 回合一致。回合在 Windows 被 childEnv 拔掉 ANTHROPIC_* / CLAUDE_* / OPENAI_* / CODEX_*、在 Mac 不在白名單裡;
// SDK 帶 --setting-sources=,CLI 不讀 ~/.claude/settings.json。對照組(整份環境、讀設定檔)說已登入時,那一列多一句出路(authOutside)。
// 主行程那半用 main.js 原文 + 真的子行程跑假的 bin(假 HOME、假 PATH;不碰真的 claude / codex、不讀任何憑證檔)。
// 跑法:node tests/check_shell_claude_env_auth.js
const fs = require("fs"), path = require("path"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
const src = fs.readFileSync(path.join(SHELL, "main.js"), "utf8"), app = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
const STR = eval(fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8") + ";STRINGS");
let red = 0; const t = (n, ok, info) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || info === undefined ? "" : "  " + JSON.stringify(info))); if (!ok) red++; };
const grab = (s, re, name) => { const m = s.match(re); if (!m) { t("main.js 裡找得到 " + name, false); return ""; } return m[0]; };
const fnOf = (s, name) => grab(s, new RegExp("^(?:async )?function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n\\}", "m"), name);
const constOf = (s, name) => grab(s, new RegExp("^const " + name + " = .*$", "m"), name);

// ── 1、2. probeEnv(純函式,平台與來源環境都注入):兩個平台都拔掉 WIN_ENV_DROP 那組,帳號相關的系統變數留著 ──
const DROP = constOf(src, "WIN_ENV_DROP"), PE = fnOf(src, "probeEnv");
const { probeEnv, WIN_ENV_DROP } = DROP && PE ? new Function(DROP + "\n" + PE + "\nreturn { probeEnv, WIN_ENV_DROP };")() : {};
if (probeEnv) {
  const SECRET = { ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_BASE_URL: "http://x", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "x", CLAUDE_CONFIG_DIR: "/x",
    OPENAI_API_KEY: "sk-x", OPENAI_FEDERATION_RULE_ID: "r", OPENAI_IDENTITY_TOKEN_FILE: "/f", CODEX_ACCESS_TOKEN: "x", CODEX_HOME: "/c", BLAVE_HOME: "/b", NODE_OPTIONS: "--inspect" };
  const mac = { USER: "u", LOGNAME: "u", HOME: "/Users/u", TMPDIR: "/t", SHELL: "/bin/zsh", PATH: "/usr/bin", ...SECRET };
  const win = { USERPROFILE: "C:\\Users\\u", HOME: "D:\\gitbash-home", USERNAME: "u", SystemRoot: "C:\\WINDOWS", APPDATA: "C:\\Users\\u\\AppData\\Roaming", Path: "C:\\WINDOWS", ...SECRET };
  for (const [plat, penv] of [["darwin", mac], ["linux", mac], ["win32", win]]) {
    const e = probeEnv("/fake/path", plat, penv), left = Object.keys(e).filter((k) => WIN_ENV_DROP.test(k));
    t(plat + ":WIN_ENV_DROP 那組一個都不剩 → " + (left.join(",") || "無"), left.length === 0 && Object.keys(SECRET).every((k) => !(k in e)));
    t(plat + ":PATH 換成登入 shell 那份、只有一個 PATH key、DISABLE_AUTOUPDATER=1", e.PATH === "/fake/path" && Object.keys(e).filter((k) => k.toUpperCase() === "PATH").length === 1 && e.DISABLE_AUTOUPDATER === "1");
  }
  const em = probeEnv("/p", "darwin", mac), ew = probeEnv("/p", "win32", win);
  // Mac 的 claude 讀 Keychain 要 USER(少了回 Not logged in):不能拿 childEnv(白名單原樣回)當偵測環境
  t("darwin:USER / LOGNAME / HOME / TMPDIR 原樣留著(Keychain 登入的人不會被判成沒登入)", ["USER", "LOGNAME", "HOME", "TMPDIR"].every((k) => em[k] === mac[k]));
  t("win32:USERPROFILE / USERNAME / SystemRoot / APPDATA 留著,HOME 對映到 USERPROFILE(同 childEnv)", ["USERPROFILE", "USERNAME", "SystemRoot", "APPDATA"].every((k) => ew[k] === win[k]) && ew.HOME === win.USERPROFILE);
  t("win32:沒有 USERPROFILE 時不造一個 HOME", probeEnv("/p", "win32", { HOME: "D:\\h" }).HOME === "D:\\h");
  t("不動傳進來的物件", (() => { const j = JSON.stringify(mac); probeEnv("/p", "darwin", mac); return JSON.stringify(mac) === j; })());
}

// ── 3、4. 原文:組環境的兩處(run、登入的 spawn)不再展開 process.env;claude 的偵測帶 --setting-sources=,排在 auth 前面 ──
const RUN = fnOf(src, "run"), LOGIN = fnOf(src, "agentLogin"), DETECT = fnOf(src, "detectAgents");
t("run():不展開 process.env,預設走 probeEnv(envPath)", !!RUN && !/\.\.\.process\.env/.test(RUN) && /env: env \|\| probeEnv\(envPath\)/.test(RUN));
t("agentLogin 的 spawn:不展開 process.env,走 probeEnv(envPath)", !!LOGIN && !/\.\.\.process\.env/.test(LOGIN) && /env: probeEnv\(envPath\)/.test(LOGIN));
{ const m = DETECT.match(/probe\("claude", [^\n]*?, (\[[^\]]*\]), (\[[^\]]*\])\)/), argv = m ? JSON.parse(m[1]) : [];
  t("claude 偵測的 argv:--setting-sources= 在 auth 前面(放後面是 unknown option)", argv.indexOf("--setting-sources=") === 0 && argv.indexOf("auth") === 1 && argv[2] === "status", argv);
  t("auth login 不加 --setting-sources=(登入寫的是憑證)", /\["auth", "login"\]/.test(LOGIN) && !/setting-sources/.test(LOGIN)); }
// 對照組是唯一帶整份環境的呼叫:結果只進 authOutside(布林),不改 loggedIn / why
{ const full = [...DETECT.matchAll(/\.\.\.process\.env/g)].length, rawLines = DETECT.split("\n").filter((l) => /\braw\b/.test(l));
  t("detectAgents:整份環境只出現在對照組那一支 run(帶第 6 個參數)", full === 1 && /const rawP = run\(bin, rawArgs, envPath, LOGIN_CHECK_MS, undefined, \{ \.\.\.process\.env, PATH: envPath, DISABLE_AUTOUPDATER: "1" \}\);/.test(DETECT));
  t("…對照組的結果只寫進 authOutside", rawLines.every((l) => !/\.(loggedIn|why|authMethod|email) = /.test(l)) && (DETECT.match(/authOutside = /g) || []).length === 2); }

// ── 字串與畫面接線:兩列各自的訊息槽(連結畫面 small.msg 的 sub、設定 › 模型接入的 .m 說明) ──
t("字串 row.keyOff 兩語都有、只帶 {acct}(列名已寫 Claude Code／Codex,不再帶 {name});不叫人去「API 金鑰」那一列填自己的金鑰", ["zh", "en"].every((l) => STR[l]["row.keyOff"] && /\{acct\}/.test(STR[l]["row.keyOff"]) && !/\{name\}/.test(STR[l]["row.keyOff"]))
  && !/API 金鑰|API key/i.test(STR.zh["row.keyOff"] + STR.en["row.keyOff"]));
// 設定 › 模型接入的 .m 固定一行(app.css .cn-opt .m),欄寬約 368–376px;超過就把出路「登入 {acct}」切掉。
// 0.1.32 Mac 實量(12px 系統字):zh「…金鑰或登入…」ChatGPT 331/376;en「…other sign-in…」ChatGPT 324/368,
// en 加 key or 是 362/368,Windows 字型沒量,不用。字數是寬度的代理:改字超過這兩條就要重量。
const zhLen = (x) => (x.match(/[\u4e00-\u9fff]|[A-Za-z0-9]+/g) || []).length;
t("zh 代入 ChatGPT ≤20 字(漢字一字、英數詞一字、標點不算)", zhLen(STR.zh["row.keyOff"].replace("{acct}", "ChatGPT")) <= 20, zhLen(STR.zh["row.keyOff"].replace("{acct}", "ChatGPT")));
t("en 代入 ChatGPT ≤58 字元", STR.en["row.keyOff"].replace("{acct}", "ChatGPT").length <= 58, STR.en["row.keyOff"].replace("{acct}", "ChatGPT").length);
t("連結畫面:沒登入那一列的 sub 先給等待／失敗句,沒有才給 row.keyOff", /sub: msg \? rowMsg\(kind, msg\) : x\.authOutside \? t\("row\.keyOff", rowVars\(kind, name\)\) : null,/.test(app));
t("{acct}:Codex → ChatGPT、Claude Code → Claude", /const rowVars = \(kind, name\) => \(\{ name, acct: kind === "codex" \? "ChatGPT" : "Claude" \}\);/.test(app));

// ── 真的子行程:假 claude / codex 只看環境變數、假 HOME 的記號檔與 --setting-sources= ──
const POSIX = process.platform !== "win32";
const PIECES = [constOf(src, "cmdWrap"), DROP, PE, RUN, fnOf(src, "which"), "const LOGIN_CHECK_MS = 3000;", fnOf(src, "binKind"), constOf(src, "runRec"), constOf(src, "cantRun"),
  fnOf(src, "detectWhy"), grab(src, /^const BAD_BIN = .*$/m, "BAD_BIN"), fnOf(src, "codexPath"), fnOf(src, "claudePath"), DETECT, "let loginChild = null;", LOGIN].join("\n");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "blave-env-auth-"));
const HOME = path.join(ROOT, "home"); fs.mkdirSync(path.join(HOME, ".claude"), { recursive: true });
const BIN = path.join(ROOT, "bin"); fs.mkdirSync(BIN);
// 假的 claude:有 ANTHROPIC_API_KEY 或 CLAUDE_CODE_OAUTH_TOKEN、或沒帶 --setting-sources= 而 settings.json 有記號 → 已登入;oauth 記號檔永遠算(OAuth 不受影響)
fs.writeFileSync(path.join(BIN, "claude"), `#!/bin/sh
flag=0; for a in "$@"; do [ "$a" = "--setting-sources=" ] && flag=1; done
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then env | grep -E '^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_)' > "$HOME/login-env"; : > "$HOME/login-ran"; exit 0; fi
if [ -f "$HOME/oauth" ] || [ -n "$ANTHROPIC_API_KEY" ] || [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || { [ $flag = 0 ] && grep -q FAKEKEY "$HOME/.claude/settings.json" 2>/dev/null; }; then
  echo '{"loggedIn":true,"authMethod":"api_key"}'; else echo '{"loggedIn":false,"authMethod":"none"}'; fi
exit 0
`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, "codex"), `#!/bin/sh
if [ "$1" = "login" ] && [ "$2" = "status" ]; then { [ -f "$HOME/signed" ] || [ -n "$CODEX_ACCESS_TOKEN" ] || [ -n "$OPENAI_FEDERATION_RULE_ID" ]; } && exit 0; exit 1; fi
exit 2
`, { mode: 0o755 });
const mk = () => new Function("execFile", "spawn", "fs", "path", "process", "loginShellPath", "CODEX_IN_CHATGPT", "bundledClaude", "BASE", "WIN", "detectLogWrite",
  "winRealExe", "storeCodexPath", "winOnPath", "pickWinBin", PIECES + "\nreturn { detectAgents, agentLogin };")(
  require("child_process").execFile, require("child_process").spawn, fs, path, process, async () => BIN + ":/usr/bin:/bin", path.join(ROOT, "nope"), () => null, "/b", false, () => {},
  (b) => b, async () => null, (s) => s, () => null);
const VARS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_ACCESS_TOKEN", "OPENAI_FEDERATION_RULE_ID", "OPENAI_API_KEY"];
const saved = Object.fromEntries(["HOME", ...VARS].map((k) => [k, process.env[k]]));
const setEnv = (o) => { for (const k of VARS) delete process.env[k]; Object.assign(process.env, o); };
const reset = () => { for (const f of ["oauth", "signed", "login-env", "login-ran", ".claude/settings.json"]) fs.rmSync(path.join(HOME, f), { force: true }); setEnv({}); };

(async () => {
  if (!POSIX || !RUN || !DETECT) console.log("SKIP  假 bin 是 sh 腳本(Windows 只跑上面的純函式與原文檢查)");
  else {
    process.env.HOME = HOME;   // 這支測試行程自己的環境:假 bin 只看得到假 HOME
    try {
      const m = mk(), shape = (x) => [x.loggedIn, x.authOutside].join("/");
      reset(); setEnv({ ANTHROPIC_API_KEY: "sk-ant-fake" });
      let d = await m.detectAgents();
      t("根因 A:環境變數 ANTHROPIC_API_KEY → Claude Code 沒登入(回合看不到)、authOutside", shape(d.claude) === "false/true", d.claude);
      reset(); setEnv({ CLAUDE_CODE_OAUTH_TOKEN: "x" });
      d = await m.detectAgents(); t("根因 A:CLAUDE_CODE_OAUTH_TOKEN 同上", shape(d.claude) === "false/true", d.claude);
      reset(); fs.writeFileSync(path.join(HOME, ".claude", "settings.json"), '{"env":{"ANTHROPIC_API_KEY":"FAKEKEY"}}');
      d = await m.detectAgents(); t("根因 B:settings.json 的金鑰 → 沒登入(--setting-sources= 不讀)、authOutside", shape(d.claude) === "false/true", d.claude);
      reset(); fs.writeFileSync(path.join(HOME, "oauth"), "");
      d = await m.detectAgents(); t("OAuth 登入(憑證檔)→ 仍已登入、沒有提示", shape(d.claude) === "true/false", d.claude);
      reset(); d = await m.detectAgents(); t("什麼都沒有 → 沒登入、沒有提示(只給〔登入〕)", shape(d.claude) === "false/false" && shape(d.codex) === "false/false", [d.claude, d.codex]);
      reset(); setEnv({ CODEX_ACCESS_TOKEN: "x" });
      d = await m.detectAgents(); t("Codex:CODEX_ACCESS_TOKEN → 沒登入、authOutside", shape(d.codex) === "false/true", d.codex);
      reset(); setEnv({ OPENAI_FEDERATION_RULE_ID: "r" });
      d = await m.detectAgents(); t("Codex:workload identity(OPENAI_FEDERATION_RULE_ID)同上", shape(d.codex) === "false/true", d.codex);
      reset(); setEnv({ OPENAI_API_KEY: "sk-x" });
      d = await m.detectAgents(); t("Codex:只有 OPENAI_API_KEY(login status 本來就不看)→ 沒登入、沒有提示", shape(d.codex) === "false/false", d.codex);
      reset(); fs.writeFileSync(path.join(HOME, "signed"), "");
      d = await m.detectAgents(); t("Codex:ChatGPT 帳號登入過 → 仍已登入", shape(d.codex) === "true/false", d.codex);
      reset(); setEnv({ ANTHROPIC_API_KEY: "sk-ant-fake", CODEX_ACCESS_TOKEN: "x" });
      const l = await m.agentLogin("claude");
      t("替用戶登入:claude auth login 的環境裡沒有 ANTHROPIC_ / CLAUDE_ / CODEX_ / OPENAI_", l.ok === true && fs.existsSync(path.join(HOME, "login-ran")) && fs.readFileSync(path.join(HOME, "login-env"), "utf8") === "", l);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
