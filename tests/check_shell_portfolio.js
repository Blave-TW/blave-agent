// 策略組合頁(0.1.24;shell/renderer/portfolio.js + trade.js 的配置分頁、shell/daemon.js 的優化指令)。不起 Electron。
//   ① 優化與部位大小的純邏輯(選擇比對、資料不足、複利回撤、反推槓桿)
//   ② 台指期換合約:口數換算、兩步存檔、錯誤碼人話、總訊號部位的口數取整
//   ③ shell/daemon.js:manage_* 只在這台電腦開、形狀檢查、優化等 ack 的時間
//   ④ 設計 desktop-portfolio-spec §9.1 #15:沒連交易所存金額不開確認框;連 Binance 時台股列的實際是「—」;自動下單 › 部位沒有金額輸入框
//   ⑤ 部位大小(Wei 11-01):沒填不代填;填過就原樣,跑優化、換幣別、成員變動、沒序列都不變;重開(本機 localStorage、雲端 ui-prefs.json 綁 who)
// 跑法:node tests/check_shell_portfolio.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "trade.js"), "utf8"), psrc = fs.readFileSync(path.join(R, "portfolio.js"), "utf8"), html = fs.readFileSync(path.join(R, "index.html"), "utf8");
let red = 0; const ok = (name, c, info) => { console.log((c ? "PASS  " : "FAIL  ") + name + (c || !info ? "" : "\n      " + info)); if (!c) red++; };
const J = JSON.stringify;
// 等被測程式走到那一步,不賭幾毫秒:機器忙時固定等待會比被測程式先結束,那支就假紅。等不到才走到逾時,紅留給後面的斷言
const until = async (cond, ms = 10000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 2)); };
const waiting = (ctx, w) => () => !!(ctx.TR.mg && ctx.TR.mg.wait && ctx.TR.mg.wait[w]);
const block = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b); if (i < 0 || j < 0) throw new Error("找不到標記:" + a); return s.slice(i, j); };
const cutF = (s, n) => { const i = s.indexOf("function " + n + "("); if (i < 0) throw new Error("no " + n); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("no " + n); };

// ── ① 純邏輯 ──
const pp = block(psrc, "/* ── 純邏輯(", "/* ── 純邏輯到此");
ok("portfolio.js 的純邏輯區塊不碰 DOM", !/\bdocument\b|\$\(|window\./.test(pp.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
const P = {}; vm.runInNewContext(pp.replace(/^const /gm, "var ") + "\nthis.out = { mgSameSel, mgShortDaysOf, mgFitParams, mgWeightPct, mpsSizingClean, mpsSeriesOf, mpsMddAt, mpsSolveLev, mpsLevFor, mgErrLine, mpsChipParts, mgBeatsOf, mpsSizeGap, mpsHistVolOf, mgSharpeText, mgPctText };", P);
const F = P.out;
// 0.1.30 文案:優化頁不出英文參數名與「Max DD」;暫停框開頭句不再叫人去選「暫停並關閉部位」(設計稽核 S3)
{ const raw = fs.readFileSync(path.join(R, "strings.js"), "utf8"), S = (0, eval)("(" + raw.slice(raw.indexOf("{", raw.indexOf("const STRINGS")), raw.lastIndexOf("}") + 1) + ")");
  ok("優化頁:Sharpe／最大回撤用回測頁那組標籤(同網頁);方法框 lookback → 回看、錯誤句「回看天數」;資料不足句不出英文;自訂方法的參數名照舊 mono",
    S.zh["mg.paramLookback"] === "回看" && /^回看天數/.test(S.zh["mg.lookbackRange"]) && !("mg.maxDd" in S.zh)
    && ["mg.lookbackRange", "mg.short", "mg.shortTip"].every((k) => !/lookback/.test(S.zh[k]) && /回看/.test(S.zh[k]))
    && /k === "lookback" \? trEl\("label", "", t\("mg\.paramLookback"\)\) : trEl\("label", "mono", k\)/.test(cutF(psrc, "mgMethodFields")) && !/"Max DD"|stat\("Sharpe"/.test(psrc));
  ok("時光機原因句只留「轉出只做目前這一版。」(S2,同網頁):不重講橫幅已經寫的「正在看 vN」", S.zh["xp.why.tm"] === "轉出只做目前這一版。" && !/\{v\}/.test(S.en["xp.why.tm"]));
  ok("暫停框開頭句只講啟動可能已生效(S3):tr.stopAfterStartFlat 拿掉",
    !("tr.stopAfterStartFlat" in S.zh) && !("tr.stopAfterStartFlat" in S.en) && /function trStopAfterStartLead\(\) \{/.test(src) && !/stopAfterStartFlat/.test(src)); }
ok("移動窗格回測各指標的贏過:三個欄位各自取整;舊 workspace 只有 Sharpe 時另兩格不畫",
  J(F.mgBeatsOf({ managed_beats_pct_total_return: 61.4, managed_beats_pct_sharpe: 85.5, managed_beats_pct_max_drawdown: 12 })) === J({ ret: "61%", sharpe: "86%", mdd: "12%" })
  && J(F.mgBeatsOf({ managed_beats_pct_sharpe: 85 })) === J({ ret: null, sharpe: "85%", mdd: null }) && J(F.mgBeatsOf({})) === J({ ret: null, sharpe: null, mdd: null }));
ok("稽核 0127b1 P2-28／v027-integ2 P3-3:三格的 Sharpe 負值用 U+2212、先取整再判正負(-0.004 寫 0.00,不寫 −0.00);壞值 null",
  F.mgSharpeText(-0.5) === "\u22120.50" && F.mgSharpeText(-0.004) === "0.00" && F.mgSharpeText(-0.005) === "\u22120.01" && F.mgSharpeText(0) === "0.00" && F.mgSharpeText(1.234) === "1.23"
  && F.mgSharpeText(NaN) === null && F.mgSharpeText(null) === null && /stat\(t\("bt\.sharpe"\), mgSharpeText\(man\.sharpe\)/.test(psrc));
ok("報酬／Max DD 的百分比先取到兩位再判正負與上色:±0.004 寫 0.00%、v 0(不上色);壞值 null;三格都走 mgPctText",
  J([F.mgPctText(0.004), F.mgPctText(-0.004), F.mgPctText(-1.5), F.mgPctText(2), F.mgPctText(0.005)]) === J([{ s: "0.00%", v: 0 }, { s: "0.00%", v: 0 }, { s: "\u22121.50%", v: -1.5 }, { s: "+2.00%", v: 2 }, { s: "+0.01%", v: 0.01 }])
  && F.mgPctText(NaN) === null && F.mgPctText(undefined) === null
  && /stat\(t\("mg\.totalReturn"\), tr0 && tr0\.s, !tr0 \? "" : tr0\.v > 0 \? "buy" : tr0\.v < 0 \? "sell"/.test(psrc) && /stat\(t\("bt\.maxDrawdown"\), dd && dd\.s, dd && dd\.v < 0 \? "sell"/.test(psrc)
  && /mgPctText\(man\["total_return_%"\]\), dd = mgPctText\(man\["max_drawdown_%"\]\)/.test(psrc));
ok("內建方法「最佳化 Sharpe」有自己的介面字(不吃機器 display_name)", /name === MG_SHARPE\) return t\("mg\.sharpe"\)/.test(psrc) && /MG_SHARPE \? t\("mg\.sharpeDesc"\)/.test(psrc));
{ const prop = { members: ["b", "a"], allocator: null, params: { lookback: 180 } };
  ok("回看還沒填(null)時,同成員同方法的提案仍算這一組:權重是主機的現值,照畫;跑優化另外擋", F.mgSameSel({ members: ["a"], allocator: "slope", params: { lookback: 365 } }, ["a"], "slope", { lookback: null }));
  ok("選擇比對:成員順序不管、舊腳本的 allocator null = slope、走查窗雙方都釘住才比", F.mgSameSel(prop, ["a", "b"], "slope", { lookback: 180 }) && !F.mgSameSel(prop, ["a"], "slope", { lookback: 180 })
    && !F.mgSameSel(prop, ["a", "b"], "equal", {}) && !F.mgSameSel(prop, ["a", "b"], "slope", { lookback: 90 }) && F.mgSameSel({ members: ["a", "b"], allocator: "equal", lookback: 0 }, ["a", "b"], "equal", {})); }
ok("資料不足:從回測 log 尾抓歷史天數(不 anchor 行首);認不得 null", F.mgShortDaysOf("Traceback…\nValueError: insufficient history: 120 days <= lookback 365") === 120 && F.mgShortDaysOf("boom") === null);
ok("參數:只收方法宣告的 key、target_vol 永遠排除、現值在範圍內才沿用;沒值或不合法 = null,宣告值不當值代填", J(F.mgFitParams({ params: { lookback: 365, target_vol: 0.3, x: true } }, { lookback: 90, x: false, zz: 1 })) === J({ lookback: 90, x: false })
  && J(F.mgFitParams({ params: { lookback: 365 } }, { lookback: 5 })) === J({ lookback: null }) && J(F.mgFitParams({ params: { lookback: 365, s: "x" } }, null)) === J({ lookback: null, s: null }));
ok("權重 %:整數就整數、非整數留 1 位;壞值 null", F.mgWeightPct(0.25) === "25" && F.mgWeightPct(0.1234) === "12.3" && F.mgWeightPct(NaN) === null);
ok("部位大小設定清理:壞值回沒填(方法也是 null,不預選目標波動)", J(F.mpsSizingClean({ fund: -1, method: "x", target: { vol: 12, mdd: "a" } })) === J({ fund: null, fundCcy: null, method: null, target: { vol: 12, mdd: null, lev: null } })
  && F.mpsSizingClean({ fund: 5, fundCcy: "TWD" }).fundCcy === "TWD" && F.mpsSizingClean({ fund: 5, fundCcy: "twd" }).fundCcy === null && F.mpsSizingClean({ fundCcy: "TWD" }).fundCcy === null);
{ const r = [0.1, -0.2, 0.05, -0.1];
  ok("複利回撤:1× 序列 +10% −20% +5% −10% 的最深回撤 = 24.4%;淨值歸零以下 = 100", Math.abs(F.mpsMddAt(1, r) - 24.4) < 1e-9 && F.mpsMddAt(10, r) === 100);
  const L = F.mpsSolveLev(15, r);
  ok("反推槓桿:目標回撤 15% → 回撤真的落在 15%;到上限都達不到(或沒有回撤)回 null", L > 0 && Math.abs(F.mpsMddAt(L, r) - 15) < 1e-6 && F.mpsSolveLev(150, r) === null && F.mpsSolveLev(10, [0.01, 0.01]) === null);
  const prop = { ann_vol_pct: 20, port_returns: { r } };
  ok("隱含槓桿:目標波動 30% / 歷史 20% = 1.5×;固定槓桿照填;沒填 = null,不當 1×", F.mpsLevFor({ method: "vol", target: { vol: 30, mdd: null, lev: null } }, prop) === 1.5
    && F.mpsLevFor({ method: "lev", target: { vol: null, mdd: null, lev: 2 } }, prop) === 2 && F.mpsLevFor({ method: "vol", target: { vol: null, mdd: null, lev: null } }, prop) === null && F.mpsLevFor({ method: null, target: { vol: 30, mdd: null, lev: 2 } }, prop) === null);
  ok("主機沒有 port_returns(舊版)或序列有洞:最大回撤算不出來就是 null,不偷換成目標波動", F.mpsLevFor({ method: "mdd", target: { vol: 40, mdd: 15, lev: null } }, { ann_vol_pct: 20 }) === null && F.mpsSeriesOf({ port_returns: { r: [0.1, NaN] } }) === null); }
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
ok("優化是 Deferred(腳本最長 120 秒才 ack):等 ack 給 150 秒,其餘照舊 20 秒", /const CMD_TIMEOUT_MS = \{ manage_optimize: 150000(?:, rename_strategy: 90000)? \};/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "daemon.js"), "utf8"))
  && /timeoutMs = CMD_TIMEOUT_MS\[cmd\] \|\| 20000/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "daemon.js"), "utf8")));
ok("雲端視角也送得出優化三個指令:沒有雲端停用鈕,ENV_CLOUD_CMDS 依序接上 manage_*", !/mgCloudOff|mg\.cloudOff/.test(psrc)
  && /ENV_CLOUD_CMDS = \[[^\]]*"stats_refresh", "manage_optimize", "manage_backtest", "manage_cancel"(?:, "rename_strategy")?\]/.test(src));
ok("雲端的優化 ack 窗同本機那份 150 秒(其餘照舊 20 秒)", /ackWindowMs: require\("\.\/daemon"\)\.CMD_TIMEOUT_MS\[cmd\]/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"))
  && /now\(\) \+ \(\(sendOpts && sendOpts\.ackWindowMs\) \|\| ACK_WINDOW_MS\)/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "cloudcmd.js"), "utf8")));

// ── 接線 ──
ok("側欄:策略組合(chart-pie)在自動下單(zap)上面", html.indexOf('id="po-nav"') > 0 && html.indexOf('id="po-nav"') < html.indexOf('id="tr-nav"') && /id="tr-nav"[^\n]*M4 14a1 1 0 0 1-\.78-1\.63/.test(html));
ok("自動下單落點一律總覽(trNeedsSetup 退場);原因行的連結開策略組合", !/trNeedsSetup/.test(src) && /trSetTab\("over"\); return; \}/.test(src) && /poOpen\("cfg", true\)/.test(cutF(src, "trPaintNoAmt")));
ok("選擇策略框的名字前同一顆呼吸點、同一個判定(envRunDot)", /r\.live = dotsUp && envRunDot\(r\.name, S\.st, now, S\.just\);/.test(src));
ok("優化／回測跑之前先更新超過 6 小時的成員績效(stats_refresh 分批 50)", /tradeSend\("stats_refresh", \{ names: names\.slice\(i, i \+ MG_REFRESH_BATCH\) \}\)/.test(psrc) && /mgRefreshThen\(S, \(\) => mgSendOptimize\(S\), null, "opt"\)/.test(psrc) && /mgRefreshThen\(S, \(\) => \{ if \(gone\(\)\) return; G\.btWaiting = false; mgSendBacktest\(S\); \}, gone, "bt"\);/.test(psrc) && /G\.refreshing\[w\] = true;/.test(psrc) && /refreshing: \{ opt: false, bt: false \}/.test(psrc));
// 0.1.27 Wei §7-3:套用金額跟配置的儲存同一個框、同一條規則(只列會變的;在跑時列要下的單),逐策略的套用表 poApplyTable 退場
ok("套用金額:策略集合跟配置不同就停用;走同一個存金額框(沒有另一張套用表、不分 fromOpt)", /!mgSameAsAmounts\(\)/.test(cutF(psrc, "mgApply")) && /if \(!anyChange && !blocked\) \{ box\.onOk\(\); return; \}/.test(src)
  && !/poApplyTable|fromOpt/.test(src + psrc));
