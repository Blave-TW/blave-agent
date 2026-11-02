/* 側欄策略資料夾(spec strategy-sidebar-folders-2026-10-30;參照面 = 網頁工作頁)。在 stratflags.js 之後載入,用它的 SF / SF_LOCAL / SF_CLOUD /
   sgBuild / sfNodes / sfGroupOf / sfSetGroup / sfWriteOrder / sfPopPlace / sfFlushWaiters。
   組標題 .sg-head 與列是清單的兄弟節點,絕不包容器(§9):拖拉、寫回、旗標同步、刪除鎖全靠「列是直接子節點」。收合 = 列加 hidden。
   資料只動顯示:不讀不寫 amounts / weights / exchanges,不碰下單(§8)。資料夾名是用戶字串,一律 textContent。 */
const SG = { editing: false, edit: null };
// 72 個 emoji,順序即選擇器順序,每 12 個一類。與 api openclaw/agent_strategies.py _STRAT_GROUP_EMOJI、main.js SG_EMOJI 逐字同一份
const SG_EMOJI = (
  "⭐🔥💡🎯🧪🚀💎🏆📌🔖📦🧩"
  + "📈📉📊💹💰💵💴💶💷🏦🌐🌏"
  + "⏰⏳🔁🔄🔀🔍🧭🔭🌊🎲🧠🔬"
  + "🐂🐻🐳🦈🦅🦊🦉🐢🐇🐝🐙🦄"
  + "🌱🌲🌵🍀🌸🌙⛅🌈🌋🌞☔🍁"
  + "⚓🔑🔧🔨🧰🧲📚📝📎🎁🎨🎈"
);
const SG_EMOJI_LIST = [...SG_EMOJI], SG_EMOJI_SET = new Set(SG_EMOJI_LIST);
const SG_CATS = ["sg.cat.common", "sg.cat.market", "sg.cat.strategy", "sg.cat.animal", "sg.cat.nature", "sg.cat.object"];
// SG_AUTO_MIN:「建市場資料夾」的支數門檻,同網頁 strat_folders.js 的 AUTO_MIN(新增資料夾鈕一律出,不看支數)
const SG_MAX = 20, SG_NAME_MAX = 20, SG_AUTO_MIN = 8, SG_COLS = 6;
// 建市場資料夾(§10):market → [組名字串, 預填 emoji]。不在表上的市場(含空值)留在未分類。
// 組名用自己的 sg.mkt.*(同網頁 workspace_sg_mkt_*):建好就成了用戶的資料夾名,受 20 碼點上限管,不跟策略庫的市場標籤綁在一起
const SG_MARKETS = {
  crypto: ["sg.mkt.crypto", "💎"], tw_index_futures: ["sg.mkt.txf", "📈"], tw_stock_futures: ["sg.mkt.stockFut", "📊"],
  tw_stock: ["sg.mkt.tw", "🏦"], us_stock: ["sg.mkt.us", "💵"], global_futures: ["sg.mkt.global", "🌐"], mixed: ["sg.mkt.mixed", "🧩"],
};
const sgEmojiName = (e) => t("sg.e." + e.codePointAt(0).toString(16).toUpperCase());
const sgStore = () => (typeof ENV !== "undefined" && ENV.cur === "cloud" ? SF_CLOUD : SF_LOCAL);
// 有資料夾就畫組標題,0 支策略也畫(不然剛建的資料夾存進去了卻看不到,Wei 11-02);有沒有策略只影響要不要畫「未分類」
const sgOn = (sc) => sc.groups().folders.length > 0;
function sgEl(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function sgBtn(cls, label) { const b = sgEl("button", cls); b.type = "button"; if (label) b.setAttribute("aria-label", label); return b; }
// lucide folder / folder-plus / inbox / ellipsis(寫死的常數);chevron 是 Accordion 的純 CSS(.sg-chev)
const SG_ICONS = {
  folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
  "folder-plus": ["M12 10v6", "M9 13h6", "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
  inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"],
  ellipsis: ["M12 12h.01", "M19 12h.01", "M5 12h.01"],
};
function sgSvg(name, cls) {
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", cls || "ic"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  for (const d of SG_ICONS[name]) { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); svg.appendChild(p); }
  return svg;
}
// 圖示格:用戶選的 emoji(清單內)或灰色 Lucide folder;不認得的值(新舊版差)畫 folder、資料照留
function sgIconInto(box, emoji) {
  box.textContent = "";
  const ok = typeof emoji === "string" && SG_EMOJI_SET.has(emoji);
  box.classList.toggle("is-emoji", ok);
  if (ok) box.textContent = emoji; else box.appendChild(sgSvg("folder"));
}
function sgNewId(groups) {
  const have = new Set(groups.folders.map((f) => f.id)), abc = "0123456789abcdefghijklmnopqrstuvwxyz";
  for (;;) {
    const r = window.crypto.getRandomValues(new Uint8Array(8));
    const id = "f" + [...r].map((x) => abc[x % 36]).join("");
    if (!have.has(id)) return id;
  }
}
const sgCodepoints = (s) => [...String(s)].length;
function sgSetFolders(sc, folders, map) { const g = sc.groups(); sc.setGroups({ v: 1, folders, map: map || g.map }); }

/* ── 版面:列建好(照清單順序)之後叫,把列照組重排、插組標題、收合的列加 hidden。app.js stratRefresh / trade.js envPaintSide 各叫一次,
   資料夾操作後由 sgRelayout 原地再叫(不必重讀清單)。≤7 支且沒有資料夾 = 跟現在完全一樣(§4) */
function sgLayout(box, sc, list) {
  sc.last = list;
  const ae = document.activeElement, keepHead = ae && box.contains(ae) && ae.closest(".sg-head");
  const keep = keepHead ? { gid: keepHead.dataset.gid, cls: ae.classList.contains("sg-more") ? ".sg-more" : ".sg-tog" } : null;
  box.querySelectorAll(":scope > .sg-head, :scope > .sg-auto").forEach((n) => n.remove());
  const wraps = [...box.querySelectorAll(":scope > .strat-wrap")];
  const on = sgOn(sc);
  box.classList.toggle("has-groups", on);
  if (!on) wraps.forEach((w) => { w.hidden = false; });
  else {
    const byName = new Map(wraps.map((w) => [w.dataset.name, w])), coll = new Set(SF.coll[sc.env]);
    sgBuild(list, sc.groups()).filter((g) => list.length > 0 || g.id !== "_u").forEach((g, i) => {
      const shut = coll.has(g.id);
      box.appendChild(sgHeadEl(g, sc, shut, i === 0));
      g.items.forEach((x) => { const w = byName.get(x.name); if (w) { w.hidden = shut; box.appendChild(w); } });
    });
    sgHeadsSync(box);
  }
  sgAutoSync(box, sc);
  if (keep) { const h = box.querySelector(':scope > .sg-head[data-gid="' + keep.gid + '"]'), b = h && h.querySelector(keep.cls); if (b) b.focus(); }
  else if (ae && ae !== document.activeElement && ae.isConnected && box.contains(ae) && !ae.closest("[hidden]")) ae.focus({ preventScroll: true });   // 列被搬過會失焦:接回去
  if (sc === sgStore()) sgHeadPaint();
}
// 資料夾操作之後原地重排:清單用目前畫面上的順序(拖過、Alt+↑/↓ 過的 sc.last 已舊)
function sgRelayout(sc) {
  const box = sc.box(), names = [...box.querySelectorAll(":scope > .strat-wrap")].map((w) => w.dataset.name);
  sgLayout(box, sc, sfApplyOrder(sc.last.slice(), names));
}
function sgHeadEl(g, sc, shut, first) {
  const uncat = g.id === "_u", label = uncat ? t("sg.uncat") : g.name;
  const head = sgEl("div", "sg-head" + (first ? " is-first" : "") + (shut ? " is-collapsed" : ""));
  head.dataset.gid = g.id; head.dataset.label = label;
  const tog = sgBtn("sg-tog"); tog.setAttribute("aria-expanded", shut ? "false" : "true");
  const ic = sgEl("span", "sg-ic"); ic.setAttribute("aria-hidden", "true");   // emoji 是裝飾,念出來只多一段雜音(§13)
  if (uncat) ic.appendChild(sgSvg("inbox")); else sgIconInto(ic, g.emoji);
  const live = sgEl("span", "sg-live"); live.hidden = true; live.setAttribute("aria-hidden", "true");
  const chev = sgEl("span", "sg-chev"); chev.setAttribute("aria-hidden", "true");
  tog.append(ic, sgEl("span", "sg-name", label), sgEl("span", "sg-n"), live, chev);
  tog.addEventListener("click", () => { if (!SF.justDragged) sgToggle(sc, head, true); });
  head.appendChild(tog);
  if (!uncat) {   // 未分類是系統組:不能改名、刪除、換序
    const more = sgBtn("sg-more", t("sg.more", { name: label })); more.setAttribute("aria-haspopup", "menu"); more.setAttribute("aria-expanded", "false");
    more.appendChild(sgSvg("ellipsis"));
    more.addEventListener("click", (e) => { e.stopPropagation(); if (SG.menuJustClosed === more) { SG.menuJustClosed = null; return; } sgMenuOpen(sc, head, more); });
    head.appendChild(more);
    head.addEventListener("contextmenu", (e) => { e.preventDefault(); if (!SF.dragActive) sgMenuOpen(sc, head, more); });   // 右鍵 = 同一個選單(§15 電腦版原生能力)
  } else head.addEventListener("contextmenu", (e) => e.preventDefault());
  return head;
}
/* 組標題的支數、組尾綠點(收合且組內有上線才出,靜止不呼吸)與可及名稱。上線判定不另開一套:讀列上 envRunDot 畫好的 .run-dot
   (本機 envPaintLocalDots、雲端 envPaintSide 都在之後叫這裡),凍結時列上的點全熄、組尾跟著消失 */
function sgHeadsSync(box) {
  let head = null, n = 0, m = 0;
  const flush = () => {
    if (!head) return;
    const tog = head.querySelector(".sg-tog"), live = head.querySelector(".sg-live"), name = head.dataset.label;
    head.querySelector(".sg-n").textContent = String(n);
    const show = head.classList.contains("is-collapsed") && m > 0;
    live.hidden = !show; live.textContent = "";
    if (show) { const d = sgEl("i", "run-dot"); live.append(d, String(m)); }
    tog.setAttribute("aria-label", t("sg.headAria", { name, n }) + (m > 0 ? t("sg.headLive", { m }) : ""));
  };
  for (const c of box.children) {
    if (c.classList.contains("sg-head")) { flush(); head = c; n = 0; m = 0; }
    else if (head && c.classList.contains("strat-wrap")) { n++; if (c.querySelector(".strat-name .run-dot")) m++; }
  }
  flush();
}
function sgRows(head) {
  const out = [];
  for (let c = head.nextElementSibling; c && !c.classList.contains("sg-head"); c = c.nextElementSibling) if (c.classList.contains("strat-wrap")) out.push(c);
  return out;
}
// 收合 / 展開:內容直接換,不做高度動畫(canon 高頻操作不加動畫);不改順序、不寫 strat_order
function sgToggle(sc, head, user, open) {
  const shut = open === undefined ? !head.classList.contains("is-collapsed") : !open;
  if (shut === head.classList.contains("is-collapsed")) return;
  const tog = head.querySelector(".sg-tog"), rows = sgRows(head), hadFocus = rows.some((w) => w.contains(document.activeElement));
  head.classList.toggle("is-collapsed", shut); tog.setAttribute("aria-expanded", shut ? "false" : "true");
  rows.forEach((w) => { w.hidden = shut; });
  if (shut && hadFocus) tog.focus();   // 焦點在收起來的列上:移到組標題,不掉到 body
  const c = new Set(SF.coll[sc.env]); if (shut) c.add(head.dataset.gid); else c.delete(head.dataset.gid);
  SF.coll = { ...SF.coll, [sc.env]: [...c] }; sfSave("coll");
  sgHeadsSync(sc.box());
  if (user) trackFeature("sfolder_toggle");
}
/* 選中一支(側欄點擊、結果卡、組合表跳轉、BYO 自動開啟、送上雲端後……):所在組收合就展開,再捲到看得見。
   app.js stratSelect / rpCloudSelect 第一行叫,排在「同一支提早 return」之前 */
function sgReveal(env, name) {
  const sc = env === "cloud" ? SF_CLOUD : SF_LOCAL, box = sc.box();
  const w = [...box.querySelectorAll(":scope > .strat-wrap")].find((x) => x.dataset.name === name);
  if (!w) return;
  if (w.hidden) { const h = box.querySelector(':scope > .sg-head[data-gid="' + sfGroupOf(w) + '"]'); if (h) sgToggle(sc, h, false, true); }
  if (!box.hidden) w.scrollIntoView({ block: "nearest" });
}

/* ── 「策略」標題列的新增資料夾鈕與上限訊息(#strat-head 在清單外、兩個視角共用,條件依目前視角算;切視角時 envPaint 重判) ── */
function sgHeadPaint() {
  const sc = sgStore(), n = sc.groups().folders.length;
  let add = $("sg-add"), lim = $("sg-limit");
  if (!add) {
    add = sgBtn("strat-add sg-add"); add.id = "sg-add"; add.appendChild(sgSvg("folder-plus"));
    add.addEventListener("click", () => sgEditOpen(sgStore(), "create"));
    $("strat-head").insertBefore(add, $("strat-add"));
    lim = sgEl("p", "sg-limit"); lim.id = "sg-limit"; lim.setAttribute("role", "status");
    $("strat-head").after(lim);
  }
  // 每次 envPaint 都會進來:值有變才寫,role=status 的節點被重寫一次有些讀屏就重念一次
  const set = (el, k, v) => { if (el[k] !== v) el[k] = v; };
  if (add.getAttribute("aria-label") !== t("sg.add")) { add.setAttribute("aria-label", t("sg.add")); add.title = t("sg.add"); }
  set(add, "disabled", n >= SG_MAX);   // 真 disabled:不進 Tab 序,達上限的話寫在下面看得見的訊息槽
  const full = !add.hidden && add.disabled && !$("strat-head").hidden;
  set(lim, "hidden", !full); set(lim, "textContent", full ? t("sg.max") : "");
}
// 「建市場資料夾」:沒有資料夾、≥8 支、已知市場 ≥2 種才出,不符就不出現(不留停用鈕)。本機的市場要等常駐程式回報,所以狀態每輪回來也重判
function sgAutoPlan(sc, list) {
  if (sc.groups().folders.length || list.length < SG_AUTO_MIN) return null;
  const order = [], by = {};
  list.forEach((x) => { const m = sc.market(x); if (!SG_MARKETS[m]) return; if (!by[m]) { by[m] = []; order.push(m); } by[m].push(x.name); });
  return order.length >= 2 ? { order, by } : null;
}
function sgAutoSync(box, sc) {
  const plan = sgAutoPlan(sc, sc.last || []), cur = box.querySelector(":scope > .sg-auto");
  if (!plan) { if (cur) cur.remove(); return; }
  if (cur) return;
  const b = sgEl("button", "sg-auto", t("sg.auto")); b.type = "button";
  b.addEventListener("click", () => sgAuto(sc));
  const first = box.querySelector(":scope > .strat-wrap");
  if (first) box.insertBefore(b, first);
}
function sgAuto(sc) {
  const plan = sgAutoPlan(sc, sc.last || []);
  if (!plan) return;
  const folders = [], map = {}, g = { folders: [] };
  plan.order.forEach((m) => {   // 依各市場第一支在目前清單的顯示順序;組名依目前語系,建好後就是用戶資料、換語系不翻譯
    const f = { id: sgNewId(g), name: t(SG_MARKETS[m][0]), emoji: SG_MARKETS[m][1] };
    g.folders.push(f); folders.push(f);
    plan.by[m].forEach((n) => { map[n] = f.id; });
  });
  sgSetFolders(sc, folders, map);
  sgRelayout(sc); sfWriteOrder(sc);
  trackFeature("sfolder_auto");
  const h = sc.box().querySelector(":scope > .sg-head .sg-tog"); if (h) h.focus();
}

/* ── 編輯列(建立 / 改名):圖示鈕＋名稱框。Enter 或失焦送出,空字串與 Esc 都是取消。
   開著時 SG.editing 擋住三條重建路(stratRefresh 的 sfBeforeRebuild、envPaintSide 的 sfCloudHold),結束時 sfFlushWaiters 補一次 */
function sgEditOpen(sc, mode, gid) {
  if (SG.editing) sgEditEnd(false);
  sgMenuClose(false);
  const box = sc.box(), groups = sc.groups();
  if (mode === "create" && groups.folders.length >= SG_MAX) return;
  const f = mode === "rename" ? groups.folders.find((x) => x.id === gid) : null;
  if (mode === "rename" && !f) return;
  const node = sgEl("div", "sg-edit");
  const ib = sgBtn("sg-ebtn", t("sg.emoji")); ib.setAttribute("aria-haspopup", "menu");
  const ic = sgEl("span", "sg-ic"); ic.setAttribute("aria-hidden", "true"); ib.appendChild(ic);
  const input = sgEl("input", "sg-input"); input.type = "text"; input.setAttribute("aria-label", t("sg.nameAria")); input.spellcheck = false;
  input.value = f ? f.name : t("sg.newName");
  node.append(ib, input);
  const head = f ? box.querySelector(':scope > .sg-head[data-gid="' + gid + '"]') : null;
  if (head) { head.before(node); head.hidden = true; }
  else {
    const heads = [...box.querySelectorAll(":scope > .sg-head")], uncat = heads.find((h) => h.dataset.gid === "_u");
    if (uncat) uncat.before(node);   // 清單最後一個資料夾之後(未分類之前)
    else { const top = box.querySelector(":scope > .strat-wrap, :scope > .sg-auto"); if (top) box.insertBefore(node, top); else box.appendChild(node); }
  }
  SG.editing = true; SG.edit = { sc, mode, gid: f ? f.id : null, node, head, input, ib, ic, emoji: f ? f.emoji : null };
  sgIconInto(ic, SG.edit.emoji);
  // 按圖示鈕時名稱框會失焦 → 送出 → 整列重畫、鈕就沒了:mousedown 擋預設(mockup 踩過)
  ib.addEventListener("mousedown", (e) => e.preventDefault());
  ib.addEventListener("click", () => sgPickOpen(ib, SG.edit.emoji, (v) => { if (!SG.edit) return; SG.edit.emoji = v; sgIconInto(SG.edit.ic, v); }, () => { if (SG.edit) SG.edit.input.focus(); }));
  input.addEventListener("input", () => { if (sgCodepoints(input.value) > SG_NAME_MAX) input.value = [...input.value].slice(0, SG_NAME_MAX).join(""); });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;   // 輸入法組字中:Enter 是選字、Esc 是取消選字,不是送出或取消改名
    if (e.key === "Enter") { e.preventDefault(); sgEditEnd(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); sgEditEnd(false); }
  });
  input.addEventListener("blur", (e) => {
    const to = e.relatedTarget;
    if (sgPick && !sgPick.hidden && (!to || sgPick.contains(to))) return;   // 焦點移進選擇器:不算送出
    if (to === ib) return;
    sgEditEnd(true);
  });
  input.focus(); input.select();
}
// commit = 送出(空字串照取消);false = 取消。寫入在前、重建在後(spec §6)
function sgEditEnd(commit) {
  const ed = SG.edit;
  if (!ed) return;
  SG.edit = null;
  sgPickClose(false);
  const name = ed.input.value, sc = ed.sc;
  let focusGid = ed.gid;
  if (commit && name.trim() && sgCodepoints(name) <= SG_NAME_MAX) {
    const g = sc.groups();
    if (ed.mode === "create" && g.folders.length < SG_MAX) {
      const f = { id: sgNewId(g), name, emoji: ed.emoji };
      sgSetFolders(sc, g.folders.concat([f])); focusGid = f.id;
      trackFeature("sfolder_create");
    } else if (ed.mode === "rename") {
      const f = g.folders.find((x) => x.id === ed.gid);   // 送出時已被別的表面刪掉:當取消,不重建
      if (f && (f.name !== name || f.emoji !== ed.emoji)) {
        sgSetFolders(sc, g.folders.map((x) => (x.id === ed.gid ? { id: x.id, name, emoji: ed.emoji } : x)));
        if (f.name !== name) trackFeature("sfolder_rename");
        if (f.emoji !== ed.emoji) trackFeature("sfolder_emoji");
      }
    }
  }
  const hadFocus = ed.node.contains(document.activeElement);
  ed.node.remove(); if (ed.head) ed.head.hidden = false;
  SG.editing = false;
  sgRelayout(sc);
  if (hadFocus || document.activeElement === document.body) {
    const h = focusGid && sc.box().querySelector(':scope > .sg-head[data-gid="' + focusGid + '"] .sg-tog');
    if (h) h.focus(); else if (!$("sg-add").hidden && !$("sg-add").disabled) $("sg-add").focus();
  }
  sfFlushWaiters();
}
// 回合結束:編輯列照失焦規則自動送出(空字串算取消),否則 sgEditing 擋住 stratRefresh(true) 與後面的結果卡。app.js onTurnEnd 第一行叫
function sgEditCommit() { if (SG.editing) sgEditEnd(true); }

