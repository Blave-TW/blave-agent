// 報告頁「回測」分頁的頁首那一行(report-backtest.js buildMeta)與指標(設計稽核 005 第 1 條,電腦版那一半)。
// 用隨包的 Electron 開真的 index.html,直接叫 window.BlaveReport.renderBacktest:
//   ① 舊的投資組合(Type C)stats.json:沒有 symbol、只有小數的 fee → 「手續費 0.05%」(fee × 100),開頭沒有多一個「·」
//   ② 有 fee [%] 就用它(不拿 fee 覆蓋);兩個都沒有 → 整段不出(不畫「手續費 —」)
//   ③ runner 現在替 Type C 寫 Sortino / Omega:有值就照畫;舊檔沒有 → 「—」(真的缺值)
// 跑法:node tests/check_shell_report_meta.js(找不到 shell/node_modules 的 Electron 就 SKIP)
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
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-btmeta-")));
const STUB = `window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" } })[k] });`;
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  逾時(60 秒)"); process.exit(1); }, 60000).unref();

// 投資組合那份(形狀照 lib/runner.py 的 Type C stats;數字是編的)
const days = Array.from({ length: 30 }, (_, i) => "2026-08-" + String(i + 1).padStart(2, "0"));
const TYPEC_OLD = { strategy: "rot", interval: "1d", start: "2024-10-21", end: "2026-09-22", fee: 0.0005, "Total Return [%]": 12.3, "Sharpe Ratio": 0.9,
  "Max Drawdown [%]": -20.1, "Total Fees Paid [%]": 2.85, Trades: 40, daily_dates: days, daily_returns: days.map((_, i) => (i % 3 - 1) * 0.004) };

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1000);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const render = (st) => js(`(() => { const box = document.createElement("div"); document.body.appendChild(box); window.BlaveReport.renderBacktest(box, ${JSON.stringify(st)});
    const m = box.querySelector(".bt-meta");
    const val = (k) => { const row = [...box.querySelectorAll(".bt-mrow")].find((r) => (r.querySelector(".mp-tip") || r.querySelector(".bt-mk")).textContent === t(k)); return row ? row.querySelector(".bt-mv").textContent : null; };
    const out = { meta: m ? m.textContent : null, first: m && m.firstChild ? m.firstChild.className : null, sortino: val("bt.sortino"), omega: val("bt.omega") };
    box.remove(); return out; })()`);
  const fee = await js(`t("bt.fee")`);

  let r = await render(TYPEC_OLD);
  ok(`① 舊的 Type C(只有 fee 小數):頁首有「${fee} 0.05%」`, r.meta && r.meta.includes(fee + "0.05%") && !r.meta.includes(fee + "—"));
  ok("① 沒有 symbol:開頭沒有多一個「·」(第一個是內容那一段,不是分隔點)", r.first === "bt-mpart" && !/^\s*·/.test(r.meta) && r.meta.startsWith("1d"));
  ok("③ 舊檔沒有 Sortino / Omega:照舊是「—」(真的缺值)", r.sortino === "—" && r.omega === "—");

  r = await render({ ...TYPEC_OLD, "fee [%]": 0.1, "Sortino Ratio": 1.234, "Omega Ratio": 1.5 });
  ok("② 有 fee [%] 就用它(0.10%),不被小數的 fee 覆蓋", r.meta.includes(fee + "0.10%") && !r.meta.includes("0.05%"));
  ok("③ runner 新寫的 Type C 有 Sortino / Omega:照畫", r.sortino === "1.23" && r.omega === "1.50");

  const noFee = { ...TYPEC_OLD }; delete noFee.fee;
  r = await render(noFee);
  ok("② 兩個都沒有:手續費那一段整段不出(不畫「手續費 —」)", r.meta && !r.meta.includes(fee));
  r = await render({ ...TYPEC_OLD, fee: "0.0005" });
  ok("② fee 不是數字(壞值):不拿來算", r.meta && !r.meta.includes(fee));
  r = await render({ ...TYPEC_OLD, symbol: "BTCUSDT" });
  ok("有 symbol(Type A):照舊排第一段,之後才是分隔點", r.meta.startsWith("BTCUSDT") && r.first === "bt-mpart");

  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
