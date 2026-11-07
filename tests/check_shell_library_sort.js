// 策略庫排序選單與列(spec library-sort-rows-2026-11-06;shell/renderer/library.js)。不起 Electron:
//   ① 純邏輯:拿 11-06 線上 17 支(fixtures/library_sort_2026-11-06.json)驗 §3.2 的驗收列、沉底判斷與「第一格講總報酬」同一個判斷、缺值排最後、同值照推薦。
//   ② 選單:選了不同的才送 lib_sort、捲回頂端、焦點回觸發鈕;沒有提示泡(設計稽核 library-sort-review 第二節第 2 題);沉底組標籤畫在沉底段正上方;index.html 的 data-sort 與 LIB_SORTS 同一份;字串逐字照 spec §6。
//   ③ 列:副標只留標的(安裝最多／最新上架才接依據)、第二格照 Sharpe 排時換 Sharpe、回撤紅字、不給 aria-label(照內容唸)。
// 跑法:node tests/check_shell_library_sort.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 1500))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const src = read(path.join(R, "library.js")), html = read(path.join(R, "index.html"));
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
const STR = (() => { const sb = {}; vm.runInNewContext(read(path.join(R, "strings.js")) + "\nthis.S = STRINGS;", sb); return sb.S; })();

// ── ① 純邏輯 ──
const a = src.indexOf("/* ── 純邏輯("), b = src.indexOf("/* ── 純邏輯到此");
const P = {}; vm.createContext(P); vm.runInContext(src.slice(a, b).replace(/^const /gm, "var "), P);
const LIST = JSON.parse(read(path.join(__dirname, "fixtures", "library_sort_2026-11-06.json"))).strategies;
const ids = (sort, list) => P.libVisible(list || LIST, "all", sort).map((s) => s.id);
ok("① fixture 是 11-06 線上 17 支", LIST.length === 17);
ok("① 排序 key 與順序:推薦、安裝最多、樣本期較長、Sharpe、最大回撤較淺、年化報酬、最新上架;會沉底的只有 Sharpe／回撤／年化",
  JSON.stringify([...P.LIB_SORTS]) === '["reco","installs","sample","sharpe","mdd","annual","newest"]' && JSON.stringify([...P.LIB_SINK_SORTS]) === '["sharpe","mdd","annual"]' && P.LIB_FLOOR_YEARS === 1);
ok("① 推薦不動:不給排序、給 reco、給認不得的值,都等於原本的官方或已驗證 → libCompare",
  ids(undefined).join() === ids("reco").join() && ids("moon").join() === ids("reco").join() && ids("reco").join() === "74,137,125,73,132,106,139,101,102,124,118,88,72,128,127,86,117");
const sh = ids("sharpe"), md = ids("mdd"), an = ids("annual");
ok("① §3.2 驗收:Sharpe 第一名 #124、最大回撤較淺第一名 #74;兩種排序最後三列都是 #127、#117、#86(不加沉底兩個第一名都是只有半年的 #127)",
  sh[0] === 124 && md[0] === 74 && sh.slice(-3).join() === "127,117,86" && md.slice(-3).join() === "127,117,86", JSON.stringify({ sh, md }));
