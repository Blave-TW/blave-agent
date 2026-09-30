// app 選單語言(macOS 頂部「檔案／編輯／顯示／視窗」):選單字由畫面交過來(renderer trPushLabels → ipc "trade-labels")。
// 以前 handler 掛在啟動步驟的最後,中間任何一步(遙測、更新、選單列…)拋例外,handler 就沒掛上,選單停在英文、其他畫面都正常。
//   1. 把 main.js whenReady 裡那段啟動序列切出來跑,讓遙測 / 更新 / 選單列各自拋例外:handler 照樣掛上、之後交來的字照樣重建選單
//   2. handler 先重建 app 選單再動選單列:選單列拋例外也不影響選單
//   3. handler 在 createWindow 之前掛好(畫面一載入就交字,不能早於 handler)
// 跑法:node tests/check_shell_menu_lang.js
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

const a = src.indexOf('  ipcMain.on("trade-labels", (e, labels) => {');
const b = src.indexOf('  startStep("min version gate", () => minGate().start());');
const si = src.indexOf("function startStep(");
const stepFn = si < 0 ? "" : src.slice(si, src.indexOf("\n", si));
ok("找得到啟動序列與 startStep", a > 0 && b > a && stepFn.length > 20);
const block = src.slice(a, src.indexOf("\n", b) + 1);
ok("handler 在 createWindow 之前掛好", block.indexOf('ipcMain.on("trade-labels"') < block.indexOf("createWindow();"));

function run(throwing) {
  const log = [], errors = [];
  const handlers = {};
  const env = {
    ipcMain: { on: (ch, fn) => { handlers[ch] = fn; } },
    fromOurPage: () => true, tmLabels: { menuFile: "", menuEdit: "", pause: "" }, uiLang: null,
    appMenuSync: () => { if (throwing.has("menu")) throw new Error("menu"); log.push("menu:" + env.tmLabels.menuFile); },
    traySync: () => { if (throwing.has("tray")) throw new Error("tray"); log.push("tray"); },
    createWindow: () => log.push("window"),
    app: { hasSingleInstanceLock: () => true, on: () => {} },
    syncOfficialOnUpdate: () => { if (throwing.has("sync")) throw new Error("sync"); },
    tradeStartIfReady: () => { if (throwing.has("trade")) throw new Error("trade"); },
    trayStart: () => { if (throwing.has("traystart")) throw new Error("traystart"); },
    accountStatus: () => { if (throwing.has("state")) throw new Error("state"); },
    tm: () => ({ start: () => { if (throwing.has("tm")) throw new Error("tm"); } }),
    updater: () => ({ start: () => { if (throwing.has("updater")) throw new Error("updater"); } }),
    minGate: () => ({ start: () => { if (throwing.has("gate")) throw new Error("gate"); } }),
    moveChecked: false, askMoveToApps: () => Promise.resolve(false),   // 0.1.10 搬到「應用程式」那一問(tests/check_shell_update_restart.js 另外測)
    console: { error: (m) => errors.push(m) },
  };
  const f = new Function("env", `with (env) { ${stepFn}\n${block}\n }`);
  try { f(env); } catch (e) { errors.push("uncaught: " + e.message); }
  const h = handlers["trade-labels"];
  if (h) h({}, { menuFile: "檔案", lang: "zh" });
  return { log, errors, registered: !!h, uiLang: env.uiLang };
}
let r = run(new Set());
ok("正常啟動:畫面交字後選單重建成中文", r.registered && r.log.includes("menu:檔案"), r);
r = run(new Set(["tm", "updater", "traystart", "sync", "trade", "gate", "state"]));
ok("遙測 / 更新 / 選單列 / 工作區同步 / 常駐程式 / 版本閘 / app 現況回報都拋例外:handler 照樣掛上、選單照樣變中文,錯誤各記一行",
  r.registered && r.log.includes("menu:檔案") && r.errors.length === 7 && r.errors.every((e) => /^\[startup\] .+ failed/.test(e)), r);
r = run(new Set(["tray"]));
ok("選單列(traySync)拋例外:選單照樣先重建成中文", r.log.includes("menu:檔案") && r.errors.some((e) => /tray failed/.test(e)), r);
console.log(red ? `\n${red} FAILED` : "\nALL PASS");
process.exit(red ? 1 : 0);
