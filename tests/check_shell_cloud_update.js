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
// 下單狀態用 trade.js 的真 trExecState(稽核 P1:mock 成 st.exec 時看不到「過期回報」那條路)
const cutLine = (s, name) => { const i = s.indexOf("function " + name + "("), e = s.indexOf("\n", i), l = s.slice(i, e); return /\}\s*(\/\/.*)?$/.test(l) && !/\{\s*$/.test(l) ? l : cut(s, name); };   // 一行寫完的函式不能切到下一個 "\n}"
eval(["trHasAccount", "trPresWip", "trSetupOnly", "trRecRunning", "trRestartStopped", "trRestartUnconfirmed", "trRestartKind", "trExecState"].map((n) => cutLine(trsrc, n)).join("\n"));
const trVenueIds = (r) => (r && r.venue ? [r.venue] : []), trVenueLabel = (id) => id || "", envMoney = (st) => (st && st.report && st.report.venue === "paper" ? "paper" : "real");
const envMoneyText = (m) => (m === "paper" ? "模擬" : "真錢"), trWhereTidy = (s) => s;
const paneSt = { chat: { off: false } }, paneToggle = () => {}, upPaint = () => {}, upRefresh = () => Promise.resolve(), $ = (id) => ({ id });
// 最小假 DOM:lede 那一句經 upRich 畫成 p(版號包 .mono)走 lead 槽
class El { constructor(tag) { this.tag = tag; this.className = ""; this.children = []; this._t = ""; } append(...x) { x.forEach((y) => this.children.push(y)); }
  get textContent() { return this.children.length ? this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("") : this._t; } set textContent(v) { this._t = String(v); this.children.length = 0; } }
