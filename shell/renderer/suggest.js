/* 建議下一步:照雲端工作頁 workspace.html 的 .sug-wrap / #chat_sug(designer mockup v9.2 案 4)。
   在 app.js 之後載入(用它的 $、sessionId、running、submitMessage、trackFeature、motionBaseMs、chatEdge)。
   runtime 在回合收尾把 <suggest> 剝掉、另送 {type:"suggestions", items};這裡先收著,回合結束(沒出錯、沒被停)停一拍才長出。
   任何入口送出、出錯、換對話都收合作廢(點建議但那句沒跑起來例外:同一組長回來,見 sugRender)。只在記憶體:重開 app、換對話都不留——同雲端(逐字稿裡沒有這段,重整就沒了)。 */
const SUG = { pending: null, timer: null };

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
  const wrap = $("sug-wrap");
  // 收合只是透明 + 高度 0,行還在 DOM:inert 一起切,Tab + Enter 才不會送出作廢的句子;焦點在行上就先還給輸入框
  if (wrap.contains(document.activeElement)) $("ta").focus();
  wrap.inert = true;
  wrap.classList.add("is-closed");
}
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
  // 長出來會壓縮聊天欄:原本貼底的補捲,別讓最新一則被蓋住;展開是漸進的,收尾再補一次
  const pin = () => { if (stick) { box.scrollTop = box.scrollHeight; chatEdge(); } };
  pin(); setTimeout(pin, motionBaseMs() + 30);
}
