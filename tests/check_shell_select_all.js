// 全選(Cmd+A)只選到內容(#208):介面元件的字不可選(app.css),游標落在聊天 / 報告閱讀區 / 策略報告裡時只選那一區(app.js)。
//   ① 規則在:哪些是介面元件、內容區裡的按鈕字照舊可選
//   ② Electron(不顯示的視窗、真的 index.html、假的 window.blave):真的滑鼠點、真的 Cmd+A 鍵
// 鍵是直接送進頁面的(sendInputEvent),系統不會替它做「全選」:頁面自己沒接手的那幾格,看的是「頁面沒攔」+ 主行程的
// webContents.selectAll()(選單「編輯 → 全選」做的就是這一件)選到什麼。真的鍵盤先到頁面還是先到選單,這支驗不到。
// 跑法:node tests/check_shell_select_all.js(② 要 BLAVE_TEST_WINDOW=1)
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 600))); if (!c) red++; };

if (!process.versions.electron) {
  const css = fs.readFileSync(path.join(SHELL, "renderer", "app.css"), "utf8");
  ok("① 介面元件不可選;內容區裡的按鈕字可選", /\n\.pane-strategies, \.pane-div, \.tb, \.chat-head, \[role="tablist"\], nav, button \{ user-select: none; -webkit-user-select: none; \}\n\.chat-scroll button, \.rpt-read button, \.rp-panel button \{ user-select: text; -webkit-user-select: text; \}\n/.test(css));
  const all = fs.readdirSync(path.join(SHELL, "renderer")).filter((f) => /\.css$/.test(f)).map((f) => [f, fs.readFileSync(path.join(SHELL, "renderer", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")]);
  const none = all.flatMap(([f, s]) => [...s.matchAll(/([^{}]+)\{[^}]*user-select: none/g)].map((m) => f + ": " + m[1].trim()));
  ok("① 整個外殼寫 user-select: none 的只有這幾條(新增一條要想過那裡的字要不要能複製)", JSON.stringify(none) === JSON.stringify(["app.css: .pane-strategies, .pane-div, .tb, .chat-head, [role=\"tablist\"], nav, button", "app.css: body.resizing", "trade.css: .cx-chip.is-empty .v"]), JSON.stringify(none));
  // 稽核 P2-9:選取錨在 document 上(nodeType 9,selectAllChildren(document) 之後再按一次)時沒有 parentElement,不能丟例外、照系統
  const appjs = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
  const blk = (appjs.match(/\nconst SELECT_REGIONS = [^\n]*\ndocument\.addEventListener\("keydown", \(e\) => \{[\s\S]*?\n\}\);\n/) || [""])[0];
  const run = (anchorNode, active) => {
    let h = null, prevented = false, picked = null;
    const doc = { activeElement: active || null, addEventListener: (ev, fn) => { if (ev === "keydown") h = fn; } };
    const win = { getSelection: () => ({ anchorNode, selectAllChildren: (r) => { picked = r; } }) };
    new Function("document", "window", blk)(doc, win);
    try { h({ key: "a", metaKey: true, preventDefault: () => { prevented = true; } }); } catch (e) { return "threw: " + e.message; }
    return (prevented ? "prevented" : "system") + (picked ? ":" + picked.id : "");
  };
  const region = { id: "chat-scroll", getClientRects: () => [1] };
  const inChat = { nodeType: 1, closest: () => region };
  ok("① Cmd+A:錨在 document(nodeType 9)→ 不丟、照系統;錨在文字節點 / 元素裡照舊選那一區", !!blk && run({ nodeType: 9, parentElement: null }) === "system"
    && run({ nodeType: 3, parentElement: inChat }) === "prevented:chat-scroll" && run(inChat) === "prevented:chat-scroll" && run(null, null) === "system", [run({ nodeType: 9, parentElement: null }), run({ nodeType: 3, parentElement: inChat })].join());
  const bin = GATE.bin(SHELL, "②");
  if (!bin) { console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  // 暫存的 userData 由這一層開、這一層收:Electron 關閉時還會往 userData 寫檔,子行程自己刪過也會再長回來(稽核 P2-12)
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "blave-selall-"));
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, BLAVE_TEST_USERDATA: tmp } });
  fs.rmSync(tmp, { recursive: true, force: true }); ok("跑完暫存目錄不存在", !fs.existsSync(tmp), tmp);
  const sub = r.status == null ? 1 : r.status;
  console.log(red || sub ? `\n${red + sub} FAILED` : "\nALL PASS");
  process.exit(red || sub ? 1 : 0);
}

