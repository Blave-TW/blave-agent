/* 統一期貨 本機開通(電腦版 Windows;設計 mockup-president-onboarding.html 電腦版分頁 d-* + mockup-desktop-prep-v2.html,Wei 10-07 拍板)。
   連接交易所框(#cx-scrim,trade.js)在「這台電腦」視角選到統一時,整個框交給這個檔畫:找 PSCCA → 帳密(找到憑證直接進;沒有才先開憑證e總管)→ 開通清單 → 完成。
   - 狀態只有一個來源:這台電腦 daemon 回報的 `president_connect`(TR_BAGS.local.st.report);長步驟回條等不到是常態,畫面看狀態走。
   - 一列只有一個狀態:步驟沒送出去(PRES.msg = {code, step})掛在那一列;在跑的優先。浮動 slot 只放整框層級(daemon 沒跑、加密儲存、重綁、忙碌)。
   - 不給營業員話術:只告訴用戶要請營業員開什麼;回報那一列給測試單的時間與委託書號(可複製)。
   - 帳號、交易密碼、憑證密碼只在這個框的欄位裡,送進主行程(president_local.js)後就清掉;憑證檔路徑與檔名(含身分證)不進這裡。
   - 憑證e總管:app 只替用戶「打開」它;簡訊碼在統一自己的視窗輸入,這裡只看 PSCCA 有沒有新檔(每 3 秒)。
   - 測試環境那一段(統一規定:先在測試主機登入、下一筆測試單、回報營業員,才開正式):走跟雲端同一份 runtime 程式
     (president_connect 的 run_host / run_test_order;本機經 president_local op host／test_order)。環境看回報的 `env`,
     測試單看 `test_order` 那一段;新帳號一律先測試主機。
   用到 capital.js 的 capSec / capRow / capBtn / capActs / capErr / capDo / capFrag / capDate / capField 的殼、trade.js 的 $ / t / trEl / CXF /
   TR_BAGS / cxModalClose / cxVenueField / trBurstBump、app.js 的 trackFeature / srSay——都在呼叫時才取。 */
const PRESIDENT = "president";
const PRES_HOTLINE = "(02) 8172-4668";
const PRES_SCAN_MS = 3000;
const PRES_NO_MOVE_MS = 90000;
const PRES_STUCK_MS = 25 * 60 * 1000;
// runtime president_connect.LOGIN_STATES 的值 → 畫面態(文案與雲端同一組 key;只有「主機」換成「這台電腦」)
// 只用來顯示:哪一類都一樣停下來、不自動重試,用戶按「確認登入」才再試一次(Wei 10-07 MVP)
const PRES_PROBE_VIEW = { password: "PASSWORD", unknown: "UNKNOWN", cert_mismatch: "CERT_MISMATCH", cert: "CERT",
  maintenance: "MAINTENANCE", timeout: "TIMEOUT", no_credentials: "NOCREDS" };
// 下單程式自己登入失敗(runtime 寫 worker.error = LOGIN_FAILED:<lib 類別>)→ 同一組畫面
const PRES_STOP_VIEW = { PASSWORD: "PASSWORD", CERT: "CERT", CERT_MISMATCH: "CERT_MISMATCH", TIMEOUT: "TIMEOUT", MAINTENANCE: "MAINTENANCE" };
// 憑證那一列的錯(runtime 的 PFX_* + 主行程 president_local.js 憑證密碼格式不對的 BAD_PW / NO_CA_PW):密碼類畫在欄位下,其餘畫在檔案卡下
const PRES_PFX_ERR = { PFX_PASSWORD: "pres.pfx.errPw", BAD_PW: "pres.pfx.errPw", NO_CA_PW: "pres.pfx.errPw", PFX_EXPIRED: "pres.pfx.errExpired", PFX_NOT_PRESIDENT: "pres.pfx.errIssuer",
  PFX_INVALID: "pres.pfx.errFile", PFX_TOO_LARGE: "pres.pfx.errFile", READ_FAILED: "pres.pfx.errRead", PFX_NONE_FOUND: "pres.pfx.errNone" };
const PRES_FEATURE = { form: "pres_form_saved", tcem: "pres_tcem_open", cert: "pres_cert_ok", probe: "pres_probe_ok", ready: "pres_ready" };

const presBlank = () => ({ phase: "prep", scan: null, waitTcem: false, tcemMsg: null, acct: "", pw: "", caPw: "",
  source: "found", picked: false, busy: false, msg: null, sent: null, recheck: false, recert: false,
  test: { url: "" }, info: null, seen: {}, sig: null, started: false, setupSent: false, startSent: false, view: null });
// 清單上有自己那一列的步驟:這些步驟沒送出去的錯掛在列上(host 記成 probe)
const PRES_ROW_STEPS = ["setup", "cert", "probe", "test_order", "start"];
// 整框層級的錯(不屬於哪一列),浮動 slot 只放這些
const PRES_FRAME_ERR = { BUSY: "cap.err.busy", NO_SEAL: "pres.err.noSeal", DAEMON_DOWN: "side.stopped", TIMEOUT: "side.stopped",
  REBOUND: "pres.err.rebound", NO_CREDS: "pres.err.rebound", BAD_ACCOUNT: "pres.form.acctErr", LIB_OUTDATED: "pres.err.libOutdated" };
let PRES = presBlank();
let presTimer = null;

/* ── 純邏輯(tests/check_shell_president_view.js 從原文切出來跑;這一段不准碰 DOM)── */
const presSec = (pc, k) => (pc && pc[k] && typeof pc[k] === "object" ? pc[k] : {});
const PRES_BUSY_STEP = { "president_local:setup": "setup", "president_local:cert": "cert", "president_local:probe": "probe", "president_local:host": "probe",
  "president_local:test_order": "test_order", "president_local:start": "start" };
