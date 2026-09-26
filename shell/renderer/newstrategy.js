/* 新增策略 modal(設計:blave-canon output/designer/spec-desktop-0.1.6-2026-09-25.md §4;照雲端工作頁 #ns_modal 逐格搬)。
   側欄「策略」標題旁的 ＋ / 歡迎頁的「新增策略」chip → 五格(名稱 / 標的 / 週期 / 指標 / 邏輯)+ 即時預覽句 +「至少填一項」+ 策略庫連結;
   送出 = 把預覽那句(nsCompose,逐字同 web 的 nsCompose)送到對話。不記 pending、不輪詢:回覆本身就在對話裡,策略檔出現在側欄靠既有的 stratRefresh。
   殼同 confirmBox 家族(#del-scrim 的 440 框);雲端視角:標題列灰底 +「雲端」記號 + 腳的目的地句。
   用到 app.js 的 $ / t / LANG / running / csTitle / csStartNew / submitMessage / trapTab / paneSt / paneToggle、trade.js 的 envCanSwitch、
   library.js 的 libEnv / libCloud / libOpen / libTrack / libEl、reports.js 的 rptAskState——都在呼叫時才取。 */

/* ── 純邏輯(tests/check_shell_newstrategy.js 從原文切出來跑;這一段不准碰 DOM / i18n)── */
const NS_FIELDS = ["name", "symbol", "timeframe", "indicators", "logic"];
/* 五格 → 送到對話的那句(逐字照 web nsCompose):zh 全形「」：。、en 半形;空格跳過;全空 → "";邏輯尾端的 。！？ / .!? 先去掉再補。
   f = { name, symbol, timeframe, indicators, logic },s = { lead, symbol, timeframe, indicators, logic, dflt }(字串表的字,由呼叫端代) */
function nsCompose(f, lang, s) {
  const v = (k) => String(f && f[k] != null ? f[k] : "").trim();
  const name = v("name"), sym = v("symbol"), tf = v("timeframe"), ind = v("indicators"), logic = v("logic");
  if (!name && !sym && !tf && !ind && !logic) return "";
  let msg;
  if (lang === "zh") {
    msg = name ? s.lead + "「" + name + "」。" : s.lead + "。";
    if (sym) msg += s.symbol + "：" + sym + "。";
    if (tf) msg += s.timeframe + "：" + tf + "。";
    if (ind) msg += s.indicators + "：" + ind + "。";
    if (logic) msg += s.logic + "：" + logic.replace(/[。！？]+$/, "") + "。";
    msg += s.dflt;
  } else {
    msg = name ? s.lead + ' "' + name + '".' : s.lead + ".";
    if (sym) msg += " " + s.symbol + ": " + sym + ".";
    if (tf) msg += " " + s.timeframe + ": " + tf + ".";
    if (ind) msg += " " + s.indicators + ": " + ind + ".";
    if (logic) msg += " " + s.logic + ": " + logic.replace(/[.!?]+$/, "") + ".";
    msg += " " + s.dflt;
  }
  return msg;
}
/* ── 純邏輯到此 ── */

