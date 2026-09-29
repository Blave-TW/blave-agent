// 內建瀏覽器「用系統瀏覽器開」(Wei 2026-09-28;設計師規格 designer-spec-browser-open-ext §1)。用假的 shell 與假分頁跑,不真的開瀏覽器。
//   1. IPC 只收分頁 id:網址由主行程從那個分頁自己拿(分頁當下的網址優先),renderer 傳什麼字串都不採信
//   2. 只開 http / https;file: / javascript: / data: / blob: / 自訂協定一律不開;網址帶帳密不開
//   3. 被判有危害的頁不開(相似網域、本機 / 內網位址、非標準埠、有危害的網站名單);敏感網域(交易所後台、銀行、登入授權頁)照開——那是用戶自己的瀏覽器
//   4. 等用戶確認的網址還沒放行:不開
//   5. 正常頁:shell.openExternal 被呼叫一次,網址等於分頁當下的網址;內建那一頁不關、不動
//   6. 畫面:鈕在網址列右端、只在單頁模式;停用條件;只送分頁 id;不是 agent 的工具
// 跑法:node tests/check_shell_browser_open_ext.js
const fs = require("fs"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const P = require(path.join(SHELL, "browser", "policy.js"));
const mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8"), idxSrc = fs.readFileSync(path.join(SHELL, "browser", "index.js"), "utf8"), br = fs.readFileSync(path.join(SHELL, "renderer", "browser.js"), "utf8");
const css = fs.readFileSync(path.join(SHELL, "renderer", "browser.css"), "utf8"), pre = fs.readFileSync(path.join(SHELL, "preload.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const fn = (src, name, pre2) => { const i = src.indexOf((pre2 || "function ") + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0; for (let k = src.indexOf("{", src.indexOf(")", i)); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("切不出 " + name); };

/* 真的主行程那一段:webUrl / openWebSafe 與 IPC 的處理函式從 main.js 原文切出來;externalUrl(id) 從 browser/index.js 原文切出來,
   配假的 shell、假的分頁表(tabs)與假的分頁(views:只有 wc.getURL / isDestroyed) */
function rig(tabList, liveOf) {
  const opened = [], touched = [];
  const tabs = { get: (id) => tabList.find((t) => t.id === id) || null, close: (id) => touched.push("close:" + id) };
  const views = { get: (id) => (id in liveOf ? { wc: { getURL: () => liveOf[id], isDestroyed: () => false, loadURL: () => touched.push("load:" + id), stop: () => touched.push("stop:" + id) } } : undefined) };
  const m = /\n    (externalUrl\(id\) \{[\s\S]*?\n    \}),\n/.exec(idxSrc); if (!m) throw new Error("找不到 index.js 的 externalUrl");
  const browser = new Function("tabs", "views", "policy", "return { " + m[1] + " };")(tabs, views, P);
  const h = /handle\("browser-open-external", (\(_e, id\) => \{[^\n]*\}), false\);/.exec(mainSrc); if (!h) throw new Error("找不到 main.js 的 browser-open-external");
  const handler = new Function("shell", "_browser", fn(mainSrc, "webUrl") + "\n" + fn(mainSrc, "openWebSafe") + "\nreturn " + h[1] + ";")({ openExternal: (u) => { opened.push(u); } }, browser);
  return { open: (arg) => handler({}, arg), opened, touched, browser };
}
const T = (o) => Object.assign({ id: "p1", url: "https://www.tradingview.com/chart/", by: "user", status: "ready", need: null, userDone: null }, o);

// ---- 1 / 5
{ const r = rig([T({})], { p1: "https://www.tradingview.com/chart/AbC123/?symbol=BINANCE%3ABTCUSDT.P" });
  ok("正常頁:回 true、shell.openExternal 一次、網址 = 分頁當下的網址(頁面自己換過網址之後的那一個)", r.open("p1") === true && r.opened.join() === "https://www.tradingview.com/chart/AbC123/?symbol=BINANCE%3ABTCUSDT.P", r.opened);
  ok("內建那一頁不關、不重新導覽、不停", r.touched.length === 0, r.touched); }
{ const r = rig([T({})], { p1: "https://www.tradingview.com/chart/" });
  const junk = ["https://evil.example/", { id: "p1" }, ["p1"], 1, null, undefined, "", "p9", "p1 ", "../p1"];
  ok("只收分頁 id:給網址、物件、陣列、數字、空值、不存在的 id 一律不開", junk.every((a) => r.open(a) === false) && r.opened.length === 0, r.opened);
  ok("renderer 給的字串從來不會被拿去開:處理函式只把它當 id 查分頁", /const u = _browser && typeof id === "string" \? _browser\.externalUrl\(id\) : null; return u \? openWebSafe\(u\) : false;/.test(mainSrc)
    && /browserOpenExternal: \(id\) => ipcRenderer\.invoke\("browser-open-external", id\)/.test(pre) && (br.match(/browserOpenExternal\(([^)]*)\)/g) || []).every((c) => c === "browserOpenExternal(x.id)")); }
{ const r = rig([T({ url: "https://example.com/a" })], {});
  ok("分頁已經不在(沒有 view)但有網址:用紀錄的那個", r.open("p1") === true && r.opened.join() === "https://example.com/a"); }
{ const r = rig([T({ url: "https://www.binance.com/en/my/dashboard", status: "blocked", reason: "sensitive_domain" })], { p1: "about:blank" });
  ok("被擋下的頁停在 about:blank:用紀錄的那個網址;敏感網域(交易所後台)照開", r.open("p1") === true && r.opened.join() === "https://www.binance.com/en/my/dashboard", r.opened); }
// ---- 2
{ const BAD = ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<b>x</b>", "blob:https://example.com/1", "blave://open", "vscode://file/x", "ftp://example.com/", "about:blank", "chrome://settings", "ws://example.com/", ""];
  const hits = BAD.filter((u) => { const r = rig([T({ url: u })], { p1: u }); return r.open("p1") !== false || r.opened.length; });
  ok("不是 http(s) 一律不開(file / javascript / data / blob / 自訂協定 / ftp / about / chrome / ws / 空)", hits.length === 0, hits);
  const CRED = ["https://user:pass@example.com/", "https://user@example.com/", "http://a:b@example.com/x"];
  ok("網址帶帳密不開", CRED.every((u) => { const r = rig([T({ url: u })], { p1: u }); return r.open("p1") === false && !r.opened.length; })); }
// ---- 3
{ P.AGENT_BLOCKLIST.push("harm.example");   // 名單今天是空的:放一個樣本進去驗規則,驗完拿掉
  const HARM = ["http://127.0.0.1:8000/", "http://localhost/", "http://192.168.1.1/", "http://10.0.0.5/admin", "https://example.com:8443/", "https://harm.example/", "https://sub.harm.example/x"];
  const lk = ["https://binance-login.xyz/", "https://www.tradinqview.com/", "https://blnance.com/"].filter((u) => P.external(u));
  const miss = HARM.filter((u) => { const r = rig([T({ url: u })], { p1: u }); return r.open("p1") !== false || r.opened.length; });
  ok("有危害的不開:本機 / 內網位址、非標準埠、有危害的網站名單", miss.length === 0, miss);
  P.AGENT_BLOCKLIST.pop();
  ok("相似網域不開(至少認得一個樣本)", lk.length >= 1 && lk.every((u) => { const r = rig([T({ url: u })], { p1: u }); return r.open("p1") === false; }), lk);
  const OKAY = ["https://www.binance.com/en/my/wallet", "https://accounts.google.com/o/oauth2/auth?client_id=x&redirect_uri=y", "https://blave.org/agent/zh", "https://www.tradingview.com/chart/", "http://example.com/"];
  ok("agent 不准碰、但對用戶沒有危害的照開:交易所後台、登入授權頁、blave.org、一般網站", OKAY.every((u) => { const r = rig([T({ url: u })], { p1: u }); return r.open("p1") === true && r.opened.join() === new URL(u).href; }), OKAY.filter((u) => P.external(u)));
  ok("不開的理由只有這六種;其餘(敏感網域、授權頁、blave、廣告)不在名單上", P.EXTERNAL_DENY.join() === "scheme,credentials_in_url,private_address,port,lookalike,blocklist"); }
// ---- 4
{ const held = T({ url: "https://example.com/?q=" + "x".repeat(50), need: { kind: "confirm" } });
  const r = rig([held], { p1: "https://example.com/" });
  ok("等用戶確認的網址還沒放行:不開;放行之後、或是別種等待(要登入):照開", r.open("p1") === false && (held.userDone = "open", r.open("p1")) === true && rig([T({ need: { kind: "login" } })], { p1: "https://www.tradingview.com/" }).open("p1") === true); }
// ---- 6
{ const can = new Function(fn(br, "brCanOpenExt") + "; return brCanOpenExt;")();
  ok("畫面上的鈕什麼時候可按:有 http(s) 網址(載入中、打不開也算)、敏感網域被擋 → 可以;沒有網址、等確認網址、可疑網址、有危害名單 → 停用",
    can({ url: "https://a.test/", ph: "load" }) && can({ url: "https://a.test/", fail: "dns" }) && can({ url: "https://www.binance.com/my", blocked: { kind: "domain", reason: "sensitive_domain" } }) && can({ url: "http://a.test/", need: { kind: "login" } })
    && !can({ url: "" }) && !can({}) && !can(null) && !can({ url: "about:blank" }) && !can({ url: "https://a.test/", need: { kind: "confirm" } })
    && !can({ url: "https://binance-login.xyz/", blocked: { kind: "addr", reason: "lookalike" } }) && !can({ url: "https://x.test/", blocked: { kind: "domain", reason: "blocklist" } }));
  const one = br.slice(br.indexOf("  const addr = brEl(\"div\", \"bv-addr\");\n  const rl = "), br.indexOf("  const slot = brEl(\"div\", \"bv-slot\");"));
  ok("鈕在網址列右端(重新載入｜網址欄｜這一顆｜它的說明泡泡);名稱 br.openSystem、說明 br.openSystem.tip 自家畫在 DOM 裡(不用 title,#207);停用不隱藏;只認用戶真的按;按了只送分頁 id 與埋點,不收回展開層", /addr\.append\(rl, url, ext, extTip\);/.test(one)
    && /const ext = brEl\("button", "ibtn ext"\); ext\.type = "button"; ext\.setAttribute\("aria-label", t\("br\.openSystem"\)\); ext\.append\(brIcon\("ext"\)\);/.test(one) && !/ext\.title/.test(one)
    && /const extTip = brEl\("span", "tip", t\("br\.openSystem\.tip"\)\); extTip\.id = "bv-ext-tip"; extTip\.setAttribute\("role", "tooltip"\); ext\.setAttribute\("aria-describedby", extTip\.id\);/.test(one) && /brTipAttach\(ext, extTip\);/.test(one)
    && /ext\.disabled = !brCanOpenExt\(x\);/.test(one) && !/ext\.hidden/.test(one)
    && /ext\.addEventListener\("click", \(e\) => \{ if \(!e\.isTrusted \|\| ext\.disabled\) return; trackFeature\("browser_open_ext"\); window\.blave\.browserOpenExternal\(x\.id\); \}\);/.test(one));
  const wall = br.slice(br.indexOf('  if (exp.mode === "wall") {'), br.indexOf('  const bv = brEl("div", "bv");')), snap = br.slice(br.indexOf('  if (exp.mode === "snap") {'), br.indexOf("  const x = BR.tabs.get(exp.id) || brTab(exp.id);"));
  ok("分頁牆與快照模式沒有這顆鈕", !/ibtn ext/.test(wall) && !/ibtn ext/.test(snap));
  ok("熱區:左右各外擴 2、上 1、下 8(✕ 在它正上方,熱區不重疊);重新載入那顆補上 tooltip", css.includes('.ibtn.ext::before { inset: -1px -2px -8px; }') && /rl\.title = t\("br\.reload"\);/.test(br));
  ok("擋下頁那顆「用系統瀏覽器開」跟 icon 鈕同一條規則:有危害名單上的網站不往外送", /brCanOpenExt\(x\) \? \{ label: t\("br\.openSystem"\), on: \(\) => \{ trackFeature\("browser_open_ext"\); window\.blave\.browserOpenExternal\(x\.id\); \} \}/.test(br));
  const tools = fs.readFileSync(path.join(SHELL, "browser", "tools.js"), "utf8") + fs.readFileSync(path.join(SHELL, "browser", "mcp.js"), "utf8");
  ok("這是用戶自己按的鈕,不是 agent 的工具:browser_* 工具清單沒有它", !/open_external|openExternal|open_ext|system_browser/i.test(tools));
  const TM = require(path.join(SHELL, "telemetry.js")).EVENTS.feature_used.name;
  ok("埋點 browser_open_ext:在白名單上、緊接在 tv_fail_compile 之後(0.1.9 起後面還有別的名字)、≤16 字;只記按了,不帶網址", TM[TM.indexOf("tv_fail_compile") + 1] === "browser_open_ext" && "browser_open_ext".length <= 16 && !/trackFeature\("browser_open_ext",/.test(br)); }
// 「你在操作」只在 agent 開的分頁
{ const userOp = new Function((br.match(/const brUserOp = [^\n]*/) || [""])[0] + "; return brUserOp;")();
  ok("「你在操作」只在 agent 開的分頁被用戶接手時出現;用戶自己開的分頁(送進 TradingView、開即時頁)不出現", userOp({ user: true, by: "agent" }) && userOp({ user: true }) && !userOp({ user: true, by: "user" }) && !userOp({ user: false, by: "agent" }) && !userOp(null)
    && /if \(brUserOp\(x\)\) \{\s*host\.append\(brIcon\("hand"\), brEl\("span", "t", t\("br\.userOp"\)\)\);/.test(br) && /if \(brUserOp\(x\)\) return t\("br\.userOp"\);/.test(br) && /if \(brUserOp\(x\)\) return brIcon\("hand"\);/.test(br));
  ok("渲染端知道分頁是誰開的:page_open 事件與展開的回傳都帶 by", /if \(ev\.by === "user" \|\| ev\.by === "agent"\) x\.by = ev\.by;/.test(br) && /brTab\(id\)\.by = res\.by;/.test(br)
    && (idxSrc.match(/return \{ id: t\.id, live: (true|false), by: t\.by,/g) || []).length === 2);
  ok("標題列一列:h5 後面接狀態句、右端 ✕;.txt 寫死高度(標題區高度不隨狀態變);狀態句太長只截文字那一段", css.includes(".bw-head { flex: none; display: flex; align-items: center;")
    && css.includes(".bw-head .txt { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-12); height: 21px; }") && css.includes(".bw-stat .t { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }")
    && /txt\.append\(brEl\("h5", "", t\("br\.h"\)\), stat\); head\.append\(txt, x0\);/.test(br)); }
console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
