/* 歡迎頁(0.1.26 起手句;設計 output/designer/strategy-creation-2026-10-15/spec-starters.md,mockup C):沒選策略就是這一頁,不分有沒有策略(Wei 10-17)。
   記號＋標題 → 三句起手句(加密｜台股｜台指期;點了就把 starter_<mk>_send 送給現在連的 AI,只有 stFill 判定跑不了才填進輸入框)
   → 入口籤 → 「可以回測的資料 ›」(預設收起、不記住)→ 還沒想法？＋三張策略庫卡(library.js wcReco 挑)。
   整頁等 app.js stratRefresh 第一次讀完清單(RP.loaded)才顯示:卡要扣掉已經裝過的,先畫一版再換會閃。
   接線:app.js stratRefresh → wcSync;送出／解鎖那三排 → stSync;回合結束 libTurnEnd 旁 → stTurnEnd;library.js libLoad → wcPaint。

   歡迎頁的資料清單(0.1.17;設計:.claude/output/designer/data-scope-2026-10/mockup-data-scope.html §1 歡迎頁)。
   工作頁沒選策略時的空狀態,籤下面列「可以回測的資料」:依市場分段,每一列一行 = 資料名 + 緊跟在後的小字(頻率・起始年),
   整列可點 →「跟我討論要怎麼用〈資料名〉做策略」落進輸入框、**不送出**(每列掛一句現成想法的版本字太多,退役)。帳號狀態決定版本:
   - 兩欄對比(免費,不用帳號 vs Blave 資料):沒登入、沒綁卡、有卡沒主機按小時付、餘額不夠、查不到。右欄不上鎖不變灰,價格只出現在那一句。
   - 單一清單(不出任何價格字):資料已經含在裡面——綁卡試用中、名下有主機、API 方案(pricing §2.3 blave_data_included 是 api 算的,
     這裡只讀 account_status 的 data_access 三態,同 app.js dataAccessOf)。
   「看全部資料」用瀏覽器開網站的資料文件頁(每份資料的頻率、起始、來源在那邊維護;app 內沒有完整目錄)。字全在 .po(wd.*);
   起始年查不到的列不放(BingX、CME／ICE 商品、公開大盤與公開期貨法人:另一條線在量,之後補)。
   接線:app.js 的 acctPaint / acctPrecheck / applyStatic / acctSignOut 叫 wdPaint(),檔尾補畫漏掉的第一次;index.html 的 #wl 骨架;welcome.css。 */

/* ── 純邏輯(tests/check_shell_welcome_data.js 從原文切出來跑;不碰 DOM / i18n)── */
/* 帳號狀態 → 清單模式 { cmp, k }:cmp = 兩欄對比;k = 右欄那句:out 沒登入 / unknown 查不到或舊 api / none 沒綁卡 /
   nobal 餘額不夠 / billed 有卡沒主機按小時(切換前)/ noplan 方案制沒有方案 / payfail 方案扣款失敗 / trial 綁卡試用中 / incl 名下有主機或 API 方案。
   da = app.js dataAccessOf(s)(included / billed / none / null);trialLeft = 試用剩幾天(planVars().n)。
   試用那句只在名下沒有主機時講:有主機的人試用到期後資料照樣含在主機費裡,「免費到 X」會是假話 */
function wdMode(signedIn, s, da, trialLeft) {
  if (!signedIn) return { cmp: true, k: "out" };
  if (da === "included") return { cmp: false, k: s && s.plan && s.plan.state === "none" && trialLeft > 0 ? "trial" : "incl" };
  if (da === "billed") return { cmp: true, k: "billed" };
  if (da === "none") return { cmp: true, k: s && s.reason === "NO_CARD" ? "none" : "nobal" };
  // 方案制:沒有方案 → noplan(有試用資格又沒卡 → none,綁卡拿試用);方案扣款失敗 → payfail
  if (da === "plan_required") return { cmp: true, k: s && s.reason === "NO_CARD" && s.trial_eligible ? "none" : "noplan" };
  if (da === "payment_failed") return { cmp: true, k: "payfail" };
  return { cmp: true, k: "unknown" };
}
/* 資料名代進句子模板的 {name}。中文模板的 {name} 兩側貼著中文字,資料名頭尾是英數就補一個半形空白
   (「用 Put/Call Ratio 做策略」);英文模板兩側本來就是空白,不補 */
