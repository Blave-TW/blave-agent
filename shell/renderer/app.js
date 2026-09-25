/* v1 骨架:偵測 → 三態渲染 → 連結 → 進工作頁。引擎接線是第 4 步。 */
const $ = (id) => document.getElementById(id);

function row({ name, st, stClass, action, cur, kind }) {
  const div = document.createElement("div");
  if (kind) div.dataset.kind = kind;
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
  [["claude", "Claude Code"], ["codex", "Codex"]].forEach(([kind, name]) => {
    rows.appendChild(row({ name, kind, st: t("cn.detecting"), stClass: "" }));
  });
  MDL.busy = true; mdlPaint();
}

let lastDetect = null;   // 換語言重畫列用,不重跑偵測
async function detect() {
  detectingRows();
  setHint(null);
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
    rows.appendChild(row({ name: "Claude Code", kind: "claude", st: t("st.signedIn"), stClass: "on",
      cur: cur === "claude",
      action: cur === "claude" ? null : btn(localBtnCls(), t("cn.connect"), () => connect("claude", d.claude)) }));
  } else if (d.claude.installed) {
    rows.appendChild(row({ name: "Claude Code", kind: "claude", st: t("st.notSignedIn"), stClass: "up",
      action: btn("btn-out", t("cn.signIn"), (e) => localLogin("claude", e.currentTarget)) }));
  } else {
    const r = row({ name: "Claude Code", kind: "claude", st: t("st.notFound"), stClass: "" });
    rows.appendChild(r);
  }

  if (d.codex.installed && d.codex.loggedIn) {
    rows.appendChild(row({ name: "Codex", kind: "codex", st: t("st.signedIn"), stClass: "on",
      cur: cur === "codex",
      action: cur === "codex" ? null : btn(localBtnCls(), t("cn.connect"), () => connect("codex", d.codex)) }));
  } else if (d.codex.installed) {
    rows.appendChild(row({ name: "Codex", kind: "codex", st: t("st.notSignedIn"), stClass: "up",
      action: btn("btn-out", t("cn.signIn"), (e) => localLogin("codex", e.currentTarget)) }));
  } else {
    rows.appendChild(row({ name: "Codex", kind: "codex", st: t("st.notFound"), stClass: "" }));
  }
  MDL.busy = false; mdlPaint();
}

/* 連結畫面的 #cn-hint 與設定 › 模型接入 是兩個地方、同一句話:狀態記在這裡,兩邊各畫各的。
   h = null 或 { text, cmd?(kind:失敗時附上終端機指令) }。 */
let HINT = null;
function setHint(h) {
  HINT = h || null;
  const n = $("cn-hint"); n.textContent = ""; n.hidden = !HINT;
  if (HINT) { n.append(HINT.text + (HINT.cmd ? " " : "")); if (HINT.cmd) n.append(cmdLine(HINT.cmd)); }
  // 另外兩個表面各自重畫(兩支都會自己判斷那一塊在不在);帳號頁那一格只由 acctPaintAcct 寫,不讓兩個人碰同一個節點
  mdlPaint();
  acctPaintAcct();
  if (HINT) srSay(HINT.text);
}

/* 連結畫面上「已安裝、未登入」那一列的登入鈕:替用戶跑 CLI 的登入指令(開瀏覽器),
   跑完重新偵測。失敗就把終端機指令寫出來——那條路永遠走得通。 */
const LOGIN_CMD = { claude: "claude auth login", codex: "codex login" };
async function localLogin(kind, b) {
  if (loginPending || oauthPending) return;
  const name = kind === "codex" ? "Codex" : "Claude Code";
  // 從哪一個表面按的(連結畫面 / 設定 › 模型接入):鎖鈕與事後放焦點都回同一個表面
  const host = () => $(b.closest(".cn-opts") ? "set-model" : "agent-rows");
  loginPending = kind;
  // 等的那一顆變「取消等待」(不是變灰),其他登入鈕鎖住
  b.textContent = t("login.cancel");
  const cancel = () => window.blave.cancelAgentLogin();
  b.addEventListener("click", cancel);
  const box = host();
  if (box) box.querySelectorAll("button").forEach((x) => { if (x !== b) x.disabled = true; });
  setHint({ text: t("login.opened", { name }) });
  const r = await window.blave.agentLogin(kind);
  loginPending = null;
  await detect();
  if (!r.ok && !r.cancelled) setHint({ text: t("login.failed", { name }), cmd: kind });
  // detect() 把整列重畫了,焦點會掉回 body:放回這一列的鈕(成功=「連結」,失敗=「登入」)
  const again = host() && host().querySelector('[data-kind="' + kind + '"] button');
  if (again) again.focus();
}

// 目前連的是哪一種(連結畫面用來標「目前使用」、決定 Blave 那顆鈕的字)。
let cur = null;

async function connect(kind, info) {
  // 主行程用它當下偵測到的路徑存;偵測不到了(CLI 剛被移掉)回 false:留在連結頁重新偵測,不進一個送不出訊息的工作頁
  if ((await window.blave.saveConnection({ kind, path: info.path, email: info.email || null })) === false) { detect(); return; }
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
  acctPaintAcct();                           // 設定 › 帳號 的那一頁(登入 / 登出是帳號的事,不是某一種 AI 的事)
  $("cn-blave-cur").hidden = cur !== "blave";
  $("cn-blave-cur").textContent = t("cn.current");
  sec.classList.toggle("is-cur", cur === "blave");
  if (cur === "blave") { sec.setAttribute("aria-current", "true"); }
  else { sec.removeAttribute("aria-current"); }
  b.textContent = hasToken && cur !== "blave" ? t("cn.blave.switch") : t("cn.blave.btn");
  b.className = localReady ? "btn-out" : "btn-fill";
  mdlPaint();                                // 設定 › 模型接入 是另一份 DOM(那張卡不再搬家),同一份狀態各畫各的
}

/* ── 設定 › 模型接入 ───────────────────────────────────────
   這一頁 = 三個選項選一個(Blave AI / Claude Code / Codex),不是連結畫面那張卡。
   **那張卡不再搬進設定**:連結畫面是第一次要做決定的地方(動詞句、填色鈕),設定頁是回來換的地方(三列平權、
   「使用中」用灰填 + 加粗標出來)。兩邊共用的是底下的邏輯(detect / connect / localLogin / blaveGo),不是 DOM。
   mdlOptions 是純邏輯(tests/check_shell_settings.js 從原文切出來跑),不碰 DOM。 */
const MDL = { busy: false };
/* pend = { login:"claude"|"codex"|null, oauth:bool }:等待中的那一列,鈕變「取消等待」而不是變灰——
   這一頁每次重畫都是新節點(setHint 會觸發),等待狀態要在資料裡,不能只靠改那顆鈕的字(改完就被重畫吃掉)。 */
/* 就緒是預設,不講:能用的列 st = null,只有不能用的列講狀態(尚未登入 / 未偵測到)。
   「改成用這個」三列同一個字「使用」(cn.use)——Blave 走 blaveGo、本機走 connect,對用戶是同一個動作 */
function mdlOptions(d, curKind, tok, pend) {
  const p = pend || {};
  const out = [{ kind: "blave", nameKey: "cn.blave.name", desc: "cn.blave.desc",
    st: tok ? null : { key: "st.notSignedIn" },
    // 已經有 token 就不必再跑一次 OAuth:切回去是一個選擇,不是重新授權
    act: p.oauth ? "oauth.cancel" : curKind === "blave" ? null : tok ? "cn.use" : curKind ? "cn.blave.signinSwitch" : "cn.blave.btn",
    isCur: curKind === "blave" }];
  [["claude", "Claude Code"], ["codex", "Codex"]].forEach(([kind, name]) => {
    const x = (d && d[kind]) || {}, ready = !!(x.installed && x.loggedIn);
    out.push({ kind, name, desc: null,
      // d 是 null = 還在偵測:狀態寫「偵測中…」、不給動作(列數不變,不 reflow)
      st: d === null ? { key: "cn.detecting" } : ready ? null : { key: x.installed ? "st.notSignedIn" : "st.notFound" },
      act: p.login === kind ? "login.cancel" : d === null || !ready ? (d !== null && x.installed ? "cn.signIn" : null) : curKind === kind ? null : "cn.use",
      isCur: ready && curKind === kind });
  });
  return out;
}
// 「重新偵測」只在本機有一個不能用的時候出:兩個都就緒時再偵測也不會有不同的結果。d = 上一次偵測的結果(偵測中照上一次的畫,鈕停用)
function mdlNeedsRedetect(d) { return !!d && ["claude", "codex"].some((k) => { const x = d[k] || {}; return !(x.installed && x.loggedIn); }); }
/* ── 設定 › 模型接入 的純邏輯到此 ─────────────────────────── */
function mdlAct(o, b) {
  // 等待中的那一顆是「取消」(不是變灰):瀏覽器分頁被關掉之後不會有人按「允許」,沒有取消就卡到逾時
  if (o.act === "login.cancel") return window.blave.cancelAgentLogin();
  if (o.act === "oauth.cancel") return window.blave.cancelOAuth();
  if (o.kind === "blave") return blaveGo(b);
  if (o.act === "cn.signIn") return localLogin(o.kind, b);
  return connect(o.kind, (lastDetect && lastDetect[o.kind]) || {});
}
function mdlPaint() {
  const box = $("set-model"); if (!box) return;
  const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
  const focusKind = box.contains(document.activeElement) ? (document.activeElement.closest("[data-kind]") || {}).dataset : null;
  box.textContent = "";
  const pend = { login: loginPending, oauth: oauthPending };
  const opts = mdlOptions(MDL.busy ? null : lastDetect, cur, hasToken, pend);
  const waiting = !!(pend.login || pend.oauth);
  const grp = (headKey, descKey) => {
    const g = el("div", "cn-grp"), h = el("div", "cn-grp-h");
    h.appendChild(el("span", null, t(headKey)));
    // 小標與後面那句同為 12px --ink-3,只隔 8px 會連起來讀成一句:中間放一個「·」分開
    if (descKey) { const sep = el("span", "sep", "·"); sep.setAttribute("aria-hidden", "true"); h.append(sep, el("span", "m", t(descKey))); }
    const o = el("div", "cn-opts"); g.append(h, o); box.appendChild(g); return [g, o];
  };
  const put = (into, o) => {
    const r = el("div", "cn-opt" + (o.isCur ? " is-cur" : "")); r.dataset.kind = o.kind;
    if (o.isCur) r.setAttribute("aria-current", "true");
    const tc = el("div", "t"); tc.appendChild(el("p", "n", o.nameKey ? t(o.nameKey) : o.name));
    if (o.desc) tc.appendChild(el("p", "m", t(o.desc)));
    r.appendChild(tc);
    if (o.st) r.appendChild(el("span", "st", t(o.st.key)));
    if (o.isCur) r.appendChild(el("span", "cn-cur", t("cn.current")));
    // 等待中:只有那一顆能按(取消),其餘鎖住
    else if (o.act) { const b = el("button", "pf-act", t(o.act)); b.type = "button"; b.disabled = waiting && o.act !== "login.cancel" && o.act !== "oauth.cancel"; b.addEventListener("click", () => mdlAct(o, b)); r.appendChild(b); }
    into.appendChild(r);
  };
  put(grp("cn.blave.group")[1], opts[0]);
  const [lg, local] = grp("cn.local.label", "cn.local.desc");
  opts.slice(1).forEach((o) => put(local, o));
  // 本機那一組最後一列底下的安靜文字鈕(不佔組標題)
  if (mdlNeedsRedetect(lastDetect)) {
    const m = el("p", "cn-more"), b = el("button", "btn-quiet", t("cn.redetect")); m.dataset.kind = "redetect";
    b.type = "button"; b.disabled = MDL.busy || waiting; b.addEventListener("click", detect); m.appendChild(b); lg.appendChild(m);
  }
  if (HINT) { const p = el("p", "cn-hint"); p.append(HINT.text + (HINT.cmd ? " " : "")); if (HINT.cmd) p.append(cmdLine(HINT.cmd)); box.appendChild(p); }
  // 重畫前焦點在這一頁:還給同一列的鈕(沒有的話退到左側的分類鈕——掉到 BODY 的話 Esc 關不掉設定)
  if (focusKind) { const again = box.querySelector('[data-kind="' + focusKind.kind + '"] button'); if (again && !again.disabled) again.focus(); }
  setFocusGuard();
}

let csReady = false;
function enterWorkspace(kind, info) {
  $("view-connect").hidden = true;
  $("view-ws").hidden = false;
  cur = kind;
  mpInit(kind);
  stratRefresh(false);
  if (!csReady) { csReady = true; csInit().catch(() => {}).then(() => { CS_BOOTED = true; upSayLines(TR_BAGS.cloud.st); }); }
  acctPrecheck();   // 換 agent 不換對話:只在第一次進工作頁接回
  trInit();         // 自動下單(trade.js):開始輪詢本機交易狀態;重複呼叫只會起一次
  // 從設定 modal 裡換的:留在 modal、重畫模型接入那一頁(「使用中」換列),焦點不搶去輸入框
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
$("set-acct-btn").addEventListener("click", async () => {
  // 未登入時這顆是「登入 Blave」:走方案頁同一條登入流程(等待中再按 = 取消),不另寫一條。
  // 等待是從別的表面(模型接入那一列)開始的話,planLogin 會靜默 return——那顆鈕寫著「取消」卻按不動,
  // 所以直接取消:等的是同一件事、同一個瀏覽器分頁,誰按取消都一樣
  if (!hasToken) {
    if (oauthPending && !planLoginBusy) { window.blave.cancelOAuth(); return; }
    await planLogin(); acctPaintAcct(); return;
  }
  if (running || oauthPending || planLoginBusy) return;
  $("set-acct-btn").disabled = true;
  const r = await window.blave.signOutBlave();
  $("set-acct-btn").disabled = false;
  hasToken = false; acct = null; planErr = null; planBusy = false;
  RPC_CACHE.clear();   // 上一個帳號的雲端報告不能在下一個帳號點同名策略時先畫出來
  if (typeof libInvalidate === "function") libInvalidate();   // 策略庫的 purchased / 閘門是這個帳號的
  // 伺服器那顆沒撤到(離線、逾時):本機已經登出,但要講清楚還差一步、去哪裡補
  const warn = () => { if (!r.revoked) setHint({ text: t("cn.blave.signOutLocalOnly") }); };
  acctPaintAcct();
  // 用自己的 CLI 的人:AI 不受影響,留在原地;帳號區還在(換成未登入那一態),焦點留在同一顆鈕上
  if (cur !== "blave") {
    paintBlaveBtn(); planWatchIdle(); srSay(t("acct.outDone"));
    $("set-acct-btn").focus();
    await detect(); warn(); return;
  }
  await window.blave.clearConnection();
  cur = null;
  setClose();
  $("view-ws").hidden = true; $("view-connect").hidden = false;
  paintBlaveBtn(); await detect(); warn();
});
// 等待期間這顆鈕變成「取消」而不是變灰:用戶把瀏覽器分頁關掉之後不會有人按
// 「允許」,沒有取消的話這裡就卡到五分鐘逾時為止。
let oauthPending = false;
$("btn-blave").addEventListener("click", () => blaveGo($("btn-blave")));
async function blaveGo(b) {
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
  setHint({ text: t("oauth.opened") });   // setHint 會重畫兩個表面
  waitChanged();
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
    setHint({ text: code && t(code) !== code ? t(code) : (m || t("oauth.failed")) });
  } finally {
    oauthPending = false;
    b.textContent = was;
    waitChanged();                           // 等待結束:兩個表面都要把「取消」換回來
  }
}

