// Blave 電腦版 — 使用追蹤(主行程用)。契約:blave-canon output/backend/2026-09-21-desktop-telemetry-contract.md
//
// 只回答一件事:「哪一步發生了(或卡在哪一步)、什麼時候、哪個版本」。二十三個事件、每個事件的屬性都是列舉——
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
  connect_done: { kind: ["blave", "claude", "codex", "apikey"] },
  login_done: null,
  first_backtest_done: null,
  trade_started: { venue_kind: ["paper", "real"] },
  cloud_started: null,
  // 0.1.9 補「卡在哪一步」(研究 desktop-usage-2026-09-29 §5):屬性一律列舉,語意見 canon 登記表
  acct_card_shown: { card: ["pre_card", "pre_credit", "turn_card", "turn_credit"] },
  acct_card_click: { card: ["pre_card", "pre_credit", "turn_card", "turn_credit"] },
  acct_card_back: { state: ["ready", "no_card", "no_credit"] },
  turn_failed: { reason: ["402", "403", "429", "engine_missing", "other", "cap"] },   // cap = 自帶 API 金鑰撞到這一輪的用量上限(0.1.16)
  connect_failed: { kind: ["claude_login", "codex_login", "claude_gone", "codex_gone", "blave_oauth", "blave_cancel", "no_local",
    // 0.1.16 自帶 API 金鑰:「連結 / 儲存」驗不過(金鑰不認、餘額不足、連不到、其他);取消不算
    "apikey_key", "apikey_credit", "apikey_net", "apikey_other"] },
  first_reply_done: { kind: ["blave", "claude", "codex", "apikey"] },
  plan_start_res: { result: ["ok", "no_card", "no_credit", "error"] },
  update_failed: { stage: ["check", "download", "staging", "install", "other"] },
  lib_blocked: { why: ["signed_out", "no_card", "no_balance", "unknown", "cloud_off", "ai_no_card", "ai_no_credit"] },
  // 每日在線心跳:app 一直開著不重開的人沒有 app_open,靠它量到。事件本身就是「這台在線」;live = 本機對帳器在跑(含模擬)
  heartbeat: { live: ["on", "off"] },
  // 引擎安裝(0.1.12;shell/enginesetup.js,主行程送):一輪真的有東西要裝的安裝跑完的結果(first / upd × done / net / other / timeout;
  // 只修 venv 連結的不送),以及選用的那組(美股資料)沒裝好(前綴是組別)。分兩個事件:同一輪會同時有 first_done 與美股失敗
  engine_setup: { result: ["first_done", "first_net", "first_other", "first_timeout", "upd_done", "upd_net", "upd_other", "upd_timeout"] },
  engine_opt_fail: { result: ["us_net", "us_other", "us_timeout"] },
  // 策略庫轉換(0.1.13;spec-0.1.13-library-conversion §8,renderer 送):本機「用這支」回合跑起來時那支的資料需求(未標 = unknown;雲端不送)、
  // 找點子框送出成功時從哪個入口來。匿名使用不加屬性:看 user_id 有無、同一 install_id 之後有沒有 login_done
  lib_pick: { data: ["none", "required", "unknown"] },
  idea_sent: { from: ["welcome", "lib_head", "lib_empty"] },
  // 0.1.15 偵測失敗(renderer 送,只在連結畫面偵測完時):本機那個 CLI 為什麼不能用。值由主行程 detectWhy 判,語意見 canon 登記表
  detect_fail: { why: ["claude_none", "claude_timeout", "claude_nonzero", "claude_badjson", "codex_none", "codex_shim", "codex_timeout", "codex_nonzero"] },
  // 用了哪個功能:名字是白名單(canon .claude/docs/product-telemetry.md 的登記表;api 端 desktop_telemetry.EVENTS 同一份),
  // api 每安裝每 name 每 UTC 日去重——回答「誰、哪天、用過哪些功能」,不做逐點擊計數。library_* 的送出點在 renderer/library.js(libTrack),
  // reports_* 在 renderer/reports.js、strategy_new 在 renderer/newstrategy.js(都經 libTrack)。
  // library_comm:0.1.6 起沒有送出點(社群段平鋪了),但 0.1.5 舊外殼還在送、api 端要繼續收,兩端順序又要一致——等 0.1.5 退場再拿掉
  feature_used: { name: ["report_backtest", "report_trades", "report_scan", "report_code", "scan_requested",
    "trade_overview", "trade_positions", "trade_assets", "trade_history", "trade_settings", "strategy_picker",
    "handoff_cloud", "handoff_pull", "view_cloud", "chat_sent", "chat_stop", "settings_datasrc", "settings_plan", "library_open", "library_use", "library_comm",
    "reports_list", "reports_read", "reports_ask", "strategy_new",
    // 內建瀏覽器(0.1.7):browser_agent 由主行程送(回合內 agent 第一次呼叫瀏覽器工具),其餘在 renderer/browser.js
    "browser_agent", "browser_handoff", "browser_read", "browser_wall", "browser_back", "browser_sum", "browser_takeover", "browser_source", "browser_url",
    // 雲端群益開通(renderer/capital.js;spec-capital-connect-v2 §5):每開一次框每個名字最多一次,失敗不埋
    "cap_form_saved", "cap_setup_done", "cap_pfx_upload", "cap_sign_open", "cap_ready", "cap_rdp_open",
    // 報告區讀本機報告時從報告推(renderer/reports.js rptTrackKind):內建範本晨報、news block 的管道
    "morning_tw", "morning_crypto", "news_web", "news_licensed",
    // 報告公開分享(renderer/report-share.js;0.1.8):公開 / 更新成功、取消成功、按「複製連結」
    "share_publish", "share_revoke", "share_copy",
    // 策略轉出(renderer/export.js;0.1.8):確認框送出且回合跑起來(依平台)、程式碼分頁複製、下載…存好、在程式碼分頁看轉出檔
    "export_pine", "export_xq", "export_mc", "export_copy", "export_save", "export_view",
    // 策略版本(0.1.8;renderer/versions.js):開選單、進時光機、開比較框、還原送出、守門框送出分岔
    "version_menu", "version_view", "version_compare", "version_restore", "version_fork",
    // 聊天結果卡(renderer/results.js;0.1.8):按卡上的鈕(報告 / 策略),回合結束自己出卡不算;report_pdf = 報告「存成 PDF」
    "result_report", "result_strategy", "report_pdf",
    // 設定 › 公開連結(renderer/report-sharelist.js;0.1.8):切到那個分類、清單畫出來時
    "share_list_open",
    // 送進 TradingView(renderer/pine-install.js;0.1.8):按了送進、貼好交接、回傳結果送出、請 agent 修 / 貼送出、找不到編輯器、編譯沒過
    // tv_read / tv_fix / tv_fail_compile:0.1.8 流程改成停在交接之後沒有送出點(回傳結果、請 agent 修、檢查結果三個入口拿掉);
    // 名字留著——舊版外殼還在送、api 端照收,兩端逐字比對連順序都比
    "tv_send", "tv_pasted", "tv_read", "tv_fix", "tv_agent_paste", "tv_fail_editor", "tv_fail_compile",
    // 內建瀏覽器「用系統瀏覽器開」(renderer/browser.js;0.1.8):按了就記,不記網址
    "browser_open_ext",
    // 建議下一步(0.1.9;renderer/suggest.js):建議列長出來、點一行且回合跑起來。不送句子本身
    "suggest_shown", "suggest_clicked",
    // 設定 › Agent 規則(renderer/rules.js;0.1.9):切到那個分類、新增或編輯存成功、刪除成功、回覆語言改成功。背景同步不埋
    "settings_rules", "rules_save", "rules_delete", "reply_lang_set",
    // 樣本外驗證(0.1.10;renderer/app.js):點分頁(同 report_scan)、確認框送出且回合跑起來(同 scan_requested)
    "report_wf", "wf_requested",
    // 更新提示(0.1.10;main.js):「重新啟動以完成更新」真的走下去(直接裝、或下單中確認後)、搬到「應用程式」那一問按了「移」。主行程送
    "update_restart", "app_move",
    // 安裝進度卡(0.1.12;renderer/engine.js engRetry):按了卡上的「重試」(送下一句時自動再試的不算)
    "engine_retry",
    // pick_gate_lock:0.1.12 起無送出點(市場檢查出貨前整個拿掉);名字留著,api 白名單已登記、兩端逐字比對連順序都比
    "pick_gate_lock",
    // 策略庫成功筆記(0.1.12;renderer/library.js):閱讀頁內文第一次畫成功
    "library_note",
    // 內建瀏覽器的交還鈕(0.1.12;renderer/browser.js):標題列那顆、聊天那一列那顆,按了就記(不管有沒有 need;browser_handoff 照舊)
    "browser_hb_head", "browser_hb_chat",
    // 部位表點策略名開那支的進出場紀錄(0.1.12;renderer/trade.js trStratOpen):真的換頁才送,點下去才發現不在的不送
    "trade_strat_open",
    // 策略庫轉換(0.1.13;renderer/library.js libTurnEnd / libCloudChanged):「用這支」那一輪結束、清單真的多了一支(或覆蓋同名那支);
    // 本機那一輪結束了但沒看到新策略
    "lib_installed", "library_no_new",
    // 下單 UX(0.1.13;renderer/trade.js,ux-order-1-4-5 §4):第 3 級槓桿勾了而且存成功、部位表「N 支策略」拆解被打開。不帶金額
    "trade_lev_ack", "trade_net_open",
    // 部位表拒單那一行的「請 agent 查原因」(0.1.13;order-copy #14 §4.4):填進聊天框才算(不送出)
    "trade_err_ask",
    // 建議下一步的關閉(renderer/suggest.js sugDismiss):按 × 或 Esc 收掉;送出、換對話、出錯的收合不算。不分 × / Esc(name 16 字裝不下第二格)
    "suggest_closed",
    // 關於第二行「更新雲端主機」(0.1.15;renderer/app.js upCloudUpdate / upCloudSend):按下(含投資組合被鎖那一行的雲端入口)、
    // 確認或直接送出且回合真的跑起來、確認框沒按主鈕就收掉
    "cloud_upd_open", "cloud_upd_ok", "cloud_upd_cancel",
    // 缺資料來源金鑰(0.1.15;renderer/app.js rpGoDataSrc):按策略頁缺金鑰那一格的「去資料來源」,不帶來源名
    "missing_key_go",
    // 自帶 API 金鑰(0.1.16;renderer/apikey.js):按 API 金鑰那一列的「設定」(連結畫面或設定 › 模型接入)。測試成功 = connect_done kind=apikey
    "apikey_setup",
    // 綁卡／儲值入口(0.1.16;預檢卡與 402 卡另有 acct_card_click):bind_* 鈕字是綁卡、topup_* 是儲值／加值,後半是入口——
    // set = 設定 › 帳號與方案(含錯誤列的鈕)、data = 沒有資料權限卡、cloud = 雲端開通頁與雲端停機的加值鈕、lib = 策略庫閘門與買策略沒卡那一框。
    // 送出點 renderer/app.js bindGo(…)、renderer/library.js libTrack;策略庫 unknown(「帳號與方案」描邊鈕)不記
    "bind_set", "topup_set", "bind_data", "topup_data", "bind_cloud", "topup_cloud", "bind_lib", "topup_lib"] },
};
const ONCE = ["app_first_open", "first_backtest_done", "first_reply_done"];   // 每個安裝只送一次:自己記,不靠 api 去重
// 每安裝每屬性值每 UTC 日只送一次(契約 §「外殼端同日同 name 也不重送」):送過的記在狀態檔、換日整組清掉。
// 放主行程而不是畫面:被攻破的 renderer 對 track-feature 灌合法名字也只會出門 20 次,搶不到 api 那顆全域熔斷
const DAILY = ["feature_used", "acct_card_shown", "acct_card_click", "acct_card_back", "turn_failed", "connect_failed",
  "plan_start_res", "update_failed", "lib_blocked", "heartbeat", "engine_setup", "engine_opt_fail", "lib_pick", "idea_sent", "detect_fail"];
