// 自動下單「還沒選策略／還沒設金額」的導引(spec-autotrade-empty v3,0.1.26)。不起 Electron。
//   ① trZCase:每一種報告 × 候選清單 × 有沒有沒存的勾選 → 缺哪一步(pick / noStrat / noVenue / amt / draft / 不歸這份管)
//   ② trZGuide:每一種組合(情況 × 純 Z × 還沒啟動 × 等回報 × 等待中 × 分頁)→ 頁首鈕、實心、狀態行、原因行、部位霧、aria-describedby;
//      列舉全部組合驗不變式(同一個動作只有一顆鈕、同一句不講兩次、等待中不出霧)
//   ③ 文案逐字照 spec §6;trHeadText 只換那兩處;部位霧卡的字、鈕、id;接線
// 跑法:node tests/check_shell_autotrade_empty.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "trade.js"), "utf8"), psrc = fs.readFileSync(path.join(R, "portfolio.js"), "utf8");
let red = 0; const ok = (name, c, info) => { console.log((c ? "PASS  " : "FAIL  ") + name + (c || info === undefined ? "" : "\n      " + info)); if (!c) red++; };
const J = JSON.stringify;
const cutF = (s, n) => { const i = s.indexOf("function " + n + "("); if (i < 0) throw new Error("no " + n); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return (s.slice(i - 6, i) === "async " ? "async " : "") + s.slice(i, k + 1); } throw new Error("no " + n); };
const pure = src.slice(src.indexOf("/* ── 純邏輯("), src.indexOf("/* ── 純邏輯到此"));
const P = vm.createContext({ console });
vm.runInContext(pure.replace(/^const /gm, "var "), P);
const run = (code) => vm.runInContext(code, P);
P.$in = null; const call = (fn, ...a) => { P.$in = a; return run(fn + "(...$in)"); };

// ── ① trZCase ──
const V = { binance: { credentials: true, pair: true, order: true, account: true } };
const rep = (config, extra) => ({ venues: V, config, ...extra });
const L = [{ name: "btc", displayName: "BTC", hasBacktest: true, symbol: "BTCUSDT" }, { name: "tw", displayName: "2330", hasBacktest: true, symbol: "2330", twd: true }, { name: "txf", displayName: "TXF", hasBacktest: true, symbol: "TXF" }, { name: "draft", displayName: "Draft", hasBacktest: false }];
const rows = (list, venue) => call("trPickRows", list, [], true, venue === "paper", venue === "president" || venue === "capital", {});
const C = (r, rw, draft) => call("trZCase", r, rw, draft);
const cases = [
  ["沒有報告", null, rows(L, "binance"), null],
  ["設定檔讀不到(config: null)", rep(null), rows(L, "binance"), null],
  ["沒有 config、但有對帳快照(讀不到設定)", { venues: V, last_reconcile: { ts: 1 } }, rows(L, "binance"), null],
  ["有金額 > 0(一般狀態)", rep({ amounts: { btc: 100 } }), rows(L, "binance"), null],
  ["有金額但這家下不了(統一綁著、加密策略有錢)", { venues: { president: V.binance }, config: { amounts: { btc: 100 }, exchanges: { btc: "president" } } }, rows(L, "president"), null],
  ["重新綁定後沒路由(金額 0 的成員也算)", rep({ amounts: { btc: 0 }, exchanges: {} }), rows(L, "binance"), null],
  ["沒選、清單還沒載入", rep({ amounts: {} }), null, "pick"],
  ["沒選、有能勾的", rep({ amounts: {} }), rows(L, "binance"), "pick"],
  ["沒選、沒有 config 欄位(從沒設定過)", { venues: V }, rows(L, "binance"), "pick"],
  ["沒選、一支回測完成的都沒有(只有草稿)", rep({ amounts: {} }), rows([L[3]], "binance"), "noStrat"],
  ["沒選、清單是空的", rep({ amounts: {} }), rows([], "binance"), "noStrat"],
  ["沒選、統一只下台指期、只有加密與台股", { venues: { president: V.binance }, config: { amounts: {} } }, rows([L[0], L[1]], "president"), "noVenue"],
  ["沒選、統一、有一支台指期", { venues: { president: V.binance }, config: { amounts: {} } }, rows(L, "president"), "pick"],
  ["沒選、模擬交易、只有台股", { venues: { paper: V.binance }, config: { amounts: {} } }, rows([L[1]], "paper"), "noVenue"],
  ["沒選、模擬交易、台股＋加密", { venues: { paper: V.binance }, config: { amounts: {} } }, rows([L[0], L[1]], "paper"), "pick"],
  ["選了、金額全 0", rep({ amounts: { btc: 0, txf: 0 } }), rows(L, "binance"), "amt"],
  ["選了、金額 0 與負數(壞值不算有錢)", rep({ amounts: { btc: 0, txf: -5 } }), rows(L, "binance"), "amt"],
  // Z-draft(0.1.26):已存一支都沒有、選擇策略框有沒存的勾選;已存有成員、有金額、讀不到設定時草稿不改判斷
  ["沒選、有沒存的勾選", rep({ amounts: {} }), rows(L, "binance"), "draft", true],
  ["從沒設定過、有沒存的勾選", { venues: V }, rows(L, "binance"), "draft", true],
  ["沒選、有沒存的勾選、清單還沒載入", rep({ amounts: {} }), null, "draft", true],
  ["選了、金額全 0、又勾了別支沒存", rep({ amounts: { btc: 0 } }), rows(L, "binance"), "amt", true],
  ["有金額、又勾了別支沒存", rep({ amounts: { btc: 100 } }), rows(L, "binance"), null, true],
  ["設定檔讀不到、有沒存的勾選", rep(null), rows(L, "binance"), null, true],
  ["沒路由、有沒存的勾選", rep({ amounts: { btc: 0 }, exchanges: {} }), rows(L, "binance"), null, true],
];
cases.forEach(([name, r, rw, want, draft]) => { const got = C(r, rw, draft); ok("trZCase:" + name + " → " + want, got === want, J(got)); });

