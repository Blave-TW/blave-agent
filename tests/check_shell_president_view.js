// 統一本機開通的狀態機(shell/renderer/president.js 的純邏輯段,從原文切出來跑)+ 畫面用到的字串兩語都有。
//   president_connect(runtime/president_connect.py 的 desktop 段寫的那一份)+ 畫面自己的狀態 → mockup 電腦版 d-* 的哪一態。
//   逐一列舉 LOGIN_STATES 的每個值、每種「在跑」、Mac、雲端已綁(Q6 擋)、事前準備三態、測試段(後端未接 → 停在那裡、不碰正式主機)、
//   憑證到期橫幅(31 天)、第一次真錢的口數列、維護時段。
// 跑法:node tests/check_shell_president_view.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "president.js"), "utf8");
const a = src.indexOf("/* ── 純邏輯"), b = src.indexOf("/* ── 純邏輯到此 ── */");
let red = 0; const ok = (n, c, got) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) { red++; if (got !== undefined) console.log("      got: " + JSON.stringify(got)); } };
if (a < 0 || b < 0) { console.log("FAIL  president.js 找不到純邏輯段的記號"); process.exit(1); }
const head = src.slice(0, src.indexOf("let PRES = presBlank();"));   // 常數 + presBlank
const ctx = {}; vm.createContext(ctx);
vm.runInContext(head + "\n" + src.slice(a, b) + "\nthis.presView = presView; this.presRunning = presRunning; this.presBlank = presBlank; this.presDaysLeft = presDaysLeft;"
  + " this.presRenewDue = presRenewDue; this.presFirstRows = presFirstRows; this.presMaintOver = presMaintOver; this.PRES_PROBE_VIEW = PRES_PROBE_VIEW;", ctx);
const { presView, presRunning, presDaysLeft, presRenewDue, presFirstRows, presMaintOver } = ctx;

const NOW = 1790000000 * 1000, S = NOW / 1000;
const W = { win: true, dual: false, now: NOW };
const ui = (o) => Object.assign(ctx.presBlank(), { phase: "flow" }, o || {});
const pc = (o) => Object.assign({ v: 1, updated_at: S - 5, busy: null, setup: { status: "ok", at: S - 100 }, cert: { status: "idle", at: null },
  probe: { status: "idle", at: null }, worker: { status: "idle", at: null } }, o || {});
const view = (c, u, x) => presView(c, u || ui(), x || W);
const CERT_OK = { status: "ok", at: S - 50, not_after: "2027-09-30T00:00:00Z" };

// 入口
ok("Mac → d-mac(不管狀態)", view(pc(), ui(), { win: false, dual: false, now: NOW }) === "d-mac");
ok("雲端已綁統一 → d-dual(Q6 擋)", view(pc(), ui(), { win: true, dual: true, now: NOW }) === "d-dual");
ok("事前準備:還沒看完 PSCCA → d-prep-load", view(null, ui({ phase: "prep" })) === "d-prep-load");
ok("事前準備:找到憑證 → d-prep", view(null, ui({ phase: "prep", scan: { found: 1, expiry: "2027/09/30", newestAt: 1 } })) === "d-prep");
ok("事前準備:沒有 → d-prep-none", view(null, ui({ phase: "prep", scan: { found: 0, expiry: null, newestAt: 0 } })) === "d-prep-none");
ok("憑證e總管開著 → d-prep-wait(不管有沒有舊檔)", view(null, ui({ phase: "prep", waitTcem: true, scan: { found: 1 } })) === "d-prep-wait");
ok("表單", view(null, ui({ phase: "form" })) === "d-form");
// 在跑
ok("剛送 setup、回報還沒動 → d-setup", view(null, ui({ sent: { step: "setup", at: NOW } })) === "d-setup");
ok("busy=president_local:cert → d-cert-run", view(pc({ busy: "president_local:cert" })) === "d-cert-run");
ok("cert importing → d-cert-run", view(pc({ cert: { status: "importing", at: S - 2 } })) === "d-cert-run");
ok("probe running → d-probe", view(pc({ env: "live", cert: CERT_OK, probe: { status: "running", at: S - 2 } })) === "d-probe");
ok("worker running → d-finish", view(pc({ env: "live", cert: CERT_OK, worker: { status: "running", at: S - 2 } })) === "d-finish");
ok("卡在 running 超過 25 分鐘不算在跑", presRunning(pc({ updated_at: S - 3600, probe: { status: "running", at: S - 3600 } }), null, NOW) === null);
ok("測試主機確認登入中(env test)→ d-t-probe;測試單在跑 → d-t-order-run", view(pc({ env: "test", cert: CERT_OK, probe: { status: "running", at: S - 2 } })) === "d-t-probe"
  && view(pc({ env: "test", cert: CERT_OK, test_order: { status: "running", at: S - 2 } })) === "d-t-order-run" && view(pc({ busy: "president_local:host", cert: CERT_OK })) === "d-t-probe");
