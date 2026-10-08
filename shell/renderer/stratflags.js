/* 側欄策略列的旗標(左軌 2×16 色條)與整列拖拉排序(spec .claude/output/designer/desktop-strat-flags-2026-10;
   視覺與行為照雲端工作頁 workspace.html 的 stratOrder / stratFlags / bindRowDrag / buildFlagPop 同一套,差別只在電腦版既有解剖:
   .strat-wrap(容器)> .strat-row(名字鈕)+ .strat-flagbtn(本案新增)+ .cs-del(✕ 會武裝)。
   在 app.js 之後載入(用它的 $、t、RP、stratTip、trackFeature)。
   偏好存這台電腦的 ui-prefs.json(主行程 strat-prefs / strat-prefs-set;不進 workspace、不寫 localStorage);
   雲端 tab 只讀 api 回的 strat_order / strat_flags(trade.js envPaintSide 用 sfApplyOrder / sfFlagMeta),不給拖、不給掛。
   順序 / 旗標是偏好不是資料:寫失敗不回滾、不彈錯,本 session 靠記憶體值維持。 */
const SF = { order: [], flags: {}, ready: null, dragActive: false, dragPointer: null, justDragged: false, waiters: [], timer: null, dirty: new Set(),
  popWrap: null, popReturn: null, popX: null, popJustClosed: null };
const SF_COLORS = { 1: "side.flagC1", 2: "side.flagC2", 3: "side.flagC3" };
const SF_SAVE_MS = 300;   // Alt+↑/↓ 連發只寫最後一次(同 web 的 trailing debounce)

/* ── 純函式(tests/check_shell_strat_prefs.js)── */
// order 內且存在的名字先,其餘(新策略)照 list 既有序(電腦版 = 最近動過在上)append 最底;長度對不上(防禦)維持原序
function sfApplyOrder(list, order) {
  if (!Array.isArray(list) || !Array.isArray(order) || !order.length || list.length < 2) return list;
  const byName = new Map();
  list.forEach((s) => { if (s && typeof s.name === "string") byName.set(s.name, s); });
  const sorted = [];
  order.forEach((n) => { if (byName.has(n)) { sorted.push(byName.get(n)); byName.delete(n); } });
  list.forEach((s) => { if (s && typeof s.name === "string" && byName.has(s.name)) sorted.push(s); });
  return sorted.length === list.length ? sorted : list;
}
// 存檔與 api 都寬容收 1–6(六色期留下的),畫面只畫 1–3;其餘當沒有
function sfFlagId(v) { return Number.isInteger(v) && v >= 1 && v <= 3 ? v : null; }

function sfReady() {
  if (!SF.ready) SF.ready = window.blave.stratPrefs().then((p) => {
    if (!p || typeof p !== "object") return;
    SF.order = Array.isArray(p.stratOrder) ? p.stratOrder : [];
    SF.flags = p.stratFlags && typeof p.stratFlags === "object" && !Array.isArray(p.stratFlags) ? p.stratFlags : {};
  }, () => {});
  return SF.ready;
}
// stratRefresh 重建列之前:偏好要讀好(第一次畫就是對的順序)、拖拉中等拖完(列拔掉會殺掉進行中的拖拉)、旗標面板開著先收(錨點會失效)
function sfBeforeRebuild() {
  sfPopClose(false);
  return Promise.all([sfReady(), SF.dragActive ? new Promise((r) => SF.waiters.push(r)) : null]);
}
function sfSave(key) {
  SF.dirty.add(key);
  clearTimeout(SF.timer);
  SF.timer = setTimeout(() => {
    const w = {};
    if (SF.dirty.has("order")) w.stratOrder = SF.order;
    if (SF.dirty.has("flags")) w.stratFlags = SF.flags;
    SF.dirty.clear();
    window.blave.stratPrefsSet(w).catch(() => {});
  }, SF_SAVE_MS);
}
// 刪除成功順手清掉該名字的項(殘鍵無害,但別留垃圾)
function sfForget(name) {
  if (SF.order.indexOf(name) >= 0) { SF.order = SF.order.filter((n) => n !== name); sfSave("order"); }
  if (name in SF.flags) { delete SF.flags[name]; sfSave("flags"); }
}

/* ── 列上的旗標 meta:掛 / 換 / 移除只改 dataset + title + aria,不重建列(本機列與雲端列共用)。
   title 無旗標時 = tipName(全名＋資料夾代號,app.js stratTip);有旗標時「全名 — 旗標：色名」、accessible name「全名，旗標：色名」(色永遠不是唯一管道) */
