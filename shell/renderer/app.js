/* v1 骨架:偵測 → 三態渲染 → 連結 → 進工作頁。引擎接線是第 4 步。 */
const $ = (id) => document.getElementById(id);

function row({ name, st, stClass, action, cur }) {
  const div = document.createElement("div");
  div.className = "cn-row" + (stClass === "" ? " off" : "") + (cur ? " is-cur" : "");
  const stSpan = stClass === "on"
    ? `<span class="cn-st on"><span class="dot"></span>${st}</span>`
    : `<span class="cn-st ${stClass}">${st}</span>`;
  div.innerHTML = `<span class="n">${name}</span>${stSpan}`;
  // 目前用的那一列:純加粗 + aria-current(canon › Interaction states › Active,
  // 沿用 Dropdown menu Selected 的先例)。原本掛一顆有框的灰徽章,既不是 canon
  // 的 status badge 也不是 mini tag,而且佔在兄弟列按鈕的同一個槽,讀起來像一顆
  // 壞掉的按鈕。
  if (cur) {
    div.setAttribute("aria-current", "true");
    // 按鈕那一格放一行純文字(不是徽章、沒有框):不然「目前用哪個」只剩名字加粗,看不出來
    const c = document.createElement("span"); c.className = "cn-cur"; c.textContent = t("cn.current");
    div.appendChild(c);
  }
  if (action) div.appendChild(action);
  return div;
}
function btn(cls, text, onClick) {
  const b = document.createElement("button");
  b.className = cls; b.type = "button"; b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

/* 焦點跟著「當下真的能用的那條」走,不是固定給 Blave。
   偵測到已登入的本機 agent 時,填色鈕給它、Blave 退成描邊:那條已經可用、零成本、
   而且我們不收 AI 費用;Blave 那條要 OAuth 還要綁卡。把填色永遠釘在 Blave 上,
   讀起來就是「在推自己的付費線」,跟「兩條產品線並行」的定位相反。
   什麼都沒偵測到時 Blave 拿回填色 —— 那時它是唯一走得通的路。 */
let localReady = false;

/* 偵測中的佔位:畫**同樣的兩列**,只把狀態換成「偵測中…」。
   原本是把整個列表換成一行字,卡片會先縮成一行再彈回來——按「重新偵測」時那個
   高度彈跳很吵,而且第一次開啟也會閃一下。列數固定,就沒有 reflow。 */
function detectingRows() {
  const rows = $("agent-rows"); rows.innerHTML = "";
  ["Claude Code", "Codex"].forEach((name) => {
    rows.appendChild(row({ name, st: t("cn.detecting"), stClass: "" }));
  });
}

let lastDetect = null;   // 換語言重畫列用,不重跑偵測
async function detect() {
  detectingRows();
  $("cn-hint").hidden = true;
  lastDetect = await window.blave.detectAgents();
  paintRows(lastDetect);
}
function paintRows(d) {
  const rows = $("agent-rows"); rows.innerHTML = "";
  localReady = !!((d.claude.installed && d.claude.loggedIn) || (d.codex.installed && d.codex.loggedIn));
  // 本機兩顆「連結」一律描邊:填色只給其中一顆,兩顆讀起來像不一樣的東西(Wei 兩次點名)。
  // 唯一的填色留給「登入 Blave」——而且只在沒有任何本機 agent 可用時(paintBlaveBtn)。
  const localBtnCls = () => "btn-out";
  paintBlaveBtn();

  // Claude Code 三態:已登入 / 裝了沒登入 / 沒裝
  if (d.claude.installed && d.claude.loggedIn) {
    rows.appendChild(row({ name: "Claude Code", st: t("st.signedIn"), stClass: "on",
      cur: cur === "claude",
      action: cur === "claude" ? null : btn(localBtnCls(), t("cn.connect"), () => connect("claude", d.claude)) }));
  } else if (d.claude.installed) {
    rows.appendChild(row({ name: "Claude Code", st: t("st.notSignedIn"), stClass: "up",
      action: btn("btn-out", t("cn.signIn"), (e) => localLogin("claude", e.currentTarget)) }));
  } else {
    const r = row({ name: "Claude Code", st: t("st.notFound"), stClass: "" });
    rows.appendChild(r);
  }

  if (d.codex.installed && d.codex.loggedIn) {
    rows.appendChild(row({ name: "Codex", st: t("st.signedIn"), stClass: "on",
      cur: cur === "codex",
      action: cur === "codex" ? null : btn(localBtnCls(), t("cn.connect"), () => connect("codex", d.codex)) }));
  } else if (d.codex.installed) {
    rows.appendChild(row({ name: "Codex", st: t("st.notSignedIn"), stClass: "up",
      action: btn("btn-out", t("cn.signIn"), (e) => localLogin("codex", e.currentTarget)) }));
  } else {
    rows.appendChild(row({ name: "Codex", st: t("st.notFound"), stClass: "" }));
  }
}

/* 連結畫面上「已安裝、未登入」那一列的登入鈕:替用戶跑 CLI 的登入指令(開瀏覽器),
   跑完重新偵測。失敗就把終端機指令寫出來——那條路永遠走得通。 */
const LOGIN_CMD = { claude: "claude auth login", codex: "codex login" };
async function localLogin(kind, b) {
  if (loginPending || oauthPending) return;
  const name = kind === "codex" ? "Codex" : "Claude Code";
  loginPending = kind;
  // 等的那一顆變「取消等待」(不是變灰),其他登入鈕鎖住
  b.textContent = t("login.cancel");
  const cancel = () => window.blave.cancelAgentLogin();
  b.addEventListener("click", cancel);
  $("agent-rows").querySelectorAll("button").forEach((x) => { if (x !== b) x.disabled = true; });
  $("cn-hint").textContent = t("login.opened", { name }); $("cn-hint").hidden = false; srSay($("cn-hint").textContent);
  const r = await window.blave.agentLogin(kind);
  loginPending = null;
  await detect();
  if (!r.ok && !r.cancelled) {
    $("cn-hint").textContent = ""; $("cn-hint").append(t("login.failed", { name }) + " ", cmdLine(kind));
    $("cn-hint").hidden = false; srSay($("cn-hint").textContent);
  }
  // detect() 把整列重畫了,焦點會掉回 body:放回這一列的鈕(成功=「連結」,失敗=「登入」)
  const row = $("agent-rows").children[kind === "codex" ? 1 : 0];
  const nb = row && row.querySelector("button"); if (nb) nb.focus();
}

// 目前連的是哪一種(連結畫面用來標「目前使用」、決定 Blave 那顆鈕的字)。
let cur = null;

async function connect(kind, info) {
  await window.blave.saveConnection({ kind, path: info.path, email: info.email || null });
  cur = kind;
  enterWorkspace(kind, info);
}

let hasToken = false;

/* Blave 那顆鈕:字(登入 / 切換)與階層(填色 / 描邊)都在這裡決定。
   已經有 token 就不必再跑一次 OAuth——切回去是一個選擇,不是重新授權。 */
function paintBlaveBtn() {
  const b = $("btn-blave");
  const sec = document.querySelector(".cn-blave");
  b.hidden = cur === "blave";
  acctPaintAcct();                           // 登出在設定左欄底部的帳號區(登入是帳號的事)
  $("cn-blave-cur").hidden = cur !== "blave";
  $("cn-blave-cur").textContent = t("cn.current");
  sec.classList.toggle("is-cur", cur === "blave");
  if (cur === "blave") { sec.setAttribute("aria-current", "true"); }
  else { sec.removeAttribute("aria-current"); }
  // 設定裡這一列是「換 AI」:沒登入 = 登入並切換;連結畫面還沒有 cur 可保留,照舊「登入 Blave」
  const inSettings = !$("set-scrim").hidden;
  b.textContent = hasToken && cur !== "blave" ? t("cn.blave.switch") : t(inSettings && cur ? "cn.blave.signinSwitch" : "cn.blave.btn");
  b.className = localReady ? "btn-out" : "btn-fill";
}

let csReady = false;
function enterWorkspace(kind, info) {
  $("view-connect").hidden = true;
  $("view-ws").hidden = false;
  cur = kind;
  mpInit(kind);
  stratRefresh(false);
  if (!csReady) { csReady = true; csInit(); }
  acctPrecheck();   // 換 agent 不換對話:只在第一次進工作頁接回
  trInit();         // 自動下單(trade.js):開始輪詢本機交易狀態;重複呼叫只會起一次
  // 從設定 modal 裡換的:留在 modal、重畫那張卡(「目前使用」換列),焦點不搶去輸入框
  if (!$("set-scrim").hidden) { paintBlaveBtn(); detect(); return; }
  autosize();          // 進工作頁先把輸入框高度對齊一行
  $("ta").focus();
}

$("btn-redetect").addEventListener("click", detect);
/* 登出 Blave:刪掉這台電腦上的 token。不問確認——再登入一次就回來了,不是不可逆的事。
   主行程會先請伺服器撤銷這顆 token 再刪本機那份(main.js signOutBlave);撤銷沒成功時提醒
   用戶到 blave.org 設定 › 裝置 補撤。
   正在用 Blave 的話,登出之後這個工作頁就沒有 agent 可用(沒有 token 時引擎會退回本機模式、
   改吃用戶自己的訂閱——那不是他選的),所以連線設定一起清、回連結畫面重選。 */
$("set-acct-out").addEventListener("click", async () => {
  if (running || oauthPending || planLoginBusy) return;
  $("set-acct-out").disabled = true;
  const r = await window.blave.signOutBlave();
  $("set-acct-out").disabled = false;
  hasToken = false; acct = null; planErr = null; planBusy = false;
  // 伺服器那顆沒撤到(離線、逾時):本機已經登出,但要講清楚還差一步、去哪裡補
  const warn = () => { if (!r.revoked) { $("cn-hint").textContent = t("cn.blave.signOutLocalOnly"); $("cn-hint").hidden = false; srSay($("cn-hint").textContent); } };
  // 用自己的 CLI 的人:AI 不受影響,留在原地;帳號區收掉之後焦點退到分類鈕(掉到 BODY 的話 Esc 關不掉設定)
  if (cur !== "blave") {
    paintBlaveBtn(); planWatchIdle(); srSay(t("acct.outDone"));
    const catBtn = document.querySelector('.set-cat[aria-current="true"]'); if (catBtn) catBtn.focus();
    await detect(); warn(); return;
  }
  await window.blave.clearConnection();
  cur = null;
  setClose();
  $("cn-foot").before(document.querySelector(".cn-card"));   // 設定 modal 借走的卡搬回連結畫面
  $("view-ws").hidden = true; $("view-connect").hidden = false;
  paintBlaveBtn(); await detect(); warn();
});
// 等待期間這顆鈕變成「取消」而不是變灰:用戶把瀏覽器分頁關掉之後不會有人按
// 「允許」,沒有取消的話這裡就卡到五分鐘逾時為止。
let oauthPending = false;
$("btn-blave").addEventListener("click", async () => {
  const b = $("btn-blave");
  if (oauthPending) { window.blave.cancelOAuth(); return; }
  // 手上已經有 token:直接切過去,不再開一次瀏覽器。
  if (await window.blave.hasBlaveToken()) {
    await window.blave.saveConnection({ kind: "blave" });
    enterWorkspace("blave", {});
    return;
  }
  const was = b.textContent;
  oauthPending = true;
  b.textContent = t("oauth.cancel");
  $("cn-hint").textContent = t("oauth.opened");
  $("cn-hint").hidden = false;
  try {
    // 同意頁的 <lang> 收 en/zh/cn/…,跟我們的語系代號同一組,直接送。
    await window.blave.startOAuth(LANG);
    acct = null;
    await window.blave.saveConnection({ kind: "blave" });
    enterWorkspace("blave", {});
  } catch (e) {
    const m = (e && e.message) || "";
    // IPC 會把訊息包成「Error invoking remote method …: Error: X」,所以比對記號
    // 而不是整串相等;主行程丟的是穩定代號,在這裡才變成當下語系的句子。
    const code = (m.match(/\b[A-Z][A-Z_]{3,}\b/) || [])[0];
    $("cn-hint").textContent = code && t(code) !== code ? t(code) : (m || t("oauth.failed"));
  } finally {
    oauthPending = false;
    b.textContent = was;
  }
});

/* ── 設定 modal ───────────────────────────────
   左下角的設定鈕直接開(雲端是「更多」選單裡的一項;桌面版只有這一項,不展開)。
   跑到一半整顆 disabled——引擎的環境變數是開子行程那一刻決定的,中途換 agent
   等於在活著的子行程底下抽掉設定。
   「模型接入」不另畫一份:把連結畫面的 .cn-card 搬進來,偵測/連結/OAuth 都是同一套。 */
// 焦點圈在 modal 裡(aria-modal 只管讀屏,不管 Tab)。設定與刪除確認共用。
function trapTab(e, box) {
  if (e.key !== "Tab") return;
  const f = [...box.querySelectorAll("button, select")].filter((x) => !x.disabled && x.offsetParent);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
function setCat(cat) {
  $("set-cats").querySelectorAll(".set-cat").forEach((b) => {
    if (b.dataset.setCat === cat) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
  });
  $("set-modal").querySelectorAll(".set-pane").forEach((p) => { p.hidden = p.dataset.setCat !== cat; });
  // 開到這一類就拿最新的狀態;沒登入的人要的是公開數字
  if (cat === "conn") cxPaint();   // 設定 › 連線(trade.js)
  if (cat === "plan") { planPaint(); if (hasToken) acctCheck(); else pubLoad().then(() => { if (!$("set-plan").hidden) planPaint(); }); }
}
async function setOpen() {
  if (running) return;
  $("set-model").appendChild(document.querySelector(".cn-card"));
  $("set-lang").value = LANG;
  setCat("display");
  const sc = $("set-scrim");
  sc.hidden = false;
  requestAnimationFrame(() => sc.classList.add("open"));   // hidden→顯示的同一幀加 class 不會跑 transition
  $("set-close").focus();
  hasToken = await window.blave.hasBlaveToken();
  paintBlaveBtn();
  detect();
}
function setClose() {
  const sc = $("set-scrim");
  if (sc.hidden) return;
  if (oauthPending || planLoginBusy) window.blave.cancelOAuth();   // 關掉 modal 就沒有地方按取消了
  sc.classList.remove("open");
  sc.hidden = true;
  $("ws-conn").focus();
}
// 選項是各語言自己的名字(不翻譯、不進 .po);中文那個用跳脫碼寫,字串閘門不准
// 程式行出現中文字面。\u7e41\u9ad4\u4e2d\u6587 = 「繁體中文」
const LANGS = [["en", "English"], ["zh", "\u7e41\u9ad4\u4e2d\u6587"]];
LANGS.forEach(([v, name]) => {
  const o = document.createElement("option"); o.value = v; o.textContent = name;
  $("set-lang").appendChild(o);
  // 連結畫面右上的同一組選項,做成 segment(設計師:看得到自己語言那個字,不用開選單)
  const b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "radio");
  b.lang = v === "zh" ? "zh-TW" : v; b.textContent = name; b.dataset.lang = v;
  b.addEventListener("click", () => applyLangChoice(v));
  $("cn-lang").appendChild(b);
});
// 語言:當場換,不重載(重載會丟掉對話)。已經印出來的對話不回頭翻;agent 列用上次
// 偵測結果重畫,不重跑偵測。設定 modal 的 select 與連結畫面的 segment 兩邊同步。
function applyLangChoice(v) {
  // 存不了就只換這一次
  try { localStorage.setItem("ws_lang", v); } catch (_) { /* noop */ }
  setLang(v);
  syncLangControls();
  applyStatic();
  mpPaint(); csRenderHead(); if (!$("cs-list").hidden) csRenderList();
  paintBlaveBtn();
  if (lastDetect) paintRows(lastDetect); else detectingRows();
  stratRefresh(false).then(() => { if (RP.name) stratSelect(RP.name, true); });
  trRepaint();   // 自動下單頁、狀態帶、設定 › 連線(trade.js)
}
// radiogroup 的鍵盤慣例:左右鍵換格並套用(只有兩格,不繞圈也夠)
$("cn-lang").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  const i = LANGS.findIndex(([v]) => v === LANG) + (e.key === "ArrowRight" ? 1 : -1);
  if (i < 0 || i >= LANGS.length) return;
  applyLangChoice(LANGS[i][0]); $("cn-lang").children[i].focus();
});
function syncLangControls() {
  $("set-lang").value = LANG;
  $("cn-lang").querySelectorAll("button").forEach((b) => {
    const on = b.dataset.lang === LANG;
    b.setAttribute("aria-checked", on ? "true" : "false"); b.tabIndex = on ? 0 : -1;
  });
}
$("ws-conn").addEventListener("click", setOpen);
$("set-close").addEventListener("click", setClose);
$("set-scrim").addEventListener("mousedown", (e) => { if (e.target === $("set-scrim")) setClose(); });
$("set-cats").addEventListener("click", (e) => {
  const b = e.target.closest(".set-cat"); if (b) setCat(b.dataset.setCat);
});
$("set-scrim").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); setClose(); return; }
  trapTab(e, $("set-modal"));
});
$("set-lang").addEventListener("change", () => applyLangChoice($("set-lang").value));
$("btn-send").addEventListener("click", sendDraft);
// 注音/日文選字時的 Enter 是「確定候選字」,不是送出。逐字照 web 工作頁
// (workspace.html:21913-21933)的三道守衛:Safari 會在這個 keydown 之前就發
// compositionend,所以 composing 已經是 false —— 那顆 Enter 帶 keyCode 229
// (真正的送出 Enter 是 13)。少任何一道,打注音的人每選一次字就誤送一次。
let composing = false;
$("ta").addEventListener("compositionstart", () => { composing = true; });
$("ta").addEventListener("compositionend", () => { composing = false; });
$("ta").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !composing && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    sendDraft();
  }
});

