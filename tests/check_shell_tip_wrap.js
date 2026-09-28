// 說明泡泡(app.css .tip)的字不跑出底色(0.1.8 Wei 截圖:組合績效「累積報酬(扣入金)」的泡泡只有格子寬、後半句疊到隔壁格)。
// 根因:觸發點掛在 .ov-stats .sl 裡,.sl 為了截斷是 white-space: nowrap,泡泡繼承成一行;.trv .tip 的 max-width 100% 又把底色壓成格寬。
//   ① 原文:.tip 基底自己宣告 white-space: normal、font-weight: 400;績效格的泡泡照字寬(max-content、260 封頂);3 欄的第 3 欄、2 欄的第 2 欄往左長
//   ② 真的排版(隨包的 Electron、看不見的視窗):視窗 1024／1280 × zh／en × 組合績效 ok／累積中,加上總權益、區段標籤、
//      策略頁回測指標、思考深度的泡泡——每一顆 scrollWidth ≤ clientWidth、字在底色裡、不出視窗、不被捲動容器右緣裁掉、字重 400
// 跑法:node tests/check_shell_tip_wrap.js(沒設 BLAVE_TEST_WINDOW=1 時 ② SKIP)
const fs = require("fs"), path = require("path"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 3000))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");

if (!process.versions.electron) {
  const app = read(path.join(R, "app.css")), trade = read(path.join(R, "trade.css"));
  const rule = (css, sel) => (css.match(new RegExp("(^|\\n)\\s*" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{[^}]*\\}")) || [""])[0];
  ok("① .tip 基底宣告 white-space: normal(不從觸發點繼承 nowrap)", /white-space: normal;/.test(rule(app, ".tip")), rule(app, ".tip"));
  ok("① .tip 基底宣告 font-weight: 400(canon Bubble;不從 .sl 繼承 600)", /font-weight: 400;/.test(rule(app, ".tip")), rule(app, ".tip"));
  ok("① 績效格的泡泡照字寬:max-content、260 封頂", /width: max-content;/.test(rule(trade, ".ov-stats .sl-tip .tip")) && /max-width: 260px;/.test(rule(trade, ".ov-stats .sl-tip .tip")), rule(trade, ".ov-stats .sl-tip .tip"));
  const narrow = (trade.match(/@container \(max-width: 520px\) \{[\s\S]*?\n\}/) || [""])[0];
  ok("① 3 欄:第 3 欄往左長;2 欄:第 3 欄改回往右、第 2 欄往左長(2n 排在 3n 之後)", /\.perf-stats \.stat:nth-child\(3n\) \.tip \{ left: auto; right: 0; \}/.test(trade)
    && /\.perf-stats \.stat:nth-child\(3n\) \.tip \{ left: 0; right: auto; \}\n\s*\.perf-stats \.stat:nth-child\(2n\) \.tip \{ left: auto; right: 0; \}/.test(narrow));
  const bin = GATE.bin(SHELL, "②");
  if (!bin) { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  // 暫存的 userData 由這一層開、這一層收:Electron 關閉時還會往 userData 寫檔,子行程自己刪過也會再長回來
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-tipwrap-"));
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, BLAVE_TEST_USERDATA: tmp } });
  fs.rmSync(tmp, { recursive: true, force: true }); ok("跑完暫存目錄不存在", !fs.existsSync(tmp), tmp);
  const sub = r.status == null ? 1 : r.status;
  console.log(red || sub ? `\n${red + sub} 紅` : "\nALL PASS");
  process.exit(red || sub ? 1 : 0);
}

