/* 雲端視角的事件清單在畫面上怎麼畫(shell/renderer/trade.js 的事件那一段)。
 * 傳輸層在 tests/check_shell_cloud.js(cloud.js)與 tests/check_shell_envsw.js(envApi),這裡只管「畫成哪一句」:
 *   1. 事件清單稽核(designer events-list-audit-2026-10-20):desktop_action 不畫、三層級別、×N、補畫的型別、0.1.28 新文案
 *   2. 那些 key 兩語都在(缺一邊就會在那個語系露出英文或 key)
 *   3. ui 那一段吃得下平台格式(欄位包在 data 裡)、認不得的型別交給 trEventText、halt 分得出自動與人按的
 * 跑法:node tests/check_shell_cloud_events.js
 */
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "trade.js"), "utf8");
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };

// 用假的 t():回 key + 代進去的值,才看得出「用了哪個 key」而不只是「有字」
const seen = [];
const t = (key, vars) => { seen.push(key); return vars ? key + "|" + JSON.stringify(vars) : key; };
const trVenueLabel = (id) => id || "";
const cut = (from, to) => { const i = src.indexOf(from), j = src.indexOf(to, i); if (i < 0 || j < 0) throw new Error("找不到標記:" + from); return src.slice(i, j); };
eval(cut("const TR_EV_P1 = [", "\nfunction trOvEvents(").replace(/^const /gm, "var "));

const J0 = JSON.stringify;
ok("desktop_action 整類不畫(用戶自己按的指令回音,Wei 10-20)", ["halt", "update", "newcmd", ""].every((a) => trEventText("desktop_action", { action: a, device: "Mac" }) === null));
ok("其他型別不受影響(機器事件照舊)", J0(trEventText("exchange_recovered", { venue: "binance" })[0]) === J0(["tr.ov.evExBack", { venue: "binance" }]) && trEventText("nope", {}) === null);

