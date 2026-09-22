/* 「送上雲端 / 拉回這台電腦」(設計:blave-canon output/designer/spec-desktop-cloud-handoff-buttons.md)。
   互動 = 按鈕 → 確認框(confirmBox:.cf-*、okDisabled、alt)→ 按「確認」直接把一句話送給 agent(submitMessage);不碰輸入框裡的草稿。
   真正搬東西的是 agent(照 references 的搬運文件、經 `blave` MCP);這個檔只負責「問一次、送一句話」。
   - **功能預設關**(主行程的 CLOUD_HANDOFF;先修 sshd 才上線):HO.on 是 false 時兩顆鈕都不畫、整個檔等於不存在。
   - 送給 agent 的那句話裡只放**策略資料夾名**,而且要過 HO_ID_RE:不放顯示名稱——那是 workspace / 雲端回報裡的自由文字,
     放進「用戶說的話」等於讓不可信內容冒充用戶指令(用戶在確認框裡看不到這句全文)。不符合的策略,鈕不畫。
   用到 app.js 的 $ / t / confirmBox / submitMessage / running / RP / paneToggle / paneSt、trade.js 的 ENV / TR_BAGS / env*——都在呼叫時才取。 */
const HO = { on: false, pending: null };   // pending = { id }:未登入 / 沒主機時按過「送上雲端」的那一支。只在記憶體,重開 app 就沒了
const HO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HO_ICONS = { up: ["M12 13v8", "M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242", "m8 17 4-4 4 4"], down: ["M12 13v8l-4-4", "m12 21 4-4", "M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284"] };

/* ── 純邏輯(tests/check_shell_handoff_msg.js 從原文切出來跑;這一段不准碰 DOM)── */
// 送給 agent 的那句話。壞 id / 壞方向回 null。tpl = 已經依 UI 語言取好的兩句範本({ up, down },各含一個 {id})
function hoMsg(dir, id, tpl) {
  if ((dir !== "up" && dir !== "down") || typeof id !== "string" || !HO_ID_RE.test(id)) return null;
  const s = tpl && typeof tpl[dir] === "string" ? tpl[dir] : null;
  return s && s.split("{id}").length === 2 ? s.split("{id}").join(id) : null;
}
/* 「會搬」那一列講哪一句(references/cloud-handoff.md §5:金鑰是**雙向**都搬,但沒用到 `DATA_` 的策略 agent 會跳過那一步)。
   回 i18n key 與代入值。三種:
     up  + 掃到來源 → 講金鑰,並列出是哪幾個(主行程掃資料夾內所有 .py,同 §5 的 grep 範圍)
     up  + 沒掃到   → 只講程式碼(這支確定用不到)
     down          → **中性句**:要拉的是雲端那一支,這台電腦掃不到它的程式碼,不可以宣稱「只搬程式碼」(稽核 C1) */
function hoMovesRow(dir, data) {
  if (dir !== "up") return ["ho.row.movesMaybe", null];
  const srcs = Array.isArray(data && data.dataSources) ? data.dataSources.filter((x) => typeof x === "string" && x) : [];
  return srcs.length ? ["ho.row.movesKeys", { sources: srcs.join(LANG === "zh" ? "、" : ", ") }] : ["ho.row.movesV", null];
}
/* 確認框是哪一態。destHas = 目的地有沒有同名(true / false / null = 不確定);destAmount = 目的地那份的投入金額。
   回 "block"(目的地那份正在下單:不准覆蓋)| "over"(會覆蓋)| "maybe"(不確定有沒有同名:用中性說法)| "plain" */
function hoState(destHas, destAmount) {
  if (typeof destAmount === "number" && destAmount > 0) return "block";
  return destHas === true ? "over" : destHas === null ? "maybe" : "plain";
}
/* ── 純邏輯到此 ── */

const hoTpl = () => ({ up: t("ho.msg.up"), down: t("ho.msg.down") });
function hoIcon(dir) {
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "ic"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  for (const d of HO_ICONS[dir]) { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); svg.appendChild(p); }
  return svg;
}
// 雲端那一邊「看得到現況而且在運行」:送上雲端要它、拉回那顆鈕也要它(讀不到 / 逾 1 小時沒同步就不畫)
function hoCloudLive() { const st = TR_BAGS.cloud.st; return envCloudKind(st) === "running" && envHeadState(st, Date.now()) !== "unknown"; }
function hoAmount(st, id) { const a = st && st.report && st.report.config && st.report.config.amounts; const v = a && Object.prototype.hasOwnProperty.call(a, id) ? Number(a[id]) : 0; return isFinite(v) ? v : 0; }

