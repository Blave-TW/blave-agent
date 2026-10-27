/* 群益本機開通 — 憑證那一段(電腦版 Windows;設計 output/designer/capital-new-cert-2026-10/spec.md + mockup.html,
   spec output/specs/desktop-capital-new-cert-2026-10-20.md,Wei 10-20 全部拍板)。
   連接交易所框(#cx-scrim,trade.js)在「這台電腦」視角選到群益時,整個框交給這個檔畫:找憑證 →(沒有)申請新憑證或匯入 pfx → 帳密。
   - 順序對齊統一本機(president.js):先找憑證,找到就直接到帳密;沒有才分兩條路(pres-seg)、選了才展開,主鈕在腳。
   - 精靈開著時每 3 秒問主行程一次(capital_local.js):出現開精靈前沒有的那一張、私鑰用得了 → 帳密。app 只替用戶打開群益的精靈。
   - 撤銷提醒與雲端提醒(雲端主機已連群益,Wei 拍 A:不擋、只提醒)共用 #cx-where 那一格。系統地區不是繁中:沒有主鈕,
     腳左側 quiet「還是要開」。地區設定的選單名照 Windows 的顯示語言(主行程回 names),不照 Blave 的語言。
   - 找到能用的憑證之後:帳密表單(身分證字號、交易密碼)→ 開通清單(安裝群益元件 → 確認帳密 → 簽署 → 讀取帳戶)→ 完成。
     狀態只有一個來源:這台電腦 daemon 回報的 `capital_local_connect`(runtime/capital_local.py);長步驟回條等不到是常態,畫面看狀態走。
     自動的只有三步、每開一次框各一次:裝元件、第一次確認帳密、確認過了啟動讀取;登入失敗(任何一種)都停下來等用戶按。
   - 身分證字號與交易密碼只在這個框的欄位裡,送進主行程後就清掉;主行程不回給這裡(只講存了沒有)。整個入口受 trade.js CAPL_LOCAL_ON 管。
   - 匯出密碼只在這個框的欄位裡,送進主行程後就清掉;檔名(群益備份檔名含身分證)與路徑不進這裡。
   用到 capital.js 的 capErr / capBtn / capActs、president.js 的 presP / presInput 的長相、trade.js 的 $ / t / trEl / CXF / CAPITAL /
   TR_BAGS / cxModalClose / cxVenueField、app.js 的 trackFeature——都在呼叫時才取。 */
const CAPL_SCAN_MS = 3000;
// 10-20 在 test-4 驗過 `control intl.cpl` 直接開到「地區」視窗(設計 l-locale-btn 的前提);驗不過就改 false,改回純文字第 1 步
const CAPL_REGION_BTN = true;
// 地區設定的選單名(不進 .po:跟著 Windows 的顯示語言,不跟 Blave)
const CAPL_WIN_NAMES = {
  zh: { cp: "\u63a7\u5236\u53f0", cr: "\u6642\u9418\u548c\u5340\u57df", rg: "\u5730\u5340", adm: "\u7cfb\u7d71\u7ba1\u7406", chg: "\u8b8a\u66f4\u7cfb\u7d71\u5730\u5340\u8a2d\u5b9a", tw: "\u4e2d\u6587\uff08\u7e41\u9ad4\uff0c\u53f0\u7063\uff09" },
  en: { cp: "Control Panel", cr: "Clock and Region", rg: "Region", adm: "Administrative", chg: "Change system locale…", tw: "Chinese (Traditional, Taiwan)" },
};
// 埋點(feature_used 白名單;api desktop_telemetry.EVENTS 同一份):每開一次框每個名字最多一次、失敗不埋、不帶任何內容
const CAPL_FEATURE = { have: "capl_have_cert", wiz: "capl_wiz_open", anyway: "capl_wiz_anyway", fresh: "capl_cert_new",
  form: "capl_form_saved", setup: "capl_setup_done", probe: "capl_probe_ok", sign: "capl_sign_open", ready: "capl_ready" };
// 主行程／daemon 回的錯 → 框底那一句(這台電腦的版本;雲端那組寫的是「主機」)
const CAPL_MSG = { BUSY: "capl.busyStep", DAEMON_DOWN: "side.stopped", TIMEOUT: "side.stopped", NO_SECRETS: "capl.noCreds", REBOUND: "capl.noCreds",
  NO_SEAL: "pres.err.noSeal", LIB_OUTDATED: "capl.libOutdated", BAD_ID: "cap.err.idFormat", BAD_PW: "cap.err.pw" };
// 主行程開精靈失敗的代號 → 畫面的 err
const CAPL_WIZ_ERR = { DOWNLOAD: "dl", SIG: "sig", START: "launch", BUSY: "busy", LIST_FAILED: "list" };
const CAPL_ERR_KEY = { dl: "capl.errDl", sig: "capl.errSig", launch: "capl.errLaunch", busy: "capl.busy", list: "capl.errList" };
const CAPL_PFX_ERR = { PFX_PASSWORD: "cap.pfx.errPw", PFX_INVALID: "cap.pfx.errFile", PFX_TOO_LARGE: "cap.pfx.errFile", PFX_NOT_CAPITAL: "cap.pfx.errIssuer",
  PFX_EXPIRED: "cap.pfx.errExpired", PFX_OLDER: "capl.errOlder", READ_FAILED: "cap.pfx.errRead", IMPORT_FAILED: "cap.pfx.errImport" };

/* choice = 找不到 / 過期那一頁選的路:"new"(申請新憑證)/ "renew"(展延;過期頁的預設)/ "have"(匯入別台匯出的檔)/ null(還沒選)。
   wiz = 精靈開著(主行程說的);err = 開精靈那一下的失敗(dl / sig / launch / busy);done = 找到能用的那張的到期日(→ 帳密);
   nokey = 新的那張進庫了、但這個 Windows 帳號用不了私鑰(F10:不給再申請——再申請會再撤銷一次);cloud = 開框那一刻雲端主機已連群益 */
/* 帳密之後:flow = 進了開通清單;id / pw = 欄位(送出後清掉);sent = 送出、回報還沒動的那一步;setupSent / probeSent / startSent = 這次開框
   自動送過了;recheck = 重填交易密碼;unlockUsed = 307 解鎖後那一次已經用了;old = 刪舊證的計畫 {n, keep}(null = 還沒問) */
