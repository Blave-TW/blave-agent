/* 策略版本(契約 .claude/docs/strategy-versions.md;設計 spec-desktop-strategy-versions-0.1.8,段號同 mockup)。
   選單以下的內容、字、流程照網頁工作頁已上線的那一套(web workspace.html 的 ver* / vc* / vg*);判斷與格式化是
   strategy_versions.js(web 那支原樣拷過來,window.blaveVersions),這裡只管 DOM 與取數。
   - 摘要清單掛在報告那一袋(RP / RPC)的 data.versions:這台電腦是主行程讀 versions/index.json,雲端是 /cloud/strategy 帶的。
   - 單版與比較:這台電腦走 loadVersion / compareVersions(主行程讀檔、跑 difflib),雲端走 cloudVersion(/cloud/version)。
   - 每個視角各記一份「正在看哪一版」;換策略、切視角、新版到了一律回目前版。
   - items 與 blob 每一欄都是機器上的 agent 寫的:型別檢查後一律 textContent。
   用到 app.js 的 $ / t / RP / RPC / rpBag / rpShowTab / confirmBox / submitMessage / running / trackFeature / trapTab / paneSt / paneToggle、
   trade.js 的 ENV / TR_BAGS / trMD / trStamp / trFmt / trUnit、handoff.js 的 hoPaint——都在呼叫時才取。 */
const VER = window.blaveVersions || null;
const VS = { local: null, cloud: null };
const verNewSide = () => ({ key: null, name: null, data: null, open: null, blob: null, state: "", seq: 0, shownAt: 0, cache: new Map() });
VS.local = verNewSide(); VS.cloud = verNewSide();

