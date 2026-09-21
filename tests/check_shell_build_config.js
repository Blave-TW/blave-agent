// shell 的打包設定與 hook 不准寫死任何憑證材料:Key ID、Issuer UUID、.p8 路徑、Team ID / 憑證名、
// 家目錄絕對路徑——全部只能從環境變數來。跑法:node tests/check_shell_build_config.js
const fs = require("fs"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const FILES = ["electron-builder.config.js", "package.json", "tools/sign-python.js", "tools/notarize-dmg.js",
  "build/entitlements.mac.plist", "build/entitlements.mac.inherit.plist", "build/entitlements.python.plist"];
const BANNED = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "UUID(Issuer ID 長這樣)"],
  [/AuthKey_|\.p8\b/, ".p8 金鑰檔名 / 路徑"],
  [/\(\s*[A-Z0-9]{10}\s*\)|Developer ID Application: [^$`"']/, "寫死的憑證名 / Team ID"],
  [/\/Users\/|~\//, "家目錄路徑"],
  [/(KEY_ID|ISSUER|IDENTITY)\w*["']?\s*[:=]\s*["'][^"'<]+["']/, "憑證變數被指派了字面值"],
  [/-----BEGIN/, "金鑰內容"],
];
let red = 0;
for (const f of FILES) {
  const p = path.join(SHELL, f);
  if (!fs.existsSync(p)) { console.log("FAIL  " + f + " 不在"); red++; continue; }
  const src = fs.readFileSync(p, "utf8");
  const hits = BANNED.filter(([re]) => re.test(src)).map(([, why]) => why);
  console.log((hits.length ? "FAIL  " : "PASS  ") + f + (hits.length ? " → " + hits.join("、") : ""));
  red += hits.length;
}
const cfg = fs.readFileSync(path.join(SHELL, "electron-builder.config.js"), "utf8");
for (const v of ["BLAVE_MAC_IDENTITY", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) {
  const ok = cfg.includes("process.env." + v);
  console.log((ok ? "PASS  " : "FAIL  ") + "config 從 process.env." + v + " 讀"); if (!ok) red++;
}
// 選單列圖示:檔案缺了 Tray 是看不見的空圖、不丟錯(稽核 M4)——圖要在、也要被打進包
for (const [ok, what] of [[/files:\s*\[[^\]]*"assets\/\*\*\/\*"/.test(cfg), "files 含 assets/**/*"],
  ...["trayTemplate.png", "trayTemplate@2x.png"].map((f) => [fs.existsSync(path.join(SHELL, "assets", f)), "assets/" + f + " 在"])]) {
  console.log((ok ? "PASS  " : "FAIL  ") + what); if (!ok) red++;
}
process.exit(red ? 1 : 0);
