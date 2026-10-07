// shell/telemetry.js:二十六個事件、屬性只有列舉、關掉就一則都不送、送不出去不炸。0.1.9 的九個「卡在哪一步」事件見檔尾那一段。
// 跑法:node tests/check_shell_telemetry.js
const fs = require("fs"), os = require("os"), path = require("path");
const { createTelemetry, EVENTS, FROM_RENDERER } = require("../shell/telemetry.js");
const ONCE_OF = (fsx) => !/const ONCE = \[[^\]]*feature_used/.test(fsx.readFileSync(path.join(__dirname, "..", "shell", "telemetry.js"), "utf8"));
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const tick = () => new Promise((r) => setTimeout(r, 5));
const mk = (dir, extra = {}) => { const sent = []; const tm = createTelemetry({ dir, endpoint: "https://x/t", appVersion: "0.3.1", osVersion: "15.5", lang: "zh-TW",
  post: (u, b) => { sent.push(b); return Promise.resolve({ status: 200 }); }, ...extra }); return { tm, sent }; };
// 這支測試建的暫存資料夾都放在同一個 TMP_ROOT 底下,跑完(成功、失敗、中途拋例外)一律收掉
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "blave-tm-"));
(async () => { try {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, "d-"));
  let { tm, sent } = mk(dir);
  tm.start(); await tick();
  t("預設開就送(app 裡不做首次告知):app_first_open + app_open", sent.map((b) => b.event).join() === "app_first_open,app_open");
  t("install_id 是 UUID、檔案權限 0600", /^[0-9a-f-]{36}$/.test(sent[0].install_id) && (fs.statSync(path.join(dir, "telemetry.json")).mode & 0o777) === 0o600);
  const ALLOWED = ["install_id", "event", "props", "app_version", "os", "os_version", "lang", "client_ts", "token"];
  t("送出去的欄位只有契約那幾個", sent.every((b) => Object.keys(b).every((k) => ALLOWED.indexOf(k) >= 0)));
  const id = sent[0].install_id;
  ({ tm, sent } = mk(dir)); tm.start(); await tick();
  t("重開:install_id 不變、不再送 app_first_open、只送 app_open", tm.installId() === id && sent.map((b) => b.event).join() === "app_open");
  sent.length = 0;

  t("不在白名單的事件不送", tm.track("chat_message", { text: "secret" }) === false);
  t("屬性不在列舉內不送", tm.track("connect_done", { kind: "BTCUSDT" }) === false && tm.track("connect_done") === false && tm.track("trade_started", { venue_kind: "binance" }) === false);
  t("多帶的屬性被丟掉", tm.track("connect_done", { kind: "claude", strategy: "my alpha", symbol: "BTCUSDT" }) === true);
  await tick();
  t("…送出去的 props 只剩列舉那一格", JSON.stringify(sent[0].props) === '{"kind":"claude"}' && !JSON.stringify(sent[0]).includes("alpha"));
  t("first_backtest_done 只送一次(跨重開)", tm.track("first_backtest_done") === true && tm.track("first_backtest_done") === false && (await tick(), mk(dir).tm.track("first_backtest_done")) === false);
  t("二十六個事件(0.1.9 +9 卡在哪一步、+heartbeat;0.1.10 更新提示只加 feature_used 的 name、不開新事件型別;0.1.12 +engine_setup / engine_opt_fail;0.1.13 +lib_pick / idea_sent;0.1.15 +detect_fail;0.1.18 +strat_created / strat_backtested / strat_deployed)、沒有自由文字型的屬性", Object.keys(EVENTS).length === 26 && Object.values(EVENTS).every((s) => s === null || Object.values(s).every(Array.isArray)));

  let tok = mk(dir, { getToken: () => "acct-abc" }); tok.tm.track("login_done"); await tick();
  t("有 token 才帶 token(放 body)", tok.sent[0].token === "acct-abc" && sent.every((b) => !("token" in b)));

  tm.setEnabled(false);
  const off = mk(dir); off.tm.start(); await tick();
  t("關掉:一則都不送、重開仍是關", off.tm.track("trade_started", { venue_kind: "paper" }) === false && off.sent.length === 0 && off.tm.isEnabled() === false);
  const dir2 = fs.mkdtempSync(path.join(TMP_ROOT, "d-"));
  const pre = mk(dir2); pre.tm.setEnabled(false); pre.tm.start(); await tick();
  t("新安裝先關掉:連 app_first_open 都不送", pre.sent.length === 0);
  // 關掉那一刻已經排進去、還沒出門的也不送(track 是 fire-and-forget,post 在下一個 microtask)
  const q = mk(fs.mkdtempSync(path.join(TMP_ROOT, "d-"))); const accepted = q.tm.track("login_done"); q.tm.setEnabled(false); await tick();
  t("關掉之後一則都不送——含已排隊的", accepted === true && q.sent.length === 0);
  q.tm.setEnabled(true); await tick();
  t("重新打開立即恢復:補送這次啟動的那兩則;再開一次不重送", q.sent.map((b) => b.event).join() === "app_first_open,app_open" && (q.tm.setEnabled(true), true) && (await tick(), q.sent.length === 2));
  // 舊版狀態檔(有 noticed 欄位)照讀不壞;曾經關掉的人更新後仍是關的、install_id 不變
  const dirOld = fs.mkdtempSync(path.join(TMP_ROOT, "d-")), oid = "11111111-2222-4333-8444-555555555555";
  fs.writeFileSync(path.join(dirOld, "telemetry.json"), JSON.stringify({ install_id: oid, enabled: false, noticed: true, sent: ["app_first_open"] }));
  const oldOff = mk(dirOld); oldOff.tm.start(); await tick();
  t("舊檔 enabled:false + noticed:true → 仍是關的、一則都不送", oldOff.tm.isEnabled() === false && oldOff.sent.length === 0 && oldOff.tm.installId() === oid);
  fs.writeFileSync(path.join(dirOld, "telemetry.json"), JSON.stringify({ install_id: oid, enabled: true, noticed: false, sent: ["app_first_open"] }));
  const oldOn = mk(dirOld); oldOn.tm.start(); await tick();
  t("舊檔沒看過告知(noticed:false)但沒關 → 照預設開;寫回去的檔不再有 noticed", oldOn.sent.map((b) => b.event).join() === "app_open" && oldOn.tm.installId() === oid && (oldOn.tm.setEnabled(true), !("noticed" in JSON.parse(fs.readFileSync(path.join(dirOld, "telemetry.json"), "utf8")))));

  const dirB = fs.mkdtempSync(path.join(TMP_ROOT, "d-"));
  const boom = mk(dirB, { post: () => Promise.reject(new Error("offline")) }); boom.tm.start(); await tick();
  t("送不出去不炸", boom.tm.track("cloud_started") === true); await tick();
  const again = mk(dirB); again.tm.start(); await tick();
  t("離線的第一次啟動不吃掉 app_first_open:沒拿到 2xx 就不記帳,下次再送", again.sent.map((b) => b.event).join() === "app_first_open,app_open");
  const third = mk(dirB); third.tm.start(); await tick();
  t("…拿到 2xx 之後就不再送", third.sent.map((b) => b.event).join() === "app_open");
  const dir400 = fs.mkdtempSync(path.join(TMP_ROOT, "d-"));
  const r400 = mk(dir400, { post: () => Promise.resolve({ status: 400 }) }); r400.tm.start(); await tick();
  t("非 2xx 不記帳", JSON.parse(fs.readFileSync(path.join(dir400, "telemetry.json"), "utf8")).sent.length === 0);
  const thrower = mk(fs.mkdtempSync(path.join(TMP_ROOT, "d-")), { post: () => { throw new Error("sync boom"); } }); thrower.tm.start();
  t("post 同步丟例外也不炸", (() => { try { thrower.tm.track("cloud_started"); return true; } catch (_) { return false; } })()); await tick();
  fs.writeFileSync(path.join(dir2, "telemetry.json"), "{broken");
  const broken = mk(dir2);
  t("狀態檔壞掉:不炸、當成關(關掉的決定不能因壞檔靜默變回開)", /^[0-9a-f-]{36}$/.test(broken.tm.installId()) && broken.tm.isEnabled() === false);
  // meta 欄位過跟 api 同一組形狀;不符整則不送
  for (const [k, v] of [["lang", "my secret note"], ["lang", "zh_TW"], ["lang", "BTC-USDT"], ["appVersion", "1.0.0-dev"], ["appVersion", "1.0-BTCUSDT.long"], ["osVersion", "Darwin 25.5"]]) {
    const x = mk(fs.mkdtempSync(path.join(TMP_ROOT, "d-")), { [k]: v }); x.tm.start(); await tick();
    t(k + "=" + JSON.stringify(v) + " → 一則都不出門", x.sent.length === 0 && x.tm.track("cloud_started") === false);
  }
  for (const v of ["zh-TW", "en-US", "en", "zh-Hant-TW", "es-419"]) { const x = mk(fs.mkdtempSync(path.join(TMP_ROOT, "d-")), { lang: v }); x.tm.start(); await tick(); t("lang=" + v + " 照送", x.sent.length === 2); }
  // os 依平台(0.1.3 Windows 真機:寫死 "macos" + os_version 段長 {1,4} 擋掉 10.0.20348 這種五位 build 號 → 一則都沒出門、sent 空)
  const tmSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "telemetry.js"), "utf8");
  t("os 不再寫死:依 process.platform 對到 macos / windows / linux(這台是 " + process.platform + ")", !/os: "macos"/.test(tmSrc) && sent.length > 0 && sent.every((b) => b.os === ({ darwin: "macos", win32: "windows", linux: "linux" })[process.platform]));
  for (const v of ["10.0.20348", "10.0.19045", "10.0.26100", "15.5", "14.6.1", "26.0"]) { const x = mk(fs.mkdtempSync(path.join(TMP_ROOT, "d-")), { osVersion: v }); x.tm.start(); await tick(); t("osVersion=" + v + " 照送(Windows 五位 build 號)", x.sent.length === 2 && x.sent[0].os_version === v); }
  { const apiPy = path.join(process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), "openclaw", "desktop_telemetry.py");
    if (fs.existsSync(apiPy)) { const api = fs.readFileSync(apiPy, "utf8"), pick = (src, k) => { const m = src.match(new RegExp(k + '[^\\n]*?(/|r")(\\^[^"/]+)')); return m ? m[2].replace(/\\Z$/, "$") : null; };
      t("os_version / lang / app_version 三個形狀跟 api 的 _*_RE 逐字相同(api 早已是 {1,5},外殼落後就是這次的 bug)", ["os_version", "lang", "app_version"].every((k) => pick(tmSrc, k + ":") && pick(tmSrc, k + ":") === pick(api, "_" + k.toUpperCase() + "_RE = re\\.compile\\("))); }
    else console.log("SKIP  api 不在旁邊,略過形狀比對"); }
  t("shell/package.json 的版號符合契約(不然打包版每一則都被丟)", /^[0-9]{1,4}(\.[0-9]{1,4}){1,3}(-(alpha|beta|rc)\.[0-9]{1,3})?$/.test(require("../shell/package.json").version));
  // main.js 的接線:這三件被改掉測試要紅
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
  t("main.js:開發版不送(isPackaged 閘還在;策略庫匿名下載的 install_id 共用同一支 telemetryLive)", /^const telemetryLive = \(\) => app\.isPackaged \|\| process\.env\.BLAVE_TELEMETRY === "1";$/m.test(mainSrc)
    && /post: \(u, b\) => \(telemetryLive\(\) \? postJSON\(u, b\) : Promise\.resolve\(\)\)/.test(mainSrc));
  t("main.js:lang 只取 app.getLocale()", /lang: app\.getLocale\(\)/.test(mainSrc) && !/lang: process\.env/.test(mainSrc));
  t("首次告知那條 IPC 退場;讀 / 切開關兩支都只收自家頁面", !/telemetry-noticed|telemetryNoticed|setNoticed/.test(mainSrc + fs.readFileSync(path.join(__dirname, "..", "shell", "preload.js"), "utf8") + fs.readFileSync(path.join(__dirname, "..", "shell", "telemetry.js"), "utf8"))
    && /ipcMain\.handle\("telemetry-get", \(e\) => \(fromOurPage\(e\)/.test(mainSrc) && /ipcMain\.handle\("telemetry-set", \(e, on\) => \{ if \(!fromOurPage\(e\)\) return false;/.test(mainSrc));

  // ── cloud_started:「送上雲端」確認框 → submitMessage(msg, { handoff: "up" }) → send-message → runTurn 成功才送。把真的那支 handler 切出來跑 ──
  const R = path.join(__dirname, "..", "shell", "renderer");
  const hoSrc = fs.readFileSync(path.join(R, "handoff.js"), "utf8"), appSrc = fs.readFileSync(path.join(R, "app.js"), "utf8");
  t("接線:確認框 onOk 帶 handoff 方向;submitMessage 原樣轉進 payload;重送(lastUserText)不帶", /submitMessage\(msg, \{ handoff: dir, noBacktest: tb === "B" \}\)/.test(hoSrc)
    && /async function submitMessage\(msg, opts\)/.test(appSrc) && /message: msg, handoff: opts && opts\.handoff, note: lastUserNote, model:/.test(appSrc) && (appSrc.match(/submitMessage\(lastUserText\b[^\n]*/g) || []).every((x) => !/handoff/.test(x)) && /function resendLast\(\) \{ return canResend\(\) \? submitMessage\(lastUserText, \{ attachment: lastUserAttachment, from: lastUserFrom \}\) : Promise\.resolve\(false\); \}/.test(appSrc));
  t("主行程:標記只認 \"up\" 且旗標要開;事件掛在 runTurn 的 then(spawn + stdin 成功),不在 catch", /const cloudUp = cloudHandoffOn\(\) && payload && payload\.handoff === "up";/.test(mainSrc)
    && /runTurn\(win, payload\)\.then\(\(\) => \{ if \(cloudUp\) tm\(\)\.track\("cloud_started"\); \}\)\.catch\(/.test(mainSrc));
  const hi = mainSrc.indexOf('ipcMain.handle("send-message", async (e, payload) => {');
  const cutBody = (from) => { let d = 0; for (let k = mainSrc.indexOf("{", from); k < mainSrc.length; k++) { if (mainSrc[k] === "{") d++; else if (mainSrc[k] === "}" && --d === 0) return mainSrc.slice(mainSrc.indexOf("{", from), k + 1); } throw new Error("no send-message body"); };
  const handlerBody = cutBody(hi + 'ipcMain.handle("send-message", async (e, payload) =>'.length);
  // 每個情境一份乾淨的狀態:真的 telemetry(自己的暫存目錄)+ 只 stub 主行程那幾個外部依賴
  const scenario = async ({ flag = true, ours = true, turnOk = true, enabled = true, payload }) => {
    const dir2 = fs.mkdtempSync(path.join(TMP_ROOT, "d-")), x = mk(dir2); if (!enabled) x.tm.setEnabled(false);
    const ends = [];
    const ctx = { fromOurPage: () => ours, activeTurn: null, turnStarting: false, restarting: null, cloudHandoffOn: () => flag, tm: () => x.tm, newTurnStop: () => {},
      BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, webContents: { send: (ch, a) => ends.push([ch, a]) } }) },
      loadConnection: () => ({ kind: "claude" }), minGate: () => ({ ensureFresh: async () => {}, turnAllowed: () => true }),
      runTurn: () => (turnOk ? Promise.resolve() : Promise.reject(new Error("AGENT_BIN_MISSING"))) };
    const handler = new Function("ctx", "with (ctx) { return async (e, payload) => " + handlerBody + "; }")(ctx);
    const r = await handler({ sender: {} }, payload); await tick(); await tick();
    return { r, events: x.sent.map((b) => b.event).join(), ends, turnStarting: ctx.turnStarting };
  };
  let s = await scenario({ payload: { handoff: "up", message: "把策略 btc_rsi 送上我的雲端主機。" } });
  t("旗標開 + 送上雲端 + 交到 agent 手上 → 送 cloud_started(只這一則、沒有 props、不含訊息)", s.r.started === true && s.events === "cloud_started" && s.turnStarting === false && !s.ends.length);
  s = await scenario({ flag: false, payload: { handoff: "up", message: "x" } });
  t("旗標關:就算 payload 帶了標記也不送(畫面本來到不了這條路)", s.r.started === true && s.events === "");
  s = await scenario({ turnOk: false, payload: { handoff: "up", message: "x" } });
  t("runTurn 失敗(引擎找不到 / spawn 失敗):不送,失敗照交給畫面", s.events === "" && s.ends.length === 1 && s.ends[0][0] === "turn-end" && s.ends[0][1].code === 1);
  s = await scenario({ enabled: false, payload: { handoff: "up", message: "x" } });
  t("追蹤關閉:不送", s.r.started === true && s.events === "");
  s = await scenario({ payload: { handoff: "down", message: "x" } });
  t("拉回這台電腦不是上雲端:不送", s.events === "");
  s = await scenario({ payload: { message: "hi" } });
  t("一般對話不送", s.events === "");
  s = await scenario({ ours: false, payload: { handoff: "up", message: "x" } });
  t("不是自家頁面:回 busy、不送", s.r.busy === true && s.events === "");
  // ── feature_used:名字是白名單,兩端同一份;renderer 每個送出點的名字都在表上;主行程拒絕表外的名字 ──
  const FEATURES = EVENTS.feature_used.name, trSrc = fs.readFileSync(path.join(R, "trade.js"), "utf8");
  t("feature_used 不是 once、name 白名單 = canon product-telemetry.md 那 69 個 + browser_open_ext + suggest_shown / suggest_clicked + 規則四個 + 樣本外驗證兩個 + 更新提示兩個 + 0.1.12 六個 + 0.1.13 五個 + suggest_closed + 0.1.15 更新雲端主機三個 + missing_key_go + 0.1.16 apikey_setup + 0.1.16 綁卡／儲值入口八個 + 0.1.17 歡迎頁資料清單兩個 + 0.1.17 聊天附件三個 = 110 個(0.1.6:+reports_list / reports_read / reports_ask / strategy_new;0.1.7 內建瀏覽器 +9、停止鈕 chat_stop、雲端群益開通 +6、晨報與新聞管道 +4;0.1.8 報告分享 +3、策略轉出 +6、策略版本 +5、聊天結果卡 +2、報告存成 PDF +1、設定 › 公開連結 +1、送進 TradingView +7;library_comm 沒送出點但 0.1.5 還在送,留到它退場;batch 6:+browser_open_ext;0.1.9 建議下一步 +2、設定 › Agent 規則 +4;0.1.10 樣本外驗證 +2(report_wf / wf_requested)、更新提示 +2(update_restart / app_move);0.1.12 安裝進度卡 engine_retry、市場對應 pick_gate_lock、策略庫成功筆記 library_note、交還鈕 browser_hb_head / browser_hb_chat、部位表點策略名 trade_strat_open,依序放最後;0.1.13 策略庫轉換 lib_installed / library_no_new、下單 UX 第 3 級槓桿勾選 trade_lev_ack、部位表拆解 trade_net_open、拒單請 agent 查原因 trade_err_ask 接在後面;建議下一步的關閉 suggest_closed 接在後面;0.1.15 關於第二行 cloud_upd_open / cloud_upd_ok / cloud_upd_cancel 接在後面、缺金鑰「去資料來源」missing_key_go 接在後面;0.1.16 自帶 API 金鑰 apikey_setup 接在後面;0.1.16 綁卡／儲值入口 bind_* / topup_* 八個接在後面;0.1.17 歡迎頁資料清單 welcome_data_row / welcome_data_all 接在後面、聊天附件 attach_file / attach_image / attach_paste 接在最後)", ONCE_OF(fs) && FEATURES.length === 110 && FEATURES[69] === "browser_open_ext" && FEATURES.slice(70).join() === "suggest_shown,suggest_clicked,settings_rules,rules_save,rules_delete,reply_lang_set,report_wf,wf_requested,update_restart,app_move,engine_retry,pick_gate_lock,library_note,browser_hb_head,browser_hb_chat,trade_strat_open,lib_installed,library_no_new,trade_lev_ack,trade_net_open,trade_err_ask,suggest_closed,cloud_upd_open,cloud_upd_ok,cloud_upd_cancel,missing_key_go,apikey_setup,bind_set,topup_set,bind_data,topup_data,bind_cloud,topup_cloud,bind_lib,topup_lib,welcome_data_row,welcome_data_all,attach_file,attach_image,attach_paste" && FEATURES[68] === "tv_fail_compile" && FEATURES[0] === "report_backtest" && FEATURES[15] === "chat_stop" && FEATURES[24] === "strategy_new" && FEATURES[33] === "browser_url" && FEATURES[39] === "cap_rdp_open" && FEATURES[43] === "news_licensed" && FEATURES[57] === "version_fork" && FEATURES[58] === "result_report" && FEATURES[59] === "result_strategy" && FEATURES[60] === "report_pdf" && FEATURES[61] === "share_list_open" && FEATURES.slice(62, 70).join() === "tv_send,tv_pasted,tv_read,tv_fix,tv_agent_paste,tv_fail_editor,tv_fail_compile,browser_open_ext" && FEATURES.every((n) => n.length <= 16) && FEATURES[20] === "library_comm");
  // 兩端漂移:api/openclaw/desktop_telemetry.py 的 EVENTS["feature_used"] 逐字同一份(同 check_runtime_mirror:要 monorepo 版面)
  const apiPy = path.join(process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), "openclaw", "desktop_telemetry.py");
  if (!fs.existsSync(apiPy)) console.log("SKIP  api 白名單比對(需要 monorepo 版面:../api/openclaw/desktop_telemetry.py)");
  else { const m = /"feature_used": \{"props": \{"name": \(([\s\S]*?)\)\}, "once": False\}/.exec(fs.readFileSync(apiPy, "utf8"));
    const apiNames = m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : null;
    t("api 端 feature_used.name 白名單 = 外殼這份(順序也同)", !!apiNames && JSON.stringify(apiNames) === JSON.stringify(FEATURES)); }
  // renderer 的送出點:掃 trackFeature(…) 的引數——字面、三元的兩個字面、或 XXX_FEATURE[…] 那張表的值;每個名字都要在表上,
  // 而且表上每個名字都要有送出點(library.js 走自己的 libTrack("…") 包裝,一樣掃)——名字登記了卻沒人送,報表上那一欄永遠是 0
  const used = new Set(), bad = [];
  for (const f of fs.readdirSync(R).filter((n) => /\.js$/.test(n))) {   // 全部 renderer 檔:新檔加了送出點也掃得到
    const src = fs.readFileSync(path.join(R, f), "utf8");
    const maps = {}; for (const m of src.matchAll(/const ([A-Z_]+_FEATURE) = \{([^}]*)\}/g)) maps[m[1]] = [...m[2].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    for (const m of src.matchAll(/(?<!function |\.)(?:trackFeature|libTrack)\(([^;]*?)\);/g)) {   // 跳過定義那行(function … / window.blave.…)
      // 引數整串只認三種形狀:一個字面、兩個字面的三元、XXX_FEATURE[…] 那張表;`ok ? "x" : v`、`"x" + y` 這種都列 bad
      const arg = m[1].trim(), names = [];
      let mm;
      if ((mm = /^"([a-z_]+)"$/.exec(arg))) names.push(mm[1]);
      else if ((mm = /^[^?]+ \? "([a-z_]+)" : "([a-z_]+)"$/.exec(arg))) names.push(mm[1], mm[2]);
      else if ((mm = /^([A-Z_]+_FEATURE)\[[^\]]+\]$/.exec(arg))) names.push(...(maps[mm[1]] || ["<unknown map " + mm[1] + ">"]));
      if (!names.length) bad.push(f + ": " + arg);
      for (const n of names) { used.add(n); if (FEATURES.indexOf(n) < 0) bad.push(f + ": " + n); }
    }
    // 綁卡／儲值入口走 bindGo("…")(app.js;記完就外開),呼叫常在 btn(…) 的引數裡、後面不是 `);`,另掃一次;同樣只認字面或兩個字面的三元
    for (const m of src.matchAll(/(?<!function )\bbindGo\(((?:[^()]|\([^()]*\))*)\)/g)) {
      const arg = m[1].trim(), names = [];
      let mm;
      if ((mm = /^"([a-z_]+)"$/.exec(arg))) names.push(mm[1]);
      else if ((mm = /^[^?]+ \? "([a-z_]+)" : "([a-z_]+)"$/.exec(arg))) names.push(mm[1], mm[2]);
      if (!names.length) bad.push(f + ": bindGo(" + arg + ")");
      for (const n of names) { used.add(n); if (FEATURES.indexOf(n) < 0) bad.push(f + ": " + n); }
    }
  }
  t("renderer 每個 trackFeature 送出點的名字都在白名單上、都是字面(沒有拿變數當名字)", bad.length === 0 && used.size > 0);
  if (bad.length) console.log("      " + bad.join("\n      "));
  // 0.1.6 起沒送出點(社群段平鋪),但 0.1.5 舊外殼還在送、api 要繼續收、兩端順序要一致:留到 0.1.5 退場。
  // browser_source 同理:0.1.8 拿掉來源卡、沒有送出點了,0.1.7 還在送
  // tv_read / tv_fix / tv_fail_compile:送進 TradingView 的流程改成停在交接(Wei 2026-09-28),三個入口拿掉之後沒有送出點;0.1.8 開發版之前的外殼還在送
  const LEGACY = ["library_comm", "browser_source", "tv_read", "tv_fix", "tv_fail_compile"];
  // 先佔名字、送出點還沒併進來的(report_pdf = 報告「存成 PDF」):送出點一進來這條就紅,提醒把它從這裡拿掉
  const RESERVED = ["report_pdf"];
  // 0.1.12 起無送出點:市場檢查出貨前整個拿掉,名字已在 api 白名單、兩端逐字比對,留著不動;不准再有送出點
  const DROPPED = ["pick_gate_lock"];
  // 主行程送的:browser_agent(agent 第一次呼叫瀏覽器工具,shell/browser/index.js firstUse 的 o.track;main.js 接到 telemetry)
  const brSrc = fs.readFileSync(path.join(R, "..", "browser", "index.js"), "utf8");
  const MAIN_SENT = /if \(o\.track\) o\.track\("browser_agent"\)/.test(brSrc) && /track: \(name\) => tm\(\)\.track\("feature_used", \{ name \}\)/.test(fs.readFileSync(path.join(R, "..", "main.js"), "utf8")) ? ["browser_agent"] : [];
  // 更新提示(0.1.10):main.js restartToUpdate 真的走下去(直接裝 / 下單中確認後)送 update_restart、askMoveToApps 按了「移」送 app_move
  { const mainS = fs.readFileSync(path.join(R, "..", "main.js"), "utf8");
    for (const n of ["update_restart", "app_move"]) if (mainS.includes('tm().track("feature_used", { name: "' + n + '" })')) MAIN_SENT.push(n); }
  const noSender = FEATURES.filter((n) => !used.has(n) && LEGACY.indexOf(n) < 0 && RESERVED.indexOf(n) < 0 && DROPPED.indexOf(n) < 0 && MAIN_SENT.indexOf(n) < 0);
  t("白名單上每個名字都有送出點(library_comm / browser_source / tv_read / tv_fix / tv_fail_compile 例外:留給舊外殼;pick_gate_lock 0.1.12 起無送出點)", noSender.length === 0 && LEGACY.concat(RESERVED, DROPPED).every((n) => FEATURES.includes(n) && !used.has(n))); if (noSender.length) console.log("      沒送出點:" + noSender.join(", "));
  /* 綁卡／儲值入口一個都不能漏(0.1.16):外開綁卡／儲值頁(acctUrl)的地方只准兩個——預檢卡 / 402 卡的 acctAction(記 acct_card_click)
     與 bindGo(記 bind_* / topup_*);以後誰再寫一顆 openExternal(acctUrl()) 卻沒記,這條就紅。
     策略庫兩個入口開的是設定 › 帳號與方案(planOpen)、不經 acctUrl,逐一釘住;每個 bind_* / topup_* 都要真的有入口在送 */
  { const BIND = FEATURES.filter((n) => /^(bind|topup)_/.test(n)), srcs = {};
    for (const f of fs.readdirSync(R).filter((n) => /\.js$/.test(n))) srcs[f] = fs.readFileSync(path.join(R, f), "utf8");
    const acctUses = [];
    for (const f in srcs) for (const m of srcs[f].matchAll(/acctUrl\(\)/g)) {
      const line = srcs[f].slice(srcs[f].lastIndexOf("\n", m.index) + 1, srcs[f].indexOf("\n", m.index));
      acctUses.push(f + ": " + line.trim());
    }
    const okUse = (u) => /^app\.js: function bindGo\(name\) \{ try \{ window\.blave\.trackFeature\(name\); \} catch/.test(u)
      || /^app\.js: return \{ label: [^\n]*on: \(\) => \{ acctClicked\(where, s\); window\.blave\.openExternal\(acctUrl/.test(u);
    const stray = acctUses.filter((u) => !okUse(u));
    const app = srcs["app.js"], tr = srcs["trade.js"], lib = srcs["library.js"];
    const sites = {
      "app 資料權限卡(綁卡/儲值)": /const top = \{ label: t\(acct\.reason === "NO_CARD" \? "acct\.addCard" : "fault\.noCreditBtn"\), on: \(\) => bindGo\(acct\.reason === "NO_CARD" \? "bind_data" : "topup_data"\) \};/.test(app),
      "app 方案頁 offer / noTrial 綁卡": (app.match(/btn\("btn-fill", t\("plan\.addCard"\), \(\) => bindGo\("bind_set"\)\)\] \}/g) || []).length === 2,
      "app 方案頁 none 儲值": /btn\("btn-fill", t\("fault\.noCreditBtn"\), \(\) => bindGo\("topup_set"\)\)\] \}/.test(app),
      "app 方案頁 stopped 加值": /btn\("btn-quiet", t\("plan\.manageStopped"\), ext\(planWebUrl\(\)\)\), btn\("btn-fill", t\("plan\.addCredit"\), \(\) => bindGo\("topup_set"\)\)\] \}/.test(app),
      "app 方案頁錯誤列 nocard / credit": /err\.key === "plan\.err\.nocard"\) acts = \[btn\("btn-fill", t\("plan\.addCard"\), \(\) => bindGo\("bind_set"\)\)\];\n\s*else if \(err && err\.key === "plan\.err\.credit"\) acts = \[btn\("btn-fill", t\("plan\.addCredit"\), \(\) => bindGo\("topup_set"\)\)\];/.test(app),
      "trade 雲端停機主鈕加值": /envCloudKind\(TR\.st\) === "stopped"\) \{ bindGo\("topup_cloud"\); return; \}/.test(tr),
      "trade 開通頁錯誤列 nocard / credit": /err\.key === "plan\.err\.nocard"\) main = btn\("btn-fill", t\("plan\.addCard"\), \(\) => bindGo\("bind_cloud"\), "main"\);\n\s*else if \(err && err\.key === "plan\.err\.credit"\) main = btn\("btn-fill", t\("plan\.addCredit"\), \(\) => bindGo\("topup_cloud"\), "main"\);/.test(tr),
      "trade 開通頁 card 綁卡": /view === "card"\) \{ main = btn\("btn-fill", t\("plan\.addCard"\), \(\) => bindGo\("bind_cloud"\), "main"\);/.test(tr),
      "library 閘門鈕(unknown 不記)": /function libGateBtn\(why\) \{[\s\S]*?b\.addEventListener\("click", \(\) => \{ if \(why !== "unknown"\) libTrack\(why === "no_balance" \? "topup_lib" : "bind_lib"\); planOpen\(\); \}\);\n\s*return b;\n\}/.test(lib),
      "library 買策略沒卡那一框": /t\("lib\.buy\.noCard"\)\], ok: t\("acct\.addCard"\), opener, onOk: \(\) => \{ libTrack\("bind_lib"\); planOpen\(\); \} \}\);/.test(lib),
    };
    const miss = Object.keys(sites).filter((k) => !sites[k]);
    t("綁卡／儲值入口全部有送:acctUrl 只在 acctAction 與 bindGo 兩處、十個入口各送對的 bind_* / topup_*、八個名字都有送出點", BIND.length === 8 && acctUses.length === 2 && !stray.length && !miss.length && BIND.every((n) => used.has(n)));
    if (stray.length) console.log("      沒記的 acctUrl:" + stray.map((u) => u.slice(0, 90)).join(" | "));
    if (miss.length) console.log("      入口對不上:" + miss.join(", "));
    // bindGo 本身:先記再外開,記失敗不擋外開
    const bg = /function bindGo\(name\) \{[^\n]*\}/.exec(app), calls = [];
    if (bg) new Function("window", "acctUrl", bg[0] + "\nbindGo(\"bind_set\");")({ blave: { trackFeature: (n) => { calls.push("t:" + n); throw new Error("x"); }, openExternal: (u) => calls.push("o:" + u) } }, () => "U");
    t("…bindGo 先送 feature_used 再外開同一頁;送的那一步丟例外也照樣外開", calls.join() === "t:bind_set,o:U"); }
  t("送出點只在功能那一層:report 五個分頁在 #rp-tabs 的 click(程式自動選預設分頁不記)、下單分頁在 trSetTab、選擇策略在 psOpen、切雲端在 envSwitch、掃描在 rpRobAsk 送出成功、樣本外驗證在 rpWfAsk 送出成功、聊天在 started、停止在 stopTurn 按下、設定兩類在 setCat、送上 / 拉回在 hoAsk 確認",
    /const RP_TAB_FEATURE = \{ bt: "report_backtest", tr: "report_trades", rob: "report_scan", wf: "report_wf", code: "report_code" \};\n\$\("rp-tabs"\)\.addEventListener\("click", \(e\) => \{[^\n]*\n\s*const b = e\.target\.closest\("\.rp-tab"\); if \(!b \|\| b\.disabled\) return;\n\s*rpShowTab\(b\.dataset\.tab\); trackFeature\(RP_TAB_FEATURE\[b\.dataset\.tab\]\);\n/.test(appSrc)
    && !/trackFeature/.test(appSrc.slice(appSrc.indexOf("function rpShowTab("), appSrc.indexOf("function rpRobOpts(")))
    && /function trSetTab\(tab, focus\) \{\n\s*TR\.tab = tab; TR\.landed = true;\n\s*trackFeature\(TR_TAB_FEATURE\[tab\]\);/.test(trSrc)
    && /trPickOff\(\)\) return;\n\s*trackFeature\("strategy_picker"\);/.test(trSrc) && /if \(env === ENV\.cur\) \{ if \(via === "link"\) head\(\); return; \}\n\s*if \(env === "cloud"\) trackFeature\("view_cloud"\);/.test(trSrc)
    && /\.then\(\(ok\) => \{ if \(ok\) trackFeature\("scan_requested"\); resolve\(ok \? turnSeq : false\); \}\)/.test(appSrc)
    && /\.then\(\(ok\) => \{ if \(ok\) trackFeature\("wf_requested"\); resolve\(ok \? turnSeq : false\); \}\)/.test(appSrc) && /if \(r\.started\) \{ busyStart\(\); trackFeature\("chat_sent"\); if \(attachment\) trackFeature\(ATTACH_FEATURE\[attachKind\(attachment, opts && opts\.from\)\]\); return true; \}/.test(appSrc)
    && /turnStopping = true; turnStopped = true; sendBtnSync\(\);\n\s*trackFeature\("chat_stop"\);/.test(appSrc)
    && /if \(cat === "src"\) \{ srcLoad\(\); trackFeature\("settings_datasrc"\); \}/.test(appSrc) && /if \(cat === "plan"\) \{ planPaint\(\); trackFeature\("settings_plan"\);/.test(appSrc)
    && /submitMessage\(msg, \{ handoff: dir, noBacktest: tb === "B" \}\)[^\n]*\n\s*\.then\(\(ok\) => \{ if \(ok\) trackFeature\(dir === "up" \? "handoff_cloud" : "handoff_pull"\); \}\);/.test(hoSrc));
  // 主行程:preload 只暴露 send、主行程只收自家頁面、名字交給 track()——表外的整則不送、表內的 props 只有 name 一格
  t("接線:preload trackFeature → send(\"track-feature\");主行程 fromOurPage 才 tm().track(\"feature_used\", { name })",
    /trackFeature: \(name\) => ipcRenderer\.send\("track-feature", name\),/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "preload.js"), "utf8"))
    && /ipcMain\.on\("track-feature", \(e, name\) => \{ if \(fromOurPage\(e\)\) tm\(\)\.track\("feature_used", \{ name \}\); \}\);/.test(mainSrc));
  { const x = mk(fs.mkdtempSync(path.join(TMP_ROOT, "d-")));
    t("主行程拒絕表外的 name:策略名 / 空字串 / 非字串 / 大小寫不對 / 缺 props 都不送", [{ name: "my alpha v7" }, { name: "" }, { name: ["chat_sent"] }, { name: { toString: () => "chat_sent" } }, { name: "Chat_Sent" }, {}, null].every((p) => x.tm.track("feature_used", p) === false) && x.sent.length === 0);
    t("表內的 name 送;每一個都送得出去;props 只有 name 一格、不帶多塞的欄位", FEATURES.every((n) => x.tm.track("feature_used", { name: n, strategy: "SECRET", symbol: "BTCUSDT" }) === true)); await tick();
    t("…送出去的 " + FEATURES.length + " 則 props 各是 {name}、不含多塞的字", x.sent.length === FEATURES.length && x.sent.every((b, i) => b.event === "feature_used" && JSON.stringify(b.props) === JSON.stringify({ name: FEATURES[i] }) && !JSON.stringify(b).includes("SECRET"))); }
  // ── 外殼端每安裝每 name 每 UTC 日只送一次(契約;api 那顆 3,000/hr 熔斷算的是 POST 數,前提就是這裡) ──
  { const dirD = fs.mkdtempSync(path.join(TMP_ROOT, "d-")); let clock = Date.UTC(2026, 8, 25, 23, 59, 30);
    const mkD = (extra = {}) => mk(dirD, { now: () => clock, ...extra });
    let d = mkD();
    t("同日同 name:第一次送、第二次直接 false 不打 api;別的 name 照送", d.tm.track("feature_used", { name: "chat_sent" }) === true && (await tick(), d.tm.track("feature_used", { name: "chat_sent" }) === false) && d.tm.track("feature_used", { name: "view_cloud" } ) === true); await tick();
    t("…出門的只有兩則", d.sent.map((b) => b.props.name).join() === "chat_sent,view_cloud");
    t("狀態檔記了 {day, keys}(跟 sent 同一個檔)", (() => { const j = JSON.parse(fs.readFileSync(path.join(dirD, "telemetry.json"), "utf8")); return j.daily.day === "20260925" && j.daily.keys.join() === "feature_used:chat_sent,feature_used:view_cloud"; })());
    d = mkD(); t("重開 app(同日):讀回狀態檔,同 name 仍不送", d.tm.track("feature_used", { name: "chat_sent" }) === false && d.sent.length === 0);
    d.tm.setEnabled(false); d.tm.setEnabled(true); await tick();
    t("關掉追蹤再打開:今天送過的不重送(補送的只有啟動那兩則)", d.tm.track("feature_used", { name: "chat_sent" }) === false && d.sent.map((b) => b.event).join() === "app_first_open,app_open");
    clock += 60 * 1000;   // 過了 UTC 午夜
    t("換日:同 name 再送一次;狀態檔換成新的一天、舊的那組清掉", d.tm.track("feature_used", { name: "chat_sent" }) === true && (await tick(), JSON.parse(fs.readFileSync(path.join(dirD, "telemetry.json"), "utf8")).daily.day === "20260926")
      && JSON.parse(fs.readFileSync(path.join(dirD, "telemetry.json"), "utf8")).daily.keys.join() === "feature_used:chat_sent");
    // 同一秒連點兩下:第一則還在路上(還沒 2xx、還沒記帳)第二則就要被 in-flight 擋掉
    let release = null; const slow = mk(fs.mkdtempSync(path.join(TMP_ROOT, "d-")), { post: () => new Promise((r) => { release = r; }) });
    t("送出中再 track 同 name:false(in-flight)", slow.tm.track("feature_used", { name: "chat_sent" }) === true && slow.tm.track("feature_used", { name: "chat_sent" }) === false); await tick();
    release({ status: 500 }); await tick();
    t("api 沒回 2xx:不記帳,之後可以再送(送出去就丟、api 去重)", slow.tm.track("feature_used", { name: "chat_sent" }) === true);
    // 狀態檔在、但 daily 那一段壞掉 / 舊版沒有:當今天什麼都沒送(退回「都送」),其餘欄位照讀
    for (const dailyRaw of [undefined, null, "x", { day: "yesterday", keys: [] }, { day: "20260925", keys: "chat_sent" }, { day: 20260925, keys: ["feature_used:chat_sent"] }]) {
      const dirB = fs.mkdtempSync(path.join(TMP_ROOT, "d-")), iid = "11111111-2222-4333-8444-555555555555";
      fs.writeFileSync(path.join(dirB, "telemetry.json"), JSON.stringify({ install_id: iid, enabled: true, sent: ["app_first_open"], daily: dailyRaw }));
      const b = mk(dirB, { now: () => clock }); t("daily 壞掉(" + JSON.stringify(dailyRaw) + ")→ 照送、install_id 不變", b.tm.track("feature_used", { name: "chat_sent" }) === true && b.tm.installId() === iid); }
    t("app_open 不走每日去重(每次啟動送、api 去重——留存靠它)", !/app_open/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "telemetry.js"), "utf8").match(/const DAILY = \[[^\]]*\]/)[0]));
  }


  // ── 0.1.9「卡在哪一步」九個事件(canon product-telemetry 登記表;研究 desktop-usage-2026-09-29 §5)──
  { const NEW = { acct_card_shown: ["card", ["pre_card", "pre_credit", "turn_card", "turn_credit"]], acct_card_click: ["card", ["pre_card", "pre_credit", "turn_card", "turn_credit"]],
      acct_card_back: ["state", ["ready", "no_card", "no_credit"]], turn_failed: ["reason", ["402", "403", "429", "engine_missing", "other", "cap"]],
      connect_failed: ["kind", ["claude_login", "codex_login", "claude_gone", "codex_gone", "blave_oauth", "blave_cancel", "no_local", "apikey_key", "apikey_credit", "apikey_net", "apikey_other"]],
      first_reply_done: ["kind", ["blave", "claude", "codex", "apikey"]], plan_start_res: ["result", ["ok", "no_card", "no_credit", "error"]],
      update_failed: ["stage", ["check", "download", "staging", "install", "other"]],
      lib_blocked: ["why", ["signed_out", "no_card", "no_balance", "unknown", "cloud_off", "ai_no_card", "ai_no_credit"]] };
    t("九個新事件逐字在白名單上:一個屬性、值全是列舉、事件名與值都 ≤16 字", Object.keys(NEW).every((ev) => EVENTS[ev] && JSON.stringify(Object.keys(EVENTS[ev])) === JSON.stringify([NEW[ev][0]]) && JSON.stringify(EVENTS[ev][NEW[ev][0]]) === JSON.stringify(NEW[ev][1]) && ev.length <= 16 && NEW[ev][1].every((v) => v.length <= 16))
      && Object.keys(EVENTS).every((ev) => ev.length <= 19));   // 舊的 first_backtest_done 19 字,新名字一律 ≤16
    const tmSrc9 = fs.readFileSync(path.join(__dirname, "..", "shell", "telemetry.js"), "utf8");
    t("first_reply_done 每安裝一次(ONCE);其餘八個每日一次(DAILY,api 的每小時熔斷算的是 POST 數)", /const ONCE = \[[^\]]*"first_reply_done"/.test(tmSrc9) && Object.keys(NEW).filter((e) => e !== "first_reply_done").every((e) => new RegExp('const DAILY = \\[[^\\]]*"' + e + '"').test(tmSrc9)));
    t("畫面只准送這幾個(FROM_RENDERER;0.1.13 +lib_pick / idea_sent、0.1.15 +detect_fail 接在最後);里程碑與主行程自己判的兩個不在名單上", JSON.stringify(FROM_RENDERER) === JSON.stringify(["acct_card_shown", "acct_card_click", "acct_card_back", "turn_failed", "connect_failed", "first_reply_done", "lib_blocked", "lib_pick", "idea_sent", "detect_fail"])
      && ["app_first_open", "app_open", "login_done", "first_backtest_done", "trade_started", "cloud_started", "feature_used", "plan_start_res", "update_failed", "heartbeat"].every((e) => !FROM_RENDERER.includes(e)));
    const x = mk(fs.mkdtempSync(path.join(TMP_ROOT, "d-")));
    t("每個事件的每個值都送得出去;表外的值 / 缺屬性 / 塞內容都不送", Object.keys(NEW).every((ev) => NEW[ev][1].every((v) => x.tm.track(ev, { [NEW[ev][0]]: v, msg: "SECRET" }) === true || ev === "first_reply_done"))
      && Object.keys(NEW).every((ev) => x.tm.track(ev, { [NEW[ev][0]]: "SECRET_BTCUSDT" }) === false && x.tm.track(ev) === false)); await tick();
    t("…出門的 props 各只有那一格、不含多塞的字", x.sent.length > 0 && x.sent.every((b) => Object.keys(b.props).length === 1 && !JSON.stringify(b).includes("SECRET")));
    t("…同日同值不重送(每日去重);first_reply_done 換了引擎也只送過一次", x.tm.track("turn_failed", { reason: "402" }) === false && x.tm.track("first_reply_done", { kind: "codex" }) === false
      && x.sent.filter((b) => b.event === "first_reply_done").length === 1);
    // api 端同一份:事件名、屬性名、值、once 逐字相同(feature_used 上面比過了)
    const apiPy9 = path.join(process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), "openclaw", "desktop_telemetry.py");
    if (!fs.existsSync(apiPy9)) console.log("SKIP  api 端九個新事件比對(需要 monorepo 版面)");
    else { const api = fs.readFileSync(apiPy9, "utf8"), got = {};
      for (const m of api.matchAll(/"([a-z_]+)": \{"props": \{"([a-z_]+)": \(([^()]*)\)\}, "once": (True|False)\}/g)) got[m[1]] = { key: m[2], vals: [...m[3].matchAll(/"([^"]+)"/g)].map((v) => v[1]), once: m[4] === "True" };
      t("api desktop_telemetry.EVENTS 的九個新事件 = 外殼這份(屬性名、值、順序、once)", Object.keys(NEW).every((ev) => got[ev] && got[ev].key === NEW[ev][0] && JSON.stringify(got[ev].vals) === JSON.stringify(NEW[ev][1]) && got[ev].once === (ev === "first_reply_done")));
      t("api 的 heartbeat = 外殼這份(live: on / off、不是 once)", !!got.heartbeat && got.heartbeat.key === "live" && JSON.stringify(got.heartbeat.vals) === '["on","off"]' && got.heartbeat.once === false); }
    // 畫面的送出點:每個 trackEvent("…") 的事件都在 FROM_RENDERER、屬性名對、字面值都在列舉;名單上每個事件都有送出點
    // 當成「值」送出去的字面:整格就是字面、三元的兩支、|| 的預設;比較用的(=== "codex")不算
    const valLits = (expr) => [...expr.matchAll(/(?:^|\? |: |\|\| )"([^"]+)"/g)].map((v) => v[1]);
    const sites = [], badE = [];
    for (const f of fs.readdirSync(R).filter((n) => /\.js$/.test(n))) {
      const src = fs.readFileSync(path.join(R, f), "utf8");
      for (const m of src.matchAll(/trackEvent\("([a-z_]+)", \{ ([a-z_]+)(?:: ([^}]*))? \}\)/g)) {
        sites.push(m[1]);
        const spec = EVENTS[m[1]], key = spec && Object.keys(spec)[0];
        if (!FROM_RENDERER.includes(m[1]) || m[2] !== key) badE.push(f + ": " + m[0]);
        for (const v of valLits(m[3] || "")) if (!spec || spec[key].indexOf(v) < 0) badE.push(f + ": " + m[1] + "=" + v);
      }
      for (const m of src.matchAll(/(?<![.\w])trackEvent\(([^)]*)/g)) if (!/^"[a-z_]+", \{/.test(m[1]) && !/^ev, props$/.test(m[1])) badE.push(f + ": 形狀不對 " + m[0]);
      for (const m of src.matchAll(/libBlocked\(([^()]*(?:\([^()]*\))?[^()]*)\);/g)) for (const v of valLits(m[1])) if (EVENTS.lib_blocked.why.indexOf(v) < 0) badE.push(f + ": lib_blocked=" + v);
    }
    t("畫面每個 trackEvent 送出點:事件在 FROM_RENDERER、屬性名對、字面值在列舉;九個都有送出點", badE.length === 0 && FROM_RENDERER.every((e) => sites.includes(e)));
    if (badE.length) console.log("      " + badE.join("\n      "));
    // 算值的純函式:切出來跑,每種輸入的輸出都在列舉裡(或 null = 不送)
    const appSrc9 = fs.readFileSync(path.join(R, "app.js"), "utf8"), libSrc9 = fs.readFileSync(path.join(R, "library.js"), "utf8");
    const fnOf = (src, name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return new Function("return (" + src.slice(i, k + 1) + ")")(); } };
    const kind = fnOf(appSrc9, "acctCardKind"), back = fnOf(appSrc9, "acctBackState"), fail = fnOf(appSrc9, "turnFailOf"), why = fnOf(libSrc9, "libBlockedWhy");
    const S = [null, {}, { reason: "NO_CARD" }, { reason: "NO_CREDIT" }, { reason: null, can_run: false }, { can_run: true, reason: "NO_CARD" }];
    t("acctCardKind:跟著卡上的句子分(預檢卡 NO_CREDIT → pre_credit、其餘 pre_card;402 卡 NO_CARD → turn_card、其餘 turn_credit)",
      S.every((s) => ["pre", "turn"].every((w) => EVENTS.acct_card_shown.card.includes(kind(w, s))))
      && kind("pre", { reason: "NO_CREDIT" }) === "pre_credit" && kind("pre", null) === "pre_card" && kind("turn", { reason: "NO_CARD" }) === "turn_card" && kind("turn", null) === "turn_credit");
    t("acctBackState:可以跑 → ready;還會重查 → null(先不下結論);重查完還不能跑 → no_card / no_credit;查不到 → null",
      S.every((s) => [true, false].every((a) => { const v = back(s, a); return v === null || EVENTS.acct_card_back.state.includes(v); }))
      && back({ can_run: true }, true) === "ready" && back({ can_run: false, reason: "NO_CARD" }, true) === null && back({ can_run: false, reason: "NO_CREDIT" }, false) === "no_credit" && back({ can_run: false }, false) === "no_card" && back(null, false) === null);
    globalThis.acctBackState = back;   // acctBackNote 切出來跑時要叫得到它
    const note = fnOf(appSrc9, "acctBackNote"), RUN = { can_run: true }, NOCARD = { can_run: false, reason: "NO_CARD" };
    t("acctBackNote:沒按過 → 不記;回前景那次照 acctBackState;記過「還不能跑」(owe)之後查到能跑就補 ready、還不能跑 / 查不到不記;按了還沒回前景也不記",
      note(null, RUN, false) === null && note({ back: true }, NOCARD, true) === null && note({ back: true }, NOCARD, false) === "no_card" && note({ back: true }, RUN, true) === "ready"
      && note({ back: false, owe: true }, RUN, false) === "ready" && note({ back: false, owe: true }, NOCARD, false) === null && note({ back: false, owe: true }, null, false) === null
      && note({ back: false }, RUN, false) === null);
    t("acct_card_back 接線:記過還不能跑 → owe;acctPaint(dataTurnEnd 也走這裡)補 ready、回前景那次留給 acctCheck 算完 again",
      /acctGone = back === "ready" \? null : \{ back: false, owe: true \};/.test(appSrc9)
      && /if \(!s\) return;[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*if \(acctGone && !acctGone\.back\) acctBackTrack\(false\);/.test(appSrc9)
      && /else acctRetry = 0;\n\s*acctBackTrack\(again\);\n\}/.test(appSrc9)
      && /if \(fresh && hasToken\) \{ acct = fresh; acctPaint\(\); \}/.test(appSrc9));
    const T = [[{ flow: "credit" }, "API Error: 402 {}", "402"], [{ flow: "blave" }, "Failed to authenticate. API Error: 403 x", "403"], [null, "API Error: 429 {\"type\":\"error\"}", "429"],
      [null, "Failed to authenticate. API Error: 429 x", "429"], [null, "API Error: 500 Internal", "other"], [{ flow: "local", kind: "claude" }, "Not logged in · Please run /login", null],
      [null, "你問的 API Error: 402 是交易所回的", null], [null, "BTC 今天漲了 3%", null], [{ limit: true }, "You've hit your session limit · resets 1:50pm", null],
      [{ cap: true, text: "ak.f.cap" }, "API Error: 429 {\"error\":{\"message\":\"turn usage limit reached\"}}", "cap"], [{ text: "ak.f.rate" }, "API Error: 429 x", "429"]];
    t("turnFailOf:402 / 403 跟 classifyFault、自帶金鑰的每輪上限 → cap(供應商 429 照舊 429)、429 另認、其他 API Error 開頭 → other、回覆裡提到 API Error(沒錨在開頭)不算", T.every(([f, txt, want]) => fail(f, txt) === want) && T.every(([f, txt]) => { const v = fail(f, txt); return v === null || EVENTS.turn_failed.reason.includes(v); }));
    t("回合結束:自帶金鑰這一輪收過 llm_cap、沒按停止 → turn_failed 記 cap(上限那句走 error chunk、turnFailOf 看不到時也一樣),要在送出之前",
      /if \(!stopped && cur === "apikey" && turnCap\) turnFail = "cap";/.test(appSrc9) && appSrc9.indexOf('turnCap) turnFail = "cap";') < appSrc9.indexOf('trackEvent("turn_failed"'));
    t("回合結束:faulted 或認到原因才送 turn_failed(按停止不送);AGENT_BIN_MISSING → engine_missing、沒認到 → other;送完清掉",
      /busyEnd\(faulted\);\n\s*if \(!stopped && \(faulted \|\| turnFail\)\) trackEvent\("turn_failed", \{ reason: \/AGENT_BIN_MISSING\/\.test\(r\.errTail \|\| ""\) \? "engine_missing" : turnFail \|\| "other" \}\);\n\s*turnFail = null;/.test(appSrc9));
    t("first_reply_done 只在畫進回覆泡泡、而且那段不是錯誤字串時送(分類過的錯誤卡在前面就 return 了)", /turnGotReply = true;\n\s*if \(!fail\) trackEvent\("first_reply_done", \{ kind: cur \}\);/.test(appSrc9)
      && appSrc9.indexOf("const fail = turnFailOf(f, text);") < appSrc9.indexOf("if (f) { faultShown = true;"));
    t("libBlockedWhy:閘門態才算被擋(signedOut / noData 的 why / 雲端停了或過期);忙碌、下載中、可用 → null",
      why({ state: "signedOut" }) === "signed_out" && ["no_card", "no_balance", "unknown"].every((w) => why({ state: "noData", why: w }) === w) && why({ state: "stopped" }) === "cloud_off" && why({ state: "stale" }) === "cloud_off"
      && ["busy", "pending", "buying", "free", "owned", "paid", "installed"].every((st) => why({ state: st }) === null)
      && /why: state === "noData" \? g : null/.test(libSrc9) && /if \(c\.dataAccess === "none"\) return c\.why === "no_card" \|\| c\.why === "no_balance" \? c\.why : "unknown";\n  return "unknown";/.test(libSrc9));
    t("lib_blocked 送出點:點進詳情(libShowDetail,使用者的點擊)與「使用」送出後引擎不能跑;不在 render(libPaintCta)",
      /libPaint\(\); \$\("lib-body"\)\.scrollTop = 0;\n\s*const s = libFind\(id\); if \(s\) libBlocked\(libBlockedWhy\(libCtaOf\(s\)\)\);/.test(libSrc9) && !/libBlocked/.test(libSrc9.slice(libSrc9.indexOf("function libPaintCta("), libSrc9.indexOf("function libAsk("))));
    // 主行程接線:track-event 只收自家頁面 + FROM_RENDERER;plan_start_res 的對照;updater 的 onFail
    const main9 = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"), pre9 = fs.readFileSync(path.join(__dirname, "..", "shell", "preload.js"), "utf8");
    t("接線:preload trackEvent → send(\"track-event\");主行程 fromOurPage 且在 FROM_RENDERER 才 tm().track",
      /trackEvent: \(ev, props\) => ipcRenderer\.send\("track-event", ev, props\),/.test(pre9)
      && /ipcMain\.on\("track-event", \(e, ev, props\) => \{ if \(fromOurPage\(e\) && require\("\.\/telemetry"\)\.FROM_RENDERER\.includes\(ev\)\) tm\(\)\.track\(ev, props\); \}\);/.test(main9));
    const pm = /tm\(\)\.track\("plan_start_res", \{ result: ([^\n]*) \}\);/.exec(main9), map = pm ? new Function("r", "return " + pm[1]) : null;
    t("plan_start_res:{state} → ok、NO_CARD / NO_CREDIT 照名、其餘(舊登入、限速、伺服器)→ error",
      !!map && map({ state: "starting" }) === "ok" && map({ error: "NO_CARD" }) === "no_card" && map({ error: "NO_CREDIT" }) === "no_credit" && ["APP_SECRET_REQUIRED", "RATE_LIMITED", "INVALID_CREDENTIALS", "SERVER"].every((c) => map({ error: c }) === "error")
      && /ipcMain\.handle\("plan-start", \(e\) => \(fromOurPage\(e\) \? planStart\(\)\.then\(\(r\) => \{/.test(main9));
    t("updater 接到 update_failed", /onFail: \(stage\) => tm\(\)\.track\("update_failed", \{ stage \}\),/.test(main9));
    const { createUpdater } = require("../shell/updater.js"), stages = [];
    const mkAu = (rejectCheck) => { const h = {}; return { h, on: (ev, fn) => { h[ev] = fn; }, setFeedURL: () => {}, checkForUpdates: () => (rejectCheck ? Promise.reject(new Error("offline")) : Promise.resolve()), quitAndInstall: () => {} }; };
    const au = mkAu(false), nat = { on: (ev, fn) => { au.h["native:" + ev] = fn; } };
    const up = createUpdater({ autoUpdater: au, nativeUpdater: nat, feedUrl: "https://x/", currentVersion: "0.1.9", isTrading: () => false, onState: () => {}, setTimer: () => {}, onFail: (s) => stages.push(s) }); up.start();
    au.h["checking-for-update"](); au.h.error(new Error("x"));
    au.h["update-available"]({ version: "0.2.0" }); au.h.error(new Error("x"));
    au.h["update-available"]({ version: "0.2.0" }); au.h["update-downloaded"]({ version: "0.2.0" }); au.h.error(new Error("x"));
    au.h["update-available"]({ version: "0.2.0" }); au.h["update-downloaded"]({ version: "0.2.0" }); au.h["native:update-downloaded"](); au.h.error(new Error("x"));
    const au2 = mkAu(true), up2 = createUpdater({ autoUpdater: au2, feedUrl: "https://x/", currentVersion: "0.1.9", isTrading: () => false, onState: () => {}, setTimer: () => {}, onFail: (s) => stages.push(s) }); up2.start(); up2.check(); await tick();
    const up3 = createUpdater({ autoUpdater: mkAu(true), feedUrl: "https://x/", currentVersion: "0.1.9", isTrading: () => false, onState: () => {}, setTimer: () => {}, onFail: () => { throw new Error("boom"); } }); up3.start();
    t("update_failed 的階段取自出錯那一刻:查 feed → check、下載中 → download、驗章暫存 → staging、已暫存 → install;check() 被拒 → check;onFail 丟例外不影響更新",
      stages.join() === "check,download,staging,install,check" && stages.every((s) => EVENTS.update_failed.stage.includes(s)) && up3.check() === true && (await tick(), up3.state().phase === "error"));
    { const au4 = mkAu(false), st4 = []; au4.checkForUpdates = () => { au4.h.error(new Error("offline")); return Promise.reject(new Error("offline")); };
      const up4 = createUpdater({ autoUpdater: au4, feedUrl: "https://x/", currentVersion: "0.1.9", isTrading: () => false, onState: () => {}, setTimer: () => {}, onFail: (s) => st4.push(s) }); up4.start(); up4.check(); await tick();
      t("查 feed 失敗時 electron-updater 先 emit error 再 reject:update_failed 只記一則 check", st4.join() === "check" && up4.state().phase === "error"); }
    // ── 每日在線心跳 heartbeat:app 一直開著不重開的人沒有 app_open ──
    t("heartbeat:一個屬性 live: on / off、名字 ≤16 字、每日一則不分值(DAILY + DAILY_ONE)、畫面送不了",
      JSON.stringify(EVENTS.heartbeat) === '{"live":["on","off"]}' && /const DAILY = \[[^\]]*"heartbeat"/.test(tmSrc9) && /const DAILY_ONE = \["heartbeat"\];/.test(tmSrc9) && !FROM_RENDERER.includes("heartbeat"));
    { let clock = Date.UTC(2026, 8, 29, 23, 59, 0), live = "off", boom = false, reads = 0;
      const dirH = fs.mkdtempSync(path.join(TMP_ROOT, "d-")), h = mk(dirH, { now: () => clock, heartbeatMs: 5, heartbeat: () => { reads++; if (boom) throw new Error("status boom"); return { live, secret: "SECRET" }; } });
      h.tm.start(); h.tm.start(); await new Promise((r) => setTimeout(r, 40));
      const beats = () => h.sent.filter((b) => b.event === "heartbeat");
      t("啟動就排計時器(只排一次;start 叫兩次也一樣):當天第一則送出,props 只有 live", beats().length === 1 && JSON.stringify(beats()[0].props) === '{"live":"off"}');
      live = "on"; await new Promise((r) => setTimeout(r, 40));
      t("同一個 UTC 日 live 變了也不再送(一天一則)", beats().length === 1);
      t("當天送過之後計時器不再讀下單狀態(heartbeat() 只在會出門的那一輪叫)", reads === 1);
      clock += 2 * 60 * 1000; await new Promise((r) => setTimeout(r, 40));
      t("換日:再送一則,live 是那一刻的", beats().length === 2 && beats()[1].props.live === "on");
      boom = true; clock += 24 * 3600 * 1000; await new Promise((r) => setTimeout(r, 40));
      t("讀下單狀態丟例外:不炸、那一輪不送", beats().length === 2);
      boom = false; h.tm.setEnabled(false); const readsOff = reads; await new Promise((r) => setTimeout(r, 40));
      t("關掉追蹤:心跳也不送,也不讀下單狀態", beats().length === 2 && reads === readsOff);
      const plain = mk(fs.mkdtempSync(path.join(TMP_ROOT, "d-")), { heartbeatMs: 5 }); plain.tm.start(); await new Promise((r) => setTimeout(r, 30));
      t("沒給 heartbeat 選項:不排心跳", !plain.sent.some((b) => b.event === "heartbeat")); }
    t("main.js:tm() 帶 heartbeat,live 用 tradeMaybeLive(同 updater 的 isTrading)", /heartbeat: \(\) => \(\{ live: tradeMaybeLive\(\) \? "on" : "off" \}\),/.test(main9));
  }

  // ── 0.1.12 引擎安裝(shell/enginesetup.js,主行程送):一個 prop、值是列舉、16 字以內、每日去重、畫面送不了 ──
  { const ENG = { engine_setup: ["result", ["first_done", "first_net", "first_other", "first_timeout", "upd_done", "upd_net", "upd_other", "upd_timeout"]],
      engine_opt_fail: ["result", ["us_net", "us_other", "us_timeout"]] };
    const tmSrc12 = fs.readFileSync(path.join(__dirname, "..", "shell", "telemetry.js"), "utf8");
    t("engine_setup / engine_opt_fail:一個屬性 result、值逐字照設計稽核定稿、名字與值都在 16 字以內", Object.keys(ENG).every((ev) => EVENTS[ev] && JSON.stringify(Object.keys(EVENTS[ev])) === '["result"]' && JSON.stringify(EVENTS[ev].result) === JSON.stringify(ENG[ev][1]) && ev.length <= 16 && ENG[ev][1].every((v) => v.length <= 16)));
    t("…每日去重(DAILY)、不是 once、畫面送不了(不在 FROM_RENDERER)", Object.keys(ENG).every((ev) => new RegExp('const DAILY = \\[[^\\]]*"' + ev + '"').test(tmSrc12) && !new RegExp('const ONCE = \\[[^\\]]*"' + ev + '"').test(tmSrc12) && !FROM_RENDERER.includes(ev)));
    const main12 = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"), eng12 = fs.readFileSync(path.join(__dirname, "..", "shell", "enginesetup.js"), "utf8"), engR = fs.readFileSync(path.join(R, "engine.js"), "utf8");
    t("…送出點:enginesetup 的結束(done / fail,relink 不送)與美股那組失敗;main 把 track 接到 tm();重試鈕送 feature_used engine_retry",
      /track: \(ev, props\) => tm\(\)\.track\(ev, props\)/.test(main12) && /if \(S\.kind !== "relink"\) track\("engine_setup", kindTag\(\) \+ "_done"\);/.test(eng12)
      && /if \(S\.kind !== "relink" && !e\.aborted\) track\("engine_setup", kindTag\(\) \+ "_" \+ S\.err\.kind\);/.test(eng12) && /track\("engine_opt_fail", g\.id \+ "_" \+ S\.warn\.kind\);/.test(eng12)
      && /function engRetry\(\) \{\s*trackFeature\("engine_retry"\);/.test(engR));
    const apiPy12 = path.join(process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), "openclaw", "desktop_telemetry.py");
    if (!fs.existsSync(apiPy12)) console.log("SKIP  api 端引擎事件比對(需要 monorepo 版面)");
    else { const api = fs.readFileSync(apiPy12, "utf8"), got = {};
      for (const m of api.matchAll(/"([a-z_]+)": \{"props": \{"([a-z_]+)": \(([^()]*)\)\}, "once": (True|False)\}/g)) got[m[1]] = { key: m[2], vals: [...m[3].matchAll(/"([^"]+)"/g)].map((v) => v[1]), once: m[4] === "True" };
      t("api desktop_telemetry.EVENTS 的 engine_setup / engine_opt_fail = 外殼這份(屬性名、值、順序、不是 once)", Object.keys(ENG).every((ev) => got[ev] && got[ev].key === "result" && JSON.stringify(got[ev].vals) === JSON.stringify(ENG[ev][1]) && got[ev].once === false)); } }
  // ── 0.1.13 策略庫轉換(spec-0.1.13-library-conversion §8;renderer 送):一個 prop、值是列舉、16 字以內、每日去重、畫面送得了 ──
  { const N13 = { lib_pick: ["data", ["none", "required", "unknown"]], idea_sent: ["from", ["welcome", "lib_head", "lib_empty"]] };
    const tmSrc13 = fs.readFileSync(path.join(__dirname, "..", "shell", "telemetry.js"), "utf8");
    t("lib_pick / idea_sent:一個屬性、值逐字照 spec §8、名字與值都在 16 字以內", Object.keys(N13).every((ev) => EVENTS[ev] && JSON.stringify(Object.keys(EVENTS[ev])) === JSON.stringify([N13[ev][0]]) && JSON.stringify(EVENTS[ev][N13[ev][0]]) === JSON.stringify(N13[ev][1]) && ev.length <= 16 && N13[ev][1].every((v) => v.length <= 16)));
    t("…每日去重(DAILY)、不是 once、畫面送得了(在 FROM_RENDERER)", Object.keys(N13).every((ev) => new RegExp('const DAILY = \\[[^\\]]*"' + ev + '"').test(tmSrc13) && !new RegExp('const ONCE = \\[[^\\]]*"' + ev + '"').test(tmSrc13) && FROM_RENDERER.includes(ev)));
    const x13 = mk(fs.mkdtempSync(path.join(TMP_ROOT, "d-")));
    t("…每個值都送得出去;表外的值 / 塞內容不送", Object.keys(N13).every((ev) => N13[ev][1].every((v) => x13.tm.track(ev, { [N13[ev][0]]: v, title: "SECRET" }) === true)) && Object.keys(N13).every((ev) => x13.tm.track(ev, { [N13[ev][0]]: "SECRET_TITLE" }) === false)); await tick();
    t("…出門的 props 各只有那一格", x13.sent.filter((b) => N13[b.event]).length === 6 && x13.sent.every((b) => !JSON.stringify(b).includes("SECRET")));
    const lib13 = fs.readFileSync(path.join(R, "library.js"), "utf8"), ns13 = fs.readFileSync(path.join(R, "newstrategy.js"), "utf8");
    t("…送出點:lib_pick 只在本機 submitMessage 回 ok 那一支(值來自 libPickData);idea_sent 在找點子框送出成功、關框之後;都包 try",
      /if \(ok\) \{[\s\S]*?if \(local\) \{ try \{ window\.blave\.trackEvent\("lib_pick", \{ data: libPickData\(s\) \}\); \} catch \(_\) \{ \} \}/.test(lib13) && (lib13.match(/trackEvent\("lib_pick"/g) || []).length === 1
      && /ideaClose\(\);[\s\S]*try \{ window\.blave\.trackEvent\("idea_sent", \{ from \}\); \} catch \(_\) \{ \}/.test(ns13) && (ns13.match(/trackEvent\("idea_sent"/g) || []).length === 1);
    t("…feature_used 的兩個名字:lib_installed 在本機認到新策略與雲端認到(libTurnEnd 兩處 + libCloudChanged)、library_no_new 只在本機沒新策略", (lib13.match(/libTrack\("lib_installed"\)/g) || []).length === 3 && (lib13.match(/libTrack\("library_no_new"\)/g) || []).length === 1);
    const apiPy13 = path.join(process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), "openclaw", "desktop_telemetry.py");
    if (!fs.existsSync(apiPy13)) console.log("SKIP  api 端 0.1.13 事件比對(需要 monorepo 版面)");
    else { const api = fs.readFileSync(apiPy13, "utf8"), got = {};
      for (const m of api.matchAll(/"([a-z_]+)": \{"props": \{"([a-z_]+)": \(([^()]*)\)\}, "once": (True|False)\}/g)) got[m[1]] = { key: m[2], vals: [...m[3].matchAll(/"([^"]+)"/g)].map((v) => v[1]), once: m[4] === "True" };
      t("api desktop_telemetry.EVENTS 的 lib_pick / idea_sent = 外殼這份(屬性名、值、順序、不是 once)", Object.keys(N13).every((ev) => got[ev] && got[ev].key === N13[ev][0] && JSON.stringify(got[ev].vals) === JSON.stringify(N13[ev][1]) && got[ev].once === false)); } }
  // ── 0.1.15 偵測失敗(renderer 送,只在連結畫面偵測完時;值由主行程 detectWhy 判)──
  { const WHY = ["claude_none", "claude_timeout", "claude_nonzero", "claude_badjson", "codex_none", "codex_shim", "codex_timeout", "codex_nonzero"];
    const tmSrc15 = fs.readFileSync(path.join(__dirname, "..", "shell", "telemetry.js"), "utf8"), mainSrc15 = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
    t("detect_fail:一個屬性 why、值逐字照 Wei 拍板的八個、名字與值都在 16 字以內", !!EVENTS.detect_fail && JSON.stringify(Object.keys(EVENTS.detect_fail)) === '["why"]' && JSON.stringify(EVENTS.detect_fail.why) === JSON.stringify(WHY) && WHY.every((v) => v.length <= 16));
    t("…每日去重(DAILY)、不是 once、畫面送得了(在 FROM_RENDERER)", /const DAILY = \[[^\]]*"detect_fail"/.test(tmSrc15) && !/const ONCE = \[[^\]]*"detect_fail"/.test(tmSrc15) && FROM_RENDERER.includes("detect_fail"));
    const x15 = mk(fs.mkdtempSync(path.join(TMP_ROOT, "d-")));
    t("…每個值都送得出去、同日同值不重送;表外的值 / 塞路徑不送", WHY.every((v) => x15.tm.track("detect_fail", { why: v, path: "SECRET" }) === true) && x15.tm.track("detect_fail", { why: "codex_shim" }) === false
      && x15.tm.track("detect_fail", { why: "C:\\SECRET" }) === false); await tick();
    t("…出門的 props 只有 why", x15.sent.filter((b) => b.event === "detect_fail").length === 8 && x15.sent.every((b) => !JSON.stringify(b).includes("SECRET")));
    // 主行程算值的 detectWhy:每種偵測紀錄的輸出都在列舉裡、能用時 null
    const dw = mainSrc15.match(/^function detectWhy\(kind, r\) \{[\s\S]*?\n\}/m);
    if (!dw) t("main.js 找得到 detectWhy", false);
    else { const detectWhy = new Function(dw[0] + "; return detectWhy;")();
      const cases = [["claude", { bin: "none" }, "claude_none"], ["claude", { bin: "none", where: ["shim"] }, "claude_none"], ["codex", { bin: "none" }, "codex_none"],
        ["codex", { bin: "none", where: ["shim"] }, "codex_shim"], ["codex", { bin: "none", where: ["shim", "cmd"], found: "cmd" }, "codex_shim"],
        ["claude", { bin: "exe", timedOut: true, code: null }, "claude_timeout"], ["codex", { bin: "exe", timedOut: true, code: null }, "codex_timeout"],
        ["claude", { bin: "posix", code: 1, timedOut: false, json: false }, "claude_badjson"], ["claude", { bin: "posix", code: 0, timedOut: false, loggedIn: false }, "claude_nonzero"],
        ["codex", { bin: "chatgpt", code: 1, timedOut: false, loggedIn: false }, "codex_nonzero"], ["codex", { bin: "exe", code: "ENOENT", timedOut: false }, "codex_nonzero"],
        ["claude", { bin: "exe", code: 0, loggedIn: true }, null], ["codex", { bin: "posix", code: 0, loggedIn: true }, null]];
      const bad = cases.filter(([k, r, want]) => detectWhy(k, r) !== want);
      t("detectWhy:沒檔 / 只有 shim / 逾時 / 不是 JSON / 回答沒登入 各對到一個值,能用回 null;輸出全在列舉裡", bad.length === 0 && cases.every(([k, r]) => { const v = detectWhy(k, r); return v === null || WHY.includes(v); }), bad); }
    t("…detectAgents 把 detectWhy 放進回傳(why),畫面在連結畫面偵測完、每個有 why 的 CLI 各送一則",
      /out\.claude\.why = detectWhy\("claude", rec\.claude\); out\.codex\.why = detectWhy\("codex", rec\.codex\);/.test(mainSrc15)
      && /if \(!\$\("view-connect"\)\.hidden\) \["claude", "codex"\]\.forEach\(\(k\) => \{ if \(lastDetect\[k\] && lastDetect\[k\]\.why\) trackEvent\("detect_fail", \{ why: lastDetect\[k\]\.why \}\); \}\);/.test(fs.readFileSync(path.join(R, "app.js"), "utf8")));
    const apiPy15 = path.join(process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), "openclaw", "desktop_telemetry.py");
    if (!fs.existsSync(apiPy15)) console.log("SKIP  api 端 detect_fail 比對(需要 monorepo 版面)");
    else { const api = fs.readFileSync(apiPy15, "utf8"), got = {};
      for (const m of api.matchAll(/"([a-z_]+)": \{"props": \{"([a-z_]+)": \(([^()]*)\)\}, "once": (True|False)\}/g)) got[m[1]] = { key: m[2], vals: [...m[3].matchAll(/"([^"]+)"/g)].map((v) => v[1]), once: m[4] === "True" };
      t("api desktop_telemetry.EVENTS 的 detect_fail = 外殼這份(屬性名、值、順序、不是 once)", !!got.detect_fail && got.detect_fail.key === "why" && JSON.stringify(got.detect_fail.vals) === JSON.stringify(WHY) && got.detect_fail.once === false); } }
  // ── 0.1.18 策略三步(主行程送;kinds 由 runtime/local_daemon.strategy_kinds 寫進狀態檔)──
  { const { STRAT_KINDS, STRAT_MARKETS } = require("../shell/telemetry.js");
    const tmSrc18 = fs.readFileSync(path.join(__dirname, "..", "shell", "telemetry.js"), "utf8"), mainSrc18 = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
    const SE = ["strat_created", "strat_backtested", "strat_deployed"];
    const MK = ["crypto", "tw_idx_fut", "tw_stk_fut", "tw_stock", "us_stock", "global_fut", "mixed", "unk"];
    const WANT = ["A", "B", "C", "unk"].flatMap((ty) => MK.map((m) => ty + "." + m));
    t("strat_*:三個事件、一個屬性 kind、值 = 型別 4 × 市場 8(逐序)、名字與值都 ≤16 字、值裡沒有 api dedupe_key 的分隔符 :",
      JSON.stringify(STRAT_KINDS) === JSON.stringify(WANT) && SE.every((ev) => ev.length <= 16 && JSON.stringify(EVENTS[ev]) === JSON.stringify({ kind: WANT })) && WANT.every((v) => v.length <= 16 && v.indexOf(":") < 0));
    t("…市場短碼對照涵蓋 runtime strategy_market 的七個值(另加 unk)",
      JSON.stringify(Object.keys(STRAT_MARKETS)) === JSON.stringify(["crypto", "tw_index_futures", "tw_stock_futures", "tw_stock", "us_stock", "global_futures", "mixed"])
      && JSON.stringify(Object.values(STRAT_MARKETS).concat("unk")) === JSON.stringify(MK));
    // runtime 那份市場清單(strategy_reporter._PRICE_FETCHERS 的值 + 兩個台指期分支 + mixed)跟外殼的對照表沒有漏
    { const rp = fs.readFileSync(path.join(__dirname, "..", "runtime", "strategy_reporter.py"), "utf8");
      const fet = rp.match(/_PRICE_FETCHERS = \{([\s\S]*?)\n\}/), vals = new Set(fet ? [...fet[1].matchAll(/: "([a-z_]+)"/g)].map((m) => m[1]) : []);
      ["tw_index_futures", "tw_stock_futures", "mixed"].forEach((v) => vals.add(v));
      t("…runtime strategy_market 會回的每個值都在外殼對照表裡(新增市場時這格紅)", vals.size === 7 && [...vals].every((v) => Object.prototype.hasOwnProperty.call(STRAT_MARKETS, v)), [...vals]); }
    t("…每日去重(DAILY)、不是 once、畫面送不了(不在 FROM_RENDERER)", SE.every((ev) => new RegExp('const DAILY = \\[[^\\]]*"' + ev + '"').test(tmSrc18) && !new RegExp('const ONCE = \\[[^\\]]*"' + ev + '"').test(tmSrc18) && !FROM_RENDERER.includes(ev)));
    t("main.js:strategies 讀 daemon 狀態檔的 strategy_kinds", /strategies: \(\) => \(_tradeHost \? \(\(_tradeHost\.status\(\)\.report \|\| \{\}\)\.strategy_kinds \|\| null\) : null\),/.test(mainSrc18));
    const apiPy18 = path.join(process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), "openclaw", "desktop_telemetry.py");
    if (!fs.existsSync(apiPy18)) console.log("SKIP  api 端 strat_* 比對(需要 monorepo 版面)");
    else { const api = fs.readFileSync(apiPy18, "utf8"), m = api.match(/^STRATEGY_KINDS = \(([^()]*)\)/m);
      const apiKinds = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((v) => v[1]) : null;
      t("api STRATEGY_KINDS = 外殼 STRAT_KINDS(逐值逐序)", JSON.stringify(apiKinds) === JSON.stringify(STRAT_KINDS));
      t("api EVENTS 的三個 strat_* = kind: STRATEGY_KINDS、不是 once", SE.every((ev) => new RegExp('^    "' + ev + '": \\{"props": \\{"kind": STRATEGY_KINDS\\}, "once": False\\},$', "m").test(api))); }

    // 行為:一個假的狀態檔序列,看出門的事件
    const K = (type, market, bt, funded) => ({ type, market, bt, funded });
    const dirS = fs.mkdtempSync(path.join(TMP_ROOT, "d-")); let clockS = Date.UTC(2026, 9, 7, 3, 0, 0);
    let x = mk(dirS, { now: () => clockS }); x.tm.installId();   // 先讓狀態檔存在
    t("kinds 是 null / 不是物件:整輪跳過、不 seed", x.tm.strategySteps(null) === 0 && x.tm.strategySteps([]) === 0 && x.tm.strategySteps("x") === 0 && JSON.parse(fs.readFileSync(path.join(dirS, "telemetry.json"), "utf8")).strat === null);
    const exist = { old_momo_SECRET: K("A", "crypto", true, true), old_draft: K(null, null, false, false) };
    t("第一次拿到 kinds(升級那一刻):存量全記成送過、一則都不送", x.tm.strategySteps(exist) === 0 && (await tick(), x.sent.length === 0));
    const j0 = JSON.parse(fs.readFileSync(path.join(dirS, "telemetry.json"), "utf8")).strat;
    t("…狀態檔記的是雜湊(16 hex)不是名字;已到的步驟才記", j0.created.length === 2 && j0.backtested.length === 1 && j0.deployed.length === 1 && j0.created.every((h) => /^[0-9a-f]{16}$/.test(h)) && !JSON.stringify(j0).includes("momo"));
    t("…再看一次同一份:不送", x.tm.strategySteps(exist) === 0);
    x = mk(dirS, { now: () => clockS });   // 重開 app:讀回狀態檔
    const s1 = { ...exist, tx_trend_SECRET: K("A", "tw_index_futures", false, false) };
    t("重開後新的一支:送 strat_created kind=A.tw_idx_fut", x.tm.strategySteps(s1) === 1); await tick();
    t("…出門的只有 kind、沒有名字", x.sent.length === 1 && x.sent[0].event === "strat_created" && JSON.stringify(x.sent[0].props) === '{"kind":"A.tw_idx_fut"}' && !JSON.stringify(x.sent[0]).includes("SECRET") && !JSON.stringify(x.sent[0]).includes("tx_trend"));
    t("…同一支再看一次:不送", x.tm.strategySteps(s1) === 0);
    s1.tx_trend_SECRET = K("A", "tw_index_futures", true, false);
    t("同一支回測好了:送 strat_backtested", x.tm.strategySteps(s1) === 1); await tick();
    s1.tx_trend_SECRET = K("A", "tw_index_futures", true, true);
    t("配了錢:送 strat_deployed;已送過的兩步不重送", x.tm.strategySteps(s1) === 1); await tick();
    t("…三則依序", x.sent.map((b) => b.event + "=" + b.props.kind).join() === "strat_created=A.tw_idx_fut,strat_backtested=A.tw_idx_fut,strat_deployed=A.tw_idx_fut");
    // 同日同 kind 的第二支:api 只會留一列,外殼不再出門、直接記成送過
    const s2 = { ...s1, eth_SECRET: K("A", "crypto", false, false), btc_SECRET: K("A", "crypto", false, false) };
    const n2 = x.tm.strategySteps(s2); await tick();
    t("同一輪兩支同 kind:只出門一則(第二支等那則記好)", n2 === 1 && x.sent.length === 4 && x.sent[3].props.kind === "A.crypto");
    t("…下一輪:第二支直接記成送過、不出門", x.tm.strategySteps(s2) === 0 && x.sent.length === 4 && x.tm.strategySteps(s2) === 0);
    clockS += 24 * 3600 * 1000;
    t("換日之後已記的不會再送", x.tm.strategySteps(s2) === 0);
    // 型別 / 市場判不出來、或不在表上 → unk
    const s3 = { ...s2, a_SECRET: K(null, null, false, false), b_SECRET: K("C", "us_stock", false, false), c_SECRET: K("Z", "BTCUSDT", false, false), d_SECRET: K("B", "constructor", false, false) };
    x.tm.strategySteps(s3); await tick(); x.tm.strategySteps(s3); await tick();
    t("判不出來 / 表外的值 → unk;出門的 kind 全在列舉裡", JSON.stringify(x.sent.slice(4).map((b) => b.props.kind).sort()) === JSON.stringify(["B.unk", "C.us_stock", "unk.unk"]) && x.sent.every((b) => STRAT_KINDS.includes(b.props.kind)));
    // 關著時發生的:記成送過,重新打開不補
    x.tm.setEnabled(false);
    const s4 = { ...s3, off_SECRET: K("B", "crypto", false, false) };
    const before = x.sent.length;
    t("關掉追蹤時新的一支:不送", x.tm.strategySteps(s4) === 0);
    x.tm.setEnabled(true); await tick();
    t("…重新打開:不補送那一支(只補啟動那兩則)", x.tm.strategySteps(s4) === 0 && (await tick(), x.sent.slice(before).every((b) => b.event === "app_first_open" || b.event === "app_open")));
    // 送不出去(離線)下一輪再試;有回應(含 4xx)就記
    let mode = "down"; const sentF = [];
    const f = createTelemetry({ dir: fs.mkdtempSync(path.join(TMP_ROOT, "d-")), endpoint: "https://x/t", appVersion: "0.3.1", osVersion: "15.5", lang: "zh-TW",
      post: (u, b) => { sentF.push(b); return mode === "down" ? Promise.reject(new Error("offline")) : Promise.resolve({ status: mode === "400" ? 400 : 200 }); } });
    f.strategySteps({});
    const sf = { n1_SECRET: K("A", "crypto", false, false) };
    f.strategySteps(sf); await tick(); f.strategySteps(sf); await tick();
    t("離線:每一輪都再試(沒記)", sentF.length === 2);
    mode = "400"; f.strategySteps(sf); await tick();
    t("api 回 400(例如 api 還沒上這個事件):記成送過,不再重送", sentF.length === 3 && f.strategySteps(sf) === 0 && (await tick(), sentF.length === 3));
    // 計時器:start() 排一次,讀 opts.strategies()
    let calls = 0;
    const tmr = mk(fs.mkdtempSync(path.join(TMP_ROOT, "d-")), { strategies: () => { calls++; return null; }, strategiesMs: 10 });
    tmr.tm.start(); tmr.tm.start(); await new Promise((r) => setTimeout(r, 55));
    t("start() 排計時器讀 strategies()(重複 start 不重排)", calls >= 3 && calls <= 6, calls); }
  console.log(red ? red + " 紅" : "ALL PASS");
} finally { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); }
  process.exit(red ? 1 : 0);
})();
