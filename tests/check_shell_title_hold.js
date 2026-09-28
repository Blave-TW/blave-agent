// 「用系統瀏覽器開」的提示不留在螢幕上(#207,第二十一批換做法):系統畫的 title 泡泡在按下去、系統瀏覽器跳到前面之後收不掉
// (第十九批把 title 屬性收起來也收不掉它——泡泡是系統畫的),所以這顆鈕不用 title,說明自家畫在 DOM 裡(app.css .tip),
// 由 browser.js brTipAttach 開關:滑過 / 鍵盤聚焦出;離開、失焦、按下去、Esc、視窗退到背景都收。
// 系統泡泡本身在不顯示的視窗裡看不到;這支驗的是:這顆鈕沒有 title、自家泡泡的進出、通用的 title 改寫已經拿掉。
//   ① 接線:鈕沒有 title、aria-describedby 指到泡泡;app.js 沒有通用 title 收放;window-active IPC 留著(報告與瀏覽器的泡泡都聽)
//   ② Electron(不顯示的視窗、真的 index.html、假的 window.blave):真的滑鼠移入 / 按下 / 移開、鍵盤聚焦、視窗進出背景
// 跑法:node tests/check_shell_title_hold.js(② 要 BLAVE_TEST_WINDOW=1)
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 600))); if (!c) red++; };

if (!process.versions.electron) {
  const read = (f) => fs.readFileSync(path.join(SHELL, f), "utf8");
  const main = read("main.js"), pre = read("preload.js"), rob = read("renderer/report-robust.js"), br = read("renderer/browser.js"), appjs = read("renderer/app.js"), css = read("renderer/browser.css");
  ok("① 這顆鈕沒有 title;說明是 DOM 裡的 role=tooltip、鈕用 aria-describedby 指到它、字還是 br.openSystem.tip", !/ext\.title/.test(br)
    && /const extTip = brEl\("span", "tip", t\("br\.openSystem\.tip"\)\); extTip\.id = "bv-ext-tip"; extTip\.setAttribute\("role", "tooltip"\); ext\.setAttribute\("aria-describedby", extTip\.id\);/.test(br) && /brTipAttach\(ext, extTip\);/.test(br));
  ok("① 泡泡的開關:滑入出;mouseleave / pointerdown / Esc / 視窗退到背景收", /btn\.addEventListener\("mouseenter", \(\) => \{ brTipHide\(\); tip\.classList\.add\("is-on"\); brTipOn = tip; \}\);/.test(br)
    && /\["mouseleave", "pointerdown"\]\.forEach\(\(ev\) => btn\.addEventListener\(ev, brTipHide\)\);/.test(br) && /if \(e\.key === "Escape"\) brTipHide\(\);/.test(br) && /window\.blave\.onWindowActive\(\(on\) => \{ if \(!on\) brTipHide\(\); \}\);/.test(br));
  // 鍵盤聚焦走 CSS(同 .mp-tip:focus-visible + .tip):不顯示的視窗裡 document 沒有焦點、focus 事件不會發,這一段只能靜態驗
  ok("① 泡泡樣式:app.css .tip 材質,掛在網址列下方靠右;鍵盤 focus-visible 由 CSS 出", /\.bv-addr \{ position: relative; \}/.test(css) && /\.bv-addr \.tip \{ left: auto; right: 0; top: calc\(100% \+ 6px\); bottom: auto; \}/.test(css) && /\.bv-addr \.tip\.is-on, \.bv-addr \.ibtn:focus-visible \+ \.tip \{ display: block; \}/.test(css));
  ok("① 第十九批的通用 title 收放拿掉了(不改寫整頁的 title、不留 data-title-held)", !/titleHold|titleBack|data-title-held|titleHeld/.test(appjs) && !/querySelectorAll\("\[title\]"\)/.test(appjs));
  ok("① window-active IPC 留著(報告與瀏覽器的自家泡泡都靠它收):主行程 focus / blur 講、preload 交出布林", /const tellActive = \(w, on\) => \{ if \(w && !w\.isDestroyed\(\) && isOurPageUrl\(w\.webContents\.getURL\(\)\)\) w\.webContents\.send\("window-active", on\); \};/.test(main)
    && /app\.on\("browser-window-focus", \(_e, w\) => \{[^\n]*tellActive\(w, true\); \}\);/.test(main) && /app\.on\("browser-window-blur", \(_e, w\) => \{[^\n]*tellActive\(w, false\); \}\);/.test(main)
    && /onWindowActive: \(fn\) => ipcRenderer\.on\("window-active", \(_e, on\) => fn\(on === true\)\),/.test(pre) && /window\.blave\.onWindowActive\(\(on\) => \{ if \(!on\) hideTip\(\); \}\);/.test(rob));
  // 其他按了會失焦的動作(開外部連結、在 Finder 中顯示、送上雲端開網頁、帳號頁)都是文字鈕,沒有 title;留著 title 的是 hover 說明、按了不失焦的
  const losers = ["openExternal", "browserOpenExternal", "revealExport"];
  const titled = [];
  for (const f of fs.readdirSync(path.join(SHELL, "renderer")).filter((x) => x.endsWith(".js") && x !== "strings.js")) {
    const src = read("renderer/" + f);
    for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\.title = /g)) {
      const v = m[1]; if (v === "document") continue;
      const re = new RegExp("\\b" + v.replace(/\$/g, "\\$") + "\\.addEventListener\\(\"click\", [^\\n]*(" + losers.join("|") + ")");
      if (re.test(src)) titled.push(f + ":" + v);
    }
  }
  ok("① 沒有別的「按了會失焦」的鈕還掛著 title", titled.length === 0, titled.join());
  const bin = GATE.bin(SHELL, "②");
  if (!bin) { console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  // 暫存的 userData 由這一層開、這一層收:Electron 關閉時還會往 userData 寫檔,子行程自己刪過也會再長回來(稽核 P2-12)
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "blave-title-"));
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, BLAVE_TEST_USERDATA: tmp } });
  fs.rmSync(tmp, { recursive: true, force: true }); ok("跑完暫存目錄不存在", !fs.existsSync(tmp), tmp);
  const sub = r.status == null ? 1 : r.status;
  console.log(red || sub ? `\n${red + sub} FAILED` : "\nALL PASS");
  process.exit(red || sub ? 1 : 0);
}

