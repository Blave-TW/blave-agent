// 報告區的 news block 與 footnote 出處連結(契約 report-blocks 1.4;spec-report-blocks-recipes §4.3 / §4.4;web report_blocks.js 已上線那份)。
//   ① 靜態:news / 外部連結那段、footnote 出處、BLOCKS.kpi_row 與 proseShapes 與 web 逐字同一份;字串 zh / en 同 web 的 workspace_report_news_*;tokens.css 有 --tag-neutral-*;
//      報告區攔 a.rb-xlink 交 openExternal;埋點只在讀本機報告時送。
//   ② 用隨包的 Electron 開真的 index.html:api/tests/fixtures/report_news.json 畫出來(三則、標籤、原文行、來源行、「、」分隔、網域不斷行、
//      尾註只網域是連結)→ 點連結走 openExternal、不導覽 → 惡意 url 全部退成純文字 → 1.3 報告跟改動前的渲染器 outerHTML 逐字相同 → 埋點。
// 跑法:node tests/check_shell_report_news.js(沒有 monorepo 版面 / git / Electron 時對應段 SKIP)
const fs = require("fs"), path = require("path"), os = require("os"), vm = require("vm");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer"), FIX = path.join(__dirname, "fixtures");
const GATE = require("./_electron_gate");
const MONO = path.join(__dirname, "..", "..");
// api 的 fixture:BLAVE_API_DIR 優先(測試樹不在 monorepo 版面時指過去),再退 monorepo 的 ../api
const apiFile = (...p) => [process.env.BLAVE_API_DIR, path.join(MONO, "api")].filter(Boolean).map((d) => path.join(d, ...p)).find((f) => fs.existsSync(f)) || path.join(MONO, "api", ...p);
const NEWS_FIX = apiFile("tests", "fixtures", "report_news.json");
const WEB_RB = path.join(MONO, "web", "app", "static", "js", "agent", "report_blocks.js");
// news 進來之前那一版渲染器(desktop 0.1.6):舊報告零變化的比對基準
const BASE_REV = "4957ea6";
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 1500))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");

