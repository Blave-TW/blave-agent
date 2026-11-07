/* 對話分頁(0.1.37;設計 spec chat-tabs-2026-10-29、技術方案 chat-tabs-parallel-tech §1.2)。
   每條開著的對話一個 ctx T:自己的 .chat-thread 容器(全放在 #chat-scroll 裡,同時只顯示一個)＋一份每輪狀態。
   app.js 那組每輪全域(running、liveBubble、busy、ACT、turn*…)當成「目前載入那個 T」的別名:切分頁時整組換掉;
   背景分頁的事件經 withTab(T, fn) 同步地把 T 換進來跑、跑完換回(fn 不准 await:換回之後才跑的延後 callback 要用 tabBound 捕 T)。
   共用的畫面(送出鈕、輸入框、策略刪除鎖、更新入口…)只畫眼前分頁:背景期間 CS.bg 為真,換回後 turnUiSync() 照眼前分頁重畫一次。
   哪些全域是每輪狀態:TAB_KEYS 這張表(tests/check_shell_chat_tabs.js 列舉 app.js 與每輪模組的頂層狀態,每個都要在這裡或 GLOBAL_OK)。
   在 app.js、suggest.js、form.js 之後載入。 */
let tabsK = 0;   // 分頁列 tick 現在亮第幾格(每秒進一格;建 tick 時就帶上,重畫不閃)
const CS = { away: { sid: null, seq: 0 }, tabs: new Map(), order: [], cur: null, loaded: null, bg: false, closed: [], main: new Map(), bootDone: false, freeze: null, barW: 0 };

// [名字, 讀, 寫, 新分頁的初值]——初值是工廠,物件每個分頁各一份
const TAB_KEYS = [
  ["sessionId", () => sessionId, (v) => { sessionId = v; }, () => null],
  ["csTitle", () => csTitle, (v) => { csTitle = v; }, () => ""],
  ["running", () => running, (v) => { running = v; }, () => false],
  ["liveBubble", () => liveBubble, (v) => { liveBubble = v; }, () => null],
  ["chatStick", () => chatStick, (v) => { chatStick = v; }, () => true],
  ["chatTop", () => chatTop, (v) => { chatTop = v; }, () => 0],
  ["busy", () => busy, (v) => { busy = v; }, () => null],
  ["ACT", () => ACT, (v) => { ACT = v; }, () => ({ running: new Map(), seq: 0, shown: null, shownAt: 0, textStart: 0, lastDelta: 0, timer: null, prep: null, lastWant: null })],
  ["swLine", () => swLine, (v) => { swLine = v; }, () => null],
  ["swHeld", () => swHeld, (v) => { swHeld = v; }, () => null],
  ["turnStopping", () => turnStopping, (v) => { turnStopping = v; }, () => false],
  ["turnStopped", () => turnStopped, (v) => { turnStopped = v; }, () => false],
  ["engineWait", () => engineWait, (v) => { engineWait = v; }, () => false],
  ["engineAbort", () => engineAbort, (v) => { engineAbort = v; }, () => null],
  ["engineSeq", () => engineSeq, (v) => { engineSeq = v; }, () => 0],
  ["lastUserTyped", () => lastUserTyped, (v) => { lastUserTyped = v; }, () => false],
  ["lastUserNote", () => lastUserNote, (v) => { lastUserNote = v; }, () => null],
  ["lastUserText", () => lastUserText, (v) => { lastUserText = v; }, () => ""],
  ["lastUserAttachments", () => lastUserAttachments, (v) => { lastUserAttachments = v; }, () => []],
  ["faultShown", () => faultShown, (v) => { faultShown = v; }, () => false],
  ["acctCard", () => acctCard, (v) => { acctCard = v; }, () => null],
  ["creditCards", () => creditCards, (v) => { creditCards = v; }, () => []],
  ["dataCard", () => dataCard, (v) => { dataCard = v; }, () => null],
  ["draft", () => draft, (v) => { draft = v; }, () => ""],
  ["turnFail", () => turnFail, (v) => { turnFail = v; }, () => null],
  ["turnFailSrc", () => turnFailSrc, (v) => { turnFailSrc = v; }, () => null],
  ["turnModel", () => turnModel, (v) => { turnModel = v; }, () => null],
  ["turnGotReply", () => turnGotReply, (v) => { turnGotReply = v; }, () => false],
  ["turnErrored", () => turnErrored, (v) => { turnErrored = v; }, () => false],
  ["turnFaulted", () => turnFaulted, (v) => { turnFaulted = v; }, () => false],
  ["turnLimit", () => turnLimit, (v) => { turnLimit = v; }, () => false],
  ["turnChanged", () => turnChanged, (v) => { turnChanged = v; }, () => false],
  ["turnCap", () => turnCap, (v) => { turnCap = v; }, () => false],
  ["turnBubble", () => turnBubble, (v) => { turnBubble = v; }, () => null],
  ["turnHadTool", () => turnHadTool, (v) => { turnHadTool = v; }, () => false],
  ["turnCards", () => turnCards, (v) => { turnCards = v; }, () => []],
  ["turnDataCode", () => turnDataCode, (v) => { turnDataCode = v; }, () => null],
  ["pendingErr", () => pendingErr, (v) => { pendingErr = v; }, () => []],
  ["turnAiBubbles", () => turnAiBubbles, (v) => { turnAiBubbles = v; }, () => []],
  ["turnFaultEl", () => turnFaultEl, (v) => { turnFaultEl = v; }, () => null],
  ["turnSeqMine", () => turnSeqMine, (v) => { turnSeqMine = v; }, () => 0],
  ["turnViewCloud", () => turnViewCloud, (v) => { turnViewCloud = v; }, () => false],
  ["UPD.turnCloud", () => UPD.turnCloud, (v) => { UPD.turnCloud = v; }, () => false],
  ["SUG", () => SUG, (v) => { SUG = v; }, () => ({ pending: null, timer: null, text: null, kind: null, shownOnce: false, used: false, gone: false, files: 0, filledText: null, inflight: null, direct: false, shownAt: 0, undoable: null })],
  ["FORM", () => FORM, (v) => { FORM = v; }, () => ({ pending: null, live: null, filled: null, shown: false, inflight: null })],
  ["XP.pending", () => XP.pending, (v) => { XP.pending = v; }, () => []],
  ["RES.turn", () => RES.turn, (v) => { RES.turn = v; }, () => null],
  ["RPT.turnAt", () => RPT.turnAt, (v) => { RPT.turnAt = v; }, () => null],
  ["RPT.cloudTurn", () => RPT.cloudTurn, (v) => { RPT.cloudTurn = v; }, () => null],
  ["BR.blocks", () => (typeof BR !== "undefined" ? BR.blocks : []), (v) => { if (typeof BR !== "undefined") BR.blocks = v; }, () => []],
  ["BR.cur", () => (typeof BR !== "undefined" ? BR.cur : null), (v) => { if (typeof BR !== "undefined") BR.cur = v; }, () => null],
];
function tabSave(T) { for (const [k, get] of TAB_KEYS) T.st[k] = get(); T.title = T.st.csTitle; }
function tabLoad(T) { for (const [k, , set] of TAB_KEYS) set(T.st[k]); CS.loaded = T; }
function tabNewState(sid) { const st = {}; for (const [k, , , init] of TAB_KEYS) st[k] = init(); st.sessionId = sid; return st; }

