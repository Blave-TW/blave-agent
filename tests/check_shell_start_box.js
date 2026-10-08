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
const okClick = (app.match(/\$\("del-ok"\)\.addEventListener\("click", (async \(\) => \{[\s\S]*?\n\})\);/) || [])[1];
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

function world(o) {
  const sent = [], store = Object.assign({}, o.store);
  const report = Object.assign({ can_wait_start: true, self_ledger: true }, o.report);
  const env = {
    $, document: { createElement: (tag) => new El(tag) }, requestAnimationFrame: (f) => f(), t: (k) => k, sent, store,
    TR: { env: o.env || "local", st: { report }, startAt: 0 }, Date,
    trReport: () => report, trZView: () => ({ off: false }), envHeadState: () => "halted", trIsPaper: () => o.money === "paper", envMoney: () => o.money || null,
    trBookBaseline: () => o.book || "unknown", envMoneyText: (m) => (m ? "tr.mode." + m : ""), trWhereTidy: (x) => x, trVenueId: () => (o.money === "paper" ? "paper" : o.money ? "binance" : null), trVenueLabel: (id) => id || "", trPadLatin: (x) => x,
    trRestartKind: () => o.restart || null, trRecomputing: () => !!o.recomputing, trBothReal: () => null, planVars: () => ({ h: "0.9", m: "50" }),
    trHeldVenue: (res) => (res && res.held) || null, trRecRunning: () => !!o.recRunning, lsGet: (k) => (k in store ? store[k] : null), lsSet: (k, v) => { store[k] = v; },
    trSend: (S, cmd) => { sent.push(cmd); return Promise.resolve(o.reply ? o.reply(cmd) : { ok: true }); },
    // 真的 trRun 依序跑每一步、前一步沒成功就停;這裡只留這一條(過場態、紅字不在這支測試的範圍)
    trRun: async (want, steps) => { for (const st of steps) { const r = await st(env.TR); if (!r || !r.ok || env.trHeldVenue(r)) break; } },
  };
  const names = Object.keys(env);
  const body = `let delCtx = null; ${fn(app, "confirmBox")}\n${fn(app, "delClose")}\n${fn(trade, "trCloudBox")}\n${fn(trade, "trTwBroker")}\n${fn(trade, "trStartNotes")}\n${fn(trade, "trAskStart")}\n
    const click = ${okClick};\n return { trAskStart, trStartNotes, click, ctx: () => delCtx };`;
  const M = new Function(...names, body)(...names.map((k) => env[k]));
  Object.keys(ids).forEach((k) => delete ids[k]);
  $("del-scrim").hidden = true;
  M.trAskStart(null);
  const opts = $("del-body").all().filter((n) => n.cls.has("cf-opt")).map((row) => ({ row, input: row.kids.find((k) => k.tag === "input"), t: row.kids.filter((k) => k.cls && k.cls.has("cf-opt-t")).map((k) => k.textContent)[0], d: row.kids.find((k) => k.cls && k.cls.has("cf-opt-d")), w: row.kids.find((k) => k.cls && k.cls.has("cf-opt-w")) }));
  const pick = (id) => { const o2 = opts.find((x) => x.input.value === id); opts.forEach((x) => { x.input.checked = x === o2; }); return o2.input.fire("change"); };
  const press = async () => { await M.click(); await new Promise((r) => setTimeout(r, 0)); };
  return { M, sent, store, opts, pick, press, okb: $("del-ok"), open: () => !$("del-scrim").hidden, body: $("del-body"), modal: $("del-modal"), mark: $("del-mark") };
}