/* ── 設定 modal ───────────────────────────────
   左下角的設定鈕直接開(雲端是「更多」選單裡的一項;桌面版只有這一項,不展開)。
   跑到一半整顆 disabled——引擎的環境變數是開子行程那一刻決定的,中途換 agent
   等於在活著的子行程底下抽掉設定。
   「模型接入」自己畫一份(mdlPaint):連結畫面那張卡不搬家——那裡是第一次做決定的地方,這裡是回來換的地方。
   共用的是底下的邏輯(detect / connect / localLogin / blaveGo),不是 DOM。 */
/* 設定裡任何一塊重畫之後的保險:焦點掉到 BODY(或掉出 modal)就放回 modal 內一個合理的落點。
   Esc 與 Tab 都綁在 #set-scrim 上,焦點在 BODY 時事件冒泡不到它——那時設定關不掉、Tab 也不再圈在框裡。
   不靠個別欄位名猜得對不對:重畫完一律過這一關。 */
/* 等待瀏覽器那邊按「允許」是**一件事**,可是「模型接入」與「帳號」是兩份 DOM:
   只要 oauthPending / planLoginBusy 變了,兩邊都得重畫,否則一邊還留著「取消」、另一邊的鈕按了沒反應。
   規矩:凡是改這兩個旗標的地方,收尾一律叫這一支(tests/check_shell_settings.js 會列舉檢查)。 */
function waitChanged() { mdlPaint(); acctPaintAcct(); }
function setFocusGuard() {
  // 確認框 / 圖片放大開著時不管:那兩個是更上層的框,焦點歸它們(現在靠 view-ws 的 inert 讓 focus() 變 no-op 撐著,寫成明文)
  if (!$("del-scrim").hidden || !$("lb-scrim").hidden) return;
  if ($("set-scrim").hidden) return;
  const a = document.activeElement;
  if (a && a !== document.body && $("set-modal").contains(a)) return;
  const back = document.querySelector('.set-cat[aria-current="true"]') || $("set-close");
  if (back) back.focus();
}
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
  if (cat === "model") mdlPaint();
  if (cat === "src") srcLoad(); else srcClear();   // 資料來源(renderer/datasrc.js);離開那一類就把沒存的金鑰從輸入框清掉
  if (cat === "acct") acctPaintAcct();
  if (cat === "priv") privLoad();
  if (cat === "plan") { planPaint(); if (hasToken) acctCheck(); else pubLoad().then(() => { if (!$("set-plan").hidden) planPaint(); }); }
}
async function setOpen() {
  if (typeof upRefresh === "function") upRefresh();   // 下載完當下在下單、之後暫停了:主行程不會再推事件,打開設定時自己重讀(稽核 M3)
  if (running) return;
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
  srcClear();   // 資料來源的表單:貼了沒存的金鑰不留在關掉的框裡
  sc.classList.remove("open");
  sc.hidden = true;
  if (typeof libRefresh === "function") libRefresh();   // 在設定裡綁了卡 / 儲了值 / 登入了:策略庫的閘門要跟上
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
  const b = e.target.closest(".set-cat"); if (b && b.dataset.setCat) setCat(b.dataset.setCat);   // 只有帶 data-set-cat 的才是分類鈕
});
$("set-scrim").addEventListener("keydown", (e) => trapTab(e, $("set-modal")));   // Esc 在下面那一支 document 層的 escTop
$("set-lang").addEventListener("change", () => applyLangChoice($("set-lang").value));

/* ── 版本與更新(設定 › 一般 › 關於)──────────────────────────────────
   主行程的 updater.js 管下載;這裡只畫狀態。新版在背景下載,永遠不自己重啟:已暫存好 → 「重新啟動以完成更新」;
   自動下單執行中那顆不出(暫停之後,或正常結束 Blave 時才裝)。 */
var UP = null;   // var:applyStatic 可能在這一行之前就被叫到(let 的 TDZ 會連 typeof 都丟例外)
/* 設定 › 隱私:使用資料。一顆即時生效的開關(沒有儲存鈕)、一行為什麼收、會收 / 不收兩份短清單、一行保留多久。
   app 裡不做首次告知(Wei);關掉之後清單留著——看得到自己關掉的是什麼。全段不寫「匿名」:登入後安裝編號會跟帳號對上。
   開關的真值在主行程(telemetry.js 的狀態檔);這裡每次打開這一類就重讀,切換後以主行程回的為準。 */
let PRIV = null;   // null = 還沒讀到(開關先鎖著,免得先畫成開、再跳成關)
const PRIV_COLLECT = ["priv.collect.1", "priv.collect.2", "priv.collect.3", "priv.collect.4"];
const PRIV_NEVER = ["priv.never.1", "priv.never.2", "priv.never.3", "priv.never.4", "priv.never.5", "priv.never.6"];
let PRIV_ID = null;   // 安裝識別碼:只收 UUID 的形狀(它會被畫出來、放進剪貼簿)
async function privLoad() {
  try { PRIV = (await window.blave.telemetryGet()) === true; } catch (_) { PRIV = null; }
  try { const id = await window.blave.telemetryInstallId(); PRIV_ID = typeof id === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) ? id : null; } catch (_) { PRIV_ID = null; }
  privPaint();
}
async function privToggle() {
  if (PRIV == null) return;
  const want = !PRIV;
  try { PRIV = (await window.blave.telemetrySet(want)) === true; } catch (_) { /* noop */ }   // 沒切成:畫面維持原狀
  privPaint(); $("priv-sw").focus();
  srSay(PRIV ? t("priv.lead") : t("priv.leadOff"));
}
function privPaint() {
  const box = $("set-priv"); if (!box) return;
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const had = box.contains(document.activeElement);
  box.textContent = "";
  const row = mk("div", "sw-row"); row.append(mk("span", "sw-l", t("priv.switch")));
  const sw = mk("button", "sw" + (PRIV ? "" : " off")); sw.type = "button"; sw.id = "priv-sw";
  sw.setAttribute("role", "switch"); sw.setAttribute("aria-checked", PRIV ? "true" : "false"); sw.setAttribute("aria-label", t("priv.switch"));
  sw.disabled = PRIV == null; sw.addEventListener("click", privToggle);
  row.append(sw); box.append(row);
  const off = PRIV === false;
  box.append(mk("p", "priv-lead", off ? t("priv.leadOff") : t("priv.lead")));
  const two = mk("div", "priv-two");
  [[off ? t("priv.collect.hOff") : t("priv.collect.h"), PRIV_COLLECT], [t("priv.never.h"), PRIV_NEVER]].forEach(([head, keys]) => {
    const col = mk("div"), ul = mk("ul"); col.append(mk("h6", "", head));
    keys.forEach((k) => ul.append(mk("li", "", t(k)))); col.append(ul); two.append(col);
  });
  box.append(two, mk("p", "priv-fine", off ? t("priv.kept") : t("priv.fine")));
  // 安裝識別碼:開關關著也看得到——要求刪除的是關掉之前送出去的那些
  if (PRIV_ID) {
    const idRow = mk("div", "sw-row priv-id"), copy = mk("button", "btn-quiet", t("priv.idCopy")); copy.type = "button";
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(PRIV_ID); } catch (_) { return; }
      copy.textContent = t("priv.idCopied"); srSay(t("priv.idCopied")); setTimeout(() => { if (copy.isConnected) copy.textContent = t("priv.idCopy"); }, 2000);
    });
    idRow.append(mk("span", "sw-l", t("priv.id")), mk("code", "priv-idv", PRIV_ID), copy);
    box.append(idRow, mk("p", "priv-lead", t("priv.idNote")));
  }
  /* 隱私權政策的入口(法遵稽核):政策 §9.1 叫人到這一頁關遙測、拿安裝識別碼,這一頁卻沒有連回那份政策 */
  const legal = mk("p", "set-legal"), pl = mk("button", "btn-quiet", t("legal.privacy")); pl.type = "button"; pl.id = "priv-legal";
  pl.addEventListener("click", () => window.blave.openExternal(legalUrl("privacy_policy")));
  legal.append(pl); box.append(legal);
  if (had) sw.focus();
  setFocusGuard();
}
/* 「一般」頁最下面的「關於」一行 + 聊天輸入列右上那一格 + 選單列那一行(proposal-desktop-update-flow-v4 §2–§4)。
   全 app 只有三個可見狀態:(a) 沒有東西 (b)「重新啟動以完成更新」= app 新版已暫存好(updater.js ready;下單中是 blocked,鈕不出、
   只在關於列寫「結束 Blave 時安裝」)(c)「更新中…」= 雲端主機正在換檔(報告的 workspace_update.state = applying)。
   雲端那半仍由本機 agent 經 MCP 去做(Wei 09-22:app 不得觸發雲端 agent 回合),但零選擇:「檢查更新」= app 重查一次 +
   雲端強制刷新一次報告,報告說落後就在本機聊天送那一句固定的話(up.c.msg)。報告還沒有 workspace_update 欄位之前,
   (c) 由那一回合推得(送出的那一回合在跑、或之後碰過雲端的回合在跑),事後那一行由版號追上推得(只有 from → to)。
   決策全在 upPlan / upDoneLine(純函式,tests/check_shell_settings.js 直接跑);upPaint 只照它畫。 */
var UPD = { cloudTurn: false, turnCloud: false, session: null, lagCv: null, done: null };
const UP_SESSION_IDLE_MS = 30 * 60000;   // 更新期間 30 分鐘沒有回合就結束(兜底)
/* 每次畫之前看一眼雲端:更新期間什麼時候結束、版號追上時記一筆給事後那一行的退路。純函式(只改 mem)。
   cloud = snapshot 的 cloud 那一塊;stale = 報告說重開後沒能確認停住(版號一樣也算落後) */
function upObserve(mem, cloud, stale, localTurn, now) {
  const c = cloud || {}, cv = c.config_version || null, lv = c.latest_config_version || null;
  const lag = !!(cv && lv && cv !== lv) || !!stale, caughtUp = !!(cv && lv && cv === lv) && !stale;
  const endSession = () => { mem.session = null; mem.cloudTurn = false; };
  if (mem.session && localTurn) mem.session.lastTurnAt = now;
  if (lag) { mem.done = null; if (cv) mem.lagCv = mem.lagCv || cv; }
  if (caughtUp) {
    if (mem.session || (mem.lagCv && mem.lagCv !== cv)) mem.done = { from: (mem.session && mem.session.fromCv) || mem.lagCv || null, to: lv };
    if (mem.session) endSession();
    mem.lagCv = null;
  }
  if (mem.session && lv && mem.session.nv && lv !== mem.session.nv) endSession();   // 出了更新一版:這一次的結果不拿來判下一版
  if (mem.session && !localTurn && now - (mem.session.lastTurnAt || mem.session.startAt) > UP_SESSION_IDLE_MS) endSession();
  return mem;
}
/* 雲端是「沒有主機」或「啟動中」= 舊主機已經不在了:之前記的落後、追上、更新期間都是那台的事,清掉——
   不清的話新開的主機一跑起來就被當成「已更新到」。停機(同一台)與讀不到不清。 */
function upMachineGone(mem, kind) {
  if (kind === "none" || kind === "starting") Object.assign(mem, { lagCv: null, done: null, session: null, cloudTurn: false });
  return mem;
}
const UP_WU_STATES = ["applying", "done", "failed"], UP_WU_OUTCOMES = ["updated", "up_to_date", "restart_failed", "restart_deferred", "stopped", "error", "partial"];
/* 報告的 workspace_update(manager/update_workspace.py apply 寫 state/workspace_update.json,runtime/portfolio_reporter.py 一天內原樣轉出;§5-3):
   { state: applying|done|failed, outcome, from, to, restarted, reason, replaced_changed: [paths], backup_dir, restart_stopped, ts }。
   done = 檔已在磁碟上(含 restart_failed / restart_deferred:restarted false + reason);failed = stopped / error / partial(帶 reason)。
   雲端那台機器上的策略碼寫得進去的東西 = 不可信輸入:只取認得的形狀、字串截長;畫面一律 textContent。
   backup_dir 會被「查看」原樣塞進送給本機 agent 的訊息,所以只認腳本產出的形狀 .official-backup/<VERSION_RE>-<UTC 時間>(不合就當沒有,那一行就不出「查看」);
   reason 不讀:failed 不講(P3),restart_failed / deferred 的句子也不帶它 */
