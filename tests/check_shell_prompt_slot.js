// 左下角一列(spec sidebar-conversion-2026-11-10 §2–§8、§12):帳號那一格逐值對 planView()、按下去走哪支;手機圖示六條各拿掉一條都不出;
// 放不下時手機讓位;步驟框只剩已登入那一版;更新圓鈕原因句出在列上方;§6.1 重開授權頁只開主行程自己存的網址;字與埋點;長相的數字。
// 真的函式配假 DOM,不開 Electron。量真的寬度(180／236／400、zh／en、Windows)要開窗,不在這裡。
// 跑法:node tests/check_shell_prompt_slot.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const SHELL = path.join(__dirname, "..", "shell");
const read = (f) => fs.readFileSync(path.join(SHELL, f), "utf8");
const src = read("renderer/promptslot.js"), app = read("renderer/app.js"), main = read("main.js"), pre = read("preload.js"), html = read("renderer/index.html"), css = read("renderer/app.css"), tele = read("telemetry.js");
const cut = (s, head) => { const i = s.indexOf(head); if (i < 0) throw new Error("找不到 " + head); let d = 0; for (let k = s.indexOf("{", s.indexOf(")", i)); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("切不出 " + head); };
let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || d === undefined ? "" : "  " + JSON.stringify(d))); if (!ok) red++; };
const STR = vm.runInNewContext(read("renderer/strings.js") + "\nSTRINGS");

// ── 假 DOM:promptslot.js 與 sideCvPaint 碰到的節點;pop 內容是 createElement 建的 ──
const mkEl = (id, tag) => { const n = { id, tag: tag || "div", hidden: false, attrs: {}, listeners: {}, dataset: {}, children: [], parent: null, className: "", textContent: "", title: "", w: 0,
  style: {}, getBoundingClientRect: () => ({ left: 12, top: 700, width: n.w }),
  classList: { add(c) { n.className = (n.className + " " + c).trim(); }, contains(c) { return n.className.split(" ").includes(c); } },
  setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, addEventListener(ev, fn) { this.listeners[ev] = fn; }, focus() { doc.lastFocus = id || n; doc.active = n; },
  append(...ks) { for (const k of ks) { k.parent = n; n.children.push(k); } }, replaceChildren(...ks) { for (const k of n.children) k.parent = null; n.children = []; n.append(...ks); },
  all() { return n.children.flatMap((k) => [k, ...(k.all ? k.all() : [])]); }, querySelector(sel) { return n.all().find((k) => k.tag === sel) || null; },
  get text() { return n.children.length ? n.children.map((k) => k.text != null ? k.text : k.textContent).join("") : n.textContent; },
  contains(x) { for (let y = x; y; y = y.parent) if (y === n) return true; return false; } }; return n; };
const dom = {}, doc = { lastFocus: null, active: null, visibilityState: "visible", rail: false, listeners: {} };
const $ = (id) => dom[id] || (dom[id] = mkEl(id));
// 列的順序同 index.html:齒輪、手機、pop、帳號膠囊、灰字、更新。寬與 margin:齒輪 28、手機 16+28、膠囊 8+寬、更新 8+28
const ROW = ["ws-conn", "ph-pill", "ph-pop", "side-cv", "side-note", "up-pill"];
ROW.forEach((id) => { $(id).parent = $("foot-row"); $("foot-row").children.push($(id)); });
const STYLE = { "ph-pill": { marginLeft: "16px" }, "side-cv": { marginLeft: "8px" }, "side-note": { marginLeft: "8px" }, "up-pill": { marginLeft: "8px" }, "ph-pop": { position: "fixed" }, "foot-row": { paddingLeft: "6px" } };
const getComputedStyle = (el) => ({ display: el.hidden ? "none" : "flex", position: "static", marginLeft: "0px", marginRight: "0px", paddingLeft: "0px", ...(STYLE[el.id] || {}) });
const feat = [], opened = [];
const BODY = { id: "body" };
const ctx = { $, Date, Promise, console, Set, Number, Array, String, Object, JSON, setTimeout, parseFloat, getComputedStyle,
  document: { body: BODY, get activeElement() { return doc.active || BODY; }, get visibilityState() { return doc.visibilityState; }, documentElement: { classList: { contains: (c) => c === "ws-sc" && doc.rail } },
    addEventListener: (ev, fn) => { doc.listeners[ev] = fn; }, createElement: (tag) => mkEl(null, tag), createElementNS: (ns, tag) => Object.assign(mkEl(null, tag), { ns }), createTextNode: (x) => ({ textContent: x, parent: null }) },
  window: { innerHeight: 800, addEventListener: (ev, fn) => { doc.listeners["win_" + ev] = fn; }, blave: { openExternal: (u) => opened.push(u) } },
  LANG: "zh", t: (k, v) => { let s = STR[ctx.LANG][k]; if (s == null) return k; if (v) for (const x in v) s = s.split("{" + x + "}").join(v[x]); return s; },
  MV_APP_IOS: "IOS_URL", MV_APP_ANDROID: "AND_URL", trackFeature: (n) => feat.push(n), phStateLoad: async () => {},
  PH: null, acct: null, authRevoked: () => ctx.__revoked === true };
