/* 本機常駐程式(runtime/local_daemon.py)在外殼這一側的宿主:起它、把簽章 secret 經 stdin 交給它、
   寫指令檔、讀 ack 與狀態檔。設計:blave-canon output/specs/desktop-local-daemon-design-2026-09.md。

   - secret 每次啟動重新產生,只存在這個行程的記憶體與 daemon 的記憶體:不進環境變數(同用戶 `ps -E`
     讀得到)、不落檔、不過 IPC 給 renderer。renderer 只能說「我要送哪個指令」,簽章在這裡做。
   - stdin 這條 pipe 一直握著不關:daemon 讀到 EOF = app 沒了 → 它自己收工並帶走對帳器。所以 app 被
     SIGKILL 也不會留下一支沒人管的下單行程。
   - 不依賴 electron:測試(tests/check_shell_daemon.js)直接 require 這個檔。 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { spawn } = require("child_process");

// renderer 可以要求送的指令。比 daemon 的 ALLOWED 窄:畫面上沒有的功能不開(報告排程、偏好、刪策略…
// 在電腦版走別條路或還沒做);多開一個就是多一個 renderer 被攻破時能碰到的面。
const UI_COMMANDS = new Set(["halt", "resume", "resume_wait", "amounts", "credentials", "credentials_remove",
  "restart_reconciler", "retest_accounts", "close_all"]);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BYTES = 16 * 1024;          // = daemon 的 MAX_BYTES;超過它會直接拒收
const HEARTBEAT_DEAD_MS = 60 * 1000;  // 設計 §4:heartbeat_at 超過 60 秒 = daemon 死了
/* exit 3 = 另一支 daemon 還握著這個 workspace 的鎖。最常見的是上一個 app 的那支還在收工:它發現 app 沒了 ≤1 秒、
   等對帳器撤單 5 秒、補 SIGKILL 3 秒,最壞約 10 秒放鎖(上一個 app 自己的 stop() 也是 9 秒強殺)。2+5+10 秒蓋過這個
   最壞情況,再多一次 10 秒當餘裕;27 秒後還握著的就不是「在收工」,是另一個活著的實例,落到原本的失敗狀態。
   **只等不殺**:持鎖的可能是另一個合法的 app。 */
const LOCK_RETRY_MS = [2000, 5000, 10000, 10000];
const LOCK_SETTLE_MS = 3000;          // exit 3 在 python 起來的頭一兩秒內就會發生;撐過這段才算拿到鎖

/* renderer 送來的參數在這裡先驗形狀(稽核 S6):daemon 端的 handler 會再驗一次語意,這一層擋的是
   「renderer 被攻破時能塞什麼」——例如 credentials 帶任意 key 寫進 workspace 的 .env。
   **renderer 這條路只收模擬交易**。Binance 的金鑰走另一條:主行程(binance_link.js)查過權限——提領開著的 key 不存——
   之後才用 send(…, { trusted: true }) 送,那時認 TRUSTED_CRED_KEYS。renderer 被攻破也繞不過那道檢查。
   解除綁定是安全方向,renderer 可以拿掉兩種。 */
