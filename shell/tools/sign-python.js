// afterPack hook:隨包 Python 的 Mach-O 自己簽(electron-builder 的 signIgnore 把整個 python-*/ 排除)。
// 為什麼不交給 electron-builder:它只有「主程式 / 其餘」兩份 entitlements,而 python 執行檔需要的
// 那一條(見 build/entitlements.python.plist)不該給 Electron 本體。
// 這支跑在翻 fuses 與簽 .app 之前,所以外層的 seal 蓋到的就是這裡簽完的檔。
// 簽章前先把隨包 Python 的標準庫預編成 unchecked-hash 的 .pyc:外部程序(例如 IDE 掃直譯器)就地跑包裡的
// python3 時快取永遠有效、不寫檔——封裝後 bundle 多一個檔 codesign --verify --strict 就不過。
// 預編完的檔案清單寫到 <appOutDir>.python-files.txt(路徑相對 Contents/Resources,兩顆都在同一份),
// release.js 與 tests/check_shell_paths.js 拿它比對產物。
// app 自己跑 Python 走 PYTHONPYCACHEPREFIX,不讀也不寫這裡的 __pycache__。
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// universal 包兩顆都隨包(tools/fetch-python.sh);main.js 啟動時照 process.arch 挑
const PY_ARCHES = ["arm64", "x64"];

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
function rmPycaches(roots) {
  for (const r of roots) for (const d of pycaches(r)) fs.rmSync(d, { recursive: true, force: true });
}
function files(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, base, out); else out.push(path.relative(base, p));
  }
  return out;
}
const resourcesOf = (appDir) => path.join(appDir, "Contents", "Resources");
const pyRootsOf = (appDir) => PY_ARCHES.map((a) => path.join(resourcesOf(appDir), `python-${a}`));
const manifestOf = (appOutDir) => `${appOutDir}.python-files.txt`;
// 產物的隨包 Python 裡,清單上沒有的檔(封裝後才被寫進來的)。沒有清單 = 不是這支 hook 產的,整份算多出來。
// 回傳的路徑相對 Contents/Resources(例:python-arm64/lib/…)
function extraPythonFiles(appOutDir) {
  const m = manifestOf(appOutDir);
  const known = new Set(fs.existsSync(m) ? fs.readFileSync(m, "utf8").split("\n").filter(Boolean) : []);
  const app = path.join(appOutDir, "Blave.app");
  return pyRootsOf(app).filter(fs.existsSync).flatMap((r) => files(r, resourcesOf(app))).filter((f) => !known.has(f));
}

async function signPython(context) {
  if (context.electronPlatformName !== "darwin") return;
  // universal:electron-builder 先各打一份 x64 / arm64 中間包(appOutDir 是 <out>-x64-temp / -arm64-temp,
  // 見 app-builder-lib macPackager.doUniversalPack),每份都會叫一次 afterPack,合併完再叫一次。
  // 中間包不能動:預編出的 .pyc 帶著各自的絕對路徑(co_filename),兩邊 SHA 不同,@electron/universal 會拒絕合併。
  // 只在合併後那一次做預編與簽章。
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const roots = pyRootsOf(app);
  for (const r of roots) if (!fs.existsSync(r)) throw new Error(`sign-python: 隨包 Python 不在 ${r}(先跑 npm run fetch-python)`);
  // 複製進來之後被外部程序寫的(掃描器在 python3 出現的一秒內就跑)先清掉——中間包也要:@electron/universal 要兩包
  // 檔案清單一致,一邊多出一個 .pyc 整個合併就炸
  rmPycaches(roots);
  if (/-(x64|arm64)-temp$/.test(context.appOutDir)) return;
  // 預編一律用打包機能原生跑的那顆(bytecode 跟架構無關,同一版 CPython 編出來的一樣);
  // 另一顆不靠 Rosetta 跑,打包機沒裝 Rosetta 也打得出來
  const hostPy = path.join(resourcesOf(app), `python-${process.arch}`, "bin", "python3");
  for (const pyRoot of roots) {
    // 掃描器寫的可能是別的最佳化等級:編之前再清一次才確定
    rmPycaches([pyRoot]);
    // -I:打包機的 PYTHON* 變數(PYTHONOPTIMIZE 會只產 .opt-1、PYTHONPATH 會換掉 compileall 本身)一律不吃。
    // -f:直譯器啟動時自己 import 的模組(encodings、json…)會先寫成時間戳版,compileall 看它「已是最新」就跳過
    execFileSync(hostPy, ["-I", "-m", "compileall", "-q", "-f", "-o", "0", "--invalidation-mode", "unchecked-hash", path.join(pyRoot, "lib")], { stdio: "inherit" });
  }
  fs.writeFileSync(manifestOf(context.appOutDir), roots.flatMap((r) => files(r, resourcesOf(app))).sort().join("\n") + "\n");
  const identity = process.env.BLAVE_MAC_IDENTITY;
  if (identity) for (const r of roots) sign(r, identity);
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
  console.log(`  • sign-python: ${path.basename(pyRoot)} ${all.length} 個 Mach-O 已簽`);
}

module.exports = signPython;
module.exports.extraPythonFiles = extraPythonFiles;
module.exports.PY_ARCHES = PY_ARCHES;