/* ── 輸入框自動長高 ───────────────────────────────
   照 web 工作頁的 autosize()(workspace.html:21908):先歸零再量 scrollHeight、
   上限 120px(CSS 的 max-height 同值,約 6 行 13px·1.5)。超過就自己捲。 */
const TA_MAX = 120;
function autosize() {
  const ta = $("ta");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, TA_MAX) + "px";
}
$("ta").addEventListener("input", autosize);


/* ── model / effort 選擇器 ─────────────────────────────
   一顆觸發鈕、一個面板:上半選 model、下半是 effort 的分段軌。軌的格數**直接由所選
   model 的支援清單長出來**,所以選不到不存在的組合(Cline 有過「換 model 後舊的
   thinking 設定殘留、打出 API error」的 bug;把 effort 烤進 model 名的做法則是被
   Cursor 的用戶罵到改掉的)。
   換 model 時 effort 能留就留,留不住就落回該 model 的預設——面板不自動關,軌的格數與
   選中格當場跟著變,看得到。
   選擇按引擎各記一組(model + 每個 model 各自的 effort),存本機、跨重啟保留。 */
const MP = { kind: null, models: [], prefs: {}, model: null };

function mpLevel(lv) { const k = "lv." + lv; const v = t(k); return v === k ? lv.charAt(0).toUpperCase() + lv.slice(1) : v; }
function mpCur() { return MP.models.find((m) => m.id === MP.model) || null; }
function mpEffort() {
  const m = mpCur(); if (!m || !m.efforts.length) return null;
  const saved = ((MP.prefs[MP.kind] || {}).efforts || {})[m.id];
  return m.efforts.includes(saved) ? saved : (m.defaultEffort || m.efforts[0]);
}
function mpSave() {
  const slot = MP.prefs[MP.kind] || (MP.prefs[MP.kind] = { efforts: {} });
  slot.model = MP.model; slot.efforts = slot.efforts || {};
  window.blave.saveModelPrefs(MP.prefs);
}

/* 這個帳號用不了的 model:記在該引擎的 prefs 裡,面板上標出來(不鎖——訂閱升級之後
   就能用了,鎖死的話用戶得去刪檔)。選擇換回預設,下一句話才不會再失敗一次。 */
function mpMarkUnavailable(id) {
  const slot = MP.prefs[MP.kind]; if (!slot) return;
  slot.unavailable = Array.isArray(slot.unavailable) ? slot.unavailable : [];
  if (!slot.unavailable.includes(id)) slot.unavailable.push(id);
  if (MP.model === id && MP.defaultModel && MP.defaultModel !== id) MP.model = MP.defaultModel;
  mpSave(); mpPaint();
}
/* 用那個 model 成功跑完一輪 = 現在能用了(升級了方案),把標記拿掉。 */
function mpMarkWorks(id) {
  const slot = MP.prefs[MP.kind];
  if (!slot || !Array.isArray(slot.unavailable) || !slot.unavailable.includes(id)) return;
  slot.unavailable = slot.unavailable.filter((x) => x !== id);
  mpSave(); mpPaint();
}

/* 進工作頁 / 換引擎時呼叫。型錄拿不到(沒裝、沒 token、離線)就整顆不畫——
   那時 runTurn 不帶任何旗標,行為跟沒有這個功能之前一樣。 */
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

async function mpInit(kind) {
  // 先同步清空:型錄最慢要 15 秒才回來(Blave AI 走網路),這期間按送出不能把**上一個
  // 引擎**的 model 送過去(Codex 的 gpt-5.5 送給 Blave 的 proxy → 該輪失敗)。
  MP.kind = kind; MP.models = []; MP.model = null; MP.defaultModel = null;
  $("mp").hidden = true;
  const [opt, prefs] = await Promise.all([window.blave.modelOptions(kind), window.blave.loadModelPrefs()]);
  // 舊引擎的型錄晚到(快速切換)→ 丟掉,不然會蓋掉新引擎的、還被 mpSave 寫進錯的欄位
  if (MP.kind !== kind) return;
  MP.models = (opt && opt.models) || [];
  MP.defaultModel = (opt && opt.defaultModel) || null;
  // model-prefs.json 是磁碟上的檔案:內容壞掉(`"x"`、`[]`、`{"codex":"abc"}`)時
  // 正規化成空的,而不是讓 effort 怎麼點都沒反應、要刪檔才會好。
  MP.prefs = isObj(prefs) ? prefs : {};
  if (!isObj(MP.prefs[kind])) MP.prefs[kind] = {};
  if (!isObj(MP.prefs[kind].efforts)) MP.prefs[kind].efforts = {};
  $("mp").hidden = MP.models.length === 0;
  if (!MP.models.length) { MP.model = null; return; }
  const saved = (MP.prefs[kind] || {}).model;
  MP.model = MP.models.some((m) => m.id === saved) ? saved : (opt.defaultModel || MP.models[0].id);
  mpPaint();
}

function mpPaint() {
  const m = mpCur(); if (!m) return;
  const eff = mpEffort();
  $("mp-t-model").textContent = m.name;
  $("mp-t-effort").textContent = eff ? "· " + mpLevel(eff) : "";
  $("mp-trigger").setAttribute("aria-label",
    eff ? t("mp.aria", { model: m.name, effort: mpLevel(eff) }) : t("mp.ariaNoEffort", { model: m.name }));

  const box = $("mp-models"); box.textContent = "";
  box.setAttribute("aria-label", t("mp.model"));
  MP.models.forEach((x) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "mp-row"; b.setAttribute("role", "radio");
    const on = x.id === MP.model;
    b.setAttribute("aria-checked", on ? "true" : "false"); b.tabIndex = on ? 0 : -1;
    const nm = document.createElement("span"); nm.textContent = x.name; b.appendChild(nm);
    if (((MP.prefs[MP.kind] || {}).unavailable || []).includes(x.id)) {
      b.classList.add("is-na");
      const na = document.createElement("span"); na.className = "mp-def"; na.textContent = t("mp.na"); b.appendChild(na);
    }
    if (x.id === MP.defaultModel) { const d = document.createElement("span"); d.className = "mp-def"; d.textContent = t("mp.default"); b.appendChild(d); }
    b.addEventListener("click", () => mpPickModel(x.id));
    box.appendChild(b);
  });

  const rail = $("mp-rail"); rail.textContent = "";
  rail.setAttribute("aria-label", t("mp.effort"));
  const has = m.efforts.length > 0;
  rail.hidden = !has; $("mp-effort-cap").hidden = !has;
  m.efforts.forEach((lv) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "mp-seg"; b.setAttribute("role", "radio");
    const on = lv === eff;
    b.setAttribute("aria-checked", on ? "true" : "false"); b.tabIndex = on ? 0 : -1;
    b.textContent = mpLevel(lv);
    b.addEventListener("click", () => mpPickEffort(lv));
    rail.appendChild(b);
  });

  // 說明句(這個 model 的預設是什麼、越高代表什麼)是在解釋術語 → 進 tooltip。
  // 面板上那一行只留給一種**狀態**:這個 model 根本沒有 effort。
  $("mp-tipbox").textContent = has
    ? t("mp.cap", { model: m.name, level: mpLevel(m.defaultEffort || m.efforts[0]) }) : "";
  const note = $("mp-note");
  note.textContent = has ? "" : t("mp.none");
  note.hidden = !note.textContent;
}

function mpPickModel(id) {
  if (id === MP.model) return;
  const before = mpEffort();
  MP.model = id;
  const m = mpCur();
  const slot = MP.prefs[MP.kind] || (MP.prefs[MP.kind] = { efforts: {} });
  slot.efforts = slot.efforts || {};
  // 這個 model 沒選過 effort:前一個 model 的值它也支援就沿用,不支援就由 mpEffort() 落回預設
  if (!slot.efforts[id] && before && m.efforts.includes(before)) slot.efforts[id] = before;
  mpSave(); mpPaint();
  // 滑鼠開的不把焦點丟到選中列:前一個焦點是輸入框(永遠算 focus-visible),程式轉移
  // 過去的焦點會繼承它,選中列就平白多一圈白框。鍵盤開的才需要焦點落在列上。
  const cur = $("mp-models").querySelector('[aria-checked="true"]'); if (cur && !viaMouse) cur.focus();
}
function mpPickEffort(lv) {
  const slot = MP.prefs[MP.kind] || (MP.prefs[MP.kind] = { efforts: {} });
  slot.efforts = slot.efforts || {}; slot.efforts[MP.model] = lv;
  mpSave(); mpPaint();
  const cur = $("mp-rail").querySelector('[aria-checked="true"]'); if (cur) cur.focus();
}

/* 選了立即生效,面板**不自動關**(要讓人看到軌變了)。關閉 = Esc / 點面板外 / 再按
   觸發鈕,焦點一律回觸發鈕。 */
