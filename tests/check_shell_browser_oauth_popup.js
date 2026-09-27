// OAuth 登入子視窗(Wei 實測:TradingView 的 Google 登入沒反應——popup 全 deny 把 OAuth 擋死):
// allow 路線(稽核 B-P1-2):window.open 回真的 proxy(opener 拿到非 null,GSI 不會判 popup 被擋)、
// 子視窗有 window.opener(postMessage 型流程走得通);did-create-window 接管成受控視窗
// (同 partition、視窗標題=唯讀網址列、agent 工具進不去)。只認用戶手勢(B-P3);白名單外照舊。
// IdP 帳戶面(mail.google.com 等)agent 導覽由 policy.agent() 擋(B-P1-1),OAuth 子視窗與用戶不受影響。
// 跑法:node tests/check_shell_browser_oauth_popup.js(找不到 Electron 只跑靜態+stub 段)
const path = require("path"), fs = require("fs"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.versions.electron) {
  const src = fs.readFileSync(path.join(SHELL, "browser", "oauth.js"), "utf8");
  const idx = fs.readFileSync(path.join(SHELL, "browser", "index.js"), "utf8");
  const pol = require(path.join(SHELL, "browser", "policy"));
  ok("白名單四家(google / apple / microsoft;facebook 只認登入/授權路徑)",
    /accounts\.google\.com/.test(src) && /appleid\.apple\.com/.test(src) && /login\.microsoftonline\.com/.test(src)
    && /host: "facebook\.com", path: \/\^\\\/\(login\|/.test(src));
  ok("index.js:只認用戶手勢(B-P3)、allow 選項、did-create-window 接管;不是剛放行的那個視窗直接關",
    /if \(by === "user" && oauth\.isIdp\(url\)\) \{/.test(idx)
    && /pendingOauth = \{ url: String\(url\), opener: wc\.getURL\(\) \|\| t\.url \};? return opts;/.test(idx)
    && /did-create-window/.test(idx) && /oauth\.adopt\(childWin, po\.url, po\.opener\)/.test(idx) && /childWin\.destroy\(\)/.test(idx));
  ok("allow 選項:opener 連結活著(action allow)、opener 關了跟著收(outlivesOpener:false)、不開額外能力",
    /action: "allow",\n      outlivesOpener: false,/.test(src) && !/nodeIntegration: true/.test(src));
  ok("標題=唯讀網址列:page-title-updated preventDefault,頁面蓋不掉", /page-title-updated", \(e\) => \{ e\.preventDefault\(\); title\(\); \}/.test(src));
  ok("oauth.js 不碰 tabs / views / CDP(agent 工具沒有路進來)", !/tabs\.|views\.|createPage|debugger/.test(src));
  ok("子視窗裡的 popup 一律 deny、webview 擋掉", /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/.test(src) && /will-attach-webview/.test(src));
  ok("close() 先關 wc 再關窗(B-P2-4:頁面 JS 不留活口)", /const w = win, c = wc;[\s\S]{0,200}c\.close\(\);[\s\S]{0,120}w\.close\(\);/.test(src));
  ok("rebinding 回應層後盾蓋到子視窗(B-P2-2:owns / abortPrivate 接進 onResponseStarted)",
    /function owns\(webContentsId\)/.test(src) && /oauth\.owns\(d\.webContentsId\)\) oauth\.abortPrivate\(\);/.test(idx));
  ok("清瀏覽資料連登入視窗一起收", /oauth\.close\(\);[\s\S]{0,120}clearStorageData/.test(idx));
  // B-P1-1:IdP 帳戶面 agent 擋單(policy 行為)
  ok("agent 導 IdP 帳戶面被擋(mail / myaccount / drive / contacts / fb settings)",
    ["https://mail.google.com/mail", "https://myaccount.google.com/", "https://drive.google.com/d", "https://contacts.google.com/", "https://www.facebook.com/settings/x"]
      .every((u) => pol.agent(u) && pol.agent(u).reason === "sensitive_domain"));
  ok("一般 google / facebook 頁 agent 照常放行", !pol.agent("https://www.google.com/search?q=x") && !pol.agent("https://www.facebook.com/somepage"));

  // ---- stub 段:isIdp 假冒 + maybeFinish 三邊界(抽真模組,假 electron)
  const { createOauth } = require(path.join(SHELL, "browser", "oauth"));
  const reg = (h) => String(h).split(".").slice(-2).join(".");
  const O = createOauth({ electron: {}, session: () => null, getWin: () => null, registrable: reg });
  ok("isIdp:真網址與子網域過;http / 後綴假冒 / **前綴假冒(notfacebook.com/login)** / fb 一般頁不過",
    O.isIdp("https://accounts.google.com/o/oauth2/v2/auth") && O.isIdp("https://www.facebook.com/v19.0/dialog/oauth")
    && !O.isIdp("http://accounts.google.com/x") && !O.isIdp("https://accounts.google.com.evil.test/x")
    && !O.isIdp("https://www.notfacebook.com/login") && !O.isIdp("https://evilaccounts.google.com/x") && !O.isIdp("https://www.facebook.com/somepage"));
  // 假 childWin / wc(EventEmitter):驗 maybeFinish 的時序與邊界
  const EE = require("events");
  const mkChild = () => {
    const wc = new EE(); wc.url = ""; wc.getURL = () => wc.url; wc.isDestroyed = () => false; wc.setWindowOpenHandler = () => {}; wc.close = () => { wc.closed = true; };
    const w = new EE(); w.isDestroyed = () => false; w.setMenuBarVisibility = () => {}; w.setTitle = (t2) => { w.title = t2; }; w.webContents = wc; w.close = () => { w.closedWin = true; w.emit("closed"); };
    return { w, wc };
  };
  (async () => {
    // 邊界 1+did-finish-load 閘(稽核突變洞):did-navigate 到 opener 網域「不」起倒數,did-finish-load 才起
    let { w, wc } = mkChild();
    O._test.IDP.push({ host: "idp.test" });
    O.adopt(w, "https://idp.test/login", "https://site.test/a");
    wc.url = "https://site.test/callback"; wc.emit("did-navigate", null, wc.url);
    await sleep(2700);
    ok("只有 did-navigate(還沒 load 完):不起倒數、不關窗(callback script 要先跑)", !w.closedWin && !wc.closed);
    wc.emit("did-finish-load");
    await sleep(2700);
    ok("did-finish-load 後寬限 2.5s:代關", wc.closed === true, { closed: wc.closed });
    // 邊界 1:opener 本身是 IdP 頁(facebook 頁上開 facebook 登入)→ 永不啟動倒數
    ({ w, wc } = mkChild());
    O.adopt(w, "https://www.facebook.com/dialog/oauth", "https://www.facebook.com/login.php");
    wc.url = "https://www.facebook.com/login.php"; wc.emit("did-navigate", null, wc.url); wc.emit("did-finish-load");
    await sleep(2700);
    ok("opener=IdP 同網域:不代關(密碼打到一半不會被殺)", !wc.closed);
    O.close();
    // 邊界 2:起了倒數又導離 opener 網域(帳號選擇/再同意)→ 取消
    ({ w, wc } = mkChild());
    O.adopt(w, "https://idp.test/login", "https://site.test/a");
    wc.url = "https://site.test/cb"; wc.emit("did-navigate", null, wc.url); wc.emit("did-finish-load");
    await sleep(800);
    wc.url = "https://idp.test/consent"; wc.emit("did-navigate", null, wc.url);
    await sleep(2400);
    ok("倒數中再導回 IdP:取消代關", !wc.closed);
    O.close();
    const bin = path.join(SHELL, "node_modules", ".bin", "electron");
    if (!fs.existsSync(bin)) { console.log("SKIP  真 Electron 那段"); process.exit(red ? 1 : 0); }
    const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
    process.exit(red || r.status ? 1 : 0);
  })();
  return;
}

const electron = require("electron");
const { app, BrowserWindow, session } = electron;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-oauth-"));
app.setPath("userData", tmp);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 800, show: false });
  await win.loadURL("data:text/html,<p>host</p>");
  const srv = require("http").createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>s</title><article><p>" + "Words here. ".repeat(40) + "</p></article>");
  });
  srv.on("connect", (_req, sock) => sock.destroy());
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  // 本機 HTTPS IdP(自簽憑證,只在測試 partition 放行):子視窗要真的載得進頁,
  // opener proxy / window.opener / postMessage 的斷言才是真的
  const cert = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blave-idpcert-"));
    require("child_process").execSync("openssl req -x509 -newkey rsa:2048 -keyout k.pem -out c.pem -days 2 -nodes -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1", { cwd: dir, stdio: "ignore" });
    return { key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) };
  })();
  const idpSrv = require("https").createServer(cert, (req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>IdP</title><p>login page</p><script>window.__hasOpener = window.opener !== null; var n = 0; var t = setInterval(function(){ n++; if (window.opener) window.opener.postMessage('IDP-HELLO', '*'); if (n > 12) clearInterval(t); }, 250);</script>");
  });
  await new Promise((r) => idpSrv.listen(0, "127.0.0.1", r));
  const IDP_URL = "https://127.0.0.1:" + idpSrv.address().port;
  const ses = session.fromPartition("persist:agent-browser");
  ses.setCertificateVerifyProc((_req2, cb) => cb(0));   // 只在測試裡:放行自簽
  await ses.setProxy({ proxyRules: "http=127.0.0.1:" + srv.address().port, proxyBypassRules: "<-loopback>" });
  const B = require(path.join(SHELL, "browser")).createBrowser({ electron, stateDir: path.join(tmp, "snaps"), getWin: () => win, uiLang: () => "en", track: () => {}, version: "test" });
  await B.beginTurn(win, "desktop-oauth");
  const ctx = { live: () => true };
  const call = async (n, a) => JSON.parse((await B._call(n, a || {}, ctx)).content[0].text);

  const r1 = await call("browser_open", { url: "http://site.test/a" });
  await call("browser_wait", { tab: r1.tab });
  const tid = B._tabs.byAlias(r1.tab).id;
  const wins0 = BrowserWindow.getAllWindows().length;
  const kid = () => win.contentView.children.find((c) => c.webContents && c.webContents.getURL().includes("site.test"));

  // 沒手勢:IdP popup 也不開(S7 照舊)
  await kid().webContents.executeJavaScript("window.__p0 = window.open('https://accounts.google.com/o/oauth2/v2/auth'); 0", true);
  await sleep(700);
  ok("沒手勢:不開窗、window.open 回 null", BrowserWindow.getAllWindows().length === wins0 && !B._oauth._test.win
    && (await kid().webContents.executeJavaScript("window.__p0 === null")));

  B.takeover(tid);   // 用戶接手=有手勢
  B._oauth._test.IDP.push({ host: "127.0.0.1" });   // 本機 HTTPS IdP 進白名單(同一個陣列,index 的 isIdp 分支吃得到)
  await kid().webContents.executeJavaScript("window.__msgs = []; window.addEventListener('message', (e) => window.__msgs.push(String(e.data))); window.__p = window.open(" + JSON.stringify(IDP_URL + "/login?client_id=t") + "); 0", true);
  await sleep(2200);
  const w1 = B._oauth._test.win;
  ok("用戶手勢+IdP:開受控視窗,而且 opener 拿到非 null(GSI 不會判 popup 被擋)",
    BrowserWindow.getAllWindows().length === wins0 + 1 && !!w1
    && (await kid().webContents.executeJavaScript("window.__p !== null")));
  // opener 連結:GSI 型流程靠 opener 端的 popup proxy(輪詢 closed / postMessage)。https 在測試
  // 代理裡載不進真頁,子視窗端的 window.opener 在真機 e2e 驗;這裡驗 opener 端 proxy 是活的
  {
    const probe = await kid().webContents.executeJavaScript("JSON.stringify({ p: typeof window.__p, closed: window.__p && window.__p.closed, msgs: window.__msgs })");
    const pr = JSON.parse(probe);
    ok("opener 端 popup proxy 活著(closed === false;GSI 輪詢用的就是它)", pr.closed === false, probe);
    // postMessage 往返(GSI 交 code 的通道):child → opener、opener → child 都要通
    await B._oauth._test.wc.executeJavaScript("window.__got = []; window.addEventListener('message', (e) => window.__got.push(String(e.data))); window.opener.postMessage('C2O','*'); 0", true).catch(() => {});
    await kid().webContents.executeJavaScript("window.__p.postMessage('O2C','*'); 0", true).catch(() => {});
    await sleep(700);
    ok("postMessage:子視窗 → opener 送達", (await kid().webContents.executeJavaScript("window.__msgs.includes('C2O')")) === true);
    ok("postMessage:opener → 子視窗 送達", (await B._oauth._test.wc.executeJavaScript("window.__got.includes('O2C')").catch(() => false)) === true);
  }
  {
    const cw = B._oauth._test.wc;
    const st = await cw.executeJavaScript("JSON.stringify({ url: location.href, hasOpener: window.opener !== null, flag: window.__hasOpener })").catch((e) => "ERR:" + String(e).slice(0, 80));
    ok("子視窗有 window.opener", typeof st === "string" && st !== null && /"hasOpener":true/.test(st), st);
  }
  ok("同 partition(cookie 才落得回主頁)", B._oauth._test.wc.session === ses);
  ok("不進 tabs(agent 工具沒有 ref 打得進去)", (await call("browser_tabs")).tabs.length === 1);
  ok("視窗標題=唯讀網址列(🔒 host)", /127\.0\.0\.1/.test(w1.getTitle()), w1.getTitle());
  await B._oauth._test.wc.executeJavaScript("document.title = 'Totally Legit Bank'; 0", true).catch(() => {});
  await sleep(300);
  ok("頁面蓋不掉標題(page-title-updated preventDefault)", !/Legit Bank/.test(w1.getTitle()), w1.getTitle());
  // 一次一個:再開回 null(聚焦既有的)
  await kid().webContents.executeJavaScript("window.__p2 = window.open(" + JSON.stringify(IDP_URL + "/again") + "); 0", true);
  await sleep(700);
  ok("已有登入視窗:不疊第二個", BrowserWindow.getAllWindows().length === wins0 + 1);
  B._oauth.close();
  await sleep(500);
  ok("close():視窗收掉", BrowserWindow.getAllWindows().length === wins0 && !B._oauth._test.win);
  ok("close() 之後 opener 端 proxy.closed === true(GSI 收得到「用戶關掉」)", await kid().webContents.executeJavaScript("window.__p.closed === true"));

  // 白名單外的 popup:照舊走分頁(user 分頁),不開窗
  await kid().webContents.executeJavaScript("window.open('http://other.test/p'); 0", true);
  await sleep(900);
  ok("白名單外:沒有新視窗、照原路開分頁", BrowserWindow.getAllWindows().length === wins0 && !B._oauth._test.win);

  // agent 手勢(3 秒窗)不開 IdP 視窗(B-P3)
  B.handback(tid);
  const t = B._tabs.get(tid); t.userControl = false;
  const v = win.contentView.children.find((c) => c.webContents && c.webContents.getURL().includes("site.test"));
  // 模擬 agent 窗口:直接標 agentActive 做不到(內部 Map),改走「沒接手+沒 agent 窗」=deny 已驗;
  // agent 分支的擋單由靜態斷言釘(by === "user" 才進 oauth)
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
