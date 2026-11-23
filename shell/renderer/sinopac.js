/* 永豐期貨 本機開通(電腦版 Mac／Windows;設計 sinopac-connect-2026-11-17 spec.md + mockup.html,Wei 11-17 拍板)。
   連接帳戶框(#cx-scrim,trade.js)在「這台電腦」視角選到永豐時,整個框交給這個檔畫:一頁表單 → 開通清單(四列)→ 完成。
   - 狀態只有一個來源:這台電腦 daemon 回報的 `sinopac_connect`(runtime/sinopac_connect.py;TR_BAGS.local.st.report)。
     長步驟回條等不到是常態,畫面看狀態走。一列只有一個狀態。
   - 金鑰、身分證字號、憑證密碼只在這個框的欄位裡,送進主行程(sinopac_local.js)後就清掉;憑證檔路徑與檔名不進這裡。
   - 簽署那一列(③)只在登入讀到 NOT_SIGNED 才出現(Wei 11-17);已簽的人一輩子看不到它。
   - 登入失敗不自動再登(永豐 451 會越試越久):每次都要用戶按。
   用到 capital.js 的 capSec / capRow / capBtn / capActs / capErr / capDo / capFrag / capDate、trade.js 的 $ / t / trEl / CXF / TR_BAGS /
   cxModalClose / cxVenueField / cxStep / cxIcon / trBurstBump / trTwd、app.js 的 trackFeature / srSay——都在呼叫時才取。 */
const SINOPAC = "sinopac";
const SP_KEY_URL = "https://www.sinotrade.com.tw/newweb/PythonAPIKey/";   // spec §11:建金鑰頁(reference Step 1)
// 永豐簽署中心(取自 Shioaji 官方文件;待 Wei 確認後才算定案,spec §11)。旗標關著時整個框都不出
const SP_SIGN_URL = "https://www.sinotrade.com.tw/newweb/signCenter/signCenterIndex/";
const SP_ID_RE = /^[A-Z][0-9A-D][0-9]{8}$/;   // = shell/sinopac_local.ID_RE = runtime sinopac_local._ID_RE
const SP_STUCK_MS = 25 * 60 * 1000;
const SP_NO_MOVE_MS = 90000;
const SP_SIM_OPEN = 8, SP_SIM_CLOSE = 20, SP_SIM_CLOSE_CLOUD = 18;   // = runtime sinopac_connect.SIM_OPEN / SIM_CLOSE_LOCAL / SIM_CLOSE_CLOUD(台北時間,週一到五)
// runtime sinopac_connect.LOGIN_STATES 的值(probe.state)→ 登入那一列的態(spec §3、§4)
const SP_PROBE_VIEW = { key: "r-key", no_futures: "r-nofut", cert: "r-cert", too_many: "r-451", timeout: "r-net", clock: "r-clock",
  version: "r-setup-fail", unknown: "r-unknown", not_open: "r-unknown", no_credentials: "r-unknown" };
// 下單程式登入停了(login_stop.reason = lib/sinopac_worker._login_reason;TOO_MANY／TIMEOUT 只重試、不停)→ 同一組畫面
const SP_STOP_VIEW = { KEY: "r-key", NO_FUTURES: "r-nofut", CERT: "r-cert", CLOCK: "r-clock", VERSION: "r-setup-fail", NOT_SIGNED: "s-notyet", UNKNOWN: "r-unknown" };
const SP_ERR_KEY = { "r-key": "sp.err.key", "r-nofut": "sp.err.noFut", "r-cert": "sp.err.cert", "r-451": "sp.err.full", "r-net": "sp.err.net",
  "r-clock": "sp.err.clock", "r-unknown": "sp.err.unknown" };
// 表單送出後主行程／機器回的錯:憑證檔那一格、身分證那一格、第五格、或整框
const SP_PFX_FILE = ["PFX_INVALID", "PFX_TOO_LARGE", "READ_FAILED"];
// 還沒選檔／機器上沒有那張:不是選錯,憑證卡換回〔選憑證檔〕＋提示句,不出錯誤句(設計稽核 S5)
const SP_PFX_NONE = ["NO_PFX", "NO_CERT"];
const SP_FRAME_ERR = { NO_SEAL: "sp.err.noSeal", REBOUND: "sp.err.rebound", NO_SECRETS: "sp.err.rebound", SECRETS_STALE: "sp.err.rebound", NO_CREDS: "sp.err.rebound", DAEMON_DOWN: "side.stopped", TIMEOUT: "side.stopped", BUSY: "cap.err.busy" };
// 存著的那組對不上:回表單整份重填,出口是腳的〔連接帳戶〕(設計稽核 M2)
const SP_REFILL = ["REBOUND", "NO_SECRETS", "SECRETS_STALE", "NO_CREDS"];
// 每開一次框每個名字最多一次;失敗不埋、不帶內容(spec §12;按〔到永豐建金鑰〕沿用 cx_key_page)
const SP_FEATURE = { form: "sinf_form_saved", sign: "sinf_sign_open", sim: "sinf_sim_sent", signed: "sinf_signed", ready: "sinf_ready", relogin: "sinf_relogin" };

/* phase:"form"(表單)/"flow"(清單)。fix:從登入失敗回表單時只清哪一類("key" | "cert" | null)。
   capw:第五格「憑證密碼」展開了沒有。relogin:從〔重新登入〕進來(主鈕是〔確認登入〕) */
const spBlank = () => ({ phase: "form", fix: null, apiKey: "", secret: "", id: "", caPw: "", capw: false, idBad: false, picked: false,
  busy: false, msg: null, sent: null, info: null, seen: {}, sig: null, started: false, relogin: false, reloginAt: null,
  setupSent: false, probeSent: false, startSent: false, simClosed: false, openedAt: 0, awaitCert: null, view: null, timer: null });
let SP = spBlank();

