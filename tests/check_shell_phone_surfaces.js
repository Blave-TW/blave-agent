// 手機對話在電腦版的三個畫面(desktop-phone-chat-settings-2026-10-30 §1–§10、mchat-phone-surfaces-2026-10-31 §1–§3):
// 分頁上的手機記號(V1:最窄 82)、「來自手機」標籤、設定 › 連結的手機那一組。從原文切出函式,配一個最小的假 DOM 真的跑,不開 Electron。
// 跑法:node tests/check_shell_phone_surfaces.js
const fs = require("fs"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
const app = fs.readFileSync(path.join(R, "app.js"), "utf8"), ct = fs.readFileSync(path.join(R, "chattabs.js"), "utf8"), css = fs.readFileSync(path.join(R, "app.css"), "utf8");
const html = fs.readFileSync(path.join(R, "index.html"), "utf8"), pkg = JSON.parse(fs.readFileSync(path.join(SHELL, "package.json"), "utf8"));
const PO = ["zh", "en"].map((l) => fs.readFileSync(path.join(SHELL, "i18n", l + ".po"), "utf8"));
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const fnOf = (src, name) => { const i = src.search(new RegExp("(async )?function " + name + "\\(")); if (i < 0) throw new Error("找不到 " + name); return src.slice(i, src.indexOf("\n}", i) + 2); };
const lineOf = (src, re) => { const m = src.match(re); if (!m) throw new Error("找不到 " + re); return m[0]; };
const po = (L, k) => { const m = PO[L].match(new RegExp('msgid "' + k.replace(/\./g, "\\.") + '"\\nmsgstr "([^"]*)"')); return m ? m[1] : null; };

// ── 假 DOM:只做這幾支函式用到的 ──
function el(tag) {
  const n = { tagName: tag, children: [], attrs: {}, classSet: new Set(), _txt: "", _html: "", listeners: {}, hidden: false, id: "", dataset: {}, style: {},
    append(...xs) { xs.forEach((x) => { n.children.push(typeof x === "string" ? { text: x } : x); }); },
    appendChild(x) { n.children.push(x); return x; },
    setAttribute(k, v) { n.attrs[k] = String(v); }, getAttribute(k) { return k in n.attrs ? n.attrs[k] : null }, hasAttribute(k) { return k in n.attrs; },
    addEventListener(ev, fn) { n.listeners[ev] = fn; }, focus() { doc.activeElement = n; },
    classList: { add: (c) => n.classSet.add(c), remove: (c) => n.classSet.delete(c), contains: (c) => n.classSet.has(c), toggle: (c, on) => (on ? n.classSet.add(c) : n.classSet.delete(c)) } };
  Object.defineProperty(n, "className", { get: () => [...n.classSet].join(" "), set: (v) => { n.classSet = new Set(String(v).split(/\s+/).filter(Boolean)); } });
  Object.defineProperty(n, "textContent", { get: () => (n._html ? "" : "") + n.children.map((c) => (c.text != null ? c.text : c.textContent)).join(""), set: (v) => { n.children = v ? [{ text: String(v) }] : []; } });
  Object.defineProperty(n, "innerHTML", { get: () => n._html, set: (v) => { n._html = v; n.children = []; } });
  return n;
}
const doc = { createElement: el, activeElement: null };
const walk = (n, out = []) => { (n.children || []).forEach((c) => { if (c && c.tagName) { out.push(c); walk(c, out); } }); return out; };
const byCls = (root, c) => walk(root).filter((x) => x.classSet.has(c));
const byId = (root, id) => walk(root).find((x) => x.id === id);
const mk = (tag, cls, text) => { const x = el(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
// t 的替身:key(+ vars);phFill 要換佔位的那幾句給帶佔位的樣板
const TPL = { "ph.meta": "ph.meta {paired} {used}", "ph.metaNever": "ph.metaNever {paired}", "ph.pairUntil": "{hm} ph.pairUntil" };
const t = (k, v) => (v ? k + JSON.stringify(v) : TPL[k] || k);

// ── 1. 分頁上的手機記號 ──
{
  const PHONE_IC = eval(lineOf(app, /const PHONE_IC = [^\n]*;/).replace(/^const PHONE_IC = /, "(").replace(/;$/, ")"));
  ok("手機圖示 = lucide smartphone、aria-hidden、一份給分頁／選單／標籤共用", /<rect width="14" height="20" x="5" y="2" rx="2"\/><path d="M12 18h\.01"\/>/.test(PHONE_IC) && /aria-hidden="true"/.test(PHONE_IC)
    && /\.msg-from \.ic, \.tab-ph \.ic \{ width: 16px; height: 16px; stroke-width: 1\.75; \}/.test(css) && /\.tab-ph \{ flex: none; display: flex; width: 16px; height: 16px; color: var\(--ink-3\); \}/.test(css) && !/tab-phone|tabs\.phone/.test(ct + app + css + PO.join("")));
  const env = { document: doc, PHONE_IC, t, CS: { cur: null, tabs: new Map() }, PH: null,
    tabsStateOf: (T) => T.st, tabsNeedsYou: () => false, tabsTitle: (T) => T.title, trackFeature() {}, tabShow() {}, tabsFreeze() {}, tabsClose() {}, tabsTip() {}, tabsTipOff() {}, csShowList() {}, $: () => ({ hidden: true }),
    TAB_X: "x", tabsLead: (st) => (st ? mk("span", "tab-lead") : null), tabsStateWord: (T, st) => (st === "run" ? "回覆中 · 3s" : st === "queued" ? "排隊中" : "") };
  const defs = [lineOf(ct, /const tabsPhone = [^\n]*;/), lineOf(ct, /function tabsPhoneEl\(\) [^\n]*/), lineOf(ct, /const tabsWordFull = [^\n]*;/), fnOf(ct, "tabsTabEl")].join("\n");
  const F = new Function("env", "with (env) { " + defs + "\nreturn { tabsPhone, tabsTabEl, tabsWordFull }; }")(env);
  const A = { sid: "desktop-a0000001", title: "把 SOL 突破策略上線", st: "run" }, B = { sid: "desktop-b0000001", title: "ETH", st: "run" };
  env.PH = { phoneSids: { "desktop-a0000001": 1 } };
  const ea = F.tabsTabEl(A), eb = F.tabsTabEl(B), kids = ea.children.map((c) => c.className || "");
  ok("有手機回合的分頁:[狀態格][手機格][標題],標題後藏「，來自手機」給讀屏;沒有手機回合的不留那一格", kids[0] === "tab-lead" && kids[1] === "tab-ph" && kids[2] === "tab-t"
    && ea.children[3].className === "sr-only" && ea.children[3].textContent === "，chat.fromPhone" && !byCls(eb, "tab-ph").length, kids);
  ok("tooltip 第二行與 +N 選單的狀態字:手機那條前面加「來自手機 · 」", F.tabsWordFull(A, "run") === "chat.fromPhone · 回覆中 · 3s" && F.tabsWordFull(B, "run") === "回覆中 · 3s" && F.tabsWordFull({ sid: "desktop-a0000001" }, "queued") === "chat.fromPhone · 排隊中");
  env.PH = { phoneSids: {} };
  ok("手機回合結束(phoneSids 沒有這條)記號就拿掉,交給未讀點", !F.tabsPhone(A) && !byCls(F.tabsTabEl(A), "tab-ph").length);
  ok("tooltip 用 tabsWordFull、+N 選單列也畫手機格", /word = tabsWordFull\(T, tabsStateOf\(T\)\);/.test(fnOf(ct, "tabsTip")) && /if \(tabsPhone\(T\)\) it\.appendChild\(tabsPhoneEl\(\)\);/.test(fnOf(ct, "tabsMenuPaint")) && /const word = tabsWordFull\(T, st\);/.test(fnOf(ct, "tabsMenuPaint")));
  // V1:手機分頁的最窄 82(= 60 + 16 + 6),選中照 112
  const minsLine = lineOf(ct, /const mins = nat\.map[^\n]*;/);
  const mins = new Function("nat", "order", "curSid", "CS", "tabsPhone", "TABS_MIN", "TABS_MIN_SEL", "TABS_MIN_PHONE", minsLine + " return mins;");
  const tabs = new Map([["a", { sid: "a" }], ["b", { sid: "b" }], ["c", { sid: "c" }]]);
  const got = mins([200, 200, 200], ["a", "b", "c"], "a", { tabs }, (T) => T.sid !== "c", 60, 112, eval(lineOf(ct, /TABS_MIN_PHONE = \d+/).split("=")[1]));
  ok("V1:沒選中的手機分頁最窄 82、一般 60、選中 112(縮到最窄記號也在)", JSON.stringify(got) === "[112,82,60]", got);
  // 背景開成分頁時念一次「{標題}，來自手機」
  ok("手機對話開成背景分頁:列外 aria-live 念「{標題}，來自手機」,只在新開的時候", /if \(!was && o\.focus === false\) \{ const el = \$\("tabs-live"\);[^\n]*tabsTitle\(T\) \+ "，" \+ t\("chat\.fromPhone"\)/.test(ct) && !/T\.phone/.test(ct));
}

// ── 2. 「來自手機」標籤 ──
{
  const added = [];
  const env = { document: doc, PHONE_IC: "<svg/>", t, splitAttachNote: (c) => ({ text: c, attachments: [] }), addMsg: () => { const m = mk("div", "msg you"); added.push(m); return m; } };
  const add = new Function("env", "with (env) { " + fnOf(app, "addHistoryYou") + "\nreturn addHistoryYou; }")(env);
  const m1 = add("hi", "mobile"), m2 = add("hi", "desktop");
  const lab = byCls(m1, "msg-from")[0];
  ok("手機送的那則:.msg.you 加 from-phone(改直排,標籤在泡泡下方不在左邊),標籤 = 圖示 + 「來自手機」;電腦前送的沒有", m1.classSet.has("from-phone") && !!lab && lab._html === "<svg/>" && lab.textContent === "chat.fromPhone" && !m2.classSet.has("from-phone") && !byCls(m2, "msg-from").length);
  ok("CSS:from-phone 直排靠右、標籤 flex 一行、離泡泡 4、12px --ink-3", /\.msg\.you\.from-phone \{ flex-direction: column; align-items: flex-end; \}/.test(css)
    && /\.msg\.you \.msg-from \{ display: flex; align-items: center; gap: var\(--space-6\); margin-top: var\(--space-4\); font-size: 12px; line-height: 1\.4; color: var\(--ink-3\); \}/.test(css));
}

// ── 3. 設定 › 連結的手機那一組 ──
{
  const names = ["phDate", "phFill", "phQr", "phRetryInto", "phActsBox", "phRow", "phPairPanel", "phGroup", "phStatus", "phBlock"];
  const consts = [lineOf(app, /const phShown = [^\n]*;/), lineOf(app, /const phName = [^\n]*;/), lineOf(app, /const PH_ACT = [^\n]*;/)];
  const env = { document: doc, t, qrcode: require(path.join(SHELL, "node_modules", "qrcode-generator")), $: () => null, setCat() {}, srSay() {},
    phToggle() {}, phPairClick() {}, phGrant() {}, phRevoke() {}, phActs() {}, phActsLoad() {}, phPhonesReload() {}, phRetry() {}, phPair() {} };
  const S = new Function("env", "with (env) { var PH, PH_ERR = '', PH_PHONES = null, PH_CODE = null, PH_ACTS = null, PH_MSG = '', PH_QUIET = false;\n" + consts.join("\n") + "\n" + names.map((n) => fnOf(app, n)).join("\n")
    + "\nreturn { set: (o) => { for (const k in o) eval(k + ' = o[k]'); }, " + names.join(", ") + " }; }")(env);
  const now = new Date(2026, 9, 31, 13, 5).getTime();
  ok("日期 MM/DD HH:mm(24 小時、補零),不是今年加年份;讀不懂寫「—」", S.phDate(new Date(2026, 9, 28, 9, 2).toISOString(), now) === "10/28 09:02" && S.phDate(new Date(2025, 0, 3, 21, 40).toISOString(), now) === "2025/01/03 21:40" && S.phDate(null, now) === "—" && S.phDate("x", now) === "—");
  const q = S.phQr("K7M2Q9XW");
  ok("配對 QR:本機產生(data:image)、內容格式 BLAVE-PAIR:{8 碼} 放得進版本 1(21 格),顯示 (21+8)×4 = 116;CSP 允許 data: 圖;套件釘版本、頁面載入", /^data:image\/gif;base64,/.test(q.src) && q.size === 116
    && /addData\("BLAVE-PAIR:" \+ code, "Alphanumeric"\)/.test(fnOf(app, "phQr")) && /img-src 'self' data:/.test(html) && html.includes('<script src="../node_modules/qrcode-generator/dist/qrcode.js"></script>') && pkg.dependencies["qrcode-generator"] === "2.0.4");
  const sync = { running: false, done: 0, total: 0, error: false, synced: true };
  // 關著:只有開關(+ 待刪時那一句),手機那一組不出
  S.set({ PH: { visible: true, signedIn: true, on: false, pending: false, sync } });
  const off = S.phBlock(mk), offSt = byId(off, "ph-status");
  ok("關著:只有開關,狀態槽是空的(hidden)、手機那一組不出", !!byId(off, "ph-sw") && offSt.hidden === true && !byCls(off, "ph-grp").length);
  const lbl = walk(off).find((x) => x.tagName === "label"), sw = byId(off, "ph-sw");
  ok("開關 label 掛 tooltip:「允許手機對話」虛線字 + .tip(ph.tip);開關 aria-labelledby／describedby 指過去,沒有 aria-label", byId(lbl, "ph-l").classSet.has("set-tipl") && byId(lbl, "ph-tip").textContent === "ph.tip" && byId(lbl, "ph-tip").getAttribute("role") === "tooltip"
    && sw.getAttribute("aria-labelledby") === "ph-l" && sw.getAttribute("aria-describedby") === "ph-tip" && !("aria-label" in sw.attrs) && /\.ph-top:has\(\.sw:focus-visible:not\(\[data-tip-off\]\)\) \.tip \{ display: block; \}/.test(css));
  S.set({ PH: { visible: true, signedIn: true, on: false, pending: true, sync } });
  ok("關了、伺服器那份還沒刪成:槽裡只有待刪那一句", byId(S.phBlock(mk), "ph-status").textContent === "ph.pending");
  // 狀態槽:一次一句,開啟失敗 > 待刪 > 同步失敗 > 同步中
  const st = (ph, err, quiet) => { S.set({ PH: Object.assign({ visible: true, signedIn: true, on: true, pending: false }, ph), PH_ERR: err || "", PH_QUIET: !!quiet, PH_PHONES: { ok: true, max: 5, phones: [] } }); return S.phStatus(mk); };
  const s1 = st({ pending: true, sync: { error: true, total: 9, done: 2 } }, "ph.err"), s2 = st({ pending: true, sync: { error: true } }), s3 = st({ sync: { error: true, total: 48, done: 12 } }), s4 = st({ sync: { error: true } }), s5 = st({ sync: { running: true, total: 48, done: 12 } }), s6 = st({ sync: { running: true, total: 48, done: 13 } }, "", true), s7 = st({ sync: { synced: true } });
  ok("狀態槽一次一句(role=status):開啟失敗 > 待刪 > 同步失敗(有總數／沒總數,接〔重試〕)> 同步中 > 空;同步完成不留字", s1.textContent === "ph.err" && s2.textContent === "ph.pending"
    && s3.textContent === 'ph.syncFail{"n":12,"m":48} ph.retry' && byId(s3, "ph-retry") && s4.textContent === "ph.syncFail0 ph.retry" && s5.textContent === 'ph.syncing{"n":12,"m":48}' && s7.hidden === true && s1.getAttribute("role") === "status");
  ok("同步中數字變的那幾次不念(aria-live off),開始那一次照念", s6.getAttribute("aria-live") === "off" && s5.getAttribute("aria-live") === null);
  // 開著、兩支手機、最近操作展開
  const iso = (d, h, mi) => new Date(2026, 9, d, h, mi).toISOString();
  const phones = [{ device_id: "a".repeat(32), platform: "ios", label: "iPhone 15", created_at: iso(28, 9, 2), last_used_at: iso(30, 13, 0), granted: true },
    { device_id: "b".repeat(32), platform: "android", label: "", created_at: iso(29, 21, 40), last_used_at: null, granted: false }];
  const rows = Array.from({ length: 12 }, (_, i) => ({ ts: iso(30, 12, 59 - i), action: i ? "send" : "grant", ip: i ? "203.0.113.5" : "" }));
  S.set({ PH: { visible: true, signedIn: true, on: true, pending: false, sync }, PH_ERR: "", PH_PHONES: { ok: true, max: 5, phones }, PH_ACTS: { id: "a".repeat(32), rows, all: false }, PH_CODE: null, PH_MSG: "" });
  const on = S.phBlock(mk), grp = byCls(on, "ph-grp")[0], rowsEl = byCls(on, "ph-row");
  ok("手機那一組:role=group、組標籤「允許連這台的手機」、〔配對手機〕在右(aria-expanded false)", grp.getAttribute("role") === "group" && grp.getAttribute("aria-labelledby") === "ph-gl" && byId(grp, "ph-gl").textContent === "ph.group" && byId(grp, "ph-pair").getAttribute("aria-expanded") === "false");
  const sw1 = byId(rowsEl[0], "ph-g-" + "a".repeat(32)), sw2 = byId(rowsEl[1], "ph-g-" + "b".repeat(32));
  ok("每支手機一列:Switch(role=switch、aria-labelledby 機型名)不是勾選框;機型名空的用 Android 手機", sw1.getAttribute("role") === "switch" && sw1.getAttribute("aria-checked") === "true" && sw2.getAttribute("aria-checked") === "false" && sw2.classSet.has("off")
    && byId(rowsEl[0], sw1.getAttribute("aria-labelledby")).textContent === "iPhone 15" && byId(rowsEl[1], sw2.getAttribute("aria-labelledby")).textContent === "ph.android" && !walk(on).some((x) => x.tagName === "input"));
  const meta1 = byCls(rowsEl[0], "m")[0], meta2 = byCls(rowsEl[1], "m")[0];
  ok("第二行:配對／最近使用的日期 MM/DD HH:mm 用 mono;還沒用過換 metaNever", meta1.children.filter((c) => c.className === "mono").map((c) => c.textContent).join() === "10/28 09:02,10/30 13:00"
    && meta2.children.filter((c) => c.className === "mono").map((c) => c.textContent).join() === "10/29 21:40" && /^ph\.metaNever/.test(meta2.textContent), [meta1.textContent, meta2.textContent]);
  const btns = (r) => byCls(byCls(r, "ph-meta")[0], "btn-quiet").map((b) => b.children[0] && b.children[0].text);
  ok("〔最近操作〕〔撤銷〕兩種列都有(開關關著的那支也撤得掉);最近操作是展開鈕(aria-expanded、aria-controls、.cv7)", btns(rowsEl[0]).join() === "ph.acts,ph.revoke" && btns(rowsEl[1]).join() === "ph.acts,ph.revoke"
    && byId(rowsEl[0], "ph-acts-" + "a".repeat(32)).getAttribute("aria-expanded") === "true" && byId(rowsEl[1], "ph-acts-" + "b".repeat(32)).getAttribute("aria-expanded") === "false"
    && byId(rowsEl[0], "ph-acts-" + "a".repeat(32)).getAttribute("aria-controls") === "ph-a-" + "a".repeat(32) && byCls(rowsEl[0], "cv7").length === 1, [btns(rowsEl[0]), btns(rowsEl[1])]);
  const acts = byCls(rowsEl[0], "ph-acts")[0], li = acts.children;
  ok("最近操作:三欄 grid(時間 mono｜操作｜IP mono),先 10 筆、多的有〔顯示全部〕;IP 沒有寫「—」;不用項目符號", li.length === 10 && li[0].children.map((c) => c.textContent).join("|") === "10/30 12:59|ph.act.grant|—"
    && li[1].children[2].textContent === "203.0.113.5" && byCls(rowsEl[0], "ph-acts-more").length === 1 && /\.ph-acts \{ display: grid; grid-template-columns: max-content 1fr max-content;[^}]*list-style: none;/.test(css) && /\.ph-acts li \{ display: contents; \}/.test(css));
  S.set({ PH_ACTS: { id: "a".repeat(32), rows, all: true } });
  const all = byCls(S.phBlock(mk), "ph-acts")[0];
  S.set({ PH_ACTS: { id: "a".repeat(32), rows: [], all: false } }); const none = byCls(S.phBlock(mk), "ph-acts-msg")[0];
  S.set({ PH_ACTS: { id: "a".repeat(32), rows: null, all: false } }); const fail = byCls(S.phBlock(mk), "ph-acts-msg")[0];
  ok("〔顯示全部〕原地展開(到 50);沒有紀錄一行「—」;讀不到用 ph.actsFail +〔重試〕(不借手機清單那句)", all.children.length === 12 && none.textContent === "—" && fail.textContent === "ph.actsFail ph.retry");
  // 配對面板
  S.set({ PH_ACTS: null, PH_CODE: { code: "K7M2Q9XW", until: Date.now() + 600000 } });
  const pr = S.phBlock(mk), panel = byId(pr, "ph-panel"), img = walk(panel).find((x) => x.tagName === "img");
  ok("配對面板:QR(alt 空、白底板)+ 碼 K7M2-Q9XW + 怎麼掃 + HH:mm 前有效;〔配對手機〕aria-expanded true", byId(pr, "ph-pair").getAttribute("aria-expanded") === "true" && img.alt === "" && img.width === 116
    && byCls(panel, "ph-code")[0].textContent === "K7M2-Q9XW" && /^ph\.pairHow/.test(byCls(panel, "ph-how")[0].textContent) && byCls(panel, "ph-how")[0].children.some((c) => c.className === "mono" && /^\d\d:\d\d$/.test(c.textContent)), [img && img.width, byCls(panel, "ph-how")[0].textContent]);
  S.set({ PH_CODE: { code: "K7M2Q9XW", until: Date.now() - 1 } });
  const ex = byId(S.phBlock(mk), "ph-panel");
  ok("配對碼過期:面板換成「配對碼過期了。〔重新產生〕」,不自動再要", ex.textContent === "ph.pairExpired ph.pairAgain" && !walk(ex).some((x) => x.tagName === "img"));
  // 上限、讀不到清單、訊息槽
  S.set({ PH_CODE: null, PH_PHONES: { ok: true, max: 2, phones }, PH_MSG: "ph.pairMax" });
  const full = S.phBlock(mk), fp = byId(full, "ph-pair");
  ok("滿了(max 支):〔配對手機〕aria-disabled、describedby 指到組內訊息槽;按了那一槽放 pairMax", fp.getAttribute("aria-disabled") === "true" && fp.getAttribute("aria-describedby") === "ph-msg" && byId(full, "ph-msg").textContent === "ph.pairMax" && byId(full, "ph-msg").getAttribute("role") === "status");
  S.set({ PH_PHONES: { ok: false }, PH_MSG: "" });
  const lf = S.phBlock(mk);
  ok("讀不到手機清單:組內訊息槽「讀不到手機清單。〔重試〕」,開關下面那一槽不受影響(兩個容器各一個槽)", byId(lf, "ph-msg").textContent === "ph.phonesFail ph.retry" && byId(lf, "ph-status").hidden === true);
  // 撤銷框、開啟框、關閉框的字
  ok("撤銷框:標題帶機型名、第二句固定出現(ph.revoke.stop),不看條件;舊的 ph.revoke.live 刪掉", /title: t\("ph\.revoke\.title", \{ name \}\), lines: \[t\("ph\.revoke\.body"\), t\("ph\.revoke\.stop"\)\]/.test(fnOf(app, "phRevoke"))
    && po(0, "ph.revoke.stop") === "它送來的回覆如果還在跑，會停下。" && po(1, "ph.revoke.stop") === "If a reply it started is still running, it stops." && po(0, "ph.revoke.live") === null);
  ok("開啟框:三段一般內文、第一段 cf-lede(主墨),不用 keep 清單(上方不留空)", /lead\.className = "cf-lede"; lead\.textContent = t\("ph\.cf\.1"\);/.test(fnOf(app, "phToggle")) && /lead, lines: \[t\("ph\.cf\.2"\), t\("ph\.cf\.3"\)\]/.test(fnOf(app, "phToggle")) && !/keep:/.test(fnOf(app, "phToggle"))
    && ["ph.cf.4", "ph.cf.5", "ph.cf.6", "ph.lead", "ph.synced", "ph.noPhones", "ph.noActs", "ph.pairCode", "tabs.phone"].every((k) => po(0, k) === null && po(1, k) === null));
  ok("撤銷成功:焦點移到下一列的開關,沒有就移到〔配對手機〕;讀屏念「已撤銷 {name}」;失敗用 ph.errRow(不是「沒有開成」)", /srSay\(t\("ph\.revokedSay", \{ name \}\)\);/.test(fnOf(app, "phRevoke")) && /\$\("ph-g-" \+ next\.device_id\)\) \|\| \$\("ph-pair"\)/.test(fnOf(app, "phRevoke"))
    && /PH_MSG = "ph\.errRow"/.test(fnOf(app, "phRevoke")) && /PH_MSG = "ph\.errRow"/.test(fnOf(app, "phGrant")) && !/ph\.err"/.test(fnOf(app, "phRevoke") + fnOf(app, "phGrant")));
  ok("開啟成功、帳號沒有手機:直接要碼打開面板;配對成功(relay pairSeq 變了)收起面板、念「已配對 {機型}」", /if \(PH_PHONES && PH_PHONES\.ok && !PH_PHONES\.phones\.length\) await phPair\(\);/.test(fnOf(app, "phSet"))
    && /st\.pairSeq !== was\.pairSeq && PH_CODE/.test(app) && /srSay\(t\("ph\.pairedSay", \{ name: phName\(n\) \}\)\)/.test(app));
}
// ── 字:spec 的表逐字(zh / en) ──
{
  const want = { "chat.fromPhone": ["來自手機", "From phone"], "ph.tip": ["Blave 開著、電腦醒著，手機才送得到。", "Works only while Blave is open and this computer is awake."],
    "ph.cf.1": ["手機送的話會在這台電腦上執行。agent 能做的跟你在電腦前一樣，包括下單。", "Messages from your phone run on this computer. The agent can do anything it can here, including placing orders."],
    "ph.off.live": ["手機送來、正在跑的回覆會停下。", "The reply your phone started will stop."], "ph.off.del": ["伺服器上的對話會刪除，這台電腦上的不受影響。", "Chats on Blave are deleted. Chats on this computer stay."],
    "ph.group": ["允許連這台的手機", "Phones allowed on this computer"], "ph.pairHow": ["用 App 的 Agent 分頁掃描，或輸入這組碼。", "Scan it in the app's Agent tab, or enter the code."],
    "ph.pairMax": ["已有 5 支手機，先撤銷一支才能再配對。", "You have 5 phones. Revoke one to pair another."], "ph.revoke.title": ["撤銷 {name}？", "Revoke {name}?"],
    "ph.revoke.body": ["這支手機不能再跟 agent 對話，要再用得重新配對。", "This phone can no longer chat with the agent. Pair it again to use it."],
    "ph.act.grant": ["允許連這台", "Allowed on this computer"], "ph.act.auth": ["驗證身分", "Verified"],
    "tm.phoneHidden": ["Blave 還開著，手機照樣連得到。要結束請從選單列或 Dock。", "Blave is still open, so your phone can reach it. To quit, use the menu bar or the Dock."] };
  const bad = Object.entries(want).filter(([k, [z, e]]) => po(0, k) !== z || po(1, k) !== e).map(([k]) => k);
  ok("手機對話的字照 spec 逐字(zh / en)", bad.length === 0, bad);
}
console.log(red ? `\n${red} 紅` : "\nALL PASS");
process.exit(red ? 1 : 0);
