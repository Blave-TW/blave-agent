// 引擎安裝(shell/enginesetup.js;0.1.12 安裝進度 B+C):pip 輸出解析、失敗分類、記號檔接續、一個一個裝、重試接著裝、逾時、快照的狀態轉換。
// 子行程是假的(不跑真的 pip、不連網);檔案寫在臨時目錄,不碰 ~/Blave。
// pip 的字樣(Downloading / Progress / WARNING: Retrying …)抄自隨包 Python 的 venv(pip 25.0.1)實跑的輸出。
// 跑法:node tests/check_shell_engine_setup.js
const fs = require("fs"), path = require("path"), os = require("os"), vm = require("vm"), { EventEmitter } = require("events");
const SHELL = path.join(__dirname, "..", "shell");
const E = require(path.join(SHELL, "enginesetup.js"));
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + JSON.stringify(d).slice(0, 1500))); if (!c) red++; };

// ── pip 輸出 → 下載量 ──
{
  const p = { done: 0, file: null, installing: false, lastByteAt: 0 };
  const feed = (l, at) => E.pipLine(p, l, at);
  ok("metadata 那一行不算下載", feed("  Downloading pandas-3.0.6-cp312-cp312-macosx_11_0_arm64.whl.metadata (79 kB)", 1) === false && p.file === null);
  ok("Using cached 不算下載", feed("Using cached pandas-3.0.6-cp312-cp312-macosx_11_0_arm64.whl (10.1 MB)", 1) === false && p.file === null);
  feed("Downloading pandas-3.0.6-cp312-cp312-macosx_11_0_arm64.whl (10.1 MB)", 2);
  ok("Downloading 開一個檔,大小先用那一行的", p.file && p.file.bytes === 0 && p.file.total === 10100000 && p.lastByteAt === 2);
  feed("Progress 0 of 10051279", 3); feed("Progress 2097152 of 10051279", 4);
  ok("Progress 換成精確的 bytes;有進才更新 lastByteAt", p.file.total === 10051279 && p.file.bytes === 2097152 && p.lastByteAt === 4);
  ok("沒有前進的 Progress 不算有資料", feed("Progress 2097152 of 10051279", 9) === false && p.lastByteAt === 4);
  feed("Progress 10051279 of 10051279", 5);
  feed("Downloading requests-2.34.2-py3-none-any.whl (73 kB)", 6);
  ok("下一個檔開始:上一個整個算進已下載;每個檔各自從 0 算", p.done === 10051279 && p.file.total === 73000 && p.file.bytes === 0);
  feed("Downloading scipy-1.18.1-cp312-cp312-macosx_14_0_arm64.whl (20.5 MB)", 7);
  ok("小於 512 KB 的檔沒有 Progress:以 Downloading 那一行的大小算進去", p.done === 10051279 + 73000);
  feed("Progress 0 of 20475078", 8); feed("Progress 20475078 of 20475078", 9);
  ok("Installing collected packages:最後一個檔收尾、進安裝階段", feed("Installing collected packages: scipy, requests, pandas", 10) === true && p.installing && p.file === null && p.done === 10051279 + 73000 + 20475078);
  const q = { done: 0, file: null, installing: false, lastByteAt: 0 };
  ok("Windows 的 \\r 已在逐行讀時去掉;Downloading 前面縮排的(解析中整顆抓)也算", E.pipLine(q, "  Downloading foo-1.0-py3-none-any.whl (1.2 MB)", 1) && q.file.total === 1200000);
}

// ── 失敗原因 ──
{
  const offline = "WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ProxyError('Cannot connect to proxy.', NewConnectionError('<pip._vendor.urllib3.connection.HTTPSConnection object at 0x1078f3ef0>: Failed to establish a new connection: [Errno 61] Connection refused'))': /simple/numpy/\nERROR: Could not find a version that satisfies the requirement numpy==2.5.3 (from versions: none)\nERROR: No matching distribution found for numpy==2.5.3";
  const midway = "ERROR: Exception:\nTraceback (most recent call last):\n  ...\npip._vendor.urllib3.exceptions.ReadTimeoutError: HTTPSConnectionPool(host='files.pythonhosted.org', port=443): Read timed out.";
  const nomatch = "ERROR: Ignored the following yanked versions: 2.4.0\nERROR: Could not find a version that satisfies the requirement numpy==9.9.9 (from versions: 1.26.0, 2.5.3)\nERROR: No matching distribution found for numpy==9.9.9";
  ok("斷線:ERROR 行看不出來,要看整段 stderr 的 Retrying → net", E.failKind({ stderr: offline }) === "net" && !/Connection|Retry/.test(E.pipError(offline)));
  ok("下載到一半斷掉(ReadTimeoutError)→ net", E.failKind({ stderr: midway }) === "net");
  ok("沒有這一版的 wheel → other(不猜原因)", E.failKind({ stderr: nomatch }) === "other");
  ok("我們自己停的 → timeout(就算 stderr 有連線字樣)", E.failKind({ stderr: offline, timedOut: true }) === "timeout");
  const retriedThenDisk = "WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ReadTimeoutError(\"HTTPSConnectionPool(host='files.pythonhosted.org', port=443): Read timed out. (read timeout=15)\")': /packages/x.whl\nERROR: Could not install packages due to an OSError: [Errno 28] No space left on device";
  ok("前面重試過一次、最後死在磁碟滿 → other(不算網路;稽核 0.1.12 P2-5)", E.failKind({ stderr: retriedThenDisk }) === "other");
  ok("…最後一行就是連線錯誤 → net", E.failKind({ stderr: "WARNING: Retrying ...\nERROR: Could not install packages due to an OSError: HTTPSConnectionPool(host='files.pythonhosted.org', port=443): Max retries exceeded" }) === "net");
  ok("沒有資料太久(idle)→ net", E.failKind({ stderr: "", idle: true }) === "net");
  ok("pipError 只留 ERROR 行、去掉 (from versions: …)", E.pipError("  Building wheel ... error\nERROR: Could not find a version that satisfies the requirement cryptography==50.0.1 (from versions: 2.2, 48.0.1)\n\nERROR: No matching distribution found for cryptography==50.0.1\n[notice] x") === "ERROR: Could not find a version that satisfies the requirement cryptography==50.0.1\nERROR: No matching distribution found for cryptography==50.0.1");
  ok("pipError 沒有 ERROR 行時留最後三行", E.pipError("a\nb\nc\nd") === "b\nc\nd");
  ok("pipError 只有「ERROR: Exception:」(下載到一半斷掉)→ 留最後三行,原因看得到", /ReadTimeoutError: HTTPSConnectionPool/.test(E.pipError(midway)) && E.pipError(midway).split("\n").length === 3);
}

