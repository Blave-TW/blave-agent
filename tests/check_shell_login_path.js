// shell/main.js 的 mergePath:登入 shell 解析出的 PATH 後面一律補上已知安裝位置。
// 起因:zsh -lc 不讀 .zshrc,而 Claude Code 安裝器把 ~/.local/bin 寫在 .zshrc → 從 Finder 開 app 偵測不到 claude。
// win32(假造):不開登入 shell,直接吃 process.env 的 PATH(可能叫 Path)、用 ; 接、補 Windows 的已知位置;缺環境變數的那項不補。
// 跑法:node tests/check_shell_login_path.js
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
const m = src.match(/^const mergePath = .*$/m);
if (!m) { console.log("FAIL  找不到 mergePath"); process.exit(1); }
eval(m[0].replace(/^const /, "var "));
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
// 切 main.js 原文的起點:找不到就 FAIL 並結束(indexOf 回 -1 時 slice(-1) 只剩最後一個字元,斷言會靜默恆真)
const at = (needle) => { const i = src.indexOf(needle); if (i < 0) { console.log("FAIL  main.js 裡找不到 " + needle); process.exit(1); } return i; };
const K = ["/Users/x/.local/bin", "/opt/homebrew/bin", "/usr/bin"];
t("shell 漏掉的補在後面、順序以 shell 為先", mergePath(["/usr/bin", "/bin"], K) === "/usr/bin:/bin:/Users/x/.local/bin:/opt/homebrew/bin");
t("已經有的不重複", mergePath(["/Users/x/.local/bin", "/usr/bin"], K) === "/Users/x/.local/bin:/usr/bin:/opt/homebrew/bin");
t("shell 失敗(空)= 只剩已知位置", mergePath([], K) === K.join(":"));
t("空段不留", mergePath(["", "/bin"], K).split(":").every(Boolean));
t("loginShellPath 真的有用 mergePath", /resolvedPath = mergePath\(got, known\)/.test(src));
t("mergePath 的分隔符預設是 path.delimiter(darwin 仍是 :)", /const mergePath = \(got, known, sep = path\.delimiter\)/.test(src) && mergePath(["/a"], ["/b"]) === "/a" + path.delimiter + "/b");

// ── win32 ──
const w = src.match(/^function winPath\(env\) \{[\s\S]*?\n\}/m);
if (!w) { console.log("FAIL  找不到 winPath"); process.exit(1); }
eval(w[0]);
t("win32:用 ; 接", mergePath(["C:\\a"], ["C:\\b"], ";") === "C:\\a;C:\\b");
const E = { PATH: "C:\\WINDOWS\\system32;C:\\Users\\u\\.local\\bin", USERPROFILE: "C:\\Users\\u", APPDATA: "C:\\Users\\u\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", ProgramFiles: "C:\\Program Files" };
t("win32:process.env 的 PATH 在前、已知位置補在後(Claude 原生安裝器、npm 全域、WinGet Links、Git for Windows 兩種裝法)",
  winPath(E) === "C:\\WINDOWS\\system32;C:\\Users\\u\\.local\\bin;C:\\Users\\u\\AppData\\Roaming\\npm;C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links;C:\\Users\\u\\AppData\\Local\\Programs\\Git\\cmd;C:\\Program Files\\Git\\cmd");
t("win32:WinGet 的捷徑資料夾在 known 裡(winget install Anthropic.ClaudeCode 裝完、Blave 沒重開也找得到);缺 LOCALAPPDATA 就不補",
  winPath({ PATH: "C:\\x", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }).split(";").includes("C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links")
  && !winPath({ PATH: "C:\\x", USERPROFILE: "C:\\Users\\u" }).includes("WinGet"));
t("win32:環境變數叫 Path(Windows 常見的大小寫)也吃", winPath({ Path: "C:\\x", USERPROFILE: "C:\\Users\\u" }).startsWith("C:\\x;C:\\Users\\u\\.local\\bin"));
t("win32:缺的環境變數那一項不補(不留相對路徑)", winPath({ PATH: "C:\\x" }) === "C:\\x" && winPath({ PATH: "C:\\x", APPDATA: "C:\\r" }) === "C:\\x;C:\\r\\npm");
t("win32:PATH 空的也只剩已知位置、沒有空段", winPath({ USERPROFILE: "C:\\Users\\u" }) === "C:\\Users\\u\\.local\\bin");
t("loginShellPath 在 win32 走 winPath(process.env)、不開登入 shell", /if \(process\.platform === "win32"\) \{ resolvedPath = winPath\(process\.env\); return resolve\(resolvedPath\); \}/.test(src)
  && src.indexOf('process.platform === "win32") { resolvedPath = winPath') < src.indexOf('const sh = process.env.SHELL || "/bin/zsh"'));
// which:where.exe 的輸出優先拿 .exe
const pw = src.match(/^function pickWinBin\(stdout\) \{[\s\S]*?\n\}/m);
if (!pw) { console.log("FAIL  找不到 pickWinBin"); process.exit(1); }
eval(pw[0]);
t("pickWinBin:where 列出 .cmd 與 .exe 時拿 .exe(原生安裝器),只有 .cmd 時拿 .cmd,空的 null",
  pickWinBin("C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd\r\nC:\\Users\\u\\.local\\bin\\claude.exe\r\n") === "C:\\Users\\u\\.local\\bin\\claude.exe"
  && pickWinBin("C:\\r\\npm\\codex.cmd\r\n") === "C:\\r\\npm\\codex.cmd" && pickWinBin("") === null);
