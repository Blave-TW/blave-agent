// 策略頁頭〔自動下單〕單鈕(spec strategy-page-autotrade-2026-10-31 §4、§5、§13–15;視覺 prototype-v8)。
//   ① 純邏輯(不開窗):handoff.js 的 SP_HEAD／spHead 原文切出來跑——§4 每一態一列,優先序衝突(HALT＋沒路由、setup＋沒路由、
//      連接中＋另一支沒配、讀不到＋鎖住…)各一列;表上每一態都被列舉到(新增一態沒有測試就紅)
//   ② 接線(不開窗):五道守門在 trGoClick、#tr-go 與策略頁同一支;onConnected 只在 cxModalClose 設、capHandoff 不設;
//      「連接中」不掛 TRP.timer;埋點五個都有送出點
//   ③ 真的開 index.html(隨包 Electron,BLAVE_TEST_WINDOW=1;window.blave 換成假的、不碰鑰匙圈與 ~/Blave):
//      §4 每一態在本機視角各畫一次(鈕字、停用、狀態詞、記號、說明下一行),雲端視角抽三態;
//      「模擬 → 自動開啟動框」「真錢 → 停在〔啟動下單〕」兩段一律用替身(trAskStart／trAskAccount／trAskStop／trGoClick 換成記錄器),
//      任何一段都不會真的開啟動框或送 resume——替身之外另外斷言 tradeSend 從沒送過 resume／resume_wait／restart_reconciler
// 跑法:node tests/check_shell_sp_autotrade.js(①②);BLAVE_TEST_WINDOW=1 node tests/check_shell_sp_autotrade.js(連 ③)
const path = require("path"), fs = require("fs"), vm = require("vm"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
const GATE = require("./_electron_gate");
const J = JSON.stringify;
let red = 0; const ok = (n, c, info) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || !info ? "" : "\n      " + info)); if (!c) red++; };

