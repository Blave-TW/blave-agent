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
ok("門檻側:|實際|>|目標| 走減倉側", J(trGateSide({ entry_usd: 84, reduce_usd: 42 }, 100, 300)) === J({ usd: 42, reduce: true, close: false, band: false }) && J(trGateSide({ entry_usd: 84, reduce_usd: 42 }, 300, 100)) === J({ usd: 84, reduce: false, close: false, band: false }));
// 全平 / 翻向只過平坦地板 close_usd(跟 web 的 pfGateSide 同一條規則;web tests/check_pf_gate_side.js 的格)
{ const G = { entry_usd: 84, reduce_usd: 42, close_usd: 10 }, u = (g, t, a) => trGateSide(g, t, a);
  ok("全平(多、空)用 min(該側, close_usd)", J(u(G, 0, 300)) === J({ usd: 10, reduce: true, close: true, band: false }) && J(u(G, 0, -300)) === J({ usd: 10, reduce: true, close: true, band: false }));
  ok("翻向兩種大小都用 min:目標較小走減倉側、目標較大走進場側", J(u(G, -100, 300)) === J({ usd: 10, reduce: true, close: true, band: false }) && J(u(G, -500, 300)) === J({ usd: 10, reduce: false, close: true, band: false }));
  ok("部分減倉、同向加倉、act=0 進場:不用 close_usd", J(u(G, 100, 300)) === J({ usd: 42, reduce: true, close: false, band: false }) && J(u(G, 300, 100)) === J({ usd: 84, reduce: false, close: false, band: false }) && J(u(G, 300, 0)) === J({ usd: 84, reduce: false, close: false, band: false }));
  ok("close_usd 缺席 / null / NaN / 0 / 負 / 字串 / Infinity → 退回該側(不可算出 NaN 或 0 把每列都畫成會成交)", [undefined, null, NaN, 0, -5, "10", Infinity].every((cu) => J(u({ entry_usd: 84, reduce_usd: 42, close_usd: cu }, 0, 300)) === J({ usd: 42, reduce: true, close: false, band: false })));
  ok("close_usd 比該側大 → 取該側", J(u({ entry_usd: 84, reduce_usd: 5, close_usd: 10 }, 0, 300)) === J({ usd: 5, reduce: true, close: false, band: false }));
  ok("表底腳注:被平坦的 10 擋住的列(減倉或全平/翻向)不另外解釋", /if \(gs && held && !\(\(gs\.reduce \|\| gs\.close\) && gs\.usd <= 10\)\) gated\.push/.test(src)); }
// 漂移容忍帶(稽核 B1;lib/portfolio.compute_diff:同向且兩邊都有倉時 applied = max(該側, band_usd),快照 gates 多 band_usd、usd 已含它;
// web 的 pfGateSide 同一條規則):帶內的差額只是 mark 在動,不畫成會下單、也不讓 trLiveOrderErr 把舊拒單當仍欠著
{ const G = { entry_usd: 84, reduce_usd: 42, close_usd: 10, band_usd: 500, usd: 500 }, u = (g, t, a) => trGateSide(g, t, a);
  ok("同向、兩邊都有倉:門檻 = max(該側, band_usd)——加倉側與減倉側都是;空單同向也算", J(u(G, 10000, 9900)) === J({ usd: 500, reduce: false, close: false, band: true })
    && J(u(G, 9900, 10000)) === J({ usd: 500, reduce: true, close: false, band: true }) && J(u(G, -10000, -9900)) === J({ usd: 500, reduce: false, close: false, band: true }));
  ok("band_usd 比該側小 → 取該側(max),不標 band", J(u({ ...G, band_usd: 20 }, 9900, 10000)) === J({ usd: 42, reduce: true, close: false, band: false }));
  ok("act=0 進場、全平、翻向:不看帶(lib 那邊 <= 0 那支與帶互斥)", J(u(G, 10000, 0)) === J({ usd: 84, reduce: false, close: false, band: false })
    && J(u(G, 0, 10000)) === J({ usd: 10, reduce: true, close: true, band: false }) && J(u(G, -10000, 9900)) === J({ usd: 10, reduce: false, close: true, band: false }) && J(u(G, -100, 300)) === J({ usd: 10, reduce: true, close: true, band: false }));
  ok("band_usd 缺席 / null / NaN / 0 / 負 / 字串 / Infinity → 舊行為(該側)", [undefined, null, NaN, 0, -5, "500", Infinity].every((bu) => J(u({ entry_usd: 84, reduce_usd: 42, close_usd: 10, band_usd: bu }, 10000, 9900)) === J({ usd: 84, reduce: false, close: false, band: false })));
  ok("表底腳注:帶內的列講「在容忍帶內」(usd 是帶不是半口,不能套「超出不到半口」)", /g\.gs\.band \? t\("tr\.gateFootBand", \{ sym: short\(g\.sym\), m: trFmt\(g\.gs\.usd\) \}\)/.test(src)); }