if (!process.versions.electron) {
  const rb = read(path.join(R, "report-blocks.js")), rpt = read(path.join(R, "reports.js")), tok = read(path.join(R, "tokens.css")), css = read(path.join(R, "report-blocks.css"));
  const STR = (() => { const sb = {}; vm.runInNewContext(read(path.join(R, "strings.js")) + "\nthis.S = STRINGS;", sb); return sb.S; })();
  const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); return i < 0 || j < 0 ? null : s.slice(i, j); };
  if (!fs.existsSync(WEB_RB)) console.log("SKIP  ① 與 web 逐字比對(需要 monorepo 版面)");
  else {
    const web = read(WEB_RB), A = "  // 外部連結(契約 §2,1.4 起)", B = "  BLOCKS.code = function (b) {";
    const F1 = '      var cell = proseShapes(el("span"), str(it.text), ctx);', F2 = "      row.setAttribute(\"aria-label\", ctx.i18n.footnoteRef";
    ok("① safeUrl / linkTo / hostOf / extLink / BLOCKS.news(含 published_at_precision)與 web 逐字同一份", !!cut(rb, A, B) && cut(rb, A, B) === cut(web, A, B) && /published_at_precision === "day" \? fmtDay\(/.test(cut(rb, A, B)));
    ok("① footnote 的出處連結與 web 逐字同一份", !!cut(rb, F1, F2) && cut(rb, F1, F2) === cut(web, F1, F2));
    // 研究報告公開分享 B 案(web 926058e3):kpi_row 的 delta 走 proseShapes、公開頁值含漢字整格 sans;電腦版永遠不是公開頁,行為不變、碼要同一份
    const KA = "  BLOCKS.kpi_row = function", KB = "  BLOCKS.line_chart = function", PA = "  var NUMERIC_RUN = ", PB = "  // ------------------------------------------------------- markdown 子集";
    ok("① BLOCKS.kpi_row 與 proseShapes(含 NUMERIC_RUN)與 web 逐字同一份", !!cut(rb, KA, KB) && cut(rb, KA, KB) === cut(web, KA, KB) && !!cut(rb, PA, PB) && cut(rb, PA, PB) === cut(web, PA, PB) && /HAS_CJK\.test\(str\(it\.value\)\)/.test(cut(rb, KA, KB)));
    ok("① makeCtx 的 ugc / listSep、DEFAULT_I18N 三個 news key、VISUAL.news 與 web 同", ['      ugc: opts.ugc === true,', '      listSep: /^(zh|ja|cn)\\b/i.test(document.documentElement.lang) ? "、" : ", ",', '    newsPos: "Positive News",', '    newsNeg: "Negative News",', '    newsNeutral: "Neutral",', "    news: 1,"].every((l) => rb.includes(l) && web.includes(l)));
  }
  const WEB_STR = { zh: { newsPos: "正面消息", newsNeg: "負面消息", newsNeutral: "中性" }, en: { newsPos: "Positive News", newsNeg: "Negative News", newsNeutral: "Neutral" } };   // web messages.po 的 workspace_report_news_*
  ok("① rb.news* zh / en 逐字同 web;rptI18n 交給渲染器", ["zh", "en"].every((L) => Object.keys(WEB_STR[L]).every((k) => STR[L]["rb." + k] === WEB_STR[L][k])) && ["newsPos", "newsNeg", "newsNeutral"].every((k) => rpt.includes(k + ': t("rb.' + k + '")')));
  ok("① tokens.css 在 :root 宣告 --tag-neutral-bg / -text = --surface-muted / --ink-2(dark 靠同元素重映射,不另寫)", /--tag-neutral-bg: var\(--surface-muted\);/.test(tok) && /--tag-neutral-text: var\(--ink-2\);/.test(tok) && (tok.match(/--tag-neutral-/g) || []).length === 2);
  ok("① report-blocks.css:Mini tag 整份配方寫在 .rb-news-tag(外殼沒有全域 .mini_tag)、三色、連結常駐底線", /\.rb-report \.rb-news-tag \{[^}]*height: 18px;[^}]*border-radius: var\(--radius-micro\);[^}]*font-size: 11px;[^}]*font-weight: 600;[^}]*letter-spacing: 0\.04em;/.test(css)
    && /\.is-neutral \{\s*background-color: var\(--tag-neutral-bg\);\s*color: var\(--tag-neutral-text\);/.test(css) && /\.rb-xlink-nm \{\s*text-decoration: underline;/.test(css) && !/\.mini_tag/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")));
  ok("① 報告區的外部連結:click + auxclick(中鍵)委派在 #rpt-read、只收 a.rb-xlink、preventDefault、https 才 openExternal",
    /\["click", "auxclick"\]\.forEach\(\(ev\) => g\("rpt-read"\)\.addEventListener\(ev, rptExtLink\)\);/.test(rpt) && /closest\("a\.rb-xlink"\)[^\n]*\n\s*e\.preventDefault\(\);\n\s*if \(\/\^https:\\\/\\\/\/i\.test\(a\.href\)\) window\.blave\.openExternal\(a\.href\);/.test(rpt));
  ok("① 晨報 / 新聞管道的埋點只在讀本機報告時送、而且在畫出 article 之後", /libTrack\("reports_read"\);\n\s*if \(env === "local"\) rptTrackKind\(doc\.report\);/.test(rpt));

  let base = null;
  try { base = require("child_process").execFileSync("git", ["show", BASE_REV + ":shell/renderer/report-blocks.js"], { cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "ignore"] }).toString(); } catch (_) { base = null; }
  const bin = GATE.bin(SHELL, "②");
  if (!bin) { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  if (!fs.existsSync(NEWS_FIX)) console.log("SKIP  ② news fixture(需要 monorepo 版面:../api/tests/fixtures/report_news.json)");
  const baseFile = base ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "blave-rbnews-")), "base.js") : "";
  if (base) fs.writeFileSync(baseFile, base); else console.log("SKIP  ② 舊報告零變化(git 裡找不到 " + BASE_REV + ")");
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: Object.assign({}, process.env, { RB_BASE: baseFile, RB_NEWS: fs.existsSync(NEWS_FIX) ? NEWS_FIX : "" }) });
  const sub = r.status == null ? 1 : r.status;
  console.log(red || sub ? `\n${red + sub} 紅` : "\nALL PASS");
  process.exit(red || sub ? 1 : 0);
}

