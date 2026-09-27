/* 報告存成 PDF(設計:blave-canon output/designer/spec-report-pdf-0.1.8.md DT1 / DT2)。
   閱讀層頁首右側動作群的最右一顆(#rpt-pdf):所有報告、所有狀態都出(績效報告、公開中的也是)——閘門只有「報告 JSON 能渲染」。
   按下 → 主行程先開系統存檔框、自己讀報告、在看不見的視窗畫成淺色、寫檔(shell/reportpdf.js);這裡只給 view / id / 清單上的版本 / 語言。
   埋點 report_pdf 由主行程在檔案寫成功時送。
   reports.js 叫兩個點:rptPaint 叫 pdfClear(換頁 / 回清單),rptRender 畫完叫 pdfDecorate。
   用到 app.js 的 $ / t / LANG / confirmBox / srSay、reports.js 的 RPT——都在呼叫時才取。 */
const PDF = { cur: null, state: "idle", timer: null };   // state:idle / picking(存檔框開著)/ saving / saved(閃 1.5 秒)
const PDF_FLASH_MS = 1500;   // 同「複製連結 → 已複製」

function pdfClear() { PDF.cur = null; pdfPaint(); }
function pdfDecorate(env, id, rep) { PDF.cur = rep && Array.isArray(rep.blocks) ? { env, id } : null; pdfPaint(); }
function pdfPaint() {
  const b = $("rpt-pdf"), busy = PDF.state === "saving";
  b.hidden = !PDF.cur;
  b.textContent = t(busy ? "pdf.saving" : PDF.state === "saved" ? "pdf.saved" : "pdf.btn");
  b.disabled = busy;
  $("rpt-share").disabled = busy;   // 產生中兩顆都停用:不同時開公開框
}
function pdfSet(state) {
  // 換字前鎖原寬(同 shlFlash):「存成中…」「已存成」比原字短,不鎖的話左邊的「分享」會跟著位移
  const b = $("rpt-pdf");
  if (state === "idle") b.style.minWidth = ""; else if (!b.hidden && b.offsetWidth) b.style.minWidth = b.offsetWidth + "px";
  clearTimeout(PDF.timer); PDF.state = state;
  if (state === "saved") PDF.timer = setTimeout(() => { PDF.state = "idle"; pdfPaint(); }, PDF_FLASH_MS);
  pdfPaint();
}
async function pdfSave() {
  const c = PDF.cur;
  if (!c || PDF.state === "picking" || PDF.state === "saving") return;
  const entry = (RPT.data[c.env] || []).find((r) => r.id === c.id);
  pdfSet("picking");
  let r = null;
  try { r = await window.blave.reportPdf(c.env, c.id, entry && typeof entry.stored_at === "number" ? entry.stored_at : undefined, LANG); } catch (_) { r = null; }
  const code = r && r.code;
  if (code === "OK") { pdfSet("saved"); srSay(t("pdf.saved")); return; }
  pdfSet("idle");
  if (code === "CANCELED" || code === "BUSY") return;   // 取消 = 什麼都沒發生
  confirmBox({ title: t("pdf.failTitle"), lines: [t("pdf.failBody")], ok: t("cdel.gotIt"), single: true, opener: $("rpt-pdf").hidden ? $("rpt-back") : $("rpt-pdf"), onOk: () => {} });
}

/* ── 接線(這支比 app.js 先載:只用 getElementById;handler 裡的才在點擊時取)── */
(function pdfWire() {
  document.getElementById("rpt-pdf").addEventListener("click", pdfSave);
  // 存檔框按了儲存、開始產:鈕字才換成「存成中…」(存檔框開著的那段不算)
  window.blave.onReportPdfSaving(() => { if (PDF.state === "picking") pdfSet("saving"); });
})();
