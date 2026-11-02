// 聊天裡的澄清表單(shell/renderer/form.js + app.js／main.js 的接線;spec agent-clarify-form-2026-10-31 §2),不開 Electron:
//   1. aiParts(歷史與升格都走它):<form …/>、成對、單獨 </form> 都剝;串流中的長半截與短半截都藏
//   2. formPick:不可信的 chunk 只收型錄裡的形狀,任何一項不合整張丟
//   3. formSentence:zh／en 組句(年份跟著商品、other 句尾、EN 小寫與冠詞);另跑網頁那份 web/tests/form_vectors.json
//   4. 分派鏈:type "form" 進 formChunk;不認得的型別不丟錯
//   5. 回合結束畫在這一輪最後一則還在 DOM 的回覆裡(背景分頁也是它自己那條);填入、我自己打、送出結算、送不出去
//   6. 接線、字串、token、樣式、埋點白名單、手機中轉不轉 form
// 跑法:node tests/check_shell_form.js(網頁那棵用 BLAVE_WEB_DIR、api 那棵用 BLAVE_API_DIR 指定)
const fs = require("fs"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const app = read("app.js"), html = read("index.html");
const formSrc = fs.existsSync(path.join(R, "form.js")) ? read("form.js") : "";
const formCss = fs.existsSync(path.join(R, "form.css")) ? read("form.css") : "";
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("找不到原文:" + a); return src.slice(i, j); };

// ── 1. aiParts ──
const md = read("md.js");
eval((md.slice(0, md.indexOf("const mdEl")) + cut(app, "const CARD_TAG", "function paintAi")).replace(/^const /gm, "var "));
const textOf = (r) => { let o = ""; const walk = (x) => { if (Array.isArray(x)) return x.forEach(walk); if (x && typeof x === "object") { if (typeof x.text === "string") o += x.text; if (typeof x.code === "string") o += x.code; Object.values(x).forEach(walk); } }; walk(r.blocks); return o; };
for (const [name, raw, want] of [
  ["標記在尾端", "可以做。先選幾個設定，不確定就照預設。\n<form id=\"txf_backtest\" prod=\"mxf\"/>", "可以做。先選幾個設定，不確定就照預設。"],
  ["標記夾在中間", "前段\n<form id=\"txf_backtest\"/>\n後段", "前段後段"],
  ["成對、中間隔行", "前段\n<form id=\"x\">\n</form>", "前段"],
  ["單獨 </form>", "前段 </form>", "前段"],
  ["跟 <await/>、<suggest>、卡片標記並存", "前段\n<blave-card:data-access/>\n<form id=\"txf_backtest\" tf=\"m5\"/>\n<await/>\n<suggest>\n下一步\n</suggest>", "前段"],
]) {
  for (const live of [true, false]) {
    const s = textOf(aiParts(raw, live));
    ok("aiParts(" + (live ? "串流" : "定稿") + "):" + name + " → 聊天文字沒有 form 標記", !/<\/?form/.test(s) && s === want, s);
  }
}
ok("串流中長半截 <form id=\"txf_backtest\" prod=\"m 先藏(LIVE_TAIL_TAGS 的 40 字前綴藏不住它)", textOf(aiParts("可以做。\n<form id=\"txf_backtest\" prod=\"m", true)) === "可以做。");
ok("串流中短半截 <、<f、<fo、<form 先藏", ["<", "<f", "<fo", "<form"].every((h) => textOf(aiParts("可以做。\n" + h, true)) === "可以做。"));
ok("沒有標記的回覆一字不動(談到 form 這個字、<formula> 不算)", textOf(aiParts("form 一下 <formula>", false)) === "form 一下 <formula>" && textOf(aiParts("回測 <format", true)).endsWith("<format"));
ok("回覆摘錄(replySnippet)也剝 form 標記(同網頁 reply_cue.js)", /\.replace\(AWAIT_TAG, " "\)\.replace\(FORM_TAG, " "\);/.test(app));

// ── 2–5. form.js:假 DOM 跑真的原文 ──
const STR = new Function(read("strings.js") + "\nreturn STRINGS;")();
let focused = null;
const node = (tag) => { const e = { tagName: String(tag).toUpperCase(), children: [], parentNode: null, className: "", dataset: {}, attrs: {}, listeners: {}, _text: "", id: "", type: "", name: "", value: "", checked: false,
  get textContent() { return e._text + e.children.map((c) => c.textContent).join(""); }, set textContent(v) { e._text = String(v); e.children.forEach((c) => { c.parentNode = null; }); e.children = []; },
  appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = e; e.children.push(c); return c; }, append(...cs) { cs.forEach((c) => e.appendChild(c)); },
  remove() { if (e.parentNode) { const p = e.parentNode; p.children = p.children.filter((c) => c !== e); e.parentNode = null; } },
  setAttribute(k, v) { e.attrs[k] = String(v); }, getAttribute(k) { return k in e.attrs ? e.attrs[k] : null },
  addEventListener(k, f) { (e.listeners[k] = e.listeners[k] || []).push(f); }, fire(k, ev) { (e.listeners[k] || []).forEach((f) => f(Object.assign({ type: k, target: e }, ev))); },
  setSelectionRange(a, b) { e.sel = [a, b]; }, focus() { focused = e.id || e; } }; return e; };
