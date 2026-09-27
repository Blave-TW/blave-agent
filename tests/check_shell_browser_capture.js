// browser_capture(報告引用圖,0.1.8)端到端:真 Electron、真 WebContentsView、真 CDP。頁面經測試行程自己的本機代理供應,
// https 走 CONNECT 轉進本機 TLS 伺服器(openssl 當場產的自簽憑證,只在這支測試的 partition 上信任;production 沒有測試開關)。
// 釘住:只拍指定元素(像素驗邊框/內部)、約 2×、存進 reports/<id>.files/、回 {file, source:{name,url}};
// 有值的密碼欄被蓋掉、頁面標記被藏起來;過大 / 過小元素、http 頁、壞報告 id、過期 ref、政策擋的網址都拒;出處頁進來源卡。
// 另跑 policy.citable / gate.captureFit 的列舉。
// 跑法:node tests/check_shell_browser_capture.js(找不到 shell/node_modules 的 Electron 或 openssl 就 SKIP)
const path = require("path"), fs = require("fs"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
if (!process.versions.electron) {
  const bin = GATE.bin(SHELL);
  if (!bin) { process.exit(0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  process.exit(r.status == null ? 1 : r.status);
}
const electron = require("electron");
const { app, BrowserWindow, session } = electron;
const policy = require(path.join(SHELL, "browser", "policy"));
const gate = require(path.join(SHELL, "browser", "gate"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-browser-capture-"));
app.setPath("userData", tmp);
let red = 0, last = null; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) { red++; console.log("      got: " + JSON.stringify(last).slice(0, 500)); } };
const J = (r) => (last = JSON.parse(r.content[0].text));

// ── 純函式列舉 ──
const cit = [
  ["https://glassnode.com/charts/x?a=1", null], ["http://glassnode.com/", "scheme"], ["ftp://a.b/", "scheme"], ["not a url", "format"],
  ["https://u:p@a.com/", "credentials"], ["https://a.com/" + "x".repeat(490), "long"], ["https://a.com/a\tb", "format"], ["https://a.com/" + "x".repeat(480), null],
];
for (const [u, want] of cit) { last = policy.citable(u); t("citable " + u.slice(0, 40) + " → " + want, last === want); }
const V = { w: 1280, h: 800 };
const fitRows = [
  [{ x: 100, y: 100, w: 600, h: 300 }, null, "一般圖表"], [{ x: 0, y: 50, w: 1280, h: 560 }, null, "滿版寬但不到整個畫面高"],
  [{ x: 10, y: 10, w: 60, h: 300 }, "too_small", "太窄"], [{ x: 10, y: 10, w: 300, h: 40 }, "too_small", "太矮"],
  [{ x: 0, y: 0, w: 1280, h: 2000 }, "too_large", "比可視區高"], [{ x: 0, y: 0, w: 1400, h: 300 }, "too_large", "比可視區寬"],
  [{ x: 20, y: 20, w: 1160, h: 690 }, "too_large", "接近整個畫面(90%×85%)"], [{ x: 20, y: 20, w: 1160, h: 670 }, "too_large", "高度差一點,面積仍 ≥75%"], [{ x: 20, y: 20, w: 1160, h: 640 }, null, "面積不到 75%"],
  [{ x: -200, y: 10, w: 400, h: 300 }, "not_visible", "一半在可視區外"],
];
for (const [box, want, n] of fitRows) { last = gate.captureFit(box, V); t("captureFit " + n + " → " + want, last === want); }

// ── 憑證 ──
const ossl = require("child_process").spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(tmp, "k.pem"), "-out", path.join(tmp, "c.pem"), "-days", "2", "-subj", "/CN=cap.test"], { stdio: "ignore" });
if (ossl.status !== 0) { console.log("SKIP  沒有 openssl:端到端那段不跑"); console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0); }

const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const CHART = `<!doctype html><html><head><title>Funding weekly</title><meta property="og:site_name" content="Chart Weekly"></head>
<body style="margin:0;font:16px sans-serif;background:#fff"><h1>Funding this week</h1><p>${"Body text. ".repeat(20)}</p>
<figure style="margin:20px"><div id="chart" role="img" aria-label="BTC funding chart" style="box-sizing:border-box;width:612px;height:312px;background:#00c853;border:6px solid #ff0000;position:relative">
<input type="password" aria-label="Chart password" value="hunter2" style="position:absolute;left:250px;top:130px;width:100px;height:40px;border:0;background:#ffff00;color:#000;font-size:30px"></div></figure>
<div style="height:900px"></div><canvas id="cv" width="300" height="150" aria-label="Canvas chart" style="display:block"></canvas>
<script>const g=document.getElementById("cv").getContext("2d");g.fillStyle="#ff00ff";g.fillRect(0,0,300,150);g.fillStyle="#222222";g.fillRect(20,20,60,30);</script>
<svg id="sv" width="300" height="150"><rect width="300" height="150" fill="#00f"/></svg>
<img alt="tiny icon" width="20" height="20" src="${PNG_1PX}">
<div id="big" role="img" aria-label="Whole page banner" style="width:100%;height:2000px;background:#ddd"></div></body></html>`;

