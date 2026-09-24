// shell/traytext.js:視窗之外的字(選單列的狀態行、結束確認框多的那一句、通知標題的前綴)。
// 雲端那一行的資料來自雲端主機的回報 = 不可信輸入。跑法:node tests/check_shell_traytext.js
const fs = require("fs"), path = require("path");
const { clean, cloudLine, cloudTrading, statusLine, notifTitle, quitDetail, venueLabel } = require("../shell/traytext.js");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const after = [];   // 非同步的那幾條:檔尾等它們跑完再結算
const V = { credentials: true, pair: true, order: true, account: true };
const st = (o = {}) => ({ alive: true, cloud: { code: "OK", machine: { state: "running" } }, report: { venues: { binance: V }, halt: { halted: false }, reconciler: { alive: true } }, ...o });
const L = { moneyPaper: "模擬", moneyReal: "真錢", stOn: "執行中", stPaused: "已暫停", stUnknown: "讀不到狀態" };
const TPL = "雲端：{money} · {state}";
const j = (x) => JSON.stringify(x);

t("雲端在下單:Binance · 執行中(Wei 0.0.6:{money} 槽寫交易所名,不寫「真錢」)", j(cloudLine(st())) === '{"money":"real","venue":"binance","state":"on"}' && statusLine(TPL, cloudLine(st()), L) === "雲端：Binance · 執行中");
t("只有模擬帳戶 → 模擬(記號寫「模擬」);混著真的 → real、venue 是排序後第一家真的", cloudLine(st({ report: { venues: { paper: V }, reconciler: { alive: true } } })).money === "paper"
  && statusLine(TPL, cloudLine(st({ report: { venues: { paper: V }, reconciler: { alive: true } } })), L) === "雲端：模擬 · 執行中"
  && j(cloudLine(st({ report: { venues: { paper: V, okx: V }, reconciler: { alive: true } } }))) === '{"money":"real","venue":"okx","state":"on"}');
t("交易所名照表(OKX / Gate.io / BingX 不是首字大寫);表外 id 首字大寫;長得不像 id 的回空;舊呼叫端沒帶 venue → 退回「真錢」",
  statusLine(TPL, { money: "real", venue: "okx", state: "on" }, L) === "雲端：OKX · 執行中" && statusLine(TPL, { money: "real", venue: "gateio", state: "on" }, L) === "雲端：Gate.io · 執行中"
  && statusLine(TPL, { money: "real", venue: "bingx", state: "on" }, L) === "雲端：BingX · 執行中" && statusLine(TPL, { money: "real", venue: "kraken", state: "on" }, L) === "雲端：Kraken · 執行中"
  && venueLabel("<b>") === "" && venueLabel("A B") === "" && venueLabel(5) === "" && statusLine(TPL, { money: "real", state: "on" }, L) === "雲端：真錢 · 執行中");
