// shell/main.js 的 resourceRoot():開發 / 打包兩種模式下,main.js 會去取的每一個官方檔案
// (OFFICIAL_DIRS / OFFICIAL_FILES、runtime/agent_turn.py、runtime/VERSION)都真的在那裡。
// 打包模式對 shell/dist 的產物測(另查隨包 Python、沒有 gitignored 的本機資料混進包);
// 產物不存在就 SKIP。跑法:node tests/check_shell_paths.js
const fs = require("fs"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const src = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
const cut = (from, to) => {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  if (a < 0 || b < 0) { console.log("FAIL  main.js 裡找不到 " + from); process.exit(1); }
  return src.slice(a, b).replace(/^const /gm, "var ");
};
let red = 0;
const t = (name, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) red++; };

function check(mode, isPackaged, resourcesPath) {
  const app = { isPackaged }, __dirname = SHELL;          // main.js 原文吃這兩個名字
  const process = { resourcesPath };
  eval(cut("const resourceRoot", "const REPO"));
  eval(cut("const OFFICIAL_DIRS", "function copyOfficial"));
  const root = resourceRoot();
  for (const d of OFFICIAL_DIRS)
    t(`${mode}: ${d}/ 在`, fs.existsSync(path.join(root, d)) && fs.readdirSync(path.join(root, d)).length > 0);
  for (const f of [...OFFICIAL_FILES, "runtime/agent_turn.py", "runtime/VERSION"])
    t(`${mode}: ${f} 在`, fs.existsSync(path.join(root, f)));
  return root;
}

check("dev", false, undefined);

const dist = path.join(SHELL, "dist");
const appDir = fs.existsSync(dist) && fs.readdirSync(dist).filter((d) => /^mac/.test(d))
  .map((d) => path.join(dist, d, "Blave.app")).find((p) => fs.existsSync(p));
