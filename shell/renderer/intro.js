/* 第一次對話 modal(spec .claude/output/backend/spec-desktop-first-chat-modal-2026-10-25.md;版面與字照設計
   .claude/output/designer/desktop-first-chat-modal-2026-10-25;舞台影片照 intro-video-2026-10-26/embed-spec.md)。每個安裝彈一次,彈出那一刻就寫 introSeen(主行程 ui-prefs)。
   判斷一直重來到彈出、或到確定這次不彈:引擎的 promise 收尾、帳號狀態變了(welcome.js wdPaint)、別的 modal 關掉 / 進工作頁
   (body 上 hidden 屬性的變化)、視窗重新顯示。主行程那一問(intro-check)放最後:其餘條件都成立才問,每次開 app 只問一次。
   主鈕送 intro.msg(起手句的規則:先擋回合中、聊天欄收著先展開、這條對話講過話就開新的);次鈕、✕、Esc 只關框、游標到輸入框。
   點遮罩不關。接線:app.js submitMessage → introMarkSent、escTop;welcome.js wdPaint → introSync;index.html #intro-scrim。 */

/* ── 純邏輯(tests/check_shell_intro.js 從原文切出來跑;不碰 DOM)── */
/* 回不彈的原因,"" = 彈。check = 主行程 intro-check 的回覆:不是 { show: true } 一律不彈(問不到、測試裡假的 IPC 回 undefined 都算) */
function introDecide(o) {
  if (o.done) return "done";
  if (!o.conn) return "conn";
  if (o.engine === "fail") return "engine_fail";
  if (o.engine !== "ok") return "engine_wait";
  if (!o.acctKnown) return "acct";
  if (o.fill) return "fill";
  if (o.sent) return "sent";
  if (o.running) return "running";
  if (o.modal) return "modal";
  if (!o.visible) return "hidden";
  if (!o.check || o.check.show !== true) return "ipc";
  return "";
}
/* ── 純邏輯到此 ── */

// engine:wait / ok / fail(這次開著失敗過就一直是 fail,之後在卡上重試成功也不彈);check:undefined = 還沒問、null = 問了在路上
// fresh = 減少動態的初始狀態(停在最後一格、還沒按過播放);resume = 視窗藏起來那一刻正在播
const INTRO = { done: false, engine: "wait", sent: false, check: undefined, queued: false, fresh: false, resume: false };
const INTRO_PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>';
const INTRO_PAUSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="1"/><rect x="9.5" y="2.5" width="3" height="11" rx="1"/></svg>';

function introInputs() {
  const c = typeof cur !== "undefined" ? cur : null, tok = typeof hasToken !== "undefined" && hasToken === true, a = typeof acct !== "undefined" ? acct : null;
  // 連 Blave AI 且登入:帳號狀態回來才判(accountStatus 回 null = 查不到,也不彈);stFill 在狀態未知時會把 canRun:null 當能跑,所以先過這道
  const acctKnown = !(c === "blave" && tok) || a !== null;
  return {
    done: INTRO.done, conn: c != null && !$("view-ws").hidden, engine: INTRO.engine, acctKnown,
    fill: acctKnown && stFill({ engine: c, signedIn: tok, canRun: a ? a.can_run : null }),
    // 代下載那一兩秒(歡迎頁卡或策略庫確認後)running 還是 false:也算在跑,不然 modal 會蓋上剛確認的安裝、主鈕那句還會讓安裝送不出去
    sent: INTRO.sent, running: (typeof running !== "undefined" && running === true) || (typeof LIB !== "undefined" && !!LIB.pending),
    modal: brModalOpen(), visible: document.visibilityState === "visible", check: INTRO.check,
  };
}
function introSync() {
  const why = introDecide(introInputs());
  if (why === "ipc" && INTRO.check === undefined) {
    INTRO.check = null;
    Promise.resolve().then(() => window.blave.introCheck()).then((r) => r, () => null).then((r) => { INTRO.check = r || { show: false }; introSync(); });
    return;
  }
  if (!why) introShow();
}
function introMarkSent() { INTRO.sent = true; }
// 別的 modal 關掉、進工作頁:body 底下 hidden 屬性變了就重判(同 browser.js 的 MutationObserver),一幀只判一次
const introMo = new MutationObserver(() => {
  if (INTRO.done || INTRO.queued) return;
  INTRO.queued = true; requestAnimationFrame(() => { INTRO.queued = false; introSync(); });
});
introMo.observe(document.body, { attributes: true, attributeFilter: ["hidden"], subtree: true });
document.addEventListener("visibilitychange", () => { if (!INTRO.done) introSync(); });
/* 引擎:先讀快照。背景安裝這次已經失敗過就不叫 ensureEngine——它會從頭重裝,等於替用戶按了重試、卡從「失敗」變回「安裝中」 */
function introEngineWatch() {
  window.blave.onEngineState((s) => { if (s && s.phase === "fail") INTRO.engine = "fail"; });
  return Promise.resolve().then(() => window.blave.engineState()).then((s) => s, () => null).then((s) => {
    if ((s && s.phase === "fail") || INTRO.engine === "fail") { INTRO.engine = "fail"; return; }
    return Promise.resolve().then(() => window.blave.ensureEngine()).then(() => { if (INTRO.engine === "fail") return; INTRO.engine = "ok"; introSync(); }, () => { INTRO.engine = "fail"; });
  });
}
introEngineWatch();

