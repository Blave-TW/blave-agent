// 0.1.55 網路不穩時第一次裝引擎不再一直停下來等「重試」(shell/enginesetup.js NET_RETRY_MS、netRetryOk):
//   ① 網路類判斷(failKind)吃多種 stderr 樣本:連線重置、逾時、DNS、SSL 中斷、HTTP 5xx、太久沒資料;磁碟、權限、hash、沒有 wheel 不算
//   ② netRetryOk:次數用完、等完會超過總上限、我們自己停的、進了安裝階段才失敗的都不重跑
//   ③ 整條跑:網路失敗自動重跑同一條 pip、退避照 NET_RETRY_MS、快照帶第幾次、重跑不清快取(--cache-dir 不變、不帶 --no-cache-dir)
//   ④ 用完才停下來給重試;非網路錯誤當場停;關 app 時在等的那一輪收掉、不再起 pip
//   ⑤ pip 自己的 --retries / --timeout 放大;Windows 的 venv 與 pip 降優先序、mac 不變;畫面那一格寫第幾次
// 跑法:node tests/check_shell_engine_net_retry.js
const fs = require("fs"), path = require("path"), os = require("os"), { EventEmitter } = require("events");
const SHELL = path.join(__dirname, "..", "shell");
const E = require(path.join(SHELL, "enginesetup.js"));
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + JSON.stringify(d).slice(0, 600))); if (!c) red++; };
const TMPS = []; const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "blave-netretry-")); TMPS.push(d); return d; };

// ── ① 網路類判斷 ──
const NET = {
  reset: "ERROR: Exception:\nTraceback (most recent call last):\nConnectionResetError: [WinError 10054] An existing connection was forcibly closed by the remote host\npip._vendor.urllib3.exceptions.ProtocolError: (\"Connection broken: ConnectionResetError(10054, 'Connection reset by peer')\", ConnectionResetError(10054))",
  readTimeout: "ERROR: Exception:\npip._vendor.urllib3.exceptions.ReadTimeoutError: HTTPSConnectionPool(host='files.pythonhosted.org', port=443): Read timed out.",
  connectTimeout: "WARNING: Retrying (Retry(total=0)) after connection broken by 'ConnectTimeoutError(<pip._vendor.urllib3.connection.HTTPSConnection object>, 'Connection to pypi.org timed out. (connect timeout=60)')': /simple/numpy/\nERROR: Could not find a version that satisfies the requirement numpy==2.5.3 (from versions: none)\nERROR: No matching distribution found for numpy==2.5.3",
  dnsWin: "WARNING: Retrying (Retry(total=9)) after connection broken by 'NewConnectionError('<pip._vendor.urllib3.connection.HTTPSConnection object>: Failed to establish a new connection: [Errno 11001] getaddrinfo failed')': /simple/pandas/\nERROR: Could not find a version that satisfies the requirement pandas (from versions: none)",
  dnsMac: "ERROR: Exception:\nNewConnectionError: Failed to establish a new connection: [Errno 8] nodename nor servname provided, or not known",
  ssl: "ERROR: Exception:\npip._vendor.urllib3.exceptions.SSLError: [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1006)",
  http503: "ERROR: HTTP error 503 while getting https://files.pythonhosted.org/packages/aa/bb/scipy-1.16.0-cp312-cp312-win_amd64.whl\nERROR: Could not install requirement scipy==1.16.0 from https://files.pythonhosted.org/... because of HTTP error 503 Server Error: Service Unavailable for url",
  too5xx: "WARNING: Retrying ...\nERROR: Exception:\npip._vendor.urllib3.exceptions.MaxRetryError: HTTPSConnectionPool(host='pypi.org', port=443): Max retries exceeded with url: /simple/x/ (Caused by ResponseError('too many 502 error responses'))",
  badGateway: "ERROR: Exception:\nrequests.exceptions.HTTPError: 502 Bad Gateway",
  incomplete: "ERROR: Exception:\npip._vendor.urllib3.exceptions.ProtocolError: ('Connection broken: IncompleteRead(9437184 bytes read, 26424375 more expected)', IncompleteRead(9437184 bytes read, 26424375 more expected))",
};
const NOT_NET = {
  disk: "ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device",
  perm: "ERROR: Could not install packages due to an OSError: [WinError 5] Access is denied: 'C:\\\\Users\\\\x\\\\Blave\\\\venv\\\\Lib\\\\site-packages\\\\numpy' Check the permissions.\nPermission denied",
  hash: "ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE.",
  nowheel: "ERROR: Could not find a version that satisfies the requirement pyarrow==25.0.1 (from versions: 1.0.0)\nERROR: No matching distribution found for pyarrow==25.0.1",
  retriedThenDisk: "WARNING: Retrying (Retry(total=4)) after connection broken by 'ReadTimeoutError(\"HTTPSConnectionPool(host='files.pythonhosted.org', port=443): Read timed out.\")': /x.whl\nERROR: Could not install packages due to an OSError: [Errno 28] No space left on device",
  serverPort: "ERROR: Invalid requirement: 'numpy==5003'",
};
const badNet = Object.keys(NET).filter((k) => E.failKind({ stderr: NET[k] }) !== "net");
ok("網路類 stderr 樣本(連線重置、讀寫逾時、連線逾時、DNS Win/mac、SSL 中斷、HTTP 503、太多 5xx、502、下載中斷)都判成 net", badNet.length === 0, badNet);
const badOther = Object.keys(NOT_NET).filter((k) => E.failKind({ stderr: NOT_NET[k] }) !== "other");
ok("非網路(磁碟滿、權限、hash、沒有 wheel、重試過後死在磁碟、數字長得像 5xx 的別的錯)都不是 net", badOther.length === 0, badOther);
ok("太久沒資料(我們停的 idle)算網路;總上限(timedOut)不算", E.failKind({ idle: true }) === "net" && E.failKind({ timedOut: true }) === "timeout");

