// shell/main.js 的 p1Pick:本機 P1 通知要發哪幾則、水位線推到哪。
// 從 main.js 把原文切出來跑(純函式,不依賴 electron)。跑法:node tests/check_shell_p1_notify.js
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
const a = src.indexOf("const P1_TYPES"), b = src.indexOf("function p1Sync()");
if (a < 0 || b < 0) { console.log("FAIL  找不到 p1Pick 的原文"); process.exit(1); }
const path_ = path, app = { getPath: () => "/nonexistent" };   // 切出來的那段有 notifiedPath / p1Load 用到
eval(src.slice(a, b).replace(/^const /gm, "var ").replace(/^let /gm, "var "));
let red = 0;
const t = (name, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) red++; };
const NOW = 1_800_000_000, ev = (id, type, payload, ago = 10) => ({ id, ts: NOW - ago, type, payload });
const types = (o) => o.show.map((e) => e.type + ":" + e.id).join(",");

let o = p1Pick([ev(5, "order_error", { symbol: "BTCUSDT" }), ev(9, "halt", { source: "reconciler" })], null, NOW);
t("第一次跑(沒水位線):只記不發,水位線=最大 id", o.show.length === 0 && o.mark === 9);
t("沒水位線、也沒事件:水位線落 0(下次的新事件才會發)", p1Pick([], null, NOW).mark === 0);
o = p1Pick([ev(5, "order_error"), ev(9, "halt", { source: "reconciler" }), ev(12, "execution_stuck", { symbol: "ETHUSDT" })], 9, NOW);
t("只發水位線以上的", types(o) === "execution_stuck:12" && o.mark === 12);
o = p1Pick([ev(20, "halt", { source: "portfolio" }), ev(21, "order_error", { symbol: "BTCUSDT" })], 12, NOW);
t("halt / order_error 不從 events 來(lib/events.py 禁寫;走狀態檔現況),水位線照推", o.show.length === 0 && o.mark === 21);
o = p1Pick([ev(30, "exchange_unreachable"), ev(31, "strategy_failed"), ev(32, "bar_stale")], 22, NOW);
t("P2 不發,水位線照推", o.show.length === 0 && o.mark === 32);
o = p1Pick([ev(33, "exchange_unreachable", { venue: "capital", minutes: 30 }), ev(34, "exchange_unreachable", { venue: "capital", minutes: 150 }),
  ev(35, "exchange_unreachable", { venue: "okx", minutes: 600 })], 32, NOW);
t("群益讀不到 ≥150 分(對帳器第二則起)升 P1 發通知;30 分那則與加密交易所不發", types(o) === "exchange_unreachable:34" && o.mark === 35);
t("群益讀不到的通知:走 _capital 那組字、標題代入小時", /ev_exchange_unreachable_capital: "Capital account unreadable for \{hours\} h"/.test(src)
  && /\|\| p1UnreachLong\(e\);/.test(src) && /const title = p1UnreachLong\(e\) && head \? head\.replace\("\{hours\}", \(\) => String\(Math\.floor\(e\.payload\.minutes \/ 60\)\)\) : head;/.test(src)
  && /notifTitle\(tmLabels\.notifPrefixLocal, title \+/.test(src));
{ // 群益讀不到升 P1 的門檻:main.js(本機通知)、trade.js(事件列顏色)、api level_for 三份同一個數字
  const num = (s, re) => { const m = re.exec(s); return m ? Number(m[1]) : null; };
  const trSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");
  const mainMin = num(src, /^const P1_UNREACH_MIN = (\d+);/m), trMin = num(trSrc, /^const TR_EX_UNREACH_P1_MIN = (\d+);/m);
  t("群益讀不到升 P1 的門檻:main.js 與 trade.js 同一個數字", mainMin != null && mainMin === trMin && P1_UNREACH_MIN === mainMin);
  const apiPy = path.join(process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), "openclaw", "agent_events.py");
  if (!fs.existsSync(apiPy)) console.log("SKIP  api 端群益讀不到門檻比對(需要 monorepo 版面或 BLAVE_API_DIR)");
  else { const apiMin = num(fs.readFileSync(apiPy, "utf8"), /^CAPITAL_UNREADABLE_P1_MIN = (\d+)$/m);
    t("…api agent_events.CAPITAL_UNREADABLE_P1_MIN 也是同一個數字(api 還沒上就紅,出貨順序 api 先)", apiMin != null && apiMin === mainMin && apiMin === trMin); } }
