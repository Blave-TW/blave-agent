/* 每天 06:00 自動更新(spec desktop-update-pill §5.2)的判斷。純函式,不依賴 electron;main.js scheduledInstall 照它做。
   只在本地 06:00–06:30 判;窗外、醒來時窗已過都不補做。在下單的人永遠不會被自動重開。 */
const { isBlocked } = require("./minversion");

const WINDOW_HOUR = 6, WINDOW_MIN = 30, IDLE_SEC = 600, REPORT_AHEAD_MS = 10 * 60000;

const inWindow = (ms) => { const d = new Date(ms); return d.getHours() === WINDOW_HOUR && d.getMinutes() < WINDOW_MIN; };
/* reports = 狀態檔 daemon.reports(runtime 1.1.148 起);daemon 不新鮮或沒有這兩個欄位 = 不知道 → 當作有報告 */
function reportsClear(reports, now) {
  if (!reports || typeof reports !== "object" || reports.running !== false || !("next_due_at" in reports)) return false;
  if (reports.next_due_at === null) return true;
  const t = typeof reports.next_due_at === "string" ? Date.parse(reports.next_due_at) : NaN;
  return Number.isFinite(t) && t - now > REPORT_AHEAD_MS;
}
/* o:{ now, on, phase, version, failed, trading, turn, idleSec, dirty, uiBusy, twHeld, asking, engineBusy, reports }
   dirty / uiBusy:畫面回的值;逾時、出錯傳 null(= 有東西,不重開)。回 { go, why } */
function schedPlan(o) {
  const no = (why) => ({ go: false, why });
  if (!o.on) return no("off");
  if (!inWindow(o.now)) return no("window");
  if (o.phase !== "ready") return no("phase");
  if (typeof o.version !== "string" || !o.version) return no("version");
  if (o.failed && o.failed === o.version) return no("failed");
  if (o.trading) return no("trading");
  if (o.turn) return no("turn");
  if (!(o.idleSec >= IDLE_SEC)) return no("active");
  if (o.twHeld) return no("tw_held");
  if (o.asking) return no("asking");
  if (o.engineBusy) return no("engine");
  if (!reportsClear(o.reports, o.now)) return no("report");
  if (o.dirty !== false) return no("draft");
  if (o.uiBusy !== false) return no("ui");
  return { go: true, why: "go" };
}
/* 啟動時:上次排程寫下的目標版號(target)與已記的失敗版號(failed)對現在的版號。
   回 { target, failed, report }:report = 這次要送 update_failed stage=install(換版失敗、第一次發現) */
function schedBoot({ current, target, failed }) {
  const behind = (v) => typeof v === "string" && !!v && isBlocked(current, v);
  if (behind(target)) return { target: null, failed: target, report: true };
  return { target: null, failed: behind(failed) ? failed : null, report: false };
}
module.exports = { schedPlan, schedBoot, inWindow, reportsClear, IDLE_SEC, REPORT_AHEAD_MS };