/* ── ⋯ 選單:改名／換圖示／上移／下移／刪除資料夾。單例掛 body、fixed(同旗標面板)。上移、下移在首尾隱藏 ── */
let sgMenu = null;
function sgMenuBuild() {
  sgMenu = sgEl("div", "flag-pop sg-menu"); sgMenu.setAttribute("role", "menu"); sgMenu.hidden = true;
  const item = (k, fn) => { const b = sgBtn("item"); b.setAttribute("role", "menuitem"); b.dataset.k = k; b.addEventListener("click", () => { const c = SG.menuCtx; sgMenuClose(false); if (c) fn(c); }); return b; };
  const sep = () => { const d = sgEl("div", "divider"); d.setAttribute("role", "separator"); return d; };
  sgMenu.append(
    item("sg.rename", (c) => sgEditOpen(c.sc, "rename", c.gid)),
    item("sg.emoji", (c) => sgPickFolder(c.sc, c.gid)),
    item("sg.up", (c) => sgMoveFolder(c.sc, c.gid, -1)),
    item("sg.down", (c) => sgMoveFolder(c.sc, c.gid, 1)),
    sep(),
    item("sg.del", (c) => sgDelete(c.sc, c.gid)),
  );
  sgMenu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); sgMenuClose(true); return; }
    if (["ArrowDown", "ArrowUp"].indexOf(e.key) < 0) return;
    e.preventDefault();
    const items = [...sgMenu.querySelectorAll("button")].filter((b) => !b.hidden), i = items.indexOf(document.activeElement);
    const next = items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
    if (next) next.focus();
  });
  sgMenu.addEventListener("focusout", (e) => { if (!sgMenu.hidden && !sgMenu.contains(e.relatedTarget)) sgMenuClose(false); });
  document.body.appendChild(sgMenu);
}
function sgMenuOpen(sc, head, anchor) {
  if (!sgMenu) sgMenuBuild();
  sgMenuClose(false); sfPopClose(false); sgPickClose(false);
  const gid = head.dataset.gid, ids = sc.groups().folders.map((f) => f.id), i = ids.indexOf(gid);
  if (i < 0) return;
  SG.menuCtx = { sc, gid, anchor };
  sgMenu.setAttribute("aria-label", t("sg.more", { name: head.dataset.label }));
  sgMenu.querySelectorAll(".item").forEach((b) => { b.textContent = t(b.dataset.k); });
  sgMenu.querySelector('[data-k="sg.up"]').hidden = i === 0;
  sgMenu.querySelector('[data-k="sg.down"]').hidden = i === ids.length - 1;
  anchor.setAttribute("aria-expanded", "true"); head.classList.add("menu-open");
  sgFloat(sgMenu, anchor);
  sgMenu.querySelector(".item").focus();
}
function sgMenuClose(restore) {
  if (!sgMenu || sgMenu.hidden) return;
  sgMenu.classList.remove("open"); sgMenu.hidden = true;
  const c = SG.menuCtx; SG.menuCtx = null;
  if (!c) return;
  c.anchor.setAttribute("aria-expanded", "false");
  const head = c.anchor.closest(".sg-head"); if (head) head.classList.remove("menu-open");
  if (restore && document.contains(c.anchor)) c.anchor.focus();
}
// 浮動面板定位:先隱形量尺寸再放(sfPopPlace:錨點下方 8、不夠翻上、clamp 進視窗)
function sgFloat(pop, anchor) {
  pop.hidden = false; pop.classList.remove("open"); pop.style.visibility = "hidden";
  const { left, top, up } = sfPopPlace(anchor.getBoundingClientRect(), pop.offsetWidth, pop.offsetHeight, window.innerWidth, window.innerHeight);
  pop.style.left = left + "px"; pop.style.top = top + "px";
  pop.classList.toggle("up", up); pop.style.visibility = "";
  requestAnimationFrame(() => pop.classList.add("open"));
}
function sgHeadTog(sc, gid) { return sc.box().querySelector(':scope > .sg-head[data-gid="' + gid + '"] .sg-tog'); }
// 換序:改變視覺順序 → 畫面由上到下寫回 strat_order(不送 strat_reorder)。未分類固定最後、不參與
function sgMoveFolder(sc, gid, dir) {
  const fs = sc.groups().folders.slice(), i = fs.findIndex((f) => f.id === gid), j = i + dir;
  if (i < 0 || j < 0 || j >= fs.length) return;
  [fs[i], fs[j]] = [fs[j], fs[i]];
  sgSetFolders(sc, fs);
  sgRelayout(sc); sfWriteOrder(sc);
  trackFeature("sfolder_reorder");
  const b = sgHeadTog(sc, gid); if (b) b.focus();
}
// 刪資料夾:裡面的策略回未分類,策略本身不動(不經「還掛在下單設定」守門,因為不刪策略)。空的直接刪,有策略先確認
function sgDelete(sc, gid) {
  const f = sc.groups().folders.find((x) => x.id === gid), head = sc.box().querySelector(':scope > .sg-head[data-gid="' + gid + '"]');
  if (!f) return;
  const n = head ? sgRows(head).length : 0;
  const run = () => {
    const g = sc.groups(), map = {};
    Object.keys(g.map).forEach((k) => { if (g.map[k] !== gid) map[k] = g.map[k]; });
    const at = g.folders.findIndex((x) => x.id === gid);
    if (at < 0) return;
    const rest = g.folders.filter((x) => x.id !== gid);
    sgSetFolders(sc, rest, map);
    SF.coll = { ...SF.coll, [sc.env]: SF.coll[sc.env].filter((x) => x !== gid) }; sfSave("coll");
    sgRelayout(sc); sfWriteOrder(sc);
    trackFeature("sfolder_delete");
    const next = rest[Math.min(at, rest.length - 1)], b = next ? sgHeadTog(sc, next.id) : sgHeadTog(sc, "_u");
    if (b) b.focus(); else if (!$("sg-add").hidden) $("sg-add").focus();
  };
  if (!n) { run(); return; }
  confirmBox({ title: t("sg.delTitle", { name: f.name }), lines: [t("sg.delBody", { n })], ok: t("sg.delOk"), opener: head && head.querySelector(".sg-more"), env: sc.env, onOk: run });
}
// ⋯ › 換圖示:選擇器錨在組標題的 ⋯ 鈕上;選了立刻寫(這個值是用戶這次改的,api／主行程照清單驗)
function sgPickFolder(sc, gid) {
  const f = sc.groups().folders.find((x) => x.id === gid), head = sc.box().querySelector(':scope > .sg-head[data-gid="' + gid + '"]');
  if (!f || !head) return;
  const anchor = head.querySelector(".sg-more");
  sgPickOpen(anchor, f.emoji, (v) => {
    const cur = sc.groups().folders.find((x) => x.id === gid);
    if (!cur || cur.emoji === v) return;
    sgSetFolders(sc, sc.groups().folders.map((x) => (x.id === gid ? { id: x.id, name: x.name, emoji: v } : x)));
    sgRelayout(sc);
    trackFeature("sfolder_emoji");
  }, () => { const h = sc.box().querySelector(':scope > .sg-head[data-gid="' + gid + '"] .sg-more'); if (h) h.focus(); });   // 還給開它的那一顆(⋯),同 web
}

