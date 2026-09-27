// Blave 電腦版 — 報告存成 PDF(主行程用)。設計:blave-canon output/designer/spec-report-pdf-0.1.8.md DT2 / DT3 / P3。
//
// 流程:先開系統存檔框(取消 = 什麼都沒發生)→ 開一個看不見的視窗載 renderer/report-print.html,用同一支 report-blocks.js
// 把同一份報告 JSON 畫成淺色 → printToPDF → 寫檔。全程在 app 內,不導去 web。
//
// 為什麼在主行程:畫面會渲染 LLM 的文字,不能讓它決定寫哪個檔、寫什麼——renderer 只給 view / id / 語言,
// 報告本體由主行程自己讀(同 reportshare.js 的立場),路徑只來自用戶在存檔框選的那一個。
//
// 這個檔不 require electron;視窗、對話框、讀報告、記資料夾都由呼叫端注入(測試用假的)。
const path = require("path");

const VIEWS = ["local", "cloud"], LANGS = ["en", "zh"];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TITLE_MAX = 60;                 // 以字元(code point)計,不是 UTF-16 長度
const TS_MIN = 946684800, TS_MAX = 4102444800;
// 列印頁自己最多等字型與圖 10 秒(spec DT3);這裡多給載入與畫圖的時間,到點還沒回報就照當下畫面產
const READY_TIMEOUT_MS = 15 * 1000;

/* P3 清理:/ \ : * ? " < > | 與控制字元 → "-";連續空白收成一個;去頭尾空白與結尾的 ".";超過 60 字截斷 */
function pdfSafeTitle(title) {
  const tidy = (s) => s.trim().replace(/\.+$/, "").trim();
  const s = tidy(String(title == null ? "" : title).replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, "-").replace(/\s+/g, " "));
  return tidy(Array.from(s).slice(0, TITLE_MAX).join(""));
}
const pad2 = (n) => (n < 10 ? "0" + n : String(n));
const tsOk = (v) => Number.isInteger(v) && v >= TS_MIN && v <= TS_MAX;
/* 檔名 {標題}_{YYYY-MM-DD}.pdf:標題 = 信封 title(清單上那個);日期 = meta.generated_at 的本機日期,沒有就 created_at——
   是報告的日期、不是存檔日(存檔資料夾依報告日排序)。兩個都沒有才用現在 */
function pdfFileName(report, nowMs) {
  const r = report && typeof report === "object" ? report : {};
  const meta = Array.isArray(r.blocks) && r.blocks[0] && r.blocks[0].type === "meta" ? r.blocks[0] : {};
  const sec = tsOk(meta.generated_at) ? meta.generated_at : tsOk(r.created_at) ? r.created_at : Math.floor((typeof nowMs === "number" ? nowMs : Date.now()) / 1000);
  const d = new Date(sec * 1000);
  const title = pdfSafeTitle(typeof r.title === "string" && r.title.trim() ? r.title : meta.title) || "report";
  return title + "_" + d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + ".pdf";
}
// 閘門只有一條(spec 範圍):報告 JSON 能渲染
const pdfCanRender = (report) => !!report && typeof report === "object" && Array.isArray(report.blocks);

/* opts:{ loadDoc(view, id, ver) → Promise<{ report, images }|null>,
          showSave(win, { defaultPath, filters }) → Promise<{ canceled, filePath }>,
          openPage() → { webContents, destroy(), isDestroyed() }(看不見的視窗,已開始載入列印頁),
          writeFile(path, buffer) → Promise, getDir() → string|null, setDir(dir), downloads() → string,
          onSaved()(檔案寫成功才叫:埋點), now?() }
   回 { save(win, view, id, ver, lang, onStart), payload(sender), ready(sender, ok) } */
function createReportPdf(opts) {
  let job = null;   // 一次只產一份:{ wc, payload, done }
  function payload(sender) { return job && job.wc === sender ? job.payload : null; }
  function ready(sender, ok) { if (job && job.wc === sender && job.done) job.done(ok === true); }
  async function render(data) {
    let page = null, timer = null;
    try {
      page = opts.openPage();
      const wc = page.webContents;
      let loaded = false;
      const ok = await new Promise((resolve) => {
        job = { wc, payload: data, done: resolve };
        wc.once("did-finish-load", () => { loaded = true; });
        wc.once("did-fail-load", () => resolve(false));
        wc.once("render-process-gone", () => resolve(false));
        timer = setTimeout(() => resolve(loaded), READY_TIMEOUT_MS);   // 逾時:頁面載得起來就照當下畫面產
      });
      if (!ok) return null;
      // Electron 預設 pageSize Letter、printBackground false:這兩個一定要帶。頁面尺寸與頁尾由 CSS @page 決定
      return await wc.printToPDF({ preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false, generateTaggedPDF: true, generateDocumentOutline: true });
    } finally {
      clearTimeout(timer); job = null;
      try { if (page && !page.isDestroyed()) page.destroy(); } catch (_) { /* 已經關了 */ }
    }
  }
  return {
    payload, ready,
    /* 回 { code }:OK / CANCELED(存檔框按取消)/ BUSY(上一份還在產)/ FAIL(讀不到報告、產生出錯或逾時、寫不進去) */
    async save(win, view, id, ver, lang, onStart) {
      if (VIEWS.indexOf(view) < 0 || typeof id !== "string" || !ID_RE.test(id)) return { code: "FAIL" };
      if (job) return { code: "BUSY" };
      let doc = null;
      try { doc = await opts.loadDoc(view, id, ver); } catch (_) { doc = null; }
      if (!doc || !pdfCanRender(doc.report)) return { code: "FAIL" };
      const now = typeof opts.now === "function" ? opts.now() : Date.now();
      let dir = null; try { dir = opts.getDir(); } catch (_) { dir = null; }
      const r = await opts.showSave(win, { defaultPath: path.join(dir || opts.downloads(), pdfFileName(doc.report, now)), filters: [{ name: "PDF", extensions: ["pdf"] }] });
      if (!r || r.canceled || !r.filePath) return { code: "CANCELED" };
      if (job) return { code: "BUSY" };
      try { if (typeof onStart === "function") onStart(); } catch (_) { /* 畫面關了 */ }   // 存檔框按了儲存:鈕字這時才換「存成中…」
      try {
        const pdf = await render({ report: doc.report, images: doc.images && typeof doc.images === "object" ? doc.images : {}, lang: LANGS.indexOf(lang) >= 0 ? lang : "en", view, savedAt: now });
        if (!pdf || !pdf.length) return { code: "FAIL" };
        await opts.writeFile(r.filePath, pdf);
      } catch (_) { return { code: "FAIL" }; }
      try { opts.setDir(path.dirname(r.filePath)); } catch (_) { /* 記不住:下次從「下載項目」開始 */ }
      try { opts.onSaved(); } catch (_) { /* 追蹤永遠不擋功能 */ }
      return { code: "OK" };
    },
  };
}

module.exports = { createReportPdf, pdfFileName, pdfSafeTitle, pdfCanRender, READY_TIMEOUT_MS };