function presRunning(pc, sent, now) {
  const fresh = (sec) => typeof sec.at !== "number" || now - sec.at * 1000 < PRES_STUCK_MS;
  const s = (k, v) => presSec(pc, k).status === v && fresh(presSec(pc, k));
  if (s("probe", "running")) return "probe";
  if (s("test_order", "running")) return "test_order";
  if (s("worker", "running")) return "start";
  if (s("cert", "importing")) return "cert";
  if (s("setup", "running")) return "setup";
  const upd = pc && typeof pc.updated_at === "number" ? now - pc.updated_at * 1000 < PRES_STUCK_MS : true;
  if (pc && typeof pc.busy === "string" && PRES_BUSY_STEP[pc.busy] && upd) return PRES_BUSY_STEP[pc.busy];
  return sent ? sent.step : null;
}
/* (president_connect, 畫面自己的狀態, { win, now }) → 態的名字(mockup 的 d-* 家族)。順序有意義:在跑的最先(鈕全鎖),
   再來是要用戶做事的,最後才是往下一步 */
function presView(pc, ui, ctx) {
  if (!ctx.win) return "d-mac";
  // 找到憑證就是帳密頁(沒有「事前準備」那一頁,Wei 10-07);presScan 同時把 phase 推到 form
  if (ui.phase === "prep") return ui.waitTcem ? "d-prep-wait" : !ui.scan ? "d-prep-load" : ui.scan.found > 0 ? "d-form" : "d-prep-none";
  if (ui.phase === "form") return "d-form";
  const setup = presSec(pc, "setup"), cert = presSec(pc, "cert"), probe = presSec(pc, "probe"), worker = presSec(pc, "worker");
  const run = presRunning(pc, ui.sent, ctx.now);
  if (run === "start") return "d-finish";
  const env = pc && pc.env === "live" ? "live" : "test";
  if (run === "probe") return env === "test" ? "d-t-probe" : "d-probe";
  if (run === "test_order") return "d-t-order-run";
  if (run === "cert") return "d-cert-run";
  if (run === "setup") return "d-setup";
  if (setup.status === "failed") return "d-setup-fail";
  if (setup.status !== "ok") return "d-setup";
  if (ui.recheck) return "d-pw";
  if (ui.recert) return cert.status === "failed" && cert.error !== "INTERRUPTED" ? "d-cert-err" : "d-cert";
  const wErr = String(worker.error || "");
  if (worker.status === "ok") return "d-done";
  if (worker.status === "failed" && wErr.indexOf("LOGIN_FAILED") !== 0) return "d-finish-fail";
  if (cert.status === "failed") return "d-cert-err";
  if (cert.status !== "ok") return "d-cert";
  // 下單程式登入失敗停下來了:同一組畫面,不自動重登(之後「確認登入」過了、比這個失敗新 = 往下走)
  if (worker.status === "failed" && !(probe.status === "ok" && (probe.at || 0) > (worker.at || 0))) return "d-" + (PRES_STOP_VIEW[wErr.slice(13)] || "UNKNOWN");
  // 登入結果:同一組畫面,掛在哪一列看 env(測試主機 → 測試段那一列;正式 → 正式那一列)
  if (probe.status === "failed" && typeof probe.state === "string") return "d-" + (PRES_PROBE_VIEW[probe.state] || "UNKNOWN");
  if (env === "live") return probe.status === "ok" && probe.state === "ok" && probe.env === "live" ? "d-finish" : "d-t-report";
  // 測試環境(新帳號一律從這裡開始;統一規定先下測試單)
  const to = presSec(pc, "test_order");
  if (to.status === "ok") return "d-t-report";
  if (to.status === "failed") return "d-t-order-fail";
  if (probe.status === "ok" && probe.state === "ok" && probe.env === "test") return "d-t-order";
  return "d-t-host";
}
// ISO 到期 → 還有幾天(無條件捨去;讀不懂 null)
function presDaysLeft(iso, now) {
  const d = typeof iso === "string" ? Date.parse(iso) : NaN;
  return isNaN(d) ? null : Math.floor((d - now) / 86400000);
}
// 第一次真錢啟動的確認(Wei 10-07 Q7 C):各策略口數 + 帳戶可動用 / 權益。amounts = portfolio_config 的口數
function presFirstRows(amounts) {
  const a = amounts && typeof amounts === "object" ? amounts : {};
  return Object.keys(a).filter((n) => typeof a[n] === "number" && a[n] > 0).sort().map((n) => ({ name: n, lots: Math.round(a[n]) }));
}
/* 主行程回的錯({code, step})畫在哪:frame = 浮動 slot(整框層級)、field = 欄位下(憑證檔)、row = 清單那一列(一列只有一個狀態)、
   slot = 沒有自己那一列的步驟(存帳密)。 */
function presMsgPlace(m) {
  if (!m) return null;
  if (PRES_FRAME_ERR[m.code]) return "frame";
  if (m.step === "cert" && PRES_PFX_ERR[m.code]) return "field";   // 存帳密那一步的 BAD_PW 沒有憑證欄位可掛,照 slot
  return PRES_ROW_STEPS.indexOf(m.step) >= 0 ? "row" : "slot";
}
/* ── 純邏輯到此 ── */

const presPC = () => { const r = TR_BAGS.local.st && TR_BAGS.local.st.report; const c = r && r.president_connect; return c && typeof c === "object" ? c : null; };
const presReport = () => (TR_BAGS.local.st && TR_BAGS.local.st.report) || null;
const presCtx = () => ({ win: window.blave.platform === "win32", now: Date.now() });
const presDown = () => !(TR_BAGS.local.st && TR_BAGS.local.st.running);
function presTrack(k) { if (PRES_FEATURE[k] && !PRES.seen[k]) { PRES.seen[k] = true; trackFeature(PRES_FEATURE[k]); } }
function presBurst() { ENV.burst = trBurstBump(ENV.burst, Date.now(), TR_BURST_MS, TR_BURST_MAX_MS); trPollSoon(1500); }