const document = { createElement: (tag) => new El(tag) };
const mono = (n, s) => !!n && (n.children || []).some((c) => c && c.className === "mono" && c.textContent === s);
const ledeOk = (b, cv, lv) => !!b.lead && b.lead.tag === "p" && b.lead.className === "cf-lede" && /^up\.cf\.lede\{/.test(b.lead.textContent) && mono(b.lead, cv) && mono(b.lead, lv);
let UP = { phase: "idle", current: "0.1.14", checkedAt: 1 };
eval("var UPD = " + src.match(/var UPD = (\{[^\n]*\});/)[1]);
eval(["UP_SESSION_IDLE_MS", "UP_RETRY_MS", "UP_WU_STATES", "UP_WU_DIR_RE"].map((k) => src.match(new RegExp("^const " + k + " = [^\\n]*;", "m"))[0].replace(/^const /, "var ")).join("\n"));
var UP_CHECKING = false, UP_CLOUD_BUSY = false;
eval(["upObserve", "upMachineGone", "upWu", "upPlan", "upLocalTurn", "upNow", "upTurnEnded", "upCloudWhere", "upRich"].map((n) => fnOr(n)).join("\n"));
eval(["upCheck", "upCloudRefresh", "upCloudUpdate", "upCloudSend"].map((n) => fnOr(n, true)).join("\n"));

// 每個下單狀態對到一份會讓真 trExecState 回出那個值的回報(alive = cloud.js 的「主機在跑而且回報夠新」)
const REP = { running: {}, halted: { halt: { halted: true } }, dead: { reconciler: { alive: false } }, noaccount: { venue: null },
  unconfirmed: {}, unknown: { error: "build failed", venues: null } };
const st = (exec, o) => ({ kind: "running", alive: !(o && o.alive === false), cloud: { config_version: "2026-10-04-c", latest_config_version: "2026-10-04-d", ...((o && o.cloud) || {}) },
  report: exec === "loading" ? null : { venue: "binance", venues: {}, reconciler: { alive: true }, ...(REP[exec] || {}), ...((o && o.report) || {}) } });
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
  const D5 = '["up.cf.d1","up.cf.d2","up.cf.d3","up.cf.d4","up.cf.d5"]';
  ok("確認框(設計師 D 版):雲端樣式 + footWhere「雲端 · 真錢 · Binance」+ 只有 lede(帶 cv→lv,走 lead 槽、版號 mono)與在跑那一句 + 主鈕「開始更新」",
    b.env === "cloud" && /env\.cloud/.test(b.footWhere || "") && /真錢/.test(b.footWhere || "") && /binance/.test(b.footWhere || "") && b.title === "up.cf.title"
    && ledeOk(b, "2026-10-04-c", "2026-10-04-d") && JSON.stringify(b.lines) === '["up.cf.body1"]' && b.ok === "up.cf.ok" && !b.single);
  ok("…細節一組五條(items,預設收合)、沒有 keep、沒有舊的 text / detailsOpen", Array.isArray(b.details) && b.details.length === 1 && JSON.stringify(b.details[0].items) === D5
    && !b.details[0].text && !b.details[0].label && b.keep === undefined && !b.detailsOpen);
  ok("原文裡沒有退役的 body2 / detail / keep", !/up\.cf\.body2|up\.cf\.detail|keep:/.test(cut(src, "upCloudUpdate") || ""));
  ok("…按下就記 cloud_upd_open(還沒送)", JSON.stringify(tracked) === '["cloud_upd_open"]');
  ok("…取消(不叫 onOk):什麼都不送、不進更新期間;onCancel 記 cloud_upd_cancel", sent.length === 0 && UPD.session === null && typeof b.onCancel === "function" && (b.onCancel(), tracked[tracked.length - 1] === "cloud_upd_cancel"));
  tracked = [];
  if (typeof b.onOk === "function") { b.onOk(); await new Promise((r) => setImmediate(r)); }
  ok("…按「開始更新」:照既有路徑在本機聊天送 up.c.msg(viewing env:cloud)、開一段更新期間", sent.length === 1 && sent[0][0] === "up.c.msg" && JSON.stringify(sent[0][1]) === '{"viewing":{"env":"cloud"}}' && !!UPD.session && UPD.session.fromCv === "2026-10-04-c" && JSON.stringify(tracked) === '["cloud_upd_ok"]');

  reset(st("unconfirmed", { report: { venue: "paper", reconciler: { stopped: { reason: "machine_restart", gated: false } } } })); await upCloudUpdate();
  ok("重開沒能確認停住(unconfirmed,模擬也算)→ 跳確認;狀態句換成「換成新版後會先停住」那句(不寫用新版重新啟動);lede 照帶版號;footWhere 寫模擬", boxes.length === 1 && sent.length === 0 && /模擬/.test(boxes[0].footWhere || "")
    && ledeOk(boxes[0], "2026-10-04-c", "2026-10-04-d") && JSON.stringify(boxes[0].lines) === '["up.cf.body1Unconfirmed"]');
  reset(st("running", { cloud: { latest_config_version: null, config_supports_wf: false } })); await upCloudUpdate();
  ok("讀不到最新版號(lv null、lib 沒有 walk_forward 才算落後)→ 照開框,lede 用不帶號那句(同關於列「有新版」不帶號的退化)", boxes.length === 1 && sent.length === 0
    && JSON.stringify(boxes[0].lines) === '["up.cf.ledeBare","up.cf.body1"]' && !boxes[0].lead);
  reset(st("running", { cloud: { config_version: null, latest_config_version: null, config_supports_wf: false } })); await upCloudUpdate();
  ok("cv 也讀不到 → 一樣不帶號(照舊走 lines,沒有 lead)", boxes.length === 1 && boxes[0].lines[0] === "up.cf.ledeBare" && !boxes[0].lead);
  for (const ex of ["halted", "dead", "noaccount"]) {
    reset(st(ex)); await upCloudUpdate();
    ok("更新雲端主機:" + ex + " → 不問、直接送 up.c.msg;記 open + ok", boxes.length === 0 && sent.length === 1 && sent[0][0] === "up.c.msg" && JSON.stringify(tracked) === '["cloud_upd_open","cloud_upd_ok"]');
  }
  for (const ex of ["loading", "unknown"]) {
    reset(st(ex)); await upCloudUpdate();
    ok("更新雲端主機:" + ex + "(讀不到下單狀態)→ 當成可能在跑,先問;狀態句用「讀不到,照正在跑處理」那句(不再借 unconfirmed 的「主機重開後」)", boxes.length === 1 && sent.length === 0 && !!boxes[0].lead && JSON.stringify(boxes[0].lines) === '["up.cf.body1Unknown"]');
  }
  ok("st() 造出的回報經真 trExecState 得到預期的狀態", ["running", "halted", "dead", "noaccount", "unknown", "loading"].every((ex) => trExecState(st(ex)) === ex)
    && trExecState(st("unconfirmed", { report: { reconciler: { alive: false, stopped: { reason: "machine_restart", gated: false } } } })) === "unconfirmed");
  for (const [ex, why] of [["running", "回報寫對帳器在跑"], ["halted", "回報寫已暫停(用戶可能已在 web / TG 恢復)"], ["dead", "回報寫對帳器沒在跑"]]) {
    reset(st(ex, { alive: false })); await upCloudUpdate();
    ok("主機在跑但回報過期(alive:false;連不上 / 429 / 睡醒)+ " + why + " → 一律先問,狀態句用「讀不到」那句", boxes.length === 1 && sent.length === 0 && JSON.stringify(boxes[0].lines) === '["up.cf.body1Unknown"]');
  }
  reset(st("unconfirmed", { alive: false, report: { reconciler: { stopped: { reason: "machine_restart", gated: false } } } })); await upCloudUpdate();
  ok("回報過期 + 裡面寫重開沒確認停住:過期的回報不能信(同 upNow),狀態句仍用「讀不到」那句、不講「主機重開後」", boxes.length === 1 && boxes[0].lines[0] === "up.cf.body1Unknown");
  ok("三分支各出各的句:running / unconfirmed / 其餘 unknown(原文沒有別的 up.cf.body1* 分支)", (cut(src, "upCloudUpdate") || "").split("up.cf.body1").length === 4);
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
    // 設計師 D 版 spec §3(.claude/output/designer/desktop-cloud-update-modal-2026-10-08/spec.md)逐字;d4 的反引號不進 textContent
    const want = { zh: ["把雲端主機更新到最新版", "雲端主機會從 {cv} 換到 {lv}。過程要幾分鐘，在聊天裡跑，做完會說一聲。", "雲端主機會換成最新版。過程要幾分鐘，在聊天裡跑，做完會說一聲。",
        "自動下單正在跑：動到下單程式時，會等沒有單在送出的空檔，再用新版重新啟動。", "主機重開後沒能確認自動下單已停下：換成新版後會先停住，按「啟動下單」才會繼續。",
        "讀不到自動下單的狀態，照正在跑處理：動到下單程式時，會等沒有單在送出的空檔，再用新版重新啟動。",
        "只換 Blave 官方的程式與說明檔，不碰你的策略檔與金鑰；部位不會平倉。", "一直等不到空檔，就只換檔，自動下單先留在舊版。", "沒更新完成會在聊天說明原因，再按一次就會接著做。",
        "你改過的官方檔會換成官方版，舊檔備份在主機的 .official-backup/。", "你自己加的下單整合不動。", "開始更新", "更新雲端主機"],
      en: ["Update the cloud machine", "The cloud machine goes from {cv} to {lv}. It takes a few minutes, runs in the chat, and says there when it’s done.",
        "The cloud machine updates to the latest version. It takes a few minutes, runs in the chat, and says there when it’s done.",
        "Auto-trading is running: if the trading code changes, it waits until no order is mid-flight, then restarts on the new version.",
        "After the machine restarted, we couldn’t confirm auto-trading had stopped: once on the new version it stays stopped until you press Start trading.",
        "Couldn’t read the auto-trading status, so it’s treated as running: if the trading code changes, it waits until no order is mid-flight, then restarts on the new version.",
        "Only Blave’s official code and reference files change; your strategy files and keys are left alone. Positions stay open.", "If no gap comes up, only the files change and auto-trading stays on the old code.",
        "If the update doesn’t finish, the chat says why; press Start update again and it picks up where it stopped.",
        "Official files you changed are replaced with the official versions; the old copies are backed up in .official-backup/ on the machine.", "Order integrations you added yourself are left alone.", "Start update", "Update cloud machine"] };
    const keys = ["up.cf.title", "up.cf.lede", "up.cf.ledeBare", "up.cf.body1", "up.cf.body1Unconfirmed", "up.cf.body1Unknown", "up.cf.d1", "up.cf.d2", "up.cf.d3", "up.cf.d4", "up.cf.d5", "up.cf.ok", "up.cloud.go"];
    const all = keys.map((k) => V.zh[k] + V.en[k]).join();
    ok("確認框與連結的字 = 設計師 D 版定稿(zh / en 逐字;不寫分鐘數上限、不寫「策略不受影響」、不寫「不撤單」)", ["zh", "en"].every((l) => keys.every((k, i) => V[l][k] === want[l][i]))
      && !/10 分鐘|10 minutes|策略不受影響|不撤單|strategies (are )?unaffected/.test(all));
    ok("退役的 up.cf.body2 / up.cf.detail 兩語都不在表裡", ["zh", "en"].every((l) => !("up.cf.body2" in V[l]) && !("up.cf.detail" in V[l]))); }
  const ps = cut(trsrc, "psOpen") || "";
  ok("trade.js 投資組合被鎖那一行的雲端入口:走 upCloudUpdate(含確認),不再直接叫 upCheck", /if \(cloud\) upCloudUpdate\(/.test(ps) && !/upCheck\(/.test(ps) && !/upCheck\(|upCloudRecheck\(/.test(trsrc));
  ok("app.js 再也沒有不經確認就送 up.c.msg 的地方:up.c.msg 只出現在 upCloudSend", (src.match(/t\("up\.c\.msg"\)/g) || []).length === 1 && /t\("up\.c\.msg"\)/.test(cut(src, "upCloudSend") || ""));

  console.log(red ? `\n${red} FAIL` : "\nall pass");
  process.exit(red ? 1 : 0);
})();