/* ── emoji 選擇器(§10):Dropdown Panel,6 欄 32×32、分類小標常駐不分頁,內容高上限 320 內捲。
   已選時最上面多一列「移除圖示」。方向鍵四向(上下跳 6)、Enter 選定、Esc 關閉並還焦點;第一行按上到「移除圖示」,按下回第一行 ── */
let sgPick = null;
function sgPickBuild() {
  sgPick = sgEl("div", "flag-pop sg-pick"); sgPick.setAttribute("role", "menu"); sgPick.hidden = true;
  const none = sgBtn("item sg-none"); none.setAttribute("role", "menuitem");
  none.addEventListener("click", () => sgPickChoose(null));
  sgPick.appendChild(none);
  SG_CATS.forEach((k, ci) => {
    const grp = sgEl("div", "sg-cat"); grp.setAttribute("role", "group"); grp.dataset.k = k;
    const lab = sgEl("div", "sg-cat-l"); lab.setAttribute("aria-hidden", "true");
    const grid = sgEl("div", "sg-grid");
    SG_EMOJI_LIST.slice(ci * 12, ci * 12 + 12).forEach((e) => {
      const c = sgBtn("sg-cell"); c.setAttribute("role", "menuitemradio"); c.dataset.e = e; c.textContent = e;
      c.addEventListener("click", () => sgPickChoose(e));
      grid.appendChild(c);
    });
    grp.append(lab, grid); sgPick.appendChild(grp);
  });
  sgPick.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); sgPickClose(true); return; }
    if (["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].indexOf(e.key) < 0) return;
    e.preventDefault();
    const cells = [...sgPick.querySelectorAll(".sg-cell")], rm = sgPick.querySelector(".sg-none"), i = cells.indexOf(document.activeElement);
    if (document.activeElement === rm) { if (e.key === "ArrowDown") cells[0].focus(); return; }
    if (i < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: SG_COLS, ArrowUp: -SG_COLS }[e.key], j = i + step;
    if (j < 0) { if (e.key === "ArrowUp" && !rm.hidden) rm.focus(); return; }   // 沒有「移除圖示」那一列時停在原格
    if (j >= cells.length) return;
    cells[j].focus(); cells[j].scrollIntoView({ block: "nearest" });
  });
  sgPick.addEventListener("focusout", (e) => { if (!sgPick.hidden && e.relatedTarget && !sgPick.contains(e.relatedTarget)) { sgPickClose(false); sgEditLeft(e.relatedTarget); } });
  document.body.appendChild(sgPick);
}
function sgPickOpen(anchor, current, onPick, onClose) {
  if (!sgPick) sgPickBuild();
  sgPickClose(false); sgMenuClose(false);
  SG.pickCtx = { anchor, onPick, onClose };
  sgPick.setAttribute("aria-label", t("sg.emoji"));
  const cur = typeof current === "string" && SG_EMOJI_SET.has(current) ? current : null, rm = sgPick.querySelector(".sg-none");
  rm.textContent = t("sg.emojiNone"); rm.hidden = !cur;
  sgPick.querySelectorAll(".sg-cat").forEach((g) => { g.setAttribute("aria-label", t(g.dataset.k)); g.querySelector(".sg-cat-l").textContent = t(g.dataset.k); });
  sgPick.querySelectorAll(".sg-cell").forEach((c) => {
    const on = c.dataset.e === cur, nm = sgEmojiName(c.dataset.e);
    c.classList.toggle("is-on", on); c.setAttribute("aria-checked", on ? "true" : "false"); c.setAttribute("aria-label", nm); c.title = nm;
  });
  anchor.setAttribute("aria-expanded", "true");
  sgFloat(sgPick, anchor);
  const to = sgPick.querySelector(".sg-cell.is-on") || sgPick.querySelector(".sg-cell");
  sgPick.scrollTop = 0; to.focus(); to.scrollIntoView({ block: "nearest" });
}
function sgPickChoose(v) { const c = SG.pickCtx; sgPickClose(true); if (c && c.onPick) c.onPick(v); }
function sgPickClose(restore) {
  if (!sgPick || sgPick.hidden) return;
  sgPick.classList.remove("open"); sgPick.hidden = true;
  const c = SG.pickCtx; SG.pickCtx = null;
  if (!c) return;
  c.anchor.setAttribute("aria-expanded", "false");
  if (restore && c.onClose) c.onClose();
}