/* agent 正在回覆時兩顆鈕都是 aria-disabled(不是原生 disabled:鍵盤停得上去、讀屏唸得到原因)。app.js 在上鎖 / 解鎖的同一處叫它 */
function hoBusy() {
  const busy = typeof running !== "undefined" && running === true;
  document.querySelectorAll("#rp-ho, .ho-down, .ho-back").forEach((b) => {
    if (busy) { b.setAttribute("aria-disabled", "true"); b.dataset.title = b.dataset.title || b.title || ""; b.title = t("turn.busy"); }
    else { b.removeAttribute("aria-disabled"); if (b.dataset.title !== undefined) { b.title = b.dataset.title; delete b.dataset.title; } }
  });
}
// 策略報告頁首那顆「送上雲端」。沒回測過、資料夾名不合規、功能關 → 不畫(.act 整個藏起來,頁首高度由 .txt 決定、不跳)
function hoPaintUp() {
  const act = $("rp-act"); if (!act) return;
  const show = HO.on && !!RP.name && !!RP.data && !!RP.data.stats && HO_ID_RE.test(RP.name);
  act.hidden = !show; act.textContent = "";
  if (!show) return;
  const b = document.createElement("button"); b.type = "button"; b.className = "btn-out has-ic"; b.id = "rp-ho";
  const l = document.createElement("span"); l.textContent = t("ho.up.btn"); b.append(hoIcon("up"), l);
  b.addEventListener("click", () => hoAsk("up", RP.name, b));
  act.appendChild(b); hoBusy();
}
// 雲端策略清單列尾那顆「拉回」(trade.js 的 envPaintSide 每列叫一次)。回節點或 null
function hoDownBtn(name) {
  if (!HO.on || !HO_ID_RE.test(name) || !hoCloudLive()) return null;
  const b = document.createElement("button"); b.type = "button"; b.className = "btn-quiet ho-down";
  b.title = t("ho.down.aria"); b.setAttribute("aria-label", t("ho.down.aria") + (LANG === "zh" ? "：" : ": ") + name);
  const l = document.createElement("span"); l.textContent = t("ho.down.btn"); b.append(hoIcon("down"), l);
  b.addEventListener("click", () => hoAsk("down", name, b));
  return b;
}

/* 還在等著送上雲端的那一支(雲端側欄第一格用)。回 id 或 null。
   報告頁換了策略 / 關了報告 → 回去也按不到那顆鈕,提示連同意圖一起清掉。 */
function hoPendingId() {
  const p = HO.pending; if (!p) return null;
  if (!HO.on || typeof RP === "undefined" || RP.name !== p.id) { HO.pending = null; return null; }
  return p.id;
}
/* 雲端側欄第一格:雲端通了之後,把人送回這台電腦那顆「送上雲端」。
   不自動切視角、不自動開框——這是一顆人按的文字鈕(規格 §1.4-1 的「畫面上的文字鈕」)。 */
function hoPendingCell(id) {
  const p = document.createElement("p"); p.className = "pf-state"; p.setAttribute("role", "listitem");   // 容器是 role="list":這一格是它的第一項
  const b = document.createElement("button"); b.type = "button"; b.className = "btn-quiet ho-back"; b.textContent = t("ho.back.btn");
  b.addEventListener("click", () => {
    if (typeof running !== "undefined" && running) return;             // agent 正在回覆:送過去也按不動那顆鈕(hoAsk 同一道門),留在原地
    if (!envCanSwitch()) return;                                       // 守門同切換器那一份:組字中切過去會把組到一半的字丟掉
    envSwitch("local", "link");
    const up = $("rp-ho"); if (up && up.offsetParent) up.focus();      // 焦點給那顆鈕本人(不是中欄標題):按 Enter 就開框。切完才取:那一輪重畫會換掉節點
  });
  p.append(t("ho.back.hint", { id }) + " ", b);
  return p;
}