const verSideOf = (B) => (B === RPC ? "cloud" : "local");
function verEl(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function verEntry(S, n) { return VER ? VER.entries(S.data).find((i) => i.n === n) || null : null; }
function verDateShort(at) { return typeof at === "number" && isFinite(at) && at > 0 ? trMD(new Date(at * 1000)) : "—"; }
function verDateLong(at) { return typeof at === "number" && isFinite(at) && at > 0 ? trStamp(at) : "—"; }
/* 這支策略的下單金額(守門依據,canon §6 的真閘門在機器端 restore())。讀不到那一邊的回報 = null:不猜,徽章只畫「目前」、
   還原走一般確認框。金額表的 key 是 STRATEGY_NAME,多半等於資料夾名;兩個都看 */
function verAmount(side, B) {
  const st = typeof TR_BAGS !== "undefined" && TR_BAGS[side] ? TR_BAGS[side].st : null;
  const a = st && st.report && st.report.config && st.report.config.amounts;
  if (!a || typeof a !== "object") return null;
  let v = 0;
  [B.name, B.data && B.data.strategyName].forEach((n) => { const x = n && Object.prototype.hasOwnProperty.call(a, n) ? Number(a[n]) : 0; if (isFinite(x) && x > v) v = x; });
  return v;
}

/* ── 頁首(app.js rpPaintHead 每次畫頁首都叫):觸發器、橫幅、時光機裡收起「送上雲端 / 拉回」 ── */
function verPaint(B) {
  const side = verSideOf(B), S = VS[side];
  const versions = B.data && !B.data.pending ? B.data.versions : null;
  const ok = !!(VER && B.name && versions && VER.usable(B.name, versions));
  const key = ok ? [B.name, versions.current, versions.counter].join("|") : null;
  // 換了策略 / 新版到了(還原跑完多出 v+1):回目前版。切視角由下面的 data-env 觀察者處理
  if (key !== S.key) verReset(S);
  S.key = key; S.name = B.name; S.data = ok ? versions : null;
  verMenuClose(false);
  verPaintTrigger(S); verPaintBanner(S);
}
function verReset(S) { S.open = null; S.blob = null; S.state = ""; S.seq++; }
/* 切視角(trade.js envSwitch 改 <html data-env>):離開的那一邊回目前版——切回來時不留時光機,免得忘了自己在看舊版。
   觀察者在切換那一輪畫完之後才跑(microtask),所以只動離開的那一邊的狀態;回來時 rpRepaint 照目前版畫 */
new MutationObserver(() => {
  verReset(VS[ENV.cur === "cloud" ? "local" : "cloud"]);
  verMenuClose(false); vcClose();
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-env"] });
function verPaintTrigger(S) {
  const wrap = $("ver-wrap");
  // 看舊版時頁首只留名稱、說明收起來:那一句寫的是目前版的邏輯(看 v1 的 SMA20/50 時寫著 SMA50/200);
  // 不從版本碼裡解析舊的 DESCRIPTION。第二行固定 24 高(.rp-sub),收起來版面不跳
  const old = !!S.data && S.open !== null;
  $("rp-desc").hidden = old;
  if (!S.data) { wrap.hidden = true; $("ver-sep").hidden = true; return; }
  const n = S.open === null ? S.data.current : S.open, label = S.open === null ? t("ver.current") : verDateShort((verEntry(S, n) || {}).at);
  $("ver-trig-n").textContent = "v" + n;
  const l = $("ver-trig-l"); l.textContent = label; l.classList.toggle("mono", S.open !== null);
  $("ver-trig").setAttribute("aria-label", t("ver.aria", { v: "v" + n, label }));
  wrap.hidden = false; $("ver-sep").hidden = old || !$("rp-desc").textContent;
}
function verPaintBanner(S) {
  const bn = $("ver-banner"), on = !!S.data && S.open !== null;
  // 進出時光機、換策略、切視角都經過這裡:轉出鈕與程式碼分頁的檔案切換只屬於目前版(renderer/export.js)
  if (typeof xpSetTimeMachine === "function") xpSetTimeMachine(on ? "v" + S.open : null);
  if (!on) { bn.hidden = true; return; }
  const e = verEntry(S, S.open) || {}, txt = $("ver-banner-t");
  txt.textContent = "";
  const w = verEl("span", "w"), parts = t("ver.viewing").split("{v}");
  w.append(parts[0] || "", verEl("b", "mono", "v" + S.open), parts[1] || "");
  const zh = LANG === "zh";
  w.append(zh ? "（" : " (", verEl("span", "mono", verDateLong(e.at)), zh ? "）" : ")");
  txt.appendChild(w);
  const note = typeof e.note === "string" ? e.note.trim() : "";
  if (note) { const nt = verEl("span", "nt", "· " + note); nt.title = note; txt.appendChild(nt); }
  txt.appendChild(verEl("span", "ro", t("ver.readonly")));
  bn.hidden = false;
  $("rp-act").hidden = true;   // 「送上雲端 / 拉回」作用在現在那份檔,不是正在看的舊版(拍板 6);回到目前版由 hoPaint 畫回來
  verBusy();
}
// 回合進行中:「還原成這一版」是 aria-disabled(同頁首 #rp-ho:鍵盤停得上去、讀屏唸得到原因)。app.js 在上鎖 / 解鎖的同一處叫它
function verBusy() {
  const b = $("ver-restore"); if (!b) return;
  const busy = typeof running !== "undefined" && running === true;
  if (busy) { b.setAttribute("aria-disabled", "true"); b.title = t("turn.busy"); } else { b.removeAttribute("aria-disabled"); b.removeAttribute("title"); }
}

/* ── 選單 ── */
function verMenuOpen(viaKey) {
  const B = rpBag(), S = VS[verSideOf(B)];
  if (!S.data || !VER) return;
  const menu = $("ver-menu"); menu.textContent = "";
  menu.appendChild(verEl("p", "vmenu-cap", t("ver.menuLbl")));
  const list = verEl("div", "vlist"), shown = S.open === null ? S.data.current : S.open;
  const amt = verAmount(verSideOf(B), B), cloud = B === RPC;
  VER.entries(S.data).forEach((it) => {
    const b = verEl("button", "vmi"); b.type = "button"; b.setAttribute("role", "menuitem"); b.tabIndex = -1;
    if (it.n === shown) b.setAttribute("aria-current", "true");
    const top = verEl("span", "vmi-top");
    top.append(verEl("span", "vmi-num mono", "v" + it.n), verEl("span", "vmi-note", typeof it.note === "string" ? it.note : ""));
    const kind = VER.badge(it.n, S.data, amt, S.data.drift);
    if (kind) top.appendChild(verEl("span", "vtag " + (kind === "live" ? "live" : kind === "drift" ? "drift" : "cur"), t(kind === "live" ? "ver.live" : kind === "drift" ? "ver.drift" : "ver.current")));
    top.appendChild(verEl("span", "vmi-date mono", verDateShort(it.at)));
    b.appendChild(top);
    // 檔案已改的原因寫在列裡(不藏 tooltip);這台電腦直接讀 drift.json,沒有延遲那半句
    if (kind === "drift") b.appendChild(verEl("span", "vmi-warn", t(cloud ? "ver.driftCloud" : "ver.driftLocal")));
    const st = verEl("span", "vmi-stats");
    [["bt.totalReturn", "ret"], ["bt.sharpe", "sharpe"], ["ver.statP", "mcpt_p"]].forEach(([k, f]) => {
      const s = verEl("span", "", t(k)); s.appendChild(verEl("span", "v mono", VER.fmt(f, it[f]))); st.appendChild(s);
    });
    b.appendChild(st);
    b.addEventListener("click", () => verPick(it.n));
    list.appendChild(b);
  });
  menu.appendChild(list);
  menu.appendChild(verEl("div", "vmenu-div"));
  const cmp = verEl("button", "vmi vmenu-foot", t("ver.compareOpen")); cmp.type = "button"; cmp.setAttribute("role", "menuitem"); cmp.tabIndex = -1;
  cmp.addEventListener("click", () => { verMenuClose(false); vcOpen(); });
  menu.appendChild(cmp);
  menu.hidden = false; $("ver-wrap").classList.add("is-open"); $("ver-trig").setAttribute("aria-expanded", "true");
  // 面板不超出中欄底:清單自己捲,標題與「比較兩個版本…」不捲
  const rp = $("rp").getBoundingClientRect(), tr = $("ver-trig").getBoundingClientRect();
  menu.style.maxHeight = Math.max(160, Math.floor(rp.bottom - tr.bottom - 8 - 16)) + "px";
  const cur = list.querySelector('[aria-current="true"]') || list.firstChild;
  if (viaKey && cur) cur.focus();   // 滑鼠開的不搬焦點(同 mpOpen:程式轉移的焦點會繼承 focus-visible)
  trackFeature("version_menu");
}
function verMenuClose(refocus) {
  const menu = $("ver-menu"); if (!menu || menu.hidden) return;
  menu.hidden = true; $("ver-wrap").classList.remove("is-open"); $("ver-trig").setAttribute("aria-expanded", "false");
  if (refocus) $("ver-trig").focus();
}
$("ver-trig").addEventListener("click", (e) => ($("ver-menu").hidden ? verMenuOpen(e.detail === 0) : verMenuClose(true)));
$("ver-trig").addEventListener("keydown", (e) => {
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && $("ver-menu").hidden) { e.preventDefault(); verMenuOpen(true); }
});
$("ver-menu").addEventListener("keydown", (e) => {
  const items = [...$("ver-menu").querySelectorAll('[role="menuitem"]')], i = items.indexOf(document.activeElement);
  const go = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
  if (go !== undefined) { e.preventDefault(); const k = (go + items.length) % items.length; if (items[k]) items[k].focus(); return; }
  if (e.key === "Tab") verMenuClose(false);
});
document.addEventListener("mousedown", (e) => { if (!$("ver-wrap").contains(e.target)) verMenuClose(false); });

/* ── 時光機 ── */
function verPick(n) {
  verMenuClose(true);
  const B = rpBag(), side = verSideOf(B), S = VS[side];
  if (!S.data) return;
  if (n === S.data.current) { verBack(); return; }
  S.open = n; S.blob = null; S.state = ""; S.seq++;
  B.drawn = {};   // 目前版的圖被舊版蓋掉:回到目前版時要重畫
  verPaintTrigger(S); verPaintBanner(S);
  trackFeature("version_view");
  verLoad(side, n);
}
function verBack() {
  const B = rpBag(), S = VS[verSideOf(B)];
  if (S.open === null) return;
  verReset(S);
  B.drawn = {};
  $("rp-code-pre").textContent = (B.data && B.data.code) || "";
  hoPaint();
  verPaintTrigger(S); verPaintBanner(S);
  rpShowTab(B.data && B.data.stats ? B.tab : "code");
}
/* app.js rpShowTab 的第一行:時光機開著就由這裡畫(回 true),否則回 false 照原本的畫。
   進出場紀錄 / 參數掃描真的 disabled,原因講在分頁列正下方那一行(#rp-nobt,「沒有回測」同一個槽) */
function verShowTab(tab) {
  const B = rpBag(), S = VS[verSideOf(B)], nobt = $("rp-nobt");
  if (!S.data || S.open === null || S.name !== B.name) { nobt.textContent = t("rp.noBt"); return false; }
  const cur = tab === "code" ? "code" : "bt";
  B.tab = cur;
  $("rp-tabs").hidden = false;
  $("rp-tabs").querySelectorAll(".rp-tab").forEach((b) => {
    b.setAttribute("aria-selected", b.dataset.tab === cur ? "true" : "false");
    b.disabled = b.dataset.tab === "tr" || b.dataset.tab === "rob";
  });
  nobt.textContent = t("ver.frozenTab"); nobt.hidden = false;
  const w = $("rp-wait");
  for (const k of ["bt", "tr", "rob", "code"]) $("rp-" + k).hidden = true;
  if (!S.blob) { verStatePaint(S); return true; }
  w.hidden = true; w.textContent = "";
  $("rp-" + cur).hidden = false;
  if (cur === "code") $("rp-code-pre").textContent = typeof S.blob.code === "string" ? S.blob.code : "";
  else if (window.BlaveReport && window.BlaveReport.renderBacktest) window.BlaveReport.renderBacktest($("rp-bt"), verStats(S.blob));
  return true;
}
/* blob → 回測面板吃的 stats 形狀(拍板 4:重用既有面板)。六個數字 + 區間 + 日報酬;沒存的(基準、Omega、總手續費、標的、週期、費率)
   本來就是「不在」,面板畫「—」或整塊不畫。__noPerm:MCPT 只存了 p、沒有排列次數 */
function verStats(b) {
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : undefined), str = (v) => (typeof v === "string" ? v : undefined);
  return { "Total Return [%]": num(b.ret), "Sharpe Ratio": num(b.sharpe), "Sortino Ratio": num(b.sortino), "Max Drawdown [%]": num(b.mdd),
    "Trades": num(b.trades), "MCPT p-value": num(b.mcpt_p), start: str(b.start), end: str(b.end),
    daily_dates: Array.isArray(b.daily_dates) ? b.daily_dates : [], daily_returns: Array.isArray(b.daily_returns) ? b.daily_returns : [], __noPerm: true };
}
// 等待 / 還在同步 / 讀不到:同一個槽(#rp-wait),互斥。載入中 200ms 後才出、出了至少撐 300ms(app.js RP_WAIT_*)
function verStatePaint(S) {
  const w = $("rp-wait"); w.textContent = ""; w.hidden = false;
  const line = document.createElement("p");
  if (S.state === "syncing") { line.className = "cx-wait"; line.textContent = t("ver.syncing"); w.appendChild(line); return; }
  if (S.state === "error") {
    line.className = "plan-err"; const m = verEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); line.append(m, t("ver.readErr"));
    const again = verEl("button", "btn-out", t("plan.recheck")); again.type = "button";
    const side = S === VS.cloud ? "cloud" : "local", n = S.open;
    again.addEventListener("click", () => verLoad(side, n));
    w.append(line, again); return;
  }
  line.className = "cx-wait"; const sp = verEl("span", "spin16"); sp.setAttribute("aria-hidden", "true"); line.append(sp, t("tr.loading"));
  line.hidden = true; w.appendChild(line);
  S.shownAt = 0;
  setTimeout(() => { if (line.isConnected && !w.hidden) { line.hidden = false; S.shownAt = Date.now(); } }, RP_WAIT_DELAY_MS);
}
function verRefresh(side) {
  const B = side === "cloud" ? RPC : RP;
  if (rpBag() === B && !$("rp").hidden) rpShowTab(B.tab);
}
// 版本 immutable(canon §3):抓過就不再打。快取 key 帶 code_hash:換了帳號、同名同號的另一支不會拿到上一個人的那份
async function verLoad(side, n) {
  const S = VS[side], seq = ++S.seq, e = verEntry(S, n);
  const ck = S.name + "|" + n + "|" + (e && typeof e.code_hash === "string" ? e.code_hash : "");
  const hit = S.cache.get(ck);
  if (hit) { S.blob = hit; S.state = ""; verRefresh(side); return; }
  S.blob = null; S.state = "loading"; verRefresh(side);
  let r = null;
  try { r = side === "cloud" ? await window.blave.cloudVersion({ name: S.name, op: "get", n }) : await window.blave.loadVersion(S.name, n); } catch (_) { r = null; }
  if (seq !== S.seq) return;
  const hold = rpWaitHold(S.shownAt, Date.now());
  if (hold) { await new Promise((ok) => setTimeout(ok, hold)); if (seq !== S.seq) return; }
  if (r && r.code === "OK" && r.blob && typeof r.blob === "object") { S.cache.set(ck, r.blob); S.blob = r.blob; S.state = ""; }
  else S.state = r && r.code === "SYNCING" ? "syncing" : "error";
  verRefresh(side);
}

