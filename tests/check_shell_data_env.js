// shell/main.js 的 syncDataEnv:workspace/.env 裡外殼自己那一塊的寫入與移除。
// 從 main.js 把函式原文切出來跑(它不依賴 electron,只吃 WS / loadDataKey 兩個外部名字),
// 邏輯壞掉這裡就紅。跑法:node tests/check_shell_data_env.js
const fs = require("fs"), os = require("os"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
const a = src.indexOf("const ENV_BEGIN"), b = src.indexOf("/* 登出 Blave:");
if (a < 0 || b < 0) { console.log("FAIL  找不到 syncDataEnv 的原文"); process.exit(1); }
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "blave-env-"));
let KEY = { api_key: "a".repeat(64), secret_key: "b".repeat(64) };
const loadDataKey = () => KEY;
// eval 裡的 const 出不了 eval 的作用域,換成 var 才拿得到 ENV_BEGIN / ENV_END / syncDataEnv
eval(src.slice(a, b).replace(/^const /gm, "var "));
const f = path.join(WS, ".env");
const rd = () => { try { return fs.readFileSync(f, "utf8"); } catch (_) { return null; } };
const BLOCK = `${ENV_BEGIN}\nblave_api_key=${KEY.api_key}\nblave_secret_key=${KEY.secret_key}\n${ENV_END}\n`;
let red = 0;
const t = (name, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) red++; };

t("沒檔、不要 key → 不建檔", syncDataEnv(false) === "none" && rd() === null);
t("要 key → 只寫自己那一塊", syncDataEnv(true) === "ours" && rd() === BLOCK);
t("權限 0600", (fs.statSync(f).mode & 0o777) === 0o600);
t("再跑一次不改檔", (() => { const m = fs.statSync(f).mtimeMs; syncDataEnv(true); return fs.statSync(f).mtimeMs === m; })());
t("不要 key、檔裡只有我們那塊 → 刪檔", syncDataEnv(false) === "none" && rd() === null);

const OWN = "BINANCE_API_KEY=x\nblave_api_key=USER_OWN\nblave_secret_key = USER_OWN\n";
fs.writeFileSync(f, OWN, { mode: 0o644 });
t("用戶自己的 blave_api_key 不動,我們那塊接在檔尾", syncDataEnv(true) === "ours" && rd() === OWN + BLOCK);
t("既有檔也收成 0600", (fs.statSync(f).mode & 0o777) === 0o600);
t("不要 key → 只拿掉我們那塊,用戶的原樣留著;他自己那組仍算有資料", syncDataEnv(false) === "own" && rd() === OWN);

fs.writeFileSync(f, "A=1\r\n" + BLOCK.replace(/\n/g, "\r\n") + "B=2\r\n");
t("CRLF 檔:拿得掉、其餘行還在", syncDataEnv(false) === "none" && /A=1/.test(rd()) && /B=2/.test(rd()) && !/blave_api_key/.test(rd()));

fs.writeFileSync(f, `A=1\n${ENV_BEGIN}\nblave_api_key=OLD\nblave_secret_key=OLD\n${ENV_END}\n`);
t("舊的一塊被新的取代,不會疊兩塊", syncDataEnv(true) === "ours" && rd() === "A=1\n" + BLOCK);

KEY = null;
t("要 key 但手上沒有 → false,而且把舊塊拿掉", syncDataEnv(true) === "none" && rd() === "A=1\n");
KEY = { api_key: "a".repeat(64), secret_key: "b".repeat(64) };

// 讀不到但不是 ENOENT(權限被拿掉):不能當成空檔往下寫——那會用我們兩行蓋掉放交易所 key 的檔。
// 用 chmod 000 的真檔測:目錄版的測法是空轉(rename 本來就會失敗,拿掉 ENOENT 判斷也照過)
fs.writeFileSync(f, "BINANCE_API_KEY=keep\n"); fs.chmodSync(f, 0o000);
const r = syncDataEnv(true);
fs.chmodSync(f, 0o600);
t("讀不到(非 ENOENT)→ 回 none、原檔一個字沒動", r === "none" && rd() === "BINANCE_API_KEY=keep\n");
t("沒留下暫存檔", !fs.existsSync(f + ".blave-tmp"));

// rename 失敗(.env 是個目錄):暫存檔裡是明文 key,要清掉
fs.rmSync(f); fs.mkdirSync(f);
syncDataEnv(true);
t("rename 失敗 → 暫存檔不留", !fs.existsSync(f + ".blave-tmp"));
fs.rmSync(WS, { recursive: true, force: true });
console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
