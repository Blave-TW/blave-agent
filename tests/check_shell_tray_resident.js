// 選單列圖示常駐(0.1.9,Wei;設計 spec-desktop-tray-resident-0.1.9):app 開著圖示就在,沒有開關;關視窗留不留背景照舊。
// 從 shell/main.js 原文切出 traySync 那一組 + 關窗那一道,配假的 Tray / Menu / app 跑(不開 Electron)。
// 跑法:node tests/check_shell_tray_resident.js
const fs = require("fs"), os = require("os"), path = require("path");
const TT = require("../shell/traytext.js");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
const cut = (head) => { const i = src.indexOf(head); if (i < 0) throw new Error("找不到 " + head); let d = 0; for (let k = src.indexOf("{", src.indexOf(")", i)); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("切不出 " + head); };
const line = (name) => { const m = new RegExp("^const " + name + " = [^\\n]*;", "m").exec(src); if (!m) throw new Error("找不到 const " + name); return m[0]; };
let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || d === undefined ? "" : "  " + JSON.stringify(d))); if (!ok) red++; };

const BODY = [line("pauseLabel"), line("trayCloudLine"), line("trayQuitLabel"), line("trayGroups"), cut("function trayLocalLine("), cut("function trayMenu("), cut("function trayDockMenu("),
  cut("function traySync(")].join("\n");
const V = { credentials: true, pair: true, order: true, account: true };
const MENU_EN = { menuQuit: "Quit Blave" };
// 字照 strings.js 的 zh(spec §7 的 key;換字時這裡不用跟著改)
const S = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "strings.js"), "utf8");
const zh = (k) => { const m = new RegExp('"' + k.replace(/\./g, "\\.") + '": "([^"]*)"').exec(S.slice(S.indexOf("zh:"))); if (!m) throw new Error("字串表沒有 " + k); return m[1]; };
const L = { running: "Auto trading is running", pause: zh("tm.pause"), pauseLocal: zh("tm.pauseLocal"), open: zh("tm.open"), quit: zh("tm.quit"), menuQuit: zh("menu.quit"),
  updateReady: zh("tm.updateReady"), restarting: zh("tm.restarting"), stLocal: zh("tm.stLocal"), stLocalOnly: zh("tm.stLocalOnly"), stCloud: zh("tm.stCloud"), stOn: zh("tm.stOn"), stPaused: zh("tm.stPaused"),
  stUnknown: zh("tm.stUnknown"), stMayTrade: zh("tm.stMayTrade"), stNotStarted: zh("tr.notStarted"), noAccount: zh("tr.noAccount"), runningZ: zh("tr.runningZ"),
  moneyPaper: zh("tr.mode.paper"), moneyReal: zh("tr.mode.real") };
const loc = (rest) => zh("tm.stLocal").replace("{money} · {state}", rest), locOnly = (s) => zh("tm.stLocalOnly").replace("{state}", s);

function world(real) {   // real:tradeLive / tradeMaybeLive 也用 main.js 原文(從狀態檔推),不用 w.live / w.maybe 樁
  const w = { trays: [], dockMenu: null, live: null, maybe: null, st: null, reads: 0, trayThrows: 0, restarts: [] };
  class Tray { constructor() { if (w.trayThrows > 0) { w.trayThrows--; throw new Error("tray boom"); } this.destroyed = false; this.menu = null; this.tip = ""; this.clicks = 0; w.trays.push(this); } destroy() { this.destroyed = true; } setToolTip(s) { this.tip = s; } setContextMenu(m) { this.menu = m; } on(ev) { if (ev === "click") this.clicks++; } }
  const ctx = {
    tray: null, trayKey: "", trayLabelsIn: true, lastVenue: null, tmLabels: { ...L }, MENU_EN, TT, WIN: false, __dirname: "/x", path, fs, console,
    Tray, Menu: { buildFromTemplate: (x) => x }, nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    app: { name: "Blave", dock: { setMenu: (m) => { w.dockMenu = m; } }, quit: () => {} },
    tradeLive: () => w.live, tradeMaybeLive: () => w.live || w.maybe || null, activeTurn: null, turnStarting: false, restarting: null,
    updateWaiting: () => false, cloudSt: () => null, pauseFromMenu: () => {}, showMain: () => {}, restartToUpdate: () => { w.restarts.push("restart"); return Promise.resolve({ ok: true }); },
  };
  Object.defineProperty(ctx, "_tradeHost", { get: () => (w.st ? { status: () => { w.reads++; return typeof w.st === "function" ? w.st(w.reads) : w.st; } } : null) });
  const body = real ? [line("venueReady"), cut("function tradeLive("), cut("function tradeMaybeLive("), BODY].join("\n") : BODY;
  const api = new Function("ctx", "with (ctx) { " + body + "\n return { traySync }; }")(ctx);
  w.ctx = ctx; Object.assign(w, api);
  const flat = (menu) => menu.map((x) => (x.type === "separator" ? "---" : x.label));
  w.menu = () => (ctx.tray && !ctx.tray.destroyed && ctx.tray.menu ? flat(ctx.tray.menu) : null);
  w.dock = () => flat(w.dockMenu || []);
  w.alive = () => !!(ctx.tray && !ctx.tray.destroyed);
  return w;
}
const running = (venues, rec) => ({ running: true, alive: true, report: { venues: venues || { binance: V }, halt: { halted: false }, reconciler: { alive: true, heartbeat_at: 1 }, daemon: { reconciler: { running: true } }, config: { amounts: { s1: 100 } }, ...(rec || {}) } });
const j = (x) => JSON.stringify(x);
const OPEN = zh("tm.open"), QUIT = zh("menu.quit"), QUIT_ASK = zh("tm.quit"), PAUSE = zh("tm.pauseLocal");

