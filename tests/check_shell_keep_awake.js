// 自動下單在跑時不讓電腦閒置睡眠(spec desktop-keep-awake-while-trading K1/K2/K5)。main.js 的 awakeWanted / awakeApply 從原文切出來跑:
//   1. 表列:running／剛按啟動／unconfirmed／holds_all 不是 true 的暫停持有;全停的暫停／dead／沒回報／沒帳戶放掉;報告錯誤沿用上一輪;Windows 統一有部位且開關關照樣持有;Mac 沒有 B
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
const want = (s, o) => M.awakeWanted({ st: s, startAt: 0, now: NOW, keepAwake: true, win: false, twHeld: false, ...(o || {}) });

const rows = [
  ["running(模擬盤也一樣)", st({ venues: { paper: venue } }), {}, true],
  ["running(真錢)", st({}), {}, true],
  ["剛按啟動、報告還說已暫停", st({ halt: { halted: true } }), { startAt: NOW - 5000 }, true],
  ["剛按啟動、對帳器還沒起來", st({ reconciler: { alive: false }, daemon: { reconciler: { running: false } } }, { alive: true }), { startAt: NOW - 59000 }, true],
  ["unconfirmed(重開沒停住;alive 是 false 也持有)", st({ reconciler: { alive: false, stopped: { reason: "machine_restart", gated: false } } }, { alive: false }), {}, true],
  ["暫停但不是全停(holds_all 缺):舊語意仍平倉停損", st({ halt: { halted: true } }), {}, true],
  ["暫停但不是全停(holds_all false)", st({ halt: { halted: true, holds_all: false } }), {}, true],
  ["暫停、holds_all 是字串 \"true\"(只認布林 true)", st({ halt: { halted: true, holds_all: "true" } }), {}, true],
  ["暫停且全停(holds_all true)", st({ halt: { halted: true, holds_all: true } }), {}, false],
  ["重開後停著(gated)", st({ reconciler: { alive: true, stopped: { reason: "machine_restart", gated: true } } }), {}, false],
  ["dead:常駐程式不在", st({}, { alive: false }), {}, false],
  ["dead:對帳器沒心跳", st({ reconciler: { alive: false } }), {}, false],
  ["dead:心跳還新鮮但監督者說沒在跑", st({ daemon: { reconciler: { running: false } } }), {}, false],
  ["沒回報", st(null), {}, false],
  ["沒狀態(宿主還沒起)", null, {}, false],
  ["報告是錯誤、上一輪沒持有", st({ error: "x", venues: undefined }), {}, false],
  ["報告是錯誤、上一輪持有:沿用", st({ error: "x", venues: undefined }), { prev: true }, true],
  ["報告是錯誤、上一輪持有但常駐程式不在", st({ error: "x", venues: undefined }, { alive: false }), { prev: true }, false],
  ["沒帳戶", st({ venues: { binance: { credentials: true } } }), {}, false],
  ["剛按啟動但已經過了收斂上限", st({ halt: { halted: true, holds_all: true } }), { startAt: NOW - M.AWAKE_START_MS }, false],
  ["開關關掉:running 也放掉", st({}), { keepAwake: false }, false],
  ["開關關掉:unconfirmed 也放掉", st({ reconciler: { alive: false, stopped: { reason: "machine_restart", gated: false } } }, { alive: false }), { keepAwake: false }, false],
  ["Windows 統一有部位、開關關、已暫停:照樣持有(B)", st({ halt: { halted: true } }), { keepAwake: false, win: true, twHeld: true }, true],
  ["Windows 沒回報、也從沒綁過台灣券商:B 不成立、放掉", st(null), { win: true, twHeld: false }, false],
  ["Mac 不走 B(就算數到部位)", st({ halt: { halted: true } }), { keepAwake: false, win: false, twHeld: true }, false],
  ["Windows 統一沒部位、開關關", st({}), { keepAwake: false, win: true, twHeld: false }, false],
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
{
  // Electron 第一顆 blocker 的 id 是 0(實測):判斷要看 null,不能看真假值
  const log = []; const pb = { start: () => { log.push("start"); return 0; }, stop: (id) => log.push("stop:" + id) };
  let cur = null;
  for (const w of [true, true, true]) cur = M.awakeApply(w, cur, pb);
  ok("id 0:連續三次要持有只開一顆、仍算持有", log.join() === "start" && cur === 0, log);
  cur = M.awakeApply(false, cur, pb);
  ok("id 0:放掉時真的 stop(0)、回到 null", log.join() === "start,stop:0" && cur === null, log);
}

// ---- 3. 接線
ok("5 秒那一輪(trayStart)叫 awakeSync", /function trayStart\(\)[^\n]*startStep\("awake", awakeSync\)/.test(main));
ok("啟動指令(START_CMDS 非 release、restart_reconciler)記下啟動時間;halt 清掉", /START_CMDS\.has\(cmd\) && intent !== "release"\) \|\| cmd === "restart_reconciler"\) \{\s*const at = awakeStartAt = Date\.now\(\)/.test(main)
  && /cmd === "halt"\) \{ awakeStartAt = 0;/.test(main));
