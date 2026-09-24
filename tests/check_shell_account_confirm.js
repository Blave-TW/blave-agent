// 換金鑰後「這還是同一個帳戶嗎？」(spec-account-confirm-2026-09-24 + 機器端契約,契約優先)。
//   ① 允許清單:book_account_confirm 在 daemon.js UI_COMMANDS、雲端白名單(ENV_CLOUD_CMDS / main.js CLOUD_SHIPPED);
//      參數剛好 { venue, same:boolean },多一個欄位、帶金鑰、same 不是布林都不收
//   ② 真的開 index.html(隨包 Electron,window.blave 換成假的):報告帶 account_guard.book_hold(ask)+ halt.holds_all
//      → 狀態行「已自動暫停 · 換了 OKX 的金鑰後…」、主鈕「確認帳戶」、沒有「解除暫停」;按下去開確認框:
//      主鈕「同一個帳戶」、次鈕「不同帳戶」(不是紅的)、焦點在取消;選了只送 book_account_confirm {venue, same}
//      → 「確認中…」→ 報告沒有 book_hold 了才收斂 → 主鈕回「啟動下單」、狀態行換成答完那一句
//   ③ 還沒確認時送出的啟動:機器回 "held: …" → 不顯示執行中、過場收掉、講為什麼沒恢復、不補 restart_reconciler
//   ④ ask:false(網路類錯誤)不問;holds_all 決定 A / A′,欄位不在才看來源名單
// 金鑰全是 not-a-real-*。跑法:node tests/check_shell_account_confirm.js(找不到 shell/node_modules 的 Electron,② 起就 SKIP)
const path = require("path"), fs = require("fs");
const SHELL = path.join(__dirname, "..", "shell");
const J = JSON.stringify;
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };

