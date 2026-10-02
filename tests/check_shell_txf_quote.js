// 台指期報價(雲端視角金額表的口數列換參考金額;同網頁 loadTxfQuote / txfRefMoney):
//   主行程 txfQuote  —— 匿名 GET txf_summary(跟網頁同一支、同一個 symbol)、成功留 5 分鐘、失敗回上一份 / null、60 秒內不重問、同時只一趟
//   preload / IPC    —— txf-quote 頻道經 fromOurPage 守門
//   renderer         —— trTxfWant 在背景補問、只在雲端視角;報價進金額表簽章;有報價時目標部位、合計、倍數、確認框照網頁換算
// 跑法:node tests/check_shell_txf_quote.js
const fs = require("fs"), path = require("path"), vm = require("vm");
let red = 0; const ok = (n, c, info) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || info === undefined ? "" : "  " + info)); if (!c) red++; };
const J = JSON.stringify;
const S = path.join(__dirname, "..", "shell"), R = path.join(S, "renderer");
const mainSrc = fs.readFileSync(path.join(S, "main.js"), "utf8"), pre = fs.readFileSync(path.join(S, "preload.js"), "utf8"), src = fs.readFileSync(path.join(R, "trade.js"), "utf8");
const cutF = (s, n) => { const i = s.indexOf("function " + n + "("); if (i < 0) throw new Error("no " + n); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("no " + n); };
const constLine = (s, n) => { const m = new RegExp("^const " + n + " = [^\\n]*", "m").exec(s); if (!m) throw new Error("no " + n); return m[0].replace(/^const /, "var "); };

