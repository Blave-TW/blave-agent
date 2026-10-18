/* 策略組合頁(0.1.24;照網頁 web-portfolio-0124 的 #mg_panel 兩個分頁):配置(金額表 + 各商品的總訊號部位,畫在 trade.js 的 poPaintCfg)
   與優化(這支檔:自己的策略清單、方法、跑優化、權重分配、部位大小、套用金額、移動窗格回測)。也放兩頁共用的台指期合約下拉與霧化空狀態。
   跟自動下單頁同一袋狀態(trade.js 的 TR / TR_BAGS):TR.view === "po" 時這一頁看得見,輪詢照 trPaint 走。
   優化的三個指令(manage_optimize / manage_backtest / manage_cancel)兩個視角都送:這台電腦走 daemon、雲端走 api 的指令佇列。
   用到 trade.js 的 $ / t / TR / TR_BAGS / ENV / trEl / trSec / trTipLabel / trHead / trFmt / trReport / trZone* / trCt* / trSaveAmounts…、
   app.js 的 trackFeature / srSay / autosize / paneSt / paneToggle、stratflags.js 的 sfApplyOrder / SF——都在呼叫時才取。 */

/* ── 純邏輯(tests/check_shell_portfolio.js 從原文切出來跑;這一段不准碰 DOM)────────────── */
const MG_EQUAL = "equal", MG_SLOPE = "slope", MG_SHARPE = "sharpe";
const MG_LOOKBACK_DEFAULT = 365;      // = manager.py LOOKBACK
const MG_TARGET_VOL_DEFAULT = 0.3;    // = manager.py TARGET_VOL
const MG_RANDOM_N = 1000;             // = management_backtest.py --random-n 預設,不傳
const MG_REFRESH_BATCH = 50;          // = stats_refresh 一次最多幾支(runtime STATS_REFRESH_MAX_NAMES)
const MG_REFRESH_MAX_MS = 20 * 60000; // 跑優化前更新績效最多等多久(沒上線的成員是整支重跑回測,一支最多 15 分鐘);逾時用現有數字跑
const MG_BT_SENT_MAX_MS = 120000;
const MG_REFRESH_POLL_MS = { fast: 3000, slow: 15000, fastFor: 60000 };   // 等更新績效時多久問一次:前 1 分鐘每 3 秒(上線中的成員幾秒就更新完),之後放寬到 15 秒     // 回測送出後報告一直沒看到 running 就放開鈕(機器端沒起來)
const MPS_METHODS = ["vol", "mdd", "lev"];
const MPS_MDD_WARN = 30;              // 預覽的最大回撤超過這個 % 字變紅
const MPS_SOLVE_LEV_MAX = 100;        // 目標回撤反推槓桿的上限
const MG_LOTS_OVER_WARN = 0.05;       // 台指期進位讓整份組合比計畫總部位多出超過這個比例,優化表下才講(Wei 10-16)
const MG_SHORT_RE = /insufficient history:\s*(\d+)\s*days?\s*<=\s*lookback\s*(\d+)/i;
// PARAMS 值型別照 contract(int/float/bool/str);lookback / target_vol 合法範圍同 listener
function mgParamOk(v) { return (typeof v === "number" && isFinite(v)) || typeof v === "boolean" || (typeof v === "string" && v.length <= 200); }
function mgParamInRange(k, v) {
  if (k === "lookback") return Number.isInteger(v) && v >= 10 && v <= 5000;
  if (k === "target_vol") return v >= 0.01 && v <= 5;
  return true;
}
// 一個方法的參數就是它自己宣告的 PARAMS(target_vol 永遠排除:那是呼叫端的旗標);現值優先保留(兩邊都宣告的 key 沿用)
function mgDefaultParams(method) {
  const p = {}, src = method && method.params && typeof method.params === "object" ? method.params : {};
  Object.keys(src).forEach((k) => { if (k !== "target_vol" && mgParamOk(src[k])) p[k] = src[k]; });
  return p;
}
function mgFitParams(method, cur) {
  const c = cur && typeof cur === "object" ? cur : {}, p = mgDefaultParams(method);
  Object.keys(p).forEach((k) => { if (k in c && typeof c[k] === typeof p[k] && mgParamOk(c[k]) && mgParamInRange(k, c[k])) p[k] = c[k]; });
  return p;
}
// 舊腳本(與舊 proposal/config)寫的 allocator=null 指的是當年唯一的內建方法 slope
function mgNormAlloc(v) { return typeof v === "string" && v ? v : MG_SLOPE; }
/* 提案 / 回測 job 是否對應目前的選擇(同網頁 mgSameSel):成員集合、方法、參數逐項;走查窗只在雙方都釘住時才比 */
function mgSameSel(o, members, alloc, params) {
  if (!o || typeof o !== "object" || !Array.isArray(o.members)) return false;
  const a = o.members.map(String).sort(), b = members.slice().sort();
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) return false;
  if (mgNormAlloc(o.allocator) !== alloc) return false;
  const p = o.params && typeof o.params === "object" ? o.params : {};
  const mine = params.lookback, theirs = typeof p.lookback === "number" ? p.lookback : typeof o.lookback === "number" ? o.lookback : null;
  if (typeof mine === "number" && theirs !== null && mine !== theirs) return false;
  return Object.keys(params).every((k) => {
    if (k === "lookback") return true;
    const x = params[k], y = p[k];
    return typeof x === "number" ? typeof y !== "boolean" && Math.abs(Number(y) - x) < 1e-9 : y === x;
  });
}
// 回測腳本的資料不足(log 尾,可能混 stdout;不 anchor 行首)→ 歷史天數 N;認不得 null
function mgShortDaysOf(err) { const m = MG_SHORT_RE.exec(String(err || "")); return m ? parseInt(m[1], 10) : null; }
function mgErrLine(e) { const s = String(e == null ? "" : e).split("\n").filter((x) => x.trim()); return (s[s.length - 1] || "").slice(0, 300); }
// 配置 %:整數就整數,非整數留 1 位
function mgWeightPct(w) {
  if (typeof w !== "number" || !isFinite(w)) return null;
  const p = w * 100;
  return Math.abs(p - Math.round(p)) < 0.05 ? String(Math.round(p)) : p.toFixed(1);
}
// fundCcy = 本金填下去時的幣別:之後成員換區(投入資金幣別跟著換)要換算,不能把同一個數字直接當新幣別讀。null = 舊存檔,照當下幣別讀
function mpsSizingClean(v) {
  const out = { fund: null, fundCcy: null, method: "vol", target: { vol: null, mdd: null, lev: null } };
  if (!v || typeof v !== "object") return out;
  const pos = (x) => (typeof x === "number" && isFinite(x) && x > 0 ? x : null);
  out.fund = pos(v.fund);
  if (out.fund !== null && typeof v.fundCcy === "string" && /^[A-Z]{2,8}$/.test(v.fundCcy)) out.fundCcy = v.fundCcy;
  if (MPS_METHODS.indexOf(v.method) >= 0) out.method = v.method;
  const tg = v.target && typeof v.target === "object" ? v.target : {};
  MPS_METHODS.forEach((m) => { out.target[m] = pos(tg[m]); });
  return out;
}
// 存著的本金換成 ccy:同幣別原值;換不出來(缺匯率)= null,不把數字原封當新幣別。只換顯示、不改存檔,換回原幣別就是原值
function mpsFundAs(s, ccy, conv) {
  if (s.fund === null) return null;
  if (!s.fundCcy || s.fundCcy === ccy) return s.fund;
  const v = conv(s.fund, s.fundCcy, ccy); return v === null ? null : Math.round(v);
}
/* 用戶確認過的值(按部位大小的「確定」、或套用金額成功)釘成明確值:本金帶幣別、方法 m 的目標。
   沒釘的 null 會跟著下一份優化結果(歷史波動、1× 回撤)與已存合計走,跑完優化就變了(Wei 10-16)。已有明確值的不蓋 */
function mpsSizingPin(s, ccy, fund, m, target) {
  const out = mpsSizingClean(s);
  if (out.fund === null && fund > 0) { out.fund = fund; out.fundCcy = ccy || null; } else if (out.fund !== null && !out.fundCcy && ccy) out.fundCcy = ccy;
  if (MPS_METHODS.indexOf(m) >= 0 && out.target[m] === null && target > 0) out.target[m] = target;
  return out;
}
// proposal.port_returns.r:按目前權重的組合日報酬(小數、沒乘槓桿);不完整 = null(最大回撤算不出來)
function mpsSeriesOf(prop) {
  const pr = prop && prop.port_returns, r = pr && typeof pr === "object" ? pr.r : null;
  if (!Array.isArray(r) || r.length < 2) return null;
  return r.every((x) => typeof x === "number" && isFinite(x)) ? r : null;
}
// 槓桿 L 下逐日複利的最大回撤(%):不用「1× 回撤 × L」線性估;某天淨值歸零以下 = 100(爆倉)
function mpsMddAt(L, series) {
  let eq = 1, pk = 1, dd = 0;
  for (let i = 0; i < series.length; i++) {
    eq *= 1 + L * series[i];
    if (eq <= 0) return 100;
    if (eq > pk) pk = eq; else if (1 - eq / pk > dd) dd = 1 - eq / pk;
  }
  return dd * 100;
}
// 反推:最大回撤 = target 的槓桿(二分;回撤隨槓桿單調變深)。到上限都達不到、或序列沒有回撤 → null
function mpsSolveLev(target, series) {
  if (!(target > 0) || !series || !(mpsMddAt(1, series) > 0)) return null;
  let hi = 1;
  while (mpsMddAt(hi, series) < target) { hi *= 2; if (hi > MPS_SOLVE_LEV_MAX) return null; }
  let lo = 0;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (mpsMddAt(mid, series) < target) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
function mpsHistVolOf(prop) {
  const p = prop || {}, v = typeof p.ann_vol_pct === "number" ? p.ann_vol_pct : typeof p.ann_volatility_pct === "number" ? p.ann_volatility_pct : null;
  return typeof v === "number" && isFinite(v) && v > 0 ? v : null;
}
/* 部位大小的隱含槓桿(同網頁 mpsLevOf):目標波動 = 目標 ÷ 歷史波動;最大回撤 = 反推;固定槓桿 = 本身。
   target null = 預設(目標波動 = 歷史波動、回撤 = 1× 時的回撤、槓桿 = 1)。選不了最大回撤(沒序列)時退回目標波動 */
function mpsMethodOf(s, series) { return s.method === "mdd" && !series ? "vol" : s.method; }
function mpsTargetOf(s, m, prop) {
  if (s.target[m] !== null) return s.target[m];
  if (m === "vol") return mpsHistVolOf(prop);
  if (m === "lev") return 1;
  const r = mpsSeriesOf(prop); return r ? Math.round(mpsMddAt(1, r) * 10) / 10 || null : null;
}
function mpsLevFor(s, prop) {
  const series = mpsSeriesOf(prop), m = mpsMethodOf(s, series), tg = mpsTargetOf(s, m, prop);
  if (tg === null) return null;
  if (m === "lev") return tg;
  if (m === "vol") { const h = mpsHistVolOf(prop); return h === null ? null : tg / h; }
  return mpsSolveLev(tg, series);
}
/* 部位大小設定鈕的摘要(同網頁:「投入金額 · 方法」,三種方法同一個格式,鈕上不寫槓桿倍數):
   fund 帶千分位與幣別;目標去掉多餘的 0(30% / 12.5% / 1.5×)。fund 或目標算不出來那一段寫「—」 */
function mpsChipParts(fund, ccy, m, target) {
  const f = typeof fund === "number" && isFinite(fund) ? Math.round(fund).toLocaleString("en-US") : null;
  const v = typeof target === "number" && isFinite(target) ? (m === "lev" ? String(Math.round(target * 100) / 100) + "×" : String(Math.round(target * 10) / 10) + "%") : null;
  return { fund: f, ccy: f === null ? null : ccy || null, target: v };   // 算不出來的那段整段不寫(同網頁 a8239131)
}
// random_benchmark → 各指標「贏過」的顯示字(取整);欄位不在(舊 workspace)= null、那格不畫
// 兩位小數、負號用 U+2212;先取整再判正負,-0.004 寫 0.00 不寫 −0.00
function mgSharpeText(x) {
  if (typeof x !== "number" || !isFinite(x)) return null;
  const v = Number(x.toFixed(2));
  return (v < 0 ? "\u2212" : "") + Math.abs(v).toFixed(2);
}
// 報酬／回撤的百分比:同樣先取到兩位再判正負與上色,0.004 寫 0.00%、不帶 + / −、不上色。回 { s: 顯示字, v: 取整後的值 },壞值 null
function mgPctText(x) {
  if (typeof x !== "number" || !isFinite(x)) return null;
  const v = Number(x.toFixed(2));
  return { s: (v > 0 ? "+" : v < 0 ? "\u2212" : "") + Math.abs(v).toFixed(2) + "%", v };
}
function mgBeatsOf(rb) {
  const f = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v) + "%" : null);
  return { ret: f(rb && rb.managed_beats_pct_total_return), sharpe: f(rb && rb.managed_beats_pct_sharpe), mdd: f(rb && rb.managed_beats_pct_max_drawdown) };
}
/* 台指期進位造成的超配(同表底「不足一口」的反向):口數照對帳器 half-up 不改,只在整份組合因取整多出來的部分
   (進位的加、捨去的扣)超過計畫總部位 eff 的 MG_LOTS_OVER_WARN 時,回進位的那幾支;pct = 那一支自己比配置多幾 %(0.7 口 → 1 口 = 43)。
   分母用 eff(投入資金 × 槓桿)不用投入資金:槓桿 > 1 時合計本來就大於投入資金,不是進位造成的。
   rows = mpsRows().rows;toF(台幣) = 折成投入資金的幣別,換不了 null。缺報價／缺匯率／沒有計畫 = 不判、回 [] */
function mgLotsOver(rows, eff, toF) {
  if (!(typeof eff === "number" && eff > 0)) return [];
  let net = 0; const up = [];
  for (const r of rows) {
    if (!r.spec || !(r.money > 0)) continue;
    if (r.lots === null || !(r.moneyTwd > 0) || !(r.perLot > 0)) return [];
    const raw = r.moneyTwd / r.perLot;
    net += r.lots * r.perLot - r.moneyTwd;
    if (r.lots > raw) up.push({ name: r.name, lots: r.lots, pct: Math.round((r.lots / raw - 1) * 100) });
  }
  const f = up.length ? toF(net) : null;
  return f !== null && f / eff > MG_LOTS_OVER_WARN ? up : [];
}
/* ── 純邏輯到此 ─────────────────────────────────────────────── */

