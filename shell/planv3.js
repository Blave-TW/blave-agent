/* 改價 v3 的電腦版付款框:主行程那一半(契約 .claude/output/pricing-pro-unlocks-agent-2026-11-16/CONTRACT.md §4.3、§5、§6;
   最後一節「凍結後修正」優先)。畫面在 renderer/planv3.js。
   - 六支端點都帶帳號 token + app_secret(同 /plan/start、/balance),兩顆憑證不出主行程。
   - 回應當不可信輸入:每支只留畫面要的欄位、逐欄驗型別(同 main.js libCheckoutBody)。
   - 開藍新頁沿用策略庫綁卡即購買那條(main.js libPayForm 驗網域與欄位 → libPayOpen 本機 127.0.0.1 一次性自動送出頁),由呼叫端注入,這裡不另寫一份。
   - 等付款結果的記號存 userData(付款頁開著時關掉 app,重開還接得上);拿到終態或過了付款頁效期就清。
   - 確認金額一律是畫面印的那個整數(含開主機的 0 元重開),不替用戶改金額、不自動重送。 */
const fs = require("fs");

const EP = {
  quote: "/oauth/desktop/plan/quote", bindTrial: "/oauth/desktop/plan/bind_trial", bindPay: "/oauth/desktop/plan/bind_pay",
  addon: "/oauth/desktop/plan/addon", result: "/oauth/desktop/plan/bind_result", start: "/oauth/desktop/plan/start",
};
const HOST_TIERS = ["linux_starter", "linux_premium", "linux_max", "windows_starter", "windows_premium", "windows_max"];
const TIERS = ["agent"].concat(HOST_TIERS);
const CYCLES = ["monthly", "annual"];
const SRC = ["card", "wallet", "none", "free"];
const PAY_SRC = ["card", "wallet", "free"];   // 一鍵扣款送得出去的 expected_source(契約 6.0)
const MARK_MS = 40 * 60 * 1000;               // 付款頁 30 分鐘有效(BIND_PLAN_OPEN_TTL),多留 10 分鐘等回呼
const RESULT_SKEW_MS = 15 * 60 * 1000;        // 伺服器的建單時間跟本機時鐘差多少還算「這一張」

const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
const amt = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const code = (v) => (typeof v === "string" && /^[A-Z0-9_]{1,40}$/.test(v) ? v : null);
const pick = (v, list) => (list.includes(v) ? v : null);
const iso = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[0-9:.+\-Z]{2,40}$/.test(v) && !isNaN(Date.parse(v)) ? v : null);
const last4 = (v) => (typeof v === "string" && /^\d{4}$/.test(v) ? v : null);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);

