// 自動下單頁的空狀態(本機:說明 + 連接交易所;雲端:說明 + 前往工作頁)整塊要水平置中在中欄。
// 兩態共用 .pf-onboard 這一條規則,置中靠 margin 的左右 auto;把 auto 拿掉或被窄欄那組蓋掉,整塊就會貼邊。
// 跑法:node tests/check_shell_onboard_center.js
const fs = require("fs"), path = require("path");
const css = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.css"), "utf8");

let red = 0;
const ok = (name, c) => { console.log((c ? "PASS  " : "FAIL  ") + name); if (!c) red++; };

const rules = [...css.matchAll(/(^|\n)([^\n{}]*\.pf-onboard[^\n{}]*)\{([^}]*)\}/g)].map((m) => ({ sel: m[2].trim(), body: m[3] }));
ok("trade.css 裡有 .pf-onboard 的規則", rules.length > 0);
const base = rules.find((r) => /^\.pf-onboard$/.test(r.sel));
ok("有一條 .pf-onboard 本體規則", !!base);
if (base) {
  const m = base.body.match(/(?:^|;)\s*margin:\s*([^;]+)/);
  const parts = m ? m[1].trim().split(/\s+(?![^(]*\))/) : [];
  // margin 簡寫的左右值:兩個值 = [上下, 左右];三個 = [上, 左右, 下];四個 = [上, 右, 下, 左]
  const lr = parts.length === 1 ? [parts[0], parts[0]] : parts.length === 2 || parts.length === 3 ? [parts[1], parts[1]] : parts.length === 4 ? [parts[3], parts[1]] : [];
  ok("左右 margin 是 auto(整塊置中)", lr.length === 2 && lr.every((v) => v === "auto"));
  ok("有 max-width(置中才看得出來:滿寬的塊置不置中都一樣)", /max-width:/.test(base.body));
}
// 窄欄(視窗 1024)那組 container query 不可以再把它推到一邊
// 只看選到那個塊本身的(.pf-onboard 是選擇器的最後一段);.pf-onboard p 之類的後代不算
const narrow = rules.filter((r) => r !== base && r.sel.split(",").some((s) => /\.pf-onboard[^\s>+~]*$/.test(s.trim())));
ok("沒有別的規則覆寫 .pf-onboard 的 margin", !narrow.some((r) => /margin(-left|-right|-inline)?:/.test(r.body)));

console.log(red ? "\n" + red + " 紅" : "\nALL PASS");
process.exit(red ? 1 : 0);
