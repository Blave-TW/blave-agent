// 錯誤回報詢問卡撐過對話重畫(設計稽核 0.1.56 第二批 S2):主行程一天只給一張卡,卡被 csPaintHistory → csClearChat 清掉就要等到明天。
// 跑真的 errreport.js 與 app.js 的 faultCard／csClearChat／csPaintHistory／csDraw、chattabs.js 的 chatEl,假 DOM、假 window.blave(不開 Electron)。
//   1. 卡所在的眼前分頁重畫:同一個節點回到最底下、只有一張、不再問主行程;〔送出〕照原 id 叫 decide
//   2. 卡所在的分頁在背景重畫:卡接回它那條的最底下,不搬到眼前那條(0.1.59:卡只出在出事的那條對話)
//   3. 重畫的是別條:卡留在原處不動
//   4. 回合在跑時重畫卡所在那條:卡跟著即時那一段留下,不重複
//   5. 按過之後(已送出／不送的那行)重畫:不補回來
//   6. 分頁關掉、卡跟著不見:之後任何一條重畫都不會冒到別條
//   7. 回合結束(onTurnEnd 帶 sid):帶 sid 問主行程、卡畫在那一輪的分頁(就算眼前是別條);那條又在跑、已關掉:不問
// 跑法:node tests/check_shell_errreport_redraw.js
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
// 從原始碼切出一整個頂層函式(到下一行行首的 });一行寫完的只取那一行
const cut = (src, head) => {
  const i = src.indexOf(head); if (i < 0) throw new Error("找不到 " + head);
  const eol = src.indexOf("\n", i), line = src.slice(i, eol);
  if (/\}\s*(\/\/.*)?$/.test(line) && !line.trimEnd().endsWith("{")) return line + "\n";
  return src.slice(i, src.indexOf("\n}\n", i) + 3);
};

