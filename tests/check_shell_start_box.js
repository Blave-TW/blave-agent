// 啟動下單框(Wei 0928 第 3 點 A 案):先選再按。真的 confirmBox / trAskStart / 主鈕的 click 從原文切出來,跑在假 DOM 上。
//   1. 沒選選項:主鈕停用、字是「啟動下單」;就算 disabled 被拿掉,按了也不送任何指令、框不關
//   2. 選了之後:鈕字換成原本那兩顆的字,送出的指令跟改版前一樣——
//      補齊 = resume(這台電腦對帳器沒在跑再補 restart_reconciler)、等新訊號 = resume_wait(同上);雲端只送所選那一個
//   3. 重算中:「補齊部位」不能選、原因句掛在那個選項上(aria-describedby);只有一種啟動方式的舊機:沒有選項、照舊一顆主鈕
//   4. 句子分層(trStartNotes):常駐句與「細節」在 本機 / 雲端 × 模擬 / 真錢 各是哪幾句;真錢第一次細節展開、機器收下指令後才記成看過
//   5. 「只調整 Blave 自己那一份」跟著帳本基準分三種說法(還沒建 / 已建 / 讀不到):把既有的同方向部位算成 Blave 的只發生在
//      帳本還沒有基準的那一次(lib/portfolio._auto_baseline);基準寫了之後每次啟動都不會再算——那時還講「會算進來」是錯的
// 跑法:node tests/check_shell_start_box.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const app = fs.readFileSync(path.join(R, "app.js"), "utf8"), trade = fs.readFileSync(path.join(R, "trade.js"), "utf8"), strings = fs.readFileSync(path.join(R, "strings.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const fn = (src, name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0; for (let k = src.indexOf("{", src.indexOf(")", i)); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("切不出 " + name); };
const okClick = (app.match(/\$\("del-ok"\)\.addEventListener\("click", (async \(e\) => \{[\s\S]*?\n\})\);/) || [])[1];
if (!okClick) throw new Error("找不到主鈕的 click");

// ---- 假 DOM(只夠 confirmBox 用) ----
function El(tag) { this.tag = tag; this.kids = []; this.attrs = {}; this.on = {}; this.cls = new Set(); this.hidden = false; this.disabled = false; this.text = ""; this.dataset = {}; }
Object.assign(El.prototype, {
  appendChild(k) { this.kids.push(k); return k; }, append(...k) { k.forEach((x) => this.kids.push(x)); },
  setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
  addEventListener(k, f) { (this.on[k] = this.on[k] || []).push(f); }, focus() { El.focus = this; }, querySelector() { return new El("x"); },
  all(out = []) { for (const k of this.kids) if (k instanceof El) { out.push(k); k.all(out); } return out; },
  fire(k) { return Promise.all((this.on[k] || []).map((f) => f())); },
});
Object.defineProperty(El.prototype, "className", { get() { return [...this.cls].join(" "); }, set(v) { this.cls = new Set(String(v).split(/\s+/).filter(Boolean)); } });
Object.defineProperty(El.prototype, "classList", { get() { const c = this.cls; return { add: (...a) => a.forEach((x) => c.add(x)), remove: (...a) => a.forEach((x) => c.delete(x)), contains: (x) => c.has(x), toggle: (x, on) => { (on === undefined ? !c.has(x) : on) ? c.add(x) : c.delete(x); } }; } });
Object.defineProperty(El.prototype, "textContent", { get() { return this.text + this.kids.map((k) => (k instanceof El ? k.textContent : String(k))).join(""); }, set(v) { this.kids = []; this.text = v == null ? "" : String(v); } });
const ids = {}; const $ = (id) => ids[id] || (ids[id] = new El("div"));
// 可控的時鐘:armAt(重畫後 600ms 內不算)要能往前撥
let CLOCK = 1_800_000_000_000; class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [CLOCK])); } static now() { return CLOCK; } }