// ── 設計 v4(自動下單頁 polish)──
ok("金額錯誤分兩種:不是數字 = bad、是數字但超過上限 = big;看得懂 = null(空白 = 0;打到一半的「100,00」算 bad,但只在 blur 才會問)", trAmountError("1,500.50") === null && trAmountError("0") === null && trAmountError("abc") === "bad" && trAmountError("100,00") === "bad" && trAmountError("") === null
  && trAmountError("-5") === "bad" && trAmountError("1e9") === "bad" && trAmountError("2000000000") === "big" && trAmountError("2,000,000,000.5") === "big" && trAmountError("$ 1000000001") === "big" && trAmountError(null) === null);
ok("模擬超過 10 倍:往上調擋下;新合計 ≤ 已存合計永遠可存(淨值掉了以後要能往下調);剛好 10 倍不算超過;真錢不擋", J(trLevCheck(true, 11.06, 110000, 100000)) === J({ over: true, blocked: true })
  && J(trLevCheck(true, 10.05, 100000, 100000)) === J({ over: true, blocked: false }) && J(trLevCheck(true, 10.2, 80000, 100000)) === J({ over: true, blocked: false }) && J(trLevCheck(true, 10, 99450, 0)) === J({ over: false, blocked: false })
  && J(trLevCheck(false, 50, 9e9, 0)) === J({ over: false, blocked: false }) && J(trLevCheck(true, null, 5, 0)) === J({ over: false, blocked: false }) && J(trLevCheck(true, NaN, 5, 0)) === J({ over: false, blocked: false }) && TR_PAPER_MAX_LEV === 10);
ok("拒單原文解析:模擬槓桿上限、淨值歸零;其他原文 / 怪輸入回 null(退回原句)", J(trOrderErrParse("order rejected: gross notional 120000.5 exceeds 10× paper equity 9945.2")) === J({ kind: "paperLev", gross: 120000.5, x: "10", cap: 99452 })
  && J(trOrderErrParse("paper account equity would be <= 0 after this fill")) === J({ kind: "paperBroke" }) && trOrderErrParse("Insufficient margin") === null && trOrderErrParse(null) === null && trOrderErrParse({}) === null);
