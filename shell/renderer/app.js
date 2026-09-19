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
  if (cur) div.setAttribute("aria-current", "true");
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

async function detect() {
  detectingRows();
  $("cn-hint").hidden = true;
  const d = await window.blave.detectAgents();
  const rows = $("agent-rows"); rows.innerHTML = "";
  localReady = !!((d.claude.installed && d.claude.loggedIn) || (d.codex.installed && d.codex.loggedIn));
  // 填色只給**第一個**能用的本機 agent:兩個都裝好的人(Claude Code + Codex)
  // 會看到兩顆填色鈕並排,等於沒有焦點(canon › 每視野一個焦點)。
  let fillGiven = false;
  const localBtnCls = () => {
    if (!localReady || fillGiven) return "btn-out";
    fillGiven = true; return "btn-fill";
  };
  paintBlaveBtn();

  // Claude Code 三態:已登入 / 裝了沒登入 / 沒裝
  if (d.claude.installed && d.claude.loggedIn) {
    rows.appendChild(row({ name: "Claude Code", st: t("st.signedIn"), stClass: "on",
      cur: cur === "claude",
      action: cur === "claude" ? null : btn(localBtnCls(), t("cn.connect"), () => connect("claude", d.claude)) }));
  } else if (d.claude.installed) {
    rows.appendChild(row({ name: "Claude Code", st: t("st.notSignedIn"), stClass: "up",
      action: btn("btn-out", t("cn.redetect"), detect) }));
    $("cn-hint").textContent = t("hint.claudeLogin");
    $("cn-hint").hidden = false;
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
      action: btn("btn-out", t("cn.redetect"), detect) }));
  } else {
    rows.appendChild(row({ name: "Codex", st: t("st.notFound"), stClass: "" }));
  }
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
  sec.classList.toggle("is-cur", cur === "blave");
  if (cur === "blave") { sec.setAttribute("aria-current", "true"); }
  else { sec.removeAttribute("aria-current"); }
  b.textContent = hasToken && cur !== "blave" ? t("cn.blave.switch") : t("cn.blave.btn");
  b.className = localReady ? "btn-out" : "btn-fill";
}

/* 開啟連結畫面。從工作頁進來(back=true)時多一顆返回鍵——沒有它,按了設定就
   出不去,跟「選了就回不去」是同一個病、只是換一層。 */
async function openConnect(back) {
  $("view-ws").hidden = true;
  $("view-connect").hidden = false;
  $("cn-back").hidden = !back;
  $("cn-back").textContent = t("cn.back");
  // 「選錯了沒關係」在第一次連結時有用,在切換器上是廢話(用戶正在做的就是換)
  $("cn-foot").hidden = !!back;
  hasToken = await window.blave.hasBlaveToken();
  paintBlaveBtn();
  detect();
}
function enterWorkspace(kind, info) {
  $("view-connect").hidden = true;
  $("view-ws").hidden = false;
  cur = kind;
  const name = kind === "blave" ? t("ws.connBlave")
    : kind === "claude" ? t("ws.connClaude") : t("ws.connCodex");
  $("ws-conn").textContent = t("ws.conn", { name });
  $("ws-conn").title = t("ws.settings");
  mpInit(kind);
  autosize();          // 進工作頁先把輸入框高度對齊一行
  $("ta").focus();
}

$("btn-redetect").addEventListener("click", detect);
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

// 左下角:目前連著誰,按下去回連結畫面換。跑到一半不給換——引擎的環境變數是
// 開子行程那一刻決定的,中途換等於在活著的子行程底下抽掉設定。
$("ws-conn").addEventListener("click", () => { if (!running) openConnect(true); });
$("cn-back").addEventListener("click", () => {
  $("view-connect").hidden = true;
  $("view-ws").hidden = false;
});
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
   換 model 時 effort 能留就留,留不住就落回該 model 的預設,**並留一行字**——ChatGPT
   桌面版的 Codex 有兩個 open bug 都是「effort 被默默重設」。
   選擇按引擎各記一組(model + 每個 model 各自的 effort),存本機、跨重啟保留。 */
const MP = { kind: null, models: [], prefs: {}, model: null, note: null };

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

/* 進工作頁 / 換引擎時呼叫。型錄拿不到(沒裝、沒 token、離線)就整顆不畫——
   那時 runTurn 不帶任何旗標,行為跟沒有這個功能之前一樣。 */
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