const all = (root) => [root].concat(...root.children.map(all));
const ta = node("textarea"); ta.id = "ta";
const ctx = { $: (id) => (id === "ta" ? ta : null), document: { createElement: node }, LANG: "zh", STRINGS: STR, sessionId: "desktop-aaaa1111", turnAiBubbles: [],
  tracked: [], said: [], trackFeature: (n) => ctx.tracked.push(n), srSay: (s) => ctx.said.push(s), autosize: () => {} };
ctx.t = (k, v) => { let s = (STR[ctx.LANG] && STR[ctx.LANG][k]) || STR.en[k] || k; if (v) for (const n in v) s = s.split("{" + n + "}").join(v[n]); return s; };
let loaded = false;
try {
  new Function("ctx", "with (ctx) { " + formSrc.replace(/^let FORM = /m, "var FORM = ") +
    "\n Object.assign(ctx, { formPick, formSentence, formChunk, formTurnEnd, formSnap, formSettle, formUnsend, formRepaint, getForm: () => FORM, setForm: (v) => { FORM = v; } }); }")(ctx);
  loaded = typeof ctx.formPick === "function";
} catch (e) { console.log("      " + e.message); }
ok("renderer/form.js 載得起來(formPick／formSentence／formChunk／formTurnEnd／formSnap／formSettle／formUnsend／formRepaint)", loaded);
const F = () => (loaded ? ctx.getForm() : {});
const J = (x) => JSON.stringify(x);

// 電腦版自己的測資(正規化後的形狀也比);網頁那份 web/tests/form_vectors.json 另外整份跑一次
const Q = (o) => Object.assign({}, o);
const CHUNK = { type: "form", session_id: "desktop-aaaa1111", id: "txf_backtest", questions: [
  { key: "prod", options: ["txf", "mxf", "tmf"], value: "mxf" },
  { key: "tf", options: ["d", "m1", "m5", "m15"], value: "m5", note: "nodata" },
  { key: "per", options: ["all", "y3", "y1"], value: "all", years: { txf: 1998, mxf: 2001, tmf: 2024 } },
  { key: "st", options: ["ma", "ch", "other"], value: "ma" }] };
