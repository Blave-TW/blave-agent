/* 歡迎頁(只有「這台電腦」視角;spec .claude/output/specs/agent-onboarding-e-f-spec-2026-10-19.md,mockup e-simple / f-watermark)。
   onboarding 期間(E,#wc):記號 → 可跳過的市場題 → 步驟清單 ①找靈感 ②做策略並回測 ③加到策略組合 ④自動下單(台股沒有④)。
   ①② 全新時同時展開;③④ 輪到才露鈕;完成的一步收成一行(打勾＋名字＋meta),點了重新展開。完成判定全從現有狀態推:
   ② = 本機清單有一支回測過(RP.list hasBacktest)、③ = 存著的金額有一支 > 0(trStored,同 strat_deployed 的判準)、④ = trExecState running。
   做完最後一步的當下原地一行「都設好了」(這次開著期間留著),之後就是完成後的首頁(F,#wf):淡化記號＋一列籤。
   「已進 F」與市場題的選擇存主行程 ui-prefs(IPC welcome-prefs),不上傳。既有用戶第一次判斷就已經完成的直接進 F,不顯示「都設好了」、不送 onb_done_*——
   所以那一次判斷要等到狀態檔真的讀到(報告還沒來時③④一律當沒輪到,不下結論)。
   起手句(spec-starters):三句並列、點了就把 starter_<mk>_send 送給現在連的 AI,只有 stFill 判定跑不了才填進輸入框;市場題選了只留那一句。
   整頁等 app.js stratRefresh 第一次讀完清單(RP.loaded)與入門偏好讀到才顯示。
   接線:app.js stratRefresh → wcSync;trade.js trPoll → onbPaint;送出／解鎖那三排 → stSync;回合結束 → stTurnEnd;設定 › 一般〔重看〕→ onbReplay。

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
/* 入門步驟(spec §2.3–2.4、§3.1)。市場:題目選了照選的;沒選照第一支回測完的策略(runtime strategy_market 的長碼,或 telemetry 的短碼);
   判斷不出來 = null(畫四步) */
function onbMkt(choice, first) {
  if (choice === "crypto" || choice === "tw" || choice === "txf") return choice;
  return first === "tw_stock" ? "tw" : first === "crypto" ? "crypto" : first === "tw_index_futures" || first === "tw_idx_fut" ? "txf" : null;
}
/* o = { mkt, bt, funded, live, known, open[4] }:known = 狀態檔讀到了(還沒讀到時③④不下結論,一律沒輪到)。
   ①跟②同時算完成(有想法的人跳過①直接打字)。cur = 還沒做、而且前面都做完(①② 永遠是 cur);open = 這一步的鈕露出來 */
function onbSteps(o) {
  const n = o.mkt === "tw" ? 3 : 4, done = [!!o.bt, !!o.bt, !!o.known && !!o.funded, !!o.known && !!o.live].slice(0, n);
  const steps = done.map((d, i) => {
    const state = d ? "done" : i < 2 || (o.known && done.slice(0, i).every(Boolean)) ? "cur" : "todo";
    return { state, open: state === "cur" || (state === "done" && !!(o.open && o.open[i])) };
  });
  return { n, steps, complete: !!o.known && done.every(Boolean) };
}
/* E／F 切換。o = { flag(已進 F), complete, base(第一次讀到狀態檔那一刻完成了沒;null = 還沒讀到), fin(這次開著時已經顯示過「都設好了」), replay(設定裡按了重看) }。
   回 { view: E | fin | F, setFlag, event }:當下完成才慶祝、才送 onb_done_*;上線那天就已經完成的直接進 F */
function onbPhase(o) {
  if (o.fin) return { view: "fin", setFlag: false, event: false };
  if (o.replay) return { view: "E", setFlag: false, event: false };
  if (o.flag) return { view: "F", setFlag: false, event: false };
  if (o.base === null || o.base === undefined || !o.complete) return { view: "E", setFlag: false, event: false };
  return o.base === false ? { view: "fin", setFlag: true, event: true } : { view: "F", setFlag: true, event: false };
}
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
  stPaint(); onbApplyMkt();   // 換語言、帳號狀態變了都走這裡:起手句換字;市場題選了 → 資料清單只列那個市場
  const s = hasToken ? acct : null, v = planVars(), m = wdMode(hasToken, s, dataAccessOf(s), v.n);
  if (!hasToken && !pub && !WD.pubAsked) { WD.pubAsked = true; pubLoad().then(() => wdPaint()); }
  const key = JSON.stringify([LANG, m.k, m.cmp, WD.mk, v.t, v.r, v.d, planMo()]);
  onbPaint();
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