// 測試機實測(Codex 0.160.0 用 npm i -g、Node 24、npm 11):where.exe 第一行是 npm 的無副檔名 sh 包裝檔,平台套件巢狀裝在 @openai/codex 底下
const WHERE_REAL = "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\codex\r\nC:\\Users\\Administrator\\AppData\\Roaming\\npm\\codex.cmd\r\n";
const realCmd = "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\codex.cmd";
t("pickWinBin:where 第一行是無副檔名的 sh 包裝檔 → 跳過、拿 codex.cmd", pickWinBin(WHERE_REAL) === realCmd);
t("pickWinBin:只有無副檔名那一行 → null(交給 execFile 只會 ENOENT、被誤判成未登入)", pickWinBin("C:\\r\\npm\\codex\r\n") === null);
t("pickWinBin:claude 三種都在(sh / .cmd / .exe)→ 仍拿 .exe;只有 sh + .cmd → .cmd;.bat 也算",
  pickWinBin("C:\\r\\npm\\claude\r\nC:\\r\\npm\\claude.cmd\r\nC:\\Users\\u\\.local\\bin\\claude.exe\r\n") === "C:\\Users\\u\\.local\\bin\\claude.exe"
  && pickWinBin("C:\\r\\npm\\claude\r\nC:\\r\\npm\\claude.cmd\r\n") === "C:\\r\\npm\\claude.cmd" && pickWinBin("C:\\r\\x\r\nC:\\r\\x.bat\r\n") === "C:\\r\\x.bat");
// where.exe 先搜目前工作目錄(稽核 P2-1):cwd 釘 System32,結果只留上層目錄在 envPath 裡的
const wk = src.match(/^const winDirKey = .*$/m), wo = src.match(/^function winOnPath\(stdout, envPath\) \{[\s\S]*?\n\}/m);
if (!wk || !wo) { console.log("FAIL  找不到 winDirKey / winOnPath"); process.exit(1); }
eval(wk[0].replace(/^const /, "var ")); eval(wo[0]);
const EP = "C:\\WINDOWS\\system32;\"C:\\Program Files\\nodejs\";C:\\Users\\u\\AppData\\Roaming\\npm\\;C:\\Users\\u\\.local\\bin";
t("winOnPath:cwd 裡的 codex.exe(不在 envPath)被濾掉,PATH 裡的 .cmd 留下 → pickWinBin 拿 .cmd 不拿 cwd 那顆",
  pickWinBin(winOnPath("C:\\Users\\u\\Downloads\\codex.exe\r\nC:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd\r\n", EP)) === "C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd");
t("winOnPath:大小寫不同、PATH 項尾端反斜線、引號包住都算在 envPath 內",
  winOnPath("c:\\users\\U\\APPDATA\\roaming\\npm\\codex.cmd\r\nC:\\Program Files\\nodejs\\claude.exe\r\nC:\\Users\\u\\.local\\bin\\claude.exe", EP).split("\r\n").length === 3);
