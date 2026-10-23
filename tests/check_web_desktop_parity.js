// 電腦版與網頁兩個表面要同一份的常數(稽核 audit-0.1.13-web C3):階段表 PHASE_OF / PHASE_NONE、
// 回測 Type C 的買進持有基準字串、回覆通知的摘錄測資／標記 regex／前綴字串,以及讀帳失敗時的帳戶幣別對照表(九個帳戶,統一期貨 president 在網頁是 hidden 條目、仍要帶 ccy)。一邊改了、另一邊沒跟就紅。
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
ok("幣別對照表兩邊同一份(九個帳戶)", Object.keys(dt).length === 9 && sorted(dt) === sorted(wt), sorted(dt) + " vs " + sorted(wt));
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
console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
