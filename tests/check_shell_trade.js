// shell/renderer/trade.js 的純邏輯(不碰 DOM 的那一段),從原文切出來跑:
//   trExecState   狀態字判定(雲端 pfExecState 的移植 + 電腦版的「狀態檔還沒有」「常駐程式不在」)
//   trAmountsToSend / trTotals / trParseAmount   金額表:送出去的 membership、合計與倍數、輸入解析
//   trClientTargets / trGateSide   目標部位與門檻側
// 跑法:node tests/check_shell_trade.js
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8");
const a = src.indexOf("/* ── 純邏輯("), b = src.indexOf("/* ── 純邏輯到此");
if (a < 0 || b < 0) throw new Error("找不到純邏輯區塊的標記");
const block = src.slice(a, b);
if (/\bdocument\b|\$\(|window\./.test(block.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))) throw new Error("純邏輯區塊碰了 DOM");
eval(block.replace(/^const /gm, "var "));
let red = 0; const ok = (name, c) => { console.log((c ? "PASS  " : "FAIL  ") + name); if (!c) red++; };
const J = JSON.stringify;

const V = { paper: { credentials: true, pair: true, order: true, account: true } };
const acct = (okv) => ({ venues: { paper: { ok: okv, equity: 10000, error: okv ? null : "get_equity: boom" } } });
const st = (r, alive = true) => ({ alive, report: r });
ok("狀態檔還沒寫出來 = loading", trExecState({ alive: true, report: null }) === "loading" && trExecState(null) === "loading");
ok("沒綁任何交易所 = noaccount(就算 HALT 在、對帳器活著也一樣,順序最先)", trExecState(st({ venues: {}, halt: { halted: true }, reconciler: { alive: true } })) === "noaccount");
ok("金鑰不成對 / 缺 lib 不算帳戶", trExecState(st({ venues: { x: { credentials: true, pair: false, order: true, account: true } } })) === "noaccount"
  && trExecState(st({ venues: { x: { credentials: true, pair: true, order: false, account: true } } })) === "noaccount");
ok("剛連上、帳戶還沒讀過:算有帳戶(不閃回 onboard)", trExecState(st({ venues: V, account: null, reconciler: { alive: false } })) === "dead");
// 稽核 S5:讀帳失敗 / 狀態檔 build 失敗時,頁面不能變成 onboard、暫停鈕不能消失
ok("S5 讀帳失敗:仍算有帳戶(不回 onboard),另外列為串接失敗", trExecState(st({ venues: V, account: acct(false), halt: {}, reconciler: { alive: true } })) === "running" && J(trFailedIds({ venues: V, account: acct(false) })) === J(["paper"]));
ok("S5 狀態檔 build 失敗(只有 error、沒有 venues)= unknown,不是 noaccount", trExecState(st({ error: "boom" })) === "unknown" && trExecState(st({ daemon: {} })) === "unknown" && trExecState(st({ error: "x", venues: V })) === "unknown");
// 心跳檔新鮮期 300 秒:app 重開後 5 分鐘內上一次的心跳還算 alive,但監督者說對帳器沒在跑 → 不能畫「執行中」
ok("重開後舊心跳還新鮮、監督者說沒在跑 = dead", trExecState(st({ venues: V, halt: {}, reconciler: { alive: true }, daemon: { reconciler: { running: false } } })) === "dead"
  && trExecState(st({ venues: V, halt: {}, reconciler: { alive: true }, daemon: { reconciler: { running: true } } })) === "running"
  && trExecState(st({ venues: V, halt: {}, reconciler: { alive: true } })) === "running");
ok("M2 啟動下單要不要補 restart:聽監督者的,沒講才退回心跳", trRecRunning(st({ reconciler: { alive: true }, daemon: { reconciler: { running: false } } })) === false
  && trRecRunning(st({ reconciler: { alive: false }, daemon: { reconciler: { running: true } } })) === true
  && trRecRunning(st({ reconciler: { alive: true } })) === true && trRecRunning(st({ reconciler: { alive: false } })) === false
  && trRecRunning({ alive: false, report: { reconciler: { alive: true } } }) === false && trRecRunning(null) === false);