/* ── 純邏輯(tests/check_shell_sinopac_view.js 從原文切出來跑;這一段不准碰 DOM)── */
const spSec = (sc, k) => (sc && sc[k] && typeof sc[k] === "object" ? sc[k] : {});
const SP_BUSY_STEP = { "sinopac_local:setup": "setup", "sinopac_local:probe": "probe", "sinopac_local:sim_test": "sim_test", "sinopac_local:start": "start" };
function spRunning(sc, sent, now) {
  const fresh = (sec) => typeof sec.at !== "number" || now - sec.at * 1000 < SP_STUCK_MS;
  const s = (k, v) => spSec(sc, k).status === v && fresh(spSec(sc, k));
  if (s("worker", "running")) return "start";
  if (s("sim", "running")) return "sim_test";
  if (s("probe", "running")) return "probe";
  if (s("setup", "running")) return "setup";
  const upd = sc && typeof sc.updated_at === "number" ? now - sc.updated_at * 1000 < SP_STUCK_MS : true;
  if (sc && typeof sc.busy === "string" && SP_BUSY_STEP[sc.busy] && upd) return SP_BUSY_STEP[sc.busy];
  return sent ? sent.step : null;
}
// 台北時間的星期(0 = 週日)與時分;用本機時鐘換算(機器端送單前用校過的鐘再判一次,畫面只決定鈕能不能按)
function spTpe(ms) { const d = new Date(ms + 8 * 3600000); return { wd: d.getUTCDay(), h: d.getUTCHours(), m: d.getUTCMinutes() }; }
// close:這台電腦 20 點、雲端 18 點(runtime SIM_CLOSE_LOCAL／SIM_CLOSE_CLOUD)
function spSimOpen(ms, close) { const x = spTpe(ms); return x.wd >= 1 && x.wd <= 5 && x.h >= SP_SIM_OPEN && x.h < (close || SP_SIM_CLOSE); }
// 下一個開窗時刻(ms):今天是平日而且還沒到 08:00 → 今天 08:00;否則往後找下一個平日的 08:00
function spSimNext(ms) {
  const x = spTpe(ms), day0 = ms + 8 * 3600000 - ((x.h * 60 + x.m) * 60000) - (new Date(ms).getUTCSeconds() * 1000) - (ms % 1000);
  for (let k = 0; k < 8; k++) {
    const at = day0 + k * 86400000 + SP_SIM_OPEN * 3600000, wd = (x.wd + k) % 7;
    if (wd >= 1 && wd <= 5 && at > ms + 8 * 3600000) return at - 8 * 3600000;
  }
  return null;
}
/* (sinopac_connect, 畫面自己的狀態, { now }) → 態的名字(spec §3 的代號)。順序有意義:在跑的最先(鈕全鎖),
   再來是要用戶做事的,最後才是往下一步(spAdvance 接手的 r-ready／w-ready) */
function spcView(sc, ui, ctx) {
  if (ui.phase === "form") return "f";
  const setup = spSec(sc, "setup"), probe = spSec(sc, "probe"), sim = spSec(sc, "sim"), worker = spSec(sc, "worker");
  const run = spRunning(sc, ui.sent, ctx.now);
  if (run === "start") return "w-run";
  if (run === "sim_test") return sim.status === "review" ? "s-review" : "s-run";
  if (run === "probe") return "r-login";
  if (run === "setup") return "r-setup";
  if (sim.status === "review") return "s-review";
  if (setup.status === "failed") return "r-setup-fail";
  if (setup.status !== "ok") return "r-setup";
  // 下單程式自己登入失敗停下來了(STOP 檔):同一組畫面,比它新的確認登入過了就往下走
  const ls = sc && sc.login_stop && typeof sc.login_stop === "object" ? sc.login_stop : null;
  if (ls && !(probe.status === "ok" && (probe.at || 0) > (ls.at || 0))) {
    if (ls.reason === "VERSION" && setup.status === "ok" && (setup.at || 0) > (ls.at || 0)) return "r-ready";   // 重裝好了:照第一次的順序接著登入
    const v = SP_STOP_VIEW[String(ls.reason || "")] || "r-unknown";
    return v === "r-clock" && ctx.cloud ? "r-unknown" : v;   // 雲端不出「這台電腦的時間不準」
  }
  if (worker.status === "ok") return "done";
  if (worker.status === "failed") return "w-fail";
  if (probe.status === "failed") {
    if (probe.state !== "not_signed") { const v = SP_PROBE_VIEW[String(probe.state || "")] || "r-unknown"; return v === "r-clock" && ctx.cloud ? "r-unknown" : v; }
    if (sim.status === "failed") return sim.state === "not_yet" ? "s-notyet" : sim.state === "tw_ip" ? "s-twip" : "s-rej";
    const nxo = sim.next_open_at, shut = typeof nxo === "number" && nxo * 1000 > ctx.now;   // 機器說的下一次開窗還沒到
    return ui.simClosed || shut || !spSimOpen(ctx.now, ctx.cloud ? SP_SIM_CLOSE_CLOUD : SP_SIM_CLOSE) ? "s-closed" : "s-ask";
  }
  if (probe.status === "ok") return "w-ready";
  return "r-ready";
}
// 第 ③ 列畫不畫:登入讀到過「還沒簽」(sim 段不再是 idle),或現在就在簽署那幾態
const spSimRow = (sc, view) => view.indexOf("s-") === 0 || ["ask", "running", "review", "passed", "failed"].indexOf(spSec(sc, "sim").status) >= 0;
/* 表單的錯畫在哪:pfx = 憑證卡下、id = 身分證欄下、capw = 第五格下、key = 金鑰欄下、frame = 浮動 slot */
function spMsgPlace(m, capw) {
  if (!m) return null;
  if (SP_FRAME_ERR[m.code]) return "frame";
  if (SP_PFX_FILE.indexOf(m.code) >= 0 || m.code === "PFX_EXPIRED") return "pfx";
  if (SP_PFX_NONE.indexOf(m.code) >= 0) return null;
  if (m.code === "BAD_KEY") return "key";
  if (m.code === "PFX_PASSWORD") return capw ? "capw" : "id";
  if (m.code === "BAD_ID") return "id";
  return "frame";
}
// 表單主鈕能不能按:這一輪要填的格都填了、身分證格式對(fix 模式只看那一類)
function spFormReady(ui, info) {
  // 〔改金鑰〕沿用機器上存著的那張(bind 不帶 src),不必重選
  const keys = !!ui.apiKey.trim() && !!ui.secret.trim(), id = SP_ID_RE.test(ui.id.trim().toUpperCase()), pfx = !!(info && info.picked) || ui.picked || (ui.fix === "key" && !!(info && info.saved));
  const capw = !ui.capw || !!ui.caPw;
  if (ui.fix === "key") return keys && pfx;
  if (ui.fix === "cert") return pfx && capw;
  return keys && id && pfx && capw;
}
// 下一次開窗(ms):機器用校過的鐘算的 sim.next_open_at 優先(SIM_CLOSED、tw_ip 都會寫),沒有才用本機鐘
function spNextOpen(sc, ms) { const n = spSec(sc, "sim").next_open_at; return typeof n === "number" && isFinite(n) && n * 1000 > ms ? n * 1000 : spSimNext(ms); }
// 台北 HH:MM(spec §5 {time})
function spHm(sec) { if (typeof sec !== "number" || !isFinite(sec)) return null; const x = spTpe(sec * 1000); return String(x.h).padStart(2, "0") + ":" + String(x.m).padStart(2, "0"); }
/* ── 純邏輯到此 ── */