// 安裝與憑證
ok("setup 失敗 → d-setup-fail", view(pc({ setup: { status: "failed", at: S - 5 } })) === "d-setup-fail");
ok("setup 還沒好(idle)→ d-setup(自動送)", view(pc({ setup: { status: "idle", at: null } })) === "d-setup");
ok("裝好、沒憑證 → d-cert", view(pc()) === "d-cert");
ok("憑證失敗 → d-cert-err", view(pc({ cert: { status: "failed", error: "PFX_PASSWORD", at: S - 5 } })) === "d-cert-err");
ok("換一張憑證(recert)→ d-cert,即使原本那張是好的", view(pc({ env: "live", cert: CERT_OK, probe: { status: "failed", state: "cert", at: S - 3 } }), ui({ recert: true })) === "d-cert");
// 測試段(跟雲端同一份 runtime:env 看回報、測試單看 test_order)
ok("憑證好了、新帳號(env test)→ d-t-host,不會直接登入正式主機", view(pc({ env: "test", cert: CERT_OK })) === "d-t-host" && view(pc({ cert: CERT_OK })) === "d-t-host");
ok("測試主機登入過 → d-t-order", view(pc({ env: "test", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "test", at: S - 3 } })) === "d-t-order");
ok("測試單成功 → d-t-report;被拒 → d-t-order-fail", view(pc({ env: "test", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "test", at: S - 9 }, test_order: { status: "ok", state: "accepted", at: S - 3 } })) === "d-t-report"
  && view(pc({ env: "test", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "test", at: S - 9 }, test_order: { status: "failed", state: "rejected", at: S - 3 } })) === "d-t-order-fail");
ok("測試主機登入失敗 → 同一組畫面(掛在測試那一列)", view(pc({ env: "test", cert: CERT_OK, probe: { status: "failed", state: "unknown", env: "test", at: S - 3 } })) === "d-UNKNOWN");
ok("切了正式、還沒確認 → 回報那一步(營業員說開好了可以再按);測試主機那次的 ok 不算正式", view(pc({ env: "live", cert: CERT_OK })) === "d-t-report"
  && view(pc({ env: "live", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "test", at: S - 3 } })) === "d-t-report");
// 正式登入的每一個結果(runtime LOGIN_STATES 的值 + unblock_used / no_credentials)
const STATES = { password: "d-PASSWORD", unknown: "d-UNKNOWN", cert_mismatch: "d-CERT_MISMATCH", cert: "d-CERT", blocked: "d-BLOCKED",
  unblock_used: "d-BLOCKED2", maintenance: "d-MAINTENANCE", host: "d-HOST", timeout: "d-TIMEOUT", retry_later: "d-TRANSIENT", no_credentials: "d-NOCREDS" };
for (const [st, v] of Object.entries(STATES)) ok(`probe ${st} → ${v}`, view(pc({ env: "live", cert: CERT_OK, probe: { status: "failed", state: st, env: "live", at: S - 3 } })) === v);
ok("PRES_PROBE_VIEW 只有這幾個(多一個少一個都要補畫面)", Object.keys(ctx.PRES_PROBE_VIEW).sort().join() === Object.keys(STATES).sort().join());
ok("沒見過的 state → d-UNKNOWN(最保守那一組,講 Blave 已先停止)", view(pc({ env: "live", cert: CERT_OK, probe: { status: "failed", state: "weird", at: S - 3 } })) === "d-UNKNOWN");
ok("改密碼中(recheck)→ d-pw", view(pc({ env: "live", cert: CERT_OK, probe: { status: "failed", state: "password", at: S - 3 } }), ui({ recheck: true })) === "d-pw");
ok("正式登入過 → d-finish(自動啟動)", view(pc({ env: "live", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "live", at: S - 3 } })) === "d-finish");
ok("下單程式好了 → d-done", view(pc({ env: "live", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "live", at: S - 9 }, worker: { status: "ok", at: S - 3 } })) === "d-done");
ok("下單程式失敗 → d-finish-fail;被擋(BLOCKED:*)→ 那個類別的畫面,不再自動啟動", view(pc({ env: "live", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "live", at: S - 9 }, worker: { status: "failed", error: "WORKER_FAILED", at: S - 3 } })) === "d-finish-fail"
  && view(pc({ env: "live", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "live", at: S - 9 }, worker: { status: "failed", error: "BLOCKED:PASSWORD", at: S - 3 } })) === "d-PASSWORD"
  && view(pc({ env: "live", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "live", at: S - 9 }, worker: { status: "failed", error: "BLOCKED:UNKNOWN", at: S - 3 } })) === "d-BLOCKED"
  && view(pc({ env: "live", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "live", at: S - 1 }, worker: { status: "failed", error: "BLOCKED:UNKNOWN", at: S - 3 } })) === "d-finish");
