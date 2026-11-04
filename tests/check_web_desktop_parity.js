// 電腦版與網頁兩個表面要同一份的常數(稽核 audit-0.1.13-web C3;成交測試的純邏輯與字串見檔尾):階段表 PHASE_OF / PHASE_NONE、設定 modal 的分類名與順序(方案 B)、
// 回測 Type C 的買進持有基準字串、回覆通知的摘錄測資／標記 regex／前綴字串,以及讀帳失敗時的帳戶幣別對照表(十個帳戶,統一期貨 president 與 Bitget 在網頁是 hidden 條目、仍要帶 ccy)。一邊改了、另一邊沒跟就紅。
// (倍數提醒門檻 LEV_T* 已隨電腦版安全檢查拿掉,Wei 10-13;不再比對)
//   電腦版:shell/renderer/trade.js 的 CX_VENUES[].ccy + TR_VENUE_CCY_OTHER
//   網頁:web/app/main/templates/agent/workspace.html 的 CX_VENUES[].ccy
// 網頁那棵用 BLAVE_WEB_DIR 指定(預設 monorepo 的 ../web);找不到就 fail,不 SKIP——不比對等於沒有這支測試。
// 側欄策略資料夾(spec strategy-sidebar-folders §10、§17)另比 api:72 個 emoji 清單與上限以 api openclaw/agent_strategies.py 為唯一來源,
// api 那棵用 BLAVE_API_DIR 指定(預設 monorepo 的 ../api),同樣找不到就 fail。
// 跑法:BLAVE_WEB_DIR=/path/to/web BLAVE_API_DIR=/path/to/api node tests/check_web_desktop_parity.js
const fs = require("fs"), path = require("path");
let red = 0; const ok = (n, c, why) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || !why ? "" : "  " + why)); if (!c) red++; };
const webDir = process.env.BLAVE_WEB_DIR || path.join(__dirname, "..", "..", "web");
const wsPath = path.join(webDir, "app", "main", "templates", "agent", "workspace.html");
if (!fs.existsSync(wsPath)) { console.log("FAIL  找不到 " + wsPath + "(設 BLAVE_WEB_DIR 指到 web)"); process.exit(1); }
const web = fs.readFileSync(wsPath, "utf8"), desk = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");
// 電腦版:CX_VENUES 的 ccy + 另外兩個帳戶
const cx = /const CX_VENUES = \{([\s\S]*?)\};/.exec(desk), other = /const TR_VENUE_CCY_OTHER = \{([^}]*)\};/.exec(desk);
const dt = {};
if (cx) for (const m of cx[1].matchAll(/(\w+): \{([^}]*)\}/g)) { const c = /ccy: "(\w+)"/.exec(m[2]); if (c) dt[m[1]] = c[1]; }
if (other) for (const m of other[1].matchAll(/(\w+): "(\w+)"/g)) dt[m[1]] = m[2];
// 網頁:CX_VENUES 陣列裡每個 { id: "…", … ccy: "…" }
const wa = web.indexOf("const CX_VENUES = ["), wb = web.indexOf("\n        ];\n", wa), wt = {};
if (wa >= 0 && wb > wa) for (const m of web.slice(wa, wb).matchAll(/\{\s*id: "(\w+)"[^{}]*?ccy: "(\w+)"/g)) wt[m[1]] = m[2];
const sorted = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
ok("幣別對照表兩邊同一份(十個帳戶)", Object.keys(dt).length === 10 && sorted(dt) === sorted(wt), sorted(dt) + " vs " + sorted(wt));
// 階段表(canon › 回合狀態列 9):電腦版 app.js 與網頁 workspace.html 的 PHASE_OF / PHASE_NONE 同一份——網頁稽核改了表,這裡就紅
const appSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8");
const phaseOf = (src) => { const m = /const PHASE_OF = \{([\s\S]*?)\};/.exec(src); const o = {}; if (m) for (const x of m[1].matchAll(/(\w+): "(\w+)"/g)) o[x[1]] = x[2]; return o; };
const phaseNone = (src) => { const m = /const PHASE_NONE = new Set\(\[([\s\S]*?)\]\);/.exec(src); return m ? [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]).sort() : null; };
const dpo = phaseOf(appSrc), wpo = phaseOf(web), dpn = phaseNone(appSrc), wpn = phaseNone(web);
ok("階段表 PHASE_OF 兩邊同一份", Object.keys(dpo).length > 10 && sorted(dpo) === sorted(wpo), sorted(dpo) + " vs " + sorted(wpo));
ok("PHASE_NONE 兩邊同一份", !!dpn && !!wpn && JSON.stringify(dpn) === JSON.stringify(wpn), JSON.stringify(dpn) + " vs " + JSON.stringify(wpn));
// 事件列文案:電腦版 trEventText 與網頁 ovEventRow 講同一件事,zh / en 逐字一致(designer events-list-audit-2026-10-20 起全部事件)
const poMap = (file) => { const o = {}; if (fs.existsSync(file)) for (const m of fs.readFileSync(file, "utf8").matchAll(/^msgid "([^"]+)"\nmsgstr ("(?:[^"\\]|\\.)*")$/gm)) o[m[1]] = JSON.parse(m[2]); return o; };
// evRestartStopFailedNote 不比:句子裡引的是各表面自己的更新鈕(電腦版「更新雲端主機」、網頁「立即更新到最新版本」)
const EV_PAIRS = {
  evExUnreachNote: "exchange_unreachable_note",
  evExUnreachTip: "exchange_unreachable_tip",
  evTargetStale: "target_stale",
  evTargetStaleNote: "target_stale_note",
  evTargetStaleMin: "target_stale_min",
  evTargetStaleHour: "target_stale_hour",
  evTargetStaleDay: "target_stale_day",
  evDeadMembers: "dead_members",
  evDeadMembersNote: "dead_members_note",
  evDeadMore: "dead_more",
  evExecOverdue: "exec_overdue",
  evExecAbandoned: "exec_abandoned",
  evExecAbandonedNote: "exec_abandoned_note",
  evRecDead: "rec_dead",
  evRecBack: "rec_back",
  evVenueUnbound: "venue_unbound",
  evVenueUnboundNote: "venue_unbound_note",
  evUiOverride: "ui_override",
  evUiOverrideNote: "ui_override_note",
  evMachineSilent: "machine_silent",
  evMachineSilentNote: "machine_silent_note",
  evMachineBack: "machine_back",
  evDiskFull: "disk_full",
  evDiskFullNote: "disk_full_note",
  evMemLow: "mem_low",
  evMemLowNote: "mem_low_note",
  evReportRejected: "report_rejected",
  evReportRejectedNote: "report_rejected_note",
  evReportDegraded: "report_degraded",
  evReportDegradedNote: "report_degraded_note",
  evReportDegradedNoteNoCount: "report_degraded_note_nocount",
  evMarketHold: "market_hold",
  evMarketHoldNote: "market_hold_note",
  evSettingsUnsafe: "settings_unsafe",
  evSettingsUnsafeNote: "settings_unsafe_note",
  evSettingsRollbackFailed: "settings_rollback_failed",
  evSettingsRollbackFailedNote: "settings_rollback_failed_note",
  evMarketCheckOff: "market_check_off",
  evMarketCheckOffNote: "market_check_off_note",
  evBarStale: "bar_stale",
  evBarStaleNote: "bar_stale_note",
  evExUnreach: "exchange_unreachable",
  evExBack: "exchange_back",
  evExecFallback: "exec_fallback",
  evExecFallbackNote: "exec_fallback_note",
  evExecInterrupted: "exec_interrupted",
  evExecInterruptedNote: "exec_interrupted_note",
  evExecStuck: "exec_stuck",
  evExecStuckNote: "exec_stuck_note",
  evSchedErr: "sched_err",
  evSchedErrNote: "sched_err_note",
  evStrategyFailed: "strategy_failed",
  evStrategyFailedNote: "strategy_failed_note",
  evRestartStopped: "restart_stopped",
  evRestartStoppedNote: "restart_stopped_note",
  evRestartStopFailed: "restart_stop_failed",
  evManualClose: "manual_close",
  evManualCloseNote: "manual_close_note",
  evHalt: "halt",
  evHaltAuto: "halt_auto",
  evHaltNote: "halt_note",
  evResume: "resume",
  evStart: "start",
  evConnected: "venue_connected",
  evDisconnected: "venue_disconnected",
  evErr: "err" };