// 設計稽核 review-desktop-portfolio 必改 3、6、8
ok("必改 3:存金額框的策略列用 trCloseTag / trCtCloseTag(「平倉」「{舊合約}平倉」);套用金額走同一個框,一起標", /const close = trCloseTag\(was, now, mayFire && !keepsPos\(n\), trStratHeld\(n\)\);/.test(src) && /const ctClose = trCtCloseTag\(n, sending, stored\);/.test(src)
  && !/const ctCloses = /.test(src));
{ const css = fs.readFileSync(path.join(R, "trade.css"), "utf8");
  const c700 = (css.match(/@container \(max-width: 700px\) \{([\s\S]*?)\n\}/) || [])[1] || "";
  { const fold = css.indexOf("@container (max-width: 400px) {\n  .mg-stats {"), body = fold < 0 ? "" : css.slice(fold, css.indexOf("\n}", fold));
    const bt = cutF(psrc, "mgBacktestSec");
    ok("移動窗格三格同一級字(18,沒有放大的主指標、沒有補高);中欄 ≤400 才折兩欄、排在 base 之後;雲端與本機同一支 render(不分模式)",
      /\.mg-stat \.sv \{[^}]*font: 600 18px\/1\.1 var\(--font-mono\)/.test(css) && !/\.mg-stat[^{]*:(first|nth|last)-child[^{]*\.sv|\.mg-stat[^{}]*\.sv \{[^}]*(font-size|min-height)/.test(css)
      && fold > css.indexOf(".mg-stat .sv {") && /\.mg-stats \{ grid-template-columns: repeat\(2, 1fr\); \}/.test(body) && !/span 2/.test(body)
      && !/ENV\.cur|TR_BAGS|\bRPC\b|\bRP\b|cloud/.test(bt)); }
  ok("移動窗格三格的漲跌色不被 .mg-stat .sv 的墨色蓋掉:.sv.buy／.sv.sell 用 greenText／redText,排在 base 之後",
    /\.mg-stat \.sv\.buy \{ color: var\(--color-greenText\); \}/.test(css) && /\.mg-stat \.sv\.sell \{ color: var\(--color-redText\); \}/.test(css)
    && css.indexOf(".mg-stat .sv.buy {") > css.indexOf(".mg-stat .sv {") && css.indexOf(".mg-stat .sv.sell {") > css.indexOf(".mg-stat .sv {"));
  { const f4 = css.indexOf("@container (max-width: 400px) {\n  .mg-stats {"), b4 = f4 < 0 ? "" : css.slice(f4, css.indexOf("\n}", f4));
    ok("中欄 ≤400 折成 2+1 後,Max DD(最後一格、落在左欄)的「贏過」氣泡改回 left 10／right auto,不往左溢出",
      /\.mg-stat:last-child \.tip \{ left: 10px; right: auto; \}/.test(b4) && f4 > css.indexOf(".mg-stat:last-child .tip { left: auto; right: 0; }")); }
  ok("0.1.26 複看 N1:中欄 ≤700 投資組合標的格可換行時用 text-wrap: pretty,不會只剩「檔」「more」一個字掉到第二行(1180–1300／聊天欄 452 實測)", /\.pf-tbl td\.c-sym \{ white-space: normal; \}\n\s*\.pf-tbl td\.c-sym \{ text-wrap: pretty; \}/.test(c700));
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
  const ctx = vm.createContext({ document: { createElement: node, createElementNS: (_ns, tag) => node(tag), createDocumentFragment: () => node("#frag") }, Date, Math, JSON, Array, Object, Number, String, Set, isFinite, console,
    $: () => null, t: (k, o) => k + (o ? " " + JSON.stringify(o) : ""), LANG: "zh", PAPER: "paper", BINANCE: "binance", CX_VENUES: { binance: { label: "Binance" } }, srSay() {}, trIsPaper: () => false, trCfPaperOnly: () => false,
    confirmBox(o) { ctx.BOX = o; }, trCloudBox: (o) => o, trWith: () => { ctx.DIRECT = (ctx.DIRECT || 0) + 1; return true; }, TR_STALE_MS: 600000, ENV_JUST_MS: 300000, trackFeature() {} });
  vm.runInContext("function trUnit() { return 'USDT'; } function trCcy() { return 'USDT'; } function trEquity() { return 10000; }", ctx);
  vm.runInContext("var delCtx = null;\n" + (src.match(/^const TR_CF = [^\n]*\n/m) || [""])[0].replace(/^const /, "var "), ctx);
  vm.runInContext(pure.replace(/^const /gm, "var ") + "\nvar trTipSeq = 0;\n" + ["trEl", "trSec", "trTipLabel", "poHelpGroup", "poCfgSec", "trHead", "trFmt", "trFmt2", "trFmtPrice", "trMoneyInto", "trReport", "trContracts", "trStored", "trBase", "trNamesOf", "trNames",
    "trListNames", "trDisplay", "trPickOff", "trPickBtn", "trVenueId", "trVenueLabel", "trVenueKind", "trTwBroker", "trStratName", "trTwNamesWant", "trTwName", "trTwNameEl", "trTwLotsText", "trTxfWant", "trRowTxf", "trRowTxfNew", "trCtPend", "trCtStored", "trCt", "trCtGate", "trCtDirty", "trCtRollTag",
    "trRowMoneyStored", "trCtPayload", "trRowIsLot", "trRowMoney", "trLotsFmt", "trLotsTgtFmt", "trLotsInto", "trQuoteMap", "trNoSignalYet", "trZoneOf", "trZoneLabel", "trZoneUnit", "trFxView", "trZoneSum", "trTotalText",
    "trPaintPosCell", "trAmountTable", "trNoVenueYet", "trGoStartKey", "trTradableFunded", "trUnrouted", "trRouteDirty", "trCloseTag", "trStratHeld", "trPaperTwOk", "trPaperTw", "trCtCloseTag", "trCfOpen", "trCfBookBad", "trCfStates", "trCfHolds", "trMarks", "trCfQty", "trCfRows", "trCfTick", "trPvRequest", "trLivePositions", "trBook", "trTwClosedKeys", "trGatedKeys", "trAwaitKeys", "poPartStates", "poSigTable", "trPosDetail", "trManualPart", "trPlanTotal", "trTxfPrice", "trNetRows", "trWithUnit", "trCatchWill", "trWaitStranded", "trGateSide", "trTradesSym", "trAppRestartQuiet"].map((n) => cutF(src, n)).join("\n"), ctx);
  const V = { credentials: true, pair: true, order: true, account: true };
  const bag = (venues, extra) => ({ env: "local", listLoaded: true, picked: null, sent: null, save: null, edits: { btc: 600 }, bad: {}, raw: {}, sig: {}, ct: { edits: {}, basis: {}, sent: null }, just: null,
    list: [{ name: "btc", displayName: "BTC", hasBacktest: true, symbol: "BTCUSDT" }, { name: "tw", displayName: "TW", hasBacktest: true, symbol: "2330" }],
    st: { alive: true, report: Object.assign({ venues, config: { amounts: { btc: 500, tw: 100000 } }, quote_ccy: { btc: "USDT", tw: "TWD" },
      states: { btc: { symbol: "BTCUSDT", position: 1 }, tw: { symbol: "2330", position: 1, market: "spot" } },
      account: { read_at: Math.floor(Date.now() / 1000), venues: Object.keys(venues).length ? { binance: { ok: true, equity: 10000, currency: "USDT", positions: { BTCUSDT: { side: "long", size: 400, entry_price: 60000, unrealized_pnl: 12.5, margin: 40 } } } } : {} } }, extra || {}) } });
  ctx.TR = bag({}); ctx.BOX = null; ctx.DIRECT = 0;
  const amt = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx));
  vm.runInContext("trCfOpen({ names: trNames(), stored: trBase(), opener: null })", ctx);
  // 0.1.27 Wei:存了有東西會變就一律出框(推翻 10-13「沒連交易所不跳框」);沒在下單 → 「儲存金額」
  ok("#15 沒連交易所:配置分頁畫金額表(有輸入框);按儲存開「儲存金額」框、沒有記號", amt.some((n) => /amt-in/.test(n.className)) && !!ctx.BOX && ctx.BOX.title === "tr.cf.title" && !ctx.BOX.mark && ctx.DIRECT === 0, J({ box: !!ctx.BOX, direct: ctx.DIRECT }));
  const sig0 = flat(vm.runInContext("poSigTable(TR.st.report, TR.st.report.config.amounts, TR.st.report.states, 'cfg')", ctx));
  ok("#15 沒連交易所:總訊號部位表只有「標的｜目標」兩欄、目標上色", J(sig0.filter((n) => n.tag === "th").map((n) => n.text)) === J(["tr.col.symbol", "tr.col.target"]) && sig0.some((n) => n.tag === "td" && /\bbuy\b/.test(n.className)));
  { // 0.1.27 台股張數(Wei 10-18 改:整股單＋零股單):主字「N 張 M 股」、小字原 TWD 目標;不足一張寫「M 股」、剛好整張「N 張」、不足一股才 0;整表只有台股時欄頭不掛（TWD）;沒有價格的列照舊寫 TWD
    const twRun = (amounts, st) => { vm.runInContext("TR.netOpen = TR.netOpen || new Set();", ctx); const f = flat(vm.runInContext(`poSigTable(TR.st.report, ${J(amounts)}, ${J(st)}, 'cfg')`, ctx));
      const tds = f.filter((n) => n.tag === "tr" && n.kids.length === 2 && n.kids[0].tag === "td").map((r) => r.kids[1]);
      return { th: f.filter((n) => n.tag === "th").map((n) => n.textContent), tw: tds.find((c) => /TWD|twLot/.test(c.textContent)), tds }; };
    const TWS = { symbol: "2330", position: 1, market: "spot", raw_closes: { 2330: 1000 }, raw_close_dates: { 2330: "2026-10-16" } };
    const two = twRun({ tw: 2105000 }, { tw: TWS }), zero = twRun({ tw: 999999 }, { tw: TWS }), sub1 = twRun({ tw: 500 }, { tw: TWS });
    const est = twRun({ tw: 2105000 }, { tw: Object.assign({}, TWS, { raw_closes_est: ["2330"] }) }), none = twRun({ tw: 2105000 }, { tw: { symbol: "2330", position: 1, market: "spot" } });
    const mix = twRun({ tw: 2105000, btc: 500 }, { tw: TWS, btc: { symbol: "BTCUSDT", position: 1 } });
    ok("台股列:2,105,000 TWD ÷ 1,000 = 2,105 股 → 主字「2 張 105 股」(整股單＋零股單)、小字 2,105,000 TWD、上色 buy;tooltip 寫 MM/DD 收盤價與整股／零股",
      two.tw && two.tw.text === 'po.twLots {"n":"2"} po.twShares {"n":"105"}' && two.tw.kids.some((k) => k.className === "sub" && k.text === "2,105,000 TWD") && /\bbuy\b/.test(two.tw.className)
      && two.tw.title === 'po.twLotsTip {"d":"10/16","px":"1,000","l":"2","s":"105"}', J(two.tw && [two.tw.textContent, two.tw.className, two.tw.title]));
    ok("不足一張(999,999 TWD ÷ 1,000 = 999 股):寫「999 股」、上色 buy,不出現 0 張、不掛原因小字", zero.tw && zero.tw.text === 'po.twShares {"n":"999"}' && /\bbuy\b/.test(zero.tw.className)
      && !zero.tw.kids.some((k) => k && /twSharesZero|twLotsZero/.test(k.text || "")), J(zero.tw && [zero.tw.textContent, zero.tw.className]));
    ok("舊 state 補的價格:tooltip 改寫估算那句", est.tw && /^po\.twLotsTipEst /.test(est.tw.title));
    ok("整表只有台股:欄頭「目標」不掛（TWD）;沒有價格的列照舊寫金額、單位寫進格子", J(two.th) === J(["tr.col.symbol", "tr.col.target"]) && none.tw && none.tw.text === "+2,105,000 TWD", J([two.th, none.tw && none.tw.textContent]));
    const one = twRun({ tw: 1000000 }, { tw: TWS });
    const half = twRun({ tw: 2105000, tw2: 1000000 }, { tw: TWS, tw2: { symbol: "2330", position: 1, market: "spot" } });
    const shortC = twRun({ tw: 1600000, pc: 2000000 }, { tw: Object.assign({}, TWS, { raw_closes: { 2330: 800 } }), pc: { market: "spot", weights: { 2330: -0.5 }, raw_closes: { 2330: 1000 }, raw_close_dates: { 2330: "2026-10-16" } } });
    ok("en 單數:剛好 1 張用 po.twLot", one.tw && one.tw.text === 'po.twLot {"n":"1"}', J(one.tw && one.tw.textContent));
    ok("兩支策略一支沒價格:整列照舊寫 TWD,不拿有價格的那支算張數", half.tw && half.tw.text === "+3,105,000 TWD", J(half.tds.map((c) => c.textContent)));
    ok("現貨 Type C 負權重當 0:只算做多那支(1,600,000 ÷ 800 = 2 張)", shortC.tw && shortC.tw.text === 'po.twLots {"n":"2"}' && shortC.tw.kids.some((k) => k.text === "1,600,000 TWD"), J(shortC.tds.map((c) => c.textContent)));
    ok("混加密:台股列照寫張數,加密列不動(+500)", mix.tw && mix.tw.text === 'po.twLots {"n":"2"} po.twShares {"n":"105"}' && mix.tds.some((c) => c.textContent === "+500"), J(mix.tds.map((c) => c.textContent)));
    const subs = (c) => (c ? c.kids.filter((k) => k && k.className === "sub").map((k) => k.text) : []);
    // 0.1.29 Mac 實測:組合權重乘出來的台幣目標帶小數(33,241.20 TWD);台幣金額跟其他地方一樣寫整數
    const frac = twRun({ tc: 100000 }, { tc: { market: "spot", weights: { 2330: 0.332412 }, raw_closes: { 2330: 1000 }, raw_close_dates: { 2330: "2026-10-16" } } });
    const fracNo = twRun({ tc: 100000 }, { tc: { market: "spot", weights: { 2330: 0.332412 } } });
    ok("台股目標金額取整:小字 33,241 TWD、沒價格的列 +33,241 TWD(不寫 .20)", subs(frac.tw)[0] === "33,241 TWD" && fracNo.tw && fracNo.tw.text === "+33,241 TWD", J([frac.tw && frac.tw.textContent, fracNo.tw && fracNo.tw.textContent]));
    ok("沒連交易所、不足一股(500 TWD ÷ 1,000):寫 0 股、灰字,原因寫在格子裡(小字 po.twSharesZero),不只 title", sub1.tw && sub1.tw.text === 'po.twShares {"n":"0"}' && /\bna\b/.test(sub1.tw.className)
      && subs(sub1.tw).some((x) => /^po\.twSharesZero /.test(x)), J(sub1.tw && [sub1.tw.textContent, subs(sub1.tw)]));
    ok("剛好整張不帶零股:1,000 股 → 只寫「1 張」;trTwLots 的 odd = 零股(同 runtime odd_shares)", one.tw && one.tw.text === 'po.twLot {"n":"1"}'
      && vm.runInContext("[trTwLotsText(2, 340), trTwLotsText(0, 340), trTwLotsText(2, 0), trTwLotsText(0, 0), trTwLotsText(0, 1), trTwLotsText(-1, -5)].join('|')", ctx)
        === ['po.twLots {"n":"2"} po.twShares {"n":"340"}', 'po.twShares {"n":"340"}', 'po.twLots {"n":"2"}', 'po.twShares {"n":"0"}', 'po.twShare {"n":"1"}', '-po.twLot {"n":"1"} po.twShares {"n":"5"}'].join("|"),
      J(one.tw && one.tw.textContent));
    // 0.1.27 稽核 P1-1／實跑 B1(Wei 10-18):連模擬交易時寫「N 股」(模擬盤整股成交,lib/order_paper);MARKET="swap" 的 Type A 也當現股併進 @spot、空頭壓 0
    const keepTR = ctx.TR; ctx.TR = bag({ paper: V }, { can_paper_twstock: true });
    const SW = { symbol: "2330", position: 1, market: "swap", raw_closes: { 2330: 1085 }, raw_close_dates: { 2330: "2026-10-16" } };
    const pap = twRun({ tw: 500000 }, { tw: SW }), pz = twRun({ tw: 1000 }, { tw: SW });
    const pmix = twRun({ tw: 2100000, tc: 1000000 }, { tw: Object.assign({}, SW, { raw_closes: { 2330: 2420 } }), tc: { market: "spot", weights: { 2330: 0.4 }, raw_closes: { 2330: 2420 }, raw_close_dates: { 2330: "2026-10-16" } } });
    const pneg = twRun({ tw: 3000000, tc: 1000000 }, { tw: Object.assign({}, SW, { position: -1, raw_closes: { 2330: 2420 } }), tc: { market: "spot", weights: { 2330: 0.4 }, raw_closes: { 2330: 2420 }, raw_close_dates: { 2330: "2026-10-16" } } });
    ok("模擬交易:500,000 TWD ÷ 1,085 = 460 股(整股捨去)、小字 TWD、上色 buy、tooltip 講整股", pap.tw && pap.tw.text === 'po.twShares {"n":"460"}' && subs(pap.tw)[0] === "500,000 TWD" && /\bbuy\b/.test(pap.tw.className) && /^po\.twSharesTip /.test(pap.tw.title), J(pap.tw && [pap.tw.textContent, pap.tw.className, pap.tw.title]));
    ok("模擬交易買不起一股:0 股＋小字講原因", pz.tw && pz.tw.text === 'po.twShares {"n":"0"}' && subs(pz.tw).some((x) => /^po\.twSharesZero /.test(x)), J(pz.tw && [pz.tw.textContent, subs(pz.tw)]));
    ok("模擬交易 swap 的 Type A 併進同一列:2,500,000 ÷ 2,420 = 1,033 股,只有一列", pmix.tds.length === 1 && pmix.tw && pmix.tw.text === 'po.twShares {"n":"1,033"}', J(pmix.tds.map((c) => c.textContent)));
    ok("模擬交易 swap 的 Type A 空頭壓 0,不抵掉別支的多單(400,000 ÷ 2,420 = 165 股)", pneg.tds.length === 1 && pneg.tw && pneg.tw.text === 'po.twShares {"n":"165"}', J(pneg.tds.map((c) => c.textContent)));
    // P1-2:還沒算出訊號的台股列(沒有 state)key 是 2330@spot,要對得上 notYet,寫「—」不寫 0
    const py = twRun({ tw: 500000 }, {}), pyc = py.tds.find((c) => c.textContent === "—");
    ok("模擬交易:還沒有 state 的台股列寫「—」(tr.sigNotYet),不是 0", py.tds.length === 1 && !!pyc && pyc.title === "tr.sigNotYet", J(py.tds.map((c) => c.textContent)));
    ctx.TR = keepTR;
  }
  ctx.TR = bag({ binance: V }); ctx.BOX = null; ctx.DIRECT = 0;
  vm.runInContext("TR = this.TR; trCfOpen({ names: trNames(), stored: trBase(), opener: null })", ctx);
  ok("#15 連上交易所、下單程式沒在跑:按下去不會送單 → 「儲存金額」", !!ctx.BOX && ctx.BOX.title === "tr.cf.title" && ctx.DIRECT === 0, J(ctx.BOX && ctx.BOX.title));
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
    /* 帳戶比帳本少(差額跟帳本反號、沒超過帳本;designer rebind-autohalt-ux 3.3):不是用戶加開,是帳本多記——改寫「帳戶實際 N」(帳戶市值)、
       tooltip 換 tr.acctActualTip、不註「含手動」,照舊不進合計。帳戶翻到另一邊(超過帳本)照舊算手動 */
    const fewer = run({ size: 5150, mark_price: 103000 }, { size: 10000, qty: 0.1 });
    ok("帳本 0.1、帳戶 0.05:細節行「帳戶實際 +5,150」(帳戶市值)、tooltip tr.acctActualTip、不加「含手動」、不進合計",
      !!fewer.man && /po\.acctActual \{"n":"\+5,150"\}/.test(fewer.man.textContent) && fewer.man.title === "tr.acctActualTip" && !/detInclManual/.test(fewer.det) && !fewer.foot, J(fewer.row) + fewer.det + (fewer.man && fewer.man.textContent));
    const flip = run({ side: "short", size: 5150, mark_price: 103000 }, { size: 10000, qty: 0.1 });
    ok("…帳戶翻成空 0.05(差額超過帳本):照舊「另有手動」+ tr.unmanagedTip", !!flip.man && /po\.manualPart/.test(flip.man.textContent) && flip.man.title === "tr.unmanagedTip", flip.man && flip.man.textContent);
    { const lot = (actual, mine) => { ctx.__a = [{ self_ledger: true }, { actual: { TMF: actual }, mine: { TMF: mine }, last: null }, {}];
        const d = vm.runInContext("trManualPart(__a[0], 'TMF', true, __a[1], __a[2])", ctx); return [d, ctx.__a[2].acct]; };
      ok("口數列:帳本 −1、帳戶 0 → 差 +1、帳戶實際 0;帳本 −2、帳戶 −1 → 帳戶實際 −1;帳本 −1、帳戶 +1(翻邊)與帳本 1、帳戶 3(加開)不標",
        J(lot(0, -1)) === J([1, 0]) && J(lot(-1, -2)) === J([1, -1]) && J(lot(1, -1)) === J([2, undefined]) && J(lot(3, 1)) === J([2, undefined])); }
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
    ok("口數列直接比口數(帳戶口數 − 帳本口數)", /if \(lot\) \{ const a = bk\.actual\[sym\] \|\| 0, m = bk\.mine\[sym\] \|\| 0; if \(out && shrink\(a - m, m\)\) out\.acct = a; return a - m; \}/.test(src)); }
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
  // 稽核 v027-integ2 P2-1:模擬交易的台股(can_paper_twstock、路由 paper)、MARKET="swap" 的 2330 Type A——照目標分列的四處都要用 2330@spot 去對帳本
  { const pt = (o) => { const now = Math.floor(Date.now() / 1000); ctx.TR = bag({ paper: V }, { can_paper_twstock: true }); ctx.TR.edits = {};
      const rp = ctx.TR.st.report; rp.config.amounts = { btc: 0, tw: o.amt != null ? o.amt : 100000 }; rp.config.exchanges = { btc: "paper", tw: "paper" };
      rp.states = o.noState ? {} : { tw: { symbol: "2330", position: o.pos != null ? o.pos : 1, market: "swap" } };
      rp.account = { read_at: now, venues: { paper: { ok: true, equity: 10000, currency: "USDT", positions: {} } } };
      rp.last_reconcile = { ts: now, actual: o.held ? { "2330@spot": { side: "long", size: o.held } } : {}, gates: o.gates || {} };
      vm.runInContext("TR = this.TR;", ctx); return rp; };
    pt({ noState: true, held: 100000 });
    const cw = vm.runInContext("trCatchWill(TR.st.report)", ctx);
    ok("P2-1 (a) 還沒算出訊號的 swap 台股 Type A(沒有 state):補齊說明不講 2330(contribs 的 key 是 2330@spot,notYet 對得上)", !/2330/.test(cw || ""), J(cw));
    pt({ pos: 1, held: 100000 });
    const sh = vm.runInContext("trStratHeld('tw')", ctx);
    ctx.TR.edits = { tw: 0 }; ctx.BOX = null; const keepEx = vm.runInContext("trExecState", ctx);
    // 台股開盤中(不照牆上時鐘):休市時那一列標「休市中，開盤後下單」,見 check_shell_a1_save F15
    ctx.__keepTw = vm.runInContext("trTwSessionOpen", ctx);
    try { vm.runInContext('trExecState = () => "running"; trTwSessionOpen = () => true; trCfOpen({ names: trNames(), stored: trBase(), opener: null })', ctx); } finally { ctx.__keep = keepEx; vm.runInContext("trExecState = __keep; trTwSessionOpen = __keepTw;", ctx); }
    // 0.1.27 存金額框改列下一輪要送的單(A1):帳本那 2330@spot 要對得上,列「賣出 2330」整筆,取代「平倉」標記
    const cfRows = ctx.BOX && ctx.BOX.extra ? flat(ctx.BOX.extra).filter((n) => /^cf-row( |$)/.test(n.className)).map((n) => n.textContent) : [];
    ok("P2-1 (b) 帳本有 2330@spot、金額改 0:trStratHeld 是 true,存金額框列賣出 2330 帳上那 100,000", sh === true && J(cfRows) === J(["tr.cf.sell2330100,000 TWD"]), J([sh, cfRows]));
    pt({ pos: 0, held: 100000 });
    const wsN = vm.runInContext("trWaitStranded(TR.st.report)", ctx);
    ok("P2-1 (c) 訊號 0、帳本 2330@spot 100,000:「等新訊號會一直開著」算 1 檔", wsN === 1, J(wsN));
    pt({ pos: 1, amt: 100, gates: { "2330@spot": { entry_usd: 5000 } } });
    const made = [], ce = ctx.document.createElement; ctx.document.createElement = (tag) => { const n = ce(tag); made.push(n); return n; };
    try { vm.runInContext("trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx); } finally { ctx.document.createElement = ce; }
    ok("P2-1 (d) 最小進場額讀 gates[\"2330@spot\"]:金額表有這一列的門檻提示", made.some((n) => /^tr\.gateHint /.test(n.text)), J(made.filter((n) => /gate/i.test(n.text)).map((n) => n.text)));
    // Type C 含台股、MARKET="swap":每個台股成分照現股(@spot、負權重壓 0),加密成分照舊
    const tc = (ex) => { pt({}); const rp = ctx.TR.st.report; rp.config.amounts = { pc: 1000000 }; rp.config.exchanges = ex;
      rp.states = { pc: { market: "swap", weights: { 2330: 0.5, 2603: -0.2, BTCUSDT: 0.3 } } }; vm.runInContext("TR = this.TR;", ctx);
      return { t: vm.runInContext("trClientTargets(TR.st.report.config.amounts, TR.st.report.states, null)", ctx), c: Object.keys(vm.runInContext("trContribs(TR.st.report.config.amounts, TR.st.report.states, null)", ctx)).sort() }; };
    const tcP = tc({ pc: "paper" });
    ok("P2-1 Type C swap 含台股(模擬交易):2330 → 2330@spot、2603 負權重壓 0 不出列、BTCUSDT 照舊;目標與拆解同一組 key",
      J(tcP.t) === J({ "2330@spot": 500000, BTCUSDT: 300000 }) && J(tcP.c) === J(["2330@spot", "BTCUSDT"]), J(tcP));
    // P3-1:逐支看 config.exchanges[名],不看整台第一家——路由到別家(binance)的那支照它自己的 MARKET
    const mx = () => { pt({}); const rp = ctx.TR.st.report; rp.venues = { binance: V, paper: V };
      rp.config.amounts = { a: 500000, b: 300000, pc: 1000000 }; rp.config.exchanges = { a: "paper", b: "binance", pc: "binance" };
      rp.states = { a: { symbol: "2330", position: 1, market: "swap", raw_closes: { 2330: 1000 } }, b: { symbol: "2330", position: -1, market: "swap", raw_closes: { 2330: 1000 } },
        pc: { market: "swap", weights: { 2603: -0.2 } } }; vm.runInContext("TR = this.TR;", ctx); return rp; };
    const rpM = mx(), tgM = vm.runInContext("trClientTargets(TR.st.report.config.amounts, TR.st.report.states, null)", ctx), A = rpM.config.amounts, S = rpM.states;
    ctx.__m = [A, S]; const lots = (k) => vm.runInContext(`trTwLots(${J(k)}, __m[0], __m[1])`, ctx);
    ok("P3-1 多家混綁(第一家 binance):路由 paper 的 swap Type A 併進 2330@spot;路由 binance 的空頭與 Type C 負權重照留在 2330／2603(同 lib aggregate_portfolio)",
      J(tgM) === J({ "2330@spot": 500000, 2330: -300000, 2603: -200000 }), J(tgM));
    const l1 = lots("2330@spot"), l2 = lots("2330");
    ok("P3-1 多家混綁:trTwLots 2330@spot 寫 500 股(全是 paper)、2330 寫張數(binance,-300 股 → 0 張)",
      !!l1 && l1.unit === "shares" && l1.shares === 500 && !!l2 && l2.unit === "lots" && l2.shares === -300 && l2.lots === 0, J([l1, l2]));
    rpM.config.exchanges = { a: "paper", b: "", pc: "binance" };
    const l3 = lots("2330");
    ok("P3-1 路由空字串的策略(解綁後還沒存)不算進 trTwLots(同 reporter tw_lots、lib 跳過)", l3 === null && lots("2330@spot").shares === 500, J([l3, lots("2330@spot")]));
    const tgU = vm.runInContext("trClientTargets(TR.st.report.config.amounts, TR.st.report.states, null)", ctx), cU = vm.runInContext("trContribs(TR.st.report.config.amounts, TR.st.report.states, null)", ctx);
    ok("路由空字串的策略(解綁後還沒存)在目標與拆解都貢獻 0、那一列照出(同 lib aggregate_portfolio 的 unrouted 列、網頁 pfTargetParts)",
      J(tgU) === J({ "2330@spot": 500000, 2330: 0, 2603: -200000 }) && cU["2330"].length === 1 && cU["2330"][0].v === 0 && cU["2330"][0].x === -1, J([tgU, cU["2330"]]));
    const tgt = () => Object.keys(vm.runInContext("trClientTargets(TR.st.report.config.amounts, TR.st.report.states, null)", ctx)).sort();
    rpM.config.exchanges = { b: "binance", pc: "binance" };
    ok("P3-1 a 還沒有路由紀錄、同時綁多家(binance＋paper):不當模擬交易", J(tgt()) === J(["2330", "2603"]));
    rpM.venues = { paper: V, president: V };
    ok("a 沒有路由紀錄、同時綁多家而且第一家就是 paper(paper＋president):仍不當模擬交易(同網頁 pfPaperOf、runtime 只繼承唯一綁著那家)", J(tgt()) === J(["2330", "2603"]), J(tgt()));
    rpM.venues = { paper: V };
    ok("沒有路由紀錄、只綁模擬交易一家:a 當模擬交易併進 2330@spot(runtime 存檔時會繼承它),路由 binance 的 b 照留 2330", J(tgt()) === J(["2330", "2330@spot", "2603"]), J(tgt())); }
  // 回歸(v027-integ2 實機):一家交易所都沒綁(venues {})時 runtime 沒有可繼承的,每支路由都是 ""——那是「只看訊號」,
  // 目標、拆解、張數照訊號算(trRouteBlank 只在有綁交易所時才算沒路由);不是模擬交易,台股寫整張,0 張帶原因小字
  { const nv = (amounts, states) => { ctx.TR = bag({}, { can_paper_twstock: true }); ctx.TR.edits = {}; const rp = ctx.TR.st.report;
      rp.config.amounts = amounts; rp.config.exchanges = {}; Object.keys(amounts).forEach((n) => { rp.config.exchanges[n] = ""; });
      rp.states = states; rp.quote_ccy = {}; Object.keys(amounts).forEach((n) => { rp.quote_ccy[n] = "TWD"; }); rp.last_reconcile = null;
      vm.runInContext("TR = this.TR;", ctx); ctx.__m = [amounts, states];
      return { t: vm.runInContext("trClientTargets(__m[0], __m[1], null)", ctx), c: vm.runInContext("trContribs(__m[0], __m[1], null)", ctx),
        lots: (k) => vm.runInContext(`trTwLots(${J(k)}, __m[0], __m[1])`, ctx), paper: (n) => vm.runInContext(`trPaperOf(${J(n)})`, ctx),
        cells: () => flat(vm.runInContext("poSigTable(TR.st.report, __m[0], __m[1], 'cfg')", ctx)) }; };
    const C = nv({ c: 1000000 }, { c: { market: "spot", weights: { 2330: 0.5, 2603: 0.3 }, raw_closes: { 2330: 2420, 2603: 200 }, raw_close_dates: { 2330: "2026-10-16", 2603: "2026-10-16" } } });
    const c1 = C.lots("2330@spot"), c2 = C.lots("2603@spot"), cc = C.cells().map((n) => n.textContent || n.text || "");
    ok("沒綁交易所、台股 Type C 路由 \"\":目標與拆解照訊號(不是 0)、不是模擬交易、張＋零股(2603 1,500 股 → 1 張 500 股;2330 206 股 → 0 張 206 股)",
      J(C.t) === J({ "2330@spot": 500000, "2603@spot": 300000 }) && C.c["2330@spot"][0].v === 500000 && C.paper("c") === false
      && !!c1 && c1.unit === "lots" && c1.lots === 0 && c1.odd === 206 && c1.shares === 206 && !!c2 && c2.unit === "lots" && c2.lots === 1 && c2.odd === 500, J([C.t, c1, c2]));
    ok("沒綁交易所、台股 Type C:總訊號部位表寫「1 張 500 股」「206 股」,不寫 0 張、不寫 0 TWD",
      cc.some((x) => x === 'po.twLot {"n":"1"} po.twShares {"n":"500"}300,000 TWD') && cc.some((x) => x === 'po.twShares {"n":"206"}500,000 TWD') && !cc.some((x) => /twLotsZero|po\.twLots \{"n":"0"\}/.test(x)), J(cc.filter((x) => /^po\.tw/.test(x))));
    const A = nv({ a: 5000000 }, { a: { symbol: "2330", position: 1, market: "swap", raw_closes: { 2330: 2420 }, raw_close_dates: { 2330: "2026-10-16" } } });
    const a1 = A.lots("2330"), ac = A.cells().map((n) => n.textContent || n.text || "");
    ok("沒綁交易所、台股 Type A 路由 \"\":目標 5,000,000、2330 寫 2 張(swap 照自己的 MARKET,不併 @spot)",
      J(A.t) === J({ 2330: 5000000 }) && !!a1 && a1.unit === "lots" && a1.lots === 2 && ac.some((x) => /^po\.twLots /.test(x) && x.includes('"n":"2"')), J([A.t, a1, ac.filter((x) => /^po\.tw/.test(x))])); }
  // 0.1.28 Wei Mac 實測:沒綁交易所時存的台股組合(路由 "")、之後綁模擬交易、還沒重存——配置頁是存檔前的編輯面,照存檔後(runtime 繼承唯一綁著那家)畫股數,
  // 不是 0 TWD;自動下單 › 部位與對帳那條照對帳器現況(沒路由 = 0)
  { ctx.TR = bag({ paper: V }, { can_paper_twstock: true }); ctx.TR.edits = {}; const rp = ctx.TR.st.report;
    const am = { c: 1000000 }, sts = { c: { market: "swap", weights: { 2330: 0.5 }, raw_closes: { 2330: 1000 }, raw_close_dates: { 2330: "2026-10-21" } } };
    rp.config.amounts = am; rp.config.exchanges = { c: "" }; rp.states = sts; rp.quote_ccy = { c: "TWD" }; rp.last_reconcile = null;
    vm.runInContext("TR = this.TR;", ctx); ctx.__m = [am, sts];
    const cells = flat(vm.runInContext("poSigTable(TR.st.report, __m[0], __m[1], 'cfg')", ctx)).map((n) => n.textContent || n.text || "");
    const live = vm.runInContext("trClientTargets(__m[0], __m[1], null)", ctx);
    ok("綁模擬交易後、路由還是 \"\"(存檔前):配置頁台股寫 500 股＋小字 500,000 TWD,不是 0 TWD;對帳現況(trClientTargets)照舊 0、離開配置頁後不殘留存檔後的路由",
      cells.some((x) => x === 'po.twShares {"n":"500"}500,000 TWD') && !cells.some((x) => /^0 TWD$/.test(x)) && J(live) === J({ 2330: 0 })
      && vm.runInContext("trPaperOf('c') === false && trRouteBlank('c') === true", ctx), J([cells.filter((x) => /TWD|tw/.test(x)), live]));
    // 金額表「部位」欄同一個口徑:台股投資組合做空 2330(權重 −0.5),存檔後路由模擬交易 = 現股、空頭壓 0(lib aggregate_portfolio)→ 空手;照現況(沒路由)會畫成空 500,000
    sts.c.weights = { 2330: -0.5 }; ctx.TR.sig = {};
    const pos = flat(vm.runInContext("trAmountTable(['c'], __m[0], __m[1])", ctx)).filter((n) => n.tag === "td" && /\bpos\b/.test(n.className)).map((n) => n.textContent);
    ok("綁模擬交易後、路由還是 \"\"(存檔前):配置頁金額表的部位欄照存檔後算(台股現股空頭壓 0 → 空手＋副行 tr.paperTwNoShort),不畫成空單", pos.length === 1 && pos[0] === "tr.flattr.paperTwNoShort", J(pos));
    const tip = flat(vm.runInContext("trAmountTable(['c'], __m[0], __m[1])", ctx)).filter((n) => n.tag === "td" && /c-sym/.test(n.className)).map((n) => n.title);
    ok("…代號格 tooltip 不再寫「（目前空手）」(原因在部位格,設計稽核 M1)", tip.length === 1 && !/typecMembersFlat/.test(tip[0]) && /tr\.typecMembers /.test(tip[0]), J(tip));
    // 單一標的同一條(稽核 B-2):台股做空、存檔後路由模擬交易 → 空手＋副行;加密現貨的空頭會抵別支的多單,不壓
    const one = (sym, market) => { const am1 = { s: 100000 }, st1 = { s: { symbol: sym, position: -1, market } };
      rp.config.amounts = am1; rp.config.exchanges = { s: "" }; rp.states = st1; rp.quote_ccy = { s: "TWD" }; ctx.__m = [am1, st1];
      ctx.TR.list = [{ name: "s", displayName: "S", hasBacktest: true, symbol: sym, market }];
      return flat(vm.runInContext("trAmountTable(['s'], __m[0], __m[1])", ctx)).filter((n) => n.tag === "td" && /\bpos\b/.test(n.className)).map((n) => n.textContent); };
    const twA = one("2330", "swap"), btcSpot = one("BTCUSDT", "spot");
    ok("單一標的台股做空、存檔後路由模擬交易:部位欄空手＋「模擬盤不放空台股」;加密現貨做空照舊寫空", J(twA) === J(["tr.flattr.paperTwNoShort"]) && /^tr\.rel\.short /.test(btcSpot[0] || ""), J([twA, btcSpot]));
    // 設計稽核 r2 S4:投資組合寫 MARKET = "spot" 被壓成空手 → 副行「現貨不放空」;同時是模擬台股也寫現貨那句
    const tcPos = (weights, market) => { const am1 = { s: 100000 }, st1 = { s: { market, weights } };
      rp.config.amounts = am1; rp.config.exchanges = { s: "" }; rp.states = st1; ctx.__m = [am1, st1];
      ctx.TR.list = [{ name: "s", displayName: "S", hasBacktest: true, symbol: null, portfolio: true, market, universe: Object.keys(weights) }];
      return flat(vm.runInContext("trAmountTable(['s'], __m[0], __m[1])", ctx)).filter((n) => n.tag === "td" && /\bpos\b/.test(n.className)).map((n) => n.textContent); };
    const spotC = tcPos({ BTCUSDT: -0.5 }, "spot"), spotTw = tcPos({ 2330: -0.5 }, "spot"), swapTw = tcPos({ 2330: -0.5 }, "swap");
    ok("投資組合空頭被壓成空手:現貨 → tr.spotNoShort(加密、台股同時是模擬也一樣);合約台股路由模擬 → tr.paperTwNoShort",
      J(spotC) === J(["tr.flattr.spotNoShort"]) && J(spotTw) === J(["tr.flattr.spotNoShort"]) && J(swapTw) === J(["tr.flattr.paperTwNoShort"]), J([spotC, spotTw, swapTw])); }
  // post-connect-flow 第 7 列:回報的 states 裡還沒有這支(還沒跑出第一次 live tick)→ 部位「—」+ tooltip;有這支、position 0 → 空手
  { ctx.TR = bag({}); ctx.TR.st.report.states = { tw: { symbol: "2330", position: 1, market: "spot" } }; ctx.TR.edits = {};
    const am = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx));
    const pc = am.filter((n) => n.tag === "td" && /\bpos\b/.test(n.className)), tip = am.filter((n) => n.title === "tr.sigNotYet");
    ok("金額表:states 缺 btc → 部位「—」,tooltip tr.sigNotYet;tw 照常 多＋副行訊號 ×1.00;沒有獨立的訊號欄", pc.some((n) => n.textContent === "—" && n.title === "tr.sigNotYet")
      && pc.some((n) => /^tr\.rel\.long /.test(n.textContent) && n.textContent.includes('tr.sigLine {"x":"×1.00"}')) && tip.length === 1 && !am.some((n) => /\bsig\b/.test(n.className)), J(pc.map((n) => n.textContent)));
    const cfg = flat(vm.runInContext("poSigTable(TR.st.report, TR.st.report.config.amounts, TR.st.report.states, 'cfg')", ctx));
    ok("總訊號部位表:states 缺 btc → BTCUSDT 目標「—」(tooltip tr.sigNotYet),不是 0", cfg.some((n) => n.tag === "td" && n.textContent === "—" && n.title === "tr.sigNotYet"));
    ctx.TR.st.report.states.btc = { symbol: "BTCUSDT", position: 0 };
    const am0 = flat(vm.runInContext("trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx));
    ok("狀態裡有 btc、position 0 → 部位寫空手,沒有 tr.sigNotYet", am0.some((n) => n.tag === "td" && /\bpos\b/.test(n.className) && n.textContent === "tr.flat") && !am0.some((n) => n.title === "tr.sigNotYet")); }
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
  // 策略組合儲存列:一家都沒連時講「還沒連接交易所」＋〔連接交易所〕(同網頁 46c27902a);綁定中、失敗、開通中、沒金額不出
  { const k = (mut) => { ctx.TR = bag({}); ctx.TR.edits = {}; ctx.TR.st.report.config.amounts = { btc: 500 }; if (mut) mut(ctx.TR, ctx.TR.st.report); vm.runInContext("TR = this.TR", ctx); return vm.runInContext("trGoStartKey('noaccount', TR.st.report)", ctx); };
    ok("noaccount:一家都沒連、有金額 → tr.noAccount", k() === "tr.noAccount", k());
    ok("noaccount:沒金額不出", k((S, r) => { r.config.amounts = { btc: 0 }; }) === null);
    ok("noaccount:綁定中／失敗(回報帶金鑰、還沒成對)不出", k((S, r) => { r.venues = { binance: { credentials: true, pair: false } }; }) === null);
    ok("noaccount:券商開通中不出", k((S, r) => { r.president_connect = { worker: { status: "running" } }; }) === null && k((S, r) => { r.capital_local_connect = { worker: { status: "running" } }; }) === null);
    ok("noaccount:雲端剛送出連接、等回報不出", k((S) => { S.cxSaved = { venue: "binance", at: Date.now() }; }) === null);
    ctx.TR = bag({}); ctx.TR.edits = {}; ctx.TR.st.report.config.amounts = { btc: 500 }; vm.runInContext('envHeadState = () => "noaccount";', ctx);
    let opened = 0; ctx.cxModalOpen = () => { opened++; }; vm.runInContext("cxModalOpen = this.cxModalOpen", ctx);
    const a = flat(vm.runInContext("TR = this.TR; trAmountTable(trNames(), trBase(), TR.st.report.states)", ctx)), go = a.find((n) => n.dataset && n.dataset.fk === "go-connect");
    vm.runInContext('envHeadState = () => "running";', ctx); if (go) go.on.click();
    ok("儲存列:「還沒連接下單帳戶」＋〔連接帳戶〕,按了開連接框", a.some((n) => n.text === "tr.noAccount") && !!go && go.text === "cx.connect" && opened === 1, J(a.map((n) => n.text).filter(Boolean)));
    const S0 = new Function(fs.readFileSync(path.join(R, "strings.js"), "utf8") + "\nreturn STRINGS;")();
    ok("字:zh「還沒連接下單帳戶」(模擬與期貨商也算,spec desktop-ui-fixes §5)「連接帳戶」", S0.zh["tr.noAccount"] === "還沒連接下單帳戶" && S0.zh["cx.connect"] === "連接帳戶"); }
  // 第 5′ 列:這家能下的金額——統一只算台指期、模擬交易不算台股(台指期算);標的不明不扣
  { const f = (vid, list, amounts, states) => { ctx.TR = { list, env: "local" }; return vm.runInContext("trTradableFunded(" + J({ venues: { [vid]: V }, config: { amounts }, states: states || {} }) + ")", ctx); };
    ok("trTradableFunded:統一 + 只有 BTC 有金額 → 0(Z,啟動下單停用);統一 + 台指期 → 1;模擬 + 台股 → 0、模擬 + 台指期 → 1;Binance 照算;標的不明 → 算",
      f("president", [{ name: "b", symbol: "BTCUSDT" }], { b: 5000 }) === 0 && f("president", [{ name: "x", symbol: "TXF" }, { name: "b", symbol: "BTCUSDT" }], { x: 1, b: 5000 }) === 1
      && f("paper", [{ name: "t", symbol: "2330", twd: true }], { t: 1000 }) === 0 && f("paper", [{ name: "x", symbol: "TXF", twd: true }], { x: 1 }) === 1
      && (ctx.TR = { list: [{ name: "t", symbol: "2330", twd: true }], env: "local" }, vm.runInContext("trTradableFunded(" + J({ venues: { paper: V }, config: { amounts: { t: 1000 } }, states: {}, can_paper_twstock: true }) + ")", ctx)) === 1
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
    ok("補齊說明:BTC 目標 500、帳上 400 → 「會買進 BTCUSDT 100 USDT」;台股(交易所不交易)不列", /tr\.opt\.catchWill \{"side":"tr\.opt\.buy","sym":" BTCUSDT","n":"100 USDT"\}/.test(w) && !/2330/.test(w), w);
    ctx.TR.st.report.config.amounts.btc = 400;   // 目標 = 帳上:差額 0 → 不講會送什麼單(沒有單)
    ok("補齊說明:差額為 0(目標 400、帳上 400)→ 不出「會買進…」;有差額時才出", vm.runInContext("trCatchWill(TR.st.report)", ctx) === null);
    // 0.1.27 模擬交易台股(can_paper_twstock):差額是台幣,照標的寫 TWD,BTC 那筆照舊帳戶幣
    { const PV = { paper: V }; ctx.TR = bag(PV, { can_paper_twstock: true });
      ctx.TR.st.report.account.venues = { paper: { ok: true, equity: 10000, currency: "USDT", positions: {} } };
      const pw = vm.runInContext("TR = this.TR; trCatchWill(TR.st.report)", ctx) || "";
      ok("補齊說明(模擬交易台股):2330 寫「100,000 TWD」、BTC 寫 USDT,不把台股標成 USDT",
        /"sym":" 2330","n":"100,000 TWD"/.test(pw) && /"sym":" BTCUSDT","n":"500 USDT"/.test(pw) && !/"sym":" 2330","n":"[^"]*USDT"/.test(pw), pw); }
    // 實機 integ2 10-18:台股寫「代號 名字」、模擬盤照股數(同策略組合表那一格);休市時補一句「開盤後第一輪才成交」,開盤中不補;crypto 那筆不受影響
    { const PV = { paper: V }; ctx.TR = bag(PV, { can_paper_twstock: true }); const rp = ctx.TR.st.report;
      rp.account.venues = { paper: { ok: true, equity: 10000, currency: "USDT", positions: {} } }; rp.config.exchanges = { btc: "paper", tw: "paper" };
      rp.states.tw.raw_closes = { 2330: 1030 }; rp.states.tw.raw_close_dates = { 2330: "2026-10-16" };
      vm.runInContext("TR_TWN.names = { 2330: '台積電' };", ctx);
      const at = (ms) => { const real = Date.now; Date.now = () => ms; try { return vm.runInContext("TR = this.TR; trCatchWill(TR.st.report)", ctx) || ""; } finally { Date.now = real; } };
      const sat = at(Date.UTC(2026, 9, 17, 3, 0)), mon = at(Date.UTC(2026, 9, 19, 2, 0)), monLate = at(Date.UTC(2026, 9, 19, 6, 0));
      vm.runInContext("TR_TWN.names = null;", ctx);
      ok("補齊說明(模擬交易台股):「買進 2330 台積電 97 股」(100,000 ÷ 1,030 捨去,同部位表);週六與 14:00 補休市句,週一 10:00 不補",
        sat.includes(J({ side: "tr.opt.buy", sym: " 2330 台積電", n: "po.twShares " + J({ n: "97" }) })) && /"sym":" BTCUSDT","n":"500 USDT"/.test(sat)
        && /tr\.opt\.catchTwClosed$/.test(sat) && /tr\.opt\.catchTwClosed$/.test(monLate) && !/catchTwClosed/.test(mon), J([sat, mon, monLate]));
      // F8:休市時前三筆先列現在就會成交的(BTCUSDT),等開盤的台股排最後;開盤中照代號排
      rp.states.tw = { type: "portfolio", market: "spot", weights: { 1101: 0.25, 2317: 0.25, 2330: 0.25, 2454: 0.25 },
        raw_closes: { 1101: 30, 2317: 200, 2330: 1030, 2454: 1200 }, raw_close_dates: { 1101: "2026-10-16", 2317: "2026-10-16", 2330: "2026-10-16", 2454: "2026-10-16" } };
      ctx.TR.list[1] = { name: "tw", displayName: "TW", hasBacktest: true, portfolio: true, universe: ["1101", "2317", "2330", "2454"] };
      const sat4 = at(Date.UTC(2026, 9, 17, 3, 0)), mon4 = at(Date.UTC(2026, 9, 19, 2, 0));
      const firstSym = (w) => (/"sym":"([^"]*)"/.exec(w) || [])[1];
      ok("F8 補齊說明:休市時 BTCUSDT(現在會成交)排第一、四檔台股在後(第四檔進「另外 N 檔」);開盤中照代號排,1101 第一",
        firstSym(sat4) === " BTCUSDT" && /tr\.opt\.catchMore \{"n":2\}/.test(sat4) && firstSym(mon4) === " 1101" && /BTCUSDT/.test(mon4) === false,
        J([sat4, mon4])); }
    ok("台股時段(台北):週一到週五 09:00–13:30;週末、08:59、13:30 都算休市", vm.runInContext("[trTwSessionOpen(Date.UTC(2026,9,19,1,0)), trTwSessionOpen(Date.UTC(2026,9,19,5,29)), trTwSessionOpen(Date.UTC(2026,9,19,5,30)), trTwSessionOpen(Date.UTC(2026,9,19,0,59)), trTwSessionOpen(Date.UTC(2026,9,17,2,0)), trTwSessionOpen(Date.UTC(2026,9,18,2,0))].join()", ctx) === "true,true,false,false,false,false");
    ok("台股時段:機器回報今天休市(tw_trading_day.trading false,國定假日)→ 休市;別天的、true、沒有這欄 → 照時鐘", vm.runInContext("[trTwSessionOpen(Date.UTC(2026,9,19,2,0), { date: '2026-10-19', trading: false }), trTwSessionOpen(Date.UTC(2026,9,19,2,0), { date: '2026-10-18', trading: false }), trTwSessionOpen(Date.UTC(2026,9,19,2,0), { date: '2026-10-19', trading: true }), trTwSessionOpen(Date.UTC(2026,9,19,2,0), null)].join()", ctx) === "false,true,true,true");
    ok("模擬盤台股股數:差額 ÷ 價格捨去到整股;不是整股成交(整張／舊 lib 沒價格)= null", vm.runInContext("[trCatchShares(100000, { unit: 'shares', price: 1030 }), trCatchShares(-500, { unit: 'shares', price: 1030 }), trCatchShares(100000, { unit: 'lots', price: 1030 }), trCatchShares(1, null)].join()", ctx) === "97,0,,");
    // 0.1.27 等新訊號的提醒(Wei 10-17):帳上有 Blave 的部位、目標比它小(平、減、翻)、差額過門檻,才算一筆
    const ws = (amt, pos, held, extra) => { ctx.TR = bag({ binance: V }); const r = ctx.TR.st.report; r.config.amounts.btc = amt; r.states.btc.position = pos;
      r.account.venues.binance.positions = held == null ? {} : { BTCUSDT: { side: held > 0 ? "long" : "short", size: Math.abs(held), entry_price: 60000 } }; Object.assign(r, extra || {});
      return vm.runInContext("TR = this.TR; trWaitStranded(TR.st.report)", ctx); };
    const wsC = { tw: 0 };
    ok("等新訊號提醒:訊號 0、帳上 400 → 1;目標 200、帳上 400(減碼)→ 1;翻空 → 1",
      ws(500, 0, 400) === 1 && ws(200, 1, 400) === 1 && ws(500, -1, 400) === 1, J([ws(500, 0, 400), ws(200, 1, 400), ws(500, -1, 400)]));
    ok("等新訊號提醒:要加碼(目標 500、帳上 400)、帳上沒部位、差額沒過門檻(目標 395)、策略沒金額 → 0",
      ws(500, 1, 400) === 0 && ws(500, 0, null) === 0 && ws(395, 1, 400) === 0 && ws(0, 0, 400) === 0, J([ws(500, 1, 400), ws(500, 0, null), ws(395, 1, 400), ws(0, 0, 400)]));
    // 0.1.28 美股純代號(trUsNoAuto,同網頁 pfWaitStranded／pfCatchWill):不會自動下單,不算會開著的部位、補齊說明不列
    { const us = (mk, fn, pos, held) => { ctx.TR = bag({ binance: V }); const r = ctx.TR.st.report; r.config.amounts.btc = 500; r.states.btc = { symbol: "AMZN", position: pos };
        r.strategy_kinds = { btc: { type: "A", market: mk } }; r.account.venues.binance.positions = { AMZN: { side: "long", size: held, entry_price: 200 } };
        return vm.runInContext("TR = this.TR; " + fn + "(TR.st.report)", ctx); };
      ok("美股:等新訊號提醒不算(us_stock 0、mixed 1);補齊說明不列(us_stock null、mixed 有)",
        us("us_stock", "trWaitStranded", 0, 400) === 0 && us("mixed", "trWaitStranded", 0, 400) === 1
        && us("us_stock", "trCatchWill", 1, 100) === null && /AMZN/.test(us("mixed", "trCatchWill", 1, 100) || ""),
        J([us("us_stock", "trWaitStranded", 0, 400), us("mixed", "trWaitStranded", 0, 400), us("us_stock", "trCatchWill", 1, 100), us("mixed", "trCatchWill", 1, 100)])); }
    ok("等新訊號提醒:還沒算出訊號(states 沒有這支)→ 不算", (() => { ctx.TR = bag({ binance: V }); const r = ctx.TR.st.report; delete r.states.btc; return vm.runInContext("TR = this.TR; trWaitStranded(TR.st.report)", ctx); })() === 0);
    ok("等新訊號提醒掛在 wait 選項的 warn,只在 > 0 時", /warn: stranded \? t\("tr\.opt\.waitStranded", \{ n: stranded \}\) : null/.test(src) && /const stranded = trWaitStranded\(r\);/.test(src));
    ok("補齊說明接在 catch 選項的 desc 後面;舊 lib 單一鈕那條接在 lines 最後", /desc: t\("tr\.opt\.catchDesc", \{ how: trCatchHow\(r\) \}\) \+ \(will \? " " \+ will : ""\)/.test(src) && /\.concat\(\[t\("tr\.startWarn1"\)\]\)\.concat\(will \? \[will\] : \[\]\)/.test(src)); }
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
    ok("舊 runtime(config 沒有 exchanges)不判;NEEDS_ROUTING 翻成句子;原因行的 Z 句在路由空的時候講「先到策略組合存一次下單設定，策略才會下到目前綁定的帳戶。」——第一次綁被拒時也會出,不寫「重新綁定」",
      run({ venues: P, config: { amounts: { btc: 500 } }, states: {} }).z === false && /if \(rc\.code === "NEEDS_ROUTING"\) return t\("tr\.needsRouting\.rejected", \{ name, more \}\);/.test(src)
      && fs.readFileSync(path.join(R, "strings.js"), "utf8").includes('"tr.startOffNoRoute": "先到策略組合存一次下單設定，策略才會下到目前綁定的帳戶。"')); }
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

// Wei 11-01:部位大小沒填不代填;填過就原樣,只有用戶手動改才變。這段跑真的 mpsRows／mgApply／mgSizeChip／mgSizeParse／mgBag,只 stub 周邊
{ let ccy = "USDT", prop = null, stored = { a: 280000, b: 120000 }; const fx = { USDT: 1, TWD: 32 }, store = {}, cfOpens = [], saves = [];
  const zone = { a: "USDT", b: "USDT", tw: "TWD" }; const G0 = () => vm.runInContext("mgBag()", ctx);
  const el = (tag, cls, txt) => { const e = { tag, cls, kids: [], dataset: {}, type: "", title: "", disabled: false, parentNode: null, get text() { return (txt == null ? "" : String(txt)) + this.kids.map((k) => k.text).join(" "); },
    appendChild(k) { this.kids.push(k); return k; }, append(...k) { k.forEach((x) => this.kids.push(x)); }, setAttribute() {}, addEventListener() {} }; return e; };
  const ctx = vm.createContext({ console, JSON, Promise, Math, Object, MG_SIZE_KEY: "ws_mg_sizing", MG_SEL_KEY: "ws_mg_members", MG_OPT_KEY: "ws_mg_opt", localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); saves.push(k); } },
    t: (k, o) => k + (o ? J(o) : ""), trEl: (c, n, x) => el(c, n, x), mpsProp: () => prop, mpsCcy: () => ccy, mpsNoSeriesKey: () => "sz.shortMdd", mpsConv: (v, a, b) => (a === b ? v : fx[a] && fx[b] ? (v / fx[a]) * fx[b] : null),
    trZoneOf: (n) => zone[n], TR_ZONE_UNKNOWN: "?", TR_TXF_CCY: "TWD", trCtStored: () => null, trStored: () => stored, trBase: () => stored, trNames: () => Object.keys(prop.weights), trTxfPrice: () => null, trRoundLots: (x) => Math.round(x),
    mgSpec: () => null, mgCt: () => null, mgProposal: () => prop, mgSameAsAmounts: () => true, trCfgUnread: () => false, trReport: () => ({}), trackFeature: () => {}, trCfOpen: (o) => cfOpens.push(o), mgMethod: () => null, mgSizeOpen: () => {}, poSetTab: () => {}, mgPaint: () => {} });
  vm.runInContext(pp.replace(/^const /gm, "var ") + "\n" + ["mgBag", "mgPrefsLoad", "mgSizingCloudLoad", "mgSave", "mpsMembers", "mpsWeight", "mpsFundOf", "mpsFundCcy", "mpsLev", "mpsRows", "mpsAmountsPayload", "mgSizeChip", "mgApply", "mgSizeNum", "mgSizeParse", "mgFundCcyFreeze"].map((n) => cutF(psrc, n)).join("\n"), ctx);
  ctx.TR = { env: "local", sig: {}, edits: {}, ct: { edits: {}, basis: {} } };
  const call = (s) => vm.runInContext(s, ctx), P1 = { members: ["a", "b"], weights: { a: 0.75, b: 0.25 }, ann_vol_pct: 20, port_returns: { r: [0.01, -0.02, 0.015, -0.01] } };
  const chip = () => call("mgSizeChip()").text.replace(/\s+/g, " ").trim(), apply = () => { const n = cfOpens.length; call("mgApply({})"); return cfOpens.length - n; };
  const draft = (s) => ({ G: G0(), ccyDirty: false, method: s.method, methodDirty: false, fund: s.fund === null ? "" : String(s.fund), fundCcy: call("mpsFundCcy")(s), fundDirty: false, t: { vol: "", mdd: "", lev: "" }, dirty: { vol: false, mdd: false, lev: false } });
  prop = P1;
  { const d = call("mpsRows()");
    ok("沒填過:鈕上不出任何數字、方法名也不出,表每列 null;已存 400,000、歷史波動 20% 都不會變成預設;〔套用〕不開確認框、沒有寫進主機的金額", /^sz\.title sz\.unset$/.test(chip()) && !/\d/.test(chip()) && d.amount === null && d.lev === null && d.eff === null && d.rows.every((r) => r.money === null && r.native === null) && apply() === 0 && d.gap === "mg.needSize", J([chip(), d]));
    ok("沒填過開框按確定(什麼都沒打):不釘任何值,存檔還是全空", J(call("mgSizeParse")(draft(G0().sizing)).sizing) === J(F.mpsSizingClean(null)) && !/mpsSizingPin|mgPinUsed/.test(psrc)); }
  { G0().sizing = F.mpsSizingClean({ fund: 11000, fundCcy: "USDT" }); const d = call("mpsRows()"), a = chip(), n = apply();
    G0().sizing = F.mpsSizingClean({ method: "vol", target: { vol: 26.4 } }); const e = call("mpsRows()"), b = chip(), n2 = apply();
    G0().sizing = F.mpsSizingClean({ fund: 11000, fundCcy: "USDT", method: "lev" }); const f = call("mpsRows()"), c = chip(), n3 = apply();
    ok("只填一半:只有投入資金／只有目標／選了方法沒填目標,都不出金額、不能套用,缺什麼講什麼", d.eff === null && e.eff === null && f.eff === null && n + n2 + n3 === 0 && [d.gap, e.gap, f.gap].join() === "mg.needMethod,mg.needFund,mg.needTarget" && a === "11,000 USDT · sz.unset" && b === "sz.m.vol 26.4%" && c === "11,000 USDT · sz.m.lev sz.unset", J([a, b, c, d.gap, e.gap, f.gap])); }
  // 填過:11,000 USDT、目標波動 26.4%、歷史波動 20% → 1.32×
  const filled = { fund: 11000, fundCcy: "USDT", method: "vol", target: { vol: 26.4, mdd: null, lev: null } }, fp = J(F.mpsSizingClean(filled));
  G0().sizing = F.mpsSizingClean(filled); call("mgSave(TR, MG_SIZE_KEY, mgBag().sizing)");
  const rnd = () => J(call("mpsRows()").rows.map((r) => Math.round(r.native))), base = rnd(), n0 = saves.length;
  ok("填過:金額 = 11,000 × 1.32 × 權重,鈕照填的寫", base === J([10890, 3630]) && chip() === "11,000 USDT · sz.m.vol 26.4%", base + chip());
  { ctx.B = { env: "local", sig: {} }; const G = call("mgBag(B)"); ok("重開:新的一袋原樣讀回", J(G.sizing) === fp, J(G.sizing)); }
  ccy = "TWD";
  ok("換顯示幣別／成員換區:鈕仍是 11,000 USDT,不換算;金額用的本金沒變;存檔沒動", chip() === "11,000 USDT · sz.m.vol 26.4%" && call("mpsRows()").amount === 11000 && call("mpsRows()").ccy === "USDT" && J(G0().sizing) === fp && saves.length === n0, chip());
  { prop = { members: ["tw", "b"], weights: { tw: 0.5, b: 0.5 }, ann_vol_pct: 20 }; const d = call("mpsRows()");
    ok("成員變動:新成員在台幣區,本金還是 11,000 USDT,只有那一列換匯(14,520 × 0.5 × 32);鈕不變", Math.round(d.rows.find((r) => r.name === "tw").native) === 232320 && Math.round(d.rows.find((r) => r.name === "b").native) === 7260 && chip() === "11,000 USDT · sz.m.vol 26.4%", J(d));
    delete fx.TWD; const e = call("mpsRows()"); fx.TWD = 32;
    ok("缺匯率:鈕與本金不變,那一列 null 標 fxMissing(套用講缺匯率,不是叫人重填)", chip() === "11,000 USDT · sz.m.vol 26.4%" && e.rows.find((r) => r.name === "tw").native === null && e.rows.find((r) => r.name === "tw").fxMissing === true && e.gap === null, J(e)); }
  ccy = "USDT"; prop = Object.assign({}, P1, { ann_vol_pct: 14, port_returns: { r: [0.02, -0.03, 0.01] } }); stored = { a: 1, b: 2 };
  { const n1 = rnd();
    ok("報告更新／重跑優化:目標與本金不跟著新結果,只有槓桿照新波動重算;已存金額變了也不影響", n1 === J([15557, 5186]) && J(G0().sizing) === fp, n1); }
  G0().sizing = F.mpsSizingClean({ fund: 11000, fundCcy: "USDT", method: "mdd", target: { vol: 26.4, mdd: 15 } }); prop = { members: ["a", "b"], weights: { a: 0.5, b: 0.5 }, ann_vol_pct: 20, port_returns: null };
  { const d = call("mpsRows()"), before = J(G0().sizing);
    ok("選最大回撤但這份沒序列:照實講算不出來,不退回目標波動(即使目標波動有填、歷史波動也有);方法與目標不動;不能套用", d.lev === null && d.eff === null && d.gap === "sz.shortMdd" && chip() === "11,000 USDT · sz.m.mdd 15%" && apply() === 0 && J(G0().sizing) === before, J(d));
    const r = call("mgSizeParse")(draft(G0().sizing)); ok("同情況開框沒動按確定:方法仍是最大回撤", r.sizing.method === "mdd" && r.sizing.target.mdd === 15, J(r)); }
  { prop = Object.assign({}, P1, { ann_vol_pct: null }); G0().sizing = F.mpsSizingClean(filled); const a = call("mpsRows()").gap;
    prop = P1; G0().sizing = F.mpsSizingClean({ fund: 1, fundCcy: "USDT", method: "mdd", target: { mdd: 9999 } }); const b = call("mpsRows()").gap;
    ok("目標波動缺歷史波動、回撤目標反推不出來:各講各的原因", a === "mg.sizeNoHist" && b === "mg.sizeNoSolve", J([a, b])); }
  // 真錢防線:匯率失效時非台指期列 native 是 null,鈕還開著就按下去,不能送成 0(同 web mgApplySuggest,不只靠按鈕 disabled)
  { prop = P1; ccy = "USDT"; G0().sizing = F.mpsSizingClean(filled);
    vm.runInContext("var __mr = mpsRows; mpsRows = function () { var d = __mr(); d.rows.forEach(function (r) { if (!r.spec) r.native = null; }); return d; };", ctx);
    const rows = call("mpsRows()").rows, n = apply();
    vm.runInContext("mpsRows = __mr;", ctx);
    ok("套用金額:非台指期列 native 是 null → 不開確認框、不寫金額(web 同一道防線)", rows.some((r) => !r.spec) && n === 0, { n, rows: rows.length }); }
  { prop = P1; ccy = "USDT"; G0().sizing = F.mpsSizingClean(filled); const n = saves.length, opened = apply(), o = cfOpens[cfOpens.length - 1]; o.onSaved({}, {});
    ok("套用成功:部位大小設定一個字都不動,也不多存", opened === 1 && J(G0().sizing) === fp && saves.length === n, J(G0().sizing)); }
  { ccy = "TWD"; const d = Object.assign(draft(G0().sizing), { fund: "12,000", fundDirty: true }), r = call("mgSizeParse")(d);
    const d2 = Object.assign(draft(G0().sizing), { fundCcy: "TWD", ccyDirty: true }), r2 = call("mgSizeParse")(d2), d3 = Object.assign(draft(G0().sizing), { fund: "", fundDirty: true }), r3 = call("mgSizeParse")(d3);
    const d6 = Object.assign(draft(G0().sizing), { fund: "90000", fundDirty: true, fundCcy: "TWD", ccyDirty: true }), r6 = call("mgSizeParse")(d6), d7 = Object.assign(draft(G0().sizing), { fund: "", fundDirty: true, fundCcy: "TWD", ccyDirty: true }), r7 = call("mgSizeParse")(d7);
    const d4 = Object.assign(draft(G0().sizing), { method: "lev", methodDirty: true }), r4 = call("mgSizeParse")(d4), d5 = draft(G0().sizing); d5.t.vol = ""; d5.dirty.vol = true; const r5 = call("mgSizeParse")(d5); ccy = "USDT";
    ok("手動改才變:打字蓋過去幣別照框裡的單位(USDT),不跟成員;單位下拉選了才換幣別,數字不換算;兩個一起改照選的;清空 = 回到沒填;換方法只換方法;清空目標 = null",
      r.sizing.fund === 12000 && r.sizing.fundCcy === "USDT" && r2.sizing.fund === 11000 && r2.sizing.fundCcy === "TWD" && r6.sizing.fund === 90000 && r6.sizing.fundCcy === "TWD" && r3.sizing.fund === null && r3.sizing.fundCcy === null && r7.sizing.fund === null && r7.sizing.fundCcy === null && r4.sizing.method === "lev" && r4.sizing.target.vol === 26.4 && r5.sizing.target.vol === null && r5.sizing.fund === 11000,
      J([r, r2, r3, r4, r5, r6, r7])); }
  { ok("單位:存的幣別跟成員不同才變小下拉(同 cf-in-ct 那組),同幣別純字;清空不再換幣別;只有兩個選項", /fundCcys: \[\.\.\.new Set\(\[mpsFundCcy\(s\), mpsCcy\(\)\]\)\]/.test(cutF(psrc, "mgSizeOpen")) && /if \(d\.fundCcys\.length > 1\)/.test(cutF(psrc, "mgSizeRender")) && /trEl\("span", "set-selw cf-in-ct"\)/.test(cutF(psrc, "mgSizeRender")) && !/d\.fundCcy = mpsCcy\(\)/.test(cutF(psrc, "mgSizeRender")) && /d\.ccyDirty = true/.test(cutF(psrc, "mgSizeRender"))); }
  { ccy = "TWD"; prop = P1; G0().sizing = F.mpsSizingClean({ fund: 5000, method: "vol", target: { vol: 20 } }); const n = saves.length; call("mgFundCcyFreeze(TR, mgBag())"); const a = G0().sizing.fundCcy; ccy = "USDT"; const s = call("mpsFundCcy")(G0().sizing);
    ok("舊存檔沒幣別:第一次畫出來定成當下幣別並存檔,之後成員換區不跟著換", a === "TWD" && s === "TWD" && saves.length === n + 1, J(G0().sizing)); }
  ok("預覽與框的單位都走本金自己的幣別;舊的預設本金、代填目標、退回方法全拿掉", /unit: mpsFundCcy\(s\)/.test(cutF(psrc, "mpsPreview")) && /fundCcy: mpsFundCcy\(s\)/.test(cutF(psrc, "mgSizeOpen")) && !/mpsMethodOf|mpsTargetOf|mpsFundDefault|mpsFundAs|mpsFundFxMissing/.test(psrc));
}
// 缺匯率走 mgFxWhy;沒填與算不出來各走自己的原因
{ let expired = false, cloud = { code: "OK" };
  const ctx = vm.createContext({ mgSameAsAmounts: () => true, trCfgUnread: () => false, trReport: () => ({}), trStored: () => ({}), trFxView: () => ({ expired }), TR_BAGS: { cloud: { st: { get cloud() { return cloud; } } } } });
  vm.runInContext(["mgFxWhy", "mgApplyWhy"].map((n) => cutF(psrc, n)).join("\n"), ctx);
  const why = vm.runInContext("mgApplyWhy", ctx), fxd = { eff: 1, rows: [{ fxMissing: true }], gap: null }, w = [why(fxd, true, true)]; cloud = null; w.push(why(fxd, true, true)); expired = true; w.push(why(fxd, true, true)); expired = false; cloud = { code: "OK" };
  w.push(why({ eff: null, rows: [], gap: "mg.needFund" }, false, true), why({ eff: null, rows: [], gap: "sz.shortMdd" }, false, true));
  ok("套用停用原因只講實際缺的那格:缺匯率三句(登入正常／沒登入／匯率過期);缺投入資金就講投入資金;最大回撤沒序列講原因", J(w) === J(["mg.applyWhyFx", "mg.applyWhyLogin", "mg.applyWhyFxOld", "mg.needFund", "sz.shortMdd"]), J(w)); }