/* 兩個視角(spec §1.2):這台電腦看本機 daemon 的回報、指令走 sinopac_local;雲端看主機的回報、指令走雲端那組(cloud_sinopac.js)。
   差在標題列、第 1 步的 IP、存放句、模擬測試時段(08:00–18:00、沒有 s-twip)、完成頁沒有 n1 */
const spCloud = () => CXF.env === "cloud";
const spBag = () => TR_BAGS[spCloud() ? "cloud" : "local"];
const spReport = () => (spBag().st && spBag().st.report) || null;
const spSC = () => { const r = spReport(); const c = r && r.sinopac_connect; return c && typeof c === "object" ? c : null; };
const spDown = () => (spCloud() ? envCloudKind(TR_BAGS.cloud.st) !== "running" : !(TR_BAGS.local.st && TR_BAGS.local.st.running));
function spTrack(k) { if (SP_FEATURE[k] && !SP.seen[k]) { SP.seen[k] = true; trackFeature(SP_FEATURE[k]); } }
function spBurst() { ENV.burst = trBurstBump(ENV.burst, Date.now(), TR_BURST_MS, TR_BURST_MAX_MS); trPollSoon(1500); }
function spForget() {
  if (SP.timer) clearTimeout(SP.timer);
  SP = spBlank();
  // 主行程丟掉這次選的檔(旗標關時那支 IPC 不在,不叫)
  if (SINOPAC_LOCAL_ON) { try { window.blave.sinopacClose().catch(() => {}); } catch (_) { } }
}
/* 開框時決定從哪裡開始:主行程存了那一組、這台電腦有開通紀錄 → 直接回清單(〔繼續〕〔重新登入〕);否則表單 */
async function spResume() {
  // 雲端:這台電腦不存任何一格(都封進主機),表單一律從頭填;清單照主機的回報接回
  let info = null; if (spCloud()) info = { saved: false, picked: false, caSeparate: false }; else { try { info = await window.blave.sinopacInfo(); } catch (_) { } }
  SP.info = info;
  const sc = spSC();
  if (((info && info.saved) || spCloud()) && sc && spSec(sc, "cert").status === "ok") {
    SP.phase = "flow";
    if (sc.login_stop && typeof sc.login_stop === "object") { SP.relogin = true; SP.reloginAt = sc.login_stop.at || 0; }
  }
  if (info && info.caSeparate) SP.capw = true;
  spPaint();
}
async function spPick() {
  if (SP.busy) return;
  let r = null; try { r = await (spCloud() ? window.blave.sinopacCloudPick() : window.blave.sinopacPick()); } catch (_) { }
  if (r && r.code === "OK") { SP.picked = true; if (SP.msg && spMsgPlace(SP.msg, SP.capw) === "pfx") SP.msg = null; }
  else if (r && r.code !== "CANCELED") SP.msg = { code: r.code || "PFX_INVALID" };
  SP.sig = null; spPaint();
}
// 表單送出:本機打開憑證(不登入永豐)→ 過了就進清單;錯掛在欄位下,框不關
async function spcGo() {
  if (SP.busy || spDown() || !spFormReady(SP, SP.info)) return;
  SP.busy = true; SP.msg = null; spPaint();
  const a = SP.fix === "cert" ? { apiKey: null, secret: null, personId: null } : { apiKey: SP.apiKey.trim(), secret: SP.secret.trim(), personId: SP.fix === "key" ? null : SP.id.trim().toUpperCase() };
  // 一格(Wei 11-17):沒展開第五格 = 憑證密碼就是身分證字號(""),改金鑰時沿用存著的那個
  a.caPassword = SP.capw ? SP.caPw : SP.fix ? null : "";
  let r = null;
  try {
    // 雲端每一包都要整組(主機那一端不沿用):改金鑰時身分證、憑證密碼要重填,檔案在同一個框裡留著
    if (spCloud()) r = await window.blave.sinopacCloudUpload({ apiKey: SP.apiKey, secret: SP.secret, personId: SP.id, caPassword: SP.capw ? SP.caPw : "" });
    else r = await window.blave.sinopacBind(a);
  } catch (_) { }
  // 雲端:sinopac_pfx 是主機的長步驟,收下了(OK／SENT)也還不知道憑證打不打得開——表單留著、主鈕轉圈,等回報的 cert(spAdvance)
  if (spCloud() && r && (r.code === "OK" || r.code === "SENT")) { SP.awaitCert = { at: Date.now() / 1000 - 5 }; spBurst(); SP.sig = null; spPaint(); return; }
  SP.busy = false;
  if ($("cx-scrim").hidden) return;
  if (r && r.code === "OK") {
    spTrack("form");
    SP.apiKey = ""; SP.secret = ""; SP.caPw = ""; SP.id = ""; SP.fix = null; SP.phase = "flow"; SP.relogin = false;
    SP.setupSent = false; SP.probeSent = false; SP.startSent = false;
    if (!spCloud()) { try { SP.info = await window.blave.sinopacInfo(); } catch (_) { } }
    spBurst();
  } else {
    SP.msg = { code: (r && r.code) || "FAILED", notAfter: r && r.notAfter };
    if (SP.msg.code === "NO_CERT") { SP.msg.code = "NO_PFX"; SP.info = Object.assign({}, SP.info, { saved: false }); }   // 機器上沒有那張:要選檔
    if (SP.msg.code === "PFX_PASSWORD" && SP.capw) SP.caPw = "";
    if (SP.msg.code === "BAD_ID") SP.idBad = true;
  }
  SP.sig = null; spPaint();
  const f = SP.msg && { pfx: "sp-pfx-other", id: "sp-id", capw: "sp-capw" }[spMsgPlace(SP.msg, SP.capw)];
  if (f && $(f)) $(f).focus();
}
async function spStep(name) {
  if (SP.busy || spDown()) return;
  const sc = spSC();
  SP.busy = true; SP.msg = null; spPaint();
  let r = null; try { r = await (spCloud() ? window.blave.sinopacCloudStep(name) : window.blave.sinopacStep(name)); } catch (_) { }
  SP.busy = false;
  const code = r && r.code;
  if (code === "OK" || code === "SENT") { SP.sent = { step: name, at: Date.now(), upd: sc ? sc.updated_at : null }; if (name === "sim_test") spTrack("sim"); }
  else if (code === "SIM_CLOSED") SP.simClosed = true;   // 機器用校過的鐘判的:畫面改講 s-closed
  else if (SP_REFILL.indexOf(code) >= 0) { SP.phase = "form"; SP.fix = null; SP.picked = false; SP.msg = { code }; }
  else SP.msg = { code: code || "FAILED", step: name };
  spBurst(); spPaint();
}
// 〔改金鑰〕〔換憑證〕:回表單,只清那一類;其餘留著(spec §3 表單上的修正鈕)
function spFix(kind) { SP.phase = "form"; SP.fix = spCloud() ? null : kind; SP.msg = null; if (kind === "key") { SP.apiKey = ""; SP.secret = ""; } else { SP.picked = false; } SP.sig = null; spPaint(); }
function spOpenSign() { if (!SP_SIGN_URL) return; spTrack("sign"); window.blave.openExternal(SP_SIGN_URL); }

