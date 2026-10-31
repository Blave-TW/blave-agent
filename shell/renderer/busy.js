/* 回合中的鎖(設計 spec busy-lock-2026-10 第一期)。0.1.37 起多條對話並行(chattabs.js):這裡的鎖都是機器層級,看「任何回合」(csAnyTurn);
   「這條自己在跑」的(送出鍵、Enter、刪回覆中那條)看分頁自己的 running。切換對話、開新對話、從別處送一句話不再上鎖(spec chat-tabs §3)。
   留下的鎖只有 BUSY 這張表;每一把都是 aria-disabled(鈕照畫、可聚焦、可點),點了在控件附近的訊息槽寫一句原因＋一個補救連結
   (查看 = 帶回聊天欄看那條回覆;停止 = 停掉那條)。不出 toast,一個容器一個槽,新的一句取代舊的;回合結束(busySync)全部收掉。
   送一句話的鈕各自已有原因行(策略庫、報告、轉出…),那幾處只叫 busyHit("send") 記埋點,句子是 turn.busy、不加連結(mockup-v2 1-3:送出鍵就是停止)。
   載在 app.js 之前(handoff.js 前一支);用到 app.js 的 $ / t / running / stopTurn / trackFeature / setClose / csShowList / paneSt / paneToggle / scrollChat——都在呼叫時才取。 */
const BUSY = {
  update:   { key: "busy.update",   fix: "view" },
  perf:     { key: "busy.perf",     fix: "view" },
  xtPerf:   { key: "xt.busyTurn",   fix: "view" },   // 成交測試的〔開始測試〕／〔重新測試〕:同一條指令、同一把鎖,句子換它自己的
  rerun:    { key: "busy.rerun",    fix: "view" },
  restore:  { key: "busy.restore",  fix: "view" },
  chatDel:  { key: "busy.chatDel",  fix: "stop" },
  cloudUpd: { key: "busy.cloudUpd", fix: "stop" },
  send:     { key: "turn.busy",     fix: null },
};
// 埋點名(spec §4;tests/check_shell_telemetry.js 掃這張表):被擋那一下記哪一把鎖。del 不在 BUSY:刪策略被鎖時不講原因(Wei),只記埋點
const BUSY_FEATURE = { update: "lock_update", perf: "lock_perf", xtPerf: "lock_perf", rerun: "lock_perf", restore: "lock_restore", del: "lock_del", chatDel: "lock_chat_del", cloudUpd: "lock_send", send: "lock_send" };
// 停止之後等回合真的收掉再做(登出 / 換 AI / 移除自帶金鑰);主行程 STOP_KILL_MS 5 秒沒輸出就砍,這裡給到 20 秒。
// 逾時不照做:確認框說了「會先停止」,停不下來就在原位講一句、留「停止」再按
const BUSY_STOP_WAIT_MS = 20000;
// 單一待辦:同時只等一件事,新的取代舊的(連按登出、登出後又換 AI 不會疊出好幾件、執行順序不定)。回合一結束(busySync)當場做,不輪詢
let BUSY_PENDING = null;   // { fn, timer }

function busyOn() { return typeof csAnyTurn === "function" ? csAnyTurn() : typeof running !== "undefined" && running === true; }
function busyLock(el, on) { if (!el) return; if (on) el.setAttribute("aria-disabled", "true"); else el.removeAttribute("aria-disabled"); }
function busyLocked(el) { return !!el && el.getAttribute("aria-disabled") === "true"; }
function busyHit(kind) { if (BUSY_FEATURE[kind] && typeof trackFeature === "function") trackFeature(BUSY_FEATURE[kind]); }

// 送一句話被擋、那顆鈕旁邊沒有自己的原因行:寫在輸入框上方那一行(同 Enter),回合結束 sendBtnSync 收
function busySendTell() {
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);   // 聊天欄收著:原因句寫在看不見的那一欄等於沒講(設計稽核 0127)
  taWaitShow(true); busyHit("send");
}

// 容器的訊息槽:第一次用到才建,接在 anchor 後面(已建好但被重畫移走了就搬回 anchor 後面)
function busySlot(id, anchor) {
  let s = document.getElementById(id);
  if (!s) { s = document.createElement("p"); s.id = id; s.className = "busy-why"; s.setAttribute("role", "status"); s.setAttribute("aria-live", "polite"); s.hidden = true; }
  if (anchor && anchor.parentNode && anchor.nextSibling !== s) anchor.parentNode.insertBefore(s, anchor.nextSibling);
  return s;
}
/* 同一畫面同一事實只講一次(稽核 0127b1 P1-5):寫新的一句原因,先收掉別處還掛著的舊句(data-busy 的槽)。
   不收的兩句:輸入框上方那句(回合本身的狀態,不是 data-busy)、「停止中…」(busy-cut-why:用戶剛按的動作還在進行) */
