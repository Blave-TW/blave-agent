// 「送上雲端 / 拉回這台電腦」(shell/renderer/handoff.js + 接線)。0.1.47 起按確認由 app 直接搬(transferUp／transferDown),不經 agent:
//   ① 只有過得了名字閘門的資料夾名才出鈕(含 Windows 保留名;同 shell/transfer.js 與 runtime)
//   ② 目的地同名一律不覆蓋:確認框講清楚會存成哪個新名字,直接指令帶那個名字
//   ③ 功能預設關的時候,兩顆鈕一顆都不畫
//   ④ 結果的並排比較照 references/cloud-handoff.md §7 的機械規則(hoCompare)
// 跑法:node tests/check_shell_handoff_msg.js
const fs = require("fs"), path = require("path"), vm = require("vm");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "handoff.js"), "utf8");
const appSrc = fs.readFileSync(path.join(R, "app.js"), "utf8"), trSrc = fs.readFileSync(path.join(R, "trade.js"), "utf8");
const html = fs.readFileSync(path.join(R, "index.html"), "utf8"), css = fs.readFileSync(path.join(R, "app.css"), "utf8");
const strings = fs.readFileSync(path.join(R, "strings.js"), "utf8");

// ── 純邏輯(從原文切出來跑;這一段不准碰 DOM)──
const a = src.indexOf("/* ── 純邏輯("), b = src.indexOf("/* ── 純邏輯到此");
if (a < 0 || b < 0) throw new Error("找不到純邏輯區塊的標記");
const block = src.slice(a, b);
if (/\bdocument\b|\$\(|window\.|\bt\(/.test(block.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))) throw new Error("純邏輯區塊碰了 DOM / i18n");
const ctx = { HO_ID_RE: eval(/const HO_ID_RE = (\/.*?\/);/.exec(src)[1]), LANG: "zh" };   // hoMovesRow 只用 LANG 決定頓號 / 逗號
const cutFn = (name) => { const i = src.indexOf("function " + name + "("); let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("no " + name); };
vm.createContext(ctx); vm.runInContext((block + "\n" + cutFn("hoMovesRow") + "\n" + cutFn("hoStaysRow")).replace(/^const /gm, "var "), ctx);
const { hoFreeName, hoMovesRow, hoCompare, hoErr, hoCell } = ctx;

{ const re = ctx.HO_ID_RE, T = require("../shell/transfer");
  const OK = ["btc_rsi", "A-1_b", "x".repeat(64), "con_2", "console", "com10", "nul2", "lpt"], BAD = ["", " ", "btc rsi", "籌碼集中度", "a]b", "a\"b", "../etc/passwd", "a/b", "a\nb", "x".repeat(65), "a.b", "con", "CON", "Nul", "aux", "prn", "com1", "LPT9"];
  t("名字閘門:好名字放行;空白、中文、路徑、超長、Windows 保留名(不分大小寫)不放", OK.every((n) => re.test(n)) && BAD.every((n) => !re.test(n)));
  t("名字閘門跟 shell/transfer.js NAME_RE 判法一致(runtime 那份由 tests/check_transfer_parity.py 比)", OK.concat(BAD).every((n) => re.test(n) === T.NAME_RE.test(n))); }
{ const A = { "Total Return [%]": 12.3, "Sharpe Ratio": 1.1, "Max Drawdown [%]": -8, Trades: 40, start: "2024-01-01", end: "2026-11-01" };
  t("並排比較:交易次數、開始、結束都相同 → match", JSON.stringify(hoCompare(A, Object.assign({}, A, { "Total Return [%]": 11 }))) === '{"state":"match","period":false}');
  t("並排比較:交易次數不同 → differs、期間沒差", JSON.stringify(hoCompare(A, Object.assign({}, A, { Trades: 41 }))) === '{"state":"differs","period":false}');
  t("並排比較:開始或結束不同 → differs 而且 period(要先講)", hoCompare(A, Object.assign({}, A, { end: "2026-10-31" })).period === true && hoCompare(A, Object.assign({}, A, { start: "2024-01-02" })).state === "differs");
  t("並排比較:目的地沒有回測 → none;來源沒有 → nosrc(不判狀態)", hoCompare(A, null).state === "none" && hoCompare(null, A).state === "nosrc");
  t("數字格:兩位小數、負號 U+2212、百分比帶 + 與 %(同回測數據)、缺值「—」、次數取整、日期原樣", hoCell("Max Drawdown [%]", -8) === "\u22128.00%" && hoCell("Total Return [%]", 12.3) === "+12.30%"
    && hoCell("Total Return [%]", 0) === "0.00%" && hoCell("Sharpe Ratio", 1.234) === "1.23" && hoCell("Sharpe Ratio", -1) === "\u22121.00" && hoCell("Sharpe Ratio", null) === "—" && hoCell("Trades", 40) === "40"
    && hoCell("start", "2024-01-01") === "2024-01-01" && hoCell("Sharpe Ratio", NaN) === "—"); }
// 機器 ack 的錯誤字串照 runtime 原文組:f"{type(e).__name__}: {e}",拒絕類別是 strategy_transfer.Refused(str 是 "<CODE>: <detail>")
const RT = path.join(__dirname, "..", "runtime"), clSrc = fs.readFileSync(path.join(RT, "command_listener.py"), "utf8"), stSrc = fs.readFileSync(path.join(RT, "strategy_transfer.py"), "utf8");
const REFUSED = /^class (\w+)\(ValueError\):\n\s+"""`CODE: detail`/m.exec(stSrc)[1];
t("ack 錯誤字串的組法還是 f\"{type(e).__name__}: {e}\"(雲端 listener 的 Deferred;本機 daemon 同一句)、Refused 的 str 是 \"CODE: detail\"",
  /err_str = f"\{type\(e\)\.__name__\}: \{e\}"/.test(clSrc) && /err = f"\{type\(e\)\.__name__\}: \{e\}"/.test(fs.readFileSync(path.join(RT, "local_daemon.py"), "utf8"))
  && /super\(\).__init__\(f"\{code\}: \{detail\}"\)/.test(stSrc) && REFUSED === "Refused");
const wire = (code, detail) => REFUSED + ": " + code + ": " + detail;
{ const E = (r) => JSON.stringify(hoErr(r));
  t("拒絕對字:機器的 ack 字串(" + wire("NOT_PORTABLE", "lib.foo") + ")取代碼與點名的檔／模組", E({ ok: false, kind: "rejected", error: wire("NOT_PORTABLE", "lib.foo") }) === '{"key":"ho.err.portable","vars":{"x":"lib.foo"}}'
    && E({ ok: false, kind: "rejected", error: wire("NAME_MISMATCH", "x") }).includes("ho.err.name") && E({ ok: false, kind: "rejected", error: wire("NO_STRATEGY_NAME", "helper.py") }).includes("ho.err.name")
    && E({ ok: false, kind: "rejected", error: wire("BAD_FILES", "a b.py") }).includes("ho.err.files") && E({ ok: false, kind: "rejected", error: "NOT_PORTABLE: lib.foo" }).includes("ho.err.portable"));
  t("這台電腦讀檔就擋下(kind local):代碼在 error、檔名在 detail", E({ ok: false, kind: "local", error: "TOO_LARGE", detail: "big.py" }) === '{"key":"ho.err.files","vars":{"x":"big.py"}}');
  t("雲端 runtime 太舊:unknown command／UNKNOWN_COMMAND／BAD_COMMAND → 更新那句,不退回 agent", ["UNKNOWN_COMMAND", "BAD_COMMAND"].every((e) => E({ ok: false, kind: "undelivered", error: e }) === '{"key":"ho.err.old"}')
    && E({ ok: false, kind: "rejected", error: "ValueError: unknown command 'strategy_import'" }) === '{"key":"ho.err.old"}' && /raise ValueError\(f"unknown command \{cmd!r\}"\)/.test(clSrc));
  t("送出了沒回條 → unknown;沒送出 → 交給 trSendError;其餘 → 稍後再試", E({ ok: false, kind: "unknown", error: "UNKNOWN_RESULT" }) === '{"key":"ho.err.unknown"}'
    && E({ ok: false, kind: "undelivered", error: "MACHINE_NOT_RUNNING" }) === '{"key":"$send"}' && E({ ok: false, kind: "rejected", error: wire("CHECK_FAILED", "crontab") }) === '{"key":"ho.err.retry"}' && E(null) === '{"key":"ho.err.retry"}');
  t("點名的字不帶換行、最多 80 字", hoErr({ ok: false, kind: "rejected", error: wire("BAD_FILES", "a\nb" + "x".repeat(200)) }).vars.x.length === 80 && !/\n/.test(hoErr({ ok: false, kind: "rejected", error: wire("BAD_FILES", "a\nb") }).vars.x)); }

{ const tk = (...xs) => (n) => xs.indexOf(n) >= 0;
  t("新名字:第一個沒被占的 _N(_2 被占 → _3)", hoFreeName("eth_ti_1h", tk("eth_ti_1h")) === "eth_ti_1h_2" && hoFreeName("eth_ti_1h", tk("eth_ti_1h", "eth_ti_1h_2")) === "eth_ti_1h_3"
    && hoFreeName("a", tk("a_2", "a_3", "a_5")) === "a_4");
  t("新名字守長度:64 字的名字從右邊截,結果仍過 HO_ID_RE", hoFreeName("x".repeat(64), tk()) === "x".repeat(62) + "_2" && ctx.HO_ID_RE.test(hoFreeName("y".repeat(64), tk("y".repeat(62) + "_2"))));
  t("新名字:壞 id 回 null", [null, "", "a b", "x".repeat(65)].every((v) => hoFreeName(v, tk()) === null)); }

// 稽核 C1:金鑰是**雙向**都搬(references/cloud-handoff.md §5),但沒用到 DATA_ 的策略 agent 會跳過那一步
{ const D = (...s2) => ({ dataSources: s2 });
  t("送上雲端 + 掃到來源 → 講金鑰並列出是哪幾個", JSON.stringify(hoMovesRow("up", D("FRED", "POLYGON"))) === JSON.stringify(["ho.row.movesKeys", { sources: "FRED、POLYGON" }]));
  t("送上雲端 + 沒掃到 → 只講程式碼(這支確定用不到)", JSON.stringify(hoMovesRow("up", D())) === JSON.stringify(["ho.row.movesV", null]) && JSON.stringify(hoMovesRow("up", {})) === JSON.stringify(["ho.row.movesV", null]));
  t("拉回 → 只講程式碼:第一版不搬金鑰(「不會搬」那列講資料來源金鑰)", JSON.stringify(hoMovesRow("down", D("FRED"))) === JSON.stringify(["ho.row.movesV", null])
    && JSON.stringify(hoMovesRow("down", null)) === JSON.stringify(["ho.row.movesV", null]) && /"ho\.row\.staysVDown": "[^"]*資料來源金鑰/.test(strings));
  t("壞 dataSources 不拋(不是陣列、列裡不是字串)", JSON.stringify(hoMovesRow("up", { dataSources: "FRED" })) === JSON.stringify(["ho.row.movesV", null])
    && JSON.stringify(hoMovesRow("up", { dataSources: [null, "", 5, "FRED"] })) === JSON.stringify(["ho.row.movesKeys", { sources: "FRED" }]) && JSON.stringify(hoMovesRow("up", null)) === JSON.stringify(["ho.row.movesV", null]));
  t("接線:up 才看 RP.data(拉回那支不在這台電腦上)", /const mv = hoMovesRow\(dir, dir === "up" \? RP\.data : null\);/.test(src));
  t("三句的內容:沒用到的不提金鑰、用到的有 {sources}、中性那句不說死", /"ho\.row\.movesV": "策略程式碼"/.test(strings) && !/"ho\.row\.movesV": "[^"]*金鑰/.test(strings)
    && /"ho\.row\.movesKeys": "[^"]*\{sources\}/.test(strings) && !/ho\.row\.movesMaybe/.test(strings)); }

// ② 掃描範圍對齊 §5 的 grep strategies/<name>/*.py(不只 strategy.py)
{ const mainSrc2 = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
  t("主行程掃資料夾內所有 .py,只回來源名、不碰值;loadStrategy 帶出 dataSources", /readdirSync\(dir\)\.filter\(\(f\) => f\.endsWith\("\.py"\)\)/.test(mainSrc2)
    && /dataSources: stratDataSources\(dir\)/.test(mainSrc2) && /out\.add\(m\[1\]\)/.test(mainSrc2) && /lstatSync\(p\)\.isFile\(\)/.test(mainSrc2));
  // 第三輪複查 6:把真的那支函式切出來跑。§5 步驟 2 明文 DATA_API_KEY / DATA_SECRET_KEY 永不搬(機器端 name_ok 拒掉),
  // 確認框列出「API、SECRET」就是講出做不到的事;判準直接用 datasrc.js 的白名單(同一條規則)
  const cutMain = (name) => { const i = mainSrc2.indexOf("function " + name + "("); let d = 0; for (let k = mainSrc2.indexOf("{", i); k < mainSrc2.length; k++) { if (mainSrc2[k] === "{") d++; else if (mainSrc2[k] === "}" && --d === 0) return mainSrc2.slice(i, k + 1); } throw new Error("no " + name); };
  const os = require("os"), stratDataSources = new Function("fs", "path", "require", "return (" + cutMain("stratDataSources") + ")")(fs, path, (m) => require(path.join(__dirname, "..", "shell", m)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blave-ho-"));
  fs.writeFileSync(path.join(dir, "strategy.py"), "import os\nDATA_API_KEY = os.environ['DATA_API_KEY']\nk = os.environ['DATA_SECRET_KEY']\nt = os.environ['DATA_POLYGON_TOKEN']\nx = os.environ['DATA_DATAX_TOKEN']\nf = os.environ['DATA_FRED_API_KEY']\n# DATA_POLYGON_TOKEN='sekretvalue'\n");
  fs.writeFileSync(path.join(dir, "leg_a.py"), "q = os.environ['DATA_QUANDL_KEY']\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "DATA_NOPE_KEY\n");
  const got = stratDataSources(dir); fs.rmSync(dir, { recursive: true, force: true });
  t("stratDataSources:DATA_API_KEY / DATA_SECRET_KEY(交易所形狀)與 DATA 開頭的來源名不列;一般來源、DATA_FRED_API_KEY(id 是 DATA_FRED)、helper 檔用到的都列;只掃 .py", JSON.stringify(got) === JSON.stringify(["FRED", "POLYGON", "QUANDL"]));
  t("回傳只有來源名,沒有值", !JSON.stringify(got).includes("sekret"));
  t("判準走 datasrc.js 的 checkName + checkField(不另抄一份規則)", /const \{ checkName, checkField \} = require\("\.\/datasrc"\);/.test(cutMain("stratDataSources")) && /if \(!checkName\(m\[1\]\) && !checkField\(m\[1\], m\[2\]\)\) out\.add\(m\[1\]\)/.test(cutMain("stratDataSources"))); }

// ── 接線(原文)──
t("功能預設關:HO.on 起手是 false,由主行程的 feature-flags 決定(renderer 自己打不開)", /^const HO = \{ on: false, pending: null, jobs: new Map\(\), cards: new Map\(\) \};/m.test(src) && /window\.blave\.featureFlags\(\)/.test(src) && /HO\.on = !!\(f && f\.cloudHandoff === true\)/.test(src) && /catch \(_\) \{ HO\.on = false; \}/.test(src));
t("頁首那顆先問 HO.on:關著就不畫;拉回還要雲端看得到現況", /const show = HO\.on && !!B\.name && HO_ID_RE\.test\(B\.name\) && hoHasCode\(B\.data\) && \(!cloud \|\| hoCloudLive\(\)\);/.test(src) && /if \(!HO\.on \|\| !HO_ID_RE\.test\(id\)\) return;/.test(src));
// Wei 09-22:上傳 / 拉回只要有程式碼就出鈕(不要求回測過——搬過去之後 agent 會在那邊重跑一次)
{ eval(src.slice(src.indexOf("function hoHasCode("), src.indexOf("\n", src.indexOf("function hoHasCode("))));
  t("有程式碼就出鈕:沒有 stats 也算;空白程式碼 / 沒資料不算", hoHasCode({ code: "x = 1", stats: null }) === true && hoHasCode({ code: "  \n" }) === false && hoHasCode(null) === false && hoHasCode({ stats: {} }) === false); }
t("hoAsk 的順序(規格 §2;0.1.37 起回合中不再擋,另開分頁送):別的框開著 / 選字中 → 不動作;雲端沒在運行 → 切過去不開框", (() => {
  const i = src.indexOf("function hoAsk("), body = src.slice(i, src.indexOf("\n}", i)).replace(/\/\/.*$/gm, "");
  const o = (re) => body.search(re);
  return o(/typeof running/) < 0 && o(/envCanSwitch\(\)/) > 0 && o(/envSwitchGuarded\("cloud"\)\) HO\.pending = \{ id \};/) > o(/envCanSwitch\(\)/) && o(/confirmBox\(\{/) > o(/envSwitchGuarded\("cloud"\)\) HO\.pending = \{ id \};/); })());
t("雲端沒在運行的六種都走同一條(envCloudKind 不是 running,或逾 1 小時沒同步)", /function hoCloudLive\(\) \{ const st = TR_BAGS\.cloud\.st; return envCloudKind\(st\) === "running" && envHeadState\(st, Date\.now\(\)\) !== "unknown"; \}/.test(src));
t("按確認 = app 直接搬(hoRun → transferUp／transferDown):不送話給 agent、不碰輸入框的草稿、不展開聊天欄", /hoRun\(dir, id, to, tb === "B", /.test(src)
  && /window\.blave\.transferUp\(id, to\)/.test(src) && /window\.blave\.transferDown\(id, to\)/.test(src) && !/\$\("ta"\)|csSendAway|submitMessage\(|paneToggle\(/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
// 設計稽核必修 1:spPaintNote(主鈕原因句)會清那一格,搬家那一行要在 hoPaint 的兩個出口都最後畫
{ const hp = cutFn("hoPaint"), sp = hp.indexOf("spPaintNote(");
  t("進度畫在來源那一支的頁:hoPaint 兩個出口都在 spPaintNote 之後才畫搬家那一行(優先序 搬家 ＞ 原因句 ＞ 停機句)", sp > 0
    && hp.indexOf("hoJobPaint();", sp) > sp && /if \(act\.hidden\) \{ hoJobPaint\(\); if \(had\)/.test(hp) && hp.lastIndexOf("hoJobPaint();") > hp.indexOf("hoBusy();")
    && hp.indexOf("hoJobPaint") > sp && /HO\.jobs\.get\(\(cloud \? "down" : "up"\) \+ ":" \+ B\.name\)/.test(src)
    && /if \(key && hoJobOwns\(\)\) \{ srSay\(t\(key\)\); return; \}/.test(cutFn("hoNote"))); }
{ const D = (s2, m) => ({ dataSources: s2, missingSources: m });
  t("確認框:這台電腦沒有的金鑰不列在「會搬」,改列在「不會搬」(設計稽核必修 2)", JSON.stringify(hoMovesRow("up", D(["FRED", "FINMIND"], ["FINMIND"]))) === JSON.stringify(["ho.row.movesKeys", { sources: "FRED" }])
    && JSON.stringify(hoMovesRow("up", D(["FINMIND"], ["FINMIND"]))) === JSON.stringify(["ho.row.movesV", null])
    && JSON.stringify(ctx.hoStaysRow("up", D(["FINMIND"], ["FINMIND"]))) === JSON.stringify(["ho.row.staysVMissing", { sources: "FINMIND" }])
    && JSON.stringify(ctx.hoStaysRow("up", D(["FRED"], []))) === JSON.stringify(["ho.row.staysV", null]) && JSON.stringify(ctx.hoStaysRow("down", null)) === JSON.stringify(["ho.row.staysVDown", null])
    && /"ho\.row\.staysVMissing": "[^"]*\{sources\} 的金鑰（這台電腦沒有）"/.test(strings)); }
t("agent 正在回覆:兩顆鈕是 aria-disabled(鍵盤停得上去、讀屏唸得到原因),不是原生 disabled", /b\.setAttribute\("aria-disabled", "true"\)/.test(src) && /b\.title = t\("turn\.busy"\)/.test(src) && !/\.disabled = true/.test(src));
t("上鎖 / 解鎖的同一處叫 hoBusy(turnUiSync 裡;app.js 三個出口都叫 turnUiSync)", /hoBusy\(\);/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "chattabs.js"), "utf8")) && (appSrc.match(/turnUiSync\(\)/g) || []).length >= 3);
t("畫面只走 textContent / DOM,沒有 innerHTML", !/innerHTML/.test(src));

// 目的地有沒有同名:拉回看本機清單(完整),送上雲端看雲端回報的索引——那份索引不保證涵蓋全部,所以找不到時不說「不會覆蓋」
t("目的地占用:清單(送上雲端 = 雲端索引,拉回 = 本機清單)或下單設定有這個名字;雲端索引沒看到 → null(中性那句),本機清單是完整的 → false", /const names = \(dir === "up" \? envCloudList\(destSt\) : RP\.list\)\.map\(\(x\) => x\.name\);/.test(src)
  && /const taken = \(n\) => names\.indexOf\(n\) >= 0 \|\| cdelInUse\(destCfg, n\) === true;/.test(src) && /const destHas = taken\(id\) \? true : dir === "up" \? null : false;/.test(src)
  && /const destSt = dir === "up" \? TR_BAGS\.cloud\.st : TR_BAGS\.local\.st;/.test(src));

/* ── 未登入按「送上雲端」→ 被切到雲端 → 登入完成 → 中欄不放行,換成「準備好了」卡 ──
   承重牆:hoPendingId() **不可以再讀 RP.name**。人在雲端等的時候本機那一邊會自己動(一輪 agent 回覆結束
   stratRefresh(true) 會 stratSelect(touched.name)),在這裡判 RP.name 就會把卡偶發地拆掉。 */
{ const run = (ho, rp) => { const c = { HO: ho, RP: rp }; vm.createContext(c); vm.runInContext(cutFn("hoPendingId"), c); return [c.hoPendingId(), c.HO.pending]; };
  t("記住的那一支:報告頁還開著同一支 → 卡出得來", JSON.stringify(run({ on: true, pending: { id: "btc_rsi" } }, { name: "btc_rsi" })) === JSON.stringify(["btc_rsi", { id: "btc_rsi" }]));
  t("沒按過「送上雲端」→ 沒有卡", JSON.stringify(run({ on: true, pending: null }, { name: "btc_rsi" })) === JSON.stringify([null, null]));
  t("在雲端等的時候 agent 動到別支(RP.name 被換掉)→ 意圖**不可以**被清掉,卡照出、記的還是原本那一支",
    JSON.stringify(run({ on: true, pending: { id: "btc_rsi" } }, { name: "eth_ma" })) === JSON.stringify(["btc_rsi", { id: "btc_rsi" }])
    && JSON.stringify(run({ on: true, pending: { id: "btc_rsi" } }, { name: null })) === JSON.stringify(["btc_rsi", { id: "btc_rsi" }]));
  t("hoPendingId 的原文裡沒有 RP(承重牆:那一判已經移到按主鈕那一刻)", !/\bRP\b/.test(cutFn("hoPendingId")));
  t("功能關著 → 卡不出", run({ on: false, pending: { id: "btc_rsi" } }, { name: "btc_rsi" })[0] === null); }
t("意圖只在記憶體:不寫 localStorage / sessionStorage(重開 app 一律回這台電腦)", !/Storage/.test(src));
t("切完才記下要送哪一支(envSwitch 會清 pending,先記會被洗掉);記的是 hoPaint 給的那一支(B.name);切不成就不記", /if \(envSwitchGuarded\("cloud"\)\) HO\.pending = \{ id \};/.test(src)
  && /b\.dataset\.id = B\.name;/.test(src) && /hoAsk\(b\.dataset\.dir, b\.dataset\.id, b\); \}\);/.test(src));
t("框真的開得起來就清掉(按確認送出也走這條);handoff.js 裡清的地方只有 hoAsk 與 hoStay", /if \(dir === "up"\) \{ HO\.pending = null; hoNote\(null\); \}/.test(src)
  && (src.match(/HO\.pending = (null|\{)/g) || []).length === 3 && src.indexOf('if (dir === "up") { HO.pending = null;') < src.indexOf("confirmBox({"));
// 承重牆①(設計 eval:四條清除條件都要):人自己切視角(切換器 / ⌘1⌘2 / 選單)也要清——沒有 TTL,少了這條殘留無上限。
// 收斂點是 envSwitch:三個入口都經過它,而且要排在「本來就在這一邊」那個早退之後(原地不動不算放棄意圖)
t("人自己切視角就清掉:收斂在 envSwitch 一處,排在「本來就在這一邊」的早退之後", (() => {
  const i = trSrc.indexOf("function envSwitch(env, via) {"), body = trSrc.slice(i, trSrc.indexOf("\n}", i));
  return i > 0 && /if \(typeof HO !== "undefined"\) HO\.pending = null;/.test(body)
    && body.indexOf("HO.pending = null;") > body.indexOf('if (env === ENV.cur) { if (via === "link") head(); return; }')
    && (trSrc.match(/HO\.pending/g) || []).length === 1; })());
t("「準備好了」卡的主鈕:守門同切換器那一份 → envSwitch(\"local\", \"link\") → 那支還在才 stratSelect(鈕上寫哪一支就落在哪一支)→ 焦點給 #rp-ho(切完、選完才取節點);不自動切視角、不自動開框", (() => {
  const back = cutFn("hoBack"), o = (re) => back.search(re);
  return /async function hoBack\(id\)/.test(src) && o(/if \(!envCanSwitch\(\)\) return;/) > 0
    && o(/const has = typeof RP !== "undefined" && RP\.list\.some\(\(x\) => x\.name === id\);/) > o(/if \(!envCanSwitch\(\)\) return;/)
    && o(/envSwitch\("local", "link"\);/) > o(/const has = /) && o(/if \(!has\) \{/) > o(/envSwitch\("local", "link"\);/)
    && o(/if \(RP\.name !== id\) await stratSelect\(id\);/) > o(/if \(!has\) \{/)
    && o(/const up = \$\("rp-ho"\); if \(up && up\.offsetParent\) up\.focus\(\);/) > o(/await stratSelect\(id\);/)
    && !/confirmBox|hoAsk/.test(back.replace(/\/\/.*$/gm, "")) && (src.match(/[^\w]envSwitch\(/g) || []).length === 1
    // 選單列、對話卡(hoGo)與結果句的〔到…看〕(hoGoDest)切視角走守門那一支(envSwitchGuarded),組字中、別的框開著不切
    && /envSwitchGuarded\("local"\)/.test(cutFn("hoGo")) && /envSwitchGuarded\("cloud"\)/.test(cutFn("hoGoDest")); })());
// 焦點:那顆鈕連同整張卡會被藏起來(gate 翻 false),重畫完成之後要有人接住焦點,不然掉回 body
t("次要出口［留在雲端］:清掉意圖 → 立刻重畫 → 焦點交給落地那一頁的標題;清的地方在 handoff.js,不散到 trade.js", (() => {
  const st = cutFn("hoStay"), o = (re) => st.search(re);
  return o(/HO\.pending = null;/) > 0 && o(/trPaint\(\);/) > o(/HO\.pending = null;/)
    && o(/const h = \$\("tr-h"\); if \(h && h\.offsetParent\) h\.focus\(\);/) > o(/trPaint\(\);/)
    && /t\("ho\.ready\.stay"\), \(\) => \{ hoStay\(\); after\(\); \}, "stay"\)/.test(trSrc) && (trSrc.match(/HO\.pending/g) || []).length === 1; })());
// spec §2-2 / §8:那支在雲端等的時候被刪掉 → 焦點在中欄標題。envSwitch 的 head() 只認 #tr-h / #cv-h,
// 中欄是策略報告頁時兩顆都藏著,所以 hoBack 自己給 #rp-name(它要有 tabindex 才 focus 得上去)
t("那支被刪了:切回這台電腦、不報錯,焦點給中欄標題 #rp-name(有 tabindex=\"-1\")", /<h5 class="rp-name" id="rp-name" tabindex="-1"><\/h5>/.test(html)
  && /if \(!has\) \{ const h = \$\("rp-name"\); if \(h && h\.offsetParent\) h\.focus\(\); return; \}/.test(src));
// 那一行講的是「你剛才按的那一次」,不是現況:離開這台電腦又回來時不可以還掛在頁首
t("報告頁首那一行:切回這台電腦時收掉", /if \(env === "local" && typeof hoNote === "function"\) hoNote\(null\);/.test(trSrc));
t("側欄那一格整段刪掉(hoPendingCell / .ho-back / ho.back.hint 都不存在;envPaintSide 不再碰 pid)", !/hoPendingCell|ho-back|ho\.back\.hint/.test(src + trSrc + html + strings)
  && !/\bpid\b/.test((() => { const i = trSrc.indexOf("function envPaintSide("); return trSrc.slice(i, trSrc.indexOf("\n}", i)); })())
  && /if \(!list\.length\) \{ box\.appendChild\(trEl\("p", "pf-state", ho \? t\("ho\.emptyHint"\)/.test(trSrc));
/* ⚠️ 承重牆:gate 用 kind === "running" 判,**不可以**用 hoCloudLive()——後者多要求「1 小時內同步過」,
   「running 但讀不到」那一態卡就不出了,人照樣掉在自動下單頁(規格 §2 說這是最容易寫錯的一格) */
t("gate 多守一格:雲端 running 而且還有一支在等 → 中欄留在 #cv-empty;判準是 kind === \"running\",不是 hoCloudLive()", (() => {
  const i = trSrc.indexOf("function envPaint()"), body = trSrc.slice(i, trSrc.indexOf("\n}", i)).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  return /const ready = cloud && kind === "running" && !!pid;/.test(body)
    && /const gate = \(cloud && kind !== "running" && kind !== "stopped"\) \|\| ready;/.test(body)
    && /const pid = typeof hoPendingId === "function" \? hoPendingId\(\) : null;/.test(body) && !/hoCloudLive/.test(body); })());
t("那一態側欄出 side.cloud.emptyReady,其餘狀態整句不出(emptyGate 已刪);走 dataset.i18n,換語言時才不會被 applyI18n 還原",
  /const sg = \$\("side-gate"\); sg\.hidden = !ready;/.test(trSrc)
  && /if \(ready && sg\.dataset\.i18n !== "side\.cloud\.emptyReady"\) \{ sg\.dataset\.i18n = "side\.cloud\.emptyReady"; sg\.textContent = t\("side\.cloud\.emptyReady"\); \}/.test(trSrc)
  && /"side\.cloud\.emptyReady":/.test(strings) && !/emptyGate/.test(trSrc + strings));
t("那張卡:不畫賣點與價格、主鈕 data-k=\"main\"(登入回來焦點正好在它身上)、次鈕是［留在雲端］", (() => {
  const i = trSrc.indexOf("function envPaintEmpty("), ep = trSrc.slice(i, trSrc.indexOf("\n}\n", i));
  return /const ready = kind === "running" && !!pid;/.test(ep) && /view = ready \? "ready" : envOpenView\(/.test(ep)
    && /if \(view === "ready"\) st\.append\(trEl\("h4", "", t\("ho\.ready\.h"\)\), trEl\("p", "", t\("ho\.ready\.body", \{ id: pid \}\)\)\);/.test(ep)
    && !/view === "ready"[^\n]*env\.open\.h/.test(ep) && /\["starting", "unreach", "unknown", "relogin", "ready"\]\.includes\(view\)/.test(ep)
    && /main = btn\("btn-fill", t\("ho\.back\.btn"\), \(\) => hoBack\(pid\), "main"\)/.test(ep)
    && /\|\| view === "ready" \? null : planErr/.test(ep) && /JSON\.stringify\(\[view, pid \|\| null,/.test(ep); })());
/* 不可以繞回同一張卡:停機 / 「running 但讀不到」兩態**不切視角**、也不記 pending,在報告頁原地講一句。
   少了它會有迴圈——切過去 → 記 pending → gate 又開 → 又是那張卡,按幾次都一樣 */
t("停機 / 讀不到:不切視角、不記 pending,改在報告頁首出一行(排在 envSwitchGuardedcloud 之前,否則還是會切過去)", (() => {
  const i = src.indexOf("function hoAsk("), body = src.slice(i, src.indexOf("\n}", i)).replace(/\/\/.*$/gm, "");
  return /if \(kind === "running" \|\| kind === "stopped"\) \{ hoNote\(kind === "running" \? "ho\.gate\.stale" : "ho\.gate\.stopped"\); return; \}/.test(body)
    && body.indexOf("hoNote(kind ===") < body.indexOf('envSwitchGuarded("cloud")')
    && /const kind = envCloudKind\(TR_BAGS\.cloud\.st\);/.test(body); })());
t("那一行:#rp-desc 下面、不切視角、鈕字沿用既有的「去雲端看」;按了那顆鈕不記 pending(記了就會繞回卡);role=status(按了鈕畫面只多這一行)", (() => {
  const n = cutFn("hoNote");
  return /<p class="rp-ho-note" id="rp-ho-note" role="status" hidden><\/p>/.test(html) && html.indexOf('id="rp-ho-note"') > html.indexOf('id="rp-desc"')
    && /b\.textContent = t\("ho\.block\.goCloud"\);/.test(n) && /hoNote\(null\); envSwitchGuarded\("cloud"\);/.test(n) && !/HO\.pending/.test(n)
    && /\.rp-ho-note \.btn-quiet \{ font-size: inherit; \}/.test(css); })());
t("那一行不留在別支策略的頁首:換策略重畫頁首時清掉", /hoNote\(null\);\s+\/\/ 換了策略/.test(src) && src.indexOf("function hoPaint(") > 0 && src.indexOf("hoNote(null)", src.indexOf("function hoPaint(")) > src.indexOf("function hoPaint(")
  && src.indexOf("hoNote(null)", src.indexOf("function hoPaint(")) < src.indexOf("\n}", src.indexOf("function hoPaint(")));

t("index.html:載入 handoff.js;報告頁首分成 .txt / .act 兩塊(鈕不畫時 .act 藏起來,頁首高度不跳)", /<script src="handoff\.js"><\/script>/.test(html) && /<div class="act" id="rp-act" hidden><\/div>/.test(html) && /<div class="txt">/.test(html));
t("app.css:icon + 字的描邊鈕、確認框的兩欄變體;列尾的「拉回」退場(.ho-down 家族清掉)", /\.btn-out\.has-ic \{ display: inline-flex;/.test(css) && !/\.ho-down/.test(css)
  && /\.cf-rows\.kv dt \{ flex: 0 0 56px;/.test(css) && /:lang\(en\) \.cf-rows\.kv dt \{ flex-basis: 84px; \}/.test(css));
// 列現在是鈕(點了畫雲端那支的報告),鈕不能包鈕:「拉回」掛在同一個 wrap 裡、不在列裡
t("trade.js:雲端清單列尾是刪除鈕(在 wrap 裡,不在鈕裡;跟 HO 無關)、拉回搬到頁首;空態換成新的那一句", /const d = armedDelete\(wrap, t\("cdel\.aria"[^\n]*\n[^\n]*wrap\.appendChild\(d\);/.test(trSrc) && !/hoDownBtn/.test(trSrc + src)
  && /ho \? t\("ho\.emptyHint"\) : t\("side\.cloud\.emptyCut1"\)/.test(trSrc) && /const ho = typeof HO !== "undefined" && HO\.on && typeof hoCloudLive === "function" && hoCloudLive\(\);/.test(trSrc));
// A′:輸入框上方「操作對象」那行已整列拿掉(tests/check_shell_envsw.js 釘);「agent 還不能操作雲端主機」那句已刪
t("trade.js:envPaint 不再看 HO.on;chat.tgt.cut1 從程式、DOM、字串表全部消失", !/HO\.on\)/.test(trSrc.slice(trSrc.indexOf("function envPaint("), trSrc.indexOf("function envPaintSide(")))
  && !/chat\.tgt\.cut1/.test(trSrc + html + strings));
t("重畫:雲端清單的 sig 把 ho、能不能刪、選中的那支、刪除中的那幾支算進去", /JSON\.stringify\(\[kind, ho, canDel, sel, \[\.\.\.CDEL\.busy\.keys\(\)\], prefs\.flags, prefs\.groups, list\.map/.test(trSrc));
t("字串 zh / en 都齊(ho.* key),而且訊息那兩句與提示各只有一個 {id}", (() => {
  const keys = ["up.btn", "down.btn", "down.aria", "up.title", "down.title", "row.moves", "row.movesV", "row.movesKeys", "row.stays", "row.staysV", "row.staysVDown", "rename.up", "rename.down", "rename.maybeUp", "srcLive.up", "srcLive.down", "block.goCloud", "note.up", "note.down", "ok.up", "ok.down", "emptyHint", "back.btn", "ready.h", "ready.body", "ready.stay", "gate.stale", "gate.stopped",
    "p.send.up", "p.run.up", "p.trial.down", "done.match", "done.differs", "done.period", "done.nosrc", "cmp.noise", "at.up", "at.down", "err.old", "err.unknown", "card.up", "card.down", "menu.down"];
  return keys.every((k) => (strings.match(new RegExp('"ho\\.' + k.replace(/\./g, "\\.") + '":', "g")) || []).length === 2)
    && (strings.match(/"ho\.ready\.body": "[^"]*"/g) || []).every((l) => l.split("{id}").length === 2)
    && (strings.match(/"ho\.rename\.(up|down)": "[^"]*"/g) || []).length === 4
    && (strings.match(/"ho\.rename\.(up|down)": "[^"]*"/g) || []).every((l) => l.split("{to}").length === 2)
    && !/"ho\.msg/.test(strings); })());
t("確認框那句依方向拆:up 講「在雲端重跑一次回測」、down 講「在這台電腦重跑」;舊的 ho.note 退場",
  /extra\.appendChild\(mk\("p", "cf-note", t\(HO_NOTE\[tb\]\[dir === "up" \? 0 : 1\]\)\)\);/.test(src) && !/"ho\.note":/.test(strings)
  && /"ho\.note\.up": "[^"]*在雲端重跑一次回測/.test(strings) && /"ho\.note\.down": "[^"]*在這台電腦重跑一次回測/.test(strings));
// 真的跑 hoAsk(假 DOM + 假 confirmBox),看框裡放了什麼、按確認送出哪一句。
// 來源在下單設定裡(判準同雲端刪除 cdelInUse,金額 0 也算):Wei 09-27 起照樣能搬,多一句「那邊照常下單、這份要給金額」。
// 目的地同名(清單有、或下單設定有):Wei 09-28 起不擋、不覆蓋,一律提議存成第一個沒被占的 <id>_N,送出去的那句帶這個名字。
{ const cut = (s, name) => { const i = s.indexOf("function " + name + "("); return s.slice(i, s.indexOf("\n}\n", i) + 3); };
  const el = () => { const n = { kids: [], textContent: "", className: "", append(...x) { n.kids.push(...x); }, appendChild(x) { n.kids.push(x); return x; } }; return n; };
  const texts = (n) => (n && typeof n === "object" ? [n.textContent || "", ...(n.kids || []).flatMap(texts)] : []);
  const xpSrc = fs.readFileSync(path.join(R, "export.js"), "utf8");
  const run = (dir, cloudCfg, localCfg, cloudList = [], localList = [], code = null) => {
    const boxes = [], runs = [];
    const c = { HO: { on: true, pending: null, jobs: new Map() }, HO_ID_RE: /^[A-Za-z0-9_-]{1,64}$/, running: false, ENV: { cur: dir === "up" ? "local" : "cloud" },
      envCanSwitch: () => true, hoCloudLive: () => true, envCloudKind: () => "running", hoNote: () => {}, envSwitchGuarded: () => true,
      TR_BAGS: { cloud: { st: { report: { config: cloudCfg } } }, local: { st: { report: { config: localCfg } } } },
      t: (k, v) => k + (v ? JSON.stringify(v) : ""), confirmBox: (o) => boxes.push(o), $: () => ({}), document: { createElement: el, createDocumentFragment: el },
      envCloudList: () => cloudList, RP: { name: "btc_rsi", list: localList, data: dir === "up" && code ? { code } : null }, RPC: { name: "btc_rsi", data: dir === "down" && code ? { code } : null }, LANG: "zh",
      HO_NOTE: { "": ["ho.note.up", "ho.note.down"], B: ["ho.noteB.up", "ho.noteB.down"] },
      hoRun: (d, id, to, typeB) => runs.push({ dir: d, id, to, typeB }), UPD: {}, csTabRunning: () => false, trackFeature: () => {} };
    vm.createContext(c);
    vm.runInContext(["hoMovesRow", "hoStaysRow", "hoFreeName", "hoKind", "hoBlocked", "hoAsk"].map((n) => cut(src, n)).join("\n") + cut(trSrc, "cdelInUse")
      + xpSrc.slice(xpSrc.indexOf("function xpIsTypeB("), xpSrc.indexOf("\n", xpSrc.indexOf("function xpIsTypeB("))), c);
    c.hoAsk(dir, "btc_rsi", {});
    const b = boxes[0]; if (!b) return null;
    b.onOk();
    return { single: !!b.single, ok: b.ok, dis: !!b.okDisabled, alt: b.alt, txt: texts(b.extra).join("|"), run: runs[0] };
  };
  // e2e 0.1.8 H:Type B 沒有回測——確認框不提回測;判別用檔頭 `# Type: B`(同轉出選單),結果畫成試跑那幾句。
  // 字講「確認它跑得起來」,不講「試跑一次」:會下單的 Type B 不試跑、只檢查(references/cloud-handoff.md 1.3、6B),現在式的承諾要對每一種都成立
  { const B = "# Strategy: 資金費率監控\n# Type:     B (monitor only, no orders)\nSTRATEGY_NAME = 'w'\n", A = "# Strategy: x\n# Type:     A\n";
    let b = run("up", {}, {}, [], [], B);
    t("Type B 送上雲端:框裡是 ho.noteB.up(沒有 ho.note.up)、直接指令標成 Type B", /ho\.noteB\.up/.test(b.txt) && !/ho\.note\.up/.test(b.txt) && b.run.dir === "up" && b.run.to === "btc_rsi" && b.run.typeB === true, JSON.stringify(b));
    b = run("down", {}, {}, [], [], B);
    t("Type B 拉回:ho.noteB.down、標成 Type B", /ho\.noteB\.down/.test(b.txt) && b.run.dir === "down" && b.run.typeB === true, JSON.stringify(b));
    b = run("up", {}, {}, [], [], A);
    t("Type A / 判不出來:照舊講回測那一句,不標 Type B", /ho\.note\.up/.test(b.txt) && !/noteB/.test(b.txt) && b.run.typeB === false && run("up", {}, {}).run.typeB === false, JSON.stringify(b));
    { const S2 = new Function(strings + "; return STRINGS;")();
      t("字串:確認框的 Type B 兩句逐字,兩語都不講「試跑 / run it once」、不再說由 agent 做", [
        ["zh", "ho.noteB.up", "會在雲端確認它跑得起來。"],
        ["zh", "ho.noteB.down", "會在這台電腦確認它跑得起來。"],
        ["en", "ho.noteB.up", "It checks that it starts on your cloud machine."],
        ["en", "ho.noteB.down", "It checks that it starts on this computer."],
      ].every((x) => S2[x[0]][x[1]] === x[2] && !/試跑|run it once|runs it once|agent/i.test(S2[x[0]][x[1]]))); }
    t("字串:Type B 兩句 zh / en 都在、都不提回測", ["noteB.up", "noteB.down"].every((k) => { const m = strings.match(new RegExp('"ho\\.' + k.replace(".", "\\.") + '": "([^"]*)"', "g")) || [];
      return m.length === 2 && m.every((l) => !/回測|backtest/i.test(l)); }));
  }
  const sendable = (r) => r && !r.single && /^ho\.ok\.(up|down)$/.test(r.ok) && !r.dis && !r.alt && /ho\.row\.moves/.test(r.txt) && /ho\.note\./.test(r.txt);
  let r = run("up", {}, { amounts: { btc_rsi: 5000 } });
  t("送上雲端:這台電腦的下單設定有這支 → 框照常可送出,多一句 ho.srcLive.up", sendable(r) && /ho\.srcLive\.up/.test(r.txt) && !/srcLive\.down/.test(r.txt));
  r = run("down", { amounts: { btc_rsi: 0 } }, {});
  t("拉回:雲端的 amounts 有這支(金額 0 也算)→ 照常可送出,多一句 ho.srcLive.down", sendable(r) && /ho\.srcLive\.down/.test(r.txt));
  t("在 weights 或 exchanges 裡也算", /srcLive\.down/.test(run("down", { weights: { btc_rsi: 0.5 } }, {}).txt) && /srcLive\.up/.test(run("up", {}, { exchanges: { btc_rsi: "okx" } }).txt));
  r = run("down", null, {});
  t("來源設定讀不到(null)→ 一般的框,不多那一句", sendable(r) && !/srcLive/.test(r.txt));
  r = run("up", {}, { amounts: { eth_ma: 1000 } });
  t("別支在下單設定裡 → 這支不多那一句", sendable(r) && !/srcLive/.test(r.txt));
  // 目的地同名 → 改存新名字(不擋、不覆蓋)
  r = run("up", { amounts: { btc_rsi: 300 } }, { amounts: { btc_rsi: 5000 } }, [{ name: "btc_rsi" }, { name: "btc_rsi_2" }]);
  t("送上雲端:雲端有 btc_rsi 且在下單、btc_rsi_2 也被占 → 框可送出,那一行講存成 btc_rsi_3;來源那句照出", sendable(r)
    && r.txt.includes('ho.rename.up{"id":"btc_rsi","to":"btc_rsi_3"}') && /ho\.srcLive\.up/.test(r.txt));
  t("直接指令帶目標名 btc_rsi_3", r.run.to === "btc_rsi_3");
  r = run("up", { weights: { btc_rsi_2: 0.5 } }, {}, [{ name: "btc_rsi" }]);
  t("雲端下單設定裡掛著的名字(資料夾不在清單)也算被占 → btc_rsi_3", sendable(r) && r.txt.includes('"to":"btc_rsi_3"') && r.run.to === "btc_rsi_3");
  r = run("down", {}, { exchanges: { btc_rsi: "okx" } });
  t("拉回:這台電腦的下單設定有 btc_rsi(清單沒有)→ ho.rename.down 存成 btc_rsi_2", sendable(r) && r.txt.includes('ho.rename.down{"id":"btc_rsi","to":"btc_rsi_2"}') && r.run.to === "btc_rsi_2");
  r = run("down", {}, {}, [], [{ name: "btc_rsi" }]);
  t("拉回:這台電腦清單有同名 → 存成 btc_rsi_2", sendable(r) && r.txt.includes('"to":"btc_rsi_2"'));
  r = run("up", {}, {});
  t("送上雲端、雲端清單沒看到 → 中性那句,目標名照原名(由機器實查定案,被佔就 _N)", sendable(r) && /ho\.rename\.maybeUp/.test(r.txt) && !/ho\.rename\.up/.test(r.txt) && r.run.to === "btc_rsi");
  r = run("down", {}, {});
  t("拉回、這台電腦沒有同名 → 沒有改名那一行,原名送出", sendable(r) && !/ho\.rename/.test(r.txt) && r.run.to === "btc_rsi");
  t("擋下態與覆蓋態整段退場(程式與字串表都沒有 ho.block.up/down、ho.over.*、goLocal、hoState、okDisabled、alt)", !/ho\.block\.(up|down)"|ho\.over\.|goLocal/.test(strings) && !/ho\.block\.(up|down)\b|ho\.over\.|goLocal|hoState|hoAmount|okDisabled|alt:/.test(src));
  t("改名那幾句的字", /"ho\.rename\.up": "雲端已經有同名的 \{id\}，這份會存成新策略 \{to\}；原本那支不動。"/.test(strings) && /"ho\.rename\.down": "這台電腦已經有同名的 \{id\}，這份會存成新策略 \{to\}；原本那支不動。"/.test(strings)
    && /"ho\.rename\.maybeUp": "若雲端已有同名策略，會改存成新名字，原本那支不動。"/.test(strings));
  t("舊的來源擋下態整段退場(ho.block.srcUp / srcDown 不在程式與字串表)", !/ho\.block\.src/.test(src + strings));
  t("那一句的字:兩個方向都講「照常下單」與「給金額才會開始下單」", ["up", "down"].every((d) => (strings.match(new RegExp('"ho\\.srcLive\\.' + d + '": "[^"]*"', "g")) || []).length === 2)
    && /"ho\.srcLive\.up": "這台電腦這一支照常下單；雲端那份[^"]*給金額，才會開始下單。"/.test(strings) && /"ho\.srcLive\.down": "雲端那一支照常下單；[^"]*給金額，才會開始下單。"/.test(strings));
  // 0.1.12 市場檢查出貨前整個拿掉:送上雲端 / 拉回不看市場(美股不在這裡擋,也不多那一行「對不上」)
  t("送上雲端 / 拉回不看市場:handoff.js 沒有 trGateOf / market_gate / ho.gate.usstock / ho.gate.mismatch;字串表也沒有那三句",
    !/trGateOf|market_gate|ho\.gate\.(usstock|mismatch)/.test(src) && !/ho\.gate\.(usstock|mismatch)/.test(strings)); }
// ── 直接搬的流程(hoRun → hoPoll → hoJobPaint):假 IPC、假 DOM、計時器立刻到 ──
(async () => {
  const el = (tag) => { let txt = ""; const n = { tag, kids: [], dataset: {}, hidden: true, writes: 0, attrs: {}, classList: { remove() {}, add() {} }, listeners: [],
    get textContent() { return txt + n.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); },
    set textContent(v) { txt = v; n.kids = []; n.writes++; },
    setAttribute(k, v) { n.attrs[k] = String(v); }, getAttribute(k) { return n.attrs[k]; }, addEventListener(_e, f) { n.listeners.push(f); }, click() { n.listeners.forEach((f) => f()); },
    append(...x) { n.kids.push(...x); }, appendChild(x) { n.kids.push(x); return x; },
    querySelector(q) { const all = (m) => m.kids.flatMap((k) => (typeof k === "object" ? [k, ...all(k)] : []));
      if (q === ".spin16") return all(n).find((k) => k.className === "spin16") || null;
      const m = /^\[data-k="(\w+)"\]$/.exec(q); return m ? all(n).find((k) => k.dataset && k.dataset.k === m[1]) || null : null; } };
    Object.defineProperty(n, "className", { value: "", writable: true }); return n; };
  const btns = (n) => n.kids.filter((k) => typeof k === "object" && k.tag === "button").map((k) => k.textContent);
  const flow = async ({ dir = "up", ack, polls = [], typeB = false, src = null }) => {
    const note = el("p"), acts = el("div"), cmp = el("div"), feats = [], polled = [];
    const c = { HO: { on: true, pending: null, jobs: new Map(), cards: new Map() }, HO_ID_RE: ctx.HO_ID_RE, ENV: { cur: dir === "up" ? "local" : "cloud" }, RP: { name: "momo", list: [] }, RPC: { name: "momo" },
      $: (id) => ({ "rp-ho-note": note, "rp-ho-acts": acts, "rp-ho-cmp": cmp })[id] || null, document: { createElement: el }, t: (k, v) => k + (v ? JSON.stringify(v) : ""), LANG: "zh", trackFeature: (f) => feats.push(f),
      stratRefresh: () => {}, setTimeout: (fn) => setImmediate(fn), trSendError: () => "SEND", hasData: () => false, hasToken: false, acct: null, rpGoDataSrc: () => {}, hoGoDest: () => {},
      window: { blave: { transferUp: async () => ack, transferDown: async () => ack,
        cloudStrategy: async () => { polled.push(1); return { code: "OK", strategy: polls.length ? polls.shift() : null }; },
        loadStrategy: async () => { polled.push(1); return polls.length ? polls.shift() : null; } } } };
    c.Date = Date;
    vm.createContext(c);
    vm.runInContext(block.replace(/^const /gm, "var ") + "\n" + ["hoRun", "hoPoll", "hoJobOwns", "hoJobView", "hoJobPaint", "hoCmpTable"].map((n) => (n === "hoRun" || n === "hoPoll" ? "async " : "") + cutFn(n)).join("\n")
      + "\n" + src_consts, c);
    await c.hoRun(dir, "momo", "momo_2", typeB, src);
    for (let i = 0; i < 20 && ["run", "send"].includes((c.HO.jobs.get(dir + ":momo") || {}).phase); i++) await new Promise((r) => setImmediate(r));
    return { c, note, acts, cmp, job: c.HO.jobs.get(dir + ":momo"), txt: note.textContent, btns: btns(acts), feats, polled: polled.length };
  };
  const src_consts = ["HO_POLL_MS", "HO_K", "HO_WHY", "HO_DONE"].map((n) => { const i = src.indexOf("const " + n + " = "); let d = 0, k = src.indexOf("=", i) + 1;
    for (; k < src.length; k++) { const ch = src[k]; if ("{[(".includes(ch)) d++; else if ("}])".includes(ch)) d--; else if (ch === ";" && d === 0) break; } return "var " + src.slice(i + 6, k + 1); }).join("\n");
  const S = { "Total Return [%]": 10, "Sharpe Ratio": 1, "Max Drawdown [%]": -5, Trades: 30, start: "2024-01-01", end: "2026-11-01" };
  let f = await flow({ ack: { ok: true, result: { dest: "momo_2", run: "backtest", type: "A" }, missing: [] },
    polls: [null, { transfer: { kind: "backtest", status: "running" } }, { stats: Object.assign({}, S, { "Total Return [%]": 9 }) }], src: { stats: S } });
  t("送上雲端:ack 成功記 handoff_cloud → 等到雲端回測跑完(先 null、再 running)→ done;一致時一句(存到哪＋結論),不帶「資料來源不同」", f.job.phase === "done" && f.job.dst["Total Return [%]"] === 9 && f.feats.join() === "handoff_cloud"
    && f.polled === 3 && /^ho\.done\.match\{"dest":"momo_2","to":"momo_2","at":"ho\.at\.up"\}$/.test(f.txt) && !/ho\.cmp\.noise/.test(f.txt), f.txt);
  t("鈕在句子後面的非 live 容器(設計稽核必修 3):看兩邊數字、到雲端看、收起;句子裡沒有鈕", f.btns.join() === "ho.cmp.show,ho.goDest.up,ho.dismiss" && !f.note.kids.some((k) => k.tag === "button") && !f.acts.hidden);
  { const tg = f.acts.querySelector('[data-k="cmp"]'), w0 = f.note.writes;
    t("並排表在 hidden 容器,〔看兩邊數字〕帶 aria-controls/aria-expanded;按了只開合表格,句子不重寫", f.cmp.hidden && tg.attrs["aria-controls"] === "rp-ho-cmp" && tg.attrs["aria-expanded"] === "false" && f.cmp.kids[0].tag === "table"
      && (tg.click(), !f.cmp.hidden && tg.attrs["aria-expanded"] === "true" && f.note.writes === w0 && f.feats.includes("handoff_compare")));
    f.c.hoJobPaint(); f.c.hoJobPaint();
    t("內容沒變就不重寫句子(輪詢、頁首重畫不讓讀屏重唸);表格開著照開著", f.note.writes === w0 && !f.cmp.hidden);
    f.note.hidden = true; f.note.textContent = "";   // = spPaintNote(null) 把那一格清掉
    f.c.hoJobPaint();
    t("那一格被原因句清掉之後,下一次 hoJobPaint 把搬家那一行畫回來(設計稽核必修 1)", !f.note.hidden && /ho\.done\.match/.test(f.note.textContent)); }
  f = await flow({ ack: { ok: true, result: { dest: "momo_2", run: "backtest" }, missing: [] }, polls: [{ stats: Object.assign({}, S, { Trades: 31 }) }], src: { stats: S } });
  t("不一樣 → 存到哪＋結論＋「兩邊資料來源不同」兩句(zh 中間不加空格)", /\}ho\.cmp\.noise$/.test(f.txt) && /^ho\.done\.differs/.test(f.txt), f.txt);
  f = await flow({ ack: { ok: true, result: { dest: "momo_2", run: "backtest" }, missing: [] }, polls: [{ transfer: { kind: "backtest", status: "failed", err: "DATA" } }] });
  t("目的地回測失敗 → fail,句子帶存到哪與原因;那支已經在目的地 → 給〔到雲端看〕(設計稽核必修 5)", f.job.phase === "fail" && /ho\.err\.run/.test(f.txt) && /"at":"ho\.at\.up"/.test(f.txt) && /ho\.why\.DATA/.test(f.txt)
    && f.btns.join() === "ho.goDest.up,ho.dismiss", f);
  f = await flow({ ack: { ok: false, kind: "rejected", error: wire("NOT_PORTABLE", "lib.foo") } });
  t("機器拒絕 → fail、點名模組;沒有存到目的地就不給〔到雲端看〕;不記 handoff_cloud、不輪詢", f.job.phase === "fail" && /ho\.err\.portable\{[^}]*"x":"lib\.foo"/.test(f.txt) && f.btns.join() === "ho.dismiss" && !f.feats.length && !f.polled, f.txt);
  f = await flow({ ack: { ok: false, kind: "unknown", error: "UNKNOWN_RESULT" } });
  t("送出了沒回條 → unknown,講稍後看清單上有沒有 {to}", f.job.phase === "unknown" && /ho\.err\.unknown\{"dest":"momo_2","to":"momo_2"/.test(f.txt), f.txt);
  f = await flow({ ack: { ok: true, result: { dest: "momo_2", run: "keys_failed" }, missing: [] } });
  t("金鑰沒寫進去(keys_failed)→ 講金鑰那句、不叫人找 agent、不輪詢", f.job.phase === "keys" && /ho\.keys\.failed/.test(f.txt) && !f.polled, f);
  f = await flow({ ack: { ok: true, result: { dest: "momo_2", run: "backtest" }, missing: ["FRED"] }, polls: [{ transfer: { kind: "backtest", status: "failed", err: "DATA" } }] });
  t("這台電腦缺金鑰 → 金鑰那句(點名來源)優先、給〔去資料來源〕;回測失敗不改成一般失敗句", f.job.phase === "keys" && /ho\.keys\.none\{"src":"FRED"/.test(f.txt) && !/ho\.err\.run/.test(f.txt)
    && f.btns[0] === "ho.keys.go", f.txt);
  f = await flow({ ack: { ok: true, result: { dest: "momo_2", run: "not_run", can_order: true, order_lines: ["3: place_order("] }, missing: [] } });
  t("Type B 會下單 → notrun,講存到哪、只檢查了程式碼", f.job.phase === "notrun" && /ho\.notrun\.order\{[^}]*"at":"ho\.at\.up"/.test(f.txt) && !f.polled, f.txt);
  f = await flow({ ack: { ok: true, result: { dest: "momo_2", run: "trial", type: "B" }, missing: [] }, polls: [{ transfer: { kind: "trial", status: "done", exit: 0 } }] });
  t("Type B 試跑完 exit 0 → 跑得起來那句(機器回 trial 就照試跑等,不等回測);沒有〔看兩邊數字〕", f.job.phase === "done" && /ho\.trial\.ok/.test(f.txt) && !f.btns.includes("ho.cmp.show"), f.txt);
  f = await flow({ dir: "down", ack: { ok: true, result: { dest: "momo_2", run: "backtest" }, exported: { type: "A", left_behind: ["params.json"] } }, polls: [{ stats: S }], src: null });
  t("拉回:記 handoff_pull、讀本機那一支、來源沒有回測 → nosrc;沒搬的檔是句子的第二句(鈕之前)", f.job.phase === "done" && f.feats.join() === "handoff_pull" && /^ho\.done\.nosrc\{[^}]*"at":"ho\.at\.down"/.test(f.txt)
    && /\}ho\.left\{"x":"params\.json"\}$/.test(f.txt) && f.btns.join() === "ho.cmp.show,ho.goDest.down,ho.dismiss", f.txt);
  { const v = f.c.hoJobView(Object.assign({}, f.job, { dst: null, left: [] }));
    t("目的地沒有回測(none)→ 句子講那邊沒跑出回測、不出〔看兩邊數字〕(設計稽核必修 10、複查)", !v.acts.includes("cmp") && v.cmp === null && /^ho\.done\.none\{/.test(v.text)
      && /"ho\.done\.none": "已存成\{at\} \{dest\}，那邊沒有跑出回測。"/.test(strings)); }
  t("表格欄標靠右(對齊靠右的數字欄),第一格列標靠左(設計複查)", /\.ho-cmp thead th \{ color: var\(--ink-3\); text-align: right; \}/.test(css) && /\.ho-cmp thead th:first-child \{ text-align: left; \}/.test(css)
    && /\.ho-cmp td\.num \{[^}]*text-align: right;/.test(css));
  { f.c.LANG = "en"; const en = f.c.hoJobView(f.job); f.c.LANG = "zh"; const zh = f.c.hoJobView(f.job);
    t("兩句相接:中文不加半形空格、英文加一個(設計複查)", /\}ho\.left\{/.test(zh.text) && /\} ho\.left\{/.test(en.text), [zh.text, en.text]); }
  { const sp = await flow({ ack: { ok: true, result: { dest: "momo_2", run: "backtest" }, missing: [] }, polls: [] });
    t("搬運中行首一個圓環(Loader inline 16/2,aria-hidden),句尾不放「…」;沒有鈕", sp.job.phase === "run" && !!sp.note.querySelector(".spin16") && !/…/.test(sp.txt) && sp.acts.hidden); }
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