/* 看回報推進(照 presAdvance;每開一次框各一次):① 元件沒裝也沒在裝 → setup ② 裝好、沒登入過、沒停住 → probe
   ③ 登入過而且已簽(或審核通過)→ start。登入失敗後不自動再登 */
function spAdvance(view, sc) {
  if (SP.awaitCert) {   // 雲端的憑證那一步:回報說好了才進清單;打不開等錯誤回到表單、掛在那一格(cert.error／not_after)
    const cert = spSec(sc, "cert"), fresh = (cert.at || 0) >= SP.awaitCert.at;
    if (fresh && cert.status === "ok") {
      SP.awaitCert = null; SP.busy = false; spTrack("form");
      SP.apiKey = ""; SP.secret = ""; SP.caPw = ""; SP.id = ""; SP.fix = null; SP.phase = "flow"; SP.relogin = false;
      SP.setupSent = false; SP.probeSent = false; SP.startSent = false; SP.sig = null;
    } else if (fresh && cert.status === "failed") {
      SP.awaitCert = null; SP.busy = false; SP.msg = { code: String(cert.error || "PFX_INVALID"), notAfter: cert.not_after || null }; SP.sig = null;
      if (SP.msg.code === "PFX_PASSWORD" && SP.capw) SP.caPw = "";
    }
    return;
  }
  if (SP.sent && sc && sc.updated_at !== SP.sent.upd) SP.sent = null;
  const probe = spSec(sc, "probe"), worker = spSec(sc, "worker");
  if (probe.status === "ok" && (probe.at || 0) * 1000 >= (SP.openedAt || 0)) spTrack("signed");
  if (SP.relogin && probe.status === "ok" && (probe.at || 0) > (SP.reloginAt || 0)) spTrack("relogin");
  if (worker.status === "ok" && SP.startSent) spTrack("ready");
  if (SP.busy || SP.sent || spDown() || SP.phase !== "flow" || (sc && sc.busy)) return;
  if (view === "r-setup" && !SP.setupSent && !spRunning(sc, null, Date.now())) { SP.setupSent = true; spStep("setup"); return; }
  if (view === "r-ready" && !SP.probeSent) { SP.probeSent = true; spStep("probe"); return; }
  if (view === "w-ready" && !SP.startSent) { SP.startSent = true; spStep("start"); }
}

