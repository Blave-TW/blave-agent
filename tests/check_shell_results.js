// 聊天結果卡(shell/renderer/results.js + reports.js 回合結束 + app.js stratRefresh + main.js 存檔;spec-desktop-result-card-0.1.8)。
//   ① 回合結束不再自動切中欄:reports.js rptTurnEnd 多出本機報告時不叫 rptOpen、交出卡項目;app.js stratRefresh(true) 不 stratSelect,
//      看著的那支被動過才原地 stratReload。
//   ② 卡的內容:種類判準(live tick 只改 stats 不算回測)、事實列的數字 = 回測頁同一支 fmtSignedPct、版號、掃描格數 + 落點、雲端記號;
//      一輪 5 張 → 3 張 +「還有 2 個」;鈕的可及名稱帶標題。
//   ③ 重開重畫:主行程存檔 / 讀檔(同 ts 併成一輪、壞形狀擋掉)→ 對現況:刪掉的是無鈕的已刪除態、之後又跑過回測的加「之後有更新」。
// 不開 Electron:純函式從原文切出來跑,畫卡用一個最小的假 DOM。跑法:node tests/check_shell_results.js
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 1500))); if (!c) red++; };
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const resSrc = read("results.js"), rptSrc = read("reports.js"), appSrc = read("app.js"), mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(s.lastIndexOf("\n", i) + 1, k + 1); } throw new Error("unbalanced " + name); };
const STR = (() => { const sb = {}; vm.runInNewContext(read("strings.js") + "\nthis.S = STRINGS;", sb); return sb.S; })();

// ── 最小假 DOM:只做 results.js 用到的那幾樣 ──
function El(tag) {
  const e = { tagName: tag.toUpperCase(), children: [], parentNode: null, attrs: {}, dataset: {}, listeners: {}, _text: "", title: "", type: "", hidden: false,
    get className() { return this.attrs.class || ""; }, set className(v) { this.attrs.class = v; },
    get classList() { const el = this; const L = () => (el.attrs.class || "").split(/\s+/).filter(Boolean); return { contains: (c) => L().includes(c), add: (c) => { if (!L().includes(c)) el.attrs.class = L().concat(c).join(" "); } }; },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }, set textContent(v) { this._text = String(v); this.children = []; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, hasAttribute(k) { return k in this.attrs; },
    appendChild(c) { if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1); c.parentNode = this; this.children.push(c); return c; },
    append(...xs) { xs.forEach((x) => this.appendChild(typeof x === "string" ? Txt(x) : x)); },
    after(n) { const p = this.parentNode; if (n.parentNode) n.parentNode.children.splice(n.parentNode.children.indexOf(n), 1); n.parentNode = p; p.children.splice(p.children.indexOf(this) + 1, 0, n); },
    replaceWith(n) { const p = this.parentNode, i = p.children.indexOf(this); n.parentNode = p; p.children[i] = n; this.parentNode = null; },
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }, click() { (this.listeners.click || []).forEach((f) => f()); }, focus() { DOC.activeElement = this; },
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === DOC.body; },
    get lastElementChild() { return this.children.filter((c) => c.tagName).slice(-1)[0] || null; },
    get previousElementSibling() { const s = this.parentNode ? this.parentNode.children.filter((c) => c.tagName) : []; return s[s.indexOf(this) - 1] || null; },
    closest(sel) { let n = this; while (n && !match(n, sel)) n = n.parentNode; return n || null; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) { const direct = sel.startsWith(":scope > "), s = direct ? sel.slice(9) : sel, out = []; const walk = (n) => n.children.forEach((c) => { if (!c.tagName) return; if (matchDesc(c, s, this)) out.push(c); if (!direct) walk(c); }); walk(this); return out; },
    get firstChild() { const el = this; return el._text ? { get textContent() { return el._text; }, set textContent(v) { el._text = String(v); } } : el.children[0] || null; },
  };
  return e;
}
function Txt(s) { return { textContent: s, parentNode: null }; }
// 「.a .b」:最後一段比自己,前面幾段依序在祖先裡找(不出 root)
function matchDesc(n, sel, root) { const parts = sel.trim().split(/\s+/); if (!match(n, parts.pop())) return false; for (let p = n.parentNode; parts.length && p && p !== root; p = p.parentNode) if (match(p, parts[parts.length - 1])) parts.pop(); return !parts.length; }
function match(n, sel) { if (!n.tagName) return false; const m = /^(\w+)?((?:\.[\w-]+)*)$/.exec(sel); if (!m) throw new Error("假 DOM 不認得 " + sel); return (!m[1] || n.tagName === m[1].toUpperCase()) && m[2].split(".").filter(Boolean).every((c) => n.classList.contains(c)); }
const DOC = { body: El("body"), activeElement: null, createElement: El, createElementNS: (_ns, tag) => El(tag) };
const CHAT = El("div"); DOC.body.appendChild(CHAT);
const texts = (n) => n.textContent;

