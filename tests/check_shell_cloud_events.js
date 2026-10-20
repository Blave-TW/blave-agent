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

ok("desktop_action 整類不畫(用戶自己按的指令回音,Wei 10-20)", ["halt", "update", "newcmd", ""].every((a) => trEventText("desktop_action", { action: a, device: "Mac" }) === null));
ok("其他型別不受影響(機器事件照舊)", trEventText("exchange_recovered", { venue: "binance" })[0] === 'tr.ov.evExBack|{"venue":"binance"}' && trEventText("nope", {}) === null);

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
  ok("target_stale 標題帶策略名;沒有就只有標題", E("target_stale", { strategy: "s2" })[0] === "tr.ov.evTargetStale · s2" && E("target_stale", {})[0] === "tr.ov.evTargetStale");
  const syms = (n) => Array.from({ length: n }, (_x, i) => "S" + i), dm = (list) => E("dead_members", { strategy: "s3", symbols: list });
  ok("dead_members ≤10 檔全列(標題接標的,不帶策略名;同網頁)", J(dm(syms(10)).slice(0, 2)) === J(["tr.ov.evDeadMembers · " + syms(10).join(", "), "tr.ov.evDeadMembersNote"]));
  ok("dead_members 11 檔 → 前 10 + 等 1(total/more 兩個都給)", dm(syms(11))[0] === "tr.ov.evDeadMembers · " + syms(10).join(", ") + ' tr.ov.evDeadMore|{"total":11,"more":1}');
  ok("dead_members 去 @spot、濾掉空與非字串;沒 symbols 只剩標題", dm(["A@spot", "", null, 5, "B"])[0] === "tr.ov.evDeadMembers · A, B" && E("dead_members", { strategy: "s3" })[0] === "tr.ov.evDeadMembers");
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
  ok("exchange_unreachable:說明縮短、後半句進 tooltip", J(E("exchange_unreachable", { venue: "okx", minutes: 30 })) === J(['tr.ov.evExUnreach|{"venue":"okx","minutes":30}', "tr.ov.evExUnreachNote", 2, "tr.ov.evExUnreachTip"]));
  ok("execution_stuck 分 overdue／abandoned／其他", J(["overdue", "abandoned", "x"].map((k) => E("execution_stuck", { kind: k }).slice(0, 2))) === J([["tr.ov.evExecOverdue", "tr.ov.evExecStuckNote"], ["tr.ov.evExecAbandoned", "tr.ov.evExecAbandonedNote"], ["tr.ov.evExecStuck", "tr.ov.evExecStuckNote"]]));
  ok("market_hold 標題帶策略名", E("market_hold", { strategy: "s4", venue: "okx" })[0] === "tr.ov.evMarketHold · s4" && E("market_hold", { strategy: "s4" })[1] === "tr.ov.evMarketHoldNote");
  ok("settings_unsafe / rollback_failed / market_check_off 各自一句", J([E("settings_unsafe", {}), E("settings_rollback_failed", {}), E("market_check_off", { kind: "table" })].map((x) => x.slice(0, 2)))
    === J([["tr.ov.evSettingsUnsafe", "tr.ov.evSettingsUnsafeNote"], ["tr.ov.evSettingsRollbackFailed", "tr.ov.evSettingsRollbackFailedNote"], ["tr.ov.evMarketCheckOff", "tr.ov.evMarketCheckOffNote"]]));
  ok("reconciler / machine / venue_unbound / ui_override 照網頁有句子", E("reconciler_dead", {})[0] === "tr.ov.evRecDead" && E("reconciler_recovered", {})[0] === "tr.ov.evRecBack"
    && E("machine_recovered", {})[0] === "tr.ov.evMachineBack" && E("venue_unbound", { venue: "okx" })[0].startsWith("tr.ov.evVenueUnbound|") && E("ui_override", {})[1] === "tr.ov.evUiOverrideNote");
  const long = "長".repeat(45);
  ok("report_rejected:標題 40 字截斷、沒標題用 report_id", E("report_rejected", { title: long, field: "a.b" })[0] === 'tr.ov.evReportRejected|{"title":"' + "長".repeat(40) + '…"}'
    && E("report_rejected", { report_id: "r1" })[0] === 'tr.ov.evReportRejected|{"title":"r1"}'
    && E("report_rejected", { title: "長".repeat(41) })[0] === 'tr.ov.evReportRejected|{"title":"' + "長".repeat(40) + '…"}'
    && E("report_rejected", { title: "長".repeat(40) })[0] === 'tr.ov.evReportRejected|{"title":"' + "長".repeat(40) + '"}');
  ok("report_degraded:count ≥1 帶次數、缺/0 用不帶次數那句", E("report_degraded", { title: "晨報", count: 3 })[1] === 'tr.ov.evReportDegradedNote|{"count":3}'
    && E("report_degraded", { title: "晨報" })[1] === "tr.ov.evReportDegradedNoteNoCount" && E("report_degraded", { title: "晨報", count: 0 })[1] === "tr.ov.evReportDegradedNoteNoCount"); }

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
  ok("停機凍結那句縮短:連平倉也不做、按啟動下單恢復", zhV["tr.ov.evDowntimeNote"] === "全部凍結，連平倉也不做；按「啟動下單」恢復");
  ok("renderer 不出現中文字面(放的是 key,不是句子)", !/[一-鿿]/.test(cut("const TR_EV_P1 = [", "\nfunction trOvEvents(").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))); }

