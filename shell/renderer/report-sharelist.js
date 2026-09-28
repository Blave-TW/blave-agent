/* 設定 › 公開連結(設計:blave-canon output/designer/spec-share-list-0.1.8.md A1 / C / D + mockup-share-list-0.1.8.html)。
   這個帳號所有公開中的報告,兩袋(雲端 / 電腦版)都列;每列:標題(原檔開得了 = 可點)、類型 · 來源 · 公開時間 · 署名、複製連結、取消分享。
   要救的是「報告區已經找不到那一份」:取消只憑代碼(主行程 share-revoke-code),不靠本機檔。
   - 清單、份數、「desktop 袋那一份在不在這台電腦」都由主行程給(憑證只在那裡);每次切到這一類重抓一次。
   - 標題、署名是不可信字串:一律 textContent。公開網址由代碼自己組(shrUrl),不用 api 給的路徑。
   - 分享框的上限那一句(D)也在這裡:shrLimitPaint 由 report-share.js 在開框 / 問到狀態 / 送出被擋時叫。
   用到 app.js 的 $ / t / LANG / confirmBox / srSay / setOpen / setClose / setCat、library.js 的 libEl / libTrack、report-share.js 的 SHR / shrUrl / shrCopy / shrSet / shrFill / shrClose、
   results.js 的 resOpenReport、trade.js 的 ENV / TR_BAGS / envCloudKind / envSwitchGuarded、app.js 的 rpWaitHold——都在呼叫時才取。 */

/* ── 純邏輯(tests/check_shell_share_list.js 從原文切出來跑;這一段不准碰 DOM / i18n)── */
const SHL_FLASH_MS = 1200;
const SHL_KIND_KEYS = { research: "shl.kind.research", morning: "shl.kind.morning", performance: "shl.kind.performance" };
const SHL_SRC_KEYS = { here: "shl.src.here", desktop: "shl.src.desktop", cloud: "shl.src.cloud" };   // 字面寫全:字串閘門(check_shell_strings)只認得完整的 key
// 來源三個值:desktop 袋且這台找得到 = here;desktop 袋找不到 = desktop(被刪或在另一台,分不出來,所以不說「已刪除」);cloud 袋 = cloud
function shlSource(row) { return row.origin === "cloud" ? "cloud" : row.local === true ? "here" : "desktop"; }
// 標題點不點得開。cloudOk = 雲端視角現在有主機在跑(沒登入 / 沒主機 / 停機 → 退成純文字,不加說明行)
function shlOpenable(row, cloudOk) {
  if (typeof row.reportId !== "string" || !row.reportId) return false;
  const src = shlSource(row);
  return src === "here" || (src === "cloud" && row.sourceExists === true && cloudOk === true);
}
// 標題下那一行原因的 key;原檔在 / 只是現在開不了 / api 不知道在不在(sourceExists null)→ null
function shlWhyKey(row) {
  const src = shlSource(row);
  return src === "desktop" ? "shl.gone" : src === "cloud" && row.sourceExists === false ? "shl.goneCloud" : null;
}
// 公開時間 MM/DD HH:mm;不是今年的加年份 YYYY/MM/DD HH:mm(本機時區)
function shlFmtTime(sec, nowMs) {
  if (typeof sec !== "number" || !isFinite(sec)) return "";
  const d = new Date(sec * 1000), p = (n) => (n < 10 ? "0" + n : String(n));
  if (isNaN(d.getTime())) return "";
  const md = p(d.getMonth() + 1) + "/" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  return d.getFullYear() === new Date(nowMs).getFullYear() ? md : d.getFullYear() + "/" + md;
}
/* 開分享框時已經知道滿了沒有(share/state 帶的四個數)。回 { kind: "live"|"daily", n } 或 null。
   「更新公開版本」不佔份數:50 份上限不擋更新;每日次數含更新,兩種都擋。數字沒給(舊 api)= 不擋,送出時 api 再守。
   兩個都滿先講每日(同 web limitOf 與 api):今天的次數用完,撤幾份也公開不了,叫人去撤是白做工 */
