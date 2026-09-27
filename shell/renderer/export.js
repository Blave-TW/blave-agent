/* 策略轉出 XQ / MultiCharts / TradingView(設計:blave-canon output/designer/spec-desktop-strategy-export-0.1.8.md)。
   觸發器、選單、確認框、轉出卡照 web 工作頁(workspace.html 的 xpAsk / buildExportNode)同位同字;只在電腦版的硬限制處不同:
   - 檔案留在 app 裡:卡上「下載…」由主行程開存檔框寫檔(save-export),不是瀏覽器下載;存好給「在 Finder 中顯示」。
   - 對話重開後卡不會回來(session.db 不存 export chunk),所以轉出檔另外住在「程式碼」分頁的檔案切換裡。
   - 雲端視角不畫:agent 標記的路徑是本機 workspace。
   真正轉檔的是 agent(references/{xq-xs,multicharts-powerlanguage,tradingview-pine}.md);這個檔只負責問一次、送一句話、把產物交給人。
   送給 agent 的那句只放資料夾名(同 handoff.js 檔頭:DISPLAY_NAME 是 workspace 裡的自由文字,不放進「用戶說的話」)。
   用到 app.js 的 $ / t / confirmBox / submitMessage / running / RP / rpBag / stratSelect / rpShowTab / addMsg / scrollChat / srSay /
   paneSt / paneToggle / trackFeature / sessionId、handoff.js 的 HO_ID_RE / hoHasCode、trade.js 的 ENV / envSwitchGuarded / trStamp、
   pine-install.js 的 tvRepaintAll——都在呼叫時才取。 */
const XP_ORDER = ["xq", "mc", "pine"];   // 同 web 選單,不因策略重排
const XP_PLATFORM = { xq: "XQ", mc: "MultiCharts", pine: "TradingView" };
const XP_FEATURE = { xq: "export_xq", mc: "export_mc", pine: "export_pine" };
const XP = { sel: "py", tm: null, pending: [] };   // sel = 程式碼分頁選中的檔;tm = 時光機正在看的舊版標籤(null = 目前版);pending = 這一輪收到的 export chunk
const XP_ICON_CHECK = "M20 6 9 17l-5-5";

/* ── 純邏輯(tests/check_shell_export.js 從原文切出來跑;這一段不准碰 DOM)── */
// 加密策略:SYMBOL 以 USDT / USDC 結尾,或資料夾裡有 .py 用 fetch_kline(主行程掃)。判不出來就當不是(照常給選)
function xpIsCrypto(d) {
  const sym = d && typeof d.symbol === "string" ? d.symbol.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
  return /USD[TC]$/.test(sym) || !!(d && d.cryptoKline === true);
}
/* 組合策略(Type C):一份腳本只跑一個標的,三個平台都轉不了(references 三份都寫 Type A only)。
   認法:回測的 stats 帶隨機投組基準 benchmark_n(只有 Type C 那一支寫),或檔頭 `# Type: C`。判不出來就當不是(照常給選,agent 讀過碼再拒) */