// 0.1.28 機器事件(api agent_events 白名單;句子同網頁 ovEventRow,兩邊門檻一致)
{ const J = JSON.stringify, E = (ty, d) => trEventText(ty, d);
  ok("bar_stale computed=true → 不畫(訊號已準時算出)", E("bar_stale", { strategy: "s1", symbol: "ETHUSDT", minutes: 7, computed: true }) === null);
  ok("bar_stale computed 不是 true(false / 缺 / 字串 / 1)→ 舊那句",
    [false, undefined, "true", 1].every((c) => J(E("bar_stale", { symbol: "X", minutes: 3, computed: c }).slice(0, 2)) === J(["tr.ov.evBarStale", 'tr.ov.evBarStaleNote|{"venue":"","minutes":3}'])));
  ok("bar_stale 沒 minutes → 不出註解", E("bar_stale", { symbol: "X" })[1] === null);
  const ts = (age) => E("target_stale", { strategy: "s2", keys: ["BTC"], age_s: age })[1];
  ok("target_stale 時間換算同 api _age_text(<120 分、<48 小時、其餘天,取整)",
    J([0, 59, 60, 7199, 7200, 172799, 172800, 259199].map(ts)) === J(['tr.ov.evTargetStaleMin|{"n":0}', 'tr.ov.evTargetStaleMin|{"n":0}', 'tr.ov.evTargetStaleMin|{"n":1}', 'tr.ov.evTargetStaleMin|{"n":119}',
      'tr.ov.evTargetStaleHour|{"n":2}', 'tr.ov.evTargetStaleHour|{"n":47}', 'tr.ov.evTargetStaleDay|{"n":2}', 'tr.ov.evTargetStaleDay|{"n":2}']));
  ok("target_stale 沒 / 壞 age_s → 不帶時間那句(後果不消失)", [undefined, null, -5, "3600", NaN, Infinity].every((a) => ts(a) === "tr.ov.evTargetStaleNote"));
  ok("target_stale 策略在策略段(另一個節點),標題不拼它;沒有就只有標題", J(E("target_stale", { strategy: "s2" }).slice(4)) === J([null, null, { text: "s2", code: true }]) && E("target_stale", { strategy: "s2" })[0] === "tr.ov.evTargetStale" && E("target_stale", {})[6] === null);
  const syms = (n) => Array.from({ length: n }, (_x, i) => "S" + i), dm = (list) => E("dead_members", { strategy: "s3", symbols: list });
  ok("dead_members ≤10 檔全列(標的是代號);0.1.46 起帶策略段", J(dm(syms(10))) === J(["tr.ov.evDeadMembers", "tr.ov.evDeadMembersNote", 2, null, syms(10).join(", "), null, { text: "s3", code: true }]));
  ok("dead_members 11 檔 → 前 10 + 等 1(total/more 兩個都給)", dm(syms(11))[4] === syms(10).join(", ") && dm(syms(11))[5] === 'tr.ov.evDeadMore|{"total":11,"more":1}');
  ok("dead_members 去 @spot、濾掉空與非字串;沒 symbols 只剩標題", dm(["A@spot", "", null, 5, "B"])[4] === "A, B" && E("dead_members", { strategy: "s3" })[0] === "tr.ov.evDeadMembers" && !E("dead_members", { strategy: "s3" })[4]);
  ok("不認得的型別照舊不顯示", E("target_stale_v2", {}) === null);
  // 三層級別(第三格):P1 紅、P2 強調、P3 一般字
  const LV = (ty, d) => (E(ty, d || { strategy: "s", symbol: "X", minutes: 1 }) || [])[2];
  ok("P1:下單執行、市場對不上、設定沒存成、重開沒停住、停機凍結", ["execution_interrupted", "execution_fallback_market", "execution_stuck", "manual_close_required",
    "market_hold", "settings_unsafe", "machine_restart_stop_failed", "downtime_paused"].every((ty) => LV(ty) === 1));
  ok("P2:其餘該知道的", ["reconciler_dead", "strategy_failed", "bar_stale", "target_stale", "dead_members", "scheduler_error", "venue_unbound",
    "market_check_off", "ui_override", "settings_rollback_failed", "report_degraded", "exchange_unreachable", "machine_silent", "disk_full",
    "memory_low", "report_rejected"].every((ty) => LV(ty) === 2));
  ok("P3:恢復類", ["reconciler_recovered", "machine_recovered", "exchange_recovered"].every((ty) => LV(ty) === 3));
  ok("主機重開依 trigger:意外/沒帶 P1、resume P2、upgrade P3", J(["unexpected", undefined, "resume", "upgrade"].map((tg) => LV("machine_restart_stopped", { trigger: tg }))) === J([1, 1, 2, 3]));
  ok("halt 級別:自動(reconciler/portfolio)P1,其他 P3", J([trEvLevel("halt", { source: "reconciler" }), trEvLevel("halt", { source: "portfolio" }), trEvLevel("halt", { source: "web" }), trEvLevel("halt", {})]) === J([1, 1, 3, 3]));
  ok("級別 → class:1 err、2 hl、3 空", trEvClass(1) === "err" && trEvClass(2) === "hl" && trEvClass(3) === "");
  ok("exchange_unreachable:說明縮短、後半句進 tooltip", J(E("exchange_unreachable", { venue: "okx", minutes: 30 })) === J([["tr.ov.evExUnreach", { venue: "okx", minutes: 30 }], "tr.ov.evExUnreachNote", 2, "tr.ov.evExUnreachTip", null, null, null]));
  ok("群益讀不到 ≥150 分(第二則起)是 P1、換群益那句、小時取整;30 分那則與加密交易所照舊 P2",
    J(E("exchange_unreachable", { venue: "capital", minutes: 270 })) === J([["tr.ov.evExUnreachCap", { hours: 4 }], "tr.ov.evExUnreachCapNote", 1, null, null, null, null])
    && E("exchange_unreachable", { venue: "capital", minutes: 150 })[2] === 1 && E("exchange_unreachable", { venue: "capital", minutes: 30 })[2] === 2
    && E("exchange_unreachable", { venue: "capital", minutes: 149 })[2] === 2 && E("exchange_unreachable", { venue: "okx", minutes: 600 })[2] === 2
    && trEvLevel("exchange_unreachable", { venue: "capital", minutes: 150 }) === 1);
  { globalThis.TR = { env: "local" };   // 本機視角:說明換成帶「或重開 Blave」的那句
    const k = E("exchange_unreachable", { venue: "capital", minutes: 270 })[1];
    delete globalThis.TR;
    const S = new Function(fs.readFileSync(path.join(R, "strings.js"), "utf8").replace(/^const STRINGS =/m, "return"))();
    ok("本機視角(TR.env=local)拿到 Local 版:zh 含「或重開 Blave」、en 含「or restart Blave」",
      k === "tr.ov.evExUnreachCapNoteLocal" && /或重開 Blave/.test(S.zh[k] || "") && /or restart Blave/.test(S.en[k] || "")
      && E("exchange_unreachable", { venue: "capital", minutes: 270 })[1] === "tr.ov.evExUnreachCapNote"); }
  ok("execution_stuck 分 overdue／abandoned／其他", J(["overdue", "abandoned", "x"].map((k) => E("execution_stuck", { kind: k }).slice(0, 2))) === J([["tr.ov.evExecOverdue", "tr.ov.evExecStuckNote"], ["tr.ov.evExecAbandoned", "tr.ov.evExecAbandonedNote"], ["tr.ov.evExecStuck", "tr.ov.evExecStuckNote"]]));
  ok("market_hold 策略在策略段、不拼進標題", E("market_hold", { strategy: "s4", venue: "okx" })[0] === "tr.ov.evMarketHold" && J(E("market_hold", { strategy: "s4" })[6]) === J({ text: "s4", code: true }) && E("market_hold", { strategy: "s4" })[1] === "tr.ov.evMarketHoldNote");
  ok("settings_unsafe / rollback_failed / market_check_off 各自一句", J([E("settings_unsafe", {}), E("settings_rollback_failed", {}), E("market_check_off", { kind: "table" })].map((x) => x.slice(0, 2)))
    === J([["tr.ov.evSettingsUnsafe", "tr.ov.evSettingsUnsafeNote"], ["tr.ov.evSettingsRollbackFailed", "tr.ov.evSettingsRollbackFailedNote"], ["tr.ov.evMarketCheckOff", "tr.ov.evMarketCheckOffNote"]]));
  ok("reconciler / machine / venue_unbound / ui_override 照網頁有句子", E("reconciler_dead", {})[0] === "tr.ov.evRecDead" && E("reconciler_recovered", {})[0] === "tr.ov.evRecBack"
    && E("machine_recovered", {})[0] === "tr.ov.evMachineBack" && J(E("venue_unbound", { venue: "okx" })[0]) === J(["tr.ov.evVenueUnbound", { venue: "okx" }]) && E("ui_override", {})[1] === "tr.ov.evUiOverrideNote");
  const long = "長".repeat(45);
  ok("report_rejected:標題 40 字截斷、沒標題用 report_id", E("report_rejected", { title: long, field: "a.b" })[0] === 'tr.ov.evReportRejected|{"title":"' + "長".repeat(40) + '…"}'
    && E("report_rejected", { report_id: "r1" })[0] === 'tr.ov.evReportRejected|{"title":"r1"}'
    && E("report_rejected", { title: "長".repeat(41) })[0] === 'tr.ov.evReportRejected|{"title":"' + "長".repeat(40) + '…"}'
    && E("report_rejected", { title: "長".repeat(40) })[0] === 'tr.ov.evReportRejected|{"title":"' + "長".repeat(40) + '"}');
  ok("report_degraded:count ≥1 帶次數、缺/0 用不帶次數那句", E("report_degraded", { title: "晨報", count: 3 })[1] === 'tr.ov.evReportDegradedNote|{"count":3}'
    && E("report_degraded", { title: "晨報" })[1] === "tr.ov.evReportDegradedNoteNoCount" && E("report_degraded", { title: "晨報", count: 0 })[1] === "tr.ov.evReportDegradedNoteNoCount"); }

