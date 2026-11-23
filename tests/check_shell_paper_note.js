// 改壞不會被別的測試抓到的版面(spec uiux-batch1 第 9 項):
//   聊天附圖(app.css;canon chat-shell › agent 貼的圖,0.1.60 spec chat-image-strip):單張限高 280、1px --border-frame、radius sm、不包卡;
//   相鄰兩張以上是橫向膠捲(外框高 160、寬上限 = 膠捲寬 − 48、張間 8、snap、細捲軸、右緣 24 淡出);圖裡的顏色是資料,不准上 filter／opacity／混色
//   (第 11 項「模擬怎麼成交？」展開內文:電腦版連接框 0.1.53 案一已拿掉那一列,沒有家,這支不再驗)
// 跑法:node tests/check_shell_paper_note.js(不開 Electron,只讀原文)
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
let red = 0; const ok = (n, c, why) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || !why ? "" : "  " + why)); if (!c) red++; };

{ const css = fs.readFileSync(path.join(R, "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
  const of = (sel) => rules.filter(([s]) => s.split(",").some((x) => x.trim() === sel)).map(([, b]) => b).join(";");
  const fig = of(".msg.img"), zoom = of(".img-zoom"), img = of(".img-zoom img"), sc = of(".img-strip-sc"), cell = of(".img-strip .img-zoom"), cimg = of(".img-strip .img-zoom img"), fade = of(".img-strip-fade");
  ok("單張不包卡:沒有 --cf-bg／--cf-border／內距", !/--cf-bg|--cf-border|padding/.test(fig), fig);
  ok("框在按鈕上:1px --border-frame、radius sm、zoom-in;焦點框 offset 2 畫在圖外", /border:\s*1px solid var\(--border-frame\)/.test(zoom) && /border-radius:\s*var\(--radius-sm\)/.test(zoom) && /cursor:\s*zoom-in/.test(zoom)
    && /outline-offset:\s*2px/.test(of(".img-zoom:focus-visible")), zoom);
  ok("單張:限高 280(圖 278 + 上下框)、width／height auto、max-width 100%", /max-height:\s*278px/.test(img) && /(^|;)\s*width:\s*auto/.test(img) && /(^|;)\s*height:\s*auto/.test(img) && /max-width:\s*100%/.test(img), img);
  ok("膠捲:原生橫捲、snap x mandatory、scroll-padding 4/24、overscroll contain、細捲軸;張間 8、內距 4", /overflow-x:\s*auto/.test(sc) && /scroll-snap-type:\s*x mandatory/.test(sc) && /scroll-padding-inline:\s*4px 24px/.test(sc)
    && /overscroll-behavior-x:\s*contain/.test(sc) && /scrollbar-width:\s*thin/.test(sc) && /gap:\s*var\(--space-8\)/.test(sc) && /padding:\s*var\(--space-4\)/.test(sc), sc);
  ok("膠捲每張:外框高 160(圖 158)、寬上限 = 膠捲寬 − 48、snap start", /height:\s*160px/.test(cell) && /max-width:\s*calc\(100% - var\(--space-48\)\)/.test(cell) && /scroll-snap-align:\s*start/.test(cell) && /height:\s*158px/.test(cimg), cell + " | " + cimg);
  ok("右緣淡出 24、不擋滑鼠、淡到聊天欄底色", /width:\s*24px/.test(fade) && /pointer-events:\s*none/.test(fade) && /var\(--surface-card\)/.test(fade), fade);
  const touched = rules.filter(([s, b]) => /\.msg\.img|\.img-zoom|\.img-strip/.test(s) && /(^|[;\s])(filter|backdrop-filter|opacity|mix-blend-mode)\s*:/.test(b)).map(([s]) => s);
  ok("附圖不上 filter／opacity／混色(圖裡的顏色是資料)", touched.length === 0, touched.join(" | "));
}
console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
