// 內建瀏覽器標題列「交還 agent」的熱區(0.1.8 第十八批 DF3)。
// 視覺是一行 12px 的文字鈕(17 高),熱區原本只有 18:狀態句那一格 overflow: hidden、高 18,外擴的 pseudo 會被裁掉。
// 熱區用 elementFromPoint 實測(canon › 熱區一律實測,不用 inset 推算):32 高、整塊在標題列內、不蓋到 ✕ 與網址列。
// 跑法:node tests/check_shell_browser_handback_hit.js(沒設 BLAVE_TEST_WINDOW=1 時 Electron 那段 SKIP)
const path = require("path"), fs = require("fs"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 2000))); if (!c) red++; };
if (!process.versions.electron) {
  const css = fs.readFileSync(path.join(SHELL, "renderer", "browser.css"), "utf8");
  ok("① browser.css:文字鈕有外擴的 ::before(高 32、垂直置中)", /\.bw-stat \.btn-quiet::before \{[^}]*height: 32px;[^}]*translateY\(-50%\)/.test(css) && /\.bw-stat \.btn-quiet \{[^}]*position: relative;/.test(css));
  const bin = GATE.bin(SHELL, "②");
  if (!bin) { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  const sub = r.status == null ? 1 : r.status;
  console.log(red || sub ? `\n${red + sub} 紅` : "\nALL PASS");
  process.exit(red || sub ? 1 : 0);
}
const { app, BrowserWindow } = require("electron");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-hb-hit-"));
app.setPath("userData", tmp);
const STUB = `window.__ev = null;
window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k === "onBrowserEvent" ? (fn) => { window.__ev = fn; }
  : k === "browserExpand" ? async () => ({ live: true, status: "ready" })
  : k.startsWith("on") ? () => {} : ["tradeLabels", "browserBounds", "browserBlockVisible", "trackFeature"].includes(k) ? () => {}
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], browserHistory: [], updateState: { phase: "idle", current: "0.0.0" }, telemetryGet: true })[k] });`;
setTimeout(() => { console.log("FAIL  ② 逾時(60 秒)"); process.exit(1); }, 60000).unref();
const MEASURE = `(() => {
  const head = document.querySelector(".bw-head"), btn = document.querySelector(".bw-stat .btn-quiet"), close = document.querySelector(".bw-head .bw-close"), label = document.querySelector(".bw-stat .t"), bar = document.querySelector(".bv-bar, .bv-url, .bv-tabs");
  const br = btn.getBoundingClientRect(), hr = head.getBoundingClientRect(), cx = br.left + br.width / 2, cy = br.top + br.height / 2;
  const hit = (x, y) => { const e = document.elementFromPoint(x, y); return !!e && (e === btn || btn.contains(e)); };
  // 沿中線往上下、左右逐 0.5px 探,連續打到這顆鈕的範圍就是熱區
  const run = (dx, dy) => { let n = 0; while (n < 200 && hit(cx + dx * (n + 0.5), cy + dy * (n + 0.5))) n += 0.5; return n; };
  const up = run(0, -1), down = run(0, 1), left = run(-1, 0), right = run(1, 0);
  const own = (el) => { if (!el) return null; const r = el.getBoundingClientRect(), e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && (e === el || el.contains(e)); };
  const lr = label.getBoundingClientRect();
  return { text: btn.textContent, visual: Math.round(br.width) + "x" + Math.round(br.height), hitH: up + down, hitW: left + right, top: cy - up, bottom: cy + down, headTop: hr.top, headBottom: hr.bottom, headH: Math.round(hr.height),
    statH: Math.round(document.querySelector(".bw-stat").getBoundingClientRect().height), closeOwn: own(close), labelOwn: own(label), labelGap: Math.round((cx - left - lr.right) * 10) / 10, barOwn: own(bar), barTop: bar ? bar.getBoundingClientRect().top : null,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`;
app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const pre = path.join(tmp, "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1024, height: 680, useContentSize: true, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await new Promise((r) => setTimeout(r, 1200));
  const js = (code) => w.webContents.executeJavaScript(code, true);
  for (const lang of ["zh", "en"]) {
    await js(`(async () => { setLang(${JSON.stringify(lang)}); brCollapse(false); window.__ev({ type: "block_open" });
      window.__ev({ type: "page_open", id: "h-${lang}", url: "https://h1.example/", by: "agent", alias: "t9" }); window.__ev({ type: "page_loaded", id: "h-${lang}", title: "H1" });
      await brExpand("h-${lang}"); window.__ev({ type: "user_takeover", id: "h-${lang}" }); await new Promise((r) => setTimeout(r, 100)); })()`);
    const m = await js(MEASURE);
    console.log(`      ${lang}:「${m.text}」視覺 ${m.visual},熱區 ${m.hitW}×${m.hitH}(y ${m.top}–${m.bottom});標題列 y ${m.headTop}–${m.headBottom}、高 ${m.headH};熱區左緣到狀態句文字 ${m.labelGap}`);
    ok(`② ${lang}:熱區高 32(elementFromPoint 實測),視覺不變(狀態句那一格仍是 18 高、標題列 49 高)`, m.hitH === 32 && m.statH === 18 && m.headH === 49 && /x1[5-8]$/.test(m.visual), JSON.stringify(m));
    ok(`② ${lang}:熱區整塊在標題列內、不伸進下面的分頁列 / 網址列`, m.top >= m.headTop && m.bottom <= m.headBottom && (m.barTop == null || m.bottom <= m.barTop) && m.barOwn !== false, JSON.stringify(m));
    ok(`② ${lang}:不蓋到相鄰的東西——✕ 的中心打到 ✕、狀態句文字的中心打到文字、熱區左緣在文字右緣之外;沒有橫向溢出`, m.closeOwn === true && m.labelOwn === true && m.labelGap >= 0 && !m.overflowX, JSON.stringify(m));
  }
  w.destroy();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* userData 還鎖著 */ }
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + (e && e.stack)); app.exit(1); });
