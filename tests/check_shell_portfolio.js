// 策略組合頁(0.1.24;shell/renderer/portfolio.js + trade.js 的配置分頁、shell/daemon.js 的優化指令)。不起 Electron。
//   ① 優化與部位大小的純邏輯(選擇比對、資料不足、複利回撤、反推槓桿)
//   ② 台指期換合約:口數換算、兩步存檔、錯誤碼人話、總訊號部位的口數取整
//   ③ shell/daemon.js:manage_* 只在這台電腦開、形狀檢查、優化等 ack 的時間
//   ④ 設計 desktop-portfolio-spec §9.1 #15:沒連交易所存金額不開確認框;連 Binance 時台股列的實際是「—」;自動下單 › 部位沒有金額輸入框
//   ⑤ 部位大小設好就維持(Wei 10-16):按確定 / 套用釘值、跑優化不跟著走、換幣別換算、最大回撤不被退回值蓋掉、重開(本機 localStorage、雲端 ui-prefs.json 綁 who)
// 跑法:node tests/check_shell_portfolio.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "trade.js"), "utf8"), psrc = fs.readFileSync(path.join(R, "portfolio.js"), "utf8"), html = fs.readFileSync(path.join(R, "index.html"), "utf8");
let red = 0; const ok = (name, c, info) => { console.log((c ? "PASS  " : "FAIL  ") + name + (c || !info ? "" : "\n      " + info)); if (!c) red++; };
const J = JSON.stringify;
const block = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b); if (i < 0 || j < 0) throw new Error("找不到標記:" + a); return s.slice(i, j); };
const cutF = (s, n) => { const i = s.indexOf("function " + n + "("); if (i < 0) throw new Error("no " + n); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("no " + n); };

// ── ① 純邏輯 ──
const pp = block(psrc, "/* ── 純邏輯(", "/* ── 純邏輯到此");
ok("portfolio.js 的純邏輯區塊不碰 DOM", !/\bdocument\b|\$\(|window\./.test(pp.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
const P = {}; vm.runInNewContext(pp.replace(/^const /gm, "var ") + "\nthis.out = { mgSameSel, mgShortDaysOf, mgFitParams, mgWeightPct, mpsSizingClean, mpsSeriesOf, mpsMddAt, mpsSolveLev, mpsLevFor, mgErrLine, mpsChipParts, mgBeatsOf, mpsFundAs, mpsSizingPin, mpsTargetOf, mgLotsOver };", P);
const F = P.out;
ok("移動窗格回測各指標的贏過:三個欄位各自取整;舊 workspace 只有 Sharpe 時另兩格不畫",
  J(F.mgBeatsOf({ managed_beats_pct_total_return: 61.4, managed_beats_pct_sharpe: 85.5, managed_beats_pct_max_drawdown: 12 })) === J({ ret: "61%", sharpe: "86%", mdd: "12%" })
  && J(F.mgBeatsOf({ managed_beats_pct_sharpe: 85 })) === J({ ret: null, sharpe: "85%", mdd: null }) && J(F.mgBeatsOf({})) === J({ ret: null, sharpe: null, mdd: null }));
ok("內建方法「最佳化 Sharpe」有自己的介面字(不吃機器 display_name)", /name === MG_SHARPE\) return t\("mg\.sharpe"\)/.test(psrc) && /MG_SHARPE \? t\("mg\.sharpeDesc"\)/.test(psrc));
{ const prop = { members: ["b", "a"], allocator: null, params: { lookback: 180 } };
  ok("選擇比對:成員順序不管、舊腳本的 allocator null = slope、走查窗雙方都釘住才比", F.mgSameSel(prop, ["a", "b"], "slope", { lookback: 180 }) && !F.mgSameSel(prop, ["a"], "slope", { lookback: 180 })
    && !F.mgSameSel(prop, ["a", "b"], "equal", {}) && !F.mgSameSel(prop, ["a", "b"], "slope", { lookback: 90 }) && F.mgSameSel({ members: ["a", "b"], allocator: "equal", lookback: 0 }, ["a", "b"], "equal", {})); }
ok("資料不足:從回測 log 尾抓歷史天數(不 anchor 行首);認不得 null", F.mgShortDaysOf("Traceback…\nValueError: insufficient history: 120 days <= lookback 365") === 120 && F.mgShortDaysOf("boom") === null);
ok("參數:只收方法宣告的 key、target_vol 永遠排除、現值在範圍內才沿用", J(F.mgFitParams({ params: { lookback: 365, target_vol: 0.3, x: true } }, { lookback: 90, x: false, zz: 1 })) === J({ lookback: 90, x: false })
  && J(F.mgFitParams({ params: { lookback: 365 } }, { lookback: 5 })) === J({ lookback: 365 }));
ok("權重 %:整數就整數、非整數留 1 位;壞值 null", F.mgWeightPct(0.25) === "25" && F.mgWeightPct(0.1234) === "12.3" && F.mgWeightPct(NaN) === null);
ok("部位大小設定清理:壞值回預設(目標波動、全部 null)", J(F.mpsSizingClean({ fund: -1, method: "x", target: { vol: 12, mdd: "a" } })) === J({ fund: null, fundCcy: null, method: "vol", target: { vol: 12, mdd: null, lev: null } })
  && F.mpsSizingClean({ fund: 5, fundCcy: "TWD" }).fundCcy === "TWD" && F.mpsSizingClean({ fund: 5, fundCcy: "twd" }).fundCcy === null && F.mpsSizingClean({ fundCcy: "TWD" }).fundCcy === null);
{ const r = [0.1, -0.2, 0.05, -0.1];
  ok("複利回撤:1× 序列 +10% −20% +5% −10% 的最深回撤 = 24.4%;淨值歸零以下 = 100", Math.abs(F.mpsMddAt(1, r) - 24.4) < 1e-9 && F.mpsMddAt(10, r) === 100);
  const L = F.mpsSolveLev(15, r);
  ok("反推槓桿:目標回撤 15% → 回撤真的落在 15%;到上限都達不到(或沒有回撤)回 null", L > 0 && Math.abs(F.mpsMddAt(L, r) - 15) < 1e-6 && F.mpsSolveLev(150, r) === null && F.mpsSolveLev(10, [0.01, 0.01]) === null);
  const prop = { ann_vol_pct: 20, port_returns: { r } };
  ok("隱含槓桿:目標波動 30% / 歷史 20% = 1.5×;固定槓桿照填;預設(null)= 1×", F.mpsLevFor({ method: "vol", target: { vol: 30, mdd: null, lev: null } }, prop) === 1.5
    && F.mpsLevFor({ method: "lev", target: { vol: null, mdd: null, lev: 2 } }, prop) === 2 && F.mpsLevFor({ method: "vol", target: { vol: null, mdd: null, lev: null } }, prop) === 1);
  ok("主機沒有 port_returns(舊版)或序列有洞:選最大回撤退回目標波動,不讓整張表變「—」", F.mpsLevFor({ method: "mdd", target: { vol: 40, mdd: 15, lev: null } }, { ann_vol_pct: 20 }) === 2 && F.mpsSeriesOf({ port_returns: { r: [0.1, NaN] } }) === null); }
ok("部位大小鈕摘要(同網頁 a8239131):「投入金額 幣別 · 方法 目標」,三種方法同格式、不寫槓桿倍數;去掉多餘的 0;投入資金算不出來就只寫「方法 目標」(不寫「—」)",
  J(F.mpsChipParts(100000, "USD", "vol", 30)) === J({ fund: "100,000", ccy: "USD", target: "30%" }) && F.mpsChipParts(100000, "USD", "mdd", 12.5).target === "12.5%"
  && F.mpsChipParts(5e4, "USDT", "lev", 1.5).target === "1.5×" && J(F.mpsChipParts(null, "USD", "vol", 30)) === J({ fund: null, ccy: null, target: "30%" }) && F.mpsChipParts(1, "USD", "vol", null).target === null
  && /if \(p\.fund\) \{ b\.appendChild\(trEl\("span", "v mono", p\.fund\)\);/.test(psrc) && !/"—"/.test(cutF(psrc, "mgSizeChip")) && !/toFixed\(2\) \+ "×"/.test(cutF(psrc, "mgSizeChip")));
{ const ctx = vm.createContext({}); vm.runInContext(cutF(src, "trHostOld") + "\nvar R = null; function trReport() { return R; }", ctx);
  const H = (r) => { ctx.R = r; return vm.runInContext("trHostOld()", ctx); };
  ok("主機版本較舊(同網頁 pfHostOld):訊號凍住、或 can_trade_portfolio 不是 true(缺席也算)才成立",
    H({ can_trade_portfolio: true }) === false && H({ can_trade_portfolio: true, signals_frozen: { since: 1, pending: [] } }) === true && H({}) === true && H({ can_trade_portfolio: false }) === true && H({ can_trade_portfolio: true, signals_frozen: null }) === false);
  ok("「還沒有訊號」與 Type C「下次執行後算出成分」在主機舊時改寫 po.hostOld;tr.noSignalYet 退場",
    /trHostOld\(\) \? t\("po\.hostOld"\) : t\("tr\.typecPending"\)/.test(src) && (src.match(/t\("po\.hostOld"\)/g) || []).length === 3 && !/tr\.noSignalYet/.test(src)); }
ok("錯誤只留最後一行、截 300 字", F.mgErrLine("a\nb\n\n") === "b" && F.mgErrLine("x".repeat(400)).length === 300);

// ── ② 台指期換合約(trade.js 純邏輯)──
const tp = block(src, "/* ── 純邏輯(", "/* ── 純邏輯到此");
const T = {}; vm.runInNewContext(tp.replace(/^const /gm, "var ") + "\nthis.out = { trCtConv, trCtConvStep, trCtSteps, trCtErrKey, trLotsTarget, trRoundLots };", T);
const C = T.out;
ok("換算:曝險不變、half-up(3 小台 → 1 大台;1 大台 → 4 小台 → 20 微台);不足一口就是 0、不補成 1(1 微台 → 0 大台);基準 0 就是 0", C.trCtConv(3 * 50, 200) === 1 && C.trCtConv(200, 50) === 4 && C.trCtConv(200, 10) === 20 && C.trCtConv(0, 200) === 0 && C.trCtConv(10, 200) === 0);
{ const ctStored = (n) => ({ a: "TXF", b: "TXF" })[n];
  const one = C.trCtSteps({ a: 4 }, { a: 1 }, { a: "MXF" }, ctStored), two = C.trCtSteps({ a: 6 }, { a: 1 }, { a: "MXF" }, ctStored);
  ok("兩步存檔:純換算的口數一步送(換合約 + 口數);改了口數就先送換算值、再送真正的口數(機器的曝險檢查)",
    J(one) === J([{ amounts: { a: 4 }, contracts: { a: "MXF" } }]) && J(two) === J([{ amounts: { a: 4 }, contracts: { a: "MXF" } }, { amounts: { a: 6 }, contracts: { a: "MXF" } }])
    && J(C.trCtSteps({ a: 3 }, { a: 1 }, null, ctStored)) === J([{ amounts: { a: 3 } }]) && J(C.trCtSteps({ a: 3 }, { a: 0 }, { a: "MXF" }, ctStored)) === J([{ amounts: { a: 3 }, contracts: { a: "MXF" } }])); }
ok("錯誤碼人話:需要更新(在跑 → 更新、沒在跑 → 先啟動)、曝險、等訊號、委託未回報、不是台指期;認不得 null",
  C.trCtErrKey("ValueError: CONTRACT_NEEDS_UPDATE: x", true) === "ct.errUpdate" && C.trCtErrKey("ValueError: CONTRACT_NEEDS_UPDATE: x", false) === "ct.errRun"
  && C.trCtErrKey("CONTRACT_EXPOSURE_MISMATCH") === "ct.errSplit" && C.trCtErrKey("ValueError: CONTRACT_GATED: y") === "ct.errGated" && C.trCtErrKey("CONTRACT_PARKED") === "ct.errParked"
  && C.trCtErrKey("ValueError: NOT_TXF_FAMILY: 「a」") === "ct.errNotTxf" && C.trCtErrKey("boom") === null);
ok("總訊號部位的口數目標先取整(同對帳器 half-up),跟原值不同才留原值", J(C.trLotsTarget(1.6)) === J({ lots: 2, raw: 1.6 }) && J(C.trLotsTarget(2)) === J({ lots: 2, raw: null }) && J(C.trLotsTarget(-0.5)) === J({ lots: -1, raw: -0.5 }) && C.trLotsTarget(0.4).lots === 0);
ok("下拉只看 can_switch_contract(下單停著也可能是 true,契約 §7);換倉中帶 halted、record_unreadable 那一列在表上講一句",
  /function trCtGate\(n\) \{ return !!trCtStored\(n\) && !trCtPend\(\) && \(trReport\(\) \|\| \{\}\)\.can_switch_contract === true; \}/.test(src) && /halted: "ct\.rollHalted"/.test(src) && /x\.state === "record_unreadable"/.test(src));

// ── ③ daemon.js ──
const { UI_COMMANDS, argsOk } = require(path.join(__dirname, "..", "shell", "daemon.js"));
const good = { members: ["a", "b"], allocator: null, params: { lookback: 180, x: true, s: "k" } };
ok("manage_* 兩個視角都開:在 UI_COMMANDS(= api 的雲端白名單 CLOUD_COMMANDS)", ["manage_optimize", "manage_backtest", "manage_cancel"].every((c) => UI_COMMANDS.has(c)));
ok("manage_optimize / manage_backtest 形狀:剛好三欄、成員 1–64 不重複不帶路徑字元、allocator null 或目錄名、params 有限值;manage_cancel 不收參數",
  argsOk("manage_optimize", good) && argsOk("manage_backtest", { ...good, allocator: "my_alloc" }) && argsOk("manage_cancel", {})
  && !argsOk("manage_optimize", { members: [], allocator: null, params: {} }) && !argsOk("manage_optimize", { members: ["a", "a"], allocator: null, params: {} })
  && !argsOk("manage_optimize", { members: ["../x"], allocator: null, params: {} }) && !argsOk("manage_optimize", { members: ["a b"], allocator: null, params: {} })
  && !argsOk("manage_optimize", { ...good, allocator: "bad name" }) && !argsOk("manage_optimize", { ...good, params: { lookback: Infinity } })
  && !argsOk("manage_optimize", { ...good, extra: 1 }) && !argsOk("manage_cancel", { x: 1 }));
ok("優化是 Deferred(腳本最長 120 秒才 ack):等 ack 給 150 秒,其餘照舊 20 秒", /const CMD_TIMEOUT_MS = \{ manage_optimize: 150000 \};/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "daemon.js"), "utf8"))
  && /timeoutMs = CMD_TIMEOUT_MS\[cmd\] \|\| 20000/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "daemon.js"), "utf8")));
ok("雲端視角也送得出優化三個指令:沒有雲端停用鈕,ENV_CLOUD_CMDS 依序接上 manage_*", !/mgCloudOff|mg\.cloudOff/.test(psrc)
  && /ENV_CLOUD_CMDS = \[[^\]]*"stats_refresh", "manage_optimize", "manage_backtest", "manage_cancel"\]/.test(src));
ok("雲端的優化 ack 窗同本機那份 150 秒(其餘照舊 20 秒)", /ackWindowMs: require\("\.\/daemon"\)\.CMD_TIMEOUT_MS\[cmd\]/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"))
  && /now\(\) \+ \(\(sendOpts && sendOpts\.ackWindowMs\) \|\| ACK_WINDOW_MS\)/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "cloudcmd.js"), "utf8")));

// ── 接線 ──
ok("側欄:策略組合(chart-pie)在自動下單(zap)上面", html.indexOf('id="po-nav"') > 0 && html.indexOf('id="po-nav"') < html.indexOf('id="tr-nav"') && /id="tr-nav"[^\n]*M4 14a1 1 0 0 1-\.78-1\.63/.test(html));
ok("自動下單落點一律總覽(trNeedsSetup 退場);原因行的連結開策略組合", !/trNeedsSetup/.test(src) && /trSetTab\("over"\); return; \}/.test(src) && /poOpen\("cfg", true\)/.test(cutF(src, "trPaintNoAmt")));
ok("選擇策略框的名字前同一顆呼吸點、同一個判定(envRunDot)", /r\.live = dotsUp && envRunDot\(r\.name, S\.st, now, S\.just\);/.test(src));
ok("優化／回測跑之前先更新超過 6 小時的成員績效(stats_refresh 分批 50)", /tradeSend\("stats_refresh", \{ names: names\.slice\(i, i \+ MG_REFRESH_BATCH\) \}\)/.test(psrc) && /mgRefreshThen\(S, \(\) => mgSendOptimize\(S\), null, "opt"\)/.test(psrc) && /mgRefreshThen\(S, \(\) => \{ if \(gone\(\)\) return; G\.btWaiting = false; mgSendBacktest\(S\); \}, gone, "bt"\);/.test(psrc) && /G\.refreshing\[w\] = true;/.test(psrc) && /refreshing: \{ opt: false, bt: false \}/.test(psrc));
ok("套用金額:策略集合跟配置不同就停用;一律開確認框(逐策略「目前｜目標｜差額」)", /!mgSameAsAmounts\(\)/.test(cutF(psrc, "mgApply")) && /if \(!fromOpt && !trHasAccount\(trReport\(\)\) && !blocked\) \{ box\.onOk\(\); return; \}/.test(src)
  && /if \(fromOpt\) extra\.appendChild\(poApplyTable\(sending, stored, mayFire\)\);/.test(src));
