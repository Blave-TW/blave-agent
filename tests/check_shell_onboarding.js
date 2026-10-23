// 歡迎頁入門步驟(spec .claude/output/specs/agent-onboarding-e-f-spec-2026-10-19.md;shell/renderer/welcome.js + trade.js 連接框)。
//   ① 純邏輯(從原文切出來跑):onbSteps 步驟狀態機(0.1.29 起不分市場、三步:①②同時、③輪到才露、狀態檔沒讀到不下結論)、
//      onbPhase E／fin／F 切換(當下完成才慶祝與送 onb_done,上線那天就已經完成的直接進 F)
//   ② 歡迎頁③〔加到策略組合〕(poPick)與選擇策略框 psOpen 原文接假 DOM 跑:到策略組合頁、開框、不替用戶勾;框開之前重讀這台電腦的清單
//      (0.1.28 Wei 實機:剛裝好的策略不在框裡)
//   ③ 連接框 cxModalOpen 原文接假 DOM 跑:預設模擬、統一照舊、每次打開記 cx_open
//   ③ 主行程 welcome-prefs 的清洗(原文接暫存檔跑):形狀不對當沒設、只動有帶的鍵
// 跑法:node tests/check_shell_onboarding.js(不起 Electron)
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os");
const R = path.join(__dirname, "..", "shell", "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 800))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
const src = read(path.join(R, "welcome.js")), trade = read(path.join(R, "trade.js")), mainSrc = read(path.join(__dirname, "..", "shell", "main.js"));

// ── ① 純邏輯 ──
const P = {}; vm.createContext(P); vm.runInContext(["onbSteps", "onbPhase"].map((n) => cutFn(src, n)).join("\n"), P);
const st = (o) => P.onbSteps(Object.assign({ bt: false, funded: false, known: true, open: [] }, o));
const states = (S) => S.steps.map((x) => x.state + (x.open ? "+" : "")).join();
ok("① 全新:三步,①② 同時展開,③ 只有標題", states(st({})) === "cur+,cur+,todo" && !st({}).complete, states(st({})));
ok("① 回測完 → ①② 收成打勾行、③ 輪到並露鈕", states(st({ bt: true })) === "done,done,cur+" && !st({ bt: true }).complete, states(st({ bt: true })));
ok("① 存了金額(③)就算全部完成——不看有沒有綁帳戶、有沒有在下單", states(st({ bt: true, funded: true })) === "done,done,done" && st({ bt: true, funded: true }).complete);
ok("① 點完成那一行重新展開:只有 done 的那一步跟著 open[i],cur 一律展開",
  states(st({ bt: true, open: [false, true, true] })) === "done,done+,cur+", states(st({ bt: true, open: [false, true, true] })));
ok("① 狀態檔還沒讀到(known false):③ 一律沒輪到、不算完成——就算其實已經存了金額", states(st({ bt: true, funded: true, known: false })) === "done,done,todo"
  && !st({ bt: true, funded: true, known: false }).complete);
const ph = (o) => JSON.stringify(P.onbPhase(Object.assign({ flag: false, complete: false, base: null, fin: false }, o)));
const V = (view, setFlag, event) => JSON.stringify({ view, setFlag, event });
ok("① E／F:狀態檔還沒讀到 → E;讀到時還沒完成 → E;之後當下做完 → 「都設好了」、存旗標、送 onb_done",
  ph({}) === V("E", false, false) && ph({ base: false }) === V("E", false, false) && ph({ base: false, complete: true }) === V("fin", true, true));
ok("① 上線那天就已經完成(第一次讀到狀態檔就完成)→ 直接 F、存旗標、不慶祝、不送 onb_done", ph({ base: true, complete: true }) === V("F", true, false));
ok("① 已進 F 的旗標在 → 一律 F(之後停掉下單、刪了策略也不退回 E);這次開著時顯示過「都設好了」→ 留著;設定〔重看〕0.1.30 拿掉(Wei),沒有 replay 分支",
  ph({ flag: true }) === V("F", false, false) && ph({ flag: true, complete: false, base: false }) === V("F", false, false)
  && ph({ fin: true, flag: true }) === V("fin", false, false) && !/replay/.test(cutFn(src, "onbPhase")));
{ const html = read(path.join(R, "index.html")), app = read(path.join(R, "app.js"));
  ok("① 設定 › 一般「入門步驟〔重看〕」整列拿掉:#set-onb、app.js 點擊處理、onbReplay、onb_replay 送出點、set.onb.replay 字串都不在",
    !/id="set-onb"|set\.onb\.replay/.test(html) && !/set-onb|onbReplay|onb_replay/.test(app) && !/onbReplay|ONB\.replay|onb_replay/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))
    && !/set\.onb\.replay/.test(read(path.join(R, "strings.js")))); }

