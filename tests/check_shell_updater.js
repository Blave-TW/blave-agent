// shell/updater.js:永遠不自己重啟、下單執行中不安裝、沒有更新來源就整個關掉。
// 跑法:node tests/check_shell_updater.js
const fs = require("fs"), path = require("path"), { EventEmitter } = require("events");
const { createUpdater } = require("../shell/updater.js");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const tick = () => new Promise((r) => setTimeout(r, 5));
function fakeAU() { const au = new EventEmitter(); au.calls = []; au.setFeedURL = (o) => au.calls.push(["feed", o]); au.checkForUpdates = () => { au.calls.push(["check"]); return Promise.resolve(); }; au.quitAndInstall = (...a) => au.calls.push(["install", ...a]); return au; }
(async () => {
  let trading = false, states = [];
  let native = null;
  const mk = (extra = {}) => { const au = fakeAU(); native = new EventEmitter(); states = []; return { au, up: createUpdater({ autoUpdater: au, nativeUpdater: native, feedUrl: "https://example.invalid/mac", currentVersion: "0.3.1", isTrading: () => trading, onState: (s) => states.push(s), setTimer: () => 0, ...extra }) }; };

  let { au, up } = mk({ feedUrl: null, autoUpdater: null });
  t("沒有更新來源:phase=off、start/check/install 都不做事也不炸", up.state().phase === "off" && up.start() === false && up.check() === false && up.install().ok === false);

  ({ au, up } = mk());
  t("start:設好 generic 來源、背景下載、不准降版", up.start() === true && au.autoDownload === true && au.allowDowngrade === false && au.allowPrerelease === false
    && JSON.stringify(au.calls[0]) === JSON.stringify(["feed", { provider: "generic", url: "https://example.invalid/mac" }]));
  t("start 叫兩次只生效一次", up.start() === false);
  t("結束 app 時自動安裝是開的(結束=已停止下單)", au.autoInstallOnAppQuit === true);
  const syncPhase = (up.check(), up.state().phase); await tick();
  t("check 會去查;按下那一刻就先講 checking(不等 electron-updater 連上 feed 才發的事件——那之前畫面會停在舊的「已是最新版」)", au.calls.some((c) => c[0] === "check") && syncPhase === "checking");
  au.emit("update-available", { version: "0.4.0" }); au.emit("download-progress", { percent: 41.7 });
  t("下載中:帶新版號與整數百分比", up.state().phase === "downloading" && up.state().version === "0.4.0" && up.state().percent === 41 && up.state().current === "0.3.1");
  t("下載中按安裝:拒絕", up.install().error === "NOT_READY" && !au.calls.some((c) => c[0] === "install"));
  t("下載中不重複檢查", up.check() === false);

  au.emit("update-downloaded", { version: "0.4.0" });
  t("zip 下載完 ≠ 可以裝:先是 staging(系統還在驗章、暫存),安裝鈕不給按", up.state().phase === "staging" && up.install().error === "NOT_READY" && up.check() === false);
  trading = true; native.emit("update-downloaded");
  t("Squirrel 暫存好了才算已下載;下單執行中:phase=blocked、安裝被擋、沒有叫 quitAndInstall", up.state().phase === "blocked" && up.install().error === "TRADING" && !au.calls.some((c) => c[0] === "install"));
  trading = false;
  t("暫停之後同一個狀態自己變成 ready(不用等下一個事件)", up.state().phase === "ready");
  const r = up.install(); await tick();
  t("沒在下單:安裝 → quitAndInstall", r.ok === true && au.calls.some((c) => c[0] === "install"));
  // 稽核 M1:暫存 / 安裝階段的 error 不能吞——鈕會變成按了沒反應,而且 4 小時的檢查永遠空轉
  ({ au, up } = mk()); up.start(); au.emit("update-available", { version: "0.4.0" }); au.emit("update-downloaded", { version: "0.4.0" });
  au.emit("error", new Error("Could not move bundle: read-only volume"));
  t("暫存失敗(translocation / 沒簽章 / 磁碟滿):phase=error + INSTALL_FAILED,可以再檢查", up.state().phase === "error" && up.state().error === "INSTALL_FAILED" && up.state().version === "0.4.0" && up.check() === true);
  ({ au, up } = mk()); up.start(); au.emit("update-downloaded", { version: "0.4.0" }); native.emit("update-downloaded"); au.emit("error", new Error("install failed"));
  t("已暫存之後的 error 也講出來(不留一顆按了沒反應的鈕)", up.state().phase === "error" && up.state().error === "INSTALL_FAILED" && up.install().error === "NOT_READY");

  ({ au, up } = mk()); up.start(); au.emit("error", new Error("net down"));
  t("檢查失敗:phase=error,之後可以再查", up.state().phase === "error" && up.check() === true);
  ({ au, up } = mk()); up.start(); up.check(); au.emit("update-not-available");
  t("沒有新版:idle + checkedAt(「已是最新版 · {t} 檢查過」的時間,經 state() 交出去);再查一次照樣可以", up.state().phase === "idle" && Math.abs(up.state().checkedAt - Date.now()) < 5000 && up.check() === true);
  ({ au, up } = mk({ onState: () => { throw new Error("renderer gone"); } })); up.start();
  t("畫面那邊丟例外不影響更新", (() => { try { au.emit("update-available", { version: "9" }); return up.state().phase === "downloading"; } catch (_) { return false; } })());

  const src = fs.readFileSync(path.join(__dirname, "..", "shell", "updater.js"), "utf8");
  t("整個檔只有 install() 一處會叫 quitAndInstall(永遠不自己重啟)", (src.match(/quitAndInstall\(/g) || []).length === 1);
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
  t("main.js:isTrading 走保守判定 tradeMaybeLive;開發版沒有更新來源;安裝 IPC 只收自家頁面", /isTrading: \(\) => !!tradeMaybeLive\(\)/.test(mainSrc) && /const feedUrl = app\.isPackaged \?/.test(mainSrc) && /"update-install", \(e\) => \(!fromOurPage\(e\) \? \{ ok: false, error: "NOT_ALLOWED" \} : activeTurn \|\| turnStarting \? \{ ok: false, error: "TURN_BUSY" \} : updater\(\)\.install\(\)\)/.test(mainSrc));
  t("tmLabels 預設物件就有回合中結束那兩句(畫面還沒交字前按結束也不會是空的)", (() => { const i = mainSrc.indexOf("let tmLabels = {"), j = mainSrc.indexOf("};", i); const d = mainSrc.slice(i, j);
    return /quitTurnTitle: "/.test(d) && /quitTurnBody: "/.test(d); })() && !/tmLabels\.quitTurnTitle \|\|/.test(mainSrc));
  t("關視窗:本機 agent 回合在跑時也只藏起來(同下單中);「背景照常下單」那則只在真的在下單時講",
    /const trading = tradeMaybeLive\(\), turn = !!\(activeTurn \|\| turnStarting\);\s*if \(quitting \|\| quitConfirmed \|\| \(!trading && !turn\)\) return;\s*e\.preventDefault\(\); win\.hide\(\);/.test(mainSrc) && /if \(trading && !hiddenSaid/.test(mainSrc));
  t("回合收尾時視窗可能已關:送 turn-end 前先看 isDestroyed", /if \(!win\.isDestroyed\(\)\) win\.webContents\.send\("turn-end"/.test(mainSrc));
  t("結束 Blave:本機 agent 回合還在跑時先問一次(同自動下單那一道),確認過才結束", /if \(!quitting && !quitConfirmed && \(activeTurn \|\| turnStarting\)\) \{\s*e\.preventDefault\(\);/.test(mainSrc) && /message: tmLabels\.quitTurnTitle/.test(mainSrc));
  const cfg = fs.readFileSync(path.join(__dirname, "..", "shell", "electron-builder.config.js"), "utf8");
  t("打包:updater.js 在 files、release 沒設更新來源會 throw、來源必須 https、有來源才出 zip", /"updater\.js"/.test(cfg) && /release 要設 BLAVE_UPDATE_URL/.test(cfg) && /\^https:/.test(cfg) && /target: "zip"/.test(cfg));
  t("release 指令不再把目標寫死成 dmg(不然 zip 不會出)", !/--mac dmg --publish never/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "package.json"), "utf8").split('"release"')[1]));
  // — app 更新後 workspace 的官方檔案要跟上(不然是新 runtime + 舊 lib 的混搭)—
  const m = mainSrc.match(/^const officialStale = .*$/m);
  t("main.js 有 officialStale", !!m); if (m) eval(m[0].replace(/^const /, "var "));
  t("隨包的比較新 → 要拷;一樣 / workspace 比較新 / 隨包讀不到 → 不拷(只往上不往下)", officialStale("2026-09-21", "2026-09-10") && officialStale("2026-09-21-b", "2026-09-21")
    && officialStale("2026-09-21", "") && !officialStale("2026-09-21", "2026-09-21") && !officialStale("2026-09-10", "2026-09-21") && !officialStale("", "2026-09-21"));
  t("在常駐程式起來之前同步(它 import 的是 workspace 的 lib)", mainSrc.indexOf("syncOfficialOnUpdate();") > 0 && mainSrc.indexOf("syncOfficialOnUpdate();") < mainSrc.indexOf("tradeStartIfReady();", mainSrc.indexOf("syncOfficialOnUpdate();")) && /syncOfficialOnUpdate\(\);[^\n]*\n\s*tradeStartIfReady\(\);/.test(mainSrc));
  t("Python 相依的記號檔比內容(清單變了要重裝)", /depsHave !== WORKSPACE_DEPS\.join/.test(mainSrc));
  t("只有拿到單一實例鎖的那一份才同步(第二份 app 不准把新 lib 拷進正在下單的 workspace)", /if \(app\.hasSingleInstanceLock\(\)\) syncOfficialOnUpdate\(\);/.test(mainSrc));
  t("VERSION 是 OFFICIAL_FILES 的最後一項(中途失敗 → 版號不變 → 下次重來)", /const OFFICIAL_FILES = \[[^\]]*"VERSION",\s*\];/.test(mainSrc));
  t("常駐程式的 env 帶 PY_ENV(不把 __pycache__ 寫進 .app)", /BLAVE_AGENT_STATE: path\.join\(BASE, "state"\),\s*\.\.\.PY_ENV/.test(mainSrc));
  t("防回滾:Squirrel 層比版號", /ElectronSquirrelPreventDowngrades: true/.test(cfg));
  t("package.json 版號是嚴格 A.B.C(Squirrel 防降版要求)", /^[0-9]+\.[0-9]+\.[0-9]+$/.test(require("../shell/package.json").version));
  t("選單列:新版在等的時候選單多一行(圖示旁不加小點),而且會觸發重畫(進 trayKey)", /updateWaiting\(\) \? \[\{ type: "separator" \}, \{ label: tmLabels\.updateReady, enabled: false \}\] : \[\]/.test(mainSrc) && !/\.setTitle\(/.test(mainSrc) && !/cloudUpdateWaiting/.test(mainSrc) && /const key = live \? \[[^\]]*updateWaiting\(\) \? tmLabels\.updateReady : ""[^\]]*\]\.join\("\|"\)/.test(mainSrc));
  // 覆寫前備份被改過的官方檔:把 main.js 的兩個函式切出來,對臨時目錄真的跑一次
  {
    const os = require("os"), a0 = mainSrc.indexOf("function listFiles("), b0 = mainSrc.indexOf("const readVersion =");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-bk-")), REPO = path.join(tmp, "repo"), WS = path.join(tmp, "ws");
    const OFFICIAL_DIRS = ["lib"], OFFICIAL_FILES = ["AGENTS.md", "VERSION"];
    const w = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
    w(path.join(REPO, "lib/data.py"), "new"); w(path.join(REPO, "lib/same.py"), "same"); w(path.join(REPO, "lib/sub/x.py"), "new-x"); w(path.join(REPO, "AGENTS.md"), "rules v2"); w(path.join(REPO, "VERSION"), "2");
    w(path.join(WS, "lib/data.py"), "agent edited"); w(path.join(WS, "lib/same.py"), "same"); w(path.join(WS, "lib/sub/x.py"), "old-x"); w(path.join(WS, "lib/order_mine.py"), "user's own"); w(path.join(WS, "AGENTS.md"), "rules v1"); w(path.join(WS, "VERSION"), "1");
    eval(mainSrc.slice(a0, b0).replace(/^const /gm, "var "));
    const bk = backupChangedOfficial("1-test");
    const got = bk.saved.slice().sort().join();
    t("備份:只收內容不同的官方檔(含子目錄),一樣的、用戶自己加的、VERSION 都不收", got === ["AGENTS.md", "lib/data.py", path.join("lib/sub/x.py")].sort().join());
    t("備份:內容是覆寫前的那一份、放在 workspace/.official-backup/<tag>/", fs.readFileSync(path.join(WS, ".official-backup/1-test/lib/data.py"), "utf8") === "agent edited" && !fs.existsSync(path.join(WS, ".official-backup/1-test/lib/order_mine.py")));
    t("備份失敗就不覆寫(try 裡備份在 copyOfficial 之前)", mainSrc.indexOf("backupChangedOfficial(`") < mainSrc.indexOf("copyOfficial();", mainSrc.indexOf("backupChangedOfficial(`")));
  }
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
