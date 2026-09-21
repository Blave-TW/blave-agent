// 設定 modal 的兩塊畫面邏輯(shell/renderer/app.js):「關於」的更新狀態(upPaint 七種 phase)、帳號區兩態(acctPaintAcct)。
// 從原文切出函式,配一個最小的假 DOM 跑。跑法:node tests/check_shell_settings.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "app.js"), "utf8"), html = fs.readFileSync(path.join(R, "index.html"), "utf8"), css = fs.readFileSync(path.join(R, "app.css"), "utf8"), trcss = fs.readFileSync(path.join(R, "trade.css"), "utf8");
const fnSrc = (name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); return src.slice(i, src.indexOf("\n}", i) + 2); };
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };
const el = () => {
  const cls = new Set(["btn-quiet"]);
  const n = { _txt: "", hidden: false, onclick: null, title: "", _cls: "", children: [],
    classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), has: (c) => cls.has(c) },
    setAttribute: () => {},
    append: (...x) => { x.forEach((y) => { n.children.push(y); n._txt += typeof y === "string" ? y : y.textContent || ""; }); },
    appendChild: (x) => { n.children.push(x); n._txt += x.textContent || ""; return x; } };
  Object.defineProperty(n, "className", { get: () => n._cls, set: (v) => { n._cls = v; } });
  // textContent = "" 也要清掉子節點(真的 DOM 是這樣;不清的話清單重畫會越畫越長,測試就看不出漏清)
  Object.defineProperty(n, "textContent", { get: () => n._txt, set: (v) => { n._txt = v; n.children.length = 0; } });
  return n;
};
const dom = {}; const $ = (id) => dom[id] || (dom[id] = el());
const document = { createElement: () => el() };
let cur = null, planLoginBusy = false, oauthPending = false, HINT = null;
const setFocusGuard = () => {}, cmdLine = () => "";
const t = (k, v) => k + (v ? JSON.stringify(v) : "");
const calls = []; const window = { blave: { updateCheck: () => { calls.push("check"); return Promise.resolve(); }, updateInstall: () => { calls.push("install"); return Promise.resolve({ ok: true }); } } };
const upRefresh = () => {}; let UP = null, hasToken = false;
eval(fnSrc("upPaint")); eval(fnSrc("acctPaintAcct"));
const paint = (st) => { UP = st; upPaint(); const b = $("set-up-btn"); return { ver: $("set-up-ver").textContent, msg: $("set-up-txt").textContent, up: $("set-up-txt").classList.has("up"), btn: b.hidden ? null : b.textContent, out: b.classList.has("btn-out"), quiet: b.classList.has("btn-quiet") }; };
const C = { current: "0.0.1", version: "0.0.2" };
let p = paint({ ...C, phase: "off", version: null });
ok("off(沒有更新來源):只有版號,沒有狀態句、沒有鈕", p.ver === 'up.app{"v":"0.0.1"}' && p.msg === "" && p.btn === null);
p = paint({ ...C, phase: "idle" }); ok("idle:已是最新版 + 安靜的「檢查更新」", p.msg === "up.latest" && p.btn === "up.check" && p.quiet && !p.out && !p.up);
p = paint({ ...C, phase: "checking" }); ok("checking:沒有鈕", p.msg === "up.checking" && p.btn === null);
p = paint({ ...C, phase: "downloading", percent: 42 }); ok("downloading:有百分比用帶百分比的句子,沒有鈕;沒有百分比退回不帶的", p.msg === 'up.downloadingPct{"nv":"0.0.2","pct":42}' && p.btn === null && paint({ ...C, phase: "downloading", percent: null }).msg === 'up.downloading{"nv":"0.0.2"}');
p = paint({ ...C, phase: "staging" }); ok("staging:沒有鈕(還沒驗完章,不能給重啟)", p.msg === 'up.staging{"nv":"0.0.2"}' && p.btn === null);
p = paint({ ...C, phase: "ready" }); ok("ready:句子升一階、鈕換成描邊的「重新啟動並更新」", p.up && p.btn === "up.install" && p.out && !p.quiet);
$("set-up-btn").onclick(); ok("ready 的鈕按下去是安裝,不是檢查", calls.join() === "install");
p = paint({ ...C, phase: "blocked" }); ok("blocked(下單中):講原因、**沒有鈕**(下單中不裝)", p.msg === 'up.blocked{"nv":"0.0.2"}' && p.up && p.btn === null);
p = paint({ ...C, phase: "error", error: "CHECK_FAILED" }); ok("error:這次沒檢查成功 + 檢查更新(鈕退回安靜的)", p.msg === "up.error" && p.up && p.btn === "up.check" && p.quiet && !p.out);
p = paint({ ...C, phase: "error", error: "INSTALL_FAILED" }); ok("安裝失敗:講出來、可以再檢查", p.msg === 'up.installFailed{"nv":"0.0.2"}' && p.btn === "up.check");
ok("版號每一種 phase 都在;狀態句不再帶版號前綴", ["idle", "checking", "ready", "blocked", "error"].every((ph) => paint({ ...C, phase: ph }).ver === 'up.app{"v":"0.0.1"}') && !/t\("up\.(latest|checking|error)", v\)/.test(fnSrc("upPaint")));
const S = fs.readFileSync(path.join(R, "strings.js"), "utf8");
ok("字串:up.app / acct.signedOut 在、up.label / up.current 清掉、前綴「{v} ·」拿掉", /"up\.app"/.test(S) && /"acct\.signedOut"/.test(S) && !/"up\.(label|current)"/.test(S) && !/"up\.[a-zA-Z]+": "\{v\} /.test(S));

// 設定 › 帳號(正式分類;左欄底那一塊已退場)
const acctState = () => ({ a1: $("acct-a1").textContent, a2: $("acct-a2").textContent, dot: $("acct-a2").className.includes("on"),
  btn: $("set-acct-btn").textContent, btnCls: $("set-acct-btn").className, list: $("acct-list").children.map((x) => x.textContent) });
hasToken = false; cur = "claude"; acctPaintAcct();
let A = acctState();
ok("未登入:Blave 帳號 / 未登入(沒有綠點)/ 填色的「登入 Blave」/ 兩條「登入拿得到什麼」", A.a1 === "acct.lbl" && A.a2 === "acct.signedOut" && !A.dot && A.btn === "cn.blave.btn" && A.btnCls === "btn-fill" && A.list.join() === "acct.in.1,acct.in.2");
planLoginBusy = true; acctPaintAcct();
ok("登入等待中:同一顆鈕變「取消」而不是變灰(同方案頁)", acctState().btn === "oauth.cancel" && acctState().btnCls === "btn-out");
planLoginBusy = false;
hasToken = true; acctPaintAcct(); A = acctState();
ok("已登入、用自己的 CLI:綠點 + 已登入、描邊的「登出」、兩條「登出會怎樣」", A.a2 === "acct.signedIn" && A.dot && A.btn === "acct.out" && A.btnCls === "btn-out" && A.list.join() === "acct.out.1,acct.out.2");
cur = "blave"; acctPaintAcct();
ok("已登入、用 Blave 的 AI:多一條講「登出會回到選 AI 的畫面」,而且排第一(最突兀的後果先講);用自己 CLI 的人不出這一條", acctState().list.join() === "acct.out.3,acct.out.1,acct.out.2");
ok("登出不另跳確認框(可逆、沒有東西會被刪);那顆鈕的 id 不變,焦點留在同一個位置", !/confirmBox\(\{[^}]*acct\.out/.test(src) && /\$\("set-acct-btn"\)\.focus\(\)/.test(src));
ok("「前往」只換分類、不外開瀏覽器(錢的事在「資料與雲端方案」)", /\$\("acct-to-plan-btn"\)\.addEventListener\("click", \(\) => \{ setCat\("plan"\);/.test(src));
ok("未登入時走現有的登入流程(planLogin),不另寫一條", /await planLogin\(\); acctPaintAcct\(\); return;/.test(src) && (src.match(/startOAuth\(/g) || []).length === 4);   // 4 = HEAD 既有的次數:帳號頁沒有多開一條
ok("左欄底那一塊清乾淨:DOM / CSS / 程式都沒有舊的 id 與 class", !/id="set-acct"[^-]/.test(html) && !/set-acct-who|set-acct-st\b/.test(html + src) && !/\.set-acct \.(who|l1|l2|lbl|mail)|\.set-cats \.set-acct/.test(css));
const CATS = (re) => [...html.matchAll(re)].map((m) => m[1]).join();
ok("分類順序:一般 → 模型接入 → 資料與雲端方案 → 帳號 → 隱私(資料來源之後才進來);每一類都有自己的頁", CATS(/class="set-cat"[^>]*data-set-cat="([a-z]+)"/g) === "display,model,plan,acct,priv" && CATS(/class="set-pane[^"]*" data-set-cat="([a-z]+)"/g) === "display,model,plan,acct,priv");
const PO2 = ["zh", "en"].map((l) => fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", l + ".po"), "utf8"));
ok("那一類定名「一般」;指到它的句子(minv.trade)兩語都跟著改", /msgid "set\.cat\.display"\nmsgstr "一般"/.test(PO2[0]) && /msgid "set\.cat\.display"\nmsgstr "General"/.test(PO2[1])
  && /msgid "minv\.trade"\nmsgstr "[^\n]*設定 › 一般/.test(PO2[0]) && /msgid "minv\.trade"\nmsgstr "[^\n]*Settings › General/.test(PO2[1]));

// 設定 › 模型接入(三選一;連結畫面那張卡不再搬進設定)
const mdl = (() => { const a = src.indexOf("const MDL = {"), b = src.indexOf("/* ── 設定 › 模型接入 的純邏輯到此"); if (a < 0 || b < 0) throw new Error("找不到純邏輯區塊"); return src.slice(a, b); })();
if (/\bdocument\b|\$\(|window\./.test(mdl.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))) throw new Error("模型接入的純邏輯碰了 DOM");
eval(mdl.replace(/^const /gm, "var "));
const D = { claude: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: false } };
const shape = (o) => [o.kind, o.isCur, o.st && o.st.key, String(o.act)].join("|");
let M = mdlOptions(D, "claude", true);
ok("三個選項、選一個:Blave 有登入狀態與「切換」;用中的那一列沒有動作(列尾改放「使用中」)", M.length === 3 && shape(M[0]) === "blave|false|st.signedIn|cn.blave.switch" && shape(M[1]) === "claude|true|st.signedIn|null" && shape(M[2]) === "codex|false|st.notSignedIn|cn.signIn");
ok("沒登入 Blave、現在用的是本機 agent:那一列是「登入並切換」(不是「登入 Blave」)", mdlOptions(D, "claude", false)[0].act === "cn.blave.signinSwitch" && mdlOptions(D, null, false)[0].act === "cn.blave.btn" && mdlOptions(D, "claude", false)[0].st.key === "st.notSignedIn");
M = mdlOptions({ claude: { installed: false }, codex: { installed: false } }, "blave", true);
ok("用的是 Blave 的 AI:那一列 is-cur、沒有動作;沒裝的兩列沒有鈕", shape(M[0]) === "blave|true|st.signedIn|null" && shape(M[1]) === "claude|false|st.notFound|null" && shape(M[2]) === "codex|false|st.notFound|null");
M = mdlOptions(D, "claude", false, { login: "codex" });
ok("等待登入中:那一列變「取消等待」(這一頁每次重畫都是新節點,等待狀態要在資料裡);其餘鈕由 waiting 鎖住", M[2].act === "login.cancel" && /b\.disabled = waiting && o\.act !== "login\.cancel"/.test(src) && /if \(o\.act === "login\.cancel"\) return window\.blave\.cancelAgentLogin\(\)/.test(src));
ok("等待 OAuth 中:Blave 那一列變「取消」,等待結束會重畫(不然「取消」留在畫面上)", mdlOptions(D, "claude", false, { oauth: true })[0].act === "oauth.cancel" && /oauthPending = false;\n    b\.textContent = was;\n    waitChanged\(\);/.test(src));
M = mdlOptions(null, "claude", true);
ok("偵測中:兩列只換狀態字、不給動作(列數不變);Blave 那一列不受偵測影響", shape(M[1]) === "claude|false|cn.detecting|null" && shape(M[2]) === "codex|false|cn.detecting|null" && M[0].act === "cn.blave.switch");
ok("連結畫面那張卡不再搬進設定(兩邊各畫各的,共用的是底下的邏輯)", !/set-model"\)\.appendChild\(document\.querySelector\("\.cn-card"\)\)/.test(src) && !/\$\("cn-foot"\)\.before\(/.test(src) && /function mdlPaint\(\)/.test(src) && /id="set-model"[^>]*><\/div>/.test(html));
ok("登入 / 連結完重畫之後,焦點回同一列的鈕(兩個表面都靠 data-kind)", /if \(kind\) div\.dataset\.kind = kind;/.test(src) && /r\.dataset\.kind = o\.kind;/.test(src) && /host\(\)\.querySelector\('\[data-kind="' \+ kind \+ '"\] button'\)/.test(src));
ok("模型接入頁的小框鈕只亮這一頁(不動全站的 .pf-act);「使用中」= 灰填 + 加粗 + 列尾三個字", /#set-model \.pf-act\{[^}]*--ink-2/.test(css) && /\.cn-opt\.is-cur\{background:var\(--surface-muted\)\}/.test(css) && /\.cn-opt\.is-cur \.n\{font-weight:600\}/.test(css));
ok("字串:設定頁那一列是「Blave 的 AI」,連結畫面的動詞句「用 Blave 的 AI」照舊", /msgid "cn\.blave\.name"\nmsgstr "Blave 的 AI"/.test(PO2[0]) && /msgid "cn\.blave\.title"\nmsgstr "用 Blave 的 AI"/.test(PO2[0]) && /data-i18n="cn\.blave\.title"/.test(html));
ok("字串:本機那一組改成「這台電腦上的 agent」,群組小標「由 Blave 提供」", /msgid "cn\.local\.label"\nmsgstr "這台電腦上的 agent"/.test(PO2[0]) && /msgid "cn\.blave\.group"\nmsgstr "由 Blave 提供"/.test(PO2[0]));

// 重畫吃掉焦點 → Esc 關不掉設定(R3-1:「重新偵測」那一顆被銷毀時踩到)
ok("重新偵測那一組掛的是 data-kind(焦點還原查的就是它),不是 data-k", /g\.dataset\.kind = "redetect";/.test(src) && !/dataset\.k = /.test(fnSrc("mdlPaint")) && /querySelector\('\[data-kind="' \+ focusKind\.kind \+ '"\] button'\)/.test(src));
ok("設定裡重畫過的每一塊都過同一關:焦點掉到 BODY 或掉出 modal 就放回框內(不靠個別欄位名猜對)", /function setFocusGuard\(\) \{[\s\S]{0,400}a !== document\.body && \$\("set-modal"\)\.contains\(a\)/.test(src)
  && ["mdlPaint", "acctPaintAcct", "privPaint"].every((n) => /setFocusGuard\(\);\n\}/.test(fnSrc(n))));
// V4:等待狀態(oauthPending / planLoginBusy)是一件事、兩份 DOM。列舉:凡是改這兩個旗標的地方都要重畫兩個表面
// 每一個**指派點**(不是每一個函式)後面三行內要看到 waitChanged():同一支裡漏掉其中一次也要抓得到
const bare = src.replace(/^\s*\/\/.*$/gm, "");   // 註解掉的程式不算數
const sites = [...bare.matchAll(/^[^\n]*\b(?:oauthPending|planLoginBusy) = (?!false, |null)[^\n]*$/gm)].filter((m) => !/^let /.test(m[0].trim()));
const late = sites.filter((m) => !/waitChanged\(\)/.test(bare.slice(m.index, m.index + 400).split("\n").slice(0, 4).join("\n"))).map((m) => m[0].trim().slice(0, 40));
ok("改了等待旗標的每一處都重畫兩個表面(共 " + sites.length + " 處" + (late.length ? ";漏的:" + late.join(" / ") : "") + ")", sites.length >= 7 && late.length === 0 && /function waitChanged\(\) \{ mdlPaint\(\); acctPaintAcct\(\); \}/.test(bare));
ok("V4(a) 帳號那顆「取消」按得動:等待是別的表面開始的也取消得了(planLogin 在那種情況會靜默 return)", /if \(oauthPending && !planLoginBusy\) \{ window\.blave\.cancelOAuth\(\); return; \}/.test(src));
ok("V1 上一則不會活過下一次登入(離線登出那句只有 detect() 會清)", /^\s*setHint\(null\);/m.test(fnSrc("planLogin").replace(/^\s*\/\/.*$/gm, "")));
ok("V2 確認框 / 圖片放大開著時,焦點歸它們(不靠 inert 讓 focus\(\) 變 no-op)", /if \(!\$\("del-scrim"\)\.hidden \|\| !\$\("lb-scrim"\)\.hidden\) return;/.test(fnSrc("setFocusGuard")));
ok("模型接入那一頁畫得出共用的那一則(它是三個表面之一)", /if \(HINT\) \{ const p = el\("p", "cn-hint"\);/.test(fnSrc("mdlPaint")));

// 帳號頁的訊息格:一個 owner
ok("帳號頁有放訊息的地方,而且只由 acctPaintAcct 寫(planPaint 會頻繁叫它,不能有第二個寫入者)", /id="acct-hint"/.test(html) && (src.match(/\$\("acct-hint"\)|el\("acct-hint"\)/g) || []).length === 1 && /el\("acct-hint"\)/.test(fnSrc("acctPaintAcct")) && /\n  mdlPaint\(\);\n  acctPaintAcct\(\);\n/.test(fnSrc("setHint")));
ok("登出沒撤成那句、登入等待中那句都到得了帳號頁", /const msg = waiting \? \{ text: t\("pv\.w\.waiting"\) \} : HINT;/.test(src) && /setHint\(\{ text: t\("cn\.blave\.signOutLocalOnly"\) \}\)/.test(src));
hasToken = true; HINT = { text: "cn.blave.signOutLocalOnly" }; acctPaintAcct();
ok("登出沒撤成:那句話出現在帳號頁(登出鈕就住在這一頁,別處看不到)", $("acct-hint").textContent === "cn.blave.signOutLocalOnly" && $("acct-hint").hidden === false);
hasToken = false; planLoginBusy = true; acctPaintAcct();
ok("登入等待中:講「瀏覽器已開啟」(等待是當下的狀態,壓過上一則)", $("acct-hint").textContent === "pv.w.waiting");
planLoginBusy = false; HINT = null; acctPaintAcct();
ok("沒有訊息就收起來", $("acct-hint").hidden === true && $("acct-hint").textContent === "");
hasToken = true; cur = "blave"; acctPaintAcct();
ok("字串:acct.out.3 照定稿(不跟 acct.out.2「對話留在這台電腦」打架)", /msgid "acct\.out\.3"\nmsgstr "你現在用的是 Blave 的 AI，登出會回到選 AI 的畫面，要先選一個才能繼續用。"/.test(PO2[0]));
// 聊天欄捲動邊界:靜止沒有線,捲起來才浮一條
ok("捲動時才出現的那條線:兩層捲動都掛、以看得見的那一層為準;靜止沒有線", /\.chat-head\.is-scrolled \{ box-shadow: 0 1px 0 var\(--border-hairline\); \}/.test(css) && !/\.chat-head \{[^}]*box-shadow/.test(css)
  && /\$\("chat-scroll"\)\.addEventListener\("scroll", chatEdge\)/.test(src) && /\$\("cs-list"\)\.addEventListener\("scroll", chatEdge\)/.test(src) && /list\.hidden \? \$\("chat-scroll"\) : list/.test(src));
ok("搬家留下的死規則與舊註解清掉", !/\.set-pane \.cn-(card|sec)/.test(css) && !/把 \.cn-card 整個搬進來/.test(html));

// 頂列那條帶子:視窗頂是同一條標題帶,三段(側欄 ::before、中欄 .tb、右欄 .chat-head 與它收合後的漸層)必須同高——
// 以後改一處漏一處,這一則會紅。.tb 還要用負的 margin 把自己疊回那一條上,值也得跟著
const BAR = [["app.css .cn-bar/.ws-bar", /\.cn-bar, \.ws-bar \{[^}]*height: (\d+)px/, css], ["app.css .pane-strategies/.pane-main padding-top", /\.pane-strategies, \.pane-main \{ padding-top: (\d+)px/, css],
  ["app.css html.ws-sc .pane-strategies padding-top", /html\.ws-sc \.pane-strategies \{ width: 44px; padding: (\d+)px/, css], ["app.css .chat-head", /\.chat-head \{\s*flex: none; height: (\d+)px/, css],
  ["app.css .cn-mid padding-bottom", /\.cn-mid \{[^}]*padding-bottom: (\d+)px/, css], ["trade.css .tb height", /\.pane-main > \.tb \{\s*flex: none; height: (\d+)px/, trcss],
  ["trade.css .tb margin-top", /\.pane-main > \.tb \{\s*flex: none; height: \d+px; margin-top: -(\d+)px/, trcss], ["trade.css 側欄 ::before", /\.pane-strategies::before \{[^}]*height: (\d+)px/, trcss],
  ["trade.css .chat-strip 漸層(上)", /linear-gradient\(var\(--surface-muted\) (\d+)px/, trcss], ["trade.css .chat-strip 漸層(下)", /var\(--surface-card\) (\d+)px\)/, trcss]];
const bars = BAR.map(([name, re, text]) => { const m = text.match(re); return [name, m ? m[1] : "找不到"]; });
ok("頂列三段同高(" + [...new Set(bars.map((b) => b[1]))].join("/") + "):" + bars.filter((b) => b[1] !== "52").map((b) => b[0]).join() , bars.every((b) => b[1] === "52"));
ok("紅綠燈對到那條帶子的中線(帶子 52 → 中線 26 → 燈 y=19)", /trafficLightPosition: \{ x: 12, y: 19 \}/.test(fs.readFileSync(path.join(R, "..", "main.js"), "utf8")));
ok("不該跟著動的 44 還在:側欄細軌的寬、收合後的寬、選項列與分類鈕的熱區下限", /html\.ws-sc \.pane-strategies \{ width: 44px;/.test(css) && /off: 44/.test(src) && /\.cn-opt\{[^}]*min-height:44px/.test(css) && /\.cn-row \{[\s\S]{0,120}min-height: 44px;/.test(css));

// 頂列底線
ok("中欄頂列與聊天頭沒有底線;雲端那兩條 transparent 跟著退場(沒有線可以透明)", !/\.pane-main > \.tb \{[^}]*border-bottom/.test(trcss) && !/\.chat-head \{[^}]*border-bottom/.test(css) && !/border-bottom-color: transparent/.test(trcss.split("html\[data-env")[1] || ""));
ok("分頁列與欄界那幾條線留著", /\.main-tabs \{[^}]*border-bottom: 1px solid var\(--border-hairline\)/.test(trcss) && /\.modal-head \{[^}]*border-bottom/.test(css));
ok("CSS:舊的三條規則與 .set-up 樣式清掉", !/\.set-acct \.(lbl|mail|btn-quiet)|\.set-up-txt|\.set-up \.btn-quiet/.test(css));
ok("字標拿掉:DOM / CSS / 程式都沒有 .ws-brand 與 #ws-home;收合鈕上距 12", !/ws-brand|ws-home/.test(html + css + src) && /html\.ws-sc \.side-rail \{[^}]*padding-top: var\(--space-12\);/.test(css));
ok("分隔線:帳號那一塊、「關於」上面、AI 接入頁列間那三條拿掉;標題列下緣、左右欄直線、方案頁的腳留著", !/\.set-acct[^{]*\{[^}]*border-top/.test(css) && !/\.set-about \{[^}]*border-top/.test(css) && !/\.cn-row \+ \.cn-row/.test(css)
  && /\.modal-head \{[^}]*border-bottom/.test(css) && /\.set-cats\s*\{[^}]*border-right/.test(css) && /\.plan-foot\s*\{[^}]*border-top/.test(css));
// 設定 › 隱私
const PO = ["zh", "en"].map((l) => fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", l + ".po"), "utf8"));
ok("隱私:分類排最後、開關是 role=switch + aria-checked、即時生效(切換後以主行程回的為準)", /data-set-cat="acct"[^>]*><\/button>\s*\n\s*(<!--[\s\S]*?-->\s*\n\s*)?<button[^>]*data-set-cat="priv"[^>]*><\/button>\s*\n\s*<\/nav>/.test(html)
  && /setAttribute\("role", "switch"\)/.test(fnSrc("privPaint")) && /aria-checked/.test(fnSrc("privPaint")) && /PRIV = \(await window\.blave\.telemetrySet\(want\)\) === true/.test(src));
ok("隱私:會收 4 條、不收 6 條(含「事件紀錄不含 IP 位址」原話);關掉後清單留著、標題與尾句換掉", /PRIV_COLLECT = \[("priv\.collect\.[1-4]",? ?){4}\]/.test(src) && /PRIV_NEVER = \[("priv\.never\.[1-6]",? ?){6}\]/.test(src)
  && /msgid "priv\.never\.6"\nmsgstr "事件紀錄不含 IP 位址"/.test(PO[0]) && /msgid "priv\.never\.6"\nmsgstr "Event records contain no IP address"/.test(PO[1])
  && /off \? t\("priv\.collect\.hOff"\) : t\("priv\.collect\.h"\)/.test(src) && /off \? t\("priv\.kept"\) : t\("priv\.fine"\)/.test(src));
ok("隱私:會收那一條寫到 macOS 版本與系統語言;七個事件逐項對得上契約的白名單", /macOS 版本、系統語言/.test(PO[0]) && Object.keys(require("../shell/telemetry.js").EVENTS).length === 7 && /首次開啟、每日開啟、完成連結（哪一種 AI）、登入、第一次回測、啟動下單（模擬或真錢）、上雲端運行/.test(PO[0]));
ok("全 app 的字串不出現「匿名 / anonymous」;首次告知的 priv.notice* 沒有建", PO.every((x) => !/匿名|anonym/i.test(x.replace(/^#.*$/gm, ""))) && PO.every((x) => !/priv\.notice/.test(x)) && !/telemetryNoticed/.test(src));
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