t("winOnPath:envPath 的子目錄、上層目錄都不算", winOnPath("C:\\Users\\u\\.local\\bin\\x\\codex.exe\r\nC:\\Users\\u\\codex.exe", EP) === "");
t("winOnPath:全被濾掉 → pickWinBin null(當沒裝,不退回 cwd 那顆)", pickWinBin(winOnPath("D:\\evil\\claude.exe\r\n", EP)) === null);
t("which 在 win32:cwd 釘 System32、where 的輸出先過 winOnPath 才 pickWinBin;run 把 cwd 交給 execFile",
  /run\(path\.win32\.join\(sys32, "where\.exe"\), \[name\], envPath, 5000, sys32\)/.test(src) && /pickWinBin\(winOnPath\(r\.stdout, envPath\)\)/.test(src)
  && /function run\(cmd, args, envPath, timeout = 10000, cwd = undefined, env = undefined\)/.test(src) && /execFile\(w\.file, w\.args, \{ timeout, cwd,/.test(src));
t("which 在 win32 用 System32\\where.exe;run 只對 .cmd/.bat 開 shell", /const sys32 = path\.win32\.join\(process\.env\.SystemRoot \|\| "C:\\\\Windows", "System32"\)/.test(src) && /const cmdWrap = \(bin, args\) => \(process\.platform === "win32" && \/\\\.\(cmd\|bat\)\$\/i\.test\(bin\)/.test(src));
// ── 偵測紀錄 + 登入檢查上限(0.1.15):紀錄只有檔種/回傳碼/逾時/耗時/登入與否,不帶路徑與 CLI 輸出 ──
const bk = src.match(/^function binKind\(p\) \{[\s\S]*?\n\}/m), rr = src.match(/^const runRec = .*$/m), dl = src.match(/^function detectLogWrite\(f, entry\) \{[\s\S]*?\n\}/m),
  dm = src.match(/^const DETECT_LOG_MAX = .*$/m), rn = src.match(/^function run\(cmd, args, envPath, timeout = 10000, cwd = undefined, env = undefined\) \{[\s\S]*?\n\}/m), cw = src.match(/^const cmdWrap = .*$/m);
if (!bk || !rr || !dl || !dm || !rn || !cw) { console.log("FAIL  找不到 binKind / runRec / detectLogWrite / DETECT_LOG_MAX / run / cmdWrap"); process.exit(1); }
eval(bk[0]); eval(rr[0].replace(/^const /, "var ")); eval(dm[0].replace(/^const /, "var ")); eval(dl[0]); eval(cw[0].replace(/^const /, "var ")); eval(rn[0]);
eval(src.match(/^const WIN_ENV_DROP = .*$/m)[0].replace(/^const /, "var ")); eval(src.match(/^function probeEnv\([^)]*\) \{[\s\S]*?\n\}/m)[0]);   // run 的環境走 probeEnv
var wsfile = require(path.join(__dirname, "..", "shell", "wsfile.js")), { execFile } = require("child_process"), os = require("os");
t("binKind:exe / cmd / bat / ps1 / 無副檔名 shim / 一般 POSIX / 沒有;ChatGPT 內附、Store 版不再是獨立檔種",
  binKind("C:\\u\\.local\\bin\\claude.exe") === "exe" && binKind("C:\\r\\npm\\codex.cmd") === "cmd" && binKind("C:\\r\\x.BAT") === "cmd" && binKind("C:\\r\\npm\\codex.ps1") === "ps1"
  && binKind("C:\\Users\\u\\AppData\\Roaming\\npm\\codex") === "shim" && binKind("/Applications/ChatGPT.app/Contents/Resources/codex") === "posix"
  && binKind("C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe") === "exe"
  && binKind("/opt/homebrew/bin/codex") === "posix" && binKind(null) === "none" && binKind("") === "none");
const dwS = src.match(/^function detectWhy\(kind, r\) \{[\s\S]*?\n\}/m);
if (!dwS) { console.log("FAIL  找不到 detectWhy"); process.exit(1); }
const crS = src.match(/^const cantRun = .*$/m);
if (!crS) { console.log("FAIL  找不到 cantRun"); process.exit(1); }
eval(crS[0].replace(/^const /, "var "));
{ eval(dwS[0]);
  t("detectWhy:codex 沒有隨包那顆一律 codex_none,PATH 上有沒有 shim 不算數(0.1.41 起 codex_shim 不再發生);claude 同樣不看 where",
    detectWhy("codex", { bin: "none", where: ["shim", "cmd"], loggedIn: false }) === "codex_none" && detectWhy("codex", { bin: "none", loggedIn: false }) === "codex_none"
    && detectWhy("claude", { bin: "none", where: ["shim"], loggedIn: false }) === "claude_none"
    && detectWhy("codex", { bin: "pkg", code: 0, loggedIn: true }) === null && detectWhy("codex", { bin: "pkg", code: 1, timedOut: false, loggedIn: false }) === "codex_nonzero"); }
// 偵測鏈拆掉之後不准長回來:OpenAI 每換一次裝法這裡就慢一版,而退路本身就是卡住用戶的地方(uid 33959)
{ const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  t("main.js 非註解行不再出現偵測鏈的任何字:WindowsApps／Get-AppxPackage／ChatGPT.app／codex.cmd", !/WindowsApps|Get-AppxPackage|ChatGPT\.app|codex\.cmd/.test(code)); }
t("偵測鏈的符號都不在了", !/\b(CODEX_IN_CHATGPT|CODEX_WIN_EXE|winRealExe|CODEX_STORE_FAMILY|CODEX_STORE_PS|pickStoreCodex|storeCodex|storeCodexPath|codexPath)\b/.test(src));
t("四處都走隨包那顆:偵測的 find 只叫 codexBundled、codexBinNow 只回它;agentLogin／saveConnection 拿偵測回的 path",
  /probe\("codex", \(seen\) => codexBundled\(!seen\), \["login", "status"\], \["login", "status"\]\)/.test(src)
  && /async function codexBinNow\(\) \{ return codexBundled\(true\); \}/.test(src)
  && /kind === "codex" \? d\.codex\.path : null;/.test(src) && /agentPath = \(d\[kind\] \|\| \{\}\)\.path \|\| null;/.test(src));
// ── Claude 的退路:PATH 上沒有 claude 就用 SDK 隨包那顆(venv/.../claude_agent_sdk/_bundled/claude),對話本來就是它在跑 ──
const bc = src.match(/^function bundledClaude\(base, win, fsx = fs\) \{[\s\S]*?\n\}/m), cpc = src.match(/^async function claudePath\(envPath, seen\) \{[\s\S]*?\n\}/m);
if (!bc || !cpc) { console.log("FAIL  找不到 bundledClaude / claudePath"); process.exit(1); }
const MAC_B = "/Users/u/Blave/venv/lib/python3.14/site-packages/claude_agent_sdk/_bundled/claude", WIN_B = "C:\\Users\\u\\Blave\\venv\\Lib\\site-packages\\claude_agent_sdk\\_bundled\\claude.exe";
t("binKind:隨包那顆是 bundled(Mac / Windows、大小寫不拘);PATH 上的 claude / claude.exe、別的資料夾裡同名的仍是 posix / exe",
  binKind(MAC_B) === "bundled" && binKind(WIN_B) === "bundled" && binKind(WIN_B.toUpperCase()) === "bundled"
  && binKind("/opt/homebrew/bin/claude") === "posix" && binKind("C:\\Users\\u\\.local\\bin\\claude.exe") === "exe" && binKind("/Users/u/Blave/venv/bin/claude") === "posix");
{ const mkB = (p) => new Function("path", "fs", bc[0] + "\nreturn bundledClaude;")(p, {});
  const fsx = (dirs, files) => ({ readdirSync: (d) => { if (!(d in dirs)) throw new Error("ENOENT"); return dirs[d]; }, existsSync: (p) => files.includes(p) });
  const macB = mkB(path.posix), winB = mkB(path.win32);
  t("bundledClaude(darwin):列 venv/lib 找 python3.x(版本不寫死)、接 site-packages/claude_agent_sdk/_bundled/claude;檔在才回",
    macB("/Users/u/Blave", false, fsx({ "/Users/u/Blave/venv/lib": ["python3.14", "python3.14-config"] }, [MAC_B])) === MAC_B
    && macB("/Users/u/Blave", false, fsx({ "/Users/u/Blave/venv/lib": ["python3.12"] }, ["/Users/u/Blave/venv/lib/python3.12/site-packages/claude_agent_sdk/_bundled/claude"])) === "/Users/u/Blave/venv/lib/python3.12/site-packages/claude_agent_sdk/_bundled/claude");
  t("bundledClaude(darwin):venv 還沒建(lib 不在)/ 建了但 SDK 還沒裝 / lib 裡沒有 python3.x → null,不拋",
    macB("/Users/u/Blave", false, fsx({}, [MAC_B])) === null && macB("/Users/u/Blave", false, fsx({ "/Users/u/Blave/venv/lib": ["python3.14"] }, [])) === null
    && macB("/Users/u/Blave", false, fsx({ "/Users/u/Blave/venv/lib": ["site-packages"] }, [MAC_B])) === null);
  t("bundledClaude(win32):venv\\Lib\\site-packages\\…\\claude.exe,不列目錄;檔不在 → null",
    winB("C:\\Users\\u\\Blave", true, fsx({}, [WIN_B])) === WIN_B && winB("C:\\Users\\u\\Blave", true, fsx({}, [])) === null);
  // claudePath 原文配假的 which / bundledClaude:PATH 優先、隨包是退路、兩個都沒有 → null
  const mkC = (whichRet, bundled) => new Function("which", "binKind", "bundledClaude", "BASE", "WIN", "BAD_BIN", cpc[0] + "\nreturn claudePath;")(async () => whichRet, binKind, () => bundled, "/b", false, { claude: null });
  var claudeFlow = (async () => {
    const seen = {};
    t("claudePath:PATH 上有 → 用它,不用隨包;seen.found 是 PATH 那顆的檔種", await mkC("/opt/homebrew/bin/claude", MAC_B)("/p", seen) === "/opt/homebrew/bin/claude" && seen.found === "posix");
    const seen2 = {};
    t("claudePath:PATH 沒有、隨包在 → 隨包那顆;seen.found 仍是 none(PATH 上沒有)", await mkC(null, MAC_B)("/p", seen2) === MAC_B && seen2.found === "none");
    t("claudePath:兩個都沒有 → null", await mkC(null, null)("/p", {}) === null);
    const b = binKind(await mkC(null, MAC_B)("/p")), n = binKind(await mkC(null, null)("/p")), dW = new Function(crS[0] + "\n" + dwS[0] + "; return detectWhy;")();
    t("…接 detectWhy:隨包那顆登入了 → null;隨包那顆沒登入 → claude_nonzero;兩個都沒有 → claude_none(埋點值不變,只有 detect.log 的 bin 分得出 bundled)",
      b === "bundled" && dW("claude", { bin: b, code: 0, loggedIn: true }) === null && dW("claude", { bin: b, code: 0, timedOut: false, loggedIn: false }) === "claude_nonzero"
      && n === "none" && dW("claude", { bin: n, loggedIn: false }) === "claude_none");
  })(); }
t("detectAgents 走 claudePath(不直接 which);claudePath 退路用 BASE / WIN 的 venv;agentLogin 拿的是 detectAgents 回的同一個 path(隨包那顆也能按登入)",
  /probe\("claude", \(seen\) => claudePath\(envPath, seen\), \["--setting-sources=", "auth", "status"\], \["auth", "status"\]\)/.test(src) && !/which\("claude"/.test(src.slice(at("async function detectAgentsRaw() {")))
  && /return \(found && \(seen \|\| found !== BAD_BIN\.claude\) \? found : null\) \|\| bundledClaude\(BASE, WIN\);/.test(cpc[0]) && /bin = kind === "claude" \? d\.claude\.path : kind === "codex" \? d\.codex\.path : null;/.test(src));
t("runRec 只取 code / timedOut / ms(stdout 有 email,不進紀錄)", JSON.stringify(runRec({ code: 1, timedOut: false, ms: 9, stdout: "{\"email\":\"a@b\"}", stderr: "x" })) === '{"code":1,"timedOut":false,"ms":9}');
const LOGF = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "blave-detect-")), "state", "detect.log");
detectLogWrite(LOGF, { n: 0 });
t("detectLogWrite:state 資料夾不在也建、一行一筆 JSON", fs.readFileSync(LOGF, "utf8") === '{"n":0}\n');
for (let i = 1; i <= 400; i++) detectLogWrite(LOGF, { n: i, pad: "x".repeat(300) });
{ const lines = fs.readFileSync(LOGF, "utf8").split("\n").filter(Boolean);
  // 超過 DETECT_LOG_MAX 才收成最近 DETECT_LOG_KEEP 行,所以行數在 KEEP 到「MAX 塞得下的行數」之間
  t("detectLogWrite:超過大小上限就收成最近 " + DETECT_LOG_KEEP + " 行(最後一筆在、最舊的不在),檔不會一直長",
    fs.statSync(LOGF).size <= DETECT_LOG_MAX + 400 && lines.length >= DETECT_LOG_KEEP && lines.length < 400 && JSON.parse(lines[lines.length - 1]).n === 400 && !lines.some((l) => JSON.parse(l).n < 100), lines.length); }