// 群益讀不到 ≥150 分的說明:雲端視角不叫人「重開 Blave」(雲端主機沒有 app,同 api notify 那句),本機視角與本機系統通知才加
{ const STR = new Function(fs.readFileSync(path.join(R, "strings.js"), "utf8").replace(/^const STRINGS =/m, "return"))();
  const body = cut("const TR_EV_P1 = [", "\nfunction trEvBody(").replace(/^const /gm, "var ");
  const note = (lang, env) => new Function("t", "trVenueLabel", "TR", body + "\nreturn trEventText;")(
    (k, v) => { let s = STR[lang][k] || k; for (const x in v || {}) s = s.split("{" + x + "}").join(v[x]); return s; }, (x) => x, { env })(
    "exchange_unreachable", { venue: "capital", minutes: 300 })[1];
  ok("雲端視角那則不含「重開 Blave」、跟 api 句子一致;本機視角帶「或重開 Blave」",
    !/重開 Blave/.test(note("zh", "cloud")) && !/restart Blave/.test(note("en", "cloud"))
    && note("zh", "cloud") === "這段時間群益策略不會下單，也不會平倉。請檢查群益連線。"
    && note("en", "cloud") === "Capital strategies place no orders and no closes meanwhile. Check the Capital connection."
    && /或重開 Blave。$/.test(note("zh", "local")) && /or restart Blave\.$/.test(note("en", "local")));
  ok("本機系統通知的字用本機版", /ev_exchange_unreachable_capital_n: t\("tr\.ov\.evExUnreachCapNoteLocal"\)/.test(src)); }

// 值缺整句不出:用一份帶佔位的 t(上面的假 t 沒有 {x} 佔位)
{ const real = { "tr.ov.evMachineSilentNote": "{minutes} m", "tr.ov.evDiskFullNote": "{disk_pct} d", "tr.ov.evMemLowNote": "{mem_avail}/{mem_total}", "tr.ov.evReportRejectedNote": "at {field}", k: "a {x} b {y}" };
  const tt = (key, vars) => { let s = real[key] || key; if (vars) for (const k in vars) s = s.split("{" + k + "}").join(vars[k]); return s; };
  const W = new Function("t", "trVenueLabel", cut("const TR_EV_P1 = [", "\nfunction trEvBody(").replace(/^const /gm, "var ") + "\nreturn { trEventText, trEvNote };")(tt, (x) => x);
  ok("trEvNote:值齊才出、缺一個(null/空字串)就 null", W.trEvNote("k", { x: 1, y: 2 }) === "a 1 b 2" && W.trEvNote("k", { x: 1 }) === null && W.trEvNote("k", { x: 1, y: "" }) === null);
  const E2 = (ty, d) => W.trEventText(ty, d)[1];
  ok("machine_silent / disk_full / memory_low / report_rejected:值缺就不出說明(同網頁 evNote)",
    E2("machine_silent", { minutes: 12 }) === "12 m" && E2("machine_silent", {}) === null && E2("disk_full", { disk_pct: 91.5 }) === "91.5% d" && E2("disk_full", {}) === null
    && E2("memory_low", { mem_avail_mb: 80, mem_total_mb: 1024 }) === "80MB/1024MB" && E2("memory_low", { mem_avail_mb: 80 }) === null
    && E2("report_rejected", { title: "x", field: "a.b" }) === "at a.b" && E2("report_rejected", { title: "x" }) === null); }


