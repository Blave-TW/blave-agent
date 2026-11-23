/* 主要市場(spec market-pref-2026-11-09):連結畫面第二步、設定 › 一般那一列、各表面的預設。
   值存主行程(mainmarket.js;本機 ui-prefs,登入著同步到帳號),這裡只拿來排預設與順序,不鎖市場。
   第二步:用戶在連結畫面按下會開始連線的鈕(app.js blaveGoNow／localLogin／codexPkgGo 叫 mktStart),或連上了要進工作頁(enterWorkspace 叫 mktHold)
   而這個安裝還要問、也還沒有值,同一張卡就換成四格＋跳過;連上而且答了才進。登入、下載失敗或取消回第一步(mktBack),答過的值留著。
   接線:app.js enterWorkspace／blaveGoNow／localLogin／connectNow／paintRows／waitChanged／applyStatic／codexPkgOnState、
   library.js libMktPick、welcome.js wcPaint／#wl-seg、trade.js cxVenueField。
   緊接在 i18n.js 後面載入(trade.js／library.js／app.js／welcome.js 執行時讀 MKT);這裡的頂層只綁事件,用到 app.js 的東西都在函式裡 */

/* ── 純邏輯(tests/check_shell_main_market.js 從原文切出來跑;不碰 DOM / i18n)── */
const MKT_VALUES = ["crypto", "twstock", "txf", "usstock"];
// 策略庫的市場選單值(library.js LIB_MARKETS 同一組);all／沒設 → 全部
const mktLibOf = (v) => (MKT_VALUES.includes(v) ? v : "all");
// 歡迎頁資料清單的分段(welcome.js WD_ROWS 的市場欄);沒設停在加密
const mktWdOf = (v) => (v === "twstock" ? "tw" : v === "txf" ? "txf" : v === "usstock" ? "us" : "crypto");
// 第二步出不出:這個安裝要問、本機還沒有值(帳號值由主行程對帳寫進本機,已知時已經算在 v 裡)
const mktAsks = (st) => !!st && st.ask === true && !MKT_VALUES.includes(st.v) && st.v !== "all";
// 連接帳戶框:主要市場是台指期時台灣期貨那組排前面,不預選
const mktTwFirst = (v) => v === "txf";
/* ── 純邏輯到此 ── */

const MKT = { v: null, ask: false, on: false, held: null, sent: false, wdUser: false };

function mktSet(st) {
  MKT.v = st && (MKT_VALUES.includes(st.v) || st.v === "all") ? st.v : null;
  MKT.ask = !!(st && st.ask === true);
}
async function mktLoad() {
  try { mktSet(await window.blave.mainMarket()); } catch (_) { /* 讀不到:照現行,不問 */ }
  mktApply();
}
/* 值換了:沒被手動切過的預設跟著換(策略庫兩袋、資料清單分段),設定那一列與歡迎頁的卡重畫 */
function mktApply() {
  const sel = $("set-mkt"); if (sel) sel.value = MKT.v || "all";
  if (typeof LIB !== "undefined") Object.values(LIB.bags).forEach((B) => { if (!B.mktUser) B.mkt = mktLibOf(MKT.v); });
  if (typeof WD !== "undefined" && !MKT.wdUser) WD.mk = mktWdOf(MKT.v);
  if (typeof libRepaint === "function") libRepaint();
  if (typeof wdPaint === "function") wdPaint();
  if (typeof wcPaint === "function") wcPaint();   // ①的卡(指紋帶 MKT.v,值沒變不重建);設定改值時沒有別的路會重畫它
  if (typeof nsRepaint === "function") nsRepaint();   // 新增策略框開著:範例列換成那個市場的三顆(newstrategy.js)
}

