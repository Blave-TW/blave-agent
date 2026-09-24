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
process.exit(red ? 1 : 0);