const CRED_KEYS = { PAPER_API_KEY: /^paper$/, PAPER_SECRET_KEY: /^paper$/, PAPER_BOUND_TS: /^\d{9,11}$/ };
const TRUSTED_CRED_KEYS = { BINANCE_API_KEY: /^[A-Za-z0-9]{16,128}$/, BINANCE_SECRET_KEY: /^[A-Za-z0-9]{16,128}$/ };
const REMOVABLE = new Set([...Object.keys(CRED_KEYS), ...Object.keys(TRUSTED_CRED_KEYS)]);
const NAME_RE = /^[A-Za-z0-9_\-.]{1,128}$/;
function argsOk(cmd, a, trusted) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return false;
  const keys = Object.keys(a);
  if (cmd === "credentials") {
    const env = a.env, allow = trusted === true ? TRUSTED_CRED_KEYS : CRED_KEYS;
    // trusted 的那包必須剛好是一整對:只送一半會在 .env 留下半把金鑰
    return keys.length === 1 && env && typeof env === "object" && !Array.isArray(env) && Object.keys(env).length > 0
      && (trusted !== true || Object.keys(env).length === Object.keys(allow).length)
      && Object.keys(env).every((k) => Object.prototype.hasOwnProperty.call(allow, k) && typeof env[k] === "string" && allow[k].test(env[k]));
  }
  // 解除綁定只准拿掉這一版認得的憑證 key(handler 自己也永遠不刪 blave_*)
  if (cmd === "credentials_remove") return keys.length === 1 && Array.isArray(a.env) && a.env.length > 0 && a.env.length <= 16
    && a.env.every((n) => typeof n === "string" && REMOVABLE.has(n.toUpperCase()));
  if (cmd === "amounts") {
    const m = a.amounts;
    return m && typeof m === "object" && !Array.isArray(m) && Object.keys(m).length <= 200
      && Object.keys(m).every((k) => NAME_RE.test(k) && typeof m[k] === "number" && isFinite(m[k]) && m[k] >= 0 && m[k] <= 1e9);
  }
  if (cmd === "resume" || cmd === "resume_wait") return keys.every((k) => k === "strategies") && (a.strategies === undefined
    || (Array.isArray(a.strategies) && a.strategies.length > 0 && a.strategies.length <= 200 && a.strategies.every((n) => typeof n === "string" && NAME_RE.test(n))));
  if (cmd === "halt") return keys.every((k) => k === "reason") && (a.reason === undefined || (typeof a.reason === "string" && a.reason.length <= 200));
  return keys.length === 0;   // restart_reconciler / retest_accounts / close_all:不收參數
}
function createDaemonHost({ python, script, base, workspace, env, log = () => {}, spawnFn = spawn, lockRetryMs = LOCK_RETRY_MS, lockSettleMs = LOCK_SETTLE_MS }) {
  const stateDir = path.join(workspace, "state");
  const inDir = path.join(stateDir, "local_cmd", "in"), ackDir = path.join(stateDir, "local_cmd", "ack");
  const statusFile = path.join(stateDir, "local_status.json");
  let child = null, secret = null, stopping = false, lastExit = null, restarts = 0;
  let lockTries = 0, lockTimer = null, lockNextAt = 0, startedAt = 0;

  function start() {
    if (child) return true;
    if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }   // 等鎖期間有人又叫了 start():舊的那個 timer 不清,stop() 之後它還會再冒一支出來
    stopping = false;
    secret = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(inDir, { recursive: true }); fs.mkdirSync(ackDir, { recursive: true });
    startedAt = Date.now();
    const c = spawnFn(python, [script, "--secret-stdin"], {
      cwd: workspace, stdio: ["pipe", "ignore", "pipe"],
      // BLAVE_AGENT_LOCAL 是 daemon 的啟動閘門,必須由這裡帶;其餘是呼叫端給的最小環境(不含任何 Blave 憑證)
      env: { ...env, BLAVE_AGENT_LOCAL: "1", BLAVE_AGENT_BASE: base, BLAVE_AGENT_WORKSPACE: workspace },
    });
    child = c;
    if (!eqTimer) { eqTimer = setInterval(eqTick, 60000); if (eqTimer.unref) eqTimer.unref(); }
    const first = setTimeout(eqTick, 20000); if (first.unref) first.unref();   // 開 app 後的第一筆,不必等到下一分鐘
    // spawn 失敗(venv 的 python 被搬走、沒有執行權限)走 error 不走 exit:不接就是主行程的未捕捉例外,
    // 而且 child 永遠不清 → isRunning() 恆真、before-quit 的 stop() 等不到 exit、app 關不掉(稽核 B1)
    c.on("error", (err) => {
      lastExit = { code: null, sig: null, at: Date.now(), error: String((err && err.code) || err) };
      log(`local daemon failed to start: ${lastExit.error}`);
      if (child === c) { child = null; secret = null; }
    });
    c.stdin.on("error", () => {});               // daemon 先死時寫 stdin 會 EPIPE;不要讓它變成未捕捉例外
    c.stdin.write(secret + "\n");                // 只寫這一行;之後不 end()——EOF 是「app 沒了」的訊號
    let tail = "";
    c.stderr.on("data", (d) => { tail = (tail + d).slice(-2000); });
    c.on("exit", (code, sig) => {
      lastExit = { code, sig, at: Date.now(), tail };
      log(`local daemon exited code=${code} sig=${sig}`);
      if (child === c) { child = null; secret = null; }
      // 自己死掉(不是我們叫它收工)→ 退避重啟,最多 5 次;重啟只是把 daemon 帶回來,**對帳器不會自己啟動**
      // (daemon 的規矩),用戶要再按一次「啟動下單」。exit 2 = 環境不對:重啟也沒用,不試。
      if (!stopping && code === 3 && lockTries < lockRetryMs.length) {
        const wait = lockRetryMs[lockTries++]; lockNextAt = Date.now() + wait;
        log(`workspace lock is held by another daemon — retry ${lockTries}/${lockRetryMs.length} in ${wait}ms`);
        lockTimer = setTimeout(() => { lockTimer = null; if (!child && !stopping) start(); }, wait); if (lockTimer.unref) lockTimer.unref();
      } else if (!stopping && code !== 2 && code !== 3 && restarts < 5) {
        const wait = Math.min(30000, 2000 * 2 ** restarts); restarts++;
        const tm = setTimeout(() => { if (!child && !stopping) start(); }, wait); if (tm.unref) tm.unref();
      }
    });
    const okTimer = setTimeout(() => { if (child === c) restarts = lockTries = 0; }, 120000); if (okTimer.unref) okTimer.unref();   // 穩定跑兩分鐘就歸零
    return true;
  }

  /* 收工:關 stdin(EOF)+ SIGTERM,兩條都會走到 daemon 的收工路徑(對帳器先撤自己的掛單)。
     設計 §5 的時間預算:對帳器 ≤3 秒、daemon 等它 5 秒、再補 SIGKILL 3 秒 → 這裡等 9 秒才強殺。 */
  function stop() {
    if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
    const c = child; if (!c) return Promise.resolve();
    stopping = true;
    return new Promise((resolve) => {
      const kill = setTimeout(() => { try { c.kill("SIGKILL"); } catch (_) {} }, 9000);
      // 不管怎樣 11 秒內一定放行:結束 app 不能卡在一支收不掉的子行程上
      const giveUp = setTimeout(() => { if (child === c) { child = null; secret = null; } resolve(); }, 11000);
      const done = () => { clearTimeout(kill); clearTimeout(giveUp); resolve(); };
      c.once("exit", done); c.once("error", done);
      try { c.stdin.end(); } catch (_) {}
      try { c.kill("SIGTERM"); } catch (_) {}
    });
  }

  function writeCommand(cmd, args, signed) {
    const id = crypto.randomBytes(12).toString("hex");
    const body = JSON.stringify({ id, cmd, args: args || {}, ts: Date.now() / 1000 });
    const mac = signed ? crypto.createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex") : "";
    const payload = JSON.stringify({ body, mac });
    if (Buffer.byteLength(payload) > MAX_BYTES) throw new Error("TOO_LARGE");
    const tmp = path.join(inDir, id + ".json.tmp");
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, path.join(inDir, id + ".json"));
    return id;
  }
  function withdraw(id) { try { fs.unlinkSync(path.join(inDir, id + ".json")); return true; } catch (_) { return false; } }
  function readAck(id) {
    if (!ID_RE.test(id)) return null;
    try { return JSON.parse(fs.readFileSync(path.join(ackDir, id + ".json"), "utf8")); } catch (_) { return null; }
  }
  /* 送一個指令並等 ack。回 {ok, result} / {ok:false, error};daemon 沒在跑、逾時也走 error。
     `halt` 在 daemon 沒跑(或 secret 不在)時照送不簽——它是安全方向,daemon 起來就會吃到。 */
  async function send(cmd, args, { timeoutMs = 20000, trusted = false } = {}) {
    if (!UI_COMMANDS.has(cmd)) return { ok: false, error: "NOT_ALLOWED" };
    if (!argsOk(cmd, args || {}, trusted === true)) return { ok: false, error: "BAD_ARGS" };
    const live = !!(child && secret);
    if (!live && cmd !== "halt") return { ok: false, error: "DAEMON_DOWN" };
    let id;
    try { fs.mkdirSync(inDir, { recursive: true }); id = writeCommand(cmd, args, live); }
    catch (e) { return { ok: false, error: e.message === "TOO_LARGE" ? "TOO_LARGE" : "WRITE_FAILED" }; }
    if (!live) return { ok: true, result: { queued: true } };
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const a = readAck(id);
      if (a && a.ok && cmd === "credentials_remove") { eqAppend({ ts: Math.floor(Date.now() / 1000), reset: true }); eqLast = null; }
      if (a && a.ok && (cmd === "credentials" || cmd === "retest_accounts")) setTimeout(eqTick, 12000);   // 連上後第一筆:等帳戶讀取器讀完
      if (a && a.ok) uiEvent(cmd);
      if (a) return a.ok ? { ok: true, result: a.result } : { ok: false, error: String(a.error || "FAILED") };
      if (!child) return { ok: false, error: withdraw(id) ? "DAEMON_DOWN" : "UNKNOWN_RESULT" };
      await new Promise((r) => setTimeout(r, 150));
    }
    // 指令檔還在 in/ 的話 120 秒內仍會被執行——逾時就是逾時,不能讓它在用戶以為「沒送到」之後才生效(稽核 S2)
    if (withdraw(id)) return { ok: false, error: "TIMEOUT" };
    const late = readAck(id);
    if (late) return late.ok ? { ok: true, result: late.result } : { ok: false, error: String(late.error || "FAILED") };
    return { ok: false, error: "UNKNOWN_RESULT" };   // daemon 已經收走、還沒回:可能已執行,畫面不能說「沒送到」
  }

  /* 狀態檔原樣交出去,外加宿主這一側知道的事。檔案是 daemon 原子寫的,讀到一半的情形不存在;
     讀不到 / 壞掉 → report:null,畫面照「還沒有狀態」處理,不猜。 */
  function status() {
    let report = null;
    try { report = JSON.parse(fs.readFileSync(statusFile, "utf8")); } catch (_) { /* 還沒寫出來 */ }
    const hb = report && report.daemon && Number(report.daemon.heartbeat_at);
    const hbMs = hb ? (hb > 1e12 ? hb : hb * 1000) : 0;
    const alive = !!child && !!hbMs && Date.now() - hbMs <= HEARTBEAT_DEAD_MS;
    // 在等鎖(nextAt = 下一次嘗試的時間)或重試剛起、還沒撐過 settle(nextAt:null)。重試用完 → null,畫面回到 lastExit.code === 3 的失敗狀態
    const lockRetry = lockTimer ? { attempt: lockTries, max: lockRetryMs.length, nextAt: lockNextAt }
      : (lockTries > 0 && child && Date.now() - startedAt < lockSettleMs ? { attempt: lockTries, max: lockRetryMs.length, nextAt: null } : null);
    return { running: !!child, alive, stopping, lockRetry, lastExit: lastExit && { code: lastExit.code, at: lastExit.at, error: lastExit.error || null }, restarts, report };
  }

  /* ── 權益歷史 ─────────────────────────────────────────────
     雲端的權益曲線來自平台每小時的快照;電腦版沒有平台那一層,由宿主在 app 開著時自己記:
     每個整點一筆(外加連上之後的第一筆),寫進 state/equity_history.jsonl。只記讀成功的帳戶;
     app 關著的時段就是沒有點(畫面斷線不插值)。解除綁定寫一筆 reset,之後的曲線從新帳戶重新起算——
     模擬帳戶的 10,000 跟下一個帳戶的淨值不能連成一條線。 */
  const eqFile = path.join(stateDir, "equity_history.jsonl");
  let eqTimer = null, eqLast = null;          // eqLast = {venue, bucket}:同一小時同一帳戶只記一筆
  function liveAccount(report) {
    const v = (report && report.venues) || {}, a = (report && report.account && report.account.venues) || {};
    const id = Object.keys(v).filter((k) => v[k] && v[k].credentials && v[k].account).sort()[0];
    const e = id && a[id];
    // bound:這次綁定的身分。解除後再綁同一家(不論從畫面或從聊天)bound 會換,曲線就不會連成一條(稽核 S9)
    const bound = boundTs(id);
    return e && e.ok && typeof e.equity === "number" && isFinite(e.equity) ? { venue: id, equity: e.equity, currency: e.currency || "USDT", bound } : null;
  }
  // <VENUE>_BOUND_TS 是綁定當下寫進 .env 的時間戳(不是秘密);只讀這一行,不碰其他 key
  function boundTs(id) {
    try {
      const m = fs.readFileSync(path.join(workspace, ".env"), "utf8").match(new RegExp("^" + String(id).toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_BOUND_TS\\s*=\\s*(\\d{9,11})\\s*$", "mi"));
      return m ? Number(m[1]) : null;
    } catch (_) { return null; }
  }
  function eqAppend(row) { try { fs.appendFileSync(eqFile, JSON.stringify(row) + "\n", { mode: 0o600 }); } catch (_) { /* 記不到就少一個點 */ } }
  function eqTick() {
    const st = status(); if (!st.alive) return;
    const acc = liveAccount(st.report); if (!acc) return;
    const ts = Math.floor(Date.now() / 1000), bucket = Math.floor(ts / 3600);
    if (eqLast && eqLast.venue === acc.venue && eqLast.bucket === bucket) return;
    if (!eqLast) {   // 行程剛起來:看檔尾,同一小時已經記過就不重記
      const rows = eqRead(); const last = rows[rows.length - 1];
      if (last && !last.reset && last.venue === acc.venue && Math.floor(last.ts / 3600) === bucket) { eqLast = { venue: acc.venue, bucket }; return; }
    }
    eqAppend({ ts, venue: acc.venue, equity: acc.equity, currency: acc.currency, ...(acc.bound ? { bound: acc.bound } : {}) });
    eqLast = { venue: acc.venue, bucket };
  }
  function eqRead() {
    let txt = ""; try { txt = fs.readFileSync(eqFile, "utf8"); } catch (_) { return []; }
    const out = [];
    for (const line of txt.split("\n")) { if (!line) continue; try { const r = JSON.parse(line); if (r && typeof r.ts === "number") out.push(r); } catch (_) { /* 壞行跳過 */ } }
    return out;
  }
  /* 給畫面的形狀(renderer/trade.js 的 trLoadCurve):curve 只含最後一次 reset 之後、現在這個帳戶的點。
     today = 今天(本地時間)第一個可用基準到現在的損益;unrealized 本機帳戶讀取器沒有這一欄 → null,畫面顯示「—」。 */
  function equity({ days } = {}) {
    const rows = eqRead(); let from = 0;
    rows.forEach((r, i) => { if (r.reset) from = i + 1; });
    const acc = liveAccount(status().report);
    let pts = rows.slice(from).filter((r) => !r.reset && typeof r.equity === "number" && isFinite(r.equity) && (!acc || r.venue === acc.venue));
    if (acc && acc.bound) { const i = pts.findIndex((r) => r.bound === acc.bound); pts = i >= 0 ? pts.slice(i).filter((r) => r.bound === acc.bound) : pts.filter((r) => !r.bound); }
    const baseline = pts.length ? pts[0].ts : null;
    const mid = new Date(); mid.setHours(0, 0, 0, 0); const midS = mid.getTime() / 1000;
    const before = pts.filter((r) => r.ts < midS).pop(), first = pts.find((r) => r.ts >= midS);
    // 「昨天最後一點」太舊(app 好幾天沒開)就不是今天的基準:退到今天第一點;兩個都沒有 → 不報當日損益
    const start = (before && midS - before.ts <= 12 * 3600 ? before : null) || first || null;
    const today = acc && start ? { pnl: acc.equity - start.equity, start_equity: start.equity } : null;
    const d = Number(days) > 0 ? Math.min(Number(days), 3660) : 90;
    pts = pts.filter((r) => r.ts >= Date.now() / 1000 - d * 86400);
    return { curve: pts.map((r) => ({ ts: r.ts, equity: r.equity })), currency: (acc && acc.currency) || "USDT", baseline_ts: baseline, today, unrealized: null };
  }

  /* 用戶在畫面上做的事(暫停 / 恢復 / 連接 / 解除)。雲端這些來自平台的事件流;電腦版沒有那一層,
     由宿主在指令 ack 成功時自己記一筆,總覽的時間軸才畫得出「已暫停 → 已恢復」。只記型別與時間,不記參數。 */
  const uiFile = path.join(stateDir, "ui_events.jsonl");
  const UI_EVENT = { halt: "halt", close_all: "halt_close", resume: "resume", resume_wait: "resume_wait", credentials: "venue_connected", credentials_remove: "venue_disconnected" };
  function uiEvent(cmd) {
    const type = UI_EVENT[cmd]; if (!type) return;
    const acc = liveAccount(status().report);
    try { fs.appendFileSync(uiFile, JSON.stringify({ ts: Math.floor(Date.now() / 1000), type, venue: (acc && acc.venue) || null }) + "\n", { mode: 0o600 }); } catch (_) { /* 少一筆事件 */ }
  }
  function events({ days } = {}) {
    let txt = ""; try { txt = fs.readFileSync(uiFile, "utf8"); } catch (_) { return []; }
    const from = Date.now() / 1000 - (Number(days) > 0 ? Math.min(Number(days), 3660) : 30) * 86400, out = [];
    for (const line of txt.split("\n")) { if (!line) continue; try { const r = JSON.parse(line); if (r && typeof r.ts === "number" && r.ts >= from && typeof r.type === "string") out.push({ ts: r.ts, type: r.type, venue: typeof r.venue === "string" ? r.venue : null }); } catch (_) { /* 壞行跳過 */ } }
    return out.slice(-500);
  }

  return { start, stop, send, status, equity, events, _eqTick: eqTick, isRunning: () => !!child };
}
module.exports = { createDaemonHost, UI_COMMANDS, argsOk };