function chatEl() { return CS.loaded ? CS.loaded.el : $("chat-scroll"); }
const tabBg = () => CS.bg === true;

/* 把 T 換進來同步跑 fn,跑完換回。T 已經是載入中的那個就直接跑(重入、眼前分頁) */
function withTab(T, fn) {
  if (!T || T === CS.loaded) return fn();
  const prev = CS.loaded, prevBg = CS.bg;
  if (prev) tabSave(prev);
  tabLoad(T); CS.bg = T !== CS.cur;
  const was = running;
  try { return fn(); }
  finally {
    const flipped = running !== was;
    tabSave(T);
    if (prev) tabLoad(prev);
    CS.bg = prevBg;
    // 共用畫面只在「有沒有回合」可能變了(這一條 running 翻面)或背景期間有人想重畫時才重畫:背景分頁每秒的計時器不該連帶重畫整個工作頁
    if (!CS.bg && (flipped || CS.dirtyUi)) { CS.dirtyUi = false; turnUiSync(); }
    else if (flipped && typeof tabsPaint === "function") tabsPaint();
  }
}
/* 延後才跑的 callback(計時器、rAF、then)捕住現在載入的分頁:跑的時候換回它 */
function tabBound(fn) { const T = CS.loaded; return (...a) => (!T ? fn(...a) : T.dead ? undefined : withTab(T, () => fn(...a))); }   // 還沒有分頁(開機那一瞬)照舊直接跑;分頁已關掉收掉:不跑

function tabMake(sid, o) {
  const el = document.createElement("div"); el.className = "chat-thread"; el.hidden = true;
  $("chat-scroll").appendChild(el);
  const T = { sid, el, st: tabNewState(sid), title: (o && o.title) || "", origin: (o && o.origin) || "desktop", queued: false, unread: null, scrollTop: 0,
    composer: { text: "", files: [] }, drawn: !(o && o.lazy), dead: false, closed: false, startedAt: 0, tickSec: 0 };
  T.st.csTitle = T.title;
  CS.tabs.set(sid, T);
  return T;
}
/* 換到 T(畫面上只顯示它)。輸入框的字與附件、捲動位置跟著分頁走 */
function tabShow(T) {
  if (!T || T === CS.cur) return;
  const old = CS.cur;
  if (old) {
    tabSave(old);
    old.composer = { text: $("ta").value, files: attachedFiles };
    old.scrollTop = $("chat-scroll").scrollTop;
    old.el.hidden = true;
  } else if (!T.composer.text && !T.composer.files.length) T.composer = { text: $("ta").value, files: attachedFiles };   // 接回第一條分頁之前就打的字(開機空窗)歸它,不被空草稿蓋掉
  CS.cur = T; tabLoad(T); CS.bg = false;
  T.el.hidden = false;
  const was = T.unread; T.unread = null;   // 打開就清掉「要你回來看」(canon › 對話狀態字)
  $("ta").value = T.composer.text || ""; autosize();
  setAttachments(T.composer.files || []);
  if (typeof engReattach === "function") engReattach();   // 安裝進度卡不屬於哪一條:搬進眼前這條
  // 捲動位置跟著分頁走:跟著捲的(chatStick)捲到底,往上捲著的回到原位;沒做完的那條捲到錯誤卡
  const box = $("chat-scroll");
  if (was === "fail" && T.el.querySelector(".fault")) [...T.el.querySelectorAll(".fault")].pop().scrollIntoView({ block: "center" });
  else if (chatStick) { box.scrollTop = box.scrollHeight; chatTop = box.scrollTop; }
  else box.scrollTop = T.scrollTop;
  csRenderHead(); turnUiSync(); if (typeof sugPaint === "function") sugPaint();
  csRemember();
  if (!T.drawn) csDraw(T);   // 重開 app 時沒畫的那條:第一次切到才讀 session.db
  if (typeof tabsSave === "function") tabsSave();
}

/* ── 機器層級:有沒有任何回合(本機任何分頁回覆中／排隊中,或主行程說還有沒有分頁的回合) ── */
/* agent 在等用戶回應:最後一輪以等你回覆收尾(同 reply_notif 的 await:done 帶 awaiting、不是停止或失敗)。下一輪收尾時覆寫;只活在開著的分頁,重開 app 不記 */
function csAnyAwait() { for (const T of CS.tabs.values()) if (T.waitUser === true) return true; return false; }
function csAnyTurn() {
  for (const T of CS.tabs.values()) if ((T === CS.loaded ? running : T.st.running) === true) return true;   // 載入中那個的 T.st 要等換出去才更新:讀全域
  for (const ph of CS.main.values()) if (ph) return true;
  return false;
}
function csTurnCount() { let n = 0; for (const T of CS.tabs.values()) if ((T === CS.loaded ? running : T.st.running) === true) n++; return n; }

/* 共用畫面照「眼前分頁＋任何回合」重畫一次。只重畫、不搬焦點、不播報、不記埋點(withTab 換回時會叫) */
function turnUiSync() {
  if (CS.bg) { CS.dirtyUi = true; return; }
  sendBtnSync(); stratDelSync(); busySync(); hoBusy(); if (typeof verBusy === "function") verBusy();
  upPaint(); rpRobSync(); rpWfSync(); if (typeof libSync === "function") libSync(); if (typeof rptSync === "function") rptSync(); if (typeof nsSync === "function") nsSync(); if (typeof wcBusySync === "function") wcBusySync();
  if (typeof xpSync === "function") xpSync();
  if (typeof tabsPaint === "function") tabsPaint();
}

