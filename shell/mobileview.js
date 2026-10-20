/* 在手機 App 上查看這台電腦的部位(主行程用)。契約:blave-canon output/backend/2026-10-20-desktop-portfolio-upload-contract.md
 *
 * 把這台電腦的部位快照(state/local_status.json 的允許清單那幾塊)傳上平台,App 唯讀看。
 *   - 兩顆憑證(帳號 token + app_secret)只在主行程:不進 renderer、不進子行程的環境、不寫檔、不 log(同 cloud.js)。
 *   - 平台遠端開放旗標(§14)關著時:不上傳、不送 closing、設定頁不出這一區;但待刪的照刪(曾經上傳過的,任何時候都要刪得掉)。
 *     旗標讀不到 = 關。
 *   - 關掉開關當下刪不成(沒網路):記「待刪」,之後每一輪重送;待刪期間一律不上傳,就算又打開也要先刪成功。
 *   - 上傳失敗只寫一行 log、等下一輪;這個檔絕不碰 daemon、對帳或下單。
 * 狀態檔(userData/mobile-view.json)只有 {on, pending, uploaded} 三個布林,沒有憑證、沒有部位。
 *
 * 這個檔不 require electron;HTTP、時鐘、狀態來源都由呼叫端注入(tests/check_shell_mobileview.js 用假的)。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const whoOf = (c) => (c && c.token ? c.who || c.token : null);   // = tokenrotate.js 的 whoOf
const FLAG_ENDPOINT = "/oauth/desktop/local/enabled";
const REPORT_ENDPOINT = "/oauth/desktop/local/report";
const DELETE_ENDPOINT = "/oauth/desktop/local/report/delete";
const TICK_MS = 2 * 60 * 1000;
const EARLY_MIN_GAP_MS = 20 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000, DELETE_TIMEOUT_MS = 5 * 1000, CLOSING_TIMEOUT_MS = 3 * 1000;
const MAX_BYTES = 512 * 1024;   // = api desktop_portfolio.MAX_BYTES(整個 body)
const REPORT_MAX_BYTES = 64 * 1024;   // = api desktop_portfolio.STORED_MAX_BYTES(清過之後那一份;超過 api 回 413 不存)
// = api desktop_portfolio.ALLOWED_KEYS(tests/check_shell_mobileview.js 逐項比對兩端)
const ALLOWED_KEYS = ["config", "states", "previews", "backtest_previews", "tw_lots", "deferred_close", "tw_trading_day",
  "signals_frozen", "quote_ccy", "scheduled", "last_reconcile", "account", "order_errors", "orders",
  "reconciler", "command_listener", "halt", "account_guard", "venues", "self_ledger",
  "downtime_pause", "portfolio_configured", "reported_at", "error", "daemon"];
const FREE_TEXT_KEYS = ["error", "msg", "reason", "last_read_error"];
const HOME_RE = /(\/Users\/|\/home\/|[A-Za-z]:[\\/]+Users[\\/]+)[^/\\\s"']+/gi;
const URL_QUERY_RE = /(https?:\/\/[^\s"'?]*)\?[^\s"']*/g;
const LONG_TOKEN_RE = /[A-Za-z0-9+/=_-]{32,}/g;

// 裝置代號:install_id 的衍生值,跟 install_id 一樣穩定,但不能拿去串回使用追蹤事件(契約 §2)
function deviceOf(installId) {
  return typeof installId === "string" && installId ? crypto.createHash("sha256").update("blave-mobile-view:" + installId).digest("hex").slice(0, 32) : null;
}

