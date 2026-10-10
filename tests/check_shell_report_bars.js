// 直條圖的值標與浮水印不再同區(e2e 0.1.8 #18 的那張圖:爆倉長條圖最右一根幾乎是 0,值標「+0.01」曾與 blave.org 疊在一起)。
// 現行規則(canon design-system › Chart watermark › 位置;web 4c5cfe75):浮水印畫在圖底 14px 署名列(WM_ROW),SVG 實高 = H + WM_ROW,
// 資料與值標畫不到那一列,值標回原位、不再讓位(dodgeWatermark 已刪)。
// 不開 Electron:從 report-blocks.js 切真的 textWidth / verticalBars 來跑,用最小的假 SVG 把 verticalBars 整支跑一次。
// 跑法:node tests/check_shell_report_bars.js
const fs = require("fs"), path = require("path");
const RB = path.join(__dirname, "..", "shell", "renderer", "report-blocks.js");
const WEB = path.join(__dirname, "..", "..", "web", "app", "static", "js", "agent", "report_blocks.js");
const src = fs.readFileSync(RB, "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 800))); if (!c) red++; };
const cut = (s, name) => { const i = s.indexOf("  function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
const FW = /  var FULL_WIDTH = [^\n]*\n/.exec(src)[0], WM = /  var WM_ROW = \d+;\n/.exec(src)[0];

const texts = [], svgs = [];
const env = { svgText: (x, y, text, attrs) => { const n = { x, y, text, cls: (attrs && attrs.class) || "" }; texts.push(n); return n; }, svgEl: () => ({}), chartSvg: (b, W, H) => { svgs.push({ W, H }); return { appendChild() {} }; } };
const make = new Function(...Object.keys(env), FW + WM + ["textWidth", "plotBottom", "plotTopOf", "watermark", "verticalBars"].map((n) => cut(src, n)).join("\n") + "\nreturn { verticalBars, textWidth, WM_ROW };");
const F = make(...Object.values(env));

ok("署名列 14px(WM_ROW),dodgeWatermark 已刪", F.WM_ROW === 14 && !/dodgeWatermark/.test(src));

// e2e 那張圖:六根、最右一根 0.0078
const W = 673, H = 170, bottom = H - 52;
const rows = [84.65, 21.09, 18.9, 10.58, 0.97, 0.0078].map((v, i) => ({ name: "X" + i, v, val: "+" + v.toFixed(2) }));
F.verticalBars({}, { rows, maxPos: 84.65, maxNeg: 0 }, W, H);
const wm = texts.find((t) => t.cls === "rb-wm"), vals = texts.filter((t) => t.cls === "rb-val-up"), others = texts.filter((t) => t.cls !== "rb-wm");
ok("SVG 實高 = H + WM_ROW;浮水印在署名列(右緣 W − 8、基線實高 − 4)", svgs.length === 1 && svgs[0].W === W && svgs[0].H === H + F.WM_ROW && wm && wm.x === W - 8 && wm.y === H + F.WM_ROW - 4, JSON.stringify({ svgs, wm }));
// 11px 字的字頂約在基線上 8;其他文字(值標、名稱)的下緣 = 基線 + 3
ok("六個值標與名稱全在署名列之上(最低的字底 < 浮水印字頂);值標回原位、不再讓位(最右一根 = 零軸 − 8、最高一根 = 24 − 8)",
  vals.length === 6 && others.every((t) => t.y + 3 < wm.y - 8) && Math.abs(vals[5].y - (bottom - 8)) < 0.02 && Math.abs(vals[0].y - (24 - 8)) < 0.01, JSON.stringify(vals.map((v) => [v.x, v.y])));

if (!fs.existsSync(WEB)) console.log("SKIP  與 web 逐字比對(需要 monorepo 版面)");
else { const web = fs.readFileSync(WEB, "utf8");
  ok("verticalBars 與 web 的 report_blocks.js 逐字相同;web 也沒有 dodgeWatermark", cut(src, "verticalBars") === cut(web, "verticalBars") && !/dodgeWatermark/.test(web)); }

console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
