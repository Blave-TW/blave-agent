/* 報告(設計:blave-canon output/designer/spec-desktop-0.1.6-2026-09-25.md §1;雲端工作頁 #rpl_panel / #rp_panel 縮成中欄的尺寸)。
   側欄「報告」→ 中欄清單(信封:標題 / 建立時間 / 類型)→ 閱讀(report-blocks.js 把整份 JSON 畫成 article.rb-report)→ 一層返回;
   「新增報告」是一個 modal(描述欄 + 5 顆範例句 chip),組成一句固定形狀的話送給 agent(rpt.new.msgLead / msgOnce 逐字同 web
   的 workspace_rp_msg_lead / _once;本版只留「一次」、不做排程)。
   - 兩個視角各一袋(RPT.bags:開著 / 在讀哪一份 / 捲動 / 剛讀過那列);本機袋 = <WS>/reports 的檔案系統(主行程讀,renderer 不碰 fs),
     雲端袋 = 平台索引 + S3 本體(停機也讀得到;主行程打 api、圖換成 data URI 才交過來)。這裡仍一律 textContent。
   - 中欄誰該出現由 trade.js 的 envShowMain 在最後一步問 rptShowMain;與策略庫互斥(rptOpen 先 libLeave,libOpen 反之)。
   - 送出後:本機 turn-end 重掃、多出新報告就自動打開;雲端 turn-end 後每 30 秒問一次清單、最多 10 分鐘,新 id 出現就停。
   用到 app.js 的 $ / t / LANG / running / csTitle / csStartNew / submitMessage / addMsg / trapTab / stratSelect / rpCloudSelect / paneSt / paneToggle /
   rpWaitHold / mdBlocks / mdPaint、trade.js 的 trLeave / envShowMain / envCanSwitch、library.js 的 libEnv / libBag / libWhere / libCloud / libLeave / libTrack /
   libEl——都在呼叫時才取(這支比它們先載)。 */

/* ── 純邏輯(tests/check_shell_reports.js 從原文切出來跑;這一段不准碰 DOM / i18n)── */
const RPT_PAGE = 12;   // 同 web RP_PAGE:680 欄一個畫面放得下的列數
const RPT_CLOUD_POLL_MS = 30 * 1000, RPT_CLOUD_WAIT_MS = 10 * 60 * 1000;   // 雲端:uploader 是 2 分鐘的計時器 + 平台入庫
const RPT_TYPE_KEYS = { performance: "rpt.type.performance", morning: "rpt.type.morning", research: "rpt.type.research" };
const RPT_FN_RE = /\[\^([A-Za-z0-9_-]{1,32})\]/g;   // 契約 §4 的尾註引用(同 report-blocks.js 的 FN_REF)
function rptPad2(n) { return n < 10 ? "0" + n : String(n); }
// 建立時間 MM/DD HH:MM(本地時區;格式同 web fmtStamp / fmtMD + fmtHM);不是有限數 → ""
function rptFmtStamp(sec) {
  if (typeof sec !== "number" || !isFinite(sec)) return "";
  const d = new Date(sec * 1000);
  if (isNaN(d.getTime())) return "";   // 超過 Date 範圍的整數:getMonth() 是 NaN
  return rptPad2(d.getMonth() + 1) + "/" + rptPad2(d.getDate()) + " " + rptPad2(d.getHours()) + ":" + rptPad2(d.getMinutes());
}
// 類型字的 key;缺或認不得 → null(列上就不出)
function rptTypeKey(type) { return typeof type === "string" && Object.prototype.hasOwnProperty.call(RPT_TYPE_KEYS, type) ? RPT_TYPE_KEYS[type] : null; }
// 本機 created_at 新到舊(同時間照原順序);雲端照 api 給的順序(stored_at 新到舊)不動
function rptSort(list, env) {
  const a = (Array.isArray(list) ? list : []).filter((r) => r && typeof r === "object" && typeof r.id === "string");
  if (env === "cloud") return a.slice();
  const at = (r) => (typeof r.created_at === "number" && isFinite(r.created_at) ? r.created_at : 0);
  return a.map((r, i) => [r, i]).sort((x, y) => (at(y[0]) - at(x[0])) || (x[1] - y[1])).map((x) => x[0]);
}
/* 工具列「新增報告」的態(規格 §1.3 狀態表):pending(agent 寫作中,那一輪就是它的進度)> busy(回合中)> stopped / stale(雲端)> free。
   c = { running, env, cloud: "live"|"stale"|"stopped"|null, pending } */