// ── 原文鎖(畫面接線)──
const paint = cutFn(src, "onbPaint");
{ const ev = cutFn(src, "onbEval");
  ok("② 先記基準再判(兩個視角各一份):base 只在狀態檔讀到(d.known)之後記一次;完成那一刻送 onb_done／onb_done_cloud(雲端只在看著雲端時送);旗標分開存 done／cloudDone;兩個視角每輪都判",
    /if \(d\.known && V\.base === null\) V\.base = S\.complete;/.test(ev) && /if \(ph\.event && env === "local"\) trackFeature\("onb_done"\);/.test(ev)
    && /if \(ph\.event && env === "cloud" && onbEnv\(\) === "cloud"\) trackFeature\("onb_done_cloud"\);/.test(ev) && /onbSave\(\{ \[f\]: true \}\)/.test(ev)
    && /const ONB_FLAG = \{ local: "done", cloud: "cloudDone" \};/.test(src) && /onbEval\(env === "cloud" \? "local" : "cloud"\);/.test(paint)); }
ok("② 完成列不帶 meta(Wei 10-21);①② 點了就地展開(aria-expanded),③ 點了到策略組合頁(不展開、不掛 aria-expanded)",
  !/metas|"meta"|acctName|d\.total|ONB_MKT_CCY/.test(src) && /if \(i < 2\) \{ h\.setAttribute\("aria-expanded"/.test(cutFn(src, "onbHead")) && /i === 2 \? poOpen\("cfg", true\) : onbToggle\(i\)/.test(cutFn(src, "onbHead")));
{ const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""), html = read(path.join(R, "index.html"));
  ok("② 不分市場:沒有市場題、沒有④、沒有依市場分流(onbMkt／onbChoice／prefs.mkt／onb_mkt_*／onb_done_tw 都不在);③ 只剩一顆鈕,靜態字是〔選擇策略〕(tr.pick,同它打開的框標題;0.1.29 設計稽核 P1-1)",
    !/onbMkt|onbChoice|onbIdeaMkt|onbApplyMkt|ONB_MKT|prefs\.mkt|onb_mkt|onb_done_tw|onb_done_trade|onb_go_paper|onb_go_trade|onbCx|ONB\.target/.test(code)
    && !/id="onb-mkt"|id="onb-h4"|id="onb-bt"|id="onb-paper"|id="onb-real"|id="onb-tr"|id="onb-futmac"/.test(html)
    && /<button class="btn-fill" id="onb-po" type="button" data-i18n="tr\.pick"><\/button>\n\s*<\/div>/.test(html)
    && !/onbIdeaMkt/.test(read(path.join(R, "library.js"))) && !/mkt/.test(cutFn(mainSrc, "onbPrefsGet") + cutFn(mainSrc, "onbPrefsSet"))); }

// ── ② ③ 的鈕字與落點:勾了沒存／存了全 0 → 〔設定金額〕(設計稽核 P2-3;不要求先綁帳戶)──
{ const C = { RP: { list: [{ name: "a", hasBacktest: true }] }, trExecState: () => "idle", trWith: (L, f) => f() };
  vm.createContext(C); vm.runInContext(cutFn(src, "onbData"), C);
  const d = (stored, draft) => { C.TR_BAGS = { local: { st: { report: {} } } }; C.trStored = () => stored; C.trZDraft = () => draft; return C.onbData().amt; };
  ok("② onbData.amt:存了但全 0 → true;沒存、勾了草稿 → true;沒存沒勾 → false;有一支 > 0(③已完成)→ false;狀態檔沒讀到 → false",
    d({ a: 0 }, false) === true && d({}, true) === true && d({}, false) === false && d({ a: 0, b: 5 }, true) === false
    && (C.TR_BAGS = { local: { st: null } }, C.trStored = () => ({ a: 0 }), C.onbData().amt) === false);
  // 雲端那一份:清單讀 TR_BAGS.cloud.list;清單還沒載入(listLoaded)前不下結論(不然既有用戶會被當成還沒回測、之後假慶祝)
  const dc = (list, loaded, stored) => { C.TR_BAGS = { local: { st: null }, cloud: { st: { report: {} }, list, listLoaded: loaded } }; C.trStored = () => stored; C.trZDraft = () => false; return C.onbData("cloud"); };
  const c1 = dc([{ name: "x", hasBacktest: true }], true, { x: 5 }), c2 = dc([{ name: "x", hasBacktest: true }], false, { x: 5 }), c3 = dc([{ name: "x", hasBacktest: false }], true, {});
  ok("② onbData(cloud):回測過看雲端清單(不看本機 RP.list)、金額看雲端那一袋;清單沒載入 → known false", c1.known && c1.bt && c1.funded && !c2.known && c3.known && !c3.bt && !c3.funded, JSON.stringify([c1, c2, c3]));
  const paint = cutFn(src, "onbPaint");
  ok("② onbPaint:鈕字照 amt 換(po.goAmounts／tr.pick),指紋帶 amt;click 把 ONB.amt 交給 poPick",
    /\$\("onb-po"\)\.textContent = t\(d\.amt \? "po\.goAmounts" : "tr\.pick"\);/.test(paint) && /JSON\.stringify\(\[LANG, env, ph\.view, S\.steps, d\.amt\]\)/.test(paint) && /poPick\(ONB\.amt\)/.test(src)); }
// ── ② 起手句不帶市場 tag(設計稽核 P2-4)──
{ const css = read(path.join(R, "welcome.css")), st = cutFn(src, "stPaint");
  ok("② 起手句沒有市場 tag:stPaint 不畫 .tag;.st-rows 三欄 auto minmax(0, 1fr) auto;welcome.css 不再有 .tag 規則",
    !/"tag"|wd\.mk\./.test(st) && /\.st-rows \{[^}]*grid-template-columns: auto minmax\(0, 1fr\) auto; \}/.test(css) && !/\.tag\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, ""))); }
