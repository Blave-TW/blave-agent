/* 送進 TradingView(設計:blave-canon output/designer/spec-desktop-pine-install-0.1.8.md)。
   Pine 轉出卡與程式碼分頁的動作槽(export.js 的 XP_ACTIONS)裡那顆鈕,加上中欄瀏覽器層的狀態句與訊息槽。
   貼上是主行程自己做的(shell/browser/pine.js):不開 agent 回合、不花額度;會花額度的只有字面寫「請 agent」的兩顆與回傳結果那一則訊息。
   狀態只在記憶體:重開 app、換對話之後畫回來的卡一律回到 idle(TradingView 分頁不一定還在,記了會騙人)。
   送給 agent 的字:資料夾名過 HO_ID_RE、檔名是主行程組的固定形狀、網頁來的字(錯誤行、測試器數字)一律當資料清過再放。
   用到 app.js 的 $ / t / confirmBox / submitMessage / running / trackFeature / paneSt / paneToggle / srSay、export.js 的 XP / XP_ACTIONS /
   xpMk / xpFill / xpLocal、browser.js 的 BR / brEl / brIcon / brExpand / brPaintOverlay、trade.js 的 trStamp——都在呼叫時才取。 */
const TV = {
  on: null,            // 設定裡內建瀏覽器開著沒有(null = 還沒問到)
  by: new Map(),       // 卡的 key(轉出卡的 id;程式碼分頁是 "code:<策略>")→ 狀態
  last: new Map(),     // 策略 → 最近送出的那個 key(程式碼分頁跟著它畫)
  tab: new Map(),      // 瀏覽器分頁 id → key
  slots: [],           // 畫在畫面上的槽:{ ctx, btn }
  cur: null,           // 正在貼的那個 key(一次一個)
  armed: false,        // 用戶真的按了鈕:中欄才自動打開
};
const TV_ICON_INFO = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';

/* ── 純邏輯(tests/check_shell_pine_install.js 從原文切出來跑;這一段不准碰 DOM)── */
const TV_MSG_MAX = 4000, TV_MSG_ROWS = 40;   // 同 web 工作頁(tvStatLines / tvComposeResult)
const TV_FILE_RE = /^[A-Za-z0-9_-]{1,64}_pine\.pine$/;
function tvSafe(s, max) {
  return String(s == null ? "" : s).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim().slice(0, max || 120);
}
// 「標籤：值」原樣逐行列出:不對應成固定欄位、不解析數字(標籤跟著 TradingView 的語言與方案變)
function tvStatLines(stats, tpl) {
  const out = [];
  for (const s of Array.isArray(stats) ? stats.slice(0, TV_MSG_ROWS) : []) {
    if (!s || typeof s !== "object") continue;
    const label = tvSafe(s.label), value = tvSafe(s.value);
    if (label || value) out.push(String(tpl.line).replace(/\{label\}|\{value\}/g, (m) => (m === "{label}" ? label : value)));
  }
  return out;
}
function tvCompose(stats, filename, tpl) {
  const lines = tvStatLines(stats, tpl), body = lines.length ? lines.join("\n") : tpl.empty;
  const tail = TV_FILE_RE.test(String(filename)) ? "\n" + String(tpl.sent).replace("{filename}", () => filename) : "";
  return (tpl.head + "\n\n" + body).slice(0, TV_MSG_MAX - tail.length) + tail;   // 先截身體再接版本行
}
// 「請 agent 修」:檔名 + 錯誤行(≤5 行、每行 ≤200 字)。錯誤行是網頁來的字,逐行加「- 」列出
function tvFixMsg(filename, errors, tpl) {
  if (!TV_FILE_RE.test(String(filename))) return null;
  const lines = (Array.isArray(errors) ? errors : []).map((e) => tvSafe(e, 200)).filter(Boolean).slice(-5).map((e) => "- " + e);
  if (!lines.length) return null;
  return String(tpl).replace(/\{filename\}|\{lines\}/g, (m) => (m === "{filename}" ? filename : lines.join("\n")));
}
// 「請 agent 貼」:只放資料夾名
function tvPasteMsg(id, tpl) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return String(tpl).split("{id}").length === 2 ? String(tpl).split("{id}").join(id) : null;
}
/* 狀態機(同 web 的 tvPaintCard,多兩態:編譯沒過、找不到編輯器):
   idle → sending(1 開圖表 / 2 開編輯器 / 3 貼上)→ handover → user(用戶在頁面上動手)→ done → reading → returned
   岔路:nf(找不到編輯器 / 新建入口 / 讀回不符)、unsaved(目前的腳本有未存的變更,TradingView 跳了確認框:由用戶處理,外殼不按)、
        fail(頁面打不開、分頁不在了)、compile(編譯沒過)、closed(回傳時圖上沒有策略) */