const csTabRunning = (sid) => { const T = CS.tabs.get(sid); return T ? (T === CS.loaded ? running : T.st.running) === true : !!CS.main.get(sid); };
const tabRun = (T) => (T === CS.loaded ? running : T.st.running) === true;
const tabVal = (T, loaded, key) => (T === CS.loaded ? loaded : T.st[key]);
/* 送出的那一輪還在不在跑。sid 之外還要比輪次:同一條接著聊的下一輪不是它,turnSeq 是全 app 的,別條開跑也不是它 */
function csTurnLive(sid, seq) { const T = CS.tabs.get(sid); return !!T && tabRun(T) && tabVal(T, turnSeqMine, "turnSeqMine") === seq; }
/* 對著雲端的回合(回傳那一條的 sid,沒有 = null):更新雲端主機只跟它們衝突,本機回合不相干。
   送出時看著雲端、這一輪碰過雲端、更新那一輪自己;手機來的與沒開成分頁的看不出對著哪邊,一律算 */
function csCloudTurn() {
  for (const T of CS.tabs.values()) if (tabRun(T) && (tabVal(T, turnViewCloud, "turnViewCloud") === true || tabVal(T, UPD.turnCloud, "UPD.turnCloud") === true || UPD.cloudSid === T.sid)) return T.sid;
  for (const [sid, ph] of CS.main) if (ph && !CS.tabs.has(sid)) return sid;
  return null;
}
/* 碰這一支策略的回合(回傳那一條的 sid,沒有 = null):還原、再跑一次只跟它們衝突。判準 = 送出時看著的那支 ∪ 這一輪工具已碰過的,不分本機雲端;
   agent 之後才碰的算不到(Wei 11-03 接受)。看不出碰什麼的(手機來的、沒開成分頁的、收尾中已沒有紀錄的、工具認不出對象的 rt.opaque)一律算 */
function csStratTurn(name) {
  for (const T of CS.tabs.values()) {
    if (!tabRun(T)) continue;
    const rt = tabVal(T, RES.turn, "RES.turn");
    if (!rt || rt.opaque || rt.viewStrat === name || rt.touched.has(name)) return T.sid;
  }
  for (const [sid, ph] of CS.main) if (ph && !CS.tabs.has(sid)) return sid;
  return null;
}
/* 同一支的同一件事還在跑就不送第二條(送上雲端、轉出:回合中不上鎖,連按會開兩條分頁做同一件事) */
const CS_ONCE = new Map();   // key → CS.away
function csOnceLive(key) { const a = CS_ONCE.get(key); if (a && csTurnLive(a.sid, a.seq)) return a; CS_ONCE.delete(key); return null; }
function csOnceMark(key) { CS_ONCE.set(key, CS.away); }

/* 從別處送一句話(策略頁的掃描／重跑／還原、策略庫〔使用〕、報告〔問〕、歡迎頁的籤、送上雲端…;spec §3 sendAway):
   眼前分頁閒著而且還沒講過話 → 送進這裡;其他情況開新分頁送,直接跑。兩件事不混在同一串脈絡裡 */
function csAway() { if (csTitle || running) csStartNew({ force: true, quiet: true }); }
// CS.away = 剛送出的那一輪是哪一條、第幾輪(submitMessage 的同步段已記好 turnSeqMine):等「這一輪」結束的人(策略庫〔使用〕、
// 新增報告、更新雲端、掃描／樣本外的「已送出」)記 sid／序號,別條先結束時不當成自己的收掉
function csSendAway(msg, opts) {
  csAway();
  const T = CS.loaded, p = submitMessage(msg, opts);
  CS.away = { sid: T ? T.sid : sessionId, seq: turnSeqMine };
  return p;
}

function csStopOne(sid) { const T = CS.tabs.get(sid); if (T && tabRun(T)) withTab(T, () => { stopTurn(); }); else window.blave.stopTurn(sid); }
function csStopAll() { for (const T of [...CS.tabs.values()]) if (tabRun(T)) withTab(T, () => { stopTurn(); }); }
// 只剩關掉但還在跑的、或沒開成分頁的那條也要帶得到:csOpen 會把它接回分頁列
function csShowRunning() {
  if (running) return;
  const tabs = [...CS.tabs.values()], T = tabs.find((x) => tabRun(x) && !x.closed) || tabs.find((x) => tabRun(x));
  if (T) { if (T.closed) csOpen(T.sid); else tabShow(T); return; }
  for (const [sid, ph] of CS.main) if (ph) { csOpen(sid); return; }
}

/* ── 事件路由:照 c.sid 找分頁 ── */
function tabsOf(sid) { return sid ? CS.tabs.get(sid) || null : CS.cur; }
function tabsOnEvent(c) {
  if (!c || typeof c !== "object") return;
  const T = tabsOf(c.sid);
  if (!T) { if (c.sid && (c.type === "queued" || c.type === "started")) CS.main.set(c.sid, c.type === "queued" ? "queued" : "running"); return; }   // 沒開著的(重載之後、手機來的還沒開成分頁):只記清單狀態,開成分頁時接上(csOpen)
  if (c.type === "queued") { tabsQueued(T, true); return; }
  if (c.type === "started") {
    tabsQueued(T, false);
    // 不是這個畫面送出的那一輪(手機來的、開成分頁的):這裡才知道它在跑——記成回合中,機器層級的鎖與分頁的「回覆中」才看得到
    // 這一輪的那句不在電腦上:停掉它時不把上一輪電腦前打的字塞回輸入框,錯誤卡也不出〔再送一次〕(會送出上一輪電腦前那句;
    // 改送手機那句也不行——手機那邊可能已經自己重送,同一句下單會跑兩次)
    withTab(T, () => { if (!running) { running = true; turnSeq++; turnSeqMine = turnSeq; turnFresh(null); lastUserTyped = false; lastUserText = ""; lastUserAttachments = []; turnViewCloud = true; } busyStart(); });
    tabsPaint(); return;
  }
  if (c.type === "browser_wait") { withTab(T, () => { busySet(t("tabs.brWait"), "", "wait"); if (ACT) ACT.shown = "browser_wait|"; }); return; }
  if (c.type === "done") T.awaiting = c.awaiting === true;
  withTab(T, () => turnEventIn(c));
}
async function tabsOnEnd(r) {
  if (!r || typeof r !== "object") return;
  const T = tabsOf(r.sid);
  CS.main.delete(r.sid);
  if (!T) { tabsPaint(); return; }
  tabsQueued(T, false);
  if (r.canceled) withTab(T, () => { turnStopped = true; });   // 取消排隊 = 沒開跑就停下:照停止收(句子放回輸入框)
  const pre = withTab(T, () => turnEndPre(r));
  let d = null;
  if (pre.probe) { try { d = await window.blave.detectAgents(); } catch (_) { d = null; } }   // 問不到就當成一般失敗
  if (T.dead) return;
  const res = withTab(T, () => turnEndPost(r, pre, d));
  // 不在眼前的分頁做完:標記要你回來看(做完還沒看／沒做完／等你回覆);眼前那條永遠不算(canon › 對話狀態字)
  if (T !== CS.cur && !(res && res.stopped)) {
    T.unread = res && res.faulted ? "fail" : T.awaiting ? "wait" : "unseen";
    tabsLiveSay(T);
  }
  T.waitUser = T.awaiting === true && !(res && (res.stopped || res.faulted));
  T.awaiting = false;
  if (T.closed && !tabRun(T)) tabsDestroy(T);   // 關掉但還在跑的那條:跑完就收掉(清單裡照樣有它)
  tabsPaint();
}
window.blave.onTurnEvent(tabsOnEvent);
window.blave.onTurnEnd(tabsOnEnd);

