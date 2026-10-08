// 統一本機開通的狀態機(shell/renderer/president.js 的純邏輯段,從原文切出來跑)+ 畫面用到的字串兩語都有。
//   president_connect(runtime/president_connect.py 的 desktop 段寫的那一份)+ 畫面自己的狀態 → mockup 電腦版 d-* 的哪一態。
//   逐一列舉 LOGIN_STATES 的每個值、每種「在跑」、Mac、找 PSCCA 的三態(找到直接帳密,沒有「事前準備」頁)、測試段(停在那裡、不碰正式主機)、
//   第一次真錢的口數列、維護時段、主行程回錯畫在哪(列／欄位／浮動 slot)、文案沒有「登入次數」。
// 跑法:node tests/check_shell_president_view.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "president.js"), "utf8");
const a = src.indexOf("/* ── 純邏輯"), b = src.indexOf("/* ── 純邏輯到此 ── */");
let red = 0; const ok = (n, c, got) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) { red++; if (got !== undefined) console.log("      got: " + JSON.stringify(got)); } };
if (a < 0 || b < 0) { console.log("FAIL  president.js 找不到純邏輯段的記號"); process.exit(1); }
const head = src.slice(0, src.indexOf("let PRES = presBlank();"));   // 常數 + presBlank
const ctx = {}; vm.createContext(ctx);
vm.runInContext(head + "\n" + src.slice(a, b) + "\nthis.presView = presView; this.presRunning = presRunning; this.presBlank = presBlank; this.presDaysLeft = presDaysLeft;"
  + " this.presFirstRows = presFirstRows; this.PRES_PROBE_VIEW = PRES_PROBE_VIEW; this.presMsgPlace = presMsgPlace; this.PRES_ROW_STEPS = PRES_ROW_STEPS; this.PRES_FRAME_ERR = PRES_FRAME_ERR;", ctx);
const { presView, presRunning, presDaysLeft, presFirstRows, presMsgPlace } = ctx;

const NOW = 1790000000 * 1000, S = NOW / 1000;
const W = { win: true, now: NOW };
const ui = (o) => Object.assign(ctx.presBlank(), { phase: "flow" }, o || {});
const pc = (o) => Object.assign({ v: 1, updated_at: S - 5, busy: null, setup: { status: "ok", at: S - 100 }, cert: { status: "idle", at: null },
  probe: { status: "idle", at: null }, worker: { status: "idle", at: null } }, o || {});
const view = (c, u, x) => presView(c, u || ui(), x || W);
const CERT_OK = { status: "ok", at: S - 50, not_after: "2027-09-30T00:00:00Z" };

// 入口
ok("Mac → d-mac(不管狀態)", view(pc(), ui(), { win: false, now: NOW }) === "d-mac");
ok("還沒看完 PSCCA → d-prep-load", view(null, ui({ phase: "prep" })) === "d-prep-load");
ok("找到憑證 → 直接 d-form,沒有「事前準備」那一頁", view(null, ui({ phase: "prep", scan: { found: 1, expiry: "2027/09/30", newestAt: 1 } })) === "d-form" && !/=== "d-prep"|"d-prep" \?/.test(src));
ok("沒有 → d-prep-none", view(null, ui({ phase: "prep", scan: { found: 0, expiry: null, newestAt: 0 } })) === "d-prep-none");
ok("憑證e總管開著 → d-prep-wait", view(null, ui({ phase: "prep", waitTcem: true, scan: { found: 0 } })) === "d-prep-wait");
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
// 登入失敗的每一類(runtime LOGIN_STATES 的值 + no_credentials):只用來顯示,哪一類都停下來等「確認登入」
const STATES = { password: "d-PASSWORD", unknown: "d-UNKNOWN", cert_mismatch: "d-CERT_MISMATCH", cert: "d-CERT",
  maintenance: "d-MAINTENANCE", timeout: "d-TIMEOUT", no_credentials: "d-NOCREDS" };
