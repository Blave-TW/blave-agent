// 「送上雲端 / 拉回這台電腦」(shell/renderer/handoff.js + 接線)。
// 這顆按鈕會**替用戶送出一句話**給 agent,而 agent 拿得到雲端主機的 SSH:所以重點是
//   ① 送出去的那句話裡只放過得了白名單的資料夾名(顯示名稱是 workspace / 雲端回報的自由文字,不可冒充用戶指令)
//   ② 確認框在「目的地那份正在下單」時真的擋下(okDisabled、而且不出那兩句假話)
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
const { hoMsg, hoState, hoMovesRow } = ctx;

const TPL = { up: "把策略 {id} 送上我的雲端主機。", down: "把雲端主機上的策略 {id} 拉回這台電腦。" };
t("好的資料夾名:句子裡代進去的就是那個名字", hoMsg("up", "btc_rsi", TPL) === "把策略 btc_rsi 送上我的雲端主機。" && hoMsg("down", "A-1_b", TPL) === "把雲端主機上的策略 A-1_b 拉回這台電腦。"
  && hoMsg("up", "x".repeat(64), TPL).includes("x".repeat(64)));
t("壞 id 一律回 null(空白、中文、方括號、引號、路徑、換行、超長、控制字元、不是字串)", ["", " ", "btc rsi", "籌碼集中度", "a]b", "a\"b", "../etc/passwd", "a/b", "a\nb", "a\u0000b", "x".repeat(65), "a.b", "a;b", "$(id)", "{id}", null, undefined, 5, {}, []].every((v) => hoMsg("up", v, TPL) === null && hoMsg("down", v, TPL) === null));
t("方向只認 up / down", ["", "UP", "cloud", null, 1, {}].every((d) => hoMsg(d, "btc_rsi", TPL) === null));
t("範本壞掉(沒有 {id} / 兩個 {id} / 不是字串)→ null:寧可不送,也不送一句沒有標的的話", [null, {}, { up: 5 }, { up: "沒有代號" }, { up: "{id} 與 {id}" }].every((tp) => hoMsg("up", "btc_rsi", tp) === null));
t("代入是字串切接,不是 replace:名字裡就算有 $& 這類樣式也原樣進去", hoMsg("up", "a-b", { up: "x{id}y" }) === "xa-by");

t("確認框四態:目的地那份正在下單 → block(最優先);有同名 → over;不確定 → maybe;其餘 plain", hoState(true, 5) === "block" && hoState(false, 5) === "block" && hoState(null, 5) === "block"
  && hoState(true, 0) === "over" && hoState(null, 0) === "maybe" && hoState(false, 0) === "plain"
  && hoState(true, null) === "over" && hoState(false, undefined) === "plain" && hoState(false, NaN) === "plain" && hoState(false, -3) === "plain" && hoState(false, "9") === "plain");

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
t("兩顆鈕都先問 HO.on:關著就不畫", /const show = HO\.on && /.test(src) && /if \(!HO\.on \|\| !HO_ID_RE\.test\(name\) \|\| !hoCloudLive\(\)\) return null;/.test(src) && /if \(!HO\.on \|\| !HO_ID_RE\.test\(id\)\) return;/.test(src));
t("送上雲端那顆:要回測過、資料夾名合規才畫", /!!RP\.data\.stats && HO_ID_RE\.test\(RP\.name\)/.test(src));
t("hoAsk 的順序(規格 §2):回合進行中 → 不動作;別的框開著 / 選字中 → 不動作;雲端沒在運行 → 切過去不開框", (() => {
  const i = src.indexOf("function hoAsk("), body = src.slice(i, src.indexOf("\n}", i)).replace(/\/\/.*$/gm, "");
  const o = (re) => body.search(re);
  return o(/running/) > 0 && o(/envCanSwitch\(\)/) > o(/running/) && o(/envSwitchGuarded\("cloud"\)\) HO\.pending = \{ id \}; return;/) > o(/envCanSwitch\(\)/) && o(/confirmBox\(\{/) > o(/envSwitchGuarded\("cloud"\)\) HO\.pending = \{ id \}; return;/); })());
