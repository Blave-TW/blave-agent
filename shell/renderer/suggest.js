/* 建議下一步:照雲端工作頁 workspace.html 的 .sug-wrap / #chat_sug(designer mockup v9.2 案 4)。
   在 app.js 之後載入(用它的 $、sessionId、running、submitMessage、trackFeature、motionBaseMs、chatEdge、escTop)。
   runtime 在回合收尾把 <suggest> 剝掉、另送 {type:"suggestions", items};這裡先收著,回合結束(沒出錯、沒被停)停一拍才長出。
   任何入口送出、出錯、換對話都收合作廢(點建議但那句沒跑起來例外:同一組長回來,見 sugRender)。只在記憶體:重開 app、換對話都不留——同雲端(逐字稿裡沒有這段,重整就沒了)。 */
const SUG = { pending: null, timer: null, unpin: null };

/* 純函式(tests/check_shell_suggest.js):chunk → 最多 3 句。VM 寫的字是不可信輸入:非字串、空白、超過 200 字整條丟(同 web) */
function sugItems(c) {
  return (Array.isArray(c && c.items) ? c.items : [])
    .filter((s) => typeof s === "string" && s.trim() && s.length <= 200)
    .slice(0, 3);
}
function sugChunk(c) {
  if (c && c.session_id && c.session_id !== sessionId) return;
  const items = sugItems(c);
  SUG.pending = items.length ? items : null;
}
function sugCollapse() {
  clearTimeout(SUG.timer); SUG.timer = null; SUG.pending = null;
  if (SUG.unpin) SUG.unpin();
  const wrap = $("sug-wrap");
  // 收合只是透明 + 高度 0,行還在 DOM:inert 一起切,Tab + Enter 才不會送出作廢的句子;焦點在行上就先還給輸入框
  if (wrap.contains(document.activeElement)) $("ta").focus();
  wrap.inert = true;
  wrap.classList.add("is-closed");
}
// 用戶自己收掉(× 或 Esc)。埋點只在這裡:sugCollapse 也被送出、出錯、換對話叫,那些不算收掉。
// 焦點明確交回輸入框,不靠 sugCollapse 裡「焦點在建議區才移」的條件(web 那邊 × 不在條件涵蓋的範圍,兩邊寫法一致)
function sugDismiss() {
  sugCollapse();
  $("ta").focus();
  trackFeature("suggest_closed");
}
// Esc 掛在輸入框與建議區本身(比 document 層的 escTop 與 browser.js 先跑):焦點在建議區、或在空的輸入框才收;
// 輸入框有字不收(免得被當成清空);有 modal / 選單開著讓它先關;收了就 preventDefault,browser.js 看到便不收瀏覽器
function sugEsc(e) {
  if (e.key !== "Escape" || e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;   // 組字中的 Esc 是取消選字
  const wrap = $("sug-wrap"), ta = $("ta");
  if (wrap.classList.contains("is-closed")) return;
  const inSug = wrap.contains(e.target), emptyTa = e.target === ta && ta.value.trim() === "";
  if (!inSug && !emptyTa) return;
  if (escTop()) return;
  e.preventDefault();
  sugDismiss();
}
$("sug-close").addEventListener("click", sugDismiss);
$("sug-wrap").addEventListener("keydown", sugEsc);
$("ta").addEventListener("keydown", sugEsc);
function sugRender(items) {
  const list = $("sug-rows");
  list.textContent = "";
  items.forEach((text) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "sug-item";
    const g = document.createElement("span");
    g.className = "sug-glyph"; g.setAttribute("aria-hidden", "true"); g.textContent = "↳";
    const s = document.createElement("span");
    s.className = "txt"; s.textContent = text;
    b.append(g, s);
    // 送出的收合在 submitMessage 開頭(不分入口);跑起來才算點過(同 export.js / handoff.js)。
    // 沒跑起來(暖機中停止、版本閘、busy、引擎起不來)這組長回來:點的那句不會塞回輸入框,收掉就什麼都不剩(同雲端失敗時保留列表)。
    // running 還是 true = 別的回合在跑、這一下被擋在收合之前,這組本來就作廢,不長回來
    b.addEventListener("click", () => { submitMessage(text).then((ok) => { if (ok) trackFeature("suggest_clicked"); else if (!running) sugShow(items); }); });
    list.appendChild(b);
  });
}
function sugTurnEnd(ok) {
  const items = SUG.pending;
  SUG.pending = null;
  if (!ok || !items) return;
  clearTimeout(SUG.timer);
  SUG.timer = setTimeout(() => {
    SUG.timer = null;
    if (running) return;   // 停一拍之間又送出了一句:這組已經過期
    sugShow(items);
    trackFeature("suggest_shown");
  }, motionBaseMs());
}
function sugShow(items) {
  const box = $("chat-scroll"), stick = box.scrollHeight - box.scrollTop - box.clientHeight < 8;
  sugRender(items);
  const wrap = $("sug-wrap");
  void wrap.offsetHeight;   // 新的行先以收合態落地,transition 才有起點
  wrap.inert = false;
  wrap.classList.remove("is-closed");
  if (SUG.unpin) SUG.unpin();
  if (!stick) return;
  // 長出來會壓縮聊天欄:原本貼底的,長完要捲到底,不然回覆尾段與結果卡被蓋住(Wei 0929 截圖)。
  // 收尾以高度轉場的 transitionend 為準:主執行緒忙時轉場起跑晚,計時器會比它先到;結果卡也可能在長的途中才掛上(resAdd 那時量到的不是貼底)。
  // 計時器只兜底沒有轉場的情況(減少動態)。用戶自己往上捲、按鍵、點了聊天裡的東西,就不再搶位置
  const pin = () => { box.scrollTop = box.scrollHeight; chatEdge(); };
  const end = (e) => { if (e.target === wrap && e.propertyName === "grid-template-rows") { pin(); SUG.unpin(); } };
  const quit = (e) => { if (e.type !== "wheel" || e.deltaY < 0) SUG.unpin(); };
  const late = setTimeout(pin, motionBaseMs() + 30), stops = ["wheel", "keydown", "pointerdown"];
  wrap.addEventListener("transitionend", end);
  stops.forEach((k) => box.addEventListener(k, quit));
  SUG.unpin = () => { clearTimeout(late); wrap.removeEventListener("transitionend", end); stops.forEach((k) => box.removeEventListener(k, quit)); SUG.unpin = null; };
  pin();
}
