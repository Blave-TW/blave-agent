// 回測指標標籤(renderer/report-backtest.js buildMetrics 的 .bt-mk > button.mp-tip),designer spec-0.1.10-label-wrap-plan-copy §1:
//   1. en「Annualized Return」改短成「Annual Return」(Wei 拍板);zh「年化報酬」不動
//   2. 三欄的門檻 480 → 640(設計稽核 0.1.10 fix-c B1,Wei 核准):en 三欄在 600 起才全部一行,多留 40 給 Windows 的系統字;
//      不分語言、不寫 JS 量寬度——就是一個 CSS 斷點。三欄並排與最右欄泡泡往左長兩處同一個數字
//   3. 保險(任何寬度):萬一還是折行,靠左、數字對標籤第一行。<button> 預設置中、多行 button 的基線取最後一行——
//      只改 text-align 或只改 first baseline 都不夠(spec 實測),要 button block + 列 first baseline 兩條一起
// 不開 Electron,只讀原文。跑法:node tests/check_shell_bt_labels.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer"), I18N = path.join(__dirname, "..", "shell", "i18n");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 400))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const css = read(path.join(R, "report-backtest.css")), bt = read(path.join(R, "report-backtest.js"));
const STR = (() => { const sb = {}; vm.runInNewContext(read(path.join(R, "strings.js")) + "\nthis.S = STRINGS;", sb); return sb.S; })();
const rule = (sel) => { const m = new RegExp("(^|\\n)" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{([^}]*)\\}").exec(css); return m ? m[2] : null; };

ok("en 年化報酬的標籤 = Annual Return(.po 與產生的 strings.js 同值);zh 不動", /msgid "bt\.annReturn"\nmsgstr "Annual Return"\n/.test(read(path.join(I18N, "en.po")))
  && STR.en["bt.annReturn"] === "Annual Return" && STR.zh["bt.annReturn"] === "年化報酬", STR.en["bt.annReturn"]);
ok("回測指標列讀的就是 bt.annReturn(改字就改到畫面那一格)", /\[t\("bt\.annReturn"\), tip\(signed\(annualReturn\(stats\)\), "bt\.tip\.annReturn"\)\]/.test(bt));
const bps = [...css.matchAll(/@container \(min-width: (\d+)px\)/g)].map((m) => m[1]);
ok("三欄門檻:兩處 @container 都是 640(三欄並排、最右欄泡泡往左長),沒有別的斷點", bps.join() === "640,640", bps.join());
ok("640 那段裡是三欄並排與最右欄泡泡往左", /@container \(min-width: 640px\) \{\n  \.bt-cols \{ grid-template-columns: repeat\(3, 1fr\);/.test(css) && /@container \(min-width: 640px\) \{\n  \.bt-col:last-child \.bt-mk \.tip \{ left: auto; right: 0; \}/.test(css));
const row = rule(".bt-mrow"), tip = rule(".bt-mk .mp-tip");
ok("列:align-items 是 first baseline(數字對標籤第一行)", !!row && /align-items: first baseline;/.test(row), row);
ok("標籤鈕:display block + text-align left(折行時靠左;block 才讓 first baseline 取到第一行)", !!tip && /display: block;/.test(tip) && /text-align: left;/.test(tip), tip);
ok("標籤仍是 .bt-mk 裡的 button.mp-tip(tooltip 相鄰選擇器與定位基準不變)", /const btn = el\("button", "mp-tip", r\[0\]\);/.test(bt) && /\.bt-mk \{ position: relative;/.test(css));

console.log(red ? "\n" + red + " 紅" : "\nALL PASS");
process.exit(red ? 1 : 0);
