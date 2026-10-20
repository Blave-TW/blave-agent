// 選擇策略框的勾選是草稿(0.1.26 Wei):按「確定」不寫 amounts,按「儲存」才連金額一起寫;還原丟掉草稿;移除成員也要儲存才生效。
// 從 trade.js 原文切出真的 psApply / trAmountTable / trSaveAmounts / poSigTable 跑在假 DOM 上,主機那一端是記錄 tradeSend 的假 api。不起 Electron。
// 跑法:node tests/check_shell_pick_draft.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "trade.js"), "utf8");
let red = 0; const ok = (name, c, info) => { console.log((c ? "PASS  " : "FAIL  ") + name + (c || !info ? "" : "\n      " + info)); if (!c) red++; };
const J = JSON.stringify;
const block = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b); if (i < 0 || j < 0) throw new Error("找不到標記:" + a); return src.slice(i, j); };
const cutF = (n) => { const i = src.indexOf("function " + n + "("); if (i < 0) throw new Error("no " + n); let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return (src.slice(i - 6, i) === "async " ? "async " : "") + src.slice(i, k + 1); } throw new Error("no " + n); };

const node = (tag) => { const n = { tag, id: "", className: "", kids: [], text: "", attrs: {}, hidden: false, disabled: false, value: "", parentNode: null, dataset: {}, title: "", on: {},
  classList: { toggle() {}, add(c) { n.className += " " + c; }, remove() {}, contains: () => false }, appendChild(c) { if (c && typeof c === "object") c.parentNode = n; n.kids.push(c); return c; },
  append(...c) { c.forEach((x) => n.appendChild(x)); }, insertAdjacentElement() {}, remove() {}, insertBefore(c) { n.kids.push(c); return c; }, focus() {},
  querySelector() { return { title: "" }; }, setAttribute(k, v) { n.attrs[k] = v; }, removeAttribute(k) { delete n.attrs[k]; }, addEventListener(e, f) { n.on[e] = f; },
  get nextSibling() { return null; }, get textContent() { return n.text + n.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }, set textContent(v) { n.text = v; n.kids = []; } }; return n; };
const flat = (n, out = []) => { if (n && n.tag) { out.push(n); n.kids.forEach((k) => flat(k, out)); } return out; };

// 選擇策略框:checkbox 只要 checked / value
let picks = [];
const psList = { querySelectorAll: () => picks.map((v) => ({ checked: true, value: v })) };
const sends = [];
// 配置分頁:psApply 確定後找新列金額格用;FOCUSED 記最後拿到焦點的是誰
const poCfg = { querySelectorAll: (sel) => (sel === ".amt-in" ? ["a", "z", "new1"].map((n) => ({ dataset: { amt: n }, offsetParent: {}, disabled: false, focus() { ctx.FOCUSED = "amt:" + n; } })) : []) };
const ctx = vm.createContext({ document: { createElement: node, createElementNS: (_ns, tag) => node(tag), createDocumentFragment: () => node("#frag") }, Date, Math, JSON, Array, Object, Number, String, Set, isFinite, console, setTimeout, clearTimeout,
  $: (id) => (id === "ps-list" ? psList : id === "po-cfg" ? poCfg : { focus() {}, hidden: false }), t: (k, o) => k + (o ? " " + JSON.stringify(o) : ""), LANG: "zh", PAPER: "paper", BINANCE: "binance", CX_VENUES: { binance: { label: "Binance" } },
  srSay() {}, trIsPaper: () => false, trackFeature() {}, trPollSoon() {}, envPaintLocalDots() {}, ENV: { sig: {} }, psClose() {}, psRefocus() { ctx.FOCUSED = "pick-btn"; }, mgSetMembers() {},
  PAINTS: 0, poPaintCfg() { ctx.PAINTS++; }, confirmBox(o) { ctx.BOX = o; }, trCloudBox: (o) => o, trWith: (S, f) => f(), TR_STALE_MS: 600000 });
