// 電腦版「這台電腦｜雲端」(shell/renderer/trade.js 的「視角純邏輯」+ 原文列舉)。
//   1. 雲端的寫入只走 cloudSend 這一條:白名單外的指令(含 credentials)送不出去,而且不會退回去碰這台電腦的東西
//   2. 列舉:trade.js / app.js 裡每一個送指令的地方都經過 envApi
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
  const evCalls = [], sendCalls = [];
  const host = { cloudStatus: async () => cloudSt(okc("running", { strategies: [{ name: "a", display_name: "Alpha", has_backtest: true, symbol: "BTCUSDT", updated_at: 5 }, { name: "" }, null, { nope: 1 }] })),
    cloudEvents: async (q) => { evCalls.push(q); return evReply; },
    cloudSend: async (...a) => { sendCalls.push(a); return { ok: true, result: {}, requestId: "rid" + "0".repeat(13) }; } };
  let evReply = { code: "OK", events: [{ ts: 1, type: "halt", data: {} }] };
  ENV_API.forEach((k) => { host[k] = (...a) => { touched.push(k); return Promise.resolve({ ok: true, from: "local", a }); }; });
  const C = envApi("cloud", host);
  /* 雲端的寫入:只有**這一批真的有 UI 在用**的四個走得出去,其餘一律 NOT_ALLOWED 且完全不碰 host。
     `credentials` 永遠不在裡面(金鑰不經過這條通用路,cloudcmd.js 檔頭契約 ①);
     `amounts`(S4)、`credentials_remove` / `retest_accounts` / `restart_reconciler`(S5)各自出貨時再加回來——
     沒有 UI 在用的指令不該是「renderer 被攻破就打得通」的面(稽核 S-2)。 */
  const CMDS = ["halt", "close_all", "resume", "resume_wait"];
  const sent = []; for (const c of CMDS) sent.push(await C.tradeSend(c, { reason: "x" }));
  ok("雲端:白名單那四個指令都經過主行程的 cloudSend(帶 cmd / args / requestId 三個參數),回傳原樣往上交",
    sent.every((r) => r && r.ok === true) && sendCalls.length === CMDS.length
    && sendCalls.map((a) => a[0]).join() === CMDS.join() && sendCalls.every((a) => a.length === 3 && JSON.stringify(a[1]) === '{"reason":"x"}' && a[2] === null) && touched.length === 0);
  const bad = []; for (const c of ["credentials", "amounts", "credentials_remove", "retest_accounts", "restart_reconciler", "", "halt2", null]) bad.push(await C.tradeSend(c, {}));
  ok("雲端:白名單外的指令(含 credentials 與還沒出貨的那四個)回 NOT_ALLOWED / undelivered,而且一次都沒碰到 cloudSend",
    bad.every((r) => r && r.ok === false && r.error === "NOT_ALLOWED" && trKindOf(r) === "undelivered")
    && sendCalls.length === CMDS.length && trErrorKind("NOT_ALLOWED") === "undelivered");
  { const c2 = envApi("cloud", host); await c2.tradeSend("halt", {}, "rid" + "0".repeat(13));
    ok("雲端:重試時呼叫端帶著上一趟那顆 request_id,這一層原樣往下傳(冪等靠它)", sendCalls[sendCalls.length - 1][2] === "rid" + "0".repeat(13)); }
  const st = await C.tradeStatus(), list = await C.listStrategies(), one = await C.loadStrategy("a"), eq = await C.tradeEquity({ days: 30 }), ev = await C.tradeEvents({ days: 30 });
  ok("雲端:讀的那幾支也沒有碰到這台電腦的 api(不把本機的數字畫在雲端那一頁)", touched.length === 0);
  ok("雲端:狀態讀 cloudStatus;清單來自同一份狀態,壞的列濾掉、形狀同本機 listStrategies", st.cloud.code === "OK" && list.length === 1 && list[0].name === "a" && list[0].displayName === "Alpha" && list[0].hasBacktest === true && list[0].symbol === "BTCUSDT" && list[0].remote === true && list[0].mtime === 5);
  ok("雲端:還沒做的端點回空的(單支策略 / 權益曲線)", one === null && JSON.stringify(eq) === '{"curve":[]}');
  ok("雲端:事件清單打主行程的 cloudEvents(帶著 days),原樣往上交", JSON.stringify(evCalls) === '[{"days":30}]' && ev.code === "OK" && JSON.stringify(ev.events) === JSON.stringify(evReply.events));
  // 讀不到 ≠ 沒有事件:壞回應、主行程拒絕、拿到的不是陣列,一律 UNREACH(畫面照這個 code 說自己讀不到)
  { const bads = [null, undefined, { code: "UNREACH", events: [] }, { code: "OK", events: "nope" }, { events: [{ ts: 1, type: "halt" }] }, []];
    const got = []; for (const b of bads) { evReply = b; got.push(await C.tradeEvents({ days: 30 })); }
    ok("雲端:事件讀不到 → { code: UNREACH, events: [] },不炸、也不畫成「沒有事件」", got.every((r) => r.code === "UNREACH" && Array.isArray(r.events) && r.events.length === 0)); }
  evReply = { code: "OK", events: [] };
  ok("雲端:真的沒有事件 = OK + 空陣列(跟讀不到分得出來)", (await C.tradeEvents({ days: 30 })).code === "OK");
  // 這台電腦同一個形狀:本機是檔案,檔不在就是真的沒發生過事,永遠 OK
  { const ls = await envApi("local", { tradeEvents: async () => null }).tradeEvents({ days: 30 });
    const ls2 = await envApi("local", { tradeEvents: async () => [{ ts: 1, type: "halt" }] }).tradeEvents({ days: 30 });
    ok("這台電腦:事件也是 { code, events } 同一個形狀,而且永遠 OK(本機檔案沒有讀不到這一態)", ls.code === "OK" && ls.events.length === 0 && ls2.code === "OK" && ls2.events.length === 1);
    // 宿主讀不到那個檔(EACCES / 檔壞了)會往上拋:這一層**不可以**吞掉,吞了就變成「這段期間沒有事件」
    let rejected = false;
    try { await envApi("local", { tradeEvents: async () => { throw new Error("EACCES"); } }).tradeEvents({ days: 30 }); } catch (_) { rejected = true; }
    ok("這台電腦:宿主拋出來的讀取錯誤原樣往上拋(讓畫面畫成讀不到),不在這一層吞掉", rejected); }
  evReply = { code: "OK", events: [{ ts: 1, type: "halt", data: {} }] };
  const cloudHalf = noComments(env).slice(noComments(env).indexOf("let last = null;"), noComments(env).indexOf("function envCloudList("));
  // 雲端那份 api 碰得到的主行程 api 就這三支:兩支讀 + 一支寫。多一支就是多一條雲端視角碰得到的路
  ok("雲端那份 api 的原文裡,host 只被拿來叫 cloudStatus / cloudEvents / cloudSend", cloudHalf.length > 50 && (cloudHalf.match(/host\s*[.\[]\s*\w*/g) || []).join() === "host.cloudStatus,host.cloudEvents,host.cloudSend");
  const L = envApi("local", host); await L.tradeSend("halt", {}); await L.tradeStatus();
  ok("這台電腦:原樣轉給主行程", touched.join() === "tradeSend,tradeStatus" && L.env === "local" && C.env === "cloud");
  ok("兩份 api 介面相同(自動下單頁換一個來源就能畫)", ENV_API.every((k) => typeof C[k] === "function" && typeof L[k] === "function"));

  // ── 2. 原文列舉 ──
  const code = noComments(src), app = noComments(fs.readFileSync(path.join(R, "app.js"), "utf8"));
  ok("trade.js 不直接叫主行程的那六支(一律經過 envApi)", !new RegExp("window\\.blave\\.(" + ENV_API.join("|") + ")\\b").test(code));
  ok("app.js 不送交易指令、不讀交易狀態", !/\btrade(Send|Status|Equity|Events)\b/.test(app));
  const sends = code.match(/[\w.]*\btradeSend\(/g) || [];
  ok("每一個送指令的地方都是「自己那一份狀態的 api」(S.api / L.api),共 " + sends.length + " 處", sends.length >= 5 && sends.every((x) => x === "S.api.tradeSend(" || x === "L.api.tradeSend("));
  // L = TR_BAGS.local(設定 › 連線這一刀永遠是這台電腦的);S = 進來那一刻的 TR
  const fn = (name) => { const i = code.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); const j = code.indexOf("\nfunction ", i + 1), k = code.indexOf("\nasync function ", i + 1); return code.slice(i, Math.min(j < 0 ? 1e9 : j, k < 0 ? 1e9 : k)); };
  const entries = ["trSend", "trSaveAmounts", "trUnbind"];
  const users = code.split(/\n(?:async )?function /).filter((b) => /S\.api\.tradeSend\(/.test(b)).map((b) => b.slice(0, b.indexOf("(")));
  ok("用 S.api 送指令的函式就是這幾個(多一個就要有人看過它的 request_id 有沒有沿用):" + users.join(), users.length === entries.length && users.every((n) => entries.indexOf(n) >= 0));
  // 會改變執行狀態的那三個指令一律經過 trSend(冪等:重試沿用同一顆 request_id);直接叫 S.api.tradeSend 會繞過它
  ok("啟動 / 暫停 / 全部平倉都經過 trSend", ["halt", "close_all", "resume", "restart_reconciler"].every((c) => new RegExp('trSend\\(S, (cmd|"' + c + '")').test(fn("trAskStop") + fn("trAskStart")))
    && !/S\.api\.tradeSend\(/.test(fn("trAskStop") + fn("trAskStart") + fn("trRun")));
  // R2-1:每一次 trRun 都要把 cmd 記進意圖(平倉那趟的結果永遠要講,靠的就是這個標記);漏標的話 close_all 的失敗會被 B-4 的守衛吞掉
  ok("trRun 的三個呼叫點都帶 cmd:halt / close_all 字面、啟動那邊帶 go(cmd) 的 cmd",
    /\], "halt"\)/.test(fn("trAskStop")) && /\], "close_all"\)/.test(fn("trAskStop")) && /\], cmd\);/.test(fn("trAskStart"))
    && /if \(mine\.cmd === "close_all" && !\(res && res\.ok\)\) trAlert\(trSendError\(res, "stop", S\.env\), null, S\);/.test(fn("trRun")));
  // R2-5:兩層白名單是刻意的雙層防守(主行程一層、renderer 一層),但兩份要逐項相等——漂移了得有人紅
  { const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
    const shipped = JSON.parse((mainSrc.match(/const CLOUD_SHIPPED = (\[[^\]]*\]);/) || [])[1] || "null");
    ok("renderer 的 ENV_CLOUD_CMDS 與主行程的 CLOUD_SHIPPED 逐項相等", Array.isArray(shipped) && JSON.stringify(ENV_CLOUD_CMDS) === JSON.stringify(shipped)); }
  /* 冪等(契約 §4):沒排進佇列的失敗與 ack 逾時之後再按 = 同一個意圖 → 沿用上一趟那顆 request_id;
     被接受 / 被主機拒絕 = 這一顆用完了,下一次換新的。不沿用的話,「429 其實前一次已經進去了」會變成 close_all 跑兩次。 */
  { eval("async " + fn("trSend"));
    const rids = [], bag = { reqIds: {}, sending: {}, api: { tradeSend: async (cmd, args, rid) => { rids.push(rid); return reply; } } };
    let reply = { ok: false, error: "RATE_LIMITED", kind: "undelivered", requestId: "R1" };
    await trSend(bag, "close_all", {}); await trSend(bag, "close_all", {});
    reply = { ok: false, error: "UNKNOWN_RESULT", kind: "unknown", requestId: "R1" };
    await trSend(bag, "close_all", {});
    ok("重試沿用同一顆 request_id(沒送到、結果不明都沿用);別的指令各有各的", rids.join() === ",R1,R1" && bag.reqIds.close_all === "R1" && bag.reqIds.halt === undefined);
    reply = { ok: true, result: {}, requestId: "R1" };
    await trSend(bag, "close_all", {});
    ok("機器收下了 → 這一顆用完(下一次是新的意圖,不可再沿用:15 分鐘內同一顆會被當重送、整個不執行)", bag.reqIds.close_all === undefined);
    bag.reqIds.halt = "R2"; reply = { ok: false, error: "boom", kind: "rejected", requestId: "R2" };
    await trSend(bag, "halt", {});
    ok("機器明白拒絕 → 也是用完(它已經執行過判斷了)", bag.reqIds.halt === undefined); }
  ok("用 L.api 送指令的函式:L 一定是這台電腦那一份", code.split(/\n(?:async )?function /).filter((b) => /L\.api\.tradeSend\(/.test(b)).every((b) => /const L = TR_BAGS\.local[,;]/.test(b)));
  ok("trade.js 沒有 innerHTML / insertAdjacentHTML(雲端來的字串一律 textContent)", !/innerHTML|insertAdjacentHTML|outerHTML/.test(code));
  ok("重開一律回這台電腦:現在看哪一邊不寫進 localStorage / sessionStorage", !/(local|session)Storage[^\n]*ws_env/.test(code) && /const ENV = \{ cur: "local"/.test(code));
  const html = fs.readFileSync(path.join(R, "index.html"), "utf8");
  ok("index.html:切換器是兩顆 aria-pressed 的鈕、開場在這台電腦;舊的狀態帶鈕已退場", /id="env-local" data-env="local" aria-pressed="true"/.test(html) && /id="env-cloud" data-env="cloud" aria-pressed="false"/.test(html) && !/tr-tb-btn/.test(html + code));

  // ── 2b. 雲端的寫入:接線、失敗的話、過場 ──
  { const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8"), pre = fs.readFileSync(path.join(__dirname, "..", "shell", "preload.js"), "utf8");
    const h = (mainSrc.match(/\n\s*(ipcMain\.)?handle\("cloud-send"[\s\S]*?\n  \}, cloudDenied\);/) || [""])[0];
    // 用 handle() 包裝(它自己就先過 fromOurPage);拒絕時回的是完整形狀,不是 null——畫面要看得懂那是「沒送到」
    ok("main.js:cloud-send 走 handle(),拒絕時回 { ok:false, error:NOT_ALLOWED, kind:undelivered }",
      /\n  handle\("cloud-send"/.test(mainSrc) && /const cloudDenied = \{ ok: false, error: "NOT_ALLOWED", kind: "undelivered" \};/.test(mainSrc) && h.length > 100);
    // 白名單不另抄一份:來源仍是 daemon.js 的 UI_COMMANDS(= api 的 CLOUD_COMMANDS),再交集這一批出貨的四個
    ok("main.js:cloud-send 的白名單沿用 daemon 的 UI_COMMANDS、明文排除 credentials,再交集這一批出貨的四個",
      /cmd === "credentials" \|\| !require\("\.\/daemon"\)\.UI_COMMANDS\.has\(cmd\) \|\| CLOUD_SHIPPED\.indexOf\(cmd\) < 0/.test(h)
      && /const CLOUD_SHIPPED = \["halt", "close_all", "resume", "resume_wait"\];/.test(mainSrc));
    // 契約 ①:cloudcmd.js 不是 secrets 的信任邊界,閘門在這裡——第三個參數永遠是 null,renderer 塞不進金鑰
    ok("main.js:cloud-send 拒收 secrets(送進 cloudcmd 的第三個參數寫死 null)",
      /cloudCmd\(\)\.send\(cmd, args[^,]*, null, \{ requestId: rid \}\)/.test(h) && !/secret/i.test(h.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")));
    ok("main.js:機器收下了才叫一次 refresh(true);preload 只多暴露 cloudSend 一支",
      /if \(r && r\.ok\) \{ cloudHost\(\)\.start\(\); cloudHost\(\)\.refresh\(true\)\.catch\(\(\) => \{\}\); \}/.test(h)
      && /cloudSend: \(cmd, args, requestId\) => ipcRenderer\.invoke\("cloud-send", cmd, args, requestId\)/.test(pre)); }
  /* 失敗的五種話。409 是**真的沒送出**(api 不排隊、不記稽核):不可沿用本機 daemon 沒跑時 halt 那個「已排隊」,
     也不可沿用本機那組寫死「這台電腦」的句子。已停機不出紅字——整頁會被下一份 state 換成停機態。 */
  { globalThis.t = (k) => k; eval(fn("trSendError"));
    // 雲端的回應一定帶 kind(cloudcmd.js 判的三桶):它知道失敗發生在指令階段還是 ack 階段,本機的代號表看不出來
    const e = (err, kind, extra) => trSendError({ ok: false, error: err, kind: "undelivered", ...extra }, kind, "cloud");
    ok("409 三態各一句:沒有主機 / 還在啟動 / 已停機(不出紅字);machine_state 缺席時不臆測",
      e("MACHINE_NOT_RUNNING", "stop", { machineState: "none" }) === "tr.cloud.noMachine"
      && e("MACHINE_NOT_RUNNING", "stop", { machineState: "starting" }) === "tr.cloud.startingNow"
      && e("MACHINE_NOT_RUNNING", "stop", { machineState: "stopped" }) === ""
      && e("MACHINE_NOT_RUNNING", "stop", { machineState: null }) === "tr.cloud.cmdNotDelivered");
    ok("429 暫停類自己一句(前一次可能已經生效);503 稽核;結果不明 / 被拒 / 其餘各自的雲端版",
      e("RATE_LIMITED", "stop") === "tr.cloud.tooSoonStop" && e("RATE_LIMITED", "start") === "tr.cloud.tooSoon"
      && e("AUDIT_UNAVAILABLE", "start") === "tr.cloud.notSent" && e("UNKNOWN_RESULT", "start", { kind: "unknown" }) === "tr.cloud.cmdUnknown"
      && e("boom", "start", { kind: "rejected" }) === "tr.cloud.cmdRejected" && e("OFFLINE", "start") === "tr.cloud.cmdFailed" && e("OFFLINE", "stop") === "tr.cloud.cmdNotDelivered");
    ok("這台電腦那組一個字都沒變(句子裡寫死「這台電腦」,雲端不可沿用)",
      trSendError({ ok: false, error: "TIMEOUT" }, "stop", "local") === "tr.cmdNotDelivered" && trSendError({ ok: false, error: "UNKNOWN_RESULT" }, "start", "local") === "tr.cmdUnknown"
      && trSendError({ ok: false, error: "UPDATE_REQUIRED" }, "start", "cloud") === "minv.trade");
    delete globalThis.t; }
  /* 稽核 B-1:指令的失敗(§1.4 那五種話)與「讀不到雲端」共用全頁唯一的紅字槽,而 trPaintHead 每一輪都重畫。
     送完指令那一步緊接著就 trPaint(),所以**重畫不可以無條件清空那一格**——清了的話,畫面上一句話都不會出現過
     (只有 srSay 播一次:讀屏聽得到、看得見的人什麼都沒有)。反過來,「讀不到雲端」那一則仍然要自己收。
     這一段真的把 trAlert / trAlertShow 與 trPaintHead 裡那一段原文跑起來,不是看 regex。 */
  { const node = { hidden: true, textContent: "" };
    var ENV = { cur: "cloud" }, srSay = () => {}, $ = () => node;
    var TR = { alertText: "", alertWant: null, alertSrc: null }, TR_BAGS = { cloud: TR, local: {} };
    globalThis.t = (k) => k;
    eval(fn("trAlert") + "\n" + fn("trAlertShow"));
    const head = fn("trPaintHead"), i0 = head.indexOf("if (ro) {");
    const seg = head.slice(i0, head.indexOf("\n  }", i0) + 4);
    const repaint = (c) => new Function("ro", "c", "TR", "trAlert", "envUnreachAlert", "t", "trStamp", seg)(true, c, TR, trAlert, envUnreachAlert, t, () => "x");
    const okNow = { transient: null, last_ok_at: Date.now() }, lost = { transient: "OFFLINE", last_ok_at: Date.now() - 10 * 60 * 1000 };
    if (i0 < 0 || seg.indexOf("envUnreachAlert") < 0) throw new Error("找不到 trPaintHead 裡的紅字槽那一段");
    trAlert("tr.cloud.tooSoonStop", "halted", TR, "cmd");
    repaint(okNow);
    ok("B-1 送完指令寫的那一則錯誤,下一次重畫還在(畫面上真的看得到,不是只有讀屏聽得到)",
      TR.alertText === "tr.cloud.tooSoonStop" && node.textContent === "tr.cloud.tooSoonStop" && node.hidden === false);
    repaint(lost);
    ok("B-1 讀不到雲端時照樣寫自己那一則(這一行不可以被整個刪掉)", TR.alertText === "tr.cloud.unreach" && TR.alertSrc === "unreach");
    repaint(okNow);
    ok("B-1 讀得到了,自己寫的那一則自己收掉", TR.alertText === "" && node.hidden === true);
    /* 稽核 B-2:逾時 = 這個意圖到此為止(Wei 拍板),`reqIds` 要一起清。不清的話下一次按會沿用同一顆,
       而 api 的佔位還在(900 秒)→ 回 duplicate、不再排一次 → 畫面說「結果不明」,機器繼續用真錢跑。 */
    TR = { env: "cloud", st: cloudSt(okc("running")), pending: { want: "halted", until: Date.now() - 1 }, reqIds: { halt: "R1" }, alertText: "", alertWant: null, alertSrc: null };
    TR_BAGS.cloud = TR;
    eval(fn("trPendingCheck"));
    trPendingCheck();
    ok("B-2 逾時:pending 與 reqIds 一起清,而且只說「結果不明」",
      TR.pending === null && Object.keys(TR.reqIds).length === 0 && TR.alertText === "tr.cloud.cmdUnknown");
    TR = { env: "cloud", st: cloudSt(okc("running"), rep({ halt: { halted: true, source: "web" } })), pending: { want: "halted", until: Date.now() + 1e6 }, reqIds: { halt: "R1" }, alertText: "", alertWant: null, alertSrc: null };
    TR_BAGS.cloud = TR; trPendingCheck();
    ok("B-2 收斂:同樣清掉(下一次按是新的意圖)", TR.pending === null && Object.keys(TR.reqIds).length === 0 && TR.alertText === "");
    delete globalThis.t; }
  // 在途的指令:切換器那一格出呼吸點(切走也看得到)。詞不可沿用 side.starting——那是主機在開機,不是指令在路上
  { const c1 = envCell("cloud", cloudSt(okc("running")), true), c2 = envCell("cloud", cloudSt(okc("running"), rep({ halt: { halted: true, source: "reconciler", at: "t1" } })), true);
    ok("雲端有在途指令 → busy + env.st.sending;紅短劃仍然優先;這台電腦那一格不受影響",
      c1.dot === "busy" && c1.word === "env.st.sending" && c1.run === false && c2.dot === "bad" && c2.word === "env.st.autoPaused"
      && envCell("local", { alive: true, report: rep() }, true).dot === null); }
  // 兩袋各自收斂、兩袋任一有過場就把輪詢調快(本機原本只看自己那袋)
  ok("trPoll:兩邊的過場都檢查、任一邊有過場就每 2.5 秒一輪、雲端有過場時每輪都重讀狀態",
    /trWith\(L, trPendingCheck\); trWith\(C, trPendingCheck\);/.test(fn("trPoll")) && /L\.pending \|\| C\.pending \? TR_POLL_PENDING/.test(fn("trPoll"))
    && /ENV\.cloudDirty \|\| C\.pending \|\|/.test(fn("trPoll")) && /envCell\("cloud", C\.st, !!C\.pending\)/.test(fn("envPaint")));
  // 等的過程中主機停機:人要看到的是「它停了」,不是「我按的那個不知道怎樣」
  ok("trPendingCheck:雲端停機 → 直接清過場、不出「結果不明」;收斂了就把 request_id 一起清掉",
    /if \(cloud && envCloudKind\(TR\.st\) === "stopped"\) \{ TR\.pending = null; TR\.reqIds = \{\}; trAlert\(""\); return; \}/.test(fn("trPendingCheck"))
    && /if \(state === p\.want\) \{ TR\.pending = null; TR\.reqIds = \{\}; trAlert\(""\); \}/.test(fn("trPendingCheck")));
  /* 逾時還沒收斂:雲端的 ack 只代表機器收下了,沒收斂多半是那份回報還沒送出來。
     這一條**只准**出「結果不明」——說「沒送到」就是叫一個暫停其實已經生效的人去交易所撤 key(規格 §1.3)。 */
  { const timeout = fn("trPendingCheck").slice(fn("trPendingCheck").indexOf("else if (Date.now() > p.until)"));
    const cloudArm = timeout.slice(0, timeout.indexOf(":"));
    ok("雲端逾時只說「結果不明」,不說「沒送到」、不說「失敗」;這台電腦那兩句原封不動",
      /cloud \? t\("tr\.cloud\.cmdUnknown"\)/.test(cloudArm) && !/cmdNotDelivered|cmdFailed/.test(cloudArm)
      && !/tr\.cloud\.cmdNotDelivered|tr\.cloud\.cmdFailed/.test(timeout)
      && /p\.unknown \? t\("tr\.cmdUnknown"\) : p\.want === "halted" \? t\("tr\.cmdNotDelivered"\) : t\("tr\.cmdFailed"\)/.test(timeout)); }
  /* 雲端啟動**不順帶送 restart_reconciler**(規格 §4.2-2):那份報告可能是一分鐘前的,照它判等於瞎猜——
     多吃一格速率桶、多一筆稽核。本機那條不動。 */
  ok("trAskStart:雲端只送 resume / resume_wait;這台電腦照舊視 trRecRunning 補 restart_reconciler",
    /cloud \? \[\(S\) => trSend\(S, cmd, \{\}\)\] : \[/.test(fn("trAskStart")) && /trRecRunning\(S\.st\) \? \{ ok: true \} : trSend\(S, "restart_reconciler", \{\}\)/.test(fn("trAskStart")));
  /* 緊急停止不可以被自己的過場態鎖住(規格 §1.3,Wei 拍板):前一個指令還在路上不是「不能停」的理由。
     重複送 halt 是安全的(api 有自己的速率桶、本機 daemon 沒跑時照樣排隊 daemon.js:149,而且重試沿用同一顆 request_id)。
     啟動方向照舊鎖住——那個重複送就是真的多開一次倉。 */
  ok("過場中:暫停那一側照樣按得下去;啟動那一側鎖住;沒有過場時兩側都不鎖",
    trBtnLocked({ want: "running" }, true) === false && trBtnLocked({ want: "halted" }, true) === false
    && trBtnLocked({ want: "halted" }, false) === true && trBtnLocked({ want: "running" }, false) === true
    && trBtnLocked(null, false) === false && trBtnLocked(null, true) === false);
  /* 稽核 R2-2:啟動的意圖被機器收下(acked)之後,機器已經確定在下單了,鈕不可以再鎖著等收斂(最長四分鐘)——
     那時它就是「暫停」那一側。ack 之前維持鎖:還不知道有沒有送到,放行會兩顆並飛。 */
  ok("啟動被收下之後就是暫停側(鈕解鎖、click 開的是暫停框);收下之前仍鎖;狀態說在跑的本來就是暫停側",
    trStopSideNow("halted", { want: "running", acked: true }) === true && trBtnLocked({ want: "running", acked: true }, trStopSideNow("halted", { want: "running", acked: true })) === false
    && trStopSideNow("halted", { want: "running" }) === false && trBtnLocked({ want: "running" }, trStopSideNow("halted", { want: "running" })) === true
    && trStopSideNow("halted", { want: "halted", acked: true }) === false && trStopSideNow("running", null) === true && trStopSideNow("halted", null) === false);
  // 三個入口(鈕的可按性、click、真的送出去那一層)只認同一條規則:哪一個漏掉,停止鈕就會在某條路上被鎖住
  ok("鈕 / click / trRun 三處都走 trBtnLocked(鈕與 click 的那一側由 trStopSideNow 判),沒有人再直接用 TR.pending 或 S.pending 擋",
    /const busy = !!TR\.pending, locked = trBtnLocked\(TR\.pending, trStopSideNow\(state, TR\.pending\)\);/.test(fn("trPaintHead"))
    && /aria-disabled", locked \? "true" : "false"/.test(fn("trPaintHead"))
    && /const stopSide = trStopSideNow\(envHeadState\(TR\.st, Date\.now\(\)\), TR\.pending\);\s*if \(trBtnLocked\(TR\.pending, stopSide\)\) return;/.test(fn("trPaintHead"))
    && /if \(res && res\.ok\) \{\s*mine\.acked = true;/.test(fn("trRun"))
    && /if \(trBtnLocked\(S\.pending, want === "halted"\)\) return;/.test(fn("trRun"))
    && !/if \(TR\.pending\) return;|if \(S\.pending\) return;/.test(fn("trPaintHead") + fn("trRun")));
  // 主鈕:雲端不再是唯讀的擺設(停機那一態仍然是「加值」);整頁級的「只能看」退場
  ok("trPaintHead:雲端的主鈕可按(只有停機那一態換成加值鈕),整頁唯讀說明不再畫",
    /if \(ro && stopped\) \{/.test(fn("trPaintHead")) && /trPaintRoNote\(null\);/.test(code) && !/"tr\.ro\.note"/.test(code)
    && /const up = ro \? envCloudKind\(TR\.st\) === "running" : trChannelUp\(TR\.st\);/.test(fn("trPaintHead")));
  // 寫進雲端的確認框要標明目的地(規格 §5:刻意講三次);本機不給那兩個參數,框逐位元組不變
  { const app2 = fs.readFileSync(path.join(R, "app.js"), "utf8"), html2 = fs.readFileSync(path.join(R, "index.html"), "utf8");
    ok("confirmBox 有 env / footWhere / lead 三個選用參數,DOM 兩個槽在,關框時一起收掉",
      /function confirmBox\(\{ title, lines, ok, onOk, opener, alt, mark, markKind, extra, okDisabled, env, footWhere, lead \}\)/.test(app2)
      && /<span class="envm" id="del-env" hidden><\/span>/.test(html2) && /<span class="del-where" id="del-where" hidden><\/span>/.test(html2)
      && /\$\("del-env"\)\.hidden = true; \$\("del-where"\)\.hidden = true; \$\("del-modal"\)\.querySelector\("\.modal-head"\)\.classList\.remove\("cloud"\);/.test(app2.slice(app2.indexOf("function delClose"))));
    ok("雲端的框:灰標題列 + 「雲端」記號 + 錢記號 + 鈕上方的目的地那一行;暫停與啟動都經過同一支",
      /o\.env = "cloud"; o\.mark = envMoneyText\(money\) \|\| null; o\.markKind = money \|\| null;/.test(fn("trCloudBox"))
      && /t\("tr\.cloud\.footWhere", \{ where: t\("env\.cloud"\), money: envMoneyText\(money\), venue: trVenueLabel\(id, true\) \}\)/.test(fn("trCloudBox"))
      && /confirmBox\(trCloudBox\(\{/.test(fn("trAskStop")) && /confirmBox\(trCloudBox\(\{/.test(fn("trAskStart"))
      && /if \(TR\.env !== "cloud"\) return o;/.test(fn("trCloudBox"))); }

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
  // 「沒有別的後門」要掃整個 renderer(以前只看 trade.js + app.js,handoff.js 從來不在視野裡:稽核 F1)。
  // 今天的三處:trade.js 的宣告與守門、handoff.js「回這台電腦」那顆鈕(它前面有同一支 envCanSwitch)
  { const all = fs.readdirSync(R).filter((f) => f.endsWith(".js")).map((f) => [f, noComments(fs.readFileSync(path.join(R, f), "utf8"))]);
    const hits = all.flatMap(([f, s]) => (s.match(/[^\w]envSwitch\(/g) || []).map(() => f));
    ok("直接叫 envSwitch 的全 renderer 只有三處:宣告本身、守門那一支、handoff.js 的「回這台電腦」(新檔直呼會紅):" + hits.join(),
      hits.length === 3 && direct === 2 && hits.filter((f) => f === "handoff.js").length === 1 && !/[^\w]envSwitch\(/.test(app)); }
  // 連接交易所的框只連這台電腦:狀態固定用本機那一袋;雲端視角開不起來(硬擋,不只靠那顆鈕的 aria-disabled)
  ok("N8 連接交易所的框固定用這台電腦那一袋", ["cxModalOpen", "cxModalPaint", "cxConnect", "cxRetest"].every((n) => /const L = TR_BAGS\.local[,;]/.test(fn(n))) && !/\bTR\.(cx|st|api)\b/.test(fn("cxModalPaint") + fn("cxConnect") + fn("cxRetest")));
  ok("連接交易所的框在雲端視角開不起來、也送不出去", /^function cxModalOpen\(opener\) \{\s*if \(ENV\.cur !== "local" \|\| TR\.env !== "local"/.test(fn("cxModalOpen")) && /if \(L\.cx\.busy \|\| ENV\.cur !== "local"/.test(fn("cxConnect")) && /ENV\.cur !== "local"\) return;/.test(fn("cxRetest")));
  ok("雲端的「重新測試」「解除綁定」不接 click(aria-disabled + 說明)", /if \(ro\) \[rt, ub\]\.forEach/.test(fn("trPaintSet")));
  // 設計師評估 2026-09-22:雲端「還沒連接交易所」那一態,停用的「連接交易所」佔掉全頁唯一的主鈕位置,
  // 真出口「前往工作頁」反而是段落裡的文字鈕 → 雲端不畫那顆鈕,主鈕換成「前往工作頁」;這台電腦那一態一個字不改
  { const ob = fn("trPaintOnboard"), S = fs.readFileSync(path.join(R, "strings.js"), "utf8");
    ok("雲端 noaccount:不畫停用的「連接交易所」(整支函式沒有 is-ro / aria-disabled / cx.connect 給雲端),主鈕是描邊的「前往工作頁」、外開瀏覽器",
      !/is-ro|aria-disabled/.test(ob) && /const cloud = TR\.env === "cloud"/.test(ob) && /if \(cloud\) \{ const g = trEl\("button", "btn-out", t\("plan\.openWs"\)\);[^\n]*window\.blave\.openExternal\(planWebUrl\(\)\)/.test(ob));
    ok("雲端 noaccount:說明換成雲端專屬那一句(這台電腦仍是 tr.onboard);那一句要講「只能看」與「到網頁的工作頁連」",
      /t\(cloud \? "tr\.onboard\.cloud" : "tr\.onboard"\)/.test(ob) && /"tr\.onboard\.cloud": "[^"]*只能看[^"]*雲端工作頁/.test(S) && /"tr\.onboard\.cloud": "[^"]*can only view the cloud[^"]*cloud workspace on the web/.test(S));
    ok("這台電腦 noaccount 不變:填色的「連接交易所」直接開連接框", /else \{ const b = trEl\("button", "btn-fill", t\("cx\.connect"\)\); b\.type = "button"; b\.id = "tr-connect"; b\.addEventListener\("click", \(\) => cxModalOpen\(b\)\); ob\.appendChild\(b\); \}/.test(ob));
    // 批次 ②:整頁級的「只能看」退場(啟動 / 暫停按得動之後那一句就是假話);#tr-ro-note 這個槽留著給停機態的 .verdict 用
    ok("整頁級的唯讀說明不再畫;tr.ro.note / tr.ro.noteEmpty 都沒有人叫",
      /trPaintRoNote\(null\);/.test(src) && !/"tr\.ro\.note"|tr\.ro\.noteEmpty/.test(src)); }
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
  const afterAwait = ["trPoll", "trOpen", "trRun", "trSend", "trSaveAmounts", "trUnbind", "trLoadCurve", "cxConnect", "cxRetest"].map((n) => { const b = fn(n), i = b.indexOf("await "); return [n, i < 0 ? "" : b.slice(i).replace(/TR === S|TR_BAGS|TR_[A-Z_]+/g, "")]; });
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
