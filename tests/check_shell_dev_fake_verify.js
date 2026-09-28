// 開發版專用的假驗證頁開關(BLAVE_DEV_FAKE_VERIFY=1;第九批 #5):用來實機走一遍「搜尋被要求驗證 → 交給用戶 → 過了自動重搜」。
//   ① 開關的三種情形(純邏輯):開+未打包 → 這一輪第一次搜尋去假頁、之後照常;開+已打包 → 沒有這個功能;沒開 → 沒有這個功能
//   ② 原文鎖:正式流程(index.js / verify.js / policy.js)沒有為它長分支;打包版不 require、不收進包;假頁不帶外部資源、不收網址當參數
//   ③ 真 Electron(隱藏視窗):第一次 browser_search 落在假頁、發 need_user(captcha)、agent 的工具被拒(needs_user_verification)
// 絕不連真的搜尋引擎:③ 只做第一次搜尋,等到 need_user 就結束那一輪。
// 跑法:node tests/check_shell_dev_fake_verify.js(③ 要 BLAVE_TEST_WINDOW=1)
const path = require("path"), fs = require("fs"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
const VF = require(path.join(SHELL, "browser", "verify.js"));
const DV = require(path.join(SHELL, "browser", "devverify.js"));
let red = 0, last = null; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok ? "" : "  " + JSON.stringify(d === undefined ? last : d).slice(0, 600))); if (!ok) red++; };
const ON = { BLAVE_DEV_FAKE_VERIFY: "1" };