vm.createContext(ctx);
vm.runInContext(src + "\nthis.__x = { slotPhPlan, slotRowFits, slotPaint, resetDay: () => { SLOT_SHOW_DAY = ''; } };", ctx);
const X = ctx.__x;
const PHOK = { visible: true, signedIn: true, pairedEver: false };
const OK = { ph: PHOK, revoked: false, rail: false, fits: true };
const flush = () => new Promise((r) => setTimeout(r, 5));

// ── §3.2 六條:全成立才出;各單獨拿掉一條都不出 ──
t("§3.2 六條都成立 → 出", X.slotPhPlan(OK).draw === true);
{ const knock = [["1 沒登入(signedIn 不是 true)", { ph: { ...PHOK, signedIn: false } }], ["1 主行程讀不到(PH null)", { ph: null }], ["2 登入失效", { revoked: true }],
    ["3 總開關沒開", { ph: { ...PHOK, visible: false } }], ["4 配對過", { ph: { ...PHOK, pairedEver: true } }], ["4 paired_ever 讀不到當配對過", { ph: { ...PHOK, pairedEver: undefined } }],
    ["5 側欄收合", { rail: true }], ["6 放不下四樣", { fits: false }]];
  for (const [name, o] of knock) t("§3.2 拿掉第 " + name + " → 不出", X.slotPhPlan({ ...OK, ...o }).draw === false, X.slotPhPlan({ ...OK, ...o }));
  t("§3.2 舊的冷卻、關閉次數、使用日、不畫表、每秒輪詢都不在了", !/COOL_DAYS|MAX_CLOSES|SEEN_DAYS|seenDays|closes|slotPhBlock|slotBlocks|csAnyTurn|setInterval/.test(src)); }

// ── §4.3 放不下:看得到的子節點寬 + margin + 列的 padding-left 跟 clientWidth 比;fixed 的 pop 與藏起來的不算 ──
{ const row = $("foot-row");
  $("ws-conn").w = 28; $("ph-pill").w = 28; $("ph-pop").w = 240; $("side-cv").w = 66; $("up-pill").w = 28;
  $("ph-pop").hidden = false; $("side-note").hidden = true; ["ws-conn", "ph-pill", "side-cv", "up-pill"].forEach((id) => { $(id).hidden = false; });
  const need = 6 + 28 + 16 + 28 + 8 + 66 + 8 + 28;   // 188:繁中「免費試用」+ 更新 + 手機
  row.clientWidth = need; t("§4.3 剛好放得下(列寬 = 加總)→ 放得下;pop(fixed)不算寬", X.slotRowFits(row) === true);
  row.clientWidth = need - 1; t("§4.3 少 1px → 放不下", X.slotRowFits(row) === false);
  $("ph-pill").hidden = true; row.clientWidth = need - 44; t("§4.3 藏起來的不算", X.slotRowFits(row) === true);
  row.clientWidth = 0; t("§4.3 列沒排出來(寬 0)→ 當放不下,等 ResizeObserver", X.slotRowFits(row) === false);
  t("§4.3 量法:不用 scrollWidth(透明熱區會被算進去)", !/scrollWidth/.test(cut(src, "function slotRowFits(")));
  t("§4.3 ResizeObserver 掛在列與列裡會變寬的三樣(不掛手機自己)", /new ResizeObserver\(\(\) => \(typeof sideCvPaint === "function" \? sideCvPaint\(\) : slotPaint\(\)\)\); \["foot-row", "side-cv", "side-note", "up-pill"\]/.test(src)); }

