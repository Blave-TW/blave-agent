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

/* agent 正在回覆時頁首那顆是 aria-disabled(不是原生 disabled:鍵盤停得上去、讀屏唸得到原因)。app.js 在上鎖 / 解鎖的同一處叫它 */
function hoBusy() {
  const busy = typeof running !== "undefined" && running === true;
  document.querySelectorAll("#rp-ho").forEach((b) => {
    if (busy) { b.setAttribute("aria-disabled", "true"); b.dataset.title = b.dataset.title || b.title || ""; b.title = t("turn.busy"); }
    else { b.removeAttribute("aria-disabled"); if (b.dataset.title !== undefined) { b.title = b.dataset.title; delete b.dataset.title; } }
  });
}
// 有程式碼就能搬(Wei 09-22:不要求回測過——搬過去之後 agent 會在那邊重跑一次回測)
function hoHasCode(d) { return !!(d && typeof d.code === "string" && d.code.trim()); }
/* 策略報告頁首右側那一顆(spec-desktop-cloud-strategy-row-delete-pullback §4):
   這台電腦那支 =「送上雲端」(up);雲端那支 =「拉回這台電腦」(down,同一個位置、同一個 id,data-dir 分方向)。
   功能關、沒有程式碼、資料夾名不合規 → 不畫(.act 整個藏起來,頁首高度由 .txt 決定、不跳)。
   拉回另外要雲端看得到現況而且在運行(讀不到 / 逾 1 小時沒同步就不畫)。 */
function hoPaint() {
  const act = $("rp-act"); if (!act) return;
  hoNote(null);                                       // 換了策略 / 重畫頁首 → 上一次那句「送不上去」不留在新的那一頁
  const cloud = ENV.cur === "cloud";
  const B = cloud ? RPC : RP, dir = cloud ? "down" : "up";
  const show = HO.on && !!B.name && HO_ID_RE.test(B.name) && hoHasCode(B.data) && (!cloud || hoCloudLive());
  act.hidden = !show; act.textContent = "";
  if (!show) return;
  const b = document.createElement("button"); b.type = "button"; b.className = "btn-out has-ic"; b.id = "rp-ho"; b.dataset.dir = dir;
  const l = document.createElement("span"); l.textContent = cloud ? t("ho.down.btn") : t("ho.up.btn"); b.append(hoIcon(dir), l);
  if (cloud) { const full = t("ho.down.aria") + (LANG === "zh" ? "：" : ": ") + B.name; b.title = full; b.setAttribute("aria-label", full); }
  const id = B.name;
  b.addEventListener("click", () => hoAsk(dir, id, b));
  act.appendChild(b); hoBusy();
}

/* 還在等著送上雲端的那一支(雲端中欄的「準備好了」卡與它的 gate 都要它)。回 id 或 null。
   **不可以再讀 RP.name**(承重牆,規格 §2):人在雲端等的時候本機那一邊會自己動——一輪 agent 回覆結束
   stratRefresh(true) 會 stratSelect(touched.name),RP.name 就換人了。在這裡判等於偶發地把卡拆掉。
   「那支還在不在」改到按主鈕那一刻才判(hoBack)。 */
function hoPendingId() { return HO.on && HO.pending ? HO.pending.id : null; }
/* 「準備好了」卡的主鈕:把人送回這台電腦那顆「送上雲端」。
   不自動切視角、不自動開框——這是一顆人按的文字鈕(規格 §1.4-1 的「畫面上的文字鈕」)。
   回合進行中不擋:切視角本來就可以(§1.4-5),而 #rp-ho 那顆自己是 aria-disabled + turn.busy。 */
