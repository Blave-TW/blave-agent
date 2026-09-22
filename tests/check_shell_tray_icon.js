// 選單列圖示(shell/assets/trayTemplate.png 與 @2x):字形在畫布裡垂直置中,上下留白差 ≤ 1px(Wei 09-22:圖示比旁邊的系統圖示低)。
// 同時守住 template 圖的前提:只有黑色 + alpha(macOS 依選單列明暗自己上色),畫布 1x 18px / 2x 36px。
// 不靠 npm 套件:用 zlib 解 PNG(8-bit RGBA、不交錯),逐列反 filter 後找 alpha > 0 的外框。
// 跑法:node tests/check_shell_tray_icon.js
const fs = require("fs"), path = require("path"), zlib = require("zlib");
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };

function readPng(file) {
  const d = fs.readFileSync(file);
  if (d.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG: " + file);
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0, inter = 0; const idat = [];
  while (p < d.length) {
    const len = d.readUInt32BE(p), type = d.toString("ascii", p + 4, p + 8), body = d.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; ctype = body[9]; inter = body[12]; }
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (depth !== 8 || ctype !== 6 || inter !== 0) throw new Error("expect 8-bit RGBA non-interlaced: " + file);
  const raw = zlib.inflateSync(Buffer.concat(idat)), bpp = 4, stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      px[y * stride + x] = (src[x] + pred) & 255;
    }
  }
  return { w, h, px };
}
function bbox({ w, h, px }) {
  let top = h, bottom = -1, left = w, right = -1, onlyBlack = true;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (!px[i + 3]) continue;
    if (px[i] || px[i + 1] || px[i + 2]) onlyBlack = false;
    top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x);
  }
  return { top, bottom: h - 1 - bottom, left, right: w - 1 - right, onlyBlack, empty: bottom < 0 };
}
const dir = path.join(__dirname, "..", "shell", "assets");
[["trayTemplate.png", 18], ["trayTemplate@2x.png", 36]].forEach(([f, size]) => {
  const img = readPng(path.join(dir, f)), b = bbox(img);
  ok(f + ":畫布 " + size + "×" + size + "、有字形、只有黑色 + alpha(template 圖)", img.w === size && img.h === size && !b.empty && b.onlyBlack);
  ok(f + ":垂直置中,上 " + b.top + "px / 下 " + b.bottom + "px(差 ≤ 1)", Math.abs(b.top - b.bottom) <= 1);
});
ok("main.js 用的就是這個 template 檔名(Template 結尾 = macOS 自動上色)", /nativeImage\.createFromPath\(path\.join\(__dirname, "assets", "trayTemplate\.png"\)\)/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8")));
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
