// app 選單在 Electron 裡真的建出來之後(Menu.buildFromTemplate → setApplicationMenu → getApplicationMenu)長什麼樣。
// 0.0.4 的「顯示」有兩個「Toggle Full Screen」(🌐F 與 ⌃⌘F):帶 togglefullscreen role 的那一格,macOS 26 會在同一個選單再插一份自己的。
// 系統插的那份不在 Electron 的選單模型裡(這支量不到它),所以這裡守的是「根因不回來」:整份選單沒有任何全螢幕的 role、
// 全螢幕的字只出現一次、是自己的 click + ⌃⌘F。系統那份不再出現是 09-24 在 macOS 26 截圖實測的(zh / en、視窗選單都看過)。
// 另外逐語言(zh / en)、全螢幕前後各建一次:每一格都有字、沒有英文漏網、字跟著狀態換。
// 跑法:node tests/check_shell_app_menu.js(找不到 shell/node_modules 的 Electron 就 SKIP)
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");

if (!process.versions.electron) {
  const bin = path.join(SHELL, "node_modules", ".bin", "electron");
  if (!fs.existsSync(bin)) { console.log("SKIP  找不到 shell/node_modules 的 Electron(先 cd shell && npm install)"); process.exit(0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  process.exit(r.status == null ? 1 : r.status);
}

const { app, Menu } = require("electron");
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };
setTimeout(() => { console.log("FAIL  逾時(30 秒)"); process.exit(1); }, 30000).unref();

const src = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
const cut = (a, b) => { const i = src.indexOf(a); return src.slice(i, src.indexOf(b, i)); };
const MENU_EN = eval("(" + cut("const MENU_EN = ", " };\n").replace("const MENU_EN = ", "") + " })");
const appMenuTemplate = eval("(" + cut("function appMenuTemplate", "\nfunction appMenuSync") + ")");
const labelsOf = (lang) => {
  const po = fs.readFileSync(path.join(SHELL, "i18n", lang + ".po"), "utf8"), L = {};
  for (const m of po.matchAll(/msgid "menu\.([A-Za-z]+)"\nmsgstr "([^"]*)"/g)) L["menu" + m[1][0].toUpperCase() + m[1].slice(1)] = m[2];
  return L;
};
// 逐格攤平 getApplicationMenu():{ label, role, accel, click, top }
const flat = () => { const out = []; const walk = (m, top) => m.items.forEach((x) => { if (x.type !== "separator") out.push({ label: x.label, role: x.role || "", accel: x.accelerator || "", click: x.click, top, sub: !!x.submenu }); if (x.submenu) walk(x.submenu, false); }); walk(Menu.getApplicationMenu(), true); return out; };
const FULL = /全螢幕|full ?screen/i;

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  let fullHits = 0; const onFull = () => { fullHits++; };
  for (const lang of ["zh", "en"]) {
    for (const full of [false, true]) {
      const L = labelsOf(lang);
      Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(L, false, full, () => {}, () => {}, onFull)));
      const items = flat(), tag = `${lang} ${full ? "全螢幕中" : "視窗"}`;
      const fsRoles = items.filter((x) => /fullscreen/i.test(x.role)), fsLabels = items.filter((x) => FULL.test(x.label || ""));
      ok(`${tag}:整份選單沒有全螢幕的 role(${fsRoles.map((x) => x.role).join() || "0"})`, fsRoles.length === 0);
      ok(`${tag}:全螢幕的字只出現一次、在「顯示」底下、⌃⌘F`, fsLabels.length === 1 && fsLabels[0].accel === "Ctrl+Cmd+F" && !fsLabels[0].top
        && Menu.getApplicationMenu().items[3].submenu.items.some((x) => FULL.test(x.label)));
      ok(`${tag}:那一格的字 = ${L[full ? "menuFullExit" : "menuFullEnter"]}`, fsLabels.length === 1 && fsLabels[0].label === L[full ? "menuFullExit" : "menuFullEnter"]);
      const named = items.filter((x, i) => !(i === 0 && x.top));
      ok(`${tag}:除了 app 名稱那一格,每一格都有字,而且都來自 ${lang}.po`, named.every((x) => x.label && Object.values(L).includes(x.label)));
      if (lang === "zh") ok(`${tag}:沒有英文漏網(Substitutions / Speech / Toggle 那種)`, named.every((x) => !/[A-Za-z]{3,}/.test(x.label.replace(/Blave/g, ""))));
    }
  }
  const item = flat().find((x) => FULL.test(x.label || "")); item.click();
  ok("按那一格 = 叫自己的切換(不靠 role 的 selector)", fullHits === 1);
  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
