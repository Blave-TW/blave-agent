// Electron 測試的守門。tests/ 下會啟動 Electron 的測試一律經過這支,不自己組 Electron 的路徑。
//
// 為什麼:測試起的 Electron 會跳到正在用電腦的人面前。預設不啟動,要跑才開:
//   node tests/check_shell_esc.js                        純 node 的段落照跑,Electron 那段 SKIP;exit code = 純 node 段的結果
//   BLAVE_TEST_WINDOW=1 node tests/check_shell_esc.js    完整跑(會起 Electron)
// 發版(shell/tools/release.js)的閘門測試自己帶 BLAVE_TEST_WINDOW=1,一定完整跑。
//
// 測試檔的接法(tests/check_tests_window_guard.js 逐支檢查,沒接就紅):
//   const GATE = require("./_electron_gate");     放在檔案最上層、process.versions.electron 那個判斷之前
//   const bin = GATE.bin(SHELL, "②");            回 Electron 執行檔路徑;不該跑時印一行 SKIP 並回 null
//   new BrowserWindow({ show: false, ... })       要顯示才驗得到的,之後呼叫 win.showInactive()
//
// 在 Electron 裡被 require 時(= 測試的 Electron 那一段)會自動:不進 Dock、show() 改成不搶前景的 showInactive()、
// focus() 不動作。真的需要畫面的測試(頁面 visibilityState 要是 visible 才收得到真滑鼠、才拍得到圖)視窗還是會
// 出現在螢幕上,只是不搶鍵盤焦點。
const path = require("path"), fs = require("fs");

const ENV = "BLAVE_TEST_WINDOW";
const SKIP_LINE = `SKIP (set ${ENV}=1 to run the Electron part)`;
const allowed = (env) => (env || process.env)[ENV] === "1";

function bin(shellDir, label) {
  const tag = label ? "  " + label : "";
  if (!allowed()) { console.log(SKIP_LINE + tag); return null; }
  const p = path.join(shellDir, "node_modules", ".bin", "electron");
  if (!fs.existsSync(p)) { console.log("SKIP  找不到 shell/node_modules 的 Electron(先 cd shell && npm install)" + tag); return null; }
  return p;
}

if (process.versions.electron) {
  // 直接 `electron tests/x.js` 也擋:守門不能靠「大家都從 node 進來」
  if (!allowed()) { console.log(SKIP_LINE); process.exit(0); }
  const { app } = require("electron");
  const hideDock = () => { try { if (app.dock) app.dock.hide(); } catch (_) { /* 非 macOS */ } };
  hideDock(); app.whenReady().then(hideDock);
  app.on("browser-window-created", (_e, win) => {
    win.show = () => win.showInactive();
    win.focus = () => {};
  });
}

module.exports = { ENV, SKIP_LINE, allowed, bin };