// ── 共用的沙盒:results.js 全檔 + reports.js 全檔 + 回測 / 掃描的兩支 IIFE(fmtSignedPct / scanTag 用真的)──
function box(extra) {
  const S = { console, Map, Set, Promise, JSON, Math, Date, Number, String, Array, Object, isFinite, setTimeout: () => 0, clearTimeout: () => {}, document: DOC, requestAnimationFrame: (f) => f(),
    window: { BlaveReport: null, blave: {} }, LANG: "zh", sessionId: "desktop-aaaa1111", RP: { list: [], name: null, data: null, tab: "bt", drawn: {} },
    t: (k, v) => { let s = STR.zh[k] || k; if (v) for (const x in v) s = s.split("{" + x + "}").join(v[x]); return s; },
    $: (id) => (id === "chat-scroll" ? CHAT : S.__els[id] || (S.__els[id] = El("div"))), __els: {}, calls: [],
    addMsg: (cls) => { const e = El("div"); e.className = "msg " + cls; CHAT.appendChild(e); return e; }, scrollChat: () => {}, srSay: (x) => S.calls.push("say:" + x), trackFeature: (n) => S.calls.push("track:" + n) };
  S.window.document = DOC; Object.assign(S, extra || {});
  vm.createContext(S);
  vm.runInContext("window.BlaveReport = {};" + read("report-backtest.js").replace(/window\./g, "window."), S);
  vm.runInContext(read("report-robust.js"), S);
  // 頂層 const / let 不會掛到沙盒物件上:換成 var 才拿得到 RPT / RES
  vm.runInContext((resSrc + "\n" + rptSrc.replace(/\(function rptWire\(\) \{[\s\S]*\}\)\(\);\s*$/, "")).replace(/^(const|let) /gm, "var "), S);
  return S;
}