if (!process.versions.electron) {
  // ── ① 允許清單 ──
  const { UI_COMMANDS, argsOk } = require(path.join(SHELL, "daemon.js"));
  ok("① daemon.js UI_COMMANDS 有 book_account_confirm", UI_COMMANDS.has("book_account_confirm"));
  ok("① 參數:{ venue, same:true|false } 收", argsOk("book_account_confirm", { venue: "okx", same: true }) && argsOk("book_account_confirm", { venue: "gateio", same: false }));
  ok("① 參數:少欄位 / 多欄位 / same 不是布林 / venue 壞形狀 / 夾帶金鑰 一律不收", [{ venue: "okx" }, { same: true }, { venue: "okx", same: "true" }, { venue: "okx", same: 1 },
    { venue: "../x", same: true }, { venue: "OKX", same: true }, { venue: "okx", same: true, OKX_API_KEY: "not-a-real-key" }, ["okx"], null].every((a) => !argsOk("book_account_confirm", a)));
  const tr = fs.readFileSync(path.join(SHELL, "renderer", "trade.js"), "utf8"), main = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
  ok("① 雲端:ENV_CLOUD_CMDS 與主行程 CLOUD_SHIPPED 都有它", /const ENV_CLOUD_CMDS = \[[^\]]*"book_account_confirm"/.test(tr) && /const CLOUD_SHIPPED = \[[^\]]*"book_account_confirm"/.test(main));
  const bin = path.join(SHELL, "node_modules", ".bin", "electron");
  if (!fs.existsSync(bin)) { console.log("SKIP  ② 找不到 shell/node_modules 的 Electron"); console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  process.exit(red || r.status !== 0 ? 1 : 0);
} else {

const { app, BrowserWindow } = require("electron");
const os = require("os");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-acct-")));
const STUB = `window.__over = {}; window.__calls = [];
window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : async (...a) => { window.__calls.push([k, a]); if (k in window.__over) return window.__over[k](...a);
      return ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
        listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" } })[k]; } });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 報告(形狀照 runtime/portfolio_reporter.build_report;數字是編的)
const now = Math.floor(Date.now() / 1000);
const report = (o) => Object.assign({ venues: { okx: { credentials: true, pair: true, order: true, account: true } },
  account: { read_at: now, venues: { okx: { ok: true, equity: 1000, currency: "USDT" } } },
  config: { amounts: { btc_trend: 500 } }, reconciler: { alive: false, heartbeat_at: now - 5 }, command_listener: { alive: true },
  halt: { halted: true, source: "reconciler", reason: "okx: key changed, account unreadable", holds_all: true },
  account_guard: { venue: "okx", book_hold: { venue: "okx", reason: "okx key changed; account id unreadable", since: now - 60, ask: true, halted: true } } }, o);

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  setTimeout(() => { console.log("FAIL  ② 逾時(60 秒內沒跑完)"); app.exit(1); }, 60000).unref();
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1200);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const run = (s) => w.webContents.executeJavaScript("(() => { " + s + "; return 0; })()", true);
  const setReport = (r) => run(`window.__st = { alive: true, report: ${J(r)} }; window.__over.tradeStatus = async () => window.__st`);
  const poll = async () => { await js(`trPoll().then(() => 0)`); await wait(150); };
  const head = () => js(`({ go: $("tr-go") ? $("tr-go").textContent : null, aria: $("tr-go") ? $("tr-go").getAttribute("aria-disabled") : null, dis: $("tr-go") ? $("tr-go").disabled : null,
    rel: !!$("tr-go-rel"), desc: $("tr-desc").textContent, alert: ($("tr-alert") && !$("tr-alert").hidden) ? $("tr-alert").textContent : "" })`);
  const T = (k, v) => js(`t(${J(k)}${v ? ", " + J(v) : ""})`);

  await setReport(report({}));
  await run(`envSwitch("local"); trOpen()`); await poll();
  let h = await head();
  ok("② 狀態行:已自動暫停 · 換了 OKX 的金鑰後…(不出英文 reason)", h.desc.startsWith((await T("env.st.autoPaused")) + " · " + (await T("tr.acct.reason", { v: "OKX" }))) && !/unreadable/.test(h.desc));
  ok("② 主鈕是「確認帳戶」、按得到;沒有「解除暫停」", h.go === (await T("tr.acct.btn")) && h.aria === "false" && !h.dis && !h.rel);
  await js(`$("tr-go").click()`); await wait(200);
  const box = await js(`({ open: !$("del-scrim").hidden, title: $("del-title").textContent, ok: $("del-ok").textContent, alt: $("del-alt").hidden ? null : $("del-alt").textContent,
    danger: $("del-alt").classList.contains("cf-alt-danger"), focus: document.activeElement && document.activeElement.id, body: $("del-body").textContent })`);
  ok("② 確認框:標題、主鈕「同一個帳戶」、次鈕「不同帳戶」", box.open && box.title === (await T("tr.acct.title", { v: "OKX" })) && box.ok === (await T("tr.acct.same")) && box.alt === (await T("tr.acct.diff")));
  ok("② 次鈕不是紅的、預設焦點在取消", !box.danger && box.focus === "del-cancel");
  ok("② 內文三段(為什麼問、同一個的後果、不同的後果)", [await T("tr.acct.body", { v: "OKX" }), await T("tr.acct.ifSame", { v: "OKX" }), await T("tr.acct.ifDiff", { v: "OKX" })].every((x) => box.body.includes(x)));
  await run(`window.__calls.length = 0; window.__over.tradeSend = async () => ({ ok: true, result: { venue: "okx", same: false, outcome: "reset" } })`);
  await js(`$("del-alt").click()`); await wait(300);
  const sends = await js(`window.__calls.filter((c) => c[0] === "tradeSend").map((c) => [c[1][0], c[1][1]])`);
  ok("② 選「不同帳戶」:只送 book_account_confirm { venue: okx, same: false },沒有別的指令、沒有祕密", J(sends) === J([["book_account_confirm", { venue: "okx", same: false }]]));
  await poll(); h = await head();
  ok("② 報告還帶著 book_hold:主鈕「確認中…」、停用(aria)、狀態行不講執行中", h.go === (await T("tr.acct.confirming")) && h.aria === "true" && !h.desc.includes(await T("tr.autoOn")));
  await setReport(report({ account_guard: { venue: "okx", book_hold: null }, halt: { halted: true, source: "reconciler", holds_all: false } })); await poll();
  h = await head();
  ok("② book_hold 不見了才收斂:主鈕回「啟動下單」,HALT 照舊", h.go === (await T("tr.start")) && h.aria === "false" && h.desc.startsWith(await T("tr.halted")));
  ok("② 答完那一句(不同帳戶 = 從零開始,會在這個帳戶重新開部位)", h.desc.includes(await T("tr.acct.doneDiff", { v: "OKX" })));

  // ③ 還沒確認時的啟動:機器回 held
  await setReport(report({ account_guard: { venue: "okx", book_hold: null }, halt: { halted: true, source: "reconciler", holds_all: false } })); await poll();
  await run(`window.__calls.length = 0; window.__over.tradeSend = async (cmd) => cmd === "resume" ? { ok: true, result: "held: okx awaits book_account_confirm" } : { ok: true }`);
  await js(`$("tr-go").click()`); await wait(200);
  await js(`$("del-ok").click()`); await wait(400);
  h = await head();
  const cmds = await js(`window.__calls.filter((c) => c[0] === "tradeSend").map((c) => c[1][0])`);
  ok("③ 啟動被 held:送了 resume、沒有補 restart_reconciler", J(cmds) === J(["resume"]));
  ok("③ …當場收掉「啟動中…」(不等逾時)、停在已暫停、不講執行中,也不出「沒送到」那種錯", !(await js(`!!TR.pending`)) && h.desc.startsWith(await T("tr.halted"))
    && !h.desc.includes(await T("tr.autoOn")) && !h.desc.includes(await T("tr.starting")) && h.alert === "");
  ok("③ …讀屏唸那一題(tr.acct.reason,live region #sr-live),不另造新句子", (await js(`$("sr-live").textContent`)) === (await T("tr.acct.reason", { v: "OKX" })));
  // 機器拒絕回答(ok:false,"ValueError: …"):過場收掉、講機器的原因(去掉 ValueError: 前綴)
  await setReport(report({})); await poll();
  await run(`window.__over.tradeSend = async () => ({ ok: false, error: "ValueError: this workspace lib keeps no per-account book — update the workspace" })`);
  await js(`$("tr-go").click()`); await wait(200); await js(`$("del-ok").click()`); await wait(400);
  h = await head();
  ok("③b 回答被機器拒絕:過場收掉、主鈕回「確認帳戶」,講機器的原因、沒有 ValueError: 前綴", !(await js(`!!TR.pending`)) && h.go === (await T("tr.acct.btn"))
    && h.alert.includes("this workspace lib keeps no per-account book") && !h.alert.includes("ValueError"));

  // ④ ask:false 不問;holds_all 決定 A / A′
  await run(`TR.acctDone = null; trAlert("")`);
  await setReport(report({ account_guard: { venue: "okx", book_hold: { venue: "okx", reason: "net", since: now, ask: false, halted: true } } })); await poll();
  h = await head();
  ok("④ ask:false(網路類):不問——主鈕是啟動下單、狀態行不出那一題", h.go === (await T("tr.start")) && !h.desc.includes(await T("tr.acct.reason", { v: "OKX" })));
  await setReport(report({ account_guard: { venue: "okx", book_hold: { venue: "okx", reason: "x", since: now } } })); await poll();
  h = await head();
  ok("④ 今天 reporter 送的形狀(只有 venue / reason / since,沒有 ask)照樣問:主鈕「確認帳戶」、狀態行出那一題", h.go === (await T("tr.acct.btn")) && h.desc.includes(await T("tr.acct.reason", { v: "OKX" })));
  await setReport(report({ account_guard: null, halt: { halted: true, source: "reconciler", holds_all: false } })); await poll();
  ok("④ holds_all:false(source 是 reconciler 也一樣)→ A「不開新倉;平倉停損照走」", (await head()).desc.includes(await T("tr.haltReason")));
  await setReport(report({ account_guard: null, halt: { halted: true, source: "web", holds_all: true } })); await poll();
  ok("④ holds_all:true(source 是 web 也一樣)→ A′「什麼單都不下」", (await head()).desc.includes(await T("tr.haltReasonAll")));
  await setReport(report({ account_guard: null, halt: { halted: true, source: "reconciler" } })); await poll();
  ok("④ 舊 runtime 沒有 holds_all:照來源名單(reconciler → A′)", (await head()).desc.includes(await T("tr.haltReasonAll")));
  const zh = await js(`[STRINGS.zh["tr.acct.reason"], STRINGS.zh["tr.acct.title"], STRINGS.en["tr.acct.btn"]]`);
  ok("字串:zh 全形標點、不出帳本 / book / reset / HALT;en 有", /，|。/.test(zh[0]) && !/帳本|book|reset|HALT/i.test(zh.join("")) && zh[2] === "Confirm account");

  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
}