function mpOpen(viaMouse) {
  if (running) return;
  $("mp-panel").hidden = false; $("mp").classList.add("is-open");
  $("mp-trigger").setAttribute("aria-expanded", "true");
  // 滑鼠開的不把焦點丟到選中列:前一個焦點是輸入框(永遠算 focus-visible),程式轉移
  // 過去的焦點會繼承它,選中列就平白多一圈白框。鍵盤開的才需要焦點落在列上。
  const cur = $("mp-models").querySelector('[aria-checked="true"]'); if (cur && !viaMouse) cur.focus();
}
function mpClose(refocus) {
  if ($("mp-panel").hidden) return;
  $("mp-panel").hidden = true; $("mp").classList.remove("is-open");
  $("mp-trigger").setAttribute("aria-expanded", "false");
  if (refocus) $("mp-trigger").focus();
}
// detail 0 = 鍵盤(Enter/Space)觸發的 click
$("mp-trigger").addEventListener("click", (e) => ($("mp-panel").hidden ? mpOpen(e.detail > 0) : mpClose(true)));
$("mp-trigger").addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" && $("mp-panel").hidden) { e.preventDefault(); mpOpen(); }
});
document.addEventListener("mousedown", (e) => { if (!$("mp").contains(e.target)) mpClose(false); });
// APG radio group:方向鍵在組內移動**並選取**,Tab 在 model 組 ↔ effort 組之間切換
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("mp-panel").hidden) { e.preventDefault(); mpClose(true); }
});
$("mp-panel").addEventListener("keydown", (e) => {
  const group = e.target.closest('[role="radiogroup"]'); if (!group) return;
  const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]; if (!d) return;
  e.preventDefault();
  const items = [...group.querySelectorAll('[role="radio"]')];
  const next = items[(items.indexOf(e.target) + d + items.length) % items.length];
  if (next) next.click();
});


/* ── 策略:sidebar + 報告 ─────────────────────────────
   資料就在本機(~/Blave/workspace/strategies/),主行程直接讀資料夾,沒有 api 這一層。
   sidebar 每輪結束重讀;agent 這一輪剛建或剛改的那支自動選中——中欄就從 welcome
   變成報告,用戶不用自己去點。
   報告三個分頁:回測 / 進出場 由各自的檔負責畫(window.BlaveReport),這裡只管
   選中、切分頁、程式碼分頁。 */
const RP = { list: [], name: null, data: null, tab: "bt", drawn: {} };

async function stratRefresh(selectTouched) {
  const before = new Map(RP.list.map((x) => [x.name, x.mtime]));
  RP.list = await window.blave.listStrategies();
  const box = $("strat-list");
  box.querySelectorAll(".strat-wrap").forEach((n) => n.remove());
  $("strat-empty").hidden = RP.list.length > 0;
  RP.list.forEach((x) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "strat-row";
    if (x.name === RP.name) b.setAttribute("aria-current", "true");
    b.dataset.name = x.name;
    const nm = document.createElement("span"); nm.className = "strat-name";
    nm.textContent = x.displayName || x.name; nm.title = x.name;
    b.append(nm);
    b.addEventListener("click", () => stratSelect(x.name));
    // 列尾是刪除鈕,不是 Sharpe(Wei):數字在報告裡就有,清單上要的是能整理。
    // 按鈕不能包按鈕,所以外面多一層 wrap,刪除鈕絕對定位在列尾(同對話清單)。
    const wrap = document.createElement("div"); wrap.className = "strat-wrap cs-row";
    const del = armedDelete(wrap, t("strat.del"), async () => {
      if (await window.blave.deleteStrategy(x.name)) stratRefresh(false);
    });
    del.disabled = running;
    wrap.append(b, del);
    box.appendChild(wrap);
  });
  // 這一輪動過的(新出現、或 mtime 變了)→ 選最近的那支
  if (selectTouched) {
    const touched = RP.list.find((x) => before.get(x.name) !== x.mtime);
    if (touched) { await stratSelect(touched.name, true); return; }
  }
  // 選中的那支被刪了 → 回 welcome
  if (RP.name && !RP.list.some((x) => x.name === RP.name)) stratSelect(null);
}

async function stratSelect(name, force) {
  if (name === RP.name && !force) return;
  if (name) trLeave();   // 中欄一次只有一個視圖:選了策略就離開自動下單頁(trade.js)
  RP.name = name; RP.drawn = {};
  $("strat-list").querySelectorAll(".strat-row").forEach((b) => {
    if (b.dataset.name === name) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  });
  if (!name) { RP.data = null; $("rp").hidden = true; $("main-empty").hidden = false; return; }
  RP.data = await window.blave.loadStrategy(name);
  if (RP.name !== name) return;                 // 等資料的時候用戶又點了別支
  if (!RP.data) { stratSelect(null); return; }
  $("main-empty").hidden = true; $("rp").hidden = false;
  $("rp-name").textContent = RP.data.displayName || name;
  // 只放說明,不附資料夾代號(Wei):代號滑過 sidebar 那一列的 title 看得到
  $("rp-desc").textContent = RP.data.description || "";
  $("rp-name").title = $("rp-name").textContent; $("rp-desc").title = RP.data.description || "";   // 單行截斷,全文放 title
  $("rp-code-pre").textContent = RP.data.code || "";
  rpShowTab(RP.data.stats ? RP.tab : "code");   // 還沒回測過 → 只有程式碼可看
}

/* 分頁第一次被看到才畫(進出場那張 K 線圖不便宜);同一支策略切回來不重畫。 */
function rpShowTab(tab) {
  RP.tab = tab;
  const has = !!(RP.data && RP.data.stats);
  $("rp-tabs").querySelectorAll(".rp-tab").forEach((b) => {
    const on = b.dataset.tab === tab;
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.disabled = !has && b.dataset.tab !== "code";
  });
  for (const k of ["bt", "tr", "code"]) $("rp-" + k).hidden = k !== tab;
  if (!has || RP.drawn[tab]) return;
  RP.drawn[tab] = true;
  const R = window.BlaveReport || {};
  if (tab === "bt" && R.renderBacktest) R.renderBacktest($("rp-bt"), RP.data.stats);
  if (tab === "tr" && R.renderTrades) R.renderTrades($("rp-tr"), RP.data.stats);
}
$("rp-tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".rp-tab"); if (b && !b.disabled) rpShowTab(b.dataset.tab);
});

/* ── 第 4 步:真的接線 ───────────────────────────── */
/* ── 對話(session)───────────────────────────────
   照雲端工作頁的對話列:清單 / 標題 / 新對話。逐字稿與長對話的摘要壓縮都是 runtime 的事
   (state/session.db),這裡只管三件:id 不再每次載入重抽(原本重開就換一條,舊對話還在
   db 裡但沒人讀)、把舊對話畫回來、列清單切換與刪除。
   第一版一次只跑一條:回合進行中清單與新對話都鎖住(csLock)。 */
const csNewId = () => "desktop-" + Math.random().toString(36).slice(2, 10).padEnd(8, "0");
let sessionId = csNewId();
let csTitle = "";          // 目前這條的標題(第一句話);空 = 還沒講過話的新對話
let csItems = [];

function csRenderHead() {
  $("cs-title").textContent = csTitle || t("cs.new");
  $("cs-title").title = csTitle || "";
}
function csRemember() {
  // 記不住就是下次開新對話,不擋
  try { localStorage.setItem("ws_session", sessionId); } catch (_) { /* noop */ }
}
function csLock(on) {
  $("cs-toggle").disabled = on; $("cs-new").disabled = on;
  if (on) csShowList(false);
}
function csClearChat() {
  $("chat-scroll").innerHTML = "";
  liveBubble = null; busy = null;
  acctCard = null; creditCards.length = 0; dataCard = null;   // 卡片跟著聊天欄一起清掉
}
function csStartNew() {
  sessionId = csNewId(); csTitle = "";
  csRemember(); csClearChat(); csRenderHead(); csShowList(false);
  // 起手範例只在「沒選策略的歡迎畫面 + 還沒講過話」時有意義
  $("chat-eg").hidden = false;
  $("ta").focus();
}
async function csOpen(id) {
  const turns = await window.blave.loadSession(id);
  if (!turns.length) { csStartNew(); return; }
  sessionId = id; csRemember(); csClearChat();
  csTitle = (turns.find((x) => x.role === "user") || {}).content || "";
  // 舊回合只有文字(工具收據與思考過程沒有存),照角色畫回去;圖另外存在
  // state/chat-images/,照時間插回去——它落在那一輪的提問與回覆之間,跟當時看到的順序一樣
  const imgs = await window.blave.loadSessionImages(id);
  turns.map((x) => ({ ts: x.ts, turn: x })).concat(imgs.map((x) => ({ ts: x.ts, img: x })))
    .sort((a, b) => a.ts - b.ts)
    .forEach((x) => (x.img ? addImage(x.img.src, x.img.caption) : addMsg(x.turn.role === "user" ? "you" : "ai", x.turn.content)));
  $("chat-eg").hidden = true;
  csRenderHead(); csShowList(false); scrollChat();
}
function csTime(sec) {
  return new Date(sec * 1000).toLocaleString(LANG === "zh" ? "zh-TW" : "en",
    { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
/* 列尾的兩段式刪除鈕(對話清單與策略清單共用):✕ → 同一格變成「刪除?」,再按一次才
   執行;滑開或失焦就復原。不用原生 confirm——它會把整個視窗卡住,樣式也不是我們的。 */
function armedDelete(row, label, onConfirm, direct) {
  const del = document.createElement("button");
  del.type = "button"; del.className = "cs-del"; del.setAttribute("aria-label", label);
  const X = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  del.innerHTML = X;
  const disarm = () => { del.classList.remove("is-armed"); del.innerHTML = X; };
  del.addEventListener("click", async () => {
    if (direct) { onConfirm(del); return; }     // 確認交給 modal,列內不武裝
    if (!del.classList.contains("is-armed")) { del.classList.add("is-armed"); del.textContent = t("cs.delConfirm"); return; }
    disarm(); await onConfirm();
  });
  row.addEventListener("mouseleave", disarm);
  del.addEventListener("blur", disarm);
  return del;
}
function csRow(m) {
  const row = document.createElement("div"); row.className = "cs-row";
  const item = document.createElement("button");
  item.type = "button"; item.className = "cs-item";
  if (m.id === sessionId) item.setAttribute("aria-current", "true");
  const name = document.createElement("span"); name.className = "cs-name"; name.textContent = m.title || t("cs.new");
  const meta = document.createElement("span"); meta.className = "cs-meta"; meta.textContent = csTime(m.last);
  item.append(name, meta);
  item.addEventListener("click", () => { if (m.id === sessionId) csShowList(false); else csOpen(m.id); });
  // 刪對話救不回來(直接從 session.db 刪)→ 跳確認框;刪策略是進垃圾桶,維持列內兩段式
  // (設計師:分界只有一個——可不可逆)
  const del = armedDelete(row, t("cs.del"), (btn) => delConfirm(m, btn), true);
  row.append(item, del);
  return row;
}
/* 刪對話的確認框。開啟時焦點在「取消」——不可逆動作的 Enter 不能直接刪;
   Esc / 點框外 / 右上 ✕ 都等於取消。 */
let delCtx = null;
function delConfirm(m, opener) {
  const cur = m.id === sessionId;
  const name = (m.title || t("cs.new")).slice(0, 40) + ((m.title || "").length > 40 ? "…" : "");
  $("del-title").textContent = cur ? t("del.titleCur") : t("del.title", { title: name });
  $("del-body").className = "del-body";
  $("del-body").textContent = t(cur ? "del.bodyCur" : "del.body");
  $("del-ok").textContent = t("del.ok");
  delCtx = { m, opener };
  $("view-ws").inert = true;
  const sc = $("del-scrim"); sc.hidden = false;
  requestAnimationFrame(() => sc.classList.add("open"));
  $("del-cancel").focus();
}
/* 同一個確認框,第二個用途:花錢的動作(啟動雲端方案)。不養第二份 DOM——標題、幾段字、主鈕的字
   與要做的事由呼叫端給;其餘(焦點預設在「取消」、Esc / 點框外 / ✕ = 取消、Tab 圈在框內)完全沿用。
   設定 modal 留在底下不關,確認框蓋在上面;取消後焦點回到開它的那顆鈕。 */
/* 第三個用途:自動下單的啟動/暫停/儲存金額(trade.js)。多三個選用參數,不給就跟原本一模一樣:
   alt = { label, onOk, danger } 第二動作鈕(排在取消與主要鈕之間;danger = 紅字,同雲端 .cf-alt);
   mark = 標題左邊的帳戶記號文字(「模擬」);extra = 接在段落後面的一個 DOM 節點(呼叫端自己用 textContent 建)。 */
function confirmBox({ title, lines, ok, onOk, opener, alt, mark, extra }) {
  $("del-title").textContent = title;
  const body = $("del-body"); body.className = "del-body lines"; body.textContent = "";
  lines.forEach((x) => { const p = document.createElement("p"); p.textContent = x; body.appendChild(p); });
  if (extra) body.appendChild(extra);
  $("del-ok").textContent = ok;
  $("del-mark").hidden = !mark; $("del-mark").textContent = mark || "";
  $("del-alt").hidden = !alt; $("del-alt").textContent = alt ? alt.label : "";
  $("del-alt").classList.toggle("cf-alt-danger", !!(alt && alt.danger));
  $("del-modal").classList.toggle("has-alt", !!alt);
  delCtx = { custom: true, onOk, onAlt: alt && alt.onOk, opener };
  $("view-ws").inert = true; $("set-scrim").inert = true;
  const sc = $("del-scrim"); sc.hidden = false;
  requestAnimationFrame(() => sc.classList.add("open"));
  $("del-cancel").focus();
}
function delClose(deleted) {
  const sc = $("del-scrim"); if (sc.hidden) return;
  sc.classList.remove("open"); sc.hidden = true;
  $("view-ws").inert = false; $("set-scrim").inert = false;
  const c = delCtx; delCtx = null;
  $("del-alt").hidden = true; $("del-mark").hidden = true; $("del-modal").classList.remove("has-alt");   // 下一個用這個框的人(刪對話)不該看到上一個的第二顆鈕
  if (deleted) $("cs-newrow").focus();
  else if (c && c.opener && c.opener.isConnected) c.opener.focus();
}
$("del-cancel").addEventListener("click", () => delClose(false));
$("del-close").addEventListener("click", () => delClose(false));
$("del-scrim").addEventListener("mousedown", (e) => { if (e.target === $("del-scrim")) delClose(false); });
$("del-scrim").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); delClose(false); return; }
  trapTab(e, $("del-modal"));
});
$("del-alt").addEventListener("click", () => { const go = delCtx && delCtx.onAlt; delClose(false); if (go) go(); });
$("del-ok").addEventListener("click", async () => {
  if (delCtx && delCtx.custom) { const go = delCtx.onOk; delClose(false); go(); return; }
  const m = delCtx && delCtx.m; if (!m) return;
  if (!(await window.blave.deleteSession(m.id))) { delClose(false); return; }
  if (m.id === sessionId) { csStartNew(); csShowList(true); } else await csRenderList();
  delClose(true);
});
async function csRenderList() {
  csItems = await window.blave.listSessions();
  const box = $("cs-rows"); box.innerHTML = "";
  csItems.forEach((m) => box.appendChild(csRow(m)));
}
function csShowList(on) {
  $("cs-list").hidden = !on;
  $("cs-head").classList.toggle("is-list", on);
  $("cs-toggle").setAttribute("aria-expanded", on ? "true" : "false");
  $("cs-toggle").setAttribute("aria-label", t(on ? "cs.back" : "cs.all"));
  // 被清單蓋住的聊天本體退出 Tab 順序與輔具樹
  $("chat-scroll").inert = on; document.querySelector(".chat-input-wrap").inert = on;
  if (on) csRenderList();
}
$("cs-toggle").addEventListener("click", () => csShowList($("cs-list").hidden));
$("cs-new").addEventListener("click", csStartNew);
$("cs-newrow").addEventListener("click", csStartNew);
$("cs-list").addEventListener("keydown", (e) => { if (e.key === "Escape") { csShowList(false); $("cs-toggle").focus(); } });
/* 開場:接回上次那條。db 裡找不到(被刪了、或還沒講過話)就是一條新的 */
async function csInit() {
  let saved = null;
  try { saved = localStorage.getItem("ws_session"); } catch (_) { /* noop */ }
  if (saved && /^desktop-[a-z0-9]{4,16}$/.test(saved)) await csOpen(saved);
  else csRenderHead();
}
let running = false;
let liveBubble = null;