const NS = { sending: false, opener: null, fail: false };   // fail = 上一次送出失敗:腳那一句留到下次送出 / 關框(讓人原樣重送)
function nsStrings() { return { lead: t("ns.msgLead"), symbol: t("ns.msgSymbol"), timeframe: t("ns.msgTimeframe"), indicators: t("ns.msgIndicators"), logic: t("ns.msgLogic"), dflt: t("ns.msgDefault") }; }
function nsFields() { const f = $("ns-modal"), o = {}; NS_FIELDS.forEach((k) => { const el = f.elements[k]; o[k] = el ? el.value : ""; }); return o; }
// 閘門同「新增報告」的鈕(停機 / 逾時 / 回合中);這個框沒有 pending 態
function nsGate() { const env = libEnv(); return rptAskState({ running: typeof running !== "undefined" && running === true, env, cloud: env === "cloud" ? libCloud() : null, pending: false }); }
// 每次 input 重算(照 web nsRefresh):預覽句、送出鈕 disabled 直到任一格有字、閘門句;送出中 foot-msg 不動
function nsRefresh() {
  const msg = nsCompose(nsFields(), LANG, nsStrings()), pv = $("ns-preview");
  pv.textContent = msg || t("ns.previewEmpty"); pv.classList.toggle("empty", !msg);
  const st = nsGate();
  $("ns-submit").disabled = !msg || NS.sending || st !== "free";
  if (msg) $("ns-submit").removeAttribute("aria-describedby"); else $("ns-submit").setAttribute("aria-describedby", "ns-hint");   // 空表單停用的原因就是頂端那一句;閘門停用的原因在 ns-msg
  if (!NS.sending) $("ns-msg").textContent = st === "busy" ? t("turn.busy") : st === "stopped" ? t("ho.gate.stopped") : st === "stale" ? t("ho.gate.stale") : NS.fail ? t("modal.sendFailed") : "";
}
function nsPaintEnv() {
  const cloud = libEnv() === "cloud";
  $("ns-modal").querySelector(".modal-head").classList.toggle("cloud", cloud);
  $("ns-env").hidden = !cloud; $("ns-env").textContent = cloud ? t("env.cloud") : "";
  $("ns-where").hidden = !cloud; $("ns-where").textContent = cloud ? t("lib.cf.cloudNote") : "";
}
function nsOpen(opener) {
  const sc = $("ns-scrim");
  if (!sc.hidden) return;
  if (typeof envCanSwitch === "function" && !envCanSwitch()) return;   // 別的框開著 / 選字中
  NS.opener = opener || document.activeElement; NS.fail = false;
  nsPaintEnv(); nsRefresh();
  $("view-ws").inert = true; $("set-scrim").inert = true;
  sc.hidden = false;
  requestAnimationFrame(() => sc.classList.add("open"));
  setTimeout(() => { if (!sc.hidden) $("ns-name").focus(); }, 60);
}
// 送出中:三顆都停用(送出後撤不回;首次裝引擎可能等一分鐘,不能讓人按了沒反應)
function nsLock(on) { ["ns-submit", "ns-cancel", "ns-close"].forEach((id) => { $(id).disabled = on; }); }
function nsClose() {
  const sc = $("ns-scrim");
  if (sc.hidden || NS.sending) return;   // 送出中框留著(等 r.started 才關)
  sc.classList.remove("open"); sc.hidden = true;
  $("view-ws").inert = false; $("set-scrim").inert = false;
  $("ns-msg").textContent = ""; NS.fail = false;
  const o = NS.opener; NS.opener = null;
  if (o && o.isConnected && o.offsetParent) o.focus();
}
// 回合開始 / 結束、換語言:框開著就重算(閘門句、預覽句的語言)
function nsSync() { if (!$("ns-scrim").hidden) nsRefresh(); }
function nsRepaint() { if (!$("ns-scrim").hidden) { nsPaintEnv(); nsRefresh(); } }
// 送出(同 §1.5 的流程):成功(跑起來)→ 關框、清欄、strategy_new;失敗 → 框留著、欄位不清、鈕回復,那一句放 foot-msg
async function nsSend() {
  if (NS.sending) return;
  const msg = nsCompose(nsFields(), LANG, nsStrings());
  if (!msg) return;
  if (nsGate() !== "free") { nsRefresh(); return; }
  NS.sending = true; NS.fail = false;
  nsLock(true);
  const fm = $("ns-msg"), busy = libEl("span", "cf-busy"), sp = libEl("span", "spin16"); sp.setAttribute("aria-hidden", "true");
  busy.append(sp, t("ns.sending")); fm.textContent = ""; fm.appendChild(busy);
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);   // 聊天欄收著就先展開:回覆在那裡
  if (csTitle) csStartNew();
  let ok = false;
  try { ok = await submitMessage(msg); } catch (_) { ok = false; }
  NS.sending = false;
  nsLock(false);
  if (!ok) { NS.fail = true; nsRefresh(); return; }   // 框留著、欄位不清、鈕回復,腳放那一句
  fm.textContent = "";
  nsClose();
  $("ns-modal").reset(); nsRefresh();
  libTrack("strategy_new");
}

/* ── 接線(這支比 app.js 先載:只用 getElementById;handler 裡的才在點擊時取)── */
(function nsWire() {
  const g = (id) => document.getElementById(id);
  g("strat-add").addEventListener("click", () => nsOpen(g("strat-add")));
  g("chat-ns").addEventListener("click", () => nsOpen(g("chat-ns")));   // 歡迎頁 chip:開框、不送訊息
  g("ns-modal").addEventListener("input", nsRefresh);
  g("ns-modal").addEventListener("submit", (e) => { e.preventDefault(); nsSend(); });   // CSP form-action 'none':原生送出一律擋;Enter 與點鈕都走這裡
  g("ns-cancel").addEventListener("click", () => nsClose());
  g("ns-close").addEventListener("click", () => nsClose());
  g("ns-lib").addEventListener("click", () => { if (NS.sending) return; nsClose(); libOpen(); });   // 關框、開同視角的策略庫
  g("ns-scrim").addEventListener("mousedown", (e) => { if (e.target === g("ns-scrim")) nsClose(); });
  g("ns-scrim").addEventListener("keydown", (e) => trapTab(e, g("ns-modal")));
})();