function sfFlagMeta(wrap, btn, tipName, id) {
  const fid = sfFlagId(id), nm = btn.querySelector(".strat-name");
  if (fid) {
    wrap.dataset.flag = String(fid);
    const v = { name: tipName, color: t(SF_COLORS[fid]) };
    if (nm) nm.title = t("side.flagTitle", v);
    btn.setAttribute("aria-label", t("side.flagAria", v));
  } else {
    delete wrap.dataset.flag;
    if (nm) nm.title = tipName;
    btn.removeAttribute("aria-label");
  }
}
function sfIcon() {
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "ic"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  for (const d of ["M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z", "M4 22v-7"]) { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); svg.appendChild(p); }
  return svg;
}
// 這台電腦的列(app.js stratRefresh 每列叫一次,接在名字鈕之後、✕ 之前):旗標鈕 + 右鍵面板。wrap 掛 data-name 給拖拉寫回與旗標改值找列
function sfRowActions(wrap, btn, x) {
  wrap.dataset.name = x.name;
  sfFlagMeta(wrap, btn, stratTip(x.displayName, x.name), SF.flags[x.name]);
  const fb = document.createElement("button");
  fb.type = "button"; fb.className = "strat-flagbtn"; fb.setAttribute("aria-label", t("side.flagSet")); fb.setAttribute("aria-haspopup", "menu");
  fb.appendChild(sfIcon());
  fb.addEventListener("click", (e) => {
    e.stopPropagation();
    if (SF.justDragged) return;
    if (SF.popJustClosed === fb) { SF.popJustClosed = null; return; }   // 這下的 pointerdown 剛把自己的面板收掉:click 不重開(toggle)
    sfPopOpen(wrap, fb, x, false);
  });
  wrap.appendChild(fb);
  // 右鍵:同一個面板,底部多一條「移到垃圾桶」(= 把該列的 ✕ 武裝並 focus 到它,之後照兩段式刪除走)
  wrap.addEventListener("contextmenu", (e) => { e.preventDefault(); if (SF.dragActive) return; sfPopOpen(wrap, fb, x, true); });
}
function sfSetFlag(name, id) {
  const next = sfFlagId(id);
  if (next === sfFlagId(SF.flags[name])) return;   // 沒變:不寫、不埋
  if (next) SF.flags[name] = next; else delete SF.flags[name];
  const x = RP.list.find((s) => s.name === name);
  $("strat-list").querySelectorAll(":scope > .strat-wrap").forEach((w) => {
    const b = w.querySelector(".strat-row");
    if (w.dataset.name === name && b) sfFlagMeta(w, b, stratTip(x && x.displayName, name), next);
  });
  trackFeature("strat_flag_set");
  sfSave("flags");
}

/* ── 旗標面板:單例掛 body、position: fixed(.strat-list 是捲動容器,absolute 錨在列內會被裁)。
   焦點進面板後列的 :has(:focus-visible) 失效,靠 .flag-open 撐住雙鈕與回流態(app.css) */