/* 排隊(只有對著雲端主機、那台的名額滿了才會有;spec 技術方案 §1.4):排隊行＋〔取消排隊〕,字同 web csShowQueued */
function tabsQueued(T, on) {
  T.queued = !!on;
  if (on && !T.queueEl) {
    // 同 web csShowQueued:一行排隊句,取消靠送出鍵(sendBtnSync 在排隊時改名「取消排隊」)
    const q = document.createElement("div"); q.className = "think-indicator cs-queued"; q.setAttribute("role", "status");
    q.textContent = t("tabs.queue"); q.dataset.i18n = "tabs.queue";
    T.el.appendChild(q); T.queueEl = q;
    withTab(T, () => scrollChat());
  } else if (!on && T.queueEl) { T.queueEl.remove(); T.queueEl = null; }
  withTab(T, () => sendBtnSync());
  tabsPaint();
}
/* 同時在跑的回合數(含這一句)當天第一次到 2／4／8 由主行程記(chat_par*);這裡只在送出時算眼前看不到的那些,給分頁列重畫 */
function tabsTrackParallel(T) {
  T.startedAt = Date.now();
  // 同時有別條在跑:這一條與那幾條的結果卡都只認自己碰過的策略(results.js resTurnOverlap)
  const others = [...CS.tabs.values()].filter((x) => x !== T && tabRun(x));
  if (others.length) { for (const x of others.concat([T])) withTab(x, () => { if (typeof resTurnOverlap === "function") resTurnOverlap(); }); }
  tabsPaint();
}

/* ── 背景分頁做完的播報:視窗在前景時念「{標題}，{狀態}」,2 秒內多條只念一句(canon › Sound 的合併規則) ── */
let tabsSaid = { at: 0, n: 0, timer: null };
function tabsLiveSay(T) {
  if (!document.hasFocus()) return;   // 不在前景:系統通知會講(主行程)
  const now = Date.now();
  if (now - tabsSaid.at < 2000) { tabsSaid.n++; } else { tabsSaid = { at: now, n: 1, timer: null }; }
  clearTimeout(tabsSaid.timer);
  const n = tabsSaid.n, title = tabsTitle(T), st = t(TAB_ST_KEY[T.unread]);
  tabsSaid.timer = setTimeout(() => { const el = $("tabs-live"); if (el) { el.textContent = ""; requestAnimationFrame(() => { el.textContent = n > 1 ? t("tabs.many", { n }) : title + "，" + st; }); } }, 50);
}

