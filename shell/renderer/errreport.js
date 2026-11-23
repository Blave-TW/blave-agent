/* 錯誤回報的詢問卡與設定(spec agent-error-report-2026-11-16 §5;主行程那半在 shell/errreport.js)。
   卡由外殼畫在對話串裡,不是 AI 的回覆:只活在畫面上,不存進對話紀錄、不經手機同步。內容一律 textContent。
   出卡時機:一輪結束時畫在那一輪的對話裡、只問那一輪記的(0.1.59);剛開 app 而且沒有任何回合在跑時問不屬於對話的那些;
   每個本地日最多一張(主行程判)。
   〔看會送出的內容〕顯示的那份文字由主行程給,送出的就是那一份;畫面只回「送／不送／以後自動送」。
   不加使用事件(Wei 裁定,spec §8)。 */
var ERR_MODE = "ask";
let errAsking = false, errLive = null;   // errLive = 還沒按的那張卡;新卡出來時收掉(它的記錄已併進新卡,主行程也只認新那批)
async function errAsk(sid) {
  // sid = 剛結束那一輪的對話:卡只畫在那條。那條關掉了、或已經開跑下一輪:不問(那一輪的記錄主行程之後丟掉,不會跑到別條)
  const T = sid ? CS.tabs.get(sid) : null;
  if (sid && (!T || T.dead || tabRun(T))) return;
  const sc = chatEl();
  // 自動送與不送也走這一支(主行程在裡面送掉或清檔、回 null);還在連結畫面:這次不問,下一輪再問
  if (errAsking || !sc || !sc.isConnected || !sc.getClientRects().length) return;
  if (!sid && typeof csAnyTurn === "function" && csAnyTurn()) return;   // 剛開 app:不打斷進行中的回合
  errAsking = true;
  let p = null;
  try { p = await window.blave.errReportPending(sid || undefined); } catch (_) { p = null; } finally { errAsking = false; }
  if (!p || !p.id) return;
  if (!T) errCard(p);
  else if (!T.dead) withTab(T, () => errCard(p));
}
function errCard(p) {
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  if (errLive) errLive.el.remove();
  const card = faultCard();
  card.T = typeof CS !== "undefined" ? CS.loaded : null;   // 卡屬於畫上去的那條對話(errReattach 只接回那條)
  errLive = card;
  // 版面(設計稽核 M2):說明句 → 帳號句 → 〔看會送出的內容〕 → JSON → 〔送出〕〔不送〕☐ 以後自動送 → 勾選說明。先讀到同意的事實,才看到鈕
  const sub = mk("div", "err-sub"), acct = mk("p", "err-acct");
  const pre = mk("pre", "err-json", p.text); pre.id = "err-json-" + p.id; pre.hidden = true; pre.tabIndex = 0;   // 240 高可捲:鍵盤要進得去
  const tog = mk("button", "btn-quiet err-tog"); tog.type = "button"; tog.setAttribute("aria-controls", pre.id); tog.setAttribute("aria-expanded", "false");
  // 只切 pre 跟鈕字,不經 card.set:鈕不重建,焦點留在鈕上,也不會重念整句。
  // 卡在對話最底時展開會把鈕列推出聊天欄:捲到勾選說明露出來為止,不用自己捲才找得到〔送出〕
  tog.addEventListener("click", () => { pre.hidden = !pre.hidden; tog.setAttribute("aria-expanded", pre.hidden ? "false" : "true"); tog.textContent = t(pre.hidden ? "err.view" : "err.hide");
    if (!pre.hidden) (note.isConnected ? note : act).scrollIntoView({ block: "nearest" }); });   // 勾了自動送、按過之後 note 已拿掉:退到鈕列
  sub.append(acct, tog, pre);
  const lab = mk("label", "err-always"), box = mk("input", "ps-cb"), labT = mk("span");
  const note = mk("p", "err-note"); note.id = "err-note-" + p.id;
  box.type = "checkbox"; box.id = "err-always-" + p.id; box.setAttribute("aria-describedby", note.id);
  lab.htmlFor = box.id; lab.append(box, labT);
  const words = () => {   // 換語言時跟著重寫(SYS_RELANG 經 sysLz 重算)
    acct.textContent = t("err.acct"); tog.textContent = t(pre.hidden ? "err.view" : "err.hide"); pre.setAttribute("aria-label", t("err.view"));
    labT.textContent = t("err.always"); note.textContent = t("err.alwaysNote");
  };
  let busy = false;
  const done = (key) => { lab.remove(); note.remove(); card.set(sysLz(() => ({ calm: true, text: t(key) }))); };   // set 只藏鈕與 sub,後塞進鈕列的勾選要自己拿掉
  const decide = async (action) => {
    if (busy) return;
    busy = true;
    let r = false;
    try { r = await window.blave.errReportDecide(p.id, action, action === "send" && box.checked); } catch (_) { r = false; }
    if (errLive === card) errLive = null;
    if (r !== true) { card.el.remove(); $("ta").focus(); return; }   // 主行程不認這一批(已被新卡取代、或設定改成不送):卡收掉,不說送了
    if (action === "send" && box.checked) { ERR_MODE = "auto"; errModePaint(); }
    done(action === "send" ? "err.sent" : "err.declined");
    $("ta").focus();   // 鈕都藏了,焦點不能掉到 body(同 resendState)
  };
  card.set(sysLz(() => {
    words();
    return {
      calm: true, text: p.n > 1 ? t("err.cardN", { n: p.n }) : t("err.card"),
      label: t("err.send"), on: () => decide("send"),
      second: { label: t("err.dontSend"), on: () => decide("decline") },
      sub,
    };
  }));
  const body = card.el.querySelector(".fault-body"), act = body.querySelector(".fault-act");
  body.insertBefore(body.querySelector(".fault-sub"), act);
  act.append(lab);
  act.after(note);
}
/* 卡所在的那條重畫(csPaintHistory → csClearChat)會把卡清掉,主行程今天已經問過、不會再給(設計稽核 0.1.56 第二批 S2)。
   csDraw 畫完之後叫:同一個節點接回它那條對話的最底下,不搬到別條(0.1.59);那條關掉了卡就跟著收掉。按過的(errLive 已收)不補 */
