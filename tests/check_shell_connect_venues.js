// 「連接交易所」多開 OKX / BingX / Gate.io / Bybit(Wei 09-23,0.0.5)、StockCoin(0.1.28)。三層各驗一次:
//   ① daemon.js 的 trusted 白名單:每一家剛好一整組才收(OKX 三個、其他兩個),半組 / 混兩家 / renderer 那條路都不收;解除綁定拿得掉
//   ② renderer 的名字表(trade.js CX_VENUES / trEnvNames / trVenueLabel)跟主行程那份(cloudcmd.venueEnvNames)同一組
//   ③ 真的開連接框(隨包 Electron + 真的 index.html,window.blave 換成假的):兩個視角都列七家;OKX、Bitget 多一格 Passphrase;
//      送出去的形狀;送完 / 關框後畫面不留金鑰;本機成功 = 「串接成功:讀得到帳戶」(不說交易權限已確認),失敗講那一家的原因
// 金鑰全是 not-a-real-*。跑法:node tests/check_shell_connect_venues.js(找不到 shell/node_modules 的 Electron,③ 就 SKIP)
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
// 統一期貨在這台電腦的下拉要不要列:照 trade.js 的旗標(0.1.18 關、0.1.19 開),測試不自己假設
const tradeSrc = fs.readFileSync(path.join(SHELL, "renderer", "trade.js"), "utf8"), presFlag = tradeSrc.match(/^const PRES_LOCAL_ON = (true|false);$/m), presOn = !!presFlag && presFlag[1] === "true";
const caplFlag = tradeSrc.match(/^const CAPL_LOCAL_ON = (true|false);$/m), caplOn = !!caplFlag && caplFlag[1] === "true";
let red = 0; const ok = (n, c, got) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) { red++; if (got !== undefined) console.log("      實際:" + (typeof got === "string" ? got : JSON.stringify(got))); } };
const J = JSON.stringify;

