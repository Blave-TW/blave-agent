/* 改價 v3 的電腦版付款框與額度提示(畫面那一半;主行程在 shell/planv3.js)。
   依據:.claude/output/pricing-pro-unlocks-agent-2026-11-16/ 的 CONTRACT.md(「凍結後修正」優先)、SPEC.md,
   mockup .claude/output/designer/conversion-journey-2026-11-16/index.html 第 1–13 步(Wei 11-17 定案),
   free-credit-wall spec 3.1(30 TWD 用完那張卡 C 版)、3.3(快用完提示;「不加鈕」已被 Wei 的 #3 文字鈕取代)。
   - **只在 v3_active 為真時出現**(登入後看 account_status,沒登入看 public_tiers.plan):false 或舊 api 沒有這個鍵 → 這個檔什麼都不做,
     各入口照舊(app.js / trade.js 的掛勾都先問 p3Live())。
   - 金額、天數、額度、門檻全部讀 api(quote、public_tiers、account_status);讀不到的那一句不畫,不寫死。
     唯一寫死的是 30 TWD 快用完的 10 TWD 門檻:api 沒有這個欄位(free-credit-wall spec 3.3)。
   - 動錢的鈕一律是框內一鍵,框就是確認框;送出的金額 = 框上印的那個整數,來源 = 那一格的 source(不是 quote 頂層的 expected_source)。
     409 一律用伺服器現價重開同一個框,頂上一句講為什麼又出現,不自動重送。
   用到 app.js 的 $ / t / LANG / acct / pub / pubLoad / hasToken / cur / RP / confirmBox / delClose / delOkBusy / delCtx / faultCard / sysLz /
   trackFeature / trackEvent / srSay / planDate / planOpen / planSignIn / acctCheck / planPaint / sidePaint / laiOpen / stratSelect /
   planPayUrl / planCryptoUrl / acctUrl / creditCards——都在呼叫時才取。 */
const P3 = { from: "set", addonFrom: "cloud", qAt: 0, qBusy: false, focusBack: null, tipSeq: 0, resume: null, pollT: null, polling: false, okLabel: null, busy: false, q: null, sel: null, wait: null, unlSaid: false, topSeen: undefined, bal: null };
const P3_SAID_KEY = "p3.said";          // 「只講一次」的那幾行:每一格(slot_start)各一次,登入送的 30 一次
const P3_POLL_MS = 5000;                // bind_result 每分鐘 30 次上限,這裡 12 次
const P3_WAIT_MS = 30 * 60 * 1000;      // 付款頁效期(BIND_PLAN_OPEN_TTL);過了還沒結果就收掉那一行

/* ── 純邏輯(tests/check_shell_plan_v3.js 從原文切出來跑;這一段不准碰 DOM)── */
const P3_FREE_LOW_TWD = 10;   // 30 TWD 快用完的門檻(spec 3.3);api 沒有欄位
const P3_HOST = ["linux_starter", "linux_premium", "linux_max", "windows_starter", "windows_premium", "windows_max"];
// 新框出不出:登入了看 account_status(舊 api 沒有 v3_active = 沒開),沒登入看公開價目
function p3On(a, p) { return a ? a.v3_active === true : !!(p && p.plan && p.plan.v3_active === true); }
function p3Num(n) { return Number(n).toLocaleString("en-US"); }
/* Agent 方案框(設計 v3-plan-box-2026-11-19 A 版;mockup 第 13 步)。q = /plan/quote(shell/planv3.js quoteBody),null = 沒登入;pv = public_tiers.plan.v3。
   框上的條件數字(一期幾天、每期 AI 額度、試用天數、試用 AI 額度)先讀報價,報價沒帶才退公開價目 v3;**缺一個就不畫框**(spec §6:同意條件不完整的框不出),回 kind "incomplete"。
   回 { kind: out | trial | bindPay | pay | active | none | incomplete, price, days, aiTrial, aiPeriod, trialDays, verify, firstAt, first, src, last4, wallet, pro } */
function p3AgentModel(q, pv) {
  const ag = (pv && pv.agent) || {}, tr = (pv && pv.trial) || {}, ao = q && q.agent_offer, m = ao && ao.monthly, qt = (q && q.trial) || {};
  const days = (m && m.period_days) || ag.period_days || null, aiPeriod = (m && m.ai_credit_twd) || ag.ai_credit_per_period_twd || null;
  const trialDays = qt.days || tr.days || null, aiTrial = qt.ai_credit_twd || tr.ai_credit_twd || null;
  const base = { days, aiPeriod, aiTrial: null, trialDays, pro: null };
  if (!q) return Object.assign(base, { kind: !ag.monthly_twd ? "none" : days && aiPeriod && trialDays ? "out" : "incomplete", price: ag.monthly_twd || null });
  if (!m) return Object.assign(base, { kind: "none" });
  base.pro = p3ProLine(q.studio);
  if (ao.kind === "active") return Object.assign(base, { kind: "active" });
  const full = !!(days && aiPeriod);
  if (q.trial.eligible && !q.has_card) {
    const ok = full && trialDays && aiTrial && m.first_charge_at && m.today_is === "verify";
    return Object.assign(base, { kind: ok ? "trial" : "incomplete", price: m.first_charge_twd, first: m.first_charge_twd, firstAt: m.first_charge_at, verify: m.today_is === "verify" ? m.today_twd : null, aiTrial });
  }
  if (!full) return Object.assign(base, { kind: "incomplete" });
  /* 這一期不收費(內部帳號:api 算 source free,不看有沒有卡):走一鍵開通、送 free。不能給〔用錢包付〕——api 對內部帳號的錢包付也算 free,
     送 wallet 會一直 409 SOURCE_CHANGED(稽核 B4) */
  if (m.source === "free") return Object.assign(base, { kind: "pay", price: m.today_twd, src: "free", last4: q.card_last4 });
  // 沒卡:主鈕一律綁卡並付;錢包夠一整期才把框腳那顆換成〔用錢包付〕(agent_offer.kind 是 pay 也一樣,Wei 的 mockup 是卡為主)
  if (!q.has_card) return Object.assign(base, { kind: "bindPay", price: m.first_charge_twd, wallet: typeof q.balance_twd === "number" && q.balance_twd >= m.first_charge_twd });
  return Object.assign(base, { kind: "pay", price: m.today_twd, src: m.source === "wallet" || m.source === "free" ? m.source : "card", last4: q.card_last4 });
}
/* 已綁卡那一態主鈕正上方「今天從哪扣」那一句(spec §3):每個 src 各一句,free(內部帳號、這期不收錢)不能落到刷卡那句 */
function p3PaySentence(src, last4) {
  if (src === "free") return ["p3.a.free", null];
  if (src === "wallet") return ["p3.a.todayWallet", null];
  if (last4) return ["p3.a.todayCard", { l: last4 }];
  return ["p3.a.todayCardAny", null];
}
// 加購框「今天從哪扣」:合計列左邊的短句與框腳的整句,每個 src 一組
function p3SrcKeys(src, last4) {
  if (src === "wallet") return ["p3.src.wallet", "p3.srcS.wallet"];
  if (src === "free") return ["p3.src.free", "p3.srcS.free"];
  if (src === "card") return last4 ? ["p3.src.card", "p3.srcS.card"] : ["p3.src.cardAny", "p3.srcS.cardAny"];
  return ["p3.src.none", "p3.srcS.none"];
}
/* 有 Pro 訂閱的人買 888(第 13 步):只提示、附取消去處,不自動停。API 方案不算重複(888 不含 API) */
function p3ProLine(so) {
  if (!so || so.plan !== "pro" || so.source === "none") return null;
  if (so.source === "crypto" || so.auto_renew === false) return so.expires_at ? { key: "p3.pro.paid", at: so.expires_at } : null;
  return { key: "p3.pro.dup", go: { newebpay: "web", apple: "ios", google: "android" }[so.source] || null };
}
/* 加購框(第 8、10 步)。sel = 選中的那一階(null = 預設)。回 null = 這個人不該看到加購框(名下有主機、quote 沒給格子)。
   cap = 這台電腦接了群益(P4,Wei 11-17):群益只跑 Windows,預設選 Windows 基本。
   回 { tier, cycle, avail, cell, kind, route: charge | bind | short, capped, lines: [{ key, vars, twd }], total, src, where, ok } */