// ── en Title Case(設計稽核 P2-5)──
{ const S = {}; vm.createContext(S); vm.runInContext(read(path.join(R, "strings.js")).replace(/^const STRINGS/m, "var STRINGS"), S);
  ok("② en:tr.pick／tr.pick.title = Pick Strategies、po.goAmounts = Set Amounts(同一位置的兩種字一起 Title Case);zh 選擇策略／設定金額",
    S.STRINGS.en["tr.pick"] === "Pick Strategies" && S.STRINGS.en["tr.pick.title"] === "Pick Strategies" && S.STRINGS.en["po.goAmounts"] === "Set Amounts"
    && S.STRINGS.zh["tr.pick"] === "選擇策略" && S.STRINGS.zh["po.goAmounts"] === "設定金額"); }

// ── ② 歡迎頁③ → 策略組合頁＋選擇策略框 ──
{ const portfolio = read(path.join(R, "portfolio.js"));
  ok("② ③ 的鈕記 onb_go_po(雲端 onb_go_po_cloud)、走 poPick(不經 poAdd:不替用戶勾任何一支)", /\$\("onb-po"\)\.addEventListener\("click", \(\) => \{ trackFeature\(onbEnv\(\) === "cloud" \? "onb_go_po_cloud" : "onb_go_po"\); poPick\(ONB\.amt\); \}\);/.test(src) && !/poAdd\(/.test(src));
  const run = async (o) => {
    const log = [], el = (id) => ({ id, hidden: true, isConnected: true, disabled: false, textContent: "", dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, focus() { log.push("focus:" + id); },
      kids: [], appendChild(x) { this.kids.push(x); return x; }, querySelector: () => null, querySelectorAll: () => [] });
    const els = { "ps-scrim": el("ps-scrim"), "ps-modal": Object.assign(el("ps-modal"), { querySelector: () => el("head") }), "ps-env": el("ps-env"), "ps-list": el("ps-list"), "ps-cancel": el("ps-cancel"), "ps-ok": el("ps-ok"), "view-ws": el("view-ws"), "tr-pick": el("tr-pick") };
    const L = { env: "local", list: o.list, listLoaded: true, meta: new Map(), st: null, view: "tr",
      api: { listStrategies: async () => { log.push("list"); if (o.onList) o.onList(L); if (o.listFail) throw new Error("x"); return o.fresh; }, loadStrategy: async () => ({ stats: { symbol: "BTCUSDT" }, code: "" }) } };
    const C = { TR: L, TR_BAGS: { local: L, cloud: {} }, ENV: { cur: "local" }, $: (id) => els[id] || null, t: (k) => k, requestAnimationFrame: (f) => f(),
      PAPER: "paper", trackFeature: (n) => log.push("track:" + n), trPickOff: () => !L.listLoaded, trNames: () => [], trReport: () => ({}), trVenueId: () => null, trPaperTwOk: () => true, trTwBroker: () => false,
      trPickPrefs: () => ({ order: [], flags: {} }), envDotsUp: () => false, envRunDot: () => false, trUniverse: () => [], trIsTwd: () => false, trAllTwd: () => false,
      trEl: (tag, cls, txt) => ({ tag, cls, txt, kids: [], dataset: {}, setAttribute() {}, appendChild(x) { this.kids.push(x); return x; }, append() {} }),
      psRow: (r) => ({ row: r.name }), mgMembers: () => [], psOpener: null, psMode: "", Map, Set, JSON, Object, Number, Promise, Error,
      poOpen: async (tab) => { log.push("poOpen:" + tab); L.view = "po"; L.open = true; }, trFocusFirstAmt: () => log.push("focusAmt"),
      trWith: (b, f) => f(), trSetEq: (a, b) => a.size === b.size && [...a].every((x) => b.has(x)), trNamesOf: () => [], trPvOf: () => null, trPvHost: () => false, poPaintCfg() {}, trackA1: null };
    els["po-cfg"] = el("po-cfg"); els["po-h"] = el("po-h");
    vm.createContext(C);
    vm.runInContext(cutFn(trade, "trPickRows") + "\nasync " + cutFn(trade, "trLoadStrategies") + "\nvar psLoading = false, psOpener = null, psMode = '';\nvar psOpen = async " + cutFn(trade, "psOpen").replace(/^function psOpen/, "function")
      + "\nvar poPick = async " + cutFn(portfolio, "poPick").replace(/^function poPick/, "function")
      + "\nvar poAdd = async " + cutFn(portfolio, "poAdd").replace(/^function poAdd/, "function"), C);
    L.save = null; L.raw = {}; L.edits = {}; L.sig = {};
    if (o.drive) await o.drive(C, L, els); else await C.poPick(o.amt);
    return { log, rows: els["ps-list"].kids.map((x) => x.row), open: !els["ps-scrim"].hidden, list: L.list.map((x) => x.name) };
  };
  return Promise.resolve().then(async () => {
    const A = { name: "a", hasBacktest: true, mtime: 1 }, B = { name: "b_new", hasBacktest: true, mtime: 2 };
    const r1 = await run({ list: [{ name: "a", hasBacktest: true }], fresh: [A, B] });
    ok("② 剛裝好一支(手上的清單還是舊的、listLoaded 已經是 true):poPick 到策略組合頁 → 開框前重讀清單 → 框裡列得到新那支;不替用戶勾、不送 po_add",
      r1.open && JSON.stringify(r1.rows) === '["a","b_new"]' && r1.log.indexOf("poOpen:cfg") === 0 && r1.log.indexOf("list") > 0 && !r1.log.some((x) => /po_add/.test(x)), JSON.stringify(r1));
    const r2 = await run({ list: [{ name: "a", hasBacktest: true }], fresh: null, listFail: true });
    ok("② 重讀失敗:照舊用手上那份開框(不是悶不吭聲不開)", r2.open && JSON.stringify(r2.rows) === '["a"]', JSON.stringify(r2));
    const cnt = (r, x) => r.log.filter((y) => y === x).length;
    const r4 = await run({ list: [A], fresh: [A, B], drive: async (C, L, els) => { L.view = "po"; L.open = true; await Promise.all([C.psOpen(els["tr-pick"]), C.psOpen(els["tr-pick"])]); } });
    ok("② 重讀還沒回來又按一次〔選擇策略〕:只讀一次、只開一個框(psLoading 守門)", r4.open && cnt(r4, "list") === 1 && cnt(r4, "track:strategy_picker") === 1, JSON.stringify(r4));
    const r5 = await run({ list: [A], fresh: [A, B], onList: (L) => { L.open = false; }, drive: async (C, L, els) => { L.view = "po"; L.open = true; await C.psOpen(els["tr-pick"]); } });
    const r5b = await run({ list: [A], fresh: [A, B], onList: (L) => { L.view = "tr"; }, drive: async (C, L, els) => { L.view = "po"; L.open = true; await C.psOpen(els["tr-pick"]); } });
    ok("② 重讀那一下切走了(離開策略組合頁／換到自動下單頁):不開框", !r5.open && !r5b.open && cnt(r5, "list") === 1, JSON.stringify([r5, r5b]));
    const r6 = await run({ list: [A], fresh: [A, B], drive: async (C, L) => { L.view = "po"; L.open = true; await C.poAdd(L, "b_new", false); C.trackFeature("picked:" + (L.picked ? [...L.picked].join() : "")); } });
    ok("② listLoaded 已經是 true 時,策略頁首〔加到策略組合〕照樣先重讀:剛裝好的那支直接進草稿、不退成開框", cnt(r6, "list") === 1 && cnt(r6, "track:picked:b_new") === 1 && !r6.open && cnt(r6, "track:strategy_picker") === 0, JSON.stringify(r6));
    const r7 = await run({ list: [A], fresh: [A], drive: async (C, L) => { L.view = "po"; L.open = true; await C.poAdd(L, "gone_one", false); await new Promise((res) => setTimeout(res, 0)); } });
    ok("② poAdd 找不到那支(鎖住那條)改開選擇策略框:整段只讀一次清單(psOpen 帶 fresh 不重讀)", r7.open && cnt(r7, "list") === 1, JSON.stringify(r7));
    const r3 = await run({ list: [A], fresh: [A], amt: true });
    ok("② poPick(amt):到策略組合頁、焦點落在第一個金額格,不開選擇策略框", !r3.open && JSON.stringify(r3.log) === '["poOpen:cfg","focusAmt"]', JSON.stringify(r3));
  }).catch((e) => ok("② poPick／psOpen 跑得起來", false, e && e.stack)).then(rest);
}
function rest() {
// ── ② 連接框 ──
{ const open = (venue, mode, bound) => {
    const log = [], el = () => ({ hidden: true, classList: { add() {}, remove() {}, toggle() {} }, focus() { log.push("focus"); }, querySelector: () => null });
    const els = { "cx-scrim": el(), "view-ws": el(), "cx-body": el(), "cx-close": el(), "cx-mode-paper": el(), "cx-mode-real": el() };
    const C = { ENV: { cur: "local" }, TR: { env: "local" }, TR_BAGS: { local: { sig: {} }, cloud: {} }, PAPER: "paper", CAPITAL: "capital",
      CXF: { env: "local", mode: "paper", venue: "paper" }, cxVenuesFor: () => ["binance", "okx"], cxForget() {}, cxBag: () => C.TR_BAGS.local, trVenueIds: () => (bound ? [bound] : []), trSetupOnly: () => false, envCloudKind: () => "running",
      trackFeature: (n) => log.push(n), $: (id) => els[id] || null, requestAnimationFrame: (f) => f(), cxModalPaint() {}, capResume() {}, cxOpener: null };
    vm.createContext(C); vm.runInContext(cutFn(trade, "cxModalOpen").replace("function cxModalOpen", "var cxModalOpen = function"), C);
    C.cxModalOpen(null, venue); return { venue: C.CXF.venue, mode: C.CXF.mode, bound: C.CXF.bound, log: log.join() }; };
  const a = open(), b = open("paper"), d = open("president");
  ok("③ 連接框預設模擬:不帶參數 / 帶模擬 → venue = paper、mode = paper;每次打開記一次 cx_open",
    a.venue === "paper" && a.mode === "paper" && b.venue === "paper" && b.mode === "paper" && a.log.split(",").filter((x) => x === "cx_open").length === 1, JSON.stringify([a, b]));
  ok("③ 帶統一照舊開在真實帳戶;不再有「沒帶 venue 也開在真實帳戶」那條(0.1.29 拿掉④)", d.venue === "president" && d.mode === "real" && !/mode === "real"/.test(cutFn(trade, "cxModalOpen")), JSON.stringify(d));
  { const e = open(null, null, "okx"), f = open("paper", null, "paper");
    ok("③ 已綁定:停在綁著的那一家、bound 為真(兩個大選項與選單由 cxVenueField 鎖住);模擬綁著就停在模擬",
      e.venue === "okx" && e.mode === "real" && e.bound === true && f.venue === "paper" && f.mode === "paper" && f.bound === true && /CXF\.bound \|\|/.test(cutFn(trade, "cxVenueField")), JSON.stringify([e, f])); }
  ok("③ 真實帳戶的事實長在卡裡:div.cf-wrap 裡 label 與 ul 是兄弟、ul 掛 aria-describedby;期貨商只留一行、講憑證(0.1.28 拿掉「不經過 AI」)",
    /card\.append\(lab, ul\)/.test(cutFn(trade, "cxVenueField")) && /r\.setAttribute\("aria-describedby", ul\.id\)/.test(cutFn(trade, "cxVenueField"))
    && /fut \? \[CXF\.env === "cloud" \? t\("cx\.fact\.certCloud"\) : t\("cx\.fact\.cert"\)\]\n/.test(cutFn(trade, "cxVenueField")));
  { const vf = cutFn(trade, "cxVenueField"), paint = cutFn(trade, "cxModalPaint"), conn = cutFn(trade, "cxConnect");
    ok("③ 已綁模擬:沒有主鈕(防重綁把模擬帳戶從頭建一次)、Enter 也不送,框裡講「要換帳戶，先在設定解除綁定。」;已綁真實帳戶主鈕寫「換金鑰」、事實收起",
      /go\.hidden = CXF\.bound && venue === PAPER;/.test(paint) && /^function cxConnect\(\) \{\n  if \(CXF\.bound && CXF\.venue === PAPER\) return;/.test(conn)
      && /if \(CXF\.mode !== "real"\) \{ if \(CXF\.bound\) w\.appendChild\(trEl\("p", "cx-hint", t\("cx\.bound"\)\)\); return w; \}/.test(vf)
      && /CXF\.bound \? t\("cx\.changeKey"\) : t\("cx\.connect"\)/.test(paint) && /wrap = on && m === "real" && !CXF\.bound/.test(vf) && /if \(!wrap\) \{ fs\.appendChild\(lab\); return; \}/.test(vf)); }
  { const C = { out: [], trEl: (tag, cls, txt) => ({ tag, cls, txt }) }, el = { kids: [], appendChild(x) { this.kids.push(x); }, append(x) { this.kids.push(x); } };
    vm.createContext(C); vm.runInContext(cutFn(trade, "cxMonoNums"), C); C.cxMonoNums(el, "不用金鑰，起始 100,000 USDT，不動真錢。");
    ok("③ 選項小字的數字包 mono(100,000),其餘照原字", JSON.stringify(el.kids) === JSON.stringify(["不用金鑰，起始 ", { tag: "span", cls: "mono", txt: "100,000" }, " USDT，不動真錢。"]), JSON.stringify(el.kids)); }
  ok("③ 鎖住、已選的圓鈕:中間的點換 --color-greyMedium(亮色不再白點配白底)", /\.cf-opt\.off input:checked::after \{ background: var\(--color-greyMedium\); \}/.test(read(path.join(R, "app.css"))));
  ok("③ 綁定成功的埋點:本機 cxConnected 與雲端成功那一條都分模擬／真實;框標題與霧上的鈕同一句 cx.title",
    /trackFeature\(CXF\.venue === PAPER \? "cx_paper_ok" : "cx_real_ok"\);/.test(cutFn(trade, "cxConnected")) && /trackFeature\(venue === PAPER \? "cx_paper_ok" : "cx_real_ok"\);/.test(cutFn(trade, "cxConnectCloud"))
    && /<h6 id="cx-title" data-i18n="cx\.title"><\/h6>/.test(read(path.join(R, "index.html"))) && !/t\("cx\.connect"\)\); b\.type = "button"; b\.id = "tr-connect"/.test(trade)); }

// ── ③ 主行程偏好清洗 ──
{ const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onb-prefs-")), file = path.join(dir, "ui-prefs.json");
  const C = { fs, uiPrefsPath: () => file }; vm.createContext(C);
  vm.runInContext(["uiPrefsPatch", "onbPrefsGet", "onbPrefsSet"].map((n) => cutFn(mainSrc, n)).join("\n"), C);
  const g0 = JSON.stringify(C.onbPrefsGet());
  fs.writeFileSync(file, JSON.stringify({ theme: "dark", onbMkt: "us", onbDone: "yes" }));
  const g1 = JSON.stringify(C.onbPrefsGet());
  const s1 = JSON.stringify(C.onbPrefsSet({ mkt: "tw" })), s2 = JSON.stringify(C.onbPrefsSet({ done: true })), s3 = JSON.stringify(C.onbPrefsSet({ mkt: "bogus" })), raw = JSON.parse(fs.readFileSync(file, "utf8"));
  ok("④ welcome-prefs:沒檔 / 形狀不對 → 沒進 F;set 只動有帶的鍵、別的偏好(theme)留著;0.1.28 存的 onbMkt 不讀、不回(市場題退役)",
    g0 === '{"done":false,"cloudDone":false}' && g1 === '{"done":false,"cloudDone":false}' && s1 === '{"done":false,"cloudDone":false}' && s2 === '{"done":true,"cloudDone":false}' && s3 === '{"done":true,"cloudDone":false}' && raw.theme === "dark" && raw.onbMkt === "us"
    && JSON.stringify(C.onbPrefsSet({ cloudDone: true })) === '{"done":true,"cloudDone":true}' && JSON.stringify(C.onbPrefsSet({ cloudDone: "yes" })) === '{"done":true,"cloudDone":false}',
    JSON.stringify([g0, g1, s1, s2, s3, raw]));
  fs.rmSync(dir, { recursive: true, force: true }); }

console.log(red ? red + " FAILED" : "all passed");
process.exit(red ? 1 : 0);
}
