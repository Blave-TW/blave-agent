// shell/telemetry.js:只有七個事件、屬性只有列舉、關掉就一則都不送、送不出去不炸。
// 跑法:node tests/check_shell_telemetry.js
const fs = require("fs"), os = require("os"), path = require("path");
const { createTelemetry, EVENTS } = require("../shell/telemetry.js");
const ONCE_OF = (fsx) => !/const ONCE = \[[^\]]*feature_used/.test(fsx.readFileSync(path.join(__dirname, "..", "shell", "telemetry.js"), "utf8"));
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const tick = () => new Promise((r) => setTimeout(r, 5));
const mk = (dir, extra = {}) => { const sent = []; const tm = createTelemetry({ dir, endpoint: "https://x/t", appVersion: "0.3.1", osVersion: "15.5", lang: "zh-TW",
  post: (u, b) => { sent.push(b); return Promise.resolve({ status: 200 }); }, ...extra }); return { tm, sent }; };
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blave-tm-"));
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
  t("八個事件、沒有自由文字型的屬性", Object.keys(EVENTS).length === 8 && Object.values(EVENTS).every((s) => s === null || Object.values(s).every(Array.isArray)));

  let tok = mk(dir, { getToken: () => "acct-abc" }); tok.tm.track("login_done"); await tick();
  t("有 token 才帶 token(放 body)", tok.sent[0].token === "acct-abc" && sent.every((b) => !("token" in b)));

  tm.setEnabled(false);
  const off = mk(dir); off.tm.start(); await tick();
  t("關掉:一則都不送、重開仍是關", off.tm.track("trade_started", { venue_kind: "paper" }) === false && off.sent.length === 0 && off.tm.isEnabled() === false);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "blave-tm-"));
  const pre = mk(dir2); pre.tm.setEnabled(false); pre.tm.start(); await tick();
  t("新安裝先關掉:連 app_first_open 都不送", pre.sent.length === 0);
  // 關掉那一刻已經排進去、還沒出門的也不送(track 是 fire-and-forget,post 在下一個 microtask)
  const q = mk(fs.mkdtempSync(path.join(os.tmpdir(), "blave-tm-"))); const accepted = q.tm.track("login_done"); q.tm.setEnabled(false); await tick();
  t("關掉之後一則都不送——含已排隊的", accepted === true && q.sent.length === 0);
  q.tm.setEnabled(true); await tick();
  t("重新打開立即恢復:補送這次啟動的那兩則;再開一次不重送", q.sent.map((b) => b.event).join() === "app_first_open,app_open" && (q.tm.setEnabled(true), true) && (await tick(), q.sent.length === 2));
  // 舊版狀態檔(有 noticed 欄位)照讀不壞;曾經關掉的人更新後仍是關的、install_id 不變
  const dirOld = fs.mkdtempSync(path.join(os.tmpdir(), "blave-tm-")), oid = "11111111-2222-4333-8444-555555555555";
  fs.writeFileSync(path.join(dirOld, "telemetry.json"), JSON.stringify({ install_id: oid, enabled: false, noticed: true, sent: ["app_first_open"] }));
  const oldOff = mk(dirOld); oldOff.tm.start(); await tick();
  t("舊檔 enabled:false + noticed:true → 仍是關的、一則都不送", oldOff.tm.isEnabled() === false && oldOff.sent.length === 0 && oldOff.tm.installId() === oid);
  fs.writeFileSync(path.join(dirOld, "telemetry.json"), JSON.stringify({ install_id: oid, enabled: true, noticed: false, sent: ["app_first_open"] }));
  const oldOn = mk(dirOld); oldOn.tm.start(); await tick();
  t("舊檔沒看過告知(noticed:false)但沒關 → 照預設開;寫回去的檔不再有 noticed", oldOn.sent.map((b) => b.event).join() === "app_open" && oldOn.tm.installId() === oid && (oldOn.tm.setEnabled(true), !("noticed" in JSON.parse(fs.readFileSync(path.join(dirOld, "telemetry.json"), "utf8")))));

  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "blave-tm-"));
  const boom = mk(dirB, { post: () => Promise.reject(new Error("offline")) }); boom.tm.start(); await tick();
  t("送不出去不炸", boom.tm.track("cloud_started") === true); await tick();
  const again = mk(dirB); again.tm.start(); await tick();
  t("離線的第一次啟動不吃掉 app_first_open:沒拿到 2xx 就不記帳,下次再送", again.sent.map((b) => b.event).join() === "app_first_open,app_open");
  const third = mk(dirB); third.tm.start(); await tick();
  t("…拿到 2xx 之後就不再送", third.sent.map((b) => b.event).join() === "app_open");
  const dir400 = fs.mkdtempSync(path.join(os.tmpdir(), "blave-tm-"));
  const r400 = mk(dir400, { post: () => Promise.resolve({ status: 400 }) }); r400.tm.start(); await tick();
  t("非 2xx 不記帳", JSON.parse(fs.readFileSync(path.join(dir400, "telemetry.json"), "utf8")).sent.length === 0);
  const thrower = mk(fs.mkdtempSync(path.join(os.tmpdir(), "blave-tm-")), { post: () => { throw new Error("sync boom"); } }); thrower.tm.start();
  t("post 同步丟例外也不炸", (() => { try { thrower.tm.track("cloud_started"); return true; } catch (_) { return false; } })()); await tick();
  fs.writeFileSync(path.join(dir2, "telemetry.json"), "{broken");
  const broken = mk(dir2);
  t("狀態檔壞掉:不炸、當成關(關掉的決定不能因壞檔靜默變回開)", /^[0-9a-f-]{36}$/.test(broken.tm.installId()) && broken.tm.isEnabled() === false);
  // meta 欄位過跟 api 同一組形狀;不符整則不送
  for (const [k, v] of [["lang", "my secret note"], ["lang", "zh_TW"], ["lang", "BTC-USDT"], ["appVersion", "1.0.0-dev"], ["appVersion", "1.0-BTCUSDT.long"], ["osVersion", "Darwin 25.5"]]) {
    const x = mk(fs.mkdtempSync(path.join(os.tmpdir(), "blave-tm-")), { [k]: v }); x.tm.start(); await tick();
    t(k + "=" + JSON.stringify(v) + " → 一則都不出門", x.sent.length === 0 && x.tm.track("cloud_started") === false);
  }
  for (const v of ["zh-TW", "en-US", "en", "zh-Hant-TW", "es-419"]) { const x = mk(fs.mkdtempSync(path.join(os.tmpdir(), "blave-tm-")), { lang: v }); x.tm.start(); await tick(); t("lang=" + v + " 照送", x.sent.length === 2); }
  // os 依平台(0.1.3 Windows 真機:寫死 "macos" + os_version 段長 {1,4} 擋掉 10.0.20348 這種五位 build 號 → 一則都沒出門、sent 空)
  const tmSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "telemetry.js"), "utf8");
  t("os 不再寫死:依 process.platform 對到 macos / windows / linux(這台是 " + process.platform + ")", !/os: "macos"/.test(tmSrc) && sent.length > 0 && sent.every((b) => b.os === ({ darwin: "macos", win32: "windows", linux: "linux" })[process.platform]));
  for (const v of ["10.0.20348", "10.0.19045", "10.0.26100", "15.5", "14.6.1", "26.0"]) { const x = mk(fs.mkdtempSync(path.join(os.tmpdir(), "blave-tm-")), { osVersion: v }); x.tm.start(); await tick(); t("osVersion=" + v + " 照送(Windows 五位 build 號)", x.sent.length === 2 && x.sent[0].os_version === v); }
  { const apiPy = path.join(__dirname, "..", "..", "api", "openclaw", "desktop_telemetry.py");
    if (fs.existsSync(apiPy)) { const api = fs.readFileSync(apiPy, "utf8"), pick = (src, k) => { const m = src.match(new RegExp(k + '[^\\n]*?(/|r")(\\^[^"/]+)')); return m ? m[2].replace(/\\Z$/, "$") : null; };
      t("os_version / lang / app_version 三個形狀跟 api 的 _*_RE 逐字相同(api 早已是 {1,5},外殼落後就是這次的 bug)", ["os_version", "lang", "app_version"].every((k) => pick(tmSrc, k + ":") && pick(tmSrc, k + ":") === pick(api, "_" + k.toUpperCase() + "_RE = re\\.compile\\("))); }
    else console.log("SKIP  api 不在旁邊,略過形狀比對"); }
  t("shell/package.json 的版號符合契約(不然打包版每一則都被丟)", /^[0-9]{1,4}(\.[0-9]{1,4}){1,3}(-(alpha|beta|rc)\.[0-9]{1,3})?$/.test(require("../shell/package.json").version));
  // main.js 的接線:這三件被改掉測試要紅
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
  t("main.js:開發版不送(isPackaged 閘還在)", /app\.isPackaged \|\| process\.env\.BLAVE_TELEMETRY === "1" \? postJSON/.test(mainSrc));
  t("main.js:lang 只取 app.getLocale()", /lang: app\.getLocale\(\)/.test(mainSrc) && !/lang: process\.env/.test(mainSrc));
  t("首次告知那條 IPC 退場;讀 / 切開關兩支都只收自家頁面", !/telemetry-noticed|telemetryNoticed|setNoticed/.test(mainSrc + fs.readFileSync(path.join(__dirname, "..", "shell", "preload.js"), "utf8") + fs.readFileSync(path.join(__dirname, "..", "shell", "telemetry.js"), "utf8"))
    && /ipcMain\.handle\("telemetry-get", \(e\) => \(fromOurPage\(e\)/.test(mainSrc) && /ipcMain\.handle\("telemetry-set", \(e, on\) => \{ if \(!fromOurPage\(e\)\) return false;/.test(mainSrc));

  // ── cloud_started:「送上雲端」確認框 → submitMessage(msg, { handoff: "up" }) → send-message → runTurn 成功才送。把真的那支 handler 切出來跑 ──
  const R = path.join(__dirname, "..", "shell", "renderer");
  const hoSrc = fs.readFileSync(path.join(R, "handoff.js"), "utf8"), appSrc = fs.readFileSync(path.join(R, "app.js"), "utf8");
  t("接線:確認框 onOk 帶 handoff 方向;submitMessage 原樣轉進 payload;重送(lastUserText)不帶", /submitMessage\(msg, \{ handoff: dir \}\)/.test(hoSrc)
    && /async function submitMessage\(msg, opts\)/.test(appSrc) && /message: msg, handoff: opts && opts\.handoff, model:/.test(appSrc) && !/submitMessage\(lastUserText, /.test(appSrc));
  t("主行程:標記只認 \"up\" 且旗標要開;事件掛在 runTurn 的 then(spawn + stdin 成功),不在 catch", /const cloudUp = cloudHandoffOn\(\) && payload && payload\.handoff === "up";/.test(mainSrc)
    && /runTurn\(win, payload\)\.then\(\(\) => \{ if \(cloudUp\) tm\(\)\.track\("cloud_started"\); \}\)\.catch\(/.test(mainSrc));
  const hi = mainSrc.indexOf('ipcMain.handle("send-message", async (e, payload) => {');
  const cutBody = (from) => { let d = 0; for (let k = mainSrc.indexOf("{", from); k < mainSrc.length; k++) { if (mainSrc[k] === "{") d++; else if (mainSrc[k] === "}" && --d === 0) return mainSrc.slice(mainSrc.indexOf("{", from), k + 1); } throw new Error("no send-message body"); };
  const handlerBody = cutBody(hi + 'ipcMain.handle("send-message", async (e, payload) =>'.length);
  // 每個情境一份乾淨的狀態:真的 telemetry(自己的暫存目錄)+ 只 stub 主行程那幾個外部依賴
  const scenario = async ({ flag = true, ours = true, turnOk = true, enabled = true, payload }) => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "blave-tm-")), x = mk(dir2); if (!enabled) x.tm.setEnabled(false);
    const ends = [];
    const ctx = { fromOurPage: () => ours, activeTurn: null, turnStarting: false, cloudHandoffOn: () => flag, tm: () => x.tm,
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
  t("feature_used 不是 once、name 白名單 = canon product-telemetry.md 那 24 個(0.1.6:+reports_list / reports_read / reports_ask / strategy_new;library_comm 沒送出點但 0.1.5 還在送,留到它退場)", ONCE_OF(fs) && FEATURES.length === 24 && FEATURES[0] === "report_backtest" && FEATURES[FEATURES.length - 1] === "strategy_new" && FEATURES[19] === "library_comm");
  // 兩端漂移:api/openclaw/desktop_telemetry.py 的 EVENTS["feature_used"] 逐字同一份(同 check_runtime_mirror:要 monorepo 版面)
  const apiPy = path.join(__dirname, "..", "..", "api", "openclaw", "desktop_telemetry.py");
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
  }
  t("renderer 每個 trackFeature 送出點的名字都在白名單上、都是字面(沒有拿變數當名字)", bad.length === 0 && used.size > 0);
  if (bad.length) console.log("      " + bad.join("\n      "));
  const LEGACY = ["library_comm"];   // 0.1.6 起沒送出點(社群段平鋪),但 0.1.5 舊外殼還在送、api 要繼續收、兩端順序要一致:留到 0.1.5 退場
  const noSender = FEATURES.filter((n) => !used.has(n) && LEGACY.indexOf(n) < 0);
  t("白名單上每個名字都有送出點(library_comm 例外:留給 0.1.5 舊外殼)", noSender.length === 0 && LEGACY.every((n) => FEATURES.includes(n) && !used.has(n))); if (noSender.length) console.log("      沒送出點:" + noSender.join(", "));
  t("送出點只在功能那一層:report 四個分頁在 #rp-tabs 的 click(程式自動選預設分頁不記)、下單分頁在 trSetTab、選擇策略在 psOpen、切雲端在 envSwitch、掃描在 rpRobAsk 送出成功、聊天在 started、設定兩類在 setCat、送上 / 拉回在 hoAsk 確認",
    /const RP_TAB_FEATURE = \{ bt: "report_backtest", tr: "report_trades", rob: "report_scan", code: "report_code" \};\n\$\("rp-tabs"\)\.addEventListener\("click", \(e\) => \{[^\n]*\n\s*const b = e\.target\.closest\("\.rp-tab"\); if \(b && !b\.disabled\) \{ rpShowTab\(b\.dataset\.tab\); trackFeature\(RP_TAB_FEATURE\[b\.dataset\.tab\]\); \}/.test(appSrc)
    && !/trackFeature/.test(appSrc.slice(appSrc.indexOf("function rpShowTab("), appSrc.indexOf("function rpRobOpts(")))
    && /function trSetTab\(tab, focus\) \{\n\s*TR\.tab = tab; TR\.landed = true;\n\s*trackFeature\(TR_TAB_FEATURE\[tab\]\);/.test(trSrc)
    && /trPickOff\(\)\) return;\n\s*trackFeature\("strategy_picker"\);/.test(trSrc) && /if \(env === ENV\.cur\) \{ if \(via === "link"\) head\(\); return; \}\n\s*if \(env === "cloud"\) trackFeature\("view_cloud"\);/.test(trSrc)
    && /\.then\(\(ok\) => \{ if \(ok\) trackFeature\("scan_requested"\); resolve\(ok \? turnSeq : false\); \}\)/.test(appSrc) && /if \(r\.started\) \{ busyStart\(\); trackFeature\("chat_sent"\); return true; \}/.test(appSrc)
    && /if \(cat === "src"\) \{ srcLoad\(\); trackFeature\("settings_datasrc"\); \}/.test(appSrc) && /if \(cat === "plan"\) \{ planPaint\(\); trackFeature\("settings_plan"\);/.test(appSrc)
    && /submitMessage\(msg, \{ handoff: dir \}\)[^\n]*\n\s*\.then\(\(ok\) => \{ if \(ok\) trackFeature\(dir === "up" \? "handoff_cloud" : "handoff_pull"\); \}\);/.test(hoSrc));
  // 主行程:preload 只暴露 send、主行程只收自家頁面、名字交給 track()——表外的整則不送、表內的 props 只有 name 一格
  t("接線:preload trackFeature → send(\"track-feature\");主行程 fromOurPage 才 tm().track(\"feature_used\", { name })",
    /trackFeature: \(name\) => ipcRenderer\.send\("track-feature", name\),/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "preload.js"), "utf8"))
    && /ipcMain\.on\("track-feature", \(e, name\) => \{ if \(fromOurPage\(e\)\) tm\(\)\.track\("feature_used", \{ name \}\); \}\);/.test(mainSrc));
  { const x = mk(fs.mkdtempSync(path.join(os.tmpdir(), "blave-tm-")));
    t("主行程拒絕表外的 name:策略名 / 空字串 / 非字串 / 大小寫不對 / 缺 props 都不送", [{ name: "my alpha v7" }, { name: "" }, { name: ["chat_sent"] }, { name: { toString: () => "chat_sent" } }, { name: "Chat_Sent" }, {}, null].every((p) => x.tm.track("feature_used", p) === false) && x.sent.length === 0);
    t("表內的 name 送;每一個都送得出去;props 只有 name 一格、不帶多塞的欄位", FEATURES.every((n) => x.tm.track("feature_used", { name: n, strategy: "SECRET", symbol: "BTCUSDT" }) === true)); await tick();
    t("…送出去的 " + FEATURES.length + " 則 props 各是 {name}、不含多塞的字", x.sent.length === FEATURES.length && x.sent.every((b, i) => b.event === "feature_used" && JSON.stringify(b.props) === JSON.stringify({ name: FEATURES[i] }) && !JSON.stringify(b).includes("SECRET"))); }
  // ── 外殼端每安裝每 name 每 UTC 日只送一次(契約;api 那顆 3,000/hr 熔斷算的是 POST 數,前提就是這裡) ──
  { const dirD = fs.mkdtempSync(path.join(os.tmpdir(), "blave-tm-")); let clock = Date.UTC(2026, 8, 25, 23, 59, 30);
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
    let release = null; const slow = mk(fs.mkdtempSync(path.join(os.tmpdir(), "blave-tm-")), { post: () => new Promise((r) => { release = r; }) });
    t("送出中再 track 同 name:false(in-flight)", slow.tm.track("feature_used", { name: "chat_sent" }) === true && slow.tm.track("feature_used", { name: "chat_sent" }) === false); await tick();
    release({ status: 500 }); await tick();
    t("api 沒回 2xx:不記帳,之後可以再送(送出去就丟、api 去重)", slow.tm.track("feature_used", { name: "chat_sent" }) === true);
    // 狀態檔在、但 daily 那一段壞掉 / 舊版沒有:當今天什麼都沒送(退回「都送」),其餘欄位照讀
    for (const dailyRaw of [undefined, null, "x", { day: "yesterday", keys: [] }, { day: "20260925", keys: "chat_sent" }, { day: 20260925, keys: ["feature_used:chat_sent"] }]) {
      const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "blave-tm-")), iid = "11111111-2222-4333-8444-555555555555";
      fs.writeFileSync(path.join(dirB, "telemetry.json"), JSON.stringify({ install_id: iid, enabled: true, sent: ["app_first_open"], daily: dailyRaw }));
      const b = mk(dirB, { now: () => clock }); t("daily 壞掉(" + JSON.stringify(dailyRaw) + ")→ 照送、install_id 不變", b.tm.track("feature_used", { name: "chat_sent" }) === true && b.tm.installId() === iid); }
    t("app_open 不走每日去重(每次啟動送、api 去重——留存靠它)", !/app_open/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "telemetry.js"), "utf8").match(/const DAILY = \[[^\]]*\]/)[0]));
  }

  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