/* ── 頁面殼:開／關、分頁、霧 ───────────────────────────────── */
const PO_TABS = ["cfg", "opt"];
async function poOpen(tab, focus) {
  const S = TR;
  if (S.env === "local") await stratSelect(null); else if (typeof rpCloudSelect === "function") await rpCloudSelect(null);
  if (typeof libLeave === "function") libLeave(S.env);
  if (typeof rptLeave === "function") rptLeave(S.env);
  S.open = true; S.view = "po";
  if (tab) S.poTab = tab;
  if (S !== TR_BAGS[ENV.cur]) return;   // 等的時候切走了:只記下這一邊是開著的
  S.sig = {}; ENV.sig.tb = null;
  envShowMain();
  trackFeature("portfolio_open");
  trPaint();
  if (focus) $("po-h").focus();
  trPollSoon(0);
}
/* 策略頁首「加到策略組合」(spec tw-holdings-a1 §1-1、F1;handoff.js hoPaint 畫在「送上雲端」右邊):回測過的 Type A／C 才有(同選擇策略的清單)。
   已在組合裡(已存或草稿)換描邊「到策略組合」,只是跳過去。兩個視角一樣 */
function poAddBtn(cloud) {
  const S = TR_BAGS[cloud ? "cloud" : "local"], B = cloud ? RPC : RP;
  // 回測過 = 這一頁讀到 stats(策略清單只在開過策略組合／自動下單後才載入,不能靠它判;同 rpTab)
  if (!B || !B.name || !B.data || B.data.pending || !B.data.stats || (typeof xpIsTypeB === "function" && xpIsTypeB(B.data))) return null;
  const name = B.name, inPo = trWith(S, () => trNames().indexOf(name) >= 0);
  const b = document.createElement("button"); b.type = "button"; b.id = "rp-po"; b.className = inPo ? "btn-out" : "btn-fill";
  b.textContent = t(inPo ? "po.addGo" : "po.add");
  b.addEventListener("click", () => poAdd(S, name, inPo));
  return b;
}
/* 按「加到策略組合」:只建草稿(同選擇策略框按確定,psApply)——這支勾進表、金額空著、游標在金額格,**不送任何指令寫設定**;
   不存就離開 = 組合沒變。唯一副作用:這支沒有最新那一根的預覽就請機器背景重算(stats_refresh,F2;同碼不定版),儲存框要它換算股數。
   選擇策略框會鎖住的(模擬交易的台股、只下台指期的券商、機器 lib 太舊的投資組合)不偷渡:跳過去打開選擇策略框,原因在那一列 */
// 策略頁開著時,鈕的樣子跟著清單載入／存進組合換(trPoll 每輪叫;只有變了才重畫頁首那一排)
let PO_ADD_SIG = null;
function poAddSync() {
  if ($("rp").hidden) { PO_ADD_SIG = null; return; }
  const cloud = ENV.cur === "cloud", S = TR_BAGS[cloud ? "cloud" : "local"], B = cloud ? RPC : RP;
  const sig = JSON.stringify([cloud, B && B.name, S.listLoaded, B && B.name ? trWith(S, () => trNames().indexOf(B.name) >= 0) : null]);
  if (sig === PO_ADD_SIG) return;
  const first = PO_ADD_SIG === null; PO_ADD_SIG = sig;
  if (!first && typeof hoPaint === "function") hoPaint();
}
async function poAdd(S, name, inPo) {
  if (S !== TR_BAGS[ENV.cur]) return;
  trackFeature(inPo ? "po_add_go" : "po_add");
  // 這台電腦的清單只在開過策略組合後才載入:建草稿前先讀一次(鎖不鎖、標的與幣別都看它)
  if (!S.listLoaded && S.env === "local") { try { await trLoadStrategies(S); S.listLoaded = true; } catch (_) { } }
  if (S !== TR_BAGS[ENV.cur]) return;
  let locked = false;
  if (!inPo) trWith(S, () => {
    if (trPickOff()) return;
    const r = trReport() || {}, names = trNames();
    const row = trPickRows(S.list, names, r.can_trade_portfolio === true, trVenueId() === PAPER && !trPaperTwOk(), trTwBroker(trVenueId()), {}).find((y) => y.name === name);
    if (!row || row.locked) { locked = true; return; }
    const sel = new Set(names); sel.add(name);
    S.picked = trSetEq(sel, trNamesOf(null)) ? null : sel;
    if (S.save === "saved") { clearTimeout(S.saveTimer); S.save = null; }
    (S.a1 = S.a1 || new Set()).add(name);   // 存成功時記 po_add_saved
    if (S.raw && S.edits[name] == null) S.raw[name] = "";   // 金額空著(§1-2):等用戶填,存成 0 也照框走
    if (S.flash) S.flash[name] = Date.now();
    const pv = trPvOf(r, name);
    if (trPvHost(r) && !(pv && pv.latest)) trPvRequest(S, name);
  });
  await poOpen("cfg");
  if (TR !== S || S.view !== "po") return;
  S.sig.cfg = null; poPaintCfg();
  if (locked) { const pk = $("tr-pick"); if (pk && !pk.disabled) { psOpen(pk); return; } }
  const inp = [...$("po-cfg").querySelectorAll(".amt-in")].find((y) => y.dataset.amt === name);
  if (inp && !inp.disabled && inp.offsetParent) inp.focus(); else $("po-h").focus();
}
function poSetTab(tab, focus) {
  if (PO_TABS.indexOf(tab) < 0) return;
  TR.poTab = tab; TR.sig.cfg = null; TR.sig.opt = null;
  if (typeof ctMenuClose === "function") ctMenuClose(false);
  poPaint();
  if (focus) $("po-tab-" + tab).focus();
}
function poWire() {
  $("po-tabs").addEventListener("click", (e) => { const b = e.target.closest(".main-tab"); if (b) poSetTab(b.dataset.tab); });
  $("po-tabs").addEventListener("keydown", (e) => {
    const i = PO_TABS.indexOf(TR.poTab), j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? PO_TABS.length - 1 : -1;
    if (j < 0 || j >= PO_TABS.length || j === i) return;
    e.preventDefault(); poSetTab(PO_TABS[j], true);
  });
  mgWire();
  window.addEventListener("resize", () => { const m = TR.mg; if (m && TR.view === "po" && TR.poTab === "opt") { m.chartSig = null; mgDrawChart(); } });
}
// trade.js trPaint 在 TR.view === "po" 時叫:分頁列等報告到了才出(載入態沒有分頁可看);兩個分頁各自畫
function poPaint() {
  if (!PO.wired) { PO.wired = true; poWire(); }
  // 頁首常駐「自動下單中・模擬／真錢」:存金額會送單的時候(同存金額框的判準 trCfFiring;spec F4)
  const lv = $("po-live"), fire = trCfFiring(TR.st, TR.pending) && trHasAccount(trReport());
  lv.hidden = !fire;
  if (fire) { const paper = trIsPaper(); lv.className = "mode " + (paper ? "paper" : "real"); lv.textContent = t("po.live", { mode: t(paper ? "tr.mode.paper" : "tr.mode.real") }); }
  if (!TR.poTab) TR.poTab = "cfg";
  const loaded = !!trReport() && TR.listLoaded;
  $("po-tabs").hidden = !loaded;
  $("po-tabs").querySelectorAll(".main-tab").forEach((b) => {
    const on = b.dataset.tab === TR.poTab; b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex = on ? 0 : -1;
  });
  const opt = loaded && TR.poTab === "opt";
  $("po-cfg").hidden = opt; $("po-opt").hidden = !opt;
  if (opt) mgPaint(); else poPaintCfg();
}
const PO = { wired: false };

/* Setup fog(canon › Components › Setup fog):示意底用真元件、固定泛稱資料(不讀用戶的任何東西),模糊後蓋遮罩,上面一張 CTA 卡。
   kind:"pick"(一支都沒選;沒有可選的策略也走這個,出路寫在選擇框的空狀態 tr.pick.empty,同網頁 pfPickEmpty)/"connect"(自動下單沒連交易所)/
   "pos-pick"／"pos-new"／"pos-draft"(自動下單 › 部位還沒選策略／沒有能勾的／勾了還沒存;spec-autotrade-empty §2、§4)。卡上那句的 id 是停用的啟動下單的 aria-describedby */
function poFog(kind) {
  const fog = trEl("div", "fog"), under = trEl("div", "fog-under pf"), pos = kind === "pos-pick" || kind === "pos-new" || kind === "pos-draft";
  under.setAttribute("aria-hidden", "true"); under.inert = true;
  if (kind === "opt") fog.classList.add("mg-fog");
  if (kind === "connect") under.appendChild(poFogOver()); else if (pos) under.appendChild(poFogPos()); else if (kind === "opt") under.appendChild(poFogOpt()); else under.appendChild(poFogCfg());
  const card = trEl("div", "fog-card");
  const msg = card.appendChild(trEl("p", "", kind === "opt" ? t("mg.fogOpt", { n: mgMembers().length }) : t(kind === "pick" ? "po.fogPick" : kind === "pos-pick" ? "tr.fogPosPick" : kind === "pos-new" ? "tr.fogPosNew" : kind === "pos-draft" ? "tr.startOffDraft" : TR.env === "cloud" ? "tr.cloud.fogConnect" : "tr.fogConnect")));
  if (pos) msg.id = "tr-pos-fog-msg";
  const b = trEl("button", "btn-fill", t(kind === "opt" ? "mg.optRun" : kind === "pick" || kind === "pos-pick" ? "tr.pick" : kind === "pos-new" ? "ns.chip" : kind === "pos-draft" ? "po.goAmounts" : "cx.connect")); b.type = "button";
  if (kind === "pick") { b.id = "tr-pick"; b.dataset.fk = "pick"; b.disabled = trPickOff(); b.addEventListener("click", () => psOpen(b)); }
  // 部位霧只在選擇策略框開得了時才出(trZNow 的 wait 含 trPickOff),停用在這裡只是保險,不會有停用而沒有原因的卡
  else if (kind === "opt") { b.id = "mg-fog-opt"; b.dataset.fk = "mg-fog-opt"; b.addEventListener("click", mgRunOptimize); }
  else if (kind === "pos-pick") { b.id = "tr-pos-pick"; b.dataset.fk = "pos-pick"; b.disabled = trPickOff(); b.addEventListener("click", () => { trackFeature("trade_fog_pick"); trZGo("pick", b); }); }
  else if (kind === "pos-new") { b.id = "tr-pos-new"; b.dataset.fk = "pos-new"; b.addEventListener("click", () => { trackFeature("trade_fog_new"); trZGo("noStrat", b); }); }
  else if (kind === "pos-draft") { b.id = "tr-pos-draft"; b.dataset.fk = "pos-draft"; b.addEventListener("click", () => { trackFeature("trade_fog_pick"); trZGo("draft", b); }); }
  else { b.id = "tr-connect"; b.addEventListener("click", () => cxModalOpen(b)); }
  card.appendChild(b);
  fog.append(under, card);
  return fog;
}
// 示意底(策略組合):策略 A／B／C 的金額表與部位表,數字取整、寫死
function poFogCfg() {
  const f = document.createDocumentFragment();
  f.appendChild(trSec(trEl("span", "label", t("po.secAmounts"))));
  const tbl = trEl("table", "pf-tbl zoned");
  tbl.appendChild(trHead([[t("tr.col.strategy"), ""], [t("tr.col.symbol"), "c-sym"], [t("tr.col.amount"), "n", "USDT"], [t("tr.col.pos"), "n", "USDT"]]));
  const tb = document.createElement("tbody");
  [["A", "BTCUSDT", 10000, 1], ["B", "ETHUSDT", 6000, -0.5], ["C", "SOLUSDT", 4000, 0]].forEach((x) => {
    const r = document.createElement("tr"), k = trEl("td", "key", t("po.fogStrat", { x: x[0] }));
    k.appendChild(trEl("span", "mkt-tag", t("tr.mkt.swap")));
    const a = trEl("td", "n"); a.appendChild(trEl("span", "amt-in fog-amt", trFmt(x[2])));
    const ps = trEl("td"); trPaintPosCell(ps, x[2], x[3], null, {});
    r.append(k, trEl("td", "sym c-sym", x[1]), a, ps); tb.appendChild(r);
  });
  tbl.appendChild(tb); f.appendChild(tbl);
  const tot = trEl("div", "pf-total"); tot.append(trEl("span", "", t("tr.total")), trEl("span", "n", "20,000")); f.appendChild(tot);
  f.appendChild(trSec(trEl("span", "label", t("po.sigTargets"))));
  const t2 = trEl("table", "pf-tbl zoned"); t2.appendChild(trHead([[t("tr.col.symbol"), ""], [t("tr.col.target"), "n", "USDT"]]));
  const tb2 = document.createElement("tbody");
  [["BTCUSDT", "+10,000", "buy"], ["ETHUSDT", "−3,000", "sell"], ["SOLUSDT", "0", "na"]].forEach((x) => { const r = document.createElement("tr"); r.append(trEl("td", "sym", x[0]), trEl("td", "n " + x[2], x[1])); tb2.appendChild(r); });
  t2.appendChild(tb2); f.appendChild(t2);
  return f;
}
// 示意底(策略組合 › 優化):權重分配表＋移動窗格回測的一條有回撤的線,數字寫死
function poFogOpt() {
  const f = document.createDocumentFragment();
  f.appendChild(trSec(trEl("span", "label", t("mg.secAmounts"))));
  const tbl = trEl("table", "pf-tbl zoned mg-tbl");
  tbl.appendChild(trHead([[t("tr.col.strategy"), ""], [t("mg.colWeight"), "n"], [t("tr.col.amount"), "n", "USDT"]]));
  const tb = document.createElement("tbody");
  [["A", "50%", "10,000"], ["B", "30%", "6,000"], ["C", "20%", "4,000"]].forEach((x) => { const r = document.createElement("tr"); r.append(trEl("td", "key", t("po.fogStrat", { x: x[0] })), trEl("td", "n", x[1]), trEl("td", "n", x[2])); tb.appendChild(r); });
  tbl.appendChild(tb); f.appendChild(tbl);
  f.appendChild(trSec(trEl("span", "label", t("mg.secBt"))));
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"), pl = document.createElementNS(NS, "polyline");
  svg.setAttribute("viewBox", "0 0 600 180"); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("class", "fog-curve");
  pl.setAttribute("fill", "none"); pl.setAttribute("stroke", "currentColor"); pl.setAttribute("stroke-width", "2");
  pl.setAttribute("points", "0,120 30,112 60,124 90,100 120,96 150,118 180,132 210,126 240,104 270,110 300,92 330,98 360,120 390,102 420,88 450,96 480,84 510,100 540,90 570,78 600,86");
  svg.appendChild(pl); f.appendChild(svg);
  return f;
}
// 示意底(自動下單 › 部位):區段標題＋標的｜目標｜帳上｜差額＋合計,數字寫死、不上紅綠(示意底不放大塊亮色)
function poFogPos() {
  const f = document.createDocumentFragment();
  f.appendChild(trSec(trEl("span", "label", t("po.nav"))));
  const tbl = trEl("table", "pf-tbl zoned pf-sig");
  tbl.appendChild(trHead([[t("tr.col.symbol"), ""], [t("tr.col.target"), "n", "USDT"], [t("tr.col.held"), "n"], [t("tr.col.diff"), "n"]]));
  const tb = document.createElement("tbody");
  [["A", "BTCUSDT", "10,000", "+10,000", "0", "+10,000"], ["B", "ETHUSDT", "6,000", "−3,000", "−1,000", "−2,000"], ["C", "SOLUSDT", "4,000", "0", "0", "0"]].forEach((x) => {
    const r = document.createElement("tr"), k = trEl("td", "sym", x[1]);
    k.appendChild(trEl("span", "mkt-tag", t("po.fogStrat", { x: x[0] }) + " · " + x[2]));
    r.append(k, trEl("td", "n", x[3]), trEl("td", "n", x[4]), trEl("td", "n", x[5])); tb.appendChild(r);
  });
  tbl.appendChild(tb); f.appendChild(tbl);
  const tot = trEl("div", "pf-total"); tot.append(trEl("span", "", t("tr.total")), trEl("span", "n", "13,000")); f.appendChild(tot);
  return f;
}
// 示意底(自動下單 › 總覽):四格、一條有回撤的曲線、三列事件
function poFogOver() {
  const f = document.createDocumentFragment(), tabs = trEl("div", "fog-tabs");
  ["tr.tab.over", "tr.tab.pos", "tr.tab.assets", "tr.tab.hist", "tr.tab.set"].forEach((k, i) => tabs.appendChild(trEl("span", "fog-tab" + (i ? "" : " on"), t(k))));
  f.appendChild(tabs);
  const st = trEl("div", "fog-stats");
  [["20,000"], ["+120"], ["−340"], ["−6.2%"]].forEach((x) => { const c = trEl("div", "fog-stat"); c.append(trEl("span", "fog-bar"), trEl("span", "fog-num", x[0])); st.appendChild(c); });
  f.appendChild(st);
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"), pl = document.createElementNS(NS, "polyline");
  svg.setAttribute("viewBox", "0 0 600 180"); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("class", "fog-curve");
  pl.setAttribute("fill", "none"); pl.setAttribute("stroke", "currentColor"); pl.setAttribute("stroke-width", "2");
  pl.setAttribute("points", "0,110 30,104 60,118 90,96 120,108 150,128 180,120 210,136 240,116 270,102 300,112 330,90 360,100 390,84 420,104 450,94 480,80 510,92 540,76 570,86 600,72");
  svg.appendChild(pl); f.appendChild(svg);
  [["14:00", "BTCUSDT +0.02"], ["13:00", "ETHUSDT −0.4"], ["12:00", "×1.00"]].forEach((x) => { const r = trEl("div", "fog-ev"); r.append(trEl("span", "mono", x[0]), trEl("span", "", x[1])); f.appendChild(r); });
  return f;
}
// 把一句話填進本機聊天輸入框、展開聊天欄、焦點放進去;**不送出**(同 trErrAsk)
function poAskAgent(text) {
  const ta = $("ta");
  if (typeof paneSt !== "undefined" && paneSt.chat.off) paneToggle("chat", false);
  ta.value = ta.value.trim() ? ta.value.replace(/\s+$/, "") + "\n" + text : text;
  autosize(); ta.focus();
}