for (const [st, v] of Object.entries(STATES)) ok(`probe ${st} → ${v}`, view(pc({ env: "live", cert: CERT_OK, probe: { status: "failed", state: st, env: "live", at: S - 3 } })) === v);
ok("PRES_PROBE_VIEW 只有這幾個(多一個少一個都要補畫面)", Object.keys(ctx.PRES_PROBE_VIEW).sort().join() === Object.keys(STATES).sort().join());
ok("沒見過的 state → d-UNKNOWN(最保守那一組,講 Blave 已先停止)", view(pc({ env: "live", cert: CERT_OK, probe: { status: "failed", state: "weird", at: S - 3 } })) === "d-UNKNOWN");
ok("改密碼中(recheck)→ d-pw", view(pc({ env: "live", cert: CERT_OK, probe: { status: "failed", state: "password", at: S - 3 } }), ui({ recheck: true })) === "d-pw");
ok("正式登入過 → d-finish(自動啟動)", view(pc({ env: "live", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "live", at: S - 3 } })) === "d-finish");
ok("下單程式好了 → d-done", view(pc({ env: "live", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "live", at: S - 9 }, worker: { status: "ok", at: S - 3 } })) === "d-done");
ok("下單程式失敗 → d-finish-fail;它自己登入失敗停了(LOGIN_FAILED:<類別>)→ 那一類的畫面,不自動重啟",
  view(pc({ env: "live", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "live", at: S - 9 }, worker: { status: "failed", error: "WORKER_FAILED", at: S - 3 } })) === "d-finish-fail"
  && view(pc({ env: "live", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "live", at: S - 9 }, worker: { status: "failed", error: "LOGIN_FAILED:PASSWORD", at: S - 3 } })) === "d-PASSWORD"
  && view(pc({ env: "live", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "live", at: S - 9 }, worker: { status: "failed", error: "LOGIN_FAILED:TIMEOUT", at: S - 3 } })) === "d-TIMEOUT"
  && view(pc({ env: "live", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "live", at: S - 9 }, worker: { status: "failed", error: "LOGIN_FAILED:WEIRD", at: S - 3 } })) === "d-UNKNOWN");
ok("用戶按了「確認登入」而且過了(probe 比那次失敗新)→ 往下啟動", view(pc({ env: "live", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "live", at: S - 1 }, worker: { status: "failed", error: "LOGIN_FAILED:PASSWORD", at: S - 3 } })) === "d-finish");
ok("第一次真錢的口數列:有金額的策略、排序、四捨五入", JSON.stringify(presFirstRows({ b: 2, a: 1.4, z: 0, x: "3" })) === JSON.stringify([{ name: "a", lots: 1 }, { name: "b", lots: 2 }]));

