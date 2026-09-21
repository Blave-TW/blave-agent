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
const ctx = { HO_ID_RE: eval(/const HO_ID_RE = (\/.*?\/);/.exec(src)[1]) };
vm.createContext(ctx); vm.runInContext(block.replace(/^const /gm, "var "), ctx);
const { hoMsg, hoState } = ctx;

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

// ── 接線(原文)──
t("功能預設關:HO.on 起手是 false,由主行程的 feature-flags 決定(renderer 自己打不開)", /^const HO = \{ on: false \};$/m.test(src) && /window\.blave\.featureFlags\(\)/.test(src) && /HO\.on = !!\(f && f\.cloudHandoff === true\)/.test(src) && /catch \(_\) \{ HO\.on = false; \}/.test(src));
t("兩顆鈕都先問 HO.on:關著就不畫", /const show = HO\.on && /.test(src) && /if \(!HO\.on \|\| !HO_ID_RE\.test\(name\) \|\| !hoCloudLive\(\)\) return null;/.test(src) && /if \(!HO\.on \|\| !HO_ID_RE\.test\(id\)\) return;/.test(src));
t("送上雲端那顆:要回測過、資料夾名合規才畫", /!!RP\.data\.stats && HO_ID_RE\.test\(RP\.name\)/.test(src));
t("hoAsk 的順序(規格 §2):回合進行中 → 不動作;別的框開著 / 選字中 → 不動作;雲端沒在運行 → 切過去不開框", (() => {
  const i = src.indexOf("function hoAsk("), body = src.slice(i, src.indexOf("\n}", i)).replace(/\/\/.*$/gm, "");
  const o = (re) => body.search(re);
  return o(/running/) > 0 && o(/envCanSwitch\(\)/) > o(/running/) && o(/envSwitchGuarded\("cloud"\); return;/) > o(/envCanSwitch\(\)/) && o(/confirmBox\(\{/) > o(/envSwitchGuarded\("cloud"\); return;/); })());
t("雲端沒在運行的六種都走同一條(envCloudKind 不是 running,或逾 1 小時沒同步)", /function hoCloudLive\(\) \{ const st = TR_BAGS\.cloud\.st; return envCloudKind\(st\) === "running" && envHeadState\(st, Date\.now\(\)\) !== "unknown"; \}/.test(src));
t("擋下態:確認鈕 disabled,而且「會覆蓋」與「接下來由 agent 執行」兩句都不出(不會執行,那兩句是假話)", (() => {
  const i = src.indexOf("if (state === \"block\")"), seg = src.slice(i, src.indexOf("const title =", i));
  return /okDisabled: state === "block"/.test(src) && /if \(state === "block"\) extra\.appendChild\(mk\("p", "cf-block"/.test(seg) && /\n\s*else \{/.test(seg) && /cf-note/.test(seg) && seg.indexOf("cf-note") > seg.indexOf("else {"); })());
t("擋下態的第二顆鈕切到目的地那一邊(用戶按的,不算自動切);拉回時順手開自動下單頁", /alt: state === "block" \? \{ label: dir === "up" \? t\("ho\.block\.goCloud"\) : t\("ho\.block\.goLocal"\), onOk: \(\) => \{ envSwitchGuarded\(goSide\); if \(goSide === "local"\) trOpen\("pos"\); \} \} : null/.test(src));
t("按確認 = 直接送一句話:不碰輸入框的草稿(#ta 一個字都沒動到),聊天欄收著先展開", /submitMessage\(msg\)/.test(src) && !/\$\("ta"\)/.test(src) && /if \(paneSt\.chat\.off\) paneToggle\("chat", false\);/.test(src));
t("確認框不放 prompt 全文:訊息是在 onOk 裡才組的,extra 裡只有那幾句 ho.*", !/ho\.msg\./.test(src.slice(src.indexOf("const extra = document.createDocumentFragment()"), src.indexOf("onOk:"))) && /const msg = hoMsg\(dir, id, hoTpl\(\)\); if \(!msg\) return;/.test(src));
t("agent 正在回覆:兩顆鈕是 aria-disabled(鍵盤停得上去、讀屏唸得到原因),不是原生 disabled", /b\.setAttribute\("aria-disabled", "true"\)/.test(src) && /b\.title = t\("turn\.busy"\)/.test(src) && !/\.disabled = true/.test(src));
t("上鎖 / 解鎖的同一處叫 hoBusy(三個出口都有)", (appSrc.match(/hoBusy\(\)/g) || []).length === 3);
t("畫面只走 textContent / DOM,沒有 innerHTML", !/innerHTML/.test(src));

// 目的地有沒有同名:拉回看本機清單(完整),送上雲端看雲端回報的索引——那份索引不保證涵蓋全部,所以找不到時不說「不會覆蓋」
t("送上雲端:雲端清單找不到時用中性說法(maybe),不宣稱不會覆蓋;拉回:本機清單是完整的,可以精確講", /const destHas = dir === "up" \? \(envCloudList\(destSt\)\.some\(\(x\) => x\.name === id\) \? true : null\) : RP\.list\.some\(\(x\) => x\.name === id\);/.test(src));
t("目的地那份的金額讀對邊(up 讀雲端、down 讀這台電腦),壞值當 0", /const destSt = dir === "up" \? TR_BAGS\.cloud\.st : TR_BAGS\.local\.st;/.test(src) && /return isFinite\(v\) \? v : 0;/.test(src)
  && /Object\.prototype\.hasOwnProperty\.call\(a, id\)/.test(src));

t("index.html:載入 handoff.js;報告頁首分成 .txt / .act 兩塊(鈕不畫時 .act 藏起來,頁首高度不跳)", /<script src="handoff\.js"><\/script>/.test(html) && /<div class="act" id="rp-act" hidden><\/div>/.test(html) && /<div class="txt">/.test(html));
t("app.css:icon + 字的描邊鈕、列尾那顆的熱區 ≥ 28、確認框的兩欄變體", /\.btn-out\.has-ic \{ display: inline-flex;/.test(css) && /\.ho-down::before \{ content: ""; position: absolute; inset: -8px -4px; \}/.test(css)
  && /\.cf-rows\.kv dt \{ flex: 0 0 56px;/.test(css) && /:lang\(en\) \.cf-rows\.kv dt \{ flex-basis: 84px; \}/.test(css));
t("trade.js:雲端清單每列掛「拉回」、空態換成新的那一句;功能關著時兩者都照舊", /const hb = ho \? hoDownBtn\(x\.name\) : null; if \(hb\) row\.appendChild\(hb\);/.test(trSrc)
  && /ho \? t\("ho\.emptyHint"\) : t\("side\.cloud\.emptyCut1"\)/.test(trSrc) && /const ho = typeof HO !== "undefined" && HO\.on && typeof hoCloudLive === "function" && hoCloudLive\(\);/.test(trSrc));
t("trade.js:輸入框上方那句「agent 還不能操作雲端主機」在功能開著時不出(它已經不成立)", /\$\("chat-tgt"\)\.hidden = !cloud \|\| \(typeof HO !== "undefined" && HO\.on\);/.test(trSrc));
t("重畫:雲端清單的 sig 把 ho 算進去(功能剛問到 / 雲端剛連上時會重畫)", /JSON\.stringify\(\[kind, ho, list\.map/.test(trSrc));
t("字串 zh / en 都齊(20 個 ho.* key),而且訊息那兩句各只有一個 {id}", (() => {
  const keys = ["up.btn", "down.btn", "down.aria", "up.title", "down.title", "row.moves", "row.movesV", "row.stays", "row.staysV", "over.up", "over.down", "over.maybeUp", "block.up", "block.down", "block.goCloud", "block.goLocal", "note", "ok", "emptyHint", "msg.up", "msg.down"];
  return keys.every((k) => (strings.match(new RegExp('"ho\\.' + k.replace(".", "\\.") + '":', "g")) || []).length === 2)
    && (strings.match(/"ho\.msg\.(up|down)": "[^"]*"/g) || []).every((l) => l.split("{id}").length === 2); })());
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