// 稽核 S1:常駐程式不在跑時的誠實狀態
const T0 = 1_000_000_000;
ok("S1 在跑 / 從沒起過(引擎還沒裝)= 不是 down", trHostDown({ running: true, lastExit: { code: 1, at: T0 } }, T0) === null && trHostDown({ running: false, lastExit: null }, T0) === null && trHostDown(null, T0) === null);
ok("S1 剛死 = 宿主重試中;90 秒後還沒起來 = 起不來", trHostDown({ running: false, lastExit: { code: 1, at: T0 } }, T0 + 5000) === "retry" && trHostDown({ running: false, lastExit: { code: 1, at: T0 } }, T0 + 91000) === "down");
ok("S1 宿主重試滿 5 次 = 起不來(不再顯示重新啟動中)", trHostDown({ running: false, restarts: 5, lastExit: { code: 1, at: T0 } }, T0 + 1000) === "down");
ok("等上一個下單機放鎖 = lock(含重試那支剛起來 running:true 的那幾秒);重試用完(lockRetry:null + exit 3)= 起不來", trHostDown({ running: false, lockRetry: { attempt: 2, max: 4, nextAt: T0 + 5000 }, lastExit: { code: 3, at: T0 } }, T0) === "lock"
  && trHostDown({ running: true, lockRetry: { attempt: 2, max: 4, nextAt: null }, lastExit: { code: 3, at: T0 } }, T0) === "lock" && trHostDown({ running: false, lockRetry: null, lastExit: { code: 3, at: T0 } }, T0) === "down");
ok("S1 exit 2/3 與 spawn 失敗不會重試 = 直接起不來", ["2", "3"].every((c) => trHostDown({ running: false, lastExit: { code: +c, at: T0 } }, T0) === "down") && trHostDown({ running: false, lastExit: { code: null, at: T0, error: "EACCES" } }, T0) === "down");
// 稽核 S2:error → 說法
ok("S2 UNKNOWN_RESULT = 結果不明(不能說沒送到)", trErrorKind("UNKNOWN_RESULT") === "unknown");
ok("S2 TIMEOUT / DAEMON_DOWN / BAD_ARGS / 空 = 沒送到", ["TIMEOUT", "DAEMON_DOWN", "BAD_ARGS", "NOT_ALLOWED", "", null, undefined].every((e) => trErrorKind(e) === "undelivered"));
ok("S2 handler 自己的字串 = 被拒絕", trErrorKind("ValueError: amounts must be numbers") === "rejected");
ok("HALT 優先於對帳器死活", trExecState(st({ venues: V, account: acct(true), halt: { halted: true }, reconciler: { alive: false } })) === "halted");
ok("對帳器沒心跳 = dead", trExecState(st({ venues: V, account: acct(true), halt: { halted: false }, reconciler: { alive: false } })) === "dead");
ok("全部正常 = running", trExecState(st({ venues: V, account: acct(true), halt: { halted: false }, reconciler: { alive: true } })) === "running");
ok("常駐程式不在:狀態檔說對帳器活著也不信", trExecState(st({ venues: V, account: acct(true), halt: {}, reconciler: { alive: true } }, false)) === "dead");
ok("指令通道:常駐程式不在或 listener 死了 = 不通", !trChannelUp(st({ command_listener: { alive: true } }, false)) && !trChannelUp(st({ command_listener: { alive: false } })) && trChannelUp(st({ command_listener: { alive: true } })));

// 稽核 S11:看不懂的回 null(不是 0、更不是放大後的數)
ok("S11 正常寫法:純數字、千分位、$、前後空白、兩位小數、空字串 = 0", trParseAmount("1,000") === 1000 && trParseAmount(" $12.345 ") === 12.35 && trParseAmount("1500.5") === 1500.5 && trParseAmount(".5") === 0.5 && trParseAmount("1,234,567.89") === 1234567.89 && trParseAmount("") === 0 && trParseAmount("0") === 0);
ok("S11 歐式小數不會被放大:「1,5」不是 15、「1.000,50」不是 1", trParseAmount("1,5") === null && trParseAmount("1.000,50") === null && trParseAmount("1,00") === null && trParseAmount("12,3456") === null);
ok("S11 科學記號 / 夾字母 / 負數 / 多個小數點 拒收", ["1e5", "1e999", "12abc", "abc", "-5", "1.2.3", ".", ",", "1 000", "Infinity", "NaN"].every((x) => trParseAmount(x) === null));
ok("S11 上限對齊宿主 1e9", trParseAmount("1000000000") === 1e9 && trParseAmount("1000000000.01") === null && trParseAmount("1,000,000,001") === null);
const names = ["a", "b", "c"], stored = { b: 300, gone: 50 };
ok("送出:>0 才新加入;已在組合的改 0 仍留 key;沒碰過的 0 不送", J(trAmountsToSend(names, stored, { a: 500, b: 0 }, true)) === J({ a: 500, b: 0 }));
ok("送出:沒改的沿用已存值", J(trAmountsToSend(names, stored, {}, true)) === J({ b: 300 }));
ok("策略已不在這台電腦上的 = 移出組合(清單載入過才算)", J(trRemoved(stored, trAmountsToSend(names, stored, {}, true))) === J(["gone"]));
// 稽核 S4:清單還沒載入 / 載入失敗時 names 是空的——那不是「策略都不見了」
ok("S4 清單沒載入:一個都不准移出,已存的 key 原樣帶著", J(trRemoved(stored, trAmountsToSend([], stored, {}, false))) === J([]) && J(trAmountsToSend([], stored, {}, false)) === J({ b: 300, gone: 50 }));
ok("S4 忘了帶 loaded(undefined)也走安全那邊", J(trRemoved(stored, trAmountsToSend([], stored, {}))) === J([]));
ok("合計與倍數", J(trTotals({ a: 500, b: 300 }, 4000)) === J({ total: 800, mult: 0.2 }));
ok("沒有淨值(null / 0)就沒有倍數,不拿 0 去除", trTotals({ a: 1 }, null).mult === null && trTotals({ a: 1 }, 0).mult === null);
ok("dirty:改回原值不算改過", trDirty(names, stored, { b: 300 }) === false && trDirty(names, stored, { b: 301 }) === true && trDirty(names, stored, { a: 0 }) === false);