const caplBlank = () => ({ started: false, scan: null, loc: null, cloud: false, choice: null, wiz: false, err: null, picked: false, ppw: "",
  pfxErr: null, done: null, nokey: false, busy: false, seen: {}, sig: null, view: null,
  flow: false, id: "", pw: "", msg: null, storeOpen: false, sent: null, setupSent: false, probeSent: false, startSent: false,
  recheck: false, unlockUsed: false, signOpened: false, signChecked: false, verifyDl: false, verifyChecked: false, old: null, oldAsked: false, base: null, readyBurst: false });
let CAPL = caplBlank();
let caplTimer = null;

/* ── 純邏輯(tests/check_shell_capital_local_view.js 從原文切出來跑;這一段不准碰 DOM)── */
const CAPL_ERR_VIEW = { dl: "l-err-dl", sig: "l-err-sig", launch: "l-err-launch", list: "l-err-list" };
// (畫面自己的狀態, { win }) → 態的名字(設計 mockup 的 l-* 家族)。順序有意義:結果先、在等的再來、最後是選路
function caplView(ui, ctx) {
  if (!ctx.win) return "m-mac";
  if (ui.nokey) return "l-nokey";
  if (ui.done) return "l-form";
  if (ui.wiz) return ui.err === "busy" ? "l-wiz-busy" : "l-wiz";
  if (!ui.scan) return "l-cert-load";
  const exp = !!ui.scan.expired, choice = ui.choice || (exp ? "renew" : null);
  if (!choice) return "l-cert-none";
  if (choice === "have") return ui.picked ? (ui.pfxErr === "PFX_PASSWORD" ? "l-cert-picked-err" : "l-cert-picked") : exp ? "l-cert-expired-have" : "l-cert-have";
  // 系統地區讀不到(loc.ok === null)不擋:講不出「不是繁中」這句事實
  if (ui.loc && ui.loc.ok === false) return exp ? "l-cert-expired-locale" : "l-locale";
  if (exp) return ui.cloud ? "l-cert-expired-cloud" : "l-cert-expired";
  if (CAPL_ERR_VIEW[ui.err]) return CAPL_ERR_VIEW[ui.err];
  return ui.cloud ? "l-cloud-warn" : "l-cert-new";
}
// 態 → 腳:msg = #cx-where 那一句(revoke / cloud)、anyway = 腳左側 quiet「還是要開」、go = 主鈕的字 key、cancel = 取消鈕的字 key
const CAPL_APPLY = ["l-cert-new", "l-cloud-warn", "l-err-dl", "l-err-sig", "l-err-launch", "l-err-list", "l-cert-expired", "l-cert-expired-cloud"];
const CAPL_LOCALE = ["l-locale", "l-cert-expired-locale"];
// 開通清單的態(caplFlowView 回的):腳只有「關閉」;完成那一態是「完成」+ 鈕正上方那句「Blave 開著才下單」
const CAPL_FLOW = ["l-setup", "l-setup-fail", "l-probe", "l-probe-idle", "l-pw", "l-pw-err", "l-pw-change", "l-pw-locked", "l-verify", "l-sign", "l-sign-wait",
  "l-sign-none", "l-cert-bad", "l-cert-nokey", "l-old-row", "l-probe-fail", "l-start", "l-start-fail", "l-done"];
function caplFootSpec(view, ui) {
  if (view === "l-done") return { msg: "local", anyway: false, go: "cap.finish", cancel: null };
  if (CAPL_FLOW.indexOf(view) >= 0) return { msg: null, anyway: false, go: null, cancel: "set.close" };
  if (view === "l-form") return { msg: null, anyway: false, go: "cap.go", cancel: "del.cancel" };
  const msg = CAPL_APPLY.indexOf(view) >= 0 || CAPL_LOCALE.indexOf(view) >= 0 ? (ui.cloud ? "cloud" : "revoke") : null;
  const go = CAPL_APPLY.indexOf(view) >= 0 ? "capl.open" : view === "l-cert-have" || view === "l-cert-expired-have" ? "capl.pick"
    : view === "l-cert-picked" || view === "l-cert-picked-err" ? "capl.import" : null;
  const later = view === "l-cert-none" || go || CAPL_LOCALE.indexOf(view) >= 0;
  return { msg, anyway: CAPL_LOCALE.indexOf(view) >= 0, go, cancel: later ? "pres.later" : view === "l-nokey" ? "set.close" : "del.cancel" };
}
// 雲端主機的回報:帳密綁著、或下單程式起來過 = 已連群益(讀不到 = 沒有,用一般的撤銷提醒)
function caplCloudOn(report) {
  const v = report && report.venues && report.venues.capital, w = report && report.capital_connect && report.capital_connect.worker;
  return !!(v && v.credentials) || !!(w && w.status === "ok");
}
const CAPL_STUCK_MS = 25 * 60 * 1000;
const CAPL_BUSY_STEP = { "capital_local:setup": "setup", "capital_local:probe": "probe", "capital_local:start": "start", "capital_local:bind": "bind" };
const caplSec = (cc, k) => (cc && cc[k] && typeof cc[k] === "object" ? cc[k] : {});
// 哪一步在跑:段落 running(25 分鐘內)> daemon 的 busy > 剛送出、回報還沒動的那一步
function caplRunning(cc, sent, now) {
  const fresh = (sec) => typeof sec.at !== "number" || now - sec.at * 1000 < CAPL_STUCK_MS;
  const s = (k) => caplSec(cc, k).status === "running" && fresh(caplSec(cc, k));
  if (s("worker")) return "start";
  if (s("probe")) return "probe";
  if (s("setup")) return "setup";
  const upd = cc && typeof cc.updated_at === "number" ? now - cc.updated_at * 1000 < CAPL_STUCK_MS : true;
  if (cc && typeof cc.busy === "string" && CAPL_BUSY_STEP[cc.busy] && upd) return CAPL_BUSY_STEP[cc.busy];
  return sent ? sent.step : null;
}
// runtime capital_connect.CODE_STATES / probe_state 的 state → 清單的態(憑證兩類要看能不能刪舊證)
const CAPL_PROBE_VIEW = { pw_wrong: "l-pw-err", no_credentials: "l-pw-err", pw_locked: "l-pw-locked", verify_needed: "l-verify", no_accounts: "l-sign",
  cert_unusable: "l-cert-nokey", cert_old: "cert", cert_expired: "cert" };
