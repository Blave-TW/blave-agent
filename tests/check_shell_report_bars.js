// 直條圖的值標不壓在右下角浮水印上(e2e 0.1.8 #18:爆倉長條圖最右一根幾乎是 0,值標「+0.01」與 blave.org 疊在一起,畫面與 PDF 都是)。
// 浮水印落點不動(型錄裁示 5:固定右下、最底層),讓的是值標:正值抬到浮水印之上、負值降到之下。
// 不開 Electron:從 report-blocks.js 切真的 textWidth / dodgeWatermark 來跑,再用最小的假 SVG 把 verticalBars 整支跑一次。
// 跑法:node tests/check_shell_report_bars.js
const fs = require("fs"), path = require("path");
const RB = path.join(__dirname, "..", "shell", "renderer", "report-blocks.js");
const WEB = path.join(__dirname, "..", "..", "web", "app", "static", "js", "agent", "report_blocks.js");
const src = fs.readFileSync(RB, "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 800))); if (!c) red++; };
const cut = (s, name) => { const i = s.indexOf("  function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
const FW = /  var FULL_WIDTH = [^\n]*\n/.exec(src)[0];

const texts = [];
const env = { svgText: (x, y, text, attrs) => { const n = { x, y, text, cls: (attrs && attrs.class) || "" }; texts.push(n); return n; }, svgEl: () => ({}), chartSvg: () => ({ appendChild() {} }) };
const make = new Function(...Object.keys(env), FW + ["textWidth", "plotBottom", "plotTopOf", "watermark", "dodgeWatermark", "verticalBars"].map((n) => cut(src, n)).join("\n") + "\nreturn { dodgeWatermark, verticalBars, textWidth };");
const F = make(...Object.values(env));

const W = 673, H = 170, bottom = H - 52, wmX = W - 8, wmY = bottom - 7;
ok("撞到(左右、上下都交疊):正值抬到浮水印之上(基線 wmY − 13)、負值降到之下(wmY + 13)", F.dodgeWatermark(617, bottom - 8, "+0.01", true, wmX, wmY) === wmY - 13 && F.dodgeWatermark(617, wmY + 5, "−0.01", false, wmX, wmY) === wmY + 13);
ok("沒撞到就不動:值標在浮水印左邊、或高過浮水印一行以上", F.dodgeWatermark(300, bottom - 8, "+0.01", true, wmX, wmY) === bottom - 8 && F.dodgeWatermark(617, 40, "+84.65", true, wmX, wmY) === 40 && F.dodgeWatermark(617, wmY + 30, "−5.00", false, wmX, wmY) === wmY + 30);

// e2e 那張圖:六根、最右一根 0.0078
const rows = [84.65, 21.09, 18.9, 10.58, 0.97, 0.0078].map((v, i) => ({ name: "X" + i, v, val: "+" + v.toFixed(2) }));
texts.length = 0; F.verticalBars({}, { rows, maxPos: 84.65, maxNeg: 0 }, W, H);
const wm = texts.find((t) => t.cls === "rb-wm"), vals = texts.filter((t) => t.cls === "rb-val-up");
const box = (t, size) => ({ x0: t.cls === "rb-wm" ? t.x - F.textWidth(t.text) * 1.1 : t.x - F.textWidth(t.text) / 2, x1: t.cls === "rb-wm" ? t.x : t.x + F.textWidth(t.text) / 2, y0: t.y - size, y1: t.y + 2 });
const hit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
ok("整支跑:浮水印還在右下原位;六個值標沒有一個的字框碰到浮水印的字框;沒撞到的那幾根位置照舊", wm && wm.x === wmX && wm.y === wmY && vals.length === 6 && vals.every((v) => !hit(box(v, 10), box(wm, 11)))
  && vals[5].y === wmY - 13 && Math.abs(vals[0].y - (24 - 8)) < 0.01, JSON.stringify(vals.map((v) => [v.x, v.y])));

if (!fs.existsSync(WEB)) console.log("SKIP  與 web 逐字比對(需要 monorepo 版面)");
else { const web = fs.readFileSync(WEB, "utf8");
  ok("dodgeWatermark / verticalBars 與 web 的 report_blocks.js 逐字相同", cut(src, "dodgeWatermark") === cut(web, "dodgeWatermark") && cut(src, "verticalBars") === cut(web, "verticalBars")); }

console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
