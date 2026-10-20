/* 主題:<head> 第一支、同步跑,第一次繪製前 <html data-theme> 就定好(CSP 不准 inline script,所以是外部檔)。
   跟隨系統／淺色／深色由主行程的 nativeTheme.themeSource 決定,這裡只讀它反映出來的 prefers-color-scheme;
   之後系統或設定一換,寫回屬性並發 blave:theme,讓圖表重畫。report-print.html 不載這支(PDF 永遠淺色)
   換的時候整頁交叉淡化一次(canon › Motion 明暗切換):首繪不淡;減少動態、視窗藏住(畫面不更新,過渡不會結束,
   守門會吃掉回來後的第一下)或不支援時一幀換完。blave:theme 在過渡回呼裡同步發,圖表在新畫面那一幀就畫好 */
(function () {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => { document.documentElement.setAttribute("data-theme", mq.matches ? "dark" : "light"); };
  apply();
  mq.addEventListener("change", () => {
    const swap = () => { apply(); window.dispatchEvent(new Event("blave:theme")); };
    const root = document.documentElement;
    root.classList.add("theme-flip");   // 元件自己的 transition 先停,不然有 transition 的一塊一塊換
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.hidden || !document.startViewTransition) {
      swap();
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-flip")));
      return;
    }
    const vt = document.startViewTransition(swap);
    // 過渡中指標事件全落在 <html>,按下還會把焦點從輸入框搶走:直接跳到終態、保住焦點,那一下不重放
    const guard = (e) => { e.preventDefault(); vt.skipTransition(); };
    root.addEventListener("pointerdown", guard, true);
    root.addEventListener("mousedown", guard, true);
    vt.finished.finally(() => {
      root.classList.remove("theme-flip");
      root.removeEventListener("pointerdown", guard, true);
      root.removeEventListener("mousedown", guard, true);
    });
  });
})();