const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.env.BLAVE_TEST_USERDATA || fs.mkdtempSync(path.join(os.tmpdir(), "blave-tipwrap-")));
const STUB = `window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" } })[k] });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  ② 逾時(120 秒)"); process.exit(1); }, 120000).unref();
const PERF = (st) => ({ code: "OK", pnl_curve: [], metrics: { cumulative_return: { status: st, value: 0.1234 }, max_drawdown: { status: st, value: 0.05, window_days: 30 }, annual_return: { status: st, value: 0.5 },
  volatility: { status: st, value: 0.3 }, sharpe: { status: st, value: 1.2 }, trade_count: { status: st, value: 42 } } });
const days = Array.from({ length: 30 }, (_, i) => "2026-08-" + String(i + 1).padStart(2, "0"));
const BT = { strategy: "x", symbol: "BTCUSDT", interval: "1h", start: "2024-10-21", end: "2026-09-22", fee: 0.0005, "Total Return [%]": 12.3, "Sharpe Ratio": 0.9, "Sortino Ratio": 1.1, "Omega Ratio": 1.2,
  "Max Drawdown [%]": -20.1, "Total Fees Paid [%]": 2.85, "Win Rate [%]": 55, "Profit Factor": 1.3, Trades: 40, daily_dates: days, daily_returns: days.map((_, i) => (i % 3 - 1) * 0.004) };
// 每顆泡泡:強制顯示(= hover／focus 時的樣子)後量;裁切邊 = 最近一個 overflow-x 不是 visible 的祖先
const MEASURE = `((sel) => { const out = [], vw = window.innerWidth;
  const clip = (e) => { for (let p = e.parentElement; p; p = p.parentElement) if (getComputedStyle(p).overflowX !== "visible") return p; return document.documentElement; };
  document.querySelectorAll(sel).forEach((tip) => { if (!tip.textContent) return; tip.style.display = "block";
    const r = tip.getBoundingClientRect(), g = document.createRange(); g.selectNodeContents(tip); const tr = g.getBoundingClientRect(), c = clip(tip).getBoundingClientRect();
    out.push({ text: tip.textContent.slice(0, 16), w: Math.round(r.width), sw: tip.scrollWidth, cw: tip.clientWidth, txtOut: tr.right > r.right + 0.5 || tr.left < r.left - 0.5, fw: getComputedStyle(tip).fontWeight,
      inView: r.left >= 0 && r.right <= vw, inClip: r.left >= c.left - 0.5 && r.right <= c.right + 0.5 });
    tip.style.display = ""; }); return out; })`;

app.whenReady().then(async () => {
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1000);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const judge = (name, m) => { const bad = m.filter((x) => x.sw > x.cw || x.txtOut || !x.inView || !x.inClip), heavy = m.filter((x) => x.fw !== "400");
    ok(`② ${name}:${m.length} 顆泡泡字都在底色裡、不出視窗、不被裁(寬 ${[...new Set(m.map((x) => x.w))].join("/")})`, m.length > 0 && !bad.length, JSON.stringify(bad));
    ok(`② ${name}:泡泡字重都是 400`, m.length > 0 && !heavy.length, JSON.stringify(heavy)); };
  for (const W of [1024, 1280]) {
    w.setContentSize(W, 820); await wait(400);
    for (const lang of ["zh", "en"]) {
      for (const st of ["ok", "accumulating"]) {
        const res = await js(`(() => { setLang("${lang}"); $("main-empty").hidden = true; $("rp").hidden = true; $("tr").hidden = false;
          const box = $("tr-over"); box.hidden = false; box.textContent = ""; TR.ov.perf = ${JSON.stringify(PERF(st))}; TR.ov.perfErr = false; TR.ov.curve = { curve: [] };
          box.append(trOvStats(), trOvPerf(), trSec(trTipLabel("label", t("tr.strategies"), t("tr.zeroMeansOff"))), trSec(trTipLabel("label", t("tr.exchPositions"), t("tr.threshold"))));
          return { cols: getComputedStyle(box.querySelector(".perf-stats")).gridTemplateColumns.split(" ").length, m: ${MEASURE}("#tr-over .tip") }; })()`);
        judge(`${W} ${lang} 總覽(組合績效 ${res.cols} 欄、${st})`, res.m);
      }
      judge(`${W} ${lang} 策略頁回測指標`, await js(`(() => { $("tr").hidden = true; $("rp").hidden = false; const b = $("rp-bt"); b.hidden = false; b.textContent = "";
        window.BlaveReport.renderBacktest(b, ${JSON.stringify(BT)}); return ${MEASURE}("#rp-bt .tip"); })()`));
      judge(`${W} ${lang} 思考深度`, await js(`(() => { $("mp").hidden = false; $("mp-panel").hidden = false; $("mp-tipbox").textContent = t("mp.cap", { model: "Claude Opus 4.5", level: "High" });
        const m = ${MEASURE}("#mp-tipbox"); $("mp-panel").hidden = true; return m; })()`));
    }
  }
  process.exit(red ? 1 : 0);
});