app.whenReady().then(async () => {
  // 視窗不顯示(不打擾用戶);分頁停在視窗外,擷取靠 awake() 叫醒合成器——這正是要驗的:視窗外的分頁閒置後照樣拍得準
  const win = new BrowserWindow({ width: 1200, height: 800, show: false });
  await win.loadURL("data:text/html,<p>host</p>");
  const handler = (req, res) => {
    const u = new URL(req.url, (req.socket.encrypted ? "https://" : "http://") + req.headers.host);
    const html = (b) => { res.writeHead(200, { "content-type": "text/html" }); res.end(b); };
    if (u.pathname === "/chart") return html(CHART);
    if (u.host === "www.binance.com" && u.pathname === "/en/markets/spa") return html('<title>markets</title><div role="img" aria-label="Price chart" style="width:400px;height:200px;background:#0af"></div>');
    return html("<title>page</title><p>x</p>");
  };
  const tls = require("https").createServer({ key: fs.readFileSync(path.join(tmp, "k.pem")), cert: fs.readFileSync(path.join(tmp, "c.pem")) }, handler);
  await new Promise((r) => tls.listen(0, "127.0.0.1", r));
  const srv = require("http").createServer(handler);
  srv.on("connect", (req, sock, head) => {
    if (req.url !== "cap.test:443") { sock.destroy(); return; }
    const up = require("net").connect(tls.address().port, "127.0.0.1", () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const ses = session.fromPartition("persist:agent-browser");
  await ses.setProxy({ proxyRules: "http=127.0.0.1:" + srv.address().port + ";https=127.0.0.1:" + srv.address().port, proxyBypassRules: "<-loopback>" });
  ses.setCertificateVerifyProc((rq, cb) => cb(rq.hostname === "cap.test" ? 0 : -2));
  const reportsDir = path.join(tmp, "reports"), sent = [];
  const realSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (ch, ev) => { if (ch === "browser-event") sent.push(ev); return realSend(ch, ev); };
  const B = require(path.join(SHELL, "browser")).createBrowser({ electron, stateDir: path.join(tmp, "snaps"), reportsDir, getWin: () => win, uiLang: () => "en", track: () => {}, version: "test", reducedMotion: () => false });
  await B.beginTurn(win, "desktop-capture1");
  const ctx = { live: () => true };
  const call = (n, a) => B._call(n, a || {}, ctx);

  let r = J(await call("browser_open", { url: "https://cap.test/chart" }));
  const tab = r.tab; await call("browser_wait", { tab });
  r = J(await call("browser_snapshot", { tab }));
  const snap = r.untrusted_content;
  // 視窗外的分頁閒置 10 秒(合成器停了)之後再拍:沒有 awake() 會逾時或拿到舊畫面
  await new Promise((q) => setTimeout(q, 10000));
  if (process.env.E2E_TRACE) {
    console.log(snap);
    const w0 = electron.webContents.getAllWebContents().find((w) => w.getURL().includes("cap.test/chart"));
    const ax = await w0.debugger.sendCommand("Accessibility.getFullAXTree");
    for (const n of ax.nodes) console.log("AX", n.ignored ? "ignored" : "", n.role && n.role.value, JSON.stringify(n.name && n.name.value), n.backendDOMNodeId);
  }
  const ref = (re) => { const x = snap.split("\n").find((l) => re.test(l)); const mm = x && x.match(/\[(@e\d+)\]/); return mm ? mm[1] : null; };
  t("snapshot 看得到圖表元素與 figure(可以拿 ref 擷取)", !!ref(/"BTC funding chart"/) && /- figure \[@e\d+\]/.test(snap));
  t("snapshot 看得到沒有 role 的 canvas(圖表庫常見)", !!ref(/- Canvas "Canvas chart"/));

  // 頁面標記層蓋在圖表上(主 world 塞一個同 id 的層):擷取時要被藏起來
  const wc = electron.webContents.getAllWebContents().find((w) => w.getURL().includes("cap.test/chart"));
  await wc.executeJavaScript(`(()=>{const c=document.getElementById("chart").getBoundingClientRect();const h=document.createElement("div");h.id="__blave_agent_marks";h.style.cssText="position:absolute;left:"+(c.left+scrollX+20)+"px;top:"+(c.top+scrollY+20)+"px;width:80px;height:80px;background:#0000ff;z-index:99999";document.body.appendChild(h);return 1})()`);

  r = J(await call("browser_capture", { tab, ref: ref(/"BTC funding chart"/), report: "wk-cite" }));
  t("擷取成功:回 file + source{name,url} + host", r.ok && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(r.file) && /\.png$/.test(r.file) && r.source && Object.keys(r.source).sort().join() === "name,url" && r.source.name === "Chart Weekly" && r.source.url === "https://cap.test/chart" && r.host === "cap.test");
  const f = r.ok ? path.join(reportsDir, "wk-cite.files", r.file) : null;
  t("圖存在 reports/<id>.files/、≤2MB", f && fs.existsSync(f) && fs.statSync(f).size > 0 && fs.statSync(f).size <= 2 * 1024 * 1024);
  if (f && fs.existsSync(f)) {
    const img = electron.nativeImage.createFromPath(f), s = img.getSize(), bm = img.toBitmap();
    const k = s.width / 612;   // 圖表外框 612 CSS px
    const px = (x, y) => { const i = (Math.round(y * k) * s.width + Math.round(x * k)) * 4; return [bm[i + 2], bm[i + 1], bm[i]]; };   // BGRA → RGB
    const near = (c, rgb) => c.every((v, i) => Math.abs(v - rgb[i]) < 40);
    last = { size: s, corner: px(2, 2), inside: px(560, 280), pw: px(300, 150), mark: px(60, 60) };
    t("約 2×(612 CSS px → ~1224 px 寬),比例對", Math.abs(s.width - 1224) <= 2 && Math.abs(s.height / s.width - 312 / 612) < 0.01);
    t("只拍那個元素:左上角是它的紅邊框、內部是綠底(沒帶到文章字與白底)", near(px(2, 2), [255, 0, 0]) && near(px(609, 309), [255, 0, 0]) && near(px(560, 280), [0, 200, 83]));
    t("有值的密碼欄被蓋掉(墨色遮罩,不是黃底欄位)", near(px(300, 150), [17, 17, 17]));
    t("頁面標記層被藏起來(那一格是圖表綠底,不是標記藍)", near(px(60, 60), [0, 200, 83]));
  }
  t("擷取完標記層還原顯示、遮罩收掉", await wc.executeJavaScript(`(()=>{const h=document.getElementById("__blave_agent_marks");return !document.getElementById("__blave_mask")&&(!h||h.style.visibility!=="hidden")})()`));
  const vb = B._viewBounds(B._tabs.byAlias(tab).id);
  last = vb;
  t("擷取完分頁放回視窗外(awake 只借視窗右下角一個像素一下)", vb && vb.x >= 20000);
  t("出處頁進這一輪的來源(存快照、page_done read)", sent.some((e) => e.type === "page_done" && e.read && e.snapshot_id));

  r = J(await call("browser_capture", { tab, ref: ref(/- Canvas "Canvas chart"/), report: "wk-cite" }));
  const cvf = r.ok ? path.join(reportsDir, "wk-cite.files", r.file) : null;
  const cvPx = (() => { if (!cvf || !fs.existsSync(cvf)) return null; const im = electron.nativeImage.createFromPath(cvf), sz = im.getSize(), bm = im.toBitmap(), i = (Math.floor(sz.height / 2) * sz.width + Math.floor(sz.width / 2)) * 4; return [bm[i + 2], bm[i + 1], bm[i]]; })();
  last = { r, cvPx };

  // 畫布上有一塊深色方塊:整張同一個顏色的圖會被當成「還沒畫」而拒拍(gate.captureBlank,check_shell_capture_lazy_image.js)
  t("捲下去才看得到的 canvas 也拍得準(clip 帶捲動量:中心是它畫的洋紅)", r.ok && r.width === 600 && cvPx && cvPx[0] > 215 && cvPx[1] < 40 && cvPx[2] > 215);
  // 展開在中欄的分頁(用戶正看著):不走 awake(本來就在視窗裡),目標框畫在元素外圈、擷取落地收掉,圖裡不會帶到
  // (強制藏標記那一條由下面的原始碼斷言釘住:展開頁上的假標記層會被擷取框的 mark() 重建掉,像素驗不到)
  const tobj = B._tabs.byAlias(tab);
  B.expand(tobj.id, { x: 0, y: 0, width: 1200, height: 800 });
  await wc.executeJavaScript("window.scrollTo(0,0); 1");
  r = J(await call("browser_capture", { tab, ref: ref(/"BTC funding chart"/), report: "wk-cite" }));
  const exf = r.ok ? path.join(reportsDir, "wk-cite.files", r.file) : null;
  const exPx = (() => { if (!exf || !fs.existsSync(exf)) return null; const im = electron.nativeImage.createFromPath(exf), sz = im.getSize(), bm = im.toBitmap(), k = sz.width / 612, at = (x, y) => { const i = (Math.round(y * k) * sz.width + Math.round(x * k)) * 4; return [bm[i + 2], bm[i + 1], bm[i]]; }; return { corner: at(2, 2), inside: at(560, 280) }; })();
  last = { r, exPx };
  t("展開中的分頁也拍得準(紅框角、綠底,沒帶到目標框)、發 page_act capture", r.ok && exPx && exPx.corner[0] > 215 && exPx.corner[1] < 40 && exPx.inside[1] > 150 && exPx.inside[0] < 40 && sent.some((e) => e.type === "page_act" && e.kind === "capture"));
  B.collapse();
  fs.unlinkSync(exf);

  r = J(await call("browser_capture", { tab, ref: ref(/"Whole page banner"/), report: "wk-cite" }));
  t("過大元素(比可視區高)→ capture_refused too_large", !r.ok && r.error === "capture_refused" && r.reason === "too_large");
  r = J(await call("browser_capture", { tab, ref: ref(/"tiny icon"/), report: "wk-cite" }));
  t("過小元素 → capture_refused too_small", !r.ok && r.error === "capture_refused" && r.reason === "too_small");
  r = J(await call("browser_capture", { tab, ref: ref(/"BTC funding chart"/), report: "../x" }));
  t("報告 id 不合格 → invalid_args、沒有寫出任何檔", !r.ok && r.error === "invalid_args" && !fs.existsSync(path.join(tmp, "x.files")));
  r = J(await call("browser_capture", { tab, ref: "@e999", report: "wk-cite" }));
  t("過期 / 不存在的 ref → stale_ref", !r.ok && r.error === "stale_ref");
  t("拒掉的那幾次沒有多寫檔(資料夾裡只有成功的兩張)", fs.readdirSync(path.join(reportsDir, "wk-cite.files")).length === 2);

  r = J(await call("browser_open", { url: "http://cap2.test/chart" })); const ht = r.tab; await call("browser_wait", { tab: ht });
  r = J(await call("browser_snapshot", { tab: ht }));
  const hr = (r.untrusted_content.match(/"BTC funding chart" \[(@e\d+)\]/) || [])[1];
  r = J(await call("browser_capture", { tab: ht, ref: hr, report: "wk-cite" }));
  t("http 頁 → capture_refused page_url(引用網址契約要 https)", !r.ok && r.error === "capture_refused" && r.reason === "page_url");

  r = J(await call("browser_open", { url: "http://www.binance.com/en/markets/spa" })); const bt = r.tab; await call("browser_wait", { tab: bt });
  r = J(await call("browser_snapshot", { tab: bt }));
  const br = (r.untrusted_content.match(/"Price chart" \[(@e\d+)\]/) || [])[1];
  const bwc = electron.webContents.getAllWebContents().find((w) => w.getURL().includes("binance.com/en/markets"));
  await bwc.executeJavaScript("history.pushState({},'','/en/my/wallet'); 1");
  r = J(await call("browser_capture", { tab: bt, ref: br, report: "wk-cite" }));
  t("當下網址被 agent 政策擋(交易所後台)→ blocked_policy", !r.ok && r.error === "blocked_policy");

  const capSrc = fs.readFileSync(path.join(SHELL, "browser", "capture.js"), "utf8");
  t("擷取在 awake() 裡、經過 withMask 且強制藏標記(展開中的分頁也藏)", /const shoot = \(\) => awake\(t, v, async \(\) => \{\s*const g = await d\.withMask\(v, async \(\) => \{[\s\S]*?captureClip\(s\.c\.box, s\.c\.view, [^\n]*\n\s*\}, true\);/.test(capSrc)
    && (capSrc.match(/got = await shoot\(\);/g) || []).length === 2 && !/captureClip\(/.test(capSrc.replace(/const shoot = [\s\S]*?\n    \}\);\n/, "")));
  const names = require(path.join(SHELL, "browser", "tools")).TOOLS.map((x) => x.name);
  t("工具清單有 browser_capture,必填 tab/ref/report", names.includes("browser_capture") && require(path.join(SHELL, "browser", "tools")).TOOLS.find((x) => x.name === "browser_capture").inputSchema.required.join() === "tab,ref,report");

  B.endTurn();
  srv.close(); tls.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* Windows:userData 還鎖著 */ }
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + (e && e.stack) + "\n      last: " + JSON.stringify(last).slice(0, 500)); app.exit(1); });