t("已暫停", cloudLine(st({ report: { venues: { binance: V }, halt: { halted: true }, reconciler: { alive: true } } })).state === "paused");
t("讀不到新狀態(alive=false:連不上 / 回報過舊)→ 不講執行中也不講已暫停", cloudLine(st({ alive: false })).state === "unknown" && cloudLine(st({ alive: false, report: { venues: { binance: V }, halt: { halted: true } } })).state === "unknown");
t("主機重開後對帳器停著(reconciler.stopped.reason = machine_restart)→ 已暫停(同畫面),不是不明",
  cloudLine(st({ report: { venues: { binance: V }, reconciler: { alive: false, stopped: { reason: "machine_restart", at: 1 } } } })).state === "paused"
  && cloudLine(st({ report: { venues: { binance: V }, reconciler: { alive: false, stopped: { reason: "other" } } } })).state === "notStarted"
  && cloudLine(st({ alive: false, report: { venues: { binance: V }, reconciler: { alive: false, stopped: { reason: "machine_restart" } } } })).state === "unknown");
{ const Cg = (o, halt) => st({ report: { venues: { binance: V }, halt: halt || {}, reconciler: { alive: false, stopped: { reason: "machine_restart", at: 1, ...o } } } });
  const LL = { ...L, stMayTrade: "可能仍在下單" };
  t("主機重開沒停住(gated === false 嚴格)→ 可能仍在下單:「雲端：真錢 · 可能仍在下單」;結束確認框不替它背書(cloudTrading false)",
    cloudLine(Cg({ gated: false })).state === "mayTrade" && statusLine(TPL, cloudLine(Cg({ gated: false })), LL) === "雲端：Binance · 可能仍在下單" && cloudTrading(Cg({ gated: false })) === false);
  t("…已按暫停 → 已暫停;gated true / 缺欄位 → 已暫停;缺 stMayTrade 那個字 → 整行不顯示",
    cloudLine(Cg({ gated: false }, { halted: true })).state === "paused" && cloudLine(Cg({ gated: true })).state === "paused" && cloudLine(Cg({})).state === "paused"
    && statusLine(TPL, cloudLine(Cg({ gated: false })), L) === null); }
{ // 「讀不到狀態」只給真的讀不到(連不上 / 回報過舊);讀得到、對帳器只是沒在跑 = 雲端頁同一句「尚未啟動下單」(trade.js trStateText 的 dead)
  const S = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "strings.js"), "utf8");
  const zh = (k) => { const i = S.indexOf("zh:"), m = new RegExp('"' + k.replace(/\./g, "\\.") + '": "([^"]*)"').exec(S.slice(i)); return m && m[1]; };
  const en = (k) => { const m = new RegExp('"' + k.replace(/\./g, "\\.") + '": "([^"]*)"').exec(S.slice(0, S.indexOf("zh:"))); return m && m[1]; };
  const LZ = { moneyReal: "真錢", moneyPaper: "模擬", stOn: zh("tm.stOn"), stPaused: zh("tm.stPaused"), stUnknown: zh("tm.stUnknown"), stNotStarted: zh("tr.notStarted") };
  const idle = st({ report: { venues: { binance: V }, halt: { halted: false }, reconciler: { alive: false, heartbeat_at: 5 } } });
  const gone = st({ alive: false, report: { venues: { binance: V }, halt: { halted: false }, reconciler: { alive: false } } });
  t("讀得到、下單程式沒在跑 → 「雲端：Binance · 尚未啟動下單」(跟雲端頁同一句,不是讀不到狀態)", cloudLine(idle).state === "notStarted" && statusLine(TPL, cloudLine(idle), LZ) === "雲端：Binance · 尚未啟動下單");
  t("讀不到(alive=false)→ 照舊「雲端：Binance · 讀不到狀態」", cloudLine(gone).state === "unknown" && statusLine(TPL, cloudLine(gone), LZ) === "雲端：Binance · 讀不到狀態");
  t("兩條路的字不一樣(zh / en 都是):同一份報告只差 alive", zh("tr.notStarted") !== zh("tm.stUnknown") && en("tr.notStarted") && en("tr.notStarted") !== en("tm.stUnknown"));
  t("尚未啟動不替雲端背書(結束確認框不說雲端在下單)", cloudTrading(idle) === false);
  const trSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8"), mainSrc2 = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
  t("接線:renderer 交 stNotStarted = tr.notStarted(雲端頁那一句);主行程的 tmLabels 有這個 key(沒有的話 trade-labels 會把它濾掉)",
    /stNotStarted: t\("tr\.notStarted"\)/.test(trSrc) && /\bstNotStarted: ""/.test(mainSrc2.slice(mainSrc2.indexOf("let tmLabels = {"), mainSrc2.indexOf("};", mainSrc2.indexOf("let tmLabels = {")))));
  t("缺 stNotStarted 那個字 → 整行不顯示(不拿讀不到狀態頂替)", statusLine(TPL, cloudLine(idle), L) === null);
  // 稽核 L2:報告帶 error(這一輪 build 失敗)= 雲端頁的 trExecState 第一條就回 unknown;選單列同一句,不講尚未啟動 / 執行中 / 已暫停
  const errd = (rec, halt) => st({ report: { error: "build failed", venues: { binance: V }, halt: halt || { halted: false }, reconciler: rec } });
  t("報告帶 error:一律「讀不到狀態」(對帳器沒心跳、有心跳、已暫停都一樣),跟雲端頁同一句",
    [errd({ alive: false }), errd({ alive: true }), errd({ alive: false }, { halted: true })].every((x) => cloudLine(x).state === "unknown")
    && statusLine(TPL, cloudLine(errd({ alive: false })), LZ) === "雲端：Binance · 讀不到狀態" && cloudTrading(errd({ alive: true })) === false); }
{ // 選單列圖示旁不放任何小點(Wei 09-23):本機新版、雲端新版都不點;「新版已下載」那一行留在選單裡
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"), tt = require("../shell/traytext.js");
  t("選單列圖示旁沒有小點:main.js 不呼叫 setTitle;雲端那條規則不留死碼;選單的「新版已下載」照留", !/\.setTitle\(/.test(mainSrc)
    && !/cloudUpdateWaiting|cloudNeedsUpdate/.test(mainSrc) && !("cloudNeedsUpdate" in tt) && /updateWaiting\(\) \? \[\{ type: "separator" \}, \{ label: tmLabels\.updateReady, enabled: false \}\] : \[\]/.test(mainSrc)); }
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
{ /* 選單列的更新那一行(v4 §4 / mockup §4):只有 app 新版已暫存好時多一行「重新啟動以完成更新」(不可點、沒有點、沒有徽章),
     前後各一條分隔線;雲端的更新**不進選單列**(v4 全 app 只有三個可見狀態:cloudUpdateLine 與「打開 Blave 更新…」那兩句退場,open-about 也退場) */
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"), tt = require("../shell/traytext.js"), pre2 = fs.readFileSync(path.join(__dirname, "..", "shell", "preload.js"), "utf8");
  const appSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8"), trSrc2 = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");
  const S = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "strings.js"), "utf8");
  const zh = (k) => { const m = new RegExp('"' + k.replace(/\./g, "\\.") + '": "([^"]*)"').exec(S.slice(S.indexOf("zh:"))); return m && m[1]; }, en = (k) => { const m = new RegExp('"' + k.replace(/\./g, "\\.") + '": "([^"]*)"').exec(S.slice(0, S.indexOf("zh:"))); return m && m[1]; };
  const menuBody = mainSrc.slice(mainSrc.indexOf("function trayMenu(live)"), mainSrc.indexOf("function traySync()"));
  t("v4 選單列:新版已暫存好(updateWaiting = ready | blocked)才多一行,字是 tm.updateReady、enabled: false、前後各一條分隔線;那一行進 trayKey、也是 tooltip",
    /\.\.\.\(updateWaiting\(\) \? \[\{ type: "separator" \}, \{ label: tmLabels\.updateReady, enabled: false \}\] : \[\]\),\n\s*\{ type: "separator" \},/.test(menuBody)
    && /const updateWaiting = \(\) => \{ try \{ const p = updater\(\)\.state\(\)\.phase; return p === "blocked" \|\| p === "ready"; \}/.test(mainSrc)
    && /updateWaiting\(\) \? tmLabels\.updateReady : ""/.test(mainSrc) && /tray\.setToolTip\(updateWaiting\(\) \? tmLabels\.updateReady : tmLabels\.running\)/.test(mainSrc));
  t("v4 選單列:那一行的字「重新啟動以完成更新 / Restart to finish updating」(renderer 交 tm.updateReady;主行程的英文預設同一句)",
    zh("tm.updateReady") === "重新啟動以完成更新" && en("tm.updateReady") === "Restart to finish updating" && /updateReady: t\("tm\.updateReady"\)/.test(trSrc2) && /updateReady: "Restart to finish updating",/.test(mainSrc));
  t("v4 選單列:雲端的更新不進選單列——traytext 沒有 cloudUpdateLine、main.js 沒有 trayCloudUpdate / openAbout / open-about、preload / app.js 沒有 onOpenAbout、trade.js 不交那兩個字、字串表也沒有",
    !("cloudUpdateLine" in tt) && !/cloudUpdateLine|trayCloudUpdate|openAbout|open-about|cloudUpdate:|cloudUpdateStale/.test(mainSrc) && !/onOpenAbout|open-about/.test(pre2) && !/onOpenAbout/.test(appSrc)
    && !/cloudUpdate|cloudUpdateStale/.test(trSrc2) && zh("tm.cloudUpdate") === null && zh("tm.cloudUpdateStale") === null && en("tm.cloudUpdate") === null);
  t("v4 選單列:選單裡沒有別的更新字(沒有「打開 Blave 更新」「有新版」那類句子)", !/Open Blave to update|new version \{nv\}/.test(mainSrc)); }
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
t("對帳器心跳不在(報告讀得到)→ 不講執行中,講尚未啟動下單", cloudLine(st({ report: { venues: { binance: V }, reconciler: { alive: false } } })).state === "notStarted");
t("沒有可講的 → null(整行不顯示):沒登入、沒主機、啟動中、停機、沒回報、沒連好交易所、還沒問到", [null, undefined, {}, st({ cloud: { code: "NO_LOGIN" } }), st({ cloud: { code: "OK", machine: { state: "none" } } }), st({ cloud: { code: "OK", machine: { state: "starting" } } }),
  st({ cloud: { code: "OK", machine: { state: "stopped" } } }), st({ report: null }), st({ report: { venues: {} } }), st({ report: { venues: { binance: { credentials: true } } } }), st({ report: "x" }), st({ report: { venues: "x" } })].every((s) => cloudLine(s) === null));