function p3AddonModel(q, sel, pv, cap) {
  const ad = q && q.addon_offer;
  if (!ad || !ad.tiers.length) return null;
  const live = q.plan.state === "active" || q.plan.state === "failing";
  const cycle = live && q.plan.cycle === "annual" ? "annual" : "monthly";
  const rows = ad.tiers.filter((r) => r[cycle]), avail = rows.map((r) => r.tier);
  if (!rows.length) return null;
  const want = [sel, q.plan.unlaunched_tier, P3_HOST.includes(q.plan.paid_tier) ? q.plan.paid_tier : null, cap ? "windows_starter" : null, "linux_starter"].find((x) => x && avail.includes(x)) || avail[0];
  const cell = rows.find((r) => r.tier === want)[cycle];
  const addons = (pv && pv.addons) || [], agentP = pv && pv.agent ? pv.agent.monthly_twd : null;
  const addonP = (addons.find((a) => a.tier === want) || {}).addon_monthly_twd || null;
  const paidHost = P3_HOST.includes(q.plan.paid_tier) ? q.plan.paid_tier : null;
  const src = cell.today_kind === "reopen_free" ? "free" : cell.source;
  // 沒卡、錢包不夠這一格:沒方案的人綁卡同時付(6.2);方案有效或試用中的人不能走 6.2,只能先儲值
  const route = src !== "none" ? "charge" : (q.plan.state === "none" || q.plan.state === "lapsed") && !q.trial.active ? "bind" : "short";
  const capped = cell.today_kind !== "reopen_free" && q.paid_launch_left_today === 0;
  /* 一個事實只講一次(設計稽核 M10,改了 Wei 看過的 mockup):合計表那一列已經寫「這期已付過」「與 X 的差額」,框頂不再另寫一句。
     剩下幾天讀不到(null)時用不帶天數的那一句,不印「剩 null 天」 */
  let lines = [];
  const left = q.plan.remaining_days, hasLeft = typeof left === "number";
  if (cell.today_kind === "reopen_free") {
    lines = [{ key: q.trial.active && q.trial.gen !== "v3" ? "p3.s.trialIncl" : "p3.s.paidAlready", vars: { tier: want }, twd: 0 }];
  } else if (cell.today_kind === "prorated") {
    lines = [paidHost ? { key: hasLeft ? "p3.s.diff" : "p3.s.diffRest", vars: { tier: want, paid: paidHost, n: left }, twd: cell.today_twd }
      : { key: !hasLeft ? "p3.s.hostRest" : cycle === "annual" ? "p3.s.hostYear" : "p3.s.hostLeft", vars: { tier: want, n: left }, twd: cell.today_twd }];   // 年繳:加購一次付到這一期年底(canon「付到年底」)
  } else if (agentP && addonP && agentP + addonP === cell.today_twd) {
    lines = [{ key: "p3.s.agent", twd: agentP, plain: true }, { key: "p3.s.host", vars: { tier: want }, twd: addonP, plus: true }];
  } else lines = [{ key: "p3.s.hostPlan", vars: { tier: want }, twd: cell.today_twd }];   // 公開價目讀不到或對不上:不拆兩行,只寫一筆
  const where = [];
  if (ad.kind === "trial_convert") where.push({ key: "p3.h.trialEnd" });
  const pd = pv && pv.agent && pv.agent.period_days;
  if (cell.next_at && cell.next_twd) where.push({ key: cycle === "annual" ? "p3.h.nextY" : pd ? "p3.h.next" : "p3.h.nextNoNum", vars: { at: cell.next_at, p: cell.next_twd, d: pd } });
  const ok = route === "bind" ? { key: "p3.h.okBind", vars: { p: cell.today_twd } } : cell.today_kind === "reopen_free" ? { key: "p3.h.okFree" }
    : cell.today_kind === "prorated" ? { key: "p3.h.okDiff", vars: { p: cell.today_twd } } : { key: "p3.h.okPay", vars: { p: cell.today_twd } };
  return { tier: want, cycle, avail, cell, kind: ad.kind, route, capped, lines, total: cell.today_twd, src: route === "bind" ? "none" : src, last4: q.card_last4,
    where, ok, winNote: want.indexOf("windows") === 0, limit: (pv && pv.daily_paid_launch_limit) || null };
}
// 系統 × 規格兩組分段(第 10 步):六格對 quote 的 addon_offer.tiers;quote 沒給的格停用,不自己猜價
function p3TierOf(os, size) { return os + "_" + size; }
function p3SplitTier(tier) { const i = tier.indexOf("_"); return { os: tier.slice(0, i), size: tier.slice(i + 1) }; }
/* 付款頁回程(第 6 步,另含契約 6.4 的 wallet／unsettled 兩態)。回 { calm, key, vars, retry, refund } 或 null(還在等) */
function p3ResultView(res, kind, verify) {
  if (!res || res.status === "pending") return null;
  if (res.status === "ok") return { calm: true, key: kind === "trial" ? "acct.ready" : "p3.w.okPlan" };
  if (res.status === "failed") return { calm: false, key: kind === "trial" ? "p3.w.failTrial" : "p3.w.failPay", retry: true };
  /* 試用綁卡只刷驗證金:金額用框上印的那筆(記號的 pay),不讀 api 的 amount_twd——舊 api 在這裡放的是到期那一期 888。
     試用綁卡永遠不印付費那句;原因碼缺(舊 api)講卡用過,綁卡前只判人,沒開成幾乎都是卡 */
  if (res.status === "wallet" && kind === "trial") {
    const key = res.reason_code === "TRIAL_NOT_ELIGIBLE" ? "p3.w.trialNoElig" : "p3.w.trialCardUsed";
    return Object.assign({ calm: false, plan: true }, Number.isInteger(verify) && verify > 0 ? { key, vars: { v: verify } } : { key: key + "NoNum" });
  }
  // 金額讀不到就用不帶數字那句(不印「已刷  TWD」;稽核 B5)
  if (res.status === "wallet") return { calm: false, key: typeof res.amount_twd === "number" && res.amount_twd > 0 ? "p3.w.wallet" : "p3.w.walletNoNum", vars: { p: res.amount_twd }, refund: res.refund_review === true };
  return { calm: true, key: "p3.w.unsettled", wait: true };   // unsettled:還在確認,繼續等
}
/* 30 TWD 用完那張卡(C 版,第 4 步;CONTRACT §1)。o = { eligible: 有試用資格又沒卡, hasBt: 有一支有回測的策略, isRunning: 已有策略在跑, need: blave_data_need(null 當要資料) }
   回 { paper, head: paper | trial | plan, main: see | trial | plan, second: trial | plan | local } */
function p3FreeCard(o) {
  const paperOk = o.hasBt && !o.isRunning && (o.eligible || o.need === false);
  if (paperOk) return { paper: true, head: "paper", main: "see", second: o.eligible ? "trial" : "plan" };
  // 有回測的人不出〔改用 Claude Code 或 Codex〕(canon desktop.md 付款框;11-17 晚):他離接模擬只差一步,換引擎不是下一步
  return { paper: false, head: o.eligible ? "trial" : "plan", main: o.eligible ? "trial" : "plan", second: o.hasBt ? null : "local" };
}
/* 回合結束要講的額度那幾行(第 3、9 步)。s = { ai: account_status.ai_credit, free: 登入送的 30 剩多少, topNew: 這一輪真的自動儲值了 {amount}|null,
   said: Set, hasCard, blocked: 這一輪被 402 擋了 }。回 [{ id, keys: [[key, vars]], cta?, local? }],id 記進 said */
function p3TurnLines(s) {
  const out = [], ai = s.ai, said = s.said;
  if (s.blocked) return out;   // 402 那張卡已經講了,不疊
  const top = s.topNew ? ["p3.topped" + (s.last4 ? "" : "NoCard"), { a: s.topNew.amount, l: s.last4 }] : null;
  if (ai && ai.state === "used_up" && !said.has("up:" + ai.slot_start)) {
    // 不寫每期給多少(Wei 11-20:對外不寫 AI 額度的 TWD 數字),只寫哪天重置
    const second = top || (ai.kind === "period" && ai.next_grant_at ? ["p3.up.next", { at: ai.next_grant_at }] : null);
    out.push({ id: "up:" + ai.slot_start, keys: [["p3.up", null]].concat(second ? [second] : []), local: true });
    return out;
  }
  if (top) out.push({ id: null, keys: [top] });
  if (ai && ai.state === "low" && !said.has("low:" + ai.slot_start) && s.low) {
    /* 方案戶另寫下一格哪天發(notifications P2):只寫日期、併進第一句(設計稽核 M5——一段最多兩句、不跟「自動儲值 300」並列第二個 300);試用格沒有下一格 */
    // 門檻照 s.low 判,字不寫數字(Wei 11-20)
    const first = ai.kind === "period" && ai.next_grant_at ? ["p3.lowReset", { at: ai.next_grant_at }] : ["p3.low", null];
    // 自動儲值開著才講門檻與金額:account_status.auto_topup 為 true／false 照它;缺或 null(舊 api、時閘前)退回「有卡就當開著」
    const auto = s.autoTopup === true || s.autoTopup === false ? s.autoTopup : s.hasCard;
    out.push({ id: "low:" + ai.slot_start, keys: [first, auto && s.lo && s.amt ? ["p3.low.then", { lo: s.lo, a: s.amt }] : ["p3.low.thenNoCard", null]] });
  } else if (!ai && typeof s.free === "number" && s.free > 0 && s.free < P3_FREE_LOW_TWD && !said.has("free")) {
    out.push({ id: "free", keys: [["p3.low", null]], cta: true });
  }
  return out;
}
/* 登入者在 v3 下看到的開通價(設定頁、雲端開通頁、方案頁那幾格):q = /plan/quote、pv = public_tiers.plan.v3。
   報價優先(agent_offer 的第一期);報價拿不到才退公開價目 v3;都沒有回 null 的數字 → 畫面不寫價。public_tiers 不分人,試辦期間是舊價,也不讀 data_paths */
