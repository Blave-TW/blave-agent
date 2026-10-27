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
  "tr.ov.evBitgetNoStopNote": "workspace_ov_ev_bitget_nostop_note", "tr.ov.evBitgetStopsUnknown": "workspace_ov_ev_bitget_stops_unknown" };
for (const lang of ["zh", "en"]) {
  const dp = poMap(path.join(__dirname, "..", "shell", "i18n", lang + ".po")), wp = poMap(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po"));
  const bad = Object.entries(BITGET_PAIRS).filter(([d, w]) => typeof dp[d] !== "string" || typeof wp[w] !== "string" || dp[d] !== wp[w]);
  ok(`Bitget 換帳戶類型的暫停句／清單／事件列 ${lang} 兩邊逐字一致(${Object.keys(BITGET_PAIRS).length} 句)`, bad.length === 0,
    bad.map(([d, w]) => d + "「" + dp[d] + "」 vs " + w + "「" + wp[w] + "」").join(";"));
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
    "set.theme": "workspace_set_theme", "set.lang": "workspace_set_lang", "set.ccy": "workspace_set_base_ccy", "set.rn": "workspace_rn_notify",
    "rlang.label": "workspace_reply_lang", "rules.head": "workspace_rules_head", "rules.add": "workspace_rules_add",
    "rules.emptyLead": "workspace_rules_empty_lead", "rules.emptyHow": "workspace_rules_empty_how" };
  for (const lang of ["zh", "en"]) {
    const d = poMap(path.join(__dirname, "..", "shell", "i18n", lang + ".po")), w = poMap(path.join(webDir, "app", "translations", lang, "LC_MESSAGES", "messages.po"));
    const bad = Object.entries(SETTINGS_PAIRS).filter(([dk, wk]) => !d[dk] || d[dk] !== w[wk]);
    ok("設定 modal 分類名與一般／Agent／連結裡的字兩邊逐字一致(" + lang + "," + Object.keys(SETTINGS_PAIRS).length + " 組)", bad.length === 0, bad.map(([dk, wk]) => dk + "「" + d[dk] + "」 vs " + wk + "「" + w[wk] + "」").join(";"));
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
    "ver.frozenRerun": "workspace_ver_frozen_rerun" };
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
console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
