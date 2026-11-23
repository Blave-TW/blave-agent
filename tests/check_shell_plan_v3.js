// 改價 v3 電腦版付款框(shell/planv3.js + shell/renderer/planv3.js;契約 output/pricing-pro-unlocks-agent-2026-11-16/CONTRACT.md)。不起 Electron:
//   ① 主行程:quote／錯誤／回程的欄位白名單;六支端點送出的 body(確認金額、expected_source、plan_tier);付款頁記號的寫與清。
//   ② 畫面純邏輯:Agent 方案框四種身分、Pro 重複、加購框每一格(來源逐格判、上限、重開不收錢、補差額、試用轉付費、沒卡綁卡、錢包不夠)、
//      回程五態、30 TWD 卡 C 版分流、回合結束那幾行。
//   ③ 接線:v3 關著時每個入口照舊;v3 開著時入口改開框;IPC 只收自家畫面。
// 跑法:node tests/check_shell_plan_v3.js
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 800))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8"), J = (x) => JSON.stringify(x);
const M = require(path.join(SHELL, "planv3.js"));
const src = read(path.join(R, "planv3.js")), app = read(path.join(R, "app.js")), mainSrc = read(path.join(SHELL, "main.js")), pre = read(path.join(SHELL, "preload.js"));
const P = {}; vm.createContext(P);
vm.runInContext(src.slice(src.indexOf("/* ── 純邏輯("), src.indexOf("/* ── 純邏輯到此")).replace(/^const /gm, "var "), P);
const STR = (() => { const sb = {}; vm.runInNewContext(read(path.join(R, "strings.js")) + "\nthis.S = STRINGS;", sb); return sb.S; })();

// ── fixtures:照 CONTRACT §5、6 的形狀(addon 每格帶 source:凍結後修正)──
const cell = (today, kind, source, next) => ({ today_twd: today, today_kind: kind, next_twd: next || today, next_at: "2026-12-16T06:00:00Z", source });
const SIX = { linux_starter: 552, linux_premium: 3400, linux_max: 7400, windows_starter: 3100, windows_premium: 5200, windows_max: 11000 };
const rows = (f) => Object.keys(SIX).map((t) => ({ tier: t, monthly: f(t, 888 + SIX[t]), annual: cell((888 * 10) + SIX[t] * 12, "full", "card") }));
function rawQuote(o) {
  o = o || {};
  return Object.assign({
    v3_active: true, has_card: false, card_last4: null, balance_twd: 0,
    trial: { eligible: true, active: false, gen: "v3", ends_at: null, cancel_at_end: false },
    plan: { state: "none", paid_tier: null, cycle: null, paid_until: null, remaining_days: null, unlaunched_tier: null },
    machine: { state: "none", tier: null },
    agent_offer: { kind: "trial_bind", monthly: { today_twd: 10, today_is: "verify", first_charge_at: "2026-11-30T14:00:00+08:00", first_charge_twd: 888, source: "card" },
      annual: { today_twd: 10, today_is: "verify", first_charge_at: "2026-11-30T14:00:00+08:00", first_charge_twd: 8880, source: "card" } },
    addon_offer: { kind: "bind_pay", tiers: rows((t, p) => cell(p, "full", "none")), source: "none" },
    studio_subscription: { source: "none", plan: null, auto_renew: null, expires_at: null, product_id: null },
    paid_launch_left_today: 5, expected_source: "none",
  }, o);
}
const Q = (o) => M.quoteBody(rawQuote(o));
const PV = { agent: { monthly_twd: 888, annual_twd: 8880, period_days: 30, ai_credit_per_period_twd: 300 },
  addons: Object.keys(SIX).map((t) => ({ tier: t, vcpu: 2, ram_gb: 4, addon_monthly_twd: SIX[t], total_monthly_twd: 888 + SIX[t] })),
  trial: { days: 14, ai_credit_twd: 150, verify_twd: 10, first_charge_monthly_twd: 888 }, ai_credit: { low_threshold_twd: 20, auto_topup_min: 50, auto_topup_amount: 300 }, daily_paid_launch_limit: 5 };

