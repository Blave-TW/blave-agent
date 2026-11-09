// shell/updater.js:已下載(ready / blocked)之後照樣查新版。feed 比已下載那版新才下載;沒更新、查失敗、Mac 下載失敗都留在舊的 ready。
// 跑法:node tests/check_shell_update_refresh.js
const { EventEmitter } = require("events");
const { createUpdater } = require("../shell/updater.js");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const tick = () => new Promise((r) => setTimeout(r, 5));

/* 照 electron-updater 6.8.12 的順序:checkForUpdates 先發 checking-for-update,有新版發 update-available(autoDownload 才自己下載),
   沒有發 update-not-available;查 feed 失敗先發 error 再 reject。downloadUpdate 失敗先發 error 再 reject。 */
function fakeAU(feed) {
  const au = new EventEmitter(); au.calls = []; au.feed = feed;
  au.setFeedURL = () => {};
  au.quitAndInstall = (...a) => au.calls.push(["install", ...a]);
  au.checkForUpdates = () => {
    au.calls.push(["check", au.autoDownload]);
    au.emit("checking-for-update");
    if (au.feed instanceof Error) { au.emit("error", au.feed); return Promise.reject(au.feed); }
    const avail = au.feed !== "0.3.1";
    if (!avail) { au.emit("update-not-available", { version: au.feed }); return Promise.resolve({ isUpdateAvailable: false, updateInfo: { version: au.feed } }); }
    au.emit("update-available", { version: au.feed });
    if (au.autoDownload) au.calls.push(["auto-download"]);
    return Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: au.feed } });
  };
  au.downloadUpdate = () => { au.calls.push(["download"]); return new Promise((res, rej) => { au.finish = res; au.failDl = (e) => { au.emit("error", e); rej(e); }; }); };
  return au;
}

