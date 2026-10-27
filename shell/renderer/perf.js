/* 更新績效(canon strategy-versions §2:live 不定版;設計 spec stats-manual-refresh-2026-10-10 §10 精簡版 A;Wei 10-12:所有有 stats 的
   Type A／C 都有,不只上線中)。回測數據分頁 meta 列尾一顆 12px 文字鈕「更新績效」送直接指令 stats_refresh {names:[name]}
   (本機走 daemon、雲端走 api 指令佇列;不經 agent、不定版、不改程式碼)。Type B 不出(判法同程式碼分頁 xpIsTypeB:檔頭 `# Type: B`)。
   上線中(在下單設定裡,amounts 有這個 key、金額 0 也算:versions.js verPicked,同 runtime _deployed_names)機器端跑 live 刷新、報告前也會自動更新;
   非上線的機器端是重跑回測到最新資料(同碼不鑄版;碼改過還沒回測 → ack skip CODE_CHANGED,不跑),title 只寫上次回測時間、不說每天自動。
   ack 專用的 skip 碼(CODE_CHANGED / INDEX_BROKEN / NOT_RUNNABLE / CONFIG_UNREADABLE)與報告帶回的 SUPERSEDED / BUSY 各有自己一句(PF_WHY),其餘沿用版本重跑的四句。
   三態互斥:閒置(鈕;滿一天多「N 天前」,絕對時間那句在 title)/ 更新中(圓環 + 「更新中」,role=status;數字留著不變灰)/
   失敗(meta 列下一行「沒更新成功,數字是舊的」,原因進 title,鈕就是重試)。
   資料:B.data.perf = { at, refresh? }(主行程 stratPerf / 雲端 strategies report 的 perf):at = stats.json mtime(秒),不是 Generated At;
   refresh = { status: running|failed, at, err? },err 是版本重跑那四個分類碼、字串沿用 ver.rerunWhy.*。
   按下當下就畫更新中(疊層 PF,不等 ack);ack 說排進佇列才記埋點 perf_update(成交測試那顆記 perf_update_xt)。之後輪詢報告(本機 2 秒、雲端 5 秒):refresh 消失且 at 前進 = 完成,
   數字原地換(回測分頁重畫)、讀屏另唸一句;refresh failed = 失敗。ack 後 2 分鐘報告都沒跟上就拿掉疊層回閒置(不知道有沒有跑,不假稱失敗)。
   成交測試分頁(report-xt.js;spec lag-test-tab §3.5)的〔開始測試〕／〔重新測試〕也是這一個動作、這一份疊層(perfXtSlot),只多帶 exec_test:true
   (本機永遠帶;雲端看 /cloud/state 的 can_exec_test,舊 runtime 不帶也照算)。「這頁按的」另記在 PFX:測試中 vs 更新中、失敗行只出在這頁按的那次、
   BUSY 那一行;perfPaint 換態時 perfXtSync 就地換那一格,只有「這頁按的那次開始／結束跑」才整片重畫(結果收掉／回來)。
   用到 app.js 的 $ / t / RP / RPC / RPC_CACHE / rpBag / rpPaintHead / rpShowTab / rpTab / rpWfCloud / running / trackFeature / srSay、
   trade.js 的 TR_BAGS、versions.js 的 verPicked / verPendingOf / VS / RERUN_WHY、export.js 的 xpIsTypeB、report-sharelist.js 的 shlFmtTime——都在呼叫時才取。 */
