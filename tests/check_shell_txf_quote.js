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
    const mk = node; const node2 = (tag) => { const n = mk(tag); n.classList = { toggle() {}, add(c) { n.className += " " + c; } }; n.on = {}; n.addEventListener = (e, f) => { n.on[e] = f; }; return n; };
    const flat = (n, out = []) => { if (n && n.tag) { out.push(n); n.kids.forEach((k) => flat(k, out)); } return out; };
    const ctx = vm.createContext({ document: { createElement: node2, createDocumentFragment: () => node("#frag") }, Date, Math, JSON, Array, Object, Number, String, Set, isFinite, console,
      $: (id) => (id === "del-ok" ? ctx.DELOK : null), DELOK: { attrs: {}, disabled: false, setAttribute(k, v) { this.attrs[k] = v; } },
      t: (k, o) => k + (o ? " " + JSON.stringify(o) : ""), LANG: "zh", PAPER: "paper", BINANCE: "binance", CX_VENUES: {}, srSay() {}, trIsPaper: () => ctx.PAPERV === true, UNIT: "TWD", EQ: 2000000,
      confirmBox(o) { ctx.BOX = o; }, trCloudBox: (o) => o, trCcy: () => "TWD" });
    vm.runInContext("function trUnit() { return UNIT; } function trEquity() { return EQ; }", ctx);
    vm.runInContext(pure.replace(/^const /gm, "var ") + "\nvar trTipSeq = 0;\n"
      + ["trEl", "trSec", "trTipLabel", "trHead", "trFmt", "trMoneyInto", "trReport", "trStored", "trBase", "trNamesOf", "trNames", "trListNames", "trDisplay", "trPickOff", "trPickBtn", "trVenueId", "trVenueLabel",
        "trStratName", "trTxfWant", "trRowTxf", "trRowIsLot", "trRowMoney", "trAmountTable", "trSaveAmounts"].map((n) => cutF(src, n)).join("\n"), ctx);
    const V = { credentials: true, pair: true, order: true, account: true };
    const paint = (price, unit = "TWD", eq = 2000000, mixed = false) => {
      vm.runInContext("TR_TXF.price = " + J(price) + "; UNIT = " + J(unit) + "; EQ = " + J(eq), ctx);
      ctx.TR = { env: "cloud", list: [{ name: "txf", displayName: "TXF", hasBacktest: true }].concat(mixed ? [{ name: "btc", displayName: "BTC", hasBacktest: true }] : []), listLoaded: true, picked: null, sent: null, save: null, edits: {}, bad: {}, sig: {},
        st: { alive: true, report: { venues: { capital: V }, config: { amounts: Object.assign({ txf: 2 }, mixed ? { btc: 500 } : {}) },
          states: Object.assign({ txf: { symbol: "TXF", position: 0.5 } }, mixed ? { btc: { symbol: "BTCUSDT", position: 1 } } : {}) } } };
      const all = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx));
      const row = all.find((n) => n.tag === "tr" && n.kids[0] && n.kids[0].className === "key"), tot = all.find((n) => n.className === "pf-total");
      const note = all.find((n) => n.className === "pf-foot unit-note");
      return { tgt: row.kids[4].textContent, tot: tot.textContent, note: note ? note.textContent : null };
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
      m1.tot === "tr.total—" && m2.tot === "tr.total8,000,500TWD·tr.ofEquity4.00x" && m3.tot === "tr.total8,000,000TWD", J([m1.tot, m2.tot, m3.tot]));
    /* spec-0.1.13 #1:確認框口數列太大時那一列下面多一句(不擋)。沒改過的舊列(edits 空,照 stored 送)也要檢查 */
    const confirm = (price, lots, eq, unit = "TWD") => { paint(price, unit, eq); ctx.TR.st.report.config.amounts.txf = lots; ctx.BOX = null;
      vm.runInContext("TR = this.TR; trSaveAmounts(trNames(), trBase(), null)", ctx);
      const box = ctx.BOX, all = box ? flat(box.extra) : [], w = all.filter((n) => n.tag === "dd" && /cf-warn/.test(n.className));
      return { box, warn: w.map((n) => n.textContent), rowCls: all.filter((n) => /cf-row/.test(n.className)).map((n) => n.className) }; };
    { const big = confirm(20000, 3, 2000000), ok2 = confirm(20000, 2, 2000000), fb = confirm(null, 50, 2000000), fb2 = confirm(null, 49, 2000000), one = confirm(20000, 1, 100000);
      ok("#1 有報價:3 口大台 = 1,200 萬 TWD > 5 × 200 萬淨值 → 那一列下面一句 tr.txfBigNotional(6 倍);2 口(4 倍)不出",
        J(big.warn) === J(['tr.txfBigNotional {"lots":"3","prod":"tr.txfProd.txf","amt":"12,000,000","x":"6.00"}']) && big.rowCls.includes("cf-row has-warn") && J(ok2.warn) === "[]", J([big.warn, ok2.warn]));
      { const css = fs.readFileSync(path.join(R, "app.css"), "utf8"), dd = flat(big.box.extra).find((n) => n.tag === "dd" && /cf-warn/.test(n.className));
        ok("#1 樣式:灰記號 + ink-2,不用紅字的 .cf-block", !!dd && dd.kids[0].className === "fault-mark" && dd.kids[0].attrs["aria-hidden"] === "true" && !/cf-block/.test(dd.className)
          && /\.cf-row dd\.cf-warn \{[^}]*color: var\(--ink-2\);/.test(css) && /\.cf-row dd\.cf-warn \.fault-mark \{ background: var\(--ink-3\); \}/.test(css)); }
      ok("#1 不擋:確認鈕照常可按(okDisabled 不受影響)",!!big.box && big.box.okDisabled === false && !!fb.box && fb.box.okDisabled === false);
      ok("#1 沒有報價 → 退回口數:大台 50 口出 tr.txfBigLots、49 口不出", J(fb.warn) === J(['tr.txfBigLots {"lots":"50","prod":"tr.txfProd.txf"}']) && J(fb2.warn) === "[]", J([fb.warn, fb2.warn]));
      ok("#1 + #4:1 口也可能超過(淨值很小),en 用單數那一句 tr.txfBigNotional1;確認框那一列用 tr.txfConfirm1", one.warn.length === 1 && /^tr\.txfBigNotional1 /.test(one.warn[0])
        && flat(one.box.extra).some((n) => n.tag === "dd" && /^tr\.txfConfirm1 /.test(n.textContent)), J(one.warn)); }
    { vm.runInContext("TR_TXF.price = null; UNIT = null; EQ = 5000", ctx);
      ctx.TR = { env: "local", list: [{ name: "btc", displayName: "BTC", hasBacktest: true }], listLoaded: true, picked: null, sent: null, save: null, edits: {}, bad: {}, sig: {},
        st: { alive: true, report: { venues: { myex: { credentials: true, pair: true, order: true, account: true } }, config: { amounts: { btc: 500 } }, states: { btc: { symbol: "BTCUSDT", position: 1 } } } } };
      const all = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx)), tot = all.find((n) => n.className === "pf-total");
      ok("#3 金額表:帳戶幣未知 → 合計不帶幣別、不出倍數,「金額單位」那一行換成 tr.ccyUnknown", tot.textContent === "tr.total500" && all.some((n) => n.className === "pf-foot" && n.textContent === "tr.ccyUnknown")
        && !all.some((n) => n.className === "pf-foot unit-note") && !all.some((n) => /null/.test(n.text || "")), tot.textContent); }
    /* ux-order-1-4-5 §1:合計列下的倍數提醒(淨值 10,000;8,500 / 24,000 / 62,000 / 120,000 = 0 / 1 / 2 / 3 級),只在有未存改動時;第 3 級確認框要勾 */
    const levT = (venue, amt, o = {}) => { vm.runInContext("TR_TXF.price = null; UNIT = 'USDT'; EQ = 10000", ctx); ctx.PAPERV = venue === "paper";
      ctx.TR = { env: "local", list: [{ name: "btc", displayName: "BTC", hasBacktest: true }], listLoaded: true, picked: null, sent: null, save: o.save || null, edits: o.saved ? {} : { btc: amt }, bad: {}, sig: {}, reqIds: {},
        st: { alive: true, report: { venues: { [venue]: { credentials: true, pair: true, order: true, account: true } }, config: { amounts: { btc: o.saved ? amt : 100 } }, states: { btc: { symbol: "BTCUSDT", market: o.market || "swap", position: 1 } } } } };
      const all = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx)), lev = all.find((n) => n.className === "pf-lev");
      return { hidden: lev.hidden, text: lev.hidden ? [] : flat(lev).filter((n) => n.tag === "span" && n.text || n.className === "pf-lev-sub").map((n) => n.text) }; };
    { const r0 = levT("okx", 8500), r1 = levT("okx", 24000), r2 = levT("okx", 62000), r3 = levT("okx", 120000);
      ok("ux §1.2 真錢:≤1 倍不出;1–5 倍一句 tr.lev.margin(L = ⌈N⌉);5 倍起灰記號 + tr.lev.loss(p = ⌊100 ÷ N⌋)+ tr.lev.marginShort",
        r0.hidden && J(r1.text) === J(['tr.lev.margin {"L":3}']) && J(r2.text) === J(['tr.lev.loss {"p":16}', 'tr.lev.marginShort {"L":7}']) && J(r3.text) === J(['tr.lev.loss {"p":8}', 'tr.lev.marginShort {"L":12}']), J([r0, r1, r2, r3]));
      ok("ux §1.2 只在有未存改動時:存好的同一組金額(沒有 edits)不出;剛存好(saved)也不出", levT("okx", 62000, { saved: true }).hidden && levT("okx", 62000, { save: "saved" }).hidden);
      ok("ux §1.2 全是現貨:不出槓桿那一句,後果句照出", J(levT("okx", 62000, { market: "spot" }).text) === J(['tr.lev.loss {"p":16}']) && levT("okx", 24000, { market: "spot" }).hidden);
      ok("ux §1.2 Binance 且 L > 5:槓桿那一句後面接 tr.lev.binance5;L ≤ 5 不接", J(levT("binance", 62000).text) === J(['tr.lev.loss {"p":16}', 'tr.lev.marginShort {"L":7}tr.lev.binance5']) && J(levT("binance", 24000).text) === J(['tr.lev.margin {"L":3}']));
      ok("ux §1.4 模擬帳戶:1–5 倍不出;5 倍起只出 tr.lev.lossPaper,沒有槓桿那一句", levT("paper", 24000).hidden && J(levT("paper", 62000).text) === J(['tr.lev.lossPaper {"p":16}']));
      const box = (venue, amt) => { levT(venue, amt); ctx.BOX = null; ctx.DELOK.attrs = {}; vm.runInContext("TR = this.TR; trSaveAmounts(trNames(), trBase(), null)", ctx); return ctx.BOX; };
      const b2 = box("okx", 62000), bp = box("paper", 120000);
      { const b = box("okx", 120000), c = flat(b.extra).find((n) => n.tag === "input" && n.type === "checkbox"), lbl = flat(b.extra).find((n) => n.className === "cf-ack");
        const said = ctx.DELOK.attrs["aria-describedby"]; c.checked = true; c.on.change(); const on = ctx.DELOK.disabled; c.checked = false; c.on.change();
        ok("ux §1.2 第 3 級:勾選框是真 checkbox 包在 label.cf-ack 裡、字 tr.lev.ack(p);儲存停用、指到那一句;勾了放行、取消又停", !!lbl && b.okDisabled === true && said === "cf-ack-t" && on === false && ctx.DELOK.disabled === true
          && flat(lbl).some((n) => n.text === 'tr.lev.ack {"p":8}'), J([said, on])); }
      ok("ux §1.2 第 2 級與模擬帳戶 12 倍:沒有勾選列", !flat(b2.extra).some((n) => n.className === "cf-ack") && !flat(bp.extra).some((n) => n.className === "cf-ack"));
      ok("smallfixes #13 模擬帳戶 12 倍照樣可存:確認鈕不停用、沒有紅字 .cf-block、槓桿列不上 .over", bp.okDisabled === false && !flat(bp.extra).some((n) => /cf-block/.test(n.className) || / over\b/.test(n.className))); }
    { // 設計稽核 M5:原本 > 0、這次改成 0 的那支,確認框在金額列與合計之間講一次(不用紅);沒改成 0 的不出
      levT("okx", 0); ctx.BOX = null; vm.runInContext("TR = this.TR; trSaveAmounts(trNames(), trBase(), null)", ctx);
      const z = flat(ctx.BOX.extra).find((n) => n.className === "cf-zeroed"), dls = ctx.BOX.extra.kids.filter((n) => n.tag === "dl");
      levT("okx", 500); ctx.BOX = null; vm.runInContext("TR = this.TR; trSaveAmounts(trNames(), trBase(), null)", ctx);
      ok("設計稽核 M5:改成 0 的列講 tr.saveZeroed(名字),合計另起一個 dl 接在它後面;沒改成 0 不出", !!z && z.textContent === 'tr.saveZeroed {"names":"BTC"}' && dls.length === 2
        && !flat(ctx.BOX.extra).some((n) => n.className === "cf-zeroed"), z && z.textContent); }
    { // 稽核 audit-0.1.13-web S1:打「15OO」沒有 blur 就按儲存 → 先把每一格重驗一次,有錯就不開確認框、不送前綴值 15
      vm.runInContext("UNIT = 'USDT'; EQ = 10000", ctx);
      ctx.TR = { env: "local", list: [{ name: "btc", displayName: "BTC", hasBacktest: true }], listLoaded: true, picked: null, sent: null, save: null, edits: {}, bad: {}, sig: {}, reqIds: {},
        st: { alive: true, report: { venues: { okx: { credentials: true, pair: true, order: true, account: true } }, config: { amounts: { btc: 1000 } }, states: { btc: { symbol: "BTCUSDT", market: "swap", position: 1 } } } } };
      const all = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx));
      const inp = all.find((n) => n.tag === "input" && n.className === "amt-in"), sv = all.find((n) => n.className === "btn-fill");
      inp.value = "15"; inp.on.input(); inp.value = "15OO"; inp.on.input(); ctx.BOX = null; sv.on.click();
      ok("稽核 S1:沒有 blur 直接按儲存 → 重驗所有格子,15OO 標紅、不開確認框(不送 15)", ctx.BOX === null && ctx.TR.bad.btc === true && inp.attrs["aria-invalid"] === "true");
      inp.value = "1,500"; inp.on.input(); sv.on.click();
      ok("稽核 S1:改成看得懂的值再按 → 開確認框、送 1,500", !!ctx.BOX && flat(ctx.BOX.extra).some((n) => n.tag === "dd" && /^1,500/.test(n.textContent || ""))); }
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
    { paint(20000, null, 2000000, true); ctx.BOX = null; vm.runInContext("TR = this.TR; trSaveAmounts(trNames(), trBase(), null)", ctx);
      const all = flat(ctx.BOX.extra);
      ok("#3 帳戶幣未知 + 一般列:確認框列 tr.ccyUnknown、一般列的數字不帶幣別", all.some((n) => n.className === "cf-note" && n.textContent === "tr.ccyUnknown")
        && all.some((n) => n.tag === "dd" && n.textContent === "500") && !all.some((n) => /null/.test(n.textContent || "")), J(all.filter((n) => n.tag === "dd").map((n) => n.textContent))); } }
  ok("確認框:有報價時口數列寫「N 口商品(≈ M TWD)」(tr.txfConfirm),沒有才只列口數",
    /m == null \? t\(trLotsKey\(v, "tr\.txfConfirmNoQuote", "tr\.txfConfirmNoQuote1"\), q\) : t\(trLotsKey\(v, "tr\.txfConfirm", "tr\.txfConfirm1"\), \{ \.\.\.q, amt: trFmt\(Math\.round\(m\)\) \}\)/.test(cutF(src, "trSaveAmounts"))
    && /m = trTxfRefMoney\(sp, v, trTxfPrice\(\)\)/.test(cutF(src, "trSaveAmounts")));
  ok("R2-S2 確認框:合計跟表下同一支 trTotals(幣別、混列「—」、倍數同規則);txfConfirm 的「≈ M TWD」本來就寫死",
    /tt = trTotals\(sending, eq, trRowMoney, trRowIsLot, trUnit\(\)\)/.test(cutF(src, "trSaveAmounts"))
    && /money\(tt\.total, tt\.ccy\)/.test(cutF(src, "trSaveAmounts")) && /^const TR_TXF_CCY = "TWD";$/m.test(src)
    && fs.readFileSync(path.join(R, "strings.js"), "utf8").includes('"tr.txfConfirm": "{lots} 口{prod}（≈ {amt} TWD）"'));

  done = true; console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
})();