// ── ① 回合結束不再自動切 ──
{
  const S = box();
  const opened = []; S.rptOpen = async () => { opened.push("rptOpen"); return true; };
  S.libEnv = () => "local"; S.libEl = (tag, cls, text) => { const e = El(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const now = Date.now();
  S.window.blave.reportsList = async () => ({ reports: [{ id: "etf-flow", title: "ETF 資金流週報", type: "research", created_at: 1790000000, mtime: now + 10 }, { id: "old", title: "舊的", type: "morning", created_at: 1780000000, mtime: now - 3600e3 }] });
  S.$("rpt").hidden = true; S.$("rpn-scrim").hidden = true; S.$("rpt-nav-new").hidden = true;   // 人不在報告區、記號原本收著
  S.rptTurnStart({ env: "local" }); S.RPT.turnAt = now;
  vm.runInContext(`this.__p = rptTurnEnd(null)`, S);
  S.__p.then((items) => {
    ok("① 本機這一輪寫了報告:rptTurnEnd 不叫 rptOpen、交出那一份的結果卡項目(版本鍵 = rptKey)、側欄記號亮(清單沒開著)",
      opened.length === 0 && items.length === 1 && items[0].kind === "report" && items[0].ref === "etf-flow" && items[0].ver === "etf-flow@" + (now + 10) && S.__els["rpt-nav-new"].hidden === false, JSON.stringify([opened, items]));
  }).catch((e) => ok("① rptTurnEnd", false, e.stack));
  ok("① reports.js 整支沒有回合結束的自動打開(rptTurnEnd / rptCloudPollTick 都不叫 rptOpen / rptShowRead)",
    !/rptOpen\(|rptShowRead\(/.test(cutFn(rptSrc, "rptTurnEnd")) && !/rptOpen\(|rptShowRead\(/.test(cutFn(rptSrc, "rptCloudPollTick")));
}
{
  // app.js stratRefresh(true):清單重讀、這一輪動過 → 不 stratSelect;看著的那支被動過 → stratReload(原地),live tick 只改 stats mtime → 不重讀
  const S = box();
  const list0 = [{ name: "btc_ma", mtime: 1, codeMtime: 1, statsMtime: 1, scanMtime: 0, generatedAt: 100 }, { name: "eth_fr", mtime: 1, codeMtime: 1, statsMtime: 1, scanMtime: 0, generatedAt: 100 }];
  const run = async (view, list1) => {
    S.RP.list = list0; S.RP.name = view; const sel = [], rel = [];
    S.window.blave.listStrategies = async () => list1;
    S.stratSelect = async (n) => sel.push(n); S.stratReload = async (n) => rel.push(n); S.armedDelete = () => El("button"); S.stratTip = () => ""; S.stratNameFill = (nm, x) => { nm.textContent = x; }; S.running = false;
    vm.runInContext(cutFn(appSrc, "stratRefresh"), S);
    await S.stratRefresh(true); return { sel, rel };
  };
  (async () => {
    let r = await run(null, [{ ...list0[0], generatedAt: 200, statsMtime: 5, mtime: 5 }, list0[1], { name: "new_one", mtime: 9, codeMtime: 9, statsMtime: 0, scanMtime: 0, generatedAt: null }]);
    ok("① stratRefresh(true):這一輪多一支、另一支跑了回測 → 中欄不動(沒有 stratSelect、也沒有 stratReload)", r.sel.length === 0 && r.rel.length === 0, JSON.stringify(r));
    r = await run("eth_fr", [list0[0], { ...list0[1], generatedAt: 300, statsMtime: 7, mtime: 7 }]);
    ok("① 看著的那支這一輪重跑了回測 → stratReload 原地重畫(不 stratSelect)", r.sel.length === 0 && r.rel.join() === "eth_fr", JSON.stringify(r));
    r = await run("eth_fr", [list0[0], { ...list0[1], statsMtime: 9, mtime: 9 }]);
    ok("① 看著的那支只被 live tick 改了 stats.json(Generated At 沒變)→ 不重讀、不出卡", r.sel.length === 0 && r.rel.length === 0 && S.resStratSub(list0[1], { ...list0[1], statsMtime: 9 }) === null, JSON.stringify(r));
  })().catch((e) => ok("① stratRefresh", false, e.stack));
}

// ── ② 卡的內容 ──
{
  const S = box();
  const prev = new Map([["eth_fr", { name: "eth_fr", codeMtime: 1, statsMtime: 1, scanMtime: 0, generatedAt: 100, version: 7, hasBacktest: true }], ["sol_bo", { name: "sol_bo", codeMtime: 1, statsMtime: 1, scanMtime: 0, generatedAt: 100, hasBacktest: true }],
    ["btc_ma", { name: "btc_ma", codeMtime: 1, statsMtime: 1, scanMtime: 1, generatedAt: 100, hasBacktest: true }]]);
  const list = [
    { name: "btc4h", displayName: "BTC 4 小時均線交叉", codeMtime: 5, statsMtime: 6, scanMtime: 0, generatedAt: 200, hasBacktest: true, totalReturn: 38.2, maxDrawdown: -12.4, version: 1 },
    { name: "eth_fr", displayName: "ETH 資金費率反轉", codeMtime: 1, statsMtime: 8, scanMtime: 0, generatedAt: 300, hasBacktest: true, totalReturn: 112.654, maxDrawdown: -27.806, version: 8 },
    { name: "sol_bo", displayName: null, codeMtime: 9, statsMtime: 1, scanMtime: 0, generatedAt: 100, hasBacktest: true },
    { name: "dca", displayName: "每日定投 BTC 100 USDT", codeMtime: 4, statsMtime: 0, scanMtime: 0, generatedAt: null, hasBacktest: false },
    { name: "btc_ma", displayName: "BTC MA", codeMtime: 1, statsMtime: 1, scanMtime: 7, generatedAt: 100, hasBacktest: true },
  ];
  const items = S.resStratItems(prev, list), sub = Object.fromEntries(items.map((x) => [x.ref, x.sub]));
  ok("② 種類:新策略 / 回測 / 只改程式碼 / 新策略(沒回測)/ 參數掃描;沒快照就一張都不出", JSON.stringify(sub) === JSON.stringify({ btc4h: "new", eth_fr: "backtest", sol_bo: "code", dca: "new", btc_ma: "scan" }) && S.resStratItems(null, list).length === 0, JSON.stringify(sub));
  const scan = { row_param: "FAST", col_param: "SLOW", row_vals: [5, 10, 15], col_vals: [20, 30, 40, 50], grid: [[1, 2, 3, 4], [2, 5, 6, 3], [1, 2, 3, 1]], generated_at: 50 };
  const it = items.find((x) => x.ref === "btc_ma"), tag = S.window.BlaveReport.scanTag({ stats: { "Generated At": 40 }, scan, code: "FAST = 10\nSLOW = 40\n" });
  it.facts.grid_rows = tag.rows; it.facts.grid_cols = tag.cols; it.facts.tag = tag.tag;
  const f = S.resFmt(), line = (x, st) => S.resFacts(x, st || "ok", f).map((g) => g.map((s) => s.text).join("")).join(" | ");
  const by = (r) => items.find((x) => x.ref === r);
  ok("② 新策略:「新策略 | 總報酬 +38.20% | 最大回撤 −12.40%」——數字 = 回測頁 fmtSignedPct(2 位、U+2212);新策略不帶版號", line(by("btc4h")) === "新策略 | 總報酬 +38.20% | 最大回撤 \u221212.40%", line(by("btc4h")));
  ok("② 回測:這一輪定了新版才帶 v8(mono);數字四捨五入同回測頁", line(by("eth_fr")) === "回測 v8 | 總報酬 +112.65% | 最大回撤 \u221227.81%" && S.resFacts(by("eth_fr"), "ok", f)[0].some((s) => s.cls === "mono" && s.text === "v8"), line(by("eth_fr")));
  ok("② 只改程式碼 / Type B 新策略 / 參數掃描:「程式碼修改 | 還沒重跑回測」「新策略 | 沒有回測」「參數掃描 | 3×4 | 目前參數：…」(落點跟掃描分頁同一支判斷)",
    line(by("sol_bo")) === "程式碼修改 | 還沒重跑回測" && line(by("dca")) === "新策略 | 沒有回測" && line(it) === "參數掃描 | 3\u00d74 | " + STR.zh[tag.tag] && /^rob\.tag\./.test(tag.tag), [line(by("sol_bo")), line(by("dca")), line(it)].join(" / "));
  ok("② 鈕:回測 / 新策略 → 看回測、掃描 → 看掃描(rob 分頁)、程式碼 / 沒回測 → 看程式碼", ["btc4h", "eth_fr", "btc_ma", "sol_bo", "dca"].map((r) => S.resBtnKey(by(r)) + ">" + S.resTab(by(r))).join() === "res.open.bt>bt,res.open.bt>bt,res.open.scan>rob,res.open.code>code,res.open.code>code");
  const rep = S.resReportItem({ id: "etf", title: "ETF 資金流週報", type: "research", created_at: 1790000000, stored_at: 1790000100 }, "cloud", "etf@1790000100");
  ok("② 雲端報告:雲端記號 + MM/DD HH:mm(mono)· 類型;類型認不得只放時間、時間也壞只放「報告」", S.resFacts(rep, "ok", f)[0][0].cls === "tag" && /^雲端\d\d\/\d\d \d\d:\d\d · 研究$/.test(line(rep))
    && line({ ...rep, env: "local", facts: { created_at: null, type: "x" } }) === "報告", line(rep));
  // e2e #22:卡第二行的類型字 = 閱讀頁類型標籤的那個字(meta.report_type);主行程的信封把它交出來
  const lrep = (o) => S.resReportItem({ id: "symbol-btc", title: "BTC 收盤高於 60 日均線", type: "morning", created_at: 1790000000, mtime: 5, ...o }, "local", "symbol-btc@5");
  ok("② 報告卡的類型字跟閱讀頁同一個來源:有 label 用 label(「單標的晨報」,不是清單的「晨報」);沒有 label / 標題已含那個字 / label 只是 type 代號 → 退回類型詞",
    /· 單標的晨報$/.test(line(lrep({ label: "單標的晨報" }))) && /· 晨報$/.test(line(lrep({}))) && /· 晨報$/.test(line(lrep({ label: "BTC 收盤" }))) && /· 晨報$/.test(line(lrep({ label: "morning" }))) && /· 晨報$/.test(line(lrep({ label: 7 }))),
    [line(lrep({ label: "單標的晨報" })), line(lrep({})), line(lrep({ label: "morning" }))].join(" / "));
  { const sb = {}; vm.runInNewContext("const RPT_TITLE_MAX = 200, RPT_TYPE_MAX = 32, RPT_LABEL_MAX = 40, RPT_TS_MIN = 946684800, RPT_TS_MAX = 4102444800;\n" + cutFn(mainSrc, "rptEnvelope") + "\nthis.E = rptEnvelope;", sb);
    const e = (blocks) => sb.E("a", { title: "t", type: "morning", created_at: 1790000000, blocks }, 5000);
    ok("② 主行程的信封帶 label = blocks[0](meta)的 report_type:控制字元收掉、截 40;沒有 meta / 不是字串 / 空的 → null;存檔的形狀檢查收得下(字串 ≤ 64)",
      e([{ type: "meta", report_type: " 單標的\n晨報 " }]).label === "單標的 晨報" && e([{ type: "meta", report_type: "x".repeat(50) }]).label.length === 40 && e([{ type: "text", report_type: "x" }]).label === null
      && e([{ type: "meta", report_type: 5 }]).label === null && e([{ type: "meta", report_type: "  " }]).label === null && e(undefined).label === null, JSON.stringify(e([{ type: "meta", report_type: " 單標的\n晨報 " }]))); }
  ok("② 標題行高 1.45(spec §2、web .res-t 同值)", /\.res \.t \{\s*font-size: 13px; font-weight: 500; line-height: 1\.45;/.test(read("results.css")));
  const cs = S.resCloudItems(new Map([["live1", 1]]), [{ name: "tx_night", displayName: "台指期夜盤突破", mtime: Math.floor(Date.now() / 1000) }, { name: "live1", displayName: "跑著的", mtime: Math.floor(Date.now() / 1000) }], Date.now() - 1000, new Set(["live1"]), new Set());
  ok("② 雲端策略:新出現的出「雲端 新策略」(沒數字);組合裡跑著的那支 updated_at 一直變 → 不出「策略更新」", cs.length === 1 && cs[0].ref === "tx_night" && line(cs[0]) === "雲端新策略", JSON.stringify(cs));
  // e2e 0.1.8 H:Type B 送上雲端(這一輪帶 noBt)→ 卡是「雲端 新策略」+「沒有回測」;只有新出現而且清單說沒有回測才寫,其餘雲端卡照舊不講回測
  { const now = Math.floor(Date.now() / 1000), L = (hb) => [{ name: "watch", displayName: "資金費率監控", mtime: now, hasBacktest: hb }];
    const nb = S.resCloudItems(new Map(), L(false), Date.now() - 1000, new Set(), new Set(), true);
    ok("② Type B 搬上雲端:卡寫「雲端 新策略」與「沒有回測」", nb.length === 1 && nb[0].facts.no_bt === true && line(nb[0]) === "雲端新策略 | " + S.t("res.noBt"), JSON.stringify(nb) + line(nb[0] || {}));
    ok("② 沒帶 noBt(Type A/C 的搬運、一般回合)或清單說有回測 → 不寫「沒有回測」", [S.resCloudItems(new Map(), L(false), Date.now() - 1000, new Set(), new Set()), S.resCloudItems(new Map(), L(true), Date.now() - 1000, new Set(), new Set(), true)]
      .every((x) => x.length === 1 && x[0].facts.no_bt === undefined && line(x[0]) === "雲端新策略")); }
  // J:組合策略(Type C)的回測沒有逐筆紀錄(只有成交次數):「進出場紀錄」分頁講這件事,不講成「沒有進出場」
  { const trJs = read("report-trades.js");
    ok("J 進出場紀錄分頁:Type C(stats 有 benchmark_n)用自己的那一句,其餘照舊", /t\(stats && typeof stats\.benchmark_n === "number" \? "tr\.emptyPf" : "tr\.empty"\)/.test(trJs)
      && /沒有逐筆進出場紀錄/.test(S.t("tr.emptyPf")) && /回測數據/.test(S.t("tr.emptyPf")) && S.t("tr.empty") === "這支策略沒有進出場紀錄。");
    // 0.1.12 實測 04a:SPY 日線的進出場紀錄全是「08:00」——日期當 UTC 午夜寫進來、照台北時間印。日線以上只印日期,而且用 UTC 取(UTC 以西也不退一天)
    const sb = { window: {} }; vm.createContext(sb); vm.runInContext(trJs, sb); const TP = sb.window.BlaveReport._tradesPure;
    ok("J 日線以上判準(stats.interval):1d / 1D / 24h / 3d / 7d / 1w / 1W / 1M → 只印日期;23h 以下、分線、缺 / 認不得 → 照舊印到分鐘",
      ["1d", "1D", "24h", "3d", "7d", "1w", "1W", "1M"].every((x) => TP.isDailyOrAbove(x) === true) && ["23h", "12h", "4h", "1h", "60m", "60min", "15m", "1m", "", null, undefined, "daily", "1 day"].every((x) => TP.isDailyOrAbove(x) === false));
    const J = JSON.stringify, tz0 = process.env.TZ, ts = Date.UTC(2026, 3, 24) / 1000, at = (tz, f) => { process.env.TZ = tz; try { return f(); } finally { if (tz0 === undefined) delete process.env.TZ; else process.env.TZ = tz0; } };
    const tpe = at("Asia/Taipei", () => [TP.fmtTime(ts, true, true), TP.fmtTime(ts, false, true), TP.fmtTime(ts, true, false)]), la = at("America/Los_Angeles", () => TP.fmtTime(ts, true, true));
    ok("J 美股日線 2026-04-24(UTC 午夜):日期版台北 = 2026/04/24、不帶年 04/24;洛杉磯一樣 2026/04/24;分線照舊印台北 08:00", J(tpe) === J(["2026/04/24", "04/24", "2026/04/24 08:00"]) && la === "2026/04/24", J([tpe, la]));
    // 台股 / 台指期 1d 走 fetch_twstock_ohlcv / fetch_twfutures_ohlcv 的是台北午夜(= 前一天 16:00 UTC):也要印成當天,不能退成 04/23
    const tw = Date.UTC(2026, 3, 23, 16) / 1000, twd = ["Asia/Taipei", "America/Los_Angeles", "UTC", "Europe/London"].map((z) => at(z, () => TP.fmtTime(tw, true, true)));
    ok("J 台股日線 2026-04-24(台北午夜):台北 / 洛杉磯 / UTC / 倫敦都印 2026/04/24", twd.every((x) => x === "2026/04/24"), J(twd));
    ok("J 接線:renderTrades 用 stats.interval 算 dateOnly,清單列與十字線(localization.timeFormatter)都帶它", /const dateOnly = isDailyOrAbove\(stats\.interval\);/.test(trJs)
      && /buildList\(listEl, buildRows\(tracks\), withYear, dateOnly, function/.test(trJs) && /fmtTime\(p\.ts, withYear, dateOnly\)/.test(trJs)
      && /buildChart\(host, candles, tracks, sanitizePanes\(stats\.panes\), dateOnly\)/.test(trJs) && /fmtTime\(time, true, dateOnly\)/.test(trJs));
    // spec-0.1.13 #7:窄框每一列固定折成同樣兩行(方向+數量+種類 / 價格 … 部位),寬框一行;斷點同網頁 560,量清單本身的寬
    const css = read("report-trades.css"), nar = (/@container tr-list \(max-width: 560px\) \{([\s\S]*?)\n\}/.exec(css) || [])[1] || "";
    ok("#7 進出場紀錄列:兩組 .tr-l1(方向+數量、種類)/ .tr-l2(價格、部位),寬框 display: contents 攤平成一行",
      /l1\.appendChild\(\s*el\("span", isBuy \? "tr-side is-buy" : "tr-side is-sell"/.test(trJs) && /if \(kindKey\[p\.kind\]\) l1\.appendChild\(el\("span", "tr-kind"/.test(trJs)
      && /l2\.appendChild\(el\("span", "tr-px"/.test(trJs) && /l2\.appendChild\(el\("span", "tr-pos"/.test(trJs) && /row\.append\(l1, l2\);/.test(trJs)
      && /\.tr-l1, \.tr-l2 \{ display: contents; \}/.test(css) && /\.tr-side, \.tr-kind, \.tr-px, \.tr-pos \{ white-space: nowrap; \}/.test(css));
    ok("#7 窄框(清單 ≤ 560):列改 grid 兩欄、時間欄佔兩行、兩組各自一行 flex;清單是 container", /container: tr-list \/ inline-size;/.test(css)
      && /\.tr-row \{ display: grid; grid-template-columns: auto 1fr;/.test(nar) && /\.tr-ts \{ grid-row: span 2;/.test(nar) && /\.tr-l1, \.tr-l2 \{ display: flex;/.test(nar)); }
  // 一輪 5 張:先 3 張 + 還有 2 個;鈕的可及名稱
  const host = El("div"); host.className = "msg ai"; CHAT.appendChild(host);
  const five = S.resOrder(items.concat(rep).map((x, i) => ({ ...x, at: 10 - i })));
  S.resPaint(host, five, null, five, 1);
  const g = host.querySelector(".res-group"), cards = g.children.filter((c) => c.classList.contains("res"));
  const more = g.children.find((c) => c.classList.contains("res-more"));
  ok("② 一輪 6 張:依產出時間由舊到新、第 4 張起 .extra(收起)、「還有 3 個」;點了整組展開、焦點落在第一張新露出的卡的鈕",
    cards.length === 6 && cards.filter((c) => c.classList.contains("extra")).length === 3 && more && more.textContent === "還有 3 個" && (more.click(), g.classList.contains("all")) && DOC.activeElement === cards[3].querySelector("button"), JSON.stringify([cards.length, more && more.textContent]));
  const b = cards.find((c) => texts(c).includes("BTC 4 小時")).querySelector("button");
  ok("② 鈕 = .btn-fill「看回測」,可及名稱「看回測：BTC 4 小時均線交叉」;標題全文在 title", b.className === "btn-fill" && b.textContent === "看回測" && b.getAttribute("aria-label") === "看回測：BTC 4 小時均線交叉", b.getAttribute("aria-label"));
  host.remove();
}

// ── ③ 重開重畫 ──
{
  // 主行程:存檔 / 讀檔(從 main.js 原文切出來,BASE 指到暫存目錄)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-res-"));
  const a = mainSrc.indexOf("/* ── 聊天結果卡(renderer/results.js"), z = mainSrc.indexOf("// ── 聊天裡的圖");
  const M = { fs, path, BASE: tmp, okSessionId: (id) => typeof id === "string" && /^desktop-[a-z0-9]{4,16}$/.test(id), JSON, Number, Array, Object, isFinite };
  vm.createContext(M); vm.runInContext(mainSrc.slice(a, z).replace(/^const /gm, "var "), M);
  const it = (o) => ({ kind: "strategy", env: "local", ref: "btc4h", ver: "200|0|5", sub: "new", title: "BTC 4 小時", facts: { has_bt: true, total_return: 38.2, max_dd: -12.4 }, at: 1, ...o });
  const sid = "desktop-zzzz0001";
  ok("③ 存檔擋形狀:不認得的 kind / sub、非本 app 的 session id、facts 裡的物件值都不落地", M.saveTurnResults(sid, { ts: 100, items: [it(), it({ kind: "evil" }), it({ ref: "x", facts: { a: { b: 1 }, total_return: 1 } })] }) === true
    && M.saveTurnResults("../etc", { ts: 1, items: [it()] }) === false && M.saveTurnResults(sid, { ts: 200, items: [it({ sub: "hack" })] }) === false);
  M.saveTurnResults(sid, { ts: 100, items: [it({ kind: "report", ref: "etf", sub: "report", ver: "etf@1", title: "ETF", facts: { created_at: 1790000000, type: "research" } })] });
  M.saveTurnResults(sid, { ts: 300, items: [it({ ref: "gone_one", title: "被刪的那支" })] });
  const rows = M.loadTurnResults(sid);
  ok("③ 讀檔:同一個 ts(雲端晚到 append 的那列)併回同一輪、照寫入順序;facts 裡的物件值被丟掉", rows.length === 2 && rows[0].ts === 100 && rows[0].items.map((x) => x.ref).join() === "btc4h,x,etf" && !("a" in rows[0].items[1].facts) && rows[0].items[1].facts.total_return === 1, JSON.stringify(rows));
  fs.rmSync(tmp, { recursive: true, force: true });

  // renderer:對現況 → 已刪除 / 之後有更新;照時間插回那一輪的回覆
  const S = box();
  S.window.blave.loadTurnResults = async () => rows;
  S.window.blave.listStrategies = async () => [{ name: "btc4h", codeMtime: 5, statsMtime: 9, scanMtime: 0, generatedAt: 999 }, { name: "x", codeMtime: 5, statsMtime: 3, scanMtime: 0, generatedAt: 200 }];
  S.window.blave.reportsList = async () => ({ reports: [{ id: "etf", title: "ETF", mtime: 1 }] });
  S.RPT.data.local = null;
  (async () => {
    const hist = await S.resHistoryItems(sid);
    const st = hist.map((h) => h.res.items.map((x, i) => x.ref + ":" + h.res.states[i]).join()).join(" / ");
    ok("③ 對現況:之後又跑過回測(版本鍵不同)= later、沒變 = ok、清單上沒有 = gone;ts 照存檔", st === "btc4h:later,x:ok,etf:ok / gone_one:gone" && hist[0].ts === 100, st);
    CHAT.children = [];
    const you = El("div"); you.className = "msg you"; CHAT.appendChild(you);
    const ai = El("div"); ai.className = "msg ai"; CHAT.appendChild(ai);
    const sys = El("div"); sys.className = "msg sys"; CHAT.appendChild(sys);
    S.resRestore(hist[0].res);
    const cards = ai.querySelector(".res-group").children;
    ok("③ 重畫:掛在那一輪最後一則回覆裡(跳過後面的系統行)、舊卡不再播進場動畫;之後有更新的照畫當時的數字 + 「之後有更新」、鈕照常",
      cards.length === 3 && cards.every((c) => c.classList.contains("is-still")) && texts(cards[0]).includes("總報酬 +38.20%") && texts(cards[0]).endsWith("之後有更新看回測") && !!cards[0].querySelector("button"), cards.map(texts).join(" / "));
    const you2 = El("div"); you2.className = "msg you"; CHAT.appendChild(you2);
    S.resRestore(hist[1].res);
    const host2 = CHAT.lastElementChild, gone = host2.querySelector(".res");
    ok("③ 那一輪沒有回覆文字 → 自己起一則 .msg.ai;已刪除態:同一個殼、.is-gone、「這支策略已刪除」、沒有鈕",
      host2 !== ai && host2.classList.contains("ai") && gone.classList.contains("is-gone") && texts(gone.querySelector(".m")) === "這支策略已刪除" && !gone.querySelector("button"), texts(gone));
    // 當場按才發現不在:卡原地換成已刪除態 + 唸一句;埋點名在白名單、≤16 字
    const live = El("div"); live.className = "msg ai"; CHAT.appendChild(live);
    const x = { kind: "strategy", env: "local", ref: "just_deleted", ver: "1|0|1", sub: "backtest", title: "剛刪的", facts: { has_bt: true }, at: 1 };
    S.resPaint(live, [x], null, [x], 5); S.RP.list = []; S.ENV = { cur: "local" }; S.BR = { exp: { mode: "one" } }; S.brCollapse = () => { S.BR.exp = null; S.calls.push("collapse"); };
    await S.resGo(x, live.querySelector(".res"));
    const now = live.querySelector(".res");
    const { EVENTS } = require(path.join(SHELL, "telemetry.js"));
    ok("③ 按卡:先收瀏覽器展開層、送 result_strategy;策略已不在 → 卡原地換成已刪除態(無鈕)+ srSay",
      S.calls[0] === "collapse" && S.calls.includes("track:result_strategy") && now.classList.contains("is-gone") && !now.querySelector("button") && S.calls.includes("say:這支策略已刪除"), JSON.stringify(S.calls));
    ok("③ 埋點:result_report / result_strategy 在 feature_used 白名單、≤16 字(prop 是 VARCHAR(16))", ["result_report", "result_strategy"].every((n) => EVENTS.feature_used.name.includes(n) && n.length <= 16));
  })().catch((e) => ok("③ 重開重畫", false, e.stack));
}
// ── ④ 切語言當場重畫(0.1.11 Windows 真機:切 en 後結果卡還是中文,要重開 app 才換)──
//   結果卡照 host._res 重畫;同一類「畫一次就不再重畫」的一起修:轉出卡、固定觸發句的摘要泡泡、引擎進度與「上一輪還在跑」那兩種系統行。
{
  const S = box(), tL = (k, v) => { let x = STR[S.LANG][k] || k; if (v) for (const n in v) x = x.split("{" + n + "}").join(v[n]); return x; };
  S.t = tL;
  vm.runInContext(read("export.js").replace(/^(const|let) /gm, "var "), S);
  CHAT.children = [];
  const it = (o) => ({ kind: "strategy", env: "local", ref: "r", ver: "1|0|1", sub: "backtest", title: "BTC SMA", facts: { has_bt: true, total_return: 12.5, max_dd: -3.25 }, at: 1, ...o });
  const items = [it({ ref: "a" }), it({ ref: "b", title: "Gone one" }), it({ ref: "c", sub: "new", title: "New one" }), it({ ref: "d", title: "Later one" })];
  const host = El("div"); host.className = "msg ai"; CHAT.appendChild(host);
  S.resPaint(host, items, ["ok", "gone", "ok", "later"], items, 7);
  host.querySelector(".res-more").click();
  const snap = () => host.querySelector(".res-group").children.map((c) => texts(c) + "|" + (c.querySelector && c.querySelector("button") ? c.querySelector("button").getAttribute("aria-label") : "")).join(" / ");
  const zh = snap();
  S.LANG = "en"; S.resRelang();
  const g = host.querySelector(".res-group"), cards = g.children.filter((c) => c.classList.contains("res"));
  const btn = cards[0].querySelector("button");
  ok("④ 切 en:結果卡當場換成英文(回測更新 → Backtest updated、總報酬 → Total Return、看回測 → View backtest),可及名稱用半形冒號",
    texts(cards[0].querySelector(".m")).startsWith(STR.en["res.kind.btUpd"] + STR.en["bt.totalReturn"] + " +12.50%") && btn.textContent === STR.en["res.open.bt"] && btn.getAttribute("aria-label") === STR.en["res.open.bt"] + ": BTC SMA", texts(cards[0]) + " | " + (btn && btn.getAttribute("aria-label")));
  ok("④ 狀態跟著留:已刪除那張仍是無鈕的已刪除態(英文)、之後有更新那張帶 Updated since、新策略那張是 New strategy",
    cards[1].classList.contains("is-gone") && !cards[1].querySelector("button") && texts(cards[1]).includes(STR.en["res.gone.strat"]) && texts(cards[3]).includes(STR.en["res.later"]) && texts(cards[2]).includes(STR.en["res.kind.new"]), cards.map(texts).join(" / "));
  ok("④ 重畫不重播進場動畫、展開過的保持展開、張數與順序不變、卡上沒有剩下的中文",
    cards.length === 4 && cards.every((c) => c.classList.contains("is-still")) && g.classList.contains("all") && cards.map((c) => texts(c.querySelector(".t"))).join() === "BTC SMA,Gone one,New one,Later one"
    && !/[\u4e00-\u9fff]/.test(texts(g)), texts(g));
  S.LANG = "zh"; S.resRelang();
  ok("④ 切回 zh:跟原本畫的一字不差", snap() === zh, snap() + " ≠ " + zh);
  ok("④ applyStatic 會叫 resRelang / xpRelang / youRelang(切語言的那一條路)", /if \(typeof resRelang === "function"\) resRelang\(\);/.test(cutFn(appSrc, "applyStatic")) && /if \(typeof xpRelang === "function"\) xpRelang\(\);/.test(cutFn(appSrc, "applyStatic")) && /\n\s*youRelang\(\);/.test(cutFn(appSrc, "applyStatic")));

  // 轉出卡:類型字、說明句(帶平台名)、兩顆鈕
  const xpHost = El("div"); xpHost.className = "msg ai"; CHAT.appendChild(xpHost);
  const card = S.xpCard({ target: "xq", strategy: "btc", filename: "btc_xq.xs", size: 2048, session: "s", id: "1" });
  xpHost.appendChild(card);
  S.LANG = "en"; S.xpRelang();
  document_i18n(S);
  const ft = card.querySelector(".ft"), cap = card.querySelector(".xp-cap"), bs = card.querySelectorAll("button");
  ok("④ 轉出卡切 en:類型字 XS language、說明句英文(平台名照填)、下載 / 在程式碼分頁看兩顆鈕英文;大小那格不動",
    texts(ft) === "XQ · " + STR.en["xp.lang.xq"] + " · 2.0 KB" && texts(cap) === STR.en["xp.capHonest"].split("{platform}").join("XQ") && bs.map((b) => b.textContent).join("|") === STR.en["xp.dl"] + "|" + STR.en["xp.view"], [texts(ft), texts(cap), bs.map((b) => b.textContent).join("|")].join(" / "));

  // 固定觸發句的摘要泡泡:原句不動,摘要照現在的語言重組
  const T = { busyPin: () => {}, scrollChat: () => {}, paintAi: () => {}, STRINGS: STR };
  Object.assign(S, T);
  vm.runInContext(["fixedMatch", "fixedName", "fixedLabel", "addMsg", "youRelang"].map((n) => cutFn(appSrc, n)).join("\n") + "\n" + /^const FIXED_PROMPTS = .*$/m.exec(appSrc)[0].replace(/^const /, "var "), S);
  S.LANG = "zh";
  const raw = STR.zh["wf.msgRun"].split("{name}").join("btc_sma").split("{lookback}").join("1095").split("{step}").join("30");
  const you = S.addMsg("you", raw), plain = S.addMsg("you", "hello");
  const zhLab = texts(you), lab = (l) => { const sv = S.LANG; S.LANG = l; const x = tL("wf.msgRunLabel", { name: "btc_sma", lookback: "1095", step: "30" }); S.LANG = sv; return x; };
  S.LANG = "en"; S.youRelang();
  ok("④ 固定觸發句的泡泡:切 en 換成英文摘要、切回 zh 回到原本那句;一般的話不動",
    zhLab === lab("zh") && texts(you) === lab("en") && (S.LANG = "zh", S.youRelang(), texts(you) === zhLab) && texts(plain) === "hello", [zhLab, texts(you)].join(" / "));

  // 上一輪還在跑:系統行記著 key(data-i18n),applyStatic 的 data-i18n 那一圈會照新語言重填(引擎進度 0.1.12 起是安裝進度卡,見 check_shell_engine_card)
  ok("④「上一輪還在跑」的系統行掛 data-i18n", /addMsg\("sys", t\("turn\.busy"\)\)\.dataset\.i18n = "turn\.busy";/.test(appSrc)
    && /document\.querySelectorAll\("\[data-i18n\]"\)\.forEach\(\(el\) => \{ el\.textContent = t\(el\.dataset\.i18n\); \}\);/.test(cutFn(appSrc, "applyStatic")));
}
// applyStatic 的 data-i18n 那一圈(同 app.js)
function document_i18n(S) { const walk = (n) => n.children.forEach((c) => { if (!c.tagName) return; if (c.dataset.i18n) c.textContent = S.t(c.dataset.i18n); walk(c); }); walk(DOC.body); }
process.on("beforeExit", () => { if (process.exitCode !== undefined) return; console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exitCode = red ? 1 : 0; });