function linesOf(v) {
  if (!Array.isArray(v)) return null;
  const out = v.slice(0, 4).map((x) => (obj(x) && ["agent", "addon"].includes(x.kind) && pick(x.tier, TIERS) && amt(x.twd) !== null ? { kind: x.kind, tier: x.tier, twd: x.twd } : null));
  return out.every(Boolean) ? out : null;
}
function agentCell(c) {
  c = obj(c); if (!c) return null;
  const today = amt(c.today_twd), first = amt(c.first_charge_twd);
  if (today === null || first === null) return null;
  // period_days / ai_credit_twd:框上的條件數字(後端補欄位中;舊 api 沒有 = null,畫面退公開價目 v3)
  return { today_twd: today, today_is: pick(c.today_is, ["verify", "charge"]), first_charge_at: iso(c.first_charge_at), first_charge_twd: first, source: pick(c.source, SRC),
    period_days: amt(c.period_days) || null, ai_credit_twd: amt(c.ai_credit_twd) || null };
}
function addonCell(c) {
  c = obj(c); if (!c) return null;
  const today = amt(c.today_twd), kind = pick(c.today_kind, ["full", "prorated", "reopen_free"]);
  if (today === null || !kind || (kind === "reopen_free" && today !== 0)) return null;
  return { today_twd: today, today_kind: kind, next_twd: amt(c.next_twd), next_at: iso(c.next_at), source: pick(c.source, SRC) };
}
/* /plan/quote 的 200(契約 §5;addon_offer.tiers 每格多一個 source,凍結後修正)。v3 沒開或形狀不對 → null */
function quoteBody(b) {
  b = obj(b);
  if (!b || b.v3_active !== true) return null;
  const tr = obj(b.trial) || {}, pl = obj(b.plan) || {}, mc = obj(b.machine) || {}, ao = obj(b.agent_offer), so = obj(b.studio_subscription) || {};
  if (!ao || !pick(ao.kind, ["trial_bind", "bind_pay", "pay", "active"])) return null;
  const agent = { kind: ao.kind, monthly: agentCell(ao.monthly), annual: agentCell(ao.annual) };
  if (!agent.monthly) return null;
  let addon = null;
  const ad = obj(b.addon_offer);
  if (ad && Array.isArray(ad.tiers)) {
    const seen = new Set();
    const tiers = ad.tiers.map((r) => {
      r = obj(r); if (!r || !pick(r.tier, HOST_TIERS) || seen.has(r.tier)) return null;
      seen.add(r.tier);
      const m = addonCell(r.monthly), y = addonCell(r.annual);
      return m || y ? { tier: r.tier, monthly: m, annual: y } : null;
    }).filter(Boolean);
    addon = { kind: pick(ad.kind, ["trial_convert", "bind_pay", "pay", "prorated", "reopen"]), tiers, source: pick(ad.source, SRC) };
  }
  return {
    has_card: b.has_card === true, card_last4: last4(b.card_last4), balance_twd: num(b.balance_twd),
    trial: { eligible: tr.eligible === true, active: tr.active === true, gen: pick(tr.gen, ["v1", "v2", "v3"]), ends_at: iso(tr.ends_at), cancel_at_end: tr.cancel_at_end === true,
      days: amt(tr.days) || null, ai_credit_twd: amt(tr.ai_credit_twd) || null },
    plan: { state: pick(pl.state, ["none", "trial", "active", "failing", "lapsed"]) || "none", paid_tier: pick(pl.paid_tier, TIERS), cycle: pick(pl.cycle, CYCLES),
      paid_until: iso(pl.paid_until), remaining_days: amt(pl.remaining_days), unlaunched_tier: pick(pl.unlaunched_tier, HOST_TIERS) },
    machine: { state: pick(mc.state, ["none", "starting", "running", "stopped"]) || "none", tier: pick(mc.tier, HOST_TIERS) },
    agent_offer: agent, addon_offer: addon,
    studio: { source: pick(so.source, ["newebpay", "apple", "google", "crypto", "other", "none"]) || "none", plan: pick(so.plan, ["pro", "api"]),
      auto_renew: typeof so.auto_renew === "boolean" ? so.auto_renew : null, expires_at: iso(so.expires_at) },
    // 讀不到(Redis 掛了)是 null,不是 0:不把「不知道」畫成「用完了」
    paid_launch_left_today: amt(b.paid_launch_left_today), expected_source: pick(b.expected_source, SRC),
  };
}
/* public_tiers.plan.v3(契約 §3.2):沒登入的框與加購框的規格、額度門檻。缺的數字是 null,畫面就不畫那一句 */
function publicV3(v) {
  v = obj(v); if (!v) return null;
  const ag = obj(v.agent) || {}, tr = obj(v.trial) || {}, ac = obj(v.ai_credit) || {};
  const pos = (x) => (amt(x) ? x : null);
  return {
    agent: { monthly_twd: pos(ag.monthly_twd), annual_twd: pos(ag.annual_twd), period_days: pos(ag.period_days), ai_credit_per_period_twd: pos(ag.ai_credit_per_period_twd) },
    addons: (Array.isArray(v.addons) ? v.addons : []).map((r) => (obj(r) && pick(r.tier, HOST_TIERS) ? { tier: r.tier, vcpu: pos(r.vcpu), ram_gb: pos(r.ram_gb),
      addon_monthly_twd: pos(r.addon_monthly_twd), total_monthly_twd: pos(r.total_monthly_twd) } : null)).filter(Boolean),
    trial: { days: pos(tr.days), ai_credit_twd: pos(tr.ai_credit_twd), verify_twd: pos(tr.verify_twd), first_charge_monthly_twd: pos(tr.first_charge_monthly_twd) },
    ai_credit: { low_threshold_twd: pos(ac.low_threshold_twd), auto_topup_min: pos(ac.auto_topup_min), auto_topup_amount: pos(ac.auto_topup_amount) },
    daily_paid_launch_limit: pos(v.daily_paid_launch_limit),
  };
}
/* 非 200 的回應(409 報價、錯誤碼):只留畫面分流與重畫要的欄位;reason 是中文句、不進畫面 */
function errBody(b) {
  b = obj(b); if (!b) return null;
  const out = { error_code: code(b.error_code) || code(b.error), confirm_field: pick(b.confirm_field, ["confirm_first_twd", "confirm_total_twd", "confirm_today_twd", "confirm_monthly_twd", "confirm_annual_twd"]),
    source: pick(b.source, SRC), use: pick(b.use, ["bind_pay", "bind_trial"]), tier: pick(b.tier, TIERS), cycle: pick(b.cycle, CYCLES),
    today_kind: pick(b.today_kind, ["full", "prorated", "reopen_free"]), machine_state: typeof b.machine_state === "string" && /^[a-z_]{1,20}$/.test(b.machine_state) ? b.machine_state : null,
    limit: amt(b.limit), resets_at: iso(b.resets_at), charged_twd: amt(b.charged_twd), lines: linesOf(b.lines) };
  for (const k of ["today_twd", "next_twd", "total_twd", "price_twd", "first_charge_twd", "verify_twd", "trial_days", "trial_ai_credit_twd", "remaining_days", "auto_topup_min", "auto_topup_amount"]) out[k] = amt(b[k]);
  for (const k of ["next_at", "first_charge_at"]) out[k] = iso(b[k]);
  return out;
}
/* /plan/bind_result(契約 6.4):形狀不對整筆當沒有。failed 的原因句不進畫面(只看 status) */
function resultBody(b) {
  const r = obj(b) && obj(b.bind);
  if (!r || !pick(r.kind, ["trial", "plan"]) || !pick(r.status, ["pending", "ok", "unsettled", "failed", "wallet"])) return null;
  return { kind: r.kind, status: r.status, tier: pick(r.tier, TIERS), cycle: pick(r.cycle, CYCLES), amount_twd: amt(r.amount_twd),
    refund_review: r.refund_review === true, at: iso(r.at) };
}
/* 記號:{ kind: trial|plan, tier, cycle, at }。過期或壞掉 = 沒有(順手清掉) */
function markOk(m, now) {
  return !!(obj(m) && pick(m.kind, ["trial", "plan"]) && (m.tier === null || pick(m.tier, TIERS)) && typeof m.at === "number" && m.at <= now && now - m.at < MARK_MS);
}
// 這一筆結果是不是記號那一張:同種類、建單時間不比開頁早太多(較新的那張一定是這次 claim 的;舊的同種結果不算)
function resultIsMark(res, mark) {
  if (!res || !mark || res.kind !== mark.kind) return false;
  const at = res.at ? Date.parse(res.at) : NaN;
  return isNaN(at) || at >= mark.at - RESULT_SKEW_MS;
}