function presForget() {
  PRES = presBlank();
  if (presTimer) { clearInterval(presTimer); presTimer = null; }
}
/* 開框時決定從哪裡開始:主行程存了帳密、而且這台電腦開始過 → 直接回到清單;否則先看 PSCCA */
async function presResume() {
  let info = null; try { info = await window.blave.presidentInfo(); } catch (_) { }
  PRES.info = info;
  const pc = presPC();
  if (info && info.saved && pc) PRES.phase = "flow";
  presScan();   // 清單裡「選憑證」那張卡也要到期日
  presPaint();
}
async function presScan() {
  let r = null; try { r = await window.blave.presidentScan(); } catch (_) { }
  PRES.scan = r && r.code === "OK" ? { found: r.found, expiry: r.expiry, newestAt: r.newestAt } : { found: 0, expiry: null, newestAt: 0 };
  // PSCCA 有憑證就直接到帳密(開框第一次看到、或憑證e總管申請完出現新檔都一樣),不用「我完成了」鈕
  if (PRES.phase === "prep" && PRES.scan.found > 0) { PRES.waitTcem = false; PRES.source = "found"; PRES.phase = "form"; presWatch(false); }
  presPaint();
}
function presWatch(on) {
  if (presTimer) { clearInterval(presTimer); presTimer = null; }
  if (on) presTimer = setInterval(() => { if ($("cx-scrim").hidden || CXF.venue !== PRESIDENT) return presWatch(false); presScan(); }, PRES_SCAN_MS);
}
async function presOpenTcem() {
  if (PRES.busy) return;
  PRES.busy = true; PRES.tcemMsg = null; presPaint();
  let r = null; try { r = await window.blave.presidentTcem(); } catch (_) { }
  PRES.busy = false;
  // 等待態與輪詢只在還沒找到憑證的那一頁:presScan 可能在等的時候已把 phase 推到 form;清單裡「憑證過期」那顆也走這裡(只開程式)
  if (r && r.code === "OK") { presTrack("tcem"); if (PRES.phase === "prep") { PRES.waitTcem = true; presWatch(true); } }
  else PRES.tcemMsg = r && r.code === "HASH" ? "pres.tcem.hash" : r && r.code === "DOWNLOAD" ? "pres.tcem.download" : "pres.tcem.fail";
  presPaint();
}
// 主行程回的錯 + 發生在哪一步(presMsgPlace 決定畫在哪)
const presErr = (r, step) => Object.assign({}, r || { code: "FAILED" }, { step });
async function presSaveCreds(then) {
  if (PRES.busy || presDown()) return;
  PRES.busy = true; PRES.msg = null; presPaint();
  let r = null; try { r = await window.blave.presidentCreds(PRES.acct.trim(), PRES.pw); } catch (_) { }
  PRES.busy = false;
  if (!r || r.code !== "OK") { PRES.msg = presErr(r, "creds"); presPaint(); return; }
  PRES.pw = ""; presTrack("form");
  try { PRES.info = await window.blave.presidentInfo(); } catch (_) { }
  if (then) await then();
  presPaint();
}
async function presGo() {
  if (PRES.phase !== "form" || !/^[0-9]{11}$/.test(PRES.acct.trim()) || !PRES.pw) return;
  await presSaveCreds(async () => { PRES.phase = "flow"; PRES.acct = ""; });
}
async function presStep(name, opts) {
  if (PRES.busy || presDown()) return;
  const pc = presPC();
  PRES.busy = true; PRES.msg = null; presPaint();
  let r = null; try { r = await window.blave.presidentStep(name, opts || {}); } catch (_) { }
  PRES.busy = false;
  const code = r && r.code, step = name === "host" ? "probe" : name;
  if (code === "OK" || code === "SENT") PRES.sent = { step, at: Date.now(), upd: pc ? pc.updated_at : null };
  else PRES.msg = presErr(r, step);
  presBurst(); presPaint();
}
async function presPick() {
  if (PRES.busy) return;
  let r = null; try { r = await window.blave.presidentPick(); } catch (_) { }
  if (r && r.code === "OK") { PRES.source = "picked"; PRES.picked = true; PRES.msg = null; }
  else if (r && r.code === "BAD_FILE") PRES.msg = { code: "PFX_INVALID", step: "cert" };
  presPaint();
}
async function presUseCert() {
  if (PRES.busy || presDown()) return;
  const pc = presPC();
  PRES.busy = true; PRES.msg = null; presPaint();
  let r = null; try { r = await window.blave.presidentCert(PRES.caPw, PRES.source); } catch (_) { }
  PRES.busy = false;
  const code = r && r.code;
  if (code === "OK" || code === "SENT") { PRES.caPw = ""; PRES.recert = false; PRES.sent = { step: "cert", at: Date.now(), upd: pc ? pc.updated_at : null }; if (code === "OK") presTrack("cert"); }
  else PRES.msg = presErr(r, "cert");
  presBurst(); presPaint();
}
// 改交易密碼(被統一擋下之後):存新密碼 → 用同一張憑證重綁(.env 的指紋跟著換)→ 正式主機再確認
async function presRecheck() {
  if (!PRES.pw) return;
  await presSaveCreds(async () => {
    const pc = presPC();
    PRES.busy = true; presPaint();
    let r = null; try { r = await window.blave.presidentCert(null, PRES.source); } catch (_) { }
    PRES.busy = false;
    if (r && r.code === "OK") { PRES.recheck = false; await presStep("probe"); }
    else if (r && r.code === "SENT") { PRES.recheck = false; PRES.sent = { step: "cert", at: Date.now(), upd: pc ? pc.updated_at : null }; }
    else { PRES.recheck = false; PRES.recert = true; PRES.msg = presErr(r, "cert"); }
  });
}
// 測試主機:照信上的網址(沒填就用測試主機);營業員說開好了 = 切正式。兩者都是 host,切完自動確認登入
function presHost(target) {
  const url = PRES.test.url.trim();
  return presStep("host", target === "live" ? { env: "live" } : url ? { url } : { env: "test" });
}

/* 看回報推進:sent 在回報動了就收;自動的兩步:① 進清單、元件沒裝也沒在裝 → setup ② 正式主機登入過 → start。
   登入不會自動再試(任何失敗都等用戶按「確認登入」) */
