// 歡迎頁入門步驟(spec .claude/output/specs/agent-onboarding-e-f-spec-2026-10-19.md;shell/renderer/welcome.js + trade.js 連接框)。
//   ① 純邏輯(從原文切出來跑):onbMkt 市場判定、onbSteps 步驟狀態機(①②同時、③④輪到才露、台股三步、狀態檔沒讀到不下結論)、
//      onbPhase E／fin／F 切換(當下完成才慶祝與送 onb_done_*,上線那天就已經完成的直接進 F)
//   ② 連接框 cxModalOpen 原文接假 DOM 跑:預設模擬、「真實帳戶」開在第一家、統一照舊、每次打開記 cx_open
//   ③ 主行程 welcome-prefs 的清洗(原文接暫存檔跑):形狀不對當沒設、只動有帶的鍵
// 跑法:node tests/check_shell_onboarding.js(不起 Electron)
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os");
const R = path.join(__dirname, "..", "shell", "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 800))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
const src = read(path.join(R, "welcome.js")), trade = read(path.join(R, "trade.js")), mainSrc = read(path.join(__dirname, "..", "shell", "main.js"));

// ── ① 純邏輯 ──
const P = {}; vm.createContext(P); vm.runInContext(["onbMkt", "onbSteps", "onbPhase"].map((n) => cutFn(src, n)).join("\n"), P);
const st = (o) => P.onbSteps(Object.assign({ mkt: null, bt: false, funded: false, live: false, known: true, open: [] }, o));
const states = (S) => S.steps.map((x) => x.state + (x.open ? "+" : "")).join();
ok("① 市場:題目選了照選的;沒選照第一支回測完的策略(長碼、短碼都認);判斷不出來 = null",
  P.onbMkt("tw", "crypto") === "tw" && P.onbMkt(null, "tw_stock") === "tw" && P.onbMkt(null, "crypto") === "crypto" && P.onbMkt(null, "tw_index_futures") === "txf"
  && P.onbMkt(null, "tw_idx_fut") === "txf" && P.onbMkt(null, "mixed") === null && P.onbMkt(null, null) === null && P.onbMkt("us", null) === null);
ok("① 全新、沒選市場(跳過市場題):四步,①② 同時展開,③④ 只有標題", states(st({})) === "cur+,cur+,todo,todo" && st({}).n === 4 && !st({}).complete, states(st({})));
ok("① 回測完 → ①② 收成打勾行、③ 輪到並露鈕、④ 還沒", states(st({ bt: true })) === "done,done,cur+,todo", states(st({ bt: true })));
ok("① 存了金額 → ④ 輪到;啟動下單在跑 → 全部完成", states(st({ bt: true, funded: true })) === "done,done,done,cur+" && !st({ bt: true, funded: true }).complete
  && states(st({ bt: true, funded: true, live: true })) === "done,done,done,done" && st({ bt: true, funded: true, live: true }).complete);
ok("① 點完成那一行重新展開:只有 done 的那一步跟著 open[i],cur 一律展開",
  states(st({ bt: true, open: [false, true, true, true] })) === "done,done+,cur+,todo", states(st({ bt: true, open: [false, true, true, true] })));
ok("① 台股:三步、沒有④;存了金額就算完成(不看有沒有在下單)", st({ mkt: "tw" }).n === 3 && states(st({ mkt: "tw", bt: true, funded: true })) === "done,done,done"
  && st({ mkt: "tw", bt: true, funded: true }).complete && !st({ mkt: "tw", bt: true }).complete);
ok("① 狀態檔還沒讀到(known false):③④ 一律沒輪到、不算完成——就算其實已經存了金額、在下單", states(st({ bt: true, funded: true, live: true, known: false })) === "done,done,todo,todo"
  && !st({ bt: true, funded: true, live: true, known: false }).complete && !st({ mkt: "tw", bt: true, funded: true, known: false }).complete);
const ph = (o) => JSON.stringify(P.onbPhase(Object.assign({ flag: false, complete: false, base: null, fin: false, replay: false }, o)));
const V = (view, setFlag, event) => JSON.stringify({ view, setFlag, event });
ok("① E／F:狀態檔還沒讀到 → E;讀到時還沒完成 → E;之後當下做完 → 「都設好了」、存旗標、送 onb_done_*",
  ph({}) === V("E", false, false) && ph({ base: false }) === V("E", false, false) && ph({ base: false, complete: true }) === V("fin", true, true));
ok("① 上線那天就已經完成(第一次讀到狀態檔就完成)→ 直接 F、存旗標、不慶祝、不送 onb_done_*", ph({ base: true, complete: true }) === V("F", true, false));
ok("① 已進 F 的旗標在 → 一律 F(之後停掉下單、刪了策略也不退回 E);這次開著時顯示過「都設好了」→ 留著;設定〔重看〕→ E、不再存旗標",
  ph({ flag: true }) === V("F", false, false) && ph({ flag: true, complete: false, base: false }) === V("F", false, false)
  && ph({ fin: true, flag: true }) === V("fin", false, false) && ph({ replay: true, complete: true, base: true }) === V("E", false, false));

// ── 原文鎖(畫面接線)──
const paint = cutFn(src, "onbPaint");
ok("② 先記基準再判:base 只在狀態檔讀到(d.known)之後記一次;完成那一刻送 onb_done_tw / onb_done_trade(台股走 tw)",
  /if \(d\.known && ONB\.base === null\) ONB\.base = S\.complete;/.test(paint) && /if \(ph\.event\) trackFeature\(mkt === "tw" \? "onb_done_tw" : "onb_done_trade"\);/.test(paint) && /onbSave\(\{ done: true \}\)/.test(paint));
ok("② 選了市場只留那一句起手句;沒選三句並列(不預設市場)", /b\.hidden = !!choice && b\.dataset\.starter !== choice;/.test(paint) && /rows\.classList\.toggle\("one", !!choice\);/.test(paint));
ok("② 台股不畫第四步:li 照 S.n 藏;台指期的描邊鈕叫「連接期貨商」", /\$\("onb-h" \+ n\)\.closest\("li"\)\.hidden = n > S\.n;/.test(paint) && /t\(mkt === "txf" \? "onb\.realFut" : "cx\.connect"\)/.test(paint));
ok("② 市場題只在選了不同的值時送 onb_mkt_*(名字是字面表);策略庫鈕直接設本機那一袋的 mkt、不經 libMktPick",
  /b\.dataset\.mk === ONB\.prefs\.mkt\) return;/.test(src) && /const ONB_MKT_FEATURE = \{ crypto: "onb_mkt_crypto", tw: "onb_mkt_tw", txf: "onb_mkt_txf" \};/.test(src)
  && /libBag\("local"\)\.mkt = c === "tw" \? "twstock" : c;/.test(src) && !/libMktPick/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));

