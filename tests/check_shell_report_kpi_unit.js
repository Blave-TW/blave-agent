// 報告 KPI 的排法(0.1.8 第十六批 #1 單位不拆行;第十八批 DF1 數字不從中間斷、欄數跟內容欄寬走)。
// 數字斷成兩行會被讀成兩個數字,單位拆開(「U／SDT」)讀不出來。放不下時改排法,不縮字:
//   內容欄 < 600 → 兩欄網格、焦點格獨佔一列;6 格 → 焦點格任何寬度都獨佔一列、其餘 3+2;
//   非焦點格的值 ≥ 11 字元 → 兩欄網格裡獨佔一列;單位 > 8 字元 → 自己一行
//   ① 原文:report-blocks.css 有那幾條;列印樣式沒有把它們改回去
//   ② 真的排版(隨包的 Electron、看不見的視窗):KPI 3–6 顆 × 七位數／一般數字 × 短／長單位 × 閱讀欄 432／544／寬欄;列印頁同一批報告
// 跑法:node tests/check_shell_report_kpi_unit.js(沒設 BLAVE_TEST_WINDOW=1 時 ② SKIP)
const fs = require("fs"), path = require("path"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 3000))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");

if (!process.versions.electron) {
  const css = read(path.join(R, "report-blocks.css")), print = read(path.join(R, "report-print.css")), js = read(path.join(R, "report-blocks.js"));
  const rule = (sel) => (css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{[^}]*\\}")) || [""])[0];
  ok("① .rb-kpi-unit 不拆行(white-space: nowrap),跟數字之間留得下換行點(inline-block)", /white-space: nowrap;/.test(rule(".rb-report .rb-kpi-unit")) && /display: inline-block;/.test(rule(".rb-report .rb-kpi-unit")), rule(".rb-report .rb-kpi-unit"));
  ok("① .rb-kpi-value 不從中間斷(overflow-wrap / word-break: normal)", /overflow-wrap: normal;/.test(rule(".rb-report .rb-kpi-value")) && /word-break: normal;/.test(rule(".rb-report .rb-kpi-value")), rule(".rb-report .rb-kpi-value"));
  ok("① 欄數跟內容欄寬走:.rb-report 是 container rb,< 600 兩欄網格、焦點格與過長的值獨佔一列", /container: rb \/ inline-size;/.test(css)
    && /@container rb \(max-width: 599px\) \{\s*\.rb-report \.rb-kpi \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*\}[\s\S]*?\.rb-report \.rb-kpi-cell\.is-focus,\s*\.rb-report \.rb-kpi-cell\.is-wide \{\s*grid-column: 1 \/ -1;/.test(css));
  ok("① 6 格:焦點格任何寬度都獨佔一列", /flex: 0 0 100%;/.test(rule(".rb-report .rb-kpi.is-n6 .rb-kpi-cell.is-focus")));
  ok("① 過長的單位自己一行(.is-long)", /display: block;/.test(rule(".rb-report .rb-kpi-unit.is-long")) && /white-space: normal;/.test(rule(".rb-report .rb-kpi-unit.is-long")));
  ok("① renderer:非焦點格的值 ≥ 11 字元加 is-wide、單位 > 8 字元加 is-long", /i > 0 && str\(it\.value\)\.length >= 11/.test(js) && /unit\.length > 8 \? " is-long" : ""/.test(js));
  // .is-rest 是 web 公開頁(結論列上提)才加在列上的 class,電腦版的 kpi_row 不會給;那幾條是逐字搬來的 light remap 契約段,不算動排法
  const kp = js.slice(js.indexOf("  BLOCKS.kpi_row = function"), js.indexOf("  BLOCKS.line_chart = function"));
  ok("① 列印樣式沒有動 KPI 的換行與排法(共用 report-blocks.css;公開頁專用的 .is-rest 除外,渲染器不會給它)", !/is-rest/.test(kp) && !/rb-kpi[\w-]*[^{]*\{[^}]*(white-space|overflow-wrap|word-break|grid-template|flex:|container)/.test(print.replace(/[^{}]*\.is-rest[^{]*\{[^}]*\}/g, "")));
  ok("① 中欄最窄寬度仍是 480(② 量的最窄內容欄 432 就是它)", /const MAIN_MIN = 480;/.test(read(path.join(R, "app.js"))));
  const bin = GATE.bin(SHELL, "②");
  if (!bin) { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  const sub = r.status == null ? 1 : r.status;
  console.log(red || sub ? `\n${red + sub} 紅` : "\nALL PASS");
  process.exit(red || sub ? 1 : 0);
}

const { app, BrowserWindow } = require("electron");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-kpi-unit-"));
app.setPath("userData", tmp);
const LABELS = ["帳戶淨值", "本週損益", "未實現損益", "可用保證金", "累計手續費", "最大單筆虧損"];
const NUMS = { 七位數: ["1,299,902.47", "+1,234,567", "-2,345,678", "9,876,543.21", "1,002,003", "-1,234,567.89"], 一般: ["99,902.47", "+1,234.5", "-0.85", "62.5", "1.42", "-12.3"] };
const UNITS = { 短: "USDT", 八字: "新台幣元每口合約", 長九字: "USDT／每口合約", 長十六字: "新台幣元每一口合約含手續費與稅" };
const kpi = (n, vals, unit, delta) => ({ type: "kpi_row", items: LABELS.slice(0, n).map((label, i) => Object.assign({ label, value: vals[i], unit }, delta ? { delta: "+12.3%", tone: "pos" } : {})) });
const CASES = [];
Object.keys(NUMS).forEach((nk) => Object.keys(UNITS).forEach((uk) => CASES.push({ name: nk + " × " + uk + "單位", nk, uk,
  report: { id: "kpi-unit", title: "KPI", type: "performance", created_at: 1788220800,
    blocks: [{ type: "meta", title: "KPI", generated_at: 1788220800 }, kpi(3, NUMS[nk], UNITS[uk]), kpi(4, NUMS[nk], UNITS[uk]), kpi(5, NUMS[nk], UNITS[uk]), kpi(6, NUMS[nk], UNITS[uk]), kpi(6, NUMS[nk], UNITS[uk], true)] } })));
const STUB = `const __fixed = { getLocale: async () => "zh-TW", loadConnection: async () => ({ kind: "claude" }), detectAgents: async () => ({ claude: { installed: true, loggedIn: true }, codex: { installed: false } }),
  listStrategies: async () => [], listSessions: async () => [], loadSession: async () => [], loadSessionImages: async () => [], updateState: async () => ({ phase: "idle", current: "0.0.0" }),
  hasBlaveToken: async () => true, ensureEngine: async () => ({}), libraryList: async () => ({ strategies: [], signedIn: true, dataAccess: "included" }),
  reportsList: async () => ({ reports: [] }), reportLoad: async () => null, cloudReports: async () => ({ code: "UNREACH", reports: [] }), trackFeature: () => {} };
window.blave = new Proxy(__fixed, { get: (o, k) => (k in o ? o[k] : typeof k !== "string" ? undefined : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {} : async () => undefined) });`;
const printStub = (report) => `window.__ready = null; window.blavePrint = { payload: async () => (${JSON.stringify({ report, images: {}, lang: "zh", view: "local", savedAt: 1788220800000 })}), ready: (ok) => { window.__ready = ok; } };`;
// 每格:數字(單位以外的那一段)佔幾行、單位佔幾行、兩者有沒有超出格子、格子有沒有超出那一排、格子在第幾列
const MEASURE = `(() => { const root = document.querySelector("article.rb-report"), out = { w: Math.round(root.getBoundingClientRect().width), sw: root.scrollWidth, cw: root.clientWidth, dsw: document.documentElement.scrollWidth, dcw: document.documentElement.clientWidth, rows: [] };
  // 行數:mono 與 sans 片段的框高不同、top 差一兩 px,所以看的是「下一個框有沒有整個落在前一行下面」
  const lines = (rg) => { let n = 0, bottom = -1e9; [...rg.getClientRects()].filter((x) => x.width > 0).sort((a, b) => a.top - b.top).forEach((x) => { if (x.top >= bottom - 2) n++; bottom = Math.max(bottom, x.bottom); }); return n; };
  root.querySelectorAll(".rb-kpi").forEach((row) => { const rr = row.getBoundingClientRect();
    out.rows.push({ n: row.children.length, w: Math.round(rr.width), cells: [...row.querySelectorAll(".rb-kpi-cell")].map((c) => { const u = c.querySelector(".rb-kpi-unit"), v = c.querySelector(".rb-kpi-value"), cr = c.getBoundingClientRect(), ur = u.getBoundingClientRect();
      const ug = document.createRange(); ug.selectNodeContents(u); const ng = document.createRange(); ng.setStart(v, 0); ng.setEndBefore(u); const nr = ng.getBoundingClientRect();
      return { focus: c.classList.contains("is-focus"), wide: c.classList.contains("is-wide"), long: u.classList.contains("is-long"), num: ng.toString(), unit: u.textContent,
        numLines: lines(ng), numRects: Math.max(...[...v.childNodes].filter((x) => x !== u).map((x) => { const t = x.nodeType === 3 ? x : x.firstChild, g = document.createRange(); g.selectNodeContents(t); return g.getClientRects().length; })), unitLines: lines(ug), unitBelow: ur.top >= nr.bottom - 1,
        w: Math.round(cr.width), h: Math.round(cr.height), top: Math.round(cr.top - rr.top), left: Math.round(cr.left - rr.left),
        over: Math.round((Math.max(ur.right, nr.right) - cr.right) * 10) / 10, out: Math.round((cr.right - rr.right) * 10) / 10 }; }) }); });
  return out; })()`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  ② 逾時(120 秒)"); process.exit(1); }, 120000).unref();
const judge = (m) => {
  const cells = m.rows.reduce((a, r) => a.concat(r.cells), []);
  // 一列 = 同一個 top;每列有幾格
  const shape = (r) => { const tops = [...new Set(r.cells.map((c) => c.top))].sort((a, b) => a - b); return tops.map((t) => r.cells.filter((c) => c.top === t).length).join("+"); };
  const narrow = m.w < 600, bad = [];
  m.rows.forEach((r) => {
    const f = r.cells[0], s = shape(r);
    if (narrow) {
      if (Math.abs(f.w - r.w) > 1) bad.push(`n${r.n} 焦點格 ${f.w} ≠ 列寬 ${r.w}`);
      r.cells.forEach((c, i) => { if (i && c.wide && Math.abs(c.w - r.w) > 1) bad.push(`n${r.n} 第 ${i + 1} 格的值 ${c.num.length} 字元卻沒有獨佔一列`); if (i && !c.wide && c.w > r.w / 2) bad.push(`n${r.n} 第 ${i + 1} 格不是半欄`); });
      if (s.split("+").some((x) => +x > 2)) bad.push(`n${r.n} 一列超過兩格:${s}`);
    } else if (r.n === 6) {
      if (s !== "1+3+2") bad.push(`n6 排成 ${s},要 1+3+2`);
      if (Math.abs(f.w - r.w) > 1) bad.push(`n6 焦點格 ${f.w} ≠ 列寬 ${r.w}`);
    }
  });
  return { n: cells.length, numSplit: cells.filter((c) => c.numLines !== 1 || c.numRects !== 1).length, unitSplit: cells.filter((c) => c.unitLines !== 1).length,
    dropped: cells.filter((c) => !c.long && c.unitBelow).length,
    longOwnLine: cells.filter((c) => c.long).every((c) => c.unitBelow), longTagged: cells.every((c) => c.long === (c.unit.length > 8)), wideTagged: cells.every((c) => c.wide === (!c.focus && c.num.length >= 11)),
    spill: cells.filter((c) => c.over > 0.5 || c.out > 0.5).length, scroll: m.sw > m.cw || m.dsw > m.dcw, bad, shapes: m.rows.map(shape).join(" | ") };
};
const pass = (v) => v.n === 24 && !v.numSplit && !v.unitSplit && v.longOwnLine && v.longTagged && v.wideTagged && !v.spill && !v.scroll && !v.bad.length;

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  app.on("window-all-closed", () => {});   // 視窗接著開:前一個關掉時不要整個結束
  const preload = path.join(tmp, "stub.js");
  fs.writeFileSync(preload, STUB);
  const w = new BrowserWindow({ width: 1680, height: 820, show: false, webPreferences: { offscreen: true, preload, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(R, "index.html"));
  await wait(1200);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  await js(`(async () => { document.getElementById("rpt-nav").click(); await new Promise((r) => setTimeout(r, 150)); })()`);
  for (const c of CASES) {
    await js(`(() => { const g = (x) => document.getElementById(x), host = g("rpt-read"); g("rpt-rows").hidden = true; host.hidden = false; host.textContent = "";
      window.renderAgentReport(host, ${JSON.stringify(c.report)}, { apiBase: "", i18n: {}, imageUrl: () => "", markdown: (x) => x }); })()`);
    for (const width of [480, 592, 0]) {
      await js(`(() => { const p = document.getElementById("rpt"); p.style.flex = ${width ? '"none"' : '""'}; p.style.width = ${width ? `"${width}px"` : '""'}; })()`);
      await wait(80);
      const m = await js(MEASURE), v = judge(m);
      console.log(`      ${c.name}、${width ? "中欄 " + width : "寬欄"}:內容欄 ${m.w}px;排法 ${v.shapes};數字斷行 ${v.numSplit}、單位拆行 ${v.unitSplit}、溢出 ${v.spill} / ${v.n} 格;單位整顆換到下一行 ${v.dropped} 格`);
      ok(`② ${c.name}、內容欄 ${m.w}:KPI 3–6 顆數字都在一行、單位不拆、不超出格子、沒有橫向捲動、排法照規格`, pass(v), JSON.stringify([v, m.rows]));
      if (c.nk === "七位數" && c.uk === "短" && width === 480) {
        const f = m.rows[3].cells[0], rest = m.rows[3].cells.slice(1);
        console.log(`      內容欄 ${m.w}、6 格:焦點格 ${f.w} × ${f.h};其餘五格寬 ${rest.map((x) => x.w).join(" / ")}`);
        ok("② 內容欄 432、6 格、焦點值 1,299,902.47:一行(getClientRects 1 個)、單位同一行、焦點格高 ≤ 63", m.w === 432 && f.num === "1,299,902.47" && f.numRects === 1 && !f.unitBelow && f.h <= 63 && f.w === 432, JSON.stringify(f));
      }
    }
  }
  w.destroy();

  for (const c of CASES) {
    const printPreload = path.join(tmp, "print-stub.js");
    fs.writeFileSync(printPreload, printStub(c.report));
    const pw = new BrowserWindow({ width: 900, height: 1200, show: false, webPreferences: { offscreen: true, preload: printPreload, contextIsolation: false, sandbox: false } });
    await pw.loadFile(path.join(R, "report-print.html"));
    let ready = null;
    for (let i = 0; i < 100 && ready == null; i++) { await wait(100); ready = await pw.webContents.executeJavaScript("window.__ready", true); }
    const m = await pw.webContents.executeJavaScript(MEASURE, true), v = judge(m);
    console.log(`      列印頁、${c.name}:內容寬 ${m.w}px;排法 ${v.shapes};數字斷行 ${v.numSplit}、單位拆行 ${v.unitSplit}、溢出 ${v.spill} / ${v.n} 格`);
    ok(`② 列印頁(report-print.html)、${c.name}:數字一行、單位不拆、不超出格子、6 格是 1+3+2`, ready === true && pass(v), JSON.stringify([ready, v, m.rows]));
    pw.destroy();
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* userData 還鎖著 */ }
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + (e && e.stack)); app.exit(1); });