const withQ = (i, patch) => Object.assign({}, CHUNK, { questions: CHUNK.questions.map((q, j) => (j === i ? Object.assign(Q(q), patch) : q)) });
const CLOUD = Object.assign({}, CHUNK, { questions: [CHUNK.questions[0], { key: "tf", options: ["d", "m1", "m5", "m15"], value: "d" }, Object.assign(Q(CHUNK.questions[2]), { years: { txf: 2011, mxf: 2011, tmf: 2011 } }), CHUNK.questions[3]] });
const VEC = {
  pick: [
    { name: "合法 chunk → 只留型錄欄位(沒有 type／session_id)", chunk: CHUNK, pick: { id: "txf_backtest", questions: CHUNK.questions } },
    { name: "雲端:沒有 note、三個都 2011", chunk: CLOUD, pick: { id: "txf_backtest", questions: CLOUD.questions } },
    { name: "id 不在 FORM_IDS", chunk: Object.assign({}, CHUNK, { id: "crypto_backtest" }), pick: null },
    { name: "0 題", chunk: Object.assign({}, CHUNK, { questions: [] }), pick: null },
    { name: "6 題", chunk: Object.assign({}, CHUNK, { questions: CHUNK.questions.concat(CHUNK.questions.slice(0, 2)) }), pick: null },
    { name: "8 個選項", chunk: withQ(1, { options: ["d", "m1", "m5", "m15", "d", "m1", "m5", "m15"] }), pick: null },
    { name: "value 不在 options", chunk: withQ(0, { value: "btc" }), pick: null },
    { name: "選項查不到字串", chunk: withQ(3, { options: ["ma", "ch", "rsi"], value: "ma" }), pick: null },
    { name: "題目 key 形狀不對", chunk: withQ(0, { key: "Prod" }), pick: null },
    { name: "years 帶字串", chunk: withQ(2, { years: { txf: "1998", mxf: 2001, tmf: 2024 } }), pick: null },
    { name: "years 超出 1900–2100", chunk: withQ(2, { years: { txf: 1899, mxf: 2001, tmf: 2024 } }), pick: null },
    { name: "years 缺某個商品", chunk: withQ(2, { years: { txf: 1998, mxf: 2001 } }), pick: null },
    { name: "note 怪值", chunk: withQ(1, { note: "nodata_x" }), pick: null },
    { name: "questions 不是陣列", chunk: Object.assign({}, CHUNK, { questions: "x" }), pick: null },
    { name: "同一題出現兩次", chunk: Object.assign({}, CHUNK, { questions: CHUNK.questions.concat([CHUNK.questions[0]]) }), pick: null },
  ],
  sentence: [
    { name: "zh 預設", lang: "zh", id: "txf_backtest", values: { prod: "txf", tf: "d", per: "all", st: "ma" }, years: { txf: 1998, mxf: 2001, tmf: 2011 }, text: "幫我做台指期 TXF 日 K 的均線交叉策略回測，用全部可用資料（1998 起）" },
    { name: "zh 換商品年份跟著換", lang: "zh", id: "txf_backtest", values: { prod: "mxf", tf: "m5", per: "all", st: "ch" }, years: { txf: 1998, mxf: 2001, tmf: 2024 }, text: "幫我做台指期 MXF 5 分 K 的通道突破策略回測，用全部可用資料（2001 起）" },
    { name: "zh 沒資料的 TMF 2024", lang: "zh", id: "txf_backtest", values: { prod: "tmf", tf: "d", per: "all", st: "ma" }, years: { txf: 1998, mxf: 2001, tmf: 2024 }, text: "幫我做台指期 TMF 日 K 的均線交叉策略回測，用全部可用資料（2024 起）" },
    { name: "zh 雲端 2011", lang: "zh", id: "txf_backtest", values: { prod: "txf", tf: "d", per: "all", st: "ma" }, years: { txf: 2011, mxf: 2011, tmf: 2011 }, text: "幫我做台指期 TXF 日 K 的均線交叉策略回測，用全部可用資料（2011 起）" },
    { name: "zh 近 3 年", lang: "zh", id: "txf_backtest", values: { prod: "txf", tf: "m15", per: "y3", st: "ma" }, years: { txf: 1998, mxf: 2001, tmf: 2011 }, text: "幫我做台指期 TXF 15 分 K 的均線交叉策略回測，用近 3 年" },
    { name: "zh other 句尾「策略是：」", lang: "zh", id: "txf_backtest", values: { prod: "txf", tf: "d", per: "y1", st: "other" }, years: { txf: 1998, mxf: 2001, tmf: 2011 }, text: "幫我做台指期 TXF 日 K 的策略回測，用近 1 年，策略是：" },
    { name: "en 預設(an MA、Daily 轉小寫)", lang: "en", id: "txf_backtest", values: { prod: "txf", tf: "d", per: "all", st: "ma" }, years: { txf: 1998, mxf: 2001, tmf: 2011 }, text: "Backtest an MA crossover strategy on TAIFEX TXF daily bars, using all available data (from 1998)" },
    { name: "en a channel breakout、1-min 不轉", lang: "en", id: "txf_backtest", values: { prod: "mxf", tf: "m1", per: "all", st: "ch" }, years: { txf: 1998, mxf: 2001, tmf: 2024 }, text: "Backtest a channel breakout strategy on TAIFEX MXF 1-min bars, using all available data (from 2001)" },
    { name: "en 最長組合 97 字元", lang: "en", id: "txf_backtest", values: { prod: "txf", tf: "m15", per: "all", st: "ma" }, years: { txf: 1998, mxf: 2001, tmf: 2011 }, text: "Backtest an MA crossover strategy on TAIFEX TXF 15-min bars, using all available data (from 1998)" },
    { name: "en other", lang: "en", id: "txf_backtest", values: { prod: "tmf", tf: "m5", per: "y3", st: "other" }, years: { txf: 2011, mxf: 2011, tmf: 2011 }, text: "Backtest a strategy on TAIFEX TMF 5-min bars, using last 3 years; the strategy is:" },
  ],
};
const runVec = (V, tag) => {
  for (const v of V.pick) ok(tag + "formPick:" + v.name, loaded && J(ctx.formPick(v.chunk)) === J(v.pick), loaded && ctx.formPick(v.chunk));
  for (const v of V.sentence) { ctx.LANG = v.lang; const s = loaded ? ctx.formSentence({ id: v.id, values: v.values, years: v.years }, v.lang) : null; ok(tag + "formSentence:" + v.name, s === v.text, s); }
  ctx.LANG = "zh";
};
runVec(VEC, "");
ok("en 預設句 96 字元、最長組合 97,都在 FORM_MAX_SENTENCE_CHARS 120 內;zh 預設句 40(Array.from 計,含空白)", Array.from(VEC.sentence[6].text).length === 96 && Array.from(VEC.sentence[8].text).length === 97 && Array.from(VEC.sentence[0].text).length === 40 && /^const FORM_MAX_SENTENCE_CHARS = 120;/m.test(formSrc));
ok("formPick:chunk 不是物件 → null", loaded && ctx.formPick(null) === null && ctx.formPick("x") === null);
{ const vp = path.join(process.env.BLAVE_WEB_DIR || path.join(__dirname, "..", "..", "web"), "tests", "form_vectors.json");
  const V = fs.existsSync(vp) ? JSON.parse(fs.readFileSync(vp, "utf8")) : null;
  // 旁邊沒有 web 樹(CI 只 checkout 這個 repo)才 SKIP;樹在、檔不在照紅
  if (!fs.existsSync(path.dirname(path.dirname(vp)))) console.log("SKIP  網頁 form_vectors.json 比對(需要 BLAVE_WEB_DIR 或 monorepo 版面)");
  else ok("讀得到網頁的 form_vectors.json(設 BLAVE_WEB_DIR)", !!V && Array.isArray(V.pick) && Array.isArray(V.sentence) && V.sentence.some((x) => x.lang === "en"), vp);
  if (V) {   // 網頁那份的形狀:pick 只比收不收(ok),sentence 比 formSentence(state, lang) 的輸出
    for (const v of V.pick) ok("網頁測資 formPick:" + v.name, loaded && (ctx.formPick(v.chunk) !== null) === v.ok, loaded && ctx.formPick(v.chunk));
    for (const v of V.sentence) { ctx.LANG = v.lang; const s = loaded ? ctx.formSentence(v.state, v.lang) : null; ok("網頁測資 formSentence:" + v.name, s === v.out, s); }
    ctx.LANG = "zh";
  } }

