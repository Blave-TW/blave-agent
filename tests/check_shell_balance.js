// Blave 餘額(電腦版自己的端點 POST /oauth/desktop/balance;shell/balance.js + renderer 的 balLoad / balNow / balNum)。不打真的 api(post 是假的)。
//   1. 200 → 數字;401(舊登入 / 憑證不對)、429、503、404(api 還沒部署)、連不上、欄位不是數字 → 讀不到(null),畫面畫「—」,不畫成 0
//   2. 帶 token + app_secret 兩顆;少一顆不發請求;10 秒內重複讀用上一次的答案;登出 / 換帳號不把上一個帳號的數字交出去
//   3. 畫面:整數、千分位、四捨五入(跟網頁同一個算法);讀取中留著上一個數字;看得到餘額的地方只有一個來源
//   4. 憑證只在主行程:IPC 只收自家頁面、回的只有兩個數字
// 跑法:node tests/check_shell_balance.js
const fs = require("fs"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const { createBalance, interpret, ENDPOINT, HOLD_MS } = require(path.join(SHELL, "balance.js"));
const app = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8"), mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8"), preload = fs.readFileSync(path.join(SHELL, "preload.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const fn = (name) => { const i = app.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); let d = 0; for (let k = app.indexOf("{", app.indexOf(")", i)); k < app.length; k++) { if (app[k] === "{") d++; else if (app[k] === "}" && --d === 0) return app.slice(i, k + 1); } throw new Error("切不出 " + name); };

// 畫面那一半:真的 balLoad / balNow / balNum,window.blave.balance 接到假的主行程
function screen(host) {
  const painted = [], els = { "mp-bill": {}, "set-scrim": { hidden: false }, "set-plan": { hidden: false } };
  const M = new Function("window", "$", "mpBillPaint", "planPaint", `let hasToken = true, balLast = null, balSeq = 0;
    ${fn("balNum")}\n${fn("balNow")}\nasync ${fn("balLoad").replace(/^async /, "")}
    return { balNum, balNow, balLoad, token: (v) => { hasToken = v; }, clear: () => { balLast = null; } };`)(
    { blave: { balance: () => host.read() } }, (id) => els[id], () => painted.push("menu"), () => painted.push("plan"));
  // 帳號與方案那一列與模型選單底部畫的字(同 planPaint / mpBillPaint 的寫法)
  const row = () => { const n = M.balNow(); return n ? n + " TWD" : "—"; };
  return { M, row, painted };
}
const mk = (reply, o) => { const sent = []; let creds = (o && o.creds) || { token: "acct-A", appSecret: "appsec-A" }, t = 1000;
  const h = createBalance({ apiBase: "https://api.test", post: async (u, b) => { sent.push([u, b]); return reply(sent.length); }, getCreds: () => creds, now: () => t });
  return { h, sent, tick: (ms) => { t += ms; }, creds: (c) => { creds = c; } }; };

(async () => {
  // ---- 1
  const CASES = [
    ["200", { status: 200, body: { balance: 1234.56, trial_ai_credit_left: null } }, "1,235 TWD"],
    ["200 試用中", { status: 200, body: { balance: 0, trial_ai_credit_left: 62.5 } }, "0 TWD"],
    ["200 負數", { status: 200, body: { balance: -12.4, trial_ai_credit_left: null } }, "-12 TWD"],
    ["401 INVALID_CREDENTIALS", { status: 401, body: { error_code: "INVALID_CREDENTIALS" } }, "—"],
    ["401 APP_SECRET_REQUIRED(舊登入)", { status: 401, body: { error_code: "APP_SECRET_REQUIRED" } }, "—"],
    ["429 ERR429", { status: 429, body: { error_code: "ERR429" } }, "—"],
    ["503 BALANCE_UNAVAILABLE", { status: 503, body: { error_code: "BALANCE_UNAVAILABLE" } }, "—"],
    ["404(api 還沒部署)", { status: 404, body: "<html>Not Found</html>" }, "—"],
    ["200 但欄位不是數字", { status: 200, body: { balance: "1234", trial_ai_credit_left: null } }, "—"],
    ["200 但沒有 balance", { status: 200, body: { trial_ai_credit_left: 5 } }, "—"],
  ];
  for (const [name, reply, want] of CASES) {
    const m = mk(() => reply), s = screen(m.h); await s.M.balLoad();
    ok(`${name} → 畫面「${want}」`, s.row() === want, s.row());
  }
  { const m = mk(() => { throw new Error("ECONNRESET"); }), s = screen(m.h); await s.M.balLoad(); ok("連不上(post 丟例外)→「—」,不炸", s.row() === "—"); }
  ok("錯誤不會被畫成 0:讀不到一律 null", [{ status: 503, body: { balance: 0 } }, { status: 401, body: { balance: 0 } }, null, undefined, { status: 200 }].every((r) => interpret(r) === null)
    && JSON.stringify(interpret({ status: 200, body: { balance: 0, trial_ai_credit_left: null } })) === '{"balance":0,"trial":null}');
  // ---- 2
  { const m = mk(() => ({ status: 200, body: { balance: 10, trial_ai_credit_left: 3 } })); const r = await m.h.read();
    ok("打的是 /oauth/desktop/balance,body 只有 token 與 app_secret", m.sent.length === 1 && m.sent[0][0] === "https://api.test" + ENDPOINT && ENDPOINT === "/oauth/desktop/balance"
      && JSON.stringify(m.sent[0][1]) === '{"token":"acct-A","app_secret":"appsec-A"}' && JSON.stringify(r) === '{"balance":10,"trial":3}');
    await m.h.read(); m.tick(HOLD_MS - 1); await m.h.read();
    ok("10 秒內重複讀:用上一次的答案,不再發請求", m.sent.length === 1 && HOLD_MS === 10000);
    m.tick(2); await m.h.read();
    ok("過了 10 秒:重新讀", m.sent.length === 2); }
  { const m = mk(() => ({ status: 429, body: { error_code: "ERR429" } })); await m.h.read(); await m.h.read();
    ok("讀不到也算一次答案:429 之後 10 秒內不再打", m.sent.length === 1); }
  { const m = mk(() => ({ status: 200, body: { balance: 1, trial_ai_credit_left: null } }), { creds: { token: "acct-A", appSecret: "" } });
    const a = await m.h.read(); m.creds(null); const b = await m.h.read();
    ok("少一顆憑證(舊登入沒有 app_secret / 沒登入):不發請求、讀不到", a === null && b === null && m.sent.length === 0); }
  { let release; const m = mk(() => new Promise((r) => { release = () => r({ status: 200, body: { balance: 500, trial_ai_credit_left: null } }); }));
    const p = m.h.read(), q = m.h.read(); m.creds({ token: "acct-B", appSecret: "appsec-B" }); release();
    ok("在途時換了帳號:上一個帳號的數字不交出去;同一時間的兩次讀只發一個請求", (await p) === null && (await q) === null && m.sent.length === 1);
    const m2 = mk(() => ({ status: 200, body: { balance: 7, trial_ai_credit_left: null } })); await m2.h.read(); m2.h.reset(); await m2.h.read();
    ok("reset()(登出 / 登入換帳號):不沿用上一次的答案", m2.sent.length === 2); }
  // ---- 3
  { const s = screen({ read: async () => null });
    ok("整數、千分位、四捨五入(跟網頁同一個算法),不再無條件捨去", s.M.balNum(1234.49) === "1,234" && s.M.balNum(1234.5) === "1,235" && s.M.balNum(0.4) === "0" && s.M.balNum(-0.4) === "0" && s.M.balNum(1234567.89) === "1,234,568"
      && [1234.5, 0.5, 99.5, 1e6 + 0.5].every((v) => s.M.balNum(v) === new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(v)))
      && [undefined, null, "12", NaN, Infinity, {}].every((v) => s.M.balNum(v) === null)); }
  { let reply = { balance: 300.5, trial: null }, gate = null; const s = screen({ read: () => (gate ? gate.then(() => reply) : Promise.resolve(reply)) });
    await s.M.balLoad(); const first = s.row();
    let open; gate = new Promise((r) => { open = r; }); reply = { balance: 250, trial: null }; const p = s.M.balLoad(); const during = s.row(); open(); await p;
    ok("讀取中留著上一個數字,讀到才換;兩個畫面都重畫", first === "301 TWD" && during === "301 TWD" && s.row() === "250 TWD" && s.painted.includes("menu") && s.painted.includes("plan"));
    gate = null; reply = null; await s.M.balLoad();
    ok("之後讀不到:換成「—」(不留著舊數字假裝還是那個餘額)", s.row() === "—");
    reply = { balance: 9, trial: null }; s.M.token(false); await s.M.balLoad();
    ok("沒登入:不讀、沒有餘額", s.M.balNow() === null); }
  { const code = app.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    ok("一個來源:畫面(帳號與方案那一列、模型選單底部)只經過 balNow(),讀只有 balLoad() 一處;餘額不再從帳號狀態讀", (code.match(/= (?:on \? )?balNow\(\)/g) || []).length === 2 && (code.match(/balNow\(\)/g) || []).length === 3
      && !/acct\.balance|balNum\(acct/.test(code) && (code.match(/window\.blave\.balance\(\)/g) || []).length === 1 && /window\.blave\.balance\(\)/.test(fn("balLoad"))); }
  ok("什麼時候讀:打開帳號與方案、打開模型選單(引擎是 Blave AI)、Blave AI 的回合結束、登入回來;不輪詢", /if \(hasToken\) \{ acctCheck\(\); balLoad\(\); \}/.test(fn("setCat")) && /if \(cur === "blave" && hasToken\) balLoad\(\);/.test(fn("mpOpen"))
    && /draftPromote\(\);[^\n]*\n  if \(cur === "blave" && hasToken\) balLoad\(\);/.test(app) && (app.match(/await acctCheck\(\); balLoad\(\); \}/g) || []).length === 2 && !/setInterval\([^)]*balLoad/.test(app));
  ok("登出、登入、換帳號都把上一個數字清掉", (app.match(/acct = null; balLast = null;/g) || []).length === 3);
  // ---- 4
  ok("IPC 走 handle()(只收自家頁面);renderer 拿到的只有 balanceHost().read() 的結果", /handle\("balance", \(\) => balanceHost\(\)\.read\(\)\);/.test(mainSrc) && /balance: \(\) => ipcRenderer\.invoke\("balance"\)/.test(preload)
    && /require\("\.\/balance"\)\.createBalance\(\{ apiBase: API_BASE, post: \(u, b\) => postJSON\(u, b\),\n    getCreds: \(\) => \{ const token = loadToken\(\); return token \? \{ token, appSecret: loadAppSecret\(\) \} : null; \} \}\);/.test(mainSrc));
  ok("登出與登入換帳號都叫 reset()", (mainSrc.match(/if \(_balance\) _balance\.reset\(\);/g) || []).length === 2);
  { const src = fs.readFileSync(path.join(SHELL, "balance.js"), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    ok("balance.js 不寫檔、不 log、不 require 任何東西", !/require\(/.test(src) && !/console\.|writeFile|appendFile/.test(src)); }
  ok("打包清單有 balance.js(main.js require 它,漏了打包版一開就炸)", /files:\s*\[[^\]]*"balance\.js"/.test(fs.readFileSync(path.join(SHELL, "electron-builder.config.js"), "utf8")));
  // 首次綁卡送多少 AI 額度:不寫死
  { const strings = fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8");
    ok("cn.blave.descSet 的贈額是變數({q},來自 api);拿不到數字只講怎麼收錢那半句", (strings.match(/"cn\.blave\.descSet": "[^"]*\{q\} TWD[^"]*"/g) || []).length === 2 && !/"cn\.blave\.descSet": "[^"]*100/.test(strings)
      && (strings.match(/"cn\.blave\.descSetNoNum":/g) || []).length === 2 && /const q = o\.desc === "cn\.blave\.descSet" \? planVars\(\)\.q : "";/.test(app)); }
  console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  " + (e && e.stack)); process.exit(1); });
