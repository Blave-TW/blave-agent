/* 左下角一列的手機圖示與它的步驟框(spec sidebar-conversion-2026-11-10 §3.2、§6.5;pop 內容 spec phone-pair-popover-2026-11-17)。
   出不出只看六條,沒有冷卻、關閉次數、使用日或不畫表;放不下(§4.3)時手機讓位,其餘三樣不動 */
/* o:{ ph(主行程 relay 狀態), revoked(登入失效), rail(側欄收合), fits(這一列放得下四樣) } → { draw, why }。
   主行程的 signedIn 只看有沒有 token,登入失效時仍是 true,所以 revoked 另外擋;paired_ever 只認 false,讀不到當作配對過 */
function slotPhPlan(o) {
  const ph = o.ph, no = (why) => ({ draw: false, why });
  if (!ph || ph.signedIn !== true) return no("out");
  if (o.revoked) return no("revoked");
  if (ph.visible !== true) return no("flag");
  if (ph.pairedEver !== false) return no("paired");
  if (o.rail) return no("rail");
  if (!o.fits) return no("fit");
  return { draw: true, why: null };
}
/* 這一列放不放得下:把看得到的每一樣的寬加左右 margin、再加列的 padding-left,跟列的 clientWidth 比。
   不用 scrollWidth:透明熱區(::before 伸出 8–9)會被算進去。pop 是 position: fixed,不佔列寬 */
function slotRowFits(row) {
  if (!row || !row.clientWidth) return false;   // 列沒排出來(細軌、還沒顯示):等 ResizeObserver 在它有寬時再算
  const cs = (el) => getComputedStyle(el);
  let need = parseFloat(cs(row).paddingLeft) || 0;
  for (const el of row.children) {
    if (el.hidden) continue;
    const c = cs(el); if (c.display === "none" || c.position === "fixed") continue;
    need += el.getBoundingClientRect().width + (parseFloat(c.marginLeft) || 0) + (parseFloat(c.marginRight) || 0);
  }
  return need <= row.clientWidth + 0.5;   // 次像素誤差
}
/* pop 內容(spec phone-pair-popover-2026-11-17 §4;手機圖示只對已登入的人出):頂端一句價值(h2,pop 用 aria-labelledby 指它)加一行好處,
   再兩步:QR 加兩個商店、登入這個帳號後在 App 按〔對話〕。下載 App 之後的進度看不到,所以 now 只有第 1 步、第 2 步是 next,不假裝有進度。
   不看「允許手機對話」開關:App 配對完自己會講按〔打開〕,兩種狀態長一樣。
   email 要等 account_status 帶回來才出,讀不到就不出那一行(步驟句不變);晚到只在第 2 步原地補(slotWhoPaint),不重建、不搬焦點。
   語言變了才重建;開著時原地換、不收,焦點本來在 pop 裡就接到 pop 第一個能按的 */
let SLOT_POP_KEY = "", SLOT_WHO_HOST = null, SLOT_WHO;
function slotWhoPaint(email) {
  if (!SLOT_WHO_HOST || SLOT_WHO === email) return;
  SLOT_WHO = email;
  if (!email) { SLOT_WHO_HOST.replaceChildren(); return; }
  const who = document.createElement("span"); who.className = "ph-who"; who.textContent = email; who.title = email;
  SLOT_WHO_HOST.replaceChildren(who);
}
function slotPopPaint() {
  const email = acct && typeof acct.email === "string" ? acct.email.trim() : "";
  if (SLOT_POP_KEY === LANG) { slotWhoPaint(email); return; }
  SLOT_POP_KEY = LANG;
  const pop = $("ph-pop"), a = document.activeElement, refocus = !pop.hidden && (a === document.body || pop.contains(a));
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const lead = mk("div", "ph-lead"), h = mk("h2", "ph-value", t("ph.value"));
  h.id = "ph-pop-h"; lead.append(h, mk("p", "ph-gain", t("ph.gain")));
  pop.setAttribute("role", "dialog"); pop.setAttribute("aria-labelledby", h.id);
  const ol = mk("ol", "ph-steps");
  const step = (state, ...kids) => {
    const li = mk("li", "ph-step " + state), n = mk("span", "ph-n", String(ol.children.length + 1));
    n.setAttribute("aria-hidden", "true");   // <ol> 已經念號碼
    if (state === "now") li.setAttribute("aria-current", "step");
    li.append(n, ...kids); ol.append(li); return li;
  };
  /* 鈕名不斷開:zh〔對話〕連前一個字一起包,鈕名不單獨掉到最後一行;en 只包鈕名(Chat 是 App 的鈕名)。split 的捕捉組落在奇數位 */
  const nwRe = LANG === "zh" ? /(.〔[^〕]+〕。?)/ : /\b(Chat)\b/;
  const say = (k) => { const el = mk("span", "ph-t");
    t(k).split(nwRe).forEach((part, i) => { if (part) el.append(i % 2 ? mk("span", "ph-nw", part) : document.createTextNode(part)); });
    return el; };
  const plate = mk("span", "ph-plate"), img = mk("img"), links = mk("div", "ph-links");
  img.src = "qr-app.svg"; img.alt = ""; img.width = img.height = 112; plate.append(img);   // 內容 https://blave.org/app?src=desktop,依裝置分流商店
  for (const ios of [true, false]) {
    const go = mk("button", "btn-quiet", t(ios ? "mv.appIos" : "mv.appAndroid")); go.type = "button";
    go.addEventListener("click", () => { trackFeature(ios ? "app_link_ios" : "app_link_android"); window.blave.openExternal(ios ? MV_APP_IOS : MV_APP_ANDROID); });
    links.append(go);
  }
  const body = mk("div", "ph-body"); body.append(plate, links);
  step("now", mk("span", "ph-t", t("ph.stepGet")), body);
  const chat = say("ph.stepChat");
  SLOT_WHO_HOST = mk("span"); SLOT_WHO = undefined; slotWhoPaint(email); chat.append(SLOT_WHO_HOST);
  step("next", chat);
  pop.replaceChildren(lead, ol);
  if (refocus) { const f = pop.querySelector("button"); if (f) f.focus(); }
}
function slotPopOpen() { return !$("ph-pop").hidden; }
function slotPopClose(refocus) {
  if (!slotPopOpen()) return;
  $("ph-pop").hidden = true; $("ph-pill").setAttribute("aria-expanded", "false");
  if (refocus) $("ph-pill").focus();
}
let SLOT_SHOW_DAY = "";
/* 叫的地方:主行程推 relay 狀態、帳號那一格重畫(登入、語言、方案)、更新圓鈕出現或消失、列寬變了(ResizeObserver,含收合與展開)。
   先放出來量,放不下就在同一拍收回去,畫面上不會閃 */
