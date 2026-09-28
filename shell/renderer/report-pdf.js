/* 報告存成 PDF(設計:blave-canon output/designer/spec-report-pdf-0.1.8.md DT1 / DT2)。
   閱讀層頁首右側動作群的最右一顆(#rpt-pdf):所有報告、所有狀態都出(績效報告、公開中的也是)——閘門只有「報告 JSON 能渲染」。
   按下 → 主行程先開系統存檔框、自己讀報告、在看不見的視窗畫成淺色、寫檔(shell/reportpdf.js);這裡只給 view / id / 清單上的版本 / 語言。
   存完的回饋(設計 D1):頁首同一列、動作群左邊一句「已存到「{dir}」」+「在 Finder 中顯示」(#rpt-saved),留到離開這份報告或下一次開始產;
   鈕成功後直接回「存成 PDF」——存檔中間隔了一個系統存檔框,鈕上閃三個字人看不到,也答不了「存到哪」。
   埋點 report_pdf 由主行程在檔案寫成功時送。
   reports.js 叫兩個點:rptPaint 叫 pdfClear(換頁 / 回清單),rptRender 畫完叫 pdfDecorate。
   用到 app.js 的 $ / t / LANG / confirmBox / srSay、reports.js 的 RPT——都在呼叫時才取。 */
const PDF = { cur: null, state: "idle", saved: null };   // state:idle / picking(存檔框開著)/ saving;saved = { key, dir, token }:狀態句

const pdfKey = (c) => (c ? c.env + "|" + c.id : null);
function pdfClear() { PDF.cur = null; PDF.saved = null; pdfPaint(); }
function pdfDecorate(env, id, rep) {
  PDF.cur = rep && Array.isArray(rep.blocks) ? { env, id } : null;
  if (PDF.saved && PDF.saved.key !== pdfKey(PDF.cur)) PDF.saved = null;   // 換了一份:上一份的那句不跟過來
  pdfPaint();
}
function pdfPaint() {
  const b = $("rpt-pdf"), busy = PDF.state === "saving";
  b.hidden = !PDF.cur;
  b.textContent = t(busy ? "pdf.saving" : "pdf.btn");
  b.disabled = busy;
  $("rpt-share").disabled = busy;   // 產生中兩顆都停用:不同時開公開框
  const box = $("rpt-saved"), s = PDF.cur ? PDF.saved : null;
  box.hidden = !s;
  if (!s) return;
  const full = t("xp.saved", { dir: s.dir || t("xp.dlDir") }), d = box.querySelector(".d"), short = box.querySelector(".s"), rv = $("rpt-reveal");
  d.textContent = full; d.title = full;
  short.textContent = t("pdf.saved"); short.title = full;   // 窄欄只講「已存成」,全文在 title,存到哪由文字鈕回答
  rv.textContent = window.blave.platform === "win32" ? t("xp.revealWin") : t("xp.reveal");
  rv.hidden = !s.token;
}
function pdfSet(state) {
  // 換字前鎖原寬(同 shlFlash):「存成中…」比原字短,不鎖的話左邊的「分享」會跟著位移
  const b = $("rpt-pdf");
  if (state === "idle") b.style.minWidth = ""; else if (!b.hidden && b.offsetWidth) b.style.minWidth = b.offsetWidth + "px";
  PDF.state = state;
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
  if (code === "OK") {
    // 人還停在這一份才出那一句(產的時候換了報告:pdfClear / pdfDecorate 已經把 cur 換掉)
    if (pdfKey(PDF.cur) === pdfKey(c)) PDF.saved = { key: pdfKey(c), dir: typeof r.dir === "string" ? r.dir : null, token: typeof r.token === "string" ? r.token : null };
    pdfSet("idle"); srSay(t("xp.saved", { dir: (typeof r.dir === "string" && r.dir) || t("xp.dlDir") }));
    return;
  }
  if (code === "CANCELED" || code === "BUSY") { pdfSet("idle"); return; }   // 取消 = 什麼都沒發生:上一次存的那句也還成立,留著
  PDF.saved = null; pdfSet("idle");
  confirmBox({ title: t("pdf.failTitle"), lines: [t("pdf.failBody")], ok: t("cdel.gotIt"), single: true, opener: $("rpt-pdf").hidden ? $("rpt-back") : $("rpt-pdf"), onOk: () => {} });
}

/* ── 接線(這支比 app.js 先載:只用 getElementById;handler 裡的才在點擊時取)── */
(function pdfWire() {
  document.getElementById("rpt-pdf").addEventListener("click", pdfSave);
  // 渲染端只交 token:路徑留在主行程,檔案被搬走時那邊自己不動作(同轉出卡那一顆)
  document.getElementById("rpt-reveal").addEventListener("click", () => { if (PDF.saved && PDF.saved.token) window.blave.revealExport(PDF.saved.token); });
  // 存檔框按了儲存、開始產:鈕字才換成「存成中…」(存檔框開著的那段不算),上一次存的那句在這一刻清掉
  window.blave.onReportPdfSaving(() => { if (PDF.state === "picking") { PDF.saved = null; pdfSet("saving"); } });
})();
