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
const verNewSide = () => ({ key: null, name: null, data: null, open: null, blob: null, state: "", seq: 0, shownAt: 0, cache: new Map(), err: null, pend: null });
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

/* ── 就地還原的疊層(canon §5;spec-strategy-versions-restore-in-place-0.1.9 §3):按下確認的當下就把 vN 當「目前」、狀態「重跑中」,
   不等機器。疊層以 side|名字為 key、存在 VS 之外:verPaint 每次畫頁首都重設 open / data,報告先到也不能把它洗掉。
   收到 ack 之後、報告也跟上(current === n)才拿掉、從此以報告為準——ack 之前讀到的 current === n 可能落在「index 已指到 n、
   rerun.json 還沒寫」的空檔(稽核 0.1.9 P1-2),那時拿掉會把畫面丟回「沒有回測」、輪詢跟著停。
   ack 回錯 / inplace:false / ack 後 2 分鐘報告仍沒跟上 → 回滾(verRollback)。 */
const VO = new Map(), VREQ = new Map();
const VP = { local: null, cloud: null };            // 每邊一支輪詢(還原不經回合,stratRefresh 不會跑)
// 輪詢上限從 ack 起算:機器端最晚 = restore 子行程上限 120 秒 + 重跑逾時 15 分鐘 + 殺掉與推送的餘裕(稽核 P2-8)
const VER_ROLLBACK_MS = 120000, VER_POLL_MAX_MS = (15 * 60 + 120 + 120) * 1000, VER_POLL_MS = { local: 2000, cloud: 5000 };
const voKey = (side, name) => side + "|" + name;
function verEffective(side, name, raw) {
  const k = voKey(side, name), o = raw ? VO.get(k) : null;
  if (!o) return raw;
  const rr = raw.rerun;
  // 報告跟上了:current 已是 n,而且不是「再跑一次」之前那一筆 failed(那一筆的 at 記在 failedAt)
  if (o.ackAt && raw.current === o.n && !(rr && rr.status === "failed" && o.failedAt != null && rr.at === o.failedAt)) { VO.delete(k); return raw; }
  return Object.assign({}, raw, { current: o.n, rerun: { n: o.n, status: "running", at: o.at } });
}
function verPendingOf(side, B) {
  const raw = B && B.data && !B.data.pending ? B.data.versions : null;
  return VER && raw ? VER.pending(verEffective(side, B.name, raw)) : null;
}
// app.js rpTab:重跑中 / 沒完成時 stats.json 被移開了,分頁不能被拉回程式碼
function verHolds(B) { return !!verPendingOf(verSideOf(B), B); }
// 「送上雲端 / 拉回」要不要收起來(handoff.js hoPaint 問):時光機裡、重跑中
function verHidesAct() {
  const B = rpBag(), S = VS[verSideOf(B)];
  if (!S.data || S.name !== B.name) return false;
  const pd = S.open === null && VER ? VER.pending(S.data) : null;
  return S.open !== null || !!(pd && pd.status === "running");
}