// ── 記號檔:還要裝哪些 ──
{
  const D = ["pandas==3.0.6", "numpy==2.5.3", "scipy==1.18.1"];
  ok("整份裝完的記號(0.1.11 以前寫的也是這個樣子)→ 不裝", E.depsTodo(D, D.join("\n"), null).length === 0);
  ok("什麼都沒有 → 照清單原順序全部", E.depsTodo(D, null, null).join() === D.join());
  ok("清單換了一個版本 → 只裝那一個", E.depsTodo(D, "pandas==3.0.5\nnumpy==2.5.3\nscipy==1.18.1", null).join() === "pandas==3.0.6");
  ok("清單多一個 → 只裝新的", E.depsTodo([...D, "yfinance==1.0"], D.join("\n"), null).join() === "yfinance==1.0");
  ok("裝到一半(.blave-deps-1.part)→ 從沒裝的接著", E.depsTodo(D, null, "pandas==3.0.6\n").join() === "numpy==2.5.3,scipy==1.18.1");
  ok("PIP_INSTALL:不帶 -q(會關掉 Progress)、帶 raw 進度、--isolated、只收 wheel", !E.PIP_INSTALL.includes("-q") && E.PIP_INSTALL.includes("--progress-bar=raw") && E.PIP_INSTALL.includes("--isolated") && E.PIP_INSTALL.includes("--only-binary=:all:"));
}

// ── 整條安裝:假的子行程 + 臨時目錄 ──
// 清單與分組直接讀 main.js(不另抄一份:抄錯了這支測試照樣綠)。WORKSPACE_DEPS / OPTIONAL_DEPS / SDK_PINS 都是字面值
const MAIN_SRC = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
const lit = (re) => { const m = re.exec(MAIN_SRC); if (!m) throw new Error("main.js 裡找不到 " + re); return m[1]; };
const MAIN_DEPS = vm.runInNewContext(lit(/const WORKSPACE_DEPS = (\[[\s\S]*?\]);/));
const OPT = vm.runInNewContext(lit(/const OPTIONAL_DEPS = (\[[\s\S]*?\]);\n/));
const SDK = vm.runInNewContext("`" + lit(/const SDK_PINS = `([^`]+)`;/) + "`", { AGENT_SDK: vm.runInNewContext(lit(/const AGENT_SDK = ("[^"]+");/)) });
const DEPS = E.depGroups(MAIN_DEPS, OPT)[0].pins;   // 核心那組
const US_IN_MAIN = MAIN_DEPS.filter((p) => !DEPS.includes(p));
// 美股那組:美股線合進來之後就是 main.js 那一份;還沒合時用 OPTIONAL_DEPS 點名的名字湊一份(版本是假的,只用在假的 pip 上)
const US = US_IN_MAIN.length ? US_IN_MAIN : OPT[0].names.map((n) => n + "==0.0.1");
const DEPS17 = [...DEPS, ...US], N = DEPS17.length, NC = DEPS.length, NU = US.length;
const nm = (p) => p.split("==")[0];
const pin = (name) => { const p = DEPS17.find((x) => nm(x) === name); if (!p) throw new Error("清單裡沒有 " + name); return p; };
const bump = (p) => nm(p) + "==999.0";
const SDK2 = SDK.replace(/^(\S+?==)\S+/, "$1999.0"), SDK_LAST = SDK.split(" ").pop();
const TMPS = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "blave-eng-")); TMPS.push(d); return d; };
function rig(o = {}) {
  const base = o.base || tmpDir();
  const ws = path.join(base, "workspace"), venvPy = path.join(base, "venv", "bin", "python");
  let clock = o.clock || 1000;
  const calls = [], snaps = [], logs = [], tracked = [], last = {};
  const behave = o.behave || (() => ({ code: 0 }));
  const spawn = (bin, args, opt) => {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.kill = () => { c.killed = true; setImmediate(() => c.emit("close", null, "SIGTERM")); };
    // 每一條 pip 被叫起來的那一刻 -c 指的檔在不在、內容是什麼(SDK 那條要在引擎那一步就讀得到)
    const ci = args.indexOf("-c"); let pins = null; if (ci >= 0) { try { pins = fs.readFileSync(args[ci + 1], "utf8"); } catch (_) { pins = "(missing)"; } }
    calls.push({ bin, args, env: opt.env, hide: opt.windowsHide, pins }); last.child = c;
    const b = behave(bin, args, calls.length) || { code: 0 };
    setImmediate(() => {
      if (args.includes("venv")) { fs.mkdirSync(path.dirname(venvPy), { recursive: true }); fs.writeFileSync(venvPy, ""); }
      for (const l of b.out || []) { clock += 10; c.stdout.emit("data", l + "\n"); }
      if (b.err) c.stderr.emit("data", b.err);
      if (b.hang) return;
      clock += b.ms || 1000;
      c.emit("close", b.code === undefined ? 0 : b.code);
    });
    return c;
  };
  const S = E.createEngineSetup({
    fs, path, spawn, base, ws, venvPy, venvBin: "bin", win: false, basePython: () => "/bundled/python3", envPath: async () => "/usr/bin:/bin",
    pyEnv: { PYTHONUTF8: "1" }, copyOfficial: () => { fs.mkdirSync(path.join(ws, "lib"), { recursive: true }); }, isPackaged: true,
    sdkPins: o.sdk || SDK, deps: o.deps || DEPS, lock: o.lock, optional: o.optional || OPT, firstRunMB: 200, venvMs: 300000, engineMs: 600000, pkgMs: o.pkgMs || 600000,
    idleMs: o.idleMs, watchMs: 5, alive: o.alive, sleep: o.sleep, lockWaitMs: o.lockWaitMs,
    now: o.realNow ? Date.now : () => clock, onChange: (s) => snaps.push(s), log: (m) => logs.push(m), track: (ev, p) => tracked.push(ev + ":" + p.result),
  });
  return { S, base, ws, venvPy, calls, snaps, logs, tracked, tick: (ms) => { clock += ms; }, get lastChild() { return last.child; } };
}
const pipCalls = (r) => r.calls.filter((c) => c.args.includes("pip"));
const pinsOf = (r) => pipCalls(r).map((c) => c.args[c.args.length - 1]);
const venvDir = (r) => path.join(r.base, "venv");

