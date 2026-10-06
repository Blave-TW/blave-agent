// 登入完成要不要把 app 拉回前景(shell/main.js loginFocus 與接線)。
// 只有「為了用 Blave AI 登入(連結畫面 blaveGo)+ account_status 回 can_run=false 且 reason 是 NO_CARD / NO_CREDIT」
// 留在瀏覽器(授權完成頁有綁卡 / 儲值鈕);其他登入、查不到、逾時都照舊搶。
// 不開視窗:純函式直接跑,接線用原始碼比對。跑法:node tests/check_shell_login_focus.js
const fs = require("fs"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const src = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const cut = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); if (a < 0 || b < 0) { console.log("FAIL  main.js 裡找不到 " + from); process.exit(1); } return src.slice(a, b); };
eval(cut("const LOGIN_ACCT_WAIT_MS", "async function startOAuth(").replace(/^const /gm, "var "));

const acct = [null, undefined, {}, { can_run: true }, { can_run: true, reason: "NO_CARD" },
  { can_run: false, reason: "NO_CARD" }, { can_run: false, reason: "NO_CREDIT" }, { can_run: false }, { can_run: false, reason: "OTHER" },
  { can_run: "false", reason: "NO_CARD" }, { can_run: 0, reason: "NO_CREDIT" }];
const stays = (intent, s) => intent === true && !!s && s.can_run === false && ["NO_CARD", "NO_CREDIT"].includes(s.reason);
const cases = [true, false, undefined, "blave", 1].flatMap((i) => acct.map((s) => [i, s]));
const wrong = cases.filter(([i, s]) => loginFocus(i, s) !== (stays(i, s) ? "stay" : "steal"));
t(`列舉 ${cases.length} 種(意圖 × 帳號狀態)只有 Blave AI + 沒卡 / 沒額度留下` + (wrong.length ? " → 錯:" + JSON.stringify(wrong) : ""), wrong.length === 0);
t("…正好兩種留下", cases.filter(([i, s]) => loginFocus(i, s) === "stay").length === 2);
t("等帳號狀態最多 3 秒", LOGIN_ACCT_WAIT_MS === 3000);

const oa = cut("async function startOAuth(lang, forBlaveAi)", "\n}\n");
const tail = oa.slice(oa.indexOf('tm().track("login_done")'));
t("只有 Blave AI 那條會等(race 逾時當 null);其他登入不 await",
  /const s = forBlaveAi \? await Promise\.race\(\[acctNow, new Promise\(\(ok\) => \{ timer = setTimeout\(\(\) => ok\(null\), LOGIN_ACCT_WAIT_MS\); \}\)\]\) : null;/.test(tail)
  && (tail.match(/\bawait\b/g) || []).length === 1);
t("account_status 丟例外不會讓登入失敗(.catch 成 null)", /const acctNow = accountStatus\(\)\.catch\(\(\) => null\);/.test(tail));
t("搶前景看 loginFocus;判斷在 return { ok: true } 之前、之後不再有東西",
  /if \(!HEADLESS && loginFocus\(forBlaveAi, s\) === "steal"\) app\.focus\(\{ steal: true \}\);\n  return \{ ok: true \};$/.test(oa));
t("IPC 只把字面 \"blave\" 當意圖(布林進 startOAuth)",
  /handle\("start-oauth", \(_e, lang, intent\) => startOAuth\(lang === "en" \? "en" : "zh", intent === "blave"\)\);/.test(src));
t("preload 轉送第二個參數", /startOAuth: \(lang, intent\) => ipcRenderer\.invoke\("start-oauth", lang, intent\),/.test(fs.readFileSync(path.join(SHELL, "preload.js"), "utf8")));

// renderer:只有連結畫面 / 設定「使用」的 blaveGo 帶意圖;方案頁登入 / 重登、登入失效的原地登入都不帶(照舊搶)
const app = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
const calls = app.match(/window\.blave\.startOAuth\([^)]*\)/g) || [];
const fnOf = (re) => { const m = app.match(re); return m ? app.slice(m.index, app.indexOf("\n}\n", m.index)) : ""; };
t(`startOAuth 呼叫 ${calls.length} 處,帶 "blave" 的只有 1 處`, calls.length >= 4 && calls.filter((c) => /"blave"/.test(c)).length === 1);
t("…那一處在 blaveGo 裡", /window\.blave\.startOAuth\(LANG, "blave"\)/.test(fnOf(/async function blaveGo\(/)));
t("…登入失效的 blaveLoginFlow 不帶", /window\.blave\.startOAuth\(LANG\)/.test(fnOf(/function blaveLoginFlow\(/)));

console.log(red ? `\n${red} 紅` : "\n全綠");
process.exit(red ? 1 : 0);