function rptAskState(c) {
  if (c.pending) return "pending";
  if (c.running) return "busy";
  if (c.env === "cloud" && c.cloud !== "live") return c.cloud === "stopped" ? "stopped" : "stale";
  return "free";
}
// 送給 agent 的那句(逐字同 web rpCompose 的一次性分支):zh 全形「」：。,en 半形;desc 原樣引用、只 trim;空 → ""。s = { lead, once }
function rptCompose(desc, lang, s) {
  const d = String(desc == null ? "" : desc).trim();
  if (!d) return "";
  return lang === "zh" ? s.lead + "：「" + d + "」。" + s.once : s.lead + ': "' + d + '". ' + s.once;
}
/* 一份報告的「版本鍵」:id + 本機 mtime / 雲端 stored_at。lib/report.py 明寫重用 id = 覆蓋——同 id 換過內容也算「新報告」,本體快取也照它分 */
function rptKey(r) { return r.id + "@" + (typeof r.mtime === "number" ? r.mtime : typeof r.stored_at === "number" ? r.stored_at : ""); }
// 回合結束後新出現的那幾份(送出前記的那一袋沒有這個版本鍵的);順序照清單
function rptNewEntries(before, list) { return (Array.isArray(list) ? list : []).filter((r) => r && typeof r.id === "string" && !before.has(rptKey(r))); }
/* ── 純邏輯到此 ── */

const RPT = { bags: { local: rptNewBag(), cloud: rptNewBag() }, data: { local: null, cloud: null }, failed: { local: false, cloud: false }, skel: { local: false, cloud: false },
  seq: { local: 0, cloud: 0 }, readSeq: 0, docs: new Map(), pending: { local: null, cloud: null }, noNew: null, poll: null, sending: false, fail: false, opener: null, paintedEnv: null };   // pending 每袋一份(雲端輪詢中送本機的不互蓋);fail = 上一次送出失敗:腳那一句留到下次送出 / 關框
const RPT_DOCS_MAX = 8;   // 讀過的本體留幾份(回清單再進同一份不重抓;換語言整組清掉——渲染出來的字是 i18n 過的)
function rptNewBag() { return { open: false, reading: null, scroll: 0, row: null, shown: RPT_PAGE }; }
const rptBag = (env) => RPT.bags[(env || libEnv()) === "cloud" ? "cloud" : "local"];
const rptVisible = (env) => !$("rpt").hidden && libEnv() === env;
function rptCtx(env) {
  return { running: typeof running !== "undefined" && running === true, env, cloud: env === "cloud" ? libCloud() : null, pending: !!RPT.pending[env] };
}
// 渲染器要的字串包(web REPORT_I18N 的 12 個 key):{where} 先代好再交進去,渲染器不改
function rptI18n(env) {
  const where = t(env === "cloud" ? "lib.where.cloud" : "lib.where.local");
  return { originScheduled: t("rb.originScheduled"), originChat: t("rb.originChat"), machine: t("rb.machine"), footScheduled: t("rb.footScheduled", { where }), footChat: t("rb.footChat", { where }),
    metaPeriod: t("rb.metaPeriod"), metaAum: t("rb.metaAum"), metaBenchmark: t("rb.metaBenchmark"), calloutRisk: t("rb.calloutRisk"), footnoteRef: t("rb.footnoteRef"), imageError: t("rb.imageError"), segOther: t("rb.segOther") };
}

