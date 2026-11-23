// 設定 › 帳號與方案 v3 試用格的頭(planv3.js p3TrialHead;設計稽核 release-0159 §1.3):真的排出來量。
//   ① 一列放得下(中文常見):〔到網站取消試用〕跟徽章距 16
//   ② 英文放不下折到下一列:連結貼齊標題左緣(以前帶 margin-left 8,內縮 8px)、跟上一列距 4
// 用隨包的 Electron 開真的 index.html + CSS(offscreen、不顯示),window.blave 換成假的,呼叫真的 p3TrialHead。
// 跑法:BLAVE_TEST_WINDOW=1 node tests/check_shell_plan_ttl_wrap.js
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
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-pttl-")));
const STUB = `window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" } })[k] });`;
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  → " + d)); if (!c) red++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  逾時(60 秒)"); process.exit(1); }, 60000).unref();

app.whenReady().then(async () => {
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(800);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const measure = (lang, width) => js(`(() => {
    setLang(${JSON.stringify(lang)});
    acct = { plan: { trial_free_until: null } };
    const box = document.createElement("div"); box.style.cssText = "position:fixed;left:40px;top:40px;width:${width}px"; document.body.appendChild(box);
    const act = document.createElement("button"); act.className = "btn-quiet"; act.textContent = t("plan.trialCancel");
    p3TrialHead({ c: t("plan.cyc.monthly"), n: 14 }, false, false, act).forEach((el) => box.appendChild(el));
    const r = (sel) => box.querySelector(sel).getBoundingClientRect(), h = r("h6"), b = r(".plan-badge"), l = r(".plan-ttl > .btn-quiet");
    const out = { wrapped: l.top >= b.bottom - 1, linkL: l.left, h6L: h.left, gap: l.left - b.right, rowGap: l.top - Math.max(h.bottom, b.bottom) };
    box.remove(); return out; })()`);

  const zh = await measure("zh", 640), en = await measure("en", 420), enWide = await measure("en", 900);
  ok("① 中文 640 寬:一列放得下,連結跟徽章距 16(列距 16、連結不帶 margin)", !zh.wrapped && Math.abs(zh.gap - 16) < 0.5, JSON.stringify(zh));
  ok("① 英文 900 寬:一列放得下,同樣距 16", !enWide.wrapped && Math.abs(enWide.gap - 16) < 0.5, JSON.stringify(enWide));
  ok("② 英文 420 寬:連結折到下一列、左緣貼齊標題左緣(不內縮)、跟上一列距 4", en.wrapped && Math.abs(en.linkL - en.h6L) < 0.5 && Math.abs(en.rowGap - 4) < 0.5, JSON.stringify(en));

  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