// ── ② trZGuide:spec 表上每一格 ──
const G = (o) => call("trZGuide", o);
const LINE = { pick: "tr.startOffNoPick", noStrat: "tr.startOffNoStrat", noVenue: "tr.startOffNoVenueStrat", amt: "tr.startOffZeroAmt", draft: "tr.startOffDraft" };
const BTN = { pick: "tr.pick", noStrat: "ns.chip", noVenue: "ns.chip", amt: "po.goAmounts", draft: "po.goAmounts" };
const rowsSpec = [
  // [名稱, 輸入, 期望]
  ["Z-pick 還沒啟動、總覽:實心〔選擇策略〕,狀態行「還沒選策略。」、原因行空,說明指狀態行", { zc: "pick", pure: true, dead: true, tab: "over" },
    { fog: "pick", fogOn: false, btn: "tr.pick", fill: true, status: "tr.startOffNoPick", reason: null, desc: "tr-desc" }],
  ["Z-pick 還沒啟動、部位:霧＋卡,頁首鈕藏、狀態行與原因行都空,說明指卡上那句", { zc: "pick", pure: true, dead: true, tab: "pos" },
    { fog: "pick", fogOn: true, btn: null, fill: true, status: "", reason: null, desc: "tr-pos-fog-msg" }],
  ["Z-pick 還沒啟動、資產／交易歷史／設定:同總覽", { zc: "pick", pure: true, dead: true, tab: "assets" },
    { fog: "pick", fogOn: false, btn: "tr.pick", fill: true, status: "tr.startOffNoPick", reason: null, desc: "tr-desc" }],
  ["Z-new(沒有回測完成的)、總覽:實心〔新增策略〕", { zc: "noStrat", pure: true, dead: true, tab: "over" },
    { fog: "noStrat", fogOn: false, btn: "ns.chip", fill: true, status: "tr.startOffNoStrat", reason: null, desc: "tr-desc" }],
  ["Z-new(這家全鎖)、部位:霧＋卡", { zc: "noVenue", pure: true, dead: true, tab: "pos" },
    { fog: "noVenue", fogOn: true, btn: null, fill: true, status: "", reason: null, desc: "tr-pos-fog-msg" }],
  ["Z-draft 還沒啟動、總覽:實心〔設定金額〕,狀態行「勾好的策略還沒儲存。」", { zc: "draft", pure: true, dead: true, tab: "over" },
    { fog: "draft", fogOn: false, btn: "po.goAmounts", fill: true, status: "tr.startOffDraft", reason: null, desc: "tr-desc" }],
  ["Z-draft 還沒啟動、部位:霧＋卡,頁首鈕藏、狀態行與原因行都空,說明指卡上那句", { zc: "draft", pure: true, dead: true, tab: "pos" },
    { fog: "draft", fogOn: true, btn: null, fill: true, status: "", reason: null, desc: "tr-pos-fog-msg" }],
  ["Z-draft 存檔中／等回報(等待中):部位不出霧", { zc: "draft", pure: true, dead: true, wait: true, tab: "pos" },
    { fog: null, fogOn: false, btn: "po.goAmounts", fill: true, status: "tr.startOffDraft", reason: null, desc: "tr-desc" }],
  ["Z-amt、部位:不上霧,實心〔設定金額〕照出", { zc: "amt", pure: true, dead: true, tab: "pos" },
    { fog: null, fogOn: false, btn: "po.goAmounts", fill: true, status: "tr.startOffZeroAmt", reason: null, desc: "tr-desc" }],
  ["Z-pick 已暫停(沒有解除暫停):狀態行照舊,原因行「還沒選策略。」", { zc: "pick", pure: true, dead: false, tab: "over" },
    { fog: "pick", fogOn: false, btn: "tr.pick", fill: true, status: null, reason: "tr.startOffNoPick", desc: "tr-noamt" }],
  ["Z-pick 已暫停、部位:原因行收起(卡上那句是唯一的導引)", { zc: "pick", pure: true, dead: false, tab: "pos" },
    { fog: "pick", fogOn: true, btn: null, fill: true, status: null, reason: null, desc: "tr-pos-fog-msg" }],
  ["Z-pick 已暫停、有〔解除暫停〕(不是純 Z):頁首照現行;部位照樣上霧", { zc: "pick", pure: false, dead: false, tab: "pos" },
    { fog: "pick", fogOn: true, btn: null, fill: true, status: null, reason: undefined, desc: "tr-noamt" }],
  ["下單程式在跑、沒有金額(不是純 Z):沒有頁首鈕,部位照樣上霧", { zc: "noStrat", pure: false, dead: false, tab: "pos" },
    { fog: "noStrat", fogOn: true, btn: null, fill: true, status: null, reason: undefined, desc: "tr-noamt" }],
  ["沒路由／這家下不了(zc = null、純 Z):描邊〔到策略組合〕照舊,原因行照 zv", { zc: null, pure: true, dead: true, tab: "pos" },
    { fog: null, fogOn: false, btn: "po.goCfg", fill: false, status: null, reason: undefined, desc: "tr-noamt" }],
  ["存完等回報(雲端):不出霧、不出頁首鈕、狀態行空,原因行是等回報那句", { zc: "pick", pure: true, dead: true, pend: "tr.cloud.startPendAmounts", wait: true, tab: "pos" },
    { fog: null, fogOn: false, btn: null, fill: true, status: "", reason: "tr.cloud.startPendAmounts", desc: "tr-noamt" }],
  ["清單還沒載入／第一次讀帳還沒回來／正在存(等待中):部位不出霧,頁首照講缺哪一步", { zc: "pick", pure: true, dead: true, wait: true, tab: "pos" },
    { fog: null, fogOn: false, btn: "tr.pick", fill: true, status: "tr.startOffNoPick", reason: null, desc: "tr-desc" }],
  ["一般狀態(zc = null、不是 Z):什麼都不動", { zc: null, pure: false, dead: true, tab: "over" },
    { fog: null, fogOn: false, btn: null, fill: false, status: null, reason: undefined, desc: "tr-noamt" }],
];
rowsSpec.forEach(([name, o, want]) => { const g = G(o), got = {}; Object.keys(want).forEach((k) => { got[k] = g[k]; }); ok("trZGuide:" + name, J(got) === J(want) && Object.keys(want).every((k) => got[k] === want[k]), J(got)); });

