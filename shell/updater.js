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
const sig = require("./updatesig");
const CHECK_EVERY_MS = 4 * 3600 * 1000;
const FIRST_CHECK_MS = 30 * 1000;   // 啟動後先讓 app 把該做的做完
const FAIL_STAGE = { checking: "check", downloading: "download", staging: "staging", ready: "install", blocked: "install" };

/* opts:{ autoUpdater, nativeUpdater, feedUrl, currentVersion, isTrading(), onState(state), setTimer?, log? }
   state:{ phase, version?, percent?, error? }
     phase = off(沒有更新來源)| idle | checking | downloading | staging(下載完,系統正在驗章與暫存)|
             ready(已暫存,等重啟)| blocked(已暫存,但下單執行中)| error
   **ready 的定義是「Squirrel 已經驗過簽章、暫存好了」,不是「zip 下載完」**(稽核 M1):electron-updater 在 macOS 先 emit
   自己的 update-downloaded,之後才交給 Squirrel 抓 zip、驗章、暫存;那一步會失敗的情況很常見(從 DMG / Downloads 直接開
   = 唯讀的 translocation、沒簽章的包、磁碟滿、/Applications 沒寫入權)。所以要聽 electron 原生 autoUpdater 的
   update-downloaded 才算 ready;在那之後的 error 是安裝失敗,要講出來、也要能再試,不能吞掉。
   **Windows(NSIS)沒有 Squirrel 那一層**:electron-updater 自己下載 Setup.exe、驗 sha512 與簽章,它的 update-downloaded 就是
   「已暫存」;main.js 在 win32 不給 nativeUpdater(null),這裡就把那個事件直接當 ready——不然 phase 永遠卡在 staging。
   opts.signed = { keys }(只有 win32 給):包沒有 Authenticode,electron-updater 只比 yml 的 sha512,所以另外要求 yml 帶
   離線私鑰的簽章(updatesig.js)。驗在 electron-updater 下載完、暫存之前那一步(verifySignature),不過就不暫存、不裝。 */