function scrubStr(s, freeText, home) {
  let out = s;
  if (home) out = out.split(home).join("~").split(home.replace(/\\/g, "/")).join("~");
  out = out.replace(HOME_RE, "~").replace(URL_QUERY_RE, "$1?…");
  return freeText ? out.replace(LONG_TOKEN_RE, "…") : out;
}
function scrub(v, key, home) {
  if (typeof v === "string") return scrubStr(v, FREE_TEXT_KEYS.indexOf(key) >= 0, home);
  if (Array.isArray(v)) return v.map((x) => scrub(x, key, home));   // 清單元素繼承父鍵
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = scrub(v[k], k, home); return o; }
  return v;
}
/* 狀態檔 → 要送的那一份(純函式):允許清單、daemon 只留監督者三個 bool 與版號、遮路徑／網址參數／錯誤裡的長亂碼 */
function cleanReport(report, home) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  const out = {};
  for (const k of ALLOWED_KEYS) if (Object.prototype.hasOwnProperty.call(report, k)) out[k] = report[k];
  if (out.daemon && typeof out.daemon === "object") {
    const rec = out.daemon.reconciler && typeof out.daemon.reconciler === "object" ? out.daemon.reconciler : {};
    const keep = {}; for (const k of ["wanted", "running", "orphan"]) if (k in rec) keep[k] = rec[k];
    out.daemon = { version: out.daemon.version, reconciler: keep };
  } else if ("daemon" in out) out.daemon = null;
  return scrub(out, null, home);
}
// 「值得提早送」的那幾格:心跳、讀帳時間這種每 15 秒都在變的不算
function signature(line, r) {
  const last = (a) => (Array.isArray(a) && a.length ? JSON.stringify(a[a.length - 1]) : "");
  return JSON.stringify([line && line.state, r && r.halt && r.halt.halted, r && r.last_reconcile && r.last_reconcile.ts,
    last(r && r.orders), last(r && r.order_errors), r && r.config && r.config.amounts]);
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((resolve) => { const t = setTimeout(() => resolve(null), ms); if (t.unref) t.unref(); })]);
}

/* opts:{ dir, apiBase, post(url, body, extra), get(url), getCreds(), status() → { report } | null, line(status) → localLine | null,
         installId(), home, now?, log? } */
