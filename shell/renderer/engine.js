/* ── 安裝進度卡(mockup-desktop-first-run-progress;Wei 選 B+C)──────────────────
   B:步驟清單+分段條「第 n / N 個」,正在跑的那一列下面多一行「這個檔案 a / b MB · 已下載 x MB」;不寫總百分比、不寫預估時間,
   唯一的時間是經過時間。C:開 app 就在背景裝(main.js 的 engine 啟動步驟),所以卡要能在任何時候出現——工作頁一打開就跟快照對一次。
   畫面不自己猜進度:數字全來自主行程的快照(shell/enginesetup.js)。卡的去留只看快照(run / fail 在、done 收),
   所以停止、換對話都不會把它收掉;安裝跑完或失敗才換。 */

/* ── 純邏輯(engView;tests/check_shell_engine_card.js 從原文切出來跑,不碰 DOM)── */
const ENG_STALL_MS = 15000;   // 連續這麼久沒收到資料才講「沒有收到資料」
const ENG_SLOW_MS = 45000;    // 一個套件跑超過這麼久(又不是卡在等資料)才講「網路慢時會久一點」
function engMB(b) { return (Math.max(0, Number(b) || 0) / 1e6).toFixed(1); }
/* s = 主行程快照、now = ms、tr = { t, dur }、held = 有一句話等著裝好再送。回 null = 不出卡 */
function engView(s, now, tr, held) {
  if (!s || !s.show || (s.phase !== "run" && s.phase !== "fail")) return null;
  const t = tr.t, dur = (ms) => tr.dur(ms / 1000);
  const end = s.phase === "fail" ? s.tEnd : now;
  const cur = s.cur || {}, dl = s.dl || {}, file = dl.file || null;
  const limit = (ms) => t("eng.min", { m: Math.round((ms || 0) / 60000) });
  const label = (k) => t("eng." + k);
  const rows = s.steps.map((st) => {
    const live = st.st === "run" && st.t0 != null;
    const row = { k: st.k, st: st.st, label: label(st.k), time: st.st === "wait" ? "" : dur(st.ms + (live ? end - st.t0 : 0)), dt: null, meta: null };
    const here = cur.step === st.k || (s.phase === "fail" && s.err && s.err.step === st.k);
    if (st.k === "pkgs" && (st.st === "run" || st.st === "err") && here && cur.i) {
      const [pre, post] = t("eng.nth", { i: cur.i, n: cur.n, name: "\u0000" }).split("\u0000");
      row.dt = { pre, mono: cur.name, post: post || "" };
    } else if (st.k === "engine" && st.st === "run" && cur.sub === "venv") row.dt = { pre: label("venv"), mono: null, post: "" };
    if (st.st === "run" && cur.name && (file || dl.installing || dl.done > 0)) {
      // 左格講現在在做什麼(下載中的檔案量 / 正在安裝),右格講累計下載量:兩格不重複「已下載」
      row.meta = { left: file ? t("eng.bytes", { a: engMB(file.bytes), b: engMB(file.total) }) : dl.installing ? t("eng.installing") : "",
        right: t("eng.dlTotal", { x: engMB((dl.done || 0) + (file ? file.bytes : 0)) }) };
    }
    return row;
  });
  // 分段條:一段 = 一個步驟(結構,不是時間);套件那一段照「第 n / N 個」填(前面裝完的 n-1 個)。
  // 只有一步時:只補引擎那種不畫(一段從 0 跳到滿,沒有資訊);只補套件那種(更新後清單多了幾個)要畫,前面裝過的那幾個本來就是滿的
  const segs = s.steps.length < 2 && !(s.steps.length === 1 && s.steps[0].k === "pkgs") ? null : s.steps.map((st) => (st.st === "done" ? 1 : st.k === "pkgs" && cur.step === "pkgs" && cur.n ? Math.max(0, cur.i - 1) / cur.n : 0));
  let slot = null;
  if (s.phase === "fail") {
    const e = s.err || {};
    const name = e.name || (e.step ? label(e.step) : "");
    // 每一條 pip 各自計時:超時的主詞是卡住的那一個(套件或 SDK);卡在建 venv 時沒有名字,用另一句
    const head = e.kind === "timeout" ? (e.name ? t("eng.toHead", { name: e.name, limit: limit(e.limitMs) }) : t("eng.toHeadVenv", { limit: limit(e.limitMs) }))
      : e.kind === "net" ? t("eng.failNet", { name }) : t("eng.failOther");
    // 引擎那一步失敗、又沒有套件名(卡在建 venv):不分失敗類別換一句——那一步不用網路,也沒有「從哪個套件接著裝」可講
    const venv = e.step === "engine" && !e.name;
    const sub = venv ? t(held ? "eng.venvSubHeld" : "eng.venvSub") : e.kind === "timeout" ? t("eng.toSub", { name }) : t(held ? "eng.failSub" : "eng.failSubIdle", { name });
    slot = { kind: "fault", head, sub, err: e.msg || "" };
  } else if (cur.name) {
    const quiet = now - (dl.lastByteAt || now);
    if (file && !dl.installing && quiet >= ENG_STALL_MS) slot = { kind: "stall", text: t("eng.stall", { s: dur(quiet), limit: limit(cur.idleMs || cur.limitMs) }) };
    else if (now - (cur.t0 || now) >= ENG_SLOW_MS) slot = { kind: "slow", text: t(dl.installing ? "eng.slowInst" : "eng.slow", { limit: limit(cur.limitMs) }) };
  }
  // 更新:步驟裡有引擎才說「更新了引擎」;只補套件(例:舊用戶升級只補美股那組)說「更新了策略套件」
  const title = s.phase === "fail" ? t("eng.headFail") : s.kind !== "update" ? t("eng.head")
    : s.steps.some((st) => st.k === "engine") ? t("eng.headUpd") : t("eng.headUpdPkgs");
  const sub = s.phase === "fail" || s.kind !== "first" || !s.sizeMB ? null : t("eng.size", { size: s.sizeMB + " MB" });
  // 讀屏:卡本身不設 live region(每秒都在變);只在步驟換了、第 n 個換了、失敗時念一次
  const runRow = rows.find((r) => r.st === "run");
  const say = s.phase === "fail" ? slot.head : runRow ? runRow.label + (runRow.dt ? " " + runRow.dt.pre + (runRow.dt.mono || "") + runRow.dt.post : "") : "";
  return { phase: s.phase, title, time: dur(s.acc + (end - s.t0)), sub, segs, rows, slot, say };
}
/* 完成後留下的那一行 */
function engReadyText(s, tr) { return tr.t("eng.ready", { t: tr.dur((s.acc + (s.tEnd - s.t0)) / 1000) }); }
/* ── 純邏輯到此 ── */

