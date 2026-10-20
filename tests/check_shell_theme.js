// 電腦版外觀(0.1.28,設計師 light-mode-2026-10 盤點):跟隨系統／淺色／深色。純 node,不起 Electron。
//   ① tokens.css:light 放 :root、dark 只重映射;新角色兩邊都有值;每個被換掉的舊 token 在深色下解析成同一個值(深色零差異)
//   ② 寫死的暗色假設清掉:renderer 的 css / js 不再直接引 --color-dark* / --color-greyDark(豁免:tokens.css、report-print.css、分享 OG 圖)
//   ③ 首繪:index.html 沒有寫死 data-theme、theme-boot.js 是 <head> 第一支 script、在所有樣式表之前;列印頁不載它(PDF 永遠淺色);
//      之後每次換:整頁交叉淡化(減少動態／藏住／不支援就一幀換完、回呼裡同步發 blave:theme、過渡中按下=跳終態保焦點)
//   ④ 主行程:ui-prefs theme 只認三個值、開窗前設 themeSource、開窗底色跟主題且鏡射 tokens.css、系統一換就改底色;IPC 兩支
//   ⑤ 設定 › 一般第一列是外觀 segment(三格順序固定)、字串兩語都有、改值才送 theme_* 、顯示淺色才送 theme_light_seen
//   ⑥ 全 app 的 segment 共用一份灰軌配方(app.css):每個畫 --surface-segment-on 選中格的控件都在配方清單裡,沒有誰還畫外框或格間分隔
// 跑法:node tests/check_shell_theme.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
const read = (f) => fs.readFileSync(f, "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || !d ? "" : "  ← " + d)); if (!c) red++; };

// ── ① token 解析:只處理 tokens.css 的兩個區塊與 var() 代換,夠用來比對值 ──
const tok = read(path.join(R, "tokens.css")).replace(/\/\*[\s\S]*?\*\//g, "");
const block = (sel) => { const i = tok.indexOf(sel + " {"); const body = tok.slice(i + sel.length + 2, tok.indexOf("\n}", i)); const o = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) o[m[1]] = m[2].trim(); return o; };
const LIGHT = block(":root"), DARK = { ...LIGHT, ...block('[data-theme="dark"]') };
const resolve = (env, v, d = 0) => (d > 10 ? "LOOP" : v.replace(/var\((--[\w-]+)\)/g, (_, k) => (k in env ? resolve(env, env[k], d + 1) : "UNDEF")));
const val = (env, k) => (k in env ? resolve(env, env[k]) : "UNDEF");
for (const k of ["--ink-disabled", "--surface-overlay", "--chart-band", "--chart-rest", "--scrim", "--fog-mask", "--color-flag-1", "--color-flag-2", "--color-flag-3"])
  ok("① " + k + " 淺色有值、深色重映射成不同的值", val(LIGHT, k) !== "UNDEF" && k in block('[data-theme="dark"]') && val(LIGHT, k) !== val(DARK, k), val(LIGHT, k) + " / " + val(DARK, k));
ok("① 旗標三色 = canon(light 壓明度、dark 照舊)", ["#ad7e1f", "#1f93ad", "#7f4eda"].every((h, i) => val(LIGHT, "--color-flag-" + (i + 1)) === h)
  && ["#c79a3e", "#8ad2e2", "#8d68d4"].every((h, i) => val(DARK, "--color-flag-" + (i + 1)) === h));
ok("① --ink-disabled:淺色 #818f97(對 body 2.94:1,同 dark 重量)、深色 greyDark 的重上值(停用字不按 token 名翻)", val(LIGHT, "--ink-disabled") === "#818f97" && val(DARK, "--ink-disabled") === "#546168");
// 舊 → 新:深色下必須一字不差(深色零差異的靜態那一半;另一半是逐像素比對,見 0.1.28 交付紀錄)
const SWAPS = [["--color-greyDark", "--ink-disabled"], ["--color-greyDark", "--border-frame"], ["--color-greyDark", "--surface-segment-on"],
  ["--color-greyDark", "--chart-band"], ["--color-greyDark", "--chart-rest"], ["--color-darkBorder", "--surface-muted"], ["--color-darkBorder", "--border-hairline"],
  ["--surface-muted", "--surface-overlay"]];
for (const [a, b] of SWAPS) ok("① 深色下 " + a + " = " + b, val(DARK, a) === val(DARK, b) && val(DARK, a) !== "UNDEF", val(DARK, a) + " vs " + val(DARK, b));
ok("① 深色 --shadow-overlay = 原本寫死在浮層上的 0 8px 24px rgba(0,0,0,.5)", val(DARK, "--shadow-overlay").replace(/\s/g, "") === "08px24pxrgba(0,0,0,.5)");
// 每個 renderer css / js 引到的角色都定義過(拼錯名字 = 透明)
const used = new Set();
for (const f of fs.readdirSync(R).filter((n) => /\.(css|js)$/.test(n) && n !== "tokens.css")) for (const m of read(path.join(R, f)).matchAll(/(?:var\(|Token\(|token\(|tok\(|Rgba\()"?(--(?:ink|surface|border|chart|bg|scrim|fog|shadow)[\w-]*)/g)) used.add(m[1]);
const undef = [...used].filter((k) => !(k in LIGHT) || !(k in DARK));
ok("① renderer 引到的角色變數在 tokens.css 都有定義", used.size > 15 && undef.length === 0, used.size + " " + undef.join(", "));

// ── ② 寫死的暗色假設 ──
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const stray = [];
for (const f of fs.readdirSync(R).filter((n) => /\.(css|js)$/.test(n) && !["tokens.css", "report-print.css"].includes(n))) {
  strip(read(path.join(R, f))).split("\n").forEach((l, i) => { if (/--color-(dark(Body|Card|Border|Text)|greyDark)\b/.test(l) && !/\.shr-og/.test(l)) stray.push(f + ":" + (i + 1)); });
}
ok("② renderer 不再直接引 --color-dark* / --color-greyDark(豁免:分享 OG 圖固定淺色)", stray.length === 0, stray.join(" "));
const css = fs.readdirSync(R).filter((n) => n.endsWith(".css")).map((n) => read(path.join(R, n))).join("\n");
ok("② 原生控件不寫死 color-scheme: dark", !/color-scheme:\s*dark\s*;/.test(css));
ok("② 浮層陰影走 --shadow-overlay,沒有寫死的 rgba(0, 0, 0, 0.5)", !/0 8px 24px rgba\(0, 0, 0, 0\.5\)/.test(css));

// ── ③ 首繪 ──
const html = read(path.join(R, "index.html")), head = html.slice(0, html.indexOf("</head>")).replace(/<!--[\s\S]*?-->/g, "");
ok("③ index.html 的 <html> 沒有寫死 data-theme", !/<html[^>]*data-theme/.test(html));
ok("③ theme-boot.js 是 <head> 第一支 script、在 CSP 之後、所有樣式表之前",
  head.indexOf('<script src="theme-boot.js"></script>') > head.indexOf("Content-Security-Policy") && head.indexOf('<script src="theme-boot.js"></script>') < head.indexOf("<link rel=\"stylesheet\"")
  && head.indexOf("<script") === head.indexOf('<script src="theme-boot.js"></script>'));
ok("③ 列印頁不載 theme-boot.js(沒有屬性 = 淺色)", !/theme-boot/.test(read(path.join(R, "report-print.html"))));
{ // theme-boot 本身:依 prefers-color-scheme 寫屬性;換的時候整頁淡化一次(減少動態／藏住／不支援 → 一幀換完)
  const run = (o) => {
    const attrs = {}, cls = new Set(), evs = [], ls = [], log = []; let onChange = null, dark = true, rafs = [];
    const vt = o.vt ? { skipped: 0, skipTransition() { this.skipped++; }, finished: new Promise((r) => { o.finish = r; }) } : null;
    const sb = { window: { matchMedia: (q) => ({ get matches() { return /reduced-motion/.test(q) ? !!o.reduce : dark; }, addEventListener: (_, f) => { onChange = f; } }),
        dispatchEvent: (e) => { evs.push(e.type); log.push("ev:" + attrs["data-theme"]); } },
      document: { hidden: !!o.hidden, documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) },
        addEventListener: (t, f, c) => ls.push([t, f, c]), removeEventListener: (t, f, c) => { const i = ls.findIndex((x) => x[0] === t && x[1] === f && x[2] === c); if (i >= 0) ls.splice(i, 1); } } },
      requestAnimationFrame: (f) => rafs.push(f), Event: function (t) { this.type = t; } };
    if (vt) sb.document.startViewTransition = (cb) => { log.push("vt:" + cls.has("theme-flip")); cb(); log.push("vt-cb-done"); return vt; };
    vm.runInNewContext(read(path.join(R, "theme-boot.js")), sb);
    const first = attrs["data-theme"]; dark = false; onChange();
    return { first, attrs, cls, evs, ls, log, vt, finish: () => o.finish(), flushRaf: () => { for (let i = 0; i < 2; i++) { const q = rafs; rafs = []; q.forEach((f) => f()); } } };
  };
  const plain = run({});
  const flipBefore = plain.cls.has("theme-flip"); plain.flushRaf();
  ok("③ theme-boot:系統深色 → dark;不支援過渡 → 一幀換成 light 並發 blave:theme,theme-flip 兩個 rAF 後才拿掉",
    plain.first === "dark" && plain.attrs["data-theme"] === "light" && plain.evs.join() === "blave:theme" && flipBefore && !plain.cls.has("theme-flip"), JSON.stringify([plain.first, plain.attrs, plain.evs]));
  const rm = run({ reduce: true, vt: true }), hid = run({ hidden: true, vt: true });
  ok("③ theme-boot:減少動態、視窗藏住時不開過渡(即使支援),照樣一幀換完", [rm, hid].every((x) => !x.log.some((l) => l.startsWith("vt:")) && x.attrs["data-theme"] === "light" && x.evs.join() === "blave:theme"));
  const v = run({ vt: true });
  ok("③ theme-boot:支援時先停元件過渡再開過渡,換屬性與 blave:theme 在回呼裡同步發(新畫面那一幀圖表就是新色)",
    v.log.join() === "vt:true,ev:light,vt-cb-done", v.log.join());
  const guards = v.ls.filter((x) => x[2] === true).map((x) => x[0]).sort().join();
  let prevented = 0; v.ls[0][1]({ preventDefault: () => prevented++ });
  ok("③ theme-boot:過渡中 pointerdown／mousedown 捕獲守門 → preventDefault(保住焦點)＋跳到終態", guards === "mousedown,pointerdown" && prevented === 1 && v.vt.skipped === 1, guards);
  const flipMid = v.cls.has("theme-flip"); v.finish();
  setTimeout(() => ok("③ theme-boot:過渡結束才拿掉 theme-flip 與兩個守門", flipMid && !v.cls.has("theme-flip") && v.ls.length === 0, v.ls.length + ""), 0);
}
// 淡化本身:時長走 token、曲線對稱;group 漏寫的話瀏覽器預設 0.25s 會撐住過渡與守門
{ const appCss = read(path.join(R, "app.css"));
  ok("③ app.css:theme-flip 期間所有元件與偽元素 transition: none !important", /html\.theme-flip \*, html\.theme-flip \*::before, html\.theme-flip \*::after \{ transition: none !important; \}/.test(appCss));
  ok("③ app.css:::view-transition-group/old/new(root) 三個都走 var(--motion-theme) ease-in-out",
    /::view-transition-group\(root\), ::view-transition-old\(root\), ::view-transition-new\(root\) \{\s*animation-duration: var\(--motion-theme\); animation-timing-function: ease-in-out;\s*\}/.test(appCss));
  ok("③ tokens.css:--motion-theme 0.3s", val(LIGHT, "--motion-theme") === "0.3s" && val(DARK, "--motion-theme") === "0.3s");
}

// ── ④ 主行程 ──
const main = read(path.join(SHELL, "main.js"));
{ const src = main.slice(main.indexOf("const THEMES = "), main.indexOf("let awakeBlocker"));
  let file = null; const patched = [];
  const sb = { fs: { readFileSync: () => { if (file === null) throw new Error("ENOENT"); return file; } }, uiPrefsPath: () => "x", uiPrefsPatch: (p) => patched.push(p), nativeTheme: { themeSource: "system", shouldUseDarkColors: true } };
  vm.runInNewContext(src + "\nthis.themeGet = themeGet; this.themeSet = themeSet; this.themeBg = themeBg;", sb);
  const got = [null, '{"theme":"light"}', '{"theme":"dark"}', '{"theme":"blue"}', "{bad"].map((x) => { file = x; return sb.themeGet(); });
  ok("④ themeGet:缺檔 / 認不得 / 壞檔都當跟隨系統", JSON.stringify(got) === JSON.stringify(["system", "light", "dark", "system", "system"]), JSON.stringify(got));
  file = "{}"; const r1 = sb.themeSet("light"), src1 = sb.nativeTheme.themeSource; const r2 = sb.themeSet("sepia");
  ok("④ themeSet:三個值才寫 ui-prefs 並改 themeSource;其他值不寫、回現值", r1 === "light" && src1 === "light" && patched.length === 1 && patched[0].theme === "light" && r2 === "system");
  const bgDark = sb.themeBg(); sb.nativeTheme.shouldUseDarkColors = false; const bgLight = sb.themeBg();
  ok("④ 開窗底色鏡射 tokens.css 的 --bg-body(dark darkBody / light white)", bgDark === val(DARK, "--color-darkBody") && bgLight === val(LIGHT, "--color-white") && val(DARK, "--bg-body") === bgDark && val(LIGHT, "--bg-body") === bgLight);
}
const ready = main.slice(main.indexOf("app.whenReady().then("));
ok("④ whenReady 先設 themeSource、後 createWindow;系統一換就改所有視窗底色", ready.indexOf("nativeTheme.themeSource = themeGet();") >= 0 && ready.indexOf("nativeTheme.themeSource = themeGet();") < ready.indexOf("createWindow();")
  && /nativeTheme\.on\("updated", \(\) => \{ const bg = themeBg\(\); for \(const w of BrowserWindow\.getAllWindows\(\)\) if \(!w\.isDestroyed\(\)\) w\.setBackgroundColor\(bg\); \}\);/.test(ready));
ok("④ 主視窗 backgroundColor: themeBg()、不再寫死 #0f161a", /backgroundColor: themeBg\(\),/.test(main) && !/backgroundColor: "#0f161a"/.test(main));
const pre = read(path.join(SHELL, "preload.js"));
ok("④ IPC:theme / theme-set 只收自家頁面(handle),preload 只傳字串", /handle\("theme", \(\) => themeGet\(\), "system"\);/.test(main) && /handle\("theme-set", \(_e, v\) => themeSet\(v\), null\);/.test(main)
  && /themeSet: \(v\) => ipcRenderer\.invoke\("theme-set", typeof v === "string" \? v : ""\)/.test(pre));

// ── ⑤ 設定 UI 與埋點 ──
const pane = html.slice(html.indexOf('<div class="set-pane" data-set-cat="display">'));
const rows = [...pane.matchAll(/<div class="set-row"[^>]*>/g)].map((m) => m.index);
ok("⑤ 設定 › 一般第一列是外觀,三格依序 跟隨系統／淺色／深色(radiogroup)", pane.indexOf('id="set-theme"') > rows[0] && pane.indexOf('id="set-theme"') < rows[1] && pane.indexOf('for="set-lang"') > rows[1]
  && /role="radiogroup" aria-labelledby="set-theme-l"/.test(pane) && [...pane.slice(0, rows[1]).matchAll(/data-theme-v="(\w+)"/g)].map((m) => m[1]).join() === "system,light,dark");
const S = (() => { const sb = {}; vm.runInNewContext(read(path.join(R, "strings.js")) + "\nthis.S = STRINGS;", sb); return sb.S; })();
ok("⑤ 字串:外觀 / 跟隨系統 / 淺色 / 深色(en Appearance / System / Light / Dark)",
  ["set.theme", "set.theme.system", "set.theme.light", "set.theme.dark"].map((k) => S.zh[k]).join() === "外觀,跟隨系統,淺色,深色"
  && ["set.theme", "set.theme.system", "set.theme.light", "set.theme.dark"].map((k) => S.en[k]).join() === "Appearance,System,Light,Dark");
const app = read(path.join(R, "app.js"));
ok("⑤ 改值才送 theme_*(主行程回的值 = 要的值、而且真的變了);顯示成淺色才送 theme_light_seen",
  /const THEME_FEATURE = \{ system: "theme_system", light: "theme_light", dark: "theme_dark" \};/.test(app)
  && /if \(!THEME_FEATURE\[v\] \|\| v === THEME\) return;/.test(app) && /if \(r !== v\) return;[^\n]*\n\s*THEME = v; themePaint\(\); trackFeature\(THEME_FEATURE\[v\]\);/.test(app)
  && /function themeShown\(\) \{ if \(document\.documentElement\.getAttribute\("data-theme"\) === "light"\) trackFeature\("theme_light_seen"\); \}/.test(app)
  && /window\.addEventListener\("blave:theme", themeShown\);/.test(app));
ok("⑤ 圖表跟著換:K 線 / 交易地圖就地改色,回測 / 樣本外 / 策略組合 / 總覽曲線重畫,策略庫小曲線改色(歡迎頁的卡片與小曲線隨 onboarding E 退役)",
  ["report-trades.js", "report-backtest.js", "report-wf.js", "portfolio.js", "trade.js", "library.js"].every((f) => /addEventListener\("blave:theme"/.test(read(path.join(R, f))))
  && /const retheme = function \(\)/.test(read(path.join(R, "report-trades.js"))));

// ── ⑥ segment 一種長相 ──
const segCss = Object.fromEntries(fs.readdirSync(R).filter((n) => n.endsWith(".css") && n !== "tokens.css").map((n) => [n, read(path.join(R, n))]));
const railM = segCss["app.css"].match(/:is\(([^)]+)\) \{\s*display: inline-flex; padding: var\(--space-2\); border-radius: var\(--radius-md\); background: var\(--surface-muted\);/);
const CELLS = ["mp-seg"];   // 格子自己帶 class 的(在 .mp-rail 裡)
const rails = railM ? railM[1].split(",").map((x) => x.trim().slice(1)) : [];
ok("⑥ 共用配方:灰軌 + 格 sm(平時 1px 透明框)+ 選中 segment-on／--border-frame 框／ink 600,不用陰影(pressed 與 checked 都認)", rails.length >= 10
  && /:is\([^)]+\) > button \{\s*position: relative; border: 1px solid transparent;/.test(segCss["app.css"])
  && /> button:is\(\[aria-pressed="true"\], \[aria-checked="true"\]\) \{\s*background: var\(--surface-segment-on\); border-color: var\(--border-frame\); color: var\(--ink\); font-weight: 600;\s*\}/.test(segCss["app.css"])
  && !rails.concat(CELLS).some((r) => Object.values(segCss).some((c) => new RegExp("\\." + r + "[^{]*\\{[^}]*box-shadow: var\\(--shadow").test(c))), rails.join());
const owners = [];
for (const [f, c] of Object.entries(segCss)) for (const m of c.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{[^}]*background: var\(--surface-segment-on\)/g))
  for (const sel of m[1].split(",")) { const cls = (sel.trim().match(/^(?:html\[[^\]]+\] )?\.([\w-]+)/) || [])[1]; if (cls) owners.push([f, cls]); }
const offList = owners.filter(([, c]) => !rails.includes(c) && !CELLS.includes(c));
ok("⑥ 每個畫選中格的控件都在配方清單裡(列舉所有 css)", owners.length > 0 && offList.length === 0, offList.map((x) => x.join(":")).join(" "));
const outlined = rails.filter((r) => Object.values(segCss).map((c) => c.replace(/\/\*[\s\S]*?\*\//g, "")).some((c) => new RegExp("\\." + r + " button \\+ button|\\." + r + "[^{]*\\{[^}]*border: 1px solid var\\(--border-frame\\)").test(c)));
ok("⑥ 沒有 segment 還畫外框或格間分隔", outlined.length === 0, outlined.join());
ok("⑥ 未選字 --ink-2(--ink-3 在灰軌上淺 4.06／深 3.61,12px 不到 AA);焦點框 offset 0;熱區共用一條補到 44",
  /:is\([^)]+\) > button \{\s*position: relative; border: 1px solid transparent; border-radius: var\(--radius-sm\); color: var\(--ink-2\);/.test(segCss["app.css"])
  && /:is\([^)]+\) > button:focus-visible \{ outline-offset: 0; z-index: 1; \}/.test(segCss["app.css"])
  && /:is\([^)]+\) > button::before \{\s*content: ""; position: absolute; left: 0; right: 0;\s*top: min\(0px, calc\(\(100% - 44px\) \/ 2\)\); bottom: min\(0px, calc\(\(100% - 44px\) \/ 2\)\);/.test(segCss["app.css"]));
const ownFx = rails.concat(CELLS).filter((r) => Object.values(segCss).map((c) => c.replace(/\/\*[\s\S]*?\*\//g, "")).some((c) => new RegExp("\\." + r + "(?: button)?(?::focus-visible|::before)[^{]*\\{").test(c)));
ok("⑥ 各 segment 不再自己寫焦點框或熱區(列舉)", ownFx.length === 0, ownFx.join());

setTimeout(() => { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }, 10);
