// 錯誤回報的畫面那半(shell/renderer/errreport.js),用假的 DOM 與 window.blave 跑真的檔(不開 Electron)。
//   1. 沒按之前不叫 decide;〔看會送出的內容〕展開的是主行程給的那份文字,aria-expanded 跟著切、鈕不重建(焦點留著)、展開時捲到勾選說明
//   1b. 版面:帳號句與展開鈕在鈕列上面,勾選在鈕列裡、說明緊接在鈕列下;勾選是 canon 的 .ps-cb
//   2. 勾了以後自動送 → decide(id, "send", true);主行程回 true 才說「已送出」、模式跟著變自動送;勾選與說明拿掉、焦點回輸入框;之後再展開捲到鈕列
//   3. 主行程回 false(批次已被新卡取代、設定改成不送)→ 卡收掉,不說送了
//   4. 〔不送〕→ decide(id, "decline", false)
//   5. 新卡出來時收掉還沒按的舊卡
//   6. 有回合在跑、還在連結畫面(對話區看不見)時不問主行程
//   7. 設定那一塊:三格、選中的 aria-checked、點了叫 errReportModeSet、回什麼才畫什麼
// 跑法:node tests/check_shell_errreport_ui.js
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

class Node_ {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.listeners = {}; this.hidden = false; this.parent = null; this._text = ""; this.className = ""; }
  append(...ns) { for (const n of ns) { if (n && typeof n === "object") { if (n.parent) n.detach(); n.parent = this; } this.children.push(n); } }
  detach() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  remove() { this.detach(); this.removed = true; }
  insertBefore(n, ref) { n.detach(); n.parent = this; this.children.splice(this.children.indexOf(ref), 0, n); }
  after(n) { n.detach(); const p = this.parent; n.parent = p; p.children.splice(p.children.indexOf(this) + 1, 0, n); }
  querySelector(sel) { return this.all().find((n) => sel.startsWith(".") && n.className.split(" ").includes(sel.slice(1))) || null; }
  focus() { FOCUS.push(this.id || this.tag); }
  scrollIntoView(o) { SCROLLS.push([this.className, o && o.block]); }
  get isConnected() { let p = this; while (p.parent) p = p.parent; return CARDS.some((c) => c.el === p); }   // 假 DOM 沒有 document:接在卡上算接著
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => (typeof c === "object" ? c.textContent : String(c))).join(""); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  fire(ev, e) { for (const fn of this.listeners[ev] || []) fn(e || {}); }
  all() { const out = []; const walk = (n) => { for (const c of n.children) if (c && typeof c === "object") { out.push(c); walk(c); } }; walk(this); return out; }
  querySelectorAll(sel) { const m = /^button(\[data-err-mode\])?$/.exec(sel); return this.all().filter((n) => m && n.tag === "button"); }
  closest(sel) { return sel.startsWith("button") && this.tag === "button" ? this : null; }
}
const CARDS = [], FOCUS = [], SCROLLS = [];
function faultCard() {   // 跟 app.js 的 faultCard 同結構:.fault-body > 說明句、.fault-act(b1 b2)、.fault-sub;set 只換字、藏鈕、重掛 sub
  const el = new Node_("div"), body = new Node_("div"), text = new Node_("div"), act = new Node_("div"), sub = new Node_("div");
  body.className = "fault-body"; act.className = "fault-act"; sub.className = "fault-sub";
  const b1 = new Node_("button"), b2 = new Node_("button");
  act.append(b1, b2); body.append(text, act, sub); el.append(body);
  const card = { el, states: [], set(s) {
    this.states.push(s); this.last = s; this.mk = s.__mk || null;
    text.textContent = s.text || ""; b1.hidden = !s.label; b2.hidden = !s.second;
    sub.hidden = !s.sub; sub.textContent = ""; if (s.sub) sub.append(s.sub);
  } };
  CARDS.push(card);
  return card;
}
const DECIDE = [], MODESET = [], PEND = [];
let LANGP = "", decideResult = true, modeSetResult = (m) => m, pendingResult = null, anyTurn = false, visible = true, onTurnEnd = null;
const ctx = {
  console, Promise, JSON, Array, String, Object, Math,
  document: { createElement: (t) => new Node_(t), createTextNode: (s) => s, getElementById: () => null },
  window: { blave: {
    errReportPending: () => { PEND.push(1); return Promise.resolve(pendingResult); },
    errReportDecide: (...a) => { DECIDE.push(a); return Promise.resolve(decideResult); },
    errReportMode: () => Promise.resolve("ask"),
    errReportModeSet: (m) => { MODESET.push(m); return Promise.resolve(modeSetResult(m)); },
    onTurnEnd: (fn) => { onTurnEnd = fn; },
  } },
  t: (k, v) => LANGP + k + (v ? JSON.stringify(v) : ""),
  sysLz: (fn) => { const o = fn(); Object.defineProperty(o, "__mk", { value: fn }); return o; },
  $: (id) => ({ focus: () => FOCUS.push(id) }),
  faultCard,
  chatEl: () => ({ isConnected: true, getClientRects: () => (visible ? [1] : []) }),
  csAnyTurn: () => anyTurn,
  setTimeout: () => 0,
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "errreport.js"), "utf8"), ctx);
const flush = () => new Promise((r) => setImmediate(r));
const find = (card, pred) => card.el.all().find(pred);
const cls = (c) => (n) => n.className.split(" ").includes(c);