// 兩語齊:缺一邊就會在那個語系露出英文或 key
{ const S = fs.readFileSync(path.join(R, "strings.js"), "utf8");
  const block = (n) => S.split(`  ${n}: {`)[1].split("\n  },")[0];
  const keysOf = (b) => new Set([...b.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
  const en = keysOf(block("en")), zh = keysOf(block("zh"));
  const need28 = [...new Set([...cut("const TR_EV_P1 = [", "\nfunction trOvEvents(").matchAll(/"(tr\.ov\.ev[A-Za-z]+)"/g)].map((m) => m[1]))].concat(["tr.ov.evTargetStale", "tr.ov.evTargetStaleNote", "tr.ov.evTargetStaleMin", "tr.ov.evTargetStaleHour", "tr.ov.evTargetStaleDay", "tr.ov.evDeadMembers", "tr.ov.evDeadMembersNote", "tr.ov.evDeadMore"]);
  const miss28 = need28.filter((k) => !en.has(k) || !zh.has(k));
  ok("事件文案用到的 " + need28.length + " 個 key 兩語都在:" + (miss28.join() || "無缺"), need28.length > 40 && miss28.length === 0);
  const valsOf = (b) => Object.fromEntries([...b.matchAll(/^\s*("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*"),?$/gm)].map((m) => [JSON.parse(m[1]), JSON.parse(m[2])]));
  const enV = valsOf(block("en")), zhV = valsOf(block("zh"));
  ok("「對帳器」對外字串全拿掉(改「下單程式」)", ![...Object.values(zhV), ...Object.values(enV)].some((x) => /對帳器|reconciler/i.test(x)));
  ok("停機凍結那句縮短:連平倉也不做、按啟動下單恢復", zhV["tr.ov.evDowntimeNote"] === "全部凍結，連平倉也不做，按「啟動下單」恢復");
  ok("renderer 不出現中文字面(放的是 key,不是句子)", !/[一-鿿]/.test(cut("const TR_EV_P1 = [", "\nfunction trOvEvents(").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))); }

// ui 那一段(會碰 DOM,只驗寫法)
{ const loop = cut("const ui = (Array.isArray(TR.ov.ui)", "// 目前的 HALT");
  ok("ui:平台格式的欄位包在 data 裡,這台電腦那一份在最外層——兩邊同一支迴圈", /const d = ev\.data && typeof ev\.data === "object" \? ev\.data : ev;/.test(loop) && /String\(d\.venue \|\| ""\)/.test(loop));
  ok("ui:認不得的型別交給 trEventText(雲端才有的 desktop_action / 交易所連不上…),還是認不得就不畫", /else \{ const txt = trEventText\(ev\.type, d, trEvStrat\(d\.strategy, ev\.strategy_label\)\); if \(txt\) \[head, note, lv, tip, code, tail, strat\] = txt; \}/.test(loop) && /if \(!head\) return;/.test(loop));
  ok("ui:halt 誰按的看 source(鏡射平台的 _HALT_AUTO_SOURCES);沒有 source = 人按的", /lv = trEvLevel\(ev\.type, d\); const closes = lv !== 1 && trHaltCloses\(ev\.type, trHaltNow\(ev, d, r\)\); head = t\(lv === 1 \? "tr\.ov\.evHaltAuto" : closes \? "tr\.ov\.evHaltClose" : d\.by === "phone" \? "tr\.ov\.evHaltPhone" : "tr\.ov\.evHalt"\)/.test(loop));
  // 0.1.28 Wei 實測:按「暫停並關閉部位」事件只寫「已暫停下單」。這台電腦的 halt_close 看 daemon 記的 closing;
  // 雲端 halt 與現在的 HALT 看 runtime 判完才寫的 closing(稽核 B-3),沒有這欄(舊 runtime)才退回寫死的 reason
  ok("ui:暫停並關閉部位寫成關閉部位;只掛了暫停(closing false)、一般暫停、別的 reason 照舊寫已暫停",
    trHaltCloses("halt_close", { closing: true }) && trHaltCloses("halt_close", {}) && !trHaltCloses("halt_close", { closing: false })
    && trHaltCloses("halt", { source: "web", reason: "close all positions" }) && trHaltCloses("halt", { source: "flatten", reason: "close all positions" })
    && !trHaltCloses("halt", { source: "web", reason: "user request" }) && !trHaltCloses("halt", {}) && !trHaltCloses("halt", null)
    && !trHaltCloses("halt", { source: "web", reason: "close all positions", closing: false }) && trHaltCloses("halt", { source: "web", reason: "close all positions", closing: true })
    && /const closes = !auto && trHaltCloses\("halt", halt\);/.test(cut("// 目前的 HALT", "trUnconfirmedRows(r.order_errors)"))
    && /t\(closes \? "tr\.ov\.evHaltClose" : trHaltByPhone\(halt\) \? "tr\.ov\.evHaltPhone" : "tr\.ov\.evHalt"\)/.test(cut("// 目前的 HALT", "trUnconfirmedRows(r.order_errors)")));
  ok("ui:下單失敗不在這一段(雲端的 portfolio 仍帶 order_errors,兩邊都畫會重複)", !/order_error/.test(loop));
  // 稽核 r2 P2-2／r3 P3-1、P3-3:雲端 halt 事件對到現在這筆 HALT 的規則(同網頁 ovHaltCloses)——ts 與 halt.at 差 ≤1 秒、reason 相同;
  // 對到時 closing 先看報告現在的值,對不上照事件自己的(再退回 reason)。這台電腦記的那筆(欄位在最外層)不動
  { const fnOf = (n) => { const i = src.indexOf("function " + n + "("); let k = src.indexOf("{", i), dep = 0; for (; k < src.length; k++) { if (src[k] === "{") dep++; else if (src[k] === "}" && --dep === 0) break; } return src.slice(i, k + 1); };
    const H = {}; new Function("H", fnOf("trMs") + "\n" + fnOf("trHaltNow") + "\nH.trMs = trMs; H.trHaltNow = trHaltNow;")(H);
    const T = 1792600000, at = (x) => new Date(x * 1000).toISOString(), CA = "close all positions";
    const ev = (ts, data) => ({ ts, type: "halt", data }), cur = (x, closing, reason = CA) => ({ halted: true, at: at(x), reason, source: "web", closing });
    const decide = (e, r) => trHaltCloses("halt", H.trHaltNow(e, e.data, { halt: r }));
    const cases = [
      ["同一秒、同 reason:事件凍住 false、現在 true → 平倉", decide(ev(T, { reason: CA, closing: false }), cur(T, true)), true],
      ["事件比 halt.at 多 1 秒(MySQL 四捨五入):照樣對到 → 平倉", decide(ev(T + 1, { reason: CA, closing: false }), cur(T + 0.6, true)), true],
      ["事件比 halt.at 少 1 秒:照樣對到", decide(ev(T - 1, { reason: CA, closing: false }), cur(T, true)), true],
      ["差 2 秒:不是同一筆,照事件自己的 false", decide(ev(T + 2, { reason: CA, closing: false }), cur(T, true)), false],
      ["一分鐘前的一般暫停、現在是平倉:不對過去", decide(ev(T - 60, { reason: "user request" }), cur(T, true)), false],
      ["同一秒、reason 不同:不對過去", decide(ev(T, { reason: "user request" }), cur(T, true)), false],
      ["現在 closing false、事件凍住 true:報告優先 → 只是暫停", decide(ev(T, { reason: CA, closing: true }), cur(T, false)), false],
      ["舊 runtime(報告沒有 closing):退回事件自己的值", decide(ev(T, { reason: CA, closing: false }), cur(T, undefined)), false],
      ["舊 runtime 且事件也沒有 closing:退回 reason", decide(ev(T, { reason: CA }), cur(T, undefined)), true],
      ["現在沒有 HALT:照事件", decide(ev(T, { reason: CA, closing: false }), { halted: false }), false],
    ];
    const bad = cases.filter((c) => c[1] !== c[2]).map((c) => c[0]);
    const local = { ts: T, type: "halt", reason: CA, closing: false };
    ok("trHaltNow 行為:" + cases.length + " 種對應全對" + (bad.length ? "(錯:" + bad.join("／") + ")" : "") + ";這台電腦記的那筆(d === ev)原樣",
      !bad.length && H.trHaltNow(local, local, { halt: cur(T, true) }) === local); }
  ok("ui:時間仍然是秒(平台與這台電腦同一個單位)", /uiHalts\.push\(ev\.ts \* 1000\)/.test(loop) && /push\(ev\.ts \* 1000,/.test(loop));
  ok("ui:雲端記的 venue_disconnected P2、這台電腦自己按的一般字", /lv = d !== ev \? 2 : 3;/.test(loop));
  ok("現在的 HALT 那列顏色照級別(execute/settings 暫停不再紅,P1 由對應事件那列承擔)", /trEl\("span", trEvClass\(trEvLevel\("halt", halt\)\),/.test(cut("// 目前的 HALT", "trUnconfirmedRows(r.order_errors)")));
  ok("ui 與機器事件兩段都走 trEvBody(帶 ev.count)", (src.match(/trEvBody\(body, .*?, ev\.count, .*?\)\)?;/g) || []).length === 2);   // 機器事件那段 0.1.50 起是區塊(後面接事件列的出口鈕)
  ok("兩段的顏色都先讀 api 的 level、缺才用自己算的", /trEvBody\(body, head, note, trEvApiLevel\(ev\) \|\| lv, tip, ev\.count, code, tail, strat\)/.test(src)
    && /trEvBody\(body, txt\[0\], txt\[1\], trEvApiLevel\(ev\) \|\| txt\[2\], txt\[3\], ev\.count, txt\[4\], txt\[5\], txt\[6\]\)/.test(src));
  ok("機器事件那段的策略段同 ui 那段(雲端讀 strategy_label、這台電腦查清單)", /const txt = trEventText\(ev\.type, evd, trEvStrat\(evd\.strategy, ev\.strategy_label\)\);/.test(src));
  ok("下單失敗那列也接 ×N(order_errors 的 count),在標題後、標的前", /t\("tr\.ov\.evErr"\)\)\);\n\s*trEvCount\(body, e\.count\);/.test(cut("trUnconfirmedRows(r.order_errors).forEach(", "(Array.isArray(r.events)"))); }
