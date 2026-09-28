// 內容很短的正常頁面不算「只停在轉址頁」(#209,0.1.8 第二十一批 #3):example.com 那種一個標題兩行字的最終頁,
// 以前因為正文不到 200 字被 content.js isRelay 當中繼頁 → 回合牆寫「讀了 0 頁」、格子歸在「讀不了」。
// 現在:文件載完(settled + readyState complete)、沒有 meta refresh、有標題、正文至少一句 → 是內容;
// 空殼(正文空)、有 meta refresh 等著轉走的中繼頁、還在載的頁、Loading／Redirecting 標題照舊是中繼頁。
//   ① 純 node:isRelay 的判定表;index.js 把「載完了沒」傳進去
//   ② 隨包的 Electron、看不見的視窗、本機替身頁(data: 網址,不連外):三頁真的走 extract() → isRelay()
// 跑法:node tests/check_shell_browser_relay_short.js(沒設 BLAVE_TEST_WINDOW=1 時 ② SKIP)
const path = require("path"), fs = require("fs"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
const IP = require(path.join(SHELL, "browser", "inpage.js")), C = require(path.join(SHELL, "browser", "content.js"));
let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || d === undefined ? "" : "  ← " + JSON.stringify(d))); if (!ok) red++; };

// example.com 2026 的正文(實機重現的那一頁):一個標題、一句話、一個連結,合起來不到 200 字
const SHORT = "# Example Domain\n\nThis domain is for use in documentation examples without needing permission. Avoid use in operations.\n\n[Learn more](https://iana.org/domains/example)\n\n";
const fin = { complete: true, refresh: false };

if (!process.versions.electron) {
  t("① 短正文的最終頁(載完、沒有 refresh、有標題)不是中繼頁", !C.isRelay({ markdown: SHORT, doc: fin, meta: { title: "Example Domain" } }, "Example Domain", true) && SHORT.length < 200);
  t("① 同一頁還在載(settled false / 沒傳)→ 照舊是中繼頁", C.isRelay({ markdown: SHORT, doc: fin }, "Example Domain", false) && C.isRelay({ markdown: SHORT, doc: fin }, "Example Domain"));
  t("① 同一頁 readyState 沒到 complete、或有 meta refresh 等著轉走 → 中繼頁", C.isRelay({ markdown: SHORT, doc: { complete: false, refresh: false } }, "Example Domain", true) && C.isRelay({ markdown: SHORT, doc: { complete: true, refresh: true } }, "Example Domain", true));
  t("① 沒有標題 / 沒有 doc(舊版 extract)→ 中繼頁", C.isRelay({ markdown: SHORT, doc: fin, meta: { title: "" } }, "", true) && C.isRelay({ markdown: SHORT }, "Example Domain", true));
  t("① 空殼(正文空 / 只有一個字)→ 中繼頁,就算載完了", C.isRelay({ markdown: "", doc: fin }, "My App", true) && C.isRelay({ markdown: "Loading", doc: fin }, "My App", true) && C.isRelay({ markdown: "You are being redirected", doc: fin }, "My App", true));
  t("① 整個標題就是 Loading／Redirecting／Just a moment → 中繼頁,不管載完沒", C.isRelay({ markdown: SHORT, doc: fin }, "Redirecting…", true) && C.isRelay({ markdown: "x ".repeat(300), doc: fin }, "Just a moment...", true));
  t("① 擋廣告攔截的擋牆頁照舊不算已讀;正文 ≥200 字的頁照舊不是中繼頁(不看 settled)", C.isRelay({ markdown: "We noticed your ad blocker is on. Please support our site by disabling it.", doc: fin }, "Benzinga", true) && !C.isRelay({ markdown: "word ".repeat(80) }, "Long article"));
  t("① 沒有站點特例(isRelay 不看網址)", !/location|hostname|example\.com/i.test(C.isRelay.toString()));
  const idx = fs.readFileSync(path.join(SHELL, "browser", "index.js"), "utf8");
  t("① index.js:讀完把「這一頁載完了、不是逾時算好的」傳給 isRelay", /C\.isRelay\(ex, v\.wc\.getTitle\(\), t\.status === "ready" && !t\.partial\)/.test(idx));
  t("① extract 交出 doc:{ complete, refresh }", /doc: \{ complete: document\.readyState === "complete", refresh \}/.test(IP.extract.toString()));
  const bin = GATE.bin(SHELL, "②");
  if (!bin) { console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  const sub = r.status == null ? 1 : r.status;
  console.log(red || sub ? "\nFAILED" : "\nALL PASS");
  process.exit(red || sub ? 1 : 0);
}
const { app, BrowserWindow } = require("electron");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-relay-short-"));
app.setPath("userData", tmp);
const page = (html) => "data:text/html;charset=utf-8," + encodeURIComponent("<!doctype html><html>" + html + "</html>");
const PAGES = {
  short: page("<head><title>Example Domain</title></head><body><div><h1>Example Domain</h1><p>This domain is for use in documentation examples without needing permission. Avoid use in operations.</p><p><a href='https://iana.org/domains/example'>Learn more</a></p></div></body>"),
  // 中繼頁:meta refresh 30 秒後轉走(測試在那之前就讀完);JS 轉址那種是同一份文件的另一半:讀的時候標題就是 Redirecting
  refresh: page("<head><title>Example Domain</title><meta http-equiv='refresh' content='30;url=about:blank'></head><body><h1>Example Domain</h1><p>You are being redirected to the new location of this page, please wait a moment.</p></body>"),
  jsredir: page("<head><title>Redirecting…</title></head><body><p>You are being redirected to the new location of this page, please wait a moment.</p><script>setTimeout(function(){ location.href = 'about:blank'; }, 30000);</script></body>"),
  shell: page("<head><title>My App</title></head><body><div id='root'></div><script>window.__state = {};</script></body>"),
};
setTimeout(() => { console.log("FAIL  ② 逾時(60 秒)"); process.exit(1); }, 60000).unref();

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const w = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { offscreen: true } });
  const read = async (url) => { await w.loadURL(url); const ex = await w.webContents.executeJavaScript("(" + IP.extract.toString() + ")()", true); return { ex, title: w.webContents.getTitle(), relay: C.isRelay(ex, w.webContents.getTitle(), true) }; };
  const a = await read(PAGES.short);
  t("② 一頁短文(標題 + 兩行字 + 連結):正文 <200 字、載完、沒有 refresh → 不是中繼頁(算已讀)", a.ex.markdown.replace(/\s+/g, " ").trim().length < 200 && a.ex.doc.complete === true && a.ex.doc.refresh === false && a.title === "Example Domain" && a.relay === false, [a.title, a.ex.doc, a.ex.markdown]);
  const b = await read(PAGES.refresh);
  t("② 只有 meta refresh 的中轉頁:extract 看到 refresh → 中繼頁", b.ex.doc.refresh === true && b.relay === true, [b.ex.doc, b.ex.markdown]);
  const c = await read(PAGES.jsredir);
  t("② JS 轉址的中轉頁(標題 Redirecting…)→ 中繼頁", c.relay === true, [c.title, c.ex.markdown]);
  const d = await read(PAGES.shell);
  t("② 空殼(有標題、沒有正文)→ 中繼頁", d.ex.markdown.trim() === "" && d.relay === true, [d.title, d.ex.markdown]);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* userData 還鎖著 */ }
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  app.exit(red ? 1 : 0);
}).catch((e) => { console.log("FAIL  " + (e && e.stack)); app.exit(1); });
