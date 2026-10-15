// 策略頁「策略邏輯」:main.js stratLogic 跑 fixtures/strategy_logic.json(runtime 那份 check_strategy_logic.py 跑同一份,答案要一樣),
// 加上畫面三件事:沒有邏輯不畫那顆字、看舊版時收起、展開記在 localStorage。跑法:node tests/check_shell_strat_logic.js
const fs = require("fs"), path = require("path"), assert = require("assert");
const SH = path.join(__dirname, "..", "shell"), R = path.join(SH, "renderer");
const mainSrc = fs.readFileSync(path.join(SH, "main.js"), "utf8"), appSrc = fs.readFileSync(path.join(R, "app.js"), "utf8");
const html = fs.readFileSync(path.join(R, "index.html"), "utf8");
let red = 0; const ok = (n, c, why) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) { red++; if (why !== undefined) console.log("      ", why); } };
const fnOf = (src, name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); const j = src.indexOf("\nfunction ", i + 1), k = src.indexOf("\nasync function ", i + 1), c = src.indexOf("\nconst ", i + 1);
  return src.slice(i, Math.min(...[j, k, c].map((x) => (x < 0 ? Infinity : x)))); };
const same = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch (_) { return false; } };

// ── 解析器:同一份 fixture ──
eval(fnOf(mainSrc, "stratLogic"));
const { cases } = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "strategy_logic.json"), "utf8"));
for (const c of cases) { let got; try { got = stratLogic(c.src); } catch (e) { got = e; } ok("fixture:" + c.case, same(got, c.expect), JSON.stringify(got)); }
ok("stratMeta 把 logic 一起帶出去(本機 loadStrategy 的 ...stratMeta(code))", /logic: stratLogic\(code\)/.test(fnOf(mainSrc, "stratMeta")));

// ── 雲端那份:interpretStrategy 只留報告要畫的欄位,logic 要在裡面、形狀不對當沒有 ──
{ const I = require(path.join(SH, "cloud.js")).interpretStrategy;
  const pick = (logic) => I({ status: 200, body: { strategy: { name: "a", logic } } }, "a").strategy.logic;
  ok("雲端:結構化 / text 原樣帶過來", same(pick({ entry: ["x"], exit: [], stop: [] }), { entry: ["x"], exit: [], stop: [] }) && same(pick({ text: "t" }), { text: "t" }));
  ok("雲端:舊快取沒有 logic、null、形狀不對 → null", pick(undefined) === null && pick(null) === null && pick("x") === null && pick([1]) === null && pick({ entry: "x" }) === null && pick({ text: 3 }) === null);
  ok("雲端:陣列裡不是字串的元素丟掉;缺的組補 []", same(pick({ entry: ["a", 1, null], stop: ["s"] }), { entry: ["a"], exit: [], stop: ["s"] }));
  ok("雲端:interpretStrategy 的 strategy 整個交給雲端那一袋(trade.js loadStrategy 不再挑欄位,logic 才到得了 rpPaintLogic)",
    /loadStrategy: async \(name\) => \{ const r = await host\.cloudStrategy\(name\); return r && r\.code === "OK" && r\.strategy \? r\.strategy : null; \}/.test(fs.readFileSync(path.join(R, "trade.js"), "utf8"))); }

// ── 畫面 ──
ok("index.html:說明行尾的觸發器是 disclosure(aria-expanded + aria-controls),展開區在 .rp-sub 下面",
  /<button class="lg-tog" id="rp-logic-tog" type="button" aria-expanded="false" aria-controls="rp-logic"[^>]*hidden>/.test(html)
  && html.indexOf('id="rp-logic"') > html.indexOf('id="rp-logic-tog"') && html.indexOf('id="rp-logic"') < html.indexOf('id="rp-ho-note"'));
const paint = fnOf(appSrc, "rpPaintLogic");
ok("rpPaintLogic:只用 textContent 畫(不吃 HTML)", !/innerHTML/.test(paint) && /textContent/.test(paint));
ok("rpPaintLogic:沒有邏輯或看舊版(#rp-desc 收起)時那顆字與展開區都收", /\$\("rp-desc"\)\.hidden/.test(paint) && /tog\.hidden = !show/.test(paint));
ok("展開狀態全站一個、存 localStorage(lsGet / lsSet 包了 try/catch)", /lsGet\(RP_LOGIC_KEY\) === "1"/.test(paint) && /lsSet\(RP_LOGIC_KEY, open \? "1" : "0"\)/.test(appSrc)
  && /function lsGet\(k\) \{ try \{ return localStorage\.getItem\(k\)/.test(appSrc) && /function lsSet\(k, v\) \{ try \{ localStorage\.setItem/.test(appSrc));
ok("看舊版時跟著說明收:versions.js 收 #rp-desc 之後重畫一次;頁首重畫時排在 verPaint 之後", /\$\("rp-desc"\)\.hidden = old;\n\s*if \(typeof rpPaintLogic === "function"\) rpPaintLogic\(\);/.test(fs.readFileSync(path.join(R, "versions.js"), "utf8"))
  && fnOf(appSrc, "rpPaintHead").indexOf("rpPaintLogic()") > fnOf(appSrc, "rpPaintHead").indexOf("verPaint(B)"));
ok("展開時拿掉 #rp-desc 的 title(說明改完整換行)", /\$\("rp-desc"\)\.title = open \? "" :/.test(paint));
ok("埋點:點開時記 strategy_logic(收起不記)", /if \(open\) trackFeature\("strategy_logic"\)/.test(appSrc));

if (red) { console.log(`\n${red} 項 FAIL`); process.exit(1); }
console.log("\n全部通過");
