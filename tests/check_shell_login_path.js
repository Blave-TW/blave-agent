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
// which / codex:where.exe 的輸出優先拿 .exe;codex.cmd 解到 npm 平台套件裡的 codex.exe,解不到 = 沒裝
const pw = src.match(/^function pickWinBin\(stdout\) \{[\s\S]*?\n\}/m), we = src.match(/^function winRealExe\(bin, arch, exists = fs\.existsSync\) \{[\s\S]*?\n\}/m), ce = src.match(/^const CODEX_WIN_EXE = [\s\S]*?\n\};/m);
if (!pw || !we || !ce) { console.log("FAIL  找不到 pickWinBin / winRealExe / CODEX_WIN_EXE"); process.exit(1); }
eval(pw[0]); eval(ce[0].replace(/^const /, "var ")); eval(we[0]);
t("pickWinBin:where 列出 .cmd 與 .exe 時拿 .exe(原生安裝器),只有 .cmd 時拿 .cmd,空的 null",
  pickWinBin("C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd\r\nC:\\Users\\u\\.local\\bin\\claude.exe\r\n") === "C:\\Users\\u\\.local\\bin\\claude.exe"
  && pickWinBin("C:\\r\\npm\\codex.cmd\r\n") === "C:\\r\\npm\\codex.cmd" && pickWinBin("") === null);
const cmd = "C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd", exe = "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
const fallback = "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
t("winRealExe:codex.cmd → 平台套件的 codex.exe(npm bin/codex.js 0.156.1 的找法)", winRealExe(cmd, "x64", (p) => p === exe) === exe);
t("winRealExe:平台套件不在 → @openai/codex 自己的 vendor/", winRealExe(cmd, "x64", (p) => p === fallback) === fallback);
t("winRealExe:兩個都不在 → null(不把 .cmd 交給 runtime 的 create_subprocess_exec)", winRealExe(cmd, "x64", () => false) === null);
t("winRealExe:已經是 .exe / null 原樣回", winRealExe("C:\\x\\codex.exe", "x64", () => false) === "C:\\x\\codex.exe" && winRealExe(null, "x64") === null);
// 測試機實測(Codex 0.160.0 用 npm i -g、Node 24、npm 11):where.exe 第一行是 npm 的無副檔名 sh 包裝檔,平台套件巢狀裝在 @openai/codex 底下
const WHERE_REAL = "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\codex\r\nC:\\Users\\Administrator\\AppData\\Roaming\\npm\\codex.cmd\r\n";
const realCmd = "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\codex.cmd";
const nested = (pkg, triple) => "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\" + pkg + "\\vendor\\" + triple + "\\bin\\codex.exe";
t("pickWinBin:where 第一行是無副檔名的 sh 包裝檔 → 跳過、拿 codex.cmd", pickWinBin(WHERE_REAL) === realCmd);
t("pickWinBin:只有無副檔名那一行 → null(交給 execFile 只會 ENOENT、被誤判成未登入)", pickWinBin("C:\\r\\npm\\codex\r\n") === null);
t("pickWinBin:claude 三種都在(sh / .cmd / .exe)→ 仍拿 .exe;只有 sh + .cmd → .cmd;.bat 也算",
  pickWinBin("C:\\r\\npm\\claude\r\nC:\\r\\npm\\claude.cmd\r\nC:\\Users\\u\\.local\\bin\\claude.exe\r\n") === "C:\\Users\\u\\.local\\bin\\claude.exe"
  && pickWinBin("C:\\r\\npm\\claude\r\nC:\\r\\npm\\claude.cmd\r\n") === "C:\\r\\npm\\claude.cmd" && pickWinBin("C:\\r\\x\r\nC:\\r\\x.bat\r\n") === "C:\\r\\x.bat");
