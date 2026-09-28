// 進門判過之後才變的頁,內容不交給 agent、不存快照(0.1.8 稽核 P1-1;第十批 #1)。
// browser_read 對還在載的頁自己最多等 5 秒——這幾秒裡轉址落到 agent 不能去的網址、落到驗證頁、或用戶接手,
// 等完要用當下的狀態把進門那組判斷重跑一次。同樣形狀的 browser_snapshot / browser_get / browser_screenshot、
// 動作後的落定(afterAction)一併釘住;browser_capture 的在 check_shell_browser_capture_flow.js。
// 不開視窗:shell/browser/index.js 照常載入,視窗、分頁的 webContents、頁面物件(cdp.js)都是假的。
// 跑法:node tests/check_shell_browser_recheck.js
const path = require("path"), fs = require("fs"), os = require("os"), { EventEmitter } = require("events");
const B = path.join(__dirname, "..", "shell", "browser");
const IP = require(path.join(B, "inpage"));
let red = 0, last = null; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok ? "" : "  " + JSON.stringify(d === undefined ? last : d).slice(0, 600))); if (!ok) red++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET = "INBOX-SECRET-TEXT";

// ── 假的頁面物件:每一支「進頁面」的呼叫都記下當時的網址 ──
const pages = [];
const cdpFile = require.resolve(path.join(B, "cdp"));
require.cache[cdpFile] = { id: cdpFile, filename: cdpFile, loaded: true, exports: { createPage: (wc) => {
  const into = (what) => { p.entered.push({ what, url: wc.getURL() }); };
  const p = {
    entered: [], slow: 0, during: null,
    attach: async () => {}, detach: () => {}, guarded: () => false, guard: async () => {}, disarm: async () => {}, quiet: async () => {},
    run: async (fn) => (fn === IP.fieldCandidates ? [] : fn === IP.maskFields ? 0 : fn === IP.readable ? 0 : typeof fn === "function" && /innerText/.test(String(fn)) ? (into("get"), await p.lag(), SECRET) : null),
    lag: async () => { if (p.during) { const f = p.during; p.during = null; await sleep(p.slow || 50); f(); } },
    extract: async () => { into("extract"); await p.lag(); return { markdown: (SECRET + " paragraph of the page. ").repeat(20), meta: { title: "page" }, headings: [], links: [], blocks: [], view: null }; },
    snapshot: async () => { into("snapshot"); await p.lag(); return { text: "- button " + SECRET, refs: 1, truncated: false }; },
    screenshot: async () => { into("screenshot"); await p.lag(); return Buffer.from("png").toString("base64"); },
    scroll: async () => { await p.lag(); return { y: 0, max: 0 }; }, node: () => null,
    focused: async () => ({ backendNodeId: undefined, desc: { tag: "body", inForm: false } }), press: async () => { await p.lag(); return {}; },
  };
  pages.push(p); wc._page = p; return p;
} } };

// ── 假的 Electron:只有 index.js 開分頁用得到的那幾支 ──
let wcSeq = 0; const wcs = [];
class FakeView {
  constructor() {
    const wc = new EventEmitter(); let url = "";
    Object.assign(wc, { id: ++wcSeq, setAudioMuted() {}, setWindowOpenHandler() {}, getURL: () => url, _go: (u) => { url = u; }, getTitle: () => "title of " + url, isDestroyed: () => false, isLoading: () => false,
      loadURL: async (u) => { url = u; }, close() {}, stop() {}, navigationHistory: { canGoBack: () => false },
      debugger: { sendCommand: async () => ({ data: Buffer.from("img").toString("base64") }) } });
    this.webContents = wc; wcs.push(wc);
  }
  getBounds() { return { x: 20000, y: 0, width: 1280, height: 800 }; }
  setBounds() {}
}
const ses = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, on() {}, webRequest: { onBeforeRequest() {}, onResponseStarted() {} } };
const fakeE = { WebContentsView: FakeView, session: { fromPartition: () => ses }, nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 10, height: 10 }) }) }, net: {} };
const sent = [];
const win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, contentView: { addChildView() {}, removeChildView() {} }, webContents: { send: (_ch, ev) => sent.push(ev), getZoomFactor: () => 1 } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-recheck-"));
const snapDir = path.join(tmp, "snaps"), SID = "desktop-recheck1";
const snapshots = () => { try { return fs.readdirSync(path.join(snapDir, SID)).filter((n) => /^s[0-9a-f]+$/.test(n)).length; } catch (_) { return 0; } };
const J = (r) => (last = JSON.parse(r.content[0].text));

