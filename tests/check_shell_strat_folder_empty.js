// 0 支策略建資料夾(Wei 11-02 實測:按得下、存得進去,畫面卻沒有那一組)。真的 index.html 與 renderer 跑在 offscreen Electron,主行程換成假的,偏好存在 localStorage,重新載入驗持久化。
// 跑法:BLAVE_TEST_WINDOW=1 node tests/check_shell_strat_folder_empty.js
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");

if (!process.versions.electron) {
  const bin = GATE.bin(SHELL);
  if (!bin) { process.exit(0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  process.exit(r.status == null ? 1 : r.status);
}
const { app, BrowserWindow } = require("electron");
const os = require("os");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-sg0-")));
const STUB = `window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : k === "stratPrefs" ? async () => JSON.parse(localStorage.getItem("t_prefs") || "null")
  : k === "stratPrefsSet" ? async (p) => { localStorage.setItem("t_prefs", JSON.stringify(p)); return { ok: true }; }
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" },
      telemetryGet: true, telemetryInstallId: "a3f9c2e1-7b04-4d6e-9e21-5c0b8d4f1a77" })[k] });`;
let red = 0; const ok = (n, c, why) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || !why ? "" : "  ← " + why)); if (!c) red++; };

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  const X = (s) => w.webContents.executeJavaScript(s, true), nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const boot = async () => { await w.loadFile(path.join(SHELL, "renderer", "index.html")); await nap(1500); await X(`enterWorkspace && enterWorkspace("claude")`).catch(() => {}); await X(`(async () => { await stratRefresh(false); })()`); await nap(300); };
  const heads = () => X(`[...document.querySelectorAll("#strat-list > .sg-head")].map((h) => h.dataset.gid === "_u" ? "_u" : h.querySelector(".sg-name").textContent)`);
  await boot();
  const start = await X(`(() => { const a = $("sg-add"), b = a && a.getBoundingClientRect(); return { list: RP.list.length, hasBtn: !!a, hidden: a ? a.hidden : null, w: b ? b.width : 0, top: a ? document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === a || a.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)) : false }; })()`);
  ok("0 支策略:新增資料夾鈕在、看得到、點得到:" + JSON.stringify(start), start.list === 0 && start.hasBtn && !start.hidden && start.w > 0 && start.top);
  const add = (name) => X(`(async () => { $("sg-add").click(); await new Promise((r) => setTimeout(r, 50)); const i = document.querySelector("#strat-list .sg-input"); if (!i) return false; i.value = ${JSON.stringify(name)}; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await new Promise((r) => setTimeout(r, 200)); return true; })()`);
  ok("按下去有編輯列", await add("趨勢組"));
  ok("Enter 存下去,組標題當場畫出來;沒有策略時不畫「未分類」", JSON.stringify(await heads()) === JSON.stringify(["趨勢組"]), JSON.stringify(await heads()));
  await add("第二組");
  ok("再建一個排在後面", JSON.stringify(await heads()) === JSON.stringify(["趨勢組", "第二組"]), JSON.stringify(await heads()));
  await nap(900);   // sfSave 有延遲
  await boot();
  ok("重新載入還在", JSON.stringify(await heads()) === JSON.stringify(["趨勢組", "第二組"]), JSON.stringify(await heads()));
  const delOk = await X(`(() => { const list = [{ name: "a", displayName: "A", hasBacktest: true }]; const box = $("strat-list"); sgLayout(box, SF_LOCAL, list); const h = [...box.querySelectorAll(":scope > .sg-head")].map((x) => x.dataset.gid); sgLayout(box, SF_LOCAL, []); return h.includes("_u"); })()`);
  ok("有策略時「未分類」照舊畫", delOk === true);
  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + String((e && e.stack) || e).slice(0, 600)); app.exit(1); });