function wdAsk(tpl, name) {
  const i = tpl.indexOf("{name}"); if (i < 0) return tpl;
  const a = tpl.slice(0, i), b = tpl.slice(i + 6), han = /[\u2e80-\u9fff]/, lat = /[A-Za-z0-9]/;
  return a + (han.test(a.slice(-1)) && lat.test(name[0]) ? " " : "") + name + (han.test(b[0] || "") && lat.test(name.slice(-1)) ? " " : "") + b;
}
/* 起手句要不要改成只填不送(spec-starters §2.2):確定跑不了才擋——還沒連 AI,或連 Blave AI、已登入而帳號不能跑。
   查不到 / 還在查(canRun null)當作能跑;沒登入照樣送,proxy 403 之後由登入卡接手(只填不送的話畫面上沒有下一步) */
function stFill(c) { return c.engine == null || (c.engine === "blave" && c.signedIn === true && c.canRun === false); }
/* ── 純邏輯到此 ── */

const WD_P = "p", WD_B = "b";
/* 每一列:[id, 市場, 來源];陣列順序就是畫面順序(對比版照來源分欄、單一清單照這裡)。字在 .po:wd.r.<id>.nm(列上顯示的名字)/
   .fq(頻率)/ .sy(起始年短句)/ .an(代進 wd.ask 那一句的名字:不帶括號說明)。
   台指期 K 線拆兩列:txd 日線免費(期交所 futDataDown,lib/data.py fetch_txf_daily_public,1998-07-21 起)、txk 分線走 Blave */
const WD_ROWS = [
  ["bnk", "crypto", WD_P], ["fng", "crypto", WD_P], ["ti", "crypto", WD_B], ["conc", "crypto", WD_B], ["liq", "crypto", WD_B], ["fr", "crypto", WD_B],
  ["twd", "tw", WD_P], ["inst", "tw", WD_B], ["rev", "tw", WD_B], ["twm", "tw", WD_B], ["br", "tw", WD_B],
  ["txd", "txf", WD_P], ["txk", "txf", WD_B], ["txio", "txf", WD_B], ["fi", "txf", WD_B], ["pcr", "txf", WD_B],
];
const WD = { mk: "crypto", key: "", pre: "", filled: "", pubAsked: false };

const wdEl = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
/* 列的字:key 先組好再查(check_shell_strings 的閘門只認字面 key;每一列每個欄位兩語齊不齊由 tests/check_shell_welcome_data.js 列舉) */
const wdK = (id, f) => { const k = "wd.r." + id + "." + f; return t(k); };
/* 右欄那句(對比版)。沒登入是一顆文字鈕,直接開瀏覽器登入(app.js planSignIn);沒綁卡是一顆文字鈕,開設定 › 帳號與方案(那一頁自己有綁卡鈕、自己的埋點);
   餘額不夠是一句 + 「儲值」鈕;按小時付只有一句(整個歡迎頁唯一出現價格的地方);查不到不講 */