/* ── 連結畫面第二步 ── */
function mktShow() {
  if (MKT.on) return mktPaint();
  MKT.on = true;
  $("view-connect").classList.add("is-mkt");
  mktPaint();
  const first = document.querySelector('#cn-mkt .mk-opt[data-mk="crypto"]'); if (first) first.focus();
  if (!MKT.sent) { MKT.sent = true; trackEvent("mkt_q", { act: "shown" }); window.blave.mainMarketSet({ shown: true }).catch(() => {}); }
}
function mktOff() { MKT.on = false; MKT.held = null; $("view-connect").classList.remove("is-mkt"); }
// 連線失敗或取消:回第一步(回 true = 真的回了)。焦點交給呼叫端(那一列的鈕);沒人接的話給 Blave 那顆
function mktBack() {
  if (!MKT.on || MKT.held) return false;   // 已經連上、在等用戶點:別處的失敗(背景補抓 Codex)不把他送回第一步
  mktOff();
  const a = document.activeElement;
  if (!a || a === document.body || $("cn-mkt").contains(a) || a.closest(".cn-foot")) { const b = $("btn-blave"); if (b && !b.hidden) b.focus(); }
  return true;
}
// 按下開始連線的鈕那一刻(只在連結畫面上)
function mktStart() { if (!$("view-connect").hidden && mktAsks(MKT)) mktShow(); }
/* enterWorkspace 進門前:從連結畫面進、還沒答 → 停在第二步等用戶(回 true);其他照進。
   登入著就重問一次帳號:帳號已經有值(換新電腦的老用戶)時主行程對帳寫進本機、推 main-market,這裡收掉第二步直接進 */
function mktHold(kind, info) {
  if ($("view-connect").hidden) return false;
  if (!mktAsks(MKT)) { mktOff(); window.blave.mainMarketSet({ seal: true }).catch(() => {}); return false; }
  MKT.held = { kind, info };
  mktShow();
  if (hasToken) window.blave.accountStatus().catch(() => {});
  return true;
}
function mktGo() {
  const h = MKT.held;
  if (!h) return mktPaint();
  enterWorkspace(h.kind, h.info);
}
function mktPick(v) {
  trackEvent("mkt_q", { act: v === "all" ? "skip" : v });
  mktSet({ v, ask: false });
  window.blave.mainMarketSet({ v, fresh: true }).catch(() => {});
  mktApply();
  mktGo();
}
/* 卡頂那一行:引擎還在連(Blave 等瀏覽器、Claude Code／Codex 等登入、Codex 下載)才出;連上了、等用戶點就拿掉。選中格的按下態只在這段時間看得到 */
function mktPaint() {
  if (!MKT.on) return;
  document.querySelectorAll("#cn-mkt .mk-opt").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mk === MKT.v)));
  const pk = typeof PKG !== "undefined" && PKG.snap && PKG.snap.phase && PKG.snap.phase !== "idle" ? PKG.snap : null;
  const mb = (n) => (Math.max(0, Number(n) || 0) / 1e6).toFixed(1);
  let text = null, cancel = null;
  if (MKT.held) text = null;
  else if (oauthPending) { text = t("row.opened"); cancel = () => window.blave.cancelOAuth(); }
  else if (loginPending) { text = ROWMSG[loginPending] === "opened" ? t("row.opened") : null; cancel = () => window.blave.cancelAgentLogin(); }
  else if (pk) text = pk.phase === "download" ? t("cn.pkgDl", { a: mb(pk.bytes), b: mb(pk.total) }) : t("cn.pkgInstall");
  // 下載進度每 250 ms 推一次:字沒變就不重建(取消鈕的焦點、讀屏不被洗)
  const w = $("cn-mkt-wait"), key = text ? text + "|" + !!cancel : "";
  if (w.dataset.k === key) return;
  w.dataset.k = key; w.textContent = "";
  if (!text) return;
  const sp = document.createElement("span"); sp.className = "spin16"; sp.setAttribute("aria-hidden", "true");
  const tx = document.createElement("span"); tx.textContent = text;
  const gap = document.createElement("span"); gap.className = "sp";
  w.append(sp, tx, gap);
  if (cancel) { const b = document.createElement("button"); b.type = "button"; b.className = "btn-quiet"; b.textContent = t("login.cancel"); b.addEventListener("click", cancel); w.appendChild(b); }
}
document.querySelectorAll("#cn-mkt .mk-opt").forEach((b) => b.addEventListener("click", () => mktPick(b.dataset.mk)));
document.getElementById("cn-mkt-skip").addEventListener("click", () => mktPick("all"));

/* ── 設定 › 一般「主要市場」── */
document.getElementById("set-mkt").addEventListener("change", (e) => {
  const v = e.currentTarget.value;
  if (!(MKT_VALUES.includes(v) || v === "all") || v === MKT.v) return;
  mktSet({ v, ask: false });
  trackEvent("mkt_set", { v });
  window.blave.mainMarketSet({ v }).catch(() => {});
  mktApply();
});
// 主行程對帳改了本機值(帳號在 web 改過、換新電腦登入的老用戶):照換;停在第二步等的那一位直接進
window.blave.onMainMarket((st) => {
  mktSet(st);
  mktApply();
  if (MKT.on && MKT.held && MKT.v) mktGo();
});