// ── ② Electron ──
const { app, BrowserWindow } = require("electron");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-rbnews-")));
const NEWS = process.env.RB_NEWS ? JSON.parse(read(process.env.RB_NEWS)) : null;
// published_at_precision "day" 是契約 1.4 的一部分(report-blocks.md §3);api 那份 fixture 還沒帶這個項目時(檢出的 api 較舊)
// 在這裡把 web 管道那一則標成 day——那一條斷言照樣跑,不因 api 版本而 SKIP
if (NEWS && !NEWS.blocks.some((b) => b.type === "news" && b.items.some((it) => it.published_at_precision === "day"))) {
  const it = NEWS.blocks.find((b) => b.type === "news").items.find((x) => x.channel === "web");
  it.published_at_precision = "day"; it.published_at = Math.floor(it.published_at / 86400) * 86400 + 43200;   // 只有日期的來源存當天 12:00 UTC
  console.log("INFO  ② api fixture 沒有 published_at_precision=day 的項目(" + process.env.RB_NEWS + "):測試自己把 web 那一則標成 day");
}
const WEEKLY = JSON.parse(read(path.join(FIX, "report_weekly.json"))), MCPT = JSON.parse(read(path.join(FIX, "report_mcpt.json")));
const MORNING_FIX = apiFile("tests", "fixtures", "report_morning.json");
const MORNING = fs.existsSync(MORNING_FIX) ? JSON.parse(read(MORNING_FIX)) : null;
if (!MORNING) console.log("SKIP  ② 舊報告零變化的晨報樣本(需要 monorepo 版面:../api/tests/fixtures/report_morning.json)");
const BAD = ["http://news.example.com/a", "https://u:p@news.example.com/", "https://user@news.example.com/", "https://news.example.com\\evil.com/", "https:\\\\evil.com", "https://例子.com/", "https://news.example.com/\u200b",
  "javascript:alert(1)", "https:evil.com", "https:/evil.com", " https://news.example.com/", "https://", "", "data:text/html,x", "file:///etc/passwd", 123, null, { href: "https://evil.com" }];
const EVIL = { schema_version: "1.4", id: "x-evil", type: "research", title: "evil", created_at: 1790380800, blocks: [
  { type: "news", items: BAD.map((u, i) => ({ title: "t" + i, sources: [{ name: "S" + i, url: u }], channel: "web", published_at: 1790344800 }))
    .concat([{ title: "ok", sources: [{ name: "OK", url: "https://ok.example.com/p?q=1" }], published_at: 1790344800 }]) },
  { type: "footnote", items: BAD.map((u, i) => ({ id: "f" + i, text: "n" + i, url: u })) }] };