// 4. 分派鏈
{ const body = cut(app, "function turnEventIn(c) {", "// turnFaulted:");
  const called = [];
  const stub = { collectDraft: (s) => ({ draft: s.draft, promote: false }), draft: "", draftPromote() {}, draftShow() {}, scrollChat() {}, sessionId: "desktop-aaaa1111",
    formChunk: (c) => called.push(c.type), sugChunk() {}, xpChunk() {} };
  const run = new Function("ctx", "with (ctx) { " + body + "\n return turnEventIn; }")(stub);
  let threw = null; try { run({ type: "form", id: "txf_backtest" }); run({ type: "something_new" }); } catch (e) { threw = e.message; }
  ok("分派:type form 進 formChunk;不認得的型別靜默忽略(鏈尾沒有 else,舊外殼向後相容)", !threw && J(called) === '["form"]', threw || called);
  ok("…form 那條在 suggestions 旁邊", /\} else if \(c\.type === "suggestions"\) \{[^\n]*\n[^\n]*\n  \} else if \(c\.type === "form"\) \{\n    if \(typeof formChunk === "function"\) formChunk\(c\);/.test(app)); }

(() => {
  if (!loaded) { ok("form.js 沒載起來,畫面段跳過", false); return; }
  const thread = (sid) => { const t = node("div"); t.className = "chat-thread"; t.sid = sid; return t; };
  const bubble = (th) => { const b = node("div"); b.className = "msg ai"; th.appendChild(b); return b; };
  const A = thread("desktop-aaaa1111"), b1 = bubble(A), b2 = bubble(A);
  ctx.turnAiBubbles = [b1, b2]; b2.remove(); ctx.turnAiBubbles.push(b2);   // 旁白泡泡被 liveBubble.remove() 之後還留在陣列裡
  const b3 = bubble(A); ctx.turnAiBubbles = [b1, b3, b2];
  ctx.formChunk(Object.assign({}, CHUNK, { session_id: "desktop-zzzz9999" }));
  ok("別條對話的 chunk 不收", F().pending === null);
  ctx.formChunk(CHUNK);
  ok("收到 chunk 先收著,回合還沒結束不畫", !!F().pending && !all(A).some((n) => /\bcform\b/.test(n.className)));
  ctx.formTurnEnd(true);
  const live = F().live;
  ok("回合結束:畫在這一輪最後一則還在 DOM 的回覆裡(正文之後),不是被拿掉的旁白泡泡", !!live && live.parentNode === b3 && b3.children[b3.children.length - 1] === live && F().shown === true && F().pending === null);
  ok("畫出來記 clarify_shown、讀屏念 form.say", J(ctx.tracked) === '["clarify_shown"]' && J(ctx.said) === J([STR.zh["form.say"]]));
  const radios = all(live).filter((n) => n.tagName === "INPUT");
  const fsets = all(live).filter((n) => n.tagName === "FIELDSET");
  ok("四題各一個 fieldset＋legend;radio 是真的 input,名字每張表單各一組", fsets.length === 4 && fsets.every((f) => f.children[0].tagName === "LEGEND") && radios.length === 13 && radios.every((r) => r.type === "radio" && /^cform-\d+-(prod|tf|per|st)$/.test(r.name)));
  ok("預設勾在 chunk 的 value(mxf／m5／all／ma)", J(radios.filter((r) => r.checked).map((r) => r.value)) === '["mxf","m5","all","ma"]');
  const note = all(live).find((n) => /\bcform-note\b/.test(n.className));
  const mins = radios.filter((r) => /^m\d/.test(r.value));
  ok("資料那一句在週期那題底下、三個分 K 的 aria-describedby 指它,字依 note 取", !!note && note.textContent === STR.zh["form.note.nodata"] && mins.length === 3 && mins.every((r) => r.attrs["aria-describedby"] === note.id) && radios.filter((r) => r.value === "d").every((r) => !r.attrs["aria-describedby"]));
  const lab = (v) => radios.find((r) => r.value === v).parentNode.textContent;
  ok("「全部可用資料」帶這個商品的起始年", lab("all") === "全部可用資料（2001 起）");
  const pick = (v) => { radios.filter((r) => r.name === radios.find((x) => x.value === v).name).forEach((r) => { r.checked = r.value === v; }); radios.find((r) => r.value === v).fire("change"); };
  ctx.tracked = [];
  pick("tmf");
  ok("換商品:年份跟著換;改選項什麼都不送、不記", lab("all") === "全部可用資料（2024 起）" && ctx.tracked.length === 0 && ta.value === "");
  const btn = (cls) => all(live).find((n) => n.tagName === "BUTTON" && new RegExp("\\b" + cls + "\\b").test(n.className));
  ok("動作列:.btn-fill「用這些設定」＋.btn-quiet「我自己打」", !!btn("btn-fill") && btn("btn-fill").textContent === "用這些設定" && !!btn("btn-quiet") && btn("btn-quiet").textContent === "我自己打");
  pick("mxf");
  btn("btn-fill").fire("click"); focused = null; btn("btn-fill").fire("click");
  const want = "幫我做台指期 MXF 5 分 K 的均線交叉策略回測，用全部可用資料（2001 起）";
  ok("主鈕:組句填進輸入框、焦點進輸入框、游標句尾、記 clarify_filled、不送", ta.value === want && focused === "ta" && J(ta.sel) === J([want.length, want.length]) && F().filled === want && ctx.tracked[0] === "clarify_filled" && !!F().live);
  ctx.tracked = [];
  btn("btn-quiet").fire("click");
  ok("我自己打:輸入框裡是組出的句子就清掉、焦點回輸入框、記 clarify_self", ta.value === "" && focused === "ta" && F().filled === null && J(ctx.tracked) === '["clarify_self"]');
  ta.value = "我自己的字"; btn("btn-quiet").fire("click");
  ok("…輸入框是用戶自己打的字就不動", ta.value === "我自己的字");
  // 送出:sendDraft 清空輸入框前 formSnap、回合 started／queued 才 formSettle;送不出去 formUnsend
  const send = (msg, started) => { ctx.formSnap(msg); ta.value = ""; if (started) ctx.formSettle(msg); else ctx.formUnsend(); };
  ctx.tracked = []; btn("btn-fill").fire("click"); ctx.tracked = [];
  send(want, false);
  ok("送不出去(busy／引擎起不來):表單 DOM 還在、filled 還原、不記", !!F().live && F().live.parentNode === b3 && F().filled === want && ctx.tracked.length === 0);
  send(want, true);
  ok("填入原句送出、回合跑起來:表單整張收掉、記 clarify_sent", !F().live && !all(A).some((n) => /\bcform\b/.test(n.className)) && F().shown === false && F().filled === null && J(ctx.tracked) === '["clarify_sent"]');
  const again = () => { ctx.formChunk(CHUNK); ctx.formTurnEnd(true); ctx.tracked = []; return F().live; };
  let el = again(); all(el).find((n) => /\bbtn-fill\b/.test(n.className)).fire("click"); ctx.tracked = [];
  send(ta.value + "，加停損", true);
  ok("填入後改字送出 → clarify_sent_ed", !F().live && J(ctx.tracked) === '["clarify_sent_ed"]');
  again(); send("我自己想做 RSI", true);
  ok("畫過、沒填、自己打字送出 → clarify_missed,表單也收掉", !F().live && J(ctx.tracked) === '["clarify_missed"]');
  again(); ctx.formSettle("卡片送的那句");
  ok("沒經過 sendDraft 的入口(重送、卡片)送出:表單收掉、不記", !F().live && ctx.tracked.length === 0);
  ctx.formChunk(CHUNK); ctx.formTurnEnd(false);
  ok("回合出錯／被停:不畫、pending 作廢", !F().live && F().pending === null && ctx.tracked.length === 0);
  ctx.formChunk(withQ(0, { value: "btc" })); ctx.formTurnEnd(true);
  ok("chunk 不合:不畫半張", !F().live && ctx.tracked.length === 0);
  const C = thread("desktop-cccc3333"); ctx.turnAiBubbles = [];
  ctx.formChunk(CHUNK); ctx.formTurnEnd(true);
  ok("這一輪沒有回覆泡泡:不畫", !F().live && all(C).length === 1);
  // 背景分頁:回合結束時 turnAiBubbles 是那條自己的(TAB_KEYS 換進來),畫在它的 .chat-thread 裡,眼前那條不多東西
  const B = thread("desktop-bbbb2222"), bb = bubble(B);
  const saved = F(); ctx.setForm({ pending: null, live: null, filled: null, shown: false, inflight: null });
  ctx.sessionId = "desktop-bbbb2222"; ctx.turnAiBubbles = [bb];
  ctx.formChunk(Object.assign({}, CHUNK, { session_id: "desktop-bbbb2222" })); ctx.formTurnEnd(true);
  const bgLive = F().live; ctx.setForm(saved); ctx.sessionId = "desktop-aaaa1111";
  ok("背景分頁收到 form chunk:畫在它自己那條的泡泡裡,眼前那條(A)沒多東西", !!bgLive && bgLive.parentNode === bb && !all(A).some((n) => /\bcform\b/.test(n.className)));
  // 語言切換:靜態字有 data-i18n,帶年份那一格由 formRepaint 重畫
  ctx.LANG = "en"; ctx.document.querySelectorAll = (sel) => (sel === ".cform" ? [bgLive] : []);
  ctx.formRepaint();
  const allLab = all(bgLive).filter((n) => n.tagName === "INPUT" && n.value === "all")[0].parentNode.textContent;
  ok("換語言:帶年份的「全部可用資料」由 formRepaint 重畫;其他字掛 data-i18n", allLab === "All available data (from 2001)" && all(bgLive).filter((n) => n.tagName === "LEGEND").every((n) => /^form\.txf_backtest\.q\./.test(n.dataset.i18n)));
  ctx.LANG = "zh";
})();