// ── ② 連接框 ──
{ const open = (venue, mode, bound) => {
    const log = [], el = () => ({ hidden: true, classList: { add() {}, remove() {}, toggle() {} }, focus() { log.push("focus"); }, querySelector: () => null });
    const els = { "cx-scrim": el(), "view-ws": el(), "cx-body": el(), "cx-close": el(), "cx-mode-paper": el(), "cx-mode-real": el() };
    const C = { ENV: { cur: "local" }, TR: { env: "local" }, TR_BAGS: { local: { sig: {} }, cloud: {} }, PAPER: "paper", CAPITAL: "capital",
      CXF: { env: "local", mode: "paper", venue: "paper" }, cxVenuesFor: () => ["binance", "okx"], cxForget() {}, cxBag: () => C.TR_BAGS.local, trVenueIds: () => (bound ? [bound] : []), trSetupOnly: () => false, envCloudKind: () => "running",
      trackFeature: (n) => log.push(n), $: (id) => els[id] || null, requestAnimationFrame: (f) => f(), cxModalPaint() {}, capResume() {}, cxOpener: null };
    vm.createContext(C); vm.runInContext(cutFn(trade, "cxModalOpen").replace("function cxModalOpen", "var cxModalOpen = function"), C);
    C.cxModalOpen(null, venue, mode); return { venue: C.CXF.venue, mode: C.CXF.mode, bound: C.CXF.bound, log: log.join() }; };
  const a = open(), b = open("paper", "paper"), c = open(null, "real"), d = open("president", "real");
  ok("③ 連接框預設模擬:不帶參數 / 帶模擬 → venue = paper、mode = paper;每次打開記一次 cx_open",
    a.venue === "paper" && a.mode === "paper" && b.venue === "paper" && b.mode === "paper" && a.log.split(",").filter((x) => x === "cx_open").length === 1, JSON.stringify([a, b]));
  ok("③ 歡迎頁④〔連接交易所〕開在「真實帳戶」第一家;〔連接期貨商〕帶統一照舊", c.venue === "binance" && c.mode === "real" && d.venue === "president" && d.mode === "real", JSON.stringify([c, d]));
  { const e = open(null, "real", "okx"), f = open("paper", "paper", "paper");
    ok("③ 已綁定:停在綁著的那一家、bound 為真(兩個大選項與選單由 cxVenueField 鎖住);模擬綁著就停在模擬",
      e.venue === "okx" && e.mode === "real" && e.bound === true && f.venue === "paper" && f.mode === "paper" && f.bound === true && /CXF\.bound \|\|/.test(cutFn(trade, "cxVenueField")), JSON.stringify([e, f])); }
  ok("③ 真實帳戶的事實長在卡裡:div.cf-wrap 裡 label 與 ul 是兄弟、ul 掛 aria-describedby;期貨商只留兩行、講憑證",
    /card\.append\(lab, ul\)/.test(cutFn(trade, "cxVenueField")) && /r\.setAttribute\("aria-describedby", ul\.id\)/.test(cutFn(trade, "cxVenueField"))
    && /fut \? \[CXF\.env === "cloud" \? t\("cx\.fact\.certCloud"\) : t\("cx\.fact\.cert"\), t\("cx\.fact\.ai"\)\]/.test(cutFn(trade, "cxVenueField")));
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
  const a = mainSrc.indexOf("const ONB_MKTS ="), b = mainSrc.indexOf("\n", a);
  vm.runInContext(mainSrc.slice(a, b).replace(/^const /, "var ") + "\n" + ["uiPrefsPatch", "onbPrefsGet", "onbPrefsSet"].map((n) => cutFn(mainSrc, n)).join("\n"), C);
  const g0 = JSON.stringify(C.onbPrefsGet());
  fs.writeFileSync(file, JSON.stringify({ theme: "dark", onbMkt: "us", onbDone: "yes" }));
  const g1 = JSON.stringify(C.onbPrefsGet());
  const s1 = JSON.stringify(C.onbPrefsSet({ mkt: "tw" })), s2 = JSON.stringify(C.onbPrefsSet({ done: true })), s3 = JSON.stringify(C.onbPrefsSet({ mkt: "bogus" })), raw = JSON.parse(fs.readFileSync(file, "utf8"));
  ok("④ welcome-prefs:沒檔 / 形狀不對 → 沒選、沒進 F;set 只動有帶的鍵、別的偏好(theme)留著;市場只收 crypto / tw / txf",
    g0 === '{"mkt":null,"done":false}' && g1 === '{"mkt":null,"done":false}' && s1 === '{"mkt":"tw","done":false}' && s2 === '{"mkt":"tw","done":true}' && s3 === '{"mkt":null,"done":true}' && raw.theme === "dark",
    JSON.stringify([g0, g1, s1, s2, s3, raw]));
  fs.rmSync(dir, { recursive: true, force: true }); }

console.log(red ? red + " FAILED" : "all passed");
process.exit(red ? 1 : 0);