/* ── 列的旗標面板裡的「移到{name}」/「移出資料夾」(stratflags.js sfPopOpen 叫;給不能拖的人,§13)。列上不帶 emoji。
   回 true = 有資料夾、這一段要出 ── */
function sgMoveFill(box, wrap, x, sc) {
  box.textContent = "";
  const folders = sc.groups().folders;
  if (!folders.length || !wrap.parentElement || !wrap.parentElement.querySelector(":scope > .sg-head")) return false;
  const cur = sfGroupOf(wrap);
  folders.forEach((f) => {
    const b = sgBtn("item", null); b.setAttribute("role", "menuitem"); b.textContent = t("sg.moveTo", { name: f.name });
    if (f.id === cur) b.setAttribute("aria-current", "true");
    b.addEventListener("click", () => { sfPopClose(true); if (f.id !== cur) sgMoveRow(sc, x.name, f.id); });
    box.appendChild(b);
  });
  if (cur && cur !== "_u") {
    const b = sgBtn("item", null); b.setAttribute("role", "menuitem"); b.textContent = t("sg.moveOut");
    b.addEventListener("click", () => { sfPopClose(true); sgMoveRow(sc, x.name, "_u"); });
    box.appendChild(b);
  }
  return true;
}
// 搬到目標組最底(同拖到組標題);目標組收合時列跟著收、焦點移到該組標題
function sgMoveRow(sc, name, gid) {
  const box = sc.box(), w = [...box.querySelectorAll(":scope > .strat-wrap")].find((r) => r.dataset.name === name);
  const head = box.querySelector(':scope > .sg-head[data-gid="' + gid + '"]');
  if (!w || !head || !sfSetGroup(sc, name, gid)) return;
  let last = head;
  for (let n = head.nextElementSibling; n && n.classList.contains("strat-wrap"); n = n.nextElementSibling) if (n !== w) last = n;
  last.after(w);
  w.hidden = head.classList.contains("is-collapsed");
  sfWriteOrder(sc);
  trackFeature("sfolder_move");
  sgHeadsSync(box);
  const b = w.hidden ? head.querySelector(".sg-tog") : w.querySelector(".strat-flagbtn") || w.querySelector(".strat-row");
  if (b) b.focus();
  srSay(t("sg.moved", { name: head.dataset.label }));
}

