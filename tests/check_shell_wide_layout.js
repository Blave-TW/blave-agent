// 寬螢幕中欄版型 A(Wei 11-20;designer wide-screen-layout-2026-11-20;canon › 行長上限屬於文字,不屬於表面)。不開窗,只讀 CSS:
//   1. 中欄各頁(自動下單、策略組合、策略庫、報告清單、策略頁成交測試)不設頁面寬上限,內容吃滿欄寬
//   2. 要讀完的句子留行長上限(44em 或既有的 ch 上限),報告文章與它的頁頭同一欄 680、一起置中
//   3. 欄寬變寬時三張主要的圖跟著長高、有下限有上限(clamp,上限 ≤ 440),2560 不會壓成一條線
// 實際排出來的寬度要開窗量(見檔尾清單),這裡守的是規則本身。
// Run: node tests/check_shell_wide_layout.js
const fs = require("fs"), path = require("path");
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
// 唯一留下的 ≥600 上限是掃讀表與清單列的 1200(第 4 條釘住只在哪三個選擇器)
const only1200 = caps.filter((c) => !/:1200$/.test(c));
ok("1 這四個檔不再有 760／680 的頁面上限;≥600 的只剩掃讀寬 1200(各檔恰好一條)", only1200.length === 0
  && ["trade.css", "library.css", "report-xt.css"].every((f) => caps.filter((c) => c === f + ":1200").length === 1) && !caps.includes("reports.css:1200"), caps.join(", "));

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
// 2560 時中欄約 2560 − 側欄 236 − 聊天欄 452 − 左右 48 ≈ 1824:圖的寬高比不超過 1824 / 下限高度 的一半以下就算看得了
{ const W = 2560 - 236 - 452 - 48, h = (c) => Math.min(Math.max(c[0], W * c[1] / 100), c[2]);
  const ratio = Object.fromEntries(Object.entries(charts).filter(([, c]) => c).map(([k, c]) => [k, +(W / h(c)).toFixed(2)]));
  ok("3 2560 寬時(中欄約 1824)三張圖的寬高比都 ≤ 5.5(固定高時是 5.7–8.3)", Object.values(ratio).length === 3 && Object.values(ratio).every((r) => r <= 5.5), JSON.stringify(ratio)); }

// 4. 掃讀寬上限(設計稽核 0.1.59 寬螢幕 #1 #2):表與清單列 1200、靠左;圖、數字條、頁首照舊吃滿。1920 內容約 1184 碰不到,2560 才作用
{ const capOf = (src, sel) => { const m = /max-width:\s*(?:calc\(\s*)?(\d+)px/.exec(rule(src, sel) || ""); return m ? +m[1] : null; };
  const lib4 = css("library.css"), W2560 = 2560 - 236 - 452 - 48, W1920 = 1920 - 236 - 452 - 48;
  const caps4 = { ".pf-scroll": capOf(trade, ".pf-scroll"), ".lib-rows, #lib-grps": capOf(lib4, ".lib-rows, #lib-grps"), ".xt .xt-tbl": capOf(xt, ".xt .xt-tbl") };
  ok("4 掃讀表與清單列上限 1200(自動下單與策略組合的表 .pf-scroll、策略庫 .lib-rows／#lib-grps、成交測試比較表 .xt-tbl),沒有置中",
    Object.values(caps4).every((c) => c === 1200) && !/margin(-inline)?:\s*[^;]*auto/.test((rule(trade, ".pf-scroll") || "") + (rule(lib4, ".lib-rows, #lib-grps") || "") + (rule(xt, ".xt .xt-tbl") || "")), JSON.stringify(caps4));
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

console.log(red ? `\n${red} FAILED` : "\nALL PASS");
console.log("開窗量的(要 BLAVE_TEST_WINDOW=1,交主 session 排):自動下單總覽、策略組合配置、策略庫清單、報告清單與文章、策略頁回測與成交測試,各在 1440／1920／2560 量 .pf 子元素寬 = 欄寬、說明句 ≤ 44em、圖高落在 clamp 範圍。");
process.exit(red ? 1 : 0);
