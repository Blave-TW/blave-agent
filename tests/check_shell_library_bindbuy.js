// 策略庫綁卡即購買(spec library-buy-with-bind-2026-11-06;shell/renderer/library.js + main.js)。不起 Electron:
//   ① 框的分流:報價回應 → 框 1(試用)／2(只買)／3(要方案)與其他出口;欠費那句只在 api 回正數時出。
//   ② 結果分流:先看 status、有 reason_code 用它;別支策略的舊紀錄不算;句子對到原型態 6／7 與 §9。有卡購買刷了沒買成先於 already purchased。
//   ③ CTA:沒卡的人付費策略主鈕是購買(不被資料牆蓋掉)、付款頁開著時是等待態。
//   ④ 主行程:藍新表單只認兩個網域、欄位白名單、自動送出頁有跳脫;結果與 /purchase 的回應只留畫面要的欄位。
// 跑法:node tests/check_shell_library_bindbuy.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 1500))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const src = read(path.join(R, "library.js")), mainSrc = read(path.join(SHELL, "main.js"));
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
const STR = (() => { const sb = {}; vm.runInNewContext(read(path.join(R, "strings.js")) + "\nthis.S = STRINGS;", sb); return sb.S; })();
const P = {}; vm.createContext(P);
vm.runInContext(src.slice(src.indexOf("/* ── 純邏輯("), src.indexOf("/* ── 純邏輯到此")).replace(/^const /gm, "var "), P);
const J = (x) => JSON.stringify(x);

// ── ① 框 ──
const quote = (o) => Object.assign({ error_code: "PRICE_CONFIRM_REQUIRED", price_twd: 1600, trial: false, trial_days: null, plan_monthly_twd: null, plan_due_twd: null }, o);
const b1 = P.libBbBox(409, quote({ trial: true, trial_days: 14, plan_monthly_twd: 1440 }));
ok("① 要資料、有試用資格 → 框 1,金額與天數照 api", b1.kind === "trial" && b1.price === 1600 && b1.trialDays === 14 && b1.planMonthly === 1440 && b1.due === null, J(b1));
const b2 = P.libBbBox(409, quote({}));
ok("① 不用資料(api 不開試用)→ 框 2", b2.kind === "plain" && b2.price === 1600, J(b2));
ok("① 沒試用也沒方案 → 框 3,帶方案月費;月費缺就退回舊框", P.libBbBox(409, { error_code: "PLAN_REQUIRED", plan_monthly_twd: 1440 }).kind === "plan"
  && P.libBbBox(409, { error_code: "PLAN_REQUIRED", plan_monthly_twd: 1440 }).planMonthly === 1440 && P.libBbBox(409, { error_code: "PLAN_REQUIRED" }).kind === "fallback");
ok("① 其他出口:剛綁好卡、已買過、付款頁還開著、429、壞形狀／打不到", P.libBbBox(409, { error_code: "HAS_CARD" }).kind === "has_card"
  && P.libBbBox(400, { error: "already purchased" }).kind === "owned" && P.libBbBox(409, { error_code: "BIND_PLAN_IN_PROGRESS" }).kind === "open"
  && P.libBbBox(429, null).kind === "rate" && P.libBbBox(0, null).kind === "fallback" && P.libBbBox(409, quote({ price_twd: 0 })).kind === "fallback");
ok("① 有方案的人(報價 plan_renews_card 為 true)才出續期那句;沒帶、false、字串都不出", P.libBbBox(409, quote({ plan_renews_card: true })).renew === true
  && [false, "true", undefined, 1].every((v) => P.libBbBox(409, quote({ plan_renews_card: v })).renew === false));