// 雲端:部位大小寫進主行程(ui-prefs.json),重開後新的一袋非同步讀回;讀回前用戶已經設過就不蓋;換人(C.mg 清掉)回來的那份丟掉
{ const cloudSet = []; const r1 = { sizing: F.mpsSizingClean({ fund: 86372, fundCcy: "USDT", method: "vol", target: { vol: 10.6 } }) }, store = {};
  const ctx = vm.createContext({ console, JSON, Promise, MG_SIZE_KEY: "ws_mg_sizing", MG_SEL_KEY: "ws_mg_members", MG_OPT_KEY: "ws_mg_opt", localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    window: { blave: { mgSizingCloud: () => Promise.resolve({ ok: true, v: ctx.cloudFile, opt: null }), mgSizingCloudSet: (v) => { cloudSet.push(v); ctx.cloudFile = JSON.parse(JSON.stringify(v)); return Promise.resolve(true); } } }, mgPaint: () => { ctx.painted = (ctx.painted || 0) + 1; } });
  vm.runInContext(pp.replace(/^const /gm, "var ") + "\n" + ["mgBag", "mgPrefsLoad", "mgSizingCloudLoad", "mgSave"].map((n) => cutF(psrc, n)).join("\n"), ctx);
  const C = { env: "cloud", sig: {} }; ctx.C = C; ctx.TR = C; const Gc = vm.runInContext("mgBag(C)", ctx);
  const cloudTest = (async () => {
    await new Promise((r) => setTimeout(r, 5));
    Gc.sizing = r1.sizing; vm.runInContext("mgSave", ctx)(C, "ws_mg_sizing", Gc.sizing);
    const C2 = { env: "cloud", sig: {} }; ctx.C2 = C2; ctx.TR = C2; const before = J(vm.runInContext("mgBag(C2)", ctx).sizing);
    await new Promise((r) => setTimeout(r, 5));
    const after = C2.mg.sizing;
    const C3 = { env: "cloud", sig: {} }; ctx.C3 = C3; const G3 = vm.runInContext("mgBag(C3)", ctx); G3.sizingSet = true; G3.sizing = F.mpsSizingClean({ fund: 7 });
    const C4 = { env: "cloud", sig: {} }; ctx.C4 = C4; vm.runInContext("mgBag(C4)", ctx); C4.mg = null;
    await new Promise((r) => setTimeout(r, 5));
    ok("重開(雲端):部位大小寫進主行程;新的一袋讀回同一份並重畫;讀回前已設過的不蓋;換人後回來的丟掉",
      cloudSet.length === 1 && before === J(F.mpsSizingClean(null)) && J(after) === J(r1.sizing) && ctx.painted >= 1 && G3.sizing.fund === 7 && C4.mg === null && !("ws_mg_sizing" in store && JSON.parse(store.ws_mg_sizing).fund === 7), J([cloudSet.length, before, after, ctx.painted, G3.sizing, C4.mg])); })();
  global.__sizingCloudTest = cloudTest; }