function tvNext(s, ev) {
  const n = Object.assign({ tv: "idle", step: 0 }, s || {}); n.soft = null; n.err = null;
  if (ev.type === "send") return { tv: "sending", step: 1, ref: ev.ref, strategy: ev.strategy, filename: n.filename || null };
  if (ev.type === "busy") { n.soft = "busy"; return n; }
  if (ev.type === "step") { if (n.tv === "sending") { n.step = ev.step; n.tab = ev.id; if (ev.sym) n.sym = ev.sym; } return n; }
  if (ev.type === "takeover") { if (n.tv === "handover" || n.tv === "closed") { n.tv = "user"; n.notyet = false; } return n; }
  if (ev.type === "returned") { n.tv = "returned"; n.at = ev.at; return n; }
  if (ev.type === "unsent") { n.err = "unknown"; if (n.tv === "reading") n.tv = "done"; return n; }
  if (ev.type !== "result") return n;
  if (ev.id) n.tab = ev.id;
  if (ev.filename) n.filename = ev.filename;
  n.step = 0; n.notyet = false;
  switch (ev.state) {
    case "handover": if (n.tv === "sending") { n.tv = "handover"; n.set = ev.set === true; } break;   // 同一個結果會到兩次(事件 + 回傳):用戶已經動手就不退回去
    case "nf": n.tv = "nf"; break;
    case "needs_user": n.tv = "unsaved"; break;
    case "done": n.tv = "done"; break;
    case "compile": n.tv = "compile"; n.errors = Array.isArray(ev.errors) ? ev.errors.slice(0, 5) : []; break;
    case "notyet": n.tv = "user"; n.notyet = true; break;
    case "reading": n.tv = "reading"; break;
    case "ok": n.tv = "done"; break;               // 數字讀到了;訊息送出去才翻成 returned
    case "closed": n.tv = "closed"; break;
    default: n.tv = "fail";                        // fail / gone / off / busy
  }
  return n;
}
/* 卡與程式碼分頁那一列怎麼畫。o = { old(重開畫回來的舊卡), stale(過期檔) }
   fill:"ext" = 槽裡的鈕拿填色、原本那顆退描邊;"base" = 填色還給原本那顆(舊卡、已回傳、過期那一面) */
function tvModel(s, o) {
  const tv = s && s.tv ? s.tv : "idle", old = !!(o && o.old), stale = !!(o && o.stale);
  const m = { tv, primary: null, pDis: false, fill: "ext", cap: null, msg: null, soft: null, quiet: [], st: null, spin: false, nav: false };
  m.primary = tv === "idle" || tv === "sending" || tv === "nf" || tv === "unsaved" || tv === "fail" ? "tv.send"
    : tv === "reading" ? "tv.reading" : tv === "compile" ? "tv.fix" : tv === "returned" ? "tv.readAgain" : "tv.read";
  m.pDis = tv === "sending" || tv === "reading";
  if (stale || tv === "returned" || (old && tv === "idle")) m.fill = "base";
  m.cap = tv === "idle" || tv === "sending" || tv === "fail" ? "xp.capHonest" : tv === "handover" || tv === "user" ? "tv.sentHint" : tv === "closed" ? "tv.planHint" : null;
  m.msg = tv === "nf" ? "tv.err.editor" : tv === "unsaved" ? "tv.err.unsaved" : tv === "compile" ? "tv.err.compile" : tv === "closed" ? "tv.err.closed" : tv === "fail" || (s && s.err === "unknown") ? "tv.err.unknown" : null;
  if (s && s.soft === "busy") m.soft = "tv.err.busy";
  if (tv === "nf") m.quiet.push("tv.agentPaste");
  if (tv === "sending") { m.st = "tv.sending"; m.spin = true; }
  if (tv === "returned") m.st = "returned";
  m.nav = tv !== "idle" && tv !== "fail" && !!(s && s.tab);
  return m;
}
// 瀏覽器層的狀態句:[icon, 字串 key, 進度格(1–3) | null, 文字鈕 key | null];null = 照一般分頁畫
function tvStatModel(s, userOn) {
  const tv = s && s.tv;
  if (tv === "sending") return ["spin", s.step <= 1 ? (s.sym ? "tv.st.chart" : "tv.st.chartN") : s.step === 2 ? "tv.st.editor" : "tv.st.paste", s.step || 1, null];
  if (tv === "user" || (tv === "handover" && userOn)) return ["hand", "br.userOp", null, "tv.st.check"];
  if (tv === "handover" || tv === "closed") return [null, "tv.st.wait", null, tv === "closed" ? "tv.st.check" : null];
  if (tv === "done" || tv === "returned") return ["check", "tv.st.done", null, null];
  if (tv === "reading") return ["spin", "tv.st.reading", null, null];
  if (tv === "compile") return ["warn", "tv.st.compile", null, null];
  if (tv === "nf") return ["warn", "tv.st.nf", null, null];
  if (tv === "unsaved") return ["warn", "tv.st.unsaved", null, null];
  return null;
}
/* ── 純邏輯到此 ── */

