/* 歡迎頁的資料清單(0.1.17;設計:.claude/output/designer/data-scope-2026-10/mockup-data-scope.html §1 歡迎頁、§2 目錄)。
   工作頁沒選策略時的空狀態,籤下面列「可以回測的資料」:依市場分段,每一列 = 資料名／頻率／起始 + 一句可回測的想法,
   整列可點 → 那一句落進輸入框、**不送出**。帳號狀態決定版本:
   - 兩欄對比(免費,不用帳號 vs Blave 資料):沒登入、沒綁卡、有卡沒主機按小時付、餘額不夠、查不到。右欄不上鎖不變灰,價格只出現在那一句。
   - 單一清單(不出任何價格字):資料已經含在裡面——綁卡試用中、名下有主機、API 方案(pricing §2.3 blave_data_included 是 api 算的,
     這裡只讀 account_status 的 data_access 三態,同 app.js dataAccessOf)。
   「看全部資料」把同一塊換成完整目錄(同一張表的完整版,app 內、不外開)。字全在 .po(wd.*);
   起始年查不到的列不放(BingX、CME／ICE 商品、公開大盤與公開期貨法人:另一條線在量,之後補)。
   接線:app.js 的 acctPaint / acctPrecheck / applyStatic / acctSignOut 叫 wdPaint();index.html 的 #wl 骨架;welcome.css。 */

/* ── 純邏輯(tests/check_shell_welcome_data.js 從原文切出來跑;不碰 DOM / i18n)── */
/* 帳號狀態 → 清單模式 { cmp, k }:cmp = 兩欄對比;k = 右欄那句:out 沒登入 / unknown 查不到或舊 api / none 沒綁卡 /
   nobal 餘額不夠 / billed 有卡沒主機按小時 / trial 綁卡試用中 / incl 名下有主機或 API 方案。
   da = app.js dataAccessOf(s)(included / billed / none / null);trialLeft = 試用剩幾天(planVars().n)。
   試用那句只在名下沒有主機時講:有主機的人試用到期後資料照樣含在主機費裡,「免費到 X」會是假話 */
function wdMode(signedIn, s, da, trialLeft) {
  if (!signedIn) return { cmp: true, k: "out" };
  if (da === "included") return { cmp: false, k: s && s.plan && s.plan.state === "none" && trialLeft > 0 ? "trial" : "incl" };
  if (da === "billed") return { cmp: true, k: "billed" };
  if (da === "none") return { cmp: true, k: s && s.reason === "NO_CARD" ? "none" : "nobal" };
  return { cmp: true, k: "unknown" };
}
/* ── 純邏輯到此 ── */

const WD_P = "p", WD_B = "b";
const WD_MARKETS = ["crypto", "tw", "txf"];
/* 每一列:[id, 市場, 來源, 進目錄, 歡迎頁順序(0 = 只進目錄)]。字在 .po:wd.r.<id>.nm / .fq / .sn(目錄的起始)/ .us(可以回測);
   歡迎頁的列另有 .sy(起始年短句)/ .tx(起手句);WD_NT 有 .nt(目錄的補充小字)、WD_WN 有 .wn(歡迎頁列尾補充)、WD_WNM 有 .wnm(歡迎頁短名)。
   順序照 mockup §2;歡迎頁對比版照來源分欄、單一清單照這裡的順序號。
   台指期 K 線拆兩列:txd 日線免費(期交所 futDataDown,lib/data.py fetch_txf_daily_public,1998-07-21 起)、txk 分線走 Blave */