if (!process.versions.electron) {
  const ho = fs.readFileSync(path.join(R, "handoff.js"), "utf8"), tr = fs.readFileSync(path.join(R, "trade.js"), "utf8"), po = fs.readFileSync(path.join(R, "portfolio.js"), "utf8");
  const cap = fs.readFileSync(path.join(R, "capital.js"), "utf8");
  const fnOf = (src, n) => { const i = src.indexOf("function " + n + "("); if (i < 0) return ""; const j = src.indexOf("\nfunction ", i + 1), k = src.indexOf("\nasync function ", i + 1); return src.slice(i, Math.min(j < 0 ? src.length : j, k < 0 ? src.length : k)); };
  // ── ① 純邏輯
  const ctx = vm.createContext({});
  try { vm.runInContext(ho.slice(ho.indexOf("/* ── 純邏輯("), ho.indexOf("/* ── 純邏輯到此")).replace(/^const /gm, "var "), ctx); } catch (e) { console.log("FAIL  ① 純邏輯段載入失敗:" + e.message); red++; }
  const seen = new Set();
  // 預設 = 已配、有帳戶、路由齊、沒在跑:「已連接・尚未啟動」
  const H = (o) => { if (typeof ctx.spHead !== "function") return { st: null }; const v = ctx.spHead(Object.assign({ market: "crypto", configured: true, hasAcct: true, goKey: "tr.start" }, o)); seen.add(v.st); return v; };
  const is = (v, st, btn, more) => v.st === st && J(v.btn) === J(btn) && Object.keys(more || {}).every((k) => J(v[k]) === J(more[k]));
  const row = (name, o, st, btn, more) => { const v = H(o); ok("① " + name, is(v, st, btn, more), J(v)); };
  row("沒回測:不畫主鈕(連雲朵之外什麼都沒有)", { noBt: true }, "none", null, { word: null, note: null, mark: false });
  row("Type B:不畫主鈕", { typeB: true, configured: false }, "none", null);
  row("美股純代號:不畫主鈕、狀態詞「不能自動下單」;讀不到也是這一態(優先)", { market: "us", unread: true }, "us", null, { word: "tr.mkt.noAuto" });
  row("讀不到:加密鈕字基本字「自動下單」、真 disabled、沒有原因句", { unread: true }, "unread", { key: "sp.btn", kind: "fill", act: null, off: true }, { note: null, word: null });
  row("讀不到:台股基本字「加到策略組合」", { unread: true, market: "tw" }, "unread", { key: "po.add", kind: "fill", act: null, off: true });
  row("讀不到優先於鎖住", { unread: true, locked: true, configured: false }, "unread", { key: "sp.btn", kind: "fill", act: null, off: true });
  const FN = { key: "cx.failStopped", go: "set" };
  row("金鑰被拒、下單程式沒在跑(fail):基本字停用 + 自動下單頁那一句原因;排在鎖住、沒配之前", { failKey: true, failRead: true, failNote: FN, configured: false, locked: true }, "fail", { key: "sp.btn", kind: "fill", act: null, off: true }, { note: FN });
  row("讀帳失敗、下單程式沒在跑(fail):已配才判,排在連接中之後、沒帳戶之前", { failRead: true, failNote: FN, routeDirty: true }, "fail", { key: "sp.btn", kind: "fill", act: null, off: true }, { note: FN });
  row("讀帳失敗但沒配:照沒配(fail 只擋金鑰被拒那種)", { failRead: true, failNote: FN, configured: false }, "add", { key: "sp.btn", kind: "fill", act: "amt" });
  row("優先序:讀不到 > fail", { unread: true, failKey: true, failRead: true }, "unread", { key: "sp.btn", kind: "fill", act: null, off: true });
  row("優先序:連接中 > 讀帳失敗", { connecting: true, failRead: true }, "connecting", { key: "sp.connecting", kind: "fill", act: null, off: true });
  row("鎖住(沒配):主鈕照畫,按了到選擇策略框", { locked: true, configured: false }, "locked", { key: "sp.btn", kind: "fill", act: "pick" });
  row("鎖住但已在組合(!inCur 豁免由 trPickRows 管;已配不算鎖)→ 照已配往下判", { locked: true }, "start", { key: "tr.start", kind: "fill", act: "go" });
  row("回測完沒配(加密):〔自動下單〕填色 → 開金額框", { configured: false, hasAcct: false }, "add", { key: "sp.btn", kind: "fill", act: "amt" });
  row("回測完沒配(台股):〔加到策略組合〕填色 → 開金額框", { configured: false, market: "tw", hasAcct: false }, "add", { key: "po.add", kind: "fill", act: "amt" });
  row("連接中、另一支沒配:照沒配(存了不接連接框由 spAfterSave 管)", { configured: false, connecting: true, hasAcct: false }, "add", { key: "sp.btn", kind: "fill", act: "amt" });
  row("在跑、這支沒金額:〔自動下單〕(框型由 trCfFiring 決定)", { configured: false, firing: true }, "add", { key: "sp.btn", kind: "fill", act: "amt" });
  row("統一開通中、沒配:〔自動下單〕", { configured: false, setup: true }, "add", { key: "sp.btn", kind: "fill", act: "amt" });
  row("統一開通中、已配:狀態詞「開通中」+〔繼續〕", { setup: true, presContinue: true }, "setup", { key: "cap.continue", kind: "fill", act: "pres" }, { word: "cap.pending" });
  row("群益本機開通中、已配:只有「開通中」,沒有〔繼續〕", { setup: true, presContinue: false }, "setupWait", null, { word: "cap.pending" });
  row("setup＋路由空:落統一那列,不是〔儲存〕", { setup: true, presContinue: true, routeDirty: true }, "setup", { key: "cap.continue", kind: "fill", act: "pres" });
  row("連接中:主鈕字「連接中…」、真 disabled、旁邊不放字", { connecting: true, hasAcct: false }, "connecting", { key: "sp.connecting", kind: "fill", act: null, off: true }, { word: null, note: null });
  row("已配、沒接帳戶:「還沒連接帳戶」+〔連接帳戶〕", { hasAcct: false }, "noAcct", { key: "sp.cx", kind: "fill", act: "cx" }, { word: "sp.noAcct" });
  row("台股已配、沒帳戶:描邊〔到策略組合〕、不出連接框", { hasAcct: false, market: "tw" }, "twNoAcct", { key: "po.addGo", kind: "out", act: "po" });
  row("有帳戶、沒路由:原因句 tr.routeSave + 〔儲存〕", { routeDirty: true }, "route", { key: "tr.save", kind: "fill", act: "route" }, { note: { key: "tr.routeSave" } });
  row("有帳戶、沒路由、策略組合有沒存的改動:sp.unsaved + 描邊〔到策略組合〕", { routeDirty: true, unsaved: true }, "unsaved", { key: "po.addGo", kind: "out", act: "po" }, { note: { key: "sp.unsaved" } });
  row("HALT＋路由空:落沒路由,不是 HALT 那列(HALT 那列要路由齊)", { routeDirty: true, zvOff: true, goKey: "tr.start" }, "route", { key: "tr.save", kind: "fill", act: "route" });
  row("在跑＋路由空:落沒路由", { routeDirty: true, firing: true }, "route", { key: "tr.save", kind: "fill", act: "route" });
  row("綁的那家下不了:〔啟動下單〕真 disabled + 這一支在選擇策略框那一列的原因(§15-1)", { zvOff: true, offNote: { key: "tr.pick.txf", vars: { venue: "統一期貨" } } }, "off",
    { key: "tr.start", kind: "fill", act: null, off: true }, { note: { key: "tr.pick.txf", vars: { venue: "統一期貨" } } });
  row("在跑、這支有金額:只留記號,不畫主鈕(§13-6)", { firing: true }, "running", null, { mark: true });
  row("已連接・尚未啟動:〔啟動下單〕(走 trGoClick)", {}, "start", { key: "tr.start", kind: "fill", act: "go" }, { note: null });
  row("換金鑰後(book_hold):鈕字「確認帳戶」(acct 態,同 web)", { goKey: "tr.acct.btn" }, "acct", { key: "tr.acct.btn", kind: "fill", act: "go" });
  row("帳本上還有部位(tr.startOnBook):原因句照畫、鈕照可按", { goNote: { key: "tr.startOnBook", vars: { n: "3 口" } } }, "start", { key: "tr.start", kind: "fill", act: "go" }, { note: { key: "tr.startOnBook", vars: { n: "3 口" } } });
  row("指令通道不通:〔啟動下單〕停用", { goOff: true }, "start", { key: "tr.start", kind: "fill", act: "go", off: true });
  ok("① SP_HEAD 每一態都有測試列(新增一態沒有測試就紅)", !!ctx.SP_HEAD && Object.keys(ctx.SP_HEAD).every((k) => seen.has(k)), J([...Object.keys(ctx.SP_HEAD || {})].filter((k) => !seen.has(k))));

  // ── ② 接線
  const goClick = fnOf(tr, "trGoClick");
  ok("② trGoClick 五道守門照順序:雲端停機 → 啟動／暫停在途 → 確認帳戶 → 過場鎖 → 暫停側／啟動",
    /envCloudKind\(TR\.st\) === "stopped"/.test(goClick) && goClick.indexOf("envCloudKind(TR.st) === \"stopped\"") < goClick.indexOf("trStartPending(TR.pending) || trHaltInFlight")
    && goClick.indexOf("trHaltInFlight") < goClick.indexOf("trAcctAsk(trReport())") && goClick.indexOf("trAcctAsk(trReport())") < goClick.indexOf("trBtnLocked(TR.pending, stopSide)")
    && goClick.indexOf("trBtnLocked(TR.pending, stopSide)") < goClick.indexOf("trAskStart(b)") && /trAskAccount\(b\); return "acct";/.test(goClick) && /trAskStop\(b\); return "stop";/.test(goClick));
  ok("② #tr-go 與策略頁〔啟動下單〕走同一支 trGoClick;策略頁不直接叫 trAskStart", /b\.addEventListener\("click", \(\) => trGoClick\(b\)\);/.test(tr)
    && /if \(act === "go"\) \{ if \(trGoClick\(b\) === "start"\) trackFeature\("sp_start_opened"\); return; \}/.test(po) && !/trAskStart\(/.test(po));
  ok("② 自動下單頁與策略頁的鈕字／鎖用同一個判定 trGoView", /const gv = trGoView\(state, trReport\(\), TR\.pending, Date\.now\(\)\)/.test(fnOf(tr, "trPaintHead")) && /gv = trGoView\(state, r, S\.pending, now\)/.test(po));
  const cxOpen = fnOf(tr, "cxModalOpen"), cxClose = fnOf(tr, "cxModalClose");
  ok("② onConnected 過了兩道早退才記;cxModalClose(true) 叫一次、false 收掉旗標;設旗標只有 cxModalClose 一處",
    cxOpen.indexOf("CXW.cb = ") > cxOpen.indexOf('envCloudKind(TR_BAGS.cloud.st) !== "running") return;') && /if \(connected === true && cb\) cb\(\); else if \(!connected && TR_BAGS\[CXF\.env\]\) TR_BAGS\[CXF\.env\]\.spCx = null;/.test(cxClose)
    && (tr + po).split("spCx = {").length === 2 && /cxModalOpen\(b, undefined, \(\) => \{ S\.spCx = \{ name, at: Date\.now\(\) \}; ENV\.burst = trBurstBump\(ENV\.burst, Date\.now\(\), TR_BURST_MS, TR_BURST_MAX_MS\); \}\);/.test(po));
  ok("② capHandoff(交給 agent、什麼都沒綁)不進連接中", /cxModalClose\("handoff"\)/.test(cap) && !/capTrack\("rdp"\); cxModalClose\(true\)/.test(cap));
  ok("② 連接中不掛計時器:旗標自帶 at、每輪 trPoll 判(spCxCheck),portfolio.js 的策略頁頭段沒有 setTimeout／TRP.timer",
    /trWith\(L, spCxCheck\); trWith\(C, spCxCheck\);/.test(fnOf(tr, "trPoll")) && !/TRP\.timer|setTimeout/.test(fnOf(po, "spCxCheck") + fnOf(po, "spGoCheck") + fnOf(po, "spCxOpen") + fnOf(po, "spCxOn"))
    && /now - w\.at < TR_CX_SAVED_MS/.test(fnOf(po, "spCxOn")));
  ok("② 接連接框前那一刻重讀 venue:有帳戶永遠不開(這條路不換綁)", /if \(S !== TR_BAGS\[ENV\.cur\] \|\| trWith\(S, \(\) => trVenueIds\(trReport\(\)\)\.length > 0\)\) return;/.test(fnOf(po, "spCxOpen")));
  ok("② 「自動下單中・模擬／真錢」:策略頁頭與策略組合頁 #po-live 用同一個判準 trCfPaperOnly(只綁模擬才寫模擬)",
    /const paper = trCfPaperOnly\(\);/.test(fnOf(po, "poPaint")) && /paper: v\.mark \? trCfPaperOnly\(\) : null/.test(fnOf(po, "spView")) && !/trIsPaper\(\)/.test(fnOf(po, "poPaint")));
  const css = fs.readFileSync(path.join(R, "app.css"), "utf8");
  ok("② 雲朵 tooltip 時機(canon 頂列互動 ⑥):hover 停 --motion-tooltip-delay 才出、鍵盤 focus 立刻出、觸控不出;Esc 走 data-tip-off",
    /\.rp-ic:hover:not\(\[data-tip-off\]\) \+ \.tip \{ visibility: visible; opacity: 1; transition-delay: var\(--motion-tooltip-delay\); \}/.test(css)
    && /\.rp-ic:focus-visible:not\(\[data-tip-off\]\) \+ \.tip \{ visibility: visible; opacity: 1; transition-delay: 0s; \}/.test(css) && /@media \(hover: none\) \{ \.rp-icw \.tip \{ display: none; \} \}/.test(css));
  const SP_EV = ["sp_auto_open", "sp_amt_saved", "sp_cx_opened", "sp_start_opened", "sp_cloud_icon"];
  ok("② 埋點五個 sp_* 都有送出點、名字 ≤16", SP_EV.every((n) => new RegExp('trackFeature\\([^;\\n]*"' + n + '"').test(tr + po + ho) && n.length <= 16), J(SP_EV.filter((n) => !new RegExp('trackFeature\\([^;\\n]*"' + n + '"').test(tr + po + ho))));

  const bin = GATE.bin(SHELL, "③");
  if (!bin) { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  // 開發版規矩:鑰匙圈用假的、BLAVE_HOME 與 user-data 隔離在暫存目錄(window.blave 本來就是假的,這兩道是保險)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "blave-sp-home-"));
  const r = require("child_process").spawnSync(bin, ["--use-mock-keychain", __filename], { stdio: "inherit", env: Object.assign({}, process.env, { BLAVE_HOME: home }) });
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(red || r.status !== 0 ? 1 : 0);
} else {

const { app, BrowserWindow } = require("electron");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-sp-ud-")));
const now = Math.floor(Date.now() / 1000);
const CODE = { btc: 'SYMBOL = "BTCUSDT"\n', txf: 'SYMBOL = "TMF"\n', tw: 'SYMBOL = "2330"\nMARKET = "spot"\n', us: 'SYMBOL = "AMZN"\n', nvda: 'SYMBOL = "NVDAUSDT"\n', nobt: 'SYMBOL = "BTCUSDT"\n', tb: "# Type: B\nSYMBOL = \"BTCUSDT\"\n", eth: 'SYMBOL = "ETHUSDT"\n' };
const SYM = { btc: "BTCUSDT", txf: "TMF", tw: "2330", us: "AMZN", nvda: "NVDAUSDT", nobt: "BTCUSDT", tb: "BTCUSDT", eth: "ETHUSDT" };
const STUB = `window.__over = {}; window.__calls = []; window.__feats = [];
window.__strats = ${J(Object.keys(CODE).map((n, i) => ({ name: n, displayName: n.toUpperCase(), mtime: i + 1, hasBacktest: n !== "nobt" })))};
window.__code = ${J(CODE)}; window.__sym = ${J(SYM)};
window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : k === "trackFeature" ? (n) => { window.__feats.push(n); }
  : async (...a) => { window.__calls.push([k, a]); if (k in window.__over) return window.__over[k](...a);
      if (k === "listStrategies") return window.__strats;
      if (k === "loadStrategy") { const n = a[0]; return { name: n, displayName: n.toUpperCase(), description: "d", code: window.__code[n], symbol: window.__sym[n], stats: n === "nobt" ? null : { symbol: window.__sym[n], "Sharpe Ratio": 1 } }; }
      if (k === "featureFlags") return { cloudHandoff: true };
      if (k === "tradeStatus") return window.__st || null;
      if (k === "tradeSend") { (window.__allCmds = window.__allCmds || []).push(a[0]); const fn = window.__send; return fn ? fn(...a) : { ok: true }; }
      return ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
        listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" } })[k]; } });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const V = { credentials: true, pair: true, order: true, account: true };
const KINDS = { btc: { market: "crypto" }, eth: { market: "crypto" }, txf: { market: "tw_index_futures" }, tw: { market: "tw_stock" }, us: { market: "us_stock" }, nvda: { market: "us_stock" }, tb: { market: "crypto" } };
// 報告(形狀照 runtime/portfolio_reporter.build_report;數字是編的)。venue = null 沒綁;running = 對帳器在跑
const rep = (o) => {
  o = o || {};
  const venue = o.venue === undefined ? null : o.venue, venues = venue ? (Array.isArray(venue) ? Object.fromEntries(venue.map((v) => [v, V])) : { [venue]: V }) : {};
  const amounts = o.amounts || {}, ex = o.exchanges !== undefined ? o.exchanges : venue ? Object.fromEntries(Object.keys(amounts).map((n) => [n, Array.isArray(venue) ? venue[0] : venue])) : {};
  const r = { venues, config: { amounts, exchanges: ex }, strategy_kinds: KINDS, quote_ccy: { btc: "USDT", eth: "USDT", tw: "TWD", txf: null },
    account: { read_at: now, venues: venue ? Object.fromEntries(Object.keys(venues).map((v) => [v, { ok: true, equity: 10000, currency: v === "president" ? "TWD" : "USDT", positions: {} }])) : {} },
    reconciler: { alive: !!o.running, heartbeat_at: o.running ? now : null }, command_listener: { alive: true }, daemon: { reconciler: { running: !!o.running, wanted: !!o.running } },
    can_trade_portfolio: true, can_paper_twstock: true, can_switch_contract: false, can_wait_start: true, states: {}, backtest_previews: o.pv || {} };
  if (o.halt) r.halt = { halted: true, source: "desktop", holds_all: false };
  if (o.bookHold) r.account_guard = { venue, book_hold: { venue, reason: "key changed", since: now - 60, ask: true } };
  return Object.assign(r, o.extra || {});
};

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  setTimeout(() => { console.log("FAIL  ③ 逾時(300 秒內沒跑完)"); app.exit(1); }, 300000).unref();
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1200);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const run = (s) => js("(() => { " + s + "; return 0; })()");
  const T = (k, v) => js(`t(${J(k)}${v ? ", " + J(v) : ""})`);
  // 替身:三個框與 trGoClick 都換成記錄器(真的那一支在 window.__realGo),代理不會真的開啟動框或確認下單
  await run(`window.__realGo = trGoClick; window.__spy = []; trAskStart = function (o) { window.__spy.push("start"); }; trAskAccount = function (o) { window.__spy.push("acct"); }; trAskStop = function (o) { window.__spy.push("stop"); };
    window.__spyGo = function (b) { window.__spy.push("go"); return "start"; };`);
  const setRep = (r, o) => run(`window.__st = { alive: true, running: true, report: ${J(r)} }; ${o || ""}`);
  const poll = async () => { await js(`trPoll().then(() => 0)`); await wait(120); };
  const sel = async (n) => { await js(`(async () => { await stratRefresh(false); await stratSelect(${J(n)}, true); return 0; })()`); await wait(150); await poll(); await run("hoPaint()"); };
  const head = () => js(`(() => { const g = $("rp-go"), a = $("rp-act"), n = $("rp-ho-note"), m = a.querySelector(".mode"), s = a.querySelector(".rp-status");
    return { st: (spView(ENV.cur === "cloud") || {}).st, go: g ? g.textContent : null, dis: g ? g.disabled : null, kind: g ? g.className : null, act: g ? g.dataset.act : null,
      word: s ? s.textContent : null, mark: m ? m.textContent : null, markKind: m ? m.className : null, note: n.hidden ? null : n.textContent, ic: !!$("rp-ho"), actHidden: a.hidden,
      del: !$("del-scrim").hidden, cx: !$("cx-scrim").hidden }; })()`);
  const box = () => js(`({ open: !$("del-scrim").hidden, title: $("del-title").textContent, ok: $("del-ok").textContent, dis: $("del-ok").disabled, mark: $("del-mark").hidden ? null : $("del-mark").textContent,
    link: $("del-link").hidden ? null : $("del-link").textContent, focus: document.activeElement && document.activeElement.id, body: $("del-body").textContent })`);
  const type = (v) => run(`const i = $("cf-in"); i.value = ${J(v)}; i.dispatchEvent(new Event("input"))`);
  const sentCmds = () => js(`window.__calls.filter((c) => c[0] === "tradeSend").map((c) => c[1][0])`);
  const reset = () => run(`window.__calls.length = 0; window.__feats.length = 0; window.__spy.length = 0; window.__send = null; trGoClick = window.__realGo;
    if (!$("del-scrim").hidden) delClose(false); if (!$("cx-scrim").hidden) cxModalClose(false); for (const k of ["local", "cloud"]) { const S = TR_BAGS[k]; S.spCx = null; S.spGo = null; S.spErr = null; S.edits = {}; S.raw = {}; S.bad = {}; S.picked = null; S.ct.edits = {}; S.pending = null; S.save = null; S.saveErr = null; }`);
  const st = async (name, r, o) => { await reset(); await setRep(r, o); await sel(name); await poll(); return head(); };
  const tx = {}; for (const k of ["sp.btn", "po.add", "po.addGo", "sp.cx", "sp.noAcct", "sp.connecting", "sp.unsaved", "tr.routeSave", "tr.save", "tr.start", "tr.acct.btn", "cap.pending", "cap.continue", "tr.mkt.noAuto", "tr.cf.title", "tr.cf.titleFire", "tr.mode.paper", "tr.mode.real", "ho.up.btn"]) tx[k] = await T(k);

  // ── §4 每一態(本機視角)
  await run(`envSwitch("local")`);
  let h = await st("nobt", rep({}));
  ok("③ 沒回測:沒有主鈕,只有雲朵 icon 鈕", h.go === null && h.ic && !h.word, J(h));
  h = await st("tb", rep({}));
  ok("③ Type B:沒有主鈕", h.go === null, J(h));
  h = await st("us", rep({}));
  ok("③ 美股純代號:沒有主鈕、狀態詞「不能自動下單」", h.st === "us" && h.go === null && h.word === tx["tr.mkt.noAuto"], J(h));
  h = await st("nvda", rep({}));
  ok("③ 股票永續(NVDAUSDT,us_stock 策略下加密所):照加密畫〔自動下單〕", h.st === "add" && h.go === tx["sp.btn"] && !h.dis, J(h));
  h = await st("btc", rep({ extra: { error: "boom", venues: undefined } }));
  ok("③ 讀不到(狀態檔 build 失敗 = unknown,不是沒帳戶):〔自動下單〕真 disabled、沒有原因句", h.st === "unread" && h.go === tx["sp.btn"] && h.dis === true && h.note === null, J(h));
  h = await st("btc", rep({ venue: "paper", amounts: { btc: 500 } }), `TR_BAGS.local.pending = { want: "running", until: Date.now() + 60000 }`);
  ok("③ 啟動在途(trStartPending):主鈕真 disabled", h.st === "unread" && h.dis === true, J(h));
  h = await st("btc", rep({}));
  ok("③ 回測完、沒配(加密、沒帳戶):〔自動下單〕填色可按", h.st === "add" && h.go === tx["sp.btn"] && h.kind === "btn-fill" && !h.dis, J(h));
  h = await st("tw", rep({}));
  ok("③ 回測完、沒配(台股):〔加到策略組合〕填色", h.st === "add" && h.go === tx["po.add"] && h.kind === "btn-fill", J(h));
  h = await st("tw", rep({ venue: "binance", amounts: { btc: 500 } }));
  ok("③ 鎖住(台股＋綁加密所,MARKET_VENUE):主鈕照畫、按了不開金額框", h.st === "locked" && h.go === tx["po.add"] && !h.dis, J(h));
  await run(`$("rp-go").click()`); await wait(500);
  const pk = await js(`({ open: !$("ps-scrim").hidden, notes: [...document.querySelectorAll("#ps-list .ps-note")].map((x) => x.textContent) })`);
  ok("③ …按了到選擇策略框,那一列寫「台幣標的的策略不能配到 Binance」;沒開金額框", pk.open && pk.notes.includes(await T("tr.pick.twdVenue", { venue: "Binance" })) && !(await box()).open, J(pk));
  await run(`if (!$("ps-scrim").hidden) psClose(false)`); await sel("tw");
  h = await st("txf", rep({ venue: "binance", amounts: { btc: 500 } }));
  ok("③ 鎖住(台指期＋綁加密所也算台幣標的)", h.st === "locked", J(h));
  h = await st("btc", rep({ amounts: { btc: 500 } }));
  ok("③ 已配、沒接帳戶:「還沒連接帳戶」+〔連接帳戶〕", h.st === "noAcct" && h.word === tx["sp.noAcct"] && h.go === tx["sp.cx"] && h.kind === "btn-fill", J(h));
  h = await st("tw", rep({ amounts: { tw: 100000 } }));
  ok("③ 台股已配、沒帳戶:描邊〔到策略組合〕", h.st === "twNoAcct" && h.go === tx["po.addGo"] && h.kind === "btn-out", J(h));
  h = await st("btc", rep({ venue: "binance", amounts: { btc: 500 }, exchanges: {} }));
  ok("③ 有帳戶、沒路由:說明下一行 tr.routeSave + 〔儲存〕", h.st === "route" && h.go === tx["tr.save"] && h.note === tx["tr.routeSave"], J(h));
  h = await st("btc", rep({ venue: "binance", amounts: { btc: 500 }, exchanges: {}, halt: true }));
  ok("③ 優先序:HALT＋路由空 → 沒路由那列(〔儲存〕),不是 HALT 的〔啟動下單〕", h.st === "route" && h.go === tx["tr.save"], J(h));
  h = await st("btc", rep({ venue: "binance", amounts: { btc: 500 }, exchanges: {} }), `TR_BAGS.local.edits = { btc: 900 }`);
  ok("③ …sp.unsaved 那句是純文字(旁邊已有〔到策略組合〕,不給第二個入口)", (await js(`$("rp-ho-note").querySelectorAll("button").length`)) === 0);
  ok("③ 有帳戶、沒路由、策略組合有沒存的金額:sp.unsaved + 描邊〔到策略組合〕", h.st === "unsaved" && h.go === tx["po.addGo"] && h.note === tx["sp.unsaved"], J(h));
  h = await st("btc", rep({ venue: "binance", amounts: { btc: 500 }, exchanges: {} }), `TR_BAGS.local.picked = new Set(["btc", "eth"])`);
  ok("③ …勾了 eth 沒填金額(picker 草稿):一樣出〔到策略組合〕不出〔儲存〕", h.st === "unsaved", J(h));
  h = await st("txf", rep({ venue: "binance", amounts: { txf: 2 }, exchanges: {}, extra: { can_switch_contract: true, config: { amounts: { txf: 2 }, exchanges: {}, contracts: {} } } }), `TR_BAGS.local.ct.edits = { txf: "MXF" }`);
  ok("③ …換了合約沒存:一樣出〔到策略組合〕", h.st === "unsaved", J(h));
  h = await st("txf", rep({ venue: "president", amounts: { txf: 2 }, exchanges: {}, extra: { president_connect: { stage: "probe" } } }));
  const setupS = await js(`trExecState(TR_BAGS.local.st)`);
  ok("③ 優先序:setup＋路由空 → 統一那列「開通中」+〔繼續〕(不是〔儲存〕)", setupS === "setup" && h.st === "setup" && h.word === tx["cap.pending"] && h.go === tx["cap.continue"], J({ setupS, h }));
  h = await st("btc", rep({ venue: "president", amounts: { btc: 500 } }));
  ok("③ 綁的那家下不了(加密策略、綁統一):〔啟動下單〕真 disabled + 那一列的原因「統一期貨只能下台指期」", h.st === "off" && h.go === tx["tr.start"] && h.dis === true
    && h.note === (await T("tr.pick.txf", { venue: await T("pres.venue") })), J(h));
  h = await st("btc", rep({ venue: "paper", amounts: { btc: 500 } }));
  ok("③ 已連接・尚未啟動:〔啟動下單〕填色可按,沒有原因句", h.st === "start" && h.go === tx["tr.start"] && !h.dis && h.note === null, J(h));
  await run(`$("rp-go").click()`); await wait(200);
  ok("③ …按〔啟動下單〕走 trGoClick → 替身 trAskStart(沒有真的開啟動框);記 sp_start_opened", J(await js("window.__spy")) === J(["start"]) && !(await box()).open && (await js("window.__feats")).includes("sp_start_opened"), J(await js("window.__spy")));
  h = await st("btc", rep({ venue: "okx", amounts: { btc: 500 }, halt: true, bookHold: true }));
  ok("③ 換金鑰後(book_hold):鈕字「確認帳戶」", h.st === "acct" && h.go === tx["tr.acct.btn"] && !h.dis, J(h));
  await run(`$("rp-go").click()`); await wait(200);
  ok("③ …按了走 trGoClick → 替身 trAskAccount,不開啟動框", J(await js("window.__spy")) === J(["acct"]), J(await js("window.__spy")));
  h = await st("btc", rep({ venue: "binance", amounts: { btc: 500 }, halt: true }));
  ok("③ 暫停中(HALT、路由齊):同「已連接・尚未啟動」〔啟動下單〕", h.st === "start" && h.go === tx["tr.start"], J(h));
  h = await st("btc", rep({ venue: "paper", amounts: { btc: 500 }, running: true }));
  ok("③ 在跑、這支有金額:只有記號「自動下單中・模擬」,沒有主鈕", h.st === "running" && h.go === null && h.mark === (await T("po.live", { mode: tx["tr.mode.paper"] })) && /paper/.test(h.markKind), J(h));
  h = await st("btc", rep({ venue: "binance", amounts: { btc: 500 }, running: true }));
  ok("③ 在跑(真錢):記號「自動下單中・真錢」", h.st === "running" && h.mark === (await T("po.live", { mode: tx["tr.mode.real"] })) && /real/.test(h.markKind), J(h));
  h = await st("eth", rep({ venue: "binance", amounts: { btc: 500 }, running: true }));
  ok("③ 在跑、這支沒金額:〔自動下單〕", h.st === "add" && h.go === tx["sp.btn"], J(h));
  h = await st("btc", rep({}), `TR_BAGS.local.spCx = { name: "btc", at: Date.now() }`);
  ok("③ 連接中:主鈕「連接中…」真 disabled、旁邊不放字", (await js(`(TR_BAGS.local.st.report.config.amounts = { btc: 500 }, hoPaint(), 0)`)) === 0 && (h = await head()) && h.st === "connecting" && h.go === tx["sp.connecting"] && h.dis === true && !h.word, J(h));

  // ── 綁了但讀帳失敗、金鑰被拒:說明行要有原因(設計稽核 §6)
  const failAcct = { read_at: now, venues: { binance: { ok: false, error: "get_equity: 401 invalid api key" } } };
  h = await st("btc", rep({ venue: "binance", amounts: { btc: 1000 }, extra: { account: failAcct } }));
  ok("③ 綁了但讀帳失敗、下單程式沒在跑(fail):〔自動下單〕停用、說明下一行「串接失敗，下單程式沒在跑。到「設定」處理。」(同自動下單頁那句)", h.st === "fail" && h.go === tx["sp.btn"] && h.dis === true
    && h.note === (await T("cx.failStopped")), J(h));
  ok("③ …句子裡的「設定」是連結", (await js(`[...$("rp-ho-note").querySelectorAll("button")].map((b) => b.textContent).join()`)) === (await T("tr.tab.set")));
  await run(`const q = $("rp-ho-note").querySelector("button"); if (q) q.click()`); await wait(400);
  ok("③ …按了到自動下單 › 設定分頁", (await js(`TR.open && TR.view === "tr" && TR.tab === "set" && !$("tr").hidden`)) === true, J(await js(`({ open: TR.open, view: TR.view, tab: TR.tab })`)));
  h = await st("btc", rep({ venue: "binance", amounts: { btc: 1000 }, running: true, extra: { account: failAcct } }));
  ok("③ 讀帳失敗、下單程式還在跑:記號照出,說明行是「串接失敗」", h.st === "running" && !!h.mark && !!h.note && h.note.startsWith(await T("cx.failShort")), J(h));
  ok("③ …那一句帶一顆到自動下單頁的文字鈕", (await js(`[...$("rp-ho-note").querySelectorAll("button")].map((b) => b.textContent).join()`)) === (await T("tr.nav")));
  await run(`const q = $("rp-ho-note").querySelector("button"); if (q) q.click()`); await wait(400);
  ok("③ …按了到自動下單頁", (await js(`TR.open && TR.view === "tr" && !$("tr").hidden`)) === true);
  h = await st("eth", rep({ venue: "binance", amounts: { btc: 1000 } }), `CXF.bn = { verdict: { reason: "KEY_REJECTED" } }`);
  ok("③ 金鑰被拒(Binance 重查不過)、這一支還沒配:一樣是 fail,不給〔自動下單〕開框", h.st === "fail" && h.dis === true && h.note === (await T("cx.failStopped")), J(h));
  await run(`CXF.bn = null`);

  // ── 金額框:加密不在跑(儲存金額)、模擬在跑(儲存並下單)、台指期口數
  h = await st("btc", rep({ pv: { btc: { symbol: "BTCUSDT", position: 1, close: 50000, bar_at: now - 3600, latest: true } } }));
  await run(`$("rp-go").click()`); await wait(400);
  let b = await box();
  ok("③ 金額框剛打開、輸入格空著:表下沒有「名字 0 加入」那一列(設計稽核 §1 可刪 1)", (await js(`document.querySelectorAll("#del-body .cf-strat .cf-row").length`)) === 0 && !b.body.includes(await T("tr.cfTagAdd")), J(b));
  ok("③ 金額框(加密、沒在跑):標題「儲存金額」、主鈕「儲存」停用(空白)、焦點在輸入格、框腳「到策略組合」、沒記號;記 sp_auto_open",
    b.open && b.title === tx["tr.cf.title"] && b.ok === tx["tr.save"] && b.dis && b.focus === "cf-in" && b.link === tx["po.addGo"] && !b.mark && (await js("window.__feats")).includes("sp_auto_open"), J(b));
  await type("1000"); b = await box();
  ok("③ …打 1,000:主鈕可按、輸入格下面寫換算量 0.02 BTC", !b.dis && /0\.02/.test(await js(`$("cf-body") ? "" : (document.querySelector(".cf-in-ref") || {}).textContent || ""`)), J(b));
  ok("③ …換算量的數字是 mono(同框裡的下單列、同 web)", (await js(`(() => { const m = document.querySelector(".cf-in-ref .mono"); return !!m && m.textContent === "0.02" && /mono/i.test(getComputedStyle(m).fontFamily); })()`)) === true);
  await run(`$("del-cancel").click()`); await wait(100);
  for (const [pos, what] of [[-1, "空單"], [0, "空手"]]) {
    h = await st("btc", rep({ pv: { btc: { symbol: "BTCUSDT", position: pos, close: 50000, bar_at: now - 3600, latest: true } } }));
    await run(`$("rp-go").click()`); await wait(400); await type("1000"); await wait(100);
    const ref = await js(`(() => { const r = document.querySelector(".cf-in-ref"); return r && !r.hidden ? r.textContent : null; })()`);
    ok("③ 訊號是" + what + "(單腳加密、沒在跑):換算量照出 0.02(輸入的金額 ÷ 價,不看訊號方向;0.1.39 開發版實跑 SOL 空單沒出)", !!ref && /^0\.02 /.test(ref), J(ref));
    await run(`$("del-cancel").click()`); await wait(100);
  }
  h = await st("btc", rep({ venue: "paper", amounts: { eth: 300 }, running: true, pv: { btc: { symbol: "BTCUSDT", position: 1, close: 50000, bar_at: now - 3600, latest: true } } }));
  await run(`$("rp-go").click()`); await wait(400); await type("1000"); await wait(100); b = await box();
  ok("③ 金額框(模擬在跑):標題與主鈕「儲存並下單」、記號「模擬」", b.title === tx["tr.cf.titleFire"] && b.ok === tx["tr.cf.titleFire"] && b.mark === tx["tr.mode.paper"], J(b));
  await run(`$("cf-in").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`); await wait(150);
  ok("③ …儲存並下單型:Enter 不送", (await box()).open && !(await sentCmds()).includes("amounts"));
  await run(`$("del-cancel").click()`); await wait(100);
  h = await st("txf", rep({}));
  await run(`$("rp-go").click()`); await wait(400); b = await box();
  const lab = await js(`(document.querySelector(".cf-in-fld .fld-l") || {}).textContent`);
  ok("③ 金額框(台指期):輸入格標籤「口數」、單位「口」", b.open && lab === (await T("tr.lotsAria")), J({ b, lab }));
  await type("2");
  ok("③ …沒有報價:不出只剩商品名的換算行", (await js(`(() => { const r = document.querySelector(".cf-in-ref"); return !!r && r.hidden && r.textContent === ""; })()`)) === true);
  await run(`TR_TXF.price = 23000`); await type("3");
  ok("③ …有報價:換算行「微台 ≈ 690,000 TWD」(數字 mono)", (await js(`(() => { const r = document.querySelector(".cf-in-ref"); return !r.hidden && /690,000/.test(r.textContent) && !!r.querySelector(".mono"); })()`)) === true);
  await run(`TR_TXF.price = null`);
  await run(`$("del-cancel").click()`); await wait(100);

  // ── 存了接連接框 → 連接中 → 模擬:自動開啟動框(替身)
  h = await st("btc", rep({ pv: { btc: { symbol: "BTCUSDT", position: 1, close: 50000, bar_at: now - 3600, latest: true } } }));
  await run(`window.__send = async (cmd, args) => { if (cmd === "amounts") { window.__st.report.config.amounts = Object.assign({}, args.amounts); } return { ok: true }; }`);
  await run(`$("rp-go").click()`); await wait(400); await type("1000"); await run(`$("del-ok").click()`); await wait(800);
  h = await head();
  ok("③ 沒帳戶、存成功:接著開連接框;記 sp_amt_saved、sp_cx_opened;只送 amounts {btc: 1000}", h.cx && (await js("window.__feats")).includes("sp_amt_saved") && (await js("window.__feats")).includes("sp_cx_opened")
    && J(await js(`window.__calls.filter((c) => c[0] === "tradeSend" && c[1][0] === "amounts").map((c) => c[1][1].amounts)`)) === J([{ btc: 1000 }]), J(h));
  const sameTick = await js(`(() => { cxModalClose(true); const g = $("rp-go"); return { go: g && g.textContent, dis: g && g.disabled }; })()`);
  ok("③ 連接框送出那一下(同一個 tick,不等 trPoll):頁首主鈕已經是停用的「連接中…」", sameTick.go === tx["sp.connecting"] && sameTick.dis === true, J(sameTick));
  await wait(100); h = await head();
  const burst = await js(`ENV.burst && ENV.burst.until > Date.now()`);
  ok("③ 連接框送出(cxModalClose(true)):頁頭「連接中…」停用、爆發輪詢開著", h.st === "connecting" && h.go === tx["sp.connecting"] && h.dis === true && burst, J({ h, burst }));
  await run(`trPollSoon(60000)`);
  ok("③ …trPollSoon 清掉 TRP.timer 也不影響連接中(旗標帶 at,不是計時器)", (await js(`!!TR_BAGS.local.spCx && typeof TR_BAGS.local.spCx.at === "number"`)) === true);
  await run(`window.__st.report = Object.assign(window.__st.report, { venues: { paper: ${J(V)} }, config: { amounts: { btc: 1000 }, exchanges: { btc: "paper" } } })`);
  await poll(); await poll();
  ok("③ 模擬接上(報告有帳戶、路由齊):自動開啟動框——走 trGoClick 的守門,替身 trAskStart 收到;記 sp_start_opened;沒有真的送 resume",
    J(await js("window.__spy")) === J(["start"]) && (await js("window.__feats")).includes("sp_start_opened") && !(await sentCmds()).some((c) => /^resume|restart_reconciler/.test(c)), J({ spy: await js("window.__spy"), cmds: await sentCmds() }));

  // 模擬接上、但報告帶著 HALT:不自動開(暫停是用戶自己的決定;設計稽核 §4-2,Wei 照建議)。首綁沒有 HALT 的照開(上一條、下一條)
  h = await st("btc", rep({ amounts: { btc: 1000 } }), `TR_BAGS.local.spCx = { name: "btc", at: Date.now() }`);
  await run(`window.__st.report = Object.assign(window.__st.report, { venues: { paper: ${J(V)} }, config: { amounts: { btc: 1000 }, exchanges: { btc: "paper" } }, halt: { halted: true, source: "desktop", holds_all: false } })`);
  await poll(); await poll();
  h = await head();
  ok("③ 模擬接上＋HALT 還在:不自動開啟動框(替身沒被叫),頁首停在〔啟動下單〕、旗標收掉", J(await js("window.__spy")) === "[]" && h.st === "start" && h.go === tx["tr.start"] && (await js("TR_BAGS.local.spGo")) === null && (await js("TR_BAGS.local.spCx")) === null, J({ spy: await js("window.__spy"), h }));
  h = await st("btc", rep({ amounts: { btc: 1000 } }), `TR_BAGS.local.spCx = { name: "btc", at: Date.now() }`);
  await run(`window.__st.report = Object.assign(window.__st.report, { venues: { paper: ${J(V)} }, config: { amounts: { btc: 1000 }, exchanges: { btc: "paper" } } })`);
  await poll(); await poll();
  ok("③ 對照:同一條路、首綁沒有 HALT → 照樣自動開啟動框(替身 trAskStart 收到一次)", J(await js("window.__spy")) === J(["start"]), J(await js("window.__spy")));
  h = await st("eth", rep({ venue: "paper", amounts: { btc: 500 }, halt: true, pv: { eth: { symbol: "ETHUSDT", position: 1, close: 3000, bar_at: now - 3600, latest: true } } }));
  await run(`window.__send = async (cmd, args) => { if (cmd === "amounts") { window.__st.report.config.amounts = Object.assign({}, args.amounts); window.__st.report.config.exchanges = Object.fromEntries(Object.keys(args.amounts).map((n) => [n, "paper"])); } return { ok: true }; }`);
  await run(`$("rp-go").click()`); await wait(400); await type("300"); await run(`$("del-ok").click()`); await wait(800); await poll(); await poll();
  ok("③ 已綁模擬、暫停中、從策略頁存一支新的:存完不自動開啟動框", (await js(`window.__calls.some((c) => c[0] === "tradeSend" && c[1][0] === "amounts")`)) && J(await js("window.__spy")) === "[]" && (await head()).st === "start", J({ spy: await js("window.__spy"), h: await head() }));

  // ── 真錢:連接中 → 接上 → 停在〔啟動下單〕,不自動開;按了才走 trGoClick(替身)
  h = await st("btc", rep({ amounts: { btc: 1000 } }));
  await run(`$("rp-go").click()`); await wait(300);
  ok("③ 「還沒連接帳戶」按〔連接帳戶〕:開連接框、記 sp_cx_opened", (await head()).cx && (await js("window.__feats")).includes("sp_cx_opened"));
  await run(`cxModalClose(true); trGoClick = window.__spyGo`); await wait(50);
  await run(`window.__st.report = Object.assign(window.__st.report, { venues: { binance: ${J(V)} }, config: { amounts: { btc: 1000 }, exchanges: { btc: "binance" } }, account: { read_at: ${now}, venues: { binance: { ok: true, equity: 10000, currency: "USDT", positions: {} } } } })`);
  await poll(); await poll(); h = await head();
  ok("③ 真錢接上:頁頭停在〔啟動下單〕,不自動開啟動框(trGoClick 替身沒被叫)", h.st === "start" && h.go === tx["tr.start"] && J(await js("window.__spy")) === "[]", J({ h, spy: await js("window.__spy") }));
  await run(`$("rp-go").click()`); await wait(150);
  ok("③ …按〔啟動下單〕:走 trGoClick(替身收到一次)", J(await js("window.__spy")) === J(["go"]));

  // ── 重綁:報告一帶出 venue 就離開連接中(路由空 → 直接落「有帳戶、沒路由」,不乾等 180 秒;spec §2-2,0.1.39 開發版實跑)
  h = await st("btc", rep({ amounts: { btc: 1000 } }), `TR_BAGS.local.spCx = { name: "btc", at: Date.now() }`);
  ok("③ 重綁送出後:連接中", h.st === "connecting", J(h));
  await run(`window.__st.report = Object.assign(window.__st.report, { venues: { binance: ${J(V)} }, config: { amounts: { btc: 1000 }, exchanges: {} }, account: { read_at: ${now}, venues: { binance: { ok: true, equity: 10000, currency: "USDT", positions: {} } } } })`);
  await poll(); h = await head();
  ok("③ 重綁:報告帶出 venue、路由空 → 下一輪就離開連接中、落「有帳戶、沒路由」(旗標收掉,不等 180 秒)", h.st === "route" && (await js("TR_BAGS.local.spCx")) === null && J(await js("window.__spy")) === "[]", J(h));
  h = await st("btc", rep({ amounts: { btc: 1000 } }), `TR_BAGS.local.spCx = { name: "btc", at: Date.now() }; trGoClick = window.__spyGo`);
  await run(`window.__st.report = Object.assign(window.__st.report, { venues: { binance: ${J(V)} }, config: { amounts: { btc: 1000 }, exchanges: { btc: "binance" } }, account: { read_at: ${now}, venues: { binance: { ok: true, equity: 10000, currency: "USDT", positions: {} } } } })`);
  await poll(); h = await head();
  ok("③ 首綁真錢(同一份報告就帶出路由):照樣走到已連接〔啟動下單〕、不自動開", h.st === "start" && (await js("TR_BAGS.local.spCx")) === null && J(await js("window.__spy")) === "[]", J(h));

  // ── 超時兩種
  h = await st("btc", rep({ amounts: { btc: 1000 } }), `TR_BAGS.local.spCx = { name: "btc", at: Date.now() - 200000 }`);
  ok("③ 超時、venue 沒進報告:落「還沒連接帳戶」", h.st === "noAcct" && (await js("TR_BAGS.local.spCx")) === null, J(h));
  h = await st("btc", rep({ venue: "binance", amounts: { btc: 1000 }, exchanges: {} }), `TR_BAGS.local.spCx = { name: "btc", at: Date.now() - 200000 }`);
  ok("③ 超時、venue 在、路由空:落「有帳戶、沒路由」", h.st === "route", J(h));
  await run(`$("rp-go").click()`); await wait(500);
  ok("③ …按〔儲存〕:不開框直送整份已存的 amounts", !(await box()).open && J(await js(`window.__calls.filter((c) => c[0] === "tradeSend" && c[1][0] === "amounts").map((c) => c[1][1].amounts)`)) === J([{ btc: 1000 }]));
  h = await st("btc", rep({ venue: "binance", amounts: { btc: 1000 }, exchanges: {} }), `window.__send = async () => ({ ok: false, error: "ValueError: MARKET_VENUE: x" })`);
  await run(`$("rp-go").click()`); await wait(500); h = await head();
  ok("③ …直送失敗:原因換在說明下一行(沒有框可重開)= 那次存檔的錯誤句", h.st === "route" && !!h.note && h.note !== tx["tr.routeSave"] && h.note === (await js("TR_BAGS.local.saveErr")), J(h));
  ok("③ …那句用錯誤色(同框裡的 cf-block)", (await js(`(() => { const x = document.createElement("span"); x.style.color = "var(--color-redText)"; document.body.appendChild(x); const want = getComputedStyle(x).color; x.remove();
    return $("rp-ho-note").classList.contains("err") && getComputedStyle($("rp-ho-note")).color === want; })()`)) === true);
  h = await st("btc", rep({ venue: "binance", amounts: { btc: 1000 } }));
  ok("③ 對照:一般原因句不是錯誤色", (await js(`$("rp-ho-note").classList.contains("err")`)) === false);

  // ── 失敗重開同一個框
  h = await st("btc", rep({ venue: "binance", amounts: { eth: 300 }, pv: { btc: { symbol: "BTCUSDT", position: 1, close: 50000, bar_at: now - 3600, latest: true } } }), `window.__send = async () => ({ ok: false, error: "ValueError: TYPE_B: x" })`);
  await run(`$("rp-go").click()`); await wait(400); await type("700"); await run(`$("del-ok").click()`); await wait(800);
  b = await box();
  ok("③ 從策略頁存失敗:框重開、輸入值 700 留著、原因在框底", b.open && (await js(`$("cf-in") && $("cf-in").value`)) === "700" && (await js(`[...document.querySelectorAll("#del-body .cf-block")].length`)) === 1, J(b));
  await run(`$("del-cancel").click()`); await wait(100);

  // ── 存 A 後 B 的草稿與勾選還在
  h = await st("btc", rep({ venue: "binance", amounts: { eth: 300 }, pv: { btc: { symbol: "BTCUSDT", position: 1, close: 50000, bar_at: now - 3600, latest: true } } }), `TR_BAGS.local.edits = { eth: 900 }; TR_BAGS.local.picked = new Set(["eth", "txf"])`);
  await run(`window.__send = async (cmd, args) => { if (cmd === "amounts") window.__st.report.config.amounts = Object.assign({}, args.amounts); return { ok: true }; }`);
  await run(`$("rp-go").click()`); await wait(400); await type("500"); await run(`$("del-ok").click()`); await wait(800);
  const kept = await js(`({ e: TR_BAGS.local.edits, p: TR_BAGS.local.picked && [...TR_BAGS.local.picked], sent: window.__calls.filter((c) => c[0] === "tradeSend" && c[1][0] === "amounts").map((c) => c[1][1].amounts) })`);
  ok("③ 存 A(btc)後:B(eth)的金額草稿 900 與 picker 勾選(txf)都還在;送出的是已存的 eth 300 + btc 500", kept.e.eth === 900 && kept.p && kept.p.includes("txf") && J(kept.sent) === J([{ eth: 300, btc: 500 }]), J(kept));
  ok("③ 真錢有帳戶、沒在跑:存完不自動開啟動框(停在〔啟動下單〕)、也不開連接框", J(await js("window.__spy")) === "[]" && !(await head()).cx);

  // ── 有帳戶永不開連接框;連接中另一支存金額不開連接框
  await reset(); await setRep(rep({ venue: "paper", amounts: { btc: 1 } })); await sel("btc");
  await run(`spCxOpen(TR_BAGS.local, $("rp-go"), "btc")`); await wait(100);
  ok("③ 有帳戶時 spCxOpen 不開連接框", !(await head()).cx);
  h = await st("eth", rep({ pv: { eth: { symbol: "ETHUSDT", position: 1, close: 3000, bar_at: now - 3600, latest: true } } }), `TR_BAGS.local.spCx = { name: "btc", at: Date.now() }`);
  await run(`window.__send = async (cmd, args) => { if (cmd === "amounts") window.__st.report.config.amounts = Object.assign({}, args.amounts); return { ok: true }; }`);
  await run(`$("rp-go").click()`); await wait(400); await type("300"); await run(`$("del-ok").click()`); await wait(800);
  ok("③ 連接中時另一支(eth)存金額:不再開連接框", !(await head()).cx && (await js(`window.__calls.some((c) => c[0] === "tradeSend" && c[1][0] === "amounts")`)), J(await head()));

  // ── 關框／capHandoff 清旗標
  h = await st("btc", rep({ amounts: { btc: 1 } }));
  await run(`$("rp-go").click()`); await wait(200); await run(`cxDismiss()`); await wait(100);
  ok("③ 連接框沒接就關(cxDismiss):不進連接中,回「還沒連接帳戶」", (await js("TR_BAGS.local.spCx")) === null && (await head()).st === "noAcct");
  await run(`TR_BAGS.local.spCx = { name: "btc", at: Date.now() }; cxModalOpen(null)`); await wait(150);
  const opened = (await head()).cx; await run(`cxDismiss()`); await wait(100);
  ok("③ 連接中時別處開的連接框沒接就關(cxModalClose(false)):連同旗標一起收掉", opened && (await js("TR_BAGS.local.spCx")) === null);
  await run(`$("rp-go").click()`); await wait(200); await run(`cxModalClose("handoff")`); await wait(100);
  ok("③ capHandoff 那種關法(交給 agent、什麼都沒綁):不進連接中", (await js("TR_BAGS.local.spCx")) === null && (await head()).st === "noAcct");

  // ── 台股:不出連接框;綁模擬在跑存台股是儲存並下單型
  h = await st("tw", rep({ pv: { tw: { symbol: "2330", position: 1, close: 1000, bar_at: now - 86400, bar_date: "2026-10-30", latest: true, daily_tw: true, market: "spot" } } }));
  await run(`$("rp-go").click()`); await wait(400); b = await box();
  ok("③ 台股金額框:沒有框腳「到策略組合」;記 po_add(不是 sp_auto_open)", b.open && b.link === null && (await js("window.__feats")).includes("po_add") && !(await js("window.__feats")).includes("sp_auto_open"), J(b));
  await type("500"); b = await box();
  ok("③ …500 TWD 換算不到 1 股:主鈕停用", b.dis === true, J(b));
  await type("200000"); await run(`window.__send = async (cmd, args) => { if (cmd === "amounts") window.__st.report.config.amounts = Object.assign({}, args.amounts); return { ok: true }; }`);
  await run(`$("del-ok").click()`); await wait(800);
  ok("③ 台股沒帳戶存成功:到策略組合(不出連接框);記 po_add_saved", !(await head()).cx && (await js(`TR.view === "po" && TR.open`)) && (await js("window.__feats")).includes("po_add_saved"));
  h = await st("tw", rep({ venue: "paper", amounts: { btc: 500 }, running: true, pv: { tw: { symbol: "2330", position: 1, close: 1000, bar_at: now - 86400, bar_date: "2026-10-30", latest: true, daily_tw: true, market: "spot" } } }));
  await run(`$("rp-go").click()`); await wait(400); await type("200000"); await wait(150); b = await box();
  ok("③ 綁模擬、引擎在跑、存台股:儲存並下單型＋模擬記號＋列股", b.title === tx["tr.cf.titleFire"] && b.mark === tx["tr.mode.paper"] && b.body.includes(await T("tr.cf.unitShares")), J(b));
  await run(`$("del-cancel").click()`); await wait(100);

  // ── 統一開通中沒配:存了落自動下單頁
  h = await st("txf", rep({ venue: "president", amounts: {}, extra: { president_connect: { stage: "probe" } }, pv: { txf: { symbol: "TMF", position: 1, close: 23000, bar_at: now - 300, latest: true } } }));
  ok("③ 統一開通中、沒配:〔自動下單〕", (await js(`trExecState(TR_BAGS.local.st)`)) === "setup" && h.st === "add" && h.go === tx["sp.btn"], J(h));
  await run(`window.__send = async (cmd, args) => { if (cmd === "amounts") window.__st.report.config.amounts = Object.assign({}, args.amounts); return { ok: true }; }`);
  await run(`$("rp-go").click()`); await wait(400); await type("2"); await run(`$("del-ok").click()`); await wait(800);
  ok("③ …存了落自動下單頁(那裡的主鈕是「繼續」),不開連接框、不開啟動框", (await js(`TR.open && TR.view === "tr" && !$("tr").hidden`)) && !(await head()).cx && J(await js("window.__spy")) === "[]",
    J({ open: await js("TR.open"), view: await js("TR.view") }));

  // ── 雲端視角(RPC + 雲端那一袋):抽三態
  const cloudSt = (amounts, venue, extra) => J({ alive: true, cloud: { kind: "running", last_ok_at: Date.now(), reported_at: now, server_time: now, fetched_at: Date.now(), epoch: 1,
    strategies_ok: true, strategies_summary: [{ name: "btc", displayName: "BTC", hasBacktest: true, symbol: "BTCUSDT", srcMarket: "crypto", mtime: 1 }] }, report: rep({ amounts, venue }), ...(extra || {}) });
  await reset();
  await run(`TR_BAGS.cloud.st = ${cloudSt({ btc: 500 }, null)}; TR_BAGS.cloud.api = Object.assign({}, TR_BAGS.cloud.api || {}, { tradeStatus: async () => TR_BAGS.cloud.st, listStrategies: async () => [{ name: "btc", displayName: "BTC", hasBacktest: true, symbol: "BTCUSDT", srcMarket: "crypto", mtime: 1, remote: true }] });
    await_ = 0`);
  const cview = async () => js(`(() => { ENV.cur = "cloud"; const C = TR_BAGS.cloud; C.list = [{ name: "btc", displayName: "BTC", hasBacktest: true, symbol: "BTCUSDT", srcMarket: "crypto", universe: [] }]; C.listLoaded = true;
    RPC.name = "btc"; RPC.data = { name: "btc", stats: { symbol: "BTCUSDT" }, code: "x" }; const v = spView(true); ENV.cur = "local"; return v; })()`);
  let cv = await cview();
  ok("③ 雲端視角、已配、沒接帳戶:「還沒連接帳戶」+〔連接帳戶〕", cv && cv.st === "noAcct" && cv.btn.key === "sp.cx", J(cv));
  await run(`TR_BAGS.cloud.st = ${cloudSt({ btc: 500 }, "binance")}; TR_BAGS.cloud.save = "sent"`);
  cv = await cview();
  ok("③ 雲端視角、存完等回報(save === sent):讀不到、真 disabled", cv && cv.st === "unread" && cv.btn.off === true, J(cv));
  await run(`TR_BAGS.cloud.save = null; TR_BAGS.cloud.st.alive = false; TR_BAGS.cloud.st.cloud.last_ok_at = 0`);
  cv = await cview();
  ok("③ 雲端視角、主機狀態讀不到:讀不到", cv && cv.st === "unread", J(cv));
  await run(`TR_BAGS.cloud.st = null; TR_BAGS.cloud.save = null; RPC.name = null; RPC.data = null`);

  // ── 版面:中線對齊(附錄 A.3-2/3)與雲朵 tooltip
  h = await st("btc", rep({ amounts: { btc: 1 } }));
  const geo = await js(`(() => { const c = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; }; const n = $("rp-name"), g = $("rp-go"), s = document.querySelector("#rp-act .rp-status"), i = $("rp-ho");
    const txt = (el) => { const rg = document.createRange(); rg.selectNodeContents(el); const r = rg.getBoundingClientRect(); return r.top + r.height / 2; };   // 字本身的中線(容器被拉高時字會貼頂)
    return { name: txt(n), go: c(g), word: s ? txt(s) : null, ic: i ? c(i) : null, icW: i ? i.getBoundingClientRect().width : null, icH: i ? i.getBoundingClientRect().height : null, aria: i && i.getAttribute("aria-label"),
      tip: (document.getElementById("rp-ho-tip") || {}).textContent, tipVis: getComputedStyle(document.getElementById("rp-ho-tip")).visibility }; })()`);
  ok("③ 版面:策略名、主鈕、狀態詞、雲朵 icon 鈕同一條中線(差 ≤ 1px)", Math.abs(geo.name - geo.go) <= 1 && Math.abs(geo.word - geo.go) <= 1 && Math.abs(geo.ic - geo.go) <= 1, J(geo));
  ok("③ 雲朵 icon 鈕 32×32、aria-label 與 tooltip 同字「送上雲端」、靜止時 tooltip 藏著", geo.icW === 32 && geo.icH === 32 && geo.aria === tx["ho.up.btn"] && geo.tip === tx["ho.up.btn"] && geo.tipVis === "hidden", J(geo));
  await run(`const o = $("rp-ho"); o.dataset.dir = "down"; o.className = "btn-out has-ic"; o.title = "拉回這台電腦:btc"; o.removeAttribute("aria-describedby"); hoPaint()`);
  const ho2 = await js(`(() => { const b = $("rp-ho"), d = b.getAttribute("aria-describedby"); return { d, has: !!(d && document.getElementById(d)), tip: !!document.querySelector("#rp-act .rp-icw .tip"), cls: b.className, title: b.title, dir: b.dataset.dir }; })()`);
  ok("③ 換回這台電腦(上一顆是雲端的「拉回」文字鈕):重建成 icon 鈕,aria-describedby 指得到 tooltip、沒有殘留的 title", ho2.has && ho2.tip && ho2.cls === "rp-ic" && ho2.title === "" && ho2.dir === "up", J(ho2));
  await run(`$("rp-ho").click()`); await wait(100);
  ok("③ 按雲朵 icon 鈕:記 sp_cloud_icon", (await js("window.__feats")).includes("sp_cloud_icon"));
  await run(`if (!$("del-scrim").hidden) delClose(false)`);

  const cmds = await js(`window.__allCmds || []`);
  ok("③ 整支測試沒有送出任何啟動指令(resume／resume_wait／restart_reconciler)", !cmds.some((c) => /^resume|restart_reconciler/.test(c)), J(cmds));
  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
}