/* (capital_local_connect, 畫面自己的狀態, now) → 開通清單的態。順序有意義:在跑的最先(鈕全鎖),再來是要用戶做事的,最後才往下一步 */
function caplFlowView(cc, ui, now) {
  const setup = caplSec(cc, "setup"), probe = caplSec(cc, "probe"), worker = caplSec(cc, "worker");
  const run = caplRunning(cc, ui.sent, now);
  if (run === "start") return "l-start";
  if (run === "probe" || run === "bind") return "l-probe";
  if (run === "setup") return "l-setup";
  if (setup.status === "failed") return "l-setup-fail";
  if (setup.status !== "ok") return "l-setup";
  if (ui.recheck) return ui.unlockUsed ? "l-pw-change" : "l-pw";
  if (worker.status === "ok") return "l-done";
  const werr = String(worker.error || "");
  if (worker.status === "failed" && werr.indexOf("LOGIN_FAILED:") !== 0) return "l-start-fail";
  // 下單程式自己登入被拒停下來(LOGIN_FAILED:<state>)= 同一組畫面;之後按了確認、而且比它新 = 往下走
  let st = probe.status === "failed" && typeof probe.state === "string" ? probe.state : null;
  if (worker.status === "failed" && !(probe.status === "ok" && (probe.at || 0) > (worker.at || 0))) st = werr.slice(13) || "unknown";
  if (st) {
    const v = CAPL_PROBE_VIEW[st] || "l-probe-fail";
    if (v === "cert") return ui.old && ui.old.n > 0 ? "l-old-row" : "l-cert-bad";
    if (v === "l-pw-locked" && ui.unlockUsed) return "l-pw-change";
    if (v === "l-sign") return ui.signChecked ? "l-sign-none" : ui.signOpened ? "l-sign-wait" : "l-sign";
    return v;
  }
  if (probe.status === "ok" && probe.state === "ok") return "l-start";
  return "l-probe-idle";
}
// setup.error(SETUP_FAILED:vcredist:<原因>,…,runtime capital_local._ensure_vc)→ 失敗那一句的 [key, vars];讀不懂 = 原本那句
const CAPL_VC_WHY = { 1618: "capl.setupBusy", denied: "capl.setupDenied", reboot: "capl.setupReboot" };
function caplSetupFailMsg(err) {
  const s = String(err || ""), items = s.indexOf("SETUP_FAILED:") === 0 ? s.slice(13).split(",") : [];
  const vc = items.find((x) => x.indexOf("vcredist:") === 0), why = vc ? vc.slice(9) : "";
  if (CAPL_VC_WHY[why]) return [CAPL_VC_WHY[why]];
  if (/^-?\d{1,10}$/.test(why)) return ["capl.setupFailCode", { code: why }];
  return ["cap.s.setupFail"];
}
/* ── 純邏輯到此 ── */

function caplCtx() { return { win: window.blave.platform === "win32" }; }
function caplTrack(k) { if (CAPL_FEATURE[k] && !CAPL.seen[k]) { CAPL.seen[k] = true; trackFeature(CAPL_FEATURE[k]); } }
function caplForget() {
  CAPL = caplBlank();
  caplWatch(false);
  // 連接框開關、換交易所都會走到這裡;旗標關時主行程沒註冊 capl-forget,叫了只會記一行 No handler registered
  if (CAPL_LOCAL_ON && window.blave && typeof window.blave.caplForget === "function") window.blave.caplForget().catch(() => {});
}
const caplCC = () => { const r = TR_BAGS.local.st && TR_BAGS.local.st.report; const c = r && r.capital_local_connect; return c && typeof c === "object" ? c : null; };
const caplDown = () => !(TR_BAGS.local.st && TR_BAGS.local.st.running);
async function caplStart() {
  CAPL.started = true;
  CAPL.cloud = caplCloudOn(TR_BAGS.cloud.st && TR_BAGS.cloud.st.report);
  let loc = null; try { loc = await window.blave.caplLocale(); } catch (_) { }
  CAPL.loc = loc && loc.code === "OK" ? { ok: loc.ok, names: loc.names === "zh" ? "zh" : "en" } : null;
  // 帳密存過、這台電腦開通過(有 capital_local_connect)→ 直接回到清單;否則先找憑證
  let info = null; try { info = await window.blave.caplInfo(); } catch (_) { }
  if (info && info.saved && caplCC()) {
    let r = null; try { r = await window.blave.caplScan(); } catch (_) { }
    CAPL.scan = r && r.code === "OK" ? { usable: r.usable, expiry: r.expiry, expired: r.expired } : { usable: 0, expiry: null, expired: null };
    CAPL.done = CAPL.scan.expiry || "—"; CAPL.flow = true; caplPaint(); return;
  }
  await caplScanNow();
}
async function caplScanNow() {
  let r = null; try { r = await window.blave.caplScan(); } catch (_) { }
  const ok = !!r && r.code === "OK";
  if (CAPL.wiz && ok && r.fresh) {
    if (r.keyOk) { CAPL.done = r.expiry || "—"; caplTrack("fresh"); } else CAPL.nokey = true;
    CAPL.wiz = false; caplWatch(false);
  } else if (CAPL.wiz && r && r.wizOpen === false) {
    // 精靈關了、沒有新的那張(取消、簡訊碼錯、群益拒絕):回到原本那一頁,分段鈕停在原本選的路(l-wiz-none)
    CAPL.wiz = false; CAPL.err = null; caplWatch(false);
    // 快照丟過(關框重開、Blave 重開)就分不出新舊:庫裡有能用的就到帳密(spec F12/F13),不讓他再開一次精靈、再撤銷一次
    if (ok && r.usable > 0) CAPL.done = r.expiry || "—";
  } else if (!CAPL.wiz && ok && r.usable > 0) { CAPL.done = r.expiry || "—"; caplWatch(false); }
  CAPL.scan = ok ? { usable: r.usable, expiry: r.expiry, expired: r.expired } : { usable: 0, expiry: null, expired: null };
  caplPaint();
}
function caplWatch(on) {
  if (caplTimer) { clearInterval(caplTimer); caplTimer = null; }
  if (on) caplTimer = setInterval(() => { if ($("cx-scrim").hidden || CXF.venue !== CAPITAL || CXF.env !== "local") return caplWatch(false); caplScanNow(); }, CAPL_SCAN_MS);
}
async function caplOpenWizard(anyway) {
  if (CAPL.busy) return;
  CAPL.busy = true; CAPL.err = null; caplPaint();
  let r = null; try { r = await window.blave.caplWizard(); } catch (_) { }
  CAPL.busy = false;
  const code = r && r.code;
  if (code === "OK") { CAPL.wiz = true; caplTrack("wiz"); if (anyway) caplTrack("anyway"); caplWatch(true); }
  else if (code === "BUSY") { CAPL.wiz = true; CAPL.err = "busy"; caplWatch(true); }   // 精靈還開著(這次或上次開框時開的)
  else {
    CAPL.err = CAPL_WIZ_ERR[code] || "launch";
    // 下載不到 / 簽章不對:已經幫他開群益憑證專區;他自己下載、自己申請完,這一頁照樣接著到帳密
    if (CAPL.err === "dl" || CAPL.err === "sig") caplWatch(true);
  }
  caplPaint();
}
function caplChoose(c) {
  if (CAPL.choice === c || CAPL.busy) return;
  CAPL.choice = c; CAPL.err = null; CAPL.pfxErr = null;
  if (c === "have") caplTrack("have");
  caplPaint();
}
async function caplPick() {
  if (CAPL.busy) return;
  CAPL.busy = true; caplPaint();
  let r = null; try { r = await window.blave.caplPick(); } catch (_) { }
  CAPL.busy = false;
  if (r && r.code === "OK") { CAPL.picked = true; CAPL.pfxErr = null; }
  else if (r && r.code !== "CANCELED") CAPL.pfxErr = r.code || "READ_FAILED";
  caplPaint();
  const f = $("capl-ppw"); if (f && CAPL.picked) f.focus();
}
async function caplImport() {
  if (CAPL.busy || !CAPL.picked || !CAPL.ppw) return;
  CAPL.busy = true; CAPL.pfxErr = null; caplPaint();
  let r = null; try { r = await window.blave.caplImport(CAPL.ppw); } catch (_) { }
  CAPL.busy = false;
  const code = r && r.code;
  if (code === "OK") { CAPL.ppw = ""; CAPL.done = r.expiry || "—"; }
  else if (code === "NO_KEY") { CAPL.ppw = ""; CAPL.nokey = true; }
  else CAPL.pfxErr = CAPL_PFX_ERR[code] ? code : "IMPORT_FAILED";
  caplPaint();
  if (CAPL.pfxErr === "PFX_PASSWORD") { const f = $("capl-ppw"); if (f) f.focus(); }
}
function caplRegion() { window.blave.caplRegion().catch(() => {}); }

