/* 群益本機開通 — 憑證那一段(電腦版 Windows;設計 output/designer/capital-new-cert-2026-10/spec.md + mockup.html,
   spec output/specs/desktop-capital-new-cert-2026-10-20.md,Wei 10-20 全部拍板)。
   連接交易所框(#cx-scrim,trade.js)在「這台電腦」視角選到群益時,整個框交給這個檔畫:找憑證 →(沒有)申請新憑證或匯入 pfx → 帳密。
   - 順序對齊統一本機(president.js):先找憑證,找到就直接到帳密;沒有才分兩條路(pres-seg)、選了才展開,主鈕在腳。
   - 精靈開著時每 3 秒問主行程一次(capital_local.js):出現開精靈前沒有的那一張、私鑰用得了 → 帳密。app 只替用戶打開群益的精靈。
   - 撤銷提醒與雲端提醒(雲端主機已連群益,Wei 拍 A:不擋、只提醒)共用 #cx-where 那一格。系統地區不是繁中:沒有主鈕,
     腳左側 quiet「還是要開」。地區設定的選單名照 Windows 的顯示語言(主行程回 names),不照 Blave 的語言。
   - 帳密表單、開通清單、刪舊證是下一段(還沒做):這一段走到「找到群益憑證，到期…」那一句為止,整個入口受 trade.js CAPL_LOCAL_ON 管。
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
const CAPL_FEATURE = { have: "capl_have_cert", wiz: "capl_wiz_open", anyway: "capl_wiz_anyway", fresh: "capl_cert_new" };
// 主行程開精靈失敗的代號 → 畫面的 err
const CAPL_WIZ_ERR = { DOWNLOAD: "dl", SIG: "sig", START: "launch", BUSY: "busy" };
const CAPL_ERR_KEY = { dl: "capl.errDl", sig: "capl.errSig", launch: "capl.errLaunch", busy: "capl.busy" };
const CAPL_PFX_ERR = { PFX_PASSWORD: "cap.pfx.errPw", PFX_INVALID: "cap.pfx.errFile", PFX_TOO_LARGE: "cap.pfx.errFile", PFX_NOT_CAPITAL: "cap.pfx.errIssuer",
  PFX_EXPIRED: "cap.pfx.errExpired", PFX_OLDER: "capl.errOlder", READ_FAILED: "cap.pfx.errRead", IMPORT_FAILED: "cap.pfx.errImport" };

/* choice = 找不到 / 過期那一頁選的路:"new"(申請新憑證)/ "renew"(展延;過期頁的預設)/ "have"(匯入別台匯出的檔)/ null(還沒選)。
   wiz = 精靈開著(主行程說的);err = 開精靈那一下的失敗(dl / sig / launch / busy);done = 找到能用的那張的到期日(→ 帳密);
   nokey = 新的那張進庫了、但這個 Windows 帳號用不了私鑰(F10:不給再申請——再申請會再撤銷一次);cloud = 開框那一刻雲端主機已連群益 */
const caplBlank = () => ({ started: false, scan: null, loc: null, cloud: false, choice: null, wiz: false, err: null, picked: false, ppw: "",
  pfxErr: null, done: null, nokey: false, busy: false, seen: {}, sig: null, view: null });
let CAPL = caplBlank();
let caplTimer = null;

