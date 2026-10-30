/* 側欄策略列的旗標(左軌 2×16 色條)與整列拖拉排序(spec .claude/output/designer/desktop-strat-flags-2026-10;
   視覺與行為照雲端工作頁 workspace.html 的 stratOrder / stratFlags / bindRowDrag / buildFlagPop 同一套,差別只在電腦版既有解剖:
   .strat-wrap(容器)> .strat-row(名字鈕)+ .strat-flagbtn(本案新增)+ .cs-del(✕ 會武裝)。
   在 app.js 之後載入(用它的 $、t、RP、stratTip、trackFeature)。
   兩份清單各一個 store(SF_LOCAL / SF_CLOUD),旗標面板、拖拉、Alt+↑/↓ 共用同一套:
   這台電腦的存 ui-prefs.json(主行程 strat-prefs / strat-prefs-set;不進 workspace、不寫 localStorage);
   雲端 tab 讀寫帳號上的 strat_order / strat_flags(= 網頁工作頁那一份;api /cloud/prefs,trade.js envPaintSide 掛列)。
   順序 / 旗標是偏好不是資料:寫失敗不回滾、不彈錯,本 session 靠記憶體值維持。 */
const SF = { order: [], flags: {}, ready: null, dragActive: false, dragPointer: null, justDragged: false, waiters: [], timer: null, dirty: new Set(),
  popWrap: null, popReturn: null, popX: null, popStore: null, popJustClosed: null };
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
// 面板從旗標鈕下方長出來:左緣對齊鈕的左緣、鈕下 8;下方不夠翻上;clamp 進視窗。
// 右緣對齊鈕(舊)時面板往左長、貼到列的左緣,蓋住下一列的名字(0.1.29 e2e 稽核建議 3)
function sfPopPlace(r, pw, ph, iw, ih) {
  let left = r.left, top = r.bottom + 8, up = false;
  if (top + ph > ih - 8) { up = true; top = r.top - 8 - ph; }
  left = Math.max(8, Math.min(left, iw - 8 - pw)); top = Math.max(8, top);
  return { left, top, up };
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

const SF_LOCAL = {
  box: () => $("strat-list"),
  flags: () => SF.flags,
  setFlag(name, id) { if (id) SF.flags[name] = id; else delete SF.flags[name]; sfSave("flags"); },
  moved(names) { SF.order = names; RP.list = sfApplyOrder(RP.list, SF.order); sfSave("order"); },   // stratRefreshAt 用 RP.list 的位置找同一列
  delLabel: () => t(window.blave.platform === "win32" ? "strat.del.win" : "strat.del"),
  directDel: false,   // ✕ 第一下是武裝(app.js armedDelete)
};

/* ── 雲端 tab:api 狀態信封的 strat_order / strat_flags 上面疊一層記憶體覆蓋(SFC.over)。
   本機剛改的值在寫回成功、而且主行程那份信封已經換上(值相同,或之後又抓過一次)之前都以覆蓋為準——
   否則下一次重畫會讀到舊信封、旗標跳回去。寫失敗 / 舊 api 不收:覆蓋留到換帳號為止(fail-soft)。 */
const SFC = { epoch: undefined, over: {}, syncedAt: {}, cur: { order: [], flags: {} }, names: null, dirty: new Set(), timer: null, held: false };
const SFC_KEYS = { order: "strat_order", flags: "strat_flags" };
function sfCloudPrefs(snap) {
  const ep = snap ? snap.epoch : undefined;
  if (typeof ep === "number" && ep !== SFC.epoch) { SFC.epoch = ep; SFC.over = {}; SFC.syncedAt = {}; SFC.dirty.clear(); clearTimeout(SFC.timer); }   // 換人 / 登出:上一個人的覆蓋不能帶過去
  const api = { order: snap && Array.isArray(snap.strat_order) ? snap.strat_order : [], flags: snap && snap.strat_flags && typeof snap.strat_flags === "object" && !Array.isArray(snap.strat_flags) ? snap.strat_flags : {} };
  for (const k of Object.keys(SFC_KEYS)) {
    if (!(k in SFC.over)) continue;
    const at = SFC.syncedAt[k];
    if (at && (JSON.stringify(api[k]) === JSON.stringify(SFC.over[k]) || (snap && snap.fetched_at > at))) { delete SFC.over[k]; delete SFC.syncedAt[k]; }
    else api[k] = SFC.over[k];
  }
  if (typeof ep === "number") {   // 沒有信封的呼叫(picker 的 {})不能把這兩個洗掉:寫回以 cur 為底整份送、names 拿來修剪
    SFC.cur = api;
    SFC.names = snap.strategies_ok && !snap.strategies_partial && Array.isArray(snap.strategies) && snap.strategies.length ? new Set(snap.strategies.map((x) => x && x.name).filter(Boolean)) : null;
  }
  return api;
}
const SF_RETRY_MS = 5000;   // 429 / 連不上之後補送一次的間隔(只補一次;再失敗就照 fail-soft 留在記憶體)
function sfCloudSave(key) {
  SFC.dirty.add(key); delete SFC.syncedAt[key];
  sfCloudArm(SF_SAVE_MS, false);
}
function sfCloudArm(ms, retry) { clearTimeout(SFC.timer); SFC.timer = setTimeout(() => sfCloudFlush(retry), ms); }
/* 送出的是修剪過的副本(api 與主行程都只收 ≤200;網頁或 agent 刪掉的策略留下的舊旗標名會把它撐爆、之後永遠 BAD);覆蓋本身不動,比對用原物件。
   旗標只在清單完整時濾掉不存在的名字(清單讀不全時濾會吃掉真的旗標);順序來自畫面上的列,只截長度 */
function sfCloudTrim(k, v) {
  if (k === "order") return v.slice(0, 200);
  const names = SFC.names;
  return Object.fromEntries(Object.entries(v).filter(([n]) => !names || names.has(n)).slice(0, 200));
}
function sfCloudFlush(retry) {
  const p = { epoch: SFC.epoch }, sent = {}, ep = SFC.epoch;
  SFC.dirty.forEach((k) => { sent[k] = SFC.over[k]; p[SFC_KEYS[k]] = sfCloudTrim(k, SFC.over[k]); });
  SFC.dirty.clear();
  Promise.resolve(window.blave.cloudStratPrefsSet(p)).then((r) => {
    if (!r || ep !== SFC.epoch) return;
    const live = Object.keys(sent).filter((k) => SFC.over[k] === sent[k]);   // 送出之後又改過的鍵換了新物件、下一包已排好:不放手、不補送
    if (r.ok === true) { live.forEach((k) => { SFC.syncedAt[k] = Date.now(); }); return; }
    if (retry || (r.code !== "RATE_LIMITED" && r.code !== "FAIL") || !live.length) return;
    const pending = SFC.dirty.size > 0;   // 已有一包排著:併進去,不把它延後
    live.forEach((k) => SFC.dirty.add(k));
    if (!pending) sfCloudArm(SF_RETRY_MS, true);
  }, () => {});
}
function sfCloudForget(name) {
  const c = SFC.cur;
  if (c.order.indexOf(name) >= 0) { SFC.over.order = c.order = c.order.filter((n) => n !== name); sfCloudSave("order"); }
  if (name in c.flags) { const f = { ...c.flags }; delete f[name]; SFC.over.flags = c.flags = f; sfCloudSave("flags"); }
}
const SF_CLOUD = {
  box: () => $("strat-list-cloud"),
  flags: () => SFC.cur.flags,
  setFlag(name, id) { const f = { ...SFC.cur.flags }; if (id) f[name] = id; else delete f[name]; SFC.over.flags = SFC.cur.flags = f; sfCloudSave("flags"); },
  moved(names) { SFC.over.order = SFC.cur.order = names; sfCloudSave("order"); },
  delLabel: () => t("menu.delete"),
  directDel: true,   // 雲端 ✕ 按下直接開確認框(trade.js cdelAsk),不在列內武裝
};
/* envPaintSide 整個清單重建之前問一次:拖拉中 → 不建(會殺掉進行中的拖拉),拖完補畫一次;面板開在雲端列上 → 先收(錨點會失效) */
function sfCloudHold(repaint) {
  if (SF.dragActive) {
    if (!SFC.held) { SFC.held = true; SF.waiters.push(() => { SFC.held = false; repaint(); }); }
    return true;
  }
  if (SF.popStore === SF_CLOUD) sfPopClose(false);
  return false;
}

/* ── 列上的旗標 meta:掛 / 換 / 移除只改 dataset + title + aria,不重建列(本機列與雲端列共用)。
   title 無旗標時 = tipName(全名＋資料夾代號,app.js stratTip);有旗標時「全名 — 旗標：色名」、accessible name「全名，旗標：色名」(色永遠不是唯一管道) */
function sfFlagMeta(wrap, btn, tipName, id) {
  const fid = sfFlagId(id), nm = btn.querySelector(".strat-name");
  wrap.dataset.sfTip = tipName;
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
// 每列叫一次(app.js stratRefresh / trade.js envPaintSide,接在名字鈕之後、✕ 之前):旗標鈕 + 右鍵面板。wrap 掛 data-name 給拖拉寫回與旗標改值找列
function sfRowActions(wrap, btn, x, store) {
  const sc = store || SF_LOCAL;
  wrap.dataset.name = x.name;
  sfFlagMeta(wrap, btn, stratTip(x.displayName, x.name), sc.flags()[x.name]);
  const fb = document.createElement("button");
  fb.type = "button"; fb.className = "strat-flagbtn"; fb.setAttribute("aria-label", t("side.flagSet")); fb.setAttribute("aria-haspopup", "menu"); fb.setAttribute("aria-expanded", "false");
  fb.appendChild(sfIcon());
  fb.addEventListener("click", (e) => {
    e.stopPropagation();
    if (SF.justDragged) return;
    if (SF.popJustClosed === fb) { SF.popJustClosed = null; return; }   // 這下的 pointerdown 剛把自己的面板收掉:click 不重開(toggle)
    sfPopOpen(wrap, fb, x, false, sc);
  });
  wrap.appendChild(fb);
  // 右鍵:同一個面板,底部多一條「移到垃圾桶」(= 把該列的 ✕ 武裝並 focus 到它,之後照兩段式刪除走)
  wrap.addEventListener("contextmenu", (e) => { e.preventDefault(); if (SF.dragActive) return; sfPopOpen(wrap, fb, x, true, sc); });
}
function sfSetFlag(name, id, store) {
  const sc = store || SF_LOCAL, next = sfFlagId(id);
  if (next === sfFlagId(sc.flags()[name])) return;   // 沒變:不寫、不埋
  sc.setFlag(name, next);
  sc.box().querySelectorAll(":scope > .strat-wrap").forEach((w) => {
    const b = w.querySelector(".strat-row");
    // 有旗標時 title 被換成「全名 — 旗標」,原本的 stratTip 記在列上(sfFlagMeta)
    if (w.dataset.name === name && b) sfFlagMeta(w, b, w.dataset.sfTip || name, next);
  });
  trackFeature("strat_flag_set");
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
    c.addEventListener("click", () => { const x = SF.popX, sc = SF.popStore; sfPopClose(true); if (x) sfSetFlag(x.name, id, sc); });
    grid.appendChild(c);
  }
  sfPop.appendChild(grid);
  const sep = () => { const d = document.createElement("div"); d.className = "divider"; d.setAttribute("role", "separator"); return d; };
  const item = (cls) => { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.setAttribute("role", "menuitem"); return b; };
  const rm = item("item");
  rm.addEventListener("click", () => { const x = SF.popX, sc = SF.popStore; sfPopClose(true); if (x) sfSetFlag(x.name, null, sc); });
  const d2 = sep(), del = item("item danger");
  d2.dataset.ctx = "1"; del.dataset.ctx = "1";   // 右鍵才有的那兩個
  del.addEventListener("click", () => {
    const w = SF.popWrap, sc = SF.popStore; sfPopClose(false);
    const x = w && w.querySelector(".cs-del");
    if (!x || x.disabled) return;
    if (sc && sc.directDel) { x.click(); return; }   // 雲端:= 按 ✕(開確認框,框自己管焦點、關掉回到 ✕)
    if (!x.classList.contains("is-armed")) x.click();   // app.js armedDelete:第一下 = 武裝成「移到垃圾桶？」
    x.focus();
  });
  const d1 = sep(); d1.dataset.rm = "1"; rm.dataset.rm = "1";   // 沒有旗標時「移除旗標」連同它上面那條線一起收
  sfPop.append(d1, rm, d2, del);   // 鍵盤排序提示那行 Wei 10-12 拿掉(Alt+↑/↓ 仍可用,只是不印)
  sfPop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (e.isComposing || e.keyCode === 229) return; e.preventDefault(); e.stopPropagation(); sfPopClose(true); return; }   // 不給 app.js 的 escTop:一次只關一層
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
function sfPopText(sc) {
  sfPop.setAttribute("aria-label", t("side.flagSet"));
  sfPop.querySelectorAll(".swcell").forEach((c) => { const n = t(SF_COLORS[Number(c.dataset.flag)]); c.setAttribute("aria-label", n); c.querySelector(".tip").textContent = n; });
  const [rm, del] = sfPop.querySelectorAll(".item");
  rm.textContent = t("side.flagRemove");
  del.textContent = (sc || SF_LOCAL).delLabel();
}
function sfPopOpen(wrap, anchor, x, ctx, store) {
  const sc = store || SF_LOCAL;
  if (!sfPop) sfPopBuild();
  sfPopClose(false);   // 換列重開:先收上一個
  sfPopText(sc);
  const del = wrap.querySelector(".cs-del"), showDel = !!ctx && !!del && !del.disabled;   // 回合中 ✕ 收起,刪除那條也不給
  sfPop.querySelectorAll("[data-ctx]").forEach((n) => { n.hidden = !showDel; });
  SF.popWrap = wrap; SF.popReturn = anchor; SF.popX = x; SF.popStore = sc;
  anchor.setAttribute("aria-expanded", "true");
  const cur = sfFlagId(sc.flags()[x.name]);
  sfPop.querySelectorAll("[data-rm]").forEach((n) => { n.hidden = !cur; });
  sfPop.querySelectorAll(".swcell").forEach((c) => { const on = Number(c.dataset.flag) === cur; c.classList.toggle("selected", on); c.setAttribute("aria-checked", on ? "true" : "false"); });
  wrap.classList.add("flag-open");
  // 先隱形量尺寸再定位(sfPopPlace)
  sfPop.hidden = false; sfPop.classList.remove("open"); sfPop.style.visibility = "hidden";
  const { left, top, up } = sfPopPlace(anchor.getBoundingClientRect(), sfPop.offsetWidth, sfPop.offsetHeight, window.innerWidth, window.innerHeight);
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
  if (ret) ret.setAttribute("aria-expanded", "false");
  SF.popWrap = null; SF.popReturn = null; SF.popX = null; SF.popStore = null;
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
$("strat-list-cloud").addEventListener("scroll", () => sfPopClose(false));

/* ── 拖拉排序:整列即把手,>6px 位移 = 拖、否則 = 原本的點選;鄰列用 transform 讓位(讓位本身就是落點回饋,不畫插入線)。
   pointer events(同 web),不用 HTML5 DnD。只認 #strat-list 的直接子列 */
function sfMoved(sc) {
  trackFeature("strat_reorder");
  sc.moved([...sc.box().querySelectorAll(":scope > .strat-wrap")].map((w) => w.dataset.name).filter(Boolean));
}
function sfBindDrag(box, sc) {
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
      if (to !== from) { const ref = rows[to]; if (to > from) ref.after(row); else ref.before(row); sfMoved(sc); }   // 拖回原位 = 不寫
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
    sfMoved(sc);
    srSay(t("side.moved", { n: [...box.querySelectorAll(":scope > .strat-wrap")].indexOf(row) + 1 }));
  });
}
sfBindDrag($("strat-list-cloud"), SF_CLOUD);
sfBindDrag($("strat-list"), SF_LOCAL);
// 重載時 app.js 的開機 IIFE 往往在這支載入前就畫過側欄(IPC 回得比中間那八支 script 讀檔快,stratRefresh 的 typeof 守衛會靜默跳過):
// 偏好一到,畫過的列就重畫一次,不然要等下一輪 stratRefresh(回合結束、切語言)才對。還沒畫過的不碰:之後那次會自己 await sfBeforeRebuild
sfReady().then(() => { if ($("strat-list").querySelector(".strat-wrap")) stratRefresh(false); });