/* ── 分頁列 ── */
const TAB_ST_KEY = { wait: "tabs.st.wait", fail: "tabs.st.fail", unseen: "tabs.st.unseen" };
const TAB_X = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
/* 手機記號:這條有手機送來的回合在跑或排隊(主行程 relay 的 phoneSids,開跑／排隊加、結束／撤回／取消減)。講的是來源不是提醒,選中的也畫 */
const tabsPhone = (T) => !!(T && typeof PH !== "undefined" && PH && PH.phoneSids && PH.phoneSids[T.sid] > 0);
function tabsPhoneEl() { const s = document.createElement("span"); s.className = "tab-ph"; s.innerHTML = PHONE_IC; return s; }
// tooltip 第二行與 +N 選單的狀態字:手機那條前面加「來自手機 · 」
const tabsWordFull = (T, st) => { const w = tabsStateWord(T, st); return tabsPhone(T) && w ? t("chat.fromPhone") + " · " + w : w; };
function tabsTitle(T) { const s = T === CS.loaded ? csTitle : T.title; return (s && (fixedLabel(s, "title") || s)) || t("cs.new"); }
// 一個分頁只畫一種:回覆中 ＞ 等你回覆 ＞ 沒做完 ＞ 做完還沒看(spec §2);選中的不會有點
function tabsStateOf(T) {
  if (tabRun(T)) return T.queued ? "queued" : "run";
  if (T === CS.cur) return "";
  return T.unread || "";
}
function tabsStateWord(T, st) {
  if (st === "run") return t("tabs.st.run", { d: fmtDur(Math.max(0, (Date.now() - (T.startedAt || Date.now())) / 1000)) });
  if (st === "queued") return t("tabs.st.queued");
  return st ? t(TAB_ST_KEY[st]) : "";
}
const tabsNeedsYou = (st) => st === "wait" || st === "fail" || st === "unseen";
// 回覆中:3 格 tick,建的時候就帶目前那一格(重畫不閃);減少動態固定第 3 格亮。排隊中:收據的 8×2 短劃,不動(停住的 tick 讀成卡住)
const tabsTickK = () => (reducedMotion() ? "2" : String(tabsK));
function tabsLead(st) {
  if (st === "run") { const s = document.createElement("span"); s.className = "tab-lead"; const k = document.createElement("span"); k.className = "tab-ticks"; k.dataset.k = tabsTickK(); k.setAttribute("aria-hidden", "true"); k.innerHTML = "<i></i><i></i><i></i>"; s.appendChild(k); return s; }
  if (st === "queued") { const s = document.createElement("span"); s.className = "tab-lead"; const d = document.createElement("span"); d.className = "tab-dash"; d.setAttribute("aria-hidden", "true"); s.appendChild(d); return s; }
  if (tabsNeedsYou(st)) { const s = document.createElement("span"); s.className = "tab-lead"; const d = document.createElement("span"); d.className = "tab-dot"; d.setAttribute("aria-hidden", "true"); s.appendChild(d); return s; }
  return null;
}
// 列上放哪幾個(spec §13.6):mins[i] = min(自然寬, 選中 112／有手機記號 82／其他 60),分頁之間 TABS_GAP(= .cs-tabs gap)。最窄加總放得下就全放(flex 自己縮);
// 放不下就讓出 +N 的寬,先放選中的,再照順序加到下一格放不下為止——選中的落在後面時就排在列尾
const TABS_MIN = 60, TABS_MIN_SEL = 112, TABS_MIN_PHONE = 82, TABS_NARROW = 88, TABS_GAP = 2;   // 手機分頁 = 一般最窄 + 手機格 16 + 間距 6(mchat-phone-surfaces §1 V1:縮到最窄記號也在)
function tabsLayout(avail, order, curSid, mins, moreW) {
  if (mins.reduce((a, b) => a + b, 0) + TABS_GAP * (order.length - 1) <= avail) return { shown: order.slice(), hidden: [] };
  const ci = Math.max(0, order.indexOf(curSid)), keep = new Set([ci]), room = avail - moreW;
  let acc = mins[ci];
  for (let i = 0; i < order.length; i++) { if (i === ci) continue; if (acc + TABS_GAP + mins[i] > room) break; keep.add(i); acc += TABS_GAP + mins[i]; }
  return { shown: order.filter((_, i) => keep.has(i)), hidden: order.filter((_, i) => !keep.has(i)) };
}
function tabsPaint() {
  const bar = $("cs-tabs"); if (!bar) return;
  // 整列重建:焦點在分頁或選單列上時照 sid 還回去(不然每次有回合翻面,鍵盤焦點就掉回 body)
  const fa = document.activeElement, fSid = fa && fa.dataset && fa.dataset.sid && (bar.contains(fa) || $("cs-menu").contains(fa)) ? fa.dataset.sid : null, fMenu = !!(fSid && $("cs-menu").contains(fa));
  try { tabsPaintIn(bar); }
  finally {
    if (fSid) { const n = (fMenu ? $("cs-menu") : bar).querySelector('[data-sid="' + fSid + '"]'); if (n && n !== document.activeElement) { if (!fMenu) { bar.querySelectorAll('[role="tab"]').forEach((x) => { x.tabIndex = -1; }); n.tabIndex = 0; } n.focus({ preventScroll: true }); } }
    tabsTipTick();
  }
}
function tabsPaintIn(bar) {
  const order = CS.order.filter((s) => CS.tabs.has(s));
  // 只有一條、而且還沒講過話:列上只有 ☰ 與 ＋,不畫空分頁(spec §1-1)
  const lone = order.length === 1 && CS.cur && order[0] === CS.cur.sid && !csTitle && !running;
  bar.textContent = "";
  $("cs-more").hidden = true;
  tabsHint();   // 提示先畫:它吃掉的寬要算進 avail
  if (lone) return;
  const curSid = CS.cur && CS.cur.sid, F = CS.freeze;
  if (F && F.shown.includes(curSid) && F.w.get(curSid).w >= TABS_MIN_SEL) {   // 接手選中的那格不到 112 就不凍,照規則重排   // 剛用滑鼠關掉一個:其餘照原寬,滑鼠離開分頁列才重排(下一顆 × 停在游標底下)
    const shown = F.shown.filter((s) => order.includes(s));
    for (const sid of shown) { const r = F.w.get(sid), el = tabsTabEl(CS.tabs.get(sid)); el.style.flex = "none"; el.style.width = r.w + "px"; if (sid !== curSid) { if (r.nox) el.classList.add("nox"); if (r.narrow) el.classList.add("narrow"); } bar.appendChild(el); }
    tabsMorePaint(order.filter((s) => !shown.includes(s)));
    return;
  }
  CS.freeze = null;
  // 自然寬:整排先以內容寬(上限 180)量一次
  const els = order.map((sid) => tabsTabEl(CS.tabs.get(sid)));
  els.forEach((el) => { el.style.flex = "none"; bar.appendChild(el); });
  const nat = els.map((el) => Math.ceil(el.getBoundingClientRect().width));
  const mins = nat.map((n, i) => (order[i] === curSid ? TABS_MIN_SEL : Math.min(n, tabsPhone(CS.tabs.get(order[i])) ? TABS_MIN_PHONE : TABS_MIN)));   // 選中那格標題短也撐到 112:× 32 才不會蓋掉大半個分頁
  const avail = bar.clientWidth || 300;
  let L = tabsLayout(avail, order, curSid, mins, 44);
  if (L.hidden.length) { tabsMorePaint(L.hidden); const mw = $("cs-more").offsetWidth; if (mw > 44) L = tabsLayout(avail, order, curSid, mins, mw); }
  bar.textContent = "";
  for (const sid of L.shown) { const i = order.indexOf(sid), el = els[i]; el.style.flex = ""; el.style.minWidth = mins[i] + "px"; el.dataset.nat = nat[i]; bar.appendChild(el); }
  tabsMorePaint(L.hidden);
  // 沒選中、寬不到 88 的不出 ×(spec §13.4):× 32 會吃掉大半個分頁,點中間就關掉了;關它用中鍵或鍵盤。被縮過的另加 narrow(標題不畫「…」、尾端淡出)
  for (const el of [...bar.children]) { if (el.getAttribute("aria-selected") === "true") continue; const w = el.getBoundingClientRect().width; if (w < TABS_NARROW) { el.classList.add("nox"); if (w < Number(el.dataset.nat) - 1) el.classList.add("narrow"); } }
}
// 用滑鼠關分頁前記下列上每格的寬(spec §13.6);鍵盤關不凍
function tabsFreeze() {
  const w = new Map();
  for (const el of $("cs-tabs").querySelectorAll(".tab")) w.set(el.dataset.sid, { w: el.getBoundingClientRect().width, nox: el.classList.contains("nox"), narrow: el.classList.contains("narrow") });
  CS.freeze = { w, shown: [...w.keys()] };
}
function tabsTabEl(T) {
  const sel = T === CS.cur, st = tabsStateOf(T);
  const el = document.createElement("div"); el.className = "tab" + (tabsNeedsYou(st) ? " attn" : "");
  el.setAttribute("role", "tab"); el.setAttribute("aria-selected", sel ? "true" : "false"); el.tabIndex = sel ? 0 : -1; el.dataset.sid = T.sid;
  const lead = tabsLead(st); if (lead) el.appendChild(lead);
  const phone = tabsPhone(T); if (phone) el.appendChild(tabsPhoneEl());   // 第二個固定格,在 tick／短劃之後(那格一次只放一種,不搶)
  const ti = document.createElement("span"); ti.className = "tab-t"; ti.textContent = tabsTitle(T); el.appendChild(ti);
  if (phone) { const sp = document.createElement("span"); sp.className = "sr-only"; sp.textContent = "，" + t("chat.fromPhone"); el.appendChild(sp); }
  const word = st === "run" ? t("tabs.st.running") : tabsStateWord(T, st);   // 分頁名稱不帶時長:讀屏念的是畫的那一刻,數字會凍住
  if (word) { const sr = document.createElement("span"); sr.className = "sr-only"; sr.textContent = "，" + word; el.appendChild(sr); }
  const x = document.createElement("span"); x.className = "tab-x"; x.setAttribute("aria-hidden", "true"); x.tabIndex = -1; x.innerHTML = '<span class="tab-xv">' + TAB_X + "</span>";
  x.addEventListener("click", (e) => { e.stopPropagation(); tabsFreeze(); tabsClose(T); });
  el.appendChild(x);
  el.addEventListener("click", () => { if (T !== CS.cur) { tabShow(T); trackFeature("tab_switch"); } if (!$("cs-list").hidden) csShowList(false); });
  el.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); tabsFreeze(); tabsClose(T); } });
  el.addEventListener("mouseenter", () => tabsTip(el, T)); el.addEventListener("mouseleave", tabsTipOff);
  el.addEventListener("focus", () => tabsTip(el, T)); el.addEventListener("blur", tabsTipOff);
  return el;
}
/* tooltip:沿用 .tip 的外觀,掛在分頁列外(分頁列 overflow:hidden 會裁)。截斷時第一行是全標題,第二行狀態字;沒截斷只放狀態字 */
function tabsTip(el, T) {
  const tip = $("tabs-tip"); if (!tip || tip.dataset.off) return;
  const ti = el.querySelector(".tab-t"), cut = ti && ti.scrollWidth > ti.clientWidth + 1, word = tabsWordFull(T, tabsStateOf(T));
  tip.textContent = "";
  if (cut) { const b = document.createElement("b"); b.textContent = tabsTitle(T); tip.appendChild(b); }
  if (word) tip.appendChild(document.createTextNode(word));
  if (!tip.childNodes.length) { tip.hidden = true; return; }
  const head = $("cs-head").getBoundingClientRect(), r = el.getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(r.left - head.left, head.width - 268)) + "px";
  tip.hidden = false; tip.dataset.sid = T.sid;
}
function tabsTipOff() { const tip = $("tabs-tip"); if (tip) { tip.hidden = true; delete tip.dataset.off; delete tip.dataset.sid; } }
// 每秒:開著的 tooltip 跟著跳秒(分頁每次重畫是新元素,照 sid 找回來)
function tabsTipTick() {
  const tip = $("tabs-tip"); if (!tip || tip.hidden || !tip.dataset.sid) return;
  const T = CS.tabs.get(tip.dataset.sid), el = $("cs-tabs").querySelector('.tab[data-sid="' + tip.dataset.sid + '"]');
  if (T && el) tabsTip(el, T); else tabsTipOff();
}
/* +N:收起來的那幾條;有要你看的放點並加粗,否則有回覆中的放 tick。aria-label 例外:可見字只有「+N」(spec §2 可及性) */
function tabsMorePaint(hidden) {
  const b = $("cs-more"); b.hidden = !hidden.length; if (!hidden.length) { tabsMenuClose(); return; }
  const Ts = hidden.map((s) => CS.tabs.get(s)), sts = Ts.map(tabsStateOf);
  const nd = sts.filter(tabsNeedsYou).length, run = sts.filter((s) => s === "run" || s === "queued").length;
  b.textContent = ""; b.classList.toggle("attn", nd > 0);
  // 有一條真的在跑就放 tick(「有東西在跑」);全是排隊才放短劃
  const lead = nd ? tabsLead("unseen") : sts.includes("run") ? tabsLead("run") : run ? tabsLead("queued") : null; if (lead) b.appendChild(lead);
  b.appendChild(document.createTextNode("+" + hidden.length));
  const parts = ["+" + hidden.length]; if (nd) parts.push(t("tabs.more.attn", { n: nd })); if (run) parts.push(t("tabs.more.run", { n: run }));
  b.setAttribute("aria-label", parts.join("，"));
  b._hidden = hidden;
  if (!$("cs-menu").hidden) tabsMenuPaint();
}
function tabsMenuPaint() {
  const m = $("cs-menu"), hidden = $("cs-more")._hidden || [];
  m.textContent = "";
  hidden.forEach((sid) => {
    const T = CS.tabs.get(sid); if (!T) return;
    const st = tabsStateOf(T), it = document.createElement("button"); it.type = "button"; it.className = "mi" + (tabsNeedsYou(st) ? " attn" : ""); it.setAttribute("role", "menuitem"); it.dataset.sid = sid;
    const lead = tabsLead(st); if (lead) it.appendChild(lead); else { const s = document.createElement("span"); s.className = "tab-lead"; it.appendChild(s); }
    if (tabsPhone(T)) it.appendChild(tabsPhoneEl());
    const ti = document.createElement("span"); ti.className = "mi-t"; ti.textContent = tabsTitle(T); it.appendChild(ti);
    const word = tabsWordFull(T, st);
    if (word) { const sep = document.createElement("span"); sep.className = "sr-only"; sep.textContent = "，"; it.appendChild(sep); const w = document.createElement("span"); w.className = "mi-s" + (st === "wait" || st === "fail" ? " s-strong" : st === "unseen" ? " s-soft" : ""); w.textContent = word; it.appendChild(w); }
    it.addEventListener("click", () => { tabsMenuClose(); tabShow(T); trackFeature("tab_switch"); });
    m.appendChild(it);
  });
}
function tabsMenuOpen() { const m = $("cs-menu"); tabsMenuPaint(); m.hidden = false; $("cs-more").setAttribute("aria-expanded", "true"); $("cs-more").classList.add("on"); trackFeature("tab_overflow"); const f = m.querySelector(".mi"); if (f) f.focus(); }
function tabsMenuClose() { const m = $("cs-menu"); if (!m || m.hidden) return; m.hidden = true; $("cs-more").setAttribute("aria-expanded", "false"); $("cs-more").classList.remove("on"); }
/* ☰ 旁的提示:只算關掉的對話(開著的在分頁上看;canon › 對話狀態字 › 標題列提示)。等你 ＞ 回覆中 ＞ 排隊 */
function tabsHint() {
  const h = $("cs-hint"); if (!h) return;
  let run = 0, q = 0;
  for (const [sid, ph] of CS.main) if (!CS.tabs.has(sid) || CS.tabs.get(sid).closed) { if (ph === "queued") q++; else if (ph) run++; }
  for (const T of CS.tabs.values()) if (T.closed && tabRun(T)) { if (T.queued) q++; else run++; }
  h.textContent = run ? t("tabs.hint.run", { n: run }) : q ? t("tabs.hint.queued", { n: q }) : "";
  h.hidden = !h.textContent;
}

