// 引用圖的來源行(shell/renderer/report-blocks.js BLOCKS.image):名稱就是網域時只畫一次。
// 擷取工具在站沒有給站名時把 source.name 退成網域,舊版會畫成「來源 alternative.me alternative.me」(0.1.8 e2e)。
// 從 report-blocks.js 切真的函式,配一個最小的假 DOM 跑。跑法:node tests/check_shell_report_image_source.js
const fs = require("fs"), path = require("path");
const js = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "report-blocks.js"), "utf8");
const grab = (name) => { const a = js.indexOf("  function " + name + "("); if (a < 0) throw new Error("找不到 " + name); return js.slice(a, js.indexOf("\n  }\n", a) + 4); };
const a = js.indexOf("  BLOCKS.image = function"), image = js.slice(a, js.indexOf("\n  };\n", a) + 5);
function node(tag) {
  const n = { tag, className: "", children: [], textContent: "", parentNode: null, addEventListener() {},
    appendChild(c) { c.parentNode = n; n.children.push(c); return c; } };
  return n;
}
const document = { createElement: node, createTextNode: (s) => ({ tag: "#text", textContent: s, children: [] }) };
const BLOCKS = new Function("document", "URL", "var BLOCKS = {};\n" + ["el", "str", "num", "safeUrl", "linkTo", "hostOf", "extLink"].map(grab).join("\n") + "\n" + image + "\nreturn BLOCKS;")(document, URL);
const ctx = { i18n: { imageSource: "來源", imageError: "x" }, imageUrl: () => "data:," };
const flat = (n) => [n].concat(...(n.children || []).map(flat));
const line = (source) => { const w = BLOCKS.image({ type: "image", file: "a.png", alt: "x", source }, ctx); const l = w.children.find((c) => c.className === "rb-image-src"); return l ? flat(l).filter((c) => c.className || c.tag === "#text").map((c) => (c.className || "#") + "=" + c.textContent) : null; };
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

let l = line({ name: "alternative.me", url: "https://alternative.me/crypto/fear-and-greed-index/" });
ok("名稱 = 網域:只畫名稱連結,不再接 mono 網域", l.join("|") === "rb-image-src=|rb-image-src-l=來源|rb-xlink=|rb-xlink-nm=alternative.me", l);
l = line({ name: "WWW.Alternative.me ", url: "https://www.alternative.me/x" });
ok("去 www.、不分大小寫、頭尾空白照樣算同一個", l.filter((x) => /mono/.test(x)).length === 0 && l.filter((x) => /rb-xlink-nm/.test(x)).length === 1, l);
l = line({ name: "Glassnode", url: "https://studio.glassnode.com/charts/x" });
ok("名稱是站名:名稱連結 + mono 網域(照舊)", l.join("|") === "rb-image-src=|rb-image-src-l=來源|rb-xlink=|rb-xlink-nm=Glassnode|#= |rb-xlink-dom mono=studio.glassnode.com", l);
l = line({ name: "glassnode.com", url: "https://studio.glassnode.com/charts/x" });
ok("名稱是另一個網域(不是這一頁的主機):兩個都畫", l.some((x) => x === "rb-xlink-dom mono=studio.glassnode.com"), l);
ok("沒有 source 不畫來源行", line(undefined) === null);
console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