// ── 帳密之後 ─────────────────────────────────────────────────────────────────
const CAPL_ID_RE = /^[A-Z][1289A-D]\d{8}$/;   // = shell/capital_local.js ID_RE
async function caplGo() {
  if (CAPL.busy || caplDown() || !CAPL_ID_RE.test(CAPL.id.trim()) || !CAPL.pw) return;
  CAPL.busy = true; CAPL.msg = null; caplPaint();
  let r = null; try { r = await window.blave.caplConnect(CAPL.id.trim(), CAPL.pw); } catch (_) { }
  CAPL.busy = false;
  const code = r && r.code;
  if (code === "OK" || code === "SENT") { CAPL.id = ""; CAPL.pw = ""; CAPL.flow = true; caplTrack("form"); const cc = caplCC(); if (code === "SENT") CAPL.sent = { step: "bind", at: Date.now(), upd: cc ? cc.updated_at : null }; }
  else CAPL.msg = { code: code || "FAILED" };
  caplBurst(); caplPaint();
}
// 重填交易密碼(群益說不對 / 解鎖後還是不行):身分證用存著的那個(主行程有),只換密碼 → 再確認一次
async function caplRecheck() {
  if (CAPL.busy || caplDown() || !CAPL.pw) return;
  CAPL.busy = true; CAPL.msg = null; caplPaint();
  let r = null; try { r = await window.blave.caplConnect(null, CAPL.pw); } catch (_) { }
  CAPL.busy = false;
  if (!(r && (r.code === "OK" || r.code === "SENT"))) { CAPL.msg = { code: (r && r.code) || "FAILED" }; caplPaint(); return; }
  CAPL.pw = ""; CAPL.recheck = false; CAPL.unlockUsed = false; CAPL.probeSent = true; CAPL.startSent = false;
  await caplStep("probe");
}
async function caplStep(name, o) {
  if (CAPL.busy || caplDown()) return;
  const cc = caplCC();
  CAPL.busy = true; CAPL.msg = null; caplPaint();
  let r = null; try { r = await window.blave.caplStep(name, o || {}); } catch (_) { }
  CAPL.busy = false;
  const code = r && r.code, unlock = !!(o && o.afterUnlock);
  if (code === "OK" || code === "SENT") { CAPL.sent = { step: name, at: Date.now(), upd: cc ? cc.updated_at : null }; if (unlock) CAPL.unlockUsed = true; }
  else if (code === "PW_RECHECK_NEEDED") { CAPL.recheck = true; if (unlock) CAPL.unlockUsed = true; }
  else CAPL.msg = { code: code || "FAILED" };
  caplBurst(); caplPaint();
}
function caplBurst() { ENV.burst = trBurstBump(ENV.burst, Date.now(), TR_BURST_MS, TR_BURST_MAX_MS); trPollSoon(1500); }
function caplSign() { window.blave.openExternal(CAP_SIGN_URL); CAPL.signOpened = true; caplTrack("sign"); caplPaint(); }
function caplVerifyDl() { window.blave.openExternal(CAP_VERIFY_URL); CAPL.verifyDl = true; caplPaint(); }
// 憑證過期／被撤銷、也沒有舊的可以刪:回到找憑證那一段(申請新的或匯入)
function caplBackToCert() { const keep = { started: true, loc: CAPL.loc, cloud: CAPL.cloud, seen: CAPL.seen }; CAPL = Object.assign(caplBlank(), keep); caplScanNow(); }
async function caplOldPlan() {
  CAPL.oldAsked = true;
  let r = null; try { r = await window.blave.caplOld(false); } catch (_) { }
  CAPL.old = r && r.code === "OK" ? { n: r.n, keep: r.keep } : { n: 0, keep: null };
  caplPaint();
}
// 刪舊證:確認框(不出現指紋或身分證)→ 主行程照同一套重算再刪 → 再確認一次帳密(600/604 不是密碼的錯,不會鎖帳號)
function caplOldConfirm(opener) {
  const n = CAPL.old ? CAPL.old.n : 0, keep = CAPL.old && CAPL.old.keep;
  confirmBox({ title: t("capl.oldTitle"), opener, lines: [t("capl.oldBody", { n }), keep ? t("capl.oldKeep", { date: keep }) : null].filter(Boolean), ok: t("capl.oldOk"),
    onOk: async () => {
      CAPL.busy = true; caplPaint();
      let r = null; try { r = await window.blave.caplOld(true); } catch (_) { }
      CAPL.busy = false;
      if (!(r && r.code === "OK" && r.n === 0)) { CAPL.msg = { code: "OLD_FAILED" }; CAPL.old = r && r.code === "OK" ? { n: r.n, keep: r.keep } : CAPL.old; caplPaint(); return; }
      CAPL.old = null; CAPL.oldAsked = false;
      await caplStep("probe");
    } });
}
/* 看回報推進:sent 在回報動了就收;自動的三步(每開一次框各一次):裝元件 → 第一次確認帳密 → 確認過了啟動讀取。
   登入失敗不會自動再試(任何一種都等用戶按)。憑證那兩類先問一次能不能刪舊證 */