ok("① 年化報酬也沉底:最後三列 #127、#117、#86;第一名 #124", an[0] === 124 && an.slice(-3).join() === "127,117,86", an.join());
const s117 = LIST.find((s) => s.id === 117), s86 = LIST.find((s) => s.id === 86), s127 = LIST.find((s) => s.id === 127);
ok("① #117 樣本 0.98 年(畫面捨入成 1.0):第一格講總報酬,同時沉底——兩邊用同一個不捨入的判斷", P.libSampleYears(s117) < 1 && P.libYears(s117) === 1 && P.wcFirstKv(s117) === "total" && P.libSinks(s117) === true && P.libUnderYear(s117) === true);
ok("① #86 官方但未驗證照樣沉底(官方身分不救);#127 已驗證但未滿 1 年沉底;滿 1 年且已驗證的不沉底", P.libSinks(s86) === true && s86.is_official === true && P.libSinks(s127) === true && P.libSinks(LIST.find((s) => s.id === 124)) === false);
ok("① 沒有回測區間的:沉底、第一格照舊講年化(wcFirstKv 不變)", P.libSinks({ verified: true, report: {} }) === true && P.wcFirstKv({ verified: true, report: {} }) === "ann");
ok("① 不會沉底的三種:安裝最多照 purchase_count、最新上架照 created_at、樣本期較長照不捨入年數",
  ids("installs").slice(0, 3).join() === "102,101,73" && ids("newest")[0] === 139 && ids("newest").slice(-1)[0] === 72 && ids("sample")[0] === 74 && ids("sample").slice(-1)[0] === 127);
{ const mk = (id, o) => Object.assign({ id, verified: true, is_official: true, created_at: "2026-01-0" + id + " 00:00:00", report: { sharpe: 1, max_drawdown: -10, equity_from: "2020-01-01", equity_to: "2026-01-01" } }, o);
  const x = [mk(1, { report: { sharpe: null, max_drawdown: null, equity_from: "2020-01-01", equity_to: "2026-01-01" } }), mk(2), mk(3, { report: { sharpe: 2, max_drawdown: 15, equity_from: "2018-01-01", equity_to: "2026-01-01" } }), mk(4, { report: { sharpe: 1, max_drawdown: -10, equity_from: "2014-01-01", equity_to: "2026-01-01" } })];
  ok("① 缺值排最後;同值照推薦決勝(樣本長的先);回撤正值照負值比(15 → −15)", ids("sharpe", x).join() === "3,4,2,1" && ids("mdd", x).join() === "4,2,3,1", ids("sharpe", x).join() + " | " + ids("mdd", x).join()); }
{ const at = (sort, list) => { const v = P.libVisible(list || LIST, "all", sort); return [P.libSinkAt(v, sort), v]; };
  const sinkOk = ["sharpe", "mdd", "annual"].every((k) => { const [i, v] = at(k); return i === 14 && v.slice(0, i).every((s) => !P.libSinks(s)) && v.slice(i).every((s) => P.libSinks(s)); });
  const noHead = ["reco", "installs", "sample", "newest"].every((k) => at(k)[0] === -1);
  const clean = LIST.filter((s) => !P.libSinks(s));
  ok("① 沉底組標籤的位置(libSinkAt):Sharpe／回撤／年化在第一支沉底策略(第 15 支,#127)正上方、前面全不沉底後面全沉底;其餘四種排序與沒有沉底策略的清單不出(-1)",
    sinkOk && noHead && at("sharpe")[1][14].id === 127 && clean.length === 14 && at("sharpe", clean)[0] === -1 && P.libSinkAt([], "sharpe") === -1, JSON.stringify(["sharpe", "mdd", "annual", "reco"].map((k) => at(k)[0]))); }
ok("① 市場篩選照舊:加密 × Sharpe 只有加密", P.libVisible(LIST, "crypto", "sharpe").every((s) => P.libMarket(s) === "crypto") && P.libVisible(LIST, "crypto", "sharpe")[0].id === 124);
{ const p = P.libSparkPath([1, 2, 4], 88, 28, 2);
  ok("① 迷你曲線:對數縱軸(1、2、4 等距)、首尾貼滿寬、起點基準線在第一點;壞 spark(太短、0、負、非數字、非陣列)回 null",
    !!p && p.pts.length === 3 && p.pts[0][0] === 0 && p.pts[2][0] === 88 && Math.abs((p.pts[0][1] - p.pts[1][1]) - (p.pts[1][1] - p.pts[2][1])) < 1e-9 && p.pts[0][1] === 26 && p.pts[2][1] === 2 && p.base === p.pts[0][1]
    && [null, [1], [1, 0], [1, -2], [1, "2"], [1, NaN], "x"].every((v) => P.libSparkPath(v, 88, 28, 2) === null) && !!P.libSparkPath([1, 1], 88, 28, 2)); }