/* ── 台指期合約下拉(canon › Dropdown menu:安靜觸發器 + Panel + Trailing value;同網頁 ctTrigger / ctMenu)──
   面板單例掛 body、position:fixed:表在 .pf-scroll 裡,absolute 會被裁掉。tab = "cfg" | "opt";lotsFor(root) = 選單每一項後面寫的口數 */
const CT_ORDER = ["TXF", "MXF", "TMF"];
let ctMenu = null, ctOpen = null;
function ctTrigger(tab, n, root, onPick, lotsFor) {
  const sp = TR_TXF_SPECS[root], prod = t(sp.prod), b = trEl("button", "ct-trig");
  b.type = "button"; b.dataset.ctTab = tab; b.dataset.ct = n; b.dataset.fk = "ct:" + tab + ":" + n;
  b.setAttribute("aria-label", t("ct.aria", { prod })); b.setAttribute("aria-haspopup", "menu"); b.setAttribute("aria-expanded", "false");
  b.appendChild(trEl("span", "", prod));
  const cv = trEl("span", "ct-cv"); cv.setAttribute("aria-hidden", "true"); b.appendChild(cv);
  b._ct = { root, lotsFor, onPick };
  b.addEventListener("click", () => { if (ctOpen && ctOpen.trig === b) ctMenuClose(true); else ctMenuOpen(b); });
  // 輪詢重建整張表時選單開著:等新觸發器進了畫面再接上去
  if (ctOpen && ctOpen.tab === tab && ctOpen.name === n) requestAnimationFrame(ctReattach);
  return b;
}
function ctVisibleTrig(tab, n) { return [...document.querySelectorAll(".ct-trig")].find((x) => x.dataset.ctTab === tab && x.dataset.ct === n && !x.disabled && x.getClientRects().length > 0) || null; }
function ctFocus(tab, n) { const x = ctVisibleTrig(tab, n); if (x) x.focus(); }
function ctMenuBuild() {
  ctMenu = trEl("div", "ct-menu"); ctMenu.setAttribute("role", "menu"); ctMenu.hidden = true;
  ctMenu.addEventListener("keydown", (e) => {
    const items = [...ctMenu.querySelectorAll(".ct-mi")], i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); ctMenuClose(true); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus(); }
    else if (e.key === "Home" || e.key === "End") { e.preventDefault(); items[e.key === "Home" ? 0 : items.length - 1].focus(); }
    else if (e.key === "Tab") ctMenuClose(false);
  });
  document.addEventListener("pointerdown", (e) => { if (ctOpen && !ctMenu.contains(e.target) && !ctOpen.trig.contains(e.target)) ctMenuClose(false); }, true);
  // fixed 面板不跟著捲:任何捲動或改視窗大小就收
  document.addEventListener("scroll", (e) => { if (ctOpen && !ctMenu.contains(e.target)) ctMenuClose(false); }, true);
  window.addEventListener("resize", () => { if (ctOpen) ctMenuClose(false); });
  document.body.appendChild(ctMenu);
}
function ctMenuFill() {
  ctMenu.textContent = "";
  ctMenu.setAttribute("aria-label", t("ct.aria", { prod: t(TR_TXF_SPECS[ctOpen.cur].prod) }));
  CT_ORDER.forEach((root) => {
    const it = trEl("button", "ct-mi"); it.type = "button"; it.tabIndex = -1; it.setAttribute("role", "menuitemradio");
    it.setAttribute("aria-checked", root === ctOpen.cur ? "true" : "false");
    it.appendChild(trEl("span", "", t(TR_TXF_SPECS[root].prod)));
    const lots = ctOpen.lotsFor(root), v = trEl("span", "ct-mv");
    if (lots == null) v.textContent = "—"; else trLotsInto(v, lots, false);
    it.appendChild(v);
    it.addEventListener("click", () => { const o = ctOpen; ctMenuClose(false); if (o && root !== o.cur) o.onPick(root); else if (o) ctFocus(o.tab, o.name); });
    ctMenu.appendChild(it);
  });
}
function ctMenuPlace() {
  const r = ctOpen.trig.getBoundingClientRect(), gap = 8, pw = ctMenu.offsetWidth, ph = ctMenu.offsetHeight;
  let top = r.bottom + gap;
  if (top + ph > window.innerHeight - gap && r.top - gap - ph > gap) top = r.top - gap - ph;
  ctMenu.style.left = Math.round(Math.max(gap, Math.min(r.left, window.innerWidth - gap - pw))) + "px";
  ctMenu.style.top = Math.round(top) + "px";
}
function ctMenuOpen(trig) {
  if (!ctMenu) ctMenuBuild();
  if (ctOpen) ctMenuClose(false);
  ctOpen = { tab: trig.dataset.ctTab, name: trig.dataset.ct, trig, cur: trig._ct.root, lotsFor: trig._ct.lotsFor, onPick: trig._ct.onPick };
  trig.setAttribute("aria-expanded", "true");
  ctMenuFill(); ctMenu.hidden = false; ctMenuPlace();
  const on = ctMenu.querySelector('[aria-checked="true"]') || ctMenu.querySelector(".ct-mi"); if (on) on.focus();
}
function ctReattach() {
  if (!ctOpen || document.body.contains(ctOpen.trig)) return;
  const x = ctVisibleTrig(ctOpen.tab, ctOpen.name);
  if (!x || !x._ct) { ctMenuClose(false); return; }
  const keep = ctMenu.contains(document.activeElement);
  Object.assign(ctOpen, { trig: x, cur: x._ct.root, lotsFor: x._ct.lotsFor, onPick: x._ct.onPick });
  x.setAttribute("aria-expanded", "true"); ctMenuFill(); ctMenuPlace();
  if (keep) { const on = ctMenu.querySelector('[aria-checked="true"]'); if (on) on.focus(); }
}
function ctMenuClose(refocus) {
  if (!ctOpen) return;
  const o = ctOpen; ctOpen = null; ctMenu.hidden = true; o.trig.setAttribute("aria-expanded", "false");
  if (refocus) { if (document.body.contains(o.trig)) o.trig.focus(); else ctFocus(o.tab, o.name); }
}

/* ── 優化分頁 ─────────────────────────────────────────────
   一袋一份(TR.mg):成員清單、方法與參數、部位大小設定、在途旗標。成員清單與部位大小:這台電腦存 localStorage
   (重開還在、不寫機器設定、對帳器碰不到)。雲端那一袋的成員清單不落地(同 app.js 雲端袋的規則);部位大小是用戶設的偏好,
   重開要還在(Wei 10-16):存 ui-prefs.json、綁這次登入(主行程比對 who,換人讀不到上一個人的) */