ok("trEvApiLevel:P1/P2/P3 → 1/2/3;缺、小寫、P4、數字、非物件 → null",
  JSON.stringify([trEvApiLevel({ level: "P1" }), trEvApiLevel({ level: "P2" }), trEvApiLevel({ level: "P3" }), trEvApiLevel({}), trEvApiLevel({ level: "p1" }),
    trEvApiLevel({ level: "P4" }), trEvApiLevel({ level: 1 }), trEvApiLevel({ level: " P1" }), trEvApiLevel(null)]) === JSON.stringify([1, 2, 3, null, null, null, null, null, null]));

// trEvBody:標題級別色 → ×N(≥2 才出、取整,mono dim)→ 代號(mono)→ 補充 → 說明;tooltip 掛在說明
{ function N(tag, cls, text) { this.cls = cls || ""; this.text = text == null ? "" : String(text); this.kids = []; this.title = ""; }
  N.prototype.appendChild = function (c) { this.kids.push(c); return c; };
  N.prototype.append = function (...xs) { xs.forEach((x) => this.kids.push(typeof x === "string" ? { text: x, kids: [] } : x)); };
  const mk = (tag, cls, text) => new N(tag, cls, text), flat = (n) => n.text + n.kids.map(flat).join("");
  const tpl = { k: "{venue} down {minutes} m", "tr.ov.evStratName": "「{name}」" };
  const fn = new Function("trEl", "trEvClass", "t", cut("function trEvHead(", "/* 事件 = 狀態改變") + "\nreturn trEvBody;")(mk, trEvClass,
    (k, v) => { let x = tpl[k] || k; if (v) for (const n in v) x = x.split("{" + n + "}").join(v[n]); return x; });
  const run = (count, note, tip, code, tail, head) => { const b = new N("span", "body"); fn(b, head || "H", note, 1, tip, count, code, tail); return b; };
  ok("trEvBody:×N 在標題後、說明前", flat(run(4, "NOTE")) === "H ×4 — NOTE" && run(4, "NOTE").kids[0].cls === "err" && run(4, "NOTE").kids[2].cls === "mono dim");
  const wc = run(3, "N", null, "1101, 1216", "T");
  ok("trEvBody:×N 在代號前(接在代號後會被讀成倍數);代號 mono、補充一般字", flat(wc) === "H ×3 1101, 1216 T — N" && wc.kids[2].cls === "mono dim" && wc.kids[4].cls === "mono" && wc.kids[6].cls === "");
  const tv = run(2, null, null, null, null, ["k", { venue: "Binance", minutes: 12 }]), hd = tv.kids[0];
  ok("trEvBody:[key, vars] 標題的值包 mono、字上級別色,整句一個節點,×N 接在整句後",
    flat(tv) === "Binance down 12 m ×2" && hd.cls === "" && JSON.stringify(hd.kids.map((k) => k.cls)) === JSON.stringify(["mono", "err", "mono", "err"]) && tv.kids[2].cls === "mono dim");
  ok("trEvBody:[key, vars] 缺值那格不出(不印 undefined)", flat(run(0, null, null, null, null, ["k", { venue: "Binance" }])) === "Binance down  m");
  ok("trEvBody:count 1／缺／字串／NaN 不出,2.9 取 2", ["H — N", "H — N", "H — N", "H — N", "H ×2 — N"].join("|") === [1, undefined, "3", NaN, 2.9].map((c) => flat(run(c, "N"))).join("|"));
  ok("trEvBody:沒說明只剩標題(+×N);tooltip 掛在說明的 title", flat(run(3, null)) === "H ×3" && run(0, "N", "TIP").kids.slice(-1)[0].title === "TIP");
  const sb = (strat) => { const b = new N("span", "body"); fn(b, "H", "N", 2, null, 2, null, null, strat); return b; };
  const nm = sb({ text: "台指期 籌碼", code: false }), cd = sb({ text: "txf_flow", code: true });
  ok("trEvBody:策略段在 ×N 後、說明前;zh 包「」;名稱一般字、代號 mono", flat(nm) === "H ×2 「台指期 籌碼」 — N" && nm.kids[4].kids[1].cls === "" && cd.kids[4].kids[1].cls === "mono" && flat(sb(null)) === "H ×2 — N"); }