(async () => {
  // ── ① 主行程:白名單 ──
  ok("① quote:v3_active 不是 true(false、缺、舊 api 404 的 body)→ null", [rawQuote({ v3_active: false }), Object.assign(rawQuote(), { v3_active: undefined }), null, {}].every((b) => M.quoteBody(b) === null));
  { const q = Q({ card_last4: "4242x", balance_twd: "120", paid_launch_left_today: null, extra_secret: "x" });
    ok("① quote:末四碼只收四位數字、餘額非數字 = null、今天剩幾次讀不到 = null(不是 0)、不認得的欄位丟掉", q.card_last4 === null && q.balance_twd === null && q.paid_launch_left_today === null && !("extra_secret" in q)); }
  { const q = Q({ addon_offer: { kind: "pay", source: "wallet", tiers: [{ tier: "linux_starter", monthly: cell(1440, "full", "wallet") }, { tier: "linux_premium", monthly: cell(4288, "full", "card") }, { tier: "bogus", monthly: cell(1, "full", "card") }, { tier: "linux_starter", monthly: cell(1, "full", "card") }] } });
    ok("① quote:加購格逐格留 source;認不得的階、重複的階丟掉", q.addon_offer.tiers.length === 2 && q.addon_offer.tiers[0].monthly.source === "wallet" && q.addon_offer.tiers[1].monthly.source === "card"); }
  ok("① quote:reopen_free 的格金額必須是 0,不是就整格丟掉", Q({ addon_offer: { kind: "reopen", source: "free", tiers: [{ tier: "linux_starter", monthly: cell(5, "reopen_free", "free") }] } }).addon_offer.tiers.length === 0);
  { const e = M.errBody({ error_code: "PLAN_CONFIRM_REQUIRED", confirm_field: "confirm_today_twd", source: "card", card_last4: "4242", tier: "linux_premium", cycle: "monthly", today_kind: "prorated", today_twd: 2040, remaining_days: 18,
      lines: [{ kind: "agent", tier: "agent", twd: 888 }, { kind: "addon", tier: "linux_premium", twd: 3400 }], next_twd: 4288, next_at: "2026-12-04T06:12:00Z", reason: "卡片被拒", message: "x" });
    ok("① 409 報價:留 confirm_field／source／金額／lines,原因句不進畫面", e.error_code === "PLAN_CONFIRM_REQUIRED" && e.confirm_field === "confirm_today_twd" && e.today_twd === 2040 && e.lines.length === 2 && !("reason" in e) && !("message" in e)); }
  ok("① 錯誤碼:DAILY_LAUNCH_LIMIT 帶 limit／resets_at;扣了錢沒開成帶 charged_twd", (() => { const e = M.errBody({ error_code: "DAILY_LAUNCH_LIMIT", limit: 5, resets_at: "2026-11-18T00:00:00+08:00" }), f = M.errBody({ error_code: "LAUNCH_FAILED", charged_twd: 1440 }); return e.limit === 5 && !!e.resets_at && f.charged_twd === 1440; })());
  ok("① 回程:五種狀態都收、其他整筆丟", ["pending", "ok", "unsettled", "failed", "wallet"].every((s) => M.resultBody({ bind: { kind: "plan", status: s, at: "2026-11-17T01:00:00Z" } }).status === s) && M.resultBody({ bind: { kind: "plan", status: "weird" } }) === null && M.resultBody({ bind: null }) === null);
  ok("① 回程:wallet 帶 refund_review", M.resultBody({ bind: { kind: "plan", status: "wallet", amount_twd: 15504, refund_review: true } }).refund_review === true);
  { const mark = { kind: "plan", at: Date.parse("2026-11-17T01:00:00Z") };
    ok("① 回程配記號:同種類、建單時間不早於開頁 15 分鐘以上才算這一張", M.resultIsMark({ kind: "plan", at: "2026-11-17T00:58:00Z" }, mark) && !M.resultIsMark({ kind: "trial", at: "2026-11-17T01:00:00Z" }, mark) && !M.resultIsMark({ kind: "plan", at: "2026-11-16T20:00:00Z" }, mark)); }
  ok("① public_tiers.plan.v3:數字留、階以外的丟、v3 null → null", M.publicV3(null) === null && M.publicV3({ agent: { monthly_twd: 888 }, addons: [{ tier: "x" }, { tier: "linux_starter", addon_monthly_twd: 552 }] }).addons.length === 1);

  // ── ① 主行程:送出的 body 與記號 ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-")), markFile = path.join(dir, "plan-bind.json");
  const mk = (reply) => {
    const sent = [], opened = [], money = []; let now = Date.parse("2026-11-17T01:00:00Z");
    const h = M.createPlanV3({ apiBase: "https://api.test", post: async (u, b) => { sent.push([u, b]); return typeof reply === "function" ? reply(u, b) : reply; },
      getCreds: () => ({ token: "acct-A", appSecret: "appsec-A" }), payForm: (b) => (b && b.url === "https://ccore.newebpay.com/x" ? { url: b.url, fields: {} } : null),
      payOpen: async (f) => { opened.push(f.url); }, markPath: () => markFile, replaceFile: (p, s) => fs.writeFileSync(p, s), onMoney: () => money.push(1), now: () => now });
    return { h, sent, opened, money, tick: (ms) => { now += ms; } };
  };
  const FORM = { status: 200, body: { url: "https://ccore.newebpay.com/x", MerchantID: "M", TradeInfo: "aa", TradeSha: "bb", Version: "2.0" } };
  { fs.rmSync(markFile, { force: true });
    const m = mk(FORM), r = await m.h.bindTrial({ cycle: "monthly", confirm: 888, lang: "zh" });
    ok("① 試用綁卡(6.1):帶 confirm_first_twd = 框上那一期,開本機付款頁,寫記號 kind=trial", r.opened === true && m.sent[0][0] === "https://api.test/oauth/desktop/plan/bind_trial"
      && J(m.sent[0][1]) === J({ token: "acct-A", app_secret: "appsec-A", cycle: "monthly", lang: "zh", confirm_first_twd: 888 }) && m.opened.length === 1 && JSON.parse(read(markFile)).kind === "trial" && JSON.parse(read(markFile)).confirm === 888); }
  { fs.rmSync(markFile, { force: true });
    const m = mk({ status: 409, body: { error_code: "PLAN_CONFIRM_REQUIRED", confirm_field: "confirm_first_twd", first_charge_twd: 888, source: "card" } }), r = await m.h.bindTrial({ cycle: "monthly", confirm: 900 });
    ok("① 試用綁卡 409:不開頁、不寫記號,回伺服器現價", !r.opened && r.status === 409 && r.body.first_charge_twd === 888 && m.opened.length === 0 && !fs.existsSync(markFile)); }
  { const m = mk({ status: 200, body: { url: "https://evil.example/x" } }), r = await m.h.bindPay({ tier: "agent", cycle: "monthly", confirm: 888 });
    ok("① 付款頁網域不在白名單:不開、回失敗", r.status === 0 && m.opened.length === 0); }
  { fs.rmSync(markFile, { force: true });
    const m = mk(FORM), r = await m.h.bindPay({ tier: "linux_starter", cycle: "monthly", confirm: 1440, restart: true });
    ok("① 綁卡付第一期(6.2):tier、confirm_total_twd、restart 照送;記號帶那一階(回程後要接著開機)", r.opened && J(m.sent[0][1]) === J({ token: "acct-A", app_secret: "appsec-A", tier: "linux_starter", cycle: "monthly", lang: "zh", confirm_total_twd: 1440, restart: true })
      && JSON.parse(read(markFile)).tier === "linux_starter"); }
  { const m = mk({ status: 200, body: { state: "starting", charged_twd: 0, source: "free", kind: "reopen_free" } }), r = await m.h.addon({ tier: "linux_starter", confirm: 0, source: "free" });
    ok("① 框內開主機(6.3):重開同階送 confirm_today_twd 0 與 expected_source free(不被「> 0」擋掉)", r.status === 200 && m.sent[0][1].confirm_today_twd === 0 && m.sent[0][1].expected_source === "free" && m.money.length === 1); }
  { const m = mk({ status: 200, body: {} });
    const a = await m.h.addon({ tier: "linux_starter", confirm: 1440 }), b = await m.h.addon({ tier: "linux_starter", confirm: 1440, source: "none" }), c = await m.h.addon({ tier: "agent", confirm: 888, source: "card" });
    ok("① 框內開主機:沒帶 expected_source、source=none、不是主機階 → 不送", [a, b, c].every((r) => r.status === 400) && m.sent.length === 0); }
  { const m = mk({ status: 502, body: { error_code: "LAUNCH_FAILED", charged_twd: 1440 } }), r = await m.h.addon({ tier: "linux_starter", confirm: 1440, source: "card" });
    ok("① 扣了錢主機沒開成:charged_twd 傳回畫面、帳號狀態作廢", r.body.charged_twd === 1440 && m.money.length === 1); }
  { const m = mk({ status: 200, body: { state: "none" } }), r = await m.h.agentStart({ cycle: "monthly", confirm: 888, source: "wallet", wallet: true });
    ok("① 只開 888 階(6.5):server false + plan_tier agent + confirm_monthly_twd + expected_source;錢包付另帶 pay_from", r.status === 200
      && J(m.sent[0][1]) === J({ token: "acct-A", app_secret: "appsec-A", server: false, plan_tier: "agent", cycle: "monthly", confirm_monthly_twd: 888, expected_source: "wallet", pay_from: "wallet" })); }
  { const m = mk({ status: 409, body: { error_code: "SOURCE_CHANGED", source: "card", price_twd: 888 } }), r = await m.h.agentStart({ cycle: "monthly", confirm: 888, source: "wallet" });
    ok("① 只開 888 階:SOURCE_CHANGED 回畫面重問,不自動重送", r.status === 409 && r.body.error_code === "SOURCE_CHANGED" && m.sent.length === 1); }
  { fs.writeFileSync(markFile, J({ kind: "plan", tier: "linux_starter", cycle: "monthly", at: Date.parse("2026-11-17T01:00:00Z") }));
    const m = mk({ status: 200, body: { bind: { kind: "plan", status: "pending", at: "2026-11-17T01:00:00Z" } } }); let o = await m.h.bindResult();
    ok("① 回程 pending:記號留著", o.res.status === "pending" && fs.existsSync(markFile));
    const m2 = mk({ status: 200, body: { bind: { kind: "trial", status: "ok", at: "2026-11-17T01:00:00Z" } } }); o = await m2.h.bindResult();
    ok("① 回程:別種單(試用綁卡)的結果不算這一張", o.res === null && fs.existsSync(markFile));
    const m3 = mk({ status: 200, body: { bind: { kind: "plan", status: "ok", at: "2026-11-17T01:00:00Z" } } }); o = await m3.h.bindResult();
    ok("① 回程 ok:清記號、作廢帳號狀態與錢包", o.res.status === "ok" && !fs.existsSync(markFile) && m3.money.length === 1);
    const m4 = mk({ status: 200, body: {} }); o = await m4.h.bindResult();
    ok("① 沒有記號:不打 api", o.mark === null && m4.sent.length === 0); }
  { fs.writeFileSync(markFile, J({ kind: "trial", tier: "agent", at: Date.parse("2026-11-17T01:00:00Z") - M.MARK_MS - 1 }));
    const m = mk({ status: 200, body: {} }), o = await m.h.bindResult();
    ok("① 記號過了付款頁效期:當沒有、順手清掉", o.mark === null && !fs.existsSync(markFile)); }
  fs.rmSync(dir, { recursive: true, force: true });

  // ── ② Agent 方案框 ──
  ok("② v3 開關:登入看 account_status、沒登入看 public_tiers;舊 api 沒有鍵 = 關", P.p3On({ v3_active: true }, null) && !P.p3On({ v3_active: false }, { plan: { v3_active: true } }) && !P.p3On({}, null)
    && P.p3On(null, { plan: { v3_active: true } }) && !P.p3On(null, { plan: {} }) && !P.p3On(null, null));
  { const m = P.p3AgentModel(null, PV); ok("② 沒登入:價格與試用天數讀公開價目,主鈕是登入", m.kind === "out" && m.price === 888 && m.trialDays === 14); }
  ok("② 沒登入、公開價目讀不到:none(退回舊路)", P.p3AgentModel(null, null).kind === "none");
  { const m = P.p3AgentModel(Q(), PV);
    ok("② 有試用資格、沒卡:驗證 10、哪天扣 888 讀 quote;報價沒帶條件數字時試用天數／試用額度／一期幾天／每期額度退公開價目", m.kind === "trial" && m.verify === 10 && m.first === 888 && /2026-11-30/.test(m.firstAt) && m.aiTrial === 150 && m.aiPeriod === 300 && m.trialDays === 14 && m.days === 30); }
  { const nt = { eligible: false, active: false, gen: "v3", ends_at: null, cancel_at_end: false };
    const a = P.p3AgentModel(Q({ trial: nt, balance_twd: 900, agent_offer: { kind: "pay", monthly: { today_twd: 888, today_is: "charge", first_charge_at: null, first_charge_twd: 888, source: "wallet" } } }), PV);
    const b = P.p3AgentModel(Q({ trial: nt, balance_twd: 887, agent_offer: { kind: "bind_pay", monthly: { today_twd: 888, today_is: "charge", first_charge_at: null, first_charge_twd: 888, source: "card" } } }), PV);
    ok("② 沒資格、沒卡:主鈕綁卡並付;錢包夠一整期才多〔用錢包付〕(887 不出)", a.kind === "bindPay" && a.wallet === true && b.kind === "bindPay" && b.wallet === false && a.price === 888); }
  { const nt = { eligible: false, active: false, gen: "v3", ends_at: null, cancel_at_end: false };
    const card = P.p3AgentModel(Q({ trial: nt, has_card: true, card_last4: "4242", agent_offer: { kind: "pay", monthly: { today_twd: 888, today_is: "charge", first_charge_at: null, first_charge_twd: 888, source: "card" } } }), PV);
    const wal = P.p3AgentModel(Q({ trial: nt, has_card: true, card_last4: "4242", balance_twd: 2000, agent_offer: { kind: "pay", monthly: { today_twd: 888, today_is: "charge", first_charge_at: null, first_charge_twd: 888, source: "wallet" } } }), PV);
    ok("② 已綁卡:框就是確認框;來源照 quote 那一格(卡 / 錢包),末四碼照 quote", card.kind === "pay" && card.src === "card" && card.last4 === "4242" && wal.src === "wallet"); }
  ok("② 方案有效或試用中:不賣第二次(active)", P.p3AgentModel(Q({ agent_offer: { kind: "active", monthly: { today_twd: 0, today_is: "charge", first_charge_at: null, first_charge_twd: 888, source: "card" } } }), PV).kind === "active");
  ok("② 有卡也有試用資格(quote 說 eligible 但 has_card):不走試用綁卡", P.p3AgentModel(Q({ has_card: true, agent_offer: { kind: "pay", monthly: { today_twd: 888, today_is: "charge", first_charge_at: null, first_charge_twd: 888, source: "card" } } }), PV).kind === "pay");
  { const so = (o) => Object.assign({ source: "newebpay", plan: "pro", auto_renew: true, expires_at: "2026-12-03T00:00:00Z" }, o);
    ok("② 重複付 Pro(第 13 步):網站／App Store／Google Play 各給取消去處;加密只講付到哪天;API 方案與沒訂閱不講;已關續訂只講付到哪天",
      P.p3ProLine(so()).go === "web" && P.p3ProLine(so({ source: "apple" })).go === "ios" && P.p3ProLine(so({ source: "google" })).go === "android"
      && P.p3ProLine(so({ source: "crypto" })).key === "p3.pro.paid" && P.p3ProLine(so({ plan: "api" })) === null && P.p3ProLine({ source: "none" }) === null
      && P.p3ProLine(so({ auto_renew: false })).key === "p3.pro.paid" && P.p3ProLine(so({ source: "other" })).go === null); }

  // ── ② 加購框 ──
  { const m = P.p3AddonModel(Q(), null, PV);
    ok("② 沒方案、沒卡:預設 Linux 基本,綁卡同時付合計 1,440(888＋552 兩行),主鈕綁卡並付", m.tier === "linux_starter" && m.route === "bind" && m.total === 1440 && m.lines.length === 2 && m.lines[0].twd === 888 && m.lines[1].twd === 552 && m.ok.key === "p3.h.okBind"); }
  { const q = Q({ has_card: true, card_last4: "4242", balance_twd: 2000, trial: { eligible: false, active: false, gen: "v3" },
      addon_offer: { kind: "pay", source: "wallet", tiers: rows((t, p) => cell(p, "full", p <= 2000 ? "wallet" : "card")) } });
    const a = P.p3AddonModel(q, "linux_starter", PV), b = P.p3AddonModel(q, "linux_premium", PV);
    ok("② 有卡、錢包 2,000:來源逐格判——Linux 基本 1,440 從錢包,Linux 進階 4,288 刷卡(不用 quote 頂層那一個)", a.src === "wallet" && b.src === "card" && a.route === "charge" && b.ok.key === "p3.h.okPay" && b.total === 4288); }
  { const q = Q({ has_card: true, trial: { eligible: false, active: false, gen: "v3" }, plan: { state: "active", paid_tier: "agent", cycle: "monthly", remaining_days: 18 },
      addon_offer: { kind: "prorated", source: "card", tiers: rows((t) => cell(Math.round(SIX[t] * 18 / 30), "prorated", "card", 888 + SIX[t])) } });
    const m = P.p3AddonModel(q, "linux_premium", PV);
    ok("② 方案有效(888 階)開主機:補差額 2,040,一行「這期剩 18 天」,主鈕補 N 開主機;下一期 4,288", m.total === 2040 && m.lines[0].key === "p3.s.hostLeft" && m.lines[0].vars.n === 18 && m.ok.key === "p3.h.okDiff" && m.where[0].vars.p === 4288); }
  { const q = Q({ has_card: true, trial: { eligible: false, active: false, gen: "v3" }, plan: { state: "active", paid_tier: "linux_starter", cycle: "monthly", remaining_days: 18 },
      addon_offer: { kind: "reopen", source: "free", tiers: rows((t) => (t === "linux_starter" ? cell(0, "reopen_free", "free") : cell(Math.round((SIX[t] - 552) * 18 / 30), "prorated", "card"))) } });
    const same = P.p3AddonModel(q, null, PV), up = P.p3AddonModel(Object.assign({}, q, { paid_launch_left_today: 0 }), "linux_max", PV), sameCap = P.p3AddonModel(Object.assign({}, q, { paid_launch_left_today: 0 }), null, PV);
    ok("② 這期付過 Linux 基本又開:預選它、0 元、主鈕開主機;只在合計表講一次「這期已付過」,框頂不另寫(設計稽核 M10)", same.tier === "linux_starter" && same.total === 0 && same.src === "free" && same.ok.key === "p3.h.okFree" && same.lines.length === 1 && same.lines[0].key === "p3.s.paidAlready" && !("lead" in same));
    ok("② 換更高階只補差額(差額那一行寫兩階)", P.p3AddonModel(q, "linux_max", PV).lines[0].key === "p3.s.diff" && !("lead" in P.p3AddonModel(q, "linux_max", PV)));
    ok("② 今天付費開機到上限:要付錢的格停用;重開不收錢的格不受上限", up.capped === true && sameCap.capped === false); }
  ok("② 今天剩幾次讀不到(null):不當成 0、不停用", P.p3AddonModel(Q({ paid_launch_left_today: null }), null, PV).capped === false);
  { const q = Q({ has_card: true, card_last4: "4242", trial: { eligible: false, active: true, gen: "v3", ends_at: "2026-11-30T14:00:00+08:00" }, plan: { state: "trial" },
      addon_offer: { kind: "trial_convert", source: "card", tiers: rows((t, p) => cell(p, "full", "card")) } });
    const m = P.p3AddonModel(q, "windows_starter", PV);
    ok("② v3 試用中開雲端:付第一期合計 3,988,框腳先講試用就此結束;Windows 帶那一句", m.total === 3988 && m.where[0].key === "p3.h.trialEnd" && m.winNote === true && m.route === "charge"); }
  { const q = Q({ has_card: true, trial: { eligible: false, active: true, gen: "v2" }, plan: { state: "trial" },
      addon_offer: { kind: "reopen", source: "free", tiers: [{ tier: "linux_starter", monthly: cell(0, "reopen_free", "free") }] } });
    const m = P.p3AddonModel(q, "windows_max", PV);
    ok("② 改價前開始的試用:quote 只給 Linux 基本,選別的也落回它;不收錢、講試用含主機", m.tier === "linux_starter" && J(m.avail) === '["linux_starter"]' && m.total === 0 && m.lines[0].key === "p3.s.trialIncl"); }
  { const q = Q({ has_card: false, balance_twd: 100, trial: { eligible: false, active: false, gen: "v3" }, plan: { state: "active", paid_tier: "agent", cycle: "monthly", remaining_days: 10 },
      addon_offer: { kind: "prorated", source: "none", tiers: rows((t) => cell(Math.round(SIX[t] / 3), "prorated", "none")) } });
    ok("② 方案有效(加密付的)、沒卡、錢包不夠:不能走綁卡付第一期,停在錢包不夠(主鈕停用)", P.p3AddonModel(q, null, PV).route === "short"); }
  { const q = Q({ has_card: true, trial: { eligible: false, active: false, gen: "v3" }, plan: { state: "active", paid_tier: "agent", cycle: "annual", remaining_days: 300 },
      addon_offer: { kind: "prorated", source: "card", tiers: Object.keys(SIX).map((t) => ({ tier: t, monthly: cell(1, "prorated", "card"), annual: cell(5444, "prorated", "card", 15504) })) } });
    const m = P.p3AddonModel(q, null, PV);
    ok("② 年繳方案開主機:讀年繳那一格、寫「付到年底」,框腳講每年", m.cycle === "annual" && m.total === 5444 && m.where[0].key === "p3.h.nextY" && m.lines[0].key === "p3.s.hostYear"); }
  ok("② 名下已有主機(addon_offer null)或 quote 沒給格子:不畫加購框", P.p3AddonModel(Q({ addon_offer: null }), null, PV) === null && P.p3AddonModel(Q({ addon_offer: { kind: "pay", tiers: [], source: "card" } }), null, PV) === null);
  ok("② 公開價目讀不到:不拆方案／主機兩行,只寫一筆合計", P.p3AddonModel(Q(), null, null).lines.length === 1 && P.p3AddonModel(Q(), null, null).lines[0].key === "p3.s.hostPlan");
  ok("② 付了主機還沒開(unlaunched_tier):預選那一階", P.p3AddonModel(Q({ plan: { state: "active", paid_tier: "linux_premium", cycle: "monthly", unlaunched_tier: "linux_premium" }, addon_offer: { kind: "reopen", source: "free", tiers: rows((t) => cell(0, "reopen_free", "free")) } }), null, PV).tier === "linux_premium");

  // ── ② 回程、30 TWD 卡、回合結束 ──
  ok("② 回程:pending 不換字;ok 分試用(可以開始了)與方案;failed 紅記號＋再試一次;wallet 講錢在錢包、refund_review 才講退款;unsettled 繼續等",
    P.p3ResultView({ status: "pending" }, "plan") === null && P.p3ResultView({ status: "ok" }, "trial").key === "acct.ready" && P.p3ResultView({ status: "ok" }, "plan").key === "p3.w.okPlan"
    && P.p3ResultView({ status: "failed" }, "trial").retry === true && P.p3ResultView({ status: "failed" }, "trial").calm === false
    && P.p3ResultView({ status: "wallet", amount_twd: 15504, refund_review: true }, "plan").refund === true && P.p3ResultView({ status: "wallet", amount_twd: 888, refund_review: false }, "plan").refund === false
    && P.p3ResultView({ status: "unsettled" }, "plan").wait === true);
  { const c = (o) => P.p3FreeCard(Object.assign({ eligible: true, hasBt: true, running: false, need: null }, o));
    ok("② 30 TWD 卡 C 版:有資格、有回測、沒在跑 → 〔看我的策略〕＋綁卡試用(不看資料需求)", J(c({})) === J({ paper: true, head: "paper", main: "see", second: "trial" }));
    ok("② 30 TWD 卡:已有策略在跑 → 不給看策略,主鈕綁卡試用;有回測的人不出〔改用 Claude Code 或 Codex〕(canon 11-17 晚)", J(c({ isRunning: true })) === J({ paper: false, head: "trial", main: "trial", second: null }));
    ok("② 30 TWD 卡:沒有回測 → 綁卡試用＋改用本機 AI", c({ hasBt: false }).main === "trial" && c({ hasBt: false }).second === "local");
    ok("② 30 TWD 卡:沒資格、策略不要資料 → 看我的策略＋開通方案", J(c({ eligible: false, need: false })) === J({ paper: true, head: "paper", main: "see", second: "plan" }));
    ok("② 30 TWD 卡:沒資格、策略要資料或判不出(None 當要) → 主鈕開通方案", c({ eligible: false, need: true }).main === "plan" && c({ eligible: false, need: null }).main === "plan" && c({ eligible: false, need: null }).head === "plan"); }
  // Wei 11-20(spec agent-888-vague-ai-credit §2):不再傳每期額度 per;下一格日期不靠它也要出
  { const said = new Set(), base = { said, hasCard: true, last4: "4242", low: 20, lo: 50, amt: 300, blocked: false };
    const up = P.p3TurnLines(Object.assign({}, base, { ai: { state: "used_up", kind: "period", slot_start: "S1", next_grant_at: "2026-12-04T00:00:00Z" }, topNew: { amount: 300 } }));
    ok("② 用完那一輪觸發了自動儲值:一行講改從錢包扣＋已自動儲值(過去式、卡號末四碼),附改用本機 AI", up.length === 1 && up[0].keys[1][0] === "p3.topped" && up[0].keys[1][1].l === "4242" && up[0].local === true);
    const up2 = P.p3TurnLines(Object.assign({}, base, { ai: { state: "used_up", kind: "period", slot_start: "S1", next_grant_at: "2026-12-04T00:00:00Z" }, topNew: null }));
    ok("② 用完、錢包還夠:第二句講下一格哪天重置(只帶 at、不帶每期額度;試用格不講)", up2[0].keys[1][0] === "p3.up.next" && JSON.stringify(Object.keys(up2[0].keys[1][1])) === '["at"]'
      && !/\d|TWD|\{n\}/.test(STR.zh["p3.up.next"].replace("{at}", "")) && !/\d|TWD|\{n\}/.test(STR.en["p3.up.next"].replace("{at}", "")) && P.p3TurnLines(Object.assign({}, base, { ai: { state: "used_up", kind: "trial", slot_start: "T", next_grant_at: null }, topNew: null }))[0].keys.length === 1);
    ok("② 同一格只講一次用完", P.p3TurnLines(Object.assign({}, base, { said: new Set(["up:S1"]), ai: { state: "used_up", kind: "period", slot_start: "S1" }, topNew: null })).length === 0);
    ok("② 用完講過了、之後又自動儲值:只講已自動儲值;沒有末四碼用沒卡號那句", (() => { const l = P.p3TurnLines(Object.assign({}, base, { said: new Set(["up:S1"]), last4: null, ai: { state: "used_up", kind: "period", slot_start: "S1" }, topNew: { amount: 300 } })); return l.length === 1 && l[0].keys[0][0] === "p3.toppedNoCard"; })());
    const low = P.p3TurnLines(Object.assign({}, base, { ai: { state: "low", kind: "period", slot_start: "S1" }, topNew: null }));
    ok("② 快用完(門檻讀 api 20):有卡講低於 50 自動儲值 300;方案戶的下一格日期併進第一句(只寫日期、不寫第二個 300、整段兩句,設計稽核 M5);沒卡只講從錢包扣;沒有關閉鈕", low[0].keys[0][0] === "p3.low" && low[0].keys[0][1] == null && ["p3.low", "p3.lowReset"].every((k) => !/\d|TWD|\{n\}/.test(STR.zh[k].replace("{at}", "")) && !/\d|TWD|\{n\}/.test(STR.en[k].replace("{at}", "")))
      && P.p3TurnLines(Object.assign({}, base, { low: null, ai: { state: "low", kind: "period", slot_start: "S9" }, topNew: null })).length === 0   // 門檻照舊由 api 給的 low 判:沒有門檻不講
      && low[0].keys[1][0] === "p3.low.then" && !low[0].local && !low[0].cta
      && (() => { const k = P.p3TurnLines(Object.assign({}, base, { ai: { state: "low", kind: "period", slot_start: "S2", next_grant_at: "2026-12-04T00:00:00Z" }, topNew: null }))[0].keys; return k.length === 2 && k[0][0] === "p3.lowReset" && !("n" in (k[1][1] || {})) && !/300/.test(STR.zh["p3.lowReset"]); })()
      && P.p3TurnLines(Object.assign({}, base, { ai: { state: "low", kind: "trial", slot_start: "T2", next_grant_at: null }, topNew: null }))[0].keys.length === 2
      && P.p3TurnLines(Object.assign({}, base, { hasCard: false, ai: { state: "low", kind: "trial", slot_start: "T" }, topNew: null }))[0].keys[1][0] === "p3.low.thenNoCard");
    { const lowK = (o) => P.p3TurnLines(Object.assign({}, base, { ai: { state: "low", kind: "trial", slot_start: "T3" }, topNew: null }, o))[0].keys[1][0];
      ok("② 快用完、account_status.auto_topup:true → 低於 50 自動儲值 300;false → 只講從錢包扣(有卡也一樣);null 與缺 → 照有沒有卡",
        lowK({ autoTopup: true }) === "p3.low.then" && lowK({ autoTopup: false }) === "p3.low.thenNoCard" && lowK({ autoTopup: null }) === "p3.low.then" && lowK({}) === "p3.low.then"
        && lowK({ autoTopup: null, hasCard: false }) === "p3.low.thenNoCard" && lowK({ autoTopup: true, hasCard: false }) === "p3.low.then"); }
    ok("② 登入送的 30 剩不到 10:一行＋安靜的文字鈕,只講一次;0 與 ≥10 不講", P.p3TurnLines(Object.assign({}, base, { ai: null, free: 6.2, topNew: null }))[0].cta === true
      && P.p3TurnLines(Object.assign({}, base, { ai: null, free: 6.2, said: new Set(["free"]), topNew: null })).length === 0 && P.p3TurnLines(Object.assign({}, base, { ai: null, free: 0 })).length === 0 && P.p3TurnLines(Object.assign({}, base, { ai: null, free: 10 })).length === 0);
    ok("② 這一輪被 402 擋了:不疊額度那幾行(那張卡已經講了)", P.p3TurnLines(Object.assign({}, base, { blocked: true, ai: { state: "used_up", slot_start: "S9" }, topNew: { amount: 300 } })).length === 0); }

  // ── ③ 接線 ──

  { // 稽核 B2／B6／B7:沒試用資格那一格講 bind_pay 那一筆;逾時也作廢快取;下一期讀不到不退 888
    const cut = (name) => { const i = app.indexOf("function " + name + "("); let d = 0; for (let k = app.indexOf("{", i); k < app.length; k++) { if (app[k] === "{") d++; else if (app[k] === "}" && --d === 0) return app.slice(i, k + 1); } };
    const run = (live, v) => new Function("p3Live", "t", "pvK", "pvPriced", "v", cut("pvCardFoot") + "\nreturn pvCardFoot('noTrial', v);")(() => live, (k, x) => k + J(x), (k) => k + ".m", () => true, v);
    ok("⑤ B2 v3、沒試用資格:底列講「綁卡就付第一期 888」(讀報價),不印舊的「最少儲值」;讀不到價就不寫;v3 關照舊", /^pv\.f\.noTrial\.v3\{/.test(run(true, { p: "888", pd: "30", b: "300" })) && /"p":"888"/.test(run(true, { p: "888", pd: "30", b: "300" }))
      && run(true, { p: "", pd: "30", b: "300" }) === "" && /^pv\.f\.noTrial\{/.test(run(false, { p: "1,440", b: "300" })) && /wait: \(typeof p3Live === "function" && p3Live\(\)\) \? "" : t\(pvK\("pv\.w\.noTrial"\)\)/.test(app));
    ok("⑤ B7 v3 下一期只認 next_charge_twd,讀不到不寫(不退回開通價)", /: v3 \? num\(pl\.next_charge_twd\) :/.test(app));
    ok("⑤ B6 加購／開通的請求送出去就作廢帳號狀態與錢包快取(含逾時 status 0)", (read(path.join(SHELL, "planv3.js")).match(/\n    money\(\);/g) || []).length === 2 && !/if \(r\.status !== 0\) money\(\)/.test(read(path.join(SHELL, "planv3.js")))); }

  { // v3 登入者的價只讀報價(33525 試辦:public_tiers 仍是舊價、data_paths 是 1,440)。把 app.js 的 planVars／pvCardFoot 切出來跑
    const cut = (name) => { const i = app.indexOf("function " + name + "("); let d = 0; for (let k = app.indexOf("{", i); k < app.length; k++) { if (app[k] === "{") d++; else if (app[k] === "}" && --d === 0) return app.slice(i, k + 1); } };
    const mk = (live, q, pubPlan) => {
      const ctx = { acct: { plan: { state: "none", tier: "linux_starter", monthly: 1440, annual: 15504 }, data_paths: { cloud_plan_monthly_from: 1440, cloud_plan_annual_from: 15504 }, starter_monthly: 1440,
          verify_amount: 10, trial_days: 14, trial_ai_credit: 150, auto_topup_min: 50, auto_topup_amount: 300 },
        pub: { starter_monthly: 1440, starter_annual: 15504, trial: { days: 14 }, plan: Object.assign({ period_days: 30, annual_period_days: 365, annual_pay_months: 10 }, pubPlan || {}) },
        P3: { q }, cur: "blave", MP: {}, LANG: "zh" };
      const sb = Object.assign({ t: (k, v) => k + (v ? J(v) : ""), planDate: (x) => x, planTierLabel: () => "", planMo: () => true, p3Live: () => live, p3Prices: P.p3Prices, raw: null }, ctx);
      vm.createContext(sb); vm.runInContext(cut("planVars") + "\n" + cut("pvCardFoot") + "\nvar pvK = (k) => k + '.m'; var pvPriced = (k, v) => !!v.p && !!v.pd;", sb);
      return sb;
    };
    const quoteNow = Q();   // 有試用資格:第一期 888、今天驗證 10
    const a = mk(true, quoteNow, { v3_active: false, v3: null }), va = a.planVars(), foot = a.pvCardFoot("offer", va);
    ok("③ v3 開、public_tiers 仍是舊價:開通價 888(讀報價),試用那一格的扣款句是 v3 那句、寫 888 不寫 1,440", va.p === "888" && va.pr === 888 && /^pv\.f\.offer\.v3\{/.test(foot) && /"p":"888"/.test(foot) && !/1,440|1440/.test(foot + J(va)));
    const b = mk(true, null, { v3_active: false, v3: null }), vb = b.planVars();
    ok("③ v3 開、報價拿不到、公開價目也沒有 v3:不寫價(扣款句不出、開通價空),不退回 1,440", vb.p === "" && vb.pr === null && b.pvCardFoot("offer", vb) === "" && !/1,440/.test(J(vb)));
    const c = mk(true, null, { v3_active: true, v3: PV }), vc = c.planVars();
    ok("③ v3 開、報價拿不到、公開價目有 v3:退用公開價目的 888", vc.p === "888" && vc.y === "8,880");
    const d = mk(false, quoteNow, { v3_active: false }), vd = d.planVars();
    ok("③ v3 關:照舊讀 data_paths 的 1,440 與舊的扣款句", vd.p === "1,440" && /^pv\.f\.offer\.m/.test(d.pvCardFoot("offer", vd)));
    ok("③ v3 開:試用那一格的主鈕是〔綁卡試用 14 天〕(關著照舊〔前往綁卡〕);開通鈕不必等這一格有價", /typeof p3Live === "function" && p3Live\(\) \? \(v\.t \? p3T\("p3\.a\.okTrial", \{ t: v\.t \}\) : t\("p3\.a\.okTrialNoNum"\)\) : t\("plan\.addCard"\)/.test(app)
      && /const planPriceOk = \(v\) => \(\(typeof p3Live === "function" && p3Live\(\)\) \|\|/.test(app));
    ok("③ p3Prices:報價優先;沒報價退公開價目 v3;都沒有全 null", J(P.p3Prices(quoteNow, null)) === '{"monthly":888,"annual":8880,"verify":10}' && P.p3Prices(null, PV).monthly === 888 && J(P.p3Prices(null, null)) === '{"monthly":null,"annual":null,"verify":null}'); }

  { // 設定 › 帳號與方案「資料已含」那一格(設計 v3-included-state-2026-11-19):v3 開/關 × 有/沒有試用資格。把那一格的運算式切出來在假的 btn 上跑
    const i0 = app.indexOf("    included: mo && "), i1 = app.indexOf("\n    // 切換前:沒有主機", i0);
    const expr = app.slice(i0, i1).replace(/^\s*included:\s*/, "").replace(/,\s*$/, "");
    const run = (live, a, mo) => new Function("mo", "p3Live", "acct", "acctOffer", "t", "p3T", "btn", "bindGo", "cloudWebGo", "return (" + expr + ");")(
      mo !== false, () => live, a, (x) => x.has_card === false && x.trial_eligible === true, (k) => k, (k, v) => k + J(v), (cls, label, on) => ({ cls, label, on: String(on) }), () => {}, () => {});
    const elig = { has_card: false, trial_eligible: true, trial_days: 14 }, noElig = { has_card: true, trial_eligible: true, trial_days: 14 };
    const on = run(true, elig), on2 = run(true, noElig), on3 = run(true, { has_card: false, trial_eligible: true }), off = run(false, elig);
    ok("③ included v3 開、有試用資格:說明 pv.d.included.v3;〔綁卡試用 14 天〕(btn-quiet、bindGo bind_set)在左,〔開雲端主機〕(p3.h.title、btn-out、cloudWebGo)在右",
      on.lead === "pv.d.included.v3" && on.acts.length === 2 && on.acts[0].cls === "btn-quiet" && on.acts[0].label === 'p3.a.okTrial{"t":14}' && /bindGo\("bind_set"\)/.test(on.acts[0].on)
      && on.acts[1].cls === "btn-out" && on.acts[1].label === "p3.h.title" && /cloudWebGo/.test(expr));
    ok("③ included v3 開、沒試用資格(有卡):只有〔開雲端主機〕;天數讀不到用 p3.a.okTrialNoNum", on2.acts.length === 1 && on2.acts[0].label === "p3.h.title" && on3.acts[0].label === "p3.a.okTrialNoNum");
    ok("③ included v3 關:照舊 pv.d.included.m＋〔到網站開雲端主機〕,沒有試用鈕;非方案制那一版照舊(lead pv.d.included、鈕 plan.start)", off.lead === "pv.d.included.m" && off.acts.length === 1 && off.acts[0].label === "plan.cloudWeb"
      && /: \{ (?:st: \["on", t\("pv\.st\.ok"\)\], )?h: "pv\.h\.ready", lead: t\("pv\.d\.included", v\), rule: t\("pv\.f\.plan", v\), acts: \[btn\("btn-out", t\("plan\.start"\), planAsk, !planPriceOk\(v\)\)\] \}$/.test(expr));
    ok("③ 「到網站開雲端主機」其他四處(試用中兩格、planOn、雲端分頁兩顆主鈕)v3 開著改說〔開雲端主機〕", (app.match(/t\(\(typeof p3Live === "function" && p3Live\(\)\) \? "p3\.h\.title" : "plan\.cloudWeb"\)/g) || []).length === 3
      && (read(path.join(R, "trade.js")).match(/t\(\(typeof p3Live === "function" && p3Live\(\)\) \? "p3\.h\.title" : "plan\.cloudWeb"\)/g) || []).length === 2
      && STR.zh["pv.d.included.v3"] === "策略要全天候自動執行，才需要雲端主機。" && !!STR.en["pv.d.included.v3"]); }
  ok("③ IPC:六支都走 handle(只收自家畫面),preload 只露出這幾支", ["plan3-quote", "plan3-bind-trial", "plan3-bind-pay", "plan3-addon", "plan3-agent-start", "plan3-bind-result", "plan3-bind-drop", "strategy-data-need"].every((c) => new RegExp('handle\\("' + c + '"').test(mainSrc) && pre.includes('"' + c + '"')));
  ok("③ 付款頁沿用策略庫那條(libPayForm 驗網域 / libPayOpen 本機一次性頁),主行程不另寫一份", /payForm: libPayForm, payOpen: libPayOpen/.test(mainSrc));
  ok("③ /plan/start 新外殼:付款框送 plan_tier agent;舊的 planStartBody 不帶(v3 關著時行為照舊)", /plan_tier: "agent"/.test(read(path.join(SHELL, "planv3.js"))) && !/plan_tier/.test(mainSrc.slice(mainSrc.indexOf("function planStartBody"), mainSrc.indexOf("function planStartResult"))));
  ok("③ 舊外殼 409 TRIAL_NO_SERVER:planStartResult 回錯誤、不自動重送(不在 PLAN_ERR 表上 → SERVER)", (() => { const s = mainSrc.slice(mainSrc.indexOf("const PLAN_CYCLES"), mainSrc.indexOf("async function planStart(")); const f = new Function(s + "\nreturn planStartResult;")(); return J(f({ status: 409, body: { error_code: "TRIAL_NO_SERVER" } })) === '{"error":"SERVER"}'; })());
  { // bindGo:v3 關 → 照舊外開;開 → 框(雲端那顆開加購框);topup_* 永遠外開
    const bg = /function bindGo\(name\) \{[^\n]*\}/.exec(app)[0], route = /function p3Route\(name\) \{[\s\S]*?\n\}/.exec(src)[0];
    const run = (live, name) => { const calls = []; new Function("window", "acctUrl", "p3Live", "p3OpenAddon", "p3OpenAgent", route + "\n" + bg + "\nbindGo(" + J(name) + ");")(
      { blave: { trackFeature: (n) => calls.push("t:" + n), openExternal: (u) => calls.push("o:" + u) } }, () => "U", () => live, () => calls.push("addon"), () => calls.push("agent")); return calls.join(); };
    ok("③ bindGo:v3 關著照舊外開綁卡頁;開著 bind_* 開框(bind_cloud 開加購框)、topup_* 照舊外開;都先記埋點",
      run(false, "bind_set") === "t:bind_set,o:U" && run(true, "bind_set") === "t:bind_set,agent" && run(true, "bind_cloud") === "t:bind_cloud,addon" && run(true, "topup_set") === "t:topup_set,o:U"); }
  ok("③ 方案頁「開通方案」(planAsk)、側欄「升級」、資料牆「看方案」、雲端「開雲端主機」(cloudWebGo):v3 開著才改走框,都先問 p3Live",
    /function planAsk\(e, repriced\) \{\n\s*if \(typeof p3Live === "function" && p3Live\(\)\) \{ p3OpenAgent\(e && e\.currentTarget, null, "set"\)/.test(app) && /trackFeature\("plan_side"\); if \(typeof p3Live === "function" && p3Live\(\)\) p3OpenAgent\(\$\("side-cv"\), null, "side"\)/.test(app)
    && /trackFeature\(ev \? "plan_event" : "plan_data"\); if \(typeof p3Live === "function" && p3Live\(\)\) p3OpenAgent\(null, null, "data"\); else planOpen\(\);/.test(app)
    && /function cloudWebGo\(\) \{ trackFeature\("cloud_open_web"\); if \(typeof p3Live === "function" && p3Live\(\)\) \{ p3OpenAddon\(null, undefined, undefined, "cloud"\); return; \}/.test(app));
  ok("③ 30 TWD 卡:只有 v3 開著才換 C 版,關著照舊那張卡", (app.match(/else if \(free && typeof p3Live === "function" && p3Live\(\)\) p3FreeCardPaint\(/g) || []).length === 2);
  ok("③ 30 TWD 卡的鈕記既有的綁卡漏斗(acct_card_click),〔看我的策略〕只導頁不代填不代啟動", /on: \(\) => \{ acctClicked\(where, s\); p3OpenAgent\(null, null, "free"\); \}/.test(src) && /on: \(\) => \{ trackEvent\("acct_card_alt_click", \{ card: where === "pre" \? "pre_free" : "turn_free" \}\); stratSelect\(bt\.name\); \}/.test(src));
  ok("③ 設定頁自動儲值(收進「Blave 餘額」的 tooltip,spec host-card-relayout D1):auto_topup 是 false 才不出,缺或 null 照有卡判;p3PlanRows 不再另出一行;回合結束把 acct.auto_topup 傳進去",
    /if \(!acctNoCard\(acct\) && !\(acct && acct\.auto_topup === false\) && ac\.auto_topup_min && ac\.auto_topup_amount\) txt \+=/.test((src.match(/function p3BalLabel[\s\S]*?\n\}/) || [""])[0])
    && !/p3TopupLine|auto_topup/.test((src.match(/function p3PlanRows[\s\S]*?\n\}/) || [""])[0]) && /autoTopup: acct \? acct\.auto_topup : undefined/.test(src));
  ok("③ 自動儲值告知:第一次讀只記基準,at 變了、30 分鐘內才講", /const topNew = seen !== undefined && top && top\.at !== seen && Date\.now\(\) - Date\.parse\(top\.at\) < 30 \* 60 \* 1000 \? top : null;/.test(src));
  ok("③ 一鍵扣款時框鎖住(不能關框重按)、送出的來源是那一格的", /sc\.dataset\.lock = "1"/.test(src) && /plan3Addon\(\{ tier: m\.tier, cycle: m\.cycle, confirm: m\.total, source: m\.src \}\)/.test(src));
  ok("③ 扣了錢主機沒開成:不講付款失敗,講已扣與這期重開不另收費", /if \(b\.charged_twd > 0\) \{[^\n]*p3Unlaunched\(null, b\.charged_twd\)/.test(src));
  ok("③ 付款框文案不寫卡別、不叫人關自動儲值", Object.keys(STR.zh).filter((k) => /^p3\./.test(k)).every((k) => !/Visa|Master|JCB|關閉|關掉/.test(STR.zh[k]) && !/Visa|turn off/i.test(STR.en[k])));
  ok("③ 每個 p3.* 字串兩語都有", Object.keys(STR.zh).filter((k) => /^p3\./.test(k)).every((k) => typeof STR.en[k] === "string" && STR.en[k]) && Object.keys(STR.en).filter((k) => /^p3\./.test(k)).every((k) => k in STR.zh));
  { const dyn = ["p3.tier.linux_starter", "p3.tier.windows_max", "p3.h.starter", "p3.h.premium", "p3.h.max", "p3.pro.web", "p3.pro.ios", "p3.pro.android", "p3.toppedNoCard"];
    const lit = [...new Set([...src.matchAll(/"(p3\.[A-Za-z.]+)"/g)].map((m) => m[1]))].filter((k) => !/\.$/.test(k) && k !== "p3.said");
    const miss = lit.concat(dyn).filter((k) => !(k in STR.zh));
    ok("③ planv3.js 用到的字串 key 都在字典裡(含組出來的階名、規格、取消去處)", miss.length === 0, miss.join()); }


  // ── ④ 流程(整支 planv3.js 跑在假的 DOM／IPC 上):連點只送一次、409 重開不再送、扣了錢沒開成不講付款失敗、回程 ok 只開一次機、錯誤後主鈕字換回來 ──
  {
    const mkEl = (tag) => { const e = { tag, children: [], dataset: {}, attrs: {}, style: {}, className: "", textContent: "", hidden: false, disabled: false, title: "", el: null,
      classList: { add() {}, remove() {}, toggle() {} }, append(...k) { k.forEach((x) => { if (x && typeof x === "object") this.children.push(x); else this.textContent += String(x); }); },
      appendChild(x) { this.children.push(x); return x; }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(ev, f) { (this.on = this.on || {})[ev] = f; }, click() { return this.on && this.on.click && this.on.click(); }, remove() { this.removed = true; },
      querySelectorAll() { return []; }, querySelector() { return null; }, focus() {} }; return e; };
    const ids = {}; const $ = (id) => (ids[id] = ids[id] || mkEl("div"));
    const calls = [], cards = [], boxes = [], evs = [];
    let quoteReply = null, startReply = null, addonReply = null, resultReply = null, startWait = null, addonWait = null;
    const walk = (n, f, out = []) => { if (!n || typeof n !== "object") return out; if (f(n)) out.push(n); (n.children || []).forEach((c) => walk(c, f, out)); return out; };
    const C = { console, Promise, Date, JSON, Math, Object, Array, Set, Number, String, isNaN, setTimeout: () => 1, clearTimeout: () => {}, LANG: "zh", hasToken: true, cur: "blave",
      acct: { v3_active: true }, pub: { plan: { v3_active: true, v3: PV } }, $, t: (k, v) => k + (v ? J(v) : ""), planDate: (x) => String(x).slice(5, 10),
      document: { createElement: mkEl, createDocumentFragment: () => mkEl("frag"), querySelector: () => null, querySelectorAll: () => [] },
      localStorage: { getItem: () => null, setItem() {} },
      confirmBox: (o) => boxes.push(o), delClose: () => calls.push("close"), delOkBusy: () => {}, srSay: () => {},
      faultCard: () => { const c = { el: mkEl("div"), b1: mkEl("button"), last: null, set(x) { this.last = x; } }; cards.push(c); return c; },
      sysLz: (fn) => fn(), trackFeature: (n) => calls.push("t:" + n), trackEvent: (ev, pr) => evs.push(ev + ":" + J(pr || {})), acctCheck: () => calls.push("acctCheck"), planPaint: () => {}, sidePaint: () => {},
      planOpen: () => calls.push("planOpen"), pubLoad: async () => {}, planSignIn: async () => ({ ok: false }), acctUrl: () => "U", planPayUrl: () => "P",
      // 加密付款的網址用 app.js 的真函式(Wei 實測:舊版開的是 planPayUrl,網頁把 from=desktop 換成綁卡頁)
      planCryptoUrl: new Function("LANG", "return " + (app.match(/^const planCryptoUrl = (\(o\) => [^;]*);/m) || [])[1] + ";")("zh"),
      window: { addEventListener() {}, blave: {
        plan3Quote: async () => { calls.push("quote"); return quoteReply; },
        plan3AgentStart: async (o) => { calls.push("start:" + J(o)); if (startWait) await startWait; return startReply; },
        plan3Addon: async (o) => { calls.push("addon:" + J(o)); if (addonWait) await addonWait; return addonReply; },
        plan3BindPay: async (o) => { calls.push("bindPay:" + J(o)); return { status: 200, opened: true }; },
        plan3BindTrial: async (o) => { calls.push("bindTrial:" + J(o)); return { status: 200, opened: true }; },
        plan3BindResult: async () => { calls.push("result"); await null; return resultReply; },
        plan3BindDrop: () => calls.push("drop"), openExternal: (u) => calls.push("open:" + u), balance: async () => null } } };
    vm.createContext(C); vm.runInContext(src.replace(/^const /gm, "var "), C);
    const reset = () => { calls.length = 0; cards.length = 0; boxes.length = 0; C.P3.busy = false; C.P3.wait = null; };
    const nt = { eligible: false, active: false, gen: "v3", ends_at: null, cancel_at_end: false };
    const payQ = Q({ trial: nt, has_card: true, card_last4: "4242", agent_offer: { kind: "pay", monthly: { today_twd: 888, today_is: "charge", first_charge_at: null, first_charge_twd: 888, source: "card" } } });
    const m = C.p3AgentModel(payQ, PV);

    reset(); let release; startWait = new Promise((r) => { release = r; }); startReply = { status: 200, body: { state: "none" } };
    const a1 = C.p3AgentGo(m, null, false), a2 = C.p3AgentGo(m, null, false); release(); await a1; await a2; startWait = null;
    ok("④ 一鍵開通連點兩下:只送一次 /plan/start(plan_tier agent、確認 888、來源 card)", calls.filter((c) => c.startsWith("start:")).length === 1 && calls.includes('start:{"cycle":"monthly","confirm":888,"source":"card","wallet":false}') && calls.includes("t:plan_monthly"));

    reset(); startReply = { status: 409, body: { error_code: "PLAN_CONFIRM_REQUIRED", source: "card" } }; quoteReply = { status: 200, body: payQ };
    await C.p3AgentGo(m, null, false); await new Promise((r) => setImmediate(r));
    ok("④ 409 改價:用伺服器現價重開同一個框(頂上帶「價格剛更新」),不自動再送", calls.filter((c) => c.startsWith("start:")).length === 1 && calls.includes("quote") && boxes.length === 1 && boxes[0].ok === 'p3.a.okPay{"p":"888"}');

    reset(); C.$("del-ok").textContent = "p3.a.okPay"; startReply = { status: 402, body: { error_code: "PLAN_CHARGE_FAILED" } };
    await C.p3AgentGo(m, null, false);
    ok("④ 扣款被拒:框不關、錯誤句在框裡、主鈕字換回「付 N」(不留「付款中…」)", !calls.includes("close") && C.$("del-ok").textContent === "p3.a.okPay");

    const am = C.p3AddonModel(Q({ has_card: true, card_last4: "4242", trial: nt, addon_offer: { kind: "pay", source: "card", tiers: rows((t, p) => cell(p, "full", "card")) } }), null, PV);
    reset(); addonReply = { status: 502, body: { error_code: "LAUNCH_FAILED", charged_twd: 1440 } };
    await C.p3AddonGo(am, null);
    ok("④ 扣了錢、主機沒開成:講已扣與這期重開不另收費(灰字以外的錯誤句不出),附〔開主機〕", cards.length === 1 && /^p3\.err\.paidNoServer/.test(cards[0].last.text) && cards[0].last.label === "p3.h.okFree" && calls.includes("close"));

    reset(); addonReply = { status: 200, body: { state: "starting" } };
    await C.p3AddonGo(am, null);
    ok("④ 框內開主機成功:送那一格的 tier／金額／來源,一行「開機中」,方案狀態改成啟動中", calls.includes('addon:{"tier":"linux_starter","cycle":"monthly","confirm":1440,"source":"card"}') && /env\.empty\.starting/.test(cards[0].last.text) && C.acct.plan.state === "starting");

    reset(); C.P3.wait = { kind: "plan", tier: "linux_starter", at: Date.now(), card: C.faultCard() }; cards.length = 0;
    resultReply = { mark: { kind: "plan", tier: "linux_starter", at: Date.now() }, res: { kind: "plan", status: "ok", amount_twd: 1440 } }; addonReply = { status: 200, body: { state: "starting" } };
    await Promise.all([C.p3Poll(), C.p3Poll()]); await new Promise((r) => setImmediate(r));
    ok("④ 綁卡付了主機階、回程 ok(回前景與計時器同時查):只開一次機,而且是 0 元、來源 free", calls.filter((c) => c === "result").length === 1 && calls.filter((c) => c.startsWith("addon:")).length === 1 && calls.includes('addon:{"tier":"linux_starter","confirm":0,"source":"free"}'));

    reset(); const wc = C.faultCard(); C.P3.wait = { kind: "trial", tier: "agent", at: Date.now(), card: wc };
    resultReply = { mark: { kind: "trial", tier: "agent", at: Date.now() }, res: { kind: "trial", status: "failed" } };
    await C.p3Poll();
    ok("④ 回程失敗:那一行換紅記號「沒有扣款」＋再試一次,不開機", wc.last.calm === false && /^p3\.w\.failTrial/.test(wc.last.text) && wc.last.label === "p3.w.retry" && !calls.some((c) => c.startsWith("addon:")));

    reset(); const wc2 = C.faultCard(); C.P3.wait = { kind: "plan", tier: "agent", at: Date.now(), card: wc2 };
    resultReply = { mark: null, res: null };
    await C.p3Poll();
    ok("④ 記號沒了(過期／別處收掉):等待那一行收掉,不留著轉", wc2.el.removed === true && C.P3.wait === null);

    // ── P7 自動接著跑、P6 取消 Pro 的去處、P4 群益預選 Windows(Wei 11-17)──
    let resends = 0; C.resendLast = () => { resends++; return Promise.resolve(true); }; C.canResend = () => true; C.hasData = () => true;
    const go7 = async (o) => {
      reset(); resends = 0; C.creditCards = o.credit ? [{}] : []; C.dataCard = null; C.lastUserText = "幫我回測"; C.turnSeqMine = 3; C.acct = { v3_active: true, can_run: true };
      quoteReply = { status: 200, body: payQ }; startReply = { status: 200, body: { state: "none" } };
      await C.p3OpenAgent(null);
      if (o.after) o.after();
      await C.p3AgentGo(m, null, false); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
      return resends;
    };
    ok("④ P7:被 402 切斷的那一輪,一鍵付好了自動重跑一次", await go7({ credit: true }) === 1);
    ok("④ P7:不是從被切斷的回合來的(沒有額度卡、沒有資料卡)不重跑", await go7({ credit: false }) === 0);
    ok("④ P7:那條之後又送了別句(最後那句或輪次變了)不重跑", await go7({ credit: true, after: () => { C.lastUserText = "別的"; } }) === 0 && await go7({ credit: true, after: () => { C.turnSeqMine = 4; } }) === 0);
    ok("④ P7:付好了但帳號還不能跑(api 還沒反映)不重跑", await go7({ credit: true, after: () => { C.acct = { v3_active: true, can_run: false }; C.acctCheck = () => calls.push("acctCheck"); } }) === 0);
    C.acct = { v3_active: true, can_run: true };
    { reset(); resends = 0; C.creditCards = [{}]; C.lastUserText = "x"; C.turnSeqMine = 1; quoteReply = { status: 200, body: payQ }; await C.p3OpenAgent(null);
      const wc3 = C.faultCard(); C.P3.wait = { kind: "plan", tier: "agent", at: Date.now(), card: wc3 };
      resultReply = { mark: { kind: "plan", tier: "agent", at: Date.now() }, res: { kind: "plan", status: "wallet", amount_twd: 888 } };
      await C.p3Poll(); await new Promise((r) => setImmediate(r));
      ok("④ P7:刷了錢方案沒開成(wallet)不重跑;記號仍在等的那一張下次 ok 才跑、只跑一次", resends === 0 && C.P3.resume !== null);
      const wc4 = C.faultCard(); C.P3.wait = { kind: "plan", tier: "agent", at: Date.now(), card: wc4 };
      resultReply = { mark: { kind: "plan", tier: "agent", at: Date.now() }, res: { kind: "plan", status: "ok" } };
      await C.p3Poll(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
      const once = resends;
      C.P3.wait = { kind: "plan", tier: "agent", at: Date.now(), card: C.faultCard() }; await C.p3Poll(); await new Promise((r) => setImmediate(r));
      ok("④ P7:回程 ok 重跑一次,之後再一個 ok 不再跑", once === 1 && resends === 1); }
    { // 11-20 試用綁卡誤報「已刷 888」:試用單沒開成講卡用過試用,金額用記號的驗證金,不讀 api 的 amount_twd(舊 api 放的是到期那一期)
      reset(); evs.length = 0; const wt = C.faultCard(); C.P3.wait = { kind: "trial", tier: "agent", at: Date.now(), card: wt };
      resultReply = { mark: { kind: "trial", tier: "agent", at: Date.now(), pay: 10 }, res: { kind: "trial", status: "wallet", amount_twd: 888 } };
      await C.p3Poll(); await new Promise((r) => setImmediate(r));
      const tx = (wt.last && wt.last.text) || "";
      ok("④ 試用綁卡回 wallet(舊 api 帶 888):講「這張卡用過試用」＋記號的 10,不出 888、不出付費那句、不出退款句",
        /^p3\.w\.trialCardUsed\{"v":"?10"?\}$/.test(tx) && !/888|p3\.w\.wallet|p3\.w\.refund/.test(tx), tx);
      ok("④ 試用綁卡 wallet:埋點記 trial_wallet(不跟付費單的 wallet 混);卡上一顆〔看方案〕開 888 方案框(from retry)",
        evs.includes('plan_bind_res:{"step":"trial_wallet"}') && !evs.includes('plan_bind_res:{"step":"wallet"}') && wt.last.label === "data.seePlan" && typeof wt.last.on === "function"
        && /else if \(v\.plan\) w\.card\.set\(sysLz\(\(\) => \(\{ calm: v\.calm, text: text\(\), label: t\("data\.seePlan"\), on: \(\) => p3OpenAgent\(w\.card\.b1, null, "retry"\) \}\)\)\);/.test(src));
      ok("④ TRIAL_NOT_ELIGIBLE 那句不寫「再」(沒試用過、付過方案或有大主機的人也是這個碼)", /不符合試用資格/.test(STR.zh["p3.w.trialNoElig"]) && !/再/.test(STR.zh["p3.w.trialNoElig"] + STR.zh["p3.w.trialNoEligNoNum"])
        && /isn't eligible for a trial/.test(STR.en["p3.w.trialNoElig"]));
      const R = (res, pay) => C.p3ResultView(Object.assign({ status: "wallet" }, res), "trial", pay);
      ok("④ 試用綁卡 wallet:記號沒金額 → 不帶數字那句;原因碼 TRIAL_NOT_ELIGIBLE → 帳號那句;付費單照舊",
        R({ amount_twd: 888 }, null).key === "p3.w.trialCardUsedNoNum" && !R({ amount_twd: 888 }, null).vars
        && R({ amount_twd: 10, reason_code: "TRIAL_NOT_ELIGIBLE" }, 10).key === "p3.w.trialNoElig" && R({ amount_twd: 888, refund_review: true }, 10).refund !== true
        && C.p3ResultView({ status: "wallet", amount_twd: 888 }, "plan").key === "p3.w.wallet");
      ok("④ 試用 wallet 四句與試用次數那句兩語都有;zh 不用分號;次數那句照 Wei 11-20 各表面同一句「每個帳號、每張卡都只能試用一次。」", ["p3.w.trialCardUsed", "p3.w.trialCardUsedNoNum", "p3.w.trialNoElig", "p3.w.trialNoEligNoNum", "p3.a.oncePerCard"]
        .every((k) => STR.zh[k] && STR.en[k] && !/；|;/.test(STR.zh[k] + STR.en[k])) && STR.zh["p3.a.oncePerCard"] === "每個帳號、每張卡都只能試用一次。" && STR.en["p3.a.oncePerCard"] === "One trial per account and per card."
        && !Object.values(STR.zh).some((v) => v === "每張卡限試用一次。"));
      ok("④ 主行程收 reason_code(只認兩個值)", M.resultBody({ bind: { kind: "trial", status: "wallet", amount_twd: 10, reason_code: "TRIAL_CARD_USED" } }).reason_code === "TRIAL_CARD_USED"
        && M.resultBody({ bind: { kind: "trial", status: "wallet", reason_code: "x; y" } }).reason_code === null); }
    { reset(); const proQ = Q({ trial: nt, has_card: true, card_last4: "4242", agent_offer: payQ.agent_offer, studio_subscription: { source: "apple", plan: "pro", auto_renew: true, expires_at: "2026-12-03T00:00:00Z" } });
      const pm = C.p3AgentModel(proQ, PV); startReply = { status: 200, body: { state: "none" } };
      await C.p3AgentGo(pm, null, false);
      ok("④ P6:付完那一句接「Pro 訂閱仍會扣款」＋〔到 App Store 取消〕;付款框裡不放取消鈕(只留主墨那句事實)", /p3\.pro\.dupAfter/.test(cards[cards.length - 1].last.text) && cards[cards.length - 1].last.label === "p3.pro.ios"
        && !/p3ProCancel/.test(/function p3AgentBox\(m, opener, note\) \{[\s\S]*?\n\}/.exec(src)[0])); }
    ok("④ P4:接了群益 → 加購框預選 Windows 基本;用戶點過的、這期付過的、還沒開的那一階照樣優先", P.p3AddonModel(Q(), null, PV, true).tier === "windows_starter" && P.p3AddonModel(Q(), null, PV, false).tier === "linux_starter"
      && P.p3AddonModel(Q(), "linux_max", PV, true).tier === "linux_max");

    // ── 設計稽核 11-17 必修(每條先寫成會紅的樣子再修)──
    { // M1 付款中框身鎖住:分段點不動、框不重畫、送的是按下那一刻的那一階;方案框的〔用加密貨幣轉帳〕付款中不外開
      const qA = Q({ has_card: true, card_last4: "4242", trial: nt, plan: { state: "active", paid_tier: "agent", cycle: "monthly", remaining_days: 18 },
        addon_offer: { kind: "prorated", source: "card", tiers: rows((t) => cell(Math.round(SIX[t] * 18 / 30), "prorated", "card", 888 + SIX[t])) } });
      reset(); C.P3.q = qA; C.P3.sel = null; C.p3AddonBox(null);
      const box = boxes[boxes.length - 1], segMax = walk(box.extra, (n) => n.dataset && n.dataset.t === "linux_max")[0];
      let rel; addonWait = new Promise((r) => { rel = r; }); addonReply = { status: 200, body: { state: "starting" } };
      const go = box.onOk(); await null;
      const lockedNow = C.$("del-body").inert === true, nBoxes = boxes.length;
      segMax.click();
      ok("④ M1 付款中:框身 inert、點分段不換階也不重畫框", lockedNow && boxes.length === nBoxes && C.P3.sel === null);
      rel(); await go; addonWait = null;
      ok("④ M1 送出的是按下那一刻的那一階(Linux 基本 331)、付完框身解鎖", calls.includes('addon:{"tier":"linux_starter","cycle":"monthly","confirm":331,"source":"card"}') && C.$("del-body").inert === false);
      reset(); const mB = C.p3AgentModel(payQ, PV); C.p3AgentBox(mB, null); const ab = boxes[boxes.length - 1], cryp = { click: () => ab.link.onClick() };
      let rel2; startWait = new Promise((r) => { rel2 = r; }); startReply = { status: 200, body: { state: "none" } };
      const go2 = ab.onOk(); await null; cryp.click(); rel2(); await go2; startWait = null;
      ok("④ M1 付款中按〔用加密貨幣轉帳〕不外開", !calls.some((c) => c.startsWith("open:")));
      // 〔用加密貨幣轉帳〕要開網頁的加密付款(買方案頁帶 pay=crypto),不是 usage?from=desktop(會被換成綁卡頁)
      reset(); C.p3AgentBox(C.p3AgentModel(payQ, PV), null); const cb = boxes[boxes.length - 1]; cb.link.onClick();
      const opened = calls.filter((c) => c.startsWith("open:"));
      // Agent 方案框(888)只買方案:帶 plan=agent(不帶的話網頁 v3 連雲端主機一起報價,稽核 0158),繳別是這一單的月繳
      ok("④ Agent 方案框〔用加密貨幣轉帳〕開 pay=crypto&plan=agent&cycle=monthly 的買方案頁,不是綁卡頁", cb.link.label === "p3.crypto" && opened.length === 1
        && opened[0] === "open:https://blave.org/agent/zh?pay=crypto&plan=agent&cycle=monthly" && !/usage\?from=desktop/.test(opened[0]), opened); }
    { const U = new Function("LANG", "return " + (app.match(/^const planCryptoUrl = (\(o\) => [^;]*);/m) || [])[1] + ";")("en");
      ok("④ 加購主機失敗卡的〔用加密貨幣轉帳〕不帶 plan=agent、繳別照這一單(年繳 annual);Agent 那條才帶",
        U({ agent: false, cycle: "annual" }) === "https://blave.org/agent/en?pay=crypto&cycle=annual" && U({ agent: false, cycle: "monthly" }) === "https://blave.org/agent/en?pay=crypto&cycle=monthly"
        && U({ agent: true, cycle: "monthly" }) === "https://blave.org/agent/en?pay=crypto&plan=agent&cycle=monthly"
        && /second: \{ label: t\("p3\.crypto"\), quiet: true, on: \(\) => \{ window\.blave\.openExternal\(planCryptoUrl\(\{ agent: !\(w\.tier && w\.tier !== "agent"\), cycle: w\.cycle \}\)\); \} \}/.test(src)); }
    ok("④ 每一處〔用加密貨幣轉帳〕(p3.crypto)都開 planCryptoUrl;planPayUrl 不再配加密的字",
      (src.match(/t\("p3\.crypto"\)[^\n]*openExternal\((\w+)\(/g) || []).length === 2 && (src.match(/t\("p3\.crypto"\)[^\n]*openExternal\((\w+)\(/g) || []).every((x) => /planCryptoUrl/.test(x))
      && !/t\("p3\.crypto"\)[^\n]*planPayUrl/.test(src) && /pay=crypto/.test((app.match(/^const planCryptoUrl = [^\n]*/m) || [""])[0]));
    { // M2 自動儲值那句看得見:觸發字是 .mp-tip 鈕,泡泡是相鄰的 .tip(只有泡泡本體叫 tip)
      const line = C.p3TopupLine(), w = line.children[0], trig = w && w.children[0], tip = w && w.children[1];
      ok("④ M2 自動儲值那句:句子在 .mp-tip 鈕上(不在 .tip 裡,.tip 是預設隱藏的泡泡本體),泡泡帶門檻、aria-describedby 綁住、不掛 aria-label",
        w.className === "p3-tipw" && trig.className === "mp-tip" && trig.textContent === "p3.topup" && tip.className === "tip" && /^p3\.topupTip/.test(tip.textContent)
        && trig.attrs["aria-describedby"] === tip.id && !!tip.id && !("aria-label" in trig.attrs) && walk(line, (n) => n.className === "tip" && n.textContent === "p3.topup").length === 0); }
    { // M3 〔重新打開付款頁〕:一個框、兩下;框的主鈕帶金額,按了就開新單
      reset(); const wc5 = C.faultCard(); C.P3.wait = { kind: "trial", tier: "agent", cycle: "monthly", confirm: 888, pay: 10, at: Date.now(), card: wc5 };
      C.p3Reopen(wc5.b1);
      const rb = boxes[boxes.length - 1];
      ok("④ M3 等待那一行〔重新打開付款頁〕:不重新報價、直接一個框,主鈕「開新付款頁,10 TWD」", boxes.length === 1 && !calls.includes("quote") && rb.ok === 'p3.w.reopenOk{"p":"10"}');
      await rb.onOk();
      ok("④ R4 那個框的內文是 p3 自己那一句(講「開新頁」,不講策略庫的「再試一次」);策略庫那條不動", J(rb.lines) === '["p3.w.openNote"]' && /開新頁/.test(STR.zh["p3.w.openNote"]) && !/再試一次/.test(STR.zh["p3.w.openNote"]) && /再試一次會開新頁/.test(STR.zh["lib.bb.open"]));
      ok("④ M3 按主鈕:帶 restart 開新單(確認的仍是 888)", calls.includes('bindTrial:{"cycle":"monthly","confirm":888,"pay":10,"lang":"zh","restart":true}')); }
    // 任務 4:已綁卡那一句,每個 src 各一句
    ok("④ 已綁卡那一句:free 是「這一期不收費」(不落到刷卡句)、wallet／card(有無末四碼)各自那句;加購框來源短句與框腳整句每個 src 一組",
      C.p3PaySentence("free", "4242")[0] === "p3.a.free" && C.p3PaySentence("wallet", "4242")[0] === "p3.a.todayWallet"
      && J(C.p3PaySentence("card", "4242")) === '["p3.a.todayCard",{"l":"4242"}]' && C.p3PaySentence("card", null)[0] === "p3.a.todayCardAny"
      && J(["wallet", "free", "card", "none"].map((x) => C.p3SrcKeys(x, "4242"))) === J([["p3.src.wallet", "p3.srcS.wallet"], ["p3.src.free", "p3.srcS.free"], ["p3.src.card", "p3.srcS.card"], ["p3.src.none", "p3.srcS.none"]])
      && C.p3SrcKeys("card", null)[1] === "p3.srcS.cardAny" && ["p3.a.free", "p3.srcS.free"].every((k) => STR.zh[k] && !/刷/.test(STR.zh[k])));
    { // M10 合計表只有一列:不畫明細,合計列寫那一列的說明,今天從哪扣進框腳第一句
      const qA = Q({ has_card: true, card_last4: "4242", trial: nt, plan: { state: "active", paid_tier: "agent", cycle: "monthly", remaining_days: 18 },
        addon_offer: { kind: "prorated", source: "card", tiers: rows((t) => cell(Math.round(SIX[t] * 18 / 30), "prorated", "card", 888 + SIX[t])) } });
      reset(); C.P3.q = qA; C.P3.sel = null; C.p3AddonBox(null);
      const bx = boxes[boxes.length - 1], rowsX = walk(bx.extra, (n) => /(^| )cf-row( |$)/.test(n.className || ""));
      ok("④ M10 補差額(一列):合計表只剩合計列、左邊是「Linux 基本主機,這期剩 18 天」,框腳先講「今天刷卡號末四碼 4242。」", rowsX.length === 1 && /p3\.s\.hostLeft/.test(rowsX[0].children[0].textContent) && /^p3\.srcS\.card/.test(bx.footWhere)); }
    ok("④ M5／S7:剩幾天讀不到 → 不印 null(用不帶天數那句);一期幾天讀不到 → 框腳用 NoNum 句",
      P.p3AddonModel(Q({ has_card: true, trial: nt, plan: { state: "active", paid_tier: "agent", cycle: "monthly", remaining_days: null }, addon_offer: { kind: "prorated", source: "card", tiers: rows(() => cell(100, "prorated", "card", 1440)) } }), null, PV).lines[0].key === "p3.s.hostRest"
      && P.p3AddonModel(Q(), null, { addons: PV.addons }).where[0].key === "p3.h.nextNoNum");
    ok("④ M9 快用完那一行的文字鈕接在句尾同一行(p3-inl);S1 分段重畫後焦點照「第幾組、第幾顆」找回;S8 框內錯誤句不另掛 role", /if \(l\.cta\) card\.el\.classList\.add\("p3-inl"\)/.test(src)
      && /p3AddonBox\(opener, note, \{ g, i \}\)/.test(src) && !/e\.setAttribute\("role", "status"\)/.test(src));


    { // 方案框 A 版(設計 v3-plan-box-2026-11-19)
      const txt = (n) => [n.textContent || ""].concat((n.children || []).map(txt)).join("|");
      const full = (o) => Q(Object.assign({ trial: { eligible: true, active: false, gen: "v3", ends_at: null, cancel_at_end: false, days: 14, ai_credit_twd: 150 } }, o));
      const fq = full(); fq.agent_offer.monthly.period_days = 30; fq.agent_offer.monthly.ai_credit_twd = 300;
      reset(); const mt = C.p3AgentModel(fq, null); C.p3AgentBox(mt, null); const tb = boxes[boxes.length - 1], tt = txt(tb.extra);
      ok("④ A 試用框、報價帶齊(公開價目讀不到也照畫):頭「14 天免費試用」＋「11/30 起每 30 天 888 TWD,之前取消不扣」;勾不寫額度數字(Wei 11-20,api 照給 150／300 也不印);鈕上一句驗證 10＋自動儲值;主鈕〔綁卡試用〕不帶天數;框腳〔用加密貨幣轉帳〕",
        mt.kind === "trial" && /14\|p3\.a\.trialUnit/.test(tt) && /p3\.a\.trialSub\{"at":"11\/30","d":"30","p":"888"\}/.test(tt) && /p3\.tick\.aiTrial(?!\{)/.test(tt) && !/p3\.tick\.ai(Trial|Period)\{/.test(tt)
        && /p3\.a\.oncePerCard\|p3\.a\.verifyLine\{"v":"10"\}/.test(tt) && /p3\.topup/.test(tt) && tb.ok === "p3.a.okTrialNoNum" && tb.link.label === "p3.crypto" && !tb.link.stay && !/p3\.tl\.|p3\.a\.cancelBy/.test(tt));
      const pq = Q({ trial: nt, has_card: true, card_last4: "4242", agent_offer: { kind: "pay", monthly: { today_twd: 888, today_is: "charge", first_charge_at: null, first_charge_twd: 888, source: "card", period_days: 30, ai_credit_twd: 300 } } });
      reset(); const mp = C.p3AgentModel(pq, null); C.p3AgentBox(mp, null); const pb = boxes[boxes.length - 1], pt = txt(pb.extra);
      // ── 設定 › 帳號與方案的 AI 額度列(spec agent-888-vague-ai-credit §3、設計 ai-credit-usage-bar §3–§6):用量條＋「已用 N%」,不印額度的 TWD 數字 ──
      { const U = C.p3UsedPct;
        ok("用量百分比:granted 0／缺 → null(整列不出);left 剛好 0 → 100;超額(left 0)→ 100;一般無條件捨去;只差一點也只到 99;left > granted → 0",
          U(0, 0) === null && U(null, 5) === null && U(undefined, 5) === null && U(300, 0) === 100 && U(300, -12) === 100 && U(300, 174) === 42 && U(300, 0.5) === 99 && U(300, 1) === 99 && U(300, 300) === 0 && U(300, 400) === 0
          // 浮點:(100−71)/100×100 = 28.999…,要跟網頁 aiUsedPct 與 references/billing.md 一樣是 29(稽核 vague-credit-postpush)
          && U(100, 71) === 29 && U(100, 70) === 30 && U(100, 1) === 99 && U(100, 99) === 1 && U(300, 213) === 29 && U(3, 2) === 33 && U(1000, 710) === 29 && U(150, 106.5) === 29
          && U(300, null) === null && U(300, undefined) === null && U(300, NaN) === null && U(300, "120") === null, [U(300, 174), U(300, 0.5), U(300, 0), U(300, null)]); }
      { const txtAll = (n) => [n.textContent || "", n.title || "", JSON.stringify(n.attrs || {}), JSON.stringify(n.dataset || {})].concat((n.children || []).map(txtAll)).join("|");
        if (!C.acctNoCard) C.acctNoCard = () => true;   // 自動儲值那句不在這幾條的範圍
        const rowsOf = (bal, ai) => { C.P3.bal = bal; C.acct = Object.assign({ v3_active: true, can_run: true }, ai ? { ai_credit: ai } : {}); const box = mkEl("div"); C.p3PlanRows(box); return box; };
        const grant = { kind: "period", next_grant_at: "2026-12-03T00:00:00Z", granted_twd: 300, left_twd: 174, low_threshold_twd: 20 };
        const normal = rowsOf({ aiGranted: 300, aiLeft: 174, aiOver: 0 }, grant), nt = txtAll(normal);
        const bar = walk(normal, (n) => n.className === "ai-track")[0], fill = walk(normal, (n) => n.className === "ai-fill")[0];
        ok("設定列一般:條＋「已用 42%」、條下「{at} 重置。」;條 aria-hidden、寬度 42%;沒有 role=meter", /p3\.set\.used\{"p":"42"\}/.test(nt) && /p3\.set\.reset\{"at":"12\/03"\}/.test(nt)
          && !!bar && bar.attrs["aria-hidden"] === "true" && fill.style.width === "42%" && !/meter|progressbar/.test(nt), nt);
        const over = txtAll(rowsOf({ aiGranted: 300, aiLeft: 0, aiOver: 18 }, grant)), upNo = txtAll(rowsOf({ aiGranted: 300, aiLeft: 0, aiOver: 0 }, grant));
        const trial = txtAll(rowsOf({ aiGranted: 150, aiLeft: 140, aiOver: 0 }, { kind: "trial", next_grant_at: null, granted_twd: 150, left_twd: 140 }));
        ok("設定列超額:已用 100%,條下先「本期已超額 18 TWD」(錢包扣的錢照寫)再「重置」;用完沒超額:100%、只有重置;試用:沒有重置日",
          /p3\.set\.used\{"p":"100"\}/.test(over) && over.indexOf("p3.set.over") >= 0 && over.indexOf("p3.set.over") < over.indexOf("p3.set.reset") && /p3\.set\.over\{"o":"18"\}/.test(over)
          && /p3\.set\.used\{"p":"100"\}/.test(upNo) && upNo.indexOf("p3.set.over") < 0 && /p3\.set\.reset/.test(upNo) && /p3\.set\.used\{"p":"6"\}/.test(trial) && trial.indexOf("p3.set.reset") < 0, [over, trial]);
        // api 照給完整的 TWD 欄位(granted／left 300、174、150、140),畫面上(含 title／aria／data)一個都不出現;只有超額那筆錢可以出現
        ok("設定列不印任何 AI 額度的 TWD 數字(總額、剩餘);title／aria／data 也沒有;沒有額度格 → 整列不出", [nt, upNo, trial, over.replace('{"o":"18"}', "")].every((x) => !/\b(300|174|150|140)\b|TWD/.test(x))
          && txtAll(rowsOf({ aiGranted: null, aiLeft: null, aiOver: 0 }, grant)).indexOf("p3.set.used") < 0
          // 舊 api 只給 granted、沒給 left:不知道用了多少 → 條與百分比都不出,不編一個「已用 100%」(稽核 0158)
          && txtAll(rowsOf({ aiGranted: 300, aiLeft: null, aiOver: null }, grant)).indexOf("p3.set.used") < 0 && walk(rowsOf({ aiGranted: 300, aiLeft: null, aiOver: null }, grant), (n) => n.className === "ai-track").length === 0 && txtAll(rowsOf({ aiGranted: 0, aiLeft: 0, aiOver: 0 }, grant)).indexOf("p3.set.used") < 0);
        ok("額度相關的字串(兩語)都不再帶額度數字的佔位:p3.c.planH／trialH／p3.set.aiV 拿掉;tick、up.next、low、lowReset、pv.offer.li.ai、pv.d.offer.blave、acct.sub 沒有 {n}／{q}／{g}",
          ["p3.c.planH", "p3.c.trialH", "p3.set.aiV"].every((k) => !(k in STR.zh) && !(k in STR.en))
          && ["p3.tick.aiPeriod", "p3.tick.aiTrial", "p3.up.next", "p3.low", "p3.lowReset", "pv.offer.li.ai", "pv.d.offer.blave", "acct.sub", "p3.set.used", "p3.set.reset"].every((k) => STR.zh[k] && STR.en[k] && !/\{(n|q|g)\}|TWD/.test(STR.zh[k] + STR.en[k]))
          && STR.zh["p3.set.used"] === "已用 {p}%" && STR.en["p3.set.used"] === "{p}% used" && STR.zh["p3.set.reset"] === "{at} 重置。" && STR.en["p3.set.reset"] === "Resets {at}."
          && STR.zh["p3.low"] === "AI 額度快用完了。" && STR.zh["p3.up.next"] === "{at} 重置。" && STR.en["p3.tick.aiPeriod"] === "Included every period");
        C.acct = { v3_active: true }; C.P3.bal = null; }
      ok("④ A 已綁卡付款框:頭 888 TWD／30 天＋「自動續扣,可隨時取消,不退款」;鈕上一句「今天刷末四碼 4242」;主鈕付 888;框身沒有鈕",
        mp.kind === "pay" && /888\|p3\.a\.unit\{"d":"30"\}/.test(pt) && /p3\.a\.renewShort/.test(pt) && /p3\.a\.todayCard\{"l":"4242"\}/.test(pt) && pb.ok === 'p3.a.okPay{"p":"888"}' && walk(pb.extra, (n) => n.tag === "button").length === 0);
      const bq = Q({ trial: nt, balance_twd: 900, agent_offer: { kind: "pay", monthly: { today_twd: 888, today_is: "charge", first_charge_at: null, first_charge_twd: 888, source: "wallet", period_days: 30, ai_credit_twd: 300 } } });
      reset(); C.p3AgentBox(C.p3AgentModel(bq, null), null); const bb = boxes[boxes.length - 1];
      ok("④ A 沒卡、錢包夠一期:主鈕綁卡並付 888,框腳只有〔用錢包付 888 TWD〕(stay,留在框裡扣)", bb.ok === 'p3.a.okBindPay{"p":"888"}' && /^p3\.a\.walletPay/.test(bb.link.label) && bb.link.stay === true);
      const miss = (mut) => { const q = full(); q.agent_offer.monthly.period_days = 30; q.agent_offer.monthly.ai_credit_twd = 300; mut(q); return C.p3AgentModel(q, null).kind; };
      ok("④ A 報價缺任一個條件數字(一期幾天／每期 AI 額度／試用天數／試用額度)、公開價目也沒有:不畫框(incomplete);公開價目有就補上",
        [(q) => { q.agent_offer.monthly.period_days = null; }, (q) => { q.agent_offer.monthly.ai_credit_twd = null; }, (q) => { q.trial.days = null; }, (q) => { q.trial.ai_credit_twd = null; }].every((f) => miss(f) === "incomplete")
        && C.p3AgentModel((() => { const q = full(); q.agent_offer.monthly.period_days = null; return q; })(), PV).kind === "trial"
        && C.p3AgentModel(Q({ trial: nt, has_card: true, agent_offer: { kind: "pay", monthly: { today_twd: 888, today_is: "charge", first_charge_at: null, first_charge_twd: 888, source: "card" } } }), null).kind === "incomplete");
      reset(); quoteReply = { status: 200, body: Q({ trial: nt, has_card: true, agent_offer: { kind: "pay", monthly: { today_twd: 888, today_is: "charge", first_charge_at: null, first_charge_twd: 888, source: "card" } } }) };
      const savedPub = C.pub; C.pub = { plan: { v3_active: true, v3: null } }; await C.p3OpenAgent(null); C.pub = savedPub;
      ok("④ A 條件不齊:開出來的是「現在讀不到價格」告知框,不是缺了條件的方案框", boxes.length === 1 && boxes[0].single === true && J(boxes[0].lines) === '["p3.err.quote"]');
      ok("④ A 框腳 link stay:confirmBox 記 linkStay、del-link 按了不關框;付款中 del-link 一起停用", /linkStay: !!\(link && link\.stay\)/.test(app) && /if \(delCtx && delCtx\.linkStay\) \{ if \(go\) go\(\); return; \}/.test(app) && /\$\("del-link"\)\.disabled = on;/.test(src));
      ok("① quote 白名單收 agent_offer.monthly.period_days／ai_credit_twd 與 trial.days／ai_credit_twd(舊 api 沒有 = null)", (() => { const b = rawQuote(); Object.assign(b.agent_offer.monthly, { period_days: 30, ai_credit_twd: 300 }); Object.assign(b.trial, { days: 14, ai_credit_twd: 150 }); const q = M.quoteBody(b), q0 = M.quoteBody(rawQuote()); return q.agent_offer.monthly.period_days === 30 && q.agent_offer.monthly.ai_credit_twd === 300 && q.trial.days === 14 && q.trial.ai_credit_twd === 150 && q0.trial.days === null && q0.agent_offer.monthly.period_days === null; })()); }

    { // 稽核 review-v3-plan-box-build:null 永不上畫面、熱區 44、價格字級 2×、這期不收費不寫「付 0」、缺值先重讀公開價目
      ok("④ M1 沒登入、公開價目沒有試用天數:不畫框(incomplete),不會印「null 天」", C.p3AgentModel(null, Object.assign({}, PV, { trial: {} })).kind === "incomplete" && C.p3AgentModel(null, PV).kind === "out");
      const txt = (n) => [n.textContent || ""].concat((n.children || []).map(txt)).join("|");
      const states = [C.p3AgentModel(null, PV), C.p3AgentModel(payQ, PV), C.p3AgentModel(Q(), PV), C.p3AgentModel(Q({ trial: nt, balance_twd: 900 }), PV),
        C.p3AgentModel(Q({ trial: nt, has_card: true, agent_offer: { kind: "pay", monthly: { today_twd: 0, today_is: "charge", first_charge_at: null, first_charge_twd: 888, source: "free" } } }), PV)];
      const shown = states.map((m) => { reset(); C.p3AgentBox(m, null); const b = boxes[boxes.length - 1]; return txt(b.extra) + "|" + b.ok + "|" + (b.link ? b.link.label : ""); });
      ok("④ M1 五種身分的方案框文字裡都沒有 null／undefined／NaN", shown.every((x) => !/null|undefined|NaN/.test(x)), shown.find((x) => /null|undefined|NaN/.test(x)));
      ok("④ S4 這期不收費(src free、today 0):主鈕〔開通方案〕,不寫「付 0 TWD」", /\|plan\.startM\|/.test(shown[4]));
      const css = fs.readFileSync(path.join(R, "planv3.css"), "utf8");
      ok("④ M3 設定那格的文字鈕(.plan-act .btn-quiet)熱區 44:套 44 配方(置中、height 44、寬 ≥ 44)", /:is\([^)]*\.plan-act[^)]*\) \.btn-quiet::before[^{]*\{\s*content: ""; position: absolute; inset: auto; left: 50%; top: 50%; width: max\(44px, calc\(100% \+ 8px\)\); height: 44px;/.test(css));
      ok("④ M4 價格大字 ≥ 內文 13 的 2 倍", (() => { const m = /\.p3-price \.big \{ font: 600 (\d+)px/.exec(css); return !!m && +m[1] >= 26; })());
      ok("④ M2 en〔用錢包付〕不帶金額(440 框腳一列排得下);S3 en 沒數字的試用鈕同句型", STR.en["p3.a.walletPay"] === "Pay From Balance" && STR.en["p3.a.okTrialNoNum"] === "Add Card, Try It");
      reset(); let pubLoads = 0; C.pubLoad = async () => { pubLoads++; C.pub = { plan: { v3_active: true, v3: PV } }; };
      C.pub = { plan: { v3_active: true, v3: null } }; quoteReply = { status: 200, body: Q() };
      await C.p3OpenAgent(null);
      ok("④ S1 報價與快取的公開價目都缺條件:先清掉快取重讀一次,讀到了就畫框(不直接出「稍後再試」)", pubLoads === 1 && boxes.length === 1 && boxes[0].ok === "p3.a.okTrialNoNum");
      C.pubLoad = async () => {}; }

    { // 稽核 pricing-v3-desktop-2026-11-19
      // 1. 埋點:十個 v3 事件都有送出點,而且 telemetry.js 收(畫面可送、每日去重、屬性值同 canon)
      const T = require(path.join(SHELL, "telemetry.js"));
      const TS = read(path.join(SHELL, "telemetry.js"));
      const TEN = { acct_card_alt: { alt: ["paper", "running", "none"] }, acct_card_alt_click: { card: ["pre_free", "turn_free"] }, free_low_shown: null,
        ai_credit_line: { kind: ["low_trial", "low_period", "used_up", "topped"] }, plan_box: { from: ["data", "free", "low", "side", "welcome", "set", "cloud", "unlaunched", "retry", "model", "lib"] },
        plan_box_res: { step: ["trial_page", "pay_page", "paid_card", "paid_wallet", "repriced", "src_changed", "charge_fail", "busy", "net", "rate", "active"] },
        plan_bind_res: { step: ["trial_ok", "plan_ok", "failed", "wallet", "trial_wallet", "refund", "unsettled", "dropped", "expired"] },
        addon_res: { step: ["ok_full", "ok_prorated", "ok_free", "ok_convert", "bind_page", "repriced", "src_changed", "capped", "cap_down", "paid_no_srv", "charge_fail", "wallet_short", "net"] },
        addon_pick: { tier: ["linux_starter", "linux_premium", "linux_max", "windows_starter", "windows_premium", "windows_max"] }, auto_resume: { r: ["sent", "skip_new", "skip_state"] } };
      const evBlock = TS.slice(TS.indexOf("const EVENTS = {"), TS.indexOf("\n};", TS.indexOf("const EVENTS = {")));
      const fr = TS.slice(TS.indexOf("const FROM_RENDERER = ["), TS.indexOf("];", TS.indexOf("const FROM_RENDERER = [")));
      const dl = TS.slice(TS.indexOf("const DAILY = ["), TS.indexOf("];", TS.indexOf("const DAILY = [")));
      ok("⑤ telemetry.js 收這十個:EVENTS 屬性值逐字同 canon、畫面可送(FROM_RENDERER)、每日去重(DAILY)", Object.keys(TEN).every((k) => {
        const line = (evBlock.match(new RegExp("\\n  " + k + ": ([^\\n]*),")) || [])[1];
        const want = TEN[k] === null ? "null" : "{ " + Object.keys(TEN[k])[0] + ": [" + TEN[k][Object.keys(TEN[k])[0]].map((v) => '"' + v + '"').join(", ") + "] }";
        return line === want && fr.includes('"' + k + '"') && dl.includes('"' + k + '"');
      }));
      { const apiPy = path.join(process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), "openclaw", "desktop_telemetry.py");
        if (fs.existsSync(apiPy) && /"auto_resume"/.test(read(apiPy))) { const api = read(apiPy);
          ok("⑤ 十個事件的屬性值逐字同 api 白名單", Object.keys(TEN).every((k) => { const m = api.match(new RegExp('"' + k + '": \\{"props": \\{([^}]*)\\}')); if (!m) return false;
            if (TEN[k] === null) return m[1].trim() === ""; const a = Object.keys(TEN[k])[0]; return m[1].includes('"' + a + '": (' + TEN[k][a].map((v) => '"' + v + '"').join(", ") + ")"); })); }
        else console.log("SKIP  api 白名單逐字比對(旁邊的 api 還沒有 v3 事件;設 BLAVE_API_DIR)"); }
      // 送出點實際觸發
      evs.length = 0; reset(); quoteReply = { status: 200, body: payQ }; startReply = { status: 200, body: { state: "none" } };
      await C.p3OpenAgent(null, null, "data"); await C.p3AgentGo(C.p3AgentModel(payQ, PV), null, false);
      reset(); startReply = { status: 409, body: { error_code: "SOURCE_CHANGED", source: "card" } }; await C.p3AgentGo(C.p3AgentModel(payQ, PV), null, false); await new Promise((r) => setImmediate(r));
      const qAdd = Q({ has_card: true, card_last4: "4242", trial: nt, addon_offer: { kind: "pay", source: "card", tiers: rows((t, p) => cell(p, "full", "card")) } });
      reset(); quoteReply = { status: 200, body: qAdd }; C.P3.sel = null; await C.p3OpenAddon(null, undefined, undefined, "cloud");
      const ab2 = boxes[boxes.length - 1]; walk(ab2.extra, (n) => n.dataset && n.dataset.t === "linux_max")[0].click();
      reset(); addonReply = { status: 200, body: { state: "starting", kind: "full" } }; await C.p3AddonGo(C.p3AddonModel(qAdd, null, PV), null);
      reset(); const wcE = C.faultCard(); C.P3.wait = { kind: "plan", tier: "agent", at: Date.now(), card: wcE };
      resultReply = { mark: { kind: "plan", tier: "agent", at: Date.now() }, res: { kind: "plan", status: "wallet", amount_twd: 15504, refund_review: true } }; await C.p3Poll();
      C.resendLast = () => Promise.resolve(true); C.canResend = () => true; C.creditCards = [{}]; C.lastUserText = "x"; C.turnSeqMine = 9; C.acct = { v3_active: true, can_run: true };
      C.P3.resume = C.p3ResumeToken(); await C.p3Resume(); C.creditCards = [];
      const tl = C.p3TurnLines({ ai: { state: "low", kind: "trial", slot_start: "Z" }, free: null, topNew: { amount: 300 }, said: new Set(), hasCard: true, last4: "4242", low: 20, lo: 50, amt: 300 });
      tl.forEach((l) => C.p3TurnEvents(l, { kind: "trial" }).forEach(([e, pr]) => C.trackEvent(e, pr)));
      C.p3TurnEvents({ id: "free", keys: [["p3.low", {}]] }, null).forEach(([e, pr]) => C.trackEvent(e, pr));
      const must = ['plan_box:{"from":"data"}', 'plan_box_res:{"step":"paid_card"}', 'plan_box_res:{"step":"src_changed"}', 'plan_box:{"from":"cloud"}', 'addon_pick:{"tier":"linux_max"}', 'addon_res:{"step":"ok_full"}',
        'plan_bind_res:{"step":"refund"}', 'auto_resume:{"r":"sent"}', 'ai_credit_line:{"kind":"low_trial"}', 'ai_credit_line:{"kind":"topped"}', 'free_low_shown:{}'];
      ok("⑤ 送出點實際觸發:plan_box(from)、plan_box_res、addon_pick、addon_res、plan_bind_res、auto_resume、ai_credit_line、free_low_shown", must.every((x) => evs.includes(x)), must.filter((x) => !evs.includes(x)).join());
      ok("⑤ acct_card_alt／acct_card_alt_click 在 p3FreeCardPaint 送(每張卡一次;〔看我的策略〕記 card)", /if \(!card\._p3sent\) \{ card\._p3sent = true; trackEvent\("acct_card_alt", \{ alt: card\._p3 \}\); \}/.test(src) && /trackEvent\("acct_card_alt_click", \{ card: where === "pre" \? "pre_free" : "turn_free" \}\)/.test(src));
      ok("⑤ 結果對到值:p3BoxStep／p3AddonStep 每條路", C.p3BoxStep({ status: 200, body: {} }, true, "card") === "paid_wallet" && C.p3BoxStep({ status: 409, body: { error_code: "PLAN_ALREADY_ACTIVE" } }) === "active"
        && C.p3BoxStep({ status: 429, body: {} }) === "rate" && C.p3BoxStep({ status: 0, body: null }) === "net" && C.p3BoxStep({ status: 402, body: { error_code: "PLAN_CHARGE_FAILED" } }) === "charge_fail"
        && C.p3AddonStep({ status: 200, body: { kind: "prorated" } }, "prorated") === "ok_prorated" && C.p3AddonStep({ status: 200, body: { kind: "full" } }, "trial_convert") === "ok_convert"
        && C.p3AddonStep({ status: 502, body: { charged_twd: 1440 } }) === "paid_no_srv" && C.p3AddonStep({ status: 503, body: { error_code: "LAUNCH_LIMIT_UNAVAILABLE" } }) === "cap_down" && C.p3AddonStep({ status: 200, opened: true }) === "bind_page");
      // 2. billing.md 的 Agent 方案新價已公告進 main(72b8441b／c183d869):外殼照 api 的 v3_active 切,文件也只能從切換時間起講新價——
      //    888 不准出現在切換時間那一句之前、台北與 UTC 兩個寫法要是同一刻、看不到帳號時切換前預設舊價;切換時間 = api V3_FROM(找得到 api 才比)
      const bill = read(path.join(__dirname, "..", "references", "billing.md"));
      const sw = /\*\*Agent plan pricing\*\* — from the switch date, (\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d) Taipei time\s+\((\d\d):(\d\d) UTC\)/.exec(bill);
      const swUtc = sw ? Date.UTC(+sw[1], +sw[2] - 1, +sw[3], +sw[4] - 8, +sw[5]) : NaN;
      ok("⑤ references/billing.md 講 Agent 方案新價先講切換時間:888 不出現在那一句之前、台北／UTC 同一刻、看不到帳號時切換前預設舊價",
        !!sw && bill.search(/\b888\b/) > sw.index && new Date(swUtc).getUTCHours() === +sw[6] && new Date(swUtc).getUTCMinutes() === +sw[7]
        && /before the switch date, treat earlier\s+plan pricing as the default/.test(bill));
      { const cfg = path.join(process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), "account", "agent_plan_config.py");
        const vf = fs.existsSync(cfg) ? /^V3_FROM = datetime\((\d+), (\d+), (\d+), (\d+), (\d+)\)/m.exec(read(cfg)) : null;
        if (!vf) console.log("SKIP  billing.md 切換時間 = api V3_FROM(找不到 api 的 agent_plan_config.py 或 V3_FROM;設 BLAVE_API_DIR)");
        else ok("⑤ billing.md 的切換時間 = api agent_plan_config.V3_FROM(UTC)", swUtc === Date.UTC(+vf[1], +vf[2] - 1, +vf[3], +vf[4], +vf[5])); }
      // 4. 改價前開始的試用:不講「開主機會結束試用」、雲端開通頁照舊「開機不另收」
      C.acct = { v3_active: true, trial_gen: "v2" }; const v2 = C.p3TrialV3(); C.acct = { v3_active: true, trial_gen: "v3" }; const v3t = C.p3TrialV3(); C.acct = { v3_active: true }; const none = C.p3TrialV3();
      ok("⑤ 試用代別:只有 trial_gen v3 才算 v3 試用(v1／v2／讀不到都照舊);設定試用格與雲端開通頁都讀它", !v2 && v3t && !none && /rule: t\(\(typeof p3TrialV3 === "function" && p3TrialV3\(\)\) \? "p3\.f\.trial"/.test(app)
        && /trial && mo && !\(typeof p3TrialV3 === "function" && p3TrialV3\(\)\) \? t\("env\.open\.trialOff"\)/.test(read(path.join(R, "trade.js")))); C.acct = { v3_active: true, can_run: true };
      // B4 內部帳號
      const iq = Q({ trial: nt, has_card: false, balance_twd: 5000, agent_offer: { kind: "pay", monthly: { today_twd: 0, today_is: "charge", first_charge_at: null, first_charge_twd: 888, source: "free", period_days: 30, ai_credit_twd: 300 } } });
      const im = C.p3AgentModel(iq, PV); reset(); C.p3AgentBox(im, null);
      ok("⑤ 內部帳號(報價 source free、沒卡、錢包夠):走一鍵開通送 free,框腳不出〔用錢包付〕(不會一直 SOURCE_CHANGED)", im.kind === "pay" && im.src === "free" && boxes[0].link.label === "p3.crypto" && boxes[0].ok === "plan.startM");
      // B5
      ok("⑤ 刷了錢沒開成、金額讀不到:用不帶數字那句(不印「已刷  TWD」)", C.p3ResultView({ status: "wallet", amount_twd: null }, "plan").key === "p3.w.walletNoNum" && C.p3ResultView({ status: "wallet", amount_twd: 888 }, "plan").key === "p3.w.wallet" && !!STR.zh["p3.w.walletNoNum"]);
      // 審計 item 2:後端補上四個欄位(公開價目讀不到)後框照畫
      const fq = Q({ trial: { eligible: true, active: false, gen: "v3", ends_at: null, cancel_at_end: false, days: 14, ai_credit_twd: 150 } }); Object.assign(fq.agent_offer.monthly, { period_days: 30, ai_credit_twd: 300 });
      ok("⑤ /plan/quote 帶齊 period_days／ai_credit_twd／trial.days／trial.ai_credit_twd、公開價目 v3 是 null:試用框照畫", C.p3AgentModel(fq, null).kind === "trial"); }

    { // api 6a608e6d:quote 的 trial.ai_credit_twd 不分代、固定 150 → 只在 trial.eligible(還沒開始的試用)的同意句用;進行中的試用不讀它
      const runQ = Q({ has_card: true, trial: { eligible: false, active: true, gen: "v2", ends_at: "2026-11-30T14:00:00+08:00", cancel_at_end: false, days: 14, ai_credit_twd: 150 },
        agent_offer: { kind: "active", monthly: { today_twd: 0, today_is: "charge", first_charge_at: null, first_charge_twd: 1440, source: "card", period_days: 30, ai_credit_twd: 300 } } });
      const rm = C.p3AgentModel(runQ, null);
      ok("⑤ 進行中的試用(v2、quote 寫 150):不畫方案框(active)、aiTrial 不帶 quote 的 150;只有 eligible 那支把 aiTrial 放進框", rm.kind === "active" && rm.aiTrial === null
        && /if \(q\.trial\.eligible && !q\.has_card\) \{[^}]*aiTrial \}\);/.test(src) && /const base = \{ days, aiPeriod, aiTrial: null,/.test(src)
        && !/quote|P3\.q/.test((src.match(/function p3PlanRows[\s\S]*?\n\}/) || [""])[0])); }

    { // 驗收 S1:雲端開通卡在 v3 試用中,旁邊〔開雲端主機〕會結束試用、今天扣;不能講「到期自動扣」
      const cut = (name) => { const i = app.indexOf("function " + name + "("); let d = 0; for (let k = app.indexOf("{", i); k < app.length; k++) { if (app[k] === "{") d++; else if (app[k] === "}" && --d === 0) return app.slice(i, k + 1); } };
      const line = (gen, v3on, q) => {
        C.acct = { v3_active: v3on, trial_gen: gen, plan: {} }; C.P3.q = q; C.p3Capital = () => false;
        return new Function("p3TrialV3", "p3TrialConvertLine", "planMo", "planTrialCx", "acct", "t", cut("planTrialLine") + "\nreturn planTrialLine({ d: '12/03', x: '888', p: '888' });")(
          C.p3TrialV3, C.p3TrialConvertLine, () => true, () => false, C.acct, (k, v) => k + (v ? J(v) : ""));
      };
      const tq = Q({ has_card: true, trial: { eligible: false, active: true, gen: "v3", ends_at: "2026-12-03T14:00:00+08:00" }, plan: { state: "trial" },
        addon_offer: { kind: "trial_convert", source: "card", tiers: rows((t, p) => cell(p, "full", "card")) } });
      const a = line("v3", true, tq), b = line("v3", true, null), c = line("v2", true, tq), d = line("v3", false, tq);
      ok("⑤ S1 v3 試用的雲端開通卡:講開主機會結束試用、今天付第一期,金額讀報價(Linux 基本 1,440);報價沒到不寫數字;v2 試用與 v3 關照舊「到期自動扣」",
        /^p3\.f\.trialConvert\{/.test(a) && /"p":"1,440"/.test(a) && /p3\.tier\.linux_starter/.test(a) && b === "p3.f.trialConvertNoNum" && /^env\.open\.trial\{/.test(c) && /^env\.open\.trial\{/.test(d), J([a, b, c, d]));
      C.acct = { v3_active: true, can_run: true }; C.P3.q = null; }
    { // R2 付款中焦點不掉出框:按框身的〔用錢包付〕→ 鎖住時焦點移到主鈕、解鎖後回到那顆鈕
      reset(); const nq = Q({ trial: nt, balance_twd: 900, agent_offer: { kind: "pay", monthly: { today_twd: 888, today_is: "charge", first_charge_at: null, first_charge_twd: 888, source: "wallet" } } });
      const mw = C.p3AgentModel(nq, PV); C.p3AgentBox(mw, null); const bx = boxes[boxes.length - 1];
      // 0.1.57 A 版:〔用錢包付〕搬到框腳 del-link(stay:不關框)
      const walletBtn = C.$("del-link"); walletBtn.click = () => bx.link.onClick();
      C.document.activeElement = walletBtn; C.$("del-body").contains = () => false;
      C.$("del-ok").focus = function () { C.document.activeElement = this; }; walletBtn.focus = function () { C.document.activeElement = this; }; walletBtn.isConnected = true;
      let rel; startWait = new Promise((r) => { rel = r; }); startReply = { status: 402, body: { error_code: "WALLET_SHORT" } };
      const go = walletBtn.click(); await null;
      const during = C.document.activeElement === C.$("del-ok");
      rel(); await go; for (let k = 0; k < 5; k++) await new Promise((r) => setImmediate(r)); startWait = null;
      ok("④ R2 按框腳〔用錢包付〕(link stay)付款中:那顆停用、焦點在主鈕;錯誤回來、解鎖後焦點回到〔用錢包付〕;錢包付送 pay_from wallet", during && C.document.activeElement === walletBtn && bx.link.stay === true
        && calls.includes('start:{"cycle":"monthly","confirm":888,"source":"wallet","wallet":true}')); }
    ok("④ R1 en 快用完／用完那一輪各兩句以內、不寫成「重置之後改從餘額扣」", [["p3.lowReset", "p3.low.then"], ["p3.up", "p3.topped"]].every((ks) => ks.map((k) => STR.en[k]).join(" ").split(/[.!?](?:\s|$)/).filter((x) => x.trim()).length <= 2)
      && !/After that/.test(STR.en["p3.low.then"]) && /^Once it runs out/.test(STR.en["p3.low.then"]));
    ok("④ R3 zh 中英之間留空格(「付過 Linux」「X 與 Y 的差額」),只有「{tier}主機」黏著", ["p3.unl", "p3.s.diff", "p3.s.diffRest"].every((k) => !/[一-鿿]\{(tier|paid)\}|\{(tier|paid)\}[與的]/.test(STR.zh[k])));
    ok("④ 日期 MM/DD;R7 單列合計不畫上緣線", C.p3Md("2026-11-30T14:00:00+08:00") === "11/30" && /"cf-row total" \+ \(one \? " solo" : ""\)/.test(src));
    { const en = Object.keys(STR.en).filter((k) => /^p3\./.test(k)).map((k) => [k, STR.en[k]]);
      const bad = en.filter(([, v]) => /;|\bwallet\b|\bservers?\b/i.test(v));
      ok("④ M7／M8 en:不用分號;錢包叫 balance、機器叫 cloud machine(用語表)", bad.length === 0, J(bad)); }
    ok("④ N2 日期一律 MM/DD(p3T 走 p3Md、不走 planDate),zh 數字日期與中文之間留空格(「12/01 前」);階名後面黏著「Linux 基本主機」",
      /if \(v\.at\) v\.at = p3Md\(v\.at\);/.test(src) && ["p3.a.trialSub", "p3.h.next", "p3.h.nextY", "p3.h.nextNoNum", "p3.up.next", "p3.lowReset", "p3.pro.paid"].every((k) => /\{at\} [\u4e00-\u9fff]|[\u4e00-\u9fff] \{at\}/.test(STR.zh[k]))
      && ["p3.s.host", "p3.s.hostLeft", "p3.s.paidAlready"].every((k) => !/\{tier\} /.test(STR.zh[k])));
    ok("④ N1 自動儲值的泡泡照外殼原樣(往上、無框):planv3.css 不覆寫 .tip 的位置與框線", !/\.p3-tipw \.tip \{[^}]*(top:|border)/.test(fs.readFileSync(path.join(R, "planv3.css"), "utf8")));
  }
  console.log(red ? red + " FAILED" : "ALL PASS");
  process.exit(red ? 1 : 0);
})();