function createPlanV3({ apiBase, post, getCreds, payForm, payOpen, markPath, onMoney, now, replaceFile }) {
  const clock = now || (() => Date.now());
  const creds = () => { const c = getCreds(); return c && c.token && c.appSecret ? c : null; };
  const call = async (ep, extra) => {
    const c = creds();
    if (!c) return { status: 401, body: null };
    try { return await post(apiBase + ep, Object.assign({ token: c.token, app_secret: c.appSecret }, extra || {})); }
    catch (_) { return { status: 0, body: null }; }
  };
  const markGet = () => {
    let m = null; try { m = JSON.parse(fs.readFileSync(markPath(), "utf8")); } catch (_) { return null; }
    if (!markOk(m, clock())) { markSet(null); return null; }
    // confirm / pay:這張單確認的金額與藍新頁上的金額;〔重新打開付款頁〕直接用它們開新單(重開 app 之後也一樣)
    return { kind: m.kind, tier: m.tier || null, cycle: pick(m.cycle, CYCLES), at: m.at, confirm: amt(m.confirm), pay: amt(m.pay) };
  };
  const markSet = (m) => { try { if (m) replaceFile(markPath(), JSON.stringify(m)); else fs.rmSync(markPath(), { force: true }); } catch (_) { } };
  const money = () => { try { onMoney(); } catch (_) { } };

  async function quote() {
    const r = await call(EP.quote);
    if (r.status === 200) { const q = quoteBody(r.body); return q ? { status: 200, body: q } : { status: 0, body: null }; }
    return { status: r.status, body: errBody(r.body) };
  }
  // 開藍新頁的兩支(6.1、6.2):200 是 P1 表單 → 驗網域與欄位 → 本機自動送出頁 → 記號
  async function openPay(ep, extra, mark) {
    const r = await call(ep, extra);
    if (r.status !== 200) return { status: r.status, body: errBody(r.body) };
    const form = payForm(r.body);
    if (!form) return { status: 0, body: null };
    try { await payOpen(form); } catch (_) { return { status: 0, body: null }; }
    markSet(Object.assign({}, mark, { at: clock() }));
    return { status: 200, opened: true };
  }
  const lang = (v) => (v === "en" ? "en" : "zh");
  function bindTrial(o) {
    o = obj(o) || {};
    const cycle = pick(o.cycle, CYCLES) || "monthly", extra = { cycle, lang: lang(o.lang) };
    if (amt(o.confirm) !== null) extra.confirm_first_twd = o.confirm;
    if (o.restart === true) extra.restart = true;
    return openPay(EP.bindTrial, extra, { kind: "trial", tier: "agent", cycle, confirm: amt(o.confirm), pay: amt(o.pay) });
  }
  function bindPay(o) {
    o = obj(o) || {};
    if (!pick(o.tier, TIERS)) return Promise.resolve({ status: 400, body: null });
    const cycle = pick(o.cycle, CYCLES) || "monthly", extra = { tier: o.tier, cycle, lang: lang(o.lang) };
    if (amt(o.confirm) !== null) extra.confirm_total_twd = o.confirm;
    if (o.restart === true) extra.restart = true;
    return openPay(EP.bindPay, extra, { kind: "plan", tier: o.tier, cycle, confirm: amt(o.confirm), pay: amt(o.confirm) });
  }
  /* 框內一鍵開主機(6.3)。confirm 是框上印的今天那一筆(重開同階是 0,照送);source 是「那一格」的來源,不是 quote 頂層那個 */
  async function addon(o) {
    o = obj(o) || {};
    if (!pick(o.tier, HOST_TIERS) || amt(o.confirm) === null || !pick(o.source, PAY_SRC)) return { status: 400, body: null };
    const extra = { tier: o.tier, confirm_today_twd: o.confirm, expected_source: o.source };
    if (pick(o.cycle, CYCLES)) extra.cycle = o.cycle;
    const r = await call(EP.addon, extra);
    money();   // 送出去就可能動了錢(含扣了錢主機沒開成、逾時沒收到結果;稽核 B6):帳號狀態與錢包都作廢
    const b = obj(r.body) || {};
    if (r.status === 200) return { status: 200, body: { state: pick(b.state, ["none", "starting", "running", "stopped"]) || "starting", charged_twd: amt(b.charged_twd), source: pick(b.source, SRC), kind: pick(b.kind, ["full", "prorated", "reopen_free"]) } };
    return { status: r.status, body: errBody(r.body) };
  }
  /* 只開 888 階(6.5 新欄位):plan_tier agent + server false;expected_source 必帶,錢包付另帶 pay_from */
  async function agentStart(o) {
    o = obj(o) || {};
    const cycle = pick(o.cycle, CYCLES) || "monthly", extra = { server: false, plan_tier: "agent", cycle };
    if (amt(o.confirm) !== null) extra[cycle === "annual" ? "confirm_annual_twd" : "confirm_monthly_twd"] = o.confirm;
    if (pick(o.source, PAY_SRC)) extra.expected_source = o.source;
    if (o.wallet === true) extra.pay_from = "wallet";
    const r = await call(EP.start, extra);
    money();
    const b = obj(r.body) || {};
    if (r.status === 200 && typeof b.state === "string") return { status: 200, body: { state: b.state } };
    return { status: r.status, body: errBody(r.body) };
  }
  /* 回 { mark, res }:沒有等著的就不打 api。拿到記號那一張的終態就清記號、作廢帳號狀態與錢包 */
  async function bindResult() {
    const mark = markGet();
    if (!mark) return { mark: null, res: null };
    const r = await call(EP.result);
    const res = r.status === 200 ? resultBody(r.body) : null;
    const mine = resultIsMark(res, mark) ? res : null;
    if (mine && mine.status !== "pending" && mine.status !== "unsettled") { markSet(null); money(); }
    return { mark, res: mine };
  }
  return { quote, bindTrial, bindPay, addon, agentStart, bindResult, dropMark: () => markSet(null) };
}

module.exports = { createPlanV3, quoteBody, errBody, resultBody, publicV3, markOk, resultIsMark, EP, HOST_TIERS, MARK_MS };