const UP_WU_DIR_RE = /^\.official-backup\/[A-Za-z0-9._-]{1,40}-\d{8}T\d{6}Z\/?$/;
function upWu(report) {
  const w = report && report.workspace_update;
  if (!w || typeof w !== "object" || UP_WU_STATES.indexOf(w.state) < 0) return null;
  const str = (v, n) => (typeof v === "string" && v ? v.slice(0, n) : null);
  return { state: w.state, outcome: UP_WU_OUTCOMES.indexOf(w.outcome) >= 0 ? w.outcome : null, to: str(w.to, 40), restarted: w.restarted === true,
    replaced: Array.isArray(w.replaced_changed) ? w.replaced_changed.length : 0, dir: typeof w.backup_dir === "string" && UP_WU_DIR_RE.test(w.backup_dir) ? w.backup_dir : null,
    restartStopped: w.restart_stopped === true, ts: typeof w.ts === "number" ? w.ts : str(w.ts, 40) };
}
/* o:{ up(updater 狀態), cloud(雲端 snapshot 的 cloud 那一塊), kind(envCloudKind), localTurn, mem(UPD), now, cloudStale, wu(upWu), checking(按了檢查更新、還沒回來) }
   回 { slot, row: { segs, status }, link, spin, cloudLag }。字一律回 [key, vars]。
   slot = null | { kind: "restart" | "applying", disabled };link = { kind: "check" | "restart", disabled } */
function upPlan(o) {
  const st = o.up || {}, ph = st.phase, mem = o.mem || {}, c = o.cloud || {}, wu = o.wu || null, turn = !!o.localTurn;
  const cv = o.kind === "running" ? c.config_version || null : null, lv = c.latest_config_version || null;
  const cloudLag = o.kind === "running" && (!!(cv && lv && cv !== lv) || !!o.cloudStale);
  // (c):報告說正在換檔;沒有那個欄位時由本機那一回合推得(檢查更新送出的那一回合在跑、或更新期間內碰過雲端的回合在跑)
  const applying = !!(wu && wu.state === "applying") || (turn && !!mem.session && (!!mem.cloudTurn || !!mem.turnCloud));
  // (b):Squirrel 已暫存好而且沒在下單(updater 的 publicState 每次都重看 isTrading:下單中是 blocked)。回合在跑時不能重開(會把它斷掉)
  const ready = ph === "ready";
  const slot = applying ? { kind: "applying", disabled: false } : ready ? { kind: "restart", disabled: turn } : null;
  const segs = [];
  if (st.current) segs.push(["up.row.app", { av: st.current }]);
  if (o.kind === "stopped" || o.kind === "unreach") segs.push(["up.row.cloudOff"]);
  else if (cv) segs.push(["up.row.cloud", { cv }]);   // 版號讀不到(舊機器 / api 快取 null)就不寫雲端那段,不印「雲端主機 null」
  let status = null;
  if (applying) status = ["up.row.applying"];
  else if (ready) status = ["up.row.ready"];
  else if (ph === "blocked") status = ["up.row.readyQuit"];
  else if (ph === "error" && st.error === "INSTALL_FAILED") status = ["up.installFailed", { nv: st.version || "" }];
  /* 「已是最新版」只在查過之後才接上:啟動後 30 秒(updater FIRST_CHECK_MS)才第一次查,checkedAt 只有 update-not-available 會寫;
     檢查中沿用上一次的結論(圓環在連結上)。雲端已知落後而還沒在換檔時也不寫——那不是最新版,但沒有第四個狀態可講 */
  else if ((ph === "idle" || ph === "checking") && st.checkedAt > 0 && !cloudLag) status = ["up.row.latest"];
  const spin = !applying && !!(o.checking || ph === "checking");
  const link = applying ? { kind: "check", disabled: true } : ready ? { kind: "restart", disabled: turn } : { kind: "check", disabled: spin };
  return { slot, row: { segs, status }, link, spin, cloudLag };
}
/* 事後那一行(§3):做完那一刻在聊天講一次,不進關於列。回 { key(講過就不再講), head, tail, view: null | "local" | "cloud", dir } 或 null。
   報告有 workspace_update:done 依 outcome 講——updated + 主機暫停中(restart_stopped;gated 重啟時 restarted 也會是 true,暫停那句優先——用戶得知道仍沒在下單)
   / 重啟了 / 只換了檔;restart_deferred = 等這筆單完成後
   再說一次「更新」就會重啟(還沒有機器端的 timer,不能講「主機會自己再試」);restart_failed = 重啟沒成;up_to_date 不講;換掉了改過的官方檔就接一句(帶「查看」)。
   failed(stopped / error / partial)沒有 §3 的句子:不講(P3,agent 那一回合已經講過)。沒有那個欄位:只剩版號追上推得的「已更新到 {cv}」。 */
function upDoneLine(wu, mem) {
  if (wu && wu.state === "done" && wu.outcome && wu.outcome !== "up_to_date") {
    const key = "wu:" + (wu.ts != null ? wu.ts : wu.to || wu.outcome);
    const head = wu.outcome === "restart_deferred" ? ["up.done.restartDeferred"] : wu.outcome === "restart_failed" ? ["up.done.restartFailed"]
      : !wu.to ? null : wu.restartStopped ? ["up.done.paused", { cv: wu.to }] : wu.restarted ? ["up.done.cloudRestarted", { cv: wu.to }] : ["up.done.cloud", { cv: wu.to }];
    if (!head) return null;   // updated 卻沒帶版號:不印「更新到 null」
    const tail = wu.replaced > 0 && wu.dir ? ["up.done.replaced", { n: wu.replaced, dir: wu.dir }] : null;
    return { key, head, tail, view: tail ? "cloud" : null, dir: wu.dir };
  }
  if (!wu && mem && mem.done && mem.done.to) return { key: "v:" + mem.done.to, head: ["up.done.cloud", { cv: mem.done.to }], tail: null, view: null, dir: null };
  return null;
}
/* app 換版後第一次啟動、蓋過改動(主行程 syncOfficialOnUpdate 只在那時給):同 §3 的格式,「開啟資料夾」開 Finder */
function upBackupLine(st) {
  const bk = st && st.backup;
  if (!(bk && Number.isInteger(bk.n) && bk.n > 0 && typeof bk.dir === "string")) return null;
  return { key: "bk:" + bk.dir, head: ["up.backup", { av: st.current || "", n: bk.n, dir: bk.dir }], tail: null, view: "local", dir: bk.dir };
}
/* 把一句話畫進節點:vars 裡列在 mono 的值包成 .mono(版號、路徑),{view} 的位置放鈕。值先換成記號、最後才放值——
   雲端來的字串(路徑)裡就算長得像 {cv} 也不會被再替換一次 */
function upRich(host, key, vars, opt) {
  const o = opt || {}, mono = o.mono || [], v = { view: "\uE002" };   // 記號用私用區字元:不會出現在正常文字裡
  mono.forEach((k, i) => { if (vars && k in vars) v[k] = "\uE000" + i + "\uE001"; });
  Object.keys(vars || {}).forEach((k) => { if (!(k in v)) v[k] = vars[k]; });
  t(key, v).split(/(\uE000\d+\uE001|\uE002)/).forEach((piece) => {
    if (piece === "\uE002") { if (o.view) host.append(o.view); }
    else if (piece.charCodeAt(0) === 0xE000) { const sp = document.createElement("span"); sp.className = "mono"; sp.textContent = String((vars || {})[mono[+piece.slice(1, -1)]]); host.append(sp); }
    else if (piece) host.append(piece);
  });
}
var CS_BOOTED = false;   // 對話接回之後才講事後那一行,不然 csOpen 清聊天時會一起清掉
const UP_SAID_KEY = "ws_upd_said";   // 講過的記號(localStorage:報告的 done 會停留到下一次更新,重開 app 不重講)
function upSayLines(cst) {
  if (!CS_BOOTED) return;
  let said = []; try { said = JSON.parse(lsGet(UP_SAID_KEY) || "[]"); } catch (_) { said = []; }
  if (!Array.isArray(said)) said = [];
  const lines = [upBackupLine(UP), cst && envCloudKind(cst) === "running" ? upDoneLine(upWu(cst.report), UPD) : null];
  lines.forEach((L) => {
    if (!L || said.indexOf(L.key) >= 0) return;
    said.push(L.key); lsSet(UP_SAID_KEY, JSON.stringify(said.slice(-20)));
    upSayLine(L);
  });
}
function upSayLine(L) {
  const el = document.createElement("div"); el.className = "msg sys";
  let view = null;
  if (L.view) { view = document.createElement("button"); view.type = "button"; view.className = "btn-quiet"; view.textContent = t(L.view === "local" ? "up.backup.open" : "up.done.view"); view.addEventListener("click", () => upView(L)); }
  upRich(el, L.head[0], L.head[1], { mono: ["cv", "av", "n", "dir"], view });
  if (L.tail) { if (LANG !== "zh") el.append(" "); upRich(el, L.tail[0], L.tail[1], { mono: ["n", "dir"], view }); }
  srSay(el.textContent);
  $("chat-scroll").appendChild(el); busyPin(); scrollChat();
}
/* 「查看」:本機備份 → 主行程開 Finder(路徑由主行程算,畫面不交路徑);雲端備份 → 在本機聊天送一句固定的話請這台電腦的 agent 列出
   (本機回合,不碰雲端 agent);回合在跑時 submitMessage 會回 false,什麼都不做 */
function upView(L) {
  if (L.view === "local") { window.blave.updateShowBackup(); return; }
  submitMessage(t("up.done.viewMsg", { dir: L.dir || "" }), { viewing: { env: "cloud" } });
}
function upLocalTurn() { try { return running === true; } catch (_) { return false; } }   // app.js 還沒跑到 `let running` 那一行時讀它會丟 TDZ
var UP_CHECKING = false;   // 按了「檢查更新」、兩邊都還沒回來:連結上是圓環
function upNow() {
  const cst = TR_BAGS.cloud.st, kind = cst ? envCloudKind(cst) : "loading";
  return upPlan({ up: UP, cloud: (cst && cst.cloud) || null, kind, localTurn: upLocalTurn(), mem: UPD, now: Date.now(),
    cloudStale: !!(cst && trRestartUnconfirmed(cst.report)), wu: kind === "running" ? upWu(cst.report) : null, checking: UP_CHECKING });
}
/* 一回合結束了(turn-end 叫;回合出錯 / 沒回覆 / 分類過的錯誤都算 fault)。只管更新期間內的回合。
   回合出錯、或整回合沒碰雲端主機:什麼都沒換,更新期間到此為止(之後無關的回合不再被畫成更新中);
   碰了雲端、正常結束:立刻強制問一次雲端(主機已回報就不必等下一輪輪詢),期間留到版號追上 / 30 分鐘沒回合 */
function upTurnEnded(faulted) {
  if (!UPD.cloudTurn && !UPD.session) return;
  const touched = UPD.turnCloud;
  UPD.cloudTurn = false; UPD.turnCloud = false;
  if (faulted || !touched) { UPD.session = null; return; }
  if (window.blave && typeof window.blave.cloudRefresh === "function") window.blave.cloudRefresh().catch(() => {}).then(() => { ENV.cloudDirty = true; if (typeof trPoll === "function") trPoll(); });
}
function upPaint() {
  const cst = TR_BAGS.cloud.st, kind = cst ? envCloudKind(cst) : "loading";
  if (cst) upMachineGone(UPD, kind);
  if (kind === "running") upObserve(UPD, cst.cloud, trRestartUnconfirmed(cst.report), upLocalTurn(), Date.now());
  const p = upNow();
  // 關於那一行:段與段之間半形「 · 」,版號 mono;狀態字不換色
  const line = $("set-up-line"); line.textContent = "";
  p.row.segs.concat(p.row.status ? [p.row.status] : []).forEach((s, i) => { if (i) line.append(" · "); upRich(line, s[0], s[1], { mono: ["av", "cv", "nv"] }); });
  // 右邊那個文字連結:檢查更新 / 重新啟動以完成更新;檢查中是 16/2 圓環(被按的控件自己的回饋),不寫「檢查中」
  const btn = $("set-up-btn"); btn.textContent = ""; btn.dataset.kind = p.link.kind;
  if (p.spin) { const sp = document.createElement("span"); sp.className = "spin16"; sp.setAttribute("aria-hidden", "true"); btn.append(sp); btn.setAttribute("aria-label", t("up.check")); }
  else { btn.append(t(p.link.kind === "restart" ? "up.restart" : "up.check")); btn.removeAttribute("aria-label"); }
  // 「檢查更新」在有雲端主機在跑時也會把它更新掉(v4 零選擇):hover 先講,用戶才不會以為只查了 app
  const tip = p.link.kind === "check" && kind === "running" ? t("up.check.cloudTip") : "";
  btn.disabled = !!p.link.disabled; btn.title = p.link.kind === "restart" && p.link.disabled ? t("up.busy") : tip;
  // 聊天輸入列右上那一格(照網頁 .ws-update):更新中不可點(aria-disabled,不是 disabled:讀屏停得上去、字色不退成停用灰)
  const w = $("ws-update");
  if (w) {
    const k = p.slot ? p.slot.kind : "", hadFocus = document.activeElement === w;
    w.hidden = !p.slot; w.dataset.kind = k;
    w.firstElementChild.textContent = k === "applying" ? t("up.applying") : k === "restart" ? t("up.restart") : "";
    w.disabled = !!(p.slot && p.slot.disabled); w.setAttribute("aria-disabled", k === "applying" ? "true" : "false");
    w.classList.toggle("is-status", k === "applying");
    w.title = p.slot && p.slot.disabled ? t("up.busy") : "";
    if (hadFocus && w.hidden) $("ta").focus();   // 那一格收掉了:焦點不能掉到 BODY
  }
  upSayLines(cst);
}
/* 「檢查更新」:app 重查一次 + 雲端強制刷新一次報告;報告說落後(而且主機沒在換檔、這裡沒有回合在跑、也不在更新期間)就在本機聊天
   送那一句固定的話,本機 agent 經 MCP 去做(零選擇)。結果沒變就回到原樣,什麼都不說 */
