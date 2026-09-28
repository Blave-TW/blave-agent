// 啟動下單框(Wei 0928 第 3 點 A 案):先選再按。真的 confirmBox / trAskStart / 主鈕的 click 從原文切出來,跑在假 DOM 上。
//   1. 沒選選項:主鈕停用、字是「啟動下單」;就算 disabled 被拿掉,按了也不送任何指令、框不關
//   2. 選了之後:鈕字換成原本那兩顆的字,送出的指令跟改版前一樣——
//      補齊 = resume(這台電腦對帳器沒在跑再補 restart_reconciler)、等新訊號 = resume_wait(同上);雲端只送所選那一個
//   3. 重算中:「補齊部位」不能選、原因句掛在那個選項上(aria-describedby);只有一種啟動方式的舊機:沒有選項、照舊一顆主鈕
//   4. 句子分層(trStartNotes):常駐句與「細節」在 本機 / 雲端 × 模擬 / 真錢 各是哪幾句;真錢第一次細節展開、機器收下指令後才記成看過
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
    envMoneyText: (m) => (m ? "tr.mode." + m : ""), trWhereTidy: (x) => x, trVenueId: () => (o.money === "paper" ? "paper" : o.money ? "binance" : null), trVenueLabel: (id) => id || "", trPadLatin: (x) => x,
    trRestartKind: () => o.restart || null, trRecomputing: () => !!o.recomputing, trBothReal: () => null, planVars: () => ({ h: "0.9", m: "50" }),
    trHeldVenue: (res) => (res && res.held) || null, trRecRunning: () => !!o.recRunning, lsGet: (k) => (k in store ? store[k] : null), lsSet: (k, v) => { store[k] = v; },
    trSend: (S, cmd) => { sent.push(cmd); return Promise.resolve(o.reply ? o.reply(cmd) : { ok: true }); },
    // 真的 trRun 依序跑每一步、前一步沒成功就停;這裡只留這一條(過場態、紅字不在這支測試的範圍)
    trRun: async (want, steps) => { for (const st of steps) { const r = await st(env.TR); if (!r || !r.ok || env.trHeldVenue(r)) break; } },
  };
  const names = Object.keys(env);
  const body = `let delCtx = null; ${fn(app, "confirmBox")}\n${fn(app, "delClose")}\n${fn(trade, "trCloudBox")}\n${fn(trade, "trStartNotes")}\n${(trade.match(/const trStartSeenKey = .*;/) || [""])[0]}\n${fn(trade, "trAskStart")}\n
    const click = ${okClick};\n return { trAskStart, trStartNotes, trStartSeenKey, click, ctx: () => delCtx };`;
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
  { const N = world({ money: "paper" }).M.trStartNotes, flat = (o) => { const n = N(o); return n.keep.join("|") + " / " + n.details.map((g) => g.label + ":" + g.items.join("|")).join(";"); };
    ok("這台電腦 · 模擬:常駐只有睡眠那一句;不出「只調整 Blave 那一份」與交易所停損單", flat({ paper: true, own: true, venue: "" }) === "tr.keep.sleep / tr.det.local:tr.means.1|tr.means.2p|tr.means.3");
    ok("這台電腦 · 真錢:常駐三句(只調整 Blave 那一份用原句、睡眠、交易所停損單)", flat({ real: true, own: true, venue: "Binance" }) === "tr.startOwnOnly|tr.keep.sleep|tr.means.4 / tr.det.local:tr.means.1|tr.means.2|tr.means.3");
    ok("機器沒證明自己只碰帳本(self_ledger 不是 true):那一句不出", flat({ real: true, own: false, venue: "Binance" }).indexOf("tr.startOwnOnly") < 0);
    ok("雲端:常駐換成主機費與停機門檻;細節是雲端那兩句(「回到這一頁按暫停」那句退役)", flat({ cloud: true, real: true, own: true, v: { h: "1", m: "50" } }) === "tr.startOwnOnly|tr.cloud.means.3 / tr.det.cloud:tr.cloud.means.1|tr.cloud.means.4"
      && flat({ cloud: true, paper: true, own: true, v: { h: "1", m: "50" } }) === "tr.cloud.means.3 / tr.det.cloud:tr.cloud.means.1|tr.cloud.means.4");
    ok("雲端拿不到金額:主機費那一句整句不出(不生沒有數字的半套說法)", flat({ cloud: true, paper: true, v: {} }).indexOf("tr.cloud.means.3") < 0); }
  { const det = (w) => w.body.all().find((n) => n.tag === "details");
    const a = world({ money: "real" }), b = world({ money: "real", store: { tr_start_seen_local_real: "1" } }), c = world({ money: "paper" }), d = world({ money: "real", env: "cloud", store: { tr_start_seen_local_real: "1" } });
    ok("「細節」:真錢第一次展開、啟動過就收著、模擬一律收著;這台電腦與雲端分開記", det(a).open === true && det(b).open === false && det(c).open === false && det(d).open === true);
    ok("真錢的標題記號是「真錢」、模擬是「模擬」", a.mark.textContent === "tr.mode.real" && a.mark.cls.has("real") && c.mark.textContent === "tr.mode.paper" && c.mark.cls.has("paper"));
    await a.pick("wait"); await a.press();
    ok("機器收下啟動指令才記成啟動過", a.store.tr_start_seen_local_real === "1", a.store);
    const e = world({ money: "real", reply: () => ({ ok: false }) }); await e.pick("catch"); await e.press();
    const h = world({ money: "real", reply: () => ({ ok: true, held: "binance" }) }); await h.pick("catch"); await h.press();
    await c.pick("catch"); await c.press();
    ok("沒送成、被帳戶確認擋住(held)、模擬:都不記", !("tr_start_seen_local_real" in e.store) && !("tr_start_seen_local_real" in h.store) && !Object.keys(c.store).length, [e.store, h.store, c.store]); }
  // ---- 字串
  { const has = (k) => (strings.match(new RegExp('"' + k.replace(/\./g, "\\.") + '":', "g")) || []).length === 2;
    const NEW = ["tr.opt.legend", "tr.opt.catch", "tr.opt.catchDesc", "tr.opt.catchDescReal", "tr.opt.catchStale", "tr.opt.wait", "tr.opt.waitDesc", "tr.opt.waitDescReal", "tr.keep.sleep", "tr.det.local", "tr.det.cloud", "cf.more"];
    const GONE = ["tr.startChoice", "tr.startWarn2", "tr.startWarn2Local", "tr.means.l", "tr.cloud.means.l", "tr.cloud.means.2"];
    ok("新字串兩語都在;退役的兩語都拿掉、程式也不再引用", NEW.every(has) && GONE.every((k) => strings.indexOf('"' + k + '"') < 0 && trade.indexOf('"' + k + '"') < 0), NEW.filter((k) => !has(k)).concat(GONE.filter((k) => strings.indexOf('"' + k + '"') >= 0)));
    const zh = strings.slice(strings.indexOf("\n  zh: {")), get = (k) => (zh.match(new RegExp('"' + k.replace(/\./g, "\\.") + '": "([^"]*)"')) || [])[1] || "";
    ok("兩顆主鈕的字沒變(實測腳本認這兩句)", get("tr.startCatchUp") === "啟動並補齊部位" && get("tr.startWait") === "啟動，等新訊號才進場" && get("tr.start") === "啟動下單");
    ok("真錢的選項說明講「真實委託」;「連平倉與停損都不會做」只留在常駐句(tr.means.3 不重述)", /真實委託/.test(get("tr.opt.catchDescReal")) && /真實委託/.test(get("tr.opt.waitDescReal")) && !/真實委託/.test(get("tr.opt.catchDesc") + get("tr.opt.waitDesc"))
      && /平倉與停損也不會執行/.test(get("tr.keep.sleep")) && !/平倉與停損/.test(get("tr.means.3"))); }
  console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  " + (e && e.stack)); process.exit(1); });