function p3Prices(q, pv) {
  const ao = q && q.agent_offer, ag = pv && pv.agent;
  if (ao && ao.monthly) return { monthly: ao.monthly.first_charge_twd || null, annual: (ao.annual && ao.annual.first_charge_twd) || null, verify: ao.monthly.today_is === "verify" ? ao.monthly.today_twd : null };
  if (ag && ag.monthly_twd) return { monthly: ag.monthly_twd, annual: ag.annual_twd || null, verify: (pv.trial && pv.trial.verify_twd) || null };
  return { monthly: null, annual: null, verify: null };
}
/* 埋點值(canon product-telemetry):方案框／加購框按主鈕之後的結果。r = IPC 回應、kind = 框的身分或報價種類 */
function p3BoxStep(r, wallet, src) {
  const st = r ? r.status : 0, c = r && r.body ? r.body.error_code : null;
  if (st === 200 && r.opened) return null;   // 開藍新頁另外記(trial_page／pay_page,看是哪一支)
  if (st === 200) return wallet || src === "wallet" ? "paid_wallet" : "paid_card";
  if (c === "PLAN_CONFIRM_REQUIRED") return "repriced";
  if (c === "SOURCE_CHANGED") return "src_changed";
  if (c === "PLAN_ALREADY_ACTIVE") return "active";
  if (c === "PLAN_BUSY" || c === "PLAN_CHARGE_UNCONFIRMED" || c === "BIND_PLAN_IN_PROGRESS") return "busy";
  if (st === 429) return "rate";
  if (st === 0) return "net";
  return "charge_fail";
}
function p3AddonStep(r, kind) {
  const st = r ? r.status : 0, b = (r && r.body) || {}, c = b.error_code;
  if (st === 200 && r.opened) return "bind_page";
  if (st === 200) return kind === "trial_convert" ? "ok_convert" : ({ full: "ok_full", prorated: "ok_prorated", reopen_free: "ok_free" }[b.kind] || "ok_full");
  if (c === "PLAN_CONFIRM_REQUIRED") return "repriced";
  if (c === "SOURCE_CHANGED") return "src_changed";
  if (c === "DAILY_LAUNCH_LIMIT") return "capped";
  if (c === "LAUNCH_LIMIT_UNAVAILABLE") return "cap_down";
  if (b.charged_twd > 0) return "paid_no_srv";
  if (c === "WALLET_SHORT") return "wallet_short";
  if (st === 0) return "net";
  return "charge_fail";
}
// 回合結束那一行要記的埋點:free_low_shown(30 TWD 快用完)、ai_credit_line(額度快用完／用完／這一輪自動儲值了)
function p3TurnEvents(l, ai) {
  const out = [];
  if (l.id === "free") out.push(["free_low_shown", {}]);
  else if (l.id && l.id.indexOf("low:") === 0) out.push(["ai_credit_line", { kind: ai && ai.kind === "trial" ? "low_trial" : "low_period" }]);
  else if (l.id && l.id.indexOf("up:") === 0) out.push(["ai_credit_line", { kind: "used_up" }]);
  if (l.keys.some(([k]) => k.indexOf("p3.topped") === 0)) out.push(["ai_credit_line", { kind: "topped" }]);
  return out;
}
/* ── 純邏輯到此 ── */

// 這個檔畫的對話行:文字鈕的熱區補到 44(planv3.css .p3-line)
function p3Card() { const c = faultCard(); c.el.classList.add("p3-line"); return c; }
// bindGo 的分流:bind_* 在 v3 開框(雲端那顆開加購框)。回 true = 這裡接手了
function p3Route(name) {
  if (!/^bind_/.test(name) || !p3Live()) return false;
  // plan_box 的 from:哪一道牆(canon product-telemetry);名字之外的入口都算設定頁
  const from = { bind_data: "data", bind_event: "data", bind_side: "side", bind_welcome: "welcome", bind_model: "model", bind_lib: "lib", bind_cloud: "cloud" }[name] || "set";
  if (name === "bind_cloud") p3OpenAddon(null, undefined, undefined, from); else p3OpenAgent(null, null, from);
  return true;
}
/* 這個人的試用是 v3 代:開主機會結束試用、付第一期。改價前開始的試用(v1／v2)照舊含 Linux 基本、開機不收錢(CONTRACT 2.3;稽核 B3)。
   只看 account_status.trial_gen,讀不到不當 v3 */
function p3TrialV3() { return p3Live() && !!acct && acct.trial_gen === "v3"; }
/* 雲端開通卡在 v3 試用中那一句(旁邊是〔開雲端主機〕):開下去會結束試用、今天付第一期。金額與階讀報價(加購框同一個預選);
   報價還沒到、或報價說不是 trial_convert,就只講結束試用、當天付,不寫數字 */
function p3TrialConvertLine() {
  const m = typeof P3 !== "undefined" && P3.q ? p3AddonModel(P3.q, null, p3Pv(), p3Capital()) : null;
  if (m && m.kind === "trial_convert" && m.total > 0) return p3T("p3.f.trialConvert", { tier: m.tier, p: m.total });
  return t("p3.f.trialConvertNoNum");
}
function p3Live() { return typeof acct !== "undefined" && p3On(hasToken ? acct : null, pub); }
function p3Pv() { return pub && pub.plan ? pub.plan.v3 : null; }
const p3El = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const p3Tier = (tier) => t("p3.tier." + tier);
// 字串裡的 {tier} / {paid} 是階的 code、{at} 是 ISO、{p} {n} 等是數字:這裡換成畫面上的字
function p3T(key, vars) {
  const v = Object.assign({}, vars || {});
  ["tier", "paid"].forEach((k) => { if (v[k]) v[k] = p3Tier(v[k]); });
  if (v.at) v.at = p3Md(v.at);   // 日期一律 MM/DD(canon Numbers;設計複稽 N2),zh／en 同一個寫法
  ["p", "n", "a", "lo", "q", "v", "d", "o", "g"].forEach((k) => { if (typeof v[k] === "number") v[k] = p3Num(v[k]); });
  return t(key, v);
}
// 這個檔的日期寫 MM/DD(canon Numbers):時間軸那一格走 mono 才對得齊(設計複稽 R6)、句子裡也同一個寫法(N2);不動共用的 planDate
function p3Md(iso) { const d = new Date(iso); return isNaN(d) ? "" : String(d.getMonth() + 1).padStart(2, "0") + "/" + String(d.getDate()).padStart(2, "0"); }
function p3SaidGet() { try { const a = JSON.parse(localStorage.getItem(P3_SAID_KEY) || "[]"); return new Set(Array.isArray(a) ? a : []); } catch (_) { return new Set(); } }
function p3SaidAdd(id) { const s = [...p3SaidGet(), id].slice(-30); try { localStorage.setItem(P3_SAID_KEY, JSON.stringify(s)); } catch (_) { } }
function p3BalSet(r) { P3.bal = r || null; if (r && P3.topSeen === undefined) P3.topSeen = r.topup ? r.topup.at : null; }

// 框內錯誤句(紅記號;calm = 灰):放在 body 最後,讀屏念一次
function p3BoxMsg(key, vars, calm) {
  const body = $("del-body"); if (!body) return;
  body.querySelectorAll(".p3-msg").forEach((x) => x.remove());
  const e = p3El("p", "plan-err p3-msg" + (calm ? " is-calm" : "")), m = p3El("span", "fault-mark");
  m.setAttribute("aria-hidden", "true"); e.append(m, p3El("span", "", p3T(key, vars)));
  body.appendChild(e); srSay(p3T(key, vars));   // 讀屏只念這一次(不另掛 role="status",同 faultCard)
}
/* 付款中:框不關、取消與 ✕ 停用、Esc／框外無效(同 library.js libBuyOneGo);**框身整塊 inert**(設計稽核 M1):付款中切規格會換掉主鈕的
   onOk 與合計,請求送的卻是切之前那一階;框內的文字鈕(用錢包付、用加密貨幣轉帳)也一起停。各個 click 另外看 P3.busy 再擋一次 */
