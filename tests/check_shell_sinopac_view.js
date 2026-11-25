// 永豐本機開通的狀態機(shell/renderer/sinopac.js 的純邏輯段,從原文切出來跑)+ 畫面用到的字串兩語都有。
//   sinopac_connect(runtime/sinopac_connect.py 寫的那一份)+ 畫面自己的狀態 → spec sinopac-connect-2026-11-17 §3 的哪一態。
//   逐一列舉 probe.state 的每個值、每種「在跑」、簽署那一列只在 not_signed 才出、STOP 檔的每個原因、模擬測試時段、
//   表單錯誤掛在哪一格、主鈕何時能按;事件列與 P1 升級跟 api level_for 同一條(capital、sinopac 150 分)。
// 跑法:node tests/check_shell_sinopac_view.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "sinopac.js"), "utf8");
const a = src.indexOf("/* ── 純邏輯"), b = src.indexOf("/* ── 純邏輯到此 ── */");
let red = 0; const ok = (n, c, got) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) { red++; if (got !== undefined) console.log("      got: " + JSON.stringify(got)); } };
if (a < 0 || b < 0) { console.log("FAIL  sinopac.js 找不到純邏輯段的記號"); process.exit(1); }
const head = src.slice(0, src.indexOf("let SP = spBlank();"));
const ctx = {}; vm.createContext(ctx);
vm.runInContext(head + "\n" + src.slice(a, b) + "\nthis.spcView = spcView; this.spBlank = spBlank; this.spRunning = spRunning; this.spSimOpen = spSimOpen; this.spSimNext = spSimNext;"
  + " this.spMsgPlace = spMsgPlace; this.spFormReady = spFormReady; this.spHm = spHm; this.spSimRow = spSimRow; this.SP_PROBE_VIEW = SP_PROBE_VIEW; this.SP_STOP_VIEW = SP_STOP_VIEW; this.SP_ERR_KEY = SP_ERR_KEY; this.spAcctErrKey = spAcctErrKey; this.SP_FRAME_ERR = SP_FRAME_ERR; this.SP_REFILL = SP_REFILL;"
  + " this.spEqView = typeof spEqView === \"function\" ? spEqView : null; this.spBusy = typeof spBusy === \"function\" ? spBusy : null; this.SP_EQ_WAIT_MS = typeof SP_EQ_WAIT_MS === \"number\" ? SP_EQ_WAIT_MS : null;", ctx);
const { spcView: spView, spRunning, spSimOpen, spSimNext, spMsgPlace, spFormReady, spHm, spSimRow } = ctx;

// 2026-11-18(週三)台北 10:00 = UTC 02:00
const NOW = Date.UTC(2026, 10, 18, 2, 0, 0), S = NOW / 1000;
const ui = (o) => Object.assign(ctx.spBlank(), { phase: "flow" }, o || {});
const sc = (o) => Object.assign({ v: 1, updated_at: S - 5, busy: null, setup: { status: "ok", at: S - 100 }, cert: { status: "ok", at: S - 90, not_after: "2028-10-15T15:59:59Z" },
  probe: { status: "idle", at: null }, sim: { status: "idle", at: null }, worker: { status: "idle", at: null } }, o || {});
const view = (c, u, now) => spView(c, u || ui(), { now: now || NOW });

ok("表單", view(null, ui({ phase: "form" })) === "f");
// 自動推進的三個入口
ok("元件沒裝 → r-setup", view(sc({ setup: { status: "idle", at: null } })) === "r-setup");
ok("裝好、沒登入過 → r-ready(spAdvance 送 probe)", view(sc()) === "r-ready");
ok("登入過而且已簽 → w-ready(spAdvance 送 start)", view(sc({ probe: { status: "ok", state: "ok", at: S - 3 } })) === "w-ready");
// 在跑
ok("setup running → r-setup;busy probe → r-login;sim running → s-run;sim review → s-review;worker running → w-run",
  view(sc({ setup: { status: "running", at: S - 2 } })) === "r-setup" && view(sc({ busy: "sinopac_local:probe" })) === "r-login"
  && view(sc({ sim: { status: "running", at: S - 2 } })) === "s-run" && view(sc({ sim: { status: "review", at: S - 2, checks: 1 } })) === "s-review"
  && view(sc({ worker: { status: "running", at: S - 2 } })) === "w-run");
ok("卡在 running 超過 25 分鐘不算在跑", spRunning(sc({ updated_at: S - 3600, probe: { status: "running", at: S - 3600 } }), null, NOW) === null);
ok("剛送、回報還沒動 → 那一步在跑", view(sc(), ui({ sent: { step: "probe", at: NOW } })) === "r-login");
// 登入失敗:每一類
const PF = (state, extra) => sc({ probe: Object.assign({ status: "failed", state, at: S - 3 }, extra || {}) });
ok("probe.state 每一類 → 對的態", JSON.stringify(["key", "no_futures", "cert", "too_many", "timeout", "clock", "version", "unknown", "not_open", "no_credentials", "weird"].map((s) => view(PF(s))))
  === JSON.stringify(["r-key", "r-nofut", "r-cert", "r-451", "r-net", "r-clock", "r-setup-fail", "r-unknown", "r-unknown", "r-unknown", "r-unknown"]));
ok("not_open 在雲端 → r-old(主機 runtime 開了、workspace 沒更新);本機照舊 r-unknown",
  spView(PF("not_open"), ui(), { now: NOW, cloud: true }) === "r-old" && view(PF("not_open")) === "r-unknown" && ctx.SP_ERR_KEY["r-old"] === "sp.err.hostOld");