(async () => {
  const Br = require(path.join(B, "index.js")).createBrowser({ electron: fakeE, stateDir: snapDir, reportsDir: path.join(tmp, "reports"), getWin: () => win, uiLang: () => "en", track: () => {}, version: "test", reducedMotion: () => true, userPresent: () => true });
  await Br.beginTurn(win, SID);
  const call = (n, a) => Br._call(n, a || {}, { live: () => true });
  let host = 0;
  // 開一頁(還在載);land(url) = 這一格導覽到 url 並載完
  const open = async () => {
    const o = J(await call("browser_open", { url: "https://redirect-" + (++host) + ".com/x" }));   // 每次換一個網域:同網域每分鐘只能開 6 頁
    if (!o.ok) throw new Error("browser_open: " + JSON.stringify(o));
    const tab = Br._tabs.byAlias(o.tab), wc = wcs[wcs.length - 1], page = wc._page;
    return { alias: o.tab, tab, wc, page, close: () => Br._tabs.close(tab.id), land: (u) => { wc._go(u); wc.emit("did-navigate", {}, u, 200); wc.emit("did-stop-loading"); } };
  };
  const leaked = (r) => JSON.stringify(r).includes(SECRET) || JSON.stringify(r).includes("title of");
  const SORRY = "https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dx", MAIL = "https://mail.google.com/mail/u/0/";

  // ---- browser_read:等的這幾秒裡頁面變了
  { const x = await open(); setTimeout(() => x.land("https://news.example.org/story"), 300);
    const t0 = Date.now(), r = J(await call("browser_read", { tab: x.alias }));
    t("對照:等的期間落在一般的頁 → 自己等到載完、讀得到、存快照", r.ok === true && r.untrusted_content.includes(SECRET) && Date.now() - t0 >= 250 && snapshots() === 1 && !!x.tab.snapshotId, r); x.close(); }
  const before = snapshots();
  { const x = await open(); setTimeout(() => x.land(MAIL), 300);
    const r = J(await call("browser_read", { tab: x.alias }));
    t("進門時網址合格、等完落在 agent 不能去的網域 → blocked_policy,沒進頁面、沒內容、沒快照", r.ok === false && r.error === "blocked_policy" && r.reason === "sensitive_domain" && !leaked(r)
      && x.page.entered.length === 0 && !x.tab.snapshotId && snapshots() === before, [r, x.page.entered]); x.close(); }
  { const x = await open(); setTimeout(() => x.land(SORRY), 300);
    const r = J(await call("browser_read", { tab: x.alias }));
    t("等完落在搜尋引擎的驗證頁 → needs_user_verification,驗證頁裡什麼都沒跑、沒快照", r.ok === false && r.error === "needs_user_verification" && !leaked(r)
      && x.page.entered.length === 0 && !x.tab.snapshotId && snapshots() === before, [r, x.page.entered]); x.close(); }
  { const x = await open(); setTimeout(() => { Br.takeover(x.tab.id); x.land("https://news.example.org/login-done"); }, 300);
    const r = J(await call("browser_read", { tab: x.alias }));
    t("等的期間用戶接手 → user_in_control,沒進頁面、沒內容、沒快照", r.ok === false && r.error === "user_in_control" && !leaked(r)
      && x.page.entered.length === 0 && !x.tab.snapshotId && snapshots() === before, [r, x.page.entered]); x.close(); }
  { const x = await open(); setTimeout(() => { Br._tabs.close(x.tab.id); }, 300);
    const r = J(await call("browser_read", { tab: x.alias }));
    t("等的期間分頁被關掉 → not_found", r.ok === false && r.error === "not_found" && x.page.entered.length === 0 && snapshots() === before, r); }
  const HOME = "https://docs.example.org/a", pageTab = await open(); pageTab.land(HOME);
  // ---- 讀頁面本身的那一下(已經載完的頁、不等):讀的途中變了,讀到的也不交
  for (const [name, change, want] of [["換到 agent 不能去的網域", (x) => x.wc._go(MAIL), "blocked_policy"], ["換到驗證頁", (x) => x.wc._go(SORRY), "needs_user_verification"], ["用戶接手", (x) => Br.takeover(x.tab.id), "user_in_control"]]) {
    for (const tool of ["browser_read", "browser_snapshot", "browser_get", "browser_screenshot"]) {
      const x = pageTab; x.wc._go(HOME); Br.handback(x.tab.id); x.page.entered.length = 0;
      x.page.during = () => change(x);
      const r = J(await call(tool, Object.assign({ tab: x.alias }, tool === "browser_get" ? { what: "text" } : {})));
      t(tool + " 進頁面的途中" + name + " → " + want + ",內容不交、不存快照", r.ok === false && r.error === want && !leaked(r) && x.page.entered.length === 1 && !x.tab.snapshotId && snapshots() === before
        && (last = null, true), [r, x.page.entered, snapshots()]);
    }
  }
  // ---- 動作後的落定(0.7 秒):動作把頁面帶到驗證頁、或這段時間用戶接手
  for (const [name, change, want] of [["頁面被帶到驗證頁", (x) => x.wc._go(SORRY), "needs_user_verification"], ["用戶接手", (x) => Br.takeover(x.tab.id), "user_in_control"], ["頁面被帶到 agent 不能去的網域", (x) => x.wc._go(MAIL), "blocked_policy"]]) {
    const x = pageTab; x.wc._go(HOME); Br.handback(x.tab.id); x.page.entered.length = 0;
    x.page.during = () => change(x);
    const r = J(await call("browser_press", { tab: x.alias, key: "Tab" }));
    t("browser_press 之後" + name + " → " + want + ",不回那一頁的畫面", r.ok === false && r.error === want && !leaked(r) && !x.page.entered.some((e) => e.what === "snapshot"), [r, x.page.entered]);
  }
  { const x = pageTab; x.wc._go(HOME); Br.handback(x.tab.id);
    const r = J(await call("browser_press", { tab: x.alias, key: "Tab" }));
    t("對照:動作後頁面沒變 → 照常回畫面", r.ok === true && r.untrusted_content.includes(SECRET), r); }

  // ---- 原文鎖:重判用的是進門那一支(tabFor),不是另寫一份
  const idx = fs.readFileSync(path.join(B, "index.js"), "utf8");
  t("recheck 重跑的是 tabFor 整組判斷,而且認同一個分頁、同一個 view", /function recheck\(t, v\) \{\s*const x = tabFor\(t\.alias\);\s*return x\.e \|\| \(x\.t === t && x\.v === v \? null : ERR\("not_found", MSG\.not_found\)\);\s*\}/.test(idx));
  t("browser_read:等完先判才進頁面,讀完再判才交出去(在扣讀取預算、記讀過的字、存快照之前)",
    /await waitLoaded\(t, READ_WAIT_MS\);\s*(\/\/[^\n]*\n\s*)?const gone = recheck\(t, v\); if \(gone\) return gone;\s*let ex; try \{ ex = await v\.page\.extract\(\); \}[^\n]*\n\s*const late = recheck\(t, v\); if \(late\) return late;\s*const r = C\.readPart\(/.test(idx));
  t("browser_capture 拿到同一支 recheck", /createCapture\(\{[^}]*\brecheck\b/.test(idx));

  Br.endTurn();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  " + (e && e.stack) + "\n      last: " + JSON.stringify(last).slice(0, 500)); process.exit(1); });
