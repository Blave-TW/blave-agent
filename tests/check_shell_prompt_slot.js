// 側欄提示格(spec sidebar-prompt-slot-2026-11-03 §12):更新壓過手機、一次一則;30 天與第 2 次關;7 個使用日;paired_ever 三態;不畫表逐列;
// 放不下的順序;主行程存檔的形狀;字與埋點。0.1.45 改(spec slot-phone-steps-2026-11-05):沒登入也出、拿掉第一次回覆門檻、pop 依登入狀態換步驟。
// 真的函式配假 DOM,不開 Electron。版面與亮暗由 CDP 實測,不在這裡。
// 跑法:node tests/check_shell_prompt_slot.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const SHELL = path.join(__dirname, "..", "shell");
const read = (f) => fs.readFileSync(path.join(SHELL, f), "utf8");
const src = read("renderer/promptslot.js"), app = read("renderer/app.js"), main = read("main.js"), html = read("renderer/index.html"), css = read("renderer/app.css");
const cut = (s, head) => { const i = s.indexOf(head); if (i < 0) throw new Error("找不到 " + head); let d = 0; for (let k = s.indexOf("{", s.indexOf(")", i)); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("切不出 " + head); };
let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || d === undefined ? "" : "  " + JSON.stringify(d))); if (!ok) red++; };

// 假 DOM:只有 promptslot.js 碰到的那幾顆
// 節點有 children／parent:pop 的內容是 promptslot.js 用 createElement 建的
const mkEl = (id, tag) => { const n = { id, tag: tag || "div", hidden: id === "ph-slot" || id === "ph-pop", attrs: {}, listeners: {}, dataset: {}, children: [], parent: null, className: "", textContent: "",
  style: {}, getBoundingClientRect: () => ({ left: 12, top: 700 }),
  classList: { add(c) { n.className = (n.className + " " + c).trim(); }, contains(c) { return n.className.split(" ").includes(c); } },
  setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(ev, fn) { this.listeners[ev] = fn; }, focus() { doc.lastFocus = id || n; doc.active = n; },
  append(...ks) { for (const k of ks) { k.parent = n; n.children.push(k); } }, replaceChildren(...ks) { for (const k of n.children) k.parent = null; n.children = []; n.append(...ks); },
  all() { return n.children.flatMap((k) => [k, ...(k.all ? k.all() : [])]); }, querySelector(sel) { return n.all().find((k) => k.tag === sel) || null; },
  get text() { return n.children.length ? n.children.map((k) => k.text != null ? k.text : k.textContent).join("") : n.textContent; },
  contains(x) { for (let y = x; y; y = y.parent) if (y === n) return true; return false; } }; return n; };
const dom = {}, doc = { lastFocus: null, visibilityState: "visible", scrims: [], rail: false, listeners: {} };
const $ = (id) => dom[id] || (dom[id] = mkEl(id));
const NOW = new Date(2026, 10, 4, 12, 0, 0).getTime(), DAY = 86400000;
const feat = [], saved = [], signins = [], opened = [];
const STR = vm.runInNewContext(read("renderer/strings.js") + "\nSTRINGS");
const BODY = { id: "body" };
const ctx = { $, Date, Promise, console, Set, Number, Array, String, setTimeout,
  document: { body: BODY, get activeElement() { return doc.active || BODY; }, get visibilityState() { return doc.visibilityState; }, querySelectorAll: (q) => (q === ".scrim" ? doc.scrims : []), documentElement: { classList: { contains: (c) => c === "ws-sc" && doc.rail } },
    addEventListener: (ev, fn) => { doc.listeners[ev] = fn; }, createElement: (tag) => mkEl(null, tag), createElementNS: (ns, tag) => Object.assign(mkEl(null, tag), { ns }), createTextNode: (x) => ({ textContent: x, parent: null }) },
  window: { innerHeight: 800, addEventListener: (ev, fn) => { doc.listeners["win_" + ev] = fn; }, blave: { slotState: async () => ctx.__state, slotPhoneSet: async (p) => { saved.push(p); return p; }, openExternal: (u) => opened.push(u) } },
  LANG: "zh", t: (k) => STR.zh[k] || k, planLoginBusy: false, oauthPending: false, planSignIn: async (b) => { signins.push(b); }, MV_APP_IOS: "IOS_URL", MV_APP_ANDROID: "AND_URL",
  trackFeature: (n) => feat.push(n), setInterval: () => 0, phStateLoad: async () => {},
  upPillNow: () => ({ show: ctx.__up === true }), csAnyTurn: () => ctx.__turn === true, csAnyAwait: () => ctx.__await === true,
  TR_BAGS: { local: { st: null }, cloud: { st: null } }, dataAccessOf: (s) => (s ? s.data_access : null), PH: null, acct: null, acctCard: null, creditCards: [] };
vm.createContext(ctx);
vm.runInContext(cut(app, "function signInLabel("), ctx);   // 真的那支:等待中被重畫要直接畫成「取消等待」
// let／const 留在 vm 的腳本作用域:另外掛一份給測試讀寫
vm.runInContext(src + "\nthis.__x = { SLOT_PH, slotPhPlan, slotPhBlock, slotPhClosed, slotDay, slotPaint, slotLoad, setSt: (s) => { SLOT_ST = s; }, getSt: () => SLOT_ST, resetDay: () => { SLOT_SHOW_DAY = ''; } };", ctx);
const X = ctx.__x, C = X.SLOT_PH;
const P0 = { closes: 0, until: 0, seenDays: [] }, PHOK = { visible: true, signedIn: true, pairedEver: false };
const BLOCKS = { turn: false, awaiting: false, scrim: false, tradeAt: 0, view: false, p1: 0, halt: false, charge: false, acctCard: false, rail: false };
const OUT = { signedIn: false, pairedEver: undefined, visible: false };   // relay.js 沒登入的樣子:總開關問不到、paired_ever 一律 undefined
const plan = (o) => X.slotPhPlan({ up: false, ph: PHOK, prefs: P0, blocks: BLOCKS, now: NOW, seen: true, ...o });
const today = X.slotDay(NOW), days = (n) => Array.from({ length: n }, (_, i) => X.slotDay(NOW - (i + 1) * DAY)).reverse();