function wdNote(k, v, into) {
  const link = (txt, signIn) => { const b = wdEl("button", "btn-quiet", txt); b.type = "button"; if (signIn) signInLabel(b, txt); b.addEventListener("click", () => (signIn ? planSignIn(b) : planOpen())); return b; };
  // 方案制(planMo):試用結束自動開始扣方案費,帶天數那句講「免費試用」不講「送」(同 app.js pv.h.offer.m);切換前照舊
  const mo = planMo();
  if (k === "out") into.appendChild(link(t(v.t ? (mo ? "wd.note.out.m" : "wd.note.out") : "wd.note.outNoNum", v), true));
  else if (k === "none") into.appendChild(link(t(v.t ? (mo ? "wd.note.none.m" : "wd.note.none") : "wd.note.noneNoNum", v)));
  else if (k === "billed") into.append(t(v.r ? "wd.note.billed" : "wd.note.billedNoNum", v));
  else if (k === "noplan") into.appendChild(link(t("wd.note.noplan")));
  else if (k === "payfail") { into.append(t("wd.note.payfail"), "　"); into.appendChild(link(t("pv.e.btn"))); }
  else if (k === "nobal") { into.append(t("wd.note.nobal"), "　"); into.appendChild(link(t("wd.note.topup"))); }
}
/* build:用戶拿得到的列(單一清單、對比版的免費欄)用「幫我建一支並回測」那句;對比版的 Blave 資料欄留討論句,不然一點就撞資料牆 */
function wdRow(id, build) {
  const b = wdEl("button", "wd-row"); b.type = "button"; b.dataset.id = id;
  const l1 = wdEl("span", "wd-l1"); l1.append(wdEl("span", "wd-nm", wdK(id, "nm")), wdEl("span", "wd-mt", wdK(id, "fq") + t("wd.sep") + wdK(id, "sy")));
  b.appendChild(l1);
  b.addEventListener("click", () => wdFill(wdAsk(t(build ? "wd.ask.build" : "wd.ask"), wdK(id, "an"))));
  return b;
}
/* 那一句落進輸入框、不送出(同 trade.js trErrAsk):聊天欄收著就先展開;用戶自己打到一半的字留著、接在後面另起一行,
   上一列填進去的那句直接換掉(連點兩列不會疊成兩句)。用戶的字(WD.pre)與填完的整框(WD.filled)分開記:
   框還是上次填完的原樣 → 只換那一句、前面用戶的字留著;被動過 → 整框都算用戶的字,新的一句接在後面 */
function wdFillText(text) {
  const ta = $("ta"), cur = ta.value;
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);
  WD.pre = cur === WD.filled ? WD.pre : cur.replace(/\s+$/, "");
  ta.value = WD.pre ? WD.pre + "\n" + text : text;
  WD.filled = ta.value; autosize(); ta.focus();
}
// 埋點分開送:起手句只填不送時走 wdFillText + starter_fill,不能灌進資料列的 welcome_data_row
function wdFill(text) { wdFillText(text); trackFeature("welcome_data_row"); }
const wdWel = (mk) => WD_ROWS.filter((r) => r[1] === mk);
/* 「看全部資料」:外開網站的資料文件頁,跟著目前的市場分頁與語言;台指期在台股那一頁。清單畫面不動 */
function wdDocs() {
  trackFeature("welcome_data_all");
  window.blave.openExternal(docsUrl(WD.mk === "crypto" ? "data_crypto" : "data_twstock"));
}
/* 重畫。指紋沒變就不碰 DOM(account_status 每一輪回合結束都會重讀,hover 與焦點不能被洗掉)。
   沒登入時那句要的試用天數來自公開價目(app.js pubLoad,一次,拿不到就用不帶數字的句子) */
