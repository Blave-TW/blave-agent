// 側欄旗標與拖拉排序(shell/renderer/stratflags.js + main.js 的 strat-prefs / strat-prefs-set;spec desktop-strat-flags-2026-10 §7)。不起 Electron。
//   ① 主行程清洗(從原文切出來、用真的 fs 在暫存 userData 跑):壞形狀回空、超長截掉、非法鍵丟掉、去重保序、旗標值 1–6 收其餘丟;
//      set 只動有帶的鍵、不碰 pdfDir、原子寫(沒留暫存檔)、壞 patch 不寫
//   ② 套序(renderer 純函式):order 內的先、缺的 append、長度對不上維持原序、沒拖過 = 原序
//   ③ 旗標畫面只畫 1–3(存檔收 1–6)
//   ④ 接線(原文):武裝時旗標鈕收起、雲端 tab 同一套旗標鈕 / 拖拉(寫回的行為在 check_shell_cloud_strat_prefs.js)、preload / main 兩支 IPC 只收自家頁面、
//      stratRefresh 先等 sfBeforeRebuild 再套序、刪除成功清偏好、兩個埋點是字面、字串表兩語都齊、tokens 三色、index.html 載入順序
// 跑法:node tests/check_shell_strat_prefs.js
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 600))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const mainSrc = read(path.join(SHELL, "main.js")), sfSrc = read(path.join(R, "stratflags.js")), appSrc = read(path.join(R, "app.js")), trSrc = read(path.join(R, "trade.js"));
const pre = read(path.join(SHELL, "preload.js")), css = read(path.join(R, "app.css")), html = read(path.join(R, "index.html")), tokens = read(path.join(R, "tokens.css"));
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
const line = (s, re) => { const m = re.exec(s); if (!m) throw new Error("no line " + re); return m[0]; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "blave-sp-"));
(async () => {
try {
  // ── ① 主行程 ──
  const ctx = { fs, path, app: { getPath: () => TMP }, console };
  vm.runInNewContext([line(mainSrc, /^const LIB_NAME_RE = .*$/m), line(mainSrc, /^const STRAT_PREFS_MAX = .*$/m), line(mainSrc, /^const uiPrefsPath = .*$/m),
    cutFn(mainSrc, "uiPrefsPatch"), cutFn(mainSrc, "stratPrefsClean"), cutFn(mainSrc, "stratPrefsGet"), cutFn(mainSrc, "stratPrefsSet")].join("\n") + "\nthis.get = stratPrefsGet; this.set = stratPrefsSet; this.clean = stratPrefsClean;", ctx);
  const file = () => JSON.parse(read(path.join(TMP, "ui-prefs.json")));
  ok("① 沒有檔:回空的、不炸", JSON.stringify(ctx.get()) === '{"stratOrder":[],"stratFlags":{}}');
  fs.writeFileSync(path.join(TMP, "ui-prefs.json"), "{broken");
  ok("① 檔壞掉:回空的、不炸", JSON.stringify(ctx.get()) === '{"stratOrder":[],"stratFlags":{}}');
  fs.writeFileSync(path.join(TMP, "ui-prefs.json"), JSON.stringify({ pdfDir: "/x/y" }));
  let r = ctx.set({ stratOrder: ["b", "a", "b", 7, ".hidden", "a/b", "", "c"], stratFlags: { a: 2, b: 6, c: 7, d: 0, e: 1.5, f: "1", g: true, ".h": 1, h: 3 } });
  ok("① set 清洗:order 去重保序、丟非字串 / 以 . 開頭 / 含分隔 / 空字串;flags 收 1–6 的整數、丟 7 / 0 / 小數 / 字串 / 布林 / 非法鍵",
    JSON.stringify(r) === '{"stratOrder":["b","a","c"],"stratFlags":{"a":2,"b":6,"h":3}}', JSON.stringify(r));
  ok("① 寫回同一個 ui-prefs.json、pdfDir 不動、沒留暫存檔", file().pdfDir === "/x/y" && file().stratOrder.join() === "b,a,c" && !fs.existsSync(path.join(TMP, "ui-prefs.json.blave-tmp")));
  r = ctx.set({ stratFlags: { a: 1 } });
  ok("① 只帶 flags:order 不動、flags 整份換", r.stratOrder.join() === "b,a,c" && JSON.stringify(r.stratFlags) === '{"a":1}');
  r = ctx.set({ stratOrder: [] });
  ok("① 空陣列合法 = 清掉自訂順序", r.stratOrder.length === 0 && JSON.stringify(r.stratFlags) === '{"a":1}');
  const before = read(path.join(TMP, "ui-prefs.json"));
  for (const bad of [null, "x", [], { stratOrder: "a,b", stratFlags: [1] }, { stratOrder: Array.from({ length: 201 }, (_, i) => "s" + i) }]) ctx.set(bad);
  ok("① 壞 patch(null / 字串 / 陣列 / 形狀錯 / 超過 200 筆)一律不寫", read(path.join(TMP, "ui-prefs.json")) === before);
  ok("① 讀取清洗:>200 筆 → [];flags 非物件 → {}", ctx.clean({ stratOrder: Array.from({ length: 201 }, (_, i) => "s" + i), stratFlags: [1] }).stratOrder.length === 0
    && JSON.stringify(ctx.clean({ stratOrder: ["a"], stratFlags: "x" })) === '{"stratOrder":["a"],"stratFlags":{}}' && JSON.stringify(ctx.clean(42)) === '{"stratOrder":[],"stratFlags":{}}');

  // ── ② ③ renderer 純函式 ──
  const rc = {};
  vm.runInNewContext(cutFn(sfSrc, "sfApplyOrder") + "\n" + cutFn(sfSrc, "sfFlagId") + "\nthis.apply = sfApplyOrder; this.fid = sfFlagId;", rc);
  const L = (...n) => n.map((name) => ({ name }));
  const names = (l) => l.map((x) => x.name).join();
  ok("② order 內且存在的先、其餘(新策略)照原序 append 最底", names(rc.apply(L("new2", "a", "b", "new1", "c"), ["c", "gone", "a"])) === "c,a,new2,b,new1");
  const same = L("a", "b");
  ok("② 沒拖過(order 空)= 原序、同一個陣列;單列也原樣", rc.apply(same, []) === same && rc.apply(same, ["b"]).length === 2 && names(rc.apply(L("a"), ["a"])) === "a");
  const odd = [{ name: "a" }, { x: 1 }, { name: "b" }];
  ok("② 長度對不上(有列沒名字,防禦)維持原序、同一個陣列;list 不是陣列原樣回", rc.apply(odd, ["b"]) === odd && rc.apply(null, ["a"]) === null && rc.apply(undefined, []) === undefined);
  ok("③ 畫面只畫 1–3:4–6 與其他一律當沒有", [1, 2, 3].every((v) => rc.fid(v) === v) && [0, 4, 6, 7, 1.5, "1", true, null, undefined].every((v) => rc.fid(v) === null));

  // ── ④ 接線 ──
  ok("④ CSS:武裝時旗標鈕收起、✕ 看得見;沒有 ✕ 的列旗標鈕移到 ✕ 的位置;雙鈕 64 / 單鈕 40;.flag-open 撐住填色",
    /\.strat-wrap:has\(\.cs-del\.is-armed\) \.strat-flagbtn \{ opacity: 0; pointer-events: none; \}/.test(css) && /\.strat-wrap:has\(\.cs-del\.is-armed\) \.cs-del \{ opacity: 1; pointer-events: auto; \}/.test(css)
    && /\.strat-wrap:not\(:has\(\.cs-del:not\(:disabled\)\)\) \.strat-flagbtn \{ right: var\(--space-6\); \}/.test(css)
    && /\.strat-wrap:is\(:hover, :has\(:focus-visible\), \.flag-open\):where\(:has\(\.strat-flagbtn\)\) \.strat-row \{ padding-right: 40px; \}/.test(css) && /:where\(:has\(\.strat-flagbtn\):has\(\.cs-del:not\(:disabled\)\)\) \.strat-row \{ padding-right: 64px; \}/.test(css)
    && /\n\.strat-wrap:is\(:hover, :has\(:focus-visible\)\):where\(:has\(\.cs-del:not\(:disabled\)\)\) \.strat-row \{ padding-right: 72px; \}/.test(css) && /\n\.strat-list \.strat-wrap \{ touch-action: none; \}/.test(css)
    && /\.strat-wrap\[data-flag\]::before \{[^}]*width: 2px; height: 16px;/.test(css) && /\.strat-wrap\.dragging \.strat-row \{[^}]*box-shadow: var\(--shadow-overlay\)/.test(css) && !/rgba\(0, ?0, ?0, ?\.45\)/.test(css));
  ok("④ tokens.css 有旗標三色(只有它可以寫 hex)、app.css 沒有寫死 hex", /--color-flag-1: #c79a3e;\s*\n\s*--color-flag-2: #8ad2e2;\s*\n\s*--color-flag-3: #8d68d4;/.test(tokens) && !/#[0-9a-f]{3,6}\b/i.test(css.split("\n").filter((l) => /flag|swcell|strat-wrap/.test(l)).join("\n")));
  const paint = cutFn(trSrc, "envPaintSide");
  ok("④ 雲端 tab:envPaintSide 用 sfCloudPrefs 套序、sig 帶旗標;每列 sfRowActions(…, SF_CLOUD) 接在名字與 ✕ 之間;拖拉中 sfCloudHold 先擋重建;列的 click 吞掉拖完那一下;刪除成功 sfCloudForget;兩份清單各綁一次拖拉",
    /const prefs = typeof sfCloudPrefs === "function" \? sfCloudPrefs\(st && st\.cloud\) : \{ order: \[\], flags: \{\} \};/.test(paint) && /sfApplyOrder\(shown, prefs\.order\)/.test(paint) && /prefs\.flags, list\.map/.test(paint)
    && /if \(ENV\.sig\.side === sig\) return;\n\s*if \(typeof sfCloudHold === "function" && sfCloudHold\(\(\) => \{ ENV\.sig\.side = null; trPaint\(\); \}\)\) return;[^\n]*\n\s*ENV\.sig\.side = sig;/.test(paint)
    && /wrap\.appendChild\(row\);\n\s*if \(typeof sfRowActions === "function"\) sfRowActions\(wrap, row, x, SF_CLOUD\);[^\n]*\n\s*if \(canDel/.test(paint) && /if \(typeof SF !== "undefined" && SF\.justDragged\) return;/.test(paint)
    && /CDEL\.gone\.set\(name, Date\.now\(\)\);\n\s*if \(typeof sfCloudForget === "function"\) sfCloudForget\(name\);/.test(trSrc) && !/window\.blave\.cloudStratPrefsSet/.test(trSrc)
    && /^sfBindDrag\(\$\("strat-list-cloud"\), SF_CLOUD\);\nsfBindDrag\(\$\("strat-list"\), SF_LOCAL\);$/m.test(sfSrc) && (sfSrc.match(/sfBindDrag\(/g) || []).length === 3
    && /\$\("strat-list-cloud"\)\.addEventListener\("scroll", \(\) => sfPopClose\(false\)\);/.test(sfSrc));
  ok("④ 雲端 tab 重建後焦點接回同名那一列的同一顆鈕(名字鈕或旗標鈕;逐列比名字,不拼 selector)",
    /const ae = document\.activeElement, aw = ae && box\.contains\(ae\) \? ae\.closest\("\.strat-wrap"\) : null;/.test(paint) && paint.indexOf("const keep =") < paint.indexOf('box.textContent = ""')
    && /if \(keep\) \{ const w = \[\.\.\.box\.querySelectorAll\(":scope > \.strat-wrap"\)\]\.find\(\(r\) => r\.dataset\.name === keep\.name\), b = w && w\.querySelector\(keep\.cls\); if \(b\) b\.focus\(\); \}/.test(paint));
  ok("④ cloud.js:snapshot 帶 strat_order / strat_flags(fail-soft、1–6、≤200),進 summaryKey(偏好改了也推)",
    /strat_order: prefOrder\(b\.strat_order\),\n\s*strat_flags: prefFlags\(b\.strat_flags\),/.test(read(path.join(SHELL, "cloud.js")))
    && /const prefOrder = \(v\) => \(Array\.isArray\(v\) \? v\.filter\(\(n\) => typeof n === "string" && n\)\.slice\(0, 200\) : \[\]\);/.test(read(path.join(SHELL, "cloud.js")))
    && /Number\.isInteger\(x\) && x >= 1 && x <= 6\)\.slice\(0, 200\)\) : \{\}\);/.test(read(path.join(SHELL, "cloud.js"))) && /JSON\.stringify\(s\.strat_order \|\| null\), JSON\.stringify\(s\.strat_flags \|\| null\),/.test(read(path.join(SHELL, "cloud.js"))));
  { const { interpret } = require(path.join(SHELL, "cloud.js"));
    const body = (o) => ({ machine: { state: "running" }, portfolio: {}, portfolio_stale: false, strategies_summary: [], ...o });
    const a = interpret({ status: 200, body: body({ strat_order: ["a", 3, "", "b"], strat_flags: { a: 2, b: 9, c: "1" } }) }), b = interpret({ status: 200, body: body({}) });
    ok("④ cloud.js interpret:清過的 order / flags;api 沒帶 = 空", a.strat_order.join() === "a,b" && JSON.stringify(a.strat_flags) === '{"a":2}' && b.strat_order.length === 0 && JSON.stringify(b.strat_flags) === "{}"); }
  ok("④ preload:兩支 IPC;set 只過 stratOrder / stratFlags 兩個鍵", /stratPrefs: \(\) => ipcRenderer\.invoke\("strat-prefs"\)/.test(pre) && /stratPrefsSet: \(p\) => ipcRenderer\.invoke\("strat-prefs-set", \{ stratOrder: p && p\.stratOrder, stratFlags: p && p\.stratFlags \}\)/.test(pre));
  ok("④ main:兩支走 handle(只收自家頁面),拒絕時回空的", /handle\("strat-prefs", \(\) => stratPrefsGet\(\), \{ stratOrder: \[\], stratFlags: \{\} \}\);/.test(mainSrc) && /handle\("strat-prefs-set", \(_e, patch\) => stratPrefsSet\(patch\), \{ stratOrder: \[\], stratFlags: \{\} \}\);/.test(mainSrc)
    && !/listStrategies\(\)[^\n]*strat(Order|Flags)/.test(mainSrc));
  const refresh = cutFn(appSrc, "stratRefresh");
  ok("④ stratRefresh:先 await sfBeforeRebuild(拖拉中等拖完、面板先收)、拿到清單後套序、旗標鈕接在名字與 ✕ 之間、列的 click 吞掉拖完那一下",
    /^\s*if \(typeof sfBeforeRebuild === "function"\) await sfBeforeRebuild\(\);/m.test(refresh) && refresh.indexOf("await sfBeforeRebuild()") < refresh.indexOf("await window.blave.listStrategies()")
    && /RP\.list = await window\.blave\.listStrategies\(\);\n\s*if \(typeof sfApplyOrder === "function"\) RP\.list = sfApplyOrder\(RP\.list, SF\.order\);/.test(refresh)
    && /wrap\.append\(b\);\n\s*if \(typeof sfRowActions === "function"\) sfRowActions\(wrap, b, x\);[^\n]*\n\s*wrap\.append\(del\);/.test(refresh) && /if \(typeof SF !== "undefined" && SF\.justDragged\) return;/.test(refresh)
    && /if \(r === true\) \{ if \(typeof sfForget === "function"\) sfForget\(x\.name\);/.test(refresh));
  const before2 = cutFn(sfSrc, "sfBeforeRebuild");
  ok("④ sfBeforeRebuild:收面板、等偏好讀好、拖拉中等 waiters;拖完(含 pointercancel)都 resolve", /sfPopClose\(false\)/.test(before2) && /sfReady\(\)/.test(before2) && /SF\.dragActive \? new Promise\(\(r\) => SF\.waiters\.push\(r\)\)/.test(before2)
    && /const finish = \(\) => \{ SF\.dragActive = false;[^\n]*SF\.waiters = \[\]; ws\.forEach\(\(r\) => r\(\)\); \};/.test(sfSrc) && /if \(ev\.pointerId === SF\.dragPointer && cleanup\(\)\) finish\(\);/.test(sfSrc));
  ok("④ 旗標值沒變不寫不埋;拖回原位不寫;兩個埋點是字面、都在白名單(0.1.20 A 案的 browser_hb_card、0.1.21 的 perf_update、0.1.23 的 pres_have_cert、0.1.24 的 contract_switch 接在它們後面)", /if \(next === sfFlagId\(sc\.flags\(\)\[name\]\)\) return;/.test(cutFn(sfSrc, "sfSetFlag")) && /if \(to !== from\) \{[^\n]*sfMoved\(sc\); \}/.test(sfSrc)
    && /trackFeature\("strat_flag_set"\);/.test(cutFn(sfSrc, "sfSetFlag")) && /trackFeature\("strat_reorder"\);/.test(cutFn(sfSrc, "sfMoved"))
    && (() => { const { EVENTS } = require(path.join(SHELL, "telemetry.js")); const n = EVENTS.feature_used.name; return n.slice(n.indexOf("strat_flag_set"), n.indexOf("contract_switch") + 1).join() === "strat_flag_set,strat_reorder,browser_hb_card,perf_update,pres_have_cert,contract_switch" && n.every((x) => x.length <= 16); })());
  ok("④ 面板:role=menu、色塊 menuitemradio、Esc 不冒泡到 escTop、外點 / resize / 捲動即收、右鍵的刪除那條走 ✕ 的武裝(回合中不給)",
    /sfPop\.setAttribute\("role", "menu"\)/.test(sfSrc) && /c\.setAttribute\("role", "menuitemradio"\)/.test(sfSrc) && /if \(e\.key === "Escape"\) \{ if \(e\.isComposing \|\| e\.keyCode === 229\) return; e\.preventDefault\(\); e\.stopPropagation\(\); sfPopClose\(true\); return; \}/.test(sfSrc)
    && /window\.addEventListener\("resize", \(\) => sfPopClose\(false\)\);/.test(sfSrc) && /\$\("strat-list"\)\.addEventListener\("scroll", \(\) => sfPopClose\(false\)\);/.test(sfSrc)
    && /showDel = !!ctx && !!del && !del\.disabled/.test(sfSrc) && /if \(!x\.classList\.contains\("is-armed"\)\) x\.click\(\);/.test(sfSrc) && !/innerHTML/.test(sfSrc));
  { const strings = read(path.join(R, "strings.js")), sb = {}; vm.runInNewContext(strings + "\nthis.S = STRINGS;", sb);
    const KEYS = ["side.flagSet", "side.flagRemove", "side.flagTitle", "side.flagAria", "side.flagC1", "side.flagC2", "side.flagC3"];
    ok("④ 字串表:七個 key 兩語都齊、字照 web 現值", KEYS.every((k) => sb.S.zh[k] && sb.S.en[k]) && sb.S.zh["side.flagTitle"] === "{name} — 旗標：{color}" && sb.S.zh["side.flagAria"] === "{name}，旗標：{color}"
      && sb.S.zh["side.flagC1"] === "赭金" && sb.S.en["side.flagC2"] === "Ice cyan" && sb.S.en["side.flagRemove"] === "Remove flag"); }
  // 稽核該修 ①④⑤:鍵盤排序的可發現性與讀屏回饋、旗標鈕 aria-expanded、選中格改內圈(外環只剩 focus ring)
  ok("④ 旗標鈕 aria-expanded:建時 false、面板開 true、收 false", /fb\.setAttribute\("aria-expanded", "false"\)/.test(cutFn(sfSrc, "sfRowActions"))
    && /anchor\.setAttribute\("aria-expanded", "true"\)/.test(cutFn(sfSrc, "sfPopOpen")) && /if \(ret\) ret\.setAttribute\("aria-expanded", "false"\);/.test(cutFn(sfSrc, "sfPopClose")));
  ok("④ 面板底不再印按鍵提示(Wei 10-12 拿掉;Alt+↑/↓ 仍可用);移動後 srSay「已移到第 N 位」",
    !/hint\.className = "hint"/.test(sfSrc) && /sfPop\.append\(d1, rm, d2, del\);/.test(sfSrc)
    && !/side\.sortHint/.test(sfSrc)
    && /if \(e\.key === "ArrowUp"\) sib\.before\(row\); else sib\.after\(row\);\n\s*const b = row\.querySelector\("\.strat-row"\); if \(b\) b\.focus\(\);\n\s*sfMoved\(sc\);\n\s*srSay\(t\("side\.moved", \{ n: \[\.\.\.box\.querySelectorAll\(":scope > \.strat-wrap"\)\]\.indexOf\(row\) \+ 1 \}\)\);/.test(sfSrc)
    && !/\.flag-pop \.hint/.test(css));
  ok("④ 選中格 = 內圈 box-shadow inset --bg-body,不再用 outline(focus ring 才是外環)", /\.flag-pop \.swcell\.selected \{ box-shadow: inset 0 0 0 2px var\(--bg-body\); \}/.test(css) && !/\.swcell\.selected \{[^}]*outline/.test(css));
  { const strings = read(path.join(R, "strings.js")), sb = {}; vm.runInNewContext(strings + "\nthis.S = STRINGS;", sb);
    ok("④ 字串表:side.sortHint 已移除、side.moved 帶 {n},兩語都齊", ["zh", "en"].every((l) => !("side.sortHint" in sb.S[l]) && /\{n\}/.test(sb.S[l]["side.moved"])) && sb.S.zh["side.moved"] === "已移到第 {n} 位"); }
  ok("④ index.html:stratflags.js 在 app.js 之後(用它的 $ / t / RP / stratTip / trackFeature)", html.indexOf('src="stratflags.js"') > html.indexOf('src="app.js"') && html.indexOf('src="stratflags.js"') > 0);
  // 0.1.23(Wei 10-13 開發版重載看到):app.js 的開機 IIFE 常在這支載入前就畫過側欄(實測 reload 後 30ms 畫、35ms 這支才到,stratRefresh 的 typeof 守衛靜默跳過 → 照 mtime 排、沒色條)。
  // 載入收尾從原文切出來跑:偏好一到,側欄已經畫過 → stratRefresh(false) 一次;還沒畫過 → 不叫(之後那次自己 await sfBeforeRebuild)
  { const tail = sfSrc.slice(sfSrc.lastIndexOf('sfBindDrag($("strat-list"), SF_LOCAL);'));
    const run = async (painted) => {
      const calls = [], c = { window: { blave: { stratPrefs: () => Promise.resolve({ stratOrder: ["b", "a"], stratFlags: { a: 1 } }) } }, $: () => ({ querySelector: () => (painted ? {} : null) }), stratRefresh: (x) => { calls.push(x); return Promise.resolve(); }, sfBindDrag: () => {}, SF_LOCAL: {} };
      vm.runInNewContext(line(sfSrc, /^const SF = \{[\s\S]*?\};$/m) + "\n" + cutFn(sfSrc, "sfReady") + "\n" + tail + "\nthis.SF = SF;", c);
      await new Promise((r) => setTimeout(r, 0));
      return { calls, order: c.SF.order.join(), flag: c.SF.flags.a };
    };
    const a = await run(true), b = await run(false);
    ok("④ 載入收尾:偏好讀好後,側欄畫過 → stratRefresh(false) 一次;沒畫過 → 不叫;兩邊偏好都進 SF", a.calls.length === 1 && a.calls[0] === false && a.order === "b,a" && a.flag === 1 && b.calls.length === 0 && b.order === "b,a");
    ok("④ 載入收尾是整支的最後一行、在 sfBindDrag 之後", /sfBindDrag\(\$\("strat-list"\), SF_LOCAL\);\n(\/\/[^\n]*\n)*sfReady\(\)\.then\(\(\) => \{ if \(\$\("strat-list"\)\.querySelector\("\.strat-wrap"\)\) stratRefresh\(false\); \}\);\n$/.test(tail)); }
} finally { fs.rmSync(TMP, { recursive: true, force: true }); }
console.log(red ? `\n${red} 紅` : "\n全綠");
process.exit(red ? 1 : 0);
})();
