// 雲端視角的開通頁(trade.js envPaintEmpty 的 .cv-open)精簡成 A 版(designer spec-0.1.10-label-wrap-plan-copy §2,Wei 選 A):
//   標題 → 一段說明(三條子彈併成 env.open.lead)→ 價格 → 鈕 + 鈕旁一句;扣款規則(plan.rule)不在這一頁畫。
//   扣款規則三件事(存在就扣、停機照扣、刪除才停)改由啟動確認框(app.js planAsk)一字不少地講:cf.body2 只講扣多少,cf.body3 一句講完「沒在用、停機都照扣;刪除才停」(精簡稽核 A3:原本 body2 句尾與 body3 重講同一件事)。
//   pv.w.out.cli 是這一頁與設定 › 帳號與方案(未登入)共用的鈕旁那句。
// 不開 Electron:把 envPaintEmpty / envOpenView / planAsk 原文切出來,配假 DOM 跑。跑法:node tests/check_shell_cloud_open.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer"), I18N = path.join(__dirname, "..", "shell", "i18n");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 600))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const cut = (src, name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0; for (let j = src.indexOf("{", i); j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}" && --d === 0) return src.slice(i, j + 1); } throw new Error("unbalanced " + name); };
const trade = read(path.join(R, "trade.js")), app = read(path.join(R, "app.js")), css = read(path.join(R, "trade.css"));
const STR = (() => { const sb = {}; vm.runInNewContext(read(path.join(R, "strings.js")) + "\nthis.S = STRINGS;", sb); return sb.S; })();
const PO = { zh: read(path.join(I18N, "zh.po")), en: read(path.join(I18N, "en.po")) };