/* ── 開 / 關 ──────────────────────────────────────────── */
async function rptOpen() {
  const B = rptBag();
  if (typeof trLeave === "function") trLeave();
  if (typeof libLeave === "function") libLeave();
  if (libEnv() === "local") { if (typeof stratSelect === "function") await stratSelect(null); }
  else if (typeof rpCloudSelect === "function") await rpCloudSelect(null);
  B.open = true;
  if (B !== rptBag()) return false;   // 等的時候切走了:只記下這一邊是開著的
  envShowMain();
  rptLoad(libEnv(), false);
  rptFocusHome();
  if (libEnv() === "local") $("rpt-nav-new").hidden = true;   // 進來就看到了:記號收掉
  libTrack("reports_list");
  return true;
}
// 焦點:進清單落在「新增報告」;那顆鈕停用時退到 #rpt-h;閱讀層在返回鈕
function rptFocusHome() {
  const B = rptBag();
  const h = B.reading ? $("rpt-back") : !$("rpt-ask").disabled ? $("rpt-ask") : $("rpt-h");
  if (h && h.offsetParent) h.focus();
}
// 選了策略 / 開自動下單 / 開策略庫:那一邊的報告收起來(中欄一次只有一個視圖)。trOpen 直接翻 DOM、不經 envShowMain,所以這裡自己收 #rpt
function rptLeave(env) {
  const B = rptBag(env);
  if (!B.open) return;
  B.open = false; if (RPT.noNew === (env || libEnv())) RPT.noNew = null;
  if (B === rptBag()) { $("rpt").hidden = true; $("rpt-nav").removeAttribute("aria-current"); }
}
/* envShowMain(trade.js)的最後一步(libShowMain 之後):報告開著就蓋掉其餘視圖。gate = 雲端沒主機可看(開通頁),那時側欄入口也藏著 */
function rptShowMain(gate) {
  const on = !gate && rptBag().open, was = !$("rpt").hidden;
  if (on) { $("rp").hidden = true; $("tr").hidden = true; $("main-empty").hidden = true; $("lib").hidden = true; $("tr-nav").removeAttribute("aria-current"); $("lib-nav").removeAttribute("aria-current"); }
  $("rpt").hidden = !on;
  if (on) $("rpt-nav").setAttribute("aria-current", "page"); else $("rpt-nav").removeAttribute("aria-current");
  if (on && (!was || RPT.paintedEnv !== libEnv())) { rptPaint(); if (was) rptLoad(libEnv(), false); }   // 剛打開 / 切視角(兩邊都開著也要換成這一邊那袋)
}

/* ── 資料 ─────────────────────────────────────────────── */
// 回 true = 這一趟的結果套上去了;false = 途中被更新的一趟蓋過(呼叫端別拿 RPT.data 當這一趟的答案)
async function rptLoad(env, force) {
  const seq = ++RPT.seq[env];
  RPT.failed[env] = false; RPT.skel[env] = false;
  let shownAt = 0;
  // canon Loader:200ms 內回來不畫 skeleton;畫了至少留 300ms(同 libLoad)
  const timer = setTimeout(() => { if (RPT.seq[env] !== seq || RPT.data[env]) return; RPT.skel[env] = true; shownAt = Date.now(); if (rptVisible(env) && !rptBag(env).reading) rptPaintList(); }, 200);
  let r = null;
  try { r = env === "cloud" ? await window.blave.cloudReports(force === true) : await window.blave.reportsList(); } catch (_) { r = null; }
  if (RPT.seq[env] !== seq) { console.warn("[reports] load superseded", env, seq); return false; }
  clearTimeout(timer);
  if (shownAt) {
    const hold = typeof rpWaitHold === "function" ? rpWaitHold(shownAt, Date.now()) : 0;
    if (hold) { await new Promise((res) => setTimeout(res, hold)); if (RPT.seq[env] !== seq) { console.warn("[reports] load superseded", env, seq); return false; } }
  }
  RPT.skel[env] = false;
  const prev = JSON.stringify(RPT.data[env]);
  if (r && Array.isArray(r.reports) && (env === "local" || r.code === "OK")) RPT.data[env] = rptSort(r.reports, env);
  else RPT.failed[env] = true;   // 手上有舊清單就照畫舊的;沒有才畫「讀不到」
  if (!rptVisible(env) || rptBag(env).reading) return true;
  if (prev !== JSON.stringify(RPT.data[env]) || RPT.failed[env]) rptPaintList(); else rptPaintTools();   // 沒變就不重畫列(捲動、焦點都留著)
  return true;
}
// 登入 / 登出 / 換帳號(app.js 在 hasToken 翻轉的地方叫):雲端那一袋是這個帳號的,作廢;開著就立刻重問
function rptInvalidate() {
  RPT.data.cloud = null; RPT.failed.cloud = false;
  for (const k of [...RPT.docs.keys()]) if (k.startsWith("cloud|")) RPT.docs.delete(k);
  rptCloudPollStop();
  RPT.pending.cloud = null;
  if (RPT.noNew === "cloud") RPT.noNew = null;
  if (rptVisible("cloud")) { if (rptBag("cloud").reading) rptPaint(); else rptLoad("cloud", true); }
}
// 回合開始 / 結束(running 變了):工具列的鈕與那一行就地重畫;新增報告框開著也跟著
function rptSync() {
  if (!$("rpt").hidden && !rptBag().reading) rptPaintTools();
  if (!$("rpn-scrim").hidden) rptNewPaint();
}
// 換語言(app.js applyStatic):清單 / 閱讀頁都是 t() 現組的字;讀過的本體整組丟掉重畫
function rptRepaint() {
  RPT.docs.clear();
  if (!$("rpt").hidden) rptPaint();
  if (!$("rpn-scrim").hidden) rptNewPaint();
}
/* 送出「新增報告」那一輪結束(app.js onTurnEnd,libTurnEnd 之後):本機重掃,多出新報告就自動打開(§5-5),沒有就出灰字;
   雲端:清單跟著主機的回報走(uploader 2 分鐘 + 平台入庫),每 30 秒問一次、最多 10 分鐘 */