const tvKey = (ctx) => (ctx.id ? String(ctx.id) : "code:" + ctx.strategy);
// 這個槽現在跟哪個狀態:卡跟自己那一次;程式碼分頁跟這支策略最近送出的那一次
function tvStateOf(ctx) {
  if (ctx.where === "card") return TV.by.get(tvKey(ctx)) || null;
  const k = TV.last.get(ctx.strategy); return k ? TV.by.get(k) || null : null;
}
const tvCan = () => TV.on === true && xpLocal() && !XP.tm;
const tvTpl = () => ({ head: t("tv.msg.head"), empty: t("tv.msg.empty"), line: t("tv.msg.line"), sent: t("tv.msg.sent") });
const tvOpenOn = (s) => !!(s && s.tab && BR.exp && BR.exp.mode === "one" && BR.exp.id === s.tab);
function tvSet(key, ev) { const s = tvNext(TV.by.get(key), ev); TV.by.set(key, s); if (s.tab) TV.tab.set(s.tab, key); tvRepaintAll(); return s; }

/* ── 動作槽 ── */
function tvProvide(ctx) {
  if (ctx.target !== "pine" || !ctx.wrap || !ctx.row) return null;
  // 這一輪新出的卡 = 這支策略有新的轉出檔:程式碼分頁不再跟著上一次送出的狀態
  if (ctx.where === "card" && !ctx.old && !TV.by.has(tvKey(ctx))) { TV.last.delete(ctx.strategy); TV.by.delete("code:" + ctx.strategy); }
  const btn = xpMk("button", "btn-fill", t("tv.send")); btn.type = "button";
  const e = { ctx, btn };
  btn.addEventListener("click", (ev) => { if (ev.isTrusted) tvPrimary(e, btn); });
  TV.slots.push(e);
  if (!tvCan()) { Promise.resolve().then(() => tvPaintSlot(e)); return null; }   // 不畫(不是灰掉);條件變了由 tvRepaintAll 補上
  Promise.resolve().then(() => tvPaintSlot(e));   // 槽掛上去之後才畫得到旁邊那幾樣
  return btn;
}
// 程式碼分頁每次重畫都是新的一列(wrap 是同一個容器),所以認「那一列還在不在」
const tvSlotEl = (c) => (c.where === "code" ? c.row : c.wrap).querySelector(".xp-ext");
function tvRepaintSlots() {
  TV.slots = TV.slots.filter((e) => e.ctx.row.isConnected);
  TV.slots.forEach(tvPaintSlot);
}
function tvRepaintAll() {
  tvRepaintSlots();
  if (typeof BR !== "undefined" && BR.exp && BR.exp.mode === "one" && TV.tab.has(BR.exp.id)) brPaintOverlay();
}
function tvPaintSlot(e) {
  const c = e.ctx, slot = tvSlotEl(c); if (!slot) return;
  c.wrap.querySelectorAll(".tv-x").forEach((n) => n.remove());   // 程式碼分頁的句子與出口鈕在動作列後面那個容器裡,不在列裡
  const cap = c.where === "card" ? c.wrap.querySelector(".xp-cap") : null;
  if (!tvCan()) {
    if (e.btn.parentNode === slot) e.btn.remove();
    xpFill(c, "base"); if (cap) { cap.hidden = false; cap.textContent = t("xp.capHonest", { platform: "TradingView" }); }
    return;
  }
  if (e.btn.parentNode !== slot) slot.appendChild(e.btn);
  const s = tvStateOf(c), m = tvModel(s, c);
  e.btn.textContent = t(m.primary); e.btn.className = m.fill === "ext" ? "btn-fill" : "btn-out"; e.btn.disabled = m.pDis;
  xpFill(c, m.fill);
  if (cap) { cap.hidden = !m.cap; if (m.cap) cap.textContent = t(m.cap, { platform: "TradingView" }); }
  const mk = (tag, cls, text) => xpMk(tag, cls + " tv-x", text);
  const own = c.row.querySelector(".xp-st:not(.tv-x)");   // 存檔結果那一格(export.js);我們的東西插在它前面
  const soft = m.soft && running === true ? m.soft : null;   // 回合結束就收:那句只在「現在按不了」的時候成立
  /* 卡:說明句在動作列上面,鈕與狀態在動作列裡。程式碼分頁固定三層:動作列 / 句子自己一行 / 出口鈕一行——
     後兩層裝在動作列後面另起的 .xv-msg 裡。塞在動作列裡時同一個狀態 zh 排成一行、en 折成兩行(設計稽核 0.1.8 第三批 D2) */
  const code = c.where === "code";
  let box = null, exits = null;
  const boxOf = () => { if (!box) { box = mk("div", "xv-msg"); c.row.after(box); } return box; };
  const sentence = (p) => { if (exits) boxOf().insertBefore(p, exits); else boxOf().appendChild(p); };
  const exit = (b) => { if (!code) { c.row.insertBefore(b, own); return; } if (!exits) { exits = mk("div", "xp-acts"); boxOf().appendChild(exits); } exits.appendChild(b); };
  if (!code) {
    if (m.msg) { const p = mk("p", "xp-msg", t(m.msg)); p.setAttribute("role", "alert"); c.row.before(p); }
    if (soft) { const p = mk("p", "xp-msg soft", t(soft)); p.setAttribute("role", "status"); c.row.before(p); }
  } else {   // 這一面的誠實句已經在上面,所以三種句子只出一句
    const line = m.msg || soft || (m.cap === "tv.sentHint" ? m.cap : null);
    if (line) { const p = mk("p", "xp-st" + (m.msg ? " err" : ""), t(line)); p.setAttribute("role", m.msg ? "alert" : "status"); sentence(p); }
  }
  for (const q of m.quiet) { const b = mk("button", "btn-quiet", t(q)); b.type = "button"; b.addEventListener("click", (ev) => { if (ev.isTrusted) tvAgentPaste(e); }); exit(b); }
  if (m.nav && !tvOpenOn(s)) {   // 已經在中欄時不放文字鈕:收起靠標題列的 ✕(同 browser.js brPaintHead)
    const b = mk("button", "btn-quiet", t("br.openPanel")); b.type = "button";
    b.addEventListener("click", (ev) => { if (!ev.isTrusted) return; trackFeature("browser_read"); brExpand(s.tab); });
    exit(b);
  }
  if (m.st) {
    const st = mk(code ? "p" : "span", "xp-st", null); st.setAttribute("role", "status");
    if (m.spin) st.append(brEl("span", "br-spin"));
    st.append(m.st === "returned" ? t("tv.returnedAt", { time: s.at }) + " " + t("tv.returnedLoop") : t(m.st));
    if (code) sentence(st); else c.row.insertBefore(st, own);
  }
}