// 設計稽核 review-desktop-portfolio 必改 3、6、8
ok("必改 3:兩個確認框共用 trCloseTag / trCtCloseTag(「平倉」「{舊合約}平倉」);套用框也標", /const close = trCloseTag\(was, now, mayFire, trStratHeld\(n\)\);/.test(src) && /const ctClose = trCtCloseTag\(n, sending, stored\);/.test(src)
  && /const close = trCloseTag\(cur, nx, mayFire, trStratHeld\(n\)\), ctClose = swapped \? trCtCloseTag\(n, amounts, stored\) : null;/.test(psrc) && !/const ctCloses = /.test(src));
{ const css = fs.readFileSync(path.join(R, "trade.css"), "utf8");
  ok("必改 6:.pf-total 靠右、間距 12(同網頁 units §9.7)", /\.pf-total \{[^}]*justify-content: flex-end;[^}]*gap: var\(--space-12\);/.test(css));
  ok("必改 8:窄欄的合約鈕跟策略名左緣對齊(-8,同觸發器左右 padding 8);優化表那顆接在名字後面維持 8", /\.ct-trig \{[^}]*padding: 0 var\(--space-8\); margin-left: calc\(-1 \* var\(--space-8\)\);/.test(css) && /\.sub-sym \.ct-trig \{ margin-left: calc\(-1 \* var\(--space-8\)\); \}/.test(css) && /\.mg-tbl \.ct-trig \{ margin-left: var\(--space-8\); \}/.test(css)); }

