// 關於的「檢查更新」與「更新雲端主機」分開(0.1.15;10-04 一按檢查更新就把 Wei 真錢下單中的雲端主機更新並重啟)。
// 檢查更新只碰電腦版、永遠不送訊息;更新雲端主機在自動下單可能在跑時先問。從 app.js / trade.js 原文切函式,配假的送出與確認框跑。
// 跑法:node tests/check_shell_cloud_update.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "app.js"), "utf8"), trsrc = fs.readFileSync(path.join(R, "trade.js"), "utf8");
const cut = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) return null; return s.slice(i, s.indexOf("\n}", i) + 2); };
const fnOr = (name, async) => (async ? "async " : "") + (cut(src, name) || "function " + name + "() {}");
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };

const t = (k, v) => (v ? k + JSON.stringify(v) : k);
var ENV = { cloudDirty: false };
const TR_BAGS = { cloud: { st: null } };
let cloudSt = null, running = false, sent = [], boxes = [], checks = 0, refreshes = 0;
const trPoll = async () => { ENV.cloudDirty = false; TR_BAGS.cloud.st = cloudSt; };
const window = { blave: { updateCheck: () => { checks++; return Promise.resolve(true); }, cloudRefresh: () => { refreshes++; return Promise.resolve(); } } };
const submitMessage = async (msg, o) => { sent.push([msg, o]); running = true; return true; };
const confirmBox = (o) => { boxes.push(o); };
let tracked = []; const trackFeature = (n) => { tracked.push(n); };
const envCloudKind = (st) => (st && st.kind) || "loading";
const trExecState = (st) => (st && st.exec) || "loading";
const trRestartUnconfirmed = (r) => { const x = r && r.reconciler && r.reconciler.stopped; return !!(x && x.reason === "machine_restart" && x.gated === false); };
const trVenueIds = (r) => (r && r.venue ? [r.venue] : []), trVenueLabel = (id) => id || "", envMoney = (st) => (st && st.report && st.report.venue === "paper" ? "paper" : "real");
const envMoneyText = (m) => (m === "paper" ? "模擬" : "真錢"), trWhereTidy = (s) => s;
const paneSt = { chat: { off: false } }, paneToggle = () => {}, upPaint = () => {}, upRefresh = () => Promise.resolve(), $ = (id) => ({ id });
let UP = { phase: "idle", current: "0.1.14", checkedAt: 1 };
eval("var UPD = " + src.match(/var UPD = (\{[^\n]*\});/)[1]);
eval(["UP_SESSION_IDLE_MS", "UP_RETRY_MS", "UP_WU_STATES", "UP_WU_DIR_RE"].map((k) => src.match(new RegExp("^const " + k + " = [^\\n]*;", "m"))[0].replace(/^const /, "var ")).join("\n"));
var UP_CHECKING = false, UP_CLOUD_BUSY = false;
eval(["upObserve", "upMachineGone", "upWu", "upPlan", "upLocalTurn", "upNow", "upTurnEnded", "upCloudWhere"].map((n) => fnOr(n)).join("\n"));
eval(["upCheck", "upCloudRefresh", "upCloudUpdate", "upCloudSend"].map((n) => fnOr(n, true)).join("\n"));

const st = (exec, o) => ({ kind: "running", exec, cloud: { config_version: "2026-10-04-c", latest_config_version: "2026-10-04-d", ...((o && o.cloud) || {}) }, report: { venue: "binance", ...((o && o.report) || {}) } });
const reset = (s) => { cloudSt = s; TR_BAGS.cloud.st = s; running = false; sent = []; boxes = []; tracked = []; checks = 0; refreshes = 0; Object.assign(UPD, { cloudTurn: false, turnCloud: false, session: null, lagCv: null, done: null }); };