function wdPaint() {
  const box = $("wl"); if (!box) return;
  stPaint(); wcLoad();   // 換語言、帳號狀態變了都走這裡:起手句換字、卡的資料要重問
  const s = hasToken ? acct : null, v = planVars(), m = wdMode(hasToken, s, dataAccessOf(s), v.n);
  if (!hasToken && !pub && !WD.pubAsked) { WD.pubAsked = true; pubLoad().then(() => wdPaint()); }
  const key = JSON.stringify([LANG, m.k, m.cmp, WD.mk, v.t, v.r, v.d, planMo()]);
  if (key === WD.key) return;
  WD.key = key;
  $("wl-seg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mk === WD.mk)));
  const st = $("wl-state"), body = $("wl-body"); st.textContent = ""; body.textContent = "";
  body.classList.toggle("cmp2", m.cmp);
  if (m.k === "trial") st.textContent = t("wd.state.trial", v);
  if (m.cmp) {
    [WD_P, WD_B].forEach((src) => {
      const col = wdEl("div", "wl-col"), h = wdEl("div", "wl-colh"); h.appendChild(wdEl("span", "wl-cap", t(src === WD_P ? "wd.col.free" : "wd.col.blave")));
      if (src === WD_B) { const nt = wdEl("span", "wl-note"); wdNote(m.k, v, nt); if (nt.childNodes.length) h.appendChild(nt); }
      col.appendChild(h);
      wdWel(WD.mk).filter((r) => r[2] === src).forEach((r) => col.appendChild(wdRow(r[0], src === WD_P)));   // 三個市場兩欄都有列(tests/check_shell_welcome_data.js 列舉)
      body.appendChild(col);
    });
  } else { const col = wdEl("div", "wl-col"); wdWel(WD.mk).forEach((r) => col.appendChild(wdRow(r[0], true))); body.appendChild(col); }
}
$("wl-seg").addEventListener("click", (e) => { const b = e.target.closest("button[data-mk]"); if (!b || b.dataset.mk === WD.mk) return; WD.mk = b.dataset.mk; wdPaint(); });
$("wl-all").addEventListener("click", wdDocs);

/* ── 起手句(spec-starters §1.4、§2)── */
const ST_ROWS = [["crypto", 2020], ["tw", 2022], ["txf", 2015]];   // 順序固定、沒有預設市場;年份 = 送出那句「回測 X 年至今」
const ST = { lang: "", pending: null };
const ST_FEATURE = { crypto: "starter_crypto", tw: "starter_tw", txf: "starter_txf" };   // 送出點的名字要是字面(tests/check_shell_telemetry.js 掃的是這張表)
const runningNow = () => typeof running !== "undefined" && running === true;
function stPaint() {
  const box = $("st-rows"); if (!box || ST.lang === LANG) return;
  ST.lang = LANG; box.textContent = "";
  ST_ROWS.forEach(([mk, y]) => {
    const b = wdEl("button", "st-row"); b.type = "button"; b.dataset.starter = mk; busyLock(b, runningNow());
    const g = wdEl("span", "g", "↳"); g.setAttribute("aria-hidden", "true");
    const mkKey = "wd.mk." + mk, rowKey = "starter_" + mk + "_row";   // key 先組好再查(同 wdK;各市場兩語齊不齊由 tests/check_shell_welcome_data.js 列舉)
    // 中間的空白文字節點給讀屏斷詞(grid 裡看不出來):不然按鈕名字是「加密BTC 日線…2020 起」
    b.append(g, wdEl("span", "tag", t(mkKey)), " ", wdEl("span", "txt", t(rowKey)), " ", wdEl("span", "since", t("starter_since", { y })));
    b.addEventListener("click", () => stGo(mk));
    box.appendChild(b);
  });
}
// 回合進行中三列是鎖(busy.js):aria-disabled、點了在輸入框上方講原因;app.js 送出 / 解鎖那三排跟 nsSync 一起叫
function stSync() { const box = $("st-rows"); if (box) box.querySelectorAll(".st-row").forEach((b) => busyLock(b, runningNow())); }
function stGo(mk) {
  if (runningNow()) { busySendTell(); return; }
  WD.mk = mk; wdPaint();   // 資料摺疊的分段跟著最後點的那句走
  const sendKey = "starter_" + mk + "_send", text = t(sendKey), a = typeof acct !== "undefined" ? acct : null;
  // 新策略開新對話(Wei;同 nsSend、策略庫、找點子):這條對話講過話(csTitle 在 submitMessage 第一個 await 之前就設好)就先開新的。
  // 只填不送也一樣先開,不然填進去的字送出時還是接在舊對話後面
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);   // 過程在對話欄回報
  const fresh = !!csTitle;
  if (fresh) csStartNew();
  if (stFill({ engine: typeof cur !== "undefined" ? cur : null, signedIn: !!hasToken, canRun: a ? a.can_run : null })) {
    wdFillText(text); trackFeature("starter_fill");
    if (fresh && typeof acctPrecheck === "function") acctPrecheck();   // 換了新對話,預檢卡(這時唯一要做的事)跟著清掉了:補回來
    return;
  }
  const before = new Set(RP.list.map((x) => x.name));
  submitMessage(text).then((ok) => { if (ok) { trackFeature(ST_FEATURE[mk]); ST.pending = { before }; } });
}
// 起手句送出的那一輪結束(app.js onTurnEnd,stratRefresh(true) 之後;同 libTurnEnd):本機清單多了一支 = starter_new
function stTurnEnd() {
  const p = ST.pending; if (!p) return;
  ST.pending = null;
  trackFeature(RP.list.some((x) => !p.before.has(x.name)) ? "starter_new" : "starter_no_new");
}