// ── DOM ────────────────────────────────────────────────────────────────────
const spP = (cls, text) => trEl("p", cls, text);
function spInput(id, label, key, o) {
  const opts = o || {}, l = trEl("label", "fld"); l.appendChild(trEl("span", "fld-l", label));
  const i = trEl("input", "f-input txt" + (opts.plain ? " cap-idf" : "") + (opts.err ? " is-err" : "")); i.id = id; i.type = opts.plain ? "text" : "password";
  i.autocomplete = opts.plain ? "off" : "new-password"; i.spellcheck = false; i.setAttribute("autocapitalize", opts.plain ? "characters" : "off");
  i.value = SP[key]; i.readOnly = !!SP.busy;
  i.addEventListener("input", () => {
    if (opts.upper) { const p = i.selectionStart; i.value = i.value.toUpperCase(); try { i.setSelectionRange(p, p); } catch (_) { } }
    SP[key] = i.value; if (key === "id") SP.idBad = false; spSyncGo();
  });
  if (opts.blur) i.addEventListener("blur", opts.blur);
  i.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); spPrimary(); } });
  l.appendChild(i);
  const d = [];
  if (opts.err) { const e = trEl("p", "cap-err", opts.err); e.id = id + "-err"; e.setAttribute("role", "status"); d.push(e.id); l.appendChild(e); }
  else if (opts.hint) { const h = trEl("p", "cx-hint", opts.hint); h.id = id + "-hint"; d.push(h.id); l.appendChild(h); }
  if (d.length) i.setAttribute("aria-describedby", d.join(" "));
  if (opts.after) l.appendChild(opts.after);
  return l;
}
// 第 1 步的〔到永豐建金鑰〕:外開(main.js open-external,只收 http/https);描邊帶外連記號(同 cxKeyPageBtn)
function spKeyPageBtn() {
  const w = trEl("div", "cx-chipw cx-kp"), b = trEl("button", "btn-out", t("sp.keyPage"));
  b.type = "button"; b.id = "sp-keypage"; b.appendChild(cxIcon("ext"));
  b.addEventListener("click", () => { trackFeature("cx_key_page"); window.blave.openExternal(SP_KEY_URL); });
  w.appendChild(b); return w;
}
// 憑證檔那一格:還沒選 = 〔選憑證檔〕+ hint;選了 = 卡(檔案記號＋「已選 .pfx 檔」＋〔換一個〕)。檔名不出(可能帶身分證)
function spPfxField(place) {
  const w = trEl("div", "fld"); w.appendChild(trEl("span", "fld-l", t("sp.pfx")));
  const picked = SP.picked || !!(SP.info && SP.fix !== "cert" && (SP.info.picked || (SP.fix === "key" && SP.info.saved)));
  if (!picked) {
    const b = capBtn("btn-out", t("sp.pfxPick"), spPick, "sp-pfx-other", SP.busy);
    w.appendChild(b);
  } else {
    const card = trEl("div", "pres-found"), mk = trEl("span", "cap-mk"); mk.appendChild(trEl("span", "cur")); mk.setAttribute("aria-hidden", "true");
    const tx = trEl("div", "capl-tx"); tx.appendChild(trEl("div", "t", t("sp.pfxPicked")));
    card.append(mk, tx, capBtn("btn-quiet", t("sp.pfxOther"), spPick, "sp-pfx-other", SP.busy)); w.appendChild(card);
  }
  if (place === "pfx") {
    const sc = spSC(), cert = spSec(sc, "cert");
    // 表單的錯同時寫進 sinopac_connect.cert.error／not_after(runtime sinopac_local._bind);日期先看回條,再看狀態
    const text = SP.msg.code === "PFX_EXPIRED" ? t("sp.err.pfxExp", { date: capDate(SP.msg.notAfter || (cert.error === "PFX_EXPIRED" ? cert.not_after : null)) || "—" }) : t("sp.err.pfxFile");
    const e = trEl("p", "cap-err", text); e.setAttribute("role", "status"); w.appendChild(e);
  } else if (!picked) w.appendChild(spP("cx-hint", t("sp.pfxHint")));
  return w;
}
function spFormBody() {
  const f = document.createDocumentFragment(), place = spMsgPlace(SP.msg, SP.capw);
  f.appendChild(cxVenueField(cxBag(), true));
  const s1 = cxStep("1"), b1 = s1.lastChild;
  if (spCloud()) {   // 雲端:權限句拿掉「不設 IP」,下面接主機 IP(同其他家的雲端連接框)
    b1.append(spKeyPageBtn(), trEl("p", "cx-hint is-ink2", cxJoin(t("sp.permCloud"), t("cx.ip.lineCloud"))));
    b1.appendChild(cxIpSlot(true, cxCloudIp()));
  } else b1.append(spKeyPageBtn(), trEl("p", "cx-hint is-ink2", t("sp.perm")));
  f.appendChild(s1);
  const s2 = cxStep("2"), b2 = s2.lastChild;
  if (SP.fix !== "cert") {   // 金鑰帶空白(BAD_KEY):沿用加密幣那條的格式句,掛在 Secret Key 下
    b2.appendChild(spInput("sp-api", t("cx.apiKey"), "apiKey"));
    b2.appendChild(spInput("sp-secret", t("cx.secretKey"), "secret", { err: place === "key" ? t("cx.chk.keyFormatV", { venue: t("sp.venue") }) : null }));
  }
  b2.appendChild(spPfxField(place));
  if (!SP.fix) {
    // 身分證:明碼、mono、自動轉大寫;離開欄位才判格式(f-id-bad);打不開憑證時下面接〔我的憑證密碼不是身分證字號〕
    const bad = SP.idBad || (place === "id" && SP.msg.code === "BAD_ID");
    const open = place === "id" && SP.msg.code === "PFX_PASSWORD";
    const other = open && !SP.capw ? capBtn("btn-quiet", t("sp.pwOther"), () => { SP.capw = true; SP.msg = null; SP.sig = null; spPaint(); if ($("sp-capw")) $("sp-capw").focus(); }, "sp-pw-other") : null;
    b2.appendChild(spInput("sp-id", t("sp.id"), "id", { plain: true, upper: true, err: bad ? t("sp.err.idFmt") : open ? t("sp.err.pfxOpen") : null,
      hint: SP.capw ? null : t("sp.idHint"), after: other,
      blur: () => { const v = SP.id.trim(); const was = SP.idBad; SP.idBad = !!v && !SP_ID_RE.test(v.toUpperCase()); if (was !== SP.idBad) { SP.sig = null; spPaint(); } } }));
  }
  // 〔換憑證〕〔改金鑰〕回來時身分證那格不在:打不開的那句與文字鈕接在憑證卡下
  if (SP.fix && place === "id" && SP.msg.code === "PFX_PASSWORD" && !SP.capw) {
    b2.appendChild(capErr(t("sp.err.pfxOpen")));
    b2.appendChild(capActs(capBtn("btn-quiet", t("sp.pwOther"), () => { SP.capw = true; SP.msg = null; SP.sig = null; spPaint(); if ($("sp-capw")) $("sp-capw").focus(); }, "sp-pw-other")));
  }
  if (SP.capw) b2.appendChild(spInput("sp-capw", t("sp.caPw"), "caPw", { err: place === "capw" ? t("sp.err.caPw") : null, hint: t("sp.caPwHint") }));
  // 存放句:整句是提示泡的觸發點(同 cx-keyat);說明照實寫「不放在 agent 的設定檔」(Wei 11-17 深夜)
  const kp = trEl("p", "cx-hint cx-keyat"), tw = trEl("span", "cx-tipw"), tg = trEl("span", "mp-tip", t(spCloud() ? "sp.storeCloud" : "sp.store")), tip = trEl("span", "tip", t(spCloud() ? "sp.storeTipCloud" : "sp.storeTip"));
  tg.tabIndex = 0; tg.id = "sp-keyat"; tip.id = "sp-store"; tip.setAttribute("role", "tooltip"); tg.setAttribute("aria-describedby", tip.id);
  tw.append(tg, tip); kp.appendChild(tw); b2.appendChild(kp);
  f.appendChild(s2);
  return f;
}
const spOff = (sc) => SP.busy || spDown() || !!(sc && sc.busy);
const spRetry = (step, id, off) => capBtn("btn-out", t("pres.retry"), () => spStep(step), id || "sp-retry", off);
/* 登入那一列的失敗(spec r-*;從〔重新登入〕進來時主鈕是填色的〔確認登入〕):講哪一類、給那一類的出口 */
function spLoginBody(view, sc) {
  const off = spOff(sc), probe = spSec(sc, "probe");
  if (view === "r-451") {
    const at = typeof probe.retry_at === "number" ? probe.retry_at : null, wait = !!at && Date.now() < at * 1000;
    return capFrag(spWhy(capErr(t("sp.err.full", { time: spHm(at) || "—" }), true)), spP("cx-hint", t("sp.err.fullHint")),
      capActs(spDesc(capBtn(SP.relogin ? "btn-fill" : "btn-out", t(SP.relogin ? "sp.confirm" : "pres.retry"), () => spStep("probe"), "sp-retry", off || wait), wait)));
  }
  const calm = view === "r-net";
  const main = SP.relogin ? capBtn("btn-fill", t("sp.confirm"), () => spStep("probe"), "sp-confirm", off) : null;
  const fixKey = capBtn(SP.relogin || view === "r-unknown" ? "btn-quiet" : "btn-out", t("sp.fixKey"), () => spFix("key"), "sp-fix-key", SP.busy);
  const fixCert = capBtn(SP.relogin ? "btn-quiet" : "btn-out", t("sp.fixCert"), () => spFix("cert"), "sp-fix-cert", SP.busy);
  const acts = view === "r-key" || view === "r-nofut" ? [main, fixKey]
    : view === "r-cert" ? [main, fixCert]
    : view === "r-unknown" ? [main || spRetry("probe", null, off), fixKey]
    : [main || spRetry("probe", null, off)];
  const hint = view === "r-clock" ? spP("cx-hint", t("sp.err.clockHint")) : null;
  const notSent = SP.msg && SP.msg.step === "probe" && !SP_FRAME_ERR[SP.msg.code] ? capErr(t("pres.err.generic")) : null;
  return capFrag(capErr(t(SP_ERR_KEY[view] || "sp.err.unknown"), calm), hint, notSent, capActs(...acts));
}
// 簽署那一列(③):s-ask／s-closed／s-notyet／s-rej／s-twip
function spSimBody(view, sc) {
  const off = spOff(sc), sign = SP_SIGN_URL ? capBtn("btn-out", t("sp.signPage"), spOpenSign, "sp-sign") : null;
  if (sign) sign.appendChild(cxIcon("ext"));
  const notSent = SP.msg && SP.msg.step === "sim_test" && !SP_FRAME_ERR[SP.msg.code] ? capErr(t("pres.err.generic")) : null;
  if (view === "s-ask" || view === "s-closed") {
    const closed = view === "s-closed", nx = closed ? spNextOpen(sc, Date.now()) : null;
    const go = spDesc(capBtn("btn-fill", t("sp.sim.go"), () => spStep("sim_test"), "sp-sim-go", off || closed), closed);
    return capFrag(capDo(t("sp.sim.do")), closed ? spWhy(spP("cx-hint", t(spCloud() ? "sp.sim.closedCloud" : "sp.sim.closed", { when: spWhen(nx) }))) : spP("cx-hint", t("sp.sim.hint")), notSent, capActs(go, sign));
  }
  if (view === "s-notyet") return capFrag(capErr(t("sp.sim.notYet"), true), spP("cx-hint", t("sp.sim.notYetHint")), notSent,
    capActs(SP.relogin ? capBtn("btn-fill", t("sp.confirm"), () => spStep("probe"), "sp-confirm", off) : spRetry("probe", null, off), sign));
  // 18:00 後被擋(sim.state tw_ip):〔再送一次〕停用到機器說的下一次開窗(next_open_at)
  if (view === "s-twip") { const nxo = spSec(sc, "sim").next_open_at, wait = typeof nxo !== "number" || nxo * 1000 > Date.now();
    return capFrag(spWhy(capErr(t("sp.sim.twIp"), true)), notSent, capActs(spDesc(capBtn("btn-out", t("sp.sim.again"), () => spStep("sim_test"), "sp-sim-again", off || wait), wait))); }
  return capFrag(capErr(t("sp.sim.rej")), notSent, capActs(capBtn("btn-out", t("sp.sim.again"), () => spStep("sim_test"), "sp-sim-again", off)));
}
// 停用的鈕指到原因那一句(copy.md 文案密度 #5;設計稽核 S3)
const spWhy = (el) => { el.id = "sp-why"; return el; };
const spDesc = (b, on) => { if (on) b.setAttribute("aria-describedby", "sp-why"); return b; };
// {when}:zh「MM/DD(週)HH:MM」、en「Tue MM/DD HH:MM」,台北時間
function spWhen(ms) {
  if (typeof ms !== "number") return "—";
  const d = new Date(ms + 8 * 3600000), p = (n) => String(n).padStart(2, "0"), md = p(d.getUTCMonth() + 1) + "/" + p(d.getUTCDate()), hm = p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
  const wd = new Intl.DateTimeFormat(LANG === "zh" ? "zh-TW" : "en-US", { weekday: "short", timeZone: "Asia/Taipei" }).format(new Date(ms));
  return LANG === "zh" ? md + "（" + wd + "）" + hm : wd + " " + md + " " + hm;
}
/* 態 → 清單四列(mockup presRows 同形):① 安裝永豐元件 ② 登入永豐 ③ 模擬測試(只在讀到還沒簽之後)④ 連上永豐 */
function spRows(view, sc) {
  const setup = spSec(sc, "setup"), probe = spSec(sc, "probe"), sim = spSec(sc, "sim"), worker = spSec(sc, "worker"), off = spOff(sc);
  const nm = SP.sent && Date.now() - SP.sent.at >= SP_NO_MOVE_MS ? capFrag(capDo(t("pres.noMove")), capActs(capBtn("btn-out", t("pres.retry"), () => { const s = SP.sent.step; SP.sent = null; spStep(s); }, "sp-nomove"))) : null;
  const runRow = (name, right) => (nm ? capRow("cur", name, "", nm) : capRow("run", name, right));
  const ol = trEl("ol", "cap-steps"), add = (li) => ol.appendChild(li);
  // ①
  if (view === "r-setup") add(SP.msg && SP.msg.step === "setup" && !SP_FRAME_ERR[SP.msg.code] ? capRow("bad", t("sp.s.setup"), "", capFrag(capErr(t("pres.err.generic")), capActs(spRetry("setup", null, off)))) : runRow(t("sp.s.setup"), t("sp.s.setupRun")));
  else if (view === "r-setup-fail") add(capRow("bad", t("sp.s.setup"), "", capFrag(capErr(t(sc && sc.login_stop && sc.login_stop.reason === "VERSION" ? "sp.err.version" : "sp.s.setupFail")), capActs(spRetry("setup", null, SP.busy)))));
  else add(capRow(setup.status === "ok" ? "done" : "todo", t("sp.s.setup")));
  // ②
  const loginErr = view.indexOf("r-") === 0 && ["r-setup", "r-setup-fail", "r-login", "r-ready"].indexOf(view) < 0;
  const loginDone = probe.status === "ok" || (probe.status === "failed" && probe.state === "not_signed") || ["w-run", "w-fail", "done", "w-ready"].indexOf(view) >= 0 || view.indexOf("s-") === 0;
  if (view === "r-login" || view === "r-ready") add(SP.msg && SP.msg.step === "probe" && !SP_FRAME_ERR[SP.msg.code] && view === "r-ready" ? capRow("bad", t("sp.s.login"), "", capFrag(capErr(t("pres.err.generic")), capActs(spRetry("probe", null, off)))) : runRow(t("sp.s.login"), t("sp.s.loginRun")));
  else if (loginErr) add(capRow(view === "r-net" || view === "r-451" ? "cur" : "bad", t("sp.s.login"), "", spLoginBody(view, sc)));
  else add(capRow(loginDone ? "done" : "todo", t("sp.s.login"), loginDone ? t("sp.s.loginDone") : ""));
  // ③ 已簽的人看不到(不畫成「已略過」)
  if (spSimRow(sc, view)) {
    if (view === "s-run") add(runRow(t("sp.s.sim"), t("sp.s.simRun")));
    else if (view === "s-review") { const li = runRow(t("sp.s.sim"), t("sp.s.simWait")); if (!nm) { const w = trEl("div", "cap-x"); w.appendChild(spP("cx-hint", t("sp.sim.wait"))); li.appendChild(w); } add(li); }
    else if (view.indexOf("s-") === 0) add(capRow(view === "s-rej" ? "bad" : "cur", t("sp.s.sim"), "", spSimBody(view, sc)));
    else { const ok = sim.status === "passed" || probe.status === "ok"; add(capRow(ok ? "done" : "todo", t("sp.s.sim"), ok ? t("sp.s.simDone") : "")); }
  }
  // ④
  if (view === "w-run" || view === "w-ready") add(SP.msg && SP.msg.step === "start" && !SP_FRAME_ERR[SP.msg.code] ? capRow("bad", t("sp.s.worker"), "", capFrag(capErr(t("pres.err.generic")), capActs(spRetry("start", null, off)))) : runRow(t("sp.s.worker"), t("sp.s.workerRun")));
  else if (view === "w-fail") add(capRow("bad", t("sp.s.worker"), "", capFrag(capErr(t("sp.s.workerFail")), capActs(capBtn("btn-out", t("pres.retry"), () => { SP.startSent = true; spStep("start"); }, "sp-retry", off)))));
  else add(capRow(worker.status === "ok" && !(sc && sc.login_stop) ? "done" : "todo", t("sp.s.worker")));
  return ol;
}
function spDoneBody(sc) {
  const r = spReport() || {}, a = (r.account && r.account.venues && r.account.venues[SINOPAC]) || {}, cert = spSec(sc, "cert");
  const f = document.createDocumentFragment();
  const lede = trEl("p", "cap-lead pres-ok"); lede.append(trEl("i", "dot"), trEl("span", "", t("sp.done.lead"))); f.appendChild(lede);
  const big = trEl("div", "pres-big"); big.append(trEl("div", "l", t("pres.done.equity")), trEl("div", "v mono", typeof a.equity === "number" ? trTwd(a.equity) + " " + TR_TXF_CCY : "—"));
  f.appendChild(big);
  const dl = trEl("dl", "cap-acct"), kv = (k, v, cls) => { const d = trEl("div", ""); d.append(trEl("dt", "", k), trEl("dd", cls || "", v)); dl.appendChild(d); };
  const masked = typeof a.account_masked === "string" && a.account_masked ? a.account_masked : spSec(sc, "probe").account_masked;   // ****1234,只露尾碼
  if (typeof masked === "string" && masked) kv(t("pres.done.acct"), masked, "mono");
  kv(t("pres.done.can"), t("pres.done.canV"));
  const exp = capDate(cert.not_after), n = typeof cert.not_after === "string" ? Math.floor((Date.parse(cert.not_after) - Date.now()) / 86400000) : null;
  if (exp) kv(t("pres.done.exp"), n !== null && isFinite(n) ? t("pres.done.expV", { date: exp, n }) : exp, "mono");
  f.appendChild(dl);
  if (!spCloud()) { const note = trEl("div", "cx-note"); note.appendChild(spP("", t("sp.done.n1"))); f.appendChild(note); }   // 雲端沒有「關機就不下單」(done-cloud)
  return f;
}
function spFoot(view) {
  const go = $("cx-go"), cancel = $("cx-cancel"), where = $("cx-where");
  // 雲端的表單:鈕上方講目的地「雲端 · 真錢 · 永豐期貨」(同其他交易所的雲端連接框)
  const dest = spCloud() && view === "f";
  where.hidden = !dest; where.textContent = dest ? t("tr.cloud.footWhere", { where: t("env.cloud"), money: envMoneyText("real"), venue: t("sp.venue") }) : "";
  const label = view === "f" ? (SP.busy ? t("cx.connecting") : t("cx.connect")) : view === "done" ? t("pres.done.ok") : null;
  go.hidden = !label;
  if (label && go.textContent.trim() !== label) {
    go.textContent = "";
    if (view === "f" && SP.busy) { const sp = trEl("span", "spin16"); sp.setAttribute("aria-hidden", "true"); go.append(sp, " "); }
    go.append(label);
  }
  cancel.hidden = view === "done";
  cancel.textContent = view === "f" ? t("del.cancel") : t("set.close");
  go.classList.toggle("is-busy", view === "f" && SP.busy);
  spSyncGo(view);
}
// 表單的主鈕在該填的格填滿、身分證格式對之前真 disabled(同 cxKeysBlank)
function spSyncGo(view) {
  const v = view || SP.view, go = $("cx-go");
  const off = spDown() || SP.busy || (v === "f" && !spFormReady(SP, SP.info));
  go.disabled = v === "f" && !SP.busy && !spFormReady(SP, SP.info);
  go.setAttribute("aria-disabled", off ? "true" : "false");
}
function spPrimary() {
  if ($("cx-go").getAttribute("aria-disabled") === "true") return;
  if (SP.view === "f") return spcGo();
  if (SP.view === "done") { cxModalClose(true); if (!(TR.open && TR.view === "tr")) trOpen(); }
}