function p3Lock(on, label) {
  const sc = $("del-scrim"), body = $("del-body");
  /* 框身變 inert、框腳〔用錢包付〕停用前,焦點在它們上面:先移到主鈕(aria-disabled、仍可聚焦),解鎖後還給原本那顆;
     不然焦點掉到 BODY、跑出 dialog,錯誤句回來也找不到(設計複稽 R2) */
  if (on) { const a = document.activeElement; P3.focusBack = a && a !== $("del-ok") && (body.contains(a) || a === $("del-link")) ? a : null; if (P3.focusBack) $("del-ok").focus(); }
  body.inert = on;
  // 送出中主鈕換字;回來之後換回原字(框沒關、帶著錯誤句時,鈕還是「付 N TWD」,不能留著「付款中…」)
  if (on) { sc.dataset.lock = "1"; P3.okLabel = $("del-ok").textContent; $("del-ok").textContent = label; delOkBusy(true); }
  else { delete sc.dataset.lock; if (P3.okLabel !== null) $("del-ok").textContent = P3.okLabel; P3.okLabel = null; delOkBusy(false); }
  $("del-cancel").disabled = on; $("del-close").disabled = on; $("del-link").disabled = on;   // 框腳的〔用錢包付〕〔用加密貨幣轉帳〕不在框身裡,inert 管不到
  // 焦點最後還:要等框腳那顆解除停用才聚焦得到
  if (!on) { const b = P3.focusBack; P3.focusBack = null; if (b && b.isConnected && !b.disabled) b.focus(); else if (!document.activeElement || document.activeElement === document.body) $("del-ok").focus(); }
}
function p3Price(p, days) {
  const d = p3El("div", "p3-price"); d.append(p3El("span", "big num", p3Num(p)), p3El("span", "u", p3T(days ? "p3.a.unit" : "p3.a.unitNoNum", { d: days }))); return d;
}
/* 「AI 超額時自動儲值。」那一句(凡會綁卡的框講一次)。門檻放泡泡:用外殼的 tooltip 配方(.mp-tip 觸發鈕＋相鄰 .tip,hover 與鍵盤 focus 都出、
   Esc 收,app.js tipEsc)。觸發點自己不能叫 .tip——那是泡泡本體,預設 display:none(設計稽核 M2:整句在每個框都看不見)。數字讀不到就只有那句、沒有泡泡 */
// lead = 同一句前面先講的事(試用框的「今天刷 10 TWD 驗證，存進錢包。」),兩句併在同一段(spec A §5-3)
function p3TopupLine(lead) {
  const ac = (p3Pv() || {}).ai_credit || {}, p = p3El("p", "p3-t");
  if (lead) p.append(lead + (LANG === "zh" ? "" : " "));
  if (!(ac.auto_topup_min && ac.auto_topup_amount)) { p.append(t("p3.topup")); return p; }
  const w = p3El("span", "p3-tipw"), b = p3El("button", "mp-tip", t("p3.topup")), tip = p3El("span", "tip", p3T("p3.topupTip", { lo: ac.auto_topup_min, a: ac.auto_topup_amount }));
  b.type = "button"; tip.id = "p3-tip-" + (++P3.tipSeq); tip.setAttribute("role", "tooltip"); b.setAttribute("aria-describedby", tip.id);
  w.append(b, tip); p.appendChild(w); return p;
}

/* ── Agent 方案框(資料牆、30 TWD 卡、側欄膠囊、歡迎頁、設定 › 帳號與方案)── */
// v3 沒開(404)時退回各入口原本那條:外開網站綁卡頁(bindGo 的舊行為)
function p3Legacy() { window.blave.openExternal(acctUrl()); }
// from = 哪一道牆開的(plan_box 埋點);409 重問重開(note 有值)不算一次開框
async function p3OpenAgent(opener, note, from) {
  if (P3.busy) return;
  if (!note) { P3.resume = p3ResumeToken(); P3.from = from || "set"; }   // 重問(409)那次不換:還是同一個被切斷的回合
  if (!hasToken) {
    if (!pub) await pubLoad();
    const m0 = p3AgentModel(null, p3Pv());
    if (m0.kind === "out") { p3AgentBox(m0, opener, note); if (!note) trackEvent("plan_box", { from: P3.from }); } else confirmBox({ title: t("p3.a.title"), lines: [t("p3.err.quote")], ok: t("cdel.gotIt"), single: true, opener, onOk: () => {} });
    return;
  }
  P3.busy = true;
  let r = null; try { r = await window.blave.plan3Quote(); } catch (_) { r = null; }
  try { if (!pub) await pubLoad(); } catch (_) { }
  if (r && r.status === 404) { P3.busy = false; p3Legacy(); return; }
  if (!r || r.status !== 200 || !r.body) { P3.busy = false; confirmBox({ title: t("p3.a.title"), lines: [t(r && r.status === 429 ? "plan.err.rate" : "p3.err.quote")], ok: t("cdel.gotIt"), single: true, opener, onOk: () => {} }); return; }
  P3.q = r.body;
  let m = p3AgentModel(r.body, p3Pv());
  // 條件數字缺一個(一期幾天、AI 額度、試用天數):公開價目一小時快取可能是舊的,先重讀一次再判(重讀期間 busy 照留,再點不會開第二個框)
  if (m.kind === "incomplete") { pubAt = 0; try { await pubLoad(); } catch (_) { } m = p3AgentModel(r.body, p3Pv()); }
  P3.busy = false;
  if (m.kind === "active") { planOpen(); return; }   // 已有方案或試用:看方案頁,不再賣一次
  if (m.kind === "none") { p3Legacy(); return; }
  // 還是缺:不畫少了條件的框,講讀不到價格(spec §6)
  if (m.kind === "incomplete") { confirmBox({ title: t("p3.a.title"), lines: [t("p3.err.quote")], ok: t("cdel.gotIt"), single: true, opener, onOk: () => {} }); return; }
  p3AgentBox(m, opener, note);
  if (!note) trackEvent("plan_box", { from: P3.from });
}
/* 框身三塊(spec A):頭(大字＋單位＋一行續扣條件)→ 三個勾 → 主鈕正上方那一句(今天這張卡會發生什麼＋自動儲值);
   第二條路放框腳左邊的 del-link(加密轉帳,或錢包夠一期的〔用錢包付〕)。框身裡沒有鈕 */
