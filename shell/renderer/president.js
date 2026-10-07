/* 統一期貨 本機開通(電腦版 Windows;設計 mockup-president-onboarding.html 電腦版分頁 d-*,Wei 10-07 拍板)。
   連接交易所框(#cx-scrim,trade.js)在「這台電腦」視角選到統一時,整個框交給這個檔畫:事前準備 → 帳密 → 開通清單 → 完成。
   - 狀態只有一個來源:這台電腦 daemon 回報的 `president_connect`(TR_BAGS.local.st.report);長步驟回條等不到是常態,畫面看狀態走。
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
const PRES_PROBE_VIEW = { password: "PASSWORD", unknown: "UNKNOWN", cert_mismatch: "CERT_MISMATCH", cert: "CERT", blocked: "BLOCKED",
  unblock_used: "BLOCKED2", maintenance: "MAINTENANCE", host: "HOST", timeout: "TIMEOUT", retry_later: "TRANSIENT", no_credentials: "NOCREDS" };
const PRES_PFX_ERR = { PFX_PASSWORD: "pres.pfx.errPw", PFX_EXPIRED: "pres.pfx.errExpired", PFX_NOT_PRESIDENT: "pres.pfx.errIssuer",
  PFX_INVALID: "pres.pfx.errFile", PFX_TOO_LARGE: "pres.pfx.errFile", READ_FAILED: "pres.pfx.errRead", PFX_NONE_FOUND: "pres.pfx.errNone" };
const PRES_FEATURE = { form: "pres_form_saved", tcem: "pres_tcem_open", cert: "pres_cert_ok", probe: "pres_probe_ok", ready: "pres_ready" };

const presBlank = () => ({ phase: "prep", scan: null, waitTcem: false, baseAt: 0, tcemMsg: null, gotMail: false, acct: "", pw: "", caPw: "",
  source: "found", picked: false, busy: false, msg: null, sent: null, unlockUsed: false, recheck: false, recert: false,
  test: { url: "" }, info: null, seen: {}, sig: null, started: false, setupSent: false, startSent: false, maintRetry: false, view: null });
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
/* (president_connect, 畫面自己的狀態, { win, dual, now }) → 態的名字(mockup 的 d-* 家族)。順序有意義:在跑的最先(鈕全鎖),
   再來是要用戶做事的,最後才是往下一步 */