// ── 6. 接線、字串、token、樣式 ──
ok("app.js:FORM_TAG 同 runtime _FORM_STRIP_RE 的 </?;FORM_OPEN_TAIL 藏長半截;LIVE_TAIL_TAGS 加 <form", app.includes('const FORM_TAG = /[ \\t]*<\\/?form\\b[^<>]*>[ \\t]*/g;') && app.includes("const FORM_OPEN_TAIL = /[ \\t]*<form\\b[^<>]*$/;") && /const LIVE_TAIL_TAGS = \[[^\]]*"<form"\]/.test(app)
  && /if \(text\.indexOf\("<form"\) >= 0 \|\| text\.indexOf\("<\/form"\) >= 0\) text = text\.replace\(FORM_TAG, ""\)\.replace\(\/\\s\+\$\/, ""\);/.test(app) && /if \(live\) \{\n    text = text\.replace\(FORM_OPEN_TAIL, ""\);/.test(app));
ok("app.js 接線:sendDraft 清空前 formSnap;沒送出去的 unlock 叫 formUnsend;started／queued 才 formSettle;回合結束 formTurnEnd(!stopped && !faulted);換語言 applyStatic 叫 formRepaint",
  /if \(typeof sugSnap === "function"\) sugSnap\(msg\); if \(typeof formSnap === "function"\) formSnap\(msg\);[^\n]*\n  \$\("ta"\)\.value = "";/.test(app)
  && /const unlock = \(\) => \{ if \(typeof sugUnsend === "function"\) sugUnsend\(\); running = false; turnStopping = false; turnUiSync\(\); if \(typeof formUnsend === "function"\) formUnsend\(\); \};/.test(app)
  && /if \(\(r\.started \|\| r\.queued\) && typeof formSettle === "function"\) formSettle\(msg\);/.test(app)
  && /if \(typeof sugTurnEnd === "function"\) sugTurnEnd\(!stopped && !faulted\);[^\n]*\n  if \(typeof formTurnEnd === "function"\) formTurnEnd\(!stopped && !faulted\);/.test(app)
  && /if \(typeof formRepaint === "function"\) formRepaint\(\);/.test(cut(app, "function applyStatic(", "\n}\n")));
{ const si = html.indexOf('<script src="suggest.js">'), fi = html.indexOf('<script src="form.js">'), ci = html.indexOf('<script src="chattabs.js">');
  ok("index.html:form.js 在 suggest.js 之後、chattabs.js 之前;form.css 有載", si > 0 && fi > si && ci > fi && /<link rel="stylesheet" href="form\.css">/.test(html)); }
