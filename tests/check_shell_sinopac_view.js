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
vm.runInContext(head + "\n" + src.slice(a, b) + "\nthis.spView = spView; this.spBlank = spBlank; this.spRunning = spRunning; this.spSimOpen = spSimOpen; this.spSimNext = spSimNext;"
  + " this.spMsgPlace = spMsgPlace; this.spFormReady = spFormReady; this.spHm = spHm; this.spSimRow = spSimRow; this.SP_PROBE_VIEW = SP_PROBE_VIEW; this.SP_STOP_VIEW = SP_STOP_VIEW; this.SP_ERR_KEY = SP_ERR_KEY;", ctx);
const { spView, spRunning, spSimOpen, spSimNext, spMsgPlace, spFormReady, spHm, spSimRow } = ctx;

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
const f = (o) => Object.assign(ctx.spBlank(), { apiKey: "k", secret: "s", id: "a123456789", picked: true }, o || {});
ok("主鈕:四格填滿、身分證格式對才能按(小寫自動轉大寫算對)", spFormReady(f(), null) && !spFormReady(f({ id: "A12" }), null) && !spFormReady(f({ secret: "" }), null) && !spFormReady(f({ picked: false }), null)
  && spFormReady(f({ picked: false }), { picked: true }));
ok("第五格展開了就要填", !spFormReady(f({ capw: true }), null) && spFormReady(f({ capw: true, caPw: "x" }), null));
ok("〔改金鑰〕存過就沿用機器上那張,不必重選", spFormReady(f({ fix: "key", id: "", picked: false }), { saved: true, picked: false }) && !spFormReady(f({ fix: "key", id: "", picked: false }), { saved: false, picked: false }));
ok("〔改金鑰〕只看金鑰與憑證檔;〔換憑證〕只看憑證檔", spFormReady(f({ fix: "key", id: "" }), null) && !spFormReady(f({ fix: "key", apiKey: "" }), null)
  && spFormReady(f({ fix: "cert", apiKey: "", secret: "", id: "" }), null));

// 字串兩語都有(畫面用到的每個 sp.* key)
const strings = fs.readFileSync(path.join(R, "strings.js"), "utf8");
const used = new Set([...src.matchAll(/t\("(sp\.[A-Za-z0-9.]+)"/g)].map((m) => m[1]).concat(Object.values(ctx.SP_ERR_KEY)));
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
console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