function presView(pc, ui, ctx) {
  if (!ctx.win) return "d-mac";
  if (ctx.dual) return "d-dual";
  if (ui.phase === "prep") return ui.waitTcem ? "d-prep-wait" : !ui.scan ? "d-prep-load" : ui.scan.found > 0 ? "d-prep" : "d-prep-none";
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
  if (worker.status === "failed" && wErr.indexOf("BLOCKED") !== 0) return "d-finish-fail";
  if (cert.status === "failed") return "d-cert-err";
  if (cert.status !== "ok") return "d-cert";
  // 下單程式的登入被擋(runtime local_tick 寫 BLOCKED:<類別>):跟正式登入被擋同一組畫面,不再自動啟動
  // (正式主機之後又確認過一次、比這個失敗新 = 用戶已經處理過:往下走)
  if (worker.status === "failed" && !(probe.status === "ok" && (probe.at || 0) > (worker.at || 0))) return "d-" + ({ PASSWORD: "PASSWORD", CERT: "CERT", CERT_MISMATCH: "CERT_MISMATCH" }[wErr.slice(8)] || "BLOCKED");
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
// 憑證到期橫幅:31 天內(= 憑證e總管開放展延的窗口)才出
function presRenewDue(pc, now) {
  const c = presSec(pc, "cert"); if (c.status !== "ok") return null;
  const n = presDaysLeft(c.not_after, now);
  return n !== null && n <= 31 ? n : null;
}
// 第一次真錢啟動的確認(Wei 10-07 Q7 C):各策略口數 + 帳戶可動用 / 權益。amounts = portfolio_config 的口數
function presFirstRows(amounts) {
  const a = amounts && typeof amounts === "object" ? amounts : {};
  return Object.keys(a).filter((n) => typeof a[n] === "number" && a[n] > 0).sort().map((n) => ({ name: n, lots: Math.round(a[n]) }));
}
// 統一維護 05:30–05:50(台北);過了就自動再確認一次
function presMaintOver(now) {
  const tp = new Date(now + 8 * 3600000), m = tp.getUTCHours() * 60 + tp.getUTCMinutes();
  return m >= 5 * 60 + 50 || m < 5 * 60 + 30;
}
/* ── 純邏輯到此 ── */

const presPC = () => { const r = TR_BAGS.local.st && TR_BAGS.local.st.report; const c = r && r.president_connect; return c && typeof c === "object" ? c : null; };
const presReport = () => (TR_BAGS.local.st && TR_BAGS.local.st.report) || null;
// 雲端那邊已經綁了統一:兩本帳本對同一個帳戶會把對方的單當手動倉(Q6 目前擋)。雲端回報讀不到就不擋(不替它下結論)
function presDual() {
  const r = TR_BAGS.cloud && TR_BAGS.cloud.st && TR_BAGS.cloud.st.report, v = r && r.venues && r.venues[PRESIDENT];
  return !!(v && v.credentials);
}
const presCtx = () => ({ win: window.blave.platform === "win32", dual: presDual(), now: Date.now() });
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
  if (info && info.saved && pc) { PRES.phase = "flow"; PRES.gotMail = true; }
  presScan();   // 清單裡「選憑證」那張卡也要到期日
  presPaint();
}
async function presScan() {
  let r = null; try { r = await window.blave.presidentScan(); } catch (_) { }
  const prev = PRES.scan;
  PRES.scan = r && r.code === "OK" ? { found: r.found, expiry: r.expiry, newestAt: r.newestAt } : { found: 0, expiry: null, newestAt: 0 };
  // 等憑證e總管:出現新檔(張數多了或最新那張換了)就自己往下,不用「我完成了」鈕
  if (PRES.waitTcem && PRES.scan.found > 0 && (!prev || PRES.scan.newestAt > PRES.baseAt)) { PRES.waitTcem = false; PRES.source = "found"; }
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
  if (r && r.code === "OK") { PRES.baseAt = PRES.scan ? PRES.scan.newestAt : 0; PRES.waitTcem = true; presTrack("tcem"); presWatch(true); }
  else PRES.tcemMsg = r && r.code === "HASH" ? "pres.tcem.hash" : r && r.code === "DOWNLOAD" ? "pres.tcem.download" : "pres.tcem.fail";
  presPaint();
}
async function presSaveCreds(then) {
  if (PRES.busy || presDown()) return;
  PRES.busy = true; PRES.msg = null; presPaint();
  let r = null; try { r = await window.blave.presidentCreds(PRES.acct.trim(), PRES.pw); } catch (_) { }
  PRES.busy = false;
  if (!r || r.code !== "OK") { PRES.msg = r || { code: "FAILED" }; presPaint(); return; }
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
  const code = r && r.code;
  if (code === "OK" || code === "SENT") { PRES.sent = { step: name === "host" ? "probe" : name, at: Date.now(), upd: pc ? pc.updated_at : null }; if (opts && opts.afterUnlock) PRES.unlockUsed = true; }
  else PRES.msg = r || { code: "FAILED" };
  presBurst(); presPaint();
}
async function presPick() {
  if (PRES.busy) return;
  let r = null; try { r = await window.blave.presidentPick(); } catch (_) { }
  if (r && r.code === "OK") { PRES.source = "picked"; PRES.picked = true; PRES.msg = null; }
  else if (r && r.code === "BAD_FILE") PRES.msg = { code: "PFX_INVALID" };
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
  else PRES.msg = r || { code: "FAILED" };
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
    else { PRES.recheck = false; PRES.recert = true; PRES.msg = r || { code: "FAILED" }; }
  });
}
// 測試主機:照信上的網址(沒填就用測試主機);營業員說開好了 = 切正式。兩者都是 host,切完自動確認登入
function presHost(target) {
  const url = PRES.test.url.trim();
  return presStep("host", target === "live" ? { env: "live" } : url ? { url } : { env: "test" });
}

