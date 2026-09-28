// 回合狀態列摘要(shell/renderer/app.js actKindOf / actWant / actApply / fmtDur;spec-turn-status-summary ②、行為規則)
//   1. 顯示誰:有工具在跑 → 最晚開始、還在跑的那個;它 done 了換剩下最晚的;silent 不進集合;unknown 不帶受詞
//   2. 沒工具在跑:同一段文字寫了 ≥1.5 秒、1.5 秒內還有字 → 正在寫回覆;否則正在思考;瀏覽器有頁在等 → 等你操作
//   3. 最短停留 1.2 秒:期間只留最新的一個,到時直接換上;同 kind 同受詞不算換
//   4. 舊 runtime(沒有 kind)退路只看工具名、不猜 Bash
//   5. 時長 47s / 4m 57s / 1h 02m;步數字串拿掉;act.* 兩語齊、每個 runtime kind 都有字
//   6. 瀏覽卡:進行中一行(圖示疊只放讀到內容的頁＋已讀 d/n＋展開);搜尋結果頁不進清單;中繼頁不算已讀;沒讀到的排最下面
// 跑法:node tests/check_shell_turn_status.js
const fs = require("fs"), path = require("path"), cp = require("child_process");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "app.js"), "utf8"), css = fs.readFileSync(path.join(R, "app.css"), "utf8");
const brSrc = fs.readFileSync(path.join(R, "browser.js"), "utf8"), brCss = fs.readFileSync(path.join(R, "browser.css"), "utf8");
const strings = fs.readFileSync(path.join(R, "strings.js"), "utf8");
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); if (i < 0 || j < 0) throw new Error("找不到標記:" + a); return s.slice(i, j); };
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

// ── 狀態機(切原文,DOM / 時鐘 / 計時器都換成假的) ──
const block = cut(src, "const ACT_HOLD_MS", "/* 時長(canon");
const dur = cut(src, "function fmtDur(", "function busyElapsed(");
const env = { now: 0, shown: [], timers: [], need: false };
const STRINGS = { en: {} };
for (const m of cut(strings, "\n  en: {", "\n  zh: {").matchAll(/"(act\.[a-z_]+)": "([^"]*)"/g)) STRINGS.en[m[1]] = m[2];
const t = (k, v) => (STRINGS.en[k] || k).replace("{n}", v && v.n != null ? v.n : "{n}");
const M = new Function("t", "STRINGS", "env", `
  const Date = { now: () => env.now };
  const setTimeout = (f, ms) => { env.timers.push({ at: env.now + ms, f }); return env.timers.length; };
  const clearTimeout = () => { env.timers.length = 0; };
  let busy = { el: {} };
  const BR = { tabs: new Map([["p1", { alias: "t2", url: "https://www.theblock.co/post/1" }]]) };
  const brHost = (u) => { try { return new URL(u).hostname; } catch (_) { return ""; } };
  const brReg = (h) => h.replace(/^www\\./, "");
  const brNeedsUser = () => env.need;
  function busySet(label, obj, kind) { env.shown.push([label, obj || "", kind]); }
  ${block.replace(/^const ACT = /m, "var ACT = ")}
  ${dur}
  return { ACT, actKindOf, actWant, actToolStart, actToolDone, actApply, actReset, actToolPrep, fmtDur, stepLabel };`)(t, STRINGS, env);