function presAdvance(view, pc) {
  if (PRES.sent && pc && pc.updated_at !== PRES.sent.upd) PRES.sent = null;
  if (PRES.busy || PRES.sent || presDown() || PRES.phase !== "flow" || (pc && pc.busy)) return;
  const setup = presSec(pc, "setup"), worker = presSec(pc, "worker");
  if (!PRES.setupSent && setup.status !== "ok" && setup.status !== "running" && setup.status !== "failed") { PRES.setupSent = true; presStep("setup"); return; }
  if (view === "d-finish" && !PRES.startSent && worker.status !== "running") { PRES.startSent = true; presTrack("probe"); presStep("start"); }
}

// ── DOM ────────────────────────────────────────────────────────────────────
const presP = (cls, text) => trEl("p", cls, text);
// 回報營業員那一列:一個值(測試單時間 / 委託書號)+ 複製鈕;只複製值,不組話術(Wei 10-07)
function presCopyRow(label, value) {
  const d = trEl("div", ""), v = trEl("dd", ""); v.appendChild(trEl("span", "pres-mono", value || "—"));
  if (value) {
    const cp = capBtn("btn-quiet", t("pres.copy"), async () => { try { await navigator.clipboard.writeText(value); srSay(t("pres.copied")); cp.textContent = t("pres.copied"); } catch (_) { } }, null);
    v.appendChild(cp);
  }
  d.append(trEl("dt", "", label), v); return d;
}
// 這一列的步驟沒送出去 → 那一列要掛的字;在跑的列不會問到這裡
const presRowErr = (step) => (PRES.msg && PRES.msg.step === step && presMsgPlace(PRES.msg) === "row" ? t("pres.err.generic") : null);
const presBadRow = (name, text, retry, id) => capRow("bad", name, "", capFrag(capErr(text), capActs(capBtn("btn-out", t("pres.retry"), retry, id, PRES.busy || presDown()))));
function presInput(id, label, key, o) {
  const opts = o || {}, l = trEl("label", "fld"); l.appendChild(trEl("span", "fld-l", label));
  const i = trEl("input", "f-input txt" + (opts.mono ? " pres-mono" : "") + (opts.err ? " is-err" : "")); i.id = id; i.type = opts.plain ? "text" : "password";
  i.autocomplete = opts.plain ? "off" : "new-password"; i.spellcheck = false; i.setAttribute("autocapitalize", "off");
  if (opts.numeric) i.inputMode = "numeric";
  i.value = PRES[key]; i.readOnly = !!PRES.busy;
  i.addEventListener("input", () => { PRES[key] = i.value; presSyncGo(); });
  i.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing && opts.enter) { e.preventDefault(); opts.enter(); } });
  l.appendChild(i);
  const d = [];
  if (opts.err) { const e = trEl("p", "cap-err", opts.err); e.id = id + "-err"; e.setAttribute("role", "status"); d.push(e.id); l.appendChild(e); }
  else if (opts.hint) { const h = trEl("p", "cx-hint", opts.hint); h.id = id + "-hint"; d.push(h.id); l.appendChild(h); }
  if (d.length) i.setAttribute("aria-describedby", d.join(" "));
  return l;
}
function presPrepBody(view) {
  const f = document.createDocumentFragment();
  if (view === "d-prep-load") { f.appendChild(presP("cap-lead", t("pres.prep.looking"))); return f; }
  if (view === "d-prep-wait") {
    const row = trEl("div", "pres-wait"), sp = trEl("span", "spin16"); sp.setAttribute("aria-hidden", "true");
    row.append(sp, presP("cap-lead", t("pres.wait.lead")));
    f.append(row, presP("cx-hint", t("pres.wait.hint")));
    f.appendChild(capActs(capBtn("btn-quiet", t("pres.wait.again"), presOpenTcem, "pres-tcem-again", PRES.busy)));
    return f;
  }
  // d-prep-none:兩步純指示,沒有話術
  f.appendChild(presP("cap-lead", t("pres.none.lead")));
  const ol = trEl("ol", "pres-todo");
  const li1 = trEl("li", ""); li1.append(trEl("span", "", t("pres.none.s1")), trEl("span", "sub", t("pres.none.s1sub", { tel: PRES_HOTLINE })));
  const li2 = trEl("li", ""); li2.append(trEl("span", "", t("pres.none.s2")), trEl("span", "sub", t("pres.none.s2sub")));
  ol.append(li1, li2); f.appendChild(ol);
  if (PRES.tcemMsg) f.appendChild(capErr(t(PRES.tcemMsg)));
  return f;
}
function presFormBody() {
  const f = document.createDocumentFragment();
  f.appendChild(cxVenueField(TR_BAGS.local));
  // 第一句就是找 PSCCA 的結果(事前準備頁拿掉了);選了別的檔或沒憑證(改帳號回來)就不講
  if (PRES.source !== "picked" && PRES.scan && PRES.scan.found > 0) f.appendChild(presP("cap-lead", PRES.scan.expiry ? t("pres.form.found", { date: PRES.scan.expiry }) : t("pres.form.foundNoDate")));
  const acctBad = PRES.acct.trim() && !/^[0-9]{11}$/.test(PRES.acct.trim());
  f.appendChild(presInput("pres-acct", t("pres.form.acct"), "acct", { plain: true, mono: true, numeric: true, hint: t("pres.form.acctHint"), err: acctBad ? t("pres.form.acctErr") : null, enter: presPrimary }));
  f.appendChild(presInput("pres-pw", t("pres.form.pw"), "pw", { hint: t("pres.form.pwHint"), enter: presPrimary }));
  const note = trEl("div", "cx-note"); note.appendChild(presP("", t("pres.form.store"))); f.appendChild(note);
  return f;
}
// 「選憑證」那一列的展開內容:找到的那張(只顯示到期日)或「選別的檔案」那張 + 憑證密碼
function presCertBody(pc, view) {
  // 剛按下去沒送出去的錯(PRES.msg)比狀態檔裡上一次的 cert.error 新,先畫它
  const cert = presSec(pc, "cert"), fresh = PRES.msg && PRES.msg.step === "cert" && PRES_PFX_ERR[PRES.msg.code] ? PRES.msg.code : null;
  const code = fresh || (view === "d-cert-err" ? cert.error : null), pwErr = PRES_PFX_ERR[code] === "pres.pfx.errPw";
  const f = document.createDocumentFragment(), card = trEl("div", "pres-found");
  const mk = trEl("span", "cap-mk"); mk.appendChild(trEl("span", "cur")); mk.setAttribute("aria-hidden", "true");
  const tx = trEl("div", "");
  if (PRES.source === "picked") tx.append(trEl("div", "t", t("pres.cert.picked")), trEl("div", "d", t("pres.cert.pickedD")));
  else {
    const exp = PRES.scan && PRES.scan.expiry;
    tx.append(trEl("div", "t", t("pres.cert.name")), trEl("div", "d", exp ? t("pres.cert.exp", { date: exp }) : t("pres.cert.here")));
  }
  card.append(mk, tx); f.appendChild(card);
  const expired = code === "PFX_EXPIRED", exp = expired ? capDate(cert.not_after) : null;
  const fileErr = presRowErr("cert") || (code && !pwErr ? t(PRES_PFX_ERR[code] || "pres.pfx.errImport", { date: exp || "—" }) : null);
  if (fileErr) { const e = trEl("p", "cap-err", fileErr); e.setAttribute("role", "status"); f.appendChild(e); }
  f.appendChild(presInput("pres-capw", t("pres.cert.pw"), "caPw", { hint: t("pres.cert.pwHint"), err: pwErr ? t("pres.pfx.errPw") : null, enter: presUseCert }));
  const off = PRES.busy || presDown() || !!(pc && pc.busy);
  const acts = [capBtn("btn-fill", t("pres.cert.use"), presUseCert, "pres-use", off), capBtn("btn-quiet", t("pres.cert.other"), presPick, "pres-pick", PRES.busy)];
  // PSCCA 裡只有過期的那張:展延要開憑證e總管,這裡沒有別的入口(開框那次的掃描只看檔名、不看到期日)
  if (expired) acts.push(capBtn("btn-quiet", t("pres.tcem.open"), presOpenTcem, "pres-tcem-renew", PRES.busy));
  f.appendChild(capActs(...acts));
  if (expired && PRES.tcemMsg) f.appendChild(capErr(t(PRES.tcemMsg)));
  f.appendChild(presP("cx-hint pres-gap", t("pres.cert.local")));
  return f;
}
function presPwBody(msg, extra) {
  const ready = !!PRES.pw && !PRES.busy && !presDown();
  const go = capBtn("btn-fill", t("pres.pw.go"), presRecheck, "pres-recheck", !ready); go.dataset.need = "pw";
  return capFrag(capErr(msg), presInput("pres-pw", t("pres.form.pw"), "pw", { err: null, hint: t("pres.pw.hint"), enter: presRecheck }), capActs(go, extra || null));
}
/* 登入失敗(任何一類):講哪一類、處理好按「確認登入」(每按一次真的登入一次)、被鎖找營業員——不講次數;
   密碼／原因不明多一個改交易密碼,憑證兩類多換憑證／改帳號。按了沒送出去的錯也掛在這一列 */