// 列舉:每一種組合都守住同一套不變式
{ const bad = [];
  ["pick", "noStrat", "noVenue", "amt", "draft", null].forEach((zc) => [true, false].forEach((pure) => [true, false].forEach((dead) => [null, "tr.cloud.startPendAmounts"].forEach((pend) => [true, false].forEach((wait0) =>
    ["over", "pos", "assets", "hist", "set", null].forEach((tab) => {
      const wait = wait0 || !!pend, o = { zc, pure, dead, pend, wait, tab }, g = G(o), tag = J(o) + " → " + J(g);
      if (g.fog && wait) bad.push("等待中出霧 " + tag);
      if (g.fog && !(zc === "pick" || zc === "noStrat" || zc === "noVenue" || zc === "draft")) bad.push("金額 0／不歸這份管卻上霧 " + tag);
      if (g.fogOn !== (!!g.fog && tab === "pos")) bad.push("霧只在部位分頁 " + tag);
      if (g.btn && g.fogOn) bad.push("霧開著頁首鈕還在(同一個動作兩顆鈕) " + tag);
      if (g.btn && !pure) bad.push("不是純 Z 卻出頁首導引鈕 " + tag);
      if (g.btn && pend) bad.push("等回報時出頁首導引鈕 " + tag);
      if (zc && g.btn && g.btn !== BTN[zc]) bad.push("鈕字不是那一步 " + tag);
      if (g.fill !== !!zc) bad.push("實心只給缺哪一步那顆 " + tag);
      if (g.status && g.reason && g.status === g.reason) bad.push("狀態行與原因行講同一句 " + tag);
      if (g.fogOn && pure && (g.status || g.reason)) bad.push("霧開著頁首還有句子 " + tag);
      if (g.status !== null && !(pure && dead && zc)) bad.push("只有純 Z、還沒啟動才換狀態行 " + tag);
      if (zc && pure && !pend && !g.fogOn && ![g.status, g.reason].includes(LINE[zc])) bad.push("頁首沒講缺哪一步 " + tag);
      if (pend && pure && zc && g.reason !== pend) bad.push("等回報那句不是唯一的訊息 " + tag);
      if (g.desc === "tr-pos-fog-msg" && !g.fogOn) bad.push("說明指向不在畫面上的卡 " + tag);
      if (g.desc === "tr-desc" && !g.status) bad.push("說明指向空的狀態行 " + tag);
    }))))));
  ok("trZGuide 列舉 " + 6 * 2 * 2 * 2 * 2 * 6 + " 種組合:等待中不出霧、霧只在部位、一個動作一顆鈕、實心只給那一步、同一句不講兩次、說明指向畫面上那一句", !bad.length, bad.slice(0, 6).join("\n      ")); }

