// afterPack hook:隨包 Python 的 Mach-O 自己簽(electron-builder 的 signIgnore 把整個 python/ 排除)。
// 為什麼不交給 electron-builder:它只有「主程式 / 其餘」兩份 entitlements,而 python 執行檔需要的
// 那一條(見 build/entitlements.python.plist)不該給 Electron 本體。
// 這支跑在翻 fuses 與簽 .app 之前,所以外層的 seal 蓋到的就是這裡簽完的檔。
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

module.exports = async function signPython(context) {
  const identity = process.env.BLAVE_MAC_IDENTITY;
  if (context.electronPlatformName !== "darwin" || !identity) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const pyRoot = path.join(app, "Contents", "Resources", "python");
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
};