function presProbeBody(view, pc) {
  const off = PRES.busy || presDown() || !!(pc && pc.busy), acct = (PRES.info && PRES.info.account) || "—";
  const KEY = { "d-PASSWORD": "pres.err.password", "d-UNKNOWN": "pres.err.unknown", "d-CERT": "pres.err.cert", "d-CERT_MISMATCH": "pres.err.certMismatch",
    "d-TIMEOUT": "pres.err.timeout", "d-MAINTENANCE": "pres.err.maint" };
  const confirm = capBtn("btn-fill", t("pres.err.confirm"), () => presStep("probe"), "pres-confirm", off);
  const extra = view === "d-PASSWORD" || view === "d-UNKNOWN" ? [capBtn("btn-quiet", t("pres.err.changePw"), () => { PRES.recheck = true; presPaint(); }, "pres-change-pw")]
    : view === "d-CERT" || view === "d-CERT_MISMATCH" ? [capBtn("btn-quiet", t("pres.err.certSwap"), () => { PRES.recert = true; presPaint(); }, "pres-recert"),
      capBtn("btn-quiet", t("pres.err.acctSwap"), () => { PRES.phase = "form"; presPaint(); }, "pres-acct-swap")] : [];
  const notSent = presRowErr("probe");
  // 略過測試段直接登正式、被拒沒說原因:多半是營業員還沒開正式權限——指回上面的測試單(不自動重試)
  const skipNote = view === "d-UNKNOWN" && pc && pc.env === "live" && pc.test_skipped === true ? presP("cx-hint", t("pres.err.unknownSkipped")) : null;
  return capFrag(capErr(t(KEY[view] || "pres.err.nocreds", { acct }), view === "d-MAINTENANCE"), skipNote, notSent ? capErr(notSent) : presP("cx-hint", t("pres.err.stopNote")), capActs(confirm, ...extra));
}
function presTestHostBody(view) {
  const f = document.createDocumentFragment();
  f.appendChild(capDo(t("pres.t.hostDo")));
  const notSent = presRowErr("probe"); if (notSent) f.appendChild(capErr(notSent));
  const l = trEl("label", "fld"); l.appendChild(trEl("span", "fld-l", t("pres.t.url")));
  const i = trEl("input", "f-input txt pres-mono"); i.id = "pres-turl"; i.type = "text"; i.spellcheck = false; i.autocomplete = "off"; i.value = PRES.test.url;
  i.addEventListener("input", () => { PRES.test.url = i.value; });
  l.append(i, presP("cx-hint", t("pres.t.urlHint"))); f.appendChild(l);
  f.appendChild(capActs(capBtn("btn-fill", t("pres.t.probe"), () => presHost("test"), "pres-tprobe", PRES.busy || presDown())));
  return f;
}
// 測試單的時間(runtime 寫台北時間 ISO)→ MM/DD HH:MM:SS,照營業員看的那個時區
function presTaipei(iso) {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/.exec(String(iso || ""));
  return m ? `${m[1]}/${m[2]} ${m[3]}` : "—";
}
// 回報營業員:一句指示 + 測試單的時間與委託書號(可複製的值),沒有話術;「營業員說開好了」沒送出去的錯也掛這一列
function presTestReportBody(pc) {
  const to = presSec(pc, "test_order"), dl = trEl("dl", "cap-acct pres-report");
  dl.append(presCopyRow(t("pres.t.reportWhen"), to.at ? presTaipei(to.at) : null), presCopyRow(t("pres.t.reportNo"), typeof to.orderno === "string" ? to.orderno : null));
  const notSent = presRowErr("probe");
  return capFrag(capDo(t("pres.t.reportDo")), dl, notSent ? capErr(notSent) : presP("cx-hint", t("pres.t.reportHint")),
    capActs(capBtn("btn-fill", t("pres.t.opened"), () => presHost("live"), "pres-probe", PRES.busy || presDown()), capBtn("btn-quiet", t("pres.t.later"), () => cxModalClose(false), "pres-later")));
}
/* 態 → 清單各列(mockup deskSteps):準備(安裝、選憑證)/ 測試環境(三列)/ 正式環境(確認登入、啟動下單程式) */
function presRows(view, pc) {
  const setup = presSec(pc, "setup"), cert = presSec(pc, "cert"), worker = presSec(pc, "worker");
  const nm = PRES.sent && Date.now() - PRES.sent.at >= PRES_NO_MOVE_MS ? capFrag(capDo(t("pres.noMove")), capActs(capBtn("btn-out", t("pres.retry"), () => { const s = PRES.sent.step; PRES.sent = null; if (s === "cert") { PRES.recert = true; presPaint(); } else presStep(s); }, "pres-nomove"))) : null;
  const runRow = (name, right) => (nm ? capRow("cur", name, "", nm) : capRow("run", name, right));
  // 在跑的優先:這台電腦說那一步正在跑,就不講「沒有開始」
  const run = presRunning(pc, PRES.sent, Date.now()), rowErr = (step) => (run === step ? null : presRowErr(step));
  // 段標題:字對讀屏藏(列名自己會講),右邊可掛一顆鈕(測試段的「直接登入正式主機」)
  const ol = trEl("ol", "cap-steps pres-steps"), ph = (k, btn) => { const li = trEl("li", "pres-ph"), s = trEl("span", "", t(k)); s.setAttribute("aria-hidden", "true"); li.appendChild(s); if (btn) li.appendChild(btn); ol.appendChild(li); };
  const add = (li) => ol.appendChild(li);
  const exp = capDate(cert.not_after), certDone = exp ? t("pres.s.certExp", { date: exp }) : "";
  const env = pc && pc.env === "live" ? "live" : "test", live = env === "live", off = PRES.busy || presDown() || !!(pc && pc.busy);
  const probe = presSec(pc, "probe"), to = presSec(pc, "test_order");
  // 已經開過正式權限的(Wei 本人、換電腦重裝):不必走測試段——host live 切正式＋登入,runtime 記 test_skipped、三列標「已略過」(仍可回頭做)
  const skipped = live && !!pc && pc.test_skipped === true;
  // 登入失敗與改密碼:掛在登入那個環境的那一列
  const probeErr = Object.values(PRES_PROBE_VIEW).concat(["NOCREDS"]).indexOf(view.slice(2)) >= 0;
  const errRow = (name) => view === "d-pw" ? capRow("bad", name, "", presPwBody(t("pres.pw.lead")))
    : capRow(view === "d-MAINTENANCE" ? "cur" : "bad", name, "", presProbeBody(view, pc));
  ph("pres.ph.prep");
  if (setup.status === "ok") add(capRow("done", t("pres.s.setup")));
  else if (view === "d-setup-fail") add(capRow("bad", t("pres.s.setup"), "", capFrag(capErr(t("pres.s.setupFail")), capActs(capBtn("btn-out", t("pres.retry"), () => presStep("setup"), "pres-retry", PRES.busy)))));
  else if (rowErr("setup")) add(presBadRow(t("pres.s.setup"), rowErr("setup"), () => presStep("setup"), "pres-retry"));
  else add(runRow(t("pres.s.setup"), t("pres.s.setupRun")));
  const certNow = view === "d-cert" || view === "d-cert-err";
  if (view === "d-cert-run") add(runRow(t("pres.s.cert"), t("pres.s.certRun")));
  else if (certNow) add(capRow(view === "d-cert-err" || rowErr("cert") ? "bad" : "cur", t("pres.s.cert"), "", presCertBody(pc, view)));
  else add(capRow(cert.status === "ok" ? "done" : "todo", t("pres.s.cert"), cert.status === "ok" ? certDone : ""));
  ph("pres.ph.test", !live && to.status !== "ok" ? capBtn("btn-quiet", t("pres.t.skip"), () => presHost("live"), "pres-skip-test", off) : null);
  // 略過之前被拒過的測試單不算「測過」:略過後正式登入 UNKNOWN 時,回測試段的路只有這一列的鈕(稽核 integ-0118 第三版 B-1)
  const tProbed = (live && !skipped) || (probe.status === "ok" && probe.env === "test") || to.status === "ok" || (!skipped && to.status === "failed");
  const skipRight = skipped ? t("pres.s.skipped") : "";
  if (view === "d-t-host") add(capRow(rowErr("probe") ? "bad" : "cur", t("pres.s.tprobe"), "", presTestHostBody(view)));
  else if (view === "d-t-probe") add(runRow(t("pres.s.tprobe"), t("pres.s.probeRun")));
  else if (!live && (probeErr || view === "d-pw")) add(errRow(t("pres.s.tprobe")));
  else if (skipped) add(capRow("todo", t("pres.s.tprobe"), skipRight, capActs(capBtn("btn-quiet", t("pres.t.back"), () => presStep("host", { env: "test" }), "pres-test-back", off))));   // 回頭做:只切回測試環境,登入由這一列(信上的網址)來
  else add(capRow(tProbed ? "done" : "todo", t("pres.s.tprobe"), tProbed ? t("pres.s.tprobeDone") : skipRight));
  if (view === "d-t-order" || view === "d-t-order-fail") add(capRow(view === "d-t-order-fail" || rowErr("test_order") ? "bad" : "cur", t("pres.s.torder"), "", capFrag(capDo(t("pres.t.orderDo")),
    rowErr("test_order") ? capErr(rowErr("test_order")) : view === "d-t-order-fail" ? capErr(t("pres.t.orderFail")) : null,   // 剛沒送出去的錯比上一次的被拒新
    capActs(capBtn(view === "d-t-order-fail" ? "btn-out" : "btn-fill", t(view === "d-t-order-fail" ? "pres.t.orderAgain" : "pres.t.order"), () => presStep("test_order"), "pres-torder", PRES.busy || presDown())))));
  else if (view === "d-t-order-run") add(runRow(t("pres.s.torder"), t("pres.s.orderRun")));
  else { const d = (live && !skipped) || to.status === "ok"; add(capRow(d ? "done" : "todo", t("pres.s.torder"), d ? t("pres.s.torderDone") : to.status === "failed" ? "" : skipRight)); }   // 被拒過的不是「已略過」
  if (view === "d-t-report") add(capRow(rowErr("probe") ? "bad" : "cur", t("pres.s.treport"), "", presTestReportBody(pc)));
  else add(capRow(live && !skipped ? "done" : "todo", t("pres.s.treport"), live && !skipped ? t("pres.s.treportDone") : skipRight));
  ph("pres.ph.live");
  if (view === "d-probe") add(runRow(t("pres.s.probe"), t("pres.s.probeRun")));
  else if (live && (probeErr || view === "d-pw")) add(errRow(t("pres.s.probe")));
  else add(capRow(view === "d-finish" || view === "d-finish-fail" ? "done" : "todo", t("pres.s.probe"), view === "d-finish" || view === "d-finish-fail" ? t("pres.s.probeDone") : ""));
  if (view === "d-finish" && rowErr("start")) add(presBadRow(t("pres.s.worker"), rowErr("start"), () => { PRES.startSent = true; presStep("start"); }, "pres-retry"));
  else if (view === "d-finish") add(runRow(t("pres.s.worker"), t("pres.s.workerRun")));
  else if (view === "d-finish-fail") add(capRow("bad", t("pres.s.worker"), "", capFrag(capErr(t("pres.s.workerFail")), capActs(capBtn("btn-out", t("pres.retry"), () => { PRES.startSent = true; presStep("start"); }, "pres-retry", PRES.busy)))));
  else add(capRow(worker.status === "ok" ? "done" : "todo", t("pres.s.worker")));
  return ol;
}
function presDoneBody(pc) {
  const r = presReport() || {}, a = (r.account && r.account.venues && r.account.venues[PRESIDENT]) || {}, cert = presSec(pc, "cert");
  const f = document.createDocumentFragment();
  const lede = trEl("p", "cap-lead pres-ok"); lede.append(trEl("i", "dot"), trEl("span", "", t("pres.done.lead"))); f.appendChild(lede);
  const big = trEl("div", "pres-big"); big.append(trEl("div", "l", t("pres.done.equity")), trEl("div", "v mono", typeof a.equity === "number" ? "NT$ " + Math.round(a.equity).toLocaleString("en-US") : "—"));
  f.appendChild(big);
  const dl = trEl("dl", "cap-acct"), kv = (k, v, cls) => { const d = trEl("div", ""); d.append(trEl("dt", "", k), trEl("dd", cls || "", v)); dl.appendChild(d); };
  kv(t("pres.done.acct"), t("pres.done.acctV", { acct: (PRES.info && PRES.info.account) || "—" }), "mono");
  kv(t("pres.done.can"), t("pres.done.canV"));
  const exp = capDate(cert.not_after), n = presDaysLeft(cert.not_after, Date.now());
  if (exp) kv(t("pres.done.exp"), n !== null ? t("pres.done.expV", { date: exp, n }) : exp, "mono");
  f.appendChild(dl);
  const note = trEl("div", "cx-note");
  ["pres.done.n1", "pres.done.n2"].forEach((k) => note.appendChild(presP("", t(k))));
  f.appendChild(note);
  return f;
}
// 浮動 slot 要放的字;清單列的錯與憑證檔的錯都畫在列裡
function presMsgText(m) {
  const where = presMsgPlace(m);
  return where === "frame" ? t(PRES_FRAME_ERR[m.code]) : where === "slot" ? t("pres.err.generic") : null;
}

