// 策略庫一鍵購買框(designer purchase-confirm-2026-11-10 A 帳單式;shell/renderer/library.js libBuyOneOpen / libBuyOneBox / libBuyOneGo)。不起 Electron:
//   從原文切出這幾支,配一個只有確認框那幾個節點的假 DOM 跑。確認框是 app.js 的單一 #del-scrim,「不關掉重開」驗的是
//   從開框到結束 #del-scrim 只從藏著變出來一次、中間沒有被 delClose 收掉(舊的兩段流程在 402 換第二段時會收一次再開)。
//   情境:錢包夠／不足有卡／付款中／失敗／SOURCE_CHANGED 重畫／處理中／新價非整數／餘額讀不到退回舊流程／付款中框被換掉;送出帶的金額與來源;
//   成功後扣款那一句(照 api 的 paid_from)。框底訊息槽與付完那句照設計稽核 purchase-box-audit-2026-11-10。
// 跑法:node tests/check_shell_library_buybox.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 1500))); if (!c) red++; };
const src = fs.readFileSync(path.join(R, "library.js"), "utf8");
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
const STR = (() => { const sb = {}; vm.runInNewContext(fs.readFileSync(path.join(R, "strings.js"), "utf8") + "\nthis.S = STRINGS;", sb); return sb.S; })();
const tick = () => new Promise((r) => setTimeout(r, 0));

// 假 DOM:夠 libEl / confirmBox 用就好
class El {
  constructor(tag) { this.tag = tag; this.kids = []; this.className = ""; this.hidden = false; this.disabled = false; this.dataset = {}; this.attrs = {}; this._text = null; }
  append(...xs) { xs.forEach((x) => this.kids.push(typeof x === "string" ? { text: x } : x)); }
  appendChild(x) { this.kids.push(x); return x; }
  setAttribute(k, v) { this.attrs[k] = v; }
  set textContent(v) { this.kids = []; this._text = v; }
  get textContent() { return (this._text || "") + this.kids.map((k) => (k instanceof El ? k.textContent : k.text)).join(""); }
  all() { return [this, ...this.kids.filter((k) => k instanceof El).flatMap((k) => k.all())]; }
  focus() {}
  get isConnected() { return true; }
}