/* 看回報推進:sent 在回報動了就收;自動的三步:① 進清單、元件沒裝也沒在裝 → setup ② 正式主機登入過 → start ③ 維護時段過了 → 再確認一次 */
function presAdvance(view, pc) {
  if (PRES.sent && pc && pc.updated_at !== PRES.sent.upd) PRES.sent = null;
  if (PRES.busy || PRES.sent || presDown() || PRES.phase !== "flow" || (pc && pc.busy)) return;
  const setup = presSec(pc, "setup"), worker = presSec(pc, "worker");
  if (!PRES.setupSent && setup.status !== "ok" && setup.status !== "running" && setup.status !== "failed") { PRES.setupSent = true; presStep("setup"); return; }
  if (view === "d-finish" && !PRES.startSent && worker.status !== "running") { PRES.startSent = true; presTrack("probe"); presStep("start"); return; }
  if (view === "d-MAINTENANCE" && !PRES.maintRetry && presMaintOver(Date.now())) { PRES.maintRetry = true; presStep("probe"); }
}

// ── DOM ────────────────────────────────────────────────────────────────────
const presP = (cls, text) => trEl("p", cls, text);
function presScript(text) {
  const box = trEl("div", "pres-script"), h = trEl("div", "pres-script-h");
  const cp = capBtn("btn-quiet", t("pres.copy"), async () => { try { await navigator.clipboard.writeText(text); srSay(t("pres.copied")); cp.textContent = t("pres.copied"); } catch (_) { } }, null);
  h.append(trEl("span", "", t("pres.script.h")), cp);
  box.append(h, trEl("p", "pres-script-b", text));
  return box;
}
function presCheck() {
  const l = trEl("label", "pres-check"), i = trEl("input"); i.type = "checkbox"; i.id = "pres-mail"; i.checked = !!PRES.gotMail;
  i.addEventListener("change", () => { PRES.gotMail = i.checked; presSyncGo(); });
  l.append(i, trEl("span", "", t("pres.prep.mail"))); return l;
}
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
  if (view === "d-prep") {
    const exp = PRES.scan.expiry;
    f.appendChild(presP("cap-lead", exp ? t("pres.prep.found", { date: exp }) : t("pres.prep.foundNoDate")));
    f.appendChild(presP("cx-hint", t("pres.prep.need")));
    f.appendChild(presScript(t("pres.script.have")));
    f.appendChild(presCheck());
    f.appendChild(presP("cx-hint", t("pres.prep.mailHint")));
    return f;
  }
  if (view === "d-prep-wait") {
    const row = trEl("div", "pres-wait"), sp = trEl("span", "spin16"); sp.setAttribute("aria-hidden", "true");
    row.append(sp, presP("cap-lead", t("pres.wait.lead")));
    f.append(row, presP("cx-hint", t("pres.wait.hint")));
    f.appendChild(capActs(capBtn("btn-quiet", t("pres.wait.again"), presOpenTcem, "pres-tcem-again", PRES.busy)));
    return f;
  }
  // d-prep-none
  f.appendChild(presP("cap-lead", t("pres.none.lead")));
  const ol = trEl("ol", "pres-todo");
  const li1 = trEl("li", ""); li1.append(trEl("span", "", t("pres.none.s1")), trEl("span", "sub", t("pres.none.s1sub", { tel: PRES_HOTLINE })));
  ol.appendChild(li1); f.appendChild(ol);
  f.appendChild(presScript(t("pres.script.none")));
  const ol2 = trEl("ol", "pres-todo"); ol2.setAttribute("start", "2");
  const li2 = trEl("li", ""); li2.append(trEl("span", "", t("pres.none.s2")), trEl("span", "sub", t("pres.none.s2sub")));
  ol2.appendChild(li2); f.appendChild(ol2);
  if (PRES.tcemMsg) f.appendChild(capErr(t(PRES.tcemMsg)));
  return f;
}
function presFormBody() {
  const f = document.createDocumentFragment();
  const acctBad = PRES.acct.trim() && !/^[0-9]{11}$/.test(PRES.acct.trim());
  f.appendChild(presInput("pres-acct", t("pres.form.acct"), "acct", { plain: true, mono: true, numeric: true, hint: t("pres.form.acctHint"), err: acctBad ? t("pres.form.acctErr") : null, enter: presPrimary }));
  f.appendChild(presInput("pres-pw", t("pres.form.pw"), "pw", { hint: t("pres.form.pwHint"), enter: presPrimary }));
  const note = trEl("div", "cx-note"); note.appendChild(presP("", t("pres.form.store"))); f.appendChild(note);
  return f;
}
// 「選憑證」那一列的展開內容:找到的那張(只顯示到期日)或「選別的檔案」那張 + 憑證密碼
function presCertBody(pc, view) {
  const cert = presSec(pc, "cert"), code = view === "d-cert-err" ? cert.error : PRES.msg && PRES_PFX_ERR[PRES.msg.code] ? PRES.msg.code : null;
  const f = document.createDocumentFragment(), card = trEl("div", "pres-found");
  const mk = trEl("span", "cap-mk"); mk.appendChild(trEl("span", "cur")); mk.setAttribute("aria-hidden", "true");
  const tx = trEl("div", "");
  if (PRES.source === "picked") tx.append(trEl("div", "t", t("pres.cert.picked")), trEl("div", "d", t("pres.cert.pickedD")));
  else {
    const exp = PRES.scan && PRES.scan.expiry;
    tx.append(trEl("div", "t", t("pres.cert.name")), trEl("div", "d", exp ? t("pres.cert.exp", { date: exp }) : t("pres.cert.here")));
  }
  card.append(mk, tx); f.appendChild(card);
  const exp = code === "PFX_EXPIRED" ? capDate(cert.not_after) : null;
  const fileErr = code && code !== "PFX_PASSWORD" ? t(PRES_PFX_ERR[code] || "pres.pfx.errImport", { date: exp || "—" }) : null;
  if (fileErr) { const e = trEl("p", "cap-err", fileErr); e.setAttribute("role", "status"); f.appendChild(e); }
  f.appendChild(presInput("pres-capw", t("pres.cert.pw"), "caPw", { hint: t("pres.cert.pwHint"), err: code === "PFX_PASSWORD" ? t("pres.pfx.errPw") : null, enter: presUseCert }));
  const off = PRES.busy || presDown() || !!(pc && pc.busy);
  f.appendChild(capActs(capBtn("btn-fill", t("pres.cert.use"), presUseCert, "pres-use", off), capBtn("btn-quiet", t("pres.cert.other"), presPick, "pres-pick", PRES.busy)));
  f.appendChild(presP("cx-hint pres-gap", t("pres.cert.local")));
  return f;
}
function presPwBody(msg, extra) {
  const ready = !!PRES.pw && !PRES.busy && !presDown();
  const go = capBtn("btn-fill", t("pres.pw.go"), presRecheck, "pres-recheck", !ready); go.dataset.need = "pw";
  return capFrag(capErr(msg), presInput("pres-pw", t("pres.form.pw"), "pw", { err: null, hint: t("pres.pw.hint"), enter: presRecheck }), capActs(go, extra || null));
}
function presProbeBody(view, pc) {
  const off = PRES.busy || presDown() || !!(pc && pc.busy), acct = (PRES.info && PRES.info.account) || "—";
  const again = () => capBtn("btn-out", t("pres.retry"), () => presStep("probe"), "pres-retry", off);
  switch (view) {
    case "d-PASSWORD": return presPwBody(t("pres.err.password"));
    case "d-UNKNOWN": return capFrag(presPwBody(t("pres.err.unknown"), PRES.unlockUsed ? null : capBtn("btn-quiet", t("pres.err.unknownOnce"), () => presStep("probe", { afterUnlock: true }), "pres-unlock", off)),
      PRES.unlockUsed ? null : presP("cx-hint", t("pres.err.onceHint")));
    case "d-CERT": case "d-CERT_MISMATCH":
      return capFrag(capErr(view === "d-CERT" ? t("pres.err.cert") : t("pres.err.certMismatch", { acct })),
        capActs(capBtn("btn-fill", t("pres.err.certSwap"), () => { PRES.recert = true; presPaint(); }, "pres-recert"), capBtn("btn-quiet", t("pres.err.acctSwap"), () => { PRES.phase = "form"; presPaint(); }, "pres-acct-swap")));
    case "d-BLOCKED": return PRES.unlockUsed ? presPwBody(t("pres.err.blocked2")) : capFrag(capErr(t("pres.err.blocked")),
      capActs(capBtn("btn-fill", t("pres.err.unlocked"), () => presStep("probe", { afterUnlock: true }), "pres-unlock", off)), presP("cx-hint", t("pres.err.onceHint")));
    case "d-BLOCKED2": return presPwBody(t("pres.err.blocked2"));
    case "d-MAINTENANCE": return capErr(t("pres.err.maint"), true);
    case "d-TRANSIENT": return capFrag(capErr(t("pres.err.transient"), true), capActs(again()));
    case "d-HOST": return capFrag(capErr(t("pres.err.host")), capActs(again()));
    case "d-TIMEOUT": return capFrag(capErr(t("pres.err.timeout")), capActs(again()));
    default: return capFrag(capErr(t("pres.err.nocreds")), capActs(again()));
  }
}
function presTestHostBody(view) {
  const f = document.createDocumentFragment();
  f.appendChild(capDo(t("pres.t.hostDo")));
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
function presTestReportBody(pc) {
  const when = presTaipei(presSec(pc, "test_order").at);
  const acct = (PRES.info && PRES.info.account) || "—";
  return capFrag(capDo(t("pres.t.reportDo", { when })), presScript(t("pres.script.report", { acct, when })), presP("cx-hint", t("pres.t.reportHint")),
    capActs(capBtn("btn-fill", t("pres.t.opened"), () => presHost("live"), "pres-probe", PRES.busy || presDown()), capBtn("btn-quiet", t("pres.t.later"), () => cxModalClose(false), "pres-later")));
}
/* 態 → 清單各列(mockup deskSteps):準備(安裝、選憑證)/ 測試環境(三列)/ 正式環境(確認登入、啟動下單程式) */
function presRows(view, pc) {
  const setup = presSec(pc, "setup"), cert = presSec(pc, "cert"), worker = presSec(pc, "worker");
  const nm = PRES.sent && Date.now() - PRES.sent.at >= PRES_NO_MOVE_MS ? capFrag(capDo(t("pres.noMove")), capActs(capBtn("btn-out", t("pres.retry"), () => { const s = PRES.sent.step; PRES.sent = null; if (s === "cert") { PRES.recert = true; presPaint(); } else presStep(s); }, "pres-nomove"))) : null;
  const runRow = (name, right) => (nm ? capRow("cur", name, "", nm) : capRow("run", name, right));
  const ol = trEl("ol", "cap-steps pres-steps"), ph = (k) => { const li = trEl("li", "pres-ph", t(k)); li.setAttribute("aria-hidden", "true"); ol.appendChild(li); };
  const add = (li) => ol.appendChild(li);
  const exp = capDate(cert.not_after), certDone = exp ? t("pres.s.certExp", { date: exp }) : "";
  const env = pc && pc.env === "live" ? "live" : "test", live = env === "live";
  const probe = presSec(pc, "probe"), to = presSec(pc, "test_order");
  // 登入失敗與改密碼:掛在登入那個環境的那一列
  const probeErr = Object.values(PRES_PROBE_VIEW).concat(["NOCREDS"]).indexOf(view.slice(2)) >= 0;
  const errRow = (name) => view === "d-pw" ? capRow("bad", name, "", presPwBody(t("pres.pw.lead")))
    : capRow(view === "d-MAINTENANCE" || view === "d-TRANSIENT" ? "cur" : "bad", name, "", presProbeBody(view, pc));
  ph("pres.ph.prep");
  if (setup.status === "ok") add(capRow("done", t("pres.s.setup")));
  else if (view === "d-setup-fail") add(capRow("bad", t("pres.s.setup"), "", capFrag(capErr(t("pres.s.setupFail")), capActs(capBtn("btn-out", t("pres.retry"), () => presStep("setup"), "pres-retry", PRES.busy)))));
  else add(runRow(t("pres.s.setup"), t("pres.s.setupRun")));
  const certNow = view === "d-cert" || view === "d-cert-err";
  if (view === "d-cert-run") add(runRow(t("pres.s.cert"), t("pres.s.certRun")));
  else if (certNow) add(capRow(view === "d-cert-err" ? "bad" : "cur", t("pres.s.cert"), "", presCertBody(pc, view)));
  else add(capRow(cert.status === "ok" ? "done" : "todo", t("pres.s.cert"), cert.status === "ok" ? certDone : ""));
  ph("pres.ph.test");
  const tProbed = live || (probe.status === "ok" && probe.env === "test") || to.status === "ok" || to.status === "failed";
  if (view === "d-t-host") add(capRow("cur", t("pres.s.tprobe"), "", presTestHostBody(view)));
  else if (view === "d-t-probe") add(runRow(t("pres.s.tprobe"), t("pres.s.probeRun")));
  else if (!live && (probeErr || view === "d-pw")) add(errRow(t("pres.s.tprobe")));
  else add(capRow(tProbed ? "done" : "todo", t("pres.s.tprobe"), tProbed ? t("pres.s.tprobeDone") : ""));
  if (view === "d-t-order" || view === "d-t-order-fail") add(capRow(view === "d-t-order-fail" ? "bad" : "cur", t("pres.s.torder"), "", capFrag(capDo(t("pres.t.orderDo")),
    view === "d-t-order-fail" ? capErr(t("pres.t.orderFail")) : null, capActs(capBtn(view === "d-t-order-fail" ? "btn-out" : "btn-fill", t(view === "d-t-order-fail" ? "pres.t.orderAgain" : "pres.t.order"), () => presStep("test_order"), "pres-torder", PRES.busy || presDown())))));
  else if (view === "d-t-order-run") add(runRow(t("pres.s.torder"), t("pres.s.orderRun")));
  else add(capRow(live || to.status === "ok" ? "done" : "todo", t("pres.s.torder"), live || to.status === "ok" ? t("pres.s.torderDone") : ""));
  if (view === "d-t-report") add(capRow("cur", t("pres.s.treport"), "", presTestReportBody(pc)));
  else add(capRow(live ? "done" : "todo", t("pres.s.treport"), live ? t("pres.s.treportDone") : ""));
  ph("pres.ph.live");
  if (view === "d-probe") add(runRow(t("pres.s.probe"), t("pres.s.probeRun")));
  else if (live && (probeErr || view === "d-pw")) add(errRow(t("pres.s.probe")));
  else add(capRow(view === "d-finish" || view === "d-finish-fail" ? "done" : "todo", t("pres.s.probe"), view === "d-finish" || view === "d-finish-fail" ? t("pres.s.probeDone") : ""));
  if (view === "d-finish") add(runRow(t("pres.s.worker"), t("pres.s.workerRun")));
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
function presMsgText(m) {
  if (!m) return null;
  const c = m.code;
  if (c === "BUSY") return t("cap.err.busy");
  if (c === "BAD_ACCOUNT") return t("pres.form.acctErr");
  if (c === "NO_SEAL") return t("pres.err.noSeal");
  if (c === "DAEMON_DOWN" || c === "TIMEOUT") return t("side.stopped");
  if (c === "REBOUND" || c === "NO_CREDS") return t("pres.err.rebound");
  if (PRES_PFX_ERR[c]) return null;   // 畫在欄位下
  return t("pres.err.generic");
}

// 腳:事前準備 / 表單 = 取消 + 下一步;清單 = 關閉;完成 = 設定策略下單(關框)
function presFoot(view) {
  const go = $("cx-go"), cancel = $("cx-cancel"), where = $("cx-where");
  where.hidden = true; where.textContent = "";
  const prep = view === "d-prep" || view === "d-prep-none" || view === "d-prep-load" || view === "d-prep-wait";
  const label = view === "d-prep" ? t("pres.next") : view === "d-prep-none" ? t("pres.tcem.open") : view === "d-form" ? (PRES.busy ? t("cx.connecting") : t("pres.form.go"))
    : view === "d-done" ? t("pres.done.go") : view === "d-dual" ? null : null;
  go.hidden = !label;
  if (label && go.textContent.trim() !== label) go.textContent = label;
  cancel.hidden = view === "d-done";
  cancel.textContent = prep || view === "d-form" || view === "d-mac" || view === "d-dual" ? (view === "d-prep-none" ? t("pres.later") : t("del.cancel")) : t("set.close");
  go.classList.toggle("is-busy", view === "d-form" && PRES.busy);
  presSyncGo(view);
}
function presSyncGo(view) {
  const v = view || PRES.view, go = $("cx-go");
  let off = presDown() || PRES.busy;
  if (v === "d-prep") off = off || !PRES.gotMail;
  if (v === "d-form") off = off || !/^[0-9]{11}$/.test(PRES.acct.trim()) || !PRES.pw;
  go.setAttribute("aria-disabled", off ? "true" : "false");
  document.querySelectorAll("#cx-body [data-need]").forEach((b) => { b.setAttribute("aria-disabled", !PRES[b.dataset.need] || PRES.busy || presDown() ? "true" : "false"); });
}
function presPrimary() {
  if ($("cx-go").getAttribute("aria-disabled") === "true") return;
  const v = PRES.view;
  if (v === "d-prep") { PRES.phase = "form"; presWatch(false); return presPaint(); }
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
  $("cx-title").textContent = view === "d-mac" || view === "d-dual" || view.indexOf("d-prep") === 0 || view === "d-form" ? t("pres.title") : t("pres.title");
  $("cx-modal").querySelector(".modal-head").classList.remove("cloud");
  $("cx-env").hidden = false; $("cx-env").textContent = t("env.local");
  presFoot(view);
  box.setAttribute("aria-busy", PRES.busy || ["d-finish", "d-probe", "d-cert-run", "d-setup", "d-t-probe", "d-t-order-run"].indexOf(view) >= 0 ? "true" : "false");
  const sig = LANG + "|" + JSON.stringify([view, pc, PRES.scan, PRES.busy, PRES.msg, PRES.source, PRES.tcemMsg, PRES.unlockUsed, PRES.test, PRES.info,
    PRES.sent && Date.now() - PRES.sent.at >= PRES_NO_MOVE_MS, presDown(), presReport() && presReport().account]);
  if (PRES.sig === sig && box.firstChild) return;
  PRES.sig = sig;
  const hadId = box.contains(document.activeElement) ? document.activeElement.id : null;
  box.textContent = "";
  if (view === "d-mac") { box.appendChild(cxVenueField(TR_BAGS.local)); box.append(presP("cap-lead", t("pres.mac.lead")), presP("cx-hint", t("pres.mac.hint"))); }
  else if (view === "d-dual") { box.appendChild(cxVenueField(TR_BAGS.local)); box.append(presP("cap-lead", t("pres.dual.lead")), presP("cx-hint", t("pres.dual.hint"))); }
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

/* ── 自動下單頁的兩條橫幅(只在這台電腦視角):憑證 31 天內到期(d-renew)、有統一部位(d-first:電腦不睡、關掉不平倉) ── */
function presBannerPaint() {
  const el = $("pres-banner"); if (!el) return;
  const show = TR.env === "local" && window.blave.platform === "win32";
  const pc = show ? presPC() : null, r = show ? presReport() : null;
  const due = pc ? presRenewDue(pc, Date.now()) : null, lots = r ? presHeldLots(r) : 0;
  const sig = LANG + "|" + JSON.stringify([due, lots, capDate(presSec(pc, "cert").not_after)]);
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig; el.textContent = "";
  el.hidden = due === null && !lots;
  if (lots) {
    const b = trEl("div", "pres-banner"), tx = trEl("div", "");
    tx.append(presP("", t("pres.held.lead", { n: lots })), presP("small", t("pres.held.sub")));
    b.appendChild(tx); el.appendChild(b);
  }
  if (due !== null) {
    const b = trEl("div", "pres-banner"), tx = trEl("div", "");
    tx.append(presP("", due < 0 ? t("pres.renew.expired", { date: capDate(presSec(pc, "cert").not_after) }) : t("pres.renew.lead", { date: capDate(presSec(pc, "cert").not_after), n: due })), presP("small", t("pres.renew.sub")));
    const acts = trEl("div", "cap-acts");
    acts.append(capBtn("btn-fill", t("pres.renew.open"), async () => { try { await window.blave.presidentTcem(); } catch (_) { } }, "pres-renew-open"),
      capBtn("btn-out", t("pres.renew.pause"), () => trRun("halted", [(S) => trSend(S, "halt", { reason: "統一憑證到期前先暫停 / paused before the 統一 certificate expires" })], "halt"), "pres-renew-pause"));
    tx.appendChild(acts); b.appendChild(tx); el.appendChild(b);
  }
}
// 帳戶讀取器的 positions(同主行程 president_local.heldLots)
function presHeldLots(report) {
  const a = report && report.account && report.account.venues && report.account.venues[PRESIDENT];
  const p = a && a.positions && typeof a.positions === "object" ? a.positions : {};
  return Object.keys(p).reduce((n, k) => { const s = p[k] && Number(p[k].size); return n + (isFinite(s) && s > 0 ? Math.round(s) : 0); }, 0);
}
// 設定 › 帳戶 「開通中＋繼續」:帳密存了、下單程式還沒起來
function presWip(r) { const c = r && r.president_connect; return !!c && typeof c === "object" && !(c.worker && c.worker.status === "ok"); }
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
