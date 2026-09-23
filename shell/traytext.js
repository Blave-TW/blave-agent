// Blave 電腦版 — 視窗之外的字(選單列、結束確認框、系統通知標題)怎麼組(主行程用;設計規格 §1.5、字串表 tm.*)。
//
// 有了雲端視角之後,「暫停下單」「自動下單執行中」這些字要講清楚是哪一邊:
//   - 選單列多一行雲端的狀態;暫停只給這台電腦(雲端的暫停要用戶在雲端視角親手做)。
//   - 這台電腦在下單時按結束:雲端也在下單的話多一句「雲端的下單不受影響」。
//   - 系統通知標題第一個詞 = 哪一邊。
// 雲端那一行的資料來自雲端主機的回報——那台機器上的策略碼寫得進去的東西,進選單列之前一律當不可信輸入:
// 只取我們認得的形狀(布林、已知的 id 長相),字串過 clean()。
//
// 這個檔不 require electron。
const BAD_CHARS = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g;
function clean(s, max) {
  if (typeof s !== "string") return "";
  const out = s.replace(BAD_CHARS, " ").replace(/\s+/g, " ").trim();
  const n = max || 40;
  return out.length > n ? out.slice(0, n - 1) + "…" : out;
}
const fmt = (tpl, vars) => String(tpl || "").replace(/\{(\w+)\}/g, (_m, k) => (vars && vars[k] != null ? String(vars[k]) : ""));
const venueReady = (v) => !!(v && typeof v === "object" && v.credentials && v.pair && v.order && v.account);
const VENUE_ID = /^[a-z][a-z0-9_]{0,31}$/;   // 回報裡的場所 id 是小寫的 env 前綴;長得不像的不拿來顯示

/* 雲端宿主的 status() → 選單列那一行要的東西,或 null(沒有可講的:沒登入、沒主機、沒連交易所、讀不到)。
   回 { money: "paper" | "real", state: "on" | "paused" | "unknown" }。
   unknown = 主機在運行、有連好的帳戶,但現在讀不到新狀態(連不上 / 回報過舊):不講「執行中」也不講「已暫停」。 */
function cloudLine(st) {
  const c = st && st.cloud, r = st && st.report;
  if (!c || c.code !== "OK" || !c.machine || c.machine.state !== "running" || !r || typeof r !== "object" || !r.venues || typeof r.venues !== "object") return null;
  const ids = Object.keys(r.venues).filter((k) => VENUE_ID.test(k) && venueReady(r.venues[k])).sort();
  if (!ids.length) return null;
  const money = ids.every((k) => k === "paper") ? "paper" : "real";
  if (!st.alive) return { money, state: "unknown" };
  if (r.halt && r.halt.halted) return { money, state: "paused" };
  // 主機重開後對帳器停著、等人按「啟動下單」:同畫面一律「已暫停」(不是「不明」)
  // 主機重開、但沒能確認停住(舊對帳器沒有重開閘門、停止後又有心跳;嚴格 === false):不能說已暫停——可能仍在下單。
  // halt 排在前面先判:「重開沒停住但已按暫停」回 paused,那是真話(舊對帳器認 HALT)
  if (r.reconciler && r.reconciler.stopped && r.reconciler.stopped.reason === "machine_restart" && r.reconciler.stopped.gated === false) return { money, state: "mayTrade" };
  if (r.reconciler && r.reconciler.stopped && r.reconciler.stopped.reason === "machine_restart") return { money, state: "paused" };
  return { money, state: r.reconciler && r.reconciler.alive ? "on" : "unknown" };
}
/* 雲端落後時選單列那一行(spec v2 §1;圖示旁的小點已全部拿掉,選單是唯一的提示)。
   規則同 renderer 的 upPlan:主機在跑,而且版號落後 → 「雲端主機有新版 {nv}」;
   版號一樣、但報告說重開後沒能確認停住(gated === false,嚴格)→ 「雲端的下單程式需要更新」。其餘回 null(整行不顯示)。
   字缺一個就回 null(主行程的 tmLabels 有英文預設,實務上不會缺;renderer 一啟動雲端輪詢就會交上正確語言的字) */
function cloudUpdateLine(labels, st) {
  const c = st && st.cloud, L = labels || {};
  if (!c || c.code !== "OK" || !c.machine || c.machine.state !== "running") return null;
  if (c.config_version && c.latest_config_version && c.config_version !== c.latest_config_version) {
    return L.cloudUpdate ? fmt(L.cloudUpdate, { nv: clean(c.latest_config_version, 24) }) : null;
  }
  const x = st.report && st.report.reconciler && st.report.reconciler.stopped;
  const stale = !!(x && typeof x === "object" && x.reason === "machine_restart" && x.gated === false);
  return stale && L.cloudUpdateStale ? L.cloudUpdateStale : null;
}
/* 雲端現在是不是「確定在下單」(結束確認框要不要多那一句)。保守:不確定就不說——那一句是在替雲端做保證。 */
const cloudTrading = (st) => { const l = cloudLine(st); return !!(l && l.state === "on"); };

/* 選單列的一行字。labels 缺任何一個要用到的字 → 回 null(整行不顯示):字由 renderer 依語言交過來,
   還沒交之前不拿英文退路硬湊一行進中文選單。 */
function statusLine(tpl, line, labels) {
  if (!tpl || !line || !labels) return null;
  const money = line.money === "paper" ? labels.moneyPaper : labels.moneyReal;
  const state = line.state === "on" ? labels.stOn : line.state === "paused" ? labels.stPaused : line.state === "mayTrade" ? labels.stMayTrade : labels.stUnknown;
  if (!money || !state) return null;
  return clean(fmt(tpl, { money, state }), 80);
}
const notifTitle = (prefix, title) => (prefix ? prefix + title : title);
const quitDetail = (body, note) => (note ? body + "\n\n" + note : body);

module.exports = { clean, fmt, cloudLine, cloudTrading, cloudUpdateLine, statusLine, notifTitle, quitDetail, VENUE_ID };
