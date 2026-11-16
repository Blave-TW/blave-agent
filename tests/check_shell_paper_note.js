// 改壞不會被別的測試抓到的版面(spec uiux-batch1 第 9 項):
//   聊天附圖(app.css .msg.img):圖高上限 480、套表單卡的殼(--cf-bg／--cf-border);圖裡的顏色是資料,不准上 filter／opacity／混色
//   (第 11 項「模擬怎麼成交？」展開內文:電腦版連接框 0.1.53 案一已拿掉那一列,沒有家,這支不再驗)
// 跑法:node tests/check_shell_paper_note.js(不開 Electron,只讀原文)
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
let red = 0; const ok = (n, c, why) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || !why ? "" : "  " + why)); if (!c) red++; };

{ const css = fs.readFileSync(path.join(R, "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
  const of = (sel) => rules.filter(([s]) => s.split(",").some((x) => x.trim() === sel)).map(([, b]) => b).join(";");
  const fig = of(".msg.img"), img = of(".msg.img img");
  ok("附圖的殼 = 表單卡那一組:--cf-bg、1px --cf-border、md 角、內距 12 含框", /background:\s*var\(--cf-bg\)/.test(fig) && /border:\s*1px solid var\(--cf-border\)/.test(fig) && /border-radius:\s*var\(--radius-md\)/.test(fig) && /padding:\s*calc\(var\(--space-12\) - 1px\)/.test(fig), fig);
  ok("圖:高上限 480、width／height auto(限高不變形)、max-width 100%、圓角 micro", /max-height:\s*480px/.test(img) && /(^|;)\s*width:\s*auto/.test(img) && /(^|;)\s*height:\s*auto/.test(img) && /max-width:\s*100%/.test(img) && /border-radius:\s*var\(--radius-micro\)/.test(img), img);
  const touched = rules.filter(([s, b]) => /\.msg\.img|\.img-zoom/.test(s) && /(^|[;\s])(filter|backdrop-filter|opacity|mix-blend-mode)\s*:/.test(b)).map(([s]) => s);
  ok("附圖不上 filter／opacity／混色(圖裡的顏色是資料)", touched.length === 0, touched.join(" | "));
}
console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
