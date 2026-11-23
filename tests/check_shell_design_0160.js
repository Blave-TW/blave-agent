// 0.1.60 設計決定落地(spec p3-0160-decisions、chat-image-strip-0160)裡會算錯的那幾段:從原文切出來跑,不開 Electron。
//   ① R4-4 權益圖縱軸最少是最新權益的 1%(trade.js trCurveRange)
//   ② R4-1 副圖門檻標籤撞到就推開、夾在 pane 內(report-trades.js spreadLevels)
//   ③ #10/R5-13 策略邏輯多語:安裝檔跟上架碼解出的一樣才換成譯文(app.js rpSameLogic／rpLogicOf)
//   ④ 聊天欄 agent 圖:相鄰兩張併成膠捲、中間隔字各自一張;放大檢視的序列是整條對話、照 DOM 順序(app.js addImage／lbItems)
//   ⑤ R5-5〔留在這台電腦〕只在有一支等著上雲端時出;R3-1 狀態詞的原因句;P3-10 Mac 台灣期貨的〔改用雲端主機〕預選 Windows
// 跑法:node tests/check_shell_design_0160.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + JSON.stringify(d))); if (!c) red++; };
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
const cutConst = (s, name) => { const m = new RegExp("^const " + name + " = [^\\n]*;$", "m").exec(s); if (!m) throw new Error("no " + name); return m[0]; };
const trade = read("trade.js"), app = read("app.js"), rt = read("report-trades.js");
const STR = vm.runInNewContext(read("strings.js").replace(/^const STRINGS/m, "var STRINGS") + "\nSTRINGS");

// ① 權益縱軸
{ const c = {}; vm.runInNewContext(cutConst(trade, "TR_CURVE_MIN_FRAC") + "\n" + cutFn(trade, "trCurveRange") + "\nthis.f = trCurveRange;", c);
  const [lo, hi] = c.f([99999.1, 99999.5, 99999.85], false), mid = (99999.1 + 99999.85) / 2;
  ok("① 10 萬權益只差 0.75:範圍撐到最新權益的 1%,以資料中間點為中心", Math.abs(hi - lo - 999.9985) < 1e-6 && Math.abs((hi + lo) / 2 - mid) < 1e-9, [lo, hi]);
  const [a, b] = c.f([100, 90, 120], false);
  ok("① 資料本身比 1% 寬:照資料畫(不加寬)", a === 90 && b === 120, [a, b]);
  const [p, q] = c.f([5, 7], true);
  ok("① 損益照舊含 0、不套 1%", p === 0 && q === 7, [p, q]);
  ok("① trDrawCurve 用它算範圍", /let \[lo, hi\] = trCurveRange\(pts\.map\(\(p\) => p\.v\), isPnl\);/.test(cutFn(trade, "trDrawCurve"))); }

