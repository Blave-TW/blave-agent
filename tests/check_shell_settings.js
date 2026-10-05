// 設定 modal 的兩塊畫面邏輯(shell/renderer/app.js):「關於」兩行(0.1.15:電腦版 / 雲端主機)+ 聊天那一格 + 事後那一行(upPlan / upDoneLine / upPaint,v4)、帳號與方案(planPaint 最上面那一組、登出)。
// 從原文切出函式,配一個最小的假 DOM 跑。跑法:node tests/check_shell_settings.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "app.js"), "utf8"), html = fs.readFileSync(path.join(R, "index.html"), "utf8"), css = fs.readFileSync(path.join(R, "app.css"), "utf8"), trcss = fs.readFileSync(path.join(R, "trade.css"), "utf8");
const fnSrc = (name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); return src.slice(i, src.indexOf("\n}", i) + 2); };
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };
const el = () => {
  const cls = new Set(["btn-quiet"]);
  const n = { _txt: "", hidden: false, onclick: null, title: "", _cls: "", children: [], dataset: {}, attrs: {}, focus: () => { document.activeElement = n; },
    classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), has: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c) },
    contains: () => false, addEventListener: (ev, fn) => { if (ev === "click") n.onclick = fn; }, focus: () => { document.activeElement = n; },
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute: (k, v) => { n.attrs[k] = String(v); }, removeAttribute: (k) => { delete n.attrs[k]; },
    append: (...x) => { x.forEach((y) => { n.children.push(y); n._txt += typeof y === "string" ? y : y.textContent || ""; }); },
    appendChild: (x) => { n.children.push(x); n._txt += x.textContent || ""; return x; } };
  Object.defineProperty(n, "className", { get: () => n._cls, set: (v) => { n._cls = v; } });
  let first = null; Object.defineProperty(n, "firstElementChild", { get: () => first || (first = el()) });   // #ws-update 裡那個 span
  // textContent = "" 也要清掉子節點(真的 DOM 是這樣;不清的話清單重畫會越畫越長,測試就看不出漏清)
  Object.defineProperty(n, "textContent", { get: () => n._txt, set: (v) => { n._txt = v; n.children.length = 0; } });
  return n;
};
const dom = {}; const $ = (id) => dom[id] || (dom[id] = el());
const document = { createElement: () => el(), activeElement: null, body: {}, querySelectorAll: (q) => (q === "#chat-scroll .msg.sys" ? $("chat-scroll").children.filter((c) => c && c._cls === "msg sys") : []) };
var ENV = { cloudDirty: false }; let polls = 0, refreshes = 0;
// trade.js 的輪詢替身:清掉記號、把「主行程手上那一份」(cloudSt)放進雲端那一袋——app.js 只從這一袋讀,不自己讀交易狀態
const trPoll = async () => { polls++; ENV.cloudDirty = false; TR_BAGS.cloud.st = cloudSt; };
let cur = null, planLoginBusy = false, oauthPending = false, HINT = null;
const setFocusGuard = () => {}, cmdLine = () => "";
// t 的替身:key + vars 的 JSON;upRich 會把 mono 的值換成記號、{view} 的位置放鈕——哪些字有 {view} 從 strings.js 讀,不寫死
const STR = eval(fs.readFileSync(path.join(R, "strings.js"), "utf8") + ";STRINGS"), VIEW_KEYS = new Set(Object.keys(STR.zh).filter((k) => /\{view\}/.test(STR.zh[k])));
const t = (k, v) => { if (!v) return k; const { view, ...rest } = v; return k + (Object.keys(rest).length ? JSON.stringify(rest) : "") + (view === "\uE002" && VIEW_KEYS.has(k) ? view : ""); };
const busyPin = () => {}, scrollChat = () => {}, said = []; const srSay = (x) => { said.push(x); };
const store = {}; const lsGet = (k) => (k in store ? store[k] : null), lsSet = (k, v) => { store[k] = String(v); };
const calls = []; let UP = null, hasToken = false, cloudSt = null, startOk = true;
const window = { blave: { updateCheck: () => { calls.push("check"); return Promise.resolve(true); }, updateInstall: () => { calls.push("install"); return Promise.resolve({ ok: true }); },
  updateState: () => Promise.resolve(UP), updateShowBackup: () => { calls.push("showBackup"); return Promise.resolve(true); }, cloudRefresh: () => { refreshes++; return Promise.resolve(); } } };
/* 「關於」兩行 + 聊天那一格 + 事後一行(upPlan / upDoneLine 決策、upPaint 照畫;upCheck 只查不送、upCloudUpdate 先問再送、upInstall)。雲端那一袋、聊天送出、確認框用假的。
   Wei 09-22 原則不變:用本機 app 不得觸發雲端 agent 回合——雲端那半在本機聊天送一句(帶 viewing env:cloud),不送雲端指令 */
