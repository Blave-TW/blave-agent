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

  ok("稽核 R3:blur 不重建儲存列(打完直接點「儲存」,mousedown 要落在還活著的那顆鈕上)——只更新鈕的 disabled", /if \(svBtn && svBtn\.isConnected\) svBtn\.disabled = anyBad\(\); else paintBar\(\); \};/.test(src) && /sv\.disabled = anyBad\(\); svBtn = sv;/.test(src));
  ok("「模擬」只留頂列記號與確認框標題:單位只寫幣別、側欄記號與綠點的節點拿掉、資產與設定帳戶列不掛、cx.perfNote 只剩總覽一處", /function trUnit\(\) \{ return trCcy\(\); \}/.test(src) && !/tr-nav-mode|tr-nav-dot/.test(html + src)
    && (src.match(/"mode paper"/g) || []).length === 0 && (src.match(/t\("cx\.perfNote"\)/g) || []).length === 1 && /mark: trIsPaper\(\) \? t\("tr\.mode\.paper"\) : null/.test(src));
  ok("綠燈只留切換器那顆:標題下那一行不再畫 run-dot", !/trEl\("span", "run-dot live"\)/.test(src));
  ok("頂列 P1=A:自動下單頁開著不出字(錢記號照出),離開才出短狀態詞;開 / 關這一頁都會重畫頂列", /const pageOpen = TR_BAGS\[ENV\.cur\]\.open === true, paper = id === PAPER, tbState = has && !pageOpen \? trShortState\(state\) : "";/.test(src)
    && /S\.open = true; S\.sig = \{\}; ENV\.sig\.tb = null;/.test(src) && /removeAttribute\("aria-current"\); ENV\.sig\.tb = null; trPaintHead\(\);/.test(src));
  ok("確認框:不再組字串(lines: []),走通用的 .cf-* 節點;擋下時 okDisabled 而且不出「儲存後…」那句", /lines: \[\], extra, okDisabled: lev\.blocked/.test(src) && /if \(!lev\.blocked\) extra\.appendChild\(trEl\("p", "cf-note", t\("tr\.saveWarn"\)\)\);/.test(src)
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

