// 原生確認框一律帶 noLink: true(0.1.11 Windows 真機 e2e:下單中的更新確認框兩顆鈕被畫成「→ 取消」「→ 重新啟動以完成更新」命令連結)。
// Electron 在 Windows 上遇到自訂鈕名,預設把鈕改畫成命令連結,要 noLink 才是一般按鈕;macOS 忽略這個參數。
// 另釘 noLink 帶出來的兩件事:Windows 的鈕順序(stayGo)、暫停失敗框的鈕字依語言。
// 列舉 shell/ 底下(不含 node_modules)每一個 showMessageBox / showMessageBoxSync 呼叫,切出它的選項物件,逐一要求有 noLink: true;
// 呼叫點數量下限一起釘住,切不出來的寫法也算紅(不是「找到的都對」就過)。不開 Electron。跑法:node tests/check_shell_nolink.js
const fs = require("fs"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + d)); if (!c) red++; };

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? jsFiles(p) : e.name.endsWith(".js") ? [p] : [];
  });
}
// 從 i(開括號)切到對應的閉括號;字串裡的括號不算
function balanced(s, i, open, close) {
  let d = 0, q = null;
  for (let k = i; k < s.length; k++) {
    const ch = s[k];
    if (q) { if (ch === "\\") k++; else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; continue; }
    if (ch === open) d++; else if (ch === close && --d === 0) return s.slice(i, k + 1);
  }
  return null;
}
// 選項物件裡最外層那一層的 noLink(巢狀物件裡的不算)
function topLevelNoLink(obj) {
  let d = 0, q = null, flat = "";
  for (let k = 0; k < obj.length; k++) {
    const ch = obj[k];
    if (q) { if (ch === "\\") k++; else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; continue; }
    if (ch === "{" || ch === "[" || ch === "(") { d++; continue; }
    if (ch === "}" || ch === "]" || ch === ")") { d--; continue; }
    if (d === 1) flat += ch;
  }
  return /(^|[\s,])noLink\s*:\s*true\b/.test(flat);
}

const sites = [];
for (const f of jsFiles(SHELL)) {
  const s = fs.readFileSync(f, "utf8"), re = /\bshowMessageBox(?:Sync)?\s*\(/g;
  let m;
  while ((m = re.exec(s))) {
    const at = path.relative(SHELL, f) + ":" + (s.slice(0, m.index).split("\n").length);
    const call = balanced(s, m.index + m[0].length - 1, "(", ")");
    const j = call ? call.indexOf("{") : -1, obj = j >= 0 ? balanced(call, j, "{", "}") : null;
    sites.push({ at, obj });
  }
}
ok("找得到全部呼叫點(main.js 五處:暫停失敗、更新確認、搬到應用程式、結束攔截兩道)", sites.length >= 5, sites.length);
sites.forEach(({ at, obj }) => ok(at + " 帶 noLink: true", !!obj && topLevelNoLink(obj), obj ? obj.slice(0, 120) : "切不出選項物件"));

// 判準自己:沒帶、帶 false、只在巢狀物件裡帶,都要判紅
ok("判準:沒帶 → 紅", !topLevelNoLink('{ type: "warning", buttons: ["a", "b"] }'));
ok("判準:noLink: false → 紅", !topLevelNoLink('{ type: "warning", noLink: false }'));
ok("判準:巢狀裡的不算", !topLevelNoLink('{ type: "warning", x: { noLink: true } }'));
ok("判準:字串裡的不算", !topLevelNoLink('{ message: "noLink: true" }'));
ok("判準:最外層帶 true → 綠", topLevelNoLink('{ type: "warning", noLink: true, buttons: ["a"] }'));

// noLink 帶出來的兩件事(0.1.12 設計稽核):
// ① Windows 照陣列順序由左往右畫自訂鈕:「留下 / 動作」兩顆的框在 win32 要反過來(動作在左、取消在最右),預設與 Esc 跟著對到取消;macOS 不動
const { stayGo } = require("../shell/traytext.js");
const W = stayGo("win32", "STAY", "GO"), M = stayGo("darwin", "STAY", "GO"), X = stayGo("linux", "STAY", "GO");
ok("stayGo win32:[動作, 留下]、預設與 Esc = 1(留下)、goIndex 0", JSON.stringify(W) === JSON.stringify({ buttons: ["GO", "STAY"], defaultId: 1, cancelId: 1, goIndex: 0 }), JSON.stringify(W));
ok("stayGo macOS(及其他):[留下, 動作]、預設與 Esc = 0、goIndex 1——跟改之前一模一樣", [M, X].every((r) => JSON.stringify(r) === JSON.stringify({ buttons: ["STAY", "GO"], defaultId: 0, cancelId: 0, goIndex: 1 })), JSON.stringify(M));
const main = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
const twoBtn = sites.filter((x) => x.obj && /buttons:\s*\[?\s*(sg\.buttons|tmLabels\.quitStay)/.test(x.obj));
ok("兩顆鈕「取消 + 動作」的框(更新確認、結束攔截兩道)三處都走 stayGo,不再寫死陣列與 0/1", twoBtn.length === 3 && twoBtn.every((x) => /buttons: sg\.buttons, defaultId: sg\.defaultId, cancelId: sg\.cancelId/.test(x.obj))
  && (main.match(/const sg = TT\.stayGo\(process\.platform, tmLabels\.quitStay, tmLabels\.(updateReady|quitGo)\);/g) || []).length === 3, twoBtn.map((x) => x.at).join());
ok("…回傳值照 goIndex 判(不再寫死 response === 1 / !== 1)", (main.match(/r\.response (===|!==) sg\.goIndex/g) || []).length === 3 && [main.slice(main.indexOf("async function restartToUpdate("), main.indexOf("const moveDeclinedPath")), main.slice(main.indexOf('app.on("before-quit"'))]
  .every((x) => x.length > 200 && !/r\.response (===|!==) [01]\b/.test(x)));   // 搬到應用程式那一問只在 macOS 出現,照舊
// ② 暫停失敗那個框只有一顆鈕:noLink 之後它不再是系統翻譯的通用鈕,字由畫面依語言交(tm.ok),noLink 照留
const po = (l) => fs.readFileSync(path.join(SHELL, "i18n", l + ".po"), "utf8");
ok("暫停失敗框的鈕 = tmLabels.ok(tm.ok:zh「確定」、en「OK」),畫面交字、主行程有英文退路", /buttons: \[tmLabels\.ok\] \}\);/.test(main) && /quitStay: "Cancel", ok: "OK",/.test(main)
  && /msgid "tm\.ok"\nmsgstr "確定"/.test(po("zh")) && /msgid "tm\.ok"\nmsgstr "OK"/.test(po("en")) && /ok: t\("tm\.ok"\)/.test(fs.readFileSync(path.join(SHELL, "renderer", "trade.js"), "utf8")));

console.log(red ? `\n${red} FAIL` : "\nALL PASS");
process.exit(red ? 1 : 0);