// ── ④ 設計 §9.1 #15:畫面行為(假 DOM) ──
{ const pure = tp + block(src, "/* ── 視角純邏輯(", "/* ── 視角純邏輯到此");
  const node = (tag) => { const n = { tag, id: "", className: "", kids: [], text: "", attrs: {}, hidden: false, disabled: false, value: "", parentNode: null, dataset: {}, title: "", on: {},
    classList: { toggle() {}, add(c) { n.className += " " + c; }, contains: () => false }, appendChild(c) { if (c && typeof c === "object") c.parentNode = n; n.kids.push(c); return c; },
    append(...c) { c.forEach((x) => n.appendChild(x)); }, insertAdjacentElement() {}, remove() {}, insertBefore(c) { n.kids.push(c); return c; },
    querySelector() { return { title: "" }; }, setAttribute(k, v) { n.attrs[k] = v; }, removeAttribute(k) { delete n.attrs[k]; }, addEventListener(e, f) { n.on[e] = f; },
    get nextSibling() { return null; }, get textContent() { return n.text + n.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }, set textContent(v) { n.text = v; n.kids = []; } }; return n; };
  const flat = (n, out = []) => { if (n && n.tag) { out.push(n); n.kids.forEach((k) => flat(k, out)); } return out; };
  const ctx = vm.createContext({ document: { createElement: node, createDocumentFragment: () => node("#frag") }, Date, Math, JSON, Array, Object, Number, String, Set, isFinite, console,
    $: () => null, t: (k, o) => k + (o ? " " + JSON.stringify(o) : ""), LANG: "zh", PAPER: "paper", BINANCE: "binance", CX_VENUES: { binance: { label: "Binance" } }, srSay() {}, trIsPaper: () => false,
    confirmBox(o) { ctx.BOX = o; }, trCloudBox: (o) => o, trWith: () => { ctx.DIRECT = (ctx.DIRECT || 0) + 1; return true; }, TR_STALE_MS: 600000, ENV_JUST_MS: 300000, trackFeature() {} });
  vm.runInContext("function trUnit() { return 'USDT'; } function trCcy() { return 'USDT'; } function trEquity() { return 10000; }", ctx);
  vm.runInContext(pure.replace(/^const /gm, "var ") + "\nvar trTipSeq = 0;\n" + ["trEl", "trSec", "trTipLabel", "trHead", "trFmt", "trFmt2", "trFmtPrice", "trMoneyInto", "trReport", "trContracts", "trStored", "trBase", "trNamesOf", "trNames",
    "trListNames", "trDisplay", "trPickOff", "trPickBtn", "trVenueId", "trVenueLabel", "trVenueKind", "trTwBroker", "trStratName", "trTwNamesWant", "trTwName", "trTwNameEl", "trTxfWant", "trRowTxf", "trRowTxfNew", "trCtPend", "trCtStored", "trCt", "trCtGate", "trCtDirty", "trCtRollTag",
    "trRowMoneyStored", "trCtPayload", "trRowIsLot", "trRowMoney", "trLotsFmt", "trLotsTgtFmt", "trLotsInto", "trQuoteMap", "trNoSignalYet", "trZoneOf", "trZoneLabel", "trZoneUnit", "trFxView", "trZoneSum", "trTotalText",
    "trAmountTable", "trGoStartKey", "trTradableFunded", "trUnrouted", "trRouteDirty", "trCloseTag", "trStratHeld", "trPaperTw", "trCtCloseTag", "trSaveAmounts", "trLivePositions", "trBook", "poPartStates", "poSigTable", "trPosDetail", "trManualPart", "trPlanTotal", "trTxfPrice", "trNetRows", "trWithUnit", "trCatchWill", "trGateSide", "trTradesSym", "trAppRestartQuiet"].map((n) => cutF(src, n)).join("\n"), ctx);
  const V = { credentials: true, pair: true, order: true, account: true };
  const bag = (venues, extra) => ({ env: "local", listLoaded: true, picked: null, sent: null, save: null, edits: { btc: 600 }, bad: {}, raw: {}, sig: {}, ct: { edits: {}, basis: {}, sent: null }, just: null,
    list: [{ name: "btc", displayName: "BTC", hasBacktest: true, symbol: "BTCUSDT" }, { name: "tw", displayName: "TW", hasBacktest: true, symbol: "2330" }],
    st: { alive: true, report: Object.assign({ venues, config: { amounts: { btc: 500, tw: 100000 } }, quote_ccy: { btc: "USDT", tw: "TWD" },
      states: { btc: { symbol: "BTCUSDT", position: 1 }, tw: { symbol: "2330", position: 1, market: "spot" } },
      account: { read_at: Math.floor(Date.now() / 1000), venues: Object.keys(venues).length ? { binance: { ok: true, equity: 10000, currency: "USDT", positions: { BTCUSDT: { side: "long", size: 400, entry_price: 60000, unrealized_pnl: 12.5, margin: 40 } } } } : {} } }, extra || {}) } });
  ctx.TR = bag({}); ctx.BOX = null; ctx.DIRECT = 0;
  const amt = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx));
  vm.runInContext("trSaveAmounts(trNames(), trBase(), null)", ctx);
  ok("#15 沒連交易所:配置分頁畫金額表(有輸入框);按儲存直接存,不開確認框", amt.some((n) => /amt-in/.test(n.className)) && ctx.BOX === null && ctx.DIRECT === 1, J({ box: !!ctx.BOX, direct: ctx.DIRECT }));
  const sig0 = flat(vm.runInContext("poSigTable(TR.st.report, TR.st.report.config.amounts, TR.st.report.states, 'cfg')", ctx));
  ok("#15 沒連交易所:總訊號部位表只有「標的｜目標」兩欄、目標上色", J(sig0.filter((n) => n.tag === "th").map((n) => n.text)) === J(["tr.col.symbol", "tr.col.target"]) && sig0.some((n) => n.tag === "td" && /\bbuy\b/.test(n.className)));
  ctx.TR = bag({ binance: V }); ctx.BOX = null; ctx.DIRECT = 0;
  vm.runInContext("TR = this.TR; trSaveAmounts(trNames(), trBase(), null)", ctx);
  ok("#15 連上交易所:開確認框(標題「確認金額」)", !!ctx.BOX && ctx.BOX.title === "tr.saveTitle" && ctx.DIRECT === 0);
  // A 案(autotrade-bridge-mockup):自動下單 › 部位 = 唯讀配置對照帳上,同一個列函式 poSigTable(…, "trade")
  const sig = flat(vm.runInContext("poSigTable(TR.st.report, TR.st.report.config.amounts, TR.st.report.states, 'trade')", ctx));
  const rows = sig.filter((n) => n.tag === "tr" && n.kids.length === 4 && n.kids[0].tag === "td").map((r) => r.kids.map((c) => c.textContent)), tw = rows.find((r) => r[0].startsWith("2330")), btcT = rows.find((r) => r[0].startsWith("BTCUSDT"));
  ok("A 案:自動下單 › 部位四欄「標的｜目標｜帳上｜差額」、沒有輸入框;台股列(交易所不交易)帳上與差額「—」;帳上欄頭 title 講帳戶",
    J(sig.filter((n) => n.tag === "th").map((n) => n.textContent)) === J(["tr.col.symbol", "tr.col.target", "tr.col.held", "tr.col.diff"]) && !sig.some((n) => n.tag === "input" || /amt-in/.test(n.className))
    && !!tw && tw[2] === "—" && tw[3] === "—" && sig.some((n) => /th-tip/.test(n.className) && /po\.actualTip/.test(n.title)), J(rows));
  ok("標的格只寫標的與市場小標:貢獻的策略與金額(「BTC · 500」)不列(Wei 10-15 拿掉,樣式一起清);右上「到策略組合修改」;帳上不是 0 的列底下一行持倉細節(均價、未實現)",
    !!btcT && /^BTCUSDT/.test(btcT[0]) && !/BTC · |500/.test(btcT[0]) && !sig.some((n) => /po-src/.test(n.className)) && !/po-src|srcLines/.test(src) && !/\.po-src/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.css"), "utf8")) && sig.some((n) => /po-bridge/.test(n.className) && n.text === "po.bridgeEdit")
    && sig.some((n) => /po-det/.test(n.className) && /po\.dEntry/.test(n.textContent) && /po\.dUpnl/.test(n.textContent)), J([btcT, sig.filter((n) => /po-det/.test(n.className)).map((n) => n.textContent)]));
  ok("A 案:策略組合 › 配置的下表退回只有目標(沒有帳上、差額、拒單、合計列)", !sig0.some((n) => n.tag === "th" && /tr\.col\.(held|diff)/.test(n.text)) && !sig0.some((n) => /po-foot|pf-note err/.test(n.className)));
  { const diffCls = (hs, amounts) => { vm.runInContext(`envHeadState = () => ${J(hs)};`, ctx); if (amounts) ctx.TR.st.report.config.amounts = amounts;
      const f = flat(vm.runInContext("poSigTable(TR.st.report, TR.st.report.config.amounts, TR.st.report.states, 'trade')", ctx));
      return { cls: f.filter((n) => n.tag === "tr" && n.kids.length === 4 && n.kids[0].tag === "td").map((r) => r.kids[3].className), link: f.some((n) => /po-bridge/.test(n.className)), idle: (() => { const th = f.filter((n) => n.tag === "th")[3]; return !th ? "no th" : flat(th).some((n) => /th-tip/.test(n.className) || n.title) ? "tip" : th.textContent; })() }; };
    const on = diffCls("running"), off = diffCls("dead"), halt = diffCls("halted");
    ok("A 案(同網頁 6ae71405):在跑 → 差額上 buy/sell;沒在跑 → 會下單的差額退 hold 灰;差額欄頭三種狀態都不掛 tooltip(Wei 10-15 拿掉未啟動／已暫停那兩句)",
      on.cls.some((c) => /\b(buy|sell)\b/.test(c)) && !off.cls.some((c) => /\b(buy|sell)\b/.test(c)) && off.cls.some((c) => /\bhold\b/.test(c))
      && [on, off, halt].every((x) => x.idle === "tr.col.diff"), J({ on, off, halt }));
    const zeroRun = diffCls("running", { btc: 0, tw: 0 }); ctx.TR.noAmtLink = true; const linked = diffCls("dead", { btc: 0, tw: 0 }); ctx.TR.noAmtLink = false;
    ctx.TR.zBridge = true; const bridged = diffCls("dead", { btc: 0, tw: 0 }); ctx.TR.zBridge = false;
    ok("設計稽核電腦版必改 3 + spec-autotrade-empty §5:「到策略組合修改」在頁首原因行實際畫出連結(TR.noAmtLink)或動作列有導引鈕(TR.zBridge)時藏;在跑但金額全空、兩者都沒有時照畫",
      on.link && zeroRun.link && !linked.link && !bridged.link && /TR\.noAmtLink = !!key && t\(key, vars\)\.toLowerCase\(\)\.indexOf\(t\("po\.nav"\)\.toLowerCase\(\)\) >= 0;/.test(src)
      && /envHeadState\(TR\.st, now\), TR\.startAt \|\| 0, !!TR\.noAmtLink, !!TR\.zBridge, fog, TR_TWN\.v\];/.test(src) && /TR\.zBridge = !!key;/.test(src), J({ zeroRun, linked, bridged }));
    ctx.TR = bag({ binance: V }); }
  // 手動部位(Wei 10-14):帳本模式下帳戶比帳本多的那份 = 手動。帳本 size 是成本、讀帳 size 是市值,金額列要比數量(帳本 qty 對 size ÷ mark_price)
  { const run = (pos, led) => { ctx.TR = bag({ binance: V }); const rp = ctx.TR.st.report; rp.self_ledger = true; rp.account.read_at = Math.floor(Date.now() / 1000);
      rp.account.venues.binance.positions = { BTCUSDT: Object.assign({ side: "long", entry_price: 60000, unrealized_pnl: 12.5, margin: 40 }, pos) };
      rp.last_reconcile = { ts: Math.floor(Date.now() / 1000) - 5, actual: {}, ledger: { BTCUSDT: Object.assign({ side: "long" }, led) }, gates: {} };
      const m = flat(vm.runInContext("TR = this.TR; poSigTable(TR.st.report, TR.st.report.config.amounts, TR.st.report.states, 'trade')", ctx));
      const row = m.filter((n) => n.tag === "tr" && n.kids.length === 4 && n.kids[0].tag === "td").map((r) => r.kids.map((c) => c.textContent)).find((r) => r[0].startsWith("BTCUSDT"));
      return { row, det: (m.find((n) => /po-det/.test(n.className)) || {}).textContent || "", man: m.find((n) => /po-manual/.test(n.className)) || null, foot: m.some((n) => /po-gate/.test(n.className)) }; };
    const same = run({ size: 10300, mark_price: 103000 }, { size: 10000, qty: 0.1 });
    ok("成本 10,000、市值 10,300、數量相同:不出現手動那一行、不加「含手動」,這一列照常進表底合計", !same.man && !/manual|Manual/.test(same.det) && same.foot && same.row[2] === "+10,000", J(same.row) + same.det);
    const more = run({ size: 15450, mark_price: 103000 }, { size: 10000, qty: 0.1 });
    ok("數量多出 0.05(× 現價 = 5,150):細節行「另有手動 +5,150」(tooltip 對帳不會動它)、行尾「含手動」;帳上仍是策略那份;這一列不進表底合計",
      !!more.man && /po\.manualPart \{"n":"\+5,150"\}/.test(more.man.textContent) && more.man.title === "tr.unmanagedTip" && /po\.detInclManual$/.test(more.det) && more.row[2] === "+10,000" && !more.foot, J(more.row) + more.det);
    const noQty = run({ size: 15450, mark_price: 103000 }, { size: 10000, legacy: true }), noMark = run({ size: 15450 }, { size: 10000, qty: 0.1 });
    ok("拿不到數量(舊帳本)或現價:不畫手動那一行、不加「含手動」、照常進合計", !noQty.man && noQty.foot && !noMark.man && noMark.foot && !/detInclManual/.test(noQty.det + noMark.det));
    const tol = run({ size: 10340, mark_price: 103000 }, { size: 10000, qty: 0.1 });   // 數量差 0.39% < 0.5%
    ok("數量差在 0.5% 以內不算手動", !tol.man && tol.foot);
    { const T0 = Math.floor(Date.now() / 1000), P = (led, positions, extra, lastTs) => { const bk = { actual: {}, mine: {}, last: led === undefined ? { ts: T0 - 60 } : { ts: lastTs || T0 - 60, ledger: led } }; ctx.__a = [Object.assign({ self_ledger: true, venues: { binance: V }, account: { read_at: T0, venues: { binance: { ok: true, positions } } } }, extra || {}), bk];
        return vm.runInContext("trManualPart(__a[0], 'BTCUSDT', false, __a[1])", ctx); };
      ok("規則 3／4:帳本沒有這一檔、帳戶有 → 整份帳戶部位(讀帳 size);沒有 ledger / 帳本兩列 / 讀帳兩列 / 帳本有而讀帳沒有 → null(判不出來);兩邊都沒有 → 0;空單方向照 side",
        P({}, { BTCUSDT: { side: "long", size: 777 } }) === 777 && P(undefined, { BTCUSDT: { side: "long", size: 1 } }) === null
        && P({ BTCUSDT: { side: "long", qty: 1 }, "BTC/USDT": { side: "long", qty: 1 } }, {}) === null && P({ BTCUSDT: { side: "long", qty: 1 } }, {}) === null && P({}, {}) === 0
        && Math.round(P({ BTCUSDT: { side: "short", size: 100, qty: 0.001 } }, { BTCUSDT: { side: "short", size: 206, mark_price: 103000 } })) === -103);
      const L1 = { BTCUSDT: { side: "long", size: 100, qty: 0.001 } }, A2 = { BTCUSDT: { side: "long", size: 206, mark_price: 103000 } };
      ok("網頁 30ea6d23:對帳快照比讀帳新、或沒有讀帳結果 → 判不出來(null);讀帳較新才算;兩家持有同一標的不畫;台指期列不套時間這條",
        P(L1, A2, null, T0 + 30) === null && P(L1, A2, { account: null }) === null && Math.round(P(L1, A2)) === 103
        && P(L1, A2, { venues: { binance: V, okx: V }, account: { read_at: T0, venues: { binance: { ok: true, positions: A2 }, okx: { ok: true, positions: A2 } } } }) === null
        && (ctx.__a = [{ self_ledger: true }, { actual: { TXF: 3 }, mine: { TXF: 1 }, last: { ts: T0 + 999 } }], vm.runInContext("trManualPart(__a[0], 'TXF', true, __a[1])", ctx) === 2)); }
    ctx.TR.st.report.self_ledger = false;
    const m2 = flat(vm.runInContext("poSigTable(TR.st.report, TR.st.report.config.amounts, TR.st.report.states, 'trade')", ctx));
    ok("不是帳本模式:沒有「另有手動」,表底照畫合計", !m2.some((n) => /po-manual/.test(n.className)) && m2.some((n) => /po-gate/.test(n.className)));
    ok("口數列直接比口數(帳戶口數 − 帳本口數)", /if \(lot\) return \(bk\.actual\[sym\] \|\| 0\) - \(bk\.mine\[sym\] \|\| 0\);/.test(src)); }
  // 「平倉」小標判不出來的三種(讀帳失敗、同標的多支策略、剛換合約舊合約還在)一律 null = 照舊標;投資組合也是
  ok("trStratHeld:任一家讀帳失敗 / 讀數過期(6 分鐘)/ 同標的還有別支 / 換合約中或帳上有別的台指期合約 / 投資組合 → null;確定帳上沒有才 false",
    /return !!e && e\.ok === false; \}\)\) return null;/.test(src) && /Date\.now\(\) - at > 6 \* 60 \* 1000\) return null;/.test(src) && /if \(Object\.keys\(stored\)\.some\(\(m\) => m !== n && keyOf\(m\) === key\)\) return null;/.test(src)
    && /if \(trTxfSpec\(key\) && \(trCtStored\(n\) !== trCt\(n\) \|\| Object\.keys\(TR_TXF_SPECS\)\.some\(\(k\) => k !== key && bk\.mine\[k\]\)\)\) return null;/.test(src) && /\(x && x\.portfolio === true\)\) return null;/.test(src));
  // 稽核 P2-1:trStratHeld 的行為(決定確認框標不標「平倉」)——帳上有 → true、確定沒有 → false、判不出來 → null
  { const held = (mut) => { ctx.TR = bag({ binance: V }); const rp = ctx.TR.st.report; rp.account.read_at = Math.floor(Date.now() / 1000); if (mut) mut(rp, ctx.TR); return vm.runInContext("TR = this.TR; trStratHeld('btc')", ctx); };
    ok("trStratHeld:帳上有這支的部位 → true;讀帳成功、帳上沒有 → false", held() === true && held((rp) => { rp.account.venues.binance.positions = {}; }) === false, J([held(), held((rp) => { rp.account.venues.binance.positions = {}; })]));
    ok("trStratHeld 判不出來 → null:讀帳失敗、讀數超過 6 分鐘、同標的另有策略、投資組合、沒連交易所",
      held((rp) => { rp.account.venues.binance = { ok: false, error: "x" }; }) === null && held((rp) => { rp.account.venues.binance.positions = {}; rp.account.read_at = Math.floor(Date.now() / 1000) - 400; }) === null
      && held((rp, T) => { rp.account.venues.binance.positions = {}; rp.config.amounts.btc2 = 5; rp.states.btc2 = { symbol: "BTCUSDT", position: -1 }; }) === null
      && held((rp, T) => { T.list[0].portfolio = true; }) === null && (ctx.TR = bag({}), vm.runInContext("TR = this.TR; trStratHeld('btc')", ctx)) === null); }
  // post-connect-flow 第 7 列:回報的 states 裡還沒有這支(還沒跑出第一次 live tick)→ 訊號與目標「—」+ tooltip;有這支、position 0 → 照舊 ×0
  { ctx.TR = bag({}); ctx.TR.st.report.states = { tw: { symbol: "2330", position: 1, market: "spot" } }; ctx.TR.edits = {};
    const am = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx));
    const sig = am.filter((n) => /\bsig\b/.test(n.className)), tip = am.filter((n) => n.title === "tr.sigNotYet");
    ok("金額表:states 缺 btc → 訊號「—」、目標「—」,兩格 tooltip tr.sigNotYet;tw 照常 ×1.00", sig.some((n) => n.textContent === "—") && sig.some((n) => n.textContent === "×1.00") && tip.length === 2, J(sig.map((n) => n.textContent)));
    const cfg = flat(vm.runInContext("poSigTable(TR.st.report, TR.st.report.config.amounts, TR.st.report.states, 'cfg')", ctx));
    ok("總訊號部位表:states 缺 btc → BTCUSDT 目標「—」(tooltip tr.sigNotYet),不是 0", cfg.some((n) => n.tag === "td" && n.textContent === "—" && n.title === "tr.sigNotYet"));
    ctx.TR.st.report.states.btc = { symbol: "BTCUSDT", position: 0 };
    const am0 = flat(vm.runInContext("trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx));
    ok("狀態裡有 btc、position 0 → 訊號照舊 ×0、目標 0,沒有 tr.sigNotYet", am0.some((n) => /\bsig\b/.test(n.className) && n.textContent === "×0") && !am0.some((n) => n.title === "tr.sigNotYet")); }
  // post-connect-flow 第 4 列:配置頁「去啟動」那一列,envHeadState 每個值都列舉
  { ctx.TR = bag({ binance: V });
    const k = (st) => vm.runInContext("trGoStartKey(" + J(st) + ", TR.st.report)", ctx);
    const all = { running: null, unconfirmed: null, dead: "po.goIdle", halted: "po.goHalt", loading: null, unknown: null, setup: null, noaccount: null };
    ok("trGoStartKey:running／unconfirmed 不畫;dead 還沒開始下單;halted 下單已暫停;loading／unknown／setup／noaccount 不畫;不認得的狀態不畫",
      Object.keys(all).every((st) => k(st) === all[st]) && k("whatever") === null, J(Object.keys(all).map((st) => [st, k(st)])));
    // 列舉才算沒漏:trExecState／envHeadState 回的每一個字面都在表上
    const states = [...new Set([...cutF(src, "trExecState").matchAll(/return "([a-z]+)"/g), ...cutF(src, "envHeadState").matchAll(/"([a-z]+)"/g)].map((m) => m[1]))].filter((x) => x !== "running" || true);
    ok("trExecState／envHeadState 會回的每個狀態都在 trGoStartKey 的表上", states.filter((x) => ["running", "unconfirmed", "dead", "halted", "loading", "unknown", "setup", "noaccount"].indexOf(x) < 0 && !/^(stopped|cloud)$/.test(x)).length === 0, J(states));
    ctx.TR.st.report.config.amounts = { btc: 0, tw: 0 };
    ok("沒有這家能下的金額:dead 也不畫", k("dead") === null);
    ok("「去啟動」那一列:過場中(TR.pending)、要確認帳戶、金鑰被拒都不畫(自動下單頁的出口不是啟動鈕)",
      /const goKey = !dirty && !routeDirty && TR\.save !== "failed" && !cfgBad && !TR\.pending && !trAcctAsk\(trReport\(\)\) && !trKeyBad\(TR\.env\) \? trGoStartKey/.test(src));
    ctx.TR = bag({ binance: V }); ctx.TR.edits = {}; vm.runInContext('envHeadState = () => "dead";', ctx);
    const a = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx));
    vm.runInContext('envHeadState = () => "running";', ctx); const a2 = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx));
    ctx.TR = bag({ binance: V }); ctx.TR.edits = {}; ctx.TR.pending = { want: "running" }; vm.runInContext('envHeadState = () => "dead";', ctx);
    const a3 = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx));
    ctx.TR.pending = null; ctx.TR.st.report.halt = { halted: true }; ctx.TR.st.report.account_guard = { book_hold: { venue: "binance", ask: true } }; vm.runInContext('envHeadState = () => "halted";', ctx);
    const a4 = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx)); vm.runInContext('envHeadState = () => "running";', ctx);
    ok("沒改金額、沒在下單(dead):儲存列的位置是「還沒開始下單 ·〔到自動下單啟動〕」(btn-fill, fk go-start)", a.some((n) => n.text === "po.goIdle") && a.some((n) => n.dataset && n.dataset.fk === "go-start" && n.text === "po.goBtn") && !a2.some((n) => n.dataset && n.dataset.fk === "go-start")
      && !a3.some((n) => n.dataset && n.dataset.fk === "go-start") && !a4.some((n) => n.dataset && n.dataset.fk === "go-start")); }
  // 第 5′ 列:這家能下的金額——統一只算台指期、模擬交易不算台股(台指期算);標的不明不扣
  { const f = (vid, list, amounts, states) => { ctx.TR = { list, env: "local" }; return vm.runInContext("trTradableFunded(" + J({ venues: { [vid]: V }, config: { amounts }, states: states || {} }) + ")", ctx); };
    ok("trTradableFunded:統一 + 只有 BTC 有金額 → 0(Z,啟動下單停用);統一 + 台指期 → 1;模擬 + 台股 → 0、模擬 + 台指期 → 1;Binance 照算;標的不明 → 算",
      f("president", [{ name: "b", symbol: "BTCUSDT" }], { b: 5000 }) === 0 && f("president", [{ name: "x", symbol: "TXF" }, { name: "b", symbol: "BTCUSDT" }], { x: 1, b: 5000 }) === 1
      && f("paper", [{ name: "t", symbol: "2330", twd: true }], { t: 1000 }) === 0 && f("paper", [{ name: "x", symbol: "TXF", twd: true }], { x: 1 }) === 1
      && f("binance", [{ name: "b", symbol: "BTCUSDT" }], { b: 1 }) === 1 && f("president", [], { q: 1 }) === 1 && f("president", [], { q: 1 }, { q: { symbol: "BTCUSDT" } }) === 0
      // 同 runtime NOT_TXF:不去 R1(TXFR1 不算);投資組合在統一下算不能下(稽核第三輪 P1-A)
      && f("president", [{ name: "r", symbol: "TXFR1" }], { r: 1 }) === 0 && f("president", [{ name: "pf", portfolio: true }], { pf: 1 }) === 0
      && f("president", [], { w: 1 }, { w: { weights: { "2330": 1 } } }) === 0 && f("binance", [{ name: "pf", portfolio: true }], { pf: 1 }) === 1); }
  // 第 5 列:Blave 重開過(app)但沒有金額、帳本沒有部位、不是 ZH → 不講重開
  { const R = (extra) => Object.assign({ venues: { binance: V }, config: { amounts: {} }, states: {}, daemon: { reconciler: { running: false, wanted: false } }, reconciler: { heartbeat_at: 9 }, halt: { halted: false } }, extra || {});
    ctx.TR = { list: [], env: "local" }; const q = (r) => vm.runInContext("trAppRestartQuiet(" + J(r) + ")", ctx);
    ok("trAppRestartQuiet:沒金額、帳本空、沒暫停 → true;有金額 / 帳本有部位 / 暫停中又有自己下單的策略 → false;暫停但 selfOrdering:false → true",
      q(R()) === true && q(R({ config: { amounts: { a: 1 } } })) === false && q(R({ last_reconcile: { ledger: { BTCUSDT: { side: "long", size: 5 } } } })) === false
      && q(R({ halt: { halted: true } })) === false && q(R({ halt: { halted: true }, selfOrdering: false })) === true && q(R({ daemon: { reconciler: { running: true } } })) === false);
    ok("狀態行:halted 而且 trAppRestartQuiet → tr.notStarted(不講重開)", /s = !ask && !done && trAppRestartQuiet\(r\) \? t\("tr\.notStarted"\)/.test(src)); }
  // 第 8 列:補齊會送出的單(取自部位表的差額)
  { ctx.TR = bag({ binance: V }); ctx.TR.st.report.account.read_at = Math.floor(Date.now() / 1000);
    const w = vm.runInContext("TR = this.TR; trCatchWill(TR.st.report)", ctx);
    ok("補齊說明:BTC 目標 500、帳上 400 → 「會買進 BTCUSDT 100 USDT」;台股(交易所不交易)不列", /tr\.opt\.catchWill \{"side":"tr\.opt\.buy","sym":"BTCUSDT","n":"100 USDT"\}/.test(w) && !/2330/.test(w), w);
    ctx.TR.st.report.config.amounts.btc = 400;   // 目標 = 帳上:差額 0 → 不講會送什麼單(沒有單)
    ok("補齊說明:差額為 0(目標 400、帳上 400)→ 不出「會買進…」;有差額時才出", vm.runInContext("trCatchWill(TR.st.report)", ctx) === null);
    ok("補齊說明接在 catch 選項的 desc 後面;舊 lib 單一鈕那條接在 lines 最後", /desc: t\("tr\.opt\.catchDesc" \+ money\) \+ \(will \? " " \+ will : ""\)/.test(src) && /\.concat\(\[t\("tr\.startWarn1"\)\]\)\.concat\(will \? \[will\] : \[\]\)/.test(src)); }
  // runtime 10-14:解除綁定保留成員與金額、只清路由。解除 → 重新綁定 → 頁面是 Z(路由空的)→ 存一次 → 可以啟動
  { const rep = (venues, ex) => ({ venues, config: { amounts: { btc: 500, tw: 0 }, exchanges: ex }, states: { btc: { symbol: "BTCUSDT", position: 1 } }, account: { read_at: Math.floor(Date.now() / 1000), venues: {} } });
    const P = { paper: V };
    const run = (r) => { ctx.TR = bag({}); ctx.TR.st.report = r; ctx.TR.edits = {}; return vm.runInContext("TR = this.TR; ({ z: trNoAmounts(TR.st.report), un: trUnrouted(TR.st.report), rd: trRouteDirty(TR.st.report), f: trTradableFunded(TR.st.report) })", ctx); };
    const unbound = run(rep({}, { btc: "", tw: "" })), rebound = run(rep(P, { btc: "", tw: "" }));
    vm.runInContext('envHeadState = () => "dead";', ctx);
    const bar = flat(vm.runInContext("trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx));
    const saved = run(rep(P, { btc: "paper", tw: "paper" }));
    vm.runInContext('envHeadState = () => "running";', ctx);
    ok("解除 → 重新綁定:路由是空的 → Z(啟動停用、原因行 tr.startOffNoRoute);配置頁的存檔鈕出現(沒改金額也能存,講 tr.routeSave);存一次(runtime 繼承現在這家)→ 不是 Z、可以啟動",
      J(rebound.un) === J(["btc", "tw"]) && rebound.z === true && rebound.rd === true && rebound.f === 0
      && bar.some((n) => n.dataset && n.dataset.fk === "save") && bar.some((n) => n.text === "tr.routeSave")
      && saved.z === false && saved.un.length === 0 && saved.rd === false && saved.f === 1 && unbound.un.length === 0, J({ unbound, rebound, saved }));
    ok("舊 runtime(config 沒有 exchanges)不判;NEEDS_ROUTING 翻成句子;原因行的 Z 句在路由空的時候講「重新綁定後，先到策略組合存一次下單設定。」",
      run({ venues: P, config: { amounts: { btc: 500 } }, states: {} }).z === false && /if \(rc\.code === "NEEDS_ROUTING"\) return t\("tr\.needsRouting\.rejected", \{ name, more \}\);/.test(src)
      && fs.readFileSync(path.join(R, "strings.js"), "utf8").includes('"tr.startOffNoRoute": "重新綁定後，先到策略組合存一次下單設定。"')); }
  // 必改 2:綁了但第一次讀帳還沒回來(沒有對帳快照、帳戶也沒讀到)→ 實際與差額寫「—」,不畫 0、差額不上色
  ctx.TR = bag({ binance: V }); ctx.TR.st.report.account = { venues: {} }; ctx.TR.st.report.last_reconcile = null;
  const fr = flat(vm.runInContext("TR = this.TR; poSigTable(TR.st.report, TR.st.report.config.amounts, TR.st.report.states, 'trade')", ctx));
  const frRows = fr.filter((n) => n.tag === "tr" && n.kids.length === 4 && n.kids[0].tag === "td").map((r) => r.kids.map((c) => c.textContent + "|" + c.className)), btcR = frRows.find((r) => r[0].startsWith("BTCUSDT"));
  ok("必改 2:第一次讀帳前,實際與差額是「—」(不是 0、不是綠字 +5,000)", !!btcR && btcR[2] === "—|n na" && btcR[3] === "—|n na", J(frRows));
  // 必改 1:兩檔同時被拒 → 兩列各掛一筆,列下的字不再重寫標的
  ctx.TR = bag({ binance: V }); const R2 = ctx.TR.st.report; R2.config.amounts = { btc: 500, eth: 500 }; R2.states.eth = { symbol: "ETHUSDT", position: 1 };
  R2.order_errors = [{ ts: new Date().toISOString().replace("Z", ""), symbol: "BTCUSDT", exchange: "binance", error: "boom-b" }, { ts: new Date().toISOString().replace("Z", ""), symbol: "ETHUSDT", exchange: "binance", error: "boom-e" }];
  ctx.TR.list.push({ name: "eth", displayName: "ETH", hasBacktest: true, symbol: "ETHUSDT" });
  const e2 = flat(vm.runInContext("TR = this.TR; poSigTable(TR.st.report, TR.st.report.config.amounts, TR.st.report.states, 'trade')", ctx)).filter((n) => /pf-note (err|past)/.test(n.className)).map((n) => n.textContent);
  ok("必改 1:兩檔同時被拒,兩列各掛自己那一筆;字是「下單失敗/上次下單失敗:{err}」不帶標的", e2.length === 2 && e2.some((x) => /boom-b/.test(x)) && e2.some((x) => /boom-e/.test(x)) && e2.every((x) => /po\.orderFailed(Row|Last)/.test(x) && !/BTCUSDT|ETHUSDT/.test(x.replace(/"err":"[^"]*"/, ""))), J(e2)); }

// Wei 拍板:套用後記住這次的本金,重複套用不漂移(槓桿 < 1 時預設本金 = 已存合計會一次比一次小);10-16 起連同當下方法的目標一起釘
{ const saved = []; let stored = 280000;
  const ctx = vm.createContext({ MG_SIZE_KEY: "ws_mg_sizing", MPS_METHODS: ["vol", "mdd", "lev"], mgSave: (S, k, v) => saved.push([S.env, k, v]), mpsFundDefault: () => stored, mpsCcy: () => "USDT", mpsConv: (v) => v });
  vm.runInContext(["mpsSizingClean", "mpsFundAs", "mpsSizingPin", "mpsFundOf", "mgPinUsed"].map((n) => cutF(psrc, n)).join("\n"), ctx);
  ctx.G = { sizing: F.mpsSizingClean(null) }; ctx.S = { env: "local" };
  const lev = 0.48, apply = () => { const used = vm.runInContext("mpsFundOf(G.sizing)", ctx); stored = Math.round(used * lev); ctx.used = used; vm.runInContext("mgPinUsed(S, G, 'USDT', used, 'vol', 10.6)", ctx); return used; };
  const a1 = apply(), a2 = apply(), a3 = apply();
  ok("本金不漂移:第一次預設 = 已存合計(280,000),套用成功後記住(帶幣別、連同當下目標);第二、三次仍是 280,000;存進部位大小設定一次",
    a1 === 280000 && a2 === 280000 && a3 === 280000 && saved.length === 1 && saved[0][1] === "ws_mg_sizing" && saved[0][2].fund === 280000 && saved[0][2].fundCcy === "USDT" && saved[0][2].target.vol === 10.6 && ctx.G.sizingSet === true, J([a1, a2, a3, saved]));
  ctx.G = { sizing: F.mpsSizingClean({ fund: 50000, fundCcy: "USDT", method: "vol", target: { vol: 20 } }) }; vm.runInContext("mgPinUsed(S, G, 'USDT', 999, 'vol', 10.6)", ctx);
  ok("自己填過本金與目標的不蓋;存成功才記(onSaved),取消不記", ctx.G.sizing.fund === 50000 && ctx.G.sizing.target.vol === 20 && saved.length === 1
    && /const fundUsed = mpsFundOf\(G\.sizing\), ccyUsed = mpsCcy\(\)/.test(psrc) && /onSaved: \(sending, was\) => \{[^\n]*mgPinUsed\(S, G, ccyUsed, fundUsed, mUsed, tgUsed\);/.test(psrc)); }
// 稽核 10-16:本金填過、換幣別又缺匯率時 mpsFundOf 也是 null;不能當「沒填」叫人重填,要講缺匯率
{ let ccy = "USDT", expired = false, cloud = { code: "OK" }; const fx = { USDT: 1 };
  const ctx = vm.createContext({ MPS_METHODS: ["vol", "mdd", "lev"], mpsCcy: () => ccy, mpsConv: (v, a, b) => (a === b ? v : fx[a] && fx[b] ? (v / fx[a]) * fx[b] : null),
    mpsFundDefault: () => null, mgSameAsAmounts: () => true, trFxView: () => ({ expired }), TR_BAGS: { cloud: { st: { get cloud() { return cloud; } } } } });
  vm.runInContext(["mpsSizingClean", "mpsFundAs", "mpsFundOf", "mpsFundFxMissing", "mgFxWhy", "mgApplyWhy"].map((n) => cutF(psrc, n)).join("\n"), ctx);
  const of = vm.runInContext("mpsFundOf", ctx), miss = vm.runInContext("mpsFundFxMissing", ctx), why = vm.runInContext("mgApplyWhy", ctx);
  const none = F.mpsSizingClean(null), usdt = F.mpsSizingClean({ fund: 1000, fundCcy: "USDT" });
  const same = [miss(none), miss(usdt)]; ccy = "TWD"; const gap = [of(usdt), miss(usdt)];
  const d = { eff: null, rows: [], fundFx: true }, w = [why(d, false, true)]; cloud = null; w.push(why(d, false, true)); expired = true; w.push(why(d, false, true));
  expired = false; cloud = { code: "OK" }; w.push(why({ eff: null, rows: [], fundFx: false }, false, true));
  ok("本金 1,000 USDT、現在是 TWD 又缺匯率:判成缺匯率(不是沒填);套用鈕講缺匯率(登入正常／沒登入／匯率過期各走既有句),沒填才講先設定投入資金;表上方不叫人去填",
    same.every((x) => x === false) && gap[0] === null && gap[1] === true && J(w) === J(["mg.applyWhyFx", "mg.applyWhyLogin", "mg.applyWhyFxOld", "mg.applyWhySize"])
    && /return \{ amount, lev, eff, rows, fundFx: mpsFundFxMissing\(G\.sizing\) \};/.test(cutF(psrc, "mpsRows")) && /const d = mpsRows\(\)/.test(cutF(psrc, "mgSuggestTable"))
    && /if \(mpsFundOf\(mgBag\(\)\.sizing\) === null && !d\.fundFx\) \{/.test(cutF(psrc, "mgSuggestTable")), J([same, gap, w])); }
// Wei 10-16:部位大小設好之後,跑優化 / 換方法 / 增減策略 / 重開都要維持;只有用戶自己改才變
{ let ccy = "USDT", fx = { USDT: 1, USD: 1, TWD: 32 };
  const store = {}, cloudSet = [];
  const ctx = vm.createContext({ console, JSON, Promise, MG_SIZE_KEY: "ws_mg_sizing", MG_SEL_KEY: "ws_mg_members",
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    window: { blave: { mgSizingCloud: () => Promise.resolve(ctx.cloudFile), mgSizingCloudSet: (v) => { cloudSet.push(v); ctx.cloudFile = JSON.parse(JSON.stringify(v)); return Promise.resolve(true); } } },
    mpsCcy: () => ccy, mpsConv: (v, a, b) => (fx[a] && fx[b] ? (v / fx[a]) * fx[b] : null), mpsFundDefault: () => ctx.defaultFund, mgPaint: () => { ctx.painted = (ctx.painted || 0) + 1; } });
  vm.runInContext(pp.replace(/^const /gm, "var ") + "\n" + ["mgBag", "mgSizingCloudLoad", "mgSave", "mpsFundOf", "mgSizeNum", "mgSizeParse"].map((n) => cutF(psrc, n)).join("\n"), ctx);
  ctx.TR = { env: "local", sig: {} };
  // 開框時的顯示 = 預設:本金 86,372(已存合計)、目標波動 10.6%(這份結果的歷史波動)。用戶只換了一下方法又換回,按確定
  const prop1 = { ann_vol_pct: 10.6, port_returns: { r: [0.01, -0.02, 0.015, -0.01] } }; ctx.defaultFund = 86372;
  const draft = (s, prop, method) => { const f0 = vm.runInContext("mpsFundOf", ctx)(s), d = { method: method || vm.runInContext("mpsMethodOf", ctx)(s, F.mpsSeriesOf(prop)), methodDirty: false, fund: String(f0), fund0: f0, fundDirty: false, t: {}, t0: {}, dirty: {} };
    ["vol", "mdd", "lev"].forEach((m) => { const v = F.mpsTargetOf(s, m, prop); d.t0[m] = v; d.t[m] = v === null ? "" : m === "vol" ? v.toFixed(1) : m === "lev" ? v.toFixed(2) : String(Math.round(v * 10) / 10); d.dirty[m] = false; }); return d; };
  const okSave = (d) => { const G = vm.runInContext("mgBag()", ctx), r = vm.runInContext("mgSizeParse", ctx)(d); G.sizing = r.sizing; G.sizingSet = true; vm.runInContext("mgSave", ctx)(ctx.TR, "ws_mg_sizing", G.sizing); return r; };
  const r1 = okSave(draft(F.mpsSizingClean(null), prop1));
  ok("按確定沒打字:畫面上的本金與所選方法的目標釘成明確值(帶幣別),方法沒點過不寫", r1.bad === false && r1.sizing.fund === 86372 && r1.sizing.fundCcy === "USDT" && r1.sizing.target.vol === 10.6 && r1.sizing.target.mdd === null && r1.sizing.method === "vol", J(r1));
  // 跑完優化:新的一份結果歷史波動 14%、已存合計變了 → 設定不跟著走
  const prop2 = { ann_vol_pct: 14, port_returns: { r: [0.02, -0.03, 0.01] } }; ctx.defaultFund = 120000;
  const G = vm.runInContext("mgBag()", ctx);
  ok("跑優化後:目標波動仍 10.6%、本金仍 86,372;槓桿照新的歷史波動重算(10.6 ÷ 14)",
    F.mpsTargetOf(G.sizing, "vol", prop2) === 10.6 && vm.runInContext("mpsFundOf", ctx)(G.sizing) === 86372 && Math.abs(F.mpsLevFor(G.sizing, prop2) - 10.6 / 14) < 1e-12, J(G.sizing));
  // 換優化方法(工具列,不是部位大小)不碰 sizing;增減策略讓投入資金換幣別 → 換算顯示、存檔不動,換回原幣別就是原值
  ccy = "TWD"; const asTwd = vm.runInContext("mpsFundOf", ctx)(G.sizing); delete fx.TWD; const noFx = vm.runInContext("mpsFundOf", ctx)(G.sizing); fx.TWD = 32; ccy = "USDT";
  ok("增減策略換了投入資金幣別:USDT 86,372 → TWD 2,763,904(照匯率換,不把 86,372 當台幣);缺匯率 = null(不猜);換回 USDT 原值、存檔沒動",
    asTwd === 2763904 && noFx === null && vm.runInContext("mpsFundOf", ctx)(G.sizing) === 86372 && G.sizing.fund === 86372 && G.sizing.fundCcy === "USDT", J([asTwd, noFx]));
  // 在 TWD 下打開框、本金沒動按確定:存檔維持 USDT 原值(不被換算後的數蓋掉)
  ccy = "TWD"; const r2 = vm.runInContext("mgSizeParse", ctx)(draft(G.sizing, prop2)); ccy = "USDT";
  ok("別的幣別下開框按確定、本金沒動:存檔仍是 86,372 USDT;用戶改本金才換成新幣別", r2.sizing.fund === 86372 && r2.sizing.fundCcy === "USDT"
    && (() => { ccy = "TWD"; const d = draft(G.sizing, prop2); d.fund = "3,000,000"; d.fundDirty = true; const r = vm.runInContext("mgSizeParse", ctx)(d); ccy = "USDT"; return r.sizing.fund === 3000000 && r.sizing.fundCcy === "TWD"; })(), J(r2));
  // 存著最大回撤、這份結果沒有序列(畫面退回目標波動):沒點分段按確定,方法仍是最大回撤
  const Gm = vm.runInContext("mgBag()", ctx); Gm.sizing = F.mpsSizingClean({ fund: 1000, fundCcy: "USDT", method: "mdd", target: { mdd: 15 } });
  const r3 = vm.runInContext("mgSizeParse", ctx)(draft(Gm.sizing, { ann_vol_pct: 20 }));
  ok("最大回撤暫時不能用(畫面退回目標波動),沒點分段按確定:存著的方法仍是最大回撤、回撤目標 15% 不動;點過才換", r3.sizing.method === "mdd" && r3.sizing.target.mdd === 15
    && (() => { const d = draft(Gm.sizing, { ann_vol_pct: 20 }); d.method = "lev"; d.methodDirty = true; return vm.runInContext("mgSizeParse", ctx)(d).sizing.method === "lev"; })()
    && /d\.method = m; d\.methodDirty = true;/.test(cutF(psrc, "mgSizeRender")) && /methodDirty: false/.test(cutF(psrc, "mgSizeOpen")), J(r3));
  { const p3 = { ann_vol_pct: 10.63 }, r = vm.runInContext("mgSizeParse", ctx)(draft(F.mpsSizingClean(null), p3));
    ok("按確定沒打字釘的是未取整的原值:歷史波動 10.63% → 槓桿剛好 1(框裡顯示 10.6 也不會讓表動一下)", r.sizing.target.vol === 10.63 && F.mpsLevFor(r.sizing, p3) === 1
      && /d\.fundDirty \? 0 : d\.fund0, d\.method, d\.dirty\[d\.method\] \? 0 : d\.t0\[d\.method\]/.test(cutF(psrc, "mgSizeParse")) && /mgsDraft\.t0\[m\] = v;/.test(cutF(psrc, "mgSizeOpen")), J(r)); }
  // 清空 = 回預設(用戶自己的選擇)
  Gm.sizing = r1.sizing;
  { const d = draft(G.sizing, prop2); d.t.vol = ""; d.dirty.vol = true; const r = vm.runInContext("mgSizeParse", ctx)(d);
    ok("清空目標 = 回預設(null,跟著優化結果走);本金照舊", r.sizing.target.vol === null && r.sizing.fund === 86372, J(r)); }
  vm.runInContext("mgSave", ctx)(ctx.TR, "ws_mg_sizing", r1.sizing);
  // 重開 app(本機):新的一袋從 localStorage 讀回
  const B2 = { env: "local", sig: {} }; ctx.B2 = B2; const G2 = vm.runInContext("mgBag(B2)", ctx);
  ok("重開(本機):新的一袋讀回同一份設定", J(G2.sizing) === J(r1.sizing) && JSON.parse(store.ws_mg_sizing).target.vol === 10.6, J(G2.sizing));
  // 雲端:寫進主行程(ui-prefs.json),重開後新的一袋非同步讀回;讀回前用戶已經設過就不蓋;換人(C.mg 清掉)回來的那份丟掉
  const C = { env: "cloud", sig: {} }; ctx.C = C; ctx.TR = C; const Gc = vm.runInContext("mgBag(C)", ctx);
  Gc.sizing = r1.sizing; vm.runInContext("mgSave", ctx)(C, "ws_mg_sizing", Gc.sizing);
  const cloudTest = (async () => {
    await new Promise((r) => setTimeout(r, 5));
    const C2 = { env: "cloud", sig: {} }; ctx.C2 = C2; ctx.TR = C2; const before = J(vm.runInContext("mgBag(C2)", ctx).sizing);
    await new Promise((r) => setTimeout(r, 5));
    const after = C2.mg.sizing;
    const C3 = { env: "cloud", sig: {} }; ctx.C3 = C3; const G3 = vm.runInContext("mgBag(C3)", ctx); G3.sizingSet = true; G3.sizing = F.mpsSizingClean({ fund: 7 });
    const C4 = { env: "cloud", sig: {} }; ctx.C4 = C4; vm.runInContext("mgBag(C4)", ctx); C4.mg = null;
    await new Promise((r) => setTimeout(r, 5));
    ok("重開(雲端):設定寫進主行程(只寫部位大小,不寫成員清單);新的一袋讀回同一份並重畫;讀回前已設過的不蓋;換人後回來的丟掉",
      cloudSet.length === 1 && before === J(F.mpsSizingClean(null)) && J(after) === J(r1.sizing) && ctx.painted >= 1 && G3.sizing.fund === 7 && C4.mg === null && !("ws_mg_sizing" in store && JSON.parse(store.ws_mg_sizing).fund === 7), J([cloudSet.length, after])); })();
  global.__sizingCloudTest = cloudTest; }
// 主行程:雲端部位大小存 ui-prefs.json、綁 who(換人 / 重新登入讀不到上一份)、清洗後才落地、不動其他鍵
{ const os = require("os"), msrc = fs.readFileSync(path.join(R, "..", "main.js"), "utf8"), pre = fs.readFileSync(path.join(R, "..", "preload.js"), "utf8");
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "blave-mgs-")); let who = "A";
  const ctx = { fs, path, app: { getPath: () => TMP }, currentWho: () => who };
  vm.runInNewContext([/^const uiPrefsPath = .*$/m.exec(msrc)[0], cutF(msrc, "uiPrefsPatch"), cutF(msrc, "mgSizingClean"), cutF(msrc, "mgSizingCloudGet"), cutF(msrc, "mgSizingCloudSet")].join("\n") + "\nthis.get = mgSizingCloudGet; this.set = mgSizingCloudSet;", ctx);
  fs.writeFileSync(path.join(TMP, "ui-prefs.json"), JSON.stringify({ pdfDir: "/x", stratOrder: ["a"] }));
  const a0 = ctx.get(), w = ctx.set({ fund: 86372, fundCcy: "USDT", method: "vol", target: { vol: 10.6, mdd: "x" }, evil: "<script>" }), back = ctx.get();
  who = "B"; const asB = ctx.get(); who = null; const none = ctx.get(), wNone = ctx.set({ fund: 1 }); who = "A";
  const file = JSON.parse(fs.readFileSync(path.join(TMP, "ui-prefs.json"), "utf8"));
  ok("主行程:沒存過 = null;存了讀回(清洗、丟多餘鍵);換人 / 沒登入讀不到也不寫;pdfDir 與側欄偏好不動;IPC 只收自家頁面",
    a0 === null && w === true && J(back) === J({ fund: 86372, fundCcy: "USDT", method: "vol", target: { vol: 10.6, mdd: null, lev: null } }) && asB === null && none === null && wNone === false
    && file.pdfDir === "/x" && J(file.stratOrder) === J(["a"]) && file.mgSizingCloud.who === "A" && !fs.readdirSync(TMP).some((f) => /blave-tmp/.test(f))
    && /handle\("mg-sizing-cloud", \(\) => mgSizingCloudGet\(\), null\);/.test(msrc) && /handle\("mg-sizing-cloud-set", \(_e, v\) => mgSizingCloudSet\(v\), false\);/.test(msrc)
    && /mgSizingCloud: \(\) => ipcRenderer\.invoke\("mg-sizing-cloud"\)/.test(pre) && /mgSizingCloudSet: \(v\) => ipcRenderer\.invoke\("mg-sizing-cloud-set", v\)/.test(pre), J([a0, back, asB, file]));
  fs.rmSync(TMP, { recursive: true, force: true }); }
// 第三台實測(cs-0124-w3)+ 設計稽核電腦版必改
{ const ctx = vm.createContext({ t: (k, o) => k + (o ? " " + JSON.stringify(o) : ""), TR: { list: [{ name: "txf", symbol: "TXF", twd: true }, { name: "tsmc", symbol: "2330", twd: true }, { name: "btc", symbol: "BTCUSDT" }] }, PAPER: "paper", TR_TWD_RE: /^(?:TXF|MXF|TMF|\d{4,6}[A-Z]?(?:\.TWO?)?)$/, CX_VENUES: { binance: {} } });
  vm.runInContext(["trCanonSym", "trTxfSpec", "trCapitalCanon", "trTwBroker", "trVenueKind", "trTradesSym", "trPaperTw"].map((n) => { try { return cutF(src, n); } catch (_) { return ""; } }).join("\n") + "\nvar TR_TXF_SPECS = " + J({ TXF: { cv: 200, prod: "x" }, MXF: { cv: 50, prod: "y" }, TMF: { cv: 10, prod: "z" } }) + ";", ctx);
  let vid = "paper"; ctx.trVenueId = () => vid;
  const run = (x) => vm.runInContext(x, ctx);
  ok("模擬交易照機器(lib/order_paper):台指期以口數成交 → 部位表對得上帳(不是「—」)、picker 不鎖;台股仍不支援;加密交易所不交易台指期",
    run('trVenueKind("paper")') === "paper" && run('trTradesSym("paper", "TXF")') && run('trTradesSym("paper", "TMF")') && !run('trTradesSym("paper", "2330")') && run('trTradesSym("paper", "BTCUSDT")')
    && !run('trTradesSym("crypto", "TXF")') && !run('trPaperTw("txf")') && run('trPaperTw("tsmc")') && !run('trPaperTw("btc")') && (vid = "binance", !run('trPaperTw("tsmc")'))); }
ok("① 台指期報價兩個視角都問(統一、模擬交易在這台電腦也下台指期)", /if \(txf\) trTxfWant\(\);/.test(src) && !/if \(txf && cloud\) trTxfWant/.test(src));
ok("③ 套用金額走同一道:trSaveAmounts 擋模擬交易台股往上加(cf-block、okDisabled),配置分頁的輸入格也是 trPaperTw",
  /const paperTw = Object\.keys\(sending\)\.filter\(\(n\) => trPaperTw\(n\) && \(Number\(sending\[n\]\) \|\| 0\) > old\(n\)\);/.test(src) && /const blocked = badStored\.length > 0 \|\| paperTw\.length > 0;/.test(src) && /const twdRow = trPaperTw\(n\);/.test(src)
  && /mgApply[\s\S]*trSaveAmounts\(trNames\(\), trBase\(\), opener, \{ source: "optimize"/.test(psrc));
{ const ctx = vm.createContext({ t: (k) => k }); vm.runInContext(cutF(src, "trCloseTag"), ctx);
  ok("確認框「平倉」:帳上沒有這支的部位(trStratHeld false)不標;讀不到(null)照舊標;兩個確認框都帶",
    vm.runInContext("trCloseTag(5, 0, true, false)", ctx) === null && vm.runInContext("trCloseTag(5, 0, true, null)", ctx) === "tr.cfTagClose" && vm.runInContext("trCloseTag(5, 0, true, true)", ctx) === "tr.cfTagClose"
    && /mayFire && was > 0 && trStratHeld\(n\) !== false/.test(src)); }
ok("口數列的未實現／保證金寫台幣(帳戶幣不是台幣時),表底不把台幣跟帳戶幣加在一起;拒單接在細節行底下、靠左",
  /rowCcy = lot \? TR_TXF_CCY : unit, ccy = rowCcy !== unit \? rowCcy : null/.test(src) && /const oneCcy = detRows\.every/.test(src) && /tb\.appendChild\(row\); rowOf\[sym\] = row;   \/\/ 拒單接在細節行底下/.test(src)
  && /\.pf-tbl td\.note\.po-err \{ text-align: left; \}/.test(fs.readFileSync(path.join(R, "trade.css"), "utf8")));
ok("設計稽核電腦版必改 1:合計算不出來 → 啟動框只寫「照策略組合 N 支策略下單。」、表底右邊整段不畫(含淨值)",
  /if \(!p\.ok\) return t\(p\.n === 1 \? "tr\.startPlanNOne" : "tr\.startPlanN", \{ n: String\(p\.n\) \}\);/.test(src) && /if \(pt && pt\.ok\) \{/.test(src) && /ok: zt\.total\.v != null,/.test(src));
{ const css = fs.readFileSync(path.join(R, "trade.css"), "utf8");
  ok("建議:「策略外」標籤同「合約」那一階(ink-3、一般字重);有說明的欄頭字畫虛線底線", /\.pf-tbl \.mkt-tag\.own-tag \{ color: var\(--ink-3\); font-weight: 400; \}/.test(css) && /\.pf-tbl th \.th-tip \{ cursor: help; text-decoration: underline dotted;/.test(css)); }
ok("1264 寬開著聊天欄(Windows 捲軸佔 17px):中欄 ≤ 600 時表頭可以折行,金額表收得進去不冒橫向捲軸",
  /@container \(max-width: 600px\) \{\n  \.pf-tbl th \{ white-space: normal; vertical-align: bottom; \}\n\}/.test(fs.readFileSync(path.join(R, "trade.css"), "utf8")));
// 備案 B(post-connect-flow):統一綁好頁主鈕「完成」、關框停在自動下單;Z 時原因行換描邊鈕「到策略組合」;統一一支台指期策略都沒有時選擇框給出口;埋點 cfg_go_start
{ const pres = fs.readFileSync(path.join(R, "president.js"), "utf8"), S = fs.readFileSync(path.join(R, "strings.js"), "utf8"), tel = fs.readFileSync(path.join(R, "..", "telemetry.js"), "utf8");
  ok("統一綁好頁:主鈕 pres.done.ok(完成／Done),pres.done.go 退場;按了關框、一律停在自動下單", /view === "d-done" \? t\("pres\.done\.ok"\)/.test(pres) && /cxModalClose\(true\); if \(!\(TR\.open && TR\.view === "tr"\)\) trOpen\(\);/.test(pres)
    && S.includes('"pres.done.ok": "完成"') && S.includes('"pres.done.ok": "Done"') && !/"pres\.done\.go"/.test(S));
  ok("Z 時(設計稽核必改 1):「到策略組合」是動作列的描邊鈕,插在停用的「啟動下單」左邊;只在純 Z(沒有解除暫停、不是等回報)時出;原因行只留一句話",
    /u = trEl\("button", "btn-out", ""\); u\.type = "button"; u\.id = "tr-go-cfg"; u\.addEventListener\("click", \(\) => trZGo\(u\.dataset\.go, u\)\); \$\("tr-act"\)\.insertBefore\(u, \$\("tr-go"\)\);/.test(src)
    && /trPaintGoCfg\(zg\.btn, zg\.fill, zg\.zc\);/.test(src) && /if \(kind !== "pick" && kind !== "amt" && kind !== "draft"\) \{ poOpen\("cfg", true\); return; \}/.test(src) && !/tr-noamt-go/.test(src)
    && S.includes('"po.goCfg": "到策略組合"') && !/"tr\.startOffNoAmtShort"/.test(S));
  ok("Z 時(設計稽核必改 2):有金額、但這家都下不了 → 「還沒有{venue}能下的策略金額。」;完全沒有金額由 trZGuide 換成缺哪一步(spec-autotrade-empty),剩下的只有設定讀不到",
    /line\.append\(trUnrouted\(rr\)\.length \? t\("tr\.startOffNoRoute"\) : any \? t\("tr\.startOffNoVenueAmt", \{ venue: trVenueLabel\(trVenueId\(\), true\) \}\) : t\("tr\.cfgNull"\)\);/.test(src)
    && S.includes('"tr.startOffNoVenueAmt": "還沒有{venue}能下的策略金額。"') && S.includes('"tr.startOffNoVenueAmt": "No strategy has an amount {venue} can trade yet."'));
  ok("pres.s.worker* 改名:連上統一／連線中…／沒有讀到統一帳戶…(跟頁首的「下單程式」分開)", S.includes('"pres.s.worker": "連上統一"') && S.includes('"pres.s.workerRun": "連線中…"') && S.includes('"pres.s.workerFail": "沒有讀到統一帳戶。再試一次；還是不行，看設定 › 帳戶的狀態。"'));
  ok("選擇策略框:每一列都被「只下台指期」鎖住 → 清單底下 tr.pick.noTxf + 到策略庫(關框、開策略庫)", /if \(!mg && rows\.length && rows\.every\(\(r\) => r\.note === "txf"\)\) \{/.test(src) && /psClose\(\); if \(typeof libOpen === "function"\) libOpen\(\);/.test(src) && S.includes('"tr.pick.noTxf": "還沒有台指期策略。"'));
  ok("埋點:cfg_go_start 在白名單、按「到自動下單啟動」時送;post_connect_to_cfg 不加", /"cfg_go_start",/.test(tel) && /"mg_run_now",/.test(tel) && /trackFeature\("cfg_go_start"\)/.test(src) && !/post_connect_to_cfg/.test(tel + src)); }
// 設計師:句中的 venue 用各語言自己的名字(zh 統一期貨／en President Futures,不混中英);「5 口」接「的部位」不留空白
{ const S = fs.readFileSync(path.join(R, "strings.js"), "utf8");
  ok("「還沒有{venue}能下的策略金額」的 venue 走 trVenueLabel → pres.venue(zh 統一期貨、en President Futures,不是中英並列的選單標籤);tr.startOnBook 的 {n} 後面沒有空白",
    S.includes('"pres.venue": "統一期貨"') && S.includes('"pres.venue": "President Futures"') && /if \(id === "president"\) return t\("pres\.venue"\);/.test(src)
    && /t\("tr\.startOffNoVenueAmt", \{ venue: trVenueLabel\(trVenueId\(\), true\) \}\)/.test(src) && S.includes('"tr.startOnBook": "帳本上還有 {n}的部位；')); }
{ const S = fs.readFileSync(path.join(R, "strings.js"), "utf8"), gone = ["tr.unsaved", "tr.exchPositions", "tr.noPositions", "tr.net.foot", "tr.unmanaged", "tr.threshold", "tr.cloud.saveIdle", "tr.cloud.saveLag",
    "tr.cloud.saveIdleUnconfirmed", "tr.cloud.saveLive.h", "tr.cloud.saveLive.b", "tr.amountFoot", "tr.pick.hint", "tr.orderFailedLast", "tr.orderFailedLastWhy", "tr.strategies"];
  ok("退場的 key 兩語都刪了(設計稽核偏離 #8);還在用的 tr.onboard / tr.pick.noneChosen / tr.noStrategies 留著", gone.every((k) => S.indexOf('"' + k + '":') < 0) && ["tr.onboard", "tr.pick.noneChosen", "tr.noStrategies"].every((k) => S.indexOf('"' + k + '":') >= 0)); }
// Wei 10-14:「載入中」只留一個;第一次安裝引擎時講在等什麼(engine.js 的 ENG.snap = enginesetup 快照)
{ const ctx = vm.createContext({ t: (k) => k }); vm.runInContext(cutF(src, "trLoadingText"), ctx);
  const L = (env, snap) => { ctx.TR = { env }; ctx.ENG = { snap }; return vm.runInContext("trLoadingText()", ctx); };
  ok("載入中的字:第一次安裝引擎 → tr.loadingEngine;更新引擎 → tr.loadingEngineUpd;裝完 / 沒有快照 / 雲端 → tr.loading",
    L("local", { phase: "run", kind: "first" }) === "tr.loadingEngine" && L("local", { phase: "run", kind: "update" }) === "tr.loadingEngineUpd"
    && L("local", { phase: "done", kind: "first" }) === "tr.loading" && L("local", null) === "tr.loading" && L("cloud", { phase: "run", kind: "first" }) === "tr.loading");
  ok("只留一個:自動下單頁頁首那一行講(trStateText),內容區不再畫第二個「載入中…」;策略組合頁沒有頁首狀態行,寫在內容區那一處",
    /if \(state === "loading"\) return TR\.env === "cloud" \? t\("tr\.cloud\.hdFetching"\) : trLoadingText\(\);/.test(src) && /if \(state === "loading"\) return;/.test(cutF(src, "trPaintOnboard"))
    && !/t\("tr\.loading"\)/.test(cutF(src, "trPaintOnboard")) && /trEl\("div", "pf-state", trLoadingText\(\)\)/.test(cutF(src, "poPaintCfg"))); }
// 程式稽核 audit-desktop-portfolio-2026-10-14
ok("P1-1 trRoundLots 補 1e-9(同機器 lib/portfolio、網頁 pfRoundLots):0.01 + 3×0.83 = 2.4999… → 3;負的同樣往外", C.trRoundLots(0.01 + 3 * 0.83) === 3 && C.trRoundLots(-(0.01 + 3 * 0.83)) === -3 && C.trRoundLots(2.4) === 2 && C.trLotsTarget(0.01 + 3 * 0.83).lots === 3);
{ // P0-1:雲端存完、報告還沒對上——合約與口數出自同一份快照;待對上期間下拉與換合約的存檔都鎖住
  const ctx = vm.createContext({ console, JSON, Object, Array, String, Number, Math, isFinite, t: (k) => k, trackFeature() {}, poPaintCfg() {}, ctFocus() {} });
  vm.runInContext(tp.replace(/^const /gm, "var ") + "\n" + ["trReport", "trContracts", "trStored", "trBase", "trCtPend", "trCtStored", "trCt", "trCtGate", "trCtPayload", "trCtPick", "trRowTxf"].map((n) => cutF(src, n)).join("\n"), ctx);
  const bag = () => ({ env: "cloud", list: [{ name: "a", symbol: "TXF" }, { name: "b", symbol: "BTCUSDT" }], edits: { b: 200 }, bad: {}, raw: {}, sig: {}, reqIds: {}, save: "sent",
    st: { alive: true, report: { config: { amounts: { a: 1, b: 100 }, contracts: {} }, can_switch_contract: true, states: {} } },
    sent: { a: 20, b: 100 }, ct: { edits: {}, basis: {}, sent: { a: "TMF" } } });   // 1 大台 → 20 微台存了、主機還沒回報
  ctx.TR = bag();
  const sending = vm.runInContext("Object.assign({}, trBase(), TR.edits)", ctx);
  const ctAll = vm.runInContext("trCtPayload(" + J(Object.keys(sending)) + ")", ctx);
  const steps = vm.runInContext("trCtSteps(" + J(sending) + ", trBase(), " + J(ctAll) + ", trCtStored)", ctx);
  ok("P0-1 1 大台換 20 微台、待對上時再改別支金額存檔:存著的合約讀送出的那一份(微台),不帶 contracts、一步送,微台那支照 20 口(不是 400)",
    vm.runInContext("trCtStored('a')", ctx) === "TMF" && ctAll === null && steps.length === 1 && steps[0].amounts.a === 20 && !steps[0].contracts && vm.runInContext("trRowTxf('a').cv", ctx) === 10, J({ ctAll, steps }));
  // 補稽核 P1-2:待對上時啟動框／表底合計／預設本金的口數配 ct.sent 的那一份(S.sent),跟已對上時同一個數
  { const need = ["trRowMoneyStored", "trZoneOf", "trZoneSum", "trTotalText", "trFxView", "trQuoteMap", "trPlanTotal", "trVenueId", "trVenueIds", "trTxfPrice", "trMultFmt", "trSymZone", "trEffSym", "trFmt"];
    vm.runInContext(need.map((n) => { try { return cutF(src, n); } catch (_) { return ""; } }).join("\n") + "\nvar TR_TXF = { price: 20000 }; function trEquity() { return null; } function trUnit() { return 'TWD'; }", ctx);
    const tot = (T) => { ctx.TR = T; return vm.runInContext("(function () { const p = trPlanTotal(trStored()); return p.text + ' ' + p.ccy; })()", ctx); };
    const only = (T) => { delete T.st.report.config.amounts.b; if (T.sent) delete T.sent.b; T.list = [T.list[0]]; return T; };
    const pend = only(bag()), done = only(bag()); done.sent = null; done.ct.sent = null; done.save = null; done.st.report.config = { amounts: { a: 20 }, contracts: { a: "TMF" } };
    const before = only(bag()); before.sent = null; before.ct.sent = null; before.save = null;
    const tp1 = tot(pend), td1 = tot(done), tb1 = tot(before);
    ok("P1-2 1 大台 → 20 微台待對上:合計 = 已對上時的值(4,000,000),不是 1 微台的 200,000;mpsFundDefault 同一條", tp1 === td1 && tb1 === td1 && /4,000,000/.test(tp1)
      && /if \(trCtPend\(\)\) stored = trBase\(\) \|\| stored;/.test(src) && /trZoneSum\(\(trCtPend\(\) \? trBase\(\) : trStored\(\)\) \|\| \{\}, null, trRowMoneyStored\)/.test(psrc), J([tp1, td1, tb1])); }
  // Windows e2e 10-14:微台 1 口 → 大台 → 微台,口數要回到 1(換算基準 = 原本的名目,存檔後也留著;不足一口不補成 1)
  { const L = { env: "local", list: [{ name: "a", symbol: "TXF" }], edits: {}, bad: {}, raw: {}, sig: {}, reqIds: {}, save: null, sent: null,
      st: { alive: true, report: { config: { amounts: { a: 1 }, contracts: { a: "TMF" } }, can_switch_contract: true, states: {} } }, ct: { edits: {}, basis: {}, sent: null } };
    ctx.TR = L; vm.runInContext("trCtPick('a', 'TXF')", ctx);
    const big = L.edits.a;
    L.st.report.config = { amounts: { a: 0 }, contracts: { a: "TXF" } }; L.edits = {}; L.ct.edits = {};   // 存檔成功:stored 換成大台 0 口,換算基準留著
    vm.runInContext("trCtPick('a', 'TMF')", ctx);
    ok("微台 1 口 → 大台:0 口(不足一口,不補成 1);存檔後再換回微台:1 口(照原本的名目,不累積誤差、不放大 20 倍)", big === 0 && L.edits.a === 1, J({ big, back: L.edits.a })); }
  ok("分兩步存檔的第一步照舊最少 1 口(runtime 曝險檢查允許;送 0 口可能讓對帳器在兩步之間先平倉)", C.trCtConvStep(10, 200) === 1 && C.trCtConvStep(0, 200) === 0 && /const conv = trCtConvStep\(old \* TR_TXF_SPECS\[from\]\.cv/.test(src));
  ctx.TR = bag(); vm.runInContext("trCtPick('a', 'TXF')", ctx);
  ok("P0-1 待對上期間選回大台:下拉不畫(純文字)、選了也不動(edits 與合約都不變),存不出「1 微台」",
    vm.runInContext("trCtGate('a')", ctx) === false && J(ctx.TR.ct.edits) === "{}" && ctx.TR.edits.a === undefined && vm.runInContext("trCt('a')", ctx) === "TMF");
  ctx.TR = bag(); ctx.TR.sent = null; ctx.TR.save = null; ctx.TR.ct.sent = null; ctx.TR.st.report.config.contracts = { a: "TMF" }; ctx.TR.st.report.config.amounts.a = 20;
  ok("P0-1 對上之後:讀報告的合約,下拉照常可用", vm.runInContext("trCtStored('a')", ctx) === "TMF" && vm.runInContext("trCtGate('a')", ctx) === true);
  ok("P0-1 第二道:存檔時合約有變、雲端又在待對上 → 不送,講 ct.waitReport", /if \(ctAll && trWith\(S, trCtPend\)\) \{ S\.save = "failed"; S\.saveErr = t\("ct\.waitReport"\);/.test(src)); }
ok("P2-4 TXFR1 不認成口數列(同網頁 pfCtStored;runtime 沒覆寫時 TXFR1 也不是口數)", !/toUpperCase\(\)\.replace\(\/R1\$\/, ""\)/.test(cutF(src, "trCtStored")));
// P1-2:更新績效等待期間按取消,真的取消——等完不送 manage_backtest、也不送 manage_cancel(機器上還沒有 job)
const btCancelTest = (async () => {
  const sent = [], ctx = vm.createContext({ console, JSON, Object, Array, String, Number, Math, Date, Promise, setTimeout, isFinite, t: (k) => k, trackFeature() {}, mgPaint() {}, trPollSoon() {},
    mgMembers: () => ["a"], mgStrategies: () => [], mgRunning: () => false, mgBlocked: () => false, mgBtBlockReason: () => null, mgArgs: () => ({ members: ["a"], allocator: null, params: {} }), trWith: (S, f) => f(), trRejectText: (x) => x, mgShortFromError: () => false, mgErrLine: (x) => x });
  vm.runInContext(pp.replace(/^const /gm, "var ") + "\nMG_REFRESH_POLL_MS = { fast: 15, slow: 15, fastFor: 60000 };\n" + ["mgBag", "mgSizingCloudLoad", "mgPerfAt", "mgRefreshThen", "mgRunBacktest", "mgSendBacktest", "mgCancelBacktest"].map((n) => (/^async /.test(psrc.slice(psrc.indexOf("function " + n + "(") - 6, psrc.indexOf("function " + n + "("))) ? "async " : "") + cutF(psrc, n)).join("\n"), ctx);
  let done = false;
  ctx.TR = { env: "cloud", mg: null, sig: {}, api: { tradeSend: async (cmd, a) => { sent.push(cmd); return cmd === "stats_refresh" ? { ok: true, result: { started: a.names, skipped: {} } } : { ok: true, result: {} }; },
    loadStrategy: async () => ({ perf: done ? { at: 1 } : { at: 1, refresh: { status: "running" } } }) } };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  vm.runInContext("mgRunBacktest()", ctx); await wait(30); vm.runInContext("mgCancelBacktest()", ctx); await wait(80); done = true; await wait(60);
  const G1 = ctx.TR.mg, sent1 = sent.slice();
  ok("P1-2 等更新績效時按取消:等完不送 manage_backtest、不送 manage_cancel;鈕放開(btSending false)", sent1.indexOf("manage_backtest") < 0 && sent1.indexOf("manage_cancel") < 0 && G1.btSending === false, J(sent1));
  sent.length = 0; done = false; ctx.TR.mg = null;
  vm.runInContext("mgRunBacktest()", ctx); await wait(30); done = true; await wait(80);
  ok("P1-2 對照:沒按取消,更新完就照常送 manage_backtest", sent.indexOf("manage_backtest") >= 0, J(sent));
})();
// Wei 10-14(同網頁 951af7ac):跑前只更新 6 小時沒更新過(或拿不到時間)的成員;全部都新就不送、不等,直接跑
const freshTest = (async () => {
  const NOW = Math.floor(Date.now() / 1000), H = 3600;
  const runOnce = async (members, perfAt, ranAt) => {
    const sent = [], ctx = vm.createContext({ console, JSON, Object, Array, String, Number, Math, Date, Promise, setTimeout, isFinite, t: (k) => k, trackFeature() {}, mgPaint() {}, trPollSoon() {},
      mgMembers: () => members, mgStrategies: () => Object.keys(ranAt).map((n) => ({ name: n, ran_at: ranAt[n] })), mgRunning: () => false, mgBlocked: () => false, mgBtBlockReason: () => null,
      mgArgs: () => ({ members, allocator: null, params: {} }), trWith: (S, f) => f(), trRejectText: (x) => x, mgShortFromError: () => false, mgErrLine: (x) => x });
    vm.runInContext(pp.replace(/^const /gm, "var ") + "\nMG_REFRESH_POLL_MS = { fast: 5, slow: 5, fastFor: 60000 };\n" + ["mgBag", "mgSizingCloudLoad", "mgPerfAt", "mgRefreshThen", "mgRunBacktest", "mgSendBacktest"].map((n) => (/^async /.test(psrc.slice(psrc.indexOf("function " + n + "(") - 6, psrc.indexOf("function " + n + "("))) ? "async " : "") + cutF(psrc, n)).join("\n"), ctx);
    let loads = 0;
    ctx.TR = { env: "cloud", mg: null, sig: {}, api: { tradeSend: async (cmd, a) => { sent.push([cmd, a && a.names ? a.names.slice() : null]); return cmd === "stats_refresh" ? { ok: true, result: { started: a.names, skipped: {} } } : { ok: true, result: {} }; },
      tradeStatus: async () => ({}), loadStrategy: async (n) => { loads++; return n in perfAt ? { perf: { at: perfAt[n] } } : {}; } } };
    vm.runInContext("mgRunBacktest()", ctx); await new Promise((r) => setTimeout(r, 120));
    return sent;
  };
  const allFresh = await runOnce(["a", "b"], { a: NOW - H, b: NOW - 6 * H + 5 }, {});
  ok("全部都在 6 小時內:不送 stats_refresh、不等,直接送 manage_backtest", allFresh.length === 1 && allFresh[0][0] === "manage_backtest", J(allFresh));
  const some = await runOnce(["a", "b", "c"], { a: NOW - H, b: NOW - 7 * H, c: NOW - 6 * H - 5 }, { a: NOW - 9 * H });
  ok("一部分舊:只送超過 6 小時的那幾支(b、c);perf.at 優先於 ran_at(a 的 ran_at 雖舊,perf.at 是新的 → 不送)", some.length === 2 && some[0][0] === "stats_refresh" && J(some[0][1]) === J(["b", "c"]) && some[1][0] === "manage_backtest", J(some));
  const unknown = await runOnce(["a", "b", "c"], { a: NOW - H }, { b: NOW - 2 * H });
  ok("拿不到時間:perf.at 與 ran_at 都沒有的那支(c)要更新;只有 ran_at 而且新的(b)不送", unknown.length === 2 && J(unknown[0][1]) === J(["c"]) && unknown[1][0] === "manage_backtest", J(unknown));
})();
// 輪詢:每一輪當場抓新的 detail 再判斷——更新一完成,下一輪就放行(不多等一輪);前 1 分鐘每 3 秒、之後 15 秒
const pollTest = (async () => {
  const sent = [], ctx = vm.createContext({ console, JSON, Object, Array, String, Number, Math, Date, Promise, setTimeout, isFinite, t: (k) => k, trackFeature() {}, mgPaint() {}, trPollSoon() {},
    mgMembers: () => ["a"], mgStrategies: () => [], mgRunning: () => false, mgBlocked: () => false, mgBtBlockReason: () => null, mgArgs: () => ({ members: ["a"], allocator: null, params: {} }), trWith: (S, f) => f(), trRejectText: (x) => x, mgShortFromError: () => false, mgErrLine: (x) => x });
  vm.runInContext(pp.replace(/^const /gm, "var ") + "\nMG_REFRESH_POLL_MS = { fast: 40, slow: 2000, fastFor: 60000 };\n" + ["mgBag", "mgSizingCloudLoad", "mgPerfAt", "mgRefreshThen", "mgRunBacktest", "mgSendBacktest"].map((n) => (/^async /.test(psrc.slice(psrc.indexOf("function " + n + "(") - 6, psrc.indexOf("function " + n + "("))) ? "async " : "") + cutF(psrc, n)).join("\n"), ctx);
  let refreshed = false, t0 = 0, tRun = 0;
  ctx.TR = { env: "cloud", mg: null, sig: {}, api: { tradeSend: async (cmd) => { sent.push(cmd); if (cmd === "stats_refresh") { t0 = Date.now(); setTimeout(() => { refreshed = true; }, 10); return { ok: true, result: { started: ["a"], skipped: {} } }; } tRun = Date.now(); return { ok: true, result: {} }; },
    tradeStatus: async () => ({}), loadStrategy: async () => ({ perf: refreshed ? { at: Math.floor(Date.now() / 1000) } : { at: 1, refresh: { status: "running" } } }) } };
  vm.runInContext("mgRunBacktest()", ctx); await new Promise((r) => setTimeout(r, 400));
  ok("輪詢:更新 10ms 就完成 → 第一輪(40ms)抓完當場判斷就放行,不多等一輪;間隔前 1 分鐘 3 秒、之後 15 秒、上限 20 分鐘",
    sent.indexOf("manage_backtest") > 0 && tRun - t0 < 150 && /const MG_REFRESH_POLL_MS = \{ fast: 3000, slow: 15000, fastFor: 60000 \};/.test(psrc) && /const MG_REFRESH_MAX_MS = 20 \* 60000;/.test(psrc), J({ sent, dt: tRun - t0 }));
})();
// 稽核 audit-prerun-refresh:BUSY 要等、skip 不等、ack 失敗直接跑、超過 50 支分批且每批的 started 都收齊、剛好 6 小時不更新
const refreshEdgeTest = (async () => {
  const NOWMS = Date.parse("2026-10-14T06:00:00Z"), NOWS = NOWMS / 1000;
  class FixedDate extends Date { static now() { return NOWMS; } }
  const go = async ({ members, perfAt, ack, running, waitMs }) => {
    const sent = [], ctx = vm.createContext({ console, JSON, Object, Array, String, Number, Math, Date: FixedDate, Promise, setTimeout, isFinite, t: (k) => k, trackFeature() {}, mgPaint() {}, trPollSoon() {},
      mgMembers: () => members, mgStrategies: () => [], mgRunning: () => false, mgBlocked: () => false, mgBtBlockReason: () => null,
      mgArgs: () => ({ members, allocator: null, params: {} }), trWith: (S, f) => f(), trRejectText: (x) => x, mgShortFromError: () => false, mgErrLine: (x) => x });
    vm.runInContext(pp.replace(/^const /gm, "var ") + "\nMG_REFRESH_POLL_MS = { fast: 5, slow: 5, fastFor: 60000 };\n" + ["mgBag", "mgSizingCloudLoad", "mgPerfAt", "mgRefreshThen", "mgRunBacktest", "mgSendBacktest"].map((n) => (/^async /.test(psrc.slice(psrc.indexOf("function " + n + "(") - 6, psrc.indexOf("function " + n + "("))) ? "async " : "") + cutF(psrc, n)).join("\n"), ctx);
    const T0 = Date.now(); let runAt = null;
    ctx.TR = { env: "cloud", mg: null, sig: {}, api: {
      tradeSend: async (cmd, a) => { sent.push([cmd, a && a.names ? a.names.length : null]); if (cmd !== "stats_refresh") { runAt = Date.now() - T0; return { ok: true, result: {} }; } return ack(a.names); },
      tradeStatus: async () => ({}),
      loadStrategy: async (n) => ({ perf: Object.assign({ at: perfAt(n) }, running(n, Date.now() - T0) ? { refresh: { status: "running" } } : {}) }) } };
    vm.runInContext("mgRunBacktest()", ctx); await new Promise((r) => setTimeout(r, waitMs || 150));
    return { sent, runAt };
  };
  const OLD = () => NOWS - 7 * 3600;
  // BUSY:機器說已經在跑,也要等它結束(拿掉 BUSY 那條 → 一開始就送 manage_backtest)
  const busy = await go({ members: ["a"], perfAt: OLD, ack: () => ({ ok: true, result: { started: [], skipped: { a: "BUSY" } } }), running: (n, ms) => ms < 60 });
  ok("BUSY:等那支結束(60ms 後)才送 manage_backtest", busy.runAt !== null && busy.runAt >= 55 && busy.sent.filter((x) => x[0] === "manage_backtest").length === 1, J(busy));
  // skip(非 BUSY):不等——就算 detail 一直說在跑也直接送(改成「等全部送出的成員」→ 永遠不送)
  const skip = await go({ members: ["a"], perfAt: OLD, ack: () => ({ ok: true, result: { started: [], skipped: { a: "NO_STATS" } } }), running: () => true });
  ok("skip(不是 BUSY):不等,照舊數字直接送 manage_backtest", skip.runAt !== null && skip.runAt < 40, J(skip));
  // ack 失敗(ok:false／null):不等,直接跑
  const fail = await go({ members: ["a"], perfAt: OLD, ack: () => ({ ok: false, error: "TIMEOUT" }), running: () => true });
  ok("ack 失敗:不等,直接送 manage_backtest", fail.runAt !== null && fail.runAt < 40, J(fail));
  // 120 支:分 50／50／20 三批;第一批裡的 m0 還在跑要等(只收最後一批的 started → 不等 m0、太早送);只送一次 manage_backtest
  const many = Array.from({ length: 120 }, (_, i) => "m" + i);
  const bat = await go({ members: many, perfAt: OLD, ack: (names) => ({ ok: true, result: { started: names, skipped: {} } }), running: (n, ms) => n === "m0" && ms < 60 });
  ok("120 支分三批(50／50／20),三批的 started 都收齊:第一批的 m0 跑完才送,manage_backtest 只送一次",
    J(bat.sent.filter((x) => x[0] === "stats_refresh").map((x) => x[1])) === J([50, 50, 20]) && bat.runAt !== null && bat.runAt >= 55 && bat.sent.filter((x) => x[0] === "manage_backtest").length === 1, J({ runAt: bat.runAt, n: bat.sent.length }));
  // 剛好 6 小時不更新(`>=` → 會送 stats_refresh);6 小時又 1 秒要更新
  const edge = await go({ members: ["a"], perfAt: () => NOWS - 6 * 3600, ack: (names) => ({ ok: true, result: { started: names, skipped: {} } }), running: () => false });
  const over = await go({ members: ["a"], perfAt: () => NOWS - 6 * 3600 - 1, ack: (names) => ({ ok: true, result: { started: names, skipped: {} } }), running: () => false });
  ok("剛好 6 小時:不送 stats_refresh、直接跑;6 小時又 1 秒:要更新", edge.sent.length === 1 && edge.sent[0][0] === "manage_backtest" && over.sent[0][0] === "stats_refresh", J([edge.sent, over.sent]));
})();
// 網頁 042538da 抓到的兩種:取消後馬上重按,舊的那一輪不能也送;已送出、ack 還沒回時按取消要送 manage_cancel
const cancelGenTest = (async () => {
  const sent = [], ctx = vm.createContext({ console, JSON, Object, Array, String, Number, Math, Date, Promise, setTimeout, isFinite, t: (k) => k, trackFeature() {}, mgPaint() {}, trPollSoon() {},
    mgMembers: () => ["a"], mgStrategies: () => [], mgRunning: () => false, mgBlocked: () => false, mgBtBlockReason: () => null, mgArgs: () => ({ members: ["a"], allocator: null, params: {} }), trWith: (S, f) => f(), trRejectText: (x) => x, mgShortFromError: () => false, mgErrLine: (x) => x });
  vm.runInContext(pp.replace(/^const /gm, "var ") + "\nMG_REFRESH_POLL_MS = { fast: 10, slow: 10, fastFor: 60000 };\n" + ["mgBag", "mgSizingCloudLoad", "mgPerfAt", "mgRefreshThen", "mgRunBacktest", "mgSendBacktest", "mgCancelBacktest"].map((n) => (/^async /.test(psrc.slice(psrc.indexOf("function " + n + "(") - 6, psrc.indexOf("function " + n + "("))) ? "async " : "") + cutF(psrc, n)).join("\n"), ctx);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let done = false, ackDelay = 0;
  ctx.TR = { env: "cloud", mg: null, sig: {}, api: {
    tradeSend: async (cmd, a) => { sent.push(cmd); if (cmd === "stats_refresh") return { ok: true, result: { started: a.names, skipped: {} } }; if (cmd === "manage_backtest" && ackDelay) await wait(ackDelay); return { ok: true, result: {} }; },
    tradeStatus: async () => ({}), loadStrategy: async () => ({ perf: done ? { at: 1 } : { at: 1, refresh: { status: "running" } } }) } };
  // 1. 等更新中按取消、馬上重按:更新結束後只送一次 manage_backtest(新的那一輪),舊的那一輪不送;取消不送 manage_cancel
  vm.runInContext("mgRunBacktest()", ctx); await wait(30); vm.runInContext("mgCancelBacktest()", ctx); vm.runInContext("mgRunBacktest()", ctx); await wait(30); done = true; await wait(80);
  ok("取消等待中的那一次後馬上重按:更新完只送一次 manage_backtest(舊那一輪換了號碼不送),也不送 manage_cancel",
    sent.filter((c) => c === "manage_backtest").length === 1 && sent.indexOf("manage_cancel") < 0, J(sent));
  // 2. 已經送出 manage_backtest、ack 還沒回時按取消:是真的有 job → 送 manage_cancel
  sent.length = 0; ctx.TR.mg = null; done = true; ackDelay = 80;
  vm.runInContext("mgRunBacktest()", ctx); await wait(30);
  const inFlight = sent.indexOf("manage_backtest") >= 0;
  vm.runInContext("mgCancelBacktest()", ctx); await wait(120);
  ok("回測已送出、ack 還沒回時按取消:送 manage_cancel(不是當成還在等更新而作廢)", inFlight && sent.indexOf("manage_cancel") >= 0, J(sent));
})();
// Wei 10-14:等更新績效時鈕下方一行「等「X」更新績效…」+「先用目前數字跑」——按了停止等待、立刻送一次;正在跑的更新不取消
const runNowTest = (async () => {
  const mk = () => { const sent = [], ctx = vm.createContext({ console, JSON, Object, Array, String, Number, Math, Date, Promise, setTimeout, isFinite, t: (k) => k, trackFeature(n) { sent.push("feature:" + n); }, mgPaint() {}, trPollSoon() {},
      mgMembers: () => ["a", "b", "c"], mgStrategies: () => [], mgRunning: () => false, mgBlocked: () => false, mgBtBlockReason: () => null, mgArgs: () => ({ members: ["a", "b", "c"], allocator: null, params: {} }), trWith: (S, f) => f(), trRejectText: (x) => x, mgShortFromError: () => false, mgErrLine: (x) => x });
    vm.runInContext(pp.replace(/^const /gm, "var ") + "\nMG_REFRESH_POLL_MS = { fast: 2000, slow: 2000, fastFor: 60000 };\n" + ["mgBag", "mgSizingCloudLoad", "mgPerfAt", "mgRefreshThen", "mgRunNow", "mgRunOptimize", "mgSendOptimize", "mgRunBacktest", "mgSendBacktest", "mgCancelBacktest"].map((n) => (/^async /.test(psrc.slice(psrc.indexOf("function " + n + "(") - 6, psrc.indexOf("function " + n + "("))) ? "async " : "") + cutF(psrc, n)).join("\n"), ctx);
    ctx.TR = { env: "cloud", mg: null, sig: {}, api: { tradeSend: async (cmd, a) => { sent.push(cmd); return cmd === "stats_refresh" ? { ok: true, result: { started: a.names, skipped: {} } } : { ok: true, result: {} }; },
      tradeStatus: async () => ({}), loadStrategy: async () => ({ perf: { at: 1, refresh: { status: "running" } } }) } };
    return { sent, ctx }; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  { const { sent, ctx } = mk(); vm.runInContext("mgRunOptimize()", ctx); await wait(30);
    const W = vm.runInContext("TR.mg.wait.opt", ctx), left = W ? W.left.slice() : null;
    vm.runInContext("mgRunNow('opt'); mgRunNow('opt')", ctx); await wait(40);
    ok("跑優化在等三支更新:G.wait.opt.left 是那三支(鈕下方那一行的來源);按「先用目前數字跑」→ 不等 2 秒輪詢、馬上送一次 manage_optimize;按兩下也只送一次;埋點 mg_run_now 一次;不送取消更新的指令",
      J(left) === J(["a", "b", "c"]) && sent.filter((c) => c === "manage_optimize").length === 1 && sent.filter((c) => c === "feature:mg_run_now").length === 1 && vm.runInContext("TR.mg.wait.opt", ctx) === null
      && !sent.some((c) => /cancel/.test(c)), J(sent)); }
  { const { sent, ctx } = mk(); vm.runInContext("mgRunBacktest()", ctx); await wait(30); vm.runInContext("mgRunNow('bt')", ctx); await wait(40);
    ok("跑回測等更新時「先用目前數字跑」→ 馬上送一次 manage_backtest(世代號照舊)", sent.filter((c) => c === "manage_backtest").length === 1, J(sent)); }
  { const { sent, ctx } = mk(); vm.runInContext("mgRunBacktest()", ctx); await wait(30); vm.runInContext("mgCancelBacktest()", ctx); const gone = vm.runInContext("TR.mg.wait.bt", ctx);
    vm.runInContext("mgRunNow('bt')", ctx); await wait(40);
    ok("等更新時按「取消」照舊:那一行當場收掉;之後再按舊的「先用目前數字跑」也不送;不送 manage_backtest、不送 manage_cancel", gone === null && vm.runInContext("TR.mg.wait.bt", ctx) === null
      && sent.indexOf("manage_backtest") < 0 && sent.indexOf("manage_cancel") < 0 && sent.indexOf("feature:mg_run_now") < 0, J(sent)); }
  ok("鈕下方那一行:只在 G.wait[w] 有在等的成員時畫;一支 mg.waitOne、多支 mg.waitMany(第一支 + 總數);文字鈕 mg.runNow",
    /\["opt", "bt"\]\.forEach\(\(w\) => \{ const W = G\.wait\[w\]; if \(!W \|\| !W\.left\.length\) return;/.test(psrc) && /n === 1 \? t\("mg\.waitOne", \{ name: trDisplay\(W\.left\[0\]\) \}\) : t\("mg\.waitMany", \{ name: trDisplay\(W\.left\[0\]\), n, more: n - 1 \}\)/.test(psrc)
    && /G\.wait\.opt && G\.wait\.opt\.left, G\.wait\.bt && G\.wait\.bt\.left,/.test(psrc));
})();
// 稽核第三輪:取消後馬上重按——舊那一輪結束時不能把新那一輪的轉圈旗標(G.refreshing.bt)清掉
const refreshFlagTest = (async () => {
  const sent = [], ctx = vm.createContext({ console, JSON, Object, Array, String, Number, Math, Date, Promise, setTimeout, isFinite, t: (k) => k, trackFeature() {}, mgPaint() {}, trPollSoon() {},
    mgMembers: () => ["a"], mgStrategies: () => [], mgRunning: () => false, mgBlocked: () => false, mgBtBlockReason: () => null, mgArgs: () => ({ members: ["a"], allocator: null, params: {} }), trWith: (S, f) => f(), trRejectText: (x) => x, mgShortFromError: () => false, mgErrLine: (x) => x });
  vm.runInContext(pp.replace(/^const /gm, "var ") + "\nMG_REFRESH_POLL_MS = { fast: 10, slow: 10, fastFor: 60000 };\n" + ["mgBag", "mgSizingCloudLoad", "mgPerfAt", "mgRefreshThen", "mgRunNow", "mgRunBacktest", "mgSendBacktest", "mgCancelBacktest"].map((n) => (/^async /.test(psrc.slice(psrc.indexOf("function " + n + "(") - 6, psrc.indexOf("function " + n + "("))) ? "async " : "") + cutF(psrc, n)).join("\n"), ctx);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  ctx.TR = { env: "cloud", mg: null, sig: {}, api: { tradeSend: async (cmd, a) => { sent.push(cmd); return cmd === "stats_refresh" ? { ok: true, result: { started: a.names, skipped: {} } } : { ok: true, result: {} }; },
    tradeStatus: async () => ({}), loadStrategy: async () => { if (slow) await wait(80); return { perf: { at: 1, refresh: { status: "running" } } }; } } };
  // 讓舊那一輪卡在「抓 detail」(80ms):取消、重按之後,新那一輪先把旗標立起來,舊那一輪才結束——結束時不能清掉新那一輪的
  let slow = false;
  vm.runInContext("mgRunBacktest()", ctx); await wait(5); slow = true; await wait(30);
  vm.runInContext("mgCancelBacktest()", ctx); slow = false; vm.runInContext("mgRunBacktest()", ctx); await wait(120);
  const G = ctx.TR.mg;
  ok("取消後馬上重按:舊那一輪結束後,新那一輪仍在等——G.refreshing.bt 還是 true、G.wait.bt 是新那一輪的、沒送 manage_backtest",
    G.refreshing.bt === true && !!G.wait.bt && G.wait.bt.left.length === 1 && sent.indexOf("manage_backtest") < 0, J({ refreshing: G.refreshing, sent }));
  vm.runInContext("mgRunNow('bt')", ctx); await wait(40);
  ok("…新那一輪按「先用目前數字跑」才送一次 manage_backtest,轉圈旗標才收", sent.filter((c) => c === "manage_backtest").length === 1 && G.refreshing.bt === false, J(sent));
})();
// 對齊網頁:優化權重換成台指期不到一口 → 列上「0 口（不足一口）」、表底講少投多少;等待那一行加「優化：」「回測：」;剛選進還沒回報的不猜「合約」
ok("優化表:台指期取整成 0 口而有錢 → mg.lotsUnder、累計少投 → 表底 mg.lotsUnderFoot(換成投入資金幣別;換不了寫 TWD)",
  /else if \(r\.spec && nx === 0 && r\.moneyTwd > 0\) \{ cell\.textContent = t\("mg\.lotsUnder"\); underTwd \+= r\.moneyTwd; \}/.test(psrc) && /t\("mg\.lotsUnderFoot", \{ amt \}\)/.test(psrc)
  && fs.readFileSync(path.join(R, "strings.js"), "utf8").includes('"mg.lotsUnder": "0 口（不足一口）"'));
{ // 台指期進位超配(Wei 10-16):列舉。TMF 一口 = 20000 點 × 10 = 200,000 TWD;投入資金幣別 = TWD(toF 原值)
  const PL = 200000, rnd = T.out.trRoundLots, row = (name, twd) => ({ name, spec: { cv: 10 }, money: twd, moneyTwd: twd, perLot: PL, lots: rnd(twd / PL) });
  const crypto = { name: "btc", spec: null, money: 500000, moneyTwd: null, perLot: null, lots: null }, id = (v) => v, L = (rows, eff, toF) => J(F.mgLotsOver(rows, eff, toF || id));
  const cases = [
    ["剛好一口", [row("a", 200000)], 1e6, "[]"],
    ["捨去(1.3 → 1 口,少投)", [row("a", 260000)], 1e6, "[]"],
    ["進位但整份只多 2%(0.9 → 1 口)", [row("a", 180000), crypto], 1e6, "[]"],
    ["進位、整份多 6%(0.7 → 1 口)→ 比配置多 43%", [row("a", 140000), crypto], 1e6, J([{ name: "a", lots: 1, pct: 43 }])],
    ["整份剛好多 5% 不講(門檻是超過)", [row("a", 150000)], 1e6, "[]"],
    ["0.5 口照 half-up 進位成 1 口 → 多 100%", [row("a", 100000)], 1e6, J([{ name: "a", lots: 1, pct: 100 }])],
    ["兩支都進位 → 兩支都列", [row("a", 140000), row("b", 140000)], 1e6, J([{ name: "a", lots: 1, pct: 43 }, { name: "b", lots: 1, pct: 43 }])],
    ["一支進位一支捨去互相抵掉 → 不講", [row("a", 140000), row("b", 260000)], 1e6, "[]"],
    ["不足一口(0 口)的少投也扣:+60k −80k → 不講", [row("a", 140000), row("b", 80000)], 1e6, "[]"],
    ["多口數:2.6 → 3 口,整份多 8% → 多 15%", [row("a", 520000)], 1e6, J([{ name: "a", lots: 3, pct: 15 }])],
    ["沒有計畫總部位(eff null／0)", [row("a", 140000)], null, "[]"],
    ["eff 0", [row("a", 140000)], 0, "[]"],
    ["缺台指期報價(lots null)→ 不判", [Object.assign(row("a", 140000), { lots: null, perLot: null })], 1e6, "[]"],
    ["權重 0 的台指期列不算", [Object.assign(row("a", 0), { money: 0, moneyTwd: 0 }), crypto], 1e6, "[]"],
    ["只有加密列", [crypto], 1e6, "[]"],
  ];
  const bad = cases.filter(([, rows, eff, want]) => L(rows, eff) !== want).map(([n, rows, eff, want]) => n + " 要 " + want + " 得 " + L(rows, eff));
  ok("優化表進位超配 mgLotsOver:" + cases.length + " 種情境(剛好、捨去、小進位、超過 5%、等於 5%、0.5 進位、兩支、互抵、不足一口、多口、缺計畫、缺報價、權重 0、只有加密)", !bad.length, bad.join(";"));
  ok("mgLotsOver:缺匯率(toF 回 null)不判;投入資金是 USD 時折算後再比(6% 的台幣多投在 USD 計畫上一樣算)",
    L([row("a", 140000)], 1e6, () => null) === "[]" && L([row("a", 140000)], 1e6 / 32, (v) => v / 32) === J([{ name: "a", lots: 1, pct: 43 }]));
  ok("門檻常數 = 5%,少投／多投兩句都畫在優化表下方(表之後)、同一個 pf-note 段落;一支用 mg.lotsOverFoot、兩支以上一支一行用 mg.lotsOverFootN(帶策略名)",
    /const MG_LOTS_OVER_WARN = 0\.05;/.test(psrc) && /const over = mgLotsOver\(d\.rows, d\.eff, \(v\) => mpsConv\(v, TR_TXF_CCY, mpsCcy\(\)\)\);/.test(psrc)
    && /over\.forEach\(\(o\) => wrap\.appendChild\(trEl\("p", "pf-note", over\.length === 1 \? t\("mg\.lotsOverFoot", \{ lots: o\.lots, pct: o\.pct \}\) : t\("mg\.lotsOverFootN", \{ name: trDisplay\(o\.name\), lots: o\.lots, pct: o\.pct \}\)\)\)\);/.test(psrc)
    && psrc.indexOf('t("mg.lotsUnderFoot"') < psrc.indexOf("const over = mgLotsOver(") && cutF(psrc, "mgSuggestTable").indexOf("wrap.appendChild(tbl);") < cutF(psrc, "mgSuggestTable").indexOf('t("mg.lotsUnderFoot"')
    && fs.readFileSync(path.join(R, "strings.js"), "utf8").includes('"mg.lotsOverFoot": "台指期進位成 {lots} 口，比配置多 {pct}%"')); }
ok("等待那一行前面寫「優化：」或「回測：」", /t\(w === "opt" \? "mg\.waitPrefixOpt" : "mg\.waitPrefixBt"\) \+ \(n === 1/.test(psrc) && fs.readFileSync(path.join(R, "strings.js"), "utf8").includes('"mg.waitPrefixOpt": "優化："'));
ok("投資組合還沒算出成分(沒有權重):金額表訊號寫「—」(tooltip tr.sigNotYet),不是 ×0", /const cNotYet = isC && !tc && !noSig;/.test(src) && /noSig \|\| notYet \|\| cNotYet \? "—" : trSignalText\(st\.position, tc\)/.test(src));
ok("剛選進、還沒回報、清單沒寫市場:金額表與部位表都不先標「合約」", /if \(isC \|\| market\) first\.appendChild\(trEl\("span", "mkt-tag"/.test(src) && /if \(!guess\) c\.appendChild\(trEl\("span", "mkt-tag"/.test(src));
// runtime NEEDS_ROUTING 閘門改成任何沒路由的成員都擋(金額 0 也算):只有金額 0 的成員沒路由也落 Z
{ const ctx = vm.createContext({ TR: { list: [] } }); const pure = src.slice(src.indexOf("/* ── 純邏輯("), src.indexOf("/* ── 純邏輯到此"));
  vm.runInContext(pure.replace(/^const /gm, "var "), ctx);
  const V2 = { paper: { credentials: true, pair: true, order: true, account: true } };
  const z = (amounts, ex) => vm.runInContext("trNoAmounts(" + J({ venues: V2, config: { amounts, exchanges: ex }, states: {} }) + ")", ctx);
  ok("有交易所綁著、任何成員沒路由(金額 0 也算)→ 落 Z;都路由好了 → 照金額判", z({ a: 100, b: 0 }, { a: "paper", b: "" }) === true && z({ a: 100, b: 0 }, { a: "paper", b: "paper" }) === false); }
// 網頁 8fb666c2:回測等更新績效、還沒送出時卡片寫「等更新績效…」,不畫進度條;最大回撤不支援時方法鈕真的停用、原因常駐
ok("回測卡:btWaiting 時只寫 mg.btWaitPerf + 取消(不畫進度條、不寫回測進行中);最大回撤不能選時 disabled、原因常駐",
  /if \(G\.btWaiting\) \{[\s\S]{0,400}t\("mg\.btWaitPerf"\)[\s\S]{0,400}return frag;\n    \}/.test(psrc) && /if \(!ok\) b\.disabled = true;/.test(psrc) && /if \(!series\) old\.hidden = false;/.test(psrc));
// 設計最終稽核三條小建議:登入失效卡不重講三次;最大回撤停用的原因點名最大回撤;投入資金空著時表上方先講要去哪裡填
{ const app = fs.readFileSync(path.join(R, "app.js"), "utf8"), S = fs.readFileSync(path.join(R, "strings.js"), "utf8");
  ok("登入失效那張卡:帳號列寫「登入已失效」一次;卡片標題「請重新登入」、不再加說明句", /revoked:  \{ h: "pv\.h\.revoked", lead: "", acts:/.test(app) && S.includes('"pv.h.revoked": "請重新登入"') && S.includes('"acct.revoked": "登入已失效"'));
  ok("最大回撤不能選:原因點名最大回撤(雲端主機版本較舊／更新前算的／共同資料不到 90 天)", /t\("sz\.shortMdd"\) : t\(mpsNoReturnsKey\(\)\)/.test(psrc) && S.includes('"sz.oldMdd": "雲端主機版本較舊，不能用最大回撤；到設定 › 一般〔更新雲端主機〕後重跑一次優化"') && S.includes('"sz.staleMdd": "這份結果是更新前算的，重跑一次優化就能用最大回撤"') && S.includes('"sz.staleMdd": "This result was computed before the update. Rerun the optimization to use max drawdown"') && S.includes('"sz.shortMdd": "共同資料不到 90 天，不能用最大回撤"'));
{ const ctx = vm.createContext({}); vm.runInContext(["mpsCvKey", "mpsCvBefore", "mpsNoReturnsKey"].map((n) => cutF(psrc, n)).join("\n") + "\nvar MPS_RETURNS_CV = " + J(/const MPS_RETURNS_CV = "([^"]+)"/.exec(psrc)[1]) + "; var TR = null;", ctx);
  const K = (env, cv) => { ctx.TR = { env, st: { cloud: cv === undefined ? undefined : { config_version: cv } } }; return vm.runInContext("mpsNoReturnsKey()", ctx); };
  ok("提案沒 port_returns 的原因分兩句:雲端 workspace 早於 2026-10-13-l(或讀不到版號)= 主機舊要先更新;已夠新 = 更新前算的、重跑就好;本機一律後者",
    K("cloud", "2026-10-13-k") === "sz.oldMdd" && K("cloud", "2026-10-12-z") === "sz.oldMdd" && K("cloud", null) === "sz.oldMdd" && K("cloud", undefined) === "sz.oldMdd"
    && K("cloud", "2026-10-13-l") === "sz.staleMdd" && K("cloud", "2026-10-13-aa") === "sz.staleMdd" && K("cloud", "2026-10-15-d") === "sz.staleMdd"
    && K("local", "2026-10-01") === "sz.staleMdd" && K("local", undefined) === "sz.staleMdd"
    && /"sz\.staleMdd": "這份結果是更新前算的/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", "zh.po"), "utf8").replace(/msgid "sz\.staleMdd"\nmsgstr /, '"sz.staleMdd": ')), K("cloud", "2026-10-13-k")); }

  ok("投入資金空著:優化表上方先講「先按「{method}」填投入資金，建議金額才算得出來。」,{method} 帶工具列鈕現在的方法名;間距上 8、下 16",
    /wrap\.appendChild\(trEl\("p", "pf-note mg-need-fund", t\("mg\.needFund", \{ method: t\(\{ vol: "sz\.m\.vol", mdd: "sz\.m\.mdd", lev: "sz\.m\.lev" \}\[mk\]/.test(psrc)
    && S.includes('"mg.needFund": "先按「{method}」填投入資金，建議金額才算得出來。"') && /\.pf-note\.mg-need-fund \{ display: block; margin: var\(--space-8\) 0 var\(--space-16\); \}/.test(fs.readFileSync(path.join(R, "trade.css"), "utf8"))); }
// Wei 回報:沒有可選的策略時霧上的 CTA 是「Ask the agent」→ 兩種霧都是「選擇策略」、開同一個選擇框;框裡一支都沒有時出路寫在框內(tr.pick.empty,同網頁 pfPickEmpty)
{ const El = class { constructor(tag, cls, text) { this.tag = tag; this.className = cls || ""; this.textContent = text || ""; this.kids = []; this.dataset = {}; this.on = {}; }
    setAttribute() {} appendChild(c) { this.kids.push(c); return c; } append(...c) { this.kids.push(...c); } addEventListener(e, f) { this.on[e] = f; } };
  const fx = { opened: [], asked: [] }, fctx = vm.createContext({ TR: { env: "local" }, t: (k) => k, trEl: (tag, cls, text) => new El(tag, cls, text), trPickOff: () => false,
    psOpen: (b) => fx.opened.push(b), cxModalOpen: () => {}, poAskAgent: (x) => fx.asked.push(x), poFogCfg: () => new El("div"), poFogOver: () => new El("div") });
  vm.runInContext(cutF(psrc, "poFog"), fctx);
  const fog = vm.runInContext("poFog('pick')", fctx), card = fog.kids[1], btn = card.kids[1];
  btn.on.click();
  ok("霧:CTA 是「選擇策略」(tr.pick),按下開選擇框、不丟聊天框;卡片字 po.fogPick", btn.textContent === "tr.pick" && card.kids[0].textContent === "po.fogPick" && fx.opened.length === 1 && !fx.asked.length, J([btn.textContent, fx]));
  const call = src.match(/box\.appendChild\(poFog\(([^)]*)\)\);\n  \} else \{\n    box\.appendChild\(trAmountTable/);
  ok("沒選策略、沒有可選的策略:都上同一張「pick」霧(不再分 none、不叫 agent)", !!call && call[1] === '"pick"' && !/kind === "none"|fog-ask/.test(psrc), call && call[1]);
  const S = fs.readFileSync(path.join(R, "strings.js"), "utf8");
  ok("po.fogNone / po.fogNoneBtn / po.fogNoneAsk 兩語都刪了;框內空狀態字同網頁 pfPickEmpty",
    !/po\.fogNone/.test(S) && S.includes("還沒有回測完成的策略——先在聊天請代理建立並回測。") && S.includes("No backtested strategies yet — ask the agent in chat to build and backtest one.")
    && /if \(!rows\.length\) list\.appendChild\(trEl\("div", "pf-state", t\("tr\.pick\.empty"\)\)\);/.test(src));
}
// 網頁 01b51a54(設計師必改):細節行未實現取整到元、帶正負號;啟動框合計包成 .plan-tot(≈ 前面補間距)
{ const det = /seg\(t\("po\.dUpnl", \{ v: money\(trFmt\(Math\.round\(x\.unrealized_pnl\) \|\| 0, true\)\) \}\)\)/.test(src) && /t\("po\.dUpnl", \{ v: trFmt\(Math\.round\(su\) \|\| 0, true\) \}\)/.test(src);
  const css = fs.readFileSync(path.join(R, "trade.css"), "utf8"), app = fs.readFileSync(path.join(R, "app.js"), "utf8");
  ok("細節行與表底的未實現取整到元、帶正負號;啟動框合計是 .plan-tot、左邊補 --space-4,confirmBox 收得下節點",
    det && /trEl\("span", "plan-tot", p\.text/.test(src) && /\.del-body \.plan-tot \{ margin-left: var\(--space-4\); \}/.test(css) && /if \(typeof x === "string"\) p\.textContent = x; else p\.appendChild\(x\);/.test(app)); }
// A 案字串逐字同網頁 6ae71405(web messages.po;網頁的 {t}/{p}/{u}/{m} 在這裡是 {total}/{v})
{ const S = fs.readFileSync(path.join(R, "strings.js"), "utf8"), has = (v) => S.includes(JSON.stringify(v));
  const want = ["{venue} 帳戶裡策略開的部位", "What your strategies hold in your {venue} account", "策略外", "Off-strategy", "這個部位不是 Blave 下單建立的，對帳不會動它。", "均價 {v}", "Entry {v}", "未實現 {v}", "Unrealized {v}", "保證金 {v}", "Margin {v}", "（{x}×）", " ({x}×)",
    "這輪不下單：", "Skipped this round: ", "到策略組合修改", "Edit in Portfolio", "照策略組合 {n} 支策略，合計 {total} 下單。", "Orders follow {n} strategies in Portfolio, total {total}.", "Orders follow {n} strategy in Portfolio, total {total}.",
    "照策略組合 {n} 支策略下單。", "Orders follow {n} strategies in Portfolio.", "Orders follow {n} strategy in Portfolio.", "另有手動 {n}", "Plus manual {n}", "（含手動）", " (incl. manual)",
    "還沒有策略設定金額，先到策略組合設定。", "No strategy has an amount yet. Set one under Portfolio.", "帳上", "Held"];
  const miss = want.filter((v) => !has(v));
  ok("A 案字串兩語逐字同網頁(帳上、策略外、細節三段、門檻前導、到策略組合修改、啟動那句、原因行縮短版)", !miss.length, J(miss)); }
Promise.all([btCancelTest, freshTest, pollTest, refreshEdgeTest, cancelGenTest, runNowTest, refreshFlagTest, global.__sizingCloudTest]).then(() => { console.log(red ? `\n${red} 項沒過` : "\nALL PASS"); process.exit(red ? 1 : 0); });