// Wei 11-01:成員、方法、參數同一條規則:填過就一直用,主機換了不跟著換;沒有值不代選。跑真的 mgBag／mgInit／mgPrune／mgMembers／mgMethodOk／mgRunOptimize／mgRunBacktest
const mgOptTest = (async () => {
  const store = {}, sets = [], sizingSets = []; let cloudRead = () => ({ ok: true, v: null, opt: null }), report = { manager: {}, config: {} }, stored = { a: 1, b: 2 };
  const fields = [], els = { "mgm-err": { hidden: true, textContent: "" }, "mgm-ok": { disabled: false }, "mgm-fields": { textContent: "", querySelectorAll: () => fields, appendChild() {} }, "po-opt": { querySelector: () => null }, "mgm-desc": {}, "mgm-params": {} };
  const ctx = vm.createContext({ console, JSON, Promise, Object, MG_SIZE_KEY: "ws_mg_sizing", MG_SEL_KEY: "ws_mg_members", MG_OPT_KEY: "ws_mg_opt", TR_ZONE_UNKNOWN: "?", localStorage: { getItem: (k) => { if (ctx.lsBroken) throw new Error("x"); return k in store ? store[k] : null; }, setItem: (k, v) => { store[k] = String(v); } },
    window: { blave: { mgSizingCloud: () => Promise.resolve().then(() => cloudRead()), mgSizingCloudSet: (v) => { sizingSets.push(v); return Promise.resolve(true); }, mgOptCloudSet: (v) => { sets.push(JSON.parse(J(v))); return Promise.resolve(true); } } },
    t: (k, o) => k + (o ? J(o) : ""), $: (id) => els[id], trReport: () => report, trStored: () => stored, trCfgUnread: () => false, mgPaint: () => { ctx.painted = (ctx.painted || 0) + 1; }, mgMethodClose: () => {}, mgRefreshThen: (S, go) => { ctx.ran = (ctx.ran || 0) + 1; }, mgMethodFields: () => {}, mgShort: () => null, trackFeature: () => {}, mgJobKey: () => null, mgRunning: () => false, mgJobAny: () => null, mgSig: () => null });
  const has = ["mgBag", "mgPrefsLoad", "mgSizingCloudLoad", "mgOptPin", "mgSave", "mgManager", "mgBlocked", "mgReportedBuiltins", "mgBuiltins", "mgMethod", "mgAllocators", "mgAllocLabel", "mgInit", "mgPrune", "mgOptBlockReason", "mgMembers", "mgSetMembers", "mgProposal", "mgPropOtherAlloc", "mgOtherProp", "mgNotDropped", "mgMethodOk", "mgBtBlockReason", "mgRunOptimize", "mgRunBacktest", "mgArgs", "mgWireAlloc"];
  vm.runInContext(pp.replace(/^const /gm, "var ") + "\n" + has.map((n) => cutF(psrc, n)).join("\n"), ctx);
  const call = (s) => vm.runInContext(s, ctx), wait = () => new Promise((r) => setTimeout(r, 5));
  const M = (extra) => Object.assign({ can_manage: true, builtin_methods: [{ name: "equal", params: {} }, { name: "slope", params: { lookback: 365 } }, { name: "sharpe", params: { lookback: 365 } }], default_method: "equal", allocators: [], strategies: [] }, extra);
  const bag = (env) => { ctx.TR = { env: env || "local", sig: {}, list: [{ name: "a" }, { name: "b" }, { name: "c" }], listLoaded: true, api: {} }; return call("mgBag()"); };
  const init = (rep, env) => { report = rep; const G = bag(env); if (G.prefs === "ok") { call("mgInit(mgBag())"); call("mgPrune(mgBag())"); } return G; };
  let G = init({ manager: M(), config: {} });
  ok("全新、主機什麼都沒有:方法空著,不套 default_method;跑優化與回測都不送,講要選方法", G.alloc === null && call("mgOptBlockReason()") === "mg.needAlloc" && call("mgBtBlockReason()") === "mg.needAlloc" && (call("mgRunOptimize()"), call("mgRunBacktest()"), !ctx.ran) && !("ws_mg_opt" in store), J(G.alloc));
  G = init({ manager: M(), config: { allocator: null, weights: {} } });
  ok("config 有 allocator:null 但沒上線:仍空著,不當 slope", G.alloc === null);
  G = init({ manager: M(), config: { weights: { a: 1 } } });
  ok("已上線的舊 config 沒寫 allocator = slope(同 manager.py);宣告的 lookback 365 不代填,要用戶填", G.alloc === "slope" && G.params.lookback === null && call("mgOptBlockReason()") === 'mg.needParams{"method":"mg.slope"}', J([G.alloc, G.params]));
  G = init({ manager: M({ proposal: { members: ["a", "b"], allocator: "sharpe", params: { lookback: 120 } }, backtest_job: { status: "done", members: ["a", "b"], allocator: "slope", params: { lookback: 90 } } }), config: { allocator: "equal" } });
  const j = [G.alloc, G.params.lookback];
  G = init({ manager: M({ proposal: { members: ["a", "b"], allocator: "sharpe", params: { lookback: 120 } } }), config: { allocator: "equal" } }); const p = [G.alloc, G.params.lookback];
  G = init({ manager: M(), config: { allocator: "equal" } });
  ok("主機現值:回測 job > 提案 > config;這些推出來的值帶參數,但用戶沒碰過就不存", J(j) === J(["slope", 90]) && J(p) === J(["sharpe", 120]) && G.alloc === "equal" && !("ws_mg_opt" in store), J([j, p, G.alloc]));
  // 用戶在框裡選 slope、回看 90
  ctx.mgmPendSet = { alloc: "slope", params: { lookback: null } }; call("mgmPend = { G: mgBag(), alloc: 'slope', params: { lookback: null } }");
  fields.length = 0; fields.push({ dataset: { key: "lookback" }, value: "" }); call("mgMethodOk()");
  const emptyStopped = els["mgm-err"].hidden === false && els["mgm-err"].textContent === "mg.lookbackRange" && !("ws_mg_opt" in store); els["mgm-err"].hidden = true;
  fields[0].value = "90"; call("mgMethodOk()");
  ok("方法框:回看空著不能確定;填了按確定存下方法與參數", emptyStopped && J(JSON.parse(store.ws_mg_opt)) === J({ alloc: "slope", params: { slope: { lookback: 90 } } }), store.ws_mg_opt);
  const prop = { members: ["a", "b"], allocator: "sharpe", params: { lookback: 365 }, weights: { a: 0.5, b: 0.5 } };
  store.ws_mg_members = J(["a", "b"]);
  G = init({ manager: M({ proposal: prop, backtest_job: { status: "done", members: ["a", "b"], allocator: "sharpe", params: { lookback: 365 } } }), config: { allocator: "sharpe", amounts: {} } }); stored = { a: 1, b: 2 };
  ok("重開、機器上的提案是別的方法算的:用戶選的 slope／90 不換;權重表照現有提示講 sharpe 算的;提案不算這組的", G.alloc === "slope" && G.params.lookback === 90 && call("mgPropOtherAlloc()") === "sharpe" && call("mgProposal()") === null, J([G.alloc, G.params]));
  report = { manager: M({ builtin_methods: [{ name: "equal", params: {} }] }), config: {} }; call("mgPrune(mgBag())");
  const gone = [G.alloc, G.params.lookback, call("mgOptBlockReason()"), call("mgBtBlockReason()")]; const n0 = ctx.ran || 0; call("mgRunOptimize()"); call("mgRunBacktest()");
  report = { manager: M(), config: {} }; call("mgPrune(mgBag())");
  ok("方法暫時不在(報告這一輪沒帶到／自訂方法被刪):不換方法、不清參數,跑優化與回測都不送並講原因;回來了還是原值", J(gone) === J(["slope", 90, 'mg.allocGone{"method":"mg.slope"}', 'mg.allocGone{"method":"mg.slope"}']) && (ctx.ran || 0) === n0 && G.alloc === "slope" && G.params.lookback === 90 && !/mgDefaultAlloc|default_method/.test(psrc), J(gone));
  report = { manager: M({ allocators: [{ name: "mine", params: { a: 1, on: true } }] }), config: {} };
  store.ws_mg_opt = J({ alloc: "mine", params: { mine: { a: 2 } } }); G = init(report);
  ok("自訂方法多宣告一格:填過的留著,沒填過的 null,不用宣告值;不能跑", G.alloc === "mine" && G.params.a === 2 && G.params.on === null && call("mgOptBlockReason()") === 'mg.needParams{"method":"mine"}', J(G.params));
  { const before = store.ws_mg_opt; call("mgmPend = { G: mgBag(), alloc: 'mine', params: { a: 2, on: null } }"); fields.length = 0; fields.push({ dataset: { key: "a" }, value: "" }, { dataset: { key: "on" }, value: "true" }); els["mgm-err"].hidden = true; call("mgMethodOk()"); const blankNum = els["mgm-err"].hidden === false && store.ws_mg_opt === before && G.params.on === null;
    fields[0].value = "3"; fields[1].value = ""; els["mgm-err"].hidden = true; call("mgMethodOk()");
    ok("自訂參數:數字格與布林格空著都不能確定,空字串不會變成 0 或 false", blankNum && els["mgm-err"].hidden === false && store.ws_mg_opt === before, store.ws_mg_opt); els["mgm-err"].hidden = true; }
  { store.ws_mg_opt = J({ alloc: "slope", params: { slope: { lookback: 90 }, sharpe: { lookback: 120 } } }); G = init({ manager: M(), config: {} }); ctx.ran = 0; call("mgRunOptimize()");
    const a = JSON.parse(store.ws_mg_opt); G.alloc = "equal"; G.params = {}; G.optBusy = false; call("mgRunBacktest()"); const b = JSON.parse(store.ws_mg_opt);
    ok("拿主機推的值跑優化／回測也算用戶確認:存下來;各方法填過的參數各自留著", ctx.ran === 2 && a.params.sharpe.lookback === 120 && b.alloc === "equal" && b.params.slope.lookback === 90 && J(b.params.equal) === "{}", J([a, b])); }
  // 成員
  delete store.ws_mg_members; stored = { a: 1, b: 2 }; G = bag(); const seeded = J(call("mgMembers()"));
  ctx.mgSetMembersArg = ["a", "c"]; call("mgSetMembers(TR, ['a', 'c'])"); const picked = JSON.parse(store.ws_mg_members); stored = { b: 2 }; G = bag(); const again = J(call("mgMembers()"));
  ctx.TR.list = [{ name: "a" }]; const shrunk = J(call("mgMembers()")); const kept = store.ws_mg_members;
  ok("成員:第一次帶配置那組;勾過之後配置怎麼變都照勾的;清單一時少一支只影響畫面,存檔不變", seeded === J(["a", "b"]) && J(picked) === J(["a", "c"]) && again === J(["a", "c"]) && shrunk === J(["a"]) && kept === J(["a", "c"]), J([seeded, picked, again, shrunk, kept]));
  // 雲端
  sets.length = 0; cloudRead = () => ({ ok: true, v: { fund: 5, fundCcy: "USDT", method: "lev", target: { lev: 2 } }, opt: { sel: ["a", "c"], alloc: "slope", params: { slope: { lookback: 90 } } } });
  G = bag("cloud"); const load0 = [G.prefs, J(call("mgMembers()")), G.sel]; call("mgSave(TR, MG_SEL_KEY, ['x'])"); call("mgSave(TR, MG_SIZE_KEY, {})");
  await wait();
  ok("雲端讀回前:成員不從配置填也不存,任何 mgSave 都不寫;讀回後成員、方法、參數、部位大小都是存的那份", J(load0) === J(["loading", J(["b"]), null]) && sets.length === 0 && sizingSets.length === 0 && G.prefs === "ok" && J(G.sel) === J(["a", "c"]) && G.optSaved.alloc === "slope" && G.sizing.fund === 5 && J(call("mgMembers()")) === J(["a", "c"]), J([load0, sets, G.sel]));
  ctx.TR.list = [{ name: "a" }, { name: "b" }, { name: "c" }]; call("mgSetMembers(TR, ['a'])");
  ok("雲端勾成員:整份寫回(sel 帶方法與參數),沒有另一條路", sets.length === 1 && J(sets[0]) === J({ sel: ["a"], alloc: "slope", params: { slope: { lookback: 90 } } }), J(sets));
  cloudRead = () => ({ ok: true, v: { fund: 5, method: "lev" }, opt: { sel: ["z"], alloc: "sharpe", params: {} } }); G = bag("cloud"); G.sizingSet = true; G.selSet = true; G.optSet = true; G.sizing = F.mpsSizingClean({ fund: 7 }); G.sel = ["q"]; await wait();
  ok("讀回前用戶已動過的不蓋", G.sizing.fund === 7 && J(G.sel) === J(["q"]) && G.optSaved === null);
  cloudRead = () => ({ ok: true, v: null, opt: null }); G = bag("cloud"); await wait(); stored = { a: 1 };
  ok("雲端第一次(真的沒存過):ok、照配置那組", G.prefs === "ok" && J(call("mgMembers()")) === J(["a"]));
  // 讀不到
  for (const [name, rd] of [["主行程回 ok:false", () => ({ ok: false })], ["IPC 拒絕(null)", () => null], ["IPC 丟例外", () => { throw new Error("x"); }]]) {
    sets.length = 0; sizingSets.length = 0; cloudRead = rd; G = bag("cloud"); await wait();
    const was = G.prefs; call("mgSave(TR, MG_SIZE_KEY, {})"); call("mgSave(TR, MG_OPT_KEY, {})"); const none = J(call("mgMembers()"));
    ok("讀不到(" + name + "):標 failed 不當沒填過;不存任何東西;成員不從配置定下來", was === "failed" && sets.length === 0 && sizingSets.length === 0 && G.sel === null && none === J(["a"]), J([was, none])); }
  cloudRead = () => ({ ok: true, v: { fund: 9, method: "lev", target: { lev: 1 } }, opt: null }); ctx.TR.mg.prefs = "loading"; call("mgPrefsLoad(TR)"); await wait();
  ok("重試讀得到:回到存的那份", ctx.TR.mg.prefs === "ok" && ctx.TR.mg.sizing.fund === 9);
  store.ws_mg_sizing = "{bad"; G = bag(); const lf = G.prefs; delete store.ws_mg_sizing;
  ok("本機存檔壞掉同樣標 failed", lf === "failed");
  { const C = { env: "cloud", sig: {} }; ctx.C = C; ctx.TR = C; cloudRead = () => ({ ok: true, v: { fund: 3, method: "lev" }, opt: null }); call("mgBag(C)"); const old = C.mg; C.mg = null; await wait();
    ok("換人後才回來的那份丟掉", old.sizing.fund === null); }
  { G = init({ manager: M(), config: { allocator: "equal" } }); call("mgmPend = { G: null, alloc: 'sharpe', params: {} }"); fields.length = 0; call("mgMethodOk()");
    ok("開著方法框時換了帳號:草稿不寫進新的人", G.alloc === "equal" && !G.optSet); }
  { report = { manager: M({ builtin_methods: null, default_method: null }), config: { allocator: "slope", target_vol_pct: 40 } }; const G = bag(); call("mgInit(mgBag())"); G.params = { lookback: 90 }; ctx.ran = 0; const was = call("mgBlocked()"); call("mgRunOptimize()"); call("mgRunBacktest()"); const args = call("mgArgs()");
    ok("舊 runtime(沒回報內建方法):走先更新,跑優化與回測都不送;mgArgs 不偷補 target_vol 也不補 lookback", was === true && ctx.ran === 0 && !("target_vol" in args.params) && J(args.params) === J({ lookback: 90 }) && !/MG_TARGET_VOL_DEFAULT|target_vol_pct/.test(psrc), J(args)); }
  ok("畫面接線:讀不到時 mgPaint 只畫讀不到那一框(有重試、重新填),不定初值;工具列與霧上的〔跑優化〕都停用並講原因;部位大小框開著換人不寫",
    cutF(psrc, "mgPaint").indexOf('if (G.prefs !== "ok")') < cutF(psrc, "mgPaint").indexOf("mgInit(G)") && /box\.appendChild\(mgPrefsBox\(\)\)/.test(cutF(psrc, "mgPaint")) && /t\("mg\.prefsRetry"\)/.test(cutF(psrc, "mgPrefsBox")) && /t\("mg\.prefsReset"\)/.test(cutF(psrc, "mgPrefsBox")) && /say\.setAttribute\("role", "status"\)/.test(cutF(psrc, "mgPrefsBox")) && /trackFeature\("mg_prefs_retry"\)/.test(cutF(psrc, "mgPrefsBox")) && /trackFeature\("mg_prefs_reset"\)/.test(cutF(psrc, "mgPrefsBox")) && /G\.alloc \? mgAllocLabel\(G\.alloc\) : t\("sz\.unset"\)/.test(cutF(psrc, "mgToolbar"))
    && /opt\.disabled = outdated \|\| !!needs/.test(cutF(psrc, "mgToolbar")) && /tb\.appendChild\(mgWhyFill\(trEl\("p", "pf-note mg-need-fund"\), needs, /.test(cutF(psrc, "mgToolbar")) && /b\.disabled = !!optNeeds;/.test(cutF(psrc, "poFog")) && /mgsDraft\.G !== G/.test(cutF(psrc, "mgSizeOk")));
})();
// 主行程:雲端部位大小存 ui-prefs.json、綁 who(換人 / 重新登入讀不到上一份)、清洗後才落地、不動其他鍵
{ const os = require("os"), msrc = fs.readFileSync(path.join(R, "..", "main.js"), "utf8"), pre = fs.readFileSync(path.join(R, "..", "preload.js"), "utf8");
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "blave-mgs-")); let who = "A";
  const ctx = { fs, path, app: { getPath: () => TMP }, currentWho: () => who };
  vm.runInNewContext([/^const uiPrefsPath = .*$/m.exec(msrc)[0], cutF(msrc, "uiPrefsPatch"), cutF(msrc, "mgSizingClean"), cutF(msrc, "mgOptCloudClean"), cutF(msrc, "mgSizingCloudGet"), cutF(msrc, "mgSizingCloudSet"), cutF(msrc, "mgOptCloudSet")].join("\n") + "\nthis.get = mgSizingCloudGet; this.set = mgSizingCloudSet; this.setOpt = mgOptCloudSet;", ctx);
  fs.writeFileSync(path.join(TMP, "ui-prefs.json"), JSON.stringify({ pdfDir: "/x", stratOrder: ["a"] }));
  const a0 = ctx.get(), w = ctx.set({ fund: 86372, fundCcy: "USDT", method: "vol", target: { vol: 10.6, mdd: "x" }, evil: "<script>" }), wo = ctx.setOpt({ sel: ["a", 3], alloc: "slope", params: { slope: { lookback: 90, bad: null }, "../x": { a: 1 } }, evil: 1 }), back = ctx.get();
  who = "B"; const asB = ctx.get(); who = null; const none = ctx.get(), wNone = ctx.set({ fund: 1 }), wNone2 = ctx.setOpt({ alloc: "x" }); who = "A";
  const file = JSON.parse(fs.readFileSync(path.join(TMP, "ui-prefs.json"), "utf8"));
  const SZ = { fund: 86372, fundCcy: "USDT", method: "vol", target: { vol: 10.6, mdd: null, lev: null } }, OP = { sel: ["a"], alloc: "slope", params: { slope: { lookback: 90 } } };
  ok("主行程:沒存過 = ok、全空;存了讀回(清洗、丟多餘鍵);換人 = ok、全空;沒登入 = 讀不到(不是沒填過)也不寫;pdfDir 與側欄偏好不動;IPC 只收自家頁面,被拒回 ok:false",
    J(a0) === J({ ok: true, v: null, opt: null }) && w === true && wo === true && J(back) === J({ ok: true, v: SZ, opt: OP }) && J(asB) === J({ ok: true, v: null, opt: null }) && J(none) === J({ ok: false }) && wNone === false && wNone2 === false
    && file.pdfDir === "/x" && J(file.stratOrder) === J(["a"]) && file.mgSizingCloud.who === "A" && file.mgOptCloud.who === "A" && !fs.readdirSync(TMP).some((f) => /blave-tmp/.test(f))
    && /handle\("mg-sizing-cloud", \(\) => mgSizingCloudGet\(\), \{ ok: false \}\);/.test(msrc) && /handle\("mg-sizing-cloud-set", \(_e, v\) => mgSizingCloudSet\(v\), false\);/.test(msrc) && /handle\("mg-opt-cloud-set", \(_e, v\) => mgOptCloudSet\(v\), false\);/.test(msrc)
    && /mgSizingCloud: \(\) => ipcRenderer\.invoke\("mg-sizing-cloud"\)/.test(pre) && /mgSizingCloudSet: \(v\) => ipcRenderer\.invoke\("mg-sizing-cloud-set", v\)/.test(pre) && /mgOptCloudSet: \(v\) => ipcRenderer\.invoke\("mg-opt-cloud-set", v\)/.test(pre), J([a0, back, asB, none, file]));
  fs.writeFileSync(path.join(TMP, "ui-prefs.json"), "{壞掉"); const bad = ctx.get(); fs.rmSync(path.join(TMP, "ui-prefs.json")); const fresh = ctx.get();
  ok("主行程:ui-prefs.json 壞掉 = 讀不到;檔不存在 = 全新安裝,ok、全空", J(bad) === J({ ok: false }) && J(fresh) === J({ ok: true, v: null, opt: null }), J([bad, fresh]));
  fs.rmSync(TMP, { recursive: true, force: true }); }
