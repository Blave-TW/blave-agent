/* 新增策略 modal(設計:blave-canon output/designer/spec-desktop-0.1.6-2026-09-25.md §4;照雲端工作頁 #ns_modal 逐格搬)。
   側欄「策略」標題旁的 ＋ / 歡迎頁的「新增策略」chip → 五格(名稱 / 標的 / 週期 / 指標 / 邏輯)+ 即時預覽句 +「至少填一項」+ 策略庫連結;
   送出 = 把預覽那句(nsCompose,句型同 web 的 nsCompose)送到對話。不記 pending、不輪詢:回覆本身就在對話裡,策略檔出現在側欄靠既有的 stratRefresh。
   殼同 confirmBox 家族(#del-scrim 的 440 框);雲端視角:標題列灰底 +「雲端」記號 + 腳的目的地句。
   同一支也放「上網找點子」框(spec-0.1.13 §5;ideaOpen,殼與送出流程同新增策略框)。
   用到 app.js 的 $ / t / LANG / cur / running / csTitle / csStartNew / submitMessage / trapTab / paneSt / paneToggle、trade.js 的 envCanSwitch、
   library.js 的 libEnv / libCloud / libOpen / libTrack / libEl / libJoin、reports.js 的 rptAskState——都在呼叫時才取。 */

/* ── 純邏輯(tests/check_shell_newstrategy.js 從原文切出來跑;這一段不准碰 DOM / i18n)── */
const NS_FIELDS = ["name", "symbol", "timeframe", "indicators", "logic"];
/* 五格 → 送到對話的那句:zh 全形「」：。、en 半形;空格跳過;全空 → "";邏輯尾端的 。！？ / .!? 先去掉再補。
   句型照 web nsCompose,但不附 web 那句「加密貨幣標的未註明市場時預設永續」:不從代號猜市場,哪個市場交給 agent 問或判斷。
   f = { name, symbol, timeframe, indicators, logic },s = { lead, symbol, timeframe, indicators, logic }(字串表的字,由呼叫端代) */
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
  } else {
    msg = name ? s.lead + ' "' + name + '".' : s.lead + ".";
    if (sym) msg += " " + s.symbol + ": " + sym + ".";
    if (tf) msg += " " + s.timeframe + ": " + tf + ".";
    if (ind) msg += " " + s.indicators + ": " + ind + ".";
    if (logic) msg += " " + s.logic + ": " + logic.replace(/[.!?]+$/, "") + ".";
  }
  return msg;
}
/* 上網找點子要送出的那句(spec-0.1.13 §1.5)。mkt = crypto / tw / any;s = { msg, topicTpl, mkt: { crypto, tw, any } }(字串表的字,any 是空字串)。
   方向:控制字元換空白 → 連續空白合併 → 去頭尾 → 截 40;清完是空的就不帶方向那段。{mkt}、{topic}、{t} 各只准出現一次,範本壞掉回 null(寧可不送,同 libMsg)。
   一次替換({mkt} / {topic} 同一趟):方向裡打了「{mkt}」也不會再被換掉 */
function ideaCompose(mkt, topic, s) {
  const once = (tpl, k) => typeof tpl === "string" && tpl.split("{" + k + "}").length === 2;
  if (!s || !once(s.msg, "mkt") || !once(s.msg, "topic") || !once(s.topicTpl, "t") || !s.mkt || typeof s.mkt[mkt] !== "string") return null;
  const tp = String(topic == null ? "" : topic).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  const sub = { mkt: s.mkt[mkt], topic: tp ? s.topicTpl.split("{t}").join(tp) : "" };
  return s.msg.replace(/\{(mkt|topic)\}/g, (_m, k) => sub[k]);
}
/* ── 純邏輯到此 ── */

const NS = { sending: false, opener: null, fail: false };   // fail = 上一次送出失敗:腳那一句留到下次送出 / 關框(讓人原樣重送)
function nsStrings() { return { lead: t("ns.msgLead"), symbol: t("ns.msgSymbol"), timeframe: t("ns.msgTimeframe"), indicators: t("ns.msgIndicators"), logic: t("ns.msgLogic") }; }
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
// 回合開始 / 結束、換語言:框開著就重算(閘門句、預覽句的語言);找點子框同一條
function nsSync() { if (!$("ns-scrim").hidden) nsRefresh(); if (!$("idea-scrim").hidden) ideaRefresh(); }
function nsRepaint() { if (!$("ns-scrim").hidden) { nsPaintEnv(); nsRefresh(); } if (!$("idea-scrim").hidden) ideaRefresh(); }
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

/* ── 上網找點子(spec-0.1.13 §5):四個入口(歡迎頁籤 / 策略庫頁首 / 第一組空 / 市場空)開同一個框,只差 from 與市場預設。
   殼與送出流程同上面的新增策略框:nsGate 閘門、送出中三顆停用、inert、trapTab、Esc 由 app.js escTop 收、送出失敗框留著 ── */
