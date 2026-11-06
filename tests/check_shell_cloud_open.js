// 雲端視角的開通頁(trade.js envPaintEmpty／envOpenCard;mockup-cloud-empty-2026-11-01 方向 A,Wei 選定):一個標題、一張卡,18 個狀態只換卡裡一格;狀態頁不留招攬字。
//   價格印在規格列、不貼在鈕上,主鈕字不帶金額;「其他方案與月價」外開定價頁;數字走 planVars／planSpec,拿不到不畫;不預告登入送的額度。
//   扣款規則三件事(存在就扣、停機照扣、刪除才停)由啟動確認框(app.js planAsk)講:cf.body2 只講扣多少,cf.body3 一句講完。
//   pv.w.out.cli 是這一頁與設定 › 帳號與方案(未登入)共用的鈕下一行。
// 不開 Electron:把原文切出來,配假 DOM 跑。跑法:node tests/check_shell_cloud_open.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer"), I18N = path.join(__dirname, "..", "shell", "i18n");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 600))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const cut = (src, name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0; for (let j = src.indexOf("{", i); j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}" && --d === 0) return src.slice(i, j + 1); } throw new Error("unbalanced " + name); };
const trade = read(path.join(R, "trade.js")), app = read(path.join(R, "app.js")), css = read(path.join(R, "trade.css"));
const STR = (() => { const sb = {}; vm.runInNewContext(read(path.join(R, "strings.js")) + "\nthis.S = STRINGS;", sb); return sb.S; })();
const PO = { zh: read(path.join(I18N, "zh.po")), en: read(path.join(I18N, "en.po")) };