async function mpInit(kind) {
  // 先同步清空:型錄最慢要 15 秒才回來(Blave AI 走網路),這期間按送出不能把**上一個
  // 引擎**的 model 送過去(Codex 的 gpt-5.5 送給 Blave 的 proxy → 該輪失敗)。
  MP.kind = kind; MP.note = null; MP.models = []; MP.model = null; MP.defaultModel = null;
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

  const note = $("mp-note");
  note.classList.toggle("is-reset", !!MP.note);
  note.textContent = MP.note ? MP.note
    : has ? t("mp.cap", { model: m.name, level: mpLevel(m.defaultEffort || m.efforts[0]) })
    : t("mp.none");
}

function mpPickModel(id) {
  if (id === MP.model) return;
  const before = mpEffort();
  MP.model = id; MP.note = null;
  const m = mpCur();
  const slot = MP.prefs[MP.kind] || (MP.prefs[MP.kind] = { efforts: {} });
  slot.efforts = slot.efforts || {};
  if (m.efforts.length && !slot.efforts[id]) {
    // 這個 model 沒選過 effort:前一個 model 的值它也支援就沿用,不支援就落回預設並說明
    if (before && m.efforts.includes(before)) slot.efforts[id] = before;
    else if (before) MP.note = t("mp.reset", { model: m.name, from: mpLevel(before), to: mpLevel(m.defaultEffort || m.efforts[0]) });
  }
  mpSave(); mpPaint();
  const cur = $("mp-models").querySelector('[aria-checked="true"]'); if (cur) cur.focus();
}
function mpPickEffort(lv) {
  const slot = MP.prefs[MP.kind] || (MP.prefs[MP.kind] = { efforts: {} });
  slot.efforts = slot.efforts || {}; slot.efforts[MP.model] = lv; MP.note = null;
  mpSave(); mpPaint();
  const cur = $("mp-rail").querySelector('[aria-checked="true"]'); if (cur) cur.focus();
}

/* 選了立即生效,面板**不自動關**(要讓人看到軌變了)。關閉 = Esc / 點面板外 / 再按
   觸發鈕,焦點一律回觸發鈕。 */
function mpOpen() {
  if (running) return;
  $("mp-panel").hidden = false; $("mp").classList.add("is-open");
  $("mp-trigger").setAttribute("aria-expanded", "true");
  const cur = $("mp-models").querySelector('[aria-checked="true"]'); if (cur) cur.focus();
}
function mpClose(refocus) {
  if ($("mp-panel").hidden) return;
  $("mp-panel").hidden = true; $("mp").classList.remove("is-open");
  $("mp-trigger").setAttribute("aria-expanded", "false");
  MP.note = null; mpPaint();
  if (refocus) $("mp-trigger").focus();
}
$("mp-trigger").addEventListener("click", () => ($("mp-panel").hidden ? mpOpen() : mpClose(true)));
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

/* ── 第 4 步:真的接線 ───────────────────────────── */
const sessionId = "desktop-" + Math.random().toString(36).slice(2, 10);
let running = false;
let liveBubble = null;

function scrollChat() { $("chat-scroll").scrollTop = $("chat-scroll").scrollHeight; }

// 起手範例:點了直接送,不要只是把字填進去讓人再按一次。
$("chat-eg").addEventListener("click", () => {
  $("ta").value = t("ws.chatExample");
  autosize();
  sendDraft();
});

function addMsg(cls, text) {
  const el = document.createElement("div");
  el.className = "msg " + cls;
  if (cls === "you") {
    // 泡泡樣式掛在子元素上(app.css `.msg.you .bubble`);.msg.you 自己只負責靠右
    const b = document.createElement("div");
    b.className = "bubble"; b.textContent = text;
    el.appendChild(b);
  } else {
    el.textContent = text;
  }
  $("chat-scroll").appendChild(el);
  busyPin();            // 等待指示器永遠留在最後一列
  scrollChat();
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
  running = true; $("btn-send").disabled = true;
  $("ws-conn").disabled = true;   // 跑到一半不給換 agent
  $("mp-trigger").disabled = true; mpClose(false);
  $("chat-empty").hidden = true;
  addMsg("you", msg); $("ta").value = ""; autosize();
  liveBubble = null; faultShown = false;
  try {
    // 暖機(首次會裝 venv + SDK,約一分鐘)由 engine-progress 的系統訊息交代,
    // 指示器不在這段亮——那段還沒開始思考,掛「思考中 58s」是假的
    await window.blave.ensureEngine();
    // 沒有型錄(選擇器沒畫)時 model / effort 都是 null,runTurn 就不帶旗標
    const r = await window.blave.sendMessage({
      sessionId, message: msg, model: MP.model, effort: mpEffort(), uiLang: LANG });
    // main.js 的契約只有這兩種回覆:busy 或 started
    if (r.started) busyStart();
    else { addMsg("sys", t("turn.busy")); running = false; $("btn-send").disabled = false; $("ws-conn").disabled = false; $("mp-trigger").disabled = false; }
  } catch (e) {
    busyEnd();
    addMsg("sys", t("turn.engineFailed", { msg: (e && e.message) || e }));
    running = false; $("btn-send").disabled = false; $("ws-conn").disabled = false; $("mp-trigger").disabled = false;
  }
}