const states = { s1: { symbol: "BTC-USDT", position: 1 }, s2: { symbol: "BTCUSDT", position: -0.5 }, s3: { symbol: "ETHUSDT", position: -1, market: "spot" }, s4: { position: 1 } };
ok("目標部位:同標的加總(dash 正規化)、現貨負值壓 0、沒 symbol 的跳過", J(trClientTargets({ s1: 1000, s2: 400, s3: 100, s4: 9 }, states)) === J({ BTCUSDT: 800, "ETHUSDT@spot": 0 }));
ok("部位正負號", trSigned({ side: "long", size: 5 }) === 5 && trSigned({ side: "sell", size: 5 }) === -5 && trSigned({}) === 0 && trSigned(null) === 0);
ok("門檻側:|實際|>|目標| 走減倉側", J(trGateSide({ entry_usd: 84, reduce_usd: 42 }, 100, 300)) === J({ usd: 42, reduce: true }) && J(trGateSide({ entry_usd: 84, reduce_usd: 42 }, 300, 100)) === J({ usd: 84, reduce: false }));
ok("舊快照只有 usd:減倉腿回 null", trGateSide({ usd: 84 }, 0, 100) === null && trGateSide({ usd: 84 }, 100, 0).usd === 84 && trGateSide(null, 1, 0) === null);
ok("時間:epoch 秒與沒帶時區的 ISO(當 UTC)都吃", trMs(1000) === 1000000 && trMs("2026-09-20T16:52:05.377713") === Date.UTC(2026, 8, 20, 16, 52, 5, 377) && trMs("x") === null && trMs(null) === null);

// 稽核 S3:啟動/暫停在指令在途時不可重入。trRun 從原文切出來,DOM 相關的換成空函式
// 非同步那段要是懸空(promise 永遠不回),node 會靜靜地 exit 0——沒跑到結尾一律算紅
process.on("beforeExit", () => { console.log("FAIL  非同步測試沒有跑到結尾"); process.exit(1); });
(async () => {
  const c0 = src.indexOf("async function trRun("), c1 = src.indexOf("\nfunction trPaintHead()");
  if (c0 < 0 || c1 < 0) throw new Error("找不到 trRun");
  var TR = { pending: null }, TR_CONFIRM_MS = 60000, alerts = [];
  var trAlert = (x) => { if (x) alerts.push(x); }, trPaint = () => {}, trPollSoon = () => {}, t = (k) => k;
  var trSendError = (res, kind) => kind + ":" + trErrorKind(res && res.error);
  eval(src.slice(c0, c1).replace("async function trRun", "trRun = async function"));
  let sent = 0, release, seenPending = null;
  const slow = () => { sent++; seenPending = TR.pending && TR.pending.want; return new Promise((r) => { release = r; }); };
  const p1 = trRun("halted", [slow]);
  ok("S3 指令送出的當下 pending 已經掛上(鈕已是過場態)", seenPending === "halted");
  await trRun("halted", [slow]); await trRun("running", [slow]);
  ok("S3 在途時再呼叫一次:不送第二個指令", sent === 1);
  release({ ok: true }); await p1;
  ok("S3 成功:pending 留著等狀態檔", TR.pending && TR.pending.want === "halted" && alerts.length === 0);
  TR.pending = null; await trRun("halted", [async () => ({ ok: false, error: "TIMEOUT" })]);
  ok("S3/S2 確定沒執行:pending 拿掉、暫停專用那句", TR.pending === null && alerts.pop() === "stop:undelivered");
  await trRun("running", [async () => ({ ok: false, error: "TIMEOUT" })]);
  ok("S2 啟動沒成功不走暫停那句(不說「它還在交易」)", alerts.pop() === "start:undelivered");
  await trRun("halted", [async () => ({ ok: false, error: "UNKNOWN_RESULT" })]);
  ok("S2 結果不明:pending 留著看狀態、說結果不明", TR.pending && TR.pending.unknown === true && alerts.pop() === "tr.cmdUnknown");
  TR.pending = null; let second = 0;
  await trRun("running", [async () => ({ ok: false, error: "X" }), async () => { second++; return { ok: true }; }]);
  ok("第一步失敗:後面的步驟(restart_reconciler)不送", second === 0 && TR.pending === null);
  console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
})();