// 外點 / 捲動 / 改窗即收(fixed 定位不跟捲動)
// 判斷落點用 composedPath:事件路徑在派送當下就定了,節點之後被清空重建、脫離 DOM 也照樣比得到(closest / contains 會失效)
document.addEventListener("pointerdown", (e) => {
  const path = e.composedPath(), within = (n) => !!n && path.indexOf(n) >= 0;
  if (sgMenu && !sgMenu.hidden && !within(sgMenu)) {
    const c = SG.menuCtx;
    SG.menuJustClosed = c && within(c.anchor) ? c.anchor : null;
    sgMenuClose(false);
  }
  if (sgPick && !sgPick.hidden && !within(sgPick) && !(SG.pickCtx && within(SG.pickCtx.anchor))) { sgPickClose(false); sgEditLeft(e.target); }
});
// 選擇器是從編輯列開的、人直接點到 / Tab 到別處:名稱框早就失焦(進選擇器那次不算),這一下才是真的離開,照失焦送出
function sgEditLeft(to) { if (SG.edit && !(to && SG.edit.node.contains(to))) sgEditEnd(true); }
window.addEventListener("resize", () => { sgMenuClose(false); sgPickClose(false); });
["strat-list", "strat-list-cloud"].forEach((id) => $(id).addEventListener("scroll", () => { sgMenuClose(false); sgPickClose(false); }));