function scrollChat() { $("chat-scroll").scrollTop = $("chat-scroll").scrollHeight; }

// 起手範例:點了直接送,不要只是把字填進去讓人再按一次。
$("chat-eg").addEventListener("click", () => {
  $("ta").value = t("ws.chatExample");
  autosize();
  sendDraft();
});

/* ── agent 回覆的顯示 ─────────────────────────────────
   原文留在 el._raw(串流是一段一段接上來的),畫面由 paintAi 重畫。做兩件事:
   1. 拿掉給外殼看的標記(`<blave-card:…/>`,runtime 要 agent 在「拿不到 Blave 資料」時附上;
      串流到一半的半截標記也先藏起來),有標記就記在 el._cards。
   2. 最小的行內 markdown:**粗體** 與 `程式碼`。一律用 DOM 節點組,不把 LLM 的字串當 HTML。
      其餘(清單、標題)照原文顯示——.msg.ai 是 pre-wrap,換行與縮排本來就在。 */
const CARD_TAG = /<blave-card:([a-z-]+)\/>/g;
/* 純函式(tests/check_shell_paint.js 直接測它):原文 → { cards, parts }。parts 只有三種:
   { text } / { code } / { strong }。``` 圍欄裡的東西一個字都不動——`f(**a, **b)`、`2**3` 被當成粗體
   吃掉星號的話,用戶照畫面抄策略碼會抄錯。`live` = 還在串流:尾端半截的標記先藏起來;回合結束後
   用 live=false 重畫一次,真的以 `<` 結尾的回覆才不會被永久吃掉。 */
function aiParts(raw, live) {
  const cards = [];
  let text = String(raw).replace(CARD_TAG, (_m, name) => { cards.push(name); return ""; });
  if (live) {
    const lt = text.lastIndexOf("<");
    if (lt >= 0 && text.length - lt <= 40 && "<blave-card:".startsWith(text.slice(lt, lt + 12)) && !text.slice(lt).includes(">")) text = text.slice(0, lt);
  }
  if (cards.length) text = text.replace(/\s+$/, "");
  const parts = [];
  text.split(/(```[\s\S]*?(?:```|$))/g).forEach((seg, i) => {
    if (!seg) return;
    if (i % 2) { parts.push({ text: seg }); return; }            // 圍欄內:原樣
    seg.split(/(`[^`\n]+`|\*\*[^*\n]+?\*\*)/g).forEach((part) => {
      if (!part) return;
      const code = /^`([^`\n]+)`$/.exec(part), bold = /^\*\*([^*\n]+?)\*\*$/.exec(part);
      parts.push(code ? { code: code[1] } : bold ? { strong: bold[1] } : { text: part });
    });
  });
  return { cards, parts };
}
function paintAi(el, raw, live) {
  el._raw = raw;
  const r = aiParts(raw, live !== false);
  el._cards = r.cards;
  el.textContent = "";
  r.parts.forEach((p) => {
    if (p.code != null) { const c = document.createElement("code"); c.textContent = p.code; el.appendChild(c); }
    else if (p.strong != null) { const b = document.createElement("strong"); b.textContent = p.strong; el.appendChild(b); }
    else el.appendChild(document.createTextNode(p.text));
  });
}

function addMsg(cls, text) {
  const el = document.createElement("div");
  el.className = "msg " + cls;
  if (cls === "you") {
    // 泡泡樣式掛在子元素上(app.css `.msg.you .bubble`);.msg.you 自己只負責靠右
    const b = document.createElement("div");
    b.className = "bubble"; b.textContent = text;
    el.appendChild(b);
  } else if (cls === "ai") {
    paintAi(el, text, false);
  } else {
    el.textContent = text;
    if (cls === "sys") srSay(text);
  }
  $("chat-scroll").appendChild(el);
  busyPin();            // 等待指示器永遠留在最後一列
  scrollChat();
  return el;
}

/* 圖片放大(lightbox):點圖開、點任何地方 / Esc / ✕ 關。焦點關掉後回到原本那張圖。 */
let lbOpener = null;
function lbOpen(src, alt, opener) {
  lbOpener = opener;
  $("lb-img").src = src; $("lb-img").alt = alt;
  $("view-ws").inert = true;
  const sc = $("lb-scrim"); sc.hidden = false;
  requestAnimationFrame(() => sc.classList.add("open"));
  $("lb-close").focus();
}
function lbClose() {
  const sc = $("lb-scrim"); if (sc.hidden) return;
  sc.classList.remove("open"); sc.hidden = true; $("lb-img").removeAttribute("src");
  $("view-ws").inert = false;
  if (lbOpener && lbOpener.isConnected) lbOpener.focus();
  lbOpener = null;
}
$("lb-scrim").addEventListener("click", lbClose);
$("lb-scrim").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); lbClose(); }
  if (e.key === "Tab") e.preventDefault();      // 裡面只有一顆鈕,焦點不離開
});

/* agent 送來的圖(回測權益圖、熱圖、它自己畫的)。src 一律是主行程給的 data: URL。 */
function addImage(src, caption) {
  const el = document.createElement("figure");
  el.className = "msg img";
  const im = document.createElement("img");
  im.src = src; im.alt = caption || t("chat.imageAlt");
  im.addEventListener("load", scrollChat);       // 解碼完才知道高度
  // 聊天欄最窄 320,圖上的軸字看不清楚——點一下放大看原尺寸。包成 button 才有鍵盤可達
  const zb = document.createElement("button");
  zb.type = "button"; zb.className = "img-zoom"; zb.setAttribute("aria-label", t("chat.imageZoom"));
  zb.appendChild(im);
  zb.addEventListener("click", () => lbOpen(src, im.alt, zb));
  el.appendChild(zb);
  if (caption) { const c = document.createElement("figcaption"); c.textContent = caption; el.appendChild(c); }
  $("chat-scroll").appendChild(el);
  busyPin(); scrollChat();
  return el;
}

/* ── 等待指示器(送出 → 回合結束) ──────────────────
   搬 web 工作頁思考列的 v1 子集:tick 條 + 動詞 + 秒數。行為對齊
   workspace.html 的 showActivity / addTick / endTurn:
   ・送出就長出來(不等 started,把引擎暖機那段也蓋住,同 web 遮 VM round-trip)
   ・工具開跑 → 動詞換「執行中 · 第 N 步」
   ・回覆開始串流 → 隱藏(web 對「沒有可展開內容」的思考列就是隱藏)
   ・下一個 thinking / tool 事件 → 原地復活
   ・回合結束 → **留下來**當可展開的「思考過程」標記(同 web 的 P2)。展開面板裡
     上面是工具收據(一次呼叫一列:記號 + 動詞 + 受詞 + 耗時),下面是思考文字。
     沒有任何工具也沒有思考的回合才整塊移除。
   原本每次工具呼叫都往聊天欄塞一行「● Bash」,一輪跑十幾個工具就把回覆淹掉。 */
const TICK_WINDOW = 8;   // 窗口內看得到的格數
const TICK_PITCH = 6;    // 每格 px(2px 條 + 4px 間距),與 CSS 同值
let busy = null;

function motionBaseMs() {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--motion-base").trim();
  if (v.endsWith("ms")) return parseFloat(v) || 180;
  if (v.endsWith("s")) return (parseFloat(v) || 0.18) * 1000;
  return 180;
}
function reducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function busyPin() {
  if (busy && busy.el.parentNode) $("chat-scroll").appendChild(busy.el);
}
function busyTick() {
  const strip = busy && busy.ticksIn;
  if (!strip) return;
  strip.appendChild(document.createElement("i"));
  requestAnimationFrame(() => {
    if (!busy || busy.ticksIn !== strip) return;
    const kids = strip.children;
    for (let i = 0; i < kids.length; i++) {
      const age = kids.length - 1 - i;
      kids[i].style.opacity = age === 0 ? "1" : age <= 2 ? "0.55" : age <= 6 ? "0.26" : "0.12";
    }
    const overflow = kids.length - TICK_WINDOW;
    if (overflow > 0) strip.style.transform = `translateX(${-(overflow * TICK_PITCH)}px)`;
  });
}
function busyElapsed() {
  if (!busy) return;
  busy.elapsed.textContent = Math.max(0, Math.floor((Date.now() - busy.start) / 1000)) + "s";
}
function busySet(verb) {
  if (!busy) return;
  busy.verb.textContent = verb;
  busy.el.hidden = false;
  busyPin(); scrollChat();
}
function busyStart() {
  if (busy) { busySet(t("turn.thinking")); return; }
  const el = document.createElement("div");
  el.className = "think-indicator";
  // 送出到第一個字之間唯一的回饋,所以要讓輔助科技讀到;polite 不打斷回覆
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  // 整輪只有這一顆 <button>(不在思考 ↔ 工具之間換節點,換了會 reflow)
  const head = document.createElement("button");
  head.type = "button";
  head.className = "think-head no-toggle";
  head.setAttribute("aria-expanded", "false");
  const ticks = document.createElement("span");
  ticks.className = "think-ticks"; ticks.setAttribute("aria-hidden", "true");
  const ticksIn = document.createElement("span");
  ticksIn.className = "think-ticks-in";
  ticks.appendChild(ticksIn);
  const verb = document.createElement("span");
  verb.className = "think-verb";
  const elapsed = document.createElement("span");
  // 每秒變的數字在 live region 裡會被逐秒念出來;狀態由動詞承載,秒數只給眼睛
  elapsed.className = "think-elapsed"; elapsed.setAttribute("aria-hidden", "true");
  const chev = document.createElement("span");
  chev.className = "think-chev"; chev.setAttribute("aria-hidden", "true");
  head.append(ticks, verb, elapsed, chev);
  // 折疊面板:grid-rows 0fr↔1fr(動到真實高度,不用猜 max-height)
  const wrap = document.createElement("div");
  wrap.className = "think-reason-wrap";
  const fold = document.createElement("div");
  fold.className = "think-fold";
  const stepsEl = document.createElement("ul");
  stepsEl.className = "think-steps";
  const reason = document.createElement("div");
  reason.className = "think-reason";
  fold.append(stepsEl, reason);
  wrap.appendChild(fold);
  el.append(head, wrap);
  head.addEventListener("click", () => {
    if (head.classList.contains("no-toggle")) return;
    const open = el.classList.toggle("is-open");
    head.setAttribute("aria-expanded", open ? "true" : "false");
  });
  $("chat-scroll").appendChild(el);
  busy = { el, head, ticksIn, verb, elapsed, stepsEl, reason, stepRows: {},
           start: Date.now(), steps: 0, timer: null };
  busySet(t("turn.thinking"));
  busyElapsed(); busyTick();          // 第 0 秒:條子不會是空的
  busy.timer = setInterval(() => { busyElapsed(); busyTick(); }, 1000);
}
function busyHasFold() {
  if (busy) busy.head.classList.remove("no-toggle"), busy.head.classList.add("has-reason");
}
/* 工具開跑:收據多一列。受詞(指令 / 檔名)放 summary,太長由 CSS 截。 */
function busyStep(c) {
  if (!busy) return;
  busy.steps += 1;
  busySet(t("turn.running", { n: busy.steps }));
  const li = document.createElement("li");
  li.className = "think-step is-run";
  const mark = document.createElement("span"); mark.className = "think-step-mark";
  const verb = document.createElement("span"); verb.className = "think-step-verb";
  verb.textContent = c.tool || "tool";
  const obj = document.createElement("span"); obj.className = "think-step-obj";
  obj.textContent = c.summary || "";
  const time = document.createElement("span"); time.className = "think-step-time";
  li.append(mark, verb, obj, time);
  busy.stepsEl.appendChild(li);
  if (c.id) busy.stepRows[c.id] = li;
  busyHasFold();
}
/* `done` 只是回頭補那一列的耗時 / 錯誤態,不是新步驟。 */
function busyStepDone(c) {
  const li = busy && c.id && busy.stepRows[c.id];
  if (!li) return;
  li.classList.remove("is-run");
  if (c.error) li.classList.add("is-err");
  const ms = Number(c.ms) || 0;
  if (ms > 0) li.querySelector(".think-step-time").textContent =
    ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms";
}
/* 思考文字累積在同一個 log,段與段之間空一行。 */
function busyReason(text) {
  if (!busy || !text) return;
  busy.reason.textContent += (busy.reason.textContent ? "\n\n" : "") + text;
  busy.reason.scrollTop = busy.reason.scrollHeight;
  busyHasFold();
}
function busyHide() {
  if (busy) busy.el.hidden = true;    // 回覆在串流了,字本身就是「還在跑」
}
function busyEnd() {
  if (!busy) return;
  const b = busy; busy = null;
  clearInterval(b.timer);
  const hasFold = b.stepsEl.children.length > 0 || b.reason.textContent.trim() !== "";
  if (hasFold) {
    // 留下來:移到這一輪回覆的**上面**(思考在前、結論在後),動詞改成「思考過程」,
    // 秒數凍結在總耗時,tick 條收掉——那個凍結的秒數已經說了花多久。
    b.el.hidden = false;
    b.el.classList.add("is-done");
    b.el.removeAttribute("role"); b.el.removeAttribute("aria-live");
    b.verb.textContent = t("turn.process");
    if (b.anchor && b.anchor.parentNode) b.anchor.parentNode.insertBefore(b.el, b.anchor);
    return;
  }
  if (b.el.hidden || reducedMotion()) { b.el.remove(); return; }
  b.el.classList.add("is-fading");
  setTimeout(() => b.el.remove(), motionBaseMs() + 30);
}

