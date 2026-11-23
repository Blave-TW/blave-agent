// 電腦版 renderer 的 <script> 都是傳統腳本、共用一個全域:兩支檔各寫一個同名的頂層 function,
// 後載入的會靜默蓋掉前一個(0.1.59 永豐 sinopac.js 的 spView／spGo 被 portfolio.js 蓋掉,連接框整片空白)。
// 這支照 index.html 的載入順序,收每支 renderer 檔的頂層 function／async function／class／const／let／var 名字,
// 同名出現在兩支檔就紅。不起 Electron。
// 跑法:node tests/check_shell_renderer_globals.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
let red = 0; const ok = (n, c, info) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || !info ? "" : "\n      " + info)); if (!c) red++; };

const html = fs.readFileSync(path.join(R, "index.html"), "utf8");
const files = [...html.matchAll(/<script\s+src="([^"]+\.js)"/g)].map((m) => m[1])
  .filter((f) => !/^https?:/.test(f) && fs.existsSync(path.join(R, f)));
ok("index.html 讀得到 renderer 腳本清單", files.length >= 20, "只找到 " + files.length + " 支");

// 頂層 = 行首沒有縮排(這個 repo 的 renderer 檔一律這樣寫頂層宣告)
const DECL = /^(?:async\s+function\s*\*?|function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const owner = new Map(), dups = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(R, f), "utf8");
  const seen = new Set();
  for (const m of src.matchAll(DECL)) {
    const n = m[1];
    if (seen.has(n)) continue; seen.add(n);
    if (owner.has(n)) dups.push(n + ":" + owner.get(n) + " → " + f);
    else owner.set(n, f);
  }
}
ok("renderer 各檔的頂層名字不重複(同名會被後載入的靜默蓋掉)", dups.length === 0, dups.join("; "));

// 自我檢查:這支真的抓得到撞名(拿兩段假原始碼跑同一個 regex)
const fake = ["function spView(a) {}\nconst X = 1;", "async function spView() {}\n"].map((s) => [...s.matchAll(DECL)].map((m) => m[1]));
ok("自我檢查:regex 收得到 function／async function／const", fake[0].includes("spView") && fake[0].includes("X") && fake[1].includes("spView"));

console.log(red ? red + " FAILED" : "ALL PASS");
process.exit(red ? 1 : 0);
