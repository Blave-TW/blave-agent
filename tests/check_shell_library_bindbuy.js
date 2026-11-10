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
    && /lines: \[t\("lib\.bb\.open"\)\]/.test(ask) && /: \(\) => libBindBuyGo\(s, w\.q, true\) \}\);/.test(ask)
    // 重開 app 後接著等的方案單(記號沒有合計):重報價、重出框 ③,按 OK 才帶 restart
    && /const requote = w\.q\.plan === true && !w\.q\.total;/.test(ask) && /requote \? \(\) => \{ LIB\.bbRestart\.add\(s\.id\); libPlanBuy\(s, libCtaMain\(\)\); \}/.test(ask)); }

ok("① 自動儲值那句:數字讀 public_tiers 的 trial(同網頁)、兩個都是正數才講,讀不到就退回舊框;字面同網頁 bc_risk_note", J(P.libBbTopup({ auto_topup_min: 50, auto_topup_amount: 300 })) === '{"lo":"50","a":"300"}'
  && P.libBbTopup(null) === null && P.libBbTopup({ auto_topup_min: 50 }) === null && P.libBbTopup({ auto_topup_min: 0, auto_topup_amount: 300 }) === null
  && STR.zh["lib.bb.topup"] === "綁卡後自動儲值是開著的：餘額低於 {lo} TWD 會自動儲值 {a} TWD，可隨時關閉。" && /tu = libBbTopup\(typeof pub !== "undefined" && pub \? pub\.trial : null\)/.test(cutFn(src, "libBindBuyBox"))
  && /\(q\.kind === "trial" \|\| q\.kind === "plain"\) && !tu\) \{ libBuyBox\(s, "noCard", opener, \{\}\); return;/.test(cutFn(src, "libBindBuyBox"))
  && cutFn(src, "libBindBuyBox").indexOf("lib.bb.topup") > cutFn(src, "libBindBuyBox").indexOf("lib.bb.renew"));
{ const cta = cutFn(src, "libPaintCta");
  ok("① 「買了不會自動下單。」鈕下、框裡都拿掉(Wei 11-09):字串連鍵刪掉、library.js 不再引用;購買框導語也不講;有結果句(含一鍵購買付完那句)時只出結果句(續扣那一行收起來,實畫見 ⑥)",
    !("lib.bb.noAuto" in STR.zh) && !("lib.bb.noAuto" in STR.en) && !/lib\.bb\.noAuto|不會自動下單/.test(src) && !/不會自動下單/.test(STR.zh["lib.buy.lead"]) && !/No orders/.test(STR.en["lib.buy.lead"])
    && /if \(bbl\.length \|\| paid\) note\.textContent = "";\n\s*else under\.forEach\(\(p\) => box\.appendChild\(p\)\);/.test(cta)); }

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
vm.runInContext(["libCode", "libPurchaseBody", "libBindBuyBody", "libPayForm", "libPayHtml", "libBindResultOut", "libCheckoutBody"].map((n) => cutFn(mainSrc, n)).join("\n") + "\nvar LIB_PAY_HOSTS = " + /const LIB_PAY_HOSTS = (\[[^\]]*\]);/.exec(mainSrc)[1] + ";"
  + "\nvar LIB_PAY_SRC = " + /const LIB_PAY_SRC = (\[[^\]]*\]);/.exec(mainSrc)[1] + ";\nvar LIB_DAY_RE = /^\\d{4}-\\d{2}-\\d{2}$/; var libDay = (v) => (typeof v === \"string\" && LIB_DAY_RE.test(v) ? v : null);", M);
const form = (o) => Object.assign({ url: "https://core.newebpay.com/MPG/mpg_gateway", MerchantID: "MS12345", TradeInfo: "ab".repeat(40), TradeSha: "C".repeat(64), Version: "2.0" }, o);
ok("④ 表單:正式／測試兩個藍新網域才收,http、別的網域、帶帳密、欄位形狀不對都丟", !!M.libPayForm(form()) && !!M.libPayForm(form({ url: "https://ccore.newebpay.com/MPG/mpg_gateway" }))
  && [{ url: "http://core.newebpay.com/x" }, { url: "https://core.newebpay.com.evil.io/x" }, { url: "https://evil.io/x" }, { url: "https://u:p@core.newebpay.com/x" }, { TradeSha: "zz" }, { MerchantID: "a\"b" }, { TradeInfo: "<x>" }]
    .every((o) => M.libPayForm(form(o)) === null) && J(Object.keys(M.libPayForm(form({ extra: "1" })).fields)) === '["MerchantID","TradeInfo","TradeSha","Version"]');
{ const h = M.libPayHtml({ url: "https://core.newebpay.com/a?x=1&y=\"2\"", fields: { MerchantID: "M<1>" } }, "NONCE");
  ok("④ 自動送出頁:屬性有跳脫、script 帶 nonce、POST", h.includes('action="https://core.newebpay.com/a?x=1&amp;y=&quot;2&quot;"') && h.includes('value="M&lt;1&gt;"') && h.includes('<script nonce="NONCE">') && h.includes('method="POST"')); }
ok("④ 結果:形狀不對整筆 null;failed 的中文句被丟、代號留著;金額 ≤0 當沒有", M.libBindResultOut({ bind_purchase: { status: "nope", strategy_id: 7 } }) === null && M.libBindResultOut({}) === null
  && J(M.libBindResultOut({ bind_purchase: { status: "failed", strategy_id: 7, reason: "卡片被拒", reason_code: "card_declined", amount_twd: 0, order_no: "TCC_1_x_S7" } })) === '{"status":"failed","strategy_id":7,"amount_twd":null,"reason":null,"reason_code":"card_declined","trial_until":null}');
ok("④ /purchase 的回應多留 amount_twd / reason / reason_code", J(M.libPurchaseBody({ error: "already purchased", amount_twd: 1500.0, reason: "already_purchased" })).includes('"amount_twd":1500,"reason":"already_purchased","reason_code":null'));
ok("④ IPC:綁卡即購買只收自家頁面;記號拿到這支終態才清,並作廢帳號、清單與餘額快取(付完自動安裝要扣後的餘額);框 ② 回來也作廢餘額", /\n  handle\("library-bind-buy", \(_e, id, opts\) => libraryBindBuy\(id, opts\), \{ status: 0, body: null \}\);/.test(mainSrc)
  && /res\.strategy_id === mark\.id && res\.status !== "pending"\) \{ libBbMarkSet\(null\); lastAcct = null; libCache = null; if \(_balance\) _balance\.reset\(\); \}/.test(cutFn(mainSrc, "libraryBindResult"))
  && /lastAcct = null; libCache = null;[^\n]*\n\s*if \(_balance\) _balance\.reset\(\);/.test(cutFn(mainSrc, "libraryCardCheckout")));