async function sendDraft() {
  const msg = $("ta").value.trim();
  if (!msg || running) return;
  $("ta").value = ""; autosize();
  submitMessage(msg);
}
/* 真的送出一句話。回傳這一輪有沒有跑起來(「再送一次」要知道)。不碰輸入框。 */
async function submitMessage(msg) {
  if (!msg || running) return false;
  running = true; $("btn-send").disabled = true;
  $("ws-conn").disabled = true;   // 跑到一半不給換 agent
  $("mp-trigger").disabled = true; mpClose(false); csLock(true);
  $("chat-eg").hidden = true;     // 起手範例只在第一句話之前有意義
  addMsg("you", msg); lastUserText = msg;
  if (!csTitle) { csTitle = msg; csRenderHead(); csRemember(); }
  liveBubble = null; faultShown = false; pendingErr = [];
  const unlock = () => { running = false; $("btn-send").disabled = false; $("ws-conn").disabled = false; $("mp-trigger").disabled = false; csLock(false); };
  try {
    // 暖機(首次會裝 venv + SDK,約一分鐘)由 engine-progress 的系統訊息交代,
    // 指示器不在這段亮——那段還沒開始思考,掛「思考中 58s」是假的
    await window.blave.ensureEngine();
    // 沒有型錄(選擇器沒畫)時 model / effort 都是 null,runTurn 就不帶旗標
    turnModel = MP.model; turnGotReply = false; turnErrored = false; turnFaulted = false; turnCards = [];
    const r = await window.blave.sendMessage({
      sessionId, message: msg, model: MP.model, effort: mpEffort() });
    // main.js 的契約只有這兩種回覆:busy 或 started
    if (r.started) { busyStart(); return true; }
    addMsg("sys", t("turn.busy")); unlock(); return false;
  } catch (e) {
    busyEnd();
    addMsg("sys", t("turn.engineFailed", { msg: (e && e.message) || e }));
    unlock(); return false;
  }
}

// 主行程丟的是 strings.js 的 key(它不組句子),查不到就原樣顯示。
window.blave.onEngineProgress((key) => addMsg("sys", t(key)));
// 引擎把上游的錯誤原封不動當成回覆文字吐出來(實測:一次一整塊,不是逐字串流),
// 長這樣:`Failed to authenticate. API Error: 403 …`。401/403 = 這台電腦的授權沒了、
// 402 = 沒額度,兩種都不是重講一次就會好的事,要給出口而不是給英文。
// 402 已經是幾秒內失敗;401 會被 Claude Code CLI 重試兩分鐘以上,所以 api 那邊把
// 帳號 token 失效改回 403(見 proxy.py `_unauthorized`),401 留給機器那條。
/* 選的 model 這個帳號用不了(訂閱方案沒有、或名字不存在)。實測字串(把 --model 設成
   不存在的名字跑一輪):
     There's an issue with the selected model (X). It may not exist or you may not have access to it.
   「名字不存在」與「帳號沒有權限」是**同一句**:#68121 的用戶沒有 Fable 的權限,API 回
   404 not_found_error「Claude Fable 5 is not available…」,CLI 顯示的就是上面這句;
   #52569 的 Pro 用戶權限沒被認到,每個 model 都是這句。所以一個 regex 兩種都接得到。
   三秒內就失敗,不像 401 會轉圈。我們沒辦法事先知道哪個帳號有哪些 model——Claude 沒有
   可查的型錄,逐個試又會燒用戶的額度——所以做法是:讓它快速失敗、講人話、把選擇換回
   預設(下一句就能用),並在面板上把那個 model 標起來,免得再踩一次。 */
const NO_MODEL_RE = /^There's an issue with the selected model \(([^)]+)\)/;

function classifyFault(text) {
  const nm = NO_MODEL_RE.exec(text || "");
  if (nm) {
    // 括號裡的名字**不能拿來認人**:我們送的是別名(`fable`),CLI 會先解析成完整 id 才
    // 報錯(`claude-fable-5`,見 anthropics/claude-code#68121 的實際輸出),兩個字串對
    // 不起來——拿它去標記會標到一個不存在的 id,選擇也不會換回預設。出事的一定是這一輪
    // 送出去的那個 model,所以用 turnModel;括號裡的字只在認不出來時拿來顯示。
    const id = turnModel || nm[1];
    const bad = MP.models.find((m) => m.id === id);
    const name = bad ? bad.name : nm[1];
    mpMarkUnavailable(id);
    const back = mpCur();
    return {
      text: back && back.id !== id
        ? t("fault.noModelSwitched", { model: name, to: back.name })
        : t("fault.noModel", { model: name }),
      label: t("fault.noModelBtn"),
      act: () => mpOpen(),
    };
  }
  // 錨在引擎故障訊息的開頭,不是「內文出現 API Error」就算:用戶問「我的交易所
  // 呼叫為什麼回 402」時,agent 的回覆裡也會有那串,不錨定就會把整句答案換成
  // 一顆儲值鈕。開頭這句是 Claude Code 的固定前綴(實測 403 那次逐字對過)。
  // Claude Code 沒登入時吐的是這句(實測,隔離設定目錄跑一輪):「Not logged in · Please run /login」。
  // /login 是 CLI 互動模式的指令,在我們這裡不存在——原樣顯示等於叫用戶去按一顆沒有的鈕。
  if (cur === "claude" && /^Not logged in\b|Please run \/login/.test(text || "")) return localAuthFault("claude");
  const m = /^(?:Failed to authenticate\. )?API Error: (40[123])\b/.exec(text || "");
  if (!m) return null;
  if (m[1] === "402") return { flow: "credit" };
  // 401/403 是誰的授權沒了,看現在連的是誰。原本一律當成 Blave 的:用自己 Claude Code 的人
  // 登入過期,會看到「Blave 授權已失效」,按下去還把 Blave 的 token 清掉。
  if (cur !== "blave") return localAuthFault(cur);
  return { flow: "blave" };
}

function localAuthFault(kind) { return { flow: "local", kind }; }

// 分類過的錯誤畫完之後,引擎緊接著那句「這輪沒跑起來」就是重複,吞掉。
let faultShown = false;

/* 讀屏出口:#chat-scroll 不是 live region,插進去的系統訊息讀屏不會念。常駐一個 polite 的
   容器(動態插入的 role=status 播報不可靠),系統訊息與錯誤卡每次換內文都寫進來。 */
function srSay(text) { $("sr-live").textContent = ""; requestAnimationFrame(() => { $("sr-live").textContent = text; }); }

/* ── 回合失敗卡(設計師 M1)───────────────────────────
   照雲端工作頁的 .chat-notice.is-fault:13px、ink-2、一條 8×2 的紅記號,不加容器、圖示、紅字。
   **一張卡、一顆鈕,跨狀態沿用同一個節點**(只換字、class 與 handler):登入的進度 / 成功 / 失敗
   不再往下追加灰字,鍵盤焦點也不會因為節點被換掉而掉回 body。
   等待中不放 spinner:等的是用戶在瀏覽器裡的動作,不是系統在忙;這段最長五分鐘。 */
function faultCard() {
  const el = document.createElement("div"); el.className = "msg fault";
  const mark = document.createElement("span"); mark.className = "fault-mark"; mark.setAttribute("aria-hidden", "true");
  const body = document.createElement("div"); body.className = "fault-body";
  const text = document.createElement("div");
  const act = document.createElement("div"); act.className = "fault-act";
  const b1 = document.createElement("button"); b1.type = "button";
  const b2 = document.createElement("button"); b2.type = "button"; b2.className = "btn-out"; b2.hidden = true;
  const sub = document.createElement("div"); sub.className = "fault-sub"; sub.hidden = true;
  let h1 = null, h2 = null;
  b1.addEventListener("click", () => h1 && h1());
  b2.addEventListener("click", () => h2 && h2());
  act.append(b1, b2); body.append(text, act, sub); el.append(mark, body);
  $("chat-scroll").appendChild(el); busyPin(); scrollChat();
  return {
    el, b1, b2,
    // s = { calm, text, label, out, disabled, on, sub(Node|string|null), second:{label,on}|null }
    set(s) {
      el.classList.toggle("is-calm", !!s.calm);
      text.textContent = s.text; srSay(s.text);
      b1.hidden = !s.label;                     // 沒有鈕的狀態(例如「可以開始了。」)
      b1.textContent = s.label || ""; b1.className = s.out ? "btn-out" : "btn-fill";
      b1.disabled = !!s.disabled; h1 = s.on || null;
      b2.hidden = !s.second; if (s.second) { b2.textContent = s.second.label; b2.disabled = false; h2 = s.second.on; }
      sub.hidden = !s.sub; sub.textContent = "";
      if (s.sub) sub.append(s.sub);
      scrollChat();
    },
  };
}

/* 「再送一次」(設計師 M3):不自動重送(那句話可能是下單,而且已經隔了好幾分鐘,最後一步留給人),
   也不要他重打(那一輪沒跑是我們知道的事)。不碰輸入框——他可能已經在打下一句。 */
let lastUserText = "";
function resendState(card, okText) {
  return { calm: true, text: okText, label: t("fault.resend"), on: async () => {
    if (running || !lastUserText) return;
    if (await submitMessage(lastUserText)) {
      card.set({ calm: true, text: okText, label: t("fault.resendDone"), disabled: true });
      $("ta").focus();
    }
  } };
}
function cmdLine(kind) {
  // {cmd} 包成 <code>,用 DOM 組(不用 innerHTML)
  const parts = t("login.failedCmd", { cmd: "\u0000" }).split("\u0000");
  const f = document.createDocumentFragment(); const c = document.createElement("code"); c.textContent = LOGIN_CMD[kind];
  f.append(parts[0] || "", c, parts[1] || ""); return f;
}

/* 同時只能有一個登入行程(main.js 的 loginChild)。等待期間其他登入入口不觸發新流程——
   原本去按另一家的「登入」會立刻顯示「登入沒有完成」,說了一件沒發生的事。 */
let loginPending = null;

function localLoginFlow(card, kind) {
  const name = kind === "codex" ? "Codex" : "Claude Code";
  const fault = (failed) => card.set({
    text: failed ? t("login.failed", { name }) : t("fault.localAuth", { name }),
    label: failed ? t("login.retry") : t("fault.localAuthBtn", { name }),
    sub: failed ? cmdLine(kind) : null, on: start });
  async function start() {
    if (loginPending || oauthPending) return;
    loginPending = kind;
    card.set({ calm: true, text: t("login.opened", { name }), label: t("login.cancel"), out: true,
               on: () => window.blave.cancelAgentLogin() });
    const r = await window.blave.agentLogin(kind);
    loginPending = null;
    if (r.ok) card.set(resendState(card, t("login.ok", { name })));
    else fault(!r.cancelled && !r.busy);      // 取消不是錯誤,回到原本那句
  }
  fault(false);
}