function world(o) {
  const sent = [], store = Object.assign({}, o.store);
  const report = Object.assign({ can_wait_start: true, self_ledger: true }, o.report);
  const env = {
    $, document: { createElement: (tag) => new El(tag) }, requestAnimationFrame: (f) => f(), t: (k) => k, sent, store,
    TR: { env: o.env || "local", st: { report }, startAt: 0, exec: { edit: null } }, Date: FakeDate,
    trReport: () => report, trZView: () => ({ off: !!env.zoff }), envHeadState: () => "halted", trIsPaper: () => o.money === "paper", envMoney: () => o.money || null,
    trBookBaseline: () => o.book || "unknown", envMoneyText: (m) => (m ? "tr.mode." + m : ""), trWhereTidy: (x) => x, trVenueId: () => (o.money === "paper" ? "paper" : o.money ? "binance" : null), trVenueLabel: (id) => id || "", 
    trRestartKind: () => o.restart || null, trRecomputing: () => !!env.recomputing, trBothReal: () => null, planVars: () => ({ h: "0.9", m: "50" }), planMo: () => false,
    trPlanLine: () => o.plan || null, trCatchPlan: (r) => (env.unread && env.unread(r) ? null : env.catchPlan) /* 同真的 trCatchPlan 開頭:部位還沒讀到(trPosUnread)= 不知道 */, trHasAccount: () => env.account !== false, trFirstReadPending: () => !!env.firstRead, trBookFresh: () => o.fresh !== false, trWaitStranded: () => o.stranded || 0, trStored: () => ({}),   // 0.1.24 A6:照策略組合 N 支、合計 ≈ X(格式在 check_shell_portfolio.js 驗)
    trHeldVenue: (res) => (res && res.held) || null, trRecRunning: () => !!o.recRunning, lsGet: (k) => (k in store ? store[k] : null), lsSet: (k, v) => { store[k] = v; },
    trSend: (S, cmd, args, how) => { sent.push(cmd); if (how) env.hows.push(how); return Promise.resolve(o.reply ? o.reply(cmd) : { ok: true }); },
    // 真的 trRun 依序跑每一步、前一步沒成功就停;這裡只留這一條(過場態、紅字不在這支測試的範圍)
    trRun: async (want, steps) => { for (const st of steps) { const r = await st(env.TR); if (!r || !r.ok || env.trHeldVenue(r)) break; } },
    window: { blave: { platform: o.platform || "darwin" } },
    LANG: "zh", trTwName: (s) => ({ "2330": "台積電" })[s] || "",
    // 0.1.60 等訊號:2 秒一讀(trPollSoon)、雲端開爆發窗(ENV.burst);啟動框關掉叫 spStartClosed(策略頁說明行當場重畫)
    trEl: (tag, cls, text) => { const e = new El(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; },
    polls: [], trPollSoon: (ms) => env.polls.push(ms), ENV: { burst: null }, trBurstBump: (b, now, ms) => ({ start: now, until: now + ms }),
    closed: 0, spStartClosed: () => { env.closed++; },
    // 真的 trPosUnread／trPosPending 跑在這份報告上(稽核 release-0160-e 必修 1:永豐 SnapshotLag 期間當還沒讀到帳)
    trVenueIds: (r) => Object.keys((r.account && r.account.venues) || {}), trLiveEntry: (r, id) => ((r.account && r.account.venues) || {})[id] || null,
    AWAKE: o.awake, account: o.account, firstRead: o.firstRead, catchPlan: o.catch === undefined ? null : o.catch, recomputing: !!o.recomputing, hows: [], tracked: [], switched: [], trackFeature: (n) => env.tracked.push(n), laiOn: () => false, envSwitchGuarded: (e) => { env.switched.push(e); return true; },
  };
  const names = Object.keys(env);
  const body = `let delCtx = null; ${fn(app, "cfSupersede")}\n${fn(app, "delOkBusy")}\n${fn(app, "confirmBox")}\n${fn(app, "cfPopToggle")}\n${fn(app, "cfPopEsc")}\n${fn(app, "delClose")}\n${fn(trade, "trCloudBox")}\n${fn(trade, "trTwBroker")}\n${fn(trade, "trExecKey")}\n${fn(trade, "trExecStored")}\n${fn(trade, "trExecCurrent")}\n${fn(trade, "trCatchHow")}\n${fn(trade, "trPadLatin")}\n${fn(trade, "trTidyZh")}\n${fn(trade, "trStartNotes")}\n${fn(trade, "trAwakeCloudGo")}\n${fn(trade, "trDeferredCloseLine")}\n${(trade.match(/^const TR_CHANGED_ARM_MS = [^\n]*\n/m) || [""])[0]}${(trade.match(/^const TR_START_POLL_MS = [^\n]*\n/m) || [""])[0]}${fn(trade, "trCatchSame")}\n${fn(trade, "trPosPending")}\n${fn(trade, "trPosUnread")}\n${fn(trade, "trStartWaitOn")}\n${fn(trade, "trStartReadRefresh")}\n${fn(trade, "trAskStart")}\n
    const click = ${okClick};\n return { trAskStart, trStartNotes, trStartReadRefresh, trStartWaitOn, trPosUnread, delClose, click, ctx: () => delCtx };`;
  const M = new Function(...names, body)(...names.map((k) => env[k]));
  env.unread = M.trPosUnread;
  Object.keys(ids).forEach((k) => delete ids[k]);
  $("del-scrim").hidden = true;
  M.trAskStart(null);
  const opts = $("del-body").all().filter((n) => n.cls.has("cf-opt")).map((row) => ({ row, input: row.kids.find((k) => k.tag === "input"), t: row.kids.filter((k) => k.cls && k.cls.has("cf-opt-t")).map((k) => k.textContent)[0], d: row.kids.find((k) => k.cls && k.cls.has("cf-opt-d")), w: row.kids.find((k) => k.cls && k.cls.has("cf-opt-w")), l: row.kids.find((k) => k.cls && k.cls.has("cf-opt-l")) }));
  const pick = (id) => { const o2 = opts.find((x) => x.input.value === id); opts.forEach((x) => { x.input.checked = x === o2; }); return o2.input.fire("change"); };
  const press = async (detail) => { await M.click({ detail: detail || 1 }); await new Promise((r) => setTimeout(r, 0)); };
  return { M, env, sent, store, opts, pick, press, okb: $("del-ok"), open: () => !$("del-scrim").hidden, body: $("del-body"), modal: $("del-modal"), mark: $("del-mark") };
}

// 讀過帳、沒有要補的單:補齊可選、不預選(下面這幾條測的是指令路由,不是預選;列不出單時補齊停用,見 R1／訊號那幾條)
const NONE = { text: null, n: 0, key: "", items: [] };
(async () => {
  // ---- 1:列不出單(還沒讀過帳等)時預選「等新訊號」,主鈕可按、字跟著預選(0.1.58 起補齊排第一,條件成立才預選它,見下面 §1.4 那組)
  { const w = world({ money: "paper" });
    ok("框開著、「等新訊號」預選、主鈕可按、字是「啟動，等新訊號」、沒有第二顆動作鈕", w.open() && w.opts.length === 2 && w.opts[1].input.checked === true && w.opts[0].input.checked === false
      && w.okb.disabled === false && w.okb.textContent === "tr.startWait" && $("del-alt").hidden === true && w.modal.cls.has("has-choices") && !w.modal.cls.has("has-alt"));
    ok("兩個選項的標題與順序:補齊部位在上、等新訊號在下(0.1.58);焦點在「取消」", w.opts.map((o) => o.t + ":" + o.input.value).join() === "tr.opt.catch:catch,tr.opt.wait:wait" && El.focus === $("del-cancel"));
    await w.press();
    ok("不改選就按:送 resume_wait(＋restart_reconciler)、框關掉", w.sent.join() === "resume_wait,restart_reconciler" && !w.open(), w.sent); }
  // ---- 2
  for (const [env, recRunning, id, want] of [["local", false, "catch", "resume,restart_reconciler"], ["local", true, "catch", "resume"], ["local", false, "wait", "resume_wait,restart_reconciler"], ["local", true, "wait", "resume_wait"],
    ["cloud", false, "catch", "resume"], ["cloud", false, "wait", "resume_wait"]]) {
    const w = world({ env, money: "paper", recRunning, catch: NONE }); await w.pick(id);
    const label = w.okb.textContent, enabled = w.okb.disabled === false;
    await w.press();
    ok(`${env} 選「${id}」(對帳器${recRunning ? "在跑" : "沒在跑"}):鈕字 ${id === "catch" ? "啟動並補齊部位" : "啟動，等新訊號"}、送出 ${want}、框關掉`,
      enabled && label === (id === "catch" ? "tr.startCatchUp" : "tr.startWait") && w.sent.join() === want && !w.open(), { label, sent: w.sent }); }
  { const w = world({ money: "paper", catch: NONE }); await w.pick("wait"); await w.pick("catch"); await w.press();
    ok("改選:以最後選的那個為準", w.sent[0] === "resume" && w.sent.indexOf("resume_wait") < 0, w.sent); }
  { const w = world({ money: "paper", reply: () => ({ ok: false }), catch: NONE }); await w.pick("catch"); await w.press();
    ok("啟動指令沒送成:不補 restart_reconciler", w.sent.join() === "resume", w.sent); }
  // ---- 3
  { const w = world({ money: "paper", recomputing: true }), c = w.opts[0];
    ok("重算中:「補齊部位」停用、說明換成原因句、aria-describedby 指它;「等新訊號」照常可選", c.input.disabled === true && c.row.cls.has("off") && c.d.textContent === "tr.cloud.recomputing"
      && c.input.attrs["aria-describedby"] === c.d.id && !!c.d.id && !c.w && w.opts[1].input.disabled === false);
    await w.pick("wait"); await w.press();
    ok("重算中選等新訊號:送 resume_wait", w.sent[0] === "resume_wait", w.sent); }
  { const w = world({ money: "paper", restart: "app", catch: NONE });
    ok("Blave 重開後:最上面一句狀態句;舊訊號那一句掛在「補齊部位」裡,「等新訊號」沒有", w.body.kids[0].tag === "p" && w.body.kids[0].textContent === "tr.restartStartLineLocal"
      && w.opts[0].w && w.opts[0].w.textContent === "tr.opt.catchStale" && !w.opts[1].w); }
  { const w = world({ money: "real", stranded: 2 }), w0 = world({ money: "real" });
    ok("有策略已經想平的部位(trWaitStranded > 0):提醒掛在「等新訊號」、「補齊部位」不掛;沒有就兩個都不掛",
      w.opts[1].w && w.opts[1].w.textContent === "tr.opt.waitStranded" && !w.opts[0].w && !w0.opts[0].w && !w0.opts[1].w); }
  // 0.1.27 稽核 P2-1:休市時按的全部平倉延到開盤(回報 deferred_close)——兩種啟動都會取消它,框裡先講;舊機只有一顆主鈕也講
  { const w = world({ money: "paper", report: { deferred_close: ["2330@spot"] } }), w0 = world({ money: "paper" }), w1 = world({ money: "paper", report: { can_wait_start: false, deferred_close: ["2330@spot"] } });
    ok("P2-1 有延後的台股平倉:框的狀態句(選項之上、兩種啟動共用)講會取消;沒有就不講;舊機一顆主鈕也講", w.body.kids.some((k) => k.tag === "p" && k.textContent === "tr.deferredClose")
      && !w0.body.all().some((k) => k.textContent === "tr.deferredClose") && w1.body.kids.some((k) => k.textContent === "tr.deferredClose")); }
  { const L = new Function("LANG", "t", "trTwName", fn(trade, "trDeferredCloseLine") + "; return trDeferredCloseLine;")("zh", (k, v) => k + "|" + JSON.stringify(v || {}), (s) => ({ "2330": "台積電" })[s] || "");
    ok("P2-1 那一句列出哪幾檔:代號＋股名、去掉 @spot、最多三檔其餘「和另外 N 檔」;空的、不是陣列 = null",
      L({ deferred_close: ["2330@spot", "2454@spot"] }) === 'tr.deferredClose|{"syms":"2330 台積電、2454"}'
      && L({ deferred_close: ["1101@spot", "1102@spot", "1103@spot", "2330@spot"] }) === 'tr.deferredClose|{"syms":"1101、1102、1103tr.opt.catchMore|{\\"n\\":1}"}'
      && L({ deferred_close: [] }) === null && L({ deferred_close: "2330" }) === null && L({}) === null, L({ deferred_close: ["1101@spot", "1102@spot", "1103@spot", "2330@spot"] }));
    // 稽核 0153 Y2:延後的是台指期(群益、統一的根代號)→ Wei 核准那一句,不列代號;月份代號不是根代號,不算
    ok("Y2 延後的台指期平倉:啟動框講會取消(tr.deferTxfCancel),TXF/MXF/TMF 都認",
      ["TXF", "MXF", "TMF"].every((k) => L({ deferred_close: [k] }) === "tr.deferTxfCancel|{}") && L({ deferred_close: ["TMF", "TXF"] }) === "tr.deferTxfCancel|{}"
      && L({ deferred_close: ["TXFL6"] }) !== "tr.deferTxfCancel|{}", L({ deferred_close: ["TMF"] })); }
  { const w = world({ money: "real", env: "cloud", restart: "machine" });
    ok("主機重開後:狀態句是主機那一句;不掛舊訊號那一句(由重算與閘門講)", w.body.kids[0].textContent === "tr.cloud.restartStartLine" && !w.opts[0].w); }
  { const w = world({ money: "paper", report: { can_wait_start: false }, catch: NONE });
    ok("只有一種啟動方式的舊機:沒有選項、主鈕可按、字是「啟動並補齊部位」", w.opts.length === 0 && w.okb.disabled === false && w.okb.textContent === "tr.startCatchUp" && !w.modal.cls.has("has-choices")
      && w.body.kids.some((k) => k.textContent === "tr.startWarn1"));
    await w.press(); ok("…按下去送 resume(＋restart_reconciler)", w.sent.join() === "resume,restart_reconciler", w.sent); }
  // ---- 0.1.58 補齊排第一、條件成立才預選(spec 0158-catchup-intro §1.3–1.5;每一列 §1.4 情境一次;稽核 0158 M1／M2／B3／B4／B5)----
  { const P = (text, n, items) => ({ text, n, key: "", items: (items || []).map(([k, q, exact]) => ({ k, q, exact: !!exact })) });
    const ONE = P("會買進 BTC 1,200 USDT。", 1, [["+BTCUSDT", 1200]]);
    const cur = () => $("del-body").all().filter((n) => n.cls.has("cf-opt")).map((row) => ({ row, id: row.kids.find((k) => k.tag === "input").value, input: row.kids.find((k) => k.tag === "input"),
      d: row.kids.find((k) => k.cls && k.cls.has("cf-opt-d")), l: row.kids.find((k) => k.cls && k.cls.has("cf-opt-l")), w: row.kids.find((k) => k.cls && k.cls.has("cf-opt-w")) }));
    const sel = () => (cur().find((o) => o.input.checked) || {}).id || null;
    const tail = () => $("del-body").kids.find((k) => k.cls && k.cls.has("cf-tail"));
    const tick = (ms) => { CLOCK += ms; };
    const pickNow = (w, id) => { const all = cur(), o = all.find((x) => x.id === id); all.forEach((x) => { x.input.checked = x === o; }); return o.input.fire("change"); };
    // §1.4 第 1 列:有單、資料新、訊號新
    { const w = world({ money: "real", catch: ONE }), c = cur();
      ok("§1.4 有單、資料新:補齊排第一而且預選、主鈕「啟動並補齊部位」、單另起一行(cf-opt-l)、說明不接「沒有要補的單」",
        c.map((o) => o.id).join() === "catch,wait" && sel() === "catch" && w.okb.textContent === "tr.startCatchUp" && w.okb.disabled === false
        && c[0].l && c[0].l.textContent === ONE.text && c[0].d.textContent === "tr.opt.catchDesc" && !tail());
      ok("§1.4 預選補齊時焦點仍在「取消」(Enter 不送單)、真錢記號照出", El.focus === $("del-cancel") && w.mark.textContent === "tr.mode.real" && w.mark.hidden === false);
      await w.press();
      ok("埋點:單沒變直接送,不送 start_catch_chg", !w.env.tracked.includes("start_catch_chg"), w.env.tracked);
      ok("§1.5 按下時單沒變:送 resume(＋restart_reconciler)、框關、主行程收到 start:catch:catch", w.sent.join() === "resume,restart_reconciler" && !w.open() && w.env.hows.join() === "start:catch:catch", [w.sent, w.env.hows]); }
    { const w = world({ money: "real", catch: ONE }); await w.press(2);
      ok("沒有重畫的框:雙擊的第二下(e.detail > 1)也不算——第一下就是那一下,這裡只按了第二下 → 什麼都沒送", w.sent.length === 0 && w.open()); }
    // 第 2 列:含休市中的台股(那句由 trCatchPlan 接在單後面,同一行;check_shell_portfolio.js 驗句子)
    { const TW = P("會買進 BTC 1,200 USDT、買進 2330 台積電 100 股。 tr.opt.catchTwClosed", 2, [["+BTCUSDT", 1200], ["+2330@spot", 100, true]]), w = world({ money: "paper", catch: TW });
      ok("§1.4 含休市台股:仍預選補齊、休市句跟單同一行、主鈕字不變", sel() === "catch" && cur()[0].l.textContent === TW.text && w.okb.textContent === "tr.startCatchUp"); }
    // 第 3 列:重算中
    { const w = world({ money: "real", catch: ONE, recomputing: true }), c = cur();
      ok("§1.4 重算中:補齊停用、說明換成原因句、不出單;預選等新訊號、主鈕「啟動，等新訊號」", c[0].input.disabled && c[0].d.textContent === "tr.cloud.recomputing" && !c[0].l && sel() === "wait" && w.okb.textContent === "tr.startWait"); }
    // 第 4 列:Blave 重開、訊號舊
    { const w = world({ money: "real", catch: ONE, restart: "app" }), c = cur();
      ok("§1.4 Blave 重開過(訊號舊):單照列、掛 catchStale,但預選等新訊號", c[0].l && c[0].l.textContent === ONE.text && c[0].w.textContent === "tr.opt.catchStale" && sel() === "wait" && w.okb.textContent === "tr.startWait"); }
    // 第 5 列:讀過帳、沒有要補的單
    { const w = world({ money: "real", catch: P(null, 0) }), c = cur();
      ok("§1.4 讀過帳沒有單:說明後接「現在沒有要補的單。」(zh 不墊空格)、不出單那行、預選等新訊號", c[0].d.textContent === "tr.opt.catchDesctr.opt.catchNone" && !c[0].l && sel() === "wait" && w.okb.textContent === "tr.startWait"); }
    { const w = world({ money: "real", catch: P(null, 0), fresh: false });
      ok("讀過帳沒有單、資料舊:照樣接「沒有要補的單」(讀過帳就講,同網頁)", cur()[0].d.textContent === "tr.opt.catchDesctr.opt.catchNone" && sel() === "wait"); }
    // 第 6 列:還沒讀過帳／沒連交易所(trCatchPlan 回 null)。Wei 裁定稽核 R1:讀到帳之前補齊停用、講原因,什麼都送不出補齊
    for (const [name, o] of [["還沒讀過帳", { firstRead: true }], ["沒連交易所", { account: false }]]) {
      const w = world({ money: "real", catch: null, ...o }), c = cur();
      ok("R1 " + name + ":補齊停用、說明換成「讀到帳戶後才能補齊」(aria-describedby 指它)、不出單;預選等新訊號", c[0].input.disabled === true && c[0].d.textContent === "tr.opt.catchNeedRead"
        && c[0].input.attrs["aria-describedby"] === c[0].d.id && !c[0].l && sel() === "wait" && w.okb.textContent === "tr.startWait");
      c[0].input.checked = true; await c[0].input.fire("change"); await w.press(1);
      ok("R1 " + name + ":就算硬把補齊勾起來按主鈕,也送不出 resume(停用的選項不換 onOk;按下時再查一次)", w.sent.indexOf("resume") < 0, w.sent); }
    { const w = world({ money: "real", catch: null, firstRead: true });
      w.M.trStartReadRefresh();
      ok("R1 還沒讀到:每一輪 trPaint 叫 trStartReadRefresh 不重畫", cur()[0].input.disabled === true && w.open());
      w.env.firstRead = false; w.env.catchPlan = ONE; w.M.trStartReadRefresh();
      ok("R1 讀到帳了:原地重畫、補齊變可選而且列出單,但不自動預選補齊(用戶要自己選)、主鈕仍是等新訊號", cur()[0].input.disabled === false && cur()[0].l && cur()[0].l.textContent === ONE.text
        && sel() === "wait" && w.okb.textContent === "tr.startWait" && w.open() && w.sent.length === 0);
      await pickNow(w, "catch"); await w.press(1);
      ok("R1 重畫後 600ms 內的點擊不算", w.sent.length === 0);
      tick(600); await w.press(1);
      ok("R1 …過了 600ms 選補齊再按:照列出的單送 resume", w.sent.join() === "resume,restart_reconciler", w.sent); }
    { const w = world({ money: "real", catch: null, firstRead: true }); w.M.delClose(false);
      w.env.firstRead = false; w.M.trStartReadRefresh();
      ok("R1 框已經關掉:讀到帳也不會重新開框", !w.open() && w.sent.length === 0); }
    { const w = world({ money: "paper", catch: null, firstRead: true, report: { can_wait_start: false } });
      ok("R1 舊 runtime 一顆鈕:讀到帳之前主鈕停用、原因句在 lines", w.okb.disabled === true && $("del-body").kids.some((k) => k.textContent === "tr.opt.catchNeedRead"));
      await w.press(1); ok("R1 舊 runtime:送不出", w.sent.length === 0);
      w.env.firstRead = false; w.env.catchPlan = ONE; w.M.trStartReadRefresh(); tick(600);
      ok("R1 舊 runtime 讀到帳:主鈕可按", w.okb.disabled === false); }
    // 讀到帳但訊號還沒算出來(trCatchPlan 回 null,稽核 B1;同 R1 原則):補齊停用,算出來後重畫才可選。
    // 0.1.60(spec add-then-start-0160 補記):停用那段是轉圈＋「正在算訊號…」、框開著時 2 秒讀一次、最多 1 分鐘;逾時換「等了 1 分鐘還沒算出訊號。」＋〔重新整理〕
    const why = (o) => o.d.kids.find((k) => k.cls && k.cls.has("cf-wait"));
    const spinOf = (o) => (why(o) ? why(o).kids.find((k) => k.cls && k.cls.has("spin16")) : null), retryOf = (o) => (why(o) ? why(o).kids.find((k) => k.tag === "button") : null);
    const EV = { preventDefault() {}, stopPropagation() {} };
    { const t0 = CLOCK, w = world({ money: "real", catch: null }), c = cur();
      ok("訊號還沒算出來:補齊停用(radio 真 disabled)、說明是轉圈(aria-hidden)＋「正在算訊號…」、aria-describedby 指它、不出單;預選等新訊號、真錢記號、焦點在取消",
        c[0].input.disabled === true && c[0].row.cls.has("off") && !!spinOf(c[0]) && spinOf(c[0]).attrs["aria-hidden"] === "true" && why(c[0]).textContent === "tr.opt.catchComputing"
        && c[0].input.attrs["aria-describedby"] === c[0].d.id && !!c[0].d.id && !c[0].l && sel() === "wait" && w.okb.textContent === "tr.startWait" && w.mark.textContent === "tr.mode.real" && El.focus === $("del-cancel"),
        { d: c[0].d.textContent, sel: sel() });
      ok("等訊號:開框就排 2 秒後讀一次、等到開框後 60 秒;trPoll 用 trStartWaitOn 判要不要 2 秒一輪;這台電腦不開爆發窗",
        w.env.polls.join() === "2000" && w.env.TR.startUnread.until === t0 + 60000 && w.M.trStartWaitOn(CLOCK) === true && w.env.ENV.burst === null, { polls: w.env.polls, u: w.env.TR.startUnread });
      c[0].input.checked = true; await c[0].input.fire("change"); await w.press(1);
      ok("訊號還沒算出來:硬把補齊勾起來按也送不出 resume(按下時 trCatchPlan 仍是 null → 重畫不送)", w.sent.indexOf("resume") < 0 && w.open(), w.sent);
      tick(2000); w.M.trStartReadRefresh();
      ok("等訊號 2 秒後還算不出:不重畫、補齊仍停用、仍在轉", cur()[0].input.disabled === true && !!spinOf(cur()[0]) && sel() === "wait" && w.sent.indexOf("resume") < 0);
      w.env.catchPlan = ONE; w.M.trStartReadRefresh();
      ok("訊號算出來了:原地重畫、補齊可選並列出單、不自動預選補齊(預選仍停等新訊號)、不再轉、不再 2 秒一讀", cur()[0].input.disabled === false && cur()[0].l && cur()[0].l.textContent === ONE.text
        && cur()[0].d.textContent === "tr.opt.catchDesc" && sel() === "wait" && w.okb.textContent === "tr.startWait" && w.env.TR.startUnread === null && w.M.trStartWaitOn(CLOCK) === false);
      await pickNow(w, "catch"); await w.press(1);
      ok("訊號算出來後重畫 600ms 內選補齊按下:不算、什麼都沒送", w.sent.indexOf("resume") < 0 && w.open(), w.sent);
      tick(600); await w.press(1);
      ok("訊號算出來後選補齊、過了 600ms 再按:照列出的單送 resume", w.sent.join() === "resume,restart_reconciler", w.sent); }
    // 1 分鐘還算不出:逾時句＋〔重新整理〕;重新整理再等一輪、焦點回取消;取消不送任何指令
    { const w = world({ money: "real", catch: null }); w.env.polls.length = 0;
      tick(59999); w.M.trStartReadRefresh();
      ok("等訊號 59.999 秒:仍是正在算", !!spinOf(cur()[0]) && w.M.trStartWaitOn(CLOCK) === true);
      tick(1); w.M.trStartReadRefresh();
      const c = cur();
      ok("等滿 1 分鐘:原地換「等了 1 分鐘還沒算出訊號。」＋〔重新整理〕(btn-quiet)、不轉、補齊仍停用、預選仍等新訊號;停止 2 秒一讀;什麼都沒送",
        c[0].input.disabled === true && !spinOf(c[0]) && why(c[0]).textContent === "tr.opt.catchLatetr.opt.catchRetry" && retryOf(c[0]).cls.has("btn-quiet")
        && sel() === "wait" && w.M.trStartWaitOn(CLOCK) === false && w.env.polls.length === 0 && w.sent.length === 0 && w.open(), { d: c[0].d.textContent, polls: w.env.polls });
      w.M.trStartReadRefresh();
      ok("逾時後每一輪 trPaint 不再重畫、句子不變", why(cur()[0]).textContent === "tr.opt.catchLatetr.opt.catchRetry");
      El.focus = null; retryOf(cur()[0]).on.click[0](EV);
      ok("按〔重新整理〕:回到正在算、重新等 1 分鐘、排 2 秒一讀、焦點回取消、什麼都沒送", !!spinOf(cur()[0]) && w.env.TR.startUnread.until === CLOCK + 60000 && w.env.polls.join() === "2000"
        && El.focus === $("del-cancel") && sel() === "wait" && w.sent.length === 0 && w.open());
      ok("原地重畫(逾時、重新整理)都不算取消:沒叫 spStartClosed", w.env.closed === 0, w.env.closed);
      w.M.delClose(false);
      ok("真錢等訊號時按取消:框關、不送任何指令、叫一次 spStartClosed(策略頁說明行當場重畫)", !w.open() && w.sent.length === 0 && w.env.closed === 1 && w.env.TR.startUnread !== null && w.M.trStartWaitOn(CLOCK) === false);
      w.M.trStartReadRefresh();
      ok("框關掉後:下一輪清掉等待、也不重新開框", w.env.TR.startUnread === null && !w.open()); }
    { const w = world({ money: "real", env: "cloud", catch: null });
      ok("雲端等訊號:另開 60 秒爆發窗(主行程才會真的重抓)", !!w.env.ENV.burst && w.env.ENV.burst.until === CLOCK + 60000 && w.env.polls.join() === "2000"); }
    { const w = world({ money: "real", catch: null, firstRead: true });
      ok("還沒讀到帳(R1)不是等訊號:照舊「讀到帳戶後才能補齊」、不轉、不 2 秒一讀", cur()[0].d.textContent === "tr.opt.catchNeedRead" && !why(cur()[0]) && w.env.polls.length === 0 && w.M.trStartWaitOn(CLOCK) === false); }
    // 稽核 release-0160-e 必修 1:永豐送單後等快照(SnapshotLag)時,帳上讀不到——當還沒讀到帳:補齊停用、講讀帳那句、不預選、不 2 秒一讀;
    // 這裡 catch 故意給一份「算得出來」的單(舊版 trCatchPlan 會把帳上當 0 列出整筆),框也不能列、不能預選
    { const LAG = { ok: false, error: { type: "SnapshotLag", stage: "get_positions" }, equity: 1000000, positions: null };
      const w = world({ money: "real", catch: ONE, report: { account: { read_at: 1, venues: { sinopac: LAG } } } }), c = cur();
      ok("SnapshotLag:補齊停用、原因句「讀到帳戶後才能補齊。」(不是正在算訊號)、不列單;預選等新訊號、主鈕「啟動，等新訊號」;不 2 秒一讀",
        c[0].input.disabled === true && c[0].row.cls.has("off") && c[0].d.textContent === "tr.opt.catchNeedRead" && !why(c[0]) && !c[0].l && sel() === "wait" && w.okb.textContent === "tr.startWait"
        && w.env.polls.length === 0, { d: c[0].d.textContent, l: !!c[0].l, sel: sel() });
      c[0].input.checked = true; await c[0].input.fire("change"); await w.press(1);
      ok("SnapshotLag:硬把補齊勾起來按也送不出 resume", w.sent.indexOf("resume") < 0, w.sent);
      w.env.TR.st.report.account.venues.sinopac = { ok: true, equity: 1000000, positions: {} }; w.M.trStartReadRefresh();
      ok("快照跟上:原地重畫、補齊可選並列出單、不預選", cur()[0].input.disabled === false && !!cur()[0].l && sel() === "wait" && w.okb.textContent === "tr.startWait"); }
    { const css = fs.readFileSync(path.join(R, "app.css"), "utf8"), tcss = fs.readFileSync(path.join(R, "trade.css"), "utf8"), rule = (css.match(/\.cf-opt-d \.cf-wait \.spin16 \{[^}]*\}/) || [""])[0];
      ok("等訊號那顆圓環照 canon loading.md 唯一配方:.spin16 本身是 currentColor＋透明缺口,這裡不另寫 --border-frame 環或弧色(設計審 web-0160 第二輪裁決 1)",
        !!rule && !/border/.test(rule) && /\.spin16 \{[^}]*border: 2px solid currentColor; border-top-color: transparent;/.test(tcss) && /\.cf-opt\.off \.cf-opt-d \.cf-wait \{ color: var\(--ink-2\); \}/.test(css), rule);
      ok("暗色下鎖住的選項補一條 --border-hairline 框(選中的照留 --border-frame)", /\[data-theme="dark"\] \.cf-opt\.off:not\(:has\(input:checked\)\) \{ border-color: var\(--border-hairline\); \}/.test(css)); }
    { const w = world({ money: "real", catch: null, recomputing: true });
      ok("重算中不是等訊號:照舊重算那句、不 2 秒一讀", cur()[0].d.textContent === "tr.cloud.recomputing" && w.env.polls.length === 0); }
    { const w = world({ money: "paper", catch: null, report: { can_wait_start: false } });
      ok("訊號還沒算出來 · 舊 runtime 一顆鈕:主鈕停用、原因句(正在算)在 lines", w.okb.disabled === true && $("del-body").kids.some((k) => k.textContent === "tr.opt.catchComputing")); }
    // 稽核 M2:資料超過 10 分鐘:單照列(同網頁)、不預選;手動選補齊時送出的就是列出來的那幾筆
    { const w = world({ money: "real", catch: ONE, fresh: false });
      ok("M2 資料超過 10 分鐘:單照列、預選等新訊號", cur()[0].l && cur()[0].l.textContent === ONE.text && sel() === "wait" && w.okb.textContent === "tr.startWait");
      await w.pick("catch"); await w.press();
      ok("M2 …手動選補齊:按下時單沒變才送 resume(送出的就是畫面上那幾筆)", w.sent.join() === "resume,restart_reconciler" && w.env.hows.join() === "start:catch:wait", [w.sent, w.env.hows]); }
    // 預選補齊時改選等新訊號:不重算、照送,主行程記 mode=wait pre=catch
    { const w = world({ money: "paper", catch: ONE }); await w.pick("wait"); w.env.catchPlan = P("會買進 BTC 9 USDT。", 1, [["+BTCUSDT", 9]]); await w.press();
      ok("改選等新訊號:不重算(單變了也照送 resume_wait)、主行程收到 start:wait:catch", w.sent.join() === "resume_wait,restart_reconciler" && !w.open() && w.env.hows.join() === "start:wait:catch", [w.sent, w.env.hows]); }
    // §1.5 ＋ 稽核 M1:按下時單變了 → 不送、框留著、換新、兩個都不預選、主鈕停用到重新選;雙擊的第二下與 600ms 內的點擊都不算
    { const w = world({ money: "real", catch: ONE }), NEW = P("會買進 BTC 1,350 USDT、賣出 ETH 300 USDT。", 2, [["+BTCUSDT", 1350], ["-ETHUSDT", 300]]);
      w.env.catchPlan = NEW; El.focus = null; await w.press(1);
      const t1 = tail(), kids = $("del-body").kids, stopAt = kids.findIndex((k) => k.cls && k.cls.has("cf-stop"));
      ok("§1.5 單變了:什麼都沒送、框沒關、單換成新的、框底出「要下的單變了」(說明一行之前、aria-live assertive＋atomic)、焦點回取消",
        w.sent.length === 0 && w.open() && cur()[0].l.textContent === NEW.text && !!t1 && t1.textContent === "tr.opt.catchChanged" && kids.indexOf(t1) < stopAt
        && t1.attrs["role"] === "alert" && t1.attrs["aria-live"] === "assertive" && t1.attrs["aria-atomic"] === "true" && El.focus === $("del-cancel"), [w.sent, t1 && t1.attrs]);
      // 設計稽核 0158 M1／M3(canon confirm-modal ❌「兩個都不選＋主鈕停用」):重畫後預選不動錢的等新訊號,補齊照樣可選
      ok("埋點:單變了重畫一次 → feature_used start_catch_chg 送一次", w.env.tracked.filter((n) => n === "start_catch_chg").length === 1, w.env.tracked);
      ok("M1 重畫後預選「等新訊號」、主鈕可按、字是「啟動，等新訊號」;補齊可選、列的是新的單", sel() === "wait" && w.okb.disabled === false && w.okb.textContent === "tr.startWait"
        && cur()[0].input.disabled === false && cur()[0].l.textContent === NEW.text);
      await w.press(2);
      ok("M1 雙擊的第二下落在重畫後的框:什麼都沒送(補齊與等新訊號都沒送)", w.sent.length === 0 && w.open(), w.sent);
      await w.press(1);
      ok("M1 重畫後 600ms 內的單擊也不算(armAt)", w.sent.length === 0 && w.open());
      await pickNow(w, "catch");
      ok("M1 重新選補齊:主鈕字回「啟動並補齊部位」", w.okb.disabled === false && w.okb.textContent === "tr.startCatchUp");
      await w.press(1);
      ok("M1 選了補齊、還在 600ms 內:不算", w.sent.length === 0 && w.open());
      tick(600); await w.press(2);
      ok("M1 過了 600ms 但是雙擊的第二下:仍不算", w.sent.length === 0 && w.open());
      await w.press(1);
      ok("埋點:被 armAt／雙擊擋下的點擊不送 start_catch_chg;單沒再變、照送那一下也不送(整段只有那一次重畫)", w.env.tracked.filter((n) => n === "start_catch_chg").length === 1, w.env.tracked);
      ok("M1 過了 600ms、重新選過、單擊:照新的單送 resume;pre 記開框時的 catch", w.sent.join() === "resume,restart_reconciler" && !w.open() && w.env.hows.join() === "start:catch:catch", [w.sent, w.env.hows]); }
    { const w = world({ money: "real", catch: ONE }); w.env.catchPlan = P("會買進 BTC 1,350 USDT。", 1, [["+BTCUSDT", 1350]]);
      await w.press(1); await w.press(2);
      ok("M1 雙擊(第一下重畫、第二下 detail 2):沒送任何補齊的單、框還開著", w.sent.indexOf("resume") < 0 && w.sent.length === 0 && w.open(), w.sent);
      tick(600); await w.press(1);
      ok("M1 …過了 600ms 單擊重畫後的預選:送的是不動錢的 resume_wait", w.sent.join() === "resume_wait,restart_reconciler", w.sent); }
    for (const [name, to] of [["方向翻了", P("會賣出 BTC 1,200 USDT。", 1, [["-BTCUSDT", 1200]])], ["少一筆(沒有單了)", P(null, 0)], ["變成不知道(讀帳資料不見)", null], ["金額變 1%", P("會買進 BTC 1,212 USDT。", 1, [["+BTCUSDT", 1212]])]]) {
      const w = world({ money: "real", catch: ONE }); w.env.catchPlan = to; await w.press();
      ok("§1.5 " + name + ":不送、框留著、出 catchChanged、預選等新訊號(主鈕「啟動，等新訊號」)", w.sent.length === 0 && w.open() && !!tail() && sel() === "wait" && w.okb.textContent === "tr.startWait", [w.sent, sel()]);
      await w.press(2); ok("§1.5 " + name + ":接著雙擊的第二下不算", w.sent.length === 0); }
    // 稽核 B3(收窄):1%、4% 都算變了(不送、框留著);只有捨入雜訊、或只有字不同(股名晚到)不擋
    for (const [name, to] of [["金額 1,200 → 1,212(1%)", P("會買進 BTC 1,212 USDT。", 1, [["+BTCUSDT", 1212]])], ["金額 1,200 → 1,248(4%)", P("會買進 BTC 1,248 USDT。", 1, [["+BTCUSDT", 1248]])]]) {
      const w = world({ money: "real", catch: ONE }); w.env.catchPlan = to; await w.press();
      ok("§1.5 " + name + ":算單變了,不送、框留著、出 catchChanged", w.sent.length === 0 && w.open() && !!tail(), w.sent); }
    for (const [name, to] of [["捨入雜訊(1,199.8,畫面同寫 1,200)", P("會買進 BTC 1,200 USDT。", 1, [["+BTCUSDT", 1199.8]])], ["只有字不同(股名晚到),方向標的數量相同", P("會買進 BTC 1,200 USDT(字不一樣)。", 1, [["+BTCUSDT", 1200]])]]) {
      const w = world({ money: "real", catch: ONE }); w.env.catchPlan = to; await w.press();
      ok("§1.5 " + name + ":不誤擋,照送", w.sent.join() === "resume,restart_reconciler" && !w.open(), w.sent); }
    // 修掉的無聲失敗:框開著時進入重算
    { const w = world({ money: "real", catch: ONE }); w.env.recomputing = true; await w.press();
      ok("§1.5 框開著時進入重算:按下不送、框不關(舊版是框關掉什麼都沒送)、補齊停用、預選等新訊號、出 catchChanged",
        w.sent.length === 0 && w.open() && cur()[0].input.disabled && sel() === "wait" && w.okb.textContent === "tr.startWait" && !!tail());
      tick(600); await w.press();
      ok("…重新選等新訊號再按:送 resume_wait,主行程收到 start:wait:catch(pre 是開框時的預選)", w.sent.join() === "resume_wait,restart_reconciler" && !w.open() && w.env.hows.join() === "start:wait:catch", [w.sent, w.env.hows]); }
    // 稽核 B4:按下時已經沒有策略設金額:框不無聲收掉,換成原因句、主鈕停用
    { const w = world({ money: "real", catch: ONE }); w.env.zoff = true; w.env.catchPlan = P(null, 0); await w.press();
      const lines = $("del-body").kids.filter((k) => k.tag === "p").map((k) => k.textContent);
      ok("B4 按下時已經沒有策略設金額:不送、框留著、寫原因、主鈕停用、出 catchChanged", w.sent.length === 0 && w.open() && lines.includes("tr.startOffNoAmt") && w.okb.disabled === true && !!tail(), lines);
      await w.press(); ok("B4 …再按也不送", w.sent.length === 0); }
    // 舊 runtime(一顆主鈕):同樣按下時重算;沒有選項可重選,靠 600ms 與雙擊的第二下不算
    { const w = world({ money: "paper", catch: ONE, report: { can_wait_start: false } }); w.env.catchPlan = P("會買進 BTC 5 USDT。", 1, [["+BTCUSDT", 5]]); await w.press();
      ok("§1.4 舊 runtime 一顆鈕:單變了也不送、框留著、出 catchChanged、單換成新的", w.sent.length === 0 && w.open() && !!tail() && w.okb.textContent === "tr.startCatchUp"
        && $("del-body").kids.some((k) => k.textContent === "會買進 BTC 5 USDT。"));
      await w.press(2); await w.press(1);
      ok("M1 舊 runtime:雙擊的第二下、600ms 內的單擊都不算", w.sent.length === 0 && w.open());
      tick(600); await w.press(1);
      ok("…過了 600ms 單擊:送 resume、主行程收到 start:single:catch", w.sent.join() === "resume,restart_reconciler" && w.env.hows.join() === "start:single:catch", [w.sent, w.env.hows]); }
    { const w = world({ money: "paper", catch: ONE, report: { can_wait_start: false } }); w.env.recomputing = true; await w.press();
      ok("§1.5 舊 runtime 框開著時進入重算:不送、框留著、主鈕停用", w.sent.length === 0 && w.open() && w.okb.disabled === true && !!tail()); }
    { const w = world({ money: "paper", env: "cloud", catch: ONE }); await w.press();
      ok("雲端:一樣預選補齊、送 resume(雲端的啟動不經主行程,不帶 how)", w.sent.join() === "resume" && w.env.hows.length === 0, [w.sent, w.env.hows]); } }
  // ---- K4:這台電腦的啟動框細節最後一行是「要 24 小時跑」+ 一顆鈕;按了記 awake_cloud_go、收框、切到雲端那一袋;雲端的框沒有這一行
  { const w = world({ money: "paper", awake: true }), lis = w.body.all().filter((n) => n.tag === "li"), last = lis[lis.length - 1], b = last && last.all().find((n) => n.tag === "button");
    ok("本機:細節最後一行是雲端出口(字 + 鈕;zh 全形冒號後不補空格,en 才補)", !!b && last.textContent === "tr.means.cloudtr.means.cloudGo" && /t\("tr\.means\.cloud"\) \+ \(LANG === "zh" \? "" : " "\)/.test(fn(trade, "trAwakeCloudGo")) && b.textContent === "tr.means.cloudGo" && b.cls.has("btn-quiet"), last && last.textContent);
    ok("本機:防睡開著時細節用 1a / 2pa(框真的讀到 AWAKE)", lis.map((n) => n.textContent).slice(0, 2).join() === "tr.means.1a,tr.means.2pa");
    if (b) await b.fire("click");
    ok("按出口:記 awake_cloud_go、框關、切到 cloud、沒送任何指令", w.env.tracked.join() === "awake_cloud_go" && !w.open() && w.env.switched.join() === "cloud" && w.sent.length === 0, { t: w.env.tracked, s: w.env.switched }); }
  { const w = world({ money: "paper", awake: true, platform: "win32" }), lis = w.body.all().filter((n) => n.tag === "li");
    ok("本機 · Windows:框真的依平台換成 1aWin / 2pa", lis.map((n) => n.textContent).slice(0, 2).join() === "tr.means.1aWin,tr.means.2pa"); }
  // 設定 › 一般(app.js awakePaint):泡泡依平台、不隨開關換;底下那句只在關著時出,講停單的後果
  { const paint = (platform, on) => { const els = {}, el = () => ({ cls: new Set(), attrs: {}, classList: { toggle() {} }, setAttribute() {}, textContent: "", hidden: false });
      const $$ = (id) => els[id] || (els[id] = el());
      new Function("$", "t", "window", "AWAKE", fn(app, "awakePaint") + "; awakePaint();")($$, (k) => k, { blave: { platform } }, on);
      const l = els["set-awake-lead"]; return els["set-awake-tip"].textContent + "|" + (l.hidden ? "-" : l.textContent); };
    ok("設定頁 · Mac:泡泡兩態都是 set.awake.lead;開著底下那句藏起來,關著出 set.awake.leadOff", paint("darwin", true) === "set.awake.lead|-" && paint("darwin", false) === "set.awake.lead|set.awake.leadOff");
    ok("設定頁 · Windows:泡泡兩態都是 set.awake.leadWin;關著出 set.awake.leadOffWin", paint("win32", true) === "set.awake.leadWin|-" && paint("win32", false) === "set.awake.leadWin|set.awake.leadOffWin"); }
  { const w = world({ money: "paper", awake: false }), lis = w.body.all().filter((n) => n.tag === "li");
    ok("防睡關著:框用舊版 1 / 2p,出口照樣在", lis.map((n) => n.textContent).slice(0, 2).join() === "tr.means.1,tr.means.2p" && lis[lis.length - 1].textContent === "tr.means.cloudtr.means.cloudGo"); }
  { const w = world({ money: "real", env: "cloud", awake: true }), lis = w.body.all().filter((n) => n.tag === "li");
    ok("雲端的框:沒有雲端出口", !lis.some((n) => /tr\.means\.cloud/.test(n.textContent))); }
  // ---- 4
  { const N = world({ money: "paper" }).M.trStartNotes, flat = (o) => { const n = N(o); return n.keep.join("|") + " / " + n.details.map((g) => (g.label || "-") + ":" + (g.items ? g.items.join("|") : g.text)).join(";"); };
    // mockup 03 A 版:這台電腦的說明縮成一行(note = tr.stopLine),其餘進小卡(details 最後一組、沒有小標);雲端沒有 note、照舊「在雲端跑」
    ok("這台電腦:note 是 tr.stopLine、小卡那一組沒有小標;雲端:note 是 null、細節帶「在雲端跑」", N({ paper: true, own: true, venue: "" }).note === "tr.stopLine" && N({ real: true, own: true, venue: "B" }).note === "tr.stopLine"
      && N({ cloud: true, paper: true, v: {} }).note === null && N({ cloud: true, paper: true, v: {} }).details[0].label === "tr.det.cloud");
    // 設計稽核 desktop-10-08 #3:睡眠那一句(tr.keep.sleep)退役——它跟細節的第 1、2 點是同一件事;本機四點全在「細節」,常駐只留 venue 通用的「只調整 Blave 那一份」
    ok("這台電腦 · 模擬:沒有常駐句;細節三點(醒著才跑、睡眠不平倉、重開要再按),不出「只調整 Blave 那一份」與交易所停損單", flat({ paper: true, own: true, venue: "" }) === " / -:tr.means.1|tr.means.2p|tr.means.3");
    ok("這台電腦 · 真錢:常駐只有「只動 Blave 那一份」;細節四點(交易所停損單排第 4)", flat({ real: true, own: true, venue: "Binance" }) === "tr.keep.own / -:tr.means.1|tr.means.2|tr.means.3|tr.means.4");
    ok("tr.keep.sleep 退役:程式不再引用、兩語都拿掉", !/tr\.keep\.sleep/.test(trade) && strings.indexOf('"tr.keep.sleep"') < 0);
    ok("機器沒證明自己只碰帳本(self_ledger 不是 true):那一句不出", !/tr\.keep\.own/.test(flat({ real: true, own: false, book: "none", venue: "Binance" })));
    // 統一(這台電腦、設計師裁定):完成頁那兩句說明搬過來——常駐「同月份分不清」取代三種加密口吻,細節多一條夜盤;三種帳本狀態都一樣
    ok("統一 · 真錢:常駐 tr.keep.pres(不是 tr.keep.own*)、細節多夜盤那一條;pres 只有這台電腦且 venue 是統一才傳(雲端不接統一)", ["none", "built", undefined].every((b) => flat({ real: true, own: true, pres: true, book: b, venue: "統一期貨" }).indexOf("tr.keep.pres / ") === 0)
      && flat({ real: true, own: true, pres: true, tw: true, venue: "統一期貨" }) === "tr.keep.pres / -:tr.means.1|tr.means.2|tr.means.3|tr.means.twStop|tr.means.presNight"
      && /pres: !cloud && trVenueId\(\) === "president", win: window\.blave\.platform === "win32" \}\);/.test(trade));
    // 台灣期貨券商沒有券商端停損單型(統一 place_stop_order 是 NotImplementedError、群益同樣沒做):「交易所端停損單建議掛上」在那裡是假的,換成「停損是這台電腦算的、睡著沒保護」
    const TW = new Function(fn(trade, "trTwBroker") + "; return trTwBroker;")();
    ok("統一 · 真錢:第 4 點是 tr.means.twStop(帶券商名)、不出 tr.means.4", flat({ real: true, own: true, pres: true, tw: true, venue: "統一期貨" }).indexOf("tr.means.4") < 0
      && /o\.tw \? trTidyZh\(t\("tr\.means\.twStop", \{ venue: o\.venue \}\)\) : t\("tr\.means\.4"\)/.test(trade));
    ok("群益 · 真錢:同樣 twStop、不出 tr.means.4(靠 venue 判斷,不是只看 pres)", flat({ real: true, own: true, tw: true, venue: "群益" }) === "tr.keep.own / -:tr.means.1|tr.means.2|tr.means.3|tr.means.twStop");
    ok("防睡開著(awake)· 模擬:第 1、2 點換成閒置不睡的那組(tr.means.1a / 2pa),第 3 點照舊", flat({ awake: true, paper: true, own: true, venue: "" }) === " / -:tr.means.1a|tr.means.2pa|tr.means.3");
    ok("防睡開著 · 真錢:tr.means.1a / 2a,交易所停損單照舊排第 4", flat({ awake: true, real: true, own: true, venue: "Binance" }) === "tr.keep.own / -:tr.means.1a|tr.means.2a|tr.means.3|tr.means.4");
    ok("防睡開著 · Mac:第 1 點是共用的 tr.means.1a(不出「筆電要接著電源」)", flat({ awake: true, win: false, real: true, own: true, venue: "Binance" }) === "tr.keep.own / -:tr.means.1a|tr.means.2a|tr.means.3|tr.means.4");
    ok("防睡開著 · Windows:第 1 點換成 tr.means.1aWin(接電源限定),其餘照舊", flat({ awake: true, win: true, real: true, own: true, venue: "Binance" }) === "tr.keep.own / -:tr.means.1aWin|tr.means.2a|tr.means.3|tr.means.4");
    ok("防睡關著 · Windows:照舊版 tr.means.1(1aWin 只在開著時)", flat({ awake: false, win: true, paper: true, own: true, venue: "" }) === " / -:tr.means.1|tr.means.2p|tr.means.3");
    ok("防睡開著 · 雲端:不受影響(主機不靠這台電腦)", flat({ awake: true, cloud: true, real: true, own: true, v: { h: "0.9", m: "50" } }) === flat({ cloud: true, real: true, own: true, v: { h: "0.9", m: "50" } }));
    ok("加密交易所 · 真錢:照舊 tr.means.4、不出 twStop", flat({ real: true, own: true, tw: false, venue: "Binance" }) === "tr.keep.own / -:tr.means.1|tr.means.2|tr.means.3|tr.means.4");
    ok("tw 旗標從既有 venue id 判:capital / president 都算,其餘不算;call site 用 trTwBroker(trVenueId())", TW("capital") && TW("president") && !TW("binance") && !TW("paper") && !TW(null)
      && /tw: trTwBroker\(trVenueId\(\)\), pres: !cloud/.test(trade));
    ok("統一那一句的條件跟 tr.keep.own* 同一個(self_ledger === true 且真錢;電腦版第一份 config 就是 self_ledger: true):沒有它那句才不出", !/tr\.keep\.pres/.test(flat({ real: true, own: false, pres: true, venue: "統一期貨" })) && /tr\.means\.presNight/.test(flat({ real: true, own: false, pres: true, venue: "統一期貨" })));
    // 5. 三種帳本狀態
    const det = (o) => N(o).details.map((g) => (g.label || "-") + (g.text ? "=" + g.text : "")).join();
    ok("帳本還沒建(第一次):常駐講「同方向的部位第一次對帳會算進來」,細節多一段 1.5 倍規則(排在環境那一段前面)", N({ real: true, own: true, book: "none", venue: "B" }).keep[0] === "tr.keep.ownFirst"
      && det({ real: true, own: true, book: "none", venue: "B" }) === "tr.det.own=tr.det.ownRule,-");
    ok("帳本已建:常駐只講「你自己開的不算 Blave 的」,不講會算進來;細節沒有 1.5 倍那一段", N({ real: true, own: true, book: "built", venue: "B" }).keep.join() === "tr.keep.ownBuilt,tr.keep.ownBuilt2"
      && det({ real: true, own: true, book: "built", venue: "B" }) === "-" && N({ cloud: true, real: true, own: true, book: "built", v: { h: "1", m: "50" } }).keep[0] === "tr.keep.ownBuilt");
    ok("讀不到帳本狀態:只講兩種情況都成立的那半句;細節沒有 1.5 倍那一段", [undefined, "unknown", "weird"].every((b) => N({ real: true, own: true, book: b, venue: "B" }).keep[0] === "tr.keep.own" && det({ real: true, own: true, book: b, venue: "B" }) === "-"));
    ok("模擬不出這一句,三種帳本狀態都一樣", ["none", "built", "unknown"].every((b) => !/tr\.(keep\.own|det\.own)/.test(flat({ paper: true, own: true, book: b, venue: "" }))));
    const B = new Function(fn(trade, "trBookBaseline") + "; return trBookBaseline;")();
    ok("帳本狀態從對帳快照讀:帶 ledger(空的也算)= 已建;帶 needs_baseline = 還沒建;沒有快照、兩個都沒有、型別不對 = 讀不到", B({ last_reconcile: { ledger: {} } }) === "built" && B({ last_reconcile: { ledger: { BTCUSDT: { size: 50 } }, own_only: true } }) === "built"
      && B({ last_reconcile: { needs_baseline: { reason: "confirming", symbols: [] } } }) === "none" && B({ last_reconcile: { needs_baseline: { reason: "state_unreadable", symbols: ["a"] } } }) === "none"
      && [null, {}, { last_reconcile: null }, { last_reconcile: {} }, { last_reconcile: { ledger: null } }, { last_reconcile: { ledger: "x", needs_baseline: "y" } }, { last_reconcile: "x" }].every((r) => B(r) === "unknown"));
    ok("還沒存過金額(needs_baseline 的原因是 unconfigured):讀不到——新機存第一份金額時會寫一份從零開始的基準,舊機會收編,這一格分不出來", B({ last_reconcile: { needs_baseline: { reason: "unconfigured", symbols: [] } } }) === "unknown");
    ok("兩個都帶(不該發生):以已建為準——寧可少講「會算進來」", B({ last_reconcile: { ledger: {}, needs_baseline: { reason: "confirming" } } }) === "built");
    ok("雲端:常駐換成主機費與停機門檻;細節是雲端那兩句(「回到這一頁按暫停」那句退役)", flat({ cloud: true, real: true, own: true, v: { h: "1", m: "50" } }) === "tr.keep.own|tr.cloud.means.3 / tr.det.cloud:tr.cloud.means.1|tr.cloud.means.4"
      && flat({ cloud: true, paper: true, own: true, v: { h: "1", m: "50" } }) === "tr.cloud.means.3 / tr.det.cloud:tr.cloud.means.1|tr.cloud.means.4");
    ok("雲端拿不到金額:主機費那一句整句不出(不生沒有數字的半套說法)", flat({ cloud: true, paper: true, v: {} }).indexOf("tr.cloud.means.3") < 0);
    ok("雲端方案制:講方案沒付款會停機(tr.cloud.means.3m),不講時價與餘額門檻", flat({ cloud: true, paper: true, mo: true, v: { h: "", m: "" } }) === "tr.cloud.means.3m / tr.det.cloud:tr.cloud.means.1|tr.cloud.means.4"); }
  { const det = (w) => w.body.all().find((n) => n.tag === "details"), pop = (w) => w.body.all().find((n) => n.cls.has("cf-pop")), stop = (w) => w.body.all().find((n) => n.cls.has("cf-stop"));
    const a = world({ money: "real" }), c = world({ money: "paper" }), d = world({ money: "real", env: "cloud" });
    // mockup 03 A 版:這台電腦是一行說明＋〔細節〕點開的小卡(小卡預設收著、用點的);雲端照舊收合的 <details>(設計稽核 desktop-10-08 #3)
    const popBtn = (w) => stop(w).kids.find((k) => k.tag === "button");
    ok("這台電腦:一行說明(tr.stopLine)＋〔細節〕鈕(aria-expanded=false、aria-controls 指小卡)＋小卡收著、沒有 <details>", [a, c].every((w) => stop(w) && stop(w).kids[0].textContent === "tr.stopLine" && popBtn(w).textContent === "cf.more" && popBtn(w).attrs["aria-expanded"] === "false"
      && popBtn(w).attrs["aria-controls"] === "cf-pop" && pop(w).id === "cf-pop" && pop(w).hidden === true && !det(w)));
    await popBtn(a).fire("click"); const opened = pop(a).hidden === false && popBtn(a).attrs["aria-expanded"] === "true"; await popBtn(a).fire("click");
    ok("按〔細節〕:小卡打開、aria-expanded 跟著;再按收回", opened && pop(a).hidden === true && popBtn(a).attrs["aria-expanded"] === "false");
    ok("雲端:沒有一行說明與小卡、「細節」收著", !stop(d) && !pop(d) && det(d).open === false);
    // 稽核 11-04:小卡只放 items 五條;真錢＋帳本未建的「哪些部位算 Blave 的」那段留在原本的 <details>、summary 用它的 label(跟網頁同一份)
    { const e = world({ money: "real", book: "none" }), popTxt = pop(e).all().map((n) => n.textContent).join("|"), dd = det(e);
      ok("真錢＋帳本未建:小卡不含 tr.det.ownRule、只有五條環境句;1.5 倍那段在 <details>(summary = tr.det.own、收著)、排在一行說明前面", !/tr\.det\.ownRule|tr\.det\.own/.test(popTxt) && pop(e).all().filter((n) => n.tag === "li").length === 5
        && !!dd && dd.open === false && dd.kids[0].tag === "summary" && dd.kids[0].textContent === "tr.det.own" && /tr\.det\.ownRule/.test(dd.textContent) && e.body.kids.indexOf(dd) < e.body.kids.indexOf(stop(e)), popTxt + " // " + (dd && dd.textContent)); }
    ok("真錢的標題記號是「真錢」、模擬是「模擬」", a.mark.textContent === "tr.mode.real" && a.mark.cls.has("real") && c.mark.textContent === "tr.mode.paper" && c.mark.cls.has("paper"));
    await a.pick("wait"); await a.press();
    ok("啟動後不再寫「看過細節」的旗標(trStartSeenKey 退役)", !Object.keys(a.store).length && !/trStartSeenKey|tr_start_seen_/.test(trade), a.store); }
  // ---- 字串
  { const has = (k) => (strings.match(new RegExp('"' + k.replace(/\./g, "\\.") + '":', "g")) || []).length === 2;
    const NEW = ["tr.keep.own", "tr.keep.ownFirst", "tr.keep.ownBuilt", "tr.keep.pres", "tr.means.presNight", "tr.means.twStop", "tr.det.own", "tr.det.ownRule", "tr.opt.legend", "tr.opt.catch", "tr.opt.catchDesc", "tr.opt.catchStale", "tr.opt.wait", "tr.opt.waitDesc", "tr.stopLine", "tr.det.cloud", "cf.more", "tr.means.1a", "tr.means.2a", "tr.means.2pa", "tr.means.cloud", "tr.means.cloudGo"];
    const GONE = ["tr.startOwnOnly", "tr.startChoice", "tr.startWarn2", "tr.startWarn2Local", "tr.means.l", "tr.cloud.means.l", "tr.cloud.means.2", "tr.keep.sleep", "tr.det.local"];
    ok("新字串兩語都在;退役的兩語都拿掉、程式也不再引用", NEW.every(has) && GONE.every((k) => strings.indexOf('"' + k + '"') < 0 && trade.indexOf('"' + k + '"') < 0), NEW.filter((k) => !has(k)).concat(GONE.filter((k) => strings.indexOf('"' + k + '"') >= 0)));
    const zh = strings.slice(strings.indexOf("\n  zh: {")), get = (k) => (zh.match(new RegExp('"' + k.replace(/\./g, "\\.") + '": "([^"]*)"')) || [])[1] || "";
    ok("兩顆主鈕的字(mockup 03:等新訊號那顆縮成「啟動，等新訊號」)", get("tr.startCatchUp") === "啟動並補齊部位" && get("tr.startWait") === "啟動，等新訊號" && get("tr.start") === "啟動下單");
    ok("1.5 倍那一段逐字沿用原句的後半(只在帳本還沒建時出);已建那一句不講「會算進來」「不會被平」", get("tr.det.ownRule") === "第一次對帳時，同方向的現有部位不超過目標 1.5 倍就整份算 Blave 的，更大時只算到目標那麼多，其餘算你的、不會被平。單向持倉帳戶上，交易所會把 Blave 的單跟你同一個幣的部位合併計算。"
      && !/算進來|不會被平|不會被動到/.test(get("tr.keep.ownBuilt") + get("tr.keep.ownBuilt2")) && /單向持倉/.test(get("tr.keep.ownBuilt2")) && get("tr.keep.own") === "只動 Blave 自己那一份。");
    { const en = strings.slice(strings.indexOf("\n  en: {"), strings.indexOf("\n  zh: {")), getEn = (k) => (en.match(new RegExp('"' + k.replace(/\./g, "\\.") + '": "([^"]*)"')) || [])[1] || "";
      // 文案清長句:單向持倉那句拆到 tr.keep.ownBuilt2(帳本已建時第二行);ownBuilt 的開頭接逗號,開頭比對不含句號
      ok("帳本已建那兩句(文案清長句定稿):同一個開頭;「也不抵掉目標部位」/ don’t offset targets;單向持倉另起一行",
        get("tr.keep.ownBuilt") === "只動 Blave 自己那一份，你自己開的部位不算、也不抵目標。"
        && get("tr.keep.ownBuilt2") === "單向持倉帳戶上，交易所會把 Blave 的單與你同幣的部位合併計算。"
        && getEn("tr.keep.ownBuilt") === "Only Blave’s own share is traded. Positions you opened aren’t counted and don’t offset targets."
        && getEn("tr.keep.ownBuilt2") === "On a one-way account, the exchange nets Blave’s orders with your position in the same coin."
        && ["tr.keep.ownFirst", "tr.keep.ownBuilt"].every((k) => get(k).indexOf("只動 Blave 自己那一份") === 0) && ["tr.keep.own", "tr.keep.ownFirst", "tr.keep.ownBuilt"].every((k) => getEn(k).indexOf("Only Blave’s own share is traded.") === 0));
      ok("統一的兩句(設計師裁定,逐字)", get("tr.keep.pres") === "只動 Blave 自己那一份。同一個商品別跟策略用同一個月份手動交易，Blave 會分不清。"
        && getEn("tr.keep.pres") === "Only Blave’s own share is traded; don’t trade the same product and month by hand as a strategy — Blave can’t tell them apart."
        && get("tr.means.presNight") === "台指期夜盤也會下單，電腦要一直開著。" && getEn("tr.means.presNight") === "TAIEX futures also trade at night; keep this computer on.");
      ok("台灣券商停損那一句(逐字,{venue} 帶券商名)", get("tr.means.twStop") === "{venue}沒有券商端停損單，電腦睡著時部位沒保護。"
        && getEn("tr.means.twStop") === "{venue} has no broker-side stops; a sleeping computer leaves positions unprotected."); }
    // mockup 03 A 版(2026-11-04):一行說明與小卡每條 ≤25 字(不算標點與空格,同 mockup 的數法);選項說明、常駐句照 mockup 逐字;市價那一句組起來就是 mockup 那句
    const cnt = (s) => s.replace(/\{venue\}/g, "Binance").replace(/[\s，。、：；「」（）／·,.:;()\-–—]/g, "").length;
    const CARD = ["tr.stopLine", "tr.means.1", "tr.means.2", "tr.means.2p", "tr.means.3", "tr.means.4", "tr.means.1a", "tr.means.1aWin", "tr.means.2a", "tr.means.2pa", "tr.means.twStop", "tr.means.presNight", "tr.means.cloud", "tr.opt.catchDesc", "tr.opt.waitDesc", "tr.keep.own"];
    // 設計師 11-04 二審把 tr.means.2 / 2a 改成「{venue}上的部位不平倉」逐字(代 Binance 算 28 / 27),這兩句不算在 25 字門檻
    const OVER = ["tr.means.2", "tr.means.2a"];
    { const T = new Function("LANG", fn(trade, "trPadLatin") + fn(trade, "trTidyZh") + "; return (v) => trTidyZh(STR.replace('{venue}', trPadLatin(v)));".replace("STR", JSON.stringify(get("tr.means.2"))))("zh");
      ok("英文交易所名在句中:全形逗號後不留空格、名字後面接中文才留(「，Binance 上的部位」);中文券商名不墊", T("Binance") === "睡眠、關機或結束 Blave 就停，Binance 上的部位不平倉。" && T("統一期貨") === "睡眠、關機或結束 Blave 就停，統一期貨上的部位不平倉。", T("Binance")); }
    ok("一行說明、小卡每條、選項說明都 ≤25 字(zh;設計師逐字裁定的兩句除外)", CARD.every((k) => get(k) && (OVER.includes(k) || cnt(get(k)) <= 25)), CARD.map((k) => k + "=" + cnt(get(k) || "")).filter((x) => +x.split("=")[1] > 25 && !OVER.includes(x.split("=")[0])));
    ok("逐字照 mockup:一行說明、等新訊號、補齊(市價)、常駐句", get("tr.stopLine") === "電腦睡眠或關掉 Blave 就停，部位不平倉。" && get("tr.opt.waitDesc") === "現在不下單，等下一個訊號才動。"
      && get("tr.opt.catchDesc").replace("{how}", get("tr.opt.catchHow.market")) === "現在用市價補到目前訊號，可能中途上車。"
      && get("tr.means.1") === "只在電腦醒著、Blave 開著、有網路時跑。" && get("tr.means.2") === "睡眠、關機或結束 Blave 就停，{venue}上的部位不平倉。" && get("tr.means.3") === "重開 Blave 後要再按「啟動下單」。" && get("tr.means.4") === "交易所的停損單不受影響，建議掛上。" && get("tr.means.cloud") === "要 24 小時跑：" && get("tr.means.cloudGo") === "改用雲端主機"); }
  console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  " + (e && e.stack)); process.exit(1); });
