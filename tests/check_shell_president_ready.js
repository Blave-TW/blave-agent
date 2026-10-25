// 統一本機開通:開通框第一次看到下單程式起來(worker ok)→ 主畫面的輪詢改快(爆發窗),
// 接住 daemon 隨後那一次帳戶重讀(runtime president_connect._ready → account_kick;tests/check_president_local_ready.py)。
//   同 tests/check_shell_capital_local_ready.js:presAdvance 從原文切出來跑,presBurst / trBurstBump / trBurstOn / 常數都用原文那一份;
//   只換 trPollSoon 與步驟送出。trPoll 用爆發窗排 TR_POLL_PENDING 那條在群益那支測。
// 跑法:node tests/check_shell_president_ready.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const pres = fs.readFileSync(path.join(R, "president.js"), "utf8"), trade = fs.readFileSync(path.join(R, "trade.js"), "utf8");
let red = 0; const ok = (n, c, got) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) { red++; if (got !== undefined) console.log("      got: " + JSON.stringify(got)); } };
const cut = (src, from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a + 1); if (a < 0 || b < 0) throw new Error("找不到 " + from); return src.slice(a, b); };
const line = (src, re) => { const m = src.match(re); if (!m) throw new Error("找不到 " + re); return m[0]; };

const code = [
  line(trade, /^const TR_POLL_OPEN = .*$/m), line(trade, /^const TR_BURST_MS = .*$/m),
  cut(trade, "function trBurstBump(", "\n}\n") + "\n}", line(trade, /^function trBurstOn\(.*$/m),
  cut(pres, "const presBlank = ", "let PRES = presBlank();"), "let PRES = presBlank();",
  line(pres, /^const presSec = .*$/m), line(pres, /^function presBurst\(\).*$/m), cut(pres, "function presAdvance(", "\n}\n") + "\n}",
  `const ENV = { burst: null }; const soon = [], steps = [];
   function trPollSoon(ms) { soon.push(ms); }
   function presStep(n) { steps.push(n); }
   function presTrack() {} function presDown() { return false; }
   this.run = (pc, phase) => { PRES.phase = phase || "flow"; presAdvance("d-done", pc); };
   this.reset = () => { PRES = presBlank(); ENV.burst = null; soon.length = 0; steps.length = 0; };
   this.st = () => ({ on: trBurstOn(ENV.burst, Date.now()), soon: soon.slice(), steps: steps.slice() });`,
].join("\n");
const ctx = {}; vm.createContext(ctx); vm.runInContext(code, ctx);

const PC = (w, extra) => Object.assign({ updated_at: 1, setup: { status: "ok" }, probe: { status: "ok", state: "ok", env: "live" }, worker: w }, extra || {});
// 開框時還在跑 → 下一輪變 ok(這次開框看著它完成)
ctx.reset(); ctx.run(PC({ status: "running" }));
ok("worker 還在跑:不開爆發窗", !ctx.st().on && ctx.st().soon.length === 0, ctx.st());
ctx.run(PC({ status: "ok" }));
ok("worker 變 ok:開爆發窗、1.5 秒內再輪一次", ctx.st().on && JSON.stringify(ctx.st().soon) === "[1500]", ctx.st());
ctx.run(PC({ status: "ok" })); ctx.run(PC({ status: "ok" }));
ok("之後每一輪不再重開(只在完成那一刻一次)", ctx.st().soon.length === 1, ctx.st());
ok("不多送任何步驟(不多登入統一)", ctx.st().steps.length === 0, ctx.st());
// 變 ok 那一輪剛好碰上推進的早退(busy / 步驟回報還沒動)也要開
ctx.reset(); ctx.run(PC({ status: "running" }));
ctx.run(PC({ status: "ok" }, { busy: "president_local:start" }));
ok("變 ok 那一輪 pc.busy 還在:照樣開爆發窗", ctx.st().on && ctx.st().soon.length === 1, ctx.st());
// 開框時就已經 ok(早就開通過,只是打開來看)
ctx.reset(); ctx.run(PC({ status: "ok", ok_at: 1 }));
ok("開框時早就 ok:不開爆發窗", !ctx.st().on && ctx.st().soon.length === 0, ctx.st());
ctx.reset(); ctx.run(PC({ status: "ok", ok_at: 1 }), "prep");
ok("開框時早就 ok、還在準備頁:也不開", !ctx.st().on && ctx.st().soon.length === 0, ctx.st());

console.log(red ? `${red} FAIL` : "all pass");
process.exit(red ? 1 : 0);
