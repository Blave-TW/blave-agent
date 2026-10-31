// 聊天欄黏底(Wei 0.1.26 回報:agent 思考中往上捲去看前面,畫面一直被捲回底部):
//   1. 離底 40px 內:新內容進來跟著捲到底
//   2. 用戶往上捲之後:計時器每秒更新、當下動作子列換字、狀態列換字、新 chunk 都不動 scrollTop
//   3. 自己捲回底部、或送出新訊息(scrollChat(true))才恢復跟著捲
//   4. 程式捲到底的 scroll 事件晚到、那時內容又長高了:不算用戶往上捲
//   5. 往上捲一點點也放開(稽核 M1):同一個 frame「chunk 捲到底＋用戶上捲」、觸控板每次只捲幾 px、滾輪往上;開較短的舊對話後內容晚長高不誤放開
// 純 node:切 app.js 原文跑在假 DOM、假時鐘上(不起 Electron)。跑法:node tests/check_shell_chat_stick.js
const TABS_STUB = require("./_tabs_stub").SRC;
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8");
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("找不到標記:" + a); return src.slice(i, j); };
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.dataset = {}; this.style = {};
    this.hidden = false; this._text = ""; this._cls = new Set(); this._on = {};
    const s = this._cls; this.classList = { add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)), contains: (c) => s.has(c),
      toggle: (c, f) => { const on = f === undefined ? !s.has(c) : !!f; if (on) s.add(c); else s.delete(c); return on; } }; }
  set className(v) { this._cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this._cls.add(c)); }
  get className() { return [...this._cls].join(" "); }
  set textContent(v) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  insertBefore(c, ref) { if (c.parentNode) c.remove(); c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
  before(c) { this.parentNode.insertBefore(c, this); } matches() { return false; }
  remove() { if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
  addEventListener(t, f) { (this._on[t] = this._on[t] || []).push(f); }
  _all(out) { this.children.forEach((c) => { out.push(c); c._all(out); }); return out; }
  querySelectorAll(sel) { const want = sel.split(".").filter(Boolean); return this._all([]).filter((e) => want.every((c) => e._cls.has(c))); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
// 聊天欄:內容高度自己給,scrollTop 照瀏覽器夾在 [0, scrollHeight - clientHeight];scroll 事件先排隊,flush() 才送(瀏覽器是下一個 frame)
class Scroller extends El {
  constructor() { super("div"); this.scrollHeight = 600; this.clientHeight = 400; this._top = 0; this._pending = false; }
  get scrollTop() { return this._top; }
  set scrollTop(v) { const t = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); if (t !== this._top) { this._top = t; this._pending = true; } }
  flush() { if (!this._pending) return; this._pending = false; (this._on.scroll || []).forEach((f) => f({ type: "scroll" })); }
}
const box = new Scroller();
const env = { now: 0, timers: [], seq: 0, tick: null }, said = [];
const ctx = {
  document: { createElement: (t) => new El(t) }, $: (id) => (id === "chat-scroll" ? box : new El("div")),
  t: (k) => k,
  STRINGS: { en: new Proxy({}, { get: (_, k) => (typeof k === "string" && /^(act|step)\./.test(k) ? k : undefined) }) },
  Date: { now: () => env.now },
  setInterval: (f) => { env.tick = f; return 1; }, clearInterval: () => {},
  setTimeout: (f, ms) => { const id = ++env.seq; env.timers.push({ id, at: env.now + ms, f }); return id; },
  clearTimeout: (id) => { env.timers = env.timers.filter((x) => x.id !== id); },
  requestAnimationFrame: () => {}, getComputedStyle: () => ({ getPropertyValue: () => "180ms" }), window: {},
  chatEdge: () => {}, TICK_WINDOW: 24, TICK_PITCH: 4, brNeedsUser: () => false, brHost: () => "", brReg: (h) => h,
  whereTag: () => new El("span"), stepWhere: () => "local", srSay: (x) => { said.push(x); }, LANG: "zh",
};
const body = cut("function scrollChat", "/* ── agent 回覆的顯示") + cut("let busy = null;", "/* 停止(照雲端工作頁") + cut("function faultCard()", "/* 「再送一次」");
// 舊程式沒有黏底那段(只有一行 scrollChat):照樣切得出來跑,這條測試對舊程式要紅
const stickSrc = src.indexOf("let chatStick") >= 0 ? cut("const CHAT_STICK_PX", "function scrollChat") : "";
const M = new Function(...Object.keys(ctx), TABS_STUB + stickSrc + body +
  "; return { scrollChat, faultCard, busyStart, busyStep, busyStepDone, busyReason, get busy() { return busy; } };")(...Object.values(ctx));
const at = (ms) => { env.now = ms; const due = env.timers.filter((x) => x.at <= ms); env.timers = env.timers.filter((x) => x.at > ms); due.forEach((x) => x.f()); box.flush(); };
const grow = (px) => { box.scrollHeight += px; };
const bottom = () => box.scrollHeight - box.clientHeight;
const userScrollTo = (top) => { box.scrollTop = top; box.flush(); };
const second = (n) => { for (let i = 0; i < n; i++) { at(env.now + 1000); grow(2); env.tick(); box.flush(); } };   // 每秒:計時器那一輪(秒數、tick 條、階段時長、actApply)

// 1. 在底部:新內容跟著捲
M.scrollChat(); box.flush();
grow(120); M.scrollChat(); box.flush();
ok("在底部:新內容進來跟著捲到底", box.scrollTop === bottom(), [box.scrollTop, bottom()]);

// 4. 程式捲到底之後、scroll 事件到之前內容又長了 200px(大段回覆一次落地):不算用戶往上捲
grow(50); M.scrollChat(); grow(200); box.flush();
M.scrollChat(); box.flush();
ok("程式捲到底的事件晚到、內容已長高:照舊黏底", box.scrollTop === bottom(), [box.scrollTop, bottom()]);

// 離底 40px 內往上捲一點點:也放開(觸控板慢慢捲時每次都在 40px 內,照舊黏底的話永遠逃不掉;稽核 M1)
{ userScrollTo(bottom() - 30); const t0 = box.scrollTop; grow(80); M.scrollChat(); box.flush();
  ok("離底 30px(往上捲,40px 內):放開、不再跟著捲", box.scrollTop === t0, [box.scrollTop, t0, bottom()]); }
userScrollTo(bottom() - 20); grow(30); M.scrollChat(); box.flush();
ok("往下捲回離底 40px 內:恢復跟著捲", box.scrollTop === bottom(), [box.scrollTop, bottom()]);
// 稽核 M1 模擬 A:串流中同一個 frame「chunk 捲到底＋用戶往上捲 50px」,scroll 事件下一個 frame 才到
M.scrollChat(true); box.flush();
grow(100); M.scrollChat(); box.scrollTop = box.scrollTop - 50; box.flush();
{ const t0 = box.scrollTop; grow(20); M.scrollChat(); box.flush();
  ok("同一個 frame 內 chunk 捲底＋用戶上捲 50px:之後的 chunk 不再拉回底部", box.scrollTop === t0 && bottom() - box.scrollTop > 40, [box.scrollTop, t0, bottom()]); }
// 模擬 A2:觸控板慢捲,每 frame 上捲 8px、每 2 frame 一個 chunk
M.scrollChat(true); box.flush();
for (let i = 0; i < 30; i++) { box.scrollTop = box.scrollTop - 8; box.flush(); if (i % 2) { grow(5); M.scrollChat(); box.flush(); } }
ok("觸控板慢捲(30 frame × 8px、中間夾 chunk):逃得掉,離底 > 200px", bottom() - box.scrollTop > 200, bottom() - box.scrollTop);
// 滾輪往上:事件一到就放開(scroll 還沒變也一樣)
M.scrollChat(true); box.flush();
(box._on.wheel || []).forEach((f) => f({ type: "wheel", deltaY: -3 })); grow(50); M.scrollChat(); box.flush();
ok("滾輪往上:不等 scroll 事件就放開", bottom() - box.scrollTop === 50, bottom() - box.scrollTop);
M.scrollChat(true); box.flush();
(box._on.wheel || []).forEach((f) => f({ type: "wheel", deltaY: 3 })); grow(50); M.scrollChat(); box.flush();
ok("滾輪往下:不放開", box.scrollTop === bottom(), [box.scrollTop, bottom()]);
// 稽核 r2 S1:回覆還短、聊天欄還不能捲(scrollTop 0)時滾輪往上 / 按 ↑:不放開,之後內容長過一屏照樣跟著捲
{ box.scrollHeight = 300; box.scrollTop = 0; box.flush(); M.scrollChat(true); box.flush();
  (box._on.wheel || []).forEach((f) => f({ type: "wheel", deltaY: -3 })); (box._on.keydown || []).forEach((f) => f({ type: "keydown", key: "ArrowUp" }));
  grow(600); M.scrollChat(); box.flush();
  ok("還不能捲時滾輪往上、按 ↑:不放開,內容長過一屏照樣跟著捲", box.scrollTop === bottom() && bottom() > 0, [box.scrollTop, bottom()]);
  ok("wheel listener 是 passive(不擋捲動)、兩條都要 scrollTop > 0 才放開", /addEventListener\("wheel", \(e\) => \{ if \(e\.deltaY < 0 && \$\("chat-scroll"\)\.scrollTop > 0\) chatStick = false; \}, \{ passive: true \}\);/.test(src)
    && /"Home"\) && \$\("chat-scroll"\)\.scrollTop > 0\) chatStick = false;/.test(src)); }