(async () => {
  // ---- 1
  { const w = world({ money: "paper" });
    ok("框開著、兩個選項都沒被選(沒有預設選項)、主鈕停用、字是「啟動下單」、沒有第二顆動作鈕", w.open() && w.opts.length === 2 && w.opts.every((o) => !o.input.checked && o.input.attrs.checked === undefined)
      && w.okb.disabled === true && w.okb.textContent === "tr.start" && $("del-alt").hidden === true && w.modal.cls.has("has-choices") && !w.modal.cls.has("has-alt"));
    ok("兩個選項的標題與順序:補齊部位、等新訊號;焦點在「取消」", w.opts.map((o) => o.t + ":" + o.input.value).join() === "tr.opt.catch:catch,tr.opt.wait:wait" && El.focus === $("del-cancel"));
    w.okb.disabled = false; await w.press();
    ok("沒選就按(就算 disabled 被拿掉):不送任何指令、框不關", w.sent.length === 0 && w.open(), w.sent); }
  // ---- 2
  for (const [env, recRunning, id, want] of [["local", false, "catch", "resume,restart_reconciler"], ["local", true, "catch", "resume"], ["local", false, "wait", "resume_wait,restart_reconciler"], ["local", true, "wait", "resume_wait"],
    ["cloud", false, "catch", "resume"], ["cloud", false, "wait", "resume_wait"]]) {
    const w = world({ env, money: "paper", recRunning }); await w.pick(id);
    const label = w.okb.textContent, enabled = w.okb.disabled === false;
    await w.press();
    ok(`${env} 選「${id}」(對帳器${recRunning ? "在跑" : "沒在跑"}):鈕字 ${id === "catch" ? "啟動並補齊部位" : "啟動，等新訊號才進場"}、送出 ${want}、框關掉`,
      enabled && label === (id === "catch" ? "tr.startCatchUp" : "tr.startWait") && w.sent.join() === want && !w.open(), { label, sent: w.sent }); }
  { const w = world({ money: "paper" }); await w.pick("wait"); await w.pick("catch"); await w.press();
    ok("改選:以最後選的那個為準", w.sent[0] === "resume" && w.sent.indexOf("resume_wait") < 0, w.sent); }
  { const w = world({ money: "paper", reply: () => ({ ok: false }) }); await w.pick("catch"); await w.press();
    ok("啟動指令沒送成:不補 restart_reconciler", w.sent.join() === "resume", w.sent); }
  // ---- 3
  { const w = world({ money: "paper", recomputing: true }), c = w.opts[0];
    ok("重算中:「補齊部位」停用、說明換成原因句、aria-describedby 指它;「等新訊號」照常可選", c.input.disabled === true && c.row.cls.has("off") && c.d.textContent === "tr.cloud.recomputing"
      && c.input.attrs["aria-describedby"] === c.d.id && !!c.d.id && !c.w && w.opts[1].input.disabled === false);
    await w.pick("wait"); await w.press();
    ok("重算中選等新訊號:送 resume_wait", w.sent[0] === "resume_wait", w.sent); }
  { const w = world({ money: "paper", restart: "app" });
    ok("Blave 重開後:最上面一句狀態句;舊訊號那一句掛在「補齊部位」裡,「等新訊號」沒有", w.body.kids[0].tag === "p" && w.body.kids[0].textContent === "tr.restartStartLineLocal"
      && w.opts[0].w && w.opts[0].w.textContent === "tr.opt.catchStale" && !w.opts[1].w); }
  { const w = world({ money: "real", env: "cloud", restart: "machine" });
    ok("主機重開後:狀態句是主機那一句;不掛舊訊號那一句(由重算與閘門講)", w.body.kids[0].textContent === "tr.cloud.restartStartLine" && !w.opts[0].w); }
  { const w = world({ money: "paper", report: { can_wait_start: false } });
    ok("只有一種啟動方式的舊機:沒有選項、主鈕可按、字是「啟動並補齊部位」", w.opts.length === 0 && w.okb.disabled === false && w.okb.textContent === "tr.startCatchUp" && !w.modal.cls.has("has-choices")
      && w.body.kids.some((k) => k.textContent === "tr.startWarn1"));
    await w.press(); ok("…按下去送 resume(＋restart_reconciler)", w.sent.join() === "resume,restart_reconciler", w.sent); }
  // ---- 4
  { const N = world({ money: "paper" }).M.trStartNotes, flat = (o) => { const n = N(o); return n.keep.join("|") + " / " + n.details.map((g) => g.label + ":" + (g.items ? g.items.join("|") : g.text)).join(";"); };
    // 設計稽核 desktop-10-08 #3:睡眠那一句(tr.keep.sleep)退役——它跟細節的第 1、2 點是同一件事;本機四點全在「細節」,常駐只留 venue 通用的「只調整 Blave 那一份」
    ok("這台電腦 · 模擬:沒有常駐句;細節三點(醒著才跑、睡眠不平倉、重開要再按),不出「只調整 Blave 那一份」與交易所停損單", flat({ paper: true, own: true, venue: "" }) === " / tr.det.local:tr.means.1|tr.means.2p|tr.means.3");
    ok("這台電腦 · 真錢:常駐只有「只調整 Blave 那一份」;細節四點(交易所停損單排第 4)", flat({ real: true, own: true, venue: "Binance" }) === "tr.keep.own / tr.det.local:tr.means.1|tr.means.2|tr.means.3|tr.means.4");
    ok("tr.keep.sleep 退役:程式不再引用、兩語都拿掉", !/tr\.keep\.sleep/.test(trade) && strings.indexOf('"tr.keep.sleep"') < 0);
    ok("機器沒證明自己只碰帳本(self_ledger 不是 true):那一句不出", !/tr\.keep\.own/.test(flat({ real: true, own: false, book: "none", venue: "Binance" })));
    // 統一(這台電腦、設計師裁定):完成頁那兩句說明搬過來——常駐「同月份分不清」取代三種加密口吻,細節多一條夜盤;三種帳本狀態都一樣
    ok("統一 · 真錢:常駐 tr.keep.pres(不是 tr.keep.own*)、細節多夜盤那一條;pres 只有這台電腦且 venue 是統一才傳(雲端不接統一)", ["none", "built", undefined].every((b) => flat({ real: true, own: true, pres: true, book: b, venue: "統一期貨" }).indexOf("tr.keep.pres / ") === 0)
      && flat({ real: true, own: true, pres: true, tw: true, venue: "統一期貨" }) === "tr.keep.pres / tr.det.local:tr.means.1|tr.means.2|tr.means.3|tr.means.twStop|tr.means.presNight"
      && /pres: !cloud && trVenueId\(\) === "president" \}\);/.test(trade));
    // 台灣期貨券商沒有券商端停損單型(統一 place_stop_order 是 NotImplementedError、群益同樣沒做):「交易所端停損單建議掛上」在那裡是假的,換成「停損是這台電腦算的、睡著沒保護」
    const TW = new Function(fn(trade, "trTwBroker") + "; return trTwBroker;")();
    ok("統一 · 真錢:第 4 點是 tr.means.twStop(帶券商名)、不出 tr.means.4", flat({ real: true, own: true, pres: true, tw: true, venue: "統一期貨" }).indexOf("tr.means.4") < 0
      && /o\.tw \? t\("tr\.means\.twStop", \{ venue: o\.venue \}\) : t\("tr\.means\.4"\)/.test(trade));
    ok("群益 · 真錢:同樣 twStop、不出 tr.means.4(靠 venue 判斷,不是只看 pres)", flat({ real: true, own: true, tw: true, venue: "群益" }) === "tr.keep.own / tr.det.local:tr.means.1|tr.means.2|tr.means.3|tr.means.twStop");
    ok("加密交易所 · 真錢:照舊 tr.means.4、不出 twStop", flat({ real: true, own: true, tw: false, venue: "Binance" }) === "tr.keep.own / tr.det.local:tr.means.1|tr.means.2|tr.means.3|tr.means.4");
    ok("tw 旗標從既有 venue id 判:capital / president 都算,其餘不算;call site 用 trTwBroker(trVenueId())", TW("capital") && TW("president") && !TW("binance") && !TW("paper") && !TW(null)
      && /tw: trTwBroker\(trVenueId\(\)\), pres: !cloud/.test(trade));
    ok("統一那一句的條件跟 tr.keep.own* 同一個(self_ledger === true 且真錢;電腦版第一份 config 就是 self_ledger: true):沒有它那句才不出", !/tr\.keep\.pres/.test(flat({ real: true, own: false, pres: true, venue: "統一期貨" })) && /tr\.means\.presNight/.test(flat({ real: true, own: false, pres: true, venue: "統一期貨" })));
    // 5. 三種帳本狀態
    const det = (o) => N(o).details.map((g) => g.label + (g.text ? "=" + g.text : "")).join();
    ok("帳本還沒建(第一次):常駐講「同方向的部位第一次對帳會算進來」,細節多一段 1.5 倍規則(排在環境那一段前面)", N({ real: true, own: true, book: "none", venue: "B" }).keep[0] === "tr.keep.ownFirst"
      && det({ real: true, own: true, book: "none", venue: "B" }) === "tr.det.own=tr.det.ownRule,tr.det.local");
    ok("帳本已建:常駐只講「你自己開的不算 Blave 的」,不講會算進來;細節沒有 1.5 倍那一段", N({ real: true, own: true, book: "built", venue: "B" }).keep[0] === "tr.keep.ownBuilt"
      && det({ real: true, own: true, book: "built", venue: "B" }) === "tr.det.local" && N({ cloud: true, real: true, own: true, book: "built", v: { h: "1", m: "50" } }).keep[0] === "tr.keep.ownBuilt");
    ok("讀不到帳本狀態:只講兩種情況都成立的那半句;細節沒有 1.5 倍那一段", [undefined, "unknown", "weird"].every((b) => N({ real: true, own: true, book: b, venue: "B" }).keep[0] === "tr.keep.own" && det({ real: true, own: true, book: b, venue: "B" }) === "tr.det.local"));
    ok("模擬不出這一句,三種帳本狀態都一樣", ["none", "built", "unknown"].every((b) => !/tr\.(keep\.own|det\.own)/.test(flat({ paper: true, own: true, book: b, venue: "" }))));
    const B = new Function(fn(trade, "trBookBaseline") + "; return trBookBaseline;")();
    ok("帳本狀態從對帳快照讀:帶 ledger(空的也算)= 已建;帶 needs_baseline = 還沒建;沒有快照、兩個都沒有、型別不對 = 讀不到", B({ last_reconcile: { ledger: {} } }) === "built" && B({ last_reconcile: { ledger: { BTCUSDT: { size: 50 } }, own_only: true } }) === "built"
      && B({ last_reconcile: { needs_baseline: { reason: "confirming", symbols: [] } } }) === "none" && B({ last_reconcile: { needs_baseline: { reason: "state_unreadable", symbols: ["a"] } } }) === "none"
      && [null, {}, { last_reconcile: null }, { last_reconcile: {} }, { last_reconcile: { ledger: null } }, { last_reconcile: { ledger: "x", needs_baseline: "y" } }, { last_reconcile: "x" }].every((r) => B(r) === "unknown"));
    ok("還沒存過金額(needs_baseline 的原因是 unconfigured):讀不到——新機存第一份金額時會寫一份從零開始的基準,舊機會收編,這一格分不出來", B({ last_reconcile: { needs_baseline: { reason: "unconfigured", symbols: [] } } }) === "unknown");
    ok("兩個都帶(不該發生):以已建為準——寧可少講「會算進來」", B({ last_reconcile: { ledger: {}, needs_baseline: { reason: "confirming" } } }) === "built");
    ok("雲端:常駐換成主機費與停機門檻;細節是雲端那兩句(「回到這一頁按暫停」那句退役)", flat({ cloud: true, real: true, own: true, v: { h: "1", m: "50" } }) === "tr.keep.own|tr.cloud.means.3 / tr.det.cloud:tr.cloud.means.1|tr.cloud.means.4"
      && flat({ cloud: true, paper: true, own: true, v: { h: "1", m: "50" } }) === "tr.cloud.means.3 / tr.det.cloud:tr.cloud.means.1|tr.cloud.means.4");
    ok("雲端拿不到金額:主機費那一句整句不出(不生沒有數字的半套說法)", flat({ cloud: true, paper: true, v: {} }).indexOf("tr.cloud.means.3") < 0); }
  { const det = (w) => w.body.all().find((n) => n.tag === "details");
    const a = world({ money: "real" }), c = world({ money: "paper" }), d = world({ money: "real", env: "cloud" });
    // 設計稽核 desktop-10-08 #3:細節一律收合(展開時整框在 1366 寬出捲軸);「看過」的 localStorage 旗標跟著退役
    ok("「細節」一律收著:真錢第一次、模擬、雲端都收", det(a).open === false && det(c).open === false && det(d).open === false);
    ok("真錢的標題記號是「真錢」、模擬是「模擬」", a.mark.textContent === "tr.mode.real" && a.mark.cls.has("real") && c.mark.textContent === "tr.mode.paper" && c.mark.cls.has("paper"));
    await a.pick("wait"); await a.press();
    ok("啟動後不再寫「看過細節」的旗標(trStartSeenKey 退役)", !Object.keys(a.store).length && !/trStartSeenKey|tr_start_seen_/.test(trade), a.store); }
  // ---- 字串
  { const has = (k) => (strings.match(new RegExp('"' + k.replace(/\./g, "\\.") + '":', "g")) || []).length === 2;
    const NEW = ["tr.keep.own", "tr.keep.ownFirst", "tr.keep.ownBuilt", "tr.keep.pres", "tr.means.presNight", "tr.means.twStop", "tr.det.own", "tr.det.ownRule", "tr.opt.legend", "tr.opt.catch", "tr.opt.catchDesc", "tr.opt.catchDescReal", "tr.opt.catchStale", "tr.opt.wait", "tr.opt.waitDesc", "tr.opt.waitDescReal", "tr.det.local", "tr.det.cloud", "cf.more"];
    const GONE = ["tr.startOwnOnly", "tr.startChoice", "tr.startWarn2", "tr.startWarn2Local", "tr.means.l", "tr.cloud.means.l", "tr.cloud.means.2", "tr.keep.sleep"];
    ok("新字串兩語都在;退役的兩語都拿掉、程式也不再引用", NEW.every(has) && GONE.every((k) => strings.indexOf('"' + k + '"') < 0 && trade.indexOf('"' + k + '"') < 0), NEW.filter((k) => !has(k)).concat(GONE.filter((k) => strings.indexOf('"' + k + '"') >= 0)));
    const zh = strings.slice(strings.indexOf("\n  zh: {")), get = (k) => (zh.match(new RegExp('"' + k.replace(/\./g, "\\.") + '": "([^"]*)"')) || [])[1] || "";
    ok("兩顆主鈕的字沒變(實測腳本認這兩句)", get("tr.startCatchUp") === "啟動並補齊部位" && get("tr.startWait") === "啟動，等新訊號才進場" && get("tr.start") === "啟動下單");
    ok("1.5 倍那一段逐字沿用原句的後半(只在帳本還沒建時出);已建那一句不講「會算進來」「不會被平」", get("tr.det.ownRule") === "第一次對帳時，同方向的現有部位不超過目標 1.5 倍就整份算 Blave 的，更大時只算到目標那麼多，其餘算你的、不會被平。單向持倉帳戶上，交易所會把 Blave 的單跟你同一個幣的部位合併計算。"
      && !/算進來|不會被平|不會被動到/.test(get("tr.keep.ownBuilt")) && /單向持倉/.test(get("tr.keep.ownBuilt")) && get("tr.keep.own") === "只調整 Blave 自己那一份。");
    { const en = strings.slice(strings.indexOf("\n  en: {"), strings.indexOf("\n  zh: {")), getEn = (k) => (en.match(new RegExp('"' + k.replace(/\./g, "\\.") + '": "([^"]*)"')) || [])[1] || "";
      ok("帳本已建那一句(設計師定稿):三句同一個開頭與句號,不用冒號;「也不會抵掉策略的目標部位」/ don’t offset a strategy’s target",
        get("tr.keep.ownBuilt") === "只調整 Blave 自己那一份。你自己開的部位不算 Blave 的，也不會抵掉策略的目標部位。單向持倉帳戶上，交易所會把 Blave 的單跟你同一個幣的部位合併計算。"
        && getEn("tr.keep.ownBuilt") === "Only Blave’s own share is traded. Positions you opened yourself aren’t counted as Blave’s and don’t offset a strategy’s target. On a one-way account the exchange nets Blave’s orders against your own position in the same coin."
        && ["tr.keep.own", "tr.keep.ownFirst", "tr.keep.ownBuilt"].every((k) => get(k).indexOf("只調整 Blave 自己那一份。") === 0 && getEn(k).indexOf("Only Blave’s own share is traded.") === 0));
      ok("統一的兩句(設計師裁定,逐字)", get("tr.keep.pres") === "只調整 Blave 自己那一份；同一個商品別跟策略用同一個月份手動交易，Blave 會分不清。"
        && getEn("tr.keep.pres") === "Only Blave’s own share is traded; don’t trade the same product and month by hand as a strategy — Blave can’t tell them apart."
        && get("tr.means.presNight") === "台指期夜盤 15:00 到隔天 05:00 也會下單，電腦要一直開著。" && getEn("tr.means.presNight") === "TAIEX futures also trade in the night session, 15:00–05:00; keep this computer on.");
      ok("台灣券商停損那一句(逐字,{venue} 帶券商名)", get("tr.means.twStop") === "{venue}沒有券商端停損單；Blave 的停損是這台電腦每根 K 棒算出來才下市價單，電腦睡著或關機時部位沒有保護。"
        && getEn("tr.means.twStop") === "{venue} has no broker-side stop orders; Blave’s stop-loss is computed on this computer each bar and sent as a market order, so a sleeping or shut-down computer leaves the position unprotected."); }
    ok("真錢的選項說明講「真實委託」;「不會自動平倉」只在細節第 2 點(tr.means.3 不重述)", /真實委託/.test(get("tr.opt.catchDescReal")) && /真實委託/.test(get("tr.opt.waitDescReal")) && !/真實委託/.test(get("tr.opt.catchDesc") + get("tr.opt.waitDesc"))
      && /不會自動平倉/.test(get("tr.means.2")) && !/平倉與停損/.test(get("tr.means.3"))); }
  console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  " + (e && e.stack)); process.exit(1); });
