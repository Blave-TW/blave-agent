// 側欄旗標與拖拉排序(shell/renderer/stratflags.js + main.js 的 strat-prefs / strat-prefs-set;spec desktop-strat-flags-2026-10 §7)。不起 Electron。
//   ① 主行程清洗(從原文切出來、用真的 fs 在暫存 userData 跑):壞形狀回空、超長截掉、非法鍵丟掉、去重保序、旗標值 1–6 收其餘丟;
//      set 只動有帶的鍵、不碰 pdfDir、原子寫(沒留暫存檔)、壞 patch 不寫;
//      資料夾 stratGroups(spec strategy-sidebar-folders §3、§10):讀取只驗形狀、超限不整包失效(map 先丟不在 stratNames 的、讀不到目錄直接截)、
//      寫入時 emoji 跟檔內同 id 比(沒變放行、變了且不在 72 個清單 → null);收合狀態 stratGroupsCollapsed 兩個視角各一份
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
const block = (s, head) => { const i = s.indexOf(head); if (i < 0) throw new Error("no " + head); const j = s.indexOf("\n);", i); return s.slice(i, j + 3); };   // 多行的 const X = ( … );
const two = (r) => JSON.stringify({ stratOrder: r.stratOrder, stratFlags: r.stratFlags });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "blave-sp-"));
(async () => {
try {
  // ── ① 主行程 ──
  const ctx = { fs, path, app: { getPath: () => TMP }, console, NAMES: [] };
  vm.runInNewContext([line(mainSrc, /^const LIB_NAME_RE = .*$/m), line(mainSrc, /^const STRAT_PREFS_MAX = .*$/m), line(mainSrc, /^const uiPrefsPath = .*$/m),
    block(mainSrc, "const SG_EMOJI = ("), line(mainSrc, /^const SG_EMOJI_SET = .*$/m), line(mainSrc, /^const SG_FOLDERS_MAX = .*$/m), line(mainSrc, /^const plainObj = .*$/m),
    "function stratNames() { return NAMES; }",   // 真的那支讀 workspace/strategies;這裡換成可控的名單
    cutFn(mainSrc, "uiPrefsPatch"), cutFn(mainSrc, "stratGroupsClean"), cutFn(mainSrc, "stratGroupsCollapsedClean"), cutFn(mainSrc, "stratPrefsClean"), cutFn(mainSrc, "stratPrefsGet"), cutFn(mainSrc, "stratPrefsSet")].join("\n") + "\nthis.get = stratPrefsGet; this.set = stratPrefsSet; this.clean = stratPrefsClean;", ctx);
  const file = () => JSON.parse(read(path.join(TMP, "ui-prefs.json")));
  const EMPTY = '{"stratOrder":[],"stratFlags":{},"stratGroups":{"v":1,"folders":[],"map":{}},"stratGroupsCollapsed":{"local":[],"cloud":[]}}';
  ok("① 沒有檔:回空的、不炸", JSON.stringify(ctx.get()) === EMPTY, JSON.stringify(ctx.get()));
  fs.writeFileSync(path.join(TMP, "ui-prefs.json"), "{broken");
  ok("① 檔壞掉:回空的、不炸", JSON.stringify(ctx.get()) === EMPTY);
  fs.writeFileSync(path.join(TMP, "ui-prefs.json"), JSON.stringify({ pdfDir: "/x/y" }));
  let r = ctx.set({ stratOrder: ["b", "a", "b", 7, ".hidden", "a/b", "", "c"], stratFlags: { a: 2, b: 6, c: 7, d: 0, e: 1.5, f: "1", g: true, ".h": 1, h: 3 } });
  ok("① set 清洗:order 去重保序、丟非字串 / 以 . 開頭 / 含分隔 / 空字串;flags 收 1–6 的整數、丟 7 / 0 / 小數 / 字串 / 布林 / 非法鍵",
    two(r) === '{"stratOrder":["b","a","c"],"stratFlags":{"a":2,"b":6,"h":3}}', JSON.stringify(r));
  ok("① 寫回同一個 ui-prefs.json、pdfDir 不動、沒留暫存檔", file().pdfDir === "/x/y" && file().stratOrder.join() === "b,a,c" && !fs.existsSync(path.join(TMP, "ui-prefs.json.blave-tmp")));
  r = ctx.set({ stratFlags: { a: 1 } });
  ok("① 只帶 flags:order 不動、flags 整份換", r.stratOrder.join() === "b,a,c" && JSON.stringify(r.stratFlags) === '{"a":1}');
  r = ctx.set({ stratOrder: [] });
  ok("① 空陣列合法 = 清掉自訂順序", r.stratOrder.length === 0 && JSON.stringify(r.stratFlags) === '{"a":1}');
  const before = read(path.join(TMP, "ui-prefs.json"));
  for (const bad of [null, "x", [], { stratOrder: "a,b", stratFlags: [1] }, { stratOrder: Array.from({ length: 201 }, (_, i) => "s" + i) }]) ctx.set(bad);
  ok("① 壞 patch(null / 字串 / 陣列 / 形狀錯 / 超過 200 筆)一律不寫", read(path.join(TMP, "ui-prefs.json")) === before);
  ok("① 讀取清洗:>200 筆 → [];flags 非物件 → {}", ctx.clean({ stratOrder: Array.from({ length: 201 }, (_, i) => "s" + i), stratFlags: [1] }).stratOrder.length === 0
    && two(ctx.clean({ stratOrder: ["a"], stratFlags: "x" })) === '{"stratOrder":["a"],"stratFlags":{}}' && JSON.stringify(ctx.clean(42)) === EMPTY);
  // ── ① 資料夾 ──
  const G = (folders, map, v) => ({ ...(v === undefined ? {} : { v }), folders, map });
  const cg = (g) => ctx.clean({ stratGroups: g }).stratGroups;
  let g = cg(G([{ id: "fok0001", name: "主力", emoji: "⭐" }, { id: "BAD", name: "x", emoji: null }, { id: "fok0001", name: "重複", emoji: null }, { id: "fblank1", name: "  ", emoji: null },
    { id: "flong01", name: "一二三四五六七八九十一二三四五六七八九十一", emoji: null }, { id: "fmax001", name: "一二三四五六七八九十一二三四五六七八九十", emoji: "🪙" }, { id: "fbig001", name: "x", emoji: "123456789" }, { id: "fnum001", name: "y", emoji: 7 }],
    { a: "fok0001", b: "BAD", c: "fgone01", ".h": "fok0001", d: "fmax001", e: 3 }));
  ok("① stratGroups 讀取清洗:壞 id / 重複 id(先到先贏)/ 空白名 / 超過 20 個碼點的名字丟掉;emoji 只驗形狀(不在清單的短字串照留、>8 個 UTF-16 單位或非字串 → null);map 指向不存在的資料夾、非法名字、非字串值丟掉",
    JSON.stringify(g) === JSON.stringify({ v: 1, folders: [{ id: "fok0001", name: "主力", emoji: "⭐" }, { id: "fmax001", name: "一二三四五六七八九十一二三四五六七八九十", emoji: "🪙" }, { id: "fbig001", name: "x", emoji: null }, { id: "fnum001", name: "y", emoji: null }], map: { a: "fok0001", d: "fmax001" } }), JSON.stringify(g));
  ok("① stratGroups 讀取清洗:不是物件 / v 不是 1 → 空結構;沒帶 v 照收", JSON.stringify(cg([1])) === '{"v":1,"folders":[],"map":{}}' && JSON.stringify(cg(G([{ id: "fok0001", name: "a", emoji: null }], {}, 2))) === '{"v":1,"folders":[],"map":{}}'
    && cg(G([{ id: "fok0001", name: "a", emoji: null }], {})).folders.length === 1);
  const many = Array.from({ length: 25 }, (_, i) => ({ id: "fid" + String(i).padStart(4, "0"), name: "n" + i, emoji: null }));
  ok("① folders 超過 20:截到 20,不整包失效", cg(G(many, {})).folders.length === 20 && cg(G(many, {})).folders[19].id === "fid0019");
  const bigMap = {}; for (let i = 0; i < 250; i++) bigMap["s" + i] = "fid0000";
  ctx.NAMES = Array.from({ length: 150 }, (_, i) => "s" + (i * 2));   // 偶數那 125 支在 0..249 裡
  let mp = cg(G(many.slice(0, 1), bigMap)).map;
  ok("① map 超過 200:先丟不在 stratNames() 的鍵(其餘全留)", Object.keys(mp).length === 125 && Object.keys(mp).every((k) => Number(k.slice(1)) % 2 === 0), Object.keys(mp).length);
  ctx.NAMES = [];
  mp = cg(G(many.slice(0, 1), bigMap)).map;
  ok("① map 超過 200、stratNames() 讀不到目錄(回 []):跳過名單過濾、直接截到 200(不清光歸屬)", Object.keys(mp).length === 200 && mp.s0 === "fid0000");
  ctx.NAMES = Array.from({ length: 220 }, (_, i) => "s" + i);
  ok("① map 超過 200、名單內也超過:截到 200", Object.keys(cg(G(many.slice(0, 1), bigMap)).map).length === 200);
  ok("① 收合狀態:兩個視角各一份,只收資料夾 id 與 _u、去重", JSON.stringify(ctx.clean({ stratGroupsCollapsed: { local: ["fok0001", "_u", "fok0001", "x", 3], cloud: "no", other: ["fok0001"] } }).stratGroupsCollapsed) === '{"local":["fok0001","_u"],"cloud":[]}');
  // 寫入端的 emoji 驗證:檔內那份是舊版看不懂的值(🪙 不在清單)
  fs.writeFileSync(path.join(TMP, "ui-prefs.json"), JSON.stringify({ pdfDir: "/x/y", stratOrder: ["b"], stratGroups: G([{ id: "fkeep01", name: "留著", emoji: "🪙" }, { id: "fchg001", name: "改了", emoji: "⭐" }], { b: "fkeep01" }, 1) }));
  r = ctx.set({ stratGroups: G([{ id: "fkeep01", name: "留著", emoji: "🪙" }, { id: "fchg001", name: "改了", emoji: "🦖" }, { id: "fnew001", name: "新的", emoji: "🪙" }, { id: "fnew002", name: "好的", emoji: "🚀" }], { b: "fkeep01" }, 1) });
  ok("① set 的 emoji:跟檔內同 id 比——沒變的放行(不改壞舊版看不懂的值)、改了且不在清單 → null、新資料夾不在清單 → null、清單內照收",
    JSON.stringify(r.stratGroups.folders.map((f) => f.emoji)) === JSON.stringify(["🪙", null, null, "🚀"]) && JSON.stringify(file().stratGroups.folders.map((f) => f.emoji)) === JSON.stringify(["🪙", null, null, "🚀"]), JSON.stringify(r.stratGroups));
  ok("① 只帶 stratGroups:順序、旗標、pdfDir 不動", r.stratOrder.join() === "b" && file().pdfDir === "/x/y");
  r = ctx.set({ stratGroupsCollapsed: { local: ["fkeep01"], cloud: ["_u"] } });
  ok("① 只帶 stratGroupsCollapsed:資料夾不動", r.stratGroups.folders.length === 4 && JSON.stringify(r.stratGroupsCollapsed) === '{"local":["fkeep01"],"cloud":["_u"]}');
  const b4 = read(path.join(TMP, "ui-prefs.json"));
  ctx.set({ stratGroups: [1] }); ctx.set({ stratGroups: "x" }); ctx.set({ stratGroupsCollapsed: null });
  ok("① stratGroups / stratGroupsCollapsed 不是物件:不寫", read(path.join(TMP, "ui-prefs.json")) === b4);
  ok("① SG_EMOJI(main.js)= 72 個單一碼點、不重複", (() => { const c = {}; vm.runInNewContext(block(mainSrc, "const SG_EMOJI = (") + "\nthis.L = [...SG_EMOJI];", c); return c.L.length === 72 && new Set(c.L).size === 72 && c.L.every((e) => [...e].length === 1); })());

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
    /const prefs = typeof sfCloudPrefs === "function" \? sfCloudPrefs\(st && st\.cloud\) : \{ order: \[\], flags: \{\} \};/.test(paint) && /sfApplyOrder\(shown, prefs\.order\)/.test(paint) && /prefs\.flags, prefs\.groups, list\.map/.test(paint)
    && /if \(ENV\.sig\.side === sig\) return;\n\s*if \(typeof sfCloudHold === "function" && sfCloudHold\(\(\) => \{ ENV\.sig\.side = null; trPaint\(\); \}\)\) return;[^\n]*\n\s*ENV\.sig\.side = sig;/.test(paint)
    && /wrap\.appendChild\(row\);\n\s*if \(typeof sfRowActions === "function"\) sfRowActions\(wrap, row, x, SF_CLOUD\);[^\n]*\n\s*if \(canDel/.test(paint) && /if \(typeof SF !== "undefined" && SF\.justDragged\) return;/.test(paint)
    && /CDEL\.gone\.set\(name, Date\.now\(\)\);\n\s*if \(typeof sfCloudForget === "function"\) sfCloudForget\(name\);/.test(trSrc) && !/window\.blave\.cloudStratPrefsSet/.test(trSrc)
    && /^sfBindDrag\(\$\("strat-list-cloud"\), SF_CLOUD\);\nsfBindDrag\(\$\("strat-list"\), SF_LOCAL\);$/m.test(sfSrc) && (sfSrc.match(/sfBindDrag\(/g) || []).length === 3
    && /\$\("strat-list-cloud"\)\.addEventListener\("scroll", \(\) => sfPopClose\(false\)\);/.test(sfSrc));
  ok("④ 雲端 tab 重建後焦點接回同名那一列的同一顆鈕(名字鈕或旗標鈕;逐列比名字,不拼 selector)",
    /const ae = document\.activeElement, aw = ae && box\.contains\(ae\) \? ae\.closest\("\.strat-wrap"\) : null, ah = /.test(paint) && paint.indexOf("const keep =") < paint.indexOf('box.textContent = ""')
    && /if \(keep\) \{ const w = \[\.\.\.box\.querySelectorAll\(":scope > \.strat-wrap"\)\]\.find\(\(r\) => r\.dataset\.name === keep\.name\), b = w && w\.querySelector\(keep\.cls\); if \(b\) b\.focus\(\); \}/.test(paint));
  ok("④ cloud.js:snapshot 帶 strat_order / strat_flags(fail-soft、1–6、≤200),進 summaryKey(偏好改了也推)",
    /strat_order: prefOrder\(b\.strat_order\),\n\s*strat_flags: prefFlags\(b\.strat_flags\),/.test(read(path.join(SHELL, "cloud.js")))
    && /const prefOrder = \(v\) => \(Array\.isArray\(v\) \? v\.filter\(\(n\) => typeof n === "string" && n\)\.slice\(0, 200\) : \[\]\);/.test(read(path.join(SHELL, "cloud.js")))
    && /Number\.isInteger\(x\) && x >= 1 && x <= 6\)\.slice\(0, 200\)\) : \{\}\);/.test(read(path.join(SHELL, "cloud.js"))) && /JSON\.stringify\(s\.strat_order \|\| null\), JSON\.stringify\(s\.strat_flags \|\| null\),/.test(read(path.join(SHELL, "cloud.js"))));
  { const { interpret } = require(path.join(SHELL, "cloud.js"));
    const body = (o) => ({ machine: { state: "running" }, portfolio: {}, portfolio_stale: false, strategies_summary: [], ...o });
    const a = interpret({ status: 200, body: body({ strat_order: ["a", 3, "", "b"], strat_flags: { a: 2, b: 9, c: "1" },
      strat_groups: { v: 1, folders: [{ id: "fok0001", name: "主力", emoji: "🪙" }, { id: "bad", name: "x", emoji: null }, { id: "fbig001", name: "y", emoji: "123456789" }], map: { a: "fok0001", b: "bad", "": "fok0001" } } }) }), b = interpret({ status: 200, body: body({}) });
    ok("④ cloud.js interpret:清過的 order / flags;api 沒帶 = 空", a.strat_order.join() === "a,b" && JSON.stringify(a.strat_flags) === '{"a":2}' && b.strat_order.length === 0 && JSON.stringify(b.strat_flags) === "{}");
    ok("④ cloud.js interpret:strat_groups 只驗形狀(不認得的 emoji 原樣留、過長 → null、壞 id 丟、map 指向不存在的丟);舊 api 沒帶 = 空結構",
      JSON.stringify(a.strat_groups) === JSON.stringify({ v: 1, folders: [{ id: "fok0001", name: "主力", emoji: "🪙" }, { id: "fbig001", name: "y", emoji: null }], map: { a: "fok0001" } }) && JSON.stringify(b.strat_groups) === '{"v":1,"folders":[],"map":{}}', JSON.stringify(a.strat_groups));
    ok("④ cloud.js summaryKey 帶 strat_groups(網頁建了資料夾也推)", /JSON\.stringify\(s\.strat_groups \|\| null\)/.test(read(path.join(SHELL, "cloud.js")))); }
  ok("④ preload:兩支 IPC;set 只過 stratOrder / stratFlags / stratGroups / stratGroupsCollapsed 四個鍵", /stratPrefs: \(\) => ipcRenderer\.invoke\("strat-prefs"\)/.test(pre) && /stratPrefsSet: \(p\) => ipcRenderer\.invoke\("strat-prefs-set", \{ stratOrder: p && p\.stratOrder, stratFlags: p && p\.stratFlags, stratGroups: p && p\.stratGroups, stratGroupsCollapsed: p && p\.stratGroupsCollapsed \}\)/.test(pre));
  ok("④ main:兩支走 handle(只收自家頁面),拒絕時回空的", /handle\("strat-prefs", \(\) => stratPrefsGet\(\), stratPrefsClean\(null\)\);/.test(mainSrc) && /handle\("strat-prefs-set", \(_e, patch\) => stratPrefsSet\(patch\), stratPrefsClean\(null\)\);/.test(mainSrc)
    && !/listStrategies\(\)[^\n]*strat(Order|Flags)/.test(mainSrc));
  const refresh = cutFn(appSrc, "stratRefresh");
  ok("④ stratRefresh:先 await sfBeforeRebuild(拖拉中等拖完、面板先收)、拿到清單後套序、旗標鈕接在名字與 ✕ 之間、列的 click 吞掉拖完那一下",
    /^\s*if \(typeof sfBeforeRebuild === "function"\) await sfBeforeRebuild\(\);/m.test(refresh) && refresh.indexOf("await sfBeforeRebuild()") < refresh.indexOf("await window.blave.listStrategies()")
    && /RP\.list = await window\.blave\.listStrategies\(\);\n\s*if \(typeof sfApplyOrder === "function"\) RP\.list = sfApplyOrder\(RP\.list, SF\.order\);/.test(refresh)
    && /wrap\.append\(b\);\n\s*if \(typeof sfRowActions === "function"\) sfRowActions\(wrap, b, x\);[^\n]*\n\s*wrap\.append\(del\);/.test(refresh) && /if \(typeof SF !== "undefined" && SF\.justDragged\) return;/.test(refresh)
    && /if \(r === true\) \{ if \(typeof sfForget === "function"\) sfForget\(x\.name\);/.test(refresh));
  const before2 = cutFn(sfSrc, "sfBeforeRebuild");
  ok("④ sfBeforeRebuild:收面板、等偏好讀好、拖拉中或資料夾編輯列開著等 waiters;拖完(含 pointercancel、Esc)都 resolve,兩件事都結束才放",
    /sfPopClose\(false\)/.test(before2) && /sfReady\(\)/.test(before2) && /SF\.dragActive \|\| sgEditing\(\) \? new Promise\(\(r\) => SF\.waiters\.push\(r\)\)/.test(before2)
    && /const finish = \(\) => \{ SF\.dragActive = false;[^\n]*sfFlushWaiters\(\); \};/.test(sfSrc) && /if \(ev\.pointerId === SF\.dragPointer && cleanup\(\)\) finish\(\);/.test(sfSrc)
    && /if \(SF\.dragActive \|\| sgEditing\(\)\) return;\n\s*const ws = SF\.waiters; SF\.waiters = \[\]; ws\.forEach\(\(r\) => r\(\)\);/.test(cutFn(sfSrc, "sfFlushWaiters"))
    && /if \(ev\.key === "Escape" && dragging\) \{[^\n]*if \(cleanup\(\)\) finish\(\); \}/.test(sfSrc));
  ok("④ 旗標值沒變不寫不埋;拖回原位 / 離開清單不寫;兩個埋點是字面、都在白名單(0.1.20 A 案的 browser_hb_card、0.1.21 的 perf_update、0.1.23 的 pres_have_cert、0.1.24 的 contract_switch 接在它們後面)", /if \(next === sfFlagId\(sc\.flags\(\)\[name\]\)\) return;/.test(cutFn(sfSrc, "sfSetFlag"))
    && /if \(!d \|\| d\.home\) return;/.test(sfSrc) && /if \(moved\) \{ trackFeature\("sfolder_move"\); sfWriteOrder\(sc\); \} else if \(reordered\) sfMoved\(sc\);/.test(sfSrc)
    && /trackFeature\("strat_flag_set"\);/.test(cutFn(sfSrc, "sfSetFlag")) && /trackFeature\("strat_reorder"\);/.test(cutFn(sfSrc, "sfMoved"))
    && (() => { const { EVENTS } = require(path.join(SHELL, "telemetry.js")); const n = EVENTS.feature_used.name; return n.slice(n.indexOf("strat_flag_set"), n.indexOf("contract_switch") + 1).join() === "strat_flag_set,strat_reorder,browser_hb_card,perf_update,pres_have_cert,contract_switch" && n.every((x) => x.length <= 16); })());
  ok("④ 面板:role=menu、色塊 menuitemradio、Esc 不冒泡到 escTop、外點 / resize / 捲動即收、右鍵的刪除那條走 ✕ 的武裝(回合中不給)",
    /sfPop\.setAttribute\("role", "menu"\)/.test(sfSrc) && /c\.setAttribute\("role", "menuitemradio"\)/.test(sfSrc) && /if \(e\.key === "Escape"\) \{ if \(e\.isComposing \|\| e\.keyCode === 229\) return; e\.preventDefault\(\); e\.stopPropagation\(\); sfPopClose\(true\); return; \}/.test(sfSrc)
    && /window\.addEventListener\("resize", \(\) => sfPopClose\(false\)\);/.test(sfSrc) && /\$\("strat-list"\)\.addEventListener\("scroll", \(\) => sfPopClose\(false\)\);/.test(sfSrc)
    && /showDel = !!ctx && !!del && !del\.disabled/.test(sfSrc) && /if \(!x\.classList\.contains\("is-armed"\)\) x\.click\(\);/.test(sfSrc) && !/innerHTML/.test(sfSrc)
    && /sfPop\.querySelector\("\.item\[data-rm\]"\)\.textContent = t\("side\.flagRemove"\);/.test(sfSrc) && /sfPop\.querySelector\("\.item\[data-ctx\]"\)\.textContent = /.test(sfSrc));
  { const strings = read(path.join(R, "strings.js")), sb = {}; vm.runInNewContext(strings + "\nthis.S = STRINGS;", sb);
    const KEYS = ["side.flagSet", "side.flagRemove", "side.flagTitle", "side.flagAria", "side.flagC1", "side.flagC2", "side.flagC3"];
    ok("④ 字串表:七個 key 兩語都齊、字照 web 現值", KEYS.every((k) => sb.S.zh[k] && sb.S.en[k]) && sb.S.zh["side.flagTitle"] === "{name} — 旗標：{color}" && sb.S.zh["side.flagAria"] === "{name}，旗標：{color}"
      && sb.S.zh["side.flagC1"] === "赭金" && sb.S.en["side.flagC2"] === "Ice cyan" && sb.S.en["side.flagRemove"] === "Remove flag"); }
  // 稽核該修 ①④⑤:鍵盤排序的可發現性與讀屏回饋、旗標鈕 aria-expanded、選中格改內圈(外環只剩 focus ring)
  ok("④ 旗標鈕 aria-expanded:建時 false、面板開 true、收 false", /fb\.setAttribute\("aria-expanded", "false"\)/.test(cutFn(sfSrc, "sfRowActions"))
    && /anchor\.setAttribute\("aria-expanded", "true"\)/.test(cutFn(sfSrc, "sfPopOpen")) && /if \(ret\) ret\.setAttribute\("aria-expanded", "false"\);/.test(cutFn(sfSrc, "sfPopClose")));
  ok("④ 面板底不再印按鍵提示(Wei 10-12 拿掉;Alt+↑/↓ 仍可用);移動後 srSay「已移到第 N 位」",
    !/hint\.className = "hint"/.test(sfSrc) && /sfPop\.append\(d1, rn, rm, ho, moves, d2, del\);/.test(sfSrc)   // ho = 送上雲端／拉回(0.1.47),併在第一條線那組
    && !/side\.sortHint/.test(sfSrc)
    && /if \(sib\.classList\.contains\("strat-wrap"\)\) \{ if \(up\) sib\.before\(row\); else sib\.after\(row\); \}/.test(sfSrc)
    && /else \{ sfMoved\(sc\); srSay\(t\("side\.moved", \{ n: \[\.\.\.box\.querySelectorAll\(":scope > \.strat-wrap"\)\]\.indexOf\(row\) \+ 1 \}\)\); \}/.test(sfSrc)
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