function xpIsPortfolio(d) {
  if (!d) return false;
  if (d.stats && typeof d.stats.benchmark_n === "number") return true;
  return typeof d.code === "string" && /^#\s*Type:\s*C\b/m.test(d.code.slice(0, 2000));
}
// 不能選的原因(i18n key);null = 可以選。外殼只擋這兩種,其餘轉不轉得了由 agent 讀過程式碼再講
function xpOff(target, d) { return xpIsPortfolio(d) ? "portfolio" : target === "xq" && xpIsCrypto(d) ? "crypto" : null; }
function xpAvail(target, d) { return xpOff(target, d) === null; }
// 送給 agent 的那句。壞 id / 壞 target / 範本不是恰好一個 {id} → null
function xpMsg(target, id, tpl) {
  if (!XP_PLATFORM[target] || typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const s = tpl && typeof tpl[target] === "string" ? tpl[target] : null;
  return s && s.split("{id}").length === 2 ? s.split("{id}").join(id) : null;
}
// runtime 的 export chunk 是不是我們畫得出來的形狀(內容是 workspace 來的,只當文字用)
function xpChunkOk(c) {
  return !!(c && typeof c === "object" && XP_PLATFORM[c.target] && typeof c.strategy === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(c.strategy)
    && typeof c.filename === "string" && c.filename && typeof c.content === "string" && c.content);
}
function xpSize(bytes) { return bytes < 1024 ? bytes + " B" : (bytes / 1024).toFixed(1) + " KB"; }
/* INTERVAL → 步驟句裡的週期:["xp.ivl.<單位>", { n }] 或 null(認不得就用不帶商品的句子)。
   XQ / MultiCharts 的分線以分鐘計(60 分鐘、240 分鐘),TradingView 照小時講 */
function xpIvl(ivl, target) {
  const m = /^(\d{1,4})\s*(m|min|h|H|d|D|w|W)$/.exec(String(ivl || "").trim()); if (!m) return null;   // 大寫 M 是月線,不收
  const n = Number(m[1]), u = m[2].toLowerCase();
  if (!n) return null;
  if (u === "m" || u === "min") return ["xp.ivl.m", { n }];
  if (u === "h") return target === "pine" ? ["xp.ivl.h", { n }] : ["xp.ivl.m", { n: n * 60 }];
  if (n !== 1) return null;
  return u === "d" ? ["xp.ivl.d", {}] : ["xp.ivl.w", {}];
}
// 程式碼分頁的檔案切換要畫哪些:Python + 有檔的平台(順序同選單)。沒有轉出檔 / 雲端 / 時光機 → 只有 Python(= 不畫切換)
function xpFiles(d, local, tm) {
  const ex = local && !tm && d && Array.isArray(d.exports) ? d.exports : [];
  return XP_ORDER.filter((k) => ex.some((x) => x && x.target === k && typeof x.content === "string"));
}
/* ── 純邏輯到此 ── */

/* 擴充點:Pine 那一份的動作槽(轉出卡的下載鈕旁、程式碼分頁的動作列)。「送進 TradingView」(pine-install.js)往 XP_ACTIONS
   推一個 provider(ctx) → 節點或 null;ctx = { where: "card" | "code", target, strategy, id, session, stale, old(重開畫回來的舊卡),
   at(轉出時間 ms), wrap(整張卡 / 轉出檔那一面), row(動作列), base(原本拿填色的那顆:卡的下載、程式碼分頁的複製) }。
   沒有 provider 出東西時槽是空的 span,不佔版面。檔案路徑不在 ctx 裡——主行程的 exportRef / exportById 有 */
const XP_ACTIONS = [];
// 一張卡一個填色(canon「每個視窗一個焦點」):槽裡的鈕拿填色時 base 退成描邊,who = "base" 還回去。過期那一面填色在「重新轉出」,不動
function xpFill(ctx, who) { if (ctx.base && !ctx.stale) ctx.base.className = who === "ext" ? "btn-out" : "btn-fill"; }
function xpExt(ctx) {
  const slot = xpMk("span", "xp-ext"); slot.dataset.where = ctx.where;
  // 一個 provider 壞掉不拖垮卡
  for (const p of XP_ACTIONS) { try { const n = p(ctx); if (n) slot.appendChild(n); } catch (_) { continue; } }
  return slot;
}
const xpMk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
function xpCheckIcon() {
  const NS = "http://www.w3.org/2000/svg", s = document.createElementNS(NS, "svg"), p = document.createElementNS(NS, "path");
  s.setAttribute("class", "xp-ok"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
  p.setAttribute("d", XP_ICON_CHECK); s.appendChild(p); return s;
}
const xpLang = (k) => (k === "xq" ? t("xp.lang.xq") : k === "mc" ? t("xp.lang.mc") : t("xp.lang.pine"));
const xpTitle = (k) => (k === "xq" ? t("xp.cf.title.xq") : k === "mc" ? t("xp.cf.title.mc") : t("xp.cf.title.pine"));
const xpTpl = () => ({ xq: t("xp.msg.xq"), mc: t("xp.msg.mc"), pine: t("xp.msg.pine") });
const xpLocal = () => typeof ENV === "undefined" || ENV.cur !== "cloud";
const xpDisabled = () => running === true || !!XP.tm;

/* ── 觸發器 + 選單(分頁列右端;同 web .tab-act)── */
function xpDom() {
  if ($("xp-dd")) return;
  const dd = xpMk("span", "xp-dd"); dd.id = "xp-dd"; dd.hidden = true;
  const b = xpMk("button", "xp-chip"); b.type = "button"; b.id = "xp-btn";
  b.setAttribute("aria-haspopup", "menu"); b.setAttribute("aria-expanded", "false"); b.setAttribute("aria-controls", "xp-menu");
  const cv = xpMk("span", "xp-cv"); cv.setAttribute("aria-hidden", "true");
  b.append(xpMk("span", "xp-chip-l"), cv);
  const m = xpMk("div", "xp-menu"); m.id = "xp-menu"; m.setAttribute("role", "menu"); m.hidden = true;
  dd.append(b, m); $("rp-tabs").appendChild(dd);
  const note = xpMk("p", "xp-note"); note.id = "xp-note"; note.setAttribute("role", "status"); note.setAttribute("aria-live", "polite"); note.hidden = true;
  $("rp-tabs").after(note);
  b.addEventListener("click", (e) => { e.stopPropagation(); m.hidden ? xpOpen() : xpClose(false); });
  m.addEventListener("keydown", xpMenuKey);
  document.addEventListener("mousedown", (e) => { if (!m.hidden && !dd.contains(e.target)) xpClose(false); });
  $("rp-tabs").addEventListener("click", (e) => { if (e.target.closest(".rp-tab")) xpNote(null); });   // 換分頁:原因句收起
}
// 報告頁首重畫時(rpPaintHead:選策略、切視角、重讀)。雲端視角、沒有程式碼、資料夾名不合規 → 不畫
function xpPaint() {
  const B = rpBag(); xpDom();
  const show = xpLocal() && !!B.name && HO_ID_RE.test(B.name) && hoHasCode(B.data);
  xpClose(false); xpNote(null);
  $("xp-dd").hidden = !show;
  $("xp-btn").firstChild.textContent = t("xp.btn");
  xpSync();
  xpCodePaint();
}
// 回合開始 / 結束(app.js 上鎖 / 解鎖同一處)與時光機進出:只換鈕態,不重畫
function xpSync() {
  if (typeof tvRepaintAll === "function") tvRepaintAll();   // Pine 動作槽(送進 TradingView)跟著同一組條件重畫
  const b = $("xp-btn"); if (!b) return;
  if (xpDisabled()) { b.setAttribute("aria-disabled", "true"); if (!$("xp-menu").hidden) xpClose(false); }
  else { b.removeAttribute("aria-disabled"); xpNote(null); }
  const again = $("xp-again"); if (again) { if (running === true) again.setAttribute("aria-disabled", "true"); else again.removeAttribute("aria-disabled"); }
}
/* 策略版本(另案)的時光機進出時呼叫:label = 正在看的那一版(如 "v5"),null = 回到目前版。
   時光機裡觸發器 aria-disabled、程式碼分頁只剩 Python(轉出檔只屬於目前版本) */
function xpSetTimeMachine(label) { XP.tm = label || null; if (XP.tm) XP.sel = "py"; xpSync(); xpCodePaint(); }
function xpNote(text) { const n = $("xp-note"); if (!n) return; n.textContent = text || ""; n.hidden = !text; }
function xpOpen() {
  const b = $("xp-btn"), m = $("xp-menu");
  if (xpDisabled()) { xpNote(running === true ? t("turn.busy") : t("xp.why.tm", { v: XP.tm })); return; }
  const d = RP.data; m.textContent = "";
  for (const k of XP_ORDER) {
    const lang = xpMk("span", "lang", "· " + xpLang(k));
    const off = xpOff(k, d);
    if (off) {   // Unavailable info 列:不是鈕、不進 Tab 序——沒有補救動作
      const r = xpMk("div", "xp-off"); r.append(XP_PLATFORM[k] + " ", lang, xpMk("span", "d", off === "portfolio" ? t("xp.off.portfolio") : t("xp.off.crypto"))); m.appendChild(r); continue;
    }
    const it = xpMk("button", "xp-it"); it.type = "button"; it.setAttribute("role", "menuitem"); it.tabIndex = -1; it.dataset.xp = k;
    it.append(XP_PLATFORM[k] + " ", lang);
    it.addEventListener("click", () => { xpClose(false); xpAsk(k, b); });
    m.appendChild(it);
  }
  m.hidden = false; $("xp-dd").classList.add("is-open"); b.setAttribute("aria-expanded", "true");
  const first = m.querySelector(".xp-it"); if (first) first.focus();
}
function xpClose(refocus) {
  const m = $("xp-menu"); if (!m || m.hidden) return;
  m.hidden = true; $("xp-dd").classList.remove("is-open"); $("xp-btn").setAttribute("aria-expanded", "false");
  if (refocus) $("xp-btn").focus();
}
function xpMenuKey(e) {
  const items = [...$("xp-menu").querySelectorAll(".xp-it")], i = items.indexOf(document.activeElement);
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); xpClose(true); return; }
  if (e.key === "Tab") { xpClose(false); return; }
  const d = { ArrowDown: 1, ArrowUp: -1 }[e.key]; if (!d || !items.length) return;
  e.preventDefault(); items[(i + d + items.length) % items.length].focus();
}

