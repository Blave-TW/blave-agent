/* 主題:<head> 第一支、同步跑,第一次繪製前 <html data-theme> 就定好(CSP 不准 inline script,所以是外部檔)。
   跟隨系統／淺色／深色由主行程的 nativeTheme.themeSource 決定,這裡只讀它反映出來的 prefers-color-scheme;
   之後系統或設定一換,寫回屬性並發 blave:theme,讓圖表重畫。report-print.html 不載這支(PDF 永遠淺色) */
(function () {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => { document.documentElement.setAttribute("data-theme", mq.matches ? "dark" : "light"); };
  apply();
  mq.addEventListener("change", () => { apply(); window.dispatchEvent(new Event("blave:theme")); });
})();
