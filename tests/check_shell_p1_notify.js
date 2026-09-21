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
o = p1Pick([ev(40, "downtime_paused", {}, 3600), ev(41, "downtime_paused", {}, 60)], 32, NOW);
t("超過 15 分鐘的舊事件不發", types(o) === "downtime_paused:41" && o.mark === 41);
t("events 裡的四個 P1 型別都認得", ["execution_interrupted", "execution_fallback_market", "execution_stuck", "downtime_paused"]
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
t("每個 P1 型別在 tmLabels 都有標題與註解", P1_TYPES.every((ty) => src.includes("ev_" + ty + ":") && src.includes("ev_" + ty + "_n:")));
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