// 橫幅與確認
const day = 86400 * 1000, iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
ok("到期剩 28 天 → 橫幅(28);剩 40 天 → 不出;過期 → 負數(過期那一句)", presRenewDue(pc({ cert: { status: "ok", not_after: iso(NOW + 28.5 * day) } }), NOW) === 28
  && presRenewDue(pc({ cert: { status: "ok", not_after: iso(NOW + 40 * day) } }), NOW) === null && presRenewDue(pc({ cert: { status: "ok", not_after: iso(NOW - 2 * day) } }), NOW) < 0);
ok("憑證沒好不出到期橫幅", presRenewDue(pc({ cert: { status: "failed", not_after: iso(NOW + day) } }), NOW) === null && presDaysLeft("x", NOW) === null);
ok("第一次真錢的口數列:有金額的策略、排序、四捨五入", JSON.stringify(presFirstRows({ b: 2, a: 1.4, z: 0, x: "3" })) === JSON.stringify([{ name: "a", lots: 1 }, { name: "b", lots: 2 }]));
const tp = (h, m) => Date.UTC(2026, 9, 8, h - 8, m);   // 台北時間 → UTC ms
ok("維護 05:30–05:50 台北:05:40 不重試、05:50 起重試", !presMaintOver(tp(5, 40)) && presMaintOver(tp(5, 50)) && presMaintOver(tp(9, 0)));

// Wei 10-07:「收到測試帳號信」只是提醒,不擋「下一步」;憑證e總管做完、偵測到新檔就直接到帳密
{ const sync = src.slice(src.indexOf("function presSyncGo("), src.indexOf("function presPrimary("));
  const scan = src.slice(src.indexOf("async function presScan("), src.indexOf("function presWatch("));
  ok("勾選不擋下一步(presSyncGo 不看 gotMail)", sync.length > 0 && !/gotMail/.test(sync));
  ok("偵測到新憑證 → 直接到帳密表單、停止輪詢", /PRES\.waitTcem = false;[^\n]*PRES\.phase = "form"; presWatch\(false\);/.test(scan)); }
{ const ban = src.slice(src.indexOf("function presBannerPaint("), src.indexOf("function presHeldLots("));
  ok("自動下單頁:統一登入被封鎖時有一條橫幅(讀回報的 venue_pause paused_blocked),帶去處理登入", /venue_pause\[PRESIDENT\]\.state === "paused_blocked"/.test(ban) && /cxModalOpen\(null, PRESIDENT\)/.test(ban)); }
// 字串:president.js / trade.js 用到的 pres.* 兩語都有
const strings = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "strings.js"), "utf8");
const sctx = {}; vm.createContext(sctx); vm.runInContext(strings + "\nthis.S = STRINGS;", sctx);
const used = new Set();
for (const f of ["president.js", "trade.js"]) {
  const s = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", f), "utf8");
  for (const m of s.matchAll(/["'](pres\.[A-Za-z0-9.]+)["']/g)) used.add(m[1]);
}
const miss = [...used].filter((k) => !(k in sctx.S.zh) || !(k in sctx.S.en));
ok(`用到的 pres.* ${used.size} 個,中英都有`, used.size > 100 && miss.length === 0, miss);
const zhHalf = [...used].filter((k) => k in sctx.S.zh && /[,;?!]|(?<!\d):(?!\d)/.test(sctx.S.zh[k]));
ok("中文字串用全形標點", zhHalf.length === 0, zhHalf);
console.log(red ? `\n${red} 紅` : "\n全綠"); process.exit(red ? 1 : 0);