/* ── 入門步驟(E)與完成後的首頁(F)── */
const WC = { shown: false, armed: false };
// prefs:null = 還在讀(讀到之前不畫,不然已進 F 的人會先閃一下步驟清單)
const ONB = { prefs: null, base: null, fin: false, replay: false, open: [false, false, false, false], key: null, target: null };
const ONB_MKT_FEATURE = { crypto: "onb_mkt_crypto", tw: "onb_mkt_tw", txf: "onb_mkt_txf" };   // 送出點的名字要是字面(tests/check_shell_telemetry.js 掃這張表)
const ONB_STEP_KEYS = ["onb.s1", "onb.s2", "onb.s3", "onb.s4"];   // 字逐字同網頁 workspace_onb_s1–s4(兩語)
// ③ 合計單位的後備:加密的金額是報價幣(預設 USDT),台股與台指期換算成台幣
const ONB_MKT_CCY = { crypto: "USDT", tw_stock: "TWD", tw_index_futures: "TWD" };
// 第一次清單讀完才顯示整頁
function wcSync() {
  if (!WC.shown) WC.shown = true;
  onbPaint();
}
// 讀清單一直失敗(RP.loaded 不會變)也不能讓歡迎頁永遠空白:進工作頁(app.js enterWorkspace)起算 3 秒照樣出。
// 從 script 載入起算的話,停在連線頁超過 3 秒的人會在還沒連 AI 時就看到歡迎頁(稽核 B1)
function wcArm() {
  if (WC.armed) return;
  WC.armed = true; setTimeout(() => { if (!WC.shown) wcSync(); }, 3000);
}
const onbSave = (patch) => { Promise.resolve().then(() => window.blave.welcomePrefsSet(patch)).catch(() => {}); };
const onbChoice = () => (ONB.prefs && ONB.prefs.mkt) || null;
// 找點子框的市場:題目選了帶那個,沒選「不限」(同 libIdeaMkt 的值域)
function onbIdeaMkt() { return onbChoice() || "any"; }
// 市場題選了:資料清單跟著那個市場、分段鈕藏起來(wdPaint 的第一步)
function onbApplyMkt() {
  const c = onbChoice(), seg = $("wl-seg"); if (!seg) return;
  if (c) WD.mk = c;
  seg.hidden = !!c;
}
/* 從現有狀態推每一步(spec §2.3)。本機視角才有歡迎頁,只看 TR_BAGS.local */
function onbData() {
  const L = typeof TR_BAGS !== "undefined" ? TR_BAGS.local : null, st = L && L.st, r = st && st.report;
  const kinds = r && r.strategy_kinds && typeof r.strategy_kinds === "object" ? r.strategy_kinds : {};
  const known = !!r && typeof trExecState === "function" && trExecState(st) !== "loading";
  const stored = known ? trWith(L, () => trStored()) || {} : {};
  // 第一支回測完的 = 回測時間最早的那支(RP.list 是最近動過在上)
  const bts = RP.list.filter((x) => x.hasBacktest).sort((a, b) => (a.generatedAt || 0) - (b.generatedAt || 0));
  const first = bts[0] || null, funded = Object.keys(stored).some((n) => Number(stored[n]) > 0);
  // ③的那支:第一支回測完、還沒存金額的;Type B 不能加進組合(同 portfolio.js poAddBtn)
  const target = bts.find((x) => !(Number(stored[x.name]) > 0) && !(kinds[x.name] && kinds[x.name].type === "B")) || null;
  let total = null;
  if (funded) {
    const p = trWith(L, () => trPlanTotal(stored));
    // 合計的幣別推不出來(報告還沒帶標的、清單沒載入):照存了金額那幾支的市場補單位,市場不一致就不補
    const mks = [...new Set(Object.keys(stored).filter((n) => Number(stored[n]) > 0).map((n) => ONB_MKT_CCY[(kinds[n] || {}).market] || null))];
    const ccy = (p && p.ccy) || (mks.length === 1 ? mks[0] : null);
    if (p && p.ok) total = p.text + (ccy ? " " + ccy : "");
  }
  const vid = known ? trVenueIds(r)[0] : null;
  return { known, bt: !!first, funded, live: known && trExecState(st) === "running", acct: !!vid, acctName: vid ? trVenueLabel(vid, true) : null,
    firstMkt: first && kinds[first.name] ? kinds[first.name].market : null, firstName: first ? first.displayName || first.name : null, target: target ? target.name : null, total };
}
// 標題列:完成的那一步是按鈕(重新展開／收起),其餘是灰或亮的字
function onbHead(i, s, meta) {
  const host = $("onb-h" + (i + 1)), label = t(ONB_STEP_KEYS[i]);
  host.textContent = "";
  const done = s.state === "done", h = wdEl(done ? "button" : "div", "onb-h is-" + s.state);
  if (done) {
    h.type = "button"; h.setAttribute("aria-expanded", String(s.open)); h.setAttribute("aria-controls", "onb-b" + (i + 1));
    h.addEventListener("click", () => onbToggle(i));
  }
  const num = wdEl("span", "num", done ? "✓" : String(i + 1)); num.setAttribute("aria-hidden", "true");
  h.append(num, wdEl("span", done ? "sr-only" : "lb", done ? t("onb.doneSr", { step: label }) : label));
  if (done) { const lb = wdEl("span", "lb", label); lb.setAttribute("aria-hidden", "true"); h.appendChild(lb); }
  if (meta && s.state !== "todo") h.appendChild(wdEl("span", "meta", meta));
  if (done) { const ch = wdEl("span", "chev", "›"); ch.setAttribute("aria-hidden", "true"); h.appendChild(ch); }
  host.appendChild(h);
}
function onbToggle(i) {
  ONB.open[i] = !ONB.open[i];
  if (ONB.open[i]) trackFeature("onb_reopen");
  ONB.key = null; onbPaint();
  const b = $("onb-h" + (i + 1)).querySelector("button"); if (b) b.focus();
}
/* 重畫。指紋沒變就不碰 DOM(trPoll 每輪都叫:hover 與焦點不能被洗掉) */
function onbPaint() {
  const wc = $("wc"), wf = $("wf"); if (!wc || !wf || !WC.shown || !ONB.prefs) return;
  const d = onbData(), choice = onbChoice(), mkt = onbMkt(choice, d.firstMkt);
  const S = onbSteps({ mkt, bt: d.bt, funded: d.funded, live: d.live, known: d.known, open: ONB.open });
  if (d.known && ONB.base === null) ONB.base = S.complete;
  const ph = onbPhase({ flag: ONB.prefs.done, complete: S.complete, base: ONB.base, fin: ONB.fin, replay: ONB.replay });
  if (ph.setFlag) { ONB.prefs.done = true; onbSave({ done: true }); }
  if (ph.view === "fin") ONB.fin = true;
  if (ph.event) trackFeature(mkt === "tw" ? "onb_done_tw" : "onb_done_trade");
  ONB.target = d.target;
  const key = JSON.stringify([LANG, ph.view, mkt, choice, S.steps, d.firstName, d.total, d.acctName, d.target]);
  if (key === ONB.key) return;
  ONB.key = key;
  wf.hidden = ph.view !== "F"; wc.hidden = ph.view === "F";
  $("onb-fin").hidden = ph.view !== "fin";
  wc.querySelector(".onb-mq").hidden = ph.view !== "E"; $("onb-steps").hidden = ph.view !== "E";
  if (ph.view !== "E") return;
  $("onb-mkt").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mk === choice)));
  // ②③ 的 meta 只在完成時出;④ 綁了帳戶就帶帳戶名(還沒啟動的那一行也帶,mockup account-dialog ④)
  const metas = [null, S.steps[1].state === "done" ? d.firstName : null, S.steps[2] && S.steps[2].state === "done" ? d.total : null, d.acctName];
  [1, 2, 3, 4].forEach((n) => { $("onb-h" + n).closest("li").hidden = n > S.n; });
  S.steps.forEach((s, i) => { onbHead(i, s, metas[i]); $("onb-b" + (i + 1)).hidden = !s.open; });
  // ②:選了市場只留那一句起手句(tag 欄一起收)
  const rows = $("st-rows");
  rows.querySelectorAll(".st-row").forEach((b) => { b.hidden = !!choice && b.dataset.starter !== choice; });
  rows.classList.toggle("one", !!choice);
  // ③:沒有能加的那支(都存過金額、只剩 Type B)就不出鈕
  $("onb-po").hidden = !d.target; $("onb-bt").hidden = !d.target;
  // ④:連好帳戶、還沒啟動 → 只剩「到自動下單」;台指期的描邊鈕叫「連接期貨商」
  // 台指期在 Mac:統一與群益本機都要 Windows,〔連接期貨商〕只會開到一個講「要 Windows」的框——收起來,只留模擬交易＋一句說明
  const futMac = mkt === "txf" && window.blave.platform !== "win32";
  $("onb-paper").hidden = d.acct; $("onb-real").hidden = d.acct || futMac; $("onb-tr").hidden = !d.acct;
  $("onb-futmac").hidden = d.acct || !futMac;
  $("onb-real").textContent = t(mkt === "txf" ? "onb.realFut" : "cx.connect");
}
// 設定 › 一般〔重看〕(app.js):清掉旗標、這次開著期間停在步驟清單(下次開 app 再照完成條件判)
function onbReplay() {
  if (!ONB.prefs) return;
  ONB.prefs.done = false; ONB.fin = false; ONB.replay = true; ONB.open = [false, false, false, false]; ONB.key = null;
  onbSave({ done: false });
  onbPaint();
}
// 市場題:選了不同的才送;選了可以再換,不能清掉
$("onb-mkt").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mk]"); if (!b || !ONB.prefs || b.dataset.mk === ONB.prefs.mkt) return;
  ONB.prefs.mkt = b.dataset.mk; onbSave({ mkt: b.dataset.mk }); trackFeature(ONB_MKT_FEATURE[b.dataset.mk]);
  wdPaint();
});
// ①〔策略庫〕:開之前把本機那一袋的市場篩選設成市場題的值(不經 libMktPick,那裡會送 lib_mkt_pick)
$("onb-lib").addEventListener("click", () => {
  const c = onbChoice();
  if (c) libBag("local").mkt = c === "tw" ? "twstock" : c;
  libOpen();
});
// ③ 加到策略組合(A1 同一個動作,po_add 由 poAdd 送)/ 看回測
$("onb-po").addEventListener("click", () => {
  const name = ONB.target, S = TR_BAGS.local; if (!name) return;
  trackFeature("onb_go_po");
  poAdd(S, name, trWith(S, () => trNames().indexOf(name) >= 0));
});
$("onb-bt").addEventListener("click", () => { if (ONB.target) stratSelect(ONB.target); });
/* ④ 先到自動下單頁、再開連接框:綁好之後「啟動下單」就在那一頁(模擬預選;連接交易所／期貨商一定開在真實帳戶)。
   台指期在這台電腦只能連統一(群益是雲端那條):〔連接期貨商〕一律預選統一(Mac 由統一那條講一句) */
