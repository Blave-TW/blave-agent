// 分頁牆與頁面清單分得出「未讀」與「讀不了」(e2e 0.1.8 第七批 #2c;設計師規格 designer-spec-wall-unread)。
// Wei 實測:六格裡三格打勾、三格沒有任何標記,縮圖卻是全亮的——讀成「壞了」。缺的是一個名字:開了、載入正常、agent 沒讀 =「未讀」。
// 從 renderer/browser.js 原文切出來跑(假的 DOM 節點),不起 Electron、不開瀏覽器。
// 跑法:node tests/check_shell_browser_unread.js
const fs = require("fs"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const src = fs.readFileSync(path.join(SHELL, "renderer", "browser.js"), "utf8"), css = fs.readFileSync(path.join(SHELL, "renderer", "browser.css"), "utf8");
const STR = new Function(fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8") + "; return STRINGS;")();
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const fn = (name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0; for (let k = src.indexOf("{", src.indexOf(")", i)); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("切不出 " + name); };
const line = (head) => { const m = src.split("\n").find((l) => l.startsWith(head)); if (!m) throw new Error("找不到 " + head); return m; };
// 假節點:只記 class、字、子節點
const node = (tag, cls, text) => ({ tag, cls: cls || "", kids: text == null ? [] : [String(text)], append(...a) { this.kids.push(...a); }, setAttribute() {}, get childNodes() { return this.kids; } });
const flat = (n) => (typeof n === "string" ? n : n.cls === "segs" ? "" : n.kids.map(flat).join(""));
const t = (k) => STR.zh[k];
const PURE = [line("const brUserOp = "), line("const brBad = "), line("const brUnread = "), line("const brIsRead = "), fn("brPh"), fn("brRank"), fn("brStatusNode"), fn("brStat")].join("\n");
const make = (BR) => new Function("BR", "t", "brEl", "brIcon", "document", PURE + "\nreturn { brUnread, brBad, brPh, brRank, brStatusNode, brStat };")(BR, t, node, (n) => node("svg", "ic-" + n), { createDocumentFragment: () => node("frag") });
const R = make({ tabs: new Map() });

// ---- 判定
const open = { url: "https://a.test/", ph: "open", by: "agent" };
ok("未讀 = 開了、載入正常、agent 沒讀:載入好的頁、或回合結束時還在載入的頁", R.brUnread(open) && R.brUnread({ ph: "load", ended: true }) && R.brUnread({ ph: "queued", ended: true }) && !R.brUnread({ ph: "load" }) && !R.brUnread({ ph: "read" }));
ok("不算未讀:讀過的、搜尋結果頁、讀不了的(打不開 / 被擋 / 只停在轉址頁)、在等人的、用戶接手的、agent 拿來操作的", [{ readEver: true }, { search: true }, { fail: "timeout" }, { blocked: { kind: "domain" } }, { relay: true }, { need: { kind: "login" } }, { user: true, by: "agent" }, { used: true }]
  .every((o) => !R.brUnread(Object.assign({}, open, o))) && !R.brUnread(null));
ok("agent 開的分頁照舊:沒讀就是未讀,被用戶接手時是「你在操作」不是未讀", R.brUnread(open) && R.brUnread({ url: "https://a.test/", ph: "open" }) && !R.brUnread(Object.assign({}, open, { user: true })) && R.brPh(Object.assign({}, open, { user: true })) === "user");
ok("讀不了 = 打不開、被擋、只停在轉址頁;在等人的那一頁不算", R.brBad({ fail: "dns" }) && R.brBad({ blocked: {} }) && R.brBad({ relay: true }) && !R.brBad({ fail: "dns", need: { kind: "login" } }) && !R.brBad(open));

// ---- 一格上的樣子
ok("格子的狀態:brPh 多一個 unread(CSS 靠它);已讀、載入中、打不開照舊", R.brPh(open) === "unread" && R.brPh({ ph: "done", readEver: true }) === "done" && R.brPh({ ph: "load" }) === "load" && R.brPh({ ph: "open", fail: "dns" }) === "fail");
{ const n = R.brStatusNode(open), e = R.brStatusNode({ ph: "open", ended: true });
  ok("狀態位:未讀是兩個字(span.st-t),進行中與回合結束後都一樣;已讀照舊是勾", n.cls === "st-t" && flat(n) === "未讀" && e.cls === "st-t" && R.brStatusNode({ ph: "done", readEver: true }).cls === "ic-check" && R.brStatusNode({ ph: "open", fail: "dns", ended: true }).cls === "ic-warn", [n, e]); }
ok("讀屏:未讀的格念「網域 — 未讀 — 標題」", /el\.setAttribute\("aria-label", brReg\(brHost\(x\.url\)\) \+ " — " \+ \(brUnread\(x\) \? t\("br\.unread"\) \+ " — " : ""\) \+ brFoot\(x\)\);/.test(src));
ok("回合結束的格帶 data-ended(未讀格的縮圖靠它降到 45%)", /if \(x\.ended\) el\.dataset\.ended = ""; else delete el\.dataset\.ended;/.test(src)
  && css.includes('.pt[data-ph="unread"][data-ended] .pg { opacity: .45; }') && css.includes(".pt-st .st-t { font-size: 11px; line-height: 1; color: var(--ink-2); white-space: nowrap; }") && css.includes('.pt[data-ph="unread"] .pt-foot { color: var(--ink-2); }'));

// ---- 牆的標題
const block = (live, xs, sourceCount) => { const tabs = new Map(xs.map((x, i) => ["p" + i, x])); const r = make({ tabs }); return flat(r.brStat({ live, ids: [...tabs.keys()], sourceCount }, true)); };
const read = { ph: "done", readEver: true, ended: true }, un = { ph: "open", ended: true }, bad = { ph: "load", fail: "timeout", ended: true }, srp = { ph: "done", search: true, ended: true };
ok("回合結束後:三個數,不寫分數", block(false, [read, read, read, un, un, un, bad, srp]) === "讀了 3 頁未讀 3讀不了 1", block(false, [read, read, read, un, un, un, bad, srp]));
ok("是 0 的那一項不出:全部讀完只有「讀了 7 頁」;沒有讀不了就不寫", block(false, Array(7).fill(read)) === "讀了 7 頁" && block(false, [read, un]) === "讀了 1 頁未讀 1" && block(false, [bad, bad]) === "讀不了 2", [block(false, Array(7).fill(read)), block(false, [bad, bad])]);
ok("三個數加起來 = 格子數(搜尋結果頁不算)", (() => { const s = block(false, [read, read, un, bad, bad, srp]); return s === "讀了 2 頁未讀 1讀不了 2"; })());
ok("整輪只操作沒讀:寫「用了 N 頁」,後面照樣接「讀不了 n」,不出「未讀」", block(false, [{ ph: "act", used: true, ended: true }, { ph: "open", used: true, ended: true }, bad]) === "用了 2 頁讀不了 1", block(false, [{ ph: "act", used: true, ended: true }, { ph: "open", used: true, ended: true }, bad]));
ok("讀了幾頁以主行程的來源紀錄為準(同摘要列)", block(false, [read, un], 4) === "讀了 4 頁未讀 1");
ok("回合進行中照舊:已讀數/總數,不寫未讀數(那時候的未讀多半只是還沒輪到)", /3\/7 已讀$/.test(block(true, [read, read, read, { ph: "open" }, { ph: "open" }, { ph: "load" }, { ph: "load", fail: "dns" }])) && !/未讀/.test(block(true, [read, { ph: "open" }])));

// e2e #186:送進 TradingView 貼好之後,標題列寫「未讀　ETHUSDT.P 2,641.44 …」——那一頁是用戶自己開的,agent 本來就碰不到
{ const mine = [{ by: "user" }, { by: "user", user: true }, { by: "user", ended: true }, { by: "user", ph: "load", ended: true }].map((o) => Object.assign({}, open, o, { title: "ETHUSDT.P 2,641.44" }));
  ok("用戶自己開的分頁(by: user):進行中、回合結束後、他正在操作,都不是未讀", mine.every((x) => !R.brUnread(x)), mine.map(R.brUnread));
  ok("…三處同一個判定:格子的 data-ph 不是 unread(縮圖不降、訊息槽照一般)、狀態位沒有「未讀」兩個字、排序不往後", mine.every((x) => R.brPh(x) !== "unread" && R.brPh(x) !== "user" && R.brStatusNode(x) === null && R.brRank(x, true) === 0),
    mine.map((x) => [R.brPh(x), R.brStatusNode(x), R.brRank(x, true)]));
  ok("…牆的標題不把它算進「未讀 n」", block(false, [read, un, mine[2]]) === "讀了 1 頁未讀 1", block(false, [read, un, mine[2]]));
  // 單頁狀態句與讀屏:原文裡這兩處都問 brUnread,所以跟著對
  const foot = new Function("t", "brReg", "brHost", "Date", line("const brUserOp = ") + "\n" + fn("brFoot") + "\nreturn brFoot;")(t, (h) => h, () => "tradingview.com", Date);
  ok("…單頁狀態句 = 頁面標題(open-ext 規格 B 節),讀屏不念「未讀」", mine.every((x) => foot(x) === "ETHUSDT.P 2,641.44")
    && /if \(x && x\.ended && brUnread\(x\)\) \{/.test(fn("brStatLine")) && /if \(x\) \{ const n = brStatusNode\(x\); if \(n\) host\.append\(n\);/.test(fn("brStatLine")) && /\(brUnread\(x\) \? t\("br\.unread"\) \+ " — " : ""\)/.test(src), mine.map(foot)); }

// ---- 順序
ok("順序:回合結束後 已讀(0) → 未讀(1) → 讀不了(2);進行中未讀不往後排(格子不能在用戶眼前跳)", R.brRank(read, true) === 0 && R.brRank(un, true) === 1 && R.brRank(bad, true) === 2 && R.brRank({ ph: "open" }, false) === 0 && R.brRank({ fail: "dns" }, false) === 2);
ok("聊天清單:細線與小標「讀不了」;回合結束後的摘要列也排(brPaintHead 的 sum 那一支);中欄分頁牆同一套順序、不補細線", /sep = brEl\("div", "bsep", t\("br\.cantRead"\)\);/.test(fn("brOrder")) && /if \(b\.sum\) \{ brPaintSum\(b\); brOrder\(b\); return; \}/.test(src)
  && (src.match(/brWallOrder\(exp\.block, wall\);/g) || []).length === 2 && !/bsep/.test(fn("brWallOrder")));

// ---- 單頁狀態句、重開 app
ok("單頁、回合結束、未讀:狀態句講完整的一句,前面不放狀態節點(不然「未讀」講兩次)", /if \(x && x\.ended && brUnread\(x\)\) \{ host\.append\(brEl\("span", "t", t\("br\.unread\.stat"\)\)\); return; \}\n  if \(x\) \{ const n = brStatusNode\(x\);/.test(src));
ok("重開 app 畫回舊對話:每一格都是回合結束的(ended),沒讀也沒壞的就是未讀;整輪沒有讀任何一頁的(用了 N 頁)不標", /x\.ended = true; x\.used = !anyRead;/.test(fn("brRestore")) && /const anyRead = r\.tabs\.some\(\(tb\) => tb && tb\.status === "done" && !tb\.search\)/.test(fn("brRestore")));
ok("agent 點過、打過字、按過鍵的頁記成「拿來操作的」", /if \(\["click", "type", "press"\]\.includes\(x\.act\.kind\)\) x\.used = true;/.test(src));

// ---- 字串
ok("字串:新增「未讀」與單頁那一句;失敗組的小標改名 br.cantRead「讀不了」,舊 key 兩語都拿掉、程式不再引用", STR.zh["br.unread"] === "未讀" && STR.en["br.unread"] === "Unread" && STR.zh["br.unread.stat"] === "載入正常，agent 沒讀這一頁" && STR.en["br.unread.stat"] === "Loaded fine. The agent didn’t read this page"
  && STR.zh["br.cantRead"] === "讀不了" && STR.en["br.cantRead"] === "Couldn’t read" && !("br.notRead" in STR.zh) && !("br.notRead" in STR.en) && !/br\.notRead/.test(src));
console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