// ── ③ 文案(spec §6,zh 基準)──
const S = {}; { const sj = fs.readFileSync(path.join(R, "strings.js"), "utf8"), ctx = vm.createContext({}); vm.runInContext(sj.replace(/^const STRINGS\s*=/m, "this.STRINGS =").replace(/^(?:const|let|var) (\w+)\s*=/gm, "this.$1 ="), ctx);
  const tbl = ctx.STRINGS || Object.values(ctx).find((v) => v && v.zh && v.en); S.zh = tbl.zh; S.en = tbl.en; }
const COPY = {
  "tr.startOffNoPick": ["還沒選策略。", "No strategies picked yet."],
  "tr.startOffNoStrat": ["還沒有回測完成的策略。", "No backtested strategies yet."],
  "tr.startOffZeroAmt": ["策略金額都是 0。", "Every strategy amount is 0."],
  "tr.startOffNoVenueStrat": ["還沒有{venue}能下的策略。", "No strategies {venue} can trade yet."],
  "tr.fogPosPick": ["選好策略，就能啟動下單。", "Pick strategies to start trading."],
  "tr.fogPosNew": ["請代理做一支策略，回測完成就能下單。", "Ask the agent for a strategy. Once it’s backtested, it can trade."],
  "po.goAmounts": ["設定金額", "Set amounts"],
  "tr.startOffDraft": ["勾好的策略還沒儲存。", "Picked strategies aren’t saved yet."],
  "tr.runningZDraft": ["下單程式在跑 · 勾好的策略還沒儲存", "Order program running · picked strategies aren’t saved yet"],
  "tr.runningZPick": ["下單程式在跑 · 還沒選策略", null], "tr.runningZNoStrat": ["下單程式在跑 · 還沒有回測完成的策略", null],
  "tr.runningZNoVenue": ["下單程式在跑 · 還沒有{venue}能下的策略", null], "tr.runningZZero": ["下單程式在跑 · 策略金額都是 0", null],
  "tr.pick": ["選擇策略", null], "ns.chip": ["新增策略", null],
};
Object.keys(COPY).forEach((k) => { const [zh, en] = COPY[k]; ok("文案 " + k + " zh 逐字" + (en ? "、en 逐字" : "、en 存在"), S.zh[k] === zh && (en ? S.en[k] === en : !!S.en[k]), J([S.zh[k], S.en[k]])); });
ok("tr.startOffNoAmtShort 兩語都刪了(沒人用)", !("tr.startOffNoAmtShort" in S.zh) && !("tr.startOffNoAmtShort" in S.en) && !/startOffNoAmtShort/.test(src + psrc));
ok("每個情況的原因句、按鈕字都在表裡(兩語)", Object.values(LINE).concat(Object.values(BTN), ["po.goCfg"]).every((k) => S.zh[k] && S.en[k]));
ok("新增的句子不提哪個市場不能自動下單(Wei 10-16 更正:不擋股票)", Object.keys(COPY).every((k) => !/股票|台股|stock/i.test(S.zh[k] + " " + S.en[k])));