function errReattach() {
  if (!errLive || errLive.el.isConnected) return;
  const T = errLive.T || CS.cur;
  if (!T || T.dead) { errLive = null; return; }
  T.el.appendChild(errLive.el);
  if (T === CS.cur) { busyPin(); scrollChat(); }
}
window.blave.onTurnEnd((r) => setTimeout(() => errAsk(r && typeof r.sid === "string" ? r.sid : null), 1500));
setTimeout(errAsk, 4000);

/* 設定 › 隱私「錯誤回報」:每次問我／自動送／不送。跟「傳送使用資料」開關互不影響,不放進那張「會收」清單 */
const ERR_MODES = ["ask", "auto", "off"];
function errModePaint() {
  const seg = document.getElementById("err-mode"); if (!seg) return;
  seg.querySelectorAll("button").forEach((b) => { const on = b.dataset.errMode === ERR_MODE; b.setAttribute("aria-checked", on ? "true" : "false"); b.tabIndex = on ? 0 : -1; });
}
async function errModePick(m) {
  if (ERR_MODES.indexOf(m) < 0 || m === ERR_MODE) return;
  let r = null;
  try { r = await window.blave.errReportModeSet(m); } catch (_) { r = null; }
  if (r === m) { ERR_MODE = m; errModePaint(); }
}
function errPrivBlock(mk) {
  const wrap = mk("div", "err-priv");
  const row = mk("div", "set-row"), lbl = mk("span", "set-gl", t("err.priv.h")); lbl.id = "err-mode-l";
  const seg = mk("div", "set-seg"); seg.id = "err-mode"; seg.setAttribute("role", "radiogroup"); seg.setAttribute("aria-labelledby", "err-mode-l");
  for (const m of ERR_MODES) {
    const b = mk("button", "", t("err.priv." + m)); b.type = "button"; b.setAttribute("role", "radio"); b.dataset.errMode = m;
    b.setAttribute("aria-checked", m === ERR_MODE ? "true" : "false"); b.tabIndex = m === ERR_MODE ? 0 : -1;
    seg.append(b);
  }
  seg.addEventListener("click", (e) => { const b = e.target.closest("button[data-err-mode]"); if (b) errModePick(b.dataset.errMode); });
  seg.addEventListener("keydown", (e) => {   // radiogroup 的鍵盤慣例(同外觀那一格)
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const bs = [...seg.querySelectorAll("button")], i = ERR_MODES.indexOf(ERR_MODE) + (e.key === "ArrowRight" ? 1 : -1);
    if (i < 0 || i >= bs.length) return;
    errModePick(ERR_MODES[i]).then(() => bs[i].focus());
  });
  row.append(lbl, seg);
  wrap.append(row, mk("p", "priv-fine", t("err.priv.note")));
  return wrap;
}
(async () => { try { const m = await window.blave.errReportMode(); if (ERR_MODES.indexOf(m) >= 0) ERR_MODE = m; } catch (_) { /* 讀不到:當每次問我 */ } errModePaint(); })();
