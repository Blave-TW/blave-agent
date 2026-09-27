// 報告引用圖:圖還沒載完不拍(e2e 0.1.8:glassnode 的圖只拍到上半、下半整片深色)。真 Electron、真 CDP、視窗不顯示。
// loading="lazy" 的圖捲進畫面才開始抓,PNG 由上往下解;外框有寫尺寸所以不動,舊流程 0.3 秒就拍了。
// 釘住:① 慢慢來的 lazy 圖 → 等到載完才拍,圖的最下面一列是圖自己的顏色(不是頁面底色);
//      ② 一直載不完的圖 → capture_refused / incomplete,資料夾裡沒有多檔;
//      ③ 畫到一半的 canvas(下半還是頁面底色)、整張同一個顏色 → 重拍一次還是一樣 → incomplete;
//         深色底的圖表、大片平色只有一小塊東西的圖照拍。
// 頁面由這支測試自己的本機代理供應(同 check_shell_browser_capture.js:CONNECT 轉進本機 TLS,自簽憑證只在測試的 partition 上信任)。
// 不碰剪貼簿、不搶焦點。跑法:node tests/check_shell_capture_lazy_image.js(BLAVE_TEST_WINDOW=1 才起 Electron;沒有 openssl 就 SKIP)
const path = require("path"), fs = require("fs"), os = require("os"), zlib = require("zlib");
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-capture-lazy-"));
app.setPath("userData", tmp);
let red = 0, last = null; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) { red++; console.log("      got: " + JSON.stringify(last).slice(0, 500)); } };
const J = (r) => (last = JSON.parse(r.content[0].text));

// 一張淺底、有一條斜線的 PNG(不壓縮:檔案夠大才分得成兩段送;整張同色的圖會被當成還沒畫)
const CRC = (() => { const tb = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tb[n] = c >>> 0; } return (b) => { let c = 0xffffffff; for (const x of b) c = tb[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; })();
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * (w * 3 + 1) + 1 + x * 3, c = Math.abs(x - 2 * y) < 6 ? [95, 86, 149] : rgb; raw[i] = c[0]; raw[i + 1] = c[1]; raw[i + 2] = c[2]; }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 0 })), chunk("IEND", Buffer.alloc(0))]);
}
const PIC = png(600, 300, [232, 232, 232]);
const fig = (src) => `<figure style="margin:20px 40px;width:600px"><img loading="lazy" width="600" height="300" alt="chart" src="${src}" style="display:block"></figure>`;
const PAGE = `<!doctype html><html><head><title>Lazy charts</title></head><body style="margin:0;background:#16171b;color:#eee;font:16px sans-serif">
<h1>Charts</h1><div style="height:3000px"></div><h2>Slow chart</h2>${fig("/slow.png")}<div style="height:1500px"></div><h2>Stuck chart</h2>${fig("/stuck.png")}
<div style="height:1500px"></div><h2>Half drawn</h2><canvas id="half" aria-label="Half drawn chart" width="600" height="300" style="display:block;margin:20px 40px"></canvas>
<div style="height:1500px"></div><h2>Dark chart</h2><canvas id="dark" aria-label="Dark chart" width="600" height="300" style="display:block;margin:20px 40px"></canvas>
<div style="height:1500px"></div><h2>Sparse chart</h2><canvas id="sparse" aria-label="Sparse chart" width="300" height="150" style="display:block"></canvas>
<div style="height:1500px"></div><h2>Empty chart</h2><canvas id="empty" aria-label="Empty chart" width="300" height="150" style="display:block"></canvas>
<script>const h=document.getElementById("half").getContext("2d");h.fillStyle="#e8e8e8";h.fillRect(0,0,600,150);h.strokeStyle="#5f5695";h.lineWidth=3;h.beginPath();h.moveTo(0,120);h.lineTo(300,40);h.lineTo(600,100);h.stroke();
const d=document.getElementById("dark").getContext("2d");d.fillStyle="#101418";d.fillRect(0,0,600,300);d.strokeStyle="#35c5a0";d.lineWidth=3;d.beginPath();d.moveTo(0,120);d.lineTo(300,40);d.lineTo(600,100);d.stroke();
const s=document.getElementById("sparse").getContext("2d");s.fillStyle="#ff00ff";s.fillRect(0,0,300,150);s.fillStyle="#222222";s.fillRect(20,20,60,30);
const e=document.getElementById("empty").getContext("2d");e.fillStyle="#ff00ff";e.fillRect(0,0,300,150);</script></body></html>`;

