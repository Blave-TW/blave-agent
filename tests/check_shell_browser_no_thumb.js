// 歷史對話的瀏覽列沒有縮圖(稽核 0.1.8 第二批 §4;e2e #14 的空白黑塊):縮圖只在頁面活著時拍、只存在記憶體,
// 重開之後那一格永遠沒有圖 → 整塊都沒有圖就不畫縮圖欄(.no-thumb)。進行中、或有的有圖有的沒有,照舊留著那一格。
// 不開 Electron:判準從原文切出來跑,接線與 CSS 看原文。跑法:node tests/check_shell_browser_no_thumb.js
const fs = require("fs"), path = require("path");
const RD = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(RD, "browser.js"), "utf8"), css = fs.readFileSync(path.join(RD, "browser.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 800))); if (!c) red++; };
const cut = (name) => { const a = src.indexOf("function " + name + "("); if (a < 0) throw new Error("no " + name); return src.slice(a, src.indexOf("\n", a)); };

const brNoThumb = new Function(cut("brNoThumb") + "\nreturn brNoThumb;")();
ok("判準:不是進行中、每一格都沒有圖 → 不畫縮圖欄", brNoThumb(false, [undefined, null, ""]) === true && brNoThumb(false, [undefined]) === true);
ok("進行中照舊留著那一格(圖馬上會來,先佔位才不跳)", brNoThumb(true, [undefined, undefined]) === false);
ok("有的有圖有的沒有:不加(整塊左緣要對齊);一格都沒有的空區塊也不加", brNoThumb(false, ["data:image/jpeg;base64,AA", undefined]) === false && brNoThumb(false, []) === false);

// 接線:class 掛在區塊(聊天)與中欄牆;每次重畫都重新判斷(歷史的頁重新開成活頁、拍到圖之後要拿掉)
const toggler = new Function("BR", cut("brNoThumb") + "\n" + cut("brOnlyVerify") + "\n" + cut("brThumbClass") + "\nreturn brThumbClass;");
const el = () => { const set = new Set(); return { classList: { toggle: (c, on) => (on ? set.add(c) : set.delete(c)), contains: (c) => set.has(c) } }; };
{ const BR = { tabs: new Map([["a", {}], ["b", {}]]) }, f = toggler(BR), n = el(), b = { live: false, ids: ["a", "b", "gone"] };
  f(b, n); const first = n.classList.contains("no-thumb");
  BR.tabs.get("a").thumb = "data:image/jpeg;base64,AA"; f(b, n);
  ok("brThumbClass:讀 BR.tabs 的 thumb(清單裡查不到的 id 當沒有圖);之後拍到圖 → class 拿掉", first === true && n.classList.contains("no-thumb") === false); }
{ const BR = { tabs: new Map([["s", { search: true, verify: true }], ["p", {}]]) }, f = toggler(BR), n = el();
  f({ live: true, ids: ["s"] }, n); const only = n.classList.contains("no-thumb");
  f({ live: true, ids: ["s", "p"] }, n);
  ok("進行中的卡只有「搜尋在等你過驗證」那一列(那一頁不拍縮圖)→ 收掉縮圖欄;還有別的頁 → 照舊留著", only === true && n.classList.contains("no-thumb") === false); }
const body = (name) => { const a = src.indexOf("function " + name + "("); let d = 0; for (let k = src.indexOf("{", a); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(a, k + 1); } throw new Error("unbalanced " + name); };
ok("brPaintHead 第一步就判(摘要列那條早退之前);回合結束換成摘要列也走 brPaintHead;中欄牆新建與原地更新兩條路都掛", /^function brPaintHead\(b\) \{\s*brThumbClass\(b, b\.el\);\s*if \(b\.sum\) return brPaintSum\(b\);/.test(body("brPaintHead"))
  && /b\.el = d; b\.sum = s; brPaintHead\(b\);/.test(body("brFinish")) && (body("brPaintOverlay").match(/brThumbClass\(exp\.block, wall\);/g) || []).length === 2);

const chat = /@container chat \(max-width: 559px\) \{\s*\.bblk\.no-thumb \.pt \{ grid-template-columns: minmax\(0, 1fr\) auto; \}\s*\.bblk\.no-thumb \.pt-bar, \.bblk\.no-thumb \.pt-foot \{ grid-column: 1 \/ 3; \}\s*\.bblk\.no-thumb \.pt-prog \{ left: var\(--space-8\); \}\s*\}/;
ok("CSS:.pg 藏掉(聊天區塊與中欄牆);一頁一列時 grid 兩欄、條頭與訊息槽跨 1/3、進度條左緣 space-8;中欄牆列高跟著內容", /\.bblk\.no-thumb \.pg, \.wall\.no-thumb \.pg \{ display: none; \}/.test(css) && chat.test(css) && /\.bw \.wall\.no-thumb \{ grid-auto-rows: auto; \}/.test(css));
ok("CSS 順序:.no-thumb 那組排在一頁一列的原規則之後(同一個 container query 條件,後寫的才蓋得過)", css.indexOf(".bblk.no-thumb .pt {") > css.indexOf(".bblk .pt { display: grid;") && css.indexOf(".bblk.no-thumb .pt-prog") > css.indexOf(".bblk .pt-prog { left: 80px; }"));

console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