if (!appDir) console.log("SKIP  packaged: shell/dist 沒有 .app(先跑 cd shell && npm run pack)");
else {
  const res = path.join(appDir, "Contents", "Resources");
  const root = check("packaged", true, res);
  t("packaged: app.asar 在", fs.existsSync(path.join(res, "app.asar")));
  t("packaged: 隨包 python3 可執行", (() => {
    try { fs.accessSync(path.join(res, "python", "bin", "python3"), fs.constants.X_OK); return true; } catch (_) { return false; }
  })());
  t("packaged: VERSION 與 repo 同一版",
    fs.readFileSync(path.join(root, "VERSION"), "utf8") === fs.readFileSync(path.join(SHELL, "..", "VERSION"), "utf8"));
  const leaked = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name === "__pycache__") leaked.push(p); else walk(p); }
      else if (/^(orders\.jsonl|portfolio_config\.json|stats\.json|state\.json|strategy\.log|\.env)$/.test(e.name)) leaked.push(p);
    }
  })(root);
  t("packaged: 沒有本機資料混進包" + (leaked.length ? " → " + leaked.slice(0, 3).join(", ") : ""), leaked.length === 0);
  // sign-python.js 預編完記下的清單(dist/mac-*.python-files.txt):多出來的檔 = 封裝後才被寫進來,簽章會驗不過
  const extra = require(path.join(SHELL, "tools", "sign-python.js")).extraPythonFiles(path.dirname(appDir));
  t("packaged: 隨包 Python 沒有清單外的檔" + (extra.length ? " → " + extra.slice(0, 3).join(", ") : ""), extra.length === 0);
  // 預編真的做了:沒有對應 .pyc 的模組,外部程序一 import 就會寫檔
  const pys = [], stdlib = path.join(res, "python", "lib", "python3.12");
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "__pycache__") walk(p); } else if (e.isFile() && e.name.endsWith(".py")) pys.push(p);
    }
  })(stdlib);
  const pycOf = (p) => path.join(path.dirname(p), "__pycache__", path.basename(p, ".py") + ".cpython-312.pyc");
  const noPyc = pys.filter((p) => !fs.existsSync(pycOf(p)));
  t(`packaged: 隨包 Python 每個 .py 都有預編的 .pyc(${pys.length} 個)` + (noPyc.length ? " → " + noPyc.slice(0, 3).join(", ") : ""), pys.length > 0 && noPyc.length === 0);
  // 標頭第 4–7 byte 是 flags:1 = unchecked-hash(不比對原始檔,永遠有效);0 是時間戳版,換機器 mtime 一變就重寫
  const flags = (p) => { const b = Buffer.alloc(8), fd = fs.openSync(p, "r"); fs.readSync(fd, b, 0, 8, 0); fs.closeSync(fd); return b.readUInt32LE(4); };
  const sample = ["json/__init__.py", "encodings/utf_8.py", "os.py"].map((f) => pycOf(path.join(stdlib, f)));
  t("packaged: 預編的 .pyc 是 unchecked-hash", sample.every((p) => fs.existsSync(p) && flags(p) === 1));

  // 簽章產物(npm run release)才有的斷言;pack 產物是 ad-hoc,整段 SKIP。
  const dv = (f) => require("child_process").spawnSync("codesign", ["-dvv", "--entitlements", "-", "--xml", f], { encoding: "utf8" });
  const appInfo = dv(appDir);
  if (!/Authority=Developer ID Application/.test(appInfo.stderr)) console.log("SKIP  signed: 產物沒有 Developer ID 簽章(npm run release 才有)");
  else {
    const ENT = "com.apple.security.cs.";
    const py = fs.realpathSync(path.join(res, "python", "bin", "python3"));
    const pyInfo = dv(py);
    const team = (s) => (s.match(/TeamIdentifier=(\S+)/) || [])[1];
    t("signed: --verify --deep --strict 過", require("child_process")
      .spawnSync("codesign", ["--verify", "--deep", "--strict", appDir]).status === 0);
    t("signed: app 是 hardened runtime", /flags=0x10000\(runtime\)/.test(appInfo.stderr));
    t("signed: app 只有 allow-jit", appInfo.stdout.includes(ENT + "allow-jit")
      && !appInfo.stdout.includes(ENT + "disable-library-validation")
      && !appInfo.stdout.includes(ENT + "allow-unsigned-executable-memory"));
    t("signed: python 同一個 Team、hardened runtime、有 secure timestamp",
      team(pyInfo.stderr) && team(pyInfo.stderr) === team(appInfo.stderr)
      && /flags=0x10000\(runtime\)/.test(pyInfo.stderr) && /Timestamp=/.test(pyInfo.stderr));
    t("signed: python 只有 disable-library-validation", pyInfo.stdout.includes(ENT + "disable-library-validation")
      && !pyInfo.stdout.includes(ENT + "allow-jit") && !pyInfo.stdout.includes(ENT + "allow-unsigned-executable-memory"));
    // 列舉隨包 Python 底下每一顆 Mach-O:漏簽一顆公證就退件
    const unsigned = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) {
          const b = Buffer.alloc(4), fd = fs.openSync(p, "r"); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd);
          if (["cffaedfe", "cafebabe"].includes(b.toString("hex")) && team(dv(p).stderr) !== team(appInfo.stderr)) unsigned.push(p);
        }
      }
    })(path.join(res, "python"));
    t("signed: 隨包 Python 的每顆 Mach-O 都是同一個 Team 簽的" + (unsigned.length ? " → " + unsigned.slice(0, 3).join(", ") : ""),
      unsigned.length === 0);
    // 有簽章就必須是發佈版:fuses 六顆翻好、asar 裡帶 blaveRelease(main.js 靠它擋 debug port)。
    // 少了這段,「有簽、已公證、但除錯口全開」的產物會整段 PASS(稽核 S1)
    const nm = path.join(__dirname, "..", "shell", "node_modules");
    const pkg = JSON.parse(require(path.join(nm, "@electron", "asar")).extractFile(path.join(res, "app.asar"), "package.json").toString());
    t("signed: asar 內 package.json 帶 blaveRelease", pkg.blaveRelease === true);
    const fw = require("child_process").spawnSync(process.execPath, ["-e",
      `const f=require(${JSON.stringify(path.join(nm, "@electron", "fuses"))});f.getCurrentFuseWire(process.argv[1]).then(w=>console.log(JSON.stringify(w)))`,
      appDir], { encoding: "utf8" });
    let wire = {}; try { wire = JSON.parse(fw.stdout); } catch (_) { /* 讀不到就當沒翻 */ }
    const F = require(path.join(nm, "@electron", "fuses")), want = { RunAsNode: 0, EnableNodeOptionsEnvironmentVariable: 0,
      EnableNodeCliInspectArguments: 0, OnlyLoadAppFromAsar: 1, EnableEmbeddedAsarIntegrityValidation: 1, EnableCookieEncryption: 1 };
    const bad = Object.entries(want).filter(([k, on]) => wire[F.FuseV1Options[k]] !== (on ? 49 : 48)   /* fuse wire 的 ASCII:"1" 開、"0" 關 */).map(([k]) => k);
    t("signed: fuses 六顆照發佈版翻好" + (bad.length ? " → " + bad.join(", ") : ""), bad.length === 0);
    const staple = require("child_process").spawnSync("xcrun", ["stapler", "validate", appDir], { encoding: "utf8" });
    if (staple.status === 0) t("signed: 公證票已 staple", true);
    else console.log("SKIP  signed: .app 沒有 staple 的公證票(BLAVE_SKIP_NOTARIZE 的產物)");
  }
}
process.exit(red ? 1 : 0);