t("雲端沒在運行的六種都走同一條(envCloudKind 不是 running,或逾 1 小時沒同步)", /function hoCloudLive\(\) \{ const st = TR_BAGS\.cloud\.st; return envCloudKind\(st\) === "running" && envHeadState\(st, Date\.now\(\)\) !== "unknown"; \}/.test(src));
t("擋下態:確認鈕 disabled,而且「會覆蓋」與「接下來由 agent 執行」兩句都不出(不會執行,那兩句是假話)", (() => {
  const i = src.indexOf("if (state === \"block\")"), seg = src.slice(i, src.indexOf("const title =", i));
  return /okDisabled: state === "block"/.test(src) && /if \(state === "block"\) extra\.appendChild\(mk\("p", "cf-block"/.test(seg) && /\n\s*else \{/.test(seg) && /cf-note/.test(seg) && seg.indexOf("cf-note") > seg.indexOf("else {"); })());
t("擋下態的第二顆鈕切到目的地那一邊(用戶按的,不算自動切);拉回時順手開自動下單頁", /alt: state === "block" \? \{ label: dir === "up" \? t\("ho\.block\.goCloud"\) : t\("ho\.block\.goLocal"\), onOk: \(\) => \{ envSwitchGuarded\(goSide\); if \(goSide === "local"\) trOpen\("pos"\); \} \} : null/.test(src));
t("按確認 = 直接送一句話(帶 handoff 方向標記給主行程記事件):不碰輸入框的草稿(#ta 一個字都沒動到),聊天欄收著先展開", /submitMessage\(msg, \{ handoff: dir \}\)/.test(src) && !/\$\("ta"\)/.test(src) && /if \(paneSt\.chat\.off\) paneToggle\("chat", false\);/.test(src));
t("確認框不放 prompt 全文:訊息是在 onOk 裡才組的,extra 裡只有那幾句 ho.*", !/ho\.msg\./.test(src.slice(src.indexOf("const extra = document.createDocumentFragment()"), src.indexOf("onOk:"))) && /const msg = hoMsg\(dir, id, hoTpl\(\)\); if \(!msg\) return;/.test(src));
t("agent 正在回覆:兩顆鈕是 aria-disabled(鍵盤停得上去、讀屏唸得到原因),不是原生 disabled", /b\.setAttribute\("aria-disabled", "true"\)/.test(src) && /b\.title = t\("turn\.busy"\)/.test(src) && !/\.disabled = true/.test(src));
t("上鎖 / 解鎖的同一處叫 hoBusy(三個出口都有)", (appSrc.match(/hoBusy\(\)/g) || []).length === 3);
t("畫面只走 textContent / DOM,沒有 innerHTML", !/innerHTML/.test(src));

// 目的地有沒有同名:拉回看本機清單(完整),送上雲端看雲端回報的索引——那份索引不保證涵蓋全部,所以找不到時不說「不會覆蓋」
t("送上雲端:雲端清單找不到時用中性說法(maybe),不宣稱不會覆蓋;拉回:本機清單是完整的,可以精確講", /const destHas = dir === "up" \? \(envCloudList\(destSt\)\.some\(\(x\) => x\.name === id\) \? true : null\) : RP\.list\.some\(\(x\) => x\.name === id\);/.test(src));
t("目的地那份的金額讀對邊(up 讀雲端、down 讀這台電腦),壞值當 0", /const destSt = dir === "up" \? TR_BAGS\.cloud\.st : TR_BAGS\.local\.st;/.test(src) && /return isFinite\(v\) \? v : 0;/.test(src)
  && /Object\.prototype\.hasOwnProperty\.call\(a, id\)/.test(src));

// ── C′:未登入按「送上雲端」→ 被切到雲端 → 登入完成 → 側欄第一格給一條回來按那顆鈕的路 ──
{ const run = (ho, rp) => { const c = { HO: ho, RP: rp }; vm.createContext(c); vm.runInContext(cutFn("hoPendingId"), c); return [c.hoPendingId(), c.HO.pending]; };
  t("記住的那一支:報告頁還開著同一支 → 提示出得來", JSON.stringify(run({ on: true, pending: { id: "btc_rsi" } }, { name: "btc_rsi" })) === JSON.stringify(["btc_rsi", { id: "btc_rsi" }]));
  t("沒按過「送上雲端」→ 沒有提示", JSON.stringify(run({ on: true, pending: null }, { name: "btc_rsi" })) === JSON.stringify([null, null]));
  t("回去按不到那顆鈕了(換了策略 / 關了報告)→ 提示不出,意圖一起清掉", JSON.stringify(run({ on: true, pending: { id: "btc_rsi" } }, { name: "eth_ma" })) === JSON.stringify([null, null])
    && JSON.stringify(run({ on: true, pending: { id: "btc_rsi" } }, { name: null })) === JSON.stringify([null, null]));
  t("功能關著 → 提示不出", JSON.stringify(run({ on: false, pending: { id: "btc_rsi" } }, { name: "btc_rsi" })) === JSON.stringify([null, null])); }
t("意圖只在記憶體:不寫 localStorage / sessionStorage(重開 app 一律回這台電腦)", !/Storage/.test(src));
t("切完才記下要送哪一支(envSwitch 會清 pending,先記會被洗掉);記的是 hoPaintUp 給的 RP.name;切不成就不記", /if \(dir === "up" && !hoCloudLive\(\)\) \{ if \(envSwitchGuarded\("cloud"\)\) HO\.pending = \{ id \}; return; \}/.test(src)
  && /hoAsk\("up", RP\.name, b\)/.test(src));
t("框真的開得起來就清掉(按確認送出也走這條);handoff.js 裡清的地方只有 hoAsk 與 hoPendingId", /if \(dir === "up"\) HO\.pending = null;/.test(src)
  && (src.match(/HO\.pending = (null|\{)/g) || []).length === 3 && src.indexOf('if (dir === "up") HO.pending = null;') < src.indexOf("confirmBox({"));
// 承重牆①(設計 eval:四條清除條件都要):人自己切視角(切換器 / ⌘1⌘2 / 選單)也要清——沒有 TTL,少了這條殘留無上限。
// 收斂點是 envSwitch:三個入口都經過它,而且要排在「本來就在這一邊」那個早退之後(原地不動不算放棄意圖)
t("人自己切視角就清掉:收斂在 envSwitch 一處,排在「本來就在這一邊」的早退之後", (() => {
  const i = trSrc.indexOf("function envSwitch(env, via) {"), body = trSrc.slice(i, trSrc.indexOf("\n}", i));
  return i > 0 && /if \(typeof HO !== "undefined"\) HO\.pending = null;/.test(body)
    && body.indexOf("HO.pending = null;") > body.indexOf('if (env === ENV.cur) { if (via === "link") head(); return; }')
    && (trSrc.match(/HO\.pending/g) || []).length === 1; })());
t("回這台電腦那顆鈕:agent 回覆中不動作(同 hoAsk)、守門同切換器那一份、走 envSwitch(\"local\", \"link\"),焦點給 #rp-ho(切完才取節點);不自動切視角、不自動開框", (() => {
  const cell = cutFn("hoPendingCell"), o = (re) => cell.search(re);
  return o(/if \(typeof running !== "undefined" && running\) return;/) > 0 && o(/if \(!envCanSwitch\(\)\) return;/) > o(/if \(typeof running !== "undefined" && running\) return;/)
    && o(/envSwitch\("local", "link"\);/) > o(/if \(!envCanSwitch\(\)\) return;/)
    && o(/const up = \$\("rp-ho"\); if \(up && up\.offsetParent\) up\.focus\(\);/) > o(/envSwitch\("local", "link"\);/)
    && !/confirmBox|hoAsk/.test(cell.replace(/\/\/.*$/gm, "")) && (src.match(/[^\w]envSwitch\(/g) || []).length === 1; })());
t("agent 回覆中那顆鈕也是 aria-disabled:掛 .ho-back、進 hoBusy 的選擇器,畫出來就套一次", /b\.className = "btn-quiet ho-back";/.test(src)
  && /querySelectorAll\("#rp-ho, \.ho-down, \.ho-back"\)/.test(src) && /if \(pid\) \{ box\.appendChild\(hoPendingCell\(pid\)\); hoBusy\(\); \}/.test(trSrc));
t("trade.js:雲端側欄第一格換成那條路(取代 ho.emptyHint、不疊加),清單非空時排在列表上方;sig 帶 pid(清掉 / 記下都會重畫)", /const pid = ho \? hoPendingId\(\) : null;/.test(trSrc)
  && /if \(pid\) \{ box\.appendChild\(hoPendingCell\(pid\)\);/.test(trSrc) && /if \(!list\.length\) \{ if \(!pid\) box\.appendChild\(trEl\("p", "pf-state", ho \? t\("ho\.emptyHint"\)/.test(trSrc)
  && /JSON\.stringify\(\[kind, ho, list\.map\(\(x\) => \[x\.name, x\.displayName, envStratWord\(x\.name, st\)\]\), pid\]\)/.test(trSrc));
t("app.css / trade.css:提示那格的文字鈕跟著那句話的字級", /#strat-list-cloud \.pf-state \.btn-quiet \{ font-size: inherit; \}/.test(fs.readFileSync(path.join(R, "trade.css"), "utf8")));

t("index.html:載入 handoff.js;報告頁首分成 .txt / .act 兩塊(鈕不畫時 .act 藏起來,頁首高度不跳)", /<script src="handoff\.js"><\/script>/.test(html) && /<div class="act" id="rp-act" hidden><\/div>/.test(html) && /<div class="txt">/.test(html));
t("app.css:icon + 字的描邊鈕、列尾那顆的熱區 ≥ 28、確認框的兩欄變體", /\.btn-out\.has-ic \{ display: inline-flex;/.test(css) && /\.ho-down::before \{ content: ""; position: absolute; inset: -8px -4px; \}/.test(css)
  && /\.cf-rows\.kv dt \{ flex: 0 0 56px;/.test(css) && /:lang\(en\) \.cf-rows\.kv dt \{ flex-basis: 84px; \}/.test(css));
t("trade.js:雲端清單每列掛「拉回」、空態換成新的那一句;功能關著時兩者都照舊", /const hb = ho \? hoDownBtn\(x\.name\) : null; if \(hb\) row\.appendChild\(hb\);/.test(trSrc)
  && /ho \? t\("ho\.emptyHint"\) : t\("side\.cloud\.emptyCut1"\)/.test(trSrc) && /const ho = typeof HO !== "undefined" && HO\.on && typeof hoCloudLive === "function" && hoCloudLive\(\);/.test(trSrc));
t("trade.js:輸入框上方那句「agent 還不能操作雲端主機」在功能開著時不出(它已經不成立)", /\$\("chat-tgt"\)\.hidden = !cloud \|\| \(typeof HO !== "undefined" && HO\.on\);/.test(trSrc));
t("重畫:雲端清單的 sig 把 ho 算進去(功能剛問到 / 雲端剛連上時會重畫)", /JSON\.stringify\(\[kind, ho, list\.map/.test(trSrc));
t("字串 zh / en 都齊(ho.* key),而且訊息那兩句與提示各只有一個 {id}", (() => {
  const keys = ["up.btn", "down.btn", "down.aria", "up.title", "down.title", "row.moves", "row.movesV", "row.movesKeys", "row.movesMaybe", "row.stays", "row.staysV", "over.up", "over.down", "over.maybeUp", "block.up", "block.down", "block.goCloud", "block.goLocal", "note", "ok", "emptyHint", "msg.up", "msg.down", "back.hint", "back.btn"];
  return keys.every((k) => (strings.match(new RegExp('"ho\\.' + k.replace(".", "\\.") + '":', "g")) || []).length === 2)
    && (strings.match(/"ho\.(msg\.(up|down)|back\.hint)": "[^"]*"/g) || []).every((l) => l.split("{id}").length === 2); })());
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