ok("每個登入失敗態都有錯誤句(r-setup-fail 走 sp.s.setupFail)", Object.values(ctx.SP_PROBE_VIEW).every((v) => v === "r-setup-fail" || ctx.SP_ERR_KEY[v]));
// 簽署那一列只在 NOT_SIGNED
ok("not_signed、時段內 → s-ask;時段外(週六)→ s-closed", view(PF("not_signed")) === "s-ask" && view(PF("not_signed"), null, Date.UTC(2026, 10, 21, 2)) === "s-closed");
ok("機器說時段外(SIM_CLOSED)→ s-closed", view(PF("not_signed"), ui({ simClosed: true })) === "s-closed");
ok("審核 5 次沒過 → s-notyet;被退 → s-rej", view(sc({ probe: { status: "failed", state: "not_signed", at: S - 3 }, sim: { status: "failed", state: "not_yet", at: S - 3 } })) === "s-notyet"
  && view(sc({ probe: { status: "failed", state: "not_signed", at: S - 3 }, sim: { status: "failed", state: "rejected", at: S - 3 } })) === "s-rej");
ok("審核通過(probe ok)→ w-ready", view(sc({ probe: { status: "ok", state: "ok", at: S - 3 }, sim: { status: "passed", at: S - 3 } })) === "w-ready");
ok("簽署列:已簽的人看不到;讀到還沒簽之後才畫", spSimRow(sc({ probe: { status: "ok", state: "ok", at: S } }), "w-ready") === false
  && spSimRow(sc({ sim: { status: "ask", at: S } }), "s-ask") === true && spSimRow(sc({ sim: { status: "passed", at: S } }), "w-run") === true);
// 下單程式起來之後
ok("worker ok → done;worker failed → w-fail", view(sc({ probe: { status: "ok", state: "ok", at: S - 9 }, worker: { status: "ok", at: S - 3 } })) === "done"
  && view(sc({ probe: { status: "ok", state: "ok", at: S - 9 }, worker: { status: "failed", at: S - 3, error: "WORKER_FAILED" } })) === "w-fail");
const STOP = (reason, probeAt) => sc({ probe: { status: "ok", state: "ok", at: probeAt }, worker: { status: "ok", at: S - 500 }, login_stop: { reason, at: S - 100 } });
ok("STOP 檔每個原因 → 同一組登入失敗畫面(〔重新登入〕進來)", JSON.stringify(["KEY", "NO_FUTURES", "CERT", "CLOCK", "VERSION", "NOT_SIGNED", "UNKNOWN", "???"].map((r) => view(STOP(r, S - 600))))
  === JSON.stringify(["r-key", "r-nofut", "r-cert", "r-clock", "r-setup-fail", "s-notyet", "r-unknown", "r-unknown"]));
ok("比 STOP 新的確認登入過了 → 往下走(done)", view(STOP("KEY", S - 10)) === "done");
// 時段
ok("雲端時段到 18:00;機器給的 next_open_at 還沒到 → s-closed;18 點後 tw_ip → s-twip",
  !spSimOpen(Date.UTC(2026, 10, 18, 10, 30), 18) && spSimOpen(Date.UTC(2026, 10, 18, 9, 59), 18)
  && spView(sc({ probe: { status: "failed", state: "not_signed", at: S - 3 }, sim: { status: "ask", at: S - 3, next_open_at: S + 3600 } }), ui(), { now: NOW }) === "s-closed"
  && spView(sc({ probe: { status: "failed", state: "not_signed", at: S - 3 }, sim: { status: "failed", state: "tw_ip", at: S - 3, next_open_at: S + 3600 } }), ui(), { now: NOW }) === "s-twip"
  && spView(PF("not_signed"), ui(), { now: Date.UTC(2026, 10, 18, 10, 30), cloud: true }) === "s-closed" && spView(PF("not_signed"), ui(), { now: Date.UTC(2026, 10, 18, 10, 30) }) === "s-ask");
ok("模擬測試時段:平日 08:00–20:00 台北", spSimOpen(NOW) && !spSimOpen(Date.UTC(2026, 10, 17, 23, 59)) && spSimOpen(Date.UTC(2026, 10, 18, 0, 0))
  && !spSimOpen(Date.UTC(2026, 10, 18, 12, 0)) && spSimOpen(Date.UTC(2026, 10, 18, 11, 59)));
ok("下一次開窗:週五 21:00 → 下週一 08:00;週三 07:00 → 當天 08:00", spSimNext(Date.UTC(2026, 10, 20, 13, 0)) === Date.UTC(2026, 10, 23, 0, 0)
  && spSimNext(Date.UTC(2026, 10, 17, 23, 0)) === Date.UTC(2026, 10, 18, 0, 0), [spSimNext(Date.UTC(2026, 10, 20, 13, 0)), spSimNext(Date.UTC(2026, 10, 17, 23, 0))]);
ok("{time} 是台北 HH:MM", spHm(Date.UTC(2026, 10, 18, 2, 10) / 1000) === "10:10" && spHm(null) === null);
// 表單
ok("錯誤掛在哪:檔案類 → 憑證卡;過期 → 憑證卡;打不開 → 身分證(第五格展開後 → 第五格);格式 → 身分證;daemon 類 → 整框",
  spMsgPlace({ code: "PFX_INVALID" }) === "pfx" && spMsgPlace({ code: "READ_FAILED" }) === "pfx" && spMsgPlace({ code: "PFX_EXPIRED" }) === "pfx"
  && spMsgPlace({ code: "PFX_PASSWORD" }, false) === "id" && spMsgPlace({ code: "PFX_PASSWORD" }, true) === "capw" && spMsgPlace({ code: "BAD_ID" }) === "id"
  && spMsgPlace({ code: "DAEMON_DOWN" }) === "frame" && spMsgPlace({ code: "REBOUND" }) === "frame");