/* ── 還原 / 上線中守門(canon §5 / §6) ── */
function verSend(msg) {
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);   // 聊天欄收著就先展開:過程在那裡
  return submitMessage(msg);
}
function verRestoreAsk() {
  const B = rpBag(), side = verSideOf(B), S = VS[side];
  if (!S.data || S.open === null || running) return;
  const n = S.open, cur = S.data.current, cloud = side === "cloud", opener = $("ver-restore");
  const display = VER.safeName(B.data.displayName) || B.name;   // 規則只有一份,在 strategy_versions.js(稽核 S4)
  const env = cloud ? "cloud" : undefined, footWhere = cloud ? t("ver.where", { name: display }) : undefined;
  const vars = { display_name: display, name: B.name, n: String(n) };
  const amt = verAmount(side, B);
  if (typeof amt === "number" && amt > 0) {
    // 有金額:不走還原,改開守門框(機器端 restore() 無論如何都會拒絕;這個框是讓人在按下去之前就知道)
    const extra = document.createDocumentFragment(), money = (trFmt(amt) || String(amt)) + " " + trUnit();
    extra.appendChild(verEl("p", "", t("ver.guardLead", { name: display, amt: money, cur: "v" + cur, v: "v" + n })));
    const ol = verEl("ol", "vg-steps");
    ["ver.guardS1", "ver.guardS2", "ver.guardS3"].forEach((k) => ol.appendChild(verEl("li", "", t(k, { v: "v" + n }))));
    extra.appendChild(ol);
    extra.appendChild(verEl("p", "cf-note", t("ver.guardNote")));
    confirmBox({ title: t("ver.guardTitle"), lines: [], extra, ok: t("ver.guardOk", { v: "v" + n }), opener, env, footWhere,
      onOk: () => verSend(t("ver.msgFork", vars)).then((ok) => { if (ok) trackFeature("version_fork"); }) });
    return;
  }
  confirmBox({ title: t("ver.rsTitle", { v: "v" + n }), lines: [t("ver.rsB1", { v: "v" + n }), t("ver.rsB2", { cur: "v" + cur })], ok: t("ver.rsOk"), opener, env, footWhere,
    onOk: () => verSend(t("ver.msgRestore", vars)).then((ok) => { if (ok) trackFeature("version_restore"); }) });
}
$("ver-back").addEventListener("click", verBack);
$("ver-restore").addEventListener("click", () => { if ($("ver-restore").getAttribute("aria-disabled") !== "true") verRestoreAsk(); });