function pure() {
  // ---- ① 開關
  t("開關:只有「環境變數 = 1 而且未打包」才開;已打包一律關;沒設、設成別的值都關",
    DV.on(ON, false) === true && DV.on(ON, true) === false && DV.on({}, false) === false && DV.on({ BLAVE_DEV_FAKE_VERIFY: "true" }, false) === false
    && DV.on({ BLAVE_DEV_FAKE_VERIFY: "https://evil.example/x" }, false) === false && DV.on(null, false) === false);
  t("開+已打包 → 沒有這個功能(create 回 null);不知道打包與否也當成已打包", DV.create({ env: ON, isPackaged: true }) === null && DV.create({ env: ON }) === null && DV.create() === null);
  t("沒開 → 沒有這個功能", DV.create({ env: {}, isPackaged: false }) === null);
  const f = DV.create({ env: ON, isPackaged: false });
  const real = VF.ENGINES.google.url("cpi today", "zh-TW", 8);
  t("開+未打包:還沒 arm 的搜尋照常去 Google", !!f && f.engines.google.url("cpi today", "zh-TW", 8) === real);
  f.arm();
  const first = f.engines.google.url("cpi today", "zh-TW", 8), second = f.engines.google.url("cpi today", "zh-TW", 8);
  t("開+未打包:arm 之後的第一次搜尋去假頁(本機那個保留網域、/sorry/ 路徑,帶著查詢字),第二次照常去 Google",
    first === "http://fake-verify.test/sorry/fake?hl=zh-TW&num=8&q=cpi%20today" && second === real, [first, second]);
  t("判別表:開關開著的那一張多認假頁(照正式的規則就是 Google 的驗證頁、不是搜尋頁);其他列是同一個物件",
    VF.verifyPage(first, f.engines) === "google" && !VF.searchPage(first, "google", f.engines) && VF.searchPage(real, "google", f.engines)
    && f.engines.ddg === VF.ENGINES.ddg && f.engines.google.verify === VF.ENGINES.google.verify && f.engines.google.search === VF.ENGINES.google.search);
  t("正式的那一張判別表沒有被動到:不認假頁的網域", VF.verifyPage(first) === null && VF.engineOf(first) === null && !VF.ENGINES.google.host.test(DV.FAKE_HOST)
    && VF.ENGINES.google.url("cpi today", "zh-TW", 8) === real);
  t("假頁的網域是保留網域(.test,正式網路上不存在)", /^[a-z-]+\.test$/.test(DV.FAKE_HOST));

  // ---- ② 原文鎖
  const src = (p) => fs.readFileSync(path.join(SHELL, p), "utf8");
  const main = src("main.js"), dv = src("browser/devverify.js"), page = fs.readFileSync(DV.PAGE, "utf8");
  for (const p of ["browser/index.js", "browser/verify.js", "browser/policy.js", "browser/tools.js", "browser/tabs.js", "browser/inpage.js"])
    t("正式流程沒有為這個開關長分支:" + p + " 不提它", !/BLAVE_DEV_FAKE_VERIFY|devverify|fake-verify/i.test(src(p)));
  t("main.js:打包版不 require 這支;開關與打包與否都交給 create 判斷",
    /const fakeVerify = app\.isPackaged \? null : require\("\.\/browser\/devverify"\)\.create\(\{ env: process\.env, isPackaged: app\.isPackaged \}\);/.test(main));
  t("main.js 只接三個點:判別表交給 createBrowser、開瀏覽器時掛上本機那一頁、每一輪開始前 arm",
    /engines: fakeVerify \? fakeVerify\.engines : undefined,/.test(main) && /if \(fakeVerify\) fakeVerify\.serve\(/.test(main)
    && /if \(fakeVerify\) fakeVerify\.arm\(\);[^\n]*\n\s*try \{ brMount = await browser\(\)\.beginTurn\(/.test(main)
    && (main.match(/fakeVerify/g) || []).length === 7, (main.match(/fakeVerify/g) || []).length);
  const cfg = src("electron-builder.config.js");
  t("打包設定:這支與那一頁不收進包", cfg.includes('"browser/**/*", "!browser/devverify.*"') && path.basename(DV.PAGE) === "devverify.html");
  t("環境變數只有開 / 關:整支只讀這一個變數、只跟 \"1\" 比,不讀任何網址", (dv.match(/env\.[A-Z_]+/g) || []).join() === "env.BLAVE_DEV_FAKE_VERIFY" && !/process\.env/.test(dv));
  t("假頁寫明是測試用的假驗證頁,有一顆按鈕", page.includes("<h1>測試用的假驗證頁</h1>") && page.includes("<title>測試用的假驗證頁</title>") && (page.match(/<button/g) || []).length === 1);
  t("假頁不載入任何外部資源、不送表單;唯一會去的地方寫死是 Google 的搜尋頁",
    !/<(script|img|link|iframe)[^>]+(src|href)=/i.test(page) && !/fetch\(|XMLHttpRequest|sendBeacon/.test(page)
    && (page.match(/https?:\/\/[^\s"'<>)]+/g) || []).join() === "https://www.google.com/search?hl=" && /onsubmit="return false"/.test(page));
  t("假頁上有正式判別表認得的標記(#captcha-form):就算網址沒認出來,頁面標記也會認成驗證頁", page.includes('id="captcha-form"') && VF.ENGINES.google.verify.marks.includes("#captcha-form"));
  const policy = require(path.join(SHELL, "browser", "policy.js"));
  t("網址政策沒有放寬:本機檔案與本機位址照樣被擋", !!policy.agent("file://" + DV.PAGE) && policy.agent("file://" + DV.PAGE).reason === "scheme"
    && (policy.agent("http://127.0.0.1:8080/sorry/fake") || {}).reason === "private_address");
}

if (!process.versions.electron) {
  pure();
  const bin = GATE.bin(SHELL, "③");
  if (!bin) { console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  const code = (r.status == null ? 1 : r.status) || (red ? 1 : 0);
  console.log(code ? "\nFAILED" : "\nALL PASS"); process.exit(code);
} else {
  const electron = require("electron");
  const { app, BrowserWindow, session } = electron;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-dev-fake-verify-"));
  app.setPath("userData", tmp);
  const J = (r) => (last = JSON.parse(r.content[0].text));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => { const end = Date.now() + (ms || 8000); while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); } return null; };
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1200, height: 800, show: false });
    await win.loadURL("data:text/html,<p>host</p>");
    const { createBrowser, PARTITION } = require(path.join(SHELL, "browser"));
    const ses = session.fromPartition(PARTITION);
    const fake = DV.create({ env: ON, isPackaged: false });
    await fake.serve(ses);
    const sent = [];
    const realSend = win.webContents.send.bind(win.webContents);
    win.webContents.send = (ch, ev) => { if (ch === "browser-event") sent.push(ev); return realSend(ch, ev); };
    const B = createBrowser({ electron, stateDir: path.join(tmp, "snaps"), reportsDir: path.join(tmp, "reports"), getWin: () => win, uiLang: () => "zh", track: () => {}, version: "test",
      reducedMotion: () => true, engines: fake.engines, userPresent: () => true, notify: () => {} });
    const call = (n, a) => B._call(n, a || {}, { live: () => true });
    fake.arm();
    await B.beginTurn(win, "desktop-fakeverify1");
    let settled = null;
    const pending = call("browser_search", { query: "cpi today", count: 3 }).then(J).then((r) => (settled = r));
    const need = await until(() => sent.find((e) => e.type === "need_user" && e.kind === "captcha"), 15000);
    t("③ 開+未打包:第一次搜尋發 need_user(captcha),帶搜尋引擎的名字", !!need && need.summary === "Google", sent.map((e) => e.type));
    const tab = B._tabs.thisTurn().find((x) => x.searchTab), alias = tab && tab.alias;
    const wc = electron.webContents.getAllWebContents().find((w) => w.session === ses && w.getURL().includes(DV.FAKE_HOST));
    t("③ 搜尋分頁落在假頁(本機那一頁),標題寫明是測試用", !!wc && wc.getURL() === "http://fake-verify.test/sorry/fake?hl=zh-TW&num=6&q=cpi%20today" && wc.getTitle() === "測試用的假驗證頁", wc && [wc.getURL(), wc.getTitle()]);
    t("③ 那一格照正式流程標成驗證中", !!tab && tab.verify === "google" && B._verifying(alias) === true, tab && tab.verify);
    const refused = [];
    for (const [n, a] of [["browser_read", { tab: alias }], ["browser_snapshot", { tab: alias }], ["browser_click", { tab: alias, ref: "@e1" }], ["browser_press", { tab: alias, key: "Enter" }], ["browser_screenshot", { tab: alias }]]) {
      const r = J(await call(n, a)); if (r.ok !== false || r.error !== "needs_user_verification") refused.push(n + ":" + (r.error || "ok"));
    }
    t("③ agent 的工具對這一頁一律被拒(needs_user_verification)", refused.length === 0, refused);
    const r = J(await call("browser_open", { url: "http://fake-verify.test/sorry/fake?q=x" }));
    t("③ agent 不能自己開假頁的網址", r.ok === false, r);
    await sleep(300);
    t("③ 這次 browser_search 還在等用戶(沒有先回)", settled === null, settled);
    B.endTurn();   // 到此為止:不按按鈕、不走退路,所以不會連到任何真的搜尋引擎
    await Promise.race([pending, sleep(5000)]);
    t("③ 那一輪結束 → 這次呼叫收掉,沒有搜尋結果", !!settled && settled.ok === false, settled);
    fake.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* userData 還鎖著 */ }
    console.log(red ? `\n${red} FAILED` : "\nALL PASS(③)");
    app.exit(red ? 1 : 0);
  }).catch((e) => { console.log("FAIL  " + (e && e.stack) + "\n      last: " + JSON.stringify(last).slice(0, 500)); app.exit(1); });
}
