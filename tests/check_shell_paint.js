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

// ── aiParts(原文 → { cards, blocks }) ──
eval(cut("const CARD_TAG", "function paintAi").replace(/^const /gm, "var "));
// 整份結構裡的字(依序接起來)與所有節點種類
const walk = (x, f) => { if (Array.isArray(x)) return x.forEach((y) => walk(y, f)); if (x && typeof x === "object") { f(x); Object.values(x).forEach((y) => walk(y, f)); } };
const textOf = (r) => { let o = ""; walk(r.blocks, (n) => { if (typeof n.text === "string") o += n.text; if (typeof n.code === "string") o += n.code; if (n.br) o += "\n"; }); return o; };
const kinds = (r) => { const k = new Set(); walk(r.blocks, (n) => Object.keys(n).forEach((x) => k.add(x))); return k; };
let r = aiParts("這是 **粗體** 與 `code`。", false);
t_("粗體與行內程式碼各自成段", J(r.blocks) === J([{ p: [{ text: "這是 " }, { strong: [{ text: "粗體" }] }, { text: " 與 " }, { code: "code" }, { text: "。" }] }]));
r = aiParts("看這段:\n```python\nf(**a, **b)\nx = 2**3**2\n```\n完", false);
t_("``` 圍欄裡的 ** 一個字都不動", r.blocks[1].code === "f(**a, **b)\nx = 2**3**2" && !kinds(r).has("strong"));
r = aiParts("沒收尾的圍欄\n```\na**b**c", true);
t_("串流中還沒收尾的圍欄也不動", r.blocks[1] && r.blocks[1].code === "a**b**c" && !kinds(r).has("strong"));
r = aiParts("拿不到資料。\n<blave-card:data-access/>", false);
t_("標記被剝掉、記進 cards、尾端空白收掉", J(r.cards) === J(["data-access"]) && textOf(r) === "拿不到資料。");
r = aiParts("拿不到資料。\n<blave-ca", true);
t_("串流中的半截標記先藏起來", textOf(r) === "拿不到資料。" && r.cards.length === 0);
r = aiParts("結論是 a <", true);
t_("串流中尾端單一個 < 先藏", textOf(r) === "結論是 a");
r = aiParts("結論是 a <", false);
t_("定稿時真的以 < 結尾的回覆不被吃掉", textOf(r) === "結論是 a <");
r = aiParts("<b>不是標記</b> 與 <blave 開頭但不是", true);
t_("不是標記的 < 不受影響", textOf(r).includes("<b>不是標記</b>"));
r = aiParts("<img src=x onerror=alert(1)> **x** [y](javascript:alert(1))", false);
t_("HTML 原樣當文字、javascript: 連結只剩字(結構裡沒有 html 這種節點、沒有非 http(s) 的 href)",
  textOf(r).startsWith("<img src=x onerror=alert(1)>") && !kinds(r).has("html") && (() => { let bad = false; walk(r.blocks, (n) => { if (n.a && !/^https?:\/\//.test(n.a)) bad = true; }); return !bad; })());
r = aiParts("| | 這台電腦 | 雲端主機 |\n|---|---|---|\n| 總報酬 | −17.54% | −17.55% |\n| 交易筆數 | 331 | 331 |", false);
t_("GFM 表格:表頭 3 欄(第一格空白)、2 列", r.blocks.length === 1 && r.blocks[0].table && r.blocks[0].table.head.length === 3 &&
  J(r.blocks[0].table.head[0]) === "[]" && r.blocks[0].table.rows.length === 2 && J(r.blocks[0].table.rows[0][1]) === J([{ text: "−17.54%" }]));
r = aiParts("| a | b |\n|---|\n| 1 | 2 |", false);
t_("分隔列欄數對不上就不是表格(GFM)", !kinds(r).has("table"));
r = aiParts("- 一\n  - 一之一\n- 二\n\n1. x\n2. y", false);
t_("巢狀清單:第一項底下有一份子清單;有序清單另成一份", r.blocks.length === 2 && r.blocks[0].list.items.length === 2 &&
  r.blocks[0].list.items[0][1].list.items.length === 1 && r.blocks[1].list.ordered && r.blocks[1].list.items.length === 2);
r = aiParts("### 標題\n範圍 0.1~2.38,~~刪掉~~", false);
t_("### 標題;單一個 ~ 是字、~~ 才是刪除線(同網頁的 del 覆寫)", r.blocks[0].h === 3 && textOf(r).includes("0.1~2.38") && kinds(r).has("del"));
r = aiParts("第一行\n第二行", false);
t_("段落裡的換行畫成 <br>(同網頁 breaks: true)", J(r.blocks) === J([{ p: [{ text: "第一行" }, { br: true }, { text: "第二行" }] }]));
r = aiParts("| a |\n|---|\n| 一<br>二<BR/>三 <b>四</b> |", false);
t_("儲存格裡的 <br> 當換行(agent 在表格裡常用),其他標籤照樣是字", J(r.blocks[0].table.rows[0][0]) === J([{ text: "一" }, { br: true }, { text: "二" }, { br: true }, { text: "三 <b>四</b>" }]));
const big = "<blave-card".repeat(20000); const t0 = Date.now(); aiParts(big, true);
t_("大量未閉合標記不會卡住(< 500ms)", Date.now() - t0 < 500);
const deep = ">".repeat(20000) + " x\n" + "- ".repeat(5000) + "y"; const t1 = Date.now(); let deepOk = true;
try { aiParts(deep, false); } catch (_) { deepOk = false; }
t_("幾萬層的 > 與 - 不會把堆疊撐爆、也不會卡住(< 1s)", deepOk && Date.now() - t1 < 1000);

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
