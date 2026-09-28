// 系統的提示泡泡(title)不留在螢幕上(#207):按下去之後、視窗退到背景時 title 收起來,之後原樣放回去(app.js titleHold / titleBack)。
// 驗的是 title 屬性的進出;系統畫的那顆泡泡本身在不顯示的視窗裡看不到,這支驗不到它。
//   ① 接線:主行程在視窗 focus / blur 時講 window-active、preload 交出 onWindowActive、報告那顆單例泡泡也聽
//   ② Electron(不顯示的視窗、真的 index.html、假的 window.blave):真的滑鼠按下 / 移開、視窗進出背景
// 跑法:node tests/check_shell_title_hold.js(② 要 BLAVE_TEST_WINDOW=1)
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 600))); if (!c) red++; };

if (!process.versions.electron) {
  const read = (f) => fs.readFileSync(path.join(SHELL, f), "utf8");
  const main = read("main.js"), pre = read("preload.js"), rob = read("renderer/report-robust.js");
  ok("① 主行程:視窗 focus 講 true、blur 講 false,只講給自家頁面", /const tellActive = \(w, on\) => \{ if \(w && !w\.isDestroyed\(\) && isOurPageUrl\(w\.webContents\.getURL\(\)\)\) w\.webContents\.send\("window-active", on\); \};/.test(main)
    && /app\.on\("browser-window-focus", \(_e, w\) => \{[^\n]*tellActive\(w, true\); \}\);/.test(main) && /app\.on\("browser-window-blur", \(_e, w\) => \{[^\n]*tellActive\(w, false\); \}\);/.test(main));
  ok("① preload 交出 onWindowActive(只交布林)", /onWindowActive: \(fn\) => ipcRenderer\.on\("window-active", \(_e, on\) => fn\(on === true\)\),/.test(pre));
  ok("① 報告的單例泡泡:視窗退到背景收、錨點不在畫面上了收", /window\.blave\.onWindowActive\(\(on\) => \{ if \(!on\) hideTip\(\); \}\);/.test(rob) && /if \(tipAnchor && !tipAnchor\.getClientRects\(\)\.length\) hideTip\(\);/.test(rob));
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
const STUB = `window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k === "onWindowActive" ? (fn) => { window.__active = fn; }
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
  const mouse = async (type, x, y) => { w.webContents.sendInputEvent(type === "mouseMove" ? { type, x, y } : { type, x, y, button: "left", clickCount: 1 }); await wait(120); };
  // 一顆蓋在最上層的鈕,包在一個也有 title 的容器裡;按下去時順手把自己的 title 換掉的另一顆放旁邊
  await js(`(() => { const box = document.createElement("div"); box.id = "th-box"; box.title = "外層"; box.style.cssText = "position:fixed;left:200px;top:200px;width:200px;height:40px;z-index:99999";
    const mk = (id, left) => { const b = document.createElement("button"); b.id = id; b.type = "button"; b.title = "說明 " + id; b.setAttribute("aria-label", "名字"); b.style.cssText = "position:absolute;left:" + left + "px;top:0;width:80px;height:40px"; box.appendChild(b); return b; };
    mk("th-a", 0); mk("th-b", 100).addEventListener("click", (e) => { e.currentTarget.title = "按過了"; });
    document.body.appendChild(box); window.__clicks = 0; document.getElementById("th-a").addEventListener("click", () => window.__clicks++); })()`);
  const at = (id) => js(`(() => { const e = document.getElementById(${JSON.stringify(id)}); return { title: e.getAttribute("title"), held: e.dataset.titleHeld === undefined ? null : e.dataset.titleHeld, label: e.getAttribute("aria-label") }; })()`);
  const J = JSON.stringify;

  ok("② 畫面有把 onWindowActive 接起來", await js(`typeof window.__active === "function"`));
  await mouse("mouseMove", 240, 220);
  ok("② 滑過、還沒按:title 在", J(await at("th-a")) === J({ title: "說明 th-a", held: null, label: "名字" }), J(await at("th-a")));
  await mouse("mouseDown", 240, 220); await mouse("mouseUp", 240, 220);
  let a = await at("th-a"), box = await at("th-box");
  ok("② 按下去:這顆與外層的 title 都收起來,aria-label 不動,click 照常", a.title === null && a.held === "說明 th-a" && a.label === "名字" && box.title === null && box.held === "外層" && (await js("window.__clicks")) === 1, J([a, box]));
  ok("② 旁邊沒被按的那顆不動", (await at("th-b")).title === "說明 th-b");
  await mouse("mouseMove", 320, 220);
  a = await at("th-a"); box = await at("th-box");
  ok("② 游標離開那顆:它的放回去;還在外層裡,外層的還收著", a.title === "說明 th-a" && a.held === null && box.title === null && box.held === "外層", J([a, box]));
  await mouse("mouseMove", 700, 500);
  ok("② 游標離開外層:外層的也放回去", J(await at("th-box")) === J({ title: "外層", held: null, label: null }), J(await at("th-box")));

  await mouse("mouseMove", 320, 220); await mouse("mouseDown", 320, 220); await mouse("mouseUp", 320, 220);
  let b = await at("th-b");
  ok("② 收著的期間被重設:新的 title 在", b.title === "按過了" && b.held === "說明 th-b", J(b));
  await mouse("mouseMove", 700, 500);
  b = await at("th-b");
  ok("② …游標離開後留新的,不蓋回舊的", b.title === "按過了" && b.held === null, J(b));

  const before = await js(`document.querySelectorAll("[title]").length`);
  await js(`window.__active(false)`);
  let st = await js(`({ titled: document.querySelectorAll("[title]").length, held: document.querySelectorAll("[data-title-held]").length })`);
  ok("② 視窗退到背景:整頁沒有一個 title(" + before + " 個都收著)", before > 3 && st.titled === 0 && st.held === before, J([before, st]));
  await js(`window.__active(true)`);
  st = await js(`({ titled: document.querySelectorAll("[title]").length, held: document.querySelectorAll("[data-title-held]").length })`);
  ok("② 視窗回來:原樣放回去", st.titled === before && st.held === 0 && (await at("th-a")).title === "說明 th-a", J([before, st]));

  // 重現的那條路:按下去 → 別的 app 到前面 → 游標離開(人在別的 app 裡動滑鼠)→ 回來
  await mouse("mouseMove", 240, 220); await mouse("mouseDown", 240, 220); await mouse("mouseUp", 240, 220);
  await js(`window.__active(false)`);
  await mouse("mouseMove", 700, 500);
  a = await at("th-a");
  ok("② 按下去後視窗退到背景、游標離開:還收著", a.title === null && a.held === "說明 th-a", J(a));
  await js(`window.__active(true)`);
  ok("② 回來才放回去", J(await at("th-a")) === J({ title: "說明 th-a", held: null, label: "名字" }) && (await js(`document.querySelectorAll("[data-title-held]").length`)) === 0, J(await at("th-a")));

  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