/* ── 示範舞台:landing hero 影片的 md 檔,播一次停在最後一格(回測結果頁)。只有鈕能操作,點影片沒反應 ── */
// 介面只有 en / zh(i18n.js setLang)。檔是從 web landing 複製的:landing 重錄時 renderer/intro/ 的四個檔要同批換
function introMedia(lang) {
  const base = "intro/hero_demo" + (lang === "zh" ? "_zh" : "");
  return { src: base + "_md.mp4", poster: base + "_poster.jpg" };
}
function introBtn(icon, key) { const b = $("intro-play"); if (!b) return; b.innerHTML = icon; b.setAttribute("aria-label", t(key)); }
// 載不到:留 poster、藏鈕,不出錯誤字。關框卸 src、或還沒載到就被暫停(AbortError)都不算
function introFail() { if ($("intro-video").getAttribute("src")) $("intro-play").hidden = true; }
function introPlay() {
  const v = $("intro-video");
  v.play().catch((e) => { if (v.readyState === 0 && !(e && e.name === "AbortError")) introFail(); });
}
function introPlayClick() {
  const v = $("intro-video");
  if (v.ended || INTRO.fresh) { INTRO.fresh = false; v.currentTime = 0; }
  else if (!v.paused) { v.pause(); return; }
  introPlay();
}
(() => {
  const v = $("intro-video");
  v.addEventListener("play", () => introBtn(INTRO_PAUSE, "intro.pause"));
  v.addEventListener("pause", () => { if (!v.ended) introBtn(INTRO_PLAY, "intro.resume"); });
  v.addEventListener("ended", () => introBtn(INTRO_PLAY, "intro.replay"));
  v.addEventListener("loadedmetadata", () => { if (INTRO.fresh) v.currentTime = Math.max(0, v.duration - 0.05); });
  v.addEventListener("error", introFail);
  $("intro-play").addEventListener("click", introPlayClick);
})();
document.addEventListener("visibilitychange", () => {
  if ($("intro-scrim").hidden) return;
  const v = $("intro-video");
  if (document.visibilityState === "hidden") { INTRO.resume = !v.paused; if (INTRO.resume) v.pause(); }
  else if (INTRO.resume) { INTRO.resume = false; introPlay(); }
});

/* ── 開 / 關 ── */
function introShow() {
  const sc = $("intro-scrim"); if (!sc.hidden) return;
  INTRO.done = true; introMo.disconnect();
  Promise.resolve().then(() => window.blave.introSeen()).catch(() => {});
  trackFeature("intro_shown");
  // 減少動態:不自動播,loadedmetadata 後停在最後一格,鈕是「播放示範」
  const v = $("intro-video"), m = introMedia(LANG), still = reducedMotion();
  INTRO.fresh = still; INTRO.resume = false; $("intro-play").hidden = false;
  introBtn(INTRO_PLAY, still ? "intro.play" : "intro.resume");
  v.muted = true; v.poster = m.poster; v.src = m.src;
  if (!still) introPlay();
  $("view-ws").inert = true;
  sc.hidden = false;
  requestAnimationFrame(() => sc.classList.add("open"));
  setTimeout(() => { if (!sc.hidden) $("intro-ask").focus(); }, 60);
}
function introHide() {
  const sc = $("intro-scrim"); if (sc.hidden) return false;
  // 每個安裝只彈一次,不留解碼器
  const v = $("intro-video"); v.pause(); v.removeAttribute("src"); v.load(); INTRO.fresh = false;
  sc.classList.remove("open"); sc.hidden = true;
  $("view-ws").inert = false;
  return true;
}
// ✕ / Esc / 次鈕:關掉、游標到輸入框(聊天欄收著就先展開,不然焦點落在藏起來的框)
function introClose(how) {
  if (!introHide()) return;
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);
  $("ta").focus();
  trackFeature(how === "type" ? "intro_type" : "intro_close");
}
// 主鈕:回合中 csStartNew 不做事也不報錯,不擋的話框收了畫面卻沒動靜
function introAsk() {
  if (runningNow()) { busySendTell(); return; }
  introHide();
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);
  if (csTitle) csStartNew();
  submitMessage(t("intro.msg")).then((ok) => { if (ok) trackFeature("intro_send"); });
}
$("intro-ask").addEventListener("click", introAsk);
$("intro-type").addEventListener("click", () => introClose("type"));
$("intro-close").addEventListener("click", () => introClose("close"));
$("intro-scrim").addEventListener("keydown", (e) => trapTab(e, $("intro-modal")));
