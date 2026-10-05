// 策略的刪除(兩個視角)、側欄 tooltip、沒有回測時那一句。跑法:node tests/check_shell_strat_delete.js
//   雲端:spec-desktop-cloud-strategy-row-delete-pullback(組合成員預檢、壓抑窗、結果三桶)
//   本機:main.js deleteStrategy 擋還在組合裡的(規則同機器端 _cmd_delete_strategy)
const fs = require("fs"), path = require("path"), os = require("os");
const R = path.join(__dirname, "..", "shell", "renderer");
const trSrc = fs.readFileSync(path.join(R, "trade.js"), "utf8"), appSrc = fs.readFileSync(path.join(R, "app.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"), html = fs.readFileSync(path.join(R, "index.html"), "utf8");
let red = 0; const ok = (n, c, why) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) { red++; if (why !== undefined) console.log("      ", why); } };
const pending = [];   // 非同步的段落:收尾前等它們跑完
const fnOf = (src, name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); const j = src.indexOf("\nfunction ", i + 1), k = src.indexOf("\nasync function ", i + 1), c = src.indexOf("\nconst ", i + 1);
  return src.slice(i, Math.min(...[j, k, c].map((x) => (x < 0 ? Infinity : x)))); };

// ── 雲端:組合成員(amounts / weights / exchanges 聯集,金額 0 也算;讀不到不預判)──
eval(fnOf(trSrc, "cdelInUse"));
ok("組合成員:三張表任一張有 key 就算(金額 0 也算)", cdelInUse({ amounts: { a: 0 } }, "a") === true && cdelInUse({ weights: { b: 0.5 } }, "b") === true && cdelInUse({ exchanges: { c: "binance" } }, "c") === true);
ok("組合成員:都沒有 = false;config 讀不到 = null(交給機器裁決)", cdelInUse({ amounts: { x: 1 } }, "a") === false && cdelInUse(null, "a") === null && cdelInUse({}, "a") === false);

// ── 雲端:壓抑窗(已刪、清單還沒跟上的不畫;60 秒或清單不再有它就放掉;結果不明那幾支到期回到原樣)──
{ eval(trSrc.match(/const CDEL_HOLD_MS = \d+;/)[0].replace("const", "var")); var CDEL = { gone: new Map(), busy: new Map(), ids: {} };
  eval(fnOf(trSrc, "cdelPrune"));
  CDEL.gone.set("a", 1000); CDEL.gone.set("b", 1000); CDEL.busy.set("c", { state: "unknown", at: 1000 }); CDEL.busy.set("d", { state: "sending", at: 1000 }); CDEL.ids.c = "R";
  cdelPrune(["a", "b", "c", "d"], 2000);
  ok("壓抑窗內、清單還有它:繼續壓抑", CDEL.gone.has("a") && CDEL.gone.has("b") && CDEL.busy.has("c"));
  cdelPrune(["b", "c", "d"], 3000);
  ok("清單不再有它:放掉壓抑(真的刪掉了)", !CDEL.gone.has("a") && CDEL.gone.has("b"));
  cdelPrune(["b", "c", "d"], 1000 + CDEL_HOLD_MS + 1);
  ok("過了壓抑窗:放掉;結果不明那一支回到原樣、request_id 換掉;送出中的不動", !CDEL.gone.has("b") && !CDEL.busy.has("c") && CDEL.ids.c === undefined && CDEL.busy.has("d")); }