// 每日一則、不分屬性值:心跳一天只要一列(live 記當天第一次送出那一刻的),下單中途開關不多送
const DAILY_ONE = ["heartbeat"];
const HEARTBEAT_MS = 10 * 60 * 1000;   // 啟動後 10 分鐘起每 10 分鐘看一次;當天送過就不出門(啟動當天另有 app_open)
// 畫面(track-event)只准送這幾個;里程碑(app_first_open、login_done…)與主行程自己判的(plan_start_res、update_failed)不收
const FROM_RENDERER = ["acct_card_shown", "acct_card_click", "acct_card_back", "turn_failed", "connect_failed", "first_reply_done", "lib_blocked", "lib_pick", "idea_sent", "detect_fail"];
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

/* opts:{ dir, endpoint, appVersion, osVersion, lang, getToken?, post, now?, heartbeat?, heartbeatMs? }   now() 只給測試換日用
   heartbeat() → 心跳的屬性({ live });給了才排心跳。heartbeatMs 只給測試用
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
      const daily = DAILY.indexOf(event) >= 0, key = daily && DAILY_ONE.indexOf(event) < 0 ? event + ":" + Object.values(b.props).join(":") : event;
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
  let beat = null;
  function beatStart() {
    if (beat || typeof opts.heartbeat !== "function") return;
    // 先看關了沒、今天送過沒:heartbeat() 要同步讀下單狀態檔,一天 144 輪只有一輪會出門
    beat = setInterval(() => {
      try { if (load().enabled && dailyKeys().indexOf("heartbeat") < 0 && !inflight.has("heartbeat")) track("heartbeat", opts.heartbeat()); } catch (_) { /* 追蹤永遠不能炸 */ }
    }, opts.heartbeatMs || HEARTBEAT_MS);
    if (beat.unref) beat.unref();
  }
  return {
    track,
    start() { track("app_first_open"); track("app_open"); beatStart(); },   // 關掉 / 已送過:track 自己會擋;心跳的計時器只排一次
    isEnabled: () => load().enabled,
    // 重新打開立即恢復:這次啟動的那兩則補送(app_open 由 api 每日去重;app_first_open 送過就不會再送)
    setEnabled(on) { const was = load().enabled; st.enabled = !!on; save(); if (st.enabled && !was) this.start(); },
    installId: () => load().install_id,
  };
}