const tick = (ms) => { env.now += ms; const due = env.timers.filter((x) => x.at <= env.now); env.timers = env.timers.filter((x) => x.at > env.now); due.forEach((x) => x.f()); };
const last = () => env.shown[env.shown.length - 1];
M.actReset(); M.actApply(true);
ok("回合一開始:正在思考", last()[0] === "Thinking");
tick(2000); M.actToolStart({ id: "a", kind: "web_read", kind_obj: "investing.com" });
ok("有工具開跑:正在讀＋網域(受詞分開給,mono)", last()[0] === "Reading" && last()[1] === "investing.com" && last()[2] === "web_read");
tick(300); M.actToolStart({ id: "b", kind: "search", kind_obj: "ETH ETF" });
ok("1.2 秒內又來一個:先不換", last()[1] === "investing.com");
tick(1000);
ok("停留時間到:直接換上最新那個(最晚開始、還在跑)", last()[0] === "Searching:" && last()[1] === "ETH ETF");
tick(1500); M.actToolDone({ id: "b" });
ok("它 done 了:換成剩下最晚開始的那個", last()[1] === "investing.com");
tick(1500); M.actToolStart({ id: "c", kind: "silent" });
ok("silent 工具不改字", last()[1] === "investing.com");
tick(1500); M.actToolStart({ id: "z", kind: "brand_new_kind", kind_obj: "leak" });
ok("外殼不認得的 kind:正在處理、不帶受詞", last()[0] === "Working" && last()[1] === "");
M.actToolDone({ id: "z" });
tick(1500); M.actToolStart({ id: "d", kind: "unknown", kind_obj: "should-not-show" }); tick(1300);
ok("認不出的工具:正在處理、不帶受詞", last()[0] === "Working" && last()[1] === "");
tick(1500); M.actToolDone({ id: "d" }); M.actToolDone({ id: "a" }); tick(1300);
ok("沒工具在跑、沒在寫字:正在思考", last()[0] === "Thinking");
const W = (st, now, need) => M.actWant(Object.assign({ running: new Map(), textStart: 0, lastDelta: 0 }, st), now, need);
ok("同一段字寫了 ≥1.5 秒、還在寫:正在寫回覆", W({ textStart: 1000, lastDelta: 2400 }, 2600).kind === "reply");
ok("…才寫 1 秒(旁白通常接著就是工具):還是正在思考", W({ textStart: 1000, lastDelta: 1900 }, 2000).kind === "thinking");
ok("…停筆超過 1.5 秒:回到正在思考", W({ textStart: 1000, lastDelta: 2000 }, 3600).kind === "thinking");
ok("tool_prep 帶 kind(runtime 邊生參數邊分類):組報告的 heredoc → 正在組報告;還沒命中 → 正在寫程式",
  W({ prep: { tool: "Bash", kind: "report" } }, 0).kind === "report" && W({ prep: { tool: "Bash", kind: "code_prep" } }, 0).kind === "code_prep");
ok("舊 runtime 的 tool_prep 沒有 kind:寫檔 → 正在寫程式;其他工具維持前一個字", W({ prep: { tool: "Write" } }, 0).kind === "code_prep"
  && W({ prep: { tool: "Bash" }, lastWant: { kind: "web_read", obj: "x.com" } }, 0).obj === "x.com");
ok("接線:tool_prep chunk 整個交給狀態機;tool 開跑時清掉 prep", /c\.type === "tool_prep"\) \{\n\s*actToolPrep\(c\);/.test(src) && /ACT\.prep = null;\n\s*if \(k\.kind === "silent"\) return;/.test(src));
ok("瀏覽器有頁在等用戶:等你操作(蓋過一切)", W({ running: new Map([["a", { kind: "web_read", obj: "x", seq: 1 }]]) }, 0, true).kind === "need_user");
M.actReset(); M.actApply(true); tick(1500);
M.actToolStart({ id: "e", kind: "web_read", kind_tab: "t2" });
ok("kind_tab:用分頁 alias 查到網域當受詞", last()[1] === "theblock.co");
tick(1500); M.actToolStart({ id: "f", kind: "web_read_many", kind_obj: "3" });
ok("讀多頁:數字在 label 裡,不再重複當受詞", last()[0] === "Reading {n} pages".replace("{n}", "3") && last()[1] === "");
// 退路
const K = (c) => { const r = M.actKindOf(c); return r.kind + "|" + (r.obj || ""); };
ok("舊 runtime 退路:只看工具名,Bash 一律「正在處理」",
  K({ tool: "Read", summary: "references/reports.md" }) === "docs|" && K({ tool: "Read", summary: "tmp/a.json" }) === "file_read|a.json"
  && K({ tool: "Edit" }) === "file_write|" && K({ tool: "Grep" }) === "files|" && K({ tool: "WebSearch", summary: "x" }) === "search|"
  && K({ tool: "mcp__blave_browser__browser_read" }) === "web_read|" && K({ tool: "Task" }) === "delegate|" && K({ tool: "TodoWrite" }) === "silent|"
  && K({ tool: "Bash", summary: "lib/runner.py strategies/a/strategy.py" }) === "unknown|");
