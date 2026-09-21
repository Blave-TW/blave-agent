// 電腦版安全修正批的不變量(安全稽核 M1、R4、R5、R9;Electron 44 的通知行為):
//   外開網址白名單、網頁權限全拒(只留自家頁面寫剪貼簿)、通知失敗要留 log(呈現路徑在 check_shell_bn_notify.js)、
//   ~/Blave 建立時 0700、Electron 主線與最低系統版本、安裝識別碼。
// 跑法:node tests/check_shell_hardening.js
const fs = require("fs"), path = require("path"), vm = require("vm");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const S = path.join(__dirname, "..", "shell");
const mainSrc = fs.readFileSync(path.join(S, "main.js"), "utf8"), main = mainSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const cut = (src, name) => { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("unbalanced " + name); };

// ── R4:外開網址白名單 ──
{ const hosts = /const EXTERNAL_HOSTS = (\[[^\]]*\]);/.exec(mainSrc)[1];
  const externalUrl = vm.runInNewContext("const EXTERNAL_HOSTS = " + hosts + "; (" + cut(mainSrc, "externalUrl") + ")", { URL });
  t("放行:blave.org 與子網域、K 線圖依授權放的那顆標誌", ["https://blave.org/agent/zh/usage?from=desktop#topup", "https://blave.org/zh", "https://download.blave.org/desktop/mac/Blave-arm64.dmg", "https://www.tradingview.com/?utm_source=x"].every((u) => externalUrl(u) === new URL(u).href));
  t("不放行:別的網域、長得像的網域、http、帶帳密、怪 port、非網址、其他 scheme", ["https://evil.example/", "https://blave.org.evil.example/", "https://evilblave.org/", "https://notblave.org/", "http://blave.org/", "https://user:pw@blave.org/", "https://blave.org:8443/", "https://blave.org@evil.example/", "file:///etc/passwd", "javascript:alert(1)", "blave.org", "", null, undefined, 5, {}].every((u) => externalUrl(u) === null));
  t("三個入口都走白名單(IPC、window.open、will-navigate);沒有剩下的 /^https:/ 直通", (main.match(/openExternalSafe\(/g) || []).length >= 4 && !/\/\^https:\\\/\\\/\/\.test\(url\)\) shell\.openExternal/.test(main)
    && /handle\("open-external", \(_e, url\) => openExternalSafe\(url\), false\);/.test(main)); }

// ── R5:網頁權限 ──
t("權限請求與權限檢查都掛了 handler,只放自家頁面的 clipboard-sanitized-write", /setPermissionRequestHandler\(/.test(main) && /setPermissionCheckHandler\(/.test(main)
  && /const permOk = \(wc, perm, url\) => perm === "clipboard-sanitized-write" && isOurPageUrl\(/.test(main));

// ── Electron 44:通知失敗不可以無聲 ──
{ const sends = (main.match(/new Notification\(/g) || []).length, watched = (main.match(/notifWatch\(/g) || []).length - 1;   // 扣掉定義那一個
  t("每一個 new Notification 都掛了 failed 的 log(沒簽章的包、用戶關掉通知時,通知只會 failed)", sends === 4 && watched === sends && /function notifWatch\(n, what\) \{ n\.on\("failed"/.test(main)); }

// ── R9:~/Blave 建立時 0700 ──
t("~/Blave 由 app 建立時是 0700(既有目錄不動)", /if \(!fs\.existsSync\(BASE\)\) fs\.mkdirSync\(BASE, \{ recursive: true, mode: 0o700 \}\);\s*fs\.mkdirSync\(WS, \{ recursive: true \}\);/.test(main));

// ── M1:Electron 主線、Node 下限、最低系統 ──
{ const pkg = JSON.parse(fs.readFileSync(path.join(S, "package.json"), "utf8")), lock = JSON.parse(fs.readFileSync(path.join(S, "package-lock.json"), "utf8"));
  const major = Number(String(pkg.devDependencies.electron).split(".")[0]);
  t("Electron 釘在 44 以上的確切版本(38 已 EOL),lockfile 跟上", /^\d+\.\d+\.\d+$/.test(pkg.devDependencies.electron) && major >= 44 && lock.packages["node_modules/electron"].version === pkg.devDependencies.electron);
  t("Node 下限寫進 engines 與 .nvmrc(electron ≥41 的 npm 套件要 Node ≥22.12)", pkg.engines && pkg.engines.node === ">=22.12.0" && fs.readFileSync(path.join(S, ".nvmrc"), "utf8").trim() === "24");
  const cfgSrc = fs.readFileSync(path.join(S, "electron-builder.config.js"), "utf8");
  t("最低系統 macOS 13 明寫進打包設定(Electron 44 不支援 12)", /minimumSystemVersion: "13\.0"/.test(cfgSrc)); }

// ── 安裝識別碼(隱私權政策:來信附上它要求刪除)──
{ const app = fs.readFileSync(path.join(S, "renderer", "app.js"), "utf8"), pre = fs.readFileSync(path.join(S, "preload.js"), "utf8"), str = fs.readFileSync(path.join(S, "renderer", "strings.js"), "utf8");
  t("IPC 過 fromOurPage(handle);preload 只暴露固定函式", /handle\("telemetry-install-id", \(\) => tm\(\)\.installId\(\)\);/.test(main) && /telemetryInstallId: \(\) => ipcRenderer\.invoke\("telemetry-install-id"\)/.test(pre));
  t("畫面只收 UUID 的形狀、用 textContent 畫、追蹤關掉也看得到(不看 PRIV)", /PRIV_ID = typeof id === "string" && \/\^\[0-9a-f\]\{8\}/.test(app) && /if \(PRIV_ID\) \{/.test(app) && !/if \(PRIV_ID && PRIV\)/.test(app) && /mk\("code", "priv-idv", PRIV_ID\)/.test(app));
  t("叫法統一:「安裝識別碼」/ Installation ID;舊的「隨機編號」當名稱的寫法不在了", /"priv\.id": "安裝識別碼"/.test(str) && /"priv\.id": "Installation ID"/.test(str) && !/這份安裝的隨機編號/.test(str)); }

console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