ok("awakeSync 把上一輪有沒有持有交進去(prev,報告錯誤時沿用)", /function awakeSync\(\)[\s\S]*?prev: awakeBlocker !== null \}\)/.test(main));
ok("結束 app 放掉", /app\.on\("will-quit", \(\) => startStep\("awake", awakeRelease\)\)/.test(main));
{ // 0.1.28:B = 台灣券商(統一 + 群益本機)有部位,或綁著卻讀不到(保守當有);舊宿主沒有 twHeld 就當沒有
  const tw = (host) => new Function("_tradeHost", fn(main, "twLots") + "\nreturn twLots();")(host);
  const dsrc = fs.readFileSync(path.join(__dirname, "..", "shell", "daemon.js"), "utf8");
  const k = (lots, known = true) => ({ lots, known });
  ok("B:群益 2 口 → 持有;統一讀不到(known:false、0 口)→ 持有;兩家都讀到 0 → 不持有;沒有宿主 / 舊宿主 → 不持有;awakeSync 交 twLots().held;daemon 宿主有 twHeld(兩家各一份 memo)",
    tw({ twHeld: () => ({ president: k(0), capital: k(2) }) }).held === true && tw({ twHeld: () => ({ president: k(0, false), capital: k(0) }) }).held === true
    && tw({ twHeld: () => ({ president: k(0), capital: k(0) }) }).held === false && tw(null).held === false && tw({}).held === false
    && /twHeld: WIN \? twLots\(\)\.held : false/.test(main) && !/presidentLots|capitalLots/.test(main)
    && /P\.twHeld\(r, "president", twMemo\.president\), capital: P\.twHeld\(r, "capital", twMemo\.capital\)/.test(dsrc) && /sealCapital, twHeld,/.test(dsrc)
    && M.awakeWanted({ st: st({ halt: { halted: true, holds_all: true } }), startAt: 0, now: NOW, keepAwake: false, win: true, twHeld: tw({ twHeld: () => ({ capital: k(0, false) }) }).held }) === true); }
ok("main.js 只有 awakeApply 一處開 blocker", (main.match(/powerSaveBlocker\.start\(|\.start\("prevent-app-suspension"\)/g) || []).length === 1 && main.indexOf("presBlocker") < 0);
ok("開關缺鍵 = 開(只有明寫 false 才關)", /\.keepAwake !== false; \} catch \(_\) \{ return true; \}/.test(main));

// 設定 › 一般的說明句(設計師 keep-awake-helper-2026-10-19):只講保護邊界,螢幕會關縮成括號;關掉態只講後果,統一那句照留
{ const sb = {}; require("vm").runInNewContext(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "strings.js"), "utf8") + "\nthis.S = STRINGS;", sb);
  const Z = {  "set.awake.lead": "只擋閒置睡眠（螢幕照常會關）。闔蓋、沒電、手動睡眠時，自動下單照樣停。",  "set.awake.leadWin": "只擋閒置睡眠（螢幕照常會關），筆電要接著電源。闔蓋、沒電、手動睡眠時，自動下單照樣停。",  "set.awake.leadOff": "電腦睡著時，自動下單停止。",  "set.awake.leadOffWin": "電腦睡著時，自動下單停止。統一期貨有部位時，接著電源的電腦仍會保持清醒。" };
  const E = {  "set.awake.lead": "Only blocks idle sleep (the screen still turns off). A closed lid, a dead battery or manual sleep still stops auto-trading.",  "set.awake.leadWin": "Only blocks idle sleep (the screen still turns off); keep a laptop plugged in. A closed lid, dead battery or manual sleep stops auto-trading.",  "set.awake.leadOff": "Auto-trading stops while the computer sleeps.",  "set.awake.leadOffWin": "Auto-trading stops while the computer sleeps. With President Futures positions open, it still stays awake while plugged in." };
  ok("說明句四態 zh / en 逐字同設計稿", Object.keys(Z).every((k) => sb.S.zh[k] === Z[k] && sb.S.en[k] === E[k]), Object.keys(Z).map((k) => [sb.S.zh[k], sb.S.en[k]])); }

console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