// 展開的步驟清單(#88):跟狀態列同一套字,工具名不上畫面
const SL = (c) => M.stepLabel(c);
const TOOLS = ["ToolSearch", "mcp__blave_browser__browser_search", "mcp__blave_browser__browser_open_many", "mcp__blave_browser__browser_wait",
  "mcp__blave__get_ssh_access", "mcp__someone_else__thing", "Bash", "Read", "ToolFromTheFuture"];
const rows = [].concat(...TOOLS.map((tool) => [SL({ tool, kind: "brand_new_kind", kind_obj: "leak" }), SL({ tool, kind: "unknown" }), SL({ tool, summary: "x" })])).filter(Boolean);
ok("步驟清單:任何工具、任何 kind 都不露工具名(沒有 mcp__、沒有底線代號)", rows.length > 20 && rows.every((r) => !/mcp__|_|ToolSearch|ToolFromTheFuture/.test(r.verb)) && rows.every((r) => STRINGS.en["act.unknown"] === r.verb || Object.values(STRINGS.en).includes(r.verb)), rows);
ok("步驟清單:kind 對得到 → 狀態列那個字＋runtime 的 summary", SL({ tool: "mcp__blave_browser__browser_search", kind: "search", kind_obj: "q", summary: "ETH staking" }).verb === "Searching:"
  && SL({ tool: "mcp__blave_browser__browser_search", kind: "search", summary: "ETH staking" }).obj === "ETH staking"
  && SL({ tool: "Bash", kind: "backtest", kind_obj: "btc_sma", summary: "" }).obj === "btc_sma");
ok("步驟清單:對不到 → 中性的「正在處理」、不帶 kind 的受詞;silent(ToolSearch)不列", SL({ tool: "mcp__x__y", kind: "brand_new_kind", kind_obj: "leak" }).verb === "Working"
  && SL({ tool: "mcp__x__y", kind: "brand_new_kind", kind_obj: "leak" }).obj === "" && SL({ tool: "ToolSearch", kind: "silent" }) === null && SL({ tool: "ToolSearch" }) === null);
ok("步驟清單:重開畫回的收據只有工具名,照名稱分類", SL({ tool: "mcp__blave_browser__browser_read", summary: "" }).verb === "Reading" && SL({ tool: "Bash", summary: "lib/runner.py" }).verb === "Working"
  && SL({ tool: "Bash", summary: "lib/runner.py" }).obj === "lib/runner.py");
ok("接線:即時那列與重開畫回那列都走 stepLabel,不再畫 c.tool / st.tool", /verb\.textContent = lab\.verb;/.test(src) && /v\.textContent = lab\.verb;/.test(src)
  && !/textContent = c\.tool/.test(src) && !/textContent = st\.tool/.test(src));
ok("時長格式", M.fmtDur(47) === "47s" && M.fmtDur(297) === "4m 57s" && M.fmtDur(60) === "1m 00s" && M.fmtDur(3720) === "1h 02m" && M.fmtDur(-3) === "0s");

