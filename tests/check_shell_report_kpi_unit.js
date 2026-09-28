// 報告 KPI 的單位不拆行(0.1.8 第十六批 #1;web 稽核 WF1 的電腦版對應)。
// .rb-report 整份是 overflow-wrap: anywhere(長網址、長代碼不撐破欄),KPI 那一格放不下「數字 + 單位」時
// 單位會從字中間斷開(「U／SDT」)。單位是一個整體:放不下就整顆換到下一行,不拆成兩半,也不橫向溢出格子。
//   ① 原文:report-blocks.css 有那一條;列印樣式沒有把它改回去
//   ② 真的排版(隨包的 Electron、看不見的視窗):閱讀欄(中欄最窄 MAIN_MIN)與寬欄、KPI 3–6 顆、七位數 + USDT;列印頁同一份報告
// 跑法:node tests/check_shell_report_kpi_unit.js(沒設 BLAVE_TEST_WINDOW=1 時 ② SKIP)
const fs = require("fs"), path = require("path"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 3000))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");

if (!process.versions.electron) {
  const css = read(path.join(R, "report-blocks.css")), print = read(path.join(R, "report-print.css"));
  const rule = (css.match(/\.rb-report \.rb-kpi-unit \{[^}]*\}/) || [""])[0];
  ok("① report-blocks.css:.rb-kpi-unit 不拆行(white-space: nowrap)", /white-space: nowrap;/.test(rule), rule);
  ok("① 列印樣式沒有動單位的換行(共用 report-blocks.css 那一條)", !/rb-kpi-unit[^{]*\{[^}]*(white-space|overflow-wrap|word-break)/.test(print));
  ok("① 中欄最窄寬度仍是 480(② 量的就是這個寬度)", /const MAIN_MIN = 480;/.test(read(path.join(R, "app.js"))));
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
const VALUES = ["1,234,567", "+1,234,567", "-2,345,678", "9,876,543", "1,002,003", "-1,234,567"];
const kpi = (n, delta) => ({ type: "kpi_row", items: LABELS.slice(0, n).map((label, i) => Object.assign({ label, value: VALUES[i], unit: "USDT" }, delta ? { delta: "+12.3%", tone: "pos" } : {})) });
const REPORT = { id: "kpi-unit", title: "KPI 單位", type: "performance", created_at: 1788220800,
  blocks: [{ type: "meta", title: "KPI 單位", generated_at: 1788220800 }, kpi(3), kpi(4), kpi(5), kpi(6), kpi(6, true)] };
const STUB = `const __fixed = { getLocale: async () => "zh-TW", loadConnection: async () => ({ kind: "claude" }), detectAgents: async () => ({ claude: { installed: true, loggedIn: true }, codex: { installed: false } }),
  listStrategies: async () => [], listSessions: async () => [], loadSession: async () => [], loadSessionImages: async () => [], updateState: async () => ({ phase: "idle", current: "0.0.0" }),
  hasBlaveToken: async () => true, ensureEngine: async () => ({}), libraryList: async () => ({ strategies: [], signedIn: true, dataAccess: "included" }),
  reportsList: async () => ({ reports: [] }), reportLoad: async () => null, cloudReports: async () => ({ code: "UNREACH", reports: [] }), trackFeature: () => {} };
window.blave = new Proxy(__fixed, { get: (o, k) => (k in o ? o[k] : typeof k !== "string" ? undefined : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {} : async () => undefined) });`;
const PRINT_STUB = `window.__ready = null; window.blavePrint = { payload: async () => (${JSON.stringify({ report: REPORT, images: {}, lang: "zh", view: "local", savedAt: 1788220800000 })}), ready: (ok) => { window.__ready = ok; } };`;
// 每顆單位:高度(拆行 = 兩行高)、Range 的行框數、有沒有超出格子;每格:有沒有超出那一排
const MEASURE = `(() => { const root = document.querySelector("article.rb-report"), out = { w: Math.round(root.getBoundingClientRect().width), sw: root.scrollWidth, cw: root.clientWidth, rows: [] };
  root.querySelectorAll(".rb-kpi").forEach((row) => { const rr = row.getBoundingClientRect();
    out.rows.push({ n: row.children.length, cells: [...row.querySelectorAll(".rb-kpi-cell")].map((c) => { const u = c.querySelector(".rb-kpi-unit"), v = c.querySelector(".rb-kpi-value"), cr = c.getBoundingClientRect(), ur = u.getBoundingClientRect(), rg = document.createRange(); rg.selectNodeContents(u);
      const lines = new Set([...rg.getClientRects()].map((x) => Math.round(x.top))).size;
      return { h: Math.round(ur.height * 10) / 10, lh: parseFloat(getComputedStyle(u).lineHeight) || 0, lines, text: u.textContent, ws: getComputedStyle(u).whiteSpace, vh: Math.round(v.getBoundingClientRect().height), over: Math.round((ur.right - cr.right) * 10) / 10, out: Math.round((cr.right - rr.right) * 10) / 10 }; }) }); });
  return out; })()`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  ② 逾時(60 秒)"); process.exit(1); }, 60000).unref();
const judge = (m) => {
  const cells = m.rows.reduce((a, r) => a.concat(r.cells), []);
  return { split: cells.filter((c) => c.lines !== 1).length, spill: cells.filter((c) => c.over > 0.5 || c.out > 0.5).length, n: cells.length, scroll: m.sw > m.cw };
};

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const preload = path.join(tmp, "stub.js"), printPreload = path.join(tmp, "print-stub.js");
  fs.writeFileSync(preload, STUB); fs.writeFileSync(printPreload, PRINT_STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(R, "index.html"));
  await wait(1200);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  await js(`(async () => { document.getElementById("rpt-nav").click(); await new Promise((r) => setTimeout(r, 150));
    const g = (x) => document.getElementById(x), host = g("rpt-read"); g("rpt-rows").hidden = true; host.hidden = false; host.textContent = "";
    window.renderAgentReport(host, ${JSON.stringify(REPORT)}, { apiBase: "", i18n: {}, imageUrl: () => "", markdown: (x) => x }); })()`);
  for (const width of [480, 0]) {
    await js(`(() => { const p = document.getElementById("rpt"); p.style.flex = ${width ? '"none"' : '""'}; p.style.width = ${width ? `"${width}px"` : '""'}; })()`);
    await wait(80);
    const m = await js(MEASURE), v = judge(m);
    console.log(`      ${width ? "中欄 " + width : "寬欄"}:閱讀欄 ${m.w}px;單位高度 ${[...new Set(m.rows.reduce((a, r) => a.concat(r.cells.map((c) => c.h)), []))].join(" / ")}px(單行 = ${m.rows[0].cells[0].lh || "normal"});拆行 ${v.split} / ${v.n} 顆`);
    ok(`② ${width ? "中欄最窄(" + width + ")" : "寬欄"}:KPI 3–6 顆、七位數 + USDT,${v.n} 顆單位每顆都只佔一行`, v.n === 24 && v.split === 0, JSON.stringify(m.rows));
    ok(`② ${width ? "中欄最窄(" + width + ")" : "寬欄"}:單位不超出格子、格子不超出那一排、閱讀欄沒有橫向溢出`, v.spill === 0 && !v.scroll, JSON.stringify([v, m.rows]));
  }
  app.on("window-all-closed", () => {});   // 兩個視窗接著開:第一個關掉時不要整個結束
  w.destroy();

  const pw = new BrowserWindow({ width: 900, height: 1200, show: false, webPreferences: { offscreen: true, preload: printPreload, contextIsolation: false, sandbox: false } });
  await pw.loadFile(path.join(R, "report-print.html"));
  let ready = null;
  for (let i = 0; i < 100 && ready == null; i++) { await wait(100); ready = await pw.webContents.executeJavaScript("window.__ready", true); }
  const m = await pw.webContents.executeJavaScript(MEASURE, true), v = judge(m);
  console.log(`      列印頁:內容寬 ${m.w}px;拆行 ${v.split} / ${v.n} 顆`);
  ok("② 列印頁(report-print.html):同一份報告,單位每顆只佔一行、不超出格子", ready === true && v.n === 24 && v.split === 0 && v.spill === 0, JSON.stringify([ready, v, m.rows]));
  pw.destroy();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* userData 還鎖著 */ }
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + (e && e.stack)); app.exit(1); });
