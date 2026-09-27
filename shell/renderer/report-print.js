/* 報告存成 PDF 的列印頁(spec-report-pdf-0.1.8 DT3 / P2 / P4)。主行程(shell/reportpdf.js)在看不見的視窗載 report-print.html,
   這支向主行程拿那一份報告(print-preload.js 的 blavePrint.payload),用跟閱讀層同一支 report-blocks.js 畫、補文末聲明、
   等字型與圖,然後回報 ready;主行程才 printToPDF。報告標題 / 內文都是 agent 寫的字:一律 textContent。
   用到 strings.js / i18n.js 的 t / setLang、md.js 的 rptMarkdown、report-blocks.js 的 renderAgentReport。 */

/* ── 純邏輯(tests/check_shell_report_pdf.js 從原文切出來跑;這一段不准碰 DOM / i18n)── */
const PDF_WAIT_MS = 10 * 1000;   // 等字型與圖的上限;逾時照當下畫面產(失敗的圖 = 閱讀層既有的「圖片載入失敗」框,照印)
// 寬表:紙上沒有橫捲,比欄寬就等比縮到剛好(不裁欄、不改橫式);放得下 = 1
function pdfZoom(avail, need) { return avail > 0 && need > avail ? avail / need : 1; }
// 存成時間 YYYY/MM/DD HH:mm(本機時區)
function pdfStamp(ms) {
  const d = new Date(ms), p = (n) => (n < 10 ? "0" + n : String(n));
  if (isNaN(d.getTime())) return "";
  return d.getFullYear() + "/" + p(d.getMonth() + 1) + "/" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
// 聲明第三段的條件句只在報告真的有註時才放(同公開頁方法句的規矩:做到才講)
function pdfHasNotes(report) {
  return !!report && Array.isArray(report.blocks) && report.blocks.some((b) => b && b.type === "footnote" && Array.isArray(b.items) && b.items.length > 0);
}
/* ── 純邏輯到此 ── */

function pdfI18n(view) {
  const where = t(view === "cloud" ? "lib.where.cloud" : "lib.where.local");
  return { originScheduled: t("rb.originScheduled"), originChat: t("rb.originChat"), machine: t("rb.machine"), footScheduled: t("rb.footScheduled", { where }), footChat: t("rb.footChat", { where }),
    metaPeriod: t("rb.metaPeriod"), metaAum: t("rb.metaAum"), metaBenchmark: t("rb.metaBenchmark"), calloutRisk: t("rb.calloutRisk"), footnoteRef: t("rb.footnoteRef"), imageError: t("rb.imageError"), imageSource: t("rb.imageSource"), segOther: t("rb.segOther"),
    newsPos: t("rb.newsPos"), newsNeg: t("rb.newsNeg"), newsNeutral: t("rb.newsNeutral"), estModel: t("rb.estModel") };
}
function pdfStatement(p) {
  const g = (id) => document.getElementById(id);
  g("pdf-disc-t").textContent = t("pdf.discTitle");
  g("pdf-disc-1").textContent = t("pdf.disc1");
  g("pdf-disc-2").textContent = t("pdf.disc2");
  const sep = LANG === "zh" ? "" : " ";
  g("pdf-disc-3").textContent = [t("pdf.disc3a"), pdfHasNotes(p.report) ? t("pdf.disc3b") : "", t("pdf.disc3c")].filter(Boolean).join(sep);
  const st = g("pdf-stamp");
  t("pdf.stamp").split("{time}").forEach((part, i) => {
    if (i) { const m = document.createElement("span"); m.className = "mono"; m.textContent = pdfStamp(p.savedAt); st.appendChild(m); }
    if (part) st.appendChild(document.createTextNode(part));
  });
  g("pdf-statement").hidden = false;
}
function pdfFitTables(root) {
  root.querySelectorAll(".rb-table-wrap, .rb-heat-wrap").forEach((w) => {
    const tb = w.querySelector("table"); if (!tb) return;
    const z = pdfZoom(w.clientWidth, tb.scrollWidth);
    if (z < 1) tb.style.zoom = String(z);
  });
}
function pdfAssets() {
  const imgs = [...document.images].filter((im) => !im.complete).map((im) => new Promise((res) => { im.addEventListener("load", res, { once: true }); im.addEventListener("error", res, { once: true }); }));
  return Promise.race([Promise.all([document.fonts.ready].concat(imgs)), new Promise((res) => setTimeout(res, PDF_WAIT_MS))]);
}
(async function pdfMain() {
  let ok = false;
  try {
    const p = await window.blavePrint.payload();
    if (!p || !p.report) return;
    setLang(p.lang);
    const meta = p.report.blocks[0] && p.report.blocks[0].type === "meta" ? p.report.blocks[0] : {};
    document.title = String(p.report.title || meta.title || "Blave");
    document.documentElement.style.setProperty("--pdf-foot", JSON.stringify(t("pdf.footShort")));
    const images = p.images || {}, host = document.getElementById("pdf-body");
    window.renderAgentReport(host, p.report, { apiBase: "", i18n: pdfI18n(p.view), imageUrl: (ref) => images[ref] || "", markdown: rptMarkdown });
    pdfStatement(p);
    pdfFitTables(host);
    await pdfAssets();
    ok = true;
  } catch (e) {
    console.warn("[report-print]", e);
  } finally {
    window.blavePrint.ready(ok);
  }
})();