// ② 門檻標籤
{ const c = {}; vm.runInNewContext("const LEVEL_GAP = 14, LEVEL_EDGE = 8;\n" + cutFn(rt, "spreadLevels") + "\nthis.f = spreadLevels;", c);
  const ys = c.f([40, 46, 50, null], 120), real = ys.filter((y) => y !== null).sort((x, y) => x - y);
  ok("② 三條擠在一起:彼此至少 14px、照價位順序、null 照舊 null", ys[3] === null && real[1] - real[0] >= 14 && real[2] - real[1] >= 14 && ys[0] < ys[1] && ys[1] < ys[2], ys);
  const edge = c.f([118, 119, 2], 120);
  ok("② 貼邊的往內移:不超出 8..112", edge.every((y) => y >= 8 && y <= 112) && Math.abs(edge[0] - edge[1]) >= 14, edge);
  ok("② 價格線本身不出軸標,軸標由 LevelLabels primitive 供(字色＝虛線色、底＝卡面)", /axisLabelVisible: false,/.test(rt) && /new LevelLabels\(p\.levels\.slice\(\), \{ text: inkMuted, back: token\("--surface-card"\) \}\)/.test(rt)
    && /crosshair: \{ vertLine: \{ labelVisible: true \}/.test(rt)); }

// ③ 策略邏輯多語
{ const asked = [];
  const c = { LANG: "zh", window: { blave: { strategyLogicI18n: (id, lang) => { asked.push(id + ":" + lang); return new Promise(() => {}); } } }, rpPaintLogic: () => {} };
  vm.runInNewContext("const RP_LOGIC_I18N = new Map();\n" + cutFn(app, "rpSameLogic") + "\n" + cutFn(app, "rpLogicOf") + "\nthis.same = rpSameLogic; this.of = rpLogicOf; this.M = RP_LOGIC_I18N;", c);
  const mine = { entry: ["a"], exit: ["b"], stop: [] }, zh = { entry: ["進場"], exit: ["出場"], stop: [] };
  ok("③ rpSameLogic:兩邊都 null 算相同;text 比字串;三組逐項比", c.same(null, null) && !c.same(mine, null) && c.same({ text: "x" }, { text: "x" }) && !c.same({ text: "x" }, mine)
    && c.same(mine, { entry: ["a"], exit: ["b"] }) && !c.same(mine, { entry: ["a"], exit: ["c"], stop: [] }));
  ok("③ 沒有 sourceId:照讀碼,不問 api", c.of({ logic: mine }) === mine && asked.length === 0);
  ok("③ 第一次:先照讀碼畫、背景問一次 (id, 語言)", c.of({ sourceId: 73, logic: mine }) === mine && asked.join() === "73:zh");
  c.M.set("73:zh", { logic: zh, logicCode: { entry: ["a"], exit: ["b"], stop: [] } });
  ok("③ 安裝檔解出的跟上架碼一樣 → 換成譯文", c.of({ sourceId: 73, logic: mine }) === zh);
  ok("③ 改過策略(跟上架碼不同)→ 繼續顯示自己的字", c.of({ sourceId: 73, logic: { entry: ["改過"], exit: [], stop: [] } }).entry[0] === "改過");
  c.M.set("73:zh", { logic: zh, logicCode: null });
  ok("③ #73 這種碼裡沒有邏輯:兩邊都 null 也換成譯文(〔策略邏輯〕會出現)", c.of({ sourceId: 73, logic: null }) === zh);
  c.LANG = "en"; c.of({ sourceId: 73, logic: null });
  ok("③ 換語言用新的 lang 重問", asked.join() === "73:zh,73:en");
  const main = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
  ok("③ 主行程:loadStrategy 帶 sourceId(source.json 讀 4096 bytes、正整數,缺了退已安裝對照表);api 不帶 token、(id, lang) 快取、失敗 10 分鐘不重打",
    /sourceId: stratSourceId\(dir, name\)/.test(main) && /wsfile\.read\(path\.join\(dir, "source\.json"\), 4096\)/.test(cutFn(main, "stratSourceId")) && /Number\.isInteger\(id\) && id > 0/.test(cutFn(main, "stratSourceId"))
    && /libraryInstalled\(\)/.test(cutFn(main, "stratSourceId")) && /getJSON\(`\$\{API_BASE\}\/openclaw\/marketplace\/strategies\/\$\{id\}\?lang=\$\{lang\}`, \{\}\)/.test(main) && /LOGIC_I18N_RETRY_MS = 10 \* 60 \* 1000/.test(main)
    && /logicOf\(s\.logic\), logicCode: logicOf\(s\.logic_code\)/.test(main)); }

// ④ 聊天欄的圖
class N {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.className = ""; this.dataset = {}; this.attrs = {}; this.style = {}; this.on = {}; this.hidden = false; this.textContent = ""; }
  get classList() { const n = this; return { contains: (c) => n.className.split(/\s+/).includes(c), add: (c) => { n.className = (n.className + " " + c).trim(); } }; }
  appendChild(c) { if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1); c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  replaceWith(n) { const p = this.parentNode, i = p.children.indexOf(this); if (n.parentNode) n.parentNode.children.splice(n.parentNode.children.indexOf(n), 1); p.children[i] = n; n.parentNode = p; this.parentNode = null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get previousElementSibling() { const p = this.parentNode; return p ? p.children[p.children.indexOf(this) - 1] || null : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k]; }
  addEventListener(e, f) { this.on[e] = f; } focus() {}
  matches(sel) { return sel.split(",").some((s) => { const last = s.trim().split(/\s+/).pop(), [tag, ...cls] = last.split("."); return (!tag || this.tagName === tag.toUpperCase()) && cls.every((c) => this.classList.contains(c)); }); }
  closest(sel) { let n = this; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parentNode; } return null; }
  all() { return [this].concat(...this.children.map((c) => c.all())); }
  querySelectorAll(sel) { return this.all().slice(1).filter((n) => sel.split(",").some((s) => { const parts = s.trim().split(/\s+/); return n.matches(parts[parts.length - 1]) && (parts.length < 2 || !!(n.parentNode && n.parentNode.closest(parts[0]))); })); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
{ const chat = new N("div"), busyEl = new N("div"), tracked = [], E = {};
  ["lb-img", "lb-n", "lb-prev", "lb-next", "lb-cap", "lb-close", "lb-scrim", "view-ws"].forEach((id) => { E[id] = new N("div"); });
  const ctx = { document: { createElement: (t) => new N(t), activeElement: null }, chatEl: () => chat, busy: { el: busyEl }, busyPin: () => chat.appendChild(busyEl), scrollChat: () => {}, t: (k, v) => k + (v ? JSON.stringify(v) : ""),
    trackFeature: (n) => tracked.push(n), requestAnimationFrame: (f) => f(), ResizeObserver: undefined, $: (id) => E[id] };
  vm.runInNewContext("const LB = { list: [], i: 0 };\nconst IMG_DRAG_PX = 8;\n" + ["lbItems", "lbOpen", "lbShow", "chatImgPrev", "chatImgBtn", "chatImgStrip", "chatImgRelabel", "addImage"].map((n) => cutFn(app, n)).join("\n")
    + "\nthis.add = addImage; this.LB = LB; this.lbItems = lbItems;", ctx);
  const kinds = () => chat.children.filter((n) => n !== busyEl).map((n) => n.classList.contains("img-strip") ? "strip:" + n.querySelectorAll(".img-zoom").length : n.classList.contains("img") ? "one" : "text");
  ctx.add("a.png", "權益曲線");
  ok("④ 一張:單張 figure.msg.img,按鈕名稱＝圖的 alt(說明字),aria-haspopup=dialog,聊天欄不印說明字", kinds().join() === "one" && chat.children[0].children[0].attrs["aria-haspopup"] === "dialog"
    && chat.children[0].children[0].children[0].alt === "權益曲線" && !chat.children[0].children.some((n) => n.tagName === "FIGCAPTION") && !("aria-label" in chat.children[0].children[0].attrs));
  ctx.add("b.png", "");
  const strip = chat.children[0];
  ok("④ 第二張進來(中間沒有字):第一張就地換成膠捲的一格;role=group、aria-label N 張圖;沒說明的那張 alt＝圖 N", kinds().join() === "strip:2" && strip.attrs.role === "group"
    && strip.attrs["aria-label"] === 'chat.imageCount{"n":2}' && strip.querySelectorAll(".img-zoom")[1].children[0].alt === 'chat.imageN{"n":2}' && strip.querySelectorAll(".img-zoom")[0].children[0].alt === "權益曲線"
    && !strip.querySelector(".img-strip-sc").attrs.tabindex);
  ctx.add("c.png", "熱圖");
  ok("④ 第三張接在同一條膠捲右邊", kinds().join() === "strip:3" && strip.attrs["aria-label"] === 'chat.imageCount{"n":3}');
  const t1 = new N("div"); t1.className = "msg ai"; chat.appendChild(t1); ctx.add("d.png", "");
  ok("④ 中間隔著字:新的一張自己一張,不併進前一條", kinds().join() === "strip:3,text,one");
  const items = ctx.lbItems();
  ok("④ 放大檢視的序列 = 整條對話的 agent 圖、照聊天順序", items.length === 4 && items.map((b) => b.children[0].src).join() === "a.png,b.png,c.png,d.png");
  items[2].on.click();
  ok("④ 點第三張:左上 3 / 4、上一張下一張都能按、說明字出、記 chat_img_zoom", E["lb-n"].textContent === "3 / 4" && !E["lb-n"].hidden && !E["lb-prev"].disabled && !E["lb-next"].disabled && E["lb-cap"].textContent === "熱圖" && tracked.includes("chat_img_zoom"));
  ok("④ 鍵盤與關閉:← → 切換、Tab 只在三顆鈕間轉、關掉後焦點回當下那張並捲進可視範圍", /e\.key === "ArrowLeft" \|\| e\.key === "ArrowRight"/.test(app) && /\["lb-close", "lb-prev", "lb-next"\]\.map\(\$\)\.filter\(\(b\) => !b\.hidden && !b\.disabled\)/.test(app)
    && /cur\.focus\(\); cur\.scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\);/.test(cutFn(app, "lbClose")));
  ok("④ 膠捲第一次被橫捲記 chat_img_scroll(每條一次;第一張換成膠捲那一下不算)", /if \(!told && !el\.blaveSilent\) \{ told = true; trackFeature\("chat_img_scroll"\); \}/.test(cutFn(app, "chatImgStrip"))); }

