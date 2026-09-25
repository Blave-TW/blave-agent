// shell/main.js 的 childEnv:常駐程式與 agent 回合的子行程環境。
//   darwin:呼叫端手寫的白名單物件**原樣**回去(同一個物件、沒有 ...process.env)——改前改後逐 key 相同。
//   win32:放行整份 process.env、拔掉敏感的,SystemRoot / USERPROFILE / APPDATA / LOCALAPPDATA / TEMP / TMP / PATHEXT / COMSPEC
//          一定要通過(Windows 的 Python 少了 SystemRoot 起不來),HOME 對映到 USERPROFILE,PYTHONUTF8=1(stdout 遇 emoji 才不炸)。
//   每個 Windows 上會跑到的 spawn / execFile 都帶 windowsHide: true(GUI app 開 console 子行程不然會彈黑視窗)。
// 沒有 Windows 機器:平台與 process.env 都是假造的參數。跑法:node tests/check_shell_win_env.js
const fs = require("fs"), path = require("path"), os = require("os");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const cut = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); if (a < 0 || b < 0) { console.log("FAIL  main.js 裡找不到 " + from); process.exit(1); } return src.slice(a, b); };
eval(cut("const WIN_ENV_DROP", "// 跑一顆 Python").replace(/^const /gm, "var "));

const MUST = ["SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATHEXT", "COMSPEC"];
const penv = {
  SystemRoot: "C:\\WINDOWS", USERPROFILE: "C:\\Users\\u", APPDATA: "C:\\Users\\u\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
  TEMP: "C:\\Users\\u\\AppData\\Local\\Temp", TMP: "C:\\Users\\u\\AppData\\Local\\Temp", PATHEXT: ".COM;.EXE;.BAT;.CMD", COMSPEC: "C:\\WINDOWS\\system32\\cmd.exe",
  Path: "C:\\WINDOWS\\system32;C:\\Users\\u\\.local\\bin", NUMBER_OF_PROCESSORS: "8", ProgramFiles: "C:\\Program Files",
  ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-x", BLAVE_PROXY_TOKEN: "proxy-x", BLAVE_HOME: "D:\\x", CODEX_HOME: "x", CLAUDE_CODE_OAUTH_TOKEN: "x",
  PYTHONPATH: "C:\\junk", PYTHONHOME: "C:\\junk", NODE_OPTIONS: "--inspect", ELECTRON_RUN_AS_NODE: "1",
};
const own = { PATH: "C:\\Users\\u\\Blave\\venv\\Scripts;C:\\WINDOWS\\system32", HOME: "C:\\Users\\u", USER: "u", LANG: "en_US.UTF-8", TMPDIR: "C:\\t",
  BLAVE_KLINE_SOURCE: "binance", BLAVE_AGENT_HOME: "C:\\Users\\u\\Blave", BLAVE_AGENT_STATE: "C:\\Users\\u\\Blave\\state", PYTHONPYCACHEPREFIX: "C:\\Users\\u\\Blave\\state\\pycache" };

// ── darwin:一字不變 ──
const mac = childEnv(own, "darwin", penv);
t("darwin:回的是同一個物件(不是複本、沒有 ...process.env)", mac === own);
t("darwin:process.env 裡的東西一個都沒進來、也沒有 PYTHONUTF8", MUST.every((k) => !(k in mac)) && !("ANTHROPIC_API_KEY" in mac) && !("Path" in mac) && !("PYTHONUTF8" in mac));
t("darwin:預設參數就是 process.platform / process.env(呼叫端只給一個參數)", process.platform === "win32" || childEnv(own) === own);

