// 聊天欄答案鈕(shell/renderer/answers.js + app.js／main.js／chattabs.js 的接線;spec chat-answer-buttons-2026-11-16 §1–§6、§9、§10),不開 Electron:
//   1. aiParts／replySnippet:<answers> 區塊與未閉合尾段都剝,串流中的半截先藏
//   2. ansPick:不可信的 chunk 任何一項不合整組丟(2–4 個、每個 ≤32 字、無控制與格式字元、不重複)
//   3. 回合結束畫在這一輪最後一則還在 DOM 的回覆裡;group＋可及名稱、讀屏念一次、全組同重
//   4. 防誤觸、按鈕送出(草稿留著)、送不出去鈕留著、真的送出去才收掉並記、打字送出記 missed、撤回、別的裝置開新回合收掉
//   5. 橫排／直排由量測決定
//   6. 接線、字串、樣式、埋點白名單、手機中轉不轉 answers
// 跑法:node tests/check_shell_answers.js
const fs = require("fs"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const app = read("app.js"), html = read("index.html"), main = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
const ansSrc = fs.existsSync(path.join(R, "answers.js")) ? read("answers.js") : "";
const ansCss = fs.existsSync(path.join(R, "answers.css")) ? read("answers.css") : "";
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("找不到原文:" + a); return src.slice(i, j); };
const J = (x) => JSON.stringify(x);

// ── 1. aiParts ──
const md = read("md.js");
eval((md.slice(0, md.indexOf("const mdEl")) + cut(app, "const CARD_TAG", "function paintAi")).replace(/^const /gm, "var "));
const textOf = (r) => { let o = ""; const walk = (x) => { if (Array.isArray(x)) return x.forEach(walk); if (x && typeof x === "object") { if (typeof x.text === "string") o += x.text; if (typeof x.code === "string") o += x.code; Object.values(x).forEach(walk); } }; walk(r.blocks); return o; };
for (const [name, raw, want] of [
  ["區塊在尾端", "要重跑嗎？\n<answers>\n重跑回測\n先不要\n</answers>\n<await/>", "要重跑嗎？"],
  ["未閉合尾段", "要重跑嗎？\n<answers>\n重跑回測", "要重跑嗎？"],
  ["夾在中間", "前段\n<answers>\n甲\n乙\n</answers>\n後段", "前段後段"],
]) for (const live of [true, false]) { const s = textOf(aiParts(raw, live)); ok("aiParts(" + (live ? "串流" : "定稿") + "):" + name, s === want, s); }
ok("串流中半截 <、<a、<ans、<answers 先藏", ["<", "<a", "<ans", "<answers"].every((h) => textOf(aiParts("要重跑嗎？\n" + h, true)) === "要重跑嗎？"));
ok("談到 answers 這個字不算", textOf(aiParts("answers 一下", false)) === "answers 一下");
ok("回覆摘錄(replySnippet)也剝 answers 區塊", /\.replace\(ANS_BLOCK, " "\)\.replace\(ANS_OPEN_TAIL, ""\)/.test(cut(app, "function replySnippet(", "\n}")));
{ const line = (name) => { const m = app.match(new RegExp("^const " + name + " = .*;$", "m")); if (!m) throw new Error("找不到 " + name); return m[0]; };
  const fnSrc = (name) => { const i = app.indexOf("function " + name + "("); let d = 0; for (let k = app.indexOf("{", app.indexOf(")", i)); k < app.length; k++) { if (app[k] === "{") d++; else if (app[k] === "}" && --d === 0) return app.slice(i, k + 1); } throw new Error(name); };
  const snip = new Function(["CARD_TAG", "SUG_BLOCK", "SUG_OPEN_TAIL", "ANS_BLOCK", "ANS_OPEN_TAIL", "AWAIT_TAG", "FORM_TAG", "RS_MAX"].map(line).concat([fnSrc("replySnippet"), "return replySnippet;"]).join("\n"))();
  ok("回覆摘錄:只剝標記,選項清單不進摘錄(spec §10.6)", snip("要重跑嗎？\n<answers>\n重跑回測\n先不要\n</answers>\n<await/>") === "要重跑嗎？", snip("要重跑嗎？\n<answers>\n重跑回測\n先不要\n</answers>\n<await/>")); }