function caplAdvance(view, cc) {
  if (CAPL.sent && cc && cc.updated_at !== CAPL.sent.upd) {
    if (CAPL.sent.step === "probe" && CAPL.signOpened) CAPL.signChecked = true;
    if (CAPL.sent.step === "probe" && CAPL.verifyDl) CAPL.verifyChecked = true;
    CAPL.sent = null;
  }
  const setup = caplSec(cc, "setup"), worker = caplSec(cc, "worker"), probe = caplSec(cc, "probe");
  // 埋點只記這次開框真的看到它完成(開框時已經完成的不算)
  if (!CAPL.base && cc) CAPL.base = { setup: setup.status || null, probe: probe.status === "ok" ? probe.state : null, worker: worker.status || null };
  if (setup.status === "ok" && CAPL.base.setup !== "ok") caplTrack("setup");
  if (probe.status === "ok" && probe.state === "ok" && CAPL.base.probe !== "ok") caplTrack("probe");
  // 這次開框看到下單程式起來:主畫面要等 daemon 重讀帳戶(runtime capital_local._ready)才有總權益,這幾秒改快輪詢接住
  if (worker.status === "ok" && CAPL.base.worker !== "ok" && !CAPL.readyBurst) { CAPL.readyBurst = true; caplBurst(); }
  if ((view === "l-old-row" || view === "l-cert-bad") && !CAPL.oldAsked) { caplOldPlan(); return; }
  if (CAPL.busy || CAPL.sent || caplDown() || (cc && cc.busy)) return;
  if (!CAPL.setupSent && setup.status !== "ok" && setup.status !== "running" && setup.status !== "failed") { CAPL.setupSent = true; caplStep("setup"); return; }
  if (view === "l-probe-idle" && !CAPL.probeSent) { CAPL.probeSent = true; caplStep("probe"); return; }
  if (view === "l-start" && !CAPL.startSent && worker.status !== "running") { CAPL.startSent = true; caplStep("start"); }
}

