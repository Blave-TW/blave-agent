// 動作旁白拿掉(Wei 0.1.7 實測):中欄「瀏覽器」標題下那行「● 輸入「…」／點「…」」不要——
// 回合狀態列已經講了 agent 在做什麼,這行重複。ph "act" 的其他載體(縮圖游標 .tc、pulse)照舊。
// 跑法:node tests/check_shell_browser_no_act_narration.js
const fs = require("fs");
const path = require("path");
const RD = path.join(__dirname, "..", "shell");
const bjs = fs.readFileSync(path.join(RD, "renderer", "browser.js"), "utf8");
const strings = fs.readFileSync(path.join(RD, "renderer", "strings.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

ok("brFoot 沒有點擊 / 打字旁白(br.typing / br.clicking / br.scrolling 全下線)", !/br\.typing|br\.clicking|br\.scrolling/.test(bjs));
["zh", "en"].forEach((lang) => {
  const po = fs.readFileSync(path.join(RD, "i18n", lang + ".po"), "utf8");
  ok(lang + ".po 的旁白字串清掉", !/msgid "br\.(typing|clicking|scrolling)"/.test(po));
});
ok("strings.js(生成物)跟上", !/"br\.(typing|clicking|scrolling)"/.test(strings));
// 沒被錯殺的鄰居:讀取進度、note 類短訊(看大綱 / 按鍵)照舊
ok("讀取進度照舊(br.reading n/N)", /t\("br\.reading"\) \+ " " \+ x\.prog\.n \+ "\/" \+ x\.prog\.total/.test(bjs));
ok("note 類短訊照舊(br.act.* / br.pressing 是讀取工具的訊息槽,不在這次範圍)", /t\("br\.act\." \+ x\.note\.kind\)/.test(bjs) && /"br\.pressing"/.test(strings));
// ph "act" 的機制照舊:縮圖游標與 pulse 都靠它
ok("ph act 仍驅動縮圖游標(.tc)與 pulse", /x\.ph === "act"/.test(bjs) && /x\.ph === "read" \|\| x\.ph === "act"/.test(bjs));

console.log(red ? "\n" + red + " FAILED" : "\nALL PASS");
process.exit(red ? 1 : 0);