async function upCheck() {
  if (UP_CHECKING) return;
  UP_CHECKING = true; upPaint();
  try { await Promise.all([window.blave.updateCheck().then(upRefresh).catch(() => {}), upCloudRecheck()]); }
  finally { UP_CHECKING = false; upPaint(); }
}
async function upCloudRecheck() {
  if (typeof window.blave.cloudRefresh !== "function" || typeof trPoll !== "function") return;
  try { await window.blave.cloudRefresh(); } catch (_) { return; }   // 主行程沒回:這次不動雲端
  // app.js 不自己讀交易狀態:標記要重讀、跑一輪輪詢(trade.js 那一份就是畫面用的);在途那一輪結束會立刻再跑一次,等它把記號清掉
  ENV.cloudDirty = true; await trPoll();
  for (let i = 0; i < 30 && ENV.cloudDirty; i++) await new Promise((r) => setTimeout(r, 100));
  const p = upNow();
  if (!p.cloudLag || (p.slot && p.slot.kind === "applying") || upLocalTurn() || UPD.session) return;
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);   // 聊天欄收著就先展開:過程在那裡
  const c = (TR_BAGS.cloud.st && TR_BAGS.cloud.st.cloud) || {}, now = Date.now();
  Object.assign(UPD, { done: null, cloudTurn: true, session: { startAt: now, lastTurnAt: now, fromCv: c.config_version || null, nv: c.latest_config_version || null } });
  await submitMessage(t("up.c.msg"), { viewing: { env: "cloud" } });
  if (!upLocalTurn()) upTurnEnded(true);   // 沒送出去(上一輪還在跑 / 版本被停用)、或回合在回來之前就結束了(同步拋錯):不進更新期間
}
async function upInstall() {
  if (upLocalTurn()) return;   // 主行程也擋一次(update-install):回合在跑不重開(重開會把它斷掉)
  const r = await window.blave.updateInstall(); if (r && !r.ok) upRefresh();
}
function upRefresh() { return window.blave.updateState().then((st) => { UP = st; upPaint(); }).catch(() => {}); }
window.blave.onUpdateState((st) => { UP = st; upPaint(); });
upRefresh();
$("ws-update").addEventListener("click", () => { if ($("ws-update").dataset.kind === "restart") upInstall(); });
$("set-up-btn").addEventListener("click", () => { if ($("set-up-btn").dataset.kind === "restart") upInstall(); else upCheck(); });
$("set-terms").addEventListener("click", () => window.blave.openExternal(legalUrl("terms_of_service")));   // 服務條款:跟版本資訊同一塊(設定 › 一般 › 關於)
$("set-privacy").addEventListener("click", () => window.blave.openExternal(legalUrl("privacy_policy")));
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
    b.addEventListener("click", (e) => mpPickModel(x.id, e.detail > 0));   // detail > 0 = 真的滑鼠點;鍵盤的 Enter / Space 是 0
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

function mpPickModel(id, viaMouse) {
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
/* Esc 關最上面那一層,焦點在哪都一樣:點了框裡的字、從對話清單的 ✕ 開、視窗切回來,焦點會落在 body,
   掛在各框 scrim 上的 keydown 收不到(Wei 09-23 實機)。一次只關一層;由上往下照 DOM 疊的順序 */
function escTop() {
  return !$("del-scrim").hidden ? () => delClose(false) : !$("cx-scrim").hidden ? () => cxModalClose(false)
    : !$("lb-scrim").hidden ? lbClose : !$("set-scrim").hidden ? setClose : !$("mp-panel").hidden ? () => mpClose(true)
    : !$("cs-list").hidden ? () => { csShowList(false); $("cs-toggle").focus(); } : null;
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.isComposing || e.keyCode === 229) return;   // 輸入法組字中的 Esc 是取消選字(同 trade.js envWire)
  const close = escTop(); if (close) { e.preventDefault(); close(); }
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
/* 雲端那一邊選中的那支(spec §1.3:選中的策略、報告分頁各邊一份)。#rp 是共用的 DOM,資料來自主行程的 cloudStrategy
   (api 的 /cloud/strategy = 同一份 stats.json + 程式碼),用跟本機同一套 renderBacktest / renderTrades 畫。
   雲端來的字串一律 textContent;這一袋不落地、不寫 localStorage(重開 app 一律回這台電腦)。 */
const RPC = { name: null, data: null, tab: "bt", drawn: {} };
const rpBag = () => (typeof ENV !== "undefined" && ENV.cur === "cloud" ? RPC : RP);
/* 送出當下畫面上開著什麼 → 給 agent 釐清「這支 / 這裡」用(跟雲端工作頁同一份契約)。
   `env` 永遠帶(A′:操作對象隨視角走——雲端視角送出的那一句要做在雲端主機上);雲端視角指的策略是雲端那一份(RPC)。 */
function chatViewing() {
  const cloud = typeof ENV !== "undefined" && ENV.cur === "cloud", env = cloud ? "cloud" : "local", B = cloud ? RPC : RP;
  if (typeof TR_BAGS !== "undefined" && TR_BAGS[env].open && !$("tr").hidden) return { env, view: "portfolio" };
  if (!$("rp").hidden && B.name && B.data) return { env, strategy: B.name, tab: B.tab === "bt" ? "data" : B.tab === "code" ? "code" : null };
  return { env };
}

/* 側欄策略列的 tooltip:顯示名稱 + 資料夾代號(兩支都叫「BTC 4 小時…」時分得出來);名稱就是代號時只放一次 */
function stratTip(display, name) {
  const d = typeof display === "string" ? display.trim() : "";
  return d && d !== name ? t("side.rowTip", { name: d, id: name }) : String(name || "");
}
function stratBlockedNote(code) {
  const p = document.createElement("p"); p.className = "cf-block";
  p.textContent = code === "IN_PORTFOLIO" ? t("strat.delInPf") : t("strat.delCfgUnread");
  return p;
}
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
    nm.textContent = x.displayName || x.name; nm.title = stratTip(x.displayName, x.name);
    b.append(nm);
    // 再點一次選中的那支 = 取消選取、回 welcome(Enter / Space 在按鈕上就是 click)。列不重建,焦點留在這一列
    b.addEventListener("click", () => stratSelect(x.name === RP.name ? null : x.name));
    // 列尾是刪除鈕,不是 Sharpe(Wei):數字在報告裡就有,清單上要的是能整理。
    // 按鈕不能包按鈕,所以外面多一層 wrap,刪除鈕絕對定位在列尾(同對話清單)。
    const wrap = document.createElement("div"); wrap.className = "strat-wrap cs-row";
    const del = armedDelete(wrap, t("strat.del"), async () => {
      const r = await window.blave.deleteStrategy(x.name);
      if (r === true) { stratRefresh(false); return; }
      // 還在下單設定的組合裡 / 讀不到下單設定:不刪,講原因(對帳器照這個名字在下單,刪了訊號就凍住)
      if (r && (r.code === "IN_PORTFOLIO" || r.code === "CONFIG_UNREADABLE")) {
        const title = t("cdel.title", { name: (x.displayName || x.name).slice(0, 40) });
        confirmBox({ title, lines: [], extra: stratBlockedNote(r.code), ok: t("cdel.gotIt"), opener: b, single: true, onOk: () => {},
          alt: r.code === "IN_PORTFOLIO" ? { label: t("cdel.goPos"), onOk: () => trOpen("pos") } : null });
      }
    });
    del.disabled = running;
    wrap.append(b, del);
    box.appendChild(wrap);
  });
  if (typeof envPaintLocalDots === "function") envPaintLocalDots();   // 列是重建的:呼吸點不等下一輪輪詢
  if (typeof libStratChanged === "function") libStratChanged();      // 策略庫列上的「已安裝」跟著本機清單走(renderer/library.js)
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
  if (name && typeof libLeave === "function") libLeave("local");   // 策略庫也收(renderer/library.js)
  RP.name = name; RP.drawn = {};
  $("strat-list").querySelectorAll(".strat-row").forEach((b) => {
    if (b.dataset.name === name) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  });
  // 中欄誰該出現由 envShowMain 決定(trade.js):雲端視角時這台電腦的三個視圖都收著,選中的那支照記、切回來才出現
  if (!name) { RP.data = null; envShowMain(); return; }
  RP.data = await window.blave.loadStrategy(name);
  if (RP.name !== name) return;                 // 等資料的時候用戶又點了別支
  if (!RP.data) { stratSelect(null); return; }
  envShowMain();
  // 在看雲端時本機這邊被 agent 動了(每輪結束的 stratRefresh):只記下,切回來 rpRepaint 再畫——那時 #rp 開著的是雲端那支,不可以拿本機的頁首去蓋它
  if (rpBag() === RP && !$("rp").hidden) { rpPaintHead(RP); rpShowTab(RP.data.stats ? RP.tab : "code"); }
}
/* 報告頁首(名字、說明、程式碼分頁)換成這一袋的。「送上雲端」只有這台電腦的策略才畫(雲端那份本來就在雲端);「拉回」在側欄列尾,不在這裡 */
function rpPaintHead(B) {
  $("rp-name").textContent = B.data.displayName || B.name;
  // 只放說明,不附資料夾代號(Wei):代號滑過 sidebar 那一列的 title 看得到
  $("rp-desc").textContent = B.data.description || "";
  $("rp-name").title = $("rp-name").textContent; $("rp-desc").title = B.data.description || "";   // 單行截斷,全文放 title
  hoPaint();   // 頁首右側:這台電腦那支 =「送上雲端」,雲端那支 =「拉回這台電腦」(renderer/handoff.js)
  $("rp-code-pre").textContent = B.data.code || "";
}
// 切視角之後:#rp 是共用的 DOM,頁首與圖都要換成這一邊選中的那支;圖若是在另一邊時畫的(容器藏著、量不到寬)也重畫
function rpRepaint() {
  const B = rpBag();
  if ($("rp").hidden || !B.data) return;
  B.drawn = {}; rpPaintHead(B); rpBodyPaint(B);
}
/* 報告本體:雲端那一份還在路上(pending: "loading")或讀不到("error")時,分頁列與三個分頁收起來,
   只放一行等待(沿用 .cx-wait + .spin16,同自動下單頁等回報那一句)或讀不到 +〔重新查看〕 */
/* 等待那一行的時機(canon › Loader › 時機;設計稽核 005 第 7 條):200ms 內拿到就不畫(網路快時不閃一下);畫了就至少撐 300ms。
   rpWaitShownAt = 這一次的等待真的出現在畫面上的時間(0 = 還沒出現) */
const RP_WAIT_DELAY_MS = 200, RP_WAIT_MIN_MS = 300;
let rpWaitShownAt = 0;
// 拿到報告時還要再等多久才換掉等待那一行:沒出現過 → 0;出現了 → 補滿 300ms。純函式
function rpWaitHold(shownAt, now) { return shownAt ? Math.max(0, RP_WAIT_MIN_MS - (now - shownAt)) : 0; }
function rpBodyPaint(B) {
  const w = $("rp-wait"), pend = B.data && B.data.pending;
  if (!pend) { rpShowTab(B.data.stats ? B.tab : "code"); return; }
  $("rp-tabs").hidden = true; $("rp-nobt").hidden = true;
  for (const k of ["bt", "tr", "rob", "code"]) $("rp-" + k).hidden = true;
  w.hidden = false; w.textContent = "";
  const line = document.createElement("p");
  if (pend === "loading") {
    line.className = "cx-wait"; const sp = document.createElement("span"); sp.className = "spin16"; sp.setAttribute("aria-hidden", "true");
    line.append(sp, t("tr.loading")); line.hidden = true; w.appendChild(line);
    rpWaitShownAt = 0;
    setTimeout(() => { if (line.isConnected && !w.hidden) { line.hidden = false; rpWaitShownAt = Date.now(); } }, RP_WAIT_DELAY_MS);   // 已經換成報告(w 收起)就不翻出來
    return;
  }
  // 讀不到:句子只講事實(旁邊就是〔重新查看〕,不再叫人「再點一次」);重試是資料 panel 的 Retry = 描邊鈕,放在句子下一行
  line.className = "plan-err"; const m = document.createElement("span"); m.className = "fault-mark"; m.setAttribute("aria-hidden", "true");
  const again = document.createElement("button"); again.type = "button"; again.className = "btn-out"; again.id = "rp-retry"; again.textContent = t("plan.recheck");
  again.addEventListener("click", () => rpCloudSelect(RPC.name, true));
  line.append(m, t("tr.cloud.reportUnreach")); w.append(line, again);
}
/* 雲端清單點一支(trade.js 的 envPaintSide):中欄畫雲端那一份的報告。null = 收掉、回雲端自動下單頁(#tr-nav)。
   讀不到 / 雲端現在沒有這一份 → 收掉選取、在回到的自動下單頁紅字槽講一句;不退回去讀這台電腦的同名那支。
   被刪、429、斷網都壓成 null,分不出來,所以同一句、不講要等幾秒。紅字槽被指令的失敗佔著時不蓋它(那句更要緊),只唸給報讀器。 */
/* 點過的雲端報告留一份:再點同一支先畫這份、背景再抓(同網頁工作頁「先有東西、抓到才換」);rpcSeq = 最後一次點的那一趟 */
const RPC_CACHE = new Map();
let rpcSeq = 0;
// 還沒拿到報告時那一袋的 data:頁首先放清單上的名字,本體由 rpBodyPaint 畫等待 / 讀不到
function rpPending(name, state) {
  const x = envCloudList(TR_BAGS.cloud.st).find((y) => y.name === name);
  return { name, displayName: x ? x.displayName : name, description: "", code: "", stats: null, pending: state };
}
function rpCloudPaint() {
  trPaint();                                      // envShowMain 會把 #rp 掀開(仍在雲端視角時)
  if (!$("rp").hidden && ENV.cur === "cloud") { rpPaintHead(RPC); rpBodyPaint(RPC); }
}
async function rpCloudSelect(name, force) {
  if (name === RPC.name && !force) return;
  const seq = ++rpcSeq;
  RPC.name = name; RPC.drawn = {};
  if (name && typeof libLeave === "function") libLeave("cloud");   // 雲端視角的策略庫也收(renderer/library.js)
  ENV.sig.side = null;                            // 側欄的 aria-current 跟著換
  const C = TR_BAGS.cloud;
  if (!name) { RPC.data = null; trPaint(); return; }
  if (C.alertSrc === "report") trAlert("", null, C);   // 上一版讀不到時講在自動下單頁的那句:收掉
  // 先換頁,不等雲端:有快取就畫快取,沒有就畫「載入中…」
  const cached = RPC_CACHE.get(name) || null;
  RPC.data = cached || rpPending(name, "loading");
  rpCloudPaint();
  const d = await C.api.loadStrategy(name);
  if (seq !== rpcSeq || RPC.name !== name) return;   // 等的時候又點了別支 / 切走了:最後一次點的算,這一份不畫
  if (!cached) {                                  // 等待那一行出現過:撐滿 300ms 再換,不閃
    const hold = rpWaitHold(rpWaitShownAt, Date.now());
    if (hold) { await new Promise((r) => setTimeout(r, hold)); if (seq !== rpcSeq || RPC.name !== name) return; }
  }
  if (!d) {
    if (cached) return;                           // 背景重抓失敗:手上那份照留
    RPC.data = rpPending(name, "error"); rpCloudPaint();   // #rp-wait 是 role=status:換成讀不到那一句時就會唸,不再另外 srSay(會唸兩遍)
    return;
  }
  RPC_CACHE.set(name, d);
  if (cached && JSON.stringify(cached) === JSON.stringify(d)) return;   // 背景重抓沒變:不重畫(圖不閃)
  RPC.data = d; RPC.drawn = {};
  rpCloudPaint();
}
// 雲端清單每輪重讀:看著的那支不在了(被刪、換了帳號)→ 收掉
function rpCloudPrune(list) {
  for (const k of [...RPC_CACHE.keys()]) if (!list.some((x) => x.name === k)) RPC_CACHE.delete(k);   // 不在清單上的報告不留
  if (RPC.name && !list.some((x) => x.name === RPC.name)) rpCloudSelect(null);
}

