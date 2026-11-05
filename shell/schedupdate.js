/* 每天 06:00 自動更新(spec desktop-update-pill §5.2)與閒著自動裝的判斷。純函式,不依賴 electron;main.js scheduledInstall 照它做。
   06:00 那條只在本地 06:00–06:30 判;窗外、醒來時窗已過都不補做。background = 手機對話開著、視窗收進背景:不看時間窗與鍵鼠閒置,其餘條件完全相同。
   在下單的人永遠不會被自動重開。 */
const { isBlocked } = require("./minversion");

const WINDOW_HOUR = 6, WINDOW_MIN = 30, IDLE_SEC = 600, REPORT_AHEAD_MS = 10 * 60000, HIDDEN_BOOT_MAX_MS = 15 * 60000;

const inWindow = (ms) => { const d = new Date(ms); return d.getHours() === WINDOW_HOUR && d.getMinutes() < WINDOW_MIN; };
/* reports = 狀態檔 daemon.reports(runtime 1.1.148 起);daemon 不新鮮或沒有這兩個欄位 = 不知道 → 當作有報告 */
function reportsClear(reports, now) {
  if (!reports || typeof reports !== "object" || reports.running !== false || !("next_due_at" in reports)) return false;
  if (reports.next_due_at === null) return true;
  const t = typeof reports.next_due_at === "string" ? Date.parse(reports.next_due_at) : NaN;
  return Number.isFinite(t) && t - now > REPORT_AHEAD_MS;
}
/* o:{ now, on, background, phase, version, failed, trading, turn, idleSec, dirty, uiBusy, twHeld, asking, engineBusy, reports, backtesting, optimizing, exectesting, refreshing, rerunning, closing }
   dirty / uiBusy:畫面回的值;逾時、出錯傳 null(= 有東西,不重開)。回 { go, why } */
function schedPlan(o) {
  const no = (why) => ({ go: false, why });
  if (!o.on) return no("off");
  if (!o.background && !inWindow(o.now)) return no("window");
  if (o.phase !== "ready") return no("phase");
  if (typeof o.version !== "string" || !o.version) return no("version");
  if (o.failed && o.failed === o.version) return no("failed");
  if (o.trading) return no("trading");
  if (o.turn) return no("turn");
  if (!o.background && !(o.idleSec >= IDLE_SEC)) return no("active");   // 收進背景的人知道會更新(Wei):不必等人離開
  if (o.twHeld) return no("tw_held");
  if (o.asking) return no("asking");
  if (o.engineBusy) return no("engine");
  if (!reportsClear(o.reports, o.now)) return no("report");
  if (o.backtesting) return no("backtest");
  if (o.optimizing) return no("optimize");
  if (o.exectesting) return no("exectest");
  if (o.refreshing) return no("stats");
  if (o.rerunning) return no("rerun");
  if (o.closing) return no("closing");
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
/* 這次啟動要不要藏窗。版號要等於標記:裝失敗、舊版被用戶自己打開時視窗一定要出來。上限防的是 ShipIt 沒重開、用戶隔很久才自己打開新版(看過最慢的驗章約 2 分 39 秒) */
function hiddenBoot(m, { current, now, platform }) {
  if ((platform !== "darwin" && platform !== "win32") || !m || m.v !== current || !Number.isFinite(m.at)) return false;
  const age = now - m.at;
  return age >= 0 && age < HIDDEN_BOOT_MAX_MS;
}
module.exports = { schedPlan, schedBoot, hiddenBoot, inWindow, reportsClear, IDLE_SEC, REPORT_AHEAD_MS, HIDDEN_BOOT_MAX_MS };
