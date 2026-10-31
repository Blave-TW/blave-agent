/* 側欄策略列的旗標(左軌 2×16 色條)與整列拖拉排序(spec .claude/output/designer/desktop-strat-flags-2026-10;
   視覺與行為照雲端工作頁 workspace.html 的 stratOrder / stratFlags / bindRowDrag / buildFlagPop 同一套,差別只在電腦版既有解剖:
   .strat-wrap(容器)> .strat-row(名字鈕)+ .strat-flagbtn(本案新增)+ .cs-del(✕ 會武裝)。
   在 app.js 之後載入(用它的 $、t、RP、stratTip、trackFeature)。
   兩份清單各一個 store(SF_LOCAL / SF_CLOUD),旗標面板、拖拉、Alt+↑/↓ 共用同一套:
   這台電腦的存 ui-prefs.json(主行程 strat-prefs / strat-prefs-set;不進 workspace、不寫 localStorage);
   雲端 tab 讀寫帳號上的 strat_order / strat_flags(= 網頁工作頁那一份;api /cloud/prefs,trade.js envPaintSide 掛列)。
   順序 / 旗標是偏好不是資料:寫失敗不回滾、不彈錯,本 session 靠記憶體值維持。 */
const SF = { order: [], flags: {}, groups: { v: 1, folders: [], map: {} }, coll: { local: [], cloud: [] }, ready: null, dragActive: false, dragPointer: null, justDragged: false, waiters: [], timer: null, dirty: new Set(),
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
/* 側欄策略資料夾的分組(spec strategy-sidebar-folders §3;網頁 tests/strat_folders_vectors.json 是兩邊同一份測資,tests/check_web_desktop_parity.js 跑)。
   list = 已套過順序的清單;回 [{ id, name, emoji, items }],資料夾照 folders 的順序、未分類(id "_u")固定最後。
   組內順序照 list;map 指向不存在的資料夾 = 未分類;map 裡不在 list 的名字略過;空資料夾照樣回(畫面要有落點) */
function sgBuild(list, groups) {
  const folders = groups && Array.isArray(groups.folders) ? groups.folders : [];
  const map = groups && groups.map && typeof groups.map === "object" ? groups.map : {};
  const out = folders.map((f) => ({ id: f.id, name: f.name, emoji: f.emoji == null ? null : f.emoji, items: [] }));
  const byId = new Map(out.map((g) => [g.id, g])), uncat = { id: "_u", name: null, emoji: null, items: [] };
  (Array.isArray(list) ? list : []).forEach((x) => {
    if (!x || typeof x.name !== "string") return;
    const g = Object.prototype.hasOwnProperty.call(map, x.name) ? byId.get(map[x.name]) : null;
    (g || uncat).items.push(x);
  });
  out.push(uncat);
  return out;
}
// 存檔與 api 都寬容收 1–6(六色期留下的),畫面只畫 1–3;其餘當沒有
function sfFlagId(v) { return Number.isInteger(v) && v >= 1 && v <= 3 ? v : null; }

function sfReady() {
  if (!SF.ready) SF.ready = window.blave.stratPrefs().then((p) => {
    if (!p || typeof p !== "object") return;
    SF.order = Array.isArray(p.stratOrder) ? p.stratOrder : [];
    SF.flags = p.stratFlags && typeof p.stratFlags === "object" && !Array.isArray(p.stratFlags) ? p.stratFlags : {};
    if (p.stratGroups && Array.isArray(p.stratGroups.folders)) SF.groups = p.stratGroups;
    if (p.stratGroupsCollapsed && typeof p.stratGroupsCollapsed === "object") SF.coll = { local: p.stratGroupsCollapsed.local || [], cloud: p.stratGroupsCollapsed.cloud || [] };
    if (typeof ENV !== "undefined" && ENV.sig) ENV.sig.side = null;   // 雲端清單不等偏好就先畫過:收合狀態到了要重建一次(sig 不含收合)
  }, () => {});
  return SF.ready;
}
// 資料夾編輯列開著(含它開出的 emoji 選擇器):重建會把編輯列拔掉、打的字會丟(spec §6 編輯中延後重建)
const sgEditing = () => typeof SG !== "undefined" && SG.editing;
// stratRefresh 重建列之前:偏好要讀好(第一次畫就是對的順序)、拖拉中或編輯資料夾中等結束(列拔掉會殺掉進行中的拖拉)、旗標面板開著先收(錨點會失效)
function sfBeforeRebuild() {
  sfPopClose(false);
  return Promise.all([sfReady(), SF.dragActive || sgEditing() ? new Promise((r) => SF.waiters.push(r)) : null]);
}
// 拖拉或編輯列結束:放行排著的重建。兩件事都結束才放,否則重建會殺掉另一件
function sfFlushWaiters() {
  if (SF.dragActive || sgEditing()) return;
  const ws = SF.waiters; SF.waiters = []; ws.forEach((r) => r());
}
function sfSave(key) {
  SF.dirty.add(key);
  clearTimeout(SF.timer);
  SF.timer = setTimeout(() => {
    const w = {};
    if (SF.dirty.has("order")) w.stratOrder = SF.order;
    if (SF.dirty.has("flags")) w.stratFlags = SF.flags;
    if (SF.dirty.has("groups")) w.stratGroups = SF.groups;
    if (SF.dirty.has("coll")) w.stratGroupsCollapsed = SF.coll;
    SF.dirty.clear();
    window.blave.stratPrefsSet(w).catch(() => {});
  }, SF_SAVE_MS);
}
// 刪除成功順手清掉該名字的項(殘鍵無害,但別留垃圾)
function sfForget(name) {
  if (SF.order.indexOf(name) >= 0) { SF.order = SF.order.filter((n) => n !== name); sfSave("order"); }
  if (name in SF.flags) { delete SF.flags[name]; sfSave("flags"); }
  if (name in SF.groups.map) { const m = { ...SF.groups.map }; delete m[name]; SF.groups = { ...SF.groups, map: m }; sfSave("groups"); }
}
// 本機視角的市場:常駐程式回報的 strategy_kinds(還沒回報 = 全部未知,「建市場資料夾」不出現)
function sfLocalMarket(name) {
  const r = typeof TR_BAGS !== "undefined" && TR_BAGS.local.st ? TR_BAGS.local.st.report : null;
  const k = r && r.strategy_kinds && typeof r.strategy_kinds === "object" ? r.strategy_kinds[name] : null;
  return k && typeof k.market === "string" ? k.market : null;
}

const SF_LOCAL = {
  box: () => $("strat-list"),
  flags: () => SF.flags,
  setFlag(name, id) { if (id) SF.flags[name] = id; else delete SF.flags[name]; sfSave("flags"); },
  moved(names) { SF.order = names; RP.list = sfApplyOrder(RP.list, SF.order); sfSave("order"); },   // stratRefreshAt 用 RP.list 的位置找同一列
  delLabel: () => t(window.blave.platform === "win32" ? "strat.del.win" : "strat.del"),
  directDel: false,   // ✕ 第一下是武裝(app.js armedDelete)
  env: "local",
  last: [],   // 上一次畫的清單(已套序),資料夾操作原地重排用
  groups: () => SF.groups,
  setGroups(g) { SF.groups = g; sfSave("groups"); },
  market: (x) => sfLocalMarket(x.name),
};

/* ── 雲端 tab:api 狀態信封的 strat_order / strat_flags 上面疊一層記憶體覆蓋(SFC.over)。
   本機剛改的值在寫回成功、而且主行程那份信封已經換上(值相同,或之後又抓過一次)之前都以覆蓋為準——
   否則下一次重畫會讀到舊信封、旗標跳回去。寫失敗 / 舊 api 不收:覆蓋留到換帳號為止(fail-soft)。 */
const SFC = { epoch: undefined, over: {}, syncedAt: {}, cur: { order: [], flags: {}, groups: { v: 1, folders: [], map: {} } }, names: null, dirty: new Set(), timer: null, held: false };
const SFC_KEYS = { order: "strat_order", flags: "strat_flags", groups: "strat_groups" };
function sfCloudPrefs(snap) {
  const ep = snap ? snap.epoch : undefined;
  if (typeof ep === "number" && ep !== SFC.epoch) { SFC.epoch = ep; SFC.over = {}; SFC.syncedAt = {}; SFC.dirty.clear(); clearTimeout(SFC.timer); }   // 換人 / 登出:上一個人的覆蓋不能帶過去
  const api = { order: snap && Array.isArray(snap.strat_order) ? snap.strat_order : [], flags: snap && snap.strat_flags && typeof snap.strat_flags === "object" && !Array.isArray(snap.strat_flags) ? snap.strat_flags : {},
    groups: snap && snap.strat_groups && Array.isArray(snap.strat_groups.folders) ? snap.strat_groups : { v: 1, folders: [], map: {} } };
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
   旗標與資料夾歸屬只在清單完整時濾掉不存在的名字(主機停機、清單讀不全時濾會吃掉真的歸屬);順序來自畫面上的列,只截長度 */
function sfCloudTrim(k, v) {
  if (k === "order") return v.slice(0, 200);
  const names = SFC.names, keep = (o) => Object.fromEntries(Object.entries(o).filter(([n]) => !names || names.has(n)).slice(0, 200));
  return k === "groups" ? { v: 1, folders: v.folders, map: keep(v.map) } : keep(v);
}
function sfCloudFlush(retry) {
  const p = { epoch: SFC.epoch }, sent = {}, ep = SFC.epoch;
  SFC.dirty.forEach((k) => { sent[k] = SFC.over[k]; p[SFC_KEYS[k]] = sfCloudTrim(k, SFC.over[k]); });
  SFC.dirty.clear();
  Promise.resolve(window.blave.cloudStratPrefsSet(p)).then((r) => {
    if (!r || ep !== SFC.epoch) return;
    const live = Object.keys(sent).filter((k) => SFC.over[k] === sent[k]);   // 送出之後又改過的鍵換了新物件、下一包已排好:不放手、不補送
    // groupsOff = 舊 api 收了順序／旗標、丟掉資料夾:資料夾不標已同步,否則下一輪輪詢會把覆蓋清掉、資料夾消失
    if (r.ok === true) { live.forEach((k) => { if (!(k === "groups" && r.groupsOff)) SFC.syncedAt[k] = Date.now(); }); return; }
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
  if (name in c.groups.map) { const m = { ...c.groups.map }; delete m[name]; SFC.over.groups = c.groups = { ...c.groups, map: m }; sfCloudSave("groups"); }
}
const SF_CLOUD = {
  box: () => $("strat-list-cloud"),
  flags: () => SFC.cur.flags,
  setFlag(name, id) { const f = { ...SFC.cur.flags }; if (id) f[name] = id; else delete f[name]; SFC.over.flags = SFC.cur.flags = f; sfCloudSave("flags"); },
  moved(names) { SFC.over.order = SFC.cur.order = names; sfCloudSave("order"); },
  delLabel: () => t("menu.delete"),
  directDel: true,   // 雲端 ✕ 按下直接開確認框(trade.js cdelAsk),不在列內武裝
  env: "cloud",
  last: [],
  groups: () => SFC.cur.groups,
  setGroups(g) { SFC.over.groups = SFC.cur.groups = g; sfCloudSave("groups"); },
  market: (x) => x.srcMarket || null,
};
/* envPaintSide 整個清單重建之前問一次:拖拉中或資料夾編輯列開著 → 不建(會殺掉進行中的拖拉／編輯列),結束補畫一次;面板開在雲端列上 → 先收(錨點會失效) */
function sfCloudHold(repaint) {
  if (SF.dragActive || sgEditing()) {
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
  // 移到資料夾(給不能拖的人;spec §13):有資料夾才出,內容每次開啟時由 stratgroups.js sgMoveFill 填
  const dm = sep(), moves = document.createElement("div"); dm.dataset.mv = "1"; moves.className = "sg-moves"; moves.dataset.mv = "1";
  sfPop.append(d1, rm, dm, moves, d2, del);   // 鍵盤排序提示那行 Wei 10-12 拿掉(Alt+↑/↓ 仍可用,只是不印)
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
  sfPop.querySelector(".item[data-rm]").textContent = t("side.flagRemove");
  sfPop.querySelector(".item[data-ctx]").textContent = (sc || SF_LOCAL).delLabel();
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
  const mv = typeof sgMoveFill === "function" && sgMoveFill(sfPop.querySelector(".sg-moves"), wrap, x, sc);
  sfPop.querySelectorAll("[data-mv]").forEach((n) => { n.hidden = !mv; });
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
  const path = e.composedPath();   // 「移到資料夾」那段每次開啟清空重建:用派送當下的路徑判斷,不靠 contains / closest
  if (!sfPop || sfPop.hidden || path.indexOf(sfPop) >= 0) return;
  const onBtn = path.find((n) => n.classList && n.classList.contains("strat-flagbtn"));
  SF.popJustClosed = onBtn && onBtn === SF.popReturn ? onBtn : null;
  sfPopClose(false);
});
window.addEventListener("resize", () => sfPopClose(false));
$("strat-list").addEventListener("scroll", () => sfPopClose(false));
$("strat-list-cloud").addEventListener("scroll", () => sfPopClose(false));

/* ── 拖拉排序:整列即把手,>6px 位移 = 拖、否則 = 原本的點選;鄰列用 transform 讓位(讓位本身就是落點回饋,不畫插入線)。
   pointer events(同 web),不用 HTML5 DnD。只認清單的直接子列。
   有資料夾時組標題(.sg-head)是同一層的兄弟節點,也是落點(spec strategy-sidebar-folders §6 拖拉):
   落點每次 pointermove 拿指標 y 比可見節點——列用起手時存的基準矩形(不含讓位的 transform,捲動補 scrollTop 差,否則列一讓位落點就翻回來),
   組標題用即時矩形(釘頂中的也算,疊在一起時取 DOM 最後那個 = 畫面最上面那個)。指到組標題 = 該組最底;列的上半 = 排在它前、下半 = 排在它後 */
// 寫回:畫面由上到下的列(含收合組裡 hidden 的列)。資料夾換序、刪資料夾、建市場資料夾也走這條,但不送 strat_reorder
function sfWriteOrder(sc) {
  sc.moved([...sc.box().querySelectorAll(":scope > .strat-wrap")].map((w) => w.dataset.name).filter(Boolean));
}
function sfMoved(sc) {
  trackFeature("strat_reorder");
  sfWriteOrder(sc);
}
// 可見的列與組標題(收合組的列是 hidden,不參與計位)
function sfNodes(box) { return [...box.children].filter((n) => !n.hidden && (n.classList.contains("strat-wrap") || n.classList.contains("sg-head"))); }
// 一列屬於哪一組:往上第一個組標題的 id;沒有組標題(沒開資料夾)= null
function sfGroupOf(node) {
  for (let n = node.previousElementSibling; n; n = n.previousElementSibling) if (n.classList.contains("sg-head")) return n.dataset.gid;
  return null;
}
// 歸屬改了才寫(未分類 = 從 map 拿掉);回傳有沒有改
function sfSetGroup(sc, name, gid) {
  const g = sc.groups(), want = gid && gid !== "_u" ? gid : null, had = Object.prototype.hasOwnProperty.call(g.map, name) ? g.map[name] : null;
  if (want === had) return false;
  const map = { ...g.map };
  if (want) map[name] = want; else delete map[name];
  sc.setGroups({ v: 1, folders: g.folders, map });
  return true;
}
const SF_EDGE = 44, SF_SCROLL_MAX = 8;   // 靠邊自動捲動:進入上下緣 44px 開始,速度隨深入線性增加、每幀上限 8px
function sfBindDrag(box, sc) {
  const finish = () => { SF.dragActive = false; document.body.classList.remove("is-dragging"); sfFlushWaiters(); };
  box.addEventListener("pointerdown", (e) => {
    if (SF.dragPointer !== null || e.button !== 0) return;   // 已有一輪在途(含門檻前)
    const row = e.target.closest(".strat-wrap");
    if (!row || row.parentElement !== box) return;
    if (e.target.closest(".cs-del, .strat-flagbtn")) return;   // 鈕上起手不算
    const startY = e.clientY;
    let dragging = false, others, base, from, rowH, s0, lim, drop = { home: true }, px = e.clientX, py = e.clientY, raf = 0, lit = null;
    const sd = () => box.scrollTop - s0;
    const stuck = (n) => base.get(n).top - sd() < box.getBoundingClientRect().top - 0.5;   // 釘頂中的組標題:不讓位
    const pick = () => {
      const br = box.getBoundingClientRect();
      if (py < br.top || py >= br.bottom || px < br.left || px >= br.right) return null;   // 指標離開清單:沒有落點,放開 = 取消
      let head = null;
      for (const n of others) if (n.classList.contains("sg-head")) { const r = n.getBoundingClientRect(); if (py >= r.top && py < r.bottom) head = n; }
      if (head) return { head };
      for (const n of others) {
        if (!n.classList.contains("strat-wrap")) continue;
        const b = base.get(n), top = b.top - sd(), bot = b.bottom - sd();
        if (py >= top && py < bot) return { ref: n, after: py >= (top + bot) / 2 };
      }
      return drop;   // 起手那一格、組距縫:沿用上一個落點,不抖
    };
    const update = () => {
      const dy = Math.max(lim[0], Math.min(lim[1], py - startY + sd()));   // 夾在清單頭尾
      row.style.transform = "translateY(" + dy + "px)";
      drop = pick();
      let p = from;
      if (drop && drop.ref) p = others.indexOf(drop.ref) + (drop.after ? 1 : 0);
      if (lit && (!drop || drop.head !== lit)) { lit.classList.remove("sg-drop"); lit = null; }
      if (drop && drop.head) { lit = drop.head; lit.classList.add("sg-drop"); p = from; }   // 組標題當落點:讓位全部歸零,只填色
      others.forEach((n, j) => {
        let v = 0;
        if (!(n.classList.contains("sg-head") && stuck(n))) { if (p > from && j >= from && j < p) v = -rowH; else if (p < from && j >= p && j < from) v = rowH; }
        n.style.transform = v ? "translateY(" + v + "px)" : "";
      });
    };
    const tick = () => {
      raf = 0;
      if (!dragging) return;
      const br = box.getBoundingClientRect();
      let v = 0;
      if (px >= br.left && px < br.right) {
        if (py >= br.top && py < br.top + SF_EDGE) v = -Math.min(SF_SCROLL_MAX, Math.ceil((SF_SCROLL_MAX * (br.top + SF_EDGE - py)) / SF_EDGE));
        else if (py < br.bottom && py >= br.bottom - SF_EDGE) v = Math.min(SF_SCROLL_MAX, Math.ceil((SF_SCROLL_MAX * (py - br.bottom + SF_EDGE)) / SF_EDGE));
      }
      if (!v) return;
      const was = box.scrollTop; box.scrollTop = was + v;
      if (box.scrollTop === was) return;   // 到頭
      update();   // 指標沒動也要重算:這一幀沒有 pointermove
      raf = requestAnimationFrame(tick);
    };
    const onMove = (ev) => {
      if (ev.pointerId !== SF.dragPointer) return;
      px = ev.clientX; py = ev.clientY;
      if (!dragging) {
        if (Math.abs(py - startY) < 6) return;
        if (row.parentElement !== box) { cleanup(); return; }   // 門檻前列被重繪拔掉:放棄這次
        dragging = true; SF.dragActive = true;
        sfPopClose(false);
        document.body.classList.add("is-dragging"); row.classList.add("dragging");
        const nodes = sfNodes(box);
        others = nodes.filter((n) => n !== row); from = nodes.indexOf(row); rowH = row.offsetHeight; s0 = box.scrollTop;
        base = new Map(nodes.map((n) => { const r = n.getBoundingClientRect(); return [n, { top: r.top, bottom: r.bottom }]; }));
        const rb = base.get(row);
        lim = [base.get(nodes[0]).top - rb.top, base.get(nodes[nodes.length - 1]).bottom - rb.bottom];
        others.forEach((n) => n.classList.add("shifting"));
      }
      update();
      if (!raf) raf = requestAnimationFrame(tick);
    };
    // 拆班收尾;回傳「剛才真的在拖」——門檻沒過就只是解除監聽
    const cleanup = () => {
      SF.dragPointer = null;
      window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); window.removeEventListener("pointercancel", onCancel); window.removeEventListener("keydown", onKey, true);
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (!dragging) return false;
      others.forEach((r) => { r.classList.remove("shifting"); r.style.transform = ""; });
      if (lit) lit.classList.remove("sg-drop");
      row.style.transform = ""; row.classList.remove("dragging");
      SF.justDragged = true; setTimeout(() => { SF.justDragged = false; }, 0);   // 放開後緊接的 click 落在拖過的列上:吞掉
      return true;
    };
    const commit = (d) => {
      if (!d || d.home) return;   // 拖回原位 / 離開清單 = 不寫
      const g0 = sfGroupOf(row), order0 = [...box.querySelectorAll(":scope > .strat-wrap")];
      if (d.head) {
        let last = d.head;   // 該組最底(含收合組 hidden 的列)
        for (let n = d.head.nextElementSibling; n && n.classList.contains("strat-wrap"); n = n.nextElementSibling) if (n !== row) last = n;
        last.after(row);
        row.hidden = d.head.classList.contains("is-collapsed");   // 放下不展開:列跟著收,組標題支數 +1
      } else if (d.after) d.ref.after(row); else d.ref.before(row);
      const g1 = sfGroupOf(row), moved = g1 !== g0 && sfSetGroup(sc, row.dataset.name, g1);
      const reordered = [...box.querySelectorAll(":scope > .strat-wrap")].some((w, i) => w !== order0[i]);
      if (moved) { trackFeature("sfolder_move"); sfWriteOrder(sc); } else if (reordered) sfMoved(sc);
      if (typeof sgHeadsSync === "function") sgHeadsSync(box);
    };
    const onUp = (ev) => {
      if (ev.pointerId !== SF.dragPointer) return;
      const d = drop;
      if (!cleanup()) return;
      commit(d);
      finish();
    };
    const onCancel = (ev) => { if (ev.pointerId === SF.dragPointer && cleanup()) finish(); };   // 回原位、不 commit
    const onKey = (ev) => { if (ev.key === "Escape" && dragging) { ev.preventDefault(); ev.stopPropagation(); if (cleanup()) finish(); } };
    SF.dragPointer = e.pointerId;
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp); window.addEventListener("pointercancel", onCancel); window.addEventListener("keydown", onKey, true);
  });
  // 鍵盤替代:焦點在列上 Alt+↑/↓ 移一格、焦點跟著列走、同一條寫回。有資料夾時到組邊緣跨到相鄰組(上 = 進上一組最底、下 = 進下一組最頂);
  // 目標組收合時列進去後焦點移到該組標題。焦點在組標題上 = 資料夾換序(stratgroups.js)
  box.addEventListener("keydown", (e) => {
    if (SF.dragActive || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const up = e.key === "ArrowUp", head = e.target.closest && e.target.closest(".sg-head");
    if (head && head.parentElement === box) { e.preventDefault(); if (typeof sgMoveFolder === "function") sgMoveFolder(sc, head.dataset.gid, up ? -1 : 1); return; }
    const row = e.target.closest && e.target.closest(".strat-wrap");
    if (!row || row.parentElement !== box) return;
    e.preventDefault();
    const sib = up ? row.previousElementSibling : row.nextElementSibling;
    if (!sib) return;
    let into = null;   // 跨組時的目標組標題
    if (sib.classList.contains("strat-wrap")) { if (up) sib.before(row); else sib.after(row); }
    else if (sib.classList.contains("sg-head")) {
      if (up) {
        const prev = sib.previousElementSibling;
        if (!prev || !(prev.classList.contains("strat-wrap") || prev.classList.contains("sg-head"))) return;   // 已在第一組
        into = prev.classList.contains("sg-head") ? prev : box.querySelector(':scope > .sg-head[data-gid="' + sfGroupOf(prev) + '"]');
        sib.before(row);
      } else { into = sib; sib.after(row); }
      row.hidden = !!into && into.classList.contains("is-collapsed");
    } else return;
    const moved = into && sfSetGroup(sc, row.dataset.name, into.dataset.gid);
    const b = row.hidden ? into.querySelector(".sg-tog") : row.querySelector(".strat-row");
    if (b) b.focus();
    if (moved) { trackFeature("sfolder_move"); sfWriteOrder(sc); srSay(t("sg.moved", { name: into.dataset.label || "" })); }
    else { sfMoved(sc); srSay(t("side.moved", { n: [...box.querySelectorAll(":scope > .strat-wrap")].indexOf(row) + 1 })); }
    if (typeof sgHeadsSync === "function") sgHeadsSync(box);
  });
}
sfBindDrag($("strat-list-cloud"), SF_CLOUD);
sfBindDrag($("strat-list"), SF_LOCAL);
// 重載時 app.js 的開機 IIFE 往往在這支載入前就畫過側欄(IPC 回得比中間那八支 script 讀檔快,stratRefresh 的 typeof 守衛會靜默跳過):
// 偏好一到,畫過的列就重畫一次,不然要等下一輪 stratRefresh(回合結束、切語言)才對。還沒畫過的不碰:之後那次會自己 await sfBeforeRebuild
sfReady().then(() => { if ($("strat-list").querySelector(".strat-wrap")) stratRefresh(false); });