let sfPop = null;
function sfPopBuild() {
  sfPop = document.createElement("div");
  sfPop.className = "flag-pop"; sfPop.setAttribute("role", "menu"); sfPop.hidden = true;
  const grid = document.createElement("div"); grid.className = "swgrid";
  for (let id = 1; id <= 3; id++) {
    const c = document.createElement("button");
    c.type = "button"; c.className = "swcell"; c.dataset.flag = String(id); c.setAttribute("role", "menuitemradio");
    const tip = document.createElement("span"); tip.className = "tip"; tip.setAttribute("aria-hidden", "true");   // hover / focus 浮固定色名(app.css .tip 材質)
    c.appendChild(tip);
    c.addEventListener("click", () => { const x = SF.popX; sfPopClose(true); if (x) sfSetFlag(x.name, id); });
    grid.appendChild(c);
  }
  sfPop.appendChild(grid);
  const sep = () => { const d = document.createElement("div"); d.className = "divider"; d.setAttribute("role", "separator"); return d; };
  const item = (cls) => { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.setAttribute("role", "menuitem"); return b; };
  const rm = item("item");
  rm.addEventListener("click", () => { const x = SF.popX; sfPopClose(true); if (x) sfSetFlag(x.name, null); });
  const d2 = sep(), del = item("item danger");
  d2.dataset.ctx = "1"; del.dataset.ctx = "1";   // 右鍵才有的那兩個
  del.addEventListener("click", () => {
    const w = SF.popWrap; sfPopClose(false);
    const x = w && w.querySelector(".cs-del");
    if (!x || x.disabled) return;
    if (!x.classList.contains("is-armed")) x.click();   // app.js armedDelete:第一下 = 武裝成「移到垃圾桶？」
    x.focus();
  });
  sfPop.append(sep(), rm, d2, del);
  sfPop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); sfPopClose(true); return; }   // 不給 app.js 的 escTop:一次只關一層
    if (["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].indexOf(e.key) < 0) return;
    e.preventDefault();
    const items = [...sfPop.querySelectorAll("button")].filter((b) => !b.hidden);
    const i = items.indexOf(document.activeElement), fwd = e.key === "ArrowRight" || e.key === "ArrowDown";
    const next = items[(i + (fwd ? 1 : items.length - 1)) % items.length];
    if (next) next.focus();
  });
  // Tab 移出面板即收(焦點已跟著走,不搶回來)
  sfPop.addEventListener("focusout", (e) => { if (!sfPop.hidden && !sfPop.contains(e.relatedTarget)) sfPopClose(false); });
  document.body.appendChild(sfPop);
}
// 字在每次開啟時填(換語言不必重建面板)
function sfPopText() {
  sfPop.setAttribute("aria-label", t("side.flagSet"));
  sfPop.querySelectorAll(".swcell").forEach((c) => { const n = t(SF_COLORS[Number(c.dataset.flag)]); c.setAttribute("aria-label", n); c.querySelector(".tip").textContent = n; });
  const [rm, del] = sfPop.querySelectorAll(".item");
  rm.textContent = t("side.flagRemove");
  del.textContent = t(window.blave.platform === "win32" ? "strat.del.win" : "strat.del");
}
function sfPopOpen(wrap, anchor, x, ctx) {
  if (!sfPop) sfPopBuild();
  sfPopClose(false);   // 換列重開:先收上一個
  sfPopText();
  const del = wrap.querySelector(".cs-del"), showDel = !!ctx && !!del && !del.disabled;   // 回合中 ✕ 收起,刪除那條也不給
  sfPop.querySelectorAll("[data-ctx]").forEach((n) => { n.hidden = !showDel; });
  SF.popWrap = wrap; SF.popReturn = anchor; SF.popX = x;
  const cur = sfFlagId(SF.flags[x.name]);
  sfPop.querySelectorAll(".swcell").forEach((c) => { const on = Number(c.dataset.flag) === cur; c.classList.toggle("selected", on); c.setAttribute("aria-checked", on ? "true" : "false"); });
  wrap.classList.add("flag-open");
  // 先隱形量尺寸再定位:錨旗標鈕下 8px、右緣對齊旗標鈕;下方不夠翻上;clamp 進視窗
  sfPop.hidden = false; sfPop.classList.remove("open"); sfPop.style.visibility = "hidden";
  const pw = sfPop.offsetWidth, ph = sfPop.offsetHeight, r = anchor.getBoundingClientRect();
  let left = r.right - pw, top = r.bottom + 8, up = false;
  if (top + ph > window.innerHeight - 8) { up = true; top = r.top - 8 - ph; }
  left = Math.max(8, Math.min(left, window.innerWidth - 8 - pw)); top = Math.max(8, top);
  sfPop.style.left = left + "px"; sfPop.style.top = top + "px";
  sfPop.classList.toggle("up", up); sfPop.style.visibility = "";
  requestAnimationFrame(() => sfPop.classList.add("open"));
  const to = sfPop.querySelector(".swcell.selected") || sfPop.querySelector(".swcell");
  if (to) to.focus();
}
function sfPopClose(restoreFocus) {
  if (!sfPop || sfPop.hidden) return;
  // 收合不做離場動效:重繪 / 捲動 / 拖拉場景要立即消失,錨點已不可靠
  sfPop.classList.remove("open"); sfPop.hidden = true;
  if (SF.popWrap) SF.popWrap.classList.remove("flag-open");
  const ret = SF.popReturn;
  SF.popWrap = null; SF.popReturn = null; SF.popX = null;
  if (restoreFocus !== false && ret && document.contains(ret)) ret.focus();
}
// 外點 / 捲動 / 改窗即收——fixed 定位不跟捲動,留著會漂在錯的位置
document.addEventListener("pointerdown", (e) => {
  if (!sfPop || sfPop.hidden || sfPop.contains(e.target)) return;
  const onBtn = e.target.closest && e.target.closest(".strat-flagbtn");
  SF.popJustClosed = onBtn && onBtn === SF.popReturn ? onBtn : null;
  sfPopClose(false);
});
window.addEventListener("resize", () => sfPopClose(false));
$("strat-list").addEventListener("scroll", () => sfPopClose(false));

