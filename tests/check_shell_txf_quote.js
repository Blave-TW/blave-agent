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
  ok("接線:兩個視角都在畫到口數列時補問(統一與模擬交易在這台電腦也下台指期);報價在金額表簽章裡(回來的值下一輪輪詢就畫上)",
    /if \(txf\) trTxfWant\(\);/.test(cutF(src, "trAmountTable")) && /trCfgUnread\(r\), trTxfPrice\(\),/.test(cutF(src, "poPaintCfg")));

  /* ── renderer:有報價時照網頁換算(目標部位、合計、倍數) ── */
  { const pure = src.slice(src.indexOf("/* ── 純邏輯("), src.indexOf("/* ── 純邏輯到此")) + src.slice(src.indexOf("/* ── 視角純邏輯("), src.indexOf("/* ── 視角純邏輯到此"));
    const node = (tag) => ({ tag, id: "", className: "", kids: [], text: "", attrs: {}, hidden: false, disabled: false, value: "", parentNode: null, dataset: {}, title: "",
      classList: { toggle() {} }, appendChild(c) { this.kids.push(c); return c; }, append(...c) { c.forEach((x) => this.kids.push(x)); }, insertAdjacentElement() {}, remove() {},
      querySelector() { return { title: "" }; }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, addEventListener() {},
      get textContent() { return this.text + this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }, set textContent(v) { this.text = v; this.kids = []; } });
    const mk = node; const node2 = (tag) => { const n = mk(tag); n.classList = { toggle() {}, add(c) { n.className += " " + c; } }; n.on = {}; n.addEventListener = (e, f) => { n.on[e] = f; }; return n; };
    const flat = (n, out = []) => { if (n && n.tag) { out.push(n); n.kids.forEach((k) => flat(k, out)); } return out; };
    const ctx = vm.createContext({ document: { createElement: node2, createElementNS: (_ns, tag) => node2(tag), createDocumentFragment: () => node("#frag") }, Date, Math, JSON, Array, Object, Number, String, Set, isFinite, console,
      $: (id) => (id === "del-ok" ? ctx.DELOK : null), DELOK: { attrs: {}, disabled: false, setAttribute(k, v) { this.attrs[k] = v; } },
      t: (k, o) => k + (o ? " " + JSON.stringify(o) : ""), LANG: "zh", PAPER: "paper", BINANCE: "binance", CX_VENUES: {}, srSay() {}, trIsPaper: () => ctx.PAPERV === true, UNIT: "TWD", EQ: 2000000,
      confirmBox(o) { ctx.BOX = o; }, trCloudBox: (o) => o, trCcy: () => "TWD", setTimeout, clearTimeout,
      trWith: () => { ctx.DIRECT = (ctx.DIRECT || 0) + 1; return true; } });   // onOk 的第一步:記一次「直接存了」、走早退那條,不碰送出鏈
    vm.runInContext("function trUnit() { return UNIT; } function trEquity() { return EQ; }", ctx);
    vm.runInContext("var delCtx = null;\n" + (src.match(/^const TR_CF = [^\n]*\n/m) || [""])[0].replace(/^const /, "var "), ctx);
    vm.runInContext(pure.replace(/^const /gm, "var ") + "\nvar trTipSeq = 0;\n"
      + ["trEl", "trSec", "trTipLabel", "poHelpGroup", "poCfgSec", "trHead", "trFmt", "trMoneyInto", "trReport", "trContracts", "trStored", "trBase", "trNamesOf", "trNames", "trListNames", "trDisplay", "trPickOff", "trPickBtn", "trVenueId", "trVenueLabel",
        "trStratName", "trTxfWant", "trRowTxf", "trRowTxfNew", "trCtPend", "trCtStored", "trCt", "trCtGate", "trCtDirty", "trCtRollTag", "trRowMoneyStored", "trCtPayload", "trRowIsLot", "trRowMoney", "trLotsFmt", "trLotsTgtFmt", "trQuoteMap", "trNoSignalYet", "trZoneOf", "trZoneLabel", "trZoneUnit", "trFxView", "trZoneSum",
        "trTotalText", "trPaintPosCell", "trAmountTable", "trTwNamesWant", "trTwName", "trTwNameEl", "trGoStartKey", "trTradableFunded", "trCloseTag", "trStratHeld", "trPaperTwOk", "trPaperTw", "trCtCloseTag", "trSaveAmounts", "trCfStates", "trCfHolds", "trCfAsof", "trMarks", "trCfQty", "trCfRows", "trCfTick", "trCfMD", "trPvRequest", "trLivePositions", "trBook", "trGateSide", "trTradesSym", "trVenueKind", "poPartStates", "trTwBroker", "trTxfPrice"].map((n) => cutF(src, n)).join("\n"), ctx);
    const V = { credentials: true, pair: true, order: true, account: true };
    const paint = (price, unit = "TWD", eq = 2000000, mixed = false) => {
      vm.runInContext("TR_TXF.price = " + J(price) + "; UNIT = " + J(unit) + "; EQ = " + J(eq), ctx);
      ctx.TR = { env: "cloud", list: [{ name: "txf", displayName: "TXF", hasBacktest: true }].concat(mixed ? [{ name: "btc", displayName: "BTC", hasBacktest: true }] : []), listLoaded: true, picked: null, sent: null, save: null, edits: {}, bad: {}, sig: {},
        st: { alive: true, report: { venues: { capital: V }, config: { amounts: Object.assign({ txf: 2 }, mixed ? { btc: 500 } : {}) },
          states: Object.assign({ txf: { symbol: "TXF", position: 0.5 } }, mixed ? { btc: { symbol: "BTCUSDT", position: 1 } } : {}) } } };
      const all = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx));
      const row = all.find((n) => n.tag === "tr" && n.kids[0] && n.kids[0].className === "key"), tot = all.find((n) => n.className === "pf-total");
      const ths = all.filter((n) => n.tag === "th").map((n) => n.textContent), grps = all.filter((n) => n.tag === "tr" && n.className === "grp").map((n) => n.kids.map((k) => k.textContent));
      // 部位格:口數與 tooltip 在 .num 上、方向字是 .dir(spec portfolio-help-icon §2)
      const pc = row.kids[3], num = flat(pc).find((x) => x.className === "num"), dir = flat(pc).find((x) => /^dir /.test(x.className));
      return { tgt: num ? num.textContent : pc.textContent, dir: dir ? dir.className : "", tgtTip: num ? num.title : pc.title, tot: tot.textContent, totTip: (tot.kids[1] || {}).title || "", totHidden: tot.hidden, ths, grps,
        units: all.some((n) => /pf-foot unit-note/.test(n.className) || n.className === "amt-unit" || n.className === "lots-unit") };
    };
    const q = paint(20000);
    /* 2 口 × 部位 0.5 = 1 口(目標部位是口數,units spec §3.3);名目 1 × 200 點值 × 20,000 點 = 4,000,000 TWD 放 title。
       全是口數列也出合計(推翻 desktop-10-08 #4,units spec §5 電腦版 #4):名目 ≈ 8,000,000 TWD · 淨值 4.00×(綁群益、帳戶幣 TWD) */
    ok("有報價:部位寫「多 1」(口數 × 訊號,數字不帶號),名目進數字的 title;只有一區 → 單位回欄頭「口」、不畫區標題;合計 ≈ 名目 TWD + 淨值倍數",
      q.tgt === "1" && q.dir === "dir buy" && q.tgtTip === 'tr.lotsNotionalTip {"amt":"4,000,000"}' && q.totHidden === false && q.tot === 'tr.total≈ 8,000,000TWD'
      && q.ths.includes("tr.colUnit " + JSON.stringify({ label: "tr.col.amount", unit: "tr.lotsUnit" })) && q.ths.includes("tr.colUnit " + JSON.stringify({ label: "tr.col.pos", unit: "tr.lotsUnit" })) && q.grps.length === 0 && !q.units, J(q));
    const n = paint(null);
    ok("沒有報價(離線 / api 錯):目標口數照畫(不靠報價)、title 空;合計「—」、不出倍數,不壞畫面", n.tgt === "1" && n.tgtTip === "" && n.tot === "tr.total—" && !n.totHidden, J(n));
    const f = paint(20000, "USDT", null);
    ok("R2-S2:讀帳失敗(帳戶幣退成 USDT、沒有淨值)→ 合計照標 TWD(口數區的名目),倍數不跨幣別相除(不出)", f.tot === "tr.total≈ 8,000,000TWD" && f.tgt === "1", J(f));
    const m1 = paint(20000, "USDT", null, true), m2 = paint(20000, "TWD", 2000000, true);
    ok("混列(台指期 + 加密)= 兩區:區標題「台指期(口)」與 USDT;沒有匯率(沒登入)→ 合計「—」,不把 TWD 與 USDT 相加",
      m1.tot === "tr.total—" && J(m1.grps.map((g) => g[0])) === J(["tr.grpLots", "USDT"]) && !m1.ths.some((h) => /TWD|USDT|lotsUnit/.test(h)), J(m1));
    ok("混列、綁群益(帳戶幣 TWD):倍數只有一個、接在表底合計後面(口數名目 8,000,000 ÷ 淨值 2,000,000,USDT 列不算);區標題不掛倍數、一列的區不出小計",
      J(m2.grps[0]) === J(["tr.grpLots", "", "", ""]) && J(m2.grps[1]) === J(["USDT", "", "", ""]) && m2.tot === 'tr.total—', J([m2.grps, m2.tot]));
    { ctx.TR_BAGS = { cloud: { st: { cloud: { fx_rates: { USDT: 1, USD: 1, TWD: 32 }, currency: "USD" } } } };
      const m3 = paint(20000, "TWD", 2000000, true);
      ok("混列有匯率:合計換成顯示幣別的 ≈ 整數(8,000,000 ÷ 32 + 500 = 250,500 USD);逐幣別的 title 拿掉(同網頁 63b7b5fe、設計稽核必改 5)",
        m3.tot === 'tr.total≈ 250,500USD' && m3.totTip === "", J(m3));
      delete ctx.TR_BAGS; }
    { /* units spec §9 + §8 金額表綁 Binance:加密 USDT、SOLUSDC、台股 Type C、凍住後才勾的一支 */
      vm.runInContext("TR_TXF.price = null; UNIT = 'USDT'; EQ = 10000", ctx);
      ctx.TR = { env: "local", listLoaded: true, picked: null, sent: null, save: null, edits: {}, bad: {}, sig: {},
        list: [{ name: "btc", displayName: "BTC", hasBacktest: true }, { name: "sol", displayName: "SOL", hasBacktest: true }, { name: "tw", displayName: "TW", hasBacktest: true, portfolio: true },
          { name: "fresh", displayName: "FRESH", hasBacktest: true, symbol: "ETHUSDT" }],
        st: { alive: true, report: { venues: { binance: V }, can_trade_portfolio: true, config: { amounts: { btc: 500, sol: 100, tw: 300000, fresh: 100 } },
          quote_ccy: { btc: "USDT", sol: "USDC", tw: "TWD", fresh: "USDT" }, signals_frozen: { since: 1, pending: ["fresh"] },
          states: { btc: { symbol: "BTCUSDT", position: 1 }, sol: { symbol: "SOLUSDC", market: "spot", position: 0.5 }, tw: { weights: { 2330: 0.5, 2317: 0.49 }, universe: ["2330", "2454", "2317"], market: "spot" } } } } };
      const all = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx));
      const grps = all.filter((n) => n.tag === "tr" && n.className === "grp").map((n) => n.kids.map((k) => k.textContent));
      const rows = all.filter((n) => n.tag === "tr" && n.kids[0] && n.kids[0].className === "key").map((r) => [r.kids[0].kids[0].text, r.kids[1].textContent, r.kids[3].textContent, r.kids[3].className]);
      const by = Object.fromEntries(rows.map((r) => [r[0], r])), tot = all.find((n) => n.className === "pf-total");
      ok("§9.3 綁 Binance:區順序 USDT(帳戶幣)→ USDC → TWD;SOLUSDC 在 USDC 區(不被帳戶幣吃掉);區內照金額排",
        J(grps.map((g) => g[0])) === J(["USDT", "USDC", "TWD"]) && J(rows.map((r) => r[0])) === J(["BTC", "FRESH", "SOL", "TW"]), J([grps, rows]));
      ok("§9.4 區標題:USDT 兩列出小計 600;一列的 USDC、TWD 不出小計;區標題都不掛倍數", J(grps[0]) === J(["USDT", "", "600", ""]) && J(grps[1]) === J(["USDC", "", "", ""]) && J(grps[2]) === J(["TWD", "", "", ""]), J(grps));
      ok("§8.2 Type C 列:標的列 weights ∪ universe 全部成分、持有的排前面(0 權重的 2454 照列、排最後);部位「多 297,000」只算持有的、副行持倉 2 檔", J(by.TW.slice(1)) === J(["2317" + "ak.sep" + "2330" + "ak.sep" + "2454", 'tr.rel.long 297,000tr.typeCHold {"n":2}', "n pos"]), J(by.TW));
      ok("signals_frozen.pending:部位寫 po.hostOld(主機版本較舊,同網頁 a8239131),不畫空手", by.FRESH[2] === "po.hostOld" && /\bna pending\b/.test(by.FRESH[3]), J(by.FRESH));
      ok("§9.7 三區、沒有匯率:合計「—」;倍數照算、接在合計後面——Binance 會下單的 USDT 600 + USDC 100(缺匯率 1:1)÷ 10,000 = 0.07,台股 300,000 不算",
        tot.textContent === 'tr.total—', tot.textContent);
      ctx.TR.st.report.states.tw = undefined; delete ctx.TR.st.report.states.tw;
      const tw2 = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx)).filter((n) => n.tag === "tr" && n.kids[0] && n.kids[0].className === "key")
        .find((r) => r.kids[0].kids[0].text === "TW");
      ok("§8.2 Type C 還沒算過:標的「—」+ tr.typecPending、部位「—」+ tr.sigNotYet(還沒算出成分,同網頁 3b67fa10),不畫空手;quote_ccy 的 TWD 照樣分區", tw2.kids[1].textContent === "—" && tw2.kids[1].title === "tr.typecPending" && tw2.kids[3].textContent === "—" && tw2.kids[3].title === "tr.sigNotYet" && tw2.kids.length === 4);
      // 選擇策略框剛勾進的台股 Type C 草稿(沒存、沒跑過、回報沒有成分):標的列策略檔的 UNIVERSE(Wei 10-16:≤3 全列、>3「等 N 檔」、hover 全列)
      const twItem = ctx.TR.list.find((y) => y.name === "tw"), rowOf = () => flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx)).filter((n) => n.tag === "tr" && n.kids[0] && n.kids[0].className === "key").find((r) => r.kids[0].kids[0].text === "TW");
      twItem.universe = ["2330", "2454", "2317", "2308", "2881"]; const tw3 = rowOf();
      twItem.universe = ["2330", "2454"]; const tw4 = rowOf(); delete twItem.universe;
      ok("§8.2 Type C 草稿(還沒有成分):標的改列策略檔 UNIVERSE——5 檔寫「前 3 檔 等 5 檔」、hover 全列;2 檔直接列;部位照舊「—」", tw3.kids[1].textContent === "tr.typecSymsMore " + J({ list: ["2330", "2454", "2317"].join("ak.sep"), n: 5, k: 2 })
        && tw3.kids[1].title === "tr.typecMembersFlat " + J({ list: ["2330", "2454", "2317", "2308", "2881"].join("ak.sep") }) && tw4.kids[1].textContent === "2330" + "ak.sep" + "2454" && tw3.kids[3].textContent === "—", J([tw3.kids[1], tw4.kids[1]])); }
    // 確認框(spec-0.1.13 #1 的大口數提醒已隨安全檢查拿掉,Wei 10-13;0.1.27 起只列會變的,canon 確認 modal):txf 存著 2 口、訊號 0.5
    const confirm = (price, lots, eq, unit = "TWD") => { paint(price, unit, eq); ctx.TR.edits = { txf: lots }; ctx.BOX = null;
      vm.runInContext("TR = this.TR; trSaveAmounts(trNames(), trBase(), null)", ctx);
      const box = ctx.BOX, all = box ? flat(box.extra) : [];
      return { box, all, rowCls: all.filter((n) => /cf-row/.test(n.className)).map((n) => n.className) }; };
    { const big = confirm(20000, 6, 2000000), fb = confirm(null, 50, 2000000), one = confirm(20000, 4, 100000);
      ok("大口數(6 口、沒報價 50 口):列下面不再多一句、沒有 .has-warn / .cf-warn,確認鈕照常可按",
        [big, fb, one].every((x) => !!x.box && x.box.okDisabled === false && !x.all.some((n) => /cf-warn|has-warn/.test(n.className || ""))), J(big.rowCls));
      ok("#4 確認框口數列:標的表比的是取整後的目標口數(2 口 × 0.5 = 1 → 4 口 × 0.5 = 2),格子只放數字、下方小字商品名 ≈ 名目;沒報價只寫商品名",
        one.all.some((n) => n.tag === "dd" && n.textContent === '1→2tr.txfConfirmRef {"prod":"tr.txfProd.txf","amt":"8,000,000"}' && n.kids[2].className === "n" && n.kids[3].className === "cf-ref")
        && fb.all.some((n) => n.tag === "dd" && n.textContent === "1→25tr.txfProd.txf"), J([one.all.filter((n) => n.tag === "dd").map((n) => n.textContent), fb.all.filter((n) => n.tag === "dd").map((n) => n.textContent)]));
      ok("#4 確認框沒有合計列、沒有淨值倍數、沒有槓桿列(canon:整份金額在框底下的配置表)", ![big, fb, one].some((x) => x.rowCls.some((c) => /\b(total|lev)\b/.test(c))));
      { const same = confirm(20000, 3, 2000000);
        ok("#4 口數改了、取整後目標沒變(2 → 3 口 × 0.5 = 1.5 → 2 口;原本 1 口):目標表列 1 → 2", same.all.some((n) => n.tag === "dd" && /^1→2/.test(n.textContent)), J(same.all.filter((n) => n.tag === "dd").map((n) => n.textContent))); }
      { paint(20000, "TWD", 2000000); ctx.TR.st.report.states.txf.position = 0; ctx.TR.edits = { txf: 5 }; ctx.BOX = null;
        vm.runInContext("TR = this.TR; trSaveAmounts(trNames(), trBase(), null)", ctx);
        const all = flat(ctx.BOX.extra), sub = all.find((n) => n.className === "cf-sub");
        ok("訊號 0、金額改了(目標沒有一檔變):框照開,表改列金額「2 → 5」+ 名目,不是空框", !!sub && /^tr\.cf\.capAmountsOne/.test(sub.textContent) && all.some((n) => n.tag === "dd" && /^2→5tr\.txfConfirmRef/.test(n.textContent)), J(all.filter((n) => n.tag === "dd").map((n) => n.textContent))); }
      { const zero = (rec) => { paint(20000, "TWD", 2000000); if (rec) ctx.TR.st.report.reconciler = { alive: true }; ctx.TR.edits = { txf: 0 }; ctx.BOX = null;
          vm.runInContext("TR = this.TR; trSaveAmounts(trNames(), trBase(), null)", ctx);
          const all = flat(ctx.BOX.extra);
          return { title: ctx.BOX.title, ok: ctx.BOX.ok, mark: ctx.BOX.mark, dds: all.filter((n) => n.tag === "dd").map((n) => n.textContent), zeroed: all.some((n) => n.className === "cf-zeroed"),
            notes: all.filter((n) => n.className === "cf-note").map((n) => n.textContent), firstPending: vm.runInContext("trFirstReadPending(trReport())", ctx) }; };
        const z0 = zero(false), z1 = zero(true);
        ok("#4 口數列改成 0:沒在下單 →「儲存金額」列 1 → 0、不標平倉;改成 0 那句(cf-zeroed)不出",
          z0.title === "tr.cf.title" && z0.dds.some((x) => x === "1→0tr.txfProd.txf") && !z0.zeroed && !z0.notes.length, J(z0));
        // 稽核 v027-a1 B1:群益在下單、第一次讀帳還沒回來——按下去下一輪就平倉,框不能寫「儲存金額」
        ok("#4 口數列改成 0、在下單但第一次讀帳還沒回來:標題與主鈕「儲存並下單」+ 記號;列目標 1 → 0 標平倉;表下一句帳上還沒讀到",
          z1.firstPending === true && z1.title === "tr.cf.titleFire" && z1.ok === "tr.cf.titleFire" && !!z1.mark && z1.dds.some((x) => x === "1→0tr.cfTagClosetr.txfProd.txf")
          && J(z1.notes) === J(["tr.cf.firstRead"]) && !z1.zeroed, J(z1)); } }
    { vm.runInContext("TR_TXF.price = null; UNIT = null; EQ = 5000", ctx);
      ctx.TR = { env: "local", list: [{ name: "btc", displayName: "BTC", hasBacktest: true }], listLoaded: true, picked: null, sent: null, save: null, edits: {}, bad: {}, sig: {},
        st: { alive: true, report: { venues: { myex: { credentials: true, pair: true, order: true, account: true } }, config: { amounts: { btc: 500 } }, states: { btc: { symbol: "BTCUSDT", position: 1 } } } } };
      const all = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx)), tot = all.find((n) => n.className === "pf-total");
      ok("#3 金額表:帳戶幣未知(自訂交易所)→ 單位照列自己的計價(BTCUSDT = USDT,帳戶幣不參與分區),不出倍數;tr.ccyUnknown 那一行退場",
        tot.textContent === "tr.total500USDT" && !all.some((n) => n.className === "pf-foot" && n.textContent === "tr.ccyUnknown")
        && !all.some((n) => /unit-note/.test(n.className)) && !all.some((n) => /null/.test(n.text || "")), tot.textContent); }
    /* 安全檢查拿掉(Wei 10-13):合計列下的倍數提醒、≥10 倍勾選都不再有;淨值倍數只剩合計後面那一個 */
    const levT = (venue, amt) => { vm.runInContext("TR_TXF.price = null; UNIT = 'USDT'; EQ = 10000", ctx); ctx.PAPERV = venue === "paper";
      ctx.TR = { env: "local", list: [{ name: "btc", displayName: "BTC", hasBacktest: true }], listLoaded: true, picked: null, sent: null, save: null, edits: { btc: amt }, bad: {}, sig: {}, reqIds: {},
        st: { alive: true, report: { venues: { [venue]: { credentials: true, pair: true, order: true, account: true } }, config: { amounts: { btc: 100 } }, states: { btc: { symbol: "BTCUSDT", market: "swap", position: 1 } } } } };
      return flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx)); };
    const box = (venue, amt) => { levT(venue, amt); ctx.BOX = null; ctx.DELOK.attrs = {}; vm.runInContext("TR = this.TR; trSaveAmounts(trNames(), trBase(), null)", ctx); return ctx.BOX; };
    { const t12 = levT("okx", 120000), b12 = box("okx", 120000), bp = box("paper", 120000);
      ok("12 倍真錢:金額表沒有 .pf-lev 提醒、合計後面照寫 12.00×;確認框沒有勾選列、儲存不停用、沒有 aria-describedby",
        !t12.some((n) => /pf-lev/.test(n.className || "")) && t12.find((n) => n.className === "pf-total").textContent === 'tr.total120,000USDT'
        && !flat(b12.extra).some((n) => n.className === "cf-ack" || (n.tag === "input" && n.type === "checkbox")) && b12.okDisabled === false && !ctx.DELOK.attrs["aria-describedby"]);
      ok("smallfixes #13 模擬帳戶 12 倍照樣可存:確認鈕不停用、沒有紅字 .cf-block", bp.okDisabled === false && !flat(bp.extra).some((n) => /cf-block/.test(n.className) || / over\b/.test(n.className)));
      // 淨值倍數只剩自動下單 › 部位的合計(trPlanTotal);存金額框 0.1.27 起不列合計與倍數(canon 確認 modal)
      ok("淨值倍數千分位兩位小數(trMultFmt);只剩 trPlanTotal 一處在用", vm.runInContext("trMultFmt(4494.68)", ctx) === "4,494.68"
        && (src.match(/t\("tr\.equityMult", \{ x: trMultFmt\(zt\.mult\) \}\)/g) || []).length === 1 && !/equityMult", \{ x: [^}]*toFixed/.test(src));
      ok("拿掉的字串與 CSS 不留殘骸;tr.lev.binance5 留著(連接框子帳戶說明還在用)", (() => {
        const gone = ["tr.lev.margin", "tr.lev.marginShort", "tr.lev.pctLt1", "tr.lev.loss", "tr.lev.lossPaper", "tr.lev.ack", "tr.txfBigNotional", "tr.txfBigNotional1", "tr.txfBigLots"];
        const po = ["zh", "en"].map((l) => fs.readFileSync(path.join(S, "i18n", l + ".po"), "utf8")), strs = fs.readFileSync(path.join(R, "strings.js"), "utf8");
        const css = fs.readFileSync(path.join(R, "app.css"), "utf8") + fs.readFileSync(path.join(R, "trade.css"), "utf8");
        return gone.every((k) => po.every((p) => !p.includes('msgid "' + k + '"')) && !strs.includes(J(k) + ":") && !src.includes('"' + k + '"'))
          && po.every((p) => p.includes('msgid "tr.lev.binance5"')) && !/\.pf-lev|\.cf-ack|cf-warn|has-warn/.test(css) && !/\b(LEV_T[123]|trLevLevel|trLevPct|trTxfBigWarn)\b/.test(src); })()); }
    { /* 確認框(0.1.27 canon 確認 modal;推翻 A 版的整份全列):BTC 不變、ETH 500 → 800、ADA 300 → 0、SOL 被取消勾選(移出)。
         標的表只列目標有變的(沒在跑「原 → 新」,在跑列要下的單);策略層只剩移出／加入 0／換合約。「移出 · 平倉」只在存完可能下單時(trMayFire) */
      const st4 = (ex) => ({ symbol: ex, position: 1, market: "swap" });
      const cf = (rep, o = {}) => { vm.runInContext("TR_TXF.price = null; UNIT = 'USDT'; EQ = 10000", ctx); ctx.PAPERV = false;
        const amounts = Object.assign({ btc: 1000, eth: 500, ada: 300, sol: 200 }, o.tw ? { tw: 300000 } : {});
        ctx.TR = { env: "local", list: ["btc", "eth", "ada", "sol", "tw"].map((n) => ({ name: n, displayName: n.toUpperCase(), hasBacktest: true })), listLoaded: true, sent: null, save: null, bad: {}, raw: {}, sig: {}, reqIds: {},
          picked: o.keep ? null : new Set(["btc", "eth", "ada"].concat(o.tw ? ["tw"] : [])), edits: o.keep ? {} : Object.assign({ eth: 800, ada: 0 }, o.tw ? { tw: 400000 } : {}), pending: o.pending || null,
          st: { alive: true, report: Object.assign({ venues: { okx: V }, config: { amounts }, quote_ccy: { tw: "TWD" }, last_reconcile: { ts: new Date().toISOString().slice(0, 19), actual: { SOLUSDT: { side: "long", size: 200 } }, target: {}, gates: {} },
            states: { btc: st4("BTCUSDT"), eth: st4("ETHUSDT"), ada: st4("ADAUSDT"), sol: st4("SOLUSDT"), tw: { weights: { 2330: 1 }, market: "spot" } } }, rep) } };
        ctx.BOX = null; vm.runInContext("TR = this.TR; trSaveAmounts(trNames(), trBase(), null)", ctx);
        const rows = ctx.BOX ? flat(ctx.BOX.extra).filter((n) => n.tag === "div" && /^cf-row\b/.test(n.className)) : [];
        return rows.map((r) => [r.kids[0].textContent, r.kids[1].textContent]); };
      const plain = cf({}), byN = (rs, n) => rs.find((r) => r[0] === n) || [];
      ok("不在跑:標的表只列目標有變的(ETHUSDT 500 → 800、ADAUSDT 300 → 0、SOLUSDT 200 → 0),BTC 沒變不列;策略層只剩移出的 SOL;沒有合計列",
        J(plain.map((r) => r[0])) === J(["ADAUSDT", "ETHUSDT", "SOLUSDT", "SOL"]) && byN(plain, "ETHUSDT")[1] === "500→800" && byN(plain, "ADAUSDT")[1] === "300→0" && ctx.BOX.title === "tr.cf.title", J(plain));
      /* 移出那列的平倉標記列舉各狀態:可能下單 = 在跑、重開沒停住、單純 HALT、剛按啟動;不會 = HALT 什麼都不擋的那種、停著、重開停住(含疊 HALT)、沒連交易所 */
      const tagOf = (rep, o) => byN(cf(rep, o), "SOL")[1];
      const FIRE = "200→tr.cfTagRemove · tr.cfTagClose", QUIET = "200→tr.cfTagRemove";
      const cases = [
        ["running", { reconciler: { alive: true } }, null, FIRE, true],
        ["unconfirmed", { reconciler: { alive: false, stopped: { reason: "machine_restart", gated: false } } }, null, FIRE, true],
        ["halted 單純 HALT", { reconciler: { alive: true }, halt: { halted: true, holds_all: false } }, null, FIRE, false],
        ["halted 舊 runtime、使用者暫停", { reconciler: { alive: true }, halt: { halted: true, source: "desktop" } }, null, FIRE, false],
        ["剛按啟動(dead + pending running)", {}, { want: "running" }, FIRE, true],
        ["halted 什麼都不擋(holds_all)", { reconciler: { alive: true }, halt: { halted: true, holds_all: true } }, null, QUIET, false],
        ["halted 舊 runtime、自動來源", { reconciler: { alive: true }, halt: { halted: true, source: "reconciler" } }, null, QUIET, false],
        ["dead", {}, null, QUIET, false],
        ["暫停在途(pending halted)", { reconciler: { alive: false } }, { want: "halted" }, QUIET, false],
        ["重開停住", { reconciler: { alive: false, stopped: { reason: "machine_restart" } } }, null, QUIET, false],
        ["重開停住 + HALT", { reconciler: { alive: false, stopped: { reason: "machine_restart" } }, halt: { halted: true, holds_all: false } }, null, QUIET, false]];
      const bad = cases.filter(([, rep, pend, want]) => tagOf(rep, { pending: pend }) !== want).map(([nm, rep, pend]) => [nm, tagOf(rep, { pending: pend })]);
      ok("移出的平倉標記只在可能下單時(" + cases.length + " 種狀態逐一列舉;不下單時只寫 tr.cfTagRemove)", bad.length === 0, J(bad));
      /* 框的種類:會送單(在跑、重開沒停住、剛按啟動)=「儲存並下單」+ 記號,列要下的單;暫停中一律「儲存金額」不列單(spec §7-2),
         表下沿用 tr.saveWarnHalted;常駐的 tr.saveWarn 退場(canon:不放後果句) */
      const kindOf = (rep, o) => { const rs = cf(rep, o), n = flat(ctx.BOX.extra).find((x) => x.className === "cf-note" && /^tr\.saveWarn/.test(x.text));
        return { title: ctx.BOX.title, mark: ctx.BOX.mark, warn: n ? n.text : null, orders: rs.some((r) => /^tr\.cf\.(buy|sell)/.test(r[0])) }; };
      const kBad = cases.filter(([nm, rep, pend, , fire]) => { const k = kindOf(rep, { pending: pend }), halted = !!(rep.halt && rep.halt.halted) && /^halted/.test(nm) && !pend && !/holds_all|自動來源/.test(nm);
        return fire ? !(k.title === "tr.cf.titleFire" && k.mark === "tr.mode.real" && k.orders && k.warn === null) : !(k.title === "tr.cf.title" && !k.mark && !k.orders && k.warn === (halted ? "tr.saveWarnHalted" : null)); }).map(([nm, rep, pend]) => [nm, kindOf(rep, { pending: pend })]);
      ok("框的種類跟著「按下去會不會送單」(同一組 " + cases.length + " 種狀態);暫停中「儲存金額」+ tr.saveWarnHalted;沒有 tr.saveWarn", kBad.length === 0 && !/"tr\.saveWarn"/.test(src), J(kBad));
      { const rs = cf({ reconciler: { alive: true } });
        ok("在跑:每列「買進／賣出 標的」= 新目標 − 帳上(帳上空的 BTC／ETH 買、移出的 SOL 賣掉帳上 200);沒有價格的加密列照錢寫(不湊數量);賣出排在買進後面",
          J(rs.filter((r) => /^tr\.cf\./.test(r[0]))) === J([["tr.cf.buyBTCUSDT", "1,000 USDT"], ["tr.cf.buyETHUSDT", "800 USDT"], ["tr.cf.sellSOLUSDT", "200 USDT"]]), J(rs)); }
      /* 一律出框(Wei 10-17,推翻 10-13 的「沒連交易所直接存」):沒綁也開;什麼都沒變才直接存;存不進去(雲端壞值)開框講原因 */
      ctx.DIRECT = 0; cf({ venues: {} });
      const noVenue = { box: !!ctx.BOX, direct: ctx.DIRECT, title: ctx.BOX && ctx.BOX.title };
      ctx.DIRECT = 0; cf({}, { keep: true });
      const nothing = { box: !!ctx.BOX, direct: ctx.DIRECT };
      ctx.DIRECT = 0; ctx.TR = { env: "cloud", list: [{ name: "btc", displayName: "BTC", hasBacktest: true }], listLoaded: true, picked: null, sent: null, save: null, edits: {}, bad: {}, raw: {}, sig: {}, reqIds: {}, pending: null,
        st: { alive: true, cloud: {}, report: { venues: {}, config: { amounts: { btc: -5 } }, states: { btc: st4("BTCUSDT") } } } };
      ctx.BOX = null; vm.runInContext("TR = this.TR; trSaveAmounts(trNames(), trBase(), null)", ctx);
      const blockedNoVenue = { box: !!ctx.BOX, direct: ctx.DIRECT, block: !!ctx.BOX && flat(ctx.BOX.extra).some((n) => n.className === "cf-block") };
      ok("沒連交易所也開框(儲存金額);什麼都沒變直接存;沒綁但存不進去(壞值)開框講原因、不送",
        noVenue.box && noVenue.direct === 0 && noVenue.title === "tr.cf.title" && !nothing.box && nothing.direct === 1 && blockedNoVenue.box && blockedNoVenue.direct === 0 && blockedNoVenue.block, J([noVenue, nothing, blockedNoVenue]));
      ok("trMayFire 與 trExecState 同一套狀態:running / unconfirmed / 單純 HALT / 剛按啟動;框的判準 trCfFiring = trMayFire 去掉暫停中", ["running", "unconfirmed"].every((s) => /s === "running" \|\| s === "unconfirmed"/.test(cutF(src, "trMayFire")))
        && /trStartPending\(pending\)/.test(cutF(src, "trMayFire")) && /trMayFire\(S\.st, S\.pending\)/.test(cutF(src, "trSaveAmounts")) && /return trMayFire\(st, pending\) && trExecState\(st\) !== "halted";/.test(cutF(src, "trCfFiring")));
      /* 兩區(USDT 四列 + 台股 Type C 一列 TWD):表頭寫兩個單位、每列數字後面帶自己的單位;不再有區小計與合計 */
      const two = cf({}, { tw: true }), sub = (flat(ctx.BOX.extra).find((n) => n.className === "cf-sub") || {}).textContent;
      ok("兩區:表頭「目標有變的 N 檔(USDT、TWD)」;每列帶自己的單位(單位看撐這檔的策略,不被別支的 TWD 帶走);沒有區標題列與合計", /^tr\.cf\.capChanges \{"n":"\d","ccy":"(USDT、TWD|TWD、USDT)"\}$/.test(sub || "")
        && byN(two, "ETHUSDT")[1] === "500→800USDT" && byN(two, "2330")[1] === "300,000→400,000TWD" && !flat(ctx.BOX.extra).some((n) => /\bcf-row (grp|total)\b/.test(n.className)), J([sub, two])); }
    { // 稽核 audit-0.1.13-web S1:打「15OO」沒有 blur 就按儲存 → 先把每一格重驗一次,有錯就不開確認框、不送前綴值 15
      vm.runInContext("UNIT = 'USDT'; EQ = 10000", ctx);
      ctx.TR = { env: "local", list: [{ name: "btc", displayName: "BTC", hasBacktest: true }], listLoaded: true, picked: null, sent: null, save: null, edits: {}, bad: {}, sig: {}, reqIds: {},
        st: { alive: true, report: { venues: { okx: { credentials: true, pair: true, order: true, account: true } }, config: { amounts: { btc: 1000 } }, states: { btc: { symbol: "BTCUSDT", market: "swap", position: 1 } } } } };
      const all = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx));
      const inp = all.find((n) => n.tag === "input" && n.className === "amt-in");
      inp.value = "15"; inp.on.input(); inp.value = "15OO"; inp.on.input(); ctx.BOX = null;
      const sv = flat(all[0]).find((n) => n.className === "btn-fill" && n.dataset.fk === "save"); sv.on.click();   // 改了才有儲存鈕(沒改時那一格是「去啟動」)
      ok("稽核 S1:沒有 blur 直接按儲存 → 重驗所有格子,15OO 標紅、不開確認框(不送 15)", ctx.BOX === null && ctx.TR.bad.btc === true && inp.attrs["aria-invalid"] === "true");
      inp.value = "1,500"; inp.on.input(); sv.on.click();
      ok("稽核 S1:改成看得懂的值再按 → 開確認框、送 1,500(列上寫 1,000 → 1,500)", !!ctx.BOX && flat(ctx.BOX.extra).some((n) => n.tag === "dd" && n.textContent === "1,000→1,500")); }
    { // 設計稽核 B7 / 稽核建議 1:報告重畫不吃掉打到一半或打錯的字——「2.9」不會被換回上一個合法值「2」
      const mk = () => { const all = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx));
        return { inp: all.find((n) => n.tag === "input" && n.className === "amt-in"), sv: all.find((n) => n.className === "btn-fill") }; };
      ctx.TR = { env: "local", list: [{ name: "btc", displayName: "BTC", hasBacktest: true }], listLoaded: true, picked: null, sent: null, save: null, edits: {}, bad: {}, raw: {}, sig: {}, reqIds: {},
        st: { alive: true, report: { venues: { okx: { credentials: true, pair: true, order: true, account: true } }, config: { amounts: { btc: 1000 } }, states: { btc: { symbol: "BTCUSDT", market: "swap", position: 1 } } } } };
      let a = mk(); a.inp.value = "2"; a.inp.on.input(); a.inp.value = "2.9x"; a.inp.on.input();
      let b = mk();
      ok("B7 打到一半(沒離開欄位)被重畫:格子留著原字「2.9x」,不換回 2", b.inp.value === "2.9x" && !ctx.TR.bad.btc, b.inp.value);
      b.inp.on.blur(); const c = mk();
      ok("B7 打錯、已標紅之後重畫:原字與紅字都留著;按儲存擋下", c.inp.value === "2.9x" && ctx.TR.bad.btc === true && c.inp.attrs["aria-invalid"] === "true" && (ctx.BOX = null, c.sv.on.click(), ctx.BOX === null));
      c.inp.value = "1,200"; c.inp.on.input(); c.inp.on.blur(); const d = mk();
      ok("B7 改成合法值、離開欄位 → 原字清掉,重畫顯示正規化後的值", d.inp.value === "1,200" && !ctx.TR.bad.btc && !("btc" in ctx.TR.raw)); }
    ctx.PAPERV = false;
    { paint(20000, null, 2000000, true); ctx.TR.edits = { txf: 4, btc: 600 }; ctx.BOX = null; vm.runInContext("TR = this.TR; trSaveAmounts(trNames(), trBase(), null)", ctx);
      const all = flat(ctx.BOX.extra), sub = (all.find((n) => n.className === "cf-sub") || {}).textContent || "";
      ok("#3 帳戶幣未知 + 一般列:表頭寫兩個單位(口、USDT),口數列寫口數＋商品名、一般列數字後面帶 USDT;tr.ccyUnknown 退場", /"ccy":"(tr\.lotsUnit、USDT|USDT、tr\.lotsUnit)"/.test(sub)
        && !all.some((n) => n.className === "cf-note" && n.textContent === "tr.ccyUnknown")
        && all.some((n) => n.tag === "dd" && n.textContent === "500→600USDT") && !all.some((n) => /null/.test(n.textContent || "")), J([sub, all.filter((n) => n.tag === "dd").map((n) => n.textContent)])); } }
  ok("金額表用 trZoneSum(分區、合計);口數小字 TWD 寫死在 tr.txfConfirmRef(名目本來就是台幣)",
    /const zt = trZoneSum\(am, eq\)/.test(cutF(src, "trAmountTable")) && /^const TR_TXF_CCY = "TWD";$/m.test(src)
    && fs.readFileSync(path.join(R, "strings.js"), "utf8").includes('"tr.txfConfirmRef": "{prod} ≈ {amt} TWD"'));

  done = true; console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
})();