const { app, BrowserWindow } = require("electron");
const os = require("os");
app.setPath("userData", process.env.BLAVE_TEST_USERDATA || fs.mkdtempSync(path.join(os.tmpdir(), "blave-title-")));
const STUB = `window.__active = null; window.__ev = null; window.__opened = [];
window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k === "onWindowActive" ? (fn) => { const prev = window.__active; window.__active = (on) => { if (prev) prev(on); fn(on); }; }
  : k === "onBrowserEvent" ? (fn) => { window.__ev = fn; }
  : k === "browserOpenExternal" ? async (id) => { window.__opened.push(id); return true; }
  : k === "platform" ? "darwin"
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" }, browserState: { blocks: [], tabs: [] } })[k] });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  ② 逾時(60 秒)"); process.exit(1); }, 60000).unref();

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1000);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const mouse = async (type, x, y) => { w.webContents.sendInputEvent(type === "mouseMove" ? { type, x, y } : { type, x, y, button: "left", clickCount: 1 }); await wait(120); };
  // 真的那顆鈕:brTipAttach 是 browser.js 的;泡泡照 brExpand 那段組(鈕 + 說明,放在最上層量得到位置)
  await js(`(() => { const box = document.createElement("div"); box.className = "bv-addr"; box.id = "th-box"; box.style.cssText = "position:fixed;left:200px;top:200px;width:300px;height:28px;z-index:99999";
    const a = document.createElement("button"); a.id = "th-pre"; a.type = "button"; a.textContent = "前一顆"; a.style.cssText = "position:absolute;left:100px;top:0;width:80px;height:28px";
    const ext = document.createElement("button"); ext.id = "th-ext"; ext.type = "button"; ext.className = "ibtn ext"; ext.setAttribute("aria-label", "用系統瀏覽器開"); ext.style.cssText = "position:absolute;left:0;top:0";
    const tip = document.createElement("span"); tip.className = "tip"; tip.id = "bv-ext-tip"; tip.setAttribute("role", "tooltip"); tip.textContent = "說明"; ext.setAttribute("aria-describedby", tip.id);
    brTipAttach(ext, tip); box.append(a, ext, tip); document.body.appendChild(box); window.__clicks = 0; ext.addEventListener("click", () => window.__clicks++); })()`);
  const st = () => js(`(() => { const e = document.getElementById("th-ext"), tip = document.getElementById("bv-ext-tip"); return { title: e.getAttribute("title"), on: tip.classList.contains("is-on"), shown: tip.getClientRects().length > 0, described: e.getAttribute("aria-describedby") === tip.id }; })()`);
  const J = JSON.stringify;
  const X = 214, Y = 214, AWAY = [700, 500];

  ok("② 畫面有把 onWindowActive 接起來", await js(`typeof window.__active === "function"`));
  let s = await st();
  ok("② 一開始:鈕沒有 title、泡泡收著、aria-describedby 指到泡泡", s.title === null && !s.on && !s.shown && s.described, J(s));
  await mouse("mouseMove", X, Y); s = await st();
  ok("② 滑過:自家泡泡出現(畫在 DOM 裡、量得到位置);仍然沒有 title", s.on && s.shown && s.title === null, J(s));
  await mouse("mouseDown", X, Y); s = await st();
  ok("② 按下去(游標還在鈕上):泡泡當場收——系統瀏覽器跳到前面之後畫面上不會留著它", !s.on && !s.shown, J(s));
  await mouse("mouseUp", X, Y); s = await st();
  ok("② 放開:click 照常、泡泡不回來", (await js("window.__clicks")) === 1 && !s.on, J(s));
  await mouse("mouseMove", ...AWAY); await mouse("mouseMove", X, Y); s = await st();
  ok("② 移開再移回來:又出", s.on && s.shown, J(s));
  await mouse("mouseMove", ...AWAY); s = await st();
  ok("② 移開:收", !s.on && !s.shown, J(s));
  // 重現的那條路:按下去 → 別的 app 到前面 → 回到 app、切到別頁
  await mouse("mouseMove", X, Y); await mouse("mouseDown", X, Y); await mouse("mouseUp", X, Y);
  await js(`window.__active(false)`); s = await st();
  ok("② 按下去後視窗退到背景:收著", !s.on && !s.shown, J(s));
  await js(`window.__active(true)`); s = await st();
  ok("② 視窗回來、游標沒動:不會自己再出", !s.on && !s.shown, J(s));
  // 滑過中視窗退到背景(沒按):也收
  await mouse("mouseMove", ...AWAY); await mouse("mouseMove", X, Y);
  await js(`window.__active(false)`); s = await st();
  ok("② 滑過中視窗退到背景:收", !s.on, J(s));
  await js(`window.__active(true)`); await mouse("mouseMove", ...AWAY);
  // 滑過中按 Esc:收
  await mouse("mouseMove", X, Y);
  w.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); w.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" }); await wait(150);
  s = await st();
  ok("② 滑過中按 Esc:收", !s.on, J(s));
  await mouse("mouseMove", ...AWAY);
  await mouse("mouseMove", X, Y); await mouse("mouseDown", X, Y); await mouse("mouseUp", X, Y); await wait(100); s = await st();
  ok("② 滑鼠按出來的焦點不是 focus-visible:按完泡泡不回來", !s.on && !s.shown, J(s));

  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
