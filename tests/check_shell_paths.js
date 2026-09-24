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

let OFFICIAL = null;   // 官方檔清單(下面的新鮮度檢查也要用):check() 裡是區域變數,帶出來一份
function check(mode, isPackaged, resourcesPath) {
  const app = { isPackaged }, __dirname = SHELL;          // main.js 原文吃這兩個名字
  const process = { resourcesPath };
  eval(cut("const resourceRoot", "const REPO"));
  eval(cut("const OFFICIAL_DIRS", "function copyOfficial"));
  OFFICIAL = { dirs: OFFICIAL_DIRS, files: OFFICIAL_FILES };
  const root = resourceRoot();
  for (const d of OFFICIAL_DIRS)
    t(`${mode}: ${d}/ 在`, fs.existsSync(path.join(root, d)) && fs.readdirSync(path.join(root, d)).length > 0);
  for (const f of [...OFFICIAL_FILES, "runtime/agent_turn.py", "runtime/VERSION"])
    t(`${mode}: ${f} 在`, fs.existsSync(path.join(root, f)));
  return root;
}

check("dev", false, undefined);

const dist = path.join(SHELL, "dist");
// universal 打包中途壞掉會留下 mac-universal-{x64,arm64}-temp:那不是產物,不拿它測
const appDir = fs.existsSync(dist) && fs.readdirSync(dist).filter((d) => /^mac/.test(d) && !/-temp$/.test(d))
  .map((d) => path.join(dist, d, "Blave.app")).find((p) => fs.existsSync(p));