for (const lang of ["zh", "en"]) {
  const dp = poMap(path.join(__dirname, "..", "shell", "i18n", lang + ".po")), wp = poMap(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po"));
  const diff = Object.entries(EV_PAIRS).filter(([d, w]) => !dp["tr.ov." + d] || dp["tr.ov." + d] !== wp["workspace_ov_ev_" + w]).map(([d]) => d);
  ok(`事件文案 ${lang} 兩邊逐字一致(${Object.keys(EV_PAIRS).length} 句)`, diff.length === 0, diff.join(", "));
}
// 全部平倉快照落後(manual_close_required reason snapshot_lag;api 1aed82a8 起群益、統一都走這個型別):整句與券商短名兩邊逐字同。
// 網頁這幾個 key 還沒上(同步改中):網頁沒有就只記一筆 NOTE,有了就必須逐字一致
const LAG_PAIRS = { "tr.ov.evManualCloseLag": "workspace_ov_ev_manual_close_lag", "tr.ov.brokerCapital": "workspace_ov_broker_capital",
  "tr.ov.brokerPresident": "workspace_ov_broker_president", "tr.ov.brokerOther": "workspace_ov_broker_other" };
for (const lang of ["zh", "en"]) {
  const dp = poMap(path.join(__dirname, "..", "shell", "i18n", lang + ".po")), wp = poMap(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po"));
  const absent = Object.values(LAG_PAIRS).filter((w) => typeof wp[w] !== "string");
  if (absent.length) console.log(`NOTE  全部平倉快照落後 ${lang}:網頁還沒有 ${absent.join(", ")}(同步改中;上了之後這裡會逐字比)`);
  const bad = Object.entries(LAG_PAIRS).filter(([d, w]) => typeof dp[d] !== "string" || (typeof wp[w] === "string" && dp[d].replace("{broker}", "%(broker)s") !== wp[w] && dp[d] !== wp[w]));
  ok(`全部平倉快照落後 ${lang}:電腦版有這幾句,網頁有的那幾句逐字一致(${Object.keys(LAG_PAIRS).length} 句)`, bad.length === 0, bad.map(([d, w]) => d + "「" + dp[d] + "」 vs " + w + "「" + wp[w] + "」").join(";"));
}
// 啟動下單框(mockup 03 A 版,2026-11-04;web 同框同字):標題、選項字、兩句說明、補齊怎麼下的四句、常駐句、兩顆主鈕字、「細節」兩邊逐字同(zh / en)。模擬／真錢同字,兩邊都收成一個 key
// 電腦版那一行說明(tr.stopLine)與小卡五條是本機環境的話(電腦睡眠就停…),網頁在雲端講的是主機停機,內容依環境、不比
const START_PAIRS = { "tr.start": "workspace_pf_start", "tr.opt.legend": "workspace_pf_start_group", "tr.opt.catch": "workspace_pf_opt_catch", "tr.opt.wait": "workspace_pf_opt_wait",
  "tr.opt.catchDesc": "workspace_pf_opt_catch_paper", "tr.opt.waitDesc": "workspace_pf_opt_wait_paper",
  "tr.opt.catchHow.market": "workspace_pf_catch_how_market", "tr.opt.catchHow.twap": "workspace_pf_catch_how_twap", "tr.opt.catchHow.chase": "workspace_pf_catch_how_chase", "tr.opt.catchHow.custom": "workspace_pf_catch_how_custom",
  "tr.keep.own": "workspace_pf_keep_own", "tr.keep.ownFirst": "workspace_pf_keep_own_first", "tr.keep.ownBuilt": "workspace_pf_keep_own_built", "tr.startWait": "workspace_pf_start_wait", "tr.startCatchUp": "workspace_pf_start_catch_up", "cf.more": "workspace_pf_more" };
for (const lang of ["zh", "en"]) {
  const dp = poMap(path.join(__dirname, "..", "shell", "i18n", lang + ".po")), wp = poMap(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po"));
  const bad = Object.entries(START_PAIRS).filter(([d, w]) => typeof dp[d] !== "string" || dp[d] !== wp[w]);
  ok(`啟動下單框 ${lang} 兩邊逐字一致(${Object.keys(START_PAIRS).length} 句)`, bad.length === 0, bad.map(([d, w]) => d + "「" + dp[d] + "」 vs " + w + "「" + wp[w] + "」").join(";"));
}
// 模擬帳戶總權益氣泡接的第二句:兩邊逐字同;網頁 en 把接句的空白放在字串開頭(電腦版接的時候才加),所以先 trim。任一邊沒有這個 key 也算紅
const PAPER_TIP_PAIRS = { "cx.perfNote": "workspace_ov_equity_tip_paper" };
for (const lang of ["zh", "en"]) {
  const dp = poMap(path.join(__dirname, "..", "shell", "i18n", lang + ".po")), wp = poMap(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po"));
  const bad = Object.entries(PAPER_TIP_PAIRS).filter(([d, w]) => typeof dp[d] !== "string" || typeof wp[w] !== "string" || dp[d].trim() !== wp[w].trim());
  ok(`模擬總權益氣泡第二句 ${lang} 兩邊逐字一致`, bad.length === 0, bad.map(([d, w]) => d + "「" + dp[d] + "」 vs " + w + "「" + wp[w] + "」").join(";"));
}
// Bitget 換帳戶類型:對不上的暫停句與清單(halt.mismatch)、事件列兩型(venue_mode_switched／venue_stops_missing)——zh / en 逐字一致,
// 任一邊找不到這個 key 也算紅(稽核 v033-integ 第二輪 R2-P3-3)
const BITGET_PAIRS = {
  "tr.haltBitgetMismatchUta": "workspace_pf_halt_bitget_mm_uta", "tr.haltBitgetMismatchClassic": "workspace_pf_halt_bitget_mm_classic",
  "tr.mm.colSym": "workspace_pf_mm_col_sym", "tr.mm.colBefore": "workspace_pf_mm_col_before", "tr.mm.colNow": "workspace_pf_mm_col_now",
  "tr.mm.none": "workspace_pf_mm_none", "tr.mm.foot": "workspace_pf_mm_foot",
  "tr.ov.evBitgetUta": "workspace_ov_ev_bitget_uta", "tr.ov.evBitgetClassic": "workspace_ov_ev_bitget_classic",
  "tr.ov.evBitgetNoStopUta": "workspace_ov_ev_bitget_nostop_uta", "tr.ov.evBitgetNoStopClassic": "workspace_ov_ev_bitget_nostop_classic",
  "tr.ov.evBitgetStopsUnreadUta": "workspace_ov_ev_bitget_stops_unread_uta", "tr.ov.evBitgetStopsUnreadClassic": "workspace_ov_ev_bitget_stops_unread_classic",
  "tr.ov.evBitgetNoStopNote": "workspace_ov_ev_bitget_nostop_note", "tr.ov.evBitgetStopsUnknown": "workspace_ov_ev_bitget_stops_unknown",
  // 連接框被拒存時的 Bitget 跟單／帶單帳戶金鑰(40731;web a516e865c)
  "cx.err.bitgetCopyKey": "workspace_cx_err_bitget_copy_key" };
for (const lang of ["zh", "en"]) {
  const dp = poMap(path.join(__dirname, "..", "shell", "i18n", lang + ".po")), wp = poMap(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po"));
  const bad = Object.entries(BITGET_PAIRS).filter(([d, w]) => typeof dp[d] !== "string" || typeof wp[w] !== "string" || dp[d] !== wp[w]);
  ok(`Bitget 換帳戶類型的暫停句／清單／事件列 ${lang} 兩邊逐字一致(${Object.keys(BITGET_PAIRS).length} 句)`, bad.length === 0,
    bad.map(([d, w]) => d + "「" + dp[d] + "」 vs " + w + "「" + wp[w] + "」").join(";"));
}
// 下單結果不明(canon notifications §3 order_unconfirmed)與兩型事件的策略段:zh / en 逐字一致,任一邊找不到也算紅
const UNCONFIRMED_PAIRS = {
  "tr.err.unconfirmed": "workspace_pf_err_unconfirmed", "tr.ov.evUnconfirmed": "workspace_ov_ev_unconfirmed",
  "tr.ov.evUnconfirmedStuck": "workspace_ov_ev_unconfirmed_stuck", "tr.ov.evUnconfirmedNote": "workspace_ov_ev_unconfirmed_note",
  "tr.ov.evUnconfirmedStuckNote": "workspace_ov_ev_unconfirmed_stuck_note",
  "tr.ov.evStratOne": "workspace_ov_ev_strat_one", "tr.ov.evStratTwo": "workspace_ov_ev_strat_two", "tr.ov.evStratMany": "workspace_ov_ev_strat_many",
  // 停車解除後(released／filled)與追蹤不了而整台暫停([order_unconfirmed_unparked])
  "tr.ov.evUnconfirmedReleased": "workspace_ov_ev_unconfirmed_released",
  "tr.ov.evUnconfirmedReleasedFilled": "workspace_ov_ev_unconfirmed_released_filled",
  "tr.ov.evUnconfirmedReleasedNone": "workspace_ov_ev_unconfirmed_released_none",
  "tr.ov.evHaltUnconfirmedNote": "workspace_ov_ev_halt_unconfirmed_note", "tr.haltUnconfirmed": "workspace_pf_halt_unconfirmed",
  // designer v034 UX 定稿:沒有標的的退路、全部平倉沒平到那一型與它的收尾、manual 停車部位表那句
  "tr.ov.evHaltUnconfirmedNoteNosym": "workspace_ov_ev_halt_unconfirmed_note_nosym",
  "tr.ov.evUnconfirmedCloseAll": "workspace_ov_ev_unconfirmed_close_all",
  "tr.ov.evUnconfirmedCloseAllNote": "workspace_ov_ev_unconfirmed_close_all_note",
  "tr.ov.evUnconfirmedReleasedCloseAllFilled": "workspace_ov_ev_unconfirmed_released_close_all_filled",
  "tr.ov.evUnconfirmedReleasedCloseAllNone": "workspace_ov_ev_unconfirmed_released_close_all_none",
  "tr.ov.evUnconfirmedInterruptedNote": "workspace_ov_ev_unconfirmed_interrupted_note",
  "tr.err.unconfirmedManual": "workspace_pf_err_unconfirmed_manual",
  "tr.haltUnconfirmedNosym": "workspace_pf_halt_unconfirmed_nosym" };
for (const lang of ["zh", "en"]) {
  const dp = poMap(path.join(__dirname, "..", "shell", "i18n", lang + ".po")), wp = poMap(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po"));
  const bad = Object.entries(UNCONFIRMED_PAIRS).filter(([d, w]) => typeof dp[d] !== "string" || typeof wp[w] !== "string" || dp[d] !== wp[w]);
  ok(`下單結果不明與策略段 ${lang} 兩邊逐字一致(${Object.keys(UNCONFIRMED_PAIRS).length} 句)`, bad.length === 0,
    bad.map(([d, w]) => d + "「" + dp[d] + "」 vs " + w + "「" + wp[w] + "」").join(";"));
}
// 交易歷史的成交狀態(runtime fill_state;designer order-history-fill-state-2026-10-28 §2):電腦版 trPaintHist 與網頁 buildOrderLogSection
const FILL_PAIRS = { "tr.fillUnconfirmed": "workspace_pf_fill_unconfirmed", "tr.fillUnconfirmedTip": "workspace_pf_fill_unconfirmed_tip",
  "tr.fillNone": "workspace_pf_fill_none", "tr.pxUnreported": "workspace_pf_px_unreported" };
for (const lang of ["zh", "en"]) {
  const dp = poMap(path.join(__dirname, "..", "shell", "i18n", lang + ".po")), wp = poMap(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po"));
  const bad = Object.entries(FILL_PAIRS).filter(([d, w]) => typeof dp[d] !== "string" || typeof wp[w] !== "string" || dp[d] !== wp[w]);
  ok(`交易歷史成交狀態 ${lang} 兩邊逐字一致(${Object.keys(FILL_PAIRS).length} 句)`, bad.length === 0,
    bad.map(([d, w]) => d + "「" + dp[d] + "」 vs " + w + "「" + wp[w] + "」").join(";"));
}
// 手機對話(mchat-phone-surfaces-2026-10-31 §5):手機送的那句下面的「來自手機」,電腦版 addHistoryYou 與網頁工作頁同一句
for (const lang of ["zh", "en"]) {
  const dp = poMap(path.join(__dirname, "..", "shell", "i18n", lang + ".po")), wp = poMap(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po"));
  ok(`「來自手機」${lang} 兩邊逐字一致(chat.fromPhone ↔ workspace_cs_from_phone)`, typeof dp["chat.fromPhone"] === "string" && dp["chat.fromPhone"] === wp.workspace_cs_from_phone,
    "chat.fromPhone「" + dp["chat.fromPhone"] + "」 vs workspace_cs_from_phone「" + wp.workspace_cs_from_phone + "」");
}
// 對話分頁(0.1.37;技術方案 §1.4、§4):對著雲端主機、名額滿了的排隊行與〔取消排隊〕,電腦版 chattabs.js tabsQueued 與網頁 csShowQueued 同一句;
// 歷史清單的狀態字(回覆中／排隊中／做完，還沒看)與分組(今天／昨天／更早)也跟網頁 workspace_cs_* 同一組
const TAB_PAIRS = { "tabs.queue": "workspace_cs_queue_line", "tabs.queueCancel": "workspace_cs_cancel_queued", "tabs.queueCancelTitle": "workspace_cs_cancel_queued_title", "tabs.st.queued": "workspace_cs_queued",
  "tabs.st.unseen": "workspace_cs_unread", "tabs.group.today": "workspace_cs_today", "tabs.group.yesterday": "workspace_cs_yesterday", "tabs.group.earlier": "workspace_cs_earlier",
  "tabs.search": "workspace_cs_search_ph" };
for (const lang of ["zh", "en"]) {
  const dp = poMap(path.join(__dirname, "..", "shell", "i18n", lang + ".po")), wp = poMap(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po"));
  const bad = Object.entries(TAB_PAIRS).filter(([d, w]) => typeof dp[d] !== "string" || typeof wp[w] !== "string" || dp[d] !== wp[w]);
  ok(`對話分頁的排隊行與狀態字 ${lang} 兩邊逐字一致(${Object.keys(TAB_PAIRS).length} 句)`, bad.length === 0,
    bad.map(([d, w]) => d + "「" + dp[d] + "」 vs " + w + "「" + wp[w] + "」").join(";"));
}
{ const ctS = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "chattabs.js"), "utf8"), appS = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8");
  ok("排隊行同 web csShowQueued:一行 tabs.queue、行內不放鈕;取消靠送出鍵(排隊時 aria-label tabs.queueCancel、title tabs.queueCancelTitle,同 web sendBtnSync)",
    /q\.textContent = t\("tabs\.queue"\);/.test(ctS) && !/tabs\.queueCancel/.test(ctS.slice(ctS.indexOf("function tabsQueued("), ctS.indexOf("function tabsTrackParallel(")))
    && /b\.dataset\.i18nAria = queued \? "tabs\.queueCancel" : running \? "ws\.stop" : "ws\.send";/.test(appS) && /if \(queued\) b\.title = t\("tabs\.queueCancelTitle"\); else b\.removeAttribute\("title"\);/.test(appS)); }
// 事件型別集合(cross-surface-parity 規則三:列舉,不只靠上面手寫的配對表):電腦版 trEventText ∪ trOvEvents 認得的型別,
// 跟網頁 ovEventRow 認得的同一組。order_error / order_unconfirmed 在電腦版從 order_errors[] 那列畫(trOvEvents 讀 e.kind),
// 不走 `type ===`;只在電腦版的三個是這台電腦自己的指令回音與舊型別(halt_close／resume_wait 是本機指令、downtime_paused 已被
// machine_restart_stopped 取代,網頁從沒畫過)。新型別只出現在一邊就紅。
{ const seg = (src, a, b) => { const i = src.indexOf(a); return i < 0 ? "" : src.slice(i, src.indexOf(b, i + 1)); };
  const types = (src) => new Set([...src.matchAll(/type === "([a-z_]+)"/g)].map((m) => m[1]));
  const dSet = new Set([...types(seg(desk, "function trEventText(", "\nfunction ")), ...types(seg(desk, "function trOvEvents(", "\nfunction "))]);
  const rows = seg(desk, "function trOvEvents(", "\nfunction ");
  if (/r\.order_errors/.test(rows)) dSet.add("order_error");
  if (/e\.kind === "order_unconfirmed"/.test(rows)) dSet.add("order_unconfirmed");
  if (/e\.released === true/.test(rows)) dSet.add("order_unconfirmed_released");   // 同一列 released 時畫成灰字;網頁畫平台的 P3 事件
  const wSet = types(seg(web, "function ovEventRow(", "\n        function "));
  const DESK_ONLY = new Set(["halt_close", "resume_wait", "downtime_paused"]);
  const onlyD = [...dSet].filter((x) => !wSet.has(x) && !DESK_ONLY.has(x)), onlyW = [...wSet].filter((x) => !dSet.has(x));
  ok(`事件型別集合兩邊一致(電腦版 ${dSet.size}、網頁 ${wSet.size})`, wSet.size > 20 && !onlyD.length && !onlyW.length,
    "只在電腦版:" + onlyD.join(",") + " 只在網頁:" + onlyW.join(",")); }
// Type C 的買進持有基準(0050／BTC／SPY,{sym} 由各表面代入):統計列標籤／圖例、三句 tooltip、圖的 aria——zh / en 兩邊逐字同一份
const poRaw = (file) => { const o = {}; if (fs.existsSync(file)) for (const m of fs.readFileSync(file, "utf8").matchAll(/^msgid "([^"]+)"\nmsgstr "((?:[^"\\]|\\.)*)"$/gm)) o[m[1]] = m[2]; return o; };
const BH_KEYS = { workspace_bt_benchmark_bh: "bt.benchmarkBh", workspace_bt_benchmark_bh_tip_adj: "bt.tip.benchmarkBhAdj",
  workspace_bt_benchmark_bh_tip_raw: "bt.tip.benchmarkBhRaw", workspace_bt_benchmark_bh_na: "bt.tip.benchmarkBhNa",
  workspace_bt_chart_aria_bh: "bt.chartAriaBh" };
for (const lang of ["zh", "en"]) {
  const w = poRaw(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po"));
  const d = poRaw(path.join(__dirname, "..", "shell", "i18n", lang + ".po"));
  const off = Object.keys(BH_KEYS).filter((k) => !w[k] || w[k] !== d[BH_KEYS[k]]);
  ok("買進持有基準五個字串兩邊同一份(" + lang + ")", off.length === 0, off.map((k) => k + ": " + w[k] + " vs " + d[BH_KEYS[k]]).join(";"));
}
// 回覆通知(spec agent-reply-notifications-0130):摘錄測資、四條標記 regex 與長度上限、前綴／空摘錄五句、回合中轉出鈕的原因句
//   電腦版:tests/check_shell_reply_snippet.js 的 CASES、renderer/app.js、shell/i18n/*.po
//   網頁:tests/reply_cue_vectors.json 的 snippet_desktop、app/static/js/agent/reply_cue.js、messages.po
{ const vecPath = path.join(webDir, "tests", "reply_cue_vectors.json"), rcPath = path.join(webDir, "app", "static", "js", "agent", "reply_cue.js");
  const snipSrc = fs.readFileSync(path.join(__dirname, "check_shell_reply_snippet.js"), "utf8");
  const zDef = (snipSrc.match(/^const Z = .*;$/m) || [""])[0], casesDef = (snipSrc.match(/^const CASES = \[[\s\S]*?^\];$/m) || [""])[0];
  const cases = zDef && casesDef ? new Function(zDef + "\n" + casesDef + "\nreturn CASES;")() : [];
  const vec = fs.existsSync(vecPath) ? JSON.parse(fs.readFileSync(vecPath, "utf8")).snippet_desktop || [] : [];
  const norm = (a) => JSON.stringify(a.map((c) => Array.isArray(c) ? [c[0], c[1] == null ? null : c[1], c[2]] : [c.name, c.in == null ? null : c.in, c.expect]));
  ok("回覆摘錄測資:電腦版 CASES 與網頁 snippet_desktop 逐項相同", cases.length > 20 && norm(cases) === norm(vec), cases.length + " vs " + vec.length);
  const rc = fs.existsSync(rcPath) ? fs.readFileSync(rcPath, "utf8") : "";
  // 電腦版 CARD_TAG 多包一層捕獲組(卡片名另有用途),網頁沒有:比對前拆掉後面不接量詞的捕獲組——比的是「吃掉哪些字」
  const re = (src, kw, name) => { const m = src.match(new RegExp("^\\s*" + kw + " " + name + " = (/.*/[a-z]*);\\s*(?://.*)?$", "m")); return m ? m[1].replace(/(^|[^\\])\(([^()?][^()]*)\)(?![*+?{])/g, "$1$2") : null; };
  const tags = ["CARD_TAG", "SUG_BLOCK", "SUG_OPEN_TAIL", "AWAIT_TAG", "FORM_TAG"], off = tags.filter((n) => !re(appSrc, "const", n) || re(appSrc, "const", n) !== re(rc, "var", n));
  ok("回覆摘錄的五條標記 regex 兩邊同一份(FORM_TAG 是 0.1.41 澄清表單)", off.length === 0, off.map((n) => n + ": " + re(appSrc, "const", n) + " vs " + re(rc, "var", n)).join(";"));
  // 回覆音 04 Rise(canon › Sound):兩音表、主增益、2 秒窗,兩邊逐值一致。網頁 var、電腦版 const,各自 eval 成值再比
  const num = (src, kw, n) => { const m = src.match(new RegExp("^\\s*" + kw + " " + n + " = ([\\s\\S]*?);", "m")); try { return m ? JSON.stringify(new Function("return " + m[1])()) : null; } catch (_) { return null; } };
  const rise = ["RISE", "RISE_GAIN", "SOUND_GAP_MS"].filter((n) => num(appSrc, "const", n) === null || num(appSrc, "const", n) !== num(rc, "var", n));
  ok("回覆音 RISE／RISE_GAIN／SOUND_GAP_MS 兩邊同一份", rise.length === 0 && JSON.parse(num(appSrc, "const", "RISE") || "[]").length === 2, rise.map((n) => n + ": " + num(appSrc, "const", n) + " vs " + num(rc, "var", n)).join(";"));
  const dMax = (appSrc.match(/^const RS_MAX = (\d+);$/m) || [])[1], wMax = (rc.match(/^\s*var MAX = (\d+);$/m) || [])[1];
  ok("回覆摘錄長度上限兩邊同一份", !!dMax && dMax === wMax, dMax + " vs " + wMax);
  const RC_KEYS = { workspace_rn_pre_await: "rc.await", workspace_rn_pre_fail: "rc.fail", workspace_rn_empty_done: "rc.doneEmpty",
    workspace_rn_empty_await: "rc.awaitEmpty", workspace_rn_empty_fail: "rc.failEmpty", workspace_busy_xp: "xp.why.busy" };
  for (const lang of ["zh", "en"]) {
    const w = poRaw(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po")), d = poRaw(path.join(__dirname, "..", "shell", "i18n", lang + ".po"));
    const bad = Object.keys(RC_KEYS).filter((k) => !w[k] || w[k] !== d[RC_KEYS[k]]);
    ok("通知前綴／空摘錄五句與回合中轉出原因句兩邊同一份(" + lang + ")", bad.length === 0, bad.map((k) => k + ": " + w[k] + " vs " + d[RC_KEYS[k]]).join(";"));
  } }
// 優化分頁〔套用金額〕停用時的原因句(C 案):zh / en 兩邊逐字一致(設計稽核 v030 S3)
{ const MG_KEYS = { workspace_mg_prop_other_alloc: "mg.propOtherAlloc" };
  for (const lang of ["zh", "en"]) {
    const w = poRaw(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po")), d = poRaw(path.join(__dirname, "..", "shell", "i18n", lang + ".po"));
    const bad = Object.keys(MG_KEYS).filter((k) => !w[k] || w[k] !== d[MG_KEYS[k]]);
    ok("優化分頁套用停用原因句兩邊同一份(" + lang + ")", bad.length === 0, bad.map((k) => k + ": " + w[k] + " vs " + d[MG_KEYS[k]]).join(";"));
  } }
// 串接失敗講怎麼改的句子(OKX 帳戶模式):兩邊逐字一致。Bitget 統一帳戶已開放,web 拿掉了「還不支援」那幾句,不再比
{ const CX_KEYS = { workspace_pf_err_okx_mode: "cx.err.okxMode" };
  for (const lang of ["zh", "en"]) {
    const w = poRaw(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po")), d = poRaw(path.join(__dirname, "..", "shell", "i18n", lang + ".po"));
    const bad = Object.keys(CX_KEYS).filter((k) => !w[k] || w[k] !== d[CX_KEYS[k]]);
    ok("串接失敗講怎麼改的句子兩邊同一份(" + lang + ")", bad.length === 0, bad.map((k) => k + ": " + w[k] + " vs " + d[CX_KEYS[k]]).join(";"));
  } }
// 建議下一步的設定開關 label／tooltip、托盤讀屏句與 × 可及名稱:zh / en 兩邊逐字一致(設計稽核 v031 M1;spec suggest-tray §2.4)
{ const SUG_KEYS = { workspace_sug_pref: "set.sug", workspace_sug_pref_tip: "set.sug.tip", workspace_sug_live: "ws.sugSay", workspace_sug_dismiss: "ws.sugDismiss" };
  for (const lang of ["zh", "en"]) {
    const w = poRaw(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po")), d = poRaw(path.join(__dirname, "..", "shell", "i18n", lang + ".po"));
    const bad = Object.keys(SUG_KEYS).filter((k) => !w[k] || w[k] !== d[SUG_KEYS[k]]);
    ok("建議下一步設定開關與托盤的字兩邊同一份(" + lang + ")", bad.length === 0, bad.map((k) => k + ": " + w[k] + " vs " + d[SUG_KEYS[k]]).join(";"));
  } }
// 建議下一步 v2(spec suggest-next-step-v2 §0;托盤版 suggest-tray-2026-10-26 拿掉鍵帽與 ws_sug_tab):取句長度上限、減少門檻、導航句首、兩個 localStorage 鍵,兩邊同名同值。
// 比原文(去空白、單引號當雙引號),同網頁 tests/check_suggest_v2.js §9;任一邊找不到就紅
{ const SUG_CONSTS = ["SUG_MAX_CHARS", "SUG_MISS_LIMIT", "SUG_NAV_PREFIXES", "SUG_KEY_ON", "SUG_KEY_MISS"];
  const sugSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "suggest.js"), "utf8");
  const val = (src, n) => { const m = src.match(new RegExp("^\\s*const " + n + " = (.+?);\\s*(//.*)?$", "m")); return m ? m[1].replace(/'/g, '"').replace(/\s+/g, "") : null; };
  const bad = SUG_CONSTS.filter((n) => val(sugSrc, n) === null || val(sugSrc, n) !== val(web, n));
  ok("建議下一步五個常數兩邊同一份(" + SUG_CONSTS.join(", ") + ")", bad.length === 0, bad.map((n) => n + ": " + val(sugSrc, n) + " vs " + val(web, n)).join(";")); }
// 聊天裡的澄清表單(spec agent-clarify-form-2026-10-31 §2.4、§6、§7.4):FORM_IDS／FORM_MAX_* 四個常數兩邊同名同值(比原文,同上),
// form.* 字串 zh / en 逐字一致(網頁 msgid = "workspace_" + 電腦版 key 把 . 換成 _,同 workspace_sug_live 那組的慣例)。
// form.note.* 只在電腦版:資料那一句只在這台拿不到 Blave 資料時出,雲端一定有資料、網頁永遠不畫(spec §3)
{ const FORM_CONSTS = ["FORM_IDS", "FORM_MAX_QUESTIONS", "FORM_MAX_OPTIONS", "FORM_MAX_SENTENCE_CHARS"];
  const fp = path.join(__dirname, "..", "shell", "renderer", "form.js"), formSrc = fs.existsSync(fp) ? fs.readFileSync(fp, "utf8") : "";
  const val = (src, n) => { const m = src.match(new RegExp("^\\s*const " + n + " = (.+?);\\s*(//.*)?$", "m")); return m ? m[1].replace(/'/g, '"').replace(/\s+/g, "") : null; };
  const bad = FORM_CONSTS.filter((n) => val(formSrc, n) === null || val(formSrc, n) !== val(web, n));
  ok("澄清表單四個常數兩邊同一份(" + FORM_CONSTS.join(", ") + ")", bad.length === 0, bad.map((n) => n + ": " + val(formSrc, n) + " vs " + val(web, n)).join(";"));
  for (const lang of ["zh", "en"]) {
    const w = poRaw(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po")), d = poRaw(path.join(__dirname, "..", "shell", "i18n", lang + ".po"));
    const keys = Object.keys(d).filter((k) => k.startsWith("form.") && !k.startsWith("form.note.")), wk = (k) => "workspace_" + k.replace(/\./g, "_");
    const off = keys.filter((k) => w[wk(k)] !== d[k]);
    ok("澄清表單 form.* 字串兩邊逐字一致(" + lang + "," + keys.length + " 句;form.note.* 只在電腦版)", keys.length === 22 && off.length === 0, off.map((k) => k + "「" + d[k] + "」 vs " + wk(k) + "「" + w[wk(k)] + "」").join(";"));
  } }
// 設定 modal 方案 B(spec settings-modal-b-2026-10-24 §4.2):web 的「一般／Agent／連結」三類是電腦版的子集合——分類名與這三類裡的字 zh / en 逐字一致,
// web #set_cats 的分類順序是電腦版 #set-cats 順序的子序列(相對順序相同)
{ const SETTINGS_PAIRS = { "set.cat.display": "workspace_set_cat_display", "set.cat.rules": "workspace_set_cat_rules", "set.cat.connect": "workspace_set_cat_connect",
    "set.theme": "workspace_set_theme", "set.lang": "workspace_set_lang", "set.ccy": "workspace_set_base_ccy", "set.rn": "workspace_rn_notify", "set.rs": "workspace_rn_sound",
    "rlang.label": "workspace_reply_lang", "rules.head": "workspace_rules_head", "rules.add": "workspace_rules_add",
    "rules.emptyLead": "workspace_rules_empty_lead" };
  for (const lang of ["zh", "en"]) {
    const d = poMap(path.join(__dirname, "..", "shell", "i18n", lang + ".po")), w = poMap(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po"));
    const bad = Object.entries(SETTINGS_PAIRS).filter(([dk, wk]) => !d[dk] || d[dk] !== w[wk]);
    ok("設定 modal 分類名與一般／Agent／連結裡的字兩邊逐字一致(" + lang + "," + Object.keys(SETTINGS_PAIRS).length + " 組)", bad.length === 0, bad.map(([dk, wk]) => dk + "「" + d[dk] + "」 vs " + wk + "「" + w[wk] + "」").join(";"));
    ok("規則空狀態的「在對話裡說…」兩邊都刪了(rules.emptyHow / workspace_rules_empty_how," + lang + ")", !("rules.emptyHow" in d) && !("workspace_rules_empty_how" in w));
  }
  const html = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "index.html"), "utf8");
  const catsOf = (src, id) => { const a = src.indexOf('id="' + id + '"'), b = src.indexOf("</nav>", a); return a < 0 || b < 0 ? [] : [...src.slice(a, b).matchAll(/<button[^>]*\bdata-set-cat="([a-z]+)"/g)].map((m) => m[1]); };
  const dc = catsOf(html, "set-cats"), wc = catsOf(web, "set_cats");
  let i = 0; for (const c of dc) if (c === wc[i]) i++;
  ok("web 設定分類(" + wc.join(",") + ")是電腦版(" + dc.join(",") + ")的子序列", dc.length === 7 && wc.length > 0 && i === wc.length); }
// 成交測試分頁(spec lag-test-tab-2026-10-26 §4、§6):挑數字的純邏輯(門檻常數 XT_TH、k 與成本檔位、判讀選句、y 軸範圍、歸零位置)兩邊逐字同一份——
// 切兩邊「成交測試純邏輯(」那一行到「成交測試純邏輯 end」之間,去掉行首縮排比;分頁名、判讀模板、交易太少句、成本段標題列等全部 xt 字串 zh / en 逐字一致
// (web 的 %% 是 Jinja 轉義,畫面上是 %,比之前還原);分頁位置兩邊都是 樣本外驗證 → 成交測試 → 程式碼
{ const xtSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "report-xt.js"), "utf8");
  const pure = (src) => { const a = src.search(/^[ \t]*\/\/ ---- 成交測試純邏輯\(/m), b = src.search(/^[ \t]*\/\/ ---- 成交測試純邏輯 end ----/m);
    if (a < 0 || b < a) return null; const body = src.slice(src.indexOf("\n", a) + 1, b); return body.split("\n").map((l) => l.trim()).filter(Boolean).join("\n"); };
  const dp = pure(xtSrc), wpu = pure(web);
  ok("成交測試純邏輯兩邊逐字同一份(門檻、檔位、選句、y 軸、歸零位置)", !!dp && dp.length > 2000 && dp === wpu, dp && wpu ? "第一個不同的行:" + (dp.split("\n").find((l, i) => l !== wpu.split("\n")[i]) || "(長度不同)") : "找不到標記行");
  const XT_PAIRS = { "rp.tab.xt": "workspace_tab_xt", "xt.verdict": "workspace_xt_verdict", "xt.lagFlat": "workspace_xt_lag_flat", "xt.lagOne": "workspace_xt_lag_one",
    "xt.lagOneFive": "workspace_xt_lag_one_five", "xt.lagMixed": "workspace_xt_lag_mixed", "xt.lagLow": "workspace_xt_lag_low", "xt.up": "workspace_xt_up", "xt.down": "workspace_xt_down",
    "xt.costDown": "workspace_xt_cost_down", "xt.costTo": "workspace_xt_cost_to", "xt.few": "workspace_xt_few", "xt.lagH": "workspace_xt_lag_h", "xt.lagSub": "workspace_xt_lag_sub",
    "xt.unit.m": "workspace_xt_unit_min", "xt.unit.h": "workspace_xt_unit_hour", "xt.unit.d": "workspace_xt_unit_day", "xt.unit.td": "workspace_xt_unit_tday", "xt.unit.w": "workspace_xt_unit_week",
    "xt.lagLbl": "workspace_xt_lag_lbl", "xt.colLag": "workspace_xt_col_lag", "xt.cur": "workspace_xt_cur", "xt.m.sharpe": "workspace_xt_m_sharpe", "xt.m.ann": "workspace_xt_m_ann",
    "xt.m.mdd": "workspace_xt_m_mdd", "xt.closeAte": "workspace_xt_close_ate", "xt.closeGain": "workspace_xt_close_gain", "xt.lagHow": "workspace_xt_lag_how", "xt.costH": "workspace_xt_cost_h",
    "xt.costSub": "workspace_xt_cost_sub", "xt.costLbl": "workspace_xt_cost_lbl", "xt.colCost": "workspace_xt_col_cost", "xt.free": "workspace_xt_free", "xt.freeAx": "workspace_xt_free_ax",
    "xt.perSide": "workspace_xt_per_side", "xt.beK": "workspace_xt_be_k", "xt.beLine": "workspace_xt_be_line", "xt.beOut": "workspace_xt_be_out", "xt.clip": "workspace_xt_clip",
    "xt.costHow": "workspace_xt_cost_how", "xt.fogOld": "workspace_xt_fog_old", "xt.behind": "workspace_xt_behind", "xt.updFail": "workspace_xt_upd_fail",
    // 按了才算(spec §3.6,10-27):鈕、過時句、BUSY 那行;還原後重跑中那句是掃描／驗證／成交測試共用的
    "xt.btnRun": "workspace_xt_btn_run", "xt.btnRerun": "workspace_xt_btn_rerun", "xt.btnBusy": "workspace_xt_btn_busy", "xt.btnTip": "workspace_xt_btn_tip",
    "xt.verdictStale": "workspace_xt_verdict_stale", "xt.busyRefresh": "workspace_xt_busy_refresh",
    "ver.frozenRerun": "workspace_ver_frozen_rerun",
    // 轉出鈕跟成交測試分頁在同一列、同一次為 1280 放得下改字(desktop-tabs-1280 §5),一起比
    "xp.btn": "workspace_xp_btn" };
  for (const lang of ["zh", "en"]) {
    const d = poMap(path.join(__dirname, "..", "shell", "i18n", lang + ".po")), w = poMap(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po"));
    const bad = Object.entries(XT_PAIRS).filter(([dk, wk]) => typeof d[dk] !== "string" || typeof w[wk] !== "string" || d[dk] !== w[wk].replace(/%%/g, "%"));
    ok("成交測試的字兩邊逐字一致(" + lang + "," + Object.keys(XT_PAIRS).length + " 句)", bad.length === 0, bad.map(([dk, wk]) => dk + "「" + d[dk] + "」 vs " + wk + "「" + w[wk] + "」").join(";"));
  }
  const html = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "index.html"), "utf8");
  const order = (src, re) => [...src.matchAll(re)].map((m) => m[1]).filter((k) => k === "wf" || k === "xt" || k === "code").join(",");
  // 畫面狀態(§3.5 兩層):xtPageOf(整頁)／xtCellOf(鈕那一格)在上面的純邏輯段裡逐字比過;這裡另把兩邊各自切出來的那段跑同一組情境,結果要一樣
  const stateFns = (src) => { try { const p = pure(src); return p ? new Function(p + "\nreturn { page: xtPageOf, cell: xtCellOf };")() : null; } catch (e) { return null; } };
  const dS = stateFns(xtSrc), wS = stateFns(web);
  const X0 = { lag: { "0": [1.2, 10, -10] } };
  const CASES = [["page", { verActive: true, x: X0 }, 1], ["page", { restoring: true }, 2], ["page", { x: null }, 4], ["page", { x: X0, sharpe: 1.2 }, 6], ["page", { x: X0, sharpe: 1.21 }, 7],
    ["page", { cfg: false, perf: "running", mine: "run", x: X0, sharpe: 1.2 }, 6],
    ["cell", { cfg: false, perf: "running" }, 3], ["cell", { cfg: null }, 3], ["cell", { cfg: true, perf: "running", mine: "run" }, 5], ["cell", { cfg: true, perf: "running", mine: "busy" }, 5],
    ["cell", { cfg: true, perf: "failed", mine: "fail" }, 8], ["cell", { cfg: true, perf: "failed", mine: "busy" }, 0], ["cell", { cfg: true, perf: "failed", mine: null }, 0],
    ["cell", { cfg: true }, 0]];
  const badS = CASES.filter(([k, i, want]) => !dS || !wS || dS[k](i) !== want || wS[k](i) !== want).map(([k, i, want]) => k + JSON.stringify(i) + "→" + want + " 電腦版 " + (dS && dS[k](i)) + " web " + (wS && wS[k](i)));
  ok("成交測試畫面狀態兩邊同一組情境同一個答案(" + CASES.length + " 組)", badS.length === 0, badS.join(";"));
  ok("成交測試分頁位置兩邊同一處(樣本外驗證 → 成交測試 → 程式碼)", order(html, /class="rp-tab"[^>]*data-tab="(\w+)"/g) === "wf,xt,code" && order(web, /class="main-tab"[\s\S]*?data-tab="(\w+)"/g) === "wf,xt,code"); }
// 歡迎頁①策略卡挑哪三張:電腦版 library.js 的 wcReco(雲端視角)與網頁 wcReco(libReco + library_rules.js)各自切出來跑同一組策略,
// 要挑到同一批、同一順序。網頁還沒有 wcReco = web 那顆還沒上線,SKIP 並講原因;有 wcReco 但切不出來或答案不同一律紅
{ const wfn = (n) => { const a = web.indexOf("        function " + n + "("), b = a < 0 ? -1 : web.indexOf("\n        }\n", a); return a < 0 || b < 0 ? null : web.slice(a, b + 10); };
  if (web.indexOf("        function wcReco(") < 0) console.log("SKIP  歡迎頁策略卡挑選兩邊同一批(網頁還沒有 wcReco:web 歡迎卡那顆還沒上線)");
  else {
    const lib = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "library.js"), "utf8");
    const dfn = (n) => { const a = lib.indexOf("\nfunction " + n + "(") + 1; if (a < 1) return null; let i = lib.indexOf("{", a), d = 0; for (; i < lib.length; i++) { if (lib[i] === "{") d++; else if (lib[i] === "}" && --d === 0) break; } return lib.slice(a, i + 1) + "\n"; };
    const dconst = (n) => { const m = new RegExp("^const " + n + " = [^\\n]*;$", "m").exec(lib); return m ? m[0] + "\n" : null; };
    const dParts = ["LIB_DAY", "LIB_MARKETS", "LIB_CATEGORY_MARKET"].map(dconst).concat(["libMarket", "libSampleYears", "libCreated", "libIsFree", "libNeeds", "libAnonOk", "libCompare", "libVisible", "wcReco"].map(dfn));
    const wParts = ["libCommunity", "libReco", "wcReco"].map(wfn), rulesPath = path.join(webDir, "app", "static", "js", "library_rules.js");
    const installed = new Set([5]), isInst = (s) => installed.has(s.id);
    let dPick = null, wPick = null, err = "";
    try { dPick = new Function("inst", dParts.join("") + "return (l) => wcReco(l, { env: 'cloud', installed: inst });")(isInst); } catch (e) { err += " 電腦版:" + e.message; }
    try { globalThis.window = globalThis; delete require.cache[require.resolve(rulesPath)]; require(rulesPath);
      wPick = new Function("env", "with (env) {" + wParts.join("") + "return wcReco; }")({ LIB: globalThis.BlaveLibrary, libInstalled: isInst }); } catch (e) { err += " 網頁:" + e.message; }
    // 三市場各兩支(驗證過的 vs 樣本更長沒驗證的、已裝的、樣本年數差 <0.05 年的一對)＋美股付費一支、社群驗證一支
    const S = (id, o) => Object.assign({ id, price: 0, is_official: true, created_at: "2026-0" + (1 + id % 9) + "-01 00:00:00" }, o);
    const R = (f, t) => ({ report: { equity_from: f, equity_to: t || "2026-10-01" } });
    const pool = [S(1, { market: "crypto", verified: true, ...R("2023-01-01") }), S(2, { market: "crypto", ...R("2015-01-01") }),
      S(3, { market: "txf", ...R("2016-01-01") }), S(4, { market: "txf", ...R("2016-01-10") }),
      S(5, { market: "twstock", verified: true, ...R("2017-01-01") }), S(6, { market: "twstock", ...R("2018-01-01") }),
      S(7, { market: "usstock", price: 5, verified: true, ...R("2010-01-01") }), S(8, { market: "usstock", is_official: false, verified: true, ...R("2010-01-01") })];
    let d = null, w = null;
    try { d = dPick && dPick(pool).map((s) => s.id); w = wPick && wPick(pool).map((s) => s.id); } catch (e) { err += " 執行:" + e.message; }
    ok("歡迎頁策略卡挑選兩邊同一批、同一順序(雲端視角,8 支測資挑 3 張)", !dParts.includes(null) && !wParts.includes(null) && !!d && d.length === 3 && JSON.stringify(d) === JSON.stringify(w),
      (dParts.includes(null) || wParts.includes(null) ? "切不出函式;" : "") + "電腦版 " + JSON.stringify(d) + " vs 網頁 " + JSON.stringify(w) + err); } }
// 策略庫詳情跟基準比(spec library-benchmark-2026-10-27 B;電腦版 library.js libBench* + main.js libBenchSanitize、網頁 workspace.html libBench / libCmpTable):
// 圖例「權益」、as_of 那句、表頭的「回測」「{n} 年」、總報酬／年化報酬／最大回撤逐字比(歡迎卡同 key)(tip_adj / tip_raw 已在上面 BH_KEYS);欄名「策略」是這次新增——網頁還沒有那個 msgid = web 那顆還沒上線,SKIP 講原因,有了就逐字比。
// 判斷:同一組 /report 形狀(api _benchmark_payload 會給的),兩邊要嘛都畫基準、要嘛都不畫,畫的話代號同一個(BTCUSDT 寫 BTC)
{ const PAIRS = { workspace_bt_legend_equity: "bt.equity", workspace_bt_benchmark_bh_as_of: "bt.tip.benchmarkBhAsOf", bc_mp_report_total: "lib.cmp.total", workspace_lib_kv_bt: "lib.kv.bt", bc_mp_years: "lib.sampleYrs", bc_mp_report_annual: "lib.kv.ann", bc_mp_sort_mdd_short: "lib.kv.mdd" }, NEW = { workspace_lib_cmp_strategy: "lib.cmp.strategy" };
  for (const lang of ["zh", "en"]) {
    const w = poRaw(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po")), d = poRaw(path.join(__dirname, "..", "shell", "i18n", lang + ".po"));
    const off = Object.keys(PAIRS).filter((k) => !w[k] || w[k] !== d[PAIRS[k]]);
    ok("策略庫基準:圖例「權益」、as_of 那句、表頭「回測 · N 年」、總報酬／年化報酬／最大回撤兩邊同一份(" + lang + ")", off.length === 0, off.map((k) => k + ": " + w[k] + " vs " + d[PAIRS[k]]).join(";"));
    for (const k of Object.keys(NEW)) {
      if (!d[NEW[k]]) ok("策略庫基準:電腦版有 " + NEW[k] + "(" + lang + ")", false);
      else if (!(k in w)) console.log("SKIP  策略庫基準欄名 " + k + " 兩邊同一份(" + lang + ";網頁 messages.po 還沒有這個 msgid:web 那顆還沒上線)");
      else ok("策略庫基準:欄名 " + k + " = " + NEW[k] + "(" + lang + ")", w[k] === d[NEW[k]], w[k] + " vs " + d[NEW[k]]);
    }
  }
  const wa = web.indexOf("        function libBench("), wb = wa < 0 ? -1 : web.indexOf("\n        }\n", wa);
  if (wa < 0) console.log("SKIP  策略庫基準畫不畫兩邊同一個判斷(網頁還沒有 libBench:web 那顆還沒上線)");
  else {
    const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"), libSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "library.js"), "utf8");
    const cut = (src, n) => { const a = src.indexOf("\nfunction " + n + "(") + 1; if (a < 1) return null; let i = src.indexOf("{", a), dd = 0; for (; i < src.length; i++) { if (src[i] === "{") dd++; else if (src[i] === "}" && --dd === 0) break; } return src.slice(a, i + 1) + "\n"; };
    const cst = (src, n) => { const m = new RegExp("^const " + n + " = [^\\n]*;$", "m").exec(src); return m ? m[0] + "\n" : null; };
    const dParts = [cst(mainSrc, "LIB_EQUITY_MAX"), cst(mainSrc, "libFin"), cst(mainSrc, "LIB_DAY_RE"), cst(mainSrc, "libDay"), cst(mainSrc, "libCurveOk"), cst(mainSrc, "LIB_BENCH_SYM_RE"), cut(mainSrc, "libBenchSanitize"), cut(libSrc, "libBenchSym")];
    let dF = null, wF = null, err = "";
    // LIB_EQUITY_MAX 跟別的常數同一行宣告:整行拿進來
    if (dParts[0] === null) { const m = /^const LIB_TITLE_MAX = [^\n]*LIB_EQUITY_MAX = [^\n]*;$/m.exec(mainSrc); dParts[0] = m ? m[0] + "\n" : null; }
    try { dF = new Function(dParts.join("") + "return (rep) => { const b = libBenchSanitize(rep.benchmark, libCurveOk(rep.equity, LIB_EQUITY_MAX)); return b ? libBenchSym(b) : null; };")(); } catch (e) { err += " 電腦版:" + e.message; }
    try { wF = new Function("env", "with (env) {" + web.slice(wa, wb + 10) + "return (rep) => { env.libReports.set(1, rep); const b = libBench(1); return b ? b.sym : null; }; }")({ libReports: new Map() }); } catch (e) { err += " 網頁:" + e.message; }
    const EQ = Array.from({ length: 400 }, (_, i) => 1 + i / 400), B = (o) => Object.assign({ symbol: "0050", adjusted: true, total_return: 794, annual_return: 20.6, max_drawdown: -34, sharpe: 1.05, equity: EQ.map((v) => v * 0.9 + 0.1), as_of: null }, o);
    const CASES = [["台股 0050", { equity: EQ, benchmark: B({}) }], ["加密 BTCUSDT → BTC", { equity: EQ, benchmark: B({ symbol: "BTCUSDT", adjusted: false }) }], ["美股 SPY、as_of", { equity: EQ, benchmark: B({ symbol: "SPY", as_of: "2026-10-20" }) }],
      ["沒有基準", { equity: EQ, benchmark: null }], ["舊 api 沒有這欄", { equity: EQ }], ["曲線不同長", { equity: EQ, benchmark: B({ equity: EQ.slice(1) }) }], ["沒有總報酬", { equity: EQ, benchmark: B({ total_return: null }) }],
      ["Sharpe／年化缺(lib 還沒補)", { equity: EQ, benchmark: B({ sharpe: null, annual_return: null }) }], ["策略曲線沒有", { equity: null, benchmark: B({}) }]];
    const call = (f, rep) => { try { return f(JSON.parse(JSON.stringify(rep))); } catch (e) { return "例外 " + e.message; } };
    const bad = dF && wF ? CASES.filter(([, rep]) => call(dF, rep) !== call(wF, rep)).map(([n, rep]) => n + ":電腦版 " + call(dF, rep) + " / 網頁 " + call(wF, rep)) : ["切不出函式" + err];
    ok("策略庫基準畫不畫、代號寫什麼兩邊同一個答案(" + CASES.length + " 組)", !dParts.includes(null) && bad.length === 0, bad.join(";"));
  } }
// ── 側欄策略資料夾(spec strategy-sidebar-folders §10 信任邊界:清單的每一份副本——api、main.js、renderer、web——同一份,改動同 commit)──
{
  const apiDir = process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), apiPy = path.join(apiDir, "openclaw", "agent_strategies.py");
  const R = path.join(__dirname, "..", "shell", "renderer"), rd = (f) => fs.readFileSync(f, "utf8");
  const sgMain = rd(path.join(__dirname, "..", "shell", "main.js")), sgR = rd(path.join(R, "stratgroups.js")), sfR = rd(path.join(R, "stratflags.js")), cloudJs = rd(path.join(__dirname, "..", "shell", "cloud.js"));
  // 括號裡的字串常值接起來(Python 的隱式串接、JS 的 + 串接都吃)
  const strBlock = (src, head) => { const i = src.indexOf(head); if (i < 0) return null; const j = src.indexOf(")", i + head.length); return [...src.slice(i + head.length, j).matchAll(/"([^"]*)"/g)].map((m) => m[1]).join(""); };
  const EMO_SPEC = "⭐🔥💡🎯🧪🚀💎🏆📌🔖📦🧩📈📉📊💹💰💵💴💶💷🏦🌐🌏⏰⏳🔁🔄🔀🔍🧭🔭🌊🎲🧠🔬🐂🐻🐳🦈🦅🦊🦉🐢🐇🐝🐙🦄🌱🌲🌵🍀🌸🌙⛅🌈🌋🌞☔🍁⚓🔑🔧🔨🧰🧲📚📝📎🎁🎨🎈";
  if (!fs.existsSync(apiPy)) ok("資料夾:找得到 api 那棵(" + apiPy + ";設 BLAVE_API_DIR)", false);
  else {
    const api = rd(apiPy), aE = strBlock(api, "_STRAT_GROUP_EMOJI = (");
    const dE = strBlock(sgMain, "const SG_EMOJI = ("), rE = strBlock(sgR, "const SG_EMOJI = (");
    ok("資料夾 emoji:api _STRAT_GROUP_EMOJI 是 72 個單一碼點、順序同 spec §10", !!aE && aE === EMO_SPEC && [...aE].length === 72, aE);
    ok("資料夾 emoji:main.js SG_EMOJI 與 api 逐字同一份(含順序)", dE === aE, dE);
    ok("資料夾 emoji:renderer stratgroups.js SG_EMOJI 與 api 逐字同一份(含順序)", rE === aE, rE);
    const num = (src, re) => { const m = re.exec(src); return m ? Number(m[1]) : null; };
    const aLim = [num(api, /^_STRAT_GROUP_FOLDERS_MAX = (\d+)/m), num(api, /^_STRAT_GROUP_NAME_MAX_LEN = (\d+)/m), num(api, /^_STRAT_ORDER_MAX = (\d+)/m)];
    const dLim = [num(sgMain, /SG_FOLDERS_MAX = (\d+)/), num(sgMain, /SG_NAME_MAX = (\d+)/), num(sgMain, /^const STRAT_PREFS_MAX = (\d+)/m)];
    const rLim = [num(sgR, /SG_MAX = (\d+)/), num(sgR, /SG_NAME_MAX = (\d+)/), 200];
    ok("資料夾上限:資料夾 20、名稱 20 個碼點、map 200 三份同值(api / main.js / renderer)", JSON.stringify(aLim) === "[20,20,200]" && JSON.stringify(dLim) === JSON.stringify(aLim) && JSON.stringify(rLim) === JSON.stringify(aLim), JSON.stringify([aLim, dLim, rLim]));
    const aId = (/^_STRAT_GROUP_ID_RE = re\.compile\(r"([^"]+)"\)/m.exec(api) || [])[1], dId = (/SG_ID_RE = \/\^([^$]+)\$\//.exec(sgMain) || [])[1], cId = (/PREF_GROUP_ID_RE = \/\^([^$]+)\$\//.exec(cloudJs) || [])[1];
    ok("資料夾 id 形狀:api / main.js / cloud.js 同一條(f + 6–12 個 [0-9a-z])", aId === "f[0-9a-z]{6,12}" && dId === aId && cId === aId, JSON.stringify([aId, dId, cId]));
  }
  // 市場對應(§10 建市場資料夾):market → 預填 emoji
  const MKT = { crypto: "💎", tw_index_futures: "📈", tw_stock_futures: "📊", tw_stock: "🏦", us_stock: "💵", global_futures: "🌐", mixed: "🧩" };
  const dM = {}; { const m = /const SG_MARKETS = \{([\s\S]*?)\};/.exec(sgR); if (m) for (const x of m[1].matchAll(/(\w+): \["[^"]+", "([^"]+)"\]/g)) dM[x[1]] = x[2]; }
  ok("資料夾:電腦版建市場資料夾的對應照 spec §10(七個市場與預填 emoji)", sorted(dM) === sorted(MKT), sorted(dM));
  // 網頁的純函式層(參照面):app/static/js/agent/strat_folders.js(node 可 require),共用測資 tests/strat_folders_vectors.json 也在網頁那棵
  const wMod = path.join(webDir, "app", "static", "js", "agent", "strat_folders.js"), wVec = path.join(webDir, "tests", "strat_folders_vectors.json");
  const W = fs.existsSync(wMod) ? require(wMod) : null;
  ok("資料夾:找得到網頁的 strat_folders.js 與共用測資 strat_folders_vectors.json", !!W && fs.existsSync(wVec), wMod);
  if (W) {
    ok("資料夾 emoji:網頁 strat_folders.js SG_EMOJI 與 api / 電腦版逐字同一份", W.SG_EMOJI === EMO_SPEC, W.SG_EMOJI);
    const wM = Object.fromEntries(Object.entries(W.MARKETS || {}).map(([k, v]) => [k, v[1]]));
    ok("資料夾:建市場資料夾的市場與預填 emoji 兩邊同一份", sorted(wM) === sorted(dM), sorted(wM) + " vs " + sorted(dM));
    ok("資料夾上限:網頁資料夾 20、名稱 20、map 200、id 形狀同電腦版", W.FOLDERS_MAX === 20 && W.NAME_MAX === 20 && W.MAP_MAX === 200 && String(W.ID_RE) === "/^f[0-9a-z]{6,12}$/", JSON.stringify([W.FOLDERS_MAX, W.NAME_MAX, W.MAP_MAX, String(W.ID_RE)]));
  }
  // 同一份測資跑兩邊的 sgBuild(want = 每組 [資料夾 id 或 null(未分類), 名字…])
  if (fs.existsSync(wVec)) {
    const VEC = JSON.parse(rd(wVec)).build;
    const i = sfR.indexOf("function sgBuild("); let d = 0, k = sfR.indexOf("{", i); for (; i >= 0 && k < sfR.length; k++) { if (sfR[k] === "{") d++; else if (sfR[k] === "}" && --d === 0) break; }
    const dBuild = i >= 0 ? new Function(sfR.slice(i, k + 1) + "\nreturn sgBuild;")() : null;
    const dOut = (c) => dBuild(c.list.map((name) => ({ name })), c.groups).map((g) => [g.id === "_u" ? null : g.id, ...g.items.map((x) => x.name)]);
    const wOut = (c) => W.sgBuild(c.list.map((name) => ({ name })), c.groups).map((g) => [g.id, ...g.names]);
    const dBad = !dBuild ? ["切不出 sgBuild"] : VEC.filter((c) => JSON.stringify(dOut(c)) !== JSON.stringify(c.want)).map((c) => c.case + ":" + JSON.stringify(dOut(c)));
    const wBad = !W ? ["沒有網頁模組"] : VEC.filter((c) => JSON.stringify(wOut(c)) !== JSON.stringify(c.want)).map((c) => c.case);
    ok("資料夾 sgBuild:電腦版 stratflags.js 跑共用測資(" + VEC.length + " 組:未分類、失效 id、失效策略名、空資料夾)", VEC.length >= 4 && dBad.length === 0, dBad.join(";"));
    ok("資料夾 sgBuild:網頁跑同一份共用測資", wBad.length === 0, wBad.join(";"));
  }
  const fontOf = (src) => { const m = /--font-emoji: ([^;]+);/.exec(src); return m ? m[1] : null; };
  const wCss = path.join(webDir, "app", "static", "css", "main.css"), dFont = fontOf(rd(path.join(R, "tokens.css"))), wFont = fs.existsSync(wCss) ? fontOf(rd(wCss)) : null;
  ok("--font-emoji:電腦版 tokens.css 照 spec 字串", dFont === '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif', dFont);
  ok("--font-emoji:網頁 main.css 與電腦版同字串", !!wFont && wFont === dFont, wFont);
  const wPo = path.join(webDir, "app", "translations", "zh", "LC_MESSAGES", "messages.po"), dPo = poMap(path.join(__dirname, "..", "shell", "i18n", "zh.po"));
  const wStr = fs.existsSync(wPo) ? new Set([...rd(wPo).matchAll(/^msgstr ("(?:[^"\\]|\\.)*")$/gm)].map((m) => JSON.parse(m[1]))) : new Set();
  const missing = Object.keys(dPo).filter((k) => /^sg\./.test(k)).filter((k) => !wStr.has(dPo[k])).map((k) => k + "=" + dPo[k]);
  ok("資料夾文案:電腦版 sg.* 的 zh 字(含 72 個 emoji 名)網頁 zh .po 都有同一句", missing.length === 0, missing.slice(0, 12).join(";") + (missing.length > 12 ? " …共 " + missing.length + " 句" : ""));
}
// 聊天長網址縮短(spec designer/chat-long-url-2026-10-30 §6):18 條測資逐項相同、上限與兩條 regex 逐值相同
//   電腦版:tests/check_shell_url_label.js 的 CASES、renderer/md.js 的 URL_LABEL_MAX / URL_WIDE / URL_UNSAFE / URL_LIKE
//   網頁:tests/url_label_vectors.json 的 url_label([輸入, 期望] 或 {in, expect})、app/static/js/agent/url_label.js
{ const vecPath = path.join(webDir, "tests", "url_label_vectors.json"), ulPath = path.join(webDir, "app", "static", "js", "agent", "url_label.js");
  const casesDef = (fs.readFileSync(path.join(__dirname, "check_shell_url_label.js"), "utf8").match(/^const CASES = \[[\s\S]*?^\];$/m) || [""])[0];
  const cases = casesDef ? new Function(casesDef + "\nreturn CASES;")() : [];
  let vec = [];
  try { vec = fs.existsSync(vecPath) ? JSON.parse(fs.readFileSync(vecPath, "utf8")).url_label || [] : []; } catch (e) { console.log("FAIL  " + vecPath + " 不是合法 JSON:" + e.message); red++; }
  const norm = (a) => JSON.stringify(a.map((c) => (Array.isArray(c) ? [c[0], c[1]] : [c.in, c.expect])));
  ok("長網址測資:電腦版 CASES 與網頁 url_label 逐項相同(18 條)", cases.length === 18 && norm(cases) === norm(vec), fs.existsSync(vecPath) ? cases.length + " vs " + vec.length : "找不到 " + vecPath);
  const mdSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "md.js"), "utf8"), ul = fs.existsSync(ulPath) ? fs.readFileSync(ulPath, "utf8") : "";
  // regex 比「吃哪些字」不比原文:寫字或寫 \u 跳脫都行;逐一跑過全部碼位,原文看起來一樣、被 NFC 換掉的字(U+F900 → U+8C48)也抓得到
  const cv = (src, n) => { const m = src.match(new RegExp("^\\s*(?:const|var|let) " + n + " = (.+);$", "m")); try { return m ? new Function("return " + m[1])() : null; } catch (_) { return null; } };
  const diffAt = (x, y) => { for (let c = 0; c <= 0x10FFFF; c++) { const ch = c >= 0xD800 && c <= 0xDFFF ? String.fromCharCode(c) : String.fromCodePoint(c); if (x.test(ch) !== y.test(ch)) return "U+" + c.toString(16).toUpperCase(); } return null; };
  const why = [];
  const dMax = cv(mdSrc, "URL_LABEL_MAX"), wMax = cv(ul, "URL_LABEL_MAX");
  if (dMax !== 40 || dMax !== wMax) why.push("URL_LABEL_MAX: " + dMax + " vs " + wMax);
  for (const n of ["URL_WIDE", "URL_UNSAFE"]) {
    const x = cv(mdSrc, n), y = cv(ul, n);
    if (!(x instanceof RegExp) || !(y instanceof RegExp)) { why.push(n + " 切不出來"); continue; }
    const at = x.flags !== y.flags ? "flags " + x.flags + " vs " + y.flags : diffAt(x, y);
    if (at) why.push(n + " 在 " + at + " 不同");
  }
  // URL_LIKE 不是單一字元集合,逐碼位比不出差異(單一字元兩邊都不配):比 source 與 flags,再跑一組探針字串
  const dl = cv(mdSrc, "URL_LIKE"), wl = cv(ul, "URL_LIKE");
  if (!(dl instanceof RegExp) || !(wl instanceof RegExp)) why.push("URL_LIKE 切不出來");
  else {
    if (dl.source !== wl.source || dl.flags !== wl.flags) why.push("URL_LIKE: " + dl + " vs " + wl);
    const PROBE = ["https://x.com", "http://a", "www.blave.org", "WWW.x", "github.com/x", "my_host.example.com/p", "a-b.c/d", "AGENTS.md", "v0.1.37", "blave.org", "官網", "x.y", "ftp://a.b/c", " https://x"];
    const off = PROBE.filter((x) => dl.test(x) !== wl.test(x));
    if (off.length) why.push("URL_LIKE 判斷不同:" + off.join("、"));
  }
  ok("長網址上限 URL_LABEL_MAX、URL_WIDE / URL_UNSAFE(逐碼位比)與 URL_LIKE(原文＋flags＋探針)兩邊同一份", why.length === 0, ul ? why.join(";") : "找不到 " + ulPath); }
// MCPT p 值(spec pvalue-unit-2026-10-30 §4):回測分頁那一列的 tooltip(講次數、門檻寫小數)、分佈圖標題、列名兩邊逐字同一份;
// 格式規則只有一份(strategy_versions.js fmt / fillP / mcptBeat),兩邊那支各自跑 §4.2 同一組測資。_zero / _non 是這次新增——網頁還沒有 = web 那顆還沒上線,SKIP 講原因
{ const PAIRS = { "bt.mcptTipSig": "workspace_bt_mcpt_tip_sig", "bt.mcptTipNs": "workspace_bt_mcpt_tip_ns", "bt.mcptDistTitle": "workspace_bt_mcpt_dist_title", "bt.mcpt": "workspace_bt_mcpt" },
    NEW = { "bt.mcptTipZero": "workspace_bt_mcpt_tip_zero", "ver.mcptTipSigNoN": "workspace_bt_mcpt_tip_sig_non", "ver.mcptTipNsNoN": "workspace_bt_mcpt_tip_ns_non" },
    TIPS = ["bt.mcptTipSig", "bt.mcptTipNs", "bt.mcptTipZero", "ver.mcptTipSigNoN", "ver.mcptTipNsNoN"];
  for (const lang of ["zh", "en"]) {
    const w = poRaw(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po")), d = poRaw(path.join(__dirname, "..", "shell", "i18n", lang + ".po"));
    const off = Object.keys(PAIRS).filter((k) => !d[k] || w[PAIRS[k]] !== d[k]);
    ok("MCPT:tooltip 兩句、分佈圖標題、列名兩邊同一份(" + lang + ")", off.length === 0, off.map((k) => k + ": " + d[k] + " vs " + w[PAIRS[k]]).join(";"));
    for (const k of Object.keys(NEW)) {
      if (!d[k]) ok("MCPT:電腦版有 " + k + "(" + lang + ")", false);
      else if (!(NEW[k] in w)) console.log("SKIP  MCPT " + NEW[k] + " 兩邊同一份(" + lang + ";網頁 messages.po 還沒有這個 msgid:web 那顆還沒上線)");
      else ok("MCPT:" + k + " = " + NEW[k] + "(" + lang + ")", w[NEW[k]] === d[k], d[k] + " vs " + w[NEW[k]]);
    }
    // 擋回頭路:p 換成百分比、跟同句的小數門檻對不起來,就是這次要修的病
    const pctBack = TIPS.map((k) => ["電腦版 " + k, d[k]]).concat(TIPS.map((k) => ["網頁 " + (PAIRS[k] || NEW[k]), w[PAIRS[k] || NEW[k]]])).filter(([, v]) => typeof v === "string" && /\{pct\}|%/.test(v));
    ok("MCPT:兩邊 tooltip 都不含 {pct} 也不含 %(" + lang + ")", pctBack.length === 0, pctBack.map(([n, v]) => n + ": " + v).join(";"));
  }
  const load = (f) => { if (!fs.existsSync(f)) return null; const g = {}; new Function("window", fs.readFileSync(f, "utf8")).call(g, g); return g.blaveVersions || null; };
  const ROWS = [[0, "<0.001", "p < 0.001", 0], [0.0004, "<0.001", "p < 0.001", 1], [0.0005, "<0.001", "p < 0.001", 1], [0.0012, "0.001", "p = 0.001", 2],
    [0.0495, "0.0495", "p = 0.0495", 99], [0.05, "0.050", "p = 0.050", 100], [0.106, "0.106", "p = 0.106", 212], [null, "—", "p = {p}", null]];
  for (const [side, f] of [["電腦版", path.join(__dirname, "..", "shell", "renderer", "strategy_versions.js")], ["網頁", path.join(webDir, "app", "static", "js", "agent", "strategy_versions.js")]]) {
    const V = load(f), bad = !V || typeof V.fillP !== "function" || typeof V.mcptBeat !== "function" ? ["沒有 fmt / fillP / mcptBeat"]
      : ROWS.filter(([p, a, b, k]) => V.fmt("mcpt_p", p) !== a || V.fillP("p = {p}", p) !== b || V.mcptBeat(p, 2000) !== k).map((r) => JSON.stringify(r)).concat(V.mcptBeat(0.016, 20000) === null ? [] : ["n=20000 應不講次數"]);
    ok("MCPT p 值共用測資(§4.2,9 組)在" + side + "那支全對", bad.length === 0, bad.join(";"));
  } }
// 改金鑰驗證碼(表面表 keyverify-surfaces-2026-10-30 §2、§3;網頁 js/key_verify.js + kc_*、電腦版 trade.js kcView + cx.kc.*):
// api 關卡代號對到哪一句兩邊同一份(sent:false 的 reason 對照),14 句 zh／en 逐字一致;寄不出那句鎖在換步驟後的定稿(沒有鈕可以「再按」)
{ const kvPath = path.join(webDir, "app", "static", "js", "key_verify.js");
  const kv = fs.existsSync(kvPath) ? fs.readFileSync(kvPath, "utf8") : "";
  const obj = (src, re) => { const m = re.exec(src), o = {}; if (m) for (const x of m[1].matchAll(/(\w+): "(\w+)"/g)) o[x[1]] = x[2]; return o; };
  const wr = obj(kv, /var REASON = \{([^}]*)\}/), dr = obj(desk, /const KC_REASON = \{([^}]*)\}/);
  ok("改金鑰驗證碼:sent:false 的 reason → 句子兩邊同一份對照(冷卻／達上限／寄不出;沒有 reason = 沒有 email)", Object.keys(dr).length === 3 && sorted(dr) === sorted(wr), sorted(dr) + " vs " + sorted(wr));
  ok("改金鑰驗證碼:沒有 reason 的 sent:false 兩邊都是 noemail、其他不認得的 reason 都是 failed",
    /REASON\[st\.reason\] \|\| \(st\.reason \? "failed" : "noemail"\)/.test(kv) && /KC_REASON\[d\.reason\] \|\| \(d\.reason \? "failed" : "noemail"\)/.test(desk));
  const KC = ["title", "why", "label", "ok", "sent", "resent", "cooldown", "limited", "failed", "noemail", "invalid", "expired", "locked", "until"];
  for (const lang of ["zh", "en"]) {
    const w = poRaw(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po")), d = poRaw(path.join(__dirname, "..", "shell", "i18n", lang + ".po"));
    const off = KC.filter((k) => !w["kc_" + k] || w["kc_" + k] !== d["cx.kc." + k]);
    ok("改金鑰驗證碼:kc_* 與 cx.kc.* 14 句兩邊同一份(" + lang + ")", off.length === 0, off.map((k) => k + ": " + w["kc_" + k] + " vs " + d["cx.kc." + k]).join(";"));
    if (lang === "zh") ok("改金鑰驗證碼:寄不出那句是換步驟後的定稿(zh)", d["cx.kc.failed"] === "驗證碼沒寄出去，金鑰沒有儲存，請稍後再試。", d["cx.kc.failed"]);
  } }

/* 策略頁頭「狀態 → 鈕態」表(spec strategy-page-autotrade §4;cross-surface-parity 規則三):
   電腦版 shell/renderer/handoff.js 的 SP_HEAD 與網頁 workspace.html 的 SP_HEAD 逐態比——態的名字、有沒有主鈕、填色／描邊、停用、
   有沒有動作、記號,以及鈕字／狀態詞／原因句的 zh 原文(電腦版走 shell/i18n,網頁走 I18N 名 → msgid → messages.po)。
   動態那幾格(看市場的基本字、#tr-go 同一個鈕字、這一支在選擇策略框那一列的原因)照槽位比,不比字。
   兩邊對不上又是刻意的,寫進 SP_EXEMPT、附一句原因,而且每一條都驗它還成立(過時的豁免也紅) */
{ const hoSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "handoff.js"), "utf8");
  const lit = (src, where) => { const m = /const SP_HEAD = (\{[\s\S]*?\n\s*\});/.exec(src); if (!m) return null; try { return (0, eval)("(" + m[1] + ")"); } catch (e) { console.log("FAIL  " + where + " 的 SP_HEAD 讀不出來:" + e.message); red++; return null; } };
  const D = lit(hoSrc, "電腦版 handoff.js"), W = lit(web, "網頁 workspace.html");
  ok("策略頁頭:兩邊都有 SP_HEAD 鈕態表", !!D && !!W);
  if (D && W) {
    const dzh = poMap(path.join(__dirname, "..", "shell", "i18n", "zh.po")), wzh = poMap(path.join(webDir, "app", "translations", "zh", "LC_MESSAGES", "messages.po"));
    const wid = {}; for (const m of web.matchAll(/^\s+(\w+): (?:\{\{ _\('([^']+)'\) \| tojson \}\}|"\{\{ _\('([^']+)'\) \}\}"),?$/gm)) wid[m[1]] = m[2] || m[3];
    const dT = (k) => dzh[k], wT = (n) => wzh[wid[n]];
    // 只有一邊有的態(附原因);其餘的態兩邊要一一對上
    const ONLY_DESK = { setupWait: "豁免 3:開通中,網頁的群益與統一都給〔繼續〕(網頁的開通清單兩家都在框裡);電腦版群益本機入口 CAPL_LOCAL_ON 關著、沒有那份清單,只留狀態詞" };
    const ONLY_WEB = {};
    // 態一樣但有一格刻意不同(附原因)
    const CELL_EXEMPT = { "fail.note": "fail 的原因句兩邊各用自己自動下單頁那一句、出口不同:電腦版「串接失敗，下單程式沒在跑。到「設定」處理。」(帳戶與金鑰在自動下單 › 設定分頁),網頁「串接失敗，到策略組合處理」(網頁的帳戶在策略組合頁);開頭的「串接失敗」另外逐字比" };
    const dk = Object.keys(D), wk = Object.keys(W);
    ok("策略頁頭:態的集合兩邊一樣(只有一邊有的都在豁免表)", dk.filter((k) => !(k in W) && !ONLY_DESK[k]).length === 0 && wk.filter((k) => !(k in D) && !ONLY_WEB[k]).length === 0,
      "只在電腦版:" + dk.filter((k) => !(k in W) && !ONLY_DESK[k]).join(",") + " 只在網頁:" + wk.filter((k) => !(k in D) && !ONLY_WEB[k]).join(","));
    Object.keys(ONLY_DESK).forEach((k) => ok("策略頁頭豁免還成立:" + k + " 只在電腦版", (k in D) && !(k in W), ONLY_DESK[k]));
    // 動態槽:電腦版 "$base" ＝ 網頁 "base";"$go"(#tr-go 同一個鈕字)＝ 網頁 pfStart;"$off"(選擇策略框那一列的原因)＝ 網頁 "lock";
    // fail 態的原因句 "$fail" ＝ 網頁 "fail"(各自自動下單頁那一句,開頭「串接失敗」逐字比,出口見 CELL_EXEMPT);
    // start 態的原因句 "$go"(帳本上還有 Blave 部位時的 tr.startOnBook)＝ 網頁 "onBook"(pfStartOnBook),兩句逐字比
    const btnText = (d, w) => d.key === "$base" ? (w === "base" && dT("sp.btn") === wT("pfNav") && dT("po.add") === wT("poAdd"))
      : d.key === "$go" ? (w === "pfStart" && dT("tr.start") === wT("pfStart")) : !!dT(d.key) && dT(d.key) === wT(w);
    const noteOk = (d, w) => d === "$fail" ? w === "fail" && !!dT("cx.failShort") && dT("cx.failShort") === wT("pfConnectFailedShort") && dT("cx.failStopped").indexOf(dT("cx.failShort")) === 0 && dT("cx.failStopped") === wT("pfConnectFailedShort") + "，" + wT("pfVenueGoFix")
      : d === "$off" ? w === "lock" : d === "$go" ? w === "onBook" && !!dT("tr.startOnBook") && dT("tr.startOnBook") === wT("pfStartOnBook") : !!d && !!w && dT(d) === wT(w);
    const bad = [];
    dk.filter((k) => k in W).forEach((k) => {
      const d = D[k], w = W[k], db = d.btn;
      const cells = {
        btn: !!db === !!w.btn && (!db || btnText(db, w.btn)),
        out: !db || (db.kind === "out") === !!w.out,
        off: !db || !!db.off === !!w.off,
        act: !db || (!!db.act) === (!!w.act),
        mark: !!d.mark === !!w.mark,
        word: !d.word === !w.word && (!d.word || dT(d.word) === wT(w.word)),
        note: (!d.note && !w.note) || noteOk(d.note, w.note),
      };
      Object.keys(cells).forEach((c) => { if (!cells[c] && !CELL_EXEMPT[k + "." + c]) bad.push(k + "." + c + " 電腦版 " + JSON.stringify(d) + " 網頁 " + JSON.stringify(w)); });
    });
    ok("策略頁頭:每一態的主鈕(有無／填色描邊／停用／動作)、記號、狀態詞、原因句兩邊同一份(zh 原文逐字)", bad.length === 0, bad.join(";"));
    ok("策略頁頭:start 態帳本上還有部位的原因句兩邊同一句(電腦版 tr.startOnBook、網頁 pfStartOnBook,zh 逐字)", D.start && D.start.note === "$go" && W.start && W.start.note === "onBook"
      && !!dT("tr.startOnBook") && dT("tr.startOnBook") === wT("pfStartOnBook"), dT("tr.startOnBook") + " vs " + wT("pfStartOnBook"));
    ok("策略頁頭:記號同一句(電腦版 po.live、網頁 poLive)", !!dT("po.live") && dT("po.live") === wT("poLive"), dT("po.live") + " vs " + wT("poLive"));
    // 判準層的豁免(表上看不到,驗兩邊的原文還是那樣)
    const spv = (() => { const i = hoSrc.length ? fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "portfolio.js"), "utf8") : ""; const a = i.indexOf("function spView("); return a < 0 ? "" : i.slice(a, i.indexOf("\nfunction ", a + 1)); })();
    ok("策略頁頭豁免 1 還成立:串接失敗兩邊都落 fail,但判準不同——網頁是 pfKeyRejected 或「綁著、pfExecState 說 noaccount」(下單程式在不在跑都算);電腦版是 trFailStopped(讀帳失敗或金鑰被拒,而且下單程式沒在跑)。下單程式還在跑時電腦版留在原本那一態(在跑照出記號),說明行改講「串接失敗」＋到自動下單頁,不擋鈕——對帳器還在下單時把頁首換成停用的鈕,等於藏起它在跑",
      /if \(pfKeyRejected\(\)\) return "fail";/.test(web) && /if \(pfVenueIds\(\)\.length > 0 && pfExecState\(\) === "noaccount"\) return "fail";/.test(web) && /const failStop = hasAcct && trFailStopped\(state, r\);/.test(spv) && /hasAcct && !failStop && \["start", "acct", "off", "running"\]/.test(spv));
    ok("策略頁頭豁免還成立:fail.note 兩邊出口不同(電腦版到「設定」、網頁到策略組合),開頭「串接失敗」同字", D.fail && D.fail.note === "$fail" && W.fail && W.fail.note === "fail" && dT("cx.failShort") === wT("pfConnectFailedShort")
      && dT("cx.failStopped") !== wT("pfConnectFailedShort") + "，" + wT("pfVenueGoFix"), CELL_EXEMPT["fail.note"]);
    ok("策略頁頭豁免 2 還成立:網頁的連接中多認「串接中且沒卡住」(真實交易所要 agent 現場建 order_／account_,常超過 3 分鐘);電腦版只認自己的旗標",
      /return pfWaitingVenues\(\)\.some\(function \(id\) \{ return !pfWaitStuck\(id, now\); \}\);/.test(web) && /connecting: spCxOn\(S, now\)/.test(spv));
    ok("策略頁頭豁免 4 還成立:網頁沒有雲朵 icon 鈕(單主機,沒有送上雲端);電腦版那顆不在 SP_HEAD 裡、埋點 sp_cloud_icon 只有電腦版送",
      !/sp_cloud_icon/.test(web) && /trackFeature\("sp_cloud_icon"\)/.test(hoSrc) && !/sp_cloud_icon/.test(JSON.stringify(D)));
    ok("策略頁頭豁免 5 還成立:存金額的事件網頁是 trade_amounts_saved 帶 source,電腦版是 portfolio_save／sp_amt_saved 不帶屬性(埋點事件名與屬性不比,規則三)",
      /gaEvent\("trade_amounts_saved", \{ source: /.test(web));
  } }
/* 三個驗證分頁的鈕態表與「怎麼看」對照(canon › 驗證分頁重跑鈕、說明文章外連;cross-surface-parity 規則三):
   電腦版 report-robust.js 的 VAL_BTN／VAL_BTN_ORDER、app.js 的 RP_HELP_SLUG,網頁 workspace.html 同名常數。逐列比 kind、disabled、labelKey 與優先序。
   鈕字 key 不同名,比各分頁開始／重跑的 zh／en 原文。網頁還沒有常數 = web 那顆還沒上線,SKIP 講原因 */
{ const robSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "report-robust.js"), "utf8");
  const lit = (src, re, where) => { const m = re.exec(src); if (!m) return null; try { return (0, eval)("(" + m[1] + ")"); } catch (e) { ok(where + " 讀得出來", false, e.message); return null; } };
  const TBL = /const VAL_BTN = (\{[\s\S]*?\n\s*\});/, ORD = /const VAL_BTN_ORDER = (\[[^\]]*\]);/, HLP = /const RP_HELP_SLUG = (\{[^}]*\});/;
  const D = lit(robSrc, TBL, "電腦版 VAL_BTN"), DO = lit(robSrc, ORD, "電腦版 VAL_BTN_ORDER"), DH = lit(appSrc, HLP, "電腦版 RP_HELP_SLUG");
  const W = lit(web, TBL, "網頁 VAL_BTN"), WO = lit(web, ORD, "網頁 VAL_BTN_ORDER"), WH = lit(web, HLP, "網頁 RP_HELP_SLUG");
  const SPEC = { behind: ["out", false, "update"], sent: ["out", true, "sent"], empty: ["out", false, "start"], stale: ["out", false, "rerun"], fresh: ["quiet", false, "rerun"] };
  ok("驗證鈕:電腦版 VAL_BTN 五態照 canon(不實心)、優先序 主機太舊 > 已送出 > 還沒跑 > 過時 > 沒過時", !!D && !!DO && JSON.stringify(DO) === JSON.stringify(["behind", "sent", "empty", "stale", "fresh"])
    && Object.keys(SPEC).every((k) => D[k] && JSON.stringify([D[k].kind, D[k].disabled, D[k].labelKey]) === JSON.stringify(SPEC[k])) && Object.keys(D).length === 5, JSON.stringify(D));
  ok("怎麼看:電腦版對照表只有回測數據、參數掃描、樣本外驗證三頁", !!DH && JSON.stringify(DH) === JSON.stringify({ bt: "backtest_metrics", rob: "avoid_overfitting", wf: "walk_forward" }), JSON.stringify(DH));
  if (!W || !WO) console.log("SKIP  驗證鈕 VAL_BTN／VAL_BTN_ORDER 兩邊同一份(網頁 workspace.html 還沒有這個常數:web 那顆還沒上線)");
  else ok("驗證鈕:VAL_BTN 逐列、優先序兩邊同一份", JSON.stringify(W) === JSON.stringify(D) && JSON.stringify(WO) === JSON.stringify(DO), JSON.stringify(W) + " vs " + JSON.stringify(D));
  if (!WH) console.log("SKIP  怎麼看 RP_HELP_SLUG 兩邊同一份(網頁 workspace.html 還沒有這個常數:web 那顆還沒上線)");
  else ok("怎麼看:RP_HELP_SLUG 兩邊同一份", JSON.stringify(WH) === JSON.stringify(DH), JSON.stringify(WH) + " vs " + JSON.stringify(DH));
  const LABELS = { "rob.btnScan": "workspace_rob_btn_scan", "rob.btnRescan": "workspace_rob_btn_rescan", "wf.btnRun": "workspace_wf_btn_run", "wf.btnRerun": "workspace_wf_btn_rerun", "xt.btnRun": "workspace_xt_btn_run", "xt.btnRerun": "workspace_xt_btn_rerun",
    "rob.btnSent": "workspace_rob_btn_sent", "wf.btnSent": "workspace_wf_btn_sent", "xt.btnBusy": "workspace_xt_btn_busy", "rp.btnUpdate": "workspace_upd_go" };
  for (const lang of ["zh", "en"]) {
    const d = poMap(path.join(__dirname, "..", "shell", "i18n", lang + ".po")), w = poMap(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po"));
    const off = Object.keys(LABELS).filter((k) => !d[k] || d[k] !== w[LABELS[k]]);
    ok("驗證鈕:三個分頁開始／重跑／已送出、主機太舊的鈕字兩邊同一份(" + lang + ")", off.length === 0, off.map((k) => k + ": " + d[k] + " vs " + w[LABELS[k]]).join(";"));
  } }
/* 〔套用金額〕停用原因(0.1.44):補救連結對照表、原因優先序、字樣,以及回合鎖「碰過哪一支」的判準。兩邊同一份,不同的只有下面具名的兩處:
   登入那兩條只有電腦版(web 沒有未登入這個狀態);en 的功能名 web 是 Title Case(同 web check_mg_sizing_parity)。 */
{ const pfSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "portfolio.js"), "utf8"), resSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "results.js"), "utf8");
  const WHY_KEY = { "mg.applyDiffSet": "mgApplyDiffSet", "mg.propOtherAlloc": "mgPropOtherAlloc", "mg.needFund": "mgNeedFund", "mg.needSize": "mgNeedSize", "mg.needMethod": "mgNeedMethod", "mg.needTarget": "mgNeedTarget",
    "mg.sizeNoHist": "mgSizeNoHist", "mg.sizeNoSolve": "mgSizeNoSolve", "sz.shortMdd": "szShortMdd", "sz.noVol": "szNoVol", "sz.staleMdd": "szStaleMdd", "sz.oldMdd": "szOldMdd",
    "mg.why.alloc": "mgWhyAlloc", "mg.why.method": "mgWhyMethod", "mg.why.changeMethod": "mgWhyChangeMethod", "mg.why.changeTarget": "mgWhyChangeTarget", "mg.why.shortMdd": "mgWhyShortMdd", "mg.why.noVol": "mgWhyNoVol",
    "mg.why.rerun": "mgWhyRerun", "mg.why.updCloud": "mgWhyUpdCloud", "mg.applyWhyUnread": "mgApplyWhyUnread", "mg.applyWhyFx": "mgApplyWhyFx", "mg.applyWhyQuote": "mgApplyWhyQuote", "mg.applyWhySame": "mgApplyWhySame", "tr.saving": "pfSaving" };
  const WHY_DESK_ONLY = ["mg.applyWhyLogin", "mg.applyWhyFxOld"];
  const cutLit = (src, re) => { const m = re.exec(src); return m ? m[0] : null; };
  const dTbl = cutLit(pfSrc, /const MG_WHY_SIZE = [^\n]*\nconst MG_WHY_FIX = \{[\s\S]*?\n\};/), wTbl = cutLit(web, /function mgWhySize\([\s\S]*?\n\s*\}\n\s*const MG_WHY_FIX = \{[\s\S]*?\n\s*\};/);
  const dFix = dTbl && new Function(dTbl + "\nreturn MG_WHY_FIX;")(), wFix = wTbl && new Function(wTbl + "\nreturn MG_WHY_FIX;")();
  ok("MG_WHY_FIX 兩邊都切得出來", !!dFix && !!wFix);
  if (dFix && wFix) { const mapK = (k) => (k === undefined ? undefined : WHY_KEY[k] || "未對照:" + k);
    const mapped = Object.keys(dFix).filter((k) => !WHY_DESK_ONLY.includes(k)).map((k) => [mapK(k), { go: dFix[k].go, focusOn: dFix[k].focusOn, link: mapK(dFix[k].link), text: dFix[k].text && (dFix[k].text === "mg.why.shortMdd" ? "mgWhyShortMdd" : "mgWhyNoVol") }]);
    const view = (o) => JSON.stringify([o.go, o.focusOn, o.link, o.text]);
    const off = mapped.filter(([wk, v]) => !wFix[wk] || view(wFix[wk]) !== view(v)).map(([wk]) => wk).concat(Object.keys(wFix).filter((wk) => !mapped.some(([k]) => k === wk)));
    ok("MG_WHY_FIX 兩邊同一份:每條原因去哪、聚焦哪格、連結字與換句(電腦版另有登入兩條)", off.length === 0 && mapped.length === 12 && WHY_DESK_ONLY.every((k) => dFix[k] && dFix[k].go === "login"), off.join()); }
  const dWhy = cutLit(pfSrc, /function mgApplyWhy\(d, quoteMissing, changed\) \{[\s\S]*?\n\}/), wWhy = cutLit(web, /function mgApplyWhyKey\(f\) \{[\s\S]*?\n\s*\}/);
  ok("原因優先序兩邊都切得出來", !!dWhy && !!wWhy);
  if (dWhy && wWhy) { const wF = new Function(wWhy + "\nreturn mgApplyWhyKey;")(), bad = [];
    const dF = (f) => new Function("trCfgUnread", "trReport", "trStored", "mgSameAsAmounts", "mgFxWhy", "trUnknownWhyKey", "TR", dWhy + "\nreturn mgApplyWhy;")(() => f.cfgUnread, () => ({}), () => ({}), () => !f.diffSet, () => "mg.applyWhyFx", () => "UNK", { save: f.saving ? "saving" : null, listLoaded: true, env: "local" })(
      { eff: f.noSize ? null : 1, gap: f.gap, rows: f.quoteMissing ? (f.fxMissing ? [{ fxMissing: true }] : f.unitUnknown ? [{ money: 1, native: null, name: "x" }] : []) : [] }, f.quoteMissing, false);
    const FLAGS = ["cfgUnread", "diffSet", "quoteMissing", "fxMissing", "unitUnknown", "noSize", "saving"];
    for (let i = 0; i < 1 << FLAGS.length; i++) for (const gap of [null, "mgNeedFund"]) { const f = {}; FLAGS.forEach((k, b) => { f[k] = !!(i & (1 << b)); }); f.gap = gap;
      const w = wF(f), dk = dF({ ...f, gap: gap && "mg.needFund" }), d = dk === "UNK" ? "pfUnknownWhy" : dk === "mg.needFund" ? "mgNeedFund" : WHY_KEY[dk] || dk;
      if (w !== d) bad.push(JSON.stringify(f) + " web=" + w + " 電腦版=" + dk); }
    ok("〔套用金額〕原因優先序兩邊同一份(7 個條件全組合 × 有無 gap)", bad.length === 0, bad.slice(0, 3).join(";")); }
  const WHY_STR = { "mg.applyDiffSet": "workspace_mg_apply_diff_set", "mg.applyDiffSetN": "workspace_mg_apply_diff_set_n", "mg.propOtherAlloc": "workspace_mg_prop_other_alloc", "mg.applyWhyUnread": "workspace_mg_apply_why_unread", "mg.applyWhyQuote": "workspace_mg_apply_why_quote", "mg.applyWhyFx": "workspace_mg_apply_why_fx", "mg.applyWhySame": "workspace_mg_apply_why_same",
    "mg.needFund": "workspace_mg_need_fund", "mg.needSize": "workspace_mg_need_size", "mg.needMethod": "workspace_mg_need_method", "mg.needTarget": "workspace_mg_need_target", "mg.sizeNoHist": "workspace_mg_size_no_hist", "mg.sizeNoSolve": "workspace_mg_size_no_solve",
    "sz.shortMdd": "workspace_sz_short_mdd", "sz.staleMdd": "workspace_sz_stale_mdd", "sz.oldMdd": "workspace_sz_old_mdd", "sz.noVol": "workspace_sz_no_vol",
    "mg.why.alloc": "workspace_mg_why_alloc", "mg.why.method": "workspace_mg_why_method", "mg.why.tbMethod": "workspace_mg_why_tb_method", "mg.why.changeMethod": "workspace_mg_why_change_method", "mg.why.changeTarget": "workspace_mg_why_change_target", "mg.why.shortMdd": "workspace_mg_why_short_mdd", "mg.why.noVol": "workspace_mg_why_no_vol", "mg.why.rerun": "workspace_mg_why_rerun", "mg.why.updCloud": "workspace_mg_why_upd_cloud", "mg.why.pickTitle": "workspace_mg_why_pick_title",
    "tr.noAccount": "workspace_pf_no_account", "tr.fogConnect": "workspace_pf_fog_connect", "po.fogNew": "workspace_pf_fog_new", "mg.fogNew": "workspace_mg_no_strategies", "rpt.fogNew": "workspace_rp_fog_new" };
  // en 兩條字樣小差,對齊前不比:sz.shortMdd 電腦版 Under、web Less than(web 自己的 mg.why.shortMdd 也是 Under);mg.applyWhyQuote web 用直引號,其餘都是 ’
  const EN_OPEN = new Set(["sz.shortMdd", "mg.applyWhyQuote"]), norm = (s) => s.toLowerCase();
  for (const lang of ["zh", "en"]) { const d = poMap(path.join(__dirname, "..", "shell", "i18n", lang + ".po")), w = poMap(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po"));
    const same = (a, b) => (lang === "zh" ? a === b.replace(/%%/g, "%") : norm(a) === norm(b.replace(/%%/g, "%")));
    const off = Object.entries(WHY_STR).filter(([dk, wk]) => !(lang === "en" && EN_OPEN.has(dk)) && (typeof d[dk] !== "string" || typeof w[wk] !== "string" || !same(d[dk], w[wk])));
    ok("原因句、補救連結、空狀態新字樣兩邊同一份(" + lang + "," + Object.keys(WHY_STR).length + " 句)", off.length === 0, off.map(([dk, wk]) => dk + "「" + d[dk] + "」 vs " + wk + "「" + w[wk] + "」").join(";")); }
  const dPath = /const RES_STRAT_PATH = (\/.*\/g);/.exec(resSrc), wPath = /const CS_STRAT_PATH = (\/.*\/g);/.exec(web);
  ok("回合碰過哪支:路徑 regex 兩邊同一份", !!dPath && !!wPath && dPath[1] === wPath[1], (dPath && dPath[1]) + " vs " + (wPath && wPath[1]));
  const listOf = (src, re) => { const m = re.exec(src); return m ? JSON.stringify(JSON.parse(m[1]).sort()) : null; };
  const dK = listOf(resSrc, /const RES_KIND_STRAT = new Set\((\[[^\]]*\])\)/), wK = listOf(web, /const CS_STRAT_KINDS = (\[[^\]]*\])/), dS = listOf(resSrc, /const RES_KIND_SAFE = new Set\((\[[^\]]*\])\)/), wS = listOf(web, /const CS_STRAT_SAFE = (\[[^\]]*\])/);
  ok("回合碰過哪支:策略類 kind、確定不碰的 kind 兩邊同一份", !!dK && dK === wK && !!dS && dS === wS, dK + " vs " + wK + ";" + dS + " vs " + wS); }
console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