// ── 常數(web 要同一份,比對在 check_web_desktop_parity.js)──
t("常數:30 天、2 次、7 個使用日、下單後 30 分鐘", C.COOL_DAYS === 30 && C.MAX_CLOSES === 2 && C.SEEN_DAYS === 7 && C.TRADE_QUIET_MIN === 30);

// ── §1 優先序 ──
t("§1 全部成立 → 畫手機", plan({}).draw === true, plan({}));
t("§1 更新在出 → 手機不畫(更新壓過手機,不疊兩則)", plan({ up: true }).draw === false && plan({ up: true }).why === "up");
t("§1 更新不看不畫表:upPillPlan 不讀提示格(回合中照出)", !/slot/i.test(cut(app, "function upPillPlan(")));
t("§1 upPillPaint 同一拍叫 slotPaint(更新一出手機馬上讓路)", /typeof slotPaint === "function"\) slotPaint\(\)/.test(cut(app, "function upPillPaint(")));

// ── §7 旗標、登入、paired_ever 三態 ──
t("§7 已登入、總開關沒開(PH.visible 不是 true)→ 不畫;主行程讀不到(PH null)→ 不畫", [false, undefined, null, 1, "true"].every((v) => plan({ ph: { ...PHOK, visible: v } }).why === "flag") && plan({ ph: null }).why === "flag");
t("steps §2 沒登入 → 畫:不看總開關、不看 paired_ever", [OUT, { ...OUT, visible: true }, { ...OUT, visible: undefined }, { ...OUT, pairedEver: true }, { signedIn: undefined }].every((ph) => plan({ ph }).draw === true));
t("steps §2 沒登入照樣守冷卻、關兩次、不畫表", plan({ ph: OUT, prefs: { closes: 2, until: 0, seenDays: [] } }).why === "closed" && plan({ ph: OUT, prefs: X.slotPhClosed(P0, NOW) }).why === "cooling" && plan({ ph: OUT, blocks: { ...BLOCKS, turn: true } }).why === "turn");
t("steps §2 已登入、配對過 → 不畫(開關開著也一樣)", plan({ ph: { visible: true, signedIn: true, pairedEver: true } }).why === "paired");
t("steps §2 沒有第一次回覆也畫:blocks 不帶 firstReply、或帶 false", plan({ blocks: BLOCKS }).draw === true && plan({ blocks: { ...BLOCKS, firstReply: false } }).draw === true && plan({ ph: OUT, blocks: { ...BLOCKS, firstReply: undefined } }).draw === true);
t("§7 paired_ever=false → 畫", plan({ ph: { ...PHOK, pairedEver: false } }).draw === true);
t("§7 paired_ever=true → 不畫", plan({ ph: { ...PHOK, pairedEver: true } }).why === "paired");
t("§7 paired_ever 讀不到(undefined／null／怪值)→ 不畫", [undefined, null, 0, "false"].every((v) => plan({ ph: { ...PHOK, pairedEver: v } }).why === "paired"));
t("§7 旗標只有 PH.visible 一把:code 裡沒有另開的開關", /ph\.visible !== true/.test(cut(src, "function slotPhPlan(")) && !/PROMO|FEATURE|localStorage|lsGet/.test(src));
t("主行程交給畫面的白名單帶 pairedEver(relayStateOut 漏了畫面永遠不畫)", /const relayStateOut = \(st\) => \(\{[^\n]*pairedEver: st\.pairedEver/.test(main));

// ── §2 關閉 ──
{ const c1 = X.slotPhClosed(P0, NOW), c2 = X.slotPhClosed(c1, NOW);
  t("§2 第 1 次關:closes 1、30 天後、seenDays 清空", c1.closes === 1 && c1.until === NOW + 30 * DAY && c1.seenDays.length === 0, c1);
  t("§2 第 2 次關:closes 2、不再出", c2.closes === 2 && plan({ prefs: c2, now: NOW + 365 * DAY }).why === "closed", c2);
  t("§2 第 1 次關之後 30 天內不出、剛好 30 天再出", plan({ prefs: c1, now: NOW + 30 * DAY - 1 }).why === "cooling" && plan({ prefs: c1, now: NOW + 30 * DAY }).draw === true); }

// ── §2 使用日 ──
{ const p = plan({ prefs: { ...P0, seenDays: [] } });
  t("§2 今天第一次畫 → 記一天", p.patch && JSON.stringify(p.patch.seenDays) === JSON.stringify([today]), p);
  const q = plan({ prefs: { ...P0, seenDays: [today] } });
  t("§2 同一天再畫 → 不重記", q.draw === true && q.patch === null, q);
  const s6 = plan({ prefs: { ...P0, seenDays: days(6) } });
  t("§2 第 7 個使用日照出、記滿 7 天", s6.draw === true && s6.patch.seenDays.length === 7, s6);
  const s7 = plan({ prefs: { ...P0, seenDays: days(7) } });
  t("§2 第 8 個使用日:自己收 30 天、算關一次、seenDays 清空", s7.draw === false && s7.why === "unclicked" && s7.patch.closes === 1 && s7.patch.until === NOW + 30 * DAY && s7.patch.seenDays.length === 0, s7);
  const s7b = plan({ prefs: { closes: 1, until: 0, seenDays: days(7) } });
  t("§2 已關過一次再自己收 → 第 2 次,不再出", s7b.patch.closes === 2 && plan({ prefs: s7b.patch, now: NOW + 365 * DAY }).why === "closed", s7b);
  const hid = plan({ prefs: { ...P0, seenDays: days(7) }, seen: false });
  t("§2 視窗看不到不算使用日:不記、不收", hid.patch === null && hid.draw === true, hid);
  const blocked = plan({ prefs: { ...P0, seenDays: [] }, blocks: { ...BLOCKS, turn: true } });
  t("§2 被不畫表擋著那天不算使用日", blocked.patch === null && blocked.draw === false, blocked); }

// ── §3 不畫表逐列 ──
{ const rows = [["任何對話在回覆", { turn: true }, "turn"], ["agent 在等用戶回應", { awaiting: true }, "await"], ["確認框開著", { scrim: true }, "scrim"],
    ["啟動下單後未滿 30 分鐘", { tradeAt: NOW - 29 * 60000 }, "trade"], ["看自動下單或策略組合頁", { view: true }, "view"], ["P1 紅點有數", { p1: 1 }, "p1"], ["HALT", { halt: true }, "halt"],
    ["扣款失敗", { charge: true }, "charge"], ["Blave AI 不能跑的卡在畫面上", { acctCard: true }, "acct"], ["側欄收合", { rail: true }, "rail"]];
  for (const [name, b, why] of rows) { const p = plan({ blocks: { ...BLOCKS, ...b } }); t("§3 " + name + " → 不畫", p.draw === false && p.why === why, p); }
  t("§3 啟動下單剛好滿 30 分鐘 → 解除", plan({ blocks: { ...BLOCKS, tradeAt: NOW - 30 * 60000 } }).draw === true); }

// ── §3 每一列接到的真來源 ──
{ const B = cut(src, "function slotBlocks(");
  t("§3 來源:csAnyTurn／csAnyAwait／.scrim／#tr #po／p1／HALT／payment_failed／acctCard／ws-sc;不再讀第一次回覆", /csAnyTurn\(\)/.test(B) && /csAnyAwait\(\)/.test(B) && /querySelectorAll\("\.scrim"\)/.test(B) && /\$\("tr"\)\.hidden/.test(B) && /\$\("po"\)\.hidden/.test(B) && /st\.p1/.test(B) && /halt\.halted/.test(B) && /"payment_failed"/.test(B) && /acctCard\.el\.isConnected/.test(B) && /"ws-sc"/.test(B) && !/firstReply/.test(src));
  const tabs = read("renderer/chattabs.js");
  t("§3 await 同 reply_notif:done 帶 awaiting、不是停止或失敗才算;清 T.awaiting 之前記下來", /T\.waitUser = T\.awaiting === true && !\(res && \(res\.stopped \|\| res\.faulted\)\);\n  T\.awaiting = false;/.test(tabs));
  t("§3 下單時間:只在 trade_started 送出那裡寫(解除暫停不算)", /tm\(\)\.track\("trade_started"[^\n]*uiPrefsPatch\(\{ tradeStartedAt: Date\.now\(\) \}\)/.test(main) && (main.match(/tradeStartedAt: Date\.now/g) || []).length === 1);
  t("§3 P1 讀 p1Badge", /p1: p1Badge/.test(main));
}

// ── 主行程存檔的形狀 ──
{ const clean = new Function(main.match(/const SLOT_DAY_RE = [^\n]+/)[0] + "\n" + cut(main, "function slotPhoneClean(") + "\nreturn slotPhoneClean;")();
  const J = (x) => JSON.stringify(clean(x));
  t("存檔:壞資料一律回乾淨形狀", [null, undefined, 3, "x", [], {}].every((x) => J(x) === JSON.stringify(P0)));
  t("存檔:closes 只收整數、夾在 0–2", clean({ closes: 9 }).closes === 2 && clean({ closes: -1 }).closes === 0 && clean({ closes: 1.5 }).closes === 0 && clean({ closes: "2" }).closes === 0);
  t("存檔:until 只收正數", clean({ until: NaN }).until === 0 && clean({ until: -5 }).until === 0 && clean({ until: 123 }).until === 123);
  t("存檔:seenDays 只留日期格式、去重、最多 7 個", JSON.stringify(clean({ seenDays: ["2026-11-01", "2026-11-01", "<b>", 3] }).seenDays) === '["2026-11-01"]' && clean({ seenDays: Array.from({ length: 12 }, (_, i) => "2026-11-" + String(i + 1).padStart(2, "0")) }).seenDays.length === 7); }

// ── 畫面:slotPaint 與按鈕 ──
(async () => {
  const reset = (st) => { X.setSt(st); X.resetDay(); feat.length = 0; saved.length = 0; ctx.PH = PHOK; ctx.__up = false; ctx.__turn = false; ctx.__await = false; doc.scrims = []; doc.rail = false; doc.lastFocus = null; dom["ph-slot"].hidden = true; dom["ph-pop"].hidden = true; dom["tr"].hidden = true; dom["po"].hidden = true; };
  ["tr", "po", "ph-slot", "ph-pop", "ph-pill", "ph-x", "ws-conn"].forEach($);
  ["ph-pill", "ph-pop", "ph-x"].forEach((id) => { dom[id].parent = dom["ph-slot"]; });   // 同 index.html:三個都在 #ph-slot 裡
  const ST = () => ({ phone: { ...P0 }, tradeAt: 0, p1: 0 });   // 不帶 firstReply:主行程那份有沒有這欄都不影響
  const flush = () => new Promise((r) => setTimeout(r, 5));
  await flush();   // 檔尾開機那一輪 slotLoad 先跑完
  reset(ST()); X.slotPaint(); await flush();
  t("畫面:成立 → 露出、送 slot_ph_show、記今天", dom["ph-slot"].hidden === false && feat.join() === "slot_ph_show" && saved.length === 1 && saved[0].seenDays[0] === X.slotDay(Date.now()), { feat, saved });
  X.slotPaint(); await flush();
  t("畫面:同一天再畫不重送、不重寫", feat.length === 1 && saved.length === 1);
  ctx.__up = true; X.slotPaint();
  t("畫面:更新出現 → 手機收掉", dom["ph-slot"].hidden === true);
  await flush(); reset(ST()); ctx.__turn = true; X.slotPaint(); await flush();
  t("畫面:回合中不畫、不送、不記", dom["ph-slot"].hidden === true && feat.length === 0 && saved.length === 0);
  ctx.__turn = false; dom["tr"].hidden = false; X.slotPaint(); t("畫面:看自動下單頁不畫", dom["ph-slot"].hidden === true); dom["tr"].hidden = true;
  dom["po"].hidden = false; X.slotPaint(); t("畫面:看策略組合頁不畫", dom["ph-slot"].hidden === true); dom["po"].hidden = true;
  doc.scrims = [{ hidden: true }]; X.slotPaint(); t("畫面:藏著的 .scrim 不算", dom["ph-slot"].hidden === false);
  doc.scrims = [{ hidden: true }, { hidden: false }]; X.slotPaint(); t("畫面:開著的 .scrim 算", dom["ph-slot"].hidden === true);
  reset(ST()); doc.rail = true; X.slotPaint(); t("畫面:側欄收合不畫", dom["ph-slot"].hidden === true);
  reset(ST()); ctx.TR_BAGS.cloud.st = { report: { halt: { halted: true } } }; X.slotPaint(); t("畫面:雲端 HALT 也算", dom["ph-slot"].hidden === true); ctx.TR_BAGS.cloud.st = null;
  reset(ST()); vm.runInContext("acct = { data_access: 'payment_failed' }", ctx); X.slotPaint(); t("畫面:扣款失敗不畫", dom["ph-slot"].hidden === true); vm.runInContext("acct = null", ctx);
  reset(ST()); vm.runInContext("acctCard = { el: { isConnected: true } }", ctx); X.slotPaint(); t("畫面:acctCard 在不畫", dom["ph-slot"].hidden === true);
  vm.runInContext("acctCard = { el: { isConnected: false } }", ctx); X.slotPaint(); t("畫面:acctCard 已從畫面拿掉 → 解除", dom["ph-slot"].hidden === false); vm.runInContext("acctCard = null", ctx);
  reset(ST()); vm.runInContext("creditCards = [{ el: { isConnected: true } }]", ctx); X.slotPaint(); t("畫面:回合 402 那張卡也算(canon:Blave AI 不能跑的卡)", dom["ph-slot"].hidden === true); vm.runInContext("creditCards = []", ctx);
  await flush(); reset(ST()); doc.visibilityState = "hidden"; X.slotPaint(); await flush();
  t("畫面:視窗看不到 → 不送 show、不記使用日", dom["ph-slot"].hidden === false && feat.length === 0 && saved.length === 0); doc.visibilityState = "visible";

  // 按膠囊
  await flush();
  reset({ ...ST(), phone: { closes: 1, until: 0, seenDays: days(3) } }); X.slotPaint(); await flush(); feat.length = 0; saved.length = 0;
  dom["ph-pill"].listeners.click(); await flush();
  t("按膠囊:開 popover、aria-expanded、slot_ph_open、使用日歸零", dom["ph-pop"].hidden === false && dom["ph-pill"].attrs["aria-expanded"] === "true" && feat.join() === "slot_ph_open" && saved[saved.length - 1].seenDays.length === 0 && saved[saved.length - 1].closes === 1, { feat, saved });
  doc.listeners.keydown({ key: "a", stopPropagation() {} });
  t("popover:其他鍵不收", dom["ph-pop"].hidden === false);
  let stopped = false; doc.listeners.keydown({ key: "Escape", stopPropagation() { stopped = true; } });
  t("popover:Esc 收、焦點回膠囊、Esc 不往外傳", dom["ph-pop"].hidden === true && doc.lastFocus === "ph-pill" && stopped);
  stopped = false; doc.listeners.keydown({ key: "Escape", stopPropagation() { stopped = true; } });
  t("popover 沒開時 Esc 不攔", stopped === false);
  dom["ph-pill"].listeners.click(); doc.lastFocus = null; doc.listeners.pointerdown({ target: dom["ph-pop"] }); t("popover:點裡面不收", dom["ph-pop"].hidden === false);
  doc.active = null; doc.listeners.pointerdown({ target: dom["tr"] }); await flush();
  t("popover:點外面(沒有東西接焦點)收、焦點回膠囊", dom["ph-pop"].hidden === true && doc.lastFocus === "ph-pill");
  dom["ph-pill"].listeners.click(); doc.lastFocus = null; const ta = { id: "ta" }; doc.active = ta; doc.listeners.pointerdown({ target: ta }); await flush();
  t("popover:點到輸入框收,焦點留在輸入框", dom["ph-pop"].hidden === true && doc.lastFocus === null); doc.active = null;
  dom["ph-pill"].listeners.click();
  t("popover:fixed 定位在膠囊上方 8(側欄裁切不到)", dom["ph-pop"].style.left === "12px" && dom["ph-pop"].style.bottom === "108px" && /position: fixed/.test(css));
  doc.listeners.win_resize(); t("popover:視窗縮放收掉", dom["ph-pop"].hidden === true);
  dom["ph-pill"].listeners.click(); ctx.__turn = true; X.slotPaint(); t("popover:膠囊被收掉時一起收", dom["ph-pop"].hidden === true && dom["ph-slot"].hidden === true); ctx.__turn = false;
  // 按 ×
  reset(ST()); X.slotPaint(); await flush(); feat.length = 0; saved.length = 0; dom["ph-x"].listeners.click(); await flush();
  t("×:送 slot_ph_close、存第 1 次關、膠囊收掉、焦點到〔設定〕", feat.join() === "slot_ph_close" && saved[saved.length - 1].closes === 1 && saved[saved.length - 1].until > Date.now() && dom["ph-slot"].hidden === true && doc.lastFocus === "ws-conn", { feat, saved });
  // ── steps §2、§3:沒登入也出、pop 依登入狀態換內容 ──
  { const steps = () => { const ol = dom["ph-pop"].children[0]; return ol ? ol.children : []; };
    const stepText = (li) => li.children.slice(1).map((k) => k.text).join("|");
    const btns = () => dom["ph-pop"].all().filter((k) => k.tag === "button");
    await flush(); reset(ST()); ctx.PH = OUT; X.slotPaint(); await flush();
    t("steps 畫面:沒登入、主行程那份沒有 firstReply → 膠囊露出、送 slot_ph_show", dom["ph-slot"].hidden === false && feat.join() === "slot_ph_show", { feat });
    reset(ST()); ctx.PH = { visible: true, signedIn: true, pairedEver: true }; X.slotPaint(); t("steps 畫面:已登入配對過 → 不出", dom["ph-slot"].hidden === true);
    reset(ST()); ctx.PH = { visible: true, signedIn: true, pairedEver: undefined }; X.slotPaint(); t("steps 畫面:已登入、paired_ever 還沒問到 → 不出", dom["ph-slot"].hidden === true);
    reset(ST()); ctx.PH = OUT; X.slotPaint(); feat.length = 0;
    dom["ph-pill"].listeners.click(); await flush();
    const s1 = steps();
    const states = (ls) => ls.map((li) => ["done", "now", "next"].filter((c) => li.classList.contains(c)).join("+")).join();
    const cur = (ls) => ls.map((li) => li.attrs["aria-current"] || "-").join();
    t("v2 §2 沒登入 pop:四步 now,next,next,next(只有一步 now);1〔登入 Blave〕是描邊鈕 btn-out,4 是按〔打開〕", s1.length === 4 && states(s1) === "now,next,next,next" && cur(s1) === "step,-,-,-"
      && btns().length === 1 && btns()[0].className === "btn-out" && btns()[0].textContent === "登入 Blave" && stepText(s1[1]) === "下載 App" && stepText(s1[2]) === "在 App 配對" && stepText(s1[3]) === STR.zh["ph.stepAllow"] && s1.map((li) => li.children[0].textContent).join() === "1,2,3,4", [states(s1), cur(s1), s1.map(stepText)]);
    const sb = btns()[0]; sb.listeners.click(); await flush();
    t("steps §4 按〔登入 Blave〕:走 planSignIn(同一顆鈕)、送 slot_ph_login", signins.length === 1 && signins[0] === sb && feat.includes("slot_ph_login"), { feat });
    feat.length = 0; ctx.planLoginBusy = true; ctx.oauthPending = true; sb.listeners.click(); await flush();
    t("steps §4 等待中再按是取消:照走 planSignIn,不再送 slot_ph_login", signins.length === 2 && !feat.includes("slot_ph_login"));
    // 等待中:pop 收掉再開(同一個登入狀態不重建),鈕還是同一顆
    t("steps §3 狀態沒變不重建:同一顆鈕", (X.slotPaint(), btns()[0] === sb));
    // 登入完成:主行程推 signedIn=true、paired_ever=false;pop 開著原地換,不收,焦點接到 pop 第一個能按的
    sb.focus(); ctx.planLoginBusy = false; ctx.oauthPending = false;
    ctx.PH = { visible: true, signedIn: true, pairedEver: false }; X.slotPaint(); await flush();
    const s2 = steps(), b2 = btns();
    const disc = (li) => li.children[0], check = (li) => { const sv = disc(li).children[0]; return !!sv && sv.tag === "svg" && /svg/.test(sv.ns) && sv.attrs.class === "ic" && sv.children[0] && sv.children[0].attrs.d === "M20 6 9 17l-5-5"; };
    t("v2 §2 登入完成 pop 開著:原地換成四步 done,now,next,next(0.1.45 的兩個 now 拿掉)、不收", dom["ph-pop"].hidden === false && dom["ph-slot"].hidden === false && s2.length === 4 && states(s2) === "done,now,next,next" && cur(s2) === "-,step,-,-"
      && stepText(s2[3]) === STR.zh["ph.stepAllow"] && s2.slice(1).map((li) => disc(li).textContent).join() === "2,3,4", [states(s2), cur(s2), s2.map(stepText)]);
    t("v2 §3 done 那步:盤裡是 Lucide check 的 svg(不是號碼)、字「已登入」;api 沒帶 email 就只寫已登入", check(s2[0]) && disc(s2[0]).textContent === "" && s2[0].children[1].className === "ph-t" && s2[0].children[1].text === "已登入" && !s2[0].children[1].children.some((k) => k.className === "ph-who") && !s2.slice(1).some(check));
    t("steps §2 登入完成:焦點落在 pop 第一個能按的(App Store)", doc.active === b2[0]);
    const img = dom["ph-pop"].all().find((k) => k.tag === "img");
    t("v2 §3 已登入 pop:2 下載 App + 白底 plate 的 QR 112(qr-app.svg、alt 空)+ App Store、Google Play 兩顆 btn-quiet", stepText(s2[1]).startsWith("下載 App") && img && img.src === "qr-app.svg" && img.width === 112 && img.height === 112 && img.alt === "" && img.parent.className === "ph-plate"
      && b2.length === 2 && b2.every((b) => b.className === "btn-quiet") && b2[0].textContent === "App Store" && b2[1].textContent === "Google Play");
    t("v2 §3 已登入 pop:3 在 App 的 Agent 分頁按〔對話〕配對(無句號),〔對話〕連前一個字不斷行;4〔打開〕也連前一個字", s2[2].children[1].text === "在 App 的 Agent 分頁按〔對話〕配對" && s2[2].all().some((k) => k.className === "ph-nw" && k.textContent === "按〔對話〕") && s2[3].all().some((k) => k.className === "ph-nw" && k.textContent === "按〔打開〕"));
    // 稽核建議 1:en 只包鈕名(Chat、Turn On=ph.ask.ok),其餘字照常斷行
    { ctx.LANG = "en"; ctx.t = (k) => STR.en[k] || k; X.slotPaint();
      const ls = steps(), nw = (li) => li.all().filter((k) => k.className === "ph-nw").map((k) => k.textContent);
      t("稽核 1:en〔Chat〕〔Turn On〕包 ph-nw、整句字不變", nw(ls[2]).join() === "Chat" && nw(ls[3]).join() === "Turn On" && ls[2].children[1].text === STR.en["ph.stepChat"] && ls[3].children[1].text === STR.en["ph.stepAllow"], [nw(ls[2]), nw(ls[3])]);
      ctx.LANG = "zh"; ctx.t = (k) => STR.zh[k] || k; X.slotPaint(); }
    // email:account_status 帶回來才出;換 email 要重建(key 帶 email)
    // 稽核建議 2:email 晚到(account_status 回來)只原地補那一行,<ol> 與鈕都是同一顆、焦點留在原處(這裡放在 Google Play)
    { const olBefore = dom["ph-pop"].children[0], gp = btns()[1]; gp.focus();
      ctx.acct = { email: "a.very.long.name@blave.org" }; X.slotPaint();
      const ls = steps(), d = ls[0].children[1], who = d.children.find((k) => k.className === "ph-who");
      t("v2 §3 account_status 帶 email:done 那步下面小字 ph-who、title 放完整 email", states(ls) === "done,now,next,next" && !!who && who.textContent === "a.very.long.name@blave.org" && who.title === "a.very.long.name@blave.org" && d.text.startsWith("已登入"), d.children.map((k) => k.className));
      t("稽核 2:email 晚到不重建 pop(同一個 <ol>、同一顆鈕)、焦點不搬(留在 Google Play)", dom["ph-pop"].children[0] === olBefore && btns()[1] === gp && doc.active === gp);
      ctx.acct = { email: "b@blave.org" }; X.slotPaint(); t("稽核 2:email 換了也只換那一行", dom["ph-pop"].children[0] === olBefore && steps()[0].children[1].children.find((k) => k.className === "ph-who").textContent === "b@blave.org" && doc.active === gp); }
    const noWho = () => !steps()[0].children[1].children.some((k) => k.className === "ph-who");
    ctx.acct = { email: "  " }; X.slotPaint(); t("v2 §3 email 空白:不畫那一行(原地拿掉)", noWho());
    ctx.acct = { email: 42 }; X.slotPaint(); t("v2 §3 email 不是字串:不畫那一行", noWho());
    ctx.acct = null; X.slotPaint();
    feat.length = 0; b2[0].listeners.click(); b2[1].listeners.click();
    t("steps §4 商店連結沿用 app_link_ios／app_link_android,外開 MV_APP_*", feat.join() === "app_link_ios,app_link_android" && opened.join() === "IOS_URL,AND_URL", { feat, opened });
    t("steps §3 pop 沒有 role=dialog、不搶焦點(disclosure 寫法維持)", !/role/.test(src) && !/ph-pop[^\n]*role=/.test(html));
    ctx.PH = { visible: true, signedIn: true, pairedEver: false, on: true }; X.slotPaint();
    t("v2 允許手機對話已開:已登入不列〔打開〕那步、剩三步 done,now,next", steps().length === 3 && states(steps()) === "done,now,next" && !steps().some((li) => stepText(li) === STR.zh["ph.stepAllow"]));
    ctx.PH = { visible: true, signedIn: true, pairedEver: false }; X.slotPaint();
    t("steps 開關關回去:那步又出來", steps().length === 4);
    t("稽核 4:號碼盤 aria-hidden(<ol> 已經念號碼,不念兩次;打勾那顆也是)", steps().every((li) => li.children[0].className === "ph-n" && li.children[0].attrs["aria-hidden"] === "true"));
    // 稽核 2:焦點在 pop 裡、膠囊整個收掉(登入後發現配對過)→ 焦點到〔設定〕,不掉到 BODY
    doc.lastFocus = null; btns()[0].focus(); ctx.PH = { visible: true, signedIn: true, pairedEver: true }; X.slotPaint();
    t("稽核 2:焦點在 pop 裡、膠囊收掉 → 焦點到〔設定〕", dom["ph-slot"].hidden === true && doc.lastFocus === "ws-conn");
    ctx.PH = { visible: true, signedIn: true, pairedEver: false }; X.slotPaint(); doc.lastFocus = null; const ta2 = { id: "ta2" }; doc.active = ta2; ctx.PH = { visible: true, signedIn: true, pairedEver: true }; X.slotPaint();
    t("稽核 2:焦點不在提示格裡(在輸入框)→ 收掉也不搶", dom["ph-slot"].hidden === true && doc.lastFocus === null && doc.active === ta2);
    ctx.PH = { visible: true, signedIn: true, pairedEver: false }; X.slotPaint(); dom["ph-pill"].listeners.click();
    // 換回沒登入(登出):pop 收著時換內容,不碰焦點
    doc.listeners.keydown({ key: "Escape", stopPropagation() {} }); doc.active = null; ctx.PH = OUT; X.slotPaint();
    t("steps 登出後:pop 收著也換回四步 now,next,next,next、焦點不動", steps().length === 4 && states(steps()) === "now,next,next,next" && doc.active === null);
    ctx.PH = { ...OUT, on: true }; X.slotPaint();
    t("steps 允許手機對話已開:沒登入也不列〔打開〕那步、剩三步", steps().length === 3 && steps().map((li) => li.children[0].textContent).join() === "1,2,3");
    ctx.PH = PHOK; }
  // 主行程讀不到
  reset(null); X.slotPaint(); t("主行程那份還沒拿到 → 不畫", dom["ph-slot"].hidden === true);
  ctx.__state = undefined; await X.slotLoad(); t("slotState 回空(舊 preload、handle 拒絕)→ 不畫、不拋", dom["ph-slot"].hidden === true && X.getSt() === null);

  // ── 放不下的順序(canon):全句帶圖示 → 短句帶圖示 → 短句不帶圖示 ──
  { const fit = (limitWithIc, limitNoIc, version) => {
      const classes = new Set(); const pill = { offsetParent: {}, title: "", attrs: {}, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
      const txt = { textContent: "", get clientWidth() { return classes.has("no-ic") ? limitNoIc : limitWithIc; }, get scrollWidth() { return this.textContent.length; } };
      const env = { $: (id) => (id === "up-pill" ? pill : txt), upPillNow: () => ({ show: true, kind: "ready", ask: false }), UP: { version }, t: (k, v) => ({ "up.pillV": "RRRRRRRRRR:" + (v && v.v), "up.pillS": "U:" + (v && v.v), "up.pill": "RRRRRRRRRR", "busy.update": "b" })[k] };
      new Function("env", "with (env) { " + cut(app, "function upPillLabel(") + "\n" + cut(app, "function upPillFit(") + "\n upPillFit(); }")(env);
      return { text: txt.textContent, noIc: classes.has("no-ic"), title: pill.title, aria: pill.attrs["aria-label"] }; };
    const full = "RRRRRRRRRR:0.1.45", short = "U:0.1.45";
    let r = fit(99, 99, "0.1.45"); t("放得下:全句帶圖示", r.text === full && !r.noIc && !r.aria, r);
    r = fit(10, 12, "0.1.45"); t("全句放不下:先換短字、圖示留著;全句放 title 與可及名稱", r.text === short && !r.noIc && r.title === full && r.aria === full, r);
    r = fit(5, 10, "0.1.45"); t("短字也放不下:才拿圖示", r.text === short && r.noIc, r);
    r = fit(5, 99, null); t("沒有版號就沒有短字:全句不帶圖示", r.text === "RRRRRRRRRR" && r.noIc, r); }

  // ── 長相與字 ──
  { const rule = (sel) => { const m = new RegExp("^" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{([^}]*)\\}", "m").exec(css); return m ? m[1] : ""; };
    const pill = rule(".ph-pill"), up = rule(".up-pill");
    t("膠囊:高 32、內距左 12 右 14、圖示間距 8、半徑 pill、卡面底、shadow-sm、字 ink", /height: 32px/.test(pill) && /padding: 0 14px 0 var\(--space-12\)/.test(pill) && /gap: var\(--space-8\)/.test(pill) && /--radius-pill/.test(pill) && /--surface-card/.test(pill) && /--shadow-sm/.test(pill) && /color: var\(--ink\)/.test(pill));
    t("更新膠囊:wrap 拿掉左右內距;內距加框 1 = 左 12 右 14、間距 8", /^\.up-pill-wrap \{ margin: 0 0 var\(--space-8\); \}/m.test(css) && /padding: 0 13px 0 11px/.test(up) && /gap: var\(--space-8\)/.test(up));
    t("× 視覺 24、熱區 44;滑過或焦點才出,觸控常駐", /width: 24px; height: 24px/.test(rule(".ph-x")) && /inset: -10px/.test(rule(".ph-x::before")) && /opacity: 0/.test(rule(".ph-x")) && /\.ph-slot:hover \.ph-x, \.ph-x:focus-visible \{ opacity: 1; \}/.test(css) && /@media \(hover: none\) \{ \.ph-x \{ opacity: 1; \} \}/.test(css));
    t("v2 popover 寬 240、內距 16、卡面底、shadow-md;QR 112 白底 plate", /width: 240px/.test(rule(".ph-pop")) && /padding: var\(--space-16\)/.test(rule(".ph-pop")) && /--surface-card/.test(rule(".ph-pop")) && /--shadow-md/.test(rule(".ph-pop")) && /--color-pureWhite/.test(rule(".ph-plate")) && /width: 112px; height: 112px/.test(rule(".ph-plate img")));
    t("v2 pop 開著膠囊用按下的底色(同 hover);沒有縮放", css.includes('.ph-pill[aria-expanded="true"] { background: var(--surface-control-on); }') && !/\.ph-pill[^{]*\{[^}]*scale/.test(css));
    t("手機膠囊與 popover 不用橘(canon 橘只給更新膠囊)", !/primary/.test(pill + rule(".ph-pop") + rule(".ph-x")));
    t("提示格在 .ws-foot 裡、〔設定〕正上方(細軌時跟著藏);更新在前,手機在後", (() => { const f = html.indexOf('class="ws-foot"'), u = html.indexOf('id="up-pill-wrap"'), p = html.indexOf('id="ph-slot"'), s = html.indexOf('id="ws-conn"'); return f >= 0 && f < u && u < p && p < s; })() && /html\.ws-sc \.ws-foot[^{]*\{ display: none; \}|html\.ws-sc \.strat-head, html\.ws-sc \.strat-list, html\.ws-sc \.ws-foot \{ display: none; \}/.test(css));
    t("手機圖示維持 lucide smartphone", /id="ph-pill"[^\n]*<rect width="14" height="20" x="5" y="2" rx="2"\/><path d="M12 18h\.01"\/>/.test(html));
    const qr = read("renderer/qr-app.svg");
    t("QR 是靜態檔,內容註明在檔頭;不加執行期相依", /^<!-- https:\/\/blave\.org\/app\?src=desktop -->/.test(qr) && /img\.src = "qr-app\.svg"/.test(src) && !/qr/i.test(JSON.stringify(JSON.parse(read("package.json")).dependencies)));
    t("pop 在 html 是空殼、緊接膠囊(Tab 從膠囊直接進 pop),內容由 promptslot.js 建", /id="ph-pill"[^\n]*<\/button>\n\s*<div class="ph-pop" id="ph-pop" hidden><\/div>\n\s*<button class="ph-x"/.test(html));
    t("v2 步驟列:號碼盤 20、欄距 12(稽核建議 3,回到 4 的倍數)、列距 16;盤 pill、11/600 tabular", /gap: var\(--space-16\)/.test(rule(".ph-steps")) && /grid-template-columns: 20px minmax\(0, 1fr\); column-gap: var\(--space-12\)/.test(rule(".ph-step"))
      && /width: 20px; height: 20px; border-radius: var\(--radius-pill\)/.test(rule(".ph-n")) && /font-size: 11px; font-weight: 600;[^}]*tabular-nums/.test(rule(".ph-n")));
    t("v2 三態只用墨色:next 空心框 --border-frame、號碼 --ink-3;done／now 實心 --control-fill;勾 12、線寬 3;不用綠橘", /color: var\(--ink-3\); box-shadow: inset 0 0 0 1px var\(--border-frame\)/.test(rule(".ph-n"))
      && css.includes(".ph-step.done .ph-n, .ph-step.now .ph-n { background: var(--control-fill); color: var(--control-fill-text); box-shadow: none; }") && /width: 12px; height: 12px;[^}]*stroke-width: 3/.test(rule(".ph-n .ic"))
      && !/primary|green|orange|red/i.test([".ph-n", ".ph-step.done .ph-n, .ph-step.now .ph-n", ".ph-t", ".ph-step.now .ph-t", ".ph-step.done .ph-t", ".ph-who"].map(rule).join()));
    t("v2 字色:next --ink-2、now --ink 500、done --ink-3;email 12/18 --ink-3 單行省略;zh 斷行 pretty", /color: var\(--ink-2\)/.test(rule(".ph-t")) && /color: var\(--ink\); font-weight: 500/.test(rule(".ph-step.now .ph-t")) && /color: var\(--ink-3\)/.test(rule(".ph-step.done .ph-t"))
      && /font-size: 12px; line-height: 18px; color: var\(--ink-3\); overflow: hidden; text-overflow: ellipsis; white-space: nowrap/.test(rule(".ph-who")) && css.includes(".ph-t:lang(zh) { text-wrap: pretty; }"));
    const strs = vm.runInNewContext(read("renderer/strings.js") + "\nSTRINGS");
    t("字:zh／en 照 spec,× 用既有 set.close", strs.zh["ph.slot"] === "在手機上用" && strs.en["ph.slot"] === "Use on Phone" && /id="ph-x"[^>]*data-i18n-aria="set\.close"/.test(html) && strs.zh["set.close"] === "關閉" && strs.en["set.close"] === "Close");
    t("字:pop 步驟照 steps §3(EN 句首大寫);ph.slotHint 已拿掉", strs.zh["ph.stepGet"] === "下載 App" && strs.en["ph.stepGet"] === "Get the app" && strs.zh["ph.stepPair"] === "在 App 配對" && strs.en["ph.stepPair"] === "Pair in the app"
      && strs.zh["ph.stepChat"] === "在 App 的 Agent 分頁按〔對話〕配對" && strs.en["ph.stepChat"] === "In the app's Agent tab, tap Chat to pair" && strs.zh["ph.signed"] === "已登入" && strs.en["ph.signed"] === "Signed in" && !("ph.slotHint" in strs.zh) && !("ph.slotHint" in strs.en) && strs.zh["pv.signin"] === "登入 Blave");
    t("v2 字:按〔打開〕那步縮成短標籤(無句號),鈕名跟配對確認框 ph.ask.ok 逐字相同", strs.zh["ph.stepAllow"] === "電腦跳出確認時，按〔打開〕" && strs.zh["ph.stepAllow"].endsWith("〔" + strs.zh["ph.ask.ok"] + "〕")
      && strs.en["ph.stepAllow"] === "When this computer asks, choose Turn On" && strs.en["ph.stepAllow"].endsWith("choose " + strs.en["ph.ask.ok"])); }

  // ── 埋點 ──
  const tele = read("telemetry.js");
  t("埋點:五個名字連在 feature_used 白名單、順序同 spec", /"slot_up_show", "slot_up_open", "slot_ph_show", "slot_ph_open", "slot_ph_close"[,\]]/.test(tele));
  t("埋點:slot_ph_login 在白名單(steps §4)", /"slot_ph_login"/.test(tele));
  t("埋點:更新膠囊畫出與按下(細軌圓鈕不算提示格)", /pill\.offsetParent !== null && upPillPaint\.shownVer !== upVer\) \{ upPillPaint\.shownVer = upVer; trackFeature\("slot_up_show"\); \}/.test(cut(app, "function upPillPaint(")) && /if \(btn === \$\("up-pill"\)\) trackFeature\("slot_up_open"\)/.test(cut(app, "function upPillClick(")));
  // 真的 upPillPaint 配假 DOM:同一版重畫只送一次,換版才再送;藏起來(細軌)不算
  { const el = () => ({ hidden: false, disabled: false, offsetParent: {}, dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {} });
    const dom = { "up-pill": el(), "up-pill-wrap": el(), "up-dot": el(), "up-pill-t": el(), "up-pill-why": el() }, sent = [];
    const ctx = { $: (id) => dom[id] || el(), UP: { version: "0.1.46" }, trackFeature: (n) => sent.push(n), upPillNow: () => ({ show: true, kind: "ready" }), upPillLabel: () => "x", t: (k) => k, busyLock() {}, upPillFit() {}, lsGet: () => new Date().toDateString(), lsSet() {}, UP_PILL_DAY_KEY: "k", Date };
    const paint = new Function("ctx", "with (ctx) { " + cut(app, "function upPillPaint(") + "\nreturn upPillPaint; }")(ctx);
    const shows = () => sent.filter((n) => n === "slot_up_show").length;
    paint(); paint(); paint();
    t("slot_up_show:同一版重畫三次只送一次", shows() === 1, sent);
    ctx.UP = { version: "0.1.47" }; paint(); paint();
    t("slot_up_show:換版再送一次", shows() === 2, sent);
    dom["up-pill"].offsetParent = null; ctx.UP = { version: "0.1.48" }; paint();
    t("slot_up_show:膠囊沒畫出(細軌)不送,也不佔掉這一版", shows() === 2, sent);
    dom["up-pill"].offsetParent = {}; paint();
    t("slot_up_show:畫出來才算這一版的那一次", shows() === 3, sent); }
  console.log(red ? `\n${red} 條沒過` : "\n全過"); process.exit(red ? 1 : 0);
})();