// trHeadText:只換「還沒有策略設定金額」與 dead 分支自己那句,其餘原樣
{ const ctx = vm.createContext({ console, LANG: "zh" });
  vm.runInContext(pure.replace(/^const /gm, "var "), ctx);
  vm.runInContext(["trHeadText", "trRunZText", "trZVars"].map((n) => cutF(src, n)).join("\n"), ctx);
  Object.assign(ctx, { t: (k, v) => (S.zh[k] || k).replace("{venue}", v && v.venue ? v.venue : "{venue}"), trVenueId: () => "president", trVenueLabel: () => "統一期貨", trZRows: () => ctx.ROWS, trZDraft: () => !!ctx.DRAFT });
  const H = (state, stText, report, zg) => { ctx.ST = stText; ctx.REP = report; vm.runInContext("trStateText = () => ST; trReport = () => REP", ctx); ctx.ZG = zg; return vm.runInContext(`trHeadText(${J(state)}, ZG)`, ctx); };
  const z = S.zh, empty = { venues: V, config: { amounts: {} } };
  ctx.ROWS = [{ name: "a", locked: false }];
  const pickDead = H("dead", z["tr.notStarted"], empty, G({ zc: "pick", pure: true, dead: true, tab: "over" }));
  const pickDeadLast = H("dead", z["tr.notStarted"] + " · " + z["tr.lastRun"], empty, G({ zc: "pick", pure: true, dead: true, tab: "over" }));
  const fogDead = H("dead", z["tr.notStarted"], empty, G({ zc: "pick", pure: true, dead: true, tab: "pos" }));
  const venueDead = H("dead", z["tr.notStarted"], empty, G({ zc: "noVenue", pure: true, dead: true, tab: "over" }));
  const funded = H("dead", z["tr.notStarted"], { venues: V, config: { amounts: { a: 1 } } }, G({ zc: null, pure: false, dead: true, tab: "over" }));
  const died = H("dead", "停了 · x", empty, G({ zc: "pick", pure: true, dead: false, tab: "over" }));
  const boot = H("dead", "booting", empty, G({ zc: "pick", pure: true, dead: true, tab: "over" }));
  const halted = H("halted", z["tr.halted"] + " · x", empty, G({ zc: "pick", pure: true, dead: false, tab: "over" }));
  ok("trHeadText:純 Z 還沒啟動 → 「還沒選策略。」取代「尚未啟動下單(· 上次執行)」;霧開著空著;{venue} 帶入;有金額、還沒啟動照舊「尚未啟動下單」",
    pickDead === "還沒選策略。" && pickDeadLast === "還沒選策略。" && fogDead === "" && venueDead === "還沒有統一期貨能下的策略。" && funded === z["tr.notStarted"], J([pickDead, pickDeadLast, fogDead, venueDead, funded]));
  ok("trHeadText:異常停止、統一開機中(不是「尚未啟動下單」那句)、已暫停照舊", died === "停了 · x" && boot === "booting" && halted === z["tr.halted"] + " · x", J([died, boot, halted]));
  const runs = [["pick", [{ locked: false }], { amounts: {} }, "下單程式在跑 · 還沒選策略"], ["noStrat", [], { amounts: {} }, "下單程式在跑 · 還沒有回測完成的策略"],
    ["noVenue", [{ locked: true }], { amounts: {} }, "下單程式在跑 · 還沒有統一期貨能下的策略"], ["amt", [{ locked: false }], { amounts: { a: 0 } }, "下單程式在跑 · 策略金額都是 0"]];
  const got = runs.map(([, rw, cfg]) => { ctx.ROWS = rw; return H("running", z["tr.runningZ"], { venues: V, config: cfg }, G({ zc: null })); });
  ctx.ROWS = [{ locked: false }]; ctx.DRAFT = true;
  const draftRun = H("running", z["tr.runningZ"], empty, G({ zc: null })), draftAmt = H("running", z["tr.runningZ"], { venues: V, config: { amounts: { a: 0 } } }, G({ zc: null }));
  ctx.DRAFT = false;
  ok("trHeadText:下單程式在跑、已存一支都沒有、有沒存的勾選 → 「下單程式在跑 · 勾好的策略還沒儲存」;已存有成員照「策略金額都是 0」", draftRun === "下單程式在跑 · 勾好的策略還沒儲存" && draftAmt === "下單程式在跑 · 策略金額都是 0", J([draftRun, draftAmt]));
  const pref = H("running", "串接失敗 · " + z["tr.runningZ"], empty, G({ zc: null }));
  const venueAmt = H("running", z["tr.runningZ"], { venues: { president: V.binance }, config: { amounts: { a: 5 }, exchanges: { a: "president" } } }, G({ zc: null }));
  ok("trHeadText:下單程式在跑、沒有金額 → 三分(還沒選策略／還沒有回測完成的或這家能下的策略／策略金額都是 0);前綴照接;有金額但這家下不了照舊那一句",
    J(got) === J(runs.map((x) => x[3])) && pref === "串接失敗 · 下單程式在跑 · 還沒選策略" && venueAmt === z["tr.runningZ"], J([got, pref, venueAmt])); }

