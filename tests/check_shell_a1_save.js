// 「加到策略組合」＋存金額確認框(spec tw-holdings-a1-save-preview §1-3、§2.2、§5、§7;canon design-system › 確認 modal)。
// 從 trade.js／portfolio.js 原文切出真的 trSaveAmounts／trCfRows／poAdd 跑在假 DOM 上,主機那一端是記錄 tradeSend 的假 api。不起 Electron。
//   ① 出框判準與框的兩種樣子:會送單(在跑)×不送單 × 有無同檔重疊 × 預覽到／沒到;暫停中一律「儲存金額」;什麼都沒變才直接存
//   ② F3 既有分支各一條:模擬交易台股往上加擋、雲端 hidden／badStored、換合約列(合約平倉標＋名目＋兩步存)、口數留空、匯率舊、暫停句、移出列
//   ③ §5 邊界:CODE_CHANGED、BUSY、逾時、signals_frozen、舊主機、只改金額、移出
//   ④ A1 鈕:沒回測不出、不在組合填色、在組合描邊;按了只建草稿、不寫設定,沒有最新預覽才送 stats_refresh;草稿存成功記 po_add_saved
// 跑法:node tests/check_shell_a1_save.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "trade.js"), "utf8"), psrc = fs.readFileSync(path.join(R, "portfolio.js"), "utf8");
const S0 = (() => { const raw = fs.readFileSync(path.join(R, "strings.js"), "utf8"); return (0, eval)("(" + raw.slice(raw.indexOf("{", raw.indexOf("const STRINGS")), raw.lastIndexOf("}") + 1) + ")"); })();
let red = 0; const ok = (name, c, info) => { console.log((c ? "PASS  " : "FAIL  ") + name + (c || !info ? "" : "\n      " + info)); if (!c) red++; };
const J = JSON.stringify;
const block = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b); if (i < 0 || j < 0) throw new Error("找不到標記:" + a); return src.slice(i, j); };
const cutF = (n, s0) => { const s = s0 || src, i = s.indexOf("function " + n + "("); if (i < 0) throw new Error("no " + n); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return (s.slice(i - 6, i) === "async " ? "async " : "") + s.slice(i, k + 1); } throw new Error("no " + n); };

const node = (tag) => { const n = { tag, id: "", className: "", kids: [], text: "", attrs: {}, hidden: false, disabled: false, value: "", parentNode: null, dataset: {}, title: "", on: {},
  classList: { toggle() {}, add(c) { n.className += " " + c; }, remove() {}, contains: () => false }, appendChild(c) { if (c && typeof c === "object") c.parentNode = n; n.kids.push(c); return c; },
  append(...c) { c.forEach((x) => n.appendChild(x)); }, insertAdjacentElement() {}, remove() {}, insertBefore(c) { n.kids.push(c); return c; }, focus() {},
  querySelector() { return { title: "" }; }, setAttribute(k, v) { n.attrs[k] = v; }, removeAttribute(k) { delete n.attrs[k]; }, addEventListener(e, f) { n.on[e] = f; },
  get nextSibling() { return null; }, get textContent() { return n.text + n.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }, set textContent(v) { n.text = v; n.kids = []; } }; return n; };
const flat = (n, out = []) => { if (n && n.tag) { out.push(n); n.kids.forEach((k) => flat(k, out)); } return out; };

const sends = [], feats = [];
let GEN = 0;
const DOM = { "del-title": node("h6"), "del-ok": node("button"), "del-mark": node("span"), "del-scrim": node("div"), "po-cfg": { querySelectorAll: () => [] }, "po-h": node("h5"), "rp": node("div") };
const ctx = vm.createContext({ document: { createElement: node, createElementNS: (_ns, tag) => node(tag), createDocumentFragment: () => node("#frag") }, Date, Math, JSON, Array, Object, Number, String, Set, Promise, isFinite, console, setTimeout, clearTimeout,
  $: (id) => DOM[id] || { focus() {}, hidden: false }, t: (k, o) => k + (o ? " " + JSON.stringify(o) : ""), LANG: "zh", PAPER: "paper", BINANCE: "binance", CX_VENUES: { binance: { label: "Binance" } },
  srSay() {}, trackFeature(n) { feats.push(n); }, trPollSoon() {}, envPaintLocalDots() {}, ENV: { sig: {}, cur: "local" }, psClose() {}, psRefocus() {}, mgSetMembers() {}, poPaintCfg() {},
  confirmBox(o) { ctx.BOX = o; ctx.delCtx = { box: o }; DOM["del-scrim"].hidden = false; }, trCloudBox: (o) => o, TR_STALE_MS: 600000, ENV_JUST_MS: 300000, delCtx: null });
vm.runInContext("function trUnit() { return 'USDT'; } function trCcy() { return 'USDT'; } function trEquity() { return 10000; }", ctx);
const pure = block("/* ── 純邏輯(", "/* ── 純邏輯到此") + block("/* ── 視角純邏輯(", "/* ── 視角純邏輯到此");
const consts = (src.match(/^const TR_CF = [^\n]*\n/m) || [""])[0].replace(/^const /, "var ");
vm.runInContext(pure.replace(/^const /gm, "var ") + "\n" + consts + "var trTipSeq = 0, psMode = 'amounts', psToAmt = false;\n" + ["trEl", "trFmt", "trFmt2", "trFmtPrice", "trReport", "trContracts", "trStored", "trBase", "trNamesOf", "trNames",
  "trListNames", "trDisplay", "trPickOff", "trVenueId", "trVenueLabel", "trVenueKind", "trTwBroker", "trTwNamesWant", "trTwName", "trTxfWant", "trRowTxf", "trRowTxfNew", "trCtPend", "trCtStored", "trCt", "trCtGate", "trCtDirty",
  "trRowMoneyStored", "trCtPayload", "trRowIsLot", "trRowMoney", "trLotsFmt", "trLotsTgtFmt", "trQuoteMap", "trNoSignalYet", "trZoneOf", "trZoneLabel", "trZoneUnit", "trFxView", "trZoneSum", "trTotalText",
  "trCloseTag", "trStratHeld", "trPaperTwOk", "trPaperTw", "trCtCloseTag", "trSaveAmounts", "trLivePositions", "trBook", "poPartStates", "trTxfPrice", "trGateSide", "trTradesSym", "trSentBeforeOf", "trWith", "trIsPaper",
  "trCfStates", "trCfHolds", "trCfAsof", "trMarks", "trCfQty", "trCfFlat", "trCfLongOnly", "trCfRows", "trCfTick", "trCfMD", "trPvRequest", "trManualPart", "trPosDetail", "trTwClosedKeys"].map((n) => cutF(n)).join("\n")
  + "\n" + ["poAddBtn", "poAdd"].map((n) => cutF(n, psrc)).join("\n"), ctx);

// 台股時段照牆上時鐘會讓結果隨星期幾變:預設開盤,休市那組(F15)自己切 TW_OPEN = false
vm.runInContext("var TW_OPEN = true, trTwSessionOpenReal = trTwSessionOpen; trTwSessionOpen = function (ms, day) { return TW_OPEN; };", ctx);
const V = { credentials: true, pair: true, order: true, account: true };
const now = Math.floor(Date.now() / 1000), BAR = now - 3600;
// 已存:btc 500(BTCUSDT 多 1)、tw 100000(台股 2330 多 1)。新策略 n5:台股等權 2330／2454(重疊 2330)或 2603／2382(不重疊)
const pv5 = (ov, extra) => Object.assign({ type: "portfolio", market: "spot", weights: ov ? { "2330": 0.5, "2454": 0.5 } : { "2603": 0.5, "2382": 0.5 },
  closes: ov ? { "2330": 1000, "2454": 1300 } : { "2603": 190, "2382": 290 }, bar_at: BAR, bar_date: "2026-10-16", latest: true, daily_tw: true }, extra || {});
function bag(o) {
  o = o || {};
  const venues = o.firing || o.halted ? (o.paper ? { paper: V } : { binance: V }) : {};
  const r = { venues, config: { amounts: Object.assign({ btc: 500, tw: 100000 }, o.amounts || {}) }, quote_ccy: { btc: "USDT", tw: "TWD", n5: "TWD" }, last_reconcile: o.firing || o.halted ? { ts: new Date(now * 1000).toISOString().slice(0, 19), actual: {}, target: {}, gates: {} } : null,
    states: Object.assign({ btc: { symbol: "BTCUSDT", position: 1 }, tw: { symbol: "2330", position: 1, market: "spot" } }, o.states || {}),
    account: { read_at: now, venues: o.firing || o.halted ? { [o.paper ? "paper" : "binance"]: { ok: true, equity: 10000, currency: "USDT", positions: { BTCUSDT: { side: "long", size: 500, mark_price: 50000 } } } } : {} },
    reconciler: { alive: true }, can_trade_portfolio: true, can_paper_twstock: true, backtest_previews: o.oldHost ? undefined : Object.assign(o.noPv ? {} : { n5: pv5(o.ov !== false, o.pv) }, o.pvs || {}) };
  if (o.oldHost) delete r.backtest_previews;
  if (o.halted) r.halt = { halted: true };
  if (o.frozen) r.signals_frozen = { since: now, pending: o.frozen };
  Object.assign(r, o.rep || {});
  const S = { env: o.env || "local", open: true, view: "po", listLoaded: true, picked: o.picked ? new Set(o.picked) : null, sent: null, save: null, saveErr: null, edits: Object.assign({}, o.edits || {}), bad: {}, raw: Object.assign({}, o.raw || {}), sig: {}, reqIds: {}, reqFor: {},
    ct: { edits: {}, basis: {}, sent: null }, just: { picked: {}, removed: {} }, flash: {}, pending: null, pvReq: o.pvReq || {},
    list: [{ name: "btc", displayName: "BTC", hasBacktest: true, symbol: "BTCUSDT", market: "swap" }, { name: "tw", displayName: "TW", hasBacktest: true, symbol: "2330", market: "spot", twd: true, twdAll: true },
      { name: "n5", displayName: "N5", hasBacktest: true, symbol: null, portfolio: true, market: "spot", twd: true, twdAll: true, universe: ["2330", "2454"] }].concat(o.list || []),
    st: { alive: true, report: r } };
  const gen = ++GEN;   // 上一個情境排在微任務裡的送出不算進這一個
  S.api = { tradeSend: async (cmd, args) => { if (gen === GEN) sends.push({ cmd, args: JSON.parse(J(args)) }); if (cmd === "amounts") r.config.amounts = Object.assign({}, args.amounts);
    return cmd === "stats_refresh" ? { ok: true, result: o.ack || { started: args.names, skipped: {} } } : { ok: true }; }, tradeStatus: async () => S.st };
  ctx.TR = S; ctx.TR_BAGS = { local: S, cloud: S }; vm.runInContext("TR = this.TR; TR_BAGS = this.TR_BAGS;", ctx);
  sends.length = 0; feats.length = 0; ctx.BOX = null; ctx.delCtx = null;
  return S;
}
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
// 開框;回 { title, ok, mark, okDisabled, rows: [文字…], notes: [{cls,text}], direct }
function open(S) {
  vm.runInContext("trSaveAmounts(trNames(), trBase(), null)", ctx);
  const b = ctx.BOX; if (!b) return { direct: true };
  const all = flat(b.extra), rows = all.filter((n) => /^cf-row( |$)/.test(n.className)).map((n) => n.textContent);
  const f = { title: b.title, ok: b.ok, mark: b.mark, okDisabled: !!b.okDisabled, rows, cap: (all.find((n) => n.className === "cf-sub") || {}).textContent || "", wait: all.some((n) => n.className === "cf-wait"),
    notes: all.filter((n) => /^cf-(note|block|zeroed)$/.test(n.className)).map((n) => n.className + ":" + n.textContent) };
  Object.defineProperty(f, "box", { value: b, enumerable: false }); return f;
}
const draft = (o) => Object.assign({ picked: ["btc", "tw", "n5"], edits: { n5: 200000 } }, o || {});