/* Blave 重新登入(設計師 M5):在卡片內原地 OAuth,不清任何東西、不 reload。原本先清 token 與
   連線設定再重載——對話與策略畫面瞬間消失,而且用戶在瀏覽器按了取消的話,連原本的連線設定也沒了。
   token 是每一輪開子行程時才讀的,OAuth 成功就直接覆寫,不必重啟任何東西。 */
function blaveLoginFlow(card) {
  const fault = (subText) => card.set({ text: t("fault.authInvalid"), label: t("fault.authBtn"), sub: subText || null, on: start });
  async function start() {
    if (loginPending || oauthPending) return;
    oauthPending = true;
    card.set({ calm: true, text: t("oauth.opened"), label: t("oauth.cancel"), out: true, on: () => window.blave.cancelOAuth() });
    try {
      await window.blave.startOAuth(LANG);
      oauthPending = false; acct = null;
      mpInit("blave");                         // 失效期間型錄抓回來是空的
      card.set(resendState(card, t("fault.authOk")));
      acctPrecheck();
    } catch (e) {
      oauthPending = false;
      const m = (e && e.message) || "";
      const code = (m.match(/\b[A-Z][A-Z_]{3,}\b/) || [])[0];
      fault(code === "OAUTH_CANCELLED" ? null : (code && t(code) !== code ? t(code) : (m || t("oauth.failed"))));
    }
  }
  fault(null);
}

/* ── Blave 的 AI 能不能用:綁卡 / 儲值 ──────────────────────
   進工作頁(用 Blave 的 AI)先問一次 api 的 account_status:不能跑就先放一張灰記號的預檢卡,
   不等他打完第一句才失敗;輸入框不鎖。402 的失敗卡也照同一份狀態換句子與鈕(沒卡 → 前往綁卡,
   有卡沒餘額 → 儲值);查不到就沿用舊的「沒額度 → 儲值」那組,不猜。
   數字(100 / 14 / 100 / 300)全部來自 api,這裡不寫死。
   視窗回到前景時自動重查(節流 10 秒;還是不能跑就 5 秒後再查,最多 3 次):綁完卡回來,卡片
   自己換成「可以開始了 / 額度到了」。不自動重送——那句話可能是下單。 */
let acct = null, acctCard = null, acctAt = 0, acctRetry = 0;
const creditCards = [];                     // 402 那張(可能不只一張:他連送了兩句)
const acctVars = (s) => ({ q: s.trial_ai_credit, t: s.trial_days, lo: s.auto_topup_min, a: s.auto_topup_amount, m: s.min_topup });
const acctUrl = () => "https://blave.org/agent/" + LANG + "/usage?from=desktop#topup";
function acctSub(s) { return s && s.trial_eligible ? t("acct.sub", acctVars(s)) : null; }
// 不能跑時的鈕與句子(預檢卡與 402 卡共用的那半)
function acctAction(s) {
  // 查不到(s 為 null)不猜:沿用「儲值」
  const noCard = !!s && s.reason === "NO_CARD";
  return { label: t(noCard ? "acct.addCard" : "fault.noCreditBtn"), on: () => window.blave.openExternal(acctUrl()) };
}
function acctPaint() {
  const s = acct;
  if (!s) return;                           // 這次查不到:畫面維持上一次的狀態,不亂翻
  if (acctCard) {
    if (s.can_run) acctCard.set({ calm: true, text: t("acct.ready") });
    else acctCard.set({ calm: true, text: t(s.reason === "NO_CREDIT" ? "acct.noCredit" : "acct.noCard"), sub: acctSub(s), ...acctAction(s) });
  }
  creditCards.forEach((card) => {
    if (s.can_run) card.set(resendState(card, t("acct.creditIn")));
    else if (s.reason === "NO_CARD") card.set({ text: t("fault.needCard"), sub: acctSub(s), ...acctAction(s), second: resendSecond() });
    else card.set({ text: t("fault.noCredit"), ...acctAction(s), second: resendSecond() });
  });
  if (dataCard && s.data_included === true) {
    // 資料在按下啟動後就給(不等主機開好):這張卡講的是「資料可以用了」;「雲端主機開好了」是另一件事,
    // 由 planWatch 在 starting → running 時另外講
    dataCard.set(resendState(dataCard, t("data.ready")));
    dataCard = null;                          // 到手了就不再盯
  } else if (dataCard) dataCard.set(dataCardState());   // 登入 / 綁卡 / 啟動中,卡上的話跟著換
  planWatch(s);
  // 能跑了就不必再盯:清掉名單,視窗回前景不再打 account_status(它跟 LLM 共用每分鐘 30 次的桶,
  // 長任務跑到 25+ 次時多幾次預檢會把一筆 LLM 擠成 429——稽核抓的)
  if (s.can_run) creditCards.length = 0;
}
function resendSecond() { return { label: t("fault.resend"), on: () => { if (!running && lastUserText) submitMessage(lastUserText); } }; }
let acctPending = 0;
async function acctCheck() {
  if (!hasToken) { acct = null; planWatchIdle(); return; }   // 帳號狀態跟「有沒有登入」走,不看連的是誰
  acctAt = Date.now();
  acctPending++;
  const s = await window.blave.accountStatus().finally(() => { acctPending--; });
  if (!hasToken) return;                    // 在途時登出了:這筆是舊帳號的
  if (s) acct = s;                          // 查不到就留著上一次的
  acctPaint();
  if (!acct) planWatchIdle();               // 查不到、手上也沒有:方案頁這時才換成「查不到」那一格
  // 問不到、手上也沒有狀態:中性句不能一直掛著,退回「沒額度 → 儲值」那組(不猜沒卡)
  if (!acct) creditCards.forEach((card) => card.set({ text: t("fault.noCredit"), ...acctAction(null), second: resendSecond() }));
  // 還是不能跑:再等 5 秒查一次,最多 3 次(藍新回呼到我們這邊有幾秒延遲)
  // 只在連的是 Blave 的 AI、而且真的有卡片在等的時候重試:自帶 CLI 的登入者 can_run=false 是常態,
  // 照舊重試會把跟 LLM 共用的每分鐘 30 次的桶打滿
  if (cur === "blave" && acct && !acct.can_run && (acctCard || creditCards.length) && acctRetry < 3) { acctRetry++; setTimeout(acctCheck, 5000); }
  else acctRetry = 0;
}
/* ── 沒有 Blave 資料權限的情境卡(設計師定稿)──────────────────
   agent 因為這台沒有資料權限而拿不到 Blave 資料的那一輪,回覆尾端會帶 `<blave-card:data-access/>`
   (runtime 的規則;paintAi 把它從畫面上拿掉、記在 turnCards)。**agent 只講事實,錢與動作由這張卡講**。
   - 連的是 Blave 的 AI(帳號不含資料):資料含在雲端主機裡 → 描邊鈕外開開機頁;sub 講月費(數字來自
     api 的 starter_monthly,沒有就不報價)——下一步是花錢的動作,事前講清楚。
   - 連的是自己的 Claude Code / Codex:只講原因,出口是 app 內的連線設定;不承諾「切過去就有」。
   同一段對話只出一次;不擋輸入、不搶焦點。同一輪有錢的阻擋卡(402 / 還沒解的預檢卡)就讓位,
   而且不算用掉那一次。視窗回前景重查到 data_included → 換成「資料可以用了」+ 再送一次。 */
const dataCardSessions = new Set();
let dataCard = null;
function dataCardState() {
  const v = planVars(), go = { label: t("pv.e.btn"), on: () => planOpen(), out: true, calm: true };
  if (!hasToken) return { ...go, text: v.t ? t("pv.e.out", v) : t("pv.e.outNoNum", v), sub: v.t && v.p ? t("pv.e.sub", v) : null };
  if (planState() === "starting") return { calm: true, text: t("data.starting") };   // 已經按過啟動:不再叫他去看方案
  if (!acct) return { ...go, text: t("pv.e.unknown") };                              // 狀態查不到:不斷言它在哪個方案裡
  if (acct && acct.reason === "NO_CARD" && acct.trial_eligible) return { ...go, text: t(cur === "blave" ? "pv.e.card" : "pv.e.card.cli", v), sub: v.p ? t("pv.e.sub", v) : null };
  return { ...go, text: t("pv.e.noTrial"), sub: v.p ? t("pv.e.subN", v) : null };
}
function maybeDataCard() {
  if (!turnCards.includes("data-access") || dataCardSessions.has(sessionId)) return;
  if (turnFaulted || creditCards.length || (acctCard && acct && !acct.can_run)) return;
  dataCardSessions.add(sessionId);
  dataCard = faultCard();
  dataCard.set(dataCardState());
}

/* ── 設定 › 雲端方案(設計師定稿)──────────────────────────
   一頁講完:狀態 → 「不啟動也能用」→ 內含三條 → 計費 → 底列常駐「存在就扣」+ 鈕。
   數字全部來自 account_status(plan.hourly / monthly / stop_below / trial_free_until、自動儲值門檻),
   這裡不寫死。啟動 = 主行程用只存在 Keychain 的 app_secret 打 api,後端直接開一台固定的 Linux
   Starter(冪等);停用 / 刪除主機是破壞性的,留在網頁,這裡只給連結。 */
