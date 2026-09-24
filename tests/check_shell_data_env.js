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

// 兩把 key 各看各的:帳號 token(能燒 AI 額度)只在連的是 Blave 時才進 agent 的 env;資料 key 看的是
// 有沒有登入,自帶 CLI 的人也拿得到。兩個條件對調任何一個,這裡就紅。
// 決定本身是一支純函式(turnCreds),從原文切出來跑整張表;接線另外用原文斷言釘住。
{ const i = src.indexOf("function turnCreds("); let d = 0, j = src.indexOf("{", i), end = -1;
  for (let k = j; k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) { end = k + 1; break; } }
  const turnCreds = eval("(" + src.slice(i, end) + ")");
  const row = (kind, signedIn, included) => { const r = turnCreds(kind, signedIn, included); return (r.proxyToken ? "T" : "-") + (r.dataKey ? "D" : "-"); };
  t("連 Blave AI + 已登入 + 含資料 → 帳號 token 與資料 key 都帶", row("blave", true, true) === "TD");
  t("連 Blave AI + 已登入 + 不含資料 → 只帶帳號 token", row("blave", true, false) === "T-");
  t("連自己的 Claude Code + 已登入 + 含資料 → **只帶資料 key**(不燒 Blave 的 AI 額度,但拿得到資料)", row("claude", true, true) === "-D" && row("codex", true, true) === "-D");
  t("連自己的 CLI + 已登入 + 不含資料 → 兩個都不帶", row("claude", true, false) === "--" && row("codex", true, false) === "--");
  t("未登入 → 兩個都不帶(不管連的是誰、不管 included 傳了什麼)", ["blave", "claude", "codex", undefined].every((k) => row(k, false, true) === "--"));
  t("含不含資料查不到(null / undefined / 非布林)→ 當沒有", [null, undefined, 1, "true"].every((v) => row("claude", true, v) === "--"));
  t("signedIn 不是布林 true → 當沒登入", row("blave", "yes", true) === "--"); }
t("接線:帳號 token 吃 plan.proxyToken、只進 BLAVE_PROXY_TOKEN", /const acct = plan\.proxyToken \? loadToken\(\) : null;/.test(src) && /\.\.\.\(acct \? \{ BLAVE_PROXY_TOKEN: acct \} : \{\}\)/.test(src));
t("接線:資料 key 吃 plan.dataKey,而且只經 syncDataEnv 進 workspace .env 的 managed block", /const dataAccess = syncDataEnv\(plan\.dataKey\);/.test(src) && (src.match(/syncDataEnv\(/g) || []).length === 3 && !/syncDataEnv\([^)]*useBlave/.test(src));
t("接線:含不含資料只在有登入時才去問", /turnCreds\(conn\.kind, signedIn, signedIn && await hasBlaveData\(\), cloudHandoffOn\(\)\)/.test(src));
{ const i = src.indexOf("function turnCreds("); let d = 0, end = -1; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) { end = k + 1; break; } }
  const tc = eval("(" + src.slice(i, end) + ")");
  t("第三欄 mcp(契約 §2.3):自帶 CLI + 登入 → proxyToken:false、mcp:true;沒登入三個全 false;功能關 → mcp 一律 false", ["claude", "codex"].every((k) => { const r = tc(k, true, false, true); return r.proxyToken === false && r.mcp === true; })
    && ["claude", "codex", "blave"].every((k) => { const r = tc(k, false, false, true); return !r.proxyToken && !r.dataKey && !r.mcp; }) && ["claude", "codex", "blave"].every((k) => tc(k, true, true, false).mcp === false)); }
t("登出要清:signOutBlave → clearToken → clearDataKey → 刪本機那份 + syncDataEnv(false)", /async function signOutBlave\(\)[\s\S]{0,600}?\n  clearToken\(\);/.test(src) && /function clearToken\(\) \{[\s\S]{0,120}?\n  clearDataKey\(\);/.test(src) && /function clearDataKey\(\) \{\s*\n\s*try \{ fs\.unlinkSync\(dataKeyPath\(\)\); \} catch \(_\) \{\}\s*\n\s*syncDataEnv\(false\);/.test(src));
// 沒有主機也能買資料(spec data-without-machine-pricing §E):account_status 的 data_access 三態 → 寫不寫資料 key → BLAVE_DATA_ACCESS。
// included 與 billed 都算有資料;none 沒有;舊 api 沒有 data_access(外殼比 api 先出)→ 退回布林 data_included,跟以前一樣。
// 真的跑 main.js 的 dataAccessOf + hasBlaveData(account_status 用假的)→ turnCreds → syncDataEnv → spawn 那一行的對應
{ const cut = (name) => { const i = src.search(new RegExp("(async )?function " + name + "\\(")); let d = 0, end = -1;
    for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) { end = k + 1; break; } } return src.slice(i, end); };
  let lastAcct = null, body = null; const ACCT_FRESH_MS = 5 * 60 * 1000;
  const accountStatus = async () => { if (body) lastAcct = { at: Date.now(), body }; return body; };
  eval(cut("dataAccessOf")); eval(cut("hasBlaveData").replace(/^async function hasBlaveData/, "var hasBlaveData = async function"));
  const tc = eval("(" + cut("turnCreds") + ")");
  const m = /\.\.\.\(dataAccess === "own" \? \{\} : \{ BLAVE_DATA_ACCESS: dataAccess === "ours" \? "1" : "0" \}\)/.exec(src);
  const envOf = (dataAccess) => (dataAccess === "own" ? {} : { BLAVE_DATA_ACCESS: dataAccess === "ours" ? "1" : "0" });
  const run = async (b) => { body = b; lastAcct = null; const has = await hasBlaveData(); const plan = tc("claude", true, has, false);
    const st = syncDataEnv(plan.dataKey); return { has, st, env: envOf(st).BLAVE_DATA_ACCESS, file: rd() }; };
  const S = (o) => ({ can_run: true, ...o });
  const rows = [
    ["included(試用 / 主機 / 方案)", S({ data_access: "included", data_included: true, data_hourly: 2 }), true],
    ["billed(按小時付、付得起)", S({ data_access: "billed", data_included: false, data_hourly: 2 }), true],
    ["none(這小時付不出來)", S({ data_access: "none", data_included: false, data_hourly: 2 }), false],
    ["舊 api 沒有 data_access、data_included:true", S({ data_included: true }), true],
    ["舊 api 沒有 data_access、data_included:false", S({ data_included: false }), false],
    ["認不得的 data_access 值 → 退回布林(true)", S({ data_access: "later", data_included: true }), true],
    ["認不得的 data_access 值 → 退回布林(false)", S({ data_access: "later", data_included: false }), false],
    ["data_access 說 none、布林說 true:認新欄位", S({ data_access: "none", data_included: true }), false],
  ];
  (async () => {
    fs.rmSync(f, { recursive: true, force: true });
    for (const [name, b, want] of rows) {
      const r = await run(b);
      t(`資料狀態 ${name} → ${want ? "寫資料 key、BLAVE_DATA_ACCESS=1" : "不寫、BLAVE_DATA_ACCESS=0"}`,
        r.has === want && r.st === (want ? "ours" : "none") && r.env === (want ? "1" : "0") && (want ? r.file === BLOCK : r.file === null));
    }
    t("查不到 account_status(null)→ 當沒有資料", (await run(null)).has === false);
    t("spawn 那一行的對應照舊由 syncDataEnv 的結果決定(ours → 1、none → 0、own → 不設)", !!m);
    fs.rmSync(WS, { recursive: true, force: true });
    console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
  })(); }