ctx.psMode = "amounts";
vm.runInContext("function trUnit() { return 'USDT'; } function trCcy() { return 'USDT'; } function trEquity() { return 10000; }", ctx);
const pure = block("/* ── 純邏輯(", "/* ── 純邏輯到此") + block("/* ── 視角純邏輯(", "/* ── 視角純邏輯到此");
vm.runInContext("var delCtx = null;\n" + (src.match(/^const TR_CF = [^\n]*\n/m) || [""])[0].replace(/^const /, "var "), ctx);
vm.runInContext(pure.replace(/^const /gm, "var ") + "\nvar trTipSeq = 0, psMode = 'amounts', psToAmt = false;\n" + ["trEl", "trSec", "trTipLabel", "poHelpGroup", "poCfgSec", "trHead", "trFmt", "trFmt2", "trFmtPrice", "trMoneyInto", "trReport", "trContracts", "trStored", "trBase", "trNamesOf", "trNames",
  "trListNames", "trDisplay", "trPickOff", "trPickBtn", "trVenueId", "trVenueLabel", "trVenueKind", "trTwBroker", "trStratName", "trTwNamesWant", "trTwName", "trTwNameEl", "trTxfWant", "trRowTxf", "trRowTxfNew", "trCtPend", "trCtStored", "trCt", "trCtGate", "trCtDirty", "trCtRollTag",
  "trRowMoneyStored", "trCtPayload", "trRowIsLot", "trRowMoney", "trLotsFmt", "trLotsTgtFmt", "trLotsInto", "trQuoteMap", "trNoSignalYet", "trZoneOf", "trZoneLabel", "trZoneUnit", "trFxView", "trZoneSum", "trTotalText",
  "trPaintPosCell", "trAmountTable", "trGoStartKey", "trTradableFunded", "trUnrouted", "trRouteDirty", "trCloseTag", "trStratHeld", "trPaperTwOk", "trPaperTw", "trCtCloseTag", "trSaveAmounts", "trCfStates", "trCfHolds", "trCfAsof", "trMarks", "trCfQty", "trCfRows", "trCfTick", "trCfMD", "trPvRequest", "trLivePositions", "trBook", "trTwClosedKeys", "trGatedKeys", "trAwaitKeys", "poPartStates", "poSigTable", "trPosDetail", "trManualPart",
  "trPlanTotal", "trTxfPrice", "trNetRows", "trWithUnit", "trCatchWill", "trGateSide", "trTradesSym", "trAppRestartQuiet", "trAmountsEdited", "trSentBeforeOf", "psApply", "trCtReported", "trSentCheck", "trWith", "trUnsavedAny"].map(cutF).join("\n"), ctx);

// 這台電腦、沒連交易所(儲存不開確認框,直接送);已存:a 有錢、z 金額 0。new1 是回測過、還沒進組合的
const report = () => ({ venues: {}, config: { amounts: { a: 500, z: 0 } }, scheduled: ["a", "z"], quote_ccy: { a: "USDT", z: "USDT", new1: "USDT" },
  states: { a: { symbol: "BTCUSDT", position: 1 }, z: { symbol: "SOLUSDT", position: 1 }, new1: { symbol: "ETHUSDT", position: 1 } }, account: { read_at: Math.floor(Date.now() / 1000), venues: {} } });
