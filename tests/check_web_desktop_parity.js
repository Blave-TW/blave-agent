// 電腦版與網頁兩個表面要同一份的常數(稽核 audit-0.1.13-web C3;成交測試的純邏輯與字串見檔尾):階段表 PHASE_OF / PHASE_NONE、設定 modal 的分類名與順序(方案 B)、
// 回測 Type C 的買進持有基準字串、回覆通知的摘錄測資／標記 regex／前綴字串,以及讀帳失敗時的帳戶幣別對照表(十個帳戶,統一期貨 president 與 Bitget 在網頁是 hidden 條目、仍要帶 ccy)。一邊改了、另一邊沒跟就紅。
// (倍數提醒門檻 LEV_T* 已隨電腦版安全檢查拿掉,Wei 10-13;不再比對)
//   電腦版:shell/renderer/trade.js 的 CX_VENUES[].ccy + TR_VENUE_CCY_OTHER
//   網頁:web/app/main/templates/agent/workspace.html 的 CX_VENUES[].ccy
// 網頁那棵用 BLAVE_WEB_DIR 指定(預設 monorepo 的 ../web);找不到就 fail,不 SKIP——不比對等於沒有這支測試。
// 跑法:BLAVE_WEB_DIR=/path/to/web node tests/check_web_desktop_parity.js
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
  const re = (src, kw, name) => { const m = src.match(new RegExp("^\\s*" + kw + " " + name + " = (/.*/[a-z]*);$", "m")); return m ? m[1].replace(/(^|[^\\])\(([^()?][^()]*)\)(?![*+?{])/g, "$1$2") : null; };
  const tags = ["CARD_TAG", "SUG_BLOCK", "SUG_OPEN_TAIL", "AWAIT_TAG"], off = tags.filter((n) => !re(appSrc, "const", n) || re(appSrc, "const", n) !== re(rc, "var", n));
  ok("回覆摘錄的四條標記 regex 兩邊同一份", off.length === 0, off.map((n) => n + ": " + re(appSrc, "const", n) + " vs " + re(rc, "var", n)).join(";"));
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
    // 按了才算(spec §3.6,10-27):鈕、過時句、BUSY 那行、回合中那句;還原後重跑中那句是掃描／驗證／成交測試共用的
    "xt.btnRun": "workspace_xt_btn_run", "xt.btnRerun": "workspace_xt_btn_rerun", "xt.btnBusy": "workspace_xt_btn_busy", "xt.btnTip": "workspace_xt_btn_tip",
    "xt.verdictStale": "workspace_xt_verdict_stale", "xt.busyRefresh": "workspace_xt_busy_refresh", "xt.busyTurn": "workspace_xt_busy_turn",
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
    ["cell", { cfg: false, perf: "running" }, 3], ["cell", { cfg: null }, 3], ["cell", { cfg: true, perf: "running", mine: "run" }, 5], ["cell", { cfg: true, perf: "running", mine: "busy", turn: true }, 5],
    ["cell", { cfg: true, perf: "failed", mine: "fail", turn: true }, 8], ["cell", { cfg: true, perf: "failed", mine: "busy" }, 0], ["cell", { cfg: true, perf: "failed", mine: null }, 0],
    ["cell", { cfg: true, turn: true }, 9], ["cell", { cfg: true }, 0]];
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
console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