// 部位霧:卡上一句一顆鈕,示意底是部位的四欄表(寫死、不上紅綠)
{ const El = class { constructor(tag, cls, text) { this.tag = tag; this.className = cls || ""; this.textContent = text || ""; this.kids = []; this.dataset = {}; this.on = {}; this.id = ""; }
    setAttribute() {} appendChild(c) { this.kids.push(c); return c; } append(...c) { this.kids.push(...c); } addEventListener(e, f) { this.on[e] = f; } };
  const fx = { go: [], ns: [], tm: [] }, flat = (n, out = []) => { if (n && typeof n === "object") { out.push(n); (n.kids || []).forEach((k) => flat(k, out)); } return out; };
  const fctx = vm.createContext({ TR: { env: "local" }, t: (k, v) => (v ? k + "|" + J(v) : k), trEl: (tag, cls, text) => new El(tag, cls, text), trPickOff: () => false, psOpen: () => {}, cxModalOpen: () => {},
    trZGo: (k, b) => fx.go.push([k, b.id]), trackFeature: (n) => fx.tm.push(n), nsOpen: (b) => fx.ns.push(b.id), poFogCfg: () => new El("div", "cfg-under"), poFogOver: () => new El("div", "over-under"),
    document: { createElement: (tag) => new El(tag), createDocumentFragment: () => new El("#frag") },
    trSec: (...c) => { const e = new El("div", "pf-sec"); e.kids.push(...c); return e; }, trHead: (cols) => { const e = new El("thead"); cols.forEach((c) => e.kids.push(new El("th", c[1], c[0]))); return e; } });
  vm.runInContext(cutF(psrc, "poFog") + "\n" + cutF(psrc, "poFogPos"), fctx);
  const card = (kind) => { const f = vm.runInContext(`poFog(${J(kind)})`, fctx); return { f, msg: f.kids[1].kids[0], btn: f.kids[1].kids[1], under: f.kids[0] }; };
  const pk = card("pos-pick"), nw = card("pos-new"), dr = card("pos-draft"); pk.btn.on.click(); nw.btn.on.click(); dr.btn.on.click();
  ok("部位霧 Z-pick:卡「選好策略，就能啟動下單。」(id tr-pos-fog-msg)＋實心〔選擇策略〕#tr-pos-pick,按下走 trZGo(pick)", pk.msg.textContent === "tr.fogPosPick" && pk.msg.id === "tr-pos-fog-msg"
    && pk.btn.textContent === "tr.pick" && pk.btn.className === "btn-fill" && pk.btn.id === "tr-pos-pick" && J(fx.go[0]) === J(["pick", "tr-pos-pick"]), J([pk.msg, fx.go]));
  ok("部位霧 Z-new:卡「請代理做一支策略，回測完成就能下單。」＋實心〔新增策略〕#tr-pos-new,按下開新增策略框", nw.msg.textContent === "tr.fogPosNew" && nw.msg.id === "tr-pos-fog-msg"
    && nw.btn.textContent === "ns.chip" && nw.btn.className === "btn-fill" && nw.btn.id === "tr-pos-new" && J(fx.go[1]) === J(["noStrat", "tr-pos-new"]));
  ok("部位霧 Z-draft:卡「勾好的策略還沒儲存。」(id tr-pos-fog-msg)＋實心〔設定金額〕#tr-pos-draft,按下走 trZGo(draft);示意底同部位那張", dr.msg.textContent === "tr.startOffDraft" && dr.msg.id === "tr-pos-fog-msg"
    && dr.btn.textContent === "po.goAmounts" && dr.btn.className === "btn-fill" && dr.btn.id === "tr-pos-draft" && J(fx.go[2]) === J(["draft", "tr-pos-draft"]) && J(flat(dr.under).map((n) => n.tag)) === J(flat(pk.under).map((n) => n.tag)), J([dr.msg, fx.go]));
  const tel = fs.readFileSync(path.join(R, "..", "telemetry.js"), "utf8"), wl = (tel.match(/feature_used: \{ name: \[([\s\S]*?)\] \}/) || [, ""])[1];
  ok("埋點:卡上三顆記 trade_fog_pick／trade_fog_new／trade_fog_pick(勾了沒存那張同網頁 trade_pos_fog_pick;≤ 16 字、白名單順序 attach_limit_hit → trade_fog_pick, trade_fog_new → exec_set → po_help_cfg, po_help_opt → lib_mkt_pick,canon product-telemetry.md);頁首導引鈕不記這兩個(分開看)", J(fx.tm) === J(["trade_fog_pick", "trade_fog_new", "trade_fog_pick"])
    && /"attach_limit_hit",[\s\S]*"trade_fog_pick", "trade_fog_new",[\s\S]*"exec_set",[\s\S]*"po_help_cfg", "po_help_opt",[\s\S]*"lib_mkt_pick",[\s\S]*"wd_fold_open"(?:,[\s\S]*)?$/.test(wl.trim()) && fx.tm.every((n) => n.length <= 16)
    && !/trade_fog_/.test(cutF(src, "trPaintGoCfg") + cutF(src, "trZGo")), J([fx.tm, wl.trim().slice(-60)]));
  const all = flat(pk.under), ths = all.filter((n) => n.tag === "th").map((n) => n.textContent), trs = all.filter((n) => n.tag === "tr");
  ok("部位示意底:區段標題「策略組合」、四欄(標的｜目標｜帳上｜差額)、三列 BTC／ETH／SOL、合計 13,000;不上 buy／sell 色;不讀用戶資料",
    all.some((n) => /pf-sec/.test(n.className)) && J(ths) === J(["tr.col.symbol", "tr.col.target", "tr.col.held", "tr.col.diff"]) && trs.length === 3
    && J(trs.map((r) => r.kids[0].textContent)) === J(["BTCUSDT", "ETHUSDT", "SOLUSDT"]) && all.some((n) => n.textContent === "13,000")
    && !all.some((n) => /\b(buy|sell)\b/.test(n.className)) && pk.under.inert === true && !/trReport|TR\.st/.test(cutF(psrc, "poFogPos")), J(ths));
  const old = card("pick"), conn = card("connect");
  ok("配置頁的霧與沒綁交易所的霧不受影響(id tr-pick／tr-connect,卡上那句沒有 id)", old.btn.id === "tr-pick" && old.msg.textContent === "po.fogPick" && !old.msg.id && conn.btn.id === "tr-connect" && !conn.msg.id); }