// sinopac_connect／sinopac_local 同步拒收、畫面原本講不出原因的代號:各有一句、掛整框;NOT_BOUND 回表單重填
const FRAME = { NOT_OPEN: "sp.err.notOpen", NOT_CAPABLE: "sp.err.notOpen", WORKSPACE_OLD: "sp.err.hostOld", WORKER_RUNNING: "sp.err.workerOn", NOT_BOUND: "sp.err.notBound",
  KEY_TIMEOUT: "sp.err.sendAgain", KEY_EXPIRED: "sp.err.sendAgain", KEY_INVALID: "sp.err.sendAgain", ENVELOPE_INVALID: "sp.err.sendAgain" };
ok("NOT_OPEN 等同步拒收代號:各有自己那一句、掛整框;NOT_BOUND 回表單", Object.entries(FRAME).every(([c, k]) => ctx.SP_FRAME_ERR[c] === k && spMsgPlace({ code: c }) === "frame")
  && ctx.SP_REFILL.indexOf("NOT_BOUND") >= 0, Object.keys(FRAME).filter((c) => ctx.SP_FRAME_ERR[c] !== FRAME[c]));
const f = (o) => Object.assign(ctx.spBlank(), { apiKey: "k", secret: "s", id: "a123456789", picked: true }, o || {});
ok("主鈕:四格填滿、身分證格式對才能按(小寫自動轉大寫算對)", spFormReady(f(), null) && !spFormReady(f({ id: "A12" }), null) && !spFormReady(f({ secret: "" }), null) && !spFormReady(f({ picked: false }), null)
  && spFormReady(f({ picked: false }), { picked: true }));
ok("第五格展開了就要填", !spFormReady(f({ capw: true }), null) && spFormReady(f({ capw: true, caPw: "x" }), null));
ok("〔改金鑰〕存過就沿用機器上那張,不必重選", spFormReady(f({ fix: "key", id: "", picked: false }), { saved: true, picked: false }) && !spFormReady(f({ fix: "key", id: "", picked: false }), { saved: false, picked: false }));
ok("〔改金鑰〕只看金鑰與憑證檔;〔換憑證〕只看憑證檔", spFormReady(f({ fix: "key", id: "" }), null) && !spFormReady(f({ fix: "key", apiKey: "" }), null)
  && spFormReady(f({ fix: "cert", apiKey: "", secret: "", id: "" }), null));

// 字串兩語都有(畫面用到的每個 sp.* key)
const strings = fs.readFileSync(path.join(R, "strings.js"), "utf8");
const used = new Set([...src.matchAll(/t\("(sp\.[A-Za-z0-9.]+)"/g)].map((m) => m[1]).concat(Object.values(ctx.SP_ERR_KEY), Object.values(ctx.SP_FRAME_ERR).filter((k) => k.indexOf("sp.") === 0)));
const trade = fs.readFileSync(path.join(R, "trade.js"), "utf8");
[...trade.matchAll(/"(sp\.[A-Za-z0-9.]+)"/g)].forEach((m) => used.add(m[1]));
const zi = strings.indexOf("\n  zh: {"), zhBlock = strings.slice(zi), enBlock = strings.slice(0, zi);
const miss = [...used].filter((k) => !zhBlock.includes(JSON.stringify(k) + ":") || !enBlock.includes(JSON.stringify(k) + ":"));
ok("畫面用到的 sp.* 字串 zh／en 都有(" + used.size + " 個)", used.size > 40 && miss.length === 0, miss);
ok("用戶看得到的字不出現 Shioaji(元件一律叫永豐元件)", !/shioaji/i.test(fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", "zh.po"), "utf8").split("永豐期貨連接框")[1] || "")
  && !/shioaji/i.test(fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", "en.po"), "utf8").split("永豐期貨連接框")[1] || ""));
ok("存放句照實寫「不放在 agent 的設定檔」,不寫 agent 讀不到(Wei 11-17)", /不放在 agent 的設定檔/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", "zh.po"), "utf8"))
  && !/agent 讀不到|agent can.t read/i.test(src + fs.readFileSync(path.join(__dirname, "..", "shell", "i18n", "zh.po"), "utf8").split("永豐期貨連接框")[1]));

// 事件列與 P1 升級:群益、永豐同一條(= api agent_events._tw_unreadable_long)
const cut = (s, n) => { const i = s.indexOf("function " + n + "("); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error(n); };
const ev = {}; vm.createContext(ev);
vm.runInContext("const TR_EX_UNREACH_P1_MIN = 150; const TR_EX_UNREACH_P1_VENUES = [\"capital\", \"sinopac\"];\n" + cut(trade, "trExUnreachLong") + "\nthis.f = trExUnreachLong;", ev);
ok("renderer:永豐連不上 150 分起 P1、145 分不升、別家不升", ev.f("exchange_unreachable", { venue: "sinopac", minutes: 150 }) && !ev.f("exchange_unreachable", { venue: "sinopac", minutes: 145 })
  && ev.f("exchange_unreachable", { venue: "capital", minutes: 270 }) && !ev.f("exchange_unreachable", { venue: "okx", minutes: 999 }) && !ev.f("exchange_unreachable", { venue: "sinopac", minutes: true }));
const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
ok("主行程 p1UnreachLong 同一組 venue 與門檻", /^const P1_UNREACH_MIN = 150;\nconst P1_UNREACH_VENUES = \["capital", "sinopac"\];/m.test(mainSrc)
  && /const variant = hang \? "_hang" : held \? "_held" : closeAll \? "_close_all" : stuck \? "_stuck" : sinopac \? "_sinopac" : capital \? "_capital"/.test(mainSrc));
const apiPy = path.join(process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), "openclaw", "agent_events.py");
if (!fs.existsSync(apiPy)) console.log("SKIP  api level_for 比對(需要 monorepo 版面:../api/openclaw/agent_events.py)");
else { const py = fs.readFileSync(apiPy, "utf8"), m = /_TW_UNREADABLE_VENUES = frozenset\(\(([^)]*)\)\)/.exec(py), n = /CAPITAL_UNREADABLE_P1_MIN = (\d+)/.exec(py);
  ok("api level_for 的 venue 與門檻 = 外殼這份(api 先上)", !!m && !!n && JSON.stringify([...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]).sort()) === JSON.stringify(["capital", "sinopac"]) && n[1] === "150"); }

// 11-23 實測:重開 app、worker 還沒寫新快照那幾秒,帳戶列寫「串接失敗」＋「sinopac snapshot stale (3182s old) — 永豐 worker down?(get_equity)」
const libAcct = fs.readFileSync(path.join(__dirname, "..", "lib", "account_sinopac.py"), "utf8");
const downTok = (/^WORKER_DOWN = "([^"]+)"$/m.exec(libAcct) || [])[1];
ok("讀帳失敗那一行:lib 標 worker 沒在跑(WORKER_DOWN)→ sp.acct.down,其他一律 sp.acct.readFail,不出原文",
  !!downTok && ctx.spAcctErrKey(downTok + " sinopac snapshot stale (3182s old) — 永豐 worker down?") === "sp.acct.down"
  && ctx.spAcctErrKey("sinopac worker error: RuntimeError: x") === "sp.acct.readFail" && ctx.spAcctErrKey(null) === "sp.acct.readFail"
  && /else if \(id === "sinopac"\) box\.appendChild\(errLine\(t\(spAcctErrKey\(ae\.msg, ro\)\)\)\);/.test(trade), downTok);
{ const S = fs.readFileSync(path.join(R, "strings.js"), "utf8"), dc = [...S.matchAll(/"sp\.acct\.downCloud": "([^"]*)"/g)].map((m) => m[1]);
  ok("複稽 P3:雲端那句不承諾自動重啟(卡住或 timer 沒開時不成立),也不叫人重開 Blave;出口是聊天請 agent 查",
    dc.length === 2 && dc.every((x) => !/自動重新啟動|restarts automatically|重開 Blave|reopening Blave/i.test(x)) && dc.some((x) => x.includes("agent")), dc); }