// ── 雲端:送出與三桶(原文;行為由上面的純函式與 cloudcmd 的三桶保證)──
{ const run = fnOf(trSrc, "cdelRun");
  ok("request_id 以名字為單位:沒送到沿用同一顆、被拒換新的、結果不明留著", /S\.api\.tradeSend\("delete_strategy", \{ name \}, CDEL\.ids\[name\] \|\| null\)/.test(run)
    && /if \(k === "rejected"\) \{\s*delete CDEL\.ids\[name\];/.test(run) && /\/\/ 沒送到[^\n]*\n\s*if \(res && typeof res\.requestId === "string"\) CDEL\.ids\[name\] = res\.requestId;/.test(run));
  ok("機器回「還在組合裡」→ 重開擋下那一態;成功 → 壓抑 + 選中那支收掉", /\/remove it there first\/\.test\(err\)/.test(run) && /CDEL\.gone\.set\(name, Date\.now\(\)\)/.test(run) && /RPC\.name === name[^\n]*rpCloudSelect\(null\)/.test(run));
  const side = fnOf(trSrc, "envPaintSide");
  ok("列尾刪除鈕:機器在跑、不在回合中、名字合規、不在刪除中才畫;跟 HO 旗標無關", /const canDel = kind === "running" && !\(typeof running !== "undefined" && running === true\);/.test(side)
    && /if \(canDel && !deleting && \/\^\[A-Za-z0-9_-\]\{1,64\}\$\/\.test\(x\.name\)/.test(side) && !/hoDownBtn/.test(side));
  ok("刪除框帶雲端記號、開框前先預檢組合成員", /if \(cdelInUse\(cfg, x\.name\) === true\) return cdelBlocked\(x, opener\);/.test(fnOf(trSrc, "cdelAsk")) && /env: "cloud"/.test(fnOf(trSrc, "cdelAsk"))
    && /okDisabled: true/.test(fnOf(trSrc, "cdelBlocked")) && /trOpen\("pos"\)/.test(fnOf(trSrc, "cdelBlocked"))); }

// ── confirmBox 的 single(只有一顆鈕)──
ok("confirmBox single:藏取消、焦點給確認;關框時取消鈕還原", /\$\("del-cancel"\)\.hidden = !!single;/.test(appSrc) && /if \(single\) \$\("del-ok"\)\.focus\(\); else \$\("del-cancel"\)\.focus\(\);/.test(appSrc)
  && /\$\("del-cancel"\)\.hidden = false;/.test(fnOf(appSrc, "delClose")));

// ── 本機:還在組合裡的不給刪(規則同機器端)──
{ const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-del-")), WS = tmp;
  eval(fnOf(mainSrc, "inPortfolio"));
  ok("本機:沒有下單設定檔 = 從沒設過組合 → 不擋", inPortfolio("a") === false);
  fs.mkdirSync(path.join(WS, "manager"));
  const cfg = (o) => fs.writeFileSync(path.join(WS, "manager", "portfolio_config.json"), typeof o === "string" ? o : JSON.stringify(o));
  cfg({ amounts: { a: 0 }, weights: { w: 1 }, exchanges: { e: "binance" } });
  ok("本機:amounts / weights / exchanges 任一張有它(金額 0 也算)→ 在組合裡", inPortfolio("a") === true && inPortfolio("w") === true && inPortfolio("e") === true && inPortfolio("z") === false);
  ok("B2 本機:檔案裡的 STRATEGY_NAME 不等於資料夾名時,用它也比(組合的 key 是它)", inPortfolio(["foo", "a"]) === true && inPortfolio(["foo", null]) === false);
  { eval(fnOf(mainSrc, "stratMeta")); ok("B2 stratMeta 讀得出 STRATEGY_NAME;行尾帶註解也讀得到(runtime 用 ast 讀得到)", stratMeta('STRATEGY_NAME = "bar"\nDISPLAY_NAME = "x"').strategyName === "bar"
    && stratMeta('STRATEGY_NAME = "bar"  # 組合的 key').strategyName === "bar" && stratMeta("STRATEGY_NAME = 'b' # x\n").strategyName === "b"); }
  ok("B2 deleteStrategy 把 STRATEGY_NAME 一起交給組合檢查", /const inPf = inPortfolio\(\[name, sn\]\);/.test(fnOf(mainSrc, "deleteStrategy")));
  cfg("{ half-written");
  ok("本機:設定檔讀不懂(可能寫到一半)→ null(不能確定,不給刪)", inPortfolio("a") === null);
  fs.rmSync(tmp, { recursive: true, force: true });
  const del = fnOf(mainSrc, "deleteStrategy");
  ok("deleteStrategy:在組合裡回 IN_PORTFOLIO、讀不懂回 CONFIG_UNREADABLE,都在丟垃圾桶之前", del.indexOf('code: "IN_PORTFOLIO"') > 0 && del.indexOf('code: "CONFIG_UNREADABLE"') > 0 && del.indexOf("IN_PORTFOLIO") < del.indexOf("trashItem")); }

// ── 本機刪策略:沒刪成的每一條路都要講原因(Wei 10-01 按「移到垃圾桶？」完全沒反應:主行程回裸 false,畫面無從講起)──
{ const mainRun = (S) => new Function("S", "path", `let activeTurn = S.activeTurn, turnStarting = S.turnStarting;
    const stratNames = () => S.names, STRAT_DIR = () => "/ws/strategies", fs = { readFileSync: () => "" }, stratMeta = () => ({ strategyName: null });
    const inPortfolio = () => S.inPf, stratStopRerun = () => {}, shell = { trashItem: S.trash }, stratCache = new Map();
    async ${fnOf(mainSrc, "deleteStrategy")}\nreturn deleteStrategy("a");`)(S, path);
  const base = { activeTurn: null, turnStarting: false, names: ["a"], inPf: false, trash: async () => {} };
  const code = async (o) => { const r = await mainRun({ ...base, ...o }); return r === true ? true : r && r.code; };
  pending.push((async () => {
    const got = [await code({ activeTurn: {} }), await code({ turnStarting: true }), await code({ names: ["b"] }), await code({ trash: async () => { throw new Error("x"); } }),
      await code({ inPf: true }), await code({ inPf: null }), await code({})];
    ok("主行程:回合中 / 正要開始 / 資料夾不在 / 丟不進垃圾桶,各回一個 code(不是光一個 false)",
      got.join() === "TURN_RUNNING,TURN_RUNNING,NOT_FOUND,TRASH_FAILED,IN_PORTFOLIO,CONFIG_UNREADABLE,true", got);
  })().catch((e) => ok("主行程 deleteStrategy 跑得起來", false, e)));
  const delSrc = fnOf(mainSrc, "deleteStrategy"), codes = [...new Set([...delSrc.matchAll(/code: "([A-Z_]+)"/g)].map((m) => m[1]))];
  ok("主行程:除了成功的 true,沒有任何一條路回裸的 false / null", !/return (false|null|undefined)?;/.test(delSrc) && !/return false\b/.test(delSrc));

  // 畫面:真的跑 stratRefresh 畫列、按兩下列尾的鈕
  const strings = fs.readFileSync(path.join(R, "strings.js"), "utf8"), STR = new Function(strings + "\nreturn STRINGS;")();
  let focused = null;
  const mk = (tag) => { const n = { tag, className: "", hidden: false, disabled: false, dataset: {}, attrs: {}, kids: [], on: {}, textContent: "", innerHTML: "", title: "", type: "", parent: null, cls: new Set(),
    style: { p: {}, setProperty(k, v) { this.p[k] = v; }, removeProperty(k) { delete this.p[k]; } },
    classList: { add: (c) => n.cls.add(c), remove: (c) => n.cls.delete(c), contains: (c) => n.cls.has(c), toggle: () => {} },
    setAttribute(k, v) { n.attrs[k] = String(v); }, removeAttribute(k) { delete n.attrs[k]; }, getBoundingClientRect: () => ({ width: 90 }), focus() { focused = n; },
    get isConnected() { let x = n; while (x.parent) x = x.parent; return x === dom["strat-list"] || x.root === true; },
    addEventListener(ev, fn) { (n.on[ev] = n.on[ev] || []).push(fn); }, fire(ev) { return Promise.all((n.on[ev] || []).map((f) => f({}))); },
    append(...c) { c.forEach((x) => n.appendChild(x)); }, appendChild(c) { c.parent = n; n.kids.push(c); return c; }, remove() { if (n.parent) n.parent.kids = n.parent.kids.filter((x) => x !== n); n.parent = null; },
    querySelectorAll(sel) { const c = sel.replace(/^\./, ""), out = []; const walk = (x) => x.kids.forEach((k) => { if ((" " + k.className + " ").includes(" " + c + " ")) out.push(k); walk(k); }); walk(n); return out; } }; return n; };
  const dom = {}, $ = (id) => dom[id] || (dom[id] = Object.assign(mk("div"), { id, root: true }));
  const ETH = (name) => ({ name, displayName: "ETH 多空力道動能" });
  let items = ["a", "b", "c"].map(ETH), result = false, lists = 0, idSeen = null; const boxes = [];
  const scope = { $, document: { createElement: mk, createDocumentFragment: () => Object.assign(mk("#frag"), { frag: true }) }, t: (k, v) => { if (v && "id" in v) idSeen = v.id; return k; },
    RP: { list: [], name: null }, stratNameFill: (nm, x) => { nm.textContent = x; }, stratTip: (d) => d, sideReclick: () => {}, stratSelect: () => {},
    trOpen: () => {}, confirmBox: (o) => boxes.push(o),
    window: { blave: { platform: "darwin", listStrategies: async () => { lists++; return items.slice(); }, deleteStrategy: async () => result } } };
  const hasSync = /\nfunction stratDelSync\(/.test(appSrc), hasAt = /\nasync function stratRefreshAt\(/.test(appSrc);
  const api = new Function(...Object.keys(scope), ["var running = false;", fnOf(appSrc, "armedDelete"), fnOf(trSrc, "trEl"), fnOf(trSrc, "cdelBoth"), ...["stratDelBody", "stratBlockedNote"].filter((f) => appSrc.includes("\nfunction " + f + "(")).map((f) => fnOf(appSrc, f)),   // 舊版(修之前)沒有 stratDelBody:照樣跑完、逐條紅
    hasSync ? fnOf(appSrc, "stratDelSync") : "function stratDelSync() {}", hasAt ? "var stratRefreshAt = async " + fnOf(appSrc, "stratRefreshAt") : "",
    "var stratRefresh = async " + fnOf(appSrc, "stratRefresh").replace(/^async /, ""), "return { stratRefresh, stratDelSync, setRunning: (v) => { running = v; } };"].join("\n"))(...Object.values(scope));
  const wrapOf = (name) => $("strat-list").kids.find((w) => w.kids[0].dataset.name === name), delOf = (name) => wrapOf(name).kids[1], rowOf = (name) => wrapOf(name).kids[0];
  // 框的內文:一般字(lines)/ 紅字(.cf-block)/ 紅字之後的一般字(補救)
  const bodyOf = (b) => { if (b.length !== 1) return null; const o = b[0], ex = o.extra ? (o.extra.frag ? o.extra.kids : [o.extra]) : [];
    return (o.lines || []).map((x) => "lines:" + x).concat(ex.map((n) => (n.className === "cf-block" ? "red:" : "plain:") + n.textContent)).join("|"); };
  pending.push((async () => {
    await api.stratRefresh(false);
    const d0 = delOf("a"); api.setRunning(true); api.stratDelSync();
    const hidMid = d0.disabled === true;
    api.setRunning(false); api.stratDelSync();
    ok("回合開始:回合前畫好的列,刪除鈕跟著收起;結束後回來(以前只在重建列時看一次 running,回合中照樣按得到)", hasSync && hidMid && d0.disabled === false);
    api.setRunning(true); await api.stratRefresh(false); api.setRunning(false); api.stratDelSync();
    ok("回合結束那次重讀趕在 running 歸零前畫好列:歸零後鈕要回來", hasSync && delOf("a").disabled === false);
    const flips = appSrc.split("\n").filter((l) => /(^\s*|[;{]\s*)running = (true|false);/.test(l) && !/^let running/.test(l));
    ok("列舉:每一個改 running 的地方都同步刪除鈕(" + flips.length + " 處)", flips.length >= 3 && flips.every((l) => /stratDelSync\(\)/.test(l)), flips.filter((l) => !/stratDelSync\(\)/.test(l)).map((l) => l.trim().slice(0, 80)));
    const tryDel = async (r, name) => { result = r; boxes.length = 0; await api.stratRefresh(false); const d = delOf(name || "a"); await d.fire("click"); await d.fire("click"); return boxes; };
    const want = { TURN_RUNNING: "lines:strat.delBusy", NOT_FOUND: "lines:strat.delGone", TRASH_FAILED: "red:strat.delFailed|plain:strat.delFailedHint",
      IN_PORTFOLIO: "red:strat.delInPf", CONFIG_UNREADABLE: "red:strat.delCfgUnread" };
    const seen = {};
    for (const c of codes) seen[c] = bodyOf(await tryDel({ ok: false, code: c }));
    ok("列舉主行程的每一個 code:畫面都開框講對應的原因;回合中、資料夾不在用一般字,組合／設定紅字,垃圾桶不收 = 紅字事實 + 一般字補救", codes.length === 5 && codes.every((c) => seen[c] === want[c]), seen);
    const odd = [bodyOf(await tryDel(false)), bodyOf(await tryDel(null)), bodyOf(await tryDel(undefined)), bodyOf(await tryDel({ ok: false, code: "SOMETHING_NEW" }))];
    ok("裸 false / null(IPC 被擋)/ 沒見過的 code:一樣開框,講沒刪成", odd.every((x) => x === want.TRASH_FAILED), odd);
    scope.window.blave.platform = "win32"; idSeen = null; const w = bodyOf(await tryDel({ ok: false, code: "TRASH_FAILED" })); scope.window.blave.platform = "darwin";
    ok("Windows:兩段都用 .win;補救那句帶資料夾代號(同名的兩支分得出是哪個資料夾)", w === "red:strat.delFailed.win|plain:strat.delFailedHint.win" && idSeen === "a", w);
    const pf = await tryDel({ ok: false, code: "IN_PORTFOLIO" });
    ok("還在組合裡:多一顆「前往部位」;其他原因沒有", !!(pf[0] && pf[0].alt && pf[0].alt.label === "cdel.goPos") && !((await tryDel({ ok: false, code: "TURN_RUNNING" }))[0] || { alt: 1 }).alt);
    const busy = await tryDel({ ok: false, code: "TURN_RUNNING" }, "b");
    ok("其他原因:關框後焦點回到被按的那一列", !!busy[0] && busy[0].opener === rowOf("b"));
    // 焦點(設計稽核 0.1.12 §4-1):列被重建,要落在同位置那一列——原本下面那列;沒有就上一列;清單空了 = 新增鈕
    items = ["a", "b", "c"].map(ETH); await api.stratRefresh(false); result = true; boxes.length = 0; let l0 = lists;
    let d = delOf("b"); items = ["a", "c"].map(ETH); focused = null; await d.fire("click"); await d.fire("click");
    const okMid = boxes.length === 0 && lists > l0 && focused === rowOf("c") && focused.isConnected;
    d = delOf("c"); items = ["a"].map(ETH); focused = null; await d.fire("click"); await d.fire("click");
    const okLast = focused === rowOf("a");
    d = delOf("a"); items = []; focused = null; await d.fire("click"); await d.fire("click");
    ok("成功:不開框、重讀清單;焦點落在下面那列 → 最後一列刪掉落上一列 → 清單空了落新增鈕", okMid && okLast && focused === $("strat-add"));
    items = ["a", "b", "c"].map(ETH); await api.stratRefresh(false); result = { ok: false, code: "NOT_FOUND" }; boxes.length = 0; l0 = lists;
    d = delOf("b"); items = ["a", "c"].map(ETH); await d.fire("click"); await d.fire("click");
    ok("資料夾不在了:先重讀清單再開框;關框後焦點回到同位置那一列(不是已經被拆掉的那列)", lists > l0 && boxes.length === 1 && boxes[0].opener === rowOf("c") && boxes[0].opener.isConnected);
    d = delOf("c"); items = ["a"].map(ETH); boxes.length = 0; await d.fire("click"); await d.fire("click");
    const prev = boxes[0] && boxes[0].opener === rowOf("a");
    d = delOf("a"); items = []; boxes.length = 0; await d.fire("click"); await d.fire("click");
    ok("資料夾不在了:最後一列 → 上一列;清單空了 → 新增鈕", prev && boxes[0] && boxes[0].opener === $("strat-add"));
    { const css = fs.readFileSync(path.join(R, "app.css"), "utf8"), tcss = fs.readFileSync(path.join(R, "trade.css"), "utf8");
      ok("滑過列只在真的有 ✕ 時讓位(回合中 ✕ 收起不留 72px 空白,兩邊清單都是);條件包 :where,武裝那條仍蓋得過",
        /\n\.strat-wrap:is\(:hover, :has\(:focus-visible\)\) \.strat-row \{ background: var\(--surface-muted\); color: var\(--ink\); \}/.test(css)
        && /\n\.strat-wrap:is\(:hover, :has\(:focus-visible\)\):where\(:has\(\.cs-del:not\(:disabled\)\)\) \.strat-row \{ padding-right: 72px; \}/.test(css)
        && !/\n\.strat-wrap:is\(:hover, :has\(:focus-visible\)\) \.strat-row \{[^}]*padding-right/.test(css)
        && /#strat-list-cloud \.strat-wrap:is\(:hover, :has\(:focus-visible\)\):where\(:has\(\.cs-del:not\(:disabled\)\)\) \.strat-row \{ padding-right/.test(tcss)
        && !/#strat-list-cloud \.strat-wrap:is\(:hover, :has\(:focus-visible\)\) \.strat-row \{ padding-right/.test(tcss)); }
    const keys = ["strat.delBusy", "strat.delGone", "strat.delFailed", "strat.delFailed.win", "strat.delFailedHint", "strat.delFailedHint.win", "strat.delInPf", "strat.delCfgUnread"];
    ok("每一句兩語都有;補救那兩句帶 {id}", keys.every((k) => STR.zh[k] && STR.en[k]) && ["strat.delFailedHint", "strat.delFailedHint.win"].every((k) => STR.zh[k].includes("{id}") && STR.en[k].includes("{id}")),
      keys.filter((k) => !(STR.zh[k] && STR.en[k])));
  })().catch((e) => ok("畫面刪除流程跑得起來", false, e))); }

// ── 側欄 tooltip(兩邊側欄同一支)──
{ var t = (k, v) => (k === "side.rowTip" ? v.name + "（" + v.id + "）" : k);
  eval(fnOf(appSrc, "stratTip"));
  ok("tooltip = 顯示名稱（資料夾代號）;名稱空或等於代號時只放代號", stratTip("BTC 4 小時動能", "btc_4h") === "BTC 4 小時動能（btc_4h）" && stratTip("", "btc_4h") === "btc_4h" && stratTip("btc_4h", "btc_4h") === "btc_4h" && stratTip(null, "x") === "x");
  ok("兩邊側欄都用它", /nm\.title = stratTip\(x\.displayName, x\.name\);/.test(appSrc) && /stratTip\(x\.displayName, x\.name\)/.test(fnOf(trSrc, "envPaintSide"))); }

// ── 側欄名字截尾時留住「（2）」(e2e 0.1.8 #37:撞名另存的兩支截尾後長得一樣)──
{ eval(fnOf(appSrc, "stratNameParts"));
  const P = (s) => { const p = stratNameParts(s); return p.head + "|" + p.tail; };
  ok("尾端的（N）/ (N) 拆成後綴;前面的空白歸後綴", P("BTC SMA50/200 均線交叉（2）") === "BTC SMA50/200 均線交叉|（2）" && P("BTC SMA cross (12)") === "BTC SMA cross| (12)" && P("x(3)") === "x|(3)");
  ok("沒有後綴、後綴不在尾端、只有後綴、不是數字 → 不拆(一段字);沒有長度門檻", P("BTC SMA 均線交叉") === "BTC SMA 均線交叉|" && P("均線（2）交叉") === "均線（2）交叉|" && P("（2）") === "（2）|" && P("台積電（日線）") === "台積電（日線）|" && P(null) === "|" && P("") === "|"
    && P("x".repeat(40)) === "x".repeat(40) + "|" && P("策略一二三四五六七八九十一二三𠀋𠀌𠀍") === "策略一二三四五六七八九十一二三𠀋𠀌𠀍|");
  // 設計稽核 0.1.8 第四批 §1:只有結尾是完整的辨識記號才固定尾段(28 個例子 = 設計師的 audit-b4/rule.js,逐一列舉)
  const T = [
    ["BTC SMA50/200 均線交叉（2）", "（2）"], ["BTC SMA cross (12)", " (12)"],
    ["Supertrend 趨勢（SOL）v2", "v2"], ["Supertrend 趨勢（SOL）", ""],
    ["BTC SMA100/200 均線交叉 v3", " v3"], ["BTC SMA50/200 均線交叉", ""],
    ["BTC ETH SOL BNB 動能輪動", ""], ["台指期 PCR 未平倉籌碼偏多", ""], ["ETH 4小時 RSI 超賣反彈", ""],
    ["btc_funding_rate_mean_reversion_4h", "_4h"], ["btc_funding_rate_mean_reversion_4h_v2", "_4h_v2"],
    ["funding_rate_watch", ""], ["eth_ti_1h", "_1h"], ["btc_sma_test_2", "_2"], ["supertrend_sol_v2", "_v2"],
    ["Momentum rotation across BTC ETH SOL", ""], ["BTC 均線策略 SMA 50/200", ""], ["BTC SMA200", ""], ["ETH RSI14", ""],
    ["台股融資反轉 日線 v12", " v12"], ["BTC 資金費率均值回歸 4h v2", " 4h v2"], ["BTC 資金費率 15m", " 15m"],
    ["v2", ""], ["4h", ""], ["台積電均線", ""], ["BTC-PERP-1h", "-1h"], ["btc_100d_200d_v100", "_v100"], ["ETH 突破 2024", ""],
  ];
  const wrong = T.filter(([s, want]) => { const p = stratNameParts(s); return p.tail !== want || p.head + p.tail !== s; }).map(([s]) => s + " → " + stratNameParts(s).tail);
  ok("尾段只在結尾是完整記號時才有(28 例):（N）、v2、_4h、_4h_v2;數字黏在英文字後、4 位數、/ 不算;超過 8 字元只留最後一個記號", T.length === 28 && wrong.length === 0, wrong);
  ok("只差尾端記號的兩支,尾段不同;固定字數的常數拿掉了", stratNameParts("Supertrend 趨勢（SOL）v2").tail !== stratNameParts("Supertrend 趨勢（SOL）").tail
    && stratNameParts("btc_funding_rate_mean_reversion_4h").tail !== stratNameParts("btc_funding_rate_mean_reversion_4h_v2").tail && !/STRAT_NAME_MAX|STRAT_NAME_TAIL/.test(appSrc));
  const mk = (cls) => { const n = { className: cls || "", textContent: "", kids: [], classList: { toggle: (c, on) => { n.has = on; } }, append: (...k) => n.kids.push(...k) }; return n; };
  const document = { createElement: () => mk() };
  eval(fnOf(appSrc, "stratNameFill"));
  const a = mk("strat-name"), b = mk("strat-name");
  stratNameFill(a, "BTC SMA50/200 均線交叉（2）"); stratNameFill(b, "BTC SMA 均線交叉");
  ok("有後綴:前段 .sn-head + 後綴 .sn-tail 兩個節點;沒有:一段字、不加 class", a.has === true && a.kids.length === 2 && a.kids[0].className === "sn-head" && a.kids[0].textContent === "BTC SMA50/200 均線交叉" && a.kids[1].className === "sn-tail" && a.kids[1].textContent === "（2）"
    && b.has === false && b.kids.length === 0 && b.textContent === "BTC SMA 均線交叉");
  const css = fs.readFileSync(path.join(R, "app.css"), "utf8");
  ok("兩邊側欄都走 stratNameFill;CSS:前段截尾、後綴不縮", /stratNameFill\(nm, x\.displayName \|\| x\.name\)/.test(fnOf(appSrc, "stratRefresh")) && /stratNameFill\(nm, x\.displayName\)/.test(fnOf(trSrc, "envPaintSide"))
    && /\.strat-name\.has-tail \{ display: flex; align-items: center; \}/.test(css) && /\.strat-name \.run-dot \{ flex: none; \}/.test(css) && /\.strat-name \.sn-head \{[^}]*text-overflow: ellipsis/.test(css) && /\.strat-name \.sn-tail \{ flex: none;/.test(css)); }

// ── 刪策略的武裝字講去向(e2e 0.1.8 #73、設計稽核第四批 W5):刪策略是進垃圾桶、可復原 → 列內兩段式,但要講去哪裡 ──
{ const css = fs.readFileSync(path.join(R, "app.css"), "utf8"), strings = fs.readFileSync(path.join(R, "strings.js"), "utf8");
  const STR = new Function(strings + "\nreturn STRINGS;")();
  const mk = () => { const n = { cls: new Set(), style: { p: {}, setProperty(k, v) { this.p[k] = v; }, removeProperty(k) { delete this.p[k]; } }, on: {}, attrs: {}, textContent: "", innerHTML: "",
    classList: { add: (c) => n.cls.add(c), remove: (c) => n.cls.delete(c), contains: (c) => n.cls.has(c) }, setAttribute: (k, v) => { n.attrs[k] = v; }, addEventListener: (e, f) => { n.on[e] = f; }, getBoundingClientRect: () => ({ width: 83.2 }) }; return n; };
  const document = { createElement: () => mk() }, t = (k) => STR.zh[k];
  eval(fnOf(appSrc, "armedDelete"));
  let ran = 0; const row = mk(), del = armedDelete(row, "x", async () => { ran++; }, false, "strat.delConfirm");
  del.on.click();
  const armed = del.cls.has("is-armed") && del.textContent === "移到垃圾桶？" && row.style.p["--armed-w"] === "84px" && ran === 0;
  del.on.blur();
  const back = !del.cls.has("is-armed") && !("--armed-w" in row.style.p) && ran === 0;
  const plain = armedDelete(mk(), "x", async () => {}, false); plain.on.click();
  ok("武裝後的字 = 傳進來的 key(移到垃圾桶？),鈕的實寬寫在列上;失焦還原、沒有執行;沒給 key 照舊「刪除？」", armed && back && plain.textContent === "刪除？");
  ok("策略列傳 strat.delConfirm(Windows 傳 .win);對話列仍走確認框(刪對話救不回來)", /\}, false, window\.blave\.platform === "win32" \? "strat\.delConfirm\.win" : "strat\.delConfirm"\);/.test(fnOf(appSrc, "stratRefresh"))
    && /armedDelete\(row, t\("cs\.del"\), \(btn\) => delConfirm\(m, btn\), true\);/.test(appSrc));
  ok("兩語的字都講去向;列的右內距照鈕的實寬讓位", STR.zh["strat.delConfirm"] === "移到垃圾桶？" && STR.en["strat.delConfirm"] === "Move to Trash?" && STR.zh["strat.delConfirm.win"] === "移到資源回收筒？" && STR.en["strat.delConfirm.win"] === "Move to Recycle Bin?"
    && /\.strat-wrap:has\(\.cs-del\.is-armed\) \.strat-row \{ padding-right: calc\(var\(--armed-w, 84px\) \+ 16px\); \}/.test(css)); }

// ── 側欄順序:最近被人或 agent 動過的在上面,live tick 重寫 stats.json 不算(e2e 0.1.8 #30 #39 #54)──
{ const cut = mainSrc.slice(mainSrc.indexOf("const stratTouchedAt"), mainSrc.indexOf("function listStrategies()"));
  const { stratOrder } = new Function(cut + "\nreturn { stratOrder };")();
  const H = 3600e3, T0 = 1790530000000;
  // 實測那一組:btc_sma_test 01:40 回測、03:04 掃描,之後每小時 live tick 重寫 stats.json(04:00);其餘是之後才建的
  const live = { name: "btc_sma_test", codeMtime: T0, statsMtime: T0 + 3 * H, scanMtime: T0 + 1.4 * H, generatedAt: T0 / 1000 + 5 };
  const newer = { name: "tsmc_ma_cross", codeMtime: T0 + 2 * H, statsMtime: T0 + 2.1 * H, scanMtime: 0, generatedAt: (T0 + 2.1 * H) / 1000 };
  const mid = { name: "btc_sma_test_2", codeMtime: T0 + 1.8 * H, statsMtime: T0 + 1.8 * H, scanMtime: 0, generatedAt: (T0 + 1.8 * H) / 1000 };
  const names = (l) => l.slice().sort(stratOrder).map((x) => x.name).join();
  ok("上線中的那支被 live tick 重寫 stats.json:不會跳到第一", names([live, mid, newer]) === "tsmc_ma_cross,btc_sma_test_2,btc_sma_test");
  ok("再過一根 K(stats.json 更新):順序不變", names([{ ...live, statsMtime: T0 + 9 * H }, newer, mid]) === "tsmc_ma_cross,btc_sma_test_2,btc_sma_test");
  ok("真的動過(重跑回測 / 改碼 / 掃參數)才往上", names([{ ...live, generatedAt: (T0 + 5 * H) / 1000 }, newer, mid]).startsWith("btc_sma_test,") && names([{ ...live, scanMtime: T0 + 5 * H }, newer, mid]).startsWith("btc_sma_test,") && names([{ ...live, codeMtime: T0 + 5 * H }, newer, mid]).startsWith("btc_sma_test,"));
  ok("舊 stats 沒有 Generated At:退回檔案時間;沒有回測的看程式碼時間", names([{ name: "old", codeMtime: 1, statsMtime: T0 + 9 * H, scanMtime: 0, generatedAt: null }, newer]) === "old,tsmc_ma_cross" && names([{ name: "draft", codeMtime: T0 + 9 * H, statsMtime: 0, scanMtime: 0, generatedAt: null }, newer]) === "draft,tsmc_ma_cross");
  ok("同一時間:照資料夾名,輸入順序怎麼換結果都一樣", names([{ ...mid, name: "b" }, { ...mid, name: "a" }]) === "a,b" && names([{ ...mid, name: "a" }, { ...mid, name: "b" }]) === "a,b");
  ok("listStrategies 用它排", /\}\)\.sort\(stratOrder\);/.test(mainSrc) && !/sort\(\(a, b\) => b\.mtime - a\.mtime\)/.test(mainSrc)); }

// ── 沒有回測時,分頁列正下方那一句(兩個視角同一段)──
ok("rp.noBt:在 #rp-tabs 正下方、跟分頁 disabled 用同一個 has", /<\/div>\s*<!--[^>]*-->\s*<p class="rp-nobt" id="rp-nobt" data-i18n="rp\.noBt" hidden><\/p>\s*<div class="rp-panel" id="rp-bt"/.test(html)
  && /rpNobtPaint\(B, has\);/.test(fnOf(appSrc, "rpShowTab")) && /nb\.classList\.remove\("is-miss"\); nb\.hidden = has;/.test(fnOf(appSrc, "rpNobtPaint")));

// ── 側欄:再點一次選中的那支 = 取消選取、中欄回 welcome(Wei 09-23)。真的跑 stratRefresh 畫列、按列上的 click ──
(async () => {
  const mkEl = (tag) => { const n = { tag, className: "", hidden: false, dataset: {}, attrs: {}, kids: [], on: {}, _text: "", title: "", type: "", parent: null,
    get textContent() { return this._text + this.kids.map((k) => k.textContent).join(""); }, set textContent(v) { this._text = String(v); this.kids = []; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(ev, fn) { (this.on[ev] = this.on[ev] || []).push(fn); }, append(...c) { c.forEach((x) => this.appendChild(x)); },
    appendChild(c) { if (typeof c === "string") c = { tag: "#text", textContent: c, kids: [], className: "" }; if (c && typeof c === "object") { c.parent = this; this.kids.push(c); } return c; }, remove() { if (this.parent) this.parent.kids = this.parent.kids.filter((x) => x !== this); },
    get isConnected() { return !!this.parent && this.parent.kids.includes(this); },
    get classList() { const n = this, has = () => n.className.split(/\s+/).filter(Boolean); return { add: (c) => { if (!has().includes(c)) n.className = [...has(), c].join(" "); }, remove: (c) => { n.className = has().filter((x) => x !== c).join(" "); }, contains: (c) => has().includes(c) }; },
    focus() { doc.activeElement = this; }, click() { (this.on.click || []).forEach((f) => f({ currentTarget: this })); },
    querySelectorAll(sel) { const cls = sel.replace(/^\./, ""), out = []; const walk = (x) => x.kids.forEach((k) => { if ((" " + k.className + " ").includes(" " + cls + " ")) out.push(k); walk(k); }); walk(this); return out; } };
    return n; };
  const doc = { createElement: mkEl, activeElement: null, body: mkEl("body") };
  const dom = {}; const $ = (id) => dom[id] || (dom[id] = mkEl("div"));
  const RP = { list: [], name: null, data: null, tab: "bt", drawn: {} }, RPC = { name: null };
  const ENV = { cur: "local" }, TR_BAGS = { local: { open: false } };
  let running = false, loads = 0; const t = (k) => k;
  const window = { blave: { listStrategies: async () => [{ name: "a", displayName: "A", mtime: 1 }, { name: "b", displayName: "B", mtime: 2 }],
    loadStrategy: async (n) => { loads++; return { name: n, stats: null, code: "x" }; }, deleteStrategy: async () => true } };
  const armedDelete = () => mkEl("button"), stratTip = (d) => d, stratNameFill = (nm, x) => { nm.textContent = x; }, trLeave = () => {}, rpBag = () => RP, rpPaintHead = () => {}, rpShowTab = () => {}, rpTab = (B) => (B.data && B.data.stats ? B.tab : "code"), confirmBox = () => {};
  const document = doc;
  eval(fnOf(trSrc, "envShowMain").replace(/^function envShowMain/, "var envShowMain = function"));
  eval("var stratRefresh = async " + fnOf(appSrc, "stratRefresh").replace(/^async /, ""));
  eval("var stratSelect = async " + fnOf(appSrc, "stratSelect").replace(/^async /, ""));
  const envCanSwitch = () => true;   // 再點選中那支走 sideReclick(展開層 / 守門那幾態在 check_shell_side_reclick)
  eval(fnOf(trSrc, "sideReclick").replace(/^function sideReclick/, "var sideReclick = function"));
  ["rp", "main-empty", "tr"].forEach((id) => { $(id).hidden = id !== "main-empty"; });
  await stratRefresh(false);
  const rows = () => $("strat-list").querySelectorAll("strat-row"), rowA = () => rows().find((r) => r.dataset.name === "a");
  const tick = () => new Promise((r) => setImmediate(r));
  rowA().focus(); rowA().click(); await tick();
  ok("點一支:選中、中欄是報告、welcome 收起", RP.name === "a" && rowA().attrs["aria-current"] === "true" && $("rp").hidden === false && $("main-empty").hidden === true);
  const same = rowA(); rowA().click(); await tick();
  ok("再點一次同一支:取消選取、中欄回 welcome、列上的 aria-current 拿掉", RP.name === null && RP.data === null && $("main-empty").hidden === false && $("rp").hidden === true && !("aria-current" in rowA().attrs));
  ok("取消選取不重建列:焦點留在那一列(不掉到 BODY)", rowA() === same && doc.activeElement === same);
  rowA().click(); await tick();
  ok("取消之後再點:又選中(是切換,不是一次性)", RP.name === "a" && $("rp").hidden === false);
  rows().find((r) => r.dataset.name === "b").click(); await tick();
  ok("選中 a 時點 b:換成 b(不是取消)", RP.name === "b" && $("main-empty").hidden === true);
  ok("鍵盤:列是 <button>,Enter / Space 走同一個 click", /b\.type = "button"; b\.className = "strat-row";/.test(fnOf(appSrc, "stratRefresh")));
  // ── 雲端視角點一支策略(Wei 09-23):立刻換到那一頁、本體先放「載入中…」,不等雲端回來;讀不到 = 讀不到 +〔重新查看〕;
  //    連點兩支 = 最後一次點的算、晚到的那份不畫;點過的有快取 = 立刻畫、背景再抓。真的跑 rpCloudSelect + envShowMain ──
  { const dom2 = {}; const $2 = (id) => dom2[id] || (dom2[id] = mkEl("div"));
    ["rp", "tr", "main-empty"].forEach((id) => { $2(id).hidden = id !== "tr"; }); $2("cv-empty").hidden = true; $2("rp-wait").hidden = true;
    const pendingLoads = []; let said = [];
    const C = { alertSrc: null, alertText: "", st: { cloud: { strategies: [{ name: "a", display_name: "策略 A" }, { name: "b", display_name: "策略 B" }] } },
      api: { loadStrategy: (n) => new Promise((res) => pendingLoads.push({ n, res })) } };
    const scope = { $: $2, document: doc, t: (k) => k, ENV: { cur: "cloud", sig: {} }, TR_BAGS: { cloud: C, local: { open: false } }, RP: { name: null }, RPC: { name: null, data: null, tab: "bt", drawn: {} },
      trAlert: () => {}, srSay: (x) => said.push(x), hoPaint: () => {}, window: {} };
    const code = [fnOf(trSrc, "envShowMain"), fnOf(trSrc, "envCloudList"), appSrc.match(/^const rpBag = [^\n]*$/m)[0].replace(/^const /, "var "), fnOf(appSrc, "rpPaintHead"), appSrc.match(/^const RP_WAIT_DELAY_MS = [^\n]*$/m)[0].replace(/^const /, "var "), "var rpWaitShownAt = 0;", fnOf(appSrc, "rpWaitHold"), fnOf(appSrc, "rpBodyPaint"), fnOf(appSrc, "rpTab"), fnOf(appSrc, "rpShowTab"), fnOf(appSrc, "rpMissKey"), fnOf(appSrc, "rpNobtPaint"),
      appSrc.slice(appSrc.indexOf("const RPC_CACHE = new Map();"), appSrc.indexOf("async function rpCloudSelect(")).replace(/^const |^let /gm, "var "),
      "var rpCloudSelect = async " + fnOf(appSrc, "rpCloudSelect").replace(/^async /, ""),
      "var trPaint = () => envShowMain();"].join("\n");
    const run = new Function(...Object.keys(scope), code + "\nreturn { rpCloudSelect, RPC_CACHE: () => RPC_CACHE, shownAt: () => rpWaitShownAt };");
    const api = run(...Object.values(scope)), RPC = scope.RPC, tick = () => new Promise((r) => setImmediate(r));
    const waitLine = () => { const w = $2("rp-wait"); return w.hidden ? null : w.kids.map((k) => k.className + ":" + k.textContent).join("|"); };
    api.rpCloudSelect("a");
    ok("點下去當下(雲端還沒回來):中欄已經換成那一支的頁面、頁首是清單上的名字、本體是「載入中…」(不是停在自動下單頁)",
      $2("rp").hidden === false && $2("tr").hidden === true && $2("rp-name").textContent === "策略 A" && /^cx-wait:.*tr\.loading/.test(waitLine() || "") && $2("rp-tabs").hidden === true);
    pendingLoads.shift().res({ name: "a", displayName: "策略 A", description: "d", code: "print(1)", stats: null }); await tick();
    ok("資料回來:換成報告(等待那一行收起、分頁列回來)", RPC.data && RPC.data.code === "print(1)" && $2("rp-wait").hidden === true && $2("rp-tabs").hidden === false);
    // 連點:先點 b、還沒回來又點 a;b 晚到不准畫
    api.rpCloudSelect("b"); api.rpCloudSelect("a", true);
    const lb = pendingLoads.find((x) => x.n === "b"), la = pendingLoads.filter((x) => x.n === "a").pop();
    la.res({ name: "a", displayName: "策略 A", description: "d", code: "print(2)", stats: null }); await tick();
    lb.res({ name: "b", displayName: "策略 B", description: "", code: "B", stats: null }); await tick();
    ok("連點兩支:最後一次點的那支留在畫面上,晚到的那一份不畫", RPC.name === "a" && RPC.data.code === "print(2)" && $2("rp-name").textContent === "策略 A");
    pendingLoads.length = 0;
    // 同一支點了兩次(a → b → a):第一趟 a 比第三趟晚到,舊的那份也不准蓋掉新的(比的是第幾趟,不是名字)
    api.RPC_CACHE().clear(); api.rpCloudSelect("a", true); api.rpCloudSelect("b"); api.rpCloudSelect("a");
    const [a1, , a3] = pendingLoads.splice(0);
    a3.res({ name: "a", displayName: "策略 A", description: "", code: "new", stats: null }); await tick();
    a1.res({ name: "a", displayName: "策略 A", description: "", code: "old", stats: null }); await tick();
    ok("a → b → a:第一趟 a 晚到不蓋掉最後一趟", RPC.data.code === "new" && api.RPC_CACHE().get("a").code === "new");
    // 點過的(有快取):立刻畫快取、背景再抓;背景抓回新的就換
    api.rpCloudSelect("b"); pendingLoads.shift().res({ name: "b", displayName: "策略 B", description: "", code: "B1", stats: null }); await tick();
    api.rpCloudSelect("a");
    ok("點過的那支:當下就是快取那一份(不出「載入中」),背景還是去抓", RPC.data.code === "new" && $2("rp-wait").hidden === true && pendingLoads.length === 1);
    pendingLoads.shift().res({ name: "a", displayName: "策略 A", description: "d", code: "print(3)", stats: null }); await tick();
    ok("背景抓回新的:換成新的", RPC.data.code === "print(3)");
    api.rpCloudSelect("b"); pendingLoads.shift().res(null); await tick();
    ok("有快取時背景重抓失敗:手上那份照留,不變成讀不到", RPC.name === "b" && RPC.data.code === "B1" && $2("rp-wait").hidden === true);
    // 讀不到(沒有快取):讀不到 +〔重新查看〕;按下去重抓
    api.RPC_CACHE().clear(); said = [];
    api.rpCloudSelect("a"); pendingLoads.shift().res(null); await tick();
    const w = $2("rp-wait"), retry = w.kids.find((k) => k.id === "rp-retry");
    ok("讀不到:頁面留在那一支、本體講讀不到 +〔重新查看〕(不跳回自動下單頁);#rp-wait 是 role=status 自己會唸,不再另外 srSay(會唸兩遍)", $2("rp").hidden === false && RPC.name === "a" && /plan-err/.test(waitLine() || "")
      && /tr\.cloud\.reportUnreach/.test(waitLine()) && !!retry && !said.includes("tr.cloud.reportUnreach"));
    ok("設計稽核 005 第 7 條:〔重新查看〕是描邊鈕(資料 panel 的 Retry),在句子下一行(不是句子裡的文字鈕)",
      retry.className === "btn-out" && w.kids[0].className === "plan-err" && !w.kids[0].kids.some((k) => k.id === "rp-retry"));
    retry.click();
    ok("按〔重新查看〕:重抓一次、先回到「載入中…」", pendingLoads.length === 1 && /tr\.loading/.test(waitLine() || ""));
    pendingLoads.shift().res({ name: "a", displayName: "策略 A", description: "", code: "ok", stats: null }); await tick();
    ok("重抓成功:換成報告", RPC.data.code === "ok" && $2("rp-wait").hidden === true);
    // Loader 時機:200ms 內回來的不畫等待(不閃);畫了就撐滿 300ms 才換
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    api.RPC_CACHE().clear(); api.rpCloudSelect("a", true);
    const line0 = $2("rp-wait").kids[0];
    ok("等待那一行:剛點下去是藏著的(200ms 內不畫)", line0 && line0.hidden === true && api.shownAt() === 0);
    pendingLoads.shift().res({ name: "a", displayName: "策略 A", description: "", code: "fast", stats: null }); await tick();
    ok("…200ms 內就回來:直接換成報告,等待那一行從沒出現過", RPC.data.code === "fast" && line0.hidden === true);
    await sleep(260);
    ok("…之後那個計時器也不會把已經撤掉的那一行翻出來", line0.hidden === true && api.shownAt() === 0);
    api.RPC_CACHE().clear(); api.rpCloudSelect("b", true);
    const line1 = $2("rp-wait").kids[0]; await sleep(230);
    ok("過了 200ms 還沒回來:等待那一行出現", line1.hidden === false && api.shownAt() > 0);
    const t0 = Date.now(); pendingLoads.shift().res({ name: "b", displayName: "策略 B", description: "", code: "slow", stats: null }); await tick();
    ok("…出現後馬上就回來:先撐著,不立刻換(至少 300ms)", RPC.data.pending === "loading");
    await sleep(320);
    ok("…撐滿 300ms 之後換成報告", RPC.data.code === "slow" && Date.now() - t0 >= 250);
    { const h = new Function(fnOf(appSrc, "rpWaitHold") + appSrc.match(/^const RP_WAIT_DELAY_MS = [^\n]*$/m)[0] + "\nreturn rpWaitHold;")();
      ok("rpWaitHold:沒出現過 0;出現 100ms → 再等 200;出現超過 300ms → 0", h(0, 5000) === 0 && h(1000, 1100) === 200 && h(1000, 1400) === 0); }
    api.rpCloudSelect(null);
    ok("收掉選取:回雲端自動下單頁", $2("rp").hidden === true && $2("tr").hidden === false); }
  await Promise.all(pending);
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();