// ── ⑥ 一步開通(spec library-free-data-one-step;0.1.50)──
{ const qb = (o) => Object.assign({ strategy_id: 7, price_twd: 600, plan_required: true, plan_blocked: null, has_card: false, card_last4: null, balance: 0, trial_eligible: false,
    plan_twd: 1440, total_twd: 2040, plan_renews_on: "2026-12-08", plan_source: "none", price_source: "none" }, o);
  const D = P.libPqOf(200, qb({}));
  ok("⑥ 報價:沒卡、錢包不夠 → 框 ③(planpay),金額照 api、續扣日 MM/DD", D.kind === "planpay" && D.price === 600 && D.plan === 1440 && D.total === 2040 && D.renewsOn === "12/08", J(D));
  const C2 = P.libPqOf(200, qb({ has_card: true, card_last4: "4242", plan_source: "card", price_source: "card" }));
  ok("⑥ 報價:有卡 → 框 ②(cardplan),帶來源與末四碼;錢包夠總額沒卡也是框 ②", C2.kind === "cardplan" && C2.planSrc === "card" && C2.priceSrc === "card" && C2.last4 === "4242"
    && P.libPqOf(200, qb({ balance: 3000, plan_source: "wallet", price_source: "wallet" })).kind === "cardplan");
  ok("⑥ 報價:錢包只夠一期(方案錢包、策略付不出)→ 框 ③;B 型(策略價 0)只看方案", P.libPqOf(200, qb({ balance: 1500, plan_source: "wallet", price_source: "none" })).kind === "planpay"
    && P.libPqOf(200, qb({ price_twd: 0, total_twd: 1440, price_source: null, plan_source: "card", has_card: true })).kind === "cardplan");
  ok("⑥ 報價:合計對不上分項、來源不明 → 不出框(fail)", P.libPqOf(200, qb({ total_twd: 2000 })).kind === "fail" && P.libPqOf(200, qb({ plan_source: null, price_source: "card", has_card: true })).kind === "fail");
  ok("⑥ 報價:開不了方案 → block(名下有主機、扣款還在確認、方案制沒上);已開了方案 / 已有資料 / 有試用資格沒卡 → refresh;404 下架、429",
    P.libPqOf(200, qb({ plan_blocked: "HAS_SERVER" })).block === "HAS_SERVER" && P.libPqOf(200, qb({ plan_blocked: "PLAN_CHARGE_UNCONFIRMED" })).kind === "block"
    && P.libPqOf(200, qb({ plan_blocked: "PLAN_ALREADY_ACTIVE" })).kind === "refresh" && P.libPqOf(200, qb({ plan_required: false })).kind === "refresh"
    && P.libPqOf(200, qb({ trial_eligible: true })).kind === "refresh" && P.libPqOf(200, qb({ trial_eligible: true, has_card: true, plan_source: "card", price_source: "card" })).kind === "cardplan"
    && P.libPqOf(404, {}).kind === "gone" && P.libPqOf(429, null).kind === "rate" && P.libPqOf(0, null).kind === "fail");
  const ch = P.libPqOf(409, { error_code: "SOURCE_CHANGED", plan: true, price_twd: 600, plan_twd: 1440, total_twd: 2040, plan_source: "card", price_source: "card", card_last4: "4242" });
  ok("⑥ card_checkout 的 409 SOURCE_CHANGED 帶新報價 → 重出框 ② 並講錢包變了;403 NO_CARD → 框 ③", ch.kind === "cardplan" && ch.changed === true
    && P.libPqOf(403, { error_code: "NO_CARD", plan: true, price_twd: 600, plan_twd: 1440, total_twd: 2040, plan_source: "none", price_source: "none" }).kind === "planpay");
  // 付款頁報價(bind_purchase 帶 accept_plan):plan 報價排在 trial／plain 前面
  const pp = P.libBbBox(409, { error_code: "PRICE_CONFIRM_REQUIRED", plan: true, trial: false, price_twd: 600, plan_twd: 1440, total_twd: 2040, plan_renews_on: "2026-12-08" });
  ok("⑥ 付款頁報價 plan:true → planpay(不是框 2);合計不符 → fallback;開不了方案 → block;USE_TRIAL／NOTHING_TO_PAY／PLAN_ALREADY_ACTIVE → refresh", pp.kind === "planpay" && pp.total === 2040
    && P.libBbBox(409, { error_code: "PRICE_CONFIRM_REQUIRED", plan: true, price_twd: 600, plan_twd: 1440, total_twd: 600 }).kind === "fallback"
    && P.libBbBox(409, { error_code: "HAS_SERVER" }).kind === "block" && ["USE_TRIAL", "NOTHING_TO_PAY", "PLAN_ALREADY_ACTIVE"].every((c) => P.libBbBox(409, { error_code: c }).kind === "refresh"));
  const srcOf = (o) => { const r = P.libPbSrc(Object.assign({ price: 600, planSrc: "card", priceSrc: "card", last4: "4242" }, o)); return r ? r.key + (r.l ? ":" + r.l : "") : null; };
  ok("⑥ 框 ② 今天從哪扣:同卡、同錢包、方案錢包策略卡、反過來;末四碼缺寫綁定的卡;B 型只看方案;內部帳號不講",
    srcOf({}) === "lib.bb.srcCard:4242" && srcOf({ last4: null }) === "lib.bb.srcCardAny" && srcOf({ planSrc: "wallet", priceSrc: "wallet" }) === "lib.bb.srcWallet"
    && srcOf({ planSrc: "wallet" }) === "lib.bb.srcMixWc:4242" && srcOf({ priceSrc: "wallet" }) === "lib.bb.srcMixCw:4242" && srcOf({ planSrc: "wallet", last4: null }) === "lib.bb.srcMixWcAny"
    && srcOf({ price: 0, priceSrc: null, planSrc: "wallet" }) === "lib.bb.srcWallet" && srcOf({ planSrc: "free" }) === null);
  const co = (st, b) => P.libCardOut(st, b);
  ok("⑥ card_checkout 回應:ok／partial(已買過算成功)／方案刷卡被拒／要重報價／開不了方案／連點／已開方案",
    co(200, { status: "ok" }).kind === "ok" && co(200, { status: "partial", purchase_reason: "already_purchased" }).kind === "ok"
    && co(200, { status: "partial", purchase_reason: "card_declined" }).kind === "part" && co(402, { error_code: "PLAN_CHARGE_FAILED" }).kind === "declined"
    && co(409, { error_code: "SOURCE_CHANGED" }).kind === "requote" && co(409, { error_code: "SOURCE_CHANGED" }).changed === true && co(403, { error_code: "NO_CARD" }).kind === "requote"
    && co(409, { error_code: "HAS_SERVER" }).block === "HAS_SERVER" && co(409, { error_code: "CHECKOUT_IN_PROGRESS" }).kind === "inProgress"
    && co(409, { error_code: "PLAN_ALREADY_ACTIVE" }).kind === "refresh" && co(0, null).kind === "fail" && co(429, null).kind === "rate"
    // 稽核 B-1:方案那段漲價(PlanError PLAN_CONFIRM_REQUIRED 原樣回)也是重報價,不是「購買失敗」
    && co(409, { error_code: "PLAN_CONFIRM_REQUIRED", plan_status: "failed" }).kind === "requote");
  const cl = (b) => P.libCardLines(P.libCardOut(200, Object.assign({ status: "partial" }, b))).map((l) => l.key + (l.p ? ":" + l.p : "")).join();
  ok("⑥ partial 的句子:刷了沒買成講金額在錢包;錢包交易出錯講錢在錢包;刷卡被拒、錢包不夠講沒扣", cl({ purchase_reason: "insufficient", amount_twd: 600 }) === "lib.bb.planPart:600"
    && cl({ purchase_reason: "error" }) === "lib.bb.planPartNoAmt" && cl({ purchase_reason: "card_declined" }) === "lib.bb.partNoCharge" && cl({ purchase_reason: "source_changed" }) === "lib.bb.partNoCharge");
  // 結果(付款頁)讀 wallet_twd,不讀 amount_twd(總額)
  const pr = (o) => keys(P.libBbRes(res(Object.assign({ plan: true, amount_twd: 2040, price_twd: 600 }, o)), 7));
  ok("⑥ 方案單結果句:都成沒有句子;方案別處已開講方案那筆;方案成策略沒成、方案沒成各講 wallet_twd;wallet_twd 是 null 不寫數字;interrupted 不當過期",
    pr({ status: "ok", plan_status: "ok", wallet_twd: 0 }) === "" && pr({ status: "ok", plan_status: "active", wallet_twd: 1440 }) === "lib.bb.planActive:1440"
    && pr({ status: "wallet", plan_status: "ok", wallet_twd: 600, reason: "insufficient" }) === "lib.bb.planPart:600" && pr({ status: "wallet", plan_status: "failed", wallet_twd: 2040, reason: "plan_failed" }) === "lib.bb.planFail:2040"
    && pr({ status: "wallet", plan_status: "active", wallet_twd: null, reason: "interrupted" }) === "lib.bb.planPartNoAmt" && pr({ status: "wallet", plan_status: "failed", wallet_twd: null, reason: "interrupted" }) === "lib.bb.planFailNoAmt");
  ok("⑥ 埋點 step:ok_free／ok_paid／part／wallet／failed", P.libBpStep({ kind: "ok" }, true) === "ok_free" && P.libBpStep({ kind: "ok" }, false) === "ok_paid"
    && P.libBpStep({ kind: "wallet", planStatus: "ok" }) === "part" && P.libBpStep({ kind: "wallet", planStatus: "failed" }) === "wallet" && P.libBpStep({ kind: "failed" }) === "failed");
  // CTA:方案制、沒方案(no_plan)、要資料、卡／錢包／月價都知道 → planBuy;任一不知道或不在方案制 → 資料牆
  const cp = (s, o) => P.libCta(S(s), C(Object.assign({ why: "no_plan", dataAccess: "plan_required", planMo: true, planTwd: 1440, noCard: true, bal: 0 }, o)));
  ok("⑥ CTA:沒方案 × 要資料 → planBuy(付費未購 paid=true、已買的照 B);不用資料不出;卡、錢包、月價、方案制任一不知道照舊資料牆",
    cp({}).state === "planBuy" && cp({}).paid === true && cp({ purchased: true }).state === "planBuy" && cp({ purchased: true }).paid === false && cp({ price: 0 }).state === "planBuy"
    && cp({ blave_data: null }).state === "planBuy" && cp({ blave_data: "none" }).state === "paid"
    && cp({}, { noCard: null }).state === "noData" && cp({}, { bal: null }).state === "noData" && cp({}, { planTwd: null }).state === "noData" && cp({}, { planMo: false }).state === "noData"
    && cp({}, { noCard: false }).state === "planBuy" && cp({}, { env: "cloud", cloud: "live" }).state === "paid");
  ok("⑥ CTA:名下有主機 → planResume;扣款還在確認 → planWait;方案制沒上 → 資料牆;報價中 → buying;剛付完重拉中(bbOk)不閃開通鈕",
    cp({}, { planBlock: "HAS_SERVER" }).state === "planResume" && cp({}, { planBlock: "PLAN_CHARGE_UNCONFIRMED" }).state === "planWait" && cp({}, { planBlock: "PLAN_NOT_ACTIVE" }).state === "noData"
    && cp({}, { buying: 7 }).state === "buying" && cp({ purchased: true }, { bbOk: 7 }).state === "owned" && cp({}, { bindWait: 7 }).state === "bindWait"
    && cp({}).why === "no_plan" && cp({}, { planBlock: "HAS_SERVER" }).why === "no_plan");
  ok("⑥ 有試用資格又沒卡(no_card)照舊 0.1.49:付費的出綁卡框、免費的資料牆(綁卡試用)", cp({}, { why: "no_card" }).state === "paid" && cp({ price: 0 }, { why: "no_card" }).state === "noData");
  // 登入回來接哪一步
  const ln = (s, o, mo) => P.libLoginNext(P.libCta(S(s), C(o)), mo !== false);
  ok("⑥ 登入後:免費不用資料／已有資料 → install;付費 → box;沒方案 → box;有試用資格沒卡的要資料免費策略 → pay;欠費、已安裝、查不到 → cta",
    ln({ price: 0, blave_data: "none" }, {}) === "install" && ln({ price: 0 }, { dataAccess: "included", why: null }) === "install" && ln({ purchased: true }, { dataAccess: "included", why: null }) === "install"
    && ln({}, { dataAccess: "included", why: null, noCard: false, bal: 0 }) === "box" && ln({ price: 0 }, { why: "no_plan", dataAccess: "plan_required", planMo: true, planTwd: 1440 }) === "box"
    && ln({ price: 0 }, { why: "no_card", dataAccess: "plan_required" }) === "pay" && ln({ price: 0 }, { why: "plan_failed", dataAccess: "payment_failed" }) === "cta"
    && ln({ price: 0 }, { dataAccess: "included", why: null, installedName: "x" }) === "cta" && ln({ price: 0 }, { why: "no_card", dataAccess: "plan_required" }, false) === "cta");
  // 稽核 S-2:付費要資料、沒卡有試用,錢包夠策略價或讀不到(libCta 是 noData)→ 報價出框 1,不開綁卡頁(spec §2.3;web c5de94c65 付費策略也從不開綁卡頁)
  ok("⑥ 登入後:付費 × 沒卡有試用,錢包 0／夠／讀不到 → 一律 box(不是 pay)", [0, 600, 3000, null].every((bal) => ln({}, { why: "no_card", dataAccess: "plan_required", noCard: true, bal }) === "box")
    && /else if \(next === "box"\) \{ if \(c\.short \|\| c\.state === "noData"\) libBindBuy\(s, m, dir \? \{ direct: dir \} : undefined\); else libBuyBox\(s, "confirm", m, \{\}\); \}/.test(cutFn(src, "libLoginGo")));
  ok("⑥ 訪客主鈕字:付費 → 登入並購買;不用資料 → 登入並安裝;要資料或未標 → 登入並使用", P.libSignedOutKey(S({}), true) === "lib.bb.loginBuy" && P.libSignedOutKey(S({ blave_data: "none", price: 0 }), false) === "lib.bb.loginInstall"
    && P.libSignedOutKey(S({ blave_data: null, price: 0 }), false) === "lib.bb.loginUse");
  ok("⑥ 字面:鈕 ≤ 原型(開通 每 30 天 N／開通並購買 N／綁卡並付 N／付 N)、框三行(兩列＋一句)", STR.zh["lib.bb.planB"] === "開通 每 30 天 {p}" && STR.zh["lib.bb.planD"] === "開通並購買 {p}"
    && STR.zh["lib.bb.planOk"] === "綁卡並付 {p}" && STR.zh["lib.bb.pay"] === "付 {p}" && STR.zh["lib.bb.planTitle"] === "開通 Blave Agent 方案" && STR.zh["lib.bb.planTail"] === "續扣先錢包後卡。可在方案頁取消，不退款。"
    && STR.en["lib.bb.ok"] === "Add Card & Buy"
    // 設計稽核 desktop-one-step:扣款中「付款中…」;扣款還在確認「稍後再回來看」(電腦版沒有重新整理);partNoCharge 講清楚沒扣的是策略價;恢復方案用設定頁那顆
    && STR.zh["lib.bb.paying"] === "付款中…" && STR.zh["lib.bb.unsettled"] === "扣款還在確認，不會重複扣。稍後再回來看。" && !/重新整理/.test(STR.zh["lib.bb.unsettled"])
    && STR.zh["lib.bb.partNoCharge"] === "方案已開通，策略沒買成，策略價沒有扣。" && !("lib.bb.resume" in STR.zh) && !("lib.bb.resume" in STR.en)
    && /case "planResume": row\.appendChild\(btn\("btn-fill", t\("plan\.resumeWeb"\), \(\) => planWebGo\(\)\)\);/.test(cutFn(src, "libPaintCta"))
    && /busy\.append\(sp, t\("lib\.bb\.paying"\)\)/.test(cutFn(src, "libCardGo")) && /ok: t\("lib\.bb\.paying"\), okDisabled: true/.test(cutFn(src, "libCardGo"))
    && ["srcCard", "srcCardAny", "srcWallet", "srcMixWc", "srcMixWcAny", "srcMixCw", "srcMixCwAny"].every((k) => / uses /.test(STR.en["lib.bb." + k])));
  ok("⑥ 開不了方案的原因只記到下一次進來:libOpen 與回前景(libRefresh)都清 planBlock(扣款確認完、恢復方案後主鈕回得來)",
    /LIB\.planBlock = null;/.test(cutFn(src, "libOpen")) && /function libRefresh\(\) \{ LIB\.planBlock = null;/.test(src));
  { const si = cutFn(src, "libSignIn"), fn = cutFn(src, "libCtaFocusNow"), lg = cutFn(src, "libLoginGo");
    ok("⑥ 登入續走接線:只有訪客主鈕(帶 label)才續走;清單收尾給焦點後接一次、只一次;帳號狀態沒讀到先重拉;照 libLoginNext 分流並送 lib_login_go",
      /LIB\.loginGo = go \? id : null; LIB\.loginDirect = go && direct \? direct : null;/.test(si) && /b\.addEventListener\("click", \(\) => libSignIn\(b, !!label, direct\)\);/.test(cutFn(src, "libSignInBtn"))
      && /LIB\.ctaFocus = null; LIB\.loginGo = null; LIB\.loginDirect = null;/.test(fn) && /if \(go\) libLoginGo\(id, direct\);/.test(fn) && fn.indexOf("if (go) libLoginGo(id, direct);") > fn.indexOf("libBag().detail !== id) return;")
      && /LIB\.data\.dataAccess === null \|\| LIB\.data\.why === "unknown"\) \{ try \{ await libLoad\(true\);/.test(lg) && /next = libLoginNext\(c, libPlanMo\(\)\)/.test(lg)
      && /trackEvent\("lib_login_go", \{ next: dir \? "pay_direct" : next \}\)/.test(lg) && /if \(next === "install"\) libSend\(s\);/.test(lg) && !/libAsk\(/.test(lg));
    /* 稽核 T1:登入回來的自動接續絕不自動扣款(Wei 紅線)。libLoginGo 裡每一個呼叫都要在白名單上:讀狀態的、代下載免費／已擁有的 libSend、
       出框的三支(libPlanBuy / libBindBuy 先報價再出框、libBuyBox 只准 "confirm")、開網站綁卡頁的 bindGo("bind_lib")(用戶自己在那頁輸卡,規格 §2.3 允許的那條)、埋點。
       扣款的 libPurchase / libCardGo / libBindBuyGo / libraryPurchase / libraryCardCheckout / libraryBindBuy 一個都不准出現 */
    const ALLOWED = ["libEnv", "libBalLoad", "libLoad", "libFind", "libBag", "libCtaOf", "libLoginNext", "libPlanMo", "libNeeds", "libCtaMain", "libSend", "libPlanBuy", "libBindBuy", "libBuyBox", "bindGo", "window.blave.trackEvent", "$"];
    const body = lg.slice(lg.indexOf("{") + 1), calls = [...body.matchAll(/(?<![\w.])((?:window\.blave\.)?[A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]).filter((n) => !["if", "return", "await", "async", "function", "catch", "try"].includes(n));
    const stray = calls.filter((n) => !ALLOWED.includes(n));
    ok("⑥ 稽核 T1:登入接續(libLoginGo)只呼叫白名單上的函式,沒有任何扣款呼叫;libBuyBox 只開確認框;綁卡頁只走 bindGo(\"bind_lib\")",
      calls.length > 5 && !stray.length && !/libPurchase|libCardGo|libBindBuyGo|libraryPurchase|libraryCardCheckout|libraryBindBuy|confirmTopup/.test(body)
      && (body.match(/libBuyBox\(/g) || []).length === (body.match(/libBuyBox\(s, "confirm", m, \{\}\)/g) || []).length && (body.match(/bindGo\(/g) || []).length === (body.match(/bindGo\("bind_lib"\)/g) || []).length,
      "多出:" + stray.join(",")); }
  const box = cutFn(src, "libPlanBox");
  ok("⑥ 框:框 ③ 最後一行固定自動儲值句、數字讀不到不開框;框 ② 不加;OK 鈕框 ③ 走付款頁(確認合計)、框 ② 走 card_checkout",
    /if \(pay && !tu\) \{[^\n]*planOpen\(\); return; \}/.test(box) && /if \(pay\) extra\.appendChild\(libEl\("p", "", t\("lib\.bb\.topup", tu\)\)\);/.test(box)
    && /onOk: pay \? \(\) => libBindBuyGo\(s, q, LIB\.bbRestart\.has\(s\.id\)\) : \(\) => libCardGo\(s, q\)/.test(box)
    && /acceptPlan: true, confirmTotal: q\.total/.test(cutFn(src, "libBindBuyGo")));
  ok("⑥ 鈕下短句字面(mockup-23-like-others):續扣／試用後續扣／只講可取消,zh 照拍板、en 都有;詳情頁的自動儲值短句已刪;框裡的長版 lib.bb.topup 不動(配 web bc_risk_note)",
    STR.zh["lib.bb.renewNote"] === "之後每 30 天 {p}，可隨時取消。" && STR.zh["lib.bb.trialRenewNote"] === "試用 {t} 天後每 30 天 {p}，可隨時取消。" && STR.zh["lib.bb.cancelNote"] === "可隨時取消。"
    && ["renewNote", "trialRenewNote", "cancelNote"].every((k) => typeof STR.en["lib.bb." + k] === "string" && STR.en["lib.bb." + k].length > 0)
    && !("lib.bb.topupShort" in STR.zh) && !("lib.bb.topupShort" in STR.en) && !/libTopupShort|lib\.bb\.topupShort/.test(src)
    && STR.zh["lib.bb.topup"] === "綁卡後自動儲值是開著的：餘額低於 {lo} TWD 會自動儲值 {a} TWD，可隨時關閉。");
  /* 詳情主鈕實畫(假 DOM):鈕字、鈕與訊息槽之間的每一行(含 noAuto 槽)、按下去走哪支、帶什麼。鈕下最多一行;續扣那幾種不放「買了不會自動下單」、也不放自動儲值;
     付款頁回來(bound)才講自動儲值(設定頁同一句 plan.topupShort) */
  var paintRun = (o) => {
    class E { constructor(tag, cls, text) { this.tag = tag; this.className = cls || ""; this.kids = []; this._t = text == null ? "" : String(text); this.hidden = false; this.id = ""; this.on = {};
        this.classList = { add: (c) => { this.className += " " + c; } }; }
      get textContent() { return this._t + this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }
      set textContent(v) { this._t = String(v); this.kids = []; }
      get childNodes() { return this.kids; }
      appendChild(c) { this.kids.push(c); return c; } append(...cs) { cs.forEach((c) => this.kids.push(c)); } prepend(c) { this.kids.unshift(c); }
      setAttribute(k, v) { this[k] = v; } addEventListener(e, f) { this.on[e] = f; } contains() { return false; } querySelector() { return null; } focus() {} }
    const K = { calls: [], STR, E, O: o, LANG: o.lang || "zh" };
    vm.createContext(K);
    vm.runInContext(src.slice(src.indexOf("/* ── 純邏輯("), src.indexOf("/* ── 純邏輯到此")).replace(/^const /gm, "var ") + `
      var LIB_PLAN_BLOCKS = [], LIB_GATE_STATES = ["noData"], document = { activeElement: null, createElement: (tag) => new E(tag) };
      var t = (k, v) => String(STR[LANG][k] === undefined ? "?" + k : STR[LANG][k]).replace(/\\{(\\w+)\\}/g, (m, n) => (v && v[n] != null ? v[n] : m));
      var box = new E("div"), $ = (id) => (id === "lib-cta" ? box : null), pub = O.pub === undefined ? { trial: { auto_topup_min: 50, auto_topup_amount: 300 } } : O.pub;
      var LIB = { dlFail: null, buyRead: O.buyRead, bbRes: new Map(O.bb ? [[7, O.bb]] : []) }, libPlanMo = () => true, planVars = () => ({ t: 14, pr: 1440 });
      var libCtx = () => O.ctx, libCtaOf = (s) => libCta(s, O.ctx), libLoginUseVars = () => null, libGateBtn = () => new E("button", "btn-fill", "gate");
      var libSignInBtn = (k, c, label, direct) => { const b = new E("button", "btn-fill", label); b.on.click = () => calls.push("signin:" + direct); return b; };
      var libPlanBuy = (s, b, x) => calls.push("plan:" + J(x)), libBindBuy = (s, b, x) => calls.push("bind:" + J(x)), libBuyBox = (s, st) => calls.push("buybox:" + st), libAsk = () => calls.push("ask");
      var J = (x) => (x === undefined ? "-" : JSON.stringify(x));
      ${/const libFx = [^\n]*/.exec(src)[0].replace(/^const/, "var")}
      ${/const libPriceText = [^\n]*/.exec(src)[0].replace(/^const/, "var")}
      ${cutFn(src, "libEl")}
      ${cutFn(src, "libTwd")}
      ${cutFn(src, "libBbText")}
      ${cutFn(src, "libTrialTerms")}
      ${cutFn(src, "libDlKey")}
      ${cutFn(src, "libPaintCta")}`, K);
    K.libPaintCta(Object.assign({ id: 7, title: "x", price: 600, purchased: false, is_owner: false, blave_data: "required" }, o.s));
    const kids = K.box.kids, row = kids.find((k) => k.className === "row"), b = row ? row.kids[0] : null;
    if (b && b.on.click && !o.noClick) b.on.click(b);
    // 鈕下:row 之後、結果框(.err)之前的 p(隱藏的訊息槽不算);付款頁回來那一句另列
    const lines = kids.filter((k) => k !== row && k.tag === "p" && !k.hidden && k.id !== "lib-cta-topup" && !/err/.test(k.className)).map((k) => k.textContent);
    const top = kids.filter((k) => k.id === "lib-cta-topup").map((k) => k.textContent);
    const paidP = kids.find((k) => k.tag === "p" && k.className === "note up" && k.role === "status") || null;
    return { btn: b ? b.textContent : null, lines, top, click: K.calls.join(), errs: kids.filter((k) => /err/.test(k.className)).length,
      dis: b ? !!b.disabled : null, spin: !!(b && b.kids[0] && b.kids[0].className === "spin16"), paid: paidP ? paidP.textContent : null, kept: K.LIB.bbRes.has(7) };
  };
  { const base = { running: false, env: "local", signedIn: true, cloud: null, pending: null, noNew: null, buying: null, installedName: null, bindWait: null, bbOk: null, planMo: true, planTwd: 1440, planBlock: null };
    const plan = (o) => Object.assign({}, base, { dataAccess: "plan_required", why: "no_plan", noCard: true, bal: 0 }, o);
    const trial = (o) => Object.assign({}, base, { dataAccess: "plan_required", why: "no_card", noCard: true, bal: 0 }, o);
    const has = (o) => Object.assign({}, base, { dataAccess: "included", why: null, noCard: true, bal: 0 }, o);
    const r = {
      D: paintRun({ ctx: plan({}) }), B: paintRun({ s: { price: 0 }, ctx: plan({}) }), Dcard: paintRun({ ctx: plan({ noCard: false }) }),
      Dtrial: paintRun({ ctx: trial({}) }), C: paintRun({ s: { blave_data: "none" }, ctx: has({}) }), Ccard: paintRun({ s: { blave_data: "none" }, ctx: has({ noCard: false }) }),
      Cen: paintRun({ lang: "en", s: { blave_data: "none" }, ctx: has({}) }), guestC: paintRun({ s: { blave_data: "none" }, ctx: Object.assign({}, base, { signedIn: false, dataAccess: null, why: null, noCard: null, bal: null }) }),
      guestCen: paintRun({ lang: "en", s: { blave_data: "none" }, ctx: Object.assign({}, base, { signedIn: false, dataAccess: null, why: null, noCard: null, bal: null }) }),
      paidBound: paintRun({ s: { blave_data: "none", purchased: true }, ctx: has({}), bb: { kind: "ok", bound: true } }),
      paidBoundNoPub: paintRun({ s: { blave_data: "none", purchased: true }, ctx: has({}), bb: { kind: "ok", bound: true }, pub: null }),
      paidNotBound: paintRun({ s: { blave_data: "none", purchased: true }, ctx: has({}), bb: { kind: "ok" } }),
      Dfailed: paintRun({ ctx: plan({}), bb: { kind: "failed" } }), DtrialFailed: paintRun({ ctx: trial({}), bb: { kind: "failed" } }) };
    const want = {
      D: { btn: "開通並購買 2,040 TWD", lines: ["之後每 30 天 1,440 TWD，可隨時取消。"], top: [], click: 'plan:{"direct":2040}' },
      B: { btn: "開通 每 30 天 1,440 TWD", lines: ["可隨時取消。"], top: [], click: 'plan:{"direct":1440}' },
      Dcard: { btn: "開通並購買 2,040 TWD", lines: ["之後每 30 天 1,440 TWD，可隨時取消。"], top: [], click: "plan:-" },
      Dtrial: { btn: "購買並使用 600 TWD", lines: ["試用 14 天後每 30 天 1,440 TWD，可隨時取消。"], top: [], click: 'bind:{"direct":600,"trial":{"t":14,"p":1440}}' },
      C: { btn: "購買並使用 600 TWD", lines: [], top: [], click: 'bind:{"direct":600}' },
      Ccard: { btn: "購買並使用 600 TWD", lines: [], top: [], click: "buybox:confirm" },
      Cen: { btn: "Buy & Use · 20 USD", lines: [], top: [], click: "bind:-" },
      guestC: { btn: "登入並購買 600 TWD", lines: [], top: [], click: "signin:600" },
      // 換算幣(en)訪客 C 不帶 direct:登入後照舊出框(同網頁、同已登入那條)
      guestCen: { btn: "Sign In & Buy · 600 TWD", lines: [], top: [], click: "signin:undefined" },
      paidBound: { btn: "安裝並回測", lines: [], top: ["低於 50 TWD 時從卡自動儲值 300 TWD。可在網頁關閉。"], click: "ask" },
      paidBoundNoPub: { btn: "安裝並回測", lines: [], top: [], click: "ask" }, paidNotBound: { btn: "安裝並回測", lines: [], top: [], click: "ask" },
      // 刷卡失敗:只出結果句(同網頁),續扣那一行收起來
      Dfailed: { btn: "開通並購買 2,040 TWD", lines: [], top: [], click: 'plan:{"direct":2040}', errs: 1 },
      DtrialFailed: { btn: "購買並使用 600 TWD", lines: [], top: [], click: 'bind:{"direct":600,"trial":{"t":14,"p":1440}}', errs: 1 } };
    const bad = Object.keys(want).filter((k) => J({ btn: r[k].btn, lines: r[k].lines, top: r[k].top }) !== J({ btn: want[k].btn, lines: want[k].lines, top: want[k].top }) || (want[k].click && r[k].click !== want[k].click)
      || (want[k].errs !== undefined && r[k].errs !== want[k].errs));
    ok("⑥ 詳情主鈕實畫:D／B／有卡 D 鈕下一行續扣、有試用的 D 一行試用後續扣(不放自動儲值);C、訪客 C、en 鈕下空白;刷卡失敗只出結果句;直接付款只在沒卡錢包不夠、鈕上是 TWD;付款頁回來綁了卡才講自動儲值",
      bad.length === 0 && Object.values(r).every((x) => x.lines.length <= 1), bad.map((k) => k + "=" + J(r[k])).join(" ; ")); }
  // 一鍵購買(設計稽核 purchase-box-audit 第 4、7 條):付完那句無記號 note up＋role=status、只此一行;裝好就收掉;讀餘額時主鈕 disabled＋鈕內轉圈、鈕字不換
  { const base = { running: false, env: "local", signedIn: true, cloud: null, pending: null, noNew: null, buying: null, installedName: null, bindWait: null, bbOk: null, planMo: true, planTwd: 1440, planBlock: null, dataAccess: "included", why: null, noCard: false, bal: 1000 };
    const paidBb = { kind: "paid", key: "lib.pb.doneCard", p: 600 };
    const a = paintRun({ s: { blave_data: "none", purchased: true }, ctx: base, bb: paidBb });
    const pend = paintRun({ s: { blave_data: "none", purchased: true }, ctx: Object.assign({}, base, { pending: 7 }), bb: paidBb });
    const inst = paintRun({ s: { blave_data: "none", purchased: true }, ctx: Object.assign({}, base, { installedName: "x" }), bb: paidBb, noClick: true });
    const rd = paintRun({ s: { blave_data: "none" }, ctx: base, buyRead: 7 }), idle = paintRun({ s: { blave_data: "none" }, ctx: base });
    ok("一鍵購買付完那句:鈕下一行「已從卡扣 600 TWD。」(p.note.up、role=status、不是 .err 沒記號);安裝中留著;裝好收掉並清 bbRes",
      a.paid === "已從卡扣 600 TWD。" && a.errs === 0 && J(a.lines) === J(["已從卡扣 600 TWD。"]) && a.kept && pend.paid === "已從卡扣 600 TWD。" && pend.kept
      && inst.paid === null && inst.lines.length === 0 && !inst.kept, J({ a, pend, inst }));
    ok("讀餘額時(LIB.buyRead=這支):付費主鈕 disabled、鈕內第一個是 spin16、鈕字同平常;沒在讀就不停用", rd.dis === true && rd.spin && rd.btn === idle.btn && idle.dis === false && !idle.spin, J({ rd, idle })); }
  var planBuyRun = async () => {
    const run = async (direct, body) => {
      const K = { calls: [], LIB: { buying: null, pending: new Map(), bbRes: new Map(), bbRestart: new Set() }, pub: null };
      vm.createContext(K);
      vm.runInContext(src.slice(src.indexOf("/* ── 純邏輯("), src.indexOf("/* ── 純邏輯到此")).replace(/^const /gm, "var ") + `
        var LIB_PLAN_BLOCKS = ${J(["HAS_SERVER", "PLAN_CHARGE_UNCONFIRMED", "PLAN_NOT_ACTIVE"])}, $ = () => null, libSync = () => {}, libCtaMain = () => null;
        var window = { blave: { libraryCheckoutQuote: async () => ({ status: 200, body: ${J(body)} }) } };
        var libBindBuyGo = (s, q) => calls.push("go:" + q.total), libPlanNext = (s, q) => calls.push("box:" + q.kind);
        async ` + cutFn(src, "libPlanBuy"), K);
      await K.libPlanBuy({ id: 7 }, null, direct ? { direct } : undefined);
      return K.calls.join();
    };
    const pay = { strategy_id: 7, price_twd: 600, plan_required: true, plan_blocked: null, has_card: false, balance: 0, trial_eligible: false, plan_twd: 1440, total_twd: 2040, plan_renews_on: "2026-12-08", plan_source: "none", price_source: "none" };
    const card = Object.assign({}, pay, { has_card: true, card_last4: "4242", plan_source: "card", price_source: "card" });
    const r = [await run(2040, pay), await run(null, pay), await run(1440, pay), await run(2040, card)];
    ok("⑥ A 案:鈕下講過自動儲值且報價合計等於鈕上 → 直接開付款頁、不出框;沒帶 direct(登入接續等)、合計不同 → 框 ③;有卡 → 框 ②",
      J(r) === J(["go:2040", "box:planpay", "box:planpay", "box:cardplan"]), J(r)); };
  ok("⑥ 付款頁回來的結果才標 bound(ok／wallet;刷卡失敗沒有卡)", /if \(out\.kind === "ok" \|\| out\.kind === "wallet"\) out\.bound = true;/.test(cutFn(src, "libBbDone")));
  // 已登入、要資料、有試用資格沒卡(Wei 11-09 推翻「有續扣就出框」):鈕下講了試用天數與每 30 天價,報價開試用且三個數字都相同才不出框 1
  var trialRun = async () => {
    const run = async (o, quote, pv, why) => {
      const K = { calls: [], LIB: { buying: null, bbRestart: new Set() } };
      vm.createContext(K);
      vm.runInContext(src.slice(src.indexOf("/* ── 純邏輯("), src.indexOf("/* ── 純邏輯到此")).replace(/^const /gm, "var ") + `
        var LANG = "zh", libSync = () => {}, libCtaMain = () => null, libPlanMo = () => true, planVars = () => (${J(pv || { t: 14, pr: 1440 })});
        var window = { blave: { libraryBindBuy: async () => ({ status: 409, body: ${J(quote)} }) } };
        var libBindBuyGo = (s, q) => calls.push("go:" + q.kind), libBindBuyBox = (s, q) => calls.push("box:" + q.kind);
        async ` + cutFn(src, "libBindBuy") + "\n" + cutFn(src, "libTrialTerms"), K);
      if (o === "terms") return J(K.libTrialTerms({ why }));
      await K.libBindBuy({ id: 7 }, null, o);
      return K.calls.join();
    };
    const tq = (x) => Object.assign({ error_code: "PRICE_CONFIRM_REQUIRED", price_twd: 600, trial: true, trial_days: 14, plan_monthly_twd: 1440 }, x), tr = { t: 14, p: 1440 };
    const r = {
      ok: await run({ direct: 600, trial: tr }, tq({})), days: await run({ direct: 600, trial: tr }, tq({ trial_days: 7 })), plan: await run({ direct: 600, trial: tr }, tq({ plan_monthly_twd: 1600 })),
      price: await run({ direct: 600, trial: tr }, tq({ price_twd: 700 })), due: await run({ direct: 600, trial: tr }, tq({ plan_due_twd: 1440 })), noTrialO: await run({ direct: 600 }, tq({})),
      plainQ: await run({ direct: 600, trial: tr }, tq({ trial: false })), noO: await run(undefined, tq({})),
      terms: await run("terms", null, null, "no_card"), termsNoPlan: await run("terms", null, null, "no_plan"), termsBad: await run("terms", null, { t: "", pr: 1440 }, "no_card") };
    const want = { ok: "go:trial", days: "box:trial", plan: "box:trial", price: "box:trial", due: "box:trial", noTrialO: "box:trial", plainQ: "box:plain", noO: "box:trial",
      terms: '{"t":14,"p":1440}', termsNoPlan: "null", termsBad: "null" };
    ok("⑥ 有試用的 D:試用天數、每 30 天價、策略價都等於鈕下講的、沒欠費 → 直接開付款頁;任一不同、欠費、鈕下沒講試用、報價不開試用 → 照舊出框;試用條件只認方案制的 no_card、數字讀不到 null",
      J(r) === J(want), J(r)); };
  // 訪客登入接續(Wei 11-09;spec §2.3 第 90 行):金額對得上且不開始任何續扣才不出框。實跑 libLoginGo → libCta → libLoginNext → libBindBuy,報價與四個出口是替身
  var loginGoRun = async () => {
    const run = async (sv, cv, direct, quote) => {
      const K = { calls: [], LIB: { buying: null, pending: new Map(), bbRes: new Map(), bbRestart: new Set(), data: { dataAccess: cv.dataAccess, why: cv.why } } };
      vm.createContext(K);
      vm.runInContext(src.slice(src.indexOf("/* ── 純邏輯("), src.indexOf("/* ── 純邏輯到此")).replace(/^const /gm, "var ") + `
        var LIB_PLAN_BLOCKS = ${J(["HAS_SERVER", "PLAN_CHARGE_UNCONFIRMED", "PLAN_NOT_ACTIVE"])}, LANG = "zh", S0 = ${J(sv)}, C0 = ${J(cv)};
        var $ = () => ({ hidden: false }), libEnv = () => "local", libBalLoad = async () => {}, libLoad = async () => {}, libFind = () => S0, libBag = () => ({ detail: S0.id });
        var libCtaOf = (s) => libCta(s, C0), libPlanMo = () => C0.planMo === true, libCtaMain = () => null, libSync = () => {};
        var window = { blave: { trackEvent: (e, p) => calls.push("ev:" + p.next), libraryBindBuy: async () => ({ status: 409, body: ${J(quote || {})} }) } };
        var libBindBuyGo = (s, q) => calls.push("go:" + q.price), libBindBuyBox = (s, q) => calls.push("box:" + q.kind), libBuyBox = (s, st) => calls.push("buybox:" + st);
        var libPlanBuy = (s, m, o) => calls.push("plan" + (o ? ":direct" : "")), libSend = () => calls.push("send"), bindGo = () => calls.push("bindGo");
        async ` + cutFn(src, "libBindBuy") + "\nasync " + cutFn(src, "libLoginGo"), K);
      await K.libLoginGo(sv.id, direct);
      return K.calls.join();
    };
    const C_ = { id: 7, price: 600, purchased: false, is_owner: false, blave_data: "none" }, D_ = Object.assign({}, C_, { blave_data: "required" });
    const ctx = (o) => Object.assign({ running: false, env: "local", signedIn: true, dataAccess: "plan_required", why: "no_plan", cloud: null, pending: null, noNew: null, buying: null,
      installedName: null, bindWait: null, bbOk: null, noCard: true, bal: 0, planMo: true, planTwd: 1440, planBlock: null }, o);
    const plain = { error_code: "PRICE_CONFIRM_REQUIRED", price_twd: 600, trial: false };
    const r = {
      c: await run(C_, ctx({}), 600, plain),
      cNoDirect: await run(C_, ctx({}), null, plain),
      cRenew: await run(C_, ctx({}), 600, Object.assign({ plan_renews_card: true }, plain)),
      cDue: await run(C_, ctx({}), 600, Object.assign({ plan_due_twd: 1440 }, plain)),
      cRepriced: await run(C_, ctx({}), 600, Object.assign({}, plain, { price_twd: 700 })),
      cCard: await run(C_, ctx({ noCard: false }), 600, plain),
      cWallet: await run(C_, ctx({ bal: 5000 }), 600, plain),
      d: await run(D_, ctx({}), 600, plain),
      dTrial: await run(D_, ctx({ why: "no_card", dataAccess: "plan_required" }), 600, Object.assign({}, plain, { trial: true, trial_days: 14 })) };
    const want = { c: "ev:pay_direct,go:600", cNoDirect: "ev:box,box:plain", cRenew: "ev:pay_direct,box:plain", cDue: "ev:pay_direct,box:plain", cRepriced: "ev:pay_direct,box:plain",
      cCard: "ev:box,buybox:confirm", cWallet: "ev:box,buybox:confirm", d: "ev:box,plan", dTrial: "ev:box,box:trial" };
    ok("⑥ 訪客接續:C 沒卡錢包不夠、金額相同、沒續扣 → 直接開付款頁;沒講過揭露、有方案續期、有欠費、改價 → 框 2;有卡或錢包夠 → 購買確認框;D → 框(不帶 direct);要資料的試用 → 框 1",
      J(r) === J(want), J(r)); };
  const go = cutFn(src, "libCardGo");
  ok("⑥ 框 ② 送出帶框上的合計與來源;扣款在路上框鎖住;重報價不自動重送", /libraryCardCheckout\(s\.id, \{ total: q\.total, planSrc: q\.planSrc, priceSrc: q\.price > 0 \? q\.priceSrc : null \}\)/.test(go)
    && /sc\.dataset\.lock = "1"/.test(go) && /if \(o\.kind === "requote"\) \{ libSync\(\); libPlanBuy\(/.test(go)); }
/* 方案單結果照 api 實際形狀(marketplace.settle_bind_purchase:extra = {strategy_id, amount_twd} + _settle_plan_order 填的欄位;reason 為 None 時不放進去),
   經主行程 libBindResultOut 再給 libBbRes——web 稽核 B1:付款期間方案在別處開了、策略也買到,api 回 status wallet + plan_status active,不能講沒買成 */
{ const api = (status, extra, reason) => ({ bind_purchase: Object.assign({ order_no: "TCC_9_1730000000ab_S7", status, strategy_id: 7, amount_twd: 2040 }, extra, reason ? { reason } : {}) });
  const via = (b) => P.libBbRes(M.libBindResultOut(b), 7);
  const ln2 = (r) => P.libBbLines(r).map((l) => l.key + (l.p ? ":" + l.p : "")).join("|");
  const act = via(api("wallet", { plan: true, plan_twd: 1440, price_twd: 600, plan_status: "active", plan_until: "2026-12-08T02:00:00Z", wallet_twd: 1440 }));
  ok("⑥ B1 方案別處已開、策略買到(status wallet、reason 缺)→ 當成功:不講沒買成、講方案那筆在錢包、埋點 ok_paid", act.kind === "ok" && ln2(act) === "lib.bb.planActive:1440" && P.libBpStep(act, act.free) === "ok_paid", J(act));
  const actFree = via(api("wallet", { amount_twd: 1440, plan: true, plan_twd: 1440, price_twd: 0, plan_status: "active", wallet_twd: 1440 }));
  ok("⑥ B1 免費策略的方案單、方案別處已開 → 成功(ok_free)、講方案那筆在錢包", actFree.kind === "ok" && actFree.free === true && ln2(actFree) === "lib.bb.planActive:1440" && P.libBpStep(actFree, true) === "ok_free", J(actFree));
  const dup = via(api("wallet", { plan: true, plan_twd: 1440, price_twd: 600, plan_status: "ok", wallet_twd: 600 }, "already_purchased"));
  ok("⑥ 方案開了、策略早就買過(already_purchased)→ 成功、講已買過那筆在錢包", dup.kind === "ok" && ln2(dup) === "lib.bb.owned:600", J(dup));
  const part = via(api("wallet", { plan: true, plan_twd: 1440, price_twd: 600, plan_status: "active", wallet_twd: 2040 }, "insufficient"));
  ok("⑥ 方案別處已開、策略真的沒買成(insufficient)→ 才講沒買成、兩筆都在錢包;埋點 part", part.kind === "wallet" && ln2(part) === "lib.bb.planPart:2040" && P.libBpStep(part) === "part", J(part));
  const fail = via(api("wallet", { plan: true, plan_twd: 1440, price_twd: 600, plan_status: "failed", plan_reason: "HAS_SERVER", wallet_twd: 2040 }, "plan_failed"));
  ok("⑥ 方案沒開成(plan_failed、名下有主機)→ wallet、同一槽講總額在錢包＋原因句、原因碼留著", fail.kind === "wallet" && fail.planReason === "HAS_SERVER" && ln2(fail) === "lib.bb.planFail:2040|lib.bb.hasServer", J(fail));
  const unc = via(api("wallet", { plan: true, plan_twd: 1440, price_twd: 600, plan_status: "failed", plan_reason: "PLAN_CHARGE_UNCONFIRMED", wallet_twd: 2040 }, "plan_failed"));
  ok("⑥ 方案沒開成、上一筆扣款還在確認 → 結果句＋「稍後再回來看」那句;一般原因(漲價)只有結果句", ln2(unc) === "lib.bb.planFail:2040|lib.bb.unsettled"
    && ln2(via(api("wallet", { plan: true, plan_twd: 1440, price_twd: 600, plan_status: "failed", plan_reason: "PLAN_CONFIRM_REQUIRED", wallet_twd: 2040 }, "plan_failed"))) === "lib.bb.planFail:2040");
  // 稽核 T2:免費策略的方案單方案沒開成,api 回 ("wallet", None)(marketplace.py:1477 `"plan_failed" if price else None`),reason 不放進結果。不能被 B1 那條判成成功
  const freeFail = via(api("wallet", { amount_twd: 1440, plan: true, plan_twd: 1440, price_twd: 0, plan_status: "failed", plan_reason: "HAS_SERVER", wallet_twd: 1440 }));
  ok("⑥ 稽核 T2:免費策略方案沒開成(status wallet、reason 缺)→ 仍是 wallet、講 1,440 在錢包、埋點 wallet(不是 ok_free)", freeFail.kind === "wallet" && ln2(freeFail) === "lib.bb.planFail:1440|lib.bb.hasServer"
    && P.libBpStep(freeFail, true) === "wallet", J(freeFail));
  const okAll = via(api("ok", { plan: true, plan_twd: 1440, price_twd: 600, plan_status: "ok", wallet_twd: 0 }));
  ok("⑥ 都成(status ok、wallet_twd 0)→ 沒有句子", okAll.kind === "ok" && ln2(okAll) === "", J(okAll)); }
// 主行程:一步開通的兩支端點與付款頁報價、結果的欄位
{ const cb = M.libCheckoutBody({ price_twd: 600, plan_twd: 1440, total_twd: 2040, plan_source: "card", price_source: "evil", card_last4: "42<4", plan_renews_on: "2026-12-08T00:00:00", plan_blocked: "HAS_SERVER", extra: "x", balance: "9" });
  ok("④ checkout 回應:來源只收列舉值、末四碼只收四位數字、日期只取 YYYY-MM-DD、原因碼大寫代號、多的欄位不留", cb.plan_source === "card" && cb.price_source === null && cb.card_last4 === null
    && cb.plan_renews_on === "2026-12-08" && cb.plan_blocked === "HAS_SERVER" && !("extra" in cb) && cb.balance === null && M.libCheckoutBody(null) === null);
  const bb = M.libBindBuyBody({ error_code: "PRICE_CONFIRM_REQUIRED", plan: true, price_twd: 600, plan_twd: 1440, total_twd: 2040, plan_renews_on: "2026-12-08", plan_renews_card: true });
  ok("④ 付款頁報價多留 plan／plan_twd／total_twd／續扣日／plan_renews_card(0.1.49 沒留這格,續期那句其實出不來)", bb.plan === true && bb.total_twd === 2040 && bb.plan_twd === 1440 && bb.plan_renews_on === "2026-12-08" && bb.plan_renews_card === true);
  const rr = M.libBindResultOut({ bind_purchase: { status: "wallet", strategy_id: 7, amount_twd: 2040, plan: true, plan_twd: 1440, price_twd: 600, wallet_twd: 2040, plan_status: "failed", plan_reason: "HAS_SERVER", reason: "plan_failed" } });
  ok("④ 方案單結果多留 plan／wallet_twd／plan_status／plan_reason;一般單不多帶", rr.plan === true && rr.wallet_twd === 2040 && rr.plan_status === "failed" && rr.plan_reason === "HAS_SERVER" && rr.price_twd === 600
    && !("plan" in M.libBindResultOut({ bind_purchase: { status: "ok", strategy_id: 7 } })));
  const lb = cutFn(mainSrc, "libraryBindBuy");
  ok("④ 方案單只送 confirm_total_twd(不送 confirm_price_twd)、記號帶 plan／free;card_checkout 只收自家頁面", /if \(plan\) body\.accept_plan = true;/.test(lb) && /else if \(!plan && Number\.isInteger\(o\.confirm\)/.test(lb)
    && /plan \? \{ id: strategyId, at: Date\.now\(\), plan: true, free: o\.free === true \}/.test(lb) && /return \{ id: m\.id, at: m\.at, plan: m\.plan === true, free: m\.free === true \};/.test(cutFn(mainSrc, "libBbMarkGet"))
    && /\n  handle\("library-card-checkout", \(_e, id, o\) => libraryCardCheckout\(id, o\), \{ status: 0, body: null \}\);/.test(mainSrc));
  // 稽核 T3:報價回餘額與卡末四碼,一樣只收自家頁面;兩支都不是裸的 ipcMain.handle
  ok("④ 稽核 T3:checkout-quote 也走 handle()(fromOurPage);兩支都沒有裸 ipcMain.handle 註冊", /\n  handle\("library-checkout-quote", \(_e, id\) => libraryCheckoutQuote\(id\), \{ status: 0, body: null \}\);/.test(mainSrc)
    && !/ipcMain\.handle\("library-(checkout-quote|card-checkout)"/.test(mainSrc));
  // 稽核 T3:主行程先擋壞參數(api 也擋,這裡是第一道)——跑真的函式,斷言沒打網路
  var t3Main = async () => { const K = { posts: 0, loadToken: () => "tok", loadAppSecret: () => "sec", API_BASE: "https://x", postJSON: async () => { K.posts++; return { status: 200, body: {} }; }, lastAcct: 1, libCache: 1 };
    vm.createContext(K); vm.runInContext("var LIB_PAY_SRC = " + /const LIB_PAY_SRC = (\[[^\]]*\]);/.exec(mainSrc)[1] + ";\nvar libCheckoutBody = () => ({});\n" + "async " + cutFn(mainSrc, "libraryCardCheckout") + "\nasync " + cutFn(mainSrc, "libraryCheckoutQuote"), K);
    const bad = [[0, { total: 2040 }], [-7, { total: 2040 }], [1.5, { total: 2040 }], ["7", { total: 2040 }], [7, { total: 0 }], [7, { total: 20.4 }], [7, null], [7, { total: "2040" }]];
    const rs = await Promise.all(bad.map(([id, o]) => K.libraryCardCheckout(id, o))), qs = await Promise.all([0, -1, "7", 2.5].map((id) => K.libraryCheckoutQuote(id)));
    ok("④ 稽核 T3:libraryCardCheckout 擋非正整數的策略 id 與合計、libraryCheckoutQuote 擋壞 id,都回 400 且沒打網路", rs.every((r) => r.status === 400) && qs.every((r) => r.status === 400) && K.posts === 0, K.posts + " posts"); }; }

// ── ⑤ 輪詢(libBbPoll / libBbDone 切出來,四周全是替身;計時器只記下、手動推)──
(async () => {
  await t3Main();
  await planBuyRun();
  await loginGoRun();
  await trialRun();
  const mk = (replies, s) => {
    const F = { replies, s, timers: [], events: [], acct: 0, refresh: 0, now: 1000, boughtOnLoad: false, sent: [], env: "local", installed: false, cur: "claude", bal: null, pub: { trial: { auto_topup_min: 50 } } };
    vm.createContext(F);
    vm.runInContext(src.slice(src.indexOf("/* ── 純邏輯("), src.indexOf("/* ── 純邏輯到此")).replace(/^const /gm, "var ") + `
      var LIB = { bbWait: null, bbRes: new Map(), bbTop: null, bbTimer: null, bbBusy: false, stale: false, data: null, pending: new Map() }, LIB_BB_POLL_MS = 5000, hasToken = true;
      var libEnv = () => env, libInstalledOf = (x, e) => (e === "local" && installed ? "dir" : null), libSend = (x) => sent.push(x.id);
      var Date = { now: () => now }, setTimeout = (f, ms) => { timers.push(ms); return timers.length; }, clearTimeout = () => {};
      var libFind = (id) => (s && s.id === id ? s : null), libSync = () => {}, libRefresh = () => { refresh++; }, libLoad = async () => { refresh++; if (s && boughtOnLoad) s.purchased = true; }, libBalLoad = async () => {}, libCtaMain = () => null, libFocusFree = () => true, acctSet = () => { acct++; }, acctPaint = () => {};
      var window = { blave: { libraryBindResult: async () => replies.shift(), trackEvent: (e, p) => events.push(e + ":" + p.step), accountStatus: async () => ({}), balance: async () => bal } };
      function libBbTrack(step) { window.blave.trackEvent("lib_bindbuy", { step }); }
      function libBpTrack(step) { if (step) window.blave.trackEvent("lib_bindplan", { step }); }
      ` + cutFn(src, "libBbPollSoon") + "\nasync " + cutFn(src, "libBbPoll") + "\n" + cutFn(src, "libBbDone") + "\nasync " + cutFn(src, "libAutoInstall") + "\n" + cutFn(src, "libAfterPay"), F);
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
    ok("⑤ ok → 標已購買、記綁了卡、送 lib_bindbuy:ok、自動安裝並回測一次(Wei 11-09);重拉期間 bbOk 暫態,帳號與清單都回來才拿掉", s.purchased === true && F.events.join() === "lib_bindbuy:ok" && F.LIB.bbWait === null && F.LIB.bbTop === null && during === 7 && F.LIB.bbOk === null && F.refresh === 1
      && F.LIB.bbRes.get(7).bound === true && J(F.sent) === "[7]", J(F.sent)); }
  { // 自動安裝只在 ok、本機視角、這支本機沒裝過、沒在裝時送;wallet／failed 不送、failed 也不算綁了卡
    const once = async (o, reply) => { const s = { id: 7, purchased: false }, F = mk([{ mark: { id: 7, at: 0 }, res: res(reply || { status: "ok", amount_twd: 1600 }) }], s);
      Object.assign(F, o); if (o.pendingSelf) F.LIB.pending.set(7, { id: 7 }); wait(F, 7, 1e9); await F.libBbPoll(); await new Promise((r) => setImmediate(r));
      return { sent: F.sent.length, bound: F.LIB.bbRes.get(7).bound === true }; };
    const r = { installed: await once({ installed: true }), cloud: await once({ env: "cloud" }), pending: await once({ pendingSelf: true }),
      wallet: await once({}, { reason: "price_changed" }), failed: await once({}, { status: "failed", amount_twd: null }),
      // Blave AI:錢包在門檻以上、試用額度＋離門檻的距離 ≥ 120 → 送;剛開試用但錢包 0(低於門檻)→ 不送;C／D 付完錢包歸零 → 不送;讀不到 → 不送
      blaveTrial: await once({ cur: "blave", bal: { balance: 70, trial: 100, free: null } }), blaveTrialNoWallet: await once({ cur: "blave", bal: { balance: 0, trial: 100, free: null } }),
      blaveEmpty: await once({ cur: "blave", bal: { balance: 0, trial: null, free: null } }), blaveNull: await once({ cur: "blave", bal: null }) };
    ok("⑤ 自動安裝不送:已裝過、雲端視角、正在裝、錢進錢包、刷卡失敗、Blave AI 錢包低於門檻或額度不夠 3 倍估值、讀不到額度;failed 不記綁了卡、wallet 記",
      J(r) === J({ installed: { sent: 0, bound: true }, cloud: { sent: 0, bound: true }, pending: { sent: 0, bound: true }, wallet: { sent: 0, bound: true }, failed: { sent: 0, bound: false },
        blaveTrial: { sent: 1, bound: true }, blaveTrialNoWallet: { sent: 0, bound: true }, blaveEmpty: { sent: 0, bound: true }, blaveNull: { sent: 0, bound: true } }), J(r)); }
  { // 框 ②(有卡或錢包夠)扣款成功也自動安裝並回測一次(Wei 11-09 A),條件同付款頁那條;方案成策略沒成、刷卡被拒、要重報價都不送。實跑 libCardGo,四周替身
    const go = async (reply, o) => { const K = { sent: [], env: "local", installed: false, R: reply, cur: "claude", bal: null, acct: { auto_topup_min: 50 }, pub: null };
      vm.createContext(K);
      vm.runInContext(src.slice(src.indexOf("/* ── 純邏輯("), src.indexOf("/* ── 純邏輯到此")).replace(/^const /gm, "var ") + `
        var LIB_PLAN_BLOCKS = [], LIB = { buying: null, bbRes: new Map(), pending: new Map(), planBlock: null }, t = (k) => k;
        var el = () => ({ dataset: {}, disabled: false, setAttribute() {}, append() {} }), nodes = {}, $ = (id) => (nodes[id] = nodes[id] || el()), libEl = el;
        var confirmBox = () => {}, delClose = () => {}, libSync = () => {}, libCtaMain = () => null, libFocusFree = () => true, libAfterPay = () => {}, libCpTrack = () => {};
        var libBbNote = () => {}, libPlanBuy = () => {}, libPlanNext = () => {}, libBuyBox = () => {};
        var libEnv = () => env, libInstalledOf = (x, e) => (e === "local" && installed ? "dir" : null), libSend = (x) => sent.push(x.id);
        var window = { blave: { libraryCardCheckout: async () => R, balance: async () => bal } };
        async ` + cutFn(src, "libAutoInstall") + "\nasync " + cutFn(src, "libCardGo"), K);
      Object.assign(K, o || {}); if (o && o.pendingSelf) K.LIB.pending.set(7, { id: 7 });
      await K.libCardGo({ id: 7, title: "x", purchased: false }, { kind: "cardplan", price: 600, plan: 1440, total: 2040, planSrc: "card", priceSrc: "card" });
      await new Promise((r) => setImmediate(r));   // 自動安裝在讀餘額之後才送
      return K.sent.length; };
    const okR = { status: 200, body: { status: "ok" } };
    const r = { ok: await go(okR), installed: await go(okR, { installed: true }), cloud: await go(okR, { env: "cloud" }), pending: await go(okR, { pendingSelf: true }),
      part: await go({ status: 200, body: { status: "partial", purchase_reason: "insufficient", amount_twd: 600 } }), declined: await go({ status: 402, body: { error_code: "PLAN_CHARGE_FAILED" } }),
      requote: await go({ status: 409, body: { error_code: "SOURCE_CHANGED" } }),
      // Blave AI 引擎:錢包離門檻 50 的距離 ≥ 3 × 40 才送(170 剛好);差 1 就不送;讀不到餘額不送;自帶 API key 不送
      blaveRich: await go(okR, { cur: "blave", bal: { balance: 170, trial: null, free: null } }), blaveShort: await go(okR, { cur: "blave", bal: { balance: 169, trial: null, free: null } }),
      blaveNull: await go(okR, { cur: "blave", bal: null }), apikey: await go(okR, { cur: "apikey" }), noEngine: await go(okR, { cur: null }) };
    ok("⑤ 框 ② 扣款成功自動安裝一次;已裝、雲端、正在裝、策略沒買成、刷卡被拒、要重報價都不送;Blave AI 只在跑完一回合不碰自動儲值時送,讀不到、自帶 API key、不知道引擎都不送",
      J(r) === J({ ok: 1, installed: 0, cloud: 0, pending: 0, part: 0, declined: 0, requote: 0, blaveRich: 1, blaveShort: 0, blaveNull: 0, apikey: 0, noEngine: 0 }), J(r)); }
  { const f = (e, b, thr) => P.libTurnFree(e, b, thr, 40);
    const r = { claude: f("claude", null, null), codex: f("codex", null, null), apikey: f("apikey", { balance: 9999 }, 50), unknown: f(null, { balance: 9999 }, 50),
      trialNoWallet: f("blave", { balance: 0, trial: 100, free: null }, 50), trial: f("blave", { balance: 50, trial: 120, free: null }, 50), trialShort: f("blave", { balance: 50, trial: 119, free: null }, 50),
      mix: f("blave", { balance: 110, trial: 60, free: null }, 50), mixShort: f("blave", { balance: 109, trial: 60, free: null }, 50),
      // 複稽 2 P1:額度夠一回合但錢包已低於門檻 → 估值超支的最後幾筆落到錢包就刷 300,不送
      free: f("blave", { balance: 0, trial: null, free: 40 }, 50), w49c200: f("blave", { balance: 49, trial: 200, free: null }, 50),
      wallet: f("blave", { balance: 170 }, 50), walletShort: f("blave", { balance: 169.9 }, 50),
      noThr: f("blave", { balance: 9999 }, null), noBal: f("blave", null, 50), badBal: f("blave", { balance: "90" }, 50) };
    ok("⑥ 一回合會不會多扣錢(估 40):自己的 Claude Code／Codex 不經 Blave → 安全;自帶 API key、不知道引擎 → 不安全;Blave AI 錢包低於自動儲值門檻一律不安全,門檻以上時額度＋(錢包−門檻)要 ≥ 3 倍估值;門檻或餘額讀不到 → 不安全",
      J(r) === J({ claude: true, codex: true, apikey: false, unknown: false, trialNoWallet: false, trial: true, trialShort: false, mix: true, mixShort: false, free: false, w49c200: false,
        wallet: true, walletShort: false, noThr: false, noBal: false, badBal: false }), J(r)); }
  ok("⑤ 購買確認框(/purchase)扣款成功改走 libAutoInstall(雲端視角、會多扣錢就停在已購買;複稽 2 P2),不再無條件 libSend;主行程買完清餘額快取",
    /if \(branch === "ok"\) \{ s\.purchased = true;[^\n]*libAutoInstall\(s\);/.test(cutFn(src, "libPurchase")) && !/libSend\(/.test(cutFn(src, "libPurchase"))
    && /libCache = null;[^\n]*\n\s*if \(_balance\) _balance\.reset\(\);/.test(cutFn(mainSrc, "libraryPurchase")));
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
  { // 方案單(0.1.50):B 型都成 → lib_bindplan:ok_free、不標已購買;方案沒開成(名下有主機)→ wallet、主鈕換恢復方案;重開 app 後記號帶 plan,刷卡失敗也記 lib_bindplan
    const s = { id: 7, purchased: false }, F = mk([{ mark: { id: 7, at: 0 }, res: res({ status: "ok", plan: true, plan_status: "ok", price_twd: 0, wallet_twd: 0, amount_twd: 1440 }) }], s);
    F.LIB.bbWait = { id: 7, q: { kind: "planpay", plan: true, free: true, total: 1440 }, until: 1e9 }; await F.libBbPoll();
    ok("⑥ 方案單 B 都成:lib_bindplan:ok_free、免費策略不標已購買、bbOk 暫態蓋資料牆", F.events.join() === "lib_bindplan:ok_free" && s.purchased === false && F.LIB.bbOk === 7, F.events.join());
    const s2 = { id: 7, purchased: true }, G = mk([{ mark: { id: 7, at: 0 }, res: res({ status: "pending", plan: true }) }, { mark: { id: 7, at: 0 }, res: res({ status: "wallet", plan: true, plan_status: "failed", plan_reason: "HAS_SERVER", wallet_twd: 2040, price_twd: 600, amount_twd: 2040, reason: "plan_failed" }) }], s2);
    G.LIB.planBlock = null; G.boughtOnLoad = true; G.LIB.bbWait = { id: 7, q: { kind: "planpay", plan: true, free: false, total: 2040 }, until: 1e9 }; G.LIB.bbWait.check = true; await G.libBbPoll(); await G.libBbPoll();
    ok("⑥ 方案單不因為清單說已買就收尾;方案沒開成 → lib_bindplan:wallet、句子講總額在錢包、名下有主機記成 planBlock", G.events.join() === "lib_bindplan:wallet" && G.LIB.planBlock === "HAS_SERVER"
      && keys(G.LIB.bbRes.get(7)) === "lib.bb.planFail:2040|lib.bb.hasServer", G.events.join() + " " + keys(G.LIB.bbRes.get(7) || null));
    const H = mk([{ mark: { id: 7, at: 0 }, res: res({ status: "failed", amount_twd: null }) }], { id: 7, purchased: false });
    H.LIB.bbWait = { id: 7, q: { kind: "planpay", plan: true, free: false }, until: 1e9 }; await H.libBbPoll();
    ok("⑥ 方案單刷卡失敗(結果不帶 plan,靠等待的那張單認)→ lib_bindplan:failed", H.events.join() === "lib_bindplan:failed", H.events.join()); }
  console.log(red ? `\n${red} 條沒過` : "\n全部通過");
  process.exit(red ? 1 : 0);
})();