const PF = { local: new Map(), cloud: new Map() };     // side → name → { at0, ref0, ackAt, failed }:按下之後、報告跟上之前的疊層
const PFL = { local: null, cloud: null };              // 上一次畫的 { name, kind, at }:更新中 → 閒置且時間前進 = 完成,唸一句
const PFP = { local: null, cloud: null };              // 每邊一支輪詢
const PFX = { local: new Map(), cloud: new Map() };    // side → name → { busy, done }:成交測試那顆按的(busy = ack BUSY、那次沒排進去;done = 那次已失敗)
const PF_POLL_MS = { local: 2000, cloud: 5000 }, PF_GRACE_MS = 120000;
// 機器端一次只跑一支:鈕排的佇列會等前一支(live 刷新每支上限 600 秒、非上線的回測 15 分、報告前那一批整批最多 600 秒),再加餘裕
const PF_POLL_MAX_MS = (900 + 900 + 120) * 1000;
const PF_ERRS = ["REFUSED", "DATA", "TIMEOUT", "EXIT", "SUPERSEDED", "BUSY"];   // = runtime _RERUN_ERRS(報告帶回的 perf.refresh.err)
// 失敗行 title 的專屬句:報告帶回的兩個 + ack 的 skip 碼(機器端沒跑);不在這裡的走 ver.rerunWhy.*
// DATA 失敗而且是沒有資料權限(runtime 寫的 why = 外殼給子行程的 BLAVE_DATA_ACCESS_WHY):看得到的那一行直接講原因(灰記號、不掛 title);
// 只在現在的原因還是同一個時才講(登入後還寫「沒登入」會叫人去找不存在的問題),否則退回通用句。雲端報告不帶 why
const PF_NO_DATA = { signed_out: "perf.noData.signedOut", no_card: "perf.noData.noCard", no_balance: "perf.noData.noBalance", no_plan: "perf.noData.noPlan", plan_failed: "perf.noData.planFailed", unknown: "perf.noData.unknown" };
const PF_WHY = { SUPERSEDED: "perf.superseded", BUSY: "perf.lockBusy", CODE_CHANGED: "perf.codeChanged", INDEX_BROKEN: "perf.indexBroken", NOT_RUNNABLE: "perf.notRunnable", CONFIG_UNREADABLE: "perf.configUnreadable" };
/* 這台現在沒資料的原因,同策略庫那份(library.js libCtx / libGrouping,源頭是 main.js dataAccessWhy);有資料或查不到 = null */
function pfNowWhy() {
  if (typeof libCtx !== "function" || typeof libGrouping !== "function") return null;
  const c = libCtx();
  if (c.signedIn === false) return "signed_out";
  if (typeof LIB === "undefined" || !LIB.data || LIB.stale) return null;
  const g = libGrouping(Object.assign(c, { env: "local" }));
  return g === "signedOut" ? "signed_out" : g;
}
const pfSide = (B) => (B === RPC ? "cloud" : "local");
function pfEl(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
// 報告帶的 perf,逐欄驗型別(雲端那份是機器上的 reporter 寫的):壞形狀 = null(不出這一組)
function perfOf(B) {
  const p = B && B.data && !B.data.pending ? B.data.perf : null;
  if (!p || typeof p !== "object" || Array.isArray(p) || typeof p.at !== "number" || !isFinite(p.at) || p.at <= 0) return null;
  const out = { at: p.at }, r = p.refresh;
  if (r && typeof r === "object" && !Array.isArray(r) && (r.status === "running" || r.status === "failed") && typeof r.at === "number") {
    out.refresh = { status: r.status, at: r.at };
    if (r.status === "failed") out.refresh.err = PF_ERRS.indexOf(r.err) >= 0 ? r.err : "EXIT";
    if (out.refresh.err === "DATA" && Object.prototype.hasOwnProperty.call(PF_NO_DATA, r.why)) out.refresh.why = r.why;
  }
  return out;
}
// 這組要不要出:Type A／C、有 perf、不在時光機也不在還原的重跑中(那時回測分頁畫的是 vN 存的 blob,沒有 stats.json 可更新)
function perfShown(side, B) {
  if (!B || !B.name || !perfOf(B)) return false;
  if (typeof xpIsTypeB === "function" && xpIsTypeB(B.data)) return false;
  if (typeof VS !== "undefined" && VS[side] && VS[side].name === B.name && VS[side].open !== null) return false;
  if (typeof verPendingOf === "function" && verPendingOf(side, B)) return false;
  return true;
}
// 上線中 = 在下單設定裡(verPicked:amounts 有這個 key,金額 0 也算,同 runtime _deployed_names):機器端走 live 刷新、每天報告前自動更新;其餘只在按下時重跑回測
function perfLive(side, B) { return typeof verPicked === "function" && verPicked(side, B) === true; }
/* 三態:{ kind: idle|running|failed, at, err?, why? }。疊層只撐到報告跟上(出現按下之後才寫的 refresh、或 at 前進)或 ack 後 2 分鐘;之後以報告為準。
   按下前就在的那筆(上次失敗)不算跟上:拿它當跟上,疊層一建就被刪、不輪詢,跑完畫面也不換 */
const pfRefKey = (r) => (r ? r.status + "@" + r.at : null);
function perfState(side, B, now) {
  const p = perfOf(B); if (!p) return null;
  const o = PF[side].get(B.name);
  if (o) {
    if ((p.refresh && pfRefKey(p.refresh) !== o.ref0) || p.at > o.at0 || (o.ackAt && now - o.ackAt > PF_GRACE_MS)) PF[side].delete(B.name);
    else return o.failed ? { kind: "failed", at: p.at, err: o.failed } : { kind: "running", at: p.at };
  }
  if (p.refresh && p.refresh.status === "running") return { kind: "running", at: p.at };
  if (p.refresh && p.refresh.status === "failed") return { kind: "failed", at: p.at, err: p.refresh.err, why: p.refresh.why };
  return { kind: "idle", at: p.at };
}
/* app.js rpShowTab 畫完回測分頁就叫:把 .upd 掛進 .bt-meta 列尾、失敗那一行插在 meta 下面。每次重建(狀態換了才會被叫到) */
function perfPaint(B) {
  const side = pfSide(B), host = $("rp-bt"), meta = host ? host.querySelector(".bt-meta") : null;
  if (host) host.querySelectorAll(".upd, .upd-fail").forEach((x) => x.remove());
  perfXtSync(B);
  if (!meta || !perfShown(side, B)) { PFL[side] = null; perfPollEnsure(side, B); return; }
  const now = Date.now(), st = perfState(side, B, now), last = PFL[side];
  // 完成:上一次畫的是更新中、這次不是而且時間前進 → 數字已原地換(renderBacktest 重畫過),視覺不出字、讀屏唸一句
  if (last && last.name === B.name && last.kind === "running" && st.kind !== "running" && st.at > last.at && typeof srSay === "function") srSay(t("perf.doneSr"));
  PFL[side] = { name: B.name, kind: st.kind, at: st.at };
  const upd = pfEl("span", "upd");
  if (st.kind === "running") {
    upd.setAttribute("role", "status");
    const busy = pfEl("span", "busy"), sp = pfEl("span", "spin16"); sp.setAttribute("aria-hidden", "true");
    busy.append(sp, pfEl("span", "", t("perf.busy"))); upd.appendChild(busy);
  } else {
    const tip = t(perfLive(side, B) ? "perf.tip" : "perf.tipBt", { t: shlFmtTime(st.at, now) }), days = Math.floor((now / 1000 - st.at) / 86400);
    const btn = pfEl("button", "btn-quiet", t("perf.btn")); btn.type = "button"; btn.id = "perf-btn";
    // 滿一天才出「N 天前」,title 跟著它;未滿一天只有鈕,title 在鈕上(回合進行中 perfBusy 會暫時換成原因,所以另存一份)
    if (days >= 1) { const ts = pfEl("span", "ts", days === 1 ? t("perf.agoOne") : t("perf.ago", { n: String(days) })); ts.title = tip; upd.appendChild(ts); }
    else { btn.title = tip; btn.dataset.tip = tip; }
    btn.addEventListener("click", () => perfClick(B));
    upd.appendChild(btn);
  }
  meta.appendChild(upd);
  if (st.kind === "failed") meta.parentNode.insertBefore(perfFailLine(side, st, "perf.fail"), meta.nextSibling);
  perfBusy();
  perfPollEnsure(side, B);
}
/* 失敗那一行:回測數據分頁 meta 下、成交測試霧卡的鈕下共用。failKey = 看得到的那句(霧卡上沒有數字,不講「數字是舊的」) */
function perfFailLine(side, st, failKey) {
  const calm = side === "local" && PF_NO_DATA[st.why] && pfNowWhy() === st.why ? PF_NO_DATA[st.why] : null;
  const line = pfEl("p", calm ? "upd-fail is-calm" : "upd-fail"); line.setAttribute("role", "status");
  if (!calm) line.title = t(PF_WHY[st.err] || "ver.rerunWhy." + (RERUN_WHY[st.err] || "exit"));   // 四個分類碼沿用版本重跑的字串,不另造一組
  const m = pfEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true");
  line.append(m, pfEl("span", "", t(calm || failKey)));
  return line;
}
/* 成交測試那一格要的狀態(report-xt.js 經 opts.ui 拿;perfShown 假 = null):{ st, perf: idle|running|failed, mine: run|busy|fail|null }(= web xtReq)。
   run = 這頁按的那次在跑(測試中、整塊收掉);fail = 那次失敗了(失敗行);busy = 那次 ack BUSY(別人的那次在跑,鈕下多一行)。
   順手收記號:跑完成功、BUSY 那次跑完、或失敗之後又有一次在跑(報告前的自動更新、回測數據那顆)——那都不是這頁按的了 */
function perfXtInfo(B) {
  const side = pfSide(B);
  if (!perfShown(side, B)) return null;
  const st = perfState(side, B, Date.now()), m = PFX[side].get(B.name);
  if (m) {
    if (st.kind === "idle" || (m.busy && st.kind !== "running") || (m.done && st.kind === "running")) PFX[side].delete(B.name);
    else if (st.kind === "failed") m.done = true;
  }
  const k = PFX[side].get(B.name);
  return { st, perf: st.kind, mine: !k ? null : k.busy ? "busy" : k.done ? "fail" : "run" };
}
/* 〔開始測試〕(kind empty,空狀態那顆)／〔重新測試〕(fresh 描邊、stale 填色,頂列右側)那一格:同〔更新績效〕一個動作、同一份疊層與輪詢,
   不開對話回合、沒有確認框、不花額度。跑的期間停用 + 圓環:這頁按的「測試中」、別處按的「更新中」;BUSY 那次鈕下多一行「跑完再按一次」;
   這頁按的那次失敗 = 鈕照出(就是重試)、下一行「沒測成功」、原因在 title */
function perfXtSlot(B, kind) {
  const side = pfSide(B), info = perfXtInfo(B);
  if (!info) return null;
  const st = info.st, box = pfEl("div", "xt-upd");
  box.dataset.xtUpd = "1"; box.dataset.xtKind = kind || "empty";
  box.dataset.xtSig = [box.dataset.xtKind, st.kind, info.mine, st.err || "", st.why || ""].join(":");
  const btn = pfEl("button", kind === "fresh" ? "btn-out" : "btn-fill"); btn.type = "button"; btn.dataset.perfBtn = "1"; btn.dataset.xtBtn = "1";
  const tip = t("xt.btnTip"); btn.title = tip; btn.dataset.tip = tip;   // 回合中 perfBusy 會暫時換成原因,所以另存一份
  if (st.kind === "running") {
    btn.disabled = true; box.setAttribute("role", "status");
    const sp = pfEl("span", "spin16"); sp.setAttribute("aria-hidden", "true");
    btn.append(sp, pfEl("span", "", t(info.mine === "run" ? "xt.btnBusy" : "perf.busy")));
  } else btn.textContent = t(box.dataset.xtKind === "empty" ? "xt.btnRun" : "xt.btnRerun");
  btn.addEventListener("click", () => perfClick(B, btn));
  box.appendChild(btn);
  if (st.kind === "running" && info.mine === "busy") box.appendChild(pfEl("p", "xt-busy-line", t("xt.busyRefresh")));
  if (st.kind === "failed" && info.mine === "fail") box.appendChild(perfFailLine(side, st, "xt.updFail"));
  return box;
}
/* 疊層換態時:這頁按的那次開始／結束跑(結果要收掉／回來)→ 整片重畫;否則就地換那一格(圖不閃)。焦點在舊鈕上就交給新鈕,
   新鈕停用(跑的期間)就交給成交測試那顆分頁鈕,不掉到 <body> */
function perfXtSync(B) {
  if (rpBag() !== B || !B.drawn.xt) return;
  const panel = $("rp-xt"), root = panel.querySelector(".xt"), old = panel.querySelector("[data-xt-upd]");
  const had = panel.contains(document.activeElement), info = perfXtInfo(B);
  const refocus = (b) => {
    if (!had) return;
    if (b && !b.disabled) { b.focus(); return; }
    const tab = $("rp-tabs-scroll") && $("rp-tabs-scroll").querySelector('.rp-tab[data-tab="xt"]');
    if (tab) tab.focus();
  };
  if (root && root.dataset.xtMineRun && String(!!info && info.perf === "running" && info.mine === "run") !== root.dataset.xtMineRun) {
    B.drawn.xt = false;
    if (B.tab === "xt" && !$("rp").hidden) { rpShowTab("xt"); refocus(panel.querySelector("[data-perf-btn]")); }
    return;
  }
  if (!old) return;
  const next = perfXtSlot(B, old.dataset.xtKind);
  if (!next) { old.remove(); return; }
  if (next.dataset.xtSig === old.dataset.xtSig) return;
  old.replaceWith(next);
  perfBusy();
  refocus(next.querySelector("[data-perf-btn]"));
}
// 回合進行中:鈕 aria-disabled(同版本還原那兩顆;spec §8),點了在 meta 列下講原因＋查看(busy.js)。app.js 在上鎖 / 解鎖的同一處叫它
function perfBusy() {
  const xt = $("rp-xt");   // 成交測試那顆(perfXtSlot)同一套,原因句用它自己那句
  [$("perf-btn")].concat(xt ? [...xt.querySelectorAll("[data-perf-btn]")] : []).forEach((b) => {
    if (!b) return;
    if (typeof running !== "undefined" && running === true) { b.setAttribute("aria-disabled", "true"); b.title = t(b.dataset.xtBtn ? "xt.busyTurn" : "busy.perf"); return; }
    b.removeAttribute("aria-disabled");
    if (b.dataset.tip) b.title = b.dataset.tip; else b.removeAttribute("title");
  });
}
/* 按下:當下畫更新中、送 stats_refresh {names:[name]}(成交測試那顆另帶 exec_test:true:本機永遠帶、雲端 can_exec_test 為 true 才帶)。
   ack 排進佇列(started)才記埋點;BUSY(已經在跑)與結果不明都等報告;
   PF_WHY 有的 skip 碼(CODE_CHANGED / INDEX_BROKEN / NOT_RUNNABLE / CONFIG_UNREADABLE)= 失敗行寫專屬原因;其餘(拒收、NO_STATS、daemon 不在)= 沒更新成功,鈕就是重試 */
async function perfClick(B, opener) {
  const b = opener || $("perf-btn");   // opener = 成交測試那顆(原因句講在它下面)
  if (b && b.getAttribute("aria-disabled") === "true") { busyTell(busySlot("perf-why", opener || $("rp-bt").querySelector(".bt-meta") || b), opener ? "xtPerf" : "perf"); return; }   // 回合進行中:觸控看不到 title
  const side = pfSide(B), name = B.name, p = perfOf(B);
  if (!p || !name) return;
  const o = { at0: p.at, ref0: pfRefKey(p.refresh), ackAt: 0, failed: null };
  PF[side].set(name, o);
  if (opener) PFX[side].set(name, { busy: false, done: false }); else PFX[side].delete(name);
  perfPollStop(side);   // 上一輪封頂留下的佔位讓開,這一輪重新輪詢
  if (rpBag() === B && !$("rp").hidden) perfPaint(B);
  const args = { names: [name] };
  if (opener && (side === "local" || (typeof rpWfCloud === "function" && rpWfCloud().can_exec_test === true))) args.exec_test = true;
  let r = null;
  try { r = await TR_BAGS[side].api.tradeSend("stats_refresh", args); } catch (_) { r = null; }
  if (PF[side].get(name) !== o) return;   // 又按了一次、或報告已跟上:那一次說了算
  const res = r && r.ok && r.result && typeof r.result === "object" ? r.result : null;
  if (res && Array.isArray(res.started) && res.started.indexOf(name) >= 0) { trackFeature(opener ? "perf_update_xt" : "perf_update"); o.ackAt = Date.now(); }
  else if (res && res.skipped && res.skipped[name] === "BUSY") { o.ackAt = Date.now(); const m = opener && PFX[side].get(name); if (m) m.busy = true; }
  else if (res && res.skipped && PF_WHY[res.skipped[name]]) o.failed = res.skipped[name];
  else if (!r || r.kind === "unknown" || r.error === "TIMEOUT" || r.error === "UNKNOWN_RESULT") o.ackAt = Date.now();
  else o.failed = "EXIT";
  if (rpBag() === B && !$("rp").hidden && B.name === name) perfPaint(B);
}
/* 更新中的輪詢:重讀這一支(本機讀檔、雲端打 /cloud/strategy),內容變了才重畫(圖不閃);沒在更新就不輪。到封頂就拿掉疊層、以報告為準 */
function perfPollNeed(side, B) {
  if (!B || !B.name || !perfShown(side, B)) return false;
  const st = perfState(side, B, Date.now());
  return !!(st && st.kind === "running");
}
function perfPollStop(side) { const P = PFP[side]; if (P) clearTimeout(P.timer); PFP[side] = null; }
function perfPollEnsure(side, B) {
  if (!perfPollNeed(side, B)) { if (PFP[side] && B && PFP[side].name === B.name) perfPollStop(side); return; }
  if (PFP[side] && PFP[side].name === B.name) return;
  perfPollStop(side);
  const P = { name: B.name, until: Date.now() + PF_POLL_MAX_MS, timer: null };
  PFP[side] = P;
  P.timer = setTimeout(() => perfPollTick(side, P), PF_POLL_MS[side]);
}
async function perfPollTick(side, P) {
  if (PFP[side] !== P) return;
  const B = side === "cloud" ? RPC : RP;
  if (B.name !== P.name) { perfPollStop(side); return; }
  const shown = rpBag() === B && !$("rp").hidden;
  // 封頂:停、拿掉疊層、以報告為準;留一個「已封頂」的佔位,重畫不會再把輪詢開回來(再按一次鈕才會,perfClick 先清掉它)
  if (Date.now() > P.until) { perfPollStop(side); PF[side].delete(P.name); PFP[side] = { name: P.name, until: 0, timer: null, capped: true }; if (shown) perfPaint(B); return; }
  let d = null;
  try { d = side === "cloud" ? await TR_BAGS.cloud.api.loadStrategy(P.name) : await window.blave.loadStrategy(P.name); } catch (_) { d = null; }
  if (PFP[side] !== P || B.name !== P.name) return;
  if (d && JSON.stringify(d) !== JSON.stringify(B.data)) {
    B.data = d; B.drawn = {};
    if (side === "cloud" && typeof RPC_CACHE !== "undefined") RPC_CACHE.set(P.name, d);
    if (shown) { rpPaintHead(B); rpShowTab(rpTab(B)); }   // 回測分頁重畫 → renderBacktest → perfPaint
  } else if (shown) perfPaint(B);   // 內容沒變也要重算疊層的逾時
  if (PFP[side] !== P) return;
  if (!perfPollNeed(side, B)) { perfPollStop(side); return; }
  P.timer = setTimeout(() => perfPollTick(side, P), PF_POLL_MS[side]);
}