// ── ② netRetryOk ──
const D = [5, 15, 30];
const net = { stderr: NET.reset };
ok("netRetryOk:網路、次數沒用完、等完還在總上限內 → 重跑", E.netRetryOk(net, 0, D, 0, 1000, false) && E.netRetryOk(net, 2, D, 0, 1000, false));
ok("…次數用完不重跑", !E.netRetryOk(net, 3, D, 0, 1000, false));
ok("…等完下一次就會超過總上限不重跑", !E.netRetryOk(net, 1, D, 990, 1000, false) && E.netRetryOk(net, 1, D, 984, 1000, false));
ok("…我們自己停的(關 app)、總上限到了、進了安裝階段才失敗的都不重跑", !E.netRetryOk({ ...net, aborted: true }, 0, D, 0, 1000, false) && !E.netRetryOk({ ...net, timedOut: true }, 0, D, 0, 1000, false) && !E.netRetryOk(net, 0, D, 0, 1000, true));
ok("…非網路錯誤不重跑", Object.values(NOT_NET).every((s) => !E.netRetryOk({ stderr: s }, 0, D, 0, 1000, false)));
ok("預設退避:5 次、間隔遞增、總等待 < 5 分鐘(總上限 45 / 90 分鐘另外管)", E.NET_RETRY_MS.length === 5 && E.NET_RETRY_MS.every((v, i, a) => i === 0 || v > a[i - 1]) && E.NET_RETRY_MS.reduce((a, b) => a + b, 0) < 300000);