// ── 2–5. answers.js:假 DOM 跑真的原文 ──
const STR = new Function(read("strings.js") + "\nreturn STRINGS;")();
let focused = null;
const node = (tag) => { const e = { tagName: String(tag).toUpperCase(), children: [], parentNode: null, className: "", dataset: {}, attrs: {}, listeners: {}, _text: "", type: "",
  classList: { add: (c) => { if (!e.classList.contains(c)) e.className = (e.className + " " + c).trim(); }, remove: (c) => { e.className = e.className.split(" ").filter((x) => x && x !== c).join(" "); }, contains: (c) => e.className.split(" ").includes(c) },
  get textContent() { return e._text + e.children.map((c) => c.textContent).join(""); }, set textContent(v) { e._text = String(v); e.children = []; },
  appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = e; e.children.push(c); return c; },
  remove() { if (e.parentNode) { const p = e.parentNode; p.children = p.children.filter((c) => c !== e); e.parentNode = null; } },
  setAttribute(k, v) { e.attrs[k] = String(v); }, addEventListener(k, f) { (e.listeners[k] = e.listeners[k] || []).push(f); }, fire(k) { (e.listeners[k] || []).forEach((f) => f({ type: k, target: e })); },
  focus() { focused = e.id || e; }, clientWidth: 400, get scrollWidth() { return e.children.reduce((w, c) => w + (c.w || 0), 0); } }; return e; };
const ta = node("textarea"); ta.id = "ta";
const ctx = { $: (id) => (id === "ta" ? ta : null), document: { createElement: node }, LANG: "zh", STRINGS: STR, sessionId: "desktop-aaaa1111", turnAiBubbles: [],
  events: [], said: [], trackEvent: (n, p) => ctx.events.push([n, p]), srSay: (s) => ctx.said.push(s), tabBg: () => false,
  now: 10000, performance: { now: () => ctx.now }, motionBaseMs: () => 180, sent: [], sendOk: true, ResizeObserver: undefined,
  submitMessage: (m, o) => { ctx.sent.push([m, o]); return { then: (f) => f(ctx.sendOk) }; } };
ctx.t = (k, v) => { let s = (STR[ctx.LANG] && STR[ctx.LANG][k]) || STR.en[k] || k; if (v) for (const n in v) s = s.split("{" + n + "}").join(v[n]); return s; };
let loaded = false;
try {
  new Function("ctx", "with (ctx) { " + ansSrc.replace(/^let ANS = /m, "var ANS = ") +
    "\n Object.assign(ctx, { ansPick, ansChunk, ansTurnEnd, ansLayout, ansSnap, ansSettle, ansUnsend, ansUndo, getAns: () => ANS }); }")(ctx);
  loaded = typeof ctx.ansPick === "function";
} catch (e) { console.log("      " + e.message); }
ok("renderer/answers.js 載得起來", loaded);
const A = () => (loaded ? ctx.getAns() : {});

for (const [name, items, want] of [
  ["2 個", ["重跑回測", "先不要"], ["重跑回測", "先不要"]], ["4 個", ["甲", "乙", "丙", "丁"], ["甲", "乙", "丙", "丁"]],
  ["32 字(Array.from 計,emoji 一個算一字)", ["甲", "😀".repeat(32)], ["甲", "😀".repeat(32)]],
  ["1 個", ["甲"], null], ["5 個", ["甲", "乙", "丙", "丁", "戊"], null], ["33 字", ["甲", "字".repeat(33)], null],
  ["重複", ["甲", "甲"], null], ["控制字元", ["甲", "乙\n丙"], null], ["格式字元(U+202E 雙向覆寫)", ["甲", "乙\u202e丙"], null], ["格式字元(U+200B)", ["甲", "乙\u200b"], null], ["空白字串", ["甲", "  "], null], ["非字串", ["甲", 2], null], ["不是陣列", "甲乙", null],
]) ok("ansPick:" + name, loaded && J(ctx.ansPick({ items })) === J(want), loaded && ctx.ansPick({ items }));