const PY_ARCHES = require(path.join(SHELL, "tools", "sign-python.js")).PY_ARCHES;
const sp = (cmd, args) => require("child_process").spawnSync(cmd, args, { encoding: "utf8" });
if (!appDir) console.log("SKIP  packaged: shell/dist 沒有 .app(先跑 cd shell && npm run pack)");
else {
  const res = path.join(appDir, "Contents", "Resources");
  const root = check("packaged", true, res);
  t("packaged: app.asar 在", fs.existsSync(path.join(res, "app.asar")));
  // universal:主程式一定要同時有 arm64 與 x86_64(只有一種 = CLI 沒帶 --universal,dmg 在另一種 Mac 上開不了)
  const archsOf = (f) => (sp("lipo", ["-archs", f]).stdout || "").trim().split(/\s+/).filter(Boolean).sort().join("+");
  t("packaged: 主程式是 universal(arm64+x86_64)→ " + archsOf(path.join(appDir, "Contents", "MacOS", "Blave")),
    archsOf(path.join(appDir, "Contents", "MacOS", "Blave")) === "arm64+x86_64");
  // 兩顆隨包 Python 都在、可執行、而且各是自己那個架構(拿錯顆 = main.js 照 process.arch 挑到的直譯器起不來)
  const machArch = { arm64: "arm64", x64: "x86_64" };
  for (const a of PY_ARCHES) {
    const py = path.join(res, `python-${a}`, "bin", "python3");
    t(`packaged: 隨包 python-${a}/bin/python3 可執行`, (() => { try { fs.accessSync(py, fs.constants.X_OK); return true; } catch (_) { return false; } })());
    t(`packaged: python-${a} 的直譯器是 ${machArch[a]}(→ ${fs.existsSync(py) ? archsOf(fs.realpathSync(py)) : "不在"})`,
      fs.existsSync(py) && archsOf(fs.realpathSync(py)) === machArch[a]);
  }
  t("packaged: shell/vendor 兩顆 Python 都抓好了(fetch-python.sh)", PY_ARCHES.every((a) => fs.existsSync(path.join(SHELL, "vendor", `python-${a}`, ".blave-pbs"))));
  // 主程式跑得起來的那顆,實際叫一次(-I:不吃打包機的 PYTHON* 變數)
  const native = sp(path.join(res, `python-${process.arch}`, "bin", "python3"), ["-I", "-c", "import sys, platform; print(sys.version_info[:3], platform.machine())"]);
  t("packaged: 本機架構那顆 Python 跑得起來 → " + (native.stdout || native.stderr || "").trim(), native.status === 0 && /3, 12/.test(native.stdout));
  /* 「這個產物是不是跟現在的原始碼同一份」——三條都在問同一件事,所以一起開關。
     平常開發時 dist/ 本來就會落後(改一行 renderer 就落後了),硬紅只會訓練大家忽略它——
     而「被忽略」正是 2026-09-23 那次打包壞掉活了一整天的原因。所以照這個檔既有的做法
     (簽章那段看產物自己是什麼),用產物的性質決定要不要硬:
       · Developer ID 簽章的產物 = 發佈流程剛建好的那一份(tools/release.js 簽完才跑這支)→ 硬。
       · 要拿 pack 的產物去實測:BLAVE_CHECK_PACK=1 → 硬。**npm run pack / npm run dist 打完就自己跑這支**
         (shell/package.json),不靠人記得——2026-09-23 那次壞掉的正是 pack 這條路徑。
       · 其餘(平常開發)→ 整組 SKIP,而且把「本來會檢查什麼」寫出來,免得被當成沒有這個檢查。
     其他 packaged 斷言(隨包 python、沒有本機資料、預編 .pyc)問的是產物本身長得對不對,
     跟新不新無關,照舊無條件跑。 */
  const dv = (f) => require("child_process").spawnSync("codesign", ["-dvv", "--entitlements", "-", "--xml", f], { encoding: "utf8" });
  const appInfo = dv(appDir);
  const signedArtifact = /Authority=Developer ID Application/.test(appInfo.stderr);
  const freshStrict = signedArtifact || process.env.BLAVE_CHECK_PACK === "1";
  if (!freshStrict) {
    console.log("SKIP  packaged(新鮮度三條):VERSION 與 repo 同版 / 隨包官方檔逐 byte 相同 / app.asar 比 shell/ 的來源新"
      + " —— 平常開發不硬擋(dist 本來就會落後)。要檢查:BLAVE_CHECK_PACK=1 node tests/check_shell_paths.js;npm run pack / dist 與發佈流程的簽章產物一律自動檢查");
  } else {
  t("packaged: VERSION 與 repo 同一版",
    fs.readFileSync(path.join(root, "VERSION"), "utf8") === fs.readFileSync(path.join(SHELL, "..", "VERSION"), "utf8"));
  /* 產物有沒有真的跟上原始碼。打包那一步失敗時 dist/ 會留著**上一次**的 .app:VERSION 沒動的那種改動,
     光比版號看不出來,log 掃過去也像成功(2026-09-23 的 ERR_REQUIRE_ESM 就是這樣過了一整天)。
     ① 內容:隨包的每一個官方檔都要跟 repo 逐 byte 相同;② 時間:app.asar 要比 shell/ 的來源新。
     清單**從 git 列舉**,不是走產物有什麼就比什麼:electron-builder 的 extraResources 用的就是
     `git ls-files`(shell/electron-builder.config.js 的 tracked),所以「追蹤中的檔」正是應該在包裡的檔,
     少一個就是包漏了。舊版只比兩邊都存在的檔——產物裡整個檔不見會被當成沒事(稽核的那個洞)。
     `runtime/` 也在這份清單裡:它跟 lib/ 一樣照 `tracked` 隨包(electron-builder 的 SHIP),
     但不在 main.js 的 OFFICIAL_DIRS(那份是啟動時複製進 workspace 的),漏掉的話
     「包裡的 runtime 比 repo 舊」沒有人會發現——跟 stale lib/ 是同一類失敗。 */
  const SHIPPED_DIRS = OFFICIAL.dirs.concat(["runtime"]);
  const REPO_ROOT = path.join(SHELL, "..");
  let tracked = null;
  try {
    tracked = require("child_process").execFileSync(
      "git", ["-C", REPO_ROOT, "ls-files", "-z", "--", ...SHIPPED_DIRS, ...OFFICIAL.files],
      { maxBuffer: 1 << 24 }).toString().split("\0").filter(Boolean);
  } catch (e) { tracked = null; }
  t("packaged: 官方檔清單列得出來(git ls-files;列不出來就沒有這個檢查,不是通過)",
    !!tracked && tracked.length > 0);
  const stale = [], missing = [];
  for (const rel of tracked || []) {
    const b2 = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(b2)) continue;              // 索引有、工作樹已刪:不是產物的問題
    const a2 = path.join(root, rel);
    if (!fs.existsSync(a2)) { missing.push(rel); continue; }
    if (!fs.readFileSync(a2).equals(fs.readFileSync(b2))) stale.push(rel);
  }
  const cut3 = (a) => a.slice(0, 3).join(", ") + (a.length > 3 ? ` 等 ${a.length} 個` : "");
  t("packaged: 追蹤中的官方檔一個都沒漏出包" + (missing.length ? " → " + cut3(missing) : "")
    + (tracked ? `(查了 ${tracked.length} 個)` : ""), !!tracked && missing.length === 0);
  t("packaged: 隨包的官方檔與 repo 逐 byte 相同(產物沒有停在上一次打包)" + (stale.length ? " → " + cut3(stale) : ""), stale.length === 0);
  // app.asar 比 shell/ 的來源新。dist / node_modules / vendor 不算(產物與相依,不是來源)
  const asar = path.join(res, "app.asar");
  let newest = 0, newestFile = "";
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (/^(dist|node_modules|vendor)$/.test(e.name)) continue;
      const p2 = path.join(d, e.name);
      if (e.isDirectory()) walk(p2);
      else if (e.isFile()) { const m = fs.statSync(p2).mtimeMs; if (m > newest) { newest = m; newestFile = path.relative(SHELL, p2); } }
    }
  })(SHELL);
  const asarAt = fs.existsSync(asar) ? fs.statSync(asar).mtimeMs : 0;
  t("packaged: app.asar 比 shell/ 的來源新" + (asarAt < newest ? ` → ${newestFile} 比產物新(重跑 cd shell && npm run pack)` : ""), asarAt >= newest);
  }
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
  // 預編真的做了(兩顆都要):沒有對應 .pyc 的模組,外部程序一 import 就會寫檔
  const pycOf = (p) => path.join(path.dirname(p), "__pycache__", path.basename(p, ".py") + ".cpython-312.pyc");
  // 標頭第 4–7 byte 是 flags:1 = unchecked-hash(不比對原始檔,永遠有效);0 是時間戳版,換機器 mtime 一變就重寫
  const flags = (p) => { const b = Buffer.alloc(8), fd = fs.openSync(p, "r"); fs.readSync(fd, b, 0, 8, 0); fs.closeSync(fd); return b.readUInt32LE(4); };
  for (const a of PY_ARCHES) {
    const pys = [], stdlib = path.join(res, `python-${a}`, "lib", "python3.12");
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== "__pycache__") walk(p); } else if (e.isFile() && e.name.endsWith(".py")) pys.push(p);
      }
    })(stdlib);
    const noPyc = pys.filter((p) => !fs.existsSync(pycOf(p)));
    t(`packaged: python-${a} 每個 .py 都有預編的 .pyc(${pys.length} 個)` + (noPyc.length ? " → " + noPyc.slice(0, 3).join(", ") : ""), pys.length > 0 && noPyc.length === 0);
    const sample = ["json/__init__.py", "encodings/utf_8.py", "os.py"].map((f) => pycOf(path.join(stdlib, f)));
    t(`packaged: python-${a} 預編的 .pyc 是 unchecked-hash`, sample.every((p) => fs.existsSync(p) && flags(p) === 1));
  }

  // 簽章產物(npm run release)才有的斷言;pack 產物是 ad-hoc,整段 SKIP。dv / appInfo 在上面新鮮度那一段就算好了
  if (!signedArtifact) console.log("SKIP  signed: 產物沒有 Developer ID 簽章(npm run release 才有)");
  else {
    const ENT = "com.apple.security.cs.";
    const team = (s) => (s.match(/TeamIdentifier=(\S+)/) || [])[1];
    t("signed: --verify --deep --strict 過", require("child_process")
      .spawnSync("codesign", ["--verify", "--deep", "--strict", appDir]).status === 0);
    t("signed: app 是 hardened runtime", /flags=0x10000\(runtime\)/.test(appInfo.stderr));
    t("signed: app 只有 allow-jit", appInfo.stdout.includes(ENT + "allow-jit")
      && !appInfo.stdout.includes(ENT + "disable-library-validation")
      && !appInfo.stdout.includes(ENT + "allow-unsigned-executable-memory"));
    // 兩顆隨包 Python 分開簽(tools/sign-python.js),所以兩顆分開驗
    for (const a of PY_ARCHES) {
      const pyInfo = dv(fs.realpathSync(path.join(res, `python-${a}`, "bin", "python3")));
      t(`signed: python-${a} 同一個 Team、hardened runtime、有 secure timestamp`,
        team(pyInfo.stderr) && team(pyInfo.stderr) === team(appInfo.stderr)
        && /flags=0x10000\(runtime\)/.test(pyInfo.stderr) && /Timestamp=/.test(pyInfo.stderr));
      t(`signed: python-${a} 只有 disable-library-validation`, pyInfo.stdout.includes(ENT + "disable-library-validation")
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
      })(path.join(res, `python-${a}`));
      t(`signed: python-${a} 的每顆 Mach-O 都是同一個 Team 簽的` + (unsigned.length ? " → " + unsigned.slice(0, 3).join(", ") : ""),
        unsigned.length === 0);
    }
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
