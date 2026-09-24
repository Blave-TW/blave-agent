// Esc 關最上面那一層(app.js escTop,document 層)。要真的鍵盤事件、真的焦點才驗得到:用隨包的 Electron 開真的 index.html,
// window.blave 換成假的(不起主行程、不碰 workspace、不連網),每一個框都用三種焦點狀態按一次真的 Esc(sendInputEvent):
//   焦點在框裡 / 焦點移到 body / 用滑鼠點框裡的字(不可聚焦的地方)——後兩種是 Wei 09-23 實機按 Esc 關不掉的情形
// 另外驗一次只關一層:設定開著、確認框疊在上面,Esc 只關確認框。
// 跑法:node tests/check_shell_esc.js(找不到 shell/node_modules 的 Electron 就 SKIP)
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");

if (!process.versions.electron) {
  const bin = path.join(SHELL, "node_modules", ".bin", "electron");
  if (!fs.existsSync(bin)) { console.log("SKIP  找不到 shell/node_modules 的 Electron(先 cd shell && npm install)"); process.exit(0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  process.exit(r.status == null ? 1 : r.status);
}

const { app, BrowserWindow } = require("electron");
const os = require("os");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-esc-")));
const STUB = `window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" } })[k] });`;
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 每一個框:怎麼開、開著的判準、框裡一段不可聚焦的字(拿來點)
const MODALS = [
  { name: "刪除對話確認框", open: `delConfirm({ id: "x", title: "t" }, $("cs-toggle"))`, isOpen: `!$("del-scrim").hidden`, text: "#del-body" },
  { name: "確認框(暫停 / 金額那一種)", open: `confirmBox({ title: "t", lines: ["一段說明"], ok: "ok", onOk() {}, opener: $("tr-nav") })`, isOpen: `!$("del-scrim").hidden`, text: "#del-body p" },
  { name: "連接交易所", open: `(ENV.cur = "local", cxModalOpen(null))`, isOpen: `!$("cx-scrim").hidden`, text: "#cx-title" },
  { name: "設定", open: `(running = false, setOpen())`, isOpen: `!$("set-scrim").hidden`, text: "#set-title" },
  { name: "圖片放大", open: `lbOpen("data:image/gif;base64,R0lGODlhAQABAAAAACw=", "x", $("ta"))`, isOpen: `!$("lb-scrim").hidden`, text: null },
  // 模型選單沒有型錄時整塊沒有版面(量到 0×0),點不到字;它的點擊路徑跟「焦點在 body」同一條(document 層),由那一格代表
  { name: "模型選單", open: `mpOpen(false)`, isOpen: `!$("mp-panel").hidden`, text: null },
];

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1200);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const esc = async () => { w.webContents.focus(); w.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); w.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" }); await wait(150); };
  const clickOn = async (sel) => {
    const r = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const b = e.getBoundingClientRect(); return { x: Math.round(b.left + 4), y: Math.round(b.top + b.height / 2) }; })()`);
    w.webContents.sendInputEvent({ type: "mouseDown", x: r.x, y: r.y, button: "left", clickCount: 1 }); w.webContents.sendInputEvent({ type: "mouseUp", x: r.x, y: r.y, button: "left", clickCount: 1 }); await wait(120);
  };
  for (const m of MODALS) {
    for (const how of ["inside", "body", "clickText"]) {
      if (how === "clickText" && !m.text) continue;
      await js(m.open); await wait(250);
      if (how === "body") await js(`document.activeElement && document.activeElement.blur()`);
      if (how === "clickText") await clickOn(m.text);
      const st = await js(`({ open: ${m.isOpen}, active: document.activeElement === document.body ? "BODY" : (document.activeElement.id || document.activeElement.className) })`);
      await esc();
      const closed = !(await js(m.isOpen));
      ok(`${m.name}:焦點${how === "inside" ? "在框裡" : how === "body" ? "在 body" : "在點過的字上(" + st.active + ")"}按 Esc → 關掉`, st.open && closed);
      if (!closed) await js(`try { delClose(false); cxModalClose(false); lbClose(); setClose(); mpClose(false); } catch (_) {}`);
    }
  }
  // 一次只關一層:設定開著、確認框疊上去
  await js(`(running = false, setOpen())`); await wait(250);
  await js(`confirmBox({ title: "t", lines: ["x"], ok: "ok", onOk() {}, opener: $("set-close") })`); await wait(150);
  await js(`document.body.focus()`); await esc();
  const a = await js(`({ del: !$("del-scrim").hidden, set: !$("set-scrim").hidden })`);
  await esc();
  const b = await js(`({ del: !$("del-scrim").hidden, set: !$("set-scrim").hidden })`);
  ok("疊兩層:第一下只關確認框、設定還在;第二下才關設定", !a.del && a.set && !b.del && !b.set);
  // 輸入法組字中的 Esc(keyCode 229)是取消選字:什麼框都不關(同 trade.js envWire 的守門)
  await js(`(running = false, setOpen())`); await wait(250);
  const ime = await js(`(() => { const e = new KeyboardEvent("keydown", { key: "Escape", keyCode: 229, bubbles: true, cancelable: true }); document.body.dispatchEvent(e);
    return { code: e.keyCode, open: !$("set-scrim").hidden }; })()`);
  ok("組字中的 Esc(keyCode 229)不關設定", ime.code === 229 && ime.open);
  await esc(); ok("…組字結束後的 Esc 照關", await js(`$("set-scrim").hidden`));
  // 對話清單也歸 escTop:焦點在 body 也關得掉;跟模型選單同時開著時一次只關一層(模型選單先)
  await js(`csShowList(true)`); await wait(100); await js(`document.activeElement && document.activeElement.blur()`); await esc();
  ok("對話清單:焦點在 body 按 Esc → 收起、焦點回到清單鈕", await js(`$("cs-list").hidden && document.activeElement === $("cs-toggle")`));
  await js(`(csShowList(true), mpOpen(false))`); await wait(100); await esc();
  const c1 = await js(`({ mp: !$("mp-panel").hidden, list: !$("cs-list").hidden })`); await esc();
  const c2 = await js(`({ mp: !$("mp-panel").hidden, list: !$("cs-list").hidden })`);
  ok("模型選單 + 對話清單都開著:第一下只關模型選單,第二下才收清單", !c1.mp && c1.list && !c2.mp && !c2.list);
  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
