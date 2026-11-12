// 歡迎頁入門步驟(spec .claude/output/specs/agent-onboarding-e-f-spec-2026-10-19.md;shell/renderer/welcome.js + trade.js 連接框)。
//   ① 純邏輯(從原文切出來跑):onbSteps 步驟狀態機(0.1.29 起不分市場、三步:①②同時、③輪到才露、狀態檔沒讀到不下結論)、
//      onbPhase E／F 切換(當下完成就換成 F、送 onb_done,上線那天就已經完成的不送);沒有「都設好了」那一行
//   ② 歡迎頁③〔加到策略組合〕(poPick)與選擇策略框 psOpen 原文接假 DOM 跑:到策略組合頁、開框、不替用戶勾;框開之前重讀這台電腦的清單
//      (0.1.28 Wei 實機:剛裝好的策略不在框裡)
//   ③ 連接框(0.1.52 案一)cxModalOpen／cxVenueField 原文接假 DOM 跑:不預選、綁模擬不鎖、統一照舊、每次打開記 cx_open;
//      期貨磚(Mac 不出)、建金鑰網址、權限句、被拒時帶 IP 的純邏輯
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
const ph = (o) => JSON.stringify(P.onbPhase(Object.assign({ flag: false, complete: false, base: null }, o)));
const V = (view, setFlag, event) => JSON.stringify({ view, setFlag, event });
ok("① E／F:狀態檔還沒讀到 → E;讀到時還沒完成 → E;之後當下做完 → 直接 F、存旗標、送 onb_done",
  ph({}) === V("E", false, false) && ph({ base: false }) === V("E", false, false) && ph({ base: false, complete: true }) === V("F", true, true));
ok("① 上線那天就已經完成(第一次讀到狀態檔就完成)→ 直接 F、存旗標、不慶祝、不送 onb_done", ph({ base: true, complete: true }) === V("F", true, false));
ok("① 已進 F 的旗標在 → 一律 F(之後停掉下單、刪了策略也不退回 E);設定〔重看〕0.1.30 拿掉(Wei),沒有 replay 分支",
  ph({ flag: true }) === V("F", false, false) && ph({ flag: true, complete: false, base: false }) === V("F", false, false)
  && !/replay/.test(cutFn(src, "onbPhase")));
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
  const dc = (list, loaded, stored) => { C.libCloud = () => "live"; C.TR_BAGS = { local: { st: null }, cloud: { st: { report: {} }, list, listLoaded: loaded } }; C.trStored = () => stored; C.trZDraft = () => false; return C.onbData("cloud"); };
  const c1 = dc([{ name: "x", hasBacktest: true }], true, { x: 5 }), c2 = dc([{ name: "x", hasBacktest: true }], false, { x: 5 }), c3 = dc([{ name: "x", hasBacktest: false }], true, {});
  ok("② onbData(cloud):回測過看雲端清單(不看本機 RP.list)、金額看雲端那一袋;清單沒載入 → known false", c1.known && c1.bt && c1.funded && !c2.known && c3.known && !c3.bt && !c3.funded, JSON.stringify([c1, c2, c3]));
  const paint = cutFn(src, "onbPaint");
  ok("② onbPaint:鈕字照 amt 換(po.goAmounts／tr.pick),指紋帶 amt;click 把 ONB.amt 交給 poPick",
    /\$\("onb-po"\)\.textContent = t\(d\.amt \? "po\.goAmounts" : "tr\.pick"\);/.test(paint) && /JSON\.stringify\(\[LANG, env, ph\.view, S\.steps, d\.amt, why\]\)/.test(paint) && /poPick\(ONB\.amt\)/.test(src));
  // ①的策略卡(spec desktop-welcome-library-first §2.5):onbPaint 有三個提早 return,wcPaint 要在 onbEval 之後、指紋 return 之前,雲端轉 stale／stopped 才收得起來
  ok("② onbPaint:onbEval(env) 之後、if (key === ONB.key) return 之前叫 wcPaint",
    paint.indexOf("wcPaint();") > paint.indexOf("onbEval(env);") && paint.indexOf("wcPaint();") < paint.indexOf("if (key === ONB.key) return;") && paint.indexOf("onbEval(env);") > 0); }