// ui 那一段(會碰 DOM,只驗寫法)
{ const loop = cut("const ui = (Array.isArray(TR.ov.ui)", "// 目前的 HALT");
  ok("ui:平台格式的欄位包在 data 裡,這台電腦那一份在最外層——兩邊同一支迴圈", /const d = ev\.data && typeof ev\.data === "object" \? ev\.data : ev;/.test(loop) && /String\(d\.venue \|\| ""\)/.test(loop));
  ok("ui:認不得的型別交給 trEventText(雲端才有的 desktop_action / 交易所連不上…),還是認不得就不畫", /else \{ const txt = trEventText\(ev\.type, d\); if \(txt\) \[head, note, lv, tip\] = txt; \}/.test(loop) && /if \(!head\) return;/.test(loop));
  ok("ui:halt 誰按的看 source(鏡射平台的 _HALT_AUTO_SOURCES);沒有 source = 人按的", /lv = trEvLevel\(ev\.type, d\); head = t\(lv === 1 \? "tr\.ov\.evHaltAuto" : "tr\.ov\.evHalt"\)/.test(loop));
  ok("ui:下單失敗不在這一段(雲端的 portfolio 仍帶 order_errors,兩邊都畫會重複)", !/order_error/.test(loop));
  ok("ui:時間仍然是秒(平台與這台電腦同一個單位)", /uiHalts\.push\(ev\.ts \* 1000\)/.test(loop) && /push\(ev\.ts \* 1000,/.test(loop));
  ok("ui:雲端記的 venue_disconnected P2、這台電腦自己按的一般字", /lv = d !== ev \? 2 : 3;/.test(loop));
  ok("現在的 HALT 那列顏色照級別(execute/settings 暫停不再紅,P1 由對應事件那列承擔)", /trEl\("span", trEvClass\(trEvLevel\("halt", halt\)\),/.test(cut("// 目前的 HALT", "(Array.isArray(r.order_errors)")));
  ok("ui 與機器事件兩段都走 trEvBody(帶 ev.count)", (src.match(/trEvBody\(body, .*?, ev\.count\)\);/g) || []).length === 2);
  ok("兩段的顏色都先讀 api 的 level、缺才用自己算的", /trEvBody\(body, head, note, trEvApiLevel\(ev\) \|\| lv, tip, ev\.count\)/.test(src)
    && /trEvBody\(body, txt\[0\], txt\[1\], trEvApiLevel\(ev\) \|\| txt\[2\], txt\[3\], ev\.count\)/.test(src)); }
ok("trEvApiLevel:P1/P2/P3 → 1/2/3;缺、小寫、P4、數字、非物件 → null",
  JSON.stringify([trEvApiLevel({ level: "P1" }), trEvApiLevel({ level: "P2" }), trEvApiLevel({ level: "P3" }), trEvApiLevel({}), trEvApiLevel({ level: "p1" }),
    trEvApiLevel({ level: "P4" }), trEvApiLevel({ level: 1 }), trEvApiLevel({ level: " P1" }), trEvApiLevel(null)]) === JSON.stringify([1, 2, 3, null, null, null, null, null, null]));

// trEvBody:標題級別色 → ×N(≥2 才出、取整)→ 說明;tooltip 掛在說明
{ function N(tag, cls, text) { this.cls = cls || ""; this.text = text == null ? "" : String(text); this.kids = []; this.title = ""; }
  N.prototype.appendChild = function (c) { this.kids.push(c); return c; };
  N.prototype.append = function (...xs) { xs.forEach((x) => this.kids.push(typeof x === "string" ? { text: x, kids: [] } : x)); };
  const mk = (tag, cls, text) => new N(tag, cls, text), flat = (n) => n.text + n.kids.map(flat).join("");
  const fn = new Function("trEl", "trEvClass", cut("function trEvBody(", "/* 事件 = 狀態改變") + "\nreturn trEvBody;")(mk, trEvClass);
  const run = (count, note, tip) => { const b = new N("span", "body"); fn(b, "H", note, 1, tip, count); return b; };
  ok("trEvBody:×N 在標題後、說明前", flat(run(4, "NOTE")) === "H ×4 — NOTE" && run(4, "NOTE").kids[0].cls === "err" && run(4, "NOTE").kids[2].cls === "mono");
  ok("trEvBody:count 1／缺／字串／NaN 不出,2.9 取 2", ["H — N", "H — N", "H — N", "H — N", "H ×2 — N"].join("|") === [1, undefined, "3", NaN, 2.9].map((c) => flat(run(c, "N"))).join("|"));
  ok("trEvBody:沒說明只剩標題(+×N);tooltip 掛在說明的 title", flat(run(3, null)) === "H ×3" && run(0, "N", "TIP").kids.slice(-1)[0].title === "TIP"); }


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

console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