// ── DOM ────────────────────────────────────────────────────────────────────
const caplP = (cls, text) => trEl("p", cls, text);
// 一句裡有一個值要換字體(日期 mono):t(k, {name: \0}) 切開,值包 .mono
function caplWithMono(cls, k, name, val) {
  const p = trEl("p", cls);
  t(k, { [name]: "\u0000" }).split("\u0000").forEach((part, i) => { if (i) p.appendChild(trEl("span", "pres-mono", val)); if (part) p.appendChild(document.createTextNode(part)); });
  return p;
}
function caplSeg(exp) {
  const seg = trEl("div", "pres-seg"), cur = CAPL.choice || (exp ? "renew" : null);
  seg.setAttribute("role", "group"); seg.setAttribute("aria-label", exp ? t("capl.renew") : t("capl.none"));
  const opts = exp ? [["renew", "capl.renew"], ["have", "pres.none.have"]] : [["new", "pres.none.new"], ["have", "pres.none.have"]];
  opts.forEach(([c, k]) => { const b = capBtn("", t(k), () => caplChoose(c), "capl-seg-" + c); b.setAttribute("aria-pressed", cur === c ? "true" : "false"); seg.appendChild(b); });
  return seg;
}
function caplTodo(items) {
  const ol = trEl("ol", "pres-todo");
  items.forEach(([main, sub]) => { const li = trEl("li", ""); if (typeof main === "string") li.appendChild(trEl("span", "", main)); else li.appendChild(main); if (sub) li.appendChild(trEl("span", "sub", sub)); ol.appendChild(li); });
  return ol;
}
// 系統地區那三步;第 1 步驗過的話換成開地區設定的描邊鈕
function caplLocaleSteps() {
  const W = CAPL_WIN_NAMES[CAPL.loc && CAPL.loc.names === "zh" ? "zh" : "en"];
  const s1 = CAPL_REGION_BTN ? capBtn("btn-out capl-region", t("capl.openRegion"), caplRegion, "capl-region") : t("capl.loc1", W);
  return caplTodo([[s1], [t("capl.loc2", W), t("capl.loc2sub")], [t("capl.loc3")]]);
}
function caplPickedBody() {
  const f = document.createDocumentFragment(), card = trEl("div", "pres-found");
  const mk = trEl("span", "cap-mk"); mk.appendChild(trEl("span", "cur")); mk.setAttribute("aria-hidden", "true");
  const tx = trEl("div", "capl-tx"); tx.append(trEl("div", "t", t("pres.cert.picked")), trEl("div", "d", t("capl.pickedD")));
  card.append(mk, tx, capBtn("btn-quiet", t("pres.cert.other"), caplPick, "capl-other", CAPL.busy));
  f.appendChild(card);
  const pwErr = CAPL.pfxErr === "PFX_PASSWORD";
  const l = trEl("label", "fld"); l.appendChild(trEl("span", "fld-l", t("cap.pfx.pw")));
  const i = trEl("input", "f-input txt" + (pwErr ? " is-err" : "")); i.id = "capl-ppw"; i.type = "password"; i.autocomplete = "new-password"; i.spellcheck = false;
  i.setAttribute("autocapitalize", "off"); i.value = CAPL.ppw; i.readOnly = !!CAPL.busy;
  i.addEventListener("input", () => { CAPL.ppw = i.value; caplSyncGo(); });
  i.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); caplImport(); } });
  const under = pwErr ? trEl("p", "cap-err", t("cap.pfx.errPw")) : caplP("cx-hint", t("cap.pfx.pwHint"));
  under.id = "capl-ppw-" + (pwErr ? "err" : "hint"); if (pwErr) under.setAttribute("role", "status"); i.setAttribute("aria-describedby", under.id);
  l.append(i, under); f.appendChild(l);
  if (CAPL.pfxErr && !pwErr) f.appendChild(capErr(t(CAPL_PFX_ERR[CAPL.pfxErr] || "cap.pfx.errImport")));
  return f;
}
function caplBody(view) {
  const f = document.createDocumentFragment();
  f.appendChild(cxVenueField(TR_BAGS.local));
  if (view === "m-mac") { f.appendChild(caplP("cap-lead", t("capl.mac"))); return f; }
  if (view === "l-cert-load") { f.appendChild(caplP("cap-lead", t("capl.looking"))); return f; }
  if (view === "l-form") { f.appendChild(caplFormBody()); return f; }
  if (view === "l-nokey") { f.appendChild(capErr(t("capl.noKey"))); return f; }
  if (view === "l-wiz" || view === "l-wiz-busy") {
    const row = trEl("div", "pres-wait"), sp = trEl("span", "spin16"); sp.setAttribute("aria-hidden", "true");
    row.append(sp, caplP("cap-lead", t("capl.wait")));
    f.append(row, caplP("cx-hint", t("capl.waitHint")), capActs(capBtn("btn-quiet", t("capl.again"), () => caplOpenWizard(false), "capl-again", CAPL.busy)));
    if (view === "l-wiz-busy") f.appendChild(capErr(t("capl.busy"), true));   // 不是失敗:灰短劃
    return f;
  }
  const exp = !!(CAPL.scan && CAPL.scan.expired), choice = CAPL.choice || (exp ? "renew" : null);
  f.appendChild(exp ? caplWithMono("cap-lead", "capl.expired", "date", CAPL.scan.expired) : caplP("cap-lead", t("capl.none")));
  f.appendChild(caplSeg(exp));
  if (!choice) return f;
  if (choice === "have") {
    if (CAPL.picked) { f.appendChild(caplPickedBody()); return f; }
    f.appendChild(caplTodo([[t("capl.h1")], [t("capl.h2")]]));
    if (CAPL.pfxErr) f.appendChild(capErr(t(CAPL_PFX_ERR[CAPL.pfxErr] || "cap.pfx.errRead")));
    return f;
  }
  if (CAPL_LOCALE.indexOf(view) >= 0) { f.append(caplP("cap-lead", t("capl.locale")), caplLocaleSteps()); }
  else if (exp) f.appendChild(caplP("cx-hint", t("capl.renewDo")));
  else f.appendChild(caplTodo([[t("capl.s1")], [t("capl.s2")]]));
  if (CAPL_ERR_KEY[CAPL.err] && CAPL.err !== "busy") f.appendChild(capErr(t(CAPL_ERR_KEY[CAPL.err])));
  return f;
}
// 欄位(身分證明碼大寫、交易密碼遮住;同雲端 capField 的長相),值只在 CAPL 裡、送出後清掉
function caplField(id, label, key, o) {
  const opts = o || {}, l = trEl("label", "fld"); l.appendChild(trEl("span", "fld-l", label));
  const i = trEl("input", "f-input txt" + (opts.plain ? " cap-idf" : "") + (opts.err ? " is-err" : "")); i.id = id; i.type = opts.plain ? "text" : "password";
  i.autocomplete = opts.plain ? "off" : "new-password"; i.spellcheck = false; i.setAttribute("autocapitalize", "off"); i.value = CAPL[key]; i.readOnly = !!CAPL.busy;
  i.addEventListener("input", () => { if (opts.plain && i.value !== i.value.toUpperCase()) { const p = i.selectionStart; i.value = i.value.toUpperCase(); i.setSelectionRange(p, p); } CAPL[key] = i.value; caplSyncGo(); });
  i.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing && opts.enter) { e.preventDefault(); opts.enter(); } });
  l.appendChild(i);
  if (opts.err) { const e = trEl("p", "cap-err", opts.err); e.id = id + "-err"; e.setAttribute("role", "status"); l.appendChild(e); i.setAttribute("aria-describedby", e.id); }
  return l;
}
function caplStore() {
  const note = trEl("div", "cx-note"), disc = trEl("button", "cx-disc", t("cap.store.q")), p = trEl("p", "cx-disc-p", t("capl.store"));
  disc.type = "button"; disc.id = "capl-store-q"; p.id = "capl-store"; disc.setAttribute("aria-controls", "capl-store");
  disc.setAttribute("aria-expanded", CAPL.storeOpen ? "true" : "false"); p.hidden = !CAPL.storeOpen;
  disc.addEventListener("click", () => { CAPL.storeOpen = !CAPL.storeOpen; disc.setAttribute("aria-expanded", CAPL.storeOpen ? "true" : "false"); p.hidden = !CAPL.storeOpen; });
  note.append(disc, p); return note;
}
function caplFormBody() {
  const f = document.createDocumentFragment();
  f.appendChild(caplWithMono("cap-lead", "capl.found", "date", CAPL.done));
  const idBad = CAPL.id.trim() && !CAPL_ID_RE.test(CAPL.id.trim());
  f.appendChild(caplField("capl-id", t("cap.id"), "id", { plain: true, err: idBad || (CAPL.msg && CAPL.msg.code === "BAD_ID") ? t("cap.err.idFormat") : null, enter: caplPrimary }));
  f.appendChild(caplField("capl-pw", t("cap.pw"), "pw", { enter: caplPrimary }));
  f.appendChild(caplStore());
  return f;
}
const caplMsgText = (m) => (m ? t(CAPL_MSG[m.code] || (m.code === "OLD_FAILED" ? "capl.oldFail" : "capl.generic")) : null);
// 「確認帳密」那一列要重填交易密碼的時候:欄位 + 重新確認(身分證不用再填,主行程存著)
function caplPwBody(lead) {
  const ready = !!CAPL.pw && !CAPL.busy && !caplDown();
  return capFrag(capDo(lead), caplField("capl-pw", t("cap.pw"), "pw", { enter: caplRecheck }), capActs(capBtn("btn-fill", t("cap.recheck"), caplRecheck, "capl-recheck", !ready)));
}
function caplFlowRows(view, cc) {
  const setup = caplSec(cc, "setup"), probe = caplSec(cc, "probe"), worker = caplSec(cc, "worker");
  const off = CAPL.busy || caplDown() || !!(cc && cc.busy), ol = trEl("ol", "cap-steps");
  const add = (li) => ol.appendChild(li), retry = (fn, id, label) => capActs(capBtn("btn-fill", t(label || "cap.retry"), fn, id, off));
  // 1 安裝群益元件(第一次缺微軟的 VC++ 2010 會跳一次 Windows 的「使用者帳戶控制」,先講)
  if (setup.status === "ok") add(capRow("done", t("cap.s.setup")));
  else if (view === "l-setup-fail") add(capRow("bad", t("cap.s.setup"), "", capFrag(capDo(t(...caplSetupFailMsg(setup.error))), retry(() => caplStep("setup"), "capl-retry", "cap.tryAgain"))));
  else add(capRow("run", t("cap.s.setup"), t("cap.s.setupRun"), capDo(t("capl.setupUac"), true)));
  // 2 群益憑證:這台電腦的憑證庫裡那張(到期日 mono)
  const exp = CAPL.done && CAPL.done !== "—" ? CAPL.done : null, right = exp ? trEl("span", "", t("pres.s.certExp") + " ") : "";
  if (exp) right.appendChild(trEl("span", "mono", exp));
  if (view === "l-old-row") add(capRow("bad", t("capl.s.cert"), "", capFrag(capDo(t("capl.old")), capActs(capBtn("btn-out", t("capl.oldRm"), () => caplOldConfirm($("capl-old-rm")), "capl-old-rm", off)))));
  else if (view === "l-cert-bad") add(capRow("bad", t("capl.s.cert"), "", capFrag(capDo(t("capl.certBad")), capActs(capBtn("btn-out", t("capl.certAgain"), caplBackToCert, "capl-cert-again", off)))));
  else if (view === "l-cert-nokey") add(capRow("bad", t("capl.s.cert"), "", capFrag(capDo(t("capl.noKey")), retry(() => caplStep("probe"), "capl-probe"))));
  else add(capRow("done", t("capl.s.cert"), right));
  // 3 確認帳密(登入一次);3′ 連線檢核(321 才出現)
  if (view === "l-probe") add(capRow("run", t("cap.s.pw"), t("cap.s.probe")));
  else if (view === "l-pw" || view === "l-pw-err") add(capRow("bad", t("cap.s.pw"), "", caplPwBody(t(probe.state === "no_credentials" && view === "l-pw-err" ? "capl.noCreds" : "cap.err.pw"))));
  else if (view === "l-pw-change") add(capRow("bad", t("cap.s.pw"), "", caplPwBody(t("cap.err.pwChange"))));
  else if (view === "l-pw-locked") add(capRow("bad", t("cap.s.pw"), "", capFrag(capDo(t("cap.err.pwLocked")), capDo(t("cap.c.unlockDo"), true),
    capActs(capBtn("btn-fill", t("cap.unlocked"), () => caplStep("probe", { afterUnlock: true }), "capl-unlock", off)))));
  else if (view === "l-probe-idle") add(capRow("cur", t("cap.s.pw"), "", retry(() => caplStep("probe"), "capl-probe", "cap.recheck")));
  else add(capRow(probe.status === "ok" && probe.state === "ok" || ["l-verify", "l-sign", "l-sign-wait", "l-sign-none", "l-start", "l-start-fail"].indexOf(view) >= 0 ? "done" : "todo", t("cap.s.pw")));
  if (view === "l-verify") {
    const again = capBtn("btn-fill", t("cap.retry"), () => caplStep("probe"), "capl-probe", off), dl = capBtn(CAPL.verifyDl ? "btn-quiet" : "btn-fill", t("cap.c.verifyDl"), caplVerifyDl, "capl-verify-dl");
    add(capRow("cur", t("cap.s.verify"), "", capFrag(CAPL.verifyChecked ? capErr(t("cap.s.verifyNot")) : null, capDo(t("capl.verifyDo")), CAPL.verifyDl ? capActs(again, dl) : capActs(dl))));
  }
  // 4 簽署 API 聲明書
  const signDo = capDo(t("cap.s.signDo"));
  if (view === "l-sign") add(capRow("cur", t("cap.s.sign"), "", capFrag(signDo, capActs(capBtn("btn-fill", t("cap.s.signOpen"), caplSign, "capl-sign")))));
  else if (view === "l-sign-wait") add(capRow("cur", t("cap.s.sign"), "", capFrag(signDo, capActs(capBtn("btn-fill", t("cap.s.signDone"), () => caplStep("probe"), "capl-probe", off), capBtn("btn-quiet", t("cap.s.signOpen"), caplSign)))));
  else if (view === "l-sign-none") add(capRow("cur", t("cap.s.sign"), "", capFrag(capErr(t("cap.s.signNone"), true), capActs(capBtn("btn-fill", t("cap.retry"), () => caplStep("probe"), "capl-probe", off), capBtn("btn-quiet", t("cap.s.signOpen"), caplSign)))));
  else add(capRow(["l-start", "l-start-fail"].indexOf(view) >= 0 || (probe.status === "ok" && probe.state === "ok") ? "done" : "todo", t("cap.s.sign")));
  // 5 讀取帳戶(下單程式起來、寫出第一份快照)
  if (view === "l-start") add(capRow("run", t("cap.s.read"), t("cap.s.readRun")));
  else if (view === "l-start-fail") add(capRow("bad", t("cap.s.read"), "", capFrag(capDo(t(String(worker.error || "") === "SNAPSHOT_ERROR" ? "cap.err.snapshot" : "cap.err.worker")),
    retry(() => { CAPL.startSent = true; caplStep("start"); }, "capl-retry", "cap.tryAgain"))));
  else if (view === "l-probe-fail") {
    const st = probe.state, key = st === "timeout" ? "cap.err.timeout" : st === "vehicle_failed" ? "capl.vehicle" : st === "api_version" ? "capl.apiVersion" : null;
    const txt = key ? t(key) : t("cap.err.unknownCode", { code: probe.code == null ? "—" : String(probe.code) });
    add(capRow("bad", t("cap.s.read"), "", capFrag(capDo(txt), st === "api_version" ? retry(() => caplStep("setup"), "capl-retry", "capl.reinstall") : retry(() => caplStep("probe"), "capl-probe"))));
  } else add(capRow("todo", t("cap.s.read")));
  return ol;
}
function caplDoneBody(cc) {
  const probe = caplSec(cc, "probe"), f = document.createDocumentFragment(), row = trEl("div", "cx-row");
  const st = trEl("span", "cn-st"); st.append(trEl("i", "dot"), trEl("span", "", t("cx.connected")));
  row.append(trEl("span", "n", t("cap.venue")), trEl("span", "mode real", t("tr.mode.real")), st);
  f.appendChild(row);
  const dl = trEl("dl", "cap-acct"), kv = (k, v, cls) => { const d = trEl("div", ""); d.append(trEl("dt", "", k), trEl("dd", cls || "", v)); dl.appendChild(d); };
  kv(t("cap.acct.tf"), probe.futures ? t("cap.acct.read") : "—", probe.futures ? "" : "none");
  if (CAPL.done && CAPL.done !== "—") kv(t("cap.acct.exp"), CAPL.done, "mono");
  f.appendChild(dl);
  if (!probe.futures && probe.securities) { const p = trEl("p", "cx-manual-note", t("cap.tfMissing") + " "); p.appendChild(capBtn("btn-quiet", t("cap.s.signOpen"), caplSign)); f.appendChild(p); }
  return f;
}