// 主行程丟的是 strings.js 的 key(它不組句子),查不到就原樣顯示。
window.blave.onEngineProgress((key) => addMsg("sys", t(key)));
// 引擎把上游的錯誤原封不動當成回覆文字吐出來(實測:一次一整塊,不是逐字串流),
// 長這樣:`Failed to authenticate. API Error: 403 …`。401/403 = 這台電腦的授權沒了、
// 402 = 沒額度,兩種都不是重講一次就會好的事,要給出口而不是給英文。
// 402 已經是幾秒內失敗;401 會被 Claude Code CLI 重試兩分鐘以上,所以 api 那邊把
// 帳號 token 失效改回 403(見 proxy.py `_unauthorized`),401 留給機器那條。
function classifyFault(text) {
  // 錨在引擎故障訊息的開頭,不是「內文出現 API Error」就算:用戶問「我的交易所
  // 呼叫為什麼回 402」時,agent 的回覆裡也會有那串,不錨定就會把整句答案換成
  // 一顆儲值鈕。開頭這句是 Claude Code 的固定前綴(實測 403 那次逐字對過)。
  const m = /^(?:Failed to authenticate\. )?API Error: (40[123])\b/.exec(text || "");
  if (!m) return null;
  if (m[1] === "402") {
    return { text: t("fault.noCredit"), label: t("fault.noCreditBtn"),
             // #topup:用量頁自己會在餘額回來之後捲到儲值區(web 那邊已經處理過
             // 原生 hash 捲動的時序),直接落在該按的地方。
             act: () => window.blave.openExternal("https://blave.org/agent/zh/usage#topup") };
  }
  return {
    text: t("fault.authInvalid"),
    label: t("fault.authBtn"),
    act: async () => {
      // 兩份狀態都自己清:token 檔 + connect.json。只清 token 也會work(啟動檢查
      // 會接住),但那是靠別人的失敗分支收尾,那條路一改這顆鈕就無聲壞掉。
      await window.blave.clearBlaveToken();
      await window.blave.clearConnection();
      location.reload();
    },
  };
}

// 分類過的錯誤畫完之後,引擎緊接著那句「這輪沒跑起來」就是重複,吞掉。
let faultShown = false;

function addFault(f) {
  const el = addMsg("sys", f.text);
  const b = document.createElement("button");
  b.type = "button"; b.className = "btn-fill"; b.textContent = f.label;
  b.style.marginTop = "var(--space-8)"; b.style.display = "block";
  b.addEventListener("click", f.act);
  el.appendChild(b);
  scrollChat();
}

window.blave.onTurnEvent((c) => {
  if (c.type === "text") {
    busyHide();
    const f = classifyFault(c.text);
    if (f) { faultShown = true; addFault(f); liveBubble = null; return; }
    if (!liveBubble) liveBubble = addMsg("ai", "");
    liveBubble.textContent += c.text;
    // 這一輪的第一個回覆泡泡 = 回合結束時「思考過程」標記要插在它上面的錨點
    if (busy && !busy.anchor) busy.anchor = liveBubble;
  } else if (c.type === "text_replace") {
    busyHide();
    if (!liveBubble) liveBubble = addMsg("ai", "");
    liveBubble.textContent = c.text;
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
    if (faultShown && c.code === "not_started") { faultShown = false; return; }
    addMsg("sys", t("turn.error", { msg: c.message || "" }));
  }
  scrollChat();
});
window.blave.onTurnEnd((r) => {
  running = false; $("btn-send").disabled = false; $("ws-conn").disabled = false; $("mp-trigger").disabled = false;
  busyEnd();
  if (r.code !== 0) addMsg("sys", t("turn.exit", { code: r.code }) + (r.errTail ? ": " + r.errTail.slice(-300) : ""));
});

/* 把 index.html 的 data-i18n 填進去。三種:文字、placeholder、aria-label。
   一律走 textContent —— .po 裡不放標記,換行用 \n,靠 CSS 的 white-space: pre-line。
   在任何畫面顯示之前做完,不然會閃一下 key。 */
function applyStatic() {
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
}

(async () => {
  setLang(pickLang(await window.blave.getLocale()));
  applyStatic();
  hasToken = await window.blave.hasBlaveToken();
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
