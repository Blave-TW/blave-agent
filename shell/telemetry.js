// Blave 電腦版 — 使用追蹤(主行程用)。契約:blave-canon output/backend/2026-09-21-desktop-telemetry-contract.md
//
// 只回答一件事:「哪一步發生了、什麼時候、哪個版本」。七個事件、每個事件的屬性都是列舉——
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
    st = ok ? { install_id: raw.install_id, enabled: raw.enabled !== false && (raw.enabled === true || DEFAULT_ON),
        sent: Array.isArray(raw.sent) ? raw.sent.filter((e) => ONCE.indexOf(e) >= 0) : [] }
      : { install_id: crypto.randomUUID(), enabled: exists ? false : DEFAULT_ON, sent: [] };
    if (!ok) save();
    return st;
  }
  function save() {
    try {   // tmp + rename:寫到一半當機不會留下壞檔
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ install_id: st.install_id, enabled: st.enabled, sent: st.sent }), { mode: 0o600 });
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
      if (!s.enabled) return false;
      const once = ONCE.indexOf(event) >= 0;
      if (once && (s.sent.indexOf(event) >= 0 || inflight.has(event))) return false;
      const b = body(event, props);
      if (!b) return false;
      // fire-and-forget。只送一次的那兩型在 2xx 之後才記帳:離線的第一次啟動不該讓 app_first_open 永遠消失(api 會去重)
      if (once) inflight.add(event);
      // 出門前再看一次開關:排進去之後、真的送出之前被關掉的,也不送(「關掉就立刻停止傳送」是寫給用戶看的承諾)
      Promise.resolve().then(() => (s.enabled ? opts.post(opts.endpoint, b) : null)).then((r) => {
        if (once && r && r.status >= 200 && r.status < 300 && s.sent.indexOf(event) < 0) { s.sent.push(event); save(); }
      }).catch(() => {}).then(() => inflight.delete(event));
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
