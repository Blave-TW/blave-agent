// Blave 電腦版 — 使用追蹤(主行程用)。契約:blave-canon output/backend/2026-09-21-desktop-telemetry-contract.md
//
// 只回答一件事:「哪一步發生了、什麼時候、哪個版本」。七個事件、每個事件的屬性都是列舉——
// 這個檔**沒有任何自由文字的入口**:對話、策略碼、策略名、標的、金額、部位、金鑰、路徑進不來,
// 不是靠呼叫端自律,是 track() 只認下面這張表(api 端還有同一張白名單再擋一次)。
//
// 送不出去就丟:不重試、不排隊、不擋任何功能;用戶在設定關掉 → 一則都不送(含 app_first_open)。
// **告知畫面看過之前一則都不送**(noticed):預設開是「告知過的預設開」,不是「沒講就開始送」。
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
};
const ONCE = ["app_first_open", "first_backtest_done"];   // 每個安裝只送一次:自己記,不靠 api 去重
const DEFAULT_ON = true;   // Wei 2026-09-21:預設開、照實告知、可關
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// 三個 meta 欄位過跟 api 同一組形狀(api/openclaw/desktop_telemetry.py):不符就整則不送——
// api 反正會 400,但更重要的是不讓形狀不對的字串離開電腦
const META = {
  app_version: /^[0-9]{1,4}(\.[0-9]{1,4}){1,3}(-(alpha|beta|rc)\.[0-9]{1,3})?$/,
  os_version: /^[0-9]{1,4}(\.[0-9]{1,4}){0,3}$/,
  lang: /^[a-z]{2,3}(-(Hans|Hant|Latn|Cyrl))?(-([A-Z]{2}|[0-9]{3}))?$/,
};

/* opts:{ dir, endpoint, appVersion, osVersion, lang, getToken?, post }
   post(url, body) → Promise;由 main.js 傳它自己的 postJSON(帶逾時)。 */
function createTelemetry(opts) {
  const file = path.join(opts.dir, "telemetry.json");
  let st = null;
  const inflight = new Set();   // 只送一次的事件:送出中不重送(記帳在 2xx 之後,中間那段靠它)
  function load() {
    if (st) return st;
    let raw = null, exists = false;
    try { const txt = fs.readFileSync(file, "utf8"); exists = true; raw = JSON.parse(txt); } catch (_) { /* 沒檔 = 新安裝;有檔但壞了 = 見下 */ }
    const ok = raw && typeof raw === "object" && UUID.test(raw.install_id);
    // 檔案在、但讀不出來:不知道用戶關過沒有 → 當成關(「關掉」這個決定不能因為壞檔就靜默變回開)
    st = ok ? { install_id: raw.install_id, enabled: raw.enabled !== false && (raw.enabled === true || DEFAULT_ON), noticed: raw.noticed === true,
        sent: Array.isArray(raw.sent) ? raw.sent.filter((e) => ONCE.indexOf(e) >= 0) : [] }
      : { install_id: crypto.randomUUID(), enabled: exists ? false : DEFAULT_ON, noticed: false, sent: [] };
    if (!ok) save();
    return st;
  }
  function save() {
    try {   // tmp + rename:寫到一半當機不會留下壞檔
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ install_id: st.install_id, enabled: st.enabled, noticed: st.noticed, sent: st.sent }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (_) { /* 記不住=下次多送一則,api 會去重 */ }
  }
  function body(event, props) {
    const spec = EVENTS[event];
    if (spec === undefined) return null;
    const clean = {};
    if (spec) for (const k of Object.keys(spec)) { if (!props || spec[k].indexOf(props[k]) < 0) return null; clean[k] = props[k]; }
    const b = { install_id: load().install_id, event, props: clean, app_version: String(opts.appVersion), os: "macos",
      os_version: String(opts.osVersion), lang: String(opts.lang), client_ts: Date.now() };
    for (const k of Object.keys(META)) if (!META[k].test(b[k])) return null;
    const tok = typeof opts.getToken === "function" ? opts.getToken() : null;
    if (typeof tok === "string" && tok) b.token = tok;
    return b;
  }
  function track(event, props) {
    try {
      const s = load();
      if (!s.enabled || !s.noticed) return false;
      const once = ONCE.indexOf(event) >= 0;
      if (once && (s.sent.indexOf(event) >= 0 || inflight.has(event))) return false;
      const b = body(event, props);
      if (!b) return false;
      // fire-and-forget。只送一次的那兩型在 2xx 之後才記帳:離線的第一次啟動不該讓 app_first_open 永遠消失(api 會去重)
      if (once) inflight.add(event);
      Promise.resolve().then(() => opts.post(opts.endpoint, b)).then((r) => {
        if (once && r && r.status >= 200 && r.status < 300 && s.sent.indexOf(event) < 0) { s.sent.push(event); save(); }
      }).catch(() => {}).then(() => inflight.delete(event));
      return true;
    } catch (_) { return false; }   // 追蹤永遠不能炸掉呼叫端
  }
  return {
    track,
    start() { track("app_first_open"); track("app_open"); },   // 沒看過告知 / 關掉 / 已送過:track 自己會擋
    setNoticed() { if (load().noticed) return; st.noticed = true; save(); this.start(); },   // 告知畫面顯示過:從這一刻才開始送
    isNoticed: () => load().noticed,
    isEnabled: () => load().enabled,
    setEnabled(on) { load(); st.enabled = !!on; save(); },
    installId: () => load().install_id,
  };
}

module.exports = { createTelemetry, EVENTS };