/* ── 頁首(app.js rpPaintHead 每次畫頁首都叫):觸發器、橫幅、時光機裡收起「送上雲端 / 拉回」 ── */
function verPaint(B) {
  const side = verSideOf(B), S = VS[side];
  const raw = B.data && !B.data.pending ? B.data.versions : null;
  const versions = verEffective(side, B.name, raw);
  const ok = !!(VER && B.name && versions && VER.usable(B.name, versions));
  const key = ok ? [B.name, versions.current, versions.counter].join("|") : null;
  // 換了策略 / 新版到了 / 還原(疊層把 current 換成 n):回目前版。切視角由下面的 data-env 觀察者處理
  if (key !== S.key) verReset(S);
  S.key = key; S.name = B.name; S.data = ok ? versions : null;
  const pd = ok ? VER.pending(versions) : null;
  // 重跑完:狀態列整列收掉,讀屏聽不到,另唸一句(spec §5)。沒完成 → 完成、或被新回測接手都算;換策略不算
  if (S.pend && !pd && S.pend.name === B.name && ok && versions.current === S.pend.n && B.data.stats && typeof srSay === "function")
    srSay(t("ver.rerunDoneSr", { v: "v" + S.pend.n }));
  S.pend = pd ? { name: B.name, n: pd.n, status: pd.status } : null;
  verMenuClose(false);
  verPaintTrigger(S); verPaintBanner(S);
  // rpPaintHead 先叫 hoPaint 才叫這裡:重跑剛完成的那一次,hoPaint 問到的還是「重跑中」而收起了鈕,這裡補畫回來
  if (!verHidesAct() && $("rp-act").hidden && typeof hoPaint === "function") hoPaint();
  verPollEnsure(side, B);
}
function verReset(S) { S.open = null; S.blob = null; S.state = ""; S.seq++; S.err = null; }
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
  // 重跑中也收起:手上那句可能還是上一版碼的 DESCRIPTION;回報(完成或沒完成)到了才填回
  const pd = S.data && S.open === null && VER ? VER.pending(S.data) : null;
  const old = !!S.data && (S.open !== null || !!(pd && pd.status === "running"));
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
  // 進出時光機、換策略、切視角都經過這裡:轉出鈕與程式碼分頁的檔案切換只屬於目前版(renderer/export.js)。
  // 重跑中不算時光機:檔案現在就是 vN 的碼,轉出照常
  if (typeof xpSetTimeMachine === "function") xpSetTimeMachine(on ? "v" + S.open : null);
  verPaintErr(S);
  // 時光機橫幅與重跑狀態列同一槽、互斥:時光機開著時狀態列暫時不畫,回到目前版再出來
  verPaintRerun(S, !on && S.data && VER ? VER.pending(S.data) : null);
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
/* 重跑狀態列(spec §4 / §6):重跑中 = 圓環 + 一句;沒完成 = fault 記號 + 一句 +「再跑一次」(REFUSED 不給鈕、接尾句)。
   role="status":內容只在狀態真的變了才重建,每次畫頁首都重建會讓讀屏一直重唸 */
const RERUN_WHY = { DATA: "data", REFUSED: "refused", TIMEOUT: "timeout" };
function verPaintRerun(S, pd) {
  const rr = $("ver-rerun"); if (!rr) return;
  if (!pd) { rr.hidden = true; rr.textContent = ""; delete rr.dataset.sig; return; }
  if (pd.status === "running") $("rp-act").hidden = true;   // 送上雲端 / 拉回:重跑中收起(Wei 決定 6);沒完成是穩定狀態,照常
  // 「再跑一次」被拒的原因(稽核 L1):只跟著按下時那一筆 failed;狀態一變(重跑中、完成、換了一筆、換策略)就收掉
  const e = S.rerr, rr0 = S.data && S.data.rerun;
  if (e && !(pd.status === "failed" && pd.n === e.n && S.name === e.name && (e.at == null || (rr0 && rr0.at === e.at)))) S.rerr = null;
  const sig = [pd.status, pd.n, pd.err, LANG, S.rerr ? 1 : 0].join("|");
  if (rr.dataset.sig !== sig || rr.hidden) {
    rr.textContent = ""; rr.dataset.sig = sig;
    const line = verEl("p", "vr-t"), mark = verEl("span", pd.status === "running" ? "spin16" : "fault-mark");
    mark.setAttribute("aria-hidden", "true");
    const txt = verEl("span"), why = t("ver.rerunWhy." + (RERUN_WHY[pd.err] || "exit"));
    t(pd.status === "running" ? "ver.rerunRunning" : "ver.rerunFailed").split(/(\{v\}|\{why\})/).forEach((p) => {
      if (p === "{v}") txt.appendChild(verEl("b", "mono", "v" + pd.n)); else if (p === "{why}") txt.append(why); else if (p) txt.append(p);
    });
    if (pd.status === "failed" && pd.err === "REFUSED") txt.append((LANG === "zh" ? "" : " ") + t("ver.rerunRefusedTail"));
    line.append(mark, txt); rr.appendChild(line);
    if (pd.status === "failed" && pd.err !== "REFUSED") {
      const again = verEl("button", "btn-out", t("ver.rerunRetry")); again.type = "button"; again.id = "ver-retry";
      // 按下去這顆鈕就隨狀態列重建消失:焦點交給版本觸發器,不掉到 body
      again.addEventListener("click", () => {
        if (again.getAttribute("aria-disabled") === "true") { verBusyNote($("ver-rerun-busy")); return; }   // 觸控看不到 title:原因寫在列裡(設計稽核 S8)
        if (!verRetry()) return;
        const tr = $("ver-trig"); if (tr) tr.focus();
      });
      rr.appendChild(again);
      const busy = verEl("p", "vb-err"); busy.id = "ver-rerun-busy"; busy.hidden = true;
      rr.appendChild(busy);
      if (S.rerr) {
        const why2 = verEl("p", "vb-err"), m2 = verEl("span", "fault-mark");
        why2.id = "ver-rerun-err"; m2.setAttribute("aria-hidden", "true");
        why2.append(m2, verEl("span", "", t("ver.rerunRetryErr"))); rr.appendChild(why2);
      }
    }
  }
  rr.hidden = false;
  verBusy();
}
// 回滾的原因行(spec §7):時光機橫幅文字與鈕的下方;離開時光機(verReset)或再按一次還原就收掉
function verPaintErr(S) {
  const el = $("ver-banner-err"); if (!el) return;
  el.textContent = "";
  if (!S.err || S.open === null) { el.hidden = true; return; }
  const m = verEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true");
  const txt = verEl("span");
  t(S.err.key).split("{v}").forEach((p, i) => { if (i) txt.appendChild(verEl("span", "mono", "v" + S.err.v)); if (p) txt.append(p); });
  el.append(m, txt); el.hidden = false;
}
// 點到 aria-disabled 的鈕(回合進行中):把 turn.busy 寫進那一列的原因行,同回滾原因行的 recipe;回合結束(verBusy)就收掉
function verBusyNote(el) {
  if (!el) return;
  el.textContent = "";
  const m = verEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true");
  el.append(m, verEl("span", "", t("turn.busy"))); el.hidden = false;
}
// 回合進行中:「還原成這一版」「再跑一次」是 aria-disabled(同頁首 #rp-ho:鍵盤停得上去、讀屏唸得到原因)。app.js 在上鎖 / 解鎖的同一處叫它
function verBusy() {
  const busy = typeof running !== "undefined" && running === true;
  if (!busy) {
    const nb = $("ver-rerun-busy"); if (nb) nb.hidden = true;
    const S = VS[verSideOf(rpBag())];
    if (S.err && S.err.key === "turn.busy") { S.err = null; verPaintErr(S); }
  }
  ["ver-restore", "ver-retry"].forEach((id) => {
    const b = $(id); if (!b) return;
    if (busy) { b.setAttribute("aria-disabled", "true"); b.title = t("turn.busy"); } else { b.removeAttribute("aria-disabled"); b.removeAttribute("title"); }
  });
}

