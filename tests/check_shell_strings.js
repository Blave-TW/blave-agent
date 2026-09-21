/* 桌面版 i18n 的漂移閘門。跑法:node tests/check_shell_strings.js
 *
 * 抓四種會讓用戶看到半成品的錯:
 *   1. en / zh 兩張表的 key 不對齊 —— 少一邊就會在那個語系露出英文或 key。
 *   2. 程式用到但表裡沒有的 key —— t() 會原樣吐 key 到畫面上。
 *   3. renderer 的非註解行裡還留著中文字面 —— 那就是漏翻的字串。
 *   4. strings.js 跟 .po 不同步 —— 翻譯改了但忘了重跑產生器。
 *
 * 第 3 項只掃 renderer(用戶看得到的那層)。main.js 不組句子、只丟穩定代號,
 * 所以它的中文只會出現在註解裡。
 */
const fs = require("fs");
const path = require("path");

const SHELL = path.join(__dirname, "..", "shell");
const read = (p) => fs.readFileSync(path.join(SHELL, p), "utf8");

let bad = 0;
const fail = (msg) => { console.log("FAIL  " + msg); bad++; };
const pass = (msg) => console.log("PASS  " + msg);

// ---- 1. en / zh 對齊 ----
// 用戶看得到的那層:主畫面 + 報告的各個分頁模組(report-*.js 由別的檔負責,
// 沒列進來的話它們的 key 漂移、漏翻的字面都不會被擋到)。
// trade.js(自動下單頁)也是手寫的畫面檔;strings.js 是產生的、i18n.js 不放字串,兩個不掃。
const RENDERER_FILES = ["renderer/app.js", "renderer/index.html",
  ...fs.readdirSync(path.join(SHELL, "renderer")).filter((f) => /^(report-.*|trade|datasrc|handoff)\.js$/.test(f)).map((f) => "renderer/" + f)];

const src = read("renderer/strings.js");
const block = (name) => src.split(`  ${name}: {`)[1].split("\n  },")[0];
const keysOf = (b) => new Set([...b.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
const en = keysOf(block("en"));
const zh = keysOf(block("zh"));
const onlyEn = [...en].filter((k) => !zh.has(k));
const onlyZh = [...zh].filter((k) => !en.has(k));
if (onlyEn.length || onlyZh.length) {
  fail(`en/zh 不對齊 — 只有 en: [${onlyEn}] / 只有 zh: [${onlyZh}]`);
} else {
  pass(`en/zh 各 ${en.size} 個 key,對齊`);
}

// ---- 2. 用到的 key 都存在 ----
const used = new Set();
for (const f of RENDERER_FILES) {
  const txt = read(f);
  for (const m of txt.matchAll(/\bt\("([^"]+)"/g)) used.add(m[1]);
  for (const m of txt.matchAll(/data-i18n(?:-html|-ph|-aria)?="([^"]+)"/g)) used.add(m[1]);
}
// 主行程丟出去的:progress("key") 與 new Error("STABLE_CODE")
const mainjs = read("main.js");
for (const m of mainjs.matchAll(/progress\("([a-z][\w.]+)"\)/g)) used.add(m[1]);
for (const m of mainjs.matchAll(/new Error\("([A-Z_]{4,})"\)/g)) used.add(m[1]);

const missing = [...used].filter((k) => !en.has(k));
if (missing.length) fail(`用到但表裡沒有:[${missing}]`);
else pass(`引用的 ${used.size} 個 key 都在表裡`);

// ---- 3. renderer 的非註解行沒有中文字面 ----
const HAN = /[一-鿿]/;
for (const f of RENDERER_FILES) {
  const hits = [];
  let inBlock = false;
  read(f).split("\n").forEach((line, i) => {
    const s = line.trim();
    if (f.endsWith(".html")) {
      if (s.startsWith("<!--")) inBlock = !s.includes("-->");
      else if (inBlock) { if (s.includes("-->")) inBlock = false; }
      else if (HAN.test(line)) hits.push(i + 1 + ": " + s.slice(0, 60));
      return;
    }
    if (inBlock) { if (s.includes("*/")) inBlock = false; return; }
    if (s.startsWith("/*")) { inBlock = !s.includes("*/"); return; }
    if (s.startsWith("//") || s.startsWith("*")) return;
    // 行尾註解:把 // 之後切掉再看(字串裡的 // 很少,切多了只會少報)
    const code = line.split("//")[0];
    if (HAN.test(code)) hits.push(i + 1 + ": " + s.slice(0, 60));
  });
  if (hits.length) fail(`${f} 非註解行還有中文字面:\n    ` + hits.join("\n    "));
  else pass(`${f} 非註解行沒有中文字面`);
}

// ---- 4. strings.js 是不是從現在的 .po 產出來的 ----
// 產到暫存再比對,不比 hash:標頭那行以後要改,hash 會無謂地紅。
// 沒有 babel 的環境(別台機器、CI)跳過,前三項仍然照跑。
const { execFileSync } = require("child_process");
// 找一顆裝了 babel 的 python:先看 BLAVE_PO_PYTHON,再試 PATH 上的 python3。
// 不寫死任何人機器上的路徑——這是公開 repo。
function findPython() {
  for (const py of [process.env.BLAVE_PO_PYTHON, "python3"].filter(Boolean)) {
    try { execFileSync(py, ["-c", "import babel"], { stdio: "pipe" }); return py; }
    catch (_) { /* 下一個 */ }
  }
  return null;
}
const PY = findPython();
if (!PY) {
  console.log("SKIP  strings.js 同步檢查(找不到裝了 babel 的 python;可設 BLAVE_PO_PYTHON)");
} else {
  const keep = read("renderer/strings.js");
  try {
    execFileSync(PY, [path.join(SHELL, "tools", "po2js.py")], { stdio: "pipe" });
    const now = read("renderer/strings.js");
    if (now !== keep) {
      fs.writeFileSync(path.join(SHELL, "renderer/strings.js"), keep);  // 別動工作樹
      fail("strings.js 跟 .po 不同步 —— 跑 `python shell/tools/po2js.py` 再 commit");
    } else {
      pass("strings.js 與 .po 同步");
    }
  } catch (e) {
    fail("產生器跑不起來:" + (e.stderr ? e.stderr.toString().trim() : e.message));
  }
}

console.log(bad ? `\n${bad} 紅` : "\nALL PASS");
process.exit(bad ? 1 : 0);