const WD_ROWS = [
  ["bnk", "crypto", WD_P, 1, 1], ["fng", "crypto", WD_P, 1, 2], ["ti", "crypto", WD_B, 1, 3], ["conc", "crypto", WD_B, 1, 4],
  ["whale", "crypto", WD_B, 1, 0], ["liq", "crypto", WD_B, 1, 5], ["sent", "crypto", WD_B, 1, 0], ["dir", "crypto", WD_B, 1, 0],
  ["top", "crypto", WD_B, 1, 0], ["fr", "crypto", WD_B, 1, 6],
  ["twd", "tw", WD_P, 1, 1], ["twm", "tw", WD_B, 1, 4], ["inst", "tw", WD_B, 1, 2], ["mg", "tw", WD_B, 1, 0], ["hold", "tw", WD_B, 1, 0],
  ["fh", "tw", WD_B, 1, 0], ["br", "tw", WD_B, 1, 5], ["fin", "tw", WD_B, 1, 0], ["rev", "tw", WD_B, 1, 3], ["val", "tw", WD_B, 1, 0],
  ["div", "tw", WD_B, 1, 0],
  ["txd", "txf", WD_P, 1, 1], ["txk", "txf", WD_B, 1, 2], ["txio", "txf", WD_B, 1, 3], ["fi", "txf", WD_B, 1, 4], ["big", "txf", WD_B, 1, 0],
  ["opt", "txf", WD_B, 1, 0], ["pcr", "txf", WD_B, 0, 5], ["exd", "txf", WD_B, 1, 0], ["sf", "txf", WD_B, 1, 0],
];
const WD_NT = new Set(["bnk", "fng", "ti", "conc", "whale", "liq", "sent", "dir", "top", "fr", "twd", "inst", "fh", "fin", "val", "txd", "txk", "txio", "opt", "exd", "sf"]);
const WD_WN = new Set(["twd", "txd"]);
/* 歡迎頁用短名(.wnm)的列:目錄留長名,清單那一欄窄、長名會把小字擠到第二行 */
const WD_WNM = new Set(["bnk"]);
const WD = { mk: "crypto", all: false, key: "", filled: "", pubAsked: false };

const wdEl = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
/* 列的字:key 先組好再查(check_shell_strings 的閘門只認字面 key;每一列每個欄位兩語齊不齊由 tests/check_shell_welcome_data.js 列舉) */
const wdK = (id, f) => { const k = "wd.r." + id + "." + f; return t(k); };
const wdT = (prefix, name) => { const k = prefix + name; return t(k); };
/* 右欄那句(對比版)。沒登入 / 沒綁卡是一顆文字鈕,開設定 › 帳號與方案(那一頁自己有登入與綁卡鈕、自己的埋點);
   餘額不夠是一句 + 「儲值」鈕;按小時付只有一句(整個歡迎頁唯一出現價格的地方);查不到不講 */
function wdNote(k, v, into) {
  const link = (txt) => { const b = wdEl("button", "btn-quiet", txt); b.type = "button"; b.addEventListener("click", () => planOpen()); return b; };
  if (k === "out") into.appendChild(link(t(v.t ? "wd.note.out" : "wd.note.outNoNum", v)));
  else if (k === "none") into.appendChild(link(t(v.t ? "wd.note.none" : "wd.note.noneNoNum", v)));
  else if (k === "billed") into.append(t(v.r ? "wd.note.billed" : "wd.note.billedNoNum", v));
  else if (k === "nobal") { into.append(t("wd.note.nobal"), "　"); into.appendChild(link(t("wd.note.topup"))); }
}
function wdRow(id) {
  const b = wdEl("button", "wd-row"); b.type = "button"; b.dataset.id = id;
  const mt = [wdK(id, "fq"), wdK(id, "sy")]; if (WD_WN.has(id)) mt.push(wdK(id, "wn"));
  const l1 = wdEl("span", "wd-l1"); l1.append(wdEl("span", "wd-nm", wdK(id, WD_WNM.has(id) ? "wnm" : "nm")), wdEl("span", "wd-mt", mt.join(t("wd.sep"))));
  const l2 = wdEl("span", "wd-l2"), gl = wdEl("span", "wd-gl", "↳"); gl.setAttribute("aria-hidden", "true");
  l2.append(gl, wdEl("span", "wd-tx", wdK(id, "tx")));
  b.append(l1, l2);
  b.addEventListener("click", () => wdFill(wdK(id, "tx")));
  return b;
}
/* 那一句落進輸入框、不送出(同 trade.js trErrAsk):聊天欄收著就先展開;用戶自己打到一半的字留著、接在後面另起一行,
   上一列填進去的那句直接換掉(連點兩列不會疊成兩句) */
