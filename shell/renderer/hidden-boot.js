/* 隱藏重開(閒著自動裝)的頁:視窗藏著,但從沒顯示過的頁 visibilityState 仍是 visible,配對框、「看過了」都會以為有人在看。
   所以第一次真的顯示之前一律回報 hidden,顯示那一刻補一次 visibilitychange,既有的監聽照常接手。
   要排在讀 visibilityState 的 script 之前(theme-boot 不讀,它得是第一支)。sessionStorage:顯示過之後重新載入(「重新登入」)不能又變回 hidden */
(function () {
  const KEY = "blaveHiddenBootShown";
  if (!(window.blave && window.blave.hiddenBoot) || sessionStorage.getItem(KEY)) return;
  const fake = (k, v) => Object.defineProperty(document, k, { configurable: true, get: () => v });
  fake("visibilityState", "hidden"); fake("hidden", true);
  window.blave.onHiddenBootShown(() => {
    sessionStorage.setItem(KEY, "1");
    delete document.visibilityState; delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
})();