t("結束確認框那一句:只有「確定在下單」才說(那一句是在替雲端做保證)", cloudTrading(st()) === true && cloudTrading(st({ alive: false })) === false && cloudTrading(st({ report: { venues: { binance: V }, halt: { halted: true }, reconciler: { alive: true } } })) === false && cloudTrading(null) === false);

// 不可信輸入
t("場所 id 長得不像 id 的不算(雲端主機寫得進去的字串不拿來判斷、更不顯示)", cloudLine(st({ report: { venues: { "<img src=x>": V, "A B": V, ["x".repeat(40)]: V }, reconciler: { alive: true } } })) === null);
t("輸出只由我們自己的字組成:回報裡塞什麼字串都進不了那一行", (() => { const s = st(); s.report.halt = { halted: false, source: "‮gnp.exe", at: "<b>" }; s.report.venues.binance.label = "EVIL"; s.cloud.machine.os_type = "EVIL"; const out = statusLine(TPL, cloudLine(s), L); return out === "雲端：Binance · 執行中"; })());
t("clean:控制字元、零寬、bidi 覆寫、換行都拿掉;過長截斷", clean("a\u0000b\nc‮d​e", 40) === "a b c d e" && clean("x".repeat(100), 10).length === 10 && clean("x".repeat(100), 10).endsWith("…") && clean(5) === "" && clean(null) === "");
t("字還沒交(任何一個要用到的是空的)→ 整行不顯示,不拿英文硬湊(模擬那一行要 moneyPaper;交易所名不是交的字,不受影響)", statusLine("", cloudLine(st()), L) === null && statusLine(TPL, cloudLine(st()), { ...L, stOn: "" }) === null
  && statusLine(TPL, cloudLine(st({ report: { venues: { paper: V }, reconciler: { alive: true } } })), { ...L, moneyPaper: "" }) === null && statusLine(TPL, cloudLine(st()), { ...L, moneyReal: "" }) === "雲端：Binance · 執行中"
  && statusLine(TPL, null, L) === null && statusLine(TPL, cloudLine(st()), null) === null);
