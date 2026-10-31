// 回合狀態列展開後只有一層(spec-turn-phases-one-layer,0.1.26;designer 0126/turn-phases):
//   1. 一個階段就畫、沒有逐步清單;可展開 = 至少一個階段或有思考文字
//   2. 當下動作:巢在進行中那一列 <li> 裡的 <ul class=think-sub aria-hidden>;字至少停 1.2s、只留最新一個待換;
//      換階段那一刻同一個節點搬進新的最後一列、直接換字;回合結束收掉
//   3. 出錯／中斷:那一階段底下最後 3 步(只取那一階段)、最後一步 is-last、有出錯步驟記號才紅;出錯攤開、停止收著;分不出階段直接當清單
//   4. 回放:預設攤開;被截過(「…另有 N 步」)只畫階段;沒東西可攤就不給 ⌄
//   5. 受詞截頭保尾(fitStepObj);role=status 只包 head;CSS 沒有內捲
// 純 node:切 app.js 原文跑在假 DOM、假時鐘上(不起 Electron)。跑法:node tests/check_shell_turn_phases.js
const TABS_STUB = require("./_tabs_stub").SRC;
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "app.js"), "utf8"), css = fs.readFileSync(path.join(R, "app.css"), "utf8");
const strings = fs.readFileSync(path.join(R, "strings.js"), "utf8");
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
  before(c) { this.parentNode.insertBefore(c, this); }
  get nextSibling() { const p = this.parentNode; return p ? p.children[p.children.indexOf(this) + 1] || null : null; }
  remove() { if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
  matches() { return false; } focus() {}
  addEventListener(t, f) { (this._on[t] = this._on[t] || []).push(f); }
  click() { (this._on.click || []).forEach((f) => f({ type: "click" })); }
  _all(out) { this.children.forEach((c) => { out.push(c); c._all(out); }); return out; }
  querySelectorAll(sel) { const want = sel.split(".").filter(Boolean); return this._all([]).filter((e) => want.every((c) => e._cls.has(c))); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
const env = { now: 0, timers: [], seq: 0 };
const scroll = new El("div");
const ctx = {
  document: { createElement: (t) => new El(t) }, $: (id) => (id === "chat-scroll" ? scroll : new El("div")),
  t: (k, v) => (k === "step.fail" ? "FAIL:" + v.did : k),
  STRINGS: { en: new Proxy({}, { get: (_, k) => (typeof k === "string" && /^(act|step)\./.test(k) ? k : undefined) }) },
  Date: { now: () => env.now },
  setInterval: () => 1, clearInterval: () => {},
  setTimeout: (f, ms) => { const id = ++env.seq; env.timers.push({ id, at: env.now + ms, f }); return id; },
  clearTimeout: (id) => { env.timers = env.timers.filter((x) => x.id !== id); },
  requestAnimationFrame: () => {}, getComputedStyle: () => ({ getPropertyValue: () => "180ms" }), window: {},
  scrollChat: () => {}, TICK_WINDOW: 24, TICK_PITCH: 4, brNeedsUser: () => false, brHost: () => "", brReg: (h) => h,
  whereTag: (env) => { const s = new El("span"); s.className = "wtag " + env; return s; },
  stepWhere: (c) => (c && String(c.tool || "").indexOf("mcp__blave__") === 0 ? "cloud" : "local"),
};
const body = cut("let busy = null;", "/* 停止(照雲端工作頁") + cut("function receiptFold(", "/* 舊回合的使用者那句");
const M = new Function(...Object.keys(ctx), TABS_STUB + body + "; return { busyStart, busyStep, busyStepDone, busyReason, busyEnd, receiptFold, faultTail, fitStepObj, phaseIdxOf, ACT_HOLD_MS, get busy() { return busy; } };")(...Object.values(ctx));
const at = (ms) => { env.now = ms; const due = env.timers.filter((x) => x.at <= ms); env.timers = env.timers.filter((x) => x.at > ms); due.forEach((x) => x.f()); };
const subs = (el) => el.querySelectorAll(".think-sub");
const rowText = (li) => [li.querySelector(".think-step-verb").textContent, (li.querySelector(".think-step-obj") || { textContent: "" }).textContent];
const step = (id, kind, summary, tool) => M.busyStep({ id, kind, summary, tool: tool || "Bash" });

// ── 純函式 ──
{ const T = M.faultTail, P = (phase, error) => ({ phase, error: !!error });
  const a = T([P(0), P(1), P(1), P(1), P(1, true)], 2);
  ok("faultTail:出錯那一階段的最後 3 步(5 步裡取後 3)、err=true", a.row === 1 && JSON.stringify(a.idx) === "[2,3,4]" && a.err, a);
  const b = T([P(0), P(0), P(1), P(1, true)], 2);
  ok("faultTail:只取那一階段裡的步驟,不跨回上一階段(1–3 列)", b.row === 1 && JSON.stringify(b.idx) === "[2,3]", b);
  const c = T([P(0), P(0, true), P(1), P(1)], 2);
  ok("faultTail:出錯在前一階段 → 掛那一階段(含最後一個 error 的那一階段),不是最後一階段", c.row === 0 && JSON.stringify(c.idx) === "[0,1]" && c.err, c);
  const d = T([P(0), P(1), P(1)], 2);
  ok("faultTail:沒有出錯的步驟(中斷)→ 掛最後一階段、err=false(記號不紅)", d.row === 1 && JSON.stringify(d.idx) === "[1,2]" && !d.err, d);
  const e = T([P(-1), P(-1), P(-1), P(-1)], 0);
  ok("faultTail:分不出階段 → row -1、最後 3 步", e.row === -1 && JSON.stringify(e.idx) === "[1,2,3]", e);
  const f = T([P(-1, true), P(0)], 1);
  ok("faultTail:第一個階段開之前的讀取步算進第一階段", f.row === 0 && JSON.stringify(f.idx) === "[0,1]" && f.err, f);
  ok("faultTail:沒有步驟 → 空", T([], 0).idx.length === 0);
  ok("phaseIdxOf:讀取類不開列、同一種併列、換一種開新列", JSON.stringify(M.phaseIdxOf(["file_read", "data", "file_read", "data", "backtest", "docs", "data"])) === "[-1,0,0,0,1,1,2]"); }
{ const o = (full) => ({ dataset: { full }, textContent: "" });
  const x = o("strategies/tw_four_factor_basket_top5/strategy.py"); M.fitStepObj(x, 20 * 7, 7);
  const y = o("strategy.py"); M.fitStepObj(y, 20 * 7, 7);
  const z = o("strategies/tw_four_factor_basket_top5/strategy.py"); M.fitStepObj(z, 0, 7);
  const w = o("abcdefghijklmnopqrstuvwxyz0123456789"); M.fitStepObj(w, 10 * 7, 7);
  ok("fitStepObj:截頭保尾、從斜線起截(…/strategy.py);放得下照全文;量不到寬度放全文;沒有斜線就直接截頭", x.textContent === "…/strategy.py" && y.textContent === "strategy.py" && z.textContent === z.dataset.full && w.textContent === "…123456789", [x.textContent, w.textContent]); }

// 字寬只從 mono 受詞量(稽核 2026-10-16 必修 1):搜尋字(12px 無襯線)排在前面時,以前字寬記成 6.0、實際 mono 11 是 6.6,截過頭再被 CSS 補第二個「…」
{ const fitSrc = cut("let stepCharW = 0;", "// 聊天欄寬度會變");
  const W = { "11px mono": 6.6, "12px sans": 6.0 };
  const mk = (cls, w, full) => { const e = new El("span"); e.className = cls; e.w = w; if (full != null) { e.dataset.full = full; e.textContent = full; } e.getBoundingClientRect = () => ({ width: e.w }); return e; };
  const doc = { createElement: (t) => (t === "canvas" ? { getContext: () => ({ font: "", measureText(s) { return { width: s.length * W[this.font] }; } }) } : new El(t)) };
  const gcs = (el) => (el._cls && el._cls.has("think-step-obj") ? (el._cls.has("mono") ? { fontSize: "11px", fontFamily: "mono" } : { fontSize: "12px", fontFamily: "sans" }) : { columnGap: "8px" });
  const F = new Function("document", "getComputedStyle", "$", fitSrc + "; return { fitSteps };")(doc, gcs, () => null);
  const root = new El("div");
  const row = (objCls, full) => { const li = new El("li"); li.clientWidth = 300; li.append(mk("think-step-verb", 40), mk(objCls, 0, full), mk("think-step-time", 30)); root.appendChild(li); return li.children[1]; };
  const q = "BTC funding rate history across major exchanges since 2020";
  const search = row("think-step-obj", q);
  const path1 = row("think-step-obj mono", "lib/runner.py --scan --param fast_window=10,20,30 slow_window=50,100,200");
  F.fitSteps(root);
  const avail = 300 - 40 - 30 - 8 * 2, fits = path1.textContent.length * 6.6 <= avail;
  ok("搜尋字排在前面:mono 受詞照 mono 11 的字寬截,截完放得下(不會再被 CSS 補第二個「…」)", path1.textContent.startsWith("…") && fits, [path1.textContent, path1.textContent.length * 6.6, avail]);
  ok("搜尋字(非 mono)不走截頭保尾:照全文,交給 CSS 從尾巴截", search.textContent === q); }

// ── 即時:一個階段就畫、當下動作 ──
env.now = 0; M.busyStart(); let b = M.busy;
step("r0", "file_read", "lib/data.py", "Read");
ok("開頭只有讀取步:沒有階段 → 清單藏著、沒有 ⌄、當下動作沒地方掛", b.phasesEl.hidden && !b.head.classList.contains("has-reason") && !subs(b.el).length);
env.now = 100; step("a", "data", "fetch BTCUSDT");
const sub = b.sub, li0 = b.phasesEl.children[0];
ok("一個階段就畫(原本要兩個);⌄ 點得出東西;沒有逐步清單節點", !b.phasesEl.hidden && b.phasesEl.children.length === 1 && b.head.classList.contains("has-reason") && !b.el.querySelector(".think-steps") && !b.el.querySelector(".think-step"));
ok("當下動作巢在進行中那一列 <li> 裡(不是清單的兄弟 li)、aria-hidden、進行式動詞(act.*,不是完成式 step.*)＋受詞", !!sub && sub.parentNode === li0 && sub.parentNode.parentNode === b.phasesEl && sub.getAttribute("aria-hidden") === "true"
  && JSON.stringify(rowText(sub.children[0])) === JSON.stringify(["act.data", "fetch BTCUSDT"]) && sub.children.length === 1, sub && rowText(sub.children[0]));
ok("當下動作不畫記號、不畫時長", !sub.querySelector(".think-step-mark") && !sub.querySelector(".think-step-time"));
env.now = 600; step("b", "strategy_read", "strategies/x/strategy.py", "Read");
env.now = 900; step("c", "file_read", "strategies/x/params.json", "Read");
ok("1.2s 內來的兩步:字不換(還停在第一步)", rowText(sub.children[0])[1] === "fetch BTCUSDT");
at(1299);
ok("…還沒滿 1.2s:照舊", rowText(sub.children[0])[1] === "fetch BTCUSDT");
at(1300);
ok("滿 1.2s:直接換成最新的那一步(中間那步不出現)", rowText(sub.children[0])[1] === "strategies/x/params.json" && rowText(sub.children[0])[0] === "act.file_read");
M.busyStepDone({ id: "c", ms: 20 });
at(5000);
ok("兩個工具之間(上一步做完了、下一步還沒來)留著上一步,不清空", rowText(sub.children[0])[1] === "strategies/x/params.json" && sub.parentNode === li0);
env.now = 5100; step("d", "backtest", "lib/runner.py");
const li1 = b.phasesEl.children[1];
ok("換階段:同一個 <ul> 搬進新的最後一列(不新建)、舊那一列不再有它、字直接換", b.sub === sub && sub.parentNode === li1 && !b.phasesEl.children[0].querySelector(".think-sub")
  && rowText(sub.children[0])[1] === "lib/runner.py" && subs(b.el).length === 1);
env.now = 5200; step("e", "report", "report.json");
ok("換階段那一刻不受 1.2s 限制(上一個字才停 100ms 也直接換)", sub.parentNode === b.phasesEl.children[2] && rowText(sub.children[0])[1] === "report.json");
env.now = 5300; step("f", "file_write", "x.py", "Write");
const li3 = b.phasesEl.children[3];
env.now = 5400; step("g", "file_read", "y.py", "Read");
ok("換階段之後重新計時:同階段的下一步照舊等滿 1.2s", rowText(sub.children[0])[1] === "x.py" && sub.parentNode === li3);
at(6500);
ok("…滿了才換", rowText(sub.children[0])[1] === "y.py");
ok("label 那組狀態(ACT)跟當下動作分開:busy 自己的 subRec / subAt / subTimer", "subRec" in b && "subTimer" in b && !/ACT\.(shown|shownAt)/.test(cut("function subApply(", "const fmtStepMs")));
env.now = 7000; M.busyEnd(false);
ok("正常收尾:當下動作收掉;收起;時長拿掉 aria-hidden(按鈕名稱帶時長)", !subs(b.el).length && !b.el.classList.contains("is-open") && b.elapsed.getAttribute("aria-hidden") === null);
ok("正常收尾:role=status 只在 head 那層,收尾時拿掉;展開區不在裡面", b.live.getAttribute("role") === null && b.el.getAttribute("role") === null && b.live.children[0] === b.head && b.el.children[1].classList.contains("think-reason-wrap"));

// ── 出錯:最後 3 步 ──
env.now = 10000; M.busyStart(); b = M.busy;
step("a", "strategy_write", "strategies/top5/strategy.py", "Write"); M.busyStepDone({ id: "a", ms: 50 });
env.now = 15000; step("b", "backtest", "lib/runner.py"); M.busyStepDone({ id: "b", ms: 30000 });
env.now = 46000; step("c", "strategy_read", "strategies/top5/strategy.py", "Read"); M.busyStepDone({ id: "c", ms: 316 });
env.now = 47000; step("d", "file_write", "strategies/top5/params.json", "Write");
env.now = 48000; step("e", "backtest", "strategies/top5/run_backtest.py");
ok("出錯之前的 3 個階段:寫策略 → 跑回測 → 寫策略 → 跑回測", b.phasesEl.children.length === 4);
M.busyStepDone({ id: "d", ms: 14 }); M.busyStepDone({ id: "e", ms: 58200, error: true });
env.now = 107000; M.busyEnd(true);
{ const rows = b.phasesEl.children, ul = rows[3].querySelector(".think-sub"), lis = ul ? ul.children : [];
  ok("出錯:掛在含 error 的那一階段(最後一列),只取那一階段的步驟(1 步,不跨回上一階段)", !!ul && lis.length === 1 && rowText(lis[0])[1] === "strategies/top5/run_backtest.py", lis.map && lis.map(rowText));
  ok("出錯的那一步:失敗的說法(stepLabel …, true, error)、is-last、耗時 58.2s;不加 aria-hidden", rowText(lis[0])[0] === "FAIL:step.backtest" && lis[0].classList.contains("is-last")
    && lis[0].querySelector(".think-step-time").textContent === "58.2s" && ul.getAttribute("aria-hidden") === null);
  ok("紅只上那一階段的記號:出錯那一列 is-err,其他列沒有", rows[3].classList.contains("is-err") && [0, 1, 2].every((i) => !rows[i].classList.contains("is-err")));
  ok("出錯自己攤開(aria-expanded=true);只有一份子清單", b.el.classList.contains("is-open") && b.head.getAttribute("aria-expanded") === "true" && subs(b.el).length === 1); }

env.now = 200000; M.busyStart(); b = M.busy;
step("a", "data", "BTC"); M.busyStepDone({ id: "a", ms: 900 });
env.now = 201000; step("b", "backtest", "lib/runner.py"); M.busyStepDone({ id: "b", ms: 1500 });
["c", "d", "e", "f"].forEach((id, i) => { env.now = 202000 + i * 1000; step(id, "file_read", "strategies/s/f" + i + ".py", "Read"); M.busyStepDone({ id, ms: 10 + i, error: id === "f" }); });
M.busyEnd(true);
{ const ul = b.phasesEl.children[1].querySelector(".think-sub"), lis = ul.children;
  ok("出錯:那一階段 5 步只列最後 3 步(讀檔照樣算進當下那一階段),最後一步 is-last、前兩步不是;耗時 ms", lis.length === 3 && lis.map((l) => rowText(l)[1]).join() === "strategies/s/f1.py,strategies/s/f2.py,strategies/s/f3.py"
    && lis[2].classList.contains("is-last") && !lis[0].classList.contains("is-last") && !lis[1].classList.contains("is-last") && lis[0].querySelector(".think-step-time").textContent === "11ms", lis.map(rowText)); }

// ── 停止:列最後幾步、不攤開;被中斷那一步沒有耗時 ──
env.now = 300000; M.busyStart(); b = M.busy;
step("a", "data", "BTC"); M.busyStepDone({ id: "a", ms: 900 }); env.now = 301000; step("b", "scan", "lib/param_scan.py");
M.busyEnd(false, true);
{ const ul = b.phasesEl.children[1].querySelector(".think-sub"), li = ul && ul.children[0];
  ok("停止:中斷的那一階段底下列最後幾步,當下動作不並存;記號不紅;照舊收著", !!ul && subs(b.el).length === 1 && ul.children.length === 1 && !b.phasesEl.children[1].classList.contains("is-err") && !b.el.classList.contains("is-open"));
  ok("停止:被中斷的步驟沒有耗時,那一欄留空", li && li.querySelector(".think-step-time").textContent === "" && li.classList.contains("is-last")); }

// ── 分不出階段的出錯回合:最後 3 步直接當清單本身 ──
env.now = 400000; M.busyStart(); b = M.busy;
["a", "b", "c", "d"].forEach((id) => { step(id, "unknown", "python x.py"); M.busyStepDone({ id, ms: 5, error: id === "d" }); });
M.busyEnd(true);
{ const ul = b.el.querySelector(".think-sub");
  ok("分不出階段:最後 3 步直接當清單(is-top,排在階段清單後、思考文字前),整塊可展開、攤開", !!ul && ul.classList.contains("is-top") && ul.children.length === 3 && ul.parentNode === b.phasesEl.parentNode
    && ul.nextSibling === b.reason && b.head.classList.contains("has-reason") && b.el.classList.contains("is-open")); }

// ── 只讀、沒思考的回合不留(Wei 10-16;code 稽核 §2-1):停止的也不留,出錯的例外 ──
env.now = 450000; M.busyStart(); b = M.busy;
["a", "b"].forEach((id) => step(id, "file_read", "x.py", "Read")); M.busyStepDone({ id: "a", ms: 5 });
M.busyEnd(false, true);
ok("停止的只讀回合(沒有階段、沒有思考):不留「思考過程」那一列", !b.el.parentNode || b.el.hidden || b.el.classList.contains("is-fading"), { parent: !!b.el.parentNode, cls: b.el.className });
env.now = 460000; M.busyStart(); b = M.busy;
step("a", "file_read", "x.py", "Read"); M.busyReason("let me check"); M.busyEnd(false, true);
ok("停止的只讀回合但有思考文字:照留", !!b.el.parentNode && b.el.classList.contains("is-done") && !b.el.classList.contains("is-fading"));

// ── 回放 ──
{ const F = (steps) => M.receiptFold(steps);
  const f = F([{ tool: "Write", summary: "strategies/a/strategy.py" }, { tool: "Bash", summary: "lib/runner.py" }, { tool: "WebSearch", summary: "q" }, { tool: "Read", summary: "y.py" }]);
  const ul = f.querySelector(".think-sub"), ph = f.querySelector(".think-phases");
  ok("回放:預設攤開;沒被截 → 最後一階段底下列它的步驟(搜尋＋其後讀檔),沒有耗時欄、記號不紅", f.classList.contains("is-open") && f.querySelector(".think-head").getAttribute("aria-expanded") === "true"
    && ph.children.length === 2 && ul && ul.parentNode === ph.children[1] && ul.children.length === 2 && !f.querySelector(".think-step-time") && !ph.querySelector(".is-err") && ul.children[1].classList.contains("is-last"), ul && ul.children.map(rowText));
  const g = F([{ tool: "Write", summary: "a.py" }, { tool: "WebSearch", summary: "q" }, { more: "…另有 3 步" }]);
  ok("回放被截過(…另有 N 步):不列子列,只畫階段;照樣攤開", !g.querySelector(".think-sub") && g.querySelector(".think-phases").children.length === 2 && g.classList.contains("is-open"));
  const h = F([{ tool: "Bash", summary: "a" }, { tool: "Bash", summary: "b" }, { tool: "Bash", summary: "c" }, { tool: "Bash", summary: "d" }]);
  ok("回放分不出階段:最後 3 步直接當清單本身(is-top)", h.querySelector(".think-phases").hidden && h.querySelector(".think-sub.is-top").children.length === 3 && h.classList.contains("is-open"));
  const k = F([{ tool: "Bash", summary: "a" }, { more: "…另有 20 步" }]);
  ok("回放被截過又分不出階段:沒東西可攤 → 只留「思考過程」那一行,不給 ⌄、不攤開", !k.querySelector(".think-sub") && !k.querySelector(".think-head").classList.contains("has-reason") && !k.classList.contains("is-open") && k.querySelector(".think-head").getAttribute("aria-expanded") === null);
  const m = F([{ tool: "mcp__blave__get_ssh_access", summary: "" }, { tool: "Write", summary: "a.py" }]);
  ok("回放:這一輪兩邊都做過事 → .has-both(子列的位置記號看得到)", m.classList.contains("has-both") && !!m.querySelector(".wtag")); }

// ── CSS 與字串 ──
ok("CSS:階段清單沒有高度上限、不內捲;列 grid、子清單 grid-column 1/-1、左縮 16;子列 12px 列距 1、整行 --ink-3、最後一步 --ink-2;紅只上記號",
  !/\.think-phases \{[^}]*(max-height|overflow)/.test(css) && /\.think-phase \{ display: grid; grid-template-columns: 8px auto minmax\(0, 1fr\) auto;/.test(css)
  && css.includes(".think-sub { grid-column: 1 / -1; min-width: 0; list-style: none; margin: 0; padding: 0 0 0 16px; }")
  && /\.think-sub-row \{[^}]*padding: 1px 0; font-size: 12px;[^}]*color: var\(--ink-3\); \}/.test(css)
  && css.includes(".think-sub-row.is-last .think-step-verb, .think-sub-row.is-last .think-step-obj { color: var(--ink-2); }")
  && css.includes(".think-phase.is-err .think-step-mark { background: var(--color-red); }") && !/\.think-sub[^{]*\{[^}]*(--color-red|transition|animation)/.test(css));
ok("CSS:.think-live(role=status 那層)不設 position(熱區 ::before 錨在 .think-indicator)", /\.think-live \{[^}]*\}/.test(css) && !/\.think-live \{[^}]*position/.test(css));
ok("字串:Show thoughts(en)/ 顯示思考內容(zh)", /"turn\.showReason": "Show thoughts"/.test(strings) && /"turn\.showReason": "顯示思考內容"/.test(strings));
ok("不埋點:當下動作、最後幾步、回放都沒有 trackFeature / trackEvent", !/trackFeature|trackEvent/.test(cut("function subApply(", "// 聊天欄寬度會變") + cut("function receiptFold(", "/* 舊回合的使用者那句")));

console.log(red ? `\n${red} FAILED` : "\nALL PASS");
process.exit(red ? 1 : 0);
