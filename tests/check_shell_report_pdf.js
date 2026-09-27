// 報告存成 PDF(spec-report-pdf-0.1.8 DT1–DT3、P2–P6)。
//   ① 純邏輯:檔名(P3 清理、60 字截斷、日期取報告的本機日期)、寬表縮放、存成時間、聲明條件句。
//   ② shell/reportpdf.js(視窗 / 存檔框 / 寫檔都換成假的):先開存檔框、取消不產、預設資料夾、埋點只在寫成功時、失敗與逾時。
//   ③ 接線:主行程讀報告(renderer 不給內容與路徑)、列印視窗 show:false、IPC 只回應自己開的那個視窗、打包清單、白名單。
//   ④ 用隨包的 Electron、看不見的視窗真的產一份 PDF:淺色、聲明、不印的東西、寬表縮放、頁數、A4。
//      BLAVE_PDF_SAMPLE=<報告.json> BLAVE_PDF_OUT=<輸出.pdf> 時改印那一份、留下檔案(人眼逐頁看用)。
// 跑法:node tests/check_shell_report_pdf.js
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 1500))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
const PDFLIB = require(path.join(SHELL, "reportpdf.js"));
const mainSrc = read(path.join(SHELL, "main.js"));

if (!process.versions.electron) {
  (async () => {
    // ── ① 純邏輯 ──
    const at = (y, m, d, h) => Math.floor(new Date(y, m - 1, d, h || 12).getTime() / 1000);   // 本機時區的那一天
    const rep = (title, gen, created) => ({ title, created_at: created, blocks: [{ type: "meta", title: "meta 的長標題", generated_at: gen }] });
    ok("① 檔名:spec 的兩個例子(/ 換成 -、日期是報告日)", PDFLIB.pdfFileName(rep("台股晨報 09/26", at(2026, 9, 26))) === "台股晨報 09-26_2026-09-26.pdf"
      && PDFLIB.pdfFileName(rep("績效週報 08/25–08/31", at(2026, 8, 31))) === "績效週報 08-25–08-31_2026-08-31.pdf", PDFLIB.pdfFileName(rep("台股晨報 09/26", at(2026, 9, 26))));
    ok("① 檔名:九個禁用字元與控制字元(含 tab)→ -;連續空白收成一個;頭尾空白與結尾的 . 去掉", PDFLIB.pdfSafeTitle('  a/b\\c:d*e?f"g<h>i|j\u0007k   l\tm.. ') === "a-b-c-d-e-f-g-h-i-j-k l-m", PDFLIB.pdfSafeTitle('  a/b\\c:d*e?f"g<h>i|j\u0007k   l\tm.. '));
    const long = PDFLIB.pdfSafeTitle("報".repeat(59) + "😀尾巴");
    ok("① 檔名:超過 60 字截斷(以字元計:表情符號算一個、不會切成半個);截斷後尾端的空白與 . 再收一次", Array.from(long).length === 60 && long.endsWith("😀") && PDFLIB.pdfSafeTitle("x".repeat(59) + " .y") === "x".repeat(59), long);
    ok("① 檔名:日期取本機日期(凌晨 00:30 與 23:30 各自落在當天);沒有 generated_at 用 created_at;兩個都沒有用現在", PDFLIB.pdfFileName(rep("a", at(2026, 3, 5, 0) + 1800)) === "a_2026-03-05.pdf" && PDFLIB.pdfFileName(rep("a", at(2026, 3, 5, 23) + 1800)) === "a_2026-03-05.pdf"
      && PDFLIB.pdfFileName(rep("a", undefined, at(2025, 12, 31))) === "a_2025-12-31.pdf" && PDFLIB.pdfFileName(rep("a", "x", 1e13), at(2026, 1, 2) * 1000) === "a_2026-01-02.pdf");
    ok("① 檔名:標題用信封 title;沒有才用 meta.title;清完是空的 → report", PDFLIB.pdfFileName(rep("短標題", at(2026, 1, 1))).startsWith("短標題_") && PDFLIB.pdfFileName(rep("", at(2026, 1, 1))).startsWith("meta 的長標題_") && PDFLIB.pdfFileName({ title: "...", created_at: at(2026, 1, 1), blocks: [] }) === "report_2026-01-01.pdf");
    ok("① 閘門只有一條:報告 JSON 能渲染(performance 也能存)", PDFLIB.pdfCanRender({ type: "performance", blocks: [] }) && !PDFLIB.pdfCanRender({ blocks: "x" }) && !PDFLIB.pdfCanRender(null));
    const src = read(path.join(R, "report-print.js")), A = "/* ── 純邏輯", B = "/* ── 純邏輯到此 ── */";
    const P = {}; vm.runInNewContext(src.slice(src.indexOf(A), src.indexOf(B)) + "\nObject.assign(this, { pdfZoom, pdfStamp, pdfHasNotes, PDF_WAIT_MS });", P);
    ok("① 寬表:比欄寬才縮、縮到剛好;放得下 / 量不到 = 1", P.pdfZoom(673, 1346) === 0.5 && P.pdfZoom(673, 673) === 1 && P.pdfZoom(673, 400) === 1 && P.pdfZoom(0, 900) === 1);
    ok("① 存成時間 YYYY/MM/DD HH:mm(本機);等字型與圖上限 10 秒", P.pdfStamp(new Date(2026, 8, 28, 14, 5).getTime()) === "2026/09/28 14:05" && P.pdfStamp(NaN) === "" && P.PDF_WAIT_MS === 10000);
    ok("① 聲明的條件句只在報告有註時才放", P.pdfHasNotes({ blocks: [{ type: "footnote", items: [{ id: "a" }] }] }) && !P.pdfHasNotes({ blocks: [{ type: "footnote", items: [] }] }) && !P.pdfHasNotes({ blocks: [{ type: "text" }] }));

    // ── ② reportpdf.js ──
    const EventEmitter = require("events");
    const DOC = { report: rep("台股晨報 09/26", at(2026, 9, 26)), images: { "a.png": "data:image/png;base64,AA==" } };
    const mk = (o) => {
      const log = [], saved = [];
      const c = PDFLIB.createReportPdf({
        loadDoc: async (view, id, ver) => { log.push(["load", view, id, ver]); return o.doc === undefined ? DOC : o.doc; },
        showSave: async (_w, s) => { log.push(["dialog", s.defaultPath, JSON.stringify(s.filters)]); return o.pick === undefined ? { canceled: false, filePath: path.join("/tmp/out dir", "x.pdf") } : o.pick; },
        openPage: () => {
          const wc = new EventEmitter(); wc.printToPDF = async (p) => { log.push(["print", JSON.stringify(p)]); if (o.printFail) throw new Error("boom"); return Buffer.from("%PDF-1.4 fake"); };
          const page = { webContents: wc, gone: false, destroy() { this.gone = true; log.push(["destroy"]); }, isDestroyed() { return this.gone; } };
          log.push(["open"]);
          // 列印頁的行為:載入 → 拿 payload → 回報 ready(o.page 可換成失敗 / 別的視窗來叫)
          setTimeout(() => { wc.emit("did-finish-load"); (o.page || ((cl, w) => { log.push(["payload", JSON.stringify(Object.keys(cl.payload(w) || {}).sort())]); cl.ready(w, true); }))(c, wc); }, 5);
          return page;
        },
        writeFile: async (p, buf) => { log.push(["write", p, String(buf).slice(0, 4)]); if (o.writeFail) throw new Error("EACCES"); },
        getDir: () => (o.dir === undefined ? null : o.dir), setDir: (d) => saved.push(d), downloads: () => "/home/dl", onSaved: () => log.push(["track"]), now: () => new Date(2026, 8, 28, 14, 5).getTime(),
      });
      return { c, log, saved };
    };
    let x = mk({}), started = 0;
    let r = await x.c.save({}, "local", "tw-1", undefined, "zh", () => { started++; x.log.push(["start"]); });
    const seq = x.log.map((l) => l[0]).join();
    ok("② 順序:讀報告 → 先開系統存檔框 → 按了儲存才通知畫面 → 開看不見的視窗 → 交報告 → 印 → 寫檔 → 埋點;視窗用完關掉", r.code === "OK" && seq === "load,dialog,start,open,payload,print,destroy,write,track" && started === 1, seq);
    ok("② 存檔框:預設位置 = 下載項目 + 檔名(P3),只收 pdf", x.log[1][1] === path.join("/home/dl", "台股晨報 09-26_2026-09-26.pdf") && x.log[1][2] === '[{"name":"PDF","extensions":["pdf"]}]', JSON.stringify(x.log[1]));
    ok("② printToPDF 一定帶 preferCSSPageSize 與 printBackground(Electron 預設 Letter、不印背景);頁首頁尾交給 CSS @page;tagged + outline", x.log.find((l) => l[0] === "print")[1] === '{"preferCSSPageSize":true,"printBackground":true,"displayHeaderFooter":false,"generateTaggedPDF":true,"generateDocumentOutline":true}');
    ok("② 交給列印頁的只有 images / lang / report / savedAt / view(沒有路徑、沒有憑證)", x.log.find((l) => l[0] === "payload")[1] === '["images","lang","report","savedAt","view"]');
    ok("② 寫成功 → 記住那個資料夾(只記資料夾)", JSON.stringify(x.saved) === JSON.stringify([path.join("/tmp", "out dir")]));
    x = mk({ dir: "/Users/me/Reports" }); await x.c.save({}, "cloud", "tw-1", 1790000000, "en");
    ok("② 上次存的資料夾當預設位置;雲端視角帶清單上的版本去讀", x.log[1][1].startsWith(path.join("/Users/me/Reports", "台股晨報")) && JSON.stringify(x.log[0]) === '["load","cloud","tw-1",1790000000]', JSON.stringify(x.log.slice(0, 2)));
    x = mk({ pick: { canceled: true } }); started = 0; r = await x.c.save({}, "local", "tw-1", undefined, "zh", () => started++);
    ok("② 取消 = 什麼都沒發生:不開視窗、不寫檔、不送埋點、不通知畫面", r.code === "CANCELED" && x.log.map((l) => l[0]).join() === "load,dialog" && started === 0 && x.saved.length === 0, JSON.stringify(x.log));
    x = mk({ writeFail: true }); r = await x.c.save({}, "local", "tw-1", undefined, "zh");
    ok("② 寫不進去 → FAIL,不送埋點、不記資料夾", r.code === "FAIL" && !x.log.some((l) => l[0] === "track") && x.saved.length === 0, JSON.stringify(x.log));
    x = mk({ printFail: true }); r = await x.c.save({}, "local", "tw-1", undefined, "zh");
    ok("② 產生出錯 → FAIL;視窗照樣關掉、不寫檔", r.code === "FAIL" && x.log.some((l) => l[0] === "destroy") && !x.log.some((l) => l[0] === "write"), JSON.stringify(x.log));
    x = mk({ page: (cl, w) => cl.ready(w, false) }); r = await x.c.save({}, "local", "tw-1", undefined, "zh");
    ok("② 列印頁回報畫不出來 → FAIL(不印空白頁)", r.code === "FAIL" && !x.log.some((l) => l[0] === "print"), JSON.stringify(x.log));
    x = mk({ doc: null }); r = await x.c.save({}, "local", "tw-1", undefined, "zh");
    ok("② 讀不到報告 / 沒有 blocks → FAIL,連存檔框都不開", r.code === "FAIL" && x.log.map((l) => l[0]).join() === "load" && (await mk({ doc: { report: { title: "x" } } }).c.save({}, "local", "a", undefined, "zh")).code === "FAIL");
    x = mk({}); const bad = [await x.c.save({}, "web", "a"), await x.c.save({}, "local", "../etc"), await x.c.save({}, "local", 5)];
    ok("② view / id 形狀不對 → FAIL,不讀檔", bad.every((b) => b.code === "FAIL") && x.log.length === 0);
    let other = null;
    x = mk({ page: (cl, w) => { const stranger = new EventEmitter(); other = cl.payload(stranger); cl.ready(stranger, true); setTimeout(() => cl.ready(w, true), 20); } });
    const t0 = Date.now(); r = await x.c.save({}, "local", "tw-1", undefined, "zh");
    ok("② 別的頁面來要報告 → null;別的頁面回報 ready 不算數(等到自己開的那個視窗才印)", r.code === "OK" && other === null && Date.now() - t0 >= 20);
    x = mk({ page: () => { /* 等第二個請求 */ } });
    const first = x.c.save({}, "local", "tw-1", undefined, "zh"); await new Promise((res) => setTimeout(res, 30));
    const second = await x.c.save({}, "local", "tw-2", undefined, "zh");
    ok("② 上一份還在產 → BUSY(一次一份)", second.code === "BUSY");
    void first;
    ok("② 逾時上限 15 秒 > 列印頁自己的 10 秒", PDFLIB.READY_TIMEOUT_MS === 15000);

    // ── ③ 接線 ──
    const pre = read(path.join(SHELL, "preload.js")), pp = read(path.join(SHELL, "print-preload.js")), open = cutFn(mainSrc, "pdfOpenPage");
    ok("③ 畫面只給 view / id / 版本 / 語言;主行程自己讀報告(本機 reportLoad、雲端 cloudReport)", /reportPdf: \(view, id, ver, lang\) => ipcRenderer\.invoke\("report-pdf", view, id, ver, lang\)/.test(pre) && /if \(view === "local"\) return reportLoad\(id\);/.test(cutFn(mainSrc, "pdfLoadDoc")) && /await cloudReport\(id, ver\)/.test(cutFn(mainSrc, "pdfLoadDoc")));
    ok("③ 列印視窗:show: false、sandbox、contextIsolation、不開新視窗、不導覽;載 renderer/report-print.html", /show: false/.test(open) && /sandbox: true/.test(open) && /contextIsolation: true/.test(open) && /nodeIntegration: false/.test(open) && /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/.test(open) && /will-navigate", \(e\) => e\.preventDefault\(\)/.test(open) && /"renderer", "report-print\.html"/.test(open));
    ok("③ 列印頁的 preload 只有 payload / ready 兩支;主行程比對 sender", /payload: \(\) => ipcRenderer\.invoke\("print-payload"\)/.test(pp) && /ready: \(ok\) => ipcRenderer\.send\("print-ready", ok === true\)/.test(pp) && (pp.match(/ipcRenderer\./g) || []).length === 2
      && /ipcMain\.handle\("print-payload", \(e\) => \(_pdf \? _pdf\.payload\(e\.sender\) : null\)\)/.test(mainSrc) && /ipcMain\.on\("print-ready", \(e, ok\) => \{ if \(_pdf\) _pdf\.ready\(e\.sender, ok\); \}\)/.test(mainSrc));
    ok("③ 埋點 report_pdf:主行程在檔案寫成功時送;名字在白名單", /onSaved: \(\) => tm\(\)\.track\("feature_used", \{ name: "report_pdf" \}\)/.test(mainSrc) && require(path.join(SHELL, "telemetry.js")).EVENTS.feature_used.name.indexOf("report_pdf") >= 0 && !/libTrack\("report_pdf"\)|trackFeature\("report_pdf"\)/.test(read(path.join(R, "report-pdf.js"))));
    ok("③ 打包清單有 reportpdf.js 與 print-preload.js", /files:\s*\[[^\]]*"reportpdf\.js"[^\]]*"print-preload\.js"/.test(read(path.join(SHELL, "electron-builder.config.js"))));
    const html = read(path.join(R, "index.html")), acts = html.slice(html.indexOf('<div class="rpt-acts">'), html.indexOf("</div>", html.indexOf('<div class="rpt-acts">')));
    ok("③ 頁首動作群:〔分享〕在左、〔存成 PDF〕固定最右,兩顆都是 btn-out", /id="rpt-share"[\s\S]*id="rpt-pdf"/.test(acts) && (acts.match(/class="btn-out"/g) || []).length === 2, acts);
    const ph = read(path.join(R, "report-print.html")), css = read(path.join(R, "report-print.css"));
    ok("③ 列印頁:<html> 不帶 data-theme(light);CSP 不准 inline script / style 屬性 / 外連;用同一支 report-blocks.js 與 md.js", !/data-theme/.test(ph.replace(/<!--[\s\S]*?-->/g, "")) && /script-src 'self'; style-src 'self'; img-src data:/.test(ph) && /connect-src 'none'/.test(ph) && /<script src="md\.js"><\/script>\s*<script src="report-blocks\.js"><\/script>\s*<script src="report-print\.js">/.test(ph));
    ok("③ 列印規則(P1 / P4):A4 與邊界、margin box 頁尾與頁碼、print-color-adjust、表頭重印、列不切、圖不過頁、不寫 hex", /@page \{\s*size: A4;\s*margin: 18mm 16mm 20mm;/.test(css) && /@bottom-left \{\s*content: var\(--pdf-foot, ""\);/.test(css) && /counter\(page\) " \/ " counter\(pages\)/.test(css) && /print-color-adjust: exact/.test(css) && /-webkit-print-color-adjust: exact/.test(css)
      && /\.rb-table thead \{ display: table-header-group; \}/.test(css) && /\.rb-table tr, \.rb-heat tr \{ break-inside: avoid; \}/.test(css) && /\.rb-image img \{ max-height: 200mm; object-fit: contain; \}/.test(css) && /orphans: 3; widows: 3/.test(css) && !/#[0-9a-fA-F]{3,8}\b(?![^{]*\{)/.test(css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/#rs_content/g, "")));
    const WEB_CSS = path.join(__dirname, "..", "..", "web", "app", "static", "css", "landing", "agent", "research_share.css");
    if (!fs.existsSync(WEB_CSS)) console.log("SKIP  ③ light remap 與 web 公開頁逐字比對(需要 monorepo 版面)");
    else {
      const w = read(WEB_CSS), seg = w.slice(w.indexOf("#rs_content .rb-report {"), w.indexOf("/* ---------- 文尾 CTA"));
      const rules = [...seg.matchAll(/(?:^|\n)(#rs_content [^{]+\{[^}]*\})/g)].map((m) => m[1].trim());
      const miss = rules.filter((rule) => css.indexOf(rule) < 0);
      ok("③ 報告 block 的 light remap = web 公開頁那一段(逐條都在;那邊改了這裡要跟著搬)", rules.length > 30 && miss.length === 0, rules.length + " 條,缺:" + miss.slice(0, 3).join(" | "));
    }

    const bin = path.join(SHELL, "node_modules", ".bin", "electron");
    if (!fs.existsSync(bin)) { console.log("SKIP  ④ 找不到 shell/node_modules 的 Electron"); console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
    const sub = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" }).status;
    console.log(red || sub ? `\n${red + (sub ? 1 : 0)} 紅` : "\nALL PASS");
    process.exit(red || sub ? 1 : 0);
  })();
  return;
}

// ── ④ Electron(看不見的視窗)──
const { app, BrowserWindow, ipcMain } = require("electron");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-pdf-e-")));
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const NOW = Math.floor(Date.now() / 1000);
const wide = { type: "table", title: "寬表", columns: Array.from({ length: 20 }, (_, i) => ({ key: "c" + i, label: "欄位名稱" + i })), rows: Array.from({ length: 3 }, () => Object.fromEntries(Array.from({ length: 20 }, (_, i) => ["c" + i, "12,345.67"]))) };
const tall = { type: "table", title: "持倉", columns: [{ key: "a", label: "代號" }, { key: "b", label: "名稱" }, { key: "c", label: "股數" }], rows: Array.from({ length: 90 }, (_, i) => ({ a: String(1000 + i), b: "標的 " + i, c: "1,000" })) };
const FIX = { schema_version: "1.6", id: "pdf-1", type: "performance", title: "績效週報 08/25–08/31", created_at: NOW, blocks: [
  { type: "meta", title: "績效週報 08/25–08/31(完整標題)", report_type: "performance", generated_at: NOW, origin: "scheduled", machine: "blave-agent-01" },
  { type: "text", variant: "lead", markdown: "本週 **+1.82%**,回撤收斂[^a]。" },
  { type: "kpi_row", items: [{ label: "報酬", value: "+1.82%", tone: "up" }, { label: "回撤", value: "-0.6%", tone: "down" }] },
  tall, wide,
  { type: "image", file: "a.png", alt: "圖", caption: "說明" },
  { type: "text", markdown: "## 方法\n\n內文一段。", private: true },
  { type: "footnote", items: [{ id: "a", text: "資料來源:臺灣證券交易所" }] }] };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  ④ 逾時(90 秒)"); process.exit(1); }, 90000).unref();

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const SAMPLE = process.env.BLAVE_PDF_SAMPLE, OUT = process.env.BLAVE_PDF_OUT || path.join(app.getPath("userData"), "out.pdf"), LANG = process.env.BLAVE_PDF_LANG || "zh";
  const report = SAMPLE ? JSON.parse(read(SAMPLE)) : FIX;
  const images = {}; report.blocks.forEach((b) => { if (b && b.type === "image") images[b.file || b.sha256] = PNG; });
  // 跟 main.js 同一個 pdfOpenPage(原文切出來跑),只多記下視窗、在印之前量一次畫面
  let win = null, facts = null, shown = false;
  const openPage = () => {
    const sb = { BrowserWindow, path, __dirname: SHELL };
    win = vm.runInNewContext(cutFn(mainSrc, "pdfOpenPage") + "\npdfOpenPage();", sb);
    win.on("show", () => { shown = true; });
    const wc = win.webContents, print = wc.printToPDF.bind(wc);
    wc.printToPDF = async (o) => {
      facts = await wc.executeJavaScript(`(() => { const q = (s) => document.querySelector(s), cs = (n) => getComputedStyle(n), all = (s) => [...document.querySelectorAll(s)];
        const tables = all(".rb-table-wrap").map((w) => { const t = w.querySelector("table"); return { zoom: t.style.zoom || "", fits: t.getBoundingClientRect().width <= w.getBoundingClientRect().width + 1 }; });
        return { theme: document.documentElement.getAttribute("data-theme"), lang: document.documentElement.lang, bodyBg: cs(document.body).backgroundColor, ink: cs(q(".rb-title")).color, title: q(".rb-title").textContent, docTitle: document.title,
          width: Math.round(q(".pdf-sheet").getBoundingClientRect().width), foot: q(".rb-foot") ? cs(q(".rb-foot")).display : "none", stmt: !q("#pdf-statement").hidden, disc: all("#pdf-statement p").map((p) => p.textContent), discTitle: q("#pdf-disc-t").textContent,
          footVar: cs(document.documentElement).getPropertyValue("--pdf-foot"), brand: !!q(".pdf-brand svg"), tables, imgs: all(".rb-image img").length, fnref: all("a.rb-fnref").length, buttons: all("button").filter((b) => cs(b).display !== "none").length,
          leadBorder: q(".rb-lead") ? cs(q(".rb-lead")).borderLeftWidth : "", priv: document.body.textContent.includes("內文一段"), thead: q(".rb-table thead") ? cs(q(".rb-table thead")).display : "" }; })()`);
      return print(o);
    };
    return win;
  };
  const tracked = [];
  const pdf = PDFLIB.createReportPdf({ loadDoc: async () => ({ report, images }), showSave: async () => ({ canceled: false, filePath: OUT }), openPage, writeFile: (p, b) => fs.promises.writeFile(p, b),
    getDir: () => null, setDir: () => {}, downloads: () => app.getPath("userData"), onSaved: () => tracked.push("report_pdf") });
  ipcMain.handle("print-payload", (e) => pdf.payload(e.sender));
  ipcMain.on("print-ready", (e, okv) => pdf.ready(e.sender, okv));
  const r = await pdf.save(null, "local", "pdf-1", undefined, LANG);
  await wait(50);
  const buf = fs.existsSync(OUT) ? fs.readFileSync(OUT) : Buffer.alloc(0), txt = buf.toString("latin1");
  const pages = (txt.match(/\/Type\s*\/Page\b(?!s)/g) || []).length, box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(txt);
  ok("④ 產出:代號 OK、檔案是 PDF、寫成功才記一次埋點;視窗從頭到尾沒有顯示、用完已關", r.code === "OK" && txt.startsWith("%PDF-") && tracked.join() === "report_pdf" && !shown && win.isDestroyed() && BrowserWindow.getAllWindows().length === 0, JSON.stringify([r, buf.length, tracked, shown]));
  if (SAMPLE) { console.log("INFO  樣張:" + OUT + "(" + pages + " 頁)\n      " + JSON.stringify(facts)); app.exit(red ? 1 : 0); return; }
  ok("④ A4(595×842pt);90 列的表跨頁 → 至少 3 頁", !!box && Math.abs(Number(box[1]) - 595) < 2 && Math.abs(Number(box[2]) - 842) < 2 && pages >= 3, JSON.stringify([box && box.slice(1), pages]));
  ok("④ 淺色:沒有 data-theme、紙底純白、標題是墨色;欄寬 = 178mm(673px)", facts.theme === null && facts.bodyBg === "rgb(255, 255, 255)" && facts.ink === "rgb(26, 34, 44)" && Math.abs(facts.width - 673) <= 1, JSON.stringify(facts));
  ok("④ 頁 1 頂有 lockup;文件標題 = 信封 title;語言照畫面給的", facts.brand && facts.docTitle === "績效週報 08/25–08/31" && facts.lang === "zh-Hant");
  ok("④ 每頁頁尾的字由字串表給(--pdf-foot);文末長版聲明四段、有註才帶條件句、存成時間", facts.footVar.includes("由 Blave Agent 產出") && facts.stmt && facts.discTitle === "聲明" && facts.disc.length === 4 && facts.disc[0].startsWith("本文件由 Blave 用戶透過其 Blave Agent") && facts.disc[1].startsWith("本文件不構成")
    && facts.disc[2] === "AI 產出可能有錯誤、遺漏或資料延遲。本文件的註列有產出時使用的資料來源，供讀者自行查核。投資前請獨立判斷，並自行承擔盈虧。" && /^本文件存成於 \d{4}\/\d\d\/\d\d \d\d:\d\d，是當下那一版的副本/.test(facts.disc[3]), JSON.stringify(facts.disc));
  ok("④ 不印:閱讀層尾行 .rb-foot、任何鈕;私人區塊保留(績效報告也能存)", facts.foot === "none" && facts.buttons === 0 && facts.priv);
  ok("④ 寬表(20 欄)縮到欄寬內、一般的表不縮;表頭是 table-header-group(換頁重印)", facts.tables.length === 2 && facts.tables[0].zoom === "" && Number(facts.tables[1].zoom) > 0 && Number(facts.tables[1].zoom) < 1 && facts.tables.every((t) => t.fits) && facts.thead === "table-header-group", JSON.stringify(facts.tables));
  ok("④ 同一支渲染器:圖走主行程給的 data URI、markdown 的尾註引用是上標、lead 是左線版", facts.imgs === 1 && facts.fnref === 1 && facts.leadBorder === "2px", JSON.stringify([facts.imgs, facts.fnref, facts.leadBorder]));
  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
