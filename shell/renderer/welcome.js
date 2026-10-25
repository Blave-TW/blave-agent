/* 歡迎頁(兩個視角各一份,0.1.30 Wei:雲端也有;入門步驟照 0.1.29 三步版(Wei 10-22 口頭定案),完成後首頁照 mockup f-watermark)。
   onboarding 期間(E,#wc):記號 → 步驟清單 ①找靈感 ②做策略並回測 ③加到策略組合,不分市場(0.1.29 Wei:拿掉市場題與④自動下單)。
   ①② 全新時同時展開;③ 輪到才露鈕;完成的一步收成一行(打勾＋名字,不帶 meta);①② 點了重新展開,③ 點了直接到策略組合頁。完成判定全從現有狀態推:
   ② = 那個視角的清單有一支回測過(本機 RP.list、雲端 TR_BAGS.cloud.list 的 hasBacktest)、③ = 那個視角存著的金額有一支 > 0(trStored,同 strat_deployed 的判準)。
   做完③的當下原地一行「都設好了」(這次開著期間留著),之後就是完成後的首頁(F,#wf):淡化記號＋一列籤。
   「已進 F」兩個視角分開存主行程 ui-prefs(IPC welcome-prefs:done = 這台電腦、cloudDone = 雲端),不上傳。既有用戶第一次判斷就已經完成的直接進 F,不顯示「都設好了」、不送 onb_done——
   所以那一次判斷要等到狀態檔真的讀到(報告還沒來時③一律當沒輪到,不下結論)。
   起手句(spec-starters):三句並列、點了就把 starter_<mk>_send 送給現在連的 AI,只有 stFill 判定跑不了才填進輸入框。
   整頁等 app.js stratRefresh 第一次讀完清單(RP.loaded)與入門偏好讀到才顯示。
   接線:app.js stratRefresh → wcSync;trade.js trPoll → onbPaint;送出／解鎖那三排 → stSync;回合結束 → stTurnEnd;切視角 → trade.js envSwitch 叫 onbPaint。

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
   有沒有卡用 app.js acctOffer(新 api 看 has_card、舊 api 退回 reason;測試把那兩行一起切出來跑)。
   試用那句只在名下沒有主機時講:有主機的人試用到期後資料照樣含在主機費裡,「免費到 X」會是假話 */