t("字本身帶控制字元(renderer 交來的也過一次 clean)", statusLine("雲端：{money}\n· {state}", cloudLine(st()), L) === "雲端：Binance · 執行中");
{ // Wei 0.0.6 接線:這台電腦那一行帶 venue;選單列不再另列一行交易所名;結束確認框的 {venue} 走同一張表;renderer 的頂列記號 / 視窗標題也寫交易所名、tr.tb 拿掉
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"), trSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");
  t("main.js:trayLocalLine 帶 venue、沒有那一行 venueName(live.venue)、venueName 走 TT.venueLabel;trade.js:記號與視窗標題走 envVenueText、tr.tb 不在;.po 也拿掉 tr.tb",
    /trayLocalLine = \(live\) => TT\.statusLine\(tmLabels\.stLocal, \{ money: live\.venue === "paper" \? "paper" : "real", venue: live\.venue, state: "on" \}, tmLabels\)/.test(mainSrc)
    && !/label: venueName\(live\.venue\)/.test(mainSrc) && /id === "paper" \? tmLabels\.paperVenue : TT\.venueLabel\(id\)/.test(mainSrc)
    && /tm\.textContent = envVenueText\(mny, id\);/.test(trSrc) && /const money = envVenueText\(cur\.money, cur\.venue\);/.test(trSrc) && !/"tr\.tb"/.test(trSrc)
    && ["zh", "en"].every((l) => !/msgid "tr\.tb"\n/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", l + ".po"), "utf8"))));
  // 結束確認框的 {venue}:表上的照表;表外 id 首字大寫;長得不像 id(venueLabel 回空)也退回首字大寫的原字——那句不能變成「部位留在。」
  const TT = require("../shell/traytext.js"), tmLabels = { paperVenue: "模擬交易" };
  const venueName = eval("(" + mainSrc.match(/const venueName = (\([^\n]*?);\s*$/m)[1] + ")");
  t("main.js venueName:paper → 模擬交易;okx → OKX;kraken → Kraken;「my venue」→ My venue(不是空字串);空 → 空", venueName("paper") === "模擬交易" && venueName("okx") === "OKX" && venueName("kraken") === "Kraken"
    && venueName("my venue") === "My venue" && venueName("") === "" && venueName(null) === ""); }
t("通知標題的前綴:有才加;結束框的那一句:有才加、隔一行", notifTitle("這台電腦：", "下單失敗") === "這台電腦：下單失敗" && notifTitle("", "下單失敗") === "下單失敗" && quitDetail("A", "B") === "A\n\nB" && quitDetail("A", "") === "A");

// 接線(main.js 原文)
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
t("main.js:選單列不為了雲端那一行去啟動輪詢(雲端宿主沒啟動過 = 沒有那一行)", /const cloudSt = \(\) => \(_cloud && _cloud\.isRunning\(\) \? _cloud\.status\(\) : null\);/.test(src) && !/cloudSt = [^\n]*cloudHost\(\)/.test(src));
t("main.js:雲端那一行進 trayKey(狀態變了才會重畫)", /const key = live \? \[[^\]]*trayCloudLine\(\) \|\| ""[^\]]*\]\.join/.test(src));
t("main.js:暫停只給這台電腦——選單列、Dock、失敗框三處都用 pauseLabel(),而且都只送本機的 halt", (src.match(/pauseLabel\(\)/g) || []).length >= 4 && !/label: tmLabels\.pause,/.test(src) && (src.match(/click: pauseFromMenu/g) || []).length === 2);
t("main.js:本機 P1 通知與暫停通知的標題都過前綴", (src.match(/TT\.notifTitle\(tmLabels\.notifPrefixLocal,/g) || []).length === 2 && !/new Notification\(\{ title: tmLabels\["ev_"/.test(src));
t("main.js:結束確認框多的那一句只在雲端確定在下單時加", /TT\.quitDetail\([^\n]*TT\.cloudTrading\(cloudSt\(\)\) \? tmLabels\.quitCloudNote : ""\)/.test(src));
t("main.js:app 選單的兩個視角送 env-switch,只送自家頁面、只有兩個固定值", /click: \(\) => onEnv\("local"\)/.test(src) && /click: \(\) => onEnv\("cloud"\)/.test(src) && (src.match(/onEnv\(/g) || []).length === 2 && /appMenuTemplate\(tmLabels, dev, full, envSwitchFromMenu,/.test(src) && (src.match(/envSwitchFromMenu\(/g) || []).length === 1 && /isOurPageUrl\(w\.webContents\.getURL\(\)\)\) w\.webContents\.send\("env-switch", env\)/.test(src));
t("main.js:官網入口是固定常數、語言段只有兩個值(renderer 交來的 lang 走白名單)", /const SITE_URL = \{ zh: "https:\/\/blave\.org\/zh", en: "https:\/\/blave\.org\/en" \};/.test(src) && /if \(labels\.lang === "zh" \|\| labels\.lang === "en"\) uiLang = labels\.lang;/.test(src) && /shell\.openExternal\(SITE_URL\[siteLang\(\)\]\)/.test(src));
t("main.js:發佈版的選單不放重新載入與開發者工具", /const dev = !\(app\.isPackaged && require\("\.\/package\.json"\)\.blaveRelease\);/.test(src) && /\.\.\.\(dev \? \[\{ role: "reload" \}/.test(src));
const pre = fs.readFileSync(path.join(__dirname, "..", "shell", "preload.js"), "utf8");
t("preload:renderer 待接的三個入口都在", /minVersionState:/.test(pre) && /onMinVersionState:/.test(pre) && /onEnvSwitch:/.test(pre));
// app 選單不中英混語(設計師 spec-desktop-005 §1):每一格都帶 label、字跟 app 的語言走;編輯選單沒有替代 / 語音;全螢幕只有一格、字跟著狀態換
{ const fs = require("fs"), path = require("path");
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
  const cutM = (a, b) => { const i = mainSrc.indexOf(a); return mainSrc.slice(i, mainSrc.indexOf(b, i)); };
  const app = { name: "Blave" };
  const MENU_EN = eval("(" + cutM("const MENU_EN = ", " };\n").replace("const MENU_EN = ", "") + " })");
  const appMenuTemplate = eval("(" + cutM("function appMenuTemplate", "\nfunction appMenuSync") + ")");
  const po = fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", "zh.po"), "utf8"), zh = {};
  for (const m of po.matchAll(/msgid "menu\.([A-Za-z]+)"\nmsgstr "([^"]*)"/g)) zh["menu" + m[1][0].toUpperCase() + m[1].slice(1)] = m[2];
  const items = (tpl) => { const out = []; const walk = (xs, top) => xs.forEach((x) => { if (x.type !== "separator") out.push({ ...x, top }); if (x.submenu) walk(x.submenu, false); }); walk(tpl, true); return out; };
  const dev = (tpl) => items(tpl).filter((x) => ["reload", "forceReload", "toggleDevTools"].includes(x.role));
  const onFull = () => {};
  const tz = appMenuTemplate(zh, false, false, () => {}, () => {}, onFull), tzFull = appMenuTemplate(zh, false, true, () => {}, () => {}, onFull), ten = appMenuTemplate({}, false, false, () => {}, () => {}, onFull);
  const noLabel = items(tz).filter((x, i) => !(i === 0 && x.top) && !x.label);
  t("app 選單:除了 app 名稱那一格(系統放名字),每一格都有 label", noLabel.length === 0);
  t("app 選單:zh 介面每一格的字都來自 zh.po(沒有一格退回英文)", items(tz).slice(1).every((x) => Object.values(zh).includes(x.label)) && Object.keys(MENU_EN).every((k) => zh[k]));
  t("app 選單:字照 spec §1.2 / Wei 拍板(顯示;隱藏 Blave、結束 Blave 帶空格,同選單列圖示與結束確認框;拷貝;沒有「設定⋯」)",
    tz[3].label === "顯示" && items(tz).some((x) => x.role === "hide" && x.label === "隱藏 Blave") && items(tz).some((x) => x.role === "quit" && x.label === "結束 Blave")
    && /msgid "tm\.quitGo"\nmsgstr "結束 Blave"/.test(po)
    && items(tz).some((x) => x.role === "copy" && x.label === "拷貝") && !items(tz).some((x) => /設定|Settings/.test(x.label || "")));
  t("app 選單:還沒交字時整份是英文退路(Title Case 的 This Computer)", items(ten).slice(1).every((x) => Object.values(MENU_EN).includes(x.label)) && items(ten).some((x) => x.label === "This Computer"));
  t("編輯選單逐項列:沒有 editMenu 整包(不帶 Substitutions / Speech),複製貼上的 role 都在", !items(tz).some((x) => /Menu$/.test(x.role || ""))
    && ["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll"].every((r) => items(tz).some((x) => x.role === r)));
  const fs1 = (tpl) => items(tpl).filter((x) => /全螢幕|Full Screen/.test(x.label || ""));
  t("全螢幕只有一格、不帶 role(帶 togglefullscreen role 時 macOS 會再插一份 🌐F 的),自己的 click + ⌃⌘F;字跟著狀態換(進入 / 離開)",
    !items(tz).some((x) => /fullscreen/i.test(x.role || "")) && fs1(tz).length === 1 && fs1(tz)[0].label === "進入全螢幕" && fs1(tz)[0].accelerator === "Ctrl+Cmd+F" && fs1(tz)[0].click === onFull
    && fs1(tzFull).length === 1 && fs1(tzFull)[0].label === "離開全螢幕" && fs1(ten)[0].label === "Enter Full Screen");
  t("視窗與輔助說明選單帶 role(系統認得,自己加視窗清單與搜尋)", tz.some((x) => x.top !== false && x.role === "window") && tz.some((x) => x.role === "help"));
  t("發佈版的選單不放重新載入與開發者工具", dev(tz).length === 0 && dev(appMenuTemplate(zh, true, false, () => {}, () => {})).length === 3
    && /const dev = !\(app\.isPackaged && require\("\.\/package\.json"\)\.blaveRelease\);/.test(mainSrc));
  const body = cutM("function appMenuSync()", "\n}\n");
  t("換語言、進出全螢幕會重建選單(key 含語言、全螢幕、每一個 menu 字);視窗的 enter/leave-full-screen 叫它", /JSON\.stringify\(\[uiLang, full, Object\.keys\(MENU_EN\)\.map\(\(k\) => tmLabels\[k\]\)\]\)/.test(body)
    && /win\.on\("enter-full-screen", appMenuSync\); win\.on\("leave-full-screen", appMenuSync\);/.test(mainSrc));
  t("renderer 交每一個 menu 字;主行程每一個 menu 鍵預設空的(= 用英文退路)", /\.\.\.Object\.fromEntries\(TR_MENU_KEYS\.map/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8"))
    && /\.\.\.Object\.fromEntries\(Object\.keys\(MENU_EN\)\.map\(\(k\) => \[k, ""\]\)\)/.test(mainSrc));
  const trSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");
  const keys = eval(/const TR_MENU_KEYS = (\[[\s\S]*?\]);/.exec(trSrc)[1]).map((k) => "menu" + k.charAt(5).toUpperCase() + k.slice(6));
  t("renderer 交的鍵跟主行程的鍵一模一樣(少一個 = 那一格永遠是英文)", JSON.stringify(keys.slice().sort()) === JSON.stringify(Object.keys(MENU_EN).sort())); }
Promise.all(after).then(() => { console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0); });
