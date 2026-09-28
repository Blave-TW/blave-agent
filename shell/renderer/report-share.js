/* 報告公開分享(設計:blave-canon output/designer/spec-share-0.1.8.md DT1–DT5 + mockup-share-0.1.8.html;契約 docs/report-sharing.md)。
   閱讀層頁首右側「分享」(#rpt-share)→ 確認框(#shr-scrim,.set-modal 640)→ 公開中的那一列(.shr-well,#rpt-read 最上方,會跟內容一起捲)。
   - 本機報告 = 主行程讀 reports/<id>.json 與圖、上傳成不可變快照;雲端視角 = 平台上已有的那份(同 web 的 share 端點)。
     憑證、聲明版本、條款版本都只在主行程(shell/reportshare.js);這裡只送 view / id / 掛名二選一 / 有沒有勾。
   - 公開狀態每次打開閱讀頁問一次(shrDecorate);問不到照「未公開」畫,api 在按下去時再守。清單列不加「公開」記號(拍板 5)。
   - 報告標題、lead、api 回的顯示名稱都是不可信字串:一律 textContent。
   reports.js 叫兩個點:rptPaint 叫 shrClear(換頁 / 回清單),rptRender 畫完叫 shrDecorate。
   用到 app.js 的 $ / t / LANG / confirmBox / trapTab / setOpen / setCat、library.js 的 libEl / libTrack、reports.js 的 RPT / rptFmtStamp——都在呼叫時才取。 */