const { app, BrowserWindow } = require("electron");
const os = require("os");
app.setPath("userData", process.env.BLAVE_TEST_USERDATA || fs.mkdtempSync(path.join(os.tmpdir(), "blave-selall-")));
const STUB = `window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" } })[k] });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  ② 逾時(60 秒)"); process.exit(1); }, 60000).unref();

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1000);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const selAll = async () => { w.webContents.focus(); const m = [process.platform === "darwin" ? "meta" : "control"];
    await js(`window.__stopped = null`);
    w.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: m }); w.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: m }); await wait(150);
    return js(`window.__stopped`); };
  const sysAll = async () => { w.webContents.selectAll(); await wait(150); };
  const clickOn = async (sel) => {
    const r = await js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(b.left + 6), y: Math.round(b.top + b.height / 2) }; })()`);
    w.webContents.sendInputEvent({ type: "mouseDown", x: r.x, y: r.y, button: "left", clickCount: 1 }); w.webContents.sendInputEvent({ type: "mouseUp", x: r.x, y: r.y, button: "left", clickCount: 1 }); await wait(150);
  };
  // 工作頁、報告閱讀區與程式碼分頁都擺上字;聊天裡放一段回覆、一段程式碼、一顆帶字的按鈕
  await js(`(() => { $("view-connect").hidden = true; $("view-ws").hidden = false; $("main-empty").hidden = true; $("rpt").hidden = false; $("rpt-read").hidden = false;
    $("chat-scroll").innerHTML = '<p id="sa-chat">聊天回覆甲</p><pre id="sa-code">print(1)</pre><button type="button" id="sa-cbtn">卡上的字</button>';
    $("rpt-read").innerHTML = '<p id="sa-rpt">報告內文乙</p><button type="button" class="mp-tip" id="sa-rbtn">欄名丙</button>';
    $("rp-code-pre").textContent = "CODE_D = 1"; $("cs-title").textContent = "對話標題戊"; $("tr-tb-txt").textContent = "狀態己";
    const s = document.createElement("button"); s.className = "strat-row"; s.id = "sa-strat"; s.textContent = "策略庚"; $("strat-list").appendChild(s); $("ta").value = "草稿辛"; })()`);
  await js(`window.addEventListener("keydown", (e) => { window.__stopped = e.defaultPrevented; })`);
  const us = (sel) => js(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).userSelect`);
  const chrome = ["#sa-strat", ".pane-strategies", "#div-side", "#tr-tb-txt", "#cs-title", "#cs-new", "#rp-tabs", "#tr-tabs", "#set-cats"], got = [];
  for (const s of chrome) got.push(await us(s));
  ok("② 介面元件(側欄、分隔條、標題列、分頁、按鈕、設定的分類)算出來都是 none", got.every((v) => v === "none"), JSON.stringify(got));
  const content = ["#sa-chat", "#sa-code", "#sa-cbtn", "#sa-rpt", "#sa-rbtn", "#rp-code-pre", "#tr-desc", "#tr-over", "#lib-rows", "#set-title", "#del-body"], got2 = [];
  for (const s of content) got2.push(await us(s));
  ok("② 內容(聊天回覆、程式碼、報告、策略程式碼、聊天與報告裡的按鈕字、自動下單頁、策略庫、各個框的字)照舊可選", got2.every((v) => v !== "none"), JSON.stringify(got2));

  const picked = () => js(`window.getSelection().toString()`);
  await js(`$("ta").focus()`); let stopped = await selAll(); await sysAll();
  let r = await js(`({ s: $("ta").selectionStart, e: $("ta").selectionEnd, n: $("ta").value.length, focus: document.activeElement.id })`);
  ok("② 焦點在輸入框:頁面不攔,選到的是框裡的字,焦點不動", stopped === false && r.s === 0 && r.e === r.n && r.n === 3 && r.focus === "ta", JSON.stringify([stopped, r]));
  await clickOn("#sa-chat"); stopped = await selAll();
  let p = await picked();
  ok("② 點過聊天內容:只選聊天那一區(回覆、程式碼、卡上的字都在)", stopped === true && p.includes("聊天回覆甲") && p.includes("print(1)") && p.includes("卡上的字") && !/報告內文乙|對話標題戊|策略庚|狀態己|草稿辛/.test(p), p);
  await clickOn("#sa-rpt"); await selAll();
  p = await picked();
  ok("② 點過報告閱讀區:只選報告(帶說明的欄名也在)", p.includes("報告內文乙") && p.includes("欄名丙") && !/聊天回覆甲|對話標題戊|策略庚|狀態己/.test(p), p);
  await js(`window.getSelection().removeAllRanges(); document.activeElement && document.activeElement.blur()`); stopped = await selAll(); await sysAll();
  p = await picked();
  ok("② 沒有落點:頁面不攔;系統全選選到的是內容、沒有介面元件的字", stopped === false && p.includes("聊天回覆甲") && p.includes("報告內文乙") && !/對話標題戊|策略庚|狀態己/.test(p), p.slice(0, 400));
  await js(`(() => { const g = window.getSelection(); g.removeAllRanges(); const x = document.createRange(); x.selectNodeContents($("sa-rpt")); g.addRange(x); $("rpt").hidden = true; })()`); stopped = await selAll();
  ok("② 落點那一區已經不在畫面上:頁面不攔、不硬選它", stopped === false);

  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
