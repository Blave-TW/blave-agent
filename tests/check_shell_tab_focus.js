/* 分頁類控件的焦點框規則(spec-0.1.19 §2):純文字分頁的 ring 永遠外擴、不准往內畫壓到字。
 *   1. #tr-tabs 是 .rp-tabs 同樣的兩層:外層畫 hairline,內層 .main-tabs-scroll 橫捲、四邊留 4 給 ring(等量負 margin 抵銷)
 *   2. trade.css 沒有 .main-tab:focus-visible { outline-offset: -2px };ring 走全域的 2px + offset 2 + radius xs
 *   3. 1024 寬那一階的 .main-tabs 內距還留著底下 1px(hairline 的位子)
 *   4. 捲動捷徑(.tabs-more)與報告分頁同一套接線(app.js tabsMoreWire)
 *   5. .mp-seg(effort 軌格子)改軌不裁切 + ring 外擴 + 聚焦浮上一層(§2.4 必修)
 * 跑法:node tests/check_shell_tab_focus.js
 */
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const html = read("index.html"), trcss = read("trade.css"), css = read("app.css"), app = read("app.js");
let red = 0; const ok = (n, c, why) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || !why ? "" : "\n      " + why)); if (!c) red++; };
const rule = (src, sel) => { const m = src.match(new RegExp("(^|\\n)" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{([^}]*)\\}")); return m ? m[2] : null; };

// 1. 兩層結構
const tabs = html.match(/<div class="main-tabs" role="tablist" id="tr-tabs"[^>]*hidden>([\s\S]*?)\n        <\/div>/);
ok("#tr-tabs 外層保留 id / role=tablist / aria-label", !!tabs && /data-i18n-aria="tr\.nav"/.test(html.match(/<div class="main-tabs"[^>]*>/)[0]));
{ const inner = tabs && tabs[1];
  const scroll = inner && inner.match(/<div class="main-tabs-scroll" id="tr-tabs-scroll">([\s\S]*?)<\/div>/);
  const five = scroll ? (scroll[1].match(/<button class="main-tab" /g) || []).length : 0;
  const outside = inner ? inner.replace(scroll[0], "") : "";
  ok("五顆 .main-tab 全在內層 .main-tabs-scroll 裡,外層沒有直接的 .main-tab", five === 5 && !/class="main-tab"/.test(outside), JSON.stringify({ five, outside }));
  ok("捲動捷徑 #tr-tabs-more.tabs-more 在內層之後:aria-hidden、不進 tab 順序、預設 hidden", /<button class="tabs-more" type="button" id="tr-tabs-more" aria-hidden="true" tabindex="-1" hidden>/.test(outside)); }

// 2. CSS:外層 hairline、內層留白、ring 不往內畫
{ const outer = rule(trcss, ".main-tabs"), scroll = rule(trcss, ".main-tabs-scroll"), tab = rule(trcss, ".main-tab");
  ok(".main-tabs:hairline 畫在 padding box 內(inset shadow)、底下留 1px;自己不再橫捲、沒有 border-bottom", !!outer && /box-shadow: inset 0 -1px 0 var\(--border-hairline\)/.test(outer)
    && /padding: 0 var\(--space-24\) 1px/.test(outer) && !/overflow-x/.test(outer) && !/border-bottom/.test(outer) && !/\.main-tabs::-webkit-scrollbar/.test(trcss), outer);
  ok(".main-tabs-scroll:橫捲、藏捲軸、四邊留 4 等量負 margin、底多 1 讓分頁底線蓋在 hairline 上;gap 承外層", !!scroll && /overflow-x: auto/.test(scroll) && /scrollbar-width: none/.test(scroll)
    && /padding: var\(--space-4\); margin: calc\(-1 \* var\(--space-4\)\); margin-bottom: calc\(-1 \* var\(--space-4\) - 1px\)/.test(scroll) && /gap: inherit/.test(scroll) && /flex: 1 1 0; min-width: 0/.test(scroll), scroll);
  ok(".main-tab:不再 margin-bottom -1(那是給舊的單層列蓋 border 用的)", !!tab && !/margin-bottom/.test(tab), tab);
  ok("沒有任何 .main-tab:focus-visible 往內畫(outline-offset 負值)", !/\.main-tab:focus-visible \{[^}]*outline-offset: -/.test(trcss));
  const ring = rule(css, ":where(button, a, [tabindex]):focus-visible");
  ok("全域 ring:2px --focus-ring、外擴 2、收角 radius-xs(分頁聚焦時繞 44 高的文字盒)", !!ring && /outline: 2px solid var\(--focus-ring\)/.test(ring) && /outline-offset: 2px/.test(ring) && /border-radius: var\(--radius-xs\)/.test(ring), ring); }

// 3. 1024 寬那一階
ok("窄中欄那一階 .main-tabs 內距收到 16,但底下的 1px 留著", /\n  \.main-tabs \{ padding: 0 var\(--space-16\) 1px; gap: var\(--space-16\); \}/.test(trcss));

// 4. 捲動捷徑同一套接線
ok("app.js:tabsMoreWire(box, more, tabSel) 一個函式,報告分頁與 #tr-tabs 各接一次;分頁拿到焦點就捲進可視範圍", /function tabsMoreWire\(box, more, tabSel\) \{/.test(app)
  && /tabsMoreWire\(\$\("rp-tabs-scroll"\), \$\("rp-tabs-more"\), "\.rp-tab"\);/.test(app) && /tabsMoreWire\(\$\("tr-tabs-scroll"\), \$\("tr-tabs-more"\), "\.main-tab"\);/.test(app)
  && /box\.querySelectorAll\(tabSel\)\.forEach\(\(b\) => b\.addEventListener\("focus", \(\) => rpTabReveal\(b\)\)\);/.test(app) && !/\$\("rp-tabs-scroll"\)\.querySelectorAll\("\.rp-tab"\)\.forEach\(\(b\) => b\.addEventListener\("focus"/.test(app));
ok("trade.js 的分頁接線不用改:點 / 鍵盤仍掛在 #tr-tabs(事件冒泡)、trSetTab 用 querySelectorAll 找 .main-tab", /\$\("tr-tabs"\)\.addEventListener\("click"/.test(read("trade.js")) && /\$\("tr-tabs"\)\.querySelectorAll\("\.main-tab"\)/.test(read("trade.js")));

// 5. .mp-seg
{ const rail = rule(css, ".mp-rail"), seg = rule(css, ".mp-seg:focus-visible");
  ok(".mp-rail 不再裁切(格子內距只有 4,往內畫會碰字;軌最窄 236 放不下 8)", !!rail && !/overflow: hidden/.test(rail), rail);
  ok(".mp-seg:focus-visible 不往內畫,聚焦時 position relative + z-index 1(不被鄰格分隔線蓋住)", !!seg && !/outline-offset/.test(seg) && /position: relative; z-index: 1/.test(seg), seg);
  ok("圓角改由首末格自己畫(同 .cn-lang)", /\.mp-seg:first-child \{ border-radius: calc\(var\(--radius-xs\) - 1px\) 0 0 calc\(var\(--radius-xs\) - 1px\); \}/.test(css)
    && /\.mp-seg:last-child \{ border-radius: 0 calc\(var\(--radius-xs\) - 1px\) calc\(var\(--radius-xs\) - 1px\) 0; \}/.test(css)); }

console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