// 接線
const head = cutF(src, "trPaintHead"), pos = cutF(src, "trPaintPos"), over = cutF(src, "trPaintOver"), go = cutF(src, "trZGo"), now = cutF(src, "trZNow");
ok("頁首:狀態行走 trHeadText(trZNow);原因行、導引鈕、停用鈕的說明都出自同一份 trZNow", /text = trHeadText\(state, trZNow\(state\)\)/.test(head) && /const zg = trZNow\(state, zv, pend\);/.test(head)
  && /trPaintGoCfg\(zg\.btn, zg\.fill, zg\.zc\);/.test(head) && /b\.setAttribute\("aria-describedby", zg\.desc\)/.test(head));
ok("等待中的判準:報告沒到、清單沒載入、第一次讀帳沒回來、選擇策略框開不了(存檔中／讀不到設定／雲端讀不到新狀態)、等回報", /const wait = !trReport\(\) \|\| !TR\.listLoaded \|\| trFirstReadPending\(r\) \|\| trPickOff\(\) \|\| !!pend;/.test(now)
  && /return TR\.save === "saving" \|\| \(cloud && TR\.save === "sent"\) \|\| !TR\.listLoaded \|\| trStored\(\) === null \|\| trCfgUnread\(trReport\(\)\)/.test(cutF(src, "trPickOff")));
