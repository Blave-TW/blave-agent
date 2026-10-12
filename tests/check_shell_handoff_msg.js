// 「送上雲端 / 拉回這台電腦」(shell/renderer/handoff.js + 接線)。
// 這顆按鈕會**替用戶送出一句話**給 agent,而 agent 拿得到雲端主機的 SSH:所以重點是
//   ① 送出去的那句話裡只放過得了白名單的資料夾名(顯示名稱是 workspace / 雲端回報的自由文字,不可冒充用戶指令)
//   ② 目的地同名一律不覆蓋:確認框講清楚會存成哪個新名字,送出去的那句帶那個名字
//   ③ 功能預設關的時候,兩顆鈕一顆都不畫
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
vm.createContext(ctx); vm.runInContext((block + "\n" + cutFn("hoMovesRow")).replace(/^const /gm, "var "), ctx);
const { hoMsg, hoFreeName, hoMovesRow } = ctx;

const TPL = { up: "把策略 {id} 送上我的雲端主機，存成 {to}。", down: "把雲端主機上的策略 {id} 拉回這台電腦，存成 {to}。" };
t("好的資料夾名:句子裡代進去的就是那個名字與目標名", hoMsg("up", "btc_rsi", TPL, "btc_rsi_2") === "把策略 btc_rsi 送上我的雲端主機，存成 btc_rsi_2。" && hoMsg("down", "A-1_b", TPL, "A-1_b") === "把雲端主機上的策略 A-1_b 拉回這台電腦，存成 A-1_b。"
  && hoMsg("up", "x".repeat(64), TPL, "x".repeat(62) + "_2").includes("x".repeat(64)));
const BAD = ["", " ", "btc rsi", "籌碼集中度", "a]b", "a\"b", "../etc/passwd", "a/b", "a\nb", "a\u0000b", "x".repeat(65), "a.b", "a;b", "$(id)", "{id}", "{to}", null, undefined, 5, {}, []];
t("壞 id / 壞目標名一律回 null(空白、中文、方括號、引號、路徑、換行、超長、控制字元、不是字串)", BAD.every((v) => hoMsg("up", v, TPL, "ok") === null && hoMsg("down", v, TPL, "ok") === null && hoMsg("up", "ok", TPL, v) === null));
t("方向只認 up / down", ["", "UP", "cloud", null, 1, {}].every((d) => hoMsg(d, "btc_rsi", TPL, "btc_rsi") === null));
t("範本壞掉(沒有 {id} / 兩個 {id} / 沒有 {to} / 兩個 {to} / 不是字串)→ null:寧可不送,也不送一句沒有標的的話", [null, {}, { up: 5 }, { up: "沒有代號" }, { up: "{id} 與 {id} {to}" }, { up: "只有 {id}" }, { up: "{id} {to} {to}" }].every((tp) => hoMsg("up", "btc_rsi", tp, "btc_rsi") === null));
t("代入是字串切接,不是 replace:名字裡就算有 $& 這類樣式也原樣進去", hoMsg("up", "a-b", { up: "x{id}y{to}" }, "a-b_2") === "xa-bya-b_2");

{ const tk = (...xs) => (n) => xs.indexOf(n) >= 0;
  t("新名字:第一個沒被占的 _N(_2 被占 → _3)", hoFreeName("eth_ti_1h", tk("eth_ti_1h")) === "eth_ti_1h_2" && hoFreeName("eth_ti_1h", tk("eth_ti_1h", "eth_ti_1h_2")) === "eth_ti_1h_3"
    && hoFreeName("a", tk("a_2", "a_3", "a_5")) === "a_4");
  t("新名字守長度:64 字的名字從右邊截,結果仍過 HO_ID_RE", hoFreeName("x".repeat(64), tk()) === "x".repeat(62) + "_2" && ctx.HO_ID_RE.test(hoFreeName("y".repeat(64), tk("y".repeat(62) + "_2"))));
  t("新名字:壞 id 回 null", [null, "", "a b", "x".repeat(65)].every((v) => hoFreeName(v, tk()) === null)); }

