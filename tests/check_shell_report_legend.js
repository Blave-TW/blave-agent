// 報告 line_chart 圖例末值的格式:去尾零、座標含零或跨零才標 +(同 fmtAxis)、小數位看資料。
//
// 電腦版(shell/renderer/report-blocks.js)同一套規則;網頁版在 web/tests/check_report_legend.js。
// 跑法:node tests/check_shell_report_legend.js
//
// 舊版一律 fmtSigned(v, 2):「−77,031.00 口」「+927.97 萬張」、資金費率「+0.00%」。
// 從 report_blocks.js 切真的 group / trimNum / dataDp / fmtLegend 來跑,再看圖例那行的接線。
const fs = require("fs");
const path = require("path");

const js = fs.readFileSync(
  path.join(__dirname, "..", "shell", "renderer", "report-blocks.js"),
  "utf8"
);
function grab(name) {
  const a = js.indexOf("  function " + name + "(");
  if (a < 0) throw new Error("找不到 " + name);
  return js.slice(a, js.indexOf("\n  }\n", a) + 4);
}
const lib = new Function(
  "MINUS", "DASH",
  ["num", "group", "trimNum", "dataDp", "fmtLegend"].map(grab).join("\n") +
    "\nreturn { dataDp, fmtLegend };"
)("−", "—");

let red = 0;
function ok(name, cond, detail) {
  console.log((cond ? "ok   " : "FAIL ") + name + (cond ? "" : "  " + JSON.stringify(detail)));
  if (!cond) red++;
}
// 同 line_chart:dp 由整張圖的資料決定,signed = scale.lo <= 0
function legend(values, axisDp, lo) {
  return lib.fmtLegend(values[values.length - 1], lo <= 0, lib.dataDp(values, axisDp));
}

const cases = [
  ["整數序列、跨零:0 位,負號 U+2212", [-12000, 3500, -77031], 0, -80000, "−77,031"],
  ["正值座標不標 +", [880.5, 901.25, 927.97], 0, 800, "927.97"],
  ["整數正值座標:不標 +、不補 .00", [1200, 1350], 0, 1000, "1,350"],
  ["資金費率:留到有效位數(4 位),跨零標 +", [-0.0012, 0.0035, 0.0103], 3, -0.005, "+0.0103"],
  ["資金費率末值是 0.01:去尾零", [0.0125, 0.01], 3, 0, "+0.01"],
  ["末值為 0 不寫 +0", [-1.5, 0], 1, -2, "0"],
  ["浮點雜訊不放大小數位", [0.1 + 0.2, 0.7], 1, 0, "+0.7"],
  ["算出來的比值:上限 = 刻度位數 +2", [1.23456789, 1.3456789], 1, 1, "1.346"],
  ["極小值(科學記號)也數得到位數", [0.00015, 0.000125], 5, 0, "+0.000125"],
];
cases.forEach(([name, vals, dp, lo, want]) => {
  const got = legend(vals, dp, lo);
  ok(name + " → " + want, got === want, got);
});
ok("非數字 → —", lib.fmtLegend(null, true, 2) === "—");

const lc = js.slice(js.indexOf("  BLOCKS.line_chart = function"), js.indexOf("  BLOCKS.candlestick = function"));
ok("接線:圖例用 fmtLegend(末值, scale.lo <= 0, 全圖資料的位數)",
  /fmtLegend\(last\[1\], scale\.lo <= 0, legendDp\)/.test(lc) && /dataDp\([\s\S]*?scale\.dp\s*\)/.test(lc) && !/fmtSigned\(/.test(lc));

// 報告總結(text variant:"summary"):跟 lead 同一種框
const tx = js.slice(js.indexOf("  BLOCKS.text = function"), js.indexOf("  BLOCKS.quote = function"));
const css = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "report-blocks.css"), "utf8");
ok("總結:variant summary 掛 rb-summary(跟 rb-lead 平行)", /b\.variant === "summary" \? " rb-summary"/.test(tx));
ok("總結的框同 lead(surface-card、radius-sm),框內小標去掉上距與底線,推翻段細線隔開、不用紅",
  /\.rb-report \.rb-text\.rb-summary \{\s*padding: var\(--space-12\) var\(--space-16\);\s*background: var\(--surface-card\);\s*border-radius: var\(--radius-sm\);/.test(css)
  && /\.rb-summary h2 \{\s*margin: 0 0 var\(--space-6\);\s*padding-bottom: 0;\s*border-bottom: 0;/.test(css)
  && /\.rb-summary p:last-child:not\(:first-of-type\) \{[^}]*border-top: 1px solid var\(--border-hairline\);/.test(css)
  && !/rb-summary[^{]*\{[^}]*--color-red/.test(css));
const WEB_RB = path.join(__dirname, "..", "..", "web", "app", "static", "js", "agent", "report_blocks.js");
if (!fs.existsSync(WEB_RB)) console.log("SKIP  與 web 逐字比對(需要 monorepo 版面)");
else ok("網頁版與電腦版同一份 dataDp / fmtLegend(一字不差)", (() => {
  const web = fs.readFileSync(WEB_RB, "utf8");
  const g = (src, n) => { const a = src.indexOf("  function " + n + "("); return a < 0 ? null : src.slice(a, src.indexOf("\n  }\n", a)); };
  return ["dataDp", "fmtLegend"].every((n) => g(web, n) && g(web, n) === g(js, n));
})());
// KPI(設計稽核 B3/B4)與負號(B5)
const kp = js.slice(js.indexOf("  BLOCKS.kpi_row = function"), js.indexOf("  BLOCKS.line_chart = function"));
ok("KPI:有 delta 時色上在 delta、值不上色;沒有 delta 才讓值上色", /var valTone = it\.delta \? "" : tone;/.test(kp) && /el\("div", "rb-kpi-value" \+ valTone \+ \(textVal \? " is-text" : ""\)\)/.test(kp) && /el\("div", "rb-kpi-delta" \+ \(it\.delta \? tone : ""\)\)/.test(kp)
  && /\.rb-kpi-delta\.rb-up \{ color: var\(--color-greenText\); \}/.test(css) && /\.rb-kpi-delta\.rb-dn \{ color: var\(--color-redText\); \}/.test(css));
ok("KPI:三個標籤同一條水平線(align-items: flex-start)", /\.rb-report \.rb-kpi \{[^}]*align-items: flex-start;/.test(css));
const dm = new Function("MINUS", (() => { const a = js.indexOf("  function dispMinus("); return js.slice(a, js.indexOf("\n  }\n", a) + 4); })() + "; return dispMinus;")("\u2212");
ok("負號顯示一律 U+2212(只換開頭的數字負號,連字號詞不動)", dm("-0.04%") === "\u22120.04%" && dm("-.5") === "\u2212.5" && dm("t-1") === "t-1" && dm("--x") === "--x"
  && /monoShapes\(val, dispMinus\(str\(it\.value\)\)\)/.test(kp) && /proseShapes\(d, dispMinus\(str\(it\.delta\)\), ctx\)/.test(kp));
console.log(red ? "\nFAIL " + red + " 項" : "\nALL PASS");
process.exit(red ? 1 : 0);
