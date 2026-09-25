// Blave 電腦版 — 使用追蹤(主行程用)。契約:blave-canon output/backend/2026-09-21-desktop-telemetry-contract.md
//
// 只回答一件事:「哪一步發生了、什麼時候、哪個版本」。八個事件、每個事件的屬性都是列舉——
// 這個檔**沒有任何自由文字的入口**:對話、策略碼、策略名、標的、金額、部位、金鑰、路徑進不來,
// 不是靠呼叫端自律,是 track() 只認下面這張表(api 端還有同一張白名單再擋一次)。
//
// 送不出去就丟:不重試、不排隊、不擋任何功能;用戶在設定 › 隱私 關掉 → 一則都不送(含 app_first_open、含關掉那一刻已經排進去還沒出門的)。
// app 裡不做首次告知(Wei 2026-09-21;告知落在隱私權政策與設定 › 隱私那一段):預設開就送、關掉就停。
// 舊版狀態檔裡的 noticed 欄位照讀不壞、但不再有作用;「曾經關掉」的人更新後仍是關的。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const EVENTS = {
  app_first_open: null,
  app_open: null,            // 每次啟動送一則;api 以「每安裝每 UTC 日」去重(留存、版本觸及率靠它)
  connect_done: { kind: ["blave", "claude", "codex"] },
  login_done: null,
  first_backtest_done: null,
  trade_started: { venue_kind: ["paper", "real"] },
  cloud_started: null,
  // 用了哪個功能:名字是白名單(canon .claude/docs/product-telemetry.md 的登記表;api 端 desktop_telemetry.EVENTS 同一份),
  // api 每安裝每 name 每 UTC 日去重——回答「誰、哪天、用過哪些功能」,不做逐點擊計數。library_* 兩個先登記、還沒有送出點
  feature_used: { name: ["report_backtest", "report_trades", "report_scan", "report_code", "scan_requested",
    "trade_overview", "trade_positions", "trade_assets", "trade_history", "trade_settings", "strategy_picker",
    "handoff_cloud", "handoff_pull", "view_cloud", "chat_sent", "settings_datasrc", "settings_plan", "library_open", "library_use"] },
};
const ONCE = ["app_first_open", "first_backtest_done"];   // 每個安裝只送一次:自己記,不靠 api 去重
// 每安裝每屬性值每 UTC 日只送一次(契約 §「外殼端同日同 name 也不重送」):送過的記在狀態檔、換日整組清掉。
// 放主行程而不是畫面:被攻破的 renderer 對 track-feature 灌合法名字也只會出門 19 次,搶不到 api 那顆全域熔斷
const DAILY = ["feature_used"];
const DAY_RE = /^[0-9]{8}$/;
const DEFAULT_ON = true;   // Wei 2026-09-21:預設開、照實告知、可關
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// 三個 meta 欄位過跟 api 同一組形狀(api/openclaw/desktop_telemetry.py):不符就整則不送——
// api 反正會 400,但更重要的是不讓形狀不對的字串離開電腦
// os_version 的段長 5:Windows 的 process.getSystemVersion() 是 10.0.20348 這種五位 build 號(api 同樣是 {1,5});
// 0.1.3 真機一則都沒送出去就是這裡 {1,4} 把整則丟掉、而且不留痕
const META = {
  app_version: /^[0-9]{1,4}(\.[0-9]{1,4}){1,3}(-(alpha|beta|rc)\.[0-9]{1,3})?$/,
  os_version: /^[0-9]{1,5}(\.[0-9]{1,5}){0,3}$/,
  lang: /^[a-z]{2,3}(-(Hans|Hant|Latn|Cyrl))?(-([A-Z]{2}|[0-9]{3}))?$/,
};

// api 的 OS_NAMES 只收這三個;別的平台(freebsd…)整則不送——api 反正會 400
const OS = { darwin: "macos", win32: "windows", linux: "linux" }[process.platform] || null;

/* opts:{ dir, endpoint, appVersion, osVersion, lang, getToken?, post, now? }   now() 只給測試換日用
   post(url, body) → Promise;由 main.js 傳它自己的 postJSON(帶逾時)。 */
