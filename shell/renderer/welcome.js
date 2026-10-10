/* 歡迎頁的資料清單(0.1.17;設計:.claude/output/designer/data-scope-2026-10/mockup-data-scope.html §1 歡迎頁)。
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
/* 右欄那句(對比版)。沒登入 / 沒綁卡是一顆文字鈕,開設定 › 帳號與方案(那一頁自己有登入與綁卡鈕、自己的埋點);
   餘額不夠是一句 + 「儲值」鈕;按小時付只有一句(整個歡迎頁唯一出現價格的地方);查不到不講 */
function wdNote(k, v, into) {
  const link = (txt) => { const b = wdEl("button", "btn-quiet", txt); b.type = "button"; b.addEventListener("click", () => planOpen()); return b; };
  if (k === "out") into.appendChild(link(t(v.t ? "wd.note.out" : "wd.note.outNoNum", v)));
  else if (k === "none") into.appendChild(link(t(v.t ? "wd.note.none" : "wd.note.noneNoNum", v)));
  else if (k === "billed") into.append(t(v.r ? "wd.note.billed" : "wd.note.billedNoNum", v));
  else if (k === "noplan") into.appendChild(link(t("wd.note.noplan")));
  else if (k === "payfail") { into.append(t("wd.note.payfail"), "　"); into.appendChild(link(t("pv.e.btn"))); }
  else if (k === "nobal") { into.append(t("wd.note.nobal"), "　"); into.appendChild(link(t("wd.note.topup"))); }
}
function wdRow(id) {
  const b = wdEl("button", "wd-row"); b.type = "button"; b.dataset.id = id;
  const l1 = wdEl("span", "wd-l1"); l1.append(wdEl("span", "wd-nm", wdK(id, "nm")), wdEl("span", "wd-mt", wdK(id, "fq") + t("wd.sep") + wdK(id, "sy")));
  b.appendChild(l1);
  b.addEventListener("click", () => wdFill(wdAsk(t("wd.ask"), wdK(id, "an"))));
  return b;
}
/* 那一句落進輸入框、不送出(同 trade.js trErrAsk):聊天欄收著就先展開;用戶自己打到一半的字留著、接在後面另起一行,
   上一列填進去的那句直接換掉(連點兩列不會疊成兩句)。用戶的字(WD.pre)與填完的整框(WD.filled)分開記:
   框還是上次填完的原樣 → 只換那一句、前面用戶的字留著;被動過 → 整框都算用戶的字,新的一句接在後面 */
function wdFill(text) {
  const ta = $("ta"), cur = ta.value;
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);
  WD.pre = cur === WD.filled ? WD.pre : cur.replace(/\s+$/, "");
  ta.value = WD.pre ? WD.pre + "\n" + text : text;
  WD.filled = ta.value; autosize(); ta.focus();
  trackFeature("welcome_data_row");
}
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
  const s = hasToken ? acct : null, v = planVars(), m = wdMode(hasToken, s, dataAccessOf(s), v.n);
  if (!hasToken && !pub && !WD.pubAsked) { WD.pubAsked = true; pubLoad().then(() => wdPaint()); }
  const key = JSON.stringify([LANG, m.k, m.cmp, WD.mk, v.t, v.r, v.d]);
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
      wdWel(WD.mk).filter((r) => r[2] === src).forEach((r) => col.appendChild(wdRow(r[0])));   // 三個市場兩欄都有列(tests/check_shell_welcome_data.js 列舉)
      body.appendChild(col);
    });
  } else { const col = wdEl("div", "wl-col"); wdWel(WD.mk).forEach((r) => col.appendChild(wdRow(r[0]))); body.appendChild(col); }
}
$("wl-seg").addEventListener("click", (e) => { const b = e.target.closest("button[data-mk]"); if (!b || b.dataset.mk === WD.mk) return; WD.mk = b.dataset.mk; wdPaint(); });
$("wl-all").addEventListener("click", wdDocs);
/* 補畫第一次:app.js 開場的 applyStatic 用 typeof wdPaint 判斷,它若在這支載入前就跑過(設定裡選過語言時是同步跑的;
   沒選過則看語系的 IPC 多快回來),那一次會跳過,沒登入的人清單就空到換語言或登入為止。
   只在 applyStatic 已經跑過時補(#wl-seg 的 aria-label 是它填的):還沒跑的話它等一下自己會畫,這裡搶先畫會閃一下英文 */
if ($("wl-seg").hasAttribute("aria-label")) wdPaint();