function tabsAdd(T) { CS.freeze = null; T.closed = false; if (!CS.order.includes(T.sid)) CS.order.push(T.sid); tabsSave(); tabsPaint(); }
function tabsDestroy(T) {
  T.dead = true; T.el.remove(); CS.tabs.delete(T.sid);
  if (T.st && T.st.SUG && T.st.SUG.timer) clearTimeout(T.st.SUG.timer);
}
/* 關分頁:從列上拿掉,不刪、不停(spec §2 關分頁);回覆中的照跑,跑完才收。關的是選中的那個 → 選它右邊的,沒有就左邊;最後一個 → 換一個新的空分頁 */
function tabsClose(T, o) {
  const i = CS.order.indexOf(T.sid); if (i < 0) return;
  const deleted = !!(o && o.deleted), run = tabRun(T);
  if (!deleted) { trackFeature(run ? "tab_close_busy" : "tab_close"); CS.closed.push(T.sid); if (CS.closed.length > 20) CS.closed.shift(); }
  CS.order.splice(i, 1);
  if (CS.cur === T) {
    const next = CS.order[i] || CS.order[i - 1];
    if (next) tabShow(CS.tabs.get(next));
    else { const N = tabMake(csNewId()); CS.order.push(N.sid); tabShow(N); }
  }
  if (run && !deleted) { T.closed = true; T.el.hidden = true; } else tabsDestroy(T);
  if (typeof sugCollapse === "function" && T === CS.cur) sugCollapse();
  tabsSave(); tabsPaint();
}
/* ⌘W:畫面判斷是不是最後一個分頁;最後一個(而且還沒講過話)就請主行程照紅燈規則關窗 */
function tabsCloseCur() {
  const lone = CS.order.length <= 1 && !csTitle && !running;
  if (lone || CS.order.length === 0) { window.blave.windowClose(); return; }
  if (CS.order.length === 1) { tabsClose(CS.cur); window.blave.windowClose(); return; }
  tabsClose(CS.cur);
}
function tabsReopen() { while (CS.closed.length) { const sid = CS.closed.pop(); if (!CS.order.includes(sid)) { csOpen(sid); return; } } }
function tabsGo(n) { const order = CS.order; if (!order.length) return; const sid = n === 9 ? order[order.length - 1] : order[n - 1]; if (sid && CS.tabs.get(sid) !== CS.cur) { tabShow(CS.tabs.get(sid)); trackFeature("tab_switch"); } }
function tabsStep(d) { const order = CS.order, i = order.indexOf(CS.cur && CS.cur.sid); if (order.length < 2 || i < 0) return; tabShow(CS.tabs.get(order[(i + d + order.length) % order.length])); trackFeature("tab_switch"); }