// ── ② 選單 ──
{ const C = { bag: { sort: "reco", scroll: 420 }, sent: [], painted: 0, closed: [], LIB_SORTS: P.LIB_SORTS, LIB: {} };
  vm.createContext(C); vm.runInContext("var window = { blave: { trackEvent: (e, p) => sent.push(e + ':' + p.by) } }, libBag = () => bag, libPaint = () => { painted++; }, libSortClose = (f) => closed.push(f);\n" + cutFn(src, "libSortPick"), C);
  C.libSortPick("sharpe"); const s1 = C.bag.scroll; C.bag.scroll = 300; C.libSortPick("sharpe"); const s2 = C.bag.scroll; C.libSortPick("bogus"); C.libSortPick("mdd");
  ok("② 選排序:選了不同的才送 lib_sort { by }(重選同一項、認不得的值都不送不重畫);換了就捲回頂端;每次都 libSortClose(true)",
    C.sent.join() === "lib_sort:sharpe,lib_sort:mdd" && C.painted === 2 && C.bag.sort === "mdd" && s1 === 0 && s2 === 300 && C.closed.join() === "true,true,true,true", JSON.stringify({ sent: C.sent, painted: C.painted, s1, s2 })); }
{ const el = (o) => Object.assign({ textContent: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } }, o);
  const items = P.LIB_SORTS.map((k) => { const l = el({ textContent: "L:" + k }); return el({ dataset: { sort: k }, querySelector: () => l }); });
  const dom = { "lib-sort-menu": { querySelectorAll: () => items }, "lib-sort-v": el(), "lib-sort-trig": el() };
  const C = { LIB_SORTS: P.LIB_SORTS, LIB_SINK_SORTS: P.LIB_SINK_SORTS, $: (id) => dom[id], t: (k) => "T:" + k, bag: { sort: "reco" } };
  vm.createContext(C); vm.runInContext("var libBag = () => bag;\n" + cutFn(src, "libPaintSort"), C);
  const seen = ["reco", "installs", "sample", "sharpe", "mdd", "annual", "newest", "old"].map((k) => { C.bag.sort = k; C.libPaintSort(); return [k, dom["lib-sort-v"].textContent, items.filter((x) => x.attrs["aria-checked"] === "true").length]; });
  ok("② 觸發器寫選中那項、恰一項 checked;bag 是舊值就回推薦;不掛 aria-describedby(提示泡整顆拿掉)",
    seen.every(([k, v, n]) => v === "L:" + (k === "old" ? "reco" : k) && n === 1) && C.bag.sort === "reco" && !("aria-describedby" in dom["lib-sort-trig"].attrs), JSON.stringify(seen)); }
{ const i = html.indexOf('id="lib-sort-menu"'), menu = html.slice(i, html.indexOf("</div>", i)), btns = menu.match(/<button[^>]*>/g) || [];
  const trigI = html.indexOf('id="lib-sort-trig"');
  ok("② index.html:排序在市場選單後面、同一個 .lib-tools;data-sort 的順序 = LIB_SORTS;選項全是 menuitemradio、tabindex=-1、只有推薦選中;沒有提示泡:觸發器不帶 aria-describedby、後面直接接面板(app.js tipEsc 認的是 .tip,面板不是,所以 Esc 照舊交給選單)",
    html.indexOf('id="lib-sort"') > html.indexOf('id="lib-mkt"') && html.indexOf('id="lib-sort"') < html.indexOf('id="lib-back"')
    && JSON.stringify((menu.match(/data-sort="(\w+)"/g) || []).map((x) => x.split('"')[1])) === JSON.stringify([...P.LIB_SORTS])
    && btns.length === 7 && btns.every((x) => /role="menuitemradio"/.test(x) && /tabindex="-1"/.test(x)) && btns.filter((x) => /aria-checked="true"/.test(x)).length === 1 && /aria-checked="true"[^>]*data-sort="reco"/.test(btns[0])
    && /<\/button>\s*<div class="ct-menu lib-mkt-menu" id="lib-sort-menu"/.test(html.slice(trigI)) && !html.includes("lib-sort-tip") && !/aria-describedby/.test(html.slice(trigI, html.indexOf(">", trigI)))
    && P.LIB_SORTS.every((k) => menu.includes('data-i18n="lib.sort.' + k + '"'))); }
const WANT = { zh: { "lib.sort.aria": "排序", "lib.sort.reco": "推薦", "lib.sort.installs": "安裝最多", "lib.sort.sample": "樣本期較長", "lib.sort.sharpe": "Sharpe", "lib.sort.mdd": "最大回撤較淺", "lib.sort.annual": "年化報酬", "lib.sort.newest": "最新上架",
  "lib.sinkHead": "未驗證或樣本未滿 1 年", "lib.listedFor": "上架 {n} 天", "lib.desc": "報酬皆為回測。" },
  en: { "lib.sort.aria": "Sort", "lib.sort.reco": "Recommended", "lib.sort.installs": "Most installed", "lib.sort.sample": "Longest backtest", "lib.sort.sharpe": "Sharpe", "lib.sort.mdd": "Shallowest drawdown", "lib.sort.annual": "Annual Return", "lib.sort.newest": "Newest",
  "lib.sinkHead": "Unverified or Under 1 Year", "lib.listedFor": "Listed {n}d", "lib.desc": "Returns are backtested." } };
