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
  // 目錄模組(require("./browser") → browser/index.js)要整個目錄進包
  const isDir = (m) => require("fs").existsSync(require("path").join(__dirname, "..", "shell", m.replace(/\.js$/, ""), "index.js"));
  const missing = mods.filter((m) => !filesLine.includes('"' + m + '"') && !(isDir(m) && filesLine.includes('"' + m.replace(/\.js$/, "") + '/**/*"')));
  const ok = mods.length >= 5 && missing.length === 0;
  console.log((ok ? "PASS  " : "FAIL  ") + "main.js require 的自家模組都在 files 裡" + (missing.length ? " → 缺 " + missing.join(", ") : "")); if (!ok) red++; }   // 不能用 exitCode:結尾的 process.exit(red ? 1 : 0) 會把它蓋回 0
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
    [/`python-\$\{process\.arch\}`, "bin", "python3"/.test(mainSrc) && /`python-\$\{process\.arch\}`, "python\.exe"/.test(mainSrc), "main.js 照 process.arch 挑隨包 Python(darwin bin/python3、win32 python.exe)"],
  ]) { console.log((ok ? "PASS  " : "FAIL  ") + what); if (!ok) red++; }
}
// Windows x64(沒有 Windows 機器:目標平台與旗標都是假造的參數):NSIS 而不是 MSI、oneClick per-user、icon.ico、隨包 Python 依平台切、
// mac 專用的簽章 / 公證守門只在 mac 是目標時才查(不然 Windows runner 打 win 包會被要求 Apple 憑證)
{
  const pkg = JSON.parse(fs.readFileSync(path.join(SHELL, "package.json"), "utf8"));
  const fetchSh = fs.readFileSync(path.join(SHELL, "tools", "fetch-python.sh"), "utf8");
  const fn = cfg.match(/^function targets\(argv, platform\) \{[\s\S]*?\n\}/m);
  const targets = fn ? new Function(fn[0] + "; return targets;")() : null;
  const ico = (f) => { try { const b = fs.readFileSync(f); const n = b.readUInt16LE(4), sizes = []; for (let i = 0; i < n; i++) sizes.push(b[6 + i * 16] || 256); return b.readUInt32LE(0) === 0x00010000 ? sizes.sort((x, y) => x - y) : null; } catch (_) { return null; } };
  const winBlock = (cfg.match(/\n  win: \{[\s\S]*?\n  \},/) || [""])[0], macBlock = (cfg.match(/\n  mac: \{[\s\S]*?\n  \},/) || [""])[0];
  const sp = (env) => require("child_process").spawnSync(process.execPath, ["-e", 'require(process.argv[1])', path.join(SHELL, "electron-builder.config.js"), ...(env.ARGV || "").split(" ").filter(Boolean)], { encoding: "utf8", env: { ...process.env, BLAVE_MAC_IDENTITY: "", BLAVE_RELEASE: "", BLAVE_UPDATE_URL: "", APPLE_API_KEY: "", APPLE_API_KEY_ID: "", APPLE_API_ISSUER: "", BLAVE_WIN_PUBLISHER: "", ...env } });
  for (const [ok, what] of [
    [!!targets && JSON.stringify(targets(["--win", "nsis", "--x64"], "darwin")) === '{"mac":false,"win":true}' && JSON.stringify(targets(["-w"], "darwin")) === '{"mac":false,"win":true}', "targets:--win / -w → 只有 win(在 mac 上交叉打包也一樣)"],
    [!!targets && JSON.stringify(targets(["--mac", "dir", "--universal"], "win32")) === '{"mac":true,"win":false}' && targets(["--mac", "--win"], "linux").mac && targets(["--mac", "--win"], "linux").win, "targets:--mac → mac;兩個都寫 → 兩個都是"],
    [!!targets && JSON.stringify(targets([], "darwin")) === '{"mac":true,"win":false}' && JSON.stringify(targets([], "win32")) === '{"mac":false,"win":true}' && JSON.stringify(targets(["--linux"], "darwin")) === '{"mac":false,"win":false}', "targets:沒寫旗標 = 打包機自己的平台;--linux 兩個都不是"],
    [/if \(T\.mac && RELEASE && !IDENTITY\)/.test(cfg) && /if \(T\.mac && IDENTITY && !RELEASE\)/.test(cfg) && /if \(T\.mac && RELEASE && !NOTARIZE && /.test(cfg), "mac 的三道守門(identity / 反向 / 公證)都掛在 T.mac 上"],
    [sp({ BLAVE_RELEASE: "1", BLAVE_NO_AUTOUPDATE: "1", BLAVE_WIN_PUBLISHER: "Blave Inc.", ARGV: "--win nsis --x64" }).status === 0, "真的 require 一次:release + --win、沒有 Apple 憑證 → 不 throw"],
    [/release\(win\)要設 BLAVE_WIN_PUBLISHER/.test((sp({ BLAVE_RELEASE: "1", BLAVE_NO_AUTOUPDATE: "1", ARGV: "--win nsis" }).stderr || "")), "release + --win 沒有 BLAVE_WIN_PUBLISHER → throw(不簽的更新包 electron-updater 不驗章)"],
    [sp({ BLAVE_RELEASE: "1", BLAVE_NO_AUTOUPDATE: "1", BLAVE_WIN_UNSIGNED: "1", ARGV: "--win nsis" }).status === 0, "BLAVE_WIN_UNSIGNED=1 明說不簽才放行"],
    [/release 要設 BLAVE_MAC_IDENTITY/.test(sp({ BLAVE_RELEASE: "1", BLAVE_NO_AUTOUPDATE: "1", ARGV: "--mac" }).stderr || ""), "release + --mac 沒有 identity → 照舊 throw(mac 守門沒被拿掉)"],
    [/release 要設 BLAVE_UPDATE_URL/.test(sp({ BLAVE_RELEASE: "1", BLAVE_WIN_PUBLISHER: "x", ARGV: "--win" }).stderr || ""), "更新來源那道守門兩個平台都在"],
    [/target: \[\{ target: "nsis", arch: \["x64"\] \}\]/.test(winBlock) && /icon: "build\/icon\.ico"/.test(winBlock), "win:只出 NSIS x64、icon.ico"],
    [/artifactName: "Blave-Setup-\$\{version\}\.\$\{ext\}"/.test(winBlock) && !/artifactName/.test(macBlock), "win:artifactName 是 Blave-Setup-x.y.z.exe(無空白;mac 不動)"],
    [/nsis: \{ oneClick: true, perMachine: false \}/.test(cfg), "nsis:oneClick、per-user(不彈 UAC,自動更新不需管理員)"],
    [/\.\.\.\(WIN_PUBLISHER \? \{ publisherName: WIN_PUBLISHER \} : \{\}\)/.test(winBlock) && /const WIN_PUBLISHER = process\.env\.BLAVE_WIN_PUBLISHER \|\| null;/.test(cfg), "publisherName 只從 process.env.BLAVE_WIN_PUBLISHER 來"],
    [/from: "vendor\/python-win-x64", to: "python-x64"/.test(winBlock) && !/python-win-x64/.test(macBlock) && /from: "vendor\/python-arm64", to: "python-arm64"/.test(macBlock) && !/python-arm64/.test(winBlock), "隨包 Python 依平台切:win 只收 python-win-x64 → python-x64,mac 只收 arm64 / x64 那兩顆"],
    [!/^\s*\{ from: "vendor\/python-/m.test(cfg.slice(cfg.indexOf("extraResources: ["), cfg.indexOf("mac: {"))), "頂層 extraResources 只有 agent(Python 都在平台區塊)"],
    [/^fetch win-x64 x86_64-pc-windows-msvc [0-9a-f]{64}$/m.test(fetchSh), "fetch-python.sh 釘了 x86_64-pc-windows-msvc 那顆、帶 64 hex 的 SHA256"],
    [/--win nsis --x64/.test(pkg.scripts["pack:win"] || "") && /fetch-python/.test(pkg.scripts["pack:win"] || ""), "package.json 有 pack:win(先抓 Python,再 --win nsis --x64)"],
    [(() => { const s = ico(path.join(SHELL, "build", "icon.ico")); return !!s && s[0] === 16 && s[s.length - 1] === 256; })(), "build/icon.ico 是 ICO、含 16 與 256"],
    [(() => { const s = ico(path.join(SHELL, "assets", "tray.ico")); return !!s && s.join() === "16,24,32"; })(), "assets/tray.ico 是 ICO、16 / 24 / 32 三階(工作列 100% / 150% / 200%)"],
  ]) { console.log((ok ? "PASS  " : "FAIL  ") + what); if (!ok) red++; }
}
// 安裝目錄(0.1.3 真機裝進 %LOCALAPPDATA%\Programs\blave-desktop):one-click per-user 的目錄名是 package name,不是 productName
// (app-builder-lib targetUtil.getWindowsInstallationDirName 只在 assisted / per-machine 才用 productFilename)。修法是打 win 包時
// 用 extraMetadata 蓋 name;package.json 的 name 不動(開發版 userData、mac 的 updater 快取目錄都掛在它上面)。真的 require 一次看結果。
{
  const meta = (argv) => { const r = require("child_process").spawnSync(process.execPath, ["-e", 'console.log(JSON.stringify(require(process.argv[1]).extraMetadata || null))', path.join(SHELL, "electron-builder.config.js"), ...argv],
    { encoding: "utf8", env: { ...process.env, BLAVE_MAC_IDENTITY: "", BLAVE_RELEASE: "", BLAVE_UPDATE_URL: "", APPLE_API_KEY: "", APPLE_API_KEY_ID: "", APPLE_API_ISSUER: "", BLAVE_WIN_PUBLISHER: "" } }); return r.status === 0 ? JSON.parse(r.stdout.trim()) : { error: r.stderr }; };
  const pkg = JSON.parse(fs.readFileSync(path.join(SHELL, "package.json"), "utf8")), mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
  const win = meta(["--win", "nsis", "--x64"]), mac = meta(["--mac", "dir", "--universal"]), both = meta(["--mac", "--win"]);
  for (const [ok, what] of [
    [win && win.name === "Blave", "--win:extraMetadata.name = Blave(安裝目錄 %LOCALAPPDATA%\\Programs\\Blave)→ " + JSON.stringify(win)],
    [mac === null, "--mac:extraMetadata 不存在(mac 的 name / 產物 / updater 快取目錄一個都不動)→ " + JSON.stringify(mac)],
    [both === null || !("name" in both), "--mac --win 同一次:不蓋 name(mac 不能碰)"],
    [pkg.name === "blave-desktop" && /if \(app\.isPackaged\) app\.setName\("Blave"\)/.test(mainSrc), "package.json 的 name 仍是 blave-desktop、main.js 打包版仍 setName(\"Blave\")(userData 兩個平台都還是 Blave)"],
    [/nsis: \{ oneClick: true, perMachine: false \}/.test(cfg), "nsis 區塊沒多任何安裝目錄選項(沒有這種選項);仍是 oneClick per-user"],
  ]) { console.log((ok ? "PASS  " : "FAIL  ") + what); if (!ok) red++; }
}
// Intel / Rosetta(0.0.6 通用版實測):SDK → mcp → pyjwt[crypto] 拉進 cryptography,50.x 起 macOS 只出 arm64 wheel,x64 退到
// 編原始碼(maturin 會自己抓一套 Rust 下來編,幾分鐘)、venv 半套。引擎的每一條 pip 都只收 wheel(--only-binary=:all:,
// 沒 wheel 就兩秒內大聲失敗)且 --isolated(不吃用戶 pip.conf / PIP_*),cryptography 釘 48.0.1(最後一版 universal2 wheel),
// 記號檔比整串釘法才會在既有 venv 上重跑。失敗要留痕、進畫面的字要說得出原因、不帶用戶路徑。
// 0.1.12 起 pip 在 shell/enginesetup.js(逐行讀進度、一個一個裝);它自己的行為在 tests/check_shell_engine_setup.js,這裡只釘「唯一一條」與釘法
(async () => {
  const mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
  const appSrc = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
  const engSrc = fs.readFileSync(path.join(SHELL, "enginesetup.js"), "utf8");
  const E = require(path.join(SHELL, "enginesetup.js"));
  const code = (x) => x.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const venvPy = "/Users/someone/Blave/venv/bin/python";
  // 假的 spawn:一般失敗;argv 是陣列、沒有 shell(逾時、沒資料太久在 check_shell_engine_setup.js)
  const { EventEmitter } = require("events");
  let seen = null;
  const runOnce = async (o) => {
    const S = E.createEngineSetup({ fs: { existsSync: (f) => f !== venvPy && !/\.blave/.test(f), readFileSync: () => { throw new Error("none"); }, mkdirSync: () => {}, writeFileSync: () => {}, readdirSync: () => [], lstatSync: () => ({ isSymbolicLink: () => false }), unlinkSync: () => {} },
      path, base: "/Users/someone/Blave", ws: "/Users/someone/Blave/workspace", venvPy, venvBin: "bin", win: false, basePython: () => "python3", envPath: async () => "", pyEnv: {}, copyOfficial: () => {}, isPackaged: true,
      sdkPins: "claude-agent-sdk==0.2.144 cryptography==48.0.1", deps: ["pandas==3.0.6"], firstRunMB: 200, venvMs: 5000, engineMs: 5000, pkgMs: 5000, onChange: () => {}, log: () => {},
      spawn: (bin, args, opt) => {
        const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => setImmediate(() => c.emit("close", null));
        if (args.includes("venv")) { setImmediate(() => c.emit("close", 0)); return c; }
        seen = { bin, args, shell: !!opt.shell, hide: opt.windowsHide };
        setImmediate(() => { if (o.stderr) c.stderr.emit("data", o.stderr); c.emit("close", 1); });
        return c;
      } });
    try { await S.ensure(); return "(resolved)"; } catch (x) { return x.message; }
  };
  const plain = await runOnce({ stderr: "ERROR: boom\nsecond line" });
  for (const [ok, what] of [
    [/const SDK_PINS = `\$\{AGENT_SDK\} cryptography==48\.0\.1`;/.test(mainSrc), "SDK 與 cryptography==48.0.1 一起釘(最後一版 universal2 wheel)"],
    [/const PIP_INSTALL = \["-m", "pip", "--isolated", "--disable-pip-version-check", "install", "--only-binary=:all:", "--progress-bar=raw"\];/.test(engSrc), "PIP_INSTALL 帶 --isolated 與 --only-binary=:all:(不帶 -q:會關掉進度)"],
    [(code(engSrc).match(/\.\.\.PIP_INSTALL/g) || []).length === 1 && /await run\(o\.venvPy, \[\.\.\.PIP_INSTALL, \.\.\.args\]/.test(engSrc) && !/-m", "pip/.test(code(engSrc).replace(/const PIP_INSTALL = [^\n]*/, "")) && !/-m pip|"pip"/.test(code(mainSrc)), "引擎唯一一條 pip 指令在 enginesetup 的 pip() 裡走 PIP_INSTALL,main.js 沒有另起的 -m pip"],
    [seen && seen.bin === venvPy && seen.args.slice(0, 7).join(" ") === E.PIP_INSTALL.join(" ") && seen.shell === false && seen.hide === true, "pip 用 venv 的 python、argv 陣列直接交給 spawn、不開 shell、帶 windowsHide"],
    [plain === "ERROR: boom", "一般失敗丟修剪過的 ERROR 行(→ " + plain + ")"],
    [/sdkPins: SDK_PINS, deps: WORKSPACE_DEPS/.test(mainSrc) && /read\(sdkMark\) !== o\.sdkPins/.test(engSrc) && /fs\.writeFileSync\(sdkMark, o\.sdkPins\)/.test(engSrc), ".blave-sdk 記號檔比、寫整串 SDK_PINS"],
    [/o\.log\("\[engine\] pip install failed: "/.test(engSrc), "pip 失敗先把完整 stderr 留在主行程的 log,再丟修剪過的"],
    [!/"\/bin\/sh"/.test(mainSrc) && !/function sh\(/.test(mainSrc), "main.js 沒有 /bin/sh -c 的 sh() 了(Windows 沒有 /bin/sh)"],
    [/faultCard\(\)\.set\(\{ text: t\("turn\.engineFailed"/.test(appSrc) && !/addMsg\("sys", t\("turn\.engineFailed"/.test(appSrc), "引擎準備失敗(卡上沒畫出來的那種)畫失敗卡(紅記號),不是灰字"],
  ]) { console.log((ok ? "PASS  " : "FAIL  ") + what); if (!ok) red++; }
  process.exit(red ? 1 : 0);
})();
process.on("beforeExit", () => { console.log("FAIL  非同步測試沒有跑到結尾"); process.exit(1); });