/* ── 記憶:開著哪些、順序、選中哪個存 ui-prefs(這台裝置的版面偏好,不同步;spec §2 順序與記憶) ── */
function tabsSave() {
  if (!CS.bootDone || typeof window.blave.tabsPrefsSet !== "function") return;
  const tabs = CS.order.filter((s) => { const T = CS.tabs.get(s); return T && (T.title || (T === CS.loaded && csTitle)); });
  window.blave.tabsPrefsSet({ tabs, sel: CS.cur ? CS.cur.sid : null }).catch(() => {});
}
async function tabsRestore() {
  let p = null; try { p = typeof window.blave.tabsPrefs === "function" ? await window.blave.tabsPrefs() : null; } catch (_) { p = null; }
  try { csItems = await window.blave.listSessions(); } catch (_) { csItems = []; }
  const known = new Set(csItems.map((m) => m && m.id));
  let tabs = p && Array.isArray(p.tabs) ? p.tabs.filter((s) => known.has(s)) : [];
  let sel = p && p.sel;
  if (!tabs.length) { let saved = null; try { saved = localStorage.getItem("ws_session"); } catch (_) { /* noop */ } if (saved && known.has(saved)) { tabs = [saved]; sel = saved; } }
  if (!tabs.includes(sel)) sel = tabs[tabs.length - 1];
  // 重開只畫選中那一個,其他點到才讀 session.db(§12 第 12 條)
  tabs.forEach((sid) => { const m = csItems.find((x) => x.id === sid) || {}; const T = tabMake(sid, { title: m.title || "", lazy: true }); CS.order.push(sid); });
  if (!tabs.length) { const T = tabMake(csNewId()); CS.order.push(T.sid); sel = T.sid; }
  const S = CS.tabs.get(sel);
  tabShow(S);
  CS.bootDone = true;
  if (!S.drawn) await csDraw(S);
  try { const st = await window.blave.turnsState(); for (const x of st || []) CS.main.set(x.sid, x.phase || "running"); } catch (_) { /* 舊主行程 */ }
  tabsPaint();
}