// ── 常駐 + §2.2 各狀態的選單 ──
{ const w = world();
  w.traySync();
  t("§2.2 引擎沒裝好 / 沒連交易所:圖示在(常駐);第一行「這台電腦：還沒連接交易所」;沒有暫停;結束不帶「…」;提示字 = 第一行;Dock 只有狀態行",
    w.alive() && j(w.menu()) === j([locOnly(zh("tr.noAccount")), "---", OPEN, QUIT]) && w.ctx.tray.tip === locOnly(zh("tr.noAccount")) && j(w.dock()) === j([locOnly(zh("tr.noAccount"))]), [w.menu(), w.dock()]);
  w.st = running(null, { reconciler: { alive: false, heartbeat_at: 1 }, daemon: { reconciler: { running: false, wanted: true } } });
  w.traySync();
  t("§2.2 已連交易所、還沒按啟動:「Binance · 尚未啟動下單」;同一顆圖示重建選單,不是新開一顆", w.trays.length === 1 && j(w.menu()) === j([loc("Binance · " + zh("tr.notStarted")), "---", OPEN, QUIT]), w.menu());
  w.st = running(null, { halt: { halted: true } });
  w.traySync();
  t("§2.2 已暫停:「Binance · 已暫停」,沒有暫停鈕(選單列不給啟動)", j(w.menu()) === j([loc("Binance · " + zh("tm.stPaused")), "---", OPEN, QUIT]), w.menu());
  w.live = { venue: "binance" }; w.st = running();
  w.traySync();
  t("§2.2 本機下單中:「Binance · 執行中」、暫停、結束…;提示字 = 第一行;Dock = 狀態行 + 暫停",
    w.trays.length === 1 && j(w.menu()) === j([loc("Binance · " + zh("tm.stOn")), "---", PAUSE, "---", OPEN, QUIT_ASK]) && w.ctx.tray.tip === loc("Binance · " + zh("tm.stOn"))
    && j(w.dock()) === j([loc("Binance · " + zh("tm.stOn")), "---", PAUSE]), [w.menu(), w.dock()]);
  w.st = running({ paper: V }); w.live = { venue: "paper" }; w.traySync();
  t("§2.2 模擬帳戶下單中:「這台電腦：模擬 · 執行中」", w.menu()[0] === loc(zh("tr.mode.paper") + " · " + zh("tm.stOn")), w.menu());
  w.st = running(null, { config: { amounts: {} } }); w.live = { venue: "binance" }; w.traySync();
  t("§2.2 下單程式在跑、沒有策略設金額:「Binance · 下單程式在跑 · 還沒有策略設定金額」,暫停照出", j(w.menu()) === j([loc("Binance · " + zh("tr.runningZ")), "---", PAUSE, "---", OPEN, QUIT_ASK]), w.menu());
  w.live = null; w.maybe = { venue: "binance" }; w.st = { running: true, alive: true, report: { error: "boom", daemon: { reconciler: { running: true } } } }; w.ctx.lastVenue = "binance"; w.traySync();
  t("§2.2 讀不到狀態(這一輪 build 失敗)、監督者說還在跑:「Binance · 讀不到狀態」,暫停出、結束帶「…」(tradeMaybeLive)", j(w.menu()) === j([loc("Binance · " + zh("tm.stUnknown")), "---", PAUSE, "---", OPEN, QUIT_ASK]), w.menu());
  w.maybe = null; w.st = running(null, { reconciler: { alive: false, heartbeat_at: 1 }, daemon: { reconciler: { running: false, wanted: true } } });
  w.ctx.cloudSt = () => ({ alive: true, cloud: { code: "OK", machine: { state: "running" } }, report: { venues: { okx: V }, halt: { halted: false }, reconciler: { alive: true } } });
  w.traySync();
  t("§2.2 雲端有策略在跑:第二行「雲端：OKX · 執行中」;暫停與結束只看本機", j(w.menu()) === j([loc("Binance · " + zh("tr.notStarted")), zh("tm.stCloud").replace("{money} · {state}", "OKX · " + zh("tm.stOn")), "---", OPEN, QUIT]), w.menu());
  w.ctx.cloudSt = () => null; w.ctx.updateWaiting = () => true; w.traySync();
  t("§2.2 新版已暫存好:多一組「重新啟動以完成更新」(前面一條分隔線),提示字換成它;Dock 不放", j(w.menu()) === j([loc("Binance · " + zh("tr.notStarted")), "---", zh("tm.updateReady"), "---", OPEN, QUIT])
    && w.ctx.tray.tip === zh("tm.updateReady") && !w.dock().includes(zh("tm.updateReady")), w.menu());
  { // 0.1.10 §3:那一行可以按。下單中字尾「…」(按了先問);回合在跑停用、不帶「…」;沒東西在等就沒有這一組
    const item = () => w.ctx.tray.menu.find((x) => x.label && x.label.startsWith(zh("tm.updateReady")));
    const it0 = item();
    t("§3 沒在下單:enabled、字不帶「…」、點下去 = restartToUpdate()", it0.enabled === true && it0.label === zh("tm.updateReady") && (it0.click(), w.restarts.length === 1), it0);
    w.maybe = { venue: null }; w.traySync(); const it1 = item();
    t("§3 下單中(m.update.ask):enabled、字尾「…」", it1.enabled === true && it1.label === zh("tm.updateReady") + "…" && w.menu().includes(PAUSE), w.menu());
    w.ctx.activeTurn = {}; w.traySync(); const it2 = item();
    t("§3 回合在跑(m.update.busy):停用、不帶「…」(選單列沒有 tooltip 講原因,同聊天那一格只停用)", it2.enabled === false && it2.label === zh("tm.updateReady"), it2);
    w.ctx.activeTurn = null; w.ctx.restarting = "stopping"; w.traySync(); const it3 = item();
    const it3r = w.ctx.tray.menu.find((x) => x.label === w.ctx.tmLabels.restarting);
    t("§3 更新重開收工中(restarting):那一行換「重新啟動中…」、停用(再點不會跳第二個框,稽核 0.1.10 P1-1 / 設計複驗);提示字同", !it3 && !!it3r && it3r.enabled === false && w.ctx.tray.tip === zh("tm.restarting"), w.menu());
    w.ctx.updateWaiting = () => false; w.traySync();
    t("…安裝中 phase 變了(updateWaiting 為假)照樣留著那一行", !!w.ctx.tray.menu.find((x) => x.label === zh("tm.restarting")), w.menu());
    w.ctx.updateWaiting = () => true;
    w.ctx.restarting = null;
    w.ctx.activeTurn = null; w.maybe = null; w.ctx.updateWaiting = () => false; w.traySync();
    t("§3 m.update = null:沒有這一項,也沒有多出來的分隔線", !item() && j(w.menu()) === j([loc("Binance · " + zh("tr.notStarted")), "---", OPEN, QUIT]), w.menu()); }
  w.ctx.updateWaiting = () => false; w.ctx.activeTurn = {}; w.traySync();
  t("§2.1 沒在下單但回合在跑(結束會先問):結束帶「…」", w.menu().slice(-1)[0] === QUIT_ASK, w.menu());
  w.ctx.activeTurn = null; w.ctx.tmLabels.open = "Open Blave"; w.traySync();
  t("換語言(字變了)也重建", w.menu().includes("Open Blave"));
  const before = w.ctx.tray.menu; w.traySync();
  t("什麼都沒變:不重建(每 5 秒叫一次)", w.ctx.tray.menu === before);
  t("§2.1 分隔線:不開頭、不結尾、不疊兩條", w.trays.every((x) => !x.menu || (x.menu[0].type !== "separator" && x.menu[x.menu.length - 1].type !== "separator" && !x.menu.some((y, i) => y.type === "separator" && x.menu[i + 1] && x.menu[i + 1].type === "separator"))));
}
{ const w = world(); w.ctx.trayLabelsIn = false;
  w.traySync();
  t("§2.2 字還沒交之前:常駐的那顆先不建(中文用戶不會先看到英文選單)", !w.alive() && w.trays.length === 0);
  w.live = { venue: "binance" }; w.st = running(); w.ctx.tmLabels = { ...L, stLocal: "", stOn: "" }; w.traySync();
  t("…可能在下單時不等字:圖示照建,第一行退回英文那一句", w.alive() && w.menu()[0] === "Auto trading is running", w.menu());
}
{ const w = world(); w.ctx.WIN = true; w.traySync();
  t("Windows:左鍵掛 showMain(右鍵照舊是選單)", w.ctx.tray.clicks === 1);
  const m = world(); m.traySync();
  t("…macOS 不掛", m.ctx.tray.clicks === 0);
}