o = p1Pick([ev(40, "machine_restart_stopped", {}, 3600), ev(41, "machine_restart_stopped", {}, 60)], 32, NOW);
t("超過 15 分鐘的舊事件不發", types(o) === "machine_restart_stopped:41" && o.mark === 41);
t("舊型別 downtime_paused 不再發(被 machine_restart_stopped 取代),水位線照推", (() => { const x = p1Pick([ev(45, "downtime_paused", {})], 41, NOW); return x.show.length === 0 && x.mark === 45; })());
t("events 裡的 P1 型別都認得", ["execution_interrupted", "execution_fallback_market", "execution_stuck", "machine_restart_stopped", "venue_login_blocked"]
  .every((ty, i) => p1Pick([ev(100 + i, ty, {})], 50, NOW).show.length === 1));
o = p1Pick([null, 7, { id: "x", type: "halt" }, { id: 60, type: 3 }, ev(61, "execution_stuck", null)], 50, NOW);
t("壞資料不炸、好的照發", types(o) === "execution_stuck:61" && o.mark === 61);
t("events 不是陣列:不動", (() => { const x = p1Pick(undefined, 61, NOW); return x.show.length === 0 && x.mark === 61; })());
// — halt / 拒單:從狀態檔現況推導(形狀照 runtime/portfolio_reporter.build_report:halt = {halted, at, reason, source},
//   order_errors = [{ts, symbol, error}])—
const R = (halt, errs) => ({ halt, order_errors: errs || [], venues: {} });
let s0 = p1FromState(R({ halted: true, at: NOW - 5, source: "reconciler" }, [{ ts: NOW - 3, symbol: "BTCUSDT", error: "x" }]), { halt: null, err: null }, NOW);
t("狀態:第一次跑只記不發", s0.show.length === 0 && s0.halt === NOW - 5 && s0.err === NOW - 3);
t("狀態:第一次跑、什麼都沒有 → 水位線落 0", (() => { const x = p1FromState(R({ halted: false }), { halt: null, err: null }, NOW); return x.halt === 0 && x.err === 0 && !x.show.length; })());
s0 = p1FromState(R({ halted: true, at: NOW - 5, source: "reconciler", reason: "3 strikes" }), { halt: 0, err: 0 }, NOW);
t("狀態:自動 HALT → 發一則,水位線=at", s0.show.map((e) => e.type).join() === "halt" && s0.halt === NOW - 5);
t("狀態:同一個 HALT 下一輪不再發", p1FromState(R({ halted: true, at: NOW - 5, source: "reconciler" }), { halt: NOW - 5, err: 0 }, NOW).show.length === 0);
t("狀態:用戶自己按的暫停不發(但水位線照推)", (() => { const x = p1FromState(R({ halted: true, at: NOW - 5, source: "desktop ui" }), { halt: 0, err: 0 }, NOW); return !x.show.length && x.halt === NOW - 5; })());
t("狀態:沒有 source 的 HALT 不發", p1FromState(R({ halted: true, at: NOW - 5 }), { halt: 0, err: 0 }, NOW).show.length === 0);
t("狀態:解除後再次自動 HALT(at 變大)會再發", p1FromState(R({ halted: true, at: NOW - 1, source: "portfolio" }), { halt: NOW - 500, err: 0 }, NOW).show.length === 1);
s0 = p1FromState(R({ halted: false }, [{ ts: NOW - 100, symbol: "A" }, { ts: NOW - 50, symbol: "ETHUSDT@spot" }, { ts: NOW - 5000, symbol: "OLD" }, null, { ts: "x" }]), { halt: 0, err: NOW - 200 }, NOW);
t("狀態:新的拒單各發一則、帶標的;舊的與壞的不發", s0.show.map((e) => e.payload.symbol).join() === "A,ETHUSDT@spot" && s0.err === NOW - 50);
t("狀態:拒單超過 15 分鐘只推水位線", (() => { const x = p1FromState(R({ halted: false }, [{ ts: NOW - 2000, symbol: "A" }]), { halt: 0, err: 0 }, NOW); return !x.show.length && x.err === NOW - 2000; })());
t("狀態:毫秒時間戳也認得", p1FromState(R({ halted: true, at: (NOW - 5) * 1000, source: "reconciler" }), { halt: 0, err: 0 }, NOW).show.length === 1);
t("狀態:report 缺欄位不炸", (() => { try { p1FromState({}, { halt: 0, err: 0 }, NOW); p1FromState(null, { halt: null, err: null }, NOW); return true; } catch (_) { return false; } })());
// — 真實形狀(稽核 M1'):halt.at = lib/guard.py 的 datetime.now(timezone.utc).isoformat()(帶 +00:00、微秒);
//   拒單 ts = lib/portfolio.py 的 datetime.utcnow().isoformat()(**不帶時區的 UTC**)。整支用 TZ=Asia/Taipei 跑也要過。
const isoAware = (sec) => new Date(sec * 1000).toISOString().replace("Z", "") + "000+00:00";   // 2026-…T03:39:08.940000+00:00
const isoNaive = (sec) => new Date(sec * 1000).toISOString().replace("Z", "") + "123";          // 2026-…T03:39:08.940123
s0 = p1FromState(R({ halted: true, at: isoAware(NOW - 5), source: "reconciler", reason: "x" }, [{ ts: isoNaive(NOW - 3), symbol: "BTCUSDT", exchange: "paper", error: "rejected" }]), { halt: 0, err: 0 }, NOW);
t("真實形狀:ISO 字串的 HALT 與拒單都會發", s0.show.map((e) => e.type).join() === "halt,order_error" && Math.abs(s0.halt - (NOW - 5)) < 0.01 && Math.abs(s0.err - (NOW - 3)) < 0.01);
t("真實形狀:不帶時區的拒單 ts 當 UTC(不是本地時間——台北會差 8 小時而被 15 分鐘門檻吃掉)", Math.abs(p1Sec(isoNaive(NOW)) - NOW) < 0.01 && Math.abs(p1Sec(isoAware(NOW)) - NOW) < 0.01);
t("真實形狀:同一輪再來一次不重發", p1FromState(R({ halted: true, at: isoAware(NOW - 5), source: "reconciler" }, [{ ts: isoNaive(NOW - 3), symbol: "BTCUSDT" }]), { halt: s0.halt, err: s0.err }, NOW).show.length === 0);
t("真實形狀:解除後同秒再 HALT 靠微秒分得開", p1Sec("2026-09-21T03:39:08.940001+00:00") > p1Sec("2026-09-21T03:39:08.940000+00:00"));
t("時間解析:垃圾不炸、回 NaN", [null, undefined, "", "yesterday", {}, []].every((v) => Number.isNaN(p1Sec(v))));
{ const tr = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");
  t("畫面交給主行程的字:重開那一型用定稿標題與 P1 內文(不講時間);舊的 downtime_paused 標籤退場",
    /ev_machine_restart_stopped: t\("tr\.ov\.evRestartStopped"\), ev_machine_restart_stopped_n: t\("tm\.evRestartStoppedNote"\)/.test(tr) && !/ev_downtime_paused/.test(tr + src)); }
