// 「送進 TradingView」在中欄變窄時(e2e 0.1.8 第七批 #6,P1):窄版面 TradingView 不畫 Pine 那顆鈕,流程卡在 pine_button。
// 流程那一段(門檻、什麼時候換寬、什麼時候還原、原因 narrow)在 tests/check_shell_pine_install.js 用假依賴驗;
// 這一支驗的是外殼真的做得到「顯示在窄的中欄、頁面卻用寬的寬度排版」:真 Electron(隱藏視窗)+ 本機假頁面(窄時用 media query 把那顆鈕藏起來)。
//   ① 窄的中欄:頁面 innerWidth = 中欄寬、鈕是藏著的(重現)
//   ② 換寬:innerWidth = 1280、鈕出現;中欄位置再變一次(用戶拖欄寬、畫面重畫)也不會掉回窄版面
//   ③ 還原:innerWidth 回到中欄寬;之後照一般分頁(換位置不再套寬版面)
//   ④ 停在視窗外(收回展開層)再放回中欄:寬版面期間仍是寬的
// 跑法:BLAVE_TEST_WINDOW=1 node tests/check_shell_pine_narrow.js(沒設就 SKIP)
const path = require("path"), fs = require("fs"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
if (!process.versions.electron) {
  const bin = GATE.bin(SHELL);
  if (!bin) { console.log("\nALL PASS"); process.exit(0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  process.exit(r.status == null ? 1 : r.status);
}
const electron = require("electron");
const { app, BrowserWindow, session } = electron;
const P = require(path.join(SHELL, "browser", "pine.js"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-pine-narrow-"));
app.setPath("userData", tmp);
let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok ? "" : "  " + JSON.stringify(d))); if (!ok) red++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 假的圖表頁:600 以下右側工具列整個不畫(真站實測的行為)
const CHART = `<!doctype html><html><head><title>BTCUSDT.P 84,514.7</title><style>body{margin:0}#rail{position:fixed;right:0;top:0;width:44px}@media (max-width:600px){#rail{display:none}}</style></head>
<body><div id="chart" style="height:600px">chart</div><div id="rail"><button id="pine" aria-label="Pine">Pine</button></div></body></html>`;
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 800, show: false });
  await win.loadURL("data:text/html,<p>host</p>");
  const srv = require("http").createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(CHART); });
  srv.on("connect", (_req, sock) => sock.destroy());
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const ses = session.fromPartition("persist:agent-browser");
  await ses.setProxy({ proxyRules: "http=127.0.0.1:" + srv.address().port + ";https=127.0.0.1:" + srv.address().port, proxyBypassRules: "<-loopback>" });
  const B = require(path.join(SHELL, "browser")).createBrowser({ electron, stateDir: path.join(tmp, "snaps"), reportsDir: path.join(tmp, "reports"), getWin: () => win, uiLang: () => "en", track: () => {}, version: "test", reducedMotion: () => true, userPresent: () => true });
  await B.beginTurn(win, "desktop-narrowtest1");
  const r = JSON.parse((await B._call("browser_open", { url: "http://tv.test/chart/" }, { live: () => true })).content[0].text);
  await B._call("browser_wait", { tab: r.tab }, { live: () => true });
  const tab = B._tabs.byAlias(r.tab), wc = electron.webContents.getAllWebContents().find((w) => w.session === ses && w.getURL().includes("tv.test"));
  const look = async () => JSON.parse(await wc.executeJavaScript("JSON.stringify({ w: window.innerWidth, pine: getComputedStyle(document.getElementById('rail')).display !== 'none' && document.getElementById('pine').getBoundingClientRect().width > 0 })"));
  const settle = async (want) => { let g = null; for (let i = 0; i < 40; i++) { g = await look(); if (g.w === want) return g; await sleep(100); } return g; };
  const L = B._pineLayout(tab.id);
  t("停在視窗外的分頁:寬度 0(不用換)", L.width() === 0, L.width());

  // ① 窄的中欄
  B.expand(tab.id, { x: 260, y: 143, width: 512, height: 600 });
  let g = await settle(512);
  t("① 中欄 512:頁面就是 512 寬、Pine 那顆鈕沒有畫出來(重現);外殼量到的寬度 = 512,低於門檻 " + P.TV_MIN_W, g.w === 512 && g.pine === false && L.width() === 512 && L.width() < P.TV_MIN_W, g);
  // ② 換寬
  const ok = await L.widen(P.TV_LAYOUT_W);
  g = await settle(P.TV_LAYOUT_W);
  t("② 換成寬版面:頁面以 1280 排版、鈕出現;中欄那一格的位置與大小沒有變(不動用戶的版面)", ok === true && g.w === 1280 && g.pine === true && JSON.stringify(B._viewBounds(tab.id)) === JSON.stringify({ x: 260, y: 143, width: 512, height: 600 }), [ok, g, B._viewBounds(tab.id)]);
  B.bounds({ x: 260, y: 143, width: 540, height: 600 });
  await sleep(400); g = await look();
  t("② 寬版面期間中欄位置再變(拖欄寬、畫面重畫):仍然是 1280,不會掉回窄版面", g.w === 1280 && g.pine === true && B._viewBounds(tab.id).width === 540, g);
  // ④ 收回再展開
  B.collapse(); await sleep(300); g = await look();
  const parked = g.w;
  B.expand(tab.id, { x: 260, y: 143, width: 512, height: 600 }); await sleep(400); g = await look();
  t("④ 寬版面期間收回展開層再放回中欄:前後都是寬的", parked === 1280 && g.w === 1280 && g.pine === true, [parked, g]);
  // ③ 還原
  await L.narrow();
  g = await settle(512);
  t("③ 還原:頁面回到中欄的真實寬度", g.w === 512 && g.pine === false, g);
  // 隱藏視窗裡單純改中欄大小不會讓頁面重排(還沒換寬之前就是這樣,跟這次的改動無關),所以這裡只驗「沒有再被套回 1280」
  B.bounds({ x: 260, y: 143, width: 560, height: 600 });
  await sleep(500); g = await look();
  t("③ 還原之後照一般分頁:換位置不再套寬版面", g.w !== 1280 && g.pine === false && B._viewBounds(tab.id).width === 560, g);
  B.endTurn();
  srv.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* userData 還鎖著 */ }
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + (e && e.stack)); app.exit(1); });
