// 電腦版畫面上的日期／時間格式。canon › Copy › Numbers:一律 MM/DD HH:mm、24 小時、補零。
// 踩過兩次:事件分頁的日期條自己拼 "MM-DD"、對話清單用 toLocaleString(12 小時制、月日不補零、英文還多一個逗號)。
// 做法:把格式化那幾顆純函式從原文切出來 eval,用「本地時間元件」建測試日期(不用 ISO 字串,時區不會翻掉日與時)。
// 跑法:node tests/check_shell_datefmt.js
const fs = require("fs"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const trade = fs.readFileSync(path.join(SHELL, "renderer", "trade.js"), "utf8");
const app = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");

let red = 0;
const ok = (name, c) => { console.log((c ? "PASS  " : "FAIL  ") + name); if (!c) red++; };

// 切出來的片段:名字寫死,抓不到就紅(重構改名後這支檔要跟著更新,不能默默變成空測試)
const cut = (src, re, what) => { const m = src.match(re); if (!m) { console.log("FAIL  切不出 " + what); red++; return ""; } return m[0]; };
const parts = [
  cut(trade, /^const tr2 = .*$/m, "tr2"),
  cut(trade, /^const trMD = .*$/m, "trMD"),
  cut(trade, /^function trMs\(ts\) \{[\s\S]*?\n\}/m, "trMs"),
  cut(trade, /^function trStamp\(ts\) \{.*$/m, "trStamp"),
  cut(app, /^function csTime\(sec\) \{.*$/m, "csTime"),
].join("\n");
if (red) { console.log("\n" + red + " 紅"); process.exit(1); }
eval(parts.replace(/^const /gm, "var "));

// 2026-09-03 13:05 本地時間:月與日都是個位數(補零壞掉會紅)、下午一點(12 小時制會變 01:05)
const d = new Date(2026, 8, 3, 13, 5, 0);
ok("trMD 補零並用 / 當分隔(事件分頁的日期條)", trMD(d) === "09/03");
ok("trStamp = MM/DD HH:mm", trStamp(d.getTime() / 1000) === "09/03 13:05");
ok("對話清單 csTime 也是 MM/DD HH:mm、24 小時制", csTime(d.getTime() / 1000) === "09/03 13:05");
ok("午夜不會變成 12:xx", trStamp(new Date(2026, 8, 3, 0, 5).getTime() / 1000) === "09/03 00:05");
ok("csTime 不自己 toLocaleString(語系會給 12 小時制)", !/toLocaleString/.test(cut(app, /^function csTime\(sec\) \{.*$/m, "csTime")));
ok("trade.js 沒有人再用 '-' 拼月日", !/"-" \+ tr2\(/.test(trade));

console.log(red ? "\n" + red + " 紅" : "\nALL PASS");
process.exit(red ? 1 : 0);