ok("稽核 C1:雲端視角不叫人重開 Blave,講主機那一句;讀不到帳戶那句兩邊同一句",
  ctx.spAcctErrKey(downTok + " stale", true) === "sp.acct.downCloud" && ctx.spAcctErrKey(downTok + " stale", false) === "sp.acct.down"
  && ctx.spAcctErrKey("x", true) === "sp.acct.readFail");
{ const pure = trade.slice(trade.indexOf("/* ── 純邏輯("), trade.indexOf("/* ── 純邏輯到此"));
  const bc = { SINOPAC_LOCAL_ON: true, spWip: () => false, spLoginStopped: () => false, spRetryAt: () => null, Date, Object, Array, String, Number, Math, JSON, isFinite, Set, Map };
  vm.createContext(bc); vm.runInContext(pure.replace(/^const /gm, "var "), bc);
  const T0 = bc.TR_SP_T0, stale = { ok: false, error: { stage: "get_equity", msg: "[sinopac_worker_down] stale" } };
  const rep = (sl, e) => ({ venues: { sinopac: { credentials: true, pair: true, order: true, account: true } }, account: { venues: { sinopac: e === undefined ? stale : e } }, sinopac_local: sl });
  const boot = (r, now) => bc.trSpBooting(r, "sinopac", now);
  ok("重開後 worker 還沒起(畫面剛載入)→ 連接中,不列串接失敗;過了 TR_SP_BOOT_MS 照講失敗",
    boot(rep({ worker_running: false, needs_secrets: true }), T0 + 5000) && !boot(rep({ worker_running: false }), T0 + bc.TR_SP_BOOT_MS + 1)
    && bc.trFailedIds(rep({ worker_running: false })).length === 0);
  const st = (T0 + 600000) / 1000;
  ok("worker 剛起(worker_started_at)那 TR_SP_BOOT_MS 內 = 連接中;之後、讀到了、或沒有 sinopac_local(雲端)都不算",
    boot(rep({ worker_running: true, worker_started_at: st }), st * 1000 + 30000) && !boot(rep({ worker_running: true, worker_started_at: st }), st * 1000 + bc.TR_SP_BOOT_MS + 1)
    && !boot(rep({ worker_running: true, worker_started_at: st }, { ok: true, equity: 1 }), st * 1000 + 1000) && !boot(rep(undefined), T0 + 1000)
    && !bc.trSpBooting(rep({ worker_running: false }), "president", T0 + 1000));
  bc.spLoginStopped = () => true;
  ok("登入停了不算啟動中(那一態有自己的句子與〔重新登入〕)", !boot(rep({ worker_running: false }), T0 + 1000));
  ok("設定 › 帳戶那一列與標頭的失敗清單都看 trSpBooting", /&& !\(!ro && trSpBooting\(r, id, Date\.now\(\)\)\) \? trLiveEntry\(r, id\) : null;/.test(trade)
    && /!\(typeof trSpBooting === "function" && trSpBooting\(r, id, Date\.now\(\)\)\); \}\); \}/.test(trade)); }