function hoAsk(dir, id, opener) {
  if (!HO.on || !HO_ID_RE.test(id)) return;
  if (typeof running !== "undefined" && running) return;                 // 鈕本身是 aria-disabled;這裡再守一次
  if (!envCanSwitch()) return;                                           // IME 選字中、別的框開著
  // 雲端沒在運行(沒登入、沒綁卡、沒主機、啟動中、停機、讀不到):切過去,那一頁自己會講。
  // 記下要送哪一支:那一頁通完(登入 / 啟動好)之後,雲端側欄第一格會給一條回來按這顆鈕的路(hoPendingCell)。
  // **切完才記**:envSwitch 自己會清 pending(人自己切視角 = 放棄這個意圖),先記會被那一行洗掉
  if (dir === "up" && !hoCloudLive()) { if (envSwitchGuarded("cloud")) HO.pending = { id }; return; }
  // 走到這裡 = 框真的開得起來(接著按確認就送出):意圖已經達成,提示不必再留。
  // 另外三個清的時機:人自己切視角(envSwitch)、回去之後開的是別支策略(hoPendingId 對不上 RP.name)、重開 app(只在記憶體、不寫檔)
  if (dir === "up") HO.pending = null;
  const destSt = dir === "up" ? TR_BAGS.cloud.st : TR_BAGS.local.st;
  // 目的地有沒有同名。拉回:這台電腦的清單是現況。送上雲端:雲端那份清單是平台上的策略索引(24 小時快取、只含機器已經回報過摘要的策略),
  // 「清單裡沒有」不等於「雲端沒有」——所以沒看到時不說「不會覆蓋」,用中性的那一句
  const destHas = dir === "up" ? (envCloudList(destSt).some((x) => x.name === id) ? true : null) : RP.list.some((x) => x.name === id);
  const state = hoState(destHas, hoAmount(destSt, id));
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const extra = document.createDocumentFragment(), dl = mk("dl", "cf-rows kv");
  const row = (k, v) => { const r = mk("div", "cf-row"); r.append(mk("dt", "", k), mk("dd", "", v)); return r; };
  const mv = hoMovesRow(dir, dir === "up" ? RP.data : null);
  dl.append(row(t("ho.row.moves"), t(mv[0], mv[1] || undefined)), row(t("ho.row.stays"), t("ho.row.staysV")));
  extra.appendChild(dl);
  if (state === "block") extra.appendChild(mk("p", "cf-block", dir === "up" ? t("ho.block.up") : t("ho.block.down")));
  else {
    if (state === "over") extra.appendChild(mk("p", "cf-removed", dir === "up" ? t("ho.over.up") : t("ho.over.down")));
    if (state === "maybe") extra.appendChild(mk("p", "cf-removed", t("ho.over.maybeUp")));
    extra.appendChild(mk("p", "cf-note", t("ho.note")));              // 擋下的時候不會執行:覆蓋那句與這句都是假話,不出
  }
  const title = dir === "up" ? t("ho.up.title", { id }) : t("ho.down.title", { id });
  const goSide = dir === "up" ? "cloud" : "local";
  confirmBox({
    title, lines: [], extra, ok: t("ho.ok"), okDisabled: state === "block", opener,
    alt: state === "block" ? { label: dir === "up" ? t("ho.block.goCloud") : t("ho.block.goLocal"), onOk: () => { envSwitchGuarded(goSide); if (goSide === "local") trOpen("pos"); } } : null,
    onOk: () => {
      const msg = hoMsg(dir, id, hoTpl()); if (!msg) return;
      if (paneSt.chat.off) paneToggle("chat", false);                   // 聊天欄收著就先展開:過程在那裡回報
      submitMessage(msg, { handoff: dir });                             // 不碰 #ta:輸入框裡的草稿原封不動;標記給主行程記「上雲端運行」那則事件(只有 up 算)
    },
  });
  $("del-title").title = title;                                         // 標題單行截尾,全文放 title
}
async function hoInit() {
  try { const f = await window.blave.featureFlags(); HO.on = !!(f && f.cloudHandoff === true); } catch (_) { HO.on = false; }
  document.documentElement.dataset.handoff = HO.on ? "on" : "off";
  if (HO.on) { hoPaintUp(); ENV.sig.side = null; if (typeof trPaint === "function") trPaint(); }
}