/* ── 選單 ── */
function verMenuOpen(viaKey) {
  const B = rpBag(), S = VS[verSideOf(B)];
  if (!S.data || !VER) return;
  const menu = $("ver-menu"); menu.textContent = "";
  menu.appendChild(verEl("p", "vmenu-cap", t("ver.menuLbl")));
  const list = verEl("div", "vlist"), shown = S.open === null ? S.data.current : S.open;
  const amt = verAmount(verSideOf(B), B), cloud = B === RPC;
  const pst = B.data && !B.data.pending ? B.data.stats : null, pageEnd = pst && typeof pst.end === "string" ? pst.end : null;
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
    const w = VER.windowNote(it.n, S.data, pageEnd, shown);
    if (w) {
      const note = verEl("span", "vmi-win");
      t("ver.winNote").split(/(\{saved\}|\{page\})/).forEach((p) => {
        if (p === "{saved}" || p === "{page}") note.appendChild(verEl("span", "mono", p === "{saved}" ? w.saved : w.page));
        else if (p) note.append(p);
      });
      b.appendChild(note);
    }
    b.addEventListener("click", () => verPick(it.n));
    list.appendChild(b);
  });
  menu.appendChild(list);
  menu.appendChild(verEl("div", "vmenu-div"));
  if (VER.canCompare(S.data)) {
    menu.removeAttribute("aria-describedby");
    const cmp = verEl("button", "vmi vmenu-foot", t("ver.compareOpen")); cmp.type = "button"; cmp.setAttribute("role", "menuitem"); cmp.tabIndex = -1;
    cmp.addEventListener("click", () => { verMenuClose(false); vcOpen(); });
    menu.appendChild(cmp);
  } else {
    // 只有一版:比較不畫(不是停用),這一格換成一句引導。不是 menuitem——方向鍵與 Tab 不停在上面,讀屏靠選單的 aria-describedby 唸
    const hint = verEl("p", "vmenu-hint"), parts = t("ver.oneHint").split("{next}");
    hint.id = "ver-hint";
    hint.append(parts[0] || "", verEl("span", "mono", "v" + VER.nextN(S.data)), parts[1] || "");
    menu.appendChild(hint);
    menu.setAttribute("aria-describedby", "ver-hint");
  }
  menu.hidden = false; $("ver-wrap").classList.add("is-open"); $("ver-trig").setAttribute("aria-expanded", "true");
  // 面板不超出中欄底:清單自己捲,標題與最下面那一格(比較列 / 引導句)不捲
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
  rpShowTab(rpTab(B));
}
/* app.js rpShowTab 的第一行:時光機開著就由這裡畫(回 true),否則回 false 照原本的畫。
   進出場紀錄 / 參數掃描 / 樣本外驗證真的 disabled,原因講在分頁列正下方那一行(#rp-nobt,「沒有回測」同一個槽) */