function busyQuietOthers(keep) {
  document.querySelectorAll("[data-busy]").forEach((s) => { if (s !== keep && s.id !== "busy-cut-why") busyQuiet(s); });
}
// 掛補救鈕的地方都是一句原因句(各頁自己的槽也一樣:轉出、策略庫、版本、掃描／驗證):在這裡收掉別處的舊句、記 data-busy,回合結束 busySync 一起收
function busyFixLink(el, action) {
  if (!el || !action) return;
  const b = document.createElement("button"); b.type = "button"; b.className = "btn-quiet busy-fix"; b.textContent = t(action === "stop" ? "busy.fix.stop" : "busy.fix.view");
  b.addEventListener("click", () => busyFix(action, el.dataset && el.dataset.sid));
  el.append(" ", b);
  busyQuietOthers(el); el.dataset.busy = "1";
}
function busyTell(slot, kind, sid) {   // sid:補救〔停止〕要停的那一條(刪回覆中那條);沒帶 = 全部在跑的
  const L = BUSY[kind]; if (!slot || !L) return;
  if (sid) slot.dataset.sid = sid; else delete slot.dataset.sid;
  busyQuietOthers(slot);
  slot.textContent = "";
  const s = document.createElement("span"); s.textContent = t(L.key); slot.appendChild(s);
  busyFixLink(slot, L.fix);
  slot.hidden = false; slot.dataset.busy = "1";   // 借用別人的原因行(#rp-ho-note)也要在回合結束時收掉
  busyHit(kind);
}
function busyFix(action, sid) {
  if (typeof trackFeature === "function") trackFeature("lock_fix");
  if (action === "stop") { if (sid && typeof csStopOne === "function") csStopOne(sid); else if (typeof csStopAll === "function") csStopAll(); else stopTurn(); return; }
  busyView();
}
// 查看:回到聊天欄、在跑的那條回覆的最底下(眼前這條沒在跑就切到在跑的那條;設定 / 對話清單蓋著就收,聊天欄收著就展開)
function busyView() {
  if (typeof csShowRunning === "function") csShowRunning();
  if (!$("set-scrim").hidden) setClose();
  if (!$("cs-list").hidden) csShowList(false);
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);
  scrollChat(true);
  $("ta").focus();
}
// 「停止中…」與逾時句的槽:掛在不會被重畫的容器上——設定開著在設定標題列下方,關著在聊天標題列下方(聊天欄收著先展開)。
// 每次寫都重新取一次(設定裡那幾頁會整頁重畫,按的那顆鈕旁邊的節點會被拆掉)。
// expand:用戶剛按下確認才展開聊天欄;20 秒後的逾時句不動版面(用戶可能已經在做別的事)
function busyCutSlot(expand) {
  const sc = $("set-scrim"), inSet = sc && !sc.hidden;
  if (expand && !inSet && typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);
  return busySlot("busy-cut-why", inSet ? $("set-modal").querySelector(".modal-head") : $("cs-head"));
}
function busyStopThen(fn) {
  if (!busyOn()) { fn(); return; }
  if (BUSY_PENDING) clearTimeout(BUSY_PENDING.timer);
  const slot = busyCutSlot(true);
  slot.textContent = t("busy.stopping"); slot.hidden = false; slot.dataset.busy = "1";
  const p = BUSY_PENDING = { fn, timer: setTimeout(() => busyStopTimeout(p), BUSY_STOP_WAIT_MS) };
  if (typeof csStopAll === "function") csStopAll(); else stopTurn();
}
function busyStopTimeout(p) {
  if (BUSY_PENDING !== p) return;
  BUSY_PENDING = null;
  const slot = busyCutSlot(false);
  slot.textContent = "";
  const s = document.createElement("span"); s.textContent = t("busy.stopFail"); slot.appendChild(s);
  busyFixLink(slot, "stop"); slot.hidden = false; slot.dataset.busy = "1";
}
function busyQuiet(slot) { if (slot) { slot.hidden = true; slot.textContent = ""; delete slot.dataset.busy; } }
// 會中斷這條回覆的動作(換 AI):回合中先問,確認了先停、等收掉再做;沒回合直接做。go 不可以再過守門(逾時會自己再跳框)
function busyCut(opener, go) {
  if (!busyOn()) { go(); return; }
  confirmBox({ title: t("busy.cut.title"), lines: [t("busy.cut.out")], ok: t("busy.cut.ok"), opener, onOk: () => busyStopThen(go) });
}

// 回合開跑 / 結束時(app.js 上鎖、解鎖那幾串)叫:對話清單的鎖切 aria-disabled(策略列的 ✕ 在 stratDelSync);結束時收掉所有原因句
function busySync() {
  const on = busyOn();
  // 清單列尾的刪除:只鎖回覆中那條自己(csRow 掛 data-sid)
  document.querySelectorAll("#cs-rows .cs-row").forEach((row) => { const del = row.querySelector(".cs-del"); busyLock(del, typeof csTabRunning === "function" && csTabRunning(row.dataset.sid)); });
  if (on) return;
  document.querySelectorAll("[data-busy]").forEach(busyQuiet);
  const p = BUSY_PENDING; BUSY_PENDING = null;
  if (p) { clearTimeout(p.timer); p.fn(); }
}
