/* v1 骨架:偵測 → 三態渲染 → 連結 → 進工作頁。引擎接線是第 4 步。 */
const $ = (id) => document.getElementById(id);

function row({ name, st, stClass, action }) {
  const div = document.createElement("div");
  div.className = "cn-row" + (stClass === "" ? " off" : "");
  const stSpan = stClass === "on"
    ? `<span class="cn-st on"><span class="dot"></span>${st}</span>`
    : `<span class="cn-st ${stClass}">${st}</span>`;
  div.innerHTML = `<span class="n">${name}</span>${stSpan}`;
  if (action) div.appendChild(action);
  return div;
}
function btn(cls, text, onClick) {
  const b = document.createElement("button");
  b.className = cls; b.type = "button"; b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

async function detect() {
  $("agent-rows").innerHTML = `<p class="cn-desc">偵測中…</p>`;
  $("cn-hint").hidden = true;
  const d = await window.blave.detectAgents();
  const rows = $("agent-rows"); rows.innerHTML = "";

  // Claude Code 三態:已登入 / 裝了沒登入 / 沒裝
  if (d.claude.installed && d.claude.loggedIn) {
    rows.appendChild(row({ name: "Claude Code", st: "已登入", stClass: "on",
      action: btn("btn-out", "連結", () => connect("claude", d.claude)) }));
  } else if (d.claude.installed) {
    rows.appendChild(row({ name: "Claude Code", st: "尚未登入", stClass: "up",
      action: btn("btn-out", "重新偵測", detect) }));
    $("cn-hint").textContent = "在終端機跑一次 claude,完成登入後回到這裡按「重新偵測」。";
    $("cn-hint").hidden = false;
  } else {
    const r = row({ name: "Claude Code", st: "未偵測到", stClass: "" });
    rows.appendChild(r);
  }

  if (d.codex.installed && d.codex.loggedIn) {
    rows.appendChild(row({ name: "Codex", st: "已登入", stClass: "on",
      action: btn("btn-out", "連結", () => connect("codex", d.codex)) }));
  } else if (d.codex.installed) {
    rows.appendChild(row({ name: "Codex", st: "尚未登入", stClass: "up",
      action: btn("btn-out", "重新偵測", detect) }));
  } else {
    rows.appendChild(row({ name: "Codex", st: "未偵測到", stClass: "" }));
  }
}

async function connect(kind, info) {
  await window.blave.saveConnection({ kind, path: info.path, email: info.email || null });
  enterWorkspace(kind, info);
}
function enterWorkspace(kind, info) {
  $("view-connect").hidden = true;
  $("view-ws").hidden = false;
  $("ws-conn").textContent = kind === "blave"
    ? "已連結:Blave AI"
    : `已連結:${kind === "claude" ? "Claude Code" : "Codex"}(你的訂閱)`;
  autosize();          // 進工作頁先把輸入框高度對齊一行
  $("ta").focus();
}

$("btn-redetect").addEventListener("click", detect);
$("btn-blave").addEventListener("click", () => {
  // OAuth(PKCE)是之後的工項;先誠實顯示,不做假流程
  $("cn-hint").textContent = "Blave 登入還沒接上(OAuth 是下一批工項)。先用本機 agent。";
  $("cn-hint").hidden = false;
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

/* ── 第 4 步:真的接線 ───────────────────────────── */
const sessionId = "desktop-" + Math.random().toString(36).slice(2, 10);
let running = false;
let liveBubble = null;

function scrollChat() { $("chat-scroll").scrollTop = $("chat-scroll").scrollHeight; }

function addMsg(cls, text) {
  const el = document.createElement("div");
  el.className = "msg " + cls;
  if (cls === "you") {
    // 泡泡樣式掛在子元素上(mockup.css `.msg.you .bubble`);.msg.you 自己只負責靠右
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
   ・回合結束 → 淡出移除(v1 沒有可回頭展開的思考過程,不留靜態列) */
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
  if (busy) { busySet("思考中"); return; }
  const el = document.createElement("div");
  el.className = "think-indicator";
  // 送出到第一個字之間唯一的回饋,所以要讓輔助科技讀到;polite 不打斷回覆
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  const head = document.createElement("div");
  head.className = "think-head";
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
  head.append(ticks, verb, elapsed);
  el.appendChild(head);
  $("chat-scroll").appendChild(el);
  busy = { el, ticksIn, verb, elapsed, start: Date.now(), steps: 0, timer: null };
  busySet("思考中");
  busyElapsed(); busyTick();          // 第 0 秒:條子不會是空的
  busy.timer = setInterval(() => { busyElapsed(); busyTick(); }, 1000);
}
function busyStep() {
  if (!busy) return;
  busy.steps += 1;
  busySet(`執行中 · 第 ${busy.steps} 步`);
}
function busyHide() {
  if (busy) busy.el.hidden = true;    // 回覆在串流了,字本身就是「還在跑」
}
function busyEnd() {
  if (!busy) return;
  const b = busy; busy = null;
  clearInterval(b.timer);
  if (b.el.hidden || reducedMotion()) { b.el.remove(); return; }
  b.el.classList.add("is-fading");
  setTimeout(() => b.el.remove(), motionBaseMs() + 30);
}

async function sendDraft() {
  const t = $("ta").value.trim();
  if (!t || running) return;
  running = true; $("btn-send").disabled = true;
  addMsg("you", t); $("ta").value = ""; autosize();
  liveBubble = null;
  try {
    // 暖機(首次會裝 venv + SDK,約一分鐘)由 engine-progress 的系統訊息交代,
    // 指示器不在這段亮——那段還沒開始思考,掛「思考中 58s」是假的
    await window.blave.ensureEngine();
    const model = "sonnet"; // v1:先固定;之後從連結資訊帶
    const r = await window.blave.sendMessage({ sessionId, message: t, model });
    // main.js 的契約只有這兩種回覆:busy 或 started
    if (r.started) busyStart();
    else { addMsg("sys", "上一輪還在跑。"); running = false; $("btn-send").disabled = false; }
  } catch (e) {
    busyEnd();
    addMsg("sys", "引擎準備失敗:" + (e.message || e));
    running = false; $("btn-send").disabled = false;
  }
}

window.blave.onEngineProgress((t) => addMsg("sys", t));
window.blave.onTurnEvent((c) => {
  if (c.type === "text") {
    busyHide();
    if (!liveBubble) liveBubble = addMsg("ai", "");
    liveBubble.textContent += c.text;
  } else if (c.type === "text_replace") {
    busyHide();
    if (!liveBubble) liveBubble = addMsg("ai", "");
    liveBubble.textContent = c.text;
  } else if (c.type === "tool") {
    if (c.status === "running") { addMsg("sys", "● " + (c.tool || "工具")); busyStep(); }
    liveBubble = null; // 工具之後的字開新泡泡,跟 web 一致
  } else if (c.type === "thinking") {
    // v1 不展開思考內容,只讓指示器回到「思考中」(回覆後又開始想時會用到)
    busySet("思考中");
  } else if (c.type === "error") {
    addMsg("sys", "出錯了:" + (c.message || ""));
  }
  scrollChat();
});
window.blave.onTurnEnd((r) => {
  running = false; $("btn-send").disabled = false;
  busyEnd();
  if (r.code !== 0) addMsg("sys", "引擎退出碼 " + r.code + (r.errTail ? ":" + r.errTail.slice(-300) : ""));
});

(async () => {
  const prev = await window.blave.loadConnection();
  if (prev && prev.kind) { enterWorkspace(prev.kind, prev); return; }
  detect();
})();