const MG_SEL_KEY = "ws_mg_members", MG_SIZE_KEY = "ws_mg_sizing";
function mgBag(S) {
  const B = S || TR;
  if (!B.mg) {
    let sel = null, sizing = mpsSizingClean(null);
    if (B.env === "local") {
      try { const v = JSON.parse(localStorage.getItem(MG_SEL_KEY) || "null"); if (Array.isArray(v)) sel = v.filter((n) => typeof n === "string" && n); } catch (_) { sel = null; }   // 讀不到就照配置那組
      try { sizing = mpsSizingClean(JSON.parse(localStorage.getItem(MG_SIZE_KEY) || "null")); } catch (_) { sizing = mpsSizingClean(null); }
    }
    B.mg = { inited: false, alloc: null, params: null, err: null, shortDays: null, shortDismissed: false, optBusy: false,
      btSending: false, btSentAt: 0, btAskedAt: 0, sel, dropped: null, sizing, sizingSet: false, ctEdits: {}, chartSig: null, refreshing: { opt: false, bt: false }, wait: { opt: null, bt: null } };
    if (B.env === "cloud") mgSizingCloudLoad(B);
  }
  return B.mg;
}
// 讀回來之前用戶已經在這一袋設過(sizingSet)就不蓋;換人(trCloudOwnerCheck 清掉 C.mg)後回來的那份丟掉
function mgSizingCloudLoad(B) {
  const G = B.mg, api = typeof window !== "undefined" && window.blave && window.blave.mgSizingCloud;
  if (!api) return;
  Promise.resolve().then(() => api()).then((v) => {
    if (B.mg !== G || G.sizingSet || !v) return;
    G.sizing = mpsSizingClean(v);
    if (TR === B) { B.sig.opt = null; mgPaint(); }
  }, () => {});
}
function mgSave(S, key, v) {
  if ((S || TR).env !== "local") {
    if (key === MG_SIZE_KEY && typeof window !== "undefined" && window.blave && window.blave.mgSizingCloudSet) window.blave.mgSizingCloudSet(v).catch(() => {});
    return;
  }
  try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) { return; }   // 存不了就只記在這一頁
}
function mgManager() { const m = (trReport() || {}).manager; return m && typeof m === "object" ? m : null; }
// 機器 workspace 落後、跑不動策略管理(can_manage false;舊 runtime 連 manager 區塊都沒有)
function mgBlocked() { const m = mgManager(); return !m || m.can_manage === false; }
function mgStrategies() { const m = mgManager(); return (m && Array.isArray(m.strategies) ? m.strategies : []).filter((s) => s && typeof s.name === "string" && s.name); }
function mgAllocators() { const m = mgManager(); return (m && Array.isArray(m.allocators) ? m.allocators : []).filter((a) => a && typeof a.name === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(a.name)); }
// 舊世界唯一的內建是 slope(吃 --lookback):機器沒回報內建方法時替它宣告那一格
function mgReportedBuiltins() {
  const m = mgManager(), list = m && Array.isArray(m.builtin_methods) ? m.builtin_methods.filter((b) => b && typeof b.name === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(b.name)) : null;
  return list && list.length ? list : null;
}
function mgBuiltins() { return mgReportedBuiltins() || [{ name: MG_SLOPE, params: { lookback: MG_LOOKBACK_DEFAULT } }]; }
function mgMethod(name) { return mgBuiltins().find((b) => b.name === name) || mgAllocators().find((a) => a.name === name) || null; }
function mgDefaultAlloc() { const list = mgBuiltins(), m = mgManager(), d = m && typeof m.default_method === "string" ? m.default_method : null; return list.some((b) => b.name === d) ? d : list[0].name; }
function mgWireAlloc(name) { return name === MG_SLOPE && !mgReportedBuiltins() ? null : name; }   // 腳本還沒更新時,內建只能用「省略旗標」表達
function mgAllocLabel(name) {
  if (name === MG_EQUAL) return t("mg.equal");
  if (name === MG_SLOPE) return t("mg.slope");
  if (name === MG_SHARPE) return t("mg.sharpe");
  const a = mgMethod(name); return a && typeof a.display_name === "string" && a.display_name ? a.display_name : name;
}
// 第一份帶 manager 的報告進來時定方法與參數的初值:機器上留檔的回測 job > 提案 > 現行 config > 預設
function mgInit(G) {
  const m = mgManager(), cfg = (trReport() || {}).config || {}, job = m.backtest_job && typeof m.backtest_job === "object" ? m.backtest_job : null;
  const src = job && (job.status === "running" || job.status === "done") ? job : m.proposal && typeof m.proposal === "object" ? m.proposal : null;
  G.inited = true;
  G.alloc = src ? mgNormAlloc(src.allocator) : "allocator" in cfg ? mgNormAlloc(cfg.allocator) : mgDefaultAlloc();
  G.params = mgDefaultParams(mgMethod(G.alloc));
  const sp = src && src.params && typeof src.params === "object" ? src.params : null;
  if (sp) Object.keys(G.params).forEach((k) => { if (k in sp && typeof sp[k] === typeof G.params[k] && mgParamOk(sp[k]) && mgParamInRange(k, sp[k])) G.params[k] = sp[k]; });
}
function mgPrune(G) { if (!mgMethod(G.alloc)) G.alloc = mgDefaultAlloc(); G.params = mgFitParams(mgMethod(G.alloc), G.params); }
// 成員 = 優化分頁自己的清單(Wei 10-13:跟配置分頁不互相牽動);第一次進來照配置已存的那一組定下來
function mgMembers() {
  const G = mgBag();
  if (G.sel === null) { const st = trStored(); if (st && !trCfgUnread(trReport())) { G.sel = Object.keys(st); mgSave(TR, MG_SEL_KEY, G.sel); } }
  // 已經不存在的策略(刪掉、換了 workspace、localStorage 留下的)剔掉:不然「策略 N 檔」算到幽靈、跑優化回 member has no backtest stats(Windows e2e 10-14)
  const all = (G.sel || Object.keys(trStored() || {})).slice().sort();
  if (!TR.listLoaded || !Array.isArray(TR.list)) return all;
  const live = all.filter((n) => TR.list.some((x) => x.name === n));
  if (G.sel && live.length !== G.sel.length) { G.sel = live.slice(); mgSave(TR, MG_SEL_KEY, G.sel); }
  return live;
}
function mgSetMembers(S, names) {
  const G = mgBag(S); G.sel = names.slice(); mgSave(S, MG_SEL_KEY, G.sel);
  // 勾掉全部 = 回到還沒跑過優化的那一屏:那一刻機器上的提案與回測記下簽名,勾回同一組時不沿用,跑成功才解除
  const m = mgManager();
  if (m && !names.length) G.dropped = { prop: mgSig(m.proposal), job: mgSig(mgJobAny()) };
  G.err = null; G.shortDays = null; G.shortDismissed = false;
  if (S === TR) { mgPaint(); const b = $("po-opt").querySelector('[data-mg-open="strat"]'); if (b) b.focus(); }
}
function mgSig(o) { return o && typeof o === "object" ? JSON.stringify(o) : null; }
function mgNotDropped(kind, o) { const G = mgBag(); return !(G.dropped && G.dropped[kind] !== null && G.dropped[kind] === mgSig(o)); }
// 套用金額只在兩邊的策略是同一組時可以按:建議只算優化清單裡的,集合不同時套用會漏改或多改
function mgSameAsAmounts() { const a = mgMembers(), b = trNames().slice().sort(); return a.length === b.length && a.every((n, i) => n === b[i]); }
function mgArgs() {
  const G = mgBag(), params = Object.assign({}, G.params);
  // 舊 runtime(1.1.46 以前)硬性要求 params 同時有 lookback 與 target_vol:只在這條相容分支背後默默補(同網頁 mgArgs)
  if (!mgReportedBuiltins()) {
    if (typeof params.lookback !== "number") params.lookback = MG_LOOKBACK_DEFAULT;
    const pct = ((trReport() || {}).config || {}).target_vol_pct;
    params.target_vol = typeof pct === "number" && mgParamInRange("target_vol", pct / 100) ? pct / 100 : MG_TARGET_VOL_DEFAULT;
  }
  return { members: mgMembers(), allocator: mgWireAlloc(G.alloc), params };
}
function mgProposal() { const m = mgManager(), G = mgBag(); return m && mgSameSel(m.proposal, mgMembers(), G.alloc, G.params) && mgNotDropped("prop", m.proposal) ? m.proposal : null; }
function mgJobAny() { const m = mgManager(); return m && m.backtest_job && typeof m.backtest_job === "object" ? m.backtest_job : null; }
function mgJob() { const j = mgJobAny(), G = mgBag(); return j && mgSameSel(j, mgMembers(), G.alloc, G.params) && mgNotDropped("job", j) ? j : null; }
function mgRunning() { const j = mgJobAny(); return !!j && j.status === "running"; }   // 機器一次只跑一個:任何 running job 都佔住「跑回測」
function mgBacktest() { const m = mgManager(), j = mgJob(); return j && j.status === "done" && m.backtest && typeof m.backtest === "object" ? m.backtest : null; }
function mgParseDay(s) { if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null; const x = Date.parse(s.slice(0, 10) + "T00:00:00Z"); return isNaN(x) ? null : x; }
// 所選成員的日曆跨度上界(聯集歷史不會比它長)——前置檢查只擋確定不夠的
function mgSpanDays() {
  let lo = null, hi = null;
  for (const n of mgMembers()) {
    const s = mgStrategies().find((x) => x.name === n), a = s && mgParseDay(s.first_date), b = s && mgParseDay(s.last_date);
    if (a === null || b === null) return null;
    if (lo === null || a < lo) lo = a; if (hi === null || b > hi) hi = b;
  }
  return lo === null ? null : Math.round((hi - lo) / 86400000) + 1;
}
// 資料不足 = 歷史 ≤ lookback(機器要至少 lookback+1 天);機器裁定(job.error / 優化 ack)優先,再用日曆跨度估。方法沒宣告視窗(等權)不會 exit 3
function mgShort() {
  const G = mgBag(), l = G.params && G.params.lookback;
  if (typeof l !== "number") return null;
  const j = mgJob(), jn = j && j.status === "error" ? mgShortDaysOf(j.error) : null;
  if (jn !== null && jn <= l) return { n: jn, l };
  if (G.shortDays !== null && G.shortDays <= l) return { n: G.shortDays, l };
  const span = mgSpanDays();
  return span !== null && span <= l ? { n: span, l } : null;
}
function mgBtBlockReason() {
  const sh = mgShort();
  if (sh) return t("mg.shortTip", { n: sh.n, l: sh.l });
  const n = mgMembers().length;
  return !n ? t("mg.stratEmpty") : n === 1 ? t("mg.singleTip") : null;
}
// 機器裁定資料不足 → 轉成警示條(N 給「改跑」);只在警示條真的畫得出來時才吞掉錯誤(exit 3 永遠至少看得到一行)
function mgShortFromError(G, e) { const d = mgShortDaysOf(e); if (d === null) return false; G.shortDays = d; G.shortDismissed = false; return !!mgShort(); }
// 回測送出後:報表看到 running、或那次送出的 job 已收尾(finished_at 不早於按下去的時間)、或等太久 → 送出中結束
function mgBtSendingSync(G) {
  if (!G.btSending) return;
  const j = mgJobAny(), finished = !!j && j.status !== "running" && typeof j.finished_at === "number" && G.btAskedAt > 0 && j.finished_at * 1000 >= G.btAskedAt;
  if (finished || (G.btSentAt && (mgRunning() || Date.now() - G.btSentAt > MG_BT_SENT_MAX_MS))) { G.btSending = false; G.btSentAt = 0; G.btAskedAt = 0; }
}

/* 部位大小(Wei 10-13 A 版):權重(怎麼分)是工具列的「方法」;這裡只管總量(放多大)。設定只改頁面上的金額,寫進主機一律走「套用金額」 */
function mpsProp() { return mgProposal(); }
function mpsMembers() { const p = mpsProp() || {}; return Array.isArray(p.members) ? p.members.map(String) : []; }
function mpsWeight(n) { const w = ((mpsProp() || {}).weights || {})[n]; return typeof w === "number" && isFinite(w) && w > 0 ? w : 0; }
// 投入資金與建議金額的幣別:成員只有一區時那一區的幣(台指期區 = TWD);兩區以上或幣別未定 = 顯示幣別
function mpsCcy() {
  const zs = [...new Set(mpsMembers().map((n) => trZoneOf(n)))];
  if (zs.length !== 1 || zs[0] === TR_ZONE_UNKNOWN) return trFxView().base;
  return zs[0] === TR_ZONE_LOTS ? TR_TXF_CCY : zs[0];
}
function mpsConv(v, from, to) { if (v === 0 || from === to) return v; const fx = trFxView().fx, a = trFxRate(fx, from), b = trFxRate(fx, to); return a === null || b === null ? null : (v / a) * b; }
// 投入資金預設 = 目前金額的合計(口數折名目台幣、混幣經匯率折顯示幣別),換成投入資金的幣別;換算不出來才留空
function mpsFundDefault() {
  const tt = trZoneSum((trCtPend() ? trBase() : trStored()) || {}, null, trRowMoneyStored).total;   // 待對上時口數配 ct.sent 的那一份(同 trPlanTotal,稽核 P1-2)
  const v = tt.v === null || !(tt.v > 0) || !tt.ccy ? null : mpsConv(tt.v, tt.ccy, mpsCcy());
  return v === null ? null : Math.round(v);
}
function mpsFundOf(s) { return s.fund !== null ? mpsFundAs(s, mpsCcy(), mpsConv) : mpsFundDefault(); }
// 本金填過、只是換幣別缺匯率:mpsFundOf 同樣回 null,但不能當「沒填」叫人去重填
function mpsFundFxMissing(s) { return s.fund !== null && mpsFundAs(s, mpsCcy(), mpsConv) === null; }
function mpsLev(s) { return mpsLevFor(s, mpsProp()); }
function mgCt(n) { const s = trCtStored(n), G = mgBag(); return s && G.ctEdits[n] ? G.ctEdits[n] : s; }
function mgSpec(n) { const c = mgCt(n); return c ? TR_TXF_SPECS[c] : trRowTxf(n); }
// 一次算完整張表:每列金額 = 投入資金 × 隱含槓桿 × 權重;台指期列折口數(現價 × 每點價值,half-up 同對帳器)
function mpsRows() {
  const G = mgBag(), amount = mpsFundOf(G.sizing), lev = mpsLev(G.sizing), eff = amount !== null && lev !== null ? amount * lev : null, ccyF = mpsCcy();
  const order = typeof sfApplyOrder === "function" ? sfApplyOrder(TR.list, trPickPrefs(TR, typeof SF !== "undefined" ? SF : null).order).map((x) => x.name) : [];
  const rank = (n) => { const i = order.indexOf(n); return i < 0 ? 1e9 : i; };
  const rows = mpsMembers().slice().sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1)).map((n) => {
    const w = mpsWeight(n), money = eff === null ? null : eff * w, spec = trCtStored(n) ? mgSpec(n) : null, px = spec ? trTxfPrice() : null;
    const perLot = spec && px ? px * spec.cv : null, unit = spec ? null : trZoneOf(n);
    const r = { name: n, w, spec, money, perLot, unit, native: spec || money === null ? null : money === 0 ? 0 : unit && unit !== TR_ZONE_UNKNOWN ? mpsConv(money, ccyF, unit) : null, moneyTwd: null, lots: null, fxMissing: false };
    if (spec && money !== null) {
      if (money === 0) r.lots = 0;
      else if (perLot) { r.moneyTwd = mpsConv(money, ccyF, TR_TXF_CCY); if (r.moneyTwd === null) r.fxMissing = true; else r.lots = trRoundLots(r.moneyTwd / perLot); }
    }
    return r;
  });
  return { amount, lev, eff, rows, fundFx: mpsFundFxMissing(G.sizing) };
}
// canonical 同金額表:台指期 = 整數口數、其他 = 這一列自己計價的金額(取整)
function mpsAmountsPayload(d) { const out = {}; d.rows.forEach((r) => { out[r.name] = r.spec ? (r.lots || 0) : Math.round(r.native || 0); }); return out; }
// 預覽三格:槓桿、年化波動、最大回撤、總部位,扣掉方法本身那一項(沒序列再扣回撤),取前三
function mpsPreview(s) {
  const prop = mpsProp(), series = mpsSeriesOf(prop), m = mpsMethodOf(s, series), L = mpsLevFor(s, prop), h = mpsHistVolOf(prop), fund = mpsFundOf(s);
  const cells = { lev: { v: L === null ? null : L.toFixed(2) + "×" }, vol: { v: L === null || h === null ? null : (h * L).toFixed(1) + "%" }, mdd: { v: null, warn: false },
    amt: { v: L === null || fund === null ? null : trFmt(Math.round(fund * L)), unit: mpsCcy() } };
  if (L !== null && series) { const d = mpsMddAt(L, series); cells.mdd = { v: "−" + d.toFixed(1) + "%", warn: d > MPS_MDD_WARN }; }
  return ["lev", "vol", "mdd", "amt"].filter((k) => k !== m && !(k === "mdd" && !series)).slice(0, 3).map((k) => Object.assign({ k, warn: false }, cells[k]));
}

function mgPaint() {
  const box = $("po-opt"); if (!box || box.hidden) return;
  const S = TR, G = mgBag(S), m = mgManager();
  // 一支策略都沒有(或都沒有回測):優化分頁跟配置分頁一樣霧化 + 選擇策略(Windows e2e 10-14)
  if (TR.listLoaded && !TR.list.some((x) => x.hasBacktest)) {
    if (box.dataset.fog !== "1") { box.textContent = ""; box.appendChild(poFog("pick")); box.dataset.fog = "1"; S.sig.opt = null; }
    return;
  }
  if (box.dataset.fog === "1") { delete box.dataset.fog; S.sig.opt = null; }
  mgBtSendingSync(G);
  if (m) { if (!G.inited) mgInit(G); mgPrune(G); }
  if (mgBlocked()) G.err = null;
  const sigM = m && m.backtest ? Object.assign({}, m, { backtest: Object.assign({}, m.backtest, { weights_history: m.backtest.weights_history ? Object.keys(m.backtest.weights_history).sort() : null }) }) : m;
  const sig = JSON.stringify([LANG, S.env, sigM, (trReport() || {}).config || null, mgMembers(), G.alloc, G.params, G.err, G.shortDays, G.shortDismissed, G.optBusy, G.btSending, !!G.btWaiting, G.refreshing.opt, G.refreshing.bt, G.wait.opt && G.wait.opt.left, G.wait.bt && G.wait.bt.left,
    G.sizing, G.ctEdits, trTxfPrice(), trFxView(), trNames(), S.save, TR.list.map((x) => [x.name, x.displayName]), trCfgUnread(trReport()), (trReport() || {}).can_switch_contract]);
  if (S.sig.opt === sig && box.childElementCount) { mgDrawChart(); return; }
  const keep = trPosFocusOf(box);
  S.sig.opt = sig; G.chartSig = null; box.textContent = "";
  const blocked = mgBlocked(), fog = !!m && mgFogOn(G);
  if (blocked) box.appendChild(mgOutdatedBox());   // 因在前、果在後:先讀到為什麼不能按,再看到被關掉的控制項
  box.appendChild(mgToolbar(blocked, fog));
  if (m) {
    if (G.err && !blocked) box.appendChild(trEl("p", "mg-err", G.err));
    if (fog) box.appendChild(poFog("opt"));
    else { box.appendChild(mgSuggest()); box.appendChild(mgBacktestSec()); }
  }
  trPosFocusBack(box, keep, $("po-h"));
  mgDrawChart();
}
/* 選了兩檔以上、還沒有權重也沒有回測(沒在跑、沒錯、沒警示):工具列下面原本整片空白(實機 integ2 10-18)→ Setup fog,CTA 是「跑優化」。
   「策略 N 檔」「方法」與「跑回測」留在工具列;同一個動作只出現一次,工具列的「跑優化」在霧開著時藏起來 */
