// shell 的打包設定與 hook 不准寫死任何憑證材料:Key ID、Issuer UUID、.p8 路徑、Team ID / 憑證名、
// 家目錄絕對路徑——全部只能從環境變數來。跑法:node tests/check_shell_build_config.js
const fs = require("fs"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const FILES = ["electron-builder.config.js", "package.json", "tools/sign-python.js", "tools/notarize-dmg.js",
  "build/entitlements.mac.plist", "build/entitlements.mac.inherit.plist", "build/entitlements.python.plist"];
const BANNED = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "UUID(Issuer ID 長這樣)"],
  [/AuthKey_|\.p8\b/, ".p8 金鑰檔名 / 路徑"],
  [/\(\s*[A-Z0-9]{10}\s*\)|Developer ID Application: [^$`"']/, "寫死的憑證名 / Team ID"],
  [/\/Users\/|~\//, "家目錄路徑"],
  [/(KEY_ID|ISSUER|IDENTITY)\w*["']?\s*[:=]\s*["'][^"'<]+["']/, "憑證變數被指派了字面值"],
  [/-----BEGIN/, "金鑰內容"],
];
let red = 0;
for (const f of FILES) {
  const p = path.join(SHELL, f);
  if (!fs.existsSync(p)) { console.log("FAIL  " + f + " 不在"); red++; continue; }
  const src = fs.readFileSync(p, "utf8");
  const hits = BANNED.filter(([re]) => re.test(src)).map(([, why]) => why);
  console.log((hits.length ? "FAIL  " : "PASS  ") + f + (hits.length ? " → " + hits.join("、") : ""));
  red += hits.length;
}
const cfg = fs.readFileSync(path.join(SHELL, "electron-builder.config.js"), "utf8");
for (const v of ["BLAVE_MAC_IDENTITY", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) {
  const ok = cfg.includes("process.env." + v);
  console.log((ok ? "PASS  " : "FAIL  ") + "config 從 process.env." + v + " 讀"); if (!ok) red++;
}
// 選單列圖示:檔案缺了 Tray 是看不見的空圖、不丟錯(稽核 M4)——圖要在、也要被打進包
// 列舉:main.js require 的每一個自家模組都要在打包清單裡(漏一個 = 打包版一啟動就找不到模組;開發版看不出來)
{ const mainSrc = require("fs").readFileSync(require("path").join(__dirname, "..", "shell", "main.js"), "utf8");
  const mods = [...new Set((mainSrc.match(/require\("\.\/([a-z_]+)(?:\.js)?"\)/g) || []).map((m) => m.match(/\.\/([a-z_]+)/)[1] + ".js"))];
  const filesLine = (cfg.match(/files:\s*\[[^\]]*\]/) || [""])[0];
  const missing = mods.filter((m) => !filesLine.includes('"' + m + '"'));
  const ok = mods.length >= 5 && missing.length === 0;
  console.log((ok ? "PASS  " : "FAIL  ") + "main.js require 的自家模組都在 files 裡" + (missing.length ? " → 缺 " + missing.join(", ") : "")); if (!ok) process.exitCode = 1; }
for (const [ok, what] of [[/files:\s*\[[^\]]*"cloud\.js"/.test(cfg) && /files:\s*\[[^\]]*"updater\.js"/.test(cfg), "files 含 cloud.js 與 updater.js(main.js require 它們)"], [/files:\s*\[[^\]]*"telemetry\.js"/.test(cfg), "files 含 telemetry.js(main.js require 它,漏了打包版一開就炸)"], [/files:\s*\[[^\]]*"assets\/\*\*\/\*"/.test(cfg), "files 含 assets/**/*"],
  ...["trayTemplate.png", "trayTemplate@2x.png"].map((f) => [fs.existsSync(path.join(SHELL, "assets", f)), "assets/" + f + " 在"])]) {
  console.log((ok ? "PASS  " : "FAIL  ") + what); if (!ok) red++;
}
// universal(一個 dmg 同時給 Apple Silicon 與 Intel):三個 target 都要 universal、CLI 明寫 target 的 pack / dist 要帶 --universal
// (CLI 有 target 時 arch 由 CLI 決定、預設 process.arch,config 的 arch 會被蓋掉),兩顆隨包 Python 都要進包且
// 在 x64ArchFiles / signIgnore 裡(合併時兩邊 SHA 相同的 Mach-O 不在 x64ArchFiles 就直接報錯;不在 signIgnore 就被 electron-builder 用錯 entitlements 簽)
{
  const pkg = JSON.parse(fs.readFileSync(path.join(SHELL, "package.json"), "utf8"));
  const fetchSh = fs.readFileSync(path.join(SHELL, "tools", "fetch-python.sh"), "utf8");
  const signPy = fs.readFileSync(path.join(SHELL, "tools", "sign-python.js"), "utf8");
  const mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
  const targets = [...cfg.matchAll(/\{ target: "(dir|dmg|zip)", arch: \[([^\]]*)\] \}/g)];
  for (const [ok, what] of [
    [targets.length === 3 && targets.every((m) => m[2] === '"universal"'), "mac.target 的 dir / dmg / zip 三個都是 arch universal"],
    [/--mac dir --universal/.test(pkg.scripts.pack) && /--mac dmg --universal/.test(pkg.scripts.dist), "package.json 的 pack / dist 帶 --universal"],
    [/from: "vendor\/python-arm64", to: "python-arm64"/.test(cfg) && /from: "vendor\/python-x64", to: "python-x64"/.test(cfg), "extraResources 收 python-arm64 與 python-x64 兩顆"],
    [/x64ArchFiles: "Contents\/Resources\/python-\{arm64,x64\}\/\*\*"/.test(cfg), "x64ArchFiles 蓋住兩顆 Python"],
    [/signIgnore: \["\/Contents\/Resources\/python-\(arm64\|x64\)\/"\]/.test(cfg), "signIgnore 蓋住兩顆 Python"],
    [/^fetch arm64 aarch64-apple-darwin [0-9a-f]{64}$/m.test(fetchSh) && /^fetch x64 +x86_64-apple-darwin +[0-9a-f]{64}$/m.test(fetchSh), "fetch-python.sh 釘了 aarch64 與 x86_64 兩顆、各帶 64 hex 的 SHA256"],
    [/PY_ARCHES = \["arm64", "x64"\]/.test(signPy) && /-\(x64\|arm64\)-temp\$/.test(signPy), "sign-python.js 兩顆都處理、跳過 universal 的 x64/arm64 中間包(中間包預編 .pyc 會讓合併失敗)"],
    // 中間包 return 之前要先清兩棵樹的 __pycache__:掃描器往其中一包寫 .pyc,@electron/universal 就因兩包清單不一致拒絕合併
    [(() => { const fn = signPy.indexOf("async function signPython"), sweep = signPy.indexOf("rmPycaches(roots);", fn), ret = signPy.indexOf("-temp$/.test(context.appOutDir)) return;", fn); return fn >= 0 && sweep > fn && ret > sweep; })(), "sign-python.js 在中間包 early return 之前先對兩棵樹清 __pycache__"],
    [/`python-\$\{process\.arch\}`, "bin", "python3"/.test(mainSrc), "main.js 照 process.arch 挑隨包 Python"],
  ]) { console.log((ok ? "PASS  " : "FAIL  ") + what); if (!ok) red++; }
}
// Intel / Rosetta(0.0.6 通用版實測):SDK → mcp → pyjwt[crypto] 拉進 cryptography,50.x 起 macOS 只出 arm64 wheel,x64 退到
// 編原始碼(maturin 會自己抓一套 Rust 下來編,幾分鐘)、venv 半套。引擎的每一條 pip 都只收 wheel(--only-binary=:all:,
// 沒 wheel 就兩秒內大聲失敗)且 --isolated(不吃用戶 pip.conf / PIP_*),cryptography 釘 48.0.1(最後一版 universal2 wheel),
// 記號檔比整串釘法才會在既有 venv 上重跑。失敗要留痕、進聊天欄的字要說得出原因、不帶用戶路徑。
(async () => {
  const mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
  const appSrc = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
  const pipCmds = mainSrc.match(/`"\$\{VENV_PY\}" [^`]*(pip|PIP_INSTALL)[^`]*`/g) || [];
  const slice = (a, b) => { const i = mainSrc.indexOf(a); if (i < 0) throw new Error("找不到 " + a); const j = mainSrc.indexOf(b, i); return mainSrc.slice(i, j + b.length); };
  const pipError = new Function(slice("function pipError(e)", "\n}\n") + "; return pipError;")();
  const trimmed = pipError(new Error("  Building wheel for cryptography (pyproject.toml) ... error\n  cargo: not found\nERROR: Could not find a version that satisfies the requirement cryptography==50.0.1 (from versions: 2.2, 2.2.1, 48.0.1)\n\nERROR: No matching distribution found for cryptography==50.0.1\n[notice] A new release of pip is available"));
  const reported = [];
  const progress = new Function("report", slice("let said = null;", "said = k; };") + "; return progress;")((k) => reported.push(k));
  ["engine.preparing", "engine.preparing", "engine.deps"].forEach(progress);
  const pipFn = slice("function pip(args, envPath, timeout)", "\n}\n");
  // sh():從原文切出來、換一顆假的 execFile 跑三種收尾——被 timeout 殺、爆 maxBuffer、一般失敗
  let fakeErr = null;
  const sh = new Function("execFile", "process", "PY_ENV", slice("function sh(cmd, envPath, timeout = 300000)", "\n}\n") + "; return sh;")(
    (_f, _a, _o, cb) => cb(fakeErr, "", fakeErr && fakeErr.stderr || ""), { env: {} }, {});
  const shMsg = async (e) => { fakeErr = e; try { await sh('"/Users/someone/Blave/venv/bin/python" -m pip', "", 5000); return "(resolved)"; } catch (x) { return x.message; } };
  const killed = await shMsg(Object.assign(new Error('Command failed: /bin/sh -c "/Users/someone/Blave/venv/bin/python" -m pip'), { killed: true, signal: "SIGTERM" }));
  const big = await shMsg(Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
  const plain = await shMsg(Object.assign(new Error("Command failed"), { stderr: "ERROR: boom" }));
  for (const [ok, what] of [
    [/const SDK_PINS = `\$\{AGENT_SDK\} cryptography==48\.0\.1`;/.test(mainSrc), "SDK 與 cryptography==48.0.1 一起釘(最後一版 universal2 wheel)"],
    [/const PIP_INSTALL = "-m pip -q --isolated install --only-binary=:all:";/.test(mainSrc), "PIP_INSTALL 帶 --isolated 與 --only-binary=:all:"],
    [pipCmds.length === 1 && pipCmds[0] === '`"${VENV_PY}" ${PIP_INSTALL} ${args}`' && pipFn.includes(pipCmds[0]) && !/-m pip(?! -q --isolated)/.test(mainSrc.replace(/\/\/.*$/gm, "")), "引擎唯一一條 pip 指令在 pip() 裡走 PIP_INSTALL,沒有另起的 -m pip"],
    [/await pip\(SDK_PINS, envPath, \d+\);/.test(mainSrc) && /await pip\(WORKSPACE_DEPS\.join\(" "\), envPath, \d+\);/.test(mainSrc), "SDK 與 workspace deps 兩條都經 pip()"],
    [/!== SDK_PINS\)/.test(mainSrc) && /writeFileSync\(sdkMark, SDK_PINS\)/.test(mainSrc), ".blave-sdk 記號檔比、寫整串 SDK_PINS"],
    [/console\.error\("\[engine\] pip install failed:"[\s\S]*throw new Error\(pipError\(e\)\);/.test(pipFn), "pip() 失敗先 console.error(\"[engine]\" …) 留痕,再丟 pipError 修剪過的"],
    [trimmed === "ERROR: Could not find a version that satisfies the requirement cryptography==50.0.1\nERROR: No matching distribution found for cryptography==50.0.1", "pipError 只留 ERROR 行、去掉 (from versions: …) 那串"],
    [pipError(new Error("a\nb\nc\nd")) === "b\nc\nd", "pipError 沒有 ERROR 行時留最後三行"],
    [killed === "timed out after 5s", "sh() 被 timeout 殺 → 「timed out after Ns」,不是整條指令(→ " + killed + ")"],
    [big === "output too large", "sh() 爆 maxBuffer → 「output too large」(→ " + big + ")"],
    [plain === "ERROR: boom", "sh() 一般失敗仍把 stderr 原樣丟出"],
    [reported.join(",") === "engine.preparing,engine.deps", "「正在準備引擎」建 venv + 裝 SDK 只印一次"],
    [/faultCard\(\)\.set\(\{ text: t\("turn\.engineFailed"/.test(appSrc) && !/addMsg\("sys", t\("turn\.engineFailed"/.test(appSrc), "引擎準備失敗畫失敗卡(紅記號),不是灰字"],
  ]) { console.log((ok ? "PASS  " : "FAIL  ") + what); if (!ok) red++; }
  process.exit(red ? 1 : 0);
})();
process.on("beforeExit", () => { console.log("FAIL  非同步測試沒有跑到結尾"); process.exit(1); });