// 腳:撤銷／雲端提醒在 #cx-where(鈕正上方、佔滿一列);「還是要開」是動態插進去的 quiet 鈕(腳左側),換交易所時 caplFootRestore 拿掉
function caplFoot(view) {
  const s = caplFootSpec(view, CAPL), go = $("cx-go"), cancel = $("cx-cancel"), where = $("cx-where"), foot = go.parentNode;
  where.hidden = !s.msg; where.textContent = s.msg ? t(s.msg === "cloud" ? "capl.cloudWarn" : s.msg === "local" ? "capl.localOnly" : "capl.revoke") : "";
  where.classList.toggle("is-strong", s.msg === "cloud");
  if (s.msg) where.setAttribute("role", "status"); else where.removeAttribute("role");
  let q = $("capl-anyway");
  if (s.anyway && !q) { q = capBtn("btn-quiet lead", t("capl.anyway"), () => caplOpenWizard(true), "capl-anyway"); foot.insertBefore(q, cancel); }
  else if (!s.anyway && q) q.remove();
  if (q && s.anyway) { q.textContent = t("capl.anyway"); q.disabled = !!CAPL.busy; }
  go.hidden = !s.go;
  if (s.go && go.textContent.trim() !== t(s.go)) go.textContent = t(s.go);
  cancel.hidden = !s.cancel; if (s.cancel) cancel.textContent = t(s.cancel);
  go.classList.toggle("is-busy", !!s.go && CAPL.busy);
  caplSyncGo(view);
}
function caplSyncGo(view) {
  const v = view || CAPL.view, go = $("cx-go");
  let off = CAPL.busy;
  if (v === "l-cert-picked" || v === "l-cert-picked-err") off = off || !CAPL.ppw;
  if (v === "l-form") off = off || caplDown() || !CAPL_ID_RE.test(CAPL.id.trim()) || !CAPL.pw;
  go.setAttribute("aria-disabled", off ? "true" : "false");
  const rb = $("capl-recheck"); if (rb) rb.setAttribute("aria-disabled", !CAPL.pw || CAPL.busy || caplDown() ? "true" : "false");
}
function caplFootRestore() {
  const q = $("capl-anyway"); if (q) q.remove();
  const where = $("cx-where"); where.classList.remove("is-strong"); where.removeAttribute("role");
  $("cx-go").classList.remove("is-busy");
}
// cx-go 按下(trade.js 的 cxConnect 交過來)
function caplPrimary() {
  if ($("cx-go").getAttribute("aria-disabled") === "true") return;
  const s = caplFootSpec(CAPL.view, CAPL);
  if (s.go === "capl.open") return caplOpenWizard(false);
  if (s.go === "capl.pick") return caplPick();
  if (s.go === "capl.import") return caplImport();
  if (s.go === "cap.go") return caplGo();
  if (s.go === "cap.finish") { caplTrack("ready"); cxModalClose(true); if (!(TR.open && TR.view === "tr")) trOpen(); }
}