function wdMode(signedIn, s, da, trialLeft) {
  if (!signedIn) return { cmp: true, k: "out" };
  if (da === "included") return { cmp: false, k: s && s.plan && s.plan.state === "none" && trialLeft > 0 ? "trial" : "incl" };
  if (da === "billed") return { cmp: true, k: "billed" };
  if (da === "none") return { cmp: true, k: s && s.reason === "NO_CARD" ? "none" : "nobal" };
  // 方案制:沒有方案 → noplan(有試用資格又沒卡 → none,綁卡拿試用;手上還有綁卡前額度的新人也算);方案扣款失敗 → payfail
  if (da === "plan_required") return { cmp: true, k: acctOffer(s) ? "none" : "noplan" };
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
/* 入門步驟(spec §2.3–2.4、§3.1)。o = { bt, funded, known, open[3] }:known = 狀態檔讀到了(還沒讀到時③不下結論,一律沒輪到)。
   ①跟②同時算完成(有想法的人跳過①直接打字)。cur = 還沒做、而且前面都做完(①② 永遠是 cur);open = 這一步的鈕露出來 */
function onbSteps(o) {
  const done = [!!o.bt, !!o.bt, !!o.known && !!o.funded];
  const steps = done.map((d, i) => {
    const state = d ? "done" : i < 2 || (o.known && done.slice(0, i).every(Boolean)) ? "cur" : "todo";
    return { state, open: state === "cur" || (state === "done" && !!(o.open && o.open[i])) };
  });
  return { steps, complete: !!o.known && done.every(Boolean) };
}
/* E／F 切換。o = { flag(已進 F), complete, base(第一次讀到狀態檔那一刻完成了沒;null = 還沒讀到), fin(這次開著時已經顯示過「都設好了」) }。
   回 { view: E | fin | F, setFlag, event }:當下完成才慶祝、才送 onb_done;上線那天就已經完成的直接進 F */
function onbPhase(o) {
  if (o.fin) return { view: "fin", setFlag: false, event: false };
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
/* 右欄那句(對比版)。沒登入是一顆文字鈕,直接開瀏覽器登入(app.js planSignIn);沒綁卡是一顆文字鈕——方案制直接開瀏覽器綁卡頁(bindGo,記 bind_welcome;
   欄名已經寫了「Blave 資料」,鈕字不再重複),切換前開設定 › 帳號與方案(那一頁自己有綁卡鈕、自己的埋點);
   餘額不夠是一句 + 「儲值」鈕;按小時付只有一句(整個歡迎頁唯一出現價格的地方);查不到不講 */
function wdNote(k, v, into) {
  const link = (txt, signIn, on) => { const b = wdEl("button", "btn-quiet", txt); b.type = "button"; if (signIn) signInLabel(b, txt); b.addEventListener("click", () => (on ? on() : signIn ? planSignIn(b) : planOpen())); return b; };
  // 方案制(planMo):試用結束自動開始扣方案費,帶天數那句講「免費試用」不講「送」(同 app.js pv.h.offer.m);切換前照舊
  const mo = planMo();
  if (k === "out") into.appendChild(link(t(v.t ? (mo ? "wd.note.out.m" : "wd.note.out") : "wd.note.outNoNum", v), true));
  else if (k === "none" && mo) into.appendChild(link(t(v.t ? "wd.note.trial" : "wd.note.noneNoNum", v), false, () => bindGo("bind_welcome")));
  else if (k === "none") into.appendChild(link(t(v.t ? "wd.note.none" : "wd.note.noneNoNum", v)));
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
  stPaint();   // 換語言、帳號狀態變了都走這裡:起手句換字
  const s = hasToken ? acct : null, v = planVars(), m = wdMode(hasToken, s, dataAccessOf(s), v.n);
  if (!hasToken && !pub && !WD.pubAsked) { WD.pubAsked = true; pubLoad().then(() => wdPaint()); }
  const key = JSON.stringify([LANG, m.k, m.cmp, WD.mk, v.t, v.r, v.d, planMo()]);
  onbPaint();
  if (typeof introSync === "function") introSync();   // 帳號狀態變了:第一次對話 modal 重判(renderer/intro.js)
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
// 「點了 = 送成一句話」的列:lucide corner-down-right(原本跟建議列共用,建議改成輸入框灰字後只剩這裡用)
const SEND_ROW_IC = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 10 5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>';
const ST_ROWS = [["crypto", 2020], ["tw", 2022], ["txf", 2015]];   // 順序固定、沒有預設市場;年份 = 送出那句「回測 X 年至今」
const ST = { lang: "", pending: null };
const ST_FEATURE = { crypto: "starter_crypto", tw: "starter_tw", txf: "starter_txf" };   // 送出點的名字要是字面(tests/check_shell_telemetry.js 掃的是這張表)
const runningNow = () => typeof running !== "undefined" && running === true;
function stPaint() {
  const box = $("st-rows"); if (!box || ST.lang === LANG) return;
  ST.lang = LANG; box.textContent = "";
  ST_ROWS.forEach(([mk, y]) => {
    const b = wdEl("button", "st-row"); b.type = "button"; b.dataset.starter = mk; busyLock(b, runningNow());
    const g = wdEl("span", "g"); g.setAttribute("aria-hidden", "true"); g.innerHTML = SEND_ROW_IC;
    const rowKey = "starter_" + mk + "_row";   // key 先組好再查(同 wdK;各市場兩語齊不齊由 tests/check_shell_welcome_data.js 列舉)
    // 不帶市場 tag(0.1.29 設計稽核:句子開頭就講了市場)。中間的空白文字節點給讀屏斷詞(grid 裡看不出來)
    b.append(g, wdEl("span", "txt", t(rowKey)), " ", wdEl("span", "since", t("starter_since", { y })));
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
  const env = onbEnv(), before = new Set((env === "cloud" ? TR_BAGS.cloud.list || [] : RP.list).map((x) => x.name));
  submitMessage(text).then((ok) => { if (ok) { trackFeature(ST_FEATURE[mk]); ST.pending = { before, env }; } });
}
// 起手句送出的那一輪結束(app.js onTurnEnd,stratRefresh(true) 之後;同 libTurnEnd):送出時那一邊的清單多了一支 = starter_new
// (雲端歡迎頁的起手句,策略建在雲端)
function stTurnEnd() {
  const p = ST.pending; if (!p) return;
  ST.pending = null;
  const list = p.env === "cloud" ? TR_BAGS.cloud.list || [] : RP.list;
  trackFeature(list.some((x) => !p.before.has(x.name)) ? "starter_new" : "starter_no_new");
}

/* ── 可以回測的資料 ›(§1.5):每次開 app 都收起來,不記住 ── */
$("wl-fold").addEventListener("click", () => {
  const open = $("wl").hidden;
  $("wl").hidden = !open; $("wl-fold").setAttribute("aria-expanded", String(open));
  if (open) trackFeature("wd_fold_open");
});

/* ── 入門步驟(E)與完成後的首頁(F)── */
const WC = { shown: false, armed: false };
// prefs:null = 還在讀(讀到之前不畫,不然已進 F 的人會先閃一下步驟清單)。base／fin／open 兩個視角各一份(ONB.v),畫面只有一份(key、amt 跟著現在的視角)
const onbV = () => ({ base: null, fin: false, open: [false, false, false] });
const ONB = { prefs: null, v: { local: onbV(), cloud: onbV() }, key: null, amt: false };
const ONB_FLAG = { local: "done", cloud: "cloudDone" };
const onbEnv = () => (typeof ENV !== "undefined" && ENV.cur === "cloud" ? "cloud" : "local");

const ONB_STEP_KEYS = ["onb.s1", "onb.s2", "onb.s3"];   // 字逐字同網頁 workspace_onb_s1–s3(兩語)
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
/* 從現有狀態推每一步(spec §2.3),env = 哪個視角的資料。雲端的清單在那份狀態裡、可能比報告晚到:清單沒載入(listLoaded)前不下結論,
   不然既有用戶第一次判斷會被當成「還沒回測」、之後假慶祝一次 */
function onbData(env) {
  const cloud = env === "cloud", L = typeof TR_BAGS !== "undefined" ? TR_BAGS[cloud ? "cloud" : "local"] : null, st = L && L.st, r = st && st.report;
  const known = !!r && typeof trExecState === "function" && trExecState(st) !== "loading" && (!cloud || !!L.listLoaded);
  const stored = known ? trWith(L, () => trStored()) || {} : {};
  const funded = Object.keys(stored).some((n) => Number(stored[n]) > 0);
  // ③ 已經勾了沒存、或存了但金額全 0:下一步是填金額,不是再開一次框(借頁首 trZCase 的 draft／amt 兩個判斷;那支要綁好帳戶才回值,新手多半沒綁,不整支照搬)
  const amt = known && !funded && (Object.keys(stored).length > 0 || trWith(L, () => trZDraft()));
  return { known, bt: (cloud ? (L && L.list) || [] : RP.list).some((x) => x.hasBacktest), funded, amt };
}
/* 標題列:完成的那一步是按鈕,其餘是灰或亮的字。完成列不帶 meta(Wei 10-21:策略名、金額、帳戶名都不放)。
   ①② 點了就地展開／收起;③ 直接到策略組合頁(做完之後要看的就是那一頁,展開只會露出用過的鈕) */
function onbHead(i, s) {
  const host = $("onb-h" + (i + 1)), label = t(ONB_STEP_KEYS[i]);
  host.textContent = "";
  const done = s.state === "done", h = wdEl(done ? "button" : "div", "onb-h is-" + s.state);
  if (done) {
    h.type = "button";
    if (i < 2) { h.setAttribute("aria-expanded", String(s.open)); h.setAttribute("aria-controls", "onb-b" + (i + 1)); }
    h.addEventListener("click", () => (i === 2 ? poOpen("cfg", true) : onbToggle(i)));
  }
  const num = wdEl("span", "num", done ? "✓" : String(i + 1)); num.setAttribute("aria-hidden", "true");
  h.append(num, wdEl("span", done ? "sr-only" : "lb", done ? t("onb.doneSr", { step: label }) : label));
  if (done) { const lb = wdEl("span", "lb", label); lb.setAttribute("aria-hidden", "true"); h.appendChild(lb); }
  if (done) { const ch = wdEl("span", "chev", "›"); ch.setAttribute("aria-hidden", "true"); h.appendChild(ch); }
  host.appendChild(h);
}
function onbToggle(i) {
  const V = ONB.v[onbEnv()];
  V.open[i] = !V.open[i];
  if (V.open[i]) trackFeature(onbEnv() === "cloud" ? "onb_reopen_cloud" : "onb_reopen");
  ONB.key = null; onbPaint();
  const b = $("onb-h" + (i + 1)).querySelector("button"); if (b) b.focus();
}
/* 一個視角的判斷:記基準、存旗標、送完成事件——兩個視角每輪都判(③ 是在策略組合頁存金額完成的,那一刻歡迎頁不在畫面上)。
   雲端的完成事件只在看著雲端時送:雲端也可能是在網站上做完的,那邊自己有 onboarding_done */
function onbEval(env) {
  const V = ONB.v[env], f = ONB_FLAG[env], d = onbData(env), S = onbSteps({ bt: d.bt, funded: d.funded, known: d.known, open: V.open });
  if (d.known && V.base === null) V.base = S.complete;
  const ph = onbPhase({ flag: ONB.prefs[f], complete: S.complete, base: V.base, fin: V.fin });
  if (ph.setFlag) { ONB.prefs[f] = true; onbSave({ [f]: true }); }
  if (ph.view === "fin") V.fin = true;
  if (ph.event && env === "local") trackFeature("onb_done");
  if (ph.event && env === "cloud" && onbEnv() === "cloud") trackFeature("onb_done_cloud");
  return { d, S, ph };
}
/* 重畫。指紋沒變就不碰 DOM(trPoll 每輪都叫:hover 與焦點不能被洗掉) */
function onbPaint() {
  const wc = $("wc"), wf = $("wf"); if (!wc || !wf || !WC.shown || !ONB.prefs) return;
  const env = onbEnv();
  onbEval(env === "cloud" ? "local" : "cloud");
  const { d, S, ph } = onbEval(env);
  ONB.amt = d.amt;
  const key = JSON.stringify([LANG, env, ph.view, S.steps, d.amt]);
  if (key === ONB.key) return;
  ONB.key = key;
  wf.hidden = ph.view !== "F"; wc.hidden = ph.view === "F";
  $("onb-fin").hidden = ph.view !== "fin";
  $("onb-steps").hidden = ph.view !== "E";
  if (ph.view !== "E") return;
  S.steps.forEach((s, i) => { onbHead(i, s); $("onb-b" + (i + 1)).hidden = !s.open; });
  // 雲端主機本來就含 Blave 資料(主機費含資料費):「免費 vs Blave 資料」那份清單在雲端會講錯事實,同網頁歡迎頁不出
  const cloud = env === "cloud", fold = $("wl-fold");
  fold.hidden = cloud;
  if (cloud) { $("wl").hidden = true; fold.setAttribute("aria-expanded", "false"); }
  $("onb-po").textContent = t(d.amt ? "po.goAmounts" : "tr.pick");
}
$("onb-lib").addEventListener("click", () => libOpen());
// ③ 到策略組合頁並打開選擇策略框,讓用戶自己勾(Wei 0.1.29:不替他挑一支);勾了沒存／存了 0 → 落在金額格
$("onb-po").addEventListener("click", () => { trackFeature(onbEnv() === "cloud" ? "onb_go_po_cloud" : "onb_go_po"); poPick(ONB.amt); });
// F 的三顆籤:不帶市場(spec §3.2)
$("wf-idea").addEventListener("click", () => ideaOpen($("wf-idea"), "welcome", "any"));
$("wf-lib").addEventListener("click", () => libOpen());
$("wf-ns").addEventListener("click", () => nsOpen($("wf-ns")));
Promise.resolve().then(() => window.blave.welcomePrefs()).then((p) => p, () => null).then((p) => {
  ONB.prefs = { done: !!(p && p.done === true), cloudDone: !!(p && p.cloudDone === true) };
  if ($("wl-seg").hasAttribute("aria-label")) wdPaint(); else onbPaint();   // applyStatic 還沒跑就先別畫資料清單(同檔尾那一條)
});
// 開機那次 stratRefresh / enterWorkspace 可能在這支載入前就跑完(script 之間會先跑掉 microtask,typeof 那時還是 undefined):補叫一次
if (RP.loaded) wcSync();
if (!$("view-ws").hidden) wcArm();
/* 補畫第一次:app.js 開場的 applyStatic 用 typeof wdPaint 判斷,它若在這支載入前就跑過(設定裡選過語言時是同步跑的;
   沒選過則看語系的 IPC 多快回來),那一次會跳過,沒登入的人清單就空到換語言或登入為止。
   只在 applyStatic 已經跑過時補(#wl-seg 的 aria-label 是它填的):還沒跑的話它等一下自己會畫,這裡搶先畫會閃一下英文 */
if ($("wl-seg").hasAttribute("aria-label")) wdPaint();