const CLICK = { seen: [] };
class El {
  constructor(tag) { this.tagName = tag; this.className = ""; this.kids = []; this._t = ""; this.dataset = {}; this.attrs = {}; this.disabled = false; }
  set textContent(v) { this._t = String(v); this.kids = []; }
  get textContent() { return this._t + this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }
  appendChild(k) { this.kids.push(k); return k; }
  append(...ks) { ks.forEach((k) => this.kids.push(k)); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(_, f) { this.on = f; }
  click(seen) { CLICK.seen = seen; return this.on && this.on(); }
  contains() { return false; }
  querySelectorAll() { return []; }
  focus() {}
}
const paintSrc = ["envOpenView", "envOpenCard", "envPaintEmpty"].map((n) => cut(trade, n)).join("\n") + "\nreturn envPaintEmpty;";
const PUB = { tiers: [{ tier: "linux_starter", label: "Starter", vcpu: 2, ram_gb: 4 }] };
function paint(lang, kind, token, pv, o) {
  o = o || {}; const mo = !!o.mo, seen = () => CLICK.seen;
  const E = { "cv-body": new El("div"), "cv-h": new El("h3") }, ac = o.acct || (token ? {} : null), pb = o.pub === false ? null : PUB;
  const tbl = STR[lang], t = (k, vars) => { let s = tbl[k] != null ? tbl[k] : k; if (vars) for (const x in vars) s = s.split("{" + x + "}").join(vars[x]); return s; };
  const nums = o.pub === false ? { p: "", t: "", pd: "", yd: "", v: "" } : { p: "1,440", pd: "30", yd: "365", t: 14, v: "10" };
  const V = { h: mo ? "" : "2", pr: mo ? 1440 : null, b: "300", d: "", n: 0, u: "", gu: "", x: "", cy: "", q: "999", ...nums, ...(o.v || {}) };
  const env = { document: { createElement: (tag) => new El(tag), activeElement: null }, $: (id) => E[id], t, LANG: lang, hasToken: token, acct: ac, acctPending: false, pub: pb,
    planView: () => pv, planVars: () => V, planSpec: (own) => { if (o.onSpec) o.onSpec.push(!!own); return o.pub === false ? null : { label: "Starter", vcpu: 2, ram: 4 }; }, ENV: { sig: {}, askedAt: o.onAsk ? 0 : Date.now() }, planSince: o.slow ? 1 : 0, PLAN_SLOW_MS: o.slow ? 0 : 1e9, planErr: o.err || null,
    planLoginBusy: !!o.loginBusy, cur: "claude", window: { blave: { openExternal: (u) => seen().push("ext:" + u), cloudRefresh: () => seen().push("cloudRefresh") } }, trEl: (tag, cls, text) => { const n = new El(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
    planOpen() { seen().push("planOpen"); }, planLogin() {}, planRelogin() {}, planAsk() {}, acctUrl: () => "u", acctCheck() { seen().push("acctCheck"); }, pubLoad: async () => { if (o.onAsk) o.onAsk.push("pubLoad"); }, envPlanChanged() {}, trPollSoon() { seen().push("after"); }, hoBack() {}, hoStay() {},
    planMo: () => mo, planFailing: () => false, planRepay() {}, planPriceOk: (v) => (mo ? !!v.pr : !!(v.p && v.h)), bindGo: (n) => seen().push("bind:" + n), planWebGo() {}, trackFeature: (n) => seen().push("feature:" + n) };
  env.cloudPricingGo = new Function("trackFeature", "window", "LANG", cut(app, "cloudPricingGo") + "\nreturn cloudPricingGo;")(env.trackFeature, env.window, lang);
  env.cloudWebGo = () => {};
  env.pvK = (k) => (mo ? k + ".m" : k); env.planTrialCx = () => false;
  const lines = new Function("t", "pvK", "planMo", "planTrialCx", "acct", cut(app, "pvCardFoot") + "\n" + cut(app, "planTrialLine") + "\nreturn { pvCardFoot, planTrialLine };")(t, env.pvK, env.planMo, env.planTrialCx, ac);
  Object.assign(env, lines);
  new Function(...Object.keys(env), paintSrc)(...Object.values(env))(kind, o.pid || null);
  const page = E["cv-body"].kids[0];
  return { page, parts: page.kids.map((k) => (k.tagName + (k.className ? "." + k.className.split(" ")[0] : ""))), text: page.textContent };
}

// ── 1. 開通頁方向 A(mockup-cloud-empty-2026-11-01):18 態,卡與狀態頁 ──
const W = {
  zh: { h: "關上電腦，策略照跑", note: "含 Blave 行情與籌碼資料。", cli: "登入不花錢，也不會換掉你用的 AI。",
    body3: "沒在用、停機都照扣。要停止收費，需到網頁刪除主機。",
    body2: "開好後每個整點從餘額扣 2 TWD（每月 1,440 TWD，以 30 天計）。", price: "1,440 TWD／30 天", yearly: "14,400 TWD／365 天" },
  en: { h: "Close the laptop, the strategy keeps running", note: "Blave market and positioning data included.", cli: "Signing in costs nothing and keeps your AI.",
    body3: "It bills even when idle or stopped. To stop the charges, delete the machine on the web.",
    body2: "Once it’s up, 2 TWD comes out of your balance every hour (1,440 TWD a month, 30 days).", price: "1,440 TWD / 30 days", yearly: "14,400 TWD / 365 days" },
};
const walk = (n, out = []) => { out.push(n); n.kids.forEach((k) => typeof k === "object" && walk(k, out)); return out; };
const one = (r, cls) => walk(r.page).find((n) => (" " + n.className + " ").includes(" " + cls + " "));
const mainBtn = (r) => walk(r.page).find((n) => n.dataset.k === "main");
const noPitch = (r) => !one(r, "cv-card") && !r.text.includes("1,440") && !one(r, "ln-arrow");
for (const lang of ["zh", "en"]) {
  const S = STR[lang], sub = (k, o) => { let s = S[k]; for (const x in o || {}) s = s.split("{" + x + "}").join(o[x]); return s; }, spec = "Starter · 2 vCPU · 4 GB";
  const out = paint(lang, "none", false, "out", { mo: true });
  ok(lang + " out:一個標題、一張卡;標題同 web bc_intro_h1;規格列 → 價格與其他方案同一塊 → 含什麼 → 試用句 → 主鈕 → 鈕下一行;沒有「雲端」＋「還沒有雲端主機」那組頁首",
    out.parts.join() === "h3,div.cv-card" && one(out, "cv-card").kids.map((k) => k.className).join() === "cv-top,cv-note,cv-slot,cv-acts,cv-foot" && one(out, "cv-prw").kids.map((k) => k.className).join() === "cv-pr,ln-arrow" && out.page.kids[0].textContent === W[lang].h, out.parts.join());
  ok(lang + " out:規格讀 planSpec、價格走 env.open.price(每 30 天,不是月換算)", one(out, "cv-spec").textContent === spec && one(out, "cv-pr").textContent === W[lang].price, one(out, "cv-pr") && one(out, "cv-pr").textContent);
  ok(lang + " out:含什麼 11 字那句、試用句帶天數、鈕字不帶金額;不預告登入送的額度", one(out, "cv-note").textContent === W[lang].note && one(out, "cv-slot").textContent === sub("env.open.trialOffer", { t: 14 })
    && mainBtn(out).textContent === S["cn.blave.btn"] && one(out, "cv-foot").textContent === W[lang].cli && !out.text.includes("30 " + (lang === "zh" ? "額度" : "credit")) && !/999/.test(out.text), out.text);
  const seen = [], more = walk(out.page).find((n) => n.dataset.k === "more"); more.click(seen);
  ok(lang + " 其他方案與價格:外開定價頁、帶 from=desktop、記 cloud_pricing;不再開設定頁", seen.join() === "feature:cloud_pricing,ext:https://blave.org/landing/" + lang + "/pricing?from=desktop" && more.className === "ln-arrow" && more.kids[0].textContent === S["env.open.more"] && more.kids[1].attrs["aria-hidden"] === "true" && !/→/.test(S["env.open.more"]), seen.join());
  const bare = paint(lang, "none", false, "out", { mo: false, pub: false });
  ok(lang + " 公開價目拿不到:規格列、價格、試用句整格不畫,不寫死、不露 {t}", !one(bare, "cv-spec") && !one(bare, "cv-pr") && !one(bare, "cv-slot") && !/\{|undefined|TWD|vCPU/.test(bare.text), bare.text);
  const wait = paint(lang, "none", false, "out", { mo: true, loginBusy: true });
  ok(lang + " 等瀏覽器授權:主鈕換描邊的取消、鈕下一行換等待句,卡不變", mainBtn(wait).className === "btn-out" && mainBtn(wait).textContent === S["oauth.cancel"] && one(wait, "cv-foot").textContent === S["pv.w.waiting"] && !!one(wait, "cv-pr"));
  const ho = paint(lang, "none", false, "out", { mo: true, pid: "策略甲" });
  ok(lang + " 從「送上雲端」進來:標題下多一行等著的那支", ho.parts.join() === "h3,p.cv-pend,div.cv-card" && ho.page.kids[1].textContent === sub("env.open.pend", { id: "策略甲" }), ho.parts.join());
  const card = paint(lang, "none", true, "offer", { mo: true }), s2 = []; mainBtn(card).click(s2);
  ok(lang + " 綁卡態:鈕字「綁卡開始試用」不帶金額、記 bind_cloud;金額在價格列,扣款句不重講,驗證金與自動儲值留在綁卡頁", mainBtn(card).textContent === S["env.open.bind"] && !/\d/.test(mainBtn(card).textContent) && s2.join() === "bind:bind_cloud"
    && one(card, "cv-slot").textContent === sub("env.open.offer", { t: 14 }) && !one(card, "cv-slot").textContent.includes("1,440") && !card.text.includes(S["pv.f.offer.m"].slice(0, 6)) && one(card, "cv-pr").textContent === W[lang].price && !!one(card, "ln-arrow"), card.text);
  const plan = paint(lang, "none", true, "plan", { mo: true }), inc = paint(lang, "none", true, "included", { mo: true });
  ok(lang + " 沒方案／API 方案戶:主鈕到網站開主機;訊息各一句;招攬態有其他方案與含什麼", mainBtn(plan).textContent === S["plan.cloudWeb"] && one(plan, "cv-slot").textContent === S["pv.f.plan.m"] && one(inc, "cv-slot").textContent === S["env.open.included"] && !!one(inc, "ln-arrow") && !!one(inc, "cv-note"), plan.text);
  const due = paint(lang, "none", true, "included", { mo: true, acct: { plan: { tier: "linux_starter" } } });
  ok(lang + " 到期等續扣(有方案列、落在 included):不出 API 方案那句", !one(due, "cv-slot") && !due.text.includes(S["env.open.included"]) && !!one(due, "cv-note"), due.text);
  const trial = paint(lang, "none", true, "trial", { mo: true, v: { d: "11/14", n: 13 } }), yr = paint(lang, "none", true, "trial", { mo: true, v: { d: "11/14", n: 13, x: "14,400" } });
  ok(lang + " 試用中:右上換日期、不擺價格、沒有招攬;回答開機要不要加錢;金額跟著 plan(年繳 14,400)", one(trial, "cv-pr").textContent === sub("env.open.tagTrial", { d: "11/14" }) && one(trial, "cv-pr").className.includes("is-tag") && !one(trial, "ln-arrow") && one(trial, "cv-note").textContent === S["env.open.trialOff"]
    && one(trial, "cv-slot").textContent === sub("env.open.trial", { p: "1,440" }) && one(yr, "cv-slot").textContent === sub("env.open.trial", { p: "14,400" }), trial.text);
  const off = paint(lang, "none", true, "trial", { mo: true, v: { d: "11/14", n: 13 }, acct: { plan: { tier: "linux_starter", next_charge_source: "none" } } });
  ok(lang + " 試用中但到期不會扣:只講開機不另收,不講扣款", one(off, "cv-note").textContent === S["env.open.trialOff"] && !one(off, "cv-slot"), off.text);
  const on = paint(lang, "none", true, "planOn", { mo: true, v: { u: "12/01" } });
  ok(lang + " 方案有效、沒主機:右上日期、同階不另收、主鈕到網站開", one(on, "cv-pr").textContent === sub("env.open.tagPlan", { u: "12/01" }) && one(on, "cv-slot").textContent === S["env.open.planOn"] && mainBtn(on).textContent === S["plan.cloudWeb"] && !one(on, "ln-arrow"), on.text);
  const rp = paint(lang, "none", true, "payFail", { mo: true, v: { gu: "12/08", x: "14,400", cy: "annual" } }), rp0 = paint(lang, "none", true, "payFail", { mo: true });
  ok(lang + " 扣款失敗:標題換掉、主鈕重新付款、補「資料已暫停」;金額與週期讀他那一期,不讀 Starter;日期拿不到退不帶日期那句", rp.page.kids[0].textContent === S["env.open.failH"] && mainBtn(rp).textContent === S["plan.repay"] && one(rp, "cv-pr").textContent === W[lang].yearly
    && one(rp, "cv-slot").textContent === sub("env.open.repay", { gu: "12/08" }) && one(rp0, "cv-slot").textContent === S["env.open.repayNoNum"] && !one(rp, "ln-arrow"), rp.text);
  const er = paint(lang, "none", true, "plan", { mo: true, err: { key: "plan.err.charge" } });
  ok(lang + " 操作失敗:訊息格讓給錯誤句、不招攬;主鈕換卡、鈕下一行留前往儲值", one(er, "plan-err").textContent === S["plan.err.charge"] && !one(er, "cv-slot") && !one(er, "cv-note") && !one(er, "ln-arrow") && mainBtn(er).textContent === S["plan.changeCard"] && one(er, "cv-foot").textContent === S["plan.addCredit"], er.text);
  const rl = paint(lang, "none", true, "revoked", { mo: true });
  ok(lang + " 登入失效:狀態頁,一句＋重新登入,不留招攬字", noPitch(rl) && rl.text.includes(S["env.empty.relogin"]) && mainBtn(rl).textContent === S["plan.relogin"], rl.text);
  const go = paint(lang, "starting", true, "plan", { mo: true }), slow = paint(lang, "starting", true, "plan", { mo: true, slow: true });
  ok(lang + " 開通中:呼吸點＋一句,沒有停用的假鈕;比平常久才出重新查看", noPitch(go) && !mainBtn(go) && go.text === S["env.empty.starting"] && one(go, "dot").className === "dot busy" && slow.text.startsWith(S["plan.err.slow"]) && mainBtn(slow).textContent === S["plan.recheck"], go.text);
  ok(lang + " env.empty.starting 刪掉後半句機制", !/這一頁會自己換|This page changes/.test(S["env.empty.starting"]));
  const rd = paint(lang, "running", true, "plan", { mo: true, pid: "策略甲" });
  ok(lang + " 主機好了有策略等著:標題、一句、回這台電腦＋留在雲端", noPitch(rd) && rd.parts[0] === "h4" && mainBtn(rd).textContent === S["ho.back.btn"] && rd.text.includes(sub("ho.ready.body", { id: "策略甲" })), rd.text);
  const un = paint(lang, "unreach", true, "plan", { mo: true }), s3 = []; mainBtn(un).click(s3);
  ok(lang + " 讀不到雲端:補〔重新查看〕,按下去重問帳號與雲端、記 cloud_recheck", noPitch(un) && un.text.startsWith(S["env.empty.unreach"]) && mainBtn(un).textContent === S["plan.recheck"] && s3.join() === "feature:cloud_recheck,acctCheck,cloudRefresh,after", s3.join());
  const uk = paint(lang, "none", true, "unknown", { mo: true });
  ok(lang + " 查不到帳號狀態:一句＋重新查看,不再畫整頁招攬", noPitch(uk) && uk.text.startsWith(S["env.empty.unknown"]) && mainBtn(uk).textContent === S["plan.recheck"], uk.text);
  const ld = paint(lang, "loading", false, "out", { mo: true });
  ok(lang + " 載入中:只有一句", ld.parts.join() === "p" && ld.text === S["tr.loading"], ld.text);
  // 列舉 18 態:都畫得出來、沒有露 {key}、沒有寫死的 undefined
  const ALL = [["out", ["none", false, "out", { mo: true }]], ["handoff", ["none", false, "out", { mo: true, pid: "a" }]], ["zero", ["none", false, "out", { mo: true }]], ["waiting", ["none", false, "out", { mo: true, loginBusy: true }]], ["offer", ["none", true, "offer", { mo: true }]],
    ["plan", ["none", true, "plan", { mo: true }]], ["included", ["none", true, "included", { mo: true }]], ["trial", ["none", true, "trial", { mo: true, v: { d: "11/14", n: 13 } }]], ["planOn", ["none", true, "planOn", { mo: true, v: { u: "12/01" } }]], ["repay", ["none", true, "payFail", { mo: true }]],
    ["err", ["none", true, "plan", { mo: true, err: { key: "plan.err.charge" } }]], ["relogin", ["none", true, "revoked", { mo: true }]], ["starting", ["starting", true, "plan", { mo: true }]], ["slow", ["starting", true, "plan", { mo: true, slow: true }]], ["ready", ["running", true, "plan", { mo: true, pid: "a" }]],
    ["unknown", ["none", true, "unknown", { mo: true }]], ["unreach", ["unreach", true, "plan", { mo: true }]], ["loading", ["loading", false, "out", { mo: true }]]];
  const bad = ALL.filter(([, a]) => /\{|undefined|\bnull\b|env\.|plan\.|pv\./.test(paint(lang, ...a).text)).map((x) => x[0]);
  ok(lang + " 18 態列舉:全部畫得出來,沒有露出 key 或空值", ALL.length === 18 && bad.length === 0, bad.join());
  const pre = paint(lang, "none", true, "trial", { v: { d: "10/10", n: 9 } }), preOffer = paint(lang, "none", true, "offer", {});
  ok(lang + " 切換前照舊:主鈕 planAsk 的啟動方案、綁卡走 pvCardFoot 舊句、前往綁卡", mainBtn(pre).textContent === S["plan.start"] && /整點小時|per clock hour/.test(preOffer.text) && mainBtn(preOffer).textContent === S["plan.addCard"], preOffer.text);
}
{ const asked = []; paint("zh", "none", true, "plan", { mo: true, pub: false, onAsk: asked });
  ok("已登入也問公開價目(規格列、一期幾天要它):!pub 就問,同一道 30 秒節流", asked.join() === "pubLoad", asked.join());
  const mainSrc = read(path.join(R, "..", "main.js"));
  ok("publicPricing 帶 tiers:階、名字、vCPU、RAM,linux 與 windows 都進", /tiers: \[\.\.\.\(Array\.isArray\(b\.linux\) \? b\.linux : \[\]\), \.\.\.\(Array\.isArray\(b\.windows\) \? b\.windows : \[\]\)\]/.test(mainSrc) && /tier: x\.tier, label: x\.label, vcpu: n\(x\.vcpu\), ram_gb: n\(x\.ram_gb\)/.test(mainSrc));
  const spec = (ac, pb, own) => new Function("acct", "pub", "own", cut(app, "planSpec") + "\nreturn planSpec(own);")(ac, pb, own), T = { tiers: [{ tier: "linux_starter", label: "Starter", vcpu: 2, ram_gb: 4 }, { tier: "linux_premium", label: "Premium", vcpu: 4, ram_gb: 16 }] };
  ok("planSpec:招攬態一律 Starter(方案已結束的 Premium 也是),跟開通價同一階;own 才讀他那一階;價目拿不到回 null", spec(null, T).label === "Starter" && spec({ plan: { tier: "linux_premium" } }, T).ram === 4 && spec({ plan: { tier: "linux_premium" } }, T, true).ram === 16 && spec(null, null) === null && spec({ plan: { tier: "x" } }, T, true) === null);
  const sp = []; paint("zh", "none", true, "payFail", { mo: true, onSpec: sp }); paint("zh", "none", true, "planOn", { mo: true, onSpec: sp }); paint("zh", "none", true, "plan", { mo: true, onSpec: sp }); paint("zh", "none", true, "trial", { mo: true, v: { d: "1", n: 1 }, onSpec: sp }); paint("zh", "none", false, "out", { mo: true, onSpec: sp });
  ok("envPaintEmpty:只有扣款失敗、方案有效讀自己那一階", sp.join() === "true,true,false,false,false", sp.join());
  const css2 = css, html = read(path.join(R, "index.html"));
  ok("版面:標題 30、窄欄 26,主鈕 36;卡 400 寬光學置中;拿掉 .main-head 與 #cv-desc,#cv-h 留給讀屏與焦點", /\.cv-ce h3 \{ margin: 0; font-size: 30px;/.test(css2) && /@container \(max-width: 519px\) \{\s*\.cv-ce h3 \{ font-size: 26px; \}/.test(css2) && /\.cv-prw \{ margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; \}/.test(css2) && !/\.cv-more/.test(css2) && /\.cv-acts \.btn-fill, \.cv-acts \.btn-out \{ width: 100%; height: 36px; \}/.test(css2)
    && /\.cv-ce, \.cv-st \{ margin: auto; width: 100%; max-width: 400px; padding-bottom: var\(--space-48\); \}/.test(css2) && !/cv-desc/.test(html + trade) && /<div class="trv" id="cv-empty" hidden>\s*<!--[^\n]*-->\s*<h2 class="sr-only" id="cv-h" tabindex="-1"/.test(html), html.slice(html.indexOf('id="cv-empty"'), html.indexOf('id="cv-empty"') + 200));
  const sent = (s, lang) => s.split(lang === "zh" ? /[。！？]/ : /(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  const cnt = (p, lang) => (lang === "zh" ? (p.replace(/\{[a-z]+\}/g, "字").replace(/[0-9A-Za-z][0-9A-Za-z,.\-]*/g, "字").match(/[一-鿿字]/g) || []).length : p.split(/\s+/).length);
  const NEWK = ["env.open.h", "env.open.lead", "env.open.pend", "env.open.trialOffer", "env.open.offer", "env.open.included", "env.open.trial", "env.open.trialOff", "env.open.planOn", "env.open.repay", "env.open.repayNoNum", "env.empty.starting", "env.empty.unknown", "wc.stopped", "onb.wait"];
  const long = []; for (const l of ["zh", "en"]) for (const k of NEWK) for (const p of sent(STR[l][k], l)) if (cnt(p, l) > (l === "zh" ? 25 : 16)) long.push(l + ":" + k + ":" + cnt(p, l));
  ok("新字串密度:zh 一句 ≤25 字、en 一句 ≤16 詞", long.length === 0, long.join()); }

// ── 停機的原因:雲端下單頁(主鈕、那段話)跟方案頁用同一支 planStopKind(扣款失敗 / 取消到期 / 自己停 / 切換前低餘額),不各判一套 ──
{ const verdict = cut(trade, "trPaintVerdict"), goBtn = cut(trade, "trGoClick");   // #tr-go 的 click 抽成 trGoClick(策略頁〔啟動下單〕共用)
  ok("雲端停機:主鈕與那段話都照 planStopKind 分流;取消到期講刪機日(tr.cloud.stoppedEnded)、不講照常續約",
    /const k = planStopKind\(\); if \(k === "fail"\) planRepay\(\); else if \(k === "hourly"\) bindGo\("topup_cloud"\); else planWebGo\(\);/.test(goBtn)
    && /planStopKind\(\)/.test(verdict) && /k === "ended" \? gu\("tr\.cloud\.stoppedEnded"\)/.test(verdict) && /k === "self" \? t\("tr\.cloud\.stoppedPlanOk"\)/.test(verdict)
    && ["zh", "en"].every((l) => STR[l]["tr.cloud.stoppedEnded"] && STR[l]["tr.cloud.stoppedEndedNoNum"] && !/續約|renew/.test(STR[l]["tr.cloud.stoppedEnded"]))); }

// ── 2. 字串:三條子彈退役、規則字串留給設定頁、確認框第三句 ──
ok("env.open.1–3、env.empty.desc 從兩份 .po 與 strings.js 刪掉;env.open.lead 兩語都在", ["zh", "en"].every((l) => !/msgid "env\.open\.[123]"|msgid "env\.empty\.desc"/.test(PO[l]) && !("env.open.1" in STR[l]) && !("env.empty.desc" in STR[l]) && STR[l]["env.open.lead"] === W[l].note));
ok("trade.js 不再讀 env.open.1–3、plan.rule;舊的 .cv-open／.cv-lead／.cv-above／.plan-price 一起拿掉", !/env\.open\.[123]|"plan\.rule"|cv-list|cv-rule|cv-open|cv-lead|cv-above/.test(trade) && !/\.cv-open|\.cv-lead|\.cv-above/.test(css) && !/plan-price|planPriceEl/.test(app + read(path.join(R, "app.css"))));
// 講錯錢的 bug:方案制下綁卡態與試用態不能畫舊制句
for (const lang of ["zh", "en"]) { const OLD = /整點小時|per clock hour|照上面的價格|price above/;
  const o = paint(lang, "none", true, "offer", { mo: true }).text, tr = paint(lang, "none", true, "trial", { mo: true, v: { d: "10/10", n: 9 } }).text;
  ok(lang + " 方案制綁卡與試用:沒有舊制句", !OLD.test(o) && !OLD.test(tr) && tr.includes("1,440"), o + " | " + tr); }
ok("plan.rule / plan.rule.running 隨設定頁展開區一起退役:兩語都沒有、app.js 不再讀;同一條規則在確認框 cf.body3 與底列 pv.f.*", ["zh", "en"].every((l) => !("plan.rule" in STR[l]) && !("plan.rule.running" in STR[l]) && typeof STR[l]["cf.body3"] === "string") && !/"plan\.rule(\.running)?"/.test(app));
for (const lang of ["zh", "en"]) {
  const boxes = [], tbl = STR[lang], t = (k, vars) => { let s = tbl[k]; if (vars) for (const x in vars) s = s.split("{" + x + "}").join(vars[x]); return s; };
  new Function("t", "planVars", "confirmBox", "planGo", "planMo", cut(app, "planAsk") + "\nreturn planAsk;")(t, () => ({ p: "1,440", h: "2" }), (o) => boxes.push(o), () => {}, () => false)();
  ok(lang + " 啟動確認框:三句直接顯示;第二句只講扣多少(不再重講存在就扣),第三句一句講完沒在用 / 停機照扣、刪除才停", boxes.length === 1 && boxes[0].lines.length === 3
    && boxes[0].lines[1] === W[lang].body2 && boxes[0].lines[2] === W[lang].body3, JSON.stringify(boxes[0] && boxes[0].lines));
  const trial = []; new Function("t", "planVars", "confirmBox", "planGo", "planMo", cut(app, "planAsk") + "\nreturn planAsk;")(t, () => ({ p: "1,440", h: "2", d: "10/10" }), (o) => trial.push(o), () => {}, () => false)();
  ok(lang + " 啟動確認框(試用):第二句同樣刪掉句尾那段重複", trial[0].lines[1] === (lang === "zh" ? "10/10前免主機費。之後每個整點從餘額扣 2 TWD。" : "No machine fee until 10/10. After that, 2 TWD comes out of your balance every hour."), trial[0].lines[1]);
}
ok("鈕旁:設定 › 帳號與方案(未登入)切換前讀 pv.w.out(lead 已講 AI 照用,只留登入不花錢)、方案制 D 版沒有 lead → 自帶 AI 讀 pv.w.out.cli、Blave AI 讀 pv.w.out;開通頁讀 pv.w.out.cli",
  /wait: planLoginBusy \? t\("pv\.w\.waiting"\) : t\(mo && cur !== "blave" \? "pv\.w\.out\.cli" : "pv\.w\.out"\),/.test(app) && /side = trEl\("span", "wait", planLoginBusy \? t\("pv\.w\.waiting"\) : t\("pv\.w\.out\.cli"\)\)/.test(trade)
  && STR.zh["pv.w.out"] === "登入不花錢。" && STR.en["pv.w.out"] === "Signing in costs nothing.");

console.log(red ? "\n" + red + " 紅" : "\nALL PASS");
process.exit(red ? 1 : 0);