function spPaint() {
  if ($("cx-scrim").hidden || CXF.venue !== SINOPAC) return;
  if (!SP.openedAt) SP.openedAt = Date.now();
  const sc = spSC(), ctx = { now: Date.now(), cloud: spCloud() };
  let view = spcView(sc, SP, ctx);
  spAdvance(view, sc);
  view = spcView(sc, SP, ctx);
  SP.view = view;
  const box = $("cx-body");
  $("cx-title").textContent = t("sp.title");
  $("cx-modal").querySelector(".modal-head").classList.toggle("cloud", spCloud());
  $("cx-env").hidden = false; $("cx-env").textContent = t(spCloud() ? "env.cloud" : "env.local");
  spFoot(view);
  box.setAttribute("aria-busy", SP.busy || ["r-setup", "r-login", "r-ready", "s-run", "s-review", "w-run", "w-ready"].indexOf(view) >= 0 ? "true" : "false");
  // 451 的〔再試一次〕停用到 {time}、時段外的鈕到開窗:到點重畫一次
  if (SP.timer) { clearTimeout(SP.timer); SP.timer = null; }
  const due = view === "r-451" ? (spSec(sc, "probe").retry_at || 0) * 1000 : view === "s-closed" || view === "s-twip" ? spNextOpen(sc, Date.now()) : null;
  if (due && due > Date.now()) SP.timer = setTimeout(() => { SP.sig = null; SP.simClosed = false; spPaint(); }, Math.min(due - Date.now() + 500, 2 ** 31 - 1));
  const sig = LANG + "|" + JSON.stringify([view, sc, SP.busy, SP.msg, SP.fix, SP.capw, SP.idBad, SP.picked, SP.info, SP.relogin,
    SP.sent && Date.now() - SP.sent.at >= SP_NO_MOVE_MS, spDown(), view === "done" && spReport() && spReport().account]);
  if (SP.sig === sig && box.firstChild) return;
  SP.sig = sig;
  const hadId = box.contains(document.activeElement) ? document.activeElement.id : null;
  box.textContent = "";
  if (view === "f") box.appendChild(spFormBody());
  else if (view === "done") box.appendChild(spDoneBody(sc));
  else box.appendChild(spRows(view, sc));
  const slot = trEl("div", ""); slot.setAttribute("role", "status"); box.appendChild(slot);
  const m = spDown() ? t("side.stopped") : SP.msg && view === "f" && spMsgPlace(SP.msg, SP.capw) === "frame" ? t(SP_FRAME_ERR[SP.msg.code] || "pres.err.generic")
    : SP.msg && view !== "f" && SP_FRAME_ERR[SP.msg.code] ? t(SP_FRAME_ERR[SP.msg.code]) : null;
  if (m) slot.appendChild(capErr(m, !spDown() && SP.msg && SP.msg.code === "BUSY"));
  spSyncGo(view);
  const back = hadId && $(hadId);
  if (back && !back.disabled) back.focus();
}
function spFootRestore() { const go = $("cx-go"); go.classList.remove("is-busy"); }