function mgFogOn(G) {
  if (mgBlocked() || G.err || G.optBusy || G.btSending || mgMembers().length < 2 || mgProposal() || mgBacktest() || mgRunning()) return false;
  const j = mgJob(), sh = mgShort();
  return !(j && j.status === "error") && !(sh && !G.shortDismissed) && !["opt", "bt"].some((w) => G.wait[w] && G.wait[w].left.length);
}
// 機器落後:同頁警示條;出口是設定 › 一般的「檢查更新」(雲端 = 更新雲端主機)
function mgOutdatedBox() {
  const box = trEl("div", "mg-warn"), cloud = TR.env === "cloud";
  box.appendChild(trEl("p", "", t("mg.outdated")));
  const b = trEl("button", "btn-quiet", cloud ? t("up.cloud.go") : t("minv.btn")); b.type = "button"; b.dataset.fk = "mg-upd";
  b.addEventListener("click", () => { if (cloud) upCloudUpdate(b); else setOpen().then(() => { setCat("display"); const u = $("set-up-btn"); if (u && !u.hidden) u.focus(); }); });
  box.appendChild(b);
  return box;
}
// 單一工具列(全頁按鈕只在這一列):左設定組(策略 N 檔、方法),右「跑優化」「跑回測」
function mgToolbar(outdated, fog) {
  const G = mgBag(), tb = trEl("div", "mg-toolbar"), set = trEl("div", "tb-set");
  const bs = trEl("button", "tb-fld"); bs.type = "button"; bs.dataset.mgOpen = "strat"; bs.dataset.fk = "mg-strat"; bs.title = t("tr.pick");
  bs.append(trEl("span", "", t("mg.tbStrat")), trEl("span", "v", t("mg.tbStratN", { n: mgMembers().length })));
  bs.disabled = !TR.listLoaded;
  bs.addEventListener("click", () => psOpen(bs, "mg"));
  const bm = trEl("button", "tb-fld"); bm.type = "button"; bm.dataset.mgOpen = "method"; bm.dataset.fk = "mg-method"; bm.title = t("mg.tbMethodTip");
  bm.append(trEl("span", "", t("mg.tbMethod")), trEl("span", "v", outdated || !G.alloc ? "—" : mgAllocLabel(G.alloc)));
  bm.disabled = outdated || !G.params;
  bm.addEventListener("click", () => mgMethodOpen(bm));
  set.append(bs, bm); tb.appendChild(set);
  const acts = trEl("div", "tb-actions"), opt = trEl("button", "btn-fill tb-run"); opt.type = "button"; opt.dataset.fk = "mg-opt";
  opt.title = t("mg.optTip");
  if (G.optBusy) { const sp = trEl("span", "spin16"); sp.setAttribute("aria-hidden", "true"); opt.append(sp, t("mg.optRunning")); } else opt.textContent = t("mg.optRun");
  opt.disabled = outdated || G.optBusy || !mgMembers().length;
  opt.addEventListener("click", mgRunOptimize);
  opt.hidden = !!fog;   // 霧上的 CTA 就是這顆;右對齊的一組,藏左邊這顆「跑回測」不會位移
  const bt = trEl("button", "btn-out tb-run2", t("mg.btRun")); bt.type = "button"; bt.dataset.fk = "mg-bt";
  const reason = outdated ? null : mgBtBlockReason();
  bt.disabled = outdated || !!reason || mgRunning() || G.btSending;
  bt.title = reason || t("mg.btTip");
  bt.addEventListener("click", mgRunBacktest);
  acts.append(opt, bt); tb.appendChild(acts);
  // 等更新績效時(Wei 10-14,同網頁):鈕下方一行講在等哪一支,後面「先用目前數字跑」;不等的時候這一行不出現
  ["opt", "bt"].forEach((w) => { const W = G.wait[w]; if (!W || !W.left.length) return;
    const line = trEl("div", "mg-wait"), n = W.left.length;
    line.appendChild(trEl("span", "", t(w === "opt" ? "mg.waitPrefixOpt" : "mg.waitPrefixBt") + (n === 1 ? t("mg.waitOne", { name: trDisplay(W.left[0]) }) : t("mg.waitMany", { name: trDisplay(W.left[0]), n, more: n - 1 }))));
    const b = trEl("button", "btn-quiet", t("mg.runNow")); b.type = "button"; b.dataset.fk = "mg-run-now-" + w; b.addEventListener("click", () => mgRunNow(w));
    line.appendChild(b); tb.appendChild(line); });
  return tb;
}
// 權重分配(警示條 → 有提案才畫:區段標 + 部位大小設定鈕 + 套用 + 表)。兩檔以上、還沒有建議也沒有回測時不畫這一段,改出 Setup fog(mgFogOn,實機 integ2 10-18)
function mgSuggest() {
  const frag = document.createDocumentFragment(), G = mgBag(), sh = mgBlocked() ? null : mgShort();
  if (sh && !G.shortDismissed) {
    const box = trEl("div", "mg-warn"); box.appendChild(trEl("p", "", t("mg.short", { n: sh.n, l: sh.l, d: sh.l - sh.n + 1 })));
    const acts = trEl("div", "mg-warn-acts");
    if ("lookback" in G.params && sh.n - 1 >= 10) {
      const go = trEl("button", "btn-out", t("mg.shortRun", { n: sh.n - 1 })); go.type = "button";
      go.addEventListener("click", () => { G.params.lookback = sh.n - 1; G.shortDismissed = false; G.err = null; mgPaint(); mgRunOptimize(); });   // 改窗即跑優化
      acts.appendChild(go);
    }
    const no = trEl("button", "btn-quiet", t("mg.shortDismiss")); no.type = "button";
    no.addEventListener("click", () => { G.shortDismissed = true; mgPaint(); });
    acts.appendChild(no); box.appendChild(acts); frag.appendChild(box);
  }
  if (mgMembers().length === 1 && !mgBlocked()) { const box = trEl("div", "mg-warn"); box.appendChild(trEl("p", "", t("mg.single", { n: 1 }))); frag.appendChild(box); }
  const prop = mgProposal();
  if (!prop) return frag;
  const sec = trEl("div", "pf-sec");
  sec.appendChild(poHelpGroup(trEl("span", "label", t("mg.secAmounts")), "optimize", "po-help-opt"));
  sec.appendChild(mgSizeChip());
  const acts = trEl("div", "pf-acts");
  // 停用時旁邊一定有一句原因(停用鈕的 title 觸控看不到;Mac e2e 10-14:缺台幣匯率時原本什麼都沒寫)。內容由 mgSuggestTable 跟著停用條件一起寫
  const why = acts.appendChild(trEl("span", "mg-apply-why", "")); why.id = "mg-apply-why";
  const ap = trEl("button", "btn-fill", t("mg.apply")); ap.type = "button"; ap.dataset.fk = "mg-apply"; ap.id = "mg-apply";
  ap.addEventListener("click", () => mgApply(ap));
  acts.appendChild(ap); sec.appendChild(acts); frag.appendChild(sec);
  const wrap = trEl("div", "pf-scroll"); frag.appendChild(wrap);
  mgSuggestTable(wrap, ap);
  return frag;
}
function mgSizeChip() {
  const G = mgBag(), b = trEl("button", "tb-fld mg-size-btn"); b.type = "button"; b.dataset.fk = "mg-size"; b.setAttribute("aria-haspopup", "dialog"); b.title = t("sz.title");
  // 摘要「投入金額 · 方法 目標」(同網頁;槓桿倍數只在框裡的預覽)
  const prop = mpsProp(), series = mpsSeriesOf(prop), m = mpsMethodOf(G.sizing, series), p = mpsChipParts(mpsFundOf(G.sizing), mpsCcy(), m, mpsTargetOf(G.sizing, m, prop));
  if (p.fund) { b.appendChild(trEl("span", "v mono", p.fund)); if (p.ccy) b.appendChild(trEl("span", "ccy", p.ccy)); b.appendChild(trEl("span", "dot", "·")); }
  b.appendChild(trEl("span", "", t({ vol: "sz.m.vol", mdd: "sz.m.mdd", lev: "sz.m.lev" }[m])));
  if (p.target) b.appendChild(trEl("span", "v mono", p.target));
  b.addEventListener("click", () => mgSizeOpen(b));
  return b;
}
// 權重分配表「策略｜權重｜金額」(Wei 10-13);分區同金額表,單位只寫在區標題;金額 = 套用時寫進主機的數
function mgSuggestTable(wrap, ap) {
  const d = mpsRows(), stored = trStored() || {}, byName = {}; d.rows.forEach((r) => { byName[r.name] = r; });
  const zoneOf = (n) => (byName[n].spec ? TR_ZONE_LOTS : byName[n].unit || TR_ZONE_UNKNOWN);
  const names = d.rows.map((r) => r.name), zones = trZoneOrder(names.map(zoneOf), trVenueId(), trMultZone(trVenueId(), trUnit(), names.map(zoneOf)));
  const multi = zones.length > 1, hu = multi ? null : trZoneUnit(zones[0]);
  const hasLots = zones.indexOf(TR_ZONE_LOTS) >= 0, tbl = trEl("table", "pf-tbl zoned mg-tbl");
  // 換算方式只寫這一處(金額欄頭的 title)
  tbl.appendChild(trHead([[t("tr.col.strategy"), ""], [t("mg.colWeight"), "n"], [t("tr.col.amount"), "n", hu, t("mg.propTip") + (multi ? t("mg.propTipConv") : "") + (hasLots ? t("mg.propTipLots") : "")]]));
  // 投入資金空著(沒填、預設 = 目前金額合計也是 0):整欄都會是「—」,表上方先講要去哪裡填(設計最終稽核)
  if (mpsFundOf(mgBag().sizing) === null && !d.fundFx) { const mk = mpsMethodOf(mgBag().sizing, mpsSeriesOf(mpsProp()));   // 句子點名工具列那顆鈕現在的方法名(按它開部位大小)
    wrap.appendChild(trEl("p", "pf-note mg-need-fund", t("mg.needFund", { method: t({ vol: "sz.m.vol", mdd: "sz.m.mdd", lev: "sz.m.lev" }[mk] || "sz.m.vol") }))); }
  const next = {}; let quoteMissing = false, changed = false, underTwd = 0;
  d.rows.forEach((r) => {
    next[r.name] = r.spec ? (r.money === null ? null : r.lots) : r.native === null ? null : Math.round(r.native);
    if (r.money !== null && next[r.name] === null) quoteMissing = true;
    if (next[r.name] !== null && next[r.name] !== (stored[r.name] || 0)) changed = true;
    if (r.spec && mgCt(r.name) !== trCtStored(r.name)) changed = true;
  });
  zones.forEach((z) => {
    const tb = document.createElement("tbody");
    if (multi) {
      const g = trEl("tr", "grp"), c = trEl("td", "grp-l" + (z === TR_ZONE_LOTS || z === TR_ZONE_UNKNOWN ? " cjk" : ""), trZoneLabel(z)), ns = names.filter((n) => zoneOf(n) === z);
      const money = z !== TR_ZONE_LOTS && z !== TR_ZONE_UNKNOWN && ns.length >= 2;
      c.colSpan = money ? 2 : 3; g.appendChild(c);
      if (money) g.appendChild(trEl("td", "n", ns.some((n) => next[n] === null) ? "" : trFmt(ns.reduce((a, n) => a + next[n], 0))));
      tb.appendChild(g);
    }
    names.filter((n) => zoneOf(n) === z).forEach((n) => {
      const r = byName[n], row = document.createElement("tr"), key = trEl("td", "key"), nm = trEl("span", "key-name", trDisplay(n));
      nm.title = trDisplay(n); key.appendChild(nm);
      // 台指期列:同配置分頁的合約下拉,選單口數照這張表的金額換算;在這裡改不動配置,按「套用金額」才連合約一起寫進主機
      if (r.spec && trCtGate(n)) key.appendChild(ctTrigger("opt", n, mgCt(n), (root) => {
        const G = mgBag(); if (root === trCtStored(n)) delete G.ctEdits[n]; else G.ctEdits[n] = root;
        trackFeature("contract_switch"); TR.sig.opt = null; mgPaint(); ctFocus("opt", n);
      }, (root) => { if (r.money === null) return null; if (r.money === 0) return 0; const px = trTxfPrice(); return r.moneyTwd != null && px ? trRoundLots(r.moneyTwd / (px * TR_TXF_SPECS[root].cv)) : null; }));
      const nx = next[n], cell = trEl("td", "n");
      if (nx === null) { cell.textContent = "—"; if (r.spec && r.fxMissing) cell.appendChild(trEl("span", "pf-note", t("mg.noFx"))); }
      // 權重換成台指期不到一口(取整成 0):列上直接講,表底講少投多少(同網頁)
      else if (r.spec && nx === 0 && r.moneyTwd > 0) { cell.textContent = t("mg.lotsUnder"); underTwd += r.moneyTwd; }
      else if (r.spec) { cell.textContent = trLotsFmt(nx, false); const m = nx ? trTxfRefMoney(r.spec, nx, trTxfPrice()) : null; if (m != null) cell.title = t("tr.lotsNotionalTip", { amt: trFmt(Math.round(m)) }); }
      else cell.textContent = trFmt(nx);
      row.append(key, trEl("td", "n", (mgWeightPct(r.w) || "0") + "%"), cell);
      tb.appendChild(row);
    });
    tbl.appendChild(tb);
  });
  // 表底合計:套用後的合計(= 確認框「目標」那一欄的合計)
  const tbT = document.createElement("tbody"), rT = trEl("tr", "total"), l = trEl("td", "", t("tr.total")); l.colSpan = 2;
  const tot = d.eff === null || quoteMissing ? null : trZoneSum(mpsAmountsPayload(d), null, (n, v) => { const sp = byName[n] && byName[n].spec; return sp ? trTxfRefMoney(sp, v, trTxfPrice()) : v; }).total;
  if (multi && tot && tot.ccy) l.appendChild(trEl("span", "ccy", tot.ccy));
  const tc = trEl("td", "n", tot ? trTotalText(tot) : "—"); if (tot && !multi && tot.ccy && hu === t("tr.lotsUnit")) tc.appendChild(trEl("span", "ccy", tot.ccy));
  rT.append(l, tc); tbT.appendChild(rT); tbl.appendChild(tbT);
  wrap.appendChild(tbl);
  if (underTwd > 0) { const conv = mpsConv(underTwd, TR_TXF_CCY, mpsCcy()), amt = conv === null ? trFmt(Math.round(underTwd)) + " " + TR_TXF_CCY : trFmt(Math.round(conv)) + " " + mpsCcy();
    wrap.appendChild(trEl("p", "pf-note", t("mg.lotsUnderFoot", { amt }))); }
  const over = mgLotsOver(d.rows, d.eff, (v) => mpsConv(v, TR_TXF_CCY, mpsCcy()));
  over.forEach((o) => wrap.appendChild(trEl("p", "pf-note", over.length === 1 ? t("mg.lotsOverFoot", { lots: o.lots, pct: o.pct }) : t("mg.lotsOverFootN", { name: trDisplay(o.name), lots: o.lots, pct: o.pct }))));
  if (d.rows.some((r) => r.spec)) trTxfWant();
  // 套用:算不出來、算出來跟目前全等、儲存生命週期中、讀不到設定、兩邊策略不是同一組都停用
  ap.disabled = d.eff === null || quoteMissing || !changed || !!TR.save && TR.save !== "failed" || trCfgUnread(trReport()) || trStored() === null || !mgSameAsAmounts() || !TR.listLoaded || (TR.env === "cloud" && !(TR.st && TR.st.alive));
  const whyEl = ap.parentNode && ap.parentNode.querySelector ? ap.parentNode.querySelector(".mg-apply-why") : null;
  if (whyEl) whyEl.textContent = ap.disabled ? t(mgApplyWhy(d, quoteMissing, changed)) : "";
  // 用的是上次存下來的匯率(登入失效／雲端讀不到):表下講是哪一天的,數字是 ≈
  const fv = trFxView(); if (fv.cached && d.rows.some((r) => r.spec || (r.unit && r.unit !== mpsCcy()))) wrap.appendChild(trEl("p", "pf-note", t("mg.fxCached", { d: new Date(fv.cached).toISOString().slice(0, 10) })));
}
/* 「套用金額」停用的原因(依序取第一個成立的;每一條停用條件都有字)。缺匯率時分開講:沒登入／登入失效 → 叫人登入;登入正常 → 缺台幣匯率;
   匯率有、缺台指期報價 → 等報價 */