// 腳:找憑證 / 表單 = 取消 + 主鈕;清單 = 關閉;完成 = 設定策略下單(關框)
function presFoot(view) {
  const go = $("cx-go"), cancel = $("cx-cancel"), where = $("cx-where");
  where.hidden = true; where.textContent = "";
  const prep = view === "d-prep-none" || view === "d-prep-load" || view === "d-prep-wait";
  const label = view === "d-prep-none" ? t("pres.tcem.open") : view === "d-form" ? (PRES.busy ? t("cx.connecting") : t("pres.form.go"))
    : view === "d-done" ? t("pres.done.go") : null;
  go.hidden = !label;
  if (label && go.textContent.trim() !== label) go.textContent = label;
  cancel.hidden = view === "d-done";
  cancel.textContent = prep || view === "d-form" || view === "d-mac" ? (view === "d-prep-none" ? t("pres.later") : t("del.cancel")) : t("set.close");
  go.classList.toggle("is-busy", view === "d-form" && PRES.busy);
  presSyncGo(view);
}
function presSyncGo(view) {
  const v = view || PRES.view, go = $("cx-go");
  let off = presDown() || PRES.busy;
  if (v === "d-form") off = off || !/^[0-9]{11}$/.test(PRES.acct.trim()) || !PRES.pw;
  go.setAttribute("aria-disabled", off ? "true" : "false");
  document.querySelectorAll("#cx-body [data-need]").forEach((b) => { b.setAttribute("aria-disabled", !PRES[b.dataset.need] || PRES.busy || presDown() ? "true" : "false"); });
}
function presPrimary() {
  if ($("cx-go").getAttribute("aria-disabled") === "true") return;
  const v = PRES.view;
  if (v === "d-prep-none") return presOpenTcem();
  if (v === "d-form") return presGo();
  if (v === "d-done") { presTrack("ready"); return cxModalClose(true); }
}