// 模擬 B:上一條對話很長 → 清空(chatTop 歸零)→ 開較短的舊對話,強制捲底後圖片／字型晚到長高 >40 才收到 scroll 事件
M.scrollChat(true); box.flush(); grow(5000); M.scrollChat(); box.flush();
box.scrollHeight = 400; box.scrollTop = box.scrollTop; box.flush();
box.scrollHeight = 2000; M.scrollChat(true); grow(120); box.flush();
grow(300); M.scrollChat(); box.flush();
ok("開較短的舊對話後內容晚長高:不誤放開,之後 img load 照樣跟著捲", box.scrollTop === bottom(), [box.scrollTop, bottom()]);
ok("程式捲完同步 chatTop、清空對話時 chatTop 歸零;滾輪與往上的按鍵放開", /box\.scrollTop = box\.scrollHeight; chatTop = box\.scrollTop;/.test(src)
  && /chatStick = true; chatTop = 0;/.test(src.slice(src.indexOf("function csClearChat("), src.indexOf("function csClearChat(") + 1500)) && /addEventListener\("wheel", \(e\) => \{ if \(e\.deltaY < 0 && \$\("chat-scroll"\)\.scrollTop > 0\) chatStick = false; \}/.test(src));
// 內容變短(建議列收掉、泡泡收回)被瀏覽器夾回底部:照舊黏著
M.scrollChat(true); box.flush(); box.scrollHeight -= 60; box.scrollTop = box.scrollTop; box.flush(); grow(40); M.scrollChat(); box.flush();
ok("內容變短被夾回底部:照舊跟著捲", box.scrollTop === bottom(), [box.scrollTop, bottom()]);

// 2. 回合進行中,用戶往上捲
env.now = 0; M.busyStart(); box.flush();
M.busyStep({ id: "a", kind: "data", summary: "fetch BTCUSDT", tool: "Bash" }); M.scrollChat(); box.flush();
userScrollTo(100);
const top0 = box.scrollTop;
second(3);
ok("往上捲之後:計時器每秒更新不動 scrollTop", box.scrollTop === top0, box.scrollTop);
env.now += 100; M.busyStep({ id: "b", kind: "backtest", summary: "lib/runner.py", tool: "Bash" }); M.scrollChat(); box.flush();
env.now += 100; M.busyStep({ id: "c", kind: "backtest", summary: "lib/report.py", tool: "Bash" }); M.scrollChat(); box.flush();
at(env.now + 1300);
ok("子列真的換過字(換階段、1.2s 後換成最新一步)", M.busy.sub && M.busy.sub.textContent.indexOf("lib/report.py") >= 0, M.busy.sub && M.busy.sub.textContent);
["a", "b", "c"].forEach((id) => M.busyStepDone({ id, ms: 5 })); M.scrollChat(); box.flush();
second(3);
ok("狀態列真的換過字(工具做完 → 正在思考)", M.busy.verb.textContent === "act.thinking", M.busy.verb.textContent);
M.busyReason("thinking..."); grow(40); M.scrollChat(); box.flush();
ok("往上捲之後:子列換字、換階段、狀態列換字、新 chunk 都不動 scrollTop", box.scrollTop === top0, [box.scrollTop, top0]);

// 3. 自己捲回底部:恢復跟著捲
userScrollTo(bottom() - 10); grow(60); second(1); M.scrollChat(); box.flush();
ok("捲回底部附近:恢復跟著捲", box.scrollTop === bottom(), [box.scrollTop, bottom()]);

// 3. 往上捲之後送出新訊息:恢復跟著捲
userScrollTo(50); grow(60); M.scrollChat(); box.flush();
ok("又往上捲:不跟", box.scrollTop === 50, box.scrollTop);
M.scrollChat(true); box.flush();
grow(90); M.scrollChat(); box.flush();
ok("送出新訊息(scrollChat(true)):捲到底並恢復跟著捲", box.scrollTop === bottom(), [box.scrollTop, bottom()]);
ok("送出那條路有設回黏底(在畫自己那則泡泡之前)", (() => { const i = src.indexOf("async function submitMessage("), j = src.indexOf("chatStick = true;", i), k = src.indexOf('addMsg("you", msg', i); return i >= 0 && j > i && j < k; })());

// img load 會把 Event 當參數傳進 scrollChat:不可以當成強制捲
userScrollTo(20); M.scrollChat({ type: "load" }); box.flush();
ok("img load 的 Event 參數不算強制捲", box.scrollTop === 20, box.scrollTop);

// 出錯要讓人看到(對齊網頁 scrollDown(true)):往上捲著,錯誤卡／錯誤通知進來也拉到底並恢復跟捲;calm 的卡照黏底規則
userScrollTo(30); grow(70);
M.faultCard().set({ calm: true, text: "plan.done" }); box.flush();
ok("往上捲後 calm 卡(可以開始了)進來:不拉", box.scrollTop === 30, box.scrollTop);
grow(70); M.faultCard().set({ text: "turn.engineFailed" }); box.flush();
ok("往上捲後錯誤卡進來:拉到底", box.scrollTop === bottom(), [box.scrollTop, bottom()]);
grow(60); M.scrollChat(); box.flush();
ok("…之後恢復跟著捲", box.scrollTop === bottom(), [box.scrollTop, bottom()]);
// 同一張錯誤卡用一模一樣的內容重畫(回前景、每 5 秒重查;稽核 S1):不再拉到底;內容變了才拉
{ const card = M.faultCard(); card.set({ text: "fault.noCredit", label: "fault.noCreditBtn" }); box.flush();
  userScrollTo(40); grow(30); card.set({ text: "fault.noCredit", label: "fault.noCreditBtn" }); box.flush();
  ok("錯誤卡同內容重畫:不拉回底部", box.scrollTop === 40, box.scrollTop);
  card.set({ text: "fault.needCard", label: "acct.addCard" }); box.flush();
  ok("錯誤卡內容變了:拉到底", box.scrollTop === bottom(), [box.scrollTop, bottom()]); }
ok("錯誤通知(turn.error 那句、回合結束補出的錯誤與結束碼)走強制捲",
  /else \{ addMsg\("sys", line\); scrollChat\(true\); \}/.test(src) && /if \(exitLine\) addMsg\("sys", exitLine\); if \(pendingErr\.length \|\| exitLine\) scrollChat\(true\);/.test(src));

// 只有鈕、沒有句子的卡(資料卡試用態,paywall-redesign-2026-10-21 §2.2):第二顆可以是文字鈕、不放記號(act-only)、讀屏念鈕字;給了句子就照舊
{ const card = M.faultCard(), el = card.el; said.length = 0;
  card.set({ calm: true, text: "", label: "lib.gate.trial", on: () => {}, second: { label: "data.seePlan", quiet: true, on: () => {} } });
  const [text] = el.children[1].children;
  ok("只有鈕:卡掛 act-only、灰記號、句子那格藏起來;第二顆是 .btn-quiet;讀屏念兩顆鈕的字",
    el.classList.contains("act-only") && el.classList.contains("is-calm") && text.hidden === true && card.b1.className === "btn-fill" && card.b2.className === "btn-quiet" && card.b2.hidden === false
    && said.join("|") === "lib.gate.trial，data.seePlan", { cls: el.className, b2: card.b2.className, said });
  card.set({ text: "data.noPlan", label: "data.seePlan", on: () => {}, second: { label: "pv.apiPlan", on: () => {} } });
  ok("同一張卡換回有句子的那態:act-only 拿掉、句子露出、第二顆回到 .btn-out(沒給 quiet)", !el.classList.contains("act-only") && text.hidden === false && card.b2.className === "btn-out" && said[said.length - 1] === "data.noPlan", { cls: el.className, b2: card.b2.className });
  const css = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.css"), "utf8");
  ok("act-only 的樣式:不放記號、鈕列不留上距、文字鈕拉開 space-16", /\.msg\.fault\.act-only \.fault-mark \{ display: none; \}/.test(css) && /\.msg\.fault\.act-only \.fault-act \{ margin-top: 0; column-gap: var\(--space-16\); \}/.test(css)); }

process.exit(red ? 1 : 0);