/* ── 確認框 → 固定句進對話(同 web xpAsk;不碰輸入框草稿)── */
function xpAsk(target, opener) {
  const id = RP.name;
  if (!XP_PLATFORM[target] || xpDisabled() || !xpLocal() || !id || !HO_ID_RE.test(id)) return;
  const platform = XP_PLATFORM[target], title = xpTitle(target);
  confirmBox({ title, lines: [t("xp.cf.body", { platform })], ok: t("xp.cf.ok"), opener,
    onOk: () => {
      const msg = xpMsg(target, id, xpTpl()); if (!msg) return;
      if (paneSt.chat.off) paneToggle("chat", false);                     // 聊天欄收著就先展開:轉的過程在那裡
      submitMessage(msg).then((ok) => { if (ok) trackFeature(XP_FEATURE[target]); });   // 跑起來才算用過(同 rpRobAsk)
    } });
  $("del-title").title = title;
}

/* ── 對話裡的轉出卡(同 web buildExportNode:檔名 + 平台·語言·大小 + 一顆下載,下面一行誠實句)──
   runtime 在 done 之前送 export chunk;回覆泡泡在 done 才定稿、回合結束還會重畫一次,所以先收著,回合結束才掛上去 */
function xpChunk(c) {
  if (c && c.session_id && c.session_id !== sessionId) return;
  if (xpChunkOk(c)) XP.pending.push({ id: typeof c.id === "string" ? c.id : null, session: sessionId, target: c.target, strategy: c.strategy,
    filename: c.filename, size: new Blob([c.content]).size });   // 內容不留在畫面:下載由主行程讀那一輪的快照
}
/* 重開 app / 切回舊對話(app.js csOpen):主行程存的那幾張卡照時間插回去——index 的 ts 是回合結束時間,排在那一輪回覆之後,
   所以掛到目前最後一則 agent 回覆下面(同即時那一輪的位置) */