// 帶策略的五種事件:第 7 格是策略段(0.1.46 起 bar_stale／strategy_failed／scheduler_error 也帶,用戶看到兩列一模一樣的「K 棒沒到位」)
{ const S = { text: "ETH 均線", code: false };
  const five = [["bar_stale", { strategy: "eth_ma", minutes: 3 }], ["strategy_failed", { strategy: "eth_ma" }], ["scheduler_error", { strategy: "eth_ma" }],
    ["target_stale", { strategy: "eth_ma", age_s: 60 }], ["market_hold", { strategy: "eth_ma", venue: "okx" }]];
  ok("五種都帶呼叫端給的策略段", five.every(([ty, d]) => trEventText(ty, d, S)[6] === S));
  ok("沒給就寫代號(mono)", five.every(([ty, d]) => JSON.stringify(trEventText(ty, d)[6]) === JSON.stringify({ text: "eth_ma", code: true })));
  ok("target_stale／market_hold 的代號不再塞在代號格", trEventText("target_stale", five[3][1], S)[4] === null && trEventText("market_hold", five[4][1], S)[4] === null);
  ok("沒有策略欄位就沒有策略段;其他型別不帶", trEventText("strategy_failed", {})[6] === null && trEventText("exchange_recovered", { venue: "binance", strategy: "x" }, S)[6] === null); }