(() => {
  if (!loaded) return;
  const thread = node("div"), bubble = () => { const b = node("div"); b.className = "msg ai"; thread.appendChild(b); return b; };
  const b1 = bubble(), gone = bubble(); gone.remove(); const b2 = bubble();
  ctx.turnAiBubbles = [b1, b2, gone];
  ctx.ansChunk({ type: "answers", session_id: "desktop-zzzz9999", items: ["甲", "乙"] });
  ok("別條對話的 chunk 不收", A().pending === null);
  ctx.ansChunk({ type: "answers", session_id: "desktop-aaaa1111", items: ["重跑回測", "先不要"] });
  ctx.ansTurnEnd(false);
  ok("回合出錯／被停:不畫、pending 作廢", !A().live && A().pending === null && ctx.events.length === 0);
  ctx.ansChunk({ type: "answers", items: ["重跑回測", "先不要"] }); ctx.ansTurnEnd(true);
  const live = A().live; let btns = live ? live.children : [];
  ok("回合結束:畫在這一輪最後一則還在 DOM 的回覆裡(正文之後)", !!live && live.parentNode === b2 && b2.children[b2.children.length - 1] === live);
  ok("role=group、可及名稱「回答」(掛 data-i18n-aria);每顆是 type=button、字就是答案、全組同一個 class(不設主鈕)",
    live.attrs.role === "group" && live.attrs["aria-label"] === "回答" && live.dataset.i18nAria === "ans.group" && btns.length === 2
    && btns.every((b) => b.tagName === "BUTTON" && b.type === "button" && b.className === "ans-btn") && J(btns.map((b) => b.textContent)) === J(["重跑回測", "先不要"]));
  ok("畫出來記 answer_shown n=2、讀屏念一次「可以按鈕回答：…」(頓號接)、焦點不搶", J(ctx.events) === J([["answer_shown", { n: "2" }]]) && J(ctx.said) === J(["可以按鈕回答：重跑回測；先不要"]) && focused === null);
  ctx.events = []; ctx.said = [];
  ctx.ansChunk({ type: "answers", items: ["重跑回測", "先不要"], default: 1 }); ctx.ansTurnEnd(true);
  const dl = A().live;
  const dBtns = dl.children.filter((n) => n.tagName === "BUTTON"), dMark = dl.children.find((n) => n.tagName === "SPAN");
  ok("default=1:那一顆預選(is-default),其餘不變;讀屏標「（建議）」、選項間用「；」接(選項自己可能有頓號);焦點仍不搶(Wei 11-20、設計稽核 S1)",
    dBtns[0].className === "ans-btn is-default" && dBtns[1].className === "ans-btn" && A().def === 1
    && J(ctx.said) === J(["可以按鈕回答：重跑回測（建議）；先不要"]) && focused === null);
  ok("預選那一顆 aria-describedby 指到組內 .sr-only「建議」;鈕名仍是鈕字;不用 aria-pressed／aria-checked(設計稽核 M2)",
    !!dMark && dMark.className === "sr-only" && dMark.textContent === "建議" && dBtns[0].attrs["aria-describedby"] === dMark.id
    && !dBtns[1].attrs["aria-describedby"] && dBtns[0].textContent === "重跑回測"
    && !dBtns.some((b) => "aria-pressed" in b.attrs || "aria-checked" in b.attrs));
  ctx.ansChunk({ type: "answers", items: ["甲", "乙"], default: 3 }); ctx.ansTurnEnd(true);
  ok("default 超出清單或不是整數:只丟預選,選項照畫、沒有說明節點", A().live.children.every((b) => b.className === "ans-btn") && A().def === 0
    && (ctx.ansChunk({ type: "answers", items: ["甲", "乙"], default: "1" }), ctx.ansTurnEnd(true), A().def === 0));
  ctx.ansChunk({ type: "answers", items: ["重跑回測", "先不要"] }); ctx.ansTurnEnd(true);
  btns = A().live.children; ctx.events = [];
  ctx.now = A().shownAt + 100; btns[1].fire("click");
  ok("畫出來 --motion-base(180ms)內按不算", ctx.sent.length === 0);
  ctx.now = A().shownAt + 200; ta.value = "我的草稿"; ctx.sendOk = false; btns[1].fire("click");
  ok("送不出去:鈕留著、inflight 清掉、不記", !!A().live && A().inflight === null && ctx.events.length === 0 && J(ctx.sent) === J([["先不要", { typed: true }]]));
  ctx.sendOk = true; ctx.sent = []; btns[1].fire("click");
  ok("按鈕:那句原句送出(typed,跟輸入框同一條路)、草稿留著", J(ctx.sent) === J([["先不要", { typed: true }]]) && ta.value === "我的草稿");
  ctx.ansSettle("先不要");
  ok("回合真的送出去:整組立刻拿掉、記 answer_sent pos=2、焦點回輸入框", !A().live && live.parentNode === null && J(ctx.events) === J([["answer_sent", { pos: "2" }]]) && focused === "ta");
  ctx.events = [];
  ctx.ansUndo("先不要", true);
  ok("那輪沒回覆沒收據就被停 → answer_undo n=2(只記一次)", J(ctx.events) === J([["answer_undo", { n: "2" }]]) && (ctx.ansUndo("先不要", true), ctx.events.length === 1));
  const again = (items) => { ctx.ansChunk({ type: "answers", items }); ctx.ansTurnEnd(true); ctx.events = []; ctx.now = A().shownAt + 200; return A().live; };
  again(["甲", "乙", "丙"]); ctx.ansSnap("我自己打的"); ctx.ansSettle("我自己打的");
  ok("畫過、自己打字送出且回合跑起來:收掉、記 answer_missed n=3", !A().live && J(ctx.events) === J([["answer_missed", { n: "3" }]]));
  again(["甲", "乙"]); ctx.ansSnap("我自己打的"); ctx.ansUnsend();
  ok("自己打字但送不出去:鈕留著", !!A().live && ctx.events.length === 0);
  ctx.ansSettle(null);
  ok("別的裝置開了新回合(chattabs started):收掉、不記", !A().live && ctx.events.length === 0);
  again(["甲", "乙"]); ctx.ansSettle("卡片送的那句");
  ok("沒經過 sendDraft／按鈕的入口送出:收掉、不記", !A().live && ctx.events.length === 0);
  // 5. 量測:一列放得下橫排;超過容器整組直排
  const el = again(["甲", "乙"]);
  el.children.forEach((b) => { b.w = 100; }); ctx.ansLayout(el);
  ok("一列放得下:橫排(沒有 is-col)", !el.classList.contains("is-col"));
  el.children.forEach((b) => { b.w = 300; }); ctx.ansLayout(el);
  ok("總寬超過容器:整組直排(is-col)", el.classList.contains("is-col"));
  el.children.forEach((b) => { b.w = 100; }); ctx.ansLayout(el);
  ok("欄寬變回來重量一次:回到橫排", !el.classList.contains("is-col"));
})();