/* 重跑中 / 沒完成(pending,看的是目前版)也由這裡畫:stats.json 已移開、或還是別的碼的結果,回測分頁畫 vN 存的 blob(spec §3、§10 最後一條) */
function verShowTab(tab) {
  const B = rpBag(), side = verSideOf(B), S = VS[side], nobt = $("rp-nobt");
  const pd = S.data && S.open === null && S.name === B.name && VER ? VER.pending(S.data) : null;
  if (!S.data || (S.open === null && !pd) || S.name !== B.name) { nobt.textContent = t("rp.noBt"); return false; }
  const n = S.open !== null ? S.open : S.data.current;
  const cur = tab === "code" ? "code" : "bt";
  B.tab = cur; B.drawn = {};   // 面板被 blob 蓋過:回到一般畫法時要重畫
  $("rp-tabs").hidden = false;
  $("rp-tabs").querySelectorAll(".rp-tab").forEach((b) => {
    b.setAttribute("aria-selected", b.dataset.tab === cur ? "true" : "false");
    b.disabled = b.dataset.tab === "tr" || b.dataset.tab === "rob" || b.dataset.tab === "wf";
  });
  if (typeof rpTabRevealSelected === "function") rpTabRevealSelected();
  const why = !pd ? "ver.frozenTab" : pd.status === "failed" ? "ver.frozenRerunFailed" : "ver.frozenRerun";
  nobt.dataset.i18n = why; nobt.textContent = t(why); nobt.hidden = false;
  const w = $("rp-wait");
  for (const k of ["bt", "tr", "rob", "wf", "code"]) $("rp-" + k).hidden = true;
  if (!S.blob) {
    if (!S.state) { verLoad(side, n); if (S.blob) return true; }   // 重跑中那一版的 blob 多半已在快取(時光機剛看過),零等待
    verStatePaint(S); return true;
  }
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
    const side = S === VS.cloud ? "cloud" : "local", n = S.open !== null ? S.open : S.data && S.data.current;
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

/* ── 還原 / 上線中守門(canon §5 / §6;spec-strategy-versions-restore-in-place-0.1.9 §1–§3、§7)──
   按下「還原成這一版」依序:有金額 → 守門框;雲端主機的 lib 太舊 → 更新框;其餘 → 還原確認框 → 直接指令 version_restore。
   不經 agent、不展開聊天欄。這台電腦的 lib 跟 app 同包,不出更新框(真的舊了由 ack 的 UPDATE_REQUIRED 接住) */
function verSend(msg) {
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);   // 聊天欄收著就先展開:過程在那裡
  return submitMessage(msg);
}
function verBoxCtx(side, B) {
  const cloud = side === "cloud", display = VER.safeName(B.data.displayName) || B.name;   // 規則只有一份,在 strategy_versions.js(稽核 S4)
  return { display, env: cloud ? "cloud" : undefined, footWhere: cloud ? t("ver.where", { name: display }) : undefined, opener: $("ver-restore") };
}
// 有金額:不走還原,改開守門框(機器端 restore() 無論如何都會拒絕;這個框是讓人在按下去之前就知道)。amt 讀不到(ack 回 LIVE)用不帶金額的 lead
function verGuard(side, B, n, cur, amt) {
  const c = verBoxCtx(side, B), vars = { display_name: c.display, name: B.name, n: String(n) };
  const extra = document.createDocumentFragment();
  const lead = typeof amt === "number" && amt > 0
    ? t("ver.guardLead", { name: c.display, amt: (trFmt(amt) || String(amt)) + " " + trUnit(), cur: "v" + cur, v: "v" + n })
    : t("ver.guardLeadNoAmt", { name: c.display, cur: "v" + cur, v: "v" + n });
  extra.appendChild(verEl("p", "", lead));
  const ol = verEl("ol", "vg-steps");
  ["ver.guardS1", "ver.guardS2", "ver.guardS3"].forEach((k) => ol.appendChild(verEl("li", "", t(k, { v: "v" + n }))));
  extra.appendChild(ol);
  extra.appendChild(verEl("p", "cf-note", t("ver.guardNote")));
  confirmBox({ title: t("ver.guardTitle"), lines: [], extra, ok: t("ver.guardOk", { v: "v" + n }), opener: c.opener, env: c.env, footWhere: c.footWhere,
    onOk: () => verSend(t("ver.msgFork", vars)).then((ok) => { if (ok) trackFeature("version_fork"); }) });
}
// 雲端主機的 lib 還不會就地還原:主鈕 = minv.btn 那一套(設定 › 一般、焦點在「檢查更新」);不退回交給 agent 的固定訊息
function verNeedUpdate(side, B, n, opener) {
  const c = verBoxCtx(side, B);
  confirmBox({ title: t("ver.rsTitle", { v: "v" + n }), lines: [t("ver.needUpdate")], ok: t("minv.btn"), opener: opener || c.opener, env: c.env, footWhere: c.footWhere,
    onOk: () => setOpen().then(() => { setCat("display"); const b = $("set-up-btn"); if (b && !b.hidden) b.focus(); }) });
}
function verRestoreAsk() {
  const B = rpBag(), side = verSideOf(B), S = VS[side];
  if (!S.data || S.open === null || running) return;
  const n = S.open, cur = S.data.current;
  S.err = null; verPaintErr(S);
  const amt = verAmount(side, B);
  if (typeof amt === "number" && amt > 0) { verGuard(side, B, n, cur, amt); return; }
  if (side === "cloud" && !VER.canRestoreInPlace(S.data)) { verNeedUpdate(side, B, n); return; }
  const c = verBoxCtx(side, B);
  // 沒回測過的修改會先另存:事前不知道檔案有沒有被改過,所以每次都講(Wei 拍板 Q1)
  confirmBox({ title: t("ver.rsTitle", { v: "v" + n }), lines: [t("ver.rsB1", { v: "v" + n }), t("ver.rsB2", { v: "v" + n, cur: "v" + cur })],
    extra: verEl("p", "cf-note", t("ver.rsNote")), ok: t("ver.rsOk"), opener: c.opener, env: c.env, footWhere: c.footWhere,
    onOk: () => verDoRestore(side, B.name, n, cur, false) });
}
// 「再跑一次」(沒完成時):同一條指令、同一個 {name, n};按下當下切回重跑中。不記埋點(spec §11)。回 true = 指令送出了
// 雲端主機的 lib 太舊 → 同還原那一條出更新框、不送(主機換回舊 lib 時,留著的 rerun.json 還會畫出這顆鈕)
function verRetry() {
  const B = rpBag(), side = verSideOf(B), S = VS[side], pd = S.data && S.open === null && VER ? VER.pending(S.data) : null;
  if (!pd || pd.status !== "failed" || running) return false;
  S.rerr = null;
  if (side === "cloud" && !VER.canRestoreInPlace(S.data)) { verPaintRerun(S, pd); verNeedUpdate(side, B, pd.n, $("ver-retry")); return false; }
  const raw = B.data && B.data.versions, rr = raw && raw.rerun;
  verDoRestore(side, B.name, pd.n, null, true, rr && typeof rr.at === "number" ? rr.at : null);
  return true;
}
/* ack → { kind: "ok" | "wait" | "fail", code?, result? }。逾時 / 結果不明不算失敗(指令可能已經執行):維持樂觀狀態、等回報。
   機器拒絕的字串是 "ValueError: <CODE>: …"(runtime _cmd_version_restore) */