/* ── 動作 ── */
function tvPrimary(e, btn) {
  const c = e.ctx, m = tvModel(tvStateOf(c), c);
  if (m.pDis || !tvCan()) return;
  if (m.primary === "tv.send") {
    if ((c.stale || c.old) && c.at) {   // 過期檔 / 舊卡:先講這是哪一天轉出的(同 web workspace_xp_cf_stale)
      confirmBox({ title: t("tv.cf.stale.h"), lines: [t("tv.cf.stale.p", { date: trStamp(c.at / 1000) })], ok: t("tv.cf.stale.ok"), opener: btn, onOk: () => tvSend(c) });
      return;
    }
    tvSend(c);
  } else if (m.primary === "tv.fix") tvFix(e);
  else tvRead(tvKeyOf(c));
}
const tvKeyOf = (c) => (c.where === "card" ? tvKey(c) : TV.last.get(c.strategy) || null);
async function tvSend(c) {
  if (TV.cur || !tvCan()) return;
  const key = tvKey(c), ref = c.id ? { session: c.session, id: c.id } : { strategy: c.strategy };
  TV.cur = key; TV.armed = true; TV.last.set(c.strategy, key);
  tvSet(key, { type: "send", ref, strategy: c.strategy });
  trackFeature("tv_send"); srSay(t("tv.sending"));
  let r = null; try { r = await window.blave.pineInstall(ref); } catch (_) { r = null; }
  TV.cur = null; TV.armed = false;
  if (!TV.by.has(key)) return;   // 這段期間換了對話:狀態已經清掉
  const s = tvSet(key, Object.assign({ type: "result" }, r || { state: "fail" }));
  if (s.tv === "handover") { trackFeature("tv_pasted"); srSay(t("tv.ho.h")); }
  else if (s.tv === "nf") { trackFeature("tv_fail_editor"); srSay(t("tv.err.editor")); }
}
async function tvCheck(key) {
  const s = TV.by.get(key); if (!s || !s.tab) return;
  let r = null; try { r = await window.blave.pineCheck(s.tab); } catch (_) { r = null; }
  if (!TV.by.has(key)) return;
  const n = tvSet(key, Object.assign({ type: "result" }, r || { state: "gone" }));
  if (n.tv === "compile") trackFeature("tv_fail_compile");
}
// 回傳結果會開一個 agent 回合:正在回覆時不搶(灰字,不是錯誤)
async function tvRead(key) {
  const s = key ? TV.by.get(key) : null; if (!s || !s.tab) return;
  if (running === true) { tvSet(key, { type: "busy" }); return; }
  let r = null; try { r = await window.blave.pineRead(s.tab); } catch (_) { r = null; }
  if (!TV.by.has(key)) return;
  const n = tvSet(key, Object.assign({ type: "result" }, r || { state: "gone" }));
  if (n.tv === "compile") { trackFeature("tv_fail_compile"); return; }
  if (!r || r.state !== "ok") return;
  if (paneSt.chat.off) paneToggle("chat", false);
  const ok = await submitMessage(tvCompose(r.stats, r.filename, tvTpl()));
  if (!TV.by.has(key)) return;
  if (!ok) { tvSet(key, { type: "unsent" }); return; }   // 先送,成功了才記(同 web)
  const d = new Date(), p2 = (x) => String(x).padStart(2, "0");
  tvSet(key, { type: "returned", at: p2(d.getHours()) + ":" + p2(d.getMinutes()) });
  trackFeature("tv_read");
}
async function tvFix(e) {
  const key = tvKeyOf(e.ctx), s = key ? TV.by.get(key) : null; if (!s) return;
  if (running === true) { tvSet(key, { type: "busy" }); return; }
  const msg = tvFixMsg(s.filename, s.errors, t("tv.msg.fix")); if (!msg) return;
  if (paneSt.chat.off) paneToggle("chat", false);
  if (await submitMessage(msg)) trackFeature("tv_fix");
}
async function tvAgentPaste(e) {
  const key = tvKeyOf(e.ctx), id = e.ctx.strategy;
  if (running === true) { if (key) tvSet(key, { type: "busy" }); return; }
  const msg = tvPasteMsg(id, t("tv.msg.paste")); if (!msg) return;
  if (paneSt.chat.off) paneToggle("chat", false);
  if (await submitMessage(msg)) trackFeature("tv_agent_paste");
}
const tvSlotOf = (key) => TV.slots.find((e) => e.ctx.row.isConnected && tvKeyOf(e.ctx) === key) || null;