(async () => {
  // 1–2
  ctx.errCard({ id: "b1", n: 2, text: "[{\"exc_type\":\"KeyError\"}]" });
  const c1 = CARDS[0];
  ok("1 卡上是 N 個錯誤、送出／不送兩顆鈕(展開不是第三個選項)", c1.last.text === 'err.cardN{"n":2}' && c1.last.label === "err.send" && c1.last.second.label === "err.dontSend" && !c1.last.third, c1.last);
  ok("1 沒按之前不叫 decide", DECIDE.length === 0);
  const pre = find(c1, (n) => n.tag === "pre"), tog = find(c1, cls("err-tog"));
  ok("1 〔看會送出的內容〕之前收著、裡面是主行程給的那份文字", pre.hidden === true && pre.textContent === "[{\"exc_type\":\"KeyError\"}]" && tog.textContent === "err.view");
  ok("1 展開鈕有 aria-expanded=false、aria-controls 指到 JSON 框;JSON 框可聚焦、有名稱", tog.attrs["aria-expanded"] === "false" && tog.attrs["aria-controls"] === pre.id && pre.id && pre.tabIndex === 0 && pre.attrs["aria-label"] === "err.view");
  const setsBefore = c1.states.length;
  tog.fire("click");
  ok("1 展開時捲到勾選說明露出來為止(nearest:看得到就不動)", SCROLLS.length === 1 && SCROLLS[0][0] === "err-note" && SCROLLS[0][1] === "nearest", SCROLLS);
  ok("1 按了展開、鈕換成收起、aria-expanded=true;不經 card.set(鈕不重建,焦點留著)", pre.hidden === false && tog.textContent === "err.hide" && tog.attrs["aria-expanded"] === "true" && c1.states.length === setsBefore && find(c1, cls("err-tog")) === tog);
  tog.fire("click");
  ok("1 收回不捲", SCROLLS.length === 1, SCROLLS);
  ok("1 再按收回", pre.hidden === true && tog.attrs["aria-expanded"] === "false" && tog.textContent === "err.view");
  const body = c1.el.querySelector(".fault-body"), act = body.querySelector(".fault-act"), fsub = body.querySelector(".fault-sub");
  const lab = find(c1, cls("err-always")), note = find(c1, cls("err-note")), box = find(c1, (n) => n.tag === "input");
  ok("1b 帳號句與展開鈕在鈕列上面", body.children.indexOf(fsub) < body.children.indexOf(act) && fsub.all().some(cls("err-acct")) && fsub.all().includes(tog));
  ok("1b 勾選在鈕列裡、排在鈕後面;說明緊接在鈕列下", lab.parent === act && act.children.indexOf(lab) === act.children.length - 1 && body.children[body.children.indexOf(act) + 1] === note);
  ok("1b 勾選用 .ps-cb、讀屏帶著說明", box.className === "ps-cb" && box.attrs["aria-describedby"] === note.id && note.textContent === "err.alwaysNote");
  LANGP = "en:"; c1.mk(); LANGP = "";
  ok("1b 換語言:卡上句子、帳號句、展開鈕、勾選、說明一起換", find(c1, cls("err-acct")).textContent === "en:err.acct" && tog.textContent === "en:err.view" && lab.textContent === "en:err.always" && note.textContent === "en:err.alwaysNote");
  c1.mk();
  box.checked = true;
  await c1.last.on(); await flush();
  ok("2 勾了以後自動送 → decide(id, send, true)", JSON.stringify(DECIDE[0]) === JSON.stringify(["b1", "send", true]), DECIDE);
  ok("2 主行程回 true 才說已送出、模式變自動送", c1.last.text === "err.sent" && ctx.ERR_MODE === "auto", [c1.last, ctx.ERR_MODE]);
  ok("2 按完勾選與說明都不在了、焦點回輸入框", !c1.el.all().includes(lab) && !c1.el.all().includes(note) && FOCUS[FOCUS.length - 1] === "ta", FOCUS);
  tog.fire("click");
  ok("2 說明拿掉之後再展開:捲到鈕列(不打在已拿掉的節點上)", SCROLLS.length === 2 && SCROLLS[1][0] === "fault-act" && SCROLLS[1][1] === "nearest", SCROLLS);
  tog.fire("click");
  LANGP = "en:"; const relang = c1.mk && c1.mk(); LANGP = "";
  ok("2 已送出那句也跟著換語言", relang && relang.text === "en:err.sent", relang);
  // 3
  ctx.ERR_MODE = "ask"; decideResult = false;
  ctx.errCard({ id: "b2", n: 1, text: "[]" });
  const c2 = CARDS[1];
  await c2.last.on(); await flush();
  ok("3 主行程回 false:卡收掉,沒說送了、焦點回輸入框", c2.el.removed === true && c2.states.every((s) => s.text !== "err.sent") && ctx.ERR_MODE === "ask" && FOCUS[FOCUS.length - 1] === "ta");
  // 4
  decideResult = true;
  ctx.errCard({ id: "b3", n: 1, text: "[]" });
  const c3 = CARDS[2];
  await c3.last.second.on(); await flush();
  ok("4 〔不送〕→ decide(id, decline, false)、卡上說不再問", JSON.stringify(DECIDE[DECIDE.length - 1]) === JSON.stringify(["b3", "decline", false]) && c3.last.text === "err.declined");
  // 5
  ctx.errCard({ id: "b4", n: 1, text: "[]" });
  ctx.errCard({ id: "b5", n: 2, text: "[]" });
  ok("5 新卡出來時收掉還沒按的舊卡", CARDS[3].el.removed === true && !CARDS[4].el.removed);
  // 6
  PEND.length = 0;
  anyTurn = true; await ctx.errAsk();
  anyTurn = false; visible = false; await ctx.errAsk();
  ok("6 有回合在跑、對話區看不見:不問主行程", PEND.length === 0, PEND);
  visible = true; pendingResult = { id: "b6", n: 1, text: "[]" }; await ctx.errAsk(); await flush();
  ok("6 閒著、看得見:問主行程、出卡", PEND.length === 1 && CARDS.length === 6);
  ok("6 回合結束時排一次詢問", typeof onTurnEnd === "function");
  // 7
  const mk = (tag, cls, text) => { const n = new Node_(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  ctx.ERR_MODE = "ask";
  const blk = ctx.errPrivBlock(mk);
  const btns = blk.all().filter((n) => n.tag === "button");
  ok("7 三格,每次問我是選中的", btns.map((b) => b.dataset.errMode).join() === "ask,auto,off" && btns[0].attrs["aria-checked"] === "true" && btns[1].attrs["aria-checked"] === "false");
  const seg = blk.all().find((n) => n.attrs.role === "radiogroup");
  seg.fire("click", { target: btns[2] }); await flush();
  ok("7 點「不送」→ errReportModeSet(off)、主行程回 off 才算", MODESET[0] === "off" && ctx.ERR_MODE === "off");
  modeSetResult = () => null;
  seg.fire("click", { target: btns[1] }); await flush();
  ok("7 主行程沒存成:畫面維持原狀", MODESET[1] === "auto" && ctx.ERR_MODE === "off");
  const txt = blk.textContent;
  ok("7 說明行與標題都在、不是使用資料那張清單", txt.includes("err.priv.h") && txt.includes("err.priv.note") && !txt.includes("priv.c."));
  console.log(red ? `\n${red} FAILED` : "\nall ok");
  process.exit(red ? 1 : 0);
})();