// ── 字串 ──
const py = `import sys, types, os, tempfile, json, re
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, "..", "runtime"))})
os.environ.setdefault("BLAVE_AGENT_DB", os.path.join(tempfile.mkdtemp(), "s.db"))
sys.modules["claude_agent_sdk"] = types.ModuleType("claude_agent_sdk")
import agent_turn
src = open(agent_turn.__file__, encoding="utf-8").read()
print(json.dumps(sorted(set(re.findall(r'return "([a-z_]+)"', src[src.index("def _bash_kind("):src.index("def _tool_kind(") + 6000])) | {k for k, _ in agent_turn._KIND_SCAN})))`;
const kinds = JSON.parse(cp.execFileSync("python3", ["-c", py], { encoding: "utf8" }));
const zh = cut(strings, "\n  zh: {", "\n};");
const need = kinds.filter((k) => k !== "silent").concat(["thinking", "reply", "code_prep", "need_user"]);
const missing = need.filter((k) => !STRINGS.en["act." + k] || !zh.includes(`"act.${k}":`));
ok("每個 runtime 會送的 kind(加 thinking／reply／code_prep／need_user)兩語都有 act.* 字", kinds.length > 20 && !missing.length, missing);
ok("步數字串拿掉(「執行中 · 第 N 步」)、不再用 turn.running", !/turn\.running/.test(strings) && !/turn\.running/.test(src));
ok("讀屏:受詞與秒數 aria-hidden;label 只在字變了才寫", /obj\.className = "think-obj"; obj\.hidden = true; obj\.setAttribute\("aria-hidden", "true"\);/.test(src)
  && /if \(busy\.verb\.textContent !== label\) busy\.verb\.textContent = label;/.test(src));
