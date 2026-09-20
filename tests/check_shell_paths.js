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
}
process.exit(red ? 1 : 0);