t("detectLogWrite:寫不進去(路徑是檔案)不拋", (() => { try { detectLogWrite(path.join(LOGF, "x", "y.log"), { n: 1 }); return true; } catch (_) { return false; } })());
t("detectAgents:兩條登入檢查都帶 LOGIN_CHECK_MS(20 秒),run 預設仍 10 秒、which 仍 5 秒",
  /^const LOGIN_CHECK_MS = 20000;$/m.test(src) && /probe\("claude", [^\n]*\["--setting-sources=", "auth", "status"\], \["auth", "status"\]\)/.test(src) && /probe\("codex", [^\n]*\["login", "status"\], \["login", "status"\]\)/.test(src)
  && (src.match(/run\((?:bin|alt), args, envPath, LOGIN_CHECK_MS\)/g) || []).length === 2
  && (src.match(/envPath, 5000/g) || []).length === 2);
{ const body = src.slice(at("async function detectAgentsRaw() {"), src.indexOf("\n}\n", at("async function detectAgentsRaw() {")));
  t("detectAgents:每次寫一行紀錄到 BASE/state/detect.log;紀錄物件只經 runRec / binKind / loggedIn 填,沒有 path、email、stdout",
    /detectLogWrite\(path\.join\(BASE, "state", "detect\.log"\), \{ ts: new Date\(\)\.toISOString\(\), os: process\.platform, \.\.\.rec \}\)/.test(body)
    && !/rec\.\w+\.(path|email|stdout|stderr)\b/.test(body)
    && [...body.matchAll(/rec\.\w+\.(\w+) = /g)].map((m) => m[1]).every((k) => ["bin", "json", "loggedIn", "alt", "outside", "cred"].includes(k))
    && [...body.matchAll(/Object\.assign\(rec\.\w+, (\w+)\(/g)].every((m) => m[1] === "runRec")); }
{ const w = src.slice(src.indexOf("async function which(name, envPath, seen) {"), src.indexOf("async function codexBinNow()"));
  t("which / claudePath 往 seen 寫的只有 where(檔種清單)/ whereTimedOut / found(檔種)", [...w.matchAll(/seen\.(\w+) = /g)].map((m) => m[1]).every((k) => ["where", "whereTimedOut", "whereCode", "found"].includes(k))
    && /seen\.where = r\.code === 0 \? winOnPath\(r\.stdout, envPath\)\.split\(\/\\r\?\\n\/\)\.filter\(Boolean\)\.map\(binKind\)/.test(w) && /seen\.found = binKind\(found\)/.test(w)); }
(async () => {
  await claudeFlow;
  // spawn 對 EPERM 這類錯誤是同步 throw(uid 33959):登入 shell 開不起來也要拿到已知位置,不能 reject
  { const ls = src.match(/^function loginShellPath\(\) \{[\s\S]*?\n\}/m);
    const f = new Function("execFile", "path", "os", "process", "mergePath", "winPath", "let resolvedPath = null;\n" + ls[0] + "\nreturn loginShellPath;")(
      () => { throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" }); }, path, os, { platform: "darwin", env: {} }, mergePath, () => "");
    const p = await f().catch((e) => "REJECT " + e.code);
    t("loginShellPath:execFile 同步 throw → 不 reject,回已知位置", /\/opt\/homebrew\/bin/.test(p) && !/^REJECT/.test(p), p);
    const rr = await run("/x/codex", [], "/usr/bin", 1000).then((r) => r, (e) => "REJECT " + e.code);
    t("run:正常路徑不受 try 影響(找不到檔仍是 ENOENT)、syscall 只留動作名,路徑不進紀錄", rr.code === "ENOENT" && rr.syscall === "spawn" && JSON.stringify(runRec(rr)).indexOf("/x/codex") < 0, rr);
    t("cantRun:EPERM、UNKNOWN(非 PE 檔)算跑不起來;逾時後殺不掉的 EPERM + timedOut 不算", cantRun({ code: "EPERM", timedOut: false }) && cantRun({ code: "EPERM" }) && cantRun({ code: "UNKNOWN" }) && !cantRun({ code: "EPERM", timedOut: true }) && !cantRun({ code: 1 })); }
  const slow = await run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], process.env.PATH, 150);
  t("run:逾時 → timedOut=true、ms ≥ 上限(以前只看得到 code,分不出逾時)", slow.timedOut === true && slow.ms >= 150 && slow.ms < 4000, slow);
  const bad = await run(process.execPath, ["-e", "process.exit(3)"], process.env.PATH, 5000);
  t("run:非 0 結束 → code=3、timedOut=false", bad.code === 3 && bad.timedOut === false && bad.ms >= 0);
  const none = await run(path.join(os.tmpdir(), "no-such-bin-" + process.pid), [], process.env.PATH, 5000);
  t("run:執行檔不在 → code=ENOENT、timedOut=false", none.code === "ENOENT" && none.timedOut === false);
  const good = await run(process.execPath, ["-e", "process.stdout.write('ok')"], process.env.PATH, 5000);
  t("run:正常 → code=0、stdout 照舊", good.code === 0 && good.stdout === "ok" && good.timedOut === false);
  // 兩條登入檢查同時跑:detectAgents 原文配假的 which / run(各 300ms),整次要遠小於 600ms;依序跑就會 ≥ 600
  { const da = src.match(/^async function detectAgentsRaw\(\) \{[\s\S]*?\n\}/m), dw = src.match(/^function detectWhy\(kind, r\) \{[\s\S]*?\n\}/m);
    if (!da || !dw) t("找得到 detectAgentsRaw / detectWhy", false);
    else { const runs = [], logged = [];
      const mkDetect = new Function("loginShellPath", "claudePath", "run", "binKind", "runRec", "detectLogWrite", "BASE", "path", "LOGIN_CHECK_MS", "process", "codexBundled", "codexCredOk", "codexHome",
        crS[0] + "\nconst BAD_BIN = {}; let codexRan = null, lastDetected = null;\n" + dw[0] + "\n" + da[0] + "\nreturn detectAgentsRaw;");
      const slow = (v) => new Promise((r) => setTimeout(() => r(v), 300));
      const detect = mkDetect(async () => "/usr/bin", async () => "/opt/claude",
        (bin, args, envPath, ms, cwd, env) => { if (!env) runs.push([bin, ms, Date.now()]); return slow(bin.endsWith("claude") ? { code: 0, stdout: '{"loggedIn":true}', timedOut: false, ms: 300 } : { code: null, stdout: "", timedOut: true, ms: 300 }); },
        binKind, runRec, (f, e) => logged.push(e), "/b", path, 20000, { platform: "darwin" }, () => "/opt/codex", () => false, () => "/h");
      const t0 = Date.now(), d = await detect(), took = Date.now() - t0;
      t("detectAgents:claude 與 codex 的登入檢查同時開跑(兩條各 300ms,整次 < 500ms;依序會 ≥ 600)、各帶 20 秒上限", took < 500 && runs.length === 2 && Math.abs(runs[0][2] - runs[1][2]) < 100 && runs.every((r) => r[1] === 20000), { took, runs });
      t("…結果照舊組回去:claude 登入、codex 逾時 → why=codex_timeout;紀錄一行", d.claude.loggedIn === true && d.claude.why === null && d.codex.installed && d.codex.loggedIn === false && d.codex.why === "codex_timeout"
        && logged.length === 1 && logged[0].codex.timedOut === true && logged[0].claude.loggedIn === true); } }
  // 偵測跑的可能是 SDK 隨包那顆 claude:不帶 DISABLE_AUTOUPDATER 它會在背景抓 330MB 新版
  const envOut = await run(process.execPath, ["-e", "process.stdout.write(String(process.env.DISABLE_AUTOUPDATER))"], process.env.PATH, 5000);
  t("run:子行程的 env 帶 DISABLE_AUTOUPDATER=1", envOut.code === 0 && envOut.stdout === "1", envOut);
  { const al = src.match(/^async function agentLogin\(kind, onSpawn\) \{[\s\S]*?\n\}/m);
    t("agentLogin:spawn 的 env 也帶 DISABLE_AUTOUPDATER=1(登入用的也可能是隨包那顆)", !!al && /spawn\([\s\S]*?env: probeEnv\(envPath\), stdio/.test(al[0])); }
  // claude auth status 跑不起來(退出碼非 0、沒有輸出)不是「回的不是 JSON」:只有退出碼 0 才記 json=false
  { const da = src.match(/^async function detectAgentsRaw\(\) \{[\s\S]*?\n\}/m), dw = src.match(/^function detectWhy\(kind, r\) \{[\s\S]*?\n\}/m);
    if (!da || !dw) { t("找得到 detectAgentsRaw / detectWhy", false); process.exit(1); }
    const mk = new Function("loginShellPath", "claudePath", "run", "binKind", "runRec", "detectLogWrite", "BASE", "path", "LOGIN_CHECK_MS", "process", "codexBundled", "codexCredOk", "codexHome", crS[0] + "\nconst BAD_BIN = {}; let codexRan = null, lastDetected = null;\n" + dw[0] + "\n" + da[0] + "\nreturn detectAgentsRaw;");
    const once = async (claudeRes) => { const logged = [];
      const d = await mk(async () => "/usr/bin", async () => "/opt/claude", async () => ({ timedOut: false, ms: 1, ...claudeRes }), binKind, runRec, (f, e) => logged.push(e), "/b", path, 20000, { platform: "darwin" }, () => null, () => false, () => "/h")();
      return { why: d.claude.why, json: logged[0].claude.json }; };
    const dead = await once({ code: 1, stdout: "" }), old = await once({ code: 0, stdout: "usage: claude" }), sig = await once({ code: "ENOENT", stdout: "" });
    t("detectAgents:claude 退出碼非 0、stdout 空 → claude_nonzero,不記 json=false;開不起來(ENOENT)→ claude_cantrun(不是沒登入)", dead.why === "claude_nonzero" && dead.json === undefined && sig.why === "claude_cantrun" && sig.json === undefined, { dead, sig });
    t("detectAgents:claude 退出碼 0 但回的不是 JSON(舊版)→ 仍是 claude_badjson", old.why === "claude_badjson" && old.json === false, old); }
  // ── Codex 只有隨包那一顆(codex-bundled-only §2):沒有偵測鏈、沒有退路 ──
  { const da = src.match(/^async function detectAgentsRaw\(\) \{[\s\S]*?\n\}/m), dw = src.match(/^function detectWhy\(kind, r\) \{[\s\S]*?\n\}/m);
    const cb = src.match(/^function codexBundled\(skipBad\) \{[\s\S]*?\n\}/m), cbn = src.match(/^async function codexBinNow\(\) \{.*\}$/m), bb = src.match(/^const BAD_BIN = .*$/m);
    if (!da || !dw || !cb || !cbn || !bb) { t("找得到 detectAgentsRaw／codexBundled／codexBinNow／BAD_BIN", false); process.exit(1); }
    const PKG_BIN = "/Users/u/Blave/codex/0.166.0/bin/codex";
    const mkAll = (o) => { const calls = [], ran = [], logged = [];
      const api = new Function("loginShellPath", "claudePath", "run", "binKind", "runRec", "detectLogWrite", "BASE", "path", "LOGIN_CHECK_MS", "process", "codexpkg", "CODEX_PIN", "TRIPLE", "WIN", "fs", "codexCredOk", "codexHome",
        crS[0] + "\n" + bb[0] + "\nlet codexRan = null, lastDetected = null;\n" + dw[0] + "\n" + cb[0] + "\n" + cbn[0] + "\n" + da[0] + "\nreturn { detectAgentsRaw, codexBinNow, codexBundled, BAD_BIN };")(
        async () => "/usr/bin", async () => null,
        async (bin, args) => { ran.push(bin); return { code: o.codes[bin] !== undefined ? o.codes[bin] : 0, stdout: "", timedOut: false, ms: 1 }; }, binKind, runRec, (f, e) => logged.push(e), "/b", path, 20000, { platform: "darwin" },
        { installed: (base, pin, triple, win, fsx) => { calls.push([base, pin, triple, win, fsx === "FS"].join(",")); return o.pkg ? { path: o.pkg, version: pin, pinned: true } : null; } }, "0.166.0", "aarch64-apple-darwin", false, "FS", () => !!o.cred, () => "/h");
      api.calls = calls; api.ran = ran; api.logged = logged; api.codes = o.codes; return api; };
    let m = mkAll({ pkg: PKG_BIN, codes: {} }), d = await m.detectAgentsRaw();
    t("隨包那顆在:偵測用它、via=pkg、detect.log bin=pkg;codexpkg.installed 帶 BASE／CODEX_PIN／TRIPLE／WIN／fs",
      d.codex.path === PKG_BIN && d.codex.via === "pkg" && d.codex.loggedIn && d.codex.why === null && m.logged[0].codex.bin === "pkg" && m.calls.includes("/b,0.166.0,aarch64-apple-darwin,false,true"), { d: d.codex, calls: m.calls });
    t("…detect.log 的 codex 那行沒有 where／found／alt 鍵", !["where", "found", "alt"].some((k) => k in m.logged[0].codex), m.logged[0].codex);
    t("…codexBinNow(每一則訊息)拿同一顆", (await m.codexBinNow()) === PKG_BIN);
    m = mkAll({ pkg: PKG_BIN, codes: { [PKG_BIN]: 127 } }); d = await m.detectAgentsRaw();
    t("隨包那顆跑不起來(127):why=codex_cantrun、installed、via=pkg、path 還是它(畫面給〔再試一次〕);BAD_BIN.codex 記它;find(null) 回 null,不寫 alt、不試第二次",
      d.codex.installed && d.codex.why === "codex_cantrun" && d.codex.via === "pkg" && d.codex.path === PKG_BIN && !("alt" in m.logged[0].codex) && m.ran.filter((b) => b === PKG_BIN).length === 2
      && m.BAD_BIN.codex === PKG_BIN, { d: d.codex, rec: m.logged[0].codex, bad: m.BAD_BIN, ran: m.ran });
    t("…之後每一則訊息 codexBinNow 回 null(回合閘講 AGENT_BIN_BROKEN);codexBundled(false)(偵測)不跳過", (await m.codexBinNow()) === null && m.codexBundled(false) === PKG_BIN && m.codexBundled(true) === null);
    { const f = mkAll({ pkg: PKG_BIN, codes: { [PKG_BIN]: 127 } }); await f.detectAgentsRaw(); f.codes[PKG_BIN] = 0; const again = await f.detectAgentsRaw();
      t("…下一次偵測照樣重試它;重抓好了(回 0)→ BAD_BIN 清掉、每一則訊息又拿得到它", again.codex.loggedIn && f.BAD_BIN.codex === null && (await f.codexBinNow()) === PKG_BIN, again.codex); }
    m = mkAll({ pkg: null, codes: {} }); d = await m.detectAgentsRaw();
    t("隨包還沒抓:installed=false、via=null、path=null、why=codex_none、bin=none,沒有任何 codex 子行程",
      !d.codex.installed && d.codex.via === null && d.codex.path === null && d.codex.why === "codex_none" && m.logged[0].codex.bin === "none" && !m.ran.length, { d: d.codex, ran: m.ran });
    t("…codexBinNow 回 null(回合閘:抓的中途 DOWNLOADING、沒在抓 MISSING)", (await m.codexBinNow()) === null);
    m = mkAll({ pkg: PKG_BIN, codes: { [PKG_BIN]: 0 }, cred: true }); d = await m.detectAgentsRaw();
    t("憑證檔在、這次開 app 第一次偵測:照樣跑 login status(Windows 的 X_OK 只查存在,要真的跑起來過)", m.ran.includes(PKG_BIN) && d.codex.loggedIn && !m.logged[0].codex.cred, { ran: m.ran, rec: m.logged[0].codex });
    m.ran.length = 0; d = await m.detectAgentsRaw();
    t("…跑起來過之後才信憑證檔:已登入、why=null、via=pkg,完全不跑 CLI;detect.log cred=true、沒有 code", d.codex.loggedIn && d.codex.why === null && d.codex.via === "pkg" && d.codex.path === PKG_BIN && !m.ran.includes(PKG_BIN) && m.logged[1].codex.cred === true && !("code" in m.logged[1].codex), { d: d.codex, ran: m.ran, rec: m.logged[1].codex });
    m = mkAll({ pkg: PKG_BIN, codes: { [PKG_BIN]: "EPERM" }, cred: true }); d = await m.detectAgentsRaw(); const d2 = await m.detectAgentsRaw();
    t("憑證檔在、隨包被拒絕執行(EPERM):兩次偵測都是 codex_cantrun,不會畫成已登入;每一則訊息回 null(回合閘 BROKEN)", d.codex.why === "codex_cantrun" && d2.codex.why === "codex_cantrun" && !d2.codex.loggedIn && (await m.codexBinNow()) === null, { d: d.codex, d2: d2.codex });
    m = mkAll({ pkg: PKG_BIN, codes: { [PKG_BIN]: 1 } }); d = await m.detectAgentsRaw();
    t("憑證檔不在:不判未登入,往下跑 login status(Mac keyring 模式沒有檔)", m.ran.includes(PKG_BIN) && d.codex.why === "codex_nonzero", { d: d.codex, ran: m.ran });
    m = mkAll({ pkg: PKG_BIN, codes: { [PKG_BIN]: 127 }, cred: false }); await m.detectAgentsRaw(); m.ran.length = 0;
    const was = m.BAD_BIN.codex; d = await (async () => { m.codes[PKG_BIN] = 127; return m.detectAgentsRaw(); })();
    t("上次判跑不起來(BAD_BIN):不走憑證捷徑,照樣重試 CLI", was === PKG_BIN && m.ran.includes(PKG_BIN) && d.codex.why === "codex_cantrun", { was, d: d.codex }); }
  // 憑證檔判斷:假 home,只 stat
  { const cc = src.match(/^function codexCredOk\(bin, home, fsx = fs\) \{[\s\S]*?\n\}/m), hm = src.match(/^const codexHome = .*$/m);
    if (!cc || !hm) { t("找得到 codexCredOk／codexHome", false); process.exit(1); }
    const H = fs.mkdtempSync(path.join(os.tmpdir(), "blave-codexhome-")), BIN = path.join(H, "bin-codex"); fs.writeFileSync(BIN, "#!/bin/sh\n", { mode: 0o755 });
    const opened = [], fsx = { constants: fs.constants, accessSync: fs.accessSync, statSync: fs.statSync, readFileSync: () => { opened.push("read"); throw new Error("read"); }, openSync: () => { opened.push("open"); throw new Error("open"); } };
    const f = new Function("path", "fs", cc[0] + "\nreturn codexCredOk;")(path, fsx), ok = (home) => f(BIN, home, fsx);
    t("codexCredOk:沒有檔 → false", ok(H) === false);
    fs.writeFileSync(path.join(H, "auth.json"), "{}"); t("…auth.json 在 → true", ok(H) === true); fs.rmSync(path.join(H, "auth.json"));
    fs.mkdirSync(path.join(H, "secrets")); fs.writeFileSync(path.join(H, "secrets", "codex_auth.age"), "x"); t("…secrets/codex_auth.age 在 → true", ok(H) === true);
    fs.mkdirSync(path.join(H, "auth.json")); fs.rmSync(path.join(H, "secrets"), { recursive: true }); t("…auth.json 是資料夾 → false", ok(H) === false); fs.rmSync(path.join(H, "auth.json"), { recursive: true });
    fs.writeFileSync(path.join(H, "auth.json"), "{}");
    if (process.platform !== "win32") { fs.chmodSync(BIN, 0o000); t("…憑證在但執行檔不能執行 → false(交給 login status 判 cantrun)", ok(H) === false); fs.chmodSync(BIN, 0o755); }
    t("…全程沒開檔:沒叫 read／open,原始碼只有 accessSync／statSync", opened.length === 0 && !/readFile|openSync|createReadStream/.test(cc[0]), opened);
    const hf = (env) => new Function("process", "path", "os", hm[0] + "\nreturn codexHome();")({ env }, path, { homedir: () => "/u" });
    t("codexHome:只看 ~/.codex,CODEX_HOME 不算(回合與 login status 的環境都拔掉它)", hf({ CODEX_HOME: "/c" }) === path.join("/u", ".codex") && hf({}) === path.join("/u", ".codex"));
    fs.rmSync(H, { recursive: true, force: true }); }
  // ── 整次偵測的上限(codex-detect-gaps §3.4 D):任何一處 reject 或卡住,畫面都要拿到一份完整形狀、不再停在「偵測中…」 ──
  { const wrap = src.match(/^async function detectAgents\(ms = DETECT_TOTAL_MS\) \{[\s\S]*?\n\}/m), tot = src.match(/^const DETECT_TOTAL_MS = .*$/m);
    const outSrc = src.slice(at("async function detectAgentsRaw() {"), src.indexOf("const rec = {", at("async function detectAgentsRaw() {")));
    const keysOf = (k) => { const m = outSrc.match(new RegExp("\\b" + k + ": \\{([^}]*)\\}")); return m ? [...m[1].matchAll(/(\w+):/g)].map((x) => x[1]).sort().join() : null; };
    if (!wrap || !tot || !keysOf("claude") || !keysOf("codex")) { t("找得到 detectAgents 包裝、DETECT_TOTAL_MS 與 detectAgentsRaw 的結果形狀", false); }
    else {
      t("DETECT_TOTAL_MS = 2 ×(which 5 秒 + LOGIN_CHECK_MS)+ 10 秒 = 60 秒;which 的上限仍是 5 秒(改了這條要重算)",
        tot[0] === "const DETECT_TOTAL_MS = 2 * (5000 + LOGIN_CHECK_MS) + 10000;" && new Function("LOGIN_CHECK_MS", tot[0] + "\nreturn DETECT_TOTAL_MS;")(20000) === 60000
        && /"-c", `command -v \$\{name\}`\], envPath, 5000\)/.test(src));
      const mkW = (raw) => { const logged = [];
        const f = new Function("detectAgentsRaw", "detectLogWrite", "path", "BASE", "process", "const DETECT_TOTAL_MS = 50;\nlet detectShared = null;\n" + wrap[0] + "\nreturn detectAgents;")(raw, (fl, e) => logged.push([fl, e]), path, "/b", { platform: "darwin" });
        return { f, logged }; };
      const shapeOk = (d) => Object.keys(d.claude).sort().join() === keysOf("claude") && Object.keys(d.codex).sort().join() === keysOf("codex")
        && d.claude.installed === true && d.codex.installed === true && d.claude.path === null && d.codex.path === null && d.claude.loggedIn === false && d.codex.loggedIn === false
        && d.claude.why === "claude_timeout" && d.codex.why === "codex_timeout" && d.codex.via === null && d.claude.how === null && d.claude.authOutside === false && d.codex.authOutside === false;
      // 測試自己也掛一個 2 秒的錶:包裝沒有上限時這裡不會永遠等(事件迴圈空了 node 會靜默結束、結束碼 0)
      const hang = mkW(() => new Promise(() => {})), t0 = Date.now(), dh = await Promise.race([hang.f(), new Promise((r) => setTimeout(r, 2000, { claude: {}, codex: {} }))]), took = Date.now() - t0;
      t("detectAgents:raw 永不回 → 50 ms 上限內回來、形狀跟 detectAgentsRaw 同一組鍵、兩條 installed:true + *_timeout、path／via null",
        took < 500 && shapeOk(dh), { took, dh });
      t("…detect.log 多一行 hung:true、err:\"deadline\",只有 ts／os／hung／err(不記訊息、不記路徑)", hang.logged.length === 1 && hang.logged[0][0] === path.join("/b", "state", "detect.log")
        && hang.logged[0][1].hung === true && hang.logged[0][1].err === "deadline" && Object.keys(hang.logged[0][1]).sort().join() === "err,hung,os,ts", hang.logged);
      const rej = mkW(() => Promise.reject(Object.assign(new Error("secret /Users/u/x"), { code: "EPIPE" }))), dr = await rej.f();
      t("detectAgents:raw reject → 同一份形狀;err 記 e.code、不記訊息", shapeOk(dr) && rej.logged.length === 1 && rej.logged[0][1].err === "EPIPE" && !JSON.stringify(rej.logged).includes("secret"), rej.logged);
      const rej2 = mkW(() => Promise.reject(new TypeError("x"))), dr2 = await rej2.f();
      t("…沒有 code 時記 e.name", shapeOk(dr2) && rej2.logged[0][1].err === "TypeError", rej2.logged);
      const RAW0 = { claude: { installed: true, loggedIn: false }, codex: { installed: false } };
      { let n = 0; const hold = mkW(() => { n++; return new Promise(() => {}); });
        const [a1, a2] = await Promise.all([hold.f(), hold.f()]); const n1 = n;
        await hold.f(); const n2 = n;
        t("detectAgents:同時進來的兩次共用一輪 raw;那一輪跑超過上限後再叫,另開新的一輪(不被卡住的那輪拖住)",
          n1 === 1 && n2 === 2 && shapeOk(a1) && shapeOk(a2), { n1, n2 }); }
      { let n = 0, done; const sl = mkW(() => { n++; return new Promise((r) => { done = r; }); });
        const p1 = sl.f(); await new Promise((r) => setTimeout(r, 10)); const p2 = sl.f(); done(RAW0); const [b1, b2] = await Promise.all([p1, p2]);
        const p3 = sl.f(); done(RAW0); await p3;
        t("…上限內、上一輪還在跑時進來的共用它;那一輪結束後再叫是新的一輪", n === 2 && b1 === RAW0 && b2 === RAW0, { n }); }
      const RAW = { claude: { installed: true, loggedIn: true }, codex: { installed: false } }, okw = mkW(async () => RAW), dk = await okw.f();
      t("detectAgents:raw 正常回來 → 原樣回傳、不多寫 detect.log", dk === RAW && okw.logged.length === 0);
      t("四個呼叫點(detect-agents IPC、agentLogin、saveConnection、開 app 的 cli_auth)都叫包裝那支,不直接叫 raw;raw 只被包裝叫",
        (src.match(/(?<!function )\bdetectAgentsRaw\(\)/g) || []).length === 1 && /mine\.p = detectAgentsRaw\(\)\.finally\(/.test(wrap[0]) && /Promise\.race\(\[raw, /.test(wrap[0])
        && /handle\("detect-agents", \(\) => detectAgents\(\)\.then/.test(src) && /const d = await detectAgents\(\);/.test(src) && /d = await detectAgents\(\); agentPath =/.test(src) && /\n\s*detectAgents\(\)\.then\(\(d\) => \{ tm\(\)\.track\("cli_auth"/.test(src)); } }
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