/* ── 連好之後(trade.js 用;spec §1.3、§6)── */
// 開通中:存了那一組、下單程式還沒起來過(同統一 presWip)。重新連接會把 worker 段清回 idle,所以又是開通中
function spWip(r) { const c = r && r.sinopac_connect; return !!c && typeof c === "object" && spSec(c, "worker").status !== "ok"; }
// 登入停了(STOP 檔;只有確認登入清得掉):新單與平倉都送不出去
function spLoginStopped(r) { const c = r && r.sinopac_connect; return !!c && typeof c === "object" && !spWip(r) && !!c.login_stop && typeof c.login_stop === "object"; }
// 連不上、自動重試中:sinopac_connect.login_retry(portfolio_reporter;STOP 時不帶),退路是帳戶那一筆 waiting = login_retry。回 retry_at(秒)或 null
function spRetryAt(r) {
  if (spLoginStopped(r)) return null;
  const lr = r && r.sinopac_connect && r.sinopac_connect.login_retry;
  if (lr && typeof lr === "object") return typeof lr.retry_at === "number" ? lr.retry_at : 0;
  const a = r && r.account && r.account.venues && r.account.venues[SINOPAC];
  if (!a || a.waiting !== "login_retry") return null;
  return typeof a.retry_at === "number" ? a.retry_at : 0;
}
// 帳戶列下一行的原因句(spec §6.1):同 trade.js 事件列那張表(TR_SP_REASON)
const spReasonText = (r) => t(TR_SP_REASON[String((r && r.sinopac_connect && r.sinopac_connect.login_stop && r.sinopac_connect.login_stop.reason) || "UNKNOWN")] || TR_SP_REASON.UNKNOWN);
