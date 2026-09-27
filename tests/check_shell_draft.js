// 回合進行中的文字先不進回覆區(shell/renderer/app.js collectDraft / draftShow / draftPromote)。
//   1. collectDraft:text 累積成草稿;tool(開跑)= 這段是旁白、丟掉;text_replace 換掉草稿;done / image / error 才升成回覆
//   2. 重現 2026-09-26 的實測:旁白 → 工具 → 旁白 → 工具 → 回覆,升成回覆的只有最後一段
//   3. 接線:text 只畫草稿行(不再 addMsg / paintAi);升格在 draftPromote(先分類錯誤、再畫泡泡);turn-end 先升格;
//      草稿行已拿掉(spec-turn-status-summary 拍板題 1):串流中的字不上畫面,狀態列說「正在寫回覆」
// 跑法:node tests/check_shell_draft.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "app.js"), "utf8"), css = fs.readFileSync(path.join(R, "app.css"), "utf8");
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("找不到標記:" + a); return src.slice(i, j); };
eval(cut("function collectDraft(", "function draftShow(").replace(/^function /m, "var collectDraft = function "));
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

// 跑一串 chunk,回傳每次升格出去的字
const run = (chunks) => { let st = { draft: "" }; const out = [];
  for (const c of chunks) { const d = collectDraft(st, c); if (d.promote && d.draft.trim()) { out.push(d.draft); st = { draft: "" }; } else st = { draft: d.draft }; }
  return { out, left: st.draft }; };

let r = run([{ type: "text", text: "First sentence " }, { type: "text", text: "must" }, { type: "tool", tool: "Bash", status: "running" },
  { type: "thinking", text: "First sentence must" }, { type: "tool", tool: "Bash", status: "done" },
  { type: "text", text: "Now let's build the full" }, { type: "tool", tool: "Write", status: "running" },
  { type: "text", text: "今天比特幣兩則新聞" }, { type: "text", text: ":……" }, { type: "done" }]);
ok("旁白 → 工具 → 旁白 → 工具 → 回覆:只有最後一段升成回覆", JSON.stringify(r.out) === JSON.stringify(["今天比特幣兩則新聞:……"]), r);
r = run([{ type: "text", text: "a" }, { type: "tool", status: "done" }, { type: "text", text: "b" }, { type: "done" }]);
ok("工具的 done(補耗時)不是新步驟,不丟草稿", JSON.stringify(r.out) === JSON.stringify(["ab"]), r);
r = run([{ type: "text", text: "raw <suggest>x</suggest>" }, { type: "text_replace", text: "clean" }, { type: "done" }]);
ok("text_replace 換掉草稿(runtime 剝掉標記後的定稿)", JSON.stringify(r.out) === JSON.stringify(["clean"]), r);
r = run([{ type: "text", text: "圖前面" }, { type: "image" }, { type: "text", text: "圖後面" }, { type: "done" }]);
ok("中途插圖:圖前那段先升格,順序 文字 → 圖 → 文字", JSON.stringify(r.out) === JSON.stringify(["圖前面", "圖後面"]), r);
r = run([{ type: "text", text: "半截" }, { type: "error", message: "x" }]);
ok("出錯:手上的半截先升格", JSON.stringify(r.out) === JSON.stringify(["半截"]), r);
r = run([{ type: "text", text: "還在打" }]);
ok("還沒 done:不升格(留給 turn-end)", r.out.length === 0 && r.left === "還在打", r);

const onEv = cut("window.blave.onTurnEvent((c) => {", "// turnFaulted:");
ok("接線:每個 chunk 先過 collectDraft,要升格就 draftPromote", /const d = collectDraft\(\{ draft \}, c\);\n\s*draft = d\.draft;\n\s*if \(d\.promote\) draftPromote\(\);/.test(onEv));
ok("接線:text / text_replace 只畫草稿行,不直接進泡泡", /c\.type === "text" \|\| c\.type === "text_replace"\) \{\n\s*draftShow\(\);\n\s*\}/.test(onEv) && !/addMsg\("ai"/.test(onEv));
const prom = cut("function draftPromote(", "window.blave.onTurnEvent(");
ok("升格:先分類錯誤(登入 / 額度 / model),再畫泡泡、記 turnGotReply、設思考過程錨點",
  /const f = classifyFault\(text\);/.test(prom) && /paintAi\(liveBubble, \(liveBubble\._raw \|\| ""\) \+ text\); turnGotReply = true;/.test(prom) && /busy\.anchor = liveBubble/.test(prom));
ok("turn-end 先升格(runtime 沒送 done 就結束時)", /window\.blave\.onTurnEnd\(async \(r\) => \{\n\s*draftPromote\(\);/.test(src));
const show = cut("function draftShow(", "function draftPromote(");
ok("草稿行拿掉了(Wei 拍板):不建 .think-draft,draftShow 只記 text delta 的時間給狀態機、不碰 DOM",
  !/think-draft/.test(src) && !/think-draft/.test(css) && /ACT\.textStart = now;/.test(show) && /ACT\.lastDelta = now;/.test(show)
  && !/textContent|appendChild|hidden/.test(show));
console.log(red ? `\n${red} FAILED` : "\nALL PASS");
process.exit(red ? 1 : 0);