function slotPaint() {
  const pill = $("ph-pill"), row = $("foot-row"); if (!pill || !row) return;
  pill.title = t("ph.slot"); pill.setAttribute("aria-label", t("ph.slot"));
  const base = { ph: PH, revoked: typeof authRevoked === "function" && authRevoked(), rail: document.documentElement.classList.contains("ws-sc") };
  const a = document.activeElement, had = pill.contains(a) || (slotPopOpen() && $("ph-pop").contains(a));
  let plan = slotPhPlan({ ...base, fits: true });
  if (plan.draw) { pill.hidden = false; plan = slotPhPlan({ ...base, fits: slotRowFits(row) }); }
  if (!plan.draw) {
    pill.hidden = true; slotPopClose(false);
    if (had) (base.rail ? $("rail-set") : $("ws-conn")).focus();   // 圖示整個收掉:焦點接到齒輪,不掉到 BODY
    return;
  }
  slotPopPaint();
  if (document.visibilityState === "visible") { const d = new Date().toDateString(); if (SLOT_SHOW_DAY !== d) { SLOT_SHOW_DAY = d; trackFeature("slot_ph_show"); } }
}
$("ph-pill").addEventListener("click", () => {
  if (slotPopOpen()) { slotPopClose(true); return; }
  // 側欄 overflow:hidden、最窄 180 比 popover 窄:fixed 才不被裁,位置開的時候量;左緣對齊圖示、往上開
  slotPopPaint();
  const r = $("ph-pill").getBoundingClientRect(), pop = $("ph-pop");
  pop.style.left = r.left + "px"; pop.style.bottom = window.innerHeight - r.top + 8 + "px";
  pop.hidden = false; $("ph-pill").setAttribute("aria-expanded", "true");
  trackFeature("slot_ph_open");
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && slotPopOpen()) { e.stopPropagation(); slotPopClose(true); } }, true);
// 點外面收:焦點回圖示;點到輸入框這類會接焦點的就留在那,不把人正要打字的地方搶走
document.addEventListener("pointerdown", (e) => {
  if (!slotPopOpen() || $("ph-pop").contains(e.target) || $("ph-pill").contains(e.target)) return;
  slotPopClose(false);
  setTimeout(() => { if (document.activeElement === document.body) $("ph-pill").focus(); }, 0);
}, true);
window.addEventListener("resize", () => slotPopClose(false));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") slotPaint(); });   // 看不到時畫出的不算曝光:回來補記
/* 列寬變了(拖側欄、收合／展開、進工作頁)、或列裡哪一樣變寬變窄(換語言、帳號狀態、更新出現):重畫帳號那一格(它排出來才算曝光)、
   再重算手機放不放得下(sideCvPaint 結尾會叫 slotPaint)。手機自己不觀察:它在同一拍裡放出又收回,大小沒變,不會自己觸發自己 */
if (typeof ResizeObserver === "function") { const ro = new ResizeObserver(() => (typeof sideCvPaint === "function" ? sideCvPaint() : slotPaint())); ["foot-row", "side-cv", "side-note", "up-pill"].forEach((id) => { if ($(id)) ro.observe($(id)); }); }
Promise.resolve().then(() => phStateLoad()).then(slotPaint).catch(() => {});