t("每個 P1 型別在 tmLabels 都有標題與註解", P1_TYPES.every((ty) => src.includes("ev_" + ty + ":") && src.includes("ev_" + ty + "_n:")));
// — 下單結果不明(canon notifications §3 order_unconfirmed):order_errors[] 帶 kind 的那列分型,帶策略名與 stuck;沒 kind 的照舊是拒單
s0 = p1FromState(R({ halted: false }, [{ ts: NOW - 30, symbol: "BTCUSDT", kind: "order_unconfirmed", strategies: ["btc_trend"] },
  { ts: NOW - 20, symbol: "BTCUSDT", kind: "order_unconfirmed", stuck: true, strategies: ["btc_trend"] },
  { ts: NOW - 10, symbol: "ETHUSDT", strategies: ["a", "b"] }, { ts: NOW - 5, symbol: "SOLUSDT", kind: "halt" }]), { halt: 0, err: 0 }, NOW);
t("狀態:kind=order_unconfirmed 分成自己的型別、帶 stuck;沒 kind 或別的 kind 照舊拒單",
  s0.show.map((e) => e.type + (e.payload.stuck ? "!" : "")).join() === "order_unconfirmed,order_unconfirmed!,order_error,order_error");
t("狀態:策略名帶進 payload", s0.show[0].payload.strategies.join() === "btc_trend" && s0.show[2].payload.strategies.join() === "a,b");
t("order_unconfirmed 是 P1 型別、但不從 events 來", P1_TYPES.includes("order_unconfirmed") && !P1_EVENT_TYPES.includes("order_unconfirmed")
  && p1Pick([ev(70, "order_unconfirmed", {})], 61, NOW).show.length === 0);