async function hoBack(id) {
  if (!envCanSwitch()) return;                                         // 守門同切換器那一份:組字中切過去會把組到一半的字丟掉
  const has = typeof RP !== "undefined" && RP.list.some((x) => x.name === id);
  envSwitch("local", "link");                                          // 它自己會清掉 pending
  // 在雲端等的時候被刪了:只切視角、不報錯(清單上沒有那一列,人自己看得到)。焦點照一般文字鈕給中欄標題——
  // envSwitch 的 head() 只認 #tr-h / #cv-h,中欄是策略報告頁時兩顆都藏著、誰都不 focus,所以這裡自己給
  if (!has) { const h = $("rp-name"); if (h && h.offsetParent) h.focus(); return; }
  if (RP.name !== id) await stratSelect(id);                           // 鈕上寫的是「把 {id} 送上來」,就要落在 {id},不是碰巧選中的別支
  const up = $("rp-ho"); if (up && up.offsetParent) up.focus();        // 焦點給那顆鈕本人(不是中欄標題):按 Enter 就開框。切完、選完才取:那幾輪重畫會換掉節點
}
/* 「留在雲端」:放棄這個意圖 → gate 變 false → 落到雲端自動下單頁。他自己選的。
   立刻重畫、不等下一輪輪詢:那顆鈕連同整張卡會被藏起來,焦點得在重畫完成之後交給落地那一頁的標題,不然掉回 body。 */
function hoStay() {
  HO.pending = null;
  trPaint();
  const h = $("tr-h"); if (h && h.offsetParent) h.focus();
}
/* 報告頁首描述下面那一行(#rp-ho-note):雲端停機 / 讀不到時**不切視角**,在原地講一句 + 一顆人按的「去雲端看」。
   key 給 null 就收起來。這個位置只為那兩句存在(規格 §2)。 */
function hoNote(key) {
  const n = $("rp-ho-note"); if (!n) return;
  n.textContent = ""; n.hidden = !key; if (!key) return;
  const b = document.createElement("button"); b.type = "button"; b.className = "btn-quiet"; b.textContent = t("ho.block.goCloud");
  b.addEventListener("click", () => { hoNote(null); envSwitchGuarded("cloud"); });   // 不記 pending:記了雲端那邊就會出「準備好了」卡,按幾次都繞回同一張
  n.append(t(key) + " ", b);
}

function hoAsk(dir, id, opener) {
  if (!HO.on || !HO_ID_RE.test(id)) return;
  if (typeof running !== "undefined" && running) return;                 // 鈕本身是 aria-disabled;這裡再守一次
  if (!envCanSwitch()) return;                                           // IME 選字中、別的框開著
  // 雲端沒在運行(沒登入、沒綁卡、沒主機、啟動中):切過去,那一頁自己會講。
  // 記下要送哪一支:那一頁通完(登入 / 啟動好)之後,雲端中欄會留一格「準備好了」卡,主鈕把人送回來按這顆鈕。
  // **切完才記**:envSwitch 自己會清 pending(人自己切視角 = 放棄這個意圖),先記會被那一行洗掉。
  // 另外兩態**不切視角**(規格 §2):停機切過去只是落在自動下單頁的紅字;「running 但讀不到」切過去還會
  // 記下 pending → gate 又開 → 又是同一張卡,按幾次都繞不出去。攔在本機講一句就沒有迴圈
  if (dir === "up" && !hoCloudLive()) {
    const kind = envCloudKind(TR_BAGS.cloud.st);                         // !hoCloudLive() 而 kind 還是 running = 逾 1 小時沒同步那一態
    if (kind === "running" || kind === "stopped") { hoNote(kind === "running" ? "ho.gate.stale" : "ho.gate.stopped"); return; }
    if (envSwitchGuarded("cloud")) HO.pending = { id };
    return;
  }
  // 走到這裡 = 框真的開得起來(接著按確認就送出):意圖已經達成,那條回頭路不必再留。
  // 另外三個清的時機:人自己切視角(envSwitch)、按了「留在雲端」(hoStay)、重開 app(只在記憶體、不寫檔)
  if (dir === "up") { HO.pending = null; hoNote(null); }
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
    // 講清楚按下去之後會發生什麼:搬過去、在那邊重跑一次回測、兩邊數字並排(擋下的時候不會執行:覆蓋那句與這句都是假話,不出)
    extra.appendChild(mk("p", "cf-note", dir === "up" ? t("ho.note.up") : t("ho.note.down")));
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
  if (HO.on) { hoPaint(); ENV.sig.side = null; if (typeof trPaint === "function") trPaint(); }
}