// trEvStrat:雲端用 api 的 strategy_label(等於代號 = 沒名稱),沒有這欄才查清單並套同一份規則
{ const list = [{ name: "eth_ma", displayName: "ETH 均線" }, { name: "phish", displayName: "到 t.me/x" }, { name: "same", displayName: "same" }];
  const F = new Function(cut("function trDisplay(n)", "\n\n/* ── 開/關視圖").replace(/^const /gm, "var ") + "\nreturn trEvStrat;");
  const TRg = globalThis.TR; globalThis.TR = { list };
  try {
    const st = F(), J = JSON.stringify;
    ok("api 給了名稱就用", J(st("eth_ma", "ETH 均線交叉")) === J({ text: "ETH 均線交叉", code: false }));
    ok("api 給的等於代號 = 沒名稱,寫代號", J(st("phish", "phish")) === J({ text: "phish", code: true }));
    ok("沒有 strategy_label:查清單,名稱過規則才用", J(st("eth_ma")) === J({ text: "ETH 均線", code: false }) && J(st("phish")) === J({ text: "phish", code: true })
      && J(st("same")) === J({ text: "same", code: true }) && J(st("gone")) === J({ text: "gone", code: true }));
    ok("沒有代號就沒有策略段", st("", "x") === null && st(undefined) === null);
    // 從主行程 interpretEvents 進來(api 回的列原樣):strategy_label／count／level 要活著走到 renderer,同名補代號才看得到
    const { interpretEvents } = require(path.join(__dirname, "..", "shell", "cloud.js"));
    const got = interpretEvents({ status: 200, body: { events: [
      { ts: 1, type: "strategy_failed", data: { strategy: "same" }, strategy_label: "same（same）", count: 3, level: "P2", strategy_labels: ["a", 7] },
      { ts: 2, type: "bar_stale", data: { strategy: "eth_ma" }, strategy_label: 5, count: 0, level: "P9" }] } }).events;
    ok("interpretEvents 留 api 的 strategy_label → 畫成 api 的名稱(同名補代號那份)", J(st(got[0].data.strategy, got[0].strategy_label)) === J({ text: "same（same）", code: false }));
    ok("interpretEvents 留 count／level／strategy_labels,型別不對的丟掉", got[0].count === 3 && got[0].level === "P2" && J(got[0].strategy_labels) === J(["a", ""])
      && !("strategy_label" in got[1]) && !("count" in got[1]) && !("level" in got[1]) && J(st(got[1].data.strategy, got[1].strategy_label)) === J({ text: "ETH 均線", code: false }));
  } finally { globalThis.TR = TRg; } }


/* 讀不到 ≠ 沒有事件(這條是硬規則:畫面不可以替資料說「這段期間什麼都沒發生」)。
   三態:讀到了有事件 / 讀到了真的沒有 / 讀不到——各畫各的。 */
{ const load = cut("async function trLoadCurve(", "function trCurvePoints(");
  ok("讀不到:catch 也記成 uiErr(不是靜靜給一個空清單),不往上拋", /catch \(_\) \{ if \(S\.ov\.days !== days\) return; S\.ov\.ui = \[\]; S\.ov\.uiErr = true; \}/.test(load) && /S\.ov\.uiErr = !ev \|\| ev\.code !== "OK";/.test(load));
  const ev = cut("  if (TR.ov.uiErr) frag.appendChild", "  rows.sort(");
  ok("讀不到:畫既有語氣的那一句(pf-state,沒有新元件 / 新 token),而且**不**畫「這段期間沒有事件」",
    /frag\.appendChild\(trEl\("div", "pf-state", t\("tr\.ov\.evUnreach"\)\)\);/.test(ev) && /if \(!rows\.length\) \{ if \(!TR\.ov\.uiErr\) frag\.appendChild\(trEl\("div", "pf-state", t\("tr\.ov\.evEmpty"\)\)\); return frag; \}/.test(ev));
  ok("讀不到:報告來源(下單 / HALT / 下單失敗)仍照列——那一句加在清單上面,不取代清單", ev.indexOf("evUnreach") < ev.indexOf("rows.length"));
  ok("重畫判準吃得到 uiErr(讀不到 → 讀到了要重畫)", /TR\.ov\.ui, TR\.ov\.uiErr,/.test(src) && /ui: \[\], uiErr: false,/.test(src));
  // ui 與 uiErr 是一組:登出 / 換帳號清掉上一個人的清單時,那個「讀不到」也要一起清(不然新帳號第一幀掛著上一個人的錯)
  ok("登出:ui 與 uiErr 一起清", /C\.ov\.curve = null; C\.ov\.ui = \[\]; C\.ov\.uiErr = false;/.test(src)); }