ok("dead 分兩種:監督者被叫去跑(wanted:true)= 異常;沒有 wanted / 舊狀態檔 / 雲端沒有 daemon 區塊 = 你還沒按啟動", trDeadKind({ daemon: { reconciler: { wanted: true, running: false } } }) === "died" && trDeadKind({ daemon: { reconciler: { wanted: false } } }) === "off"
  && trDeadKind({ daemon: { reconciler: {} } }) === "off" && trDeadKind({ daemon: {} }) === "off" && trDeadKind({}) === "off" && trDeadKind(null) === "off" && trDeadKind({ daemon: { reconciler: { wanted: "true" } } }) === "off");
{ const S = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "strings.js"), "utf8"), html = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "index.html"), "utf8"), appSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8");
  ok("輸入途中不報錯:input 事件裡沒有標紅(只有「已經紅、現在看得懂」才消紅);blur 與 Enter 才驗,Enter 不送出", (() => { const i = src.indexOf('inp.addEventListener("input"'), j = src.indexOf('const settle = ', i), body = src.slice(i, j).replace(/\/\/.*$/gm, "");
    return i > 0 && j > i && !/markBad\((?!null\))/.test(body) && /if \(v != null && TR\.bad\[n\]\) markBad\(null\);/.test(body) && /bar\.hidden = false;/.test(body)
      && /const settle = \(\) => \{ const why = trAmountError\(inp\.value\); markBad\(why\);/.test(src) && /if \(e\.key === "Enter" && !e\.isComposing\) \{ e\.preventDefault\(\); settle\(\); \}/.test(src); })());
// 過期的拒單紅字不可以留在表底(Wei 在 Electron 44 實機看到:22:26 的「部位要到 110,000」掛在寫著 20,000 的表下面)。
// 機器端 lib/portfolio._record_order_error 只 append、留最後 5 筆,從來不清 → 規則在 renderer:只顯示**標的還欠著一張單**的那一筆
{ const E = (sym, err) => ({ ts: "2026-09-21T14:26:00", symbol: sym, error: err });
  const P = (...k) => new Set(k);
  ok("那筆失敗還欠著(標的仍有可下單差額)→ 照樣掛出來", trLiveOrderErr([E("BTCUSDT", "boom")], P("BTCUSDT")).error === "boom");
  ok("用戶把金額改小 / 後來補成交,差額已在門檻內 → 那筆失敗是歷史,不掛(這就是 Wei 撞到的那一個)", trLiveOrderErr([E("BTCUSDT", "boom")], P("ETHUSDT")) === null && trLiveOrderErr([E("BTCUSDT", "boom")], P()) === null);
  ok("最新那筆已解決、較舊那筆還欠著 → 掛還欠著的那一筆(不是無腦取最後一筆)", trLiveOrderErr([E("ETHUSDT", "old"), E("BTCUSDT", "new")], P("ETHUSDT")).error === "old");
  ok("兩筆都還欠著 → 取比較新的那一筆", trLiveOrderErr([E("ETHUSDT", "old"), E("BTCUSDT", "new")], P("ETHUSDT", "BTCUSDT")).error === "new");
  ok("標的寫法不一致(小寫、帶 - 、@spot)也對得起來", trLiveOrderErr([E("btc-usdt@spot", "s")], P("BTCUSDT@spot")).error === "s" && trLiveOrderErr([E("BTCUSDT@spot", "s")], P("BTCUSDT")) === null);
  ok("壞輸入不拋:不是陣列 / 列裡不是物件 / 沒有 symbol", trLiveOrderErr(null, P("BTCUSDT")) === null && trLiveOrderErr(undefined, P("BTCUSDT")) === null && trLiveOrderErr([null, 5, "x"], P("BTCUSDT")) === null
    && trLiveOrderErr([E(undefined, "b")], P("BTCUSDT")) === null && trLiveOrderErr([E("BTCUSDT", "b")], null) === null);
  ok("接線:表底那行吃 trLiveOrderErr;pending = 會觸發下單的列,外加**口數列**差額非 0 的(用 lot,不是 !gs)", /const le = trLiveOrderErr\(r\.order_errors, pending\);/.test(src)
    && /if \(acts\) pending\.add\(sym\);/.test(src) && !/\(!gs && Math\.round/.test(src) && !/errs\[errs\.length - 1\]/.test(src));
  ok("口數列的差額不被畫成灰色(同一個 ≥10 的誤用)", /acts = lot \? Math\.round\(Math\.abs\(d\)\) > 0 : Math\.abs\(d\) >= \(gs \? gs\.usd : 10\);/.test(src) && /const lot = trIsLot\(last, sym\);/.test(src)); }

// 稽核 B0:按口數的標的(群益 / futures_contracts)——機器端不寫 gates、下單也沒門檻(差 1 口就送單),
// 但畫面的 acts 是拿「≥ 10」在比口數。**不可以用「沒有 gate」當口數訊號**:lib/portfolio.py:1119 是「兩側門檻都等於 flat 就不寫 gates」,
// 那是一般加密標的的常態——用 !gs 會把每條加密列都當成口數列,過期紅字又掛回去(9749e29 白做)
{ const snap = (t, a) => ({ ts: "2026-09-21T14:27:00", target: t, actual: a, orders: [] });
  ok("認得出口數列:asset_spec.type、target.exchange、actual.exchange 任一個說 capital 就算", trIsLot(snap({ TXF: { amount: 3, asset_spec: { type: "futures_contracts" } } }, {}), "TXF") === true
    && trIsLot(snap({ TXF: { amount: 3, exchange: "capital" } }, {}), "TXF") === true && trIsLot(snap({}, { TXF: { size: 1, exchange: "capital" } }), "TXF") === true);
  ok("一般加密列不是口數列(就算它沒有 gate);壞 / 缺的快照不拋", !trIsLot(snap({ BTCUSDT: { amount: 100, exchange: "binance" } }, {}), "BTCUSDT") && !trIsLot(snap({ BTCUSDT: 100 }, {}), "BTCUSDT")
    && !trIsLot(null, "BTCUSDT") && !trIsLot(snap(null, null), "BTCUSDT") && !trIsLot(snap({}, {}), "BTCUSDT") && !trIsLot(snap({ BTCUSDT: { asset_spec: "x" } }, {}), "BTCUSDT"));
  ok("標的寫法不一致(小寫、帶 -、@spot)也對得起來", trIsLot(snap({ "txf@spot": { exchange: "capital" } }, {}), "TXF@spot") === true && trIsLot(snap({ "btc-usdt": { exchange: "capital" } }, {}), "BTCUSDT") === true); }

  ok("稽核 R3:blur 不重建儲存列(打完直接點「儲存」,mousedown 要落在還活著的那顆鈕上)——只更新鈕的 disabled", /if \(svBtn && svBtn\.isConnected\) svBtn\.disabled = anyBad\(\) \|\| stale; else paintBar\(\); \};/.test(src) && /sv\.disabled = anyBad\(\) \|\| stale; svBtn = sv;/.test(src));
  ok("「模擬」只留頂列記號與確認框標題:單位只寫幣別、側欄記號與綠點的節點拿掉、資產與設定帳戶列不掛、cx.perfNote 只剩總覽一處", /function trUnit\(\) \{ return trCcy\(\); \}/.test(src) && !/tr-nav-mode|tr-nav-dot/.test(html + src)
    && (src.match(/"mode paper"/g) || []).length === 0 && (src.match(/t\("cx\.perfNote"\)/g) || []).length === 1 && /mark: trIsPaper\(\) \? t\("tr\.mode\.paper"\) : null/.test(src));
  ok("綠燈只留切換器那顆:標題下那一行不再畫 run-dot", !/trEl\("span", "run-dot live"\)/.test(src));
  ok("頂列 P1=A:自動下單頁開著不出字(錢記號照出),離開才出短狀態詞;開 / 關這一頁都會重畫頂列", /const pageOpen = TR_BAGS\[ENV\.cur\]\.open === true, paper = id === PAPER, tbState = has && !pageOpen \? trShortState\(state\) : "";/.test(src)
    && /S\.open = true; S\.sig = \{\}; ENV\.sig\.tb = null;/.test(src) && /removeAttribute\("aria-current"\); ENV\.sig\.tb = null; trPaintHead\(\);/.test(src));
  ok("確認框:不再組字串(lines: []),走通用的 .cf-* 節點;擋下時 okDisabled 而且不出「儲存後…」那句", /const blocked = lev\.blocked \|\| badStored\.length > 0;/.test(src) && /lines: \[\], extra, lead, okDisabled: blocked/.test(src) && /if \(!blocked\) extra\.appendChild\(trEl\("p", "cf-note", !cloud \? t\("tr\.saveWarn"\) : /.test(src)
    && /\$\("del-ok"\)\.disabled = !!okDisabled;/.test(appSrc) && /classList\.remove\("has-alt"\); \$\("del-ok"\)\.disabled = false;/.test(appSrc));
  ok(".cf-* 是通用樣式(在 app.css、不綁金額確認框):下一批「送上雲端」要重用", /\.cf-row\.total dd \{ font-size: 15px/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.css"), "utf8")) && !/\.cf-row/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.css"), "utf8")));
  ok("畫面上不再出現「對帳沒有在跑」「心跳」;刪掉的四個 key 兩語都刪了", !/"tr\.(paperCcy|saveLine|recDead|lastBeat)"/.test(S) && !/最後心跳|對帳沒有在跑|last heartbeat|Reconciler not running/.test(S)); }
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
  let sent = 0, seenPending = null; const rels = [];
  const slow = () => { sent++; seenPending = TR.pending && TR.pending.want; return new Promise((r) => { rels.push(r); }); };
  const p1 = trRun("halted", [slow]);
  ok("S3 指令送出的當下 pending 已經掛上(鈕已是過場態)", seenPending === "halted");
  await trRun("running", [slow]);
  ok("S3 在途時再按「啟動」:不送第二個指令(那個重複送就是真的多開一次倉)", sent === 1);
  /* 規格 §1.3(Wei 拍板):緊急停止**不可以**被自己的過場態鎖住——前一個指令還在路上不是「不能停」的理由。
     重複送 halt 是安全的:api 那邊 halt 有自己的速率桶,本機 daemon 沒跑時照樣排隊(daemon.js:149),
     而同一次動作的重試沿用同一顆 request_id(trSend),不會變成兩顆。 */
  const p2 = trRun("halted", [slow]);
  ok("S3 在途時再按「暫停」:照送得出去", sent === 2 && TR.pending && TR.pending.want === "halted");
  rels.forEach((r) => r({ ok: true })); await p1; await p2;
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

  /* 稽核 B-3:暫停側的鈕永遠可按,所以 ack 窗(最長 20 秒)之內按第二次是正常操作。那時 reqIds 還沒寫進去
     (要等第一趟回來),再送一次會鑄出**第二顆** request_id——雲端排兩筆、本機 daemon.js:128 每次都鑄新 id 根本
     沒有去重,兩邊都變成 close_all 跑兩次(每一筆各起一支 flatten)。在途時把同一趟的結果交給第二個呼叫端。 */
  { const s0 = src.indexOf("async function trSend("), s1 = src.indexOf("async function trRun(");
    if (s0 < 0 || s1 < 0 || s0 > s1) throw new Error("找不到 trSend");
    eval(src.slice(s0, s1).replace("async function trSend", "trSend = async function"));
    let calls = 0; const rel = [], rids = [];
    const bag = { reqIds: {}, sending: {}, api: { tradeSend: (cmd, args, rid) => { calls++; rids.push(rid); return new Promise((r) => rel.push(r)); } } };
    const a = trSend(bag, "close_all", {}), b = trSend(bag, "close_all", {});
    ok("B-3 在途時第二次按同一顆指令:不再送一次(不會有第二顆 request_id 在飛)", calls === 1 && rel.length === 1);
    rel[0]({ ok: true });
    ok("B-3 兩個呼叫端拿到的是同一趟的結果", (await a) === (await b));
    const c3 = trSend(bag, "close_all", {});
    ok("B-3 飛完了就放開(下一次按照樣送得出去)", calls === 2 && rel.length === 2);
    rel[1]({ ok: true }); await c3;
    ok("B-3 在途標記不會留下來(留著的話這顆指令就永遠送不出去了)", Object.keys(bag.sending).length === 0 && rids.join() === ",")
    ; }

  /* 稽核 B-4:暫停側可重入 → 舊的那一趟回來時,不可以把**還在飛的那一次**的過場態清掉,
     更不可以寫出「暫停沒送到、去交易所撤 key」——那一趟其實正要執行。 */
  { TR.pending = null; alerts.length = 0;
    const rel2 = [], slow2 = () => new Promise((r) => rel2.push(r));
    const q1 = trRun("halted", [slow2]); const first = TR.pending;
    const q2 = trRun("halted", [slow2]); const second2 = TR.pending;
    rel2[0]({ ok: false, error: "OFFLINE" }); await q1;
    ok("B-4 舊的那一趟回來:不清掉新的 pending、不寫假的「沒送到」", TR.pending === second2 && second2 !== first && alerts.length === 0);
    rel2[1]({ ok: true }); await q2;
    ok("B-4 新的那一趟自己收(pending 留著等狀態)", TR.pending === second2 && !second2.unknown); }

  /* spec-desktop-start-pending-stop §1.2:本機兩步啟動(resume → restart_reconciler)在第一步還沒回來時被暫停蓋掉,
     第二步不送——多一個沒人要的指令,而且讓「暫停」之後緊接著冒出「對帳器重新啟動」。 */
  { TR.pending = null; alerts.length = 0;
    const relS = [], stepCalls = [];
    const s1 = (S) => { stepCalls.push("resume"); return new Promise((r) => relS.push(r)); };
    const s2 = async () => { stepCalls.push("restart_reconciler"); return { ok: true }; };
    const qs = trRun("running", [s1, s2], "resume");
    const qh = trRun("halted", [async () => { stepCalls.push("halt"); return { ok: true }; }], "halt");
    relS[0]({ ok: true }); await qs; await qh;
    ok("啟動被暫停蓋掉:第二步(restart_reconciler)不送", stepCalls.join() === "resume,halt", stepCalls.join());
    TR.pending = null; stepCalls.length = 0;
    await trRun("running", [async () => { stepCalls.push("resume"); return { ok: true }; }, s2], "resume");
    ok("陽性對照:沒被蓋掉的啟動兩步都送", stepCalls.join() === "resume,restart_reconciler"); }

  /* 稽核 R2-1(Wei 拍):**平倉那趟的結果永遠要講,不管後來誰蓋了 pending**。close_all 跟 halt 共用 want:"halted"
     這個槽——先按平倉再按暫停,暫停收斂、鈕變「啟動」,而平倉其實沒送出去、部位還在;B-4 的守衛不能把這一句吞掉。 */
  { TR.pending = null; alerts.length = 0;
    const rel3 = [], slow3 = () => new Promise((r) => rel3.push(r));
    const q1 = trRun("halted", [slow3], "close_all"); const q2 = trRun("halted", [slow3], "halt"); const cur = TR.pending;
    rel3[0]({ ok: false, error: "TIMEOUT" }); await q1;
    ok("R2-1 ① 平倉被暫停蓋掉、平倉回沒送到:紅字照出、現在的 pending(暫停那顆)不動", alerts.pop() === "stop:undelivered" && TR.pending === cur && cur.cmd === "halt");
    rel3[1]({ ok: true }); await q2;
    TR.pending = null; alerts.length = 0;
    const q3 = trRun("halted", [slow3], "close_all");
    TR.pending = null;   // 暫停先收斂:trPendingCheck 把 pending 清掉了
    rel3[2]({ ok: false, error: "TIMEOUT" }); await q3;
    ok("R2-1 ② 暫停先收斂清掉 pending、平倉才回 TIMEOUT:一樣要講,而且不把已經清掉的 pending 扶回來", alerts.pop() === "stop:undelivered" && TR.pending === null);
    TR.pending = null; alerts.length = 0;
    const q4 = trRun("halted", [slow3], "halt"); trRun("halted", [slow3], "halt");
    rel3[3]({ ok: false, error: "TIMEOUT" }); await q4;
    ok("R2-1 對照:被蓋掉的是 halt 就照 B-4 不講(halt 冪等,新的那趟會自己講)", alerts.length === 0); }

  /* ── S4 雲端填金額(spec-desktop-cloud-s4)── */
  { const B = 1_800_000_000;   // ack 當下那份報告的時間(主機的秒)
    ok("S4 §3.2 報告對上送出的那一份 = same(四捨五入到 2 位)", trSentSettled({ a: 1500, b: 0 }, { a: 1500.001, b: 0 }, null, B) === "same");
    ok("S4 §3.2 ack 之後來的新報告、值不同 = changed(別處改過,照報告畫、不出錯)", trSentSettled({ a: 1500 }, { a: 900 }, B + 5, B) === "changed");
    ok("S4 §3.2 還是 ack 當下那份(或更舊)= wait;沒有報告時間也只能等", trSentSettled({ a: 1500 }, { a: 900 }, B, B) === "wait" && trSentSettled({ a: 1500 }, { a: 900 }, B - 5, B) === "wait" && trSentSettled({ a: 1500 }, { a: 900 }, null, B) === "wait");
    ok("#7 只拿報告對報告比:這台電腦的時鐘快一小時也不影響(參數裡根本沒有本機時間)", trSentSettled({ a: 1500 }, { a: 900 }, B + 1, B) === "changed" && trSentSettled.length === 4);
    ok("S4 §3.2 key 集合不同就不是 same(amounts 整份覆蓋,少一個 key = 移出組合)",
      trSentSettled({ a: 1500 }, { a: 1500, b: 0 }, null, B) === "wait" && trSentSettled({ a: 1500, b: 0 }, { a: 1500 }, null, B) === "wait");
    ok("S4 §3.4 底稿用送出的那一份:沒改的格子送的是上一次送出的值", J(trAmountsToSend(["a", "b"], { a: 1500, b: 800 }, { b: 1000 }, true)) === J({ a: 1500, b: 1000 }));
    // 稽核 #1(真錢):api 讀不到清單時回空陣列 → 外殼不可以因此把整個組合移出
    const stored1 = { momo: 1500, trend: 800 };
    ok("#1 雲端、清單空、組合有金額:送出內容仍帶全部 key(不會變成 {})", J(trSendAmounts("cloud", [], stored1, {}, true)) === J(stored1));
    ok("#1 雲端、清單只剩一支:另一支照樣帶著,不推論移出", J(trSendAmounts("cloud", ["momo"], stored1, { momo: 2000 }, true)) === J({ momo: 2000, trend: 800 }));
    ok("#1 本機照舊:清單載入過、策略不在了 = 移出組合", J(trSendAmounts("local", ["momo"], stored1, {}, true)) === J({ momo: 1500 }));
    ok("#1 雲端清單空 + 組合有金額 = 不算載入(不給存);空組合的空清單才算", trCloudListOk(true, [], stored1) === false && trCloudListOk(true, [], {}) === true
      && trCloudListOk(true, [{ name: "momo" }], stored1) === true && trCloudListOk(false, [{ name: "momo" }], stored1) === false);
    // 稽核 #2:收斂 / 逾時只換啟動暫停那一組的 request_id
    const ids = { halt: "1", close_all: "2", resume: "3", resume_wait: "4", amounts: "A", update: "U", restart_reconciler: "R" };
    trClearRunIds(ids);
    ok("#2 收斂時只清 halt / close_all / resume / resume_wait,amounts / update / restart_reconciler 留著", J(ids) === J({ amounts: "A", update: "U", restart_reconciler: "R" }));
    // S4 §4 ④:request_id 綁內容
    ok("④ 內容 key 與順序無關、改一個數字就不同", trAmountsKey({ a: 1, b: 2 }) === trAmountsKey({ b: 2, a: 1 }) && trAmountsKey({ a: 1, b: 2 }) !== trAmountsKey({ a: 1, b: 3 }));
    ok("M1 表上沒列出、存量裡有的那幾支 = 表下「有 N 支讀不到」的 N", J(trHidden(["momo"], { momo: 1, trend: 2, x: 0 })) === J(["trend", "x"]) && trHidden(["a"], {}).length === 0);
    ok("L1 已有組合跡象(對帳跑過 / 有排程)卻沒有 amounts = 讀不到設定,不給存;新機兩個訊號都沒有 = 照樣能第一次存",
      trCfgUnread({ config: {}, last_reconcile: { at: 1 } }) === true && trCfgUnread({ config: null, scheduled: ["a"] }) === true
      && trCfgUnread({ config: {}, last_reconcile: null, scheduled: [] }) === false && trCfgUnread({ config: { amounts: {} }, last_reconcile: { at: 1 } }) === false
      && trCfgUnread({ config: {}, scheduled: null }) === false && trCfgUnread(null) === false);
    ok("L3 主機設定裡不合法的值挑得出來(非數字 / 負數 / 超過上限);合法的不挑",
      J(trBadStored({ a: 1, b: "x", c: -1, d: 2e9, e: NaN, f: 0 })) === J(["b", "c", "d", "e"])); }
  { const tsrc = src;
    const fnOf = (name) => { const i = tsrc.indexOf("function " + name + "("); if (i < 0) return ""; const j = tsrc.indexOf("\nfunction ", i + 1), k = tsrc.indexOf("\nasync function ", i + 1);
      return tsrc.slice(i, Math.min(j < 0 ? Infinity : j, k < 0 ? Infinity : k)); };
    const tbl = fnOf("trAmountTable");
    // §4:request_id 綁內容不綁指令名——改一格 / 還原都要換掉,不然 429 之後改了數字再存,api 當成重送、新數字永遠不會套用
    ok("S4 §4 輸入框的 input 事件清掉 reqIds.amounts", /inp\.addEventListener\("input", \(\) => \{[\s\S]*?delete TR\.reqIds\.amounts;/.test(tbl));
    ok("S4 §4 還原也清掉 reqIds.amounts", /rv\.addEventListener\("click", \(\) => \{[^\n]*delete TR\.reqIds\.amounts;/.test(tbl));
    ok("S4 §4 雲端存檔走 trSend(單飛 + request_id 沿用),不直叫 tradeSend", /cloud \? await trSend\(S, "amounts", \{ amounts: sending \}\)/.test(fnOf("trSaveAmounts")));
    ok("S4 §1.1 ① 讀不到新狀態不給存:儲存鈕 disabled、儲存函式也擋", /sv\.disabled = anyBad\(\) \|\| stale;/.test(tbl)
      && /if \(cloud && \(!\(S\.st && S\.st\.alive\) \|\| trCfgUnread\(trReport\(\)\)\)\) return;/.test(fnOf("trSaveAmounts")));
    ok("S4 §1.1 ② 雲端清單走 trCloudListOk(strategies_ok + 空清單有金額不算)", /C\.listLoaded = trCloudListOk\(C\.st && C\.st\.cloud && C\.st\.cloud\.strategies_ok, C\.list,/.test(tsrc) && !/C\.listLoaded = true/.test(tsrc));
    ok("#1 存檔走 trSendAmounts(依視角);④ 雲端送出前內容變了就換 request_id", /const sending = trSendAmounts\(S\.env, /.test(fnOf("trSaveAmounts"))
      && /if \(S\.reqFor\.amounts !== key\) delete S\.reqIds\.amounts;/.test(fnOf("trSaveAmounts")));
    ok("L3 雲端表下合計與確認框同口徑(看不見但照送的那幾支也算);讀不到設定時儲存函式也擋",
      /trTotals\(cloud \? trSendAmounts\("cloud", names, stored, TR\.edits, false\) : trCurrentAmounts/.test(tbl)
      && /if \(cloud && \(!\(S\.st && S\.st\.alive\) \|\| trCfgUnread\(trReport\(\)\)\)\) return;/.test(fnOf("trSaveAmounts")));
    { const css = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.css"), "utf8");
      ok("設計稽核必修 ①②③:雲端輸入框焦點框、placeholder --ink-2、選中/hover 列上「拉回」--ink-2(兩個 :not 都在)",
        /html\[data-env="cloud"\] \.chat-input:focus-within \{ border-color: var\(--ink\); \}/.test(css)
        && /html\[data-env="cloud"\] \.chat-input textarea::placeholder \{ color: var\(--ink-2\); \}/.test(css)
        && /#strat-list-cloud \.strat-wrap:is\(:hover, :has\(:focus-visible\), :has\(\[aria-current="true"\]\)\) \.ho-down:not\(:hover\):not\(\[aria-disabled="true"\]\) \{ color: var\(--ink-2\); \}/.test(css)); }
    ok("#2 trPendingCheck 不再整包清 reqIds", !/reqIds = \{\}/.test(fnOf("trPendingCheck")) && (fnOf("trPendingCheck").match(/trClearRunIds\(TR\.reqIds\)/g) || []).length === 3);
    // trSentCheck 的行為:收斂清記號並播一次讀屏、主機停了清掉、逾時不清記號但清 request_id
    let said = []; var srSay = (x) => said.push(x); var envCloudKind = (st) => st.kind; var t = (k) => k;
    eval(tsrc.match(/const TR_CONFIRM_CLOUD_MS = \d+;/)[0].replace("const", "var")); eval(fnOf("trSentCheck"));
    const bag = (o) => Object.assign({ sent: { a: 1500 }, sentRep: 1e9, save: "sent", saveUnknownAt: 0, reqIds: { amounts: "R" }, sig: {},
      st: { kind: "running", cloud: { reported_at: null }, report: { config: { amounts: { a: 900 } } } } }, o);
    let C = bag(); trSentCheck(C, 1e12 + 1e9);
    ok("S4 §3.3 逾時不清記號、不出字(Wei 拍板)", C.sent !== null && C.save === "sent" && said.length === 0);
    C = bag({ st: { kind: "running", cloud: {}, report: { config: { amounts: { a: 1500 } } } } }); trSentCheck(C, 1e12);
    ok("S4 §3.2 對上了:清掉記號、讀屏播一次 pendDone", C.sent === null && C.save === null && said.join() === "tr.cloud.pendDone");
    said = []; C = bag({ st: { kind: "stopped", cloud: {}, report: null } }); trSentCheck(C, 1e12);
    ok("S4 §3.2 主機停了:清掉,不播", C.sent === null && said.length === 0);
    C = bag({ sent: null, save: "failed", saveUnknownAt: 1e12 }); trSentCheck(C, 1e12 + 1000);
    ok("S4 §4 ack 逾時之後、收斂窗口內:同一份內容重按沿用同一顆", C.reqIds.amounts === "R");
    trSentCheck(C, 1e12 + 241000);
    const alertCalls = []; var trAlert = (...a) => alertCalls.push(a);
    eval(fnOf("trCloudOwnerCheck"));
    const ob = (ep, kind) => ({ epoch: 3, sent: { a: 1 }, sentRep: 5, save: "sent", saveErr: null, saveUnknownAt: 7, reqIds: { amounts: "R", halt: "H" }, reqFor: { amounts: "k" }, sig: {},
      st: { kind: kind || "running", cloud: { epoch: ep } } });
    let O = ob(3); trCloudOwnerCheck(O);
    ok("#8 同一個人:在途金額與 request_id 留著", O.sent !== null && O.reqIds.amounts === "R" && O.save === "sent");
    O = ob(4); trCloudOwnerCheck(O);
    ok("#8 換帳號(epoch 變了):sent / save / saveUnknownAt / reqIds 全清", O.sent === null && O.save === null && O.saveUnknownAt === 0 && J(O.reqIds) === "{}" && J(O.reqFor) === "{}" && O.epoch === 4);
    ok("M2 換帳號:上一個人的過場、在途那一趟、紅字也清(B 的暫停不會併進 A 那一趟)", (() => { const X = Object.assign(ob(9), { pending: { want: "running" }, sending: { halt: 1 } });
      trCloudOwnerCheck(X); return X.pending === null && J(X.sending) === "{}" && alertCalls.some((c) => c[0] === "" && c[2] === X); })());
    O = ob(3, "signedOut"); trCloudOwnerCheck(O);
    ok("#8 登出:一樣全清", O.sent === null && J(O.reqIds) === "{}");
    ok("S4 §4 過了收斂窗口:request_id 換掉(再按是新的意圖)", C.reqIds.amounts === undefined && C.saveUnknownAt === 0); }
  console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
})();

