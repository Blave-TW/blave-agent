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
ok("連上的規則(稽核 S-2:放寬已撤回):四個欄位都要——缺 pair 或 pair: false 都不算連上", J(trVenueIds({ venues: { paper: { credentials: true, pair: true, order: true, account: true } } })) === J(["paper"])
  && J(trVenueIds({ venues: { x: { credentials: true, pair: false, order: true, account: true } } })) === "[]" && J(trVenueIds({ venues: { x: { credentials: true, order: true, account: true } } })) === "[]"
  && !/pair !== false/.test(src));
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
{ const pr = trPortfolioRow({ weights: { BTCUSDT: 0.5, ETHUSDT: -0.3, SOLUSDT: 0 }, market: "swap" }, 1000);
  ok("稽核 005 #5 投資組合那一列:{n} 個標的、目標部位 = 多空合計 Σ|金額 × 權重|", pr && pr.n === 3 && Math.abs(pr.gross - 800) < 1e-9 && J(pr.syms) === J(["BTCUSDT", "ETHUSDT", "SOLUSDT"]));
  ok("…現貨的負權重壓 0(同 trClientTargets)、壞權重當 0;單一標的策略回 null", Math.abs(trPortfolioRow({ weights: { A: -0.5, B: 0.5, C: "x" }, market: "spot" }, 1000).gross - 500) < 1e-9
    && trPortfolioRow({ symbol: "BTCUSDT", position: 1 }, 1000) === null && trPortfolioRow(null, 1) === null && trPortfolioRow({ weights: [0.5] }, 1) === null); }
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
ok("lib 的錯誤 token:[okx_account_mode] / [gateio_price_deviated] 認得出來(下單失敗與帳戶讀取兩條路共用 trErrToken);沒 token 的照舊",
  trErrToken("OKX 帳戶模式不支援合約：到 OKX 設定 → 帳戶模式 [okx_account_mode] (OKX 51010: x | /api/v5/trade/order)") === "okx_account_mode"
  && J(trOrderErrParse("Gate.io 盤口偏離標記價太遠 [gateio_price_deviated] (Gate.io MARKET_PRICE_TOO_DEVIATED: x | /futures)")) === J({ kind: "gateio_price_deviated" })
  && J(trOrderErrParse("AccountModeError: ... [okx_account_mode] ...")) === J({ kind: "okx_account_mode" })
  && trErrToken("okx_account_mode without brackets") === null && trErrToken("[other_token]") === null && trErrToken(null) === null);
{ const f = src.slice(src.indexOf("function trOrderErrText("), src.indexOf("\n}\n", src.indexOf("function trOrderErrText(")));
  ok("拒單那一句:兩個 token 各有在地化的句子(表底紅字、灰字「上次」、總覽事件列都走 trOrderErrText)",
    /p\.kind === "okx_account_mode"\) return t\("tr\.err\.okxMode", \{ sym \}\)/.test(f) && /p\.kind === "gateio_price_deviated"\) return t\("tr\.err\.gateDeviated", \{ sym \}\)/.test(f));
  ok("帳戶讀取失敗(設定分頁)帶 [okx_account_mode]:講怎麼改,不出 cx.fail 的原文", /if \(trErrToken\(e\.error\) === "okx_account_mode"\) box\.appendChild\(errLine\(t\("cx\.err\.okxMode"\)\)\);\n\s*else box\.appendChild\(errLine\(t\("cx\.fail"/.test(src)); }
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

  ok("稽核 R3:blur 不重建儲存列(打完直接點「儲存」,mousedown 要落在還活著的那顆鈕上)——只更新鈕的 disabled", /if \(svBtn && svBtn\.isConnected\) svBtn\.disabled = anyBad\(\) \|\| stale \|\| cfgBad; else paintBar\(\); \};/.test(src) && /sv\.disabled = anyBad\(\) \|\| stale \|\| cfgBad; svBtn = sv;/.test(src));
  ok("「模擬」只留頂列記號與確認框標題:單位只寫幣別、側欄記號與綠點的節點拿掉、資產與設定帳戶列不掛、cx.perfNote 只剩總覽一處", /function trUnit\(\) \{ return trCcy\(\); \}/.test(src) && !/tr-nav-mode|tr-nav-dot/.test(html + src)
    && (src.match(/"mode paper"/g) || []).length === 0 && (src.match(/t\("cx\.perfNote"\)/g) || []).length === 1 && /mark: trIsPaper\(\) \? t\("tr\.mode\.paper"\) : null/.test(src));
  ok("綠燈只留切換器那顆:標題下那一行不再畫 run-dot(側欄策略列的呼吸點另外畫,在 envDotInto)", !/run-dot/.test(src.slice(src.indexOf("function trPaintHead("), src.indexOf("\nfunction ", src.indexOf("function trPaintHead(") + 1)))
    && (src.match(/trEl\("span", "run-dot live"\)/g) || []).length === 1 && /function envDotInto\(nm, on\) \{[\s\S]{0,120}?if \(!d\) \{ d = trEl\("span", "run-dot live"\)/.test(src));
  ok("頂列 P1=A:自動下單頁開著不出字(記號照出),離開才出短狀態詞;開 / 關這一頁都會重畫頂列", /const pageOpen = TR_BAGS\[ENV\.cur\]\.open === true, tbState = has && !pageOpen \? trShortState\(state\) : "";/.test(src)
    && /S\.open = true; S\.sig = \{\}; ENV\.sig\.tb = null;/.test(src) && /removeAttribute\("aria-current"\); ENV\.sig\.tb = null; trPaintHead\(\);/.test(src));
  // Wei 0.0.6:頂列記號寫交易所名(模擬 = 「模擬」),狀態詞後面不再重複交易所名;視窗標題同一個詞;tr.tb 拿掉
  ok("頂列記號 = 交易所名 / 模擬;狀態句只有短狀態詞(不接「 · Binance」);視窗標題走同一支;tr.tb 不再用", /tm\.textContent = envVenueText\(mny, id\);/.test(src)
    && /ENV\.sig\.tb = tsig; txt\.textContent = ""; txt\.title = tbState;/.test(src) && /if \(tbUp\) txt\.append\(trEl\("span", "up", tbState\)\);/.test(src)
    && /const money = envVenueText\(cur\.money, cur\.venue\);/.test(src) && !/"tr\.tb"/.test(src) && /out\.money = envMoney\(st\); out\.venue = trVenueIds\(st && st\.report\)\[0\] \|\| null;/.test(src));
  ok("確認框:不再組字串(lines: []),走通用的 .cf-* 節點;擋下時 okDisabled 而且不出「儲存後…」那句", /const blocked = lev\.blocked \|\| badStored\.length > 0;/.test(src) && /lines: \[\], extra, lead, okDisabled: blocked/.test(src) && /if \(!blocked\) extra\.appendChild\(trEl\("p", "cf-note", !cloud \? t\("tr\.saveWarn"\) : /.test(src)
    && /\$\("del-ok"\)\.disabled = !!okDisabled;/.test(appSrc) && /classList\.remove\("has-alt"\); \$\("del-ok"\)\.disabled = false;/.test(appSrc));
  ok(".cf-* 是通用樣式(在 app.css、不綁金額確認框):下一批「送上雲端」要重用", /\.cf-row\.total dd \{ font-size: 15px/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.css"), "utf8")) && !/\.cf-row/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.css"), "utf8")));
  ok("畫面上不再出現「對帳沒有在跑」「心跳」;刪掉的四個 key 兩語都刪了", !/"tr\.(paperCcy|saveLine|recDead|lastBeat)"/.test(S) && !/最後心跳|對帳沒有在跑|last heartbeat|Reconciler not running/.test(S)); }
ok("舊快照只有 usd:減倉腿回 null", trGateSide({ usd: 84 }, 0, 100) === null && trGateSide({ usd: 84 }, 100, 0).usd === 84 && trGateSide(null, 1, 0) === null);
ok("時間:epoch 秒與沒帶時區的 ISO(當 UTC)都吃", trMs(1000) === 1000000 && trMs("2026-09-20T16:52:05.377713") === Date.UTC(2026, 8, 20, 16, 52, 5, 377) && trMs("x") === null && trMs(null) === null);

// 稽核 S3:啟動/暫停在指令在途時不可重入。trRun 從原文切出來,DOM 相關的換成空函式
// 非同步那段要是懸空(promise 永遠不回),node 會靜靜地 exit 0——沒跑到結尾一律算紅
process.on("beforeExit", () => { console.log("FAIL  非同步測試沒有跑到結尾"); process.exit(1); });
// 設定分頁的帳戶列:真的跑一次 trPaintSet(真字串表),看模擬帳戶 / 真實交易所 × 本機 / 雲端各畫出什麼。
// 模擬帳戶沒有金鑰、沒有交易所:「重新測試」按了永遠是已連接,說明也不能講「移除金鑰」
{ const vm = require("vm"), R = path.join(__dirname, "..", "shell", "renderer");
  const cutF = (n) => { const i = src.indexOf("function " + n + "("); if (i < 0) throw new Error("no " + n); let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("no " + n); };
  const node = (tag) => ({ tag, id: "", className: "", kids: [], text: "", disabled: false, focused: 0, classList: { add() {} },
    appendChild(c) { this.kids.push(c); return c; }, append(...c) { c.forEach((x) => this.kids.push(x)); }, setAttribute() {}, addEventListener() {}, focus() { this.focused++; ctx.document.activeElement = this; },
    contains(x) { return flat(this).includes(x); },
    get textContent() { return this.text + this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }, set textContent(v) { this.text = v; this.kids = []; } });
  const flat = (n, out = []) => { if (n && n.tag) { out.push(n); n.kids.forEach((k) => flat(k, out)); } return out; };
  const ctx = { LANG: "zh", Date, Math, Object, Array, String, Number, JSON, isFinite, isNaN, Set, Map };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(R, "strings.js"), "utf8").replace(/^const /gm, "var ") + "\n" + fs.readFileSync(path.join(R, "i18n.js"), "utf8").replace(/^(const|let) /gm, "var "), ctx);
  vm.runInContext(src.slice(src.indexOf("/* ── 純邏輯("), src.indexOf("/* ── 純邏輯到此")).replace(/^const /gm, "var "), ctx);
  vm.runInContext(src.slice(src.indexOf("const PAPER = "), src.indexOf("const cxVenuesFor")).replace(/^const /gm, "var ") + "\n" + ["trEl", "trReport", "trVenueId", "trEnvNames", "trPaintSet", "trUnbind"].map(cutF).join("\n"), ctx);
  // acctOk:true = 已連接、false = 讀帳失敗、null = 還沒讀過(串接中…);bn = Binance 金鑰重查的 state(主行程 binance_link)
  const paint = (venue, env, lang, focusRetest, acctOk = true, bn = null) => {
    const box = node("div"), tab = node("button"), els = { "tr-set": box, "tr-tab-set": tab };
    ctx.document = { createElement: node, activeElement: null };
    if (focusRetest) { const was = node("button"); was.id = "cx-retest"; box.kids.push(was); ctx.document.activeElement = was; }
    ctx.$ = (id) => els[id] || flat(box).find((n) => n.id === id) || null;
    ctx.trShould = () => true; ctx.trSec = (x) => x; ctx.trVenueLabel = (id) => id; ctx.cxRetest = () => {}; ctx.cxIpChip = () => node("span");
    ctx.planWebUrl = () => ""; ctx.window = { blave: { openExternal() {} } }; ctx.CXF = { bn };
    ctx.TR = { env, cx: { retest: false, err: null }, unbinding: false, cxPend: null,
      st: { alive: true, report: { venues: { [venue]: { credentials: true, pair: true, order: true, account: true } }, account: { venues: acctOk == null ? {} : { [venue]: acctOk ? { ok: true, equity: 1000 } : { ok: false, error: "get_equity: paper ledger unreadable" } } } } } };
    vm.runInContext("LANG = " + JSON.stringify(lang) + "; trPaintSet();", ctx);
    const all = flat(box), T = ((tbl) => (k) => tbl[k])(vm.runInContext("STRINGS[LANG]", ctx));   // 當下那一語的表:斷言時 LANG 可能已經換了
    return { retest: all.some((n) => n.id === "cx-retest"), unbind: all.some((n) => n.id === "tr-unbind"), foots: all.filter((n) => n.className === "pf-foot").map((n) => n.textContent), T, tab, active: ctx.document.activeElement };
  };
  const cases = [];
  ["zh", "en"].forEach((lang) => ["local", "cloud"].forEach((env) => ["paper", "binance"].forEach((venue) => cases.push({ lang, env, venue, r: paint(venue, env, lang) }))));
  const bad = (f) => cases.filter(f).map((c) => c.lang + "/" + c.env + "/" + c.venue);
  // Wei 0.0.6:「重新測試」只在讀帳失敗 / 金鑰重查出事(紅記號)時畫;已連接(綠點)與串接中都沒有——模擬與真實交易所同一條
  const b1 = bad((c) => c.r.retest || !c.r.unbind);
  ok("帳戶列:已連接時沒有「重新測試」(模擬 / 真實交易所都沒有);兩者都有「解除綁定」(本機 / 雲端 × zh / en)" + (b1.length ? " ✗ " + b1 : ""), b1.length === 0);
  const want = (c) => c.venue === "paper" ? "tr.unbindDescPaper" : c.env === "cloud" ? "tr.cloud.unbindDesc" : "tr.unbindDesc";
  const b2 = bad((c) => !c.r.T(want(c)) || c.r.foots[0] !== c.r.T(want(c)));
  ok("帳戶列說明:模擬帳戶是「解除後可以改綁真實交易所」、真實交易所仍是移除金鑰那句(本機 / 雲端各自)" + (b2.length ? " ✗ " + b2 : ""), b2.length === 0
    && cases.find((c) => c.lang === "zh" && c.venue === "paper").r.foots[0] === "解除後可以改綁真實交易所。"
    && cases.find((c) => c.lang === "en" && c.venue === "paper").r.foots[0] === "Unbind to connect a real exchange instead."
    && cases.filter((c) => c.venue === "paper").every((c) => !/金鑰|keys/.test(c.r.foots[0])));
  // 稽核 L1 + Wei 0.0.6:讀帳失敗(串接失敗)時才有「重新測試」;已連接、串接中都沒有——模擬與真實交易所同一條
  const pf = ["local", "cloud"].flatMap((env) => ["paper", "binance"].map((v) => paint(v, env, "zh", false, false)));
  ok("讀帳失敗:本機 / 雲端 × 模擬 / Binance 都有「重新測試」;已連接沒有;串接中(還沒讀過)也沒有", pf.every((r) => r.retest)
    && !paint("paper", "local", "zh").retest && !paint("binance", "cloud", "zh").retest && !paint("binance", "local", "zh", false, null).retest && !paint("paper", "local", "zh", false, null).retest);
  ok("Binance 金鑰重查出事(verdict,帳戶讀得到也算失敗態)→ 有「重新測試」;灰記號(沒白名單 / 合約沒開 / 現貨沒開)也有——它是 24 小時自動重查前唯一的入口;重查乾淨(last.ok、沒註記)→ 沒有",
    paint("binance", "local", "zh", false, true, { verdict: { reason: "IP_CHANGED", ip: "1.2.3.4" }, last: null }).retest === true
    && paint("binance", "local", "zh", false, true, { verdict: null, last: { ok: true, code: "NO_IP_RESTRICT", detail: {} } }).retest === true
    && paint("binance", "local", "zh", false, true, { verdict: null, last: { ok: true, code: "OK", detail: { spot: true, futures: false } } }).retest === true
    && paint("binance", "local", "zh", false, true, { verdict: null, last: { ok: true, code: "OK", detail: { spot: false, futures: true } } }).retest === true
    && paint("binance", "local", "zh", false, true, { verdict: null, last: { ok: true, code: "OK", detail: { spot: true, futures: true } } }).retest === false
    && paint("binance", "local", "zh", false, null, { verdict: null, last: { ok: true, code: "OK", detail: { spot: true, futures: true } } }).retest === false);
  const fp = paint("paper", "local", "zh", true), fb = paint("binance", "local", "zh", true), fbFail = paint("binance", "local", "zh", true, false);
  ok("焦點在「重新測試」上、這一列變成已連接(鈕不見了):模擬 / Binance 都把焦點交給設定分頁,不掉到 BODY;還在失敗的留在重新測試上", fp.tab.focused === 1 && fp.active === fp.tab
    && fb.tab.focused === 1 && fb.active === fb.tab && fbFail.tab.focused === 0 && fbFail.active && fbFail.active.id === "cx-retest");
  // 頂列記號 / 視窗標題的那個詞(envVenueText):模擬 → 「模擬」;真的交易所 → CX_VENUES 的名字(OKX / Gate.io 不是首字大寫);沒連 → 空
  { const c2 = { t: (k) => ({ "tr.mode.paper": "模擬", "cx.paperShort": "模擬交易" })[k] || k }; vm.createContext(c2);
    vm.runInContext(src.slice(src.indexOf("const PAPER = "), src.indexOf("const cxVenuesFor")).replace(/^const /gm, "var ") + "\n" + cutF("trVenueLabel") + "\n" + src.match(/const envVenueText = [^\n]*/)[0].replace(/^const /, "var "), c2);
    ok("記號的字:模擬 → 「模擬」;Binance / OKX / Gate.io 照表;表外 id 首字大寫;沒連 → 空(不再有「真錢」)",
      vm.runInContext('[envVenueText("paper", "paper"), envVenueText("real", "binance"), envVenueText("real", "okx"), envVenueText("real", "gateio"), envVenueText("real", "kraken"), envVenueText(null, null)].join("|")', c2) === "模擬|Binance|OKX|Gate.io|Kraken|"); }
  // 按「解除綁定」跳出的確認框:模擬帳戶講下單設定清空 + 再綁從頭開始,不講金鑰;真實交易所照舊
  const warn = (venue, env, lang) => { let box = null; ctx.confirmBox = (o) => { box = o; }; ctx.trCloudBox = (o) => o;
    paint(venue, env, lang); vm.runInContext("trUnbind(null)", ctx); return { line: box && box.lines[0], tbl: vm.runInContext("STRINGS[LANG]", ctx) }; };
  const wcases = []; ["zh", "en"].forEach((lang) => ["local", "cloud"].forEach((env) => ["paper", "binance"].forEach((venue) => wcases.push({ lang, env, venue, w: warn(venue, env, lang) }))));
  const wKey = (c) => c.venue === "paper" ? "tr.unbindWarnPaper" : c.env === "cloud" ? "tr.cloud.unbindWarn" : "tr.unbindWarn";
  const b3 = wcases.filter((c) => !c.w.tbl[wKey(c)] || c.w.line !== c.w.tbl[wKey(c)]).map((c) => c.lang + "/" + c.env + "/" + c.venue);
  ok("解除綁定確認框:模擬帳戶用自己那句(下單設定清空、再綁從 100,000 USDT 重新開始、不提金鑰),真實交易所本機 / 雲端各自舊句" + (b3.length ? " ✗ " + b3 : ""), b3.length === 0
    && wcases.filter((c) => c.venue === "paper").every((c) => /100,000 USDT/.test(c.w.line) && !/金鑰|keys/.test(c.w.line))
    && wcases.filter((c) => c.venue !== "paper").every((c) => /金鑰|keys/.test(c.w.line))); }
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
    ok("S4 §1.1 ① 讀不到新狀態不給存:儲存鈕 disabled、儲存函式也擋", /sv\.disabled = anyBad\(\) \|\| stale \|\| cfgBad;/.test(tbl)
      && /if \(cloud && \(!\(S\.st && S\.st\.alive\) \|\| trCfgUnread\(trReport\(\)\)\)\) return;/.test(fnOf("trSaveAmounts")));
    ok("S4 §1.1 ② 雲端清單走 trCloudListOk(strategies_ok + 空清單有金額不算)", /C\.listLoaded = trCloudListOk\(C\.st && C\.st\.cloud && C\.st\.cloud\.strategies_ok, C\.list,/.test(tsrc) && !/C\.listLoaded = true/.test(tsrc));
    ok("#1 存檔走 trSendAmounts(依視角);④ 雲端送出前內容變了就換 request_id", /const sending = trSendAmounts\(S\.env, /.test(fnOf("trSaveAmounts"))
      && /if \(S\.reqFor\.amounts !== key\) delete S\.reqIds\.amounts;/.test(fnOf("trSaveAmounts")));
    ok("L3 雲端表下合計與確認框同口徑(看不見但照送的那幾支也算);讀不到設定時儲存函式也擋",
      /trTotals\(cloud \? trSendAmounts\("cloud", names, stored, TR\.edits, false\) : trCurrentAmounts/.test(tbl)
      && /if \(cloud && \(!\(S\.st && S\.st\.alive\) \|\| trCfgUnread\(trReport\(\)\)\)\) return;/.test(fnOf("trSaveAmounts")));
    { const css = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.css"), "utf8");
      const app = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.css"), "utf8");
      ok("spec-desktop-005 §2:雲端輸入框不再鋪灰底、不另設 placeholder 色——兩個視角同一個 --ink-3(灰底上 --ink-3 過不了 AA)",
        !/data-env="cloud"\][^{]*\.chat-input/.test(css) && !/data-env="cloud"\][^{]*\.chat-input/.test(app)
        && /\.chat-input textarea::placeholder \{ color: var\(--ink-3\); \}/.test(app) && !/\.ho-down/.test(css)); }
    { const tp = fnOf("trAmountTable");
      ok("稽核 005 #5 金額表:投資組合的標的欄與名稱下那一小行都寫 tr.nSyms、title 列資產;目標部位不上買賣色、不帶正負號、title 講多空合計",
        /pc = trPortfolioRow\(st, 0\)/.test(tp) && /const symText = pc \? t\("tr\.nSyms", \{ n: pc\.n \}\) : sym \|\| "—"/.test(tp)
        && /trEl\("span", "sub-sym" \+ \(pc \? "" : " mono"\), symText\); if \(symTip\) sub\.title = symTip;/.test(tp) && /const symTd = trEl\("td", "sym c-sym", symText\); if \(symTip\) symTd\.title = symTip;/.test(tp)
        && /v = pc \? trPortfolioRow\(st, a\)\.gross : a \* pos;/.test(tp) && /\(v === 0 \? "na" : pc \? "" : v > 0 \? "buy" : "sell"\)/.test(tp)
        && /if \(pc\) tgt\.title = t\("tr\.grossTip"\);/.test(tp) && /trMoneyInto\(tgt, v, !pc\)/.test(tp)); }
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
    const alertCalls = []; var trAlert = (...a) => alertCalls.push(a); var CDEL = { gone: new Map([["x", 1]]), busy: new Map([["y", {}]]), ids: { y: "R" } };
    eval(fnOf("trCloudOwnerCheck"));
    const ob = (ep, kind) => ({ epoch: 3, sent: { a: 1 }, sentRep: 5, save: "sent", saveErr: null, saveUnknownAt: 7, reqIds: { amounts: "R", halt: "H" }, reqFor: { amounts: "k" }, sig: {},
      st: { kind: kind || "running", cloud: { epoch: ep } } });
    let O = ob(3); trCloudOwnerCheck(O);
    ok("#8 同一個人:在途金額與 request_id 留著", O.sent !== null && O.reqIds.amounts === "R" && O.save === "sent");
    O = ob(4); trCloudOwnerCheck(O);
    ok("#8 換帳號(epoch 變了):sent / save / saveUnknownAt / reqIds 全清", O.sent === null && O.save === null && O.saveUnknownAt === 0 && J(O.reqIds) === "{}" && J(O.reqFor) === "{}" && O.epoch === 4);
    ok("M2 換帳號:上一個人的過場、在途那一趟、紅字也清(B 的暫停不會併進 A 那一趟)", (() => { const X = Object.assign(ob(9), { pending: { want: "running" }, sending: { halt: 1 } });
      trCloudOwnerCheck(X); return X.pending === null && J(X.sending) === "{}" && alertCalls.some((c) => c[0] === "" && c[2] === X); })());
    ok("換帳號也清雲端刪除的在途 / 壓抑 / request_id(上一個人的)", CDEL.gone.size === 0 && CDEL.busy.size === 0 && J(CDEL.ids) === "{}");
    O = ob(3, "signedOut"); trCloudOwnerCheck(O);
    ok("#8 登出:一樣全清", O.sent === null && J(O.reqIds) === "{}");
    ok("S4 §4 過了收斂窗口:request_id 換掉(再按是新的意圖)", C.reqIds.amounts === undefined && C.saveUnknownAt === 0); }
  /* ── 09-22 第三批 ── */
  { // 「暫停中…」整段真的停用(Wei 09-22 選 B;audit 2-4):ack 之後、結果不明都一樣,收斂或過了上限才恢復
    ok("暫停過場:ack 前後都停用;過了收斂上限 / 啟動過場 / 沒有過場 → 不停用",
      trHaltInFlight({ want: "halted", until: 2e12 }, 1e12) === true && trHaltInFlight({ want: "halted", acked: true, until: 2e12 }, 1e12) === true
      && trHaltInFlight({ want: "halted", until: 1e12 }, 2e12) === false && trHaltInFlight({ want: "running", until: 2e12 }, 1e12) === false && trHaltInFlight(null, 1) === false);
    const head = src.slice(src.indexOf("function trPaintHead("), src.indexOf("\nfunction ", src.indexOf("function trPaintHead(") + 1));
    ok("2-4 結果不明(ack 逾時)也還是停用,到收斂上限才放開", trHaltInFlight({ want: "halted", unknown: true, until: 2e12 }, 1e12) === true && trHaltInFlight({ want: "halted", unknown: true, until: 1e12 }, 2e12) === false);
    ok("主鈕在暫停在途時是 disabled 屬性(不是只有 aria-disabled),click 也擋;停用前先把焦點交給標題(不掉到 BODY)",
      /const busy = !!TR\.pending, flying = trHaltInFlight\(TR\.pending, Date\.now\(\)\);/.test(head) && /\|\| flying;\n\s*b\.setAttribute\("aria-disabled", locked \? "true" : "false"\)/.test(head)
      && /if \(flying && document\.activeElement === b\) \{ \$\("tr-h"\)\.focus\(\); TR\.focusParked = true; \}\s*b\.disabled = flying \|\| /.test(head)
      && /trHaltInFlight\(TR\.pending, Date\.now\(\)\)\) return;/.test(head) && /mine\.acked = true;/.test(src)); }
  { // 讀不到主機設定(config: null):trStored 不退成 {};兩個視角都不給存
    ok("config: null → trCfgUnread;config: {}(新機)→ 不算", trCfgUnread({ config: null }) === true && trCfgUnread({ config: {} }) === false);
    const stor = src.slice(src.indexOf("function trStored("), src.indexOf("\nfunction ", src.indexOf("function trStored(") + 1));
    eval(stor.replace("function trStored(", "var trStored = function (") );
    var trReport = () => REP; let REP = { config: null };
    ok("trStored:config null → null(不可退成 {});{} → {};有 amounts → 那一份", trStored() === null && ((REP = { config: {} }), JSON.stringify(trStored())) === "{}" && ((REP = { config: { amounts: { a: 1 } } }), trStored().a === 1));
    ok("讀不到設定:存檔函式兩個視角都擋、金額表整張不畫(畫 0 是假話)", /if \(!stored \|\| trStored\(\) === null \|\| trCfgUnread\(trReport\(\)\)\) return;/.test(src)
      && /else if \(stored === null\) \{[\s\S]{0,200}t\("tr\.cfgNull"\)/.test(src) && /const cfgBad = trCfgUnread\(trReport\(\)\);/.test(src)); }
  { // 主機重開後對帳器停著(reconciler.stopped.reason === "machine_restart"):「已暫停」,不是「死了」;原因行帶出口
    const V2 = { paper: { credentials: true, pair: true, order: true, account: true } };
    const rs = { alive: true, report: { venues: V2, halt: { halted: false }, reconciler: { alive: false, stopped: { reason: "machine_restart", at: 1 } } } };
    ok("machine_restart → halted(按鈕是「啟動下單」);其他原因停的照舊是 dead", trExecState(rs) === "halted" && trRestartStopped(rs.report)
      && trExecState({ alive: true, report: { venues: V2, halt: {}, reconciler: { alive: false, stopped: { reason: "other" } } } }) === "dead"
      && trExecState({ alive: true, report: { venues: V2, halt: {}, reconciler: { alive: false, stopped: null } } }) === "dead");
    // 定稿(eval-downtime-behavior-unified):已暫停一律帶原因行;重開那條優先、墨色;HALT 那條次要灰;常駐不截斷
    const stx = src.slice(src.indexOf("function trStateText("), src.indexOf("\nfunction ", src.indexOf("function trStateText(") + 1));
    ok("狀態行:重開(主機 / Blave)講 B、HALT 講 A,兩者同時講 B", /\+ trHaltReasonText\(r, TR\.acctDone\); \}/.test(stx) && /return rk === "machine" \? t\(z \? "tr\.cloud\.restartStoppedZ" : "tr\.cloud\.restartStopped"\)\n\s*: rk === "app" \? t\(z \? \(H && trSelfOrdering\(r\) \? "tr\.restartStoppedLocalZH" : "tr\.restartStoppedLocalZ"\) : "tr\.restartStoppedLocal"\)\n\s*: trHaltStopsAll\(r && r\.halt\) \? \(trRestartUnconfirmed\(r\) \? t\("tr\.cloud\.haltReasonUnconfirmed"\) : t\(z \? "tr\.haltReasonAllZ" : "tr\.haltReasonAll"\)\) : t\("tr\.haltReason"\);/.test(src)
      && /\|\| died \|\| state === "halted" \|\| state === "unconfirmed" \|\| trNoAmounts\(trReport\(\)\) \|\| \(state === "noaccount" && trNoAccountStopped\(trReport\(\)\)\)\);/.test(src) && /else if \(inkAt > 0\) tx\.append\(full\.slice\(0, inkAt\), trEl\("span", "ink", inkReason\), full\.slice\(inkAt \+ inkReason\.length\)\);/.test(src) && !/rkCut/.test(src));
    const Vp = { paper: { credentials: true, pair: true, order: true, account: true } };
    const reopened = { alive: true, report: { venues: Vp, halt: {}, reconciler: { alive: false, heartbeat_at: 100 }, daemon: { reconciler: { running: false, wanted: false } } } };
    const never = { alive: true, report: { venues: Vp, halt: {}, reconciler: { alive: false, heartbeat_at: null }, daemon: { reconciler: { running: false, wanted: false } } } };
    ok("Blave 結束再打開(上次跑過)= 已暫停(app);從沒跑過 = 尚未啟動(dead);對帳器自己掛了(wanted)= dead",
      trRestartKind(reopened.report) === "app" && trExecState(reopened) === "halted" && trRestartKind(never.report) === null && trExecState(never) === "dead"
      && trExecState({ alive: true, report: { venues: Vp, halt: {}, reconciler: { alive: false, heartbeat_at: 100 }, daemon: { reconciler: { running: false, wanted: true } } } }) === "dead"
      && trExecState({ ...reopened, alive: false }) === "dead");
    { // 稽核第三輪測試洞:HALT + 結束 app 再打開 → 判成 "app",狀態行用 tr.restartStoppedLocal(不是 HALT 那條)
      const haltApp = { alive: true, report: { venues: Vp, config: { amounts: { a: 100 } }, halt: { halted: true, at: 1, source: "desktop ui" }, reconciler: { alive: false, heartbeat_at: 100 }, daemon: { reconciler: { running: false, wanted: false } } } };
      const fn2 = (n) => src.slice(src.indexOf("function " + n + "("), src.indexOf("\nfunction ", src.indexOf("function " + n + "(") + 1));
      var TR = { env: "local", st: haltApp, pending: null }, trReport = () => TR.st.report, t = (k) => k, trStamp = () => "—", envHeadWord = () => null, trKeyBad = () => false;
      eval(fn2("trStateText")); eval(fn2("trHaltReasonText"));
      ok("HALT + Blave 結束再打開:kind = app、狀態 halted、狀態行是 Blave 重開那條(不是 HALT 的「平倉照常」)",
        trRestartKind(haltApp.report) === "app" && trExecState(haltApp) === "halted" && trStateText("halted") === "tr.halted · tr.restartStoppedLocal"); }
    ok("主機重開 + 已按過暫停:講重開那條(kind = machine 優先)", trRestartKind({ halt: { halted: true }, reconciler: { stopped: { reason: "machine_restart" } } }) === "machine");
    ok("啟動框:重開過才多那一行(主機 / Blave 各一句),HALT 後再啟動不加", /lines: \(trRestartKind\(r\) === "machine" \? \[t\("tr\.cloud\.restartStartLine"\)\] : trRestartKind\(r\) === "app" \? \[t\("tr\.restartStartLineLocal"\)\] : \[\]\)/.test(src));
    { /* Wei 0.0.6:這台電腦沒有「自己下單」的策略程式時,「解除暫停」與「包含你自己的策略程式下的單」都在講一顆不存在的東西。
         主行程掃 strategies/<name>/*.py 是否 import lib.order_* / lib.execute,寫進 report.selfOrdering;renderer 只認嚴格 === false(雲端 / 舊格式沒欄位照現行) */
      const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
      const cutM = (n) => { const i = mainSrc.indexOf("function " + n + "("); let d = 0; for (let k = mainSrc.indexOf("{", i); k < mainSrc.length; k++) { if (mainSrc[k] === "{") d++; else if (mainSrc[k] === "}" && --d === 0) return mainSrc.slice(i, k + 1); } throw new Error("no " + n); };
      eval(mainSrc.match(/const SELF_ORDER_RE = [^\n]*\n/)[0].replace(/^const /, "var ") + cutM("stratSelfOrdering"));
      const tplA = fs.readFileSync(path.join(__dirname, "..", "strategies", "TEMPLATE_A.py"), "utf8"), tplC = fs.readFileSync(path.join(__dirname, "..", "strategies", "TEMPLATE_C.py"), "utf8");
      ok("偵測:Type A / C 範本(lib.runner / lib.data)不算自己下單;lib.order_* / lib.execute 的各種 import 與點呼叫都算;註解裡的不算、execute_helper 不算、空檔不算",
        !stratSelfOrdering(tplA) && !stratSelfOrdering(tplC) && !stratSelfOrdering("from lib.data import fetch_kline\nfrom lib.runner import run\nfrom lib.notify import make_sender\n")
        && stratSelfOrdering("from lib.order_binance import open_position\n") && stratSelfOrdering("import lib.execute\n") && stratSelfOrdering("from lib import data, order_okx\n")
        && stratSelfOrdering("import lib\nlib.execute.run_twap(x)\n") && stratSelfOrdering("from lib.execute import run_twap\n") && stratSelfOrdering("from lib import execute\n")
        && !stratSelfOrdering("# from lib.order_binance import open_position\nfrom lib.data import fetch_kline  # lib.execute.\n") && !stratSelfOrdering("from lib import execute_helper\n") && !stratSelfOrdering("") && !stratSelfOrdering(null));
      ok("偵測:black 排的多行 import(括號換行、每項一行帶註解)與 `\\` 續行都收成一行後對得到;括號裡只有 data 的不算",
        stratSelfOrdering("from lib import (\n    data,\n    execute,  # twap\n)\n") && stratSelfOrdering("from lib.order_bybit import (\n    open_position,\n    close_position,\n)\n")
        && stratSelfOrdering("from lib import data, \\\n    order_gateio\n") && stratSelfOrdering("from lib \\\n    import execute\n")
        && !stratSelfOrdering("from lib import (\n    data,\n    runner,\n)\n") && !stratSelfOrdering("from lib import (\n    data,  # execute later\n)\n"));
      ok("掃資料夾:讀不到的檔當「有」、而且不快取(偏向藏鈕會把 Type B 用戶的出口藏掉)", /try \{ code = fs\.readFileSync\(p, "utf8"\); \} catch \(_\) \{ return true; \}/.test(cutM("stratSelfOrderingAny"))
        && /const hit = stratSelfOrdering\(code\);\s*selfOrdCache\.set\(p, \{ mtime, hit \}\);/.test(cutM("stratSelfOrderingAny")));
      const appR = (o) => ({ venues: Vp, config: { amounts: {} }, halt: { halted: true, at: 1, source: "desktop ui" }, reconciler: { alive: false, heartbeat_at: 100 }, daemon: { reconciler: { running: false, wanted: false } }, ...o });
      const has = appR({ selfOrdering: true }), none = appR({ selfOrdering: false }), old = appR({});
      ok("有自己下單的策略 / 沒欄位(雲端、舊格式):照現行——解除暫停照出、原因行叫人按它、狀態行講 ZH(包含你自己的策略程式下的單)",
        [has, old].every((r) => trExecState({ alive: true, report: r }) === "halted" && J(trZView("halted", r)) === J({ off: true, release: true, reason: "tr.startOffNoAmtRelease" }) && trHaltReasonText(r, null) === "tr.restartStoppedLocalZH"));
      ok("沒有自己下單的策略(selfOrdering === false):沒有解除暫停、原因行是 Z 那句、狀態行只剩「Blave 重開過,下單程式沒在跑」;單純 HALT(沒重開)也不出解除暫停",
        J(trZView("halted", none)) === J({ off: true, release: false, reason: "tr.startOffNoAmt" }) && trHaltReasonText(none, null) === "tr.restartStoppedLocalZ"
        && J(trZView("halted", appR({ selfOrdering: false, reconciler: { alive: true }, daemon: { reconciler: { running: true } } }))) === J({ off: true, release: false, reason: "tr.startOffNoAmt" }));
      ok("嚴格 === false:null / 0 / 字串都照現行;帳戶確認那一題與有金額(非 Z)的句子不受影響", trZView("halted", appR({ selfOrdering: null })).release === true && trZView("halted", appR({ selfOrdering: 0 })).release === true
        && trHaltReasonText(appR({ selfOrdering: false, account_guard: { book_hold: { venue: "binance", reason: "x", since: 1 } } }), null) === "tr.acct.reason"
        && trHaltReasonText(appR({ selfOrdering: false, config: { amounts: { a: 100 } } }), null) === "tr.restartStoppedLocal");
      ok("接線:主行程在 trade-status 把 selfOrdering 掛進報告(掃整個策略資料夾、按 mtime 快取);雲端那條路沒有這個欄位",
        /handle\("trade-status", \(\) => \{ const st = tradeHost\(\)\.status\(\); if \(st\.report && typeof st\.report === "object"\) st\.report\.selfOrdering = stratSelfOrderingAny\(\); return st; \}\);/.test(mainSrc)
        && /selfOrdCache\.get\(p\)/.test(mainSrc) && /files = fs\.readdirSync\(dir\)\.filter\(\(f\) => f\.endsWith\("\.py"\)\)/.test(mainSrc)
        && !/selfOrdering/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "cloud.js"), "utf8")));
      // 偵測用的 regex 是自己一個常數,不准黏到別的白名單上(0.0.7 開發中一次誤替換把它接到 SAFE_ID 後面:任何含「from lib import execute」的字都過得了 id 檢查)
      const safeLine = mainSrc.match(/^const SAFE_ID = ([^\n]*);$/m);
      ok("SAFE_ID 還是原本那條 id 白名單(逐字),拒收空白 / 換行 / 夾著 import 的字;SELF_ORDER_RE 單獨一行", !!safeLine && safeLine[1] === "/^[A-Za-z0-9][\\w.:\\/-]{0,127}$/"
        && (() => { const re = eval(safeLine[1]); return re.test("abc-1.2:x") && !re.test("a b") && !re.test("a\nb") && !re.test("from lib import execute") && !re.test("x|from lib import execute"); })()
        && (mainSrc.match(/^const SELF_ORDER_RE = /gm) || []).length === 1 && (mainSrc.match(/from\\s\+lib\\s\+import/g) || []).length === 1); } }
  { // S5 已存到、等回報:3 分鐘沒回報就換成「主機沒回報」、鈕還回來(畫面不倒數)
    const at = 1e12, sv = { venue: "binance", at };
    ok("S5 等回報:3 分鐘前不換、到 3 分鐘換;沒存過 / 沒有時間不換", trCxSavedStale(sv, at + 179999) === false && trCxSavedStale(sv, at + 180000) === true
      && trCxSavedStale(null, at + 1e9) === false && trCxSavedStale({ venue: "paper" }, at + 1e9) === false && TR_CX_SAVED_MS === 180000);
    const ob = src.slice(src.indexOf("function trPaintOnboard("), src.indexOf("\nfunction ", src.indexOf("function trPaintOnboard(") + 1));
    ok("S5 過了上限:講「主機沒回報」+ 連接鈕回來;重畫簽章帶著這個狀態(輪詢到了才換得過去);沒有倒數", /savedStale = trCxSavedStale\(saved, Date\.now\(\)\)/.test(ob)
      && /saved && \[saved\.venue, saved\.code, saved\.detail\], savedStale,/.test(ob) && /if \(saved && savedStale\) \{[\s\S]*?t\(saved\.venue === PAPER \? "tr\.cloud\.cxSavedStalePaper" : "tr\.cloud\.cxSavedStale"\)[\s\S]*?b\.id = "tr-connect"/.test(ob) && !/秒|countdown|remaining/.test(ob.replace(/\/\*[\s\S]*?\*\//g, ""))); }
  { // spec-restart-gated-false-display:主機重開、沒能確認停住(stopped.gated === false 嚴格)
    const Vg = { paper: { credentials: true, pair: true, order: true, account: true } };
    const C0 = (o) => ({ alive: false, report: { venues: Vg, halt: {}, reconciler: { alive: false, stopped: { reason: "machine_restart", at: 1, ...o } } } });
    ok("gated:false 未暫停 → unconfirmed(不是 dead / halted / running);B 的原因行與重開啟動框那一行都帶不出來(kind 不是 machine)",
      trExecState(C0({ gated: false })) === "unconfirmed" && trRestartKind(C0({ gated: false }).report) === null && trRestartUnconfirmed(C0({ gated: false }).report));
    ok("gated:true 與缺欄位:照現行(已暫停 + B);只有嚴格的 false 才進(0 / null / 字串都不算)",
      trExecState(C0({ gated: true })) === "halted" && trExecState(C0({})) === "halted" && trRestartKind(C0({}).report) === "machine"
      && [0, null, "false", undefined].every((g) => !trRestartUnconfirmed(C0({ gated: g }).report)));
    const Ch = C0({ gated: false }); Ch.report.halt = { halted: true, at: 2, source: "web" };
    ok("gated:false 已按暫停 → halted,原因行是 A(舊對帳器認 HALT;B 的「什麼單都不下」是假話)", trExecState(Ch) === "halted" && trRestartKind(Ch.report) === null);
    ok("主鈕在 unconfirmed 是「暫停下單」那一側;已暫停之後也不給「啟動下單」", trStopSide("unconfirmed") === true
      && /: trStopSide\(state\) \|\| trRestartUnconfirmed\(trReport\(\)\) \? t\("tr\.stop"\) : t\("tr\.start"\);/.test(src));
    const fn3 = (n) => src.slice(src.indexOf("function " + n + "("), src.indexOf("\nfunction ", src.indexOf("function " + n + "(") + 1));
    var TR = { env: "cloud", st: C0({ gated: false }), pending: null }, trReport = () => TR.st.report, t = (k) => k, trStamp = () => "—", envHeadWord = () => null, trKeyBad = () => false;
    eval(fn3("trStateText")); eval(fn3("trShortState")); eval(fn3("trHaltReasonText"));
    ok("狀態行:可能仍在下單 + 紅字原因行;頂列短詞同一個詞;已按暫停後是「已暫停 · A」",
      trStateText("unconfirmed") === "tr.cloud.mayTrade · tr.cloud.restartUnconfirmed" && trShortState("unconfirmed") === "tr.cloud.mayTrade"
      && ((TR.st = Ch), trStateText("halted") === "tr.halted · tr.haltReason"));
    ok("紅字那一段包 .danger、不截斷;CSS 用 --color-redText", /trEl\("span", "danger", ucReason\)/.test(src)
      && /\.main-head-desc \.danger \{ color: var\(--color-redText\); \}/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.css"), "utf8")));
    { // 稽核 B3:讀帳失敗的前綴照樣接;B4:紅字只包原因那一句(前面有前綴、後面接「最後更新」都還是紅的)
      const Cf = C0({ gated: false }); Cf.report.account = { venues: { paper: { ok: false, error: "x" } } }; TR.st = Cf;   // 讀帳失敗 = trFailedIds 有東西
      ok("B3 unconfirmed + 讀帳失敗:狀態行也有「串接失敗 · 」前綴(同頂列短詞)", trStateText("unconfirmed") === "cx.failShort · tr.cloud.mayTrade · tr.cloud.restartUnconfirmed");
      TR.st = C0({ gated: false }); }
    const head = fn3("trPaintHead");
    ok("B4 紅字那一段用原因句本身定位(不要求 full === text):回報過舊接了「最後更新」、前面有「串接失敗」都還是紅",
      /const ucReason = state === "unconfirmed" \? t\("tr\.cloud\.restartUnconfirmed"\) : "", ucAt = ucReason \? full\.indexOf\(ucReason\) : -1;/.test(head)
      && /else if \(ucAt > 0\) tx\.append\(full\.slice\(0, ucAt\), trEl\("span", "danger", ucReason\), full\.slice\(ucAt \+ ucReason\.length\)\);/.test(head) && !/ucCut/.test(head));
    ok("B1 存金額確認框:unconfirmed 也算在下單(出「雲端正在下單」那一行,不講「沒有在下單、按啟動下單」)",
      /const live = cloud && \(trExecState\(S\.st\) === "running" \|\| trExecState\(S\.st\) === "unconfirmed"\);/.test(fn3("trSaveAmounts")));
    ok("B2 部位表底的下單失敗:unconfirmed 也是紅字的現在式(不降成灰的「上次」)", /if \(trErrLoud\(le, hs, TR\.startAt, r\.last_reconcile\)\) frag\.appendChild\(trEl\("div", "pf-foot err"/.test(src)
      && trErrLoud({ ts: "2026-09-21T14:26:00" }, "unconfirmed", 0, { ts: "2026-09-21T14:25:59" }) === true && trErrLoud({ ts: "2026-09-21T14:26:00" }, "halted", 0, null) === false);
    ok("不亮綠點:切換器那一格只在 running 才亮(unconfirmed 不借用 running)", /out\.run = state === "running" && /.test(src) && trExecState(C0({ gated: false })) !== "running"); }
  { // 事件清單補兩種
    const ev = src.slice(src.indexOf("const TR_DT_ACTION"), src.indexOf("function trOvEvents("));
    var trVenueLabel = (x) => x, t = (k, v) => k + (v ? JSON.stringify(v) : "");
    eval(ev.replace("const TR_DT_ACTION", "var TR_DT_ACTION"));
    ok("S4 machine_restart_stop_failed 事件:同網頁那一列(可能沒停住;先暫停、再更新)", J(trEventText("machine_restart_stop_failed", {})) === J(["tr.ov.evRestartStopFailed", "tr.ov.evRestartStopFailedNote"]));
    ok("machine_restart_stopped 事件:標題已暫停、說明講平倉停損也不會執行", J(trEventText("machine_restart_stopped", {})) === J(["tr.ov.evRestartStopped", "tr.ov.evRestartStoppedNote"]));
    ok("desktop_action update / delete_strategy 有自己的一句", trEventText("desktop_action", { action: "update" })[0] === "tr.ov.evDtUpdate" && trEventText("desktop_action", { action: "delete_strategy" })[0] === "tr.ov.evDtDeleteStrategy");
    const mc = trEventText("manual_close_required", { exchange: "capital", symbols: "TMF, TXF", reason: "x" }), mc0 = trEventText("manual_close_required", { symbols: "" });
    ok("manual_close_required:帶標的時接在後面;symbols 空字串只講那一句;註解同網頁", mc[0] === "tr.ov.evManualClose · TMF, TXF" && mc[1] === "tr.ov.evManualCloseNote" && mc0[0] === "tr.ov.evManualClose"); }
  { // 設計稽核可後修 §3-1:雲端的投資組合策略那句講真話;L3:框開著時變成讀不到設定 → 送出前再擋一次;L2:=absent 講明
    ok("雲端沒撥過款的投資組合策略:講「第一筆在網頁設定」,本機維持 tr.typeC", /if \(locked\) first\.appendChild\(trEl\("span", "pf-note", cloud \? t\("tr\.cloud\.typeC"\) : t\("tr\.typeC"\)\)\);/.test(src));
    const save = src.slice(src.indexOf("function trSaveAmounts("), src.indexOf("\nfunction ", src.indexOf("function trSaveAmounts(") + 1));
    const gate = "if (trWith(S, () => trStored() === null || trCfgUnread(trReport())))";
    ok("L3 存金額:確認框按下之後、送出之前再查一次設定讀不讀得到", save.indexOf(gate) > save.indexOf("onOk: async () => {") && save.indexOf(gate) < save.indexOf('trSend(S, "amounts"'));
    const run = src.slice(src.indexOf("async function cdelRun("), src.indexOf("\nfunction cdelBoth"));
    ok("L2 刪除回 =absent:不當成刪掉了(不壓抑列),講「主機上本來就沒有」", /if \(res && res\.ok && \/=absent\$\/\.test\(String\(res\.result \|\| ""\)\)\) \{/.test(run)
      && run.indexOf("=absent") < run.indexOf("CDEL.gone.set(") && /t\("cdel\.absent"\)/.test(run)); }
  { const css = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.css"), "utf8"), acss = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.css"), "utf8");
    ok("設計稽核必修:灰記號真的是灰的;設定窗與確認框有字型(掛在 html, body,不只 .app);關於的小點已拿掉(spec-desktop-settings-cleanup §1-1)",
      /\.verdict\.is-calm \.fault-mark \{ background: var\(--ink-3\); \}/.test(css) && /html, body \{[^}]*font-family: -apple-system/.test(acss)
      && !/\.up-dot/.test(acss));
    ok("設計稽核(版面):框標題一律貼左、確認框與連接框的腳都換行(目的地那一行獨占一列)、文字鈕停用灰階退場、關於那顆本機鈕對齊、.app 不重複宣告字型",
      /\.modal-head > h6 \{ margin-right: auto; \}/.test(acss) && /\.del-modal \.modal-foot, \.cx-modal \.modal-foot \{ flex-wrap: wrap; \}/.test(acss)
      && /\.btn-quiet:disabled, \.btn-quiet:disabled:hover \{ color: var\(--color-greyDark\); cursor: not-allowed; text-decoration: none; \}/.test(acss)
      && /\.set-up-lbtn \{ margin-top: var\(--space-6\); \}/.test(acss) && /\.btn-quiet \{\n  flex: none; padding: 0;/.test(acss) && !/\.app \{[^}]*font-family/.test(acss) && !/\.set-about \.st\.bad|\.up-cf/.test(acss)
      && /#strat-list-cloud \.strat-wrap:is\(:hover, :has\(:focus-visible\)\) \.strat-row \{ padding-right: calc\(var\(--space-32\) \+ var\(--space-8\)\); \}/.test(css));
    { const en = fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", "en.po"), "utf8");
      ok("停機那幾句 en 用彎撇號(同檔其他句)", ["tr.cloud.restartStopped", "tr.restartStoppedLocal", "tr.ov.evRestartStoppedNote", "tm.evRestartStoppedNote", "tr.cloud.means.4"]
        .every((k) => { const m = en.match(new RegExp('msgid "' + k.replace(/\./g, "\\.") + '"\\nmsgstr "([^\\n]*)"')); return m && !/'/.test(m[1]) && /’/.test(m[1]); })); }
    ok("「暫停下單」文字鈕:--ink-2、熱區跟主鈕等高", /\.main-head \.tr-go-stop \{ color: var\(--ink-2\); min-height: 32px;/.test(css)); }
  { // S5 雲端連接的結果句(MVP 不查提領:沒有提領那一句)
    var CXF = { env: "cloud" }, cxCloudIp = () => "1.2.3.4", trSendError = (r) => (r.machineState === "stopped" ? "" : "send:" + r.error);
    eval(src.slice(src.indexOf("function cxChkTextCloud("), src.indexOf("const cxCalm")));
    const T = (code, detail) => cxChkTextCloud({ code, detail: detail || {} });
    ok("S5 每個代號一句;時鐘 / 網路 / 限速三種用雲端版", T("CLOCK") === "cx.chk.clockCloud" && T("NETWORK") === "cx.chk.networkCloud" && T("RATE_LIMITED") === "cx.chk.rateCloud"
      && T("RATE_BANNED") === "cx.chk.bannedCloud" && T("RATE_BACKOFF") === "cx.chk.backoffCloud" && T("IP_OR_KEY") === "cx.chk.ipOrKey" && T("INCOMPLETE_PAIR") === "cx.chk.incomplete" && T("TRADING_DISABLED") === "cx.chk.trading");
    ok("S5 沒有提領那一句;拒絕原文截 200、結果不明不叫人重按、主機停了講停機", !/withdraw/.test(src.slice(src.indexOf("function cxChkTextCloud("), src.indexOf("const cxCalm")))
      && T("REJECTED", { error: "z".repeat(300) }) === 'tr.cloud.cmdRejected{"err":"' + "z".repeat(200) + '"}' && T("CMD_UNKNOWN") === "tr.cloud.cxUnknown"
      && T("UNDELIVERED", { error: "MACHINE_NOT_RUNNING", machineState: "stopped" }) === "side.stopped" && T("UNDELIVERED", { error: "RATE_LIMITED" }) === "send:RATE_LIMITED"); }
  var fnS = (n) => src.slice(src.indexOf("function " + n + "("), src.indexOf("\nfunction ", src.indexOf("function " + n + "(") + 1));
  { // audit-trading-ux 1-2(A′):HALT 依 source 分支,規則同 api agent_event_copy
    ok("A′ 來源:portfolio / web / user / flatten / desktop 與缺欄位 = A;reconciler 與認不得的來源 = A′",
      ["portfolio", "web", "user", "flatten", "desktop"].every((x) => !trHaltStopsAll({ halted: true, source: x }))
      && [undefined, null, {}, { halted: true }, { halted: true, source: "" }, { halted: true, source: 7 }].every((h) => !trHaltStopsAll(h))
      && trHaltStopsAll({ halted: true, source: "reconciler" }) && trHaltStopsAll({ halted: true, source: "healthcheck" }));
    const Vh = { paper: { credentials: true, pair: true, order: true, account: true } };
    const H = (src, stopped) => ({ alive: true, report: { venues: Vh, config: { amounts: { a: 100 } }, halt: { halted: true, at: 3, source: src }, reconciler: { alive: true, ...(stopped ? { stopped } : {}) } } });
    TR.st = H("reconciler"); const aP = trStateText("halted"); TR.st = H("portfolio"); const pP = trStateText("halted");
    TR.st = H("reconciler", { reason: "machine_restart", at: 1 }); const bP = trStateText("halted");
    ok("A′ 狀態行:reconciler → 什麼單都不下;portfolio → A;重開(B)仍優先", aP === "tr.halted · tr.haltReasonAll" && pP === "tr.halted · tr.haltReason" && bP === "tr.halted · tr.cloud.restartStopped");
    const head = fnS("trPaintHead");
    ok("A′ / B / B0 的原因行升正文墨色,用原因句本身定位(前面有「串接失敗 · 」也照升)", /const inkReason = state === "halted" && \(trRestartKind\(hr\) \|\| trHaltStopsAll\(hr\.halt\) \|\| trAcctAsk\(hr\)\) \? trHaltReasonText\(hr, TR\.acctDone\) : state === "noaccount" && trNoAccountStopped\(hr\) \? t\("tr\.cloud\.restartNoAccountZ"\) : "";/.test(head)
      && /const inkAt = inkReason \? full\.indexOf\(inkReason\) : -1;/.test(head) && !/full === text && !trFailedIds/.test(head.slice(head.indexOf("const inkReason"))));
    ok("A′ 事件列:halt 列與 UI 補的 HALT 列都依 source 取重開那句說明", /note = trHaltStopsAll\(d\) \? t\("tr\.ov\.evRestartStoppedNote"\) : t\("tr\.ov\.evHaltNote"\);/.test(src)
      && /trHaltStopsAll\(halt\) \? t\("tr\.ov\.evRestartStoppedNote"\) : t\("tr\.ov\.evHaltNote"\)/.test(src)); }
  { // audit 2-1(B0):沒有交易所 + 重開停止
    const B0 = (o) => ({ alive: true, report: { venues: {}, halt: {}, reconciler: { alive: false, stopped: { reason: "machine_restart", at: 1, ...o } } } });
    ok("B0 判定:沒交易所 + 重開停著才算;gated:false、沒停、有交易所都不算", trNoAccountStopped(B0({}).report) && trNoAccountStopped(B0({ gated: true }).report)
      && !trNoAccountStopped(B0({ gated: false }).report) && !trNoAccountStopped({ venues: {}, halt: {}, reconciler: {} })
      && !trNoAccountStopped({ ...B0({}).report, venues: { paper: { credentials: true, pair: true, order: true, account: true } } }) && !trNoAccountStopped(null) && !trNoAccountStopped({ error: "x" }));
    TR.st = B0({}); const b0t = trStateText("noaccount"); TR.st = { alive: true, report: { venues: {}, halt: {}, reconciler: {} } }; const n0 = trStateText("noaccount");
    ok("B0 狀態行(v2 §9-1:一定是 Z):已暫停 · 按「解除暫停」那一句;一般 noaccount 照舊", b0t === "tr.halted · tr.cloud.restartNoAccountZ" && n0 === "tr.noAccount");
    const head = fnS("trPaintHead"), start = fnS("trAskStart"), pc = fnS("trPendingCheck");
    ok("B0(§12 / §13-1):不出「啟動下單」,只出**實心**的「解除暫停」;沒有原因行(出口寫在狀態句裡);onboard 照留", /const b0 = state === "noaccount" && trNoAccountStopped\(trReport\(\)\);\n\s*if \(!stopped && \(b0 \|\| state === "noaccount"[^\n]*\{ if \(b\) \{ if \(document\.activeElement === b\) \$\("tr-h"\)\.focus\(\); b\.remove\(\); \} trPaintGoStop\(false\); trPaintGoUpd\(false\); trPaintNoAmt\(pend\); trPaintGoRel\(b0, b0\); return; \}/.test(head)
      && /trEl\("button", trNoAccountStopped\(trReport\(\)\) \? "btn-out" : "btn-fill", t\("cx\.connect"\)\)/.test(src));
    ok("B0 啟動框與 b0Done 退場(沒有啟動鈕了);解除暫停一律 X0", !/restartNoAccountStart|b0Done/.test(src) && trReleaseKind({ ...B0({}).report, config: { amounts: {} }, self_ledger: true }).kind === "x0"
      && J(trZView("noaccount", B0({}).report)) === J({ off: true, release: true, reason: null, noStart: true }) && trZView("noaccount", { ...B0({}).report, config: { amounts: { a: 5 } } }).release); }
  { // 1-4 撤回(後端:Type A/C 重開停止期間照跑):啟動框的第二句不分 B
    ok("啟動框第二句:一般暫停 tr.startWarn2;Blave 重開 tr.startWarn2Local;主機重開(B)不出(新狀態稽核 1-2)", /const rkS = trRestartKind\(r\), warn2 = rkS === "app" \? t\("tr\.startWarn2Local"\) : rkS === "machine" \? null : t\("tr\.startWarn2"\);/.test(src)
      && /\.concat\(canWait \? \[t\("tr\.startChoice"\)\] : \[t\("tr\.startWarn1"\)\]\)\.concat\(warn2 \? \[warn2\] : \[\]\),/.test(src) && !/restartStartWarn2/.test(src)); }
  { // S1:C 裡沒有啟動鈕,框裡不能叫人「之後按啟動下單」
    ok("S1 C 的暫停框與存金額框:用不叫人按啟動的那兩句", /trRestartUnconfirmed\(r\) \? t\("tr\.cloud\.closeAllWarn2Unconfirmed"\) : t\("tr\.closeAllWarn2"\)/.test(src)
      && /const idle = cloud && trRestartUnconfirmed\(S\.st && S\.st\.report\) \? t\("tr\.cloud\.saveIdleUnconfirmed"\) : t\("tr\.cloud\.saveIdle"\);/.test(src)); }
  { // 2-2:C 期間標頭多一顆「立即更新到最新版本」(同聊天那一行的動作)
    const head = fnS("trPaintHead"), up = fnS("trPaintGoUpd");
    ok("2-2 C 才出、其他態收掉;點了走 upGo;回合在跑停用並講 up.busy", /trPaintGoUpd\(ro && trRestartUnconfirmed\(trReport\(\)\)\);/.test(head) && (head.match(/trPaintGoUpd\(false\)/g) || []).length === 2
      && /"btn-quiet tr-go-upd"/.test(up) && /if \(typeof upGo === "function" && trUpdAct\(\) === "cloud"\) \{ upGo\(\); trPaintGoUpd\(true\); \}/.test(up) && /const why = busy \? t\("up\.busy"\) : act === "cloud" \? "" : plan && plan\.cloud && plan\.cloud\.updating \? t\("up\.updating"\)\n\s*: envCloudKind\(TR\.st\) === "stopped" \? t\("up\.c\.stopped"\) : t\("up\.c\.unreach"\);/.test(up)
      && /u\.disabled = !!why; u\.title = why;/.test(up)
      && /if \(why && document\.activeElement === u\) \{ \$\("tr-h"\)\.focus\(\); TR\.updParked = true; \}/.test(up)
      && /if \(!why && TR\.updParked\) \{ TR\.updParked = false; const ae = document\.activeElement; if \(!ae \|\| ae === document\.body \|\| ae === \$\("tr-h"\)\) u\.focus\(\); \}/.test(up)
      && /if \(!on\) \{ if \(u\) \{ if \(document\.activeElement === u\) \$\("tr-h"\)\.focus\(\); u\.remove\(\); \} TR\.updParked = false; return; \}/.test(up)
      && /function trUpdAct\(plan\) \{ const p = plan \|\| \(typeof upNow === "function" \? upNow\(\) : null\); return \(\(p && p\.btn\) \|\| \{\}\)\.act \|\| null; \}/.test(src)
      && /\$\("tr-desc"\)\.after\(u\); \}/.test(up) && !/tr-act"\)\.appendChild\(u\)/.test(up) && /\.main-head \.tr-go-upd \{ display: block; margin-top: var\(--space-4\); min-height: 32px; color: var\(--ink-2\); text-align: left; \}/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.css"), "utf8"))); }
  { // 總覽曲線(Wei 09-22):沒紀錄的時段直接連起來;累積損益照雲端 drawOvPnl 零上綠、零下紅、0 是水位線
    const segs = trPnlSegments([{ t: 0, v: 10 }, { t: 10, v: 30 }, { t: 20, v: -10 }, { t: 30, v: -20 }, { t: 40, v: 0 }]);
    const near = (x, y) => Math.abs(x - y) < 1e-9;
    ok("PnL 線段:同側一段一色(>= 0 綠);跨 0 在內插的交越點切開、兩半各取各的色(落在 0 算跨,同 drawOvPnl 切出零長的一段)", segs.length === 6
      && segs[0].pos && segs[0].t0 === 0 && segs[0].t1 === 10
      && segs[1].pos && segs[1].t0 === 10 && near(segs[1].t1, 17.5) && segs[1].v1 === 0 && segs[1].cut1
      && !segs[2].pos && near(segs[2].t0, 17.5) && segs[2].v0 === 0 && segs[2].cut0 && segs[2].t1 === 20
      && !segs[3].pos && !segs[4].pos && segs[4].t1 === 40 && segs[4].v1 === 0 && segs[4].cut1 && segs[5].pos && segs[5].t0 === 40 && segs[5].t1 === 40
      && trPnlSegments([{ t: 0, v: 5 }]).length === 0 && trPnlSegments([]).length === 0);
    ok("PnL 線段:時間差再大也照連(沒有缺口規則)", trPnlSegments([{ t: 0, v: 1 }, { t: 1e6, v: 2 }]).length === 1);
    const draw = fnS("trDrawCurve"), curve = fnS("trOvCurve");
    ok("曲線不斷線:畫圖不看 TR_GAP_S、沒有孤立點;圖下那句照講沒紀錄", !/TR_GAP_S|arc\(/.test(draw) && /t\("tr\.ov\.gapNote"\)/.test(curve)
      && /if \(!isPnl\) \{[\s\S]*?trToken\("--color-data-1"\)[\s\S]*?return;\n\s*\}/.test(draw));
    ok("PnL 照 drawOvPnl:0 的虛線 [3,4] greyMedium、綠 greenText / 紅 redText、線寬 1.5 圓角;不寫死 hex",
      /ctx\.setLineDash\(\[3, 4\]\); ctx\.strokeStyle = trToken\("--color-greyMedium"\);/.test(draw) && /const zy = Math\.round\(yAt\(0\)\) \+ 0\.5;/.test(draw)
      && /const G = trToken\("--color-greenText"\), Rd = trToken\("--color-redText"\);/.test(draw) && /ctx\.strokeStyle = sg\.pos \? G : Rd;/.test(draw)
      && /ctx\.lineWidth = 1\.5; ctx\.lineJoin = "round"; ctx\.lineCap = "round";/.test(draw) && !/#[0-9a-fA-F]{3,8}\b/.test(draw)); }
  { // 文字:po 兩語
    const po = (l) => fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", l + ".po"), "utf8");
    const get = (l, k) => { const m = po(l).match(new RegExp('msgid "' + k.replace(/\./g, "\\.") + '"\\nmsgstr "([^\\n]*)"')); return m ? m[1] : null; };
    ok("曲線說明講真話(不再說斷開的地方)", get("zh", "tr.ov.gapNote") === "Blave 沒開著的時段沒有紀錄，曲線直接連起來。" && /connects straight across/.test(get("en", "tr.ov.gapNote")) && !/斷開/.test(get("zh", "tr.ov.gapNote")));
    ok("A′ / B0 / S1 文字照稽核;事件兩句 note 同網頁語序", /^什麼單都不下——平倉與停損也不會執行。/.test(get("zh", "tr.haltReasonAll")) && /^No orders are going out — exits and stops won’t run either\./.test(get("en", "tr.haltReasonAll"))
      && /^主機重開過，什麼單都不下/.test(get("zh", "tr.cloud.restartNoAccountZ")) && get("zh", "tr.cloud.restartNoAccountStart") === null && get("zh", "tr.cloud.restartNoAccount") === null
      && get("zh", "tr.ov.evHaltNote") === "平倉與停損停利照常執行；停開新倉" && get("zh", "tr.ov.evRestartStoppedNote") === "平倉與停損不會執行；什麼單都不下"
      && /更新到最新版本、再按「啟動下單」/.test(get("zh", "tr.cloud.closeAllWarn2Unconfirmed")) && /^雲端已暫停：.*更新到最新版本、再按「啟動下單」/.test(get("zh", "tr.cloud.saveIdleUnconfirmed"))
      && /after you update to the latest version and press Start trading/.test(get("en", "tr.cloud.closeAllWarn2Unconfirmed")) && /after you update to the latest version and press Start trading/.test(get("en", "tr.cloud.saveIdleUnconfirmed"))
      && get("en", "tr.cloud.restartStartWarn2") === null && get("zh", "tr.cloud.restartStartWarn2") === null);
    ok("側欄「已停」→「已暫停」;設定的雲端舊版那句照稽核", get("zh", "side.cloud.st.halted") === "已暫停" && get("en", "side.cloud.st.halted") === "Paused"
      && get("zh", "up.c.needsUpdate") === "雲端的下單程式是舊版，主機重開後沒能確認它停下，需要更新。");
    const en = po("en").split("\n").filter((l) => l.startsWith("msgstr ")).join("\n");
    // Title Case 撤回(web 已回 sentence case,兩邊要一致;Title Case 另開一批)。唯一留著的是 HEAD 本來就有的 tr.cloud.means.2
    ok("EN 鈕名維持 sentence case(同網頁):鈕字是小寫那一版,新句子引用鈕名也是", get("en", "tr.stop") === "Pause trading" && get("en", "tr.start") === "Start trading"
      && get("en", "tr.stopFlat") === "Pause and close positions" && get("en", "tr.startCatchUp") === "Start and catch up positions" && get("en", "up.chat") === "Update to the latest version now" && get("en", "cx.connect") === "Connect an exchange"
      && ["Start Trading", "Update to the Latest Version Now", "Pause and Close Positions", "Catch Up Positions", "Wait for New Signals", "Connect an Exchange"].every((x) => en.indexOf(x) < 0)
      && (en.match(/Pause Trading/g) || []).length === 1 && /Press Pause trading first, then Update to the latest version now\./.test(get("en", "tr.cloud.restartUnconfirmed"))
      && !/Pause Trading \(keep|Press Start Trading/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"))); }
  { // 重開停著、策略還沒用開機後的資料算完(stopped.recomputed === false):鎖「補齊部位」,「等新訊號」照給
    const SR = (o) => ({ reconciler: { stopped: { reason: "machine_restart", at: 1, ...o } } });
    ok("recomputed:只有嚴格的 false 才鎖;true / 缺欄位(舊 runtime)/ 沒有 stopped 都不鎖", trRecomputing(SR({ recomputed: false })) && !trRecomputing(SR({ recomputed: true }))
      && !trRecomputing(SR({})) && [0, null, "false", undefined].every((x) => !trRecomputing(SR({ recomputed: x }))) && !trRecomputing({ reconciler: {} }) && !trRecomputing(null));
    const start = fnS("trAskStart");
    ok("recomputed 啟動框:補齊那顆 okDisabled、多一行說明(接在重開那行後面);等新訊號的 alt 不動;按下去再查一次",
      /const recomputing = trRecomputing\(r\);/.test(start) && /\.concat\(recomputing \? \[t\("tr\.cloud\.recomputing"\)\] : \[\]\)/.test(start)
      && start.indexOf('t("tr.cloud.restartStartLine")') < start.indexOf('t("tr.cloud.recomputing")')
      && /ok: t\("tr\.startCatchUp"\), okDisabled: recomputing, okWhy: recomputing \? t\("tr\.cloud\.recomputing"\) : null, onOk: \(\) => \{ if \(!trRecomputing\(trReport\(\)\)\) go\("resume"\); \},/.test(start)
      && /alt: canWait \? \{ label: t\("tr\.startWait"\), onOk: \(\) => go\("resume_wait"\) \} : null,/.test(start)
      && start.indexOf("trNoAccountStopped(r)") < start.indexOf("const recomputing"));
    const po = (l) => fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", l + ".po"), "utf8");
    ok("recomputed 文字(zh / en)", /msgid "tr\.cloud\.recomputing"\nmsgstr "策略正在用開機後的資料重算，算完才能補齊部位；算完後關掉這個框再開一次。"/.test(po("zh"))
      && /msgid "tr\.cloud\.recomputing"\nmsgstr "Strategies are recomputing on post-restart data\. Catch up becomes available when they finish; close this box and open it again then\."/.test(po("en"))); }
  { // round-2 稽核 B1(列舉):C(主機重開、沒能確認停住)裡沒有啟動鈕——看得到的狀態字一個都不可以叫人按「啟動下單」
    //   每一種 C 子狀態 × zh / en,用真的字串表畫:未暫停、已暫停 × 每一類 halt.source(白名單 / 自動 / 認不得 / 缺欄位)、讀帳失敗、回報過舊
    const vm = require("vm"), R = path.join(__dirname, "..", "shell", "renderer");
    const cutB = (x, y) => src.slice(src.indexOf(x), src.indexOf(y));
    const fnC = (n) => src.slice(src.indexOf("function " + n + "("), src.indexOf("\nfunction ", src.indexOf("function " + n + "(") + 1));
    const ctx = { LANG: "zh", Date, Math, Object, Array, String, Number, JSON, isFinite, isNaN, Set, Map };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(R, "strings.js"), "utf8").replace(/^const /gm, "var ") + "\n" + fs.readFileSync(path.join(R, "i18n.js"), "utf8").replace(/^(const|let) /gm, "var "), ctx);
    vm.runInContext((cutB("/* ── 純邏輯(", "/* ── 純邏輯到此") + cutB("/* ── 視角純邏輯(", "/* ── 視角純邏輯到此")).replace(/^const /gm, "var "), ctx);
    vm.runInContext(fnC("trStateText") + fnC("trShortState") + fnC("trReport"), ctx);
    ctx.trStamp = () => "09/21 22:26"; ctx.trKeyBad = () => false;
    const Vc = { binance: { credentials: true, pair: true, order: true, account: true } };
    const sources = [null, "web", "user", "flatten", "portfolio", "desktop", "reconciler", "healthcheck", "desktop-agent", "", undefined];
    const cases = [];
    sources.forEach((src0) => [false, true].forEach((acctFail) => {
      const report = { venues: Vc, config: { amounts: { a: 100 } }, halt: src0 === null ? { halted: false } : { halted: true, at: 5, ...(src0 === undefined ? {} : { source: src0 }) },
        reconciler: { alive: false, heartbeat_at: 9, stopped: { reason: "machine_restart", at: 1, gated: false } },
        account: { venues: { binance: acctFail ? { ok: false, error: "x" } : { ok: true, equity: 1000 } } } };
      cases.push({ name: String(src0) + (acctFail ? "+acctFail" : ""), st: { alive: true, running: true, report, cloud: { code: "OK", machine: { state: "running" } } } });
    }));
    const bad = [];
    ["zh", "en"].forEach((lang) => { ctx.LANG = lang; vm.runInContext("LANG = " + JSON.stringify(lang), ctx);
      cases.forEach((c) => {
        ctx.TR = { env: "cloud", st: c.st }; vm.runInContext("var TR = this.TR", ctx);
        const state = vm.runInContext("trExecState(TR.st)", ctx);
        const texts = [vm.runInContext("trStateText(" + JSON.stringify(state) + ")", ctx), vm.runInContext("trShortState(" + JSON.stringify(state) + ")", ctx),
          vm.runInContext('t("tr.cloud.stale", { t: "x" })', ctx), vm.runInContext('t("tr.stop")', ctx)];
        const w = vm.runInContext('envStratWord("a", TR.st)', ctx); if (w) texts.push(vm.runInContext("t(" + JSON.stringify(w) + ")", ctx));
        if (texts.some((x) => /啟動下單|Start trading/i.test(String(x)))) bad.push(lang + ":" + c.name + " → " + texts[0]);
      }); });
    ok("B1 列舉:C 的每一種子狀態(" + cases.length + " 種 × zh/en)看得到的狀態字都沒有「啟動下單」/ Start trading" + (bad.length ? ":" + bad.slice(0, 3).join(" | ") : ""), cases.length === 22 && bad.length === 0);
    ctx.LANG = "zh"; vm.runInContext('LANG = "zh"', ctx);
    ctx.TR = { env: "cloud", st: cases.find((c) => c.name === "reconciler").st }; vm.runInContext("var TR = this.TR", ctx);
    ok("B1 C + 自動 HALT 的原因行指向更新(不是 A′ 那句)", /舊版下單程式可能還在跑。先按「立即更新到最新版本」；不確定暫停的原因，可以在聊天請 agent 查。$/.test(vm.runInContext('trStateText("halted")', ctx))); }
  { // round-2 稽核 B2:B0 的去向行沒有交易所時不留空段
    ok("B2 去向行濾掉空段:「雲端 ·  · 」→「雲端」;三段齊全照原樣", trWhereTidy("雲端 ·  · ") === "雲端" && trWhereTidy("雲端 · 真錢 · Binance") === "雲端 · 真錢 · Binance"
      && trWhereTidy("Cloud · Paper · ") === "Cloud · Paper" && /o\.footWhere = trWhereTidy\(t\("tr\.cloud\.footWhere"/.test(src)); }
  { // 0.0.3 實機:同一組金額,表上「你淨值的 N x」跟確認框的倍數要一樣(兩處用同一個淨值快照)
    ok("淨值快照:確認框用表上畫的那一個(同視角);沒畫過 / 另一個視角 / 壞值才用現在的", trShownEquity({ env: "local", v: 9945 }, "local", 9961) === 9945
      && trShownEquity({ env: "cloud", v: 9945 }, "local", 9961) === 9961 && trShownEquity(null, "local", 9961) === 9961 && trShownEquity({ env: "local", v: null }, "local", 9961) === 9961 && trShownEquity({ env: "local", v: NaN }, "local", 5) === 5);
    ok("淨值快照接線:表上那行記下它用的淨值,確認框讀它", /const eq = trEquity\(\); TR\.eqShown = \{ env: TR\.env, v: eq \};/.test(src)
      && /trCurrentAmounts\(names, stored, TR\.edits\), eq\);/.test(src) && /const eq = trShownEquity\(TR\.eqShown, TR\.env, trEquity\(\)\), tt = trTotals\(sending, eq\)/.test(src)); }
  { // 0.0.3 實機:按下啟動之後,啟動前的失敗不再講成現在式
    ok("按下啟動記時間(表底紅字只給這之後的失敗)", /const go = \(cmd\) => \{ TR\.startAt = Date\.now\(\); return trRunStart\(cmd\); \};/.test(fnS("trAskStart")));
    const po = (l) => fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", l + ".po"), "utf8");
    ok("本機重開的啟動框那一句(zh / en):講 Blave 關著時沒跑,不講「暫停期間照常更新」", /msgid "tr\.startWarn2Local"\nmsgstr "Blave 關著的那段時間，策略沒有執行/.test(po("zh")) && /msgid "tr\.startWarn2Local"\nmsgstr "Nothing ran while Blave was closed/.test(po("en"))
      && /msgid "tr\.orderFailedLastWhy"\nmsgstr "上次下單失敗：\{why\}"/.test(po("zh"))); }
  { // 設計師新狀態稽核(09-22)
    const po = (l) => fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", l + ".po"), "utf8");
    const get = (l, k) => { const m = po(l).match(new RegExp('msgid "' + k.replace(/\./g, "\\.") + '"\\nmsgstr "([^\\n]*)"')); return m ? m[1] : null; };
    ok("2-4 A′ 不再叫人去事件列找原因(事件列從來不印 halt.reason);改成請 agent 查", ["tr.haltReasonAll", "tr.cloud.haltReasonUnconfirmed"].every((k) => !/事件列/.test(get("zh", k)) && !/Events/.test(get("en", k)) && /agent/.test(get("zh", k)) && /agent/.test(get("en", k))));
    ok("§3-5 累積損益圖讀屏唸「累積損益曲線」,權益照舊", /t\(isPnl \? "tr\.ov\.curveAriaPnl" : "tr\.ov\.curveAria", \{/.test(src) && /^累積損益曲線/.test(get("zh", "tr.ov.curveAriaPnl")) && /^Cumulative PnL curve/.test(get("en", "tr.ov.curveAriaPnl")));
    const head = fnS("trPaintHead");
    ok("§3-8 暫停收斂放開後焦點還回主鈕(停在標題或掉到 body 都不行);只在先前停過焦點時才動", /if \(!flying && TR\.focusParked\) \{ TR\.focusParked = false; const ae = document\.activeElement; if \(!b\.disabled && \(!ae \|\| ae === document\.body \|\| ae === \$\("tr-h"\)\)\) b\.focus\(\); \}/.test(head));
    const appSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.js"), "utf8");
    ok("2-3 停用的主鈕 aria-describedby 指到為什麼按不了那一句;關框收掉", /if \(okDisabled && okWhy && x === okWhy\) p\.id = "del-ok-why";/.test(appSrc)
      && /if \(okDisabled && okWhy && \$\("del-ok-why"\)\) \$\("del-ok"\)\.setAttribute\("aria-describedby", "del-ok-why"\); else \$\("del-ok"\)\.removeAttribute\("aria-describedby"\);/.test(appSrc)
      && /\$\("del-ok"\)\.disabled = false; \$\("del-ok"\)\.removeAttribute\("aria-describedby"\);/.test(appSrc.slice(appSrc.indexOf("function delClose"))));
    const css = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.css"), "utf8");
    ok("2-1 側欄雲端列尾:C 的長詞改紅短劃(title + aria-label 帶全文),其他詞照舊寫字", /function envRowMark\(w\) \{\n\s*if \(w !== "tr\.cloud\.mayTrade"\) return trEl\("span", "stx", t\(w\)\);\n\s*const m = trEl\("span", "dot bad"\); m\.setAttribute\("role", "img"\); m\.setAttribute\("aria-label", t\(w\)\); m\.title = t\(w\);/.test(src)
      && /if \(w\) row\.appendChild\(envRowMark\(w\)\);/.test(src) && /\.strat-row \.dot\.bad \{ flex: none; display: inline-block; width: 8px; height: 2px; background: var\(--color-red\); \}/.test(css)); }
  { // v2 §8:沒有策略設金額(Z)時停用「啟動下單」+「解除暫停」
    const Vz = { paper: { credentials: true, pair: true, order: true, account: true } };
    ok("Z 判定:沒有任何金額 > 0(含沒有設定檔);讀不到設定檔(config: null)不算 Z(不猜)", trNoAmounts({ config: { amounts: {} } }) && trNoAmounts({ config: { amounts: { a: 0, b: "0" } } }) && trNoAmounts({})
      && !trNoAmounts({ config: { amounts: { a: 0, b: 5 } } }) && !trNoAmounts({ config: null }) && !trNoAmounts(null));
    // 不變式(列舉):Z 時只要主鈕會是「啟動下單」,它就一定停用
    const halts = [{}, { halted: true, source: "web" }, { halted: true, source: "reconciler" }];
    const recs = [{ alive: true }, { alive: false }, { alive: false, heartbeat_at: 100 }, { alive: false, stopped: { reason: "machine_restart", at: 1 } }, { alive: false, stopped: { reason: "machine_restart", at: 1, gated: true } }, { alive: true, stopped: { reason: "machine_restart", at: 1, gated: false } }];
    const daemons = [undefined, { reconciler: { running: false, wanted: false } }, { reconciler: { running: false, wanted: true } }, { reconciler: { running: true } }];
    const cfgs = [{ amounts: {} }, { amounts: { a: 0 } }, undefined];
    let n = 0; const bad = [];
    [Vz, {}].forEach((venues) => halts.forEach((halt) => recs.forEach((reconciler) => daemons.forEach((daemon) => cfgs.forEach((config) => {
      const r = { venues, halt, reconciler, ...(daemon ? { daemon } : {}), ...(config ? { config } : {}) }, st0 = { alive: true, report: r }, state = trExecState(st0);
      const hasBtn = !(state === "loading" || state === "unknown" || (state === "noaccount" && !trNoAccountStopped(r)));
      const saysStart = hasBtn && !trStopSide(state) && !trRestartUnconfirmed(r);
      if (saysStart) { n++; if (!trZView(state, r).off) bad.push(state + ":" + JSON.stringify(r)); }
    })))));
    ok("不變式:沒有策略設金額時「啟動下單」永遠停用(列舉 " + n + " 種會出「啟動下單」的報告)" + (bad.length ? ":" + bad[0].slice(0, 160) : ""), n > 20 && bad.length === 0);
    const Zr = (o) => ({ venues: Vz, config: { amounts: {} }, halt: {}, reconciler: { alive: false }, ...o });
    const zv = (o) => { const r = Zr(o); return trZView(trExecState({ alive: true, report: r }), r); };
    const Rst = { alive: false, stopped: { reason: "machine_restart", at: 1 } };
    ok("§8 表:dead → 停用、沒有解除暫停;HALT / 重開停止 → 停用 + 解除暫停;Blave 重開(app,沒 HALT)→ 停用、沒有解除暫停;原因行各對",
      J(zv({})) === J({ off: true, release: false, reason: "tr.startOffNoAmt" })
      && J(zv({ halt: { halted: true, source: "web" } })) === J({ off: true, release: true, reason: "tr.startOffNoAmtRelease" })
      && J(zv({ reconciler: Rst })) === J({ off: true, release: true, reason: "tr.startOffNoAmtRelease" })
      && J(zv({ reconciler: { alive: false, heartbeat_at: 100 }, daemon: { reconciler: { running: false, wanted: false } } })) === J({ off: true, release: false, reason: "tr.startOffNoAmt" }));
    ok("§8 表:running / 可能仍在下單(C)/ 一般 noaccount / 有金額 → 照現行(全 false);B0 = 解除暫停",
      !zv({ reconciler: { alive: true } }).off && !zv({ reconciler: { alive: true, stopped: { reason: "machine_restart", at: 1, gated: false } } }).off
      && !trZView("noaccount", Zr({ venues: {} })).off && !trZView("dead", Zr({ config: { amounts: { a: 5 } } })).off && trZView("noaccount", Zr({ venues: {}, reconciler: Rst })).release);
    // 解除暫停的確認框
    const RK = (o) => trReleaseKind(Zr({ reconciler: Rst, ...o }));
    const act = (m) => ({ BTCUSDT: { side: "long", size: m, exchange: "binance" }, "ETHUSDT@spot": { side: "long", size: 5, exchange: "binance" } });
    ok("§8 框:只有重開停止會開始平倉;單純 HALT、沒有設定檔(對帳器唯讀)、沒有孤兒 → X0", trReleaseKind(Zr({ halt: { halted: true } })).kind === "x0"
      && RK({ portfolio_configured: false }).kind === "x0" && RK({ last_reconcile: { actual: act(0) } }).kind === "x0");
    /* 稽核 R9:只認 portfolio_configured === false(逐字同網頁 pfNeverConfigured)。「設定檔在、但讀不壞」機器端照樣算設定過、
       對帳器照跑照平倉,不可以在這裡當成安全;那一種由 trNoAmounts 的 config === null 擋在上游(Z 不成立,鈕不存在) */
    ok("R9 讀不到設定檔(config: null)不算「從沒設定過」:走警告那一邊(X1),不說「什麼都不會平」", trReleaseKind({ ...Zr({ reconciler: Rst }), config: null, portfolio_configured: true, last_reconcile: { actual: act(300) } }).kind === "x1"
      && trReleaseKind({ ...Zr({ reconciler: Rst }), config: undefined, last_reconcile: { actual: act(300) } }).kind === "x1"
      && !trNoAmounts({ ...Zr({ reconciler: Rst }), config: null }));
    ok("§8 框:重開停止 + 帳上有合約部位(self_ledger 沒開)→ X1 帶數量(現貨不算);讀不到快照 → X1 不帶數字", J(RK({ last_reconcile: { actual: act(300) } })) === J({ kind: "x1", n: 1 }) && J(RK({})) === J({ kind: "x1", n: null }));
    ok("§8 框:self_ledger 開著、帳本上有部位 → X2;帳本空 → X0", RK({ self_ledger: true, last_reconcile: { ledger: { BTCUSDT: { size: 10 } }, actual: act(300) } }).kind === "x2"
      && RK({ self_ledger: true, last_reconcile: { ledger: {}, actual: act(300) } }).kind === "x0");
    const rel = fnS("trAskRelease"), head = fnS("trPaintHead"), gorel = fnS("trPaintGoRel"), noamt = fnS("trPaintNoAmt"), pend = fnS("trPendingCheck");
    await (async () => { // 行為測試(稽核的測試缺口 ③):真的跑一次「解除暫停」,看它到底送了哪些指令——不是對原始碼比 regex
      const sends = []; let box = null;
      const env2 = { t: (k) => k, trReport: () => Zr({ reconciler: Rst }), trCloudBox: (o) => o, confirmBox: (o) => { box = o; }, srSay: () => {},
        TR: { env: "local", pending: null, sending: {}, reqIds: {}, api: { tradeSend: async (cmd, args, rid, intent) => { sends.push([cmd, args, rid, intent]); return { ok: true }; } } },
        trRun: (want, steps, cmd) => { env2.ran = { want, cmd }; return Promise.all(steps.map((f) => f(env2.TR))); },
        trHaltStopsAll, trReleaseKind, trRestartStopped, trRestartUnconfirmed, trNoAccountStopped, trHasAccount, trCanonKey, trMs, console };
      const vm2 = require("vm"); vm2.createContext(env2);
      vm2.runInContext(fnS("trAskRelease") + "\n" + src.slice(src.indexOf("async function trSend("), src.indexOf("\n/* 送「會改變執行狀態」的指令")), env2);
      vm2.runInContext("trAskRelease(null)", env2);
      return Promise.resolve(box && box.alt ? box.alt.onOk() : box && box.onOk()).then(() => {
        ok("§8 解除暫停真的只送一個 resume(沒有 restart_reconciler / resume_wait),而且標成 release;want 是自己的 released",
          J(sends) === J([["resume", {}, null, "release"]]) && env2.ran && env2.ran.want === "released" && env2.ran.cmd === "resume");
      });
    })();
    ok("§8 X0 自動觸發的 HALT 多一句;X1/X2 主鈕是「先不要」(single:焦點在它)、平掉並解除是破壞性次鈕", /const auto = !!\(r\.halt && r\.halt\.halted\) && trHaltStopsAll\(r\.halt\);/.test(rel) && /\.concat\(auto \? \[t\("tr\.relAuto"\)\] : \[\]\)/.test(rel)
      && /single: true,/.test(rel) && /ok: t\("tr\.relNotNow"\), onOk: \(\) => \{\}, alt: \{ label: t\("tr\.relCloseGo"\), danger: true, onOk: go \}/.test(rel) && /k\.n \? t\("tr\.relX1Body", \{ n: k\.n \}\) : t\("tr\.relX1BodyN"\)/.test(rel));
    ok("§8 接線:主鈕 disabled 帶 zv.off、aria-describedby 指原因行、title 不讓「連不上」蓋掉原因;原因行與解除暫停鈕每次畫", /b\.disabled = flying \|\| zv\.off \|\| \(!busy && !usable\);/.test(head)
      && /if \(zv\.off\) b\.setAttribute\("aria-describedby", "tr-noamt"\);/.test(head) && /b\.title = zv\.off \? "" :/.test(head) && /trPaintNoAmt\(pend \|\| zv\.reason\); trPaintGoRel\(zv\.release, zv\.noStart\);/.test(head)
      && /if \(trZView\(envHeadState\(TR\.st, Date\.now\(\)\), r\)\.off\) return;/.test(fnS("trAskStart")));
    ok("§8 / §13-1 解除暫停鈕:B0 實心、其餘描邊;插在主鈕左邊(主鈕守住最右);在途「解除中…」停用、通道不通也停用;停用時焦點先交給標題、放開再還回來;原因行的「部位」是切分頁的連結",
      /u\.classList\.toggle\("btn-fill", !!solid\); u\.classList\.toggle\("btn-out", !solid\);/.test(gorel) && /\$\("tr-act"\)\.insertBefore\(u, \$\("tr-go"\)\)/.test(gorel)
      && /u\.textContent = rel \? t\("tr\.releasing"\) : t\("tr\.release"\);/.test(gorel) && /const off = !!TR\.pending \|\| !up;/.test(gorel)
      && /if \(off && document\.activeElement === u\) \{ \$\("tr-h"\)\.focus\(\); TR\.relParked = true; \}/.test(gorel)
      && /if \(!off && TR\.relParked\) \{ TR\.relParked = false;[^\n]*u\.focus\(\); \}/.test(gorel)
      && /word = t\("tr\.tab\.pos"\)/.test(noamt) && /trSetTab\("pos", true\)/.test(noamt) && /\$\("tr-desc"\)\.after\(p\)/.test(noamt));
    ok("§8 解除在途的收斂:HALT 與重開停止都清掉就算(Z 時落到 running 或 dead 都行);狀態字「解除中…」", /relDone = p\.want === "released" && !!TR\.st && !!TR\.st\.report && !\(pr\.halt && pr\.halt\.halted\) && !trRestartStopped\(pr\);/.test(pend)
      && /TR\.pending\.want === "released" \? t\("tr\.releasing"\)/.test(fnS("trStateText")) && /TR\.pending\.want === "released" \? t\("tr\.releasing"\)/.test(fnS("trShortState")));
    ok("§8 running + Z 的狀態行不寫「自動下單執行中」", /let s = trNoAmounts\(r\) \? t\("tr\.runningZ"\) : t\("tr\.autoOn"\);/.test(fnS("trStateText")));
    { const S2 = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "strings.js"), "utf8");
      ok("§8 破壞性次鈕的字:en「Close positions and release」(不讀成「關掉這個框」,同網頁);zh 不動", /"tr\.relCloseGo": "Close positions and release"/.test(S2) && /"tr\.relCloseGo": "平掉並解除暫停"/.test(S2) && !/Close and release/.test(S2)); }
    const css = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.css"), "utf8");
    ok("視覺稽核 2-4:停用的實心鈕有一條比填色亮一階的框(只靠填色對 darkBody 只有 1.5:1)", /\.btn-fill:disabled \{ background: var\(--surface-muted\); color: var\(--ink-3\); border: 1px solid var\(--color-greyMedium\); cursor: default; opacity: 1; \}/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.css"), "utf8")));
    ok("稽核 R5:原因行收掉 / 重建之前,焦點在那條「部位」連結上就先交給標題(不掉到 BODY);標頭早退拿掉主鈕時同理",
      /const hadFocus = !!p && p\.contains\(document\.activeElement\);/.test(noamt) && /if \(!key\) \{ if \(p\) \{ if \(hadFocus\) \$\("tr-h"\)\.focus\(\); p\.remove\(\); \} return; \}/.test(noamt)
      && /if \(hadFocus\) \$\("tr-h"\)\.focus\(\);\n\s*p\.dataset\.key = key/.test(noamt)
      && /\{ if \(b\) \{ if \(document\.activeElement === b\) \$\("tr-h"\)\.focus\(\); b\.remove\(\); \} trPaintGoStop\(false\);/.test(head));
  { /* V2b 標頭三列(spec §12-4):列 1 標題 | 動作槽,狀態句與原因行跨滿寬;中欄 ≤520 且**兩顆**鈕時鈕自己一列。
       舊的 flex 版在 1024 最小視窗 + 三欄全開(中欄 336)把文字欄壓到 60 px,最長的狀態 36 行 */
    const css2 = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.css"), "utf8");
    const cq = css2.slice(css2.indexOf("@container (max-width: 520px)"), css2.indexOf("}\n", css2.indexOf(".pf-tbl .ccy")));
    ok("V2b:.main-head 是 grid、.txt 走 display: contents、標題與動作槽同一列、動作槽靠右",
      /\.main-head \{ flex: none; display: grid; grid-template-columns: minmax\(0, 1fr\) auto; column-gap: var\(--space-16\); align-items: start;/.test(css2)
      && /\.main-head > \.txt \{ display: contents; \}/.test(css2) && /\.main-head-name \{ grid-column: 1; grid-row: 1; \}/.test(css2)
      && /\.main-head \.act \{ grid-column: 2; grid-row: 1; justify-self: end;/.test(css2)
      && /\.main-head:not\(:has\(\.act\)\) \{ grid-template-columns: minmax\(0, 1fr\); column-gap: 0; \}/.test(css2));
    ok("V2b:.txt 底下每一個孩子都跨滿寬(狀態句、原因行、更新入口、唯讀說明、停機區塊、紅字)——漏一個就會被塞進第二欄",
      /\.main-head-desc, \.main-head \.tr-noamt, \.main-head \.tr-go-upd, \.main-head \.tr-ro-note, \.main-head #tr-verdict, \.main-head \.pf-alert \{ grid-column: 1 \/ -1; \}/.test(css2));
    ok("V2b:中欄 ≤520 + 兩顆鈕才換列、各佔一半;一顆鈕留在標題列(不用無條件換行那一種)",
      /\.main-head:has\(\.act button \+ button\) \.act \{ grid-column: 1 \/ -1; grid-row: 2; justify-self: stretch;/.test(cq)
      && /\.main-head:has\(\.act button \+ button\) \.act > button \{ flex: 1; \}/.test(cq)
      && !/\.main-head \.act \{ grid-column: 1 \/ -1/.test(cq));
    { /* 陷阱的行為版:把 trPaintHead 裡那個 wrap 判斷式逐字切出來,對每一種 Z 狀態真的算一次。
         只比 regex 的話,改成 `trNoAmounts(r) && false` 之類照樣綠 */
      const expr = head.slice(head.indexOf('desc.classList.toggle("wrap", ') + 'desc.classList.toggle("wrap", '.length, head.indexOf(");   //", head.indexOf('desc.classList.toggle("wrap", '))).replace(/\);\s*$/, "");
      const wrap = new Function("state", "ro", "died", "TR", "trReport", "trHostDown", "trNoAmounts", "trNoAccountStopped", "return " + expr + ";");
      const Vw = { paper: { credentials: true, pair: true, order: true, account: true } };
      const zCases = [["Z+主機重開", { venues: Vw, config: { amounts: {} }, halt: {}, reconciler: { alive: false, stopped: { reason: "machine_restart", at: 1 } } }],
        ["Z+自動暫停", { venues: Vw, config: { amounts: {} }, halt: { halted: true, source: "reconciler" }, reconciler: { alive: true } }],
        ["B0", { venues: {}, config: { amounts: {} }, halt: {}, reconciler: { alive: false, stopped: { reason: "machine_restart", at: 1 } } }],
        ["Blave 重開", { venues: Vw, config: { amounts: {} }, halt: {}, reconciler: { alive: false, heartbeat_at: 100 }, daemon: { reconciler: { running: false, wanted: false } } }],
        ["running+Z", { venues: Vw, config: { amounts: {} }, halt: {}, reconciler: { alive: true } }],
        ["尚未啟動+Z", { venues: Vw, config: { amounts: {} }, halt: {}, reconciler: { alive: false, heartbeat_at: 100 }, daemon: { reconciler: { running: false, wanted: false } } }]];
      const noWrap = zCases.filter(([, r]) => { const st0 = { alive: true, running: true, report: r }, state = trExecState(st0);
        return !wrap(state, false, trDeadKind(r) === "died" && state === "dead", { st: st0, env: "local", pending: null }, () => r, () => null, trNoAmounts, trNoAccountStopped); });
      ok("V2b 陷阱(行為):Z 的每一種狀態狀態句都會換行" + (noWrap.length ? ":" + noWrap.map((x) => x[0]).join() : ""), noWrap.length === 0); }
    // 陷阱:狀態句預設 nowrap + 省略號,跨滿寬之後少了 .wrap 會被截成一行**而且看起來很正常**——藏掉的是「部位現在沒有人在管」
    ok("V2b 陷阱:Z 的每一種狀態都掛 .wrap(running + Z、尚未啟動那兩種以前沒有)", /trNoAmounts\(trReport\(\)\) \|\| \(state === "noaccount" && trNoAccountStopped\(trReport\(\)\)\)\);/.test(src)
      && /\.main-head-desc \{[^}]*white-space: nowrap; \}/.test(css2) && /\.main-head-desc\.wrap \{ white-space: normal; overflow: visible; \}/.test(css2)); }
    ok("§8 原因行樣式:--ink-3 12px", /\.main-head \.tr-noamt \{ margin: var\(--space-4\) 0 0; font-size: 12px; line-height: 1\.5; color: var\(--ink-3\); \}/.test(css)); }
  { // 稽核 S-1:模擬帳戶送出後直接當成已連接(不進「連接中…」等待態)
    const paint = fnS("trPaint"), skel = fnS("trPaintSkel"), cx = src.slice(src.indexOf("async function cxConnectCloud("), src.indexOf("\nfunction ", src.indexOf("async function cxConnectCloud(")));
    const now = 1e12;
    ok("模擬:存下的紀錄在上限內算已連接;真實交易所不算;過了上限兩邊都不算(退回 onboard 講主機沒回報)",
      trCxAssumed({ venue: "paper", at: now }, now + 1000) === true && trCxAssumed({ venue: "binance", at: now }, now + 1000) === false
      && trCxAssumed({ venue: "paper", at: now }, now + TR_CX_SAVED_MS) === false && trCxAssumed(null, now) === false);
    ok("模擬(spec-desktop-waiting-states §3):收掉分頁列與骨架,走 onboard 的等待兩行;骨架元件與 CSS 都拿掉",
      /const bare = assumed \|\| state === "noaccount" \|\| state === "loading" \|\| state === "unknown";/.test(paint)
      && !/trPaintSkel|tr-skel/.test(src) && !/tr-skel/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.css"), "utf8")));
    ok("模擬:送出成功後讀屏念「已連接」,不念「正在等主機確認」;真實交易所照舊念已存 + 等確認",
      /srSay\(venue === PAPER \? t\("cx\.connected"\) : \(venue === BINANCE \? t\("tr\.cloud\.cxSavedBn"\) : t\("tr\.cloud\.cxSavedV", \{ venue: trVenueLabel\(venue, true\) \}\)\) \+ " " \+ t\("tr\.cloud\.cxWaiting"\)\);/.test(cx));
    // 追加稽核 4:報告真的帶出 paper 的那一刻不可以再念一次(同一件事對讀屏講兩次);真實交易所那時才第一次念
    ok("模擬:報告追上時不重複念「已連接」;真實交易所照念", /const said = C\.cxSaved\.venue === PAPER; C\.cxSaved = null; C\.sig = \{\}; if \(!said\) srSay\(t\("cx\.connected"\)\);/.test(src)); }
  { /* spec-desktop-waiting-states:機器的上一份報告不可以否定用戶剛做的事。
       存完金額到下一份報告之間,標頭原來寫「還沒有策略設定金額,先到部位設定」——那是假的,
       而且叫人再做一次他剛做完的事;鈕照舊停用(它作用在機器實際持有的設定上),換的是理由。 */
    const Vp2 = { paper: { credentials: true, pair: true, order: true, account: true } };
    const rz = (o) => ({ venues: Vp2, config: { amounts: {} }, halt: {}, reconciler: { alive: false, heartbeat_at: 100 }, daemon: { reconciler: { running: false, wanted: false } }, ...o });
    /* 定稿:等回報那一行**不在 trZView 裡**。它的條件只有 sentOn && 沒再改 && 存檔沒失敗,跟 Z、
       跟金額、跟 trExecState 都無關;非 Z(有金額,常見的那一種)也要出。trZView 繼續只決定**鈕**。 */
    ok("§2 trZView 只吃 (state, r):原因行不再由它決定(Z 自己那一句照舊)",
      /^function trZView\(state, r\) \{/m.test(src) && trZView("dead", rz()).reason === "tr.startOffNoAmt"
      && trZView("halted", rz({ halt: { halted: true, source: "web" }, reconciler: { alive: true } })).reason === "tr.startOffNoAmtRelease");
    ok("§2 鈕的行為沒變:Z 停用、非 Z 不停用(等回報那一行不動鈕)",
      trZView("dead", rz()).off === true && trZView("dead", rz({ config: { amounts: { a: 100 } } })).off === false
      && trZView("halted", rz({ halt: { halted: true, source: "web" }, reconciler: { alive: true } })).off === true);
    { /* 行為:trPaintHead 那一整條組合式**從原文切出來跑**(改了就露餡)。非 Z 是常見的那一種,
         所以它必須真的出線;又改過 / 有格子看不懂 / 存檔失敗 / 本機都不出。 */
      const vm = require("vm");
      let NOW = 1e12;
      const ctx2 = { Date: { now: () => NOW }, Object, Array, String, Number, JSON, isFinite, isNaN, Set, Map };
      vm.createContext(ctx2);
      vm.runInContext(src.slice(src.indexOf("/* ── 純邏輯("), src.indexOf("/* ── 純邏輯到此")).replace(/^const /gm, "var "), ctx2);
      // fnS 切到下一個 function 為止,所以 trAmountsPending 那一段本身就帶著 TR_PEND_SLOW_MS(不另外宣告)
      vm.runInContext([fnS("trReport"), fnS("trStored"), fnS("trBase"), fnS("trNames"), fnS("trAmountsPending"), fnS("trPendKey"), fnS("trAmountsEdited")].join("\n"), ctx2);
      const ZV = "var ask = false; " + (src.match(/^ {2}const zv = ask \? .+$/m) || [""])[0].trim().replace(/^const /, "var ");
      const PEND = (src.match(/^ {2}const pend = .+$/m) || [""])[0].trim().replace(/^const /, "var ");
      const rp = (amounts, o2) => ({ venues: V, halt: {}, reconciler: { alive: false, heartbeat_at: 100 },
        daemon: { reconciler: { running: false, wanted: false } }, config: { amounts }, ...o2 });
      const line = (o, amounts, state, o2) => {
        ctx2.TR = { env: "cloud", save: "sent", sent: { a: 100 }, sentAt: 1e12, edits: {}, bad: {},
          list: [{ name: "a", hasBacktest: true }], st: { alive: true, report: rp(amounts === undefined ? { a: 100 } : amounts, o2) }, ...o };
        vm.runInContext("var TR = this.TR; var state = " + JSON.stringify(state || "dead"), ctx2);
        return vm.runInContext(ZV + "\n" + PEND + "\npend", ctx2);
      };
      ok("§2 組合式真的切得出來(接線改名就紅,不是永遠 true)",
        /trAmountsEdited\(\)/.test(PEND) && /trPendKey\(/.test(PEND) && /zv\.off && !zv\.noStart/.test(PEND) && /trZView\(state, trReport\(\)/.test(ZV));
      ok("§2 非 Z(有金額,常見的那一種)也出這一行,而且是「這一頁的數字還是舊的」那一句;Z 才是「回報進來就能啟動」",
        line({}, { a: 100 }) === "tr.cloud.startPendAmountsStale" && line({}, {}) === "tr.cloud.startPendAmounts");
      ok("§2 非 Z 時鈕不受影響(這一行不擋人按啟動下單)", trZView("dead", rz({ config: { amounts: { a: 100 } } })).off === false);
      /* 判準是鈕能不能按、不是有沒有金額:重開沒確認停住(C)沒有金額時 trZView 回 none(鈕照樣能按),
         那一格必須講「這一頁的數字還是舊的」,不能講「回報進來就能啟動」——會一邊那樣說一邊讓人按下去。 */
      ok("§2 C(重開沒確認停住)+ 沒有金額:鈕能按,所以句子不講「回報進來就能啟動」",
        trZView("dead", rz({ reconciler: { alive: false, stopped: { reason: "machine_restart", at: 1, gated: false } } })).off === false
        && line({}, {}, "dead", { reconciler: { alive: false, stopped: { reason: "machine_restart", at: 1, gated: false } } }) === "tr.cloud.startPendAmountsStale");
      ok("§2 存完又改過 / 有格子看不懂 → 收起來(畫面上的數字是他正在打的,不是「舊的」)",
        line({ edits: { a: 7 } }) === null && line({ bad: { a: 1 } }) === null && line({ edits: { a: 100 } }) !== null);
      ok("§2 存檔失敗、本機、沒送過 → 不出(失敗要讓儲存列講失敗)",
        line({ save: "failed" }) === null && line({ env: "local" }) === null && line({ sent: null }) === null);
      NOW = 1e12 + 20001;
      ok("§2 過了 20 秒:Z 與非 Z 都換成同一句升級句(時間一到就換,不另造計時器)",
        line({}, { a: 100 }) === "tr.cloud.startPendSlow" && line({}, {}) === "tr.cloud.startPendSlow");
      NOW = 1e12; }
    { /* §2-3 定稿:常態那一句**不講秒數**(爆發窗之後常態約 5 秒);超過 20 秒才升級成帶「最久大約兩分鐘」那一句。
         照 app.js 的 plan.err.slow + PLAN_SLOW_MS 那個既有形狀,不另造計時器 */
      eval(fnS("trAmountsPending").replace(/^function /, "var trAmountsPending2 = function "));
      eval(fnS("trPendKey").replace(/^function /, "var trPendKey = function ").replace("trAmountsPending(S)", "trAmountsPending2(S)"));
      eval(src.match(/^const TR_PEND_SLOW_MS = [^\n]*$/m)[0].replace(/^const /, "var "));
      const T1 = 1e12, bag = { env: "cloud", sent: { a: 1 }, save: "sent", sentAt: T1 };
      ok("§2 20 秒之前是不講秒數那一句;之後升級成帶數字那一句", trPendKey(bag, T1 + 1000, true) === "tr.cloud.startPendAmounts"
        && trPendKey(bag, T1 + TR_PEND_SLOW_MS, true) === "tr.cloud.startPendAmounts" && trPendKey(bag, T1 + TR_PEND_SLOW_MS + 1, true) === "tr.cloud.startPendSlow"
        && TR_PEND_SLOW_MS === 20000);
      // 常態句分兩版(Z / 非 Z),升級句兩版共用——慢的時候講的是「主機還在回報」,那跟有沒有金額無關
      ok("§2 Z 與非 Z 各一句常態句;過了 20 秒兩邊都換成同一句升級句",
        trPendKey(bag, T1 + 1000, true) === "tr.cloud.startPendAmounts" && trPendKey(bag, T1 + 1000, false) === "tr.cloud.startPendAmountsStale"
        && trPendKey(bag, T1 + 9e6, true) === "tr.cloud.startPendSlow" && trPendKey(bag, T1 + 9e6, false) === "tr.cloud.startPendSlow");
      /* 這條比的是**寫死的 5000**,不是 cloud.js 的 MIN_GAP_MS。它保的是「升級句的門檻不會被調到
         跟常態等待同一個數量級」;它**不會**在有人把 MIN_GAP_MS 從 5 秒改大時變紅(那時 20 秒可能
         已經不到三倍了,這裡照樣綠)。要連動得把 MIN_GAP_MS 從 cloud.js 讀進來比——刻意不做:
         renderer 這支測試不該依賴 main process 那個檔的內部常數名。 */
      ok("§2 門檻不得低於常態(約 5 秒)的三倍", TR_PEND_SLOW_MS >= 3 * 5000);
      ok("§2 沒在等的時候兩句都不出(本機、失敗、沒送過)", trPendKey({ env: "local", sent: { a: 1 }, sentAt: T1 }, T1 + 9e6) === null
        && trPendKey({ env: "cloud", sent: { a: 1 }, save: "failed", sentAt: T1 }, T1 + 9e6) === null && trPendKey({ env: "cloud", sent: null }, T1) === null);
      ok("§2 送出時間有記下來(沒有它就永遠升不了級)", /S\.sent = sending; S\.sentAt = Date\.now\(\);/.test(src) && /sent: null, sentAt: 0,/.test(src)); }
    // 送出中那一態怎麼算:只有雲端、而且存檔沒失敗
    // trAmountsPending 讀袋子(不在純邏輯區):從原文切出來跑
    eval(fnS("trAmountsPending").replace(/^function /, "var trAmountsPending = function "));
    const AP = (bag) => trAmountsPending(bag);
    ok("§2 判定:雲端 + 有 sent + 沒失敗;本機不算、失敗不算(失敗時原因行要講失敗)",
      AP({ env: "cloud", sent: { a: 1 }, save: "sent" }) === true && AP({ env: "cloud", sent: { a: 1 }, save: "failed" }) === false
      && AP({ env: "local", sent: { a: 1 } }) === false && AP({ env: "cloud", sent: null }) === false);
    ok("§2 aria-describedby 照舊指到原因行(換句之後自動就對)", /if \(zv\.off\) b\.setAttribute\("aria-describedby", "tr-noamt"\);/.test(fnS("trPaintHead")));
    const po2 = (l) => fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", l + ".po"), "utf8");
    const zhOf = (k) => (po2("zh").match(new RegExp('msgid "' + k.replace(/\./g, "\\.") + '"\nmsgstr "([^\n]*)"')) || [])[1] || "";
    ok("§2 常態那一句:講在等誰、會自己好,**不講秒數**,也不叫人再去設定金額",
      zhOf("tr.cloud.startPendAmounts") === "新金額已送到主機，正在等回報。回報進來就能啟動。"
      && /You’ll be able to start once it reports back\./.test(po2("en"))
      && !/分鐘|秒/.test(zhOf("tr.cloud.startPendAmounts")) && !/先到「部位」/.test(zhOf("tr.cloud.startPendAmounts")));
    ok("§2 非 Z 那一句:一樣不講秒數,只說這一頁的數字還是舊的——不說「回報進來就能啟動」(鈕本來就能按),也不是警告",
      zhOf("tr.cloud.startPendAmountsStale") === "新金額已送到主機，正在等回報。這一頁的數字還是舊的。"
      && /The numbers on this page are still the old ones\./.test(po2("en"))
      && !/分鐘|秒/.test(zhOf("tr.cloud.startPendAmountsStale")) && !/就能啟動|先到「部位」/.test(zhOf("tr.cloud.startPendAmountsStale")));
    ok("§2 慢的那一句才講數字,而且叫人不要再按一次(同 plan.err.slow 的語氣)",
      zhOf("tr.cloud.startPendSlow") === "比平常久。主機還在回報，不用再按一次；最久大約兩分鐘。"
      && /Taking longer than usual\./.test(po2("en")) && /兩分鐘/.test(zhOf("tr.cloud.startPendSlow")));
    // §2-3c(a):spinner 放在原因行上,**不放進鈕裡**
    const noamt = fnS("trPaintNoAmt");
    ok("§2-3c spinner 在等回報那一句的句首(沿用 .cx-wait / .spin16),句子整段包在一個 span 裡(不然 flex 會把它切成好幾欄)",
      /const wait = key === "tr\.cloud\.startPendAmounts" \|\| key === "tr\.cloud\.startPendAmountsStale" \|\| key === "tr\.cloud\.startPendSlow";/.test(noamt) && /p\.classList\.toggle\("cx-wait", wait\);/.test(noamt)
      && /if \(wait\) \{ const sp = trEl\("span", "spin16"\); sp\.setAttribute\("aria-hidden", "true"\); p\.appendChild\(sp\); \}/.test(noamt)
      && /const line = wait \? trEl\("span", ""\) : p;/.test(noamt)
      && /\.main-head \.tr-noamt\.cx-wait \{ display: flex; align-items: flex-start; gap: var\(--space-8\); \}/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.css"), "utf8")));
    /* §1 規則 6:控件只有在「用戶按了這顆控件、動作還在路上」時才可以用進行式標籤冒充狀態。
       這一段用戶按的是儲存,不是啟動下單——所以那顆鈕從頭到尾就是「啟動下單」,只是停用。
       列舉打包版裡每一個「…中…」的控件標籤,確認它們都只出現在自己那顆控件的在途分支裡。 */
    const head6 = fnS("trPaintHead"), goRel = fnS("trPaintGoRel");
    ok("§1 規則 6:等回報期間主鈕的字沒變(沒有 tr.starting / 沒有另造進行式),spinner 也不在鈕裡",
      !/spin16/.test(head6) && !/spin16/.test(goRel)
      && /b\.textContent = ask \? \(pendingAcct \? t\("tr\.acct\.confirming"\) : t\("tr\.acct\.btn"\)\)\n\s*: TR\.pending && TR\.pending\.want !== "released" \? \(TR\.pending\.want === "halted" \? t\("tr\.stopping"\) : t\("tr\.starting"\)\) : trStopSide\(state\)/.test(head6));
    { /* 規則 6 的閘門:控件的字不會變成狀態。清單**從 strings.js 掃出來**(zh 值以「中…」結尾),
         不是手寫——手寫的話新加一個進行式標籤沒有人會發現。掃 renderer 每一個檔、每一個出現處
         (不是只查第一個),原文先剝註解(註解裡出現 pending 這個字不守任何門)。
         要求:每個出現處前面 WIN 字內要有**自己那顆控件的在途旗標**——讀它(if / 三元)或在同一段
         動作裡設它(SRC.busy = true 後才換字)都算,因為「使用者按了才變字」正是規則 6 要的。
         STATUS_ONLY 是四個從來不掛在控件上的狀態字(讀取中 / 偵測中),它們本來就是狀態,不受本條管。
         守不住的情形:WIN 字內剛好有個無關的 pending / busy。要真正的防護得做 AST,這裡換來的是
         「新增一個沒人守的進行式標籤會紅」,那是稽核指出的那個洞。 */
      const S2 = (() => { const raw = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "strings.js"), "utf8");
        return (0, eval)("(" + raw.slice(raw.indexOf("{", raw.indexOf("const STRINGS")), raw.lastIndexOf("}") + 1) + ")"); })();
      const STATUS_ONLY = ["tr.loading", "cn.detecting", "cx.ip.loading", "tr.cloud.hdConnecting"];
      const prog = Object.keys(S2.zh).filter((k) => /中…$/.test(S2.zh[k]) && STATUS_ONLY.indexOf(k) < 0);
      const RD = path.join(__dirname, "..", "shell", "renderer");
      const files = fs.readdirSync(RD).filter((f) => f.endsWith(".js") && f !== "strings.js" && f !== "i18n.js");
      /* 最後一項 t("cx.connected") = 設定頁帳號列那個 failed ? … : connected ? … : 串接中…
         的三元,「既沒失敗也還沒連上」就是它的在途條件。 */
      const WIN = 260;  // 夠到 app.js 方案卡那張 per-state 表的 st: ["busy"](離標籤 240 字)
      const FLAG = /pending|busy|save === "saving"|cx\.retest|unbinding|deleting|flying|updating|want === "|view === "starting"|t\("cx\.connected"\)/;
      const bad = []; let seen = 0;
      files.forEach((f) => {
        const bare = fs.readFileSync(path.join(RD, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        prog.forEach((k) => {
          const needle = 't("' + k + '")';
          for (let at = bare.indexOf(needle); at >= 0; at = bare.indexOf(needle, at + 1)) {
            seen++;
            if (!FLAG.test(bare.slice(Math.max(0, at - WIN), at))) bad.push(f + ":" + k + "@" + at);
          }
        });
      });
      ok("§1 規則 6:掃出來的 " + prog.length + " 個進行式標籤,在 renderer 全部檔案裡的 " + seen
        + " 個出現處都有自己的在途旗標守著" + (bad.length ? ":" + bad.slice(0, 3).join(", ") : ""),
        prog.length >= 10 && seen >= 15 && bad.length === 0);
      ok("§1 規則 6:清單是掃出來的、跨檔掃、而且 STATUS_ONLY 真的只放狀態字(新加一個進行式標籤會自己被納入)",
        prog.indexOf("tr.starting") >= 0 && prog.indexOf("tr.loading") < 0 && files.length >= 4
        && files.indexOf("app.js") >= 0 && STATUS_ONLY.every((k) => /中…$/.test(S2.zh[k]))); }
    // §2-3c(b):儲存列只講自己的職責,等待那半句交給標頭(規則 4:一個視窗只講一次)
    ok("§2-3c 儲存列不再重複講等待", /msgid "tr\.cloud\.pendAmounts"\nmsgstr "新金額已存到雲端主機。"/.test(po2("zh"))
      && /msgid "tr\.cloud\.pendAmounts"\nmsgstr "The new amounts are saved on the cloud machine\."/.test(po2("en"))
      && !/回報/.test((po2("zh").match(/msgid "tr\.cloud\.pendAmounts"\nmsgstr "([^\n]*)"/) || [])[1] || ""));
    // §2-3b:兩種「—」要分得出來
    const pos = fnS("trAmountTable");
    ok("§2-3b 等回報時目標部位不畫「—」(那是「策略沒有部位」的意思),改畫待回報記號;表下常駐一句說明",
      /if \(v === 0 && sentOn\) \{ tgt\.textContent = ""; tgt\.appendChild\(trEl\("span", "amt-dash"\)\); \}\n\s*else if \(v === 0\) tgt\.textContent = "—";/.test(pos)
      && /if \(sentOn\) frag\.appendChild\(trEl\("div", "pf-foot", t\("tr\.cloud\.pendTarget"\)\)\);/.test(pos)); }
  { /* 動作後的爆發輪詢窗(§2-4:真正的止血)。窗是**時間**不是條件——報告永遠不來也會到期,
       到期回到誠實的等待畫面,不會一直轉。這裡把兩個純函式真的跑一遍。 */
    eval(fnS("trBurstBump").replace(/^function /, "var trBurstBump = function "));
    eval(fnS("trBurstOn").replace(/^function /, "var trBurstOn = function "));
    eval(src.match(/^const TR_BURST_MS = [^\n]*$/m)[0].replace(/^const /, "var "));
    const T0b = 1e12;
    const b1 = trBurstBump(null, T0b, TR_BURST_MS, TR_BURST_MAX_MS);
    ok("按一次:窗從現在起算 30 秒", b1.until === T0b + TR_BURST_MS && trBurstOn(b1, T0b + 29999) && TR_BURST_MS === 30000);
    // **有到期日**:這一條紅了就代表窗變成「等到好為止」,報告不來就會一直快輪詢
    ok("窗有到期日:過了就關,不管有沒有等到東西", trBurstOn(b1, T0b + TR_BURST_MS) === false && trBurstOn(b1, T0b + 9e6) === false
      && trBurstOn(null, T0b) === false && /until > now/.test(fnS("trBurstOn")));
    // 連續存檔:只把到期往後推,但總長有上限
    let b = b1;
    for (let i = 1; i <= 40; i++) b = trBurstBump(b, T0b + i * 2000, TR_BURST_MS, TR_BURST_MAX_MS);   // 每 2 秒存一次、存 80 秒
    ok("一直改金額不會把窗推到無限長:總長上限 " + TR_BURST_MAX_MS / 1000 + " 秒(從第一次按下起算)", b.until === T0b + TR_BURST_MAX_MS && b.start === T0b
      && trBurstOn(b, T0b + TR_BURST_MAX_MS) === false
      && trBurstBump(b, T0b + 85000, TR_BURST_MS, TR_BURST_MAX_MS).until === T0b + TR_BURST_MAX_MS);   // 窗還開著時再存,照樣頂在上限
    // 兩次存檔很近:同一個窗往後延,不是開第二個(第二次的 start 還是第一次那個)
    const b2 = trBurstBump(b1, T0b + 2000, TR_BURST_MS, TR_BURST_MAX_MS);
    ok("兩次存檔靠很近:延長同一個窗,不開第二個", b2.start === T0b && b2.until === T0b + 2000 + TR_BURST_MS);
    // 窗過期之後再存一次 = 新的一次(重新拿滿 30 秒與新的上限)
    const b3 = trBurstBump(b, T0b + TR_BURST_MAX_MS + 1, TR_BURST_MS, TR_BURST_MAX_MS);
    ok("窗過期之後再存:重新開一個(不是永遠被舊的上限綁住)", b3.start === T0b + TR_BURST_MAX_MS + 1 && b3.until === b3.start + TR_BURST_MS);
    // 地板:畫面每 2.5 秒催一次,但真正出去的請求由主行程的 MIN_GAP_MS 擋成 5 秒一次
    const cloudSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "cloud.js"), "utf8");
    const mainSrc2 = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
    ok("地板 5 秒:cloud-refresh 沒帶 force,所以吃得到 MIN_GAP_MS;催得再快也追不過它",
      /const POLL_FOREGROUND_MS = 15 \* 1000, POLL_BACKGROUND_MS = 60 \* 1000, BACKOFF_MS = 60 \* 1000, MIN_GAP_MS = 5 \* 1000;/.test(cloudSrc)
      && /if \(!force && now\(\) - lastTryAt < MIN_GAP_MS\) return snap;/.test(cloudSrc)
      && /ipcMain\.handle\("cloud-refresh", \(e\) => \{ if \(!fromOurPage\(e\)\) return null; cloudHost\(\)\.start\(\); return cloudHost\(\)\.refresh\(\)\.then/.test(mainSrc2)
      && !/refresh\(true\)/.test((mainSrc2.match(/ipcMain\.handle\("cloud-refresh"[^\n]*/) || [""])[0]));   // 那一支不可以帶 force——帶了就繞過地板
    // 接線:窗期間每輪都叫主行程重抓、每輪都重讀、tick 收到 2.5 秒;等到了就提早收窗
    const poll = fnS("trPoll");
    /* 接線。兩條是稽核抓出來的回歸:
       B-2 那一支**不可以 await**(它打網路、postJSON 逾時 20 秒,await 會把本機那一份狀態一起凍住);
       B-1 **不可以早收窗**——早收只認得 C.pending / trAmountsPending,而連接交易所、解除綁定、重新測試
       這三種雲端寫入都不設那兩個,窗一開就被下一輪當場關掉(等於沒開,而且那幾條路一個請求都沒多)。 */
    ok("接線:窗期間重抓(不 await)→ 重讀 → 2.5 秒一輪;而且不早收窗",
      /if \(burst && typeof window\.blave\.cloudRefresh === "function"\) window\.blave\.cloudRefresh\(\)\.catch\(\(\) => \{\}\);/.test(poll)
      && !/await window\.blave\.cloudRefresh/.test(poll)
      && /ENV\.cloudDirty \|\| C\.pending \|\| burst \|\|/.test(poll)
      && !/ENV\.burst = null/.test(poll));
    { /* 行為版:窗開著時**下一輪還活著**。B-1 的回歸只用 regex 看不出來——早收那一行在的時候
         regex 照樣通過,而窗其實已經被關掉了。這裡真的跑一次 trPoll 的收窗那一段。 */
      const tick = (bag, burstAt, now) => { const ENV2 = { burst: { start: burstAt, until: burstAt + TR_BURST_MS } };
        // trPoll 裡那一段(現在應該整段不存在):照原文有沒有那一行決定要不要跑
        if (/ENV\.burst = null/.test(poll)) { if (ENV2.burst && !bag.pending && !trAmountsPending2(bag)) ENV2.burst = null; }
        return trBurstOn(ENV2.burst, now); };
      const conn = { env: "cloud", cxSaved: { venue: "paper", at: T0b } };          // 連接交易所:只設 cxSaved
      const retest = { env: "cloud", cxPend: { what: "retest", at: T0b } };          // 重新測試:只設 cxPend
      const unbind = { env: "cloud", cxPend: { what: "unbind", at: T0b } };          // 解除綁定:同上
      const amt = { env: "cloud", sent: { a: 1 }, save: "sent", sentAt: T0b };
      ok("B-1 每一種雲端寫入開的窗,下一輪都還活著(連接 / 重新測試 / 解除綁定 / 存金額)",
        [conn, retest, unbind, amt].every((bag) => tick(bag, T0b, T0b + 1) === true)); }
    ok("觸發點:每一個雲端寫入(trSend 一處全收)+ 連接交易所;本機不開窗(本機沒有這條延遲)",
      /if \(S\.env === "cloud" && res && res\.ok\) ENV\.burst = trBurstBump\(ENV\.burst, Date\.now\(\), TR_BURST_MS, TR_BURST_MAX_MS\);/.test(fnS("trSend"))
      && /ENV\.burst = trBurstBump\(ENV\.burst, Date\.now\(\), TR_BURST_MS, TR_BURST_MAX_MS\);   \/\/ S5/.test(src));
    /* **等待那一態要一直看得見**:窗只是讓它短,不是把它繞過去。窗到期之後(報告還是沒來)
       畫面必須還是那句誠實的等待,而不是空白或永遠的 spinner——這一條紅了就代表那個狀態變成沒人看得到的狀態。 */
    const Vb = { paper: { credentials: true, pair: true, order: true, account: true } };
    const rb = { venues: Vb, config: { amounts: {} }, halt: {}, reconciler: { alive: false, heartbeat_at: 100 }, daemon: { reconciler: { running: false, wanted: false } } };
    ok("窗到期、報告還是沒來:等待那一態照樣在(鈕停用 + 帶數字那一句),不是空白也不是一直轉",
      trBurstOn(b1, T0b + TR_BURST_MS) === false && trZView("dead", rb).off === true
      && trPendKey({ env: "cloud", sent: { a: 1 }, save: "sent", sentAt: T0b }, T0b + TR_BURST_MAX_MS, true) === "tr.cloud.startPendSlow"
      && trPendKey({ env: "cloud", sent: { a: 1 }, save: "sent", sentAt: T0b }, T0b + TR_BURST_MAX_MS, false) === "tr.cloud.startPendSlow"); }
  { /* §3 載入態:一個視窗只講一次等待,而且通用的「載入中…」只有在三件事都不知道時才用 */
    const po3 = (l) => fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", l + ".po"), "utf8");
    const get3 = (l, k) => { const m = po3(l).match(new RegExp('msgid "' + k.replace(/\./g, "\\.") + '"\\nmsgstr "([^\\n]*)"')); return m ? m[1] : null; };
    ok("§3 標頭講在等誰,不再用通用的「載入中…」(雲端第一份報告 / 模擬剛存好兩條路都是)",
      /if \(state === "loading"\) return TR\.env === "cloud" \? t\("tr\.cloud\.hdFetching"\) : t\("tr\.loading"\);/.test(fnS("trStateText"))
      && get3("zh", "tr.cloud.hdFetching") === "正在跟你的主機要資料" && get3("en", "tr.cloud.hdFetching") === "Fetching data from your machine");
    const ob3 = fnS("trPaintOnboard");
    ok("§3 等待只講一次:內文那兩行不再附第二句「載入中…」;第 1 行兩條路各講各已經完成的事",
      !/t\("tr\.loading"\)/.test(fnS("trWaitTwoLines")) && get3("zh", "tr.cloud.machineUp") === "你的主機在跑。"
      && get3("zh", "tr.cloud.cxSavedPaperDone") === "模擬帳戶已存到雲端主機。"
      && (ob3.match(/tr\.loading/g) || []).length === 1);   // 只剩本機那條路的通用字
    ok("§3 第 2 行沿用 §5 定稿那句(在等誰 / 多久 / 會自己好 / 不用做事),沒有另寫一套", /t\("tr\.cloud\.cxWaiting"\)/.test(fnS("trWaitTwoLines"))
      && /^正在等主機確認，通常一兩分鐘。/.test(get3("zh", "tr.cloud.cxWaiting"))); }
  { // v2 §5:雲端 S5「等主機確認」
    const po = (l) => fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", l + ".po"), "utf8");
    const get = (l, k) => { const m = po(l).match(new RegExp('msgid "' + k.replace(/\./g, "\\.") + '"\\nmsgstr "([^\\n]*)"')); return m ? m[1] : null; };
    ok("S5 標頭:真實交易所存了、還沒回報 → 連接中…;過了 3 分鐘 → 沒有收到主機確認;模擬帳戶直接當已連接(畫骨架,標頭寫讀取中)", /if \(state === "noaccount" && TR\.env === "cloud" && TR\.cxSaved\) return trCxSavedStale\(TR\.cxSaved, Date\.now\(\)\) \? t\("tr\.cloud\.hdNoConfirm"\)\n\s*: trCxAssumed\(TR\.cxSaved, Date\.now\(\)\) \? t\("tr\.cloud\.hdFetching"\) : t\("tr\.cloud\.hdConnecting"\);/.test(fnS("trStateText"))
      && fnS("trStateText").indexOf("TR.cxSaved") < fnS("trStateText").indexOf("trNoAccountStopped(r) ?"));
    const ob = fnS("trPaintOnboard"), css = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.css"), "utf8");
    // 每一個 @media (prefers-reduced-motion …) 區塊的內容(數大括號)
    const rmBlocks = (c) => { const out = []; let i = c.indexOf("@media (prefers-reduced-motion"); while (i >= 0) { let d = 0, k = c.indexOf("{", i); const s0 = k; for (; k < c.length; k++) { if (c[k] === "{") d++; else if (c[k] === "}" && --d === 0) break; } out.push(c.slice(s0, k)); i = c.indexOf("@media (prefers-reduced-motion", k); } return out; };
    ok("S5 內文兩行:第一行已完成的事、第二行圓環 spinner + 正在等主機確認;沒有呼吸點", /ob\.appendChild\(trWaitTwoLines\("tr\.cloud\.cxSavedBn"\)\);/.test(ob) && !/dot busy/.test(ob)
      && /const wait = trEl\("p", "cx-saved cx-wait"\), sp = trEl\("span", "spin16"\);/.test(fnS("trWaitTwoLines")) && /t\("tr\.cloud\.cxWaiting"\)/.test(fnS("trWaitTwoLines"))
      && /if \(assumed \|\| \(state === "loading" && TR\.env === "cloud"\)\) \{ box\.appendChild\(trWaitTwoLines\(assumed \? "tr\.cloud\.cxSavedPaperDone" : "tr\.cloud\.machineUp"\)\); return; \}/.test(ob));
    ok("spinner 照 canon Loader:16/2、缺口 1/4、currentColor、1s linear;**沒有** reduced-motion 例外", /\.spin16 \{ flex: none; display: inline-block; width: 16px; height: 16px; box-sizing: border-box; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: trSpin 1s linear infinite; \}/.test(css)
      && !rmBlocks(css).some((b) => /spin16/.test(b)) && !rmBlocks(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "app.css"), "utf8")).some((b) => /spin16/.test(b)) && !/cx-saved \.dot/.test(css));
    ok("稽核 B3:最低版本閘擋下「解除暫停」時的字不叫人按啟動下單", /^這個版本的 Blave 需要更新，才能送出「解除暫停」。/.test(get("zh", "minv.release")) && !/啟動下單/.test(get("zh", "minv.release")) && !/Start trading/.test(get("en", "minv.release")));
    ok("狀態行的分隔符統一成「 · 」(不混「・」)", ["up.c.running", "up.c.chatRunning", "tr.runningZ"].every((k) => / · /.test(get("zh", k)) && !/・/.test(get("zh", k))));
    ok("§13-2 模擬帳戶逾時自己一句:不提金鑰、講「再試一次」;真實交易所那句不動", /^模擬帳戶已經送出，.*可以再試一次/.test(get("zh", "tr.cloud.cxSavedStalePaper")) && !/金鑰/.test(get("zh", "tr.cloud.cxSavedStalePaper"))
      && /^The paper account was sent,/.test(get("en", "tr.cloud.cxSavedStalePaper")) && /^金鑰已經送出，/.test(get("zh", "tr.cloud.cxSavedStale")));
    ok("S5 文字(zh / en)", get("zh", "tr.cloud.hdConnecting") === "連接中…" && get("en", "tr.cloud.hdNoConfirm") === "No confirmation from the machine" && get("zh", "tr.cloud.cxSavedPaper") === null
      && /^正在等主機確認，通常一兩分鐘。/.test(get("zh", "tr.cloud.cxWaiting")) && /^Waiting for the machine to confirm, usually a minute or two\./.test(get("en", "tr.cloud.cxWaiting"))); }
  { // v2 §9-1(列舉):Z 時任何狀態字都不叫人按「啟動下單」——那顆停用或根本不在。真的字串表、zh / en、兩個視角
    const vm = require("vm"), R = path.join(__dirname, "..", "shell", "renderer");
    const cutB = (x, y) => src.slice(src.indexOf(x), src.indexOf(y));
    const ctx = { LANG: "zh", Date, Math, Object, Array, String, Number, JSON, isFinite, isNaN, Set, Map };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(R, "strings.js"), "utf8").replace(/^const /gm, "var ") + "\n" + fs.readFileSync(path.join(R, "i18n.js"), "utf8").replace(/^(const|let) /gm, "var "), ctx);
    vm.runInContext((cutB("/* ── 純邏輯(", "/* ── 純邏輯到此") + cutB("/* ── 視角純邏輯(", "/* ── 視角純邏輯到此")).replace(/^const /gm, "var "), ctx);
    vm.runInContext(fnS("trStateText") + fnS("trShortState") + fnS("trReport"), ctx);
    ctx.trStamp = () => "09/21 22:26"; ctx.trKeyBad = () => false;
    const Vz = { paper: { credentials: true, pair: true, order: true, account: true } };
    const halts = [{}, { halted: true, source: "web" }, { halted: true, source: "reconciler" }, { halted: true, source: "portfolio" }];
    const recs = [{ alive: true }, { alive: false }, { alive: false, heartbeat_at: 100 }, { alive: false, stopped: { reason: "machine_restart", at: 1 } }, { alive: false, stopped: { reason: "machine_restart", at: 1, gated: true } }];
    const daemons = [undefined, { reconciler: { running: false, wanted: false } }, { reconciler: { running: false, wanted: true } }];
    const cfgs = [{ amounts: {} }, { amounts: { a: 0 } }, undefined];
    const hosts = [{ alive: true, running: true }, { alive: false, running: false, lastExit: { code: 1, at: Date.now() }, restarts: 1 }];
    const bad = []; let n = 0;
    ["zh", "en"].forEach((lang) => { vm.runInContext("LANG = " + JSON.stringify(lang), ctx);
      [Vz, {}].forEach((venues) => halts.forEach((halt) => recs.forEach((reconciler) => daemons.forEach((daemon) => cfgs.forEach((config) => hosts.forEach((host) => ["local", "cloud"].forEach((env) => {
        const report = { venues, halt, reconciler, ...(daemon ? { daemon } : {}), ...(config ? { config } : {}), account: { venues: { paper: { ok: true, equity: 1000 } } } };
        const st = { ...host, report, ...(env === "cloud" ? { cloud: { code: "OK", machine: { state: "running" } } } : {}) };
        ctx.TR = { env, st }; vm.runInContext("var TR = this.TR", ctx);
        const state = vm.runInContext("trExecState(TR.st)", ctx), z = vm.runInContext("trNoAmounts(TR.st.report) || trNoAccountStopped(TR.st.report)", ctx);
        if (!z) return;
        n++;
        const texts = [vm.runInContext("trStateText(" + JSON.stringify(state) + ")", ctx), vm.runInContext("trShortState(" + JSON.stringify(state) + ")", ctx)];
        const zv = vm.runInContext("trZView(" + JSON.stringify(state) + ", TR.st.report)", ctx); if (zv.reason) texts.push(vm.runInContext("t(" + JSON.stringify(zv.reason) + ")", ctx));
        // §12:「尚未啟動下單」是狀態描述(不需要 Z 變體),先拿掉再查「叫人按鈕」的字
        const notStarted = vm.runInContext('t("tr.notStarted")', ctx);
        if (texts.some((x) => /啟動下單|Start trading/i.test(String(x).split(notStarted).join("")))) bad.push(lang + "/" + env + "/" + state + ": " + texts[0]);
      })))))));
    });
    ok("§9-1 列舉:Z 的每一種報告(" + n + " 種,zh / en × 本機 / 雲端 × 下單機在不在)狀態行、頂列短詞、原因行都沒有「啟動下單」/ Start trading" + (bad.length ? ":" + bad.slice(0, 2).join(" | ") : ""), n > 500 && bad.length === 0);
    vm.runInContext('LANG = "zh"', ctx);
    const one = (report, st0) => { ctx.TR = { env: "local", st: { alive: true, running: true, ...st0, report } }; vm.runInContext("var TR = this.TR", ctx); return vm.runInContext("trStateText(trExecState(TR.st))", ctx); };
    { // §12:狀態句只講發生了什麼(不提金額、不提鈕);出口只在原因行。B0 是唯一保留出口的狀態句
      const Vz2 = { paper: { credentials: true, pair: true, order: true, account: true } };
      const cases = [["A′", { venues: Vz2, config: { amounts: {} }, halt: { halted: true, source: "reconciler" }, reconciler: { alive: true } }],
        ["B(本機、有 HALT)", { venues: Vz2, config: { amounts: {} }, halt: { halted: true, source: "web" }, reconciler: { alive: false, heartbeat_at: 100 }, daemon: { reconciler: { running: false, wanted: false } } }],
        ["B(本機、沒 HALT)", { venues: Vz2, config: { amounts: {} }, halt: {}, reconciler: { alive: false, heartbeat_at: 100 }, daemon: { reconciler: { running: false, wanted: false } } }],
        ["dead", { venues: Vz2, config: { amounts: {} }, halt: {}, reconciler: { alive: false, heartbeat_at: 100 }, daemon: { reconciler: { running: false, wanted: true } } }]];
      vm.runInContext('LANG = "zh"', ctx);
      const bad2 = cases.filter(([, r]) => { const txt = one(r); return /還沒有策略設定金額|解除暫停|「部位」/.test(txt); });
      ok("§12 Z 的狀態句不提金額、不提鈕(A′ / B 雲端 / B 本機兩種 / dead)" + (bad2.length ? ":" + bad2[0][0] + " → " + one(bad2[0][1]) : ""), bad2.length === 0
        && /主機重開過，什麼單都不下——部位現在沒有人在管/.test(one({ venues: Vz2, config: { amounts: {} }, halt: {}, reconciler: { alive: false, stopped: { reason: "machine_restart", at: 1 } } })));
      ok("§12 A(用戶自己按的暫停)與「尚未啟動下單」不需要 Z 變體:原句本來就沒提鈕", /: rec\.heartbeat_at \? t\("tr\.notStarted"\) \+ " · " \+ t\("tr\.lastRun"[^\n]*\) : t\("tr\.notStarted"\);/.test(fnS("trStateText"))
        && !/tr\.notStartedZ|tr\.haltReasonZ/.test(src) && /不開新倉；平倉與停損停利照常執行。/.test(one({ venues: { paper: { credentials: true, pair: true, order: true, account: true } }, config: { amounts: {} }, halt: { halted: true, source: "web" }, reconciler: { alive: true } })));
      ok("§12 B0 是唯一保留出口的狀態句(它沒有停用的啟動鈕,也就沒有原因行)", /按「解除暫停」恢復放行。$/.test(one({ venues: {}, config: { amounts: {} }, halt: {}, reconciler: { alive: false, stopped: { reason: "machine_restart", at: 1 } } }))
        && trZView("noaccount", { venues: {}, config: { amounts: {} }, halt: {}, reconciler: { alive: false, stopped: { reason: "machine_restart", at: 1 } } }).reason === null);
      // 驗收:一個標頭裡「還沒有策略設定金額」只出現一次(狀態句 + 原因行合起來算)
      const once = cases.concat([["B(雲端)", { venues: Vz2, config: { amounts: {} }, halt: {}, reconciler: { alive: false, stopped: { reason: "machine_restart", at: 1 } } }]])
        .map(([n2, r]) => { const zv2 = trZView(vm.runInContext("trExecState({ alive: true, running: true, report: this.R })", Object.assign(ctx, { R: r })), r);
          const full = one(r) + (zv2.reason ? vm.runInContext("t(" + JSON.stringify(zv2.reason) + ")", ctx) : ""); return [n2, (full.match(/還沒有策略設定金額/g) || []).length]; });
      ok("§12 驗收:任一 Z 狀態的標頭裡「還沒有策略設定金額」只出現一次" + JSON.stringify(once), once.every(([, c]) => c === 1));
      // 驗收(代理指標):en 1024 的標頭 ≤ 6 行 —— harness 量不到排版,改鎖字數(稽核量到原本 216px / 8+4 行,砍掉尾巴後約 130px)
      vm.runInContext('LANG = "en"', ctx);
      const lens = cases.map(([n2, r]) => [n2, one(r).length]);
      ok("§12 驗收(代理):en 的 Z 狀態句都 ≤ 150 字元" + JSON.stringify(lens), lens.every(([, L]) => L <= 150));
      vm.runInContext('LANG = "zh"', ctx); } }
  console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
})();