/* ── 純邏輯(tests/check_shell_capital_local_view.js 從原文切出來跑;這一段不准碰 DOM)── */
const CAPL_ERR_VIEW = { dl: "l-err-dl", sig: "l-err-sig", launch: "l-err-launch" };
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
const CAPL_APPLY = ["l-cert-new", "l-cloud-warn", "l-err-dl", "l-err-sig", "l-err-launch", "l-cert-expired", "l-cert-expired-cloud"];
const CAPL_LOCALE = ["l-locale", "l-cert-expired-locale"];
function caplFootSpec(view, ui) {
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
/* ── 純邏輯到此 ── */

const caplCtx = () => ({ win: window.blave.platform === "win32" });
function caplTrack(k) { if (CAPL_FEATURE[k] && !CAPL.seen[k]) { CAPL.seen[k] = true; trackFeature(CAPL_FEATURE[k]); } }
function caplForget() {
  CAPL = caplBlank();
  caplWatch(false);
  if (window.blave && typeof window.blave.caplForget === "function") window.blave.caplForget().catch(() => {});
}
async function caplStart() {
  CAPL.started = true;
  CAPL.cloud = caplCloudOn(TR_BAGS.cloud.st && TR_BAGS.cloud.st.report);
  let loc = null; try { loc = await window.blave.caplLocale(); } catch (_) { }
  CAPL.loc = loc && loc.code === "OK" ? { ok: loc.ok, names: loc.names === "zh" ? "zh" : "en" } : null;
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
  if (view === "l-form") { f.appendChild(caplWithMono("cap-lead", "capl.found", "date", CAPL.done)); return f; }
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

// 腳:撤銷／雲端提醒在 #cx-where(鈕正上方、佔滿一列);「還是要開」是動態插進去的 quiet 鈕(腳左側),換交易所時 caplFootRestore 拿掉
function caplFoot(view) {
  const s = caplFootSpec(view, CAPL), go = $("cx-go"), cancel = $("cx-cancel"), where = $("cx-where"), foot = go.parentNode;
  where.hidden = !s.msg; where.textContent = s.msg ? t(s.msg === "cloud" ? "capl.cloudWarn" : "capl.revoke") : "";
  where.classList.toggle("is-strong", s.msg === "cloud");
  if (s.msg) where.setAttribute("role", "status"); else where.removeAttribute("role");
  let q = $("capl-anyway");
  if (s.anyway && !q) { q = capBtn("btn-quiet lead", t("capl.anyway"), () => caplOpenWizard(true), "capl-anyway"); foot.insertBefore(q, cancel); }
  else if (!s.anyway && q) q.remove();
  if (q && s.anyway) { q.textContent = t("capl.anyway"); q.disabled = !!CAPL.busy; }
  go.hidden = !s.go;
  if (s.go && go.textContent.trim() !== t(s.go)) go.textContent = t(s.go);
  cancel.hidden = false; cancel.textContent = t(s.cancel);
  go.classList.toggle("is-busy", !!s.go && CAPL.busy);
  caplSyncGo(view);
}
function caplSyncGo(view) {
  const v = view || CAPL.view, go = $("cx-go");
  let off = CAPL.busy;
  if (v === "l-cert-picked" || v === "l-cert-picked-err") off = off || !CAPL.ppw;
  go.setAttribute("aria-disabled", off ? "true" : "false");
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
}

function caplPaint() {
  if ($("cx-scrim").hidden || CXF.venue !== CAPITAL || CXF.env !== "local") return;
  const view = caplView(CAPL, caplCtx());
  CAPL.view = view;
  const box = $("cx-body");
  $("cx-title").textContent = t("cap.title");
  $("cx-modal").querySelector(".modal-head").classList.remove("cloud");
  $("cx-env").hidden = false; $("cx-env").textContent = t("env.local");
  caplFoot(view);
  box.setAttribute("aria-busy", CAPL.busy || view === "l-cert-load" || view === "l-wiz" ? "true" : "false");
  const sig = LANG + "|" + JSON.stringify([view, CAPL.scan, CAPL.loc, CAPL.cloud, CAPL.choice, CAPL.err, CAPL.picked, CAPL.pfxErr, CAPL.done, CAPL.busy]);
  if (CAPL.sig === sig && box.firstChild) return;
  CAPL.sig = sig;
  const hadId = box.contains(document.activeElement) ? document.activeElement.id : null;
  box.textContent = "";
  box.appendChild(caplBody(view));
  caplSyncGo(view);
  const back = hadId && $(hadId);
  if (back && !back.disabled) back.focus();
}