function createMobileView(opts) {
  const file = path.join(opts.dir, "mobile-view.json");
  const clock = opts.now || (() => Date.now());
  const log = opts.log || (() => {});
  let st = null, flag = false, lastSentAt = 0, lastSig = null, inflight = null, timer = null, kickTimer = null;
  function load() {
    if (st) return st;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { /* 沒檔 = 預設開(Wei 10-20 Q1) */ }
    st = { on: !(raw && raw.on === false), pending: !!(raw && raw.pending === true), uploaded: !!(raw && raw.uploaded === true) };
    return st;
  }
  function save() {
    try { const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(load()), { mode: 0o600 }); fs.renameSync(tmp, file); }
    catch (_) { /* 記不住:最壞是下次啟動忘了待刪,7 天 TTL 是最後一道 */ }
  }
  const device = () => deviceOf(opts.installId());
  const creds = () => { const c = opts.getCreds(); return c && c.token && c.appSecret ? c : null; };

  async function refreshFlag() {
    let r = null;
    try { r = await withTimeout(opts.get(opts.apiBase + FLAG_ENDPOINT), REQUEST_TIMEOUT_MS); } catch (_) { r = null; }
    flag = !!(r && r.status === 200 && r.body && r.body.enabled === true);
    return flag;
  }
  async function sendDelete(timeoutMs) {
    const c = creds(), dev = device();
    if (!c || !dev) return "no_creds";
    let r = null;
    try { r = await withTimeout(opts.post(opts.apiBase + DELETE_ENDPOINT, { token: c.token, app_secret: c.appSecret, device: dev }), timeoutMs); }
    catch (_) { r = null; }
    if (r && r.status === 200) return "ok";
    // 401 = 這組憑證已經失效:平台讀取時會把這顆 token 的那台藏起來,不必再刪(契約 §9.3)
    if (r && r.status === 401) return "gone";
    log("mobile view: delete not sent (" + (r ? r.status : "offline") + ")");
    return "failed";
  }
  async function flushPending() {
    const s = load();
    if (!s.pending) return true;
    const r = await sendDelete(REQUEST_TIMEOUT_MS);
    if (r === "failed") return false;
    s.pending = false; s.uploaded = false; save();
    return true;
  }
  async function upload(closing) {
    const s = load(), c = creds(), dev = device();
    if (!flag || !s.on || s.pending || !c || !dev) return false;
    const status = closing ? null : opts.status();
    const report = closing ? null : cleanReport(status && status.report, opts.home);
    if (!closing && !report) return false;
    if (report && Buffer.byteLength(JSON.stringify(report)) > REPORT_MAX_BYTES) { log("mobile view: report over 64 KB after cleaning, not sent"); return false; }
    const line = closing ? null : opts.line(status);
    const body = { token: c.token, app_secret: c.appSecret, device: dev, closing: !!closing, report };
    if (line) body.local_line = line;
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BYTES) { log("mobile view: report over 512 KB, not sent"); return false; }
    let r = null;
    try { r = await withTimeout(opts.post(opts.apiBase + REPORT_ENDPOINT, body), closing ? CLOSING_TIMEOUT_MS : REQUEST_TIMEOUT_MS); } catch (_) { r = null; }
    if (whoOf(opts.getCreds()) !== whoOf(c)) return false;   // 在途時登出 / 換了帳號
    if (r && r.status === 403 && r.body && r.body.error_code === "MOBILE_VIEW_OFF") { flag = false; return false; }
    if (!r || r.status !== 200) { log("mobile view: upload failed (" + (r ? r.status : "offline") + ")"); return false; }
    lastSentAt = clock(); lastSig = closing ? null : signature(line, report);
    if (!s.uploaded) { s.uploaded = true; save(); }
    return true;
  }
  // 一輪:先讀旗標,再刪待刪的,最後才上傳。同一時間只跑一輪
  function tick() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        await refreshFlag();
        if (!(await flushPending())) return false;
        return await upload(false);
      } catch (e) { log("mobile view: tick failed " + ((e && e.message) || e)); return false; }
      finally { inflight = null; }
    })();
    return inflight;
  }
  // 狀態有值得講的變動時提早送(每台最快 20 秒一次);旗標只靠 tick 刷新
  function kick() {
    const s = load();
    if (inflight || !flag || !s.on || s.pending || clock() - lastSentAt < EARLY_MIN_GAP_MS) return false;
    const status = opts.status(), report = status && status.report;
    if (!report || signature(opts.line(status), cleanReport(report, opts.home)) === lastSig) return false;
    inflight = upload(false).finally(() => { inflight = null; });
    return true;
  }
  async function setOn(on) {
    const s = load(), want = !!on;
    if (s.on === want) return state();
    s.on = want;
    if (!want) {
      lastSig = null;
      // 曾經傳過(或旗標開著、可能傳過)才需要刪;刪不成就記待刪,下一輪重送
      if (creds() && (s.uploaded || flag)) s.pending = (await sendDelete(REQUEST_TIMEOUT_MS)) === "failed";
      if (!s.pending) s.uploaded = false;
      save();
      return state();
    }
    save();
    if (await flushPending()) { await refreshFlag(); await upload(false); }   // 打開時立刻傳一份,不等下一個 2 分鐘
    return state();
  }
  /* 登出:撤銷 token 之前呼叫(撤銷之後這對憑證就刪不了)。刪不成也照樣登出:token 撤銷後平台讀取會把這台藏起來 */
  async function signOut() {
    const s = load();
    if (s.uploaded || s.pending || flag) await sendDelete(DELETE_TIMEOUT_MS);
    s.pending = false; s.uploaded = false; lastSig = null; lastSentAt = 0; save();
  }
  /* app 正常結束:最後一筆 closing。旗標關、開關關、待刪中、沒傳過都不送;最多等 3 秒,不卡結束流程 */
  function wantsClosing() { const s = load(); return flag && s.on && !s.pending && s.uploaded && !!creds(); }
  async function closing() { if (!wantsClosing()) return false; try { return await upload(true); } catch (_) { return false; } }
  function state() {
    const s = load();
    return { visible: flag, on: s.on, pending: s.pending, signedIn: !!creds() };
  }
  function start() {
    if (timer) return;
    tick();
    timer = setInterval(tick, TICK_MS); if (timer.unref) timer.unref();
    kickTimer = setInterval(kick, EARLY_MIN_GAP_MS); if (kickTimer.unref) kickTimer.unref();
  }
  function stop() { if (timer) clearInterval(timer); if (kickTimer) clearInterval(kickTimer); timer = null; kickTimer = null; }
  return { start, stop, tick, kick, setOn, signOut, closing, wantsClosing, state, refreshFlag, isVisible: () => flag };
}

module.exports = { createMobileView, cleanReport, deviceOf, signature, ALLOWED_KEYS, MAX_BYTES, REPORT_MAX_BYTES, TICK_MS, EARLY_MIN_GAP_MS,
  FLAG_ENDPOINT, REPORT_ENDPOINT, DELETE_ENDPOINT, CLOSING_TIMEOUT_MS, DELETE_TIMEOUT_MS };
