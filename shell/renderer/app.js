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
  $("ta").focus();
}

$("btn-redetect").addEventListener("click", detect);
$("btn-blave").addEventListener("click", () => {
  // OAuth(PKCE)是之後的工項;先誠實顯示,不做假流程
  $("cn-hint").textContent = "Blave 登入還沒接上(OAuth 是下一批工項)。先用本機 agent。";
  $("cn-hint").hidden = false;
});
$("btn-send").addEventListener("click", sendDraft);
$("ta").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendDraft(); }
});

/* ── 第 4 步:真的接線 ───────────────────────────── */
const sessionId = "desktop-" + Math.random().toString(36).slice(2, 10);
let running = false;
let liveBubble = null;

function addMsg(cls, text) {
  const el = document.createElement("div");
  el.className = "msg " + cls; el.textContent = text;
  $("chat-scroll").appendChild(el);
  $("chat-scroll").scrollTop = $("chat-scroll").scrollHeight;
  return el;
}

async function sendDraft() {
  const t = $("ta").value.trim();
  if (!t || running) return;
  running = true; $("btn-send").disabled = true;
  addMsg("you", t); $("ta").value = "";
  liveBubble = null;
  try {
    await window.blave.ensureEngine();
    const model = "sonnet"; // v1:先固定;之後從連結資訊帶
    const r = await window.blave.sendMessage({ sessionId, message: t, model });
    if (r.busy) { addMsg("sys", "上一輪還在跑。"); running = false; $("btn-send").disabled = false; }
  } catch (e) {
    addMsg("sys", "引擎準備失敗:" + (e.message || e));
    running = false; $("btn-send").disabled = false;
  }
}

window.blave.onEngineProgress((t) => addMsg("sys", t));
window.blave.onTurnEvent((c) => {
  if (c.type === "text") {
    if (!liveBubble) liveBubble = addMsg("agent", "");
    liveBubble.textContent += c.text;
  } else if (c.type === "text_replace") {
    if (!liveBubble) liveBubble = addMsg("agent", "");
    liveBubble.textContent = c.text;
  } else if (c.type === "tool") {
    if (c.status === "running") addMsg("sys", "● " + (c.tool || "工具"));
    liveBubble = null; // 工具之後的字開新泡泡,跟 web 一致
  } else if (c.type === "thinking") {
    // v1 不展開思考,只在狀態列示意
  } else if (c.type === "error") {
    addMsg("sys", "出錯了:" + (c.message || ""));
  }
  $("chat-scroll").scrollTop = $("chat-scroll").scrollHeight;
});
window.blave.onTurnEnd((r) => {
  running = false; $("btn-send").disabled = false;
  if (r.code !== 0) addMsg("sys", "引擎退出碼 " + r.code + (r.errTail ? ":" + r.errTail.slice(-300) : ""));
});

(async () => {
  const prev = await window.blave.loadConnection();
  if (prev && prev.kind) { enterWorkspace(prev.kind, prev); return; }
  detect();
})();