const TR_BAGS = { cloud: { st: null, reqIds: {} } };
let running = false, LANG = "zh", sent = [];
const envCloudKind = (st) => (st && st.kind) || "loading";
const trRestartUnconfirmed = (r) => { const x = r && r.reconciler && r.reconciler.stopped; return !!(x && x.reason === "machine_restart" && x.gated === false); };   // 同 trade.js(那邊有自己的測試)
const submitMessage = async (msg, o) => { sent.push([msg, o]); if (startOk) running = true; return startOk; };   // 真的那支一開跑就把 running 設起來
// 「更新雲端主機」的確認框與下單狀態(0.1.15):確認框記下參數,按不按由測試決定;下單狀態由假雲端那一袋的 exec 給(沒給 = running)
const boxes = [], confirmBox = (o) => { boxes.push(o); }, featured = [], trackFeature = (n) => { featured.push(n); };
const trExecState = (st) => (st && st.exec) || "running";
const trVenueIds = () => ["binance"], trVenueLabel = (id) => id, envMoney = () => "real", envMoneyText = (m) => m, trWhereTidy = (x) => x;
const paneSt = { chat: { off: false } }, paneToggle = () => {};
eval("var UPD = " + src.match(/var UPD = (\{[^\n]*\});/)[1]);
eval(["UP_SESSION_IDLE_MS", "UP_RETRY_MS", "UP_WU_STATES", "UP_WU_DIR_RE", "UP_SAID_KEY"].map((k) => src.match(new RegExp("^const " + k + " = [^\\n]*;", "m"))[0].replace(/^const /, "var ")).join("\n"));
var CS_BOOTED = false, UP_CHECKING = false, UP_CLOUD_BUSY = false;
var UP_LINE_OF = new WeakMap();
eval(["upObserve", "upMachineGone", "upWu", "upPlan", "upCloudWhere", "upDoneLine", "upBackupLine", "upRich", "upPaintLine", "upSayLines", "upSayLine", "upRelang", "upView", "upLocalTurn", "upNow", "upTurnEnded", "upPaint", "acctPaintAcct"].map(fnSrc).join("\n"));
eval(["upCheck", "upCloudRefresh", "upCloudUpdate", "upCloudSend", "upInstall"].map((n) => "async " + fnSrc(n)).join("\n"));
eval(src.match(/^function upRefresh\(\) \{[^\n]*\}$/m)[0]);
eval([/^\$\("ws-update"\)\.addEventListener\("click", [^\n]*$/m, /^\$\("set-up-btn"\)\.addEventListener\("click", [^\n]*$/m, /^\$\("set-upc-btn"\)\.addEventListener\("click", [^\n]*$/m].map((re) => src.match(re)[0]).join("\n"));   // 三個入口的接線
const stepWhere = (c) => (c && c.where) || "local";
const C = { current: "0.0.7", version: "0.0.8" };
// alive = cloud.js status() 的「主機在跑而且回報夠新」;過期那條路在 check_shell_cloud_update.js
const cloud = (o, kind) => ({ kind: kind || "running", alive: true, cloud: { config_version: "2026-09-24-b", latest_config_version: "2026-09-24-b", ...((o && o.cloud) || {}) }, report: (o && o.report) || {} });
const plan = (up, st, x) => upPlan({ up, cloud: st && st.cloud, kind: st ? envCloudKind(st) : "loading", localTurn: false, mem: {}, now: 0, cloudStale: !!(st && trRestartUnconfirmed(st.report)), wu: st ? upWu(st.report) : null, ...(x || {}) });
const paint = (up, st) => { UP = up; TR_BAGS.cloud.st = st === undefined ? TR_BAGS.cloud.st : st; upPaint(); const b = $("set-up-btn"), w = $("ws-update");
  const cb = $("set-upc-btn");
  return { cspin: cb.children.some((c) => c && c.className === "spin16"), caria: cb.attrs["aria-label"], ctitle: cb.title, line: $("set-up-line").textContent, cline: $("set-upc").hidden ? null : $("set-upc-line").textContent, clink: cb.hidden ? null : cb.textContent, cdis: cb.disabled, link: b.textContent, kind: b.dataset.kind, dis: b.disabled, spin: b.children.some((c) => c && c.className === "spin16"), title: b.title,
    slot: w.hidden ? null : w.firstElementChild.textContent, slotKind: w.dataset.kind, slotDis: w.disabled, slotAria: w.attrs["aria-disabled"], status: w.classList.has("is-status"), slotTitle: w.title }; };
const mono = (n, s) => (n.children || []).some((c) => c && c.className === "mono" && c.textContent === s);
// ── 關於那一行:七種寫法(§4)。字一律由 upPlan 決定,upPaint 用「 · 」接、版號 mono ──
const idle = { ...C, phase: "idle", checkedAt: 1 }, fresh = { ...C, phase: "idle" };
let p = paint(idle, cloud());
ok("① 查完、都最新:第一行 Blave {av} · 已是最新版 + 檢查更新(可按);第二行 雲端主機 {cv} · 已是最新版、沒有連結", p.line === 'up.row.app{"av":"0.0.7"} · up.row.latest' && p.link === "up.check" && p.kind === "check" && !p.dis && !p.spin
  && p.cline === 'up.row.cloud{"cv":"2026-09-24-b"} · up.row.latest' && p.clink === null);
ok("① 兩個版號各自包在 .mono 裡(各在自己那一行)", mono($("set-up-line"), "0.0.7") && mono($("set-upc-line"), "2026-09-24-b"));
p = paint(fresh, cloud());
ok("② 還沒查完(啟動 30 秒內):第一行只寫版本、不寫狀態字、不寫「檢查中」;連結照舊;第二行不受影響", p.line === 'up.row.app{"av":"0.0.7"}' && p.link === "up.check" && !/checking/.test(p.line) && p.cline === 'up.row.cloud{"cv":"2026-09-24-b"} · up.row.latest');
{ const upd = fs.readFileSync(path.join(R, "..", "updater.js"), "utf8");
  ok("② 那 30 秒來自 updater.js 的 FIRST_CHECK_MS;「已是最新版」只認 checkedAt,而 checkedAt 只有 update-not-available 會寫", /const FIRST_CHECK_MS = 30 \* 1000;/.test(upd) && (upd.match(/checkedAt/g) || []).length === 1 && /update-not-available", \(\) => set\(\{ phase: "idle", version: null, checkedAt: Date\.now\(\) \}\)/.test(upd)
    && /st\.checkedAt > 0\) status = \["up\.row\.latest"\]/.test(fnSrc("upPlan"))); }
UP_CHECKING = true; p = paint(idle, cloud()); UP_CHECKING = false;
ok("③ 按下檢查更新的那幾秒:連結本身變成 16/2 圓環(停用、aria-label 留著檢查更新),狀態字沿用上一次的「已是最新版」,沒有「檢查中」", p.spin && p.dis && p.link === "" && $("set-up-btn").attrs["aria-label"] === "up.check" && /up\.row\.latest$/.test(p.line));
p = paint({ ...idle, phase: "checking" }, cloud());
ok("③ updater 自己在查(phase checking)也是圓環、狀態字不變", p.spin && /up\.row\.latest$/.test(p.line));
p = paint({ ...C, phase: "ready" }, cloud());
ok("④ app 已下載、沒在下單:狀態字「新版已下載」,連結換成「重新啟動以完成更新」", /up\.row\.ready$/.test(p.line) && p.link === "up.restart" && p.kind === "restart" && !p.dis);
p = paint({ ...C, phase: "blocked" }, cloud());
ok("⑤ app 已下載、下單中(0.1.10):狀態字同樣「新版已下載」,連結是「重新啟動以完成更新…」(按了主行程先問)", /up\.row\.ready$/.test(p.line) && p.link === "up.restart…" && p.kind === "restart" && !p.dis);
const applying = cloud({ report: { workspace_update: { state: "applying", ts: 1 } } });
p = paint(idle, applying);
ok("⑥ 雲端換檔中(報告 workspace_update.state = applying):第二行「雲端主機 {cv} · 更新中…」、沒有連結;第一行照舊、檢查更新可按", p.cline === 'up.row.cloud{"cv":"2026-09-24-b"} · up.row.applying' && p.clink === null
  && p.line === 'up.row.app{"av":"0.0.7"} · up.row.latest' && p.link === "up.check" && !p.dis && !p.spin);
p = paint(idle, cloud({ cloud: { config_version: "2026-09-22-p" } }, "stopped"));
ok("⑦ 雲端停機:第二行「雲端主機（停機）」、不帶版號、沒有連結;讀不到就不出第二行", p.line === 'up.row.app{"av":"0.0.7"} · up.row.latest' && p.cline === "up.row.cloudOff" && p.clink === null && paint(idle, cloud({}, "unreach")).cline === null);
p = paint(idle, cloud({}, "none"));
ok("⑧ 沒雲端主機:Blave {av} · 已是最新版、沒有第二行;沒登入 / 還沒讀到 / 啟動中同樣不出", p.line === 'up.row.app{"av":"0.0.7"} · up.row.latest' && p.cline === null && ["signedOut", "starting"].every((k) => paint(idle, cloud({}, k)).cline === null) && paint(idle, null).cline === null);
ok("雲端版號讀不到(舊機器 / api 快取 null):不印「雲端主機 null」、不出第二行", paint(idle, cloud({ cloud: { config_version: null } })).cline === null);
{ const lag = paint(idle, cloud({ cloud: { config_version: "2026-09-22-p" } }));
  ok("雲端已知落後:第一行照寫「已是最新版」(只講電腦版);第二行「雲端主機 {cv} · 有新版 {lv}」+「更新雲端主機…」(自動下單在跑,會先問)", lag.line === 'up.row.app{"av":"0.0.7"} · up.row.latest'
    && lag.cline === 'up.row.cloud{"cv":"2026-09-22-p"} · up.row.cloudNew{"lv":"2026-09-24-b"}' && lag.clink === "up.cloud.go…" && !lag.cdis && mono($("set-upc-line"), "2026-09-24-b")
    && plan(idle, cloud({ cloud: { config_version: "2026-09-22-p" } })).cloudLag === true); }
{ const halted = paint(idle, { ...cloud({ cloud: { config_version: "2026-09-22-p" } }), exec: "halted" }), stale = paint(idle, cloud({ report: { reconciler: { stopped: { reason: "machine_restart", gated: false } } } }));
  ok("已暫停 / 停了 / 沒連帳戶:連結不加「…」(不會先問);重開沒確認停住而版號一樣:不寫有新版、連結照出(會先問)", halted.clink === "up.cloud.go"
    && ["dead", "noaccount"].every((ex) => paint(idle, { ...cloud({ cloud: { config_version: "2026-09-22-p" } }), exec: ex }).clink === "up.cloud.go")
    && stale.cline === 'up.row.cloud{"cv":"2026-09-24-b"}' && stale.clink === "up.cloud.go…" && plan(idle, cloud({ report: { reconciler: { stopped: { reason: "machine_restart", gated: false } } } })).cloudLag === true); }
{ const lagSt = cloud({ cloud: { config_version: "2026-09-22-p" } });
  UP_CLOUD_BUSY = true; const busy = paint(idle, lagSt); UP_CLOUD_BUSY = false;
  running = true; const turn = paint(idle, lagSt); running = false;
  ok("停用一定講原因(canon Disabled):刷新中 = 16/2 圓環(aria-label 留著更新雲端主機、不掛 title);本機回合在跑 = 停用 + title up.busy;可按時沒有 title",
    busy.cspin && busy.cdis && busy.caria === "up.cloud.go" && busy.ctitle === "" && !turn.cspin && turn.cdis && turn.ctitle === "up.busy" && turn.clink === "up.cloud.go…" && paint(idle, lagSt).ctitle === ""); }
ok("讀不到最新版號但 lib 沒有 walk_forward:第二行寫「· 有新版」(不帶版號)+ 連結", paint(idle, cloud({ cloud: { latest_config_version: null, config_supports_wf: false } })).cline === 'up.row.cloud{"cv":"2026-09-24-b"} · up.row.cloudNewBare');
ok("雲端主機的 lib 沒有 walk_forward(config_supports_wf false):就算 api 讀不到最新版號(lv null)也算落後——樣本外驗證的〔去更新〕→「檢查更新」才有出口(稽核 P2-5);true / 缺欄位照舊",
  plan(idle, cloud({ cloud: { latest_config_version: null, config_supports_wf: false } })).cloudLag === true && plan(idle, cloud({ cloud: { latest_config_version: null, config_supports_wf: true } })).cloudLag === false
  && plan(idle, cloud({ cloud: { latest_config_version: null } })).cloudLag === false && plan(idle, cloud({ cloud: { config_supports_wf: false } }, "stopped")).cloudLag === false);
ok("安裝失敗:關於列那一句沿用 up.installFailed;查失敗什麼都不說", /up\.installFailed\{"nv":"0\.0\.8"\}$/.test(paint({ ...C, phase: "error", error: "INSTALL_FAILED" }, cloud()).line) && paint({ ...C, phase: "error", error: "CHECK_FAILED" }, cloud()).line === 'up.row.app{"av":"0.0.7"}');
ok("背景下載 / 暫存中 / 沒有更新來源:關於列不寫狀態字(沒有東西可等)", ["downloading", "staging", "off"].every((ph) => paint({ ...C, phase: ph }, cloud()).line === 'up.row.app{"av":"0.0.7"}'));
ok("狀態字不換色:upPlan 不回任何 cls,CSS 沒有 .st.up / .st.ok / 舊兩行版的 id;檢查更新不再掛「也會更新雲端」的 hover(up.check.cloudTip 刪了)", !("cls" in plan(idle, cloud()).row) && !("cls" in plan(idle, cloud()).cloud) && !/\.set-about \.st|set-up-(ver|txt|cver|ctxt|cnote|lbtn|head)|up-dot/.test(css + html + src) && !/cloudTip/.test(src + fs.readFileSync(path.join(R, "strings.js"), "utf8")));
ok("DOM:關於兩行(0.1.15):第一行電腦版 + 檢查更新;第二行 #set-upc(預設 hidden)雲端主機 + 更新雲端主機;兩行都 role=status;#ws-update 的字不走 data-i18n", /<p class="set-up-line" id="set-up-line" role="status"><\/p>\s*<button type="button" class="btn-quiet" id="set-up-btn"><\/button>\s*<\/div>\s*<div class="set-up-row" id="set-upc" hidden>\s*<p class="set-up-line" id="set-upc-line" role="status"><\/p>\s*<button type="button" class="btn-quiet" id="set-upc-btn" hidden><\/button>/.test(html)
  && (() => { const span = html.slice(html.indexOf('id="ws-update"'), html.indexOf("</button>", html.indexOf('id="ws-update"'))); return !/data-i18n/.test(span) && /<span><\/span>/.test(span); })());
// ── 聊天輸入列右上那一格:(b) 重新啟動以完成更新 / (c) 更新中… / 沒有東西 ──
p = paint({ ...C, phase: "ready" }, cloud());
ok("(b) ready 而且沒在下單:那一格出「重新啟動以完成更新」,可點", p.slot === "up.restart" && p.slotKind === "restart" && !p.slotDis && p.slotAria === "false" && !p.status);
p = paint({ ...C, phase: "blocked" }, cloud());
ok("(b) 下單中(blocked,0.1.10):那一格照出,字尾接「…」(按了主行程先問、確認後收工再裝),可點", p.slot === "up.restart…" && p.slotKind === "restart" && !p.slotDis);
{ const pb = plan({ ...C, phase: "blocked" }, cloud()), pr = plan({ ...C, phase: "ready" }, cloud()), pt = plan({ ...C, phase: "blocked" }, cloud(), { localTurn: true }), pe = plan({ ...C, phase: "error", error: "INSTALL_FAILED" }, cloud());
  ok("upPlan:blocked → slot restart、ask:true;ready → ask:false;回合中 disabled;error → 沒有 slot;blocked 的關於列 link 是 restart、狀態字 up.row.ready",
    pb.slot.kind === "restart" && pb.slot.ask === true && pr.slot.ask === false && pt.slot.disabled === true && pe.slot === null
    && pb.link.kind === "restart" && pb.link.ask === true && pb.row.status[0] === "up.row.ready" && !/readyQuit/.test(src)); }
{ const pr = paint({ ...C, phase: "blocked", restarting: true }, cloud()), plr = plan({ ...C, phase: "ready", restarting: true }, cloud());
  ok("重新啟動中(主行程 restarting,設計複驗 0.1.10):那一格與關於列的連結都是「重新啟動中…」、停用;不掛 up.busy、沒有「…」以外的字",
    pr.slot === "up.restarting" && pr.slotKind === "restarting" && pr.slotDis && pr.slotTitle === "" && pr.link === "up.restarting" && pr.kind === "restarting" && pr.dis
    && plr.slot.kind === "restarting" && plr.link.kind === "restarting" && plan({ ...C, phase: "ready", restarting: true }, applying).slot.kind === "restarting");
  calls.length = 0; $("ws-update").onclick && $("ws-update").onclick(); $("set-up-btn").onclick && $("set-up-btn").onclick();
  ok("…按了什麼都不做(不重裝、不查更新)", calls.length === 0);
  const zhS = fs.readFileSync(path.join(R, "strings.js"), "utf8");
  ok("…字 up.restarting:zh「重新啟動中…」、en「Restarting…」(U+2026)", /"up\.restarting": "Restarting…"/.test(zhS) && /"up\.restarting": "重新啟動中…"/.test(zhS)); }
p = paint(idle, applying);
ok("(c) 雲端換檔中:同一格不可點的「更新中…」(aria-disabled,不是 disabled;is-status;沒有時鐘、沒有百分比)", p.slot === "up.applying" && p.slotKind === "applying" && p.slotAria === "true" && !p.slotDis && p.status && !/\d/.test(p.slot));
p = paint({ ...C, phase: "ready" }, applying);
ok("(c) 壓過 (b):雲端換檔中時那一格是更新中;關於第一行照舊給重新啟動(只管電腦版;回合在跑時另有 up.busy 擋)", p.slot === "up.applying" && p.link === "up.restart" && !p.dis);
p = paint(idle, cloud());
ok("(a) 兩邊都最新:那一格什麼都不出", p.slot === null);
ok("(a) 背景下載 / 暫存中 / 檢查中:那一格也不出", ["downloading", "staging", "checking"].every((ph) => paint({ ...C, phase: ph }, cloud()).slot === null));
ok("報告的 workspace_update 是不可信輸入:state 不認得 / 不是物件 / 缺席都當沒有", upWu({ workspace_update: { state: "weird" } }) === null && upWu({ workspace_update: "applying" }) === null && upWu({}) === null && upWu(null) === null
  && upWu({ workspace_update: { state: "done", to: "x".repeat(100), replaced_changed: -1, backup_dir: 5, restarted: "true", restart_stopped: 1, outcome: "weird" } }).to.length === 40 && upWu({ workspace_update: { state: "done", replaced_changed: "lib/data.py" } }).replaced === 0
  && upWu({ workspace_update: { state: "done", backup_dir: 5, restarted: "true", restart_stopped: 1, outcome: "weird" } }).dir === null && upWu({ workspace_update: { state: "done", restarted: "true", restart_stopped: 1, outcome: "weird" } }).restarted === false
  && upWu({ workspace_update: { state: "done", restart_stopped: 1, outcome: "weird" } }).restartStopped === false && upWu({ workspace_update: { state: "done", outcome: "weird" } }).outcome === null && upWu({ workspace_update: { state: "done", outcome: "updated", replaced_changed: ["a", "b"] } }).replaced === 2);
{ const dir = (d) => upWu({ workspace_update: { state: "done", outcome: "updated", backup_dir: d } }).dir;
  ok("稽核 S-3:backup_dir 只認腳本產出的形狀 .official-backup/<VERSION_RE>-<UTC>(update_workspace.py 的 tag;有沒有尾斜線都算)",
    dir(".official-backup/2026-09-22-p-20260924T051200Z") === ".official-backup/2026-09-22-p-20260924T051200Z" && dir(".official-backup/unknown-20260924T051200Z/") === ".official-backup/unknown-20260924T051200Z/");
  ok("…不合形狀就當沒有(那一行就不出「查看」):../、帶空白、帶引號、別的資料夾、缺時間戳、超長", [".official-backup/../", ".official-backup/../x-20260924T051200Z", ".official-backup/a b-20260924T051200Z",
    ".official-backup/a\"-20260924T051200Z", "lib/2026-09-22-p-20260924T051200Z", ".official-backup/2026-09-22-p", ".official-backup/" + "x".repeat(41) + "-20260924T051200Z", "d/", "", "ls -la; rm -rf ~"].every((d) => dir(d) === null)); }
(async () => {
  calls.length = 0; paint({ ...C, phase: "ready" }, cloud()); await $("ws-update").onclick(); await new Promise((r) => setImmediate(r));
  ok("(b) 按那一格 = 重開換版(updateInstall),不送任何雲端指令", calls.join() === "install" && sent.length === 0);
  calls.length = 0; await $("set-up-btn").onclick(); await new Promise((r) => setImmediate(r));
  ok("關於列的「重新啟動以完成更新」同一條路(updateInstall)", calls.join() === "install");
  { const realI = window.blave.updateInstall, realS = window.blave.updateState; let reads = 0, threw = false;
    window.blave.updateInstall = () => Promise.reject(new Error("main threw")); window.blave.updateState = () => { reads++; return Promise.resolve(UP); };
    try { await upInstall(); } catch (_) { threw = true; }
    window.blave.updateInstall = realI; window.blave.updateState = realS;
    ok("主行程那邊拋例外(IPC reject):upInstall 不冒 unhandled rejection、當成沒裝成重讀狀態(稽核 P2-3)", !threw && reads === 1); }
  calls.length = 0; paint(idle, applying); await $("ws-update").onclick();
  ok("(c) 按更新中那一格什麼都不做", calls.length === 0 && sent.length === 0);
  running = true; p = paint({ ...C, phase: "ready" }, cloud()); calls.length = 0; await $("ws-update").onclick(); await $("set-up-btn").onclick();
  ok("(b) 這台電腦有回合在跑:那一格與關於的連結都停用、原因 up.busy(重開會把回合斷掉),按了不裝", p.slot === "up.restart" && p.slotDis && p.slotTitle === "up.busy" && p.link === "up.restart" && p.dis && p.title === "up.busy" && calls.length === 0);
  running = false;
  document.activeElement = $("ws-update"); paint(idle, cloud());
  ok("那一格收掉時焦點交給輸入框(不掉到 BODY)", document.activeElement === $("ta"));
  // ── 檢查更新(§2,0.1.15):app 重查一次 + 雲端唯讀刷新一次報告;永遠不送訊息。雲端更新只走第二行的「更新雲端主機」 ──
  calls.length = 0; sent.length = 0; refreshes = 0; polls = 0; ENV.cloudDirty = false; running = false;
  cloudSt = cloud(); paint(idle, cloud());
  let pr = upCheck(); const during = paint(idle);
  await pr;
  ok("檢查更新:兩件事都做(updateCheck + cloudRefresh),期間連結是圓環、做完回原樣;不送任何訊息、不改狀態字", calls.join() === "check" && refreshes === 1 && during.spin && during.dis && !paint(idle).spin && sent.length === 0 && /up\.row\.latest$/.test(paint(idle).line));
  ok("檢查更新:刷新完標記雲端要重讀並立刻輪詢一次(第二行的版號跟著新);app.js 不自己讀交易狀態", polls === 1 && !/tradeStatus/.test(fnSrc("upCloudRefresh")));
  calls.length = 0; sent.length = 0; refreshes = 0; boxes.length = 0; cloudSt = cloud({ cloud: { config_version: "2026-09-22-p" } }); TR_BAGS.cloud.st = cloudSt;
  await upCheck();
  ok("檢查更新:報告說落後、自動下單在跑 → 只查電腦版 + 刷新,不送、不開確認框、不進更新期間(10-04 事故)", calls.join() === "check" && refreshes === 1 && sent.length === 0 && boxes.length === 0 && UPD.session === null && TR_BAGS.cloud.st === cloudSt);
  cloudSt = { ...cloud({ cloud: { config_version: "2026-09-22-p" } }), exec: "halted" }; await upCheck();
  ok("檢查更新:落後、已暫停也一樣不送;upCheck / upCloudRefresh 原文沒有 submitMessage", sent.length === 0 && !/submitMessage|up\.c\.msg/.test(fnSrc("upCheck") + fnSrc("upCloudRefresh")));
  // ── 更新雲端主機:自動下單在跑 → 先問;按下才照既有路徑送 up.c.msg ──
  cloudSt = cloud({ cloud: { config_version: "2026-09-22-p" } }); TR_BAGS.cloud.st = cloudSt; paint(idle, cloudSt); refreshes = 0; boxes.length = 0;
  await $("set-upc-btn").onclick();
  const bx = boxes[0] || {};
  ok("更新雲端主機(自動下單在跑):先刷新一次、跳確認框(雲端樣式、footWhere、焦點回這顆鈕),按下之前什麼都不送", refreshes === 1 && boxes.length === 1 && sent.length === 0 && bx.env === "cloud" && bx.footWhere === 'tr.cloud.footWhere{"where":"env.cloud","money":"real","venue":"binance"}'
    && bx.opener === $("set-upc-btn") && bx.title === "up.cf.title" && bx.ok === "up.cf.ok" && JSON.stringify(bx.lines) === '["up.cf.body1","up.cf.body2"]' && bx.details[0].text === "up.cf.detail" && !bx.details[0].label);
  bx.onOk(); await new Promise((r) => setImmediate(r));
  ok("…按「更新」:在本機聊天送那一句固定的話、帶 viewing env:cloud(沒有雲端指令、沒有新指令)、開一段更新期間",
    sent.length === 1 && sent[0][0] === "up.c.msg" && JSON.stringify(sent[0][1]) === '{"viewing":{"env":"cloud"}}' && UPD.cloudTurn === true && UPD.session && UPD.session.fromCv === "2026-09-22-p" && UPD.session.nv === "2026-09-24-b"
    && !/cloudSend|update_workspace/.test(fnSrc("upCloudUpdate") + fnSrc("upCloudSend")));
  ok("接線:那一句仍是 up.c.msg(zh / en 都在);沒有別的 up.c.* 字串", /"up\.c\.msg": "把雲端主機更新到最新版本"/.test(fs.readFileSync(path.join(R, "strings.js"), "utf8")) && (fs.readFileSync(path.join(R, "strings.js"), "utf8").match(/"up\.c\.[a-zA-Z]+":/g) || []).length === 2);
  // (c) 的退路:報告還沒有 workspace_update 欄位時,由那一回合推得
  p = paint(idle, cloudSt);
  ok("(c) 退路:送出的那一回合在跑 → 那一格「更新中…」、第二行「更新中…」沒有連結;第一行不受影響(報告沒有 workspace_update)", running === true && p.slot === "up.applying" && /up\.row\.applying$/.test(p.cline) && p.clink === null && /up\.row\.latest$/.test(p.line));
  sent.length = 0; boxes.length = 0; running = false; await upCloudUpdate(); running = true;   // 回合剛結束、更新期間還在(等版號追上)
  ok("更新期間內(3 分鐘內,上一次還沒回報)再按更新雲端主機:不再送第二句、不開確認框;第二行寫「更新中…」、沒有連結(不是無聲灰掉)", sent.length === 0 && boxes.length === 0 && UPD.session !== null
    && ((running = false), (() => { const q = paint(idle, cloudSt); return /up\.row\.applying$/.test(q.cline) && q.clink === null; })()) && ((running = true), true));
  refreshes = 0; polls = 0; UPD.turnCloud = true; upTurnEnded(false); running = false; p = paint(idle, cloudSt); await new Promise((r) => setImmediate(r));
  ok("回合(碰過雲端)正常結束:立刻強制問一次雲端、標記重讀並輪詢;那一格收起(沒有回合在跑就不是更新中);更新期間留著等版號追上", refreshes === 1 && polls === 1 && p.slot === null && UPD.session !== null && UPD.cloudTurn === false);
  running = true; p = paint(idle, cloudSt);
  ok("更新期間內之後的回合、還沒碰雲端:不是更新中", p.slot === null);
  UPD.turnCloud = true; p = paint(idle, cloudSt);
  ok("…碰了雲端(tool chunk 帶 where: cloud):更新中", p.slot === "up.applying");
  upTurnEnded(true); running = false;
  ok("回合出錯:更新期間到此為止(之後無關的回合不再被畫成更新中)", UPD.session === null && ((running = true), paint(idle, cloudSt).slot === null) && ((running = false), true));
  Object.assign(UPD, { cloudTurn: true, turnCloud: false, session: { startAt: 1, lastTurnAt: 1, fromCv: "a", nv: "b" } }); upTurnEnded(false);
  ok("送出的那一回合正常結束但整回合沒碰雲端(例如要先登入):更新期間收掉", UPD.session === null);
  const halted = (o, kind) => ({ ...cloud(o, kind), exec: "halted" });
  sent.length = 0; boxes.length = 0; running = false; startOk = false; cloudSt = halted({ cloud: { config_version: "2026-09-22-p" } }); await upCloudUpdate();
  ok("已暫停:不問、直接送;聊天沒送出去(上一輪還在跑 / 版本被停用)就不進更新期間", boxes.length === 0 && sent.length === 1 && UPD.session === null && UPD.cloudTurn === false);
  startOk = true; sent.length = 0; running = true; await upCloudUpdate(); running = false;
  ok("這台電腦有回合在跑時按更新雲端主機:刷新,不送(送不出去)", sent.length === 0 && boxes.length === 0);
  { // R4:更新期間裡最後一個回合結束滿 3 分鐘(雲端早該回報了)仍落後 = 上一次沒成功 → 再按更新雲端主機要重送;還沒滿 3 分鐘照舊不送
    const lag = halted({ cloud: { config_version: "2026-09-22-p", latest_config_version: null, config_supports_wf: false } }); cloudSt = lag; TR_BAGS.cloud.st = lag;
    UPD.session = { startAt: Date.now() - UP_RETRY_MS + 20000, lastTurnAt: Date.now() - UP_RETRY_MS + 20000, fromCv: "2026-09-22-p", nv: null }; UPD.cloudTurn = false; sent.length = 0; await upCloudUpdate();
    const early = sent.length;
    UPD.session = { startAt: Date.now() - UP_RETRY_MS - 1000, lastTurnAt: Date.now() - UP_RETRY_MS - 1000, fromCv: "2026-09-22-p", nv: null }; UPD.cloudTurn = false; sent.length = 0; await upCloudUpdate(); running = false;
    ok("R4 讀不到最新版號時的更新期間:最後一回合結束未滿 3 分鐘不重送;滿 3 分鐘還落後就重送、開一段新的更新期間(不必等 30 分鐘閒置)",
      UP_RETRY_MS === 3 * 60000 && early === 0 && sent.length === 1 && sent[0][0] === "up.c.msg" && UPD.session && Date.now() - UPD.session.startAt < 5000);
    UPD.session = null; UPD.cloudTurn = false; }
  sent.length = 0; cloudSt = halted({ cloud: { config_version: "2026-09-22-p" }, report: { workspace_update: { state: "applying", ts: 2 } } }); await upCloudUpdate();
  ok("主機自己正在換檔(applying)時按更新雲端主機:不送", sent.length === 0);
  sent.length = 0; cloudSt = halted({ cloud: { config_version: "2026-09-22-p" } }, "stopped"); await upCloudUpdate();
  ok("雲端停機:不送(讀不到也是)", sent.length === 0 && ((cloudSt = halted({}, "unreach")), await upCloudUpdate(), sent.length === 0));
  sent.length = 0; boxes.length = 0; cloudSt = halted({ cloud: { config_version: "2026-09-22-p" } }); TR_BAGS.cloud.st = cloudSt; running = false; UPD.session = null;
  { const real = window.blave.cloudRefresh; window.blave.cloudRefresh = () => Promise.reject(new Error("main threw")); await upCloudUpdate(); window.blave.cloudRefresh = real; }
  ok("刷新失敗(主行程沒回):這次不動雲端,不送也不問", sent.length === 0 && boxes.length === 0);
  ok("接線:submitMessage 每一句都把 turnCloud 歸零;tool chunk 第一次帶 where: cloud 就記下並重畫;turn-end 把出錯交給 upTurnEnded;busyStep 不碰 UPD",
    /UPD\.turnCloud = false;[^\n]*\n\s*running = true; sendBtnSync\(\);/.test(fnSrc("submitMessage")) && !/UPD\.done/.test(fnSrc("submitMessage"))
    && /if \(!UPD\.turnCloud && stepWhere\(c\) === "cloud"\) \{ UPD\.turnCloud = true; upPaint\(\); \}\s*busyStep\(c\);/.test(src)
    && /const faulted = !stopped && \(r\.code !== 0 \|\| turnFaulted \|\| turnErrored \|\| !turnGotReply \|\| loggedOut\);/.test(src) && /upTurnEnded\(faulted\);\s*running = false;/.test(src) && !/UPD/.test(fnSrc("busyStep")));
  ok("接線:關於第一行的連結 = 重新啟動 / 檢查更新;第二行 = upCloudUpdate;那一格只有 restart 會做事;up.c.msg 只在 upCloudSend 送;沒有 upGo / 每秒重畫 / open-about", /const k = \$\("set-up-btn"\)\.dataset\.kind; if \(k === "restart"\) upInstall\(\); else if \(k === "check"\) upCheck\(\);/.test(src) && /if \(\$\("ws-update"\)\.dataset\.kind === "restart"\) upInstall\(\);/.test(src)
    && /\$\("set-upc-btn"\)\.addEventListener\("click", \(\) => upCloudUpdate\(\$\("set-upc-btn"\)\)\);/.test(src) && (src.match(/t\("up\.c\.msg"\)/g) || []).length === 1 && /t\("up\.c\.msg"\)/.test(fnSrc("upCloudSend")) && !/upCloudRecheck/.test(src)
    && !/upGo|upInstallLocal|UP_TICK|upClock|onOpenAbout|doneChatHidden|UP_REPORT_WAIT_MS/.test(src));
  // ── 主機刪掉又重開:落後 / 追上 / 更新期間都是那台的事,清掉 ──
  { const T0 = 1e12, ses = { session: { startAt: T0, lastTurnAt: T0, fromCv: "a", nv: "b" }, cloudTurn: true, lagCv: "a", done: null };
    ok("upMachineGone:沒有主機 / 啟動中清掉;停機 / 讀不到不清", upMachineGone({ ...ses }, "none").session === null && upMachineGone({ ...ses }, "starting").lagCv === null && upMachineGone({ ...ses }, "stopped").session !== null && upMachineGone({ ...ses }, "unreach").lagCv === "a");
    let m = upObserve({ session: { ...ses.session }, cloudTurn: true, lagCv: null, done: null }, { config_version: "b", latest_config_version: "b" }, false, false, T0 + 1);
    ok("upObserve:版號追上 → 更新期間結束、記一筆 from → to(事後那一行的退路)", m.session === null && m.cloudTurn === false && m.done && m.done.from === "a" && m.done.to === "b");
    m = upObserve({ session: { ...ses.session }, cloudTurn: false, lagCv: null, done: null }, { config_version: "a", latest_config_version: "b" }, false, false, T0 + UP_SESSION_IDLE_MS + 1);
    ok("upObserve:30 分鐘沒回合就結束;有回合就續命;出了更新一版也結束", m.session === null && upObserve({ session: { ...ses.session }, cloudTurn: false }, { config_version: "a", latest_config_version: "b" }, false, true, T0 + UP_SESSION_IDLE_MS + 1).session !== null
      && upObserve({ session: { ...ses.session }, cloudTurn: false }, { config_version: "a", latest_config_version: "c" }, false, false, T0 + 1).session === null);
    m = upObserve({ session: null, cloudTurn: false, lagCv: null, done: null }, { config_version: "a", latest_config_version: "b" }, false, false, T0); m = upObserve(m, { config_version: "b", latest_config_version: "b" }, false, false, T0 + 1);
    ok("upObserve:不是按鈕觸發(用戶自己叫 agent 更新):原本落後、之後追上 → 一樣有 from → to;一開就是最新版 / 版號一樣但重開沒停住(stale)都不算", m.done && m.done.from === "a" && m.done.to === "b"
      && upObserve({ lagCv: null, done: null }, { config_version: "b", latest_config_version: "b" }, false, false, T0).done === null && upObserve({ lagCv: "a", done: null }, { config_version: "b", latest_config_version: "b" }, true, false, T0).done === null); }
  // ── 事後那一行(§3):做完那一刻在聊天講一次,不進關於列 ──
  const msgs = () => $("chat-scroll").children.filter((c) => c && c._cls === "msg sys");
  const last = () => { const m = msgs(); return m[m.length - 1]; };
  const btnOf = (m) => (m.children || []).find((c) => c && typeof c === "object" && c.onclick);
  // 產方的形狀(manager/update_workspace.py status_doc):outcome 決定講哪一句;replaced_changed 是路徑清單
  const wu = (o) => cloud({ report: { workspace_update: { state: "done", outcome: "updated", from: "2026-09-22-p", to: "2026-09-24-b", restarted: false, reason: null, replaced_changed: [], backup_dir: null, restart_stopped: false, version_written: true, ts: 100, ...o } } });
  $("chat-scroll").children.length = 0; Object.keys(store).forEach((k) => delete store[k]); CS_BOOTED = false;
  paint(idle, wu({}));
  ok("對話還沒接回時不講(csOpen 清聊天會一起清掉);enterWorkspace 在 csInit 接回之後才叫 upSayLines", msgs().length === 0 && /csInit\(\)\.catch\(\(\) => \{\}\)\.then\(\(\) => \{ CS_BOOTED = true; upSayLines\(TR_BAGS\.cloud\.st\); \}\);/.test(src));
  CS_BOOTED = true; paint(idle, wu({})); paint(idle, wu({})); paint(idle, wu({}));
  ok("done:「雲端主機已更新到 {cv}。」在聊天講一次(sys、讀屏念一次),再畫幾次都不重複;版號 mono", msgs().length === 1 && last().textContent === 'up.done.cloud{"cv":"2026-09-24-b"}' && mono(last(), "2026-09-24-b") && said.filter((x) => /up\.done\.cloud\{/.test(x)).length === 1 && !btnOf(last()));
  paint(idle, wu({ ts: 101, restarted: true }));
  ok("＋下單程式重啟了:換那一句(同一個 ts 只講一次,新的 ts 再講)", msgs().length === 2 && last().textContent === 'up.done.cloudRestarted{"cv":"2026-09-24-b"}');
  paint(idle, wu({ ts: 102, restart_stopped: true }));
  ok("主機暫停中(restart_stopped,沒重啟):「自動下單仍暫停,按啟動下單才會繼續」那一句;不讀 report.reconciler", msgs().length === 3 && last().textContent === 'up.done.paused{"cv":"2026-09-24-b"}' && !/reconciler/.test(fnSrc("upDoneLine")));
  paint(idle, wu({ ts: 1025, restarted: true, restart_stopped: true }));
  ok("稽核 S-2:主機重開暫停中 + gated 重啟(restarted 與 restart_stopped 都 true):講暫停那句,不是「已用新版重新啟動」——用戶得知道仍沒在下單", msgs().length === 4 && last().textContent === 'up.done.paused{"cv":"2026-09-24-b"}');
  paint(idle, wu({ ts: 103, restarted: true, replaced_changed: ["lib/data.py", "lib/execute.py"], backup_dir: ".official-backup/2026-09-22-p-20260924T051200Z/" }));
  { const m = last(), b = btnOf(m);
    ok("＋換掉了改過的官方檔:接一句「你改過的 {n} 個官方檔…舊的在 {dir}(查看)」,{view} 的位置是「查看」文字鈕;zh 兩句直接相接", msgs().length === 5
      && m.textContent === 'up.done.cloudRestarted{"cv":"2026-09-24-b"}up.done.replaced{"n":"2","dir":".official-backup/2026-09-22-p-20260924T051200Z/"}up.done.view' && !!b && b.textContent === "up.done.view" && b._cls === "btn-quiet"
      && mono(m, ".official-backup/2026-09-22-p-20260924T051200Z/"));
    sent.length = 0; running = false; b.onclick(); running = false;
    ok("雲端的「查看」:在本機聊天送一句固定的話請這台電腦的 agent 列出那個資料夾(本機回合、帶 viewing env:cloud),不碰雲端 agent", sent.length === 1 && sent[0][0] === 'up.done.viewMsg{"dir":".official-backup/2026-09-22-p-20260924T051200Z/"}' && JSON.stringify(sent[0][1]) === '{"viewing":{"env":"cloud"}}'); }
  LANG = "en"; paint(idle, wu({ ts: 104, replaced_changed: ["a"], backup_dir: ".official-backup/unknown-20260924T051201Z" })); LANG = "zh";
  ok("en 兩句之間補一個空白", last().textContent === 'up.done.cloud{"cv":"2026-09-24-b"} up.done.replaced{"n":"1","dir":".official-backup/unknown-20260924T051201Z"}up.done.view');
  { // 0.1.11 Windows 真機:切 en 後聊天那則通知還是中文——那一行記著 key 與參數,切語言時照現在的語言重畫(applyStatic → upRelang)
    const zhLine = msgs()[msgs().length - 2], zhTxt = zhLine.textContent, nMsg = msgs().length; LANG = "en"; upRelang(); const b2 = btnOf(zhLine);
    ok("切語言:聊天裡已經講過的更新通知照新語言重畫(en 兩句之間的空白出現、「查看」鈕重建且照樣能按);不重複、不多出一則",
      zhTxt.indexOf(" ") < 0 && zhLine.textContent === zhTxt.replace("}up.done.replaced", "} up.done.replaced") && !!b2 && b2.textContent === "up.done.view" && msgs().length === nMsg);
    LANG = "zh"; upRelang();
    ok("切回 zh 也跟著回來;applyStatic 會叫 upRelang", zhLine.textContent === zhTxt && /if \(typeof upRelang === "function"\) upRelang\(\);/.test(fnSrc("applyStatic"))); }
  paint(idle, wu({ ts: 105, replaced_changed: ["a", "b"] }));
  ok("換了檔但沒有備份路徑:不出「查看」那一句(沒有東西可看)", last().textContent === 'up.done.cloud{"cv":"2026-09-24-b"}' && !btnOf(last()));
  const n0 = msgs().length; paint(idle, wu({ ts: 106, outcome: "restart_deferred", reason: "order in flight", replaced_changed: ["a"], backup_dir: ".official-backup/2026-09-22-p-20260924T051202Z" }));
  ok("restart_deferred(單子進行中):「新檔已就位…等這筆單完成後再說一次「更新」就會重啟」(沒有機器端 timer,不講主機會自己再試)+ 換掉的檔那一句照接", msgs().length === n0 + 1 && /^up\.done\.restartDeferredup\.done\.replaced/.test(last().textContent) && !!btnOf(last()));
  paint(idle, wu({ ts: 107, outcome: "restart_failed", reason: "failed" }));
  ok("restart_failed:重啟沒成那一句", msgs().length === n0 + 2 && last().textContent === "up.done.restartFailed");
  paint(idle, wu({ ts: 108, outcome: "up_to_date" })); paint(idle, wu({ ts: 109, state: "failed", outcome: "stopped", reason: "dirty" })); paint(idle, wu({ ts: 110, state: "failed", outcome: "error", reason: "x" })); paint(idle, wu({ ts: 111, state: "failed", outcome: "partial", reason: "kept" }));
  paint(idle, wu({ ts: 112, outcome: null })); paint(idle, cloud({ report: { workspace_update: { state: "applying", from: "a", to: "b", ts: 113 } } }));
  ok("up_to_date / failed(stopped、error、partial)/ outcome 不認得 / applying:不講", msgs().length === n0 + 2);
  ok("updated 沒帶版號:不講(不印「更新到 null」)", (paint(idle, wu({ ts: 114, to: null })), msgs().length === n0 + 2));
  ok("講過的記號在 localStorage(報告的 done 會停留到下一次更新,重開 app 不重講)", JSON.parse(store[UP_SAID_KEY]).indexOf("wu:100") >= 0 && (() => { const n = msgs().length; paint(idle, wu({})); return msgs().length === n; })());
  // 沒有 workspace_update 欄位的主機:只剩版號追上推得的那一句
  { const n = msgs().length; UPD.lagCv = null; UPD.done = null; paint(idle, cloud({ cloud: { config_version: "2026-09-22-p" } })); paint(idle, cloud());
    ok("退路:原本落後、之後版號追上 → 「雲端主機已更新到 {cv}。」一次;再追上同一版不重講", msgs().length === n + 1 && last().textContent === 'up.done.cloud{"cv":"2026-09-24-b"}' && (paint(idle, cloud()), msgs().length === n + 1)); }
  { // app 換版後第一次啟動、蓋過改動(主行程 syncOfficialOnUpdate 只在那時給):同 §3 的格式,「開啟資料夾」由主行程開 Finder
    const n = msgs().length, BK = { ...idle, backup: { n: 1, dir: ".official-backup/2026-09-22-p-20260924T0630/" } };
    paint(BK, cloud()); paint(BK, cloud());
    const m = last(), b = btnOf(m);
    ok("備份那一句:「Blave 已更新到 {av}。你改過的 {n} 個官方檔…(開啟資料夾)」講一次", msgs().length === n + 1 && m.textContent === 'up.backup{"av":"0.0.7","n":"1","dir":".official-backup/2026-09-22-p-20260924T0630/"}up.backup.open' && !!b && b.textContent === "up.backup.open");
    calls.length = 0; b.onclick();
    ok("「開啟資料夾」→ 主行程 updateShowBackup(路徑由主行程算,畫面不交路徑);main.js 用 shell.showItemInFolder 開 workspace 裡那個資料夾", calls.join() === "showBackup"
      && /handle\("update-show-backup", \(\) => \{ if \(!_officialBackup\) return false; shell\.showItemInFolder\(path\.join\(WS, _officialBackup\.dir\)\); return true; \}, false\);/.test(fs.readFileSync(path.join(R, "..", "main.js"), "utf8"))
      && /updateShowBackup: \(\) => ipcRenderer\.invoke\("update-show-backup"\)/.test(fs.readFileSync(path.join(R, "..", "preload.js"), "utf8")));
    ok("沒有備份 / 壞掉的 backup 不講", upBackupLine({ backup: null }) === null && upBackupLine({ backup: { n: 0, dir: "x" } }) === null && upBackupLine({ backup: { n: 2 } }) === null && upBackupLine(null) === null); }
  ok("upRich:雲端來的路徑裡長得像 {cv} 的字不會被再替換一次", (() => { const h = el(); upRich(h, "up.done.replaced", { n: 1, dir: "{n}{view}" }, { mono: ["dir"] }); return mono(h, "{n}{view}") && !/[\uE000-\uE002]/.test(h.textContent); })());
  { const S2 = fs.readFileSync(path.join(R, "strings.js"), "utf8"), zhS = S2.slice(S2.indexOf("zh:")), enS = S2.slice(0, S2.indexOf("zh:"));
    const has = (s, k, v) => new RegExp('"' + k.replace(/\./g, "\\.") + '": ' + JSON.stringify(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(s);
    ok("字(§4):關於列七種寫法與連結 zh / en", has(zhS, "up.row.app", "Blave {av}") && has(zhS, "up.row.cloud", "雲端主機 {cv}") && has(zhS, "up.row.cloudOff", "雲端主機（停機）") && has(zhS, "up.row.latest", "已是最新版") && has(zhS, "up.row.ready", "新版已下載")
      && !/"up\.row\.readyQuit"/.test(S2) && has(zhS, "up.row.applying", "更新中…") && has(zhS, "up.check", "檢查更新") && has(zhS, "up.restart", "重新啟動以完成更新") && has(zhS, "up.applying", "更新中…") && has(zhS, "tm.updateReady", "重新啟動以完成更新")
      && has(enS, "up.row.cloud", "Cloud machine {cv}") && has(enS, "up.row.cloudOff", "Cloud machine (stopped)") && has(enS, "up.row.latest", "Up to date") && has(enS, "up.restart", "Restart to finish updating") && has(enS, "tm.updateReady", "Restart to finish updating"));
    ok("字(§3):事後那一行 zh / en", has(zhS, "up.done.cloud", "雲端主機已更新到 {cv}。") && has(zhS, "up.done.cloudRestarted", "雲端主機已更新到 {cv}，自動下單已用新版重新啟動。") && has(zhS, "up.done.replaced", "你改過的 {n} 個官方檔換成了官方版，舊的在 {dir}（{view}）。")
      && has(zhS, "up.done.view", "查看") && has(zhS, "up.backup", "Blave 已更新到 {av}。你改過的 {n} 個官方檔換成了官方版，舊的在 {dir}（{view}）。") && has(zhS, "up.backup.open", "開啟資料夾")
      && has(zhS, "up.done.restartDeferred", "雲端主機的新檔已就位，但自動下單仍在跑舊版；等這筆單完成後再說一次「更新」就會重啟。") && has(enS, "up.done.restartDeferred", "The cloud machine has the new files, but auto-trading is still on the old code; once this order finishes, say 更新 again and it will restart.") && has(zhS, "up.done.restartFailed", "雲端主機的新檔已就位，但自動下單重新啟動失敗，仍在跑舊版；再說一次「更新」就會再試。") && has(zhS, "up.done.paused", "雲端主機已更新到 {cv}。自動下單仍暫停，按「啟動下單」才會繼續。")
      && has(enS, "up.done.cloud", "Cloud machine updated to {cv}.") && has(enS, "up.done.replaced", "{n} official files you had changed were replaced; the old copies are in {dir} ({view}).") && has(enS, "up.done.view", "view") && has(enS, "up.backup.open", "Open folder"));
    { // 0.1.11 設計稽核 S1:三句事後那一行講「自動下單」(跟 agent 的回覆句同一組字);restartDeferred 跟兩份 reference 的 restart_deferred 句逐字相同
      const V = require("vm").runInNewContext(S2.replace(/^const STRINGS/m, "var STRINGS") + "\nSTRINGS"), ref = ["updating.md", "cloud-handoff.md"].map((f) => fs.readFileSync(path.join(R, "..", "..", "references", f), "utf8"));
      const said = ["up.done.cloudRestarted", "up.done.restartFailed", "up.done.restartDeferred"].flatMap((k) => ["zh", "en"].map((l) => V[l][k]));
      ok("S1 up.done.cloudRestarted / restartFailed / restartDeferred = 定稿(zh / en),沒有「下單程式」/ order program;restartDeferred 跟 updating.md、cloud-handoff.md 逐字相同",
        V.en["up.done.cloudRestarted"] === "Cloud machine updated to {cv}; auto-trading restarted on the new version."
        && V.en["up.done.restartFailed"] === "The cloud machine has the new files, but auto-trading failed to restart and is still on the old code; say 更新 again to retry."
        && !said.some((x) => /下單程式|order program/.test(x))
        && ref.every((d) => d.includes("「" + V.zh["up.done.restartDeferred"] + "」 / \"" + V.en["up.done.restartDeferred"] + "\""))); }
    ok("S0–S7 那一套的字全清掉(up.c.* 只剩 up.c.msg;up.chat / up.update / up.latestAt / tm.cloudUpdate* 都不在)", !/"up\.c\.(unreach|stopped|note|noteLong|available|checking|seeChat|needsUpdate|running|runningShort|onCloud|runNote|noReport|done|doneFrom|chatRunning|chatDone)"/.test(S2)
      && !/"up\.(app|latest|latestAt|checking|downloading|downloadingPct|ready|blocked|error|staging|update|updating|chat|installLocal)"|"tm\.cloudUpdate(Stale)?"/.test(S2)); }

// 設定 › 帳號與方案(「資料與雲端方案」＋「帳號」併成一類;設計師規格 designer-spec-acct-plan)。整頁由 planPaint 畫——真的畫一次的檢查在下面「帳號與方案」那一塊
ok("登出不碰雲端主機(那一句是事實):外殼只撤 token、清記憶體裡上一個帳號的東西,沒有任何停機 / 停用方案的呼叫", (() => { const m = fs.readFileSync(path.join(R, "..", "main.js"), "utf8"), i = m.indexOf("async function signOutBlave()"), f = m.slice(i, m.indexOf("\n}\n", i));
  return /oauth\/desktop\/revoke/.test(f) && /clearToken\(\);/.test(f) && !/plan\/(stop|cancel)|machine|planStart|\/stop/.test(f); })());
ok("左欄底那一塊清乾淨:DOM / CSS / 程式都沒有舊的 id 與 class", !/id="set-acct"[^-]/.test(html) && !/set-acct-who|set-acct-st\b/.test(html + src) && !/\.set-acct \.(who|l1|l2|lbl|mail)|\.set-cats \.set-acct/.test(css));
const CATS = (re) => [...html.matchAll(re)].map((m) => m[1]).join();
ok("分類順序:一般 → 模型接入 → Agent 規則 → 資料來源 → 帳號與方案 → 公開連結 → 隱私(七個;Agent 規則 0.1.9 加在模型接入後面);每一類都有自己的頁;「帳號」那一頁與它的節點都拿掉了", CATS(/class="set-cat"[^>]*data-set-cat="([a-z]+)"/g) === "display,model,rules,src,plan,shares,priv" && CATS(/class="set-pane[^"]*" data-set-cat="([a-z]+)"/g) === "display,model,rules,src,plan,shares,priv"
  && !/set-acct-pane|acct-to-plan|acct-list|acct-a1|id="set-acct-btn"|id="acct-hint"/.test(html) && !/acct-to-plan|acct-list|acct-a1|acct\.in\.|acct\.toPlan/.test(src));
// 舊的兩個分類 id 都還開得到合併後的頁:真的跑 setCat
{ const mk = (k) => { const n = el(); n.dataset.setCat = k; return n; }, ids = ["display", "model", "src", "plan", "shares", "priv"], cats = ids.map(mk), panes = ids.map(mk); let painted = 0; const tracked = [];
  const run = new Function("$", "mdlPaint", "srcLoad", "srcClear", "rulesOpen", "rulesClear", "privLoad", "aboutIdLoad", "shlOpen", "planPaint", "trackFeature", "acctCheck", "balLoad", "pubLoad", "hasToken", fnSrc("setCat") + "; return setCat;")(
    (id) => (id === "set-cats" ? { querySelectorAll: () => cats } : id === "set-modal" ? { querySelectorAll: () => panes } : $(id)), () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => { painted++; }, (n) => tracked.push(n), () => {}, () => {}, () => Promise.resolve(), true);
  const open = (k) => { painted = 0; tracked.length = 0; run(k); return { cur: cats.filter((c) => c.attrs["aria-current"] === "true").map((c) => c.dataset.setCat).join(), shown: panes.filter((p) => !p.hidden).map((p) => p.dataset.setCat).join(), painted, tracked: tracked.join() }; };
  const a = open("acct"), b = open("plan");
  ok("setCat(\"acct\") 與 setCat(\"plan\") 開到同一頁:左欄亮「帳號與方案」、只露出那一頁、整頁重畫、埋點記 settings_plan", JSON.stringify(a) === JSON.stringify(b) && a.cur === "plan" && a.shown === "plan" && a.painted === 1 && a.tracked === "settings_plan");
  ok("別的分類不受影響", open("priv").shown === "priv" && open("display").cur === "display");
  const callers = ["library.js", "report-share.js", "report-sharelist.js", "app.js"].map((f) => fs.readFileSync(path.join(R, f), "utf8")).join("\n");
  ok("外殼裡開這一頁的呼叫點都用 plan(保險那一行只是防漏)", !/setCat\("acct"\)|data-set-cat="acct"/.test(callers + html) && /if \(cat === "acct"\) cat = "plan";/.test(fnSrc("setCat"))); }
const PO2 = ["zh", "en"].map((l) => fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", l + ".po"), "utf8"));
ok("那一類定名「一般」;指到它的句子(minv.trade)兩語都跟著改", /msgid "set\.cat\.display"\nmsgstr "一般"/.test(PO2[0]) && /msgid "set\.cat\.display"\nmsgstr "General"/.test(PO2[1])
  && /msgid "minv\.trade"\nmsgstr "[^\n]*設定 › 一般/.test(PO2[0]) && /msgid "minv\.trade"\nmsgstr "[^\n]*Settings › General/.test(PO2[1]));

// 設定 › 模型接入(三選一;連結畫面那張卡不再搬進設定)
const mdl = (() => { const a = src.indexOf("const MDL = {"), b = src.indexOf("/* ── 設定 › 模型接入 的純邏輯到此"); if (a < 0 || b < 0) throw new Error("找不到純邏輯區塊"); return src.slice(a, b); })();
if (/\bdocument\b|\$\(|window\./.test(mdl.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))) throw new Error("模型接入的純邏輯碰了 DOM");
eval(mdl.replace(/^const /gm, "var "));
const D = { claude: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: false } };
const shape = (o) => [o.kind, o.isCur, o.st && o.st.key, String(o.act)].join("|");
let M = mdlOptions(D, "claude", true);
// e2e 0.1.8 #100 #101:電腦版看得到 Blave 餘額、切到 Blave AI 之後講明會從餘額扣款(設計師第五批 c)。餘額怎麼讀、怎麼取整、讀不到畫什麼在 tests/check_shell_balance.js
{ const cut = (n) => { const i = src.indexOf("function " + n + "("); let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("no " + n); };
  ok("① 帳號與方案:Blave 餘額在最上面那一組裡(狀態點之前);沒登入整列不出;讀不到畫「—」、title 與 aria-label 用 plan.balNa", /if \(hasToken\) \{\s*const n = balNow\(\), row = el\("div", "plan-bal"\), val = el\("span", "v" \+ \(n \? "" : " na"\), n \? n \+ " TWD" : "—"\);\s*if \(!n\) \{ val\.title = t\("plan\.balNa"\); val\.setAttribute\("aria-label", t\("plan\.balNa"\)\); \}\s*row\.append\(el\("span", "l", t\("plan\.bal"\)\), val\); id\.append\(row\);\s*\}/.test(src)
    && src.indexOf('row = el("div", "plan-bal")') < src.indexOf('if (V.st) { const stEl = el("span", "plan-st "') && /\.plan-bal \.v \{ font-size: 13px; color: var\(--ink\); font-variant-numeric: tabular-nums; \}/.test(css) && !/plan-bal[^}]*mono/.test(css));
  ok("② 模型選單底部:引擎是 Blave AI 才出(連同分隔線);讀不到餘額只出規則那半句;打開選單與回合結束重讀", /const on = cur === "blave", n = on \? balNow\(\) : null;\s*\$\("mp-bill-div"\)\.hidden = !on; \$\("mp-bill"\)\.hidden = !on;/.test(src) && /\$\("mp-bill-sep"\)\.hidden = !n; \$\("mp-bill-bal"\)\.hidden = !n;/.test(src)
    && /<p class="mp-note" id="mp-note" aria-live="polite"><\/p>\s*<!--[^>]*-->\s*<div class="mp-div" id="mp-bill-div" hidden><\/div>\s*<p class="mp-note mp-bill" id="mp-bill" hidden>/.test(html)
    && /if \(cur === "blave" && hasToken\) balLoad\(\);/.test(cut("mpOpen")) && /\n  if \(cur === "blave" && hasToken\) balLoad\(\);/.test(src) && /\.mp-bill \.b \{ white-space: nowrap;/.test(css));
  ok("③ 模型接入:Blave AI 那一列先講怎麼收錢(cn.blave.descSet);連結畫面那張卡的 cn.blave.desc 不動", M[0].desc === "cn.blave.descSet" && /data-i18n="cn\.blave\.desc"/.test(html) && /msgid "cn\.blave\.desc"\nmsgstr "首次綁卡送 100 TWD 的 AI 額度，之後按用量計費"/.test(PO2[0])
    && /msgid "cn\.blave\.descSet"\nmsgstr "按用量從 Blave 餘額扣款。首次綁卡送 \{q\} TWD 的 AI 額度。"/.test(PO2[0]) && /msgid "mp\.billBal"\nmsgstr "Balance \{n\} TWD"/.test(PO2[1])); }
ok("三個選項、選一個:就緒的列不講狀態、動作一律「使用」;用中的那一列沒有動作(列尾「使用中」);不能用的列才講(尚未登入 + 登入)", M.length === 3 && shape(M[0]) === "blave|false||cn.use" && shape(M[1]) === "claude|true||null" && shape(M[2]) === "codex|false|st.notSignedIn|cn.signIn");
ok("「切換」「連結」同一個動作同一個字:三列都用 cn.use,設定頁不再出現 cn.blave.switch / cn.connect / st.signedIn", mdlOptions(D, "codex", true)[1].act === "cn.use" && mdlOptions(D, "codex", true)[0].act === "cn.use"
  && !/cn\.blave\.switch|cn\.connect|st\.signedIn/.test(mdl + fnSrc("mdlPaint")));
ok("沒登入 Blave、現在用的是本機 agent:那一列是「登入並切換」(不是「登入 Blave」)", mdlOptions(D, "claude", false)[0].act === "cn.blave.signinSwitch" && mdlOptions(D, null, false)[0].act === "cn.blave.btn" && mdlOptions(D, "claude", false)[0].st.key === "st.notSignedIn");
M = mdlOptions({ claude: { installed: false }, codex: { installed: false } }, "blave", true);
ok("用的是 Blave AI:那一列 is-cur、沒有動作、不講狀態;沒裝的兩列「未偵測到」、沒有鈕", shape(M[0]) === "blave|true||null" && shape(M[1]) === "claude|false|st.notFound|null" && shape(M[2]) === "codex|false|st.notFound|null");
M = mdlOptions(D, "claude", false, { login: "codex" });
ok("等待登入中:那一列變「取消等待」(這一頁每次重畫都是新節點,等待狀態要在資料裡);其餘鈕由 waiting 鎖住", M[2].act === "login.cancel" && /b\.disabled = waiting && o\.act !== "login\.cancel"/.test(src) && /if \(o\.act === "login\.cancel"\) return window\.blave\.cancelAgentLogin\(\)/.test(src));
ok("等待 OAuth 中:Blave 那一列變「取消」,等待結束會重畫(不然「取消」留在畫面上)", mdlOptions(D, "claude", false, { oauth: true })[0].act === "oauth.cancel" && /oauthPending = false;\n    b\.textContent = was;\n    waitChanged\(\);/.test(src));
M = mdlOptions(null, "claude", true);
ok("偵測中:兩列只換狀態字、不給動作(列數不變);Blave 那一列不受偵測影響", shape(M[1]) === "claude|false|cn.detecting|null" && shape(M[2]) === "codex|false|cn.detecting|null" && M[0].act === "cn.use");
ok("「重新偵測」只在本機有一個不能用時出:兩個都就緒不出、還沒偵測過不出", !mdlNeedsRedetect({ claude: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: true } })
  && mdlNeedsRedetect(D) && mdlNeedsRedetect({ claude: { installed: true, loggedIn: true }, codex: { installed: false } }) && !mdlNeedsRedetect(null));
{ // mdlPaint 真的畫一次(假 DOM):全部就緒 → 只有「使用」「使用」「使用中」;一個沒登入 → 那一列講、本機那組底下出「重新偵測」(安靜文字鈕,不在組標題)
  var MDL = MDL || { busy: false }, lastDetect = null, loginPending = null, detect = () => {}, mdlAct = () => {}, planVars = () => ({ q: "100" }); hasToken = true;
  eval(fnSrc("mdlPaint"));
  const walk = (n, out = []) => { (n.children || []).forEach((c) => { if (c && typeof c === "object") { out.push(c); walk(c, out); } }); return out; };
  const texts = () => walk($("set-model")).map((n) => [n._cls, n.textContent]);
  lastDetect = { claude: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: true } }; cur = "codex"; mdlPaint();
  let all = walk($("set-model")), btns = all.filter((n) => n._cls === "pf-act").map((n) => n.textContent), quiet = all.filter((n) => /btn-quiet/.test(n._cls));
  ok("全部就緒:整頁只有「使用」「使用」「使用中」,沒有「已登入」、沒有「重新偵測」", btns.join() === "cn.use,cn.use" && all.some((n) => n._cls === "cn-cur" && n.textContent === "cn.current")
    && !texts().some(([, x]) => /st\.signedIn|cn\.redetect/.test(x)) && quiet.length === 0);
  lastDetect = { claude: { installed: true, loggedIn: false }, codex: { installed: false } }; cur = "blave"; mdlPaint();
  all = walk($("set-model")); const more = all.find((n) => n._cls === "cn-more"), rb = more && more.children[0];
  const grpH = all.filter((n) => n._cls === "cn-grp-h");
  ok("一個沒登入:那一列「尚未登入」+〔登入〕,沒裝的「未偵測到」沒有鈕;本機那組底下出安靜的「重新偵測」、組標題裡沒有鈕",
    all.some((n) => n._cls === "st" && n.textContent === "st.notSignedIn") && all.some((n) => n._cls === "st" && n.textContent === "st.notFound")
    && all.filter((n) => n._cls === "pf-act").map((n) => n.textContent).join() === "cn.signIn" && !!rb && rb._cls === "btn-quiet" && rb.textContent === "cn.redetect" && more.dataset.kind === "redetect"
    && grpH.every((h) => !walk(h).some((c) => /pf-act|btn-quiet/.test(c._cls)))); }
ok("連結畫面那張卡不再搬進設定(兩邊各畫各的,共用的是底下的邏輯)", !/set-model"\)\.appendChild\(document\.querySelector\("\.cn-card"\)\)/.test(src) && !/\$\("cn-foot"\)\.before\(/.test(src) && /function mdlPaint\(\)/.test(src) && /id="set-model"[^>]*><\/div>/.test(html));
ok("登入 / 連結完重畫之後,焦點回同一列的鈕(兩個表面都靠 data-kind)", /if \(kind\) div\.dataset\.kind = kind;/.test(src) && /r\.dataset\.kind = o\.kind;/.test(src) && /host\(\)\.querySelector\('\[data-kind="' \+ kind \+ '"\] button'\)/.test(src));
ok("模型接入頁的小框鈕只亮這一頁(不動全站的 .pf-act);「使用中」= 灰填 + 加粗 + 列尾三個字", /#set-model \.pf-act\{[^}]*--ink-2/.test(css) && /\.cn-opt\.is-cur\{background:var\(--surface-muted\)\}/.test(css) && /\.cn-opt\.is-cur \.n\{font-weight:600\}/.test(css));
ok("字串:設定頁那一列是「Blave AI」,連結畫面的動詞句「用 Blave AI」照舊", /msgid "cn\.blave\.name"\nmsgstr "Blave AI"/.test(PO2[0]) && /msgid "cn\.blave\.title"\nmsgstr "用 Blave AI"/.test(PO2[0]) && /data-i18n="cn\.blave\.title"/.test(html));
ok("字串:本機那一組改成「用你自己的 AI」(0.1.16 API 金鑰同組一列,audit 方案一),群組小標「由 Blave 提供」", /msgid "cn\.local\.label"\nmsgstr "用你自己的 AI"/.test(PO2[0]) && /msgid "cn\.blave\.group"\nmsgstr "由 Blave 提供"/.test(PO2[0]));

// 重畫吃掉焦點 → Esc 關不掉設定(R3-1:「重新偵測」那一顆被銷毀時踩到)
ok("重新偵測那一組掛的是 data-kind(焦點還原查的就是它),不是 data-k", /m\.dataset\.kind = "redetect";/.test(src) && !/dataset\.k = /.test(fnSrc("mdlPaint")) && /querySelector\('\[data-kind="' \+ focusKind\.kind \+ '"\] button'\)/.test(src));
ok("設定裡重畫過的每一塊都過同一關:焦點掉到 BODY 或掉出 modal 就放回框內(不靠個別欄位名猜對)", /function setFocusGuard\(\) \{[\s\S]{0,400}a !== document\.body && \$\("set-modal"\)\.contains\(a\)/.test(src)
  && ["mdlPaint", "acctPaintAcct", "privPaint"].every((n) => /setFocusGuard\(\);\n\}/.test(fnSrc(n))));
// V4:等待狀態(oauthPending / planLoginBusy)是一件事、兩份 DOM。列舉:凡是改這兩個旗標的地方都要重畫兩個表面
// 每一個**指派點**(不是每一個函式)後面三行內要看到 waitChanged():同一支裡漏掉其中一次也要抓得到
const bare = src.replace(/^\s*\/\/.*$/gm, "");   // 註解掉的程式不算數
const sites = [...bare.matchAll(/^[^\n]*\b(?:oauthPending|planLoginBusy) = (?!false, |null)[^\n]*$/gm)].filter((m) => !/^let /.test(m[0].trim()));
const late = sites.filter((m) => !/waitChanged\(\)/.test(bare.slice(m.index, m.index + 400).split("\n").slice(0, 4).join("\n"))).map((m) => m[0].trim().slice(0, 40));
ok("改了等待旗標的每一處都重畫兩個表面(共 " + sites.length + " 處" + (late.length ? ";漏的:" + late.join(" / ") : "") + ")", sites.length >= 7 && late.length === 0 && /function waitChanged\(\) \{ mdlPaint\(\); acctPaintAcct\(\); \}/.test(bare));
// (V4(a) 帳號頁自己的「取消」鈕隨那一頁退場:未登入時這一頁唯一的鈕是頁尾那顆,等待中它就是「取消」——planLogin 的第一行)
ok("V4(a) 頁尾那顆「取消」按得動", /if \(planLoginBusy\) \{ window\.blave\.cancelOAuth\(\); return; \}/.test(fnSrc("planLogin")));
ok("V1 上一則不會活過下一次登入(離線登出那句只有 detect() 會清)", /^\s*setHint\(null\);/m.test(fnSrc("planLogin").replace(/^\s*\/\/.*$/gm, "")));
ok("V2 確認框 / 圖片放大開著時,焦點歸它們(不靠 inert 讓 focus\(\) 變 no-op)", /if \(!\$\("del-scrim"\)\.hidden \|\| !\$\("lb-scrim"\)\.hidden\) return;/.test(fnSrc("setFocusGuard")));
ok("模型接入那一頁畫得出共用的那一則(它是三個表面之一)", /if \(HINT\) \{ const p = el\("p", "cn-hint"\);/.test(fnSrc("mdlPaint")));

// 訊息格 #acct-hint:一個寫入者(planPaint)
ok("訊息格只由 planPaint 寫:index.html 沒有那個節點、程式裡只有一處建它;共用訊息變了會叫到它(setHint → acctPaintAcct → 那一頁開著就 planPaint)", !/id="acct-hint"/.test(html) && (src.match(/"acct-hint"/g) || []).length === 1 && /hint\.id = "acct-hint"; hint\.hidden = !HINT;/.test(fnSrc("planPaint"))
  && /\n  mdlPaint\(\);\n  acctPaintAcct\(\);\n/.test(fnSrc("setHint")) && /if \(!\$\("set-scrim"\)\.hidden && !\$\("set-plan"\)\.hidden\) planPaint\(\);/.test(fnSrc("acctPaintAcct")) && !/acctPaintAcct\(\)/.test(fnSrc("planPaint")));
ok("登出沒撤成那句到得了這一頁", /setHint\(\{ text: t\("cn\.blave\.signOutLocalOnly"\) \}\)/.test(src));
ok("字串:合併後的頁名、確認框、刪掉的五個 key(zh / en)", /msgid "set\.cat\.plan"\nmsgstr "帳號與方案"/.test(PO2[0]) && /msgid "set\.cat\.plan"\nmsgstr "Account & plan"/.test(PO2[1]) && /msgid "pv\.e\.btn"\nmsgstr "Account & Plan"/.test(PO2[1])
  && /msgid "acct\.cf\.title"\nmsgstr "登出 Blave？"/.test(PO2[0]) && /msgid "acct\.cf\.ok"\nmsgstr "Sign Out"/.test(PO2[1]) && /msgid "acct\.out\.4"\nmsgstr "登出不會停用雲端主機，主機費照扣。"/.test(PO2[0])
  && PO2.every((p) => !/msgid "lib\.gate\.unknown"/.test(p)) && PO2.every((p) => !/msgid "(set\.cat\.acct|acct\.toPlan|acct\.toPlanBtn|acct\.in\.1|acct\.in\.2)"/.test(p) && !/資料與雲端方案|Data & [Cc]loud [Pp]lan/.test(p)));
ok("agent 文件裡的頁名跟著改", /Settings › 帳號與方案 \(en: Account & plan\)/.test(fs.readFileSync(path.join(__dirname, "..", "references", "billing.md"), "utf8")) && /Sign in from Settings › Account & plan/.test(fs.readFileSync(path.join(__dirname, "..", "references", "cloud-handoff.md"), "utf8")));
ok("字串:acct.out.3 照定稿(不跟 acct.out.2「對話留在這台電腦」打架)", /msgid "acct\.out\.3"\nmsgstr "你現在用的是 Blave AI，登出會回到選 AI 的畫面，要先選一個才能繼續用。"/.test(PO2[0]));
// 聊天欄捲動邊界:靜止沒有線,捲起來才浮一條
ok("捲動時才出現的那條線:兩層捲動都掛、以看得見的那一層為準;靜止沒有線", /\.chat-head\.is-scrolled \{ box-shadow: 0 1px 0 var\(--border-hairline\); \}/.test(css) && !/\.chat-head \{[^}]*box-shadow/.test(css)
  && /\$\("chat-scroll"\)\.addEventListener\("scroll", chatEdge\)/.test(src) && /\$\("cs-list"\)\.addEventListener\("scroll", chatEdge\)/.test(src) && /list\.hidden \? \$\("chat-scroll"\) : list/.test(src));
ok("搬家留下的死規則與舊註解清掉", !/\.set-pane \.cn-(card|sec)/.test(css) && !/把 \.cn-card 整個搬進來/.test(html));

// 頂列那條帶子:視窗頂是同一條標題帶,三段(側欄 ::before、中欄 .tb、右欄 .chat-head 與它收合後的漸層)必須同高——
// 以後改一處漏一處,這一則會紅。.tb 還要用負的 margin 把自己疊回那一條上,值也得跟著
const BAR = [["app.css .cn-bar/.ws-bar", /\.cn-bar, \.ws-bar \{[^}]*height: (\d+)px/, css], ["app.css .pane-strategies/.pane-main padding-top", /\.pane-strategies, \.pane-main \{ padding-top: (\d+)px/, css],
  ["app.css html.ws-sc .pane-strategies padding-top", /html\.ws-sc \.pane-strategies \{ width: 44px; padding: (\d+)px/, css], ["app.css .chat-head", /\.chat-head \{\s*flex: none; height: (\d+)px/, css],
  ["app.css .cn-mid padding-bottom", /\.cn-mid \{[^}]*padding-bottom: (\d+)px/, css], ["trade.css .tb height", /\.pane-main > \.tb \{\s*flex: none; height: (\d+)px/, trcss],
  ["trade.css .tb margin-top", /\.pane-main > \.tb \{\s*flex: none; height: \d+px; margin-top: -(\d+)px/, trcss], ["trade.css 側欄 ::before", /\.pane-strategies::before \{[^}]*height: (\d+)px/, trcss],
  ["trade.css .chat-strip 漸層(上)", /linear-gradient\(var\(--surface-muted\) (\d+)px/, trcss], ["trade.css .chat-strip 漸層(下)", /var\(--surface-card\) (\d+)px\)/, trcss]];
const bars = BAR.map(([name, re, text]) => { const m = text.match(re); return [name, m ? m[1] : "找不到"]; });
ok("頂列三段同高(" + [...new Set(bars.map((b) => b[1]))].join("/") + "):" + bars.filter((b) => b[1] !== "52").map((b) => b[0]).join() , bars.every((b) => b[1] === "52"));
ok("紅綠燈對到那條帶子的中線(帶子 52 → 中線 26 → 燈 y=19)", /trafficLightPosition: \{ x: 12, y: 19 \}/.test(fs.readFileSync(path.join(R, "..", "main.js"), "utf8")));
ok("不該跟著動的 44 還在:側欄細軌的寬、收合後的寬、選項列與分類鈕的熱區下限", /html\.ws-sc \.pane-strategies \{ width: 44px;/.test(css) && /off: 44/.test(src) && /\.cn-opt\{[^}]*min-height:44px/.test(css) && /\.cn-row \{[\s\S]{0,120}min-height: 44px;/.test(css));

// 頂列底線
ok("中欄頂列與聊天頭沒有底線;雲端那兩條 transparent 跟著退場(沒有線可以透明)", !/\.pane-main > \.tb \{[^}]*border-bottom/.test(trcss) && !/\.chat-head \{[^}]*border-bottom/.test(css) && !/border-bottom-color: transparent/.test(trcss.split("html\[data-env")[1] || ""));
ok("分頁列與欄界那幾條線留著", /\.main-tabs \{[^}]*border-bottom: 1px solid var\(--border-hairline\)/.test(trcss) && /\.modal-head \{[^}]*border-bottom/.test(css));
ok("CSS:舊的三條規則與 .set-up 樣式清掉", !/\.set-acct \.(lbl|mail|btn-quiet)|\.set-up-txt|\.set-up \.btn-quiet/.test(css));
ok("字標拿掉:DOM / CSS / 程式都沒有 .ws-brand 與 #ws-home;收合鈕上距 12", !/ws-brand|ws-home/.test(html + css + src) && /html\.ws-sc \.side-rail \{[^}]*padding-top: var\(--space-12\);/.test(css));
ok("分隔線:帳號那一塊、「關於」上面、AI 接入頁列間那三條拿掉;標題列下緣、左右欄直線、方案頁的腳留著", !/\.set-acct[^{]*\{[^}]*border-top/.test(css) && !/\.set-about \{[^}]*border-top/.test(css) && !/\.cn-row \+ \.cn-row/.test(css)
  && /\.modal-head \{[^}]*border-bottom/.test(css) && /\.set-cats\s*\{[^}]*border-right/.test(css) && /\.plan-foot\s*\{[^}]*border-top/.test(css));
// 設定 › 隱私
const PO = ["zh", "en"].map((l) => fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", l + ".po"), "utf8"));
ok("隱私:分類排最後、開關是 role=switch + aria-checked、即時生效(切換後以主行程回的為準)", /data-set-cat="shares"[^>]*><\/button>\s*\n\s*(<!--[\s\S]*?-->\s*\n\s*)?<button[^>]*data-set-cat="priv"[^>]*><\/button>\s*\n\s*<\/nav>/.test(html)
  && /setAttribute\("role", "switch"\)/.test(fnSrc("privPaint")) && /aria-checked/.test(fnSrc("privPaint")) && /PRIV = \(await window\.blave\.telemetrySet\(want\)\) === true/.test(src));
ok("隱私:會收 8 條(功能那條緊接在里程碑後、0.1.9「卡在哪一步」再接在功能後、0.1.13 免登入下載的安裝識別碼接在安裝識別碼後、0.1.10 帳號狀態一併回報的那條排最後)、不收 6 條(含「事件紀錄不含 IP 位址」原話);關掉後清單留著、標題與尾句換掉", /PRIV_COLLECT = \["priv\.collect\.1", "priv\.collect\.5", "priv\.collect\.6", "priv\.collect\.2", "priv\.collect\.3", "priv\.collect\.4", "priv\.collect\.8", "priv\.collect\.7"\]/.test(src) && /PRIV_NEVER = \[("priv\.never\.[1-6]",? ?){6}\]/.test(src)
  && /msgid "priv\.never\.6"\nmsgstr "事件紀錄不含 IP 位址"/.test(PO[0]) && /msgid "priv\.never\.6"\nmsgstr "Event records contain no IP address"/.test(PO[1])
  && /off \? t\("priv\.collect\.hOff"\) : t\("priv\.collect\.h"\)/.test(src) && /off \? t\("priv\.kept"\) : t\("priv\.fine"\)/.test(src));
{ // 隱私開關連點(0.1.10 #9-1):上一次還沒回來,後面幾下不送;回來了(成功或丟例外)才解鎖。不用 disabled——焦點會掉到 body
  const sent = [], answer = [];
  const env = { PRIV: true, privPaint: () => {}, srSay: () => {}, t: (k) => k, $: () => ({ focus() {} }),
    window: { blave: { telemetrySet: (v) => { sent.push(v); return new Promise((ok, no) => answer.push({ ok, no })); } } } };
  const decl = (src.match(/^let PRIV_BUSY = false;$/m) || [""])[0].replace(/^let /, "var ");
  const toggle = new Function("env", "with (env) { " + decl + "\nasync " + fnSrc("privToggle") + "\nreturn privToggle; }")(env);
  const p1 = toggle(); toggle(); toggle();
  ok("隱私開關:連點三下,主行程只收到一次(關)", JSON.stringify(sent) === "[false]");
  answer[0].ok(false); await p1;
  const p2 = toggle();
  ok("隱私開關:回來之後解鎖,下一下照送(開)", env.PRIV === false && JSON.stringify(sent) === "[false,true]");
  answer[1].no(new Error("ipc")); await p2; toggle();
  ok("隱私開關:主行程丟例外也解鎖,畫面維持原狀", env.PRIV === false && sent.length === 3);
  ok("隱私開關:鎖是旗標,不是把開關 disabled(焦點留在開關上)", !/disabled/.test(fnSrc("privToggle"))); }
{ /* 法遵入口(法遵稽核):app 裡本來連一個服務條款 / 隱私權政策的連結都沒有,而隱私權政策 §9.1 還叫人到
     設定 › 隱私 關遙測(安裝識別碼後來搬到 設定 › 一般 › 關於)。隱私權政策放隱私那一頁、服務條款跟版本資訊放「關於」;兩個都外開瀏覽器、網址帶目前語言。
     **不加同意步驟、不擋畫面**(Wei 還沒決定任何接受流程) */
  const seen2 = []; const realOpen = window.blave.openExternal;
  window.blave.openExternal = (u) => { seen2.push(u); };
  // privPaint 真的跑一次(假 DOM 夠用:它只用 createElement / append / textContent)
  eval(src.match(/const PRIV_COLLECT = [^\n]*;/)[0].replace(/^const /, "var ")); eval(src.match(/const PRIV_NEVER = [^\n]*;/)[0].replace(/^const /, "var "));
  eval(src.match(/^const legalUrl = [^\n]*$/m)[0].replace(/^const /, "var "));
  var PRIV = true, privToggle = () => {}, srSay = () => {};
  eval(fnSrc("privPaint"));
  LANG = "zh"; privPaint();
  // privPaint 用 document.createElement 組節點,不經過 $():從 #set-priv 的子樹把那顆鈕找出來
  const findBtn = () => { const out = []; const walk = (n) => { if (!n || !n.children) return; n.children.forEach((c) => { if (c && typeof c === "object") { if (c.onclick && c.textContent === "legal.privacy") out.push(c); walk(c); } }); }; walk($("set-priv")); return out[0]; };
  const pl = findBtn();
  if (pl && pl.onclick) pl.onclick();
  ok("隱私那一頁有「隱私權政策」,點了外開 /disclaimer/zh/privacy_policy(不是寫死英文)", !!pl && seen2.join() === "https://blave.org/disclaimer/zh/privacy_policy");
  LANG = "en"; privPaint(); { const b2 = findBtn(); if (b2 && b2.onclick) b2.onclick(); }
  ok("換語言之後網址跟著換", seen2[1] === "https://blave.org/disclaimer/en/privacy_policy");
  ok("「關於」那一塊有服務條款,點了外開 /disclaimer/<lang>/terms_of_service;走既有的 openExternal,沒有自己另開一套",
    /<p class="set-legal"><button type="button" class="btn-quiet" id="set-terms" data-i18n="legal\.terms"><\/button> <span aria-hidden="true">·<\/span> <button type="button" class="btn-quiet" id="set-privacy" data-i18n="legal\.privacy"><\/button><\/p>/.test(html)
    && /\$\("set-terms"\)\.addEventListener\("click", \(\) => window\.blave\.openExternal\(legalUrl\("terms_of_service"\)\)\);/.test(src)
    && /\$\("set-privacy"\)\.addEventListener\("click", \(\) => window\.blave\.openExternal\(legalUrl\("privacy_policy"\)\)\);/.test(src)
    && /const legalUrl = \(page\) => "https:\/\/blave\.org\/disclaimer\/" \+ LANG \+ "\/" \+ page;/.test(src)
    && /\.set-legal \{ margin: var\(--space-16\) 0 0; font-size: 12px; color: var\(--ink-3\); \}/.test(css)
    && (() => { const a = html.indexOf('<p class="set-legal">'), row = html.slice(a, html.indexOf("</p>", a)); return !/使用|同意|agree/i.test(row.replace(/<[^>]+>/g, "")) && row.replace(/<[^>]+>/g, "").trim() === "·"; })());
  ok("兩個字都在(zh / en)", /msgid "legal\.terms"\nmsgstr "服務條款"/.test(PO[0]) && /msgid "legal\.terms"\nmsgstr "Terms of Service"/.test(PO[1])
    && /msgid "legal\.privacy"\nmsgstr "隱私權政策"/.test(PO[0]) && /msgid "legal\.privacy"\nmsgstr "Privacy Policy"/.test(PO[1]));
  ok("**沒有**同意步驟 / 擋畫面:沒有 accept / agree / consent 那一類的閘門", !/legal\.(accept|agree|consent)|acceptTerms|consentGate/.test(src + html + PO[0] + PO[1]));
  // 署名從 NOTICE 讀出來再去 LICENSE 找,不寫死字串:法人名稱改了(2026-09-23 從
  // 「Blave」改成正式公司名)時,兩個檔一起改才會綠,只改一邊就紅——寫死的話
  // 只會變成「改名字就要順手改測試」,守不到「兩份不一致」這件事
  { const lic = fs.readFileSync(path.join(__dirname, "..", "LICENSE"), "utf8");
    const notice = fs.readFileSync(path.join(__dirname, "..", "NOTICE"), "utf8");
    const m = notice.match(/^Copyright .+$/m);
    ok("LICENSE 的 Apache 樣板佔位已經填成 repo 自己的署名(同 NOTICE)",
      !!m && lic.includes("\n   " + m[0] + "\n") && !/\[yyyy\]|\[name of copyright owner\]/.test(lic)); }
  window.blave.openExternal = realOpen; LANG = "zh"; }
// 事件數跟告知綁在一起:加事件而沒補「會收」那幾條,這裡就紅(canon product-telemetry 出貨清單第 5 條)
ok("隱私:會收那一條寫到作業系統與版本、系統語言(spec-0.1.13 #12:Windows 也看得到這一條,不寫 macOS);二十三個事件逐項對得上契約的白名單(feature_used 是「用了哪些功能」那一條:名稱、每日一次、不含內容;0.1.9 的九個與 0.1.12 的引擎安裝兩個是「卡在哪一步」那一條:只記類別;heartbeat 是里程碑那一條的「app 開著的每一天」;0.1.13 的 lib_pick / idea_sent 在功能那一條講到:用策略庫的策略記要不要 Blave 資料、送出找點子記哪個入口;0.1.15 的 detect_fail 是「卡在哪一步」那條的「連不上 AI 的原因類別」)", /app 版本、作業系統與版本、系統語言/.test(PO[0]) && /The app version, operating system and version, and system language/.test(PO[1]) && Object.keys(require("../shell/telemetry.js").EVENTS).length === 23 && /首次開啟、每日開啟、app 開著的每一天（含本機自動下單有沒有在跑）、完成連結（哪一種 AI）、登入、第一次回測、啟動下單（模擬或真錢）、上雲端運行/.test(PO[0])
  && /each day the app stays open \(and whether local auto-trading is running\)/.test(PO[1])
  && /msgid "priv\.collect\.5"\nmsgstr "用了哪些功能：分頁與按鈕的名稱，每天每項記一次，不含裡面的內容；從策略庫用一支策略時，記它要不要 Blave 資料；送出找點子時，記是從哪個入口送出"/.test(PO[0]) && /msgid "priv\.collect\.5"\nmsgstr "Which features you used: tab and button names, once per item per day, without their content; when you use a library strategy, whether it needs Blave data; when you send an idea request, which entry point it came from"/.test(PO[1])
  && (() => { const ev = require("../shell/telemetry.js").EVENTS, c5 = (L) => (PO[L].match(/msgid "priv\.collect\.5"\nmsgstr "([^"]*)"/) || [])[1] || "";   // 兩個新事件真的有被講到:事件還在白名單上,面板就要有對應那半句
    return !!ev.lib_pick && !!ev.idea_sent && /要不要 Blave 資料/.test(c5(0)) && /哪個入口/.test(c5(0)) && /whether it needs Blave data/.test(c5(1)) && /which entry point/.test(c5(1)); })()
  && /msgid "priv\.collect\.6"\nmsgstr "卡在哪一步：回合失敗、連不上 AI、策略庫用不了的原因類別，綁卡／儲值提示有沒有出現與按下、回來後能不能用，啟動雲端方案的結果，更新卡在哪一步，第一次收到 AI 回覆，第一次安裝或更新後補裝（引擎與策略套件）有沒有裝好、沒裝好是哪一類原因；只記類別，不含內容"/.test(PO[0])
  && /msgid "priv\.collect\.6"\nmsgstr "Where things got stuck: the category of a failed turn, a failed AI connection or a blocked library strategy, whether a card or top-up prompt appeared and was clicked and whether your account was ready when you came back, the result of starting a cloud plan, which update step failed, your first AI reply, and whether the first-run or post-update setup of this computer \(engine and strategy packages\) finished and, if not, the category of the reason — categories only, never the content"/.test(PO[1]));
ok("acct.sub 開通試用那句兼講期限(Wei 核准 0.1.10):zh / en 逐字", /msgid "acct\.sub"\nmsgstr "首次綁卡，\{t\} 天內有 \{q\} TWD 的 AI 額度，電腦版也拿得到 Blave 的資料。"/.test(PO[0])
  && /msgid "acct\.sub"\nmsgstr "A first-time card gets \{q\} TWD of AI credit and Blave data in the desktop app, both for \{t\} days\."/.test(PO[1]));
// 例外只有報告分享的掛名二選一(shr.anon):那是公開頁上作者欄真的不出名字,不是在講追蹤資料匿名
ok("隱私 0.1.13(Wei 核准草稿 §B):priv.collect.8 講免登入下載記哪一支 + 安裝識別碼、登入後對上帳號;priv.never.2 收窄成「你自己的策略」", /msgid "priv\.collect\.8"\nmsgstr "沒登入或登入失效時從策略庫下載免登入策略：哪一支（策略庫編號）和安裝識別碼，用來算安裝人數；之後登入就會跟你的帳號對上"/.test(PO[0])
  && /msgid "priv\.collect\.8"\nmsgstr "When you download a no-sign-in library strategy: which one \(its library number\) and the installation ID, to count installs; once you sign in, it is linked to your Blave account"/.test(PO[1])
  && /msgid "priv\.never\.2"\nmsgstr "你自己的策略：程式碼與名稱"/.test(PO[0]) && /msgid "priv\.never\.2"\nmsgstr "Your own strategies' code and names"/.test(PO[1]));
ok("全 app 的字串不出現「匿名 / anonymous」(報告分享的掛名選項 shr.anon 除外);首次告知的 priv.notice* 沒有建", PO.every((x) => !/匿名|anonym/i.test(x.replace(/^#.*$/gm, "").replace(/msgid "shr\.anon"\nmsgstr "[^"]*"/, ""))) && PO.every((x) => !/priv\.notice/.test(x)) && !/telemetryNoticed/.test(src));
// 設定 › 資料與雲端方案 › 主機運行中那格:主鈕是「切到雲端」(關設定 + 走切換器同一個守門入口),不再外開網頁(Wei:不用前往工作頁了)
{
  const node = () => { const n = el(); n.dataset = {}; n.querySelectorAll = () => []; n.contains = () => false; n.firstChild = null;
    n.addEventListener = (_ev, fn) => { n._on = fn; }; n._click = () => n._on && n._on({ currentTarget: n }); return n; };
  dom["set-plan"] = node(); document.createElement = node;
  const seen = [];
  window.blave.openExternal = (u) => { seen.push("ext:" + u); };
  const setClose = () => { seen.push("close"); }, envSwitchGuarded = (e) => { seen.push("env:" + e); return true; };
  let acct = { plan: { state: "running" } }, acctPending = 0, planBusy = false, planSince = 0, planSlowSaid = false, planErr = null, planLastView = null, planMoreOpen = false;
  const PLAN_SLOW_MS = 1e9, srSay = () => {}, planAsk = () => {}, planLogin = () => {}, acctCheck = () => {}, acctUrl = () => "acct", planWebUrl = () => "https://blave.org/agent/zh", planState = () => acct.plan.state;
  let PV_P = "", PV_R = "", PV_N = 0, PV_H = "";
  const planVars = () => ({ p: PV_P, h: PV_H, m: "", a: "", b: "", v: "", t: "", q: "", top: "", d: "", n: PV_N, name: "Claude Code", r: PV_R });
  eval(fnSrc("dataAccessOf")); const usageUrl = () => "usage"; eval(src.match(/^const pvK = [^\n]*$/m)[0].replace(/^const /, "var "));
  const envPlanChanged = undefined;
  hasToken = true; cur = "claude";
  let balLast = null; eval(fnSrc("balNum")); eval(fnSrc("balNow"));   // 餘額由 balLoad 讀進 balLast(主行程的端點);這裡直接給值
  eval(fnSrc("planView")); eval(src.match(/^function planToCloud\(\).*$/m)[0]); eval(fnSrc("planPaint"));
  // 最上面一組(.plan-id):帳號列 → 訊息格 → 餘額列;餘額列是這一組的第三個子節點
  const balRow = () => dom["set-plan"].children[0].children[0].children[2];
  { planPaint(); const row = balRow(), val = row.children[1];
    ok("① 真的畫一次:還沒讀到餘額 →「Blave 餘額　—」;讀到就是「1,235 TWD」(四捨五入)", dom["set-plan"].children[0].children[0].className === "plan-id" && row.className === "plan-bal" && row.children[0].textContent === "plan.bal" && val.textContent === "—" && val.className === "v na" && val.title === "plan.balNa"
      && (balLast = balNum(1234.9), planPaint(), balRow().children[1].textContent) === "1,235 TWD", row.className + "|" + val.textContent);
    balLast = null; }
  { // ── 帳號與方案:最上面那一組、登出的確認框、訊息格(真的跑 planPaint / acctOutAsk / acctPaintAcct)──
    const boxes = []; const confirmBox = (o) => { boxes.push(o); }; let oauthPending = false; const acctSignOut = () => {};
    eval(fnSrc("acctOutAsk")); eval(fnSrc("acctPaintAcct"));
    const walkP = (n, out = []) => { (n.children || []).forEach((c) => { if (c && typeof c === "object") { out.push(c); walkP(c, out); } }); return out; };
    const page = () => { const all = walkP(dom["set-plan"]), sc = all.find((n) => n.className === "plan-scroll"), id = all.find((n) => n.className === "plan-id"), rows = id ? id.children.filter((c) => c.className === "plan-bal") : [];
      const row = (r) => r && { l: r.children[0].textContent, v: r.children[1].textContent, vCls: r.children[1].className, btn: r.children[2] || null };
      return { first: !!sc && sc.children[0] === id, who: row(rows[0]), bal: row(rows[1]), rows: rows.length, hint: id && id.children.find((c) => c.id === "acct-hint"), order: id ? id.children.map((c) => c.id || c.className).join() : "",
        idx: (f) => (sc ? sc.children.findIndex(f) : -1), dots: all.filter((n) => n.className === "dot").length,
        foot: all.filter((n) => /^btn-/.test(n.className) && n.dataset.k && !/^(acct-out|more)$/.test(n.dataset.k)).map((n) => n.className + ":" + n.textContent) }; };
    const keep = { acct, hasToken, cur };
    hasToken = false; cur = "claude"; acct = null; HINT = null; planPaint();
    let A = page();
    ok("未登入:最上面一組只有帳號列「Blave 帳號 / 未登入」(灰字),沒有鈕、沒有餘額列;整頁唯一的登入鈕在頁尾", A.first && A.rows === 1 && A.who.l === "acct.lbl" && A.who.v === "acct.signedOut" && A.who.vCls === "v na" && !A.who.btn && A.foot.join() === "btn-fill:pv.signin", JSON.stringify(A));
    planLoginBusy = true; planPaint();
    ok("登入等待中:頁尾那顆變「取消」;「瀏覽器已開啟…」只在鈕左邊,不在帳號列下面再放一次", page().foot.join() === "btn-out:oauth.cancel" && page().hint.hidden === true && walkP(dom["set-plan"]).some((n) => n.className === "wait" && n.textContent === "pv.w.waiting"));
    planLoginBusy = false;
    hasToken = true; acct = { plan: { state: "none" }, data_access: "included", can_run: true }; balLast = balNum(1234.4); planPaint(); A = page();
    ok("已登入:帳號列「已登入」＋文字鈕「登出」(不是描邊鈕、沒有綠點),下面一列 Blave 餘額;順序 帳號列 → 訊息格 → 餘額列", A.first && A.rows === 2 && A.who.v === "acct.signedIn" && A.who.vCls === "v"
      && !!A.who.btn && A.who.btn.className === "btn-quiet" && A.who.btn.textContent === "acct.out" && A.who.btn.id === "set-acct-btn" && A.who.btn.dataset.k === "acct-out"
      && A.bal.l === "plan.bal" && /TWD$/.test(A.bal.v) && A.order === "plan-bal,acct-hint,plan-bal" && A.dots === 1, JSON.stringify(A));
    ok("這一組在方案內容之前(狀態點、標題句都在它後面);細線由這一組帶、不由列帶", page().idx((n) => n.className === "plan-id") === 0 && page().idx((n) => /^plan-st/.test(n.className)) > 0
      && /\.plan-id \{[^}]*border-bottom: 1px solid var\(--border-hairline\)/.test(css) && /\.plan-id \.plan-bal \{ padding: 0; margin: 0; border: 0; \}/.test(css)
      && css.includes(".plan-pane .plan-scroll{padding:var(--space-16)}") && !/\.acct-(id|list|link)|#acct-hint/.test(css));
    acct = null; planPaint();
    ok("已登入、正在重讀(手上有上一個數字):餘額列留著那個數字,不閃成「—」", page().bal.v === "1,234 TWD");
    balLast = null; planPaint();
    ok("已登入、查不到:帳號列照出,餘額列畫「—」", page().rows === 2 && page().who.v === "acct.signedIn" && page().bal.v === "—" && page().foot.join() === "btn-out:plan.recheck");
    // 登出:按了才出確認框(Wei 2026-09-28 定案);三句說明不常駐
    const press = (o) => { boxes.length = 0; cur = o.cur; acct = o.acct; hasToken = true; planPaint(); const b = page().who.btn; b._click(); return boxes[0]; };
    const own = press({ cur: "claude", acct: { plan: { state: "none" } } });
    ok("按「登出」:出確認框(標題、確認鈕、開它的那顆鈕);用自己的 CLI、沒有主機 → 兩句", !!own && own.title === "acct.cf.title" && own.ok === "acct.cf.ok" && own.opener === page().who.btn && own.lines.join() === "acct.out.1,acct.out.2" && own.onOk === acctSignOut);
    ok("用 Blave AI:多一句「登出會回到選 AI 的畫面」,排第一", press({ cur: "blave", acct: { plan: { state: "none" } } }).lines.join() === "acct.out.3,acct.out.1,acct.out.2");
    ok("帳號有主機(啟動中 / 運行中 / 已停機):多一句「登出不會停用雲端主機,主機費照扣」;沒有主機不出", ["starting", "running", "stopped"].every((st) => press({ cur: "claude", acct: { plan: { state: st } } }).lines.join() === "acct.out.1,acct.out.4,acct.out.2")
      && press({ cur: "blave", acct: { plan: { state: "running" } } }).lines.join() === "acct.out.3,acct.out.1,acct.out.4,acct.out.2");
    { boxes.length = 0; running = true; acctOutAsk(null); running = false; oauthPending = true; acctOutAsk(null); oauthPending = false; ok("回合進行中 / 等待登入中:不出框", boxes.length === 0); }
    ok("確認框按下去才走登出那一支;登出之後(用自己 CLI 的人留在原地)焦點回左欄的「帳號與方案」、讀屏念一次;用 Blave AI 的人照舊回選 AI 的畫面", /confirmBox\(\{ title: t\("acct\.cf\.title"\), lines, ok: t\("acct\.cf\.ok"\), opener, onOk: acctSignOut \}\);/.test(src)
      && /async function acctSignOut\(\) \{\n  if \(!hasToken \|\| running \|\| oauthPending \|\| planLoginBusy\) return;\n  const r = await window\.blave\.signOutBlave\(\);/.test(src)
      && /srSay\(t\("acct\.outDone"\)\);\n    const c = document\.querySelector\('\.set-cat\[data-set-cat="plan"\]'\); if \(c\) c\.focus\(\);/.test(src) && /await window\.blave\.clearConnection\(\);\n  cur = null;\n  setClose\(\);/.test(src));
    // 訊息格
    dom["set-scrim"] = node(); dom["set-scrim"].hidden = false; dom["set-plan"].hidden = false;
    hasToken = true; cur = "claude"; acct = { plan: { state: "none" } }; HINT = { text: "cn.blave.signOutLocalOnly" }; acctPaintAcct();
    ok("登出沒撤成:那句話出現在帳號列正下方、餘額列之前", page().hint.textContent === "cn.blave.signOutLocalOnly" && page().hint.hidden === false && page().order === "plan-bal,acct-hint,plan-bal");
    HINT = null; acctPaintAcct();
    ok("沒有訊息就收起來(不佔高度)", page().hint.hidden === true && page().hint.textContent === "");
    { let n = 0; const real = planPaint; planPaint = () => { n++; }; dom["set-plan"].hidden = true; acctPaintAcct(); const closed = n; dom["set-plan"].hidden = false; dom["set-scrim"].hidden = true; acctPaintAcct(); const off = n; dom["set-scrim"].hidden = false; acctPaintAcct(); planPaint = real;
      ok("那一頁沒開(別的分類 / 設定關著)不重畫;開著才畫", closed === 0 && off === 0 && n === 1); }
    acct = keep.acct; hasToken = keep.hasToken; cur = keep.cur; HINT = null; planLastView = null; }
  const paintPlan = () => { planPaint(); const foot = dom["set-plan"].children[1], act = foot.children[foot.children.length - 1]; return act.children; };
  let acts = paintPlan();
  ok("running:兩顆鈕 = 「前往網頁停用」+「切到雲端」(plan.switchCloud);不再有「前往工作頁」", acts.map((b) => b.textContent).join() === "plan.manage,plan.switchCloud" && acts[1].className === "btn-out" && acts[1].disabled === false);
  acts[1]._click();
  ok("按「切到雲端」:先關設定、再走 envSwitchGuarded(\"cloud\");沒有 openExternal", seen.join() === "close,env:cloud");
  seen.length = 0; acts[0]._click();
  ok("「前往網頁停用」照舊外開網頁", seen.join() === "ext:https://blave.org/agent/zh");
  ok("planToCloud 就是那兩個呼叫,沒有第二套切換邏輯", /^function planToCloud\(\) \{ setClose\(\); envSwitchGuarded\("cloud"\); \}$/m.test(src) && !/plan\.openWs/.test(fnSrc("planPaint")));
  // 其他三格不動:starting 沒有切換鈕;stopped 仍是「前往網頁管理」+「前往儲值」
  acct = { plan: { state: "stopped" } }; seen.length = 0; acts = paintPlan();
  ok("stopped 格照舊:前往網頁管理 + 前往儲值,兩顆都外開", acts.map((b) => b.textContent).join() === "plan.manageStopped,plan.addCredit" && (acts[0]._click(), acts[1]._click(), seen.join() === "ext:https://blave.org/agent/zh,ext:acct"));
  acct = { plan: { state: "starting" } }; acts = paintPlan();
  ok("starting 格照舊:一顆灰掉的「啟動中…」", acts.map((b) => b.textContent).join() === "plan.starting" && acts[0].disabled === true);
  { // §4 運行中:說明一句;網頁限定那一句只在「方案內容與計費」展開區裡、接在 pv.inc.note 後面
    const walk = (n, out = []) => { (n.children || []).forEach((c) => { if (c && typeof c === "object") { out.push(c); walk(c, out); } }); return out; };
    acct = { plan: { state: "running" } }; PV_P = "990"; planMoreOpen = true; paintPlan();
    const all = walk(dom["set-plan"]), lead = all.filter((n) => n._cls === "plan-lead").map((n) => n.textContent), fine = all.filter((n) => n._cls === "plan-fine").map((n) => n.textContent);
    ok("運行中:說明只有 pv.d.running 一句;pv.inc.web 在展開區、緊接 pv.inc.note", lead.join() === "pv.d.running" && fine.indexOf("pv.inc.web") === fine.indexOf("pv.inc.note") + 1 && fine.indexOf("pv.inc.note") >= 0);
    PV_P = ""; planMoreOpen = false; }
  { /* 沒有主機也能買資料(spec-data-without-machine-flow §1 / §4 / §5):資料那一格從兩態(included / plan)變四態。
       真的跑 planView + planPaint;數字(時價)從 account_status 的 data_hourly 來,這裡用 PV_R 模擬 planVars 的 r */
    const walk = (n, out = []) => { (n.children || []).forEach((c) => { if (c && typeof c === "object") { out.push(c); walk(c, out); } }); return out; };
    const view = (a) => { acct = { plan: { state: "none" }, ...a }; return planView(); };
    ok("四態 + 退路:included / billed / none;沒有 data_access 的舊 api 照舊看布林(true → included、false → plan)",
      view({ data_access: "included", data_included: true }) === "included" && view({ data_access: "billed", data_included: false }) === "billed"
      && view({ data_access: "none", data_included: false }) === "none" && view({ data_included: true }) === "included" && view({ data_included: false }) === "plan"
      && view({ data_access: "someday", data_included: false }) === "plan");
    ok("billed 排在綁卡前面(沒綁卡但餘額付得起:不叫他去綁卡);none + 沒綁卡照舊走綁卡那兩格;試用中照舊是 trial",
      view({ data_access: "billed", reason: "NO_CARD", trial_eligible: true }) === "billed" && view({ data_access: "none", reason: "NO_CARD", trial_eligible: true }) === "offer"
      && view({ data_access: "none", reason: "NO_CARD", trial_eligible: false }) === "noTrial" && (PV_N = 5, view({ data_access: "included" }) === "trial") && ((PV_N = 0), true));
    const paintOf = (a) => { acct = { plan: { state: "none" }, ...a }; const acts = paintPlan(); const all = walk(dom["set-plan"]);
      return { acts: acts.map((b) => [b.className, b.textContent]), lead: all.filter((n) => n.className === "plan-lead").map((n) => n.textContent).join(),
        st: all.filter((n) => /^plan-st/.test(n.className || "")).map((n) => n.className + ":" + n.textContent).join(), texts: all.map((n) => n.textContent).join("|") }; };
    PV_P = "1,440"; PV_R = "2";
    const b = paintOf({ data_access: "billed", data_included: false, data_hourly: 2 });
    ok("billed:狀態「可用」(跟 included 同一個字,計費方式由標題講——設計稽核 005 第 6 條)、說明帶時價(讀 data_hourly,不寫死)、鈕 = 安靜的〔用量與帳務〕+ 描邊的〔啟動方案〕",
      /pv\.st\.ok/.test(b.st) && !/pv\.st\.billed/.test(b.st) && /^plan-st on/.test(b.st) && b.lead === "pv.d.billed" + JSON.stringify(planVars()) && planVars().r === "2"
      && JSON.stringify(b.acts) === JSON.stringify([["btn-quiet", "pv.usage"], ["btn-out", "plan.start"]]));
    const n = paintOf({ data_access: "none", data_included: false, data_hourly: 2 });
    ok("none:唯一的實心鈕是〔儲值〕,主機降成安靜文字鈕;不講主機月價那一行", /^plan-st bad/.test(n.st) && /pv\.st\.noData/.test(n.st) && /^pv\.d\.none/.test(n.lead)
      && JSON.stringify(n.acts) === JSON.stringify([["btn-quiet", "plan.start"], ["btn-fill", "fault.noCreditBtn"]]) && !/pv\.f\.plan/.test(n.texts));
    { const zh = fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", "zh.po"), "utf8"), en = fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", "en.po"), "utf8");
      const str = (po, k) => (new RegExp('msgid "' + k.replace(/\./g, "\\.") + '"\\nmsgstr "([^"]*)"').exec(po) || [])[1];
      ok("設計稽核 005 第 6 條:none 的說明不再重講「這小時餘額不夠付」(狀態與標題已經講了),改講規則;兩個版本同步",
        /^每個有用到資料的整點小時收 \{r\} TWD 主機與資料費。/.test(str(zh, "pv.d.none")) && !/餘額不夠付/.test(str(zh, "pv.d.none")) && !/餘額不夠付/.test(str(zh, "pv.d.noneNoNum"))
        && /^Each clock hour that uses data/.test(str(en, "pv.d.none")) && /^Each clock hour that uses data/.test(str(en, "pv.d.noneNoNum")));
      ok("…外開的儲值一律「前往儲值 / Add Credit」:fault.noCreditBtn 與 plan.addCredit 同一個字(四個用到的地方一起變);pv.st.billed 退場",
        str(zh, "fault.noCreditBtn") === "前往儲值" && str(zh, "fault.noCreditBtn") === str(zh, "plan.addCredit") && str(en, "fault.noCreditBtn") === str(en, "plan.addCredit")
        && str(zh, "pv.st.billed") === undefined); }
    PV_R = "";
    ok("拿不到時價(data_hourly 缺):用不帶數字的那一句,不印「 TWD」", paintOf({ data_access: "billed" }).lead === "pv.d.billedNoNum" && paintOf({ data_access: "none" }).lead === "pv.d.noneNoNum");
    // 稽核 Delta 3 #3:billed 的人沒有主機,底列不能是「主機存在就扣」那條機器規則;講成「開了主機之後」
    PV_H = "2";
    const bRule = (a) => walk((paintOf(a), dom["set-plan"])).filter((n) => n.className === "plan-rule").map((n) => n.textContent).join();
    ok("Delta 3 #3:billed 底列是「開了主機之後…」(pv.f.billed),不是 pv.f.plan;included 照舊 pv.f.plan", /^pv\.f\.billed/.test(bRule({ data_access: "billed", data_hourly: 2 }))
      && /^pv\.f\.plan/.test(bRule({ data_access: "included", data_included: true })));
    PV_H = "";
    ok("…沒有主機時價:billed 不出底列", bRule({ data_access: "billed", data_hourly: 2 }) === "");
    // Delta 3 #2:新句子(資料按小時計費)只在 api 帶著 data_access 時講;舊 api 用 .old 那一版(那時資料真的只在方案裡)
    const lead = (a) => paintOf(a).lead, texts = (a) => paintOf(a).texts;
    ok("Delta 3 #2:offer / noTrial 在新 api 用新句、在舊 api(沒有 data_access)用 .old;noTrial 標題也跟著",
      /pv\.f\.offer\{/.test(texts({ data_access: "none", reason: "NO_CARD", trial_eligible: true })) && /pv\.f\.offer\.old/.test(texts({ data_included: false, reason: "NO_CARD", trial_eligible: true }))
      && /^pv\.d\.noTrial\{/.test(lead({ data_access: "none", reason: "NO_CARD", trial_eligible: false })) && /^pv\.d\.noTrial\.old/.test(lead({ data_included: false, reason: "NO_CARD", trial_eligible: false }))
      && /pv\.h\.billed/.test(texts({ data_access: "none", reason: "NO_CARD", trial_eligible: false })) && /pv\.h\.plan/.test(texts({ data_included: false, reason: "NO_CARD", trial_eligible: false }))
      && /pv\.w\.noTrial\.old/.test(texts({ data_included: false, reason: "NO_CARD", trial_eligible: false })));
    PV_N = 5;
    ok("Delta 3 #2:試用中那一格也一樣(pv.d.trial / pv.d.trial.old)", /^pv\.d\.trial\{/.test(lead({ data_access: "included", data_included: true })) && /^pv\.d\.trial\.old/.test(lead({ data_included: true })));
    PV_N = 0;
    PV_R = "2";
    // included 這一格一個字都不准動(設計 §1:有主機 / 方案的人不該多看到任何費用字樣):組成照改之前那樣(改前的 app.js 對照過逐字相同)
    const inc = paintOf({ data_access: "included", data_included: true, data_hourly: 2 });
    ok("included 的畫面照舊:可用 · 資料可以用了 · 想全天候才開主機 · 主機時價 · 描邊〔啟動方案〕;沒有任何按小時付費的字",
      /^plan-st on:pv\.st\.ok/.test(inc.st) && /^pv\.d\.included/.test(inc.lead) && /pv\.h\.ready/.test(inc.texts) && /pv\.f\.plan/.test(inc.texts)
      && JSON.stringify(inc.acts) === JSON.stringify([["btn-out", "plan.start"]]) && !/pv\.(st\.billed|st\.noData|d\.billed|d\.none|usage)|主機與資料費/.test(inc.texts));
    PV_P = ""; PV_R = ""; }
  // 內文講切換器、標題不動。哪些事歸給網頁工作頁、哪些不可以再歸給它——那條規則由 check_shell_strings.js 守,這裡只守「內文確實在講切換器」。
  // spec-desktop-settings-cleanup §4:運行中那段收成一句「那一邊有什麼」;網頁限定那一句搬進「方案內容與計費」(pv.inc.web)
  ok("內文一句講雲端那一邊有什麼、標題不動;網頁限定那一句在方案內容裡(zh / en)", /msgid "pv\.d\.running"\nmsgstr "在雲端那一邊，可以看主機上的策略、部位與下單，也可以請 agent 在主機上做策略。"/.test(PO[0])
    && /msgid "pv\.d\.running"\nmsgstr "On the cloud side you can see the strategies, positions and orders on the machine, and ask the agent to build strategies there\."/.test(PO[1])
    && /msgid "pv\.inc\.web"\nmsgstr "[^\n]*工作頁/.test(PO[0]) && /msgid "pv\.inc\.web"\nmsgstr "[^\n]*workspace on the web/.test(PO[1])
    && /el\("p", "plan-fine", t\("pv\.inc\.note"\)\), el\("p", "plan-fine", t\("pv\.inc\.web"\)\)/.test(src) && /msgid "pv\.h\.running"\nmsgstr "策略可以在雲端主機上線了"/.test(PO[0])
    && /msgid "plan\.switchCloud"\nmsgstr "切到雲端"/.test(PO[0]) && /msgid "plan\.switchCloud"\nmsgstr "Switch to cloud"/.test(PO[1]));
}
// 聊天裡「拿不到資料」那張卡(spec-data-without-machine-flow §3):none 的出口是錢包(儲值 / 綁卡),不是主機;
// 從 none 回來時,按小時付的那條要講「會收錢」,免費那條照舊「可以用了」。真的跑 dataCardState / acctPaint / maybeDataCard
{ const mkCard = () => { const c = { states: [] }; c.set = (x) => { c.states.push(x); c.last = x; }; return c; };
  let acct = null, hasToken = true, cur = "claude", dataCard = null, acctCard = null, sessionId = "s1", turnFaulted = false, running = false, lastUserText = "q", acctGone = null;   // acctGone:acctPaint 補記 acct_card_back 用的,這裡沒按過卡上的鈕
  const creditCards = [], dataCardSessions = new Set(); let turnCards = [];
  let V = { t: 14, p: "1,440", r: "2" };
  const planVars = () => V, planOpen = () => {}, planState = () => (acct && acct.plan && acct.plan.state) || "none", planWatch = () => {};
  const acctUrl = () => "topup", faultCard = () => mkCard(), submitMessage = async () => true, $ = () => ({ focus() {} });
  const acctSub = () => null, acctAction = () => ({}), resendSecond = () => null;
  eval(fnSrc("dataAccessOf")); eval(src.match(/^const hasData = [^\n]*$/m)[0].replace(/^const /, "var ")); eval(src.match(/^const pvK = [^\n]*$/m)[0].replace(/^const /, "var "));
  eval(fnSrc("dataReadyText")); eval(fnSrc("resendState")); eval(fnSrc("dataCardState")); eval(fnSrc("dataCardSync")); eval(fnSrc("maybeDataCard")); eval(fnSrc("acctPaint"));
  const A = (o) => ({ can_run: true, plan: { state: "none" }, ...o });
  acct = A({ data_access: "none", reason: "NO_CREDIT", data_hourly: 2 });
  let c = dataCardState();
  ok("none、有卡:〔儲值〕實心鈕(不是描邊的「資料與雲端方案」)、講這小時的主機與資料費(時價來自 data_hourly)、儲值後馬上恢復;不提主機",
    c.label === "fault.noCreditBtn" && !c.out && c.text === "data.noBalance" + JSON.stringify(V) && c.sub === "data.noBalanceSub" && !/pv\.e|plan/.test(JSON.stringify(c)));
  acct = A({ data_access: "none", reason: "NO_CARD", trial_eligible: true });
  c = dataCardState();
  ok("none、沒綁卡、有試用:〔前往綁卡〕+「首次綁卡送 {t} 天,期間資料免費」;沒試用就不講那句",
    c.label === "acct.addCard" && !c.out && c.text === "data.noCard" && c.sub === "data.noCardSub" + JSON.stringify(V)
    && (acct = A({ data_access: "none", reason: "NO_CARD", trial_eligible: false }), dataCardState().sub === null));
  V = { t: 14, p: "1,440", r: "" }; acct = A({ data_access: "none", reason: "NO_CREDIT" });
  ok("none 拿不到時價:用不帶數字的句子", dataCardState().text === "data.noBalanceNoNum");
  V = { t: 14, p: "1,440", r: "2" };
  acct = A({ data_included: false });
  ok("舊 api(沒有 data_access)照舊:描邊的「資料與雲端方案」+「它在雲端方案裡」;月價副句拿掉了", dataCardState().label === "pv.e.btn" && dataCardState().out === true && dataCardState().text === "pv.e.noTrial" && dataCardState().sub == null);
  acct = A({ data_included: false, reason: "NO_CARD", trial_eligible: true });
  ok("舊 api、沒綁卡有試用:副句是舊的那句(之後資料在方案裡)——那時它是真話;新 api 那句只在有 data_access 時講", dataCardState().sub === "pv.e.sub.old" + JSON.stringify(V));
  // 復原:從 none 變成拿得到
  { const card = mkCard(); dataCard = card; acct = A({ data_access: "billed", data_hourly: 2 }); acctPaint();
    ok("none → billed(儲值回來):那張卡講「餘額夠了,有用到資料的那個小時會收」+〔再送一次〕,不是「資料可以用了」",
      card.last.text === "data.readyBilled" + JSON.stringify(V) && card.last.label === "fault.resend");
    const n = card.states.length; acctPaint();
    ok("同一句不重設(role=status 不重唸)", card.states.length === n);
    acct = A({ data_access: "none", reason: "NO_CREDIT", data_hourly: 2 }); acctPaint();
    ok("稽核 Delta 3:講過「餘額夠了」之後餘額又用完 → 那張卡換回儲值,不停在錯的那一句", dataCard === card && card.last.label === "fault.noCreditBtn" && card.last.text === "data.noBalance" + JSON.stringify(V));
    acct = A({ data_access: "billed", data_hourly: 2 }); acctPaint(); await card.last.on();
    ok("按了〔再送一次〕:放手(之後的事由下一輪講)", dataCard === null); }
  { const card = mkCard(); dataCard = card; acct = A({ data_access: "included", data_included: true }); dataCard._key = null; acctPaint();
    ok("none → included(開了主機 / 開始試用):照舊「Blave 的資料可以用了」+〔再送一次〕", card.last.text === "data.ready" && card.last.label === "fault.resend"); }
  { const card = mkCard(); dataCard = card; acct = A({ data_included: true }); acctPaint();
    ok("舊 api 的 data_included:true 也算回來了(退路)", card.last.text === "data.ready"); }
  { const card = mkCard(); dataCard = card; acct = A({ data_access: "none", reason: "NO_CREDIT", data_hourly: 2 }); acctPaint();
    ok("還是 none:卡留著、跟著換成儲值那一句,不給〔再送一次〕", dataCard === card && card.last.label === "fault.noCreditBtn"); }
  // 卡出來的那一刻帳號已經付得起(狀態比 agent 那一輪新):直接給〔再送一次〕
  dataCard = null; turnCards = ["data-access"]; sessionId = "s2"; acct = A({ data_access: "billed", data_hourly: 2 }); maybeDataCard();
  ok("卡出來時已經 billed:直接是「餘額夠了…會收」+〔再送一次〕", dataCard && /^data\.readyBilled/.test(dataCard.last.text) && dataCardSessions.has("s2")); }
// 主機與資料費的時價只從 account_status 的 data_hourly 來,外殼一個數字都不寫死(提案 §3 C3)
{ let acct = null; const pub = null, cur = "claude", planDate = () => "";
  eval(fnSrc("planVars"));
  ok("planVars().r = data_hourly(3 就是 3);沒給就是空字串(畫面改用不帶數字的句子)", ((acct = { data_hourly: 3 }), planVars().r === "3") && ((acct = { data_hourly: 2 }), planVars().r === "2")
    && ((acct = {}), planVars().r === "") && ((acct = { data_hourly: 0 }), planVars().r === "")); }
// 聊天裡「這小時用到了 Blave 的資料,主機與資料費 N TWD」那一則已拿掉(Wei 2026-09-24:惱人;計費不變,只是不在對話裡講)
ok("回合結束不再出費用那一則:dataFeeNote / dataFeeShow / data.fee 字串都不在外殼裡", !/dataFeeNote|dataFeeShow|DATA_RULE_KEY|DATA_NOTE_HOUR_KEY|"data\.fee(First)?"/.test(src));
{ /* 回合結束(dataTurnEnd)真的跑:有登入就重讀一次(稽核 Delta 3 #1:試用剛到期、餘額剛用完只有這裡看得到);卡用這一份 */
  let acct = null, hasToken = true, fetched = 0, notes = [], NEXT = null, painted = 0, cardCalls = 0;
  const window = { blave: { accountStatus: async () => { fetched++; return NEXT; }, openExternal: () => {} } };
  const acctPaint = () => { painted++; }, faultCard = () => ({ set: (x) => notes.push(x) }), maybeDataCard = () => { cardCalls++; };
  eval(fnSrc("dataAccessOf"));
  eval("var dataTurnEnd = async " + fnSrc("dataTurnEnd").replace(/^async /, ""));
  acct = { data_access: "included", data_included: true }; NEXT = { data_access: "billed", data_hourly: 2, data_hour_paid: true };
  await dataTurnEnd();
  ok("Delta 3 #1:手上是舊的 included(試用剛到期)→ 回合結束照樣重讀,拿到 billed 就用新的:acct 換掉、卡看新的;不出任何一則",
    fetched === 1 && acct === NEXT && painted === 1 && cardCalls === 1 && notes.length === 0);
  await dataTurnEnd();
  ok("再一輪:照讀(卡要新的),還是不出", fetched === 2 && notes.length === 0);
  NEXT = null; const before = acct;
  await dataTurnEnd();
  ok("讀不到:acct 留著,卡照舊檢查", acct === before && painted === 2 && cardCalls === 3);
  hasToken = false; fetched = 0; await dataTurnEnd();
  ok("沒登入:不讀、卡照舊檢查", fetched === 0 && cardCalls === 4);
  ok("接線:回合正常結束走 dataTurnEnd(卡在裡面)", /if \(!loggedOut && r\.code === 0\) dataTurnEnd\(\);/.test(src)); }
})().then(() => {
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
});
