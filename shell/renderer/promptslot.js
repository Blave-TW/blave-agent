/* 側欄提示格的手機那則(spec sidebar-prompt-slot-2026-11-03,沒登入也出與 pop 步驟改 spec slot-phone-steps-2026-11-05;canon › Components › 側欄提示格)。更新那則是 upPillPaint 畫的,這裡只讓路。
   關閉狀態存主行程 ui-prefs(slotPhone,主行程驗形狀)。web 工作頁同一套規則,常數比對在 tests/check_web_desktop_parity.js */
const SLOT_PH = { COOL_DAYS: 30, MAX_CLOSES: 2, SEEN_DAYS: 7, TRADE_QUIET_MIN: 30 };
const SLOT_DAY_MS = 86400000;
const slotDay = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); };
const slotPhClosed = (p, now) => { const closes = p.closes + 1; return { closes, until: closes >= SLOT_PH.MAX_CLOSES ? 0 : now + SLOT_PH.COOL_DAYS * SLOT_DAY_MS, seenDays: [] }; };
/* spec §3 不畫表:回第一條成立的代號,都不成立回 null */
function slotPhBlock(b, now) {
  if (b.turn) return "turn";
  if (b.awaiting) return "await";
  if (b.scrim) return "scrim";
  if (b.tradeAt > 0 && now >= b.tradeAt && now - b.tradeAt < SLOT_PH.TRADE_QUIET_MIN * 60000) return "trade";
  if (b.view) return "view";
  if (b.p1 > 0) return "p1";
  if (b.halt) return "halt";
  if (b.charge) return "charge";
  if (b.acctCard) return "acct";
  if (b.rail) return "rail";
  return null;
}
/* o:{ up(更新膠囊在出), ph(主行程 relay 狀態), prefs, blocks, now, seen(這次畫出算不算使用日:視窗看得到才算) }
   回 { draw, why, patch(要存回去的 prefs,或 null) }。spec slot-phone-steps §2:沒登入不看開關、不看 paired_ever(relay.js 沒登入一律給 undefined);
   已登入時 paired_ever 只認 false,讀不到(undefined、null)與配對過一樣不畫 */
function slotPhPlan(o) {
  const no = (why, patch) => ({ draw: false, why, patch: patch || null });
  if (o.up) return no("up");
  const ph = o.ph, p = o.prefs;
  if (!ph) return no("flag");
  if (ph.signedIn === true) {
    if (ph.visible !== true) return no("flag");
    if (ph.pairedEver !== false) return no("paired");
  }
  if (!p) return no("prefs");
  if (p.closes >= SLOT_PH.MAX_CLOSES) return no("closed");
  if (p.until > o.now) return no("cooling");
  const why = slotPhBlock(o.blocks || {}, o.now);
  if (why) return no(why);
  if (!o.seen) return { draw: true, why: null, patch: null };
  const today = slotDay(o.now);
  if (p.seenDays.includes(today)) return { draw: true, why: null, patch: null };
  if (p.seenDays.length >= SLOT_PH.SEEN_DAYS) return no("unclicked", slotPhClosed(p, o.now));   // 第 7 天要整天出得來:第 8 個使用日才收
  return { draw: true, why: null, patch: { ...p, seenDays: p.seenDays.concat(today) } };
}

/* ── 畫面 ── */
let SLOT_ST = null, SLOT_SHOW_DAY = "";
async function slotLoad() {
  try { SLOT_ST = (await window.blave.slotState()) || null; } catch (_) { SLOT_ST = null; }
  slotPaint();
}
function slotSave(patch) {
  if (SLOT_ST) SLOT_ST.phone = patch;
  Promise.resolve().then(() => window.blave.slotPhoneSet(patch)).catch(() => {});
}
function slotBlocks() {
  const st = SLOT_ST || {};
  return { turn: csAnyTurn(), awaiting: csAnyAwait(), scrim: [...document.querySelectorAll(".scrim")].some((x) => !x.hidden),
    tradeAt: st.tradeAt, view: !$("tr").hidden || !$("po").hidden, p1: st.p1,
    halt: ["local", "cloud"].some((k) => { const r = TR_BAGS[k].st && TR_BAGS[k].st.report; return !!(r && r.halt && r.halt.halted); }),
    charge: dataAccessOf(acct) === "payment_failed",
    acctCard: !!(acctCard && acctCard.el.isConnected) || creditCards.some((c) => c.el && c.el.isConnected),
    rail: document.documentElement.classList.contains("ws-sc") };
}
/* pop 內容(spec slot-phone-steps §3,號碼盤三態改 spec slot-phone-v2 §2–3):沒登入〔登入 Blave〕、下載、配對;已登入 打勾的已登入、QR 加兩個商店、在 App 按〔對話〕。
   兩種都在最後接「按〔打開〕」(「允許手機對話」已開就不列,同意框不會再問)。電腦版只看得到登不登入:只有第 1 步能打勾,
   下載 App 之後的進度看不到,所以 now 永遠只有一步、後面都是 next,不假裝有進度。
   email 要等 account_status 帶回來才出(api 還沒給時只寫「已登入」);晚到只原地補那一行(slotWhoPaint),不重建、不搬焦點。
   登入狀態、開關或語言變了才重建;開著時原地換、不收,焦點本來在 pop 裡(登入鈕被拿掉後掉到 BODY)就接到 pop 第一個能按的 */
