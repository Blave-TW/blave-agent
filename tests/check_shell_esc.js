// Esc 關最上面那一層(app.js escTop,document 層)。要真的鍵盤事件、真的焦點才驗得到:用隨包的 Electron 開真的 index.html,
// window.blave 換成假的(不起主行程、不碰 workspace、不連網),每一個框都用三種焦點狀態按一次真的 Esc(sendInputEvent):
//   焦點在框裡 / 焦點移到 body / 用滑鼠點框裡的字(不可聚焦的地方)——後兩種是 Wei 09-23 實機按 Esc 關不掉的情形
// 另外驗一次只關一層:設定開著、確認框疊在上面,Esc 只關確認框。
// 泡泡是最上層:六套泡泡各疊在三種上層上,第一下 Esc 只收泡泡、第二下才關上層。
// 跑法:node tests/check_shell_esc.js(找不到 shell/node_modules 的 Electron 就 SKIP)
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");

if (!process.versions.electron) {
  const bin = GATE.bin(SHELL);
  if (!bin) { process.exit(0); }
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
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (!c && d ? "  " + d : "")); if (!c) red++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  逾時(180 秒)"); process.exit(1); }, 180000).unref();

// 每一個框:怎麼開、開著的判準、框裡一段不可聚焦的字(拿來點)
const MODALS = [
  { name: "刪除對話確認框", open: `delConfirm({ id: "x", title: "t" }, $("cs-toggle"))`, isOpen: `!$("del-scrim").hidden`, text: "#del-body" },
  { name: "確認框(暫停 / 金額那一種)", open: `confirmBox({ title: "t", lines: ["一段說明"], ok: "ok", onOk() {}, opener: $("tr-nav") })`, isOpen: `!$("del-scrim").hidden`, text: "#del-body p" },
  { name: "連接交易所", open: `(ENV.cur = "local", cxModalOpen(null))`, isOpen: `!$("cx-scrim").hidden`, text: "#cx-title" },
  { name: "設定", open: `(running = false, setOpen())`, isOpen: `!$("set-scrim").hidden`, text: "#set-title" },
  { name: "圖片放大", open: `lbOpen("data:image/gif;base64,R0lGODlhAQABAAAAACw=", "x", $("ta"))`, isOpen: `!$("lb-scrim").hidden`, text: null },
  // 0.1.6 的兩個表單 modal(欄位可聚焦:焦點在框裡那一格會落在描述欄 / 名稱欄上)
  { name: "新增策略", open: `(running = false, nsOpen($("strat-add")))`, isOpen: `!$("ns-scrim").hidden`, text: "#ns-modal .ns-hint" },
  { name: "新增報告", open: `(running = false, rptNewOpen($("rpt-ask")))`, isOpen: `!$("rpn-scrim").hidden`, text: "#rpn-honest" },
  // 0.1.13 上網找點子(殼同新增策略;焦點在框裡那一格落在方向欄上)
  { name: "上網找點子", open: `(running = false, ENV.cur = "local", ideaOpen($("chat-idea"), "welcome", "any"))`, isOpen: `!$("idea-scrim").hidden`, text: "#idea-title" },
  // 0.1.8 報告分享確認框(焦點在框裡那一格落在「匿名」radio 上)
  { name: "報告分享", open: `(hasToken = true, shrOpen({ env: "local", id: "x", rep: { type: "research", title: "t", blocks: [] }, host: $("rpt-read"), share: null, name: null }, "new", $("rpt-share")))`, isOpen: `!$("shr-scrim").hidden`, text: "#shr-must" },
  // 0.1.33 第一次對話 modal(焦點在框裡那一格落在主鈕上;點遮罩不關,所以 Esc 是鍵盤唯一的出口)
  { name: "第一次對話", open: `introShow()`, isOpen: `!$("intro-scrim").hidden`, text: "#intro-title" },
  // 0.1.36 額度用完卡片開的「用你自己的 AI」(焦點在框裡那一格落在列上的鈕或 ✕)
  { name: "用你自己的 AI", open: `laiOpen({ b2: $("ta") })`, isOpen: `!$("lai-scrim").hidden`, text: "#lai-lede" },
  // 模型選單沒有型錄時整塊沒有版面(量到 0×0),點不到字;它的點擊路徑跟「焦點在 body」同一條(document 層),由那一格代表
  { name: "模型選單", open: `mpOpen(false)`, isOpen: `!$("mp-panel").hidden`, text: null },
  // 0.1.8 策略版本(versions.js 自己的 capture 層 Esc):比較框、版本選單(同模型選單:觸發器藏著時沒有版面,點不到字)
  { name: "比較版本", open: `(VS.local.data = { counter: 2, current: 2, items: [{ n: 1, at: 1757000000 }, { n: 2, at: 1757100000 }] }, VS.local.name = "x", vcOpen())`, isOpen: `!$("vc-scrim").hidden`, text: "#vc-title" },
  { name: "版本選單", open: `(VS.local.data = { counter: 2, current: 2, items: [{ n: 1, at: 1757000000 }, { n: 2, at: 1757100000 }] }, verMenuOpen(false))`, isOpen: `!$("ver-menu").hidden`, text: null },
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
      if (!closed) await js(`try { delClose(false); cxModalClose(false); lbClose(); setClose(); mpClose(false); nsClose(); rptNewClose(); introClose("close"); laiClose(); } catch (_) {}`);
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
  // 泡泡是最上層的暫態層(六套泡泡 × 三種上層:escTop 管的設定框、trade.js 自己接 Esc 的 ps-scrim、versions.js capture 層的比較框):
  // 泡泡開著時第一下 Esc 只收泡泡、上層還在;第二下才關上層
  const ROB_SCAN = { row_param: "A", col_param: "B", row_vals: [10, 20, 30], col_vals: [0.5, 0.7, 0.9], grid: [[3.0, 0.2, 0.1], [0.3, 1.4, 1.5], [null, 1.5, 1.6]], window: 1, fee: 0.0005, start: "2025-01-01", end: "2025-06-01", generated_at: 100 };
  const WF = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "wf_sample.json"), "utf8"));
  const box = `(() => { let b = document.getElementById("__tipbox"); if (b) b.remove(); b = document.createElement("div"); b.id = "__tipbox"; b.style.width = "760px"; document.body.appendChild(b); return b; })()`;
  const focusCell = (sel) => `(() => { const td = document.querySelector(${JSON.stringify(sel)}); td.focus(); td.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); })()`;
  const isOn = (id) => `(!!document.getElementById(${JSON.stringify(id)}) && document.getElementById(${JSON.stringify(id)}).classList.contains("is-on"))`;
  const TIPS = {
    ".tip(CSS 帶出,滑過)": { inModal: true, show: (host) => `(() => { const h = document.querySelector(${JSON.stringify(host)}); const b = document.createElement("button"); b.type = "button"; b.className = "mp-tip"; b.id = "__mt"; b.textContent = "說明字";
        const p = document.createElement("span"); p.className = "tip"; p.id = "__mtp"; p.textContent = "泡泡"; h.prepend(b, p); const r = b.getBoundingClientRect(); return { x: Math.round(r.left + 4), y: Math.round(r.top + r.height / 2) }; })()`,
      on: `(!!document.getElementById("__mtp") && getComputedStyle(document.getElementById("__mtp")).display !== "none")`, gone: `["__mt", "__mtp"].forEach((i) => { const n = document.getElementById(i); if (n) n.remove(); })` },
    "參數掃描 .rob-tip": { show: () => `(window.BlaveReport.renderRobust(${box}, { stats: { symbol: "BTCUSDT", interval: "1h", start: "2025-01-01", end: "2025-06-01", "fee [%]": 0.05, "Generated At": 50 }, scan: ${JSON.stringify(ROB_SCAN)}, code: "", name: "s1" }, { t }), ${focusCell("#__tipbox .rob-tbl td")})`, on: isOn("rob-tip") },
    "前進測試 .wf-tip": { show: () => `(window.BlaveReport.renderWf(${box}, { stats: { symbol: "BTCUSDT", interval: "1d", start: "2023-01-01", end: "2024-11-30", "Generated At": 50 }, wf: ${JSON.stringify(WF)}, code: "ENTRY_TH = 0.002\\nEXIT_TH = -0.002\\n", name: "s1" }, { t, busy: false, turn: 1, scope: "local", gate: true }), ${focusCell("#__tipbox .wf-grid td[tabindex='0']")})`, on: isOn("wf-tip") },
    "成交紀錄 .hist-tip": { show: () => `(() => { const b = trHistTipBtn("未確認", "說明", "hist:x"); ${box}.append(b); b.dispatchEvent(new MouseEvent("mouseenter")); })()`, on: isOn("hist-tip") },
    // 分頁 tooltip(chattabs.js):滑鼠停在分頁上帶出,焦點不在分頁列
    "對話分頁 #tabs-tip": { show: () => `(() => { const p = $("tabs-tip"); delete p.dataset.off; p.textContent = "分頁"; p.hidden = false; })()`, on: `!$("tabs-tip").hidden`, gone: `tabsTipOff()` },
    "內建瀏覽器 .bv-addr .tip": { show: () => `(() => { const h = ${box}, b = document.createElement("button"), p = document.createElement("span"); p.className = "tip"; p.id = "__brt"; p.textContent = "說明"; h.append(b, p); brTipAttach(b, p); b.dispatchEvent(new MouseEvent("mouseenter")); })()`, on: isOn("__brt") },
  };
  const LAYERS = [
    { name: "設定(escTop)", host: "#set-modal", open: `(running = false, setOpen())`, isOpen: `!$("set-scrim").hidden`, close: `setClose()` },
    { name: "選策略框 ps-scrim(trade.js 自己接 Esc)", host: "#ps-modal", open: `(TRP.started || trInit(), $("ps-scrim").hidden = false, $("ps-scrim").classList.add("open"), $("ps-cancel").focus())`, isOpen: `!$("ps-scrim").hidden`, close: `psClose()` },
    { name: "比較版本(versions.js capture)", host: "#vc-modal", open: MODALS.find((m) => m.name === "比較版本").open, isOpen: `!$("vc-scrim").hidden`, close: `vcClose()` },
  ];
  for (const L of LAYERS) for (const [tn, T] of Object.entries(TIPS)) {
    await js(L.open); await wait(250);
    const pt = await js(T.show(L.host)); await wait(80);
    if (T.inModal) { w.webContents.sendInputEvent({ type: "mouseMove", x: pt.x, y: pt.y }); await wait(120); }
    const s0 = await js(`({ tip: ${T.on}, open: ${L.isOpen} })`);
    await esc();
    const s1 = await js(`({ tip: ${T.on}, open: ${L.isOpen} })`);
    await esc();
    const s2 = await js(`({ open: ${L.isOpen} })`);
    ok(`${L.name} + ${tn}:泡泡開著第一下 Esc 只收泡泡、框還在;第二下才關框`, s0.tip && s0.open && !s1.tip && s1.open && !s2.open, JSON.stringify([s0, s1, s2]));
    if (s2.open) await js(`try { ${L.close} } catch (_) {}`);
    if (T.gone) await js(T.gone);
    await js(`(() => { const b = document.getElementById("__tipbox"); if (b) b.remove(); })()`);
    if (T.inModal) { w.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 }); await wait(60); }
  }
  // 沒有泡泡時 Esc 照常一下關框(不被白白吃掉一下)
  await js(`(running = false, setOpen())`); await wait(250); await esc();
  ok("沒有泡泡:Esc 一下就關設定", await js(`$("set-scrim").hidden`));
  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
