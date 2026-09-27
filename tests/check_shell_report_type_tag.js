// 報告標題旁的類型標籤(shell/renderer/report-blocks.js BLOCKS.meta):report_type 是 type 代號時不畫。
// lib/report.py 在 agent 沒給 report_type 時填的是 type 代號,標籤就印出 research / morning / performance(設計稽核 0.1.8 第三批 W10)。
// 整支 report-blocks.js 配最小的假 DOM 跑 renderReportBlock;判斷要跟 web 的 report_blocks.js 同一句。跑法:node tests/check_shell_report_type_tag.js
const fs = require("fs"), path = require("path");
const js = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "report-blocks.js"), "utf8");
const WEB = path.join(__dirname, "..", "..", "web", "app", "static", "js", "agent", "report_blocks.js");
function node(tag) {
  const n = { tag, className: "", childNodes: [], textContent: "", parentNode: null, addEventListener() {}, setAttribute() {},
    appendChild(c) { c.parentNode = n; n.childNodes.push(c); return c; } };
  return n;
}
const document = { documentElement: { lang: "zh-Hant" }, createElement: node, createTextNode: (s) => ({ tag: "#text", textContent: s, childNodes: [] }) };
const window = { console };
new Function("window", "document", js)(window, document);
const flat = (n) => [n].concat(...(n.childNodes || []).map(flat));
const i18n = new Proxy({}, { get: (_t, k) => String(k) });
const tag = (meta) => { const out = window.renderReportBlock({ type: "meta", title: "比特幣收在 8.47 萬", generated_at: 1790000000, ...meta }, { i18n });
  const t = flat(out).filter((x) => x.className === "rb-type-tag"); return t.length ? t.map((x) => x.textContent).join("|") : null; };
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

ok("顯示字照畫(績效週報、一次性)", tag({ report_type: "績效週報" }) === "績效週報" && tag({ report_type: "一次性" }) === "一次性", [tag({ report_type: "績效週報" })]);
const codes = ["research", "morning", "performance"].map((c) => tag({ report_type: c }));
ok("三個 type 代號都不畫(列舉 lib/report.py 收的 type)", codes.every((x) => x === null), codes);
// write_report 的參數說明那一行:type        `performance` / `morning` / `research`
const types = (/^\s+type\s+((?:`[a-z_]+`(?: \/ )?)+)/m.exec(fs.readFileSync(path.join(__dirname, "..", "lib", "report.py"), "utf8")) || [])[1] || "";
const known = (types.match(/`([a-z_]+)`/g) || []).map((s) => s.slice(1, -1));
ok("lib/report.py 收的每一種 type 都在不畫的名單裡(" + known.join("、") + ")", known.length >= 3 && known.every((c) => tag({ report_type: c }) === null), known);
ok("認不得的字不猜、照畫;沒給 / 標題已含 → 不畫", tag({ report_type: "weekly" }) === "weekly" && tag({}) === null && tag({ report_type: "比特幣" }) === null);
if (fs.existsSync(WEB)) {
  const line = (s) => (/var TYPE_CODES = [^\n]+/.exec(s) || [""])[0] + "|" + (/if \(rtype && [^\n]+/.exec(s) || [""])[0];
  ok("判斷與 web 的 report_blocks.js 逐字相同", line(js) === line(fs.readFileSync(WEB, "utf8")) && line(js).length > 40, [line(js)]);
} else console.log("SKIP  找不到 ../web,沒有跟 web 比");
console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
