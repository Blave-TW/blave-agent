// 回合狀態列的階段清單預設收合(Wei 10-15,0.1.25;designer 0125-review spec-turn-receipt-collapse)。
//   以前階段清單在展開區(.think-reason-wrap)外面,CSS 只在 is-done 時才藏它 → 跑著時直接長出來,按 ⌄ 只開合下面的收據,清單收不掉。
//   現在清單住進 .think-fold,一顆 ⌄ 管全部,只有收合／展開兩態。
//   1. 新回合長出兩種階段:收著(aria-expanded=false);收合列不多任何節點;aria-controls 指向整塊展開區、每輪各一個 id
//   2. 按 ⌄ 收起 → 再來 ≥3 次進度更新(新步驟、步驟做完、計時器、思考文字)仍收著;再按一次展開;Enter / Space 同樣開關
//   3. 回合結束一律收起(展開過也一樣);出錯的回合例外,收據自己攤開
//   4. 回放(receiptFold)預設攤開(Wei 10-16:回放的收據都來自停止／出錯的回合;spec-turn-phases-one-layer 舊帳 1)
//   一層化之後(spec-turn-phases-one-layer):展開區只剩階段清單＋思考文字,role=status 只包狀態列那一行,清單沒有高度上限
// 純 node:切 app.js 原文跑在假 DOM 上(不起 Electron);「看得到」= 清單沒 hidden、在展開區裡、而展開區開著(app.css 的 1fr 規則)
// 跑法:node tests/check_shell_receipt_collapse.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "app.js"), "utf8"), css = fs.readFileSync(path.join(R, "app.css"), "utf8");
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("找不到標記:" + a); return src.slice(i, j); };
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.dataset = {}; this.style = {};
    this.hidden = false; this._text = ""; this._cls = new Set(); this._on = {}; this.scrollTop = 0; this.scrollHeight = 0;
    const s = this._cls; this.classList = { add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)), contains: (c) => s.has(c),
      toggle: (c, f) => { const on = f === undefined ? !s.has(c) : !!f; if (on) s.add(c); else s.delete(c); return on; } }; }
  set className(v) { this._cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this._cls.add(c)); }
  get className() { return [...this._cls].join(" "); }
  set textContent(v) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  insertBefore(c, ref) { if (c.parentNode) c.remove(); c.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
  before(c) { this.parentNode.insertBefore(c, this); }
  get nextSibling() { const p = this.parentNode; return p ? p.children[p.children.indexOf(this) + 1] || null : null; }
  remove() { if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
  matches() { return false; } focus() {}
  addEventListener(t, f) { (this._on[t] = this._on[t] || []).push(f); }
  dispatch(type, extra) { const ev = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra }; (this._on[type] || []).forEach((f) => f(ev)); return ev; }
  click() { this.dispatch("click"); }
  // HTML 按鈕的鍵盤啟動行為:Enter 在 keydown 觸發 click、Space 在 keyup;有人 preventDefault 就不觸發
  key(k) { const d = this.dispatch("keydown", { key: k }); const u = this.dispatch("keyup", { key: k });
    if (this.tagName !== "BUTTON") return; if (k === "Enter" && !d.defaultPrevented) this.click(); if (k === " " && !d.defaultPrevented && !u.defaultPrevented) this.click(); }
  _all(out) { this.children.forEach((c) => { out.push(c); c._all(out); }); return out; }
  querySelectorAll(sel) { const want = sel.split(".").filter(Boolean); return this._all([]).filter((e) => want.every((c) => e._cls.has(c))); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
const scroll = new El("div"), timers = [];
const ctx = {
  document: { createElement: (t) => new El(t) }, $: (id) => (id === "chat-scroll" ? scroll : new El("div")),
  t: (k) => k, STRINGS: { en: new Proxy({}, { get: (_, k) => (typeof k === "string" && /^(act|step)\./.test(k) ? k : undefined) }) },
  setInterval: (f) => { timers.push(f); return timers.length; }, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
  requestAnimationFrame: () => {}, getComputedStyle: () => ({ getPropertyValue: () => "180ms" }), window: {},
  scrollChat: () => {}, TICK_WINDOW: 24, TICK_PITCH: 4, brNeedsUser: () => false, brHost: () => "", brReg: (h) => h,
  whereTag: () => new El("span"), stepWhere: (c) => (c && String(c.tool || "").indexOf("mcp__blave__") === 0 ? "cloud" : "local"),
};
const body = cut("let busy = null;", "/* 停止(照雲端工作頁") + cut("function receiptFold(", "/* 舊回合的使用者那句");
const M = new Function(...Object.keys(ctx), body + "; return { busyStart, busyStep, busyStepDone, busyReason, busyEnd, receiptFold, phasesPaint, get busy() { return busy; } };")(...Object.values(ctx));

const inWrap = (n) => { for (let p = n.parentNode; p; p = p.parentNode) if (p.classList.contains("think-reason-wrap")) return p; return null; };
function phasesShown(el) {
  const ol = el.querySelector(".think-phases"), wrap = inWrap(ol);
  if (!wrap) throw new Error("階段清單不在展開區裡");
  return !ol.hidden && el.classList.contains("is-open");
}
ok("app.css:展開區只靠 is-open 開(1fr)、預設 0fr;階段清單沒有自己的顯示規則;chevron 翻轉只綁 aria-expanded",
  /\.think-reason-wrap \{[^}]*grid-template-rows: 0fr;/.test(css) && css.includes(".think-indicator.is-open .think-reason-wrap { grid-template-rows: 1fr; }")
  && !/\.think-phases[^{]*\{[^}]*display/.test(css) && css.includes('.think-head[aria-expanded="true"] .think-chev {') && !/is-open[^{]*\.think-chev/.test(css));
ok("app.css:階段清單沒有高度上限、不內捲(內捲自動捲到底會把最上面一列裁一半,spec-turn-phases-one-layer §3);逐步清單的樣式拿掉",
  /\.think-phases \{ list-style: none;[^}]*\}/.test(css) && !/\.think-phases \{[^}]*(max-height|overflow)/.test(css) && !/\.think-steps?[ {.]/.test(css));

const tick = () => timers[timers.length - 1]();
function liveTurn() {
  timers.length = 0; M.busyStart();
  M.busyStep({ tool: "mcp__blave__data", kind: "data", kind_obj: "BTCUSDT", id: "a" }); M.busyStepDone({ id: "a", ms: 900 });
  M.busyStep({ tool: "Bash", kind: "backtest", kind_obj: "tw_four_factor_basket", id: "b" }); tick();
  return M.busy;
}
const st = (b) => ({ shown: phasesShown(b.el), open: b.el.classList.contains("is-open"), aria: b.head.getAttribute("aria-expanded"), rows: b.phasesEl.children.length });
const headKids = (h) => h.children.map((c) => c.className).join("|");

// 1
let b = liveTurn(), s = st(b);
ok("1 新回合長出兩種階段(寫進清單了),但預設收著、aria-expanded=false", s.rows === 2 && !b.phasesEl.hidden && !s.shown && !s.open && s.aria === "false", s);
ok("1 head 是 <button type=button>(鍵盤 Enter / Space 開關靠原生按鈕)", b.head.tagName === "BUTTON" && b.head.type === "button");
ok("1 收合列不加字:head 只有 tick 條、摘要、時長、chevron 四個節點", headKids(b.head) === "think-ticks|think-sum|think-elapsed|think-chev cv7", headKids(b.head));
const ctl1 = b.head.getAttribute("aria-controls"), wrap1 = inWrap(b.phasesEl);
ok("1 aria-controls 指向整塊展開區(清單、思考文字都在裡面)", !!ctl1 && wrap1.id === ctl1 && inWrap(b.reason) === wrap1 && b.phasesEl.getAttribute("aria-hidden") === null, { ctl1, id: wrap1 && wrap1.id });
{ let p = b.head.parentNode; const live = p && p.getAttribute("role") === "status" && p.getAttribute("aria-live") === "polite" ? p : null;
  const inLive = (n) => { for (let q = n; q; q = q.parentNode) if (q === live) return true; return false; };
  ok("1 role=status 只包狀態列那一行(head);展開區、階段清單不在 live region 裡;整塊 .think-indicator 不掛 role", !!live && b.el.getAttribute("role") === null && !inLive(wrap1) && !inLive(b.phasesEl) && live.parentNode === b.el); }

// 2 滑鼠
b.head.click(); s = st(b);
ok("2 按 ⌄:展開,階段清單出現", s.shown && s.open && s.aria === "true", s);
b.head.click(); s = st(b);
ok("2 再按 ⌄:收起", !s.shown && !s.open && s.aria === "false", s);
M.busyStepDone({ id: "b", ms: 4000 }); M.busyStep({ tool: "Bash", kind: "scan", kind_obj: "x", id: "c" }); tick(); M.busyReason("thinking"); tick(); M.busyStep({ tool: "Write", kind: "report", id: "d" }); tick();
s = st(b);
ok("2 收起後再來 6 次進度更新(做完、新步驟、計時器 ×3、思考文字):仍收著", s.rows >= 4 && !s.shown && !s.open && s.aria === "false", s);
b.head.click(); s = st(b);
ok("2 再按一次 ⌄ 展開", s.shown && s.open && s.aria === "true", s);
tick(); tick(); tick(); M.busyStep({ tool: "Bash", kind: "order", id: "e" }); s = st(b);
ok("2 展開後再來 4 次更新:仍展開(更新不改用戶的選擇)", s.shown && s.open, s);

// 2 鍵盤
for (const [name, k] of [["Enter", "Enter"], ["Space", " "]]) {
  M.busyEnd(false); b = liveTurn();
  b.head.key(k); const a1 = st(b);
  b.head.key(k); const a2 = st(b);
  M.busyStep({ tool: "Bash", kind: "scan", id: "k1" }); tick(); tick(); M.busyStepDone({ id: "k1" }); const a3 = st(b);
  b.head.key(k); const a4 = st(b);
  ok(`2 鍵盤 ${name}:展開 → 收起 → 3 次以上更新仍收著 → 再按展開`, a1.shown && a1.aria === "true" && !a2.shown && a2.aria === "false" && !a3.shown && a4.shown && a4.aria === "true", [a1, a2, a3, a4]);
}

// 3 收尾
M.busyEnd(false); b = liveTurn();
ok("1 每輪各一個 aria-controls id", b.head.getAttribute("aria-controls") !== ctl1, [ctl1, b.head.getAttribute("aria-controls")]);
b.head.click(); M.busyEnd(false);
ok("3 回合中展開過、正常收尾:收起(aria-expanded=false)", !st(b).open && !st(b).shown && st(b).aria === "false", st(b));
b = liveTurn(); M.busyEnd(false);
ok("3 沒碰過 ⌄、正常收尾:收著", !st(b).open && !st(b).shown, st(b));
b = liveTurn(); b.head.click(); b.head.click(); M.busyEnd(true);
ok("3 出錯收尾(例外):收據自己攤開,aria-expanded=true", st(b).open && st(b).shown && st(b).aria === "true", st(b));

// 5 讀屏與捲動(稽核 0125 P2-1):清單在 role=status 裡,每秒的 paint 列沒變就不能重建
{ const ol = new El("ol"), rows = [{ phase: "data", kind: "data", obj: "BTCUSDT", start: 0, end: 5000 }, { phase: "backtest", kind: "backtest", obj: "x", start: 5000, end: null }];
  M.phasesPaint(ol, rows, 7000, true); const li0 = ol.children.slice(), t1 = ol.children[1].querySelector("think-phase-time").textContent;
  ol.scrollTop = 120;
  M.phasesPaint(ol, rows.map((r) => ({ ...r })), 9000, true); const t2 = ol.children[1].querySelector("think-phase-time").textContent;
  ok("5 連續兩次 paint、列沒變:列節點是同一批(不重建、捲動不被拉回),只有進行中那列的秒數在走", ol.children.length === 2 && ol.children.every((c, i) => c === li0[i]) && t1 === "2s" && t2 === "4s" && ol.scrollTop === 120, { t1, t2 });
  ok("5 秒數節點 aria-hidden(只給眼睛,不進 live region)", ol.querySelectorAll("think-phase-time").every((x) => x.getAttribute("aria-hidden") === "true") && ol.querySelectorAll("think-phase-time").length === 2);
  M.phasesPaint(ol, rows.concat([{ phase: "report", kind: "report", obj: "", start: 9500, end: null }]).map((r, i) => (i === 1 ? { ...r, end: 9500 } : r)), 9800, true);
  ok("5 換階段:才重建(多一列、舊的最後一列不再是 is-run)", ol.children.length === 3 && ol.children[0] !== li0[0] && !ol.children[1].classList.contains("is-run") && ol.children[2].classList.contains("is-run"));
  const live = liveTurn(), first = live.phasesEl.children[0]; tick(); tick(); tick();
  ok("5 即時回合:計時器跑 3 次,階段列節點不換", live.phasesEl.children[0] === first);
  ok("5 收合時展開區 visibility:hidden(等淡出跑完才切),展開時 visible 立刻生效——收著的清單不進讀屏",
    /\.think-fold \{[^}]*opacity: 0; visibility: hidden; transition: opacity var\(--motion-base\) var\(--ease-standard\), visibility 0s linear var\(--motion-base\);/.test(css)
    && /\.think-indicator\.is-open \.think-fold \{ opacity: 1; visibility: visible; transition: opacity var\(--motion-base\) var\(--ease-standard\), visibility 0s; \}/.test(css));
  M.busyEnd(false); }

// 4 回放
const f = M.receiptFold([{ tool: "WebSearch", summary: "q" }, { tool: "Write", summary: "x.py" }]);
const fRows = f.querySelector(".think-phases").children.length, fh = f.querySelector(".think-head"), fw = inWrap(f.querySelector(".think-phases"));
const fs1 = phasesShown(f), fa1 = fh.getAttribute("aria-expanded");
fh.click(); const fs2 = phasesShown(f), fa2 = fh.getAttribute("aria-expanded"); fh.key(" "); const fs3 = phasesShown(f);
ok("4 回放(兩種階段):預設攤開(aria-expanded=true);按 ⌄ 收起、再按(Space)展開;aria-controls 指向展開區", fRows === 2 && fs1 && fa1 === "true" && !fs2 && fa2 === "false" && fs3 && fh.getAttribute("aria-controls") === fw.id, { fRows, fs1, fs2, fs3 });

console.log(red ? `\n${red} FAILED` : "\nALL PASS");
process.exit(red ? 1 : 0);
