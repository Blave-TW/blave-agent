// 伸縮鈕不被瀏覽器蓋住(Wei 0.1.7 實測):中欄的 .bw overlay(z-index 20)蓋過 .pane-div(原 z-index 5),
// 20px 收合把手騎在欄縫上、有 10px 在中欄裡,那半顆被蓋住、點下去落在 .bw。
// 修法:.pane-div 疊到 .bw 之上;原生 view 量的是 .bv-page,靠 .bv 的 24px 側 padding 讓開(10 < 24)。
// 跑法:node tests/check_shell_browser_pane_fit.js
const fs = require("fs");
const path = require("path");
const RD = path.join(__dirname, "..", "shell", "renderer");
const app = fs.readFileSync(path.join(RD, "app.css"), "utf8");
const br = fs.readFileSync(path.join(RD, "browser.css"), "utf8");
const bjs = fs.readFileSync(path.join(RD, "browser.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

const z = (css, sel) => { const m = css.match(new RegExp(sel.replace(/[.\\]/g, "\\$&") + "\\s*\\{[^}]*z-index:\\s*(\\d+)", "")); return m ? Number(m[1]) : null; };
const zDiv = z(app, ".pane-div"), zBw = z(br, ".bw");
ok("欄縫(.pane-div)疊在 .bw overlay 之上(把手才看得到、點得到)", zDiv !== null && zBw !== null && zDiv > zBw, { zDiv, zBw });

const handle = app.match(/\.pane-div \.handle \{[^}]*width:\s*(\d+)px/);
const pad = /\.bv \{[^}]*padding: 0 var\(--space-24\)/.test(br);
ok("原生 view 讓開把手:.bv 側 padding 24 > 把手騎進中欄的一半(20/2 = 10)", handle && Number(handle[1]) / 2 < 24 && pad, { handle: handle && handle[1], pad });

// bounds 量測面:主行程 setBounds 的矩形 = renderer 量 .bv-page(在 .bv 裡,吃得到那 24px),
// 不是 .bw / .pane-main 本身——量錯元素的話上面那條讓開就是假的
ok("bounds 量的是 .bv-page[data-live='1'](.bv 之內)", /querySelector\("\.bv-page\[data-live='1'\]"\)/.test(bjs));
ok(".bw overlay 自己仍鋪滿中欄(left/right 0)——蓋把手靠 z-index 解,不是縮 overlay", /\.bw \{[^}]*left: 0; right: 0/.test(br));

console.log(red ? "\n" + red + " FAILED" : "\nALL PASS");
process.exit(red ? 1 : 0);
