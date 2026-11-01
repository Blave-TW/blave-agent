// 台股代號後面的名字(0.1.25;1438 三地開發):總訊號部位表(配置與自動下單 › 部位)與「N 支策略」拆解句。
//   1. shell/twnames.js:公開台股清單 → { 代號: 名字 }、本機快取一天、問不到用上一份、失敗 1 分鐘內不再問
//   2. renderer/trade.js:只有台股代號補名字(加密、台指期不動)、拿到表才重畫、名字截尾全名在 title
// 跑法:node tests/check_shell_tw_names.js
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, ".."), SHELL = path.join(ROOT, "shell"), R = path.join(SHELL, "renderer");
const tw = require(path.join(SHELL, "twnames.js"));
const trSrc = fs.readFileSync(path.join(R, "trade.js"), "utf8"), mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
const preSrc = fs.readFileSync(path.join(SHELL, "preload.js"), "utf8"), css = fs.readFileSync(path.join(R, "trade.css"), "utf8");
let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || d === undefined ? "" : "  " + JSON.stringify(d))); if (!ok) red++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "blave-twn-"));
const cut = (src, name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("切不到 " + name); };
const LIST = { data: [{ stock_id: "1438", name: "三地開發" }, { stock_id: "0050", name: "元大台灣50" }, { stock_id: "00400A", name: "主動國泰動能高息" }, { stock_id: "00890B", name: "凱基ESG BBB債15+" },
  { stock_id: "BTC", name: "x" }, { stock_id: "2330", name: "" }, { stock_id: 2317, name: "鴻海" }, { stock_id: "2454", name: "長".repeat(41) }, null, { stock_id: " 2603 ", name: " 長榮 " }] };