let done = false;
process.on("exit", (c) => { if (!done && c === 0) { console.log("FAIL  測試沒有跑完(有 promise 永遠沒回來)"); process.exitCode = 1; } });
(async () => {
  /* ── 主行程 ── */
  { let clock = 1_000_000_000, calls = [], reply = null;
    const ctx = vm.createContext({ Date: { now: () => clock }, Number, isFinite, Promise, Error, API_BASE: "https://api.blave.org",
      getJSON: (url, h) => { calls.push([url, h]); return typeof reply === "function" ? reply() : Promise.resolve(reply); } });
    vm.runInContext(constLine(mainSrc, "TXF_QUOTE_MS") + "\nvar txfCache = null, txfFailAt = 0, txfInflight = null;\n" + cutF(mainSrc, "txfQuote"), ctx);
    const q = () => vm.runInContext("txfQuote()", ctx);
    reply = { status: 200, body: { price: 23050.5, change: 10 } };
    const p1 = await q();
    ok("成功:回指數;打的是網頁同一支匿名端點(symbol=TXF、不帶任何憑證)", p1 === 23050.5 && calls.length === 1
      && calls[0][0] === "https://api.blave.org/studio/charts/twfutures/txf_summary?symbol=TXF" && J(calls[0][1]) === "{}", J(calls));
    clock += 299000; reply = { status: 200, body: { price: 1 } };
    ok("5 分鐘內再問:用快取、不打 api", (await q()) === 23050.5 && calls.length === 1);
    clock += 2000; reply = { status: 200, body: { price: 23100 } };
    ok("過了 5 分鐘:重問、換新值", (await q()) === 23100 && calls.length === 2);
    clock += 301000; reply = { status: 503, body: { error: "x" } };
    ok("過期後 api 回錯:回上一份(同網頁不清掉)", (await q()) === 23100 && calls.length === 3);
    clock += 30000;
    ok("失敗後 60 秒內:不再問(不拿輪詢敲 api)", (await q()) === 23100 && calls.length === 3);
    clock += 31000; reply = () => Promise.reject(new Error("ENOTFOUND"));
    ok("60 秒後再問;離線(請求丟例外)也只回上一份", (await q()) === 23100 && calls.length === 4);
    vm.runInContext("txfCache = null; txfFailAt = 0;", ctx); clock += 100000;
    for (const bad of [{ status: 200, body: { price: null } }, { status: 200, body: { price: -5 } }, { status: 200, body: {} }, { status: 404, body: { price: 23000 } }]) {
      reply = bad; vm.runInContext("txfFailAt = 0;", ctx);
      const v = await q();
      if (v !== null) { ok("看不懂的回應(price 缺 / 非正數 / 非 200)= null", false, J([bad, v])); break; }
    }
    ok("看不懂的回應(price 缺 / 非正數 / 非 200)= null,沒有上一份就不猜", vm.runInContext("txfCache", ctx) === null);
    const rel = []; reply = () => new Promise((res) => { rel.push(() => res({ status: 200, body: { price: 23200 } })); });
    vm.runInContext("txfFailAt = 0;", ctx); const before = calls.length;
    const a = q(), b = q(); rel.forEach((f) => f());
    ok("同時兩次:只打一趟、兩邊拿到同一個值", (await a) === 23200 && (await b) === 23200 && calls.length === before + 1); }
  ok("IPC:txf-quote 走 handle(fromOurPage 守門);preload 只開 txfQuote 這一個呼叫",
    /handle\("txf-quote", \(\) => txfQuote\(\)\);/.test(mainSrc) && /txfQuote: \(\) => ipcRenderer\.invoke\("txf-quote"\),/.test(pre)
    && /const handle = \(channel, fn, denied = null\) => ipcMain\.handle\(channel, \(e, \.\.\.a\) => \(fromOurPage\(e\) \? fn\(e, \.\.\.a\) : denied\)\);/.test(mainSrc));

  /* ── renderer:背景補問 ── */
  { let asked = 0, answer = 23000, clock = 5_000_000;
    const win = { blave: { txfQuote: () => { asked++; return typeof answer === "function" ? answer() : Promise.resolve(answer); } } };
    const ctx = vm.createContext({ window: win, Date: { now: () => clock }, Promise, Number, isFinite });
    vm.runInContext(constLine(src, "TR_TXF") + "\n" + cutF(src, "trTxfPrice") + "\n" + cutF(src, "trTxfWant"), ctx);
    const want = () => vm.runInContext("trTxfWant()", ctx), price = () => vm.runInContext("trTxfPrice()", ctx), flush = () => new Promise((r) => setImmediate(r));
    ok("一開始沒有報價 = null(畫「—」)", price() === null);
    want(); await flush();
    ok("畫到口數列 → 背景問一次、拿到就記下", asked === 1 && price() === 23000);
    clock += 200000; want(); await flush();
    ok("5 分鐘內不再問", asked === 1);
    clock += 101000; answer = null; want(); await flush();
    ok("過期再問;主行程回 null(問不到)→ 手上那份不清掉", asked === 2 && price() === 23000);
    vm.runInContext("TR_TXF.price = null; TR_TXF.at = Date.now();", ctx); answer = null;
    clock += 30000; want(); await flush();
    ok("沒有報價時失敗後 60 秒內不再問", asked === 2);
    clock += 31000; answer = 23500; want(); want(); await flush();
    ok("60 秒後再問;同時叫兩次只問一次", asked === 3 && price() === 23500);
    const bare = vm.createContext({ Date: { now: () => 0 }, Promise, Number, isFinite });
    vm.runInContext(constLine(src, "TR_TXF") + "\n" + cutF(src, "trTxfWant"), bare);
    ok("沒有 window.blave(測試、舊 preload)不壞", vm.runInContext("trTxfWant(1e9)", bare) === false); }
  ok("接線:只在雲端視角、畫到口數列才補問;報價在金額表簽章裡(回來的值下一輪輪詢就畫上)",
    /if \(txf && cloud\) trTxfWant\(\);/.test(cutF(src, "trAmountTable")) && /trCfgUnread\(r\), trTxfPrice\(\)\];/.test(cutF(src, "trPaintPos")));

  /* ── renderer:有報價時照網頁換算(目標部位、合計、倍數) ── */
  { const pure = src.slice(src.indexOf("/* ── 純邏輯("), src.indexOf("/* ── 純邏輯到此")) + src.slice(src.indexOf("/* ── 視角純邏輯("), src.indexOf("/* ── 視角純邏輯到此"));
    const node = (tag) => ({ tag, id: "", className: "", kids: [], text: "", attrs: {}, hidden: false, disabled: false, value: "", parentNode: null, dataset: {}, title: "",
      classList: { toggle() {} }, appendChild(c) { this.kids.push(c); return c; }, append(...c) { c.forEach((x) => this.kids.push(x)); }, insertAdjacentElement() {}, remove() {},
      querySelector() { return { title: "" }; }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, addEventListener() {},
      get textContent() { return this.text + this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }, set textContent(v) { this.text = v; this.kids = []; } });
    const flat = (n, out = []) => { if (n && n.tag) { out.push(n); n.kids.forEach((k) => flat(k, out)); } return out; };
    const ctx = vm.createContext({ document: { createElement: node, createDocumentFragment: () => node("#frag") }, Date, Math, JSON, Array, Object, Number, String, Set, isFinite, console,
      $: () => null, t: (k, o) => k + (o ? " " + JSON.stringify(o) : ""), LANG: "zh", PAPER: "paper", CX_VENUES: {}, srSay() {}, trIsPaper: () => false, UNIT: "TWD", EQ: 2000000 });
    vm.runInContext("function trUnit() { return UNIT; } function trEquity() { return EQ; }", ctx);
    vm.runInContext(pure.replace(/^const /gm, "var ") + "\nvar trTipSeq = 0;\n" + src.slice(src.indexOf("const TR_GATE_KEY"), src.indexOf("function trGateReason")).replace(/^const /gm, "var ")
      + ["trEl", "trSec", "trTipLabel", "trHead", "trFmt", "trMoneyInto", "trReport", "trStored", "trBase", "trNamesOf", "trNames", "trListNames", "trDisplay", "trPickOff", "trPickBtn", "trVenueId", "trVenueLabel",
        "trVenueInline", "trZhTidy", "tv", "trGateReason", "trStratName", "trTxfWant", "trRowTxf", "trRowIsLot", "trRowMoney", "trAmountTable"].map((n) => cutF(src, n)).join("\n"), ctx);
    const V = { credentials: true, pair: true, order: true, account: true };
    const paint = (price, unit = "TWD", eq = 2000000, mixed = false) => {
      vm.runInContext("TR_TXF.price = " + J(price) + "; UNIT = " + J(unit) + "; EQ = " + J(eq), ctx);
      ctx.TR = { env: "cloud", list: [{ name: "txf", displayName: "TXF", hasBacktest: true }].concat(mixed ? [{ name: "btc", displayName: "BTC", hasBacktest: true }] : []), listLoaded: true, picked: null, sent: null, save: null, edits: {}, bad: {}, sig: {},
        st: { alive: true, report: { venues: { capital: V }, config: { amounts: Object.assign({ txf: 2 }, mixed ? { btc: 500 } : {}) },
          states: Object.assign({ txf: { symbol: "TXF", position: 0.5 } }, mixed ? { btc: { symbol: "BTCUSDT", position: 1 } } : {}) } } };
      const all = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx));
      const row = all.find((n) => n.tag === "tr" && n.kids[0] && n.kids[0].className === "key"), tot = all.find((n) => n.className === "pf-total");
      const note = all.find((n) => n.className === "pf-foot unit-note");
      return { tgt: row.kids[3].textContent, tot: tot.textContent, note: note ? note.textContent : null };
    };
    const q = paint(20000);
    // 2 口 × 200 點值 × 20,000 點 = 8,000,000 TWD;× 部位 0.5 = 4,000,000;淨值 2,000,000 → 4.00x
    ok("有報價:目標部位 = 口 × 點值 × 指數 × 部位(帳戶幣);合計 = 參考金額、出「你淨值的 N x」", q.tgt === "+4,000,000TWD" && q.tot === "tr.total8,000,000TWD·tr.ofEquity4.00x", J(q));
    const n = paint(null);
    ok("沒有報價(離線 / api 錯):退回「—」、不出倍數,不壞畫面", n.tgt === "—" && n.tot === "tr.total—", J(n));
    ok("R2-S1:有報價 → 口數列的目標部位是錢,表下「金額單位」那一行要出(窄寬時列內幣別收到這一行);沒報價、全是口數列 → 不出",
      q.note === 'tr.unitNote {"c":"TWD"}' && n.note === null, J([q.note, n.note]));
    const f = paint(20000, "USDT", null);
    ok("R2-S2:讀帳失敗(帳戶幣退成 USDT、沒有淨值)+ 有報價 → 目標部位、合計、表下那一行都標 TWD,不出倍數",
      f.tgt === "+4,000,000TWD" && f.tot === "tr.total8,000,000TWD" && f.note === 'tr.unitNote {"c":"TWD"}', J(f));
    const m1 = paint(20000, "USDT", null, true), m2 = paint(20000, "TWD", 2000000, true), m3 = paint(20000, "USDT", 2000000);
    ok("混列(同網頁 pfRefTotal):台指期列 + 一般列、帳戶幣 USDT → 合計「—」;帳戶幣 TWD → 加總標 TWD 出倍數;只有口數列、帳戶幣 USDT → 標 TWD 不出倍數",
      m1.tot === "tr.total—" && m2.tot === "tr.total8,000,500TWD·tr.ofEquity4.00x" && m3.tot === "tr.total8,000,000TWD", J([m1.tot, m2.tot, m3.tot])); }
  ok("確認框:有報價時口數列寫「N 口商品(≈ M TWD)」(tr.txfConfirm),沒有才只列口數",
    /m == null \? t\("tr\.txfConfirmNoQuote", \{ lots: trFmt\(v\), prod: t\(sp\.prod\) \}\) : t\("tr\.txfConfirm", \{ lots: trFmt\(v\), prod: t\(sp\.prod\), amt: trFmt\(Math\.round\(m\)\) \}\)/.test(cutF(src, "trSaveAmounts"))
    && /m = trTxfRefMoney\(sp, v, trTxfPrice\(\)\)/.test(cutF(src, "trSaveAmounts")));
  ok("R2-S2 確認框:合計跟表下同一支 trTotals(幣別、混列「—」、倍數同規則);txfConfirm 的「≈ M TWD」本來就寫死",
    /tt = trTotals\(sending, eq, trRowMoney, trRowIsLot, trUnit\(\)\)/.test(cutF(src, "trSaveAmounts"))
    && /money\(tt\.total, tt\.ccy\)/.test(cutF(src, "trSaveAmounts")) && /^const TR_TXF_CCY = "TWD";$/m.test(src)
    && fs.readFileSync(path.join(R, "strings.js"), "utf8").includes('"tr.txfConfirm": "{lots} 口{prod}（≈ {amt} TWD）"'));

  done = true; console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
})();
