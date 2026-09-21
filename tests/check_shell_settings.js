// 設定 modal 的兩塊畫面邏輯(shell/renderer/app.js):「關於」的更新狀態(upPaint 七種 phase)、帳號區兩態(acctPaintAcct)。
// 從原文切出函式,配一個最小的假 DOM 跑。跑法:node tests/check_shell_settings.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "app.js"), "utf8"), html = fs.readFileSync(path.join(R, "index.html"), "utf8"), css = fs.readFileSync(path.join(R, "app.css"), "utf8");
const fnSrc = (name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); return src.slice(i, src.indexOf("\n}", i) + 2); };
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };
const el = () => { const cls = new Set(["btn-quiet"]); return { textContent: "", hidden: false, onclick: null, classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), has: (c) => cls.has(c) } }; };
const dom = {}; const $ = (id) => dom[id] || (dom[id] = el());
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

// 帳號區
hasToken = false; acctPaintAcct();
ok("未登入:整塊還在——Blave 帳號 / 未登入 / 登入 Blave", $("set-acct-who").textContent === "acct.lbl" && $("set-acct-st").textContent === "acct.signedOut" && $("set-acct-btn").textContent === "cn.blave.btn" && !/set-acct"\)\.hidden/.test(src) && !/id="set-acct"[^>]*hidden/.test(html));
hasToken = true; acctPaintAcct();
ok("已登入:已登入 / 登出", $("set-acct-st").textContent === "acct.signedIn" && $("set-acct-btn").textContent === "acct.out");
ok("那顆鈕吃 .set-cat 的樣子但不是分類:沒有 data-set-cat、點了不會被當成換分類(會把每一頁都藏起來)", /<button type="button" class="set-cat" id="set-acct-btn"><\/button>/.test(html) && /if \(b && b\.dataset\.setCat\) setCat\(/.test(src));
ok("未登入時走現有的登入流程(planLogin),不另寫一條", /if \(!hasToken\) \{ await planLogin\(\);/.test(src) && (src.match(/startOAuth\(/g) || []).length === 4);   // 4 = HEAD 既有的次數:帳號區沒有多開一條
ok("CSS:舊的三條規則與 .set-up 樣式清掉", !/\.set-acct \.(lbl|mail|btn-quiet)|\.set-up-txt|\.set-up \.btn-quiet/.test(css));
ok("字標拿掉:DOM / CSS / 程式都沒有 .ws-brand 與 #ws-home;收合鈕上距 12", !/ws-brand|ws-home/.test(html + css + src) && /html\.ws-sc \.side-rail \{[^}]*padding-top: var\(--space-12\);/.test(css));
ok("分隔線:帳號區上面、「關於」上面、AI 接入頁列間那三條拿掉;標題列下緣、左右欄直線、方案頁的腳留著", !/\.set-acct\{[^}]*border-top/.test(css) && !/\.set-about \{[^}]*border-top/.test(css) && !/\.cn-row \+ \.cn-row/.test(css)
  && /\.modal-head \{[^}]*border-bottom/.test(css) && /\.set-cats\s*\{[^}]*border-right/.test(css) && /\.plan-foot\s*\{[^}]*border-top/.test(css));
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