ok("版面:摘要 inline-flex、受詞可截、字級 12", /\.think-sum \{ display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; \}/.test(css)
  && /\.think-obj \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px;/.test(css) && /\.think-verb \{ flex: none; font-size: 12px;/.test(css));

// ── 瀏覽卡 ──
ok("卡頭不放狀態字:進行中的卡走 brLine(圖示疊＋已讀 d/n),不走 brStat", /\n  h\.append\(brLine\(b\)\);/.test(brSrc) && !/br\.browsing|br\.compiling/.test(cut(brSrc, "function brLine(", "function brOrder(")));
ok("疊圖只放真的讀到內容的頁(讀過、不是搜尋頁、不是中繼頁)", /const brIsRead = \(x\) => !!x && x\.readEver && !x\.search && !x\.relay;/.test(brSrc)
  && /\.filter\(brIsRead\)\.slice\(0, 4\)/.test(brSrc) && /read\.slice\(0, 4\)/.test(brSrc));
ok("搜尋結果頁開頁當下就認(Google / DDG 的網址),不先閃一格 0/1", /if \(BR_SERP\.test\(String\(ev\.url \|\| ""\)\)\) \{[^\n]*x\.search = true;[^\n]*return; \}/.test(brSrc));
ok("搜尋結果頁從清單拿掉", /case "search": if \(x\) \{[\s\S]{0,300}b\.ids\.splice\(i, 1\)/.test(brSrc));
ok("中繼頁:page_done 帶 relay 就不算讀過,訊息槽寫原因", /if \(ev\.relay\) x\.relay = true; if \(ev\.read && !ev\.relay\) x\.readEver = true;/.test(brSrc) && /if \(x\.relay\) return t\("br\.relay"\);/.test(brSrc));
ok("收著時只露出要你操作的頁;沒讀到的排最下面、有細線與小標", /\.bblk:not\(\.sum\):not\(\.is-open\) \.wall > \.pt:not\(\[data-ph="wait"\]\)/.test(brCss) && /\.bsep \{ grid-column: 1 \/ -1;/.test(brCss)
  && /const want = ok\.concat\(\[sep\], ng\);/.test(brSrc));
ok("聊天列不掛「由你按」(只留中欄)", !/brEl\("span", "tag-you"/.test(cut(brSrc, "function brStatusNode(", "function brPh(")));
// 重開對話的順序:舊紀錄的區塊時間是回合開始(早於逐字稿那句用戶訊息幾秒)→ 挪到那句後面
const fix = new Function(cut(src, "function histFixOrder(", "async function csOpen(") + "; return histFixOrder;")();
const seq = [{ ts: 100, br: { kind: "block" } }, { ts: 102, turn: { role: "user" } }, { ts: 140, turn: { role: "assistant" } },
  { ts: 200, turn: { role: "user" } }, { ts: 205, br: { kind: "block" } }, { ts: 230, turn: { role: "assistant" } }].reduce(fix, []);
ok("重開對話:瀏覽區塊不排在同一輪的用戶訊息上面(舊紀錄);新紀錄本來就對的不動",
  seq.map((x) => x.br ? "B" : x.turn.role[0]).join("") === "uBauBa", seq.map((x) => x.br ? "B" : x.turn.role[0]).join(""));
ok("新紀錄的區塊時間 = agent 第一次用瀏覽器(不是回合開始)", /ts: \(c\.usedAt \|\| c\.turnKey\) \/ 1000/.test(fs.readFileSync(path.join(R, "..", "browser", "index.js"), "utf8")));
const head = cut(brSrc, "function brPaintHead(b) {", "function brToggleList(");
ok("卡頭最多一顆文字鈕＋chevron:中欄沒有這一輪的頁 →「看網頁」,已在中欄就不放字(收回靠中欄 ✕);沒有「全部展開」",
  /if \(!mine && !b\.conv && b\.ids\.length\) \{[^\n]*t\("br\.openPanel"\)/.test(head) && !/closePanel/.test(brSrc)
  && !/expandAll|br\.expand"/.test(brSrc + strings) && /aria-label", t\(b\.open \? "br\.listHide" : "br\.listShow"\)/.test(head));
// 「看網頁」(Wei 0928 第 1 點 A 案):安靜鈕——圖示＋字、無底線;視覺高 28、熱區 32(上下各外擴 2),卡高不變
{ const rule = (brCss.match(/\.br-open \{[^}]*\}/) || [""])[0];
  ok("「看網頁」是安靜鈕:瀏覽器視窗圖示＋字(字串不變)、無底線、視覺 28／熱區 32、hover 填色", /brEl\("button", "br-open"\);[^\n]*all\.append\(brIcon\("win"\), t\("br\.openPanel"\)\)/.test(head)
    && /win: '<svg class="ic"/.test(brSrc) && /height: 28px/.test(rule) && /font-size: 12px/.test(rule) && /gap: var\(--space-6\)/.test(rule) && !/text-decoration|border:/.test(rule)
    && brCss.includes('.br-open::before { content: ""; position: absolute; inset: -2px 0; }') && brCss.includes(".br-open:hover { background: var(--surface-muted); color: var(--ink); }")
    && !/btn-quiet/.test(head)); }
// 中欄即時頁(設計稽核 A2):背景分頁固定 1280×800 排版,中欄大小只在顯示時套;擷取 / 顯示後清掉 viewport 覆寫
const bIdx = fs.readFileSync(path.join(R, "..", "browser", "index.js"), "utf8");
ok("中欄即時頁:背景分頁固定 1280×800、bounds() 不再改 parkSize;擷取與 setBounds 之後清 viewport 覆寫;容器底色 surface-muted",
  /const parkSize = \{ width: 1280, height: 800 \};/.test(bIdx) && !/parkSize = \{ width: Math\.round/.test(bIdx)
  && /Emulation\.clearDeviceMetricsOverride/.test(bIdx) && /v\.view\.setBounds\(nb\); unEmulate\(v\);/.test(bIdx)
  && /\.bv-page \{[^}]*background: var\(--surface-muted\)/.test(brCss));
// 擷取成功、逾時、拋錯三種情況都要清掉 viewport 覆寫(複審 P2-6):把真的 captureSnapshotImage 切出來跑
{
  const fnCut = (name) => { const a = bIdx.indexOf("  async function " + name + "(") >= 0 ? bIdx.indexOf("  async function " + name + "(") : bIdx.indexOf("  function " + name + "("); return bIdx.slice(a, bIdx.indexOf("\n  }\n", a) + 4); };
  const mk = (behave) => { const sent = []; return { sent, v: { wc: { debugger: { sendCommand: (m) => { sent.push(m); if (m === "Page.captureScreenshot") return behave(sent.filter((x) => x === m).length); if (m === "Page.getLayoutMetrics") return Promise.resolve({ cssContentSize: { width: 1280, height: 3000 } }); return Promise.resolve({}); } } } } }; };
  const run = new Function("within", fnCut("unEmulate") + fnCut("fullClip") + fnCut("captureSnapshotImage") + "; return captureSnapshotImage;")((p) => p);
  const cases = { ok: () => Promise.resolve({ data: "AA==" }), throws: (n) => n === 1 ? Promise.reject(new Error("timeout")) : Promise.resolve({ data: "AA==" }), bothFail: () => Promise.reject(new Error("x")) };
  Promise.all(Object.entries(cases).map(async ([k, f]) => { const m = mk(f); await run(m.v, true); return [k, m.sent.includes("Emulation.clearDeviceMetricsOverride")]; })).then(async (rs) => {
    ok("整頁擷取成功 / 逾時 / 兩種都失敗:都清掉 viewport 覆寫", rs.every(([, c]) => c), rs);
    // 操作中的視口版(!full,防閃爍那批):從頭到尾不碰 viewport——沒有 beyond-viewport、也沒東西要清
    const m2 = mk(() => Promise.resolve({ data: "AA==" })); await run(m2.v);
    ok("視口版擷取不動 viewport(無 getLayoutMetrics、無 clearDeviceMetricsOverride)", m2.sent.join() === "Page.captureScreenshot", m2.sent);
    console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
  });
}
ok("中欄狀態句講這一頁(不再重複已讀 d/n)", /if \(x\) \{ const n = brStatusNode\(x\);[^\n]*brFoot\(x\)/.test(brSrc));
ok("來源卡已拿掉(0.1.8):browser.css 沒有 .src / .srcs 規則", !/(^|[\s,])\.srcs?\b/m.test(brCss));
// 中繼頁判定(主行程)
const C = require(path.join(__dirname, "..", "shell", "browser", "content.js"));
const body = "x ".repeat(150);
ok("中繼頁判定:正文 <200 字,或整個標題就是 Loading／Redirect／Just a moment", C.isRelay({ markdown: "short" }, "NewsNow: Loading story…")
  && C.isRelay({ markdown: body }, "Just a moment...") && C.isRelay({ markdown: body }, "Redirecting…")
  && !C.isRelay({ markdown: body }, "Ethereum ETF flows hit record") && !C.isRelay({ markdown: body }, "Bitcoin loading up for breakout"));
ok("擋廣告攔截的擋牆頁不算已讀(稽核 B1);正文長的文章提到 ad blocker 照算", C.isRelay({ markdown: "We noticed your ad blocker is on. Please support our site by disabling it. " + "x ".repeat(120) }, "Benzinga")
  && !C.isRelay({ markdown: "An essay on why ad blockers matter. " + "word ".repeat(600) }, "Ad blockers"));
// 回合中按 Enter(e2e 0.1.8 #71、設計稽核第四批 W6):草稿非空 → 不送、輸入框上方出一行;回合結束即收
{ const el = { dataset: {}, textContent: "" }, $ = () => el, t = (k) => "<" + k + ">";
  const taWaitShow = new Function("$", "t", cut(src, "function taWaitShow(", "\n}\n") + "\n}\nreturn taWaitShow;")($, t);
  taWaitShow(true); const on = el.textContent === "<ws.waitTurn>" && el.dataset.i18n === "ws.waitTurn";
  taWaitShow(false);
  ok("Enter 提示行:出現時帶字與 data-i18n(換語言跟著換),收掉時兩個都清", on && el.textContent === "" && !("i18n" in el.dataset));
  ok("接線:回合中且草稿非空才出、不送;沒在跑照舊送;回合結束(sendBtnSync)收掉", /e\.preventDefault\(\);\n\s*if \(running && \$\("ta"\)\.value\.trim\(\)\) \{ taWaitShow\(true\); return; \}[^\n]*\n\s*sendDraft\(\);/.test(src)
    && /if \(!running\) taWaitShow\(false\);/.test(cut(src, "function sendBtnSync(", "async function stopTurn(")));
  const html = fs.readFileSync(path.join(R, "index.html"), "utf8");
  ok("那一行在輸入框正上方、role=status;12px --ink-2、空的時候不佔位", /<p class="ta-wait" id="ta-wait" role="status"><\/p>\s*<div class="chat-input">/.test(html)
    && /\.ta-wait \{ margin: 0 0 var\(--space-6\); font-size: 12px; line-height: 1\.5; color: var\(--ink-2\); \}\n\.ta-wait:empty \{ display: none; \}/.test(css)); }
// (結果在上面的非同步檢查裡印)