/* app 的現況,隨每一次 account_status 帶給 api(0.1.10 起;api 端 openclaw/desktop_telemetry.state_from_headers)。
   是設定值,不是使用事件:「使用事件」開關、現在連的是哪個 AI、本機有沒有跑過回測(只有 bt / none)。api 的提醒信
   看到 off 就不寄(隱私權政策 §9.1),連的 AI 與回測過沒有也以這份為準。關掉時只送 off,其他都不送;
   沒登入時 account_status 本來就不打。 */
const ENGINES = ["blave", "claude", "codex", "apikey"];
function statusHeaders(enabled, kind, backtested) {
  if (enabled !== true) return { "X-Blave-Telemetry": "off" };
  return { "X-Blave-Telemetry": "on", "X-Blave-Engine": ENGINES.indexOf(kind) >= 0 ? kind : "none",
    "X-Blave-Progress": backtested === true ? "bt" : "none" };
}
// 本機有沒有任何一支策略跑過回測:strategies/<name>/stats.json 存在就算,找到一支就停。讀不到目錄 = 沒有
function anyBacktest(stratDir) {
  try {
    for (const d of fs.readdirSync(stratDir, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(stratDir, d.name, "stats.json"))) return true;
    }
  } catch (_) { /* 還沒有 workspace */ }
  return false;
}

module.exports = { createTelemetry, EVENTS, FROM_RENDERER, statusHeaders, anyBacktest };