/* ── 拖拉排序:整列即把手,>6px 位移 = 拖、否則 = 原本的點選;鄰列用 transform 讓位(讓位本身就是落點回饋,不畫插入線)。
   pointer events(同 web),不用 HTML5 DnD。只認 #strat-list 的直接子列 */
function sfMoved() {
  SF.order = [...$("strat-list").querySelectorAll(":scope > .strat-wrap")].map((w) => w.dataset.name).filter(Boolean);
  RP.list = sfApplyOrder(RP.list, SF.order);   // stratRefreshAt 用 RP.list 的位置找同一列
  trackFeature("strat_reorder");
  sfSave("order");
}
function sfBindDrag(box) {
  const finish = () => { SF.dragActive = false; document.body.classList.remove("is-dragging"); const ws = SF.waiters; SF.waiters = []; ws.forEach((r) => r()); };
  box.addEventListener("pointerdown", (e) => {
    if (SF.dragPointer !== null || e.button !== 0) return;   // 已有一輪在途(含門檻前)
    const row = e.target.closest(".strat-wrap");
    if (!row || row.parentElement !== box) return;
    if (e.target.closest(".cs-del, .strat-flagbtn")) return;   // 鈕上起手不算
    const startY = e.clientY;
    let dragging = false, rows, from, to, rowH;
    const onMove = (ev) => {
      if (ev.pointerId !== SF.dragPointer) return;
      const dy = ev.clientY - startY;
      if (!dragging) {
        if (Math.abs(dy) < 6) return;
        if (row.parentElement !== box) { cleanup(); return; }   // 門檻前列被重繪拔掉:放棄這次
        dragging = true; SF.dragActive = true;
        sfPopClose(false);
        document.body.classList.add("is-dragging"); row.classList.add("dragging");
        rows = [...box.querySelectorAll(":scope > .strat-wrap")]; from = to = rows.indexOf(row); rowH = row.offsetHeight;
        rows.forEach((r) => { if (r !== row) r.classList.add("shifting"); });
      }
      const c = Math.max(-from * rowH, Math.min((rows.length - 1 - from) * rowH, dy));   // 夾在清單頭尾
      row.style.transform = "translateY(" + c + "px)";
      to = from + Math.round(c / rowH);
      rows.forEach((r, j) => {
        if (r === row) return;
        let s = 0;
        if (from < to && j > from && j <= to) s = -rowH; else if (from > to && j >= to && j < from) s = rowH;
        r.style.transform = s ? "translateY(" + s + "px)" : "";
      });
    };
    // 拆班收尾;回傳「剛才真的在拖」——門檻沒過就只是解除監聽
    const cleanup = () => {
      SF.dragPointer = null;
      window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); window.removeEventListener("pointercancel", onCancel);
      if (!dragging) return false;
      rows.forEach((r) => { r.classList.remove("shifting"); r.style.transform = ""; });
      row.classList.remove("dragging");
      SF.justDragged = true; setTimeout(() => { SF.justDragged = false; }, 0);   // 放開後緊接的 click 落在拖過的列上:吞掉
      return true;
    };
    const onUp = (ev) => {
      if (ev.pointerId !== SF.dragPointer || !cleanup()) return;
      if (to !== from) { const ref = rows[to]; if (to > from) ref.after(row); else ref.before(row); sfMoved(); }   // 拖回原位 = 不寫
      finish();
    };
    const onCancel = (ev) => { if (ev.pointerId === SF.dragPointer && cleanup()) finish(); };   // 回原位、不 commit
    SF.dragPointer = e.pointerId;
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp); window.addEventListener("pointercancel", onCancel);
  });
  // 鍵盤替代:焦點在列上 Alt+↑/↓ 移一格、焦點跟著列走、同一條寫回
  box.addEventListener("keydown", (e) => {
    if (SF.dragActive || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const row = e.target.closest && e.target.closest(".strat-wrap");
    if (!row || row.parentElement !== box) return;
    e.preventDefault();
    const sib = e.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling;
    if (!sib || !sib.classList.contains("strat-wrap")) return;
    if (e.key === "ArrowUp") sib.before(row); else sib.after(row);
    const b = row.querySelector(".strat-row"); if (b) b.focus();
    sfMoved();
  });
}
sfBindDrag($("strat-list"));