// 第三台實測(cs-0124-w3)+ 設計稽核電腦版必改
{ const ctx = vm.createContext({ t: (k, o) => k + (o ? " " + JSON.stringify(o) : ""), TR: { list: [{ name: "txf", symbol: "TXF", twd: true }, { name: "tsmc", symbol: "2330", twd: true }, { name: "btc", symbol: "BTCUSDT" }] }, PAPER: "paper", TR_TWD_RE: /^(?:TXF|MXF|TMF|\d{4,6}[A-Z]?(?:\.TWO?)?)$/, CX_VENUES: { binance: {} } });
  vm.runInContext(["trCanonSym", "trTxfSpec", "trCapitalCanon", "trTwBroker", "trVenueKind", "trTradesSym", "trPaperTwOk", "trPaperTw"].map((n) => { try { return cutF(src, n); } catch (_) { return ""; } }).join("\n") + "\nvar TR_TXF_SPECS = " + J({ TXF: { cv: 200, prod: "x" }, MXF: { cv: 50, prod: "y" }, TMF: { cv: 10, prod: "z" } }) + ";", ctx);
  let vid = "paper"; ctx.trVenueId = () => vid;
  const run = (x) => vm.runInContext(x, ctx);
  ok("模擬交易照機器(lib/order_paper):台指期以口數成交 → 部位表對得上帳(不是「—」)、picker 不鎖;台股仍不支援;加密交易所不交易台指期",
    run('trVenueKind("paper")') === "paper" && run('trTradesSym("paper", "TXF")') && run('trTradesSym("paper", "TMF")') && !run('trTradesSym("paper", "2330")') && run('trTradesSym("paper", "BTCUSDT")')
    && !run('trTradesSym("crypto", "TXF")') && !run('trPaperTw("txf")') && run('trPaperTw("tsmc")') && !run('trPaperTw("btc")') && (vid = "binance", !run('trPaperTw("tsmc")')));
  // 0.1.27:機器的 lib 回報 can_paper_twstock 才解鎖台股;加密所照舊不交易台股
  vid = "paper"; ctx.trReport = () => ({ can_paper_twstock: true });
  ok("模擬交易台股:回報 can_paper_twstock 時部位表算它、金額不鎖;加密所照舊不交易台股;沒有這欄照舊鎖",
    run('trTradesSym("paper", "2330")') && run('trTradesSym("paper", "2330@spot")') && !run('trPaperTw("tsmc")') && !run('trTradesSym("crypto", "2330")')
    && (ctx.trReport = () => ({ can_paper_twstock: false }), !run('trTradesSym("paper", "2330")') && run('trPaperTw("tsmc")'))
    && (ctx.trReport = () => null, run('trPaperTw("tsmc")'))); }