/* ── 比較兩個版本(唯讀、沒有腳;預設 A = 正在看的舊版或上一版、B = 目前版) ── */
let vcSeq = 0, vcSide = null;
function vcFill(sel, S, pick) {
  sel.textContent = "";
  VER.entries(S.data).forEach((it) => {
    const o = document.createElement("option"); o.value = String(it.n);
    o.textContent = "v" + it.n + " · " + verDateLong(it.at) + (it.n === S.data.current ? " · " + t("ver.current") : "");
    sel.appendChild(o);
  });
  sel.value = String(pick);
}
function vcOpen() {
  const B = rpBag(), side = verSideOf(B), S = VS[side];
  if (!S.data || !VER) return;
  const items = VER.entries(S.data);
  vcSide = side;
  vcFill($("vc-a"), S, S.open !== null ? S.open : items[1].n);
  vcFill($("vc-b"), S, items[0].n);
  $("view-ws").inert = true;
  const sc = $("vc-scrim"); sc.hidden = false;
  requestAnimationFrame(() => sc.classList.add("open"));
  $("vc-a").focus();
  trackFeature("version_compare");
  vcLoad();
}
function vcClose() {
  const sc = $("vc-scrim"); if (sc.hidden) return;
  vcSeq++; sc.classList.remove("open"); sc.hidden = true; $("view-ws").inert = false;
  const tr = $("ver-trig"); if (tr && tr.offsetParent) tr.focus();
}
async function vcLoad() {
  const out = $("vc-out"), S = VS[vcSide], a = parseInt($("vc-a").value, 10), b = parseInt($("vc-b").value, 10), seq = ++vcSeq;
  out.textContent = "";
  if (!(a > 0) || !(b > 0) || !S || !S.name) return;
  if (a === b) { out.appendChild(verEl("p", "vc-note", t("ver.cmpSameVersion"))); return; }
  const wait = verEl("p", "cx-wait"), sp = verEl("span", "spin16"); sp.setAttribute("aria-hidden", "true"); wait.append(sp, t("tr.loading")); wait.hidden = true;
  out.appendChild(wait);
  let shownAt = 0;
  setTimeout(() => { if (wait.isConnected) { wait.hidden = false; shownAt = Date.now(); } }, RP_WAIT_DELAY_MS);
  let r = null;
  try { r = vcSide === "cloud" ? await window.blave.cloudVersion({ name: S.name, op: "compare", a, b }) : await window.blave.compareVersions(S.name, a, b); } catch (_) { r = null; }
  if (seq !== vcSeq) return;
  const hold = rpWaitHold(shownAt, Date.now());
  if (hold) { await new Promise((ok) => setTimeout(ok, hold)); if (seq !== vcSeq) return; }
  out.textContent = "";
  if (r && r.code === "SYNCING") {   // canon §9 的上傳落差,不是錯誤(只有雲端)
    const miss = Array.isArray(r.missing) && r.missing.length ? r.missing : [a, b];
    out.appendChild(verEl("p", "vc-note", t("ver.cmpSyncing", { v: miss.map((n) => "v" + n).join(LANG === "zh" ? "、" : ", ") })));
    return;
  }
  if (!r || r.code !== "OK" || !r.data) {
    const line = verEl("p", "plan-err"), m = verEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); line.append(m, t("ver.readErr"));
    const again = verEl("button", "btn-out", t("plan.recheck")); again.type = "button"; again.addEventListener("click", vcLoad);
    out.append(line, again); return;
  }
  vcRender(out, r.data);
}
function vcRender(out, d) {
  const A = d.a || {}, B = d.b || {};
  const tbl = verEl("table", "vc-tbl"), thead = document.createElement("thead"), htr = document.createElement("tr");
  [t("ver.cmpMetric"), "v" + A.n, "v" + B.n, t("ver.cmpDelta")].forEach((x) => htr.appendChild(verEl("th", "", x)));
  thead.appendChild(htr); tbl.appendChild(thead);
  const tb = document.createElement("tbody");
  [["bt.totalReturn", "ret"], ["bt.sharpe", "sharpe"], ["bt.sortino", "sortino"], ["bt.maxDrawdown", "mdd"], ["bt.mcpt", "mcpt_p"], ["bt.trades", "trades"]].forEach(([k, f]) => {
    const tr = document.createElement("tr");
    [t(k), VER.fmt(f, A[f]), VER.fmt(f, B[f])].forEach((x) => tr.appendChild(verEl("td", "", x)));
    const dl = VER.delta(f, A[f], B[f]), td = verEl("td", dl.tone || "", dl.text);   // 差值照指標語意上色:回撤變大、p 變大都是紅
    tr.appendChild(td); tb.appendChild(tr);
  });
  tbl.appendChild(tb); out.appendChild(tbl);
  if (VER.windowsDiffer(A, B)) out.appendChild(verEl("p", "vc-note", t("ver.cmpWindow", { a: (A.start || "—") + "→" + (A.end || "—"), b: (B.start || "—") + "→" + (B.end || "—") })));
  const hunks = Array.isArray(d.hunks) ? d.hunks : [];
  if (!hunks.length) { out.appendChild(verEl("p", "vc-sec", t("ver.cmpNoDiff"))); return; }
  out.appendChild(verEl("p", "vc-sec", t("ver.cmpCode", { n: String(hunks.length) })));
  const box = verEl("div", "vc-diff");
  hunks.forEach((h) => {
    if (!h || typeof h !== "object") return;
    box.appendChild(verEl("div", "hk", "@@ −" + h.a_start + "," + h.a_count + " +" + h.b_start + "," + h.b_count + " @@"));
    (Array.isArray(h.lines) ? h.lines : []).forEach((ln) => {
      if (!Array.isArray(ln)) return;
      const tag = ln[0] === "add" ? "add" : ln[0] === "del" ? "del" : "";
      const row = verEl("div", "ln" + (tag ? " " + tag : ""));
      row.append(verEl("span", "s", tag === "add" ? "+" : tag === "del" ? "−" : " "), String(ln[1] == null ? "" : ln[1]));
      box.appendChild(row);
    });
  });
  out.appendChild(box);
  if (d.truncated) out.appendChild(verEl("p", "vc-note", t("ver.cmpTruncated")));   // 顯示的不是整份差異時要說,不能讓人以為其餘相同
}
$("vc-close").addEventListener("click", vcClose);
$("vc-scrim").addEventListener("mousedown", (e) => { if (e.target === $("vc-scrim")) vcClose(); });
$("vc-scrim").addEventListener("keydown", (e) => trapTab(e, $("vc-modal")));
["vc-a", "vc-b"].forEach((id) => $(id).addEventListener("change", vcLoad));
// Esc:比較框 → 選單,一次關一層。capture:app.js 的 escTop 不認得這兩層,先在這裡收掉、不往下傳
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.isComposing || e.keyCode === 229) return;
  if (!$("vc-scrim").hidden) { e.preventDefault(); e.stopPropagation(); vcClose(); return; }
  if (!$("ver-menu").hidden) { e.preventDefault(); e.stopPropagation(); verMenuClose(true); }
}, true);