if (!process.versions.electron) (async () => {
  ok("⓪ trade.js 有 PRES_LOCAL_ON 旗標,「台灣期貨」那組磚看它(cxPresListed);群益本機另受 CAPL_LOCAL_ON 管(0.1.50 起開);不是 Windows 不出期貨磚", !!presFlag && !!caplFlag
    && /if \(env !== "local"\) return \[\[CAPITAL, "cap\.venue"\]\];\n  if \(platform !== "win32"\) return null;\n  return \[cxCaplListed\(\) \? \[CAPITAL, "cap\.venue"\] : null, cxPresListed\(\) \? \["president", "pres\.venue"\] : null\]\.filter\(Boolean\);/.test(tradeSrc)
    && /const tw = cxTwTiles\(CXF\.env, window\.blave\.platform\);/.test(tradeSrc));
  // ── ① daemon 白名單 ──
  const { argsOk } = require(path.join(SHELL, "daemon.js"));
  const CC = require(path.join(SHELL, "cloudcmd.js"));
  const K = "not-a-real-key-0001", S = "not-a-real-secret-0001", P = "not a real passphrase";
  const set = (v) => Object.fromEntries(CC.venueEnvNames(v).map((n) => [n, /PASSPHRASE$/.test(n) ? P : /SECRET/.test(n) ? S : K]));
  ok("① trusted:OKX / BingX / Gate.io / Bybit / StockCoin / Bitget 各自剛好一整組 → 收", ["okx", "bingx", "gateio", "bybit", "stockcoin", "bitget"].every((v) => argsOk("credentials", { env: set(v) }, true) === true));
  ok("① OKX 少了 PASSPHRASE(半組)→ 不收;混兩家 → 不收;多一個 BLAVE_* → 不收",
    argsOk("credentials", { env: { OKX_API_KEY: K, OKX_SECRET_KEY: S } }, true) === false
    && argsOk("credentials", { env: { OKX_API_KEY: K, BYBIT_SECRET_KEY: S } }, true) === false
    && argsOk("credentials", { env: { ...set("bybit"), BLAVE_API_KEY: K } }, true) === false);
  ok("① 值帶換行 / 空白金鑰 → 不收(passphrase 可以有空白)", argsOk("credentials", { env: { ...set("okx"), OKX_API_KEY: K + "\nX=1" } }, true) === false
    && argsOk("credentials", { env: { ...set("bingx"), BINGX_API_KEY: "has space" } }, true) === false && argsOk("credentials", { env: set("okx") }, true) === true);
  ok("① renderer 那條路(沒有 trusted)→ 這六家一律不收", ["okx", "bingx", "gateio", "bybit", "stockcoin", "bitget"].every((v) => argsOk("credentials", { env: set(v) }) === false && argsOk("credentials", { env: set(v) }, "true") === false));
  ok("① 解除綁定:六家的名字(含 OKX_PASSPHRASE、BITGET_PASSPHRASE)都拿得掉", ["okx", "bingx", "gateio", "bybit", "stockcoin", "bitget"].every((v) => argsOk("credentials_remove", { env: CC.venueEnvNames(v) }) === true));
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
      ok("①b INCOMPLETE_PAIR / UNKNOWN / no permission check / LIB_BROKEN → 各自的代號;舊 runtime 的 WITHDRAW_ENABLED 與看不懂的句子 → SEND_FAILED(遮過)",
        (await codeOf("ValueError: INCOMPLETE_PAIR: okx needs OKX_API_KEY + OKX_SECRET_KEY + OKX_PASSPHRASE together — not saved")) === "INCOMPLETE_PAIR"
        && (await codeOf("ValueError: UNKNOWN: okx's account answer could not be read — not saved")) === "UNKNOWN"
        && (await codeOf("ValueError: no permission check exists for okx on this workspace (run 更新 blave agent first) — not saved")) === "NO_CHECK"
        && (await codeOf("ValueError: LIB_BROKEN: lib/account_okx.py could not load (SyntaxError: invalid syntax) — not saved")) === "LIB_BROKEN"
        && (await codeOf("ValueError: WITHDRAW_ENABLED: 這把 okx 金鑰有提領權限,沒有儲存 (this okx key has withdrawal permission — not saved)")) === "SEND_FAILED"
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
  ok("② trEnvNames 與主行程 cloudcmd.venueEnvNames 同一組(解除綁定送的就是機器寫的)", ["binance", "okx", "bingx", "gateio", "bybit", "stockcoin", "bitget"].every((v) => J(trEnvNames(v)) === J(CC.venueEnvNames(v)))
    && J(trEnvNames("paper")) === J(["PAPER_API_KEY", "PAPER_SECRET_KEY", "PAPER_BOUND_TS"]));
  ok("② 名字表與主行程那份同一組交易所", J(Object.keys(CX_VENUES).sort()) === J(Object.keys(CC.CONNECT_VENUES).sort()) && CX_VENUES.okx.pass === true && !CX_VENUES.bybit.pass);
  ok("② 提領不再檢查(Wei 2026-10-15):沒有任何一家帶 noWdCheck,renderer 也不再提 cx.note.wdUnchecked", Object.keys(CX_VENUES).every((v) => !("noWdCheck" in CX_VENUES[v])) && !/noWdCheck|wdUnchecked|WITHDRAW_ENABLED/.test(src));
  ok("② 顯示名:Gate.io / OKX / BingX / StockCoin(首字大寫會寫錯)", trVenueLabel("gateio") === "Gate.io" && trVenueLabel("okx") === "OKX" && trVenueLabel("bingx") === "BingX" && trVenueLabel("stockcoin") === "StockCoin" && trVenueLabel("paper", true) === "cx.paperShort");
  ok("② 兩個視角都列七家,磚的順序同網頁與 landing(runtime 已在電腦版開放 Binance 以外這六家,寫入前讀一次帳戶;Bitget 0.1.29 經典帳戶)", J(cxVenuesFor("local")) === J(["binance", "bingx", "okx", "gateio", "bybit", "bitget", "stockcoin"]) && J(cxVenuesFor("cloud")) === J(cxVenuesFor("local")));

  // ── ③ 交給 Electron ──
  const bin = GATE.bin(SHELL, "③");
  if (!bin) { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  process.exit(red || r.status !== 0 ? 1 : 0);
})();
else {

const { app, BrowserWindow } = require("electron");
const os = require("os");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-venues-")));
const STUB = `window.__over = {}; window.__calls = [];
window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k === "platform" ? (window.__platform || "win32") : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
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
  const fields = () => js(`[...document.querySelectorAll("#cx-body input.f-input")].map((i) => i.id)`);
  // 選一家 = 點那塊磚(0.1.52 案一);已經在某一家就先按「換一家」回磚
  const pick = (v) => js(`(() => { if ($("cx-change")) $("cx-change").click(); const b = $("cx-tile-" + ${J(v)}); if (b) b.click(); })()`);
  const tiles = () => js(`[...document.querySelectorAll("#cx-body .cx-tile")].map((b) => b.id.replace("cx-tile-", ""))`);
  const fill = (o) => js(`(() => { for (const [id, v] of Object.entries(${J(o)})) { const i = $(id); i.value = v; i.dispatchEvent(new Event("input")); } })()`);

  // 雲端視角
  await js(`(() => { trPollSoon = () => {}; trPoll = async () => {};
    TR_BAGS.cloud.st = { alive: true, cloud: { code: "OK", machine: { state: "running", public_ip: "203.0.113.9" }, strategies: [] }, report: {} };
    if (ENV.cur !== "cloud") envSwitch("cloud"); cxModalOpen(null, null), (($m) => { if ($m && !$m.checked) { $m.checked = true; $m.dispatchEvent(new Event("change")); } })($("cx-mode-real")); })()`);
  await wait(150);
  const cloudOpts = await tiles();
  ok("③ 雲端視角(不預選、沒有主鈕;模擬在框腳):七塊磚(Binance / BingX / OKX / Gate.io / Bybit / Bitget / StockCoin)+ 台灣期貨那一組的群益(renderer/capital.js)",
    J(cloudOpts) === J(["binance", "bingx", "okx", "gateio", "bybit", "bitget", "stockcoin", "capital"]) && (await js(`$("cx-go").hidden && !$("cx-paper").hidden && document.activeElement === $("cx-tile-binance")`)));
  const labels = await js(`[...document.querySelectorAll("#cx-body .cx-tile .n")].map((n) => n.textContent)`);
  const groups = await js(`[...document.querySelectorAll("#cx-body .cx-grp")].map((g) => g.textContent)`);
  const capL = await js(`[t("cap.venue"), t("cap.group.tw")]`);
  ok("③ 磚上是交易所的正式名字;群益(字串表的名字)在自己那一組", J(labels) === J(["Binance", "BingX", "OKX", "Gate.io", "Bybit", "Bitget", "StockCoin", capL[0]]) && groups.length === 2 && groups[1] === capL[1] && capL[0] !== "cap.venue");
  const byVenue = {};
  for (const v of ["okx", "bingx", "gateio", "bybit", "stockcoin", "bitget"]) { await pick(v); byVenue[v] = await fields(); }
  ok("③ OKX、Bitget 三格(API Key / Secret Key / Passphrase);BingX / Gate.io / Bybit / StockCoin 兩格", J(byVenue.okx) === J(["cx-api", "cx-secret", "cx-pass"])
    && J(byVenue.bitget) === J(["cx-api", "cx-secret", "cx-pass"])
    && ["bingx", "gateio", "bybit", "stockcoin"].every((v) => J(byVenue[v]) === J(["cx-api", "cx-secret"])));
  await pick("okx");
  const ph = await js(`(() => { const h = $("cx-pass-hint"); return h ? [h.textContent, $("cx-pass").getAttribute("aria-describedby"), h.closest("label") === $("cx-pass").closest("label")] : null; })()`);
  ok("③ OKX 的 Passphrase 欄下面一行說明(不是登入密碼),欄位用 aria-describedby 指到它(設計稽核 005 第 10 條)",
    !!ph && ph[0] === (await js(`t("cx.passHint")`)) && /不是 OKX 的登入密碼/.test(await js(`STRINGS.zh["cx.passHint"]`)) && ph[1] === "cx-pass-hint" && ph[2] === true);
  await pick("bingx");
  ok("③ 沒有 Passphrase 的交易所:沒有那一行", await js(`!document.querySelector("#cx-body .cx-hint[id$='-hint']")`));
  // 步驟 1:權限句;雲端每一家(含 StockCoin)都常駐白名單那句與主機 IP(Wei 11-10:雲端寫入前不查非 Binance 金鑰,被拒那一刻等不到)
  const step1 = () => js(`(() => { const s = document.querySelector("#cx-body .cx-step .cx-step-b"); return s ? { hint: [...s.querySelectorAll(".cx-hint")].map((p) => p.textContent), chip: !!s.querySelector(".cx-chip"), kp: !!$("cx-keypage"), ip: (s.querySelector(".cx-chip .v") || {}).textContent || null } : null; })()`);
  const g1 = (await pick("gateio"), await step1()), o1 = (await pick("okx"), await step1()), b1 = (await pick("binance"), await step1()), s1 = (await pick("stockcoin"), await step1());
  const [permF, permT, lineC] = await js(`[t("cx.perm.futures"), t("cx.perm"), t("cx.ip.lineCloud")]`);
  const ipLine = (x, perm, line) => x.hint.length === 1 && x.hint[0].indexOf(perm) === 0 && x.hint[0].indexOf(line) > 0 && x.chip && x.ip === "203.0.113.9";
  ok("③ 雲端步驟 1:Gate.io／Binance 講合約交易、OKX 講交易;每一家(含 StockCoin)都接「白名單貼雲端主機的 IP」＋主機 IP;StockCoin 沒有建金鑰鈕",
    ipLine(g1, permF, lineC) && ipLine(o1, permT, lineC) && ipLine(b1, permF, lineC) && ipLine(s1, permT, lineC)
    && g1.kp && o1.kp && b1.kp && !s1.kp, { gateio: g1, okx: o1, binance: b1, stockcoin: s1 });
  { // 主機回報不出 IP:非 Binance 也照出灰 chip(讀不到雲端主機的 IP),不整句消失
    await run(`TR_BAGS.cloud.st.cloud.machine.public_ip = null; TR_BAGS.cloud.sig.cxm = null; cxModalPaint()`);
    const o2 = (await pick("okx"), await step1()), none = await js(`t("cx.ip.cloudNone")`);
    ok("③ 雲端讀不到主機 IP:OKX 步驟 1 照出白名單那句與灰 chip「讀不到雲端主機的 IP」", o2.hint[0].indexOf(lineC) > 0 && o2.chip && o2.ip === none
      && (await js(`!!document.querySelector("#cx-body .cx-step .cx-chip.is-empty")`)), o2);
    await run(`TR_BAGS.cloud.st.cloud.machine.public_ip = "203.0.113.9"; TR_BAGS.cloud.sig.cxm = null; cxModalPaint()`); }
  { // 雲端〔到 OKX 建金鑰〕:開頁同時把主機 IP 寫進剪貼簿、鈕旁講「IP 已複製」(同網頁,每一家都是)
    await pick("okx");
    await run(`window.__clip = []; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (x) => { window.__clip.push(x); } } }); $("cx-keypage").click()`);
    await wait(100);
    const kp = await js(`({ clip: window.__clip, said: $("cx-keypage").parentNode.querySelector(".cx-said").textContent, open: window.__calls.filter((c) => c[0] === "openExternal").map((c) => c[1][0]).pop() })`);
    ok("③ 雲端〔到 OKX 建金鑰〕:開 OKX 的 API 頁、主機 IP 進剪貼簿、講「IP 已複製」", J(kp.clip) === J(["203.0.113.9"]) && kp.said === (await js(`t("cx.ip.copiedOpen")`)) && kp.open === "https://www.okx.com/account/my-api", kp); }
  ok("③ 三格都是密碼欄、不自動完成", await js(`[...document.querySelectorAll("#cx-body input.f-input")].length > 0 && [...document.querySelectorAll("#cx-body input.f-input")].every((i) => i.type === "password" && i.autocomplete === "off")`));
  await pick("okx");
  await fill({ "cx-api": "not-a-real-key-okx", "cx-secret": "not-a-real-secret-okx", "cx-pass": "not a real passphrase" });
  await run(`window.__over.cloudConnect = async (a) => ({ ok: true, code: "OK", detail: {} })`);
  await js(`$("cx-go").click()`); await wait(300);
  const sent = await js(`window.__calls.filter((c) => c[0] === "cloudConnect").map((c) => c[1][0])`);
  const lang = await js(`LANG`);
  ok("③ 雲端送出的形狀:{ venue: okx, apiKey, secret, passphrase, lang }(第一趟不帶 keyChangeCode)", sent.length === 1 && !("keyChangeCode" in sent[0] && sent[0].keyChangeCode !== undefined) && J(sent[0]) === J({ venue: "okx", apiKey: "not-a-real-key-okx", secret: "not-a-real-secret-okx", passphrase: "not a real passphrase", lang }) && (lang === "zh" || lang === "en"));
  ok("③ 送出成功:框關掉、畫面這邊的金鑰清空(CXF 與 DOM 都沒有)", await js(`$("cx-scrim").hidden && CXF.apiKey === "" && CXF.secret === "" && CXF.passphrase === "" && !document.querySelector("#cx-body input")`));

  // 雲端被拒 = 主機拒絕這個指令(設計稽核 005 第 2 條):講主機、帶 detail.error;不是「OKX 沒有接受這把金鑰：—」
  const errOf = () => js(`($("cx-body").querySelector(".plan-err") || {}).textContent || ""`);
  await js(`cxModalOpen(null, null)`); await wait(100); await pick("okx");
  await fill({ "cx-api": "not-a-real-key-okx", "cx-secret": "not-a-real-secret-okx", "cx-pass": "not a real passphrase" });
  await run(`window.__over.cloudConnect = async () => ({ ok: false, code: "REJECTED", detail: { error: "unsupported venue: okx" } })`);
  await js(`$("cx-go").click()`); await wait(300);
  const cRej = await errOf();
  ok("③ 雲端 REJECTED:句子是「雲端主機沒有接受這個指令(原因)」,原因是 detail.error、不是「—」;主機拒指令不接 IP 白名單那句", cRej === (await js(`t("tr.cloud.cmdRejected", { err: "unsupported venue: okx" })`)) && !/沒有接受這把金鑰/.test(cRej));
  await run(`window.__over.cloudConnect = async () => ({ ok: false, code: "REJECTED", detail: { error: "ValueError: REJECTED: okx did not accept this key (AccountModeError: OKX 帳戶模式不支援合約 [okx_account_mode] (OKX acctLv=1)) — not saved" } })`);
  await js(`$("cx-go").click()`); await wait(300);
  ok("③ 雲端 REJECTED 帶 [okx_account_mode]:講怎麼改帳戶模式", (await errOf()) === (await js(`t("cx.err.okxMode")`)));
  await js(`cxModalClose(false)`); await wait(100);

  // 這台電腦
  await js(`(() => { window.__platform = "darwin"; window.__over.binanceIp = async () => "198.51.100.7"; envSwitch("local"); TR_BAGS.local.st = { alive: true, report: { venues: {} } }; cxModalOpen(null, null); })()`);
  await wait(150);
  ok("③ 這台電腦是 Mac:七塊加密貨幣磚,台灣期貨那組不出磚、原位講 cx.macTw", J(await tiles()) === J(["binance", "bingx", "okx", "gateio", "bybit", "bitget", "stockcoin"])
    && (await js(`(document.querySelector("#cx-body .cx-macnote") || {}).textContent === t("cx.macTw")`)));
  await js(`(() => { cxModalClose(false); window.__platform = "win32"; cxModalOpen(null, null); })()`); await wait(150);
  // 這台電腦的「台灣期貨」組(Windows):群益本機受 CAPL_LOCAL_ON 管、統一受 PRES_LOCAL_ON 管(群益在前,同 mockup);兩個都關時那一組整個不出
  ok("③ 這台電腦(Windows):七塊磚" + (presOn ? " + 台灣期貨有統一" : ";PRES_LOCAL_ON 關著 → 沒有統一") + (caplOn ? "、群益本機" : "(CAPL_LOCAL_ON 關著 → 沒有群益)"),
    J(await tiles()) === J(["binance", "bingx", "okx", "gateio", "bybit", "bitget", "stockcoin"].concat(caplOn ? ["capital"] : [], presOn ? ["president"] : []))
    && J(await js(`[...document.querySelectorAll("#cx-body .cx-grp")].map((g) => g.textContent)`)) === J(await js(presOn || caplOn ? `[t("cx.group.crypto"), t("cap.group.tw")]` : `[t("cx.group.crypto")]`)));
  if (caplOn) {
    await pick("capital");
    ok("③ CAPL_LOCAL_ON 開著:這台電腦選 capital → 群益本機的框(標題「連接群益期貨」、這台電腦);頭列有「換一家」、框腳不出模擬", (await js(`CXF.venue`)) === "capital"
      && (await js(`$("cx-title").textContent === t("cap.title") && !$("cx-env").hidden && !!$("cx-change") && $("cx-paper").hidden`)));
  }
  await pick("okx"); await wait(100);
  ok("③ 換到 OKX:主鈕在", await js(`!$("cx-go").hidden`));
  { const lo = await step1();
    ok("③ 這台電腦的 OKX:步驟 1 只有權限句,不常駐 IP(被拒才帶,spec §4)", !!lo && lo.hint.length === 1 && lo.hint[0] === permT && !lo.chip, lo); }
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
  await js(`cxModalOpen(null, null)`); await wait(100); await pick("okx");
  await fill({ "cx-api": "not-a-real-key-okx", "cx-secret": "not-a-real-secret-okx", "cx-pass": "not a real passphrase" });
  await run(`window.__over.venueConnect = async () => ({ ok: false, code: "REJECTED", detail: { reason: "RuntimeError: 50113 Invalid Sign" } })`);
  await js(`$("cx-go").click()`); await wait(300);
  const failMsg = await js(`($("cx-body").querySelector(".plan-err") || {}).textContent || ""`);
  ok("③ 拒絕:框留著、講 OKX 沒有接受這把金鑰與原因(不是 Binance 的句子)", !(await js(`$("cx-scrim").hidden`)) && /OKX/.test(failMsg) && /50113 Invalid Sign/.test(failMsg) && !/Binance/.test(failMsg));
  ok("③ 拒絕(Binance 以外):同一個訊息槽多接「設了 IP 白名單的話，加進這台電腦的 IP」＋這台電腦的 IP", failMsg.indexOf(await js(`t("cx.chk.ipAdd")`)) > 0
    && (await js(`[...$("cx-body").querySelectorAll(".plan-err .cx-chip .v")].map((v) => v.textContent).join()`)) === "198.51.100.7");
  const say = async (code) => { await run(`window.__over.venueConnect = async () => ({ ok: false, code: ${J(code)}, detail: {} })`); await js(`$("cx-go").click()`); await wait(300);
    return js(`($("cx-body").querySelector(".plan-err") || {}).textContent || ""`); };
  ok("③ 沒填齊(OKX):講三格要一起給", (await say("INCOMPLETE_PAIR")).indexOf(await js(`t("cx.chk.incompletePass")`)) >= 0);
  ok("③ UNKNOWN / NO_CHECK:那一家的句子", (await say("UNKNOWN")) === (await js(`t("cx.chk.unknownV", { venue: "OKX" })`)) && (await say("NO_CHECK")) === (await js(`t("cx.chk.noCheckV", { venue: "OKX" })`)));
  { await run(`window.__over.venueConnect = async () => ({ ok: false, code: "LIB_BROKEN", detail: { reason: "lib/account_okx.py could not load (SyntaxError: invalid syntax)" } })`); await js(`$("cx-go").click()`); await wait(300);
    const lb = await js(`($("cx-body").querySelector(".plan-err") || {}).textContent || ""`);
    ok("③ LIB_BROKEN:講這台電腦的程式載入失敗、帶原因、請回報;不是 UNKNOWN 那句、不怪交易所", lb === (await js(`t("cx.chk.libBrokenV", { venue: "OKX", reason: "lib/account_okx.py could not load (SyntaxError: invalid syntax)" })`))
      && lb !== (await js(`t("cx.chk.unknownV", { venue: "OKX" })`)) && /這台電腦|this computer/.test(lb)); }
  await fill({ "cx-api": "not-a-real-key-okx", "cx-secret": "not-a-real-secret-okx", "cx-pass": "not a real passphrase" });   // 換家會清欄位;下面的等待狀態要它們在
  await run(`window.__over.venueConnect = async () => ({ ok: false, code: "REJECTED", detail: { reason: "AccountModeError: OKX 帳戶模式不支援合約 [okx_account_mode] (OKX acctLv=1)" } })`);
  await js(`$("cx-go").click()`); await wait(300);
  ok("③ 本機 REJECTED 帶 [okx_account_mode]:講怎麼改帳戶模式,不出原文", (await js(`($("cx-body").querySelector(".plan-err") || {}).textContent || ""`)) === (await js(`t("cx.err.okxMode")`)));

  // ── 等待狀態(spec-desktop-006 §1.3 A):鈕內圓環 + 「串接中…」、狀態槽講在等什麼、aria-busy;結果回來那句就消失 ──
  // 訊息槽 = #cx-body 底下直屬的那個 role=status;〔到 X 建金鑰〕與 IP chip 旁邊各有一個(「IP 已複製」),querySelector 會先抓到它們
  const slotOf = () => js(`(() => { const s = $("cx-body").querySelector(":scope > [role=status]"); return s ? s.textContent : null; })()`);
  await run(`window.__over.venueConnect = () => new Promise((r) => { window.__release = r; })`);
  await js(`$("cx-go").click()`); await wait(200);
  const pend = await js(`(() => { const go = $("cx-go"), sp = go.querySelector(".spin16"), slot = $("cx-body").querySelector(":scope > [role=status]");
    return { spin: !!sp && sp.getAttribute("aria-hidden") === "true" && go.firstChild === sp, label: go.textContent.trim(),
      busy: go.classList.contains("is-busy") && go.getAttribute("aria-disabled") === "true" && !go.disabled, bodyBusy: $("cx-body").getAttribute("aria-busy"),
      marks: slot ? slot.querySelectorAll(".fault-mark, .spin16").length : -1, ro: $("cx-api").readOnly && $("cx-change").disabled && $("cx-paper").disabled }; })()`);
  ok("③ pending:鈕內圓環在字前(aria-hidden)+「串接中…」、is-busy + aria-disabled(不是 disabled)、#cx-body aria-busy、欄位唯讀、「換一家」與框腳模擬停用",
    pend.spin && pend.label === (await js(`t("cx.connecting")`)) && pend.busy && pend.bodyBusy === "true" && pend.ro);
  const pendSlot = await slotOf();
  ok("③ pending:狀態槽講「正在向 OKX 確認這把金鑰」,不加記號、不加第二個圓環", pendSlot === (await js(`t("cx.gate.checking", { venue: "OKX" })`)) && pend.marks === 0, { slot: pendSlot, marks: pend.marks });
  // 20 秒逾時分兩句(§1.3 C):TIMEOUT = 指令被撤回、沒存 → 紅句;UNKNOWN_RESULT = daemon 收走了、可能還在查 → 灰句
  await js(`window.__release({ ok: false, code: "SEND_FAILED", detail: { error: "TIMEOUT" } })`); await wait(300);
  const to = await js(`(() => { const go = $("cx-go"), p = $("cx-body").querySelector(".plan-err"); return { spin: !!go.querySelector(".spin16"), label: go.textContent.trim(), dis: go.getAttribute("aria-disabled"),
    bodyBusy: $("cx-body").getAttribute("aria-busy"), msg: p ? p.textContent : "", calm: !!p && p.classList.contains("is-calm"), api: $("cx-api").value, open: !$("cx-scrim").hidden }; })()`);
  to.slot = await slotOf();
  ok("③ TIMEOUT:紅句「下單機 20 秒內沒有處理、沒有儲存」取代 pending 句(不漏 TIMEOUT 代號)、鈕還原可按、欄位保留、框留著",
    to.msg === (await js(`t("cx.chk.engineTimeout")`)) && to.slot === to.msg && !/TIMEOUT/.test(to.msg) && !to.calm
    && !to.spin && to.label === (await js(`t("cx.connect")`)) && to.dis === "false" && to.bodyBusy === "false" && to.api === "not-a-real-key-okx" && to.open, to);
  await run(`window.__over.venueConnect = async () => ({ ok: false, code: "SEND_FAILED", detail: { error: "UNKNOWN_RESULT" } })`);
  await js(`$("cx-go").click()`); await wait(300);
  const un = await js(`(() => { const p = $("cx-body").querySelector(".plan-err"); return { msg: p ? p.textContent : "", calm: !!p && p.classList.contains("is-calm"), open: !$("cx-scrim").hidden, dis: $("cx-go").getAttribute("aria-disabled") }; })()`);
  ok("③ UNKNOWN_RESULT:灰句帶 OKX、叫人先到 設定 › 帳戶 看、鈕可按、框留著", un.msg === (await js(`t("cx.chk.gateSlow", { venue: "OKX" })`)) && un.calm && un.open && un.dis === "false");
  // 灰句期間輪詢的報告出現了這一家 → 走 ok 那條路自動關框(trPoll 每輪叫 cxGateSlowSync;這裡 trPoll 是空殼,直接叫)
  const venuesOf = (id) => `{ venues: { ${id}: { credentials: true, pair: true, order: true, account: true } } }`;
  await run(`window.__over.tradeStatus = async () => TR_BAGS.local.st; TR_BAGS.local.st = { alive: true, report: ${venuesOf("bybit")} }; cxGateSlowSync()`); await wait(200);
  ok("③ 灰句期間報告出現的是別家(Bybit):框不關", !(await js(`$("cx-scrim").hidden`)));
  // tradeStatus 還沒回來就要關:cxConnected 等它回來才關框,而 trPoll 在 cxGateSlowSync 之後接著 cxModalPaint,晚關就閃一次閒置表單
  await run(`window.__over.tradeStatus = () => new Promise((r) => { window.__relStatus = r; }); TR_BAGS.local.st = { alive: true, report: ${venuesOf("okx")} }; cxGateSlowSync(); window.__closedSync = $("cx-scrim").hidden && !document.querySelector("#cx-body input")`);
  ok("③ 灰句期間報告出現了 OKX:tradeStatus 回來前框就關了、欄位已丟(不閃一次閒置表單)", await js(`window.__closedSync`));
  await run(`window.__relStatus(TR_BAGS.local.st); window.__over.tradeStatus = async () => TR_BAGS.local.st`); await wait(300);
  ok("③ 灰句期間報告出現了 OKX:框自動關、金鑰清空、講「串接成功」", await js(`$("cx-scrim").hidden && CXF.apiKey === "" && CXF.secret === "" && CXF.passphrase === ""`)
    && (await js(`$("sr-live").textContent`)) === (await js(`t("cx.linkOk")`)));
  ok("③ trPoll 每一輪都叫 cxGateSlowSync(源碼)", /cxGateSlowSync\(\);\s*\n\s*if \(!\$\("cx-scrim"\)\.hidden\) cxModalPaint\(\);/.test(fs.readFileSync(path.join(SHELL, "renderer", "trade.js"), "utf8")));
  // 模擬交易那條路(0.1.52 案一):框腳〔先用模擬交易〕;磚那一態沒有主鈕,所以等待時主鈕不出、框腳那顆與磚停用,
  // 訊息槽只講「串接中…」,**不**出現 cx.gate.checking(本機寫 .env,次秒完成)
  // 上一段的報告留著 OKX 帳戶 → 框會鎖在已綁定的那一家;模擬那條要的是還沒綁任何帳戶的第一次
  await run(`TR_BAGS.local.st = { alive: true, report: { venues: {} } }`);
  await js(`cxModalOpen(null, null)`); await wait(100);
  await run(`window.__calls.length = 0; window.__release = null; window.__over.tradeSend = () => new Promise((r) => { window.__release = r; })`);
  await js(`$("cx-paper").click()`); await wait(200);
  const pp = await js(`(() => ({ venue: CXF.venue, goHidden: $("cx-go").hidden, footOff: !$("cx-paper").hidden && $("cx-paper").disabled,
    tilesOff: [...document.querySelectorAll("#cx-body .cx-tile")].every((b) => b.disabled), bodyBusy: $("cx-body").getAttribute("aria-busy"), pending: typeof window.__release === "function",
    sent: window.__calls.filter((c) => c[0] === "tradeSend" && c[1][0] === "credentials").map((c) => Object.keys((c[1][1] || {}).env || {}).sort()) }))()`);
  pp.slot = await slotOf();
  ok("③ 模擬交易 pending(框腳〔先用模擬交易〕):送 PAPER_* 那組、主鈕不出、框腳那顆與磚停用、狀態槽講「串接中…」(沒有 cx.gate.checking)",
    pp.venue === "paper" && pp.pending && J(pp.sent) === J([["PAPER_API_KEY", "PAPER_BOUND_TS", "PAPER_SECRET_KEY"]]) && pp.goHidden && pp.footOff && pp.tilesOff && pp.bodyBusy === "true"
    && pp.slot === (await js(`t("cx.connecting")`)) && pp.slot !== (await js(`t("cx.gate.checking", { venue: "OKX" })`)), pp);
  if (pp.pending) await js(`window.__release({ ok: true })`);
  await wait(300);
  const pdone = await js(`({ closed: $("cx-scrim").hidden, said: $("sr-live").textContent })`);
  ok("③ 模擬交易存好:框關、講「已連接」", pdone.closed && pdone.said === (await js(`t("cx.connected")`)), pdone);

  // ── 設定 › 帳戶 那一列(§1.3 D):報告還沒有這一家的帳戶條目 → 圓環 + 「串接中…」;讀到帳戶 → 綠點、圓環消失 ──
  const setRow = () => js(`(() => { const st = $("tr-set").querySelector(".cx-row .cn-st"); return st ? { cls: st.className, spin: !!st.querySelector(".spin16"), dot: !!st.querySelector(".dot"), text: st.textContent } : null; })()`);
  await run(`window.__over.tradeSend = async () => ({ ok: true }); TR_BAGS.local.st = { alive: true, report: ${venuesOf("okx")} }; TR.sig.set = null; trPaintSet()`); await wait(100);
  const linking = await setRow();
  ok("③ 帳戶列(還沒讀到帳戶):.cn-st.cx-wait、圓環 + 「串接中…」", !!linking && /\bcx-wait\b/.test(linking.cls) && linking.spin && !linking.dot && linking.text === (await js(`t("cx.connecting")`)));
  await run(`TR_BAGS.local.st.report.account = { venues: { okx: { ok: true, equity: 1 } } }; TR.sig.set = null; trPaintSet()`); await wait(100);
  const linked = await setRow();
  ok("③ 帳戶列(讀到帳戶):綠點 + 「已連接」,圓環消失", !!linked && !/\bcx-wait\b/.test(linked.cls) && linked.dot && !linked.spin && linked.text === (await js(`t("cx.connected")`)));
  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
}