function p3AgentBox(m, opener, note) {
  if (P3.busy) return;   // 付款中不重畫框(重畫會換掉 onOk)
  const x = document.createDocumentFragment(), d = m.days;
  if (note) x.appendChild(p3El("p", "p3-t p3-ink", t(note)));
  const head = p3El("div", "p3-head");
  if (m.kind === "trial") {
    const pr = p3El("div", "p3-price"); pr.append(p3El("span", "big num", p3Num(m.trialDays)), p3El("span", "u", t("p3.a.trialUnit"))); head.appendChild(pr);
    head.appendChild(p3El("p", "p3-sub", p3T("p3.a.trialSub", { at: m.firstAt, d, p: m.first })));
  } else {
    head.appendChild(p3Price(m.price, d));
    head.appendChild(p3El("p", "p3-sub", m.kind === "out" ? p3T("p3.a.out", { t: m.trialDays }) : t("p3.a.renewShort")));
  }
  x.appendChild(head);
  const ul = p3El("ul", "p3-ticks"), ai = p3El("li", "", t("p3.tick.ai"));
  ai.appendChild(p3El("span", "", t(m.kind === "trial" ? "p3.tick.aiTrial" : "p3.tick.aiPeriod")));   // 不寫額度的 TWD 數字(Wei 11-20)
  ul.append(p3El("li", "", t("p3.tick.data")), ai, p3El("li", "", t("p3.tick.pro")));
  x.appendChild(ul);
  if (m.kind === "out") {
    const go = () => { delClose(false); planSignIn(null).then((res) => { if (res && res.ok) p3OpenAgent(opener, null, P3.from); }); };
    confirmBox({ title: t("p3.a.title"), lines: [], extra: x, ok: t("pv.signin"), opener, onOk: go });
    return;
  }
  // 主鈕正上方那一句
  let ok;
  if (m.kind === "trial") {
    x.appendChild(p3El("p", "p3-t", t("p3.a.oncePerCard")));
    x.appendChild(p3TopupLine(p3T("p3.a.verifyLine", { v: m.verify })));
    ok = t("p3.a.okTrialNoNum");   // 頭已經寫了幾天(copy #1:同一事實只講一次)
  } else if (m.kind === "bindPay") {
    x.appendChild(p3TopupLine());
    ok = p3T("p3.a.okBindPay", { p: m.price });
  } else {
    const ps = p3PaySentence(m.src, m.last4);
    x.appendChild(p3El("p", "p3-t", p3T(ps[0], ps[1])));
    ok = m.src === "free" || !m.price ? t("plan.startM") : p3T("p3.a.okPay", { p: m.price });   // 這期不收費:不寫「付 0 TWD」
  }
  if (m.pro) x.appendChild(p3El("p", "p3-t p3-ink p3-pro", m.pro.key === "p3.pro.paid" ? p3T("p3.pro.paid", { at: m.pro.at }) : t("p3.pro.dup")));
  // 框腳左邊:錢包夠一整期的〔用錢包付〕(要留在框裡鎖住扣款:stay),否則〔用加密貨幣轉帳〕(外開網站,先關框)
  const link = m.kind === "bindPay" && m.wallet
    ? { label: p3T("p3.a.walletPay", { p: m.price }), stay: true, onClick: () => { if (!P3.busy) p3AgentGo(m, opener, true); } }
    : { label: t("p3.crypto"), onClick: () => { if (!P3.busy) window.blave.openExternal(planCryptoUrl({ agent: true, cycle: "monthly" })); } };   // 這個框的單一律月繳(p3AgentGo)
  confirmBox({ title: t("p3.a.title"), lines: [], extra: x, ok, opener, stay: true, link, onOk: () => p3AgentGo(m, opener, false) });
}
function p3ProCancel(go) {
  const u = { web: "https://blave.org/landing/" + LANG + "/setting?tab=billing&from=desktop", ios: "https://apps.apple.com/account/subscriptions", android: "https://play.google.com/store/account/subscriptions" }[go];
  if (u) window.blave.openExternal(u);
}
async function p3AgentGo(m, opener, wallet) {
  if (P3.busy) return;
  P3.busy = true;
  p3Lock(true, t("p3.paying"));
  let r = null;
  try {
    if (m.kind === "trial") r = await window.blave.plan3BindTrial({ cycle: "monthly", confirm: m.first, pay: m.verify, lang: LANG });
    else if (m.kind === "bindPay" && !wallet) r = await window.blave.plan3BindPay({ tier: "agent", cycle: "monthly", confirm: m.price, lang: LANG });
    else r = await window.blave.plan3AgentStart({ cycle: "monthly", confirm: m.price, source: wallet ? "wallet" : m.src, wallet });
  } catch (_) { r = null; }
  p3Lock(false); P3.busy = false;
  const b = (r && r.body) || {}, c = b.error_code;
  const job = p3AgentJob(m);
  { const step = r && r.status === 200 && r.opened ? (m.kind === "trial" ? "trial_page" : "pay_page") : p3BoxStep(r, wallet, m.src); if (step) trackEvent("plan_box_res", { step }); }
  if (r && r.status === 200 && r.opened) { delClose(false); p3WaitStart(job); return; }
  if (r && r.status === 200) {
    delClose(false); trackFeature("plan_monthly");
    p3Done(p3Card(), "p3.w.okPlan", m.pro);
    if (typeof balLoad === "function") balLoad();
    p3Resume();
    return;
  }
  p3After(r, c, () => p3OpenAgent(opener, c === "SOURCE_CHANGED" ? "p3.resourced" : "p3.repriced"), () => p3OpenAgent(opener, null, P3.from), () => p3RestartAsk(job, opener));
}
// 一張藍新單要記的事:哪一種、哪一階、確認的金額(confirm)、藍新頁上的金額(pay;試用是驗證金)、Pro 那句
function p3AgentJob(m) { return m.kind === "trial" ? { kind: "trial", tier: "agent", cycle: "monthly", confirm: m.first, pay: m.verify, pro: m.pro } : { kind: "plan", tier: "agent", cycle: "monthly", confirm: m.price, pay: m.price, pro: m.pro }; }
function p3JobBox(job, opener, note) { if (job.tier && job.tier !== "agent") p3OpenAddon(opener, job.tier, note); else p3OpenAgent(opener, note); }
/* 上一張付款頁還開著(409 BIND_PLAN_IN_PROGRESS,或等待那一行的〔重新打開付款頁〕):一個框講「舊頁仍能付、兩頁都付多的進錢包」(同策略庫 lib.bb.open),
   主鈕帶金額、按了就作廢舊頁開新單(restart)。設計稽核 M3:等待那一行直接到這個框,不再先重開整個方案框 */
function p3RestartAsk(job, opener) {
  if (P3.busy) return;
  const title = job.tier && job.tier !== "agent" ? t("p3.h.title") : t("p3.a.title");
  confirmBox({ title, lines: [t("p3.w.openNote")], ok: job.pay ? p3T("p3.w.reopenOk", { p: job.pay }) : t("p3.w.reopenOkNoNum"), opener, stay: true, onOk: async () => {
    if (P3.busy) return;
    P3.busy = true; p3Lock(true, t("p3.paying"));
    let r = null;
    try { r = job.kind === "trial" ? await window.blave.plan3BindTrial({ cycle: job.cycle, confirm: job.confirm, pay: job.pay, lang: LANG, restart: true })
      : await window.blave.plan3BindPay({ tier: job.tier, cycle: job.cycle, confirm: job.confirm, lang: LANG, restart: true }); } catch (_) { r = null; }
    p3Lock(false); P3.busy = false;
    if (job.tier === "agent") { const step = r && r.status === 200 && r.opened ? (job.kind === "trial" ? "trial_page" : "pay_page") : p3BoxStep(r, false, null); if (step) trackEvent("plan_box_res", { step }); }
    else trackEvent("addon_res", { step: p3AddonStep(r, null) });
    if (r && r.status === 200 && r.opened) { delClose(false); p3WaitStart(job); return; }
    p3After(r, r && r.body && r.body.error_code, () => p3JobBox(job, opener, "p3.repriced"), () => p3JobBox(job, opener), null);
  } });
}
/* 送出後的錯誤分流(三個框共用)。reprice = 用伺服器現價重開框(帶頂上那句);reopen = 狀態變了、照新身分重開;restart = 上一張付款頁還開著 */
function p3After(r, c, reprice, reopen, restart) {
  const st = r ? r.status : 0, b = (r && r.body) || {};
  if (c === "PLAN_CONFIRM_REQUIRED" || c === "SOURCE_CHANGED") { reprice(); return; }
  if (c === "BIND_PLAN_IN_PROGRESS" && restart) { restart(true); return; }
  if (["CARD_ALREADY_BOUND", "NOT_ELIGIBLE", "USE_TRIAL", "NO_CARD", "HAS_SERVER", "TRIAL_TIER_LOCKED"].includes(c)) { acctCheck(); reopen(); return; }
  if (c === "PLAN_ALREADY_ACTIVE") { delClose(false); acctCheck(); const k = p3Card(); k.set(sysLz(() => ({ calm: true, text: t("p3.err.active") }))); return; }
  if (c === "DAILY_LAUNCH_LIMIT") { if (P3.q) P3.q.paid_launch_left_today = 0; reopen(true); return; }
  // 扣了錢、主機沒開成(契約 6.3「扣了錢、建機失敗」):不能講成付款失敗;這期重開同階不收錢
  if (b.charged_twd > 0) { delClose(false); acctCheck(); p3Unlaunched(null, b.charged_twd); return; }
  const key = c === "WALLET_SHORT" ? "p3.err.walletShort" : c === "PLAN_CHARGE_FAILED" ? "p3.err.charge" : c === "PLAN_BUSY" || c === "PLAN_CHARGE_UNCONFIRMED" ? "p3.err.busy"
    : c === "LAUNCH_LIMIT_UNAVAILABLE" ? "p3.err.capDown" : st === 429 ? "plan.err.rate" : st === 0 ? "p3.err.net" : st === 401 ? "plan.err.relogin" : "p3.err.server";
  p3BoxMsg(key, null, key === "p3.err.busy" || key === "p3.err.net");
  if (st === 0) acctCheck();   // 沒收到結果不代表沒扣:以伺服器現況為準
}