app.whenReady().then(async () => {
  const ossl = require("child_process").spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(tmp, "k.pem"), "-out", path.join(tmp, "c.pem"), "-days", "2", "-subj", "/CN=lazy.test"], { stdio: "ignore" });
  if (ossl.status !== 0) { console.log("SKIP  沒有 openssl"); app.exit(0); return; }
  const win = new BrowserWindow({ width: 1200, height: 800, show: false });
  await win.loadURL("data:text/html,<p>host</p>");
  const hits = { slow: 0, stuck: 0 }, open = new Set();
  const handler = (req, res) => {
    const u = new URL(req.url, "https://" + req.headers.host);
    if (u.pathname === "/slow.png") {   // 先送一半,1.5 秒後才送另一半:這段時間瀏覽器畫得出上半張
      hits.slow++; res.writeHead(200, { "content-type": "image/png", "content-length": PIC.length });
      const cut = PIC.length >> 1; res.write(PIC.subarray(0, cut)); setTimeout(() => res.end(PIC.subarray(cut)), 1500); return;
    }
    if (u.pathname === "/stuck.png") { hits.stuck++; open.add(res); res.writeHead(200, { "content-type": "image/png", "content-length": PIC.length }); res.write(PIC.subarray(0, PIC.length >> 1)); return; }   // 後半永遠不來
    res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE);
  };
  const tls = require("https").createServer({ key: fs.readFileSync(path.join(tmp, "k.pem")), cert: fs.readFileSync(path.join(tmp, "c.pem")) }, handler);
  await new Promise((r) => tls.listen(0, "127.0.0.1", r));
  const srv = require("http").createServer(handler);
  srv.on("connect", (req, sock, head) => {
    if (req.url !== "lazy.test:443") { sock.destroy(); return; }
    const up = require("net").connect(tls.address().port, "127.0.0.1", () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const ses = session.fromPartition("persist:agent-browser");
  await ses.setProxy({ proxyRules: "http=127.0.0.1:" + srv.address().port + ";https=127.0.0.1:" + srv.address().port, proxyBypassRules: "<-loopback>" });
  ses.setCertificateVerifyProc((rq, cb) => cb(rq.hostname === "lazy.test" ? 0 : -2));
  const reportsDir = path.join(tmp, "reports");
  const B = require(path.join(SHELL, "browser")).createBrowser({ electron, stateDir: path.join(tmp, "snaps"), reportsDir, getWin: () => win, uiLang: () => "en", track: () => {}, version: "test", reducedMotion: () => false });
  await B.beginTurn(win, "desktop-lazy1");
  const call = (n, a) => B._call(n, a || {}, { live: () => true });
  let r = J(await call("browser_open", { url: "https://lazy.test/charts" }));
  const tab = r.tab; await call("browser_wait", { tab });
  r = J(await call("browser_snapshot", { tab, interactive_only: false }));
  const lines = String(r.untrusted_content || "").split("\n");
  const after = (head, re) => { const i = lines.findIndex((l) => l.includes('heading "' + head + '"')); const l = i < 0 ? null : lines.slice(i + 1).find((x) => re.test(x)); const m = l && l.match(/\[(@e\d+)\]/); return m ? m[1] : null; };
  const files = () => { try { return fs.readdirSync(path.join(reportsDir, "lazy.files")); } catch (_) { return []; } };
  const pixels = (file) => { const im = electron.nativeImage.createFromPath(path.join(reportsDir, "lazy.files", file)), s = im.getSize(), bm = im.toBitmap(); return { s, at: (fx, fy) => { const i = (Math.min(s.height - 1, Math.round(fy * s.height)) * s.width + Math.min(s.width - 1, Math.round(fx * s.width))) * 4; return [bm[i + 2], bm[i + 1], bm[i]]; } }; };
  const near = (c, rgb) => c.every((v, i) => Math.abs(v - rgb[i]) < 24);

  last = { slow: after("Slow chart", /- figure \[@e\d+\]/), hits };
  t("還沒捲到:lazy 圖沒有被抓過", hits.slow === 0 && !!last.slow);
  let t0 = Date.now();
  r = J(await call("browser_capture", { tab, ref: after("Slow chart", /- figure \[@e\d+\]/), report: "lazy" }));
  t("慢慢來的 lazy 圖:等到載完才拍(≥ 1.5 秒)", r.ok === true && hits.slow === 1 && Date.now() - t0 >= 1400);
  if (r.ok) { const p = pixels(r.file); last = { size: p.s, top: p.at(0.5, 0.1), mid: p.at(0.5, 0.6), bottom: p.at(0.5, 0.97) };
    t("整張都是圖自己的顏色:上、中、最下面一列(不是頁面的深色底)", near(last.top, [230, 230, 230]) && near(last.mid, [230, 230, 230]) && near(last.bottom, [230, 230, 230])); }
  const n1 = files().length;
  t0 = Date.now();
  r = J(await call("browser_capture", { tab, ref: after("Stuck chart", /- figure \[@e\d+\]/), report: "lazy" }));
  t("一直載不完的圖 → capture_refused / incomplete,沒有多寫檔", !r.ok && r.error === "capture_refused" && r.reason === "incomplete" && hits.stuck === 1 && files().length === n1 && Date.now() - t0 >= 3900);
  r = J(await call("browser_capture", { tab, ref: after("Half drawn", /"Half drawn chart" \[@e\d+\]/), report: "lazy" }));
  t("只畫了上半的圖(下半透出頁面底色)→ 重拍一次還是一樣 → incomplete,沒有多寫檔", !r.ok && r.error === "capture_refused" && r.reason === "incomplete" && files().length === n1);
  r = J(await call("browser_capture", { tab, ref: after("Dark chart", /"Dark chart" \[@e\d+\]/), report: "lazy" }));
  t("深色底的圖表(下半是它自己的底色)照拍", r.ok === true && files().length === n1 + 1);
  r = J(await call("browser_capture", { tab, ref: after("Sparse chart", /"Sparse chart" \[@e\d+\]/), report: "lazy" }));
  t("大片平色、只有左上角一小塊東西的圖(下面 2/3 是它自己的底色)照拍", r.ok === true && files().length === n1 + 2);
  r = J(await call("browser_capture", { tab, ref: after("Empty chart", /"Empty chart" \[@e\d+\]/), report: "lazy" }));
  t("整張同一個顏色(什麼都還沒畫)→ incomplete,沒有多寫檔", !r.ok && r.reason === "incomplete" && files().length === n1 + 2);
  for (const res of open) { try { res.destroy(); } catch (_) { /* 已關 */ } }
  B.endTurn();
  srv.close(); tls.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* Windows:userData 還鎖著 */ }
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + (e && e.stack) + "\n      last: " + JSON.stringify(last).slice(0, 500)); app.exit(1); });