ok("① 台指期報價兩個視角都問(統一、模擬交易在這台電腦也下台指期)", /if \(txf\) trTxfWant\(\);/.test(src) && !/if \(txf && cloud\) trTxfWant/.test(src));
ok("③ 套用金額走同一道:trCfOpen 擋模擬交易台股往上加(cf-block、okDisabled),配置分頁的輸入格也是 trPaperTw",
  /const paperTw = Object\.keys\(sending\)\.filter\(\(n\) => trPaperTw\(n\) && \(Number\(sending\[n\]\) \|\| 0\) > old\(n\)\);/.test(src) && /\n  blocked = badStored\.length > 0 \|\| paperTw\.length > 0;/.test(src) && /const twdRow = trPaperTw\(n\);/.test(src)
  && /mgApply[\s\S]*trCfOpen\(\{ names: trNames\(\), stored: trBase\(\), opener, source: "optimize"/.test(psrc));
{ const ctx = vm.createContext({ t: (k) => k }); vm.runInContext(cutF(src, "trCloseTag"), ctx);
  ok("確認框「平倉」:只有確定帳上有(trStratHeld true)才標;沒有(false)、讀不到(null)都不標(0.1.41);兩個確認框都帶",
    vm.runInContext("trCloseTag(5, 0, true, false)", ctx) === null && vm.runInContext("trCloseTag(5, 0, true, null)", ctx) === null && vm.runInContext("trCloseTag(5, 0, true, true)", ctx) === "tr.cfTagClose"
    && /mayFire && was > 0 && trStratHeld\(n\) === true/.test(src)); }
ok("口數列與台股列(模擬交易的台股以台幣回報)的未實現／保證金寫台幣(帳戶幣不是台幣時),表底不把台幣跟帳戶幣加在一起;拒單接在細節行底下、靠左",
  /rowCcy = lot \|\| zoneOfSym\[sym\] === TR_TXF_CCY \? TR_TXF_CCY : unit, ccy = rowCcy !== unit \? rowCcy : null/.test(src) && /const oneCcy = detRows\.every/.test(src) && /tb\.appendChild\(row\); rowOf\[sym\] = row;   \/\/ 拒單接在細節行底下/.test(src)
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
  ok("pres.s.worker* 改名:連上統一／連線中…／沒有讀到統一帳戶…(跟頁首的「下單程式」分開)", S.includes('"pres.s.worker": "連上統一"') && S.includes('"pres.s.workerRun": "連線中…"') && S.includes('"pres.s.workerFail": "沒有讀到統一帳戶。再試一次，還是不行就看設定 › 帳戶的狀態。"'));
  ok("選擇策略框:每一列都被「只下台指期」鎖住 → 清單底下 tr.pick.noTxf + 到策略庫(關框、開策略庫)", /if \(!mg && rows\.length && rows\.every\(\(r\) => r\.note === "txf"\)\) \{/.test(src) && /psClose\(\); if \(typeof libOpen === "function"\) libOpen\(\);/.test(src) && S.includes('"tr.pick.noTxf": "還沒有台指期策略。"'));
  ok("埋點:cfg_go_start 在白名單、按「到自動下單啟動」時送;post_connect_to_cfg 不加", /"cfg_go_start",/.test(tel) && /"mg_run_now",/.test(tel) && /trackFeature\("cfg_go_start"\)/.test(src) && !/post_connect_to_cfg/.test(tel + src)); }
// 設計師:句中的 venue 用各語言自己的名字(zh 統一期貨／en President Futures,不混中英);「5 口」接「的部位」不留空白
{ const S = fs.readFileSync(path.join(R, "strings.js"), "utf8");
  ok("「還沒有{venue}能下的策略金額」的 venue 走 trVenueLabel → pres.venue(zh 統一期貨、en President Futures,不是中英並列的選單標籤);tr.startOnBook 的 {n} 後面沒有空白",
    S.includes('"pres.venue": "統一期貨"') && S.includes('"pres.venue": "President Futures"') && /if \(id === "president"\) return t\("pres\.venue"\);/.test(src)
    && /t\("tr\.startOffNoVenueAmt", \{ venue: trVenueLabel\(trVenueId\(\), true\) \}\)/.test(src) && S.includes('"tr.startOnBook": "帳本上還有 {n}的部位。')); }
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
  { const need = ["trRowMoneyStored", "trZoneOf", "trZoneSum", "trTotalText", "trFxView", "trQuoteMap", "trPlanTotal", "trVenueId", "trVenueIds", "trTxfPrice", "trMultFmt", "trSymZone", "trEffSym", "trFmt", "trPaperTwOk"];
    vm.runInContext(need.map((n) => { try { return cutF(src, n); } catch (_) { return ""; } }).join("\n") + "\nvar TR_TXF = { price: 20000 }; function trEquity() { return null; } function trUnit() { return 'TWD'; }", ctx);
    const tot = (T) => { ctx.TR = T; return vm.runInContext("(function () { const p = trPlanTotal(trStored()); return p.text + ' ' + p.ccy; })()", ctx); };
    const only = (T) => { delete T.st.report.config.amounts.b; if (T.sent) delete T.sent.b; T.list = [T.list[0]]; return T; };
    const pend = only(bag()), done = only(bag()); done.sent = null; done.ct.sent = null; done.save = null; done.st.report.config = { amounts: { a: 20 }, contracts: { a: "TMF" } };
    const before = only(bag()); before.sent = null; before.ct.sent = null; before.save = null;
    const tp1 = tot(pend), td1 = tot(done), tb1 = tot(before);
    ok("P1-2 1 大台 → 20 微台待對上:合計 = 已對上時的值(4,000,000),不是 1 微台的 200,000", tp1 === td1 && tb1 === td1 && /4,000,000/.test(tp1)
      && /if \(trCtPend\(\)\) stored = trBase\(\) \|\| stored;/.test(src), J([tp1, td1, tb1])); }
    // 實機 integ2 10-18:綁了交易所、淨值還沒讀到 → 倍數那一段寫「淨值 —」;沒綁整段不出
    { const only = (T) => { delete T.st.report.config.amounts.b; if (T.sent) delete T.sent.b; T.list = [T.list[0]]; return T; }, bound = only(bag()); bound.st.report.venues = { president: { credentials: true, pair: true, order: true, account: true } };
      ctx.TR = bound; const na = vm.runInContext("trZoneSum(trStored(), null, trRowMoneyStored).multText", ctx); ctx.TR = only(bag()); const none = vm.runInContext("trZoneSum(trStored(), null, trRowMoneyStored).multText", ctx);
      ok("淨值讀不到:綁了交易所 → tr.equityMultNa(不是 0.00×、也不是空白);沒綁 → 空字串", na === "tr.equityMultNa" && none === "", J([na, none])); }
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
    mgMembers: () => ["a"], mgStrategies: () => [], mgJobAny: () => null, mgRunning: () => false, mgBlocked: () => false, mgBtBlockReason: () => null, mgArgs: () => ({ members: ["a"], allocator: null, params: {} }), trWith: (S, f) => f(), trRejectText: (x) => x, mgShortFromError: () => false, mgErrLine: (x) => x });
  vm.runInContext(pp.replace(/^const /gm, "var ") + "\nfunction mgOptBlockReason() { return null; }\nMG_REFRESH_POLL_MS = { fast: 15, slow: 15, fastFor: 60000 };\n" + ["mgBag", "mgPrefsLoad", "mgSizingCloudLoad", "mgOptPin", "mgPerfAt", "mgRefreshThen", "mgRunBacktest", "mgSendBacktest", "mgCancelBacktest"].map((n) => (/^async /.test(psrc.slice(psrc.indexOf("function " + n + "(") - 6, psrc.indexOf("function " + n + "("))) ? "async " : "") + cutF(psrc, n)).join("\n"), ctx);
  let done = false;
  ctx.TR = { env: "cloud", mg: null, sig: {}, api: { tradeSend: async (cmd, a) => { sent.push(cmd); return cmd === "stats_refresh" ? { ok: true, result: { started: a.names, skipped: {} } } : { ok: true, result: {} }; },
    loadStrategy: async () => ({ perf: done ? { at: 1 } : { at: 1, refresh: { status: "running" } } }) } };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  vm.runInContext("mgRunBacktest()", ctx); await until(waiting(ctx, "bt")); vm.runInContext("mgCancelBacktest()", ctx); await wait(80); done = true; await wait(60);
  const G1 = ctx.TR.mg, sent1 = sent.slice();
  ok("P1-2 等更新績效時按取消:等完不送 manage_backtest、不送 manage_cancel;鈕放開(btSending false)", sent1.indexOf("manage_backtest") < 0 && sent1.indexOf("manage_cancel") < 0 && G1.btSending === false, J(sent1));
  sent.length = 0; done = false; ctx.TR.mg = null;
  vm.runInContext("mgRunBacktest()", ctx); await until(waiting(ctx, "bt")); done = true; await until(() => sent.indexOf("manage_backtest") >= 0);
  ok("P1-2 對照:沒按取消,更新完就照常送 manage_backtest", sent.indexOf("manage_backtest") >= 0, J(sent));
})();
// Wei 10-14(同網頁 951af7ac):跑前只更新 6 小時沒更新過(或拿不到時間)的成員;全部都新就不送、不等,直接跑
const freshTest = (async () => {
  const NOW = Math.floor(Date.now() / 1000), H = 3600;
  const runOnce = async (members, perfAt, ranAt) => {
    const sent = [], ctx = vm.createContext({ console, JSON, Object, Array, String, Number, Math, Date, Promise, setTimeout, isFinite, t: (k) => k, trackFeature() {}, mgPaint() {}, trPollSoon() {},
      mgMembers: () => members, mgStrategies: () => Object.keys(ranAt).map((n) => ({ name: n, ran_at: ranAt[n] })), mgJobAny: () => null, mgRunning: () => false, mgBlocked: () => false, mgBtBlockReason: () => null,
      mgArgs: () => ({ members, allocator: null, params: {} }), trWith: (S, f) => f(), trRejectText: (x) => x, mgShortFromError: () => false, mgErrLine: (x) => x });
    vm.runInContext(pp.replace(/^const /gm, "var ") + "\nfunction mgOptBlockReason() { return null; }\nMG_REFRESH_POLL_MS = { fast: 5, slow: 5, fastFor: 60000 };\n" + ["mgBag", "mgPrefsLoad", "mgSizingCloudLoad", "mgOptPin", "mgPerfAt", "mgRefreshThen", "mgRunBacktest", "mgSendBacktest"].map((n) => (/^async /.test(psrc.slice(psrc.indexOf("function " + n + "(") - 6, psrc.indexOf("function " + n + "("))) ? "async " : "") + cutF(psrc, n)).join("\n"), ctx);
    let loads = 0; const redone = new Set();
    ctx.TR = { env: "cloud", mg: null, sig: {}, api: { tradeSend: async (cmd, a) => { sent.push([cmd, a && a.names ? a.names.slice() : null]); if (cmd === "stats_refresh") a.names.forEach((n) => redone.add(n)); return cmd === "stats_refresh" ? { ok: true, result: { started: a.names, skipped: {} } } : { ok: true, result: {} }; },
      tradeStatus: async () => ({}), loadStrategy: async (n) => { loads++; return redone.has(n) ? { perf: { at: NOW } } : n in perfAt ? { perf: { at: perfAt[n] } } : {}; } } };
    vm.runInContext("mgRunBacktest()", ctx); await until(() => sent.some((x) => x[0] === "manage_backtest"));
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
    mgMembers: () => ["a"], mgStrategies: () => [], mgJobAny: () => null, mgRunning: () => false, mgBlocked: () => false, mgBtBlockReason: () => null, mgArgs: () => ({ members: ["a"], allocator: null, params: {} }), trWith: (S, f) => f(), trRejectText: (x) => x, mgShortFromError: () => false, mgErrLine: (x) => x });
  vm.runInContext(pp.replace(/^const /gm, "var ") + "\nfunction mgOptBlockReason() { return null; }\nMG_REFRESH_POLL_MS = { fast: 40, slow: 2000, fastFor: 60000 };\n" + ["mgBag", "mgPrefsLoad", "mgSizingCloudLoad", "mgOptPin", "mgPerfAt", "mgRefreshThen", "mgRunBacktest", "mgSendBacktest"].map((n) => (/^async /.test(psrc.slice(psrc.indexOf("function " + n + "(") - 6, psrc.indexOf("function " + n + "("))) ? "async " : "") + cutF(psrc, n)).join("\n"), ctx);
  let refreshed = false, t0 = 0, tRun = 0;
  ctx.TR = { env: "cloud", mg: null, sig: {}, api: { tradeSend: async (cmd) => { sent.push(cmd); if (cmd === "stats_refresh") { t0 = Date.now(); setTimeout(() => { refreshed = true; }, 10); return { ok: true, result: { started: ["a"], skipped: {} } }; } tRun = Date.now(); return { ok: true, result: {} }; },
    tradeStatus: async () => ({}), loadStrategy: async () => ({ perf: refreshed ? { at: Math.floor(Date.now() / 1000) } : { at: 1, refresh: { status: "running" } } }) } };
  vm.runInContext("mgRunBacktest()", ctx); await until(() => tRun);
  ok("輪詢:更新 10ms 就完成 → 第一輪(40ms)抓完當場判斷就放行,不多等一輪;間隔前 1 分鐘 3 秒、之後 15 秒、上限 20 分鐘",
    sent.indexOf("manage_backtest") > 0 && tRun - t0 < 150 && /const MG_REFRESH_POLL_MS = \{ fast: 3000, slow: 15000, fastFor: 60000 \};/.test(psrc) && /const MG_REFRESH_MAX_MS = 20 \* 60000;/.test(psrc), J({ sent, dt: tRun - t0 }));
})();
// runtime 1.1.136 回條先到、「更新中」晚到;舊 runtime 先推後回條。兩種順序都要等到這一次真的結束才跑
const orderTest = (async () => {
  const go = async ({ base, timeline }) => {
    const sent = [], ctx = vm.createContext({ console, JSON, Object, Array, String, Number, Math, Date, Promise, setTimeout, isFinite, t: (k) => k, trackFeature() {}, mgPaint() {}, trPollSoon() {},
      mgMembers: () => ["a"], mgStrategies: () => [], mgJobAny: () => null, mgRunning: () => false, mgBlocked: () => false, mgBtBlockReason: () => null, mgArgs: () => ({ members: ["a"], allocator: null, params: {} }), trWith: (S, f) => f(), trRejectText: (x) => x, mgShortFromError: () => false, mgErrLine: (x) => x });
    vm.runInContext(pp.replace(/^const /gm, "var ") + "\nfunction mgOptBlockReason() { return null; }\nMG_REFRESH_POLL_MS = { fast: 10, slow: 10, fastFor: 60000 };\n" + ["mgBag", "mgPrefsLoad", "mgSizingCloudLoad", "mgOptPin", "mgPerfAt", "mgRefreshThen", "mgRunBacktest", "mgSendBacktest"].map((n) => (/^async /.test(psrc.slice(psrc.indexOf("function " + n + "(") - 6, psrc.indexOf("function " + n + "("))) ? "async " : "") + cutF(psrc, n)).join("\n"), ctx);
    let t0 = 0, runAt = null;
    ctx.TR = { env: "cloud", mg: null, sig: {}, api: {
      tradeSend: async (cmd, a) => { sent.push(cmd); if (cmd === "stats_refresh") { t0 = Date.now(); return { ok: true, result: { started: a.names, skipped: {} } }; } runAt = Date.now() - t0; return { ok: true, result: {} }; },
      tradeStatus: async () => ({}), loadStrategy: async () => ({ perf: t0 ? timeline(Date.now() - t0) : base }) } };
    vm.runInContext("mgRunBacktest()", ctx); await until(() => runAt !== null);
    return { sent, runAt };
  };
  const OLD = 1700000000, RUN = { status: "running", at: OLD + 50 };
  // 1.1.136:前 60ms 機器還沒推(detail 跟送出前一樣)→ 60–100ms 更新中 → 之後 at 換新
  const late = await go({ base: { at: OLD }, timeline: (ms) => ms < 60 ? { at: OLD } : ms < 100 ? { at: OLD, refresh: RUN } : { at: OLD + 99 } });
  ok("回條先到、推送晚到:detail 還跟送出前一樣時繼續等,更新完(at 換新)才送 manage_backtest", late.runAt !== null && late.runAt >= 95, J(late));
  // 舊 runtime:回條時已經是更新中
  const early = await go({ base: { at: OLD }, timeline: (ms) => ms < 60 ? { at: OLD, refresh: RUN } : { at: OLD + 99 } });
  ok("先推後回條(舊 runtime):更新中 → at 換新就送,不多等", early.runAt !== null && early.runAt >= 55 && early.runAt < 120, J(early));
  // 上一次留下的 failed:沒回報前不算這一次的結果;這一次失敗(新的 refresh.at)才放行
  const prevFail = { status: "failed", at: OLD + 5, err: "DATA" };
  const failed = await go({ base: { at: OLD, refresh: prevFail }, timeline: (ms) => ms < 60 ? { at: OLD, refresh: prevFail } : { at: OLD, refresh: { status: "failed", at: OLD + 60, err: "DATA" } } });
  ok("送出前就掛著上一次的 failed:推送前不放行,這一次的 failed 回來才送", failed.runAt !== null && failed.runAt >= 55, J(failed));
  // 送出前 detail 沒有 perf(拿不到基準):照舊只看 running,不卡滿 20 分鐘
  const nobase = await go({ base: null, timeline: () => null });
  ok("送出前拿不到 perf.at:不等推送,照舊沒看到更新中就跑", nobase.runAt !== null && nobase.runAt < 60, J(nobase));
})();
// 稽核 web-mgrefresh P1-2:雲端輪詢走 loadStrategyLite(只拿 perf);讀不到(429／斷線)= 繼續等,不是結束;不在了(null)= 結束
const liteTest = (async () => {
  const go = async (lite) => {
    const sent = [], full = [], ctx = vm.createContext({ console, JSON, Object, Array, String, Number, Math, Date, Promise, setTimeout, isFinite, t: (k) => k, trackFeature() {}, mgPaint() {}, trPollSoon() {},
      mgMembers: () => ["a"], mgStrategies: () => [], mgJobAny: () => null, mgRunning: () => false, mgBlocked: () => false, mgBtBlockReason: () => null, mgArgs: () => ({ members: ["a"], allocator: null, params: {} }), trWith: (S, f) => f(), trRejectText: (x) => x, mgShortFromError: () => false, mgErrLine: (x) => x });
    vm.runInContext(pp.replace(/^const /gm, "var ") + "\nfunction mgOptBlockReason() { return null; }\nMG_REFRESH_POLL_MS = { fast: 10, slow: 10, fastFor: 60000 };\n" + ["mgBag", "mgPrefsLoad", "mgSizingCloudLoad", "mgOptPin", "mgPerfAt", "mgRefreshThen", "mgRunBacktest", "mgSendBacktest"].map((n) => (/^async /.test(psrc.slice(psrc.indexOf("function " + n + "(") - 6, psrc.indexOf("function " + n + "("))) ? "async " : "") + cutF(psrc, n)).join("\n"), ctx);
    let t0 = 0, runAt = null;
    ctx.TR = { env: "cloud", mg: null, sig: {}, api: {
      tradeSend: async (cmd, a) => { sent.push(cmd); if (cmd === "stats_refresh") { t0 = Date.now(); return { ok: true, result: { started: a.names, skipped: {} } }; } runAt = Date.now() - t0; return { ok: true, result: {} }; },
      tradeStatus: async () => ({}), loadStrategy: async (n) => { full.push(n); return null; },
      loadStrategyLite: async (n) => lite(t0 ? Date.now() - t0 : -1, n) } };
    vm.runInContext("mgRunBacktest()", ctx); await until(() => runAt !== null);
    return { sent, full, runAt };
  };
  const OLD = 1700000000;
  const unreach = await go((ms, n) => { if (ms < 0) return { name: n, perf: { at: OLD } }; if (ms < 80) throw new Error("UNREACH"); return { name: n, perf: { at: OLD + 99 } }; });
  ok("雲端輪詢讀不到(429)那段繼續等,讀到 at 換新才送 manage_backtest;基準與輪詢都走 lite,不抓整份", unreach.runAt !== null && unreach.runAt >= 75 && unreach.full.length === 0, J(unreach));
  const gone = await go((ms, n) => (ms < 0 ? { name: n, perf: { at: OLD } } : null));
  ok("讀得到但這支已經不在了(null):當結束,直接跑", gone.runAt !== null && gone.runAt < 60, J(gone));
})();
// 稽核 audit-prerun-refresh:BUSY 要等、skip 不等、ack 失敗直接跑、超過 50 支分批且每批的 started 都收齊、剛好 6 小時不更新
const refreshEdgeTest = (async () => {
  const NOWMS = Date.parse("2026-10-14T06:00:00Z"), NOWS = NOWMS / 1000;
  class FixedDate extends Date { static now() { return NOWMS; } }
  const go = async ({ members, perfAt, ack, running }) => {
    const sent = [], ctx = vm.createContext({ console, JSON, Object, Array, String, Number, Math, Date: FixedDate, Promise, setTimeout, isFinite, t: (k) => k, trackFeature() {}, mgPaint() {}, trPollSoon() {},
      mgMembers: () => members, mgStrategies: () => [], mgJobAny: () => null, mgRunning: () => false, mgBlocked: () => false, mgBtBlockReason: () => null,
      mgArgs: () => ({ members, allocator: null, params: {} }), trWith: (S, f) => f(), trRejectText: (x) => x, mgShortFromError: () => false, mgErrLine: (x) => x });
    vm.runInContext(pp.replace(/^const /gm, "var ") + "\nfunction mgOptBlockReason() { return null; }\nMG_REFRESH_POLL_MS = { fast: 5, slow: 5, fastFor: 60000 };\n" + ["mgBag", "mgPrefsLoad", "mgSizingCloudLoad", "mgOptPin", "mgPerfAt", "mgRefreshThen", "mgRunBacktest", "mgSendBacktest"].map((n) => (/^async /.test(psrc.slice(psrc.indexOf("function " + n + "(") - 6, psrc.indexOf("function " + n + "("))) ? "async " : "") + cutF(psrc, n)).join("\n"), ctx);
    const T0 = Date.now(); let runAt = null; const asked = new Set();
    ctx.TR = { env: "cloud", mg: null, sig: {}, api: {
      tradeSend: async (cmd, a) => { sent.push([cmd, a && a.names ? a.names.length : null]); if (cmd !== "stats_refresh") { runAt = Date.now() - T0; return { ok: true, result: {} }; } a.names.forEach((n) => asked.add(n)); return ack(a.names); },
      tradeStatus: async () => ({}),
      loadStrategy: async (n) => { const on = running(n, Date.now() - T0); return { perf: Object.assign({ at: asked.has(n) && !on ? perfAt(n) + 100 : perfAt(n) }, on ? { refresh: { status: "running" } } : {}) }; } } };
    vm.runInContext("mgRunBacktest()", ctx); await until(() => runAt !== null);
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
    mgMembers: () => ["a"], mgStrategies: () => [], mgJobAny: () => null, mgRunning: () => false, mgBlocked: () => false, mgBtBlockReason: () => null, mgArgs: () => ({ members: ["a"], allocator: null, params: {} }), trWith: (S, f) => f(), trRejectText: (x) => x, mgShortFromError: () => false, mgErrLine: (x) => x });
  vm.runInContext(pp.replace(/^const /gm, "var ") + "\nfunction mgOptBlockReason() { return null; }\nMG_REFRESH_POLL_MS = { fast: 10, slow: 10, fastFor: 60000 };\n" + ["mgBag", "mgPrefsLoad", "mgSizingCloudLoad", "mgOptPin", "mgPerfAt", "mgRefreshThen", "mgRunBacktest", "mgSendBacktest", "mgCancelBacktest"].map((n) => (/^async /.test(psrc.slice(psrc.indexOf("function " + n + "(") - 6, psrc.indexOf("function " + n + "("))) ? "async " : "") + cutF(psrc, n)).join("\n"), ctx);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let done = false, ackDelay = 0, runs = 0;
  ctx.TR = { env: "cloud", mg: null, sig: {}, api: {
    tradeSend: async (cmd, a) => { sent.push(cmd); if (cmd === "stats_refresh") { runs++; return { ok: true, result: { started: a.names, skipped: {} } }; } if (cmd === "manage_backtest" && ackDelay) await wait(ackDelay); return { ok: true, result: {} }; },
    tradeStatus: async () => ({}), loadStrategy: async () => ({ perf: done ? { at: 1 + runs } : { at: 1, refresh: { status: "running" } } }) } };
  // 1. 等更新中按取消、馬上重按:更新結束後只送一次 manage_backtest(新的那一輪),舊的那一輪不送;取消不送 manage_cancel
  vm.runInContext("mgRunBacktest()", ctx); await until(waiting(ctx, "bt")); vm.runInContext("mgCancelBacktest()", ctx); vm.runInContext("mgRunBacktest()", ctx); await until(waiting(ctx, "bt")); done = true; await until(() => sent.indexOf("manage_backtest") >= 0); await wait(40);
  ok("取消等待中的那一次後馬上重按:更新完只送一次 manage_backtest(舊那一輪換了號碼不送),也不送 manage_cancel",
    sent.filter((c) => c === "manage_backtest").length === 1 && sent.indexOf("manage_cancel") < 0, J(sent));
  // 2. 已經送出 manage_backtest、ack 還沒回時按取消:是真的有 job → 送 manage_cancel
  sent.length = 0; ctx.TR.mg = null; done = true; ackDelay = 80;
  vm.runInContext("mgRunBacktest()", ctx); await until(() => sent.indexOf("manage_backtest") >= 0);
  const inFlight = sent.indexOf("manage_backtest") >= 0;
  vm.runInContext("mgCancelBacktest()", ctx); await until(() => sent.indexOf("manage_cancel") >= 0);
  ok("回測已送出、ack 還沒回時按取消:送 manage_cancel(不是當成還在等更新而作廢)", inFlight && sent.indexOf("manage_cancel") >= 0, J(sent));
})();
// Wei 10-14:等更新績效時鈕下方一行「等「X」更新績效…」+「先用目前數字跑」——按了停止等待、立刻送一次;正在跑的更新不取消
const runNowTest = (async () => {
  const mk = () => { const sent = [], ctx = vm.createContext({ console, JSON, Object, Array, String, Number, Math, Date, Promise, setTimeout, isFinite, t: (k) => k, trackFeature(n) { sent.push("feature:" + n); }, mgPaint() {}, trPollSoon() {},
      mgMembers: () => ["a", "b", "c"], mgStrategies: () => [], mgJobAny: () => null, mgRunning: () => false, mgBlocked: () => false, mgBtBlockReason: () => null, mgArgs: () => ({ members: ["a", "b", "c"], allocator: null, params: {} }), trWith: (S, f) => f(), trRejectText: (x) => x, mgShortFromError: () => false, mgErrLine: (x) => x });
    vm.runInContext(pp.replace(/^const /gm, "var ") + "\nfunction mgOptBlockReason() { return null; }\nMG_REFRESH_POLL_MS = { fast: 2000, slow: 2000, fastFor: 60000 };\n" + ["mgBag", "mgPrefsLoad", "mgSizingCloudLoad", "mgOptPin", "mgPerfAt", "mgRefreshThen", "mgRunNow", "mgRunOptimize", "mgSendOptimize", "mgRunBacktest", "mgSendBacktest", "mgCancelBacktest"].map((n) => (/^async /.test(psrc.slice(psrc.indexOf("function " + n + "(") - 6, psrc.indexOf("function " + n + "("))) ? "async " : "") + cutF(psrc, n)).join("\n"), ctx);
    ctx.TR = { env: "cloud", mg: null, sig: {}, api: { tradeSend: async (cmd, a) => { sent.push(cmd); return cmd === "stats_refresh" ? { ok: true, result: { started: a.names, skipped: {} } } : { ok: true, result: {} }; },
      tradeStatus: async () => ({}), loadStrategy: async () => ({ perf: { at: 1, refresh: { status: "running" } } }) } };
    return { sent, ctx }; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  { const { sent, ctx } = mk(); vm.runInContext("mgRunOptimize()", ctx); await until(waiting(ctx, "opt"));
    const W = vm.runInContext("TR.mg.wait.opt", ctx), left = W ? W.left.slice() : null;
    vm.runInContext("mgRunNow('opt'); mgRunNow('opt')", ctx); await until(() => sent.indexOf("manage_optimize") >= 0); await wait(40);
    ok("跑優化在等三支更新:G.wait.opt.left 是那三支(鈕下方那一行的來源);按「先用目前數字跑」→ 不等 2 秒輪詢、馬上送一次 manage_optimize;按兩下也只送一次;埋點 mg_run_now 一次;不送取消更新的指令",
      J(left) === J(["a", "b", "c"]) && sent.filter((c) => c === "manage_optimize").length === 1 && sent.filter((c) => c === "feature:mg_run_now").length === 1 && vm.runInContext("TR.mg.wait.opt", ctx) === null
      && !sent.some((c) => /cancel/.test(c)), J(sent)); }
  { const { sent, ctx } = mk(); vm.runInContext("mgRunBacktest()", ctx); await until(waiting(ctx, "bt")); vm.runInContext("mgRunNow('bt')", ctx); await until(() => sent.indexOf("manage_backtest") >= 0); await wait(40);
    ok("跑回測等更新時「先用目前數字跑」→ 馬上送一次 manage_backtest(世代號照舊)", sent.filter((c) => c === "manage_backtest").length === 1, J(sent)); }
  { const { sent, ctx } = mk(); vm.runInContext("mgRunBacktest()", ctx); await until(waiting(ctx, "bt")); vm.runInContext("mgCancelBacktest()", ctx); const gone = vm.runInContext("TR.mg.wait.bt", ctx);
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
    mgMembers: () => ["a"], mgStrategies: () => [], mgJobAny: () => null, mgRunning: () => false, mgBlocked: () => false, mgBtBlockReason: () => null, mgArgs: () => ({ members: ["a"], allocator: null, params: {} }), trWith: (S, f) => f(), trRejectText: (x) => x, mgShortFromError: () => false, mgErrLine: (x) => x });
  vm.runInContext(pp.replace(/^const /gm, "var ") + "\nfunction mgOptBlockReason() { return null; }\nMG_REFRESH_POLL_MS = { fast: 10, slow: 10, fastFor: 60000 };\n" + ["mgBag", "mgPrefsLoad", "mgSizingCloudLoad", "mgOptPin", "mgPerfAt", "mgRefreshThen", "mgRunNow", "mgRunBacktest", "mgSendBacktest", "mgCancelBacktest"].map((n) => (/^async /.test(psrc.slice(psrc.indexOf("function " + n + "(") - 6, psrc.indexOf("function " + n + "("))) ? "async " : "") + cutF(psrc, n)).join("\n"), ctx);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  ctx.TR = { env: "cloud", mg: null, sig: {}, api: { tradeSend: async (cmd, a) => { sent.push(cmd); return cmd === "stats_refresh" ? { ok: true, result: { started: a.names, skipped: {} } } : { ok: true, result: {} }; },
    tradeStatus: async () => ({}), loadStrategy: async () => { if (slow) { stuck++; await wait(80); left++; } return { perf: { at: 1, refresh: { status: "running" } } }; } } };
  // 讓舊那一輪卡在「抓 detail」(80ms):取消、重按之後,新那一輪先把旗標立起來,舊那一輪才結束——結束時不能清掉新那一輪的
  let slow = false, stuck = 0, left = 0;
  vm.runInContext("mgRunBacktest()", ctx); await until(waiting(ctx, "bt")); slow = true; await until(() => stuck);
  vm.runInContext("mgCancelBacktest()", ctx); slow = false; vm.runInContext("mgRunBacktest()", ctx); await until(() => left === stuck && waiting(ctx, "bt")()); await wait(40);
  const G = ctx.TR.mg;
  ok("取消後馬上重按:舊那一輪結束後,新那一輪仍在等——G.refreshing.bt 還是 true、G.wait.bt 是新那一輪的、沒送 manage_backtest",
    G.refreshing.bt === true && !!G.wait.bt && G.wait.bt.left.length === 1 && sent.indexOf("manage_backtest") < 0, J({ refreshing: G.refreshing, sent }));
  vm.runInContext("mgRunNow('bt')", ctx); await until(() => sent.indexOf("manage_backtest") >= 0); await wait(10);
  ok("…新那一輪按「先用目前數字跑」才送一次 manage_backtest,轉圈旗標才收", sent.filter((c) => c === "manage_backtest").length === 1 && G.refreshing.bt === false, J(sent));
})();
// 對齊網頁:優化權重換成台指期不到一口 → 列上「0 口（不足一口）」、表底講少投多少;等待那一行加「優化：」「回測：」;剛選進還沒回報的不猜「合約」
ok("優化表:台指期取整成 0 口而有錢 → mg.lotsUnder、累計少投 → 表底 mg.lotsUnderFoot(換成投入資金幣別;換不了寫 TWD)",
  /else if \(r\.spec && nx === 0 && r\.moneyTwd > 0\) \{ cell\.textContent = t\("mg\.lotsUnder"\); underTwd \+= r\.moneyTwd; \}/.test(psrc) && /t\("mg\.lotsUnderFoot", \{ amt \}\)/.test(psrc)
  && fs.readFileSync(path.join(R, "strings.js"), "utf8").includes('"mg.lotsUnder": "0 口（不足一口）"'));