// ── 常駐:沒有開關,下單停了圖示照在 ──
{ const w = world();
  w.live = { venue: "binance" }; w.st = running(); w.traySync();
  w.live = null; w.st = running(null, { halt: { halted: true } }); w.traySync();
  t("下單停了(已暫停):同一顆圖示照在,暫停項拿掉、結束不帶「…」;Dock 跟著換", w.alive() && w.trays.length === 1
    && j(w.menu()) === j([loc("Binance · " + zh("tm.stPaused")), "---", OPEN, QUIT]) && j(w.dock()) === j([loc("Binance · " + zh("tm.stPaused"))]), [w.menu(), w.dock()]);
  const rd = (f) => fs.readFileSync(path.join(__dirname, "..", "shell", f), "utf8");
  t("沒有開關:設定頁沒有那一列、主行程沒有 tray-get / tray-set 與 trayResident、preload 沒有 trayGet / traySet、埋點白名單沒有 tray_off、.po 沒有 set.tray*",
    !/set-tray|set\.tray/.test(rd("renderer/index.html") + rd("renderer/app.js")) && !/tray-get|tray-set|trayResident|tray_off/.test(src) && !/trayGet|traySet/.test(rd("preload.js"))
    && !require("../shell/telemetry.js").EVENTS.feature_used.name.includes("tray_off") && ["zh", "en"].every((l) => !/msgid "set\.tray/.test(rd("i18n/" + l + ".po"))));
}

// ── traytext.localLine:§2.2 每一種情境一筆 ──
{ const S0 = (x) => { const l = TT.localLine(...x); return l && l.state; };
  const rows = [
    ["沒有下單宿主(引擎還沒裝好)", [null], "none"],
    ["宿主沒在跑、沒報告", [{ running: false, alive: false, report: null }], "none"],
    ["常駐程式剛起、第一份報告還在路上 → 這一行先不出", [{ running: true, alive: false, report: null }], null],
    ["沒連好交易所", [running({ binance: { credentials: true } })], "none"],
    ["尚未啟動(要起來、還沒起)", [running(null, { reconciler: { alive: false }, daemon: { reconciler: { running: false, wanted: true } } })], "notStarted"],
    ["常駐程式不在跑", [{ ...running(), running: false, alive: false }], "notStarted"],
    ["已暫停(HALT)", [running(null, { halt: { halted: true } })], "paused"],
    ["機器重開後停著", [running(null, { reconciler: { alive: false, stopped: { reason: "machine_restart" } } })], "paused"],
    ["機器重開沒停住", [running(null, { reconciler: { alive: false, stopped: { reason: "machine_restart", gated: false } } })], "mayTrade"],
    ["app 重開、對帳器等人按啟動(有舊心跳、沒被要求)", [running(null, { reconciler: { alive: false, heartbeat_at: 1 }, daemon: { reconciler: { running: false } } })], "paused"],
    ["執行中", [running()], "on"],
    ["執行中、沒有策略設金額", [running(null, { config: { amounts: { a: 0 } } })], "onZ"],
    ["設定檔讀不到(config: null)不算沒設金額", [running(null, { config: null })], "on"],
    ["報告 build 失敗", [{ running: true, alive: true, report: { error: "x" } }, "okx"], "unknown"],
    ["心跳舊了、監督者說在跑", [{ ...running(), alive: false }], "unknown"],
  ];
  const bad = rows.filter(([, x, want]) => S0(x) !== want).map(([n, x]) => n + " → " + S0(x));
  t("localLine 列舉 §2.2 各情境(" + rows.length + " 筆)", bad.length === 0, bad);
  t("…on 與 tradeLive 同一組條件:tradeLive 不認的(心跳舊 / 監督者說沒在跑 / 已暫停 / 報告失敗)localLine 也不說 on",
    [{ ...running(), alive: false }, running(null, { daemon: { reconciler: { running: false } } }), running(null, { halt: { halted: true } }), { running: true, alive: true, report: { error: "x" } }].every((s) => !/^on/.test(S0([s]) || "")));
  // 0.1.18:統一在這台電腦開通中(只綁了它、對帳器沒在跑)→ 尚未啟動下單,不是已暫停(同 trade.js trExecState 的 setup)
  { const VP = { president: { credentials: true, pair: true, order: true, account: true } }, wip = { worker: { status: "idle" } };
    const rs = { halt: { halted: true }, reconciler: { alive: false, heartbeat_at: 1 }, daemon: { reconciler: { running: false, wanted: false } } };
    t("統一開通中:notStarted 而不是 paused;worker ok 之後照舊 paused;對帳器在跑就不算開通中", S0([{ running: true, alive: true, report: { venues: VP, president_connect: wip, ...rs } }]) === "notStarted"
      && S0([{ running: true, alive: true, report: { venues: VP, president_connect: { worker: { status: "ok" } }, ...rs } }]) === "paused"
      && S0([{ running: true, alive: true, report: { venues: VP, president_connect: wip, halt: { halted: true }, reconciler: { alive: true }, daemon: { reconciler: { running: true } } } }]) === "paused");
    // 稽核 integ-0118 B-1:開通過(worker.ok_at)、之後登入失敗停掉 → 照一般狀態機;機器重開過的一律不講「尚未啟動下單」
    const failed = { worker: { status: "failed", error: "LOGIN_FAILED:MAINTENANCE", ok_at: 5 } }, mr = { reconciler: { alive: false, stopped: { reason: "machine_restart", at: 7 } }, daemon: { reconciler: { running: false, wanted: false } } };
    t("B-1 開通過→重開→登入失敗:paused(HALT)/ paused(重開停著)/ mayTrade(沒停住),不是 notStarted;從沒 ok 過但機器重開過也是 paused",
      S0([{ running: true, alive: true, report: { venues: VP, president_connect: failed, ...rs } }]) === "paused"
      && S0([{ running: true, alive: true, report: { venues: VP, president_connect: failed, halt: {}, ...mr } }]) === "paused"
      && S0([{ running: true, alive: true, report: { venues: VP, president_connect: failed, halt: {}, reconciler: { alive: false, stopped: { reason: "machine_restart", gated: false } } } }]) === "mayTrade"
      && S0([{ running: true, alive: true, report: { venues: VP, president_connect: wip, halt: {}, ...mr } }]) === "paused"); }
  t("…讀不到時沒有上次的場所 / 場所長得不像 id:不帶交易所名(用「這台電腦：{state}」那個樣板)", !TT.localLine({ running: true, alive: true, report: { error: "x" } }, "<b>").money && !TT.localLine({ running: true, alive: true, report: { error: "x" } }, null).money);
  t("statusLine:沒有 money 的那幾態走不帶 {money} 的樣板;字沒交就整行不出", TT.statusLine(L.stLocalOnly, { state: "none" }, L) === locOnly(zh("tr.noAccount")) && TT.statusLine(L.stLocalOnly, { state: "none" }, { ...L, noAccount: "" }) === null
    && TT.statusLine(L.stLocal, { money: "real", venue: "okx", state: "onZ" }, L) === loc("OKX · " + zh("tr.runningZ")));
}

// ── 關視窗:留不留在背景照舊(有東西在跑才留),跟圖示常駐無關 ──
{ const CLOSE = cut('app.on("browser-window-created", (_e, win) =>');
  const run = (trading, turn, restarting) => {
    let handler = null, prevented = false, hidden = false;
    const ctx = { app: { on: (_ev, f) => f(null, { on: (ev, h) => { if (ev === "close") handler = h; }, hide: () => { hidden = true; } }) },
      tradeMaybeLive: () => trading, activeTurn: turn ? {} : null, turnStarting: false, quitting: false, quitConfirmed: !!restarting, restarting: restarting || null, hiddenSaid: true, tmLabels: {}, Notification: { isSupported: () => false } };
    new Function("ctx", "with (ctx) { " + CLOSE + "); }")(ctx);
    handler({ preventDefault: () => { prevented = true; } });
    return { prevented, hidden };
  };
  t("沒在下單、沒有回合:關視窗不攔(視窗關掉 → window-all-closed → 結束),就算圖示常駐", j(run(null, false)) === '{"prevented":false,"hidden":false}');
  t("下單中 / 回合中:只把視窗收起來", j(run({ venue: "binance" }, false)) === '{"prevented":true,"hidden":true}' && j(run(null, true)) === '{"prevented":true,"hidden":true}');
  t("更新重開收工中(restarting = stopping,quitConfirmed 已是 true):紅燈只收視窗;交給 quitAndInstall 之後(installing)放行", j(run(null, false, "stopping")) === '{"prevented":true,"hidden":true}' && j(run(null, false, "installing")) === '{"prevented":false,"hidden":false}');
  t("window-all-closed 照舊直接結束(沒有「有圖示就留著」的分支)", /\napp\.on\("window-all-closed", \(\) => app\.quit\(\)\);\n/.test(src));
  t("畫面第一次交字才放行常駐的那顆:trade-labels 收完字設 trayLabelsIn、再 traySync", /tmLabels\[k\] = labels\[k\];\n\s*trayLabelsIn = true;[\s\S]{0,400}startStep\("tray", traySync\);/.test(src));
}
// ── 稽核 0.1.9 批 1(T-P2-1～4、設計 T2)──
{ const w = world(); w.trayThrows = 1;
  try { w.traySync(); } catch (_) { /* 這一輪建圖示失敗 */ }
  w.traySync();
  t("T-P2-2 建圖示那一輪拋例外:下一輪 key 相同也會重做,圖示照樣建起來(trayKey 等副作用做完才記)", w.alive() && w.trays.length === 1 && j(w.menu()) === j([locOnly(zh("tr.noAccount")), "---", OPEN, QUIT]), w.menu());
}
{ const w = world(true);
  w.st = (n) => (n === 1 ? { running: true, alive: false, report: { venues: { binance: V }, halt: { halted: false }, reconciler: { alive: true, heartbeat_at: 1 }, daemon: { reconciler: { running: true } } } }
    : running(null, { halt: { halted: true } }));   // 第一次讀:心跳舊、可能在下單;之後再讀:已暫停
  w.ctx.lastVenue = "binance"; w.traySync();
  t("T-P2-3 一輪 traySync 只讀一次狀態檔:第一行、暫停項、結束字出自同一份快照(不會「已暫停」卻有暫停鈕)",
    w.reads === 1 && j(w.menu()) === j([loc("Binance · " + zh("tm.stUnknown")), "---", PAUSE, "---", OPEN, QUIT_ASK]), [w.reads, w.menu()]);
  const u = world(true); u.st = running(); u.traySync();
  t("…下單中(tradeLive 認得)也一樣一次;第一行「Binance · 執行中」", u.reads === 1 && u.menu()[0] === loc("Binance · " + zh("tm.stOn")), [u.reads, u.menu()]);
}
{ const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blave-uiprefs-")), P = path.join(dir, "ui-prefs.json");
  const patch = new Function("fs", "uiPrefsPath", cut("function uiPrefsPatch(") + "\n return uiPrefsPatch;")(fs, () => P);
  fs.writeFileSync(P, JSON.stringify({ pdfDir: "/Users/x/Downloads", other: 1 }));
  patch({ pdfDir: "/Users/x/Desktop" });
  t("T-P2-4 ui-prefs.json 先寫暫存檔再 rename:寫完不留暫存檔,其他 key 留著", !fs.existsSync(P + ".blave-tmp") && j(JSON.parse(fs.readFileSync(P, "utf8"))) === j({ pdfDir: "/Users/x/Desktop", other: 1 }));
  fs.mkdirSync(P + ".blave-tmp");   // 暫存檔寫不進去 = 寫到一半就失敗
  let threw = false; try { patch({ pdfDir: "/Users/x/Other" }); } catch (_) { threw = true; }
  t("…寫到一半失敗:拋出去給呼叫端,原檔整份留著", threw && j(JSON.parse(fs.readFileSync(P, "utf8"))) === j({ pdfDir: "/Users/x/Desktop", other: 1 }));
}
{ const START = cut("function trayStart("), STEP = cut("function startStep(");
  let tick = null, p1 = 0; const errs = [];
  let polls = 0;
  const ctx = { trayTimer: null, setInterval: (f) => { tick = f; return {}; }, traySync: () => {}, appMenuSync: () => {}, p1Sync: () => { p1++; }, console: { error: (e) => errs.push(e) },
    updater: () => ({ poll: () => { polls++; throw new Error("poll boom"); } }) };
  new Function("ctx", "with (ctx) { " + STEP + "\n" + START + "\n trayStart(); }")(ctx);
  ctx.traySync = () => { throw new Error("tray boom"); };
  try { tick(); } catch (_) { /* 沒隔開的話 traySync 的例外會從這裡冒出來 */ }
  t("T-P2-1 5 秒那一輪 traySync 拋例外:P1 通知照跑,錯誤留一行 log", p1 === 1 && errs.some((e) => /tray failed/.test(e)), [p1, errs]);
  t("0.1.10 §2 5 秒那一輪叫 updater().poll()(ready ↔ blocked 補推),包在 startStep 裡:poll 拋例外只留一行 log、選單列那一輪照跑", polls === 1 && errs.some((e) => /update poll failed/.test(e)), [polls, errs]);
}
{ const trSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");
  t("設計 T2:關視窗那則通知在 Windows 講系統匣(字與主行程的英文退路都分平台)",
    /hidden: t\(window\.blave\.platform === "win32" \? "tm\.hiddenWin" : "tm\.hidden"\)/.test(trSrc) && zh("tm.hiddenWin").includes("系統匣") && !zh("tm.hiddenWin").includes("選單列")
    && /hidden: WIN \? "Blave is still running in the system tray\." : "Blave is still running in the menu bar\.",/.test(src));
}
/* app 選單的「結束 Blave」:before-quit 會先問(可能在下單 / 回合在跑)時字尾「…」,同選單列 trayQuitLabel 的規則(HIG)。
   appMenuSync 每 5 秒跟 traySync 一起對一次,key 含 ask 才會在狀態變時重建 */
{ const tpl = new Function("app", "MENU_EN", cut("function appMenuTemplate(") + "\n return appMenuTemplate;")({ name: "Blave" }, MENU_EN);
  const quitOf = (L, ask) => tpl(L, false, false, () => {}, () => {}, () => {}, ask)[0].submenu.find((x) => x.role === "quit").label;
  t("不會先問:「結束 Blave」不帶「…」", quitOf(L, false) === zh("menu.quit") && !/…$/.test(quitOf(L, false)));
  t("會先問(可能在下單 / 回合在跑):字尾「…」= tm.quit", quitOf(L, true) === zh("tm.quit") && /…$/.test(quitOf(L, true)));
  t("renderer 還沒交字:英文退路也帶「…」", quitOf({}, true) === "Quit Blave…" && quitOf({}, false) === "Quit Blave");
  t("不帶 ask 的舊呼叫 = 不問", quitOf(L, undefined) === zh("menu.quit"));
  const sync = cut("function appMenuSync(");
  t("appMenuSync:ask = tradeMaybeLive() || activeTurn || turnStarting,進 key、傳給樣板", /const ask = !!\(tradeMaybeLive\(\) \|\| activeTurn \|\| turnStarting\);/.test(sync)
    && /JSON\.stringify\(\[uiLang, full, ask, tmLabels\.quit,/.test(sync) && /onFull, ask\)\)\);/.test(sync));
  t("5 秒那一輪也叫 appMenuSync(下單狀態沒有事件,靠這裡補)", /startStep\("tray", traySync\); startStep\("app menu", appMenuSync\);/.test(cut("function trayStart(")));
}
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