// ── 6. 接線、字串、樣式、埋點 ──
ok("app.js:ANS_BLOCK／ANS_OPEN_TAIL 同 runtime 那兩條(含 default 屬性);LIVE_TAIL_TAGS 加 <answers", app.includes('const ANS_BLOCK = /[ \\t]*<answers(?:\\s+default="\\d")?\\s*>[\\s\\S]*?<\\/answers>[ \\t]*/g;')
  && app.includes("const ANS_OPEN_TAIL = /[ \\t]*<answers\\b(?:(?!<\\/answers>)[\\s\\S])*$/;") && /const LIVE_TAIL_TAGS = \[[^\]]*"<answers"\]/.test(app));
ok("app.js 接線:sendDraft 清空前 ansSnap;unlock 叫 ansUnsend;started／queued 才 ansSettle;chunk 分派 ansChunk;回合結束 ansTurnEnd(!stopped && !faulted);停止撤回 ansUndo",
  /if \(typeof ansSnap === "function"\) ansSnap\(msg\);[^\n]*\n  \$\("ta"\)\.value = "";/.test(app)
  && /const unlock = \(\) => \{[^\n]*if \(typeof ansUnsend === "function"\) ansUnsend\(\); \};/.test(app)
  && /if \(\(r\.started \|\| r\.queued\) && typeof ansSettle === "function"\) ansSettle\(msg\);/.test(app)
  && /\} else if \(c\.type === "answers"\) \{\n    if \(typeof ansChunk === "function"\) ansChunk\(c\);/.test(app)
  && /if \(typeof formTurnEnd === "function"\) formTurnEnd\(!stopped && !faulted\);[^\n]*\n  if \(typeof ansTurnEnd === "function"\) ansTurnEnd\(!stopped && !faulted\);/.test(app)
  && /if \(typeof ansUndo === "function"\) ansUndo\(lastUserText, !turnGotReply && !turnHadTool\);/.test(app));
