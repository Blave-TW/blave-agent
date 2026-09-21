// shell/telemetry.js:只有七個事件、屬性只有列舉、關掉就一則都不送、送不出去不炸。
// 跑法:node tests/check_shell_telemetry.js
const fs = require("fs"), os = require("os"), path = require("path");
const { createTelemetry, EVENTS } = require("../shell/telemetry.js");
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
  t("七個事件、沒有自由文字型的屬性", Object.keys(EVENTS).length === 7 && Object.values(EVENTS).every((s) => s === null || Object.values(s).every(Array.isArray)));

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
  t("shell/package.json 的版號符合契約(不然打包版每一則都被丟)", /^[0-9]{1,4}(\.[0-9]{1,4}){1,3}(-(alpha|beta|rc)\.[0-9]{1,3})?$/.test(require("../shell/package.json").version));
  // main.js 的接線:這三件被改掉測試要紅
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
  t("main.js:開發版不送(isPackaged 閘還在)", /app\.isPackaged \|\| process\.env\.BLAVE_TELEMETRY === "1" \? postJSON/.test(mainSrc));
  t("main.js:lang 只取 app.getLocale()", /lang: app\.getLocale\(\)/.test(mainSrc) && !/lang: process\.env/.test(mainSrc));
  t("首次告知那條 IPC 退場;讀 / 切開關兩支都只收自家頁面", !/telemetry-noticed|telemetryNoticed|setNoticed/.test(mainSrc + fs.readFileSync(path.join(__dirname, "..", "shell", "preload.js"), "utf8") + fs.readFileSync(path.join(__dirname, "..", "shell", "telemetry.js"), "utf8"))
    && /ipcMain\.handle\("telemetry-get", \(e\) => \(fromOurPage\(e\)/.test(mainSrc) && /ipcMain\.handle\("telemetry-set", \(e, on\) => \{ if \(!fromOurPage\(e\)\) return false;/.test(mainSrc));
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
