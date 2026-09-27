// 被停止 / 中途出錯的回合重開 app 後:runtime 寫給下一輪 agent 的收據行(「[中斷前已執行:…]」)不畫成字,
// 拆成跟即時回合一樣的「思考過程」收據(shell/renderer/app.js splitReceipt / receiptFold / addHistoryAi)。
//   1. splitReceipt:拆出回覆本文與步驟(工具名 + 受詞、「…另有 N 步」);沒有收據行的回覆原樣不動
//   2. 格式對得上:用真的 runtime `_fault_receipt_suffix` 產一行來拆(兩邊誰改了格式這裡就紅)
//   3. 接線:歷史的 assistant 走 addHistoryAi;收據畫在回覆上面、收起;只剩收據(沒有本文)不畫空泡泡
// 跑法:node tests/check_shell_history_receipt.js
const fs = require("fs"), path = require("path"), cp = require("child_process");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "app.js"), "utf8");
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("找不到標記:" + a); return src.slice(i, j); };
eval(cut("const RECEIPT_RE =", "function receiptFold(").replace(/^const /gm, "var "));
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

let r = splitReceipt("已停止。停止時還在跑的步驟：Bash。\n[中斷前已執行:Bash strategies/ lib/data.py、Read lib/x.py、…另有 3 步]");
ok("回覆本文留下、收據行拿掉", r.text === "已停止。停止時還在跑的步驟：Bash。", r);
ok("步驟:工具名 + 受詞,「…另有 N 步」單獨一列", JSON.stringify(r.steps) === JSON.stringify([
  { tool: "Bash", summary: "strategies/ lib/data.py" }, { tool: "Read", summary: "lib/x.py" }, { more: "…另有 3 步" }]), r.steps);
r = splitReceipt("\n[中斷前已執行:Bash strategies/ lib/data.py]");
ok("只有收據(Wei 看到的那一輪):本文是空的", r.text.trim() === "" && r.steps.length === 1, r);
r = splitReceipt("一般回覆,文中提到 [中斷前已執行:x] 但不在結尾\n還有下一行");
ok("不在結尾的同字樣不動", r.steps === null && r.text.startsWith("一般回覆"), r);
ok("沒有收據行:原樣不動", splitReceipt("好").steps === null && splitReceipt("好").text === "好");

// 用真的 runtime 產收據行(stub 掉 claude_agent_sdk,不連網)
const py = `
import sys, types, os, tempfile
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, "..", "runtime"))})
os.environ.setdefault("BLAVE_AGENT_DB", os.path.join(tempfile.mkdtemp(), "s.db"))
sys.modules["claude_agent_sdk"] = types.ModuleType("claude_agent_sdk")
import agent_turn as at
steps = [("Bash", "strategies/ lib/data.py"), ("Read", "lib/x.py")] + [("Grep", "p%d" % i) for i in range(at.TOOL_STEPS_MAX + 2)]
sys.stdout.write("已停止。" + at._fault_receipt_suffix(steps))
`;
const out = cp.spawnSync("python3", ["-c", py], { encoding: "utf8" });
if (out.status !== 0) { console.log(out.stderr); red++; }
else {
  r = splitReceipt(out.stdout);
  ok("runtime 真的產的那一行拆得開(本文、第一步、「…另有」)", r.text === "已停止。" && r.steps[0].tool === "Bash"
    && r.steps[0].summary === "strategies/ lib/data.py" && !!r.steps[r.steps.length - 1].more, { out: out.stdout.slice(-120), r });
}

ok("接線:歷史的 assistant 走 addHistoryAi(user 照舊 addMsg)",
  /x\.turn\.role === "user" \? addMsg\("you", x\.turn\.content\) : addHistoryAi\(x\.turn\.content\)/.test(src));
const hist = cut("function addHistoryAi(", "async function csOpen(");
ok("收據畫在回覆上面、只剩收據時不畫空泡泡", /appendChild\(receiptFold\(r\.steps\)\);\n\s*if \(!r\.steps \|\| r\.text\.trim\(\)\) addMsg\("ai", r\.text\);/.test(hist));
const fold = cut("function receiptFold(", "function addHistoryAi(");
ok("收據長得跟即時回合結束時一樣(think-indicator is-done、思考過程、收起、步驟列)",
  /"think-indicator is-done"/.test(fold) && /dataset\.i18n = "turn\.process"/.test(fold) && /aria-expanded", "false"/.test(fold)
  && /"think-step"/.test(fold) && /whereTag\(stepWhere/.test(fold));
console.log(red ? `\n${red} FAILED` : "\nALL PASS");
process.exit(red ? 1 : 0);