// 11-23 夜盤實測:每次送單後 ORDER_SETTLE_S 內 lib 拒讀部位(SnapshotLag),帳戶讀取器回 ok:false＋equity 數字＋positions null,
// 頁首寫「串接失敗」、總權益「—」。部位未知不是串接失敗:權益照畫、部位寫「—」＋「等永豐回報中…」,部位照舊不當 0(lesson 16)
{ const pure = trade.slice(trade.indexOf("/* ── 純邏輯("), trade.indexOf("/* ── 純邏輯到此"));
  const pc = { SINOPAC_LOCAL_ON: true, spWip: () => false, spLoginStopped: () => false, spRetryAt: () => null, Date, Object, Array, String, Number, Math, JSON, isFinite, Set, Map };
  vm.createContext(pc); vm.runInContext(pure.replace(/^const /gm, "var "), pc);
  ["trPosPending", "trEqOk"].forEach((n) => { if (typeof pc[n] !== "function") pc[n] = () => undefined; });   // 修前沒有這兩支:照樣跑完、報紅
  const lagCls = (/^class (SnapshotLag)\(RuntimeError\):/m.exec(libAcct) || [])[1];
  const lag = { ok: false, equity: 50010, currency: "TWD", accounts: { futures: 50010 }, available: 41000, positions: null, holdings: null,
    error: { stage: "get_positions", type: lagCls || "?", msg: "永豐部位快取尚未跟上最近一次下單" } };
  const rep = (e) => ({ venues: { sinopac: { credentials: true, pair: true, order: true, account: true } }, account: { read_at: 1, venues: { sinopac: e } } });
  ok("lib 的類別名就是外殼認的那個(SnapshotLag)", lagCls === "SnapshotLag" && /e\.error\.type === "SnapshotLag" && e\.error\.stage === "get_positions"/.test(trade));
  ok("SnapshotLag(只有部位在等):不列串接失敗、權益照讀、保證金照畫", pc.trPosPending(lag) && pc.trFailedIds(rep(lag)).length === 0
    && pc.trEqOk(lag) && pc.trLiveTotal(lag) === 50010 && !!pc.trMarginModel(lag, 1), pc.trFailedIds(rep(lag)));
  const eqFail = Object.assign({}, lag, { equity: null, accounts: null, error: { stage: "get_equity", type: "RuntimeError", msg: "x" } });
  const noEq = Object.assign({}, lag, { equity: null, accounts: null });
  const other = Object.assign({}, lag, { error: { stage: "get_positions", type: "RuntimeError", msg: "sinopac: TXF is open in several contract months" } });
  ok("其他讀帳失敗照舊是串接失敗:權益讀不到、SnapshotLag 卻沒有權益、部位讀失敗但不是 SnapshotLag",
    [eqFail, noEq, other].every((e) => !pc.trPosPending(e) && !pc.trEqOk(e) && pc.trFailedIds(rep(e)).length === 1));
  ok("部位仍是讀不到(ok 不改):自動下單頁不把它當 0——帳上與差額寫「—」、表底一句、細節行與策略外不畫",
    lag.ok === false && /const posPend = recon && !firstRead && trVenueIds\(r\)\.some\(\(id\) => trPosPending\(trLiveEntry\(r, id\)\)\);/.test(trade)
    && /else if \(firstRead \|\| posPend\) row\.append\(dash\(false\), dash\(false\)\);/.test(trade)
    && /const outside = recon && !firstRead && !posPend \?/.test(trade) && /if \(trade && !firstRead && !posPend && covered\(sym\)\)/.test(trade)
    && /if \(\(posPend \|\| firstRead\) && hs !== "dead" && hs !== "unknown"\) \{/.test(trade) && /w\.append\(sp, trEl\("span", "", t\(posPend \? "sp\.posPending" : "cap\.s\.readRun"\)\)\)/.test(trade)
    && /function trLivePositions\(r\) \{[\s\S]{0,120}if \(!e \|\| !e\.ok \|\| !e\.positions\) return;/.test(trade)
    && /function trCfBookBad\(r\) \{\n  if \(!trVenueIds\(r\)\.some\(\(id\) => \{ const e = trLiveEntry\(r, id\); return !!e && e\.ok === false; \}\)\) return false;/.test(trade));
  ok("總權益、資產頁、設定 › 帳戶那一列看 trEqOk／trPosPending,不看 e.ok",
    /function trEquity\(\) \{ const e = trLiveEntry\(trReport\(\), trVenueId\(\)\); return trEqOk\(e\) \? trLiveTotal\(e\) : null; \}/.test(trade)
    && /const v = trEqOk\(e\) \? \(twd \?/.test(trade) && /\(\(!!e && !e\.ok && !trPosPending\(e\)\) \|\| !!\(bn && bn\.verdict\)/.test(trade)
    && /else if \(trEqOk\(e\) && !failed\) st\.appendChild/.test(trade) && /else if \(e && !e\.ok && !capWip && !trPosPending\(e\)\) \{/.test(trade));
  const S = fs.readFileSync(path.join(R, "strings.js"), "utf8"), pp = [...S.matchAll(/"sp\.posPending": "([^"]*)"/g)].map((m) => m[1]);
  ok("「等永豐回報中…」中英都有、刪節號單個 …", pp.length === 2 && pp.includes("等永豐回報中…") && pp.includes("Waiting for SinoPac to report…"), pp); }
// 檔尾的 spResume 實跑是非同步的:懸空(promise 永遠不回)時 node 會靜靜 exit 0,沒跑到結尾一律算紅
let spDone = false;
process.on("beforeExit", () => { if (spDone) return; console.log("FAIL  非同步測試沒有跑到結尾"); process.exit(1); });
// 11-23 夜盤實測:剛連好時連接框寫「已連接」但權益數「—」——報告讀帳比下單程式第一份快照早 4 秒,下一輪才有。
// 第一份快照到之前寫「讀取中…」;讀到了但沒有權益、或一直沒跟上(超過 SP_EQ_WAIT_MS)照舊「—」;SnapshotLag 那筆讀到了權益照畫數字
{ const ev = ctx.spEqView, okAt = S - 10, w = sc({ probe: { status: "ok", state: "ok", at: S - 20 }, worker: { status: "ok", at: okAt } });
  const acct = (readAt, e) => ({ account: { read_at: readAt, venues: e === undefined ? {} : { sinopac: e } } });
  const down = { ok: false, error: { stage: "get_equity", msg: "[sinopac_worker_down] sinopac snapshot missing" } };
  const lagE = { ok: false, equity: 49750, positions: null, error: { stage: "get_positions", type: "SnapshotLag", msg: "x" } };
  const J = JSON.stringify, run = (r, c, now) => (ev ? J(ev(r, c, now === undefined ? NOW : now)) : "no spEqView");
  ok("讀帳早於下單程式 ok(第一份快照前):讀取中…", run(acct(okAt - 4, down), w) === J({ wait: true }), run(acct(okAt - 4, down), w));
  ok("下單程式 ok 了、這一家還沒進帳戶讀取:讀取中…;報告沒有 account 也一樣", run(acct(okAt + 1), w) === J({ wait: true }) && run({}, w) === J({ wait: true }));
  ok("讀到數字:照畫(含 SnapshotLag 讀到權益那筆,不跟 trPosPending 打架)", run(acct(okAt + 5, { ok: true, equity: 49750 }), w) === J({ v: 49750 })
    && run(acct(okAt - 4, lagE), w) === J({ v: 49750 }));
  ok("讀到了(晚於 ok)但真的沒有權益:「—」,不是讀取中", run(acct(okAt + 5, down), w) === J({}) && run(acct(okAt + 5, { ok: true }), w) === J({}));
  ok("等超過 SP_EQ_WAIT_MS 還沒跟上:退回「—」;下單程式還沒 ok(不在完成頁)不出讀取中",
    run(acct(okAt - 4, down), w, okAt * 1000 + ctx.SP_EQ_WAIT_MS) === J({}) && run(acct(okAt - 4, down), w, okAt * 1000 + ctx.SP_EQ_WAIT_MS - 1) === J({ wait: true })
    && run(acct(0, down), sc()) === J({}) && run(acct(0, down), null) === J({}));
  ok("有權益就畫數字,不看時間窗:過了 SP_EQ_WAIT_MS 讀到真權益照畫",
    run(acct(okAt + 5, { ok: true, equity: 1 }), w, okAt * 1000 + ctx.SP_EQ_WAIT_MS + 1) === J({ v: 1 }));
  ok("有權益就畫數字,不看下單程式狀態:worker 不是 ok(running／failed／沒有回報)讀到真權益照畫",
    ["running", "failed", "idle"].every((st) => run(acct(okAt + 5, { ok: true, equity: 1 }), sc({ worker: { status: st, at: okAt } })) === J({ v: 1 }))
    && run(acct(okAt + 5, { ok: true, equity: 1 }), null) === J({ v: 1 }));
  ok("SP_EQ_WAIT_MS = trade.js TR_SP_BOOT_MS", ctx.SP_EQ_WAIT_MS !== null && new RegExp("const TR_SP_BOOT_MS = " + ctx.SP_EQ_WAIT_MS + ",").test(trade));
  const doneB = (() => { const i = src.indexOf("function spDoneBody("); return src.slice(i, src.indexOf("\n}\n", i)); })();
  ok("完成頁的權益格走 spEqView;等第一份快照時是圓環(spEqWait),畫面上不放「讀取中…」字;讀取中框 aria-busy、簽章帶這一態(過了等待時間會重畫成「—」)",
    /const eq = spEqView\(r, sc, Date\.now\(\)\);/.test(doneB) && /eq\.wait \? spEqWait\(\) : trEl\("div", "v mono", eq\.v !== undefined \? trTwd\(eq\.v\)/.test(doneB)
    && !/readRun|讀取中/.test(doneB) && /SP\.busy \|\| eqWait \|\|/.test(src) && /spReport\(\)\.account, eqWait\]\);/.test(src));
  ok("等待態:.v 裡一顆 aria-hidden 的 .spin16 + .sr-only 念 sp.posPending(設計定稿 11-25;骨架撐 120 秒會讀成壞掉)",
    /function spEqWait\(\) \{ const v = trEl\("div", "v"\), b = trEl\("span", "spin16 pres-eq-spin"\); b\.setAttribute\("aria-hidden", "true"\); v\.append\(b, trEl\("span", "sr-only", t\("sp\.posPending"\)\)\); return v; \}/.test(src)
    && !/spEqSk|sp-eq-sk/.test(src));
  const pcss = fs.readFileSync(path.join(R, "president.css"), "utf8");
  ok("圓環 20/2、--ink-3、不覆寫 animation(reduced-motion 照轉,繼承 trade.css .spin16);舊骨架條規則已拿掉",
    /\.pres-big \.pres-eq-spin \{ width: 20px; height: 20px; color: var\(--ink-3\); vertical-align: middle; \}/.test(pcss)
    && !/pres-eq-spin[^}]*animation/.test(pcss) && !/sp-eq-sk/.test(pcss)); }
// 已連接狀態的〔換金鑰〕(runbook 11-23 第 7 項;設計稽核 11-24):只在設定 › 帳戶那一列、只有這台電腦;開框直接到表單、只清金鑰兩格
{ const body = (n) => { const i = src.indexOf("function " + n + "("); return i < 0 ? "" : src.slice(i, src.indexOf("\n}\n", i)); };
  ok("完成頁沒有〔換金鑰〕(剛驗過的金鑰;入口只留設定列)", !/sp-fix-key|sp\.fixKey|spFix|rekey/.test(body("spDoneBody")));
  // 鈕上方那一句(Wei 11-24):只在換金鑰路徑;放在腳的 .foot-msg(送出鈕正上方),不在表單中段
  const foot = body("spFoot");
  ok("換金鑰路徑:腳裡送出鈕上方一句 sp.rekeyNote(.foot-msg),主鈕叫 cx.changeKey;表單本體沒有那句",
    /let msg = \$\("sp-foot-msg"\);\n  if \(view === "f" && SP\.rekey\) \{ if \(!msg\) \{ msg = trEl\("span", "foot-msg"\); msg\.id = "sp-foot-msg"; go\.parentNode\.insertBefore\(msg, go\.parentNode\.firstChild\); \} msg\.textContent = t\("sp\.rekeyNote"\); \}\n  else if \(msg\) msg\.remove\(\);/.test(foot)
    && /SP\.busy \? t\("cx\.connecting"\) : SP\.rekey \? t\("cx\.changeKey"\) : t\("cx\.connect"\)/.test(foot)
    && !/rekeyNote/.test(body("spFormBody")) && (src.match(/sp\.rekeyNote/g) || []).length === 1);
  ok("換金鑰路徑的表單標題是 cx.changeKey(換金鑰／Replace Key);首次開通與其他態照舊 sp.title",
    /\$\("cx-title"\)\.textContent = t\(view === "f" && SP\.rekey \? "cx\.changeKey" : "sp\.title"\);/.test(body("spPaint"))
    && (src.match(/"cx-title"\)\.textContent/g) || []).length === 1);
  ok("換到別家或別的框:那一句跟著收掉(spFootRestore)", /function spFootRestore\(\) \{[^\n]*const msg = \$\("sp-foot-msg"\); if \(msg\) msg\.remove\(\); \}/.test(src));
  ok("只有 spResume 設 rekey(本機、帶 spAsk);登入失敗那幾列的〔換金鑰〕與 spFix 不設", (src.match(/SP\.rekey = true/g) || []).length === 1
    && /\(\) => spFix\("key"\), "sp-fix-key"/.test(body("spLoginBody")) && !/rekey/.test(body("spLoginBody")) && !/rekey/.test((/\nfunction spFix\([^\n]*/.exec(src) || ["rekey"])[0]));
  ok("換好(本機 bind OK、雲端憑證 ok)就收掉 rekey", (src.match(/SP\.phase = "flow"; SP\.relogin = false; SP\.rekey = false;/g) || []).length === 2);
  { const rn = [...strings.matchAll(/"sp\.rekeyNote": "([^"]*)"/g)].map((m) => m[1]), zh = rn.find((x) => /[一-鿿]/.test(x)) || "", en = rn.find((x) => !/[一-鿿]/.test(x)) || "";
    ok("sp.rekeyNote:中文「連線會先中斷，新金鑰登入成功才恢復下單。」(≤25 字、沒有破折號);英文不寫金鑰自己登入(signs in)",
      rn.length === 2 && zh === "連線會先中斷，新金鑰登入成功才恢復下單。" && [...zh.replace(/[，。]/g, "")].length <= 25 && !/[—–]/.test(rn.join(""))
      && en === "The connection stops first. Orders resume once sign-in with the new key succeeds.", rn); }
  { const fk = [...strings.matchAll(/"(sp\.fixKey|cx\.changeKey)": "([^"]*)"/g)].map((m) => m[1] + "=" + m[2]).sort();
    ok("一個概念一個詞:永豐〔換金鑰〕跟加密所 cx.changeKey 同字(中「換金鑰」、英 Replace Key)",
      JSON.stringify(fk) === JSON.stringify(["cx.changeKey=Replace Key", "cx.changeKey=換金鑰", "sp.fixKey=Replace Key", "sp.fixKey=換金鑰"]), fk); }
  ok("spRekeyOpen:帶 spAsk 開永豐的框,框沒開成就收掉", /spAsk = "key"; cxModalOpen\(b, SINOPAC\);\n  if \(\$\("cx-scrim"\)\.hidden \|\| CXF\.venue !== SINOPAC\) spAsk = null;/.test(body("spRekeyOpen")));
  const rs = body("spResume");
  ok("spResume 讀走 spAsk:本機要換金鑰就留在表單、只清金鑰,不進清單、不當重新登入",
    /const ask = spAsk; spAsk = null;/.test(rs) && /if \(ask === "key" && !spCloud\(\)\) \{ SP\.fix = "key"; SP\.rekey = true; \}\n    else \{\n      SP\.phase = "flow";/.test(rs));
  // 機器自己接回那一段(runtime sinopac_local._resume_after_rebind):busy 是 sinopac_local:resume 時畫登入那一列在跑、畫面不自己送 probe／start
  const lpy = fs.readFileSync(path.join(__dirname, "..", "runtime", "sinopac_local.py"), "utf8"), rstep = (/^RESUME_STEP = "([^"]+)"/m.exec(lpy) || [])[1];
  ok("runtime 的 RESUME_STEP 對得上畫面的 SP_BUSY_STEP(→ 登入那一列在跑)", rstep === "sinopac_local:resume"
    && /"sinopac_local:resume": "probe" \};/.test(src) && view(sc({ busy: rstep })) === "r-login", rstep);
  ok("busy 期間畫面不推進、鈕鎖住(spAdvance／spOff 都看 spBusy)", /if \(SP\.busy \|\| SP\.sent \|\| spDown\(\) \|\| SP\.phase !== "flow" \|\| spBusy\(sc, Date\.now\(\)\)\) return;/.test(body("spAdvance"))
    && /const spOff = \(sc\) => SP\.busy \|\| spDown\(\) \|\| spBusy\(sc, Date\.now\(\)\);/.test(src) && !/sc && sc\.busy|!!\(sc && sc\.busy\)/.test(src));
  // 稽核第二輪 M1:daemon 死在步驟中留下的 busy(runtime 起來會清)是第二道:狀態檔過了 SP_STUCK_MS 就不算在跑、不鎖畫面
  ok("spBusy 看新鮮度:新的 busy 算、25 分鐘前的不算、沒有 busy 不算", !!ctx.spBusy && ctx.spBusy(sc({ busy: rstep }), NOW) === true
    && ctx.spBusy(sc({ busy: rstep, updated_at: S - 26 * 60 }), NOW) === false && ctx.spBusy(sc(), NOW) === false && ctx.spBusy(null, NOW) === false);
  ok("留下的舊 busy:畫面照段落走(r-ready,spAdvance 會送確認登入),不停在登入在跑", view(sc({ busy: rstep, updated_at: S - 26 * 60 })) === "r-ready"
    && view(sc({ busy: rstep })) === "r-login");
  ok("接回在等再試一次(451／沒回應):登入那一列畫那一類失敗(451 帶時間),不是在跑",
    view(sc({ busy: rstep, probe: { status: "failed", state: "too_many", at: S - 3, retry_at: S + 500 } })) === "r-451"
    && view(sc({ busy: rstep, probe: { status: "failed", state: "timeout", at: S - 3 } })) === "r-net");
  // spResume 實跑:本機、存著那組、憑證 ok → 帶 spAsk 的停在表單 fix=key、標 rekey;沒帶的照舊進清單;雲端帶了也不標(雲端沒有這顆鈕)
  const rctx = { SINOPAC: "sinopac", SP: null, spAsk: null, CXF: { env: "local" }, TR_BAGS: { local: { st: { report: { sinopac_connect: sc() } } }, cloud: { st: { report: { sinopac_connect: sc() } } } },
    window: { blave: { sinopacInfo: async () => ({ saved: true, picked: false, caSeparate: false }) } }, spPaint() {}, spSec: ctx.spSec || ((c, k) => (c && c[k] && typeof c[k] === "object" ? c[k] : {})) };
  vm.createContext(rctx);
  vm.runInContext("var spCloud = () => CXF.env === 'cloud'; var spBag = () => TR_BAGS[spCloud() ? 'cloud' : 'local']; var spReport = () => (spBag().st && spBag().st.report) || null;"
    + " var spSC = () => { const r = spReport(); const c = r && r.sinopac_connect; return c && typeof c === 'object' ? c : null; };\n" + rs.replace(/^function spResume/, "var spResume = async function") + "\n};", rctx);
  (async () => {
    rctx.SP = ctx.spBlank(); rctx.spAsk = "key"; await rctx.spResume();
    const a = { phase: rctx.SP.phase, fix: rctx.SP.fix, ask: rctx.spAsk, rekey: rctx.SP.rekey };
    rctx.SP = ctx.spBlank(); await rctx.spResume();
    const b = { phase: rctx.SP.phase, fix: rctx.SP.fix, rekey: rctx.SP.rekey };
    rctx.CXF.env = "cloud"; rctx.SP = ctx.spBlank(); rctx.spAsk = "key"; await rctx.spResume();
    const c = { phase: rctx.SP.phase, fix: rctx.SP.fix, rekey: rctx.SP.rekey, ask: rctx.spAsk };
    ok("spResume 實跑:帶換金鑰 → 表單 fix=key、spAsk 用掉;沒帶 → 清單", a.phase === "form" && a.fix === "key" && a.ask === null && b.phase === "flow" && b.fix === null, [a, b]);
    ok("換金鑰路徑才標 rekey(本機帶 spAsk true、一般開框 false、雲端帶了也 false、空白狀態 false)",
      a.rekey === true && b.rekey === false && c.rekey === false && c.ask === null && ctx.spBlank().rekey === false, [a, b, c]);
    const row = (() => { const i = trade.indexOf("function trPaintSet("); return trade.slice(i, trade.indexOf("\n}\n", i)); })();
    ok("設定 › 帳戶那一列:永豐、這台電腦、已連接或串接中才有〔換金鑰〕(開通中、登入停了、重試中、串接失敗、雲端都不出),開框走 spRekeyOpen;解除中停用;排在〔解除連接〕前",
      /if \(id === "sinopac" && SINOPAC_LOCAL_ON && !ro && !spW && !spLogin && !spRetry && !failed && !headRelogin && typeof spRekeyOpen === "function"\) \{\n    const k = trEl\("button", "pf-act", t\("cx\.changeKey"\)\); k\.type = "button"; k\.id = "sp-rekey";\n    k\.disabled = !!TR\.unbinding \|\| unbindingClose; k\.addEventListener\("click", \(\) => spRekeyOpen\(k\)\);/.test(row)
      && row.indexOf('k.id = "sp-rekey"') < row.indexOf('ub.id = "tr-unbind"') && row.indexOf('k.id = "sp-rekey"') > 0
      && row.indexOf("const failed = ") >= 0 && row.indexOf("const failed = ") < row.indexOf('k.id = "sp-rekey"'));
    spDone = true; console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
  })();
}