ok("畫面外開跑的一輪(chattabs started → turnFresh(null))收掉答案鈕;畫面送出的那輪(turnFresh(bubble))不收", /turnFresh\(null\);/.test(read("chattabs.js")) && /if \(!bubble && typeof ansSettle === "function"\) ansSettle\(null\);/.test(cut(app, "function turnFresh(bubble) {", "\n}\n")));
{ const fi = html.indexOf('<script src="form.js">'), ai = html.indexOf('<script src="answers.js">'), ci = html.indexOf('<script src="chattabs.js">');
  ok("index.html:answers.js 在 form.js 之後、chattabs.js 之前;answers.css 有載", fi > 0 && ai > fi && ci > ai && /<link rel="stylesheet" href="answers\.css">/.test(html)); }
ok("main.js:非手機回合帶 --answer-buttons(手機畫不出鈕)", /\.\.\.\(rec\.origin === "mobile" \? \[\] : \["--answer-buttons"\]\),/.test(main));
ok("answers.js:兩個常數(同網頁與 runtime,parity 比原文)、狀態只在記憶體、不讀 running", /^const ANS_MAX_ITEMS = 4;$/m.test(ansSrc) && /^const ANS_MAX_CHARS = 32;$/m.test(ansSrc)
  && !/localStorage|lsSet|chat-results/.test(ansSrc) && !/\brunning\b/.test(ansSrc.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")));
ok("字串:ans.group／ans.say zh／en 照 spec §6", STR.zh["ans.group"] === "回答" && STR.en["ans.group"] === "Answers" && STR.zh["ans.say"] === "可以按鈕回答：{s}" && STR.en["ans.say"] === "Answer with a button: {s}");
{ const css = ansCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const hovers = [...css.matchAll(/:hover/g)].length, inHover = (css.match(/@media \(hover: hover\) \{[^\n]*\}/g) || []).join("").split(":hover").length - 1;
  ok("answers.css:不寫 hex、不另造 keyframes(進場 res-in)、新寫的 :hover 都在 @media (hover: hover)", !!css && !/#[0-9a-fA-F]{3,8}\b/.test(css) && !/@keyframes/.test(css) && /animation: res-in var\(--motion-base\) var\(--ease-standard\) backwards;/.test(css) && hovers === inHover);
  ok("answers.css:外觀高 32、熱區 ::before 上下各 7、1px --border-frame、--radius-sm、底透明、字 13 --ink 400、內距 6 12;欄距 8 列距 12、上距 12",
    /\.ans-btn \{[^}]*min-height: 32px;[^}]*padding: var\(--space-6\) var\(--space-12\); border: 1px solid var\(--border-frame\); border-radius: var\(--radius-sm\);[^}]*background: transparent; color: var\(--ink\);[^}]*font-size: 13px; font-weight: 400; line-height: 1\.4;/.test(css)
    && /\.ans-btn::before \{ content: ""; position: absolute; inset: -7px 0; \}/.test(css) && /column-gap: var\(--space-8\); row-gap: var\(--space-12\);/.test(css) && /margin: var\(--space-12\) 0 0;/.test(css));
  ok("answers.css:直排等寬(fit-content(100%))、字可折行;hover／按下換 --surface-muted、走 --motion-fast", /\.ans\.is-col \{ display: grid; grid-template-columns: fit-content\(100%\);/.test(css) && /\.ans\.is-col \.ans-btn \{ white-space: normal;/.test(css)
    && /\.ans-btn:hover \{ background: var\(--surface-muted\); \}/.test(css) && /\.ans-btn:active \{ background: var\(--surface-muted\); \}/.test(css) && /transition: background-color var\(--motion-fast\) var\(--ease-standard\);/.test(css)); }
{ const { EVENTS, FROM_RENDERER } = require(path.join(SHELL, "telemetry.js"));
  ok("埋點:answer_shown／answer_missed／answer_undo 帶 n、answer_sent 帶 pos,畫面送得了", J(EVENTS.answer_shown) === '{"n":["2","3","4"]}' && J(EVENTS.answer_missed) === '{"n":["2","3","4"]}' && J(EVENTS.answer_undo) === '{"n":["2","3","4"]}'
    && J(EVENTS.answer_sent) === '{"pos":["1","2","3","4"]}' && ["answer_shown", "answer_sent", "answer_missed", "answer_undo"].every((e) => FROM_RENDERER.includes(e))); }
{ const RL = require(path.join(SHELL, "relay.js"));
  ok("手機中轉不轉 answers chunk:relay.js TURN_TYPES 沒有 answers", !RL.TURN_TYPES.includes("answers"), RL.TURN_TYPES); }

console.log(red ? "\n" + red + " FAILED" : "\nALL PASS");
process.exit(red ? 1 : 0);
