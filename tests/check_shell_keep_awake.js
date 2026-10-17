// 自動下單在跑時不讓電腦閒置睡眠(spec desktop-keep-awake-while-trading K1/K2/K5)。main.js 的 awakeWanted / awakeApply 從原文切出來跑:
//   1. 表列:running／剛按啟動／unconfirmed 持有;halted／dead／沒回報／沒帳戶放掉;Windows 統一有部位且開關關照樣持有;Mac 沒有 B
//   2. K2:同一個答案重複套用不疊第二顆、不多停一次;放掉後再要才開新的一顆
//   3. 接線:5 秒那一輪有叫、啟動指令記時間、結束 app 放掉、main.js 只有 awakeApply 一處開 blocker
// 跑法:node tests/check_shell_keep_awake.js
const fs = require("fs"), path = require("path");
const main = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const fn = (src, name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0; for (let k = src.indexOf("{", src.indexOf(")", i)); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("切不出 " + name); };
const line = (re) => { const m = main.match(re); if (!m) throw new Error("找不到 " + re); return m[0]; };
const M = new Function(`${line(/const AWAKE_START_MS = \d+;/)}\n${line(/const venueReady = .*;/)}\n${fn(main, "awakeWanted")}\n${fn(main, "awakeApply")}\nreturn { awakeWanted, awakeApply, AWAKE_START_MS };`)();

const NOW = 1_800_000_000_000;
const venue = { credentials: true, pair: true, order: true, account: true };
const base = () => ({ venues: { binance: venue }, reconciler: { alive: true }, daemon: { reconciler: { running: true } } });
const st = (patch, top) => ({ alive: true, running: true, ...(top || {}), report: patch === null ? null : Object.assign(base(), patch) });
const want = (s, o) => M.awakeWanted({ st: s, startAt: 0, now: NOW, keepAwake: true, win: false, presLots: 0, ...(o || {}) });

const rows = [
  ["running(模擬盤也一樣)", st({ venues: { paper: venue } }), {}, true],
  ["running(真錢)", st({}), {}, true],
  ["剛按啟動、報告還說已暫停", st({ halt: { halted: true } }), { startAt: NOW - 5000 }, true],
  ["剛按啟動、對帳器還沒起來", st({ reconciler: { alive: false }, daemon: { reconciler: { running: false } } }, { alive: true }), { startAt: NOW - 59000 }, true],
  ["unconfirmed(重開沒停住;alive 是 false 也持有)", st({ reconciler: { alive: false, stopped: { reason: "machine_restart", gated: false } } }, { alive: false }), {}, true],
  ["halted", st({ halt: { halted: true } }), {}, false],
  ["重開後停著(gated)", st({ reconciler: { alive: true, stopped: { reason: "machine_restart", gated: true } } }), {}, false],
  ["dead:常駐程式不在", st({}, { alive: false }), {}, false],
  ["dead:對帳器沒心跳", st({ reconciler: { alive: false } }), {}, false],
  ["dead:心跳還新鮮但監督者說沒在跑", st({ daemon: { reconciler: { running: false } } }), {}, false],
  ["沒回報", st(null), {}, false],
  ["沒狀態(宿主還沒起)", null, {}, false],
  ["報告是錯誤", st({ error: "x", venues: undefined }), {}, false],
  ["沒帳戶", st({ venues: { binance: { credentials: true } } }), {}, false],
  ["剛按啟動但已經過了收斂上限", st({ halt: { halted: true } }), { startAt: NOW - M.AWAKE_START_MS }, false],
  ["開關關掉:running 也放掉", st({}), { keepAwake: false }, false],
  ["開關關掉:unconfirmed 也放掉", st({ reconciler: { alive: false, stopped: { reason: "machine_restart", gated: false } } }, { alive: false }), { keepAwake: false }, false],
  ["Windows 統一有部位、開關關、已暫停:照樣持有(B)", st({ halt: { halted: true } }), { keepAwake: false, win: true, presLots: 2 }, true],
  ["Windows 統一有部位、沒回報:照樣持有(B)", null, { keepAwake: false, win: true, presLots: 1 }, true],
  ["Mac 不走 B(就算數到部位)", st({ halt: { halted: true } }), { keepAwake: false, win: false, presLots: 2 }, false],
  ["Windows 統一沒部位、開關關", st({}), { keepAwake: false, win: true, presLots: 0 }, false],
];
for (const [name, s, o, exp] of rows) ok(`${exp ? "持有" : "放掉"}:${name}`, want(s, o) === exp, { got: want(s, o) });

// ---- 2. K2 冪等
{
  const log = []; let n = 0;
  const pb = { start: (type) => { log.push("start:" + type); return ++n; }, stop: (id) => log.push("stop:" + id) };
  let cur = null;
  for (const w of [true, true, true]) cur = M.awakeApply(w, cur, pb);
  ok("連續三次要持有:只開一顆、型別 prevent-app-suspension", log.join() === "start:prevent-app-suspension" && cur === 1, log);
  for (const w of [false, false]) cur = M.awakeApply(w, cur, pb);
  ok("連續兩次放掉:只停一次、回到 null", log.join() === "start:prevent-app-suspension,stop:1" && cur === null, log);
  cur = M.awakeApply(true, cur, pb);
  ok("放掉後再要:開新的一顆(不重用舊 id)", cur === 2 && log.length === 3, log);
}

// ---- 3. 接線
ok("5 秒那一輪(trayStart)叫 awakeSync", /function trayStart\(\)[^\n]*startStep\("awake", awakeSync\)/.test(main));
ok("啟動指令(START_CMDS 非 release、restart_reconciler)記下啟動時間;halt 清掉", /START_CMDS\.has\(cmd\) && intent !== "release"\) \|\| cmd === "restart_reconciler"\) \{\s*const at = awakeStartAt = Date\.now\(\)/.test(main)
  && /cmd === "halt"\) \{ awakeStartAt = 0;/.test(main));
ok("結束 app 放掉", /app\.on\("will-quit", \(\) => startStep\("awake", awakeRelease\)\)/.test(main));
ok("main.js 只有 awakeApply 一處開 blocker", (main.match(/powerSaveBlocker\.start\(|\.start\("prevent-app-suspension"\)/g) || []).length === 1 && main.indexOf("presBlocker") < 0);
ok("開關缺鍵 = 開(只有明寫 false 才關)", /\.keepAwake !== false; \} catch \(_\) \{ return true; \}/.test(main));

console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
