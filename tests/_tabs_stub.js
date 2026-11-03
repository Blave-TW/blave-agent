// 單分頁的測試替身(0.1.37 對話分頁):從 app.js 切片出來跑的測試沒有載 chattabs.js,這裡補上「眼前那條 = 唯一一條」的版本。
// 用法:把 SRC 接在切片的原文前面(new Function 的本體、vm.runInContext 的第一段)。要並行行為的測試另外用 check_shell_chat_tabs.js
exports.SRC = `
var CS = (typeof CS !== "undefined" && CS) || { tabs: new Map(), order: [], cur: null, loaded: null, bg: false, closed: [], main: new Map(), away: { sid: null, seq: 0 } };
function chatEl() { return $("chat-scroll"); }
function tabBg() { return false; }
function csAnyTurn() { return typeof running !== "undefined" && running === true; }
function withTab(T, fn) { return fn(); }
function tabBound(fn) { return fn; }
function csSendAway(m, o) { const p = submitMessage(m, o); CS.away = { sid: typeof sessionId !== "undefined" ? sessionId : null, seq: typeof turnSeqMine !== "undefined" ? turnSeqMine : 0 }; return p; }
function csCloudTurn() { return typeof running !== "undefined" && running === true ? (typeof sessionId !== "undefined" && sessionId) || "stub" : null; }   // 單分頁:那條在跑就當對著雲端;本機回合不擋雲端更新的行為在 check_shell_busy_relax.js 用真碼測
function csOnceLive() { return null; }
function csOnceMark() {}
function tabRun() { return typeof running !== "undefined" && running === true; }
function csAway() {}
function turnUiSync() {}
function csTabRunning() { return typeof running !== "undefined" && running === true; }
function tabsQueued() {}
function tabsTrackParallel() {}
`;