/* ── 加購框(雲端視角的開通頁、設定 › 帳號與方案的〔開雲端主機〕、還沒開機的提示)── */
async function p3OpenAddon(opener, pre, note, from) {
  if (P3.busy) return;
  if (!note) P3.addonFrom = from || "cloud";
  if (!hasToken) { planSignIn(null).then((res) => { if (res && res.ok) p3OpenAddon(opener, pre, note, from); }); return; }
  P3.busy = true;
  let r = null; try { r = await window.blave.plan3Quote(); } catch (_) { r = null; }
  P3.busy = false;
  if (!pub) await pubLoad();
  if (r && r.status === 404) { window.blave.openExternal("https://blave.org/agent/" + LANG + "?from=desktop"); return; }   // 舊行為:到網站開(cloudWebGo)
  if (!r || r.status !== 200 || !r.body) { confirmBox({ title: t("p3.h.title"), lines: [t(r && r.status === 429 ? "plan.err.rate" : "p3.err.quote")], ok: t("cdel.gotIt"), single: true, opener, onOk: () => {} }); return; }
  P3.q = r.body; if (pre !== undefined) P3.sel = pre || null;
  if (!p3AddonModel(r.body, P3.sel, p3Pv(), p3Capital())) { acctCheck(); const k = p3Card(); k.set(sysLz(() => ({ calm: true, text: t("p3.err.hasServer") }))); return; }
  p3AddonBox(opener, note);
  if (!note) {
    trackEvent("plan_box", { from: P3.addonFrom });
    const m = p3AddonModel(r.body, P3.sel, p3Pv(), p3Capital());
    if (m && m.capped) trackEvent("addon_res", { step: "capped" }); else if (m && m.route === "short") trackEvent("addon_res", { step: "wallet_short" });
  }
}
// focusAt = { g: 第幾組分段, i: 第幾顆 }:點分段重畫整個框之後焦點回到那一顆(系統與規格兩組會帶同一個 data-t,不能用它找)
function p3AddonBox(opener, note, focusAt) {
  if (P3.busy) return;   // 付款中不重畫(設計稽核 M1)
  const m = p3AddonModel(P3.q, P3.sel, p3Pv(), p3Capital()); if (!m) return;
  const x = document.createDocumentFragment(), pv = p3Pv() || {}, cur3 = p3SplitTier(m.tier);
  if (note) x.appendChild(p3El("p", "p3-t p3-ink", t(note)));
  const hw = p3El("div", "p3-hw"); hw.setAttribute("role", "group"); hw.setAttribute("aria-label", t("p3.h.spec"));
  let segN = 0;
  const seg = (label, opts) => {
    const r = p3El("div", "p3-hw-r"), s = p3El("div", "set-seg p3-seg"), g = segN++; s.setAttribute("role", "group"); s.setAttribute("aria-label", label);
    opts.forEach(([tier, txt, tip], i) => {
      const b = p3El("button", "", txt); b.type = "button"; b.dataset.t = tier;
      const on = tier === m.tier || (opts === osOpts ? p3SplitTier(tier).os === cur3.os : p3SplitTier(tier).size === cur3.size);
      b.setAttribute("aria-pressed", String(on)); if (tip) b.title = tip;
      b.disabled = !m.avail.includes(tier);
      b.addEventListener("click", () => { if (P3.busy) return; if (tier !== m.tier) trackEvent("addon_pick", { tier }); P3.sel = tier; p3AddonBox(opener, note, { g, i }); });
      s.appendChild(b);
    });
    r.append(p3El("span", "l", label), s); hw.appendChild(r);
  };
  // 系統那組:切系統時規格照留;那一格 quote 沒給就退到該系統第一個有的
  const osPick = (os) => { const want = p3TierOf(os, cur3.size); return m.avail.includes(want) ? want : m.avail.find((x2) => x2.indexOf(os + "_") === 0) || want; };
  const osOpts = [[osPick("linux"), "Linux"], [osPick("windows"), "Windows", t("p3.h.winTip")]];
  seg(t("p3.h.os"), osOpts);
  seg(t("p3.h.size"), ["starter", "premium", "max"].map((z) => [p3TierOf(cur3.os, z), t("p3.h." + z)]));
  const spec = (pv.addons || []).find((a) => a.tier === m.tier) || ((pub && pub.tiers) || []).map((a) => ({ tier: a.tier, vcpu: a.vcpu, ram_gb: a.ram_gb })).find((a) => a.tier === m.tier);
  const sl = p3El("p", "p3-hw-spec", spec && spec.vcpu && spec.ram_gb ? p3T("p3.h.specV", { c: spec.vcpu, r: spec.ram_gb }) : "");
  if (m.winNote) sl.append((sl.textContent ? (LANG === "zh" ? "。" : ". ") : ""), t("p3.h.winNote"));
  hw.appendChild(sl); x.appendChild(hw);
  if (m.route === "bind") x.appendChild(p3TopupLine());
  /* 合計表(框身最後一塊)。兩列以上:明細＋合計列(合計列左邊寫今天從哪扣)。只有一列(補差額、重開同階、年繳)時明細跟合計是同一個數:
     不畫明細列,合計列左邊寫那一列的說明,今天從哪扣改成框腳的第一句(設計稽核 M10) */
  const dl = p3El("dl", "cf-rows p3-sum"), one = m.lines.length === 1, sk = p3SrcKeys(m.src, m.last4);
  if (!one) m.lines.forEach((l) => { const r = p3El("div", "cf-row"); r.append(p3El("dt", "", p3T(l.key, l.vars)), p3El("dd", "", (l.plus ? "＋" : "") + p3Num(l.twd))); dl.appendChild(r); });
  const tot = p3El("div", "cf-row total" + (one ? " solo" : ""));   // 只有一列:上緣那條線沒有隔開任何東西,不畫(設計複稽 R7)
  tot.append(p3El("dt", "", one ? p3T(m.lines[0].key, m.lines[0].vars) : p3T(sk[0], { l: m.last4 })), p3El("dd", "", p3T("p3.s.tot", { p: m.total })));
  dl.appendChild(tot); x.appendChild(dl);
  const why = m.capped ? p3T(m.limit ? "p3.h.cap" : "p3.h.capNoNum", { n: m.limit }) : m.route === "short" ? t("p3.err.walletShort") : "";
  const parts = (one && m.total > 0 ? [p3T(sk[1], { l: m.last4 })] : []).concat(m.where.map((w) => p3T(w.key, w.vars)));
  const where = why || parts.join(LANG === "zh" ? "" : " ");
  confirmBox({ title: t("p3.h.title"), lines: [], extra: x, ok: p3T(m.ok.key, m.ok.vars), opener, stay: true, footWhere: where, okDisabled: !!why,
    onOk: () => p3AddonGo(m, opener) });
  const grp = focusAt ? document.querySelectorAll("#del-body .p3-seg")[focusAt.g] : null, back = grp ? grp.children[focusAt.i] : null;
  if (back && !back.disabled) back.focus();
  if (why) $("del-ok").setAttribute("aria-describedby", "del-where");
}
async function p3AddonGo(m, opener) {
  if (P3.busy || m.capped || m.route === "short") return;
  P3.busy = true;
  p3Lock(true, t("p3.paying"));
  let r = null;
  try {
    r = m.route === "bind" ? await window.blave.plan3BindPay({ tier: m.tier, cycle: m.cycle, confirm: m.total, lang: LANG })
      : await window.blave.plan3Addon({ tier: m.tier, cycle: m.cycle, confirm: m.total, source: m.src });
  } catch (_) { r = null; }
  p3Lock(false); P3.busy = false;
  const b = (r && r.body) || {}, c = b.error_code;
  const job = { kind: "plan", tier: m.tier, cycle: m.cycle, confirm: m.total, pay: m.total, pro: null };
  trackEvent("addon_res", { step: p3AddonStep(r, m.kind) });
  if (r && r.status === 200 && r.opened) { delClose(false); p3WaitStart(job); return; }
  if (r && r.status === 200) { delClose(false); p3Started(b.state); return; }
  const restart = m.route === "bind" ? () => p3RestartAsk(job, opener) : null;
  p3After(r, c, () => p3OpenAddon(opener, m.tier, c === "SOURCE_CHANGED" ? "p3.resourced" : "p3.repriced"), (keep) => (keep ? p3AddonBox(opener) : p3OpenAddon(opener, m.tier)), restart);
}
// 開機送出成功:照方案頁「啟動中」那條走(planWatch 每 20 秒重查,看到 running 講「雲端主機開好了」)
function p3Started(state) {
  if (typeof acct !== "undefined" && acct) acct = { ...acct, plan: { ...(acct.plan || {}), state: state || "starting", unlaunched_tier: null } };
  const card = p3Card(); card.set(sysLz(() => ({ calm: true, text: t("env.empty.starting") })));
  planPaint(); sidePaint(); acctCheck(); if (typeof balLoad === "function") balLoad();
}
/* 付好了那一行(第 6 步「付好了」;P6:有 Pro 訂閱的人,取消 Pro 的去處放在這一句,不放在付款框裡) */
function p3Done(card, key, pro) {
  const go = pro && pro.go;
  card.set(sysLz(() => ({ calm: true, text: t(key) + (pro && pro.key === "p3.pro.dup" ? (LANG === "zh" ? "" : " ") + t("p3.pro.dupAfter") : ""),
    ...(go ? { label: t("p3.pro." + go), quiet: true, on: () => p3ProCancel(go) } : {}) })));
  acctCheck();
}
// 這台電腦接了群益(本機自動下單連著群益):加購框預選 Windows(P4)
function p3Capital() { try { return typeof trVenueIds === "function" && trVenueIds(TR_BAGS.local.st && TR_BAGS.local.st.report).indexOf("capital") >= 0; } catch (_) { return false; } }
/* P7:被付費牆切斷的那一輪(這條分頁上有 402 的額度卡、或這一輪出了資料卡)。記下哪一條、最後那句、第幾輪;付好了只重跑一次,
   而且那條分頁之後沒有再送別句(最後那句與輪次都沒變)、現在沒在跑。要的是:Blave AI 擋的(402)→ 帳號能跑了;資料擋的 → 拿得到資料了 */