var tmLabels = {}; tmLabels.stratOne = "策略 {name}"; tmLabels.stratTwo = "策略 {a}、{b}"; tmLabels.stratMany = "{name} 等 {n} 支策略"; tmLabels.withStrat = "{strat}：{note}";
t("通知內文:一支、兩支、三支以上、沒有策略", p1WithStrat(["a"], "N") === "策略 a：N" && p1WithStrat(["a", "b"], "N") === "策略 a、b：N"
  && p1WithStrat(["a", "b", "c"], "N") === "a 等 3 支策略：N" && p1WithStrat([], "N") === "N" && p1WithStrat(undefined, "N") === "N");
// 0.1.46:策略寫名稱(呼叫端給 label,同一份規則讀不到就是代號);zh 範本包「」
tmLabels.stratOne = "策略「{name}」"; tmLabels.stratTwo = "策略「{a}」、「{b}」"; tmLabels.stratMany = "「{name}」等 {n} 支策略";
const lbl = (c) => ({ a: "台指期 籌碼", b: "b" }[c] || c);
t("通知內文:策略名經 label 換成名稱、zh 包「」;沒 label 照舊代號", p1WithStrat(["a"], "N", lbl) === "策略「台指期 籌碼」：N"
  && p1WithStrat(["a", "b"], "N", lbl) === "策略「台指期 籌碼」、「b」：N" && p1WithStrat(["a"], "N") === "策略「a」：N");
t("系統通知:market_hold 這種只帶單一 strategy 的也帶策略,名稱照 p1StratLabel",
  /body: p1WithStrat\(e\.payload && \(Array\.isArray\(e\.payload\.strategies\) \? e\.payload\.strategies : typeof e\.payload\.strategy === "string" \? \[e\.payload\.strategy\] : null\), note, p1StratLabel\)/.test(src));
