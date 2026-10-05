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
t("win32:process.env 的 PATH 在前、已知位置補在後(Claude 原生安裝器、npm 全域、Git for Windows 兩種裝法)",
  winPath(E) === "C:\\WINDOWS\\system32;C:\\Users\\u\\.local\\bin;C:\\Users\\u\\AppData\\Roaming\\npm;C:\\Users\\u\\AppData\\Local\\Programs\\Git\\cmd;C:\\Program Files\\Git\\cmd");
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
  /^const LOGIN_CHECK_MS = 20000;$/m.test(src) && /run\(claudeBin, \["auth", "status"\], envPath, LOGIN_CHECK_MS\)/.test(src) && /run\(codexBin, \["login", "status"\], envPath, LOGIN_CHECK_MS\)/.test(src)
  && (src.match(/envPath, 5000/g) || []).length === 2);
{ const body = src.slice(src.indexOf("async function detectAgents() {"), src.indexOf("\n}\n", src.indexOf("async function detectAgents() {")));
  t("detectAgents:每次寫一行紀錄到 BASE/state/detect.log;紀錄物件只經 runRec / binKind / loggedIn 填,沒有 path、email、stdout",
    /detectLogWrite\(path\.join\(BASE, "state", "detect\.log"\), \{ ts: new Date\(\)\.toISOString\(\), os: process\.platform, \.\.\.rec \}\)/.test(body)
    && !/rec\.\w+\.(path|email|stdout|stderr)\b/.test(body)
    && [...body.matchAll(/rec\.\w+\.(\w+) = /g)].map((m) => m[1]).every((k) => ["bin", "json", "loggedIn"].includes(k))
    && [...body.matchAll(/Object\.assign\(rec\.\w+, (\w+)\(/g)].every((m) => m[1] === "runRec")); }
{ const w = src.slice(src.indexOf("async function which(name, envPath, seen) {"), src.indexOf("async function codexBinNow()"));
  t("which / codexPath 往 seen 寫的只有 where(檔種清單)/ whereTimedOut / found(檔種)", [...w.matchAll(/seen\.(\w+) = /g)].map((m) => m[1]).every((k) => ["where", "whereTimedOut", "found"].includes(k))
    && /seen\.where = r\.code === 0 \? winOnPath\(r\.stdout, envPath\)\.split\(\/\\r\?\\n\/\)\.filter\(Boolean\)\.map\(binKind\)/.test(w) && /seen\.found = binKind\(found\)/.test(w)); }
(async () => {
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
      const mkDetect = new Function("loginShellPath", "which", "codexPath", "run", "binKind", "runRec", "detectLogWrite", "BASE", "path", "LOGIN_CHECK_MS", "process",
        dw[0] + "\n" + da[0] + "\nreturn detectAgents;");
      const slow = (v) => new Promise((r) => setTimeout(() => r(v), 300));
      const detect = mkDetect(async () => "/usr/bin", async (n) => "/opt/" + n, async () => "/opt/codex",
        (bin, args, envPath, ms) => { runs.push([bin, ms, Date.now()]); return slow(bin.endsWith("claude") ? { code: 0, stdout: '{"loggedIn":true}', timedOut: false, ms: 300 } : { code: null, stdout: "", timedOut: true, ms: 300 }); },
        binKind, runRec, (f, e) => logged.push(e), "/b", path, 20000, { platform: "darwin" });
      const t0 = Date.now(), d = await detect(), took = Date.now() - t0;
      t("detectAgents:claude 與 codex 的登入檢查同時開跑(兩條各 300ms,整次 < 500ms;依序會 ≥ 600)、各帶 20 秒上限", took < 500 && runs.length === 2 && Math.abs(runs[0][2] - runs[1][2]) < 100 && runs.every((r) => r[1] === 20000), { took, runs });
      t("…結果照舊組回去:claude 登入、codex 逾時 → why=codex_timeout;紀錄一行", d.claude.loggedIn === true && d.claude.why === null && d.codex.installed && d.codex.loggedIn === false && d.codex.why === "codex_timeout"
        && logged.length === 1 && logged[0].codex.timedOut === true && logged[0].claude.loggedIn === true); } }
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
