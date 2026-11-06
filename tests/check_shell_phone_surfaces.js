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
const TPL = { "ph.meta": "ph.meta {used}" };
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

// ── 3. 設定 › 連結的手機那一組(mockup-web-only-pairing-2026-11-02 §8):開關＋唯讀清單＋到網站撤銷 ──
{
  const names = ["phDate", "phFill", "phRetryInto", "phRow", "phGroup", "phStatus", "phBlock"];
  const consts = [lineOf(app, /const phShown = [^\n]*;/), lineOf(app, /const phName = [^\n]*;/), lineOf(app, /const phWebUrl = [^\n]*;/)];
  const opened = [], tracked3 = [];
  const env = { document: doc, t, LANG: "zh", $: () => null, setCat() {}, srSay() {}, libExtIcon: () => mk("svg", "ic"), trackFeature: (n) => tracked3.push(n), window: { blave: { openExternal: (u) => opened.push(u) } }, phToggle() {}, phPhonesReload() {}, phRetry() {} };
  const S = new Function("env", "with (env) { var PH, PH_BUSY = false, PH_ERR = '', PH_PHONES = null, PH_QUIET = false;\n" + consts.join("\n") + "\n" + names.map((n) => fnOf(app, n)).join("\n")
    + "\nreturn { set: (o) => { for (const k in o) eval(k + ' = o[k]'); }, " + names.join(", ") + " }; }")(env);
  const now = new Date(2026, 9, 31, 13, 5).getTime();
  ok("日期 MM/DD HH:mm(24 小時、補零),不是今年加年份;讀不懂寫「—」", S.phDate(new Date(2026, 9, 28, 9, 2).toISOString(), now) === "10/28 09:02" && S.phDate(new Date(2025, 0, 3, 21, 40).toISOString(), now) === "2025/01/03 21:40" && S.phDate(null, now) === "—" && S.phDate("x", now) === "—");
  const sync = { running: false, done: 0, total: 0, error: false, synced: true };
  S.set({ PH: { visible: true, signedIn: true, on: false, pending: false, sync } });
  const off = S.phBlock(mk), offSt = byId(off, "ph-status");
  ok("關著:只有開關,狀態槽是空的(hidden)、手機那一組不出", !!byId(off, "ph-sw") && offSt.hidden === true && !byCls(off, "ph-grp").length);
  const lbl = walk(off).find((x) => x.tagName === "label"), sw = byId(off, "ph-sw");
  ok("開關 label 掛 tooltip:「允許手機對話」虛線字 + .tip(ph.tip);開關 aria-labelledby／describedby 指過去,沒有 aria-label", byId(lbl, "ph-l").classSet.has("set-tipl") && byId(lbl, "ph-tip").textContent === "ph.tip" && byId(lbl, "ph-tip").getAttribute("role") === "tooltip"
    && sw.getAttribute("aria-labelledby") === "ph-l" && sw.getAttribute("aria-describedby") === "ph-tip" && !("aria-label" in sw.attrs) && /\.ph-top:has\(\.sw:focus-visible:not\(\[data-tip-off\]\)\) \.tip \{ display: block; \}/.test(css));
  S.set({ PH: { visible: true, signedIn: true, on: false, pending: true, sync } });
  ok("關了、伺服器那份還沒刪成:槽裡只有待刪那一句", byId(S.phBlock(mk), "ph-status").textContent === "ph.pending");
  const st = (ph, err, quiet) => { S.set({ PH: Object.assign({ visible: true, signedIn: true, on: true, pending: false }, ph), PH_ERR: err || "", PH_QUIET: !!quiet, PH_PHONES: { ok: true, phones: [] } }); return S.phStatus(mk); };
  const s1 = st({ pending: true, sync: { error: true, total: 9, done: 2 } }, "ph.err"), s2 = st({ pending: true, sync: { error: true } }), s3 = st({ sync: { error: true, total: 48, done: 12 } }), s4 = st({ sync: { error: true } }), s5 = st({ sync: { running: true, total: 48, done: 12 } }), s6 = st({ sync: { running: true, total: 48, done: 13 } }, "", true), s7 = st({ sync: { synced: true } });
  ok("狀態槽一次一句(role=status):開啟失敗 > 待刪 > 同步失敗(有總數／沒總數,接〔重試〕)> 同步中 > 空;同步完成不留字", s1.textContent === "ph.err" && s2.textContent === "ph.pending"
    && s3.textContent === 'ph.syncFail{"n":12,"m":48} ph.retry' && byId(s3, "ph-retry") && s4.textContent === "ph.syncFail0 ph.retry" && s5.textContent === 'ph.syncing{"n":12,"m":48}' && s7.hidden === true && s1.getAttribute("role") === "status");
  ok("同步中數字變的那幾次不念(aria-live off),開始那一次照念", s6.getAttribute("aria-live") === "off" && s5.getAttribute("aria-live") === null);
  ok("needVerify 那一句與〔重新驗證〕拿掉(打開不再過驗證碼)", !st({ needVerify: true }).textContent && !/needVerify|ph-verify|phReverify/.test(app));
  const iso = (d, h, mi) => new Date(2026, 9, d, h, mi).toISOString();
  const phones = [{ device_id: "a".repeat(32), platform: "ios", label: "iPhone 15", last_used_at: iso(30, 13, 0) }, { device_id: "b".repeat(32), platform: "android", label: "", last_used_at: null }];
  S.set({ PH: { visible: true, signedIn: true, on: true, pending: false, sync }, PH_ERR: "", PH_PHONES: { ok: true, phones } });
  const on = S.phBlock(mk), grp = byCls(on, "ph-grp")[0], rowsEl = byCls(on, "ph-row");
  const webB = byId(grp, "ph-web");
  ok("開著:組標籤「帳號下的手機」(ph.list,role=group)、右邊〔到網站撤銷〕", grp.getAttribute("role") === "group" && grp.getAttribute("aria-labelledby") === "ph-gl" && byId(grp, "ph-gl").textContent === "ph.list" && webB.children[0].text === "ph.webRevoke");
  ok("〔到網站撤銷〕會開瀏覽器:字後面接 ↗(libExtIcon)、讀屏名稱帶「在瀏覽器開啟」;熱區補到 44 高(同〔檢查更新〕)", webB.children.at(-1).classSet.has("ic") && webB.getAttribute("aria-label") === "ph.webRevoke.aria" && webB.classSet.has("ph-web")
    && /\.ph-web::before \{ inset: -15px -4px; \}/.test(css) && /#set-up-btn::before \{ inset: -15px -4px; \}/.test(css));
  byId(grp, "ph-web").listeners.click();
  ok("〔到網站撤銷〕外開網站 設定 › 已配對的手機(帶語言、from=desktop),記 phone_web_revoke(只送名字)", opened.at(-1) === "https://blave.org/landing/zh/setting?tab=phones&from=desktop" && tracked3.join() === "phone_web_revoke"
    && fs.readFileSync(path.join(SHELL, "telemetry.js"), "utf8").includes('"phone_ask_no", "phone_web_revoke",'), [opened, tracked3]);
  ok("每支一列唯讀:機型(空的用 Android 手機)+ 最近使用(mono)/還沒用過;沒有開關、勾選、最近操作、撤銷", rowsEl.length === 2 && byCls(rowsEl[0], "ph-name")[0].textContent === "iPhone 15" && byCls(rowsEl[1], "ph-name")[0].textContent === "ph.android"
    && byCls(rowsEl[0], "ph-meta")[0].children.some((c) => c.className === "mono" && c.textContent === "10/30 13:00") && byCls(rowsEl[1], "ph-meta")[0].textContent === "ph.metaNever"
    && !walk(grp).some((x) => x.tagName === "input" || x.getAttribute("role") === "switch" || x.tagName === "img") && !walk(grp).some((x) => x.tagName === "button" && x.id !== "ph-web"));
  ok("確認框段落 text-wrap: pretty(同意框第一段末行不留孤字)", /\.del-body\.lines p\{margin:0;text-wrap:pretty\}/.test(css));
  S.set({ PH_PHONES: { ok: true, phones: [] } });
  const empty = byCls(S.phBlock(mk), "ph-grp")[0];
  ok("帳號還沒有手機:組內一句 ph.none,不出〔到網站撤銷〕(出口在 App)", byId(empty, "ph-msg").textContent === "ph.none" && !byId(empty, "ph-web") && !byCls(empty, "ph-list").length);
  S.set({ PH_PHONES: { ok: false } });
  const lf = S.phBlock(mk);
  ok("讀不到手機清單:組內訊息槽「讀不到手機清單。〔重試〕」,開關下面那一槽不受影響", byId(lf, "ph-msg").textContent === "ph.phonesFail ph.retry" && byId(lf, "ph-status").hidden === true);
  ok("配對面板、QR、勾選、撤銷、最近操作與 qrcode-generator 都拿掉", !/phQr|phPairPanel|phPair\b|phGrant|phRevoke|phActs|qrcode|relayPairCode|relayGrant|relayRevoke|relayActions|PH_CODE|PH_ACTS|PH_KC/.test(app)
    && !html.includes("qrcode-generator") && !("qrcode-generator" in pkg.dependencies) && !/\.ph-pair|\.ph-code|\.ph-acts|ph-verify/.test(css) && /img-src 'self' data:/.test(html));
  ok("開啟框:三段一般內文、第一段 cf-lede(主墨);取消走 phCfDrop", /title: t\("ph\.cf\.title"\), lead: phCfLead\(\), lines: \[t\("ph\.cf\.2"\), t\("ph\.cf\.3"\)\], ok: t\("ph\.cf\.ok"\), stay: true, opener, onOk: \(\) => phSet\(true\), onCancel: phCfDrop/.test(fnOf(app, "phToggle"))
    && /lead\.className = "cf-lede"; lead\.textContent = t\("ph\.cf\.1"\);/.test(lineOf(app, /function phCfLead\(\) [^\n]*/)));
}
// ── 字:spec 的表逐字(zh / en),拿掉的字不留 ──
{
  const want = { "chat.fromPhone": ["來自手機", "From phone"], "ph.tip": ["Blave 開著、電腦醒著，手機才送得到。", "Works only while Blave is open and this computer is awake."],
    "ph.cf.1": ["帳號下所有手機都能叫這台做事，包括下單。之後新配對的手機也一樣。", "Every phone on your account can tell this computer what to do, including placing orders. Phones paired later can too."],
    "ph.cf.2": ["近 30 天和之後的對話會上傳，金鑰與資料夾路徑會先遮掉。關掉就刪除伺服器上那份。", "Chats from the last 30 days and new ones are uploaded, with keys and folder paths masked. Turning this off deletes the copy on Blave."],
    "ph.cf.3": ["附件、策略程式和舊對話的圖片不上傳。回覆手機時的圖片會上傳。", "Attachments, strategy code and images in older chats stay here. Images in replies to your phone are uploaded."], "ph.cf.ok": ["打開", "Turn On"], "ph.off.ok": ["關閉", "Turn Off"],
    "ph.off.live": ["手機送來、正在跑的回覆會停下。", "The reply your phone started will stop."], "ph.off.del": ["伺服器上的對話會刪除，這台電腦上的不受影響。", "Chats on Blave are deleted. Chats on this computer stay."],
    "acct.out.6": ["手機對話關閉，伺服器上的對話刪除。", "Phone chat turns off. Its chats on Blave are deleted."], "ph.offRelogin": ["重新登入後手機對話已關閉，要用請到 設定 › 連結 重新打開。", "Phone chat was turned off when you signed in again. Turn it back on in Settings › Connections."],
    "ph.list": ["帳號下的手機", "Phones on This Account"], "ph.webRevoke": ["到網站撤銷", "Revoke on Website"], "ph.webRevoke.aria": ["到網站撤銷（在瀏覽器開啟）", "Revoke on Website (opens in browser)"], "ph.none": ["在 App 的 Agent 分頁按〔對話〕配對。", "In the app's Agent tab, tap Chat to pair."],
    "ph.ask.title": ["{name} 想連這台電腦", "{name} wants to connect to this computer"], "ph.ask.no": ["不用", "Not Now"], "ph.ask.ok": ["打開", "Turn On"],
    "ph.meta": ["最近使用 {used}", "Last used {used}"], "ph.metaNever": ["還沒用過", "Not used yet"],
    "tm.phoneHidden": ["Blave 還開著，手機照樣連得到。要結束請從選單列或 Dock。", "Blave is still open, so your phone can reach it. To quit, use the menu bar or the Dock."] };
  const bad = Object.entries(want).filter(([k, [z, e]]) => po(0, k) !== z || po(1, k) !== e).map(([k]) => k);
  ok("手機對話的字照 mockup §10 逐字(zh / en)", bad.length === 0, bad);
  const gone = ["ph.group", "ph.pair", "ph.pairHow", "ph.pairUntil", "ph.pairExpired", "ph.pairAgain", "ph.pairFail", "ph.pairMax", "ph.pairedSay", "ph.acts", "ph.actsMore", "ph.actsFail", "ph.revoke", "ph.revoke.title", "ph.revoke.body", "ph.revoke.stop", "ph.revoke.ok", "ph.revokedSay", "ph.errRow",
    "ph.act.send", "ph.act.grant", "ph.act.auth", "ph.kc.title", "ph.kc.failed", "ph.kc.limitedDead", "ph.verify", "ph.verifyBtn"];
  ok("mockup §10 拿掉的字(配對、勾選、撤銷、最近操作、驗證碼)兩語都不在", gone.every((k) => po(0, k) === null && po(1, k) === null), gone.filter((k) => po(0, k) !== null || po(1, k) !== null));
  const zhLen = ["ph.cf.1", "ph.list", "ph.webRevoke", "ph.none", "ph.ask.title", "ph.ask.no", "ph.ask.ok", "ph.meta", "ph.metaNever"].flatMap((k) => po(0, k).split(/[。？]/)).filter((x) => [...x].length > 25);
  ok("這次新寫、改寫的字每句 ≤ 25 字(canon 文案密度)", zhLen.length === 0, zhLen);
}
// ── 4. 打開與配對確認框:phSet／phAskMaybe 真的跑,假 relaySet ──
(async () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const run = async (answers, steps, o = {}) => {
    const calls = [], boxes = [], closed = [], busy = [], tracked = [], hints = [], shown = [], nos = [], order = answers.slice(), delOk = { disabled: false }, scrim = { hidden: false }, conn = { hidden: o.connHidden === true };
    const title = el("h2"); title.textContent = "";
    const delScrim = { hidden: o.delOpen !== true }, otherScrim = { hidden: o.otherOpen !== true }, delBody = el("div"), active = o.active || null;
    let gate = null;
    const env = { document: Object.assign({}, doc, { visibilityState: o.hiddenWin ? "hidden" : "visible", addEventListener() {}, querySelectorAll: (q) => (q === ".scrim" ? [otherScrim, delScrim] : []), activeElement: active, body: "body" }), t, LANG: "en", srSay() {}, connectPaint: () => { env.paints = (env.paints || 0) + 1; }, phPhonesReload: async () => { env.reloads = (env.reloads || 0) + 1; },
      setHint: (h) => hints.push(h), trackFeature: (n) => tracked.push(n),
      window: { blave: { relaySet: async (on) => { calls.push(on); if (o.hold) await new Promise((r) => { gate = r; }); const r = order.shift(); return r === undefined ? { ok: true, state: { on } } : r; },
        relayAskShown: (id) => { shown.push(id); return Promise.resolve(true); }, relayAskNo: (id) => { nos.push(id); return Promise.resolve(true); } } },
      $: (id) => ({ "del-ok": delOk, "set-scrim": scrim, "set-connect": conn, "del-title": title, "del-scrim": delScrim, "del-body": delBody, "ph-box-err": byId(delBody, "ph-box-err") }[id] || null), delOkBusy: (x) => busy.push(x) };
    env.confirmBox = (x) => { boxes.push(x); title.textContent = x.title; title.classSet.delete("cf-wrap"); delBody.children = []; env.setCtx(x); };
    env.delClose = (x) => { closed.push(x); env.closeCtx(); };
    const S = new Function("env", "with (env) { var PH = " + JSON.stringify(o.PH || { visible: true, signedIn: true, on: false }) + ", PH_BUSY = false, PH_WAIT = null, PH_ERR = '', PH_PHONES = null, PH_ASKED = '', PH_ASK_BOX = null, delCtx = null;\n"
      + [lineOf(app, /const phShown = [^\n]*;/), lineOf(app, /const phName = [^\n]*;/), fnOf(app, "phDate"), lineOf(app, /^function phCfDrop\(\) [^\n]*/m), lineOf(app, /^function phCfLead\(\) [^\n]*/m), lineOf(app, /^const phHere = [^\n]*;/m), fnOf(app, "phSet"), fnOf(app, "phBoxErr"), fnOf(app, "phAskMaybe"), fnOf(app, "phAskDrop"), lineOf(app, /^function phRepaint\(\) [^\n]*/m)].join("\n")
      + "\nenv.setCtx = (x) => { delCtx = { onCancel: x.onCancel, onOk: x.onOk, stay: x.stay }; }; env.closeCtx = () => { const c = delCtx; delCtx = null; if (c && c.onCancel && !c.acted) c.onCancel(); };"
      + "\nreturn { phSet, phAskMaybe, phAskDrop, err: () => PH_ERR, ph: () => PH, setPH: (x) => { PH = x; }, ok: () => delCtx && delCtx.onOk(), cancel: () => { const c = delCtx; delCtx = null; if (c && c.onCancel) c.onCancel(); }, open: () => env.setCtx({ onCancel: phCfDrop, stay: true }) }; }")(env);
    await steps(S, { boxes, release: () => gate && gate(), env });
    return { calls, boxes, closed, S, busy, tracked, hints, shown, nos, title, env, delBody };
  };
  const a = await run([], async (S) => { S.open(); await S.phSet(true); });
  ok("打開:relaySet 只帶布林(沒有碼、語言);留在框裡等、主鈕轉圈;200 收框、重讀手機清單", JSON.stringify(a.calls) === "[true]" && a.busy[0] === true && a.closed.length === 1 && a.env.reloads === 1 && a.S.err() === "");
  const e = await run([{ ok: false, code: "FAILED", state: { on: false } }], async (S) => { S.open(); await S.phSet(true); });
  ok("沒開成(設定裡的開啟框):收框、設定裡出 ph.err;不寫主畫面的 #cn-hint", e.closed.length === 1 && e.S.err() === "ph.err" && e.hints.length === 0 && !/setHint/.test(fnOf(app, "phSet")));
  const g2 = await run([{ ok: true, state: { on: true } }], async (S, x) => { S.open(); const p = S.phSet(true); await tick(); S.cancel(); x.release(); await p; }, { hold: true });
  ok("〔開啟〕等待中取消有效:回應丟掉,不出錯", g2.S.err() === "" && g2.closed.length === 0);
  const off = await run([{ ok: true, state: { on: false } }], async (S) => { await S.phSet(false); });
  ok("關:不經框、relaySet(false)", off.boxes.length === 0 && JSON.stringify(off.calls) === "[false]");
  // 9b
  const ASK = { id: "devA0000001:1730530000000", label: "iPhone 15", platform: "ios", at: new Date(2026, 10, 2, 14, 33).getTime(), late: false };
  const PHA = (ask, x) => Object.assign({ visible: true, signedIn: true, on: false, ask }, x || {});
  const OPENER = { id: "focused-before" };
  const b1 = await run([], async (S) => { S.phAskMaybe(); }, { PH: PHA(ASK), active: OPENER });
  const bx = b1.boxes[0];
  ok("9b 跳框:標題「{機型} 想連這台電腦」、內文 = 開啟框那三段、鈕〔不用〕〔打開〕、stay;跟主行程說跳過了、記 phone_ask_shown", !!bx && bx.title === 'ph.ask.title{"name":"iPhone 15"}' && bx.lead.textContent === "ph.cf.1" && JSON.stringify(bx.lines) === '["ph.cf.2","ph.cf.3"]'
    && bx.cancel === "ph.ask.no" && bx.ok === "ph.ask.ok" && bx.stay === true && !bx.focus && !bx.single && b1.shown.join() === ASK.id && b1.tracked.join() === "phone_ask_shown", bx);
  ok("9b 焦點預設〔不用〕:confirmBox 沒有 focus／single 時焦點給取消鈕", /else if \(single\) \$\("del-ok"\)\.focus\(\); else \$\("del-cancel"\)\.focus\(\);/.test(fnOf(app, "confirmBox")));
  ok("9b 關框後焦點還給跳框前那一個(opener = 當時的 activeElement)", bx.opener === OPENER);
  ok("9b 標題可換行(cf-wrap,只這個框;confirmBox 每次先拿掉)、沒有時間", b1.title.textContent === 'ph.ask.title{"name":"iPhone 15"}' && b1.title.classSet.has("cf-wrap")
    && /\$\("del-title"\)\.textContent = title; \$\("del-title"\)\.classList\.toggle\("cf-wrap", !!wrapTitle\);/.test(fnOf(app, "confirmBox")) && /#del-title\.cf-wrap \{ white-space: normal; \}/.test(css));
  const b2 = await run([], async (S) => { S.phAskMaybe(); }, { PH: PHA(Object.assign({}, ASK, { late: true, label: "", platform: "android" })) });
  ok("9b 配對時間距今久(late):標題後面帶配對時間 MM/DD HH:mm(整塊不折行);機型空的用 Android 手機", b2.boxes[0].title === 'ph.ask.title{"name":"ph.android"}' && b2.title.textContent.endsWith("11/02 14:33") && b2.title.children.some((c) => c.className === "cf-when"), b2.title.textContent);
  const b3 = await run([], async (S) => { S.phAskMaybe(); S.cancel(); }, { PH: PHA(ASK) });
  ok("9b〔不用〕／關掉框:記 phone_ask_no、打 answer no;不開開關", b3.tracked.join() === "phone_ask_shown,phone_ask_no" && b3.nos.join() === ASK.id && b3.calls.length === 0);
  const b4 = await run([], async (S) => { S.phAskMaybe(); await S.ok(); }, { PH: PHA(ASK), connHidden: true });
  ok("9b〔打開〕:走 relaySet(true)、成功才記 phone_ask_on、收框;不打 answer no", b4.tracked.join() === "phone_ask_shown,phone_ask_on" && JSON.stringify(b4.calls) === "[true]" && b4.closed.length === 1 && b4.nos.length === 0);
  const b5 = await run([{ ok: false, code: "FAILED", state: { on: false } }], async (S) => { S.phAskMaybe(); await S.ok(); }, { PH: PHA(ASK), connHidden: true });
  const errP = byId(b5.delBody, "ph-box-err");
  ok("9b〔打開〕沒開成:框留著、主鈕停轉、框內 ph.err(role=status、紅字 cf-block)、不寫 #cn-hint、不記成已回答", b5.closed.length === 0 && b5.busy.join() === "true,false" && !!errP && errP.textContent === "ph.err" && errP.getAttribute("role") === "status" && errP.classSet.has("cf-block")
    && b5.hints.length === 0 && b5.tracked.join() === "phone_ask_shown" && b5.nos.length === 0);
  const b5b = await run([{ ok: false, code: "FAILED", state: { on: false } }, { ok: true, state: { on: true } }], async (S) => { S.phAskMaybe(); await S.ok(); await S.ok(); }, { PH: PHA(ASK), connHidden: true });
  ok("9b 沒開成後〔打開〕可以再按:第二次成功才收框、記 phone_ask_on", JSON.stringify(b5b.calls) === "[true,true]" && b5b.closed.length === 1 && b5b.tracked.join() === "phone_ask_shown,phone_ask_on");
  const b5c = await run([{ ok: false, code: "FAILED", state: { on: false } }], async (S) => { S.phAskMaybe(); await S.ok(); S.cancel(); }, { PH: PHA(ASK), connHidden: true });
  ok("9b 沒開成後改按〔不用〕:照記 phone_ask_no、answer no", b5c.tracked.join() === "phone_ask_shown,phone_ask_no" && b5c.nos.join() === ASK.id);
  const b6 = await run([], async (S) => { S.phAskMaybe(); S.phAskMaybe(); }, { PH: PHA(ASK) });
  ok("9b 同一次只跳一次(主行程收掉之前又推來也不跳)", b6.boxes.length === 1);
  const no = async (ph, o) => (await run([], async (S) => { S.phAskMaybe(); }, Object.assign({ PH: ph }, o || {}))).boxes.length;
  ok("9b 不跳:開關已開、沒有 ask、總開關關、沒登入、確認框開著、別的框(.scrim)開著、視窗不在前面", (await no(PHA(ASK, { on: true }))) === 0 && (await no(PHA(null))) === 0 && (await no(PHA(ASK, { visible: false }))) === 0
    && (await no(PHA(ASK, { signedIn: false }))) === 0 && (await no(PHA(ASK), { delOpen: true })) === 0 && (await no(PHA(ASK), { otherOpen: true })) === 0 && (await no(PHA(ASK), { hiddenWin: true })) === 0);
  for (const [nm, st] of [["登出／換帳號", { signedIn: false, on: false, visible: true }], ["開關被打開", { signedIn: true, on: true, visible: true }], ["總開關關", { signedIn: true, on: false, visible: false }]]) {
    const d = await run([], async (S) => { S.phAskMaybe(); S.phAskDrop(st); }, { PH: PHA(ASK) });
    ok("9b 框開著時" + nm + ":收框,不算〔不用〕(不記 phone_ask_no、不打 answer no)", d.closed.length === 1 && d.nos.length === 0 && d.tracked.join() === "phone_ask_shown");
  }
  const keep = await run([], async (S) => { S.phAskMaybe(); S.phAskDrop({ signedIn: true, on: false, visible: true }); }, { PH: PHA(ASK) });
  ok("9b 狀態沒變:框留著", keep.closed.length === 0);
  ok("9b 接線:狀態推來(先看要不要收框)、啟動讀一次、視窗回到前面／取得焦點、確認框關掉後都試一次", /phRepaint\(\);\n  phAskDrop\(st\);\n  phAskMaybe\(\);\n  phNoticePaint\(\);\n\}\);/.test(app) && /phStateLoad\(\)\.then\(\(\) => \{ phAskMaybe\(\); phNoticePaint\(\); \}\);/.test(app)
    && /document\.addEventListener\("visibilitychange", phAskMaybe\);/.test(app) && /window\.addEventListener\("focus", phAskMaybe\);/.test(app) && /if \(typeof phAskMaybe === "function"\) setTimeout\(phAskMaybe, 0\);/.test(fnOf(app, "delClose")));
  ok("9b 埋點三個在白名單、≤16 字;驗證碼四個沒有送出點", ["phone_ask_shown", "phone_ask_on", "phone_ask_no"].every((n) => n.length <= 16 && fs.readFileSync(path.join(SHELL, "telemetry.js"), "utf8").includes('"' + n + '"'))
    && !/phone_vfy_|phone_reverify/.test(app));
  // ── 5. 開關開著、帳號下剛配對了手機:輸入框上方那一列(spec account-session-revoke §3.3、設計 account-security-mails §7.3)──
  const NOTE = { id: "devN0000001:1730530000000", label: "Pixel 9", platform: "android", at: 1730530000000, more: 0 };
  const nrun = async (ph, steps, o = {}) => {
    const box = el("div"), body = el("div"), ta = el("textarea"), shown = [], closed = [], opened = [], tracked = [];
    box.hidden = true; box.contains = (x) => !!x && (x === box || walk(box).includes(x)); box.children.push(body);
    const seen = new Set(); let writes = 0; const look = () => { if (!seen.has(body.children)) { seen.add(body.children); writes++; } };   // 寫一次字 = textContent 換掉一次 children 陣列
    box.offsetParent = o.detached ? null : {};   // 聊天欄所在的畫面沒顯示(連結畫面等)= null
    const store = o.store || {}, docN = Object.create(doc); docN.visibilityState = o.bg ? "hidden" : "visible"; docN.hasFocus = () => !o.blur;
    const env = { document: docN, t, LANG: "zh", trackFeature: (n) => tracked.push(n), requestAnimationFrame: (f) => f(), libExtIcon: () => mk("svg", "ic"),
      lsGet: (k) => (k in store ? store[k] : null), lsSet: (k, v) => { store[k] = v; }, paneSt: { chat: { get off() { return !!o.chatOff; } } },
      window: { blave: { relayNoticeShown: (id) => { shown.push(id); return Promise.resolve(true); }, relayNoticeClose: (id) => { closed.push(id); return Promise.resolve(true); }, openExternal: (u) => opened.push(u) } },
      $: (id) => ({ "ph-notice": box, "ph-notice-t": body, ta }[id] || null) };
    let S; try { S = new Function("env", "with (env) { var PH = " + JSON.stringify(ph) + ";\n"
      + [lineOf(app, /const phShown = [^\n]*;/), lineOf(app, /const phName = [^\n]*;/), lineOf(app, /const phWebUrl = [^\n]*;/), lineOf(app, /^let PH_NOTICE_KEY = [^\n]*/m), lineOf(app, /^const PH_NOTICE_SEEN_KEY = [^\n]*/m), fnOf(app, "phNoticeVisible"), fnOf(app, "phNoticeTrack"), fnOf(app, "phNoticePaint"), fnOf(app, "phNoticeClose")].join("\n")
      + "\nreturn { phNoticePaint, phNoticeTrack, setPH: (x) => { PH = x; }, setLang: (l) => { LANG = l; }, x: () => { " + lineOf(app, /\$\("ph-notice-x"\)\.addEventListener\("click", ([^\n]*)\);/).replace(/^\$\("ph-notice-x"\)\.addEventListener\("click", \(\) => \{ /, "").replace(/ \}\);$/, "") + " } }; }")(env); } catch (e) { ok("剛配對:畫面那幾支切不出來", false, String(e.message)); const no = () => {}; S = { phNoticePaint: no, phNoticeTrack: no, setPH: no, setLang: no, x: no }; }
    const paint = S.phNoticePaint; S.phNoticePaint = () => { paint(); look(); };
    await steps(S, { box, body, ta, o, docN });
    await tick();
    return { box, body, ta, shown, closed, opened, tracked, store, writes: () => writes };
  };
  const PHN = (n, x) => Object.assign({ visible: true, signedIn: true, on: true, notice: n }, x || {});
  const web = (r) => walk(r.body).find((x) => x.classSet.has("ph-web"));
  const n1 = await nrun(PHN(NOTE), async (S) => { S.phNoticePaint(); S.phNoticePaint(); });
  ok("剛配對:開著＋有 notice → 那一列出現,字 = ph.newPhone(帶機型)、句尾〔到網站撤銷〕(ph-web 那顆、讀屏名稱、外連圖示)", n1.box.hidden === false && (n1.body.children[0] || {}).text === 'ph.newPhone{"name":"Pixel 9","more":"0"}' && (n1.body.children[1] || {}).text === " "
    && !!web(n1) && web(n1).textContent === "ph.webRevoke" && web(n1).getAttribute("aria-label") === "ph.webRevoke.aria" && web(n1).classSet.has("btn-quiet") && web(n1).children.some((c) => c.classSet && c.classSet.has("ic")), n1.body.textContent);
  ok("剛配對:出現時跟主行程說一次(relayNoticeShown → prompt/seen)、看得到就記 phone_new_shown 一次;狀態再推來不重寫字(status 不重念)", n1.shown.join() === NOTE.id && n1.tracked.join() === "phone_new_shown" && n1.writes() === 1, [n1.shown, n1.tracked, n1.writes()]);
  const n2 = await nrun(PHN(NOTE), async (S) => { S.phNoticePaint(); }, { store: { ph_notice_counted: NOTE.id } });
  ok("剛配對:這一批記過了(重開 app)→ 不再記 phone_new_shown", n2.shown.length === 1 && n2.tracked.length === 0);
  for (const [nm, o] of [["視窗在背景", { bg: true }], ["視窗沒有焦點", { blur: true }], ["聊天欄收起", { chatOff: true }], ["聊天欄那個畫面沒顯示", { detached: true }]]) {
    const r = await nrun(PHN(NOTE), async (S, d) => { S.phNoticePaint(); await tick(); d.o.bg = d.o.blur = d.o.chatOff = d.o.detached = false; d.docN.visibilityState = "visible"; d.box.offsetParent = {}; }, o);
    const before = r.tracked.slice();
    ok("剛配對:" + nm + " → prompt/seen 照送、那一列留著,phone_new_shown 不記", r.shown.join() === NOTE.id && r.box.hidden === false && before.length === 0, [r.shown, before]);
  }
  {
    const r = await nrun(PHN(NOTE), async (S, d) => { S.phNoticePaint(); await tick(); d.o.chatOff = false; S.phNoticeTrack(); S.phNoticeTrack(); }, { chatOff: true });
    ok("剛配對:聊天欄收起時不記,之後展開(paneToggle → phNoticeTrack)才記一次", r.tracked.join() === "phone_new_shown" && r.store.ph_notice_counted === NOTE.id && /if \(key === "chat" && !off && typeof phNoticeTrack === "function"\) phNoticeTrack\(\);/.test(fnOf(app, "paneToggle"))
      && /document\.addEventListener\("visibilitychange", phNoticeTrack\);\nwindow\.addEventListener\("focus", phNoticeTrack\);/.test(app)); }
  const n3 = await nrun(PHN(Object.assign({}, NOTE, { more: 2, label: "" })), async (S) => { S.phNoticePaint(); });
  ok("剛配對:不只一支 → ph.newPhones(最新那支的名字 + 支數);機型空的用 Android 手機", (n3.body.children[0] || {}).text === 'ph.newPhones{"name":"ph.android","more":"2"}', n3.body.textContent);
  const n4 = await nrun(PHN(NOTE), async (S) => { S.phNoticePaint(); S.setLang("en"); S.phNoticePaint(); });
  ok("剛配對:換語言重寫字,不重記、不重打 shown", n4.writes() === 2 && n4.shown.length === 1 && n4.tracked.join() === "phone_new_shown");
  for (const [nm, ph] of [["開關關著", PHN(NOTE, { on: false })], ["沒有 notice", PHN(null)], ["總開關關", PHN(NOTE, { visible: false })], ["沒登入", PHN(NOTE, { signedIn: false })], ["讀不到狀態", null]]) {
    const r = await nrun(ph, async (S) => { S.phNoticePaint(); });
    ok("剛配對:" + nm + " → 不出、不打 shown", r.box.hidden === true && r.shown.length === 0);
  }
  const n5 = await nrun(PHN(NOTE), async (S, d) => { S.phNoticePaint(); S.setPH(PHN(null)); S.phNoticePaint(); });
  ok("剛配對:主行程收掉(關開關、登出、401)→ 那一列收掉", n5.box.hidden === true);
  const n6 = await nrun(PHN(NOTE), async (S, d) => { S.phNoticePaint(); await tick(); doc.activeElement = web({ body: d.body }); S.x(); });
  ok("剛配對 ✕:記 phone_new_close、跟主行程說關掉(relayNoticeClose)、當場收、焦點回輸入框", n6.tracked.join() === "phone_new_shown,phone_new_close" && n6.closed.join() === NOTE.id && n6.box.hidden === true && doc.activeElement === n6.ta, [n6.tracked, n6.closed, n6.box.hidden, doc.activeElement && doc.activeElement.tagName]);
  const n7 = await nrun(PHN(NOTE), async (S, d) => { S.phNoticePaint(); await tick(); const w = web({ body: d.body }); if (w) w.listeners.click(); });
  ok("剛配對〔到網站撤銷〕:記 phone_new_revoke(不是設定頁那顆的 phone_web_revoke)、開網站 設定 › 已配對的手機、這一列也收掉", n7.tracked.join() === "phone_new_shown,phone_new_revoke" && n7.opened.join() === "https://blave.org/landing/zh/setting?tab=phones&from=desktop" && n7.closed.join() === NOTE.id && n7.box.hidden === true, [n7.tracked, n7.opened, n7.closed, n7.box.hidden]);
  const n8 = await nrun(PHN(NOTE), async (S) => { S.phNoticePaint(); await tick(); S.x(); S.phNoticePaint(); S.setPH(PHN(Object.assign({}, NOTE, { id: "devN0000002:1730530001000" }))); S.phNoticePaint(); });
  ok("剛配對 ✕ 之後主行程又推來還帶舊那一批的狀態:不閃回;下一批照出", n8.box.hidden === false && n8.shown.join() === NOTE.id + ",devN0000002:1730530001000" && n8.closed.join() === NOTE.id);
  { const r = await nrun(PHN(NOTE), async (S, d) => { S.phNoticePaint(); await tick(); S.x(); S.phNoticePaint(); d.box.flashAfter = d.box.hidden; });
    ok("剛配對 ✕ 後同一批再推來:那一列維持收起", r.box.flashAfter === true); }
  ok("剛配對:〔到網站撤銷〕在這一列裡熱區上緣只到 −3(折行不蓋前一行),設定頁那顆不動;✕ 在 #ws-update 出現時上緣收到 −4;zh 句子 text-wrap: pretty",
    /\.ph-notice \.ph-web::before \{ inset: -3px -4px -12px; \}/.test(css) && /\.ph-web::before \{ inset: -15px -4px; \}/.test(css)
    && /\.ws-update:not\(\[hidden\]\) \+ \.ph-notice \.ph-notice-x::before \{ top: -4px; \}/.test(css) && /\.ph-notice \.fault-body:lang\(zh\) \{ text-wrap: pretty; \}/.test(css));
  const wrap = html.slice(html.indexOf('<div class="chat-input-wrap">'), html.indexOf('<div class="chat-input">'));
  ok("剛配對:位置在聊天欄輸入框上方、#ws-update 下一層自己一列;role=status、字不掛 data-i18n、✕ 讀屏名稱沿用 set.close、16 的 x 圖示",
    wrap.indexOf('id="ws-update"') >= 0 && wrap.indexOf('id="ph-notice"') > wrap.indexOf('id="ws-update"') && /<div class="ph-notice" id="ph-notice" role="status" hidden>\s*<span class="fault-mark" aria-hidden="true"><\/span>\s*<div class="fault-body" id="ph-notice-t"><\/div>\s*<button type="button" class="ph-notice-x" id="ph-notice-x" data-i18n-aria="set\.close"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"\/><\/svg><\/button>/.test(wrap));
  ok("剛配對:樣子跟回合失敗卡同一組(13px、ink-2、行高 1.6、紅記號、不加框);✕ 視覺 28 熱區 44、ink-3;離輸入框 8、離 #ws-update 4",
    /\.msg\.fault, \.ph-notice \{ display: flex; align-items: flex-start; gap: var\(--space-8\); font-size: 13px; line-height: 1\.6; color: var\(--ink-2\); \}/.test(css)
    && /\.ph-notice \{ margin: 0 0 var\(--space-8\); \}/.test(css) && /\.ws-update:not\(\[hidden\]\) \+ \.ph-notice \{ margin-top: var\(--space-4\); \}/.test(css)
    && /\.ph-notice-x \{[^}]*width: 28px; height: 28px;[^}]*color: var\(--ink-3\);/.test(css) && /\.ph-notice-x::before \{ content: ""; position: absolute; inset: -8px; \}/.test(css) && !/\.ph-notice[^{]*\{[^}]*(border:|background: var\(--color-red|color: var\(--color-red)/.test(css));
  ok("剛配對:字照設計 §7.3 逐字(zh / en;en 不分單複數)", po(0, "ph.newPhone") === "{name} 剛配對，現在能叫這台電腦做事。" && po(0, "ph.newPhones") === "{name} 和另外 {more} 支手機剛配對，現在能叫這台電腦做事。"
    && po(1, "ph.newPhone") === "{name} was just paired and can now control this computer." && po(1, "ph.newPhones") === "{name} and {more} more were just paired and can now control this computer." && po(0, "ph.revokeWeb") === null);
  ok("剛配對:接線(狀態推來、啟動、換語言都畫一次);埋點三個在白名單、接在 phone_web_revoke 後面", /phAskMaybe\(\);\n  phNoticePaint\(\);\n\}\);/.test(app) && /if \(typeof phNoticePaint === "function" && typeof PH !== "undefined"\) phNoticePaint\(\);/.test(fnOf(app, "applyStatic"))
    && fs.readFileSync(path.join(SHELL, "telemetry.js"), "utf8").includes('"phone_web_revoke",\n    // 0.1.43 開關開著') && ["phone_new_shown", "phone_new_close", "phone_new_revoke"].every((n) => n.length <= 16 && fs.readFileSync(path.join(SHELL, "telemetry.js"), "utf8").includes('"' + n + '"')));
  ok("#del-title .cf-when:mono、--ink-3、不折行", /#del-title \.cf-when \{ font-family: var\(--font-mono\);[^}]*color: var\(--ink-3\); white-space: nowrap; \}/.test(css));
  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