async function xpHistoryItems(sid) {
  let rows = []; try { rows = await window.blave.loadSessionExports(sid); } catch (_) { return []; }
  return (rows || []).filter((r) => r && XP_PLATFORM[r.target]).map((r) => ({ ts: Number(r.ts) || 0, xp: { ...r, session: sid } }));
}
function xpRestore(rec) { xpPut(xpHost(null), xpCard(rec, true)); }
// 卡掛在哪:這一輪的回覆泡泡;沒有(回覆後面接了圖、或這一輪沒有字)就往回找到上一句用戶的話為止的最後一則回覆(results.js resHostNow,兩種卡同一則),再沒有才另起一則
function xpHost(bubble) {
  if (bubble && bubble.isConnected) return bubble;
  return resHostNow() || addMsg("ai", "");
}
// 同一則回覆裡結果卡永遠最後:兩份存檔的 ts 各自記,重開時誰先畫不保證
function xpPut(host, card) { const g = host.querySelector(":scope > .res-group"); if (g) g.before(card); else host.appendChild(card); }
function xpTurnEnd(bubble) {
  const list = XP.pending; XP.pending = [];
  // 正開著的那支每一輪結束都重掃轉出檔(只換 exports,不動其他分頁):檔案是 agent 寫進資料夾的,
  // 這一輪有沒有送卡跟檔案在不在是兩件事——只在有卡時重掃,漏卡那一輪程式碼分頁要切走再切回來才看得到
  if (RP.name) xpReload(RP.name);
  if (!list.length) return;
  const host = xpHost(bubble);
  list.forEach((c) => xpPut(host, xpCard(c)));
  scrollChat();
}
async function xpReload(name) {
  let d = null; try { d = await window.blave.loadStrategy(name); } catch (_) { return; }
  if (!d || RP.name !== name || !RP.data) return;
  RP.data.exports = d.exports; RP.data.cryptoKline = d.cryptoKline;
  if (rpBag() === RP) xpCodePaint();
}
function xpCard(c, old) {
  const platform = XP_PLATFORM[c.target], wrap = xpMk("div", "xp-wrap");
  const box = xpMk("div", "xp"), f = xpMk("span", "f");
  const fn = xpMk("span", "fn mono", String(c.filename).replace(/[/\\]/g, "_")); fn.title = fn.textContent;
  const ft = xpMk("span", "ft", platform + " · " + xpLang(c.target) + " · ");
  ft.appendChild(xpMk("span", "mono", xpSize(c.size)));
  f.append(fn, ft);
  const dl = xpMk("button", "btn-fill", t("xp.dl")); dl.type = "button";
  box.append(f, dl);
  const acts = xpMk("div", "xp-acts"), view = xpMk("button", "btn-quiet", t("xp.view")); view.type = "button";
  const st = xpMk("span", "xp-st"); st.setAttribute("role", "status"); st.setAttribute("aria-live", "polite");
  acts.append(view, st);
  dl.addEventListener("click", () => xpSave(c.id ? { session: c.session, id: c.id } : { strategy: c.strategy, target: c.target }, st));
  view.addEventListener("click", () => xpGoCode(c.strategy, c.target));
  wrap.append(box, xpMk("p", "xp-cap", t("xp.capHonest", { platform })), acts);
  if (c.target === "pine") box.appendChild(xpExt({ where: "card", target: c.target, strategy: c.strategy, id: c.id, session: c.session,
    old: !!old, at: Number(c.ts) > 0 ? Number(c.ts) * 1000 : null, wrap, row: acts, base: dl }));
  return wrap;
}
async function xpSave(ref, st) {
  let r = null; try { r = await window.blave.saveExport(ref); } catch (_) { r = null; }
  if (r && r.canceled) return;                                            // 取消存檔框 = 什麼都不顯示
  st.textContent = ""; st.classList.toggle("err", !(r && r.ok));
  if (!r || !r.ok) { st.textContent = t("xp.saveFail"); return; }
  trackFeature("export_save");
  const rv = xpMk("button", "btn-quiet", window.blave.platform === "win32" ? t("xp.revealWin") : t("xp.reveal")); rv.type = "button";
  rv.addEventListener("click", () => window.blave.revealExport(r.token));
  st.append(t("xp.saved", { dir: r.dir || t("xp.dlDir") }), rv);
}
// 卡上的「在「程式碼」分頁看」:回這台電腦、選那支、停在那一份
async function xpGoCode(name, target) {
  if (!xpLocal() && !envSwitchGuarded("local")) return;
  await stratSelect(name, true);
  if (RP.name !== name || !RP.data) return;
  XP.sel = target; rpShowTab("code"); xpCodePaint();
  if (XP.sel === target) trackFeature("export_view");
  const b = document.querySelector('#xp-bar [data-k="' + target + '"]'); if (b) b.focus();
}

