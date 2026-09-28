// 報告存成 PDF(spec-report-pdf-0.1.8 DT1–DT3、P2–P6)。
//   ① 純邏輯:檔名(P3 清理、60 字截斷、日期取報告的本機日期)、寬表縮放、存成時間、聲明條件句。
//   ② shell/reportpdf.js(視窗 / 存檔框 / 寫檔都換成假的):先開存檔框、取消不產、預設資料夾、埋點只在寫成功時、失敗與逾時。
//   ③ 接線:主行程讀報告(renderer 不給內容與路徑)、列印視窗 show:false、IPC 只回應自己開的那個視窗、打包清單、白名單。
//   ④ 用隨包的 Electron、看不見的視窗真的產一份 PDF:淺色、聲明、不印的東西、寬表縮放、頁數、A4。
//      BLAVE_PDF_SAMPLE=<報告.json> BLAVE_PDF_OUT=<輸出.pdf> 時改印那一份、留下檔案(人眼逐頁看用)。
//   ⑤ 圖表真的畫進 PDF:量寬的圖(candlestick / bar_chart)原本等下一幀才畫,列印頁載完就印 → 圖是空的(時有時無)。
//      把 requestAnimationFrame 釘死(= 印之前一幀都沒來),印的那一刻每張圖都要有 svg、有尺寸、有該有的柱數。
// 跑法:node tests/check_shell_report_pdf.js
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os");
const GATE = require("./_electron_gate");
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
    const P = {}; vm.runInNewContext(src.slice(src.indexOf(A), src.indexOf(B)) + "\nObject.assign(this, { pdfZoom, pdfStamp, pdfHasNotes, PDF_WAIT_MS, PDF_Z_MIN, PDF_WIDE_W });", P);
    // 寬表三級(稽核 P1;案例同 web/tests/check_report_pdf.js)
    const Z = (a, n, w) => JSON.stringify(P.pdfZoom(a, n, w)), R3 = (z, wide, note) => JSON.stringify({ z, wide, note });
    ok("① 寬表 ①:放得下 / 量不到不縮;直式縮到剛好,下限 0.62(0.6203 還在下限內)", P.PDF_Z_MIN === 0.62 && P.PDF_WIDE_W === 1001 && Z(673, 600, 1001) === R3(1, false, false) && Z(673, 673, 1001) === R3(1, false, false) && Z(0, 600, 1001) === R3(1, false, false)
      && Z(673, 1000, 1001) === R3(0.673, false, false) && Z(673, 1085, 1001) === R3(673 / 1085, false, false));
    ok("① 寬表 ②:直式到下限還放不下 → 改橫式,用橫式內容寬重算(不放大超過 1)", Z(673, 1100, 1001) === R3(0.91, true, false) && Z(673, 1500, 1001) === R3(1001 / 1500, true, false) && Z(673, 1090, 1200) === R3(1, true, false));
    ok("① 寬表 ③:橫式也到下限才繼續縮,加一行小字;沒有橫式頁可用(wideAvail 不給)= 跳過 ②", Z(673, 2000, 1001) === R3(0.5005, true, true) && Z(673, 1500, 0) === R3(673 / 1500, false, true) && Z(673, 1500) === R3(673 / 1500, false, true));
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
    { const r0 = await mk({}).c.save({}, "local", "tw-1", undefined, "zh", () => {});
      ok("② 成功只回 code(沒給 savedRef 時 dir / token 是 null);路徑不在回傳裡", JSON.stringify(r0) === '{"code":"OK","dir":null,"token":null}', JSON.stringify(r0)); }
    { const y = mk({}), refs = []; const c2 = PDFLIB.createReportPdf({ loadDoc: async () => DOC, showSave: async () => ({ canceled: false, filePath: path.join("/tmp/out dir", "x.pdf") }),
        openPage: () => { const wc = new EventEmitter(); wc.printToPDF = async () => Buffer.from("%PDF"); setTimeout(() => { wc.emit("did-finish-load"); c2.ready(wc, true); }, 5); return { webContents: wc, destroy() {}, isDestroyed: () => false }; },
        writeFile: async () => {}, getDir: () => null, setDir: () => {}, downloads: () => "/home/dl", onSaved: () => {}, savedRef: (p) => { refs.push(p); return { dir: "out dir", token: "abc123", path: p }; } });
      const r2 = await c2.save({}, "local", "tw-1", undefined, "zh", () => {});
      ok("② 設計 D1:成功多回 { dir, token }(主行程的 savedRef 給);只有這兩欄,完整路徑不交給畫面", JSON.stringify(r2) === '{"code":"OK","dir":"out dir","token":"abc123"}' && refs.join() === path.join("/tmp/out dir", "x.pdf"), JSON.stringify(r2)); void y; }
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
      && /\.rb-table thead \{\s*display: table-header-group;\s*\}/.test(css) && /\.rb-table tr,\s*\.rb-heat tr \{\s*break-inside: avoid;\s*\}/.test(css) && /\.rb-image img \{\s*max-height: 200mm;\s*object-fit: contain;\s*\}/.test(css) && /orphans: 3;\s*widows: 3/.test(css) && !/#[0-9a-fA-F]{3,8}\b(?![^{]*\{)/.test(css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/#rs_content/g, "")));
    const printJs = read(path.join(R, "report-print.js")), STR = (() => { const sb = {}; vm.runInNewContext(read(path.join(R, "strings.js")) + "\nthis.S = STRINGS;", sb); return sb.S; })();
    ok("③ 寬表三級的接線(P1):CSS 有具名橫式頁與 --pdf-z;JS 把倍率寫在 --pdf-z、橫式加 .is-wide、③ 才插那一行小字(字面 zh / en 定稿);等字型與圖之後再量一次",
      /@page wide \{\s*size: A4 landscape;\s*\}/.test(css) && /\.rb-block\.is-wide \{\s*page: wide;\s*\}/.test(css) && /\.rb-table-wrap > table,\s*\.rb-heat-wrap > table \{\s*zoom: var\(--pdf-z, 1\);\s*\}/.test(css)
      && /pdfZoom\(w\.clientWidth, tb\.scrollWidth, block \? PDF_WIDE_W : 0\)/.test(printJs) && /tb\.style\.setProperty\("--pdf-z", String\(r\.z\)\)/.test(printJs) && /block\.classList\.toggle\("is-wide", r\.wide\)/.test(printJs)
      && /note\.className = "rb-cap pdf-table-note"; note\.textContent = t\("pdf\.tableNote"\);/.test(printJs) && /pdfFitTables\(host\);\s*await pdfAssets\(\);\s*pdfFitTables\(host\);/.test(printJs) && !/style\.zoom/.test(printJs)
      && STR.zh["pdf.tableNote"] === "這張表已縮小以放進頁面，原始大小請在 Blave 裡看。" && STR.en["pdf.tableNote"] === "This table is scaled down to fit the page. Open the report in Blave to see it at full size.");
    ok("③ 圖表:回報 ready 之前當場畫完量寬的圖(不等下一幀);渲染器把 drawReportCharts 交出來", /pdfFitTables\(host\);\s*(?:\/\/[^\n]*\n\s*)*window\.drawReportCharts\(\);\s*ok = true;/.test(printJs) && /global\.drawReportCharts = drawChartsNow;/.test(read(path.join(R, "report-blocks.js"))));
    const WEB_RB = path.join(__dirname, "..", "..", "web", "app", "static", "js", "agent", "report_blocks.js");
    if (!fs.existsSync(WEB_RB)) console.log("SKIP  ③ drawChartsNow 與 web 逐字比對(需要 monorepo 版面)");
    else {
      const cutIn = (src2, name) => { try { return cutFn(src2, name); } catch (_) { return null; } };
      const mine = cutIn(read(path.join(R, "report-blocks.js")), "drawChartsNow"), theirs = cutIn(read(WEB_RB), "drawChartsNow");
      ok("③ drawChartsNow 與 web 的 report_blocks.js 逐字相同(web 的列印頁有同一個洞,兩邊一起補)", !!mine && mine === theirs && /global\.drawReportCharts = drawChartsNow;/.test(read(WEB_RB)), theirs === null ? "web 沒有 drawChartsNow" : "");
    }
    ok("③ 孤行(e2e #17):清單一條不切、最後一條不單獨落到下一頁;block 的尾註(含寬表那行小字)跟著前一列走", /\.rb-news-item,\s*\.rb-fn,\s*\.rb-text li \{\s*break-inside: avoid;\s*\}/.test(css) && /\.rb-text li:last-child,\s*\.rb-cap \{\s*break-before: avoid;\s*\}/.test(css));
    const pdfJs = read(path.join(R, "report-pdf.js"));
    ok("③ PDF 鈕換字前鎖原寬(稽核 P4:左邊的「分享」不位移);回到原字才解", /if \(state === "idle"\) b\.style\.minWidth = ""; else if \(!b\.hidden && b\.offsetWidth\) b\.style\.minWidth = b\.offsetWidth \+ "px";\s*PDF\.state = state;/.test(cutFn(pdfJs, "pdfSet")));
    // 設計 D1:存完的回饋是頁首同一列的狀態句 +「在 Finder 中顯示」,不是鈕上閃字
    { const mkEl = () => ({ hidden: true, disabled: false, textContent: "", title: "", style: {}, offsetWidth: 81, on: {}, addEventListener(e, f) { this.on[e] = f; } });
      const els = { "rpt-pdf": mkEl(), "rpt-share": mkEl(), "rpt-back": mkEl(), "rpt-reveal": mkEl(), "rpt-saved": Object.assign(mkEl(), { d: mkEl(), s: mkEl(), querySelector(q) { return q === ".d" ? this.d : this.s; } }) };
      const said = [], boxes = [], revealed = []; let next = null, onSaving = null;
      const sb = { console, Promise, document: { getElementById: (i) => els[i] }, $: (i) => els[i], t: (k, v) => STR.zh[k].split("{dir}").join(v ? v.dir : ""), LANG: "zh", srSay: (x) => said.push(x), confirmBox: (o) => boxes.push(o), RPT: { data: { local: [], cloud: [] } },
        window: { blave: { platform: "darwin", reportPdf: async () => { const r = next; if (r && r.start) onSaving(); return r; }, revealExport: (tk) => revealed.push(tk), onReportPdfSaving: (f) => { onSaving = f; } } } };
      vm.createContext(sb); vm.runInContext(pdfJs + "\nthis.PDF = PDF; this.pdfSave = pdfSave; this.pdfClear = pdfClear; this.pdfDecorate = pdfDecorate;", sb);
      const REP = { blocks: [] }, box = els["rpt-saved"], btn = els["rpt-pdf"], snap = () => [box.hidden, box.d.textContent, box.s.textContent, els["rpt-reveal"].textContent, btn.textContent].join("|");
      sb.pdfDecorate("local", "a", REP);
      ok("③ D1 還沒存:沒有狀態句,鈕是「存成 PDF」", snap() === "true||||存成 PDF", snap());
      next = { code: "OK", dir: "報告", token: "tk1", start: true }; await sb.pdfSave();
      ok("③ D1 成功:狀態句「已存到「報告」」+「在 Finder 中顯示」,窄欄短句「已存成」(全文在 title);鈕直接回「存成 PDF」、不閃「已存成」;讀屏念完整句",
        snap() === "false|已存到「報告」|已存成|在 Finder 中顯示|存成 PDF" && box.d.title === "已存到「報告」" && box.s.title === "已存到「報告」" && btn.disabled === false && said.join() === "已存到「報告」" && btn.style.minWidth === "", snap() + " " + said.join());
      els["rpt-reveal"].on.click();
      ok("③ D1 文字鈕只交 token(renderer 不傳路徑);走轉出卡那一支 revealExport", revealed.join() === "tk1" && /revealExport\(PDF\.saved\.token\)/.test(pdfJs) && !/filePath|showItemInFolder/.test(pdfJs));
      next = { code: "CANCELED" }; await sb.pdfSave();
      ok("③ D1 存檔框按取消:什麼都沒發生——上一次存的那句留著、不跳框", snap() === "false|已存到「報告」|已存成|在 Finder 中顯示|存成 PDF" && boxes.length === 0, snap());
      next = { code: "OK", dir: null, token: "tk2", start: true }; let mid = null; const real = sb.window.blave.reportPdf; sb.window.blave.reportPdf = async () => { onSaving(); mid = snap(); return next; }; await sb.pdfSave(); sb.window.blave.reportPdf = real;
      ok("③ D1 開始產的那一刻清掉上一次的(鈕「存成中…」);存到「下載項目」時資料夾名由畫面翻", mid === "true|已存到「報告」|已存成|在 Finder 中顯示|存成中…" && snap() === "false|已存到「下載」|已存成|在 Finder 中顯示|存成 PDF", mid + " → " + snap());
      next = { code: "FAIL", start: true }; await sb.pdfSave();
      ok("③ D1 失敗:沒有狀態句、鈕回「存成 PDF」、出既有的單鈕失敗框", box.hidden === true && btn.textContent === "存成 PDF" && boxes.length === 1 && boxes[0].single === true, snap());
      next = { code: "OK", dir: "報告", token: "tk3", start: true }; await sb.pdfSave(); sb.pdfDecorate("local", "b", REP);
      const other = snap(); sb.pdfDecorate("local", "a", REP);
      ok("③ D1 換另一份報告就清掉;之後再打開同一份不恢復;回清單(pdfClear)也清", other === "true|已存到「報告」|已存成|在 Finder 中顯示|存成 PDF" && box.hidden === true && (sb.pdfClear(), sb.PDF.saved === null), other);
      sb.window.blave.platform = "win32"; sb.pdfDecorate("cloud", "c", REP); next = { code: "OK", dir: "x", token: "tk4", start: true }; await sb.pdfSave();
      ok("③ D1 Windows 的文字鈕是「在檔案總管中顯示」;雲端視角的報告同一套", els["rpt-reveal"].textContent === "在檔案總管中顯示" && box.hidden === false);
      ok("③ D1 不計時:PDF_FLASH_MS 與 saved 狀態退場;節點不掛 role=status(播報走 srSay)", !/PDF_FLASH_MS|setTimeout|"saved"/.test(pdfJs) && /<p class="rpt-saved" id="rpt-saved" hidden><span class="d"><\/span><span class="s"><\/span><button class="btn-quiet" id="rpt-reveal" type="button"><\/button><\/p>\s*<div class="rpt-acts">/.test(html));
      const rcss = read(path.join(R, "reports.css"));
      ok("③ D1 排法:同一列靠右貼著動作群、返回鈕不被擠(flex: none)、資料夾名單行截尾、文字鈕不縮、中欄 ≤ 560 換短句", /\.rpt-rhead \.rpt-back \{ flex: none; \}/.test(rcss) && /\.rpt-saved \{ flex: 0 1 auto; min-width: 0; display: flex; align-items: center; gap: var\(--space-6\); margin: 0 0 0 auto; font-size: 12px; line-height: 1\.5; color: var\(--ink-2\); \}/.test(rcss)
        && /\.rpt-saved \.d \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/.test(rcss) && /\.rpt-saved \.btn-quiet \{ flex: none;/.test(rcss) && /@container main \(max-width: 560px\) \{ \.rpt-saved \.d \{ display: none; \} \.rpt-saved \.s \{ display: inline; \} \}/.test(rcss));
      ok("③ D1 主行程:reportPdf 把 savedRef 交給 reportpdf.js;轉出卡與 PDF 共用同一張 token 表,reveal-export 只認那張表", /savedRef,\s*\}\);/.test(cutFn(mainSrc, "reportPdf")) && /return \{ ok: true, \.\.\.savedRef\(r\.filePath\) \};/.test(mainSrc) && /savedExports\.set\(token, filePath\);/.test(cutFn(mainSrc, "savedRef"))
        && /handle\("reveal-export", \(_e, token\) => \{ const p = savedExports\.get\(String\(token \|\| ""\)\);/.test(mainSrc)); }
    const WEB_PRINT = path.join(__dirname, "..", "..", "web", "app", "static", "css", "agent", "report_print.css");
    if (!fs.existsSync(WEB_PRINT)) console.log("SKIP  ③ 共用列印規則與 web 逐字比對(需要 monorepo 版面)");
    else {
      const mark = "/* ========== 共用:以下到檔尾逐字同 web 的 report_print.css ========== */\n", at = css.indexOf(mark), host = at < 0 ? "" : css.slice(0, at), shared = at < 0 ? "" : css.slice(at + mark.length), w = read(WEB_PRINT);
      let d = 0; while (d < shared.length && shared[d] === w[d]) d++;
      ok("③ 共用列印規則 = web 的 report_print.css(逐字;那邊改了整段搬過來)", at > 0 && shared === w, at < 0 ? "找不到共用段的標記" : "第 " + d + " 字起不同:" + JSON.stringify(shared.slice(d, d + 80)) + " vs " + JSON.stringify(w.slice(d, d + 80)));
      ok("③ 共用段要宿主頁給的三樣:--pdf-sans / --pdf-mono 在宿主段、--pdf-foot 由 report-print.js 設;@page 與不印按鈕的規則只在共用段", /--pdf-sans: [^;]+;/.test(host) && /--pdf-mono: [^;]+;/.test(host) && /setProperty\("--pdf-foot"/.test(read(path.join(R, "report-print.js")))
        && !/@page|display: none !important/.test(host) && /font: 400 7\.5pt\/1\.4 var\(--pdf-sans,/.test(shared) && /font: 400 7\.5pt\/1\.4 var\(--pdf-mono,/.test(shared) && /#rs_content button,/.test(shared) && !/\.pdf-doc button/.test(css) && /\.pdf-brand img,\s*\.pdf-brand svg \{/.test(shared));
    }
    const WEB_CSS = path.join(__dirname, "..", "..", "web", "app", "static", "css", "landing", "agent", "research_share.css");
    if (!fs.existsSync(WEB_CSS)) console.log("SKIP  ③ light remap 與 web 公開頁逐字比對(需要 monorepo 版面)");
    else {
      const w = read(WEB_CSS), seg = w.slice(w.indexOf("#rs_content .rb-report {"), w.indexOf("/* ---------- 文尾 CTA"));
      const rules = [...seg.matchAll(/(?:^|\n)(#rs_content [^{]+\{[^}]*\})/g)].map((m) => m[1].trim());
      const miss = rules.filter((rule) => css.indexOf(rule) < 0);
      ok("③ 報告 block 的 light remap = web 公開頁那一段(逐條都在;那邊改了這裡要跟著搬)", rules.length > 30 && miss.length === 0, rules.length + " 條,缺:" + miss.slice(0, 3).join(" | "));
    }

    const bin = GATE.bin(SHELL, "④");
    if (!bin) { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
    const sub = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" }).status;
    const n = red + (sub == null ? 1 : sub);
    console.log(n ? `\n${n} 紅` : "\nALL PASS"); process.exit(n ? 1 : 0);
  })();
  return;
}

// ── ④ Electron(看不見的視窗)──
const { app, BrowserWindow, ipcMain, session } = require("electron");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-pdf-e-")));
// 這支測試唯一的視窗就是列印頁:它一關,Electron 預設(沒人聽 window-all-closed)就結束程式、exit 0——後面的斷言一條都沒跑到還算綠
app.on("window-all-closed", () => {});
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const NOW = Math.floor(Date.now() / 1000);
const cols = (n, title) => ({ type: "table", title, columns: Array.from({ length: n }, (_, i) => ({ key: "c" + i, label: "欄位名稱" + i })), rows: Array.from({ length: 3 }, () => Object.fromEntries(Array.from({ length: n }, (_, i) => ["c" + i, "12,345.67"]))) });
const narrow = cols(10, "10 欄"), mid = cols(15, "15 欄"), wide = cols(20, "20 欄");   // 寬表三級各一張
const tall = { type: "table", title: "持倉", columns: [{ key: "a", label: "代號" }, { key: "b", label: "名稱" }, { key: "c", label: "股數" }], rows: Array.from({ length: 90 }, (_, i) => ({ a: String(1000 + i), b: "標的 " + i, c: "1,000" })) };
const FIX = { schema_version: "1.6", id: "pdf-1", type: "performance", title: "績效週報 08/25–08/31", created_at: NOW, blocks: [
  // report_type 是給人看的顯示字(lib/report.py 的參數說明),不是 type 代號——樣張上印出 performance 是這份假資料寫錯(稽核 P5)
  { type: "meta", title: "週報 08/25–08/31(完整標題)", report_type: "績效週報", generated_at: NOW, origin: "scheduled", machine: "blave-agent-01" },
  { type: "text", variant: "lead", markdown: "本週 **+1.82%**,回撤收斂[^a]。" },
  { type: "kpi_row", items: [{ label: "報酬", value: "+1.82%", tone: "up" }, { label: "回撤", value: "-0.6%", tone: "down" }] },
  tall, narrow, mid, wide,
  { type: "image", file: "a.png", alt: "圖", caption: "說明" },
  { type: "text", markdown: "## 方法\n\n內文一段。", private: true },
  { type: "footnote", items: [{ id: "a", text: "資料來源:臺灣證券交易所" }] }] };
// ⑤ 的樣本:實機存出空圖的那一份台股大盤晨報(市場資料,沒有帳戶資訊)
const TW = JSON.parse(read(path.join(__dirname, "fixtures", "report_tw_market_pdf.json")));
const CHART_TYPES = ["bar_chart", "candlestick", "line_chart"];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  ④ 逾時(90 秒)"); process.exit(1); }, 90000).unref();

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const SAMPLE = process.env.BLAVE_PDF_SAMPLE, OUT = process.env.BLAVE_PDF_OUT || path.join(app.getPath("userData"), "out.pdf"), LANG = process.env.BLAVE_PDF_LANG || "zh";
  let report = SAMPLE ? JSON.parse(read(SAMPLE)) : FIX;
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
        const tables = all(".rb-table-wrap").map((w) => { const t = w.querySelector("table"), wide = !!w.closest(".rb-block.is-wide"), n = w.nextElementSibling;
          return { z: t.style.getPropertyValue("--pdf-z"), used: cs(t).zoom, wide, need: t.scrollWidth, width: Math.round(t.getBoundingClientRect().width), room: wide ? 1001 : Math.round(w.getBoundingClientRect().width),
            note: n && n.classList.contains("pdf-table-note") ? n.textContent : "", page: cs(w.closest(".rb-block")).page }; });
        return { theme: document.documentElement.getAttribute("data-theme"), lang: document.documentElement.lang, bodyBg: cs(document.body).backgroundColor, ink: cs(q(".rb-title")).color, title: q(".rb-title").textContent, docTitle: document.title,
          width: Math.round(q(".pdf-sheet").getBoundingClientRect().width), foot: q(".rb-foot") ? cs(q(".rb-foot")).display : "none", stmt: !q("#pdf-statement").hidden, disc: all("#pdf-statement p").map((p) => p.textContent), discTitle: q("#pdf-disc-t").textContent,
          footVar: cs(document.documentElement).getPropertyValue("--pdf-foot"), brand: !!q(".pdf-brand svg"), tables, imgs: all(".rb-image img").length, fnref: all("a.rb-fnref").length, buttons: all("button").filter((b) => cs(b).display !== "none").length,
          blocks: all(".rb-block").map((b) => { const s = b.querySelector("svg.rb-chart"); if (!s) return null; const r = s.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height), bars: s.querySelectorAll(".rb-bar-up, .rb-bar-dn").length, lines: s.querySelectorAll("polyline").length, texts: s.querySelectorAll("text").length }; }),
          raf: String(window.requestAnimationFrame).length,
          leadBorder: q(".rb-lead") ? cs(q(".rb-lead")).borderLeftWidth : "", priv: document.body.textContent.includes("內文一段"), thead: q(".rb-table thead") ? cs(q(".rb-table thead")).display : "", typeTag: q(".rb-type-tag") ? q(".rb-type-tag").textContent : null }; })()`);
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
  const boxes = [...txt.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => Math.round(Number(m[1])) + "x" + Math.round(Number(m[2])));
  ok("④ 產出:代號 OK、檔案是 PDF、寫成功才記一次埋點;視窗從頭到尾沒有顯示、用完已關", r.code === "OK" && txt.startsWith("%PDF-") && tracked.join() === "report_pdf" && !shown && win.isDestroyed() && BrowserWindow.getAllWindows().length === 0, JSON.stringify([r, buf.length, tracked, shown]));
  if (SAMPLE) { console.log("INFO  樣張:" + OUT + "(" + pages + " 頁;各頁 " + boxes.join(" ") + ")\n      " + JSON.stringify(facts)); app.exit(red ? 1 : 0); return; }
  ok("④ A4(595×842pt);90 列的表跨頁 → 至少 3 頁", !!box && Math.abs(Number(box[1]) - 595) < 2 && Math.abs(Number(box[2]) - 842) < 2 && pages >= 3, JSON.stringify([box && box.slice(1), pages]));
  ok("④ 淺色:沒有 data-theme、紙底純白、標題是墨色;欄寬 = 178mm(673px)", facts.theme === null && facts.bodyBg === "rgb(255, 255, 255)" && facts.ink === "rgb(26, 34, 44)" && Math.abs(facts.width - 673) <= 1, JSON.stringify(facts));
  ok("④ 頁 1 頂有 lockup;文件標題 = 信封 title;語言照畫面給的;類型標籤印的是 report_type 那個顯示字", facts.brand && facts.docTitle === "績效週報 08/25–08/31" && facts.lang === "zh-Hant" && facts.typeTag === "績效週報", JSON.stringify(facts.typeTag));
  ok("④ 每頁頁尾的字由字串表給(--pdf-foot);文末長版聲明四段、有註才帶條件句、存成時間", facts.footVar.includes("由 Blave Agent 產出") && facts.stmt && facts.discTitle === "聲明" && facts.disc.length === 4 && facts.disc[0].startsWith("本文件由 Blave 用戶透過其 Blave Agent") && facts.disc[1].startsWith("本文件不構成")
    && facts.disc[2] === "AI 產出可能有錯誤、遺漏或資料延遲。本文件的註列有產出時使用的資料來源，供讀者自行查核。投資前請獨立判斷，並自行承擔盈虧。" && /^本文件存成於 \d{4}\/\d\d\/\d\d \d\d:\d\d，是當下那一版的副本/.test(facts.disc[3]), JSON.stringify(facts.disc));
  ok("④ 不印:閱讀層尾行 .rb-foot、任何鈕;私人區塊保留(績效報告也能存)", facts.foot === "none" && facts.buttons === 0 && facts.priv);
  const [t0, ta, t1, t2] = facts.tables, fits = (t) => t.width <= t.room + 1, near = (a, b) => Math.abs(Number(a) - b) < 0.001;
  ok("④ 一般的表不縮、不換頁;表頭是 table-header-group(換頁重印)", facts.tables.length === 4 && t0.z === "" && !t0.wide && !t0.note && t0.page === "auto" && fits(t0) && facts.thead === "table-header-group", JSON.stringify(facts.tables));
  ok("④ 寬表 ①(10 欄):直式縮到剛好(不低於 0.62),留在直式頁、不加小字", !ta.wide && ta.page === "auto" && near(ta.z, 673 / ta.need) && Number(ta.z) >= 0.62 && Number(ta.z) < 1 && near(ta.used, Number(ta.z)) && fits(ta) && !ta.note, JSON.stringify(ta));
  ok("④ 寬表 ②(15 欄):直式要縮到下限以下 → 那一塊改橫式頁(page: wide),倍率 = 橫式內容寬 / 表寬、不低於 0.62,不加小字", t1.wide && t1.page === "wide" && 673 / t1.need < 0.62 && near(t1.z, Math.min(1, 1001 / t1.need)) && Number(t1.z) >= 0.62 && near(t1.used, Number(t1.z)) && fits(t1) && !t1.note, JSON.stringify(t1));
  ok("④ 寬表 ③(20 欄):橫式也放不下 → 繼續縮到剛好,表下一行小字", t2.wide && t2.page === "wide" && near(t2.z, 1001 / t2.need) && Number(t2.z) < 0.62 && fits(t2) && t2.note === "這張表已縮小以放進頁面，原始大小請在 Blave 裡看。", JSON.stringify(t2));
  ok("④ printToPDF 認具名橫式頁:同一份 PDF 直式(595×842)與橫式(842×595)混排", boxes.includes("595x842") && boxes.includes("842x595"), boxes.join(" "));
  ok("④ 同一支渲染器:圖走主行程給的 data URI、markdown 的尾註引用是上標、lead 是左線版", facts.imgs === 1 && facts.fnref === 1 && facts.leadBorder === "2px", JSON.stringify([facts.imgs, facts.fnref, facts.leadBorder]));

  // ── ⑤ 圖表 ──
  // 最壞情況:印之前一幀都沒來。釘死 requestAnimationFrame,量寬的圖只能靠列印頁自己當場畫
  const stub = path.join(app.getPath("userData"), "noframe.js");
  fs.writeFileSync(stub, 'require("electron").webFrame.executeJavaScript("window.requestAnimationFrame = function () { return 0; };");');
  session.defaultSession.registerPreloadScript({ type: "frame", filePath: stub });
  report = TW; facts = null;
  const OUT2 = path.join(app.getPath("userData"), "tw.pdf");
  const pdf2 = PDFLIB.createReportPdf({ loadDoc: async () => ({ report, images: {} }), showSave: async () => ({ canceled: false, filePath: OUT2 }), openPage, writeFile: (p, b) => fs.promises.writeFile(p, b),
    getDir: () => null, setDir: () => {}, downloads: () => app.getPath("userData"), onSaved: () => {} });
  ipcMain.removeHandler("print-payload"); ipcMain.removeAllListeners("print-ready");
  ipcMain.handle("print-payload", (e) => pdf2.payload(e.sender));
  ipcMain.on("print-ready", (e, okv) => pdf2.ready(e.sender, okv));
  const r2 = await pdf2.save(null, "local", "tw-market-20260928", undefined, "zh");
  await wait(50);
  const want = TW.blocks.map((b) => (CHART_TYPES.indexOf(b.type) >= 0 ? b : null)), got = (facts && facts.blocks) || [];
  ok("⑤ 樣本:台股大盤晨報的四張圖(bar_chart 10 根、candlestick 90 根、bar_chart 3 根、line_chart);這一輪沒有下一幀", r2.code === "OK" && fs.existsSync(OUT2) && facts && facts.raf < 40
    && want.filter(Boolean).map((b) => b.type + (b.items || b.candles || []).length).join() === "bar_chart10,candlestick90,bar_chart3,line_chart0" && got.length === TW.blocks.length, JSON.stringify([r2, facts && facts.raf, got.length, TW.blocks.length]));
  const bad = want.map((b, i) => {
    if (!b) return null;
    const c = got[i], marks = b.type === "bar_chart" ? b.items.length : b.type === "candlestick" ? b.candles.length * 2 : 0;   // K 棒 = 影線 + 實體
    if (!c) return i + " " + b.type + ":沒有 svg";
    if (Math.abs(c.w - 673) > 1 || c.h < 100) return i + " " + b.type + ":尺寸 " + c.w + "×" + c.h;
    if (marks ? c.bars !== marks : c.lines < 1) return i + " " + b.type + ":柱 " + c.bars + " / 線 " + c.lines + "(要 " + (marks || "≥1 條線") + ")";
    return c.texts > 0 ? null : i + " " + b.type + ":沒有軸標";
  }).filter(Boolean);
  ok("⑤ 印的那一刻每張圖都畫好了:有 svg、寬 = 欄寬 673、高 ≥ 100、柱數 / K 棒數 / 折線對得上資料", bad.length === 0, bad.join(" | "));
  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