function presPaint() {
  if ($("cx-scrim").hidden || CXF.venue !== PRESIDENT || CXF.env !== "local") return;
  const pc = presPC(), ctx = presCtx();
  let view = presView(pc, PRES, ctx);
  presAdvance(view, pc);
  view = presView(pc, PRES, ctx);
  PRES.view = view;
  if (view === "d-done" && !PRES.seen.ready && presSec(pc, "worker").status === "ok" && PRES.startSent) presTrack("ready");
  const box = $("cx-body");
  $("cx-title").textContent = t("pres.title");
  $("cx-modal").querySelector(".modal-head").classList.remove("cloud");
  $("cx-env").hidden = false; $("cx-env").textContent = t("env.local");
  presFoot(view);
  box.setAttribute("aria-busy", PRES.busy || ["d-finish", "d-probe", "d-cert-run", "d-setup", "d-t-probe", "d-t-order-run"].indexOf(view) >= 0 ? "true" : "false");
  const sig = LANG + "|" + JSON.stringify([view, pc, PRES.scan, PRES.busy, PRES.msg, PRES.source, PRES.tcemMsg, PRES.test, PRES.info,
    PRES.sent && Date.now() - PRES.sent.at >= PRES_NO_MOVE_MS, presDown(), presReport() && presReport().account]);
  if (PRES.sig === sig && box.firstChild) return;
  PRES.sig = sig;
  const hadId = box.contains(document.activeElement) ? document.activeElement.id : null;
  box.textContent = "";
  if (view === "d-mac") { box.appendChild(cxVenueField(TR_BAGS.local)); box.append(presP("cap-lead", t("pres.mac.lead")), presP("cx-hint", t("pres.mac.hint"))); }
  else if (view.indexOf("d-prep") === 0) { box.appendChild(cxVenueField(TR_BAGS.local)); box.appendChild(presPrepBody(view)); }
  else if (view === "d-form") box.appendChild(presFormBody());
  else if (view === "d-done") box.appendChild(presDoneBody(pc));
  else box.appendChild(presRows(view, pc));
  const slot = trEl("div", ""); slot.setAttribute("role", "status"); box.appendChild(slot);
  const m = presDown() ? t("side.stopped") : presMsgText(PRES.msg);
  if (m) slot.appendChild(capErr(m, !presDown() && PRES.msg && PRES.msg.code === "BUSY"));
  presSyncGo(view);
  const back = hadId && $(hadId);
  if (back && !back.disabled) back.focus();
}
function presFootRestore() { const go = $("cx-go"); go.classList.remove("is-busy"); }