function mgApplyWhy(d, quoteMissing, changed) {
  if (!mgSameAsAmounts()) return "mg.applyDiffSet";
  if (quoteMissing) return d.rows.some((r) => r.fxMissing) ? mgFxWhy() : "mg.applyWhyQuote";
  if (d.fundFx) return mgFxWhy();
  if (d.eff === null) return "mg.applyWhySize";
  if (TR.save && TR.save !== "failed") return "tr.saving";
  if (trCfgUnread(trReport()) || trStored() === null) return TR.env === "cloud" ? "tr.cloud.cfgUnread" : "tr.cfgUnreadLocal";
  if (!TR.listLoaded || (TR.env === "cloud" && !(TR.st && TR.st.alive))) return "mg.applyWhyWait";
  if (!changed) return "mg.applyWhySame";
  return "mg.applyWhyWait";
}
function mgFxWhy() {
  const c = typeof TR_BAGS !== "undefined" && TR_BAGS.cloud.st ? TR_BAGS.cloud.st.cloud : null;
  if (trFxView().expired) return "mg.applyWhyFxOld";   // 上次存下的匯率超過 30 天:不再拿來換算
  return !c || c.code === "NO_LOGIN" || c.code === "REVOKED" || c.code === "NO_APP_SECRET" ? "mg.applyWhyLogin" : "mg.applyWhyFx";
}
// 套用金額:建議寫進配置分頁的未儲存值,走同一個確認框與 amounts(trSaveAmounts);取消就把未儲存值還原
function mgApply(opener) {
  const S = TR, G = mgBag(S);
  if (!mgProposal() || (S.save && S.save !== "failed") || trCfgUnread(trReport()) || !mgSameAsAmounts()) return;
  const d = mpsRows();
  if (d.eff === null || d.rows.some((r) => r.spec && r.lots === null)) return;   // 缺報價時台期列 lots 是 null,不能把「未知」送成 0
  const payload = mpsAmountsPayload(d), names = Object.keys(payload);
  if (!names.length) return;   // 零成員的 payload 是 {} = 清空整個組合,不送
  const stored = trStored() || {}, before = Object.assign({}, S.edits), beforeCt = Object.assign({}, S.ct.edits), beforeBasis = Object.assign({}, S.ct.basis);
  names.forEach((n) => {
    if (payload[n] !== (stored[n] || 0)) S.edits[n] = payload[n]; else delete S.edits[n];
    if (!trCtStored(n)) return;
    if (mgCt(n) !== trCtStored(n)) S.ct.edits[n] = mgCt(n); else delete S.ct.edits[n];
    delete S.ct.basis[n];
  });
  trackFeature("mg_apply");
  /* 本金沒填(null)時預設 = 已存金額的合計;套用後合計變成「本金 × 槓桿」,下一次的預設就跟著縮(槓桿 < 1 時 280k → 134k,第三台實測)。
     存成功就把這次用的本金(連同當下方法的目標)記進部位大小設定(同 mgSave),之後就是它,重複套用、重跑優化都不漂移 */
  const fundUsed = mpsFundOf(G.sizing), ccyUsed = mpsCcy(), prop = mpsProp(), mUsed = mpsMethodOf(G.sizing, mpsSeriesOf(prop)), tgUsed = mpsTargetOf(G.sizing, mUsed, prop);
  trSaveAmounts(trNames(), trBase(), opener, { source: "optimize",
    onCancel: () => { S.edits = before; S.ct.edits = beforeCt; S.ct.basis = beforeBasis; S.sig.cfg = null; },
    // 存成功就回配置分頁,剛改的金額格閃一下;優化自己換的合約交回配置(存著的就是它了)
    onSaved: (sending, was) => { Object.keys(sending).forEach((n) => { if (sending[n] !== (was[n] || 0)) S.flash[n] = Date.now(); }); G.ctEdits = {}; mgPinUsed(S, G, ccyUsed, fundUsed, mUsed, tgUsed); if (TR === S && S.view === "po") poSetTab("cfg"); } });
}
function mgPinUsed(S, G, ccy, fund, m, target) {
  const next = mpsSizingPin(G.sizing, ccy, fund, m, target);
  if (JSON.stringify(next) === JSON.stringify(mpsSizingClean(G.sizing))) return;
  G.sizing = next; G.sizingSet = true; mgSave(S, MG_SIZE_KEY, G.sizing);
}
// 移動窗格回測:跑中 / 結果 / 失敗;沒跑過、沒在跑、也沒錯:整段不出現(Wei 10-13)
function mgBacktestSec() {
  const frag = document.createDocumentFragment(), G = mgBag(), jobAny = mgJobAny(), running = (jobAny && jobAny.status === "running") || G.btSending;
  const job = mgJob();
  if (!running && !mgBacktest() && !(job && job.status === "error")) return frag;
  frag.appendChild(trSec(trEl("span", "label", t("mg.secBt"))));
  if (running) {
    const panel = trEl("div", "run-panel"), row = trEl("div", "run-row"), sp = trEl("span", "spin16");
    /* 還在等更新績效、回測還沒送出:寫「等更新績效…」,不畫進度條、不寫「回測進行中」;取消照留(同網頁 8fb666c2) */
    if (G.btWaiting) {
      sp.setAttribute("role", "status"); sp.setAttribute("aria-label", t("mg.btWaitPerf")); row.append(sp, trEl("span", "st", t("mg.btWaitPerf")));
      const c0 = trEl("button", "pf-act", t("mg.btCancel")); c0.type = "button"; c0.title = t("mg.btCancelTip"); c0.dataset.fk = "mg-cancel"; c0.addEventListener("click", mgCancelBacktest);
      row.appendChild(c0); panel.appendChild(row); frag.appendChild(panel); return frag;
    }
    sp.setAttribute("role", "status"); sp.setAttribute("aria-label", t("mg.btRunningAria")); row.appendChild(sp);
    const pg = jobAny && jobAny.status === "running" && jobAny.progress && typeof jobAny.progress === "object" ? jobAny.progress : null;
    const day = pg && typeof pg.day === "number" ? pg.day : null, total = pg && typeof pg.total === "number" && pg.total > 0 ? pg.total : null;
    row.appendChild(trEl("span", "st", day !== null && total !== null ? t("mg.btRunningAt", { d: day, t: total }) : t("mg.btRunningAria")));
    const cancel = trEl("button", "pf-act", t("mg.btCancel")); cancel.type = "button"; cancel.title = t("mg.btCancelTip"); cancel.dataset.fk = "mg-cancel";
    cancel.addEventListener("click", mgCancelBacktest);
    row.appendChild(cancel); panel.appendChild(row);
    const pct = day !== null && total !== null ? Math.max(0, Math.min(100, Math.round((day / total) * 100))) : 0;
    const prog = trEl("div", "prog"); prog.setAttribute("role", "progressbar"); prog.setAttribute("aria-valuemin", "0"); prog.setAttribute("aria-valuemax", "100"); prog.setAttribute("aria-valuenow", String(pct));
    const bar = trEl("i"); bar.style.width = pct + "%"; prog.appendChild(bar); panel.appendChild(prog);
    panel.appendChild(trEl("div", "run-meta", pct + "% · " + t("mg.btRandom", { n: MG_RANDOM_N.toLocaleString("en-US") })));
    frag.appendChild(panel);
    return frag;
  }
  // 資料不足已轉成權重分配區的警示條時不重複當錯誤顯示
  if (job && job.status === "error" && !(mgShortDaysOf(job.error) !== null && mgShort())) frag.appendChild(trEl("p", "mg-err", t("mg.btError", { e: mgErrLine(job.error) || t("tr.cmdFailed") })));
  const bt = mgBacktest(); if (!bt) return frag;
  const man = bt.managed && typeof bt.managed === "object" ? bt.managed : {}, rb = bt.random_benchmark && typeof bt.random_benchmark === "object" ? bt.random_benchmark : {};
  // 每個指標各自的「贏過 X% 隨機」(Wei 10-15),附期間注記的參考值、不是判決;舊 workspace 只有 Sharpe 那一個
  const beats = mgBeatsOf(rb), ov = bt.overlap && typeof bt.overlap === "object" ? bt.overlap : null;
  const win = ov && typeof ov.start === "string" && typeof ov.eval_days === "number" ? " " + t("mg.beatsNote", { s: ov.start, n: ov.eval_days }) : "";
  if (!beats.ret && !beats.sharpe && !beats.mdd && ov) frag.appendChild(trEl("p", "mg-refnote", t("mg.beatsNone")));
  const grid = trEl("div", "mg-stats");
  const stat = (label, v, cls, k) => {
    const c = trEl("div", "mg-stat"); c.append(trEl("div", "sl", label), trEl("div", "sv" + (v === null ? " na" : cls ? " " + cls : ""), v === null ? "—" : v));
    if (beats[k]) {
      const b = trEl("div", "mg-stat-beat"), lab = trTipLabel("mg-beats", t("mg.beats", { p: beats[k] }), t({ ret: "mg.beatsTip.ret", sharpe: "mg.beatsTip.sharpe", mdd: "mg.beatsTip.mdd" }[k]) + win);
      lab.firstChild.dataset.fk = "tip:mg-beat-" + k;   // 三格可能同字(都贏過 85%):重畫後焦點要回到同一格
      b.appendChild(lab); c.appendChild(b);
    }
    return c;
  };
  const tr0 = mgPctText(man["total_return_%"]), dd = mgPctText(man["max_drawdown_%"]);
  grid.append(stat(t("mg.totalReturn"), tr0 && tr0.s, !tr0 ? "" : tr0.v > 0 ? "buy" : tr0.v < 0 ? "sell" : "", "ret"), stat("Sharpe", mgSharpeText(man.sharpe), "", "sharpe"),
    stat("Max DD", dd && dd.s, dd && dd.v < 0 ? "sell" : "", "mdd"));
  frag.appendChild(grid);
  const frame = trEl("div", "mg-frame"); frame.appendChild(trEl("div", "chart-cap", t("mg.chartCap")));
  const series = mgWeightSeries(bt), canvas = document.createElement("canvas");
  canvas.className = "mg-canvas" + (series ? " has-weights" : ""); canvas.id = "mg-canvas"; canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", series ? t("mg.chartAriaW") : t("mg.chartAria"));
  frame.appendChild(canvas);
  const legend = trEl("div", "mg-legend");
  [["lg-managed", "mg.legendManaged"], ["lg-band", "mg.legendBand"], ["lg-median", "mg.legendMedian"]].forEach((it) => { const s = trEl("span"); s.append(trEl("i", it[0]), t(it[1])); legend.appendChild(s); });
  frame.appendChild(legend);
  if (series) {
    const wl = trEl("div", "mg-legend lg-weights"); wl.appendChild(trEl("span", "lg-cap", t("mg.legendWeights")));
    series.forEach((sr) => { const s = trEl("span"), sw = trEl("i"); sw.style.background = "var(" + sr.colorVar + ")"; const nm = trEl("span", "lg-name", sr.label); nm.title = sr.label; s.append(sw, nm); wl.appendChild(s); });
    frame.appendChild(wl);
  }
  frag.appendChild(frame);
  return frag;
}
// 逐日權重 → 要畫的堆疊序列(全有或全無);期間平均權重前 3 大配 data-2/3/4,其餘併成「其他 N 支」
function mgWeightSeries(bt) {
  const wh = bt && bt.weights_history, dates = Array.isArray(bt && bt.daily_dates) ? bt.daily_dates : null;
  if (!wh || typeof wh !== "object" || Array.isArray(wh) || !dates || dates.length < 2) return null;
  const names = Object.keys(wh).sort(), n = dates.length;
  if (!names.length || names.some((k) => !Array.isArray(wh[k]) || wh[k].length !== n || wh[k].some((v) => typeof v !== "number" || !isFinite(v)))) return null;
  const mean = new Map(names.map((k) => [k, wh[k].reduce((a, v) => a + v, 0) / n]));
  const top = names.slice().sort((a, b) => mean.get(b) - mean.get(a)).slice(0, 3), rest = names.filter((k) => top.indexOf(k) < 0);
  const out = names.filter((k) => top.indexOf(k) >= 0).map((k, i) => ({ label: trDisplay(k), colorVar: "--color-data-" + (i + 2), values: wh[k] }));
  if (rest.length) out.push({ label: t("mg.legendRest", { n: rest.length }), colorVar: "--color-greyDark", values: Array.from({ length: n }, (_, i) => rest.reduce((a, k) => a + wh[k][i], 0)) });
  return out;
}
function mgRgba(name, a) { const h = trToken(name), m = /^#([0-9a-f]{6})$/i.exec(h); if (!m) return h; const v = parseInt(m[1], 16); return "rgba(" + (v >> 16) + "," + ((v >> 8) & 255) + "," + (v & 255) + "," + a + ")"; }
// 累積報酬(%)vs 隨機 p5–p95 帶 + 中位數虛線;下方權重佔比堆疊(y 固定 0–100%)。顏色全讀 token
function mgDrawChart() {
  const canvas = $("mg-canvas"), G = TR.mg;
  if (!canvas || !G || TR.view !== "po" || TR.poTab !== "opt") return;
  const bt = mgBacktest(); if (!bt) return;
  const W = canvas.clientWidth, H = canvas.clientHeight; if (!W || !H) return;
  const sig = String(bt.computed_at) + "|" + W + "x" + H; if (sig === G.chartSig) return; G.chartSig = sig;
  const num = (arr) => (Array.isArray(arr) && arr.every((v) => typeof v === "number" && isFinite(v)) ? arr : null);
  const dates = Array.isArray(bt.daily_dates) ? bt.daily_dates : null, managed = num(bt.managed_cum);
  const rbo = bt.random_benchmark && typeof bt.random_benchmark === "object" ? bt.random_benchmark : {}, band = rbo.band && typeof rbo.band === "object" ? rbo.band : {};
  let p5 = num(band.p5), p95 = num(band.p95), p50 = num(band.p50);
  const dpr = window.devicePixelRatio || 1; canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H); ctx.font = "11px " + trToken("--font-mono");
  if (!dates || !managed || managed.length < 2 || dates.length !== managed.length) return;
  const n = managed.length;
  let bandOff = 0;
  if (!p5 || !p95 || p5.length !== p95.length || p5.length < 2) p5 = p95 = p50 = null;
  else if (p5.length !== n) { bandOff = typeof rbo.band_start === "string" ? dates.indexOf(rbo.band_start) : -1; if (bandOff < 0 || bandOff + p5.length > n) p5 = p95 = p50 = null; }
  if (p50 && (!p5 || p50.length !== p5.length)) p50 = null;
  const series = mgWeightSeries(bt), padL = 8, padR = 56, padT = 12, padB = 22, gap = series ? 24 : 0, h2 = series ? 90 : 0;
  const iw = W - padL - padR, ih = H - padT - padB - gap - h2; if (ih <= 0) return;
  let min = 0, max = 0; managed.concat(p5 || [], p95 || [], p50 || []).forEach((v) => { if (v < min) min = v; if (v > max) max = v; });
  const span = max - min || 1; min -= span * 0.06; max += span * 0.06;
  const X = (i) => padL + (iw * i) / (n - 1), Y = (v) => padT + (1 - (v - min) / (max - min)) * ih;
  ctx.lineWidth = 1; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  const step = (max - min) / 3, dec = step >= 10 ? 0 : step >= 1 ? 1 : 2;
  for (let g = 0; g <= 3; g++) {
    const gv = min + ((max - min) * g) / 3, gy = Math.round(Y(gv)) + 0.5;
    ctx.strokeStyle = trToken("--color-darkBorder"); ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(padL + iw, gy); ctx.stroke();
    ctx.fillStyle = trToken("--color-greyMedium"); ctx.fillText((gv < 0 ? "−" : gv > 0 ? "+" : "") + Math.abs(gv).toFixed(dec) + "%", padL + iw + 6, gy);
  }
  if (p5 && p95) {
    ctx.fillStyle = mgRgba("--color-greyDark", 0.55); ctx.beginPath();
    for (let i = 0; i < p5.length; i++) ctx.lineTo(X(bandOff + i), Y(p95[i]));
    for (let i = p5.length - 1; i >= 0; i--) ctx.lineTo(X(bandOff + i), Y(p5[i]));
    ctx.closePath(); ctx.fill();
    if (bandOff > 0) { const bx = Math.round(X(bandOff)) + 0.5; ctx.save(); ctx.setLineDash([2, 3]); ctx.strokeStyle = trToken("--color-greyDark"); ctx.beginPath(); ctx.moveTo(bx, padT); ctx.lineTo(bx, padT + ih); ctx.stroke(); ctx.restore(); }
  }
  const zy = Math.round(Y(0)) + 0.5; ctx.strokeStyle = trToken("--color-greyDark"); ctx.beginPath(); ctx.moveTo(padL, zy); ctx.lineTo(padL + iw, zy); ctx.stroke();
  if (p50) { ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = trToken("--color-greyMedium"); ctx.lineWidth = 1.2; ctx.beginPath(); for (let i = 0; i < p50.length; i++) ctx.lineTo(X(bandOff + i), Y(p50[i])); ctx.stroke(); ctx.restore(); }
  ctx.strokeStyle = trToken("--color-data-1"); ctx.lineWidth = 1.8; ctx.lineJoin = "round"; ctx.beginPath(); for (let i = 0; i < n; i++) ctx.lineTo(X(i), Y(managed[i])); ctx.stroke();
  if (series) {
    const wTop = padT + ih + gap, WY = (v) => wTop + (1 - Math.max(0, Math.min(1, v))) * h2;
    ctx.lineWidth = 1;
    [0, 0.5, 1].forEach((g) => { const gy = Math.round(WY(g)) + 0.5; ctx.strokeStyle = trToken(g === 0 ? "--color-greyDark" : "--color-darkBorder"); ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(padL + iw, gy); ctx.stroke();
      ctx.fillStyle = trToken("--color-greyMedium"); ctx.fillText(Math.round(g * 100) + "%", padL + iw + 6, gy); });
    const base = new Array(n).fill(0);
    ctx.save(); ctx.globalAlpha = 0.85;
    series.forEach((sr) => { ctx.fillStyle = trToken(sr.colorVar); ctx.beginPath(); for (let i = 0; i < n; i++) ctx.lineTo(X(i), WY(base[i] + sr.values[i])); for (let i = n - 1; i >= 0; i--) ctx.lineTo(X(i), WY(base[i])); ctx.closePath(); ctx.fill(); for (let i = 0; i < n; i++) base[i] += sr.values[i]; });
    ctx.restore();
  }
  ctx.fillStyle = trToken("--color-greyMedium"); ctx.textBaseline = "alphabetic";
  [[0, "left", padL], [Math.floor((n - 1) / 2), "center", padL + iw / 2], [n - 1, "right", padL + iw]].forEach((x) => { const dd = dates[x[0]]; if (typeof dd !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(dd)) return; ctx.textAlign = x[1]; ctx.fillText(dd.slice(0, 10), x[2], H - 6); });
}

