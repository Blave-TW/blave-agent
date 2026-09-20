// shell/renderer/app.js 的兩塊不 trivial 的邏輯,從原文切出來跑(不需要 electron / DOM):
//   aiParts   agent 回覆 → 顯示片段(行內 markdown、``` 圍欄不動、<blave-card:…/> 標記剝除)
//   planWatch 雲端方案的輪詢:只掛一個 timer、15 分鐘後不再掛、starting→running 只講一次且不插在一輪中間、
//             starting→none 要講失敗
// 跑法:node tests/check_shell_paint.js
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8");
const cut = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); if (a < 0 || b < 0) throw new Error("找不到原文:" + from); return src.slice(a, b); };
let red = 0; const t_ = (name, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) red++; };
const J = (x) => JSON.stringify(x);

// ── aiParts ──
eval(cut("const CARD_TAG", "function paintAi").replace(/^const /gm, "var "));
const kinds = (r) => r.parts.map((p) => Object.keys(p)[0]).join(",");
let r = aiParts("這是 **粗體** 與 `code`。", false);
t_("粗體與行內程式碼各自成段", kinds(r) === "text,strong,text,code,text" && r.parts[1].strong === "粗體" && r.parts[3].code === "code");
r = aiParts("看這段:\n```python\nf(**a, **b)\nx = 2**3**2\n```\n完", false);
t_("``` 圍欄裡的 ** 一個字都不動", r.parts.some((p) => p.text && p.text.includes("f(**a, **b)") && p.text.includes("2**3**2")) && !r.parts.some((p) => p.strong));
r = aiParts("沒收尾的圍欄\n```\na**b**c", true);
t_("串流中還沒收尾的圍欄也不動", !r.parts.some((p) => p.strong) && r.parts.some((p) => p.text && p.text.includes("a**b**c")));
r = aiParts("拿不到資料。\n<blave-card:data-access/>", false);
t_("標記被剝掉、記進 cards、尾端空白收掉", J(r.cards) === J(["data-access"]) && r.parts.map((p) => p.text).join("") === "拿不到資料。");
r = aiParts("拿不到資料。\n<blave-ca", true);
t_("串流中的半截標記先藏起來", r.parts.map((p) => p.text).join("") === "拿不到資料。\n" && r.cards.length === 0);
r = aiParts("結論是 a <", true);
t_("串流中尾端單一個 < 先藏", r.parts.map((p) => p.text).join("") === "結論是 a ");
r = aiParts("結論是 a <", false);
t_("定稿時真的以 < 結尾的回覆不被吃掉", r.parts.map((p) => p.text).join("") === "結論是 a <");
r = aiParts("<b>不是標記</b> 與 <blave 開頭但不是", true);
t_("不是標記的 < 不受影響", r.parts.map((p) => p.text || "").join("").includes("<b>不是標記</b>"));
r = aiParts("<img src=x onerror=alert(1)> **x**", false);
t_("只會產生 text / code / strong 三種片段(HTML 原樣當文字)", r.parts.every((p) => ["text", "code", "strong"].includes(Object.keys(p)[0])) && r.parts[0].text.includes("<img"));
const big = "<blave-card".repeat(20000); const t0 = Date.now(); aiParts(big, true);
t_("大量未閉合標記不會卡住(< 500ms)", Date.now() - t0 < 500);

// ── planWatch ──
var timers = [], now = 1_000_000, said = [], sr = [], painted = 0, checks = 0;
var running = false, acct = null, planErr = null, planSince = 0, planTimer = null, planWas = null, planDoneSaid = false, planDonePending = false;
var PLAN_POLL_MS = 20000, PLAN_SLOW_MS = 15 * 60 * 1000;
const _Date = Date; global.Date = class extends _Date { static now() { return now; } };
global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
var $ = () => ({ hidden: true }), t = (k) => k, srSay = (x) => sr.push(x), sidePaint = () => {}, planPaint = () => { painted++; }, acctCheck = () => { checks++; };
var faultCard = () => ({ set: (s) => said.push(s.text) });
eval(cut("function planWatch(s)", "/* 「設定」右邊那行安靜的字").replace(/^const /gm, "var "));
const P = (state) => ({ plan: { state } });
planWatch(P("starting")); planWatch(P("starting")); planWatch(P("starting"));
t_("啟動中連續呼叫只掛一個 timer、間隔 20 秒", timers.length === 1 && timers[0].ms === 20000);
timers[0].fn(); t_("timer 到了會重查、而且把自己清掉", checks === 1 && planTimer === null);
now += 16 * 60 * 1000; planWatch(P("starting"));
t_("超過 15 分鐘不再掛 timer", timers.length === 1);
running = true; planWatch(P("running"));
t_("一輪進行中:完成的那句延後、不插進去", said.length === 0 && planDonePending === true);
running = false; planSayDone(); planWatch(P("running")); planWatch(P("running"));
t_("開好了只講一次", said.length === 1 && said[0] === "plan.done");
planWas = null; planDoneSaid = false; planWatch(P("running"));
t_("沒親眼看到 starting → running 的不講(本來就在跑的機器)", said.length === 1);
planWatch(P("starting")); planWatch(P("none"));
t_("starting → none = 建機失敗:要講,不能靜悄悄", planErr && planErr.key === "plan.err.server" && sr.includes("plan.err.server"));
global.Date = _Date;
console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