const ENG = { snap: null, card: null, timer: null, said: "", held: null, warned: false };
const ENG_TR = { t: (k, v) => t(k, v), dur: (sec) => fmtDur(sec) };

function engOnState(s) { ENG.snap = s; engPaint(); }
/* 工作頁打開時跟主行程對一次:背景安裝可能早就開始了,那時這一頁還沒有在聽 */
function engSync() { window.blave.engineState().then((s) => { if (s) engOnState(s); }).catch(() => {}); }

function engPaint() {
  const s = ENG.snap; if (!s) return;
  const v = engView(s, Date.now(), ENG_TR, !!(ENG.held && ENG.held.bubble.isConnected));
  if (!v) {
    clearInterval(ENG.timer); ENG.timer = null;
    if (ENG.card && s.phase === "done") engDone(s);
    else if (s.phase === "done" && s.warn) engWarn(s);   // 裝的時候沒在看這一頁(還在選 AI):美股那組沒裝好照樣講一次
    return;
  }
  const box = $("chat-scroll");
  if (!ENG.card || !ENG.card.isConnected) { ENG.card = engBuild(); box.appendChild(ENG.card); busyPin(); scrollChat(); }
  engFill(ENG.card, v);
  if (v.say && v.say !== ENG.said) { ENG.said = v.say; srSay(v.say); }
  if (s.phase === "run" && !ENG.timer) ENG.timer = setInterval(engPaint, 1000);   // 經過時間、「沒有收到資料」的秒數
  if (s.phase !== "run") { clearInterval(ENG.timer); ENG.timer = null; }
}
/* 完成:卡淡出,原地換成一行「這台電腦準備好了 · 4m 12s」(不做慶祝效果) */
function engDone(s) {
  const card = ENG.card; ENG.card = null; ENG.said = "";
  const line = document.createElement("div"); line.className = "msg sys"; line.textContent = engReadyText(s, ENG_TR);
  const swap = () => { if (card.isConnected) card.replaceWith(line); else { $("chat-scroll").appendChild(line); busyPin(); } srSay(line.textContent); scrollChat(); if (s.warn) engWarn(s); };
  if (reducedMotion() || !card.isConnected) { swap(); return; }
  card.classList.add("is-leaving");
  setTimeout(swap, motionBaseMs() + 30);
}
/* 選用的那組(美股資料)沒裝好:這台電腦照樣準備好了,只是暫時抓不到美股資料。聊天欄失敗卡的版型、灰記號、「錯誤訊息」可展開,
   沒有重試鈕——下次開 app 會自己再試。一次啟動只講一次 */
