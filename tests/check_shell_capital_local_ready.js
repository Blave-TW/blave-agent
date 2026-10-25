// 群益本機開通:開通框第一次看到下單程式起來(worker ok)→ 主畫面的輪詢改快(爆發窗,TR_POLL_PENDING),
// 接住 daemon 隨後那一次帳戶重讀(runtime capital_local._ready → account_kick;tests/check_capital_local_ready.py)。
//   caplAdvance 從原文切出來跑,caplBurst / trBurstBump / trBurstOn / 常數都用原文那一份;只換 trPollSoon 與步驟送出。
// 跑法:node tests/check_shell_capital_local_ready.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const capl = fs.readFileSync(path.join(R, "capital_local.js"), "utf8"), trade = fs.readFileSync(path.join(R, "trade.js"), "utf8");
let red = 0; const ok = (n, c, got) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) { red++; if (got !== undefined) console.log("      got: " + JSON.stringify(got)); } };
const cut = (src, from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a + 1); if (a < 0 || b < 0) throw new Error("找不到 " + from); return src.slice(a, b); };
const line = (src, re) => { const m = src.match(re); if (!m) throw new Error("找不到 " + re); return m[0]; };

const code = [
  line(trade, /^const TR_POLL_OPEN = .*$/m), line(trade, /^const TR_BURST_MS = .*$/m),
  cut(trade, "function trBurstBump(", "\n}\n") + "\n}", line(trade, /^function trBurstOn\(.*$/m),
  cut(capl, "const caplBlank = ", "let CAPL = caplBlank();"), "let CAPL = caplBlank();",
  line(capl, /^function caplBurst\(\).*$/m), cut(capl, "function caplAdvance(", "\n}\n") + "\n}",
  `const ENV = { burst: null }; const soon = [], steps = [];
   function trPollSoon(ms) { soon.push(ms); }
   function caplStep(n) { steps.push(n); }
   function caplSec(cc, k) { return (cc && cc[k]) || {}; }
   function caplTrack() {} function caplOldPlan() {} function caplDown() { return false; }
   this.run = (cc) => caplAdvance("l-done", cc);
   this.reset = () => { CAPL = caplBlank(); ENV.burst = null; soon.length = 0; steps.length = 0; };
   this.st = () => ({ on: trBurstOn(ENV.burst, Date.now()), soon: soon.slice(), steps: steps.slice() });`,
].join("\n");
const ctx = {}; vm.createContext(ctx); vm.runInContext(code, ctx);

const CC = (w) => ({ updated_at: 1, setup: { status: "ok" }, probe: { status: "ok", state: "ok" }, worker: w });
// 開框時還在跑 → 下一輪變 ok(這次開框看著它完成)
ctx.reset(); ctx.run(CC({ status: "running" }));
ok("worker 還在跑:不開爆發窗", !ctx.st().on && ctx.st().soon.length === 0, ctx.st());
ctx.run(CC({ status: "ok" }));
ok("worker 變 ok:開爆發窗、1.5 秒內再輪一次", ctx.st().on && JSON.stringify(ctx.st().soon) === "[1500]", ctx.st());
ctx.run(CC({ status: "ok" })); ctx.run(CC({ status: "ok" }));
ok("之後每一輪不再重開(只在完成那一刻一次)", ctx.st().soon.length === 1, ctx.st());
ok("不多送任何步驟(不多登入群益)", ctx.st().steps.length === 0, ctx.st());
// 開框時就已經 ok(早就開通過,只是打開來看)
ctx.reset(); ctx.run(CC({ status: "ok", ok_at: 1 }));
ok("開框時早就 ok:不開爆發窗", !ctx.st().on && ctx.st().soon.length === 0, ctx.st());
// 爆發窗開著時,trPoll 排下一輪用 TR_POLL_PENDING(2.5 秒)
const sched = line(trade, /TRP\.timer = setTimeout\(trPoll, TRP\.again \? 0 : .*$/m);
ok("trPoll:爆發窗開著排 TR_POLL_PENDING", /trBurstOn\(ENV\.burst, Date\.now\(\)\) \? TR_POLL_PENDING/.test(sched), sched);
ok("TR_POLL_PENDING ≤ 2.5 秒、爆發窗 ≥ 30 秒(蓋得過 daemon 帳戶讀取的 2 秒輪詢＋讀取本身)", vm.runInContext("TR_POLL_PENDING <= 2500 && TR_BURST_MS >= 30000", ctx));

console.log(red ? `${red} FAIL` : "all pass");
process.exit(red ? 1 : 0);