function p3ResumeToken() {
  const credit = typeof creditCards !== "undefined" && creditCards.length > 0, data = typeof dataCard !== "undefined" && !!dataCard && !dataCard._relogin;
  if (!credit && !data) return null;
  return { why: credit ? "credit" : "data", text: lastUserText, seq: turnSeqMine, run: typeof tabBound === "function" ? tabBound((fn) => fn()) : (fn) => fn() };
}
async function p3Resume() {
  const k = P3.resume; P3.resume = null;   // 只一次
  if (!k) return;
  await acctCheck();
  k.run(() => {
    if (lastUserText !== k.text || turnSeqMine !== k.seq || !canResend()) { trackEvent("auto_resume", { r: "skip_new" }); return; }   // 那條之後送過別句、正在跑、或沒有可重送的
    if (k.why === "credit" ? !(acct && acct.can_run) : !hasData(acct)) { trackEvent("auto_resume", { r: "skip_state" }); return; }
    trackEvent("auto_resume", { r: "sent" });
    resendLast();
  });
}
/* 這期付了主機階、還沒開機(account_status.plan.unlaunched_tier;或剛扣了錢、主機沒開成):一行灰字＋〔開主機〕,按了開加購框(那一階預選、不收錢) */
function p3Unlaunched(tier, charged) {
  const card = p3Card();
  card.set(sysLz(() => ({ calm: !charged, text: charged ? p3T("p3.err.paidNoServer", { p: charged }) : p3T("p3.unl", { tier }),
    label: t("p3.h.okFree"), on: () => p3OpenAddon(card.b1, tier || null, undefined, "unlaunched") })));
}

/* ── 付款頁回程(第 6 步)── */
// job = p3AgentJob 那個形狀:{ kind, tier, cycle, confirm, pay, pro }
function p3WaitCard(card) {
  card.set(sysLz(() => ({ calm: true, text: t("p3.w.wait"), label: t("p3.w.reopen"), quiet: true, on: () => p3Reopen(card.b1),
    second: { label: t("p3.w.drop"), quiet: true, on: () => { trackEvent("plan_bind_res", { step: "dropped" }); p3WaitDrop(); } } })));
}
function p3WaitStart(job) {
  if (P3.wait && P3.wait.card) P3.wait.card.el.remove();
  const card = p3Card();
  P3.wait = Object.assign({}, job, { at: Date.now(), card, pro: job.pro || null });
  p3WaitCard(card);
  p3PollSoon();
}
// 〔重新打開付款頁〕:知道這張單的金額就直接到「舊頁仍能付」那個框開新單(兩下);不知道(很舊的記號)才重開整個框
function p3Reopen(b) { const w = P3.wait; if (!w) return; if (w.confirm) p3RestartAsk(w, b); else p3JobBox(w, b); }
function p3WaitDrop() { const w = P3.wait; P3.wait = null; if (w && w.card) w.card.el.remove(); try { window.blave.plan3BindDrop(); } catch (_) { } }
function p3PollSoon() { if (P3.pollT) clearTimeout(P3.pollT); P3.pollT = setTimeout(p3Poll, P3_POLL_MS); }
// 同時只跑一次(回前景與計時器可能同時叫):兩次都看到 ok 會畫兩張結果、開兩次機
async function p3Poll() {
  if (P3.polling) return;
  P3.polling = true;
  try { await p3PollOnce(); } finally { P3.polling = false; }
}
async function p3PollOnce() {
  if (P3.pollT) clearTimeout(P3.pollT);
  P3.pollT = null;
  let o = null; try { o = await window.blave.plan3BindResult(); } catch (_) { o = null; }
  const mark = o && o.mark, res = o && o.res;
  if (!o) { if (P3.wait) p3PollSoon(); return; }   // 主行程沒回:下一拍再問
  if (!mark) { if (P3.wait) { trackEvent("plan_bind_res", { step: "expired" }); p3WaitDrop(); } return; }   // 記號沒了(過了效期、或別處已收掉):那一行收掉
  if (!P3.wait) { const card = p3Card(); P3.wait = { kind: mark.kind, tier: mark.tier, cycle: mark.cycle || "monthly", confirm: mark.confirm || null, pay: mark.pay || null, at: mark.at, card, pro: null };   // 重開 app 接著等
    p3WaitCard(card); }
  const v = p3ResultView(res, mark.kind, mark.pay), w = P3.wait;
  if (!v || v.wait) {
    if (v) { w.card.set(sysLz(() => ({ calm: true, text: t(v.key) }))); if (!w.unsettledSaid) { w.unsettledSaid = true; trackEvent("plan_bind_res", { step: "unsettled" }); } }
    if (Date.now() - w.at < P3_WAIT_MS) p3PollSoon(); else { trackEvent("plan_bind_res", { step: "expired" }); p3WaitDrop(); }
    return;
  }
  P3.wait = null;
  trackEvent("plan_bind_res", { step: res.status === "ok" ? (mark.kind === "trial" ? "trial_ok" : "plan_ok") : res.status === "wallet" ? (mark.kind === "trial" ? "trial_wallet" : v.refund ? "refund" : "wallet") : "failed" });
  const text = () => p3T(v.key, v.vars) + (v.refund ? (LANG === "zh" ? "" : " ") + t("p3.w.refund") : "");
  if (v.retry) w.card.set(sysLz(() => ({ calm: false, text: text(), label: t("p3.w.retry"), on: () => (w.tier && w.tier !== "agent" ? p3OpenAddon(w.card.b1, w.tier, undefined, "retry") : p3OpenAgent(w.card.b1, null, "retry")),
    second: { label: t("p3.crypto"), quiet: true, on: () => { window.blave.openExternal(planCryptoUrl({ agent: !(w.tier && w.tier !== "agent"), cycle: w.cycle })); } } })));
  else if (res.status === "ok") p3Done(w.card, v.key, w.pro);
  // 試用沒開成但卡已綁上:可能想直接開通,給一顆開 888 方案框的鈕(框裡照常確認金額,不自動扣)
  else if (v.plan) w.card.set(sysLz(() => ({ calm: v.calm, text: text(), label: t("data.seePlan"), on: () => p3OpenAgent(w.card.b1, null, "retry") })));
  else w.card.set(sysLz(() => ({ calm: v.calm, text: text() })));
  if (res.status !== "ok") acctCheck();
  if (typeof balLoad === "function") balLoad();
  // P7(Wei 11-17):付好了才自動接著跑被付費牆切斷的那一輪;wallet(刷了沒開成)、unsettled(還在確認)不跑。開主機那條沒有被切斷的回合
  if (res.status === "ok" && (!w.tier || w.tier === "agent")) p3Resume();
  // 綁卡同時付了主機那一階(6.2):回呼不建機,外殼接著開機(這期同階不收錢);要錢的話不自動送,改開框
  if (res.status === "ok" && mark.kind === "plan" && w.tier && w.tier !== "agent") p3AutoLaunch(w.tier);
}
async function p3AutoLaunch(tier) {
  let r = null; try { r = await window.blave.plan3Addon({ tier, confirm: 0, source: "free" }); } catch (_) { r = null; }
  if (r && r.status === 200) { p3Started(r.body.state); return; }
  p3OpenAddon(null, tier);
}
window.addEventListener("focus", () => { if (P3.wait) p3Poll(); });   // 回前景馬上查一次(p3PollOnce 先清掉計時器)

/* ── 30 TWD 用完那張卡(C 版)── */
// 最近一支有回測、頁首有〔自動下單〕的本機策略(美股沒有主鈕,往下找;spec 3.1)
function p3RecentBt() {
  const list = (typeof RP !== "undefined" && RP.list) || [];
  return list.filter((x) => x && x.hasBacktest)
    .sort((a, b) => (b.statsMtime || b.mtime || 0) - (a.statsMtime || a.mtime || 0))[0] || null;
}
// 已有策略在跑:這台電腦的常駐程式活著、組合裡有策略、沒有暫停;或雲端主機在跑
function p3Running() {
  try {
    const st = TR_BAGS.local.st, r = st && st.report, a = r && r.config && r.config.amounts;
    if (st && st.alive && a && Object.keys(a).length && !(r.halt && r.halt.halted)) return true;
    return typeof envCloudKind === "function" && envCloudKind(TR_BAGS.cloud.st) === "running";
  } catch (_) { return false; }
}
/* card = acctPaint 的預檢卡或 402 卡;where = pre | turn。畫上「發生什麼」那一行(原樣)+ 下一步卡(第 4 步) */
async function p3FreeCardPaint(card, where, s) {
  const bt = p3RecentBt(), eligible = acctOffer(s), live = p3Running();
  let need = null;
  if (bt && !eligible && !live) { try { need = await window.blave.strategyDataNeed(bt.name); } catch (_) { need = null; } }
  if (acct && acct.can_run) return;   // 等判讀的這一下已經能跑了(剛綁卡回來):不把「可以開始了」蓋回用完那張
  const v = p3FreeCard({ eligible, hasBt: !!bt, isRunning: live, need }), pv = p3Pv() || {};
  card._p3 = v.paper ? "paper" : live ? "running" : "none";
  if (!card._p3sent) { card._p3sent = true; trackEvent("acct_card_alt", { alt: card._p3 }); }
  const days = (pv.trial && pv.trial.days) || s.trial_days;
  const trialBtn = () => ({ label: days ? p3T("p3.a.okTrial", { t: days }) : t("p3.a.okTrialNoNum"), on: () => { acctClicked(where, s); p3OpenAgent(null, null, "free"); } });
  const planBtn = () => ({ label: t("p3.c.plan"), on: () => { acctClicked(where, s); p3OpenAgent(null, null, "free"); } });
  card.set(sysLz(() => {
    const offer = p3El("div", "p3-offer"), act = p3El("div", "p3-act"), mk = (o, cls) => { const b = p3El("button", cls, o.label); b.type = "button"; b.addEventListener("click", o.on); return b; };
    if (v.head === "paper") { offer.append(p3El("h4", "", t("p3.c.paperH")), p3El("p", "", p3T("p3.c.recent", { name: bt.displayName || bt.name }))); }
    else offer.appendChild(p3El("h4", "", t(v.head === "trial" ? "p3.c.trialHNoNum" : "p3.c.planHNoNum")));   // 不寫額度的 TWD 數字(Wei 11-20)
    const main = v.main === "see" ? { label: t("p3.c.see"), on: () => { trackEvent("acct_card_alt_click", { card: where === "pre" ? "pre_free" : "turn_free" }); stratSelect(bt.name); } } : v.main === "trial" ? trialBtn() : planBtn();
    const second = v.second === "trial" ? trialBtn() : v.second === "plan" ? planBtn() : v.second === "local" ? { label: t("acct.useLocal"), on: () => laiOpen(card) } : null;
    act.append(mk(main, "btn-fill")); if (second) act.append(mk(second, "btn-quiet")); offer.appendChild(act);
    const text = (where === "pre" ? t("acct.freeUpNoNum") : t("fault.freeUpNoNum")) + (live ? (LANG === "zh" ? "" : " ") + t("p3.c.running") : "");
    return { calm: where === "pre", text, sub: offer };
  }));
}

