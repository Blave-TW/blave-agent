// 雲端視角開著的那支:回合結束那次重抓拿到舊的之後,由清單輪詢(trPoll → rpCloudWatch)看到內容指紋變了再補抓。
//   真的跑 app.js 的 rpCloudSelect / rpCloudWatch / rpCloudRefetch 與 onTurnEnd 那兩行,外加接線(trade.js 的 sig 映射與呼叫點)。
// 跑法:node tests/check_shell_cloud_refetch.js
const path = require("path"), fs = require("fs"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const app = fs.readFileSync(path.join(R, "app.js"), "utf8"), trade = fs.readFileSync(path.join(R, "trade.js"), "utf8");
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };
const cut = (src, name) => {   // 從 "function name(" 起數大括號切到收尾
  const i = src.search(new RegExp("^(async )?function " + name + "\\(", "m"));
  if (i < 0) throw new Error("missing " + name);
  let d = 0, j = src.indexOf("{", i);
  for (; j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}" && --d === 0) break; }
  return src.slice(i, j + 1);
};
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  const ctx = { console, Promise, JSON, setTimeout, Map, Date, loads: [], next: [], paints: 0 };
  ctx.ENV = { cur: "cloud", sig: {} };
  ctx.RPC = { name: null, data: null, tab: "bt", drawn: {} };
  ctx.TR_BAGS = { cloud: { st: { cloud: { strategies: [{ name: "A", sig: "s1", updated_at: 1 }] } }, alertSrc: null,
    api: { loadStrategy: (n) => { ctx.loads.push(n); return Promise.resolve(ctx.next.shift()); } } } };
  vm.createContext(ctx);
  const head = app.slice(app.indexOf("const RPC_CACHE = new Map();"), app.indexOf("async function rpCloudSelect(")).replace(/^const |^let /gm, "var ");
  const turnEnd = app.match(/^ {2}if \(cloudTurn && RPC\.name\) rpCloudSelect\(RPC\.name, true\);\n {2}else if \(rpcOwed && RPC\.name\) rpCloudRefetch\(RPC\.name\);[^\n]*$/m);
  ok("onTurnEnd:碰過雲端 → 照舊立即重抓;沒碰雲端但回合中欠著 → 補抓", !!turnEnd);
  vm.runInContext([head, cut(trade, "envCloudList"), cut(app, "rpCloudSelect"), cut(app, "rpCloudWatch"), cut(app, "rpCloudShownSig"), cut(app, "rpCloudRefetch"),
    "var running = false, rpWaitShownAt = 0; function rpWaitHold() { return 0; } function rpCloudPaint() { paints++; } function trPaint() {}",
    "function rpPending(name, state) { return { name, pending: state }; }",
    "function turnEnd(cloudTurn) {\n" + (turnEnd ? turnEnd[0] : "") + "\n}"].join("\n"), ctx);
  const list = (sig) => { ctx.TR_BAGS.cloud.st.cloud.strategies[0].sig = sig; return vm.runInContext("envCloudList(TR_BAGS.cloud.st)", ctx); };
  const st = (ga, extra) => ({ "Generated At": ga, "Sharpe Ratio": 1, candles: [[1]], trades: [], ...(extra || {}) });
  const D0 = { name: "A", displayName: "A", description: "", code: "x=1", stats: st(100) };
  const D1 = { ...D0, stats: st(200) };
  const D1bar = { ...D0, stats: st(200, { candles: [[1], [2]], "Sharpe Ratio": 1.1 }) };   // live 每根 K:K 線尾與績效動、明確回測時戳不變
  const D2 = { ...D0, stats: st(300) };

  ctx.RPC_CACHE.set("A", D0); ctx.next.push(D0);
  vm.runInContext("rpCloudSelect('A')", ctx); await tick();
  ok("選中:基準記下清單上那一份 sig", ctx.RPC_SEEN.name === "A" && ctx.RPC_SEEN.sig === "s1");
  ctx.paints = 0; ctx.loads.length = 0;

  ctx.next.push(D0); vm.runInContext("turnEnd(true)", ctx); await tick();   // 平台還沒同步到新結果:拿到舊的
  ok("回合結束立即重抓保留(拿到舊資料 → 資料沒換)", ctx.loads.length === 1 && ctx.RPC.data === ctx.RPC_CACHE.get("A") && ctx.RPC.data.stats["Generated At"] === 100);
  ctx.paints = 0; ctx.loads.length = 0;

  vm.runInContext("rpCloudWatch", ctx)(list("s1")); await tick();
  ok("輪詢:sig 沒變 → 不抓", ctx.loads.length === 0 && ctx.paints === 0);

  ctx.next.push(D1); vm.runInContext("rpCloudWatch", ctx)(list("s2")); await tick();
  ok("輪詢:sig 變了 → 重抓、換成新結果、整片重畫一次", ctx.loads.join() === "A" && ctx.RPC.data === D1 && ctx.paints === 1 && Object.keys(ctx.RPC.drawn).length === 0);
  ctx.paints = 0; ctx.loads.length = 0;

  ctx.running = true; vm.runInContext("rpCloudWatch", ctx)(list("s3")); await tick();
  ok("回合中 sig 變了 → 不抓不畫,記欠著", ctx.loads.length === 0 && ctx.paints === 0 && ctx.rpcOwed === true);
  ctx.running = false; ctx.next.push(D2); vm.runInContext("turnEnd(false)", ctx); await tick();
  ok("回合結束(沒碰雲端,例如網頁發起的雲端回合)→ 補抓並重畫、欠著清掉", ctx.loads.join() === "A" && ctx.RPC.data === D2 && ctx.paints === 1 && ctx.rpcOwed === false);
  ctx.paints = 0; ctx.loads.length = 0;

  ctx.RPC.drawn = { bt: true, tr: true }; ctx.RPC.data = D1; ctx.next.push(D1bar);
  vm.runInContext("rpCloudWatch", ctx)(list("s4")); await tick();
  ok("live 每根 K 的變動(明確回測時戳沒變)→ 只換資料、眼前這一頁不重畫,別的分頁切過去再畫", ctx.RPC.data === D1bar && ctx.paints === 0 && JSON.stringify(ctx.RPC.drawn) === '{"bt":true}');
  ctx.loads.length = 0;

  ctx.next.push(D2); ctx.TR_BAGS.cloud.api.loadStrategy = (n) => { ctx.loads.push(n); ctx.running = true; return Promise.resolve(ctx.next.shift()); };
  vm.runInContext("rpCloudWatch", ctx)(list("s5")); await tick();
  ok("抓的期間回合開跑 → 抓回來也不畫,記欠著", ctx.loads.length === 1 && ctx.paints === 0 && ctx.RPC.data === D1bar && ctx.rpcOwed === true);
  ctx.running = false; ctx.loads.length = 0;
  ctx.TR_BAGS.cloud.api.loadStrategy = (n) => { ctx.loads.push(n); return Promise.resolve(ctx.next.shift()); };

  ctx.ENV.cur = "local"; vm.runInContext("rpCloudWatch", ctx)(list("s6")); await tick();
  ok("本機視角 → 不抓、基準不動", ctx.loads.length === 0 && ctx.RPC_SEEN.sig === "s5");
  ctx.ENV.cur = "cloud"; ctx.next.push(D2); vm.runInContext("rpCloudWatch", ctx)(list("s6")); await tick();
  ok("切回雲端那一輪 → 比得出變化、補抓", ctx.loads.length === 1);
  ctx.loads.length = 0;

  ctx.TR_BAGS.cloud.st.cloud.strategies[0].updated_at = null;
  vm.runInContext("rpCloudWatch", ctx)(list(null)); await tick();
  ok("sig 與 updated_at 都沒有(舊快取)→ 不追蹤、不抓", ctx.loads.length === 0);

  ok("接線:envCloudList 帶出 sig;trPoll 每輪讀到雲端清單後叫 rpCloudWatch",
    /sig: typeof x\.sig === "string" && x\.sig \? x\.sig : null/.test(cut(trade, "envCloudList"))
    && /if \(typeof rpCloudWatch === "function"\) rpCloudWatch\(C\.list\);/.test(cut(trade, "trPoll")));

  console.log(red ? `\n${red} 紅` : "\n全綠");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