(async () => {
  reset(st("running")); await upCheck();
  ok("檢查更新:雲端落後、自動下單在跑 → 只查電腦版(updateCheck)+ 唯讀刷新雲端,不送任何訊息、不開確認框", checks === 1 && sent.length === 0 && boxes.length === 0);
  reset(st("halted")); await upCheck();
  ok("檢查更新:雲端落後、已暫停 → 一樣不送(檢查更新永遠不更新雲端);也不記更新雲端主機的埋點", sent.length === 0 && boxes.length === 0 && tracked.length === 0);
  ok("檢查更新的原文裡沒有 submitMessage / up.c.msg", !/submitMessage|up\.c\.msg/.test(cut(src, "upCheck") || "") && !/submitMessage|up\.c\.msg/.test(cut(src, "upCloudRefresh") || "x"));

  reset(st("running")); await upCloudUpdate();
  const b = boxes[0] || {};
  ok("更新雲端主機:自動下單在跑(running)→ 先跳確認框,按下之前什麼都不送", boxes.length === 1 && sent.length === 0);
  ok("確認框(設計師定稿):雲端樣式 + footWhere「雲端 · 真錢 · Binance」+ 在跑那一句 + 共用第二句 + 收合的細節 + 主鈕「更新」",
    b.env === "cloud" && /env\.cloud/.test(b.footWhere || "") && /真錢/.test(b.footWhere || "") && /binance/.test(b.footWhere || "") && b.title === "up.cf.title"
    && JSON.stringify(b.lines) === '["up.cf.body1","up.cf.body2"]' && Array.isArray(b.details) && b.details.length === 1 && b.details[0].text === "up.cf.detail" && b.ok === "up.cf.ok" && !b.single);
  ok("…按下就記 cloud_upd_open(還沒送)", JSON.stringify(tracked) === '["cloud_upd_open"]');
  ok("…取消(不叫 onOk):什麼都不送、不進更新期間;onCancel 記 cloud_upd_cancel", sent.length === 0 && UPD.session === null && typeof b.onCancel === "function" && (b.onCancel(), tracked[tracked.length - 1] === "cloud_upd_cancel"));
  tracked = [];
  if (typeof b.onOk === "function") { b.onOk(); await new Promise((r) => setImmediate(r)); }
  ok("…按「更新」:照既有路徑在本機聊天送 up.c.msg(viewing env:cloud)、開一段更新期間", sent.length === 1 && sent[0][0] === "up.c.msg" && JSON.stringify(sent[0][1]) === '{"viewing":{"env":"cloud"}}' && !!UPD.session && UPD.session.fromCv === "2026-10-04-c" && JSON.stringify(tracked) === '["cloud_upd_ok"]');

  reset(st("unconfirmed", { report: { venue: "paper", reconciler: { stopped: { reason: "machine_restart", gated: false } } } })); await upCloudUpdate();
  ok("重開沒能確認停住(unconfirmed,模擬也算)→ 跳確認;第一句換成「換成新版就會先停住」那句(不寫用新版重新啟動);footWhere 寫模擬", boxes.length === 1 && sent.length === 0 && /模擬/.test(boxes[0].footWhere || "")
    && JSON.stringify(boxes[0].lines) === '["up.cf.body1Unconfirmed","up.cf.body2"]');
  for (const ex of ["halted", "dead", "noaccount"]) {
    reset(st(ex)); await upCloudUpdate();
    ok("更新雲端主機:" + ex + " → 不問、直接送 up.c.msg;記 open + ok", boxes.length === 0 && sent.length === 1 && sent[0][0] === "up.c.msg" && JSON.stringify(tracked) === '["cloud_upd_open","cloud_upd_ok"]');
  }
  for (const ex of ["loading", "unknown"]) {
    reset(st(ex)); await upCloudUpdate();
    ok("更新雲端主機:" + ex + "(讀不到下單狀態)→ 當成可能在跑,先問;第一句用沒能確認停下那句", boxes.length === 1 && sent.length === 0 && boxes[0].lines[0] === "up.cf.body1Unconfirmed");
  }
  reset(st("running", { cloud: { latest_config_version: "2026-10-04-c" } })); await upCloudUpdate();
  ok("雲端已是最新(沒有落後也沒有重開未確認):更新雲端主機什麼都不做", boxes.length === 0 && sent.length === 0);
  reset({ ...st("halted"), kind: "stopped" }); await upCloudUpdate();
  ok("雲端停機:不送", boxes.length === 0 && sent.length === 0);
  reset(st("halted")); running = true; await upCloudUpdate();
  ok("這台電腦有回合在跑:不送(送不出去)", sent.length === 0 && boxes.length === 0);

  { const dc = cut(src, "delClose") || "";
    ok("確認框的 onCancel:只在沒按主鈕 / 第二動作鈕就收掉時叫(取消、✕、Esc、框外、被程式收掉);主鈕與第二動作鈕先記 acted", /if \(c && c\.onCancel && !c\.acted\) c\.onCancel\(\);/.test(dc)
      && /delCtx\.acted = true; delClose\(false\); go\(\); return; \}/.test(src) && /if \(delCtx\) delCtx\.acted = true; delClose\(false\); if \(go\) go\(\);/.test(src) && /opener, onCancel \};/.test(cut(src, "confirmBox") || "")); }
  { const V = require("vm").runInNewContext(fs.readFileSync(path.join(R, "strings.js"), "utf8").replace(/^const STRINGS/m, "var STRINGS") + "\nSTRINGS");
    const want = { zh: ["更新雲端主機？", "自動下單正在雲端主機上跑。更新動到下單程式時，會用新版重新啟動自動下單。", "主機重開後，沒能確認自動下單已經停下。下單程式換成新版就會先停住，按「啟動下單」才會繼續。",
        "部位不會平倉。正在送出的單會等它完成才重啟；一直等不到空檔，就只換檔，自動下單先留在舊版。", "你改過的官方檔會換成官方版，舊檔另存備份；你自建的下單整合不動。", "更新", "更新雲端主機"],
      en: ["Update the cloud machine?", "Auto-trading is running on the cloud machine. If the update changes the trading code, auto-trading restarts on the new version.",
        "After the machine restarted, we couldn’t confirm auto-trading had stopped. Once the trading code is on the new version, it stays stopped until you press Start trading.",
        "Positions stay open. If an order is being sent, the restart waits for it to finish; if no gap comes up, only the files are updated and auto-trading stays on the old code.",
        "Official files you changed are replaced with the official versions; the old copies are backed up. Your own order integrations are left alone.", "Update", "Update cloud machine"] };
    const keys = ["up.cf.title", "up.cf.body1", "up.cf.body1Unconfirmed", "up.cf.body2", "up.cf.detail", "up.cf.ok", "up.cloud.go"];
    ok("確認框與連結的字 = 設計師定稿(zh / en 逐字;沒有「最多等 10 分鐘」)", ["zh", "en"].every((l) => keys.every((k, i) => V[l][k] === want[l][i])) && !/10 分鐘|10 minutes/.test(keys.map((k) => V.zh[k] + V.en[k]).join())); }
  const ps = cut(trsrc, "psOpen") || "";
  ok("trade.js 投資組合被鎖那一行的雲端入口:走 upCloudUpdate(含確認),不再直接叫 upCheck", /if \(cloud\) upCloudUpdate\(/.test(ps) && !/upCheck\(/.test(ps) && !/upCheck\(|upCloudRecheck\(/.test(trsrc));
  ok("app.js 再也沒有不經確認就送 up.c.msg 的地方:up.c.msg 只出現在 upCloudSend", (src.match(/t\("up\.c\.msg"\)/g) || []).length === 1 && /t\("up\.c\.msg"\)/.test(cut(src, "upCloudSend") || ""));

  console.log(red ? `\n${red} FAIL` : "\nall pass");
  process.exit(red ? 1 : 0);
})();