function rptTurnEnd() {
  if (RPT.pending.cloud && !RPT.poll) rptCloudPollStart(RPT.pending.cloud);   // 已在輪詢就不重開 10 分鐘窗(用戶接著聊天,每一輪都會到這裡)
  const p = RPT.pending.local;
  if (!p) return;
  RPT.pending.local = null;
  rptPaintTools();
  rptLoad("local", true).then((applied) => {
    if (!applied) return;   // 被更新的一趟蓋過:那一趟自己會畫,這裡不拿舊資料下結論
    const fresh = rptNewEntries(p.before, RPT.data.local);
    if (!fresh.length) { RPT.noNew = "local"; rptSync(); return; }
    RPT.noNew = null;
    // 只在人還停在報告區或歡迎頁(聊天)時自動打開;等待期間已切到自動下單 / 策略 / 策略庫就不拉回,側欄入口只做記號
    if (libEnv() !== "local" || !(rptBag("local").open || !$("main-empty").hidden)) { $("rpt-nav-new").hidden = false; rptSync(); return; }
    rptOpen().then((opened) => { if (opened && libEnv() === "local" && rptBag("local").open) rptShowRead(fresh[0].id); });   // 等的期間切到雲端就不開(不把本機 id 塞進雲端袋)
  });
}
function rptCloudPollStart(p) {
  rptCloudPollStop();
  RPT.poll = { before: p.before, until: Date.now() + RPT_CLOUD_WAIT_MS, timer: null };
  rptCloudPollTick();
}
function rptCloudPollStop() { if (RPT.poll && RPT.poll.timer) clearTimeout(RPT.poll.timer); RPT.poll = null; }
async function rptCloudPollTick() {
  const w = RPT.poll;
  if (!w) return;
  await rptLoad("cloud", true);
  if (RPT.poll !== w) return;
  const fresh = rptNewEntries(w.before, RPT.data.cloud);
  if (fresh.length || Date.now() > w.until) {
    RPT.poll = null; RPT.pending.cloud = null;
    if (!fresh.length) RPT.noNew = "cloud";
    rptSync();
    return;
  }
  w.timer = setTimeout(rptCloudPollTick, RPT_CLOUD_POLL_MS);
}