/* ── 指令 ──
   跑優化／移動窗格回測前,只把上次更新超過 6 小時(或拿不到時間)的成員送 stats_refresh(Wei 10-14,同網頁 951af7ac);全部都新就不送、不等,直接跑。
   送了的等每一支結束——完成、失敗、被 skip 都算——再跑;被 skip 或失敗的照舊數字跑,不擋、不提示。一次最多 50 支,超過分批;等待有上限,逾時用現有數字跑 */
// 成員的「上次更新」:detail 的 perf.at,沒有就用機器回報的 ran_at(同一個 stats.json mtime,epoch 秒);都沒有 = null
async function mgPerfAt(S, n, load) {
  let d = null; try { d = await load(n); } catch (_) { d = null; }
  const p = d && d.perf; if (p && typeof p.at === "number" && isFinite(p.at)) return p.at;
  const m = mgStrategies().find((x) => x.name === n);
  return m && typeof m.ran_at === "number" && isFinite(m.ran_at) ? m.ran_at : null;
}
async function mgRefreshThen(S, run, cancelled, which) {   // which:"opt"／"bt"——兩條各自一個在等旗標,一條等完不能把另一條的清掉(稽核)
  // 20 分鐘與「前 1 分鐘每 3 秒」都從按下那一刻起算(同網頁:含問更新時間、等 ack)
  const t0 = Date.now(), until = t0 + MG_REFRESH_MAX_MS, nowSec = Math.floor(t0 / 1000);
  const load = S.env === "cloud" ? (n) => S.api.loadStrategy(n) : (n) => window.blave.loadStrategy(n);
  const members = mgMembers(), ats = await Promise.all(members.map((n) => mgPerfAt(S, n, load)));   // 並行抓(稽核 P2:雲端每支一次 detail,串行會多等好幾秒)
  const names = members.filter((n, i) => ats[i] === null || nowSec - ats[i] > 6 * 3600);   // 剛好 6 小時不算舊(整數秒比)
  if (!names.length) { run(); return; }
  const G = mgBag(S), w = which === "bt" ? "bt" : "opt"; G.refreshing[w] = true;
  const started = [];
  for (let i = 0; i < names.length; i += MG_REFRESH_BATCH) {
    let r = null;
    try { r = await S.api.tradeSend("stats_refresh", { names: names.slice(i, i + MG_REFRESH_BATCH) }); } catch (_) { r = null; }
    const res = r && r.ok && r.result && typeof r.result === "object" ? r.result : null;
    if (res && Array.isArray(res.started)) started.push(...res.started);
    if (res && res.skipped) Object.keys(res.skipped).forEach((n) => { if (res.skipped[n] === "BUSY") started.push(n); });   // 已經在跑的那支也等它
  }
  /* 抓 detail 失敗(雲端 api 一時讀不到)當成「這支結束了」:最壞是用現有數字跑——跟 skip／更新失敗同一個後果;
     當成還在跑則會因為一支讀不到而卡滿 20 分鐘(網頁是沿用舊快取,快取多半沒有 running,實際效果相同) */
  const busy = async (n) => { let d = null; try { d = await load(n); } catch (_) { d = null; } const p = d && d.perf, x = p && p.refresh; return !!(x && x.status === "running"); };
  // G.wait[w]:鈕下方那一行(在等哪幾支)與「先用目前數字跑」(mgRunNow 設 now、叫醒等待);正在跑的更新不取消,照樣跑完
  const W = G.wait[w] = { left: started.slice(), now: false, wake: null }, repaint = () => { S.sig.opt = null; if (TR === S && S.view === "po" && S.poTab === "opt") mgPaint(); };
  if (W.left.length) repaint();
  while (W.left.length && !W.now && Date.now() < until && !(cancelled && cancelled())) {
    await new Promise((res) => { W.wake = res; setTimeout(res, Date.now() - t0 < MG_REFRESH_POLL_MS.fastFor ? MG_REFRESH_POLL_MS.fast : MG_REFRESH_POLL_MS.slow); });
    W.wake = null;
    if (W.now || (cancelled && cancelled())) break;
    // 每一輪當場抓新的 detail 再判斷(不拿上一輪抓回來的舊資料判,不然更新完還要多等一輪;網頁同一個 bug)。並行抓;跑完的從那一行拿掉
    const bs = await Promise.all(W.left.map(busy));
    W.left = W.left.filter((n, k) => bs[k]); repaint();
  }
  if (G.wait[w] === W || G.wait[w] === null) { G.wait[w] = null; G.refreshing[w] = false; }   // 取消後又重按:新那一輪的旗標不清
  repaint();
  run();
}
// 「先用目前數字跑」:停止等待、立刻用現有數字送出(只送一次:等待迴圈結束才 run 一次;回測另有世代號)。正在跑的更新照樣跑完
function mgRunNow(w) {
  const G = mgBag(), W = G.wait[w]; if (!W || W.now) return;
  W.now = true; trackFeature("mg_run_now");
  if (W.wake) W.wake();
}
function mgRunOptimize() {
  const S = TR, G = mgBag(S);
  if (G.optBusy || mgBlocked() || !mgMembers().length) return;
  G.optBusy = true; G.err = null; mgPaint();   // 更新績效的等待期間鈕就維持送出中(inline 環),不另外加字
  mgRefreshThen(S, () => mgSendOptimize(S), null, "opt");
}
async function mgSendOptimize(S) {
  const G = mgBag(S), args = trWith(S, mgArgs), sig = JSON.stringify(args);
  let r = null;
  try { r = await S.api.tradeSend("manage_optimize", args); } catch (_) { r = null; }
  G.optBusy = false;
  const late = sig !== trWith(S, () => JSON.stringify(mgArgs()));   // 晚到的 ack:名單/方法已換,結果不落地
  if (r && r.ok) { trackFeature("mg_opt_run"); if (G.dropped) G.dropped.prop = null; }
  else if (!late) { const e = r && r.error ? r.error : ""; if (!trWith(S, () => mgShortFromError(G, e))) G.err = e === "TIMEOUT" || e === "UNKNOWN_RESULT" ? t("mg.timeout") : /no backtest stats/i.test(e) ? t("mg.errNoStats") : t("mg.optError", { e: mgErrLine(trRejectText(e)) || t("tr.cmdFailed") }); }
  S.sig.opt = null;
  try { S.st = await S.api.tradeStatus(); } catch (_) { }   // 提案經下一份報告回來
  if (TR === S && S.view === "po") { if (S.poTab === "opt") mgPaint(); else if (r && r.ok) srSay(t("mg.optDoneToast")); }   // 人已經切去配置分頁:講一聲結果在哪
  trPollSoon(500);
}
function mgRunBacktest() {
  const S = TR, G = mgBag(S);
  if (G.btSending || mgRunning() || mgBlocked() || mgBtBlockReason()) return;
  G.btSending = true; G.btSentAt = 0; G.btAskedAt = Date.now(); G.err = null;
  /* 每按一次換一個號碼(同網頁 042538da):取消等待中的那一次也換號——舊的那一輪等完看到號碼不是自己的就不送。
     只用一個布林會錯兩種:取消後馬上重按(重設成 false,舊那一輪也送出);已送出、ack 還沒回時按取消(誤當成還在等、不送 manage_cancel) */
  const gen = G.btGen = (G.btGen || 0) + 1, gone = () => gen !== G.btGen;
  G.btWaiting = true; mgPaint();
  mgRefreshThen(S, () => { if (gone()) return; G.btWaiting = false; mgSendBacktest(S); }, gone, "bt");
}
async function mgSendBacktest(S) {
  const G = mgBag(S), args = trWith(S, mgArgs), sig = JSON.stringify(args);
  let r = null;
  try { r = await S.api.tradeSend("manage_backtest", args); } catch (_) { r = null; }
  const late = sig !== trWith(S, () => JSON.stringify(mgArgs()));
  // ack 回來只代表機器收到:成功就維持「送出中」直到報表看到 running(mgBtSendingSync),不然第二下會撞 backtest already running
  if (r && r.ok) { G.btSentAt = Date.now(); if (G.dropped) G.dropped.job = null; trackFeature("mg_bt_run"); }
  else { G.btSending = false; G.btSentAt = 0; G.btAskedAt = 0; if (!late) { const e = r && r.error ? r.error : ""; if (!trWith(S, () => mgShortFromError(G, e))) G.err = /no backtest stats/i.test(e) ? t("mg.errNoStats") : t("mg.btError", { e: mgErrLine(trRejectText(e)) || t("tr.cmdFailed") }); } }
  S.sig.opt = null;
  try { S.st = await S.api.tradeStatus(); } catch (_) { }
  if (TR === S && S.view === "po" && S.poTab === "opt") mgPaint();
  trPollSoon(500);
}
async function mgCancelBacktest() {
  const S = TR, G = mgBag(S); G.err = null;
  // 還在等更新績效、回測還沒送出(btWaiting):機器上沒有 job 可取消——作廢這一次(換號,等待迴圈提早結束、不送 manage_backtest),鈕放開;
  // 已經送出(ack 還沒回也算)就照常送 manage_cancel
  if (G.btSending && G.btWaiting) { const W = G.wait.bt; G.wait.bt = null; if (W && W.wake) W.wake();   // 等待那一行收掉、迴圈馬上醒來看到換號
    G.btGen = (G.btGen || 0) + 1; G.btWaiting = false; G.btSending = false; G.btSentAt = 0; G.btAskedAt = 0; S.sig.opt = null; if (TR === S) mgPaint(); return; }
  let r = null; try { r = await S.api.tradeSend("manage_cancel", {}); } catch (_) { r = null; }
  if (!(r && r.ok)) G.err = t("tr.cmdFailed");
  S.sig.opt = null; if (TR === S) mgPaint(); trPollSoon(500);
}

