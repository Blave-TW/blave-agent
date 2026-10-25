/* 第一次對話 modal(spec .claude/output/backend/spec-desktop-first-chat-modal-2026-10-25.md;版面與字照設計
   .claude/output/designer/desktop-first-chat-modal-2026-10-25)。每個安裝彈一次,彈出那一刻就寫 introSeen(主行程 ui-prefs)。
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
const INTRO = { done: false, engine: "wait", sent: false, check: undefined, queued: false, timers: [], idx: 0, paused: false, ended: false };
// 三個市場輪流,不替用戶挑市場。曲線是示意(台股有一段回撤、台指期有一段盤整),圖上只有年份,沒有績效數字
const INTRO_DEMOS = [
  { mk: "crypto", x: ["2020", "2022", "2024"], pts: [0, 2, 1, 4, 6, 5, 9, 12, 10, 8, 7, 9, 11, 10, 13, 15, 14, 17, 16, 19, 22, 20, 23, 25, 24, 27, 30, 29, 31, 33] },
  { mk: "tw", x: ["2015", "2018", "2021"], pts: [6, 7, 9, 8, 10, 11, 10, 12, 13, 11, 8, 6, 5, 6, 8, 9, 11, 12, 11, 13, 14, 13, 15, 16, 15, 17, 18, 17, 19, 20] },
  { mk: "txf", x: ["2015", "2018", "2021"], pts: [4, 5, 4, 6, 8, 7, 7, 7, 6, 7, 6, 7, 6, 6, 7, 6, 9, 11, 10, 12, 11, 9, 8, 9, 11, 13, 12, 14, 13, 15] },
];
// 時間軸(設計定稿):打字每字 70、打完停 900、策略 2400、回測 3600;三個播完約 24 秒,停在最後一格
const INTRO_T = { lead: 300, ch: 70, hold: 900, strat: 2400, bt: 3600 };
const INTRO_PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>';
const INTRO_PAUSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="1"/><rect x="9.5" y="2.5" width="3" height="11" rx="1"/></svg>';

function introInputs() {
  const c = typeof cur !== "undefined" ? cur : null, tok = typeof hasToken !== "undefined" && hasToken === true, a = typeof acct !== "undefined" ? acct : null;
  // 連 Blave AI 且登入:帳號狀態回來才判(accountStatus 回 null = 查不到,也不彈);stFill 在狀態未知時會把 canRun:null 當能跑,所以先過這道
  const acctKnown = !(c === "blave" && tok) || a !== null;
  return {
    done: INTRO.done, conn: c != null && !$("view-ws").hidden, engine: INTRO.engine, acctKnown,
    fill: acctKnown && stFill({ engine: c, signedIn: tok, canRun: a ? a.can_run : null }),
    sent: INTRO.sent, running: typeof running !== "undefined" && running === true,
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

/* ── 示範舞台 ── */
const inEl = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
// key 先組好再查;三個市場每一欄兩語齊不齊由 tests/check_shell_intro.js 列舉
const inK = (mk, f) => { const k = "intro." + mk + "." + f; return t(k); };
function inPath(pts) {
  const n = pts.length - 1, max = Math.max(...pts);
  return pts.map((v, i) => (i ? "L" : "M") + (i / n * 100).toFixed(2) + " " + (92 - v / max * 84).toFixed(2)).join(" ");
}
function introStage(still) {
  const st = $("intro-stage"); st.textContent = ""; st.className = "intro-stage" + (still ? " still" : "");
  const s1 = inEl("div", "in-scene in-sc1"), idea = inEl("div", "in-idea");
  idea.append(inEl("span", "in-idea-t")); if (!still) { const c = inEl("span", "in-caret"); c.setAttribute("aria-hidden", "true"); idea.append(c); }
  s1.append(inEl("div", "in-cap", t("intro.sc1")), idea);
  const s2 = inEl("div", "in-scene in-sc2"), card = inEl("div", "in-strat");
  card.append(inEl("div", "in-strat-n"), inEl("dl", "in-rules")); s2.append(inEl("div", "in-cap", t("intro.sc2")), card);
  const s3 = inEl("div", "in-scene in-sc3"), bt = inEl("div", "in-bt"), top = inEl("div", "in-bt-top"), plot = inEl("div", "in-plot");
  top.append(inEl("span", "in-bt-tab", t("intro.bt")), inEl("span", "in-bt-name"), inEl("span", "in-tag", t("intro.tag")));
  plot.innerHTML = '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><line class="grid" x1="0" x2="100" y1="8" y2="8"/><line class="grid" x1="0" x2="100" y1="50" y2="50"/><line class="grid" x1="0" x2="100" y1="92" y2="92"/><path class="eq"/></svg>';
  plot.append(inEl("div", "in-cover"));
  bt.append(top, plot, inEl("div", "in-xax")); s3.append(inEl("div", "in-cap", t("intro.sc3")), bt);
  st.append(s1, s2, s3);
  if (still) return;
  const dots = inEl("div", "in-dots"); dots.setAttribute("aria-hidden", "true"); dots.append(inEl("i"), inEl("i"), inEl("i"));
  const play = inEl("button", "in-play"); play.type = "button"; play.id = "intro-play";
  play.addEventListener("click", introPlayClick);
  st.append(dots, play);
}
function introFill(i) {
  const d = INTRO_DEMOS[i], st = $("intro-stage");
  st.querySelector(".in-strat-n").textContent = inK(d.mk, "name");
  const dl = st.querySelector(".in-rules"); dl.textContent = "";
  [["intro.entry", "in"], ["intro.exit", "out"], ["intro.bt", "span"]].forEach(([k, f]) => dl.append(inEl("dt", null, t(k)), inEl("dd", null, inK(d.mk, f))));
  st.querySelector(".in-bt-name").textContent = inK(d.mk, "name");
  st.querySelector(".eq").setAttribute("d", inPath(d.pts));
  const x = st.querySelector(".in-xax"); x.textContent = ""; d.x.concat(t("intro.today")).forEach((y) => x.append(inEl("span", null, y)));
  st.querySelectorAll(".in-dots i").forEach((e, k) => e.classList.toggle("on", k === i));
}
const inShow = (k) => $("intro-stage").querySelectorAll(".in-scene").forEach((s, i) => s.classList.toggle("on", i === k));
function introStop() { INTRO.timers.forEach(clearTimeout); INTRO.timers = []; }
function introBtn(icon, key) { const b = $("intro-play"); if (!b) return; b.innerHTML = icon; b.setAttribute("aria-label", t(key)); }
function introRun(i) {
  introStop(); INTRO.idx = i; INTRO.paused = false; INTRO.ended = false;
  const st = $("intro-stage"), d = INTRO_DEMOS[i], idea = inK(d.mk, "idea"), out = st.querySelector(".in-idea-t");
  st.classList.remove("static"); introFill(i); introBtn(INTRO_PAUSE, "intro.pause");
  out.textContent = ""; inShow(0);
  const at = (ms, fn) => INTRO.timers.push(setTimeout(fn, ms));
  let ms = INTRO_T.lead;
  [...idea].forEach((_, k) => at(ms + k * INTRO_T.ch, () => { out.textContent = idea.slice(0, k + 1); }));
  ms += idea.length * INTRO_T.ch + INTRO_T.hold;
  at(ms, () => inShow(1)); ms += INTRO_T.strat;
  at(ms, () => inShow(2)); ms += INTRO_T.bt;
  at(ms, () => (i < INTRO_DEMOS.length - 1 ? introRun(i + 1) : introPause(true)));
}
// 暫停 / 播完:停在這一個市場的結果格
function introPause(end) {
  introStop(); INTRO.paused = true; INTRO.ended = !!end;
  const st = $("intro-stage"); st.classList.add("static"); introFill(INTRO.idx);
  st.querySelector(".in-idea-t").textContent = inK(INTRO_DEMOS[INTRO.idx].mk, "idea"); inShow(2);
  introBtn(INTRO_PLAY, end ? "intro.replay" : "intro.resume");
}
function introPlayClick() { if (!INTRO.paused) introPause(false); else introRun(INTRO.ended ? 0 : INTRO.idx); }

/* ── 開 / 關 ── */
function introShow() {
  const sc = $("intro-scrim"); if (!sc.hidden) return;
  INTRO.done = true; introMo.disconnect();
  Promise.resolve().then(() => window.blave.introSeen()).catch(() => {});
  trackFeature("intro_shown");
  const still = reducedMotion();
  introStage(still);
  if (still) { introFill(0); $("intro-stage").querySelector(".in-idea-t").textContent = inK(INTRO_DEMOS[0].mk, "idea"); }
  else introRun(0);
  $("view-ws").inert = true;
  sc.hidden = false;
  requestAnimationFrame(() => sc.classList.add("open"));
  setTimeout(() => { if (!sc.hidden) $("intro-ask").focus(); }, 60);
}
function introHide() {
  const sc = $("intro-scrim"); if (sc.hidden) return false;
  introStop(); sc.classList.remove("open"); sc.hidden = true;
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
// 主鈕:回合中 csStartNew 不做事也不報錯,不擋的話框收了畫面卻沒動靜(同 welcome.js stGo)
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