const PLAN_POLL_MS = 20000, PLAN_SLOW_MS = 15 * 60 * 1000;
let planSlowSaid = false;
let planErr = null, planBusy = false, planSince = 0, planTimer = null, planWas = null, planDoneSaid = false, planDonePending = false;
const planState = () => (acct && acct.plan && acct.plan.state) || "none";
const planWebUrl = () => "https://blave.org/agent/" + LANG;
function planDate(iso) {
  const d = new Date(iso); if (isNaN(d)) return "";
  return LANG === "zh" ? (d.getMonth() + 1) + " \u6708 " + d.getDate() + " \u65e5"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
/* 沒登入時的數字(試用天數、AI 額度、驗證金、Starter 月價)來自 api 的公開價目端點;拿不到就用不帶
   數字的退化句,不寫死。登入後一律以 account_status 為準。 */
let pub = null, pubAt = 0;
async function pubLoad() {
  if (pub && Date.now() - pubAt < 3600000) return pub;
  try { const r = await window.blave.publicPricing(); if (r && r.trial) { pub = r; pubAt = Date.now(); } }
  // 主行程還沒有這支、或離線:用退化句
  catch (_) { pub = null; }
  return pub;
}
function planVars() {
  const s = acct || {}, pl = s.plan || {}, tr = (pub && pub.trial) || {};
  const num = (v) => (Number(v) > 0 ? Number(v).toLocaleString("en-US") : "");
  const until = pl.trial_free_until ? new Date(pl.trial_free_until) : null;
  const left = until && !isNaN(until) ? Math.ceil((until - Date.now()) / 86400000) : 0;
  return { p: num(pl.monthly || s.starter_monthly || (pub && pub.starter_monthly)), h: num(pl.hourly || (pub && pub.starter_hourly)), m: num(pl.stop_below),
    a: num(s.auto_topup_min || tr.auto_topup_min), b: num(s.bind_min_topup || s.min_topup),
    v: num(s.verify_amount || tr.verify_amount), t: s.trial_days || tr.days || "", q: num(s.trial_ai_credit || tr.ai_credit),
    top: num(s.auto_topup_amount || tr.auto_topup_amount),
    d: left > 0 ? planDate(pl.trial_free_until) : "", n: left > 0 ? left : 0,
    name: cur === "codex" ? "Codex" : "Claude Code" };
}
function planOpen() { setOpen().then(() => setCat("plan")); }
/* 這一頁現在是哪一格(設計師 v3 的狀態表)。登入是帳號的事、換 AI 是引擎的事:這裡只看有沒有登入與帳號
   狀態,不看 cur(cur 只決定試用說明第一句寫「AI 照用你的…」還是「另有 AI 額度」)。 */
function planView() {
  if (!hasToken) return "out";
  if (!acct) return "unknown";
  const st = planBusy ? "starting" : planState();
  if (st !== "none") return st;                                   // starting / running / stopped
  if (acct.reason === "NO_CARD") return acct.trial_eligible ? "offer" : "noTrial";
  if (planVars().n > 0) return "trial";
  return acct.data_included === true ? "included" : "plan";
}
let planMoreOpen = false, planLoginBusy = false, planLastView = null;
function planPaint() {
  const box = $("set-plan"); if (!box) return;
  // 登入回來、狀態還在查:留著上一格,查完(或失敗)那次重畫才換——不閃「查不到」
  if (hasToken && !acct && acctPending && box.firstChild) return;
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const btn = (cls, label, on, dis) => { const b = el("button", cls, label); b.type = "button"; b.disabled = !!dis; if (on) b.addEventListener("click", on); return b; };
  const focusId = document.activeElement && box.contains(document.activeElement) ? document.activeElement.dataset.k : null;
  box.textContent = "";
  const v = planVars(), view = planView(), hasNum = !!(v.t && v.p);
  const sc = el("div", "plan-scroll"), foot = el("div", "plan-foot");
  const ext = (u) => () => window.blave.openExternal(u);
  const slow = view === "starting" && planSince && Date.now() - planSince > PLAN_SLOW_MS;
  if (slow && !planSlowSaid) { planSlowSaid = true; srSay(t("plan.err.slow")); }   // 錯誤列每次重畫都是新節點,讀屏靠這裡念一次
  if (!slow) planSlowSaid = false;
  const err = slow ? { key: "plan.err.slow", calm: true } : planErr;

  // 每一格:狀態點(有才出)/ 標題句 / 說明 / 鈕上方那行 / 鈕左小字 / 鈕
  const offerLead = () => (cur === "blave" ? t("pv.d.offer.blave", v) : t("pv.d.offer.cli", v));
  const V = {
    out:      { h: hasNum ? "pv.h.offer" : "pv.h.offerNoNum", lead: hasNum ? offerLead() : t("pv.d.noPrice"), rule: hasNum ? t("pv.f.out", v) : "", wait: planLoginBusy ? t("pv.w.waiting") : t("pv.w.out.cli"),
                acts: [planLoginBusy ? btn("btn-out", t("oauth.cancel"), planLogin) : btn("btn-fill", t("pv.signin"), planLogin)] },
    unknown:  { h: "pv.h.unknown", lead: t("pv.d.unknown"), acts: [btn("btn-out", t("plan.recheck"), () => acctCheck())] },
    offer:    { h: "pv.h.offer", lead: offerLead(), rule: t("pv.f.offer", v), acts: [btn("btn-fill", t("plan.addCard"), ext(acctUrl()))] },
    noTrial:  { h: "pv.h.plan", lead: t("pv.d.noTrial", v), rule: t("pv.f.noTrial", v), wait: t("pv.w.noTrial"), acts: [btn("btn-fill", t("plan.addCard"), ext(acctUrl()))] },
    trial:    { st: ["on", t("pv.st.trial", v)], h: "pv.h.ready", lead: t("pv.d.trial", v), rule: t("pv.f.trial", v), acts: [btn("btn-out", t("plan.start"), planAsk, !(v.p && v.h))] },
    plan:     { st: ["", t("pv.st.none")], h: "pv.h.plan", lead: t("pv.d.plan", v), rule: t("pv.f.plan", v), acts: [btn("btn-fill", t("plan.start"), planAsk, !(v.p && v.h))] },
    included: { st: ["on", t("pv.st.ok")], h: "pv.h.ready", lead: t("pv.d.included", v), rule: t("pv.f.plan", v), acts: [btn("btn-out", t("plan.start"), planAsk, !(v.p && v.h))] },
    starting: { st: ["busy", t("pv.st.starting")], h: "pv.h.starting", lead: t("pv.d.starting"),
                acts: [slow ? btn("btn-out", t("plan.recheck"), () => { planSince = Date.now(); acctCheck(); planPaint(); }) : btn("btn-fill", t("plan.starting"), null, true)] },
    running:  { st: ["on", t("plan.st.running")], h: "pv.h.running", lead: t("pv.d.running"), rule: t("pv.f.running", v),
                acts: [btn("btn-quiet", t("plan.manage"), ext(planWebUrl())), btn("btn-out", t("plan.openWs"), ext(planWebUrl()))] },
    stopped:  { st: ["bad", v.m ? t("plan.st.stopped", v) : t("plan.st.stoppedNoAmt")], h: "pv.h.stopped", lead: t("pv.d.stopped", v),
                acts: [btn("btn-quiet", t("plan.manageStopped"), ext(planWebUrl())), btn("btn-fill", t("plan.addCredit"), ext(acctUrl()))] },
  }[view];

  if (view !== planLastView) { if (planLastView && !box.hidden) srSay(t(V.h, v)); planLastView = view; }
  if (V.st) { const stEl = el("span", "plan-st " + V.st[0]); stEl.append(el("span", "dot"), el("span", null, V.st[1])); sc.append(stEl); }
  sc.append(el("h5", null, t(V.h, v)), el("p", "plan-lead", V.lead));
  // 收起的細節:內含三條 + 計費(月價為主、時價並列、試用免費、自動儲值)+ 每人一次。價格查不到就整段不出
  if (v.p) {
    const more = btn("btn-quiet plan-more", t("pv.more"), () => { planMoreOpen = !planMoreOpen; planPaint(); });
    more.setAttribute("aria-expanded", String(planMoreOpen)); more.setAttribute("aria-controls", "plan-detail"); more.dataset.k = "more";
    const det = el("div", "plan-detail"); det.id = "plan-detail"; det.hidden = !planMoreOpen;
    const inc = el("div", "plan-sec"); inc.append(el("p", "plan-lbl", t("plan.inc"))); const ul = el("ul", "plan-list");
    [t("pv.inc.1"), t("pv.inc.2"), t("pv.inc.3")].forEach((x) => ul.append(el("li", null, x)));
    inc.append(ul, el("p", "plan-fine", t("pv.inc.note")));
    const bill = el("div", "plan-sec"); bill.append(el("p", "plan-lbl", t("plan.bill")));
    const pr = el("div", "plan-price"); pr.append(el("span", "m", t("plan.month", v))); if (v.h) pr.append(el("span", "h", t("plan.hour", v))); bill.append(pr);
    if (v.d) bill.append(el("p", "plan-fine", t("plan.trialFree", v)));
    if (v.a && v.top) bill.append(el("p", "plan-fine", t("plan.topup", { a: v.a, b: v.top })));
    // 展開是確認框之前唯一講完整規則的地方(沒登入 / 綁卡那幾格的第一屏刻意不講)
    bill.append(el("p", "plan-fine", t(view === "running" ? "plan.rule.running" : "plan.rule")));
    if (view === "out" || view === "offer") bill.append(el("p", "plan-fine", t("pv.more.once")));
    det.append(inc, bill); sc.append(more, det);
  }
  // 底列:錯誤(有才出)→ 鈕上方那行(這顆鈕會帶來的錢)→ 鈕左小字 + 鈕
  if (err) { const e = el("p", "plan-err" + (err.calm ? " is-calm" : "")); e.setAttribute("role", "status"); e.append(el("span", "fault-mark"), el("span", null, t(err.key))); foot.append(e); }
  if (V.rule) foot.append(el("p", "plan-rule", V.rule));
  const act = el("div", "plan-act");
  if (V.wait) act.append(el("span", "wait", V.wait));
  let acts = V.acts;
  if (err && err.key === "plan.err.relogin") acts = [btn("btn-fill", t("plan.relogin"), planRelogin)];
  else if (err && err.key === "plan.err.nocard") acts = [btn("btn-fill", t("plan.addCard"), ext(acctUrl()))];
  else if (err && err.key === "plan.err.credit") acts = [btn("btn-fill", t("plan.addCredit"), ext(acctUrl()))];
  acts.forEach((b, i) => { b.dataset.k = view + ":" + i; act.append(b); });
  foot.append(act); box.append(sc, foot);
  // 重畫前焦點在這一頁的鈕上 → 還給同一顆(或現在的主鈕);那顆是 disabled 就退到左側的分類鈕——焦點掉到
  // BODY 的話 Esc 關不掉設定
  if (focusId) {
    const again = [...box.querySelectorAll("button")].find((b) => b.dataset.k === focusId) || act.lastElementChild;
    if (again && !again.disabled) again.focus();
    else { const catBtn = document.querySelector('.set-cat[aria-current="true"]'); if (catBtn) catBtn.focus(); }
  }
}
/* 方案頁的「登入 Blave」:只拿 token,**不改連線**(AI 照用他現在那個)。等待瀏覽器期間同一顆鈕變「取消」。 */
async function planLogin() {
  if (planLoginBusy) { window.blave.cancelOAuth(); return; }
  if (oauthPending || running) return;
  planLoginBusy = oauthPending = true; planErr = null; planPaint();
  try { await window.blave.startOAuth(LANG); hasToken = true; acct = null; acctPaintAcct(); await acctCheck(); }
  // 取消或失敗:留在原地,不報錯
  catch (_) { planErr = null; }
  planLoginBusy = oauthPending = false; planPaint();
}
/* 花錢動作的唯一確認點。每一次送出前都過這個框(失敗後重按也一樣):規則只有一條。 */
function planAsk(e) {
  const v = planVars();
  if (!(v.p && v.h)) return;
  confirmBox({ title: t("cf.title"), ok: t("cf.ok"), opener: e && e.currentTarget, onOk: planGo,
    lines: [t("cf.body1"), t(v.d ? "cf.body2Trial" : "cf.body2", v), t("cf.body3")] });
}
async function planGo() {
  planErr = null; planBusy = true; planSince = Date.now(); planPaint();   // 不等回應才變鈕:擋連點
  const r = await window.blave.planStart();
  planBusy = false;
  if (r && r.state) {
    if (acct) acct = { ...acct, plan: { ...(acct.plan || {}), state: r.state } };
    planPaint(); sidePaint(); acctCheck();
    return;
  }
  planSince = 0;
  acctCheck();                               // 我們這邊逾時不代表沒開成:以伺服器的現況為準
  planErr = { key: { APP_SECRET_REQUIRED: "plan.err.relogin", INVALID_CREDENTIALS: "plan.err.relogin", NO_CARD: "plan.err.nocard",
    NO_CREDIT: "plan.err.credit", RATE_LIMITED: "plan.err.rate" }[r && r.error] || "plan.err.server" };
  planErr.calm = planErr.key === "plan.err.relogin";
  planPaint(); srSay(t(planErr.key));
}
/* 舊登入沒有 app_secret:重新登入一次(同一個 OAuth 流程)。回來停在這一類,**不自動送出**——
   要他自己再按一次「啟動方案」、再過一次確認框。 */
async function planRelogin() {
  if (oauthPending || planLoginBusy) return;
  oauthPending = true;
  // 可能換了帳號:上一個帳號的數字不能留到花錢確認框
  try { await window.blave.startOAuth(LANG); planErr = null; hasToken = true; acct = null; await acctCheck(); }
  // 取消或失敗:那句話留著,鈕還在
  catch (_) { /* noop */ }
  oauthPending = false;
  planPaint();
}
/* 每次拿到新的 account_status 都走這裡:啟動中 → 每 20 秒重查(不論設定有沒有開,完成的那句話靠它);
   這台 app 親眼看到 starting → running 才講「開好了」,而且只講一次。 */
function planWatch(s) {
  const st = (s.plan && s.plan.state) || "none";
  if (st === "starting") {
    if (!planSince) planSince = Date.now();
    if (!planTimer && Date.now() - planSince <= PLAN_SLOW_MS) planTimer = setTimeout(() => { planTimer = null; acctCheck(); }, PLAN_POLL_MS);
  } else planSince = 0;
  if (planWas === "starting" && st === "running" && !planDoneSaid) {
    planDoneSaid = true;
    if (running) planDonePending = true; else planSayDone();     // 一輪串流進行中不插
  }
  // 啟動中掉回未啟動 = 那次建機沒成功(搶輸的一方先看到 starting、贏家失敗):要講,不能靜悄悄把鈕變回來
  if (planWas === "starting" && st === "none") { planErr = { key: "plan.err.server" }; srSay(t("plan.err.server")); }
  else if (st !== "none") planErr = null;
  planWas = st;
  if (!$("set-scrim").hidden && !$("set-plan").hidden) planPaint();
  sidePaint();
}
function planSayDone() { planDonePending = false; const c = faultCard(); c.set({ calm: true, text: t("plan.done") }); }
/* 「設定」右邊那行安靜的字:只在試用最後 3 天 / 啟動中 / 已停機出現。不是通知(不推播、不打斷)。 */
function planWatchIdle() { if (!$("set-scrim").hidden && !$("set-plan").hidden) planPaint(); sidePaint(); }
/* 設定左欄底部的帳號區 + 連結畫面尾註那一句:有沒有登入、公開數字拿不拿得到,決定出不出 */
function acctPaintAcct() {
  $("set-acct").hidden = !hasToken;
  const f = $("cn-foot-data"), tr = pub && pub.trial;
  if (f) { f.hidden = !(tr && tr.days); if (!f.hidden) f.textContent = t("cn.foot.data", { t: tr.days }); }
}
function sidePaint() {
  const n = $("ws-conn-note"); if (!n) return;
  let text = "", up = false;
  if (hasToken && acct) {
    const st = planState(), v = planVars();
    if (st === "starting") text = t("side.starting");
    else if (st === "stopped") { text = t("side.stopped"); up = true; }
    else if (st === "none" && v.n > 0 && v.n <= 3) text = t("side.trial", v);
  }
  n.textContent = text; n.hidden = !text; n.classList.toggle("up", up);
  $("ws-conn").setAttribute("aria-label", text ? t("ws.settings") + ", " + text : t("ws.settings"));
}

/* 進工作頁(或切到 Blave)時的預檢:只有查到「不能跑」才放卡 */
async function acctPrecheck() {
  if (acctCard && acctCard.el.isConnected) acctCard.el.remove();
  acctCard = null;
  if (!hasToken) { acct = null; planWatchIdle(); return; }
  acct = await window.blave.accountStatus(); acctAt = Date.now();
  if (acct) planWatch(acct);                  // 方案狀態(側欄那行字、啟動中的輪詢)不看能不能跑
  if (cur !== "blave") return;                // 預檢卡講的是「Blave 的 AI 能不能跑」,自帶 CLI 的人用不到
  if (!acct || acct.can_run) return;
  acctCard = faultCard();
  acctPaint();
}
function creditFlow(card) {
  creditCards.push(card);
  // 手上有「不能跑」的狀態就直接畫;沒有就先畫中性句、鈕先鎖著,等 account_status 回來再換——
  // 對從沒綁過卡的人先說「餘額用完了」是錯話,而且讀屏會念兩次(設計師 L3)
  if (acct && !acct.can_run) acctPaint();
  else card.set({ calm: true, text: t("fault.checking"), label: t("fault.noCreditBtn"), disabled: true });
  // 先照手上(可能過期)的狀態畫,再去問一次最新的
  acctCheck();
}
window.addEventListener("focus", () => {
  if (!hasToken || !(acctCard || creditCards.length || dataCard || planState() === "starting")) return;
  if (Date.now() - acctAt < 10000) return;
  acctCheck();
});

function addFault(f) {
  const card = faultCard();
  if (f.flow === "local") return localLoginFlow(card, f.kind);
  if (f.flow === "blave") return blaveLoginFlow(card);
  if (f.flow === "credit") return creditFlow(card);
  card.set({ text: f.text, label: f.label, on: f.act,
             second: f.resend ? { label: t("fault.resend"), on: () => { if (!running && lastUserText) submitMessage(lastUserText); } } : null });
}

window.blave.onTurnEvent((c) => {
  if (c.type === "image") {
    // 別條對話的圖不畫進來(第一版一次只跑一條,這是保險);下一段文字另起一個泡泡,
    // 順序才會是 文字 → 圖 → 文字,不是圖被擠到整段回覆的後面
    if (c.session_id !== sessionId) return;
    addImage(c.src, c.caption); liveBubble = null;
  } else if (c.type === "text") {
    busyHide();
    const f = classifyFault(c.text);
    if (f) { faultShown = true; turnFaulted = true; addFault(f); liveBubble = null; return; }
    if (!liveBubble) liveBubble = addMsg("ai", "");
    paintAi(liveBubble, (liveBubble._raw || "") + c.text); turnGotReply = true;
    if (liveBubble._cards.length) turnCards = liveBubble._cards.slice();
    // 這一輪的第一個回覆泡泡 = 回合結束時「思考過程」標記要插在它上面的錨點
    if (busy && !busy.anchor) busy.anchor = liveBubble;
  } else if (c.type === "text_replace") {
    busyHide();
    if (!liveBubble) liveBubble = addMsg("ai", "");
    paintAi(liveBubble, c.text);
    if (liveBubble._cards.length) turnCards = liveBubble._cards.slice();
    if (busy && !busy.anchor) busy.anchor = liveBubble;
  } else if (c.type === "tool") {
    // `done` 只是回頭補那一列的耗時 / 錯誤態,不是新步驟
    if (c.status === "done") { busyStepDone(c); scrollChat(); return; }
    // 這段文字後面接了工具呼叫 → 是過場旁白、不是回覆:從泡泡移除(同 web)。
    // 內容不會消失——引擎同步把它當 thinking chunk 送進思考 log。
    if (liveBubble && liveBubble.parentNode) {
      if (busy && busy.anchor === liveBubble) busy.anchor = null;
      liveBubble.remove();
    }
    liveBubble = null;
    busyStep(c);
  } else if (c.type === "thinking") {
    busySet(t("turn.thinking"));
    busyReason(c.text || "");
  } else if (c.type === "error") {
    turnErrored = true;
    if (faultShown && c.code === "not_started") { faultShown = false; return; }
    const line = t("turn.error", { msg: c.message || "" });
    // 本機 agent、這一輪還沒有任何回覆:先不畫,回合結束問過 CLI 的登入狀態再決定出哪一則
    // (設計師 M4)。先畫再換掉會閃,讀屏也已經念出去收不回來。
    if (holdErrors()) pendingErr.push(line); else addMsg("sys", line);
  }
  scrollChat();
});
// turnFaulted:這一輪已經畫過分類過的錯誤卡。不能用 faultShown 判——它在吞掉 not_started 那句時
// 就被歸零了,回合結束時再看會以為沒畫過,多畫一張登入卡。
let turnModel = null, turnGotReply = false, turnErrored = false, turnFaulted = false;
// 這一輪的回覆帶了哪些卡片標記(paintAi 從文字裡拿出來的);回合結束才出卡,不插在串流中間
let turnCards = [];
let pendingErr = [];
const holdErrors = () => (cur === "claude" || cur === "codex") && !turnGotReply && !turnFaulted;
window.blave.onTurnEnd(async (r) => {
  // 這一輪有真的回覆、沒有分類過的錯誤 → 那個 model 是能用的
  if (r.code === 0 && turnGotReply && !faultShown && turnModel) mpMarkWorks(turnModel);
  stratRefresh(true);
  const exitLine = r.code !== 0 ? t("turn.exit", { code: r.code }) + (r.errTail ? ": " + r.errTail.slice(-300) : "") : null;
  // 不靠錯誤字串認登入失效(兩家 CLI 的措辭會變):本機 agent 這一輪出錯或沒有任何回覆時,直接問
  // CLI 現在是不是登入狀態。沒登入 → 只出登入卡,那串給工程師看的錯誤丟掉;有登入 → 才畫通用訊息。
  // 等待指示器留到判斷完才收,中間不留空窗。
  let loggedOut = false;
  if ((cur === "claude" || cur === "codex") && (turnErrored || !turnGotReply) && !turnFaulted) {
    try { const d = await window.blave.detectAgents(); loggedOut = !!(d[cur] && d[cur].installed && !d[cur].loggedIn); }
    // 問不到就當成一般失敗
    catch (_) { /* noop */ }
  }
  if (liveBubble && liveBubble._raw != null) paintAi(liveBubble, liveBubble._raw, false);   // 定稿:不再藏半截標記
  busyEnd();
  if (!loggedOut && r.code === 0) maybeDataCard();
  if (planDonePending) planSayDone();
  if (loggedOut) addFault(localAuthFault(cur));
  else { pendingErr.forEach((x) => addMsg("sys", x)); if (exitLine) addMsg("sys", exitLine); }
  pendingErr = [];
  running = false; $("btn-send").disabled = false; $("ws-conn").disabled = false; $("mp-trigger").disabled = false; csLock(false);
});

/* 側欄 / 聊天欄:拖拉調寬 + 收合(雲端工作頁那套移植,數字相同)。
   側欄 236(180–400)、聊天 452(336–720)、中間保底 480 —— 上限是動態的。
   收合:hover 分隔線浮出把手點一下,或把欄拖過門檻(側欄 <110、聊天 <240);
   側欄收成 44px 細軌、聊天收成 24px 邊條。雙擊分隔線回預設。
   這是每台電腦自己的偏好,放 localStorage;讀寫失敗就用預設。 */
const PANES = {
  side: { div: "div-side", prop: "--side-w", cls: "ws-sc", def: 236, min: 180, max: 400, snap: 110, off: 44, dir: 1 },
  chat: { div: "div-chat", prop: "--chat-w", cls: "ws-cc", def: 452, min: 336, max: 720, snap: 240, off: 24, dir: -1 },
};
const MAIN_MIN = 480;
const paneSt = { side: { w: PANES.side.def, off: false }, chat: { w: PANES.chat.def, off: false } };

function paneEdge(key) { return paneSt[key].off ? PANES[key].off : paneSt[key].w; }
function paneClamp(key, w) {
  const p = PANES[key];
  const room = window.innerWidth - paneEdge(key === "side" ? "chat" : "side") - MAIN_MIN;
  return Math.round(Math.max(p.min, Math.min(w, p.max, room)));
}
function panesRender(save) {
  Object.keys(PANES).forEach((key) => {
    const p = PANES[key], st = paneSt[key], d = $(p.div);
    document.documentElement.classList.toggle(p.cls, st.off);
    document.documentElement.style.setProperty(p.prop, st.w + "px");
    d.classList.toggle("pane-off", st.off);
    d.setAttribute("aria-valuenow", st.off ? 0 : st.w);
    d.setAttribute("aria-valuemin", p.min);
    d.setAttribute("aria-valuemax", p.max);
  });
  if (save) { try { localStorage.setItem("ws_layout", JSON.stringify(paneSt)); } catch (_) {} }
}
function paneToggle(key, off) {
  paneSt[key].off = off;
  if (!off) paneSt[key].w = paneClamp(key, paneSt[key].w);
  panesRender(true);
}
function panesInit() {
  try {
    const saved = JSON.parse(localStorage.getItem("ws_layout")) || {};
    Object.keys(PANES).forEach((key) => {
      const s = saved[key];
      if (!s || typeof s !== "object") return;
      paneSt[key].off = !!s.off;
      paneSt[key].w = Number(s.w) || PANES[key].def;
    });
  } catch (_) {}
  Object.keys(PANES).forEach((key) => { paneSt[key].w = paneClamp(key, paneSt[key].w); });
  panesRender(false);

  let handleAt = 0;   // 連點把手不算分隔線雙擊
  Object.keys(PANES).forEach((key) => {
    const p = PANES[key], st = paneSt[key], d = $(p.div);
    let down = false, dragging = false, fromHandle = false, x0 = 0, w0 = 0;
    const begin = () => { dragging = true; d.classList.add("active"); document.body.classList.add("resizing"); };
    d.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      d.setPointerCapture(e.pointerId);
      down = true; dragging = false;
      // 把手正好浮在游標處,用戶常從那裡起手拖:位移 >3px 才算拖,原地放開才算點
      fromHandle = !!e.target.closest(".handle");
      x0 = e.clientX; w0 = paneEdge(key);
      if (!fromHandle) begin();
    });
    d.addEventListener("pointermove", (e) => {
      if (!down) return;
      const dx = e.clientX - x0;
      if (!dragging) { if (Math.abs(dx) <= 3) return; begin(); }
      const raw = w0 + dx * p.dir;
      st.off = raw < p.snap;
      // 拖過門檻收合時,寬度留在起手前那個值 —— 不然再展開只剩最小寬
      st.w = st.off ? (w0 > p.off ? w0 : st.w) : paneClamp(key, raw);
      panesRender(false);
    });
    const end = (e) => {
      if (!down) return;
      down = false;
      if (dragging) {
        d.classList.remove("active");
        document.body.classList.remove("resizing");
        panesRender(true);
      } else if (fromHandle && e.type === "pointerup") {
        // pointer capture 在分隔線上,原生 click 落不回把手,收合在這裡做
        handleAt = Date.now();
        paneToggle(key, true);
      }
      fromHandle = false;
    };
    d.addEventListener("pointerup", end);
    d.addEventListener("pointercancel", end);
    d.addEventListener("dblclick", () => {
      if (Date.now() - handleAt < 500) return;
      st.off = false; st.w = paneClamp(key, p.def);
      panesRender(true);
    });
    d.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); paneToggle(key, !st.off); return; }
      const step = e.key === "ArrowRight" ? 16 : e.key === "ArrowLeft" ? -16 : 0;
      if (!step) return;
      e.preventDefault();
      const delta = step * p.dir;
      if (st.off) { if (delta > 0) { st.w = p.min; paneToggle(key, false); } return; }
      st.w = paneClamp(key, st.w + delta);
      panesRender(true);
    });
  });
  $("rail-open").addEventListener("click", () => paneToggle("side", false));
  $("chat-strip").addEventListener("click", () => paneToggle("chat", false));
  // 視窗縮小時重新夾一次,中間那欄才不會被擠到 480 以下
  window.addEventListener("resize", () => {
    Object.keys(PANES).forEach((k) => { paneSt[k].w = paneClamp(k, paneSt[k].w); });
    panesRender(false);
  });
}
panesInit();


