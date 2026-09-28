// 搜尋驗證交接怎麼收場,分開記(稽核 P2-4):用戶跳過(按出口 / 交還後還在驗證頁 / 關掉那一格)、逾時、人不在、引擎斷線各是一回事。
//   - 引擎斷線 / 回合結束 / 分頁壞掉不是用戶的決定:不記,同一輪的下一次搜尋照樣問他
//   - 用戶跳過與逾時各記各的,之後這一輪不再問,而回給模型的 reason 照那一種講(user_skipped / timeout / no_user),不是一律 captcha
// 不開視窗:視窗、webContents、頁面物件都是假的;搜尋引擎的結果頁由假頁面回「這是驗證頁」。
// 跑法:node tests/check_shell_browser_verify_outcome.js(約 30 秒:兩次搜尋之間有 4 秒間隔)
const path = require("path"), fs = require("fs"), os = require("os"), { EventEmitter } = require("events");
const SHELL = path.join(__dirname, "..", "shell"), B = path.join(SHELL, "browser");
let red = 0, last = null; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok ? "" : "  " + JSON.stringify(d === undefined ? last : d).slice(0, 600))); if (!ok) red++; };
const J = (r) => (last = JSON.parse(r.content[0].text));

(async () => {
  const IP = require(path.join(B, "inpage"));
  const cdpFile = require.resolve(path.join(B, "cdp"));
  require.cache[cdpFile] = { id: cdpFile, filename: cdpFile, loaded: true, exports: { createPage: (wc) => ({
    attach: async () => {}, detach: () => {}, guarded: () => false, guard: async () => {}, disarm: async () => {}, quiet: async () => {},
    run: async (fn) => (fn === IP.dirtyFields ? { n: 0, edited: false } : fn === IP.readable ? 0 : null),
    focused: async () => null, serp: async () => ({ captcha: true, items: [] }),   // 每一張搜尋結果頁都是驗證頁
  }) } };
  const wcs = [];
  class FakeView {
    constructor() {
      const wc = new EventEmitter(); let url = "";
      Object.assign(wc, { id: wcs.length + 1, setAudioMuted() {}, setWindowOpenHandler() {}, getURL: () => url, getTitle: () => "t", isDestroyed: () => false, isLoading: () => false,
        loadURL: async (u) => { url = u; setImmediate(() => { wc.emit("did-navigate", {}, u, 200); wc.emit("did-stop-loading"); }); }, close() {}, stop() {},
        navigationHistory: { canGoBack: () => false }, debugger: { sendCommand: async () => ({}) } });
      this.webContents = wc; wcs.push(wc); this._b = { x: 20000, y: 0, width: 1280, height: 800 };
    }
    getBounds() { return this._b; }
    setBounds(b) { this._b = b; }
  }
  const ses = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, on() {}, webRequest: { onBeforeRequest() {}, onResponseStarted() {} } };
  const fakeE = { WebContentsView: FakeView, session: { fromPartition: () => ses }, nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 10, height: 10 }) }) }, net: {} };
  const sent = [];
  const win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, contentView: { addChildView() {}, removeChildView() {} }, webContents: { send: (_ch, ev) => sent.push(ev), getZoomFactor: () => 1 } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-vo-"));
  const Br = require(path.join(B, "index.js")).createBrowser({ electron: fakeE, stateDir: path.join(tmp, "snaps"), reportsDir: path.join(tmp, "reports"), getWin: () => win, uiLang: () => "en", track: () => {}, version: "test", reducedMotion: () => true, userPresent: () => true });
  let conn = true;
  const search = () => Br._call("browser_search", { query: "btc etf flows", count: 3 }, { live: () => true, connected: () => conn });
  const asks = (from) => sent.slice(from).filter((e) => e.type === "need_user" && e.kind === "captcha");
  // 等到請求卡就做 fn;搜尋自己先回來(沒問)就回 null——不問的情況不能吊死在這裡
  const onAsk = (from, p, fn) => new Promise((res) => { const iv = setInterval(() => { const a = asks(from); if (a.length) { clearInterval(iv); fn(a[0]); res(a[0]); } }, 50); p.then(() => { clearInterval(iv); res(null); }, () => { clearInterval(iv); res(null); }); });
  await Br.beginTurn(win, "desktop-vo1", { userSent: true });

  // ---- 1. 引擎在等驗證的時候斷線:不算用戶拒絕;回 cancelled;同一輪的下一次搜尋照樣問
  let at = sent.length;
  let p = search(); t("1(前提)第一次搜尋問了他", !!(await onAsk(at, p, () => { conn = false; })));
  let r = J(await p);
  t("1 引擎斷線 → 這一次回 cancelled(沒有原因可講)", r.ok === false && r.error === "cancelled", r);
  t("1 等的那一格收掉(不佔名額)、沒有留下請求卡", Br._tabs.reachable().every((x) => !x.need && x.status !== "loading"), Br._tabs.reachable().map((x) => [x.status, !!x.need]));
  conn = true; at = sent.length;
  p = search(); const asked2 = await onAsk(at, p, (a) => Br.userDone(a.id, "skip"));   // 這次他按了「這次不搜尋」
  r = J(await p);
  t("1 下一次搜尋照樣問了他(斷線不算他拒絕);他跳過 → reason user_skipped", !!asked2 && r.ok === false && r.error === "search_unavailable" && r.reason === "user_skipped", r);
  at = sent.length; r = J(await search());
  t("1 之後這一輪不再問(沒有請求卡)、reason 講的是驗證頁(captcha)", asks(at).length === 0 && r.error === "search_unavailable" && r.reason === "captcha", r);

  // ---- 2. 逾時與人不在各記各的:之後的搜尋回同一種原因,不是一律 captcha
  for (const [end, reason] of [["timeout", "timeout"], ["absent", "no_user"]]) {
    Br.endTurn(); await Br.beginTurn(win, "desktop-vo1", { userSent: true });
    Br._cur().verifyEnd = end;   // 這一輪稍早的那一次驗證是這樣收場的
    at = sent.length; r = J(await search());
    t("2 這一輪之前" + (end === "timeout" ? "逾時" : "人不在") + "過 → 不再問、reason " + reason, asks(at).length === 0 && r.error === "search_unavailable" && r.reason === reason, r);
  }

  // ---- 3. 用戶把驗證頁那一格關掉 = 這次不做:算他跳過
  Br.endTurn(); await Br.beginTurn(win, "desktop-vo1", { userSent: true });
  at = sent.length;
  p = search(); t("3(前提)問了他", !!(await onAsk(at, p, (a) => Br._tabs.close(a.id))));
  r = J(await p);
  t("3 關掉驗證頁那一格 → reason user_skipped,記成跳過", r.error === "search_unavailable" && r.reason === "user_skipped" && Br._cur().verifyEnd === "declined", [r, Br._cur().verifyEnd]);

  // ---- 4. 原文鎖
  const idx = fs.readFileSync(path.join(B, "index.js"), "utf8");
  const hand = idx.slice(idx.indexOf("async function handVerify("), idx.indexOf("const SEARCH_TAIL_MS"));
  t("handVerify:closed 不記(引擎斷線 / 回合結束 / 分頁壞掉);分頁是用戶關掉的才當 exit;其餘照 timeout / absent / declined 分開記", /if \(got === "closed"\) \{/.test(hand) && /t\.status === "closed"/.test(hand)
    && /c\.verifyEnd = got === "timeout" \? "timeout" : got === "absent" \? "absent" : "declined";/.test(hand) && !/verifyDeclined/.test(idx));
  t("searchOnce:closed 對模型講 failed(不是 no_user)", /got === "closed" \? "failed"/.test(idx));
  Br.endTurn();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  " + (e && e.stack) + "\n      last: " + JSON.stringify(last).slice(0, 500)); process.exit(1); });