function shlLimit(limits, mode) {
  const L = limits && typeof limits === "object" ? limits : {};
  const full = (n, max) => typeof n === "number" && typeof max === "number" && max > 0 && n >= max;
  if (full(L.todayCount, L.dailyLimit)) return { kind: "daily", n: L.dailyLimit };
  if (mode !== "update" && full(L.liveCount, L.liveLimit)) return { kind: "live", n: L.liveLimit };
  return null;
}
// 送出時才被擋(api 的 LIVE_LIMIT / DAILY_LIMIT)→ 同一個形狀;數字沒給就拿開框時問到的上限
function shlLimitFromCode(code, limit, limits) {
  const L = limits && typeof limits === "object" ? limits : {};
  if (code === "LIVE_LIMIT") return { kind: "live", n: typeof limit === "number" ? limit : L.liveLimit };
  if (code === "DAILY_LIMIT") return { kind: "daily", n: typeof limit === "number" ? limit : L.dailyLimit };
  return null;
}
/* ── 純邏輯到此 ── */

const SHL = { seq: 0, rows: null, limits: null, view: "idle" };   // view:idle / skel / list / empty / fail / gate / relogin

/* ── 設定 › 公開連結 ─────────────────────────────────── */
// app.js 的 setCat 切到這一類時叫:每次重抓(取消分享可能發生在另一台電腦或 web)
function shlOpen() {
  libTrack("share_list_open");
  shlLoad();
}
async function shlLoad() {
  const seq = ++SHL.seq;
  SHL.rows = null; SHL.limits = null; SHL.view = "idle"; shlPaint();
  let shownAt = 0;
  // canon Loader:200ms 內回來不畫骨架;畫了至少留 300ms(同 rptLoad)
  const timer = setTimeout(() => { if (SHL.seq !== seq) return; SHL.view = "skel"; shownAt = Date.now(); shlPaint(); }, 200);
  let r = null;
  try { r = await window.blave.shareList(); } catch (_) { r = null; }
  if (SHL.seq !== seq) return;
  clearTimeout(timer);
  if (shownAt) {
    const hold = typeof rpWaitHold === "function" ? rpWaitHold(shownAt, Date.now()) : 0;
    if (hold) { await new Promise((res) => setTimeout(res, hold)); if (SHL.seq !== seq) return; }
  }
  const code = r && r.code;
  if (code === "OK" && Array.isArray(r.shares)) {
    SHL.rows = r.shares.slice().sort((a, b) => b.published_at - a.published_at);   // 公開時間新到舊
    SHL.limits = r.limits || null;
    SHL.view = SHL.rows.length ? "list" : "empty";
  } else SHL.view = code === "NO_LOGIN" ? "gate" : code === "RELOGIN" ? "relogin" : "fail";
  shlPaint();
}
const shlCloudOk = () => typeof TR_BAGS !== "undefined" && typeof envCloudKind === "function" && envCloudKind(TR_BAGS.cloud.st) === "running";
function shlPaint() {
  const box = $("set-shares"); if (!box) return;
  box.textContent = "";
  const head = libEl("div", "shl-head");
  head.appendChild(libEl("h6", "set-gl", t("shl.title")));
  if (SHL.view === "list") head.appendChild(shlCount());
  box.appendChild(head);
  if (SHL.view === "skel") { [[82, 54], [64, 48], [74, 57]].forEach((w) => { const r = libEl("div", "shl-sk"), a = libEl("span", "sk"), b = libEl("span", "sk s"); a.style.width = w[0] + "%"; b.style.width = w[1] + "%"; r.append(a, b); box.appendChild(r); }); return; }
  if (SHL.view === "empty") { box.appendChild(libEl("p", "shl-msg q", t("shl.empty"))); return; }
  if (SHL.view === "fail" || SHL.view === "gate" || SHL.view === "relogin") {
    const row = libEl("div", "shl-msgrow");
    if (SHL.view !== "gate") { const m = libEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); row.appendChild(m); }
    row.appendChild(libEl("p", "shl-msg", t(SHL.view === "fail" ? "shl.loadFail" : SHL.view === "gate" ? "shl.gate" : "conn.expired")));
    const b = libEl("button", "btn-out", t(SHL.view === "fail" ? "br.reload" : "cn.blave.btn")); b.type = "button";
    b.addEventListener("click", SHL.view === "fail" ? shlLoad : shlToAcct);
    row.appendChild(b); box.appendChild(row);
    return;
  }
  if (SHL.view !== "list") return;
  const ul = libEl("ul", "shl-rows"), cloudOk = shlCloudOk(), now = Date.now();
  SHL.rows.forEach((row) => ul.appendChild(shlRow(row, cloudOk, now)));
  box.appendChild(ul);
}
// 畫面上只有「N／50」;可及名稱是整句
function shlCount() {
  const L = SHL.limits || {}, n = SHL.rows.length, max = typeof L.liveLimit === "number" ? L.liveLimit : null;
  const c = libEl("span", "shl-count");
  if (max == null) { c.appendChild(libEl("b", "mono", String(n))); return c; }
  shrFill(c, t("shl.count"), { n: String(n), max: String(max) });
  c.firstElementChild.classList.add("n");
  c.setAttribute("role", "img"); c.setAttribute("aria-label", t("shl.countAria", { n: String(n), max: String(max) }));
  return c;
}
function shlRow(row, cloudOk, now) {
  const li = libEl("li", "shl-row"), left = libEl("div", "shl-left"), acts = libEl("div", "shl-acts");
  const title = row.title || row.code;
  let name;
  if (shlOpenable(row, cloudOk)) { name = libEl("button", "shl-name", title); name.type = "button"; name.addEventListener("click", () => shlGo(row)); }
  else name = libEl("span", "shl-name", title);
  name.title = title;
  const sub = libEl("div", "shl-sub"), sep = () => sub.append(" · ");
  if (Object.prototype.hasOwnProperty.call(SHL_KIND_KEYS, row.type)) { sub.append(t(SHL_KIND_KEYS[row.type])); sep(); }
  sub.append(t(SHL_SRC_KEYS[shlSource(row)])); sep();
  sub.appendChild(libEl("span", "mono", shlFmtTime(row.published_at, now) || "—")); sep();
  sub.append(row.byline || t("shr.anon"));
  left.append(name, sub);
  const why = shlWhyKey(row);
  if (why) left.appendChild(libEl("div", "shl-gone", t(why)));
  const copy = libEl("button", "btn-out", t("shr.copy")); copy.type = "button";
  copy.addEventListener("click", () => shrCopy(shrUrl(LANG, row.code)).then((ok) => { if (ok) { shlFlash(copy); libTrack("share_copy"); } }));
  const off = libEl("button", "btn-quiet", t("shr.revoke")); off.type = "button"; off.setAttribute("aria-haspopup", "dialog");
  off.addEventListener("click", () => shlRevokeAsk(row, off));
  acts.append(copy, off);
  li.append(left, acts);
  return li;
}
// 鈕字換「已複製」1.2 秒:先鎖原寬(字變短鈕不縮、旁邊那顆不位移),讀屏念一次
function shlFlash(btn) {
  clearTimeout(btn._shlT);
  if (!btn.style.minWidth) btn.style.minWidth = btn.offsetWidth + "px";
  btn.textContent = t("shr.copied"); srSay(t("shr.copied"));
  btn._shlT = setTimeout(() => { if (btn.isConnected) btn.textContent = t("shr.copy"); }, SHL_FLASH_MS);
}
function shlToAcct() { setCat("plan"); const c = document.querySelector('.set-cat[data-set-cat="plan"]'); if (c) c.focus(); }
// 標題 = 打開那份報告:關設定、切到那一袋的視角、開閱讀頁。按了才發現不在 → 念一句(清單下次打開會更新)
async function shlGo(row) {
  const env = shlSource(row) === "cloud" ? "cloud" : "local";
  setClose();
  const now = typeof ENV !== "undefined" ? ENV.cur : "local";
  if (env !== now && !envSwitchGuarded(env)) return;
  const r = await resOpenReport({ env, ref: row.reportId });
  if (r === false) srSay(t("res.gone.report"));
}
/* 取消確認(C):字逐字沿用閱讀頁的取消框,只在內文第一行加被取消那份的標題(清單上一次看到多列,要能確認按的是哪一份) */
function shlRevokeAsk(row, opener) {
  const lead = libEl("p", "shl-cf-title", row.title || row.code);
  confirmBox({ title: t("shr.revokeTitle"), lead, lines: [t("shr.revokeBody")], ok: t("shr.revokeOk"), cancel: t("shr.keep"), opener, onOk: async () => {
    let r = null;
    try { r = await window.blave.shareRevokeCode(row.code); } catch (_) { r = null; }
    const code = r && r.code;
    if (code === "OK" || code === "NOT_PUBLIC") {   // NOT_PUBLIC:別處已經取消了,結果一樣
      if (code === "OK") libTrack("share_revoke");
      shlDrop(row);
      return;
    }
    const back = opener.isConnected ? opener : document.querySelector('.set-cat[data-set-cat="shares"]');
    confirmBox({ title: t("shr.revokeFailTitle"), lines: [t(code === "RELOGIN" ? "conn.expired" : "shr.revokeFailBody")], ok: t("cdel.gotIt"), single: true, opener: back, onOk: () => {} });   // 標題寫結果,不再是問句
  } });
}
function shlDrop(row) {
  if (SHL.rows) SHL.rows = SHL.rows.filter((x) => x.code !== row.code);
  if (SHL.rows && !SHL.rows.length) SHL.view = "empty";
  if (!$("set-shares").hidden) shlPaint();
  srSay(t("shl.revoked"));
  // 閱讀頁正開著同一份:公開列同步收起
  if (typeof SHR !== "undefined" && SHR.cur && SHR.cur.share && SHR.cur.share.code === row.code) shrSet(SHR.cur, null);
  const c = document.querySelector('.set-cat[data-set-cat="shares"]'); if (c && !$("set-scrim").hidden) c.focus();   // 那一列沒了:焦點回分類鈕
}

