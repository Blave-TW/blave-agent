// 讀得到就算好(e2e 0.1.8 第七批 #5A;實測 09-28:browser_wait 四次各等滿 20–25 秒,共約 95 秒——廣告多的新聞站永遠到不了 load)。
//   ① 原文鎖:門檻是常數、保守(主文件解析完 + 40 字以上的段落合計 400 字 + 連續兩次字數相同);只量 agent 自己開的一般頁
//   ② 真 Electron(隱藏視窗)+ 本機假頁面:
//      a. 正文先到、但有一張圖與一支 async 腳本永遠不回應 → browser_wait 幾秒內回 ready(partial),不是等滿 20 秒
//      b. 只有導覽列、正文還沒來的頁 → 不算好(不會提早)
//      c. 一次等三頁:兩頁好了、一頁永遠不回應 → 幾秒內回來,好的標 ready、沒好的標 loading 並列在 still_loading
//      d. browser_open_many 之後直接 browser_read:頁面還在載 → 自己短等,讀得到正文
//      e. 一頁都還沒好 → 照舊等、照舊回 still_waiting
// 跑法:node tests/check_shell_browser_early_ready.js(② 要 BLAVE_TEST_WINDOW=1)
const path = require("path"), fs = require("fs"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
let red = 0, last = null; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok ? "" : "  " + JSON.stringify(d === undefined ? last : d).slice(0, 700))); if (!ok) red++; };
const idx = fs.readFileSync(path.join(SHELL, "browser", "index.js"), "utf8"), IP = require(path.join(SHELL, "browser", "inpage.js"));