function world(o) {
  const ids = {}; ["del-scrim", "del-title", "del-ok", "del-cancel", "del-close", "lib", "lib-cta"].forEach((id) => { ids[id] = new El("div"); ids[id].id = id; });
  ids["del-scrim"].hidden = true;
  const log = { syncRead: [], opens: 0, closes: 0, boxes: [], buys: [], bindBuy: 0, legacy: [], auto: 0 };
  let body = null, ctx = null;
  const sb = {
    console, Object, Number, Math, JSON, Promise, Intl,
    document: { createElement: (t) => new El(t), createDocumentFragment: () => new El("#frag") },
    $: (id) => ids[id],
    t: (k, v) => { let s = STR.zh[k]; if (typeof s !== "string") throw new Error("缺字串 " + k); for (const [a, b] of Object.entries(v || {})) s = s.split("{" + a + "}").join(b); return s; },
    LANG: "zh",
    LIB: Object.assign({ buying: null, pending: new Map(), bbRes: new Map(), bal: null, last4: null, data: { dataAccess: "included" }, stale: false }, o.LIB || {}),
    acct: o.acct === undefined ? { has_card: true } : o.acct,
    acctNoCard: (s) => !!s && s.has_card === false,
    hasToken: true,
    window: { blave: {
      balance: async () => (typeof o.balance === "function" ? o.balance() : o.balance),
      libraryPurchase: (id, topup, box) => new Promise((res) => { log.buys.push({ id, topup, box }); log.release = (r) => res(r); }),
    } },
    // 確認框:同 app.js 的單一 #del-scrim。藏著 → 出來才算開一次;delClose 看 lock(付款中收不掉)
    confirmBox: (x) => {
      const sc = ids["del-scrim"]; if (sc.hidden) log.opens++;
      sc.hidden = false; body = x.extra || null; ctx = x; sb.delCtx = x;
      ids["del-title"].textContent = x.title; ids["del-ok"].textContent = x.ok; ids["del-ok"].disabled = !!x.okDisabled; ids["del-cancel"].hidden = !!x.single;
      log.boxes.push({ title: x.title, text: (x.lines || []).join("|") + (body ? body.textContent : ""), ok: x.ok, stay: !!x.stay, single: !!x.single, cls: body ? body.all().map((e) => e.className).filter(Boolean) : [] });
    },
    delClose: () => { const sc = ids["del-scrim"]; if (sc.hidden || sc.dataset.lock) return; sc.hidden = true; log.closes++; ctx = null; sb.delCtx = null; },
    delCtx: null,
    delOkBusy: (on) => { ids["del-ok"].busy = on; },
    envCanSwitch: () => ids["del-scrim"].hidden,
    libBag: () => ({ detail: 5 }),
    libSync: () => { log.syncRead.push(sb.LIB.buyRead); }, libRefresh: () => {}, libCtaMain: () => null,
    libAutoInstall: () => { log.auto++; },
    libBindBuy: () => { log.bindBuy++; },
    bindGo: (n) => { log.bindGo = (log.bindGo || []).concat(n); },
    libSymbolNodes: () => ["BTC/USDT", " 永續"],
    libFeeLine: () => false, libEnv: () => "local", libNeeds: () => "none",
    libBbCharged: (b) => ({ kind: "wallet", code: b.reason || null, amount: Math.round(b.amount_twd) }),
    libPriceText: (s) => libTwdOut(s.price), libBalanceText: (v) => String(v), libFx: () => false, libTrack: () => {}, planOpen: () => {},
  };
  const libTwdOut = (n) => new Intl.NumberFormat("zh-TW").format(n) + " TWD";
  vm.createContext(sb);
  sb.libBalLoad = async () => { const r = await sb.window.blave.balance(); sb.LIB.bal = r && typeof r.balance === "number" ? r.balance : null; sb.LIB.last4 = r && typeof r.last4 === "string" ? r.last4 : null; };
  // 舊兩段流程只記一筆,不真的跑(這支只驗一鍵框;舊流程在 check_shell_library ④)
  vm.runInContext(/const LIB_PB_MSG = [^\n]*/.exec(src)[0].replace(/^const/, "var") + "\n" + ["libEl", "libBuyBranch", "libTwd", "libHasCard", "libBuyOneOpen", "libBuyOneBox", "libBuyOneGo", "libBuyBox"].map((n) => (src.includes("async function " + n + "(") ? "async " : "") + cutFn(src, n)).join("\n"), sb);
  const realBuyBox = sb.libBuyBox;
  sb.libBuyBox = (s, stage, opener, x) => { if (x && (x.legacy || x.failed)) { log.legacy.push(stage); return; } realBuyBox(s, stage, opener, x); };
  return { sb, ids, log, ok: () => { const c = ctx, go = c && c.onOk; if (!go) return; if (!c.stay) sb.delClose(false); go(); }, cur: () => log.boxes[log.boxes.length - 1] };
}
const S = () => ({ id: 5, title: "BTC 筹码集中度 多空死区过滤避免频繁进出策略", price: 70 });
const shown = (w) => !w.ids["del-scrim"].hidden;

