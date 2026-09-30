// app 的現況隨 account_status 帶給 api(0.1.10;api 端 openclaw/desktop_telemetry.state_from_headers):
// 使用事件開關 + 現在連的是哪個 AI + 本機有沒有回測過。關掉只送 off、其他都不送;沒登入不打;
// 切換開關、登入完成、開 app、換／清 AI 的當下各打一次。
// 不開視窗:純函式直接跑,main.js 的接線用原始碼比對。跑法:node tests/check_shell_app_state.js
const fs = require("fs"), path = require("path");
const os = require("os");
const { statusHeaders, anyBacktest } = require("../shell/telemetry.js");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

t("關掉:只有 off,不帶 engine / progress(連著哪個 AI、回測過沒有都一樣)",
  ["blave", "claude", "codex", null].every((k) => [true, false].every((bt) => same(statusHeaders(false, k, bt), { "X-Blave-Telemetry": "off" }))));
t("開著:帶現在連的 AI 與回測過沒有", ["blave", "claude", "codex"].every((k) =>
  same(statusHeaders(true, k, false), { "X-Blave-Telemetry": "on", "X-Blave-Engine": k, "X-Blave-Progress": "none" })
  && same(statusHeaders(true, k, true), { "X-Blave-Telemetry": "on", "X-Blave-Engine": k, "X-Blave-Progress": "bt" })));
t("開著但沒連任何 AI / 認不得的值:engine=none,不把原字送出去",
  [null, undefined, "", "/usr/local/bin/claude", "Claude", {}].every((k) => statusHeaders(true, k, false)["X-Blave-Engine"] === "none"));
t("開關、回測都只認字面上的 true", ["true", 1, null, undefined].every((v) => statusHeaders(v, "claude", true)["X-Blave-Telemetry"] === "off" && statusHeaders(true, "claude", v)["X-Blave-Progress"] === "none"));
t("只有這三個 header,值都是列舉", [statusHeaders(true, "codex", true), statusHeaders(false)].every((h) =>
  Object.keys(h).every((k) => ["X-Blave-Telemetry", "X-Blave-Engine", "X-Blave-Progress"].includes(k))
  && ["on", "off"].includes(h["X-Blave-Telemetry"]) && (!("X-Blave-Engine" in h) || ["blave", "claude", "codex", "none"].includes(h["X-Blave-Engine"]))
  && (!("X-Blave-Progress" in h) || ["bt", "none"].includes(h["X-Blave-Progress"]))));

// anyBacktest:strategies/<name>/stats.json 任一支存在就算;沒目錄、只有策略碼、同名檔案不是資料夾都不算
const sd = fs.mkdtempSync(path.join(os.tmpdir(), "blave-bt-"));
const noDir = anyBacktest(path.join(sd, "nope"));
fs.mkdirSync(path.join(sd, "a")); fs.writeFileSync(path.join(sd, "a", "strategy.py"), "");
fs.writeFileSync(path.join(sd, "stats.json"), "{}");
const onlyCode = anyBacktest(sd);
fs.mkdirSync(path.join(sd, "b")); fs.writeFileSync(path.join(sd, "b", "stats.json"), "{}");
t("anyBacktest:沒目錄 false、只有策略碼 false、有一支 stats.json 就 true", noDir === false && onlyCode === false && anyBacktest(sd) === true);

const main = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
const fnStart = main.indexOf("async function accountStatus()");
const fn = main.slice(fnStart, main.indexOf("\n}\n", fnStart));
t("accountStatus 帶上 statusHeaders(開關來源是 telemetry 的 isEnabled、engine 來自連結紀錄的 kind、回測看 strategies)",
  /const conn = loadConnection\(\), on = tm\(\)\.isEnabled\(\)/.test(fn) && /T\.statusHeaders\(on, conn && conn\.kind, btSeen\)/.test(fn)
  && /if \(on && !btSeen\) btSeen = T\.anyBacktest\(STRAT_DIR\(\)\)/.test(fn)
  && /getJSON\([^)]*account_status`, \{ "x-api-key": `proxy-\$\{acct\}`, \.\.\.state \}\)/.test(fn));
t("…沒登入(沒 token)就不打", fn.indexOf("if (!acct) return null;") >= 0 && fn.indexOf("if (!acct) return null;") < fn.indexOf("getJSON("));
t("…取值包在 try 裡(讀連結紀錄出錯不會讓帳號狀態整支炸掉)", fn.indexOf("try {") >= 0 && fn.indexOf("try {") < fn.indexOf("loadConnection()"));
const setH = main.slice(main.indexOf('ipcMain.handle("telemetry-set"'), main.indexOf('ipcMain.handle("telemetry-set"') + 400);
t("切換開關的當下打一次 account_status(先改開關、再打)",
  /setEnabled\(on === true\); accountStatus\(\); return tm\(\)\.isEnabled\(\);/.test(setH));
const login = main.slice(main.indexOf('tm().track("login_done")'), main.indexOf("return { ok: true };", main.indexOf('tm().track("login_done")')));
t("登入完成時打一次(新 token 存好之後)", /\n\s*accountStatus\(\);/.test(login) && login.indexOf("saveToken") < 0 && main.indexOf("saveToken(r.body.access_token)") < main.indexOf('tm().track("login_done")'));
const cut = (name) => { const i = main.indexOf(name); return main.slice(i, main.indexOf("\n}", i) + 2); };
t("換 AI 成功後打一次(存成功才打,存失敗的那條 return false 在前面)", /tm\(\)\.track\("connect_done", \{ kind: saved\.kind \}\);\s*\n\s*accountStatus\(\);[^\n]*\n\s*return true;/.test(cut("async function saveConnection")));
t("清掉 AI 連結後也打一次", /const clearConnection = \(\) => \{ const r = connStore\(\)\.clear\(\); accountStatus\(\); return r; \};/.test(main));
t("開 app 時補報一次(已登入才會真的打:accountStatus 自己看 token)", /startStep\("app state", \(\) => \{ accountStatus\(\); \}\);/.test(main));
t("只有主行程送:renderer 與 preload 不碰這幾個 header", ["renderer/app.js", "preload.js"].every((f) =>
  !/X-Blave-(Telemetry|Engine|Progress)/.test(fs.readFileSync(path.join(__dirname, "..", "shell", f), "utf8"))));

console.log(red ? `\n${red} 紅` : "\n全綠");
process.exit(red ? 1 : 0);
