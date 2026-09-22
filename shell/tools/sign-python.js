// afterPack hook:隨包 Python 的 Mach-O 自己簽(electron-builder 的 signIgnore 把整個 python/ 排除)。
// 為什麼不交給 electron-builder:它只有「主程式 / 其餘」兩份 entitlements,而 python 執行檔需要的
// 那一條(見 build/entitlements.python.plist)不該給 Electron 本體。
// 這支跑在翻 fuses 與簽 .app 之前,所以外層的 seal 蓋到的就是這裡簽完的檔。
// 簽章前先把隨包 Python 的標準庫預編成 unchecked-hash 的 .pyc:外部程序(例如 IDE 掃直譯器)就地跑包裡的
// python3 時快取永遠有效、不寫檔——封裝後 bundle 多一個檔 codesign --verify --strict 就不過。
// 預編完的檔案清單寫到 <appOutDir>.python-files.txt,release.js 與 tests/check_shell_paths.js 拿它比對產物。
// app 自己跑 Python 走 PYTHONPYCACHEPREFIX,不讀也不寫這裡的 __pycache__。
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MACHO = new Set(["cffaedfe", "cefaedfe", "cafebabe", "feedfacf", "feedface"]);
function isMachO(f) {
  const fd = fs.openSync(f, "r"), b = Buffer.alloc(4);
  try { fs.readSync(fd, b, 0, 4, 0); } finally { fs.closeSync(fd); }
  return MACHO.has(b.toString("hex"));
}
function machos(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) machos(p, out);
    else if (e.isFile() && isMachO(p)) out.push(p);
  }
  return out;
}

function pycaches(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.name === "__pycache__") out.push(p); else pycaches(p, out);
  }
  return out;
}
function files(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, base, out); else out.push(path.relative(base, p));
  }
  return out;
}
const pyRootOf = (appOutDir) => path.join(appOutDir, "Blave.app", "Contents", "Resources", "python");
const manifestOf = (appOutDir) => `${appOutDir}.python-files.txt`;
// 產物的隨包 Python 裡,清單上沒有的檔(封裝後才被寫進來的)。沒有清單 = 不是這支 hook 產的,整份算多出來
function extraPythonFiles(appOutDir) {
  const m = manifestOf(appOutDir);
  const known = new Set(fs.existsSync(m) ? fs.readFileSync(m, "utf8").split("\n").filter(Boolean) : []);
  return files(pyRootOf(appOutDir)).filter((f) => !known.has(f));
}

async function signPython(context) {
  if (context.electronPlatformName !== "darwin") return;
  const pyRoot = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources", "python");
  // 複製進來之後被外部程序寫的(掃描器在 python3 出現的一秒內就跑),可能是別的最佳化等級:清掉重編才確定
  for (const d of pycaches(pyRoot)) fs.rmSync(d, { recursive: true, force: true });
  // -I:打包機的 PYTHON* 變數(PYTHONOPTIMIZE 會只產 .opt-1、PYTHONPATH 會換掉 compileall 本身)一律不吃。
  // -f:直譯器啟動時自己 import 的模組(encodings、json…)會先寫成時間戳版,compileall 看它「已是最新」就跳過
  execFileSync(path.join(pyRoot, "bin", "python3"), ["-I", "-m", "compileall", "-q", "-f", "-o", "0", "--invalidation-mode", "unchecked-hash", path.join(pyRoot, "lib")], { stdio: "inherit" });
  fs.writeFileSync(manifestOf(context.appOutDir), files(pyRoot).sort().join("\n") + "\n");
  const identity = process.env.BLAVE_MAC_IDENTITY;
  if (identity) sign(pyRoot, identity);
}

function sign(pyRoot, identity) {
  const exe = fs.realpathSync(path.join(pyRoot, "bin", "python3"));
  const ent = path.join(__dirname, "..", "build", "entitlements.python.plist");
  const all = machos(pyRoot);
  // 函式庫先、執行檔最後;entitlements 只對執行檔有意義。
  for (const f of all.filter((p) => p !== exe).concat(exe)) {
    const args = ["--force", "--timestamp", "--options", "runtime", "--sign", `Developer ID Application: ${identity}`];
    if (f === exe) args.push("--entitlements", ent);
    execFileSync("codesign", [...args, f], { stdio: "inherit" });
  }
  console.log(`  • sign-python: ${all.length} 個 Mach-O 已簽`);
}

module.exports = signPython;
module.exports.extraPythonFiles = extraPythonFiles;
