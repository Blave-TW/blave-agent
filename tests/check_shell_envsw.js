// 電腦版「這台電腦｜雲端」第一刀(shell/renderer/trade.js 的「視角純邏輯」+ 原文列舉)。
//   1. 雲端視角唯讀:envApi("cloud") 這一層就把寫入擋掉,而且不會退回去讀這台電腦的東西
//   2. 列舉:trade.js / app.js 裡每一個送指令的地方都經過 envApi、每一個會送指令的入口都先擋雲端
//   3. 雲端那一邊是哪一種、切換器每格畫什麼、側欄列尾的狀態字
// 跑法:node tests/check_shell_envsw.js
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..", "shell", "renderer");
const src = fs.readFileSync(path.join(R, "trade.js"), "utf8");
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b); if (i < 0 || j < 0) throw new Error("找不到標記:" + a); return src.slice(i, j); };
const noComments = (x) => x.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const pure = cut("/* ── 純邏輯(", "/* ── 純邏輯到此"), env = cut("/* ── 視角純邏輯(", "/* ── 視角純邏輯到此");
if (/\bdocument\b|\$\(|window\./.test(noComments(env))) throw new Error("視角純邏輯區塊碰了 DOM / window");
eval((pure + env).replace(/^const /gm, "var "));
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };
// 稽核 Q1:從開通頁按「綁卡」外開瀏覽器,回來要重查帳號狀態(不然畫面一直停在「綁卡」,人會以為沒綁成)
{ const appSrc = fs.readFileSync(path.join(R, "app.js"), "utf8");
  ok("Q1 回到 app 時,開通頁看得見就重查帳號狀態", /planState\(\) === "starting" \|\| envOpenVisible\(\)\)\) return;/.test(appSrc)
    && /function envOpenVisible\(\) \{ return ENV\.cur === "cloud" && !\$\("cv-empty"\)\.hidden; \}/.test(src)); }
process.on("beforeExit", () => { console.log("FAIL  非同步測試沒有跑到結尾"); process.exit(1); });

const V = { binance: { credentials: true, pair: true, order: true, account: true } }, P = { paper: V.binance };
const rep = (o = {}) => ({ venues: V, halt: {}, reconciler: { alive: true }, account: { venues: { binance: { ok: true, equity: 1000 } } }, config: { amounts: { a: 100, b: 0 } }, ...o });
const cloudSt = (c, report, alive = true) => ({ alive, running: true, report: report === undefined ? rep() : report, lastExit: null, restarts: 0, cloud: c });
const okc = (state, extra = {}) => ({ code: "OK", machine: { state }, strategies: [], ...extra });