// ── ③④ 整條跑 ──
function rig(o) {
  const base = tmpDir(), ws = path.join(base, "workspace"), venvPy = path.join(base, "venv", "bin", "python");
  let clock = 1000; const calls = [], snaps = [], logs = [], sleeps = [], prio = [], busyAt = [];
  const spawn = (bin, args, opt) => {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = 7000 + calls.length;
    c.kill = () => { c.killed = true; setImmediate(() => c.emit("close", null, "SIGTERM")); };
    calls.push({ bin, args });
    const b = (args.includes("pip") ? o.pip(calls.filter((x) => x.args.includes("pip")).length, args) : null) || { code: 0 };
    setImmediate(() => {
      if (args.includes("venv")) { fs.mkdirSync(path.dirname(venvPy), { recursive: true }); fs.writeFileSync(venvPy, ""); }
      for (const l of b.out || []) { clock += 10; c.stdout.emit("data", l + "\n"); }
      if (b.err) c.stderr.emit("data", b.err);
      clock += 1000; c.emit("close", b.code === undefined ? 0 : b.code);
    });
    return c;
  };
  const S = E.createEngineSetup({ fs, path, spawn, base, ws, venvPy, venvBin: "bin", win: !!o.win, basePython: () => "/bundled/python3", envPath: async () => "/usr/bin",
    pyEnv: {}, copyOfficial: async () => { fs.mkdirSync(path.join(ws, "lib"), { recursive: true }); }, isPackaged: true,
    sdkPins: "claude-agent-sdk==1.0", deps: ["numpy==2.0"], optional: [], firstRunMB: 200, venvMs: 300000, engineMs: o.engineMs || 600000, pkgMs: 600000,
    alive: () => false, setPriority: (pid, p) => prio.push([pid, p]), pipCacheDir: "/cache/pip", netRetryMs: o.delays || [5000, 15000, 30000],
    sleep: async (ms) => { sleeps.push(ms); clock += ms; busyAt.push(S.busy()); if (o.onSleep) o.onSleep(S, sleeps.length); },
    now: () => clock, onChange: (s) => snaps.push(JSON.parse(JSON.stringify(s))), log: (m) => logs.push(m), track: () => {} });
  const pipArgs = () => calls.filter((c) => c.args.includes("pip")).map((c) => c.args);
  // waits:每次重跑前實際等了多久(等待切成一秒一段,照 log 的那一行分組加總)
  const total = () => sleeps.reduce((a, b) => a + b, 0);
  return { S, calls, snaps, logs, sleeps, prio, pipArgs, base, busyAt, total };
}
const DL = ["Collecting claude-agent-sdk==1.0", "Downloading claude_agent_sdk-1.0-py3-none-any.whl (90.0 MB)", "Progress 1048576 of 90000000"];
(async () => {
  { const r = rig({ pip: (n) => (n <= 2 ? { code: 2, out: DL, err: NET.reset } : n === 3 ? { code: 0, out: ["Using cached claude_agent_sdk-1.0-py3-none-any.whl (90.0 MB)", "Installing collected packages: claude-agent-sdk"] } : { code: 0 }) });
    await r.S.ensure();
    const last = r.snaps[r.snaps.length - 1], args = r.pipArgs();
    ok("網路斷兩次:自動重跑同一條 pip、第三次裝好,不停下來(phase done、沒有 err)", last.phase === "done" && !last.err && args.length === 4 && args[0].join(" ") === args[1].join(" ") && args[1].join(" ") === args[2].join(" "), { phase: last.phase, n: args.length });
    ok("退避照 NET_RETRY_MS 依序等(5 秒、15 秒;每段等待切成 ≤1 秒一段)", r.total() === 20000 && r.sleeps.every((ms) => ms <= 1000) && r.logs.filter((l) => /auto retry/.test(l)).map((l) => /in (\d+)s/.exec(l)[1]).join() === "5,15", r.sleeps);
    ok("等待中算「安裝中」(busy):結束確認會先收掉、搬到應用程式不會在這時問", r.busyAt.length > 0 && r.busyAt.every(Boolean) && r.S.busy() === false);
    const rs = r.snaps.filter((s) => s.cur && s.cur.retry).map((s) => s.cur.retry.n + "/" + s.cur.retry.max).filter((v, i, a) => v !== a[i - 1]);
    ok("快照帶第幾次(畫面寫「自動重試中(第 n 次)」),phase 一直是 run;裝好後清掉", rs.join() === "1/3,2/3" && r.snaps.filter((s) => s.cur && s.cur.retry).every((s) => s.phase === "run") && r.snaps.filter((s) => s.cur && s.cur.step === "engine").slice(-1).every((s) => !s.cur.retry), rs);
    ok("重跑不清快取:每一條都帶同一個 --cache-dir、沒有 --no-cache-dir;不刪 venv、不重建 venv", args.every((a) => a.join(" ").includes("--cache-dir /cache/pip") && !a.includes("--no-cache-dir")) && r.calls.filter((c) => c.args.includes("venv")).length === 1);
    ok("每次重跑留一行 log(第幾次、等幾秒、原因最後一行)", r.logs.filter((l) => /pip network error, auto retry \d\/3 in \d+s: /.test(l)).length === 2 && r.logs.some((l) => /auto retry 1\/3 in 5s: .*Connection reset by peer/.test(l)), r.logs);
    ok("下載到一半的那個檔不算進已下載量(只算下載完的)", last.dl.done === 0, last.dl); }
  { const r = rig({ pip: () => ({ code: 2, out: DL, err: NET.readTimeout }) });
    let err = null; try { await r.S.ensure(); } catch (e) { err = e; }
    const last = r.snaps[r.snaps.length - 1];
    ok("一直斷:重跑用完(3 次)才停下來給重試,失敗類別照舊是 net", err && last.phase === "fail" && last.err.kind === "net" && r.total() === 50000 && r.pipArgs().length === 4, { total: r.total(), n: r.pipArgs().length }); }
  { const r = rig({ pip: () => ({ code: 1, err: NOT_NET.hash }) });
    let err = null; try { await r.S.ensure(); } catch (e) { err = e; }
    ok("非網路錯誤(hash 不符):當場停,不等、不重跑", err && r.sleeps.length === 0 && r.pipArgs().length === 1 && r.snaps[r.snaps.length - 1].err.kind === "other"); }
  { const r = rig({ pip: () => ({ code: 2, out: [...DL, "Installing collected packages: claude-agent-sdk"], err: NET.reset }) });
    let err = null; try { await r.S.ensure(); } catch (e) { err = e; }
    ok("進了安裝階段才失敗(site-packages 可能寫了一半):不自動重跑,照舊停下來走半裝保護", err && r.sleeps.length === 0 && r.pipArgs().length === 1); }
  { const r = rig({ engineMs: 20000, pip: () => ({ code: 2, out: DL, err: NET.ssl }) });
    let err = null; try { await r.S.ensure(); } catch (e) { err = e; }
    ok("總上限管全部重跑:20 秒的上限下,等 5 秒那次之後再等 15 秒會超過 → 只重跑一次", err && r.total() === 5000 && r.pipArgs().length === 2, r.sleeps); }
  { const r = rig({ pip: () => ({ code: 2, out: DL, err: NET.dnsWin }), onSleep: (S) => { S.abort(); } });
    let err = null; try { await r.S.ensure(); } catch (e) { err = e; }
    ok("等下一次的時候關 app(abort):一秒內收掉(不等完 5 秒)、不再起 pip、當成我們自己停的、busy 回 false", err && r.sleeps.length === 1 && r.pipArgs().length === 1 && r.snaps[r.snaps.length - 1].phase === "fail" && /app closing/.test(String(err.message)) && r.S.busy() === false, r.sleeps); }
  { // 真計時:不注入 sleep,abort 之後 ensure 要在一秒多內回來(不是等滿 5 秒)
    const base = tmpDir(), venvPy = path.join(base, "venv", "bin", "python"); let pips = 0;
    const spawn = (bin, args) => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = 9000; c.kill = () => {};
      if (args.includes("pip")) pips++;
      setImmediate(() => { if (args.includes("venv")) { fs.mkdirSync(path.dirname(venvPy), { recursive: true }); fs.writeFileSync(venvPy, ""); } if (args.includes("pip")) c.stderr.emit("data", NET.reset); c.emit("close", args.includes("pip") ? 2 : 0); }); return c; };
    const S = E.createEngineSetup({ fs, path, spawn, base, ws: path.join(base, "workspace"), venvPy, venvBin: "bin", win: false, basePython: () => "/py", envPath: async () => "", pyEnv: {}, copyOfficial: async () => {}, isPackaged: true,
      sdkPins: "claude-agent-sdk==1.0", deps: ["numpy==2.0"], optional: [], firstRunMB: 200, venvMs: 300000, engineMs: 600000, pkgMs: 600000, alive: () => false, setPriority: () => {}, netRetryMs: [5000], onChange: () => {}, log: () => {}, track: () => {} });
    const t0 = Date.now(); const run = S.ensure().catch((e) => e);
    await new Promise((res) => { const iv = setInterval(() => { const c = S.snapshot().cur; if (c && c.retry && S.busy() && pips === 1) { clearInterval(iv); res(); } }, 20); });
    S.abort(); const e = await run, ms = Date.now() - t0;
    ok("真計時:等 5 秒的那段裡 abort,1.5 秒內收掉、不再起 pip", e && /app closing/.test(String(e.message)) && ms < 1500 && pips === 1, { ms, pips }); }

  // ── ⑤ pip 旗標、優先序、畫面 ──
  ok("PIP_INSTALL 帶 --retries 10 與 --timeout 60", E.PIP_INSTALL.join(" ").includes("--retries 10 --timeout 60"));
  { const r = rig({ win: true, pip: () => ({ code: 0 }) }); await r.S.ensure();
    const BELOW = os.constants.priority.PRIORITY_BELOW_NORMAL, ids = r.calls.map((c, i) => 7000 + i);
    const venvPid = ids[r.calls.findIndex((c) => c.args.includes("venv"))], pipPids = ids.filter((_, i) => r.calls[i].args.includes("pip"));
    ok("Windows:建 venv 與每一條 pip 都降一級(BELOW_NORMAL)", [venvPid, ...pipPids].every((pid) => r.prio.some(([p, v]) => p === pid && v === BELOW)), r.prio); }
  { const r = rig({ win: false, pip: () => ({ code: 0 }) }); await r.S.ensure();
    ok("mac:venv 與 pip 不調優先序(只有背景編譯那支照舊)", r.prio.every(([pid, v]) => v === undefined && r.calls[pid - 7000].args.includes("compileall")), r.prio); }
  { const es = fs.readFileSync(path.join(SHELL, "renderer", "engine.js"), "utf8");
    const a = es.indexOf("const ENG_STALL_MS"), b = es.indexOf("/* 完成後留下的那一行 */");
    const engView = new Function(es.slice(a, b) + "\nreturn engView;")();
    const tr = { t: (k, v) => k + (v ? JSON.stringify(v) : ""), dur: (s) => s + "s" };
    const snap = (retry) => ({ show: true, phase: "run", kind: "first", sizeMB: 200, acc: 0, t0: 0, steps: [{ k: "engine", st: "run", ms: 0, t0: 0 }], dl: { done: 0, file: null, lastByteAt: 0 }, cur: { step: "engine", name: "claude-agent-sdk", t0: 0, limitMs: 600000, retry } });
    const v1 = engView(snap({ n: 2, max: 5 }), 60000, tr, false), v0 = engView(snap(null), 60000, tr, false);
    ok("畫面:重跑中那一格寫「自動重試中(第 n 次)」、不出失敗卡;沒在重跑照舊", v1.slot && v1.slot.text === 'eng.netRetry{"n":2}' && v1.phase === "run" && !(v0.slot && /netRetry/.test(v0.slot.text)), [v1.slot, v0.slot]);
    const po = (f) => fs.readFileSync(path.join(SHELL, "i18n", f), "utf8");
    ok("字串兩語都有、帶 {n}", /msgid "eng\.netRetry"\nmsgstr "[^"]*\{n\}[^"]*"/.test(po("zh.po")) && /msgid "eng\.netRetry"\nmsgstr "[^"]*\{n\}[^"]*"/.test(po("en.po"))); }
  for (const d of TMPS) fs.rmSync(d, { recursive: true, force: true });
  console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  例外 " + (e && e.stack)); process.exit(1); });