// 稽核 C1:金鑰是**雙向**都搬(references/cloud-handoff.md §5),但沒用到 DATA_ 的策略 agent 會跳過那一步
{ const D = (...s2) => ({ dataSources: s2 });
  t("送上雲端 + 掃到來源 → 講金鑰並列出是哪幾個", JSON.stringify(hoMovesRow("up", D("FRED", "POLYGON"))) === JSON.stringify(["ho.row.movesKeys", { sources: "FRED、POLYGON" }]));
  t("送上雲端 + 沒掃到 → 只講程式碼(這支確定用不到)", JSON.stringify(hoMovesRow("up", D())) === JSON.stringify(["ho.row.movesV", null]) && JSON.stringify(hoMovesRow("up", {})) === JSON.stringify(["ho.row.movesV", null]));
  t("拉回 → 中性句:雲端那支的程式碼這台電腦掃不到,不可以宣稱「只搬程式碼」", JSON.stringify(hoMovesRow("down", D("FRED"))) === JSON.stringify(["ho.row.movesMaybe", null])
    && JSON.stringify(hoMovesRow("down", null)) === JSON.stringify(["ho.row.movesMaybe", null]));
  t("壞 dataSources 不拋(不是陣列、列裡不是字串)", JSON.stringify(hoMovesRow("up", { dataSources: "FRED" })) === JSON.stringify(["ho.row.movesV", null])
    && JSON.stringify(hoMovesRow("up", { dataSources: [null, "", 5, "FRED"] })) === JSON.stringify(["ho.row.movesKeys", { sources: "FRED" }]) && JSON.stringify(hoMovesRow("up", null)) === JSON.stringify(["ho.row.movesV", null]));
  t("接線:up 才看 RP.data(拉回那支不在這台電腦上)", /const mv = hoMovesRow\(dir, dir === "up" \? RP\.data : null\);/.test(src));
  t("三句的內容:沒用到的不提金鑰、用到的有 {sources}、中性那句不說死", /"ho\.row\.movesV": "策略程式碼"/.test(strings) && !/"ho\.row\.movesV": "[^"]*金鑰/.test(strings)
    && /"ho\.row\.movesKeys": "[^"]*\{sources\}/.test(strings) && /"ho\.row\.movesMaybe": "[^"]*如果有/.test(strings) && /"ho\.row\.movesMaybe": "[^"]*if any/.test(strings)); }

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
t("功能預設關:HO.on 起手是 false,由主行程的 feature-flags 決定(renderer 自己打不開)", /^const HO = \{ on: false, pending: null \};/m.test(src) && /window\.blave\.featureFlags\(\)/.test(src) && /HO\.on = !!\(f && f\.cloudHandoff === true\)/.test(src) && /catch \(_\) \{ HO\.on = false; \}/.test(src));
t("頁首那顆先問 HO.on:關著就不畫;拉回還要雲端看得到現況", /const show = HO\.on && !!B\.name && HO_ID_RE\.test\(B\.name\) && hoHasCode\(B\.data\) && \(!cloud \|\| hoCloudLive\(\)\);/.test(src) && /if \(!HO\.on \|\| !HO_ID_RE\.test\(id\)\) return;/.test(src));
// Wei 09-22:上傳 / 拉回只要有程式碼就出鈕(不要求回測過——搬過去之後 agent 會在那邊重跑一次)
{ eval(src.slice(src.indexOf("function hoHasCode("), src.indexOf("\n", src.indexOf("function hoHasCode("))));
  t("有程式碼就出鈕:沒有 stats 也算;空白程式碼 / 沒資料不算", hoHasCode({ code: "x = 1", stats: null }) === true && hoHasCode({ code: "  \n" }) === false && hoHasCode(null) === false && hoHasCode({ stats: {} }) === false); }