function engWarn(s) {
  if (ENG.warned || !s.warn) return;
  ENG.warned = true;
  let sub = null;
  if (s.warn.msg) {
    sub = document.createElement("details"); sub.className = "eng-err";
    const sm = document.createElement("summary"); sm.textContent = t("eng.details");
    const pre = document.createElement("pre"); pre.textContent = s.warn.msg;
    sub.append(sm, pre);
  }
  // 灰記號(is-calm):引擎好了、那句也送出了、沒有鈕可按,紅色會讓人以為剛才那句沒成功(設計稽核 0.1.12 F5)
  faultCard().set({ calm: true, text: t("eng.optFail"), sub });
}
/* 換對話 / 開新對話會清掉聊天欄:安裝是整台電腦的事,卡要跟著回來(fail 狀態沒有每秒重畫,不補就連重試鈕一起不見)。
   卡放到這一條對話的最下面;等著重試的那句不跟著搬(engRetry 換了對話就丟掉) */
function engReattach() { if (ENG.card) ENG.card.remove(); engPaint(); }
/* 用戶在安裝中送出一句:卡移到那句底下(B 的順序:泡泡 → 卡) */
function engAfter(bubble) { if (ENG.card && ENG.card.isConnected && bubble && bubble.isConnected) { bubble.after(ENG.card); busyPin(); scrollChat(); } }