/* 把 index.html 的 data-i18n 填進去。三種:文字、placeholder、aria-label。
   一律走 textContent —— .po 裡不放標記,換行用 \n,靠 CSS 的 white-space: pre-line。
   在任何畫面顯示之前做完,不然會閃一下 key。 */
function applyStatic() {
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
  // 字標 → 官網,跟著介面語言走(官網的 <lang> 段跟我們的語系代號同一組)。
  // target=_blank 由主行程的 setWindowOpenHandler 接走、交給系統瀏覽器開
  $("ws-home").href = "https://blave.org/" + LANG;   // 結尾不加斜線:/zh/ 是 404
}

(async () => {
  // 用戶在設定裡選過的語言優先,沒選過才跟系統
  let savedLang = null;
  try { savedLang = localStorage.getItem("ws_lang"); } catch (_) { /* noop */ }
  setLang(savedLang || pickLang(await window.blave.getLocale()));
  syncLangControls();
  applyStatic();
  hasToken = await window.blave.hasBlaveToken();
  pubLoad().then(acctPaintAcct);   // 連結畫面尾註那句要的天數;拿不到就不出
  const prev = await window.blave.loadConnection();
  // kind 說「用 Blave 的 AI」但 token 不在(被撤銷後清掉、Keychain 讀不到、換了
  // 電腦),進工作頁會在左下角寫「已連結:Blave AI」,實際上引擎沒有 token 就走
  // 本機模式 —— 帳算在用戶自己的 Claude Code 訂閱上。那個 footer 不能說謊。
  if (prev && prev.kind === "blave" && !(await window.blave.hasBlaveToken())) {
    await window.blave.clearConnection();
    hasToken = false;
    paintBlaveBtn();
    detect();
    $("cn-hint").textContent = t("conn.expired");
    $("cn-hint").hidden = false;
    return;
  }
  if (prev && prev.kind) { enterWorkspace(prev.kind, prev); return; }
  paintBlaveBtn();
  detect();
})();