// 設計稽核 v030 S4:雲端主機本來就含資料,步驟②不出「可以回測的資料」(免費 vs Blave 兩欄會講錯事實);本機照舊、切回本機要再露出來
{ const run = (envs) => {
    const el = (id) => ({ id, hidden: false, textContent: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
    const els = {}; ["wc", "wf", "onb-steps", "onb-b1", "onb-b2", "onb-b3", "onb-po", "wl-fold", "wl", "onb-wait"].forEach((id) => { els[id] = el(id); });
    const C = { $: (id) => els[id], t: (k) => k, LANG: "zh", JSON, ONB_WAIT_MS: 12000, WC: { shown: true }, ONB: { prefs: {}, key: null, amt: false, v: { local: {}, cloud: {} } }, onbHead() {}, wcPaint() {}, ENVNOW: "local",
      onbEnv: () => C.ENVNOW, onbEval: () => ({ d: { amt: false }, S: { steps: [{ open: true }, { open: true }, { open: false }] }, ph: { view: "E" } }) };
    vm.createContext(C); vm.runInContext(paint, C);
    return envs.map((e) => { C.ENVNOW = e; if (e === "local-open") { C.ENVNOW = "local"; els.wl.hidden = false; els["wl-fold"].attrs["aria-expanded"] = "true"; } C.onbPaint();
      return [e, els["wl-fold"].hidden, els.wl.hidden, els["wl-fold"].attrs["aria-expanded"] || null].join(); });
  };
  const r = run(["local-open", "cloud", "local"]);
  ok("② 雲端歡迎頁步驟②不出「可以回測的資料」:#wl-fold 收掉、#wl 收起、aria-expanded false;本機照舊(展開著的不被收);切回本機 #wl-fold 再出現",
    JSON.stringify(r) === JSON.stringify(["local-open,false,false,true", "cloud,true,true,false", "local,false,true,false"]), JSON.stringify(r)); }
// ── ② 方案 A(mockup-welcome-fin-2026-11-01):完成行進 F,#12／#23 不再是死路;#25／#26 講出來;#10／#22 ③ 沒鈕時講原因 ──
{ const html = read(path.join(R, "index.html")), css = read(path.join(R, "welcome.css"));
  const wf = html.slice(html.indexOf('id="wf"'), html.indexOf("</section>", html.indexOf('id="wf"'))), wc = html.slice(html.indexOf('id="wc"'), html.indexOf('id="wf"'));
  const S0 = new Function(read(path.join(R, "strings.js")) + "\nreturn STRINGS;")();
  ok("② 「都設好了」那一行整個拿掉(Wei):畫面節點、畫面碼、樣式、兩語字串、V.fin 都沒有", !html.includes("onb-fin") && !/onb-fin|V\.fin|"fin"/.test(src) && !/onb-fin/.test(css) && !("onb.fin" in S0.zh) && !("onb.fin" in S0.en));
  ok("② .fin-grp 留給籤與 #wf-alert(間距 8)、置中", /\.fin-grp \{ display: flex; flex-direction: column; align-items: center; gap: var\(--space-8\); \}/.test(css) && wf.indexOf('class="fin-grp"') < wf.indexOf('id="wf-idea"'));
  const mk = (id) => ({ id, hidden: true, textContent: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  const run = (view) => { const els = {}; ["wc", "wf", "onb-steps", "onb-b1", "onb-b2", "onb-b3", "onb-po", "wl-fold", "wl", "onb-wait"].forEach((id) => { els[id] = mk(id); });
    const C = { $: (id) => els[id], t: (k) => k, LANG: "zh", JSON, Date, ONB_WAIT_MS: 12000, WC: { shown: true }, ONB: { prefs: {}, key: null, amt: false, v: { local: { waitAt: view === "wait" ? Date.now() - 13000 : 0 } } }, onbHead() {}, wcPaint() {}, onbEnv: () => "local",
      onbEval: () => ({ d: { amt: false, bt: true, wait: view === "wait" || view === "waitNew" }, S: { steps: [{ open: false }, { open: false }, { open: false }] }, ph: { view: view === "wait" || view === "waitNew" ? "E" : view } }) };
    vm.createContext(C); vm.runInContext(cutFn(src, "onbPaint"), C); C.onbPaint(); return els; };
  const F = run("F"), E = run("E");
  ok("② F:#wf 開著、步驟頁收起,三顆籤當場可按;E:#wc 開著、#wf 收起", !F.wf.hidden && F.wc.hidden && E.wf.hidden && !E.wc.hidden);
  ok("② #10／#22:回測做完而狀態沒讀到撐過 ONB_WAIT_MS,③ 下面出原因句;剛沒讀到先不出(只差一輪輪詢不跳版面);其他情況不出", !run("wait")["onb-wait"].hidden && run("waitNew")["onb-wait"].hidden && E["onb-wait"].hidden && /const ONB_WAIT_MS = 12000;/.test(src) && /<p class="onb-wait" id="onb-wait" data-i18n="onb\.wait" hidden><\/p>/.test(html));
  const dd = (st, list) => { const C = { TR_BAGS: { local: { st } }, RP: { list }, trExecState: () => "idle", trWith: () => ({}), trStored: () => ({}), trZDraft: () => false }; vm.createContext(C); vm.runInContext(cutFn(src, "onbData"), C); return C.onbData("local"); };
  ok("② onbData.wait:問過了、沒有報告 → true;開機第一輪還沒回來(st null)不算;讀到了不算", dd({ report: null }, []).wait === true && dd(null, []).wait === false && dd({ report: {} }, []).wait === false
    && (() => { const C = { TR_BAGS: { cloud: { st: { report: null }, list: [], listLoaded: true } }, RP: { list: [] }, libCloud: () => "stopped", trExecState: () => "idle" }; vm.createContext(C); vm.runInContext(cutFn(src, "onbData"), C); const a = C.onbData("cloud").wait; C.libCloud = () => "stale"; const b = C.onbData("cloud").wait; C.libCloud = () => "live"; return a === false && b === false && C.onbData("cloud").wait === true; })());
    /* 真跑 onbEval 兩輪(本機、雲端各一):第一輪完成送事件、存旗標;第二輪走 flag,不再送 */
  { for (const env of ["local", "cloud"]) { const sent = [], saved = [], F0 = { local: "done", cloud: "cloudDone" };
      const C = { ONB: { prefs: { done: false, cloudDone: false }, v: { local: { base: false, open: [] }, cloud: { base: false, open: [] } } }, ONB_FLAG: F0, onbData: () => ({ bt: true, funded: true, known: true }), onbSave: (o) => saved.push(o), trackFeature: (n) => sent.push(n), onbEnv: () => env };
      vm.createContext(C); vm.runInContext(["onbSteps", "onbPhase", "onbEval"].map((n) => cutFn(src, n)).join("\n"), C);
      const a = C.onbEval(env), b = C.onbEval(env);
      ok("② " + env + ":完成當下 view F、事件只送一次、旗標存一次", a.ph.view === "F" && b.ph.view === "F" && sent.length === 1 && sent[0] === (env === "local" ? "onb_done" : "onb_done_cloud") && saved.length === 1, JSON.stringify({ sent, saved })); } }
  ok("② 完成事件只在 onbEval 送,onbPaint 不碰", !/onb_done/.test(cutFn(src, "onbPaint")) && (src.match(/trackFeature\("onb_done"\)/g) || []).length === 1);
  const seen = [];
  const mkEl = (tag, cls, txt) => ({ tag, className: cls || "", kids: [], attrs: {}, text: txt == null ? "" : String(txt), on: {}, append(...x) { this.kids.push(...x); }, appendChild(x) { this.kids.push(x); return x; }, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { this.on[k] = f; } });
  const box = (id) => { const b = mkEl("p", "wc-alert"); b.id = id; b.hidden = true; Object.defineProperty(b, "textContent", { set() { b.kids = []; } }); b.classList = { toggle(c, on) { b.calm = !!on; } }; return b; }, A = { "wc-alert": box("wc-alert"), "wf-alert": box("wf-alert") };
  const C2 = { $: (id) => A[id], t: (k) => k, LANG: "zh", WC: {}, wdEl: mkEl, trackFeature: (n) => seen.push(n), trOpen: () => seen.push("trOpen") }; vm.createContext(C2); vm.runInContext(cutFn(src, "wcAlert"), C2);
  const flat = (n) => n.kids.map((k) => (k.kids && k.kids.length ? flat(k) : k.text || k)).join("|");
  C2.wcAlert("stopped");
  ok("② #25 停機:E 與 F 各一行,句子＋到自動下單", !A["wc-alert"].hidden && !A["wf-alert"].hidden && !A["wc-alert"].calm && flat(A["wc-alert"]).includes("wc.stopped|wc.goTrade") && flat(A["wf-alert"]).includes("wc.stopped|wc.goTrade"), flat(A["wc-alert"]));
  A["wf-alert"].kids.find((k) => k.className === "ln-arrow").on.click();
  ok("② 停機的箭頭開自動下單頁、記 wc_stopped_go", seen.join() === "wc_stopped_go,trOpen", seen.join());
  C2.wcAlert("stale");
  ok("② #26 過時:灰記號、沿用 tr.cloud.unknown、沒有鈕", A["wc-alert"].calm === true && flat(A["wc-alert"]).includes("tr.cloud.unknown") && !A["wc-alert"].kids.some((k) => k.className === "ln-arrow"), flat(A["wc-alert"]));
  C2.wcAlert("live");
  ok("② 恢復(live)或本機(null):兩行都收掉", A["wc-alert"].hidden && A["wf-alert"].hidden);
  ok("② wcPaint 每輪都叫 wcAlert,在指紋 return 之前;E 的那行在記號與步驟之間、F 的在 .fin-grp 最上面", cutFn(src, "wcPaint").indexOf("wcAlert(cloud)") > 0 && cutFn(src, "wcPaint").indexOf("wcAlert(cloud)") < cutFn(src, "wcPaint").indexOf("key !== WC.key")
    && wc.indexOf('class="wc-mark"') < wc.indexOf('id="wc-alert"') && wc.indexOf('id="wc-alert"') < wc.indexOf('id="onb-steps"') && wf.indexOf('id="wf-alert"') < wf.indexOf('id="wf-idea"')); }
// ── ② ①的策略卡(spec desktop-welcome-library-first §2.2):wcCard 原文接假 DOM 跑 ──
{ const css = read(path.join(R, "welcome.css")), lib = read(path.join(R, "library.js"));
  const mkEl = (tag, cls, txt) => ({ tag, className: cls || "", textContent: txt == null ? "" : String(txt), kids: [], attrs: {}, dataset: {}, on: {}, id: "",
    append(...xs) { xs.forEach((x) => this.kids.push(x)); }, appendChild(x) { this.kids.push(x); return x; }, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { this.on[k] = f; } });
  const C = { wdEl: mkEl, t: (k) => "<" + k + ">", WC: { tip: 0 }, libSymbolNodes: () => ["BTC/USDT"], libRich: (k, v) => mkEl("frag", "", k), libMono: (x) => mkEl("span", "mono", x),
    trackFeature() {}, onbEnv: () => "local", wcDetail() {}, wcUse() {} };
  vm.createContext(C);
  const blk = lib.slice(lib.indexOf("/* ── 純邏輯("), lib.indexOf("/* ── 純邏輯到此"));
  vm.runInContext(blk.replace(/^const /gm, "var ") + "\n" + cutFn(src, "wcCard"), C);
  const rep = { annual_return: 12.3, total_return: 40, sharpe: 1.234, max_drawdown: -18.5, equity_from: "2020-01-01", equity_to: "2026-06-30" };
  const walk = (n, out) => { out.push(n); (n.kids || []).forEach((k) => typeof k === "object" && walk(k, out)); return out; };
  const c1 = walk(C.wcCard({ id: 7, title: "A", report: rep }, true), []), c2 = walk(C.wcCard({ id: 8, title: "B", report: rep }, false), []);
  const short = walk(C.wcCard({ id: 9, title: "C", report: Object.assign({}, rep, { equity_from: "2026-01-01", equity_to: "2026-06-30" }) }, true), []);
  const cls = (all, c) => all.filter((n) => (" " + n.className + " ").includes(" " + c + " "));
  const arrow = cls(c1, "ln-arrow")[0], tips = cls(c1, "mp-tip");
  ok("② 卡不畫 tag、不畫曲線(沒有 LWC);名字是按鈕;CTA 是 .ln-arrow、字是 lib.use、箭頭 aria-hidden",
    !c1.some((n) => /\btag\b|wc-curve/.test(n.className)) && !/LightweightCharts|wcCurve|createChart/.test(src) && cls(c1, "t")[0].tag === "button"
    && arrow && arrow.tag === "button" && cls(c1, "lbl")[0].textContent === "<lib.use>" && cls(c1, "ar")[0].attrs["aria-hidden"] === "true", JSON.stringify(c1.map((n) => n.className)));
  { const m = cls(c1, "m")[0], nws = m.kids.filter((k) => typeof k === "object" && k.className === "nw");
    ok("② 名字是 button.t 包 span.tn(兩行截斷寫在 span,WebKit 不吃 button 上的 line-clamp);meta 的「·」跟後面那段同一個 nowrap,折行不會掛孤點",
      cls(c1, "t")[0].kids.length === 1 && cls(c1, "t")[0].kids[0].className === "tn" && cls(c1, "t")[0].kids[0].textContent === "A"
      && nws.length === 1 && nws[0].kids[0] === "· " && !m.kids.some((k) => typeof k === "string" && /·/.test(k))
      && /\.wc-card \.t \.tn \{ display: -webkit-box; -webkit-line-clamp: 2;/.test(css) && !/\.wc-card \.t \{[^}]*line-clamp/.test(css) && /\.wc-stat \.v \{ min-width: 7ch;/.test(css), JSON.stringify(m.kids)); }
  ok("② gloss 只掛第一張卡的三個 label:.mp-tip 按鈕 + 緊鄰的 span.tip[role=tooltip](aria-describedby 對上 id),字重用 bt.tip.*;第二張沒有",
    tips.length === 3 && cls(c2, "mp-tip").length === 0 && cls(c1, "k").every((k) => k.kids.length === 2 && k.kids[0].className === "mp-tip" && k.kids[1].className === "tip" && k.kids[1].attrs.role === "tooltip" && k.kids[0].attrs["aria-describedby"] === k.kids[1].id && k.kids[1].id)
    && cls(c1, "tip").map((n) => n.textContent).join() === "<bt.tip.annReturn>,<bt.tip.sharpe>,<bt.tip.maxDrawdown>", JSON.stringify(cls(c1, "tip").map((n) => n.textContent)));
  ok("② 三格:第一格年化依正負上色、Sharpe 兩位不上色、最大回撤一律紅;樣本未滿 1 年第一格換總報酬(label 與 gloss 一起換)",
    cls(c1, "v").map((n) => n.className + "=" + n.textContent).join("|") === "v mono up=+12.30%|v mono=1.23|v mono down=−18.50%"
    && cls(short, "mp-tip")[0].textContent === "<lib.kv.total>" && cls(short, "tip")[0].textContent === "<bt.tip.totalReturn>" && cls(short, "v")[0].textContent === "+40.00%", JSON.stringify([cls(c1, "v").map((n) => n.className + "=" + n.textContent), cls(short, "v")[0]]));
  ok("② welcome.css:卡一張一列(info／stats／act 三格)、<640 兩排、<420 三排且 CTA 靠左;Arrow link hover 字換 --link-quiet-hover、只有 .lbl 補底線、熱區上下補到 44;不再有 .st-row／.tag 規則",
    /\.wc-card \{\s*display: grid; grid-template-columns: minmax\(0, 1fr\) auto auto; grid-template-areas: "info stats act";/.test(css)
    && /@container \(max-width: 639px\) \{\s*\.wc-card \{ grid-template-columns: minmax\(0, 1fr\) auto; grid-template-areas: "info info" "stats act";/.test(css)
    && /@container \(max-width: 419px\) \{\s*\.wc-card \{ grid-template-columns: minmax\(0, 1fr\); grid-template-areas: "info" "stats" "act";[^}]*\}\s*\.wc-card \.act \{ justify-self: start; \}/.test(css)
    && /\.ln-arrow:hover:not\(\[aria-disabled="true"\]\) \{ color: var\(--link-quiet-hover\); \}/.test(css) && /\.ln-arrow:hover:not\(\[aria-disabled="true"\]\) \.lbl \{ text-decoration: underline;/.test(css)
    && /@container \(max-width: 259px\) \{ \.wc-cards \{ display: none; \} \}/.test(css)
    && /\.ln-arrow::before \{ content: ""; position: absolute; left: 0; right: 0; top: -6px; bottom: -6px; \}/.test(css) && /min-height: 32px/.test(css.slice(css.indexOf(".ln-arrow {")))
    && !/\.st-row|\.tag\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")));
  // 骨架→真卡不跳版:骨架拿樣板策略走 wcCard 原樣建(同斷行),字換透明條;真卡的名字區只在一行排(≥640)先留名字一行＋meta 兩行(兩排時不留,設計稽核 D2)
  ok("② 骨架由 wcCard(樣板策略)建、每段字包進 .skt、整張 aria-hidden + inert;.info 只在 ≥640 先留名字一行＋meta 兩行的高度;wcBusySync 不碰骨架",
    /const c = wcCard\(WC_SKEL, false\)/.test(cutFn(src, "wcSkel")) && /k = wdEl\("span", "skt"\)/.test(cutFn(src, "wcSkel")) && /c\.setAttribute\("aria-hidden", "true"\); c\.inert = true;/.test(cutFn(src, "wcSkel"))
    && /@container \(min-width: 640px\) \{ \.wc-card \.info \{ min-height: calc\(13px \* 1\.45 \+ var\(--space-2\) \+ 2 \* 12px \* 1\.5\); \} \}/.test(css)
    && (css.match(/min-height: calc\(13px \* 1\.45/g) || []).length === 1 && /\.wc-card\.is-skel \.skt \{ color: transparent;/.test(css)
    && /querySelectorAll\("\.wc-card:not\(\.is-skel\) \.ln-arrow"\)/.test(cutFn(src, "wcBusySync"))); }
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
      PAPER: "paper", trackFeature: (n) => log.push("track:" + n), trPickOff: () => !L.listLoaded, trNames: () => [], trReport: () => ({}), trVenueId: () => null, trPaperTwOk: () => true, trTwBroker: () => false, trTwdVenueLock: () => null, trTwStockSelf: () => null,
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
// ── ② 連接框(0.1.52 案一,spec connect-account-plan1)──
{ const open = (venue, bound) => {
    const log = [], el = () => ({ hidden: true, classList: { add() {}, remove() {}, toggle() {} }, focus() { log.push("focus"); }, querySelector: () => null });
    const els = { "cx-scrim": el(), "view-ws": el(), "cx-body": el(), "cx-close": el() };
    const C = { ENV: { cur: "local" }, TR: { env: "local" }, TR_BAGS: { local: { sig: {} }, cloud: {} }, PAPER: "paper", CAPITAL: "capital", CX_VENUES: { binance: {}, okx: {} },
      CXF: { env: "local", venue: null, ip: "1.2.3.4" }, cxForget() {}, cxBag: () => C.TR_BAGS.local, trVenueIds: () => (Array.isArray(bound) ? bound : bound ? [bound] : []), trSetupOnly: () => false, envCloudKind: () => "running",
      trackFeature: (n) => log.push(n), $: (id) => els[id] || null, requestAnimationFrame: (f) => f(), cxModalPaint() {}, capResume() {}, cxIpLookup() {}, cxFocusStart: () => log.push("focusStart"), cxOpener: null, CXW: { cb: null }, trPresLoginHeld: () => false };
    vm.createContext(C); vm.runInContext(cutFn(trade, "cxModalOpen").replace("function cxModalOpen", "var cxModalOpen = function"), C);
    C.cxModalOpen(null, venue); return { venue: C.CXF.venue, bound: C.CXF.bound, paperBound: C.CXF.paperBound, log: log.join() }; };
  const a = open(), d = open("president"), e = open(null, "okx"), f = open(null, "paper");
  ok("③ 連接框不預選:沒帶參數 → venue = null(交易所磚),焦點交給 cxFocusStart;每次打開記一次 cx_open",
    a.venue === null && a.bound === false && a.paperBound === false && a.log.split(",").filter((x) => x === "cx_open").length === 1 && /focusStart$/.test(a.log), JSON.stringify(a));
  ok("③ 帶統一照舊開在統一那條", d.venue === "president", JSON.stringify(d));
  ok("③ 綁著真實帳戶:停在那一家、bound 為真;綁著模擬:不鎖、回磚(paperBound),連上真實帳戶直接取代",
    e.venue === "okx" && e.bound === true && e.paperBound === false && f.venue === null && f.bound === false && f.paperBound === true, JSON.stringify([e, f]));
  { const g = open(null, ["paper", "president"]);
    ok("③ 模擬跟統一同綁(paper 排第一):算綁著真實帳戶、停在統一,不出「取代模擬」那一態(連上別家會把統一一起擠掉)", g.bound === true && g.paperBound === false && g.venue === "president", JSON.stringify(g)); }
  { const paint = cutFn(trade, "cxModalPaint"), conn = cutFn(trade, "cxConnect"), pg = cutFn(trade, "cxPaperGo"), vf = cutFn(trade, "cxVenueField");
    ok("③ 磚那一態沒有主鈕、Enter 不送;框腳模擬綁著任何一種都不出、驗證碼那一步不出、送出中停用;綁著真實帳戶主鈕寫「換金鑰」、沒有「換一家」",
      /go\.hidden = !kc && !picked;/.test(paint) && /^function cxConnect\(\) \{\n  if \(!CXF\.venue\) return;/.test(conn)
      && /pb\.hidden = !!kc \|\| CXF\.bound \|\| CXF\.paperBound; pb\.disabled = !!L\.cx\.busy \|\| down;/.test(paint)
      && /CXF\.bound \? t\("cx\.changeKey"\) : t\("cx\.connect"\)/.test(paint) && /if \(!CXF\.bound\) \{ const b = trEl\("button", "btn-quiet", t\("cx\.change"\)\)/.test(vf)
      && /if \(L\.cx\.busy \|\| CXF\.bound \|\| CXF\.paperBound \|\| CXF\.kc\) return;\n  CXF\.venue = PAPER;/.test(pg)); }
  // 純邏輯:期貨磚、建金鑰網址、權限句、被拒時帶 IP
  { const C = { CAPITAL: "capital", BINANCE: "binance", PRES_LOCAL_ON: true, CAPL_LOCAL_ON: true, CXF: { venue: null } };
    vm.createContext(C);
    vm.runInContext([/const CX_VENUES = \{[\s\S]*?\};\n/.exec(trade)[0].replace("const CX_VENUES", "var CX_VENUES"), "var BITGET_VERIFIED_MODES = [];",
      /const cxPresListed = [^\n]*\n/.exec(trade)[0].replace("const ", "var "), /const cxCaplListed = [^\n]*\n/.exec(trade)[0].replace("const ", "var "),
      /const cxPermKey = [^\n]*\n/.exec(trade)[0].replace("const ", "var "), /const CX_IPADD_SKIP = [^\n]*\n/.exec(trade)[0].replace("const ", "var "),
      ...["cxTwTiles", "cxKeyUrl", "cxIpAddFor", "trErrToken"].map((n) => cutFn(trade, n))].join("\n"), C);
    const J = JSON.stringify;
    ok("③ 台灣期貨磚:Mac(不是 win32)不出磚(null → 原位講 cx.macTw);Windows 列群益、統一;雲端只列群益",
      C.cxTwTiles("local", "darwin") === null && C.cxTwTiles("local", "linux") === null && J(C.cxTwTiles("local", "win32")) === J([["capital", "cap.venue"], ["president", "pres.venue"]])
      && J(C.cxTwTiles("cloud", "darwin")) === J([["capital", "cap.venue"]]), J([C.cxTwTiles("local", "win32"), C.cxTwTiles("cloud", "darwin")]));
    ok("③ 磚的順序 = Binance、BingX、OKX、Gate.io、Bybit、Bitget、StockCoin(同網頁 CX_VENUES、landing)", J(Object.keys(C.CX_VENUES)) === J(["binance", "bingx", "okx", "gateio", "bybit", "bitget", "stockcoin"]));
    ok("③ 建金鑰網址:Binance、BingX、OKX、Gate.io、Bybit 有不帶語系段的 https keyUrl;Bitget(待 Wei 定)、StockCoin 沒有(不出鈕)",
      J(Object.keys(C.CX_VENUES).filter((id) => C.cxKeyUrl(id))) === J(["binance", "bingx", "okx", "gateio", "bybit"])
      && Object.keys(C.CX_VENUES).every((id) => !C.cxKeyUrl(id) || (/^https:\/\//.test(C.cxKeyUrl(id)) && !/\/(zh|en)[-_/]/i.test(C.cxKeyUrl(id)))) && C.cxKeyUrl("nope") === null);
    ok("③ 權限句:Binance、Gate.io 講合約交易,其他講交易", C.cxPermKey("binance") === "cx.perm.futures" && C.cxPermKey("gateio") === "cx.perm.futures" && ["okx", "bingx", "bybit", "bitget", "stockcoin"].every((v) => C.cxPermKey(v) === "cx.perm"));
    const r = (code, reason) => ({ code, detail: { reason } });
    ok("③ 被拒時帶 IP(只有這台電腦):Binance 一律不帶(IP 在步驟 1);其他家 IP_OR_KEY／TRADING_DISABLED／REJECTED 帶,REJECTED 已講真原因的三種不帶;雲端每一家都不帶(IP 常駐步驟 1);其他錯不帶",
      ["IP_OR_KEY", "REJECTED", "TRADING_DISABLED"].every((c) => !C.cxIpAddFor(r(c, "x"), "binance", false))
      && C.cxIpAddFor(r("IP_OR_KEY"), "okx", false) && C.cxIpAddFor(r("TRADING_DISABLED"), "bybit", false) && C.cxIpAddFor(r("REJECTED", "Invalid API-key, IP"), "gateio", false)
      && ["IP_OR_KEY", "TRADING_DISABLED"].every((c) => ["okx", "bybit", "stockcoin", "binance"].every((v) => !C.cxIpAddFor(r(c), v, true)))
      && ["[okx_account_mode] x", "[bitget_account_mode:uta] x", "[bitget_copy_trading_key] x"].every((x) => !C.cxIpAddFor(r("REJECTED", x), "okx", false))
      && !C.cxIpAddFor(r("REJECTED", "x"), "okx", true) && !C.cxIpAddFor(r("NETWORK"), "okx", false) && !C.cxIpAddFor(r("IP_OR_KEY"), "paper", false) && !C.cxIpAddFor(null, "okx", false)); }
  // 磚那一態接假 DOM 跑:已綁模擬那一句、兩組磚、Mac 那一句、點磚記 cx_venue_pick
  { const mk = (tag) => { const n = { tag, className: "", id: "", textContent: "", children: [], attrs: {}, on: {}, disabled: false,
      appendChild(c) { this.children.push(c); return c; }, append(...c) { c.forEach((x) => this.children.push(x)); }, setAttribute(k, v) { this.attrs[k] = String(v); },
      addEventListener(e, fn) { this.on[e] = fn; } }; return n; };
    const run = (o) => {
      const log = [], C = { document: { createElement: mk }, CAPITAL: "capital", PAPER: "paper", BINANCE: "binance", PRES_LOCAL_ON: true, CAPL_LOCAL_ON: true,
        CXF: { env: o.env || "local", venue: null, paperBound: !!o.paperBound, bound: false }, window: { blave: { platform: o.platform || "win32" } },
        t: (k) => k, trackFeature: (n) => log.push(n), cxForget() {}, cxModalPaint: () => log.push("paint"), cxIpLookup: () => log.push("ip"), cxFocusStart: () => log.push("focus"),
        cxVenuesFor: () => ["binance", "bingx", "okx"], trVenueLabel: (id) => id.toUpperCase(), $: () => null };
      vm.createContext(C);
      vm.runInContext([cutFn(trade, "trEl"), /const cxPresListed = [^\n]*\n/.exec(trade)[0].replace("const ", "var "), /const cxCaplListed = [^\n]*\n/.exec(trade)[0].replace("const ", "var "),
        "var CX_VENUES = { binance: {}, bingx: {}, okx: {} };", ...["cxTwTiles", "cxPick", "cxTiles", "cxVenueField"].map((n) => cutFn(trade, n))].join("\n"), C);
      const L = { cx: { busy: !!o.busy }, sig: {} }, w = C.cxVenueField(L);
      return { C, L, log, w, flat: (function walk(n, out) { out.push(n); (n.children || []).forEach((c) => walk(c, out)); return out; })(w, []) };
    };
    const a = run({}), tiles = a.flat.filter((n) => n.className === "cx-tile");
    ok("③ 還沒選:兩組磚(加密貨幣三家＋台灣期貨群益、統一),磚是 type=button、id 帶交易所、組有 role=group 指到組標籤;沒有已綁模擬那一句",
      JSON.stringify(tiles.map((n) => n.id)) === JSON.stringify(["cx-tile-binance", "cx-tile-bingx", "cx-tile-okx", "cx-tile-capital", "cx-tile-president"])
      && tiles.every((n) => n.type === "button" && !n.disabled) && a.flat.filter((n) => n.className === "cx-tiles").every((g) => g.attrs.role === "group" && /^cx-grp-/.test(g.attrs["aria-labelledby"]))
      && !a.flat.some((n) => n.className === "cx-replace"), JSON.stringify(tiles.map((n) => n.id)));
    tiles[2].on.click();
    ok("③ 點磚:記 cx_venue_pick(不帶交易所名)、進那一家、重畫、加密貨幣先查 IP、焦點交給 cxFocusStart", a.C.CXF.venue === "okx" && a.log.join() === "cx_venue_pick,paint,ip,focus", a.log.join());
    const b = run({ paperBound: true, platform: "darwin" });
    ok("③ 已綁模擬:磚上方一句 cx.replacePaper;Mac:台灣期貨標籤下是 cx.macTw、不出期貨磚",
      b.w.children[0].className === "cx-replace" && b.w.children[0].textContent === "cx.replacePaper" && b.flat.some((n) => n.className === "cx-macnote" && n.textContent === "cx.macTw")
      && !b.flat.some((n) => /cx-tile-(capital|president)/.test(n.id)));
    const c = run({ busy: true });
    ok("③ 模擬送出中:磚停用", c.flat.filter((n) => n.className === "cx-tile").every((n) => n.disabled));
    // replace-paper A 案:綁著模擬、自動下單正在跑、選了一家 → 主鈕正上方 cx.replacePaperRun;沒在跑(暫停、停了、不知道)、還在磚、驗證碼那一步、沒綁模擬都不出
    { const X = {}; vm.createContext(X); vm.runInContext(cutFn(trade, "cxStopsRun"), X);
      const paint = cutFn(trade, "cxModalPaint");
      ok("③ 已綁模擬＋正在跑:選了一家才出「連上後模擬交易停止」;halted／dead／unknown／unconfirmed 等其他態／磚／驗證碼／沒綁模擬不出;框腳自己一格、每次重畫先藏(群益、統一提早 return 的路不留)",
        X.cxStopsRun(true, true, false, "running") === true
        && ["halted", "dead", "unknown", "loading", "unconfirmed", "setup", "noaccount", null].every((h) => X.cxStopsRun(true, true, false, h) === false)
        && X.cxStopsRun(true, false, false, "running") === false && X.cxStopsRun(true, true, true, "running") === false && X.cxStopsRun(false, true, false, "running") === false
        && /^function cxModalPaint\(\) \{\n(?:  \/\/[^\n]*\n)?[^\n]*\$\("cx-stops"\)\.hidden = true;\n  if \(CXF\.venue === CAPITAL/.test(paint)
        && /const stops = cxStopsRun\(CXF\.paperBound, picked, !!kc, envHeadState\(L\.st, Date\.now\(\)\)\);\n  \$\("cx-stops"\)\.hidden = !stops; \$\("cx-stops"\)\.textContent = stops \? t\("cx\.replacePaperRun"\) : "";/.test(paint)
        && /<span class="del-where" id="cx-stops" hidden><\/span>/.test(read(path.join(R, "index.html")))); }
    // 頭列(稽核 v052 建議 7):標題已是「連接群益期貨／連接統一期貨」的那幾步傳 noName,只留「換一家」;綁著又不講名字 → 頭列整個不出
    const head = (venue, noName, bound) => { const d = run({}); d.C.CXF.venue = venue; d.C.CXF.bound = bound; const w = d.C.cxVenueField(d.L, noName), h = w.children[0];
      return h ? h.children.map((x) => x.textContent).join("|") : "-"; };
    ok("③ 頭列:一般「名稱|換一家」;群益本機／統一 noName 只剩「換一家」;綁著＋noName 不出頭列;呼叫端只在標題帶名字那幾步傳 noName",
      head("okx", false, false) === "OKX|cx.change" && head("president", true, false) === "cx.change" && head("capital", true, true) === "-" && head("capital", false, true) === "CAPITAL"
      && /f\.appendChild\(cxVenueField\(TR_BAGS\.local, true\)\);/.test(read(path.join(R, "capital_local.js")))
      && /view\.indexOf\("d-prep"\) === 0\) \{ box\.appendChild\(cxVenueField\(TR_BAGS\.local, true\)\);/.test(read(path.join(R, "president.js")))
      && /view === "d-mac"\) \{ box\.appendChild\(cxVenueField\(TR_BAGS\.local\)\);/.test(read(path.join(R, "president.js")))
      && /box\.appendChild\(cxVenueField\(TR_BAGS\.cloud\)\);/.test(read(path.join(R, "capital.js")))); }
  ok("③ 綁定成功的埋點:本機 cxConnected 與雲端成功那一條都分模擬／真實;框標題與自動下單頁入口鈕同一句 cx.title",
    /trackFeature\(CXF\.venue === PAPER \? "cx_paper_ok" : "cx_real_ok"\);/.test(cutFn(trade, "cxConnected")) && /trackFeature\(venue === PAPER \? "cx_paper_ok" : "cx_real_ok"\);/.test(cutFn(trade, "cxConnectCloud"))
    && /<h6 id="cx-title" data-i18n="cx\.title"><\/h6>/.test(read(path.join(R, "index.html"))) && !/t\("cx\.connect"\)\); b\.type = "button"; b\.id = "tr-connect"/.test(trade));
  ok("③ 建金鑰鈕記 cx_key_page(不帶交易所名),外開走 open-external;雲端每一家都把主機 IP 寫進剪貼簿(同網頁),這台電腦只有 Binance",
    /trackFeature\("cx_key_page"\);\n    const url = cxKeyUrl\(venue\); if \(url\) window\.blave\.openExternal\(url\);\n    const ip = CXF\.env === "cloud" \? cxCloudIp\(\) : venue === BINANCE \? CXF\.ip : null;/.test(cutFn(trade, "cxKeyPageBtn")));
  ok("③ 框腳有「先用模擬交易」(#cx-paper,data-i18n cx.paperFoot),接到 cxPaperGo", /<button type="button" class="btn-quiet" id="cx-paper" data-i18n="cx\.paperFoot" hidden><\/button>/.test(read(path.join(R, "index.html")))
    && /\$\("cx-paper"\)\.addEventListener\("click", cxPaperGo\);/.test(trade));
  ok("③ 「先用模擬交易」熱區補到 44 高、寬至少 44(設計稽核 0153 #5,同 #cx-change)",
    /#cx-paper::before \{ inset: auto; left: 50%; top: 50%; width: max\(44px, calc\(100% \+ 8px\)\); height: 44px; transform: translate\(-50%, -50%\); \}/.test(read(path.join(R, "trade.css"))));
  ok("③ 金鑰去向是提示泡:觸發點 tabindex=0、aria-describedby 指到 role=tooltip 的 .tip(Esc 由 app.js tipEsc 認);展開列 cx-store-q 拿掉",
    /tg\.tabIndex = 0; tg\.id = "cx-keyat"; tip\.id = "cx-store"; tip\.setAttribute\("role", "tooltip"\); tg\.setAttribute\("aria-describedby", tip\.id\);/.test(cutFn(trade, "cxModalPaint"))
    && /trEl\("span", "mp-tip", t\(cloud \? "cx\.fact\.keyCloud" : "cx\.fact\.key"\)\), tip = trEl\("span", "tip", t\(cloud \? "cx\.leadCloud" : "cx\.lead"\)\)/.test(cutFn(trade, "cxModalPaint")) && !/cx-store-q|storeOpen/.test(trade)); }

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