function createUpdater(opts) {
  const au = opts.autoUpdater, log = opts.log || (() => {});
  const timer = opts.setTimer || ((fn, ms) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); return t; });
  let feedUrl = opts.feedUrl || null;
  let state = { phase: feedUrl ? "idle" : "off", version: null, percent: null, error: null }, started = false, pushed = null;
  const push = () => { const ps = publicState(); pushed = ps.phase; try { opts.onState(ps); } catch (_) { /* 畫面壞掉不該影響更新 */ } };
  const set = (patch) => { state = { ...state, ...patch }; push(); };
  // 失敗在哪一步(埋點 update_failed):階段取自出錯那一刻的 phase,不是錯誤訊息
  const fail = (stage) => { try { if (opts.onFail) opts.onFail(stage); } catch (_) { /* 追蹤不該影響更新 */ } };
  // 已下載的狀態每次讀都重新看一次「現在有沒有在下單」:下載完成當下在跑、之後暫停了,鈕要跟著解鎖
  const publicState = () => ({ ...state, current: opts.currentVersion, phase: state.phase === "ready" || state.phase === "blocked" ? (opts.isTrading() ? "blocked" : "ready") : state.phase });

  function start() {
    if (started || !feedUrl) return false;
    started = true;
    if (opts.signed) {
      const why = sig.keysProblem(opts.signed.keys) || (typeof au.verifySignature !== "function" ? "electron-updater has no verifySignature hook" : null);
      // 驗不了就整個不更新(畫面只顯示版號),不退回只比 sha512
      if (why) { log("updates disabled: " + why); feedUrl = null; set({ phase: "off" }); return false; }
      requireSignature(opts.signed.keys);
    }
    au.autoDownload = true;
    au.autoInstallOnAppQuit = true;      // 結束 app = 已經停止下單,這時裝是安全的
    au.allowDowngrade = false;
    au.allowPrerelease = false;
    au.setFeedURL({ provider: "generic", url: feedUrl });
    au.on("checking-for-update", () => set({ phase: "checking", error: null }));
    au.on("update-available", (i) => set({ phase: "downloading", version: i && i.version, percent: 0 }));
    au.on("update-not-available", () => set({ phase: "idle", version: null, checkedAt: Date.now() }));   // 「已是最新版 · {t} 檢查過」用的時間
    au.on("download-progress", (p) => set({ phase: "downloading", percent: p && Number.isFinite(p.percent) ? Math.floor(p.percent) : null }));
    au.on("update-downloaded", (i) => {
      if (opts.signed) {
        // 快取裡已經有同一個 sha512 的檔時,electron-updater 不重新下載、也就不走 verifySignature:在這裡再驗一次 yml。
        // 必須同步設 autoInstallOnAppQuit——發完這個事件它緊接著掛「結束時安裝」,看的就是這一刻的值
        const m = sig.verifyManifest(i, { keys: opts.signed.keys, feed: feedUrl, currentVersion: opts.currentVersion });
        au.autoInstallOnAppQuit = !m.error;
        if (m.error) { log("downloaded update rejected: " + m.error); fail("download"); set({ phase: "error", error: "UPDATE_FAILED" }); return; }
      }
      set({ phase: opts.nativeUpdater ? "staging" : "ready", version: i && i.version, percent: 100 });
    });
    if (opts.nativeUpdater) opts.nativeUpdater.on("update-downloaded", () => set({ phase: "ready", percent: 100 }));
    au.on("error", (e) => {
      log("update error: " + (e && e.message));
      const installing = state.phase === "staging" || state.phase === "ready" || state.phase === "blocked";
      fail(FAIL_STAGE[state.phase] || "other");
      set({ phase: "error", error: installing ? "INSTALL_FAILED" : "UPDATE_FAILED" });
    });
    timer(() => check(), CHECK_EVERY_MS);
    setTimeout(() => check(), FIRST_CHECK_MS).unref?.();
    return true;
  }
  /* electron-updater 在 doDownloadUpdate 下載完(含差量組裝)、改名進快取之前叫 this.verifySignature(暫存檔):回字串 = 刪檔、
     發 ERR_UPDATER_INVALID_SIGNATURE。公開的 verifyUpdateCodeSignature 只在 app-update.yml 有 publisherName 時才會被叫到,
     未簽章包沒有,所以掛在這一層;原本那支(Authenticode)最後照叫,SignPath 接上後兩道都在。
     electron-updater 釘死 6.8.9,tests/check_shell_updatesig.js 會核對這個呼叫點還在。 */
  function requireSignature(keys) {
    let pending = null;
    const authenticode = au.verifySignature;
    au.disableWebInstaller = true;
    au.on("update-available", (i) => { pending = i; });   // 它先發這個才開始下載,拿到的就是等一下要下載的那份 yml
    au.verifySignature = async (file) => {
      try {
        const m = sig.verifyManifest(pending, { keys, feed: feedUrl, currentVersion: opts.currentVersion });
        if (m.error) { log("update rejected: " + m.error); return m.error; }
        if ((await sig.sha512File(file)) !== m.sha512) { log("update rejected: installer sha512 differs from the signed manifest"); return "installer sha512 differs from the signed manifest"; }
        return await authenticode.call(au, file);
      } catch (e) {
        log("update rejected: verification failed: " + (e && e.message));
        return "update verification failed";
      }
    };
  }
  function check() {
    if (!feedUrl || ["checking", "downloading", "staging", "ready", "blocked"].indexOf(state.phase) >= 0) return false;
    // 按下去那一刻就講「檢查中」:electron-updater 的 checking-for-update 事件要等它連上 feed 才發,那之前畫面還停在舊的「已是最新版」
    set({ phase: "checking", error: null });
    // electron-updater 查 feed 失敗是先 emit error 再 reject:error 那支記過了(phase 已是 error)就不再記一次
    // 下載失敗(含驗章不過)已經由 error 事件處理過;downloadPromise 的 reject 接住,不留成 unhandled rejection
    Promise.resolve().then(() => au.checkForUpdates()).then((r) => { if (r && r.downloadPromise) r.downloadPromise.catch(() => {}); }).catch((e) => { log("check failed: " + (e && e.message)); if (state.phase !== "error") fail("check"); set({ phase: "error", error: "CHECK_FAILED" }); });
    return true;
  }
  /* ready ↔ blocked 只跟著下單狀態變,沒有事件會 set():選單列 5 秒那一輪叫這支,phase 跟上次推給畫面的不同才推(暫停後「…」拿掉、
     開始下單後補上)。其餘 phase 都由 set() 推,這裡不管 */
  function poll() {
    const ps = publicState();
    if ((ps.phase !== "ready" && ps.phase !== "blocked") || ps.phase === pushed) return false;
    push();
    return true;
  }
  // 「重新啟動並更新」:只有已下載、而且現在沒有在下單才做。下單中要先收工,由 main.js restartToUpdate 決定(planRestart)
  function install() {
    if (state.phase !== "ready" && state.phase !== "blocked") return { ok: false, error: "NOT_READY" };
    if (opts.isTrading()) return { ok: false, error: "TRADING" };
    setImmediate(() => au.quitAndInstall(false, true));
    return { ok: true };
  }
  return { start, check, install, poll, state: publicState };
}

/* 按「重新啟動以完成更新」(聊天那一格 / 關於列 / 選單列)之後怎麼走(spec-desktop-update-prompt-0.1.10 §0)。
   asking = 已經有確認框開著(跟結束攔截共用 quitAsking):不疊第二個。confirm = 下單中,先問、確認後收工再裝 */
function planRestart({ phase, turn, asking, trading }) {
  if (phase !== "ready" && phase !== "blocked") return "not_ready";
  if (turn) return "busy";
  if (asking) return "asking";
  return trading ? "confirm" : "install";
}

/* 啟動時不在「應用程式」資料夾就問一次(§4;只有 macOS 打包版會遇到:Squirrel 在唯讀 / translocation 的位置裝不上)。
   下單中不問:搬移會重開 = 停單;這次不問也不記成「不要」 */
function shouldAskMove({ platform, packaged, inApps, declined, trading, askedThisRun }) {
  return platform === "darwin" && !!packaged && !inApps && !declined && !trading && !askedThisRun;
}

module.exports = { createUpdater, planRestart, shouldAskMove, CHECK_EVERY_MS };