/* 分頁第一次被看到才畫(進出場那張 K 線圖不便宜);同一支策略切回來不重畫。畫的是現在這一邊那一袋(RP / RPC)。 */
function rpShowTab(tab) {
  const B = rpBag();
  B.tab = tab;
  $("rp-wait").hidden = true; $("rp-tabs").hidden = false;   // 等待 / 讀不到那一行(rpBodyPaint)收起
  const has = !!(B.data && B.data.stats);
  $("rp-tabs").querySelectorAll(".rp-tab").forEach((b) => {
    const on = b.dataset.tab === tab;
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.disabled = !has && b.dataset.tab !== "code";
  });
  $("rp-nobt").hidden = has;   // 同一個 has:沒有回測就在分頁列正下方講一句(兩個視角都出)
  for (const k of ["bt", "tr", "rob", "code"]) $("rp-" + k).hidden = k !== tab;
  if (!has || B.drawn[tab]) return;
  B.drawn[tab] = true;
  const R = window.BlaveReport || {};
  if (tab === "bt" && R.renderBacktest) R.renderBacktest($("rp-bt"), B.data.stats);
  if (tab === "tr" && R.renderTrades) R.renderTrades($("rp-tr"), B.data.stats);
  // 參數掃描(report-robust.js 不碰桌面版全域:i18n、掃描鈕的送出、回合狀態、meta 那一行都從這裡交進去)
  if (tab === "rob" && R.renderRobust) R.renderRobust($("rp-rob"), { stats: B.data.stats, scan: B.data.scan || null, code: B.data.code, name: B.name }, rpRobOpts());
}
// 交給 report-robust.js 的環境:回合狀態(busy + 序號)與這一袋是哪一邊(scope:本機 / 雲端同名策略的「已送出」不互相污染)
function rpRobOpts() {
  const R = window.BlaveReport || {};
  return { t, busy: running, turn: turnSeq, scope: rpBag() === RPC ? "cloud" : "local", onScan: rpRobAsk, buildMeta: R.buildMeta };
}
/* 「開始掃描」:確認框 → 固定訊息進對話(同雲端工作頁 robAskScan)。不覆寫 viewing:rpBag()===RPC ⇔ ENV.cur==="cloud" ⇔ chatViewing 本來就回 env:cloud,
   而且還帶著 strategy 欄位(覆寫成 { env } 會把它丟掉)。回 Promise<turn|false> = 跑起來的那一回合的序號;取消的話不會 resolve(模組不等它,沒有東西掛在上面) */
function rpRobAsk(name, opener) {
  return new Promise((resolve) => confirmBox({ title: t("rob.btnScan"), lines: [t("rob.emptyCap")], ok: t("rob.cfOk"), opener, env: rpBag() === RPC ? "cloud" : undefined,
    onOk: () => submitMessage(t("rob.msgScan", { name })).then((ok) => resolve(ok ? turnSeq : false)) }));
}
/* 回合開始 / 結束:參數掃描分頁的空狀態要跟著換鈕態(回合中鎖鈕、結束解鎖)。就地改鈕、不整塊重畫(焦點不掉到 body;有掃描結果的頁沒有鈕,模組自己略過) */
function rpRobSync() {
  const B = rpBag(), R = window.BlaveReport || {};
  if (B.drawn.rob && R.robSync) R.robSync($("rp-rob"), rpRobOpts());
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
  liveBubble = null; busy = null; swLine = null;
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
// 用 trade.js 那顆 trStamp(MM/DD HH:mm,24 小時制):toLocaleString 會跟著語系給 12 小時制與不補零的月日
function csTime(sec) { return trStamp(sec); }
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
   mark = 標題左邊的帳戶記號文字(「模擬」);extra = 接在段落後面的一個 DOM 節點(呼叫端自己用 textContent 建);
   okDisabled = 主要鈕真的 disabled(內容說明為什麼不能按,例:超過上限)。框內排版有一組通用的 .cf-*(app.css):
   .cf-rows > .cf-row(dt 說明 / dd 數字靠右;.total 大一階、.lev 小一階、.over 紅)、.cf-removed、.cf-block(紅,擋下的原因)、.cf-note(最淡的警語)。 */
/* env / footWhere(規格 spec-desktop-local-and-cloud §1.2):寫進雲端的確認框要標明目的地——標題列灰底 +「雲端」記號,
   鈕正上方再一行 {哪一台} · {真錢/模擬} · {交易所}。markKind = 錢記號的顏色(real / paper),lead = 放在所有句子最上面的那一塊
   (今天只有「兩邊都真錢」那個灰記號)。**都不給就跟以前一模一樣**。 */
function confirmBox({ title, lines, ok, onOk, opener, alt, mark, markKind, extra, okDisabled, okWhy, env, footWhere, lead, single }) {
  $("del-title").textContent = title;
  const body = $("del-body"); body.className = "del-body lines"; body.textContent = "";
  if (lead) body.appendChild(lead);
  lines.forEach((x) => { const p = document.createElement("p"); p.textContent = x; if (okDisabled && okWhy && x === okWhy) p.id = "del-ok-why"; body.appendChild(p); });
  if (extra) body.appendChild(extra);
  $("del-ok").textContent = ok; $("del-ok").disabled = !!okDisabled;
  // okWhy = 停用的主鈕為什麼按不了(lines 裡的那一句):讀屏停在鈕上時唸得到
  if (okDisabled && okWhy && $("del-ok-why")) $("del-ok").setAttribute("aria-describedby", "del-ok-why"); else $("del-ok").removeAttribute("aria-describedby");
  $("del-modal").querySelector(".modal-head").classList.toggle("cloud", env === "cloud");
  $("del-env").hidden = env !== "cloud"; $("del-env").textContent = env === "cloud" ? t("env.cloud") : "";
  $("del-where").hidden = !footWhere; $("del-where").textContent = footWhere || "";
  $("del-mark").className = "mode " + (markKind || "paper");
  $("del-mark").hidden = !mark; $("del-mark").textContent = mark || "";
  $("del-alt").hidden = !alt; $("del-alt").textContent = alt ? alt.label : "";
  $("del-alt").classList.toggle("cf-alt-danger", !!(alt && alt.danger));
  $("del-modal").classList.toggle("has-alt", !!alt);
  delCtx = { custom: true, onOk, onAlt: alt && alt.onOk, opener };
  $("view-ws").inert = true; $("set-scrim").inert = true;
  // single:只有一顆鈕(「知道了」那種:沒有要取消的事)。焦點給它;Esc / 框外 / ✕ 照舊關
  $("del-cancel").hidden = !!single;
  const sc = $("del-scrim"); sc.hidden = false;
  requestAnimationFrame(() => sc.classList.add("open"));
  if (single) $("del-ok").focus(); else $("del-cancel").focus();
}
function delClose(deleted) {
  const sc = $("del-scrim"); if (sc.hidden || sc.dataset.lock) return;   // lock:策略庫購買扣款在路上(library.js libPurchase),Esc / ✕ / 框外都不關
  sc.classList.remove("open"); sc.hidden = true;
  $("view-ws").inert = false; $("set-scrim").inert = false;
  const c = delCtx; delCtx = null;
  // 下一個用這個框的人(刪對話)不該看到上一個的第二顆鈕、也不該看到上一個的「雲端」記號
  $("del-alt").hidden = true; $("del-mark").hidden = true; $("del-modal").classList.remove("has-alt"); $("del-ok").disabled = false; $("del-ok").removeAttribute("aria-describedby");
  $("del-env").hidden = true; $("del-where").hidden = true; $("del-modal").querySelector(".modal-head").classList.remove("cloud"); $("del-cancel").hidden = false;
  if (deleted) $("cs-newrow").focus();
  else if (c && c.opener && c.opener.isConnected) c.opener.focus();
}
$("del-cancel").addEventListener("click", () => delClose(false));
$("del-close").addEventListener("click", () => delClose(false));
$("del-scrim").addEventListener("mousedown", (e) => { if (e.target === $("del-scrim")) delClose(false); });
$("del-scrim").addEventListener("keydown", (e) => trapTab(e, $("del-modal")));
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
/* 捲到頭底下才浮一條線(靜止沒有線):清單那一層也會捲,兩層都掛,以現在看得見的那一層為準 */
function chatEdge() {
  const list = $("cs-list"), box = list.hidden ? $("chat-scroll") : list;
  $("cs-head").classList.toggle("is-scrolled", box.scrollTop > 0);
}
$("chat-scroll").addEventListener("scroll", chatEdge);
$("cs-list").addEventListener("scroll", chatEdge);
function csShowList(on) {
  $("cs-list").hidden = !on;
  $("cs-head").classList.toggle("is-list", on);
  $("cs-toggle").setAttribute("aria-expanded", on ? "true" : "false");
  $("cs-toggle").setAttribute("aria-label", t(on ? "cs.back" : "cs.all"));
  // 被清單蓋住的聊天本體退出 Tab 順序與輔具樹
  $("chat-scroll").inert = on; document.querySelector(".chat-input-wrap").inert = on;
  if (on) csRenderList();
  chatEdge();
}
$("cs-toggle").addEventListener("click", () => csShowList($("cs-list").hidden));
$("cs-new").addEventListener("click", csStartNew);
$("cs-newrow").addEventListener("click", csStartNew);
/* 開場:接回上次那條。db 裡找不到(被刪了、或還沒講過話)就是一條新的 */
async function csInit() {
  let saved = null;
  try { saved = localStorage.getItem("ws_session"); } catch (_) { /* noop */ }
  if (saved && /^desktop-[a-z0-9]{4,16}$/.test(saved)) await csOpen(saved);
  else csRenderHead();
}
let running = false;
let turnSeq = 0;   // 回合序號:每跑起來一輪 +1。參數掃描分頁的「已送出」只認送出那一輪(掃描回合沒產出,下一輪無關的回合不可以又鎖回「已送出」)
let liveBubble = null;

function scrollChat() { $("chat-scroll").scrollTop = $("chat-scroll").scrollHeight; chatEdge(); }

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
   2. markdown 照網頁工作頁(marked,gfm + breaks)的規則排:標題、清單(含巢狀)、表格、``` 圍欄、引言、分隔線,
      行內粗體 / 斜體 / 刪除線(只認 ~~,單一個 ~ 是「0.1~2.38」的範圍符號)/ 程式碼 / 連結 / 換行。
      網頁是 marked 產 HTML 再過 DOMPurify;這裡不解讀 HTML:只產結構,DOM 由 mdPaint 一個節點一個節點組,
      字串一律走 textContent。agent 寫的 `<img onerror=…>`、`<b>` 原樣當文字顯示。 */
const CARD_TAG = /<blave-card:([a-z-]+)\/>/g;
/* 純函式(tests/check_shell_paint.js 直接測它):原文 → { cards, blocks }。``` 圍欄裡的東西一個字都不動——
   `f(**a, **b)`、`2**3` 被當成粗體吃掉星號的話,用戶照畫面抄策略碼會抄錯。`live` = 還在串流:尾端半截的標記
   先藏起來;回合結束後用 live=false 重畫一次,真的以 `<` 結尾的回覆才不會被永久吃掉。 */
function aiParts(raw, live) {
  const cards = [];
  let text = String(raw).replace(CARD_TAG, (_m, name) => { cards.push(name); return ""; });
  if (live) {
    const lt = text.lastIndexOf("<");
    if (lt >= 0 && text.length - lt <= 40 && "<blave-card:".startsWith(text.slice(lt, lt + 12)) && !text.slice(lt).includes(">")) text = text.slice(0, lt);
  }
  if (cards.length) text = text.replace(/\s+$/, "");
  return { cards, blocks: mdBlocks(text, 0) };
}
const MD_FENCE = /^( {0,3})(`{3,}|~{3,})([^`]*)$/;
const MD_HEAD = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const MD_HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const MD_QUOTE = /^ {0,3}> ?(.*)$/;
const MD_LI = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const MD_DEPTH = 12;     // 巢狀上限:再深的當純文字,病態輸入(幾萬個 >)不會把堆疊撐爆
const mdIndent = (s) => /^ */.exec(s)[0].length;
function mdCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}
/* 表頭 + 分隔列(|---|:--:|)成立、欄數一樣才是表格(GFM);回傳每欄的對齊 */
function mdTableAt(lines, i) {
  if (i + 1 >= lines.length || lines[i].indexOf("|") < 0 || lines[i + 1].indexOf("|") < 0) return null;
  const head = mdCells(lines[i]), delim = mdCells(lines[i + 1]);
  if (head.length !== delim.length || !delim.every((c) => /^:?-+:?$/.test(c))) return null;
  return delim.map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : /^:/.test(c) ? "left" : ""));
}
/* 會打斷段落的行(同 marked:清單只有「非空的 - * + 或 1.」才打斷,「2. 」接在段落裡是字) */
function mdStarts(lines, i) {
  const s = lines[i], li = MD_LI.exec(s);
  return MD_FENCE.test(s) || MD_HEAD.test(s) || MD_HR.test(s) || MD_QUOTE.test(s) || !!mdTableAt(lines, i) ||
    (!!li && li[1].length < 4 && li[4].trim() !== "" && (!/\d/.test(li[2]) || /^1[.)]$/.test(li[2])));
}
function mdBlocks(text, depth) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/^\t+/, (t) => "    ".repeat(t.length)));
  if (depth > MD_DEPTH) return [{ p: [{ text: lines.join("\n") }] }];
  const out = [];
  let i = 0, m;
  while (i < lines.length) {
    const s = lines[i];
    if (!s.trim()) { i++; continue; }
    if ((m = MD_FENCE.exec(s))) {
      const ind = m[1].length, fence = m[2], body = [];
      const closes = (l) => { const x = l.trim(); return mdIndent(l) < 4 && x.length >= fence.length && x === fence[0].repeat(x.length); };
      for (i++; i < lines.length && !closes(lines[i]); i++) body.push(lines[i].slice(Math.min(ind, mdIndent(lines[i]))));
      i++;                                                   // 收尾那行;串流中還沒收尾 = 一路到底
      out.push({ code: body.join("\n"), lang: m[3].trim().split(/\s+/)[0] });
    } else if ((m = MD_HEAD.exec(s))) {
      out.push({ h: m[1].length, inl: mdInline(m[2] || "", 0) }); i++;
    } else if (MD_HR.test(s)) {
      out.push({ hr: true }); i++;
    } else if (MD_QUOTE.test(s)) {
      const body = [];
      for (; i < lines.length && lines[i].trim(); i++) {
        const q = MD_QUOTE.exec(lines[i]);
        if (q) body.push(q[1]); else if (!mdStarts(lines, i)) body.push(lines[i]); else break;
      }
      out.push({ quote: mdBlocks(body.join("\n"), depth + 1) });
    } else if (mdTableAt(lines, i)) {
      const align = mdTableAt(lines, i), head = mdCells(s).map((c) => mdInline(c, 0)), rows = [];
      for (i += 2; i < lines.length && lines[i].trim() && !mdStarts(lines, i); i++) {
        const c = mdCells(lines[i]); rows.push(align.map((_a, k) => mdInline(c[k] || "", 0)));
      }
      out.push({ table: { align, head, rows } });
    } else if ((m = MD_LI.exec(s)) && m[1].length < 4) {
      const r = mdList(lines, i, depth); out.push(r.block); i = r.next;
    } else {
      const para = [s];
      let setext = 0;
      for (i++; i < lines.length && lines[i].trim(); i++) {
        if (/^ {0,3}=+[ \t]*$/.test(lines[i])) { setext = 1; i++; break; }
        if (/^ {0,3}-+[ \t]*$/.test(lines[i])) { setext = 2; i++; break; }
        if (mdStarts(lines, i)) break;
        para.push(lines[i]);
      }
      const inl = mdInline(para.map((l) => l.replace(/^ +/, "")).join("\n").replace(/\s+$/, ""), 0);
      out.push(setext ? { h: setext, inl } : { p: inl });
    }
  }
  return out;
}
/* 一份清單:每項的內容 = 縮排到內容欄(記號後面那格)以上的行,去掉縮排後遞迴排版——巢狀清單、項目裡的圍欄都從這裡來。
   換記號(- 換 *、1. 換 1))= 另一份清單,同 CommonMark。 */