ok("form.js:四個常數(同網頁,parity 比原文)、狀態只在記憶體", /^const FORM_IDS = \["txf_backtest"\];$/m.test(formSrc) && /^const FORM_MAX_QUESTIONS = 5;$/m.test(formSrc) && /^const FORM_MAX_OPTIONS = 7;$/m.test(formSrc)
  && /^let FORM = \{ pending: null, live: null, filled: null, shown: false, inflight: null \};$/m.test(formSrc) && !/localStorage|lsSet|saveSession|chat-results/.test(formSrc));
ok("form.js 不讀「有沒有回合」(回合結束在 turnEndPost 裡同步跑,已在那個分頁的 withTab 裡)、不用 $(\"chat-scroll\")", !!formSrc && !/\brunning\b|busyOn\(|csAnyTurn\(|chat-scroll/.test(formSrc.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")));
{ const po = (lang) => { const s = fs.readFileSync(path.join(SHELL, "i18n", lang + ".po"), "utf8"), o = {}; for (const m of s.matchAll(/^msgid "([^"]+)"\nmsgstr "((?:[^"\\]|\\.)*)"/gm)) o[m[1]] = m[2]; return o; };
  const zh = po("zh"), en = po("en");
  const WANT = {
    "form.txf_backtest.q.prod": ["交易商品", "Contract"], "form.txf_backtest.q.tf": ["K 線週期", "Bar interval"], "form.txf_backtest.q.per": ["回測期間", "Backtest period"], "form.txf_backtest.q.st": ["策略類型", "Strategy type"],
    "form.txf_backtest.prod.txf": ["大台 TXF", "TXF (full)"], "form.txf_backtest.prod.mxf": ["小台 MXF", "MXF (mini)"], "form.txf_backtest.prod.tmf": ["微台 TMF", "TMF (micro)"],
    "form.txf_backtest.tf.d": ["日 K", "Daily"], "form.txf_backtest.tf.m1": ["1 分 K", "1-min"], "form.txf_backtest.tf.m5": ["5 分 K", "5-min"], "form.txf_backtest.tf.m15": ["15 分 K", "15-min"],
    "form.txf_backtest.per.all": ["全部可用資料（{year} 起）", "All available data (from {year})"], "form.txf_backtest.per.y3": ["近 3 年", "Last 3 years"], "form.txf_backtest.per.y1": ["近 1 年", "Past year"],
    "form.txf_backtest.st.ma": ["均線交叉", "MA crossover"], "form.txf_backtest.st.ch": ["通道突破", "Channel breakout"], "form.txf_backtest.st.other": ["其他，自己描述", "Other, I'll describe"],
    "form.note.nodata": ["分 K 要 Blave 資料，這個帳號目前拿不到", "Intraday bars need Blave data; this account can't get it right now"], "form.note.nodata_signed_out": ["分 K 要 Blave 資料，要先登入", "Intraday bars need Blave data; sign in to Blave first"],
    "form.use": ["用這些設定", "Use these settings"], "form.self": ["我自己打", "I'll type it"], "form.say": ["有幾個設定要選，表單在回覆下面", "A few settings to pick; the form is under the reply"],
    "form.txf_backtest.sentence": ["幫我做台指期 {code} {tf} 的{st}策略回測，用{per}", "Backtest {st} strategy on TAIFEX {code} {tf} bars, using {per}"],
    "form.txf_backtest.sentence_other": ["幫我做台指期 {code} {tf} 的策略回測，用{per}，策略是：", "Backtest a strategy on TAIFEX {code} {tf} bars, using {per}; the strategy is:"],
  };
  const bad = Object.keys(WANT).filter((k) => zh[k] !== WANT[k][0] || en[k] !== WANT[k][1]);
  const extra = Object.keys(zh).concat(Object.keys(en)).filter((k) => k.startsWith("form.") && !(k in WANT));
  ok("24 條 form.* 字串 zh／en 照 spec §6 逐字(.po),沒有 spec 以外的(不另設 .sent 變體)", Object.keys(WANT).length === 24 && bad.length === 0 && extra.length === 0, bad.map((k) => k + ": " + zh[k] + " / " + en[k]).concat(extra));
  ok("strings.js 也有(po2js 重跑過)", Object.keys(WANT).every((k) => STR.zh[k] === WANT[k][0] && STR.en[k] === WANT[k][1])); }
{ const tok = read("tokens.css"), root = tok.slice(0, tok.indexOf('[data-theme="dark"] {')), dark = tok.slice(tok.indexOf('[data-theme="dark"] {'));
  ok("tokens.css light:卡殼 bg-body 無框;radio off 欄位底＋greyLight 框、on 填 control-fill＋白點", /--cf-bg: var\(--bg-body\); --cf-border: transparent;/.test(root) && /--check-bg: var\(--surface-field\);/.test(root) && /--check-border: var\(--color-greyLight\);/.test(root)
    && /--check-on-bg: var\(--control-fill\);/.test(root) && root.includes("--check-on-radio: url(\"data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='-4 -4 8 8'%3e%3ccircle r='2' fill='%23ffffff'/%3e%3c/svg%3e\");"));
  ok("tokens.css dark:卡殼 outlined(Wei 拍 A);checkbox／radio off 框 greyMedium(Wei 拍 B),off 底透明、點是 darkBody", /--cf-bg: transparent; --cf-border: var\(--border-frame\);/.test(dark) && /--check-bg: transparent;/.test(dark) && /--check-border: var\(--color-greyMedium\);/.test(dark) && !/--check-border: var\(--color-greyDark\)/.test(tok)
    && /--check-on-bg: var\(--control-fill\);/.test(dark) && dark.includes("--check-on-radio: url(\"data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='-4 -4 8 8'%3e%3ccircle r='2' fill='%230f161a'/%3e%3c/svg%3e\");")); }
{ const css = formCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const hovers = [...css.matchAll(/:hover/g)].length, inHover = (css.match(/@media \(hover: hover\) \{[\s\S]*?\n\}/g) || []).join("").split(":hover").length - 1;
  ok("form.css:不寫 hex、不另造 keyframes(進場用 results.css 的 res-in);class 用 cform-(確認框已經用掉 .cf-opt)", !!css && !/#[0-9a-fA-F]{3,8}\b/.test(css) && !/@keyframes/.test(css) && /animation: res-in var\(--motion-base\) var\(--ease-standard\) backwards;/.test(css) && !/\.cf-|\.cf\b/.test(css));
  ok("form.css:殼(內距 12−1、md 角、--cf-bg／--cf-border)、選項橫排 flex-wrap 欄距 16 每列 44、radio 18 走 --check-*", /\.msg\.ai \.cform \{[^}]*padding: calc\(var\(--space-12\) - 1px\);[^}]*border-radius: var\(--radius-md\);[^}]*background: var\(--cf-bg\);[^}]*border: 1px solid var\(--cf-border\);/.test(css)
    && /\.cform-opts \{[^}]*flex-wrap: wrap;[^}]*column-gap: var\(--space-16\);/.test(css) && /\.cform-opt \{[^}]*min-height: 44px;/.test(css) && /\.cform-opt input \{[^}]*width: 18px; height: 18px;[^}]*border-radius: var\(--radius-pill\);[^}]*var\(--check-bg\)[^}]*border: 1px solid var\(--check-border\);/.test(css)
    && /\.cform-opt input:checked \{[^}]*background-color: var\(--check-on-bg\);[^}]*border-color: var\(--check-on-bg\);[^}]*background-image: var\(--check-on-radio\);/.test(css) && /\.cform-opt input:focus-visible \{ outline: 2px solid var\(--focus-ring\); outline-offset: 2px; \}/.test(css));
  ok("form.css:題與題之間 24(設計稽核:組內列距約 26,組間要比它大)", /\.cform fieldset \+ fieldset \{ margin-top: var\(--space-24\); \}/.test(css));
  ok("form.css:「我自己打」熱區照 .busy-fix 補到 44(全域 .btn-quiet::before 只有 -6／-4)", /\.cform-self::before \{ inset: auto; left: 50%; top: 50%; width: max\(44px, calc\(100% \+ 8px\)\); height: 44px; transform: translate\(-50%, -50%\); \}/.test(css));
  ok("form.css:新寫的 :hover 都包在 @media (hover: hover)", !!css && hovers === inHover, { hovers, inHover }); }
