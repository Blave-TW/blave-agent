// shell/traytext.js:視窗之外的字(選單列的狀態行、結束確認框多的那一句、通知標題的前綴)。
// 雲端那一行的資料來自雲端主機的回報 = 不可信輸入。跑法:node tests/check_shell_traytext.js
const fs = require("fs"), path = require("path");
const { clean, cloudLine, cloudTrading, cloudNeedsUpdate, statusLine, notifTitle, quitDetail } = require("../shell/traytext.js");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const V = { credentials: true, pair: true, order: true, account: true };
const st = (o = {}) => ({ alive: true, cloud: { code: "OK", machine: { state: "running" } }, report: { venues: { binance: V }, halt: { halted: false }, reconciler: { alive: true } }, ...o });
const L = { moneyPaper: "模擬", moneyReal: "真錢", stOn: "執行中", stPaused: "已暫停", stUnknown: "讀不到狀態" };
const TPL = "雲端：{money} · {state}";
const j = (x) => JSON.stringify(x);

t("雲端在下單:真錢 · 執行中", j(cloudLine(st())) === '{"money":"real","state":"on"}' && statusLine(TPL, cloudLine(st()), L) === "雲端：真錢 · 執行中");
t("只有模擬帳戶 → 模擬;混著真的 → 真錢", cloudLine(st({ report: { venues: { paper: V }, reconciler: { alive: true } } })).money === "paper" && cloudLine(st({ report: { venues: { paper: V, okx: V }, reconciler: { alive: true } } })).money === "real");
t("已暫停", cloudLine(st({ report: { venues: { binance: V }, halt: { halted: true }, reconciler: { alive: true } } })).state === "paused");
t("讀不到新狀態(alive=false:連不上 / 回報過舊)→ 不講執行中也不講已暫停", cloudLine(st({ alive: false })).state === "unknown" && cloudLine(st({ alive: false, report: { venues: { binance: V }, halt: { halted: true } } })).state === "unknown");
t("主機重開後對帳器停著(reconciler.stopped.reason = machine_restart)→ 已暫停(同畫面),不是不明",
  cloudLine(st({ report: { venues: { binance: V }, reconciler: { alive: false, stopped: { reason: "machine_restart", at: 1 } } } })).state === "paused"
  && cloudLine(st({ report: { venues: { binance: V }, reconciler: { alive: false, stopped: { reason: "other" } } } })).state === "unknown"
  && cloudLine(st({ alive: false, report: { venues: { binance: V }, reconciler: { alive: false, stopped: { reason: "machine_restart" } } } })).state === "unknown");
{ const Cg = (o, halt) => st({ report: { venues: { binance: V }, halt: halt || {}, reconciler: { alive: false, stopped: { reason: "machine_restart", at: 1, ...o } } } });
  const LL = { ...L, stMayTrade: "可能仍在下單" };
  t("主機重開沒停住(gated === false 嚴格)→ 可能仍在下單:「雲端：真錢 · 可能仍在下單」;結束確認框不替它背書(cloudTrading false)",
    cloudLine(Cg({ gated: false })).state === "mayTrade" && statusLine(TPL, cloudLine(Cg({ gated: false })), LL) === "雲端：真錢 · 可能仍在下單" && cloudTrading(Cg({ gated: false })) === false);
  t("…已按暫停 → 已暫停;gated true / 缺欄位 → 已暫停;缺 stMayTrade 那個字 → 整行不顯示",
    cloudLine(Cg({ gated: false }, { halted: true })).state === "paused" && cloudLine(Cg({ gated: true })).state === "paused" && cloudLine(Cg({})).state === "paused"
    && statusLine(TPL, cloudLine(Cg({ gated: false })), L) === null); }
{ const N = (cv, lv, stopped, state) => ({ cloud: { code: "OK", machine: { state: state || "running" }, config_version: cv, latest_config_version: lv }, report: { reconciler: { stopped } } });
  const R = (g) => ({ reason: "machine_restart", at: 1, gated: g });
  t("選單列小點(雲端有新版在等):版號落後亮;版號一樣但重開沒停住(gated === false 嚴格)也亮——同 upPlan",
    cloudNeedsUpdate(N("1.1.80", "1.1.83", null)) === true && cloudNeedsUpdate(N("1.1.83", "1.1.83", R(false))) === true
    && cloudNeedsUpdate(N("1.1.83", "1.1.83", null)) === false && cloudNeedsUpdate(N("1.1.83", "1.1.83", R(true))) === false && cloudNeedsUpdate(N("1.1.83", "1.1.83", R(undefined))) === false);
  t("…主機沒在跑 / 讀不到:不亮", cloudNeedsUpdate(N("1.1.80", "1.1.83", R(false), "stopped")) === false && cloudNeedsUpdate(null) === false && cloudNeedsUpdate({ cloud: { code: "OFFLINE" } }) === false);
  t("main.js 的小點走這一支(不另寫一份規則)", /const cloudUpdateWaiting = \(\) => TT\.cloudNeedsUpdate\(cloudSt\(\)\);/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"))); }
{ // T1:主行程只收預設物件裡已經有的 key(for k of Object.keys(tmLabels)):畫面交過來、預設沒有的字會被靜靜丟掉
  // (例:少了 stMayTrade,選單列的雲端那一行就在最該講話的狀態整行消失)。列舉 trPushLabels 交的每一個 key
  const tr = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8"), mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
  const a = tr.indexOf("window.blave.tradeLabels({"), b = tr.indexOf("});", a);
  const body = tr.slice(a + "window.blave.tradeLabels(".length, b + 1).replace(/,\s*\{(?:[^{}"]|"[^"]*")*\}\)/g, ")");   // t("…", { where: … }) 裡的代入值不是 key
  const pushed = [...body.matchAll(/([A-Za-z_]\w*): /g)].map((m) => m[1]).filter((k) => k !== "lang");   // lang 另外收(main.js 直接讀 labels.lang)
  const i = mainSrc.indexOf("let tmLabels = {"), j = mainSrc.indexOf("};", i), defs = new Set([...mainSrc.slice(i, j).matchAll(/([A-Za-z_]\w*): /g)].map((m) => m[1]));
  const missing = pushed.filter((k) => !defs.has(k));
  t("T1 trPushLabels 交的每一個字,tmLabels 預設物件裡都有那個 key(不然主行程收不下)" + (missing.length ? ":缺 " + missing.join() : ""), pushed.length > 40 && missing.length === 0
    && /for \(const k of Object\.keys\(tmLabels\)\)/.test(mainSrc) && /labels\.lang === "zh"/.test(mainSrc));
  // 反方向(round-2 稽核 T1):選單列用到的每一個字,畫面都要交——預設物件有但沒人交,換語言後那一行就停在英文預設
  // (更糟的是 stMayTrade:預設是英文,zh 用戶在 C 裡看到的是英文)。列舉 traytext.js 的 labels.* 與 main.js 的 tmLabels.st*
  const trayUsed = [...new Set([...fs.readFileSync(path.join(__dirname, "..", "shell", "traytext.js"), "utf8").matchAll(/\blabels\.([A-Za-z_]\w*)/g)].map((m) => m[1])
    .concat([...mainSrc.matchAll(/\btmLabels\.(st[A-Z]\w*)/g)].map((m) => m[1])))].filter((k) => k !== "lang");
  const unpushed = trayUsed.filter((k) => pushed.indexOf(k) < 0);
  t("T1 反方向:選單列用到的每一個字(含 stMayTrade)trPushLabels 都有交" + (unpushed.length ? ":沒交 " + unpushed.join() : ""), trayUsed.length >= 6 && trayUsed.indexOf("stMayTrade") >= 0 && unpushed.length === 0 && trayUsed.every((k) => defs.has(k))); }
t("對帳器心跳不在 → 不講執行中", cloudLine(st({ report: { venues: { binance: V }, reconciler: { alive: false } } })).state === "unknown");
t("沒有可講的 → null(整行不顯示):沒登入、沒主機、啟動中、停機、沒回報、沒連好交易所、還沒問到", [null, undefined, {}, st({ cloud: { code: "NO_LOGIN" } }), st({ cloud: { code: "OK", machine: { state: "none" } } }), st({ cloud: { code: "OK", machine: { state: "starting" } } }),
  st({ cloud: { code: "OK", machine: { state: "stopped" } } }), st({ report: null }), st({ report: { venues: {} } }), st({ report: { venues: { binance: { credentials: true } } } }), st({ report: "x" }), st({ report: { venues: "x" } })].every((s) => cloudLine(s) === null));
t("結束確認框那一句:只有「確定在下單」才說(那一句是在替雲端做保證)", cloudTrading(st()) === true && cloudTrading(st({ alive: false })) === false && cloudTrading(st({ report: { venues: { binance: V }, halt: { halted: true }, reconciler: { alive: true } } })) === false && cloudTrading(null) === false);

// 不可信輸入
t("場所 id 長得不像 id 的不算(雲端主機寫得進去的字串不拿來判斷、更不顯示)", cloudLine(st({ report: { venues: { "<img src=x>": V, "A B": V, ["x".repeat(40)]: V }, reconciler: { alive: true } } })) === null);
t("輸出只由我們自己的字組成:回報裡塞什麼字串都進不了那一行", (() => { const s = st(); s.report.halt = { halted: false, source: "‮gnp.exe", at: "<b>" }; s.report.venues.binance.label = "EVIL"; s.cloud.machine.os_type = "EVIL"; const out = statusLine(TPL, cloudLine(s), L); return out === "雲端：真錢 · 執行中"; })());
t("clean:控制字元、零寬、bidi 覆寫、換行都拿掉;過長截斷", clean("a\u0000b\nc‮d​e", 40) === "a b c d e" && clean("x".repeat(100), 10).length === 10 && clean("x".repeat(100), 10).endsWith("…") && clean(5) === "" && clean(null) === "");
t("字還沒交(任何一個要用到的是空的)→ 整行不顯示,不拿英文硬湊", statusLine("", cloudLine(st()), L) === null && statusLine(TPL, cloudLine(st()), { ...L, stOn: "" }) === null && statusLine(TPL, cloudLine(st()), { ...L, moneyReal: "" }) === null && statusLine(TPL, null, L) === null && statusLine(TPL, cloudLine(st()), null) === null);
t("字本身帶控制字元(renderer 交來的也過一次 clean)", statusLine("雲端：{money}\n· {state}", cloudLine(st()), L) === "雲端：真錢 · 執行中");
t("通知標題的前綴:有才加;結束框的那一句:有才加、隔一行", notifTitle("這台電腦：", "下單失敗") === "這台電腦：下單失敗" && notifTitle("", "下單失敗") === "下單失敗" && quitDetail("A", "B") === "A\n\nB" && quitDetail("A", "") === "A");

// 接線(main.js 原文)
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
t("main.js:選單列不為了雲端那一行去啟動輪詢(雲端宿主沒啟動過 = 沒有那一行)", /const cloudSt = \(\) => \(_cloud && _cloud\.isRunning\(\) \? _cloud\.status\(\) : null\);/.test(src) && !/cloudSt = [^\n]*cloudHost\(\)/.test(src));
t("main.js:雲端那一行進 trayKey(狀態變了才會重畫)", /const key = live \? \[[^\]]*trayCloudLine\(\) \|\| ""[^\]]*\]\.join/.test(src));
t("main.js:暫停只給這台電腦——選單列、Dock、失敗框三處都用 pauseLabel(),而且都只送本機的 halt", (src.match(/pauseLabel\(\)/g) || []).length >= 4 && !/label: tmLabels\.pause,/.test(src) && (src.match(/click: pauseFromMenu/g) || []).length === 2);
t("main.js:本機 P1 通知與暫停通知的標題都過前綴", (src.match(/TT\.notifTitle\(tmLabels\.notifPrefixLocal,/g) || []).length === 2 && !/new Notification\(\{ title: tmLabels\["ev_"/.test(src));
t("main.js:結束確認框多的那一句只在雲端確定在下單時加", /TT\.quitDetail\([^\n]*TT\.cloudTrading\(cloudSt\(\)\) \? tmLabels\.quitCloudNote : ""\)/.test(src));
t("main.js:app 選單的兩個視角送 env-switch,只送自家頁面、只有兩個固定值", /envSwitchFromMenu\("local"\)/.test(src) && /envSwitchFromMenu\("cloud"\)/.test(src) && (src.match(/envSwitchFromMenu\(/g) || []).length === 3 && /isOurPageUrl\(w\.webContents\.getURL\(\)\)\) w\.webContents\.send\("env-switch", env\)/.test(src));
t("main.js:官網入口是固定常數、語言段只有兩個值(renderer 交來的 lang 走白名單)", /const SITE_URL = \{ zh: "https:\/\/blave\.org\/zh", en: "https:\/\/blave\.org\/en" \};/.test(src) && /if \(labels\.lang === "zh" \|\| labels\.lang === "en"\) uiLang = labels\.lang;/.test(src) && /shell\.openExternal\(SITE_URL\[siteLang\(\)\]\)/.test(src));
t("main.js:發佈版的選單不放重新載入與開發者工具", /const dev = !\(app\.isPackaged && require\("\.\/package\.json"\)\.blaveRelease\);/.test(src) && /\.\.\.\(dev \? \[\{ role: "reload" \}/.test(src));
t("main.js:選單保留編輯選單(沒有它,輸入框的複製貼上快捷鍵會失效)", /\{ role: "editMenu" \}/.test(src) && /\{ role: "appMenu" \}/.test(src) && /\{ role: "windowMenu" \}/.test(src));
const pre = fs.readFileSync(path.join(__dirname, "..", "shell", "preload.js"), "utf8");
t("preload:renderer 待接的三個入口都在", /minVersionState:/.test(pre) && /onMinVersionState:/.test(pre) && /onEnvSwitch:/.test(pre));
// app 選單不中英混語:自家的 label 走 app 的 i18n(renderer 交字),Electron 內建 role 的項目不自訂 label
{ const fs = require("fs"), path = require("path");
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"), a = mainSrc.indexOf("function appMenuSync()"), body = mainSrc.slice(a, mainSrc.indexOf("\n}\n", a)).replace(/\/\/.*$/gm, "");
  const labels = [...body.matchAll(/label:\s*([^,}]+)/g)].map((m) => m[1].trim());
  t("app 選單:每一個自家 label 都來自 tmLabels(英文只當還沒交字之前的退路),沒有寫死的字", labels.length === 4 && labels.every((l) => /^tmLabels\.menu(View|Local|Cloud|Site) \|\| "[^"]+"$/.test(l)));
  t("app 選單:帶 role 的項目都沒有自訂 label", [...body.matchAll(/\{[^{}]*role:[^{}]*\}/g)].every((m) => !/label:/.test(m[0])));
  t("換語言會重建選單(四個字都進 key);renderer 交 menuView", /\[tmLabels\.menuLocal, tmLabels\.menuCloud, tmLabels\.menuSite, tmLabels\.menuView\]\.join/.test(body)
    && /menuView: t\("menu\.view"\)/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8")) && /menuView: ""/.test(mainSrc)); }
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