(async () => {
  // ── 畫面:slotPaint ──
  const row = $("foot-row");
  const reset = () => { feat.length = 0; X.resetDay(); ctx.PH = PHOK; ctx.__revoked = false; doc.rail = false; doc.lastFocus = null; doc.active = null; doc.visibilityState = "visible";
    $("ph-pill").hidden = true; $("ph-pop").hidden = true; $("side-cv").hidden = false; $("side-cv").w = 42; $("side-note").hidden = true; $("up-pill").hidden = true; row.clientWidth = 400; };
  await flush();
  reset(); X.slotPaint();
  t("畫面:成立 → 圖示露出、送 slot_ph_show;title 與 aria-label 都是「在手機上用」", $("ph-pill").hidden === false && feat.join() === "slot_ph_show" && $("ph-pill").title === "在手機上用" && $("ph-pill").attrs["aria-label"] === "在手機上用", feat);
  X.slotPaint(); t("畫面:同一天再畫不重送", feat.length === 1);
  reset(); doc.visibilityState = "hidden"; X.slotPaint(); t("畫面:視窗看不到 → 照出、不送 show", $("ph-pill").hidden === false && feat.length === 0);
  doc.visibilityState = "visible"; doc.listeners.visibilitychange(); t("畫面:回到看得到 → 補送 show", feat.join() === "slot_ph_show");
  reset(); ctx.PH = { ...PHOK, signedIn: false }; X.slotPaint(); t("畫面:沒登入不出(登入膠囊旁邊不會有手機)", $("ph-pill").hidden === true && feat.length === 0);
  reset(); ctx.__revoked = true; X.slotPaint(); t("畫面:登入失效(主行程 signedIn 仍 true)不出", $("ph-pill").hidden === true);
  reset(); doc.rail = true; X.slotPaint(); t("畫面:側欄收合不出", $("ph-pill").hidden === true);
  reset(); $("up-pill").hidden = false; $("side-cv").w = 66; row.clientWidth = 6 + 28 + 16 + 28 + 8 + 66 + 8 + 28 - 1; X.slotPaint();
  t("畫面:四樣放不下 → 手機讓位,其餘三樣不動", $("ph-pill").hidden === true && $("side-cv").hidden === false && $("up-pill").hidden === false);
  row.clientWidth += 1; X.slotPaint(); t("畫面:放得下 → 手機回來", $("ph-pill").hidden === false);

  // 步驟框
  reset(); X.slotPaint(); $("ph-pill").listeners.click(); await flush();
  t("步驟框:開、aria-expanded、slot_ph_open;fixed 定位在圖示上方 8、左緣對齊圖示", $("ph-pop").hidden === false && $("ph-pill").attrs["aria-expanded"] === "true" && feat.includes("slot_ph_open") && $("ph-pop").style.left === "12px" && $("ph-pop").style.bottom === "108px", feat);
  doc.listeners.keydown({ key: "a", stopPropagation() {} }); t("步驟框:其他鍵不收", $("ph-pop").hidden === false);
  let stopped = false; doc.listeners.keydown({ key: "Escape", stopPropagation() { stopped = true; } });
  t("步驟框:Esc 收、焦點回圖示、Esc 不往外傳", $("ph-pop").hidden === true && doc.lastFocus === "ph-pill" && stopped);
  stopped = false; doc.listeners.keydown({ key: "Escape", stopPropagation() { stopped = true; } }); t("步驟框沒開時 Esc 不攔", stopped === false);
  $("ph-pill").listeners.click(); doc.listeners.pointerdown({ target: $("ph-pop") }); t("步驟框:點裡面不收", $("ph-pop").hidden === false);
  doc.active = null; doc.lastFocus = null; doc.listeners.pointerdown({ target: $("tr") }); await flush();
  t("步驟框:點外面(沒有東西接焦點)收、焦點回圖示", $("ph-pop").hidden === true && doc.lastFocus === "ph-pill");
  $("ph-pill").listeners.click(); doc.listeners.win_resize(); t("步驟框:視窗縮放收掉", $("ph-pop").hidden === true);
  // §6.5 圖示因為任何一條消失:步驟框一起收、焦點接到齒輪
  $("ph-pill").listeners.click(); let first = $("ph-pop").all().find((k) => k.tag === "button"); first.focus();
  ctx.PH = { ...PHOK, pairedEver: true }; X.slotPaint();
  t("§6.5 圖示消失:步驟框一起收、焦點從 pop 接到齒輪", $("ph-pill").hidden === true && $("ph-pop").hidden === true && doc.lastFocus === "ws-conn");
  reset(); X.slotPaint(); $("ph-pill").listeners.click(); first = $("ph-pop").all().find((k) => k.tag === "button"); first.focus(); doc.lastFocus = null; doc.rail = true; X.slotPaint();
  t("§6.5 收合造成的消失:焦點接到細軌的齒輪", $("ph-pill").hidden === true && doc.lastFocus === "rail-set");
  reset(); X.slotPaint(); $("ph-pill").focus(); doc.lastFocus = null; ctx.PH = { ...PHOK, visible: false }; X.slotPaint();
  t("§6.5 焦點在圖示上(步驟框沒開)、圖示消失 → 焦點接到齒輪", $("ph-pill").hidden === true && doc.lastFocus === "ws-conn");
  reset(); X.slotPaint(); const ta = { id: "ta" }; doc.active = ta; ctx.PH = { ...PHOK, pairedEver: true }; X.slotPaint();
  t("§6.5 焦點不在圖示或 pop 裡 → 收掉也不搶", doc.lastFocus === null && doc.active === ta);

  // 步驟框內容:只剩已登入那一版
  { reset(); X.slotPaint(); $("ph-pill").listeners.click();
    const steps = () => { const ol = $("ph-pop").children[0]; return ol ? ol.children : []; };
    const states = (ls) => ls.map((li) => ["done", "now", "next"].filter((c) => li.classList.contains(c)).join("+")).join();
    const btns = () => $("ph-pop").all().filter((k) => k.tag === "button");
    const s1 = steps(), img = $("ph-pop").all().find((k) => k.tag === "img");
    t("§6.5 只有已登入那一版:done,now,next,next;沒有登入鈕(btn-out)", s1.length === 4 && states(s1) === "done,now,next,next" && !btns().some((b) => b.className === "btn-out") && s1[0].children[1].text === "已登入", states(s1));
    t("§6.5 QR 112 白底 plate + App Store、Google Play 兩顆 btn-quiet", !!img && img.src === "qr-app.svg" && img.width === 112 && img.parent.className === "ph-plate" && btns().length === 2 && btns().every((b) => b.className === "btn-quiet"));
    feat.length = 0; btns()[0].listeners.click(); btns()[1].listeners.click();
    t("§6.5 商店連結沿用 app_link_ios／app_link_android,外開 MV_APP_*", feat.join() === "app_link_ios,app_link_android" && opened.join() === "IOS_URL,AND_URL", feat);
    const ol = $("ph-pop").children[0], gp = btns()[1]; gp.focus(); ctx.acct = { email: "a@blave.org" }; X.slotPaint();
    t("§6.5 email 晚到只原地補那一行(同一個 <ol>、焦點不搬)", $("ph-pop").children[0] === ol && steps()[0].children[1].children.some((k) => k.className === "ph-who" && k.textContent === "a@blave.org") && doc.active === gp);
    ctx.acct = null; ctx.PH = { ...PHOK, on: true }; X.slotPaint();
    t("§6.5 允許手機對話已開:不列〔打開〕那步", steps().length === 3);
    t("§7 沒登入那一支與它的埋點拿掉了", !/slot_ph_login|ph\.stepPair|planSignIn|signInLabel/.test(src)); }

  // ── §3.1 帳號那一格:planView() 的每個值 ──
  { // 列舉 planView 回得出的值:return 後面的字面 + planState 那一行註明的三個
    const pv = cut(app, "function planView("), lits = new Set();
    for (const m of pv.matchAll(/return ([^;]+);/g)) for (const q of m[1].matchAll(/(?<!=== )"(\w+)"/g)) lits.add(q[1]);   // 比較用的字面(=== "payment_failed")不是回傳值
    const st = /if \(st !== "none"\) return st;\s*\/\/ (\w+) \/ (\w+) \/ (\w+)/.exec(pv); if (st) [st[1], st[2], st[3]].forEach((x) => lits.add(x));
    // spec §3.1 那張表:值 → [膠囊字 key, 提示(title 與 aria-label), 種類];null = 不出膠囊
    const SPEC = { out: ["side.cv.signin", "登入 Blave", "login"], revoked: ["side.cv.signin", "重新登入 Blave", "login"], unknown: null, starting: null, running: null,
      stopped: ["side.stopped", "", "stopped"], trial: null, planOn: null, included: null, offer: ["side.cv.trial", "綁卡免費試用 14 天", "trial"], payFail: null,
      plan: ["side.cv.plan", "升級方案", "plan"], billed: null, noTrial: ["side.cv.plan", "升級方案", "plan"], none: ["side.cv.plan", "升級方案", "plan"] };
    const missing = [...lits].filter((v) => !(v in SPEC)), extra = Object.keys(SPEC).filter((v) => !lits.has(v));
    t("§3.1 planView 回得出的值 = spec 表上 15 個(新增一個值這條就紅,要回來補表)", missing.length === 0 && extra.length === 0 && Object.keys(SPEC).length === 15, { missing, extra });
    // 真的 sideCvPaint／sideCvClick,planView／planVars 用假的
    const S = { view: "out", v: { n: 0, t: 14 }, feat: [], hit: [], busy: false, pending: false, reopen: false };
    const ctx2 = { $, t: ctx.t, document: { get visibilityState() { return doc.visibilityState; }, documentElement: { classList: { contains: (c) => c === "ws-sc" && doc.rail } } }, Date,
      planView: () => S.view, planVars: () => S.v, trackFeature: (n) => S.feat.push(n), slotPaint: () => S.hit.push("slot"),
      planSignIn: () => S.hit.push("signin"), planOpen: () => S.hit.push("open"), bindGo: (n) => S.hit.push("bind:" + n),
      window: { blave: { reopenOAuth: async () => { S.hit.push("reopen"); return S.reopen; } } } };
    Object.defineProperty(ctx2, "planLoginBusy", { get: () => S.busy }); Object.defineProperty(ctx2, "oauthPending", { get: () => S.pending });
    const decl = app.match(/^const SIDE_CV = \{[\s\S]*?\n\};\n/m)[0] + app.match(/^let sideCvGone = [^\n]*\n/m)[0] + app.match(/^let sideBooted = [^\n]*\n/m)[0] + app.match(/^const SIDE_CV_DAY = [^\n]*\n/m)[0] + app.match(/^const SIDE_CV_FEATURE = [^\n]*\n/m)[0];
    const F = new Function("ctx", "with (ctx) { " + decl + cut(app, "function sideCvPaint(") + "\n" + cut(app, "async function sideCvClick(") + "\n return { sideCvPaint, sideCvClick, gone: () => sideCvGone, boot: () => { sideBooted = true; }, newDay: () => { for (const k in SIDE_CV_DAY) delete SIDE_CV_DAY[k]; } }; }")(ctx2);
    ["side-cv", "side-note", "ws-conn", "rail-set"].forEach((id) => { $(id).hidden = false; $(id).attrs = {}; $(id).title = ""; });
    // 開機:token 讀到之前 hasToken 還是初值 false,真的 planView 會回 out(登入的人也一樣)——這時不畫、不記曝光
    { const pv0 = new Function("hasToken", "authRevoked", "acct", cut(app, "function planView(") + "\nreturn planView();")(false, () => false, null);
      S.view = pv0; S.v = { n: 0, t: 14 }; F.sideCvPaint();
      t("開機:token 還沒讀到(真的 planView 此時回 out)→ 這一格不畫、不記 side_cv_login", pv0 === "out" && $("side-cv").hidden === true && S.feat.length === 0, [pv0, S.feat]);
      const boot = app.slice(app.indexOf("  applyStatic();\n  hasToken = await window.blave.hasBlaveToken();"), app.indexOf("  awakeLoad();"));
      t("開機:讀到 token 的下一行才放行並重畫", /hasToken = await window\.blave\.hasBlaveToken\(\);\n  sideBooted = true; sideCvPaint\(\);/.test(boot) && (app.match(/sideBooted = true/g) || []).length === 1); }
    F.boot();
    const bad = [];
    for (const view of Object.keys(SPEC)) {
      S.view = view; S.v = { n: 0, t: 14 }; F.sideCvPaint(); const want = SPEC[view], cv = $("side-cv");
      const got = cv.hidden ? null : [cv.textContent, cv.title, cv.dataset.kind, cv.attrs["aria-label"] || ""];
      const exp = want ? [STR.zh[want[0]], want[1], want[2], want[1]] : null;
      if (JSON.stringify(got) !== JSON.stringify(exp)) bad.push([view, got, exp]);
    }
    t("§3.1 每個值畫的東西(字、title、aria-label 用提示全名、種類)照表;不出膠囊的那幾個是空的", bad.length === 0, bad);
    S.view = "stopped"; F.sideCvPaint(); t("§3.1 已停機沒有提示、也不另設 aria-label(名字就是看得到的字)", $("side-cv").title === "" && !("aria-label" in $("side-cv").attrs));
    S.view = "offer"; S.v = { n: 0, t: "" }; F.sideCvPaint(); t("§3.1 免費試用拿不到天數:不掛提示", $("side-cv").textContent === "免費試用" && $("side-cv").title === "" && !("aria-label" in $("side-cv").attrs));
    ctx.LANG = "en"; S.view = "plan"; F.sideCvPaint(); t("§5 en:Upgrade／提示 Upgrade Plan", $("side-cv").textContent === "Upgrade" && $("side-cv").attrs["aria-label"] === "Upgrade Plan"); ctx.LANG = "zh";
    const notes = [0, 1, 2, 3, 4, 14].map((n) => { S.view = "trial"; S.v = { n, t: 14 }; F.sideCvPaint(); return $("side-note").hidden ? "" : $("side-note").textContent; });
    t("§3.1 試用中:剩 1–3 天出灰字「試用剩 {n} 天」,其餘空;膠囊不出", JSON.stringify(notes) === JSON.stringify(["", "試用剩 1 天", "試用剩 2 天", "試用剩 3 天", "", ""]) && $("side-cv").hidden === true, notes);
    S.view = "trial"; S.v = { n: 3, t: 14 }; F.sideCvPaint();
    t("§6.6 有灰字時齒輪的可及名稱帶狀態;齒輪與細軌齒輪的 title 是「設定」", $("ws-conn").attrs["aria-label"] === "設定, 試用剩 3 天" && $("ws-conn").title === "設定" && $("rail-set").attrs["aria-label"] === "設定" && $("rail-set").title === "設定");
    S.view = "running"; F.sideCvPaint(); t("§6.6 沒灰字時齒輪就是「設定」", $("ws-conn").attrs["aria-label"] === "設定");
    t("§4.3 這一格每次重畫都叫 slotPaint 重算手機", S.hit.filter((h) => h === "slot").length >= Object.keys(SPEC).length);
    // 埋點:出現類每種每天一次;看不到、收合時不送
    F.newDay(); S.feat.length = 0; doc.visibilityState = "hidden"; S.view = "out"; F.sideCvPaint(); doc.visibilityState = "visible"; doc.rail = true; $("side-cv").offsetParent = null; F.sideCvPaint(); doc.rail = false;   // 收合:.ws-foot 整塊 display none
    $("side-cv").offsetParent = null; F.sideCvPaint(); delete $("side-cv").offsetParent;
    t("§8.1 出現類:視窗看不到、側欄收合、膠囊沒排出來(offsetParent null,例如還在連結畫面)時不送", S.feat.length === 0, S.feat);
    t("§8.1 還沒排出來的那次由 ResizeObserver 補:它叫 sideCvPaint", /new ResizeObserver\(\(\) => \(typeof sideCvPaint === "function" \? sideCvPaint\(\) : slotPaint\(\)\)\)/.test(src));
    ["out", "out", "revoked", "offer", "plan", "noTrial", "stopped", "running"].forEach((v) => { S.view = v; S.v = { n: 0, t: 14 }; F.sideCvPaint(); });
    t("§8.1 出現類:side_cv_login／trial／plan／stopped 每種每天一次(revoked 與 out 同一種)", S.feat.join() === "side_cv_login,side_cv_trial,side_cv_plan,side_cv_stopped", S.feat);
    // 按下去
    const click = async (view, o) => { S.view = view; S.v = { n: 0, t: 14 }; S.busy = !!(o && o.busy); S.pending = !!(o && o.pending); S.reopen = !!(o && o.reopen); F.sideCvPaint(); S.feat.length = 0; S.hit.length = 0; await F.sideCvClick(); return [S.hit.filter((h) => h !== "slot").join(), S.feat.join()]; };
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    t("§3.1 登入(沒在等):planSignIn、記 login_side", eq(await click("out"), ["signin", "login_side"]));
    t("§3.1 重新登入(revoked)同上", eq(await click("revoked"), ["signin", "login_side"]));
    t("§6.1 等待中再按:重開授權頁、記 login_side_again,不取消、不重來", eq(await click("out", { busy: true, pending: true, reopen: true }), ["reopen", "login_side_again"]));
    t("§6.1 等待中再按、主行程說沒在等(剛好逾時、還沒收到結果):不另起一次", eq(await click("out", { busy: true, pending: true, reopen: false }), ["reopen", ""]));
    t("§6.1 別處在登入(oauthPending、不是這條):不做事", eq(await click("out", { pending: true }), ["", ""]));
    t("§3.1 免費試用:bindGo(\"bind_side\")、設旗標", eq(await click("offer"), ["bind:bind_side", ""]) && F.gone() === true);
    t("§3.1 升級:planOpen、記 plan_side", eq(await click("plan"), ["open", "plan_side"]));
    t("§3.1 已停機:planOpen、記 stopped_side", eq(await click("stopped"), ["open", "stopped_side"]));
    t("§3.1 灰字不是控件:沒有 click、不在 Tab 順序(span)", /<span class="row-note" id="side-note" hidden><\/span>/.test(html) && !/side-note"\)\.addEventListener/.test(app));
  }

  // ── §6.2 綁卡回來重查、§6.3 登入時先空 ──
  { const at = app.indexOf('window.addEventListener("focus", () => {\n  if (acctGone)'), f = app.slice(at, app.indexOf("\n});", at));
    t("§6.2 回前景:條件加上 sideCvGone、10 秒節流照舊,查回來才清旗標並重畫", at > 0 && /\|\| sideCvGone\)\) return;\n  if \(Date\.now\(\) - acctAt < 10000\) return;/.test(f) && /acctCheck\(\)\.then\(\(\) => \{ if \(forSide\) \{ sideCvGone = false; sidePaint\(\); \} \}\)/.test(f));
    t("§6.2 旗標只在按「免費試用」時設、只在那次重查回來時清", (app.match(/sideCvGone = true/g) || []).length === 1 && (app.match(/(?<!let )sideCvGone = false/g) || []).length === 1);
    t("§6.2 關設定時重畫這一格;焦點回看得到的那顆齒輪", /sidePaint\(\);[^\n]*\n  \(document\.documentElement\.classList\.contains\("ws-sc"\) \? \$\("rail-set"\) : \$\("ws-conn"\)\)\.focus\(\);/.test(cut(app, "function setClose(")));
    t("§6.3 planLogin 先把 acct 清成 null 再重讀,中間經 acctPaintAcct 把這一格畫空", /acct = null;[^\n]*acctPaintAcct\(\); await acctCheck\(\);/.test(cut(app, "async function planLogin(")) && /sideCvPaint\(\);/.test(cut(app, "function acctPaintAcct(")));
    t("§6.3 其他三條登入路(連結畫面、登入失效卡、重新登入)換到 token、清 acct 的同一行就把這一格畫空", (app.match(/hasToken = true;[^\n]*acct = null;[^\n]*sideCvPaint\(\);/g) || []).length === 3);
    t("雲端回 REVOKED 翻面時重畫這一格(trade.js 輪詢)", /if \(typeof sideCvPaint === "function" && authRevoked\(\) !== ENV\.sideRv\) \{ ENV\.sideRv = authRevoked\(\); sideCvPaint\(\); \}/.test(read("renderer/trade.js"))); }

  // ── §6.1 主行程:只重開自己存的那個網址 ──
  { const R = cut(main, "function reopenOAuth(");
    const run = (pending) => { const out = []; const f = new Function("pendingOAuth", "shell", R + "\nreturn reopenOAuth();"); return [f(pending, { openExternal: (u) => out.push(u) }), out]; };
    t("§6.1 reopenOAuth:有在等而且有網址 → 開那個網址、回 true", JSON.stringify(run({ url: "https://x/authorize?state=s" })) === JSON.stringify([true, ["https://x/authorize?state=s"]]));
    t("§6.1 沒在等(pendingOAuth 清掉)或還沒有網址 → 回 false、不開", JSON.stringify(run(null)) === JSON.stringify([false, []]) && JSON.stringify(run({ url: null })) === JSON.stringify([false, []]));
    t("§6.1 IPC 不收參數、不收畫面傳來的字串;preload 也不傳", /handle\("reopen-oauth", \(\) => reopenOAuth\(\), false\);/.test(main) && /reopenOAuth: \(\) => ipcRenderer\.invoke\("reopen-oauth"\),/.test(pre));
    t("§6.1 網址是 startOAuth 自己組的那一個,存在這次的 pendingOAuth 上", /const mine = pendingOAuth = \{\n\s*url: null,/.test(main) && /mine\.url = authUrl;\n\s*shell\.openExternal\(authUrl\);/.test(main));
    t("§6.1 5 分鐘逾時也清掉 pendingOAuth(只清這一次的),逾時後再按是重新開始", /setTimeout\(\(\) => \{ if \(pendingOAuth === mine\) pendingOAuth = null; server\.close\(\); reject\(new Error\("OAUTH_TIMEOUT"\)\); \}, 300000\)/.test(main)); }

  // ── §6.4 更新原因句出在列上方 ──
  t("§6.4 原因句錨點 #foot-why 在列前面:busySlot 插在它後面 = 列的上方,列本身不動", /const anchor = \$\("foot-why"\);/.test(cut(app, "function upPillClick(")) && /<div id="foot-why" hidden><\/div>\n\s*<div class="foot-row" id="foot-row">/.test(html));

  // ── §2、§3.5 結構 ──
  { const r = html.slice(html.indexOf('<div class="foot-row" id="foot-row">'), html.indexOf("</aside>"));
    const ids = [...r.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]);
    t("§2 列的順序:齒輪、手機、pop、帳號膠囊、灰字、更新(Tab 順序同畫面;pop 緊接手機)", ids.join() === "foot-row,ws-conn,ph-pill,ph-pop,side-cv,side-note,up-pill", ids);
    t("§3.5 細軌:展開鈕在上;底部 .rail-bot 是更新圓鈕、它下面齒輪,齒輪開設定", /<div class="side-rail"><button class="rail-btn" id="rail-open"[\s\S]*?<div class="rail-bot"><button class="up-pill up-rail" id="up-rail"[^>]*>[\s\S]*?<\/button><button class="rail-btn" id="rail-set" type="button" aria-haspopup="dialog">/.test(html)
      && /\$\("rail-set"\)\.addEventListener\("click", setOpen\);/.test(app));
    t("§7 舊節點拿掉:#up-pill-wrap、#up-pill-t、#ph-slot、#ph-x、#ws-conn-note", !/id="(up-pill-wrap|up-pill-t|ph-slot|ph-x|ws-conn-note)"/.test(html) && !/"(up-pill-wrap|up-pill-t|ph-slot|ph-x|ws-conn-note)"/.test(app + src)); }

  // ── §4 長相 ──
  { const rule = (sel) => { const m = new RegExp("^" + sel.replace(/[.*+?^${}()|[\]\\#]/g, "\\$&") + " \\{([^}]*)\\}", "m").exec(css); return m ? m[1] : ""; };
    t("§4.1 列高 44、padding-left space-6", /min-height: 44px;/.test(rule(".foot-row")) && /padding-left: var\(--space-6\);/.test(rule(".foot-row")));
    t("§4.1 齒輪／手機 28、radius-sm、熱區 ::before -8(44);圖示線寬 1.75", /width: 28px; height: 28px;/.test(rule(".ic-btn")) && /--radius-sm/.test(rule(".ic-btn")) && /inset: -8px;/.test(rule(".ic-btn::before")) && /stroke-width: 1\.75;/.test(rule(".ic-btn .ic")));
    t("§4.1 膠囊高 28、pill、1px border-frame、左右 space-8、12/500、不折行;熱區 -9 -1(高 44、寬同膠囊)", /height: 28px;/.test(rule(".cv-pill")) && /--radius-pill/.test(rule(".cv-pill")) && /border: 1px solid var\(--border-frame\);/.test(rule(".cv-pill")) && /padding: 0 var\(--space-8\);/.test(rule(".cv-pill"))
      && /font-size: 12px; font-weight: 500; line-height: 1; white-space: nowrap;/.test(rule(".cv-pill")) && /inset: -9px -1px;/.test(rule(".cv-pill::before")));
    t("§4.1 灰字 12、左右 space-4、不折行、ink-3", /font-size: 12px;/.test(rule(".row-note")) && /padding: 0 var\(--space-4\);/.test(rule(".row-note")) && /white-space: nowrap;/.test(rule(".row-note")) && /color: var\(--ink-3\);/.test(rule(".row-note")));
    t("§4.1 間距:手機前 16、其餘 8(固定 margin-left,不靠相鄰選擇器)", /^#ph-pill \{ margin-left: var\(--space-16\); \}/m.test(css) && /^\.cv-pill, \.row-note, \.foot-row \.up-pill \{ margin-left: var\(--space-8\); \}/m.test(css));
    t("§4.2 齒輪／手機滑過與步驟框開著:底 surface-muted、圖示 ink;膠囊滑過 surface-muted", /^\.ic-btn:hover, \.ic-btn\[aria-expanded="true"\] \{ background: var\(--surface-muted\); color: var\(--ink\); \}/m.test(css) && /^\.cv-pill:hover \{ background: var\(--surface-muted\); \}/m.test(css));
    t("§4.2 橘只有更新這一顆;沒有陰影、沒有寫死 hex", !/primary/.test(rule(".ic-btn") + rule(".cv-pill") + rule(".row-note") + rule(".foot-row")) && !/shadow|#[0-9a-f]{3,6}\b/i.test(rule(".ic-btn") + rule(".cv-pill") + rule(".row-note") + rule(".foot-row") + rule(".up-pill")));
    t("§4.2 減少動態:三種鈕的轉場關掉", css.includes("@media (prefers-reduced-motion: reduce) { .ic-btn, .cv-pill, .up-pill { transition: none; } }"));
    t("§7 舊樣式拿掉:.ph-slot／.ph-x／.ph-pill 白底陰影／.up-pill-wrap／.up-pill-t／.no-ic／.ws-more／.ws-more-note", !/\.ph-slot|\.ph-x\b|\.ph-pill|\.up-pill-wrap|\.up-pill-t\b|\.no-ic|\.ws-more/.test(css)); }

  // ── §5 字 ──
  const pair = (k, zh, en) => STR.zh[k] === zh && STR.en[k] === en;
  t("§5 新字:登入／免費試用／升級／升級方案", pair("side.cv.signin", "登入", "Sign In") && pair("side.cv.trial", "免費試用", "Free Trial") && pair("side.cv.plan", "升級", "Upgrade") && pair("side.cv.planTip", "升級方案", "Upgrade Plan"));
  t("§5 沿用的字還在:設定、在手機上用、登入 Blave、重新登入 Blave、已停機、試用剩 {n} 天、綁卡免費試用 {t} 天", pair("ws.settings", "設定", "Settings") && pair("ph.slot", "在手機上用", "Use on Phone") && pair("pv.signin", "登入 Blave", "Sign In to Blave")
    && pair("fault.authBtn", "重新登入 Blave", "Sign In to Blave Again") && pair("side.stopped", "已停機", "Stopped") && STR.zh["side.trial"] === "試用剩 {n} 天" && STR.zh["wd.note.trial"] === "綁卡免費試用 {t} 天");
  t("§7 拿掉 up.pillS、ph.stepPair;side.starting 留著(trade.js 頂列在用)", !("up.pillS" in STR.zh) && !("ph.stepPair" in STR.zh) && STR.zh["side.starting"] === "啟動中" && /side\.starting/.test(read("renderer/trade.js")));

  // ── §8 埋點 ──
  t("§8.1 九個新名字接在 0.1.52 的 cx_key_page 後面、順序同 spec;之後只接 0.1.54 拉回 icon 鈕 sp_pull_icon", /"cx_key_page",\n[^\n]*\n[^\n]*\n\s*"side_cv_login", "side_cv_trial", "side_cv_plan", "side_cv_stopped",\n\s*"login_side", "login_side_again", "bind_side", "plan_side", "stopped_side",\n[^\n]*\n\s*"sp_pull_icon"\] \},/.test(tele));
  t("§8.2 slot_ph_show／slot_ph_open 留著(手機圖示畫出／按下);slot_up_*、slot_ph_close、slot_ph_login 沒有送出點", /"slot_ph_show"/.test(src) && /"slot_ph_open"/.test(src) && !/slot_up_show|slot_up_open|slot_ph_close|slot_ph_login/.test(app + src));
  t("§8.2 upd_pill_shown 列裡或細軌看得到都算、每日一次;upd_go_pill 按圓鈕", /if \(p\.show && \(pill\.offsetParent !== null \|\| dot\.offsetParent !== null\)\)/.test(cut(app, "function upPillPaint(")) && /trackFeature\("upd_go_pill"\);/.test(cut(app, "function upPillClick(")));
  t("§7 主行程的提示格存檔拿掉:slot-state、slot-phone-set、slotPhone", !/slot-state|slot-phone-set|slotPhone|slotStateGet/.test(main + pre));
  console.log(red ? `\n${red} 條沒過` : "\n全過"); process.exit(red ? 1 : 0);
})();
