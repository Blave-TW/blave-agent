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
t("which 在 win32 用 System32\\where.exe;run 只對 .cmd/.bat 開 shell", /System32", "where\.exe"\), \[name\], envPath, 5000\)/.test(src) && /const cmdWrap = \(bin\) => \(process\.platform === "win32" && \/\\\.\(cmd\|bat\)\$\/i\.test\(bin\)/.test(src));
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
