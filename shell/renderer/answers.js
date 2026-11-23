/* 聊天欄答案鈕(spec designer chat-answer-buttons-2026-11-16 §1–§6、§9):等回答的回合,runtime 把 <answers> 區塊剝成
   {type:"answers", items, default};這裡先收著,回合正常結束才畫在這一輪最後一則回覆的正文之後。不編號;agent 建議的那一顆
   (default,1 起算)預選:選項膠囊的選取態(Wei 11-20)。焦點仍留在輸入框,預選不代替用戶送出。
   按一顆 = 那句原句送出(跟輸入框同一條路,草稿留著);回合真的送出去(started／queued,任何入口、別的裝置開的新回合)整組收掉。
   只在記憶體(重載不還原:歷史裡 runtime 已接上純文字清單);ANS 進 chattabs.js 的 TAB_KEYS,跟著分頁走。
   在 form.js 之後、chattabs.js 之前載入。 */
let ANS = { pending: null, live: null, items: null, def: 0, shownAt: 0, inflight: null, undoable: null };
// 下面兩個跟 runtime 與網頁工作頁同名同值(tests/check_web_desktop_parity.js 逐字比對原文)
const ANS_MAX_ITEMS = 4;
const ANS_MAX_CHARS = 32;
const ANS_BAD_CHAR = /[\p{Cc}\p{Cf}]/u;   // 控制與格式字元(U+202E 雙向覆寫):鈕上的字不能跟送出的不一樣;runtime ANS_BAD_CATS 同一組
let ansSeq = 0;   // 預選說明節點的 id 流水號:分頁各有一組鈕,id 不能撞

/* 純函式:chunk → 預選第幾顆(1 起算;沒標或不合 = 0)。default 不合只丟預選,不丟整組 */
function ansDefault(c, n) {
  const d = c && c.default;
  return Number.isInteger(d) && d >= 1 && d <= n ? d : 0;
}
/* 純函式:chunk → 選項陣列或 null。VM 送來的是不可信輸入:任何一項不合整組丟,不截字、不補字 */
function ansPick(c) {
  const it = c && c.items;
  if (!Array.isArray(it) || it.length < 2 || it.length > ANS_MAX_ITEMS) return null;
  const out = [];
  for (const s of it) {
    if (typeof s !== "string" || !s.trim() || ANS_BAD_CHAR.test(s) || out.indexOf(s) >= 0) return null;
    if (Array.from(s).length > ANS_MAX_CHARS) return null;
    out.push(s);
  }
  return out;
}
function ansChunk(c) {
  if (c && c.session_id && c.session_id !== sessionId) return;
  const items = ansPick(c);
  ANS.pending = items ? { items, def: ansDefault(c, items.length) } : null;
}
/* app.js turnEndPost 叫(同 formTurnEnd 的時機與落點):ok 才畫 */
function ansTurnEnd(ok) {
  const p = ANS.pending;
  ANS.pending = null;
  if (!ok || !p) return;
  const items = p.items, def = p.def;
  const host = turnAiBubbles.filter((b) => b.parentNode).pop();
  if (!host) return;
  ansDrop();
  const el = ansBuild(items, def);
  host.appendChild(el);
  Object.assign(ANS, { live: el, items, def, shownAt: performance.now() });   // 防誤觸從畫出來那一刻算,不掛動畫
  ansLayout(el);
  trackEvent("answer_shown", { n: String(items.length) });
  const said = items.map((s, i) => (i + 1 === def ? t("ans.def", { s }) : s));
  // 用分號接:選項自己可能有頓號、逗號,用同一個符號接會聽成更多個選項(設計稽核 0.1.59 S1)
  srSay(t("ans.say", { s: said.join(LANG === "en" ? "; " : "；") }));
}
function ansBuild(items, def) {
  const el = document.createElement("div");
  el.className = "ans";
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", t("ans.group"));
  el.dataset.i18nAria = "ans.group";
  // 預選那一顆的「建議」要讀屏讀得到,而且不改鈕名:aria-describedby 指到組內一個 .sr-only 節點。
  // 不用 aria-pressed／aria-checked:會念成「已按下」,像已經回答過(設計稽核 0.1.59 M2)
  let mark = null;
  if (def) {
    mark = document.createElement("span");
    mark.className = "sr-only"; mark.id = "ans-def-" + (++ansSeq); mark.textContent = t("ans.defMark");
    mark.dataset.i18n = "ans.defMark";
    el.appendChild(mark);
  }
  items.forEach((s, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "ans-btn" + (i + 1 === def ? " is-default" : ""); b.textContent = s;
    if (mark && i + 1 === def) b.setAttribute("aria-describedby", mark.id);
    b.addEventListener("click", () => ansSend(el, i));
    el.appendChild(b);
  });
  // 欄寬變了(拖分隔條、視窗縮放)重量一次;藏起來的分頁寬 0,不量
  if (typeof ResizeObserver === "function") {
    let w = -1;
    el._ro = new ResizeObserver((es) => { const nw = Math.round(es[0].contentRect.width); if (nw > 0 && nw !== w) { w = nw; ansLayout(el); } });
    el._ro.observe(el);
  }
  return el;
}
/* 橫排或直排由量測決定、不看字數:先不折行試排,總寬超過容器就整組直排(等寬、字靠左、可折行) */
function ansLayout(el) {
  el.classList.remove("is-col");
  if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) el.classList.add("is-col");
}
function ansDrop() {
  const el = ANS.live;
  if (el) { if (el._ro) el._ro.disconnect(); el.remove(); }
  ANS.live = null; ANS.items = null; ANS.def = 0;
}
function ansSend(el, i) {
  if (ANS.live !== el || performance.now() - ANS.shownAt < motionBaseMs()) return;   // 有回合在跑:submitMessage 回 false,鈕留著
  const msg = ANS.items[i];
  ANS.inflight = { msg, pos: i + 1, n: ANS.items.length };
  submitMessage(msg, { typed: true }).then((ok) => { if (!ok) ansUnsend(); });
}

/* 結算(同 form.js 的三段式):sendDraft 清空輸入框之前記快照,回合真的送出去才收掉並記。msg = null:別的裝置開的回合,只收不記 */
function ansSnap(msg) { ANS.inflight = ANS.live ? { msg, pos: 0, n: ANS.items.length } : null; }
function ansSettle(msg) {
  const inf = ANS.inflight, had = !!ANS.live;
  ANS.inflight = null;
  ansDrop();
  ANS.undoable = inf && inf.pos && inf.msg === msg ? { msg, n: inf.n } : null;
  if (!had || !inf || msg === null || inf.msg !== msg) return;
  if (!inf.pos) { trackEvent("answer_missed", { n: String(inf.n) }); return; }
  trackEvent("answer_sent", { pos: String(inf.pos) });
  if (!tabBg()) $("ta").focus();
}
// 沒送出去(busy、版本閘、暖機中停止、引擎起不來):鈕留著
function ansUnsend() { ANS.inflight = null; }
// 按鈕送出的那輪,還沒回覆、沒工具收據就被停止(句子回到輸入框、鈕不回來):app.js 回合結束停止那一支呼叫
function ansUndo(msg, clean) {
  const d = ANS.undoable;
  ANS.undoable = null;
  if (d && d.msg === msg && clean) trackEvent("answer_undo", { n: String(d.n) });
}
