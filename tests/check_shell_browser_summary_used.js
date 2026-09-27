// 瀏覽卡摘要列:整輪都在操作、一頁都沒讀(Wei 實測 TradingView:貼 Pine、切週期,沒 browser_read)
// 不再寫「讀了 0 頁」——改「用了 N 頁」。canon 第 1 條口徑不動:「已讀」仍只認真的讀到正文的頁
// (讀過任何一頁就照舊「讀了 N 頁」),N(用了)不含搜尋頁/被擋/打不開/只停中繼頁,格子照樣不打勾。
// 另:設計師定案 br.openPanel zh「看網頁」/ en "View pages"、br.closePanel en 改 "Close"(key 不改名)。
// 跑法:node tests/check_shell_browser_summary_used.js
const fs = require("fs");
const path = require("path");
const RD = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(RD, "browser.js"), "utf8");
const strings = fs.readFileSync(path.join(RD, "strings.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

// ---- 抽真的 brPaintSum + brIsRead 來跑(假 DOM 節點,t() 回 key)
const fnCut = (name) => { const a = src.indexOf("function " + name + "("); return src.slice(a, src.indexOf("\n}\n", a) + 3); };
const isReadLine = src.match(/const brIsRead = .*;/)[0];
function Node() { this.kids = []; this.text = ""; }
Node.prototype.append = function (...k) { k.forEach((x) => this.kids.push(x)); };
const flat = (n) => (typeof n === "string" ? n : n && n.kids ? [n.text, ...n.kids.map(flat)].join("") : "");
function paint(tabs, { sourceCount = null, exp = null } = {}) {
  const env = {
    brEl: (tag, cls, txt) => { const n = new Node(); n.cls = cls || ""; n.text = txt || ""; n.style = {}; return n; },
    brFav: () => { const n = new Node(); n.style = {}; return n; },
    brIcon: () => new Node(),
    t: (k) => "[" + k + "]",
    BR: { tabs: new Map(Object.entries(tabs)), exp },
    brCollapse: () => {}, trackFeature: () => {},
  };
  const fn = new Function(...Object.keys(env), isReadLine + "\n" + fnCut("brPaintSum") + "; return brPaintSum;")(...Object.values(env));
  const s = new Node(); s.textContent = ""; s.append = Node.prototype.append; s.kids = [];
  const b = { sum: s, ids: Object.keys(tabs), sourceCount };
  fn(b);
  return flat(s);
}
const T = (o) => Object.assign({ url: "https://x.test/a", ph: "done" }, o);

ok("全是操作沒有讀 → 「用了 1 頁」(不再「讀了 0 頁」)",
  paint({ a: T({ readEver: false }) }, { sourceCount: 0 }).includes("[br.summaryUsedPre]1[br.summaryPost]"));
ok("讀過任何一頁 → 照舊「讀了 N 頁」(操作過沒讀的那頁不進 N)",
  paint({ a: T({ readEver: true }), b: T({ readEver: false }) }, { sourceCount: 1 }).includes("[br.summaryPre]1[br.summaryPost]"));
ok("用了的口徑:搜尋頁/被擋/打不開/中繼頁不算(全擋 → 照舊讀了 0)",
  paint({ a: T({ blocked: { kind: "domain" } }), b: T({ fail: "network" }), c: T({ search: true }), d: T({ relay: true }) }, { sourceCount: 0 }).includes("[br.summaryPre]0[br.summaryPost]"));
ok("混合:1 頁被擋 + 1 頁操作過 → 用了 1(只數真的開起來的)",
  paint({ a: T({ blocked: { kind: "domain" } }), b: T({}) }, { sourceCount: 0 }).includes("[br.summaryUsedPre]1[br.summaryPost]"));

// ---- 文案(設計師定案)與 i18n
ok("br.summaryUsedPre 兩語都有(用了 / Used)", /"br\.summaryUsedPre": "用了 "/.test(strings) && /"br\.summaryUsedPre": "Used "/.test(strings));
ok("br.openPanel = 看網頁 / View pages(key 不改名)", /"br\.openPanel": "看網頁"/.test(strings) && /"br\.openPanel": "View pages"/.test(strings));
ok("br.closePanel = 收回 / Close", /"br\.closePanel": "收回"/.test(strings) && /"br\.closePanel": "Close"/.test(strings));

console.log(red ? "\n" + red + " FAILED" : "\nALL PASS");
process.exit(red ? 1 : 0);