/* ── 回合結束:額度快用完、用完改從錢包扣、已自動儲值(第 3、9 步)── */
async function p3TurnEnd() {
  if (!p3Live() || !hasToken || cur !== "blave") return;
  const here = typeof tabBound === "function" ? tabBound((fn) => fn()) : (fn) => fn();   // 讀完餘額再畫:畫進回合結束的那一條,不是當下看著的那條
  let b = null; try { b = await window.blave.balance(); } catch (_) { b = null; }
  if (!b) return;
  here(() => p3TurnDraw(b));
}
function p3TurnDraw(b) {
  const seen = P3.topSeen, top = b.topup;
  // 第一次讀(還不知道這一輪之前是哪一筆):只記下來不講;之後 at 變了、而且是最近 30 分鐘內的,才是這一輪剛發生的
  const topNew = seen !== undefined && top && top.at !== seen && Date.now() - Date.parse(top.at) < 30 * 60 * 1000 ? top : null;
  P3.topSeen = top ? top.at : null; P3.bal = b;
  const ac = (p3Pv() || {}).ai_credit || {};
  const lines = p3TurnLines({ ai: acct && acct.ai_credit, free: b.free, topNew, said: p3SaidGet(), hasCard: !acctNoCard(acct), autoTopup: acct ? acct.auto_topup : undefined, last4: b.last4,
    blocked: typeof creditCards !== "undefined" && creditCards.length > 0,
    low: ac.low_threshold_twd, lo: ac.auto_topup_min || (acct && acct.auto_topup_min), amt: ac.auto_topup_amount || (acct && acct.auto_topup_amount) });
  lines.forEach((l) => {
    if (l.id) p3SaidAdd(l.id);
    // 埋點(canon product-telemetry 的十個 v3 事件;主行程每安裝 × 值 × UTC 日去重)
    p3TurnEvents(l, acct && acct.ai_credit).forEach(([ev, props]) => { if (ev === "free_low_shown") trackEvent("free_low_shown", {}); else trackEvent("ai_credit_line", { kind: props.kind }); });
    const card = p3Card();
    if (l.cta) card.el.classList.add("p3-inl");   // 30 TWD 快用完那一行:文字鈕接在句尾、同一行(設計稽核 M9;canon「一行安靜文字連結」)
    const label = l.cta ? (acctOffer(acct) ? (acct.trial_days ? p3T("p3.a.okTrial", { t: acct.trial_days }) : t("p3.a.okTrialNoNum")) : t("p3.c.plan")) : null;
    card.set(sysLz(() => ({ calm: true, text: l.keys.map(([k, v]) => p3T(k, v)).join(LANG === "zh" ? "" : " "),
      ...(label ? { label, quiet: true, on: () => p3OpenAgent(card.b1, null, "low") } : {}),
      ...(l.local ? { label: t("acct.useLocal"), quiet: true, on: () => laiOpen(card) } : {}) })));
  });
}
/* 每次帳號狀態回來(acctPaint):第一次先記下自動儲值的基準;付了主機還沒開機的提示,一次開 app 講一次 */
function p3AcctSync(s) {
  if (!p3On(s, null)) return;
  if (P3.topSeen === undefined) window.blave.balance().then((b) => { if (b && P3.topSeen === undefined) p3BalSet(b); }).catch(() => {});
  const u = s.plan && s.plan.unlaunched_tier;
  if (u && !P3.unlSaid && !P3.wait && P3_HOST.includes(u)) { P3.unlSaid = true; p3Unlaunched(u, 0); }
  if (!P3.started) { P3.started = true; p3Poll(); }   // 付款頁開著時關掉 app:重開接著等
  p3QuoteLoad();
}
/* 設定頁與雲端開通頁的價要讀報價(p3Prices):帳號狀態回來時順手讀一次,60 秒內不重讀;讀到才重畫。讀不到就維持「不寫價」 */
async function p3QuoteLoad() {
  if (P3.qBusy || (P3.qAt && Date.now() - P3.qAt < 60000)) return;
  P3.qBusy = true;
  let r = null; try { r = await window.blave.plan3Quote(); } catch (_) { r = null; }
  P3.qBusy = false; P3.qAt = Date.now();
  if (r && r.status === 200 && r.body) { P3.q = r.body; if (typeof planPaint === "function" && !$("set-scrim").hidden) planPaint(); if (typeof sidePaint === "function") sidePaint(); }
}

/* 用量條的百分比(設計 ai-credit-usage-bar-2026-11-20 §3):granted 不是 >0 → null(整列不出);用完(left <= 0,含超額)→ 100;
   其餘無條件捨去、最多 99——只有真的用完才寫 100。left 不是數字(舊 api 只給 granted)→ null:不知道用了多少,不能編一個 100% */
function p3UsedPct(granted, left) {
  const g = Number(granted), l = Number(left);
  if (!(g > 0) || typeof left !== "number" || !isFinite(left)) return null;
  if (!(l > 0)) return 100;
  // 同網頁 aiUsedPct:先收到小數 6 位再捨去——(100−71)/100×100 在浮點是 28.999…,直接 floor 會少 1%(網頁與 references/billing.md 都是 29)
  return Math.max(0, Math.min(99, Math.floor(Number((((g - l) / g) * 100).toFixed(6)))));
}
/* ── 設定 › 帳號與方案:本期 AI 額度用量條與超額(第 9 步「超額中的設定頁」)、自動儲值那一句 ──
   Wei 11-20:不寫 AI 額度的總額與剩餘 TWD,只寫「已用 N%」;條下依序「本期已超額 {o} TWD」(錢包扣的錢照寫)→「{at} 重置。」。
   條是裝飾(aria-hidden),title／aria／data 都不放 TWD 數字 */
function p3PlanRows(id) {
  if (!p3Live() || !hasToken) return false;
  const b = P3.bal, pct = b ? p3UsedPct(b.aiGranted, b.aiLeft) : null;
  if (pct !== null) {
    const r = p3El("div", "plan-bal is-meter"), m = p3El("span", "v ai-meter"), track = p3El("span", "ai-track"), fill = p3El("span", "ai-fill");
    track.setAttribute("aria-hidden", "true"); fill.style.width = pct + "%"; if (pct > 0) fill.classList.add("on"); track.appendChild(fill);
    m.append(track, p3El("span", "pct", p3T("p3.set.used", { p: pct })));
    r.append(p3El("span", "l", t("p3.set.ai")), m);
    id.appendChild(r);
    if (b.aiOver > 0) id.appendChild(p3El("p", "plan-fine", p3T("p3.set.over", { o: Math.round(b.aiOver) })));
    const ai = acct && acct.ai_credit;
    if (ai && ai.kind === "period" && ai.next_grant_at) id.appendChild(p3El("p", "plan-fine", p3T("p3.set.reset", { at: ai.next_grant_at })));
  }
  if (!acctNoCard(acct) && !(acct && acct.auto_topup === false)) { const p = p3TopupLine(); p.className = "plan-fine"; id.appendChild(p); }   // 關了自動儲值:不講它會補(auto_topup 缺或 null 照有卡判)
  return true;
}