t("hoAsk 的順序(規格 §2):回合進行中 → 不動作;別的框開著 / 選字中 → 不動作;雲端沒在運行 → 切過去不開框", (() => {
  const i = src.indexOf("function hoAsk("), body = src.slice(i, src.indexOf("\n}", i)).replace(/\/\/.*$/gm, "");
  const o = (re) => body.search(re);
  return o(/running/) > 0 && o(/envCanSwitch\(\)/) > o(/running/) && o(/envSwitchGuarded\("cloud"\)\) HO\.pending = \{ id \};/) > o(/envCanSwitch\(\)/) && o(/confirmBox\(\{/) > o(/envSwitchGuarded\("cloud"\)\) HO\.pending = \{ id \};/); })());
t("雲端沒在運行的六種都走同一條(envCloudKind 不是 running,或逾 1 小時沒同步)", /function hoCloudLive\(\) \{ const st = TR_BAGS\.cloud\.st; return envCloudKind\(st\) === "running" && envHeadState\(st, Date\.now\(\)\) !== "unknown"; \}/.test(src));
t("按確認 = 直接送一句話(帶 handoff 方向標記給主行程記事件):不碰輸入框的草稿(#ta 一個字都沒動到),聊天欄收著先展開", /submitMessage\(msg, \{ handoff: dir, noBacktest: tb === "B" \}\)/.test(src) && !/\$\("ta"\)/.test(src) && /if \(paneSt\.chat\.off\) paneToggle\("chat", false\);/.test(src));
t("確認框不放 prompt 全文:訊息是在 onOk 裡才組的,extra 裡只有那幾句 ho.*", !/ho\.msg\./.test(src.slice(src.indexOf("const extra = document.createDocumentFragment()"), src.indexOf("onOk:"))) && /const msg = hoMsg\(dir, id, hoTpl\(tb\), to\); if \(!msg\) return;/.test(src));
t("agent 正在回覆:兩顆鈕是 aria-disabled(鍵盤停得上去、讀屏唸得到原因),不是原生 disabled", /b\.setAttribute\("aria-disabled", "true"\)/.test(src) && /b\.title = t\("turn\.busy"\)/.test(src) && !/\.disabled = true/.test(src));
t("上鎖 / 解鎖的同一處叫 hoBusy(三個出口都有)", (appSrc.match(/hoBusy\(\)/g) || []).length === 3);
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
  && /b\.addEventListener\("click", \(\) => hoAsk\(dir, id, b\)\);/.test(src));
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
    && !/confirmBox|hoAsk/.test(back.replace(/\/\/.*$/gm, "")) && (src.match(/[^\w]envSwitch\(/g) || []).length === 1; })());
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
t("那張卡:不畫三條賣點與價格、#cv-desc 留空、主鈕 data-k=\"main\"(登入回來焦點正好在它身上)、次鈕是［留在雲端］", (() => {
  const i = trSrc.indexOf("function envPaintEmpty("), ep = trSrc.slice(i, trSrc.indexOf("\n}\n", i));
  return /const ready = kind === "running" && !!pid;/.test(ep) && /const view = ready \? "ready" : envOpenView\(/.test(ep)
    && /view !== "loading" && view !== "unreach" && view !== "ready"\) desc\.textContent = t\("env\.empty\.desc"\)/.test(ep)
    && /if \(view === "ready"\) page\.append\(trEl\("h4", "", t\("ho\.ready\.h"\)\), trEl\("p", "cv-p", t\("ho\.ready\.body", \{ id: pid \}\)\)\);/.test(ep)
    && !/view === "ready"[^\n]*env\.open\.h/.test(ep)
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
t("trade.js:雲端清單列尾是刪除鈕(在 wrap 裡,不在鈕裡;跟 HO 無關)、拉回搬到頁首;空態換成新的那一句", /wrap\.appendChild\(armedDelete\(wrap, t\("cdel\.aria"/.test(trSrc) && !/hoDownBtn/.test(trSrc + src)
  && /ho \? t\("ho\.emptyHint"\) : t\("side\.cloud\.emptyCut1"\)/.test(trSrc) && /const ho = typeof HO !== "undefined" && HO\.on && typeof hoCloudLive === "function" && hoCloudLive\(\);/.test(trSrc));
// A′:輸入框上方「操作對象」那行已整列拿掉(tests/check_shell_envsw.js 釘);「agent 還不能操作雲端主機」那句已刪
t("trade.js:envPaint 不再看 HO.on;chat.tgt.cut1 從程式、DOM、字串表全部消失", !/HO\.on\)/.test(trSrc.slice(trSrc.indexOf("function envPaint("), trSrc.indexOf("function envPaintSide(")))
  && !/chat\.tgt\.cut1/.test(trSrc + html + strings));
t("重畫:雲端清單的 sig 把 ho、能不能刪、選中的那支、刪除中的那幾支算進去", /JSON\.stringify\(\[kind, ho, canDel, sel, \[\.\.\.CDEL\.busy\.keys\(\)\], prefs\.flags, list\.map/.test(trSrc));
t("字串 zh / en 都齊(ho.* key),而且訊息那兩句與提示各只有一個 {id}", (() => {
  const keys = ["up.btn", "down.btn", "down.aria", "up.title", "down.title", "row.moves", "row.movesV", "row.movesKeys", "row.movesMaybe", "row.stays", "row.staysV", "rename.up", "rename.down", "rename.maybeUp", "srcLive.up", "srcLive.down", "block.goCloud", "note.up", "note.down", "ok", "emptyHint", "msg.up", "msg.down", "back.btn", "ready.h", "ready.body", "ready.stay", "gate.stale", "gate.stopped"];
  return keys.every((k) => (strings.match(new RegExp('"ho\\.' + k.replace(".", "\\.") + '":', "g")) || []).length === 2)
    && (strings.match(/"ho\.(msg\.(up|down)|ready\.body)": "[^"]*"/g) || []).every((l) => l.split("{id}").length === 2)
    && (strings.match(/"ho\.(msg\.(up|down)|rename\.(up|down))": "[^"]*"/g) || []).length === 8
    && (strings.match(/"ho\.(msg\.(up|down)|rename\.(up|down))": "[^"]*"/g) || []).every((l) => l.split("{to}").length === 2); })());
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
  const TPLB = { up: "B 把策略 {id} 送上我的雲端主機，存成 {to}。", down: "B 把雲端主機上的策略 {id} 拉回這台電腦，存成 {to}。" };
  const run = (dir, cloudCfg, localCfg, cloudList = [], localList = [], code = null) => {
    const boxes = [], sent = [], opts = [];
    const c = { HO: { on: true, pending: null }, HO_ID_RE: /^[A-Za-z0-9_-]{1,64}$/, running: false, ENV: { cur: dir === "up" ? "local" : "cloud" },
      envCanSwitch: () => true, hoCloudLive: () => true, envCloudKind: () => "running", hoNote: () => {}, envSwitchGuarded: () => true,
      TR_BAGS: { cloud: { st: { report: { config: cloudCfg } } }, local: { st: { report: { config: localCfg } } } },
      t: (k, v) => k + (v ? JSON.stringify(v) : ""), confirmBox: (o) => boxes.push(o), $: () => ({}), document: { createElement: el, createDocumentFragment: el },
      envCloudList: () => cloudList, RP: { list: localList, data: dir === "up" && code ? { code } : null }, RPC: { data: dir === "down" && code ? { code } : null }, LANG: "zh",
      hoTpl: (k) => (k === "B" ? TPLB : TPL), HO_NOTE: { "": ["ho.note.up", "ho.note.down"], B: ["ho.noteB.up", "ho.noteB.down"] }, paneSt: { chat: {} },
      submitMessage: (m, o) => { sent.push(m); opts.push(o); return Promise.resolve(false); }, trackFeature: () => {} };
    vm.createContext(c);
    vm.runInContext(["hoMsg", "hoMovesRow", "hoFreeName", "hoKind", "hoAsk"].map((n) => cut(src, n)).join("\n") + cut(trSrc, "cdelInUse")
      + xpSrc.slice(xpSrc.indexOf("function xpIsTypeB("), xpSrc.indexOf("\n", xpSrc.indexOf("function xpIsTypeB("))), c);
    c.hoAsk(dir, "btc_rsi", {});
    const b = boxes[0]; if (!b) return null;
    b.onOk();
    return { single: !!b.single, ok: b.ok, dis: !!b.okDisabled, alt: b.alt, txt: texts(b.extra).join("|"), msg: sent[0], opts: opts[0] };
  };
  // e2e 0.1.8 H:Type B 沒有回測——確認框與送出去的那句不提回測;判別用檔頭 `# Type: B`(同轉出選單)。
  // 字講「確認它跑得起來」,不講「試跑一次」:會下單的 Type B 不試跑、只檢查(references/cloud-handoff.md 1.3、6B),現在式的承諾要對每一種都成立
  { const B = "# Strategy: 資金費率監控\n# Type:     B (monitor only, no orders)\nSTRATEGY_NAME = 'w'\n", A = "# Strategy: x\n# Type:     A\n";
    let b = run("up", {}, {}, [], [], B);
    t("Type B 送上雲端:框裡是 ho.noteB.up(沒有 ho.note.up)、送出的是 Type B 那一句、帶 noBacktest", /ho\.noteB\.up/.test(b.txt) && !/ho\.note\.up/.test(b.txt) && b.msg === "B 把策略 btc_rsi 送上我的雲端主機，存成 btc_rsi。" && b.opts.handoff === "up" && b.opts.noBacktest === true, JSON.stringify(b));
    b = run("down", {}, {}, [], [], B);
    t("Type B 拉回:ho.noteB.down、Type B 那一句", /ho\.noteB\.down/.test(b.txt) && b.msg === "B 把雲端主機上的策略 btc_rsi 拉回這台電腦，存成 btc_rsi。" && b.opts.noBacktest === true, JSON.stringify(b));
    b = run("up", {}, {}, [], [], A);
    t("Type A / 判不出來:照舊講回測那一句,不帶 noBacktest", /ho\.note\.up/.test(b.txt) && !/noteB/.test(b.txt) && b.msg === "把策略 btc_rsi 送上我的雲端主機，存成 btc_rsi。" && b.opts.noBacktest === false && run("up", {}, {}).opts.noBacktest === false, JSON.stringify(b));
    { const S2 = new Function(strings + "; return STRINGS;")();
      t("字串(設計師定稿):Type B 四句逐字,兩語都不講「試跑 / run it once」", [
        ["zh", "ho.msgB.up", "把策略 {id} 送上我的雲端主機，存成 {to}。搬完確認它在雲端跑得起來，告訴我結果。"],
        ["zh", "ho.msgB.down", "把雲端主機上的策略 {id} 拉回這台電腦，存成 {to}。拉回後確認它在這裡跑得起來，告訴我結果。"],
        ["zh", "ho.noteB.up", "接下來由 agent 搬過去，確認它在雲端跑得起來。"],
        ["zh", "ho.noteB.down", "接下來由 agent 搬回來，確認它在這台電腦跑得起來。"],
        ["en", "ho.msgB.up", "Send the strategy {id} to my cloud machine as {to}. Once it’s moved, check that it starts there, and tell me the result."],
        ["en", "ho.msgB.down", "Bring the strategy {id} from my cloud machine back to this computer as {to}. Once it’s back, check that it starts here, and tell me the result."],
        ["en", "ho.noteB.up", "The agent moves it and checks that it starts on your cloud machine."],
        ["en", "ho.noteB.down", "The agent brings it back and checks that it starts on this computer."],
      ].every((x) => S2[x[0]][x[1]] === x[2] && !/試跑|run it once|runs it once/i.test(S2[x[0]][x[1]]))); }
    t("字串:Type B 四句 zh / en 都在、都不提回測,訊息各一個 {id} 一個 {to}", ["msgB.up", "msgB.down", "noteB.up", "noteB.down"].every((k) => { const m = strings.match(new RegExp('"ho\\.' + k.replace(".", "\\.") + '": "([^"]*)"', "g")) || [];
      return m.length === 2 && m.every((l) => !/回測|backtest/i.test(l) && (k.indexOf("msg") ? true : l.split("{id}").length === 2 && l.split("{to}").length === 2)); }));
  }
  const sendable = (r) => r && !r.single && r.ok === "ho.ok" && !r.dis && !r.alt && /ho\.row\.moves/.test(r.txt) && /ho\.note\./.test(r.txt);
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
  t("送出去的那句帶目標名 btc_rsi_3", r.msg === "把策略 btc_rsi 送上我的雲端主機，存成 btc_rsi_3。");
  r = run("up", { weights: { btc_rsi_2: 0.5 } }, {}, [{ name: "btc_rsi" }]);
  t("雲端下單設定裡掛著的名字(資料夾不在清單)也算被占 → btc_rsi_3", sendable(r) && r.txt.includes('"to":"btc_rsi_3"') && /存成 btc_rsi_3。$/.test(r.msg));
  r = run("down", {}, { exchanges: { btc_rsi: "okx" } });
  t("拉回:這台電腦的下單設定有 btc_rsi(清單沒有)→ ho.rename.down 存成 btc_rsi_2", sendable(r) && r.txt.includes('ho.rename.down{"id":"btc_rsi","to":"btc_rsi_2"}') && r.msg === "把雲端主機上的策略 btc_rsi 拉回這台電腦，存成 btc_rsi_2。");
  r = run("down", {}, {}, [], [{ name: "btc_rsi" }]);
  t("拉回:這台電腦清單有同名 → 存成 btc_rsi_2", sendable(r) && r.txt.includes('"to":"btc_rsi_2"'));
  r = run("up", {}, {});
  t("送上雲端、雲端清單沒看到 → 中性那句,送出去的名字照原名(由 agent 實查定案)", sendable(r) && /ho\.rename\.maybeUp/.test(r.txt) && !/ho\.rename\.up/.test(r.txt) && r.msg === "把策略 btc_rsi 送上我的雲端主機，存成 btc_rsi。");
  r = run("down", {}, {});
  t("拉回、這台電腦沒有同名 → 沒有改名那一行,原名送出", sendable(r) && !/ho\.rename/.test(r.txt) && /存成 btc_rsi。$/.test(r.msg));
  t("擋下態與覆蓋態整段退場(程式與字串表都沒有 ho.block.up/down、ho.over.*、goLocal、hoState、okDisabled、alt)", !/ho\.block\.(up|down)"|ho\.over\.|goLocal/.test(strings) && !/ho\.block\.(up|down)\b|ho\.over\.|goLocal|hoState|hoAmount|okDisabled|alt:/.test(src));
  t("改名那幾句的字", /"ho\.rename\.up": "雲端已經有同名的 \{id\}，這份會存成新策略 \{to\}；原本那支不動。"/.test(strings) && /"ho\.rename\.down": "這台電腦已經有同名的 \{id\}，這份會存成新策略 \{to\}；原本那支不動。"/.test(strings)
    && /"ho\.rename\.maybeUp": "若雲端已有同名策略，會改存成新名字，原本那支不動。"/.test(strings));
  t("舊的來源擋下態整段退場(ho.block.srcUp / srcDown 不在程式與字串表)", !/ho\.block\.src/.test(src + strings));
  t("那一句的字:兩個方向都講「照常下單」與「給金額才會開始下單」", ["up", "down"].every((d) => (strings.match(new RegExp('"ho\\.srcLive\\.' + d + '": "[^"]*"', "g")) || []).length === 2)
    && /"ho\.srcLive\.up": "這台電腦這一支照常下單；雲端那份[^"]*給金額，才會開始下單。"/.test(strings) && /"ho\.srcLive\.down": "雲端那一支照常下單；[^"]*給金額，才會開始下單。"/.test(strings));
  // 0.1.12 市場檢查出貨前整個拿掉:送上雲端 / 拉回不看市場(美股不在這裡擋,也不多那一行「對不上」)
  t("送上雲端 / 拉回不看市場:handoff.js 沒有 trGateOf / market_gate / ho.gate.usstock / ho.gate.mismatch;字串表也沒有那三句",
    !/trGateOf|market_gate|ho\.gate\.(usstock|mismatch)/.test(src) && !/ho\.gate\.(usstock|mismatch)/.test(strings)); }
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
