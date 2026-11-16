/* 第一次開窗的時序(0.1.55:Windows 第一次開 app 整片黑、殺掉重開才出現連結畫面)。沒有用戶證據,照讀 code 的推論防三件事:
   ① 主視窗建好就顯示,畫面還沒畫出來時看到的是底色 → 先不顯示,ready-to-show 才顯示,保底 SHOW_FALLBACK_MS 強制顯示(永遠不能不出現);
   ② 建窗同一輪就起首次安裝(拷官方檔、建 venv、pip 全速)跟頁面搶 → 等主視窗 did-finish-load 再起,保底 ENGINE_WAIT_MS;
   ③ Windows 的 GPU 行程非正常結束 → 記下來,之後的啟動在 ready 之前關掉硬體加速(Chromium 改走軟體繪製)。
   純函式,不依賴 Electron;tests/check_shell_bootguard.js */
"use strict";

const SHOW_FALLBACK_MS = 3000, ENGINE_WAIT_MS = 5000;

// win 先 show:false 建好。skip() 為真(結束中、隱藏重開那一扇)就不顯示;log 只寫列舉字
function showWhenReady(win, o = {}) {
  const setT = o.setTimeout || setTimeout, clearT = o.clearTimeout || clearTimeout, log = o.log || (() => {});
  let done = false, timer = null;
  const go = (why) => {
    if (done) return;
    done = true;
    if (timer) clearT(timer);
    if (win.isDestroyed() || (o.skip && o.skip())) return;
    log(`[boot] main window shown (${why})`);
    if (!win.isVisible()) win.show();
  };
  win.once("ready-to-show", () => go("ready-to-show"));
  timer = setT(() => go("fallback"), o.ms || SHOW_FALLBACK_MS);
}

// fn 等 wc 的 did-finish-load 才跑,最多等 ms;沒有 wc(已關掉)當場跑。跑之前 cancelled() 為真(app 在結束)就不跑:
// 黑畫面的人多半幾秒內就關 app,engineAbort 收不到之後才起的那一輪,pip 會變孤兒
function afterLoad(wc, o, fn) {
  const setT = o.setTimeout || setTimeout, clearT = o.clearTimeout || clearTimeout, log = o.log || (() => {});
  let done = false, timer = null;
  const go = (why) => {
    if (done) return;
    done = true;
    if (timer) clearT(timer);
    if (o.cancelled && o.cancelled()) { log(`[boot] ${o.what || "task"} not started (app closing)`); return; }
    log(`[boot] ${o.what || "task"} start (${why})`);
    fn();
  };
  if (!wc || typeof wc.once !== "function" || (wc.isDestroyed && wc.isDestroyed())) { go("no-window"); return; }
  wc.once("did-finish-load", () => go("did-finish-load"));
  timer = setT(() => go("fallback"), o.ms || ENGINE_WAIT_MS);
}

/* ③ 只記「這次啟動、主視窗第一次 ready-to-show 之前」掛掉的(Wei 拍板):那才是畫不出第一格的那一種。
   之後任何時間掛掉(登出、驅動更新 TDR、遠端桌面重連)Chromium 自己會重起 GPU 行程,不記。只有 Windows;clean-exit 是正常收掉;
   這次已經關著硬體加速還掉的也不記(關了也沒用,記了只是把復原計數歸零) */
const gpuOffMark = (platform, type, reason, beforeFirstPaint, alreadyOff) =>
  platform === "win32" && type === "GPU" && reason !== "clean-exit" && beforeFirstPaint === true && !alreadyOff;
/* 復原:關著硬體加速正常結束(走到 will-quit)滿 GPU_OK_RUNS 次,或旗標記下超過 GPU_OFF_MAX_DAYS 天,下次啟動就清掉旗標、重新試 GPU。
   同一台第二次又記到(gpuOffTrips ≥ GPU_STICKY_TRIPS)就不靠正常結束次數清:那台大概真的有問題,不讓它每四次開機黑一次;只剩天數那條 */
const GPU_OK_RUNS = 3, GPU_OFF_MAX_DAYS = 30, GPU_STICKY_TRIPS = 2, DAY_MS = 86400000;
const gpuFlag = (p) => (p && typeof p === "object" && p.gpuOff && typeof p.gpuOff === "object" && !Array.isArray(p.gpuOff) ? p.gpuOff : null);
// gpu-boot.json 原文 → { off: 這次要不要關硬體加速, clear: 要不要清掉旗標(ready 之後寫), why }。讀不到、壞掉、沒有這個鍵都當沒有
function gpuOffBoot(text, now) {
  let p = null;
  try { p = JSON.parse(text); } catch (_) { return { off: false, clear: false, why: null }; }
  const f = gpuFlag(p);
  if (!f) return { off: false, clear: false, why: null };
  const at = Number(f.at), ok = Number.isInteger(f.ok) && f.ok > 0 ? f.ok : 0, trips = Number.isInteger(p.gpuOffTrips) ? p.gpuOffTrips : 1;
  if (!Number.isFinite(at) || at > now || now - at >= GPU_OFF_MAX_DAYS * DAY_MS) return { off: false, clear: true, why: "expired" };
  if (ok >= GPU_OK_RUNS && trips < GPU_STICKY_TRIPS) return { off: false, clear: true, why: "recovered" };
  return { off: true, clear: false, why: null };
}
// 寫旗標那一刻的 patch:新旗標、正常結束次數從 0 算;gpuOffTrips = 這台累計記到幾次(清旗標時不清它)
function gpuOffPatch(prefs, ver, reason, now) {
  const trips = prefs && Number.isInteger(prefs.gpuOffTrips) && prefs.gpuOffTrips > 0 ? prefs.gpuOffTrips : 0;
  return { gpuOff: { v: ver, reason, at: now, ok: 0 }, gpuOffTrips: trips + 1 };
}
// 關著硬體加速正常結束一次:ok + 1。沒有旗標回 null = 不寫
function gpuOkPatch(prefs) {
  const f = gpuFlag(prefs);
  if (!f) return null;
  return { gpuOff: { ...f, ok: (Number.isInteger(f.ok) && f.ok > 0 ? f.ok : 0) + 1 } };
}

module.exports = { showWhenReady, afterLoad, gpuOffMark, gpuOffBoot, gpuOffPatch, gpuOkPatch, GPU_OK_RUNS, GPU_OFF_MAX_DAYS, GPU_STICKY_TRIPS, SHOW_FALLBACK_MS, ENGINE_WAIT_MS };