// Wei 10-07:PSCCA 有憑證(開框第一次看到、或憑證e總管做完出現新檔)就直接到帳密;沒有勾選、沒有營業員話術
{ const scan = src.slice(src.indexOf("async function presScan("), src.indexOf("function presWatch("));
  ok("找到憑證 → 直接到帳密表單、停止輪詢", /PRES\.phase === "prep" && PRES\.scan\.found > 0\) \{ PRES\.waitTcem = false;[^\n]*PRES\.phase = "form"; presWatch\(false\);/.test(scan));
  ok("沒有勾選列、沒有話術框、沒有一鍵複製話術", !/gotMail|presCheck|presScript|pres\.script\.|pres\.prep\.(need|mail|found)|pres\.next/.test(src)); }
{ const body = src.slice(src.indexOf("function presProbeBody("), src.indexOf("function presTestHostBody("));
  const adv = src.slice(src.indexOf("function presAdvance("), src.indexOf("// ── DOM"));
  ok("失敗畫面:一顆「確認登入」(每按一次送一次 probe)+ 處理好再按／被鎖找營業員那一句;沒有解鎖鈕", /capBtn\("btn-fill", t\("pres\.err\.confirm"\), \(\) => presStep\("probe"\)/.test(body)
    && /pres\.err\.stopNote/.test(body) && !/unlock|afterUnlock/i.test(src));
  ok("沒有任何自動再登入(presAdvance 不送 probe / host)", !/presStep\("probe"/.test(adv) && !/presHost\(/.test(adv));
  ok("沒有到期橫幅、沒有雙邊檢查", !/presRenewDue|presDual|venue_pause/.test(src)); }
// 主行程回錯畫在哪:一列只有一個狀態——步驟沒送出去掛在那一列;浮動 slot 只放整框層級;憑證檔的錯在欄位下;存帳密(沒有列)才放 slot
ok("步驟沒送出去 → 那一列(setup / cert / probe(含 host) / test_order / start)", ctx.PRES_ROW_STEPS.every((s) => presMsgPlace({ code: "FAILED", step: s }) === "row")
  && ctx.PRES_ROW_STEPS.slice().sort().join() === "cert,probe,setup,start,test_order");
ok("整框層級(daemon 沒跑、加密儲存、重綁、忙碌)→ 浮動 slot,不管哪一步", ["DAEMON_DOWN", "TIMEOUT", "NO_SEAL", "REBOUND", "NO_CREDS", "BUSY"].every((c) => presMsgPlace({ code: c, step: "probe" }) === "frame"));
ok("憑證檔的錯 → 欄位下;存帳密失敗 → slot;沒有錯 → null", presMsgPlace({ code: "PFX_PASSWORD", step: "cert" }) === "field" && presMsgPlace({ code: "FAILED", step: "creds" }) === "slot" && presMsgPlace(null) === null);
// 稽核 integ-0118 C-1:主行程憑證密碼格式不對(BAD_PW / NO_CA_PW)畫在憑證密碼欄位下,不是列上的「這一步沒有開始」;存帳密那一步的 BAD_PW 沒有欄位可掛照 slot;
// LIB_OUTDATED 要更新工作區,給自己的字(frame);列裡的新錯優先於狀態檔裡上一次的錯
ok("C-1 BAD_PW / NO_CA_PW(cert)→ 欄位下;BAD_PW(creds)→ slot;LIB_OUTDATED → frame 自己的字", presMsgPlace({ code: "BAD_PW", step: "cert" }) === "field" && presMsgPlace({ code: "NO_CA_PW", step: "cert" }) === "field"
  && presMsgPlace({ code: "BAD_PW", step: "creds" }) === "slot" && presMsgPlace({ code: "LIB_OUTDATED", step: "cert" }) === "frame" && ctx.PRES_FRAME_ERR.LIB_OUTDATED === "pres.err.libOutdated");
{ const cb = src.slice(src.indexOf("function presCertBody("), src.indexOf("function presPwBody("));
  ok("C-1 憑證列:剛沒送出去的錯(PRES.msg)先於狀態檔的 cert.error;密碼類三個碼都掛欄位下", /const code = fresh \|\| \(view === "d-cert-err" \? cert\.error : null\), pwErr = PRES_PFX_ERR\[code\] === "pres\.pfx\.errPw"/.test(cb)
    && /const fileErr = presRowErr\("cert"\) \|\| \(code && !pwErr/.test(cb) && /err: pwErr \? t\("pres\.pfx\.errPw"\) : null/.test(cb));
  ok("C-2 只有過期憑證那條死路:列裡多一顆「開啟憑證e總管」", /if \(expired\) acts\.push\(capBtn\("btn-quiet", t\("pres\.tcem\.open"\), presOpenTcem, "pres-tcem-renew"/.test(cb));
  const rows = src.slice(src.indexOf("function presRows("), src.indexOf("function presDoneBody("));
  ok("C-1 測試單列:剛沒送出去的錯先於上一次的被拒", /rowErr\("test_order"\) \? capErr\(rowErr\("test_order"\)\) : view === "d-t-order-fail" \? capErr\(t\("pres\.t\.orderFail"\)\) : null/.test(rows));
  const tcem = src.slice(src.indexOf("async function presOpenTcem("), src.indexOf("// 主行程回的錯 + 發生在哪一步"));
  ok("C-2 presOpenTcem:等待態與輪詢只在 prep(presScan 可能在等的時候已推到 form)", /if \(PRES\.phase === "prep"\) \{ PRES\.waitTcem = true; presWatch\(true\); \}/.test(tcem) && !/PRES\.waitTcem = true; presTrack/.test(tcem));
  // A 段錯誤輸入:換憑證選錯檔 / 密碼錯時 runtime 不再清掉在用的那張(status ok、not_after 留著,只記 last_error);過期那張的日期在 last_error_not_after
  ok("換憑證選到過期的:在用的那張還是 ok 時,過期日讀 last_error_not_after,不是在用那張的 not_after", /exp = expired \? capDate\(cert\.status === "ok" \? cert\.last_error_not_after : cert\.not_after\) : null;/.test(cb)); }
// A 段錯誤輸入:測試主機網址不是統一那兩台(runtime HOST_NOT_ALLOWED)→ 欄位下自己那句,不是列上的「這一步沒有開始」
{ const th = src.slice(src.indexOf("function presTestHostBody("), src.indexOf("// 測試單的時間"));
  ok("HOST_NOT_ALLOWED(host 記成 probe)→ 欄位下;別的 probe 錯照舊掛列上", presMsgPlace({ code: "HOST_NOT_ALLOWED", step: "probe" }) === "field" && presMsgPlace({ code: "FAILED", step: "probe" }) === "row");
  ok("測試主機那一格:HOST_NOT_ALLOWED 畫 pres.err.hostNotAllowed 在欄位下(紅框、role=status、aria-describedby),蓋掉提示句",
    /const hostErr = PRES\.msg && PRES\.msg\.step === "probe" && PRES_HOST_ERR\[PRES\.msg\.code\] \? t\(PRES_HOST_ERR\[PRES\.msg\.code\]\) : null;/.test(th)
    && /"f-input txt pres-mono" \+ \(hostErr \? " is-err" : ""\)/.test(th) && /const under = hostErr \? trEl\("p", "cap-err", hostErr\) : presP\("cx-hint", t\("pres\.t\.urlHint"\)\);/.test(th)
    && /if \(hostErr\) under\.setAttribute\("role", "status"\); i\.setAttribute\("aria-describedby", under\.id\);/.test(th)
    && /^這個網址不是統一的測試或正式主機。照測試帳號信上寫的填。$/.test(require("vm").runInNewContext(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "strings.js"), "utf8") + "\nSTRINGS.zh['pres.err.hostNotAllowed']"))); }
{ const rows = src.slice(src.indexOf("function presRows("), src.indexOf("function presDoneBody("));
  ok("列上的錯先問「在跑嗎」(在跑的優先,不會轉圈又掛錯)", /rowErr = \(step\) => \(run === step \? null : presRowErr\(step\)\)/.test(rows));
  ok("自動送的兩步(安裝、啟動)沒送出去 → 那一列掛錯 + 再試一次", /rowErr\("setup"\)\) add\(presBadRow/.test(rows) && /rowErr\("start"\)\) add\(presBadRow/.test(rows)); }
// Wei 實測:已經開過正式權限的(本人、換電腦重裝)不必走測試段——測試段標題一顆「直接登入正式主機」(host live),三列「已略過」,正式登入失敗停在正式那列
{ const rows = src.slice(src.indexOf("function presRows("), src.indexOf("function presDoneBody("));
  const pb = src.slice(src.indexOf("function presProbeBody("), src.indexOf("function presTestHostBody("));
  const SK = { env: "live", cert: CERT_OK, test_skipped: true };
  ok("略過後正式登入失敗(UNKNOWN)→ 停在正式那列 d-UNKNOWN,不回測試段;過了 → d-finish", view(pc({ ...SK, probe: { status: "failed", state: "unknown", env: "live", at: S - 3 } })) === "d-UNKNOWN"
    && view(pc({ ...SK, probe: { status: "ok", state: "ok", env: "live", at: S - 3 } })) === "d-finish" && view(pc({ ...SK, probe: { status: "running", at: S - 2 } })) === "d-probe");
  ok("測試段標題的鈕:只在測試環境、安裝與憑證都好了、測試單還沒成功時畫,按了送 host live(既有指令:切正式＋登入)", /ph\("pres\.ph\.test", !live && setup\.status === "ok" && cert\.status === "ok" && to\.status !== "ok" \? capBtn\("btn-quiet", t\("pres\.t\.skip"\), \(\) => presHost\("live"\), "pres-skip-test", off\) : null\);/.test(rows)
    && /, ph = \(k, btn\) => \{[^\n]*s\.setAttribute\("aria-hidden", "true"\); li\.appendChild\(s\); if \(btn\) li\.appendChild\(btn\);/.test(rows));
  ok("略過(runtime test_skipped、env live):三列灰、不打勾、右邊「已略過」;第一列給「改做測試單」(host test:只切回、不登入)", /const skipped = live && !!pc && pc\.test_skipped === true;/.test(rows)
    && /const tProbed = \(live && !skipped\) \|\|/.test(rows) && /else if \(skipped\) add\(capRow\("todo", t\("pres\.s\.tprobe"\), skipRight, capActs\(capBtn\("btn-quiet", t\("pres\.t\.back"\), \(\) => presStep\("host", \{ env: "test" \}\), "pres-test-back", off\)\)\)\);/.test(rows)
    && /const d = \(live && !skipped\) \|\| to\.status === "ok"; add\(capRow\(d \? "done" : "todo", t\("pres\.s\.torder"\), d \? t\("pres\.s\.torderDone"\) : to\.status === "failed" \? "" : skipRight\)\);/.test(rows)
    && /add\(capRow\(live && !skipped \? "done" : "todo", t\("pres\.s\.treport"\), live && !skipped \? t\("pres\.s\.treportDone"\) : skipRight\)\);/.test(rows));
  ok("略過後 UNKNOWN 多一句「營業員還沒開正式權限 → 先做上面的測試單」,沒有自動重試", /view === "d-UNKNOWN" && pc && pc\.env === "live" && pc\.test_skipped === true \? presP\("cx-hint", t\("pres\.err\.unknownSkipped"\)\)/.test(pb));
  // 稽核 integ-0118 第三版 B-1:略過之前測試單被拒過(test_order failed)→ 正式 UNKNOWN 那一格也要有「改做測試單」,被拒的那列不標「已略過」。
  // presRows 真的跑一次(殼全部換成記錄用的替身),不只比對原文
  const dom = { t: (k) => k, trEl: (tag, cls, text) => ({ tag, cls, text, kids: [], appendChild(x) { this.kids.push(x); return x; }, append(...xs) { this.kids.push(...xs); }, setAttribute() {} }),
    capRow: (kind, name, right, body) => ({ kind, name, right, body: body || null }), capBtn: (cls, label, fn, id, off) => ({ btn: id, off: !!off }),
    capActs: (...xs) => ({ acts: xs }), capFrag: (...xs) => ({ frag: xs }), capDo: (x) => ({ do: x }), capErr: (x) => ({ err: x }), capDate: () => "",
    presDown: () => false, presRowErr: () => null, presBadRow: (name, text, retry, id) => ({ kind: "bad", name, btn: id }),
    presProbeBody: () => ({ body: "probe" }), presPwBody: () => ({ body: "pw" }), presTestHostBody: () => ({ body: "thost" }), presCertBody: () => ({ body: "cert" }), presTestReportBody: () => ({ body: "treport" }),
    presStep: () => {}, presHost: () => {}, Date };
  const rctx = Object.assign({}, dom); vm.createContext(rctx);
  vm.runInContext(head + "\nlet PRES = presBlank();\n" + src.slice(a, b) + "\n" + rows + "\nthis.presRows = presRows;", rctx);
  const rowsOf = (c, v) => JSON.stringify(rctx.presRows(v || view(pc(c)), pc(c)));
  const REJ = { ...SK, test_order: { status: "failed", state: "rejected", at: S - 20 }, probe: { status: "failed", state: "unknown", env: "live", at: S - 3 } };
  const rj = rowsOf(REJ);
  ok("B-1 略過前測試單被拒 → 正式 UNKNOWN:測試主機那列有「改做測試單」(pres-test-back),測試單那列不寫「已略過」",
    view(pc(REJ)) === "d-UNKNOWN" && rj.indexOf('"btn":"pres-test-back"') >= 0 && !/"name":"pres\.s\.torder","right":"pres\.s\.skipped"/.test(rj), rj);
  ok("B-1 對照:沒被拒的略過照舊有鈕;沒略過(正常走到正式)沒有鈕、測試主機列打勾",
    rowsOf({ ...SK, probe: { status: "failed", state: "unknown", env: "live", at: S - 3 } }).indexOf('"btn":"pres-test-back"') >= 0
    && rowsOf({ env: "live", cert: CERT_OK, test_order: { status: "failed", at: S - 20 }, probe: { status: "ok", state: "ok", env: "live", at: S - 3 } }, "d-finish").indexOf('"btn":"pres-test-back"') < 0
    && /"name":"pres\.s\.tprobe","right":"pres\.s\.tprobeDone"/.test(rowsOf({ env: "live", cert: CERT_OK, test_order: { status: "failed", at: S - 20 }, probe: { status: "ok", state: "ok", env: "live", at: S - 3 } }, "d-finish")));
  // Wei 10-08 實測:「直接登入正式主機」在憑證還沒完成時就出現,跟「用這張憑證」撞在一起。憑證(與安裝)好了才畫;之前測試段三列全灰、沒有任何鈕
  const noCert = [rowsOf({ env: "test" }), rowsOf({ env: "test", cert: { status: "failed", error: "PFX_PASSWORD", at: S - 5 } }), rowsOf({ env: "test", cert: { status: "importing", at: S - 2 } }), rowsOf({ env: "test", setup: { status: "idle", at: null } })];
  ok("憑證未 ok(idle / failed / importing)或 setup 未 ok → 沒有 pres-skip-test,測試段三列 todo、沒有鈕", noCert.every((r) => r.indexOf("pres-skip-test") < 0
    && /"name":"pres\.s\.tprobe","right":""/.test(r) && /"kind":"todo","name":"pres\.s\.torder"/.test(r) && /"kind":"todo","name":"pres\.s\.treport"/.test(r) && !/"btn":"pres-(skip-test|test-back|torder)"/.test(r)), noCert);
  ok("憑證 ok、測試單未 ok → 有 pres-skip-test;測試單 ok 後沒有", rowsOf({ env: "test", cert: CERT_OK }).indexOf('"btn":"pres-skip-test"') >= 0
    && rowsOf({ env: "test", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "test", at: S - 3 } }).indexOf('"btn":"pres-skip-test"') >= 0
    && rowsOf({ env: "test", cert: CERT_OK, probe: { status: "ok", state: "ok", env: "test", at: S - 9 }, test_order: { status: "ok", state: "accepted", at: S - 3 } }).indexOf("pres-skip-test") < 0); }
// 稽核 integ-0118 B-1:設定 › 帳戶 的「開通中＋繼續」看 worker.ok_at(開通過又停掉的不算開通中),同 trade.js trPresWip
ok("presWip:worker ok 過(ok_at)就不是開通中", /function presWip\(r\) \{[^\n]*c\.worker\.status === "ok" \|\| c\.worker\.ok_at/.test(src));
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
// Wei 10-07:不講「算／不算登入次數」「連錯三次」——用戶不需要數
const presKeys = Object.keys(sctx.S.zh).filter((k) => k.indexOf("pres.") === 0);
const countZh = presKeys.filter((k) => /次數|三次|登入次/.test(sctx.S.zh[k])), countEn = presKeys.filter((k) => /attempt|three wrong|count as/i.test(sctx.S.en[k] || ""));
ok("pres.* 兩語都沒有登入次數那類句子", countZh.length === 0 && countEn.length === 0, countZh.concat(countEn));
ok("「這一步沒有開始。再試一次。」", sctx.S.zh["pres.err.generic"] === "這一步沒有開始。再試一次。");
// 完成頁(設計師裁定,Wei 嫌字多):兩句說明逐字;夜盤 / 電腦不睡 / 同月份那幾句搬去啟動框(check_shell_start_box.js),完成頁不再有
ok("完成頁兩句說明逐字;沒有夜盤、不睡、同月份;完成頁只有 n1 / n2 兩句", sctx.S.zh["pres.done.n1"] === "結束 Blave 或關機就不再下單；部位留在統一，不會自動平倉。" && sctx.S.zh["pres.done.n2"] === "Blave 只管自己下的單，不碰你手動下的。"
  && sctx.S.en["pres.done.n1"] === "Quit Blave or shut down and orders stop; positions stay at President and aren’t closed." && sctx.S.en["pres.done.n2"] === "Blave manages only its own orders and never touches trades you place by hand."
  && Object.keys(sctx.S.zh).filter((k) => k.indexOf("pres.done.") === 0).every((k) => !/夜盤|不睡|月份|night|awake|month/i.test(sctx.S.zh[k] + sctx.S.en[k]))
  && /\["pres\.done\.n1", "pres\.done\.n2"\]\.forEach/.test(src) && !/pres\.done\.n3/.test(src));
ok("stopNote 沒有數字", !/\d/.test(sctx.S.zh["pres.err.stopNote"]) && !/\d/.test(sctx.S.en["pres.err.stopNote"]));
// 設計稽核 desktop-10-08(電腦版統一畫面)#2 / #8 / #10
ok("#2 第一次真錢框:權益數「12,147,198 TWD」(trTwd 整數 + 幣別後綴),不用 NT$;保證金那句不再講「統一沒有給用戶的模擬環境」",
  !/"NT\$/.test(src) && /t\("pres\.first\.equity", \{ v: trTwd\(a\.equity\) \+ " " \+ TR_TXF_CCY \}\)/.test(src) && /trEl\("div", "v mono", typeof a\.equity === "number" \? trTwd\(a\.equity\) \+ " " \+ TR_TXF_CCY : "—"\)/.test(src)
  && sctx.S.zh["pres.first.margin"] === "每口保證金以統一公告為準；保證金不足時統一會拒單。這幾口是真錢。" && !/模擬環境|simulated/i.test(sctx.S.zh["pres.first.margin"] + sctx.S.en["pres.first.margin"]));
{ const body = src.slice(src.indexOf("function presProbeBody("), src.indexOf("function presTestHostBody("));
  ok("#8 失敗畫面的輔助句照類別:PASSWORD / UNKNOWN → 被鎖找營業員;TIMEOUT → 恢復後再試;憑證 / 維護 / 沒帳密 → 沒有輔助句",
    /const hintKey = view === "d-PASSWORD" \|\| view === "d-UNKNOWN" \? "pres\.err\.stopNote" : view === "d-TIMEOUT" \? "pres\.err\.retryNote" : null;/.test(body)
    && /hintKey \? presP\("cx-hint", t\(hintKey\)\) : null/.test(body));
  ok("#8 字串:stopNote 只剩鎖住那半句(不重述「按「確認登入」」);retryNote 逐字", sctx.S.zh["pres.err.stopNote"] === "如果被統一鎖住，請聯絡營業員解鎖。" && !/確認登入|Confirm login/.test(sctx.S.zh["pres.err.stopNote"] + sctx.S.en["pres.err.stopNote"])
    && sctx.S.zh["pres.err.retryNote"] === "網路或統一恢復後再試一次。" && /President/.test(sctx.S.en["pres.err.retryNote"]) && !/lock/i.test(sctx.S.en["pres.err.retryNote"])); }
{ const cap = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "capital.js"), "utf8"), css = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "capital.css"), "utf8");
  ok("#10 憑證列右側「到期 2027/04/29」:漢字 sans、日期 .mono(同資產分頁「更新 + 時間」);capRow 收節點;CSS 有 .cap-r .mono", /certDone = exp \? trEl\("span", "", t\("pres\.s\.certExp"\) \+ " "\) : "";\n\s*if \(exp\) certDone\.appendChild\(trEl\("span", "mono", exp\)\);/.test(src)
    && sctx.S.zh["pres.s.certExp"] === "到期" && sctx.S.en["pres.s.certExp"] === "Expires" && !/\{date\}/.test(sctx.S.zh["pres.s.certExp"])
    && /if \(right && typeof right === "object"\) r\.appendChild\(right\); else r\.textContent = right \|\| "";/.test(cap) && /\.cap-r \.mono \{ font-family: "Roboto Mono"/.test(css)); }
// 0.1.18 設計師裁定 A:自動下單頁的統一在倉橫幅整塊拿掉(元素 / 畫法 / CSS / 兩個 key),口數改接在 trade.js 狀態句尾(tr.presAwake,check_shell_trade.js 驗句子)
{ const html = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "index.html"), "utf8"), css = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "president.css"), "utf8");
  const tr = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");
  ok("A 橫幅退場:#pres-banner 元素不存在、presBannerPaint 不存在(定義與呼叫點)、.pres-banner CSS 不存在、pres.held.lead / sub 兩語都沒有;presHeldLots 留著給 trade.js 用",
    !/id="pres-banner"|pres-banners/.test(html) && !/presBannerPaint/.test(src + tr) && !/\.pres-banner/.test(css)
    && ["pres.held.lead", "pres.held.sub"].every((k) => !(k in sctx.S.zh) && !(k in sctx.S.en)) && /^function presHeldLots\(report\)/m.test(src) && /presHeldLots\(r\)/.test(tr)
    && sctx.S.zh["tr.presAwake"] === "統一有 {n} 口在倉，電腦保持清醒" && /stays awake/.test(sctx.S.en["tr.presAwake"])); }
console.log(red ? `\n${red} 紅` : "\n全綠"); process.exit(red ? 1 : 0);