ok("優化表不再講台指期進位超配(0.1.44 拿掉):程式、門檻常數、字串、.po 都不留;少投那句照舊",
  !/[lL]otsOver|LOTS_OVER/.test(psrc) && !/lotsOverFoot/.test(fs.readFileSync(path.join(R, "strings.js"), "utf8") + fs.readFileSync(path.join(R, "..", "i18n", "zh.po"), "utf8") + fs.readFileSync(path.join(R, "..", "i18n", "en.po"), "utf8"))
  && /t\("mg\.lotsUnderFoot", \{ amt \}\)/.test(psrc));
ok("等待那一行前面寫「優化：」或「回測：」", /t\(w === "opt" \? "mg\.waitPrefixOpt" : "mg\.waitPrefixBt"\) \+ \(n === 1/.test(psrc) && fs.readFileSync(path.join(R, "strings.js"), "utf8").includes('"mg.waitPrefixOpt": "優化："'));
ok("投資組合還沒算出成分(沒有權重):金額表部位寫「—」(tooltip tr.sigNotYet),不是空手", /const cNotYet = isC && !tc && !noSig;/.test(src) && /trPaintPosCell\(tgt, a, pos, tc, \{ noSig, notYet: notYet \|\| cNotYet, txf, sentOn, clamped: paperShort \? "paper" : \(tc && tc\.clamped\) \|\| null \}\);/.test(src));
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
  ok("最大回撤不能選:原因點名最大回撤(雲端主機版本較舊／更新前算的／共同資料不到 90 天)", /"port_returns" in p \? "sz\.shortMdd" : mpsNoReturnsKey\(\)/.test(psrc) && /t\(mpsNoSeriesKey\(\)\)/.test(cutF(psrc, "mgSizeRender")) && S.includes('"sz.oldMdd": "雲端主機較舊，不能用最大回撤，更新雲端主機"') && S.includes('"sz.staleMdd": "重跑一次優化才能用最大回撤"') && S.includes('"sz.staleMdd": "Rerun the optimization to use max drawdown"') && S.includes('"sz.shortMdd": "共同資料不到 90 天，不能用最大回撤"'));
{ const ctx = vm.createContext({}); vm.runInContext(["mpsCvKey", "mpsCvBefore", "mpsNoReturnsKey"].map((n) => cutF(psrc, n)).join("\n") + "\nvar MPS_RETURNS_CV = " + J(/const MPS_RETURNS_CV = "([^"]+)"/.exec(psrc)[1]) + "; var TR = null;", ctx);
  const K = (env, cv) => { ctx.TR = { env, st: { cloud: cv === undefined ? undefined : { config_version: cv } } }; return vm.runInContext("mpsNoReturnsKey()", ctx); };
  ok("提案沒 port_returns 的原因分兩句:雲端 workspace 早於 2026-10-13-l(或讀不到版號)= 主機舊要先更新;已夠新 = 更新前算的、重跑就好;本機一律後者",
    K("cloud", "2026-10-13-k") === "sz.oldMdd" && K("cloud", "2026-10-12-z") === "sz.oldMdd" && K("cloud", null) === "sz.oldMdd" && K("cloud", undefined) === "sz.oldMdd"
    && K("cloud", "2026-10-13-l") === "sz.staleMdd" && K("cloud", "2026-10-13-aa") === "sz.staleMdd" && K("cloud", "2026-10-15-d") === "sz.staleMdd"
    && K("local", "2026-10-01") === "sz.staleMdd" && K("local", undefined) === "sz.staleMdd"
    && /"sz\.staleMdd": "重跑一次優化才能用最大回撤/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", "zh.po"), "utf8").replace(/msgid "sz\.staleMdd"\nmsgstr /, '"sz.staleMdd": ')), K("cloud", "2026-10-13-k")); }

  ok("部位大小還沒填:原因只有〔套用金額〕旁一句,表上不再講一次;字已定稿;工具列那句間距上 8、下 16",
    !/mg-need-fund/.test(cutF(psrc, "mgSuggestTable")) && !/mg\.noFx/.test(psrc)
    && S.includes('"mg.needFund": "先填投入資金"') && !/"mg\.applyWhySize"|"mg\.noFx"/.test(S) && S.includes('"mg.applyWhyFx": "缺匯率，金額換算不出來"') && !/"mg\.applyWhy(Fx|Login|FxOld)": "[^"]*(台指期|TAIEX|台幣|TWD)/.test(S) && /\.mg-unitw \.set-sel \{ height: 30px; \}/.test(fs.readFileSync(path.join(R, "trade.css"), "utf8")) && /"mg\.prefsReset": "Start Over"/.test(S) && /\.pf-note\.mg-need-fund \{ display: block; margin: var\(--space-8\) 0 var\(--space-16\); color: var\(--ink-2\); \}/.test(fs.readFileSync(path.join(R, "trade.css"), "utf8"))); }