(async () => {
  // ── 錢包夠 ──
  { const w = world({ LIB: { bal: 1250 } }); const s = S();
    w.sb.libBuyBox(s, "confirm", null, {}); await tick();
    const b = w.cur();
    ok("錢包夠:一個框、標題固定「確認購買」、名稱在內文(不截)、價格主列、付款寫錢包、鈕〔付 70 TWD〕、一次付清那行、stay 不關",
      w.log.opens === 1 && b.title === "確認購買" && b.text.includes(s.title) && !b.text.includes("BTC/USDT") && !b.cls.some((c) => c.includes("lib-pb-meta")) && b.text.includes("價格70 TWD") && b.text.includes("付款錢包") && b.ok === "付 70 TWD"
      && b.text.includes("一次付清，不續扣。") && b.stay && b.cls.includes("cf-row lead") && b.cls.includes("lib-pb-nm"), JSON.stringify(b));
    w.ok(); await tick();
    ok("付款中:框還在、鎖住、取消與 ✕ 停用、主鈕「付款中…」轉圈但不設 disabled(焦點留在鈕上,aria-disabled 由 delOkBusy 管);送出帶 confirm_topup false＋金額與來源 wallet",
      shown(w) && w.ids["del-scrim"].dataset.lock === "1" && !w.ids["del-ok"].disabled && w.ids["del-cancel"].disabled && w.ids["del-close"].disabled && w.ids["del-ok"].textContent === "付款中…" && w.ids["del-ok"].busy === true
      && w.log.buys.length === 1 && w.log.buys[0].topup === false && JSON.stringify(w.log.buys[0].box) === '{"price":70,"source":"wallet"}', JSON.stringify([w.log.buys, w.ids["del-ok"]]));
    w.sb.delClose(false);
    ok("付款中 Esc／✕／框外(delClose)收不掉", shown(w) && w.log.closes === 0);
    w.ok(); await tick();
    ok("付款中再按主鈕(沒 disabled):LIB.buying 擋住,不送第二筆", w.log.buys.length === 1);
    w.log.release({ status: 200, body: { status: "ok", strategy_id: 5 } }); await tick();
    const res = w.sb.LIB.bbRes.get(5);
    ok("成功:這時才關框(全程只開一次、沒有關掉重開)、已購、自動安裝、主鈕下一句「已從錢包扣 70 TWD。」(paid 型:無記號,不走 libBbLines 的 fault-mark)",
      !shown(w) && w.log.opens === 1 && w.log.closes === 1 && s.purchased === true && w.log.auto === 1 && res && res.kind === "paid" && res.key === "lib.pb.doneWallet" && res.p === 70
      && w.sb.t(res.key, { p: w.sb.libTwd(res.p) }) === "已從錢包扣 70 TWD。", JSON.stringify([w.log, res])); }
  // ── 成功句照 api 的 paid_from(B2):框寫錢包、api 說從卡扣 → 寫卡 ──
  { const w = world({ LIB: { bal: 1250 } }); const s = S();
    w.sb.libBuyBox(s, "confirm", null, {}); await tick(); w.ok(); await tick();
    w.log.release({ status: 200, body: { status: "ok", paid_from: "card" } }); await tick();
    const res = w.sb.LIB.bbRes.get(5);
    ok("200 帶 paid_from card:成功句寫「已從卡扣」,不照框上的錢包", res && res.kind === "paid" && res.key === "lib.pb.doneCard", JSON.stringify(res)); }

  // ── 錢包不足、有卡 ──
  { const w = world({ LIB: { bal: 10, last4: "4242" } }); const s = S();
    w.sb.libBuyBox(s, "confirm", null, {}); await tick();
    ok("錢包不足有卡:同一個框、付款列寫「卡 ••4242」", w.log.opens === 1 && w.cur().text.includes("付款卡 ••4242") && w.cur().ok === "付 70 TWD", JSON.stringify(w.cur()));
    w.ok(); await tick();
    ok("按一次就扣:直接帶 confirm_topup true＋來源 card(不再出第二段)", w.log.buys.length === 1 && w.log.buys[0].topup === true && w.log.buys[0].box.source === "card" && w.log.buys[0].box.price === 70);
    // ── 失敗:同一個框留著出錯誤句 ──
    w.log.release({ status: 0, body: null }); await tick();
    ok("失敗:框沒關、錯誤句在框底訊息槽、紅記號(.plan-err 不帶 is-calm)、鈕回〔付 70 TWD〕、鎖解開", shown(w) && w.log.closes === 0 && w.log.opens === 1 && w.cur().text.endsWith("購買失敗，請再試一次。")
      && w.cur().cls.includes("plan-err lib-pb-err") && w.cur().ok === "付 70 TWD" && !w.ids["del-scrim"].dataset.lock && !w.ids["del-cancel"].disabled && w.sb.LIB.buying === null, JSON.stringify(w.cur()));
    // ── 重按 → SOURCE_CHANGED:同一個框用 api 回的來源重畫 ──
    w.ok(); await tick();
    w.log.release({ status: 409, body: { error_code: "SOURCE_CHANGED", price_twd: 70, balance_twd: 500, price_source: "wallet", has_card: true } }); await tick();
    ok("SOURCE_CHANGED:沒關、同一個框改寫成錢包、框底訊息槽換成「金額或付款方式剛變了，請再確認。」(灰記號,同一格)、錯誤句拿掉;LIB.bal 跟上", shown(w) && w.log.closes === 0 && w.log.opens === 1
      && w.cur().text.endsWith("金額或付款方式剛變了，請再確認。") && w.cur().cls.includes("plan-err lib-pb-err is-calm") && w.cur().cls.filter((c) => c.includes("lib-pb-err")).length === 1 && w.cur().text.includes("付款錢包") && !w.cur().text.includes("購買失敗") && w.sb.LIB.bal === 500, JSON.stringify(w.cur()));
    w.ok(); await tick();
    ok("重畫後再按:帶新的來源 wallet、confirm_topup false", w.log.buys.length === 3 && w.log.buys[2].topup === false && w.log.buys[2].box.source === "wallet");
    // ── PRICE_CONFIRM_REQUIRED:金額換成 api 回的 ──
    w.log.release({ status: 409, body: { error_code: "PRICE_CONFIRM_REQUIRED", price_twd: 90, balance_twd: 10, price_source: "card", has_card: true } }); await tick();
    ok("PRICE_CONFIRM_REQUIRED:同一個框、鈕〔付 90 TWD〕、付款列回到卡;清單上的價格 s.price 跟著換", shown(w) && w.log.opens === 1 && w.log.closes === 0 && w.cur().ok === "付 90 TWD" && w.cur().text.includes("付款卡 ••4242") && s.price === 90, JSON.stringify(w.cur()));
    w.ok(); await tick();
    ok("再按帶的是新金額 90", w.log.buys[3].box.price === 90 && w.log.buys[3].topup === true);
    w.log.release({ status: 200, body: { status: "ok" } }); await tick();
    const res = w.sb.LIB.bbRes.get(5);
    ok("刷卡成功(舊 api 沒 paid_from → 照框上的卡):一句「已從卡扣 90 TWD。」;整段只開過一次框", res.key === "lib.pb.doneCard" && w.sb.t(res.key, { p: w.sb.libTwd(res.p) }) === "已從卡扣 90 TWD。" && w.log.opens === 1 && w.log.closes === 1, JSON.stringify(res)); }

  // ── 沒末四碼(舊 api) → 綁定的卡;舊 api 的 402 topup → 同一個框改成卡 ──
  { const w = world({ LIB: { bal: 2000 } }); const s = S(); s.price = 1500;
    w.sb.libBuyBox(s, "confirm", null, {}); await tick();
    ok("錢包夠的框", w.cur().text.includes("付款錢包"));
    w.ok(); await tick(); w.log.release({ status: 402, body: { needs_topup: true, has_card: true, balance: 100, required: 1500 } }); await tick();
    ok("舊 api 402 needs_topup(錢包剛被扣走):同一個框改寫成「綁定的卡」＋變動那句,不出舊的第二段框", shown(w) && w.log.opens === 1 && w.log.closes === 0 && w.cur().text.includes("付款綁定的卡") && w.cur().text.includes("金額或付款方式剛變了"), JSON.stringify(w.cur())); }
  { const w = world({ LIB: { bal: 10 } }); const s = S();
    w.sb.libBuyBox(s, "confirm", null, {}); await tick();
    ok("api 還沒回 card_last4:付款列寫「綁定的卡」", w.cur().text.includes("付款綁定的卡"));
    w.ok(); await tick(); w.log.release({ status: 409, body: { error_code: "SOURCE_CHANGED", price_twd: 70, balance_twd: 10, price_source: "none", has_card: false } }); await tick();
    ok("卡沒了(price_source none):關框、轉綁卡即購買", !shown(w) && w.log.bindBuy === 1); }
  { const w = world({ LIB: { bal: 1000 } }); const s = S();
    w.sb.libBuyBox(s, "confirm", null, {}); await tick(); w.ok(); await tick(); w.log.release({ status: 409, body: { error: "purchase already in progress" } }); await tick();
    const b = w.cur();
    ok("一般 409(併發):同一個框、商品與兩列照畫、訊息槽是處理中(灰記號)、只留〔知道了〕,沒有付款鈕", shown(w) && w.log.opens === 1 && w.log.closes === 0 && b.single && !b.stay && b.ok === "知道了"
      && b.text.includes(s.title) && b.text.includes("價格70 TWD") && b.text.includes("付款錢包") && b.text.endsWith(STR.zh["lib.buy.inProgress"]) && b.cls.includes("plan-err lib-pb-err is-calm"), JSON.stringify(b));
    w.ok(); await tick();
    ok("按〔知道了〕:關框、不再送購買", !shown(w) && w.log.buys.length === 1); }
  // ── 錢包是負的(api 409 BALANCE_NEGATIVE,沒扣):同一框、紅記號句、只留〔知道了〕、不重送 ──
  { const w = world({ LIB: { bal: 10, last4: "4242" } }); const s = S();
    w.sb.libBuyBox(s, "confirm", null, {}); await tick(); w.ok(); await tick();
    w.log.release({ status: 409, body: { error: "Settle the negative balance before paying by card.", error_code: "BALANCE_NEGATIVE", balance_twd: -50 } }); await tick();
    const b = w.cur();
    ok("BALANCE_NEGATIVE:不當成處理中;同一個框、訊息槽是「錢包是負的…」紅記號(不帶 is-calm)、主鈕〔前往儲值〕＋取消、沒有「一次付清」;LIB.bal 跟上 -50",
      w.sb.libBuyBranch(409, { error_code: "BALANCE_NEGATIVE" }) === "negative" && shown(w) && w.log.opens === 1 && w.log.closes === 0 && !b.single && !b.stay && b.ok === "前往儲值" && !b.text.includes("一次付清")
      && b.text.endsWith("錢包是負的，先儲值才能刷卡購買。") && b.cls.includes("plan-err lib-pb-err") && !b.text.includes("處理中") && w.sb.LIB.bal === -50, JSON.stringify(b));
    w.ok(); await tick();
    ok("BALANCE_NEGATIVE 按〔前往儲值〕:關框、做 bindGo(\"topup_set\")(同設定頁方案卡)、不重送", !shown(w) && w.log.buys.length === 1 && JSON.stringify(w.log.bindGo) === '["topup_set"]', JSON.stringify(w.log.bindGo)); }
  { const w = world({ LIB: { bal: -50, last4: "4242" } }); const s = S();
    w.sb.libBuyBox(s, "confirm", null, {}); await tick();
    const b = w.cur();
    ok("開框前已知錢包是負的又要走卡:直接畫負餘額那一態(〔前往儲值〕＋取消),不畫〔付 70 TWD〕卡框", w.log.opens === 1 && !b.single && b.ok === "前往儲值" && b.text.endsWith("錢包是負的，先儲值才能刷卡購買。"), JSON.stringify(b));
    w.ok(); await tick();
    ok("負餘額框按〔前往儲值〕不送購買、去儲值", w.log.buys.length === 0 && !shown(w) && JSON.stringify(w.log.bindGo) === '["topup_set"]'); }
  { const w = world({ LIB: { bal: 1000 } }); const s = S();
    w.sb.libBuyBox(s, "confirm", null, {}); await tick(); w.ok(); await tick();
    w.sb.confirmBox({ title: "別的框", lines: ["x"], ok: "好" });
    w.log.release({ status: 409, body: { error_code: "BALANCE_NEGATIVE", balance_twd: -5 } }); await tick();
    const n = w.sb.LIB.bbRes.get(5);
    ok("BALANCE_NEGATIVE 時框已被換掉:句子寫到主鈕下(紅記號)", w.cur().title === "別的框" && n && n.key === "lib.pb.negative" && n.bad === true, JSON.stringify(n)); }
  { const pu = cutFn(src, "libPurchase");
    ok("舊兩段流程(libPurchase)撞到 BALANCE_NEGATIVE 也畫負餘額那一態,不講處理中", /else if \(branch === "negative"\) libBuyOneBox\(s, \{ price: s\.price, source: "card", msg: "negative" \}, opener\);/.test(pu)); }
  // ── B4:新價不是整數 → 退回舊兩段流程,s.price 跟上 ──
  { const w = world({ LIB: { bal: 1000 } }); const s = S();
    w.sb.libBuyBox(s, "confirm", null, {}); await tick(); w.ok(); await tick();
    w.log.release({ status: 409, body: { error_code: "PRICE_CONFIRM_REQUIRED", price_twd: 70.5, balance_twd: 1000, price_source: "wallet", has_card: true } }); await tick();
    ok("409 新價 70.5(非整數):關框、退回舊流程、s.price=70.5,不用舊價重畫一鍵框", !shown(w) && w.log.closes === 1 && w.log.legacy.join() === "confirm" && s.price === 70.5 && w.log.boxes.length === 1, JSON.stringify([w.log, s])); }
  // ── 不一致 2:changed 時有沒有卡也跟上 ──
  { const w = world({ LIB: { bal: 1000, last4: "4242" }, acct: { has_card: false, plan: 1 } }); const s = S();
    w.sb.libBuyBox(s, "confirm", null, {}); await tick(); w.ok(); await tick();
    w.log.release({ status: 409, body: { error_code: "SOURCE_CHANGED", price_twd: 70, balance_twd: 10, price_source: "card", has_card: true } }); await tick();
    ok("SOURCE_CHANGED 來源換成卡:帳號狀態 has_card 改成 true(其他欄位留著)、框寫卡", w.sb.acct.has_card === true && w.sb.acct.plan === 1 && w.cur().text.includes("付款卡 ••4242"), JSON.stringify([w.sb.acct, w.cur()])); }
  // ── 不一致 4:付款中框被別的框換掉 ──
  { const w = world({ LIB: { bal: 1000 } }); const s = S();
    w.sb.libBuyBox(s, "confirm", null, {}); await tick(); w.ok(); await tick();
    w.sb.confirmBox({ title: "別的框", lines: ["x"], ok: "好" });
    w.log.release({ status: 0, body: null }); await tick();
    const n = w.sb.LIB.bbRes.get(5);
    ok("付款中被別的框換掉、結果失敗:不把購買框蓋回去,失敗句寫到主鈕下(紅記號)、鎖與取消／✕ 都解開", w.cur().title === "別的框" && shown(w) && n && n.kind === "note" && n.key === "lib.buy.failed" && n.bad === true
      && !w.ids["del-scrim"].dataset.lock && !w.ids["del-cancel"].disabled && !w.ids["del-close"].disabled, JSON.stringify([w.cur(), n])); }
  { const w = world({ LIB: { bal: 1000 } }); const s = S();
    w.sb.libBuyBox(s, "confirm", null, {}); await tick(); w.ok(); await tick();
    w.sb.confirmBox({ title: "別的框", lines: ["x"], ok: "好" });
    w.log.release({ status: 200, body: { status: "ok" } }); await tick();
    ok("付款中被別的框換掉、結果成功:別的框不被收掉、已購與付完那句照記", shown(w) && w.log.closes === 0 && w.cur().title === "別的框" && s.purchased === true && w.sb.LIB.bbRes.get(5).kind === "paid"); }
  { const w = world({ LIB: { bal: 1000 } }); const s = S();
    w.sb.libBuyBox(s, "confirm", null, {}); await tick(); w.ok(); await tick(); w.log.release({ status: 400, body: { error: "already purchased" } }); await tick();
    ok("已買過(400,這次沒扣):關框、已購,不講扣了多少", !shown(w) && s.purchased === true && !w.sb.LIB.bbRes.has(5)); }

  // ── 開框前餘額沒讀到:先讀再開;讀不到或不知道有沒有卡才退回舊流程 ──
  { let done = null; const w = world({ balance: () => new Promise((res) => { done = res; }) }); const s = S();
    w.sb.libBuyBox(s, "confirm", null, {}); await tick();
    const during = w.sb.LIB.buyRead, syncDuring = w.log.syncRead.includes(5);
    w.sb.libBuyBox(s, "confirm", null, {}); await tick();
    done({ balance: 2000, last4: null }); await tick(); await tick();
    ok("餘額還沒讀:讀的時候 LIB.buyRead=這支並重畫(主鈕 disabled＋轉圈)、重按不重讀;讀到 2000 後解除再開錢包框", during === 5 && syncDuring && w.sb.LIB.buyRead === null
      && w.log.opens === 1 && w.cur().text.includes("付款錢包") && w.log.legacy.length === 0, JSON.stringify(w.log)); }
  { const w = world({ balance: null }); const s = S();
    w.sb.libBuyBox(s, "confirm", null, {}); await tick(); await tick();
    ok("讀不到餘額:退回舊的兩段流程(一鍵框沒開)", w.log.opens === 0 && w.log.legacy.join() === "confirm"); }
  { const w = world({ LIB: { bal: 10 }, acct: null }); const s = S();
    w.sb.libBuyBox(s, "confirm", null, {}); await tick();
    ok("錢包不夠、不知道有沒有卡:退回舊流程,不猜「綁定的卡」", w.log.opens === 0 && w.log.legacy.join() === "confirm"); }
  { const w = world({ LIB: { bal: 10, last4: "4242" }, acct: null }); const s = S();
    w.sb.libBuyBox(s, "confirm", null, {}); await tick();
    ok("帳號狀態還沒回來、但餘額那支回了末四碼:算有卡,開卡的框", w.log.opens === 1 && w.cur().text.includes("付款卡 ••4242") && w.log.legacy.length === 0); }
  { const w = world({ LIB: { bal: 10 }, acct: { has_card: false } }); const s = S();
    w.sb.libBuyBox(s, "confirm", null, {}); await tick();
    ok("錢包不夠、已知沒卡:走舊流程(它收 402 再進綁卡即購買,不跟報價的 HAS_CARD 互丟)", w.log.opens === 0 && w.log.legacy.join() === "confirm"); }

  // ── 主行程:送到 api 的 body、回應白名單、餘額帶末四碼(不起 Electron,切 main.js / balance.js 原文跑) ──
  { const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"), sent = [];
    const M = { sent, API_BASE: "https://api.test", loadToken: () => "acct-A", loadAppSecret: () => "appsec-A", libCache: 1, _balance: { reset() {} },
      postJSON: async (url, body) => { sent.push(body); return { status: 200, body: { status: "ok", paid_from: "card" } }; } };
    vm.createContext(M);
    vm.runInContext(["libCode", "libPurchaseBody"].map((n) => cutFn(mainSrc, n)).join("\n") + "\nasync " + cutFn(mainSrc, "libraryPurchase"), M);
    const r0 = await M.libraryPurchase(5, false); await M.libraryPurchase(5, true, { price: 70, source: "card" }); await M.libraryPurchase(5, false, { price: "70", source: "bank" }); await M.libraryPurchase(5, false, { price: 70.5, source: "wallet" });
    const keys = (b) => Object.keys(b).join();
    ok("main:沒帶框(舊流程)body 跟以前一樣四欄;帶框才加 confirm_price_twd／expected_source;壞值(字串、小數、別的來源)不送",
      keys(sent[0]) === "token,app_secret,strategy_id,confirm_topup" && sent[1].confirm_price_twd === 70 && sent[1].expected_source === "card" && sent[1].confirm_topup === true
      && keys(sent[2]) === "token,app_secret,strategy_id,confirm_topup" && !("confirm_price_twd" in sent[3]) && sent[3].expected_source === "wallet", JSON.stringify(sent));
    const b = M.libPurchaseBody({ error_code: "SOURCE_CHANGED", price_twd: 70, balance_twd: 500.5, price_source: "wallet", has_card: true }), j = M.libPurchaseBody({ error_code: "SOURCE_CHANGED", price_twd: "70", price_source: "bank" });
    ok("main:409 回應留 price_twd／balance_twd／price_source;來源不是 wallet／card／none 就 null、數字不是數字就 null",
      b.price_twd === 70 && b.balance_twd === 500.5 && b.price_source === "wallet" && b.has_card === true && b.error_code === "SOURCE_CHANGED" && j.price_source === null && j.price_twd === null, JSON.stringify([b, j]));
    const pf = [M.libPurchaseBody({ status: "ok", paid_from: "card" }), M.libPurchaseBody({ status: "ok", paid_from: "bank" }), M.libPurchaseBody({ status: "ok" })];
    ok("main:200 的 paid_from 只收 wallet／card,其他與缺欄是 null;libraryPurchase 的回傳帶得到畫面", r0 && r0.status === 200 && r0.body && r0.body.paid_from === "card" && pf[0].paid_from === "card" && pf[1].paid_from === null && pf[2].paid_from === null, JSON.stringify(pf));
    ok("main:balance IPC 原樣交出 balanceHost().read()(last4 跟著到畫面)", /handle\("balance", \(\) => balanceHost\(\)\.read\(\)\);/.test(mainSrc)); }

  // ── 詳情主鈕的原文守門(實畫在 check_shell_library_bindbuy ⑥ 的 paintRun):讀餘額時付費主鈕真 disabled＋鈕內 .spin16、鈕字不換;付完那句無記號 note up＋role=status,裝好收掉 ──
  { const pc = cutFn(src, "libPaintCta");
    ok("讀餘額時:付費主鈕鈕字照舊(buyLabel)、前面插 spin16、disabled", /const pb = btn\("btn-fill", buyLabel\(\)[\s\S]{0,300}if \(LIB\.buyRead === s\.id\) \{ const sp = libEl\("span", "spin16"\);[^\n]*pb\.prepend\(sp\); pb\.disabled = true; \}/.test(pc));
    ok("付完那句:paid 型畫成 p.note.up(12px ink-2、無 fault-mark)、role=status;installed 時從 bbRes 拿掉",
      /bb\.kind === "paid" && c\.state === "installed"\) LIB\.bbRes\.delete\(s\.id\)/.test(pc) && /libEl\("p", "note up", libBbText\(bb\)\)/.test(pc) && /paid\.setAttribute\("role", "status"\)/.test(pc));
    ok("一鍵框原文不再設 del-ok.disabled、不再有 lib-pb-meta", !/ok\.disabled = true/.test(cutFn(src, "libBuyOneGo")) && !/lib-pb-meta/.test(src)
      && !/lib-pb-meta/.test(fs.readFileSync(path.join(R, "library.css"), "utf8"))); }
  // ── 字串:zh／en 都齊(web 同一個框逐字同,清單見回報) ──
  const KEYS = ["lib.pb.negative", "lib.pb.title", "lib.pb.price", "lib.pb.pay", "lib.pb.wallet", "lib.pb.card", "lib.pb.cardAny", "lib.pb.once", "lib.pb.changed", "lib.pb.doneWallet", "lib.pb.doneCard"];
  ok("新字串 zh／en 都有;設計稿那幾句逐字", KEYS.every((k) => typeof STR.zh[k] === "string" && typeof STR.en[k] === "string")
    && STR.zh["lib.pb.title"] === "確認購買" && STR.en["lib.pb.title"] === "Confirm Purchase" && STR.zh["lib.pb.once"] === "一次付清，不續扣。" && STR.en["lib.pb.once"] === "One-time payment in TWD. No renewals."
    && STR.zh["lib.pb.card"] === "卡 {l}" && STR.en["lib.pb.card"] === "Card {l}" && STR.en["lib.pb.pay"] === "Pay with" && STR.en["lib.pb.wallet"] === "Balance"
    && STR.zh["lib.pb.negative"] === "錢包是負的，先儲值才能刷卡購買。" && STR.en["lib.pb.negative"] === "Your balance is negative. Add credit before paying by card." && STR.zh["plan.addCredit"] === "前往儲值");
  console.log(red ? `\n${red} FAIL` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  例外 " + (e && e.stack)); process.exit(1); });