/* ── 「程式碼」分頁:沒有轉出檔 = 跟以前一模一樣;有的話上面一排檔案切換(同策略庫 .lib-seg)── */
function xpCodePaint() {
  const host = $("rp-code"), pre = $("rp-code-pre"); if (!host || !pre) return;
  let bar = $("xp-bar"), view = $("xp-view");
  if (!bar) { bar = xpMk("div", "xp-bar"); bar.id = "xp-bar"; view = xpMk("div", "xp-view"); view.id = "xp-view"; host.insertBefore(bar, pre); host.insertBefore(view, pre); }
  const B = rpBag(), files = xpFiles(B.data, B === RP && xpLocal(), XP.tm);
  if (!files.includes(XP.sel)) XP.sel = "py";
  bar.textContent = ""; view.textContent = "";
  bar.hidden = !files.length; view.hidden = XP.sel === "py"; pre.hidden = XP.sel !== "py";
  if (!files.length) return;
  const seg = xpMk("div", "lib-seg"); seg.setAttribute("role", "group"); seg.setAttribute("aria-label", t("xp.files"));
  for (const k of ["py", ...files]) {
    const b = xpMk("button", "", k === "py" ? "Python" : XP_PLATFORM[k]); b.type = "button"; b.dataset.k = k; b.setAttribute("aria-pressed", String(k === XP.sel));
    b.addEventListener("click", () => {
      if (XP.sel === k) return;
      XP.sel = k; xpCodePaint();
      if (k !== "py") trackFeature("export_view");
      const again = document.querySelector('#xp-bar [data-k="' + k + '"]'); if (again) again.focus();
    });
    seg.appendChild(b);
  }
  bar.appendChild(seg);
  if (XP.sel !== "py") xpView(view, B.data.exports.find((x) => x.target === XP.sel), B.data);
}
function xpView(host, ex, d) {
  const k = ex.target, platform = XP_PLATFORM[k];
  const meta = xpMk("p", "xv-meta" + (ex.stale ? " stale" : ""), ex.stale ? t("xp.stale") : t("xp.meta", { date: trStamp(ex.exportedAt / 1000) }));
  host.append(meta, xpMk("p", "xv-honest", t("xp.honest", { platform })));
  // 動作列:靠左、主動作在前。過期時主動作換成重新轉出、複製降為描邊、下載收起(一個畫面一個焦點)
  const row = xpMk("div", "xv-acts"), grp = xpMk("div", "grp"), st = xpMk("span", "xp-st"); st.setAttribute("role", "status"); st.setAttribute("aria-live", "polite");
  const cp = xpMk("button", ex.stale ? "btn-out" : "btn-fill", t("xp.copy")); cp.type = "button";
  cp.addEventListener("click", () => xpCopy(cp, ex.content));
  if (ex.stale) {
    const again = xpMk("button", "btn-fill", t("xp.again")); again.type = "button"; again.id = "xp-again";
    again.addEventListener("click", () => { if (running === true) { xpNote(t("turn.busy")); return; } xpAsk(k, again); });
    grp.append(again, cp);
  } else {
    const dl = xpMk("button", "btn-out", t("xp.dl")); dl.type = "button";
    const name = RP.name; dl.addEventListener("click", () => xpSave({ strategy: name, target: k }, st));
    grp.append(cp, dl);
  }
  row.append(grp, st); host.appendChild(row);
  if (k === "pine") grp.appendChild(xpExt({ where: "code", target: k, strategy: RP.name, id: null, session: null, stale: !!ex.stale,
    at: ex.exportedAt, wrap: host, row, base: cp }));
  // 貼上步驟:預設展開;收起狀態依平台記在 localStorage
  let open = true;
  try { open = localStorage.getItem("xp_steps_" + k) !== "0"; } catch (_) { open = true; }
  const box = xpMk("div", "xv-steps"), tg = xpMk("button"); tg.type = "button"; tg.id = "xp-steps-btn";
  tg.setAttribute("aria-expanded", String(open)); tg.setAttribute("aria-controls", "xp-steps-ol");
  const cv = xpMk("span", "cv"); cv.setAttribute("aria-hidden", "true"); tg.append(cv, xpMk("span", "", t("xp.steps", { platform })));
  const ol = xpMk("ol"); ol.id = "xp-steps-ol"; ol.hidden = !open;
  xpSteps(k, d).forEach((s) => ol.appendChild(xpMk("li", "", s)));
  tg.addEventListener("click", () => {
    const o = tg.getAttribute("aria-expanded") !== "true"; tg.setAttribute("aria-expanded", String(o)); ol.hidden = !o;
    try { localStorage.setItem("xp_steps_" + k, o ? "1" : "0"); } catch (_) { /* noop */ }
  });
  box.append(tg, ol); host.appendChild(box);
  const code = xpMk("div", "xv-code"); code.appendChild(xpMk("pre", "rp-code mono", ex.content)); host.appendChild(code);
}
function xpSteps(k, d) {
  const sym = d && typeof d.symbol === "string" ? d.symbol : "", iv = xpIvl(d && d.interval, k), ivl = iv ? t(iv[0], iv[1]) : "";
  const has = !!(sym && ivl);
  if (k === "pine") return [has ? t("xp.steps.pine.1", { sym, ivl }) : t("xp.steps.pine.1n"), t("xp.steps.pine.2"), t("xp.steps.pine.3")];
  if (k === "xq") return [t("xp.steps.xq.1"), has ? t("xp.steps.xq.2", { sym, ivl }) : t("xp.steps.xq.2n"), t("xp.steps.xq.3")];
  const extra = xpIsCrypto(d) ? t("xp.steps.mc.crypto") : "";
  return [t("xp.steps.mc.1"), has ? t("xp.steps.mc.2", { sym, ivl, extra }) : t("xp.steps.mc.2n", { extra }), t("xp.steps.mc.3")];
}
// 複製:鈕字換成勾 +「已複製」1.2 秒,先鎖住原寬(不跳);讀屏唸一次
async function xpCopy(btn, text) {
  try { await navigator.clipboard.writeText(text); } catch (_) { return; }
  trackFeature("export_copy");
  const label = btn.textContent; btn.style.minWidth = btn.offsetWidth + "px";
  btn.textContent = ""; btn.append(xpCheckIcon(), xpMk("span", "", t("xp.copied"))); srSay(t("xp.copied"));
  setTimeout(() => { if (!btn.isConnected) return; btn.textContent = label; btn.style.minWidth = ""; }, 1200);
}