// Wei 回報:沒有可選的策略時霧上的 CTA 是「Ask the agent」→ 兩種霧都是「選擇策略」、開同一個選擇框;框裡一支都沒有時出路寫在框內(tr.pick.empty,同網頁 pfPickEmpty)
{ const El = class { constructor(tag, cls, text) { this.tag = tag; this.className = cls || ""; this.textContent = text || ""; this.kids = []; this.dataset = {}; this.on = {}; }
    setAttribute() {} appendChild(c) { this.kids.push(c); return c; } append(...c) { this.kids.push(...c); } addEventListener(e, f) { this.on[e] = f; } };
  const fx = { opened: [], asked: [] }, fctx = vm.createContext({ TR: { env: "local" }, t: (k) => k, trEl: (tag, cls, text) => new El(tag, cls, text), trPickOff: () => false,
    psOpen: (b) => fx.opened.push(b), cxModalOpen: () => {}, poAskAgent: (x) => fx.asked.push(x), poFogCfg: () => new El("div"), poFogOver: () => new El("div") });
  vm.runInContext(cutF(psrc, "poFog"), fctx);
  const fog = vm.runInContext("poFog('pick')", fctx), card = fog.kids[1], btn = card.kids[1];
  btn.on.click();
  ok("霧:CTA 是「選擇策略」(tr.pick),按下開選擇框、不丟聊天框;卡片字 po.fogPick", btn.textContent === "tr.pick" && card.kids[0].textContent === "po.fogPick" && fx.opened.length === 1 && !fx.asked.length, J([btn.textContent, fx]));
  // 0.1.44 推翻「兩種霧都是選擇策略」(spec desktop-ui-fixes §1):沒有回測完成的策略走 po-new,鈕開新增策略框;選擇框只當保險
  const call = src.match(/box\.appendChild\(poFog\((.*)\)\);\n  \} else \{\n    box\.appendChild\(trAmountTable/);
  ok("沒選策略:有回測完成的上 pick 霧,一支都沒有上 po-new 霧;沒有 none 那條、不叫 agent", !!call && call[1] === 'TR.list.some((x) => x.hasBacktest) ? "pick" : "po-new"' && !/kind === "none"|fog-ask/.test(psrc), call && call[1]);
  const S = fs.readFileSync(path.join(R, "strings.js"), "utf8");
  ok("po.fogNone / po.fogNoneBtn / po.fogNoneAsk 兩語都刪了;框內空狀態一句接〔策略庫〕",
    !/po\.fogNone/.test(S) && S.includes('"tr.pick.empty": "還沒有回測完成的策略。"') && S.includes('"tr.pick.empty": "No backtested strategies yet."')
    && /const p = trEl\("p", "ps-next", t\("tr\.pick\.empty"\) \+ " "\)/.test(src));
}
// 網頁 01b51a54(設計師必改):細節行未實現取整到元、帶正負號;啟動框合計包成 .plan-tot(≈ 前面補間距)
{ const det = /seg\(t\("po\.dUpnl", \{ v: money\(trFmt\(Math\.round\(x\.unrealized_pnl\) \|\| 0, true\)\) \}\)\)/.test(src) && /t\("po\.dUpnl", \{ v: trFmt\(Math\.round\(su\) \|\| 0, true\) \}\)/.test(src);
  const css = fs.readFileSync(path.join(R, "trade.css"), "utf8"), app = fs.readFileSync(path.join(R, "app.js"), "utf8");
  ok("細節行與表底的未實現取整到元、帶正負號;啟動框合計是 .plan-tot、≈ 的才在左邊補 --space-4(不是 ≈ 就不補,免得「合計」後面兩格寬),confirmBox 收得下節點",
    det && /trEl\("span", "plan-tot" \+ \(p\.text\.indexOf\("≈"\) === 0 \? " approx" : ""\), p\.text/.test(src) && /\.del-body \.plan-tot\.approx \{ margin-left: var\(--space-4\); \}/.test(css) && /if \(typeof x === "string"\) p\.textContent = x; else p\.appendChild\(x\);/.test(app)); }
// A 案字串逐字同網頁 6ae71405(web messages.po;網頁的 {t}/{p}/{u}/{m} 在這裡是 {total}/{v})
{ const S = fs.readFileSync(path.join(R, "strings.js"), "utf8"), has = (v) => S.includes(JSON.stringify(v));
  const want = ["{venue} 帳戶裡策略開的部位", "What your strategies hold in your {venue} account", "策略外", "Off-strategy", "這個部位不是 Blave 下單建立的，對帳不會動它。", "均價 {v}", "Entry {v}", "未實現 {v}", "Unrealized {v}", "保證金 {v}", "Margin {v}", "（{x}×）", " ({x}×)",
    "這輪不下單：", "Skipped this round: ", "到策略組合修改", "Edit in Portfolio", "照策略組合 {n} 支策略，合計 {total} 下單。", "Orders follow {n} strategies in Portfolio, total {total}.", "Orders follow {n} strategy in Portfolio, total {total}.",
    "照策略組合 {n} 支策略下單。", "Orders follow {n} strategies in Portfolio.", "Orders follow {n} strategy in Portfolio.", "另有手動 {n}", "Plus manual {n}", "（含手動）", " (incl. manual)",
    "還沒有策略設定金額，先到策略組合設定。", "No strategy has an amount yet. Set one under Portfolio.", "帳上", "Held"];
  const miss = want.filter((v) => !has(v));
  ok("A 案字串兩語逐字同網頁(帳上、策略外、細節三段、門檻前導、到策略組合修改、啟動那句、原因行縮短版)", !miss.length, J(miss)); }
// 實機 integ2 10-18:優化分頁選了 2 檔、還沒跑優化也沒跑回測時下方整片空白 → Setup fog(CTA 跑優化,工具列那顆藏起來)
{ const st = { blocked: false, members: ["a", "b"], prop: null, other: null, bt: null, running: false, job: null, short: null };
  const ctx = vm.createContext({ mgBlocked: () => st.blocked, mgMembers: () => st.members, mgProposal: () => st.prop, mgOtherProp: () => st.other, mgBacktest: () => st.bt, mgRunning: () => st.running, mgJob: () => st.job, mgShort: () => st.short });
  vm.runInContext(cutF(psrc, "mgFogOn"), ctx);
  const G0 = () => ({ err: null, optBusy: false, btSending: false, shortDismissed: false, wait: { opt: null, bt: null } }), on = (o, g) => { const keep = Object.assign({}, st); Object.assign(st, o || {}); try { return vm.runInContext("mgFogOn", ctx)(Object.assign(G0(), g || {})); } finally { Object.assign(st, keep); } };
  ok("優化分頁的霧:2 檔、沒權重沒回測 → 開;1 檔／0 檔、有權重、有別的方法算的權重(C 案)、有回測、回測在跑、回測失敗、資料不足警示、送出中、等績效、機器落後 → 不開",
    on() === true && on({ members: ["a"] }) === false && on({ members: [] }) === false && on({ prop: {} }) === false && on({ other: {} }) === false && on({ bt: {} }) === false && on({ running: true }) === false
    && on({ job: { status: "error" } }) === false && on({ short: { n: 10, l: 60 } }) === false && on({ short: { n: 10, l: 60 } }, { shortDismissed: true }) === true
    && on({}, { optBusy: true }) === false && on({}, { btSending: true }) === false && on({}, { wait: { opt: { left: ["a"] }, bt: null } }) === false && on({ blocked: true }) === false && on({}, { err: "x" }) === false);
  ok("…霧開著時工具列的「跑優化」藏起來、霧上 CTA 是 mg.optRun 接 mgRunOptimize;兩語都有 mg.fogOpt 帶 {n}、只有一句(canon 一句話＋一顆鈕,不講工具列已有的跑回測)",
    /if \(fog\) box\.appendChild\(poFog\("opt"\)\);/.test(psrc) && /opt\.hidden = !!fog;/.test(psrc) && /kind === "opt"\) \{ b\.id = "mg-fog-opt"; b\.dataset\.fk = "mg-fog-opt"; b\.disabled = !!optNeeds; b\.addEventListener\("click", mgRunOptimize\); \}/.test(psrc)
    && (() => { const raw = fs.readFileSync(path.join(R, "strings.js"), "utf8"), S2 = (0, eval)("(" + raw.slice(raw.indexOf("{", raw.indexOf("const STRINGS")), raw.lastIndexOf("}") + 1) + ")"); return /\{n\}/.test(S2.zh["mg.fogOpt"]) && /\{n\}/.test(S2.en["mg.fogOpt"]) && !/跑回測|。.+/.test(S2.zh["mg.fogOpt"]) && !/Backtest|\.\s\S/.test(S2.en["mg.fogOpt"]); })()); }
// 回測「送出中」何時結束(同網頁 check_mg_bt_sending):認 job 的 started_at＋pid,不拿主機的 finished_at 比這台電腦的時鐘。
// 主機快 300 秒＋畫面上有舊結果:舊 job 不能當成這次跑完;主機慢 60 秒＋短回測直接 done:當場結束,不卡 120 秒
{ const T = 1800000000000, S0 = T / 1000, env = { now: T, job: null };
  const ctx = vm.createContext({ JSON, Object, Date: { now: () => env.now }, mgManager: () => ({ backtest_job: env.job }) });
  vm.runInContext(pp.replace(/^const /gm, "var ") + "\n" + ["mgJobAny", "mgRunning", "mgBtSendingSync"].map((n) => cutF(psrc, n)).join("\n"), ctx);
  const run = (o) => { env.now = T; env.job = o.before || null;
    const G = { btSending: true, btSentAt: o.acked === false ? 0 : T, btBaseJob: vm.runInContext("mgJobKey(mgJobAny())", ctx), btWaiting: !!o.waiting };
    env.job = o.job || null; env.now = T + (o.later || 5000); ctx.G = G; vm.runInContext("mgBtSendingSync(G)", ctx); return G.btSending; };
  const OLD = { status: "done", pid: 41, started_at: S0 - 60, finished_at: S0 - 50 }, FAST_OLD = { status: "done", pid: 41, started_at: S0 + 240, finished_at: S0 + 250 };
  const job = (skew, status) => ({ status, pid: 77, started_at: S0 + 1 + skew, finished_at: status === "running" ? null : S0 + 3 + skew });
  ok("送出中:主機時鐘快＋舊結果 → 報表還是舊 job 時仍算送出中(跑中面板出現、鈕鎖住);這次的 running／done 一出現就結束",
    run({ before: FAST_OLD, job: FAST_OLD }) === true && run({ before: FAST_OLD, job: FAST_OLD, acked: false }) === true && run({ before: FAST_OLD, job: job(300, "running") }) === false && run({ before: FAST_OLD, job: job(300, "done") }) === false);
  ok("送出中:主機時鐘慢＋短回測直接收尾 → 當場結束(含 ack 還沒回、原本沒 job、失敗收尾)",
    run({ before: OLD, job: job(-60, "done") }) === false && run({ before: null, job: job(-60, "done"), acked: false }) === false && run({ before: OLD, job: job(-60, "error") }) === false);
  ok("送出中:同一秒起的新 job 靠 pid 分;舊 job 原樣回來、沒有 job、還在等更新績效 → 仍算送出中;沒 started_at/pid 的舊 runtime 照舊等 running;120 秒逾時(ack 後才起算)",
    run({ before: OLD, job: Object.assign({}, OLD, { pid: 42 }) }) === false && run({ before: OLD, job: Object.assign({}, OLD) }) === true && run({ before: null, job: null }) === true
    && run({ before: OLD, job: job(0, "done"), acked: false, waiting: true }) === true && run({ before: { status: "done" }, job: { status: "done" } }) === true && run({ before: { status: "done" }, job: { status: "running" } }) === false
    && run({ before: OLD, job: OLD, later: 120001 }) === false && run({ before: OLD, job: OLD, later: 120001, acked: false }) === true);
  ok("…按下去就記住當下的 job(等更新績效之前),不再拿 finished_at 比",
    /G\.btSending = true; G\.btSentAt = 0; G\.btBaseJob = mgJobKey\(mgJobAny\(\)\);[\s\S]*G\.btWaiting = true;/.test(cutF(psrc, "mgRunBacktest")) && !/finished_at/.test(cutF(psrc, "mgBtSendingSync"))); }
// 用戶回報①(0.1.29):換方法後權重區整段不畫、沒說為什麼 → 機器上那份提案是別的方法算的時候講一句(同網頁 mgPropOtherAlloc)
{ const env = {};
  const ctx = vm.createContext({ JSON, Object, Array, String, MG_SLOPE: "slope",
    mgManager: () => ({ proposal: env.prop }), mgBag: () => ({ alloc: env.alloc, optBusy: !!env.busy, wait: { opt: env.wait ? { left: ["a"] } : null } }),
    mgBlocked: () => !!env.blocked, mgMembers: () => env.members, mgNotDropped: () => !env.dropped });
  vm.runInContext(cutF(psrc, "mgNormAlloc") + "\n" + cutF(psrc, "mgPropOtherAlloc"), ctx);
  const run = (o) => { Object.keys(env).forEach((k) => delete env[k]); Object.assign(env, { prop: { members: ["b", "a"], allocator: "slope" }, alloc: "equal", members: ["a", "b"] }, o); return vm.runInContext("mgPropOtherAlloc()", ctx); };
  ok("優化分頁:提案是 slope、目前選等權 → 回 slope(舊腳本 allocator null 也算 slope);同方法、成員不同、丟棄、跑優化中、等績效、機器落後、沒提案 → null",
    run({}) === "slope" && run({ prop: { members: ["a", "b"], allocator: null } }) === "slope" && run({ alloc: "slope" }) === null && run({ members: ["a"] }) === null
    && run({ members: ["a", "c"] }) === null && run({ dropped: true }) === null && run({ busy: true }) === null && run({ wait: true }) === null && run({ blocked: true }) === null
    && run({ prop: null }) === null && run({ prop: { allocator: "slope" } }) === null);
  // C 案(Wei 10-23):不出霧、照畫那份權重表;套用停用、原因「這份是「{method}」算的」寫在 .mg-apply-why,實心交回〔跑優化〕
  ok("…別的方法算的那份:權重表照畫(mpsProp 也認它)、不出霧;套用停用、原因寫進 .mg-apply-why(鈕以 aria-describedby 指到它,canon 文案密度 #5);套用本身只認 mgProposal",
    /const why = trEl\("div", "mg-apply-why"\);\n  const ap = [^\n]*ap\.setAttribute\("aria-describedby", "mg-apply-why"\);/.test(cutF(psrc, "mgSuggest")) &&
    /const other = mgProposal\(\) \? null : mgPropOtherAlloc\(\);\n  if \(!mgProposal\(\) && !other\) return frag;/.test(cutF(psrc, "mgSuggest")) && /mgSuggestTable\(wrap, ap, other, why\);/.test(cutF(psrc, "mgSuggest"))
    && /function mpsProp\(\) \{ return mgProposal\(\) \|\| mgOtherProp\(\); \}/.test(psrc) && /mgProposal\(\) \|\| mgOtherProp\(\) \|\| mgBacktest\(\)/.test(cutF(psrc, "mgFogOn"))
    && /ap\.disabled = !!other \|\|/.test(cutF(psrc, "mgSuggestTable")) && /const wk = other \? "mg\.propOtherAlloc" : ap\.disabled \? mgApplyWhy\(d, quoteMissing, changed\) : null;/.test(cutF(psrc, "mgSuggestTable"))
    && /if \(!mgProposal\(\) \|\|/.test(cutF(psrc, "mgApply")) && !/mg-other-alloc/.test(psrc)); }
let psPromise = null;
// ── 0.1.44 〔套用金額〕停用原因可點(mockup apply-why-links B 版)、策略名可點、目標波動算不出停用 ──
{ const STR = fs.readFileSync(path.join(R, "strings.js"), "utf8"), box = { }; vm.runInNewContext(STR.replace(/^const /gm, "var ") + "\nthis.out = typeof STRINGS !== 'undefined' ? STRINGS : null;", box);
  const CAT = box.out, WHY = psrc.slice(psrc.indexOf("const MG_WHY_SIZE"), psrc.indexOf("function mgWhyParts")), cut = (...ns) => ns.map((n) => cutF(psrc, n)).join("\n");
  const mkEl = (tag, cls, text) => { const e = { tag, className: cls || "", textContent: text == null ? "" : text, kids: [], dataset: {}, attrs: {}, on: {}, isConnected: true, offsetParent: {}, disabled: false, hidden: false, focusCalls: 0, selected: 0,
      appendChild(k) { this.kids.push(k); k.parentElement = this; return k; }, get children() { return this.kids; }, append(...ks) { ks.forEach((k) => { this.kids.push(k); k.parentElement = this; }); }, setAttribute(a, v) { this.attrs[a] = v; }, addEventListener(n, f) { this.on[n] = f; }, focus() { this.focusCalls++; FOCUS.at = this; }, select() { this.selected++; }, querySelector: () => null, querySelectorAll: () => [] }; return e; };
  const FOCUS = { at: null }, flatText = (e) => e.kids.map((k) => k.textContent).join("");
  const whyCtx = (o) => { const log = [], c = vm.createContext(Object.assign({ log, TR: { env: "local", st: { alive: true } }, trEl: (g, cl, x) => mkEl(g, cl, x), t: (k, a) => { const v = CAT[(o && o.lang) || "zh"][k]; return a ? v.replace(/\{(\w+)\}/g, (_, n) => a[n]) : v; },
      mgBag: () => ({ params: {}, optBusy: false }), trPickOff: () => false, mpsProp: () => ({}), mgBlocked: () => false, mgOptBlockReason: () => null, mgMembers: () => ["a", "b"], trackFeature: (n) => log.push("track:" + n),
      psOpen: (b, m, f, op) => log.push("psOpen:" + m + ":" + J(op)), mgMethodOpen: () => log.push("method"), mgSizeOpen: (b, fo) => log.push("size:" + fo), upCloudUpdate: () => log.push("update"), mgRunOptimize: () => log.push("run"), $: () => mkEl("div"), planSignIn: (x) => log.push(x), signInLabel: (x, l) => { x.dataset.signin = l; x.textContent = l; return x; } }, o || {}));
    vm.runInContext(WHY + "\n" + cut("mgWhyParts", "mgWhyCan", "mgWhyFill", "mgWhyWait", "mgWhySignSync", "mgWhyGo"), c); return c; };
  // 列舉:表上每一條、兩語,連結字都在句子裡(不在 = 接句尾那兩條);中文 ≤25 字;字串都在
  { const c = whyCtx(), FIX = vm.runInContext("MG_WHY_FIX", c), bad = [], APPEND = ["mg.applyDiffSet", "mg.propOtherAlloc"];
    Object.keys(FIX).forEach((k) => { const f = FIX[k], sk = f.text || k; ["zh", "en"].forEach((L) => { const sent = CAT[L][sk], link = f.link ? CAT[L][f.link] : sent;
      if (!sent || !link) bad.push(L + " 缺 " + sk); else if (APPEND.indexOf(k) < 0 && sent.indexOf(link) < 0) bad.push(L + " " + k + " 句中沒有連結字「" + link + "」"); });
      if (CAT.zh[sk] && CAT.zh[sk].replace(/\s/g, "").replace(/[A-Za-z]+|\d+|\{\w+\}/g, "N").length > 25) bad.push("zh 超過 25 字 " + sk); });
    ok("原因連結表 " + Object.keys(FIX).length + " 條,兩語連結字都在句中、中文句 ≤25 字", Object.keys(FIX).length === 14 && !bad.length, bad.join(";")); }
  ok("Wei 定字:sz.noVol 兩語;鈕下那句同字接連結", CAT.zh["sz.noVol"] === "近 90 天沒有波動資料，不能用目標波動" && CAT.en["sz.noVol"] === "No volatility data in the last 90 days, so target volatility is off" && CAT.en["mg.why.noVol"] === CAT.en["sz.noVol"] + "; " + CAT.en["mg.why.changeMethod"]);
  ["mg.applyDiffSetN", "mg.applyWhyUnread", "sz.noVol", "mg.why.pickTitle"].forEach((k) => { if (!CAT.zh[k] || !CAT.en[k] || CAT.zh[k].length > 25) ok("字串 " + k, false); });
  ok("工具列三句(缺方法／方法不見／缺參數)兩語都含〔方法〕連結字", ["mg.needAlloc", "mg.allocGone", "mg.needParams"].every((k) => ["zh", "en"].every((L) => CAT[L][k].indexOf(CAT[L]["mg.why.tbMethod"]) >= 0)));
  // 每一條帶去哪:點了走對的函式、送 mg_why_fix;整句是連結時沒有前段
  { const go = (k, o) => { const c = whyCtx(o); c.el = mkEl("div"); c.text = c.t((vm.runInContext("MG_WHY_FIX", c)[k].text) || k, { a: 2, b: 3, method: "x" }); vm.runInContext("mgWhyFill(el, text, MG_WHY_FIX[" + J(k) + "], 'mg-why-fix')", c); const b = c.el.kids.find((x) => x.tag === "button"); if (!b) return { b: null, el: c.el }; b.on.click(); return { b, el: c.el, log: c.log }; };
    const want = { "mg.applyDiffSet": 'psOpen:amounts:{"check":["a","b"]}', "mg.propOtherAlloc": "method", "mg.needFund": "size:fund", "mg.needSize": "size:fund", "mg.needMethod": "size:seg", "mg.needTarget": "size:t", "mg.sizeNoHist": "size:seg", "mg.sizeNoSolve": "size:t", "sz.shortMdd": "size:seg", "sz.staleMdd": "run" };
    const bad = Object.keys(want).filter((k) => { const r = go(k); return !r.b || J(r.log) !== J(["track:mg_why_fix", want[k]]) || r.b.dataset.fk !== "mg-why-fix"; });
    ok("原因 → 去處逐條(含埋點 mg_why_fix、data-fk=mg-why-fix)", !bad.length, bad.join());
    const old = go("sz.oldMdd", { TR: { env: "cloud", st: { alive: true } }, upNow: () => ({ cloud: { link: {} } }) });
    ok("主機較舊:雲端走 upCloudUpdate;本機不出連結", J(old.log) === J(["track:mg_why_fix", "update"]) && go("sz.oldMdd").b === null);
    const whole = go("mg.needFund"), mid = go("mg.applyWhyLogin"), tail = go("mg.sizeNoHist");
    ok("底線畫在原字上:整句是連結沒有前段;〔登入 Blave〕+ 後段;前段 + 〔換一個方法〕", whole.el.kids.length === 1 && whole.b.textContent === "先填投入資金"
      && mid.el.kids.map((k) => k.textContent).join("|") === "登入 Blave| 才拿得到匯率" && tail.el.kids.map((k) => k.textContent).join("|") === "這份結果算不出目標波動，|換一個方法");
    ok("開框的連結帶 aria-haspopup,直接做事的(重跑)不帶", whole.b.attrs["aria-haspopup"] === "dialog" && !go("sz.staleMdd").b.attrs["aria-haspopup"]);
    ok("按不動就不出連結:選擇策略開不了／優化在跑;句子照出", go("mg.applyDiffSet", { trPickOff: () => true }).b === null && go("sz.staleMdd", { mgBag: () => ({ params: {}, optBusy: true }) }).b === null
      && flatText(go("mg.applyDiffSet", { trPickOff: () => true }).el) === "配置 2 檔、這裡 3 檔");
    const c2 = whyCtx(), plain = mkEl("div"); c2.plain = plain; vm.runInContext("mgWhyFill(plain, '建議金額跟目前一樣', MG_WHY_FIX['mg.applyWhySame'], 'mg-why-fix')", c2);
    ok("等一下就好／好狀態不連:表上沒有這幾個原因", plain.kids.length === 1 && plain.kids[0].tag === "span" && ["mg.applyWhySame", "mg.applyWhyQuote", "mg.applyWhyFx", "mg.applyWhyWait", "mg.applyWhyUnread", "tr.saving", "tr.ccyMixed"].every((k) => !(k in vm.runInContext("MG_WHY_FIX", c2)))); }
  // 登入:原地開瀏覽器登入(planSignIn 帶這顆鈕),不繞去設定;等待中被輪詢重畫,鈕字由 signInLabel 接手
  { const c = whyCtx(), host = mkEl("div"); c.host = host; vm.runInContext("mgWhyFill(host, '登入 Blave 才拿得到匯率', MG_WHY_FIX['mg.applyWhyLogin'], 'mg-why-fix')", c);
    const b = host.kids.find((k) => k.tag === "button"); c.b = b; c.log.length = 0; vm.runInContext("mgWhyGo(MG_WHY_FIX['mg.applyWhyLogin'], b)", c);
    ok("登入連結:直接 planSignIn(帶這顆鈕)、鈕經 signInLabel、不開設定", c.log[0] === "track:mg_why_fix" && c.log[1] === b && c.log.length === 2 && b.dataset.signin === "登入 Blave" && !b.attrs["aria-haspopup"]
      && !/setOpen|setCat/.test(cutF(psrc, "mgWhyGo")));
    // 等待登入:連結字換「取消等待」時句子前後段不留,收尾後回來;按下當下、收尾都由 app.js 叫 mgWhySignSync(不重畫),輪詢重畫走 mgWhyFill
    const CANCEL = "取消等待"; c.t0 = c.t; c.document = { querySelectorAll: () => [b] };
    vm.runInContext(`var __t = t; t = (k, a) => (k === "oauth.cancel" ? ${JSON.stringify(CANCEL)} : __t(k, a));`, c);
    const seen = () => host.kids.filter((k) => !k.hidden).map((k) => k.textContent).join("|");
    const idle = seen(); b.textContent = CANCEL; vm.runInContext("mgWhySignSync()", c); const waiting = seen(); b.textContent = "登入 Blave"; vm.runInContext("mgWhySignSync()", c); const back = seen();
    ok("登入等待中整行只留〔取消等待〕,句子前後段不畫;結束後整句回來", idle === "登入 Blave| 才拿得到匯率" && waiting === CANCEL && back === idle, J([idle, waiting, back]));
    c.signInLabel = (x, l) => { x.dataset.signin = l; x.textContent = CANCEL; return x; }; const h2 = mkEl("div"); c.h2 = h2; vm.runInContext("mgWhyFill(h2, '上次存的匯率已超過 30 天，登入 Blave 更新', MG_WHY_FIX['mg.applyWhyFxOld'], 'mg-why-fix')", c);
    ok("等待中被輪詢重畫:也只留〔取消等待〕", h2.kids.filter((k) => !k.hidden).map((k) => k.textContent).join("|") === CANCEL, J(h2.kids.map((k) => [k.textContent, k.hidden])));
    const asrc = fs.readFileSync(path.join(R, "app.js"), "utf8"), fnA = (n) => { const i = asrc.indexOf("function " + n + "("); return asrc.slice(i, asrc.indexOf("\n}", i)); };
    ok("planSignIn 換字、planLogin 收尾都叫 mgWhySignSync", /mgWhySignSync\(\)/.test(fnA("planSignIn")) && /mgWhySignSync\(\)/.test(fnA("planLogin"))); }
  // 原因順序:讀不到設定排第一(trNames 空,不能講配置 0 檔);幣別未定講幣別不講報價
  { const c = vm.createContext({ TR: { save: null, env: "local", listLoaded: true, st: { alive: true } }, TR_BAGS: { cloud: { st: { cloud: { code: "OK" } } } }, trFxView: () => ({}), unread: true, mgSameAsAmounts: () => false, trReport: () => ({ states: {} }), trStored: () => ({}), trUnknownWhyKey: (ns) => "unk:" + ns.join() });
    c.trCfgUnread = () => c.unread; vm.runInContext(cut("mgApplyWhy", "mgFxWhy"), c); const why = (d, q) => { c.d = d; c.q = q; return vm.runInContext("mgApplyWhy(d, q, true)", c); };
    const a = why({ eff: 1, rows: [] }, false); c.unread = false; c.mgSameAsAmounts = () => true;
    const u = why({ eff: 1, rows: [{ name: "x", spec: null, money: 5, native: null, fxMissing: false }] }, true), q2 = why({ eff: 1, rows: [{ name: "t", spec: {}, money: 5, native: null, fxMissing: false }] }, true);
    ok("讀不到設定優先於成員不同;幣別未定 → 幣別句;台指期缺報價 → 報價句", a === "mg.applyWhyUnread" && u === "unk:x" && q2 === "mg.applyWhyQuote", J([a, u, q2])); }
  // 成員不同的句子
  { const c = vm.createContext({ t: (k, a) => k + J(a), trNames: () => ["a", "b", "c"], mgMembers: () => ["a", "b", "d"] }); vm.runInContext(cutF(psrc, "mgDiffText"), c); const same = vm.runInContext("mgDiffText()", c); c.mgMembers = () => ["a"]; const diff = vm.runInContext("mgDiffText()", c);
    ok("成員不同:同檔數講差幾檔,不同檔數比數字", same === 'mg.applyDiffSetN{"n":1}' && diff === 'mg.applyDiffSet{"a":3,"b":1}', J([same, diff])); }
  // 真錢:〔改配置〕的預勾不能繞過下單鎖
  { const els = {}, E = (id) => els[id] || (els[id] = Object.assign(mkEl("div", id), { classList: { toggle() {}, add() {}, remove() {} }, querySelector: (q) => (id === "ps-modal" ? E("head") : null) })); E("ps-scrim").hidden = true;
    const rowsSeen = []; const list = ["a", "b", "tx", "kept"].map((name) => ({ name, symbol: name.toUpperCase() + "USDT", hasBacktest: true }));
    const TR0 = { env: "local", list, open: true, view: "po", listLoaded: true };
    const c = vm.createContext({ TR: TR0, TR_BAGS: { local: TR0 }, ENV: { cur: "local" }, $: E, t: (k) => k, trEl: (g, cl, x) => mkEl(g, cl, x), psLoading: false, psMode: null, psOpener: null, psFromWhy: false, psToAmt: false, requestAnimationFrame: () => {},
      trLoadStrategies: async () => {}, trPickOff: () => false, mgMembers: () => ["a"], trNames: () => ["kept", "tx"], trackFeature: () => {}, trPickPrefs: () => ({ flags: {}, order: [] }), trReport: () => ({ can_trade_portfolio: true }), trVenueId: () => "okx", PAPER: "paper", trPaperTwOk: () => true, trTwBroker: () => false, trTwdVenueLock: () => (n) => n === "b" || n === "tx",
      envDotsUp: () => false, envRunDot: () => false, psRow: (r) => { rowsSeen.push(r); return mkEl("label"); }, trTxfSpec: () => null, trTwNameEl: () => null });
    vm.runInContext(cutF(src, "trPickRows") + "\nasync " + cutF(src, "psOpen") + "\nthis.run = psOpen;", c);
    const mem = (ns) => { c.mgMembers = () => ns; }; mem(["a", "b"]);
    psPromise = c.run(mkEl("button"), "amounts", true, { check: ["a", "b"] }).then(() => {
      const by = {}; rowsSeen.forEach((r) => { by[r.name] = r; });
      ok("〔改配置〕預勾優化這組:可勾的勾上;被下單鎖鎖住的新標的(優化裡有)勾不上;配置已有的存量沒在優化裡 = 不勾、不鎖(確認框講移出);鎖照配置算", by.a.checked === true && by.a.locked === false && by.b.checked === false && by.b.locked === true && by.kept.checked === false && by.kept.locked === false && by.tx.checked === false && by.tx.locked === false, J(by));
      ok("框頭講改的是配置;沒帶 check 的路徑不動標題", E("ps-title").textContent === "mg.why.pickTitle" && /if \(psFromWhy\) \{ rows\.forEach/.test(cutF(src, "psOpen")));
    }); }
  { const ap = cutF(src, "psApply"), cl = cutF(src, "psClose");
    ok("確定後留在優化分頁、焦點落〔套用金額〕,不搬去配置金額格;取消回連結,連結被重畫換掉就憑 data-fk 找", ap.indexOf("if (fromWhy) {") > ap.indexOf("poPaintCfg();") && ap.indexOf("if (fromWhy) {") < ap.indexOf('querySelectorAll(".amt-in")') && /const ap = \$\("mg-apply"\); if \(ap && !ap\.disabled\) ap\.focus\(\);/.test(ap)
      && /else if \(!\(fromWhy && mgWhyFocus\(\)\)\) psRefocus\(\);/.test(cl) && /\$\("ps-title"\)\.textContent = t\("tr\.pick\.title"\);/.test(cl)); }
  // B 版位置:原因句是 .pf-sec 的直接子、整行靠右;不在 .pf-acts 裡
  { const css = fs.readFileSync(path.join(R, "trade.css"), "utf8"), sg = cutF(psrc, "mgSuggest");
    ok("原因句在鈕正下方一行(整行靠右、行高 44、沒字收起),不跟鈕擠同一列", /sec\.append\(acts, why\)/.test(sg) && !/acts\.appendChild\(trEl\("span", "mg-apply-why"/.test(sg) && /\.mg-apply-why \{ flex: 0 0 100%; margin: -12px 0 -8px; padding: 13px 0;[^}]*text-align: right; \}/.test(css) && /\.mg-apply-why:empty \{ display: none; \}/.test(css));
    ok("mgPaint 簽章帶 trPickOff:選擇策略開得了／開不了時連結跟著換", /trPickOff\(\), mgWhyCan/.test(cutF(psrc, "mgPaint")));
    // 策略名:優化表、部位拆解、等算出的組合都走 trStratName(同配置表;不在清單是純文字)
    ok("策略名可點:優化表、部位表拆解列、等算出的投資組合都走 trStratName;優化表的合約下拉蓋在熱區上", /nm = trStratName\(n\);/.test(cutF(psrc, "mgSuggestTable")) && !/key-name/.test(psrc) && /nm\.appendChild\(trStratName\(c\.name\)\)/.test(src) && /nc\.append\(trStratName\(it\.wait\)/.test(src) && /\.mg-tbl \.ct-trig \{ position: relative; z-index: 1; \}/.test(css) && /\.pf-tbl td\.sname:has\(> \.pf-strat\) \{ position: relative; \}/.test(css) && /\.net-line \.nm:has\(> \.pf-strat\) \{ position: relative;/.test(css)); }
  // 目標波動算不出:那顆停用、原因常駐;不代換方法、已選的不動
  { const render = (prop, draftM) => { const body = mkEl("div"), c = vm.createContext({ mgsDraft: { method: draftM, t: { vol: "", mdd: "", lev: "" }, fund: "", fundCcy: "USDT", fundCcys: ["USDT"] }, $: () => body, trEl: (g, cl, x) => mkEl(g, cl, x), document: { createElement: (g) => mkEl(g) }, t: (k) => k, mpsProp: () => prop, mgSizeField: () => mkEl("div"), mgSizePreview: () => {}, MPS_METHODS: ["vol", "mdd", "lev"], mpsNoSeriesKey: () => "sz.shortMdd", mpsSeriesOf: (p) => p.s || null, mpsHistVolOf: F.mpsHistVolOf });
      vm.runInContext(cut("mpsVolIsZero", "mpsNoVolKey", "mgSizeRender") + "\nmgSizeRender();", c); const mf = body.kids[1], seg = mf.kids[1]; return { btn: Object.fromEntries(seg.kids.map((b) => [b.dataset.m, b])), notes: mf.kids.slice(2).filter((n) => !n.hidden).map((n) => n.textContent), d: c.mgsDraft }; };
    const zero = render({ ann_vol_pct: 0, s: [1, 2] }, "vol"), fine = render({ ann_vol_pct: 12, s: [1, 2] }, "vol"), oldP = render({ s: [1, 2] }, null), both = render({ ann_vol_pct: 0 }, null);
    ok("波動 0:目標波動停用,原因常駐講近 90 天沒波動資料;已選的方法不被換掉", zero.btn.vol.disabled === true && zero.btn.lev.disabled === false && zero.notes.join() === "sz.noVol" && zero.d.method === "vol" && zero.btn.vol.attrs["aria-checked"] === "true", J(zero.notes));
    ok("算得出波動:不停用、不多一句", fine.btn.vol.disabled === false && fine.notes.length === 0, J(fine.notes));
    ok("舊提案沒有波動欄位:一樣停用,但不能講成沒波動資料;兩顆都不能用時兩句都在", oldP.btn.vol.disabled === true && oldP.notes.join() === "mg.sizeNoHist" && both.btn.mdd.disabled === true && both.notes.join() === "sz.shortMdd,sz.noVol", J([oldP.notes, both.notes]));
    ok("點停用那顆不換方法", (() => { const before = zero.d.method; zero.btn.vol.on.click(); return zero.d.method === before && zero.d.methodDirty !== true; })());
    ok("真錢:算不出時金額仍是 null、不退回別的方法;mpsSizeGap 只換原因 key", F.mpsLevFor({ method: "vol", target: { vol: 30, mdd: null, lev: 2 } }, { ann_vol_pct: 0 }) === null && F.mpsSizeGap({ fund: 100, method: "vol", target: { vol: 30, mdd: null, lev: 2 } }, { ann_vol_pct: 0 }, "x") === "sz.noVol");
    const gapV = (p) => F.mpsSizeGap({ fund: 100, method: "vol", target: { vol: 30, mdd: null, lev: 2 } }, p, "x");
    ok("沒波動資料時鈕下與框內同一個原因:波動 0 → sz.noVol,舊提案沒欄位 → mg.sizeNoHist;鈕下那句多接連結字", gapV({ ann_volatility_pct: 0 }) === "sz.noVol" && gapV({}) === "mg.sizeNoHist" && CAT.zh["mg.why.noVol"] === CAT.zh["sz.noVol"] + "，" + CAT.zh["mg.why.changeMethod"]); }

  // 設計師／稽核回修:停用外觀、下拉留白、拆解列熱區不撐高列、描述念整句、更新連結不當死鈕
  { const css = fs.readFileSync(path.join(R, "trade.css"), "utf8");
    ok("部位大小框停用的方法:認真 disabled(灰字、not-allowed、hover 不變),舊的 aria-disabled 規則拿掉", /\.mg-size-seg button:disabled, \.mg-size-seg button:disabled:hover \{ color: var\(--ink-disabled\); cursor: not-allowed; \}/.test(css) && !/\.mg-size-seg button\[aria-disabled/.test(css));
    ok("選中又停用的方法:不填色、1px --ink-disabled 框,深色下字才讀得到(--ink-disabled 與 --surface-segment-on 同值),權重壓得過選中規則", /\.mg-size-seg button:disabled\[aria-checked="true"\] \{ background: transparent; border-color: var\(--ink-disabled\); \}/.test(css));
    ok("優化表合約下拉上下各留 8px(24 高撐到 40、不越列界);配置表窄欄那顆不動", /\.mg-tbl \.ct-trig::before \{ inset: -8px 0; \}/.test(css) && !/\.sub-sym \.ct-trig::before/.test(css));
    ok("拆解列策略名熱區:列距不動;中間列貼滿 22、首列往框內距擴、末列往合計上距擴,不跨鄰列", /\.net-line \{ display: flex; align-items: baseline; gap: var\(--space-12\); padding: var\(--space-2\) 0; \}/.test(css) && /\.net-line \.pf-strat::before \{ inset: -2px 0; \}/.test(css) && /\.net-line:first-child \.pf-strat::before \{ top: -10px; \}/.test(css) && /\.net-line:has\(\+ \.net-sum\) \.pf-strat::before \{ bottom: -6px; \}/.test(css)); }
  { const c = vm.createContext({}); vm.runInContext(cutF(psrc, "mgWhyHost"), c); const K = (tagName, next) => ({ tagName, nextElementSibling: next || null }), row = (first) => ({ firstElementChild: first }), host = (r) => vm.runInContext("mgWhyHost", c)(r);
    const lead = row(K("BUTTON", K("SPAN"))), whole = row(K("BUTTON")), pre = row(K("SPAN", K("BUTTON")));
    ok("鈕的描述念整句:連結打頭帶後段 → 整行;只有連結 → 連結;有前段 → 前段", host(lead) === lead && host(whole) === whole.firstElementChild && host(pre) === pre.firstElementChild && /const host = mgWhyHost\(why\); host\.id = "mg-apply-why";/.test(cutF(psrc, "mgSuggestTable"))); }
  { const can = (env, plan) => { const c = whyCtx({ TR: { env, st: { alive: true } }, upNow: () => plan }); return vm.runInContext("mgWhyCan({ go: 'update' })", c); };
    ok("〔更新雲端主機〕:換檔中／已停(upPlan 回 link null)不出連結;回合中(disabled)留著由 upCloudUpdate 講原因;本機不出", can("cloud", { cloud: { link: null } }) === false && can("cloud", { cloud: null }) === false && can("cloud", { cloud: { link: { disabled: true } } }) === true && can("cloud", { cloud: { link: {} } }) === true && can("local", { cloud: { link: {} } }) === false);
    ok("mgPaint 簽章帶更新連結能不能按:換檔開始或結束連結跟著變", /mgWhyCan\(\{ go: "update" \}\)/.test(cutF(psrc, "mgPaint"))); }
  // 部位大小框的落點
  { const open = (focusOn, opt) => { const on = mkEl("button", "checked"), first = mkEl("button", "first"), fund = mkEl("input", "fund"), tg = mkEl("input", "t"), body = mkEl("div"); body.querySelector = (q) => (/aria-checked/.test(q) ? (opt.checked ? on : null) : first);
      const log = {}, c = vm.createContext({ mgBag: () => ({ sizing: { fund: null, target: { vol: null, mdd: null, lev: null }, method: null } }), mpsProp: () => ({}), $: (id) => (id === "mgs-scrim" ? { hidden: true } : id === "mgs-body" ? body : id === "mgs-fund" ? fund : id === "mgs-t" ? (opt.t ? tg : null) : null), mpsFundCcy: () => "USDT", mpsCcy: () => "USDT", MPS_METHODS: [], mgSizeRender: () => {}, trackFeature: () => {}, mgScrimOpen: (id, el) => { log.to = el; }, mgsOpener: null, mgsDraft: null });
      vm.runInContext(cutF(psrc, "mgSizeOpen") + "\nthis.go = mgSizeOpen;", c); c.go(mkEl("button"), focusOn); return { to: log.to.className, sel: tg.selected }; };
    const r = [open(undefined, { checked: true }).to, open(undefined, {}).to, open("fund", { checked: true }).to, open("seg", { checked: true }).to, open("seg", {}).to, open("t", { checked: true, t: true }).to, open("t", { checked: true }).to];
    ok("框的落點:照舊(選中的方法→投入資金);fund;seg 選中那顆、停用時第一顆能用的;t 目標格全選,沒目標格退方法", J(r) === J(["checked", "fund", "fund", "checked", "first", "t", "checked"]) && open("t", { t: true }).sel === 1, J(r)); }
}
Promise.all([btCancelTest, freshTest, pollTest, orderTest, liteTest, refreshEdgeTest, cancelGenTest, runNowTest, refreshFlagTest, global.__sizingCloudTest, mgOptTest, psPromise]).then(() => { console.log(red ? `\n${red} 項沒過` : "\nALL PASS"); process.exit(red ? 1 : 0); });
