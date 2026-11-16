// shell/main.js 的隱藏視窗開關(BLAVE_HEADLESS=1):開發版專用,打包版設了也無效。
//   ① headlessOn(純函式,從 main.js 把原文切出來跑,不依賴 Electron)
//   ② 原文鎖:開關只綁 app.isPackaged;會把主視窗顯示出來 / 搶前景的地方都看它
// 跑法:node tests/check_shell_headless.js
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
const fnSrc = (src.match(/^function headlessOn\(env, isPackaged\) \{[^\n]*\}$/m) || [])[0];
if (!fnSrc) { console.log("FAIL  找不到 headlessOn 的原文"); process.exit(1); }
const headlessOn = eval("(" + fnSrc + ")");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const ON = { BLAVE_HEADLESS: "1" };

t("開發版 + 開 → 隱藏", headlessOn(ON, false) === true);
t("開發版 + 沒開 → 不變(沒設、空字串、設成 1 以外的值都算沒開)", [{}, { BLAVE_HEADLESS: "" }, { BLAVE_HEADLESS: "0" }, { BLAVE_HEADLESS: "true" }, null, undefined].every((e) => headlessOn(e, false) === false));
t("打包版 + 開 → 不變", headlessOn(ON, true) === false);
t("打包版 + 沒開 → 不變", headlessOn({}, true) === false);

t("開關只算一次,綁的是 app.isPackaged(不是別的打包判斷)", /^const HEADLESS = headlessOn\(process\.env, app\.isPackaged\);$/m.test(src) && (src.match(/headlessOn\(/g) || []).length === 2);
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
t("整支只有這一處讀 BLAVE_HEADLESS,只跟 \"1\" 比", (code.match(/BLAVE_HEADLESS/g) || []).length === 1 && fnSrc.includes('env.BLAVE_HEADLESS === "1"'));
t("不進 Dock", /^if \(HEADLESS && app\.dock\) app\.dock\.hide\(\);$/m.test(src));
const cw = src.slice(src.indexOf("function createWindow() {"), src.indexOf("app.whenReady().then("));
// 0.1.55 起主視窗一律 show:false 建好、畫出第一格才顯示(shell/bootguard.js showWhenReady;tests/check_shell_bootguard.js)。
// 隱藏模式的不變式改由這裡守:顯示的那條路只在不是 HEADLESS 時掛上,createWindow 自己不 show / focus
t("主視窗:一律 show:false 建好;顯示的路(showWhenReady)只在 !HEADLESS 時掛;隱藏模式背景不節流",
  cw.includes("show: false, paintWhenInitiallyHidden: true,") && cw.includes("...(HEADLESS ? { backgroundThrottling: false } : {}),")
  && /\n  if \(!HEADLESS && !bgBoot\) require\("\.\/bootguard"\)\.showWhenReady\(win,/.test(cw) && (cw.match(/showWhenReady\(/g) || []).length === 1
  && !/\bshow: (?!false, paintWhenInitiallyHidden)/.test(cw) && !/\.show\(|showInactive|\.focus\(/.test(cw));
t("showWhenReady 只在 ready-to-show／保底時 show,不 focus、不 moveTop", (() => { const g = fs.readFileSync(path.join(__dirname, "..", "shell", "bootguard.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); return (g.match(/\.show\(\)/g) || []).length === 1 && !/\.focus\(|moveTop|showInactive|app\.focus/.test(g); })());
const sm = src.slice(src.indexOf("function showMain() {"), src.indexOf("async function pauseFromMenu()"));
t("showMain:隱藏模式在 show / focus 之前就返回(視窗不在時照樣建)", /if \(!w\) \{ createWindow\(\); return; \}\n  if \(HEADLESS\) return;\n  if \(w\.isMinimized\(\)\) w\.restore\(\); w\.show\(\); w\.focus\(\);/.test(sm));
// 主行程裡把主視窗叫出來的路只有 showMain 一條:多一處 .show() / app.focus 就要有人看過它在隱藏模式下會不會冒出來
t("主視窗的 w.show() 只在 showMain;其餘 .show() 都是系統通知", (code.match(/\bw(in)?\.show\(\)/g) || []).length === 1 && sm.includes("w.show()"));
t("app.focus 只有一處,而且隱藏模式不叫", (code.match(/app\.focus\(/g) || []).length === 1 && /^  if \(!HEADLESS && loginFocus\(forBlaveAi, s\) === "steal"\) app\.focus\(\{ steal: true \}\);$/m.test(src));
t("沒有 moveTop / showInactive / dock.show / dock.bounce 這類別的路", !/\.moveTop\(|\.showInactive\(|dock\.show\(|dock\.bounce\(|setAlwaysOnTop\(/.test(code));

console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