function wdFill(text) {
  const ta = $("ta"), cur = ta.value;
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);
  ta.value = cur.trim() && cur !== WD.filled ? cur.replace(/\s+$/, "") + "\n" + text : text;
  WD.filled = ta.value; autosize(); ta.focus();
  trackFeature("welcome_data_row");
}
const wdWel = (mk) => WD_ROWS.filter((r) => r[1] === mk && r[4] > 0).sort((a, b) => a[4] - b[4]);
/* 完整目錄(mockup §2):一張表、依市場分組;「來源」欄只在對比版出(資料已含的人不必分);窄欄時 welcome.css 把列改成一塊一塊 */
function wdCatalog(src) {
  const wrap = wdEl("div", "wd-catw"), tbl = wdEl("table", "wd-cat"), thead = wdEl("thead"), hr = wdEl("tr"), tb = wdEl("tbody");
  const cols = ["data", "fq", "sn"].concat(src ? ["src"] : [], ["us"]);
  cols.forEach((k) => { const th = wdEl("th", "", wdT("wd.h.", k)); th.scope = "col"; hr.appendChild(th); });
  thead.appendChild(hr);
  let last = "";
  WD_ROWS.filter((r) => r[3]).forEach(([id, mk, s]) => {
    if (mk !== last) { last = mk; const g = wdEl("tr", "g"), td = wdEl("td"); td.colSpan = cols.length; td.appendChild(wdEl("span", "wl-cap", wdT("wd.mk.", mk === "txf" ? "txfo" : mk))); g.appendChild(td); tb.appendChild(g); }
    const tr = wdEl("tr"), nm = wdEl("td", "nm", wdK(id, "nm"));
    if (WD_NT.has(id)) nm.appendChild(wdEl("small", "", wdK(id, "nt")));
    tr.append(nm, wdEl("td", "fq", wdK(id, "fq")), wdEl("td", "sn", wdK(id, "sn")));
    if (src) { const td = wdEl("td", "sr"); td.appendChild(wdEl("span", "wd-tag" + (s === WD_P ? " line" : ""), t(s === WD_P ? "wd.src.p" : "wd.src.b"))); tr.appendChild(td); }
    tr.appendChild(wdEl("td", "us", wdK(id, "us")));
    tb.appendChild(tr);
  });
  tbl.append(thead, tb);
  const foot = wdEl("div", "wd-foot"); foot.append(wdEl("p", "", t("wd.foot.1")), wdEl("p", "", t("wd.foot.2")));
  wrap.append(tbl, foot);
  return wrap;
}
/* 重畫。指紋沒變就不碰 DOM(account_status 每一輪回合結束都會重讀,hover 與焦點不能被洗掉)。
   沒登入時那句要的試用天數來自公開價目(app.js pubLoad,一次,拿不到就用不帶數字的句子) */
function wdPaint() {
  const box = $("wl"); if (!box) return;
  const s = hasToken ? acct : null, v = planVars(), m = wdMode(hasToken, s, dataAccessOf(s), v.n);
  if (!hasToken && !pub && !WD.pubAsked) { WD.pubAsked = true; pubLoad().then(() => wdPaint()); }
  const key = JSON.stringify([LANG, m.k, m.cmp, WD.mk, WD.all, v.t, v.r, v.d]);
  if (key === WD.key) return;
  WD.key = key;
  const seg = $("wl-seg"); seg.hidden = WD.all;
  seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mk === WD.mk)));
  const st = $("wl-state"), body = $("wl-body"); st.textContent = ""; body.textContent = "";
  body.classList.toggle("cmp2", m.cmp && !WD.all);
  if (m.k === "trial") st.textContent = t("wd.state.trial", v);
  if (WD.all) { if (m.cmp) wdNote(m.k, v, st); body.appendChild(wdCatalog(m.cmp)); }
  else if (m.cmp) {
    [WD_P, WD_B].forEach((src) => {
      const col = wdEl("div", "wl-col"), h = wdEl("div", "wl-colh"); h.appendChild(wdEl("span", "wl-cap", t(src === WD_P ? "wd.col.free" : "wd.col.blave")));
      if (src === WD_B) { const nt = wdEl("span", "wl-note"); wdNote(m.k, v, nt); if (nt.childNodes.length) h.appendChild(nt); }
      col.appendChild(h);
      wdWel(WD.mk).filter((r) => r[2] === src).forEach((r) => col.appendChild(wdRow(r[0])));   // 三個市場兩欄都有列(tests/check_shell_welcome_data.js 列舉)
      body.appendChild(col);
    });
  } else { const col = wdEl("div", "wl-col"); wdWel(WD.mk).forEach((r) => col.appendChild(wdRow(r[0]))); body.appendChild(col); }
  $("wl-all").textContent = t(WD.all ? "wd.less" : "wd.all");
}
$("wl-seg").addEventListener("click", (e) => { const b = e.target.closest("button[data-mk]"); if (!b || b.dataset.mk === WD.mk) return; WD.mk = b.dataset.mk; wdPaint(); });
$("wl-all").addEventListener("click", () => { WD.all = !WD.all; if (WD.all) trackFeature("welcome_data_all"); wdPaint(); });
