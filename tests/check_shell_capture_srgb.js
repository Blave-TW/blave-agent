// 引用圖的顏色(0.1.8 之後的小債):展開在中欄的分頁,CDP 拍回來的是顯示器色彩空間的值,P3 螢幕上 sRGB 的 #f00 變成 234/51/35;
// 存出去的 PNG / JPEG 不帶色彩設定檔,看的人當 sRGB,顏色就偏了。存之前轉回 sRGB。
//   ① 數學:P3 值轉回 sRGB(紅、綠、藍原色、灰階、黑白;alpha 不動)
//   ② 認哪一種顯示器:只有 Chromium 對標準 Display P3 印出來的那一種;sRGB、自訂原色、HDR、讀不到都不轉
//   ③ 接線:只在展開在中欄拍的那一張轉、在縮小與編碼之前(PNG 與退成 JPEG 都吃到);顯示器色彩空間由 index.js 從 screen 拿
// 不開 Electron。P3 螢幕上實拍(展開 / 停在視窗外各一張,讀存下來的 #f00)要開視窗,不在這支。
// 跑法:node tests/check_shell_capture_srgb.js
const path = require("path"), fs = require("fs");
const B = path.join(__dirname, "..", "shell", "browser");
const { p3ToSrgb, displayIsP3 } = require(path.join(B, "capture.js"));
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + JSON.stringify(d))); if (!c) red++; };

// BGRA,一個像素四個位元組
const px = (list) => Buffer.from(list.flatMap(([r, g, b, a]) => [b, g, r, a === undefined ? 255 : a]));
const rgb = (bm) => { const out = []; for (let i = 0; i < bm.length; i += 4) out.push([bm[i + 2], bm[i + 1], bm[i], bm[i + 3]]); return out; };
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
const got = rgb(p3ToSrgb(px([[234, 51, 35], [117, 251, 76], [0, 0, 245], [128, 128, 128], [0, 0, 0], [255, 255, 255], [60, 60, 60, 128]])));
ok("① sRGB 的紅在 P3 拍成 234/51/35 → 轉回 255/0/0", near(got[0], [255, 0, 0, 255]), got[0]);
ok("① sRGB 的綠(P3 117/251/76)→ 綠為主、紅藍接近 0", got[1][1] === 255 && got[1][0] <= 4 && got[1][2] <= 1, got[1]);
ok("① 藍在兩組原色裡同一個點(P3 的藍 = sRGB 的藍)→ 只剩藍", got[2][0] <= 1 && got[2][1] <= 1 && got[2][2] >= 250, got[2]);
ok("① 灰階、黑、白不變;alpha 不動", near(got[3], [128, 128, 128, 255]) && near(got[4], [0, 0, 0, 255]) && near(got[5], [255, 255, 255, 255]) && near(got[6], [60, 60, 60, 128]), got.slice(3));

const P3 = "{primaries:P3, transfer:SRGB, matrix:RGB, range:FULL}";
ok("② 標準 Display P3 → 轉", displayIsP3(P3) === true);
for (const [what, cs] of [["sRGB 顯示器", "{primaries:BT709, transfer:SRGB, matrix:RGB, range:FULL}"], ["P3 原色但 HDR 曲線", "{primaries:P3, transfer:SRGB_HDR, matrix:RGB, range:FULL}"],
  ["校色過的自訂原色", "{r:[0.6810, 0.3190], g:[0.2640, 0.6900], b:[0.1500, 0.0600], wp:[0.3127, 0.3290]}, transfer:SRGB, matrix:RGB, range:FULL}"],
  ["讀不到(null)", null], ["空字串", ""], ["不是字串", 5]]) ok("② " + what + " → 不轉(照原樣存)", displayIsP3(cs) === false, cs);

const cap = fs.readFileSync(path.join(B, "capture.js"), "utf8"), idx = fs.readFileSync(path.join(B, "index.js"), "utf8");
const conv = cap.indexOf("if (onScreen && displayIsP3(d.colorSpace ? d.colorSpace() : null))"), resize = cap.indexOf("if (img.getSize().width > want) img = img.resize("), png = cap.indexOf("let buf = img.toPNG()");
ok("③ 轉換在縮小與編碼之前(PNG 與退成 JPEG 都吃到),只在展開在中欄拍的那一張", conv > 0 && conv < resize && resize < png
  && (cap.match(/onScreen = t\.id === d\.expanded\(\);\n\s*got = await shoot\(\);/g) || []).length === 2 && /if \(t\.id === d\.expanded\(\)\) return fn\(\);/.test(cap), [conv, resize, png]);
ok("③ 轉不了就照原樣存,不擋這張圖", /createFromBitmap\(p3ToSrgb\(img\.toBitmap\(\)\), \{ width: s0\.width, height: s0\.height \}\); \}\n\s*catch \(_\) \{/.test(cap));
ok("③ index.js 把視窗所在顯示器的色彩空間交給擷取(拿不到 → null)", /colorSpace: \(\) => \{ try \{ const w = o\.getWin && o\.getWin\(\); return w && E\.screen \? E\.screen\.getDisplayMatching\(w\.getBounds\(\)\)\.colorSpace : null; \} catch \(_\) \{ return null; \} \},/.test(idx));

console.log(red ? `\n${red} FAILED` : "\nALL PASS");
process.exit(red ? 1 : 0);