(async () => {
  let trading = false;
  // 先走一般流程到「已下載 0.4.0」:mac 有 native(Squirrel),win 沒有
  async function readyAt(mac, feed, extra = {}) {
    const au = fakeAU("0.4.0"), native = mac ? new EventEmitter() : null;
    const up = createUpdater({ autoUpdater: au, nativeUpdater: native, feedUrl: "https://example.invalid/u", currentVersion: "0.3.1", isTrading: () => trading, onState: () => {}, setTimer: () => 0, ...extra });
    up.start(); up.check(); await tick();
    au.emit("update-downloaded", { version: "0.4.0" }); if (native) native.emit("update-downloaded");
    au.feed = feed; au.calls.length = 0;
    return { au, native, up };
  }
  const dl = (au) => au.calls.filter((c) => c[0] === "download" || c[0] === "auto-download").length;

  for (const mac of [true, false]) {
    const P = mac ? "mac:" : "win:";
    let { au, native, up } = await readyAt(mac, "0.4.0");
    t(P + "前提:已下載 0.4.0、ready", up.state().phase === "ready" && up.state().version === "0.4.0");

    // feed 還是同一版:不下載、不洗掉 ready
    let r = up.check(); const syncPhase = up.state().phase; await tick();
    t(P + "ready 時照樣去查 feed(不再直接 return false)", r === true && au.calls.some((c) => c[0] === "check"));
    t(P + "查的時候不用 autoDownload(同版不重新下載),查完還原成 true", au.calls.find((c) => c[0] === "check")[1] === false && au.autoDownload === true);
    t(P + "feed 跟已下載那版一樣:維持 ready 0.4.0、沒有下載", syncPhase === "ready" && up.state().phase === "ready" && up.state().version === "0.4.0" && dl(au) === 0);
    t(P + "查完可以再查", up.check() === true); await tick();

    // feed 沒有更新的版本(feed = 目前版本):update-not-available 不把 ready 洗成 idle
    au.feed = "0.3.1"; up.check(); await tick();
    t(P + "update-not-available:維持 ready 0.4.0", up.state().phase === "ready" && up.state().version === "0.4.0" && dl(au) === 0);

    // feed 回退:比已下載那版舊、比目前版本新(electron-updater 照樣說 isUpdateAvailable)→ 不下載(Windows 下載就會清掉已驗過的那版)
    au.feed = "0.3.5"; up.check(); await tick();
    t(P + "feed 0.3.5 比已下載 0.4.0 舊:不下載、維持 ready 0.4.0", up.state().phase === "ready" && up.state().version === "0.4.0" && dl(au) === 0);

    // 查 feed 失敗:維持 ready,不變 error
    au.feed = new Error("net down"); up.check(); await tick();
    t(P + "查 feed 失敗:維持 ready 0.4.0、不是 error", up.state().phase === "ready" && up.state().version === "0.4.0" && up.state().error == null);

    // 下單中(blocked)一樣會查
    trading = true; au.feed = "0.4.0"; au.calls.length = 0; up.check(); await tick();
    t(P + "blocked 時一樣查、維持 blocked", au.calls.some((c) => c[0] === "check") && up.state().phase === "blocked"); trading = false;

    // 有新版 0.5.0:去下載
    au.feed = "0.5.0"; au.calls.length = 0; up.check(); await tick();
    t(P + "feed 比已下載那版新:叫 downloadUpdate 一次", dl(au) === 1);
    if (mac) {
      au.emit("download-progress", { percent: 50 });
      t(P + "下載期間維持 ready 0.4.0(Squirrel 暫存的舊版還在),可以裝(安裝那條在下面另測)", up.state().phase === "ready" && up.state().version === "0.4.0");
    } else {
      t(P + "下載一開始就切 downloading 0.5.0(electron-updater 已清掉舊的 Setup.exe),安裝鈕不給按", up.state().phase === "downloading" && up.state().version === "0.5.0" && up.install().error === "NOT_READY");
    }
    t(P + "下載中不重複查", up.check() === false);
    au.emit("update-downloaded", { version: "0.5.0" }); au.finish([]);
    if (native) { t(P + "zip 下載完:staging 0.5.0(交給 Squirrel 重新暫存)", up.state().phase === "staging" && up.state().version === "0.5.0"); native.emit("update-downloaded"); }
    await tick();
    t(P + "抓好後 ready、版號換成 0.5.0", up.state().phase === "ready" && up.state().version === "0.5.0");
    t(P + "抓好後 refresh 已結束:可以再查(update-downloaded 有把 refreshing 歸零)", up.check() === true); await tick();

    // 新版下載失敗
    ({ au, native, up } = await readyAt(mac, "0.5.0"));
    up.check(); await tick(); au.failDl(new Error("sha512 checksum mismatch")); await tick();
    if (mac) t(P + "新版下載 / 驗章失敗:留在舊的 ready 0.4.0,不變 error", up.state().phase === "ready" && up.state().version === "0.4.0" && up.state().error == null);
    else t(P + "新版下載 / 驗章失敗:舊安裝檔已被清掉 → 走一般的 UPDATE_FAILED,之後可以再查", up.state().phase === "error" && up.state().error === "UPDATE_FAILED" && up.check() === true);
  }

  // Mac:下載期間按了安裝,之後的 error 照常講 INSTALL_FAILED(不當背景查新版的失敗吞掉)
  { const { au, up } = await readyAt(true, "0.5.0"); up.check(); await tick();
    t("mac:下載中按安裝 → 叫 quitAndInstall(裝 Squirrel 暫存的舊版)", up.install().ok === true); await tick();
    t("mac:真的叫到 quitAndInstall", au.calls.some((c) => c[0] === "install"));
    au.emit("error", new Error("No update available, can't quit and install"));
    t("mac:下載中按安裝後的 error → INSTALL_FAILED", up.state().phase === "error" && up.state().error === "INSTALL_FAILED"); }

  // Mac:新 zip 交給 Squirrel 重新暫存失敗 → INSTALL_FAILED(不當背景查新版的失敗吞掉)
  { const { au, native, up } = await readyAt(true, "0.5.0"); up.check(); await tick();
    au.emit("update-downloaded", { version: "0.5.0" });
    au.emit("error", new Error("Code signature at URL did not pass validation"));
    t("mac:重新暫存失敗 → error + INSTALL_FAILED、之後可以再查", up.state().phase === "error" && up.state().error === "INSTALL_FAILED" && up.check() === true); }

  // Mac:轉交 Squirrel 卡住(本機 proxy 起不來,downloadUpdate 永遠不結束、也不發 update-downloaded)→ 30 分鐘沒進度就重新來過
  { let clock = 1e9; const { au, up } = await readyAt(true, "0.5.0", { now: () => clock }); up.check(); await tick();
    au.emit("download-progress", { percent: 100 });
    clock += 29 * 60 * 1000;
    t("mac:卡住未滿 30 分鐘:不重複查", up.check() === false);
    clock += 2 * 60 * 1000; au.calls.length = 0;
    t("mac:卡住滿 30 分鐘:refreshing 歸零、重新查,phase 仍是舊的 ready", up.check() === true && up.state().phase === "ready" && up.state().version === "0.4.0");
    await tick(); t("mac:重新查真的打到 feed", au.calls.some((c) => c[0] === "check")); }

  // 有人正要裝(busy):不查;查到一半變 busy:不下載(Windows 下載就清掉舊安裝檔,停完單會裝不到)
  for (const mac of [true, false]) {
    const P = mac ? "mac:" : "win:";
    let busy = true; const { au, up } = await readyAt(mac, "0.5.0", { busy: () => busy });
    t(P + "busy 時 check() 不查", up.check() === false && !au.calls.some((c) => c[0] === "check"));
    busy = false; const realCheck = au.checkForUpdates; au.checkForUpdates = () => { const p = realCheck(); busy = true; return p; };
    up.check(); await tick();
    t(P + "查到新版的那一刻已經 busy:不下載、維持 ready 0.4.0", dl(au) === 0 && up.state().phase === "ready" && up.state().version === "0.4.0" && au.autoDownload === true);
    busy = false; au.checkForUpdates = realCheck;
    t(P + "busy 解除後可以再查", up.check() === true); await tick();
  }

  // 一般(還沒下載過)的查詢不受影響:照樣 autoDownload
  { const au = fakeAU("0.4.0"); const up = createUpdater({ autoUpdater: au, nativeUpdater: null, feedUrl: "https://example.invalid/u", currentVersion: "0.3.1", isTrading: () => false, onState: () => {}, setTimer: () => 0 });
    up.start(); up.check(); await tick();
    t("idle 時的查詢照舊:autoDownload、phase downloading", au.calls[0][1] === true && up.state().phase === "downloading" && up.state().version === "0.4.0"); }

  { const mainSrc = require("fs").readFileSync(require("path").join(__dirname, "..", "shell", "main.js"), "utf8");
    t("main.js:busy 接上停單收工(restarting / quitConfirmed)、確認框(quitAsking)與閒著自動裝(_schedRunning)", /busy: \(\) => !!\(restarting \|\| quitAsking \|\| moveAsking \|\| quitConfirmed \|\| quitting \|\| _schedRunning\)/.test(mainSrc));
    t("main.js:閒著自動裝的標記用 install 前一刻重讀的版號,不用開頭那份 st", /const target = updater\(\)\.state\(\)\.version;/.test(mainSrc) && /updHiddenBoot: \{ v: target,/.test(mainSrc) && /updSchedTarget: target \}/.test(mainSrc) && !/updSchedTarget: st\.version/.test(mainSrc)); }

  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