t("winRealExe:平台套件巢狀在 @openai/codex/node_modules 底下(0.160.0)→ 找得到", winRealExe(realCmd, "x64", (p) => p === nested("codex-win32-x64", "x86_64-pc-windows-msvc")) === nested("codex-win32-x64", "x86_64-pc-windows-msvc"));
t("winRealExe:arm64 的巢狀路徑同一套規則", winRealExe(realCmd, "arm64", (p) => p === nested("codex-win32-arm64", "aarch64-pc-windows-msvc")) === nested("codex-win32-arm64", "aarch64-pc-windows-msvc"));
t("winRealExe:實測那兩行一路走下來 → 巢狀 codex.exe", winRealExe(pickWinBin(WHERE_REAL), "x64", (p) => p === nested("codex-win32-x64", "x86_64-pc-windows-msvc")) === nested("codex-win32-x64", "x86_64-pc-windows-msvc"));
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
  && /function run\(cmd, args, envPath, timeout = 10000, cwd = undefined\)/.test(src) && /execFile\(w\.file, args, \{ timeout, cwd,/.test(src));
t("which 在 win32 用 System32\\where.exe;run 只對 .cmd/.bat 開 shell", /const sys32 = path\.win32\.join\(process\.env\.SystemRoot \|\| "C:\\\\Windows", "System32"\)/.test(src) && /const cmdWrap = \(bin\) => \(process\.platform === "win32" && \/\\\.\(cmd\|bat\)\$\/i\.test\(bin\)/.test(src));
// ── 偵測紀錄 + 登入檢查上限(0.1.15):紀錄只有檔種/回傳碼/逾時/耗時/登入與否,不帶路徑與 CLI 輸出 ──
const bk = src.match(/^function binKind\(p\) \{[\s\S]*?\n\}/m), rr = src.match(/^const runRec = .*$/m), dl = src.match(/^function detectLogWrite\(f, entry\) \{[\s\S]*?\n\}/m),
  dm = src.match(/^const DETECT_LOG_MAX = .*$/m), rn = src.match(/^function run\(cmd, args, envPath, timeout = 10000, cwd = undefined\) \{[\s\S]*?\n\}/m), cw = src.match(/^const cmdWrap = .*$/m);
if (!bk || !rr || !dl || !dm || !rn || !cw) { console.log("FAIL  找不到 binKind / runRec / detectLogWrite / DETECT_LOG_MAX / run / cmdWrap"); process.exit(1); }
eval(bk[0]); eval(rr[0].replace(/^const /, "var ")); eval(dm[0].replace(/^const /, "var ")); eval(dl[0]); eval(cw[0].replace(/^const /, "var ")); eval(rn[0]);
var wsfile = require(path.join(__dirname, "..", "shell", "wsfile.js")), { execFile } = require("child_process"), os = require("os");
t("binKind:exe / cmd / bat / ps1 / 無副檔名 shim / ChatGPT 內附 / 一般 POSIX / 沒有",
  binKind("C:\\u\\.local\\bin\\claude.exe") === "exe" && binKind("C:\\r\\npm\\codex.cmd") === "cmd" && binKind("C:\\r\\x.BAT") === "cmd" && binKind("C:\\r\\npm\\codex.ps1") === "ps1"
  && binKind("C:\\Users\\u\\AppData\\Roaming\\npm\\codex") === "shim" && binKind("/Applications/ChatGPT.app/Contents/Resources/codex") === "chatgpt"
  && binKind("/opt/homebrew/bin/codex") === "posix" && binKind(null) === "none" && binKind("") === "none");
// ── Windows 的 Store 版 Codex 桌面版:不在 PATH 上,問系統套件的安裝資料夾(釘發行者),接 app\resources\codex.exe ──
const STORE_DIR = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0", STORE_EXE = STORE_DIR + "\\app\\resources\\codex.exe";
const FAM = "OpenAI.Codex_2p2nqsd0c76g0";
t("binKind:Store 版的 codex.exe 是 store(排在 exe 前面);同資料夾別的 exe、別家套件仍是 exe", binKind(STORE_EXE) === "store" && binKind(STORE_EXE.toLowerCase()) === "store"
  && binKind(STORE_DIR + "\\app\\Codex.exe") === "exe" && binKind("C:\\Program Files\\WindowsApps\\Evil.Codex_1.0.0.0_x64__abc\\app\\resources\\codex.exe") === "exe");
const sf = src.match(/^const CODEX_STORE_FAMILY = .*$/m), sq = src.match(/^const CODEX_STORE_PS = .*$/m), ps = src.match(/^function pickStoreCodex\(stdout\) \{[\s\S]*?\n\}/m),
  sp = src.match(/^async function storeCodexPath\(envPath, fresh\) \{[\s\S]*?\n\}/m), cp = src.match(/^async function codexPath\(envPath, seen, fresh\) \{[\s\S]*?\n\}/m), dwS = src.match(/^function detectWhy\(kind, r\) \{[\s\S]*?\n\}/m);
if (!sf || !sq || !ps || !sp || !cp || !dwS) { console.log("FAIL  找不到 CODEX_STORE_FAMILY / CODEX_STORE_PS / pickStoreCodex / storeCodexPath / codexPath / detectWhy"); process.exit(1); }
eval(sf[0].replace(/^const /, "var ")); eval(ps[0]);
t("pickStoreCodex:實測那一行 → 安裝資料夾底下的 app\\resources\\codex.exe;CRLF、前後空行不影響", pickStoreCodex("\r\n" + FAM + "|26.1007.2314.0|" + STORE_DIR + "\r\n\r\n") === STORE_EXE && CODEX_STORE_FAMILY === FAM);
t("pickStoreCodex:空輸出 / 不是這個格式 → null", pickStoreCodex("") === null && pickStoreCodex(null) === null && pickStoreCodex("Get-AppxPackage : Access is denied\r\n") === null && pickStoreCodex(STORE_DIR) === null);
t("pickStoreCodex:發行者不對(側載的同名套件)不收", pickStoreCodex("OpenAI.Codex_aaaaaaaaaaaaa|99.0.0.0|C:\\Program Files\\WindowsApps\\OpenAI.Codex_99.0.0.0_x64__aaaaaaaaaaaaa") === null);
t("pickStoreCodex:相對路徑、不在 \\WindowsApps\\OpenAI.Codex_ 底下、多一層子資料夾、多一欄都不收",
  [".\\WindowsApps\\OpenAI.Codex_1_x64__2p2nqsd0c76g0", "C:\\Users\\u\\Downloads\\OpenAI.Codex_1_x64__2p2nqsd0c76g0", "C:\\Program Files\\WindowsApps\\Other.App_1_x64__2p2nqsd0c76g0",
    STORE_DIR + "\\app", STORE_DIR + "|x", ""].every((d) => pickStoreCodex(FAM + "|1.0.0.0|" + d) === null) && pickStoreCodex(FAM + "|abc|" + STORE_DIR) === null);
{ const d = (v) => "D:\\WindowsApps\\OpenAI.Codex_" + v + "_x64__2p2nqsd0c76g0", line = (v) => FAM + "|" + v + "|" + d(v);
  t("pickStoreCodex:同時裝了多版取版號最高的(逐段比數字:26.1007 > 26.999;順序無關;別的磁碟也行)",
    pickStoreCodex(line("26.999.1.0") + "\r\n" + line("26.1007.2314.0") + "\r\n" + line("26.1007.99.0")) === d("26.1007.2314.0") + "\\app\\resources\\codex.exe"
    && pickStoreCodex(line("26.1007.2314.0") + "\n" + line("26.999.1.0")) === d("26.1007.2314.0") + "\\app\\resources\\codex.exe"); }
const crS = src.match(/^const cantRun = .*$/m);
if (!crS) { console.log("FAIL  找不到 cantRun"); process.exit(1); }
eval(crS[0].replace(/^const /, "var "));
var BAD_BIN = { codex: null, claude: null };
{ eval(dwS[0]);
  t("detectWhy:PATH 只有 shim、Store 也沒有 → 仍是 codex_shim;有 Store 就是能用(null);Store 版沒登入 → codex_nonzero;都沒有 → codex_none",
    detectWhy("codex", { bin: "none", where: ["shim", "cmd"], loggedIn: false }) === "codex_shim" && detectWhy("codex", { bin: binKind(STORE_EXE), where: ["shim", "cmd"], code: 0, loggedIn: true }) === null
    && detectWhy("codex", { bin: "store", where: [], code: 1, timedOut: false, loggedIn: false }) === "codex_nonzero" && detectWhy("codex", { bin: "none", where: [], loggedIn: false }) === "codex_none"); }
t("storeCodexPath:PowerShell 走 System32 的絕對路徑、-NoProfile -NonInteractive、cwd 釘 System32、有逾時;查的是 OpenAI.Codex 這一個名字、不帶 -AllUsers",
  /run\(path\.win32\.join\(sys32, "WindowsPowerShell", "v1\.0", "powershell\.exe"\), \["-NoProfile", "-NonInteractive", "-Command", CODEX_STORE_PS\], envPath, 15000, sys32\)/.test(sp[0])
  && /const sys32 = path\.win32\.join\(process\.env\.SystemRoot \|\| "C:\\\\Windows", "System32"\)/.test(sp[0]) && /"Get-AppxPackage -Name OpenAI\.Codex \| /.test(sq[0]) && !/AllUsers/i.test(sq[0]));
t("detectAgents(用戶按重新偵測)叫 codexPath 帶 fresh=true;codexBinNow(每一則訊息)不帶、走快取", /probe\("codex", \(seen\) => codexPath\(envPath, seen, true\), \["login", "status"\]\)/.test(src)
  && /async function codexBinNow\(\) \{ return codexPath\(await loginShellPath\(\)\); \}/.test(src));
var storeFlow = (async () => {
  // storeCodexPath + codexPath 原文配假的 which / run / fs:PATH 有就不問 Store;沒有才問;問到的記住,檔不在了才重問
  const calls = [], disk = new Set([STORE_EXE]), st = { which: null, out: FAM + "|26.1007.2314.0|" + STORE_DIR + "\r\n", code: 0 };
  const mk = new Function("which", "run", "fs", "path", "process", "binKind", "winRealExe", "pickStoreCodex", "CODEX_STORE_PS", "CODEX_IN_CHATGPT",
    "let storeCodex = null; const BAD_BIN = { codex: null };\n" + sp[0] + "\n" + cp[0] + "\nreturn codexPath;");
  // 假的 which 照真的那樣往 seen.where 寫檔種:PATH 上有 .cmd 時 where.exe 會列出 sh 包裝檔 + .cmd
  const codexPath = mk(async (n, ep, seen) => { if (seen) seen.where = st.which ? ["shim", "cmd"] : []; return st.which; }, async (bin, args, envPath, ms, cwd) => { calls.push([bin, args, ms, cwd]); return { code: st.code, stdout: st.out, timedOut: false, ms: 1 }; },
    { existsSync: (p) => disk.has(p) }, path, { platform: "win32", arch: "x64", env: { SystemRoot: "C:\\Windows" } }, binKind, winRealExe, pickStoreCodex, "PS", "/x");
  st.which = "C:\\Users\\u\\.local\\bin\\codex.exe";
  t("codexPath(win32):PATH 上有 codex.exe → 用它,不起 PowerShell", await codexPath("C:\\p") === st.which && calls.length === 0);
  st.which = null; const seen = {};
  t("codexPath(win32):PATH 沒有 → 問 Store,回 app\\resources\\codex.exe;seen.found 仍是 none(PATH 上沒有)",
    await codexPath("C:\\p", seen) === STORE_EXE && calls.length === 1 && calls[0][0] === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" && calls[0][2] === 15000 && calls[0][3] === "C:\\Windows\\System32" && seen.found === "none");
  t("…第二次(每一則訊息)用記住的路徑,不再起 PowerShell", await codexPath("C:\\p") === STORE_EXE && await codexPath("C:\\p") === STORE_EXE && calls.length === 1);
  t("…fresh(重新偵測)一律重問", await codexPath("C:\\p", {}, true) === STORE_EXE && calls.length === 2);
  const NEW_DIR = STORE_DIR.replace("26.1007.2314.0", "26.1101.5.0"), NEW_EXE = NEW_DIR + "\\app\\resources\\codex.exe";
  disk.delete(STORE_EXE); disk.add(NEW_EXE); st.out = FAM + "|26.1101.5.0|" + NEW_DIR + "\r\n";
  t("…app 更新換了資料夾(記住的檔不在了)→ 重問、拿到新路徑", await codexPath("C:\\p") === NEW_EXE && calls.length === 3);
  disk.delete(NEW_EXE);
  t("…系統說有、檔其實不在 → null(不把不存在的路徑交給 runtime)", await codexPath("C:\\p") === null && calls.length === 4);
  disk.add(NEW_EXE); st.code = 1;
  t("…PowerShell 非 0(逾時、被 AppLocker 擋)→ null", await codexPath("C:\\p") === null);
  st.code = 0; st.which = "C:\\r\\npm\\codex.cmd";
  t("codexPath(win32):PATH 上只有解不到 exe 的 .cmd → 也退到 Store", await codexPath("C:\\p") === NEW_EXE);
  disk.delete(NEW_EXE); const rec = {};
  rec.bin = binKind(await codexPath("C:\\p", rec, true));
  t("…PATH 只有 shim、Store 也沒有 → 一路走下來 bin=none、where 有 cmd → detectWhy 仍是 codex_shim(語意沒被 Store 退路改掉)",
    rec.bin === "none" && detectWhy("codex", { ...rec, loggedIn: false }) === "codex_shim");
  const mac = mk(async () => null, async () => { calls.push("mac"); return { code: 0, stdout: st.out }; }, { existsSync: () => false }, path, { platform: "darwin", arch: "arm64", env: {} }, binKind, winRealExe, pickStoreCodex, "PS", "/x");
  t("codexPath(darwin):不走 Store 這條", await mac("/usr/bin") === null && !calls.includes("mac"));
})();
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
  /probe\("claude", \(seen\) => claudePath\(envPath, seen\), \["auth", "status"\]\)/.test(src) && !/which\("claude"/.test(src.slice(src.indexOf("async function detectAgents() {")))
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
  /^const LOGIN_CHECK_MS = 20000;$/m.test(src) && /probe\("claude", [^\n]*\["auth", "status"\]\)/.test(src) && /probe\("codex", [^\n]*\["login", "status"\]\)/.test(src)
  && (src.match(/run\((?:bin|alt), args, envPath, LOGIN_CHECK_MS\)/g) || []).length === 2
  && (src.match(/envPath, 5000/g) || []).length === 2);
{ const body = src.slice(src.indexOf("async function detectAgents() {"), src.indexOf("\n}\n", src.indexOf("async function detectAgents() {")));
  t("detectAgents:每次寫一行紀錄到 BASE/state/detect.log;紀錄物件只經 runRec / binKind / loggedIn 填,沒有 path、email、stdout",
    /detectLogWrite\(path\.join\(BASE, "state", "detect\.log"\), \{ ts: new Date\(\)\.toISOString\(\), os: process\.platform, \.\.\.rec \}\)/.test(body)
    && !/rec\.\w+\.(path|email|stdout|stderr)\b/.test(body)
    && [...body.matchAll(/rec\.\w+\.(\w+) = /g)].map((m) => m[1]).every((k) => ["bin", "json", "loggedIn", "alt"].includes(k))
    && [...body.matchAll(/Object\.assign\(rec\.\w+, (\w+)\(/g)].every((m) => m[1] === "runRec")); }
{ const w = src.slice(src.indexOf("async function which(name, envPath, seen) {"), src.indexOf("async function codexBinNow()"));
  t("which / codexPath 往 seen 寫的只有 where(檔種清單)/ whereTimedOut / found(檔種)", [...w.matchAll(/seen\.(\w+) = /g)].map((m) => m[1]).every((k) => ["where", "whereTimedOut", "found"].includes(k))
    && /seen\.where = r\.code === 0 \? winOnPath\(r\.stdout, envPath\)\.split\(\/\\r\?\\n\/\)\.filter\(Boolean\)\.map\(binKind\)/.test(w) && /seen\.found = binKind\(found\)/.test(w)); }
(async () => {
  await storeFlow; await claudeFlow;
  const slow = await run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], process.env.PATH, 150);
  t("run:逾時 → timedOut=true、ms ≥ 上限(以前只看得到 code,分不出逾時)", slow.timedOut === true && slow.ms >= 150 && slow.ms < 4000, slow);
  const bad = await run(process.execPath, ["-e", "process.exit(3)"], process.env.PATH, 5000);
  t("run:非 0 結束 → code=3、timedOut=false", bad.code === 3 && bad.timedOut === false && bad.ms >= 0);
  const none = await run(path.join(os.tmpdir(), "no-such-bin-" + process.pid), [], process.env.PATH, 5000);
  t("run:執行檔不在 → code=ENOENT、timedOut=false", none.code === "ENOENT" && none.timedOut === false);
  const good = await run(process.execPath, ["-e", "process.stdout.write('ok')"], process.env.PATH, 5000);
  t("run:正常 → code=0、stdout 照舊", good.code === 0 && good.stdout === "ok" && good.timedOut === false);
  // 兩條登入檢查同時跑:detectAgents 原文配假的 which / run(各 300ms),整次要遠小於 600ms;依序跑就會 ≥ 600
  { const da = src.match(/^async function detectAgents\(\) \{[\s\S]*?\n\}/m), dw = src.match(/^function detectWhy\(kind, r\) \{[\s\S]*?\n\}/m);
    if (!da || !dw) t("找得到 detectAgents / detectWhy", false);
    else { const runs = [], logged = [];
      const mkDetect = new Function("loginShellPath", "claudePath", "codexPath", "run", "binKind", "runRec", "detectLogWrite", "BASE", "path", "LOGIN_CHECK_MS", "process",
        crS[0] + "\nconst BAD_BIN = {};\n" + dw[0] + "\n" + da[0] + "\nreturn detectAgents;");
      const slow = (v) => new Promise((r) => setTimeout(() => r(v), 300));
      const detect = mkDetect(async () => "/usr/bin", async () => "/opt/claude", async () => "/opt/codex",
        (bin, args, envPath, ms) => { runs.push([bin, ms, Date.now()]); return slow(bin.endsWith("claude") ? { code: 0, stdout: '{"loggedIn":true}', timedOut: false, ms: 300 } : { code: null, stdout: "", timedOut: true, ms: 300 }); },
        binKind, runRec, (f, e) => logged.push(e), "/b", path, 20000, { platform: "darwin" });
      const t0 = Date.now(), d = await detect(), took = Date.now() - t0;
      t("detectAgents:claude 與 codex 的登入檢查同時開跑(兩條各 300ms,整次 < 500ms;依序會 ≥ 600)、各帶 20 秒上限", took < 500 && runs.length === 2 && Math.abs(runs[0][2] - runs[1][2]) < 100 && runs.every((r) => r[1] === 20000), { took, runs });
      t("…結果照舊組回去:claude 登入、codex 逾時 → why=codex_timeout;紀錄一行", d.claude.loggedIn === true && d.claude.why === null && d.codex.installed && d.codex.loggedIn === false && d.codex.why === "codex_timeout"
        && logged.length === 1 && logged[0].codex.timedOut === true && logged[0].claude.loggedIn === true); } }
  // 偵測跑的可能是 SDK 隨包那顆 claude:不帶 DISABLE_AUTOUPDATER 它會在背景抓 330MB 新版
  const envOut = await run(process.execPath, ["-e", "process.stdout.write(String(process.env.DISABLE_AUTOUPDATER))"], process.env.PATH, 5000);
  t("run:子行程的 env 帶 DISABLE_AUTOUPDATER=1", envOut.code === 0 && envOut.stdout === "1", envOut);
  { const al = src.match(/^async function agentLogin\(kind, onSpawn\) \{[\s\S]*?\n\}/m);
    t("agentLogin:spawn 的 env 也帶 DISABLE_AUTOUPDATER=1(登入用的也可能是隨包那顆)", !!al && /spawn\([\s\S]*?env: \{ \.\.\.process\.env, PATH: envPath, DISABLE_AUTOUPDATER: "1" \}/.test(al[0])); }
  // claude auth status 跑不起來(退出碼非 0、沒有輸出)不是「回的不是 JSON」:只有退出碼 0 才記 json=false
  { const da = src.match(/^async function detectAgents\(\) \{[\s\S]*?\n\}/m), dw = src.match(/^function detectWhy\(kind, r\) \{[\s\S]*?\n\}/m);
    const mk = new Function("loginShellPath", "claudePath", "codexPath", "run", "binKind", "runRec", "detectLogWrite", "BASE", "path", "LOGIN_CHECK_MS", "process", crS[0] + "\nconst BAD_BIN = {};\n" + dw[0] + "\n" + da[0] + "\nreturn detectAgents;");
    const once = async (claudeRes) => { const logged = [];
      const d = await mk(async () => "/usr/bin", async () => "/opt/claude", async () => null, async () => ({ timedOut: false, ms: 1, ...claudeRes }), binKind, runRec, (f, e) => logged.push(e), "/b", path, 20000, { platform: "darwin" })();
      return { why: d.claude.why, json: logged[0].claude.json }; };
    const dead = await once({ code: 1, stdout: "" }), old = await once({ code: 0, stdout: "usage: claude" }), sig = await once({ code: "ENOENT", stdout: "" });
    t("detectAgents:claude 退出碼非 0、stdout 空 → claude_nonzero,不記 json=false;開不起來(ENOENT)→ claude_cantrun(不是沒登入)", dead.why === "claude_nonzero" && dead.json === undefined && sig.why === "claude_cantrun" && sig.json === undefined, { dead, sig });
    t("detectAgents:claude 退出碼 0 但回的不是 JSON(舊版)→ 仍是 claude_badjson", old.why === "claude_badjson" && old.json === false, old); }
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