t("stuck 那則有自己的標題與內文", src.includes("ev_order_unconfirmed_stuck:") && src.includes("ev_order_unconfirmed_stuck_n:"));
{ const x = p1FromState(R({ halted: true, at: NOW - 5, source: "reconciler", reason: "[order_unconfirmed_unparked] BTCUSDT: unknown" }), { halt: 0, err: 0 }, NOW);
  t("追蹤不了而整台暫停:halt 那則帶 unconfirmed,內文用專屬那句(有英文退路)", x.show.length === 1 && x.show[0].payload.unconfirmed === true
    && p1FromState(R({ halted: true, at: NOW - 5, source: "reconciler", reason: "3 strikes" }), { halt: 0, err: 0 }, NOW).show[0].payload.unconfirmed === false
    && src.includes("ev_halt_unconfirmed_n:")); }
{ const x = p1FromState(R({ halted: true, at: NOW - 5, source: "reconciler", reason: "[order_unconfirmed_unparked] BTCUSDT: unknown" }), { halt: 0, err: 0 }, NOW);
  t("追蹤不了而整台暫停:payload 帶標的(標題接「· BTCUSDT」)", x.show[0].payload.symbol === "BTCUSDT"); }
{ const x = p1FromState(R({ halted: false }, [{ ts: NOW - 9, symbol: "BTCUSDT", kind: "order_unconfirmed", manual: true, park_id: "manual:B:1" },
  { ts: NOW - 8, symbol: "ETHUSDT", kind: "order_unconfirmed", stuck: true, close_all: true, inflight_id: "ETHUSDT_market" }]), { halt: 0, err: 0 }, NOW);
  t("manual 停車第一列不叫(HALT 已叫);全部平倉沒平到那列帶 close_all", x.show.length === 1 && x.show[0].payload.close_all === true
    && src.includes("ev_order_unconfirmed_close_all:") && src.includes("ev_order_unconfirmed_close_all_n:")); }
// 全部平倉刻意沒送單那列(manager/flatten manual_close_required):不再當「下單失敗」叫;同 api 的分流與 reason
{ const MC = (extra) => Object.assign({ ts: NOW - 5, symbol: "TMF", kind: "manual_close_required", exchange: "capital", symbols: "TMF" }, extra);
  const pick = (row) => p1FromState(R({ halted: false }, [row]), { halt: 0, err: 0 }, NOW).show[0];
  const q = pick(MC({ reason: "queued", until: 1793899200 })), id = pick(MC({})), lag = pick(MC({ reason: "snapshot_lag", exchange: "president" }));
  t("manual_close_required:群益 queued／identity(或沒帶)、統一 snapshot_lag 都叫自己的型別,payload 帶 reason 與 until",
    q.type === "manual_close_required" && q.payload.reason === "queued" && q.payload.until === 1793899200
    && id.type === "manual_close_required" && id.payload.reason === "identity" && lag.payload.reason === "snapshot_lag");
  t("manual_close_required:認不得的組合照舊當拒單(統一沒有身分問題、新 reason)",
    pick(MC({ exchange: "president", reason: "identity" })).type === "order_error" && pick(MC({ reason: "new_one" })).type === "order_error");
  t("本機通知的標題與內文按 reason 換,queued 講幾點後再按(台灣時間)",
    /mcr === "snapshot_lag" \? "_lag" : mcr === "queued" \? "_queued"/.test(src) && /replace\("\{at\}", p1TwClock\(e\.payload\.until\)\)/.test(src)
    && p1TwClock(1793899200) === "01:20" && /ev_manual_close_required_queued_n: "[^"]*\{at\}/.test(src)
    && !/Order failed|rejected/.test((src.match(/ev_manual_close_required[^\n]*/g) || []).join(" "))); }
{ const tr = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");
  t("畫面交給主行程的字:manual_close_required 三種標題與內文都有",
    ["ev_manual_close_required:", "ev_manual_close_required_n:", "ev_manual_close_required_lag:", "ev_manual_close_required_lag_n:",
     "ev_manual_close_required_queued:", "ev_manual_close_required_queued_n:", "ev_manual_close_required_queued_soon_n:"].every((k) => tr.includes(k) && src.includes(k))); }