// 全 app 的 checkbox／radio(appearance: none 的 18px 控件)off 框都讀 --check-border:dark 值換 greyMedium(Wei 拍 B)一處改全站。列舉,多一顆沒跟就紅
{ const hits = [];
  for (const f of fs.readdirSync(R).filter((n) => n.endsWith(".css")).sort()) {
    const css = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) if (/appearance: none/.test(m[2]) && /width: 18px; height: 18px/.test(m[2])) hits.push({ f, sel: m[1].trim(), ok: /border: 1px solid var\(--check-border\)/.test(m[2]) });
  }
  ok("checkbox／radio off 框都讀 --check-border(" + hits.map((h) => h.sel).join("、") + ")", hits.length >= 4 && hits.every((h) => h.ok) && ["cform-opt input", "cf-opt input", "shr-rad input", "ps-cb"].every((x) => hits.some((h) => h.sel.endsWith(x))), hits.filter((h) => !h.ok)); }
// 手機中轉:api relay.py 的 TURN_TYPES 沒有 form,外殼送給手機時跳過(relay.js 的 TURN_TYPES 同一份)
{ const RL = require(path.join(SHELL, "relay.js"));
  const apiPy = path.join(process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), "openclaw", "relay.py");
  const m = fs.existsSync(apiPy) && /^TURN_TYPES = \(([^)]*)\)/m.exec(fs.readFileSync(apiPy, "utf8"));
  const apiT = m ? [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]) : null;
  ok("手機中轉不轉 form chunk:relay.js TURN_TYPES 沒有 form", !RL.TURN_TYPES.includes("form"), RL.TURN_TYPES);
  // 旁邊沒有 api 樹(CI)才 SKIP;樹在、常數讀不到照紅
  if (!fs.existsSync(path.dirname(path.dirname(apiPy)))) console.log("SKIP  relay.js TURN_TYPES 與 api relay.py 比對(需要 BLAVE_API_DIR 或 monorepo 版面)");
  else ok("relay.js TURN_TYPES 與 api relay.py 同一份(設 BLAVE_API_DIR)", !!apiT && J(apiT) === J(RL.TURN_TYPES), { shell: RL.TURN_TYPES, api: apiT }); }

console.log(red ? `\n${red} 紅` : "\nALL PASS");
process.exit(red ? 1 : 0);