function createTelemetry(opts) {
  const file = path.join(opts.dir, "telemetry.json");
  let st = null;
  const inflight = new Set();   // 只送一次 / 每日一次的事件:送出中不重送(記帳在 2xx 之後,中間那段靠它;同一秒連點兩下就是這裡擋)
  const nowMs = () => (typeof opts.now === "function" ? opts.now() : Date.now());
  const today = () => new Date(nowMs()).toISOString().slice(0, 10).replace(/-/g, "");
  // 狀態檔裡的 daily 讀不出形狀(舊版沒有、被改壞)= 當今天什麼都還沒送:最壞是多送一則,api 會去重
  const dailyOf = (raw) => raw && typeof raw === "object" && DAY_RE.test(raw.day) && Array.isArray(raw.keys)
    ? { day: raw.day, keys: raw.keys.filter((k) => typeof k === "string") } : { day: today(), keys: [] };
  const dailyKeys = () => { if (st.daily.day !== today()) st.daily = { day: today(), keys: [] }; return st.daily.keys; };   // 換日清掉
  function load() {
    if (st) return st;
    let raw = null, exists = false;
    try { const txt = fs.readFileSync(file, "utf8"); exists = true; raw = JSON.parse(txt); } catch (_) { /* 沒檔 = 新安裝;有檔但壞了 = 見下 */ }
    const ok = raw && typeof raw === "object" && UUID.test(raw.install_id);
    // 檔案在、但讀不出來:不知道用戶關過沒有 → 當成關(「關掉」這個決定不能因為壞檔就靜默變回開)
    st = ok ? { install_id: raw.install_id, enabled: raw.enabled !== false && (raw.enabled === true || DEFAULT_ON),
        sent: Array.isArray(raw.sent) ? raw.sent.filter((e) => ONCE.indexOf(e) >= 0) : [], daily: dailyOf(raw.daily) }
      : { install_id: crypto.randomUUID(), enabled: exists ? false : DEFAULT_ON, sent: [], daily: dailyOf(null) };
    if (!ok) save();
    return st;
  }
  function save() {
    try {   // tmp + rename:寫到一半當機不會留下壞檔
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ install_id: st.install_id, enabled: st.enabled, sent: st.sent, daily: st.daily }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (_) { /* 記不住=下次多送一則,api 會去重 */ }
  }
  function body(event, props) {
    const spec = EVENTS[event];
    if (spec === undefined) return null;
    const clean = {};
    if (spec) for (const k of Object.keys(spec)) { if (!props || spec[k].indexOf(props[k]) < 0) return null; clean[k] = props[k]; }
    if (!OS) return null;
    const b = { install_id: load().install_id, event, props: clean, app_version: String(opts.appVersion), os: OS,
      os_version: String(opts.osVersion), lang: String(opts.lang), client_ts: nowMs() };
    for (const k of Object.keys(META)) if (!META[k].test(b[k])) return null;
    const tok = typeof opts.getToken === "function" ? opts.getToken() : null;
    if (typeof tok === "string" && tok) b.token = tok;
    return b;
  }
  function track(event, props) {
    try {
      const s = load();
      if (!s.enabled) return false;
      const once = ONCE.indexOf(event) >= 0;
      if (once && (s.sent.indexOf(event) >= 0 || inflight.has(event))) return false;
      const b = body(event, props);
      if (!b) return false;
      // 每日一次的事件:鍵 = 事件 + 那一格屬性值(白名單驗過的那個,不是呼叫端給的原字);今天送過 / 送出中都不再出門
      const daily = DAILY.indexOf(event) >= 0, key = daily ? event + ":" + Object.values(b.props).join(":") : event;
      if (daily && (dailyKeys().indexOf(key) >= 0 || inflight.has(key))) return false;
      // fire-and-forget。只送一次 / 每日一次的在 2xx 之後才記帳:離線的第一次啟動不該讓 app_first_open 永遠消失(api 會去重)
      if (once || daily) inflight.add(key);
      // 出門前再看一次開關:排進去之後、真的送出之前被關掉的,也不送(「關掉就立刻停止傳送」是寫給用戶看的承諾)
      Promise.resolve().then(() => (s.enabled ? opts.post(opts.endpoint, b) : null)).then((r) => {
        const okR = r && r.status >= 200 && r.status < 300;
        if (once && okR && s.sent.indexOf(event) < 0) { s.sent.push(event); save(); }
        if (daily && okR && dailyKeys().indexOf(key) < 0) { dailyKeys().push(key); save(); }
      }).catch(() => {}).then(() => inflight.delete(key));
      return true;
    } catch (_) { return false; }   // 追蹤永遠不能炸掉呼叫端
  }
  return {
    track,
    start() { track("app_first_open"); track("app_open"); },   // 關掉 / 已送過:track 自己會擋
    isEnabled: () => load().enabled,
    // 重新打開立即恢復:這次啟動的那兩則補送(app_open 由 api 每日去重;app_first_open 送過就不會再送)
    setEnabled(on) { const was = load().enabled; st.enabled = !!on; save(); if (st.enabled && !was) this.start(); },
    installId: () => load().install_id,
  };
}

module.exports = { createTelemetry, EVENTS };