let SLOT_POP_KEY = "", SLOT_WHO_HOST = null, SLOT_WHO;
function slotWhoPaint(email) {
  if (!SLOT_WHO_HOST || SLOT_WHO === email) return;
  SLOT_WHO = email;
  const kids = [document.createTextNode(t("ph.signed"))];
  if (email) { const who = document.createElement("span"); who.className = "ph-who"; who.textContent = email; who.title = email; kids.push(who); }
  SLOT_WHO_HOST.replaceChildren(...kids);
}
const SLOT_CHECK = "M20 6 9 17l-5-5";   // Lucide check
function slotPopPaint() {
  const signedIn = !!(PH && PH.signedIn === true), allowOn = !!(PH && PH.on === true);
  const email = signedIn && acct && typeof acct.email === "string" ? acct.email.trim() : "";
  const key = signedIn + "|" + allowOn + "|" + LANG;
  if (SLOT_POP_KEY === key) { slotWhoPaint(email); return; }
  SLOT_POP_KEY = key;
  const pop = $("ph-pop"), a = document.activeElement, refocus = !pop.hidden && (a === document.body || pop.contains(a));
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const ol = mk("ol", "ph-steps");
  const step = (state, ...kids) => {
    const li = mk("li", "ph-step " + state), n = mk("span", "ph-n");
    n.setAttribute("aria-hidden", "true");   // <ol> 已經念號碼;done 那步的字是「已登入」,不靠勾
    if (state === "done") {
      const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"), path = document.createElementNS(NS, "path");
      svg.setAttribute("class", "ic"); svg.setAttribute("viewBox", "0 0 24 24"); path.setAttribute("d", SLOT_CHECK); svg.append(path); n.append(svg);
    } else n.textContent = String(ol.children.length + 1);
    if (state === "now") li.setAttribute("aria-current", "step");
    li.append(n, ...kids); ol.append(li); return li;
  };
  /* 鈕名不斷開:zh〔對話〕〔打開〕連前一個字一起包,鈕名不單獨掉到最後一行;en 只包鈕名(Chat 是 App 的鈕名,Turn On 同 ph.ask.ok)。
     split 的捕捉組落在奇數位 */
  const nwRe = LANG === "zh" ? /(.〔[^〕]+〕。?)/ : new RegExp("\\b(Chat|" + t("ph.ask.ok").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")\\b");
  const say = (k) => { const el = mk("span", "ph-t");
    t(k).split(nwRe).forEach((part, i) => { if (part) el.append(i % 2 ? mk("span", "ph-nw", part) : document.createTextNode(part)); });
    return el; };
  SLOT_WHO_HOST = null; SLOT_WHO = undefined;
  if (!signedIn) {
    const b = signInLabel(mk("button", "btn-out"), t("pv.signin")); b.type = "button";
    b.addEventListener("click", () => { if (!planLoginBusy && !oauthPending) trackFeature("slot_ph_login"); planSignIn(b); });   // 等待中再按是取消,不算一次登入
    const cell = mk("span"); cell.append(b);
    step("now", cell).classList.add("btn");
    step("next", mk("span", "ph-t", t("ph.stepGet")));
    step("next", mk("span", "ph-t", t("ph.stepPair")));
  } else {
    SLOT_WHO_HOST = mk("span", "ph-t"); slotWhoPaint(email);
    step("done", SLOT_WHO_HOST);
    const plate = mk("span", "ph-plate"), img = mk("img"), links = mk("div", "ph-links");
    img.src = "qr-app.svg"; img.alt = ""; img.width = img.height = 112; plate.append(img);   // 內容 https://blave.org/app?src=desktop,依裝置分流商店
    for (const ios of [true, false]) {
      const go = mk("button", "btn-quiet", t(ios ? "mv.appIos" : "mv.appAndroid")); go.type = "button";
      go.addEventListener("click", () => { trackFeature(ios ? "app_link_ios" : "app_link_android"); window.blave.openExternal(ios ? MV_APP_IOS : MV_APP_ANDROID); });
      links.append(go);
    }
    const body = mk("div", "ph-body"); body.append(plate, links);
    step("now", mk("span", "ph-t", t("ph.stepGet")), body);
    step("next", say("ph.stepChat"));
  }
  if (!allowOn) step("next", say("ph.stepAllow"));
  pop.replaceChildren(ol);
  if (refocus) { const f = pop.querySelector("button"); if (f) f.focus(); }
}
function slotPopOpen() { return !$("ph-pop").hidden; }
function slotPopClose(refocus) {
  if (!slotPopOpen()) return;
  $("ph-pop").hidden = true; $("ph-pill").setAttribute("aria-expanded", "false");
  if (refocus) $("ph-pill").focus();
}
function slotPaint() {
  const wrap = $("ph-slot"); if (!wrap) return;
  const seen = document.visibilityState === "visible";
  const plan = slotPhPlan({ up: upPillNow().show, ph: PH, prefs: SLOT_ST && SLOT_ST.phone, blocks: slotBlocks(), now: Date.now(), seen });
  if (plan.patch) slotSave(plan.patch);
  if (!plan.draw) {
    const had = !wrap.hidden && wrap.contains(document.activeElement);
    wrap.hidden = true; slotPopClose(false);
    if (had) $("ws-conn").focus();   // 同 ×:膠囊整個收掉(登入後發現配對過、開關沒開),焦點接到下面的〔設定〕,不掉到 BODY
    return;
  }
  wrap.hidden = false;
  slotPopPaint();
  if (seen) { const d = slotDay(Date.now()); if (SLOT_SHOW_DAY !== d) { SLOT_SHOW_DAY = d; trackFeature("slot_ph_show"); } }
}
$("ph-pill").addEventListener("click", () => {
  if (slotPopOpen()) { slotPopClose(true); return; }
  // 側欄 overflow:hidden、最窄 180 比 popover 窄:fixed 才不被裁,位置開的時候量
  slotPopPaint();
  const r = $("ph-pill").getBoundingClientRect(), pop = $("ph-pop");
  pop.style.left = r.left + "px"; pop.style.bottom = window.innerHeight - r.top + 8 + "px";
  pop.hidden = false; $("ph-pill").setAttribute("aria-expanded", "true");
  trackFeature("slot_ph_open");
  if (SLOT_ST && SLOT_ST.phone) slotSave({ ...SLOT_ST.phone, seenDays: [] });   // 按過就不算「連 7 個使用日沒按」
});
$("ph-x").addEventListener("click", () => {
  if (!SLOT_ST || !SLOT_ST.phone) return;
  trackFeature("slot_ph_close");
  slotSave(slotPhClosed(SLOT_ST.phone, Date.now()));
  slotPaint();
  $("ws-conn").focus();   // 膠囊跟 × 都收掉了:焦點接到下面的〔設定〕,不掉到 BODY
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && slotPopOpen()) { e.stopPropagation(); slotPopClose(true); } }, true);
// 點外面收:焦點回膠囊;點到輸入框這類會接焦點的就留在那,不把人正要打字的地方搶走
document.addEventListener("pointerdown", (e) => {
  if (!slotPopOpen() || $("ph-pop").contains(e.target) || $("ph-pill").contains(e.target)) return;
  slotPopClose(false);
  setTimeout(() => { if (document.activeElement === document.body) $("ph-pill").focus(); }, 0);
}, true);
window.addEventListener("resize", () => slotPopClose(false));
/* 不畫表的條件散在十幾個地方、大多沒有事件可接:一秒看一次(只讀旗標,變了才動畫面)。主行程那份(下單時間、第一次回覆、P1)十秒拿一次 */
Promise.resolve().then(() => phStateLoad()).then(slotLoad).catch(() => {});
setInterval(slotPaint, 1000);
setInterval(slotLoad, 10000);