ok("② 字串逐字照 spec §6 與設計稽核第二節第 3 題(zh／en);lib.annLabel、lib.years、提示泡的 lib.sort.tip.reco／.value 沒有呼叫點了,兩語都刪", ["zh", "en"].every((L) => Object.entries(WANT[L]).every(([k, v]) => STR[L][k] === v)) && ["lib.annLabel", "lib.years", "lib.sort.tip.reco", "lib.sort.tip.value"].every((k) => !(k in STR.zh) && !(k in STR.en) && !src.includes('"' + k + '"')));
ok("② 接線:觸發鈕開關、面板點選 libSortPick、鍵盤與市場選單同一支 menuKeys、點外面(capture)關;清單重畫時焦點在面板裡就還給觸發鈕;離開策略庫收起來;換主題重畫曲線",
  /g\("lib-sort-trig"\)\.addEventListener\("click", \(\) => \{ if \(g\("lib-sort-menu"\)\.hidden\) libSortOpen\(\); else libSortClose\(false\); \}\);/.test(src)
  && /const b = e\.target\.closest\("\.ct-mi\[data-sort\]"\); if \(b\) libSortPick\(b\.dataset\.sort\);/.test(src) && /menuKeys\("lib-sort-menu", libSortClose\);/.test(src)
  && /if \(!g\("lib-sort-menu"\)\.hidden && !g\("lib-sort"\)\.contains\(e\.target\)\) libSortClose\(false\); \}, true\);/.test(src)
  && /libSortClose\(!det && \$\("lib-sort-menu"\)\.contains\(document\.activeElement\)\);/.test(cutFn(src, "libPaint")) && /libSortClose\(false\);/.test(cutFn(src, "libLeave"))
  && /window\.addEventListener\("blave:theme", \(\) => \{ libSparkAll\(\);/.test(src) && /libPaintMkt\(\); libPaintSort\(\);/.test(cutFn(src, "libPaintList"))
  && /libVisible\(LIB\.data\.strategies, B\.mkt, B\.sort\)/.test(cutFn(src, "libPaintList")) && (cutFn(src, "libPaintList").match(/libRow\(s, B\.sort\)/g) || []).length === 1);
{ const lp = cutFn(src, "libPaintList");
  ok("② 沉底組標籤接線:平鋪與分兩組都走同一支 fill(分組時每組各自找沉底段);標籤是 h6 組標題(讀屏念得到)、字串 lib.sinkHead,畫在 libSinkAt 那一列正上方",
    /const at = libSinkAt\(arr, B\.sort\);/.test(lp) && /if \(i === at\) host\.appendChild\(libEl\("h6", "lib-grp-h lib-sink-h", t\("lib\.sinkHead"\)\)\); host\.appendChild\(libRow\(s, B\.sort\)\);/.test(lp)
    && /\{ fill\(rows, v\); libSparkAll\(\); return; \}/.test(lp) && /const d = libEl\("div", "lib-rows"\); fill\(d, arr\); return d;/.test(lp)); }
{ const names = [...src.matchAll(/^function (\w+)\(/gm)].map((m) => m[1]), dup = names.filter((n, i) => names.indexOf(n) !== i);
  ok("② library.js 沒有同名的頂層函式(後宣告的會蓋掉前一支:libMdd 撞名時列上回撤全變 —)", dup.length === 0, dup.join()); }
ok("② 列不開 lightweight-charts:libRow／libSparkDraw 沒有 LightweightCharts、曲線 aria-hidden", !/LightweightCharts/.test(cutFn(src, "libRow") + cutFn(src, "libSparkDraw")) && /cv\.setAttribute\("aria-hidden", "true"\)/.test(cutFn(src, "libRow")));

// ── ③ 列(假 DOM)──
{ class N {
    constructor(tag) { this.tag = tag; this.k = []; this.t = ""; this.dataset = {}; this.attrs = {}; this.className = ""; }
    set textContent(v) { this.k = []; this.t = String(v); }
    get textContent() { return this.t + this.k.map((x) => (typeof x === "string" ? x : x.textContent)).join(""); }
    append(...a) { this.k.push(...a); } appendChild(x) { this.k.push(x); return x; } setAttribute(k, v) { this.attrs[k] = v; } addEventListener() { }
    find(cls) { const out = []; const walk = (n) => { if (n && typeof n === "object") { if ((" " + n.className + " ").includes(" " + cls + " ")) out.push(n); (n.k || []).forEach(walk); } }; walk(this); return out; }
  }
  const sb = { Node: N, document: { createElement: (t) => new N(t), createDocumentFragment: () => new N("#f") }, LANG: "zh", Date,
    libTags: () => ["已驗證", "免費"].map((x) => { const n = new N("span"); n.className = "tag"; n.textContent = x; return n; }), libShowDetail() { }, LIB_SPARK_W: 88, LIB_SPARK_H: 28, LIB_PAIR_RE: /^([A-Z0-9]{1,10})USDT$/, LIB_IV_KEYS: {}, libIvKey: () => "1h" };
  sb.t = (k) => STR[sb.LANG][k];
  for (const k of ["libSampleYears", "libUnderYear", "wcFirstKv", "libMddOf", "libNum", "libPct", "libFixed", "libListedDays", "libCreated"]) sb[k] = P[k];
  sb.LIB_FLOOR_YEARS = P.LIB_FLOOR_YEARS; sb.LIB_DAY = P.LIB_DAY;
  vm.runInNewContext(["libEl", "libMono", "libRich", "libSymbolNodes", "libRow"].map((f) => (f === "libMono" ? "const libMono = (text) => libEl(\"span\", \"mono\", text);" : cutFn(src, f))).join("\n"), sb);
  const row = (s, sort, lang) => { sb.LANG = lang || "zh"; const r = sb.libRow(s, sort), l2 = r.find("l2")[0], nums = r.find("num");
    return { l2: l2.textContent, k: nums.map((n) => n.k[0].textContent), v: nums.map((n) => n.k[1].textContent), cls: nums.map((n) => n.k[1].className), aria: r.attrs["aria-label"], l1: r.find("l1")[0].textContent, spark: r.find("spark").length, cv: r.find("spark")[0].k[0].attrs["aria-hidden"] }; };
  const s101 = LIST.find((s) => s.id === 101), s73 = LIST.find((s) => s.id === 73);
  const a1 = row(s101, "reco"), a2 = row(s127, "sharpe"), a3 = row(s101, "installs"), a4 = row(s73, "newest"), a5 = row(s101, "mdd", "en");
  ok("③ 副標只留代號(不帶「永續／台指期／台股」後綴、週期、官方／社群、樣本年數;同 web 列);安裝最多接「 · N 人安裝」、最新上架接「 · 上架 N 天」,其餘不接",
    a1.l2 === "BTC/USDT" && a2.l2 === "多標的" && a3.l2 === "BTC/USDT · 78 人安裝" && /^多標的 · 上架 \d+ 天$/.test(a4.l2) && a5.l2 === "BTC/USDT", JSON.stringify([a1.l2, a2.l2, a3.l2, a4.l2, a5.l2]));
  ok("③ 兩格:滿 1 年講年化、未滿講總報酬(#127);第二格預設最大回撤(負值、紅字),照 Sharpe 排換 Sharpe(不上色、不帶正號);label 在上、數字在下",
    JSON.stringify(a1.k) === '["年化報酬","最大回撤"]' && JSON.stringify(a1.v) === '["+19.99%","−19.04%"]' && /\bup\b/.test(a1.cls[0]) && /\bdown\b/.test(a1.cls[1])
    && JSON.stringify(a2.k) === '["總報酬","Sharpe"]' && JSON.stringify(a2.v) === '["+22.44%","4.22"]' && a2.cls[1] === "v mono", JSON.stringify([a1, a2]));
  ok("③ 列不給 aria-label(照內容唸,看得到的 tag 才念得到;WCAG 2.5.3);標題與 tag 之間有空白不黏字;每列一格曲線且 aria-hidden",
    a1.aria === undefined && a2.aria === undefined && a1.l1 === "BTC 通道動能共振 已驗證 免費" && a1.spark === 1 && a1.cv === "true", JSON.stringify([a1.aria, a1.l1]));
  { const sym = (r) => { sb.LANG = "zh"; return sb.libSymbolNodes({ report: r }, true).map((x) => (typeof x === "string" ? x : x.textContent)).join(""); };
    const full = (r) => { sb.LANG = "zh"; return sb.libSymbolNodes({ report: r }).map((x) => (typeof x === "string" ? x : x.textContent)).join(""); };
    ok("③ libSymbolNodes(noIv) 只回代號:BTC/USDT、TXF、2330、多標的;不帶 noIv 的三個呼叫點照舊帶後綴",
      sym({ symbol: "BTCUSDT" }) === "BTC/USDT" && sym({ symbol: "TXF" }) === "TXF" && sym({ symbol: "2330" }) === "2330" && sym({}) === "多標的"
      && full({ symbol: "BTCUSDT" }).startsWith("BTC/USDT " + STR.zh["lib.mk.perp"]) && full({ symbol: "TXF" }).startsWith("TXF " + STR.zh["lib.mk.txf"]), [sym({ symbol: "TXF" }), full({ symbol: "TXF" })].join(" | ")); } }

console.log(red ? red + " 紅" : "ALL PASS");
process.exit(red ? 1 : 0);