/* ── 自動下單頁:有統一部位時一條橫幅(d-first:電腦不睡、關掉不平倉),只在這台電腦視角 ── */
function presBannerPaint() {
  const el = $("pres-banner"); if (!el) return;
  const show = TR.env === "local" && window.blave.platform === "win32";
  const r = show ? presReport() : null, lots = r ? presHeldLots(r) : 0;
  const sig = LANG + "|" + lots;
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig; el.textContent = "";
  el.hidden = !lots;
  if (lots) {
    const b = trEl("div", "pres-banner"), tx = trEl("div", "");
    tx.append(presP("", t("pres.held.lead", { n: lots })), presP("small", t("pres.held.sub")));
    b.appendChild(tx); el.appendChild(b);
  }
}
// 帳戶讀取器的 positions(同主行程 president_local.heldLots)
function presHeldLots(report) {
  const a = report && report.account && report.account.venues && report.account.venues[PRESIDENT];
  const p = a && a.positions && typeof a.positions === "object" ? a.positions : {};
  return Object.keys(p).reduce((n, k) => { const s = p[k] && Number(p[k].size); return n + (isFinite(s) && s > 0 ? Math.round(s) : 0); }, 0);
}
// 設定 › 帳戶 「開通中＋繼續」:帳密存了、下單程式從來沒起來過(worker.ok_at = 起來過;同 trade.js trPresWip)
function presWip(r) { const c = r && r.president_connect; return !!c && typeof c === "object" && !(c.worker && (c.worker.status === "ok" || c.worker.ok_at)); }
/* 第一次用真錢啟動統一策略:多一道確認(各策略口數 + 權益數),按了繼續才進一般的啟動框。這台電腦記住按過(localStorage) */
const PRES_FIRST_KEY = "tr_pres_first_ok";
function presFirstGate(next, opener) {
  const r = presReport() || {}, v = r.venues && r.venues[PRESIDENT];
  if (TR.env !== "local" || !(v && v.credentials) || lsGet(PRES_FIRST_KEY) === "1") return next();
  const rows = presFirstRows(trStored());
  const a = (r.account && r.account.venues && r.account.venues[PRESIDENT]) || {};
  const lines = rows.map((x) => t("pres.first.row", { name: trDisplay(x.name), n: x.lots, unit: t(trLotsKey(x.lots, "tr.lotsUnit", "tr.lotUnit")) }));
  lines.push(typeof a.equity === "number" ? t("pres.first.equity", { v: "NT$ " + Math.round(a.equity).toLocaleString("en-US") }) : t("pres.first.equityNone"));
  lines.push(t("pres.first.margin"));
  confirmBox({ title: t("pres.first.title"), mark: t("tr.mode.real"), markKind: "real", opener, lines, ok: t("pres.first.ok"),
    onOk: () => { lsSet(PRES_FIRST_KEY, "1"); trackFeature("pres_first_start"); setTimeout(next, 0); } });
}
