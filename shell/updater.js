// Blave 電腦版 — 自動更新(主行程用;spec §13)。
//
// app 版號 = 框架版號:runtime / lib / references 是隨包的 extraResources,一次更新換一整包。
// 規則:
//   - 啟動後與之後每 4 小時查一次;有新版就在背景下載。**永遠不自己重啟。**
//   - 自動下單在跑的時候不安裝:「重新啟動並更新」那顆鈕在執行中是擋下來的(isTrading),
//     用戶先暫停、或正常結束 app(結束 = 停止下單)時才裝。結束時自動安裝是安全的——那一刻已經沒有東西在下單。
//   - 用戶的東西(策略、帳本、state/、workspace .env)都在 BLAVE_HOME,不在 app 包裡,更新碰不到。
//   - 沒有更新來源(開發版、沒設 BLAVE_UPDATE_URL 打出來的包)= 整個關掉,畫面只顯示版號。
//
// 這個檔不 require electron / electron-updater:由 main.js 注入,node 測試才跑得動。
const CHECK_EVERY_MS = 4 * 3600 * 1000;
const FIRST_CHECK_MS = 30 * 1000;   // 啟動後先讓 app 把該做的做完

/* opts:{ autoUpdater, nativeUpdater, feedUrl, currentVersion, isTrading(), onState(state), setTimer?, log? }
   state:{ phase, version?, percent?, error? }
     phase = off(沒有更新來源)| idle | checking | downloading | staging(下載完,系統正在驗章與暫存)|
             ready(已暫存,等重啟)| blocked(已暫存,但下單執行中)| error
   **ready 的定義是「Squirrel 已經驗過簽章、暫存好了」,不是「zip 下載完」**(稽核 M1):electron-updater 在 macOS 先 emit
   自己的 update-downloaded,之後才交給 Squirrel 抓 zip、驗章、暫存;那一步會失敗的情況很常見(從 DMG / Downloads 直接開
   = 唯讀的 translocation、沒簽章的包、磁碟滿、/Applications 沒寫入權)。所以要聽 electron 原生 autoUpdater 的
   update-downloaded 才算 ready;在那之後的 error 是安裝失敗,要講出來、也要能再試,不能吞掉。
   **Windows(NSIS)沒有 Squirrel 那一層**:electron-updater 自己下載 Setup.exe、驗 sha512 與簽章,它的 update-downloaded 就是
   「已暫存」;main.js 在 win32 不給 nativeUpdater(null),這裡就把那個事件直接當 ready——不然 phase 永遠卡在 staging。 */
function createUpdater(opts) {
  const au = opts.autoUpdater, log = opts.log || (() => {});
  const timer = opts.setTimer || ((fn, ms) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); return t; });
  let state = { phase: opts.feedUrl ? "idle" : "off", version: null, percent: null, error: null }, started = false;
  const set = (patch) => { state = { ...state, ...patch }; try { opts.onState(publicState()); } catch (_) { /* 畫面壞掉不該影響更新 */ } };
  // 已下載的狀態每次讀都重新看一次「現在有沒有在下單」:下載完成當下在跑、之後暫停了,鈕要跟著解鎖
  const publicState = () => ({ ...state, current: opts.currentVersion, phase: state.phase === "ready" || state.phase === "blocked" ? (opts.isTrading() ? "blocked" : "ready") : state.phase });

  function start() {
    if (started || !opts.feedUrl) return false;
    started = true;
    au.autoDownload = true;
    au.autoInstallOnAppQuit = true;      // 結束 app = 已經停止下單,這時裝是安全的
    au.allowDowngrade = false;
    au.allowPrerelease = false;
    au.setFeedURL({ provider: "generic", url: opts.feedUrl });
    au.on("checking-for-update", () => set({ phase: "checking", error: null }));
    au.on("update-available", (i) => set({ phase: "downloading", version: i && i.version, percent: 0 }));
    au.on("update-not-available", () => set({ phase: "idle", version: null, checkedAt: Date.now() }));   // 「已是最新版 · {t} 檢查過」用的時間
    au.on("download-progress", (p) => set({ phase: "downloading", percent: p && Number.isFinite(p.percent) ? Math.floor(p.percent) : null }));
    au.on("update-downloaded", (i) => set({ phase: opts.nativeUpdater ? "staging" : "ready", version: i && i.version, percent: 100 }));
    if (opts.nativeUpdater) opts.nativeUpdater.on("update-downloaded", () => set({ phase: "ready", percent: 100 }));
    au.on("error", (e) => {
      log("update error: " + (e && e.message));
      const installing = state.phase === "staging" || state.phase === "ready" || state.phase === "blocked";
      set({ phase: "error", error: installing ? "INSTALL_FAILED" : "UPDATE_FAILED" });
    });
    timer(() => check(), CHECK_EVERY_MS);
    setTimeout(() => check(), FIRST_CHECK_MS).unref?.();
    return true;
  }
  function check() {
    if (!opts.feedUrl || ["checking", "downloading", "staging", "ready", "blocked"].indexOf(state.phase) >= 0) return false;
    // 按下去那一刻就講「檢查中」:electron-updater 的 checking-for-update 事件要等它連上 feed 才發,那之前畫面還停在舊的「已是最新版」
    set({ phase: "checking", error: null });
    Promise.resolve().then(() => au.checkForUpdates()).catch((e) => { log("check failed: " + (e && e.message)); set({ phase: "error", error: "CHECK_FAILED" }); });
    return true;
  }
  // 「重新啟動並更新」:只有已下載、而且現在沒有在下單才做
  function install() {
    if (state.phase !== "ready" && state.phase !== "blocked") return { ok: false, error: "NOT_READY" };
    if (opts.isTrading()) return { ok: false, error: "TRADING" };
    setImmediate(() => au.quitAndInstall(false, true));
    return { ok: true };
  }
  return { start, check, install, state: publicState };
}

module.exports = { createUpdater, CHECK_EVERY_MS };
