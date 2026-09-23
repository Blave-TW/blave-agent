// shell/traytext.js:視窗之外的字(選單列的狀態行、結束確認框多的那一句、通知標題的前綴)。
// 雲端那一行的資料來自雲端主機的回報 = 不可信輸入。跑法:node tests/check_shell_traytext.js
const fs = require("fs"), path = require("path");
const { clean, cloudLine, cloudTrading, statusLine, notifTitle, quitDetail } = require("../shell/traytext.js");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const after = [];   // 非同步的那幾條:檔尾等它們跑完再結算
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
{ // 選單列圖示旁不放任何小點(Wei 09-23):本機新版、雲端新版都不點;「新版已下載」那一行留在選單裡
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"), tt = require("../shell/traytext.js");
  t("選單列圖示旁沒有小點:main.js 不呼叫 setTitle;雲端那條規則不留死碼;選單的「新版已下載」照留", !/\.setTitle\(/.test(mainSrc)
    && !/cloudUpdateWaiting|cloudNeedsUpdate/.test(mainSrc) && !("cloudNeedsUpdate" in tt) && /updateWaiting\(\) \? \[\{ label: tmLabels\.updateReady/.test(mainSrc)); }
{ // 連上的規則(Wei 09-23):pair 沒帶 = 連上,只有 pair: false 不算;main.js 的 venueReady 同一條
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
  const S = (v) => ({ alive: true, running: true, cloud: { code: "OK", machine: { state: "running" } }, report: { venues: { paper: v }, reconciler: { alive: true } } });
  t("連上的規則(稽核 S-2 撤回放寬):四個欄位都要;缺 pair 或 pair: false 都不算連上,三處同一條", cloudLine(S({ credentials: true, pair: true, order: true, account: true })) !== null
    && cloudLine(S({ credentials: true, order: true, account: true })) === null && cloudLine(S({ credentials: true, pair: false, order: true, account: true })) === null
    && /const venueReady = \(v\) => !!\(v && v\.credentials && v\.pair && v\.order && v\.account\);/.test(mainSrc)
    && !/pair !== false/.test(mainSrc) && !/pair !== false/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "traytext.js"), "utf8"))); }
{ // 稽核 B1:「解除暫停」送的也是 resume,但不是開始下單——不可以記成 trade_started(污染開機漏斗)
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "shell", "preload.js"), "utf8");
  const tr = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");
  t("B1 解除暫停不記「開始下單」:主行程看 intent、preload 帶得過去、renderer 送 resume 時標 release",
    /if \(\(cmd === "resume" \|\| cmd === "resume_wait"\) && intent !== "release"\) Promise\.resolve\(out\)/.test(mainSrc)
    && /tradeSend: \(cmd, args, requestId, intent\) => ipcRenderer\.invoke\("trade-send", cmd, args, requestId, intent\),/.test(preload)
    && /ipcMain\.handle\("trade-send", async \(e, cmd, args, _requestId, intent\) =>/.test(mainSrc)
    && /trSend\(S, "resume", \{\}, "release"\)/.test(tr) && (mainSrc.match(/trade_started/g) || []).length === 1); }
{ /* 稽核 R1:整條鏈一段都不 mock —— trAskRelease → trSend → envApi(local)→ **真的 preload.js** → main.js 的遙測判斷式。
     上一版從 preload 起跳,漏掉 envApi 那一段(`o[k] = (...a) => host[k](...a)`):把它改成只轉兩個參數,35 支測試照樣全綠,
     行為卻退回 B1(解除暫停被記成開始下單)。起點往上搬一層,那一段就被蓋住了 */
  const vm = require("vm"), R = path.join(__dirname, "..", "shell");
  const trSrc = fs.readFileSync(path.join(R, "renderer", "trade.js"), "utf8"), mainSrc = fs.readFileSync(path.join(R, "main.js"), "utf8");
  // ① 真的 preload.js,只把 electron 換成記錄器
  const invoked = []; let api = null;
  const pctx = { require: (m) => (m === "electron" ? { contextBridge: { exposeInMainWorld: (_k, o) => { api = o; } }, ipcRenderer: { invoke: (...a) => { invoked.push(a); return Promise.resolve({ ok: true }); }, on: () => {}, send: () => {} } } : require(m)), console };
  vm.createContext(pctx); vm.runInContext(fs.readFileSync(path.join(R, "preload.js"), "utf8"), pctx);
  // ② 真的 renderer:ENV_API / envApi / trSend / trAskRelease,其餘依賴給最小替身
  const body = (n) => { const i2 = trSrc.indexOf("function " + n + "("); let d = 0, k = trSrc.indexOf("{", i2); for (; k < trSrc.length; k++) { if (trSrc[k] === "{") d++; else if (trSrc[k] === "}" && --d === 0) break; } return trSrc.slice(i2, k + 1); };
  const pick = (re) => trSrc.match(re)[0];
  const env = { console, t: (k) => k, srSay: () => {}, trCloudBox: (o) => o, confirmBox: (o) => { env.box = o; }, host: api,
    trReport: () => ({ halt: { halted: true }, venues: { paper: { credentials: 1, pair: 1, order: 1, account: 1 } } }),
    trRun: (want, steps, cmd) => { env.ran = { want, cmd }; return Promise.all(steps.map((f) => f(env.TR))); } };
  vm.createContext(env);
  vm.runInContext([pick(/const ENV_API = \[[^\]]*\];/), pick(/const ENV_CLOUD_CMDS = \[[^\]]*\];/), body("envApi"), body("envCloudList"),
    trSrc.slice(trSrc.indexOf("async function trSend("), trSrc.indexOf("\n/* 送「會改變執行狀態」的指令")),
    body("trHaltStopsAll"), body("trReleaseKind"), body("trRestartStopped"), body("trRestartUnconfirmed"), body("trNoAccountStopped"),
    body("trHasAccount"), body("trCanonKey"), body("trMs"), body("trAskRelease")].join("\n"), env);
  vm.runInContext("TR = { env: 'local', pending: null, sending: {}, reqIds: {}, api: envApi('local', host) }", env);
  vm.runInContext("trAskRelease(null)", env);
  // ③ main.js 的參數表與遙測判斷式,逐字切出來跑
  const params = mainSrc.match(/ipcMain\.handle\("trade-send", async \(([^)]*)\) =>/)[1];
  const i0 = mainSrc.indexOf('if ((cmd === "resume"');
  const cond = mainSrc.slice(i0, mainSrc.indexOf(") Promise.resolve(out)", i0) + 1).replace(/^if /, "");
  const tracks = new Function(params, "return !!" + cond + ";");
  const fires = (a) => tracks.apply(null, [{}].concat((a || []).slice(1)));
  after.push(Promise.resolve(env.box && env.box.onOk()).then(() => {
    const rel = invoked[0]; invoked.length = 0;
    return vm.runInContext("trSend(TR, 'resume', {})", env).then(() => {
      t("R1 全鏈(trAskRelease → trSend → envApi → 真的 preload → main 判斷式):解除暫停帶著 release 送到主行程、不記「開始下單」;啟動下單照記",
        JSON.stringify(rel) === '["trade-send","resume",{},null,"release"]' && fires(rel) === false
        && JSON.stringify(invoked[0]) === '["trade-send","resume",{},null,null]' && fires(invoked[0]) === true);
    });
  })); }
{ // 稽核 S-6:圖示旁的點拿掉之後,雲端落後只剩選單列這一行
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"), tt = require("../shell/traytext.js");
  const L = { cloudUpdate: "雲端主機有新版 {nv}，打開 Blave 更新…", cloudUpdateStale: "雲端的下單程式需要更新，打開 Blave 更新…" };
  const C2 = (cv, lv, stopped, state) => ({ cloud: { code: "OK", machine: { state: state || "running" }, config_version: cv, latest_config_version: lv }, report: { reconciler: { stopped: stopped || undefined } } });
  t("S-6 版號落後 → 帶新版號那一行;版號一樣但重開沒停住(gated === false 嚴格)→ 需要更新那一句;其餘 null",
    tt.cloudUpdateLine(L, C2("1.1.80", "1.1.83")) === "雲端主機有新版 1.1.83，打開 Blave 更新…"
    && tt.cloudUpdateLine(L, C2("1.1.83", "1.1.83", { reason: "machine_restart", gated: false })) === L.cloudUpdateStale
    && tt.cloudUpdateLine(L, C2("1.1.83", "1.1.83")) === null && tt.cloudUpdateLine(L, C2("1.1.83", "1.1.83", { reason: "machine_restart", gated: true })) === null
    && tt.cloudUpdateLine(L, C2("1.1.83", "1.1.83", { reason: "machine_restart" })) === null && tt.cloudUpdateLine(L, C2("1.1.83", "1.1.83", { reason: "machine_restart", gated: 0 })) === null
    && tt.cloudUpdateLine(L, C2("1.1.80", "1.1.83", null, "stopped")) === null && tt.cloudUpdateLine(L, null) === null);
  t("S-6 字還沒交過來就不顯示(不出英文預設)", tt.cloudUpdateLine({}, C2("1.1.80", "1.1.83")) === null && tt.cloudUpdateLine({}, C2("1.1.83", "1.1.83", { reason: "machine_restart", gated: false })) === null);
  t("S-6 選單有那一行、點了開設定 › 一般、也進重畫簽章;字有交、預設物件也有",
    /\.\.\.\(cu \? \[\{ label: cu, click: openAbout \}\] : \[\]\),/.test(mainSrc) && /const cloud = trayCloudLine\(\), cu = trayCloudUpdate\(\);/.test(mainSrc)
    && /trayCloudLine\(\) \|\| "", trayCloudUpdate\(\) \|\| ""\]\.join\("\|"\)/.test(mainSrc)
    && /w\.webContents\.send\("open-about"\)/.test(mainSrc) && /cloudUpdate: "Cloud machine: new version \{nv\}/.test(mainSrc)
    && /window\.blave\.onOpenAbout\(\(\) => \{ if \(running\) \{ addMsg\("sys", t\("up\.busy"\)\); return; \} setOpen\(\); \}\);/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8"))); }
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
Promise.all(after).then(() => { console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0); });
