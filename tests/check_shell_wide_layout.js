// 寬螢幕中欄版型 A(Wei 11-20;designer wide-screen-layout-2026-11-20;canon › 行長上限屬於文字,不屬於表面)。不開窗,只讀 CSS:
//   1. 中欄各頁(自動下單、策略組合、策略庫、報告清單、策略頁成交測試)不設頁面寬上限,內容吃滿欄寬
//   2. 要讀完的句子留行長上限(44em 或既有的 ch 上限),報告文章與它的頁頭同一欄 680、一起置中
//   3. 欄寬變寬時三張主要的圖跟著長高、有下限有上限(clamp,上限 ≤ 440),2560 不會壓成一條線
//   7. 聊天欄預設寬跟著視窗(clamp(452, 30vw, 620)),用戶拉過的照舊;8. 0.1.59 漏掉的幾處封頂(designer desktop-widescreen-2026-11-24 A)
// 實際排出來的寬度要開窗量(見檔尾清單),這裡守的是規則本身。
// Run: node tests/check_shell_wide_layout.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const css = (f) => fs.readFileSync(path.join(R, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  → " + d)); if (!c) red++; };
const rule = (src, sel) => { const i = src.indexOf(sel + " {"); if (i < 0) return null; return src.slice(i, src.indexOf("}", i) + 1); };
const px = (s) => [...String(s).matchAll(/max-width:\s*(?:calc\()?\s*(\d+)px/g)].map((m) => +m[1]);

const trade = css("trade.css"), lib = css("library.css"), rpts = css("reports.css"), xt = css("report-xt.css"),
  share = css("report-share.css"), blocks = css("report-blocks.css"), bt = css("report-backtest.css");

// 1. 頁面上限拿掉
ok("1 自動下單／策略組合:#tr、#po 的 .pf 子元素與頁首都沒有 px 寬上限", !/#(tr|po) > \.pf[^{]*\{[^}]*max-width/.test(trade) && !/#(tr|po) > \.main-head \{[^}]*max-width/.test(trade));
ok("1 策略庫:.lib-body 的子元素沒有寬上限", !/\.lib-body > \*\s*\{[^}]*max-width/.test(lib));
ok("1 報告清單:.rpt-body 子元素、工具列、空清單示意列都沒有 px 寬上限",
  !/\.rpt-body > \*\s*\{[^}]*max-width/.test(rpts) && px(rule(rpts, ".rpt-tools")).length === 0 && !/\.rpt-fog \.rpt-row\s*\{[^}]*max-width/.test(rpts));
ok("1 策略頁成交測試:.xt 子元素不設寬上限(max-width: none)", /\.xt > \*\s*\{\s*max-width: none;/.test(xt));
// 只看宣告,不看 @container／@media 的條件(那是斷點,不是上限)
const caps = ["trade.css", "library.css", "reports.css", "report-xt.css"].flatMap((f) => px(css(f).replace(/@(container|media)[^{]*\{/g, "{")).filter((n) => n >= 600).map((n) => f + ":" + n));
// 唯一留下的 ≥600 上限是掃讀表與清單列的 1200(第 4、8 條釘住只在哪幾個選擇器):trade.css 兩條(.pf-scroll、.pf-log)、library.css 一條(清單與詳情同一條)、report-xt.css 一條
const only1200 = caps.filter((c) => !/:1200$/.test(c)), n1200 = { "trade.css": 2, "library.css": 1, "report-xt.css": 1 };
ok("1 這四個檔不再有 760／680 的頁面上限;≥600 的只剩掃讀寬 1200(條數照清單)", only1200.length === 0
  && Object.entries(n1200).every(([f, n]) => caps.filter((c) => c === f + ":1200").length === n) && !caps.includes("reports.css:1200"), caps.join(", "));

// 2. 文字留行長上限
ok("2 自動下單／策略組合頁首折行的說明句 44em", /\.main-head-desc\.wrap \{[^}]*max-width: 44em;/.test(trade));
ok("2 報告清單的訊息句 44em", /\.rpt-msg \{[^}]*max-width: 44em;/.test(rpts));
ok("2 既有的句子上限還在:.verdict 64ch、.pf-onboard 46ch", /\.verdict \{[^}]*max-width: 64ch;/.test(trade) && /\.pf-onboard \{[^}]*max-width: 46ch;/.test(trade));
ok("2 報告文章(.rb-report)與文章頁頭(.rpt-rhead)同一欄 680、都置中:清單吃滿、文章照文字的行長上限",
  /\.rb-report \{[^}]*max-width: 680px;[^}]*margin: 0 auto;/.test(blocks) && /\.rpt-rhead \{[^}]*max-width: 680px; margin-inline: auto;/.test(share));

// 3. 圖的高度
const clampOf = (src, sel) => { const m = /height:\s*clamp\((\d+)px,\s*(\d+)cqi,\s*(\d+)px\)/.exec(rule(src, sel) || ""); return m ? m.slice(1).map(Number) : null; };
const charts = { ".ov-canvas": clampOf(trade, ".ov-canvas"), ".mg-canvas": clampOf(trade, ".mg-canvas"), ".bt-canvas": clampOf(bt, ".bt-canvas") };
ok("3 三張主要的圖高度是 clamp(下限 px, cqi, 上限 px):下限同原本固定高(240／220／320)、上限 ≤ 440、上限 > 下限",
  charts[".ov-canvas"] && charts[".ov-canvas"][0] === 240 && charts[".mg-canvas"] && charts[".mg-canvas"][0] === 220 && charts[".bt-canvas"] && charts[".bt-canvas"][0] === 320
  && Object.values(charts).every((c) => c && c[2] <= 440 && c[2] > c[0] && c[1] >= 15 && c[1] <= 30), JSON.stringify(charts));
// cqi 要有量的對象:.ov-canvas 在 .trv 裡、.bt-canvas 在 .bt 裡,兩個都是 inline-size container;.mg-canvas 至少有中欄 .pane-main
ok("3 cqi 量得到欄寬:.trv、.bt 是 inline-size container,中欄 .pane-main 也是", /\.trv \{[^}]*container-type: inline-size;/.test(trade) && /\.bt \{[^}]*container-type: inline-size;/.test(bt)
  && /\.pane-main \{[^}]*container: main \/ inline-size;/.test(css("browser.css")));
// 聊天欄 0.1.60 的固定 452 時,2560 的中欄約 2560 − 側欄 236 − 452 − 左右 48 ≈ 1824(聊天欄最窄可拖到 336、收合剩 24,那時中欄更寬,圖照樣封頂在上限高):圖的寬高比不超過 1824 / 下限高度 的一半以下就算看得了
{ const W = 2560 - 236 - 452 - 48, h = (c) => Math.min(Math.max(c[0], W * c[1] / 100), c[2]);
  const ratio = Object.fromEntries(Object.entries(charts).filter(([, c]) => c).map(([k, c]) => [k, +(W / h(c)).toFixed(2)]));
  ok("3 2560 寬時(中欄約 1824)三張圖的寬高比都 ≤ 5.5(固定高時是 5.7–8.3)", Object.values(ratio).length === 3 && Object.values(ratio).every((r) => r <= 5.5), JSON.stringify(ratio)); }

// 4. 掃讀寬上限(設計稽核 0.1.59 寬螢幕 #1 #2):表與清單列 1200、靠左;圖、數字條、頁首照舊吃滿。1920 內容約 1184 碰不到,2560 才作用
{ const capOf = (src, sel) => { const m = /max-width:\s*(?:calc\(\s*)?(\d+)px/.exec(rule(src, sel) || ""); return m ? +m[1] : null; };
  const chatAt = (vw) => Math.round(Math.max(452, Math.min(0.3 * vw, 620))), lib4 = css("library.css"), W2560 = 2560 - 236 - chatAt(2560) - 48, W1920 = 1920 - 236 - chatAt(1920) - 48;
  const caps4 = { ".pf-scroll": capOf(trade, ".pf-scroll"), ".pf-log": capOf(trade, ".pf-log"), ".lib-rows, #lib-grps, .lib-det": capOf(lib4, ".lib-rows, #lib-grps, .lib-det"), ".xt .xt-tbl": capOf(xt, ".xt .xt-tbl") };
  ok("4 掃讀表與清單列上限 1200(自動下單與策略組合的表 .pf-scroll、交易歷史 .pf-log、策略庫清單與詳情、成交測試比較表 .xt-tbl),沒有置中",
    Object.values(caps4).every((c) => c === 1200) && !/margin(-inline)?:\s*[^;]*auto/.test((rule(trade, ".pf-scroll") || "") + (rule(trade, ".pf-log") || "") + (rule(lib4, ".lib-rows, #lib-grps, .lib-det") || "") + (rule(xt, ".xt .xt-tbl") || "")), JSON.stringify(caps4));
  ok("4 2560(中欄內容約 " + W2560 + ")時表與清單列被 1200 收住;1920(約 " + W1920 + ")時碰不到上限、跟 A 版一樣吃滿", W2560 > 1200 && W1920 < 1200);
  ok("4 圖與數字條不受這個上限:.ov-canvas、.bt-canvas 沒有 max-width", !/max-width/.test(rule(trade, ".ov-canvas") || "") && !/max-width/.test(rule(bt, ".bt-canvas") || "")); }
// 5. 組合績效六格:.trv ≥ 1000 時一列六格,角落第 1 格左、第 6 格右(設計稽核 #3);窄時照舊 3 欄、≤520 兩欄
ok("5 組合績效:預設 3 欄;@container (min-width: 1000px) 改 repeat(6, 1fr)、第 1 格左兩角、第 6 格右兩角;≤520 仍是 2 欄",
  /\.bt-stats\.ov-stats\.perf-stats \{ grid-template-columns: repeat\(3, 1fr\); \}/.test(trade)
  && /@container \(min-width: 1000px\) \{\s*\.bt-stats\.ov-stats\.perf-stats \{ grid-template-columns: repeat\(6, 1fr\); \}[^@]*\.perf-stats \.stat:nth-child\(1\) \{ border-radius: var\(--radius-lg\) 0 0 var\(--radius-lg\); \}[^@]*\.perf-stats \.stat:nth-child\(6\) \{ border-radius: 0 var\(--radius-lg\) var\(--radius-lg\) 0; \}/.test(trade)
  && /@container \(max-width: 520px\) \{[^@]*\.bt-stats\.ov-stats\.perf-stats \{ grid-template-columns: repeat\(2, 1fr\); \}/.test(trade));
// 6. 44 熱區(設計稽核「其他」:form.css 拿掉 .cform-self::before 那條)。「我自己打」那顆鈕整個拿掉了(form.js 只剩主鈕 .btn-fill.cform-use),
//    熱區規則跟著走是對的;剩下的鈕各自有 44:主鈕 32 高 + ::before 上下各 7 = 46;答案鈕最小 32 + ::before 上下各 7 = 46
{ const app6 = css("app.css"), form6 = css("form.css"), ans6 = css("answers.css"), formJs = fs.readFileSync(path.join(R, "form.js"), "utf8");
  ok("6 表單沒有「我自己打」鈕了(form.js 沒有 cform-self／form.self),form.css 也沒有它的熱區規則", !/cform-self|form\.self/.test(formJs) && !/cform-self/.test(form6));
  ok("6 表單主鈕是 .btn-fill(32 高)、全域 .btn-fill::before inset -7px → 熱區 46 ≥ 44", /mk\("button", "btn-fill cform-use"/.test(formJs) && /\.btn-fill \{[^}]*height: 32px;/.test(app6) && /\.btn-fill::before, \.btn-out::before \{ content: ""; position: absolute; inset: -7px; \}/.test(app6));
  ok("6 答案鈕 min-height 32、::before 上下各外擴 7 → 熱區 ≥ 46;表單選項列 min-height 44", /\.ans-btn \{[^}]*min-height: 32px;/.test(ans6) && /\.ans-btn::before \{ content: ""; position: absolute; inset: -7px 0; \}/.test(ans6)
    && /\.cform-opt \{[^}]*min-height: 44px;/.test(form6)); }


// 7. 聊天欄預設寬(designer desktop-widescreen-2026-11-24 §2.2、§7.2):沒拉過(want null,或舊版收合時存下的預設 452)= 照 clamp(452, 30vw, 620) 跟著視窗(620 = 13px × 44em 572 + 內距 48);
//    拉過的照舊;雙擊分隔線或聚焦時按 Home 回到自動;仍過 paneClamp(中欄保底 480)。跑真的 panesInit,DOM 換成假的
{ const app = fs.readFileSync(path.join(R, "app.js"), "utf8");
  const src = app.slice(app.indexOf("const PANES = {"), app.indexOf("\npanesInit();"));
  const boot = (vw, saved, old) => {
    const els = {}, winL = {}, cls = new Set(), store = { ws_layout: saved === undefined ? null : JSON.stringify(saved) };
    const el = (id) => (els[id] = els[id] || { L: {}, classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, removeAttribute() {}, setPointerCapture() {}, addEventListener(k, f) { this.L[k] = f; } });
    const ctx = { $: el, window: { innerWidth: vw, addEventListener: (k, f) => (winL[k] = f) }, requestAnimationFrame: (f) => { f(); return 1; }, cancelAnimationFrame() {},
      localStorage: { getItem: (k) => store[k], setItem: (k, v) => (store[k] = v) }, Date,
      document: { body: { classList: { add() {}, remove() {} } }, documentElement: { classList: { toggle() {}, add: (k) => cls.add(k), remove: (k) => cls.delete(k) }, style: { setProperty() {} } } } };
    vm.runInNewContext(src + (old ? "\ndelete PANES.chat.auto; paneSt.chat.want = PANES.chat.def;" : "") + "\npanesInit(); this.st = paneSt;", ctx);
    return { st: ctx.st, resize: (w) => { ctx.window.innerWidth = w; winL.resize(); return ctx.st.chat.w; }, dbl: () => els["div-chat"].L.dblclick(), store, snapLeft: cls.has("ws-snap"),
      key: (k) => { let pd = 0; els["div-chat"].L.keydown({ key: k, preventDefault: () => pd++ }); return pd; },
      // 在分隔線本體(不是把手)按下、照 dxs 依序移動、放開;聊天欄 dir = -1,往左拖是變寬
      drag: (dxs, id = "div-chat") => { const d = els[id], ev = (x) => ({ button: 0, pointerId: 1, clientX: 1000 + x, target: { closest: () => null }, type: "pointerup", preventDefault() {} });
        d.L.pointerdown(ev(0)); dxs.forEach((x) => d.L.pointermove(ev(x))); d.L.pointerup(ev(dxs.length ? dxs[dxs.length - 1] : 0)); } };
  };
  // 對照組 = 同一份程式碼拿掉 auto(0.1.60 的固定 452);1024 時兩邊都是側欄先讓到 180、聊天 364
  const VW = [1024, 1280, 1370, 1440, 1920, 2560], auto = VW.map((vw) => boot(vw).st.chat.w), was = VW.map((vw) => boot(vw, undefined, true).st.chat.w);
  ok("7 沒存過偏好:1440 以下跟 0.1.60 一模一樣、1920 = 576、2560 = 620", JSON.stringify(auto.slice(0, 4)) === JSON.stringify(was.slice(0, 4)) && was[3] === 452 && auto[4] === 576 && auto[5] === 620,
    JSON.stringify({ auto, was }));
  const old = boot(2560, { side: { w: 236, want: 236, off: false }, chat: { w: 452, want: 452, off: true } });
  ok("7 舊版收合時存下的 want 452 當作沒拉過:展開後 2560 = 620;收合狀態照舊", old.st.chat.want === null && old.st.chat.off === true && old.st.chat.w === 620, JSON.stringify(old.st.chat));
  const own = boot(2560, { side: { w: 236, want: 236, off: false }, chat: { w: 500, want: 500, off: false } });
  ok("7 用戶拉過的寬照舊:want 500 在 2560 仍是 500,縮到 1920 也是 500", own.st.chat.w === 500 && own.resize(1920) === 500, JSON.stringify(own.st.chat));
  const b = boot(1440);
  const rs = [b.resize(1920), b.resize(2560), b.resize(1100)], mid1100 = 1100 - b.st.side.w - rs[2]; rs.push(b.resize(1440));
  ok("7 自動時視窗縮放跟著重算:1440 → 1920 → 2560 → 1100 → 1440 = 576／620／夾到中欄保底 480／452;resize 期間的 .ws-snap 用完就拿掉",
    rs[0] === 576 && rs[1] === 620 && rs[2] < 452 && mid1100 >= 480 && rs[3] === 452 && b.st.side.w === 236 && !b.snapLeft, JSON.stringify({ rs, mid1100 }));
  own.resize(2560); own.dbl();
  ok("7 雙擊分隔線回到自動(want null、存檔裡也是 null),2560 = 620;重開照舊是自動", own.st.chat.want === null && own.st.chat.w === 620 && JSON.parse(own.store.ws_layout).chat.want === null
    && boot(2560, JSON.parse(own.store.ws_layout)).st.chat.w === 620, JSON.stringify(own.st.chat));
  { const k = boot(2560, { chat: { w: 500, want: 500, off: false } }), arrow = k.key("ArrowRight"), afterArrow = k.st.chat.want, home = k.key("Home");
    ok("7 鍵盤:方向鍵寫成固定寬(500 → 484),聚焦時按 Home 等同雙擊回到自動 620、存檔 want null", arrow === 1 && afterArrow === 484 && home === 1 && k.st.chat.want === null && k.st.chat.w === 620
      && JSON.parse(k.store.ws_layout).chat.want === null, JSON.stringify({ afterArrow, st: k.st.chat })); }
  { const t = boot(1920), saved = () => JSON.parse(t.store.ws_layout || "{}").chat;
    t.drag([0.4]); const a = [t.st.chat.want, saved() && saved().want];
    t.drag([-2, -3, 3]); const b = t.st.chat.want; const w2560 = t.resize(2560);
    t.resize(1920); t.drag([-1, -4, -24]); const c = [t.st.chat.want, t.st.chat.w, saved().want];
    ok("7 分隔線本體按下只微動(0.4px、來回 3px 內)不寫 want,照舊跟著視窗(2560 = 620);位移 > 3px 才寫成固定寬(576 往左拖 24 = 600、存檔也是 600)",
      a[0] === null && (a[1] === undefined || a[1] === null) && b === null && w2560 === 620 && c[0] === 600 && c[1] === 600 && c[2] === 600, JSON.stringify({ a, b, w2560, c })); }
  { const t = boot(2560, { side: { w: 400, want: 400, off: false }, chat: { w: 620, want: null, off: false } }), w0 = [t.st.side.w, t.st.chat.w];
    t.resize(1440); const one = [t.st.side.w, t.st.chat.w];
    ok("7 視窗一次從 2560 跳到 1440(離開全螢幕):側欄 400 不被多夾、聊天欄回到 452,一次 resize 就到位;中欄 ≥ 480",
      JSON.stringify(w0) === "[400,620]" && JSON.stringify(one) === "[400,452]" && 1440 - one[0] - one[1] >= 480, JSON.stringify({ w0, one })); }
  ok("7 上限 620 = 13px 的 44em 加左右內距 24×2:聊天欄的 .chat-scroll 左右內距還是 24", 13 * 44 + 48 === 620 && /\.chat-scroll \{[^}]*padding: var\(--space-24\) var\(--space-24\)/.test(css("app.css")));
  ok("7 跟著視窗變的寬不吃緩動:.ws-snap 下兩欄 transition: none(收合、展開照舊走 --motion-base)",
    /\.ws-snap \.pane-strategies, \.ws-snap \.pane-chat \{ transition: none; \}/.test(css("app.css")) && /\.pane-strategies, \.pane-chat \{[^}]*transition: width var\(--motion-base\)/.test(css("app.css"))); }

// 8. 0.1.59 漏掉的幾處(designer desktop-widescreen-2026-11-24 §2.1、§2.3、§2.4)
{ const lib8 = css("library.css"), wf8 = css("report-wf.css"), rj = fs.readFileSync(path.join(R, "report-robust.js"), "utf8"), wj = fs.readFileSync(path.join(R, "report-wf.js"), "utf8");
  ok("8 策略庫詳情:說明段落 .lib-p 與摘要 .lib-sum 行長 ≤ 44em(text-wrap: pretty)", /\.lib-p \{[^}]*max-width: 44em;[^}]*text-wrap: pretty;/.test(lib8) && /\.lib-sum \{[^}]*max-width: 44em;[^}]*text-wrap: pretty;/.test(lib8));
  const lc = clampOf(lib8, ".lib-card .chart"), wc = clampOf(wf8, ".wf-canvas");
  ok("8 策略庫曲線 clamp(200, 22cqi, 320)(cqi 量 .lib,同 .bt-canvas 係數)、樣本外驗證曲線 clamp(220, 20cqi, 320)(cqi 量 .bt)", JSON.stringify(lc) === "[200,22,320]" && JSON.stringify(wc) === "[220,20,320]"
    && /\.lib \{[^}]*container-type: inline-size;/.test(lib8), JSON.stringify({ lc, wc }));
  { const ctx = {}; vm.runInNewContext(/const heatCap = [^\n]*;/.exec(rj)[0] + "\nthis.f = heatCap;", ctx);
    // 反算:外層 − 直軸名 23 − frame 34 = 表寬;fixed layout 表寬 = 列標 84 + 欄數 × 格寬 + (欄數 + 2) × spacing 4
    const cell = (n) => (ctx.f(n) - 23 - 34 - 84 - (n + 2) * 4) / n;
    ok("8 熱圖外層上限反算回去一格正好 120(3 欄 = " + ctx.f(3) + "、6 欄 = " + ctx.f(6) + ")", [1, 3, 6, 12, 40].every((n) => cell(n) === 120) && ctx.f(3) === 521); }
  ok("8 參數熱圖與落點網格(二維)都把上限寫在 .rob-heat-body;單參數兩張都是表 328(.rob-tbl.is-single、.wf-grid.is-single),切分頁寬度不跳", /if \(!sc\.single\) body\.style\.maxWidth = heatCap\(sc\.cols\.length\) \+ "px";/.test(rj)
    && /if \(!w\.single && R\.heatCap\) body\.style\.maxWidth = R\.heatCap\(w\.cols\.length\) \+ "px";/.test(wj) && /el\("table", "wf-grid" \+ \(w\.single \? " is-single" : ""\)\)/.test(wj)
    && /heatCap,/.test(rj) && /\.rob-tbl\.is-single \{ max-width: 328px; \}/.test(css("report-robust.css")) && /\.wf-grid\.is-single \{ max-width: 328px; \}/.test(wf8));
  { const log = [...trade.matchAll(/\.pf-log \{ (?:display: grid; )?grid-template-columns: ([^;]*);([^}]*)\}/g)].map((m) => [m[1].trim().split(/\s+/), m[2]]);
    ok("8 交易歷史:寬版 6 欄、窄版 5 欄全部 max-content(沒有 1fr),寬版 justify-content: start(金額接在商品後、多的寬度留在列尾)",
      log.length === 2 && log[0][0].length === 6 && log[1][0].length === 5 && log.every(([c]) => c.every((x) => x === "max-content")) && /justify-content: start;/.test(log[0][1]), JSON.stringify(log)); }
  { const trc = css("report-trades.css"), nar = /@container tr-list \(max-width: 560px\) \{([\s\S]*?)\n\}/.exec(trc);
    ok("8 交易地圖清單列:寬框「→ 部位」不推到最右(基底 .tr-pos 沒有 margin-left: auto);窄框 ≤ 560 第二行照舊靠右",
      /\.tr-pos \{ flex: none; text-align: right; \}/.test(trc) && !/\.tr-pos \{[^}]*margin-left: auto/.test(trc.replace(nar ? nar[0] : "", "")) && !!nar && /\.tr-pos \{ margin-left: auto; \}/.test(nar[1])); }
  const sz = rule(trade, ".mg-sz") || "";
  ok("8 部位大小列:寬版格線不再有 1fr、justify-content: start(〔套用金額〕接在目標值後隔 8,多的寬度留在列尾);預覽列 contain: inline-size 不撐欄寬",
    !/1fr/.test(sz) && /grid-template-areas: "fund seg t go" "msg msg msg msg";/.test(sz) && /justify-content: start;/.test(sz) && /column-gap: var\(--space-8\);/.test(sz)
    && /\.mg-msg \{[^}]*contain: inline-size;/.test(trade), sz); }

console.log(red ? `\n${red} FAILED` : "\nALL PASS");
console.log("開窗量的(要 BLAVE_TEST_WINDOW=1,交主 session 排):自動下單總覽、策略組合配置、策略庫清單、報告清單與文章、策略頁回測與成交測試,各在 1440／1920／2560 量 .pf 子元素寬 = 欄寬、說明句 ≤ 44em、圖高落在 clamp 範圍;"
  + "0.1.61 另量聊天欄 452／576／620、策略庫詳情右緣 = 清單右緣、參數熱圖一格 ≤ 120、〔套用金額〕左緣 = 目標值右緣 + 8。");
process.exit(red ? 1 : 0);