class El {
  constructor(tag) { this.tagName = tag; this.className = ""; this.kids = []; this._t = ""; this.dataset = {}; this.attrs = {}; this.disabled = false; }
  set textContent(v) { this._t = String(v); this.kids = []; }
  get textContent() { return this._t + this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }
  appendChild(k) { this.kids.push(k); return k; }
  append(...ks) { ks.forEach((k) => this.kids.push(k)); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener() {}
  contains() { return false; }
  querySelectorAll() { return []; }
  focus() {}
}
const paintSrc = cut(trade, "envOpenView") + "\n" + cut(trade, "envPaintEmpty") + "\nreturn envPaintEmpty;";
function paint(lang, kind, token, pv, mo) {
  const E = { "cv-desc": new El("p"), "cv-body": new El("div"), "cv-h": new El("h3") };
  const tbl = STR[lang], t = (k, vars) => { let s = tbl[k] != null ? tbl[k] : k; if (vars) for (const x in vars) s = s.split("{" + x + "}").join(vars[x]); return s; };
  const env = { document: { createElement: (tag) => new El(tag), activeElement: null }, $: (id) => E[id], t, LANG: lang, hasToken: token, acct: token ? {} : null, acctPending: false, pub: {},
    planView: () => pv, planVars: () => (mo ? { p: "1,440", h: "", pr: 1440, yr: 14400, y: "14,400", k: "10", yd: "365", d: pv === "trial" ? "10/10" : null } : { p: "1,440", h: "2", d: pv === "trial" ? "10/10" : null }), ENV: { sig: {}, askedAt: Date.now() }, planSince: 0, PLAN_SLOW_MS: 1e9, planErr: null,
    planLoginBusy: false, cur: "claude", window: { blave: {} }, trEl: (tag, cls, text) => { const n = new El(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
    planOpen() {}, planLogin() {}, planRelogin() {}, planAsk() {}, acctUrl: () => "u", acctCheck() {}, pubLoad: async () => {}, envPlanChanged() {}, trPollSoon() {}, hoBack() {}, hoStay() {},
    planMo: () => !!mo, cloudWebGo() {}, planFailing: () => false, planPayUrl: () => "u", planRepay() {}, planPriceOk: (v) => (mo ? !!v.pr : !!(v.p && v.h)), planPriceEl: new Function("t", cut(app, "planPriceEl") + "\nreturn planPriceEl;")(t) };
  new Function(...Object.keys(env), paintSrc)(...Object.values(env))(kind, null);
  const page = E["cv-body"].kids[0];
  return { page, parts: page.kids.map((k) => (k.tagName + (k.className ? "." + k.className.split(" ")[0] : ""))), text: page.textContent };
}

// ── 1. 開通頁的結構與逐字 ──
const W = {
  zh: { h: "把策略放上雲端，電腦關機也照跑", lead: "一台 24 小時開著的主機，照排程跑策略、自動下單；含 Blave 的行情與籌碼資料。", cli: "登入不花錢，也不會換掉你用的 AI。",
    body3: "沒在用、停機都照扣；要停止收費，需到網頁刪除主機。",
    body2: "開好後每個整點從餘額扣 2 TWD（每月 1,440 TWD，以 30 天計）。" },
  en: { h: "Keep Your Strategies Running with This Computer Off", lead: "A machine that stays on runs your strategies on schedule and places the orders, with Blave’s market and positioning data included.",
    cli: "Signing in costs nothing and keeps your AI.", body3: "It bills even when idle or stopped. To stop the charges, delete the machine on the web.",
    body2: "Once it’s up, 2 TWD comes out of your balance every hour (1,440 TWD a month, 30 days)." },
};
for (const lang of ["zh", "en"]) {
  const out = paint(lang, "none", false, "offer");
  ok(lang + " out:標題 → 一段說明 → 價格 → 鈕列,就這四塊(沒有子彈清單、沒有規則行)", out.parts.join() === "h4,p.cv-lead,div.plan-price,div.cv-act", out.parts.join());
  ok(lang + " out:標題 / 說明逐字(spec §2.2)", out.page.kids[0].textContent === W[lang].h && out.page.kids[1].textContent === W[lang].lead, out.page.kids[0].textContent + " | " + out.page.kids[1].textContent);
  ok(lang + " out:價格照舊走 {p} / {h}(月價 + 以 30 天計那一行)", out.page.kids[2].textContent === STR[lang]["plan.month"].replace("{p}", "1,440") + STR[lang]["plan.hour"].replace("{h}", "2").replace("{p}", "1,440"));
  { const act = out.page.kids.find((k) => k.className === "cv-act"), side = act && act.kids[1];
    ok(lang + " out:鈕旁那句縮短(不再預告綁卡)", !!side && side.textContent === W[lang].cli, side && side.textContent); }
  ok(lang + " out:整頁不出扣款規則(存在就扣 / 停機照扣 / 刪除才停在啟動確認框與設定頁)", !out.text.includes(STR[lang]["plan.rule"]));
  const st = paint(lang, "none", true, "trial");
  ok(lang + " start:同一段標題 / 說明 / 價格,鈕上方那行與主鈕不動;不出規則行", st.parts.join() === "h4,p.cv-lead,div.plan-price,p.cv-above,div.cv-act" && st.page.kids[1].textContent === W[lang].lead && !st.text.includes(STR[lang]["plan.rule"]), st.parts.join());
  const mo = paint(lang, "none", true, "plan", true);
  ok(lang + " 方案制 start:開通頁不印開通價、主鈕是〔到網站開雲端主機〕(電腦版只開方案,主機到網站開)", mo.parts.join() === "h4,p.cv-lead,div.cv-act"
    && mo.page.kids.find((k) => k.className === "cv-act").kids[0].textContent === STR[lang]["plan.cloudWeb"], mo.text);
  const rp = paint(lang, "none", true, "payFail", true);
  ok(lang + " 方案扣款失敗:開通頁主鈕是「重新付款」", rp.page.kids.find((k) => k.className === "cv-act").kids[0].textContent === STR[lang]["plan.repay"], rp.text);
  const card = paint(lang, "none", true, "offer");
  ok(lang + " card:同一段精簡(五種狀態共用那段 code)", card.parts.join() === "h4,p.cv-lead,div.plan-price,p.cv-above,div.cv-act", card.parts.join());
}

// ── 停機的原因:雲端下單頁(主鈕、那段話)跟方案頁用同一支 planStopKind(扣款失敗 / 取消到期 / 自己停 / 切換前低餘額),不各判一套 ──
{ const verdict = cut(trade, "trPaintVerdict"), goBtn = trade.slice(trade.indexOf('b.id = "tr-go";'), trade.indexOf('act.appendChild(b);', trade.indexOf('b.id = "tr-go";')));
  ok("雲端停機:主鈕與那段話都照 planStopKind 分流;取消到期講刪機日(tr.cloud.stoppedEnded)、不講照常續約",
    /const k = planStopKind\(\); if \(k === "fail"\) planRepay\(\); else if \(k === "hourly"\) bindGo\("topup_cloud"\); else planWebGo\(\);/.test(goBtn)
    && /planStopKind\(\)/.test(verdict) && /k === "ended" \? gu\("tr\.cloud\.stoppedEnded"\)/.test(verdict) && /k === "self" \? t\("tr\.cloud\.stoppedPlanOk"\)/.test(verdict)
    && ["zh", "en"].every((l) => STR[l]["tr.cloud.stoppedEnded"] && STR[l]["tr.cloud.stoppedEndedNoNum"] && !/續約|renew/.test(STR[l]["tr.cloud.stoppedEnded"]))); }

// ── 2. 字串:三條子彈退役、規則字串留給設定頁、確認框第三句 ──
ok("env.open.1–3 從兩份 .po 與 strings.js 刪掉;env.open.lead 兩語都在", ["zh", "en"].every((l) => !/msgid "env\.open\.[123]"/.test(PO[l]) && !("env.open.1" in STR[l]) && !("env.open.2" in STR[l]) && !("env.open.3" in STR[l]) && STR[l]["env.open.lead"] === W[l].lead));
ok("trade.js 不再讀 env.open.1–3、plan.rule;trade.css 的 .cv-list / .cv-rule 一起拿掉,.cv-lead = 13 / 1.7 / --ink-2、上距 16",
  !/env\.open\.[123]|"plan\.rule"|cv-list|cv-rule/.test(trade) && !/\.cv-list|\.cv-rule/.test(css) && /\.cv-lead \{ margin: var\(--space-16\) 0 0; font-size: 13px; line-height: 1\.7; color: var\(--ink-2\); \}/.test(css));
ok("plan.hour:en 改成「{h} TWD an hour from your balance (30-day month)」(精簡稽核 A11),zh 不動(開通頁與設定頁共用)", STR.en["plan.hour"] === "{h} TWD an hour from your balance (30-day month)" && STR.zh["plan.hour"] === "以 30 天計 ＝ 每個整點從餘額扣 {h} TWD");
ok("plan.rule 還在,設定 › 方案內容與計費照讀", ["zh", "en"].every((l) => typeof STR[l]["plan.rule"] === "string") && /t\(view === "running" \? "plan\.rule\.running" : "plan\.rule"\)/.test(app));
for (const lang of ["zh", "en"]) {
  const boxes = [], tbl = STR[lang], t = (k, vars) => { let s = tbl[k]; if (vars) for (const x in vars) s = s.split("{" + x + "}").join(vars[x]); return s; };
  new Function("t", "planVars", "confirmBox", "planGo", "planMo", cut(app, "planAsk") + "\nreturn planAsk;")(t, () => ({ p: "1,440", h: "2" }), (o) => boxes.push(o), () => {}, () => false)();
  ok(lang + " 啟動確認框:三句直接顯示;第二句只講扣多少(不再重講存在就扣),第三句一句講完沒在用 / 停機照扣、刪除才停", boxes.length === 1 && boxes[0].lines.length === 3
    && boxes[0].lines[1] === W[lang].body2 && boxes[0].lines[2] === W[lang].body3, JSON.stringify(boxes[0] && boxes[0].lines));
  const trial = []; new Function("t", "planVars", "confirmBox", "planGo", "planMo", cut(app, "planAsk") + "\nreturn planAsk;")(t, () => ({ p: "1,440", h: "2", d: "10/10" }), (o) => trial.push(o), () => {}, () => false)();
  ok(lang + " 啟動確認框(試用):第二句同樣刪掉句尾那段重複", trial[0].lines[1] === (lang === "zh" ? "10/10前免主機費；之後每個整點從餘額扣 2 TWD。" : "No machine fee until 10/10. After that, 2 TWD comes out of your balance every hour."), trial[0].lines[1]);
}
ok("鈕旁:設定 › 帳號與方案(未登入)讀 pv.w.out(lead 已講 AI 照用,只留登入不花錢)、開通頁讀 pv.w.out.cli(那頁唯一講 AI 不會被換掉的地方)",
  /wait: planLoginBusy \? t\("pv\.w\.waiting"\) : t\("pv\.w\.out"\),/.test(app) && !/pv\.w\.out\.cli/.test(app) && /side = trEl\("span", "wait", planLoginBusy \? t\("pv\.w\.waiting"\) : t\("pv\.w\.out\.cli"\)\)/.test(trade)
  && STR.zh["pv.w.out"] === "登入不花錢。" && STR.en["pv.w.out"] === "Signing in costs nothing.");

console.log(red ? "\n" + red + " 紅" : "\nALL PASS");
process.exit(red ? 1 : 0);