function engBuild() {
  const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
  const card = el("div", "eng-card");
  const top = el("div", "eng-top"); top.append(el("span", "eng-title"), el("span", "eng-time"));
  const seg = el("div", "eng-seg"); seg.setAttribute("aria-hidden", "true");
  card.append(top, el("div", "eng-sub"), seg, el("ol", "eng-steps"), el("div", "eng-slot"));
  return card;
}
function engFill(card, v) {
  const q = (sel) => card.querySelector(sel);
  q(".eng-title").textContent = v.title;
  q(".eng-time").textContent = v.time;
  q(".eng-sub").textContent = v.sub || ""; q(".eng-sub").hidden = !v.sub;
  const seg = q(".eng-seg"); seg.hidden = !v.segs;
  if (v.segs) {
    while (seg.children.length > v.segs.length) seg.lastChild.remove();
    while (seg.children.length < v.segs.length) { const s = document.createElement("span"); s.appendChild(document.createElement("i")); seg.appendChild(s); }
    v.segs.forEach((f, i) => { seg.children[i].firstChild.style.transform = "scaleX(" + f.toFixed(3) + ")"; });
  }
  const ol = q(".eng-steps");
  v.rows.forEach((r, i) => {
    let li = ol.children[i];
    if (!li || li.dataset.k !== r.k) {
      li = document.createElement("li"); li.dataset.k = r.k;
      li.innerHTML = '<span class="eng-mk"></span><span class="lb"></span><span class="tm"></span><span class="dt"></span><span class="dt eng-meta"><span></span><span></span></span>';
      if (ol.children[i]) ol.children[i].replaceWith(li); else ol.appendChild(li);
    }
    // 記號只在狀態換了才換:轉圈的節點每秒重建會從頭轉
    if (li.dataset.st !== r.st) {
      li.dataset.st = r.st; li.className = "eng-st is-" + r.st;
      const mk = li.querySelector(".eng-mk"); mk.textContent = "";
      const m = document.createElement("span"); m.className = r.st === "run" ? "spin16" : "eng-dash"; mk.appendChild(m);
    }
    li.querySelector(".lb").textContent = r.label;
    li.querySelector(".tm").textContent = r.time;
    const dt = li.querySelector(".dt:not(.eng-meta)"); dt.hidden = !r.dt; dt.textContent = "";
    if (r.dt) { dt.append(r.dt.pre); if (r.dt.mono) { const c = document.createElement("span"); c.className = "mono"; c.textContent = r.dt.mono; dt.append(c); } dt.append(r.dt.post); }
    const meta = li.querySelector(".eng-meta"); meta.hidden = !r.meta;
    if (r.meta) { meta.children[0].textContent = r.meta.left; meta.children[1].textContent = r.meta.right; }
  });
  while (ol.children.length > v.rows.length) ol.lastChild.remove();
  const slot = q(".eng-slot"), sl = v.slot;
  const key = sl ? sl.kind + "|" + (sl.head || sl.text) + "|" + (sl.sub || "") + "|" + (sl.err || "") : "";
  if (slot.dataset.key === key) return;
  slot.dataset.key = key; slot.textContent = ""; slot.hidden = !sl;
  if (!sl) return;
  if (sl.kind !== "fault") { slot.textContent = sl.text; return; }
  const body = document.createElement("div"); body.className = "eng-fault"; body.textContent = sl.head;
  const sub = document.createElement("div"); sub.className = "fault-sub"; sub.textContent = sl.sub;
  const act = document.createElement("div"); act.className = "fault-act";
  const b = document.createElement("button"); b.type = "button"; b.className = "btn-fill"; b.textContent = t("eng.retry");
  b.addEventListener("click", engRetry); act.appendChild(b);
  body.append(sub, act);
  if (sl.err) {
    const d = document.createElement("details"); d.className = "eng-err";
    const sm = document.createElement("summary"); sm.textContent = t("eng.details");
    const pre = document.createElement("pre"); pre.textContent = sl.err;
    d.append(sm, pre); body.appendChild(d);
  }
  slot.appendChild(body);
}
/* 重試:從失敗那一步接著裝(主行程照記號檔只裝還沒裝的)。有一句話在等(失敗時泡泡留著)→ 裝好就送出那句 */
function engRetry() {
  trackFeature("engine_retry");
  const h = ENG.held;
  // 程式自己開的回合正在跑(送上雲端 / 拉回之類):那句先留著(還是等著重試的那句),這次只重裝
  if (h && h.bubble.isConnected && h.sessionId === sessionId && running) { window.blave.ensureEngine().catch(() => { /* 失敗由快照畫在卡上 */ }); return; }
  ENG.held = null;
  if (h && h.bubble.isConnected && h.sessionId === sessionId) { submitMessage(h.msg, Object.assign({}, h.opts, { bubble: h.bubble })); return; }
  if (h && h.bubble.isConnected) h.bubble.remove();   // 換了對話:那句不在這個對話送
  window.blave.ensureEngine().catch(() => { /* 失敗由快照畫在卡上 */ });
}
/* 安裝失敗、那句話沒送:泡泡留著,等重試 */
function engHold(msg, opts, bubble) { ENG.held = { msg, opts, bubble, sessionId }; engPaint(); }
/* 換送別句:上一句不會再送了,泡泡收掉(留著會像已經送出) */
function engDropHeld() { const h = ENG.held; ENG.held = null; if (h && h.bubble.isConnected) h.bubble.remove(); }

window.blave.onEngineState(engOnState);
// 開場那串 IPC 可能在這支載入前就走完、進了工作頁(enterWorkspace 那一次 engSync 就叫不到):載入時自己再對一次
engSync();