/* ── 兩個框:方法、部位大小(殼同 #ps-scrim;Esc 與 Tab 圈在這裡自己接)── */
let mgmPend = null, mgmOpener = null, mgsDraft = null, mgsOpener = null;
function mgWire() {
  [["mgm", mgMethodClose, mgMethodOk], ["mgs", mgSizeClose, mgSizeOk]].forEach(([p, close, ok]) => {
    $(p + "-cancel").addEventListener("click", () => close()); $(p + "-close").addEventListener("click", () => close());
    $(p + "-ok").addEventListener("click", ok);
    $(p + "-scrim").addEventListener("mousedown", (e) => { if (e.target === $(p + "-scrim")) close(); });
    $(p + "-scrim").addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const f = [...$(p + "-modal").querySelectorAll("button, input, select")].filter((x) => !x.disabled && x.offsetParent);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
    if (!$("mgm-scrim").hidden) { e.preventDefault(); mgMethodClose(); } else if (!$("mgs-scrim").hidden) { e.preventDefault(); mgSizeClose(); }
  });
  $("mgm-sel").addEventListener("change", () => {
    const G = mgBag(), alloc = $("mgm-sel").value;
    // 切回生效中的方法帶回它現在的參數;換到別的方法用它宣告的那組,兩邊都宣告的 key 沿用用戶調過的值
    mgmPend = { alloc, params: alloc === G.alloc ? Object.assign({}, G.params) : mgFitParams(mgMethod(alloc), mgmPend.params) };
    mgMethodFields();
  });
  $("mgm-ask").addEventListener("click", () => { mgMethodClose(); poAskAgent(t("mg.askAgentMsg")); });   // 內建之外的方法跟 agent 討論:丟進輸入框、不送出
}
function mgScrimOpen(id, focusEl) { $("view-ws").inert = true; const sc = $(id); sc.hidden = false; requestAnimationFrame(() => sc.classList.add("open")); if (focusEl) focusEl.focus(); }
function mgScrimClose(id, opener) { const sc = $(id); if (sc.hidden) return; sc.classList.remove("open"); sc.hidden = true; $("view-ws").inert = false; if (opener && opener.isConnected) opener.focus(); else { const b = $("po-opt").querySelector('[data-fk="mg-method"]'); if (b) b.focus(); else $("po-h").focus(); } }
function mgMethodOpen(opener) {
  const G = mgBag(); if (!G.params || !$("mgm-scrim").hidden) return;
  mgmOpener = opener; mgmPend = { alloc: G.alloc, params: Object.assign({}, G.params) };
  const sel = $("mgm-sel"); sel.textContent = "";
  const g1 = document.createElement("optgroup"); g1.label = t("mg.groupBuiltin");
  mgBuiltins().forEach((b) => { const o = trEl("option", "", mgAllocLabel(b.name)); o.value = b.name; g1.appendChild(o); });
  sel.appendChild(g1);
  const cs = mgAllocators();
  if (cs.length) { const g2 = document.createElement("optgroup"); g2.label = t("mg.groupCustom"); cs.forEach((a) => { const o = trEl("option", "", mgAllocLabel(a.name)); o.value = a.name; g2.appendChild(o); }); sel.appendChild(g2); }
  sel.value = G.alloc; mgMethodFields();
  mgScrimOpen("mgm-scrim", sel);
}
function mgMethodClose(focusEl) { mgScrimClose("mgm-scrim", focusEl || mgmOpener); mgmOpener = null; }
function mgMethodFields() {
  const alloc = mgmPend.alloc, a = mgMethod(alloc);
  $("mgm-desc").textContent = alloc === MG_EQUAL ? t("mg.equalDesc") : alloc === MG_SLOPE ? t("mg.slopeDesc") : alloc === MG_SHARPE ? t("mg.sharpeDesc") : a && typeof a.description === "string" ? a.description : "";
  const box = $("mgm-fields"); box.textContent = ""; $("mgm-err").hidden = true;
  const keys = Object.keys(mgmPend.params); $("mgm-params").hidden = !keys.length;   // 方法沒宣告參數(等權)整格不出現
  keys.forEach((k, i) => {
    const v = mgmPend.params[k], row = trEl("div", "mg-pfld"), lab = trEl("label", "mono", k); lab.htmlFor = "mgm-p-" + i; row.appendChild(lab);
    let inp;
    if (typeof v === "boolean") { inp = trEl("select", "mg-sel"); ["true", "false"].forEach((x) => { const o = trEl("option", "", x); o.value = x; inp.appendChild(o); }); inp.value = String(v); }
    else { inp = trEl("input", "amt-in"); inp.type = "text"; if (typeof v === "number") inp.inputMode = "decimal"; inp.value = String(v); inp.spellcheck = false; }
    inp.id = "mgm-p-" + i; inp.dataset.key = k; row.appendChild(inp);
    row.appendChild(trEl("span", "u", k === "lookback" ? t("mg.unitDays") : ""));
    box.appendChild(row);
  });
}
function mgMethodOk() {
  const G = mgBag(), out = Object.assign({}, mgmPend.params);
  for (const f of $("mgm-fields").querySelectorAll("[data-key]")) {
    const k = f.dataset.key, cur = mgmPend.params[k], raw = String(f.value).trim();
    if (typeof cur === "boolean") out[k] = raw === "true";
    else if (typeof cur === "number") {
      const num = Number(raw);
      if (raw === "" || !isFinite(num)) { $("mgm-err").textContent = t("mg.paramInvalid", { k }); $("mgm-err").hidden = false; return; }
      if (k === "lookback" && !mgParamInRange(k, num)) { $("mgm-err").textContent = t("mg.lookbackRange"); $("mgm-err").hidden = false; return; }
      out[k] = num;
    } else out[k] = raw.slice(0, 200);
  }
  const changed = mgmPend.alloc !== G.alloc || Object.keys(out).some((k) => out[k] !== G.params[k]) || Object.keys(G.params).length !== Object.keys(out).length;
  if (changed) { G.alloc = mgmPend.alloc; G.params = out; G.shortDismissed = false; G.err = null; }
  mgMethodClose(); TR.sig.opt = null; mgPaint();
  const b = $("po-opt").querySelector('[data-fk="mg-method"]'); if (b) b.focus();
}
function mgSizeOpen(opener) {
  const G = mgBag(); if (!mpsProp() || !$("mgs-scrim").hidden) return;
  mgsOpener = opener;
  const s = G.sizing, fund = mpsFundOf(s), prop = mpsProp(), series = mpsSeriesOf(prop);
  mgsDraft = { method: mpsMethodOf(s, series), methodDirty: false, fund: fund === null ? "" : String(fund), fund0: fund, fundDirty: false, t: {}, t0: {}, dirty: {}, oldMsg: false };
  MPS_METHODS.forEach((m) => { const v = mpsTargetOf(s, m, prop); mgsDraft.t0[m] = v; mgsDraft.t[m] = v === null ? "" : m === "vol" ? v.toFixed(1) : m === "lev" ? v.toFixed(2) : String(Math.round(v * 10) / 10); mgsDraft.dirty[m] = false; });
  mgSizeRender();
  mgScrimOpen("mgs-scrim", $("mgs-body").querySelector('.mg-size-seg [aria-checked="true"]'));
  trackFeature("mg_sizing_open");
}
function mgSizeClose(focusEl) { mgScrimClose("mgs-scrim", focusEl || mgsOpener); mgsOpener = null; }
function mgSizeNum(s, unitRe) { const x = String(s == null ? "" : s).trim().replace(unitRe, "").replace(/,/g, "").trim(); if (!/^(\d+\.?\d*|\.\d+)$/.test(x)) return null; const v = parseFloat(x); return isFinite(v) && v > 0 ? v : null; }
/* 草稿 → {sizing, bad}:動過但看不懂 = bad(確定停用);清空 = 回預設(跟著優化結果走)。
   沒動過的格:已有明確值的照舊;還是預設(null)的本金與所選方法的目標,把開框時那個值釘下來——按確定就是認了畫面上的值(Wei 10-16)。
   釘未取整的原值(t0),不釘框裡 toFixed 過的字:歷史波動 10.63% 釘成 10.6 會讓槓桿變 0.997、按確定整張表就動一下。
   方法只在點過分段時才寫:最大回撤暫時不能用時畫面退回目標波動,沒點就按確定不准把存著的最大回撤改掉 */
function mgSizeParse(d) {
  const out = mpsSizingClean(mgBag().sizing), ccy = mpsCcy(); let bad = false;
  if (d.methodDirty) out.method = d.method;
  if (d.fundDirty) {
    if (String(d.fund).trim() === "") { out.fund = null; out.fundCcy = null; }
    else if ((out.fund = mgSizeNum(d.fund, /\s*[A-Za-z]+$/)) === null) bad = true; else out.fundCcy = ccy;
  }
  MPS_METHODS.forEach((m) => { if (!d.dirty[m]) return; if (String(d.t[m]).trim() === "") out.target[m] = null; else if ((out.target[m] = mgSizeNum(d.t[m], /\s*[%×xX]$/)) === null && m === d.method) bad = true; });
  if (bad) return { sizing: out, bad };
  return { sizing: mpsSizingPin(out, ccy, d.fundDirty ? 0 : d.fund0, d.method, d.dirty[d.method] ? 0 : d.t0[d.method]), bad };
}
function mgSizeField(id, label, value, unit, mode, onInput) {
  const f = trEl("div", "mg-fld"), l = trEl("label", "mg-fld-l", label); l.htmlFor = id; f.appendChild(l);
  const w = trEl("span", "mg-unitw"), inp = trEl("input", "amt-in"); inp.type = "text"; inp.id = id; inp.inputMode = mode; inp.autocomplete = "off"; inp.value = value;
  inp.addEventListener("input", () => onInput(inp.value)); w.appendChild(inp);
  if (unit) w.appendChild(trEl("span", "u", unit));
  f.appendChild(w); return f;
}
function mgSizePreview(pv) {
  const r = mgSizeParse(mgsDraft); $("mgs-ok").disabled = r.bad; pv.textContent = "";
  const prop = mpsProp() || {}, days = [prop.vol_window_days, prop.history_days].filter((v) => typeof v === "number" && isFinite(v) && v > 0)[0];
  mpsPreview(r.sizing).forEach((c) => {
    const cell = trEl("div", ""), k = trEl("div", "k", t({ lev: "sz.lev", vol: "sz.pv.vol", mdd: "sz.pv.mdd", amt: "sz.pv.amt" }[c.k]));
    if (c.k === "vol" && days) k.title = t("sz.pv.volTip", { n: String(Math.round(days)) });
    if (c.k === "mdd") k.title = t("sz.pv.mddTip");
    const v = trEl("div", "v" + (c.warn ? " warn" : ""), c.v === null ? "—" : c.v);
    if (c.v !== null && c.unit) v.appendChild(trEl("small", "", c.unit));
    cell.append(k, v); pv.appendChild(cell);
  });
}
// 提案沒有 port_returns:雲端 workspace 早於 2026-10-13-l 就是主機舊、要先更新;夠新代表這份是更新前算的,重跑就有。
// 本機 workspace 跟著 app 一起換,不會是主機舊
const MPS_RETURNS_CV = "2026-10-13-l";
function mpsCvKey(v) { const m = /^(\d{4}-\d{2}-\d{2})(?:-([a-z]+))?$/.exec(typeof v === "string" ? v : ""); return m ? [m[1], (m[2] || "").length, m[2] || ""] : null; }
function mpsCvBefore(v, min) { const a = mpsCvKey(v), b = mpsCvKey(min); if (!a || !b) return true; for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; }
function mpsNoReturnsKey() {
  if (TR.env !== "cloud") return "sz.staleMdd";
  return mpsCvBefore(((TR.st && TR.st.cloud) || {}).config_version, MPS_RETURNS_CV) ? "sz.oldMdd" : "sz.staleMdd";
}
function mgSizeRender() {
  const d = mgsDraft, body = $("mgs-body"), pv = trEl("div", "mg-size-pv"), series = mpsSeriesOf(mpsProp());
  body.textContent = "";
  const fundF = mgSizeField("mgs-fund", t("mg.fund"), d.fund, mpsCcy(), "numeric", (v) => { d.fund = v; d.fundDirty = true; mgSizePreview(pv); });
  fundF.querySelector("label").title = t("mg.fundTip");
  body.appendChild(fundF);
  const mf = trEl("div", "mg-fld"); mf.appendChild(trEl("span", "mg-fld-l", t("mg.tbMethod")));
  const seg = trEl("div", "mg-size-seg"); seg.setAttribute("role", "radiogroup"); seg.setAttribute("aria-label", t("mg.tbMethod"));
  // 原因點名是最大回撤不能用(設計最終稽核:原本只講「主機版本較舊」,看不出被擋的是哪個)
  const old = trEl("p", "ps-hint mg-size-old", mpsProp() && "port_returns" in mpsProp() ? t("sz.shortMdd") : t(mpsNoReturnsKey())); old.hidden = !d.oldMsg;
  MPS_METHODS.forEach((m) => {
    const b = trEl("button", "", t({ vol: "sz.m.vol", mdd: "sz.m.mdd", lev: "sz.m.lev" }[m])); b.type = "button"; b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", m === d.method ? "true" : "false"); b.dataset.m = m;
    const ok = m !== "mdd" || !!series;
    if (!ok) b.disabled = true;   // 舊主機／共同資料不夠:真的停用,原因常駐寫在分段下面(同網頁 8fb666c2)
    b.addEventListener("click", () => { if (!ok) return; if (m === d.method) return; d.method = m; d.methodDirty = true; mgSizeRender(); const on = body.querySelector('.mg-size-seg [data-m="' + m + '"]'); if (on) on.focus(); });
    seg.appendChild(b);
  });
  if (!series) old.hidden = false;   // 最大回撤不能選:原因常駐(不是點了才出現)
  mf.append(seg, old); body.appendChild(mf);
  const m = d.method;
  body.appendChild(mgSizeField("mgs-t", t({ vol: "sz.t.vol", mdd: "sz.t.mdd", lev: "sz.lev" }[m]), d.t[m], m === "lev" ? "×" : "%", "decimal", (v) => { d.t[m] = v; d.dirty[m] = true; mgSizePreview(pv); }));
  body.appendChild(pv); mgSizePreview(pv);
}
function mgSizeOk() {
  const r = mgSizeParse(mgsDraft); if (r.bad) return;
  const G = mgBag(); G.sizing = r.sizing; G.sizingSet = true; mgSave(TR, MG_SIZE_KEY, G.sizing);
  trackFeature("mg_sizing_set");
  mgSizeClose(); TR.sig.opt = null; mgPaint();
  const chip = $("po-opt").querySelector(".mg-size-btn"); if (chip) chip.focus();   // 重建後原本那顆不在了
}