(async () => {
  try {
    const m = tw.parseList(LIST);
    t("parseList:只收台股代號 + 非空名字(去頭尾空白);數字型代號、空名、超長名、非台股代號略過", JSON.stringify(m) === JSON.stringify({ 1438: "三地開發", "0050": "元大台灣50", "00400A": "主動國泰動能高息", "00890B": "凱基ESG BBB債15+", 2603: "長榮" }), m);
    t("parseList:形狀不對 → {}", JSON.stringify(tw.parseList(null)) === "{}" && JSON.stringify(tw.parseList({ data: "x" })) === "{}" && JSON.stringify(tw.parseList({})) === "{}");

    let now = 1e12; const calls = []; let answer = () => ({ status: 200, body: LIST });
    const get = async (url, h) => { calls.push([url, h]); return answer(); };
    const dir = fs.mkdtempSync(path.join(TMP, "a-")), a = tw.createTwNames({ dir, get, apiBase: "https://api.blave.org", now: () => now });
    const [r1, r2] = await Promise.all([a.names(), a.names()]);
    t("第一次:問 api 的公開台股清單(不帶任何憑證)、同時兩個呼叫只問一次、回 { 代號: 名字 }", calls.length === 1 && calls[0][0] === "https://api.blave.org/studio/charts/twstock/stock_list" && JSON.stringify(calls[0][1]) === "{}" && r1["1438"] === "三地開發" && r2 === r1, calls);
    const disk = JSON.parse(fs.readFileSync(path.join(dir, "tw_names.json"), "utf8"));
    t("存進 userData/tw_names.json(帶時間);沒有留下 .tmp", disk.at === now && disk.names["1438"] === "三地開發" && !fs.existsSync(path.join(dir, "tw_names.json.tmp")));
    now += tw.TTL_MS - 1; await a.names();
    t("一天內不再問", calls.length === 1);
    const b = tw.createTwNames({ dir, get, apiBase: "https://api.blave.org", now: () => now });
    t("重開 app(新的實例)讀本機那份、不問", (await b.names())["0050"] === "元大台灣50" && calls.length === 1);
    now += 2; answer = () => ({ status: 500, body: {} });
    const stale = await b.names();
    t("過了一天問 api;問不到 → 用上一份(不清空)", calls.length === 2 && stale["1438"] === "三地開發");
    now += tw.RETRY_MS - 1; await b.names();
    t("失敗後 10 分鐘內不再問", calls.length === 2);
    now += 2; answer = () => ({ status: 200, body: { data: [{ stock_id: "1438", name: "三地開發新" }] } });
    t("10 分鐘後再問,拿到新的就換上", (await b.names())["1438"] === "三地開發新" && calls.length === 3);
    const c = tw.createTwNames({ dir: path.join(TMP, "nope", "x"), get: async () => { throw new Error("offline"); }, apiBase: "https://api.blave.org", now: () => now });
    t("從沒拿到過又問不到 → {}(畫面只顯示代號,不拋)", JSON.stringify(await c.names()) === "{}");
    const eDir = fs.mkdtempSync(path.join(TMP, "e-")), e = tw.createTwNames({ dir: eDir, get: async () => ({ status: 200, body: { data: [] } }), apiBase: "x", now: () => now });
    t("api 回空清單算失敗(不把空表存成一天的快取)", JSON.stringify(await e.names()) === "{}" && !fs.existsSync(path.join(eDir, "tw_names.json")));

    // ── 主行程與 preload 接線 ──
    t("main:tw-names 只收自家畫面(handle 包 fromOurPage)、拒絕時回 {};用 getJSON + API_BASE + userData", /handle\("tw-names", \(\) => twNames\(\)\.names\(\), \{\}\);/.test(mainSrc) && /require\("\.\/twnames"\)\.createTwNames\(\{ dir: app\.getPath\("userData"\), get: getJSON, apiBase: API_BASE \}\)/.test(mainSrc));
    t("preload:twNames 走 tw-names", /twNames: \(\) => ipcRenderer\.invoke\("tw-names"\),/.test(preSrc));

    // ── renderer:trTwName 真的跑 ──
    let asked = 0, resolveNames = null, painted = 0;
    const ctx = { window: { blave: { twNames: () => { asked++; return new Promise((ok) => { resolveNames = ok; }); } } }, trPaint: () => painted++, Date, Promise, Object, String };
    vm.createContext(ctx);
    vm.runInContext((trSrc.match(/const TR_TWSTOCK_RE = [^;]+;/) || [""])[0] + "\n" + (trSrc.match(/const TR_TWN = [^;]+;/) || [""])[0] + "\n" + cut(trSrc, "trTwNamesWant") + "\n" + cut(trSrc, "trTwName") + "\nthis.trTwName = trTwName; this.TR_TWN = TR_TWN;", ctx);
    const before = ctx.trTwName("1438@spot"), again = ctx.trTwName("2330");
    t("還沒拿到表:回 \"\"(只顯示代號)、只問一次", before === "" && again === "" && asked === 1);
    resolveNames({ 1438: "三地開發", 2330: "台積電", "00400A": "主動國泰動能高息" }); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    t("拿到表:版本 +1、重畫一次", ctx.TR_TWN.v === 1 && painted === 1);
    t("台股代號補名字:1438@spot / 2330 / 2330.TW / 00400A", ctx.trTwName("1438@spot") === "三地開發" && ctx.trTwName("2330") === "台積電" && ctx.trTwName("2330.TW") === "台積電" && ctx.trTwName("00400a@spot") === "主動國泰動能高息");
    t("加密、台指期、表上沒有的代號 → \"\"(不動);拿到之後不再問", ["BTCUSDT", "ETHUSDT@spot", "TXF", "MXF", "TMF", "9999", "", null].every((s) => ctx.trTwName(s) === "") && asked === 1);

    // ── 畫面接線 ──
    const sig = cut(trSrc, "poSigTable");
    t("總訊號部位表的標的格(配置與自動下單 › 部位共用 symCell):台指期列不補,其餘交給 trTwNameEl(不是台股回 null)", /const tw = sp \? null : trTwNameEl\(sym\); if \(tw\) c\.appendChild\(tw\);/.test(sig) && sig.indexOf("trTwNameEl(sym)") < sig.indexOf('"mkt-tag"', sig.indexOf("trTwNameEl(sym)")));
    t("名字:span.tw-name、全名在 title", /const el = trEl\("span", "tw-name", nm\); el\.title = nm;/.test(cut(trSrc, "trTwNameEl")));
    t("「N 支策略」拆解的合計句:台股寫「代號 名字」", /base = twn \? base0 \+ " " \+ twn : base0;/.test(cut(trSrc, "trNetRows")));
    t("配置頁與部位頁的重畫簽章都帶 TR_TWN.v(表拿到了才重畫得出名字)", /TR_TWN\.v\];/.test(cut(trSrc, "poPaintCfg")) && /TR_TWN\.v\];/.test(cut(trSrc, "trPaintPos")));
    t("trade.css:名字截尾 8em(ellipsis + nowrap)、sans、次要灰 --ink-2;總訊號部位表裡隔 8(同網頁 .sym-name / .pf-sig .sym-name)", /\n\.tw-name \{[^}]*max-width: 8em; margin-left: var\(--space-6\); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;[^}]*font-family: var\(--font-sans\); color: var\(--ink-2\); \}/.test(css) && /\.pf-sig \.tw-name \{ margin-left: var\(--space-8\); \}/.test(css));
    t("配置頁金額表的標的格:台股補名字(投資組合列、台指期列不補;窄欄那份同一支 symInto)", /else \{ host\.append\(symText\); const tw = isC \|\| txf \? null : trTwNameEl\(sym\); if \(tw\) host\.appendChild\(tw\); \}/.test(trSrc));
    t("自動下單 › 交易歷史:代號後面補名字、在市場小標之前(台指期那條走 trTxfSymInto 不補)", /ss\.textContent = sym\.replace\(\/@spot\$\/, ""\); const tw = trTwNameEl\(sym\); if \(tw\) ss\.appendChild\(tw\); \}\n\s*ss\.appendChild\(trEl\("span", "mkt-tag"/.test(trSrc));
    { const ev = cut(trSrc, "trOvEvents");
      t("總覽的拒單事件:認得的原因整句帶「代號 名字」;認不得的原文在代號後面補名字(截尾、title)", /trOrderErrText\(twn \? sym \+ " " \+ twn : sym, raw\)/.test(ev) && /body\.append\(" ", trEl\("span", "mono", sym\)\); if \(tw\) body\.appendChild\(tw\);/.test(ev)); }
    // 策略組合 › 金額表投資組合列:有名字寫名字、沒有退回代號;名字表第一次沒拿到,輪詢要補問(表的簽章沒變不會再走 trTwName,代號會一直留著)
    { const ctx = { tf: (k, v) => (k === "ak.sep" ? ", " : k === "tr.typecSymsMore" ? v.list + " and " + v.k + " more" : k + (v ? JSON.stringify(v) : "")) };
      vm.runInNewContext(cut(trSrc, "trShortSym") + "\n" + cut(trSrc, "trTypeCLabel"), ctx);
      const N = { "2330": "台積電", "2303": "聯電", "2454": "聯發科" }, keys = ["2330", "2303", "2454", "2317", "2412"], nameOf = (k) => N[k] || "";
      const L = (nf) => vm.runInNewContext("(k, nf, tf) => trTypeCLabel({ n: 0, keys: k }, tf, nf, null)", ctx)(keys, nf, ctx.tf);
      t("投資組合列:有名字 → 「台積電, 聯電, 聯發科 and 2 more」", L(nameOf).text === "台積電, 聯電, 聯發科 and 2 more", L(nameOf).text);
      t("投資組合列:名字表還沒到 → 退回代號「2330, 2303, 2454 and 2 more」", L(() => "").text === "2330, 2303, 2454 and 2 more", L(() => "").text);
      t("投資組合列:部分查不到 → 那幾檔退回代號", L((k) => (k === "2303" ? "" : N[k] || "")).text === "台積電, 2303, 聯發科 and 2 more");
      const P = { dataset: {}, title: "", textContent: "2330", classList: { removed: [], remove(c) { this.removed.push(c); } } };
      const ms = { TR_TWSTOCK_RE: /^\d{4,6}[A-Z]?(?:\.TWO?)?$/, t: ctx.tf };
      vm.runInNewContext(cut(trSrc, "trShortSym") + cut(trSrc, "trTypeCLabel") + cut(trSrc, "trTwMetaFill"), ms);
      ms.trTwName = nameOf; ms.trTwMetaFill(P, "2330");
      t("回測頁首標的:一檔「2330 台積電」、名字不進等寬", P.textContent === "2330 台積電" && P.classList.removed.includes("mono"), P.textContent);
      const Q = { dataset: {}, title: "", textContent: "BTCUSDT", classList: { remove() {} } }; ms.trTwMetaFill(Q, "BTCUSDT"); ms.trTwName = () => ""; const W = { dataset: {}, title: "", textContent: "2330", classList: { remove() {} } }; ms.trTwMetaFill(W, "2330");
      t("回測頁首標的:加密不動、沒有名字留代號", Q.textContent === "BTCUSDT" && W.textContent === "2330");
      // 真跑 trTwNamesWant:第一次回空表,下一輪輪詢補問就拿到
      let asks = 0, paints = 0, clock = 1000000; const later = (f) => { const x = {}; return x; };
      const box = { Date: { now: () => clock }, TR_TWN: { names: null, busy: false, at: 0, v: 0, wanted: true }, TR_TWN_RETRY_MS: 60000, trPaint: () => { paints++; }, trTwMetaFill: () => {}, document: { querySelectorAll: () => [] }, window: { blave: { twNames: async () => (++asks === 1 ? {} : { "2330": "台積電" }) } }, Promise, Object };
      vm.runInNewContext(cut(trSrc, "trTwNamesWant"), box);
      box.trTwNamesWant(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
      const a0 = box.TR_TWN.names; box.TR_TWN.at = clock; clock += 59000; box.trTwNamesWant(); const held = asks; clock += 2000; box.trTwNamesWant(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
      t("名字表第一次空:一分鐘內不再問、過了再問,拿到就重畫", a0 === null && held === 1 && asks === 2 && box.TR_TWN.names && box.TR_TWN.names["2330"] === "台積電" && paints === 1, { asks, paints });
      t("輪詢補問:trPoll 看 TR_TWN.wanted 叫 trTwNamesWant(不靠表重畫)", /if \(TR_TWN\.wanted\) trTwNamesWant\(\);/.test(trSrc.slice(trSrc.indexOf("async function trPoll"))));
      t("標的格 CSS:投資組合列可換行、只在名字之間換、窄欄那份同規則", /\.pf-tbl td\.sname\.c-sym \{ white-space: normal; word-break: keep-all; overflow-wrap: break-word;/.test(css) && /\.sub-sym \{[^}]*word-break: keep-all;/.test(css)); }
  } finally { fs.rmSync(TMP, { recursive: true, force: true }); }
  console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
})();