/* ── 鍵盤:⌘T／⌘W 由選單送(main.js tab-new / tab-close);⌘1–9、⌃Tab／⌃⇧Tab、⌘⇧T 在這裡 ── */
document.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229 || $("view-ws").hidden || $("view-ws").inert) return;
  const mod = e.metaKey || (window.blave.platform === "win32" && e.ctrlKey);
  if (mod && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) { e.preventDefault(); tabsGo(Number(e.code.slice(5))); return; }
  if (e.ctrlKey && !e.metaKey && e.key === "Tab") { e.preventDefault(); tabsStep(e.shiftKey ? -1 : 1); return; }
  if (mod && e.shiftKey && !e.altKey && e.code === "KeyT") { e.preventDefault(); tabsReopen(); }
});
$("cs-tabs").addEventListener("keydown", (e) => {
  const tabs = [...$("cs-tabs").querySelectorAll('[role="tab"]')], i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  if (e.key === "ArrowRight" && i === tabs.length - 1 && !$("cs-more").hidden) { e.preventDefault(); $("cs-more").focus(); }   // 走到列尾:焦點落到 +N(spec §13.7)
  else if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Home" || e.key === "End") {
    e.preventDefault();
    const n = e.key === "Home" ? tabs[0] : e.key === "End" ? tabs[tabs.length - 1] : tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    tabs.forEach((x) => { x.tabIndex = -1; }); n.tabIndex = 0; n.focus();
  }
  else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tabs[i].click(); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); const T = CS.tabs.get(tabs[i].dataset.sid); if (T) tabsClose(T); }
});
// Esc 收 tooltip:滑鼠滑過(焦點不在分頁列)時也收得掉(WCAG 1.4.13);同 app.js tipEsc:window capture 先收、收掉才不往下傳(escTop 不再關一層),沒顯示不攔
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.isComposing || e.keyCode === 229) return;
  const tip = $("tabs-tip"); if (!tip || tip.hidden) return;
  tip.hidden = true; tip.dataset.off = "1"; e.preventDefault(); e.stopPropagation();
}, true);
$("cs-more").addEventListener("click", () => { if ($("cs-menu").hidden) tabsMenuOpen(); else tabsMenuClose(); });
$("cs-more").addEventListener("keydown", (e) => { if (e.key !== "ArrowLeft") return; const tabs = $("cs-tabs").querySelectorAll('[role="tab"]'); if (tabs.length) { e.preventDefault(); tabs[tabs.length - 1].focus(); } });
$("cs-menu").addEventListener("keydown", (e) => {
  const items = [...$("cs-menu").querySelectorAll(".mi")], i = items.indexOf(document.activeElement);
  if (e.key === "Escape") { e.preventDefault(); tabsMenuClose(); $("cs-more").focus(); }
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const n = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]; if (n) n.focus(); }
});
document.addEventListener("mousedown", (e) => { if (!$("cs-menu").hidden && !e.target.closest("#cs-menu, #cs-more")) tabsMenuClose(); });
$("cs-hint").addEventListener("click", () => { csShowList(true); trackFeature("hist_open"); });
if (typeof window.blave.onTabNew === "function") window.blave.onTabNew(() => csNewClick());
if (typeof window.blave.onTabClose === "function") window.blave.onTabClose(() => tabsCloseCur());
// 手機來的那一輪(relay.js):背景開成分頁(記號跟著 relay 的 phoneSids),手機送的那句接在歷史後面、帶「來自手機」;
// 列外那個 aria-live 念一次「{標題}，來自手機」,不然讀屏不知道列上多了一個分頁
if (typeof window.blave.onTabOpen === "function") window.blave.onTabOpen((o) => {
  if (!o || typeof o.sid !== "string") return;
  const was = CS.tabs.has(o.sid) && !CS.tabs.get(o.sid).closed, p = csOpen(o.sid, { focus: o.focus !== false, since: o.origin === "mobile" ? o.since : 0 });
  if (o.origin !== "mobile") return;
  trackFeature("tab_remote");
  p.then((T) => {
    if (!T || T.dead) return;
    if (o.echo && !T.echoDrawn) withTab(T, () => addHistoryYou(o.echo, "mobile"));   // 讀歷史時已經畫到那一句(csDraw):不補第二次
    T.echoDrawn = false;
    if (o.echo) tabsPhoneTitle(T, o.echo);
    if (!was && o.focus === false) { const el = $("tabs-live"); if (el) { el.textContent = ""; requestAnimationFrame(() => { el.textContent = tabsTitle(T) + "，" + t("chat.fromPhone"); }); } }
  }).catch(() => {});
});
// 手機那句是這條的第一句:標題比照電腦前送出(app.js submitMessage),空才設、不帶附件行。歷史先讀到 session.db 時標題還是空的,
// 送出那條路又不經過這裡,不補的話分頁、+N 選單與對話清單一直是「新對話」。背景分頁不動眼前的標題列
function tabsPhoneTitle(T, echo) {
  const a = splitAttachNote(echo), title = a.text || a.attachments[0] || "";
  if (!title || !withTab(T, () => { if (csTitle) return false; csTitle = title; if (!CS.bg) csRenderHead(); return true; })) return;
  T.title = title;
  const m = csItems.find((x) => x && x.id === T.sid); if (m && !m.title) m.title = title;
  const list = $("cs-list"); if (list && !list.hidden) csFilter();
  tabsSave(); tabsPaint();
}
// 拉寬拉窄即時重算(凍住的寬也放掉);寬沒變的通知(重畫本身)不理
new ResizeObserver(() => { const w = $("cs-tabs").clientWidth; if (w === CS.barW) return; CS.barW = w; CS.freeze = null; tabsPaint(); }).observe($("cs-tabs"));
$("cs-tabs").addEventListener("mouseleave", () => { if (CS.freeze) { CS.freeze = null; tabsPaint(); } });
// 回覆中的時長每秒進一格(tooltip、+N 選單裡的字);只在有回合時跑
setInterval(() => {
  if (!csAnyTurn()) return;
  tabsK = (tabsK + 1) % 3;
  const k = tabsTickK();
  document.querySelectorAll(".tab-ticks").forEach((el) => { el.dataset.k = k; });
  if (!$("cs-menu").hidden) tabsMenuTick();
  tabsTipTick();
}, 1000);
// 選單開著:每秒只換回覆中那幾列的時長字,不重建(重建會讓方向鍵移到一半的焦點掉回 body)
function tabsMenuTick() {
  for (const it of $("cs-menu").querySelectorAll(".mi")) {
    const T = CS.tabs.get(it.dataset.sid), w = it.querySelector(".mi-s");
    if (T && w && tabsStateOf(T) === "run") w.textContent = tabsStateWord(T, "run");
  }
}

/* 歷史清單那一列的狀態(app.js csRow):優先序回覆中 ＞ 等你回覆 ＞ 排隊中 ＞ 沒做完 ＞ 做完，還沒看;眼前那條不算 */
function csListState(m) {
  const T = CS.tabs.get(m.id), ph = CS.main.get(m.id);
  if (T && T === CS.cur) return null;
  if (T && tabRun(T)) return T.queued ? { kind: "queued", word: t("tabs.st.queued") } : { kind: "run", word: tabsStateWord(T, "run") };
  if (ph === "queued") return { kind: "queued", word: t("tabs.st.queued") };
  if (ph) return { kind: "run", word: t("tabs.st.running") };
  if (m.waiting) return { kind: "wait", word: t("tabs.st.wait") };
  if (T && T.unread) return { kind: T.unread, word: t(TAB_ST_KEY[T.unread]) };
  return null;
}
