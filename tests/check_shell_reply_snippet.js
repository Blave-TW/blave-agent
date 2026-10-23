// 回合結束系統通知的摘錄 replySnippet(renderer/app.js;spec agent-reply-notifications-0130 §3.3)。從原文切出來跑,連同它用的那幾條標記 regex。
// 測資照 §3.3:開頭就是程式碼區塊、整則只有表格、未閉合的 ```、連結與網址、中英混排截在第 60 字、emoji 在第 60 字、<suggest> 在尾端、空回覆;
// 另加 Blave 自己的標記、markdown 記號、snake_case 不被當斜體。網頁工作頁那一支要過同一組 CASES。
// 跑法:node tests/check_shell_reply_snippet.js
const fs = require("fs"), path = require("path");
const app = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const fn = (src, name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0; for (let k = src.indexOf("{", src.indexOf(")", i)); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("切不出 " + name); };
const line = (name) => { const m = app.match(new RegExp("^const " + name + " = .*;$", "m")); if (!m) throw new Error("找不到 " + name); return m[0]; };
const replySnippet = new Function([line("CARD_TAG"), line("SUG_BLOCK"), line("SUG_OPEN_TAIL"), line("AWAIT_TAG"), line("RS_MAX"), fn(app, "replySnippet"), "return replySnippet;"].join("\n"))();

const Z = "回".repeat(70);
const CASES = [
  ["開頭就是程式碼區塊", "```python\nprint(1)\n```\n回測完成：年化 38.2%", "回測完成：年化 38.2%"],
  ["整則只有表格", "| 參數 | 年化 |\n|---|---|\n| 20／55 | 38.2% |", ""],
  ["未閉合的 ```(尾段整段刪)", "結果如下\n```\nx = 1\ny = 2", "結果如下"],
  ["~~~ 圍欄也算", "前\n~~~\ncode\n~~~\n後", "前 後"],
  ["連結留字、裸網址刪", "看 [回測報告](https://blave.org/r/abc) 或 https://blave.org/x 這裡", "看 回測報告 或 這裡"],
  ["圖片整個刪", "![圖](a.png)完成", "完成"],
  ["HTML 標籤刪、字留", "<b>粗</b>與<br/>換行", "粗與換行"],
  ["中英混排截在第 60 字", "回測 ETH breakout 完成，" + "a".repeat(80), ("回測 ETH breakout 完成，" + "a".repeat(80)).slice(0, 60) + "…"],
  ["剛好 60 字不加「…」", "字".repeat(60), "字".repeat(60)],
  ["61 字截成 60＋「…」", "字".repeat(61), "字".repeat(60) + "…"],
  ["emoji 在第 60 字不切壞(膚色組合字算一格)", "字".repeat(59) + "👍🏽" + "尾巴", "字".repeat(59) + "👍🏽…"],
  ["<suggest> 在尾端", "做完了。\n<suggest>\n- 再掃一次\n</suggest>", "做完了。"],
  ["沒收尾的 <suggest>", "做完了。<suggest>- 再", "做完了。"],
  ["<await/> 三種寫法", "要用哪組？<await/>", "要用哪組？"],
  ["<await /> 與 </await>", "A<await /> B<await></await>", "A B"],
  ["卡片標記", "拿不到資料<blave-card:need-data/>", "拿不到資料"],
  ["<export …/>", "轉好了\n<export target=\"pine\" path=\"strategies/x/exports/a.pine\" />", "轉好了"],
  ["空回覆", "", ""],
  ["null／undefined", null, ""],
  ["只有空白", " \n\t ", ""],
  ["標題、引言、清單記號去掉留字", "# 結果\n> 注意\n- 第一\n* 第二\n+ 第三\n1. 第四\n2) 第五", "結果 注意 第一 第二 第三 第四 第五"],
  ["水平線刪掉", "上\n---\n***\n下", "上 下"],
  ["粗斜體、刪除線去記號", "**粗** __也粗__ *斜* _斜_ ~~刪~~", "粗 也粗 斜 斜 刪"],
  ["snake_case 與 2*3 不被當成斜體", "策略 btc_rsi_v2 的 2 * 3", "策略 btc_rsi_v2 的 2 * 3"],
  ["行內程式碼留字,裡面的 ** 不被吃掉", "呼叫 `f(**kw)` 就好", "呼叫 f(**kw) 就好"],
  ["換行與連續空白收成一格", "第一行\n\n\n第二行   第三", "第一行 第二行 第三"],
  ["\\r\\n 換行", "上\r\n下", "上 下"],
  ["截斷前的尾空白修掉", "字".repeat(59) + " " + Z, "字".repeat(59) + "…"],
];
for (const [name, raw, want] of CASES) { const got = replySnippet(raw); ok(name, got === want, { got, want }); }
ok("輸出永遠 ≤ 61 個 grapheme(主行程的驗證門檻)", CASES.every(([, raw]) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(replySnippet(raw))].length <= 61));

console.log(red ? red + " 紅" : "ALL PASS");
process.exit(red ? 1 : 0);