if (!process.versions.electron) {
  const cut = (src, head) => { const i = src.indexOf(head); if (i < 0) throw new Error("找不到 " + head); let d = 0; for (let k = src.indexOf("{", src.indexOf(")", i)); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("切不出 " + head); };
  const K = /const READY_TEXT_MIN = (\d+), EARLY_EVERY_MS = (\d+), WAIT_STRAGGLER_MS = (\d+), READ_WAIT_MS = (\d+);/.exec(idx) || [];
  t("門檻是常數:正文至少 400 字、每 0.7 秒量一次、等其他頁最多 3 秒、browser_read 自己最多等 5 秒", K.slice(1).map(Number).join() === "400,700,3000,5000", K.slice(1));
  const early = cut(idx, "function early(");
  t("保守:字數夠、而且連續兩次量到的一樣(內容不再長)才算好;量一次最多 1.5 秒", /if \(n >= READY_TEXT_MIN && n === last\) \{/.test(early) && /within\(v\.page\.run\(IP\.readable\), 1500\)/.test(early));
  t("只量 agent 自己開的一般頁:搜尋分頁(可能是驗證頁)、用戶的頁、接手中的頁、agent 不能去的網址都不量", /if \(t\.by !== "agent" \|\| t\.searchTab\) return;/.test(early) && /if \(!t\.userControl && !t\.verify && !policy\.agent\(pageUrl\(t, v\)\)\) \{/.test(early));
  t("換頁之後舊的那一輪量測自己停(比對導覽計數)", /const same = \(\) => views\.get\(t\.id\) === v && v\.navs === nav && t\.status === "loading";/.test(early));
  // readable() 的判準:假 document
  const run = (doc) => new Function("document", IP.readable.toString() + "; return readable();")(doc);
  const el = (n) => ({ innerText: "x".repeat(n) });
  const doc = (state, ps) => ({ readyState: state, body: {}, querySelectorAll: () => ps });
  t("readable():主文件還在解析 → 0;短字(導覽、按鈕)不算;40 字以上的段落才算", run(doc("loading", [el(500)])) === 0 && run(doc("interactive", Array.from({ length: 30 }, () => el(20)))) === 0 && run(doc("interactive", [el(300), el(39), el(150)])) === 450 && run({ readyState: "complete", body: null, querySelectorAll: () => [] }) === 0);
  t("browser_read 遇到還在載的頁自己短等", /if \(t\.status === "loading"\) await waitLoaded\(t, READ_WAIT_MS\);/.test(cut(idx, "async function doRead(")));
  const md = fs.readFileSync(path.join(__dirname, "..", "references", "browser.md"), "utf8"), desc = require(path.join(SHELL, "browser", "tools.js")).TOOLS.find((x) => x.name === "browser_wait").description;
  t("規則與工具說明跟著改:讀得到就算好、先讀好的、browser_read 自己會等;不再叫它 still_waiting 就再等", /\*\*A page is ready as soon as its text is there\*\*/.test(md) && /`still_loading`/.test(md) && /wait once more at most/.test(md)
    && /ready as soon as its text is there/.test(desc) && /still_loading/.test(desc) && !/If it returns still_waiting, call it again/.test(desc));
  const bin = GATE.bin(SHELL, "②");
  if (!bin) { console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  const code = (r.status == null ? 1 : r.status) || (red ? 1 : 0);
  console.log(code ? "\nFAILED" : "\nALL PASS"); process.exit(code);
} else {
  const electron = require("electron");
  const { app, BrowserWindow, session } = electron;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-early-"));
  app.setPath("userData", tmp);
  const J = (r) => (last = JSON.parse(r.content[0].text));
  const BODY = "<h1>CPI day</h1>" + Array.from({ length: 8 }, (_, i) => "<p>Paragraph " + i + " of the article body, long enough to count as real text for the reader, with figures 3." + i + "%.</p>").join("");
  const hung = [];
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1200, height: 800, show: false });
    await win.loadURL("data:text/html,<p>host</p>");
    const srv = require("http").createServer((req, res) => {
      const u = new URL(req.url, "http://" + req.headers.host);
      const html = (b) => { res.writeHead(200, { "content-type": "text/html" }); res.end(b); };
      if (/^\/hang\./.test(u.pathname)) { hung.push(res); return; }                       // 永遠不回應的子資源(廣告、追蹤)
      if (u.pathname === "/never") { hung.push(res); return; }                             // 主文件本身永遠不回應
      if (u.pathname === "/adheavy") return html("<!doctype html><title>Ad heavy</title><nav>Home | Markets | Crypto</nav><article>" + BODY + '</article><img src="/hang.png"><script async src="/hang.js"></script>');
      if (u.pathname === "/navonly") return html('<!doctype html><title>Shell only</title><nav><a>Home</a><a>Markets</a><a>Crypto</a></nav><div id="app"></div><img src="/hang.png">');
      if (u.pathname === "/fast") return html("<!doctype html><title>Fast</title><article>" + BODY + "</article>");
      return html("<title>x</title><p>x</p>");
    });
    srv.on("connect", (_req, sock) => sock.destroy());
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const ses = session.fromPartition("persist:agent-browser");
    await ses.setProxy({ proxyRules: "http=127.0.0.1:" + srv.address().port + ";https=127.0.0.1:" + srv.address().port, proxyBypassRules: "<-loopback>" });
    const sent = []; const realSend = win.webContents.send.bind(win.webContents);
    win.webContents.send = (ch, ev) => { if (ch === "browser-event") sent.push(ev); return realSend(ch, ev); };
    const B = require(path.join(SHELL, "browser")).createBrowser({ electron, stateDir: path.join(tmp, "snaps"), reportsDir: path.join(tmp, "reports"), getWin: () => win, uiLang: () => "en", track: () => {}, version: "test", reducedMotion: () => true, userPresent: () => true });
    await B.beginTurn(win, "desktop-earlytest1");
    const call = (n, a) => B._call(n, a || {}, { live: () => true });
    const timed = async (n, a) => { const t0 = Date.now(); const r = J(await call(n, a)); return { r, ms: Date.now() - t0 }; };

    // a
    let o = J(await call("browser_open", { url: "http://a1.test/adheavy" }));
    let w = await timed("browser_wait", { tab: o.tab });
    t("a 正文先到、子資源永遠不回應:browser_wait " + w.ms + " ms 就回 ready(partial),不是等滿 20 秒", w.r.ok === true && w.r.tabs[0].status === "ready" && w.r.tabs[0].partial === true && w.r.tabs[0].title === "Ad heavy" && w.ms < 6000, w);
    t("a 畫面收到 page_loaded(partial)", sent.some((e) => e.type === "page_loaded" && e.partial === true && e.title === "Ad heavy"));
    let rd = J(await call("browser_read", { tab: o.tab }));
    t("a 讀得到正文", rd.ok === true && /Paragraph 7 of the article body/.test(rd.untrusted_content), rd);
    // b
    o = J(await call("browser_open", { url: "http://b1.test/navonly" }));
    w = await timed("browser_wait", { tab: o.tab, timeout_s: 4 });
    t("b 只有導覽列、正文還沒來:不提早算好(4 秒內仍是 still_waiting / loading)", w.r.ok === false && w.r.error === "still_waiting" && w.r.tabs[0].status === "loading" && w.ms >= 3500, w);
    // c
    o = J(await call("browser_open_many", { urls: ["http://c1.test/fast", "http://c2.test/adheavy", "http://c3.test/never"] }));
    const ids = o.tabs.map((x) => x.tab);
    w = await timed("browser_wait", { tabs: ids });
    const st = Object.fromEntries(w.r.tabs.map((x) => [x.tab, x.status]));
    t("c 一次等三頁(一頁永遠不回應):" + w.ms + " ms 就回來,好的標 ready、沒好的標 loading 並列在 still_loading,附一句先讀好的", w.r.ok === true && w.ms < 8000 && st[ids[0]] === "ready" && st[ids[1]] === "ready" && st[ids[2]] === "loading"
      && JSON.stringify(w.r.still_loading) === JSON.stringify([ids[2]]) && /read the tabs that are ready now/.test(w.r.note), w);
    // d
    o = J(await call("browser_open_many", { urls: ["http://d1.test/adheavy"] }));
    const d = await timed("browser_read", { tab: o.tabs[0].tab, part: "section", section: "CPI day" });
    t("d 開了直接讀(沒有呼叫 browser_wait):browser_read 自己短等," + d.ms + " ms 讀到正文", d.r.ok === true && /Paragraph 0 of the article body/.test(JSON.stringify(d.r.untrusted_content)) && d.ms < 7000, d);
    // e
    o = J(await call("browser_open", { url: "http://e1.test/never" }));
    w = await timed("browser_wait", { tab: o.tab, timeout_s: 3 });
    t("e 一頁都還沒好:照舊等到期限、回 still_waiting", w.r.ok === false && w.r.error === "still_waiting" && w.ms >= 2500, w);
    B.endTurn();
    hung.forEach((r) => { try { r.destroy(); } catch (_) { /* 已斷 */ } });
    srv.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* userData 還鎖著 */ }
    console.log(red ? `\n${red} FAILED` : "\nALL PASS(②)");
    app.exit(red ? 1 : 0);
  }).catch((e) => { console.log("FAIL  " + (e && e.stack) + "\n      last: " + JSON.stringify(last).slice(0, 500)); app.exit(1); });
}