ok("① 欠費那句:plan_due_twd 是正數才出(四捨五入成整數);0、null、負數、字串都不出", P.libBbBox(409, quote({ plan_due_twd: 1440 })).due === 1440
  && P.libBbBox(409, quote({ trial: true, plan_due_twd: 1439.6 })).due === 1440
  && [0, null, -5, "1440", undefined].every((v) => P.libBbBox(409, quote({ plan_due_twd: v })).due === null));
{ // 框裡真的有出那句:框 1 / 2 都看 q.due
  const body = cutFn(src, "libBindBuyBox");
  ok("① 續期那句只看 q.renew、排在腳注前;字面照 Wei 11-07", /if \(q\.renew\) extra\.appendChild\(libEl\("p", "", t\("lib\.bb\.renew"\)\)\);/.test(body) && body.indexOf("lib.bb.renew") < body.indexOf("lib.bb.topup")
    && STR.zh["lib.bb.renew"] === "之後方案續期，錢包不夠會從這張卡扣。");
  ok("① 上一張付款頁還開著那句照 api 實際行為(restart 不作廢舊頁,兩頁都付多的那筆進錢包;不再寫「不會重複扣」)", STR.zh["lib.bb.open"] === "上一筆付款頁還開著，仍能付款。再試一次會開新頁，兩頁都付的話，多的那筆存入錢包。"
    && !/不會重複扣/.test(STR.zh["lib.bb.open"]) && !/won't pay twice/.test(STR.en["lib.bb.open"]));
  ok("① 框 1、2 共用欠費那句(q.due 才 append)、框 3 不講;框 1 欠費句排在表格之後、試用句之前(稽核 ⑦);主鈕字:綁卡並購買 / 開通方案", /if \(q\.due\) \{[^\n]*lib\.bb\.due/.test(body) && body.indexOf("lib.bb.due") > body.indexOf('q.kind === "trial" || q.kind === "plain"')
    && body.indexOf("lib.bb.due") > body.indexOf("extra.appendChild(dl)") && body.indexOf("lib.bb.due") < body.indexOf("lib.bb.trialNote")
    && /t\("lib\.bb\.ok"\)/.test(body) && /t\("lib\.bb\.planBtn"\)[^\n]*planOpen\(\)/.test(body) && STR.zh["lib.bb.ok"] === "綁卡並購買" && STR.zh["lib.bb.planBtn"] === "開通方案"); }

{ const cta = cutFn(src, "libPaintCta"), ask = cutFn(src, "libBbReopenAsk");
  ok("① 〔重新打開付款頁〕先出框講「舊頁仍能付、兩頁都付多的進錢包」,按了才帶 restart 開新單(程式稽核 N3)",
    /btn\("btn-quiet", t\("lib\.bb\.reopen"\), \(b\) => libBbReopenAsk\(s, b\)\)/.test(cta) && !/libBindBuyGo\(s, LIB\.bbWait\.q, true\)/.test(cta)
    && /lines: \[t\("lib\.bb\.open"\)\]/.test(ask) && /onOk: \(\) => libBindBuyGo\(s, w\.q, true\)/.test(ask)); }

ok("① 自動儲值那句:數字讀 public_tiers 的 trial(同網頁)、兩個都是正數才講,讀不到就退回舊框;字面同網頁 bc_risk_note", J(P.libBbTopup({ auto_topup_min: 50, auto_topup_amount: 300 })) === '{"lo":"50","a":"300"}'
  && P.libBbTopup(null) === null && P.libBbTopup({ auto_topup_min: 50 }) === null && P.libBbTopup({ auto_topup_min: 0, auto_topup_amount: 300 }) === null
  && STR.zh["lib.bb.topup"] === "綁卡後自動儲值是開著的：餘額低於 {lo} TWD 會自動儲值 {a} TWD，可隨時關閉。" && /tu = libBbTopup\(typeof pub !== "undefined" && pub \? pub\.trial : null\)/.test(cutFn(src, "libBindBuyBox"))
  && /\(q\.kind === "trial" \|\| q\.kind === "plain"\) && !tu\) \{ libBuyBox\(s, "noCard", opener, \{\}\); return;/.test(cutFn(src, "libBindBuyBox"))
  && cutFn(src, "libBindBuyBox").indexOf("lib.bb.topup") > cutFn(src, "libBindBuyBox").indexOf("lib.bb.renew"));
{ const cta = cutFn(src, "libPaintCta");
  ok("① 「買了不會自動下單。」不在綁卡框與購買確認框,改放付費未購主鈕下一行小字(canon copy #4 例外);鈕下一個槽:結果句 > 等待付款句 > 這行",
    !/lib\.bb\.noAuto/.test(cutFn(src, "libBindBuyBox")) && !/不會自動下單/.test(STR.zh["lib.buy.lead"]) && !/No orders/.test(STR.en["lib.buy.lead"])
    && /if \(bbl\.length\) note\.textContent = "";\n\s*else if \(c\.state === "paid" && !note\.textContent[^\n]*note\.textContent = t\("lib\.bb\.noAuto"\);/.test(cta)
    && cta.indexOf('note.textContent = t("lib.bb.noAuto")') < cta.indexOf("note.hidden = !note.textContent;") && STR.zh["lib.bb.noAuto"] === "買了不會自動下單。"); }

// ── ② 結果 ──
const res = (o) => Object.assign({ status: "wallet", strategy_id: 7, amount_twd: 1600, reason: null, reason_code: null, trial_until: null }, o);
ok("② 別支策略的舊紀錄、沒有紀錄、壞 status 都是 none;pending 照 pending", P.libBbRes(res({ strategy_id: 8 }), 7).kind === "none" && P.libBbRes(null, 7).kind === "none"
  && P.libBbRes(res({ status: "weird" }), 7).kind === "none" && P.libBbRes(res({ status: "pending" }), 7).kind === "pending");
ok("② wallet:reason 是代號;有 reason_code 先用它", P.libBbRes(res({ reason: "unavailable" }), 7).code === "unavailable" && P.libBbRes(res({ reason: "unavailable", reason_code: "own" }), 7).code === "own");
ok("② failed:reason 是藍新的句子,不當代號;代號只看 reason_code", P.libBbRes(res({ status: "failed", reason: "unavailable", amount_twd: null }), 7).code === null
  && P.libBbRes(res({ status: "failed", reason: "卡片餘額不足", reason_code: "card_declined" }), 7).code === "card_declined");
const keys = (r) => P.libBbLines(r).map((l) => l.key + (l.p ? ":" + l.p : "") + (l.d ? "@" + l.d : "")).join("|");
ok("② 句子:下架、已買過用原型句;其他原因講已刷 N、錢在錢包;沒金額另一句;開了試用接到期日;刷卡失敗;成功沒有句子",
  keys(P.libBbRes(res({ reason: "unavailable" }), 7)) === "lib.bb.gone:1600" && keys(P.libBbRes(res({ reason: "already_purchased" }), 7)) === "lib.bb.owned:1600"
  && keys(P.libBbRes(res({ reason: "price_changed" }), 7)) === "lib.bb.wallet:1600" && keys(P.libBbRes(res({ amount_twd: null, reason: "error" }), 7)) === "lib.bb.walletNoAmt"
  && keys(P.libBbRes(res({ reason: "unavailable", trial_until: "2026-11-20T23:59:59+08:00" }), 7)) === "lib.bb.gone:1600|lib.bb.trialOn@11/20"
  && keys(P.libBbRes(res({ status: "failed", amount_twd: null }), 7)) === "lib.bb.failed" && keys(P.libBbRes(res({ status: "ok", trial_until: "2026-11-20" }), 7)) === "", keys(P.libBbRes(res({ reason: "unavailable", trial_until: "2026-11-20T23:59:59+08:00" }), 7)));
ok("② 字串照設計稽核 ①(錢包一律「已存入錢包」)與 ⑤", STR.zh["lib.bb.wallet"] === "已刷 {p}，錢已存入錢包，策略沒買成。" && STR.zh["lib.bb.gone"] === "已下架沒買成，{p} 已存入錢包。" && STR.zh["lib.bb.owned"] === "已買過，{p} 已存入錢包。"
  && STR.zh["lib.bb.walletNoAmt"] === "策略沒買成，錢已存入錢包。" && STR.zh["lib.bb.expired"] === "付款頁已過期，沒付的話不會扣款。" && !("lib.bb.seeBalance" in STR.zh) && !/lib\.bb\.seeBalance/.test(src)
  && STR.zh["lib.bb.due"] === "你的方案欠費 {p}，綁卡後會一起補扣。" && STR.zh["lib.bb.failed"] === "刷卡沒成功，沒有扣款。" && STR.zh["lib.bb.trialOn"] === "試用照常，到 {d}。"
  && Object.keys(STR.zh).filter((k) => k.startsWith("lib.bb.")).every((k) => typeof STR.en[k] === "string" && STR.en[k].length > 0));
ok("② 有卡購買:400 already purchased 帶 amount_twd 是 charged(不再當成功);402／500 帶也是;沒帶照舊",
  P.libBuyBranch(400, { error: "already purchased", amount_twd: 1500.0, reason: "already_purchased" }) === "charged" && P.libBuyBranch(402, { error: "insufficient credits", amount_twd: 1500 }) === "charged"
  && P.libBuyBranch(500, { error: "purchase failed", amount_twd: 1500 }) === "charged" && P.libBuyBranch(400, { error: "already purchased" }) === "ok"
  && P.libBuyBranch(402, { needs_topup: true, has_card: false }) === "noCard" && P.libBuyBranch(402, { needs_topup: true, has_card: true, amount_twd: null }) === "topup");
{ const c = P.libBbCharged({ amount_twd: 1500.0, reason: "already_purchased" });
  ok("② charged 的句子跟綁卡即購買同一套、金額取整", keys(c) === "lib.bb.owned:1500" && keys(P.libBbCharged({ amount_twd: 1499.6, reason: "insufficient" })) === "lib.bb.wallet:1500"); }

// ── ③ CTA ──
const S = (o) => Object.assign({ id: 7, price: 1600, purchased: false, is_owner: false, blave_data: "required" }, o);
const C = (o) => Object.assign({ running: false, env: "local", signedIn: true, dataAccess: "none", why: "no_card", cloud: null, pending: null, noNew: null, buying: null, installedName: null, bindWait: null, bbOk: null, noCard: true, bal: 0 }, o);
ok("③ 已知沒卡又錢包不夠、要資料的付費策略:主鈕是購買、直接出綁卡框(short)", P.libCta(S(), C()).state === "paid" && P.libCta(S(), C()).short === true && P.libCta(S(), C({ bal: 1599 })).short === true);
ok("③ 沒卡但錢包夠、錢包還不知道、卡狀態不知道:照舊資料牆(稽核 ③ 收窄)", P.libCta(S(), C({ bal: 1600 })).state === "noData" && P.libCta(S(), C({ bal: null })).state === "noData" && P.libCta(S(), C({ noCard: null })).state === "noData");
ok("③ 不用資料的付費策略:錢包夠就走確認框(short false)、不夠才直接出綁卡框", P.libCta(S({ blave_data: "none" }), C({ bal: 5000 })).short === false && P.libCta(S({ blave_data: "none" }), C()).short === true);
ok("③ 其他原因(沒方案、欠費、查不到)與免費策略照舊是資料牆", P.libCta(S(), C({ why: "no_plan" })).state === "noData" && P.libCta(S({ price: 0 }), C()).state === "noData"
  && P.libCta(S({ purchased: true }), C()).state === "noData");
ok("③ 剛綁卡即購買成功、還沒重拉:已購買暫態(安裝並回測),不閃資料牆;別支不受影響", P.libCta(S({ purchased: true }), C({ bbOk: 7 })).state === "owned" && P.libCta(S({ id: 8, purchased: true }), C({ bbOk: 7 })).state === "noData");
ok("③ 付款頁開著:這支是等待態,別支不受影響", P.libCta(S(), C({ bindWait: 7 })).state === "bindWait" && P.libCta(S({ id: 8 }), C({ bindWait: 7 })).state === "paid");

// ── ④ 主行程 ──
const M = { URL, Buffer }; vm.createContext(M);
vm.runInContext(["libCode", "libPurchaseBody", "libBindBuyBody", "libPayForm", "libPayHtml", "libBindResultOut"].map((n) => cutFn(mainSrc, n)).join("\n") + "\nvar LIB_PAY_HOSTS = " + /const LIB_PAY_HOSTS = (\[[^\]]*\]);/.exec(mainSrc)[1] + ";", M);
const form = (o) => Object.assign({ url: "https://core.newebpay.com/MPG/mpg_gateway", MerchantID: "MS12345", TradeInfo: "ab".repeat(40), TradeSha: "C".repeat(64), Version: "2.0" }, o);
ok("④ 表單:正式／測試兩個藍新網域才收,http、別的網域、帶帳密、欄位形狀不對都丟", !!M.libPayForm(form()) && !!M.libPayForm(form({ url: "https://ccore.newebpay.com/MPG/mpg_gateway" }))
  && [{ url: "http://core.newebpay.com/x" }, { url: "https://core.newebpay.com.evil.io/x" }, { url: "https://evil.io/x" }, { url: "https://u:p@core.newebpay.com/x" }, { TradeSha: "zz" }, { MerchantID: "a\"b" }, { TradeInfo: "<x>" }]
    .every((o) => M.libPayForm(form(o)) === null) && J(Object.keys(M.libPayForm(form({ extra: "1" })).fields)) === '["MerchantID","TradeInfo","TradeSha","Version"]');
{ const h = M.libPayHtml({ url: "https://core.newebpay.com/a?x=1&y=\"2\"", fields: { MerchantID: "M<1>" } }, "NONCE");
  ok("④ 自動送出頁:屬性有跳脫、script 帶 nonce、POST", h.includes('action="https://core.newebpay.com/a?x=1&amp;y=&quot;2&quot;"') && h.includes('value="M&lt;1&gt;"') && h.includes('<script nonce="NONCE">') && h.includes('method="POST"')); }
ok("④ 結果:形狀不對整筆 null;failed 的中文句被丟、代號留著;金額 ≤0 當沒有", M.libBindResultOut({ bind_purchase: { status: "nope", strategy_id: 7 } }) === null && M.libBindResultOut({}) === null
  && J(M.libBindResultOut({ bind_purchase: { status: "failed", strategy_id: 7, reason: "卡片被拒", reason_code: "card_declined", amount_twd: 0, order_no: "TCC_1_x_S7" } })) === '{"status":"failed","strategy_id":7,"amount_twd":null,"reason":null,"reason_code":"card_declined","trial_until":null}');
ok("④ /purchase 的回應多留 amount_twd / reason / reason_code", J(M.libPurchaseBody({ error: "already purchased", amount_twd: 1500.0, reason: "already_purchased" })).includes('"amount_twd":1500,"reason":"already_purchased","reason_code":null'));
ok("④ IPC:綁卡即購買只收自家頁面;記號拿到這支終態才清,並作廢帳號與清單快取", /\n  handle\("library-bind-buy", \(_e, id, opts\) => libraryBindBuy\(id, opts\), \{ status: 0, body: null \}\);/.test(mainSrc)
  && /res\.strategy_id === mark\.id && res\.status !== "pending"\) \{ libBbMarkSet\(null\); lastAcct = null; libCache = null; \}/.test(cutFn(mainSrc, "libraryBindResult")));

// ── ⑤ 輪詢(libBbPoll / libBbDone 切出來,四周全是替身;計時器只記下、手動推)──
(async () => {
  const mk = (replies, s) => {
    const F = { replies, s, timers: [], events: [], acct: 0, refresh: 0, now: 1000, boughtOnLoad: false };
    vm.createContext(F);
    vm.runInContext(src.slice(src.indexOf("/* ── 純邏輯("), src.indexOf("/* ── 純邏輯到此")).replace(/^const /gm, "var ") + `
      var LIB = { bbWait: null, bbRes: new Map(), bbTop: null, bbTimer: null, bbBusy: false, stale: false, data: null }, LIB_BB_POLL_MS = 5000, hasToken = true;
      var Date = { now: () => now }, setTimeout = (f, ms) => { timers.push(ms); return timers.length; }, clearTimeout = () => {};
      var libFind = (id) => (s && s.id === id ? s : null), libSync = () => {}, libRefresh = () => { refresh++; }, libLoad = async () => { refresh++; if (s && boughtOnLoad) s.purchased = true; }, libBalLoad = async () => {}, libCtaMain = () => null, libFocusFree = () => true, acctSet = () => { acct++; }, acctPaint = () => {};
      var window = { blave: { libraryBindResult: async () => replies.shift(), trackEvent: (e, p) => events.push(e + ":" + p.step), accountStatus: async () => ({}) } };
      function libBbTrack(step) { window.blave.trackEvent("lib_bindbuy", { step }); }
      ` + cutFn(src, "libBbPollSoon") + "\nasync " + cutFn(src, "libBbPoll") + "\n" + cutFn(src, "libBbDone"), F);
    return F;
  };
  const wait = (F, id, until) => { F.LIB.bbWait = { id, q: { price: 1600 }, until }; };
  { // 先 pending 再 wallet(下架):第一輪排下一次,第二輪收尾
    const s = { id: 7, purchased: false };
    const F = mk([{ mark: { id: 7, at: 0 }, res: res({ status: "pending" }) }, { mark: { id: 7, at: 0 }, res: res({ reason: "unavailable", trial_until: "2026-11-20" }) }], s);
    wait(F, 7, 1e9); await F.libBbPoll();
    const after1 = { waiting: !!F.LIB.bbWait, timers: F.timers.join() };
    await F.libBbPoll();
    const r = F.LIB.bbRes.get(7);
    ok("⑤ pending → 排下一輪(5 秒);wallet → 停止等待、結果記在這支、送 lib_bindbuy:wallet、清單與帳號重問;下架那支句子放清單頂、不標已購買",
      after1.waiting && after1.timers === "5000" && F.LIB.bbWait === null && !!r && r.kind === "wallet" && r.code === "unavailable" && F.events.join() === "lib_bindbuy:wallet"
      && F.LIB.stale === true && F.refresh === 1 && F.LIB.bbTop && F.LIB.bbTop.id === 7 && s.purchased === false, JSON.stringify({ after1, r, ev: F.events, top: F.LIB.bbTop }));
  }
  { const s = { id: 7, purchased: false }, F = mk([{ mark: { id: 7, at: 0 }, res: res({ status: "ok", amount_twd: 1600 }) }], s);
    wait(F, 7, 1e9); await F.libBbPoll();
    const during = F.LIB.bbOk; await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    ok("⑤ ok → 標已購買(不自動安裝)、送 lib_bindbuy:ok;重拉期間 bbOk 暫態,帳號與清單都回來才拿掉", s.purchased === true && F.events.join() === "lib_bindbuy:ok" && F.LIB.bbWait === null && F.LIB.bbTop === null && during === 7 && F.LIB.bbOk === null && F.refresh === 1); }
  { // D1:重開過付款頁、付的是舊頁 → 結果槽仍是新單的 pending;回前景重拉清單看到已購買就收尾
    const s = { id: 7, purchased: false }, F = mk([{ mark: { id: 7, at: 0 }, res: res({ status: "pending" }) }], s);
    F.boughtOnLoad = true; wait(F, 7, 1e9); F.LIB.bbWait.check = true; await F.libBbPoll();
    ok("⑤ 付了舊頁(結果槽被新單佔著):回前景重拉清單、已購買就當成功收尾,不等到逾時", F.LIB.bbWait === null && F.LIB.bbRes.get(7).kind === "ok" && F.events.join() === "lib_bindbuy:ok" && F.replies.length === 1);
    const G = mk([1, 2, 3, 4, 5, 6].map(() => ({ mark: { id: 7, at: 0 }, res: res({ status: "pending" }) })), { id: 7, purchased: false });
    wait(G, 7, 1e9); for (let i = 0; i < 6; i++) await G.libBbPoll();
    ok("⑤ 沒回前景也每 6 輪(30 秒)重拉一次清單", G.refresh === 1); }
  { const F = mk([{ mark: null, res: null }], null);
    wait(F, 7, 1e9); await F.libBbPoll();
    ok("⑤ 主行程的記號沒了(過期):停止等待、主鈕下方講「付款頁已過期」、不送埋點", F.LIB.bbWait === null && F.LIB.bbRes.get(7) && F.LIB.bbRes.get(7).key === "lib.bb.expired" && F.events.length === 0 && F.timers.length === 0); }
  { const F = mk([{ mark: { id: 7, at: 0 }, res: res({ status: "pending" }) }], null);
    wait(F, 7, 500); await F.libBbPoll();
    ok("⑤ 超過付款單效期還是 pending:停止等待、不再排下一輪、講「付款頁已過期」", F.LIB.bbWait === null && J(P.libBbLines(F.LIB.bbRes.get(7))) === '[{"key":"lib.bb.expired"}]' && F.timers.length === 0); }
  { const F = mk([{ mark: { id: 7, at: 0 }, res: res({ strategy_id: 8, status: "failed" }) }], null);
    wait(F, 7, 1e9); await F.libBbPoll();
    ok("⑤ 別支策略的終態不算這支的:繼續等", !!F.LIB.bbWait && F.LIB.bbRes.size === 0 && F.timers.join() === "5000"); }
  console.log(red ? `\n${red} 條沒過` : "\n全部通過");
  process.exit(red ? 1 : 0);
})();