class N {
  constructor(tag) {
    this.tag = tag; this.children = []; this.parentNode = null; this.className = ""; this.attrs = {}; this.listeners = {}; this.hidden = false; this._t = "";
    const self = this;
    this.classList = {
      contains: (c) => self.className.split(" ").includes(c),
      add: (c) => { if (!self.classList.contains(c)) self.className = (self.className + " " + c).trim(); },
      remove: (c) => { self.className = self.className.split(" ").filter((x) => x && x !== c).join(" "); },
      toggle: (c, on) => { if (on === undefined) on = !self.classList.contains(c); if (on) self.classList.add(c); else self.classList.remove(c); return on; },
    };
  }
  get childNodes() { return this.children.slice(); }
  _rm(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parentNode = null; }
  appendChild(n) { if (n.parentNode) n.parentNode._rm(n); n.parentNode = this; this.children.push(n); return n; }
  append(...ns) { for (let n of ns) { if (typeof n === "string") { const s = new N("#text"); s._t = n; n = s; } this.appendChild(n); } }
  insertBefore(n, ref) { if (n.parentNode) n.parentNode._rm(n); n.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; this.children.splice(i < 0 ? this.children.length : i, 0, n); return n; }
  after(n) { const p = this.parentNode; p.insertBefore(n, p.children[p.children.indexOf(this) + 1] || null); }
  remove() { if (this.parentNode) this.parentNode._rm(this); }
  get isConnected() { let p = this; while (p.parentNode) p = p.parentNode; return p === ROOT; }
  contains(n) { for (let p = n; p; p = p.parentNode) if (p === this) return true; return false; }
  all() { const out = []; const walk = (x) => { for (const c of x.children) { out.push(c); walk(c); } }; walk(this); return out; }
  querySelectorAll(sel) { return this.all().filter((x) => x.classList.contains(sel.slice(1))); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this._t = String(v); }
  get textContent() { return this._t + this.children.map((c) => c.textContent).join(""); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  focus() {}
  getClientRects() { for (let p = this; p; p = p.parentNode) if (p.hidden) return []; return this.isConnected ? [1] : []; }
}
const ROOT = new N("root"), SCROLL = new N("div"); ROOT.appendChild(SCROLL);
const PEND = [], DECIDE = [];
let pendingResult = null, turns = [];
const ctx = {
  console, Promise, JSON, Array, String, Object, Math, Map, WeakMap,
  document: { createElement: (t) => new N(t), getElementById: () => null },
  window: { blave: {
    errReportPending: (sid) => { PEND.push(sid === undefined ? 1 : sid); return Promise.resolve(pendingResult); },
    errReportDecide: (...a) => { DECIDE.push(a); return Promise.resolve(true); },
    errReportMode: () => Promise.resolve("ask"),
    errReportModeSet: (m) => Promise.resolve(m),
    onTurnEnd: () => {},
    loadSession: () => Promise.resolve(turns),
    loadSessionImages: () => Promise.resolve([]),
  } },
  $: (id) => (id === "chat-scroll" ? SCROLL : { focus() {}, textContent: "" }),
  t: (k, v) => k + (v ? JSON.stringify(v) : ""),
  LANG: "zh", setTimeout: () => 0, requestAnimationFrame: () => 0,
  busyPin: () => {}, scrollChat: () => {}, srSay: () => {}, csRenderHead: () => {}, tabBg: () => false,
  splitAttachNote: (s) => ({ text: s, attachments: [] }),
  histFixOrder: (out, x) => { out.push(x); return out; },
  addHistoryYou: (s) => { const n = new N("div"); n.className = "msg you"; n._t = s; ctx.chatEl().appendChild(n); },
  addHistoryAi: (s) => { const n = new N("div"); n.className = "msg ai"; n._t = s; ctx.chatEl().appendChild(n); },
  csAnyTurn: () => false, tabRun: (T) => T.running === true,
  running: false, busy: null, liveBubble: null, swLine: null, swHeld: null, chatStick: true, chatTop: 0, acctCard: null, creditCards: [], dataCard: null, csTitle: "",
  CS: { cur: null, loaded: null, bg: false, tabs: new Map() },
  // chattabs.js 的 withTab 契約:把 T 換成載入中的那個同步跑、跑完換回(每輪全域的換手不在這支測試的範圍)
  withTab: (T, fn) => { const C = ctx.CS; if (!T || T === C.loaded) return fn(); const prev = C.loaded; C.loaded = T; C.bg = T !== C.cur; try { return fn(); } finally { C.loaded = prev; C.bg = false; } },
};
vm.createContext(ctx);
const app = read("app.js"), tabs = read("chattabs.js");
vm.runInContext(["const SYS_RELANG = new WeakMap();", "let SYS_QUIET = false;", "function sysLz(fn) { const o = fn(); Object.defineProperty(o, \"__mk\", { value: fn }); return o; }",
  cut(tabs, "function chatEl("), cut(app, "function faultCard("), cut(app, "function csClearChat("), cut(app, "async function csDraw("), cut(app, "function csPaintHistory(")].join("\n"), ctx);
vm.runInContext(read("errreport.js"), ctx);
const flush = () => new Promise((r) => setImmediate(r));
const errLive = () => vm.runInContext("errLive", ctx);

function tab(sid) { const el = new N("div"); el.className = "chat-thread"; SCROLL.appendChild(el); const T = { sid, el, dead: false, drawn: true }; ctx.CS.tabs.set(sid, T); return T; }
function show(T) { for (const x of ctx.CS.tabs.values()) x.el.hidden = x !== T; ctx.CS.cur = T; ctx.CS.loaded = T; }
const cards = () => SCROLL.querySelectorAll(".err-sub").map((s) => { let p = s; while (p && !p.classList.contains("fault")) p = p.parentNode; return p; });
async function ask(id) { pendingResult = { id, n: 1, text: "[]" }; await vm.runInContext("errAsk()", ctx); await flush(); }
const last = (T) => T.el.children[T.el.children.length - 1];

(async () => {
  turns = [{ role: "user", content: "hi", ts: 1 }, { role: "assistant", content: "yo", ts: 2 }];
  const A = tab("A"), B = tab("B");

  // 1
  show(A); await ask("b1");
  const card = errLive() && errLive().el, asked = PEND.length;
  ok("前提:卡畫在眼前那條、只問過主行程一次", !!card && A.el.contains(card) && cards().length === 1 && asked === 1);
  await vm.runInContext("csDraw(CS.tabs.get('A'))", ctx); await flush();
  ok("1 眼前那條重畫:同一個節點還在、在最底下", card.isConnected && A.el.contains(card) && last(A) === card, A.el.children.map((c) => c.className));
  ok("1 只有一張卡", cards().length === 1, cards().length);
  ok("1 沒有再問主行程(pending 會用掉當天額度)", PEND.length === asked, PEND.length);
  await vm.runInContext("csDraw(CS.tabs.get('A'))", ctx); await flush();
  ok("1 連續重畫兩次也只有一張", cards().length === 1 && errLive() && errLive().el === card);

  // 2
  show(B);
  ok("前提:換到 B,卡留在 A", A.el.contains(card) && !B.el.contains(card));
  await vm.runInContext("csDraw(CS.tabs.get('A'))", ctx); await flush();
  ok("2 背景的 A 重畫:卡接回 A 的最底下、不搬到眼前的 B", A.el.contains(card) && !B.el.contains(card) && last(A) === card, { inA: A.el.contains(card), inB: B.el.contains(card) });
  ok("2 只有一張、沒有再問", cards().length === 1 && PEND.length === asked);

  // 3
  const before = A.el.children.indexOf(card);
  await vm.runInContext("csDraw(CS.tabs.get('B'))", ctx); await flush();
  ok("3 重畫的是 B,卡留在 A 原處", A.el.contains(card) && A.el.children.indexOf(card) === before && cards().length === 1);

  // 4
  show(A); ctx.running = true;
  await vm.runInContext("csDraw(CS.tabs.get('A'))", ctx); await flush();
  ok("4 回合在跑時重畫:卡跟著即時那一段留在 A、只有一張", A.el.contains(card) && cards().length === 1, cards().length);
  ctx.running = false;

  // 〔送出〕照原 id
  card.querySelector(".fault-act").children[0].click(); await flush();
  ok("〔送出〕照原 id 叫 decide 一次", DECIDE.length === 1 && DECIDE[0][0] === "b1" && DECIDE[0][1] === "send", DECIDE);

  // 5
  ok("前提:按過之後 errLive 收掉", errLive() === null);
  await vm.runInContext("csDraw(CS.tabs.get('A'))", ctx); await flush();
  ok("5 按過之後重畫:那行不補回來", cards().length === 0 && !card.isConnected, cards().length);

  // 6
  show(A); await ask("b2");
  const c2 = errLive().el;
  A.el.remove(); A.dead = true; ctx.CS.tabs.delete("A");   // tabsDestroy
  show(B);
  ok("前提:分頁關掉,卡跟著不見", !c2.isConnected);
  await vm.runInContext("csDraw(CS.tabs.get('B'))", ctx); await flush();
  ok("6 別條重畫:卡不冒到 B、也不再問", !B.el.contains(c2) && cards().length === 0 && errLive() === null && PEND.length === asked + 1, { inB: B.el.contains(c2), n: cards().length, pend: PEND.length });

  // 7
  const C = tab("C"); show(B);
  pendingResult = { id: "b3", n: 1, text: "[]" };
  await vm.runInContext("errAsk('C')", ctx); await flush();
  ok("7 回合結束:帶那條的 sid 問主行程", PEND[PEND.length - 1] === "C", PEND);
  ok("7 …卡畫在 C(眼前是 B)", errLive() && C.el.contains(errLive().el) && !B.el.contains(errLive().el));
  const n7 = PEND.length;
  C.running = true; await vm.runInContext("errAsk('C')", ctx);
  C.running = false; await vm.runInContext("errAsk('gone')", ctx);
  ok("7 那條又在跑、或已經不在:不問", PEND.length === n7, PEND);

  console.log(red ? `\n${red} FAIL` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  例外 " + (e && e.stack)); process.exit(1); });
