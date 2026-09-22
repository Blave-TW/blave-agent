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

console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
