// 同一句用戶訊息顯示兩次(Wei 實測截圖):submitMessage 先畫泡泡再送,沒送出去的路
// (busy「上一輪還在跑」/ 版本閘 blocked / 暖機中按停止 / 引擎起不來)泡泡留著——ghost 泡泡
// 跟之後真的送出的那則長一模一樣。修:沒送出去就收回泡泡,打字的那句還原到輸入框。
// (fault 卡的「重送」與停止後再送是真的兩則、兩列 DB,不在此列。)
// 跑法:node tests/check_shell_chat_unsent_bubble.js
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

const sub = (src.match(/async function submitMessage\(msg, opts\) \{[\s\S]*?\n\}/) || [""])[0];
ok("泡泡留住節點+unsend(收回泡泡;打字的才塞回輸入框,固定句不塞)",
  /const bubble = addMsg\("you", msg\);/.test(sub) && /const unsend = \(\) => \{ bubble\.remove\(\); if \(lastUserTyped\) stopRestore\(msg\); \};/.test(sub));
ok("busy(上一輪還在跑):收回泡泡再上系統行", /unsend\(\); addMsg\("sys", t\("turn\.busy"\)\); unlock\(\); return false;/.test(sub));
ok("版本閘 blocked:收回泡泡", /minv\.chat[\s\S]{0,200}unsend\(\); unlock\(\); return false;/.test(sub));
ok("暖機中按停止:收回泡泡(還原照舊只認打字的)", /if \(turnStopped\) \{ turnStopped = false; unlock\(\); bubble\.remove\(\); if \(lastUserTyped\) stopRestore\(msg\); return false; \}/.test(sub));
ok("引擎起不來(catch):收回泡泡", /turn\.engineFailed[\s\S]{0,120}unsend\(\); unlock\(\); return false;/.test(sub));
ok("真的送出(started)那條不收泡泡", /if \(r\.started\) \{ busyStart\(\); trackFeature\("chat_sent"\); return true; \}/.test(sub));
ok("addMsg 回傳節點(收回靠它)", /\$\("chat-scroll"\)\.appendChild\(el\);[\s\S]{0,120}return el;\n\}/.test(src));

// ---- 停止後重複(Wei 定性):按停止把句子放回輸入框時,舊的那則泡泡一併收回;
// 有工具收據(摺疊)時保留——收據需要上下文。session.db 照實留,只是畫面不重複。
{
  ok("回合起手記住泡泡+收據旗標", /turnCards = \[\]; turnBubble = bubble; turnHadTool = false;/.test(src));
  ok("tool chunk 一到就記「有收據」", /\} else if \(c\.type === "tool"\) \{\n    turnHadTool = true;/.test(src));
  const stopBlk = (src.match(/if \(stopped && lastUserTyped\) \{[\s\S]*?\n  \}/) || [""])[0];
  ok("停止:沒回覆也沒收據 → 收回泡泡再還原輸入框(重送不出現兩則)",
    /if \(!turnGotReply && !turnHadTool && turnBubble && turnBubble\.parentNode\) turnBubble\.remove\(\);/.test(stopBlk)
    && stopBlk.indexOf("turnBubble.remove()") < stopBlk.indexOf("stopRestore(lastUserText)"));
  ok("有回覆或有收據 → 泡泡留著(條件裡兩個旗標都在)", /!turnGotReply && !turnHadTool/.test(stopBlk));
}

console.log(red ? "\n" + red + " FAILED" : "\nALL PASS");
process.exit(red ? 1 : 0);