ok("Z-draft 的輸入:三個呼叫點(頁首／部位 trZNow、在跑那句 trRunZText、總覽)都帶 trZDraft();草稿判準同金額表的 dirty(trBase 為底、trPickKeep)",
  /const zc = trZCase\(trReport\(\), trZRows\(r\), trZDraft\(\)\);/.test(now) && /const zc = trZCase\(r, trZRows\(r\), trZDraft\(\)\);/.test(cutF(src, "trRunZText"))
  && (src.match(/trZCase\(/g) || []).length === 4 && /const base = trBase\(\); return !!base && trPickDirty\(TR\.picked, base, trPickKeep\(TR\.env, TR\.picked, base, trListNames\(\)\)\);/.test(cutF(src, "trZDraft")));
ok("候選清單跟選擇策略框同一套鎖(能不能下台股、統一／群益只下台指期、舊 lib 的投資組合)", /trPickRows\(TR\.list, \[\], \(r \|\| \{\}\)\.can_trade_portfolio === true, trVenueId\(\) === PAPER, trTwBroker\(trVenueId\(\)\), \{\}\)/.test(cutF(src, "trZRows")));
ok("部位:有霧就上霧(pick → pos-pick,draft → pos-draft,其餘 → pos-new),重畫簽章帶霧的種類;Z-amt 照畫表", /if \(fog\) box\.appendChild\(poFog\(fog === "pick" \? "pos-pick" : fog === "draft" \? "pos-draft" : "pos-new"\)\);\n\s*else box\.appendChild\(poSigTable/.test(pos) && /!!TR\.zBridge, fog, TR_TWN\.v\];/.test(pos));
ok("切分頁時頁首跟著重畫(部位上霧時導引鈕收、狀態行空)", /trPaintHead\(\);[^\n]*\n\s*trPaintTab\(\);\n\}/.test(cutF(src, "trSetTab")));
ok("頁首鈕行為:選擇策略 = 到配置頁開框(opener 是配置頁 #tr-pick,確定後焦點到第一個金額格);設定金額 = 到配置頁、焦點第一個金額格;新增策略 = nsOpen",
  /if \(kind === "noStrat" \|\| kind === "noVenue"\) \{ if \(typeof nsOpen === "function"\) nsOpen\(from\); return; \}/.test(go) && /await poOpen\("cfg"\);/.test(go)
  && /if \(kind !== "pick" && kind !== "amt" && kind !== "draft"\) \{ poOpen\("cfg", true\); return; \}/.test(go) && /if \(kind === "amt" \|\| kind === "draft"\) \{ trFocusFirstAmt\(\); return; \}/.test(go) && /const b = \$\("tr-pick"\);[\s\S]*psToAmt = true; psOpen\(b\);/.test(go)
  && /querySelector\("\.amt-in:not\(:disabled\)"\)/.test(cutF(src, "trFocusFirstAmt")));
ok("選擇策略框:從導引開的,確定後焦點落在第一個金額格;取消回 opener(#tr-pick),旗標在關框時收掉", /const refocus = psToAmt \? trFocusFirstAmt : psRefocus;/.test(cutF(src, "psApply"))
  && !/psRefocus\(\)/.test(cutF(src, "psApply")) && /psOpener = null; psToAmt = false;/.test(cutF(src, "psClose")));
ok("頁首導引鈕:Z 時實心、沒路由／這家下不了描邊;id 不跟配置頁的 #tr-pick 撞", /u\.classList\.toggle\("btn-fill", !!fill\); u\.classList\.toggle\("btn-out", !fill\);/.test(cutF(src, "trPaintGoCfg"))
  && /u\.id = "tr-go-cfg"/.test(cutF(src, "trPaintGoCfg")) && /b\.id = "tr-pos-pick"/.test(psrc));
ok("總覽:Z 時權益曲線、事件沒有資料整區不畫(連標題);讀不到、另一個模式畫得出來照舊", /const z = !!trZCase\(trReport\(\), trZRows\(r\), trZDraft\(\)\);/.test(over) && /box\.appendChild\(trOvCurve\(z\)\);/.test(over)
  && /if \(z && pts\.length < 2 && all\.length < 2 && \(\(trPnlServerPoints\(\) \|\| \{\}\)\.pts \|\| \[\]\)\.length < 2\) return document\.createDocumentFragment\(\);/.test(cutF(src, "trOvCurve"))
  && /if \(!rows\.length && z && !TR\.ov\.uiErr\) return document\.createDocumentFragment\(\);/.test(cutF(src, "trOvEvents")));
ok("部位霧鋪滿整欄(同策略組合頁的霧)", /#tr > \.pf:not\(#tr-onboard\) > \.fog \{ max-width: none; \}/.test(fs.readFileSync(path.join(R, "trade.css"), "utf8")));

if (red) { console.log(red + " FAILED"); process.exit(1); }
console.log("all passed");
