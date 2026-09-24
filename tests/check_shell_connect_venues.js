// 「連接交易所」多開 OKX / BingX / Gate.io / Bybit(Wei 09-23,0.0.5)。三層各驗一次:
//   ① daemon.js 的 trusted 白名單:每一家剛好一整組才收(OKX 三個、其他兩個),半組 / 混兩家 / renderer 那條路都不收;解除綁定拿得掉
//   ② renderer 的名字表(trade.js CX_VENUES / trEnvNames / trVenueLabel)跟主行程那份(cloudcmd.venueEnvNames)同一組
//   ③ 真的開連接框(隨包 Electron + 真的 index.html,window.blave 換成假的):兩個視角都列五家;OKX 多一格 Passphrase;
//      送出去的形狀;送完 / 關框後畫面不留金鑰;本機成功 = 「串接成功:讀得到帳戶」(不說交易權限已確認),失敗講那一家的原因
// 金鑰全是 not-a-real-*。跑法:node tests/check_shell_connect_venues.js(找不到 shell/node_modules 的 Electron,③ 就 SKIP)
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };
const J = JSON.stringify;

if (!process.versions.electron) (async () => {
  // ── ① daemon 白名單 ──
  const { argsOk } = require(path.join(SHELL, "daemon.js"));
  const CC = require(path.join(SHELL, "cloudcmd.js"));
  const K = "not-a-real-key-0001", S = "not-a-real-secret-0001", P = "not a real passphrase";
  const set = (v) => Object.fromEntries(CC.venueEnvNames(v).map((n) => [n, /PASSPHRASE$/.test(n) ? P : /SECRET/.test(n) ? S : K]));
  ok("① trusted:OKX / BingX / Gate.io / Bybit 各自剛好一整組 → 收", ["okx", "bingx", "gateio", "bybit"].every((v) => argsOk("credentials", { env: set(v) }, true) === true));
  ok("① OKX 少了 PASSPHRASE(半組)→ 不收;混兩家 → 不收;多一個 BLAVE_* → 不收",
    argsOk("credentials", { env: { OKX_API_KEY: K, OKX_SECRET_KEY: S } }, true) === false
    && argsOk("credentials", { env: { OKX_API_KEY: K, BYBIT_SECRET_KEY: S } }, true) === false
    && argsOk("credentials", { env: { ...set("bybit"), BLAVE_API_KEY: K } }, true) === false);
  ok("① 值帶換行 / 空白金鑰 → 不收(passphrase 可以有空白)", argsOk("credentials", { env: { ...set("okx"), OKX_API_KEY: K + "\nX=1" } }, true) === false
    && argsOk("credentials", { env: { ...set("bingx"), BINGX_API_KEY: "has space" } }, true) === false && argsOk("credentials", { env: set("okx") }, true) === true);
  ok("① renderer 那條路(沒有 trusted)→ 這四家一律不收", ["okx", "bingx", "gateio", "bybit"].every((v) => argsOk("credentials", { env: set(v) }) === false && argsOk("credentials", { env: set(v) }, "true") === false));
  ok("① 解除綁定:四家的名字(含 OKX_PASSPHRASE)都拿得掉", ["okx", "bingx", "gateio", "bybit"].every((v) => argsOk("credentials_remove", { env: CC.venueEnvNames(v) }) === true));
  ok("① Binance 照舊:一整對才收", argsOk("credentials", { env: { BINANCE_API_KEY: "A".repeat(64), BINANCE_SECRET_KEY: "b".repeat(64) } }, true) === true
    && argsOk("credentials", { env: { BINANCE_API_KEY: "A".repeat(64) } }, true) === false);

  // ── ①b main.js 的 venue-connect:形狀照 cloudcmd、只走 trusted、回應只有代號,daemon 回的句子遮過金鑰才給畫面 ──
  { const mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
    const i = mainSrc.indexOf('  handle("venue-connect"'), j = mainSrc.indexOf("  // Binance 真錢連接:四支都只收自家頁面");
    const handlers = {}, sent = []; let reply = { ok: true };
    new Function("handle", "require", "sendTrustedCreds", mainSrc.slice(i, j))((n, fn) => { handlers[n] = fn; }, (m) => require(path.join(SHELL, m)), async (env) => { sent.push(env); return reply; });
    const H = handlers["venue-connect"], okx = { venue: "okx", apiKey: K, secret: S, passphrase: P };
    const go = async () => {
      const a = await H({}, okx);
      ok("①b 送 daemon 的就是 OKX 那一組(trusted),回應只有代號(READ_OK = runtime 寫入前讀得到帳戶)", J(sent[0]) === J({ OKX_API_KEY: K, OKX_SECRET_KEY: S, OKX_PASSPHRASE: P }) && J(a) === J({ ok: true, code: "READ_OK", detail: {} }));
      sent.length = 0;
      const b = await H({}, { venue: "binance", apiKey: K, secret: S }), c = await H({}, { venue: "paper" }), d = await H({}, { venue: "okx", apiKey: K, secret: S });
      ok("①b Binance / 模擬不走這支;OKX 沒有 passphrase = 沒填齊;都沒送 daemon", b.code === "BAD_ARGS" && c.code === "BAD_ARGS" && d.code === "INCOMPLETE_PAIR" && sent.length === 0);
      reply = { ok: false, error: "ValueError: REJECTED: okx did not accept this key (RuntimeError: 50113 bad sign for " + K + ") — not saved" };
      const e = await H({}, okx);
      ok("①b REJECTED:帶那一家的原因,金鑰值遮掉", e.ok === false && e.code === "REJECTED" && /50113 bad sign/.test(e.detail.reason) && e.detail.reason.indexOf(K) < 0);
      const codeOf = async (err) => { reply = { ok: false, error: err }; return (await H({}, okx)).code; };
      ok("①b INCOMPLETE_PAIR / UNKNOWN / no permission check → 各自的代號;看不懂的句子 → SEND_FAILED(遮過)",
        (await codeOf("ValueError: INCOMPLETE_PAIR: okx needs OKX_API_KEY + OKX_SECRET_KEY + OKX_PASSPHRASE together — not saved")) === "INCOMPLETE_PAIR"
        && (await codeOf("ValueError: UNKNOWN: okx's account answer could not be read — not saved")) === "UNKNOWN"
        && (await codeOf("ValueError: no permission check exists for okx on this workspace (run 更新 blave agent first) — not saved")) === "NO_CHECK"
        && (await codeOf("RuntimeError: .env unreadable (OSError) — try again")) === "SEND_FAILED");
      reply = { ok: false, error: "DAEMON_DOWN" };
      ok("①b daemon 自己的代號原樣", J((await H({}, okx)).detail) === J({ error: "DAEMON_DOWN" }));
    };
    await go(); }

  // ── ② renderer 的名字表 ──
  const src = fs.readFileSync(path.join(SHELL, "renderer", "trade.js"), "utf8");
  const cut = (n) => { const i = src.indexOf("function " + n + "("); let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error(n); };
  const t = (k) => k;
  eval(src.slice(src.indexOf("const PAPER = "), src.indexOf("\nfunction trEl(")).replace(/^const /gm, "var "));
  eval(cut("trEnvNames")); eval(cut("trVenueLabel"));
  ok("② trEnvNames 與主行程 cloudcmd.venueEnvNames 同一組(解除綁定送的就是機器寫的)", ["binance", "okx", "bingx", "gateio", "bybit"].every((v) => J(trEnvNames(v)) === J(CC.venueEnvNames(v)))
    && J(trEnvNames("paper")) === J(["PAPER_API_KEY", "PAPER_SECRET_KEY", "PAPER_BOUND_TS"]));
  ok("② 名字表與主行程那份同一組交易所", J(Object.keys(CX_VENUES).sort()) === J(Object.keys(CC.CONNECT_VENUES).sort()) && CX_VENUES.okx.pass === true && !CX_VENUES.bybit.pass);
  ok("② 顯示名:Gate.io / OKX / BingX(首字大寫會寫錯)", trVenueLabel("gateio") === "Gate.io" && trVenueLabel("okx") === "OKX" && trVenueLabel("bingx") === "BingX" && trVenueLabel("paper", true) === "cx.paperShort");
  ok("② 兩個視角都列五家(runtime 已在電腦版開放這四家,寫入前讀一次帳戶)", J(cxVenuesFor("local")) === J(["binance", "okx", "bingx", "gateio", "bybit"]) && J(cxVenuesFor("cloud")) === J(cxVenuesFor("local")));

  // ── ③ 交給 Electron ──
  const bin = path.join(SHELL, "node_modules", ".bin", "electron");
  if (!fs.existsSync(bin)) { console.log("SKIP  ③ 找不到 shell/node_modules 的 Electron"); console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  process.exit(red || r.status !== 0 ? 1 : 0);
})();
else {

const { app, BrowserWindow } = require("electron");
const os = require("os");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-venues-")));
const STUB = `window.__over = {}; window.__calls = [];
window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : async (...a) => { window.__calls.push([k, a]); if (k in window.__over) return window.__over[k](...a);
      return ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
        listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" } })[k]; } });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  setTimeout(() => { console.log("FAIL  ③ 逾時(60 秒內沒跑完)"); app.exit(1); }, 60000).unref();
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1200);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const run = (s) => w.webContents.executeJavaScript("(() => { " + s + "; return 0; })()", true);   // 賦值成函式的那幾行:回傳值不能跨 IPC
  const fields = () => js(`[...document.querySelectorAll("#cx-body input")].map((i) => i.id)`);
  const pick = (v) => js(`(() => { const s = $("cx-venue"); s.value = ${J(v)}; s.dispatchEvent(new Event("change")); })()`);
  const fill = (o) => js(`(() => { for (const [id, v] of Object.entries(${J(o)})) { const i = $(id); i.value = v; i.dispatchEvent(new Event("input")); } })()`);

  // 雲端視角
  await js(`(() => { trPollSoon = () => {}; trPoll = async () => {};
    TR_BAGS.cloud.st = { alive: true, cloud: { code: "OK", machine: { state: "running", public_ip: "203.0.113.9" }, strategies: [] }, report: {} };
    if (ENV.cur !== "cloud") envSwitch("cloud"); cxModalOpen(null); })()`);
  await wait(150);
  const cloudOpts = await js(`[...$("cx-venue").options].map((o) => o.value)`);
  ok("③ 雲端視角:模擬 + 五家(Binance / OKX / BingX / Gate.io / Bybit)", J(cloudOpts) === J(["paper", "binance", "okx", "bingx", "gateio", "bybit"]));
  const labels = await js(`[...$("cx-venue").options].slice(1).map((o) => o.textContent)`);
  ok("③ 選單上是交易所的正式名字", J(labels) === J(["Binance", "OKX", "BingX", "Gate.io", "Bybit"]));
  const byVenue = {};
  for (const v of ["okx", "bingx", "gateio", "bybit"]) { await pick(v); byVenue[v] = await fields(); }
  ok("③ OKX 三格(API Key / Secret Key / Passphrase);BingX / Gate.io / Bybit 兩格", J(byVenue.okx) === J(["cx-api", "cx-secret", "cx-pass"])
    && ["bingx", "gateio", "bybit"].every((v) => J(byVenue[v]) === J(["cx-api", "cx-secret"])));
  await pick("okx");
  const ph = await js(`(() => { const h = $("cx-pass-hint"); return h ? [h.textContent, $("cx-pass").getAttribute("aria-describedby"), h.closest("label") === $("cx-pass").closest("label")] : null; })()`);
  ok("③ OKX 的 Passphrase 欄下面一行說明(不是登入密碼),欄位用 aria-describedby 指到它(設計稽核 005 第 10 條)",
    !!ph && ph[0] === (await js(`t("cx.passHint")`)) && /不是 OKX 的登入密碼/.test(await js(`STRINGS.zh["cx.passHint"]`)) && ph[1] === "cx-pass-hint" && ph[2] === true);
  await pick("bingx");
  ok("③ 沒有 Passphrase 的交易所:沒有那一行", await js(`!document.querySelector("#cx-body .cx-hint[id$='-hint']")`));
  ok("③ 三格都是密碼欄、不自動完成", await js(`[...document.querySelectorAll("#cx-body input")].length > 0 && [...document.querySelectorAll("#cx-body input")].every((i) => i.type === "password" && i.autocomplete === "off")`));
  await pick("okx");
  await fill({ "cx-api": "not-a-real-key-okx", "cx-secret": "not-a-real-secret-okx", "cx-pass": "not a real passphrase" });
  await run(`window.__over.cloudConnect = async (a) => ({ ok: true, code: "OK", detail: {} })`);
  await js(`$("cx-go").click()`); await wait(300);
  const sent = await js(`window.__calls.filter((c) => c[0] === "cloudConnect").map((c) => c[1][0])`);
  ok("③ 雲端送出的形狀:{ venue: okx, apiKey, secret, passphrase }", sent.length === 1 && J(sent[0]) === J({ venue: "okx", apiKey: "not-a-real-key-okx", secret: "not-a-real-secret-okx", passphrase: "not a real passphrase" }));
  ok("③ 送出成功:框關掉、畫面這邊的金鑰清空(CXF 與 DOM 都沒有)", await js(`$("cx-scrim").hidden && CXF.apiKey === "" && CXF.secret === "" && CXF.passphrase === "" && !document.querySelector("#cx-body input")`));

  // 雲端被拒 = 主機拒絕這個指令(設計稽核 005 第 2 條):講主機、帶 detail.error;不是「OKX 沒有接受這把金鑰：—」
  const errOf = () => js(`($("cx-body").querySelector(".plan-err") || {}).textContent || ""`);
  await js(`cxModalOpen(null)`); await wait(100); await pick("okx");
  await fill({ "cx-api": "not-a-real-key-okx", "cx-secret": "not-a-real-secret-okx", "cx-pass": "not a real passphrase" });
  await run(`window.__over.cloudConnect = async () => ({ ok: false, code: "REJECTED", detail: { error: "unsupported venue: okx" } })`);
  await js(`$("cx-go").click()`); await wait(300);
  const cRej = await errOf();
  ok("③ 雲端 REJECTED:句子是「雲端主機沒有接受這個指令(原因)」,原因是 detail.error、不是「—」", cRej === (await js(`t("tr.cloud.cmdRejected", { err: "unsupported venue: okx" })`)) && !/沒有接受這把金鑰/.test(cRej));
  await run(`window.__over.cloudConnect = async () => ({ ok: false, code: "REJECTED", detail: { error: "ValueError: REJECTED: okx did not accept this key (AccountModeError: OKX 帳戶模式不支援合約 [okx_account_mode] (OKX acctLv=1)) — not saved" } })`);
  await js(`$("cx-go").click()`); await wait(300);
  ok("③ 雲端 REJECTED 帶 [okx_account_mode]:講怎麼改帳戶模式", (await errOf()) === (await js(`t("cx.err.okxMode")`)));
  await js(`cxModalClose(false)`); await wait(100);

  // 這台電腦
  await js(`(() => { envSwitch("local"); TR_BAGS.local.st = { alive: true, report: { venues: {} } }; cxModalOpen(null); })()`);
  await wait(150);
  ok("③ 這台電腦:模擬 + 五家", J(await js(`[...$("cx-venue").options].map((o) => o.value)`)) === J(["paper", "binance", "okx", "bingx", "gateio", "bybit"]));
  await pick("okx");
  await fill({ "cx-api": "not-a-real-key-okx", "cx-secret": "not-a-real-secret-okx", "cx-pass": "not a real passphrase" });
  await run(`window.__calls.length = 0; window.__over.venueConnect = async () => ({ ok: true, code: "READ_OK", detail: {} }); window.__over.tradeSend = async () => ({ ok: true })`);
  await js(`$("cx-go").click()`); await wait(400);
  const calls = await js(`window.__calls.map((c) => [c[0], c[1][0]])`);
  const vc = calls.find((c) => c[0] === "venueConnect");
  ok("③ 本機:金鑰只走 venueConnect(形狀同雲端),之後叫 retest_accounts;沒有經過 trade-send 的 credentials",
    !!vc && J(vc[1]) === J({ venue: "okx", apiKey: "not-a-real-key-okx", secret: "not-a-real-secret-okx", passphrase: "not a real passphrase" })
    && calls.some((c) => c[0] === "tradeSend" && c[1] === "retest_accounts") && !calls.some((c) => c[0] === "tradeSend" && c[1] === "credentials"));
  ok("③ 成功:講「串接成功:讀得到帳戶,交易權限在第一筆下單時確認」、框關掉、金鑰清空", await js(`$("cx-scrim").hidden && CXF.apiKey === "" && CXF.passphrase === ""`)
    && (await js(`$("sr-live").textContent`)) === (await js(`t("cx.linkOk")`)) && /交易權限/.test(await js(`STRINGS.zh["cx.linkOk"]`)));
  // 那一家拒絕:講原因,框留著、欄位照舊(沒有儲存,讓人改完再按)
  await js(`(() => { cxModalOpen(null); })()`); await wait(100); await pick("okx");
  await fill({ "cx-api": "not-a-real-key-okx", "cx-secret": "not-a-real-secret-okx", "cx-pass": "not a real passphrase" });
  await run(`window.__over.venueConnect = async () => ({ ok: false, code: "REJECTED", detail: { reason: "RuntimeError: 50113 Invalid Sign" } })`);
  await js(`$("cx-go").click()`); await wait(300);
  const failMsg = await js(`($("cx-body").querySelector(".plan-err") || {}).textContent || ""`);
  ok("③ 拒絕:框留著、講 OKX 沒有接受這把金鑰與原因(不是 Binance 的句子)", !(await js(`$("cx-scrim").hidden`)) && /OKX/.test(failMsg) && /50113 Invalid Sign/.test(failMsg) && !/Binance/.test(failMsg));
  const say = async (code) => { await run(`window.__over.venueConnect = async () => ({ ok: false, code: ${J(code)}, detail: {} })`); await js(`$("cx-go").click()`); await wait(300);
    return js(`($("cx-body").querySelector(".plan-err") || {}).textContent || ""`); };
  ok("③ 沒填齊(OKX):講三格要一起給", (await say("INCOMPLETE_PAIR")).indexOf(await js(`t("cx.chk.incompletePass")`)) >= 0);
  ok("③ UNKNOWN / NO_CHECK:那一家的句子", (await say("UNKNOWN")) === (await js(`t("cx.chk.unknownV", { venue: "OKX" })`)) && (await say("NO_CHECK")) === (await js(`t("cx.chk.noCheckV", { venue: "OKX" })`)));
  await run(`window.__over.venueConnect = async () => ({ ok: false, code: "REJECTED", detail: { reason: "AccountModeError: OKX 帳戶模式不支援合約 [okx_account_mode] (OKX acctLv=1)" } })`);
  await js(`$("cx-go").click()`); await wait(300);
  ok("③ 本機 REJECTED 帶 [okx_account_mode]:講怎麼改帳戶模式,不出原文", (await js(`($("cx-body").querySelector(".plan-err") || {}).textContent || ""`)) === (await js(`t("cx.err.okxMode")`)));
  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
}