/* ── 主行程的事件(browser.js brOnEvent 轉過來)── */
function tvOnEvent(ev) {
  if (ev.type === "pine_step") {
    if (!TV.cur) return;
    tvSet(TV.cur, { type: "step", step: Number(ev.step) || 1, id: String(ev.id || ""), sym: typeof ev.sym === "string" ? ev.sym.slice(0, 40) : null });
    // 用戶按了鈕,打開那一頁就是回應;之後等他的時候不再自己開(只改卡上的字)
    if (Number(ev.step) === 1 && TV.armed && ev.id) { TV.armed = false; brExpand(String(ev.id)); }
    return;
  }
  const key = TV.tab.get(String(ev.id || "")); if (!key) return;
  if (ev.type === "pine_result") tvSet(key, Object.assign({}, ev, { type: "result" }));
  else if (ev.type === "user_takeover") tvSet(key, { type: "takeover" });
}

/* ── 中欄瀏覽器層(browser.js 在畫狀態句 / 訊息槽 / 簽章時問這三支)── */
const tvOfTab = (id) => { const k = TV.tab.get(id); return k ? TV.by.get(k) || null : null; };
function tvSig(id) { const s = tvOfTab(id); return s ? [s.tv, s.step, !!s.notyet, !!s.set, s.at || ""].join("|") : ""; }
function tvStat(host, x) {
  const key = TV.tab.get(x.id), m = tvStatModel(key ? TV.by.get(key) : null, !!x.user); if (!m) return false;
  if (m[0] === "spin") host.append(brEl("span", "br-spin")); else if (m[0]) host.append(brIcon(m[0]));
  const s = TV.by.get(key);
  host.append(brEl("span", "", t(m[1], { sym: s.sym || "", id: s.strategy || "" })));
  if (m[2]) { const g = brEl("span", "segs"); g.setAttribute("aria-hidden", "true"); for (let i = 1; i <= 3; i++) g.append(brEl("i", i < m[2] ? "ok" : i === m[2] ? "on" : "")); host.append(g); }
  if (m[3]) { const b = brEl("button", "btn-quiet", t(m[3])); b.type = "button"; b.addEventListener("click", (ev) => { if (ev.isTrusted) tvCheck(key); }); host.append(b); }
  return true;
}
function tvSlot(x) {
  const key = TV.tab.get(x.id), s = key ? TV.by.get(key) : null; if (!s) return null;
  const ask = (h, p, btns) => {
    const box = brEl("div", "ask"), txt = brEl("div", "txt"); txt.append(brEl("h6", "", h), brEl("p", "", p)); box.append(txt);
    if (btns) { const a = brEl("div", "act"); for (const [k, cls, fn] of btns) { const b = brEl("button", cls, t(k)); b.type = "button"; b.addEventListener("click", (ev) => { if (ev.isTrusted) fn(); }); a.append(b); } box.append(a); }
    return box;
  };
  const honest = () => t("tv.done.p") + t("xp.honest", { platform: "TradingView" });
  const e = tvSlotOf(key);
  // 交接卡沒有鈕:要按的那顆在頁面上(「加到圖表」旁掛「由你按」)
  if (s.tv === "handover") return ask(t("tv.ho.h"), t("tv.ho.p") + (s.set ? "" : t("tv.ho.switch")));
  if ((s.tv === "user" && s.notyet) || s.tv === "closed") {
    const l = brEl("div", "slot-line tv-2"), d = brEl("div"), ic = document.createElement("span"); ic.innerHTML = TV_ICON_INFO;
    d.append(brEl("div", "", t(s.tv === "closed" ? "tv.err.closed" : "tv.notyet")), brEl("div", "", t("tv.planHint")));
    l.append(ic.firstChild, d); return l;
  }
  if (s.tv === "done") return ask(t("tv.done.h"), honest(), [["tv.read", "btn-fill", () => tvRead(key)]]);
  if (s.tv === "returned") return ask(t("tv.done.h"), honest(), [["tv.readAgain", "btn-out", () => tvRead(key)]]);
  if (s.tv === "compile") return ask(t("tv.cmp.h"), t("tv.cmp.p"), e ? [["tv.fix", "btn-fill", () => tvFix(e)]] : null);
  if (s.tv === "unsaved") return ask(t("tv.unsaved.h"), t("tv.unsaved.p"), e ? [["tv.retry", "btn-out", () => tvSend(e.ctx)]] : null);
  if (s.tv === "nf") return ask(t("tv.nf.h"), t("tv.nf.p"), e ? [["tv.retry", "btn-out", () => tvSend(e.ctx)], ["tv.agentPaste", "btn-fill", () => tvAgentPaste(e)]] : null);
  return null;
}
// 換對話 / 新對話(browser.js brReset):分頁與卡都清掉了,狀態跟著清——畫回來的卡是 idle
function tvReset() { TV.by.clear(); TV.last.clear(); TV.tab.clear(); TV.slots = []; TV.cur = null; TV.armed = false; }
async function tvPrefs() {
  let p = null; try { p = await window.blave.browserPrefs(); } catch (_) { p = null; }
  TV.on = !!(p && p.enabled); tvRepaintAll();
  if (typeof xpCodePaint === "function" && typeof RP !== "undefined" && RP.data) xpCodePaint();
}

XP_ACTIONS.push(tvProvide);
tvPrefs();