function caplPaint() {
  if ($("cx-scrim").hidden || CXF.venue !== CAPITAL || CXF.env !== "local") return;
  const ctx = caplCtx(), cc = caplCC();
  let view = caplView(CAPL, ctx);
  if (ctx.win && CAPL.flow) { view = caplFlowView(cc, CAPL, Date.now()); caplAdvance(view, cc); view = caplFlowView(cc, CAPL, Date.now()); }
  CAPL.view = view;
  const box = $("cx-body");
  $("cx-title").textContent = t("cap.title");
  $("cx-modal").querySelector(".modal-head").classList.remove("cloud");
  $("cx-env").hidden = false; $("cx-env").textContent = t("env.local");
  caplFoot(view);
  box.setAttribute("aria-busy", CAPL.busy || ["l-cert-load", "l-wiz", "l-setup", "l-probe", "l-start"].indexOf(view) >= 0 ? "true" : "false");
  const sig = LANG + "|" + JSON.stringify([view, CAPL.scan, CAPL.loc, CAPL.cloud, CAPL.choice, CAPL.err, CAPL.picked, CAPL.pfxErr, CAPL.done, CAPL.busy,
    CAPL.flow && cc, CAPL.msg, CAPL.old, CAPL.signOpened, CAPL.verifyDl, CAPL.verifyChecked, caplDown()]);
  if (CAPL.sig === sig && box.firstChild) return;
  CAPL.sig = sig;
  const hadId = box.contains(document.activeElement) ? document.activeElement.id : null;
  box.textContent = "";
  if (CAPL_FLOW.indexOf(view) >= 0 && view !== "l-done") box.appendChild(caplFlowRows(view, cc));
  else if (view === "l-done") box.appendChild(caplDoneBody(cc));
  else box.appendChild(caplBody(view));
  // 框層級的那一句(步驟沒送出去、daemon 沒在跑):放最後,離鈕最近
  const slot = trEl("div", ""); slot.setAttribute("role", "status"); box.appendChild(slot);
  const m = CAPL.flow || view === "l-form" ? (caplDown() ? t("side.stopped") : caplMsgText(CAPL.msg)) : null;
  if (m) slot.appendChild(capErr(m, !caplDown() && CAPL.msg && CAPL.msg.code === "BUSY"));
  caplSyncGo(view);
  const back = hadId && $(hadId);
  if (back && !back.disabled) back.focus();
}
