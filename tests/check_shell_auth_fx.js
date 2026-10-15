// Mac e2e 10-14 的兩個 bug(不起 Electron):
//   ① 組合有台指期、缺 TWD 匯率時「套用金額」被停用卻沒說明:停用時一定寫原因;匯率有本機退路(上次拿到的那一份,標 ≈ 與日期)
//   ② 登入狀態前後矛盾(帳號頁寫「已登入」、別處寫「登入已失效」):主行程 authState 是單一來源,REVOKED 時每一處同一句 + 登入鈕
// 跑法:node tests/check_shell_auth_fx.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
let red = 0; const ok = (name, c, info) => { console.log((c ? "PASS  " : "FAIL  ") + name + (c || !info ? "" : "\n      " + info)); if (!c) red++; };
const J = JSON.stringify;
const read = (f) => fs.readFileSync(f, "utf8");
const cutF = (s, n) => { const i = s.indexOf("function " + n + "("); if (i < 0) throw new Error("no " + n); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unclosed " + n); };
const trade = read(path.join(R, "trade.js")), pf = read(path.join(R, "portfolio.js")), app = read(path.join(R, "app.js")), main = read(path.join(SHELL, "main.js"));
const S = read(path.join(R, "strings.js"));

// ① 匯率退路
{ const store = {}, ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const ctx = vm.createContext({ JSON, Date, localStorage: ls, TR_BAGS: { cloud: { st: null } } });
  vm.runInContext(cutF(trade, "trFxView"), ctx);
  ctx.TR_BAGS.cloud.st = { cloud: { code: "OK", fx_rates: { USD: 1, TWD: 32 }, currency: "USD" } };
  const live = vm.runInContext("trFxView()", ctx);
  ctx.TR_BAGS.cloud.st = { cloud: { code: "REVOKED" } };
  const cached = vm.runInContext("trFxView()", ctx);
  const empty = (() => { const c2 = vm.createContext({ JSON, Date, localStorage: { getItem: () => null, setItem() {} }, TR_BAGS: { cloud: { st: { cloud: { code: "REVOKED" } } } } }); vm.runInContext(cutF(trade, "trFxView"), c2); return vm.runInContext("trFxView()", c2); })();
  ok("匯率:雲端那份有 → 照用並記在這台電腦;登入失效拿不到 → 用上次那份、標 cached(拿到的時間);一次都沒拿過 → null",
    live.fx.TWD === 32 && !live.cached && cached.fx && cached.fx.TWD === 32 && typeof cached.cached === "number" && empty.fx === null, J({ live, cached, empty })); }
ok("用的是上次存下的匯率時,優化表下講是哪一天的(≈);字串兩語", /if \(fv\.cached && d\.rows\.some/.test(pf) && /t\("mg\.fxCached", \{ d: new Date\(fv\.cached\)\.toISOString\(\)\.slice\(0, 10\) \}\)/.test(pf)
  && S.includes('"mg.fxCached": "台幣換算用 {d} 的匯率（≈），登入後會更新"'));

// ① 停用原因
{ const ctx = vm.createContext({ TR: { save: null, env: "local", listLoaded: true, st: { alive: true } }, TR_BAGS: { cloud: { st: { cloud: { code: "OK" } } } }, trFxView: () => ({ fx: null, base: "USD" }),
    mgSameAsAmounts: () => true, trCfgUnread: () => false, trReport: () => ({}), trStored: () => ({}) });
  vm.runInContext(cutF(pf, "mgApplyWhy"), ctx);
  const why = (d, q, ch) => vm.runInContext("mgApplyWhy(" + J(d) + ", " + J(q) + ", " + J(ch) + ")", ctx);
  const fxRow = { rows: [{ fxMissing: true }], eff: 100 }, quoteRow = { rows: [{ fxMissing: false }], eff: 100 };
  const okFx = why(fxRow, true, true);
  ctx.TR_BAGS.cloud.st.cloud.code = "REVOKED"; const revFx = why(fxRow, true, true);
  ctx.TR_BAGS.cloud.st.cloud.code = "OK";
  ok("套用金額停用一定有原因:缺匯率 + 登入失效 → 叫人登入;登入正常缺匯率 → 缺台幣匯率;匯率有缺報價 → 等報價;沒有投入資金 → 先設定;跟目前一樣 → 一樣;兩邊策略不同組 → 原句",
    revFx === "mg.applyWhyLogin" && okFx === "mg.applyWhyFx" && why(quoteRow, true, true) === "mg.applyWhyQuote" && why({ rows: [], eff: null }, false, true) === "mg.applyWhySize"
    && why({ rows: [], eff: 100 }, false, false) === "mg.applyWhySame" && (ctx.mgSameAsAmounts = () => false, why(fxRow, true, true)) === "mg.applyDiffSet", J([revFx, okFx]));
  ok("原因寫在鈕旁那一格(每次停用條件重算時一起寫);字串兩語",
    /if \(whyEl\) whyEl\.textContent = ap\.disabled \? t\(mgApplyWhy\(d, quoteMissing, changed\)\) : "";/.test(pf)
    && S.includes('"mg.applyWhyLogin": "需要登入 Blave 才拿得到台幣匯率，台指期口數換算不出來"') && /"mg\.applyWhyLogin": "Sign in to Blave/.test(S)); }

// ② 登入狀態單一來源
ok("主行程 authState:沒 token → out;帳號那一支 401／403(輪替救不回)或雲端 REVOKED／NO_APP_SECRET → revoked;任何 200、存了新 token → in;auth-state IPC",
  /function authState\(\) \{ return !loadToken\(\) \? "out" : authRevoked \? "revoked" : "in"; \}/.test(main) && /function saveToken\(tok\) \{\n  authRevoked = false;/.test(main)
  && /if \(r\.status === 401 \|\| \(r\.status === 403 && r\.body && r\.body\.error_code === "ACCOUNT_TOKEN_INVALID"\)\) \{ if \(currentWho\(\) === who\) authRevoked = true; return null; \}/.test(main)
  && /snap\.code === "REVOKED" \|\| snap\.code === "NO_APP_SECRET"\)\) authRevoked = true; else if \(snap && snap\.code === "OK"\) authRevoked = false;/.test(main)
  && /handle\("auth-state", \(\) => authState\(\), "out"\);/.test(main) && /authState: \(\) => ipcRenderer\.invoke\("auth-state"\)/.test(read(path.join(SHELL, "preload.js"))));
{ const ctx = vm.createContext({ hasToken: true, AUTH: { revoked: false }, TR_BAGS: { cloud: { st: { cloud: { code: "OK" } } } }, acct: null });
  vm.runInContext(cutF(app, "authRevoked"), ctx);
  const a1 = vm.runInContext("authRevoked()", ctx);
  ctx.AUTH.revoked = true; const a2 = vm.runInContext("authRevoked()", ctx);
  ctx.AUTH.revoked = false; ctx.TR_BAGS.cloud.st.cloud.code = "REVOKED"; const a3 = vm.runInContext("authRevoked()", ctx);
  ctx.hasToken = false; const a4 = vm.runInContext("authRevoked()", ctx);
  ok("畫面的 authRevoked:主行程說 revoked 或雲端狀態 REVOKED 都算;沒登入不算(那是「沒登入」)", a1 === false && a2 === true && a3 === true && a4 === false); }
{ const ctx = vm.createContext({}); vm.runInContext(cutF(trade, "envOpenView"), ctx);
  ok("雲端分頁:帳號那一支說登入失效(planView revoked)也進「請重新登入」那一格,跟帳號頁同一個狀態", vm.runInContext('envOpenView("ok", true, "revoked")', ctx) === "relogin"); }
ok("設定 › 帳號與方案:登入失效時不寫「已登入」、不講網路問題——帳號列「登入已失效」、卡片標題「請重新登入」、一顆登入鈕(不重講三次)",
  /if \(typeof authRevoked === "function" && authRevoked\(\)\) return "revoked";/.test(app) && /revoked:  \{ h: "pv\.h\.revoked", lead: "", acts: \[planLoginBusy \? btn\("btn-out", t\("oauth\.cancel"\), planLogin\) : btn\("btn-fill", t\("pv\.signin"\), planLogin\)\] \}/.test(app)
  && /t\(!hasToken \? "acct\.signedOut" : rv \? "acct\.revoked" : "acct\.signedIn"\)/.test(app));
ok("每一處同一句:conn.expired(帳號頁、公開連結、分享)= 「登入已失效，請重新登入。」;雲端分頁那句同開頭",
  S.includes('"conn.expired": "登入已失效，請重新登入。"') && S.includes('"env.empty.relogin": "登入已失效，請重新登入。這台電腦上的對話與策略不受影響。"')
  && S.includes('"acct.revoked": "登入已失效"') && S.includes('"conn.expired": "Your Blave sign-in has expired. Please sign in again."'));

// 第二輪 e2e:暫停的原因照 HALT 實際寫的講——解除綁定造成的不講成「Blave 重開過」
{ const pure = trade.slice(trade.indexOf("/* ── 純邏輯("), trade.indexOf("/* ── 純邏輯到此"));
  const ctx = vm.createContext({ t: (k) => k, JSON, Object, Array, String, Number, Math, Date, isFinite, Set, Map, console, TR: { list: [] } });
  vm.runInContext(pure.replace(/^const /gm, "var "), ctx);
  const V = { paper: { credentials: true, pair: true, order: true, account: true } };
  const base = (o) => Object.assign({ venues: V, config: { amounts: { a: 1 } }, states: {}, halt: { halted: true, reason: "exchange unbound (paper)", source: "web" }, reconciler: { alive: true, heartbeat_at: 9 } }, o || {});
  const why = (r) => vm.runInContext("trHaltReasonText(" + J(r) + ", null)", ctx);
  const off = why(base({ daemon: { reconciler: { running: false, wanted: false } }, reconciler: { alive: false, heartbeat_at: 9 } }));
  const never = why(base({ reconciler: { alive: false } })), died = why(base({ reconciler: { alive: true, heartbeat_at: 9 }, daemon: { reconciler: { running: false, wanted: true } } }));
  ok("HALT 原因是解除綁定:對帳器真的活著才講「平倉與停損停利照常執行」(tr.haltUnbound);重開後沒在跑、從沒啟動過、自己掛了都講「什麼單都不下」(tr.haltUnboundOff);別的原因照舊",
    why(base()) === "tr.haltUnbound" && off === "tr.haltUnboundOff" && never === "tr.haltUnboundOff" && died === "tr.haltUnboundOff" && why(base({ halt: { halted: true, reason: "desktop ui", source: "desktop" } })) !== "tr.haltUnbound", J([why(base()), off, never, died]));
  // 稽核 r4 P2:沒有路由、帳本上又有部位 → 不是可按的「啟動下單」(按了會被 NEEDS_ROUTING 拒)
  const zv = vm.runInContext("trZView('halted', " + J(base({ config: { amounts: { a: 1 }, exchanges: { a: "" } }, last_reconcile: { ledger: { BTCUSDT: { side: "long", size: 5 } } } })) + ")", ctx);
  ok("沒有路由、帳本上有部位:啟動下單停用、原因講要先存(不是 tr.startOnBook)", zv.off === true && zv.reason === "tr.startOffNoAmt", J(zv)); }
// 稽核 r4 P2:匯率快取期限——7 天以上確認框講日期;超過 30 天不用、套用停用並講原因
{ const mk = (ageDays) => { const ls = { getItem: () => JSON.stringify({ fx: { USD: 1, TWD: 32 }, base: "USD", at: Date.now() - ageDays * 86400000 }), setItem() {} };
    const ctx = vm.createContext({ JSON, Date, localStorage: ls, TR_BAGS: { cloud: { st: { cloud: { code: "REVOKED" } } } } }); vm.runInContext(cutF(trade, "trFxView"), ctx); return vm.runInContext("trFxView()", ctx); };
  const d10 = mk(10), d40 = mk(40);
  ok("匯率快取:10 天前的照用(cached);40 天前的不用(fx null、expired)", d10.fx && d10.cached && d40.fx === null && typeof d40.expired === "number", J([d10, d40]));
  ok("確認框:用 7 天以上前的匯率時講日期(tr.fxOld);套用停用原因:超過 30 天 → mg.applyWhyFxOld",
    /if \(fv\.cached && Date\.now\(\) - fv\.cached > 7 \* 86400000\) extra\.appendChild\(trEl\("p", "cf-note", t\("tr\.fxOld"/.test(trade) && /if \(trFxView\(\)\.expired\) return "mg\.applyWhyFxOld";/.test(pf)
    && S.includes('"tr.fxOld": "台幣換算用的是 {d} 的匯率（≈），登入後會更新。"')); }

// Windows e2e 10-14 的 P3:模擬交易的淨值倍數算進台指期;成交過的標的不再掛舊失敗;錯誤不給英文路徑;優化分頁剔除幽靈成員、零策略霧化、錯誤翻成句子
{ const pure = trade.slice(trade.indexOf("/* ── 純邏輯("), trade.indexOf("/* ── 純邏輯到此"));
  const ctx = vm.createContext({ t: (k) => k, JSON, Object, Array, String, Number, Math, Date, isFinite, Set, Map, console, TR: { list: [] } });
  vm.runInContext(pure.replace(/^const /gm, "var "), ctx);
  const fx = { USD: 1, USDT: 1, TWD: 32 }, zoneOf = (n) => (n === "txf" ? "lots" : "USDT"), money = (n, a) => (n === "txf" ? a * 200 * 20000 : a);
  ctx.__a = [fx]; ctx.__z = zoneOf; ctx.__m = money;
  const m = vm.runInContext("trEquityMult({ sol: 60000, txf: 1 }, __z, __m, 'paper', 'USDT', 100000, __a[0])", ctx);
  ok("模擬交易:淨值倍數算進台指期(60,000 USDT + 1 大台 4,000,000 TWD ≈ 125,000 USD → 1.85×)", Math.abs(m - (60000 + 4000000 / 32) / 100000) < 1e-9, String(m));
  const errs = [{ ts: "2026-10-14T16:51:00", symbol: "DOGEUSDT", exchange: "paper", error: "[WinError 5] Access is denied: 'state/x.tmp'" }];
  const live = (orders) => vm.runInContext("trLiveOrderErrs(" + JSON.stringify(errs) + ", new Set(['DOGEUSDT']), { open: new Set(), running: false, orders: " + JSON.stringify(orders) + " })", ctx).size;
  ok("部位表的舊失敗:之後同一標的有成交的單 → 不掛;之後沒成交(或成交在失敗之前)→ 照掛",
    live([{ ts: "2026-10-14T16:55:00", symbol: "DOGEUSDT", exchange: "paper", legs: [{ executed_qty: 100 }] }]) === 0 && live([]) === 1
    && live([{ ts: "2026-10-14T16:40:00", symbol: "DOGEUSDT", exchange: "paper", legs: [{ executed_qty: 100 }] }]) === 1 && live([{ ts: "2026-10-14T16:55:00", symbol: "DOGEUSDT", exchange: "paper", legs: [{ executed_qty: 0 }] }]) === 1);
  ok("錯誤不給英文路徑:WinError 5 / Access is denied → tr.err.fileLocked;其他錯誤裡的完整路徑換成「…」",
    vm.runInContext("trRejectText(\"RuntimeError: [WinError 5] Access is denied: 'C:\\\\cleanwin\\\\x.json'\")", ctx) === "tr.err.fileLocked"
    && !/Users/.test(vm.runInContext("trRejectText(\"ValueError: bad file /Users/wei/Blave/x.json here\")", ctx)));
  const masked = ["/private/var/folders/x/y.json", "/Library/Application Support/x", "~/Blave/workspace/a.py", "C:\\Users\\wei\\Blave\\x.json", "'/opt/blave/x'", "\"C:\\cleanwin\\y\""]
    .map((p) => vm.runInContext("trRejectText(" + JSON.stringify("ValueError: cannot read " + p + " now") + ")", ctx));
  ok("路徑全遮:/private/var、/Library、~/、C:\\Users\\…、引號包住的(單、雙引號)都換成「…」", masked.every((x) => !/private|Library|~\/|Users|opt\/blave|cleanwin/.test(x) && /…/.test(x)), J(masked)); }
ok("優化分頁:已經不存在的成員剔掉(存回 localStorage);一支有回測的策略都沒有 → 霧化 + 選擇策略;member has no backtest stats → mg.errNoStats",
  /const live = all\.filter\(\(n\) => TR\.list\.some\(\(x\) => x\.name === n\)\);/.test(pf) && /if \(TR\.listLoaded && !TR\.list\.some\(\(x\) => x\.hasBacktest\)\) \{\n    if \(box\.dataset\.fog !== "1"\) \{ box\.textContent = ""; box\.appendChild\(poFog\("pick"\)\);/.test(pf)
  && (pf.match(/\/no backtest stats\/i\.test\(e\) \? t\("mg\.errNoStats"\)/g) || []).length === 2);
// runtime SAVE_FAILED、英文「and {n} more」、第一次真錢啟動的說明只在啟動 ack 成功才記成看過
{ const pres = read(path.join(R, "president.js"));
  const ctx = vm.createContext({ store: {}, lsSet(k, v) { ctx.store[k] = v; }, PRES_FIRST_KEY: "tr_pres_first_ok" });
  vm.runInContext("var PRES_FIRST_ARMED = false;\n" + cutF(pres, "presFirstDone"), ctx);
  vm.runInContext("presFirstDone()", ctx); const notArmed = ctx.store.tr_pres_first_ok;
  vm.runInContext("PRES_FIRST_ARMED = true; presFirstDone()", ctx);
  ok("第一次真錢啟動的說明:按「確定」只是待記,啟動 ack 成功(trRun want running)才記成看過;被拒／取消不記",
    notArmed === undefined && ctx.store.tr_pres_first_ok === "1" && /onOk: \(\) => \{ PRES_FIRST_ARMED = true;/.test(pres) && !/onOk: \(\) => \{ lsSet\(PRES_FIRST_KEY/.test(pres)
    && /if \(want === "running" && typeof presFirstDone === "function"\) presFirstDone\(\);/.test(trade)); }
ok("SAVE_FAILED 翻成句子(兩語);英文「and {n} more」同網頁",
  /if \(rc\.code === "SAVE_FAILED"\) return t\("tr\.saveFailed\.rejected"\);/.test(trade) && S.includes('"tr.saveFailed.rejected": "設定檔暫時寫不進去，這次什麼都沒改，請再存一次。"')
  && S.includes('"tr.rejMore": " and {n} more"') && S.includes('"tr.opt.catchMore": "and {n} more"'));
// Mac e2e 第三輪:解除綁定的確認框照新行為寫——策略組合與金額保留(runtime 只清路由)、模擬帳戶權益重新開始(lib/order_paper 重設帳本)、成交紀錄保留
ok("解除綁定確認框:不再說「下單設定會一併清空／部位與紀錄不會帶過去」;三句(模擬、這台電腦、雲端)都講策略組合和金額保留、重新綁定後存一次;模擬講權益重新開始(不寫死 100,000:回報沒有初始權益這個欄位)、成交紀錄保留",
  ["tr.unbindWarnPaper", "tr.unbindWarn", "tr.cloud.unbindWarn"].every((k) => { const all = [...S.matchAll(new RegExp('"' + k.replace(/\./g, "\\.") + '": "([^"]*)"', "g"))].map((m) => m[1]); const zh = all.find((x) => /[\u4e00-\u9fff]/.test(x)) || "";
    return all.length === 2 && /策略組合和金額會保留/.test(zh) && /存一次就能繼續下單/.test(zh) && !/一併清空|不會帶過去/.test(zh) && all.some((x) => /portfolio and amounts are kept/.test(x)); })
  && /"tr\.unbindWarnPaper": "[^"]*權益與部位會重新開始；成交紀錄保留。"/.test(S) && !/"tr\.unbindWarnPaper": "[^"]*100,000/.test(S) && !/order settings are (also )?cleared/i.test(S));
console.log(red ? `\n${red} 項沒過` : "\nALL PASS"); process.exit(red ? 1 : 0);