// — HALT 已在(用戶按的)時停放單帳戶讀 3 次對不上:HALT 檔的 unexplained 出現新 park_id → 一則 halt,每個 park_id 一次 —
{ const U = (id, ago = 20, extra = {}) => ({ park_id: id, venue: "capital", symbol: "TMF", at: NOW - ago, reason: "群益 TMF 賣 2 口沒回報成交，帳戶讀了 3 次都對不上。", ...extra });
  const userHalt = (unx) => R({ halted: true, at: NOW - 600, source: "web", reason: "用戶按了全部平倉", ...(unx ? { unexplained: unx } : {}) });
  const base = { halt: NOW - 600, err: 0, unx: [] };
  let x = p1FromState(userHalt([U("capital:TMF@1")]), base, NOW);
  t("unexplained:用戶的 HALT 底下出現新的 park_id → 一則 halt,帶原因句與標的,記住這個 id",
    x.show.length === 1 && x.show[0].type === "halt" && x.show[0].payload.unexplained === true && x.show[0].payload.symbol === "TMF"
    && /對不上/.test(x.show[0].payload.reason) && x.unx.join() === "capital:TMF@1" && x.halt === NOW - 600);
  const again = p1FromState(userHalt([U("capital:TMF@1")]), { ...base, unx: x.unx }, NOW);
  t("unexplained:同一個 park_id 下一輪不重發", again.show.length === 0 && again.unx.join() === "capital:TMF@1");
  x = p1FromState(userHalt([U("capital:TMF@1"), U("president:TMFK6@2", 10)]), { ...base, unx: ["capital:TMF@1"] }, NOW);
  t("unexplained:只發新的那個 park_id", x.show.length === 1 && /president/.test(x.unx.join()) && x.unx.length === 2);
  const plain = p1FromState(userHalt(null), base, NOW), plainOld = p1FromState(userHalt(null), { halt: NOW - 600, err: 0 }, NOW);
  t("unexplained:沒有這個欄位 → 行為照舊(用戶的 HALT 不發、水位線不動;舊的 p1-notified 沒有 unx 也一樣)",
    plain.show.length === 0 && plain.halt === NOW - 600 && plain.unx.length === 0 && plainOld.show.length === 0);
  const auto = p1FromState(R({ halted: true, at: NOW - 5, source: "reconciler", reason: "3 strikes" }), { halt: 0, err: 0, unx: [] }, NOW);
  t("unexplained:自動 HALT 照舊一則,unx 不影響", auto.show.length === 1 && !auto.show[0].payload.unexplained);
  const first = p1FromState(userHalt([U("capital:TMF@1")]), { halt: null, err: null, unx: null }, NOW);
  t("unexplained:第一次跑(沒有 unx 紀錄)只記不發", first.show.length === 0 && first.unx.join() === "capital:TMF@1");
  t("unexplained:升級前的 p1-notified(有 halt 水位線、沒有 unx)照樣發新的",
    p1FromState(userHalt([U("capital:TMF@9")]), { halt: NOW - 600, err: 0 }, NOW).show.length === 1);
  t("unexplained:超過 15 分鐘的只記不發", p1FromState(userHalt([U("old", 2000)]), base, NOW).show.length === 0);
  t("unexplained:沒有 HALT(halted false)時不看", p1FromState(R({ halted: false, unexplained: [U("z")] }), base, NOW).show.length === 0);
  t("unexplained:壞資料不炸、不記", (() => { const y = p1FromState(userHalt([null, "x", { park_id: "" }, { park_id: 3 }]), base, NOW); return y.show.length === 0 && y.unx.length === 0; })());
  t("unexplained:記住的 id 有上限", p1FromState(userHalt([U("n")]), { ...base, unx: Array.from({ length: 25 }, (_, i) => "p" + i) }, NOW).unx.length === P1_UNX_KEEP);
  t("unexplained:p1-notified.json 存讀 unx", /unx: p1Ids\(j\.unx\)/.test(src) && /unx: stt\.unx/.test(src) && p1Ids(["a", 3, ""]).join() === "a" && p1Ids(undefined) === null);
  t("unexplained:通知標題是帳戶對不上(ev_halt_unexplained),內文是機器的原因句;不借主機重開那句;節流跟自動 HALT 分開",
    /const head = \(unexplained && tmLabels\.ev_halt_unexplained\) \|\|/.test(src) && /const note = unexplained \? e\.payload\.reason/.test(src)
    && !/ev_machine_restart_stopped_n \? " "/.test(src) && /":unexplained"/.test(src)
    && /ev_halt_unexplained: t\("tr\.ov\.evHaltUnexplained"\)/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8"))); }
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
