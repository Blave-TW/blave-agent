// 自動下單沒連帳戶、這台電腦清單是空的(spec first-strategy-sidebar §B1、§B3、§B6):trade.js trOnbPick 判畫哪一張、3 秒退回、不來回換,
// trPaintOnboard 只在現行畫 poFog("connect") 的那個分支換卡,清單還沒到畫一行等待字不上霧。真的函式配假計時器,不開 Electron。
// 跑法:node tests/check_shell_onb_new.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");
let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || d === undefined ? "" : "  " + JSON.stringify(d))); if (!ok) red++; };
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };

function mk() {
  const clock = { now: 1000, timers: [] }, paints = [];
  const ctx = { TR: { env: "local", open: true, listLoaded: false, list: [] }, stopped: false, trReport: () => ({}), trNoAccountStopped: () => ctx.stopped, trPaint: () => paints.push(clock.now),
    Date: { now: () => clock.now }, setTimeout: (f, ms) => { const h = { f, at: clock.now + ms }; clock.timers.push(h); return h; }, clearTimeout: (h) => { clock.timers = clock.timers.filter((x) => x !== h); } };
  vm.createContext(ctx);
  vm.runInContext(src.match(/^const TR_ONB_WAIT_MS = [^\n]*\n/m)[0] + src.match(/^const TR_ONB = [^\n]*\n/m)[0] + cutFn(src, "trOnbReset") + "\n" + cutFn(src, "trOnbPick") + "\nthis.pick = trOnbPick; this.reset = trOnbReset;", ctx);
  const tick = (ms) => { clock.now += ms; const due = clock.timers.filter((h) => h.at <= clock.now); clock.timers = clock.timers.filter((h) => h.at > clock.now); due.forEach((h) => h.f()); };
  return { ctx, clock, paints, tick };
}
{ const { ctx } = mk(); ctx.TR.listLoaded = true; ctx.TR.list = [];
  t("§B3 這台電腦、沒連帳戶、清單載入且是空的 → new", ctx.pick("noaccount", null) === "new");
  const b = mk(); b.ctx.TR.listLoaded = true; b.ctx.TR.list = [{ name: "alert", hasBacktest: false }];
  t("§B1 清單不是空的(含只有不回測的策略)→ connect", b.ctx.pick("noaccount", null) === "connect"); }
{ const { ctx } = mk(); ctx.TR.listLoaded = true;
  const r = [ctx.pick("noaccount", { venue: "x" }), (ctx.stopped = true, ctx.pick("noaccount", null)), (ctx.stopped = false, ctx.TR.env = "cloud", ctx.pick("noaccount", null)), (ctx.TR.env = "local", ctx.pick("loading", null))];
  t("§B3 只在現行畫 connect 的那個分支判:有等回報的金鑰、重開後停著沒帳戶、雲端視角、不是 noaccount → null(照現行)", r.every((x) => x === null), r); }
{ const { ctx, paints, tick, clock } = mk();
  t("§B3 清單還沒到 → wait(畫等待字、不上霧),排一次 3 秒的重畫", ctx.pick("noaccount", null) === "wait" && clock.timers.length === 1 && clock.timers[0].at === 1000 + 3000);
  tick(1000); t("§B3 等待中再畫不重排計時", ctx.pick("noaccount", null) === "wait" && clock.timers.length === 1);
  tick(2000); t("§B3 到點當下自己叫一次重畫(不等下一輪輪詢)", paints.length === 1 && paints[0] === 4000);
  t("§B3 3 秒沒到 → connect", ctx.pick("noaccount", null) === "connect");
  ctx.TR.listLoaded = true; ctx.TR.list = [];
  t("§B3 之後清單才到、是空的也不換(不會先〔連接帳戶〕再跳〔新增策略〕)", ctx.pick("noaccount", null) === "connect");
  ctx.reset(); t("§B3 下一次進這一頁(trOnbReset)才重判", ctx.pick("noaccount", null) === "new"); }
{ const { ctx } = mk(); ctx.TR.listLoaded = true; ctx.TR.list = [];
  const a = ctx.pick("noaccount", null); ctx.TR.list = [{ name: "s1", hasBacktest: false }]; const b = ctx.pick("noaccount", null); ctx.TR.list = []; const c = ctx.pick("noaccount", null);
  t("§B6 清單載入後照現況:new → 做了一支(任何一種)當下回 connect;清單又空了回 new(不必離開再進來)", [a, b, c].join() === "new,connect,new", [a, b, c]); }
{ const { ctx, clock } = mk();
  ctx.pick("noaccount", null); ctx.TR.listLoaded = true; ctx.TR.list = [];
  t("§B3 3 秒內清單到了 → new,計時照樣在(到點只重畫、不改判)", ctx.pick("noaccount", null) === "new");
  ctx.pick("loading", null); t("§B3 state 變了就重判並清計時", clock.timers.length === 0); }
{ const { ctx, paints, tick } = mk();
  ctx.pick("noaccount", null); ctx.TR.open = false; tick(3000);
  t("§B3 到點時已不在這一頁:不重畫", paints.length === 0); }
const onb = cutFn(src, "trPaintOnboard"), op = cutFn(src, "trOpen"), lv = cutFn(src, "trLeave");
t("§B3 trPaintOnboard:判斷結果進指紋;只換 poFog(\"connect\") 那個分支,wait 畫 trLoadingText 一行、不上霧", /const onb = trOnbPick\(state, saved\);/.test(onb) && /trNoAccountStopped\(trReport\(\)\), onb\]\)\) return;/.test(onb)
  && /if \(!saved && !trNoAccountStopped\(trReport\(\)\)\) \{\n\s*if \(onb === "wait"\) box\.appendChild\(trEl\("div", "pf-state", trLoadingText\(\)\)\);[^\n]*\n\s*else box\.appendChild\(poFog\(onb === "new" \? "onb-new" : "connect"\)\);/.test(onb)
  && (onb.match(/poFog\(/g) || []).length === 1);
t("§B3 進這一頁(trOpen)與離開(trLeave)都 trOnbReset,計時不殘留", /if \(S\.env === "local" && typeof trOnbReset === "function"\) trOnbReset\(\);/.test(op) && /if \(e === "local" && typeof trOnbReset === "function"\) trOnbReset\(\);/.test(lv));
t("§B3 3 秒是具名常數", /^const TR_ONB_WAIT_MS = 3000;$/m.test(src) && !/3000/.test(cutFn(src, "trOnbPick")));
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