const fresh = () => {
  sends.length = 0; ctx.BOX = null; ctx.PAINTS = 0;
  const S = { env: "local", open: true, view: "po", listLoaded: true, picked: null, sent: null, save: null, saveErr: null, edits: {}, bad: {}, raw: {}, sig: {}, reqIds: {}, reqFor: {}, ct: { edits: {}, basis: {}, sent: null }, just: { picked: {}, removed: {} },
    list: ["a", "z", "new1"].map((n) => ({ name: n, displayName: n.toUpperCase(), hasBacktest: true, symbol: { a: "BTCUSDT", z: "SOLUSDT", new1: "ETHUSDT" }[n] })),
    st: { alive: true, report: report() } };
  // 假主機:收到 amounts 就照寫進設定檔(runtime _cmd_amounts:整份覆蓋)
  S.api = { tradeSend: async (cmd, args) => { sends.push({ cmd, args: JSON.parse(J(args)) }); if (cmd === "amounts") { S.st.report.config.amounts = Object.assign({}, args.amounts); S.st.report.scheduled = Object.keys(args.amounts); } return { ok: true }; },
    tradeStatus: async () => S.st };
  ctx.TR = S; ctx.TR_BAGS = { local: S, cloud: {} }; vm.runInContext("TR = this.TR; TR_BAGS = this.TR_BAGS;", ctx); return S;
};
const pick = (names) => { picks = names; vm.runInContext("psApply()", ctx); };
const table = () => flat(vm.runInContext("trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx));
const bar = (f) => f.find((n) => n.className === "pf-savebar");
const btn = (f, fk) => f.find((n) => n.dataset && n.dataset.fk === fk);
const dot = (S, n) => vm.runInContext(`envRunDot(${J(n)}, TR.st, Date.now(), TR.just)`, ctx);
const sigSyms = () => flat(vm.runInContext("poSigTable(TR.st.report, trStored() || {}, TR.st.report.states, 'cfg')", ctx)).filter((n) => n.tag === "td").map((n) => n.textContent).join("|");
// 0.1.27 起存金額一律開框(只有什麼都沒變才直接存;canon 確認 modal):開了就按主鈕
const save = async (f) => { ctx.BOX = null; btn(f, "save").on.click(); if (ctx.BOX) await ctx.BOX.onOk(); for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

(async () => {
  // ① 確定後不寫入
  { const S = fresh(); S.save = "saved";
    pick(["a", "z", "new1"]);
    const f = table(), b = bar(f);
    ok("① 勾 new1 按確定:不送任何指令,主機設定檔不變", sends.length === 0 && J(S.st.report.config.amounts) === J({ a: 500, z: 0 }), J(sends));
    ok("① 表上照列 new1、可以填金額;儲存列出現(還原 + 儲存),「已儲存」那行收掉", vm.runInContext("trNames()", ctx).indexOf("new1") >= 0 && f.some((n) => n.className === "amt-in" && !n.disabled && /^NEW1 — /.test(n.attrs["aria-label"] || ""))
      && !!b && !b.hidden && !!btn(f, "revert") && !!btn(f, "save") && S.save === null, J({ hidden: b && b.hidden, save: S.save }));
    ok("① 側欄不亮燈(呼吸點只看已存的 + 存成功那一刻的標記)、總訊號部位沒有 new1 的標的", dot(S, "new1") === false && dot(S, "a") === true && !/ETHUSDT/.test(sigSyms()) && /BTCUSDT/.test(sigSyms()), sigSyms());
    ok("① 等回報那句的判準(trAmountsEdited)也認得草稿", vm.runInContext("trAmountsEdited()", ctx) === true); }

  // ① 焦點(設計稽核 P2,同網頁):新勾了 → 第一支新列的金額格;只取消勾選 → 回〔選擇策略〕
  { fresh(); ctx.FOCUSED = null; pick(["a", "new1", "z"]); const f1 = ctx.FOCUSED;
    fresh(); ctx.FOCUSED = null; pick(["a"]); const f2 = ctx.FOCUSED;
    const inp = (fresh(), pick(["a", "z", "new1"]), table().find((n) => n.className === "amt-in" && n.dataset.amt === "new1"));
    ok("① 確定後焦點:新勾了落在新列金額格(data-amt 認列);只取消勾選回〔選擇策略〕鈕", f1 === "amt:new1" && f2 === "pick-btn" && !!inp, J({ f1, f2 })); }

  // ② 儲存後才寫入:成員與金額同一份 amounts
  { const S = fresh();
    pick(["a", "z", "new1"]); S.edits.new1 = 300;
    await save(table());
    ok("② 按儲存:一次送一份 amounts,新勾的 new1 帶著金額一起寫進去", sends.length === 1 && sends[0].cmd === "amounts" && J(sends[0].args.amounts) === J({ a: 500, z: 0, new1: 300 }), J(sends));
    ok("② 存好之後:草稿交回(picked null)、new1 亮燈、總訊號部位出現 new1 的標的", S.picked === null && dot(S, "new1") === true && /ETHUSDT/.test(sigSyms()), J({ picked: S.picked, sig: sigSyms() })); }
  { const S = fresh();
    pick(["a", "z", "new1"]);
    await save(table());
    ok("② 金額 0 也照存(跟原本的規則一樣:key 在 = 在組合裡)", sends.length === 1 && J(sends[0].args.amounts) === J({ a: 500, z: 0, new1: 0 }) && dot(S, "new1") === true, J(sends)); }

  // ③ 還原丟掉草稿
  { const S = fresh();
    pick(["a", "z", "new1"]); S.edits.new1 = 300;
    btn(table(), "revert").on.click();
    const f = table();
    ok("③ 還原:新勾的那列消失、什麼都沒送、儲存列收起", S.picked === null && vm.runInContext("trNames()", ctx).indexOf("new1") < 0 && sends.length === 0 && bar(f).hidden === true && dot(S, "new1") === false, J({ picked: S.picked, sends })); }

  // ④ 移除成員也要儲存才生效(金額 0 的也一樣)
  { const S = fresh();
    pick(["a"]);
    const f = table();
    ok("④ 取消勾選 z($0)按確定:不送、z 照樣亮燈(主機還在算它)、儲存列出現", sends.length === 0 && dot(S, "z") === true && !bar(f).hidden && J(S.st.report.config.amounts) === J({ a: 500, z: 0 }), J(sends));
    await save(f);
    ok("④ 按儲存:送出的 amounts 沒有 z,z 熄燈", sends.length === 1 && J(sends[0].args.amounts) === J({ a: 500 }) && dot(S, "z") === false, J(sends)); }
  { const S = fresh(); S.st.report.config.amounts = { z: 0 }; S.st.report.scheduled = ["z"];
    pick([]);
    const f = table();
    ok("④ 把唯一一支 $0 成員取消勾選:表空,但儲存列照畫(移出要送得出去),也不上霧", sends.length === 0 && !bar(f).hidden && !!btn(f, "save")
      && /!names\.length && !trPickDirty\(TR\.picked, stored, /.test(cutF("poPaintCfg")), J(sends));
    await save(f);
    ok("④ 按儲存:送出空的 amounts", sends.length === 1 && J(sends[0].args.amounts) === J({}), J(sends)); }

  // ⑤ 確認框:新勾的列標「加入」;已存沒變的不列(0.1.27 canon 確認 modal:表只列會變的,推翻 0124 D2 的「沒變的退灰」)
  { const S = fresh(); S.st.report.venues = { binance: { credentials: true, pair: true, order: true, account: true } };
    pick(["a", "z", "new1"]);
    btn(table(), "save").on.click();
    const rows = ctx.BOX ? flat(ctx.BOX.extra).filter((n) => /^cf-row( |$)/.test(n.className)) : [], r = rows.find((n) => /^NEW1/.test(n.textContent));
    ok("⑤ 確認框:new1 那列標 tr.cfTagAdd(金額 0 也算會變);已存沒變的 a、z 不列", !!r && /tr\.cfTagAdd/.test(r.textContent) && !rows.some((n) => /^(A|Z)/.test(n.textContent)), J(rows.map((n) => [n.className, n.textContent])));
    ok("⑤ 框還沒按確定:沒有送出", sends.length === 0); }

  // ⑥ 讀不到設定時按確定:不記草稿
  { const S = fresh(); S.st.report.config = null;
    pick(["a", "z", "new1"]);
    ok("⑥ config: null 時按確定:不記草稿、不送", S.picked === null && sends.length === 0); }

  // ⑧ 雲端存完、主機 30 秒都沒套用(timeout):草稿照樣交回,表改畫主機上的值、儲存列講「主機還沒套用」
  { const C = { env: "cloud", list: [{ name: "a" }, { name: "z" }, { name: "new1" }], picked: new Set(["a", "z", "new1"]), sent: { a: 500, z: 0, new1: 0 }, sentAt: Date.now() - 60000, sentBefore: { a: 500, z: 0 },
      save: "sent", sig: {}, ct: { sent: null }, reqIds: {}, notApplied: null, st: { cloud: { code: "OK", machine: { state: "running" } }, report: { config: { amounts: { a: 500, z: 0 } } } } };
    ctx.C = C; vm.runInContext("trSentCheck(this.C, Date.now())", ctx);
    ok("⑧ timeout:picked 放掉、notApplied 記下送出的那一份", C.picked === null && C.sent === null && J(C.notApplied) === J({ a: 500, z: 0, new1: 0 }), J({ picked: C.picked && [...C.picked], na: C.notApplied })); }

  // ⑧b 雲端存檔 ack ok 就點的燈:回報是 timeout(主機沒套用)或 changed(別處改過)時收回;same 才留著(稽核 v026 M2)
  { const mk = (amounts, ageMs) => { const now = Date.now(), C = { env: "cloud", list: [{ name: "a" }, { name: "z" }, { name: "new1" }], picked: null, sent: { a: 500, new1: 0 }, sentAt: now - ageMs, sentBefore: { a: 500, z: 0 },
        save: "sent", sig: {}, ct: { sent: null }, reqIds: {}, notApplied: null, just: { picked: {}, removed: {} }, st: { cloud: { code: "OK", machine: { state: "running" } }, report: { config: { amounts }, scheduled: Object.keys(amounts) } } };
      vm.runInContext("envJustMark", ctx)(C.just, C.sentBefore, C.sent, now);
      ctx.C = C; vm.runInContext("trSentCheck(this.C, Date.now())", ctx);
      const dot = (n) => { ctx.C2 = C; return vm.runInContext(`envRunDot(${J(n)}, C2.st, Date.now(), C2.just)`, ctx); };
      return { C, newDot: dot("new1"), zDot: dot("z") }; };
    const to = mk({ a: 500, z: 0 }, 60000), ch = mk({ a: 900 }, 1000), same = mk({ a: 500, new1: 0 }, 1000);
    ok("⑧b timeout:剛加入的 new1 不再強制亮、剛移出的 z 不再強制熄(照主機回報:z 還在 → 亮)", to.newDot === false && to.zDot === true && !("new1" in to.C.just.picked) && !("z" in to.C.just.removed), J(to.C.just));
    ok("⑧b changed(別處改過):同樣收回,照主機回報畫", ch.newDot === false && !("new1" in ch.C.just.picked) && !("z" in ch.C.just.removed), J(ch.C.just));
    ok("⑧b same(回報對上):燈照常(new1 亮、z 熄)", same.newDot === true && same.zDot === false && "new1" in same.C.just.picked, J(same.C.just)); }

  // ⑨ 畫面那一端:trUnsavedAny 看兩個視角的草稿與金額(主行程結束 / 關窗前來問的就是它)
  { const S = fresh(); ctx.TR_BAGS.cloud = { env: "cloud", list: [], listLoaded: false, picked: null, sent: null, edits: {}, bad: {}, raw: {}, sig: {}, ct: { edits: {}, basis: {}, sent: null }, st: { report: { config: { amounts: {} } } } };
    vm.runInContext("TR_BAGS = this.TR_BAGS;", ctx);
    const any = () => vm.runInContext("trUnsavedAny()", ctx);
    const clean = any();
    pick(["a", "z", "new1"]); const drafted = any();
    btn(table(), "revert").on.click(); const reverted = any();
    S.edits.a = 700; const edited = any(); S.edits = {};
    ctx.TR_BAGS.cloud.picked = new Set(["x"]); const cloudDraft = any(); ctx.TR_BAGS.cloud.picked = null;
    ok("⑨ trUnsavedAny:沒改 false;勾了草稿 true;還原後 false;只改金額 true;另一個視角(雲端)有草稿也算", clean === false && drafted === true && reverted === false && edited === true && cloudDraft === true,
      J({ clean, drafted, reverted, edited, cloudDraft })); }

  // ⑩ 主行程:關窗 / 結束時有沒存的草稿 → 擋下、跳「還沒儲存，要離開嗎？」;選離開才走
  { const msrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
    const cutM = (head) => { const i = msrc.indexOf(head); if (i < 0) throw new Error("找不到 " + head); let d = 0; for (let k = msrc.indexOf("{", msrc.indexOf(")", i)); k < msrc.length; k++) { if (msrc[k] === "{") d++; else if (msrc[k] === "}" && --d === 0) return msrc.slice(i, k + 1); } throw new Error("切不出 " + head); };
    const TT = require(path.join(__dirname, "..", "shell", "traytext.js"));
    const CLOSE = cutM('app.on("browser-window-created", (_e, win) =>'), BQ = cutM('app.on("before-quit", (e) =>'), GATE = "async " + cutM("async function draftDirty(").slice(6) + "\nasync " + cutM("function draftGate("), NOTED = (msrc.match(/\nconst draftNoted = [^\n]+/) || [""])[0], MAINWIN = cutM("function draftMainWin(");
    const tick = () => new Promise((r) => setTimeout(r, 30));
    const rig = (o) => {
      const log = [], OURS = "file:///app/renderer/index.html";
      const win = { url: o.url || OURS, destroyed: false, isDestroyed() { return this.destroyed; }, isMinimized: () => false, restore() {}, show() {}, focus() {}, hide() { log.push("hide"); }, close() { log.push("close"); if (ctx.closeHandler) { const e = { p: false, preventDefault() { this.p = true; } }; ctx.closeHandler(e); if (!e.p) log.push("closed"); } },
        webContents: { getURL: () => win.url, executeJavaScript: (code) => { log.push("ask"); return o.dirty === "hang" ? new Promise(() => {}) : Promise.resolve(o.dirty === true && /trUnsavedAny\(\) === true/.test(code)); } } };
      const ctx = { quitting: false, quitConfirmed: false, quitAsking: false, moveAsking: false, draftOk: false, draftNote: false, restarting: null, hiddenSaid: true, HEADLESS: true, activeTurn: o.turn ? {} : null, turnStarting: false,
        tradeMaybeLive: () => (o.live ? { venue: "binance" } : null), _tradeHost: null, _engineSetup: { busy: () => false }, twLots: () => { const z = { lots: 0, known: true }, t = o.tw || {}, pres = t.pres || z, cap = t.cap || z; return { pres, cap, held: [pres, cap].some((x) => !x.known || x.lots > 0) }; }, boxes: [], Notification: { isSupported: () => false },
        isOurPageUrl: (u) => u === OURS, BrowserWindow: { getAllWindows: () => [win] }, TT, process: { platform: "darwin" },
        setTimeout: (f) => setTimeout(f, 5), Promise, showMain() { log.push("showMain"); }, venueName: () => "Binance", cloudSt: () => null,
        tmLabels: { quitStay: "取消", unsavedGo: "離開", unsavedTitle: "還沒儲存，要離開嗎？", unsavedBody: "b", unsavedNote: "NOTE", quitGo: "結束 Blave", quitTitle: "t", quitBody: "q {venue}", quitTurnTitle: "tt", quitTurnBody: "tb", hidden: "", presQuitTitle: "pt", presQuitBody: "統一 {lots} 口", caplQuitBody: "群益 {lots} 口", presQuitUnknown: "統一讀不到", caplQuitUnknown: "群益讀不到" },
        dialog: { showMessageBox: (_w, opts) => { ctx.boxes.push(opts); log.push("dialog:" + opts.message + (/NOTE$/.test(opts.detail || "") ? "+NOTE" : "")); const sg = TT.stayGo("darwin", "", ""), go = opts.message === "還沒儲存，要離開嗎？" ? o.leave : false; return Promise.resolve({ response: go ? sg.goIndex : sg.cancelId }); } },
        app: { on: (ev, f) => { if (ev === "browser-window-created") f(null, Object.assign(win, { on: (e2, h) => { if (e2 === "close") ctx.closeHandler = h; } })); else ctx.quitHandler = f; }, quit: () => log.push("app.quit") } };
      new Function("ctx", "with (ctx) { " + NOTED.replace("const ", "var ") + "\n" + MAINWIN + "\n" + GATE + "\nctx.draftGate = draftGate;\n" + CLOSE + ");\n" + BQ + "); }")(ctx);
      // with(ctx) 裡宣告的 function 讀寫的是 ctx 上的旗標(draftOk / quitAsking)
      const closeEv = () => { const e = { p: false, preventDefault() { this.p = true; } }; ctx.closeHandler(e); return e.p; };
      const quitEv = () => { const e = { p: false, preventDefault() { this.p = true; } }; ctx.quitHandler(e); return e.p; };
      return { log, ctx, win, closeEv, quitEv };
    };
    { const r = rig({ dirty: true }); const blocked = r.closeEv(); await tick();
      ok("⑩ 關窗、有沒存的草稿:擋下、問畫面、跳「還沒儲存，要離開嗎？」;按取消就不關、draftOk 不設", blocked && r.log.join() === "ask,showMain,dialog:還沒儲存，要離開嗎？" && r.ctx.draftOk === false && r.ctx.quitAsking === false, r.log); }
    { const r = rig({ dirty: true, leave: true }); r.closeEv(); await tick();
      ok("⑩ 選「離開」:記 draftOk、真的把視窗關掉(第二次 close 不再擋)", r.ctx.draftOk === true && r.log.join() === "ask,showMain,dialog:還沒儲存，要離開嗎？,close,closed", r.log); }
    { const r = rig({ dirty: false }); r.closeEv(); await tick();
      ok("⑩ 沒有草稿:不跳框,直接關", r.log.join() === "ask,close,closed", r.log); }
    { const r = rig({ dirty: "hang" }); r.closeEv(); await tick();
      ok("⑩ 畫面卡住不回:等一下就放行(不能讓人關不掉)", r.log.join() === "ask,close,closed", r.log); }
    { const r = rig({ dirty: true, live: true }); const p = r.closeEv(); await tick();
      ok("⑩ 下單中關窗只收起來(草稿還在記憶體):不問", p && r.log.join() === "hide", r.log); }
    { const r = rig({ dirty: true, url: "https://example.com/" }); const p = r.closeEv(); await tick();
      ok("⑩ 不是主視窗(別的視窗)關掉:不問", !p && r.log.length === 0, r.log); }
    { const r = rig({ dirty: true }); const p = r.quitEv(); await tick();
      ok("⑩ Cmd+Q / 選單結束、有草稿:before-quit 擋下並跳同一個框;取消就不結束", p && r.log.join() === "ask,showMain,dialog:還沒儲存，要離開嗎？" && !r.log.includes("app.quit"), r.log); }
    { const r = rig({ dirty: true, leave: true }); r.quitEv(); await tick();
      ok("⑩ 結束時選「離開」:draftOk 記下、再 app.quit()(往下走到其他攔截)", r.ctx.draftOk === true && r.log.join() === "ask,showMain,dialog:還沒儲存，要離開嗎？,app.quit", r.log); }
    { const r = rig({ dirty: true, live: true }); r.quitEv(); await tick(); r.quitEv(); await tick();
      ok("⑩ 下單中又有草稿:不連跳兩個框——只跳「自動下單還在執行」那一個,草稿那句併在內文最後", r.log.filter((x) => /^dialog:/.test(x)).join() === "dialog:t+NOTE" && !r.log.includes("dialog:還沒儲存，要離開嗎？"), r.log);
      ok("⑩ …那個框按取消:收回 draftOk 與併進去那一句(下次結束再問)", r.ctx.draftOk === false && r.ctx.draftNote === false, r.log); }
    { const r = rig({ dirty: true, turn: true }); r.quitEv(); await tick(); r.quitEv(); await tick();
      ok("⑩ 回合中又有草稿:同樣只跳回合那一個框、併一句", r.log.filter((x) => /^dialog:/.test(x)).join() === "dialog:tt+NOTE", r.log); }
    { const r = rig({ dirty: false, live: true }); r.quitEv(); await tick(); r.quitEv(); await tick();
      ok("⑩ 下單中沒有草稿:框裡不帶那一句", r.log.filter((x) => /^dialog:/.test(x)).join() === "dialog:t", r.log); }
    { const r = rig({ dirty: true, live: true }); r.ctx.draftOk = true; r.closeEv();
      ok("⑩ 改成收起來(下單中關窗):收回 draftOk,之後結束照樣會問(稽核 B1)", r.ctx.draftOk === false && r.log.join() === "hide", r.log); }
    // 台灣券商還有部位(不論在不在下單):同一道框講「這幾口不會平倉」——群益本機的口數也算(0.1.28)
    { const r = rig({ dirty: false, tw: { cap: { lots: 2, known: true } } }); r.quitEv(); await tick(); r.quitEv(); await tick();
      const b = r.ctx.boxes.filter((x) => x.message === "pt");
      ok("⑩ 只有群益本機有 2 口:擋下、跳部位那道框,內文是群益那一句(不是統一的)", b.length === 1 && b[0].detail === "群益 2 口" && r.log[r.log.length - 1] === "dialog:pt", r.log); }
    { const r = rig({ dirty: false, tw: { pres: { lots: 1, known: true }, cap: { lots: 3, known: true } } }); r.quitEv(); await tick(); r.quitEv(); await tick();
      const b = r.ctx.boxes.filter((x) => x.message === "pt");
      ok("⑩ 兩家都有部位:同一道框兩句各講自己的口數", b.length === 1 && b[0].detail === "統一 1 口\n\n群益 3 口", r.ctx.boxes); }
    { const r = rig({ dirty: false, tw: { cap: { lots: 0, known: false } } }); r.quitEv(); await tick(); r.quitEv(); await tick();
      const b = r.ctx.boxes.filter((x) => x.message === "pt");
      ok("⑩ 群益綁著、讀不到、之前也沒讀到過部位:保守當有部位,照樣攔、講讀不到", b.length === 1 && b[0].detail === "群益讀不到", r.ctx.boxes); }
    { const r = rig({ dirty: false, tw: { cap: { lots: 2, known: false } } }); r.quitEv(); await tick(); r.quitEv(); await tick();
      const b = r.ctx.boxes.filter((x) => x.message === "pt");
      ok("⑩ 讀不到、但最後一次讀成功是 2 口:講那個口數", b.length === 1 && b[0].detail === "群益 2 口", r.ctx.boxes); }
    { const r = rig({ dirty: false }); r.quitEv(); await tick();
      ok("⑩ 都沒部位、沒在下單:不攔", r.log.includes("app.quit") && !r.ctx.boxes.length, r.log); }
    ok("⑩ 開新的主視窗就收回 draftOk", /function createWindow\(\) \{\n  draftOk = false;/.test(msrc)); }

  // ⑪ 雲端登出:草稿連同金額編輯一起清
  ok("⑪ 雲端登出(signedOut)時 C.edits 與 C.picked 一起清", /if \(envCloudKind\(C\.st\) === "signedOut"\) \{ C\.edits = \{\}; C\.picked = null;/.test(src));

  // ⑦ 字串兩語都有
  { const S = fs.readFileSync(path.join(R, "strings.js"), "utf8");
    ok("⑦ tr.cfTagAdd 兩語都在", (S.match(/"tr\.cfTagAdd": "[^"]+"/g) || []).length === 2);
    ok("⑦ 離開提醒三個字串兩語都在,畫面交給主行程", ["tm.unsavedTitle", "tm.unsavedBody", "tm.unsavedGo"].every((k) => (S.match(new RegExp('"' + k.replace(/\./g, "\\.") + '": "[^"]+"', "g")) || []).length === 2)
      && /unsavedTitle: t\("tm\.unsavedTitle"\), unsavedBody: t\("tm\.unsavedBody"\), unsavedGo: t\("tm\.unsavedGo"\)/.test(src)); }

  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