/* ── 畫 ──────────────────────────────────────────────── */
function rptPaint() {
  const env = libEnv(), B = rptBag(env); RPT.paintedEnv = env;
  const reading = !!B.reading;
  $("rpt-head-list").hidden = reading; $("rpt-back").hidden = !reading; $("rpt-read").hidden = !reading;
  if (reading) { $("rpt-rows").textContent = ""; $("rpt-state").hidden = true; $("rpt-state").textContent = ""; rptFetch(env, B.reading); }
  else { $("rpt-read").textContent = ""; rptPaintList(); $("rpt-body").scrollTop = B.scroll || 0; }
}
function rptPaintTools() {
  const env = libEnv(), data = RPT.data[env], n = data ? data.length : 0, count = $("rpt-count");
  count.textContent = t(n === 1 ? "rpt.count.one" : "rpt.count.other", { n: String(n) });
  count.classList.toggle("is-zero", n === 0);   // 0 份藏字留位
  const st = rptAskState(rptCtx(env));
  $("rpt-ask").disabled = st !== "free";
  $("rpt-ask-t").textContent = t(st === "pending" ? "rpt.asking" : "rpt.ask");
  $("rpt-ask").querySelector("svg").hidden = st === "pending";   // 「agent 寫作中…」不是動作,＋ icon 收掉
  const msg = $("rpt-msg");
  let text = null, err = false;
  if (st === "pending") text = t("rpt.note.pending");
  else if (st === "busy") text = t("turn.busy");
  else if (st === "stopped" || st === "stale") text = t(st === "stopped" ? "ho.gate.stopped" : "ho.gate.stale");
  else if (RPT.noNew === env) { text = t("rpt.err.noNew"); err = true; }
  msg.textContent = ""; msg.className = "rpt-msg" + (err ? " err" : ""); msg.hidden = !text;
  if (!text) return;
  if (err) { const m = libEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true"); msg.appendChild(m); }   // 灰記號:不是錯誤,是「沒發生」
  msg.appendChild(libEl("span", "", text));
}
function rptRow(r, current) {
  const b = libEl("button", "rpt-row"); b.type = "button"; b.dataset.id = r.id;
  if (current) b.setAttribute("aria-current", "true");
  const tt = libEl("div", "t", r.title); tt.title = r.title;
  const m = libEl("div", "m");
  m.appendChild(libEl("span", "mono", rptFmtStamp(r.created_at) || "\u2014"));   // 印不出的時間戳:—
  const k = rptTypeKey(r.type);   // web 第二行只有時間;這裡多一個類型字——電腦版沒有旗標色條幫人分組
  if (k) m.append(" · " + t(k));
  b.append(tt, m);
  return b;
}
function rptPaintList() {
  const env = libEnv(), B = rptBag(env), rows = $("rpt-rows"), state = $("rpt-state");
  rows.textContent = ""; state.hidden = true; state.textContent = ""; state.className = "rpt-state";
  rptPaintTools();
  const data = RPT.data[env];
  if (!data) {
    if (RPT.skel[env]) {
      [94, 82, 90, 76, 87].forEach((w) => { const r = libEl("div", "rpt-sk"), a = libEl("div", "sk"), c = libEl("div", "sk s"); a.style.width = w + "%"; c.style.width = Math.round(w * 0.5) + "%"; r.append(a, c); rows.appendChild(r); });
    } else if (RPT.failed[env]) {
      state.hidden = false;
      const b = libEl("button", "btn-out", t("rpt.retry")); b.type = "button"; b.addEventListener("click", () => rptLoad(env, true));
      state.append(t("rpt.error"), document.createElement("br"), b);
    }
    return;
  }
  if (!data.length) {   // 空狀態(§1.4):兩行置中、不在中間再放一顆鈕(填充動作是右上那顆)
    state.hidden = false; state.className = "rpt-state rpt-empty";
    state.append(libEl("p", "l1", t("rpt.empty")), libEl("p", "l2", t("rpt.emptyHint")));
    return;
  }
  // 剛讀的那份可能排在平鋪範圍外——多開幾批,回清單時才看得到它
  if (B.row) { const at = data.findIndex((r) => r.id === B.row); while (at >= B.shown) B.shown += RPT_PAGE; }
  data.slice(0, B.shown).forEach((r) => rows.appendChild(rptRow(r, r.id === B.row)));
  const rest = data.length - B.shown;
  if (rest > 0) {
    const more = libEl("button", "rpt-more"); more.type = "button";
    more.appendChild(libRich("rpt.more", { n: libEl("span", "mono", String(rest)) }));
    rows.appendChild(more);
  }
}
// 「更早的報告」:原地再開 12;重畫會殺掉按鈕本身,焦點接到新展開的第一列
function rptMore() {
  const B = rptBag(), was = B.shown, st = $("rpt-body").scrollTop;
  B.shown += RPT_PAGE;
  rptPaintList();
  $("rpt-body").scrollTop = st;
  const rowsEl = $("rpt-rows").querySelectorAll(".rpt-row");
  if (rowsEl[was]) rowsEl[was].focus();
}

/* ── 閱讀(§1.6)────────────────────────────────────── */
function rptShowRead(id) {
  const B = rptBag();
  if (!B.reading) B.scroll = $("rpt-body").scrollTop;
  B.row = id; B.reading = id;
  rptPaint(); $("rpt-body").scrollTop = 0;
  $("rpt-back").focus();
}
function rptBack() {
  const B = rptBag(); B.reading = null; ++RPT.readSeq;
  rptPaint();
  const r = $("rpt-rows").querySelector('.rpt-row[data-id="' + B.row + '"]');
  if (r) r.focus(); else $("rpt-h").focus();
}
async function rptFetch(env, id) {
  const entry = (RPT.data[env] || []).find((r) => r.id === id), ver = entry ? rptKey(entry) : id + "@";   // 本體快取照版本鍵分:同 id 覆寫後不會讀到舊本體
  const host = $("rpt-read"), key = env + "|" + ver, cached = RPT.docs.get(key);
  host.textContent = "";
  if (cached) { rptRender(env, cached, host); return; }
  const seq = ++RPT.readSeq;
  // 載入中:同 rpBodyPaint 的 .cx-wait + spin16,200 / 300ms 規則,置中
  const wait = libEl("div", "rpt-state center"), line = libEl("p", "cx-wait"), sp = libEl("span", "spin16");
  sp.setAttribute("aria-hidden", "true"); line.append(sp, t("tr.loading")); line.hidden = true; wait.appendChild(line); host.appendChild(wait);
  let shownAt = 0;
  setTimeout(() => { if (RPT.readSeq !== seq || !line.isConnected) return; line.hidden = false; shownAt = Date.now(); }, 200);
  let r = null;
  try { r = env === "cloud" ? await window.blave.cloudReport(id, entry && typeof entry.stored_at === "number" ? entry.stored_at : undefined) : await window.blave.reportLoad(id); } catch (_) { r = null; }
  if (RPT.readSeq !== seq) return;
  if (shownAt) {
    const hold = typeof rpWaitHold === "function" ? rpWaitHold(shownAt, Date.now()) : 0;
    if (hold) { await new Promise((res) => setTimeout(res, hold)); if (RPT.readSeq !== seq) return; }
  }
  const doc = r && r.report && typeof r.report === "object" && Array.isArray(r.report.blocks) ? { report: r.report, images: r.images && typeof r.images === "object" ? r.images : {} } : null;
  host.textContent = "";
  if (!doc) {   // 讀不到(雲端打不到 / 平台沒這份 / 本機 JSON 壞):一句 + 重新查看
    const box = libEl("div", "rpt-state center"), e = libEl("p", "plan-err"), m = libEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true");
    e.append(m, libEl("span", "", t("rpt.readErr")));
    const again = libEl("button", "btn-out", t("plan.recheck")); again.type = "button"; again.addEventListener("click", () => rptFetch(env, id));
    box.append(e, again); host.appendChild(box);
    return;
  }
  RPT.docs.set(key, doc);
  if (RPT.docs.size > RPT_DOCS_MAX) RPT.docs.delete(RPT.docs.keys().next().value);
  rptRender(env, doc, host);
}
function rptRender(env, doc, host) {
  try {
    window.renderAgentReport(host, doc.report, { apiBase: "", i18n: rptI18n(env), imageUrl: (ref) => doc.images[ref] || "", markdown: rptMarkdown });   // 空 src → onerror → 渲染器自己的失敗框
    libTrack("reports_read");
  } catch (_) {
    host.textContent = "";
    const box = libEl("div", "rpt-state center"), e = libEl("p", "plan-err"), m = libEl("span", "fault-mark"); m.setAttribute("aria-hidden", "true");
    e.append(m, libEl("span", "", t("rpt.readErr"))); box.appendChild(e); host.appendChild(box);
  }
}
/* text block 的 markdown → DOM(渲染器的 makeCtx.markdown):接 app.js 的 mdBlocks / mdPaint(一個節點一個節點組,不經 HTML)。
   契約不支援連結:mdPaint 從 [text](url) / 裸網址生出來的 <a> 拆回純文字(同 web)。尾註引用 [^id] → 上標:web 是餵給 marked 之前
   換成 <a> 字串;這裡的 markdown 不解讀 HTML,改在畫好的樹上換(程式碼與連結裡不換)。**粗體不必前置展開**:mdInline 的 ** 沒有
   CommonMark 的 flanking 限制。monoNarrative 由渲染器接手 */
function rptMarkdown(md, ctx) {
  if (typeof mdBlocks !== "function" || typeof mdPaint !== "function") return null;
  const frag = document.createDocumentFragment();
  mdPaint(frag, mdBlocks(md, 0));
  frag.querySelectorAll("a").forEach((a) => a.replaceWith(document.createTextNode(a.textContent)));
  const walker = document.createTreeWalker(frag, window.NodeFilter.SHOW_TEXT, null), texts = [];
  let n = null;
  while ((n = walker.nextNode())) { const p = n.parentNode; if (p && (p.nodeName === "CODE" || p.nodeName === "A")) continue; RPT_FN_RE.lastIndex = 0; if (RPT_FN_RE.test(n.nodeValue)) texts.push(n); }
  texts.forEach((node) => {
    const s = node.nodeValue, f = document.createDocumentFragment(), re = new RegExp(RPT_FN_RE.source, "g");
    let last = 0, m = null;
    while ((m = re.exec(s))) {
      const k = ctx.footnotes[m[1]];
      if (!k) continue;   // 對不上的引用 api 會 400;真的漏進來就原樣留字面,不做出一個點不到的上標
      if (m.index > last) f.append(s.slice(last, m.index));
      const a = document.createElement("a"); a.className = "rb-fnref"; a.href = "#fn-" + m[1]; a.textContent = String(k);
      a.setAttribute("aria-label", ctx.i18n.footnoteRef + " " + k);
      a.addEventListener("click", rptJumpFn);
      f.append(a); last = re.lastIndex;
    }
    if (last < s.length) f.append(s.slice(last));
    node.replaceWith(f);
  });
  return frag;
}
// 上標跳到尾註列(同 report-blocks.js 的 jumpToFootnote:只做「同頁跳到那條註解」,不導覽)
function rptJumpFn(e) {
  e.preventDefault();
  const id = this.getAttribute("href").slice(1), root = this.closest("article.rb-report");
  const target = root ? [...root.querySelectorAll(".rb-fn")].find((x) => x.id === id) : null;
  if (!target) return;
  target.scrollIntoView({ behavior: "auto", block: "center" });
  target.setAttribute("tabindex", "-1"); target.focus({ preventScroll: true });
}

/* ── 「新增報告」modal(§1.5;殼同 confirmBox 家族)──────────── */
function rptNewOpen(opener) {
  const sc = $("rpn-scrim");
  if (!sc.hidden) return;
  if (typeof envCanSwitch === "function" && !envCanSwitch()) return;   // 別的框開著 / 選字中
  RPT.opener = opener || document.activeElement; RPT.fail = false;
  rptNewPaint();
  $("view-ws").inert = true; $("set-scrim").inert = true;
  sc.hidden = false;
  requestAnimationFrame(() => sc.classList.add("open"));
  setTimeout(() => { if (!sc.hidden) $("rpn-desc").focus(); }, 60);
}
// 目的地記號(雲端視角三處)、誠實句、閘門(停機 / 逾時 / 回合中 → 送出鈕 disabled + .foot-msg 那一句);送出中不動 foot-msg
function rptNewPaint() {
  const env = libEnv(), cloud = env === "cloud";
  $("rpn-modal").querySelector(".modal-head").classList.toggle("cloud", cloud);
  $("rpn-env").hidden = !cloud; $("rpn-env").textContent = cloud ? t("env.cloud") : "";
  $("rpn-where").hidden = !cloud; $("rpn-where").textContent = cloud ? t("lib.cf.cloudNote") : "";
  $("rpn-honest").textContent = t("rpt.new.honest", { where: libWhere() });
  if (RPT.sending) return;
  const st = rptAskState(rptCtx(env));
  $("rpn-send").disabled = st !== "free";
  $("rpn-msg").textContent = st === "busy" ? t("turn.busy") : st === "stopped" ? t("ho.gate.stopped") : st === "stale" ? t("ho.gate.stale") : st === "pending" ? t("rpt.note.pending") : RPT.fail ? t("modal.sendFailed") : "";
}
// 送出中:三顆都停用(送出後撤不回,取消沒有意義;首次裝引擎可能等一分鐘,不能讓人按了沒反應)
function rptNewLock(on) { ["rpn-send", "rpn-cancel", "rpn-close"].forEach((id) => { $(id).disabled = on; }); }
function rptNewClose() {
  const sc = $("rpn-scrim");
  if (sc.hidden || RPT.sending) return;   // 送出中框留著(等 r.started 才關,不然人會以為沒按到)
  sc.classList.remove("open"); sc.hidden = true;
  $("view-ws").inert = false; $("set-scrim").inert = false;
  $("rpn-msg").textContent = ""; RPT.fail = false;
  const o = RPT.opener; RPT.opener = null;
  if (o && o.isConnected && o.offsetParent && !o.disabled) o.focus(); else rptFocusHome();   // 送出成功後開它的那顆鈕已停用(agent 寫作中):退到 #rpt-h
}
// 範例 chip:把範本填進描述欄、欄高撐到 min(scrollHeight, 50vh)、焦點回描述欄(照 web;chip 沒有選取態)
function rptFillTpl(key) {
  const d = $("rpn-desc");
  d.value = t(key);
  d.style.height = "auto";
  d.style.height = Math.min(d.scrollHeight + d.offsetHeight - d.clientHeight, window.innerHeight * 0.5) + "px";
  d.focus();
}
// 送出(同策略庫 libSend):描述空著 → 焦點回欄、不送;閘門沒開 → 只更新那一句;成功(跑起來)才關框、記 pending、對話多一行、reports_ask
async function rptSend() {
  if (RPT.sending) return;
  const d = $("rpn-desc"), desc = d.value.trim();
  if (!desc) { d.focus(); return; }
  const env = libEnv();
  if (rptAskState(rptCtx(env)) !== "free") { rptNewPaint(); return; }
  const msg = rptCompose(desc, LANG, { lead: t("rpt.new.msgLead"), once: t("rpt.new.msgOnce") });
  RPT.sending = true; RPT.fail = false;
  rptNewLock(true);
  const fm = $("rpn-msg"), busy = libEl("span", "cf-busy"), sp = libEl("span", "spin16"); sp.setAttribute("aria-hidden", "true");
  busy.append(sp, t("rpt.new.sending")); fm.textContent = ""; fm.appendChild(busy);
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);   // 聊天欄收著就先展開:過程在那裡回報
  if (csTitle) csStartNew();
  const before = new Set((RPT.data[env] || []).map(rptKey));
  let ok = false;
  try { ok = await submitMessage(msg); } catch (_) { ok = false; }
  RPT.sending = false;
  rptNewLock(false);
  if (!ok) { RPT.fail = true; rptNewPaint(); return; }   // 框留著、欄位不清、鈕回復,腳放那一句:讓人原樣重送
  fm.textContent = "";
  rptNewClose();
  d.value = ""; d.style.height = "";
  RPT.pending[env] = { env, before }; RPT.noNew = null;
  addMsg("sys", t("rpt.queued"));   // web 是等 user 回音落下再貼;桌面 addMsg("you") 是同步的,直接接在後面
  libTrack("reports_ask");
  rptSync();
}