function mdList(lines, i, depth) {
  const first = MD_LI.exec(lines[i]), ordered = /\d/.test(first[2]), mark = first[2].slice(-1), items = [];
  const same = (x) => !!x && x[1].length < 4 && x[2].slice(-1) === mark && /\d/.test(x[2]) === ordered;
  while (i < lines.length) {
    const m = MD_LI.exec(lines[i]);
    if (!same(m)) break;
    const sp = m[3].length, col = m[1].length + m[2].length + (sp === 0 || sp > 4 ? 1 : sp), body = [m[4]];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (!l.trim()) {
        let k = j + 1; while (k < lines.length && !lines[k].trim()) k++;
        if (k < lines.length && mdIndent(lines[k]) >= col) { for (; j < k; j++) body.push(""); continue; }
        break;
      }
      if (mdIndent(l) >= col) { body.push(l.slice(col)); j++; continue; }
      if (body[body.length - 1].trim() && !MD_LI.test(l) && !mdStarts(lines, j)) { body.push(l.trim()); j++; continue; }   // 段落的懶散續行
      break;
    }
    items.push(mdBlocks(body.join("\n"), depth + 1));
    i = j;
    if (i < lines.length && !lines[i].trim()) {           // 項目之間隔空行:下一個非空行是同一種記號才還是這份清單
      let k = i; while (k < lines.length && !lines[k].trim()) k++;
      if (k < lines.length && same(MD_LI.exec(lines[k]))) i = k; else break;
    }
  }
  return { block: { list: { ordered, start: ordered ? parseInt(first[2], 10) : 1, items } }, next: i };
}
/* 行內:最左邊先配到的那個贏;同一個位置照這個順序(程式碼 > 跳脫 > 連結 > 網址 > 粗體 > 斜體 > 刪除線 > 換行) */
const MD_INL = new RegExp([
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.source,                                                           // 1,2 程式碼
  /\\([!-/:-@[-`{-~])/.source,                                                                           // 3 跳脫
  /(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*<?([^\s<>()]*(?:\([^\s()]*\)[^\s<>()]*)*)>?(?:\s+"[^"\n]*")?\s*\)/.source,  // 4,5,6 連結 / 圖
  /<(https?:\/\/[^\s<>]+)>/.source,                                                                      // 7
  /(https?:\/\/[^\s<>"]*[^\s<>"?!.,:;*_~)'\]}。，、；：！？）」』])/.source,                                 // 8 裸網址
  /\*\*(?=\S)([\s\S]*?\S)\*\*/.source,                                                                   // 9
  /(?<!\w)__(?=\S)([\s\S]*?\S)__(?!\w)/.source,                                                          // 10
  /\*(?=[^\s*])([\s\S]*?[^\s*])\*/.source,                                                               // 11
  /(?<!\w)_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/.source,                                                    // 12
  /~~(?=[^\s~])([\s\S]*?[^\s~])~~/.source,                                                               // 13
  /<[bB][rR]\s*\/?>|\n/.source,                                                                         // 換行;表格儲存格裡常見的 <br> 也當換行(其餘 HTML 一律當字)
].join("|"), "g");
/* 連結只收 http(s)。其餘(javascript:、相對路徑)只顯示字。點下去由 #chat-scroll 的委派交給系統瀏覽器(見 addMsg 下面) */
const mdHref = (u) => (/^https?:\/\/[^\s]+$/i.test(u) ? u : null);
function mdInline(s, depth) {
  const out = [];
  if (!s) return out;
  if (depth > MD_DEPTH) return [{ text: s }];
  const re = new RegExp(MD_INL.source, "g");
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    last = re.lastIndex;
    const sub = (x) => mdInline(x, depth + 1);
    if (m[1] != null) out.push({ code: /^ [\s\S]*[^ ][\s\S]* $/.test(m[2]) ? m[2].slice(1, -1) : m[2] });
    else if (m[3] != null) out.push({ text: m[3] });
    else if (m[5] != null) {
      const href = mdHref(m[6]), kids = sub(m[5] || m[6]);
      out.push(href ? { a: href, kids } : { span: kids });
    } else if (m[7] != null || m[8] != null) { const u = m[7] || m[8]; out.push({ a: u, kids: [{ text: u }] }); }
    else if (m[9] != null || m[10] != null) out.push({ strong: sub(m[9] != null ? m[9] : m[10]) });
    else if (m[11] != null || m[12] != null) out.push({ em: sub(m[11] != null ? m[11] : m[12]) });
    else if (m[13] != null) out.push({ del: sub(m[13]) });
    else out.push({ br: true });
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}
function paintAi(el, raw, live) {
  el._raw = raw;
  const r = aiParts(raw, live !== false);
  el._cards = r.cards;
  el.textContent = "";
  mdPaint(el, r.blocks);
}
/* 結構 → DOM。一個節點一個節點組:字只經 textContent / createTextNode 進畫面,不經任何「把字串當 HTML 解析」的 API */
const mdEl = (tag) => document.createElement(tag);
function mdPaint(host, blocks) {
  blocks.forEach((b) => {
    let n;
    if (b.p) { n = mdEl("p"); mdPaintInl(n, b.p); }
    else if (b.h) { n = mdEl("h" + b.h); mdPaintInl(n, b.inl); }
    else if (b.hr) n = mdEl("hr");
    else if (b.code != null) { n = mdEl("pre"); const c = mdEl("code"); c.textContent = b.code; n.appendChild(c); }
    else if (b.quote) { n = mdEl("blockquote"); mdPaint(n, b.quote); }
    else if (b.list) {
      n = mdEl(b.list.ordered ? "ol" : "ul");
      if (b.list.ordered && b.list.start !== 1) n.start = b.list.start;
      b.list.items.forEach((it) => { const li = mdEl("li"); mdPaint(li, it); n.appendChild(li); });
    } else if (b.table) {
      // 表格包一層自己的橫向捲動容器(同網頁 .md-tblwrap):欄位多時在表格裡橫捲,不把聊天欄撐寬
      n = mdEl("div"); n.className = "md-tblwrap";
      const tb = mdEl("table"), th = mdEl("thead"), bd = mdEl("tbody");
      const row = (cells, tag) => {
        const tr = mdEl("tr");
        cells.forEach((c, k) => { const x = mdEl(tag); if (b.table.align[k]) x.style.textAlign = b.table.align[k]; mdPaintInl(x, c); tr.appendChild(x); });
        return tr;
      };
      th.appendChild(row(b.table.head, "th"));
      b.table.rows.forEach((r) => bd.appendChild(row(r, "td")));
      tb.appendChild(th); if (b.table.rows.length) tb.appendChild(bd);
      n.appendChild(tb);
    }
    if (n) host.appendChild(n);
  });
}
function mdPaintInl(host, parts) {
  parts.forEach((p) => {
    if (p.text != null) host.appendChild(document.createTextNode(p.text));
    else if (p.code != null) { const c = mdEl("code"); c.textContent = p.code; host.appendChild(c); }
    else if (p.br) host.appendChild(mdEl("br"));
    else if (p.a) {
      const a = mdEl("a"); a.href = p.a; a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = p.a;
      mdPaintInl(a, p.kids); host.appendChild(a);
    } else {
      const x = mdEl(p.strong ? "strong" : p.em ? "em" : p.del ? "del" : "span");
      mdPaintInl(x, p.strong || p.em || p.del || p.span); host.appendChild(x);
    }
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
/* 對話裡的連結(agent 回覆的 markdown、新聞 Sources)交給系統瀏覽器,不在 app 視窗內導覽。要 preventDefault:
   不然 <a target=_blank> 會走主行程的導覽守門(只放行 blave.org),新聞網站點了沒反應(0.1.1 用戶回報)。
   mdHref 已經只收 http(s),這裡再看一次是因為 href 是從 DOM 拿的 */
const chatLink = (e) => {
  if (e.type === "auxclick" && e.button !== 1) return;   // 中鍵才算;右鍵留給系統選單
  const a = e.target.closest("a[href]"); if (!a) return;
  e.preventDefault();
  if (/^https?:\/\//i.test(a.href)) window.blave.openExternal(a.href);
};
// Cmd/Ctrl+click 是帶 metaKey/ctrlKey 的 click,同一條;中鍵是 auxclick,不攔會走 window.open → 白名單
["click", "auxclick"].forEach((ev) => $("chat-scroll").addEventListener(ev, chatLink));

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
  li.append(mark, whereTag(stepWhere(c)), verb, obj, time);   // ④ 這一步實際做在哪(事實)
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
function busyEnd(faulted) {
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
    if (faulted && b.stepsEl.children.length) busyOpenReceipts(b);
    return;
  }
  if (b.el.hidden || reducedMotion()) { b.el.remove(); return; }
  b.el.classList.add("is-fading");
  setTimeout(() => b.el.remove(), motionBaseMs() + 30);
}

/* 出錯的回合(設計稽核 005 第 12 條,Wei 同意):工具收據自己攤開——「做到哪」不該還要多按一下;思考文字維持收起
   (那是模型自己的獨白,多半是英文,出錯時要的是收據)。有思考文字才在收據下面留一顆「顯示思考內容」,按了才出 */
function busyOpenReceipts(b) {
  b.el.classList.add("is-open"); b.head.setAttribute("aria-expanded", "true");
  if (!b.reason.textContent.trim()) return;
  b.el.classList.add("reason-held");
  const show = document.createElement("button");
  show.type = "button"; show.className = "btn-quiet think-reason-show"; show.textContent = t("turn.showReason");
  show.addEventListener("click", () => { b.el.classList.remove("reason-held"); show.remove(); b.reason.setAttribute("tabindex", "-1"); b.reason.focus(); });   // 鈕消失,焦點接到剛出來的字
  b.reason.before(show);
}
async function sendDraft() {
  const msg = $("ta").value.trim();
  if (!msg || running) return;
  $("ta").value = ""; autosize();
  submitMessage(msg);
}
/* 真的送出一句話。回傳這一輪有沒有跑起來(「再送一次」要知道)。不碰輸入框。 */
async function submitMessage(msg, opts) {   // opts.handoff:「送上雲端 / 拉回」確認框送的那句才有(handoff.js);重送(lastUserText)不帶
  if (!msg || running) return false;
  UPD.turnCloud = false; turnSeq++;   // 這一回合碰過雲端沒有,從零開始記(tool chunk 的 where);回合序號 +1(參數掃描的「已送出」只認這一輪)
  running = true; $("btn-send").disabled = true; hoBusy(); upPaint(); rpRobSync(); if (typeof libSync === "function") libSync();   // 回合在跑:更新入口停用(更新會重開 app)
  $("ws-conn").disabled = true;   // 跑到一半不給換 agent
  $("mp-trigger").disabled = true; mpClose(false); csLock(true);
  $("chat-eg").hidden = true;     // 起手範例只在第一句話之前有意義
  // 操作對象在送出當下定案:之後切視角不改這一輪。opts.viewing = 呼叫端指定(更新雲端那一句永遠帶 env:cloud)
  const viewing = opts && opts.viewing && typeof opts.viewing === "object" ? opts.viewing : chatViewing();
  addMsg("you", msg); lastUserText = msg;
  if (!csTitle) { csTitle = msg; csRenderHead(); csRemember(); }
  liveBubble = null; faultShown = false; pendingErr = [];
  const unlock = () => { running = false; $("btn-send").disabled = false; $("ws-conn").disabled = false; $("mp-trigger").disabled = false; csLock(false); hoBusy(); upPaint(); rpRobSync(); if (typeof libSync === "function") libSync(); };
  try {
    // 暖機(首次會裝 venv + SDK,約一分鐘)由 engine-progress 的系統訊息交代,
    // 指示器不在這段亮——那段還沒開始思考,掛「思考中 58s」是假的
    await window.blave.ensureEngine();
    // 沒有型錄(選擇器沒畫)時 model / effort 都是 null,runTurn 就不帶旗標
    turnModel = MP.model; turnGotReply = false; turnErrored = false; turnFaulted = false; turnCards = [];
    const r = await window.blave.sendMessage({
      sessionId, message: msg, handoff: opts && opts.handoff, model: MP.model, effort: mpEffort(), viewing });
    // main.js 的回覆:started / busy,以及最低版本閘擋下的 blocked(沒有 spawn、沒有花 AI)
    if (r.started) { busyStart(); return true; }
    if (r.blocked === "UPDATE_REQUIRED") {
      // 不是「上一輪還在跑」:這個版本被停用了,要更新才能繼續。鈕帶去 設定 › 一般 最下面的「關於」(那裡有更新鈕)
      faultCard().set({ text: t("minv.chat"), label: t("minv.btn"), out: true, on: () => setOpen().then(() => { setCat("display"); $("set-up-btn").hidden ? null : $("set-up-btn").focus(); }) });
      unlock(); return false;
    }
    addMsg("sys", t("turn.busy")); unlock(); return false;
  } catch (e) {
    busyEnd();
    // 失敗卡而不是灰字:灰字排在「正在準備引擎…」下面,看起來像那一行還在跑(0.0.6 Intel 實測)
    faultCard().set({ text: t("turn.engineFailed", { msg: (e && e.message) || e }) });
    unlock(); return false;
  }
}

/* ── A′ 的標示:哪一邊(spec-desktop-local-and-cloud §6)────────
   .wtag = 「這台電腦」/「雲端主機」小標,純標示、不可點;掛 data-i18n,換語言時 applyStatic 會重填。 */
function whereTag(env) {
  const s = document.createElement("span"); s.className = "wtag " + (env === "cloud" ? "cloud" : "local");
  s.dataset.i18n = env === "cloud" ? "chat.tgt.cloud" : "env.local"; s.textContent = t(s.dataset.i18n);
  return s;
}
/* 工具動作做在哪(④,事實):只看結構化的訊號。runtime 若在 tool chunk 帶了 `where`("cloud" | "local")就照它——Bash 經 ssh / scp
   做在雲端只有 runtime 看得出來(它手上有完整指令;summary 優先回路徑 token,`ssh host python lib/runner.py` 的 summary 是
   `lib/runner.py`,在這裡比對會標錯邊)。沒帶時只認工具**名稱**:`blave` MCP 的(mcp__blave__*)= 雲端,其餘一律這台電腦。
   不比對 summary 裡的字。純函式,tests/check_shell_envsw.js 從原文切出來跑。 */
function stepWhere(c) {
  if (c && (c.where === "cloud" || c.where === "local")) return c.where;
  const tool = c && typeof c.tool === "string" ? c.tool : "";
  return tool.indexOf("mcp__blave__") === 0 ? "cloud" : "local";
}
/* 切視角時的系統行(③):只在對話有內容時插;切到哪一邊都插一條當前方向的;連續切(上一條仍是最後一則)只留最新一條。
   只在記憶體(逐字稿是 runtime 存的,這一行不進 session.db):重開 app / 換對話就沒了。 */
let swLine = null;
function chatSwitched(from, to) {
  if (from === to) return;
  const box = $("chat-scroll");
  if (swLine) { if (swLine.parentNode === box && box.lastElementChild === swLine) swLine.remove(); swLine = null; }
  if (!box.children.length) return;
  const el = document.createElement("div"); el.className = "sysline";
  el.dataset.i18n = to === "cloud" ? "chat.sw.cloud" : "chat.sw.local"; el.textContent = t(el.dataset.i18n);
  box.appendChild(el); busyPin(); scrollChat();
  swLine = el;
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
    // s = { calm, text, label, out, quiet, disabled, on, sub(Node|string|null), second:{label,on}|null }
    set(s) {
      el.classList.toggle("is-calm", !!s.calm);
      text.textContent = s.text; srSay(s.text);
      b1.hidden = !s.label;                     // 沒有鈕的狀態(例如「可以開始了。」)
      b1.textContent = s.label || ""; b1.className = s.quiet ? "btn-quiet" : s.out ? "btn-out" : "btn-fill";
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
    oauthPending = true; waitChanged();
    card.set({ calm: true, text: t("oauth.opened"), label: t("oauth.cancel"), out: true, on: () => window.blave.cancelOAuth() });
    try {
      await window.blave.startOAuth(LANG);
      oauthPending = false; waitChanged(); acct = null;
      mpInit("blave");                         // 失效期間型錄抓回來是空的
      card.set(resendState(card, t("fault.authOk")));
      acctPrecheck();
    } catch (e) {
      oauthPending = false; waitChanged();
      const m = (e && e.message) || "";
      const code = (m.match(/\b[A-Z][A-Z_]{3,}\b/) || [])[0];
      fault(code === "OAUTH_CANCELLED" ? null : (code && t(code) !== code ? t(code) : (m || t("oauth.failed"))));
    }
  }
  fault(null);
}

/* ── Blave AI 能不能用:綁卡 / 儲值 ──────────────────────
   進工作頁(用 Blave AI)先問一次 api 的 account_status:不能跑就先放一張灰記號的預檢卡,
   不等他打完第一句才失敗;輸入框不鎖。402 的失敗卡也照同一份狀態換句子與鈕(沒卡 → 前往綁卡,
   有卡沒餘額 → 儲值);查不到就沿用舊的「沒額度 → 儲值」那組,不猜。
   數字(100 / 14 / 100 / 300)全部來自 api,這裡不寫死。
   視窗回到前景時自動重查(節流 10 秒;還是不能跑就 5 秒後再查,最多 3 次):綁完卡回來,卡片
   自己換成「可以開始了 / 額度到了」。不自動重送——那句話可能是下單。 */
let acct = null, acctCard = null, acctAt = 0, acctRetry = 0;
const creditCards = [];                     // 402 那張(可能不只一張:他連送了兩句)
const acctVars = (s) => ({ q: s.trial_ai_credit, t: s.trial_days, lo: s.auto_topup_min, a: s.auto_topup_amount, m: s.min_topup });
const acctUrl = () => "https://blave.org/agent/" + LANG + "/usage?from=desktop#topup";
const usageUrl = () => "https://blave.org/agent/" + LANG + "/usage?from=desktop";
/* 資料狀態(同 main.js dataAccessOf):"included" 免費含在裡面、"billed" 按有用到的整點小時收、"none" 這一小時付不出來;
   null = 舊 api 沒有 data_access(或值認不得)→ 照舊只看布林 data_included。included 與 billed 都算拿得到資料 */
function dataAccessOf(s) {
  if (!s) return null;
  return ["included", "billed", "none"].includes(s.data_access) ? s.data_access : s.data_included === true ? "included" : null;
}
const hasData = (s) => { const a = dataAccessOf(s); return a === "included" || a === "billed"; };
/* 講「資料按小時計費」的那幾句只在 api 是新制時用(account_status 帶著 data_access);舊 api(外殼先出的那段時間)
   或還沒登入、查不到時用 `.old` 那一版——那時沒有主機的人真的拿不到資料,新句子會是假話 */
const pvK = (k) => (acct && typeof acct.data_access === "string" ? k : k + ".old");
// 拿到資料之後那張卡的話:按小時付的那條要講「會收錢」(剛因為沒錢被擋過,不能只說「可以用了」);免費那條照舊
function dataReadyText(s) {
  if (dataAccessOf(s) !== "billed") return t("data.ready");
  const v = planVars(); return v.r ? t("data.readyBilled", v) : t("data.readyBilledNoNum");
}
/* 服務條款 / 隱私權政策(法遵稽核:app 裡本來一個入口都沒有)。網址帶目前的介面語言,zh 的人不會落到英文頁
   (web 的路由是 /disclaimer/<lang>/…)。外開走既有的 openExternal(主行程的 externalUrl 已經認得 blave.org) */
const legalUrl = (page) => "https://blave.org/disclaimer/" + LANG + "/" + page;
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
  dataCardSync(s);
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
  // 只在連的是 Blave AI、而且真的有卡片在等的時候重試:自帶 CLI 的登入者 can_run=false 是常態,
  // 照舊重試會把跟 LLM 共用的每分鐘 30 次的桶打滿
  if (cur === "blave" && acct && !acct.can_run && (acctCard || creditCards.length) && acctRetry < 3) { acctRetry++; setTimeout(acctCheck, 5000); }
  else acctRetry = 0;
}
/* ── 沒有 Blave 資料權限的情境卡(設計師定稿)──────────────────
   agent 因為這台沒有資料權限而拿不到 Blave 資料的那一輪,回覆尾端會帶 `<blave-card:data-access/>`
   (runtime 的規則;paintAi 把它從畫面上拿掉、記在 turnCards)。**agent 只講事實,錢與動作由這張卡講**。
   - 這一小時付不出資料費(data_access = none):出口是儲值(沒綁卡是綁卡),不提主機。
   - 沒登入 / 查不到 / 舊 api:描邊鈕開「資料與雲端方案」那一頁。
   同一段對話只出一次;不擋輸入、不搶焦點。同一輪有錢的阻擋卡(402 / 還沒解的預檢卡)就讓位,
   而且不算用掉那一次。視窗回前景重查到拿得到資料 → 換成 dataReadyText + 再送一次(不自動重送)。 */
const dataCardSessions = new Set();
let dataCard = null;
function dataCardState() {
  const v = planVars(), go = { label: t("pv.e.btn"), on: () => planOpen(), out: true, calm: true };
  if (!hasToken) return { ...go, text: v.t ? t("pv.e.out", v) : t("pv.e.outNoNum", v), sub: v.t && v.p ? t(pvK("pv.e.sub"), v) : null };
  if (planState() === "starting") return { calm: true, text: t("data.starting") };   // 已經按過啟動:不再叫他去看方案
  if (!acct) return { ...go, text: t("pv.e.unknown") };                              // 狀態查不到:不斷言它在哪個方案裡
  /* 付不出這一小時(spec-data-without-machine-flow §3):出口是錢包,不是主機——沒綁卡 → 綁卡(有試用就講送幾天);
     有卡 → 儲值。兩格都不提主機。account_status 刻意不回餘額,所以不講「餘額 N TWD」 */
  if (dataAccessOf(acct) === "none") {
    const top = { label: t(acct.reason === "NO_CARD" ? "acct.addCard" : "fault.noCreditBtn"), on: () => window.blave.openExternal(acctUrl()) };
    if (acct.reason === "NO_CARD") return { ...top, text: t("data.noCard"), sub: acct.trial_eligible && v.t ? t("data.noCardSub", v) : null };
    return { ...top, text: v.r ? t("data.noBalance", v) : t("data.noBalanceNoNum"), sub: t("data.noBalanceSub") };
  }
  // 以下只有舊 api(沒有 data_access)走得到:那時資料真的只在試用 / 方案裡
  if (acct && acct.reason === "NO_CARD" && acct.trial_eligible) return { ...go, text: t(cur === "blave" ? "pv.e.card" : "pv.e.card.cli", v), sub: v.p ? t(pvK("pv.e.sub"), v) : null };
  return { ...go, text: t("pv.e.noTrial") };
}
function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* noop */ } }
/* 回合結束:有登入就重讀一次 account_status(一次;試用剛到期、餘額剛用完都只有這裡看得到——之前只在進工作頁、
   重登、回前景時讀,「餘額夠了」會講在已經沒錢的時候,試用到期那一則也永遠出不來)。卡用這一份 */
async function dataTurnEnd() {
  if (hasToken) {
    const fresh = await window.blave.accountStatus().catch(() => null);
    if (fresh && hasToken) { acct = fresh; acctPaint(); }
  }
  maybeDataCard();
}
/* 那張卡的字跟著最新的帳號狀態走,拿到資料之後也不放手:餘額又用完了要換回儲值那一句,不能停在「餘額夠了」。
   按了〔再送一次〕才放手(那之後的事由下一輪自己講)。同一句不重設(role 會重唸) */
function dataCardSync(s) {
  if (!dataCard) return;
  const ready = hasData(s), st = ready ? resendState(dataCard, dataReadyText(s)) : dataCardState();
  const key = JSON.stringify([st.text, st.sub || null, st.label || null]);
  if (dataCard._key === key) return;
  dataCard._key = key;
  if (ready) { const card = dataCard, go = st.on; st.on = async () => { if (running || !lastUserText) return; if (dataCard === card) dataCard = null; await go(); }; }
  dataCard.set(st);
}
function maybeDataCard() {
  if (!turnCards.includes("data-access") || dataCardSessions.has(sessionId)) return;
  if (turnFaulted || creditCards.length || (acctCard && acct && !acct.can_run)) return;
  dataCardSessions.add(sessionId);
  dataCard = faultCard();
  dataCardSync(acct);   // 卡出來的那一刻帳號已經拿得到資料(剛儲值):直接是〔再送一次〕
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
    top: num(s.auto_topup_amount || tr.auto_topup_amount), r: num(s.data_hourly),
    d: left > 0 ? planDate(pl.trial_free_until) : "", n: left > 0 ? left : 0,
    name: cur === "codex" ? "Codex" : "Claude Code" };
}
function planOpen() { setOpen().then(() => setCat("plan")); }
// 主機運行中那格的主鈕:關設定、切到雲端視角(走切換器同一個守門入口 envSwitchGuarded,trade.js);不外開網頁
function planToCloud() { setClose(); envSwitchGuarded("cloud"); }
/* 這一頁現在是哪一格(設計師 v3 的狀態表)。登入是帳號的事、換 AI 是引擎的事:這裡只看有沒有登入與帳號
   狀態,不看 cur(cur 只決定試用說明第一句寫「AI 照用你的…」還是「另有 AI 額度」)。 */
function planView() {
  if (!hasToken) return "out";
  if (!acct) return "unknown";
  const st = planBusy ? "starting" : planState();
  if (st !== "none") return st;                                   // starting / running / stopped
  const da = dataAccessOf(acct);
  if (da === "billed") return "billed";                           // 沒綁卡但有餘額也付得起:不叫他去綁卡
  if (acct.reason === "NO_CARD") return acct.trial_eligible ? "offer" : "noTrial";
  if (planVars().n > 0) return "trial";
  if (da === "none") return "none";
  return da === "included" ? "included" : "plan";                 // plan = 舊 api(沒有 data_access)且不含資料
}
let planMoreOpen = false, planLoginBusy = false, planLastView = null;
function planPaint() {
  acctPaintAcct();                           // 登入等待中那顆鈕是「取消」:帳號頁跟著同一份狀態
  if (typeof envPlanChanged === "function") envPlanChanged();   // 開通頁跟著同一份狀態重畫(trade.js);放最前面:下面有提早 return
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
    out:      { h: hasNum ? "pv.h.offer" : "pv.h.offerNoNum", lead: hasNum ? offerLead() : t(pvK("pv.d.noPrice")), rule: hasNum ? t(pvK("pv.f.out"), v) : "", wait: planLoginBusy ? t("pv.w.waiting") : t("pv.w.out.cli"),
                acts: [planLoginBusy ? btn("btn-out", t("oauth.cancel"), planLogin) : btn("btn-fill", t("pv.signin"), planLogin)] },
    unknown:  { h: "pv.h.unknown", lead: t("pv.d.unknown"), acts: [btn("btn-out", t("plan.recheck"), () => acctCheck())] },
    offer:    { h: "pv.h.offer", lead: offerLead(), rule: t(pvK("pv.f.offer"), v), acts: [btn("btn-fill", t("plan.addCard"), ext(acctUrl()))] },
    noTrial:  { h: pvK("pv.h.billed") === "pv.h.billed" ? "pv.h.billed" : "pv.h.plan", lead: t(pvK("pv.d.noTrial"), v), rule: t("pv.f.noTrial", v), wait: t(pvK("pv.w.noTrial")), acts: [btn("btn-fill", t("plan.addCard"), ext(acctUrl()))] },
    trial:    { st: ["on", t("pv.st.trial", v)], h: "pv.h.ready", lead: t(pvK("pv.d.trial"), v), rule: t("pv.f.trial", v), acts: [btn("btn-out", t("plan.start"), planAsk, !(v.p && v.h))] },
    plan:     { st: ["", t("pv.st.none")], h: "pv.h.plan", lead: t("pv.d.plan", v), rule: t("pv.f.plan", v), acts: [btn("btn-fill", t("plan.start"), planAsk, !(v.p && v.h))] },
    included: { st: ["on", t("pv.st.ok")], h: "pv.h.ready", lead: t("pv.d.included", v), rule: t("pv.f.plan", v), acts: [btn("btn-out", t("plan.start"), planAsk, !(v.p && v.h))] },
    // 沒有主機、按有用到的整點小時付資料:資料的事講在前面,主機退到「要全天候自動執行才需要」(spec-data-without-machine-flow §4 / §5)
    billed:   { st: ["on", t("pv.st.ok")], h: "pv.h.billed", lead: v.r ? t("pv.d.billed", v) : t("pv.d.billedNoNum"), rule: v.h ? t("pv.f.billed", v) : "",
                acts: [btn("btn-quiet", t("pv.usage"), ext(usageUrl())), btn("btn-out", t("plan.start"), planAsk, !(v.p && v.h))] },
    // 付不出這一小時:唯一的主鈕是儲值;主機降成安靜文字鈕——這一刻推銷一台更貴的東西是錯的
    none:     { st: ["bad", t("pv.st.noData")], h: "pv.h.none", lead: v.r ? t("pv.d.none", v) : t("pv.d.noneNoNum"),
                acts: [btn("btn-quiet", t("plan.start"), planAsk, !(v.p && v.h)), btn("btn-fill", t("fault.noCreditBtn"), ext(acctUrl()))] },
    starting: { st: ["busy", t("pv.st.starting")], h: "pv.h.starting", lead: t("pv.d.starting"),
                acts: [slow ? btn("btn-out", t("plan.recheck"), () => { planSince = Date.now(); acctCheck(); planPaint(); }) : btn("btn-fill", t("plan.starting"), null, true)] },
    running:  { st: ["on", t("plan.st.running")], h: "pv.h.running", lead: t("pv.d.running"), rule: t("pv.f.running", v),
                acts: [btn("btn-quiet", t("plan.manage"), ext(planWebUrl())), btn("btn-out", t("plan.switchCloud"), planToCloud)] },
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
    inc.append(ul, el("p", "plan-fine", t("pv.inc.note")), el("p", "plan-fine", t("pv.inc.web")));   // 網頁限定的事:從運行中那一段搬來,講一次就好
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
  setHint(null);                             // 上一則(例如離線登出「還要去補撤」)講的是上一次的事,不該活過這次登入
  planLoginBusy = oauthPending = true; planErr = null; planPaint(); waitChanged();
  try { await window.blave.startOAuth(LANG); hasToken = true; acct = null; if (typeof libInvalidate === "function") libInvalidate(); acctPaintAcct(); await acctCheck(); }
  // 取消或失敗:留在原地,不報錯
  catch (_) { planErr = null; }
  planLoginBusy = oauthPending = false; planPaint(); waitChanged();
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
  oauthPending = true; waitChanged();
  // 可能換了帳號:上一個帳號的數字不能留到花錢確認框
  try { await window.blave.startOAuth(LANG); planErr = null; hasToken = true; acct = null; if (typeof libInvalidate === "function") libInvalidate(); await acctCheck(); }
  // 取消或失敗:那句話留著,鈕還在
  catch (_) { /* noop */ }
  oauthPending = false; waitChanged();
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
/* 設定左欄底部的帳號區:有登入才出。(連結畫面最底下那句「首次綁卡送 N 天資料」已拿掉——Wei:選 AI 的地方不放宣傳文) */
/* 設定 › 帳號。兩態同一副骨架:身分兩行 + 一顆鈕 + 「會怎樣」的短清單 + 一行指往「資料與雲端方案」。
   主行程拿不到 Blave 帳號的 email(那裡的 email 是 Claude Code 的),所以第一行先寫「Blave 帳號」;
   之後 account_status 帶得回 email 再換成 email,版面不用動。 */
function acctPaintAcct() {
  if (!$("set-acct-pane")) return;
  const el = (id) => $(id);
  el("acct-a1").textContent = t("acct.lbl"); el("acct-a1").title = t("acct.lbl");
  const a2 = el("acct-a2"); a2.textContent = ""; a2.className = "a2" + (hasToken ? " on" : "");
  if (hasToken) { const d = document.createElement("i"); d.className = "dot"; d.setAttribute("aria-hidden", "true"); a2.appendChild(d); }
  a2.append(t(hasToken ? "acct.signedIn" : "acct.signedOut"));
  const b = el("set-acct-btn"), waiting = !hasToken && (planLoginBusy || oauthPending);
  b.textContent = hasToken ? t("acct.out") : waiting ? t("oauth.cancel") : t("cn.blave.btn");
  b.className = hasToken || waiting ? "btn-out" : "btn-fill";
  // 登出會怎樣 / 登入拿得到什麼。用 Blave AI 的人登出之後會被送回選 AI 的畫面(見登出那支的 cur === "blave" 分支),
  // 對話要換成這台電腦上的 agent 或重新登入才接得下去;用自己 CLI 的人不受影響,所以那一條只對前者出
  const keys = hasToken ? (cur === "blave" ? ["acct.out.3", "acct.out.1", "acct.out.2"] : ["acct.out.1", "acct.out.2"]) : ["acct.in.1", "acct.in.2"];
  const ul = el("acct-list"); ul.textContent = "";
  keys.forEach((k) => { const li = document.createElement("li"); li.textContent = t(k); ul.appendChild(li); });
  // 這一頁唯一的訊息格:等待登入時講「瀏覽器已開啟」(同方案頁那條路),其餘時候放共用的那一則
  // (登出時伺服器那顆沒撤成的提醒就是靠它——登出鈕住在這一頁,那句話只有這裡看得到)
  const hint = el("acct-hint"); hint.textContent = "";
  const msg = waiting ? { text: t("pv.w.waiting") } : HINT;
  hint.hidden = !msg;
  if (msg) { hint.append(msg.text + (msg.cmd ? " " : "")); if (msg.cmd) hint.append(cmdLine(msg.cmd)); }
  el("acct-to-plan").textContent = t("acct.toPlan");
  el("acct-to-plan-btn").textContent = t("acct.toPlanBtn");
  setFocusGuard();
}
$("acct-to-plan-btn").addEventListener("click", () => { setCat("plan"); const c = document.querySelector('.set-cat[data-set-cat="plan"]'); if (c) c.focus(); });
function sidePaint() {
  if (typeof envPlanChanged === "function") envPlanChanged();   // 雲端視角的開通頁吃同一份帳號 / 方案狀態(trade.js)
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
  if (cur !== "blave") return;                // 預檢卡講的是「Blave AI 能不能跑」,自帶 CLI 的人用不到
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
  if (!hasToken || !(acctCard || creditCards.length || dataCard || planState() === "starting" || envOpenVisible())) return;
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
    // 這一回合第一次碰雲端主機:在收到 chunk 這一層記(busyStep 在 !busy 時直接 return),更新那一行當場換成 S3
    if (!UPD.turnCloud && stepWhere(c) === "cloud") { UPD.turnCloud = true; upPaint(); }
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
  stratRefresh(true).catch(() => {}).then(() => { if (typeof libTurnEnd === "function") libTurnEnd(); });   // 策略庫的「用這支」:清單重讀完才知道有沒有多一支;重讀失敗也要收掉 pending
  // 連的是 Codex 但這台電腦上找不到它了:主行程刻意讓這一輪失敗(不會偷偷改跑 Claude)。講人話,不要丟代碼給用戶看
  const exitLine = r.code !== 0
    ? (/AGENT_BIN_MISSING/.test(r.errTail || "") ? t("AGENT_BIN_MISSING") : t("turn.exit", { code: r.code }) + (r.errTail ? ": " + r.errTail.slice(-300) : ""))
    : null;
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
  const faulted = r.code !== 0 || turnFaulted || turnErrored || !turnGotReply || loggedOut;   // 同 upTurnEnded 的判準
  busyEnd(faulted);
  if (!loggedOut && r.code === 0) dataTurnEnd();
  if (planDonePending) planSayDone();
  if (loggedOut) addFault(localAuthFault(cur));
  else { pendingErr.forEach((x) => addMsg("sys", x)); if (exitLine) addMsg("sys", exitLine); }
  pendingErr = [];
  const cloudTurn = UPD.turnCloud;   // upTurnEnded 會把它歸零,先記下
  upTurnEnded(faulted);
  running = false; $("btn-send").disabled = false; $("ws-conn").disabled = false; $("mp-trigger").disabled = false; csLock(false); hoBusy(); upPaint(); rpRobSync(); if (typeof libSync === "function") libSync();
  // 碰過雲端的回合:雲端那支的報告背景重抓(rpCloudSelect force = 先畫手上那份、抓到不同才換)——不然雲端掃完 scan 永遠不會出現在分頁上
  if (cloudTurn && RPC.name) rpCloudSelect(RPC.name, true);
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
  if (typeof trPushLabels === "function") trPushLabels();   // 主行程的選單列 / 結束攔截跟著換語言
  if (typeof upPaint === "function" && typeof UP !== "undefined") upPaint();
  acctPaintAcct();   // 設定 › 帳號(兩態的字跟著語言換)
  if (typeof mdlPaint === "function") mdlPaint();   // 設定 › 模型接入
  if (typeof privPaint === "function" && $("set-priv") && !$("set-priv").hidden) privPaint();
  if (typeof libRepaint === "function") libRepaint();   // 策略庫的清單 / 詳情(renderer/library.js 用 t() 現組的字)
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
}

(async () => {
  // 用戶在設定裡選過的語言優先,沒選過才跟系統
  let savedLang = null;
  try { savedLang = localStorage.getItem("ws_lang"); } catch (_) { /* noop */ }
  setLang(savedLang || pickLang(await window.blave.getLocale()));
  syncLangControls();
  applyStatic();
  hasToken = await window.blave.hasBlaveToken();
  hoInit();                        // 「送上雲端 / 拉回」的功能開關(renderer/handoff.js;預設關 = 兩顆鈕都不畫)
  pubLoad().then(acctPaintAcct);   // 連結畫面尾註那句要的天數;拿不到就不出
  const prev = await window.blave.loadConnection();
  // kind 說「用 Blave AI」但 token 不在(被撤銷後清掉、Keychain 讀不到、換了
  // 電腦),進工作頁會在左下角寫「已連結:Blave AI」,實際上引擎沒有 token 就走
  // 本機模式 —— 帳算在用戶自己的 Claude Code 訂閱上。那個 footer 不能說謊。
  if (prev && prev.kind === "blave" && !(await window.blave.hasBlaveToken())) {
    await window.blave.clearConnection();
    hasToken = false;
    paintBlaveBtn();
    detect();
    setHint({ text: t("conn.expired") });
    return;
  }
  if (prev && prev.kind) { enterWorkspace(prev.kind, prev); return; }
  paintBlaveBtn();
  detect();
})();
