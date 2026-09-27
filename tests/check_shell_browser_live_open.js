// 點瀏覽卡(摘要列的一列) = 開即時頁(Wei 2026-09-27):分頁還活著就切過去,已關掉(收成快照、重開 app)就重新導覽到那個網址;
// 快照只當縮圖與退路(重開被政策擋下時)。歷史對話裡點舊列同一條路(brExpand 不 live 就 showLive)。來源卡已拿掉(0.1.8),每一頁都是摘要列的一列。
//   1. 主行程 showLive:同網址的活分頁 → 原分頁;關掉後 → 新 user 分頁重新載入(伺服器真的收到);被政策擋 → null;
//      user 分頁不觸發外送確認卡(帶著這一輪讀過的字照樣開)
//   2. 畫面接線:brExpand 拿到 live:false 先 showLive 重開;開不了才退回快照
// 跑法:node tests/check_shell_browser_live_open.js(找不到 Electron 只跑 2)
const path = require("path"), fs = require("fs"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

if (!process.versions.electron) {
  const brSrc = fs.readFileSync(path.join(SHELL, "renderer", "browser.js"), "utf8");
  ok("來源卡拿掉了:沒有 brLive / brSources;快照退路只剩展開層的「看快照」", !/brLive|brSources/.test(brSrc) && /on: \(\) => brSnap\(\{ url: x\.url, title: x\.title, snapshot_id: x\.snap \}, b\)/.test(brSrc));
  ok("brExpand:分頁不在了先 showLive 重開(歷史對話點舊列也走這裡),重開失敗才落到快照退路頁",
    /if \(res && !res\.live && !reopened\) \{/.test(brSrc) && /return brExpand\(r\.id, true\);/.test(brSrc));
  ok("preload / main 有 browser-show-live 這條 IPC", /browserShowLive: \(url\) => ipcRenderer\.invoke\("browser-show-live", url\)/.test(fs.readFileSync(path.join(SHELL, "preload.js"), "utf8"))
    && /handle\("browser-show-live", \(_e, url\) => browser\(\)\.showLive\(url\), null\);/.test(fs.readFileSync(path.join(SHELL, "main.js"), "utf8")));
  const bin = path.join(SHELL, "node_modules", ".bin", "electron");
  if (!fs.existsSync(bin)) { console.log("SKIP  真 Electron 那段(找不到 shell/node_modules 的 Electron)"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  process.exit(red || r.status ? 1 : 0);
}

const electron = require("electron");
const { app, BrowserWindow, session } = electron;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-liveopen-"));
app.setPath("userData", tmp);
const hits = [];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 800, show: false });
  await win.loadURL("data:text/html,<p>host</p>");
  const secret = "LIVE-SECRET-" + "q".repeat(40);
  const srv = require("http").createServer((req, res) => {
    const u = new URL(req.url, "http://" + req.headers.host); hits.push(u.host + u.pathname);
    res.writeHead(200, { "content-type": "text/html" });
    if (u.host === "note.test") return res.end(`<title>Note</title><article><p>${"Body text. ".repeat(40)}${secret}</p></article>`);
    res.end("<title>page</title><article><p>" + "Words. ".repeat(40) + "</p></article>");
  });
  srv.on("connect", (_req, sock) => sock.destroy());
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const ses = session.fromPartition("persist:agent-browser");
  await ses.setProxy({ proxyRules: "http=127.0.0.1:" + srv.address().port, proxyBypassRules: "<-loopback>" });
  const sent = [];
  const realSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (ch, ev) => { if (ch === "browser-event") sent.push(ev); return realSend(ch, ev); };
  const B = require(path.join(SHELL, "browser")).createBrowser({ electron, stateDir: path.join(tmp, "snaps"), getWin: () => win, uiLang: () => "en", track: () => {}, version: "test" });
  await B.beginTurn(win, "desktop-liveopen");
  const ctx = { live: () => true };
  const call = async (n, a) => JSON.parse((await B._call(n, a || {}, ctx)).content[0].text);

  let r = await call("browser_open", { url: "http://note.test/a" }); await call("browser_wait", { tab: r.tab });
  await call("browser_read", { tab: r.tab });
  const t1 = B._tabs.byAlias(r.tab);
  const s1 = B.showLive("http://note.test/a");
  ok("分頁還活著:切過去(同一個 id,不重開)", s1 && s1.existing === true && s1.id === t1.id, s1);
  const before = hits.length;
  B._tabs.close(t1.id);
  const s2 = B.showLive("http://note.test/a");
  ok("分頁關掉了:重新導覽(新分頁)", s2 && s2.existing === false && s2.id !== t1.id, s2);
  for (let i = 0; i < 30 && hits.length === before; i++) await new Promise((res) => setTimeout(res, 100));
  ok("…伺服器真的又收到那一頁(即時頁,不是快照)", hits.filter((h) => h === "note.test/a").length >= 2, hits);
  const opened = sent.filter((e) => e.type === "page_open").pop();
  ok("…user 分頁(用戶點的):不長瀏覽卡、外送擋不看它", opened && opened.by === "user", opened);
  const s3 = B.showLive("http://collector.test/c?d=" + encodeURIComponent(secret));
  await new Promise((res) => setTimeout(res, 400));
  ok("帶著這一輪讀過的字照樣開(外送確認只管 agent 分頁),不發確認卡", s3 && s3.id && !sent.some((e) => e.type === "need_user" && e.kind === "confirm"), s3);
  ok("被政策擋的網址(內網)→ null(畫面退回快照)", B.showLive("http://10.0.0.1/") === null);
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