/* ── 純邏輯(tests/check_shell_report_share.js 從原文切出來跑;這一段不准碰 DOM / i18n)── */
const SHR_SITE = "https://blave.org/";
// 本機的「內容已更新」:這台電腦公開的 → 比公開當下那份檔的 mtime(s.local_mtime,主行程記的;同一個鐘)。
// 沒有那筆紀錄(別台電腦公開的)才拿檔案 mtime 比 published_at(api 的鐘):差一分鐘以內不算,寧可漏報公開後一分鐘內的覆寫,
// 也不要因為兩邊的鐘差一點就對剛公開的報告講「agent 更新了這份報告」
const SHR_CLOCK_SLACK_MS = 60 * 1000;
// 類型白名單(= web report_share.js SHAREABLE;契約 §1):不在名單上的(缺 type、未來的新類型)不出現入口,也不做 disabled
const SHR_TYPES = ["research", "morning", "performance"];
function shrKind(type) { return SHR_TYPES.indexOf(type) >= 0 ? type : null; }
function shrGate(rep) { return !!rep && typeof rep === "object" && !!shrKind(rep.type) && Array.isArray(rep.blocks); }
function shrUrl(lang, code) { return SHR_SITE + (lang === "zh" ? "zh" : "en") + "/r/" + encodeURIComponent(code) + "?src=research_link"; }
// 公開後原報告換過 → { time: 換的時間(秒), day: 公開那一版的時間(秒) };沒換 / 判斷不了 → null
function shrStale(env, s, mtimeMs) {
  if (!s || typeof s.published_at !== "number") return null;
  if (env === "local") {
    if (typeof mtimeMs !== "number") return null;
    const after = typeof s.local_mtime === "number" ? s.local_mtime : s.published_at * 1000 + SHR_CLOCK_SLACK_MS;
    return mtimeMs > after ? { time: Math.floor(mtimeMs / 1000), day: s.published_at } : null;
  }
  // 雲端同 web shareState:兩個都是平台收件時間,同一個鐘
  return typeof s.report_stored_at === "number" && typeof s.source_stored_at === "number" && s.report_stored_at > s.source_stored_at ? { time: s.report_stored_at, day: s.source_stored_at } : null;
}
// og:description 的 lead 首句:與 web report_share.js leadSentence / app/main/research_share.py lead_sentence() 同一條規則
function shrLead(rep, limit) {
  limit = limit || 120;
  const blocks = rep && Array.isArray(rep.blocks) ? rep.blocks : [];
  const lead = blocks.find((b) => b && b.type === "text" && b.variant === "lead") || null;
  let text = String((lead && lead.markdown) || "").replace(/\[\^[A-Za-z0-9_-]+\]/g, "").replace(/[*`#>]/g, "").replace(/^\s*(?:[-+]|\d+\.)\s+/gm, "").replace(/\s+/g, " ").trim();
  const m = /[。！？!?]|\.(?=\s|$)/.exec(text);
  if (m) text = text.slice(0, m.index + m[0].length);
  if (text.length > limit) text = text.slice(0, limit - 1).replace(/\s+$/, "") + "…";
  return text;
}
// 預覽卡的類型詞,一類一組(字面寫全:字串閘門只認得完整的 key)。tag = 固定圖上那一行字;
// performance 的公開頁用不帶類型標籤的預設圖(契約 §4),縮圖照實不畫那一行——專屬圖做出來再把它加進 SHR_OG_LABELLED
const SHR_OG_PREFIX = { research: "shr.ogPrefix.research", morning: "shr.ogPrefix.morning", performance: "shr.ogPrefix.performance" };
const SHR_OG_TAG = { research: "shr.ogTag.research", morning: "shr.ogTag.morning", performance: "shr.ogTag.performance" };
const SHR_OG_LABELLED = ["research", "morning"];
// shr.tooLarge 的 {n} / {mb}:= api 的 LOCAL_IMG_MAX_COUNT 與 LOCAL_IMG_TOTAL_MAX_BYTES(web report_share.js 同兩個數)
const SHR_IMG_MAX_COUNT = 20, SHR_IMG_MAX_MB = 20;
// 主行程的穩定代號 → 腳那一句的 key(NO_DISPLAY_NAME / ALREADY / NOT_PUBLIC / NO_LOGIN 由呼叫端各自處理,不到這裡)
function shrErrKey(code) {
  return code === "RELOGIN" ? "conn.expired" : code === "RATE_LIMITED" ? "shr.rate" : code === "IMAGE_QUOTA" ? "shr.quota"
    : code === "NO_MACHINE" ? "shr.failedCloud" : code === "BAD_CONTENT" ? "shr.badContent" : code === "TOO_LARGE" ? "shr.tooLarge" : code === "NOT_SHAREABLE" || code === "NO_REPORT" || code === "BAD_ARGS" ? "shr.notShareable" : "shr.failed";
}
/* ── 純邏輯到此 ── */

const SHR = { cur: null, dlg: null };   // cur = 閱讀頁上那一份 { env, id, rep, host, share: undefined(還在問)|null|{…}, name };dlg = 確認框開著時的那一趟

/* ── 閱讀頁:入口與公開列 ─────────────────────────────── */
function shrClear() { SHR.cur = null; $("rpt-share").hidden = true; }
function shrDecorate(env, id, rep, host) {
  const c = { env, id, rep, host, share: undefined, name: undefined };
  SHR.cur = c; shrPaint();
  shrAsk(c).then(() => { if (SHR.cur === c) shrPaint(); });
}
// 問一次公開狀態;問不到 → 當「未公開」(spec DT4),名字 = null(署名選項停用)
async function shrAsk(c) {
  let r = null;
  try { r = await window.blave.shareState(c.env, c.id); } catch (_) { r = null; }
  if (r && r.code === "OK") { c.share = r.share || null; c.name = typeof r.displayName === "string" && r.displayName ? r.displayName : null; c.limits = r.limits || null; return r; }
  if (c.share === undefined) c.share = null;
  if (c.name === undefined) c.name = null;
  return r;
}
function shrPaint() {
  const c = SHR.cur;
  if (!c) return;
  const old = c.host.querySelector(":scope > .shr-well"); if (old) old.remove();
  if (c.share === undefined) { $("rpt-share").hidden = true; return; }
  if (c.share) { $("rpt-share").hidden = true; c.host.insertBefore(shrWell(c), c.host.firstChild); return; }
  $("rpt-share").hidden = !shrGate(c.rep);
}
function shrSet(c, share) { c.share = share; if (SHR.cur === c) shrPaint(); }
function shrMtime(c) { const e = c.env === "local" ? (RPT.data.local || []).find((r) => r.id === c.id) : null; return e && typeof e.mtime === "number" ? e.mtime : null; }
// "{time}" 這類佔位換成 mono span(譯文不含 HTML;同 web report_share.js fill)
function shrFill(parent, tpl, vals) {
  String(tpl).split(/(\{[a-z]+\})/).forEach((part) => {
    const m = /^\{([a-z]+)\}$/.exec(part);
    if (m && Object.prototype.hasOwnProperty.call(vals, m[1])) parent.appendChild(libEl("span", "mono", vals[m[1]]));
    else if (part) parent.appendChild(document.createTextNode(part));
  });
  return parent;
}
function shrWell(c) {
  const s = c.share, url = shrUrl(LANG, s.code), well = libEl("div", "shr-well"), row = libEl("div", "shr-row");
  const u = libEl("span", "shr-url mono", url.replace(/^https:\/\//, "")); u.title = url;
  const copy = libEl("button", "btn-out shr-copy", t("shr.copy")); copy.type = "button";
  copy.addEventListener("click", () => shrCopy(url).then((ok) => { if (!ok) return; shrFlash(copy); libTrack("share_copy"); }));
  const off = libEl("button", "btn-quiet", t("shr.revoke")); off.type = "button"; off.setAttribute("aria-haspopup", "dialog");
  off.addEventListener("click", () => shrRevokeAsk(c, off));
  row.append(libEl("span", "shr-tag", t("shr.live")), u, copy, off);
  well.appendChild(row);
  well.appendChild(shrFill(libEl("div", "shr-sub"), t("shr.version"), { time: rptFmtStamp(s.published_at) }));
  const st = shrStale(c.env, s, shrMtime(c));
  if (st) {
    const box = libEl("div", "shr-stale");
    box.appendChild(shrFill(libEl("span", "t"), t("shr.stale"), { time: rptFmtStamp(st.time), day: rptFmtStamp(st.day).slice(0, 5) }));
    // 同 id 被覆寫成不在白名單上的類型:更新一定被 422,只留提示與取消分享(同 web)
    if (shrGate(c.rep)) {
      const upd = libEl("button", "btn-out", t("shr.updateCheck")); upd.type = "button"; upd.setAttribute("aria-haspopup", "dialog");
      upd.addEventListener("click", () => shrOpen(c, "update", upd));
      box.appendChild(upd);
    }
    well.appendChild(box);
  }
  return well;
}
async function shrCopy(text) { try { await navigator.clipboard.writeText(text); return true; } catch (_) { return false; } }
function shrFlash(btn) {
  clearTimeout(btn._shrT); btn.textContent = t("shr.copied");
  btn._shrT = setTimeout(() => { if (btn.isConnected) btn.textContent = t("shr.copy"); }, 1500);
}
function shrFocusWell(c) { const b = c.host.querySelector(":scope > .shr-well .shr-copy"); if (b) b.focus(); }
function shrRevokeAsk(c, opener) {
  confirmBox({ title: t("shr.revokeTitle"), lines: [t("shr.revokeBody")], ok: t("shr.revokeOk"), cancel: t("shr.keep"), opener, env: c.env, onOk: async () => {
    let r = null;
    try { r = await window.blave.shareRevoke(c.env, c.id); } catch (_) { r = null; }
    const code = r && r.code;
    if (code === "OK" || code === "NOT_PUBLIC") {   // NOT_PUBLIC:別處已經取消了,結果一樣
      if (code === "OK") libTrack("share_revoke");
      shrSet(c, null);
      if (SHR.cur === c && !$("rpt-share").hidden) $("rpt-share").focus();
      return;
    }
    confirmBox({ title: t("shr.revokeFailTitle"), lines: [t(code === "RELOGIN" ? "conn.expired" : "shr.revokeFailBody")], ok: t("cdel.gotIt"), single: true, env: c.env, opener: opener.isConnected ? opener : $("rpt-back"), onOk: () => {} });   // 標題寫結果,不再是問句
  } });
}
// 未登入(只會發生在本機視角):鈕照出、按下才守門;主鈕開設定 › 帳號與方案,不做登入後自動續走(spec DT3)
function shrGateAsk(opener) {
  confirmBox({ title: t("shr.dlgTitle"), lines: [t("shr.gate")], ok: t("shr.gateGo"), opener, onOk: () => setOpen().then(() => setCat("plan")) });
}

/* ── 確認框(DT2)────────────────────────────────────── */
function shrOpen(c, mode, opener) {
  if (!shrGate(c.rep)) return;
  if (!$("shr-scrim").hidden || (typeof envCanSwitch === "function" && !envCanSwitch())) return;   // 別的框開著 / 選字中
  if (c.env === "local" && !hasToken) { shrGateAsk(opener); return; }
  const rep = c.rep, meta = rep.blocks[0] && rep.blocks[0].type === "meta" ? rep.blocks[0] : {}, kind = shrKind(rep.type);
  // limit = 已達上限(report-sharelist.js):主鈕停用;said = 訊息槽裡是失敗句;ackSeen = 勾選列整列在捲動區看得見
  const D = { c, mode, opener, busy: false, noName: false, limit: shlLimit(c.limits, mode), limitShown: false, said: false, hint: false, ackSeen: true, io: null };
  SHR.dlg = D;
  $("shr-title").textContent = t(mode === "update" ? "shr.dlgTitleUpdate" : "shr.dlgTitle");
  // 雲端視角:灰標題列 + 「雲端」記號(同 #rpn-modal);公開與更新是同一個框
  const cloud = c.env === "cloud";
  $("shr-modal").querySelector(".modal-head").classList.toggle("cloud", cloud);
  $("shr-env").hidden = !cloud; $("shr-env").textContent = cloud ? t("env.cloud") : "";
  $("shr-same").hidden = mode !== "update";
  $("shr-og-tag").textContent = t(SHR_OG_TAG[kind]); $("shr-og-tag").hidden = SHR_OG_LABELLED.indexOf(kind) < 0;
  $("shr-tt").textContent = t(SHR_OG_PREFIX[kind]) + String(meta.title || rep.title || "");
  $("shr-ds").textContent = shrLead(rep);
  $("shr-perf").hidden = kind !== "performance";   // 公開與更新兩種模式都出
  $("shr-must").textContent = t(c.env === "local" ? "shr.noteLocal" : "shr.noteCloud");
  $("shr-anon").checked = true; $("shr-ack").checked = false;
  $("shr-send").textContent = t(mode === "update" ? "shr.sendUpdate" : "shr.send");
  $("shr-msg").textContent = ""; $("shr-msg").classList.remove("is-hint");
  shrLock(false); shrName(D); shrLimitPaint(D);
  // 名字與上限開框時再向 api 抓一次(改名、別處公開 / 取消之後回來不必重開閱讀頁)
  shrAsk(c).then(() => { if (SHR.dlg !== D) return; shrName(D); if (!D.busy) { D.limit = shlLimit(c.limits, mode); shrLock(false); shrLimitPaint(D); shrHint(); } });
  $("view-ws").inert = true; $("set-scrim").inert = true;
  const sc = $("shr-scrim"); sc.hidden = false;
  requestAnimationFrame(() => sc.classList.add("open"));
  ($("shr-radios").hidden ? $("shr-ack") : $("shr-anon")).focus();
  // 勾選列有沒有完整落在捲動區內(同 web syncHint;0.99 是給次像素的餘裕)
  D.io = new IntersectionObserver((es) => { if (SHR.dlg !== D) return; D.ackSeen = es[es.length - 1].intersectionRatio >= 0.99; shrHint(); }, { root: $("shr-modal").querySelector(".modal-body"), threshold: [0, 0.99, 1] });
  D.io.observe($("shr-ack").closest(".shr-chk"));
}
// 勾選在捲動區外又還沒勾:主鈕停用的原因只剩這一句講得出來。訊息槽只有一個,送出中、失敗句、上限句優先
function shrHint() {
  const D = SHR.dlg;
  if (!D || D.busy || D.said || D.limit) return;
  const fm = $("shr-msg"), on = !$("shr-ack").checked && !D.ackSeen;
  if (on) { fm.textContent = t("shr.scrollHint"); $("shr-send").setAttribute("aria-describedby", "shr-msg"); }
  else if (D.hint) { fm.textContent = ""; $("shr-send").removeAttribute("aria-describedby"); }
  fm.classList.toggle("is-hint", on); D.hint = on;
}
// 帳號的名稱原樣掛(系統預設名、含推薦碼的名稱都照用;契約 §3),名稱是空的(或讀不到 / api 回 NO_DISPLAY_NAME)才沒有選項可選:
// 兩顆 radio 整組收掉,換成純文字「作者 匿名」(同 web setPlain);提示換成去填名稱那句。有名字才出兩顆 radio
function shrName(D) {
  const name = D.noName ? null : D.c.name;
  const on = typeof name === "string" && !!name;
  const moved = !on && $("shr-radios").contains(document.activeElement);
  $("shr-nm").textContent = on ? name : "";
  $("shr-named").disabled = !on;   // 收起來的那顆不可能被送出(shrSubmit 看 disabled)
  if (!on) $("shr-anon").checked = true;
  $("shr-radios").hidden = !on; $("shr-anon-only").hidden = on;
  $("shr-hint").textContent = t(on ? "shr.nameHint" : "shr.noName");
  if (moved) $("shr-ack").focus();
}
// 送出中:取消 / ✕ / 主鈕都停用(上傳含圖可能要幾秒,不能讓人以為沒按到;同 rptNewLock)
function shrLock(on) {
  $("shr-cancel").disabled = on; $("shr-close").disabled = on;
  $("shr-send").disabled = on || !$("shr-ack").checked || !!(SHR.dlg && SHR.dlg.limit);
}
function shrClose() {
  const sc = $("shr-scrim"), D = SHR.dlg;
  if (sc.hidden || (D && D.busy)) return;
  sc.classList.remove("open"); sc.hidden = true;
  if (D && D.io) { D.io.disconnect(); D.io = null; }
  $("view-ws").inert = false; $("set-scrim").inert = false;
  SHR.dlg = null;
  const o = D && D.opener;
  if (o && o.isConnected && o.offsetParent && !o.disabled) o.focus(); else if ($("rpt-back").offsetParent) $("rpt-back").focus();
}
async function shrSubmit() {
  const D = SHR.dlg;
  if (!D || D.busy || D.limit || !$("shr-ack").checked) return;
  const c = D.c, byline = !$("shr-named").disabled && $("shr-named").checked ? "name" : "anonymous";
  D.busy = true; D.said = false; D.hint = false; shrLock(true);
  $("shr-send").removeAttribute("aria-describedby");
  const fm = $("shr-msg"), busy = libEl("span", "cf-busy"), sp = libEl("span", "spin16"); sp.setAttribute("aria-hidden", "true");
  busy.append(sp, t("shr.sending")); fm.textContent = ""; fm.classList.remove("is-hint"); fm.appendChild(busy);
  let r = null;
  try { r = await window.blave.sharePublish(c.env, c.id, { byline, confirmed: true, update: D.mode === "update" }); } catch (_) { r = null; }
  D.busy = false;
  if (SHR.dlg !== D) return;
  shrLock(false); fm.textContent = "";
  const code = r && r.code;
  if (code === "OK" && r.share) {
    libTrack("share_publish");
    D.opener = null; shrClose();
    shrCopy(shrUrl(LANG, r.share.code));
    shrSet(c, r.share); shrFocusWell(c);
    return;
  }
  if (code === "ALREADY" || code === "NOT_PUBLIC") {   // 別處公開過 / 別處取消了:重問一次,換成那個狀態
    D.opener = null; shrClose();
    shrAsk(c).then(() => { if (SHR.cur === c) shrPaint(); });
    return;
  }
  if (code === "NO_DISPLAY_NAME") { D.noName = true; shrName(D); shrHint(); return; }   // 名字 api 不收:只剩匿名,勾選保留、可直接再送
  if (code === "NO_LOGIN") { D.opener = null; shrClose(); shrGateAsk($("rpt-share")); return; }
  // 送出時才撞到上限(開框之後別處又公開了):同一句放同一個位置,框留著
  const lim = shlLimitFromCode(code, r && r.limit, c.limits);
  if (lim) { D.limit = lim; shrLimitPaint(D); return; }
  D.said = true;
  shrFill(fm, t(shrErrKey(code)), { n: String(SHR_IMG_MAX_COUNT), mb: String(SHR_IMG_MAX_MB) });   // 框留著、欄位不動,原樣重送。api 的原文不上畫面:主行程寫進 log(reportshare.js failDetail)
}

/* ── 接線(這支比 app.js 先載:只用 getElementById;handler 裡的才在點擊時取)── */
(function shrWire() {
  const g = (id) => document.getElementById(id);
  g("rpt-share").addEventListener("click", () => { if (SHR.cur) shrOpen(SHR.cur, "new", g("rpt-share")); });
  g("shr-modal").addEventListener("submit", (e) => { e.preventDefault(); shrSubmit(); });   // CSP form-action 'none':原生送出一律擋
  g("shr-ack").addEventListener("change", () => { g("shr-send").disabled = !g("shr-ack").checked || !!(SHR.dlg && (SHR.dlg.busy || SHR.dlg.limit)); shrHint(); });
  g("shr-cancel").addEventListener("click", shrClose);
  g("shr-close").addEventListener("click", shrClose);
  g("shr-tos").addEventListener("click", () => window.blave.openExternal(SHR_SITE + "disclaimer/" + (LANG === "zh" ? "zh" : "en") + "/terms_of_service#ugc"));
  g("shr-scrim").addEventListener("mousedown", (e) => { if (e.target === g("shr-scrim")) shrClose(); });
  g("shr-scrim").addEventListener("keydown", (e) => trapTab(e, g("shr-modal")));
})();