// ⑤ 其他
{ ok("⑤ R5-5〔留在這台電腦〕:有 pid 才出、切回本機、焦點給策略頁頭、記 cloud_stay_local;字兩語", /if \(pid\) act\.appendChild\(btn\("btn-quiet hit44", t\("env\.open\.stayLocal"\)/.test(trade) && /envSwitchGuarded\("local"\);/.test(trade)
    && /const h = \$\("rp-name"\); if \(ENV\.cur === "local" && h && h\.offsetParent\) h\.focus\(\);/.test(trade) && STR.zh["env.open.stayLocal"] === "留在這台電腦" && STR.en["env.open.stayLocal"] === "Keep It Local");
  const hs = read("handoff.js");
  ok("⑤ R3-1 美股狀態詞:SP_HEAD.us 帶原因句 sp.usWhy;畫的時候 .has-tip、可聚焦、title 與 aria-describedby 同一句", /us: \{ btn: null, word: "tr\.mkt\.noAuto", tip: "sp\.usWhy" \}/.test(hs)
    && /w\.classList\.add\("has-tip"\); w\.tabIndex = 0; w\.title = t\(v\.tip\); w\.setAttribute\("aria-describedby", d\.id\);/.test(read("portfolio.js"))
    && STR.zh["sp.usWhy"] === "用美股訊號，現在還不能自動下單。" && STR.en["sp.usWhy"] === "Uses a US-stock signal, so it can’t auto-trade yet.");
  ok("⑤ P3-10 Mac 台灣期貨:一句講要 Windows、〔改用雲端主機〕關連接框、開加購框預選 Windows、記 cx_mac_tw_cloud", STR.zh["cx.macTw"] === "群益、統一需要 Windows。" && STR.zh["cx.macTwGo"] === "改用雲端主機"
    && /cxModalClose\(false\); p3OpenAddon\(null, p3TierOf\("windows", "starter"\), undefined, "cloud"\);/.test(trade) && /trackFeature\("cx_mac_tw_cloud"\)/.test(trade));
  { const css = read("trade.css"), rule = (sel) => { const i = css.indexOf("\n" + sel + " {"); return i < 0 ? null : css.slice(i + sel.length + 3, css.indexOf("}", i)).trim(); }, tl = cutFn(trade, "cxTiles");
    ok("⑤ Mac 台灣期貨說明行(spec mac-tw-row-0160):連結直接 append、不插空字串／空格,間距交給 CSS gap", /const b = trEl\("button", "btn-quiet[^"]*", t\("cx\.macTwGo"\)\);/.test(tl) && /\n      p\.append\(b\); \}/.test(tl) && !/p\.append\([^)]*" "/.test(tl), tl.slice(tl.indexOf("const macTw"), tl.indexOf("const twGroup")));
    const grp = rule(".cx-grp"), note = rule(".cx-macnote"), hit = rule(".cx-tiles + .cx-macnote .btn-quiet::before");
    ok("⑤ 段與段之間 16、磚到說明行 12;說明行 flex wrap、column-gap 8", /^margin: var\(--space-16\) 0 var\(--space-6\);/.test(grp || "") && rule(".cx-pick > .cx-grp:first-child") === "margin-top: 0;"
      && /display: flex; flex-wrap: wrap; align-items: baseline; column-gap: var\(--space-8\);/.test(note || "") && rule(".cx-tiles + .cx-macnote") === "margin-top: var(--space-12);", [grp, note]);
    ok("⑤ 〔改用雲端主機〕熱區:上緣往上只伸 12(剛好接磚底)、只做水平置中;比 .cx-body 那條置中 44 的權重高", hit === "top: calc(-1 * var(--space-12)); transform: translateX(-50%);"
      && css.includes("\n.cx-body .btn-quiet::before { inset: auto; left: 50%; top: 50%; width: max(44px, calc(100% + 8px)); height: 44px;"), hit); }
  ok("⑤ R3-15 優化表底合計跨幣別時換成投入資金的幣別(d.ccy),不換顯示幣別", /trZoneSum\(mpsAmountsPayload\(d\), null, \([^)]*\) => \{[^}]*\}, d\.ccy\)\.total/.test(read("portfolio.js"))
    && /trZoneTotals\(amounts, trZoneOf, mf, fv\.fx, base \|\| fv\.base\)/.test(trade)); }

// ⑥ 設計師裁定(web-0160-review 末尾 D 批 2、5)
{ const pf = read("portfolio.js"), html = read("index.html");
  ok("⑥ 「已儲存」不蓋掉說明句:spView 記 v.saved、不改 v.note;另一段 #rp-saved(role=status)接在 #rp-ho-note 後面,hoPaint 畫",
    /if \(S\.spSaved && S\.spSaved\.name === name && now - S\.spSaved\.at < SP_SAVED_MS\) v\.saved = true;/.test(pf) && !/v\.note = \{ key: "tr\.saved" \}/.test(pf)
    && html.indexOf('id="rp-saved" role="status" hidden') > html.indexOf('id="rp-ho-note"') && /spPaintSaved\(!act\.hidden && !!\(sv && sv\.saved\)\)/.test(read("handoff.js")));
  const c = { $: () => ({ hidden: false, textContent: "" }), t: (k) => k }; vm.runInNewContext(cutFn(pf, "spPaintSaved") + "\nthis.f = spPaintSaved;", c);
  const box = { hidden: true, textContent: "" }; c.$ = () => box; c.f(true); const a = [box.hidden, box.textContent]; c.f(false);
  ok("⑥ spPaintSaved:開 = 出「已儲存」;關 = 收起清字", a[0] === false && a[1] === "tr.saved" && box.hidden === true && box.textContent === "");
  // #7:系統代收側欄
  const cls = new Set(), saved = [], els = {}, el = (id) => (els[id] = els[id] || { attrs: {}, classList: { toggle() {} }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } });
  const ctx = { document: { documentElement: { classList: { toggle: (k, on) => (on ? cls.add(k) : cls.delete(k)), contains: (k) => cls.has(k) }, style: { setProperty() {} } } },
    $: (id) => el(id), localStorage: { setItem: (k, v) => saved.push(k), getItem: () => null }, window: { innerWidth: 1400 } };
  vm.runInNewContext(app.slice(app.indexOf("const PANES = {"), app.indexOf("let paneSideAuto = false;"))
    + "\nlet paneSideAuto = false;\n" + ["paneOff", "paneSideForce", "paneEdge", "paneClamp", "panesRender", "paneToggle"].map((n) => cutFn(app, n)).join("\n")
    + "\nthis.force = paneSideForce; this.st = paneSt; this.toggle = paneToggle;", ctx);
  ctx.force(true);
  ok("⑥ #7 雲端沒主機:左欄收成細軌(ws-sc)、標 ws-sc-auto(細軌不給展開)、不寫用戶的收合偏好;側欄分隔線 tabindex -1、aria-disabled", cls.has("ws-sc") && cls.has("ws-sc-auto") && ctx.st.side.off === false && saved.length === 0
    && els["div-side"].tabIndex === -1 && els["div-side"].attrs["aria-disabled"] === "true" && els["div-chat"].tabIndex === 0);
  ctx.force(false);
  ok("⑥ 主機開好／切回本機:回到用戶原本展開的樣子", !cls.has("ws-sc") && !cls.has("ws-sc-auto") && saved.length === 0);
  ctx.toggle("side", true); saved.length = 0; ctx.force(true); ctx.force(false);
  ok("⑥ 用戶本來就收著:代收結束後照舊收著", cls.has("ws-sc") && !cls.has("ws-sc-auto") && ctx.st.side.off === true && saved.length === 0);
  // 複稽 c:代收時視窗縮小、聊天欄照 44 的側欄夾寬;代收結束側欄回原寬時兩欄重夾,中欄保底 480
  ctx.toggle("side", false); ctx.force(true); ctx.window.innerWidth = 1100; ctx.st.chat.want = 720; ctx.st.chat.w = 720 - 0; ctx.force(false);
  ok("⑥ 代收結束兩欄重夾:中欄 ≥ 480(MAIN_MIN)", 1100 - ctx.st.side.w - ctx.st.chat.w >= 480, [ctx.st.side.w, ctx.st.chat.w]);
  // 複稽 a:代收時分隔線拖、鍵盤、雙擊都不改偏好
  const pi = app.slice(app.indexOf("function panesInit()"), app.indexOf("\npanesInit();"));
  ok("⑥ 代收時分隔線鎖住:pointerdown／dblclick／keydown 都先問 locked();畫的時候 tabindex -1 + aria-disabled", /const locked = \(\) => key === "side" && paneSideAuto;/.test(pi)
    && /if \(e\.button !== 0 \|\| locked\(\)\) return;/.test(pi) && /if \(Date\.now\(\) - handleAt < 500 \|\| locked\(\)\) return;/.test(pi) && /d\.addEventListener\("keydown", \(e\) => \{\n\s*if \(locked\(\)\) return;/.test(pi)
    && /d\.tabIndex = locked \? -1 : 0;/.test(cutFn(app, "panesRender")));
  // 複稽 b:代收時按細軌更新圓鈕(回合中被鎖):原因走 title + aria-describedby,不去展開、不寫進藏著的列
  { const btn = { id: "up-rail", title: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, after(n) { this.next = n; } }, said = [], hit = [], toggled = [];
    const c2 = { upPillNow: () => ({ show: true, kind: "ready" }), busyLocked: () => true, paneSideAuto: true, $: (id) => (id === "up-rail-why" ? btn.next || null : { focus() {} }), document: { createElement: () => ({}) },
      t: (k) => k, srSay: (s) => said.push(s), busyHit: (k) => hit.push(k), paneToggle: (...a) => toggled.push(a), paneSt: { side: { off: false } }, busyTell: () => toggled.push("tell"), busySlot: () => ({}), trackFeature() {}, upRestartAsk() {} };
    vm.runInNewContext(cutFn(app, "upPillClick") + "\nupPillClick(btn);", Object.assign(c2, { btn }));
    ok("⑥ 代收時細軌更新圓鈕被鎖:title 與 aria-describedby 都指到 busy.update、念一次、記 lock;不展開側欄、不寫藏著的列", btn.title === "busy.update" && btn.attrs["aria-describedby"] === "up-rail-why"
      && btn.next && btn.next.textContent === "busy.update" && btn.next.className === "sr-only" && said.join() === "busy.update" && hit.join() === "update" && toggled.length === 0, { t: btn.title, toggled }); }
  ok("⑥ envPaint 在雲端沒主機(不含「準備好了」)時叫 paneSideForce", /paneSideForce\(cloud && gate && !ready\)/.test(trade)); }

console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