/* ── 可以回測的資料 ›(§1.5):每次開 app 都收起來,不記住 ── */
$("wl-fold").addEventListener("click", () => {
  const open = $("wl").hidden;
  $("wl").hidden = !open; $("wl-fold").setAttribute("aria-expanded", String(open));
  if (open) trackFeature("wd_fold_open");
});

/* ── 還沒想法？三張策略庫卡(§1.6;長相照網頁 libCard)── */
const WC = { key: null, charts: [], shown: false, armed: false, retried: null };
// 第一次清單讀完才顯示整頁
function wcSync() {
  if (!WC.shown) { WC.shown = true; $("wc").hidden = false; }
  wcLoad(); wcPaint();
}
// 讀清單一直失敗(RP.loaded 不會變)也不能讓歡迎頁永遠空白:進工作頁(app.js enterWorkspace)起算 3 秒照樣出。
// 從 script 載入起算的話,停在連線頁超過 3 秒的人會在還沒連 AI 時就打策略庫、進來後卡片再換一輪(稽核 B1)
function wcArm() {
  if (WC.armed) return;
  WC.armed = true; setTimeout(() => { if (!WC.shown) wcSync(); }, 3000);
}
// 開機那次 stratRefresh / enterWorkspace 可能在這支載入前就跑完(script 之間會先跑掉 microtask,typeof 那時還是 undefined):補叫一次
if (RP.loaded) wcSync();
if (!$("view-ws").hidden) wcArm();
// 手上沒有、作廢了、換了語言才問(主行程有 5 分鐘快取)。不從 wcPaint 叫:libLoad 結束會叫 wcPaint,讀不到時會一直重打。
// 讀不到(主行程不快取失敗)只再試一次:之後要等登入翻轉(libInvalidate 標 stale)或換語言,不跟著每次帳號刷新、回合結束重打(稽核 B2)
function wcLoad() {
  if (!WC.shown || LIB.loading) return;
  if (LIB.data && !LIB.stale && LIB.data.lang === LANG) return;
  if (!LIB.data && LIB.failed && !LIB.stale) { if (WC.retried === LANG) return; WC.retried = LANG; }
  libLoad(false);
}
function wcPaint() {
  const box = $("wc-reco"), cards = $("wc-cards"); if (!box || !WC.shown) return;
  const picks = LIB.data ? wcReco(LIB.data.strategies, { dataAccess: LIB.data.dataAccess, signedIn: !!hasToken, installed: wcInstalled }) : [];
  const key = JSON.stringify([LANG, LIB.data ? "d" : LIB.skel ? "skel" : "none", LIB.data ? LIB.data.strategies.length : 0, picks]);
  if (key === WC.key) return;
  WC.key = key;
  WC.charts.forEach((c) => { try { c.remove(); } catch (_) { } }); WC.charts = [];
  cards.textContent = "";
  if (!LIB.data && LIB.skel) {
    for (let i = 0; i < 3; i++) { const c = wdEl("div", "wc-card is-skel"); [70, 40, 100, 55].forEach((w) => { const k = wdEl("div", "sk"); k.style.width = w + "%"; c.appendChild(k); }); cards.appendChild(c); }
    $("wc-more").hidden = true; box.hidden = false; return;
  }
  box.hidden = !picks.length;   // 讀不到、或挑出來是 0 支:整塊不見,不顯示錯誤字
  if (!picks.length) return;
  picks.forEach((s) => cards.appendChild(wcCard(s)));
  $("wc-more").hidden = false; $("wc-more").textContent = t("workspace_wel_more", { n: LIB.data.strategies.length });
  requestAnimationFrame(() => cards.querySelectorAll(".wc-curve").forEach((h) => wcCurve(h, (LIB.data.strategies.find((x) => String(x.id) === h.dataset.id) || {}).report)));
}
// libInstalledName 會把「名字不在本機清單」的對照刪掉:清單還沒讀到(3 秒保底那條路)時只看對照表,不能拿空清單去刪
function wcInstalled(s) { return RP.loaded ? !!libInstalledName(s) : !!LIB.installed[String(s.id)]; }
function wcCard(s) {
  const c = wdEl("article", "wc-card"), head = wdEl("div", "wc-card-h"), r = s.report || {};
  head.appendChild(wdEl("span", "t", s.title));   // 不放「已驗證」:三張都是官方、全部已驗證,同一個字印三次不能比較(Wei 10-17;策略庫面板照舊)
  const meta = wdEl("div", "wc-card-m"), y1 = String(r.equity_from || "").slice(0, 4), y2 = String(r.equity_to || "").slice(0, 4);
  meta.append(...libSymbolNodes(s));
  if (y1 && y2) meta.append(" · ", wdEl("span", "nw", t("workspace_lib_bt_span", { span: y1 === y2 ? y1 : y1 + "–" + y2 })));
  const curve = wdEl("div", "wc-curve"); curve.dataset.id = String(s.id);
  const stats = wdEl("div", "wc-stats"), mdd = typeof r.max_drawdown === "number" ? -Math.abs(r.max_drawdown) : null;
  [[t("wc.annLabel"), libPct(r.annual_return), r.annual_return > 0 ? " up" : r.annual_return < 0 ? " down" : ""], [t("lib.kv.sharpe"), libFixed(r.sharpe, 2), ""], [t("lib.kv.mdd"), libPct(mdd), mdd < 0 ? " down" : ""]]
    .forEach(([k, v, cls]) => { const d = wdEl("div", "wc-stat"); d.append(wdEl("span", "k", k), wdEl("span", "v mono" + cls, v)); stats.appendChild(d); });
  const act = wdEl("div", "wc-card-a"), use = wdEl("button", "btn-out", t("lib.use")), more = wdEl("button", "btn-quiet", t("workspace_lib_detail"));
  use.type = "button"; more.type = "button";
  // 〔用這支〕= 打開這支的詳情、焦點放在詳情主鈕(spec §1.6 的替代做法):下載失敗、沒送出、被擋都只畫在詳情裡,
  // 從歡迎頁直接 libAsk 的話那些錯誤畫在藏著的 #lib,畫面上什麼都沒有(稽核 M1)。閘門、library_use、lib_pick、lib_installed 照舊由詳情那條路送
  use.addEventListener("click", () => wcDetail(s, true));
  more.addEventListener("click", () => wcDetail(s, false));
  act.append(use, more);
  c.append(head, meta, curve, stats, act);
  return c;
}
async function wcDetail(s, cta) {
  await libOpen(); libShowDetail(s.id);
  const b = cta ? libCtaMain() : null; if (b) b.focus();
}
// 小曲線(lightweight-charts,同 library.js libChartDraw 的接法;沒有軸、不能捲)。畫不出來就留空,卡的數字照樣在
function wcCurve(host, r) {
  const data = r ? libCurve(r.spark, r.equity_from, r.equity_to) : null;
  if (!data || typeof LightweightCharts === "undefined") { host.classList.add("is-empty"); return; }
  const LWC = LightweightCharts, tok = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const chart = LWC.createChart(host, {
    autoSize: true, layout: { textColor: tok("--ink-3"), background: { type: "solid", color: tok("--surface-card") }, attributionLogo: false },
    leftPriceScale: { visible: false }, rightPriceScale: { visible: false, mode: LWC.PriceScaleMode.Logarithmic, scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: { visible: false, borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
    grid: { vertLines: { visible: false }, horzLines: { visible: false } }, crosshair: { mode: LWC.CrosshairMode.Hidden }, handleScroll: false, handleScale: false,
  });
  try {
    const series = chart.addSeries(LWC.LineSeries, { color: tok("--color-green"), lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    series.setData(data); chart.timeScale().fitContent(); WC.charts.push(chart);
  } catch (_) { chart.remove(); host.classList.add("is-empty"); }
}
$("wc-more").addEventListener("click", () => libOpen());
/* 補畫第一次:app.js 開場的 applyStatic 用 typeof wdPaint 判斷,它若在這支載入前就跑過(設定裡選過語言時是同步跑的;
   沒選過則看語系的 IPC 多快回來),那一次會跳過,沒登入的人清單就空到換語言或登入為止。
   只在 applyStatic 已經跑過時補(#wl-seg 的 aria-label 是它填的):還沒跑的話它等一下自己會畫,這裡搶先畫會閃一下英文 */
if ($("wl-seg").hasAttribute("aria-label")) wdPaint();
