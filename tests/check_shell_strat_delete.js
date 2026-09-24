// 策略的刪除(兩個視角)、側欄 tooltip、沒有回測時那一句。跑法:node tests/check_shell_strat_delete.js
//   雲端:spec-desktop-cloud-strategy-row-delete-pullback(組合成員預檢、壓抑窗、結果三桶)
//   本機:main.js deleteStrategy 擋還在組合裡的(規則同機器端 _cmd_delete_strategy)
const fs = require("fs"), path = require("path"), os = require("os");
const R = path.join(__dirname, "..", "shell", "renderer");
const trSrc = fs.readFileSync(path.join(R, "trade.js"), "utf8"), appSrc = fs.readFileSync(path.join(R, "app.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"), html = fs.readFileSync(path.join(R, "index.html"), "utf8");
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };
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
  ok("deleteStrategy:回合進行中或正要開始都不刪", /if \(activeTurn \|\| turnStarting \|\| !stratNames\(\)\.includes\(name\)\) return false;/.test(del));
  ok("deleteStrategy:在組合裡回 IN_PORTFOLIO、讀不懂回 CONFIG_UNREADABLE,都在丟垃圾桶之前", del.indexOf('code: "IN_PORTFOLIO"') > 0 && del.indexOf('code: "CONFIG_UNREADABLE"') > 0 && del.indexOf("IN_PORTFOLIO") < del.indexOf("trashItem"));
  ok("畫面:擋下時開單鈕框講原因(先到自動下單頁移出),不是靜靜沒反應", /r\.code === "IN_PORTFOLIO" \|\| r\.code === "CONFIG_UNREADABLE"/.test(appSrc) && /single: true/.test(appSrc) && /t\("strat\.delInPf"\)/.test(appSrc)); }

// ── 側欄 tooltip(兩邊側欄同一支)──
{ var t = (k, v) => (k === "side.rowTip" ? v.name + "（" + v.id + "）" : k);
  eval(fnOf(appSrc, "stratTip"));
  ok("tooltip = 顯示名稱（資料夾代號）;名稱空或等於代號時只放代號", stratTip("BTC 4 小時動能", "btc_4h") === "BTC 4 小時動能（btc_4h）" && stratTip("", "btc_4h") === "btc_4h" && stratTip("btc_4h", "btc_4h") === "btc_4h" && stratTip(null, "x") === "x");
  ok("兩邊側欄都用它", /nm\.title = stratTip\(x\.displayName, x\.name\);/.test(appSrc) && /stratTip\(x\.displayName, x\.name\)/.test(fnOf(trSrc, "envPaintSide"))); }

// ── 沒有回測時,分頁列正下方那一句(兩個視角同一段)──
ok("rp.noBt:在 #rp-tabs 正下方、跟分頁 disabled 用同一個 has", /<\/div>\s*<!--[^>]*-->\s*<p class="rp-nobt" id="rp-nobt" data-i18n="rp\.noBt" hidden><\/p>\s*<div class="rp-panel" id="rp-bt"/.test(html)
  && /\$\("rp-nobt"\)\.hidden = has;/.test(fnOf(appSrc, "rpShowTab")));

// ── 側欄:再點一次選中的那支 = 取消選取、中欄回 welcome(Wei 09-23)。真的跑 stratRefresh 畫列、按列上的 click ──
(async () => {
  const mkEl = (tag) => { const n = { tag, className: "", hidden: false, dataset: {}, attrs: {}, kids: [], on: {}, _text: "", title: "", type: "", parent: null,
    get textContent() { return this._text + this.kids.map((k) => k.textContent).join(""); }, set textContent(v) { this._text = String(v); this.kids = []; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(ev, fn) { (this.on[ev] = this.on[ev] || []).push(fn); }, append(...c) { c.forEach((x) => this.appendChild(x)); },
    appendChild(c) { if (typeof c === "string") c = { tag: "#text", textContent: c, kids: [], className: "" }; if (c && typeof c === "object") { c.parent = this; this.kids.push(c); } return c; }, remove() { if (this.parent) this.parent.kids = this.parent.kids.filter((x) => x !== this); },
    get isConnected() { return !!this.parent && this.parent.kids.includes(this); },
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
  const armedDelete = () => mkEl("button"), stratTip = (d) => d, trLeave = () => {}, rpBag = () => RP, rpPaintHead = () => {}, rpShowTab = () => {}, confirmBox = () => {}, stratBlockedNote = () => mkEl("p");
  const document = doc;
  eval(fnOf(trSrc, "envShowMain").replace(/^function envShowMain/, "var envShowMain = function"));
  eval("var stratRefresh = async " + fnOf(appSrc, "stratRefresh").replace(/^async /, ""));
  eval("var stratSelect = async " + fnOf(appSrc, "stratSelect").replace(/^async /, ""));
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
    const code = [fnOf(trSrc, "envShowMain"), fnOf(trSrc, "envCloudList"), appSrc.match(/^const rpBag = [^\n]*$/m)[0].replace(/^const /, "var "), fnOf(appSrc, "rpPaintHead"), appSrc.match(/^const RP_WAIT_DELAY_MS = [^\n]*$/m)[0].replace(/^const /, "var "), "var rpWaitShownAt = 0;", fnOf(appSrc, "rpWaitHold"), fnOf(appSrc, "rpBodyPaint"), fnOf(appSrc, "rpShowTab"),
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
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();