const IDEA = { sending: false, opener: null, fail: false, from: "welcome", mkt: "any" };
const IDEA_FROM = ["welcome", "lib_head", "lib_empty"];
function ideaStrings() { return { msg: t("idea.msg"), topicTpl: t("idea.topicTpl"), mkt: { crypto: t("idea.mkt.crypto"), tw: t("idea.mkt.tw"), any: "" } }; }
function ideaMsg() { return ideaCompose(IDEA.mkt, $("idea-topic").value, ideaStrings()); }
// 找點子框只在這台電腦視角開:閘門只看回合在不在跑(沒有雲端主機停機 / 逾時那兩態)
function ideaGate() { return rptAskState({ running: typeof running !== "undefined" && running === true, env: "local", cloud: null, pending: false }); }
function ideaRefresh() {
  const msg = ideaMsg(), st = ideaGate();
  $("idea-mkt").querySelectorAll("button[data-mkt]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mkt === IDEA.mkt ? "true" : "false"));
  $("idea-opt").textContent = libJoin("", t("idea.opt"));
  $("idea-preview").textContent = msg || "";
  // 自帶 Claude Code / Codex 的人不經 Blave 扣款:費用句只對 Blave AI 講
  const hint = typeof cur !== "undefined" && cur === "blave" ? t("idea.cost") : "";
  $("idea-hint").textContent = hint; $("idea-hint").hidden = !hint;
  $("idea-submit").disabled = !msg || IDEA.sending || st !== "free";
  if (!IDEA.sending) $("idea-msg").textContent = st === "busy" ? t("turn.busy") : st === "stopped" ? t("ho.gate.stopped") : st === "stale" ? t("ho.gate.stale") : IDEA.fail ? t("modal.sendFailed") : "";
}
function ideaOpen(opener, from, mkt) {
  const sc = $("idea-scrim");
  if (!sc.hidden || libEnv() !== "local") return;   // 只有這台電腦視角(雲端沒有內建瀏覽器)
  if (typeof envCanSwitch === "function" && !envCanSwitch()) return;   // 別的框開著 / 選字中
  IDEA.opener = opener || document.activeElement; IDEA.fail = false;
  IDEA.from = IDEA_FROM.includes(from) ? from : "welcome"; IDEA.mkt = mkt === "crypto" || mkt === "tw" ? mkt : "any";
  ideaRefresh();
  $("view-ws").inert = true; $("set-scrim").inert = true;
  sc.hidden = false;
  requestAnimationFrame(() => sc.classList.add("open"));
  setTimeout(() => { if (!sc.hidden) $("idea-topic").focus(); }, 60);
}
function ideaLock(on) { ["idea-submit", "idea-cancel", "idea-close"].forEach((id) => { $(id).disabled = on; }); $("idea-mkt").querySelectorAll("button").forEach((b) => { b.disabled = on; }); }
function ideaClose() {
  const sc = $("idea-scrim");
  if (sc.hidden || IDEA.sending) return;
  sc.classList.remove("open"); sc.hidden = true;
  $("view-ws").inert = false; $("set-scrim").inert = false;
  $("idea-msg").textContent = ""; IDEA.fail = false;
  const o = IDEA.opener; IDEA.opener = null;
  if (o && o.isConnected && o.offsetParent) o.focus();
}
async function ideaSend() {
  if (IDEA.sending) return;
  const msg = ideaMsg();
  if (!msg) return;
  if (ideaGate() !== "free") { ideaRefresh(); return; }
  IDEA.sending = true; IDEA.fail = false;
  ideaLock(true);
  const fm = $("idea-msg"), busy = libEl("span", "cf-busy"), sp = libEl("span", "spin16"); sp.setAttribute("aria-hidden", "true");
  busy.append(sp, t("ns.sending")); fm.textContent = ""; fm.appendChild(busy);
  $("idea-submit").textContent = t("ns.sending");
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);   // 聊天欄收著就先展開:回覆在那裡
  if (csTitle) csStartNew();
  let ok = false;
  try { ok = await submitMessage(msg); } catch (_) { ok = false; }
  IDEA.sending = false;
  ideaLock(false); $("idea-submit").textContent = t("ns.submit");
  if (!ok) { IDEA.fail = true; ideaRefresh(); return; }   // 框留著、方向不清,腳放那一句
  fm.textContent = "";
  const from = IDEA.from;
  ideaClose();
  $("idea-modal").reset(); ideaRefresh();
  try { window.blave.trackEvent("idea_sent", { from }); } catch (_) { }   // 追蹤永遠不擋功能
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
  g("idea-modal").addEventListener("input", ideaRefresh);
  g("idea-modal").addEventListener("submit", (e) => { e.preventDefault(); ideaSend(); });
  g("idea-topic").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.isComposing || e.keyCode === 229)) e.preventDefault(); });   // 中文輸入法選字的 Enter 不送出
  g("idea-mkt").addEventListener("click", (e) => { const b = e.target.closest("button[data-mkt]"); if (!b || IDEA.sending) return; IDEA.mkt = b.dataset.mkt; ideaRefresh(); });
  g("idea-cancel").addEventListener("click", () => ideaClose());
  g("idea-close").addEventListener("click", () => ideaClose());
  g("idea-scrim").addEventListener("mousedown", (e) => { if (e.target === g("idea-scrim")) ideaClose(); });
  g("idea-scrim").addEventListener("keydown", (e) => trapTab(e, g("idea-modal")));
})();