// ── win32 ──
const win = childEnv(own, "win32", penv);
t("win32:七個系統變數都通過、值來自 process.env → " + MUST.filter((k) => win[k] !== penv[k]).join(",") || "全到", MUST.every((k) => win[k] === penv[k]));
t("win32:ANTHROPIC_* / OPENAI_* / process.env 的 BLAVE_* / CODEX_* / CLAUDE_* 都拔掉", ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "BLAVE_PROXY_TOKEN", "BLAVE_HOME", "CODEX_HOME", "CLAUDE_CODE_OAUTH_TOKEN"].every((k) => !(k in win)));
t("win32:會改 Python / Node 行為的也拔掉(PYTHONPATH / PYTHONHOME / NODE_OPTIONS / ELECTRON_RUN_AS_NODE)", ["PYTHONPATH", "PYTHONHOME", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"].every((k) => !(k in win)));
t("win32:白名單物件的每一個 key 都在、值以它為準(含自己的 BLAVE_* 與 PYTHONPYCACHEPREFIX)", Object.keys(own).filter((k) => k !== "HOME").every((k) => win[k] === own[k]));
t("win32:HOME 對映到 USERPROFILE", win.HOME === penv.USERPROFILE);
t("win32:PYTHONUTF8=1 一定在;用戶自己設的 PYTHONUTF8=0 被拔掉、以我們的為準", win.PYTHONUTF8 === "1" && childEnv(own, "win32", { ...penv, PYTHONUTF8: "0" }).PYTHONUTF8 === "1");
t("pyExec(建 venv / pip)在 win32 也帶 PYTHONUTF8、darwin 不帶(WIN 三元)", /execFile\(bin, args, \{ timeout, windowsHide: true, env: \{ \.\.\.process\.env, \.\.\.PY_ENV, \.\.\.\(WIN \? WIN_PY_ENV : \{\}\), PATH: envPath \} \}/.test(src));
t("win32:PATH 只有一份(process.env 的 Path 被白名單的 PATH 取代,不留兩個只差大小寫的 key)", Object.keys(win).filter((k) => k.toUpperCase() === "PATH").join() === "PATH" && win.PATH === own.PATH);
t("win32:其餘的原樣通過(NUMBER_OF_PROCESSORS、ProgramFiles)", win.NUMBER_OF_PROCESSORS === "8" && win.ProgramFiles === penv.ProgramFiles);
t("win32:process.env 沒有 SystemRoot 時補 C:\\Windows(不然 Python 起不來)", childEnv(own, "win32", { USERPROFILE: "C:\\Users\\u" }).SystemRoot === "C:\\Windows");
t("win32:不動傳進來的兩個物件", (() => { const o = JSON.stringify(own), p = JSON.stringify(penv); childEnv(own, "win32", penv); return JSON.stringify(own) === o && JSON.stringify(penv) === p; })());
// 突變:把 SystemRoot 加進拔除清單這條要紅
t("突變:拔除清單若吃到 SystemRoot,上面「七個都通過」會紅", (() => { const bad = /^(SYSTEMROOT|ANTHROPIC_)/i; const e = {}; for (const k of Object.keys(penv)) if (!bad.test(k)) e[k] = penv[k]; return !MUST.every((k) => e[k] === penv[k]); })());

// ── 接線:兩個 spawn 點都經過 childEnv;darwin 的白名單物件逐 key 跟改前一樣 ──
t("常駐程式的 env 經 childEnv(...)、venv 目錄用 VENV_BIN", /env: childEnv\(\{ PATH: path\.join\(BASE, "venv", VENV_BIN\) \+ path\.delimiter/.test(src));
t("agent 回合的 spawn 用 childEnv(env)、windowsHide", /\], \{ env: childEnv\(env\), cwd: WS, windowsHide: true \}\)/.test(src));
{
  // windowsHide:列舉三個檔裡每一個 spawn / execFile / spawnFn 呼叫點,看它整個引數清單(括號配對、跳過字串與註解)裡有沒有
  // windowsHide: true——新加一個沒帶就紅。唯一放行的是 loginShellPath 那支 `execFile(sh, ["-lc"`:它在 win32 提前 return 之後,Windows 跑不到
  const callText = (text, i) => {   // text[i] 是 "(":回到配對的 ")" 為止的原文
    let depth = 0, q = null, j = i;
    for (; j < text.length; j++) {
      const c = text[j], n = text[j + 1];
      if (q === "//") { if (c === "\n") q = null; continue; }
      if (q === "/*") { if (c === "*" && n === "/") { q = null; j++; } continue; }
      if (q) { if (c === "\\") j++; else if (c === q) q = null; continue; }
      if (c === "/" && n === "/") { q = "//"; continue; }
      if (c === "/" && n === "*") { q = "/*"; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; continue; }
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return text.slice(i, j + 1);
    }
    return text.slice(i);
  };
  const files = { "main.js": src, "daemon.js": fs.readFileSync(path.join(__dirname, "..", "shell", "daemon.js"), "utf8"), "datasrc.js": fs.readFileSync(path.join(__dirname, "..", "shell", "datasrc.js"), "utf8") };
  const sites = [], bare = [];
  for (const [f, text] of Object.entries(files)) {
    for (const m of text.matchAll(/\b(?:spawn|execFile|spawnFn)\(/g)) {
      const call = callText(text, m.index + m[0].length - 1);
      if (call.startsWith('(sh, ["-lc"')) continue;
      sites.push(f + ":" + text.slice(0, m.index).split("\n").length);
      if (!/windowsHide: true/.test(call)) bare.push(sites[sites.length - 1]);
    }
  }
  t("windowsHide:六個呼叫點都帶(main.js run / agentLogin / pyExec / 回合 spawn、daemon.js、datasrc.js)→ 找到 " + sites.length + " 處,沒帶的:" + (bare.join(",") || "無"), sites.length === 6 && bare.length === 0);
  // 突變:掃描器真的看得到「沒帶」——拿回合 spawn 那段把 windowsHide 拔掉再掃一次
  const turnSrc = src.replace("cwd: WS, windowsHide: true }", "cwd: WS }");
  const turnCall = callText(turnSrc, turnSrc.indexOf("spawn(VENV_PY") + "spawn".length);
  t("突變:回合 spawn 拔掉 windowsHide 後掃描器抓得到(括號配對有跨過 argv 裡的註解)", turnCall.includes("cwd: WS }") && !/windowsHide/.test(turnCall) && /--delivery/.test(turnCall));
}
{
  // 常駐程式那個物件:從原文切出來、用假的 BASE / process 算一次,key 集合釘死(改前的那組)
  const m = /env: childEnv\((\{ PATH: path\.join\(BASE, "venv", VENV_BIN\)[\s\S]*?\.\.\.PY_ENV \})\)/.exec(src);
  const obj = new Function("path", "os", "process", "BASE", "VENV_BIN", "PY_ENV", "return " + m[1])(path, os, { env: { PATH: "/usr/bin:/bin", USER: "u", LANG: "en", TMPDIR: "/t" } }, "/Users/u/Blave", "bin", {});
  t("常駐程式(darwin)的白名單 key 逐一相同:PATH HOME USER LANG TMPDIR BLAVE_KLINE_SOURCE BLAVE_AGENT_HOME BLAVE_AGENT_STATE",
    Object.keys(obj).join() === "PATH,HOME,USER,LANG,TMPDIR,BLAVE_KLINE_SOURCE,BLAVE_AGENT_HOME,BLAVE_AGENT_STATE" && obj.PATH === "/Users/u/Blave/venv/bin:/usr/bin:/bin");
  // agent 回合那個物件:同樣切出來算(dataAccess=ours、沒 token、沒 MCP、沒圖片接收端)
  const a = src.indexOf("const env = {", src.indexOf("async function runTurn(")), b = src.indexOf("\n  };", a);
  const turn = new Function("path", "os", "process", "BASE", "WS", "VENV_PY", "VENV_BIN", "PY_ENV", "envPath", "acct", "useCodex", "mcpFile", "mcpMount", "dataAccess", "dataAccessWhy", "signedIn", "imgPort", "imgToken", "sessionId",
    src.slice(a, b + 4) + "\n return env;")(path, os, { env: { USER: "u", LOGNAME: "u", TMPDIR: "/t", LANG: "zh_TW.UTF-8" } }, "/Users/u/Blave", "/Users/u/Blave/workspace", "/Users/u/Blave/venv/bin/python", "bin", {}, "/opt/homebrew/bin:/usr/bin", null, false, null, null, "ours", () => "unknown", true, 0, "", "s1");
  t("agent 回合(darwin)的白名單 key 逐一相同:PATH HOME BLAVE_PYTHON USER LOGNAME TMPDIR BLAVE_AGENT_BASE BLAVE_AGENT_WORKSPACE BLAVE_AGENT_HOME BLAVE_AGENT_STATE BLAVE_AGENT_DB BLAVE_KLINE_SOURCE BLAVE_DATA_ACCESS LANG",
    Object.keys(turn).join() === "PATH,HOME,BLAVE_PYTHON,USER,LOGNAME,TMPDIR,BLAVE_AGENT_BASE,BLAVE_AGENT_WORKSPACE,BLAVE_AGENT_HOME,BLAVE_AGENT_STATE,BLAVE_AGENT_DB,BLAVE_KLINE_SOURCE,BLAVE_DATA_ACCESS,LANG"
    && turn.PATH === "/Users/u/Blave/venv/bin:/opt/homebrew/bin:/usr/bin" && turn.BLAVE_DATA_ACCESS === "1");
  t("agent 回合的物件本身沒有 ...process.env(白名單的本意)", !/\.\.\.process\.env/.test(src.slice(a, b)));
}
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