async function onbCx(paper) {
  await trOpen();
  if (ENV.cur !== "local" || !$("cx-scrim").hidden) return;
  const fut = onbMkt(onbChoice(), onbData().firstMkt) === "txf";
  cxModalOpen($("tr-connect") || $("tr-nav"), paper ? PAPER : fut ? "president" : null, paper ? "paper" : "real");
}
$("onb-paper").addEventListener("click", () => { trackFeature("onb_go_paper"); onbCx(true); });
$("onb-real").addEventListener("click", () => { trackFeature("onb_go_trade"); onbCx(false); });
$("onb-tr").addEventListener("click", () => trOpen());
// F 的三顆籤:不帶市場(spec §3.2)
$("wf-idea").addEventListener("click", () => ideaOpen($("wf-idea"), "welcome", "any"));
$("wf-lib").addEventListener("click", () => libOpen());
$("wf-ns").addEventListener("click", () => nsOpen($("wf-ns")));
Promise.resolve().then(() => window.blave.welcomePrefs()).then((p) => p, () => null).then((p) => {
  ONB.prefs = { mkt: p && ["crypto", "tw", "txf"].includes(p.mkt) ? p.mkt : null, done: !!(p && p.done === true) };
  if ($("wl-seg").hasAttribute("aria-label")) wdPaint(); else onbPaint();   // applyStatic 還沒跑就先別畫資料清單(同檔尾那一條)
});
// 開機那次 stratRefresh / enterWorkspace 可能在這支載入前就跑完(script 之間會先跑掉 microtask,typeof 那時還是 undefined):補叫一次
if (RP.loaded) wcSync();
if (!$("view-ws").hidden) wcArm();
/* 補畫第一次:app.js 開場的 applyStatic 用 typeof wdPaint 判斷,它若在這支載入前就跑過(設定裡選過語言時是同步跑的;
   沒選過則看語系的 IPC 多快回來),那一次會跳過,沒登入的人清單就空到換語言或登入為止。
   只在 applyStatic 已經跑過時補(#wl-seg 的 aria-label 是它填的):還沒跑的話它等一下自己會畫,這裡搶先畫會閃一下英文 */
if ($("wl-seg").hasAttribute("aria-label")) wdPaint();
