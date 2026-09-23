// 選單列圖示(shell/assets/trayTemplate.png 與 @2x):鎖設計師 spec-desktop-update-experience-v2 §6 的數字。
// 兩張都從母檔向量 .claude/brand-assets/mark.svg 的 path 重新點陣化(不是互相縮放):
//   1x 18×18,translate(1,-1) scale(0.0888889) → 字形 16×12,上 / 下 3 / 3,左 / 右 1 / 1
//   2x 36×36,translate(2,-3) scale(0.1777778) → 字形 32×24(1x 的精確兩倍),上 / 下 5 / 7,左 / 右 2 / 2
// 2x 比 bbox 置中再往上抬 1px(0.5pt)是**光學補償**:字形下半是實心長條、上面只有右邊一座塔,重心在 bbox 中心下方,
// 純置中讀起來還是偏低(Wei 兩次說「低」的剩餘原因);1x 抬不了半格,維持 3 / 3。
// template 圖的前提:只有黑色 + alpha(macOS 依選單列明暗上色),檔名 *Template.png。
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
const SPEC = [["trayTemplate.png", 18, { w: 16, h: 12, top: 3, bottom: 3, left: 1, right: 1 }], ["trayTemplate@2x.png", 36, { w: 32, h: 24, top: 5, bottom: 7, left: 2, right: 2 }]];
SPEC.forEach(([f, size, want]) => {
  const img = readPng(path.join(dir, f)), b = bbox(img), gw = size - b.left - b.right, gh = size - b.top - b.bottom;
  ok(f + ":畫布 " + size + "×" + size + "、有字形、只有黑色 + alpha(template 圖)", img.w === size && img.h === size && !b.empty && b.onlyBlack);
  ok(f + ":字形 " + gw + "×" + gh + "(要 " + want.w + "×" + want.h + ")", gw === want.w && gh === want.h);
  ok(f + ":留白 上 " + b.top + " / 下 " + b.bottom + " / 左 " + b.left + " / 右 " + b.right + "(要 " + [want.top, want.bottom, want.left, want.right].join(" / ") + ")",
    b.top === want.top && b.bottom === want.bottom && b.left === want.left && b.right === want.right);
});
/* 形狀探針(稽核的測試缺口 ①:只鎖外框的話,一張純色矩形也會全綠)。取字形語意上必然的三點:
   左上是負空間(浪之上)必須透明;右上那座塔必須不透明;下半實心帶必須不透明。座標是 1x,2x 取兩倍 */
const PROBES = [[[3, 4], 0], [[14, 5], 255], [[9, 13], 255], [[2, 12], 255]];
SPEC.forEach(([f, size]) => {
  const img = readPng(path.join(dir, f)), k = size / 18;
  const miss = PROBES.filter(([[x, y], want]) => { const a = img.px[((y * k) * img.w + x * k) * 4 + 3]; return want === 0 ? a !== 0 : a < 200; });
  ok(f + ":形狀探針(左上負空間透明、右上塔與下半實心帶不透明)" + (miss.length ? ":" + JSON.stringify(miss.map((m) => m[0])) : ""), miss.length === 0);
});
ok("main.js 用的就是這個 template 檔名(Template 結尾 = macOS 自動上色)", /nativeImage\.createFromPath\(path\.join\(__dirname, "assets", "trayTemplate\.png"\)\)/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8")));
console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
