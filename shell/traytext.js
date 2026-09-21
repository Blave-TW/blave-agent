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
  return { money, state: r.reconciler && r.reconciler.alive ? "on" : "unknown" };
}
/* 雲端現在是不是「確定在下單」(結束確認框要不要多那一句)。保守:不確定就不說——那一句是在替雲端做保證。 */
const cloudTrading = (st) => { const l = cloudLine(st); return !!(l && l.state === "on"); };

/* 選單列的一行字。labels 缺任何一個要用到的字 → 回 null(整行不顯示):字由 renderer 依語言交過來,
   還沒交之前不拿英文退路硬湊一行進中文選單。 */
function statusLine(tpl, line, labels) {
  if (!tpl || !line || !labels) return null;
  const money = line.money === "paper" ? labels.moneyPaper : labels.moneyReal;
  const state = line.state === "on" ? labels.stOn : line.state === "paused" ? labels.stPaused : labels.stUnknown;
  if (!money || !state) return null;
  return clean(fmt(tpl, { money, state }), 80);
}
const notifTitle = (prefix, title) => (prefix ? prefix + title : title);
const quitDetail = (body, note) => (note ? body + "\n\n" + note : body);

module.exports = { clean, fmt, cloudLine, cloudTrading, statusLine, notifTitle, quitDetail, VENUE_ID };