function verAckKind(r) {
  if (r && r.ok) return { kind: "ok", result: r.result && typeof r.result === "object" ? r.result : {} };
  const e = r && typeof r.error === "string" ? r.error : "";
  if (!r || r.kind === "unknown" || e === "TIMEOUT" || e === "UNKNOWN_RESULT") return { kind: "wait" };
  const m = /^\s*\w+:\s*([A-Z_]+):/.exec(e);
  return { kind: "fail", code: m ? m[1] : null };
}
async function verDoRestore(side, name, n, prev, retry, failedAt) {
  const B = side === "cloud" ? RPC : RP, k = voKey(side, name), tok = {};
  VREQ.set(k, tok);
  VO.set(k, { n, prev, at: Math.floor(Date.now() / 1000), ackAt: 0, failedAt: failedAt == null ? null : failedAt });
  verPollStop(side);
  if (B.name === name && rpBag() === B && !$("rp").hidden) {
    B.drawn = {}; verPaint(B); rpShowTab(B.tab);
    const tr = $("ver-trig"); if (tr) tr.focus();   // 確認框把焦點還給的那顆鈕已隨時光機收起(設計稽核 S1)
  }
  let r = null;
  try { r = await TR_BAGS[side].api.tradeSend("version_restore", { name, n }); } catch (_) { r = null; }
  if (VREQ.get(k) !== tok) return;   // 等 ack 的時候又按了一次(另一版 / 再跑一次):那一次說了算
  const a = verAckKind(r);
  // 回報 2 分鐘內要跟上,否則回滾;輪詢上限也從這一刻重新起算
  const armed = () => { const o = VO.get(k); if (o && o.n === n) o.ackAt = Date.now(); const P = VP[side]; if (P && P.name === name) P.until = Date.now() + VER_POLL_MAX_MS; };
  if (a.kind === "ok") {
    if (!retry) trackFeature("version_restore");   // ack 成功才算(含 inplace:false:還原確實做了);再跑一次不計
    if (a.result.inplace === false) { verRollback(side, name, n, "ver.rsAsNew"); return; }
    armed(); return;
  }
  if (a.kind === "wait") { armed(); return; }
  if (a.code === "LIVE") {
    verRollback(side, name, n, null);
    if (B.name === name && rpBag() === B) verGuard(side, B, n, VS[side].data ? VS[side].data.current : prev, verAmount(side, B));
    return;
  }
  if (a.code === "UPDATE_REQUIRED" && side === "cloud") {
    verRollback(side, name, n, null);
    if (B.name === name && rpBag() === B) verNeedUpdate(side, B, n);
    return;
  }
  if (retry) VS[side].rerr = { name, n, at: failedAt };   // 再跑一次沒進時光機:原因寫在狀態列下方(稽核 L1)
  verRollback(side, name, n, a.code === "NO_VERSION" ? "ver.rsErrGone" : "ver.rsErr");
}
/* 回滾 = 拿掉疊層,畫面回到按下之前:時光機看 vN、橫幅兩顆鈕都在,需要時多一行原因。回滾不送埋點 */
function verRollback(side, name, n, reason) {
  VO.delete(voKey(side, name));
  const B = side === "cloud" ? RPC : RP, S = VS[side];
  if (B.name !== name || rpBag() !== B || $("rp").hidden || !B.data) return;
  B.drawn = {};
  verPaint(B);
  if (!S.data || n === S.data.current || !VER.entries(S.data).some((i) => i.n === n)) { rpShowTab(rpTab(B)); return; }
  S.open = n; S.blob = null; S.state = ""; S.seq++;
  S.err = reason ? { key: reason, v: n } : null;
  $("rp-code-pre").textContent = "";
  verPaintTrigger(S); verPaintBanner(S);
  verLoad(side, n);
  // 焦點交給重新出現的「還原成這一版」;原因行本身不搶焦點。人已經移到別處就不動
  const a = document.activeElement;
  if (!a || a === document.body || a === $("ver-trig")) { const b = $("ver-restore"); if (b) b.focus(); }
}
/* 重跑期間的輪詢(spec §13):這台電腦每 2 秒讀本機檔、雲端每 5 秒打 /cloud/strategy(detail 桶);內容沒變就不重畫(圖不閃)。
   疊層還在、或重跑中才跑;沒完成是穩定狀態不輪;最多 16 分鐘(機器端逾時 15 分鐘 + 餘裕)。看不到那一邊時照讀、不畫 */