(async () => {
  // ── 1. 傳輸層 ──
  const touched = [];
  const host = { cloudStatus: async () => cloudSt(okc("running", { strategies: [{ name: "a", display_name: "Alpha", has_backtest: true, symbol: "BTCUSDT", updated_at: 5 }, { name: "" }, null, { nope: 1 }] })) };
  ENV_API.forEach((k) => { host[k] = (...a) => { touched.push(k); return Promise.resolve({ ok: true, from: "local", a }); }; });
  const C = envApi("cloud", host);
  // 雲端視角下每一個寫入類指令(本機 daemon.js UI_COMMANDS 那一組 + 連線頁那幾支)都送不出去
  const CMDS = ["halt", "close_all", "resume", "resume_wait", "restart_reconciler", "amounts", "credentials", "credentials_remove", "retest_accounts"];
  const res = []; for (const c of CMDS) res.push(await C.tradeSend(c, { amounts: { a: 1 } }));
  ok("雲端:每一個寫入指令都回 NOT_ALLOWED(跟主行程拒絕同一個代碼 → 畫面講「沒送到、什麼都沒變」)", res.every((r) => r && r.ok === false && r.error === "NOT_ALLOWED") && trErrorKind("NOT_ALLOWED") === "undelivered");
  const st = await C.tradeStatus(), list = await C.listStrategies(), one = await C.loadStrategy("a"), eq = await C.tradeEquity({ days: 30 }), ev = await C.tradeEvents({ days: 30 });
  ok("雲端:沒有任何一支碰到這台電腦的 api(不寫、也不把本機的數字畫在雲端那一頁)", touched.length === 0);
  ok("雲端:狀態讀 cloudStatus;清單來自同一份狀態,壞的列濾掉、形狀同本機 listStrategies", st.cloud.code === "OK" && list.length === 1 && list[0].name === "a" && list[0].displayName === "Alpha" && list[0].hasBacktest === true && list[0].symbol === "BTCUSDT" && list[0].remote === true && list[0].mtime === 5);
  ok("雲端:還沒做的端點回空的(單支策略 / 權益曲線 / 畫面事件)", one === null && JSON.stringify(eq) === '{"curve":[]}' && Array.isArray(ev) && ev.length === 0);
  const cloudHalf = noComments(env).slice(noComments(env).indexOf("let last = null;"), noComments(env).indexOf("function envCloudList("));
  ok("雲端那份 api 的原文裡,host 只被拿來叫 cloudStatus", cloudHalf.length > 50 && (cloudHalf.match(/host\s*[.\[]\s*\w*/g) || []).join() === "host.cloudStatus");
  const L = envApi("local", host); await L.tradeSend("halt", {}); await L.tradeStatus();
  ok("這台電腦:原樣轉給主行程", touched.join() === "tradeSend,tradeStatus" && L.env === "local" && C.env === "cloud");
  ok("兩份 api 介面相同(自動下單頁換一個來源就能畫)", ENV_API.every((k) => typeof C[k] === "function" && typeof L[k] === "function"));

  // ── 2. 原文列舉 ──
  const code = noComments(src), app = noComments(fs.readFileSync(path.join(R, "app.js"), "utf8"));
  ok("trade.js 不直接叫主行程的那六支(一律經過 envApi)", !new RegExp("window\\.blave\\.(" + ENV_API.join("|") + ")\\b").test(code));
  ok("app.js 不送交易指令、不讀交易狀態", !/\btrade(Send|Status|Equity|Events)\b/.test(app));
  const sends = code.match(/[\w.]*\btradeSend\(/g) || [];
  ok("每一個送指令的地方都是「自己那一份狀態的 api」(S.api / L.api),共 " + sends.length + " 處", sends.length >= 7 && sends.every((x) => x === "S.api.tradeSend(" || x === "L.api.tradeSend("));
  // L = TR_BAGS.local(設定 › 連線這一刀永遠是這台電腦的);S = 進來那一刻的 TR,所以每個用 S.api 送指令的入口都要先擋雲端
  const fn = (name) => { const i = code.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); const j = code.indexOf("\nfunction ", i + 1), k = code.indexOf("\nasync function ", i + 1); return code.slice(i, Math.min(j < 0 ? 1e9 : j, k < 0 ? 1e9 : k)); };
  const entries = ["trRun", "trAskStop", "trAskStart", "trSaveAmounts", "trUnbind"];
  ok("會送指令的入口都先擋雲端:" + entries.join(" / "), entries.every((n) => /(S|TR)\.env (!== "local"|=== "cloud")[^;]*\) return;/.test(fn(n).split("\n").slice(0, 3).join("\n"))));
  const users = code.split(/\n(?:async )?function /).filter((b) => /S\.api\.tradeSend\(/.test(b)).map((b) => b.slice(0, b.indexOf("(")));
  ok("用 S.api 送指令的函式就是上面那幾個(多一個就要有人看過它擋了沒):" + users.join(), users.every((n) => entries.indexOf(n) >= 0));
  ok("用 L.api 送指令的函式:L 一定是這台電腦那一份", code.split(/\n(?:async )?function /).filter((b) => /L\.api\.tradeSend\(/.test(b)).every((b) => /const L = TR_BAGS\.local[,;]/.test(b)));
  ok("trade.js 沒有 innerHTML / insertAdjacentHTML(雲端來的字串一律 textContent)", !/innerHTML|insertAdjacentHTML|outerHTML/.test(code));
  ok("重開一律回這台電腦:現在看哪一邊不寫進 localStorage / sessionStorage", !/(local|session)Storage[^\n]*ws_env/.test(code) && /const ENV = \{ cur: "local"/.test(code));
  const html = fs.readFileSync(path.join(R, "index.html"), "utf8");
  ok("index.html:切換器是兩顆 aria-pressed 的鈕、開場在這台電腦;舊的狀態帶鈕已退場", /id="env-local" data-env="local" aria-pressed="true"/.test(html) && /id="env-cloud" data-env="cloud" aria-pressed="false"/.test(html) && !/tr-tb-btn/.test(html + code));

  // ── 3. 雲端那一邊是哪一種 ──
  ok("還沒問到 = loading", envCloudKind(null) === "loading" && envCloudKind({ cloud: {} }) === "loading");
  ok("沒登入 / 舊登入 / 被撤銷 = signedOut", ["NO_LOGIN", "NO_APP_SECRET", "REVOKED"].every((c) => envCloudKind(cloudSt({ code: c }, null)) === "signedOut"));
  ok("還沒成功讀到過 = unreach", ["OFFLINE", "RATE_LIMITED", "BAD_RESPONSE"].every((c) => envCloudKind(cloudSt({ code: c }, null)) === "unreach"));
  ok("主機四態;不認得的當 none", ["none", "starting", "stopped", "running"].every((s) => envCloudKind(cloudSt(okc(s))) === s) && envCloudKind(cloudSt(okc("weird"))) === "none");

  // ── 切換器每格 ──
  const cell = (e, s, p) => { const c = envCell(e, s, p); return [c.money, c.run, c.dot, c.word].join(); };
  ok("這台電腦:沒連帳戶 = 只有字;模擬 / 真錢記號;下單中才有綠點", cell("local", { alive: true, report: rep({ venues: {} }) }) === ",false,," && cell("local", { alive: true, report: rep({ venues: P, account: null }) }) === "paper,true,," && cell("local", { alive: true, report: rep() }) === "real,true,,");
  ok("過場中 / 讀帳失敗 / 常駐程式不在:沒有綠點", cell("local", { alive: true, report: rep() }, true) === "real,false,," && cell("local", { alive: true, report: rep({ account: { venues: { binance: { ok: false } } } }) }) === "real,false,," && cell("local", { alive: false, report: rep() }) === "real,false,,");
  // Binance 金鑰重查出事:單可能送不出去 → 這台電腦那格不亮綠點(原本 trKeyBad 沒有任何測試:變異成恆 false 這裡會紅)
  { const live = { alive: true, report: rep() }, withV = (reason, fn) => { globalThis.CXF = { bn: { verdict: reason ? { reason } : null } }; try { return fn(); } finally { delete globalThis.CXF; } };
    ok("金鑰出事(IP 換了 / 交易權限沒了 / 被拒)→ 這台電腦那格不亮綠點;雲端那格不受影響", ["IP_CHANGED", "TRADING_LOST", "KEY_REJECTED", "REJECTED"].every((r) => withV(r, () => cell("local", live) === "real,false,," && trKeyBad("local") === true && trKeyBad("cloud") === false)));
    ok("沒有 verdict / CXF 還沒載入 → 不算出事", withV(null, () => trKeyBad("local") === false) && trKeyBad("local") === false && cell("local", live) === "real,true,,"); }
  // 設計 v4 §7:下單停了而且不是人按的(監督者被叫去跑、卻沒在跑)= 出事,沿用「已自動暫停」那一套;你還沒按啟動 = 沒有記號
  { const dead = (wanted, hb) => ({ alive: true, report: rep({ reconciler: { alive: false, heartbeat_at: hb }, daemon: { reconciler: { wanted, running: false } } }) });
    ok("異常停止 → 紅短劃 + tr.s.died,sig 帶最後執行的時間(看過才消);過場中不算", cell("local", dead(true, 1700000000)) === "real,false,bad,tr.s.died" && envCell("local", dead(true, 1700000000)).sig === "died:1700000000" && cell("local", dead(true, 1), true) === "real,false,,");
    ok("還沒按啟動(關 app 重開、不按啟動)→ 切換器沒有記號", cell("local", dead(false, 1700000000)) === "real,false,," && cell("local", dead(undefined, 1700000000)) === "real,false,,"); }
  ok("人按的暫停不叫人;不是人按的(對帳器 / 健檢)才出紅記號", cell("local", { alive: true, report: rep({ halt: { halted: true, source: "web", at: "t1" } }) }) === "real,false,," && cell("local", { alive: true, report: rep({ halt: { halted: true, source: "reconciler", at: "t1" } }) }) === "real,false,bad,env.st.autoPaused");
  ok("看過才消:同一件事 sig 相同,換一件 sig 不同", envCell("cloud", cloudSt(okc("running"), rep({ halt: { halted: true, source: "reconciler", at: "t1" } }))).sig === "halt:t1" && envCell("cloud", cloudSt(okc("running"), rep({ halt: { halted: true, source: "reconciler", at: "t2" } }))).sig === "halt:t2" && envCell("cloud", cloudSt(okc("running"))).sig === null);
  ok("雲端:未登入 / 未啟動只有字(格子照樣可按);啟動中 = busy;已停機 = 錢記號 + 紅記號", cell("cloud", cloudSt({ code: "NO_LOGIN" }, null)) === ",false,,env.st.signedOut" && cell("cloud", cloudSt(okc("none"), null)) === ",false,,env.st.none" && cell("cloud", cloudSt(okc("starting"), null)) === ",false,busy,side.starting" && cell("cloud", cloudSt(okc("stopped"), rep(), false)) === "real,false,bad,side.stopped");
  ok("雲端:停機主機的舊快取(alive=false)不可以亮綠點;讀不到 / 還沒問到什麼都不講", cell("cloud", cloudSt(okc("running"), rep(), false)) === "real,false,," && cell("cloud", cloudSt({ code: "OFFLINE" }, null)) === ",false,," && cell("cloud", null) === ",false,,");
  ok("雲端:運行中 + 回報夠新才是下單中", cell("cloud", cloudSt(okc("running"))) === "real,true,,");

  // ── 切換器 A 案:格內只留一個記號;錢記號與狀態詞進 title / aria-label ──
  const halted = envCell("cloud", cloudSt(okc("running"), rep({ halt: { halted: true, source: "reconciler", at: "t1" } })));
  ok("A 記號優先序:沒看過的出事 = 紅短劃;看過同一件 = 沒有記號;換一件再亮", envCellMark(halted, undefined) === "bad" && envCellMark(halted, "halt:t1") === null && envCellMark(halted, "halt:t0") === "bad");
  ok("A 啟動中 = 呼吸點;下單中 = 綠點;平常 / 未登入 / 未啟動 = 什麼都沒有", envCellMark(envCell("cloud", cloudSt(okc("starting"), null))) === "busy" && envCellMark(envCell("cloud", cloudSt(okc("running")))) === "run"
    && [cloudSt(okc("none"), null), cloudSt({ code: "NO_LOGIN" }, null), cloudSt(okc("running"), rep({ halt: { halted: true, source: "web" } }))].every((x) => envCellMark(envCell("cloud", x)) === null));
  const W = (x) => { const w = envCellWords(x); return w.money + "|" + w.state; };
  ok("A 另一邊的詞進得了 title / aria-label:真錢 + 已自動暫停(看過之後詞還在);下單中;未登入;平常什麼都沒有", W(halted) === "tr.mode.real|env.st.autoPaused" && W(envCell("cloud", cloudSt(okc("running")))) === "tr.mode.real|tr.autoOn"
    && W(envCell("cloud", cloudSt({ code: "NO_LOGIN" }, null))) === "null|env.st.signedOut" && W(envCell("local", { alive: true, report: rep({ venues: P, account: null, halt: { halted: true, source: "web" } }) })) === "tr.mode.paper|null");
  ok("trPaintHead 裡沒有未宣告的 st(踩過:雲端正常讀得到時整頁丟 ReferenceError、標題停在上一邊的字)", !/(^|[^.\w])st\b/.test(fn("trPaintHead")));
  // 設計師 R2-1:同一份狀態下,切換器那一格的詞(tooltip)= 標題描述 = 頂列右邊那一句(後兩者都出自 trStateText)
  const same = (st) => envCell(st.cloud ? "cloud" : "local", st, false).word === envHeadWord(envHeadState(st, 1e12), st);
  const autoH = { halt: { halted: true, source: "reconciler", at: "t1" } }, userH = { halt: { halted: true, source: "web", at: "t1" } };
  ok("R2-1 三處同一個詞:自動暫停(雲端 / 這台電腦)、已停機;人按的暫停與下單中都沒有特別的詞", [cloudSt(okc("running"), rep(autoH)), { alive: true, report: rep(autoH) }, cloudSt(okc("stopped", { stale: true }), rep(), false), cloudSt(okc("running"), rep(userH)), cloudSt(okc("running")), { alive: true, report: rep() }].every(same)
    && envHeadWord("halted", cloudSt(okc("running"), rep(autoH))) === "env.st.autoPaused" && envHeadWord("halted", cloudSt(okc("running"), rep(userH))) === null && envHeadWord("dead", cloudSt(okc("stopped"), rep(), false)) === "side.stopped");
  ok("R2-1 寫法:trStateText 的暫停與停機兩句都出自 envHeadWord 那兩個 key", /envHeadWord\(state, TR\.st\) === "env\.st\.autoPaused" \? t\("env\.st\.autoPaused"\)/.test(fn("trStateText")) && /=== "stopped"\) return t\("side\.stopped"\)/.test(fn("trStateText")));
  ok("側欄頂不再寫「雲端 / 這台電腦」(Wei):DOM、CSS、程式、字串都沒有 envhead 與「主機運行中」", !/envhead/.test(html + code + fs.readFileSync(path.join(R, "trade.css"), "utf8")) && !/side\.cloud\.(running|headAria|stopped)/.test(code + fs.readFileSync(path.join(R, "strings.js"), "utf8")));
  const cellSrc = fn("envPaintCell");
  ok("A 格內不再放錢記號與狀態詞(只 append 圖示與一個記號);詞進 title 與 aria-label", (cellSrc.match(/b\.appendChild\(/g) || []).length === 2 && !/"mode |"w"|"w /.test(cellSrc) && /b\.title = tip \+/.test(cellSrc) && /setAttribute\("aria-label", tip\)/.test(cellSrc) && /aria-keyshortcuts/.test(cellSrc));
  const css = fs.readFileSync(path.join(R, "trade.css"), "utf8");
  ok("A 選中格不反白(不用 --control-fill)、格寬固定 40", !/\.envsw[^{]*\{[^}]*--control-fill/.test(css) && /\.envsw button \{[^}]*width: 40px/.test(css) && /\.envsw button\[aria-pressed="true"\] \{[^}]*--surface-control-on/.test(css));
  { const appCss = fs.readFileSync(path.join(R, "app.css"), "utf8");
    ok("雲端沒主機:兩份 .strat-list 都藏起來時「設定」仍釘底(.ws-foot 自己 margin-top:auto,不靠清單的 flex:1 撐)", /\.ws-foot \{[^}]*margin-top: auto;/.test(appCss)
      && /\$\("strat-list"\)\.hidden = cloud; \$\("strat-list-cloud"\)\.hidden = !cloud \|\| gate;/.test(fn("envPaint"))); }
  ok("A 看得見的這一邊:錢記號在切換器右邊那一句的最前面", /<\/div>\s*<span class="mode" id="tr-tb-mode"[^>]*><\/span><span class="tb-txt"/.test(html) && !/tb-sep/.test(html + code + css));

  // ── 稽核 N1:雲端讀不到新狀態時,文字不可以斷言「沒在跑」;綠點照樣不亮 ──
  const NOW = 1e12, MIN = 60000;
  const tr0 = okc("running", { transient: "OFFLINE", stale: true, last_ok_at: NOW - 40000 });
  ok("N1 連不上 + 上一份說在下單:文字用的狀態是 running(不是 dead → 不寫「對帳沒有在跑」、鈕字不變「啟動下單」)", envHeadState(cloudSt(tr0, rep(), false), NOW) === "running" && trExecState(cloudSt(tr0, rep(), false)) === "dead");
  ok("N1 同一份:切換器的綠點、側欄列尾仍然保守(不亮、不講)", envCell("cloud", cloudSt(tr0, rep(), false)).run === false && envStratWord("a", cloudSt(tr0, rep(), false)) === null);
  ok("N1 回報過舊(不是連不上)、主機仍運行:同樣用回報自己說的", envHeadState(cloudSt(okc("running", { stale: true, last_ok_at: NOW - 40000 }), rep(), false), NOW) === "running");
  ok("R2 睡眠醒來的空窗(alive 已被壓成 false,但 transient / stale 都還沒立):仍用回報自己說的,不寫「對帳沒有在跑」", envHeadState(cloudSt(okc("running", { last_ok_at: NOW - 4 * MIN }), rep(), false), NOW) === "running" && envCell("cloud", cloudSt(okc("running"), rep(), false)).run === false);
  ok("N1 上一份說已暫停 → halted", envHeadState(cloudSt(tr0, rep({ halt: { halted: true, source: "web" } }), false), NOW) === "halted");
  ok("N1 停機不變(舊快取不被扶正);讀得到時 = trExecState;這台電腦不受影響", envHeadState(cloudSt(okc("stopped", { stale: true }), rep(), false), NOW) === "dead" && envCloudKind(cloudSt(okc("stopped", { stale: true }), rep(), false)) === "stopped"
    && envHeadState(cloudSt(okc("running")), NOW) === "running" && envHeadState({ alive: false, report: rep() }, NOW) === "dead");
  // Wei:上一份回報說的話最多信 1 小時
  const aged = (ms) => cloudSt(okc("running", { transient: "OFFLINE", stale: true, last_ok_at: NOW - ms }), rep(), false);
  ok("信任上限:59 分鐘仍 running;61 分鐘退成 unknown(不說在下單、也不說停了);剛好 1 小時仍信", envHeadState(aged(59 * MIN), NOW) === "running" && envHeadState(aged(61 * MIN), NOW) === "unknown" && envHeadState(aged(ENV_TRUST_MS), NOW) === "running" && ENV_TRUST_MS === 3600000);
  ok("信任上限:last_ok_at 為 0 / 缺席 / 在未來(時鐘被調)= 沒有可以信的東西 → unknown;沒給 now 也不會被當成可信", envHeadState(aged(NOW), NOW) === "unknown" && envHeadState(cloudSt(okc("running", { stale: true }), rep(), false), NOW) === "unknown"
    && envHeadState(aged(-5 * MIN), NOW) === "unknown" && envHeadState(aged(59 * MIN)) === "unknown");
  ok("信任上限:過了之後綠點照樣不亮、停機與讀得到的情況不受影響", envCell("cloud", aged(61 * MIN)).run === false && envHeadState(cloudSt(okc("running")), NOW) === "running" && envHeadState(cloudSt(okc("stopped", { stale: true, last_ok_at: 1 }), rep(), false), NOW) === "dead");
  // 稽核 R3:連得上、但主機上的回報器停了——last_ok_at 每輪都是新的,要看回報本身多舊(用伺服器的兩個時間相減)
  const repAged = (h, extra = {}) => cloudSt(okc("running", { stale: true, last_ok_at: NOW - 1000, fetched_at: NOW - 1000, reported_at: (NOW - h * 3600e3) / 1000, server_time: NOW / 1000, ...extra }), rep(), false);
  ok("R3 回報 2 小時前 → unknown;30 分鐘前 → 照信;時鐘差不影響(這台電腦快 3 小時、伺服器的兩個時間照舊)", envHeadState(repAged(2), NOW) === "unknown" && envHeadState(repAged(0.5), NOW) === "running"
    && envHeadState(repAged(0.5, { last_ok_at: NOW + 3 * 3600e3 - 1000, fetched_at: NOW + 3 * 3600e3 - 1000 }), NOW + 3 * 3600e3) === "running");
  ok("R3 拿到之後又擱了很久也算進去(50 分鐘前的回報 + 擱了 20 分鐘);沒有 server_time 就只看連線那一條", envHeadState(repAged(50 / 60, { last_ok_at: NOW - 20 * MIN, fetched_at: NOW - 20 * MIN, server_time: (NOW - 20 * MIN) / 1000, reported_at: (NOW - 70 * MIN) / 1000 }), NOW) === "unknown"
    && envHeadState(repAged(2, { server_time: null }), NOW) === "running");
  ok("雲端不知道現況:不放主鈕(鈕字不替它下結論)、標題用中性那句", /\(ro && state === "unknown"\)\)\) \{ if \(b\) b\.remove\(\); return; \}/.test(fn("trPaintHead")) && /state === "unknown"\) return t\("tr\.cloud\.unknown"\)/.test(fn("trStateText")));
  // ── 稽核 N2:紅字看「多久沒成功」,不是畫面讀了幾次 ──
  const T = 1e12, snap = { transient: "OFFLINE", last_ok_at: T };
  ok("N2 同一份 snapshot 讀三次(一次網路抖動)不出紅字;超過三個週期才出;讀得到就收", [0, 16000, 32000].every((d) => envUnreachAlert(snap, T + d) === false) && envUnreachAlert(snap, T + ENV_UNREACH_MS + 1) === true
    && envUnreachAlert({ last_ok_at: T }, T + 1e9) === false && envUnreachAlert(null, T) === false && envUnreachAlert({ transient: "OFFLINE", last_ok_at: 0 }, T) === false);

  // ── 稽核 N8:兩袋不串(原文列舉;這些東西不起 DOM 測不到行為,只守住寫法)──
  const kd = code.slice(code.indexOf('document.addEventListener("keydown"', code.indexOf("function envWire(")), code.indexOf("onCloudState", code.indexOf("function envWire(")));
  // 切視角的入口列舉:切換器的 click、⌘1/⌘2、app 選單的 IPC——全部走 envSwitchGuarded;守門規則只有 envCanSwitch 一份
  const wire = fn("envWire"), direct = (code.match(/[^\w]envSwitch\(/g) || []).length;
  ok("N8 守門只有一份:確認框 / 連接交易所的框 / 圖片放大開著、還沒進工作頁都不切;組字中不生效", ["view-ws", "del-scrim", "cx-scrim", "lb-scrim"].every((id) => fn("envCanSwitch").includes(id)) && /!envCanSwitch\(\)\) return false;/.test(fn("envSwitchGuarded")) && /isComposing/.test(kd));
  ok("三個入口都走 envSwitchGuarded(click / keydown / onEnvSwitch),envWire 裡沒有人直接叫 envSwitch", (wire.match(/envSwitchGuarded\(/g) || []).length === 3 && !/[^\w]envSwitch\(/.test(wire) && /onEnvSwitch\(\(env\) => \{ envSwitchGuarded\(env\); \}\)/.test(wire));
  ok("直接叫 envSwitch 的只有兩處:宣告本身與守門那一支(renderer 沒有別的後門)", direct === 2 && !/[^\w]envSwitch\(/.test(app));
  // 連接交易所的框只連這台電腦:狀態固定用本機那一袋;雲端視角開不起來(硬擋,不只靠那顆鈕的 aria-disabled)
  ok("N8 連接交易所的框固定用這台電腦那一袋", ["cxModalOpen", "cxModalPaint", "cxConnect", "cxRetest"].every((n) => /const L = TR_BAGS\.local[,;]/.test(fn(n))) && !/\bTR\.(cx|st|api)\b/.test(fn("cxModalPaint") + fn("cxConnect") + fn("cxRetest")));
  ok("連接交易所的框在雲端視角開不起來、也送不出去", /^function cxModalOpen\(opener\) \{\s*if \(ENV\.cur !== "local" \|\| TR\.env !== "local"/.test(fn("cxModalOpen")) && /if \(L\.cx\.busy \|\| ENV\.cur !== "local"/.test(fn("cxConnect")) && /ENV\.cur !== "local"\) return;/.test(fn("cxRetest")));
  ok("雲端的「連接交易所」「重新測試」「解除綁定」都不接 click(aria-disabled + 說明)", /if \(TR\.env === "cloud"\) \{ b\.classList\.add\("is-ro"\);[^\n]*\}\s*else b\.addEventListener\("click", \(\) => cxModalOpen\(b\)\)/.test(fn("trPaintOnboard")) && /if \(ro\) \[rt, ub\]\.forEach/.test(fn("trPaintSet")));
  ok("設定 › 連線分類清乾淨:DOM、程式、字串都沒有", !/set-conn|data-set-cat="conn"/.test(html) && !/cxPaint\(|cxOpen\(|set-conn|"conn"/.test(code + app) && !/"(set\.cat\.conn|cx\.unbindHint|cx\.unbindLink|cx\.acct\.title)"/.test(fs.readFileSync(path.join(R, "strings.js"), "utf8")));
  // 設計師規格 v2 方案 C:存放說明收進「金鑰存在哪?」展開列——仍然只在不是模擬交易時出現,而且誠實揭露那句原文要在
  ok("金鑰存放說明(cx.lead)在框裡的展開列,只在不是模擬交易時出現;展開狀態重畫時保住", (() => { const i = src.indexOf('if (venue === PAPER) box.appendChild(trEl("p", "cx-manual-note", t("cx.paperNote")));'), j = src.indexOf('box.appendChild(note);', i), body = src.slice(i, j);
    return i > 0 && j > i && /\n\s*else \{/.test(body) && /trEl\("button", "cx-disc", t\("cx\.store\.q"\)\), store = trEl\("p", "cx-disc-p", t\("cx\.lead"\)\)/.test(body) && /aria-expanded", CXF\.storeOpen \? "true" : "false"\); store\.hidden = !CXF\.storeOpen;/.test(body)
      && (src.match(/t\("cx\.lead"\)/g) || []).length === 1; })());
  { const S = fs.readFileSync(path.join(R, "strings.js"), "utf8");
    ok("誠實揭露原文保留(zh / en):agent 和策略程式讀得到金鑰;沒有「永遠不經過 agent」這類說法", /"cx\.lead": "[^"]*agent 和你的策略程式讀得到/.test(S) && /"cx\.lead": "[^"]*The agent and your strategy code can read them/.test(S) && !/不經過 agent|不會經過 agent|never (reach|pass through|go through) the agent/i.test(S));
    ok("規格刪掉的 key 兩語都刪了;錯誤句保留「通常是」不寫成斷言", !/"cx\.(perm|whitelist|ip\.local|ip\.localNoIp|ip\.copy)"/.test(S) && /"cx\.chk\.trading": "[^"]*通常是/.test(S) && /"cx\.chk\.trading": "[^"]*Usually/.test(S));
    ok("複製元件:icon 鈕有可及名稱、成功才換勾並在 status 槽講「已複製」2 秒;「IP 換了」句子不再夾 {ip}", /b\.setAttribute\("aria-label", t\("cx\.ip\.copyThis"\)\)/.test(src) && /said\.setAttribute\("role", "status"\)/.test(src)
      && /await navigator\.clipboard\.writeText\(ip\); \} catch \(_\) \{ return; \}\s*b\.classList\.add\("is-done"\); said\.textContent = t\("cx\.ip\.copied"\);\s*setTimeout\([^\n]*2000\)/.test(src) && !/"cx\.re\.ipChanged": "[^"]*\{ip\}/.test(S) && /t\("cx\.re\.ipChanged"\)\s*:/.test(src)); }
  const afterAwait = ["trPoll", "trOpen", "trRun", "trSaveAmounts", "trUnbind", "trLoadCurve", "cxConnect", "cxRetest"].map((n) => { const b = fn(n), i = b.indexOf("await "); return [n, i < 0 ? "" : b.slice(i).replace(/TR === S|TR_BAGS|TR_[A-Z_]+/g, "")]; });
  const leaks = afterAwait.filter((x) => /\bTR\b/.test(x[1])).map((x) => x[0]);
  ok("N8 跨 await 的流程在第一個 await 之後不碰裸的 TR(只准 TR === S 與 TR_BAGS):" + (leaks.join() || "無"), afterAwait.every((x) => x[1].length > 0) && leaks.length === 0);
  ok("N3/N4/N7 寫法:設定開著不搬焦點、切視角前放掉輸入框焦點、排下一輪在 finally", /if \(!\$\("set-scrim"\)\.hidden\) \{[^}]*\}\s*else if \(via === "link"\)/.test(fn("envSwitch")) && /\.blur\(\)/.test(fn("envSwitch")) && /finally \{[\s\S]*TRP\.timer = setTimeout\(trPoll/.test(fn("trPoll")));
  ok("N5 雲端清單每次拿到狀態就跟著換(不管看哪一邊)", /C\.st = await C\.api\.tradeStatus\(\);[\s\S]{0,300}await trLoadStrategies\(C\)/.test(fn("trPoll")));

  // ── 雲端視角的開通頁(規格 §3 對照表)──
  const OV = (k, tok, pv) => envOpenView(k, tok, pv);
  ok("開通頁:未登入 / 舊登入要重登 / 沒綁卡(兩種)/ 可以啟動(三種)", OV("signedOut", false, "out") === "out" && OV("signedOut", true, "plan") === "relogin" && OV("none", true, "offer") === "card" && OV("none", true, "noTrial") === "card"
    && ["trial", "plan", "included"].every((pv) => OV("none", true, pv) === "start"));
  ok("開通頁:任一邊說啟動中就是啟動中(剛按下啟動、cloud.js 還說沒主機);沒登入的人不會被帳號那邊的殘值帶成啟動中", OV("starting", true, "plan") === "starting" && OV("none", true, "starting") === "starting" && OV("none", false, "starting") === "out");
  ok("開通頁:讀不到 / 還沒問到不畫開通內容;帳號狀態還沒到或兩邊對不上 = unknown(給重查,不給啟動)", OV("unreach", true, "plan") === "unreach" && OV("loading", false, "out") === "loading" && ["unknown", "out", "running", "stopped"].every((pv) => OV("none", true, pv) === "unknown"));
  const ep = fn("envPaintEmpty");
  ok("開通頁重用已上線的流程:登入 planLogin、重登 planRelogin、啟動 planAsk(花錢的確認框);這裡不直接碰 planStart / startOAuth / confirmBox", /planLogin/.test(ep) && /planRelogin/.test(ep) && /t\("plan\.start"\), planAsk,/.test(ep) && !/planStart|startOAuth|confirmBox\(|planGo/.test(ep + fn("envPlanChanged")));
  ok("價格不寫死:數字只來自 planVars;拿不到月價就不畫價格段、啟動鈕 disabled", /if \(v\.p\) \{\s*const pr = trEl\("div", "plan-price"\)/.test(ep) && /main\.disabled = !\(v\.p && v\.h\)/.test(ep) && !/[0-9]{2,}\s*(TWD|USD)/.test(ep));
  ok("查帳號 / 公開價目有間隔(查不到時不空轉)", /Date\.now\(\) - \(ENV\.askedAt \|\| 0\) > 30000/.test(ep));
  ok("空側欄那一句在、舊空態兩個 key 清掉", /id="side-gate" data-i18n="side\.cloud\.emptyGate"/.test(html) && /\$\("side-gate"\)\.hidden = !gate/.test(code) && !/"env\.empty\.(p1|plan)"/.test(fs.readFileSync(path.join(R, "strings.js"), "utf8") + code));

  // ── 最低版本閘 / 交給主行程的字 ──
  ok("UPDATE_REQUIRED:確定沒執行(不留過場)、講更新那一句,不叫人重按", trErrorKind("UPDATE_REQUIRED") === "undelivered" && /if \(e === "UPDATE_REQUIRED"\) return t\("minv\.trade"\);/.test(fn("trSendError")));
  ok("聊天被擋:不再誤畫成「上一輪還在跑」", /if \(r\.blocked === "UPDATE_REQUIRED"\) \{[\s\S]{0,400}t\("minv\.chat"\)[\s\S]{0,300}unlock\(\); return false;\s*\}\s*addMsg\("sys", t\("turn\.busy"\)\)/.test(app));
  const labels = fn("trPushLabels");
  ok("tradeLabels 多交的 15 個 key 都在(換語言時 applyStatic 會重叫 trPushLabels)", ["lang: LANG", "stLocal", "stCloud", "stOn", "stPaused", "stUnknown", "moneyPaper", "moneyReal", "pauseLocal", "quitCloudNote", "notifPrefixLocal", "notifPrefixCloud", "menuLocal", "menuCloud", "menuSite"].every((k) => labels.includes(k)) && /trPushLabels\(\)/.test(fn.call(null, "trInit") + app));

  // ── 側欄列尾 ──
  ok("列尾狀態字:有投入金額的才講;下單中 / 已停;主機沒在下單就不講", envStratWord("a", cloudSt(okc("running"))) === "side.cloud.st.trading" && envStratWord("b", cloudSt(okc("running"))) === null && envStratWord("zz", cloudSt(okc("running"))) === null
    && envStratWord("a", cloudSt(okc("running"), rep({ halt: { halted: true } }))) === "side.cloud.st.halted" && envStratWord("a", cloudSt(okc("stopped"), rep(), false)) === null && envStratWord("a", null) === null);

  process.removeAllListeners("beforeExit");
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