// 那一句兩語都在、語氣跟雲端其他「讀不到」一致(不斷言沒事發生)
{ const S = fs.readFileSync(path.join(R, "strings.js"), "utf8");
  const block = (n) => S.split(`  ${n}: {`)[1].split("\n  },")[0];
  const valsOf = (b) => Object.fromEntries([...b.matchAll(/^\s*("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*"),?$/gm)].map((m) => [JSON.parse(m[1]), JSON.parse(m[2])]));
  const enV = valsOf(block("en")), zhV = valsOf(block("zh"));
  ok("tr.ov.evUnreach 兩語都在,而且講「讀不到」不講「沒有事件」",
    /讀不到/.test(zhV["tr.ov.evUnreach"] || "") && !/沒有事件/.test(zhV["tr.ov.evUnreach"] || "")
    && /read/i.test(enV["tr.ov.evUnreach"] || "") && !/no events/i.test(enV["tr.ov.evUnreach"] || "")); }

// 已暫停時帳戶對不上(雲端 halt 事件 data.unexplained、本機 HALT 檔 halt.unexplained;designer halt-unexplained-copy-review §一):
// 事件列「部位對不上」＋標的(mono,雲端從 park_id 拆)＋「— 先到{venue}核對」,tooltip 是機器原因句;雲端畫過的 park_id 狀態檔那份不再畫
{ const loop = cut("const ui = (Array.isArray(TR.ov.ui)", "// 目前的 HALT"), local = cut("// 標題「部位對不上」", "trUnconfirmedRows(r.order_errors).forEach");
  ok("事件列:雲端 halt 帶 unexplained → 部位對不上、P1、代號是 park_id 拆出的標的、說明帶券商、tooltip 是原因句;排在一般 halt 分支之前",
    /if \(ev\.type === "halt" && d\.unexplained === true\) \{ head = t\("tr\.ov\.evHaltUnexplained"\); lv = 1; code = trUnxSym\(d\) \|\| null; note = t\("tr\.ov\.evHaltUnexplainedNote", \{ venue: trUnxVenue\(d\) \}\); tip = typeof d\.reason === "string"/.test(loop)
    && /unxSeen\.add/.test(loop) && loop.indexOf("d.unexplained === true") < loop.indexOf('else if (ev.type === "halt" || ev.type === "halt_close")'));
  ok("事件列:本機從 halt.unexplained 畫(trEvBody 同一套:P1、標的、說明、tooltip),跳過雲端已畫的 park_id",
    /trHaltUnexplained\(halt\)\.filter\(\(u\) => !unxSeen\.has\(u\.park_id\)\)/.test(local) && /push\(trMs\(u\.at\), \(body\) => trEvBody\(body, t\("tr\.ov\.evHaltUnexplained"\)/.test(local)
    && /t\("tr\.ov\.evHaltUnexplainedNote", \{ venue: trUnxVenue\(u\) \}\), 1, typeof u\.reason === "string"/.test(local) && /trUnxSym\(u\) \|\| null/.test(local));
  const S = fs.readFileSync(path.join(R, "strings.js"), "utf8");
  const keys = { "tr.haltUnexplained": ["{venue}", "{symbols}"], "tr.haltUnexplainedNosym": ["{venue}"], "tr.haltUnexplainedDo": ["{btn}"],
    "tr.ov.evHaltUnexplained": [], "tr.ov.evHaltUnexplainedNote": ["{venue}"] };
  ok("帳戶對不上的五個 key 兩語都在、佔位符齊;zh 事件說明不帶句號、不叫人按鈕", Object.entries(keys).every(([k, ph]) => {
    const vals = [...S.matchAll(new RegExp('"' + k.replace(/\./g, "\\.") + '": "((?:[^"\\\\]|\\\\.)*)"', "g"))].map((m) => m[1]);
    return vals.length === 2 && vals.every((v) => ph.every((p) => v.includes(p)));
  }) && /"tr\.ov\.evHaltUnexplainedNote": "先到\{venue\}核對"/.test(S)); }
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