function verPollNeed(side, B) {
  if (!B || !B.name) return false;
  if (VO.has(voKey(side, B.name))) return true;
  const pd = verPendingOf(side, B);
  return !!(pd && pd.status === "running");
}
function verPollStop(side) { const P = VP[side]; if (P) clearTimeout(P.timer); VP[side] = null; }
function verPollEnsure(side, B) {
  if (!verPollNeed(side, B)) { if (VP[side] && VP[side].name === B.name) verPollStop(side); return; }
  if (VP[side] && VP[side].name === B.name) return;
  verPollStop(side);
  const P = { name: B.name, until: Date.now() + VER_POLL_MAX_MS, timer: null };
  VP[side] = P;
  P.timer = setTimeout(() => verPollTick(side, P), VER_POLL_MS[side]);
}
/* ack 後 2 分鐘報告仍沒跟上:還原 → 回滾到時光機 + rsErr;再跑一次(current 本來就是 n,報告仍是按下前那一筆 failed)
   → 拿掉疊層、回到沒完成(設計稽核 S2:不然 ack 不明時會一直轉圈)。沒逾時就只照報告收疊層。回 true = 畫面已處理 */
function verOverlayExpire(side, name, B) {
  const k = voKey(side, name), o = VO.get(k), raw = B.data && B.data.versions;
  if (!o) return false;
  if (!o.ackAt || Date.now() - o.ackAt <= VER_ROLLBACK_MS) { verEffective(side, name, raw); return false; }
  const rr = raw && raw.rerun;
  if (o.failedAt != null && raw && raw.current === o.n && rr && rr.status === "failed" && rr.at === o.failedAt) {
    VO.delete(k);
    VS[side].rerr = { name, n: o.n, at: o.failedAt };   // 機器多半沒收到:同被拒那一句(稽核 L1)
    if (rpBag() === B && !$("rp").hidden && B.data) { rpPaintHead(B); rpShowTab(rpTab(B)); }
    return true;
  }
  if (!(raw && raw.current === o.n)) { verRollback(side, name, o.n, "ver.rsErr"); return true; }
  verEffective(side, name, raw);
  return false;
}
async function verPollTick(side, P) {
  if (VP[side] !== P) return;
  const B = side === "cloud" ? RPC : RP;
  if (B.name !== P.name) { verPollStop(side); return; }
  if (Date.now() > P.until) {   // 封頂:停輪詢,照手上最後一份畫一次;留一個「已封頂」的佔位,重畫不會再把輪詢開回來
    verPollStop(side);
    if (!verOverlayExpire(side, P.name, B)) VO.delete(voKey(side, P.name));   // 到封頂還掛著的疊層不再可信,以報告為準
    VP[side] = { name: P.name, until: 0, timer: null, capped: true };
    if (rpBag() === B && !$("rp").hidden && B.data) { rpPaintHead(B); rpShowTab(rpTab(B)); }
    return;
  }
  let d = null;
  try { d = side === "cloud" ? await TR_BAGS.cloud.api.loadStrategy(P.name) : await window.blave.loadStrategy(P.name); } catch (_) { d = null; }
  if (VP[side] !== P || B.name !== P.name) return;
  const shown = rpBag() === B && !$("rp").hidden;
  if (d && JSON.stringify(d) !== JSON.stringify(B.data)) {
    B.data = d; B.drawn = {};
    if (side === "cloud" && typeof RPC_CACHE !== "undefined") RPC_CACHE.set(P.name, d);
    if (shown) { rpPaintHead(B); rpShowTab(rpTab(B)); }
  }
  verOverlayExpire(side, P.name, B);
  if (VP[side] !== P) return;
  if (!verPollNeed(side, B)) { verPollStop(side); if (shown) { rpPaintHead(B); rpShowTab(rpTab(B)); } return; }
  P.timer = setTimeout(() => verPollTick(side, P), VER_POLL_MS[side]);
}
$("ver-back").addEventListener("click", verBack);
$("ver-restore").addEventListener("click", () => {
  if ($("ver-restore").getAttribute("aria-disabled") !== "true") { verRestoreAsk(); return; }
  const S = VS[verSideOf(rpBag())]; S.err = { key: "turn.busy", v: S.open }; verPaintErr(S);   // 設計稽核 S8
});

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
  if (!S.data || !VER || !VER.canCompare(S.data)) return;   // 一版時 items[1] 不存在
  // B = 目前版(current,還原後不一定是最大號);A = 正在看的舊版,不在時光機時取版號最大、不是目前的那一版(spec §8)
  const items = VER.entries(S.data), cur = S.data.current;
  vcSide = side;
  vcFill($("vc-a"), S, S.open !== null ? S.open : (items.find((i) => i.n !== cur) || items[1]).n);
  vcFill($("vc-b"), S, cur);
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