/* ── 分享框:達上限(D)──────────────────────────────── */
// D = report-share.js 的那一趟;D.limit 有值 = 主鈕停用(shrLock 與勾選的 handler 都看它),那一句放在鈕正上方的訊息槽
function shrLimitPaint(D) {
  const fm = $("shr-msg"), send = $("shr-send");
  if (!D.limit) {
    if (D.limitShown) { fm.textContent = ""; D.limitShown = false; }
    if (!D.hint) send.removeAttribute("aria-describedby");   // 上一趟開框留下的也收掉;捲動提示(report-share.js shrHint)掛著的不動
    return;
  }
  fm.textContent = ""; fm.classList.remove("is-hint"); D.limitShown = true; D.hint = false;
  const n = typeof D.limit.n === "number" ? String(D.limit.n) : "";
  shrFill(fm, t(D.limit.kind === "live" ? "shr.limitLive" : "shr.limitDaily"), { n });
  if (D.limit.kind === "live") {   // 50 份那句帶出口;每日那句沒有補救動作,只講什麼時候能再試
    const go = libEl("button", "btn-quiet", t("shr.limitLiveGo")); go.type = "button";
    go.addEventListener("click", shrLimitGo);
    fm.append(" ", go);
  }
  send.disabled = true; send.setAttribute("aria-describedby", "shr-msg");
}
function shrLimitGo() {
  const D = SHR.dlg; if (D) D.opener = null;
  shrClose();
  setOpen().then(() => { setCat("shares"); const c = document.querySelector('.set-cat[data-set-cat="shares"]'); if (c) c.focus(); });
}