(async () => {
  // ── ① 不在跑:儲存金額;預覽到,列目標有變的標的
  { bag(draft()); const f = open();
    ok("① 不在跑+重疊+預覽到:標題「儲存金額」、主鈕「儲存」、無記號;表頭「目標有變的 N 檔(TWD)」帶收盤日",
      f.title === "tr.cf.title" && f.ok === "tr.save" && !f.mark && /^tr\.cf\.capChanges \{"n":"2","ccy":"TWD"\}，tr\.cf\.asofClose \{"d":"\d\d\/\d\d"\}$/.test(f.cap), J(f));
    ok("① …2330 原 → 新(100,000 → 200,000)、下面一行股數 200 股(200,000 ÷ 1,000);新標的 2454 只寫新值與 76 股(100,000 ÷ 1,300 捨去)",
      f.rows.some((x) => /^2330100,000→200,000200 tr\.cf\.unitShares$/.test(x)) && f.rows.some((x) => /^2454100,00076 tr\.cf\.unitShares$/.test(x)) && f.rows.length === 2, J(f.rows));
    ok("① …框底沒有否定句、沒有常駐後果句", f.notes.length === 0, J(f.notes)); }
  // 稽核 571a664 P2:草稿的預覽帶未還原收盤(raw_closes,runtime 1.1.134)時用它換股數,不用還原價(2330 200,000 ÷ 1,250 = 160 股、2454 100,000 ÷ 1,480 = 67 股)
  { bag(Object.assign(draft(), { pv: { raw_closes: { "2330": 1250, "2454": 1480 } } })); const f = open();
    ok("① …預覽帶 raw_closes:2330 寫 160 股、2454 寫 67 股(不是還原價的 200／76)", f.rows.some((x) => /^2330100,000→200,000160 tr\.cf\.unitShares$/.test(x)) && f.rows.some((x) => /^2454100,00067 tr\.cf\.unitShares$/.test(x)), J(f.rows)); }
  { bag(draft({ ov: false })); const f = open();
    ok("① 不在跑+不重疊:照樣出框,只列新的兩檔(既有的 2330 沒變不列)", f.title === "tr.cf.title" && f.rows.length === 2 && !f.rows.some((x) => /^2330/.test(x)), J(f.rows)); }
  // ── ① 在跑:儲存並下單
  { const S = bag(draft({ firing: true, paper: true })); const f = open();
    ok("① 在跑+重疊+預覽到:標題與主鈕「儲存並下單」、記號「模擬」;表頭「下一輪要送的單(N 筆)」",
      f.title === "tr.cf.titleFire" && f.ok === "tr.cf.titleFire" && f.mark === "tr.mode.paper" && /^tr\.cf\.capOrders \{"n":"\d"\}/.test(f.cap), J(f));
    ok("① …每列「買進／賣出 標的 數量 單位」:台股以股(2330 帳上 0 → 目標 200,000 → 買 200 股;2454 買 76 股)",
      f.rows.some((x) => x === "tr.cf.buy2330200 tr.cf.unitShares") && f.rows.some((x) => x === "tr.cf.buy245476 tr.cf.unitShares"), J(f.rows));
    ok("① …BTC 帳上 500、目標 500:差額 0 不列", !f.rows.some((x) => /BTCUSDT/.test(x)), J(f.rows));
  }
  { bag(draft({ firing: true })); const f = open();
    ok("① 真錢在跑(Binance):記號「真錢」;交易所不交易的台股不算要送的單——只改 BTC 時才是「儲存並下單」", f.title === "tr.cf.title" && !f.mark, J(f));
    bag({ firing: true, edits: { btc: 1000 } }); const g = open();
    ok("① …改 BTC:「儲存並下單」+「真錢」", g.title === "tr.cf.titleFire" && g.mark === "tr.mode.real", J(g)); }
  { bag({ firing: true, edits: { btc: 1000 }, rep: {} }); const f = open();
    ok("① 在跑+只改既有金額(不需要預覽):BTC 目標 1,000 − 帳上 500 → 買 0.01 顆(現價 50,000)",
      f.title === "tr.cf.titleFire" && f.rows.length === 1 && f.rows[0] === "tr.cf.buyBTCUSDT0.01 tr.cf.unitCoins", J(f.rows)); }
  { bag({ firing: true, edits: { btc: 504 } }); const f = open();
    ok("① 在跑但差額沒過下單門檻(10):按下去不送單 → 照「儲存金額」列目標的變動、無記號", f.title === "tr.cf.title" && !f.mark && f.rows.length === 1, J(f)); }
  // ── ① 預覽沒到 → 計算中、主鈕停用;到了換上表
  { const S = bag(draft({ noPv: true })); const f = open(); await tick();
    ok("① 預覽沒到:框照開,表的位置「計算中…」、主鈕停用;背景送 stats_refresh 只對這一支",
      f.wait && f.okDisabled && f.rows.length === 0 && sends.some((x) => x.cmd === "stats_refresh" && J(x.args) === J({ names: ["n5"] })), J({ f, sends }));
    S.st.report.backtest_previews = { n5: pv5(true) }; DOM["del-scrim"].hidden = false;
    vm.runInContext("trCfTick()", ctx);
    const rows = flat(f.box.extra).filter((n) => /^cf-row( |$)/.test(n.className)).map((n) => n.textContent);
    ok("① …報告帶來預覽(trCfTick):換上表、主鈕可按", rows.length === 2 && DOM["del-ok"].disabled === false, J({ rows, dis: DOM["del-ok"].disabled })); }
  { bag(draft({ firing: true, paper: true, noPv: true })); const f = open();
    ok("① 在跑+預覽沒到:標題已是「儲存並下單」,表寫計算中、主鈕停用", f.title === "tr.cf.titleFire" && f.wait && f.okDisabled, J(f)); }
  { const S = bag(draft({ pv: { latest: false } })); const f = open(); await tick();
    ok("① 預覽不是最新那根:框不等它,照用;背景再送一次 stats_refresh", !f.wait && f.rows.length === 2 && sends.some((x) => x.cmd === "stats_refresh"), J({ f, sends })); }
  // ── ① 暫停中:儲存金額、不列單、沿用暫停句
  { bag(draft({ halted: true })); const f = open();
    ok("① 暫停中(HALT):「儲存金額」框、列目標變動不列單、無記號;表下沿用 tr.saveWarnHalted",
      f.title === "tr.cf.title" && !f.mark && !f.rows.some((x) => /tr\.cf\.(buy|sell)/.test(x)) && f.notes.some((x) => x === "cf-note:tr.saveWarnHalted"), J(f)); }
  // ── ① 什麼都沒變:直接存
  { bag({ edits: {} }); const f = open(); await tick();
    ok("① 金額完全沒變:不開框直接存", f.direct === true && sends.filter((x) => x.cmd === "amounts").length === 1, J({ f, sends })); }
  { bag({ edits: { btc: 600 } }); const f = open();
    ok("① 沒綁交易所也出框(推翻 10-13「沒連交易所不跳框」)", !f.direct && f.title === "tr.cf.title", J(f)); }

  // ── ② F3 既有分支
  { bag({ picked: ["btc", "tw", "n5"], edits: { n5: 200000 }, rep: { venues: { paper: V }, account: { read_at: now, venues: {} } } });
    vm.runInContext("trPaperTwOk = function () { return false; }", ctx);
    const f = open();
    ok("② 模擬交易不支援台股往上加:cf-block 點名、主鈕停用", f.okDisabled && f.notes.some((x) => /^cf-block:tr\.pick\.twd：/.test(x)), J(f.notes));
    vm.runInContext(cutF("trPaperTwOk"), ctx); }
  { const S = bag({ env: "cloud", edits: { btc: 600 }, amounts: { gone: 50, bad: -1 } }); S.list.push({ name: "bad", displayName: "BAD", hasBacktest: true, symbol: "ETHUSDT" });
    const f = open();
    ok("② 雲端:清單找不到的那支照原樣帶著(tr.cloud.hidden)、主機設定的壞值點名並擋(tr.cloud.badStored)",
      f.notes.some((x) => /^cf-note:tr\.cloud\.hidden/.test(x)) && f.notes.some((x) => /^cf-block:tr\.cloud\.badStored/.test(x)) && f.okDisabled, J(f.notes)); }
  { const S = bag({ edits: {}, list: [{ name: "fut", displayName: "FUT", hasBacktest: true, symbol: "TXF" }], amounts: { fut: 2 }, states: { fut: { symbol: "TXF", position: 1 } },
      rep: { config: { amounts: { btc: 500, tw: 100000, fut: 2 }, contracts: { fut: "TXF" } }, can_switch_contract: true } });
    S.ct.edits.fut = "MXF"; S.edits.fut = 8;
    const f = open();
    // 小台那一列由已存的 fut 撐著:現況 0 也畫「0 → 8」(設計稽核 S3)
    ok("② 換合約:策略層那一列寫「大台 → 小台」(lotsRef);標的表列 大台 2 → 0、小台 0 → 8",
      f.rows.some((x) => x === "FUT8tr.txfProd.txf→tr.txfProd.mxf") && f.rows.some((x) => /^tr\.txfProd\.txf2→0/.test(x)) && f.rows.some((x) => /^tr\.txfProd\.mxf0→8/.test(x)), J(f.rows));
    await f.box.onOk(); await tick();
    const am = sends.filter((x) => x.cmd === "amounts");
    ok("② …按儲存:照 trCtSteps 送(contracts 帶著新合約)", am.length >= 1 && J(am[am.length - 1].args.contracts || {}).indexOf("MXF") >= 0, J(am)); }
  { const S = bag({ edits: { btc: 600 }, list: [{ name: "fut", displayName: "FUT", hasBacktest: true, symbol: "TXF" }], amounts: { fut: 0 }, states: { fut: { symbol: "TXF", position: 1 } } });
    S.raw.fut = "";
    const f = open();
    ok("② 口數格留空:cf-zeroed 點名", f.notes.some((x) => /^cf-zeroed:tr\.saveBlankLots/.test(x)), J(f.notes)); }
  { bag({ edits: { btc: 600 } });
    vm.runInContext("trFxView = function () { return { cached: Date.now() - 8 * 86400000 }; }", ctx);
    const f = open();
    ok("② 匯率 7 天以上:tr.fxOld 講日期", f.notes.some((x) => /^cf-note:tr\.fxOld/.test(x)), J(f.notes));
    vm.runInContext(cutF("trFxView"), ctx); }
  { bag({ picked: ["btc"], halted: true }); const f = open();
    ok("② 移出(暫停中):策略層那一列「原 → 移出」(帳上沒這檔就不標平倉,trStratHeld);暫停句照出", f.rows.some((x) => /^TW100,000→tr\.cfTagRemove/.test(x)) && f.notes.some((x) => /saveWarnHalted/.test(x)), J(f)); }
  { bag({ picked: ["btc"] }); const f = open();
    ok("② 移出(不在跑):框照開;標的表 2330 原 → 0,策略列只寫「移出」", f.title === "tr.cf.title" && f.rows.some((x) => /^2330100,000→0/.test(x)) && f.rows.some((x) => /^TW100,000→tr\.cfTagRemove$/.test(x)), J(f.rows)); }

  // ── ③ §5 邊界
  { bag(draft({ noPv: true, pvReq: { n5: { at: Date.now(), code: "CODE_CHANGED" } } })); const f = open();
    ok("③ CODE_CHANGED:不等,框寫「改過程式還沒回測」、主鈕可按", !f.wait && !f.okDisabled && f.notes.some((x) => /^cf-note:tr\.cf\.codeChanged/.test(x)), J(f)); }
  { const S = bag(draft({ noPv: true, ack: { started: [], skipped: { n5: "BUSY" } } })); const f = open(); await tick();
    ok("③ BUSY:視為重跑中,照等(計算中、主鈕停用)", f.wait && f.okDisabled && (S.pvReq.n5 || {}).code == null, J({ f, req: S.pvReq })); }
  { const S = bag(draft({ noPv: true, ack: { started: [], skipped: { n5: "CODE_CHANGED" } } })); open(); await tick();
    ok("③ ack 回 CODE_CHANGED:記下來,框改寫那一句", (S.pvReq.n5 || {}).code === "CODE_CHANGED", J(S.pvReq)); }
  { bag(draft({ noPv: true })); const f = open();
    const cf = vm.runInContext("TR_CF.cur", ctx); cf.until = Date.now() - 1; vm.runInContext("trCfTick()", ctx);
    const notes = flat(f.box.extra).filter((n) => n.className === "cf-note").map((n) => n.textContent);
    ok("③ 逾時:計算中換成一句說明、主鈕恢復", notes.some((x) => /^tr\.cf\.late/.test(x)) && DOM["del-ok"].disabled === false, J({ notes, dis: DOM["del-ok"].disabled })); }
  { const t2 = vm.runInContext("TR_CF_WAIT_TW_MS", ctx), t5 = vm.runInContext("TR_CF_WAIT_MS", ctx);
    ok("③ 逾時上限:台股日線 2 分、其他 5 分", t2 === 120000 && t5 === 300000, J({ t2, t5 })); }
  { bag(draft({ noPv: true, frozen: ["n5"] })); const f = open();
    ok("③ signals_frozen(剛睡醒、對帳器可能還活著):同計算中", f.wait && f.okDisabled, J(f)); }
  { bag(draft({ oldHost: true, env: "cloud" })); const f = open();
    ok("③ 雲端舊主機(沒有 backtest_previews):框照開、只列算得出的,一句講要等雲端主機更新;不送 stats_refresh",
      !f.wait && !f.okDisabled && f.notes.some((x) => /^cf-note:tr\.cf\.hostOldCloud/.test(x)) && !sends.some((x) => x.cmd === "stats_refresh"), J({ f, sends })); }
  { bag(draft({ noPv: true, oldHost: true })); const f = open();
    ok("③ 本機舊 runtime:同上,換本機那一句", f.notes.some((x) => /^cf-note:tr\.cf\.hostOld /.test(x)), J(f.notes)); }

  // ── 稽核 v027-a1 修正
  const FX = { name: "fx", displayName: "FX", hasBacktest: true, symbol: "TXF", market: "swap", twd: true, twdAll: true };
  const EC = { name: "ec", displayName: "EC", hasBacktest: true, symbol: "ETHUSDT", market: "swap" };
  const pvA = (sym, extra) => Object.assign({ type: "signal", symbol: sym, market: "swap", position: 1, bar_at: BAR, bar_date: "2026-10-16", latest: true, daily_tw: false }, extra || {});
  { bag({ picked: ["btc", "tw", "fx"], edits: { fx: 2 }, list: [FX], quote: true, noPv: true, pvs: { fx: pvA("TXF", { bar_at: BAR - 3 * 86400, bar_date: "2026-10-13", latest: false, daily_tw: true }) } });
    const f = open();
    ok("B2 台指期口數列只靠舊預覽撐:表頭照樣寫是哪一根(依 10/13 收盤,MM/DD)", f.rows.some((x) => /^tr\.txfProd\.txf/.test(x)) && /tr\.cf\.asofClose \{"d":"10\/13"\}$/.test(f.cap), J(f)); }
  { bag({ firing: true, picked: ["btc", "tw", "ec"], edits: { ec: 300 }, list: [EC], noPv: true, pvs: { ec: pvA("ETHUSDT") } });
    const f = open();
    ok("B2 沒有價格、只能照金額寫的單(ETHUSDT 300):表頭照樣寫依哪一根", f.title === "tr.cf.titleFire" && f.rows.some((x) => /^tr\.cf\.buyETHUSDT300/.test(x)) && /tr\.cf\.asofBar \{"d":"\d\d\/\d\d \d\d:\d\d"\}/.test(f.cap), J(f)); }
  // 美股日線(NVDA 價格、下 NVDAUSDT):表頭照台股寫「依 MM/DD 收盤算」,日期是機器給的紐約交易日,不拿 UTC 午夜換本機時區
  { const NV = { name: "nv", displayName: "NV", hasBacktest: true, symbol: "NVDAUSDT", market: "swap" };
    const nvAt = Date.UTC(2026, 9, 20) / 1000;
    bag({ firing: true, picked: ["btc", "tw", "nv"], edits: { nv: 1000 }, list: [NV], noPv: true,
      pvs: { nv: pvA("NVDAUSDT", { close: 216.47, bar_at: nvAt, bar_date: "2026-10-20", daily_us: true }) } });
    const f = open();
    ok("美股日線預覽:表頭寫「依 10/20 收盤算」(紐約交易日),不寫那根的本機時間", f.rows.some((x) => /NVDAUSDT/.test(x)) && /tr\.cf\.asofClose \{"d":"10\/20"\}$/.test(f.cap), J(f));
    bag({ firing: true, picked: ["btc", "tw", "nv"], edits: { nv: 1000 }, list: [NV], noPv: true,
      pvs: { nv: pvA("NVDAUSDT", { close: 216.47, bar_at: nvAt, bar_date: "2026-10-20" }) } });
    const g = open();
    ok("…舊 runtime 沒帶 daily_us:照舊寫依哪一根(時間)", /tr\.cf\.asofBar \{"d":"\d\d\/\d\d \d\d:\d\d"\}/.test(g.cap), J(g)); }
  { bag({ firing: true, picked: ["btc", "tw", "n5"], edits: { btc: 1000, n5: 200000 } });
    const f = open();
    ok("B2 列全是 live 撐的(BTC 照帳上現價換算),組合裡另有一份不相干的預覽(Binance 不交易的台股草稿):表頭不寫時間",
      f.title === "tr.cf.titleFire" && f.rows.length === 1 && /BTCUSDT/.test(f.rows[0]) && !/asof/.test(f.cap), J(f)); }
  { bag({ edits: { btc: 1000 } }); const f = open();
    ok("B2 沒用到預覽:表頭不寫時間", f.rows.length === 1 && !/asof/.test(f.cap), J(f)); }
  // B3:在跑、草稿的預覽不是最新那根、照它算這一刻沒有單——下一輪照最新那根算可能就有,框保守寫「儲存並下單」
  const b3 = (pvx) => { bag({ firing: true, picked: ["btc", "tw", "ec"], edits: { ec: 300 }, list: [EC], noPv: true, pvs: { ec: pvA("ETHUSDT", Object.assign({ position: 0, close: 3000 }, pvx)) } }); return open(); };
  { const f = b3({ latest: false });
    ok("B3 在跑+草稿預覽不是最新那根(部位 0):「儲存並下單」+ 記號,表下一句點名這支", f.title === "tr.cf.titleFire" && f.ok === "tr.cf.titleFire" && f.mark === "tr.mode.real"
      && f.notes.some((x) => /^cf-note:tr\.cf\.oldPv \{"names":"EC"\}$/.test(x)), J(f));
    const g = b3({ latest: undefined });
    ok("B3 …主機沒寫 latest(判不出):一樣保守", g.title === "tr.cf.titleFire" && g.notes.some((x) => /tr\.cf\.oldPv/.test(x)), J(g));
    const h = b3({ latest: true });
    ok("B3 …預覽就是最新那根、部位 0:沒有單 →「儲存金額」、沒有那一句", h.title === "tr.cf.title" && !h.mark && !h.notes.some((x) => /oldPv/.test(x)), J(h)); }
  { bag({ firing: true, picked: ["btc", "tw", "n5"], edits: { n5: 200000 }, pv: { latest: false } }); const f = open();
    ok("B3 …舊預覽的草稿這家交易所下不了(Binance 不交易台股):照「儲存金額」", f.title === "tr.cf.title" && !f.notes.some((x) => /oldPv/.test(x)), J(f)); }
  // B5:草稿列「存了就會下單」與框同一個判準(trCfWillOrder)
  { const w = (n) => vm.runInContext(`trCfWillOrder(${J(n)}, trPvOf(trReport(), ${J(n)}), trContracts())`, ctx);
    bag(draft({ firing: true, list: [EC], pvs: { ec: pvA("ETHUSDT") } }));
    ok("B5 trCfWillOrder:Binance 在跑——台股草稿不會下單、加密草稿會", w("n5") === false && w("ec") === true);
    bag(draft({ firing: true, paper: true }));
    ok("B5 …模擬交易(收台股):台股草稿會下單", w("n5") === true);
    bag(draft({ halted: true, list: [EC], pvs: { ec: pvA("ETHUSDT") } }));
    ok("B5 …暫停中:都不會", w("ec") === false);
    bag(draft({ list: [EC], pvs: { ec: pvA("ETHUSDT") } }));
    ok("B5 …沒在跑:都不會", w("ec") === false);
    bag(draft({ list: [EC], pvs: { ec: pvA("ETHUSDT") } })).pending = { want: "running" };
    ok("B5 …啟動在途(trCfFiring 為真)但還沒綁帳:不會", vm.runInContext("trCfFiring(TR.st, TR.pending)", ctx) === true && w("ec") === false);
    ok("B5 草稿列那一句走 trCfWillOrder(不是只看 trCfFiring)", /if \(trCfWillOrder\(n, .*?\)\) first\.appendChild\(trEl\("span", "pf-note live", t\("po\.willOrder"\)\)\)/.test(src)
      && !/trCfFiring\(TR\.st, TR\.pending\)\) first\.appendChild/.test(src)); }
  // 0.1.28 美股純代號(設計師 desktop-0128-misc-review §1):不分交易所都不會自動下單——草稿列不出「存了就會下單」,框不列它的單
  { const w = (n) => vm.runInContext(`trCfWillOrder(${J(n)}, trPvOf(trReport(), ${J(n)}), trContracts())`, ctx);
    const US = { name: "us", displayName: "US", hasBacktest: true, symbol: "AMZN", market: "swap", srcMarket: "us_stock" };
    bag(draft({ firing: true, list: [US, EC], pvs: { us: pvA("AMZN"), ec: pvA("ETHUSDT") } }));
    ok("美股 trCfWillOrder:Binance 在跑——美股草稿(AMZN、us_stock)不會下單,加密草稿照會", w("us") === false && w("ec") === true);
    bag(draft({ firing: true, paper: true, list: [US], pvs: { us: pvA("AMZN") } }));
    ok("美股 …模擬交易也不會", w("us") === false);
    bag({ firing: true, picked: ["btc", "tw", "us", "ec"], edits: { us: 300, ec: 300 }, list: [US, EC], noPv: true, pvs: { us: pvA("AMZN"), ec: pvA("ETHUSDT") } });
    const f = open();
    ok("美股 存金額框:AMZN 不列進會送單,ETHUSDT 照列", !f.rows.some((x) => /^tr\.cf\.(buy|sell)AMZN/.test(x)) && f.rows.some((x) => /^tr\.cf\.buyETHUSDT300/.test(x)), J(f)); }
  // 不會送單時(列目標「原 → 新」):美股列只寫金額,不換數量、表頭不寫依哪一根;加密對照組照寫(B2;同網頁 8ebba9e22)
  { const US = { name: "us", displayName: "US", hasBacktest: true, symbol: "AMZN", market: "swap", srcMarket: "us_stock" };
    bag({ picked: ["btc", "tw", "us"], edits: { us: 300 }, list: [US], noPv: true, pvs: { us: pvA("AMZN", { close: 200 }) } });
    const f = open();
    ok("美股新列(原 → 新):只寫金額、不換成數量(qty 不算)", f.title === "tr.cf.title" && J(f.rows) === J(["AMZN300"]), J(f));
    ok("美股新列:表頭不寫「依那根算」", !/asof/.test(f.cap), J(f.cap));
    bag({ picked: ["btc", "tw", "ec"], edits: { ec: 300 }, list: [EC], noPv: true, pvs: { ec: pvA("ETHUSDT", { close: 3000 }) } });
    const g = open();
    ok("對照:加密新列照寫顆數與「依那根算」", J(g.rows) === J(["ETHUSDT3000.1 tr.cf.unitCoins"]) && /tr\.cf\.asofBar/.test(g.cap), J(g)); }
  // B6／R1:已存的投資組合這一刻算不出(沒有 state.json、沒有預覽):對帳器只算有 state.json 的,它沒有貢獻,帳上的成分下一輪照樣賣——要列成賣單
  const PC = (u) => ({ name: "pc", displayName: "PC", hasBacktest: true, symbol: null, portfolio: true, market: "swap", universe: u });
  const eth = (S) => { S.st.report.account.venues.binance.positions.ETHUSDT = { side: "long", size: 300, mark_price: 3000 }; return S; };
  { const run = (u) => { eth(bag({ firing: true, edits: { btc: 1000 }, amounts: { pc: 1000 }, list: [PC(u)], noPv: true })); return open(); };
    const f = run(["ETHUSDT"]), g = run(undefined), SELL = "tr.cf.sellETHUSDT0.1 tr.cf.unitCoins";
    ok("B6 算不出的投資組合:清單 UNIVERSE 的成分照樣列賣單(買 BTC + 賣 ETH)、「儲存並下單」", f.title === "tr.cf.titleFire" && f.rows.length === 2 && /^tr\.cf\.buyBTCUSDT/.test(f.rows[0]) && f.rows[1] === SELL, J(f));
    ok("B6 …讀不到 UNIVERSE(雲端清單一律 []):一樣列賣單", g.title === "tr.cf.titleFire" && g.rows.length === 2 && g.rows[1] === SELL, J(g)); }
  { const EX = { name: "ex", displayName: "EX", hasBacktest: true, symbol: "ETHUSDT", market: "swap" };
    eth(bag({ firing: true, picked: ["btc", "tw", "pc"], amounts: { pc: 1000, ex: 300 }, states: { ex: { symbol: "ETHUSDT", position: 1 } }, list: [PC([]), EX], noPv: true }));
    const f = open();
    ok("R1 沒 state.json、沒預覽的投資組合在,移出帳上有 ETH 的 EX:「儲存並下單」+ 記號、列賣 ETH;策略列「移出 · 平倉」",
      f.title === "tr.cf.titleFire" && f.mark === "tr.mode.real" && f.rows.includes("tr.cf.sellETHUSDT0.1 tr.cf.unitCoins") && f.rows.includes("EX300→tr.cfTagRemove · tr.cfTagClose"), J(f)); }
  // B4(paper e2e 0.1.27 batch3):移出一支沒有 state.json、也沒有預覽的策略——存了它就沒有貢獻,不用等它的預覽;框不卡「計算中」
  { const BC = { name: "bc", displayName: "BC", hasBacktest: true, symbol: "BTCUSDT", market: "swap" };
    bag({ firing: true, picked: ["btc", "tw"], amounts: { bc: 3000 }, list: [BC], noPv: true }); const f = open();
    ok("B4 移出沒 state、沒預覽的策略:不寫計算中、主鈕可按;策略列「移出」", !f.wait && !f.okDisabled && f.rows.some((x) => /^BC3,000→tr\.cfTagRemove/.test(x)), J(f));
    bag({ firing: true, picked: ["btc", "tw", "n5"], edits: { n5: 200000 }, amounts: { bc: 3000 }, list: [BC], noPv: true }); const g = open();
    ok("B4 …同時加入一支預覽還沒到的草稿:照等那支(計算中、主鈕停用)", g.wait && g.okDisabled, J(g)); }
  // R2:已經有別的單(買 BTC)時,舊預覽那一句照出、表頭照寫那一根
  { bag({ firing: true, picked: ["btc", "tw", "ec"], edits: { btc: 1000, ec: 300 }, list: [EC], noPv: true, pvs: { ec: pvA("ETHUSDT", { position: 0, close: 3000, latest: false }) } });
    const f = open();
    ok("R2 有單 + 草稿預覽不是最新那根:列買 BTC、表下點名 EC、表頭寫依哪一根", f.title === "tr.cf.titleFire" && f.rows.some((x) => /^tr\.cf\.buyBTCUSDT/.test(x))
      && f.notes.some((x) => /^cf-note:tr\.cf\.oldPv \{"names":"EC"\}$/.test(x)) && /tr\.cf\.asofBar /.test(f.cap), J(f)); }
  // R3:讀過帳、因舊預覽判成「儲存並下單」:原 → 新的列只有這家下得了、帳上有部位的才標平倉
  { const r3 = (ed, pos) => { const S = bag({ firing: true, picked: ["btc", "tw", "ec"], edits: Object.assign({ ec: 300 }, ed), list: [EC], noPv: true,
      pvs: { ec: pvA("ETHUSDT", { position: 0, close: 3000, latest: false }) } }); if (pos) S.st.report.account.venues.binance.positions.BTCUSDT = pos; return open(); };
    const f = r3({ tw: 0 });
    ok("R3 Binance 在跑、舊預覽判成儲存並下單、台股 tw 改 0:2330 原 → 0 不標平倉(Binance 不交易台股)",
      f.title === "tr.cf.titleFire" && f.rows.some((x) => /^2330100,000→0/.test(x)) && !f.rows.some((x) => /^2330.*tr\.cfTagClose/.test(x)), J(f));
    const g = r3({ btc: 0 }, { side: "long", size: 5, mark_price: 50000 });
    ok("R3 …BTC 改 0、帳上還有 5(沒過下單門檻):BTCUSDT 原 → 0 標平倉", g.title === "tr.cf.titleFire" && g.rows.some((x) => /^BTCUSDT500→0tr\.cfTagClose/.test(x)), J(g)); }
  // ② F3「{舊合約}平倉」有帳的情境:群益帳上有舊合約(大台)部位、換到小台後沒人撐 → 策略列標 ct.tagClose
  { const S = bag({ edits: {}, list: [{ name: "fut", displayName: "FUT", hasBacktest: true, symbol: "TXF" }], amounts: { fut: 2 }, states: { fut: { symbol: "TXF", position: 1 } },
      rep: { venues: { capital: V }, config: { amounts: { btc: 500, tw: 100000, fut: 2 }, contracts: { fut: "TXF" } }, can_switch_contract: true,
        last_reconcile: { ts: new Date(now * 1000).toISOString().slice(0, 19), actual: {}, target: {}, gates: {} },
        account: { read_at: now, venues: { capital: { ok: true, equity: 2000000, currency: "TWD", positions: { TX2611: { side: "long", size: 2 } } } } } } });
    S.ct.edits.fut = "MXF"; S.edits.fut = 8;
    const f = open();
    ok("② 換合約+帳上有舊合約部位:策略列標「{大台}平倉」(ct.tagClose)", f.rows.some((x) => /^FUT8ct\.tagClose \{"prod":"tr\.txfProd\.txf"\}/.test(x)), J(f.rows));
    S.st.report.account.venues.capital.positions = {}; const g = open();
    ok("② …帳上沒有舊合約部位:不標", !g.rows.some((x) => /ct\.tagClose/.test(x)), J(g.rows)); }
  // S1:換策略。對帳器(快照 caps 帶 first_signal_wait)對還沒算出第一個訊號的成員,它的標的這一輪先不動;框照它列
  const LR = (target, old) => ({ ts: new Date(now * 1000).toISOString().slice(0, 19), actual: {}, target: target || {}, gates: {}, caps: old ? ["contract_override"] : ["contract_override", "rollover_halt_freeze", "first_signal_wait"] });
  const DB = { name: "db", displayName: "DB", hasBacktest: true, symbol: "BTCUSDT", market: "swap" };
  const DC = { name: "dc", displayName: "DC", hasBacktest: true, symbol: null, portfolio: true, market: "swap", universe: ["BTCUSDT", "SOLUSDT"] };
  const pvC = { type: "portfolio", market: "swap", weights: { BTCUSDT: 0.5, SOLUSDT: 0.5 }, closes: { BTCUSDT: 50000, SOLUSDT: 150 }, bar_at: BAR, bar_date: "2026-10-16", latest: true, daily_tw: false };
  const HELD = (syms, names) => "cf-note:tr.cf.held " + J({ syms, names }), side = (f) => f.rows.filter((x) => /^tr\.cf\.(buy|sell)/.test(x));
  // 存檔前那一輪的快照(對帳器第一輪拿它當錨點):btc 在 BTC 上貢獻 500
  const PRE = () => ({ BTCUSDT: { side: "long", size: 500, gated: false, contributors: [{ strategy: "btc", position: 1, amount: 500, contribution: 500 }] } });
  { bag({ firing: true, picked: ["btc", "tw", "db"], edits: { btc: 0, db: 500 }, list: [DB], noPv: true, pvs: { db: pvA("BTCUSDT", { close: 50000 }) }, rep: { last_reconcile: LR(PRE()) } });
    const f = open();
    ok("S1 單一→單一(btc 改 0、加同標的草稿 db,預覽最新多 1):「儲存金額」、不列單;BTC 這一輪不會動那句",
      f.title === "tr.cf.title" && !f.mark && side(f).length === 0 && f.notes.includes(HELD("BTCUSDT", "DB")) && f.rows.includes("BTC500→0"), J(f)); }
  { bag({ firing: true, picked: ["tw", "db"], edits: { db: 500 }, list: [DB], noPv: true, pvs: { db: pvA("BTCUSDT", { close: 50000 }) }, rep: { last_reconcile: LR(PRE()) } });
    const f = open();
    ok("S1 …移出 btc(不是改 0):策略列「移出」不帶平倉", f.title === "tr.cf.title" && f.rows.includes("BTC500→tr.cfTagRemove") && f.notes.includes(HELD("BTCUSDT", "DB")), J(f)); }
  { bag({ firing: true, picked: ["btc", "tw", "dc"], edits: { btc: 0, dc: 1000 }, list: [DC], noPv: true, pvs: { dc: pvC }, rep: { last_reconcile: LR(PRE()) } });
    const f = open();
    ok("S1 單一→組合(btc 改 0、加含 BTC 的草稿組合):只列買 SOL、不列賣 BTC;BTC 不會動那句", f.title === "tr.cf.titleFire" && J(side(f)) === J(["tr.cf.buySOLUSDT3.3333 tr.cf.unitCoins"])
      && f.notes.includes(HELD("BTCUSDT", "DC")), J(f)); }
  { bag({ firing: true, picked: ["tw", "db"], edits: { db: 500 }, list: [DB], noPv: true, pvs: { db: pvA("BTCUSDT", { close: 50000 }) }, rep: { last_reconcile: LR(null, true) } });
    const f = open();
    ok("S1 …對帳器是舊 lib(caps 沒有 first_signal_wait):不說不會動、移出的 btc 照標平倉", !f.notes.some((x) => /tr\.cf\.held/.test(x)) && f.rows.includes("BTC500→tr.cfTagRemove · tr.cfTagClose"), J(f)); }
  // 已存、還沒有 state.json 的 db:等待窗內不動 BTC;過了窗(快照不再列它在等)照常對帳,沒貢獻的 BTC 照賣
  { const w = (awaiting) => { bag({ firing: true, picked: ["btc", "tw", "db"], amounts: { db: 500 }, edits: { btc: 0 }, list: [DB], noPv: true,
      rep: { last_reconcile: LR(awaiting ? { BTCUSDT: Object.assign(PRE().BTCUSDT, { frozen: 0, awaiting: { db: now + 3000 } }) } : {}) } }); return open(); };
    const f = w(false), g = w(true);
    ok("S1 等待逾時(或新成員一直算不出):照常處理——列賣 BTC、「儲存並下單」,出場不被卡住", f.title === "tr.cf.titleFire" && side(f).includes("tr.cf.sellBTCUSDT0.01 tr.cf.unitCoins") && !f.notes.some((x) => /tr\.cf\.held/.test(x)), J(f));
    ok("S1 …還在等待窗內(db 是純新加、frozen 0),這次把 btc 改 0:btc 那 500 變成被換掉的那段,不列賣 BTC、說它先不動",
      side(g).length === 0 && g.notes.includes(HELD("BTCUSDT", "DB")), J(g)); }
  { bag({ halted: true, picked: ["btc", "tw", "db"], edits: { btc: 0, db: 500 }, list: [DB], noPv: true, pvs: { db: pvA("BTCUSDT", { close: 50000 }) }, rep: { last_reconcile: LR(), halt: { halted: true } } });
    const f = open();
    ok("S1 暫停中:框照舊(儲存金額 + 暫停那句),不加不會動那句", f.title === "tr.cf.title" && f.notes.includes("cf-note:tr.saveWarnHalted") && !f.notes.some((x) => /tr\.cf\.held/.test(x)), J(f)); }
  // 模擬交易的台股不管 MARKET 一律現股(lib/portfolio._paper_tw_market、trClientTargets):swap 的台股新成員等的是 2330@spot,不是 2330
  { const DT = { name: "dt", displayName: "DT", hasBacktest: true, symbol: "2330", market: "swap", twd: true, twdAll: true };
    bag({ firing: true, paper: true, picked: ["btc", "tw", "dt"], edits: { dt: 100000 }, list: [DT], noPv: true, rep: { last_reconcile: LR() } });
    const got = JSON.parse(vm.runInContext("JSON.stringify([trCfSymsOf('dt', null, {}), Object.keys(trCfHolds(trReport(), trBase(), Object.assign({}, trBase(), { dt: 100000 }), {}, null).wait)])", ctx));
    ok("S1 模擬交易的 swap 台股新成員:先不動的標的與它的標的都是 2330@spot(同對帳器)", J(got) === J([["2330@spot"], ["2330@spot"]]), J(got)); }
  // F13:台股列寫股數。實盤 state 的未還原收盤(raw_closes,同 trTwLots)也是價格來源——模擬帳戶沒持有台股時 mark 沒有台股價
  { const TWC = { weights: { "2330": 1 }, market: "spot", raw_closes: { "2330": 1000 }, raw_close_dates: { "2330": "2026-10-16" } };
    bag({ firing: true, paper: true, picked: ["btc", "tw"], edits: { tw: 150000 }, noPv: true, states: { tw: TWC } }); const f = open();
    ok("F13 在跑、模擬交易、台股 Type C 有 raw_closes、帳上沒台股:列「買進 2330 150 股」,不是只寫 TWD", f.rows.includes("tr.cf.buy2330150 tr.cf.unitShares"), J(f));
    bag({ picked: ["btc", "tw"], edits: { tw: 150000 }, noPv: true, states: { tw: TWC } }); const g = open();
    ok("F13 不在跑(目標有變):100,000 → 150,000 下面小字 150 股", g.rows.some((x) => /^2330100,000→150,000/.test(x) && /150 tr\.cf\.unitShares/.test(x)), J(g));
    // 0.1.27 以前的 lib 寫的預覽沒有 closes:別支 live 策略查到的同一檔照用;一檔都沒價格時表頭不寫「依 MM/DD 收盤算」
    const OLDPV = { type: "portfolio", market: "spot", weights: { "2330": 1 }, bar_at: BAR, bar_date: "2026-10-16", latest: true, daily_tw: true };
    bag({ picked: ["btc", "tw", "n5"], edits: { n5: 50000 }, pvs: { n5: OLDPV }, states: { tw: TWC } }); const h = open();
    ok("F13 草稿的舊預覽沒有 closes:用 tw 的 raw_closes 換股數(2330 100,000 → 150,000、150 股)", h.rows.some((x) => /^2330100,000→150,000/.test(x) && /150 tr\.cf\.unitShares/.test(x)), J(h));
    bag({ picked: ["btc", "tw", "n5"], edits: { n5: 50000 }, pvs: { n5: Object.assign({}, OLDPV, { weights: { "2603": 1 } }) } }); const k = open();
    ok("F13 一檔都沒價格:表頭不寫「依 10/16 收盤算」", k.rows.some((x) => /^2603/.test(x)) && !/asofClose/.test(k.cap), J(k)); }
  // F14:等新訊號那句最多點名三檔,其餘「和另外 N 檔」
  { const ks = ["2303", "2317", "2330", "2382", "2454"], w = {}, gt = {}; ks.forEach((x) => { w[x] = 0.2; gt[x + "@spot"] = { side: "long", size: 20000, gated: true, contributors: [{ strategy: "tw", position: 0.2, amount: 100000, contribution: 20000, gated: true }] }; });
    bag({ firing: true, paper: true, picked: ["btc", "tw"], edits: { tw: 200000 }, noPv: true, states: { tw: { weights: w, market: "spot" } }, rep: { last_reconcile: LR(gt) } }); const f = open();
    const n = f.notes.find((x) => /^cf-note:tr\.cf\.gated /.test(x)), syms = n ? JSON.parse(n.slice("cf-note:tr.cf.gated ".length)).syms : "";
    ok("F14 五檔等新訊號:句子點名前三檔、其餘「和另外 2 檔」", syms === '2303、2317、2330tr.opt.catchMore {"n":2}', J(f)); }
  // F15:休市中(對帳器把台股留到開盤):有現在要送的單時,台股的單標「休市中，開盤後下單」、排最後、不算進「下一輪要送的 N 筆」,表下不再講休市(逐列已經講了)
  { const TWC = { weights: { "2330": 1 }, market: "spot", raw_closes: { "2330": 1000 } };
    vm.runInContext("TW_OPEN = false", ctx);
    bag({ firing: true, paper: true, picked: ["btc", "tw"], edits: { btc: 1000 }, noPv: true, states: { tw: TWC } }); const f = open();
    vm.runInContext("TW_OPEN = true", ctx);
    const btc = f.rows.findIndex((x) => /^tr\.cf\.buyBTCUSDT/.test(x)), tw = f.rows.findIndex((x) => /^tr\.cf\.buy2330/.test(x));
    ok("F15 休市中:台股那列標 po.twClosedHold、排在 BTC 後面;表頭只算 BTC 那 1 筆;表下不出 tr.opt.catchTwClosed",
      btc === 0 && tw === 1 && /po\.twClosedHold$/.test(f.rows[tw]) && !/twClosedHold/.test(f.rows[btc]) && /^tr\.cf\.capOrders \{"n":"1"\}/.test(f.cap) && !f.notes.includes("cf-note:tr.opt.catchTwClosed"), J(f));
    const dds = flat(f.box.extra).filter((n) => /^cf-row( |$)/.test(n.className)).map((n) => n.kids[1]);
    ok("F15 送單列的數量包成 span.n(.cf-amt .n + .tag 的 --space-8 才對得上,「188 股」與「休市中」不黏)",
      dds.length === 2 && dds.every((d) => d.kids[0] && d.kids[0].className === "n") && dds[tw].kids[1] && dds[tw].kids[1].className === "tag", J(dds.map((d) => d.kids.map((k) => (typeof k === "string" ? "#text" : k.className)))));
    // 全部都是留到開盤的台股(這一輪一筆都不送,稽核 0.1.27 batch2 P2-2):表頭「開盤後要送的單（N 筆）」,逐列不標、表下不講休市,主鈕照舊「儲存並下單」
    vm.runInContext("TW_OPEN = false", ctx);
    bag({ firing: true, paper: true, picked: ["btc", "tw"], edits: { tw: 150000 }, noPv: true, states: { tw: TWC } }); const a = open();
    vm.runInContext("TW_OPEN = true", ctx);
    ok("F15 全部休市:表頭 tr.cf.capOrdersOpen、逐列不標 po.twClosedHold、表下不出 tr.opt.catchTwClosed、標題 tr.cf.titleFire",
      a.title === "tr.cf.titleFire" && /^tr\.cf\.capOrdersOpen \{"n":"1"\}/.test(a.cap) && a.rows.length === 1 && /^tr\.cf\.buy2330/.test(a.rows[0]) && !a.rows.some((x) => /twClosedHold/.test(x)) && !a.notes.includes("cf-note:tr.opt.catchTwClosed"), J(a));
    bag({ firing: true, paper: true, picked: ["btc", "tw"], edits: { btc: 1000 }, noPv: true, states: { tw: TWC } }); const g = open();
    ok("F15 開盤中:照舊兩筆、不標休市", /^tr\.cf\.capOrders \{"n":"2"\}/.test(g.cap) && !g.rows.some((x) => /twClosedHold/.test(x)) && !g.notes.includes("cf-note:tr.opt.catchTwClosed"), J(g)); }
  // 稽核 0.1.27 P1:列一多、焦點停在取消,overflow:hidden 的外框被捲走、標題與模擬／真錢記號推出框外。所有確認框只讓內文捲(不再只限啟動框)
  { const css = fs.readFileSync(path.join(R, "app.css"), "utf8"), html = fs.readFileSync(path.join(R, "index.html"), "utf8");
    const shell = (css.match(/\.set-modal \{([^}]*)\}/) || [, ""])[1], box = html.slice(html.indexOf('id="del-modal"'), html.indexOf("</div>\n</div>", html.indexOf('id="del-modal"')));
    const ih = box.indexOf('class="modal-head"'), ib = box.indexOf('id="del-body"'), iff = box.indexOf('class="modal-foot"');
    ok("P1 確認框:.del-modal .del-body 一律 min-height 0 + overflow-y auto(沒有 .has-choices 限定);外框照舊 max-height + overflow hidden + flex column;頭 → 內文 → 腳、取消在腳裡",
      /^\.del-modal \.del-body \{ min-height: 0; overflow-y: auto; \}/m.test(css) && !/\.has-choices \.del-body/.test(css)
      && /max-height: calc\(100vh - var\(--space-48\)\);/.test(shell) && /overflow: hidden;/.test(shell) && /display: flex; flex-direction: column;/.test(shell)
      && ih > 0 && ih < ib && ib < iff && box.indexOf('id="del-cancel"') > iff); }
  // S3:等新訊號(訊號閘)擋下的標的不列單;閘中那支自己移出,閘跟著走,照列
  { const gt = { BTCUSDT: { side: "long", size: 500, gated: true, contributors: [{ strategy: "btc", position: 1, amount: 500, contribution: 500, gated: true }] } };
    bag({ firing: true, edits: { btc: 1000 }, rep: { last_reconcile: LR(gt) } }); const f = open();
    ok("S3 btc 在等新訊號、改金額 500→1000:不列買 BTC、「儲存金額」、表下說等新訊號", f.title === "tr.cf.title" && side(f).length === 0 && f.notes.includes("cf-note:tr.cf.gated " + J({ syms: "BTCUSDT" })), J(f));
    bag({ firing: true, picked: ["tw"], rep: { last_reconcile: LR(gt) } }); const g = open();
    ok("S3 …移出閘中的 btc 本身:照列賣 BTC", g.title === "tr.cf.titleFire" && side(g).includes("tr.cf.sellBTCUSDT0.01 tr.cf.unitCoins"), J(g)); }
  // 快照 awaiting 已經過期、框還開著:對帳器照常賣,框也要列賣單(不能說不動)
  { bag({ firing: true, picked: ["btc", "tw", "db"], amounts: { db: 500 }, edits: { btc: 0 }, list: [DB], noPv: true,
      rep: { last_reconcile: LR({ BTCUSDT: { side: "long", size: 500, contributors: [], awaiting: { db: now - 5 }, frozen: 500 } }) } }); const f = open();
    ok("F3 快照 awaiting 已到期:列賣 BTC、「儲存並下單」、不說不動", f.title === "tr.cf.titleFire" && side(f).includes("tr.cf.sellBTCUSDT0.01 tr.cf.unitCoins") && !f.notes.some((x) => /tr\.cf\.held/.test(x)), J(f)); }
  // 方向 2:對帳器已經記下 frozen(快照列帶 frozen、不 gated):只凍被換掉那段,別支的金額／訊號照送
  { const at = (contribs, frozen) => ({ BTCUSDT: { side: "long", size: 500, gated: false, frozen, contributors: contribs, awaiting: { db: now + 3000 } } });
    bag({ firing: true, picked: ["btc", "tw", "db"], amounts: { db: 500 }, edits: { btc: 1000 }, list: [DB], noPv: true,
      rep: { last_reconcile: LR(at([{ strategy: "btc", position: 1, amount: 500, contribution: 500 }], 0)) } }); const f = open();
    ok("D2 db 等第一個訊號、BTC 已記 frozen 0:btc 500→1000 照列買 BTC 0.01(只凍被換掉那段)", f.title === "tr.cf.titleFire" && J(side(f)) === J(["tr.cf.buyBTCUSDT0.01 tr.cf.unitCoins"]) && !f.notes.some((x) => /tr\.cf\.held/.test(x)), J(f));
    bag({ firing: true, picked: ["tw", "db"], amounts: { db: 500 }, list: [DB], noPv: true,
      rep: { last_reconcile: LR(at([{ strategy: "btc", position: 1, amount: 500, contribution: 500 }], 0)) } }); const g = open();
    ok("D2 …等待中把 btc 移出:它最後那份 500 跟著凍,不列賣 BTC、不標平倉、說被換掉那段先不動", side(g).length === 0 && g.notes.includes(HELD("BTCUSDT", "DB")) && g.rows.includes("BTC500→tr.cfTagRemove"), J(g));
    bag({ firing: true, picked: ["btc", "tw", "db"], amounts: { db: 500 }, list: [DB], noPv: true, states: { btc: { symbol: "BTCUSDT", position: 0 } }, edits: { tw: 100001 },
      rep: { last_reconcile: LR(at([{ strategy: "btc", position: 1, amount: 500, contribution: 300 }], 200)) } }); const h = open();
    ok("D2 …btc 停損(訊號 0)、frozen 200:列賣 BTC 300 那段(0.006),留 200", J(side(h)) === J(["tr.cf.sellBTCUSDT0.006 tr.cf.unitCoins"]), J(h)); }
  // 稽核 0b16add 存活突變:(a) 窗內目標第二道夾(夾到同一輪沒有等待時的目標 after)、(b) 讀帳模式帳上變少時 frozen 跟著縮
  { const D1 = { name: "d1", displayName: "D1", hasBacktest: true, symbol: "BTCUSDT", market: "swap" }, D2 = { name: "d2", displayName: "D2", hasBacktest: true, symbol: "BTCUSDT", market: "swap" };
    const acct = (size) => ({ read_at: now, venues: { binance: { ok: true, equity: 10000, currency: "USDT", positions: { BTCUSDT: { side: "long", size, mark_price: 50000 } } } } });
    // (a) 帳上 1,000;btc 300 留著、d1 已算出(cohort)500、d2 還在等:其他成員要 300,同一輪沒有等待時是 800,落在 [300, 1,000] 裡 → 目標夾到 800,賣 200
    const winA = { BTCUSDT: { side: "long", size: 1000, gated: false, frozen: 0, cohort: ["d1"], awaiting: { d2: now + 3000 }, contributors: [{ strategy: "btc", position: 1, amount: 300, contribution: 300 }] } };
    bag({ firing: true, picked: ["btc", "tw", "d1", "d2"], amounts: { btc: 300, d1: 500, d2: 500 }, states: { d1: { symbol: "BTCUSDT", position: 1 } }, edits: { tw: 100001 }, list: [D1, D2], noPv: true,
      rep: { last_reconcile: LR(winA), account: acct(1000) } }); const f = open();
    ok("M-a 窗內目標夾到同一輪沒有等待時的目標:帳上 1,000、其他成員 300、沒有等待時 800 → 只賣 200(0.004),不賣 700", J(side(f)) === J(["tr.cf.sellBTCUSDT0.004 tr.cf.unitCoins"]), J(f));
    // (b) 快照 frozen 300、btc 當時 500;帳上只剩 600(< 500 + 300):frozen 縮成 100。btc 改 200 → 目標 300,賣 300(0.006);沒縮會只賣 100
    const winB = { BTCUSDT: { side: "long", size: 800, gated: false, frozen: 300, awaiting: { db: now + 3000 }, contributors: [{ strategy: "btc", position: 1, amount: 500, contribution: 500 }] } };
    bag({ firing: true, picked: ["btc", "tw", "db"], amounts: { db: 500 }, edits: { btc: 200 }, list: [DB], noPv: true, rep: { last_reconcile: LR(winB), account: acct(600) } }); const g = open();
    ok("M-b 讀帳模式帳上少了:frozen 跟著縮(300 → 100),btc 500→200 賣 300(0.006)", J(side(g)) === J(["tr.cf.sellBTCUSDT0.006 tr.cf.unitCoins"]), J(g)); }
  // 錨點 = 存檔前那一輪的快照:純新加(沒換掉誰)沒有被凍的那段;同一次存檔一起改的鄰居金額照送;現貨不放空
  // 草稿算不出(主機不出預覽):框照對帳器下一輪那份列
  { bag({ firing: true, picked: ["btc", "tw", "db"], edits: { db: 500 }, list: [DB], oldHost: true, rep: { last_reconcile: LR(PRE()) } }); const f = open();
    ok("A 純新加 db(BTC,算不出)、btc 不動:frozen 0,不說「被換掉的那段」、不列 BTC 單", !f.wait && side(f).length === 0 && !f.notes.some((x) => /tr\.cf\.held/.test(x)), J(f));
    bag({ firing: true, picked: ["tw", "db"], edits: { db: 500 }, list: [DB], oldHost: true, rep: { last_reconcile: LR(PRE()) } }); const g = open();
    ok("A …同一格把 btc 移出:有被換掉的那段(500),說它先不動", !g.wait && side(g).length === 0 && g.notes.includes(HELD("BTCUSDT", "DB")), J(g)); }
  { const C1 = { name: "c1", displayName: "C1", hasBacktest: true, symbol: "BTCUSDT", market: "swap" };
    const pre = { BTCUSDT: { side: "long", size: 700, gated: false, contributors: [{ strategy: "btc", position: 1, amount: 500, contribution: 500 }, { strategy: "c1", position: 1, amount: 200, contribution: 200 }] } };
    const acct = { read_at: now, venues: { binance: { ok: true, equity: 10000, currency: "USDT", positions: { BTCUSDT: { side: "long", size: 700, mark_price: 50000 } } } } };
    bag({ firing: true, picked: ["btc", "tw", "db", "c1"], amounts: { c1: 200 }, states: { c1: { symbol: "BTCUSDT", position: 1 } }, edits: { btc: 0, db: 500, c1: 50 }, list: [DB, C1], oldHost: true,
      rep: { last_reconcile: LR(pre), account: acct } }); const f = open();
    ok("D3 換策略同一次把鄰居 c1 200→50:這一輪就賣 c1 那 150(0.003),btc 那 500 先不動", f.title === "tr.cf.titleFire" && J(side(f)) === J(["tr.cf.sellBTCUSDT0.003 tr.cf.unitCoins"]), J(f)); }
  { const D1 = { name: "d1", displayName: "D1", hasBacktest: true, symbol: "BTCUSDT", market: "swap" }, D2 = { name: "d2", displayName: "D2", hasBacktest: true, symbol: "BTCUSDT", market: "swap" };
    const win = { BTCUSDT: { side: "long", size: 500, gated: false, frozen: 500, cohort: ["d1"], contributors: [{ strategy: "d1", position: 1, amount: 500, contribution: 500 }], awaiting: { d2: now + 3000 } } };
    bag({ firing: true, picked: ["btc", "tw", "d1", "d2"], amounts: { btc: 0, d1: 500, d2: 500 }, states: { d1: { symbol: "BTCUSDT", position: 1 } }, edits: { tw: 100001 }, list: [D1, D2], oldHost: true,
      rep: { last_reconcile: LR(win) } }); const f = open();
    ok("D4 btc 換成 d1+d2、d1 已算出多單、d2 還在等:不在被凍的 500 上再買 d1 那 500", side(f).length === 0, J(f));
    const winS = JSON.parse(J(win)); winS.BTCUSDT.contributors[0] = { strategy: "d1", position: -1, amount: 500, contribution: -500 };
    bag({ firing: true, picked: ["btc", "tw", "d1", "d2"], amounts: { btc: 0, d1: 500, d2: 500 }, states: { d1: { symbol: "BTCUSDT", position: -1 } }, edits: { tw: 100001 }, list: [D1, D2], oldHost: true,
      rep: { last_reconcile: LR(winS) } }); const g = open();
    ok("D4 …d1 算出空單、d2 還在等:d1(cohort)不算進去,被換掉的 500 不賣", side(g).length === 0, J(g)); }
  { const SP = { name: "sp", displayName: "SP", hasBacktest: true, symbol: "BTCUSDT", market: "spot" }, C1S = { name: "c1s", displayName: "C1S", hasBacktest: true, symbol: "BTCUSDT", market: "spot" };
    const DBS = { name: "dbs", displayName: "DBS", hasBacktest: true, symbol: "BTCUSDT", market: "spot" };
    const lr = LR({ "BTCUSDT@spot": { side: "long", size: 500, gated: false, contributors: [{ strategy: "sp", position: 1, amount: 500, contribution: 500 }, { strategy: "c1s", position: 0, amount: 600, contribution: 0 }] } });
    lr.actual = { "BTCUSDT@spot": { side: "long", size: 500 } };
    bag({ firing: true, picked: ["btc", "tw", "sp", "c1s", "dbs"], amounts: { sp: 500, c1s: 600 }, states: { sp: { symbol: "BTCUSDT", position: 1, market: "spot" }, c1s: { symbol: "BTCUSDT", position: -1, market: "spot" } },
      edits: { sp: 0, dbs: 500 }, list: [SP, C1S, DBS], oldHost: true, rep: { last_reconcile: lr } }); const f = open();
    ok("G4 現貨:c1s 空 600 + 被換掉的 500 = −100 → 目標 0,只賣帳上那 500(0.01),不賣超過", J(side(f)) === J(["tr.cf.sellBTCUSDT0.01 tr.cf.unitCoins"]), J(f)); }
  // 被換掉的那段只算帳上還有的(同 lib):快照目標沒到帳(暫停／被拒／手動平倉)、閘中的離開成員、cohort 不在帳上;窗內目標落在 [帳上, 其他成員要的]
  { const C1 = { name: "c1", displayName: "C1", hasBacktest: true, symbol: "BTCUSDT", market: "swap" };
    const two = (btcG) => ({ BTCUSDT: { side: "long", size: 700, gated: !!btcG, contributors: [Object.assign({ strategy: "btc", position: 1, amount: 500, contribution: 500 }, btcG ? { gated: true } : {}), { strategy: "c1", position: 1, amount: 200, contribution: 200 }] } });
    const acct = (n) => ({ read_at: now, venues: { binance: { ok: true, equity: 10000, currency: "USDT", positions: n ? { BTCUSDT: { side: "long", size: n, mark_price: 50000 } } : {} } } });
    const run = (o) => { bag(Object.assign({ firing: true, picked: ["tw", "db", "c1"], amounts: { c1: 200 }, edits: { db: 500 }, list: [DB, C1], oldHost: true }, o)); return open(); };
    let f = run({ states: { c1: { symbol: "BTCUSDT", position: 0 } }, rep: { last_reconcile: LR(two()), account: acct(200) } });
    ok("E1 btc 那 500 沒到帳(帳上只有 c1 的 200)就換成 db、c1 停損:照列賣 c1 那 200(0.004),不替 btc 撐", J(side(f)) === J(["tr.cf.sellBTCUSDT0.004 tr.cf.unitCoins"]), J(f));
    f = run({ states: { c1: { symbol: "BTCUSDT", position: 1 } }, rep: { last_reconcile: LR(two(true)), account: acct(700) } });
    ok("E2 閘中的 btc(帳上撐著 500)被移出、換 db:那 500 先不動,不列賣", side(f).length === 0 && f.notes.includes(HELD("BTCUSDT", "DB")), J(f));
    f = run({ states: { c1: { symbol: "BTCUSDT", position: 1 } }, edits: { db: 500, c1: 400 }, rep: { last_reconcile: LR(two()), account: acct(700) } });
    ok("窗內 c1 200→400:先抵掉被換掉的那段,不列買(對帳器窗結束才買)", side(f).length === 0 && f.notes.includes(HELD("BTCUSDT", "DB")), J(f));
    for (const [label, extra] of [["S7 基準還沒寫(needs_baseline)", { needs_baseline: "confirming" }], ["S8 那一檔在等 pending", { baseline_pending: ["BTCUSDT"] }]]) {
      const lr = Object.assign(LR(two()), extra);
      f = run({ states: { c1: { symbol: "BTCUSDT", position: 0 } }, rep: { last_reconcile: lr, account: acct(700) } });
      ok(label + ":對帳器整檔不動、不給 anchor——c1 停損也不列賣", side(f).length === 0 && f.notes.includes(HELD("BTCUSDT", "DB")), J(f)); }
    const D1 = { name: "d1", displayName: "D1", hasBacktest: true, symbol: "BTCUSDT", market: "swap" }, D2 = { name: "d2", displayName: "D2", hasBacktest: true, symbol: "BTCUSDT", market: "swap" };
    const win = { BTCUSDT: { side: "long", size: 700, gated: false, frozen: 500, cohort: ["d1"], awaiting: { d2: now + 3000 },
      contributors: [{ strategy: "d1", position: 1, amount: 500, contribution: 500 }, { strategy: "c1", position: 1, amount: 200, contribution: 200 }] } };
    bag({ firing: true, picked: ["tw", "d1", "d2"], amounts: { btc: 0, d1: 500, d2: 500, c1: 200 }, states: { d1: { symbol: "BTCUSDT", position: 1 }, c1: { symbol: "BTCUSDT", position: 1 } },
      edits: { tw: 100001 }, list: [D1, D2, C1], oldHost: true, rep: { last_reconcile: LR(win), account: acct(700) } }); f = open();
    ok("S10 窗內(cohort d1 沒到帳)把 c1 移出:c1 那 200 跟著凍,不列賣", side(f).length === 0, J(f)); }
  // UNIVERSE 的註解:跟 lib/portfolio 讀同一份 fixture
  { const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "universe_comments.json"), "utf8"));
    vm.runInContext(cutF("trUniverse"), ctx); const u = vm.runInContext("trUniverse(" + J(fx.code) + ")", ctx);
    ok("UNIVERSE:註解裡的代號或 ] 不多算、不截斷,引號裡的 # 照收(同 lib)", J(u) === J(fx.universe), J(u)); }
  ok("R3 原 → 新列的 held 只看帳上(這家下不下得了由 covered 在列單時判)", /held: !!o\.mine\[sym\], kept: /.test(cutF("trCfRows")) && !/held: o\.covered/.test(cutF("trCfRows")));
  ok("死碼:trCfStates 裡沒有 keyOf、框狀態沒有 changed", !/keyOf/.test(cutF("trCfStates")) && !/changed: false/.test(cutF("trSaveAmounts")));

  // ── 單位換算
  { const q = (s, m, p) => vm.runInContext(`trCfQty(${J(s)}, ${m}, ${p})`, ctx);
    ok("數量:台股不足 1 股捨去;加密 4 位有效;沒價格回 null(不湊數)", q("2330@spot", 1999, 1000).n === 1 && q("2330", 999, 1000).n === 0 && q("BTCUSDT", 123.4, 50000).text === "0.002468" && q("BTCUSDT", 5, null) === null,
      J([q("2330@spot", 1999, 1000), q("BTCUSDT", 123.4, 50000)])); }

  // ── ④ A1 鈕
  { const S = bag({ edits: {} }); ctx.RP = { name: "n5", data: { code: "x", stats: {} } }; ctx.RPC = ctx.RP;
    let b = vm.runInContext("poAddBtn(false)", ctx);
    ok("④ 回測過、不在組合:填色「加到策略組合」", !!b && b.className === "btn-fill" && b.text === "po.add" && b.id === "rp-po", J(b && { c: b.className, t: b.text }));
    ctx.RP = { name: "tw", data: { code: "x", stats: {} } }; b = vm.runInContext("poAddBtn(false)", ctx);
    ok("④ 已在組合:描邊「到策略組合」", !!b && b.className === "btn-out" && b.text === "po.addGo");
    S.listLoaded = false; ctx.RP = { name: "n5", data: { code: "x", stats: {} } };
    ok("④ 策略清單還沒載入(沒開過策略組合)也照出:看這一頁讀到的 stats", !!vm.runInContext("poAddBtn(false)", ctx)); S.listLoaded = true;
    ctx.RP = { name: "nobt", data: { code: "x" } };
    ok("④ 沒回測過(NO_STATS):鈕不出現", vm.runInContext("poAddBtn(false)", ctx) === null);
    ctx.xpIsTypeB = () => true; ctx.RP = { name: "n5", data: { code: "x", stats: {} } };
    ok("④ Type B:鈕不出現", vm.runInContext("poAddBtn(false)", ctx) === null); delete ctx.xpIsTypeB; }
  { const S = bag({ edits: {}, noPv: true }); ctx.poOpen = async () => { S.view = "po"; };
    await vm.runInContext("poAdd(TR, 'n5', false)", ctx); await tick();
    ok("④ 按 A1:草稿勾進(picked 多 n5)、金額格空著、不送 amounts;沒有預覽 → 只對這支送 stats_refresh;記 po_add",
      S.picked && S.picked.has("n5") && S.raw.n5 === "" && !sends.some((x) => x.cmd === "amounts") && J(sends.filter((x) => x.cmd === "stats_refresh").map((x) => x.args)) === J([{ names: ["n5"] }]) && feats.includes("po_add") && S.a1.has("n5"), J({ sends, feats }));
    S.edits.n5 = 100000; S.st.report.backtest_previews = { n5: pv5(true) };
    const f = open(); await f.box.onOk(); await tick();
    ok("④ 從 A1 進來的草稿存成功:記 po_add_saved;沒在跑不記 po_save_orders", feats.includes("po_add_saved") && !feats.includes("po_save_orders") && feats.includes("portfolio_save"), J(feats)); }
  { const S = bag({ edits: {} }); ctx.poOpen = async () => { S.view = "po"; };
    await vm.runInContext("poAdd(TR, 'n5', false)", ctx); await tick();
    ok("④ 已有最新那根的預覽:不送 stats_refresh", !sends.some((x) => x.cmd === "stats_refresh"), J(sends)); }
  { const S = bag(draft({ firing: true, paper: true })); const f = open(); await f.box.onOk(); await tick();
    ok("④ 按「儲存並下單」存成功:記 po_save_orders", feats.includes("po_save_orders"), J(feats)); }
  { const S = bag({ edits: {} }); ctx.poOpen = async () => { S.view = "po"; };
    await vm.runInContext("poAdd(TR, 'tw', true)", ctx);
    ok("④ 描邊那顆:只跳過去(不改草稿),記 po_add_go", S.picked === null && feats.includes("po_add_go"), J(feats)); }

  // 0.1.28 排練:剛加入的策略訊號空手 → 框不能只剩標題與兩顆鈕(s9_save_dialog);「才會進場」只在真的會進場時講(稽核 usfix2 P2-1)
  { const flat0 = (extra) => pvA("ETHUSDT", Object.assign({ position: 0, close: 3000 }, extra || {}));
    const SP = { name: "sp", displayName: "SP", hasBacktest: true, symbol: "ETHUSDT", market: "spot" };
    bag({ firing: true, picked: ["btc", "tw", "ec"], edits: { ec: 300 }, list: [EC], noPv: true, pvs: { ec: flat0() } });
    let f = open();
    ok("空手新策略(合約,在跑):「儲存金額」+「訊號出現時才會進場」、沒有列", f.title === "tr.cf.title" && f.rows.length === 0 && J(f.notes) === J(["cf-note:tr.cf.flat"]), J(f));
    bag({ picked: ["btc", "tw", "ec"], edits: { ec: 300 }, list: [EC], noPv: true, pvs: { ec: flat0() } });
    f = open();
    ok("…沒在跑(s9:尚未啟動、沒綁帳戶):只講前半句,不說「才會進場」", f.rows.length === 0 && J(f.notes) === J(["cf-note:tr.cf.flatNoOrder"]), J(f));
    bag({ halted: true, picked: ["btc", "tw", "ec"], edits: { ec: 300 }, list: [EC], noPv: true, pvs: { ec: flat0() } });
    f = open();
    ok("…暫停中:只講前半句(暫停那句照出)", f.notes.includes("cf-note:tr.cf.flatNoOrder") && !f.notes.some((x) => x === "cf-note:tr.cf.flat" || x === "cf-note:tr.cf.flatLong"), J(f));
    bag(draft({ firing: true, pv: { weights: { "2330": 0, "2454": 0 } } })); f = open();
    ok("…這家下不了(Binance 在跑、空手的台股組合):只講前半句", f.rows.length === 0 && J(f.notes) === J(["cf-note:tr.cf.flatNoOrder"]), J(f));
    bag({ firing: true, picked: ["btc", "tw", "sp"], edits: { sp: 300 }, list: [SP], noPv: true, pvs: { sp: flat0({ market: "spot" }) } });
    f = open();
    ok("空手新策略(現貨,只能做多):寫「訊號翻多時才會進場」", J(f.notes) === J(["cf-note:tr.cf.flatLong"]) && f.rows.length === 0, J(f));
    bag({ firing: true, picked: ["btc", "tw", "sp"], edits: { sp: 300 }, list: [SP], noPv: true, pvs: { sp: flat0({ market: "spot", position: -1 }) } });
    f = open();
    ok("現貨訊號是空單(壓成 0)也算空手:翻多那句(稽核 usfix2 P2-2)", f.rows.length === 0 && J(f.notes) === J(["cf-note:tr.cf.flatLong"]), J(f));
    bag({ firing: true, picked: ["btc", "tw", "ec"], edits: { ec: 300 }, list: [EC], noPv: true, pvs: { ec: flat0({ position: -1 }) } });
    f = open();
    ok("對照:合約空單照列賣單、不出空手那句", f.rows.some((x) => /^tr\.cf\.sellETHUSDT/.test(x)) && !f.notes.some((x) => /tr\.cf\.flat/.test(x)), J(f));
    const PS = { name: "ps", displayName: "PS", hasBacktest: true, symbol: null, portfolio: true, market: "spot", universe: ["ETHUSDT", "SOLUSDT"] };
    bag({ firing: true, picked: ["btc", "tw", "ps"], edits: { ps: 300 }, list: [PS], noPv: true,
      pvs: { ps: { type: "portfolio", market: "spot", weights: { ETHUSDT: 0, SOLUSDT: -0.5 }, closes: { ETHUSDT: 3000, SOLUSDT: 90 }, bar_at: BAR, bar_date: "2026-10-16", latest: true } } }); f = open();
    ok("空手新投資組合(現貨,權重 0 與負權重壓 0):翻多那句", f.title === "tr.cf.title" && f.rows.length === 0 && f.notes.includes("cf-note:tr.cf.flatLong"), J(f));
    bag({ firing: true, picked: ["btc", "tw", "ec"], edits: { ec: 300 }, list: [EC], noPv: true, pvs: { ec: flat0({ position: 1 }) } });
    f = open();
    ok("對照:新策略有部位 → 照列、不出空手那句", f.rows.length === 1 && !f.notes.some((x) => /tr\.cf\.flat/.test(x)), J(f));
    bag({ picked: ["btc", "tw", "ec"], edits: { ec: 300 }, list: [EC], noPv: true, pvs: { ec: flat0({ latest: false }) }, firing: true });
    f = open();
    ok("對照:預覽不是最新那根(框保守寫儲存並下單)→ 不說「不會下單」", f.title === "tr.cf.titleFire" && !f.notes.some((x) => /tr\.cf\.flat/.test(x)), J(f)); }
  // 0.1.28 排練:股票永續(us_stock 策略下 NVDAUSDT)數量寫「股」、照交易所小數(s17_save_dialog_long);加密照「顆」
  { const NV = { name: "nv", displayName: "NV", hasBacktest: true, symbol: "NVDAUSDT", market: "swap" }, kinds = { strategy_kinds: { nv: { market: "us_stock" } } };
    const pvN = pvA("NVDAUSDT", { close: 220.21, daily_us: true });
    bag({ firing: true, picked: ["btc", "tw", "nv"], edits: { nv: 200 }, list: [NV], noPv: true, pvs: { nv: pvN }, rep: kinds });
    let f = open();
    ok("股票永續會送單:買進 NVDAUSDT 0.9082 股(不捨去成整股)", J(f.rows) === J(["tr.cf.buyNVDAUSDT0.9082 tr.cf.unitShares"]), J(f));
    bag({ picked: ["btc", "tw", "nv"], edits: { nv: 200 }, list: [NV], noPv: true, pvs: { nv: pvN }, rep: kinds });
    f = open();
    ok("股票永續原 → 新:小字也寫股", J(f.rows) === J(["NVDAUSDT2000.9082 tr.cf.unitShares"]), J(f));
    bag({ env: "cloud", firing: true, picked: ["btc", "tw", "nv"], edits: { nv: 200 }, list: [Object.assign({ srcMarket: "us_stock" }, NV)], noPv: true, pvs: { nv: pvN } });
    f = open();
    ok("雲端(市場讀清單 srcMarket):同樣寫股", f.rows.some((x) => /NVDAUSDT0\.9082 tr\.cf\.unitShares$/.test(x)), J(f));
    bag({ firing: true, picked: ["btc", "tw", "nv"], edits: { nv: 200 }, list: [NV], noPv: true, pvs: { nv: pvN } });
    f = open();
    ok("對照:不是 us_stock 的策略(加密市場)照寫顆", J(f.rows) === J(["tr.cf.buyNVDAUSDT0.9082 tr.cf.unitCoins"]), J(f)); }

  /* ── 存檔後的路由(Wei 10-22):框的「新」那側照存檔後的路由算,列出的單 = 存檔後對帳器實際會送的單。
     對照端 tests/_cf_lib_after.py 在同一個 workspace 裡跑:真的 reporter(venues、strategy_states、save_routing)餵畫面,
     真的 runtime 存檔(command_listener._cmd_amounts)＋對帳器讀目標(lib/portfolio.aggregate_portfolio)給答案。
     會送的單 = 目標 − 帳上,過下單門檻 10 才算。沒在跑時框不列單,改列目標「原 → 新」,新值要等於存檔後對帳器的目標(按啟動就照它下) */
  { const { spawnSync } = require("child_process"), ROOT = path.join(__dirname, "..");
    const PY = process.env.BLAVE_TEST_PYTHON || (fs.existsSync(path.join(ROOT, ".venv", "bin", "python")) ? path.join(ROOT, ".venv", "bin", "python") : "python3");
    const BTC_PX = 50000;
    const lib = (sc) => { const p = spawnSync(PY, [path.join(__dirname, "_cf_lib_after.py")], { input: J(sc), encoding: "utf8" });
      try { return JSON.parse(String(p.stdout).trim().split("\n").pop()); } catch (_) { return { error: "helper: " + String(p.stderr).slice(-300) }; } };
    const num = (s) => { const m = /^-?[\d,]*\.?\d+/.exec(String(s)); return m ? Number(m[0].replace(/,/g, "")) : NaN; };
    const boxRows = () => { const b = ctx.BOX; if (!b) return { opened: false, fire: false, orders: [], changes: {}, arrows: {} };
      const dl = flat(b.extra).filter((n) => n.tag === "dl" && n.className === "cf-rows cf-amt"), rows = dl.length ? dl[0].kids.filter((k) => k && /^cf-row/.test(k.className)) : [];
      const orders = [], changes = {}, arrows = {};
      rows.forEach((row) => { const [dt, dd] = row.kids, side = dt.kids.find((k) => k && /^side /.test(k.className)), n = dd.kids.find((k) => k && k.className === "n");
        const sym = dt.textContent.replace(side ? side.textContent : "", ""), was = dd.kids.find((k) => k && k.className === "was");
        if (side) orders.push({ side: side.className.slice(5), sym, qty: num(n.textContent) }); else { changes[sym] = num(n.textContent); arrows[sym] = was ? num(was.textContent) : null; } });
      return { opened: true, fire: b.title === "tr.cf.titleFire", orders, changes, arrows }; };
    const isV = (v) => !!v && v.credentials && v.pair && v.order && v.account;
    const run = (sc) => {
      const L = lib(sc);
      if (!L.report) return { L, B: null };
      const ids = Object.keys(L.report.venues).filter((id) => isV(L.report.venues[id])).sort();
      const S = bag({ firing: sc.firing, halted: sc.halted, paper: ids[0] === "paper" }), r = S.st.report;
      r.venues = L.report.venues; r.states = L.report.states; r.config = JSON.parse(J(sc.before));
      if (sc.oldRuntime) delete r.save_routing; else r.save_routing = L.report.save_routing;
      r.account = { read_at: now, venues: Object.fromEntries(ids.map((v) => [v, { ok: true, equity: 1e6, currency: "USDT",
        positions: Object.assign({ BTCUSDT: { side: "long", size: 0, mark_price: BTC_PX } }, sc.book || {}) }])) };
      r.last_reconcile = ids.length ? { ts: new Date(now * 1000).toISOString().slice(0, 19), actual: {}, target: {}, gates: {} } : null;
      if (!sc.firing && !sc.halted && ids.length) r.daemon = { reconciler: { running: false } };
      S.list = Object.keys(sc.strategies).map((n) => { const x = sc.strategies[n], tw = !x.symbol || /^\d{4}/.test(x.symbol);
        return { name: n, displayName: n, hasBacktest: true, symbol: x.symbol || null, market: x.market || "swap", portfolio: !x.symbol, universe: x.weights ? Object.keys(x.weights) : [],
          twd: tw, twdAll: tw, srcMarket: tw ? "tw_stock" : "crypto" }; });
      r.quote_ccy = Object.fromEntries(S.list.map((x) => [x.name, x.twd ? "TWD" : "USDT"]));
      S.edits = {}; Object.keys(sc.send).forEach((n) => { if (sc.send[n] !== sc.before.amounts[n]) S.edits[n] = sc.send[n]; });
      open(); return { L, B: boxRows() };
    };
    const canon = (k) => k.replace(/@spot$/, "");
    const pxOf = (L, sym) => { if (sym === "BTCUSDT") return BTC_PX; for (const n of Object.keys(L.report.states)) { const rc = L.report.states[n].raw_closes; if (rc && rc[sym] > 0) return rc[sym]; } return null; };
    const bookOf = (sc) => Object.fromEntries(Object.keys(sc.book || {}).map((k) => [k, sc.book[k].side === "short" ? -sc.book[k].size : sc.book[k].size]));
    const wantOrders = (L, sc) => { const bk = bookOf(sc);
      return Object.keys(L.targets).concat(Object.keys(bk)).filter((k, i, a) => a.indexOf(k) === i).map((k) => ({ k, d: (L.targets[k] || 0) - (bk[k] || 0) }))
        .filter((x) => Math.abs(x.d) >= 10).map(({ k, d }) => { const sym = canon(k), px = pxOf(L, sym), q = Math.abs(d) / px;
          return { side: d > 0 ? "buy" : "sell", sym, qty: /^\d{4}/.test(sym) ? Math.floor(q + 1e-9) : q }; }).filter((o) => o.qty > 0).sort((a, b) => (a.sym < b.sym ? -1 : 1)); };
    const sameOrders = (a, b) => a.length === b.length && a.slice().sort((x, y) => (x.sym < y.sym ? -1 : 1)).every((o, i) => o.side === b[i].side && o.sym === b[i].sym && Math.abs(o.qty - b[i].qty) <= 1e-6 * Math.max(1, b[i].qty));
    const wantChanges = (L) => { const out = {}; Object.keys(L.before).concat(Object.keys(L.targets)).forEach((k) => { const a = L.before[k] || 0, b = L.targets[k] || 0;
      if (Math.round(a) !== Math.round(b)) out[canon(k)] = Math.round(b); }); return out; };
    const BTC = { symbol: "BTCUSDT", market: null, position: 1 }, TW = { symbol: "2330", market: null, position: 1, raw_closes: { 2330: 1000 } };   // 台股策略不寫 MARKET(實際的樣子:回報 swap、清單 srcMarket tw_stock)
    const PC = { weights: { 2330: 0.6, 2603: -0.4 }, market: null, raw_closes: { 2330: 1000, 2603: 200 } }, TWS = { symbol: "2603", market: null, position: -1, raw_closes: { 2603: 200 } };
    const both = { btc: 500, tw: 100000 }, blank2 = { btc: "", tw: "" }, P = { env: ["paper"], manifest: ["paper"] }, BN = { env: ["binance"], manifest: ["binance"] };
    const cases = [
      ["綁模擬帳戶、沒路由(綁之前存的)、下單程式還沒啟動", { ...P, firing: false, before: { amounts: both, exchanges: blank2 }, send: both, strategies: { btc: BTC, tw: TW } }],
      ["綁模擬帳戶、沒路由、下單程式在跑", { ...P, firing: true, before: { amounts: both, exchanges: blank2 }, send: both, strategies: { btc: BTC, tw: TW } }],
      ["綁模擬帳戶、沒路由、暫停中(0.1.28 Wei 實測的狀態)", { ...P, firing: false, halted: true, before: { amounts: both, exchanges: blank2 }, send: both, strategies: { btc: BTC, tw: TW } }],
      ["綁真實交易所(Binance)、沒路由、在跑", { ...BN, firing: true, before: { amounts: { btc: 500 }, exchanges: { btc: "" } }, send: { btc: 500 }, strategies: { btc: BTC } }],
      ["綁真實交易所(Binance)、沒路由、還沒啟動", { ...BN, firing: false, before: { amounts: { btc: 500 }, exchanges: { btc: "" } }, send: { btc: 800 }, strategies: { btc: BTC } }],
      ["已有路由(模擬帳戶)、在跑、改金額", { ...P, firing: true, before: { amounts: both, exchanges: { btc: "paper", tw: "paper" } }, send: { btc: 800, tw: 100000 }, strategies: { btc: BTC, tw: TW } }],
      ["已有路由(Binance)、在跑、改金額", { ...BN, firing: true, before: { amounts: { btc: 500 }, exchanges: { btc: "binance" } }, send: { btc: 800 }, strategies: { btc: BTC } }],
      ["帳上有部位(Binance 多 300):單 = 目標 800 − 帳上 300", { ...BN, firing: true, before: { amounts: { btc: 500 }, exchanges: { btc: "binance" } }, send: { btc: 800 }, strategies: { btc: BTC },
        book: { BTCUSDT: { side: "long", size: 300, mark_price: BTC_PX } } }],
      ["同時綁兩家、沒路由:runtime 不知道繼承誰、照樣沒路由", { env: ["binance", "paper"], manifest: ["binance", "paper"], firing: true, before: { amounts: both, exchanges: blank2 }, send: both, strategies: { btc: BTC, tw: TW } }],
      ["稽核 S3:.env 有 Binance＋模擬、綁定清單只有模擬 → runtime 繼承模擬", { env: ["binance", "paper"], manifest: ["paper"], firing: true, before: { amounts: { btc: 500 }, exchanges: { btc: "" } }, send: { btc: 500 }, strategies: { btc: BTC } }],
      ["稽核 S4:綁了沒有 lib 的交易所＋模擬(清單兩家都有)→ runtime 不繼承", { env: ["kucoin", "paper"], manifest: ["kucoin", "paper"], libs: { paper: ["order", "account"] }, firing: true,
        before: { amounts: { btc: 500 }, exchanges: { btc: "" } }, send: { btc: 500 }, strategies: { btc: BTC } }],
      ["投資組合(Type C,台股一多一空)、綁模擬帳戶、沒路由、在跑:空頭壓 0", { ...P, firing: true, before: { amounts: { pc: 1000000 }, exchanges: { pc: "" } }, send: { pc: 1000000 }, strategies: { pc: PC } }],
      ["單一標的台股做空、綁模擬帳戶、沒路由、在跑:現股不放空、不下單", { ...P, firing: true, before: { amounts: { tws: 100000 }, exchanges: { tws: "" } }, send: { tws: 100000 }, strategies: { tws: TWS } }],
      ["舊 runtime(報告沒有 save_routing):退回自己推,單一模擬帳戶照樣對", { ...P, firing: true, oldRuntime: true, before: { amounts: both, exchanges: blank2 }, send: both, strategies: { btc: BTC, tw: TW } }],
    ];
    for (const [name, sc] of cases) {
      const { L, B } = run(sc);
      if (L.error) { ok("存檔後的路由 · " + name + ":對照端(runtime 存檔＋lib 目標)跑得起來", false, L.error); continue; }
      if (sc.firing) {
        const want = wantOrders(L, sc);
        ok("存檔後的路由 · " + name + ":框列出的單 = 存檔後對帳器會送的單", sameOrders(B.orders, want) && B.fire === want.length > 0, J({ box: B, want, lib: L }));
      } else {
        ok("存檔後的路由 · " + name + ":不列單(標題不是儲存並下單);目標的新值 = 存檔後對帳器的目標", B.opened && !B.fire && B.orders.length === 0 && J(B.changes) === J(wantChanges(L)), J({ box: B, want: wantChanges(L), lib: L }));
      }
    }
    { const sc = { ...P, firing: true, before: { amounts: { btc: 500 }, exchanges: { btc: "" } }, send: { btc: 500 }, strategies: { btc: BTC } };
      const a = run(sc).B, b = run({ ...sc, env: ["kucoin", "paper"], manifest: ["kucoin", "paper"], libs: { paper: ["order", "account"] } }).B;
      ok("存檔後的路由 · 綁定集合讀報告的 save_routing:同一份畫面綁定,runtime 的集合不同,框跟著 runtime(單一模擬列單、多綁 kucoin 不列)", a.orders.length === 1 && b.orders.length === 0 && !b.fire, J([a, b])); }
    { const { L, B } = run({ env: [], manifest: [], firing: false, before: { amounts: both, exchanges: blank2 }, send: { btc: 500, tw: 200000 }, strategies: { btc: BTC, tw: TW } });
      ok("存檔後的路由 · 沒綁交易所:框不列單;存檔後對帳器也一筆都不送(沒路由的目標全 0)", !L.error && B.opened && !B.fire && B.orders.length === 0 && Object.keys(L.targets).every((k) => L.targets[k] === 0), J({ box: B, lib: L })); }
    { const { L, B } = run({ env: ["sinopac"], manifest: ["sinopac"], libs: { sinopac: ["order"] }, firing: false, before: { amounts: { tw: 100000 }, exchanges: { tw: "" } }, send: { tw: 100000 }, strategies: { tw: TW } });
      // runtime 存檔照樣路由 sinopac,但對帳器接線(lib/venue_wiring.official_venues)要 order_ 與 account_ 兩支 lib 才算綁著:一筆都不送
      ok("存檔後的路由 · 稽核 S7:只綁 sinopac(只有下單 lib):runtime 路由 sinopac、對帳器接不上不送單;框也一筆單都不列(畫面沒有這家帳戶,照只看訊號直接存)",
        !L.error && L.exchanges.tw === "sinopac" && !B.fire && B.orders.length === 0, J({ box: B, lib: L })); }
    { const { B } = run(cases[2][1]);
      ok("存檔後的路由 · 暫停中原樣按儲存:框照開、2330 寫「0 → 100,000」(已存的策略現況 0 也畫箭頭,設計稽核 S3)", B.opened && B.changes["2330"] === 100000 && B.arrows["2330"] === 0, J(B)); } }

  // ── 字串:兩語都有、中文全形
  { const keys = ["tr.cf.title", "tr.cf.titleFire", "tr.cf.capOrders", "tr.cf.capOrdersOpen", "tr.cf.capChanges", "tr.cf.asofClose", "tr.cf.asofBar", "tr.cf.buy", "tr.cf.sell", "tr.cf.unitShares", "tr.cf.unitCoins", "tr.cf.flat", "tr.cf.flatLong", "tr.cf.flatNoOrder", "tr.cf.codeChanged", "tr.cf.hostOld", "tr.cf.hostOldCloud", "tr.cf.late", "tr.cf.firstRead", "tr.cf.oldPv", "tr.cf.held", "tr.cf.gated", "po.unsaved", "po.willOrder", "po.live", "po.add", "po.addGo"];
    ok("字串:新 key 兩語都有;標題與主鈕同字(儲存並下單)", keys.every((k) => S0.en[k] && S0.zh[k]) && S0.zh["tr.cf.titleFire"] === "儲存並下單" && S0.zh["tr.cf.title"] === "儲存金額" && S0.zh["po.add"] === "加到策略組合",
      J(keys.filter((k) => !S0.en[k] || !S0.zh[k]))); }
  console.log(red ? `\n${red} FAILED` : "\nall checks passed");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
