// 收回中欄展開層(只收展開層,不關分頁、不打斷 agent):Esc 這條路;聊天瀏覽卡頭的「收回」文字鈕拿掉。
//   1. 中欄標題列的 ✕(spec-desktop-browser-close-0.1.8):牆 / 單頁 / 快照都有、按了走 brCollapse(true)、重畫後焦點放回;位置與熱區的實測在 check_shell_browser_ui.js
//   2. Esc:展開中才收;別的框已經處理(defaultPrevented)、組字中、網址列編輯中都不動
//   3. 卡頭與摘要列在中欄開著時沒有文字鈕;br.closePanel 兩語都刪了
// 跑法:node tests/check_shell_browser_close_button.js
const fs = require("fs"), path = require("path");
const RD = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(RD, "browser.js"), "utf8"), css = fs.readFileSync(path.join(RD, "browser.css"), "utf8");
const strings = fs.readFileSync(path.join(RD, "strings.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const fnCut = (name) => { const a = src.indexOf("function " + name + "("); return src.slice(a, src.indexOf("\n}\n", a) + 3); };

// ---- 1. 真的 brPaintOverlay 跑在假 DOM 上:三種模式都有 ✕、按了只收展開層、重畫後焦點放回新的 ✕
{
  const doc = { activeElement: null };
  function El(cls, text) { this.className = cls || ""; this.kids = []; this.text = text || ""; this.attrs = {}; this.on = {}; this.dataset = {}; this.style = {}; this.hidden = false; this.parentNode = null; this.isConnected = true; }
  const has = (n, c) => (" " + n.className + " ").includes(" " + c + " ");
  const walk = (n, out = []) => { for (const k of n.kids) if (k instanceof El) { out.push(k); walk(k, out); } return out; };
  Object.assign(El.prototype, {
    append(...k) { k.forEach((x) => { if (x instanceof El) x.parentNode = this; this.kids.push(x); }); }, prepend() {},
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, addEventListener(k, f) { this.on[k] = f; },
    querySelectorAll(sel) { const c = sel.trim().split(/\s+/).pop().replace(/\[.*$/, "").slice(1); return walk(this).filter((n) => has(n, c)); },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    contains(n) { return n === this || walk(this).includes(n); }, focus() { doc.activeElement = this; }, replaceWith() {}, remove() {},
  });
  Object.defineProperty(El.prototype, "textContent", { get() { return this.text; }, set(v) { this.kids = []; this.text = v; } });
  Object.defineProperty(El.prototype, "classList", { get() { const n = this; return { contains: (c) => has(n, c), toggle() {}, add() {}, remove() {} }; } });
  Object.defineProperty(El.prototype, "children", { get() { return this.kids.filter((k) => k instanceof El); } });
  const calls = [], any = new Proxy(function () {}, { get: (_, k) => (k === "then" ? undefined : (...a) => { calls.push(String(k)); return null; }), apply: () => new El() });
  const collapsed = [], chev = new El("br-toggle");
  const real = { document: doc, BR: null, brEl: (tag, cls, txt) => new El(cls, txt), t: (k) => "[" + k + "]", window: { blave: any, addEventListener() {} },
    brCollapse: (u) => { collapsed.push(u); real.BR.exp = null; }, brOverlaySig: () => null, sessionId: "s" };
  const scope = new Proxy(real, { has: (_, k) => typeof k === "string" && !(k in globalThis), get: (o, k) => (typeof k !== "string" ? undefined : k in o ? o[k] : any) });
  // 函式表達式才會把 with 的作用域帶進閉包(宣告式在 with 裡會被提到外層)
  const inScope = (name) => new Function("scope", "with (scope) { return (" + fnCut(name).trim() + "); }")(scope);
  real.brFocusBack = inScope("brFocusBack");
  const F = inScope("brPaintOverlay");
  const tabs = new Map([["p1", { id: "p1", url: "https://a.test/", ph: "done" }], ["p2", { id: "p2", url: "https://b.test/", ph: "done" }]]);
  const blockEl = new El("bblk"); blockEl.append(chev);
  const blk = { ids: ["p1", "p2"], el: blockEl };
  const paint = (exp) => { const pane = new El("pane-main"), bw = new El("bw"); pane.append(bw); real.BR = { bw, exp, tabs, blocks: [blk], shown: null, sig: null, wallBlock: null, ro: { disconnect() {}, observe() {} } }; F(); return bw; };
  const MODES = { wall: { mode: "wall", block: blk }, one: { mode: "one", id: "p1", live: true, res: {} }, snap: { mode: "snap", src: { url: "https://a.test/", title: "A", snapshot_id: "S" }, snap: null, block: blk } };
  for (const [name, exp] of Object.entries(MODES)) {
    const bw = paint(exp), head = bw.querySelector(".bw-head"), x = bw.querySelector(".bw-close");
    ok(name + ":標題列有一顆 ✕(.modal-close.bw-close、排在 .txt 後面、aria-label 走 set.close、沒有停用)",
      !!x && bw.querySelectorAll(".bw-close").length === 1 && head.children[0].className === "txt" && head.children[1] === x && has(x, "modal-close") && x.text === "✕" && x.type === "button"
      && x.attrs["aria-label"] === "[set.close]" && !x.disabled && !x.hidden);
    calls.length = 0; collapsed.length = 0; doc.activeElement = x;
    if (x) x.on.click();
    ok(name + ":按 ✕ → brCollapse(true) 一次,不關分頁、不交還、不停回合;焦點回聊天那張卡", collapsed.length === 1 && collapsed[0] === true
      && !calls.some((c) => /browser(Close|UserDone|Handback|Takeover|Reload|Navigate)|stop/i.test(c)) && doc.activeElement === chev, { collapsed, calls });
  }
  { const bw = paint(MODES.one), old = bw.querySelector(".bw-close"); old.focus(); real.BR.sig = null; F();
    const now = bw.querySelector(".bw-close");
    ok("整層重畫時焦點在 ✕ 上 → 放回新的那顆(不是舊節點、不掉到 body)", now !== old && doc.activeElement === now); }
  { const bw = paint(MODES.one); doc.activeElement = null; real.BR.sig = null; F();
    ok("焦點不在 ✕ 上時重畫不搶焦點", doc.activeElement === null); }
}
ok("brCollapse 只收展開層:不叫關分頁、不停回合", !/browserClose|stopTurn|browserUserDone/.test(fnCut("brCollapse")) && /window\.blave\.browserCollapse\(\)/.test(fnCut("brCollapse")));
ok("CSS 照 spec:.bw-close 只有定位(上 -6、右 -8)＋熱區外擴 6;.modal-close 本體不在 browser.css 改寫",
  css.includes(".bw-close { position: relative; margin: calc(var(--space-6) * -1) calc(var(--space-8) * -1) 0 0; }") && css.includes('.bw-close::before { content: ""; position: absolute; inset: -6px; }') && !/\.modal-close/.test(css));

// ---- 2
const escSrc = (src.match(/document\.addEventListener\("keydown", (\(e\) => \{\n  if \(e\.key !== "Escape"[\s\S]*?\n\})\);/) || [])[1];
ok("browser.js 有 Esc 這一段", !!escSrc);
if (escSrc) {
  const run = (exp, ev) => { let n = 0, pd = 0; const BR = { exp }; const h = new Function("BR", "brCollapse", "return " + escSrc)(BR, (u) => { if (u === true) n++; });
    h(Object.assign({ key: "Escape", preventDefault: () => { pd++; }, target: { closest: () => null } }, ev)); return n + ":" + pd; };
  ok("展開中按 Esc → 收回(算用戶動作)", run({ mode: "one", id: "p1" }, {}) === "1:1" && run({ mode: "wall" }, {}) === "1:1");
  ok("沒展開 / 別的框已處理 / 組字中 / 不是 Esc → 不動", [run(null, {}), run({ mode: "wall" }, { defaultPrevented: true }), run({ mode: "wall" }, { isComposing: true }), run({ mode: "wall" }, { keyCode: 229 }), run({ mode: "wall" }, { key: "a" })].every((r) => r === "0:0"));
  ok("網址列編輯中的 Esc 是取消編輯,不收回", run({ mode: "one", id: "p1" }, { target: { closest: (s) => (s === ".bv-addr input" ? {} : null) } }) === "0:0");
}

// ---- 3
{
  function Node() { this.kids = []; this.text = ""; this.style = {}; }
  Node.prototype.append = function (...k) { k.forEach((x) => this.kids.push(x)); };
  const flat = (n) => (typeof n === "string" ? n : n && n.kids ? [n.text, ...n.kids.map(flat)].join("") : "");
  const env = { brEl: (tag, cls, txt) => { const n = new Node(); n.text = txt || ""; n.addEventListener = () => {}; return n; }, brFav: () => new Node(), brIcon: () => new Node(), t: (k) => "[" + k + "]",
    BR: { tabs: new Map([["a", { url: "https://x.test/", ph: "done", readEver: true }]]), exp: { mode: "one", id: "a" } }, brCollapse: () => {}, trackFeature: () => {} };
  const fn = new Function(...Object.keys(env), src.match(/const brIsRead = .*;/)[0] + "\n" + fnCut("brPaintSum") + "; return brPaintSum;")(...Object.values(env));
  const s = new Node(); fn({ sum: s, ids: ["a"], sourceCount: 1 });
  ok("摘要列:這一輪的頁開在中欄時只有「讀了 N 頁」＋chevron,沒有文字鈕", flat(s) === "[br.summaryPre]1[br.summaryPost]", flat(s));
  ok("進行中的卡頭:在中欄時不放文字鈕,不在才放「看網頁」", /if \(!mine && !b\.conv && b\.ids\.length\) \{[^\n]*t\("br\.openPanel"\)/.test(fnCut("brPaintHead")));
  ok("br.closePanel 與 .sum-back 都清掉", !/closePanel/.test(src + strings) && !/sum-back/.test(src + css)
    && ["en", "zh"].every((l) => !/br\.closePanel/.test(fs.readFileSync(path.join(RD, "..", "i18n", l + ".po"), "utf8"))));
}
console.log(red ? "\n" + red + " FAILED" : "\nALL PASS");
process.exit(red ? 1 : 0);
