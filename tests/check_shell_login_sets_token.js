// 每條「登入 Blave AI 成功」的路都要把 renderer 的 hasToken 設成 true。
// 漏了的話 acctPrecheck / acctCheck 一進門就 return:綁卡預檢卡不畫、402 卡停在「確認中」,要重開 app 才好
// (0.1.9–0.1.14 連結畫面的「Blave AI」鈕就是這樣)。列舉 app.js 裡每個 await startOAuth( 與
// if (await hasBlaveToken()) 分支,各自往下 2 行內要看到 hasToken = true。
// 跑法:node tests/check_shell_login_sets_token.js
const fs = require("fs"), path = require("path");
const lines = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8").split("\n");
let red = 0, n = 0;
lines.forEach((l, i) => {
  if (!/await window\.blave\.startOAuth\(|if \(await window\.blave\.hasBlaveToken\(\)\)/.test(l)) return;
  n++;
  const near = lines.slice(i, i + 3).join("\n");
  const good = /hasToken = true/.test(near);
  console.log((good ? "PASS  " : "FAIL  ") + `app.js:${i + 1} ${l.trim().slice(0, 70)}`);
  if (!good) red++;
});
if (n < 5) { console.log(`FAIL  只找到 ${n} 個登入點,預期至少 5 個(比對字串可能改了,這支測試要跟著改)`); red++; }
console.log(red ? `${red} 紅` : "all pass");
process.exit(red ? 1 : 0);