/* ── 接線(這支比 app.js 先載:只用 getElementById,不碰 app.js 的全域;handler 裡的才在點擊時取)── */
(function rptWire() {
  const g = (id) => document.getElementById(id);
  g("rpt-nav").addEventListener("click", () => { if (!rptBag().open) rptOpen(); });
  g("rpt-back").addEventListener("click", rptBack);
  g("rpt-ask").addEventListener("click", () => rptNewOpen(g("rpt-ask")));
  g("rpt-rows").addEventListener("click", (e) => {   // 列會重畫:委派
    const b = e.target.closest(".rpt-row[data-id]"); if (b) { rptShowRead(b.dataset.id); return; }
    if (e.target.closest(".rpt-more")) rptMore();
  });
  g("rpt-body").addEventListener("scroll", () => { const B = rptBag(); if (!B.reading) B.scroll = g("rpt-body").scrollTop; });
  g("rpn-modal").addEventListener("submit", (e) => { e.preventDefault(); rptSend(); });   // CSP form-action 'none':原生送出一律擋
  g("rpn-cancel").addEventListener("click", () => rptNewClose());
  g("rpn-close").addEventListener("click", () => rptNewClose());
  g("rpn-scrim").addEventListener("mousedown", (e) => { if (e.target === g("rpn-scrim")) rptNewClose(); });
  g("rpn-scrim").addEventListener("keydown", (e) => trapTab(e, g("rpn-modal")));
  g("rpn-modal").querySelectorAll("[data-tpl]").forEach((b) => b.addEventListener("click", () => rptFillTpl(b.dataset.tpl)));
})();