const LIST = [{ id: "tw-market-20260926", title: "news", type: "morning", created_at: 1790380800 }, { id: "x-evil", title: "evil", type: "research", created_at: 1790380700 }];
const STUB = `window.__r = { list: ${JSON.stringify({ reports: LIST })}, docs: ${JSON.stringify({ "tw-market-20260926": { report: NEWS, images: {} }, "x-evil": { report: EVIL, images: {} } })}, tracked: [], opened: [] };
const __fixed = {
  getLocale: async () => "zh-TW", loadConnection: async () => ({ kind: "claude" }), detectAgents: async () => ({ claude: { installed: true, loggedIn: true }, codex: { installed: false } }),
  listStrategies: async () => [], listSessions: async () => [], loadSession: async () => [], loadSessionImages: async () => [], updateState: async () => ({ phase: "idle", current: "0.0.0" }),
  hasBlaveToken: async () => true, ensureEngine: async () => ({}), libraryList: async () => ({ strategies: [], signedIn: true, dataAccess: "included" }),
  reportsList: async () => window.__r.list, reportLoad: async (id) => window.__r.docs[id] || null,
  cloudReports: async () => ({ code: "UNREACH", reports: [] }), cloudReport: async () => ({ code: "UNREACH", report: null, images: {} }),
  trackFeature: (n) => { window.__r.tracked.push(n); }, openExternal: async (u) => { window.__r.opened.push(u); return true; },
};
window.blave = new Proxy(__fixed, { get: (o, k) => (k in o ? o[k] : typeof k !== "string" ? undefined : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {} : async () => undefined) });`;
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
setTimeout(() => { console.log("FAIL  ② 逾時(90 秒)"); process.exit(1); }, 90000).unref();

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const preload = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(preload, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload, contextIsolation: false, sandbox: false } });
  let navigated = false; w.webContents.on("will-navigate", (e) => { navigated = true; e.preventDefault(); });
  w.webContents.setWindowOpenHandler(() => { navigated = true; return { action: "deny" }; });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1200);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const T = (k) => js(`t(${JSON.stringify(k)})`);
  const Q = `const q = (x) => [...document.querySelectorAll(x)], g = (id) => document.getElementById(id);`;
  const openRow = async (id) => { await js(`(async () => { const b = document.getElementById("rpt-back"); if (!b.hidden) b.click(); if (document.getElementById("rpt").hidden) document.getElementById("rpt-nav").click(); await new Promise((r) => setTimeout(r, 150)); document.querySelector('#rpt-rows .rpt-row[data-id="${id}"]').click(); })()`); await wait(500); };

  if (NEWS) {
    await openRow("tw-market-20260926");
    const a = await js(`(() => { ${Q} const A = g("rpt-read").querySelector("article.rb-report"); const items = [...A.querySelectorAll(".rb-news .rb-news-item")];
      const tag = A.querySelector(".rb-news-tag.is-neutral"), probe = document.createElement("span"); probe.style.background = "var(--surface-muted)"; probe.style.color = "var(--ink-2)"; A.appendChild(probe);
      const pc = getComputedStyle(probe), tc = getComputedStyle(tag), link = A.querySelector(".rb-news a.rb-xlink"), fnA = [...A.querySelectorAll(".rb-footnotes .rb-fn")].map((r) => r.querySelector("a") ? r.querySelector("a").className + "|" + r.querySelector("a").textContent + "|" + r.querySelector("a").href : "");
      const out = { n: items.length, titles: items.map((li) => li.querySelector(".rb-news-title").textContent), sym: items.map((li) => { const s = li.querySelector(".rb-news-sym"); return s ? s.className + ":" + s.textContent : ""; }),
        orig: items.map((li) => { const o = li.querySelector(".rb-news-orig"); return o ? o.lang + ":" + o.textContent : ""; }), sum: items.map((li) => li.querySelector(".rb-news-sum") ? 1 : 0).join(""),
        tags: items.map((li) => { const t = li.querySelector(".rb-news-tag"); return t ? t.className + ":" + t.textContent : ""; }), meta0: [...items[0].querySelector(".rb-news-meta").childNodes].map((n) => n.nodeType === 3 ? "#" + n.nodeValue : n.className),
        meta0Text: items[0].querySelector(".rb-news-meta").textContent, when: items.map((li) => { const x = li.querySelector(".rb-news-when"); return x ? getComputedStyle(x).whiteSpace + ":" + x.querySelector(".mono").textContent : ""; }),
        href: link.getAttribute("href"), target: link.target, rel: link.rel, nm: link.querySelector(".rb-xlink-nm").textContent, dom: link.querySelector(".rb-xlink-dom").textContent, domCls: link.querySelector(".rb-xlink-dom").className, nbsp: link.childNodes[1].nodeValue === "\\u00a0",
        domWrap: getComputedStyle(link.querySelector(".rb-xlink-dom")).whiteSpace, nmDeco: getComputedStyle(link.querySelector(".rb-xlink-nm")).textDecorationLine, srcPlain: items[0].querySelector(".rb-news-src").textContent, srcFont: getComputedStyle(items[0].querySelector(".rb-news-src")).fontFamily === getComputedStyle(items[0].querySelector(".rb-news-sum")).fontFamily,
        tagH: tc.height, tagFs: tc.fontSize, tagFw: tc.fontWeight, tagBg: tc.backgroundColor === pc.backgroundColor, tagInk: tc.color === pc.color, fn: fnA, fnDeco: A.querySelector(".rb-footnotes a") && getComputedStyle(A.querySelector(".rb-footnotes a")).textDecorationLine,
        fnTextDeco: getComputedStyle(A.querySelector(".rb-footnotes .rb-fn span:not(.rb-fn-no)")).textDecorationLine, scripts: A.querySelectorAll("script, iframe").length };
      probe.remove(); return out; })()`);
    const L = await Promise.all(["rb.newsPos", "rb.newsNeutral"].map(T));
    ok("② news:三則、標題純文字(不是連結)、代號 mono、外文原文行帶 lang、有摘要的才畫摘要", a.n === 3 && a.titles[0] === "2330台積電 9 月營收年增 38%" && a.sym[0] === "rb-news-sym mono:2330" && a.sym[1] === "" && a.orig[1] === "en:Fed governor says more data needed before cutting rates" && a.orig[0] === "" && a.sum === "110" && a.scripts === 0, JSON.stringify(a));
    ok("② 標籤在來源行開頭、字走 i18n(正面消息 / 中性);Mini tag 18px / 11px / 600;中性底色與字 = --surface-muted / --ink-2", a.tags[0] === "mini_tag rb-news-tag is-pos:" + L[0] && a.tags[1] === "mini_tag rb-news-tag is-neutral:" + L[1] && a.meta0[0] === "mini_tag rb-news-tag is-pos" && a.tagH === "18px" && a.tagFs === "11px" && a.tagFw === "600" && a.tagBg && a.tagInk, JSON.stringify(a));
    ok("② 來源行:沒 url 的來源是純文字(不套 mono)、zh 分隔「、」、有 url 的是 名稱(常駐底線)+ 不斷行空白 + 網域(mono、nowrap)、「·」跟時間綁一起 nowrap",
      a.srcPlain === "Anue鉅亨" && a.srcFont && a.meta0.join("|") === "mini_tag rb-news-tag is-pos|rb-news-src|#、|rb-xlink|rb-news-when" && a.nm === "經濟日報" && a.nbsp && a.dom === "money.udn.com" && a.domCls === "rb-xlink-dom mono" && a.domWrap === "nowrap" && a.nmDeco === "underline"
      && a.when.every((x, i) => (NEWS.blocks.find((b) => b.type === "news").items[i].published_at_precision === "day" ? /^nowrap:\d\d\/\d\d$/ : /^nowrap:\d\d\/\d\d \d\d:\d\d$/).test(x)), JSON.stringify(a));
    { const items = NEWS.blocks.find((b) => b.type === "news").items, di = items.findIndex((it) => it.published_at_precision === "day"), d = new Date(items[di].published_at * 1000), p2 = (n) => String(n).padStart(2, "0");
      ok("② published_at_precision \"day\":時間段只有日期 MM/DD(本地日期,不畫 00:00 / 12:00);沒帶的照舊 MM/DD HH:mm", di >= 0 && a.when[di] === "nowrap:" + p2(d.getMonth() + 1) + "/" + p2(d.getDate()) && items.some((it, i) => !it.published_at_precision && /^nowrap:\d\d\/\d\d \d\d:\d\d$/.test(a.when[i])), JSON.stringify([di, a.when])); }
    ok("② 連結屬性:href 原樣、target _blank、rel noopener noreferrer nofollow(不是公開頁,不加 ugc)", a.href === "https://money.udn.com/money/story/5612/1" && a.target === "_blank" && a.rel === "noopener noreferrer nofollow", JSON.stringify(a));
    ok("② 尾註:沒 url 的那條沒有 <a>;有 url 的只有網域是連結(去 www、mono、底線),說明文字不加底線", a.fn[0] === "" && a.fn[1] === "rb-xlink is-dom mono|twse.com.tw|https://www.twse.com.tw/" && a.fnDeco === "underline" && a.fnTextDeco === "none", JSON.stringify(a));
    const c = await js(`(() => { ${Q} const A = g("rpt-read").querySelector("article.rb-report"), x = A.querySelector(".rb-news a.rb-xlink"), f = A.querySelector(".rb-footnotes a.rb-xlink"); const before = location.href;
      x.querySelector(".rb-xlink-dom").click(); f.click(); x.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })); const right = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 }); x.dispatchEvent(right);
      const fr = A.querySelector("a.rb-fnref"); if (fr) fr.click();
      return { opened: window.__r.opened.slice(), same: location.href === before, rightPrevented: right.defaultPrevented }; })()`);
    await wait(100);
    ok("② 點來源(含點網域那段)/ 尾註網域 / 中鍵 → openExternal 各一次、頁面不導覽、不開新視窗;右鍵不攔", c.opened.join() === ["https://money.udn.com/money/story/5612/1", "https://www.twse.com.tw/", "https://money.udn.com/money/story/5612/1"].join() && c.same && !c.rightPrevented && !navigated, JSON.stringify(c));
    const tr = await js("window.__r.tracked.slice()");
    ok("② 讀本機 tw-market-* 且帶 web / licensed 兩種管道:morning_tw、news_web、news_licensed 各送;不送 morning_crypto", ["reports_read", "morning_tw", "news_web", "news_licensed"].every((n) => tr.includes(n)) && !tr.includes("morning_crypto"), JSON.stringify(tr));
    await js(`(async () => { setLang("en"); applyStatic(); rptRepaint && rptRepaint(); })()`); await wait(50);
    await openRow("x-evil"); await openRow("tw-market-20260926");
    const en = await js(`(() => { const m = document.querySelector("#rpt-read .rb-news-item .rb-news-meta"); const out = { txt: [...m.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue), tag: m.querySelector(".rb-news-tag").textContent }; setLang("zh"); applyStatic(); return out; })()`);
    ok("② en:分隔符「, 」、標籤 Positive News", en.txt[0] === ", " && en.tag === "Positive News", JSON.stringify(en));
  }

  {
    await js(`window.__r.tracked = []; window.__r.opened = [];`);
    await openRow("x-evil");
    const e = await js(`(() => { ${Q} const A = g("rpt-read").querySelector("article.rb-report"); return { links: [...A.querySelectorAll("a")].map((x) => x.getAttribute("href")), srcs: [...A.querySelectorAll(".rb-news-src")].map((x) => x.textContent), items: A.querySelectorAll(".rb-news-item").length, fnA: A.querySelectorAll(".rb-footnotes a").length, fns: A.querySelectorAll(".rb-fn").length }; })()`);
    ok("② 惡意 url(http、帳密、反斜線、非 ASCII、零寬字、javascript:、https:evil、前導空白、空、非字串…)一律退成純文字來源、尾註不帶 <a>;對照組 https://ok.example.com 照常是連結",
      e.items === BAD.length + 1 && e.links.join() === "https://ok.example.com/p?q=1" && e.srcs.length === BAD.length && e.srcs.every((s, i) => s === "S" + i) && e.fnA === 0 && e.fns === BAD.length, JSON.stringify(e));
    const tr = await js("window.__r.tracked.slice()");
    ok("② 非內建範本 id 的報告:不送 morning_*(管道照 items[].channel 送)", !tr.some((n) => /^morning_/.test(n)) && tr.includes("news_web") && !tr.includes("news_licensed"), JSON.stringify(tr));
  }

  if (process.env.RB_BASE) {
    const docs = [WEEKLY, MCPT].concat(MORNING ? [MORNING] : []);
    // 量容器寬的圖(candlestick / bar)在 ResizeObserver 的下一幀才畫:兩邊都掛上、等畫完再比
    const same = await js(`(async () => { const fake = { NodeFilter: window.NodeFilter, console: window.console, ResizeObserver: window.ResizeObserver, requestAnimationFrame: window.requestAnimationFrame.bind(window), matchMedia: window.matchMedia.bind(window) };   // 渲染器讀的 global.* 全列(沒有 marked / DOMPurify:外殼走 opts.markdown)
      (function (window) { ${read(process.env.RB_BASE)} })(fake);
      const docs = ${JSON.stringify(docs)}, opts = { apiBase: "", i18n: rptI18n("local"), imageUrl: () => "", markdown: rptMarkdown }, read = document.getElementById("rpt-read"), out = [];
      for (const rep of docs) {
        const ha = document.createElement("div"), hb = document.createElement("div"); read.append(ha, hb);
        fake.renderAgentReport(ha, rep, opts); window.renderAgentReport(hb, rep, opts);
        for (let k = 0; k < 3; k++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
        // 唯一預期的差異:圖例末值改成新規則(去尾零、只有座標含零或跨零才標 +;spec-turn-status-summary ④ 同批)
        // 預期的差異(同批設計稽核 B4/B5):KPI 有 delta 時色從值移到 delta、顯示負號統一 U+2212——兩邊都抹平再比
        const norm = (h) => h.replace(/ rb-(?:up|dn)(?=")/g, "").split("\u2212").join("-");
        const a = norm(ha.innerHTML.split("+914.20 萬張").join("914.2 萬張")), b = norm(hb.innerHTML); ha.remove(); hb.remove();
        let i = 0; while (i < a.length && a[i] === b[i]) i++;
        out.push({ id: rep.id, len: a.length, svg: (a.match(/<svg/g) || []).length, same: a === b, diff: a === b ? "" : a.slice(i - 60, i + 100) + " ≠ " + b.slice(i - 60, i + 100) });
      }
      return out; })()`);
    ok("② 舊版報告零變化:weekly / mcpt(1.3)、morning(1.2)用改動前(" + BASE_REV + ")與現在的渲染器畫,outerHTML 逐字相同(圖例末值新格式、KPI 色移到 delta、負號 U+2212 除外)", same.length === docs.length && same.every((x) => x.same && x.len > 1000 && x.svg > 0), JSON.stringify(same));
  }

  console.log(red ? `\n② ${red} 紅` : "\n② ALL PASS");
  app.exit(red ? 1 : 0);
});
