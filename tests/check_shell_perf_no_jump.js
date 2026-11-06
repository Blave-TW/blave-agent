// 按〔更新績效〕不跳版(0.1.45):.upd 三態寬度不同時,.bt-meta 折行的位置跟著變,下面的內容上下跳一行(量到 19–22px)。
// 真的 index.html、真的 renderBacktest + perfPaint,視窗不顯示:寬度 280–1100、zh／en、有無「N 天前」、亮暗,
// 閒置 → 更新中 → 更新完(時間前進,「N 天前」消失)三步,下面內容的位置與 .upd-box 的寬度都不能動。
// 跑法:BLAVE_TEST_WINDOW=1 node tests/check_shell_perf_no_jump.js(沒帶就 SKIP)
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");

if (!process.versions.electron) {
  const bin = GATE.bin(SHELL);
  if (!bin) process.exit(0);
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "blave-nojump-"));
  const r = require("child_process").spawnSync(bin, ["--use-mock-keychain", "--user-data-dir=" + tmp, __filename], { stdio: "inherit", env: { ...process.env, BLAVE_TEST_USERDATA: tmp } });
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(r.status == null ? 1 : r.status);
}

const { app, BrowserWindow, nativeTheme } = require("electron");
app.setPath("userData", process.env.BLAVE_TEST_USERDATA);
const STUB = `window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" } })[k] });`;
let red = 0; const ok = (n, c, why) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || !why ? "" : "\n      " + why)); if (!c) red++; };
setTimeout(() => { console.log("FAIL  逾時(120 秒)"); process.exit(1); }, 120000).unref();
const days = Array.from({ length: 30 }, (_, i) => "2026-08-" + String(i + 1).padStart(2, "0"));
const STATS = { strategy: "s", symbol: "BTCUSDT", interval: "1h", start: "2024-10-21", end: "2026-09-22", "fee [%]": 0.05, "Total Return [%]": 12.3, "Sharpe Ratio": 0.9,
  "Max Drawdown [%]": -20.1, "Total Fees Paid [%]": 2.85, Trades: 40, daily_dates: days, daily_returns: days.map((_, i) => (i % 3 - 1) * 0.004) };

app.whenReady().then(async () => {
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await new Promise((r) => setTimeout(r, 1000));
  const sweep = () => w.webContents.executeJavaScript(`(() => {
    const old = document.getElementById("rp-bt"); if (old) old.id = "rp-bt-orig";
    let box = document.getElementById("rp-bt");
    if (!box) { box = document.createElement("div"); box.id = "rp-bt"; box.style.cssText = "position:fixed;left:0;top:0;z-index:99999"; document.body.appendChild(box); }
    const out = {};
    for (const lang of ["zh", "en"]) { LANG = lang;
      for (const aged of [false, true]) {
        const bad = []; let wrapped = 0;
        for (let wd = 280; wd <= 1100; wd += 2) {
          box.style.width = wd + "px"; box.textContent = "";
          const now = Date.now() / 1000, at = now - (aged ? 5 * 86400 : 3600);
          const B = { name: "s", data: { name: "s", stats: ${JSON.stringify(STATS)}, perf: { at }, code: "" } };
          window.BlaveReport.renderBacktest(box, B.data.stats);
          const read = () => { const m = box.querySelector(".bt-meta"), b = box.querySelector(".upd-box"); return { top: m.nextElementSibling.getBoundingClientRect().top, boxW: b ? b.getBoundingClientRect().width : -1, h: m.getBoundingClientRect().height }; };
          PF.local.delete("s"); perfPaint(B); const idle = read();
          PF.local.set("s", { at0: at, ref0: null }); perfPaint(B); const run = read(); PF.local.delete("s");
          B.data.perf = { at: now }; perfPaint(B); const done = read();
          if (idle.h > 20) wrapped++;
          if (idle.top !== run.top || idle.top !== done.top || idle.boxW !== run.boxW || idle.boxW !== done.boxW) bad.push([wd, run.top - idle.top, done.top - idle.top, run.boxW - idle.boxW, done.boxW - idle.boxW]);
        }
        out[lang + (aged ? " 有 N 天前" : "")] = { bad, wrapped };
      }
    }
    return out; })()`, true);
  for (const theme of ["light", "dark"]) {
    nativeTheme.themeSource = theme;
    await new Promise((r) => setTimeout(r, 200));
    const res = await sweep();
    for (const k of Object.keys(res)) ok(theme + " " + k + ":閒置 → 更新中 → 更新完,下面內容與 .upd-box 寬度都不動(寬 280–1100;折行的寬度 " + res[k].wrapped + " 個也算)",
      res[k].bad.length === 0 && res[k].wrapped > 0, "動到的寬度 " + res[k].bad.length + " 個,前幾個 [寬, 更新中位移, 更新完位移, 更新中寬差, 更新完寬差]:" + JSON.stringify(res[k].bad.slice(0, 4)));
  }
  console.log(red ? `\n${red} FAILED` : "\nall pass");
  app.exit(red ? 1 : 0);
});