(async () => {
  // 第一次:三步都要走
  const r = rig({ behave: (bin, args) => (args.includes(pin("numpy")) ? { out: ["Downloading numpy-2.5.3-cp312-cp312-macosx_14_0_arm64.whl (5.4 MB)", "Progress 0 of 5445405", "Progress 2097152 of 5445405", "Progress 5445405 of 5445405", "Installing collected packages: numpy"] } : { code: 0 }) });
  await r.S.ensure();
  const s0 = r.snaps[0], last = r.snaps[r.snaps.length - 1];
  ok("第一次:三個步驟(建立工作區 / 安裝引擎 / 安裝策略套件)、kind=first、帶實測大小", s0.phase === "run" && s0.steps.map((x) => x.k).join() === "ws,engine,pkgs" && s0.kind === "first" && s0.sizeMB === 200 && s0.show === true, s0);
  ok("venv 用隨包 Python 建,pip 用 venv 的 python;子行程不開 shell、帶 windowsHide、PYTHONUNBUFFERED", r.calls[0].bin === "/bundled/python3" && r.calls[0].args.join(" ") === "-m venv " + venvDir(r) && pipCalls(r).every((c) => c.bin === r.venvPy && c.hide === true && c.env.PYTHONUNBUFFERED === "1" && c.env.PATH === "/usr/bin:/bin" && c.env.PYTHONUTF8 === "1") && r.calls[0].env.PYTHONUTF8 === "1");
  ok("SDK 一條、套件照清單原順序一個一個裝(7 條)", pinsOf(r).join() === [SDK_LAST, ...DEPS].join(), pinsOf(r));
  const pinsFile = path.join(venvDir(r), ".blave-pins.txt");
  { const sdk = pipCalls(r)[0], i = sdk.args.indexOf("-c");
    ok("SDK 那條也帶 -c 整份清單(SDK 的相依不能悄悄升級核心套件),而且叫起來的那一刻檔已經寫好", i > 0 && sdk.args[i + 1] === path.join(venvDir(r), ".blave-pins.txt") && sdk.pins === DEPS.join("\n") + "\n"
      && sdk.args.slice(-SDK.split(" ").length).join(" ") === SDK, sdk); }
  ok("每個套件都拿整份清單當 -c(依賴版本跟一次全裝一樣)", pipCalls(r).slice(1).every((c) => { const i = c.args.indexOf("-c"); return i > 0 && c.args[i + 1] === pinsFile; }) && fs.readFileSync(pinsFile, "utf8") === DEPS.join("\n") + "\n");
  ok("裝完:.blave-sdk 與 .blave-deps-1 是整串(舊版認得的樣子)、.blave-deps-1.part 收掉", fs.readFileSync(path.join(venvDir(r), ".blave-sdk"), "utf8") === SDK && fs.readFileSync(path.join(venvDir(r), ".blave-deps-1"), "utf8") === DEPS.join("\n") && !fs.existsSync(path.join(venvDir(r), ".blave-deps-1.part")));
  ok("最後一張快照:done、每一步都 done、有花多久", last.phase === "done" && last.steps.every((x) => x.st === "done" && x.ms >= 0 && x.t0 === null) && last.steps[1].ms > 0 && last.steps[2].ms > 0 && last.tEnd > last.t0, last);
  const seq = r.snaps.map((s) => s.steps.map((x) => x.st[0]).join("")).filter((v, i, a) => v !== a[i - 1]);
  ok("步驟狀態依序:www → rww → dww → drw → ddw → ddr → ddd", seq.join(" ") === "www rww dww drw ddw ddr ddd", seq);
  const nth = r.snaps.filter((s) => s.cur && s.cur.step === "pkgs" && s.cur.i).map((s) => s.cur.i + "/" + s.cur.n + ":" + s.cur.name).filter((v, i, a) => v !== a[i - 1]);
  ok("第 n / 7 個:n 是清單裡的位置、名字不帶版本", nth.join() === DEPS.map((p, i) => (i + 1) + "/" + NC + ":" + nm(p)).join(), nth);
  ok("引擎那一步先是「建立 Python 環境」,再是 SDK(名字 claude-agent-sdk)", r.snaps.some((s) => s.cur && s.cur.step === "engine" && s.cur.sub === "venv") && r.snaps.some((s) => s.cur && s.cur.step === "engine" && s.cur.name === "claude-agent-sdk" && s.cur.limitMs === 600000));
  const mid = r.snaps.find((s) => s.dl.file && s.dl.file.bytes === 2097152);
  ok("下載量進快照:這個檔 bytes / total、已下載總量累加", mid && mid.dl.file.total === 5445405 && last.dl.done === 5445405, mid);
  ok("沒事可做:不送快照、不跑子行程", await (async () => { const n = r.snaps.length, c = r.calls.length; await r.S.ensure(); return r.snaps.length === n && r.calls.length === c; })());

  // 第 4 個斷線 → 失敗 → 重試從第 4 個接著
  let fail = true;
  const f = rig({ behave: (bin, args) => (fail && args.includes(pin("pyarrow")) ? { code: 1, out: ["Downloading pyarrow-25.0.1-cp312-cp312-macosx_12_0_arm64.whl (35.9 MB)", "Progress 0 of 35861559", "Progress 8388608 of 35861559"], err: "ERROR: Exception:\nReadTimeoutError: HTTPSConnectionPool(host='files.pythonhosted.org', port=443): Read timed out." } : args.includes(pin("numpy")) ? { out: ["Downloading numpy-2.5.3-cp312-cp312-macosx_14_0_arm64.whl (5.4 MB)", "Progress 5445405 of 5445405"] } : { code: 0 }) });
  let thrown = null; try { await f.S.ensure(); } catch (e) { thrown = e; }
  const fs1 = f.S.snapshot();
  ok("失敗:ensure 拋出、快照 phase=fail、出事的那一步 err、前面的 done", thrown && fs1.phase === "fail" && fs1.steps.map((x) => x.st).join() === "done,done,err", fs1);
  ok("失敗原因:net、停在 pyarrow、第 4 / 7 個", fs1.err.kind === "net" && fs1.err.name === "pyarrow" && fs1.err.step === "pkgs" && fs1.cur.i === DEPS.indexOf(pin("pyarrow")) + 1, fs1.err);
  ok("失敗留痕:完整 stderr 進主行程的 log", f.logs.some((l) => /pip install failed/.test(l) && /ReadTimeoutError/.test(l)));
  ok("失敗卡的錯誤訊息帶得到原因(不是只有「ERROR: Exception:」)", /Read timed out/.test(fs1.err.msg), fs1.err.msg);
  ok("斷掉的那一個檔不算進已下載", fs1.dl.done === 5445405 && fs1.dl.file === null);
  ok("裝好的三個記在 .blave-deps-1.part、.blave-deps-1 還沒寫", fs.readFileSync(path.join(venvDir(f), ".blave-deps-1.part"), "utf8") === DEPS.slice(0, DEPS.indexOf(pin("pyarrow"))).join("\n") && !fs.existsSync(path.join(venvDir(f), ".blave-deps-1")));
  const before = pipCalls(f).length; fail = false; f.tick(60000);
  await f.S.ensure();
  const fs2 = f.S.snapshot();
  ok("重試:只裝第 4–7 個,SDK 與前三個不重裝、不重建 venv", pinsOf(f).slice(before).join() === DEPS.slice(DEPS.indexOf(pin("pyarrow"))).join() && f.calls.filter((c) => c.args.includes("venv")).length === 1, pinsOf(f).slice(before));
  ok("重試沿用同一張卡:步驟、kind、已下載量、先前花的時間都接著算", fs2.phase === "done" && fs2.kind === "first" && fs2.steps.map((x) => x.k).join() === "ws,engine,pkgs" && fs2.acc === fs1.tEnd - fs1.t0 && fs2.dl.done === 5445405 && fs2.steps[2].ms > fs1.steps[2].ms && fs2.steps[0].ms === fs1.steps[0].ms, { fs1, fs2 });
  ok("重試一開始:出事那一步回到 run(不是留在 err)、錯誤清掉", f.snaps.some((s) => s.phase === "run" && s.t0 > fs1.tEnd && s.err === null && s.steps[2].st === "run"));

  // 關掉 app 再開(快照不在記憶體了):照記號檔從第 4 個接著,標題仍是「第一次」
  { const r2 = rig({ behave: (bin, args, n) => (args.includes(pin("pyarrow")) ? { code: 1, err: "ERROR: boom" } : { code: 0 }) });
    try { await r2.S.ensure(); } catch (_) { /* 預期 */ }
    const r3 = rig({ base: r2.base });
    await r3.S.ensure();
    ok("重開 app 再裝:只裝沒裝的、標題仍是第一次(.blave-deps-1 還沒寫過)", pinsOf(r3).join() === DEPS.slice(DEPS.indexOf(pin("pyarrow"))).join() && r3.snaps[0].kind === "first" && r3.snaps[0].steps.map((x) => x.k).join() === "pkgs", r3.snaps[0]); }

  // 逾時:pip 不結束 → 自己停、訊息固定、kind=timeout、limitMs = 那個套件的上限
  { const t = rig({ pkgMs: 30, behave: (bin, args) => (args.includes(pin("pandas")) ? { hang: true } : { code: 0 }) });
    let e = null; try { await t.S.ensure(); } catch (x) { e = x; }
    const s = t.S.snapshot();
    ok("逾時:殺掉、「timed out after 0s」不帶指令與路徑、kind=timeout、limitMs=套件上限", e && e.message === "timed out after 0s" && s.err.kind === "timeout" && s.err.limitMs === 30 && s.err.step === "pkgs" && s.err.name === "pandas", s.err); }

  // 更新:SDK 釘法換了(.blave-deps-1 是完整的)→ 只有引擎那一步、kind=update、不帶大小
  { const u = rig(); await u.S.ensure();
    fs.unlinkSync(path.join(venvDir(u), ".blave-pins.txt"));   // 上一輪留下的不算:這一輪自己要寫
    const u2 = rig({ base: u.base, sdk: SDK2 }); await u2.S.ensure();
    { const c0 = pipCalls(u2)[0];
      ok("只換 SDK 的更新(沒有套件那一步):SDK 那條照樣帶 -c、檔是這一版的整份清單", c0.args.includes("-c") && c0.pins === DEPS.join("\n") + "\n", c0); }
    ok("更新後補裝:只走引擎那一步、標題是更新、不寫死大小", u2.snaps[0].kind === "update" && u2.snaps[0].steps.map((x) => x.k).join() === "engine" && u2.snaps[0].sizeMB === null && pinsOf(u2).join() === SDK_LAST, u2.snaps[0]);
    const u3 = rig({ base: u.base, sdk: SDK2, deps: DEPS.map((p) => (p === pin("scipy") ? bump(p) : p)) }); await u3.S.ensure();
    ok("清單換了一個版本:只裝那一個、kind=update", pinsOf(u3).join() === bump(pin("scipy")) && u3.snaps[0].kind === "update");
    // .app 換了位置:venv 的 python 是斷掉的連結 → 重建 venv,不出卡(show=false)
    fs.unlinkSync(u3.venvPy); fs.symlinkSync(path.join(u3.base, "nowhere"), u3.venvPy);
    const u4 = rig({ base: u.base, sdk: SDK2, deps: DEPS.map((p) => (p === pin("scipy") ? bump(p) : p)) }); await u4.S.ensure();
    ok("只有 venv 連結斷了:先清斷掉的連結再重建、沒有 pip、不出卡", u4.snaps[0].show === false && u4.calls.length === 1 && u4.calls[0].args.includes("venv") && pipCalls(u4).length === 0, u4.snaps[0]); }

  // ~/Blave 由我們建立時 0700(稽核 R9);已經在的不動權限
  if (process.platform !== "win32") {
    const parent = tmpDir(), base = path.join(parent, "Blave");
    const n = rig({ base }); await n.S.ensure();
    const pre = rig(); fs.chmodSync(pre.base, 0o755); await pre.S.ensure();
    ok("~/Blave 由 app 建立時是 0700;既有目錄的權限不動", (fs.statSync(base).mode & 0o777) === 0o700 && (fs.statSync(pre.base).mode & 0o777) === 0o755);
  }
  // 17 個的清單:第一次 1/17 … 17/17;7 個裝過的既有用戶升級 → 只補新加的 10 個,從第 8 / 17 個開始
  { const nthOf = (r) => r.snaps.filter((s) => s.cur && s.cur.step === "pkgs" && s.cur.i).map((s) => s.cur.i + "/" + s.cur.n + ":" + s.cur.name).filter((v, i, a) => v !== a[i - 1]);
    const f17 = rig({ deps: DEPS17 }); await f17.S.ensure();
    ok("17 個:第一次照清單一個一個裝,第 n / 17 個", pinsOf(f17).slice(1).join() === DEPS17.join() && nthOf(f17).join() === DEPS17.map((p, i) => (i + 1) + "/" + N + ":" + nm(p)).join(), nthOf(f17));
    const old = rig(); await old.S.ensure();
    const up = rig({ base: old.base, deps: DEPS17, behave: (bin, args) => (args.includes(US[NU - 1]) ? { out: ["Downloading yfinance-1.7.0-py3-none-any.whl (131 kB)", "Downloading curl_cffi-0.16.3-cp310-abi3-macosx_11_0_arm64.whl (3.2 MB)", "Progress 3200000 of 3200000"] } : { code: 0 }) });
    await up.S.ensure();
    const u0 = up.snaps[0], ul = up.snaps[up.snaps.length - 1];
    ok("7 → 17 升級:只補新加的 10 個、kind=update、只有套件那一步、不寫大小", pinsOf(up).join() === US.join() && u0.kind === "update" && u0.steps.map((x) => x.k).join() === "pkgs" && u0.sizeMB === null, { pins: pinsOf(up), u0 });
    ok("7 → 17 升級:從第 8 / 17 個開始數(前 7 個本來就在)", nthOf(up).join() === US.map((p, i) => (i + NC + 1) + "/" + N + ":" + nm(p)).join(), nthOf(up));
    ok("7 → 17 升級:已下載量只算這次真的下載的", ul.phase === "done" && ul.dl.done === 131000 + 3200000, ul.dl);
    ok("7 → 17 升級:兩組各一個記號檔——核心那份(7 個)沒被動到、美股那份是 10 個的整串", fs.readFileSync(path.join(venvDir(up), ".blave-deps-1"), "utf8") === DEPS.join("\n") && fs.readFileSync(path.join(venvDir(up), ".blave-deps-us"), "utf8") === US.join("\n"));
    const bmp = rig({ base: old.base, deps: [bump(DEPS17[0]), ...DEPS17.slice(1)] }); fs.writeFileSync(path.join(venvDir(old), ".blave-deps-1"), DEPS.join("\n")); fs.unlinkSync(path.join(venvDir(old), ".blave-deps-us"));
    await bmp.S.ensure();
    ok("清單同時換掉一個版本又多 10 個:i 從已經裝好的個數 +1 起算(第 7 / 17 個),分段條與字一致", nthOf(bmp)[0] === NC + "/" + N + ":" + nm(DEPS17[0]) && nthOf(bmp).length === NU + 1 && nthOf(bmp).pop() === N + "/" + N + ":" + nm(DEPS17[N - 1]), nthOf(bmp)); }
  // ── 選用的那組(美股資料):裝不起來不擋引擎 ──
  { const G = E.depGroups(DEPS17, OPT);
    ok("分組:點名的 10 個是 us、其餘 7 個是核心、順序照清單", G.length === 2 && G[0].id === "core" && G[0].pins.join() === DEPS.join() && G[1].id === "us" && G[1].pins.join() === US.join() && G[1].optional && !G[0].optional);
    ok("分組:名字不分大小寫與 - _ .;清單沒點名到的新套件當核心(裝不起來照樣擋)", E.depGroups(["Curl-CFFI==1", "newdep==2"], OPT)[1].pins.join() === "Curl-CFFI==1" && E.depGroups(["Curl-CFFI==1", "newdep==2"], OPT)[0].pins.join() === "newdep==2");
    ok("分組:7 個的清單一個都沒點到 → 只有核心一組", E.depGroups(DEPS, OPT).length === 1);
    let failUs = true;
    const g = rig({ deps: DEPS17, behave: (bin, args) => (failUs && args.includes(US[1]) ? { code: 1, err: "ERROR: No matching distribution found for " + US[1] } : { code: 0 }) });
    let thrown = null; try { await g.S.ensure(); } catch (e) { thrown = e; }
    const gs = g.S.snapshot();
    ok("美股那組失敗:不往外丟、phase=done、步驟都 done、warn 記哪一組哪一個", thrown === null && gs.phase === "done" && gs.steps.every((x) => x.st === "done") && gs.err === null && gs.warn && gs.warn.group === "us" && gs.warn.name === nm(US[1]) && gs.warn.kind === "other", gs);
    ok("美股那組失敗:核心那組記號照寫、美股那組不寫;已裝好的 curl_cffi 記在它自己的 .part", fs.readFileSync(path.join(venvDir(g), ".blave-deps-1"), "utf8") === DEPS.join("\n") && !fs.existsSync(path.join(venvDir(g), ".blave-deps-us")) && fs.readFileSync(path.join(venvDir(g), ".blave-deps-us.part"), "utf8") === US[0]);
    ok("美股那組失敗:這一組剩下的不再試、留一筆 log", pinsOf(g).slice(1).join() === DEPS17.slice(0, NC + 2).join() && g.logs.some((l) => /optional packages "us" not installed/.test(l)));
    const n1 = g.calls.length, s1 = g.snaps.length; await g.S.ensure();
    ok("同一次啟動再送一句:不再試美股那組(不讓每一句話都等一輪 pip)、不出卡", g.calls.length === n1 && g.snaps.length === s1);
    failUs = false;
    const g2 = rig({ base: g.base, deps: DEPS17 }); await g2.S.ensure();
    ok("下次開 app:只從 lxml 接著裝美股那組,核心不重裝;標題是補裝、第 9 / 17 個起算", pinsOf(g2).join() === DEPS17.slice(NC + 1).join() && g2.snaps[0].kind === "update" && g2.snaps.find((s) => s.cur && s.cur.i).cur.i === NC + 2 && fs.readFileSync(path.join(venvDir(g2), ".blave-deps-us"), "utf8") === US.join("\n"), pinsOf(g2));
    const core = rig({ deps: DEPS17, behave: (bin, args) => (args.includes(pin("scipy")) ? { code: 1, err: "ERROR: boom" } : { code: 0 }) });
    let ce = null; try { await core.S.ensure(); } catch (e) { ce = e; }
    ok("核心那組失敗:照舊往外丟、phase=fail、美股那組沒開始裝", ce && core.S.snapshot().phase === "fail" && !pinsOf(core).some((p) => US.includes(p)));
    const legacy = rig(); await legacy.S.ensure();
    const lu = rig({ base: legacy.base, deps: DEPS17, behave: (bin, args) => (args.includes(US[NU - 1]) ? { code: 1, err: "WARNING: Retrying ... NewConnectionError(...)\nERROR: No matching distribution found for " + US[NU - 1] } : { code: 0 }) });
    let le = null; try { await lu.S.ensure(); } catch (e) { le = e; }
    ok("7 個裝過的舊用戶升級、美股那組最後一個斷線:引擎照樣好、warn.kind=net、核心記號沒被動到", le === null && lu.S.snapshot().phase === "done" && lu.S.snapshot().warn.kind === "net" && lu.S.snapshot().warn.name === nm(US[NU - 1]) && fs.readFileSync(path.join(venvDir(lu), ".blave-deps-1"), "utf8") === DEPS.join("\n")); }
  // ── 埋點(主行程送;值照設計稽核定稿):一輪有東西要裝的才送,只修 venv 連結不送 ──
  { const a = rig(); await a.S.ensure(); await a.S.ensure();
    ok("埋點:第一次裝完 → engine_setup first_done 一則;沒事可做的空跑不送", a.tracked.join() === "engine_setup:first_done", a.tracked);
    let bad = true; const b = rig({ behave: (bin, args) => (bad && args.includes(pin("numpy")) ? { code: 1, err: "WARNING: Retrying ... NewConnectionError\nERROR: x" } : { code: 0 }) });
    try { await b.S.ensure(); } catch (_) { /* 預期 */ } bad = false; await b.S.ensure();
    ok("埋點:失敗 first_net、重試成功再 first_done(重試沿用同一張卡,kind 不變)", b.tracked.join() === "engine_setup:first_net,engine_setup:first_done", b.tracked);
    const t = rig({ pkgMs: 30, behave: (bin, args) => (args.includes(pin("pandas")) ? { hang: true } : { code: 0 }) }); try { await t.S.ensure(); } catch (_) { /* 預期 */ }
    ok("埋點:超時 first_timeout", t.tracked.join() === "engine_setup:first_timeout", t.tracked);
    const u = rig({ base: a.base, deps: DEPS17, behave: (bin, args) => (args.includes(US[1]) ? { code: 1, err: "ERROR: nope" } : { code: 0 }) }); await u.S.ensure();
    ok("埋點:更新補裝、美股那組失敗 → engine_opt_fail us_other + engine_setup upd_done(兩個事件分開)", u.tracked.join() === "engine_opt_fail:us_other,engine_setup:upd_done", u.tracked);
    fs.unlinkSync(u.venvPy); fs.symlinkSync(path.join(u.base, "nowhere"), u.venvPy);
    const r2 = rig({ base: a.base, deps: DEPS17 }); fs.writeFileSync(path.join(venvDir(r2), ".blave-deps-us"), US.join("\n")); await r2.S.ensure();
    ok("埋點:只修 venv 連結(relink)不送", r2.tracked.length === 0 && r2.snaps[0].kind === "relink", { t: r2.tracked, k: r2.snaps[0] && r2.snaps[0].kind });
    const z = E.createEngineSetup({ fs, path, spawn: () => { throw new Error("x"); }, base: tmpDir(), ws: "/nonexistent-ws-xyz", venvPy: "/nonexistent-venv/python", venvBin: "bin", win: false, basePython: () => "x", envPath: async () => "", pyEnv: {}, copyOfficial: () => {}, isPackaged: true,
      sdkPins: SDK, deps: DEPS, firstRunMB: 1, venvMs: 1, engineMs: 1, pkgMs: 1, onChange: () => {}, log: () => {}, track: () => { throw new Error("telemetry down"); } });
    let ze = null; try { await z.ensure(); } catch (e) { ze = e; }
    ok("埋點壞了不拖累安裝:track 拋例外,安裝的錯誤照常是安裝自己的", ze && !/telemetry down/.test(ze.message), ze && ze.message); }
  // ── 清單分組要對得上(稽核 0.1.12 T4):OPTIONAL_DEPS 點名的名字,在 WORKSPACE_DEPS 裡要嘛全都有(美股線合進來之後)、要嘛全沒有 ──
  { const pn = (x) => String(x).split("==")[0].toLowerCase().replace(/[-_.]+/g, "-");
    const hit = OPT.flatMap((g) => g.names).filter((n) => MAIN_DEPS.some((p) => pn(p) === pn(n)));
    ok("main.js 的 OPTIONAL_DEPS 每個名字都對得到 WORKSPACE_DEPS 的一個 pin(合併前一個都沒有也算對;只對到一部分 = 打錯字)", hit.length === 0 || hit.length === OPT.flatMap((g) => g.names).length, { hit, names: OPT.flatMap((g) => g.names) });
    ok("核心那組不是空的、OPTIONAL_DEPS 只有一組 us", DEPS.length > 0 && OPT.length === 1 && OPT[0].id === "us");
    // 選用那組排在清單最後、連續:OPTIONAL_DEPS 漏點一個名字(那個 pin 會靜靜變成核心)時,它夾在選用的中間或後面,這裡就紅
    const firstOpt = MAIN_DEPS.findIndex((p) => !DEPS.includes(p));
    ok("WORKSPACE_DEPS 的排法:核心在前、選用的連續排在最後(漏點名字會被抓到)", firstOpt === -1 || MAIN_DEPS.slice(firstOpt).every((p) => !DEPS.includes(p)), MAIN_DEPS.slice(firstOpt)); }

  // ── 第一次要下載多少:依平台(稽核 0.1.12 P2-1 實測 209 / 217 / 224 / 235 / 227 MB,各自往上取到 10 MB)──
  { const i = MAIN_SRC.indexOf("function firstRunMB("), j = MAIN_SRC.indexOf("\n}\n", i);
    const f = new Function("os", MAIN_SRC.slice(i, j + 2) + "; return firstRunMB;")({ release: () => "24.0.0" });
    ok("firstRunMB:macOS 14+ Apple 晶片 210、Intel 220;macOS 12/13(Darwin < 23)Apple 晶片 230、Intel 240;Windows 230",
      f("darwin", "arm64", 24) === 210 && f("darwin", "x64", 23) === 220 && f("darwin", "arm64", 22) === 230 && f("darwin", "x64", 21) === 240 && f("win32", "x64", 0) === 230 && f("darwin", "arm64") === 210,
      [f("darwin", "arm64", 24), f("darwin", "x64", 23), f("darwin", "arm64", 22), f("darwin", "x64", 21), f("win32", "x64", 0)]);
    ok("main.js 把 firstRunMB() 交給 enginesetup、兩道停的上限照稽核:總上限 45 分鐘、2 分鐘沒資料就停", /firstRunMB: firstRunMB\(\)/.test(MAIN_SRC) && /idleMs: PIP_IDLE_MS/.test(MAIN_SRC)
      && /const ENGINE_PIP_MS = 2700000, PKG_PIP_MS = 2700000, PIP_IDLE_MS = 120000, VENV_MS = 300000;/.test(MAIN_SRC) && !/105 KB\/s/.test(MAIN_SRC)); }

  // ── 關 app / 為了更新重開:收掉正在跑的 pip(稽核 0.1.12 P1-1)──
  { const a = rig({ behave: (bin, args) => (args.includes(pin("pandas")) ? { hang: true, out: ["Downloading pandas-3.0.6-cp312-cp312-macosx_11_0_arm64.whl (10.1 MB)"] } : { code: 0 }) });
    const p = a.S.ensure().then(() => null, (e) => e); await new Promise((r) => setTimeout(r, 30));
    const lock = path.join(venvDir(a), ".blave-install.lock");
    const hadLock = fs.existsSync(lock), wasBusy = a.S.busy();
    const stopped = await a.S.abort(); const e = await p;
    ok("abort():殺掉正在跑的 pip、等它結束才回來;安裝失敗但不算埋點(我們自己收的)、鎖檔收掉", hadLock && wasBusy && stopped === true && e && e.aborted === true && a.calls[a.calls.length - 1].args.includes(pin("pandas"))
      && !a.S.busy() && !fs.existsSync(lock) && a.tracked.length === 0, { hadLock, wasBusy, stopped, e: e && e.message, tracked: a.tracked });
    ok("abort():沒在裝時立刻回 false", (await a.S.abort()) === false);
    // 裝到美股那組時關 app(稽核 0.1.12 複驗 P2):不能被記成「美股那組失敗」,ensure 也不能當成裝好了
    const o2 = rig({ deps: DEPS17, behave: (bin, args) => (args.includes(US[0]) ? { hang: true } : { code: 0 }) });
    const p2 = o2.S.ensure().then(() => "resolved", (x) => x); await new Promise((r) => setTimeout(r, 30));
    const busyUs = o2.S.busy() && o2.S.snapshot().cur.name === nm(US[0]);
    await o2.S.abort(); const r2 = await p2, s2 = o2.S.snapshot();
    ok("裝美股那組時被收掉:ensure 拋出(aborted)、沒有 warn、不送 engine_opt_fail 也不送 engine_setup、美股那組記號沒寫", busyUs && r2 !== "resolved" && r2.aborted === true && !s2.warn && o2.tracked.length === 0
      && !fs.existsSync(path.join(venvDir(o2), ".blave-deps-us")), { busyUs, r2: r2 && (r2.message || r2), warn: s2.warn, tracked: o2.tracked }); }
  // 鎖檔:上一次留下的 pip 還活著(當掉、被強制結束)→ 先等它結束,不同時寫同一個 venv
  { let alive = true, waited = 0; const base = tmpDir();
    fs.mkdirSync(path.join(base, "venv"), { recursive: true }); fs.writeFileSync(path.join(base, "venv", ".blave-install.lock"), JSON.stringify({ pid: 4242, at: 1 }));
    const l = rig({ base, alive: (pid) => pid === 4242 && alive, sleep: async () => { waited++; if (waited === 3) alive = false; } });
    await l.S.ensure();
    ok("鎖檔裡的 pip 還活著:等它結束(這裡等了 3 輪)才開始裝;不殺它", waited === 3 && pinsOf(l).length === DEPS.length + 1 && l.logs.some((x) => /another installer \(pid 4242\)/.test(x)), { waited, logs: l.logs });
    let w2 = 0; const base2 = tmpDir();
    fs.mkdirSync(path.join(base2, "venv"), { recursive: true }); fs.writeFileSync(path.join(base2, "venv", ".blave-install.lock"), JSON.stringify({ pid: 4242, at: 1 }));
    const l2 = rig({ base: base2, alive: () => true, lockWaitMs: 1, realNow: true, sleep: async () => { w2++; await new Promise((r) => setTimeout(r, 3)); } });
    await l2.S.ensure();
    ok("…一直活著(pid 可能被別的程式重用了):等滿上限就往下走,不卡死", w2 >= 1 && pinsOf(l2).length === DEPS.length + 1, w2);
    const l3 = rig({ alive: () => { throw new Error("不該問"); } }); await l3.S.ensure();
    ok("沒有鎖檔:不等", pinsOf(l3).length === DEPS.length + 1); }

  // ── 多久沒收到資料才停(稽核 0.1.12 P1-2):慢但有在動的不停;下載中卡住 → 以網路失敗停;安裝階段不出聲不算 ──
  { const st = rig({ realNow: true, idleMs: 40, behave: (bin, args) => (args.includes(pin("pandas")) ? { hang: true, out: ["Downloading pandas-3.0.6-cp312-cp312-macosx_11_0_arm64.whl (10.1 MB)", "Progress 0 of 10051279"] } : { code: 0 }) });
    let e = null; try { await st.S.ensure(); } catch (x) { e = x; }
    const s = st.S.snapshot();
    ok("下載中 idleMs 沒有新資料:停下、kind=net(呈現成網路中斷)、訊息「no data for …」不帶路徑", e && /^no data for \d+s$/.test(e.message) && s.err.kind === "net" && s.err.name === "pandas" && st.tracked.join() === "engine_setup:first_net", { m: e && e.message, err: s.err });
    const ins = rig({ realNow: true, idleMs: 20, pkgMs: 120, behave: (bin, args) => (args.includes(pin("pandas")) ? { hang: true, out: ["Downloading pandas-3.0.6-cp312-cp312-macosx_11_0_arm64.whl (10.1 MB)", "Progress 10051279 of 10051279", "Installing collected packages: pandas"] } : { code: 0 }) });
    let e2 = null; try { await ins.S.ensure(); } catch (x) { e2 = x; }
    ok("安裝階段(Installing collected packages 之後)不出聲:不算沒資料,只有總上限會停 → timeout", e2 && ins.S.snapshot().err.kind === "timeout" && /^timed out after/.test(e2.message), e2 && e2.message);
    let n = 0; const flow = rig({ realNow: true, idleMs: 40, behave: (bin, args) => {
      if (!args.includes(pin("pandas"))) return { code: 0 };
      return { hang: true, out: ["Downloading pandas-3.0.6-cp312-cp312-macosx_11_0_arm64.whl (10.1 MB)"] }; } });
    const pr = flow.S.ensure().then(() => "ok", (x) => x.message);
    // 慢但一直有資料:每 15ms 來一行 Progress,總共 120ms(遠超過 idleMs)→ 不會被停
    await new Promise((r) => setTimeout(r, 20));
    const c = flow.calls.length; let bytes = 0;
    const child = flow.lastChild;
    ok("(測試接線)拿得到正在跑的假子行程", !!child);
    if (child) { for (n = 0; n < 8; n++) { await new Promise((r) => setTimeout(r, 15)); bytes += 100000; child.stdout.emit("data", "Progress " + bytes + " of 10051279\n"); }
      ok("慢但一直有資料進來(8 × 15ms,共 120ms > idleMs 40ms):沒被停", flow.S.busy() && flow.S.snapshot().phase === "run");
      child.emit("close", 0); }
    ok("…之後正常裝完", (await pr) === "ok" && flow.calls.length >= c);
    // 解析相依的那段(Collecting … / Using cached …)沒有 bytes,但有輸出:也算有在動
    const col = rig({ realNow: true, idleMs: 40, behave: (bin, args) => (args.includes(pin("pandas")) ? { hang: true } : { code: 0 }) });
    const pc = col.S.ensure().then(() => "ok", (x) => x.message); await new Promise((r) => setTimeout(r, 10));
    const cc = col.lastChild;
    for (let k = 0; k < 8; k++) { await new Promise((r) => setTimeout(r, 15)); cc.stdout.emit("data", "Collecting dep" + k + " (from pandas==3.0.6)\n"); }
    ok("解析中一直有輸出(沒有 bytes、共 120ms > idleMs):不算沒資料、沒被停", col.S.busy() && col.S.snapshot().phase === "run");
    cc.emit("close", 0); ok("…之後正常裝完", (await pc) === "ok"); }

  // ── 失敗後的下一輪(稽核 0.1.12 P2-2)──
  { const r1 = rig(); await r1.S.ensure();
    let failB = true; const deps2 = DEPS.map((p) => (p === pin("pandas") ? bump(p) : p));
    const u = rig({ base: r1.base, deps: deps2, behave: (bin, args) => (failB && args.includes(bump(pin("pandas"))) ? { code: 1, err: "ERROR: boom" } : { code: 0 }) });
    try { await u.S.ensure(); } catch (_) { /* 預期 */ }
    const k1 = u.S.snapshot().steps.map((x) => x.k).join();
    fs.unlinkSync(u.venvPy); failB = false;
    let e = null; try { await u.S.ensure(); } catch (x) { e = x; }
    const s2 = u.S.snapshot();
    ok("補裝失敗(只有套件那步)後同一次啟動 venv 又不見了:重試多出引擎那一步,補進卡裡、照順序排,不再丟 TypeError", k1 === "pkgs" && e === null && s2.phase === "done" && s2.steps.map((x) => x.k).join() === "engine,pkgs", { k1, e: e && e.message, steps: s2.steps });
    const v = rig(); let failC = true;
    const vv = rig({ base: v.base, behave: (bin, args) => (failC && args.includes(pin("numpy")) ? { code: 1, err: "ERROR: x" } : { code: 0 }) });
    try { await vv.S.ensure(); } catch (_) { /* 預期 */ }
    // 上一輪其實裝好了(例:死在寫最後那個記號檔之前):這一輪沒事可做 → 卡不能停在失敗
    fs.writeFileSync(path.join(venvDir(vv), ".blave-deps-1"), DEPS.join("\n")); fs.writeFileSync(path.join(venvDir(vv), ".blave-sdk"), SDK); failC = false;
    const before = vv.calls.length; await vv.S.ensure();
    ok("失敗後下一輪沒事可做:快照改成 done(卡收掉),不跑子行程", vv.S.snapshot().phase === "done" && vv.calls.length === before && vv.S.snapshot().err === null); }

  // 開發版:每次都重拷官方檔(改了 lib/ 重啟就生效)
  { let copies = 0; const d = rig(); await d.S.ensure();
    const S2 = E.createEngineSetup({ fs, path, spawn: () => { throw new Error("不該跑"); }, base: d.base, ws: d.ws, venvPy: d.venvPy, venvBin: "bin", win: false, basePython: () => "x", envPath: async () => "", pyEnv: {}, copyOfficial: () => { copies++; }, isPackaged: false,
      sdkPins: SDK, deps: DEPS, firstRunMB: 200, venvMs: 1, engineMs: 1, pkgMs: 1, onChange: () => {}, log: () => {} });
    await S2.ensure(); ok("開發版:沒事可做也重拷官方檔", copies === 1); }

  // ── 間接相依的鎖(稽核 2026-10-02 P2-4):只進 -c,不裝、不進記號檔;main.js 那份要跟現在的直接相依對得上 ──
  { const L = ["six==1.17.0", "urllib3==2.8.0"], k = rig({ lock: L }); await k.S.ensure();
    const pf = path.join(venvDir(k), ".blave-pins.txt");
    ok("lock:-c 那份 = 直接相依 + 鎖(SDK 那條叫起來時就在)", pipCalls(k)[0].pins === [...DEPS, ...L].join("\n") + "\n" && fs.readFileSync(pf, "utf8") === [...DEPS, ...L].join("\n") + "\n");
    ok("lock:鎖裡的不會被當成要裝的(pip 只裝 SDK 與清單)、記號檔照舊只有清單", pinsOf(k).join() === [SDK_LAST, ...DEPS].join() && !pipCalls(k).some((c) => L.some((l) => c.args.includes(l)))
      && fs.readFileSync(path.join(venvDir(k), ".blave-deps-1"), "utf8") === DEPS.join("\n"), pinsOf(k)); }
  { const LOCK = vm.runInNewContext(lit(/const WORKSPACE_LOCK = (\[[\s\S]*?\]);/)), FOR = vm.runInNewContext(lit(/const WORKSPACE_LOCK_FOR = ("[^"]+");/));
    const nn = (p) => p.split("==")[0].toLowerCase().replace(/[-_.]+/g, "-"), direct = new Set([...MAIN_DEPS, ...SDK.split(" ")].map(nn));
    ok("WORKSPACE_LOCK_FOR 對得上現在的 SDK_PINS + WORKSPACE_DEPS(對不上 = 換了直接相依沒重解鎖:跑 node shell/tools/lock-deps.js 貼回 main.js)", FOR === E.lockKey(SDK, MAIN_DEPS), { FOR, now: E.lockKey(SDK, MAIN_DEPS) });
    ok("WORKSPACE_LOCK:每行都是 名字==版本、不重複、不含直接相依(那些已經在清單裡)", LOCK.length >= 30 && LOCK.every((l) => /^[a-z0-9][a-z0-9._-]*==[0-9][0-9A-Za-z.+!-]*$/.test(l)) && new Set(LOCK.map(nn)).size === LOCK.length && !LOCK.some((l) => direct.has(nn(l))), LOCK.filter((l) => direct.has(nn(l))));
    ok("lockKey:SDK 或清單任一個換了就不一樣", E.lockKey(SDK, MAIN_DEPS) !== E.lockKey(SDK2, MAIN_DEPS) && E.lockKey(SDK, MAIN_DEPS) !== E.lockKey(SDK, [bump(MAIN_DEPS[0]), ...MAIN_DEPS.slice(1)]) && E.lockKey(SDK, MAIN_DEPS) === E.lockKey(SDK, [...MAIN_DEPS]));
    ok("接線:main.js 只在 WORKSPACE_LOCK_FOR 對得上時才帶鎖,對不上帶空的", /lock: WORKSPACE_LOCK_FOR === require\("\.\/enginesetup"\)\.lockKey\(SDK_PINS, WORKSPACE_DEPS\) \? WORKSPACE_LOCK : \[\],/.test(MAIN_SRC)); }

  for (const d of TMPS) fs.rmSync(d, { recursive: true, force: true });
  process.exit(red ? 1 : 0);
})();
process.on("beforeExit", () => { console.log("FAIL  非同步測試沒有跑到結尾"); process.exit(1); });
