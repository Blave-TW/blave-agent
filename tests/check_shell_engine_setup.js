// 引擎安裝(shell/enginesetup.js;0.1.12 安裝進度 B+C):pip 輸出解析、失敗分類、記號檔接續、每組一條 pip(0.1.28)、重試接著裝、逾時、
// 快照的狀態轉換、裝好後的背景編譯。
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
  const W = E.pipWheel;
  ok("pipWheel:Downloading / Using cached 的 wheel 取名字(正規化)與版本;metadata、Collecting、不是 wheel 的回 null",
    JSON.stringify(W("Downloading curl_cffi-0.16.3-cp310-abi3-macosx_11_0_arm64.whl (3.2 MB)")) === JSON.stringify({ name: "curl-cffi", version: "0.16.3" })
    && JSON.stringify(W("Using cached python_dateutil-2.9.0.post0-py2.py3-none-any.whl (229 kB)")) === JSON.stringify({ name: "python-dateutil", version: "2.9.0.post0" })
    && W("  Downloading pandas-3.0.6-cp312-cp312-macosx_11_0_arm64.whl.metadata (79 kB)") === null && W("Collecting pandas==3.0.6") === null && W("Progress 1 of 2") === null);
  const N = E.pipCurName;
  ok("現在在弄哪一個:Collecting 取套件名(帶 from 的相依也算)、Downloading 取 wheel 檔名第一段,都照 PEP 503 正規化(小寫、_ → -);metadata / Using cached / Progress 不算",
    N("Collecting pandas==3.0.6") === "pandas" && N("Collecting numpy>=1.26.0 (from pandas==3.0.6)") === "numpy" && N("Collecting curl_cffi==0.16.3") === "curl-cffi" && N("Collecting Python_Dotenv==1.2.3") === "python-dotenv"
    && N("Downloading curl_cffi-0.16.3-cp310-abi3-macosx_11_0_arm64.whl (3.2 MB)") === "curl-cffi" && N("Downloading python_dotenv-1.2.3-py3-none-any.whl (21 kB)") === "python-dotenv" && N("  Downloading scipy-1.18.1-cp312-cp312-macosx_14_0_arm64.whl (20.5 MB)") === "scipy"
    && N("  Downloading pandas-3.0.6-cp312-cp312-macosx_11_0_arm64.whl.metadata (79 kB)") === null && N("Using cached pandas-3.0.6-cp312-cp312-macosx_11_0_arm64.whl (10.1 MB)") === null
    && N("Progress 1 of 2") === null && N("Installing collected packages: numpy") === null);
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
  ok("PIP_INSTALL:不帶 -q(會關掉 Progress)、帶 raw 進度、--isolated、只收 wheel、--no-compile(.pyc 改在背景編)", !E.PIP_INSTALL.includes("-q") && E.PIP_INSTALL.includes("--progress-bar=raw") && E.PIP_INSTALL.includes("--isolated") && E.PIP_INSTALL.includes("--only-binary=:all:") && E.PIP_INSTALL.includes("--no-compile"));
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
// 快照裡的名字照 PEP 503 正規化(小寫、連字號):curl_cffi → curl-cffi
const nn = (p) => nm(p).toLowerCase().replace(/[-_.]+/g, "-");
const pin = (name) => { const p = DEPS17.find((x) => nm(x) === name); if (!p) throw new Error("清單裡沒有 " + name); return p; };
const bump = (p) => nm(p) + "==999.0";
const SDK2 = SDK.replace(/^(\S+?==)\S+/, "$1999.0");
const TMPS = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "blave-eng-")); TMPS.push(d); return d; };
function rig(o = {}) {
  const base = o.base || tmpDir();
  const ws = path.join(base, "workspace"), venvPy = path.join(base, "venv", "bin", "python");
  let clock = o.clock || 1000;
  const calls = [], snaps = [], logs = [], tracked = [], last = {}, prio = [];
  const behave = o.behave || (() => ({ code: 0 }));
  const spawn = (bin, args, opt) => {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = 5000 + calls.length;
    c.kill = () => { c.killed = true; setImmediate(() => c.emit("close", null, "SIGTERM")); };
    // 每一條 pip 被叫起來的那一刻 -c 指的檔在不在、內容是什麼(SDK 那條要在引擎那一步就讀得到)
    const ci = args.indexOf("-c"); let pins = null; if (ci >= 0) { try { pins = fs.readFileSync(args[ci + 1], "utf8"); } catch (_) { pins = "(missing)"; } }
    calls.push({ bin, args, env: opt.env, hide: opt.windowsHide, pins, child: c }); last.child = c;
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
    fs, path, spawn, base, ws, venvPy, venvBin: "bin", win: false, basePython: () => "/bundled/python3", envPath: o.envPath || (async () => "/usr/bin:/bin"),
    pyEnv: { PYTHONUTF8: "1" }, copyOfficial: () => { fs.mkdirSync(path.join(ws, "lib"), { recursive: true }); }, isPackaged: true,
    sdkPins: o.sdk || SDK, deps: o.deps || DEPS, lock: o.lock, optional: o.optional || OPT, firstRunMB: 200, venvMs: 300000, engineMs: 600000, pkgMs: o.pkgMs || 600000,
    // 假子行程的 pid(5000+n)可能撞到本機真的行程:探針預設當它死了,否則 waitLock 在假時鐘下永遠等不完
    idleMs: o.idleMs, watchMs: 5, alive: o.alive || (() => false), sleep: o.sleep, lockWaitMs: o.lockWaitMs, setPriority: (pid) => prio.push(pid),
    groupMB: o.groupMB === undefined ? { core: 100, us: 10 } : o.groupMB, pipCacheDir: o.pipCacheDir, procStart: o.procStart, killPid: o.killPid,
    now: o.realNow ? Date.now : () => clock, onChange: (s) => snaps.push(s), log: (m) => logs.push(m), track: (ev, p) => tracked.push(ev + ":" + p.result),
  });
  // settle:等背景編譯(假的,下一輪事件迴圈就結束)收尾;同一個 base 開下一個 rig 之前要等,不然記號檔還沒寫
  const settle = async () => { for (let k = 0; k < 2000 && S.compiling(); k++) await new Promise((x) => setTimeout(x, 1)); };
  return { S, base, ws, venvPy, calls, snaps, logs, tracked, prio, settle, tick: (ms) => { clock += ms; }, get lastChild() { return last.child; } };
}
const pipCalls = (r) => r.calls.filter((c) => c.args.includes("pip"));
// 一條 pip 要裝的 pin:-c <檔> 之後的全部
const batchOf = (c) => c.args.slice(c.args.indexOf("-c") + 2);
const pinsOf = (r) => pipCalls(r).flatMap(batchOf);
const batches = (r) => pipCalls(r).map((c) => batchOf(c).join(" "));
const pycCalls = (r) => r.calls.filter((c) => c.args.includes("compileall"));
const SDKP = SDK.split(" ");
const venvDir = (r) => path.join(r.base, "venv");

(async () => {
  // 第一次:三步都要走
  const r = rig({ behave: (bin, args) => (args.includes(pin("numpy")) ? { out: ["Collecting " + pin("pandas"), "Collecting " + pin("numpy"), "Downloading numpy-2.5.3-cp312-cp312-macosx_14_0_arm64.whl (5.4 MB)", "Progress 0 of 5445405", "Progress 2097152 of 5445405", "Progress 5445405 of 5445405", "Installing collected packages: numpy"] } : { code: 0 }) });
  await r.S.ensure();
  const pycAtReady = pycCalls(r).length, compilingAtReady = r.S.compiling(), busyAtReady = r.S.busy();
  const s0 = r.snaps[0], last = r.snaps[r.snaps.length - 1];
  ok("第一次:三個步驟(建立工作區 / 安裝引擎 / 安裝策略套件)、kind=first、帶實測大小", s0.phase === "run" && s0.steps.map((x) => x.k).join() === "ws,engine,pkgs" && s0.kind === "first" && s0.sizeMB === 200 && s0.show === true, s0);
  ok("venv 用隨包 Python 建,pip 用 venv 的 python;子行程不開 shell、帶 windowsHide、PYTHONUNBUFFERED", r.calls[0].bin === "/bundled/python3" && r.calls[0].args.join(" ") === "-m venv " + venvDir(r) && pipCalls(r).every((c) => c.bin === r.venvPy && c.hide === true && c.env.PYTHONUNBUFFERED === "1" && c.env.PATH === "/usr/bin:/bin" && c.env.PYTHONUTF8 === "1") && r.calls[0].env.PYTHONUTF8 === "1");
  ok("SDK 一條、核心那組一條(7 個照清單原順序,一次交給 pip)", batches(r).join("|") === [SDK, DEPS.join(" ")].join("|"), batches(r));
  ok("每一條 pip 都帶 --no-compile", pipCalls(r).length === 2 && pipCalls(r).every((c) => c.args.includes("--no-compile")));
  const pinsFile = path.join(venvDir(r), ".blave-pins.txt");
  { const sdk = pipCalls(r)[0], i = sdk.args.indexOf("-c");
    ok("SDK 那條也帶 -c 整份清單(SDK 的相依不能悄悄升級核心套件),而且叫起來的那一刻檔已經寫好", i > 0 && sdk.args[i + 1] === path.join(venvDir(r), ".blave-pins.txt") && sdk.pins === DEPS.join("\n") + "\n"
      && sdk.args.slice(-SDK.split(" ").length).join(" ") === SDK, sdk); }
  ok("核心那條也拿整份清單當 -c(依賴版本跟一次全裝一樣)", pipCalls(r).slice(1).every((c) => { const i = c.args.indexOf("-c"); return i > 0 && c.args[i + 1] === pinsFile; }) && fs.readFileSync(pinsFile, "utf8") === DEPS.join("\n") + "\n");
  ok("裝完:.blave-sdk 與 .blave-deps-1 是整串(舊版認得的樣子)、.blave-deps-1.part 收掉", fs.readFileSync(path.join(venvDir(r), ".blave-sdk"), "utf8") === SDK && fs.readFileSync(path.join(venvDir(r), ".blave-deps-1"), "utf8") === DEPS.join("\n") && !fs.existsSync(path.join(venvDir(r), ".blave-deps-1.part")));
  ok("最後一張快照:done、每一步都 done、有花多久", last.phase === "done" && last.steps.every((x) => x.st === "done" && x.ms >= 0 && x.t0 === null) && last.steps[1].ms > 0 && last.steps[2].ms > 0 && last.tEnd > last.t0, last);
  const seq = r.snaps.map((s) => s.steps.map((x) => x.st[0]).join("")).filter((v, i, a) => v !== a[i - 1]);
  ok("步驟狀態依序:www → rww → dww → drw → ddw → ddr → ddd", seq.join(" ") === "www rww dww drw ddw ddr ddd", seq);
  const nth = r.snaps.filter((s) => s.cur && s.cur.step === "pkgs" && s.cur.i).map((s) => s.cur.i + "/" + s.cur.n + "x" + s.cur.k + ":" + s.cur.name).filter((v, i, a) => v !== a[i - 1]);
  ok("套件那一步:i / n = 已裝好 +1 / 整份清單、k = 這一條裝幾個;名字不帶版本,先是第一個、再跟著 Collecting / Downloading 換", nth.join() === ["1/" + NC + "x" + NC + ":pandas", "1/" + NC + "x" + NC + ":numpy"].join(), nth);
  ok("引擎那一步先是「建立 Python 環境」,再是 SDK(名字 claude-agent-sdk)", r.snaps.some((s) => s.cur && s.cur.step === "engine" && s.cur.sub === "venv") && r.snaps.some((s) => s.cur && s.cur.step === "engine" && s.cur.name === "claude-agent-sdk" && s.cur.limitMs === 600000));
  const mid = r.snaps.find((s) => s.dl.file && s.dl.file.bytes === 2097152);
  ok("下載量進快照:這個檔 bytes / total、已下載總量累加", mid && mid.dl.file.total === 5445405 && last.dl.done === 5445405, mid);
  { const pc = pycCalls(r)[0], idx = r.calls.indexOf(pc);
    ok("裝好之後在背景編 .pyc:ensure 回來時已經叫起來(不等它)、在最後一條 pip 之後、用建 venv 的那顆 Python(不是 Windows 會轉手的 venv launcher)對整個 venv、-q、不帶 -j",
      pycAtReady === 1 && compilingAtReady && idx === r.calls.length - 1 && idx > r.calls.indexOf(pipCalls(r)[1]) && pc.bin === "/bundled/python3" && pc.args.join(" ") === "-m compileall -q " + venvDir(r) && !pc.args.some((a) => /^-j/.test(a)), pc && pc.args);
    ok("背景編譯帶同一份 pyEnv(打包版的 PYTHONPYCACHEPREFIX 才對得上回合)、windowsHide、調低優先權(那支的 pid)", pc.env.PYTHONUTF8 === "1" && pc.hide === true && r.prio.join() === String(pc.child.pid), r.prio);
    ok("背景編譯不算「安裝中」:busy() 是 false(搬移詢問、結束確認照常),compiling() 是 true", busyAtReady === false && compilingAtReady === true);
    await r.settle();
    ok("編完寫 .blave-pyc、compiling() 回 false、留一筆 log", !r.S.compiling() && fs.readFileSync(path.join(venvDir(r), ".blave-pyc"), "utf8") === SDK + "\n" + DEPS.join("\n") && r.logs.some((l) => /bytecode compiled in/.test(l))); }
  ok("沒事可做:不送快照、不跑子行程(也不再編)", await (async () => { const n = r.snaps.length, c = r.calls.length; await r.S.ensure(); return r.snaps.length === n && r.calls.length === c; })());

  // 核心那條下載到 pyarrow 時斷線 → 失敗 → 重試整組再跑一條(已下載完的檔在 pip 快取裡)
  let fail = true;
  const f = rig({ behave: (bin, args) => (!args.includes(pin("pyarrow")) ? { code: 0 } : fail ? { code: 1, out: ["Downloading numpy-2.5.3-cp312-cp312-macosx_14_0_arm64.whl (5.4 MB)", "Progress 5445405 of 5445405", "Downloading pyarrow-25.0.1-cp312-cp312-macosx_12_0_arm64.whl (35.9 MB)", "Progress 0 of 35861559", "Progress 8388608 of 35861559"], err: "ERROR: Exception:\nReadTimeoutError: HTTPSConnectionPool(host='files.pythonhosted.org', port=443): Read timed out." } : { code: 0 }) });
  let thrown = null; try { await f.S.ensure(); } catch (e) { thrown = e; }
  const fs1 = f.S.snapshot();
  ok("失敗:ensure 拋出、快照 phase=fail、出事的那一步 err、前面的 done", thrown && fs1.phase === "fail" && fs1.steps.map((x) => x.st).join() === "done,done,err", fs1);
  ok("失敗原因:net、停在正在下載的 pyarrow(Downloading 那一行)、整組從第 1 個起算", fs1.err.kind === "net" && fs1.err.name === "pyarrow" && fs1.err.step === "pkgs" && fs1.cur.i === 1 && fs1.cur.k === NC, fs1.err);
  ok("失敗了不跑背景編譯", pycCalls(f).length === 0);
  ok("失敗留痕:完整 stderr 進主行程的 log", f.logs.some((l) => /pip install failed/.test(l) && /ReadTimeoutError/.test(l)));
  ok("失敗卡的錯誤訊息帶得到原因(不是只有「ERROR: Exception:」)", /Read timed out/.test(fs1.err.msg), fs1.err.msg);
  ok("斷掉的那一個檔不算進已下載", fs1.dl.done === 5445405 && fs1.dl.file === null);
  ok("整組是一個單位:.blave-deps-1 還沒寫、也不寫逐個的 .part", !fs.existsSync(path.join(venvDir(f), ".blave-deps-1.part")) && !fs.existsSync(path.join(venvDir(f), ".blave-deps-1")));
  const before = pipCalls(f).length; fail = false; f.tick(60000);
  await f.S.ensure();
  const fs2 = f.S.snapshot();
  ok("重試:核心那組整條再跑一次,SDK 不重裝、不重建 venv", batches(f).slice(1).join("|") === [DEPS.join(" "), DEPS.join(" ")].join("|") && pipCalls(f).length === before + 1 && f.calls.filter((c) => c.args.includes("venv")).length === 1, batches(f));
  ok("重試沿用同一張卡:步驟、kind、已下載量、先前花的時間都接著算", fs2.phase === "done" && fs2.kind === "first" && fs2.steps.map((x) => x.k).join() === "ws,engine,pkgs" && fs2.acc === fs1.tEnd - fs1.t0 && fs2.dl.done === 5445405 && fs2.steps[2].ms > fs1.steps[2].ms && fs2.steps[0].ms === fs1.steps[0].ms, { fs1, fs2 });
  ok("重試一開始:出事那一步回到 run(不是留在 err)、錯誤清掉", f.snaps.some((s) => s.phase === "run" && s.t0 > fs1.tEnd && s.err === null && s.steps[2].st === "run"));

  // 關掉 app 再開(快照不在記憶體了):照記號檔接著,標題仍是「第一次」
  { const r2 = rig({ behave: (bin, args, n) => (args.includes(pin("pyarrow")) ? { code: 1, err: "ERROR: boom" } : { code: 0 }) });
    try { await r2.S.ensure(); } catch (_) { /* 預期 */ }
    const r3 = rig({ base: r2.base });
    await r3.S.ensure();
    ok("重開 app 再裝:SDK 不重裝、核心那組整條、標題仍是第一次(.blave-deps-1 還沒寫過)", batches(r3).join("|") === DEPS.join(" ") && r3.snaps[0].kind === "first" && r3.snaps[0].steps.map((x) => x.k).join() === "pkgs", r3.snaps[0]);
    // 0.1.27 以前一個一個裝、裝到一半留下的 .part:升上來只裝沒裝的那幾個(一條),裝完收掉 .part
    const lg = rig(); await lg.S.ensure(); await lg.settle();
    fs.unlinkSync(path.join(venvDir(lg), ".blave-deps-1")); fs.writeFileSync(path.join(venvDir(lg), ".blave-deps-1.part"), DEPS.slice(0, 3).join("\n"));
    const lg2 = rig({ base: lg.base }); await lg2.S.ensure();
    ok("舊版留下的 .blave-deps-1.part:只裝還沒裝的那幾個、一條 pip、裝完 .part 收掉", batches(lg2).join("|") === DEPS.slice(3).join(" ") && lg2.snaps.find((s) => s.cur && s.cur.i).cur.i === 4
      && fs.readFileSync(path.join(venvDir(lg2), ".blave-deps-1"), "utf8") === DEPS.join("\n") && !fs.existsSync(path.join(venvDir(lg2), ".blave-deps-1.part")), batches(lg2)); }

  // 逾時:pip 不結束 → 自己停、訊息固定、kind=timeout、limitMs = 那個套件的上限
  { const t = rig({ pkgMs: 30, behave: (bin, args) => (args.includes(pin("pandas")) ? { hang: true } : { code: 0 }) });
    let e = null; try { await t.S.ensure(); } catch (x) { e = x; }
    const s = t.S.snapshot();
    ok("逾時:殺掉、「timed out after 0s」不帶指令與路徑、kind=timeout、limitMs=套件上限", e && e.message === "timed out after 0s" && s.err.kind === "timeout" && s.err.limitMs === 30 && s.err.step === "pkgs" && s.err.name === "pandas", s.err); }

  // 更新:SDK 釘法換了(.blave-deps-1 是完整的)→ 只有引擎那一步、kind=update、不帶大小
  { const u = rig(); await u.S.ensure(); await u.settle();
    fs.unlinkSync(path.join(venvDir(u), ".blave-pins.txt"));   // 上一輪留下的不算:這一輪自己要寫
    const u2 = rig({ base: u.base, sdk: SDK2 }); await u2.S.ensure();
    { const c0 = pipCalls(u2)[0];
      ok("只換 SDK 的更新(沒有套件那一步):SDK 那條照樣帶 -c、檔是這一版的整份清單", c0.args.includes("-c") && c0.pins === DEPS.join("\n") + "\n", c0); }
    ok("更新後補裝:只走引擎那一步、標題是更新、不寫死大小", u2.snaps[0].kind === "update" && u2.snaps[0].steps.map((x) => x.k).join() === "engine" && u2.snaps[0].sizeMB === null && batches(u2).join("|") === SDK2, u2.snaps[0]);
    ok("換了 SDK:編譯記號先刪掉、裝完再編一次", pycCalls(u2).length === 1);
    await u2.settle();
    const u3 = rig({ base: u.base, sdk: SDK2, deps: DEPS.map((p) => (p === pin("scipy") ? bump(p) : p)) }); await u3.S.ensure(); await u3.settle();
    ok("清單換了一個版本:只裝那一個、kind=update", pinsOf(u3).join() === bump(pin("scipy")) && u3.snaps[0].kind === "update");
    // .app 換了位置:venv 的 python 是斷掉的連結 → 重建 venv,不出卡(show=false)
    fs.unlinkSync(u3.venvPy); fs.symlinkSync(path.join(u3.base, "nowhere"), u3.venvPy);
    const u4 = rig({ base: u.base, sdk: SDK2, deps: DEPS.map((p) => (p === pin("scipy") ? bump(p) : p)) }); await u4.S.ensure();
    ok("只有 venv 連結斷了:先清斷掉的連結再重建、沒有 pip、不出卡、不重編(.pyc 還在)", u4.snaps[0].show === false && u4.calls.length === 1 && u4.calls[0].args.includes("venv") && pipCalls(u4).length === 0, u4.snaps[0]); }

  // ~/Blave 由我們建立時 0700(稽核 R9);已經在的不動權限
  if (process.platform !== "win32") {
    const parent = tmpDir(), base = path.join(parent, "Blave");
    const n = rig({ base }); await n.S.ensure();
    const pre = rig(); fs.chmodSync(pre.base, 0o755); await pre.S.ensure();
    ok("~/Blave 由 app 建立時是 0700;既有目錄的權限不動", (fs.statSync(base).mode & 0o777) === 0o700 && (fs.statSync(pre.base).mode & 0o777) === 0o755);
  }
  // 17 個的清單:第一次三條 pip(SDK / 核心 / 美股);7 個裝過的既有用戶升級 → 只補新加的 10 個(一條),從 8 / 17 起算
  { const nthOf = (r) => r.snaps.filter((s) => s.cur && s.cur.step === "pkgs" && s.cur.i).map((s) => s.cur.i + "/" + s.cur.n + "x" + s.cur.k).filter((v, i, a) => v !== a[i - 1]);
    const f17 = rig({ deps: DEPS17 }); await f17.S.ensure();
    ok("17 個:第一次恰好三條 pip——SDK、核心(7 個)、美股(10 個),每條都帶 --no-compile", batches(f17).join("|") === [SDK, DEPS.join(" "), US.join(" ")].join("|") && pipCalls(f17).every((c) => c.args.includes("--no-compile")), batches(f17));
    ok("17 個:i / n 跟著組前進(1 / 17 一次 7 個 → 8 / 17 一次 10 個),分段條照這個填", nthOf(f17).join() === ["1/" + N + "x" + NC, (NC + 1) + "/" + N + "x" + NU].join(), nthOf(f17));
    { const bars = f17.snaps.filter((s) => s.cur && s.cur.step === "pkgs" && s.cur.bar).map((s) => JSON.stringify(s.cur.bar)).filter((v, i, a) => v !== a[i - 1]).map((x) => JSON.parse(x));
      ok("17 個:分段條照兩組預估下載量分(核心 100 MB : 美股 10 MB)、核心從 0 起、美股接在核心後面、各組 est = 預估 MB、dl0 = 那一組開始時的累計下載量",
        bars.length === 2 && bars[0].from === 0 && Math.abs(bars[0].span - 100 / 110) < 1e-9 && bars[0].est === 100e6 && Math.abs(bars[1].from - 100 / 110) < 1e-9 && Math.abs(bars[1].from + bars[1].span - 1) < 1e-9 && bars[1].est === 10e6
        && bars.every((b) => typeof b.dl0 === "number"), bars); }
    ok("17 個:兩組都裝完才編一次", pycCalls(f17).length === 1 && f17.calls.indexOf(pycCalls(f17)[0]) === f17.calls.length - 1);
    const old = rig(); await old.S.ensure(); await old.settle();
    const up = rig({ base: old.base, deps: DEPS17, behave: (bin, args) => (args.includes(US[NU - 1]) ? { out: ["Downloading yfinance-1.7.0-py3-none-any.whl (131 kB)", "Downloading curl_cffi-0.16.3-cp310-abi3-macosx_11_0_arm64.whl (3.2 MB)", "Progress 3200000 of 3200000"] } : { code: 0 }) });
    await up.S.ensure();
    const u0 = up.snaps[0], ul = up.snaps[up.snaps.length - 1];
    ok("7 → 17 升級:只補新加的 10 個、kind=update、只有套件那一步、不寫大小", pinsOf(up).join() === US.join() && u0.kind === "update" && u0.steps.map((x) => x.k).join() === "pkgs" && u0.sizeMB === null, { pins: pinsOf(up), u0 });
    ok("7 → 17 升級:從 8 / 17 開始數(前 7 個本來就在)、一條裝 10 個", nthOf(up).join() === (NC + 1) + "/" + N + "x" + NU, nthOf(up));
    ok("7 → 17 升級:名字跟著 Downloading 換(yfinance → curl-cffi,正規化過)", up.snaps.filter((s) => s.cur && s.cur.step === "pkgs" && s.cur.name).map((s) => s.cur.name).filter((v, i, a) => v !== a[i - 1]).join() === [nn(US[0]), "yfinance", "curl-cffi"].join());
    ok("7 → 17 升級:已下載量只算這次真的下載的", ul.phase === "done" && ul.dl.done === 131000 + 3200000, ul.dl);
    ok("7 → 17 升級:兩組各一個記號檔——核心那份(7 個)沒被動到、美股那份是 10 個的整串", fs.readFileSync(path.join(venvDir(up), ".blave-deps-1"), "utf8") === DEPS.join("\n") && fs.readFileSync(path.join(venvDir(up), ".blave-deps-us"), "utf8") === US.join("\n"));
    await up.settle();
    const bmp = rig({ base: old.base, deps: [bump(DEPS17[0]), ...DEPS17.slice(1)] }); fs.writeFileSync(path.join(venvDir(old), ".blave-deps-1"), DEPS.join("\n")); fs.unlinkSync(path.join(venvDir(old), ".blave-deps-us"));
    await bmp.S.ensure();
    { const b = bmp.snaps.find((s) => s.cur && s.cur.step === "pkgs" && s.cur.bar).cur.bar;
      ok("只補一部分:前面裝好的那幾個先算滿(6 / 17),核心那組只裝 1 / 7 → 預估只算那個比例", Math.abs(b.from - (N - NC - NU + NC - 1) / N) < 1e-9 && Math.abs(b.est - 100e6 / NC) < 1, b); }
    ok("清單同時換掉一個版本又多 10 個:i 從已經裝好的個數 +1 起算(7 / 17 一次 1 個 → 8 / 17 一次 10 個)", nthOf(bmp).join() === [NC + "/" + N + "x1", (NC + 1) + "/" + N + "x" + NU].join() && batches(bmp).join("|") === [bump(DEPS17[0]), US.join(" ")].join("|"), nthOf(bmp)); }
  // ── 選用的那組(美股資料):裝不起來不擋引擎 ──
  { const G = E.depGroups(DEPS17, OPT);
    ok("分組:點名的 10 個是 us、其餘 7 個是核心、順序照清單", G.length === 2 && G[0].id === "core" && G[0].pins.join() === DEPS.join() && G[1].id === "us" && G[1].pins.join() === US.join() && G[1].optional && !G[0].optional);
    ok("分組:名字不分大小寫與 - _ .;清單沒點名到的新套件當核心(裝不起來照樣擋)", E.depGroups(["Curl-CFFI==1", "newdep==2"], OPT)[1].pins.join() === "Curl-CFFI==1" && E.depGroups(["Curl-CFFI==1", "newdep==2"], OPT)[0].pins.join() === "newdep==2");
    ok("分組:7 個的清單一個都沒點到 → 只有核心一組", E.depGroups(DEPS, OPT).length === 1);
    let failUs = true;
    const g = rig({ deps: DEPS17, behave: (bin, args) => (failUs && args.includes(US[1]) ? { code: 1, out: ["Collecting " + US[0], "Collecting " + US[1]], err: "ERROR: No matching distribution found for " + US[1] } : { code: 0 }) });
    let thrown = null; try { await g.S.ensure(); } catch (e) { thrown = e; }
    const gs = g.S.snapshot();
    ok("美股那組失敗:不往外丟、phase=done、步驟都 done、warn 記哪一組哪一個", thrown === null && gs.phase === "done" && gs.steps.every((x) => x.st === "done") && gs.err === null && gs.warn && gs.warn.group === "us" && gs.warn.name === nm(US[1]) && gs.warn.kind === "other", gs);
    ok("美股那組失敗:核心那組記號照寫、美股那組不寫(整組一個單位,沒有 .part)", fs.readFileSync(path.join(venvDir(g), ".blave-deps-1"), "utf8") === DEPS.join("\n") && !fs.existsSync(path.join(venvDir(g), ".blave-deps-us")) && !fs.existsSync(path.join(venvDir(g), ".blave-deps-us.part")));
    ok("美股那組失敗:那一條就是整組、留一筆 log;引擎照樣好,照樣在背景編", batches(g).slice(1).join("|") === [DEPS.join(" "), US.join(" ")].join("|") && g.logs.some((l) => /optional packages "us" not installed/.test(l)) && pycCalls(g).length === 1);
    await g.settle();
    const n1 = g.calls.length, s1 = g.snaps.length; await g.S.ensure();
    ok("同一次啟動再送一句:不再試美股那組(不讓每一句話都等一輪 pip)、不出卡", g.calls.length === n1 && g.snaps.length === s1);
    failUs = false;
    const g2 = rig({ base: g.base, deps: DEPS17 }); await g2.S.ensure();
    ok("下次開 app:美股那組整條再裝一次,核心不重裝;標題是補裝、8 / 17 起算;裝完再編一次", batches(g2).join("|") === US.join(" ") && g2.snaps[0].kind === "update" && g2.snaps.find((s) => s.cur && s.cur.i).cur.i === NC + 1 && fs.readFileSync(path.join(venvDir(g2), ".blave-deps-us"), "utf8") === US.join("\n") && pycCalls(g2).length === 1, batches(g2));
    const core = rig({ deps: DEPS17, behave: (bin, args) => (args.includes(pin("scipy")) ? { code: 1, err: "ERROR: boom" } : { code: 0 }) });
    let ce = null; try { await core.S.ensure(); } catch (e) { ce = e; }
    ok("核心那組失敗:照舊往外丟、phase=fail、美股那組沒開始裝", ce && core.S.snapshot().phase === "fail" && !pinsOf(core).some((p) => US.includes(p)));
    const legacy = rig(); await legacy.S.ensure(); await legacy.settle();
    const lu = rig({ base: legacy.base, deps: DEPS17, behave: (bin, args) => (args.includes(US[NU - 1]) ? { code: 1, out: ["Collecting " + US[NU - 1]], err: "WARNING: Retrying ... NewConnectionError(...)\nERROR: No matching distribution found for " + US[NU - 1] } : { code: 0 }) });
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
    ok("main.js 把 firstRunMB() 交給 enginesetup、兩道停的上限:SDK 那條 45 分鐘、套件一組一條 90 分鐘(0.1.28)、2 分鐘沒資料就停", /firstRunMB: firstRunMB\(\)/.test(MAIN_SRC) && /idleMs: PIP_IDLE_MS/.test(MAIN_SRC)
      && /const ENGINE_PIP_MS = 2700000, PKG_PIP_MS = 5400000, PIP_IDLE_MS = 120000, VENV_MS = 300000;/.test(MAIN_SRC) && !/105 KB\/s/.test(MAIN_SRC)); }

  // ── 關 app / 為了更新重開:收掉正在跑的 pip(稽核 0.1.12 P1-1)──
  { const a = rig({ behave: (bin, args) => (args.includes(pin("pandas")) ? { hang: true, out: ["Downloading pandas-3.0.6-cp312-cp312-macosx_11_0_arm64.whl (10.1 MB)"] } : { code: 0 }) });
    // 等到 pip 真的卡在那個套件才收(固定 30ms 真時鐘在慢機器上還沒裝到 → abort() 回 false、ensure 永遠不回;稽核跑 12 次掛 3 次)
    const atArg = async (r, arg) => { for (let k = 0; k < 2000 && !(r.lastChild && r.calls.length && r.calls[r.calls.length - 1].args.includes(arg)); k++) await new Promise((x) => setTimeout(x, 5)); };
    const p = a.S.ensure().then(() => null, (e) => e); await atArg(a, pin("pandas"));
    const lock = path.join(venvDir(a), ".blave-install.lock");
    const hadLock = fs.existsSync(lock), wasBusy = a.S.busy();
    const stopped = await a.S.abort(); const e = await p;
    ok("abort():殺掉正在跑的 pip、等它結束才回來;安裝失敗但不算埋點(我們自己收的)、鎖檔收掉", hadLock && wasBusy && stopped === true && e && e.aborted === true && a.calls[a.calls.length - 1].args.includes(pin("pandas"))
      && !a.S.busy() && !fs.existsSync(lock) && a.tracked.length === 0, { hadLock, wasBusy, stopped, e: e && e.message, tracked: a.tracked });
    ok("abort():沒在裝時立刻回 false", (await a.S.abort()) === false);
    // 裝到美股那組時關 app(稽核 0.1.12 複驗 P2):不能被記成「美股那組失敗」,ensure 也不能當成裝好了
    const o2 = rig({ deps: DEPS17, behave: (bin, args) => (args.includes(US[0]) ? { hang: true } : { code: 0 }) });
    const p2 = o2.S.ensure().then(() => "resolved", (x) => x); await atArg(o2, US[0]);
    const busyUs = o2.S.busy() && o2.S.snapshot().cur.name === nn(US[0]);
    await o2.S.abort(); const r2 = await p2, s2 = o2.S.snapshot();
    ok("裝美股那組時被收掉:ensure 拋出(aborted)、沒有 warn、不送 engine_opt_fail 也不送 engine_setup、美股那組記號沒寫", busyUs && r2 !== "resolved" && r2.aborted === true && !s2.warn && o2.tracked.length === 0
      && !fs.existsSync(path.join(venvDir(o2), ".blave-deps-us")), { busyUs, r2: r2 && (r2.message || r2), warn: s2.warn, tracked: o2.tracked }); }
  // 鎖檔:上一次留下的 pip 還活著(當掉、被強制結束)→ 先等它結束,不同時寫同一個 venv
  { let alive = true, waited = 0; const base = tmpDir();
    fs.mkdirSync(path.join(base, "venv"), { recursive: true }); fs.writeFileSync(path.join(base, "venv", ".blave-install.lock"), JSON.stringify({ pid: 4242, at: 1 }));
    const l = rig({ base, alive: (pid) => pid === 4242 && alive, sleep: async () => { waited++; if (waited === 3) alive = false; } });
    await l.S.ensure();
    ok("鎖檔裡的 pip 還活著:等它結束(這裡等了 3 輪)才開始裝;不殺它", waited === 3 && pinsOf(l).length === SDKP.length + DEPS.length && l.logs.some((x) => /another installer \(pid 4242\)/.test(x)), { waited, logs: l.logs });
    let w2 = 0; const base2 = tmpDir();
    fs.mkdirSync(path.join(base2, "venv"), { recursive: true }); fs.writeFileSync(path.join(base2, "venv", ".blave-install.lock"), JSON.stringify({ pid: 4242, at: 1 }));
    const l2 = rig({ base: base2, alive: () => true, lockWaitMs: 30, realNow: true, sleep: async () => { w2++; await new Promise((r) => setTimeout(r, 3)); } });
    await l2.S.ensure();
    ok("…一直活著(pid 可能被別的程式重用了):等滿上限就往下走,不卡死", w2 >= 1 && pinsOf(l2).length === SDKP.length + DEPS.length, w2);
    const l3 = rig({ alive: () => { throw new Error("不該問"); } }); await l3.S.ensure();
    ok("沒有鎖檔:不等", pinsOf(l3).length === SDKP.length + DEPS.length); }

  // ── 多久沒收到資料才停(稽核 0.1.12 P1-2):慢但有在動的不停;下載中卡住 → 以網路失敗停;安裝階段不出聲不算 ──
  { const st = rig({ realNow: true, idleMs: 40, behave: (bin, args) => (args.includes(pin("pandas")) ? { hang: true, out: ["Downloading pandas-3.0.6-cp312-cp312-macosx_11_0_arm64.whl (10.1 MB)", "Progress 0 of 10051279"] } : { code: 0 }) });
    let e = null; try { await st.S.ensure(); } catch (x) { e = x; }
    const s = st.S.snapshot();
    ok("下載中 idleMs 沒有新資料:停下、kind=net(呈現成網路中斷)、訊息「no data for …」不帶路徑", e && /^no data for \d+s$/.test(e.message) && s.err.kind === "net" && s.err.name === "pandas" && st.tracked.join() === "engine_setup:first_net", { m: e && e.message, err: s.err });
    // 假時鐘(同下面兩段的理由):真時鐘時 spawn 到第一行之間事件迴圈卡 20ms 就會先以 net 停掉。進了安裝階段才把假時鐘推過 idleMs,
    // 沒照「安裝階段不算」的實作在這裡就以 net 停;照了的,只有 pkgMs(真的 120ms 計時器)會停
    const ins = rig({ idleMs: 20, pkgMs: 120, behave: (bin, args) => (args.includes(pin("pandas")) ? { hang: true, out: ["Downloading pandas-3.0.6-cp312-cp312-macosx_11_0_arm64.whl (10.1 MB)", "Progress 10051279 of 10051279", "Installing collected packages: pandas"] } : { code: 0 }) });
    let e2 = null; const pIns = ins.S.ensure().catch((x) => { e2 = x; });
    for (let k = 0; k < 2000 && !(ins.S.busy() && ins.S.snapshot().dl.installing); k++) await new Promise((x) => setTimeout(x, 2));
    ins.tick(1000); await pIns;
    ok("安裝階段(Installing collected packages 之後)不出聲:不算沒資料,只有總上限會停 → timeout", e2 && ins.S.snapshot().err.kind === "timeout" && /^timed out after/.test(e2.message), e2 && e2.message);
    // 下面兩段用假時鐘(10-04 runner 紅過):真時鐘時 idleMs 40 對每 15ms 一行只有 25ms 餘裕,慢機器的事件迴圈一卡就被停,
    // 之後測試自己送的 close 0 被當成「no data」。假時鐘每行前推 15ms、看門狗(watchMs 5)照真時間跑:實作對時靜默最多 15、
    // 機器多慢都不會停;有輸出卻不重算靜默的話,第 3 行起靜默就超過 40,中間那段真的 sleep 讓看門狗看得到 → 被停
    const wd = () => new Promise((r) => setTimeout(r, 25));   // 看門狗至少跑過 5 輪
    const atPandas = async (r) => { for (let k = 0; k < 2000 && !(r.lastChild && r.calls[r.calls.length - 1].args.includes(pin("pandas"))); k++) await new Promise((x) => setTimeout(x, 5)); };
    let n = 0; const flow = rig({ idleMs: 40, behave: (bin, args) => {
      if (!args.includes(pin("pandas"))) return { code: 0 };
      return { hang: true, out: ["Downloading pandas-3.0.6-cp312-cp312-macosx_11_0_arm64.whl (10.1 MB)"] }; } });
    const pr = flow.S.ensure().then(() => "ok", (x) => x.message);
    // 慢但一直有資料:每 15ms 來一行 Progress,總共 120ms(遠超過 idleMs)→ 不會被停
    await atPandas(flow);
    const c = flow.calls.length; let bytes = 0;
    const child = flow.lastChild;
    ok("(測試接線)拿得到正在跑的假子行程", !!child);
    if (child) { for (n = 0; n < 8; n++) { flow.tick(15); await wd(); bytes += 100000; child.stdout.emit("data", "Progress " + bytes + " of 10051279\n"); }
      ok("慢但一直有資料進來(8 × 15ms,共 120ms > idleMs 40ms):沒被停", flow.S.busy() && flow.S.snapshot().phase === "run");
      child.emit("close", 0); }
    ok("…之後正常裝完", (await pr) === "ok" && flow.calls.length >= c);
    // 解析相依的那段(Collecting … / Using cached …)沒有 bytes,但有輸出:也算有在動
    const col = rig({ idleMs: 40, behave: (bin, args) => (args.includes(pin("pandas")) ? { hang: true } : { code: 0 }) });
    const pc = col.S.ensure().then(() => "ok", (x) => x.message);
    await atPandas(col);
    const cc = col.lastChild;
    for (let k = 0; k < 8; k++) { col.tick(15); await wd(); cc.stdout.emit("data", "Collecting dep" + k + " (from pandas==3.0.6)\n"); }
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
    const before = pipCalls(vv).length, beforeAll = vv.calls.length; await vv.S.ensure();
    ok("失敗後下一輪沒事可做:快照改成 done(卡收掉),不跑 pip;還沒編過 → 只補一支背景編譯", vv.S.snapshot().phase === "done" && pipCalls(vv).length === before && vv.calls.length === beforeAll + 1 && pycCalls(vv).length === 1 && vv.S.snapshot().err === null); }

  // ── 背景編 .pyc(pip 帶 --no-compile):ready 之後起、不擋、可收掉、失敗只記 log ──
  { const isPyc = (args) => args.includes("compileall");
    // 編到一半被 abort(結束 app / 更新重開):收掉、不寫記號;pip 沒在跑所以 abort 回 false;下次 ensure 沒事可做也會再編
    const a = rig({ behave: (bin, args) => (isPyc(args) ? { hang: true } : { code: 0 }) });
    await a.S.ensure();
    const pc = pycCalls(a)[0], was = a.S.compiling();
    const ret = await a.S.abort();
    ok("abort():背景編譯一起收掉(殺得到那支、等它結束)、不寫 .blave-pyc;沒有 pip 在跑 → 回 false", was && pc.child.killed && !a.S.compiling() && ret === false && !fs.existsSync(path.join(venvDir(a), ".blave-pyc")) && a.logs.some((l) => /bytecode compile stopped \(aborted\)/.test(l)), { was, ret });
    const n = a.calls.length; await a.S.ensure();
    ok("被收掉的那次沒編完:下一輪 ensure(沒有東西要裝)再起一支", a.calls.length === n + 1 && pycCalls(a).length === 2 && a.S.compiling());
    const n2 = a.calls.length; await a.S.ensure();
    ok("編譯還在跑時又 ensure(每送一句話都會):不重複起", a.calls.length === n2);
    // 編譯還在跑、又有東西要裝(同一次啟動裡記號檔不見了):先收掉編譯再起 pip
    fs.unlinkSync(path.join(venvDir(a), ".blave-deps-1"));
    const running = pycCalls(a)[1];
    let killedBeforePip = null;
    const orig = running.child.kill; running.child.kill = () => { killedBeforePip = pipCalls(a).length; orig(); };
    await a.S.ensure();
    ok("有新的 pip 要跑:先收掉正在跑的背景編譯(pip 開始之前),裝完再編一次", killedBeforePip === 2 && pipCalls(a).length === 3 && pycCalls(a).length === 3 && a.calls.indexOf(pycCalls(a)[2]) === a.calls.length - 1, { killedBeforePip, pip: pipCalls(a).length });
    await a.S.abort();
    // 退出碼 1 = 有檔編不過(套件帶的 py2 殘檔):照樣算編完、記 log;其他退出碼不寫記號
    const one = rig({ behave: (bin, args) => (isPyc(args) ? { code: 1, out: ["*** Error compiling '/x/site-packages/pkg/py2_only.py'..."] } : { code: 0 }) });
    await one.S.ensure(); await one.settle();
    ok("compileall 回 1(有檔編不過):照樣寫記號、log 留那幾行", fs.existsSync(path.join(venvDir(one), ".blave-pyc")) && one.logs.some((l) => /some files did not compile/.test(l) && /py2_only/.test(l)));
    const bad = rig({ behave: (bin, args) => (isPyc(args) ? { code: 2 } : { code: 0 }) });
    await bad.S.ensure(); await bad.settle();
    ok("compileall 其他退出碼:不寫記號、只記 log、引擎照樣是 done", !fs.existsSync(path.join(venvDir(bad), ".blave-pyc")) && bad.logs.some((l) => /bytecode compile stopped \(exit 2\)/.test(l)) && bad.S.snapshot().phase === "done");
    // spawn 直接拋(例:python 不見了):只記 log,不往外丟
    const th = rig(); await th.S.ensure(); await th.settle(); fs.unlinkSync(path.join(venvDir(th), ".blave-pyc"));
    const S3 = E.createEngineSetup({ fs, path, spawn: (bin, args) => { if (args.includes("compileall")) throw new Error("spawn EACCES"); throw new Error("不該跑 pip"); }, base: th.base, ws: th.ws, venvPy: th.venvPy, venvBin: "bin", win: false, basePython: () => "x", envPath: async () => "", pyEnv: {}, copyOfficial: () => {}, isPackaged: true,
      sdkPins: SDK, deps: DEPS, optional: OPT, firstRunMB: 200, venvMs: 1, engineMs: 1, pkgMs: 1, onChange: () => {}, log: (m) => th.logs.push(m), setPriority: () => {} });
    let se = null; try { await S3.ensure(); } catch (e) { se = e; }
    ok("背景編譯起不來:ensure 照樣成功、留一筆 log", se === null && !S3.compiling() && th.logs.some((l) => /bytecode compile not started: spawn EACCES/.test(l)), se && se.message);
    // 調優先權失敗(例:權限)不擋編譯
    const pr = rig(); const S4 = E.createEngineSetup({ fs, path, spawn: (bin, args) => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}; setImmediate(() => c.emit("close", 0)); return c; },
      base: pr.base, ws: pr.ws, venvPy: pr.venvPy, venvBin: "bin", win: false, basePython: () => "x", envPath: async () => "", pyEnv: {}, copyOfficial: () => {}, isPackaged: true,
      sdkPins: SDK, deps: DEPS, optional: OPT, firstRunMB: 200, venvMs: 60000, engineMs: 60000, pkgMs: 60000, onChange: () => {}, log: () => {}, setPriority: () => { throw new Error("EPERM"); } });
    fs.mkdirSync(path.dirname(pr.venvPy), { recursive: true }); fs.writeFileSync(pr.venvPy, "");
    let pe = null; try { await S4.ensure(); } catch (e) { pe = e; }
    ok("調不了優先權:照樣編、不往外丟", pe === null && S4.compiling(), pe && pe.message);
    await new Promise((x) => setTimeout(x, 5));
    // 接線:結束 app 時編譯中也要先收掉(不然 python 變孤兒);預設用 os 的最低優先權
    const SRC = fs.readFileSync(path.join(SHELL, "enginesetup.js"), "utf8");
    ok("接線:before-quit 把「編譯中」也算進要先收掉的;預設優先權 = os.constants.priority.PRIORITY_LOW",
      /installing = !!\(_engineSetup && \(_engineSetup\.busy\(\) \|\| _engineSetup\.compiling\(\)\)\)/.test(MAIN_SRC) && /require\("os"\)\.constants\.priority\.PRIORITY_LOW/.test(SRC)); }

  // ── 稽核 enginefast P2-1:背景編譯的鎖、孤兒 compileall、abort 之後不再起子行程 ──
  { const lockOf = (r) => path.join(venvDir(r), ".blave-pyc.lock");
    const h = rig({ behave: (bin, args) => (args.includes("compileall") ? { hang: true } : { code: 0 }) });
    await h.S.ensure();
    const pc = pycCalls(h)[0]; let lk = null; try { lk = JSON.parse(fs.readFileSync(lockOf(h), "utf8")); } catch (_) { /* 沒有 */ }
    ok("背景編譯起來時寫 .blave-pyc.lock(那支的 pid + 起的時間)", lk && lk.pid === pc.child.pid && typeof lk.at === "number", lk);
    await h.S.abort();
    ok("…收掉之後鎖檔也收掉", !fs.existsSync(lockOf(h)));
    // 上一次留下的孤兒:pid 活著、建立時間對得上 → 在任何 pip 之前收掉它、等它結束、再裝
    const mk = (pid, at) => { const b = tmpDir(); fs.mkdirSync(path.join(b, "venv"), { recursive: true }); fs.writeFileSync(path.join(b, "venv", ".blave-pyc.lock"), JSON.stringify({ pid, at })); return b; };
    let up = true; const killed = [];
    const o1 = rig({ base: mk(4343, 1000), alive: (pid) => pid === 4343 && up, procStart: (pid) => (pid === 4343 ? 1000 + 1500 : null), killPid: (pid) => { killed.push(pid); setTimeout(() => { up = false; }, 3); }, sleep: (ms) => new Promise((r) => setTimeout(r, 2)) });
    let killedBeforePip = null;
    const o1p = o1.S.ensure(); const iv = setInterval(() => { if (killed.length && killedBeforePip === null) killedBeforePip = pipCalls(o1).length; }, 0);
    await o1p; clearInterval(iv); await o1.settle();
    ok("孤兒 compileall(pid 活著、建立時間差 1.5 秒):先收掉、等它結束、鎖檔清掉,之後才起 pip", killed.join() === "4343" && killedBeforePip === 0 && pipCalls(o1).length === 2 && !fs.existsSync(lockOf(o1)) && o1.logs.some((l) => /stopping leftover bytecode compile \(pid 4343\)/.test(l)), { killed, killedBeforePip, logs: o1.logs });
    // pid 被別的程式重用(建立時間對不上)/ 查不到建立時間:不殺,只等它結束或等滿
    // 複核 P1-2:建立時間確定對不上 = pid 被別的程式重用,當年那支早死了 → 直接刪鎖往下走,不等
    { const k2 = []; let waits = 0;
      const o2 = rig({ base: mk(5151, 1000), alive: (pid) => pid === 5151, procStart: () => 1000 + 3600e3, killPid: (pid) => k2.push(pid), sleep: async () => { waits++; } });
      await o2.S.ensure(); await o2.settle();
      ok("鎖檔的 pid 被別的程式重用(建立時間差 1 小時):不殺、不等、刪鎖照裝", k2.length === 0 && waits === 0 && pipCalls(o2).length === 2 && !fs.existsSync(lockOf(o2)) && o2.logs.some((l) => /belongs to another program now/.test(l)), { k2, waits }); }
    // 查不到建立時間:不殺,最多等 15 秒(以前 180 秒),等的時候安裝卡在(cur.sub = waitPyc)
    { const k3 = []; let waits = 0, r3 = null;
      r3 = rig({ base: mk(5252, 1000), alive: (pid) => pid === 5252, procStart: async () => null, killPid: (pid) => k3.push(pid), sleep: async (ms) => { waits++; r3.tick(ms); } });
      await r3.S.ensure(); await r3.settle();
      const w = r3.snaps.find((x) => x.cur && x.cur.sub === "waitPyc");
      ok("查不到建立時間:不殺、最多等 15 秒(500ms × 30 輪)才往下裝、鎖檔清掉", k3.length === 0 && waits === 30 && pipCalls(r3).length === 2 && !fs.existsSync(lockOf(r3)), { k3, waits });
      ok("…等的那段安裝卡已經出來(phase run、show)、cur.sub = waitPyc、limitMs = 等的上限(15 秒,給畫面填 {limit})", !!w && w.phase === "run" && w.show === true && w.cur.limitMs === 15000, w); }
    // 複核 P1-1:鎖檔記的是我們這次自己正在跑的編譯 → 之後每一次 ensure 都不能把它當孤兒殺(alive 真的回 true、建立時間也對得上)
    { const kp = [];
      const me = rig({ alive: () => true, procStart: async (pid) => { try { return JSON.parse(fs.readFileSync(lockOf(me), "utf8")).at; } catch (_) { return null; } }, killPid: (pid) => kp.push(pid),
        behave: (bin, args) => (args.includes("compileall") ? { hang: true } : { code: 0 }) });
      await me.S.ensure();
      const first = pycCalls(me)[0];
      await me.S.ensure(); await me.S.ensure();
      ok("自己正在跑的背景編譯:之後送幾句話(ensure)都不被當孤兒殺、不重起", kp.length === 0 && pycCalls(me).length === 1 && !first.child.killed && me.S.compiling(), { kp, n: pycCalls(me).length });
      fs.unlinkSync(path.join(venvDir(me), ".blave-deps-1"));
      await me.S.ensure();
      ok("…同一次啟動又要起 pip:編譯走 compileStop 收(不是 killPid)、鎖檔不被當孤兒", kp.length === 0 && first.child.killed && pipCalls(me).length === 3, { kp });
      await me.S.abort(); }
    // 複核 P2-6:abort 之後在途那一輪還沒醒、又起了新的一輪:舊那輪照樣不能起子行程
    { let release; const gate = new Promise((r) => { release = r; });
      const ov = rig({ envPath: () => gate.then(() => "/usr/bin:/bin") });
      const pA = ov.S.ensure().then(() => "resolved", (e) => e);
      await ov.S.abort();
      const pB = ov.S.ensure().then(() => "resolved", (e) => e);
      release(); const [rA, rB] = await Promise.all([pA, pB]); await ov.settle();
      ok("兩輪重疊:abort 前那輪以 aborted 結束、只有新的那輪真的裝(pip 2 條)", rA !== "resolved" && rA.aborted === true && rB === "resolved" && pipCalls(ov).length === 2, { rA: rA && rA.message, rB: rB && rB.message, n: pipCalls(ov).length }); }
    // abort 之後還在途中的那一輪 ensure:不再起任何子行程;下一輪照常
    const g1 = rig();
    const p1 = g1.S.ensure().then(() => "resolved", (e) => e);
    const ab = await g1.S.abort(); const r1 = await p1;
    ok("abort 之後在途的 ensure 不再起子行程(venv / pip / 編譯都沒有)、以 aborted 結束、不送埋點", ab === false && r1 !== "resolved" && r1.aborted === true && g1.calls.length === 0 && g1.tracked.length === 0, { calls: g1.calls.length, r1: r1 && r1.message, tracked: g1.tracked });
    await g1.S.ensure(); await g1.settle();
    ok("…下一次 ensure(例:更新裝不起來、app 繼續跑)照常裝完並編譯", g1.S.snapshot().phase === "done" && pipCalls(g1).length === 2 && pycCalls(g1).length === 1);
    fs.unlinkSync(path.join(venvDir(g1), ".blave-pyc"));
    const p2 = g1.S.ensure(); await g1.S.abort(); await p2;
    ok("沒事可做、只差編譯的那一輪被 abort:不起 compileall", pycCalls(g1).length === 1 && !g1.S.compiling()); }

  // ── 稽核 enginefast P2-3:死在安裝階段(不是我們 abort 的)→ 下一次那一組 --force-reinstall --no-deps ──
  { const forceOf = (r) => path.join(venvDir(r), ".blave-deps-1.force");
    const INST = ["Downloading numpy-2.5.3-cp312-cp312-macosx_14_0_arm64.whl (5.4 MB)", "Progress 5445405 of 5445405", "Installing collected packages: numpy, pandas"];
    let bad = true;
    const f = rig({ behave: (bin, args) => (bad && args.includes(pin("pandas")) ? { code: 1, out: INST, err: "ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device" } : { code: 0 }) });
    try { await f.S.ensure(); } catch (_) { /* 預期 */ }
    ok("安裝階段失敗(非 abort):寫 .blave-deps-1.force", fs.existsSync(forceOf(f)));
    bad = false; await f.S.ensure();
    const last = pipCalls(f)[pipCalls(f).length - 1].args;
    ok("重試那一條:--force-reinstall --no-deps 只帶這一組的 pin(在 -c 之前)、裝完 .force 收掉", last.indexOf("--force-reinstall") >= 0 && last.indexOf("--no-deps") >= 0 && last.indexOf("--force-reinstall") < last.indexOf("-c")
      && batchOf({ args: last }).join(" ") === DEPS.join(" ") && !fs.existsSync(forceOf(f)) && f.S.snapshot().phase === "done", last);
    fs.unlinkSync(path.join(venvDir(f), ".blave-deps-1")); await f.settle(); await f.S.ensure();
    ok("…之後一般的重裝不再帶 --force-reinstall", !pipCalls(f)[pipCalls(f).length - 1].args.includes("--force-reinstall"));
    const d = rig({ behave: (bin, args) => (args.includes(pin("pandas")) ? { code: 1, out: INST.slice(0, 2), err: "ERROR: Exception:\nReadTimeoutError: HTTPSConnectionPool(host='files.pythonhosted.org', port=443): Read timed out." } : { code: 0 }) });
    try { await d.S.ensure(); } catch (_) { /* 預期 */ }
    ok("下載中斷(還沒進安裝階段,site-packages 沒被動):不寫 .force", !fs.existsSync(forceOf(d)));
    const a = rig({ behave: (bin, args) => (args.includes(pin("pandas")) ? { hang: true, out: INST } : { code: 0 }) });
    const pa = a.S.ensure().catch((e) => e);
    for (let k = 0; k < 2000 && !(a.S.busy() && a.S.snapshot().dl.installing); k++) await new Promise((x) => setTimeout(x, 2));
    await a.S.abort(); await pa;
    ok("安裝階段被我們 abort(關 app):照拍板不寫 .force", !fs.existsSync(forceOf(a)));
    // 複核 P2-5:一看到 Installing 那一行就寫(app 當掉也蓋得到),名字含間接相依;重試對那些名字 force
    const INST2 = ["Downloading numpy-2.5.3-cp312-cp312-macosx_14_0_arm64.whl (5.4 MB)", "Using cached pytz-2026.4-py2.py3-none-any.whl (509 kB)", "Downloading kiwisolver-1.5.1-cp312-cp312-macosx_11_0_arm64.whl (64 kB)",
      "Downloading pandas-3.0.6-cp312-cp312-macosx_11_0_arm64.whl (10.1 MB)", "Installing collected packages: pytz, kiwisolver, numpy, pandas"];
    const cr = rig({ behave: (bin, args) => (args.includes(pin("pandas")) ? { hang: true, out: INST2 } : { code: 0 }) });
    cr.S.ensure().catch(() => {});
    for (let k = 0; k < 2000 && !(cr.S.busy() && cr.S.snapshot().dl.installing); k++) await new Promise((x) => setTimeout(x, 2));
    const during = fs.existsSync(forceOf(cr)) ? fs.readFileSync(forceOf(cr), "utf8").split("\n") : null;
    ok("安裝階段一開始(還沒失敗、也還沒結束)就寫 .force,內容 = Installing 那一行的名字(含間接相依)、版本取自同條 pip 的 Downloading / Using cached 檔名",
      during && during.join() === "pytz==2026.4,kiwisolver==1.5.1,numpy==2.5.3,pandas==3.0.6", during);
    // 這時 app 當掉(不走 abort):下一次開 app 那一條帶 --force-reinstall --no-deps,裝這一組的 pin + 間接相依的名字
    const cr2 = rig({ base: cr.base }); await cr2.S.ensure(); await cr2.settle();
    const la = pipCalls(cr2)[pipCalls(cr2).length - 1].args, bt = batchOf({ args: la });
    ok("當掉之後重開:--force-reinstall --no-deps,這一組的 pin 全在、加上釘了版本的間接相依 pytz / kiwisolver(不重複 numpy / pandas)、成功後 .force 收掉",
      la.includes("--force-reinstall") && la.includes("--no-deps") && DEPS.every((x) => bt.includes(x)) && bt.includes("pytz==2026.4") && bt.includes("kiwisolver==1.5.1") && bt.length === DEPS.length + 2 && !fs.existsSync(forceOf(cr2)), bt);
    // 上一次真的半裝(.force 在)、這一次又被我們 abort:.force 回到上一次那份,不被這次 abort 抹掉
    fs.unlinkSync(path.join(venvDir(cr2), ".blave-deps-1")); fs.writeFileSync(forceOf(cr2), "kiwisolver==1.5.1");
    const ab2 = rig({ base: cr.base, behave: (bin, args) => (args.includes(pin("pandas")) ? { hang: true, out: ["Installing collected packages: six, numpy"] } : { code: 0 }) });
    const pab = ab2.S.ensure().catch((e) => e);
    for (let k = 0; k < 2000 && !(ab2.S.busy() && ab2.S.snapshot().dl.installing); k++) await new Promise((x) => setTimeout(x, 2));
    await ab2.S.abort(); await pab;
    ok("上一次半裝留下的 .force、這次被 abort:回到上一次那份(kiwisolver==1.5.1)", fs.existsSync(forceOf(ab2)) && fs.readFileSync(forceOf(ab2), "utf8") === "kiwisolver==1.5.1");
    // 複核 P2-8:取不到版本的那個不 force、記 log;沒釘版本的舊格式行不帶進重試
    const nv = rig({ behave: (bin, args) => (args.includes(pin("pandas")) ? { hang: true, out: ["Downloading numpy-2.5.3-cp312-cp312-macosx_14_0_arm64.whl (5.4 MB)", "Installing collected packages: six, numpy"] } : { code: 0 }) });
    nv.S.ensure().catch(() => {});
    for (let k = 0; k < 2000 && !(nv.S.busy() && nv.S.snapshot().dl.installing); k++) await new Promise((x) => setTimeout(x, 2));
    ok("Installing 那一行有名字但這條 pip 沒看到它的 wheel(six):不 force 它、記 log;看得到的(numpy)照釘", fs.readFileSync(forceOf(nv), "utf8") === "numpy==2.5.3" && nv.logs.some((l) => /no wheel version seen for six/.test(l)), nv.logs);
    fs.writeFileSync(forceOf(nv), "kiwisolver\nnumpy==2.5.3");
    const nv2 = rig({ base: nv.base }); await nv2.S.ensure(); await nv2.settle();
    const lb = batchOf({ args: pipCalls(nv2)[pipCalls(nv2).length - 1].args });
    ok("….force 裡沒釘版本的行(舊格式 kiwisolver)不帶進重試,只帶 name==version 的", !lb.includes("kiwisolver") && !lb.some((x) => /^kiwisolver/.test(x)) && lb.length === DEPS.length, lb); }
  // 複核 P2-9:SDK 那條也有半裝保護(.blave-sdk.force)
  { const sdkForce = (r) => path.join(venvDir(r), ".blave-sdk.force");
    const SINST = ["Downloading anyio-4.15.1-py3-none-any.whl (113 kB)", "Downloading claude_agent_sdk-0.2.159-py3-none-macosx_11_0_arm64.whl (93.1 MB)", "Using cached cryptography-48.0.1-cp39-abi3-macosx_10_9_universal2.whl (7.1 MB)",
      "Installing collected packages: anyio, cryptography, claude-agent-sdk"];
    const sc = rig({ behave: (bin, args) => (args.includes("pip") && args.includes(SDKP[0]) ? { hang: true, out: SINST } : { code: 0 }) });
    sc.S.ensure().catch(() => {});
    for (let k = 0; k < 2000 && !(sc.S.busy() && sc.S.snapshot().dl.installing); k++) await new Promise((x) => setTimeout(x, 2));
    const sd = fs.existsSync(sdkForce(sc)) ? fs.readFileSync(sdkForce(sc), "utf8") : null;
    ok("SDK 那條進了安裝階段就寫 .blave-sdk.force(名字釘版本)", sd === "anyio==4.15.1\ncryptography==48.0.1\nclaude-agent-sdk==0.2.159", sd);
    const sc2 = rig({ base: sc.base }); await sc2.S.ensure(); await sc2.settle();
    const sa = pipCalls(sc2)[0].args, sb = batchOf({ args: sa });
    ok("SDK 那條當掉之後重開:--force-reinstall --no-deps、SDK_PINS 照帶、加上 anyio==4.15.1(SDK 與 cryptography 不重複)、成功後 .force 收掉",
      sa.includes("--force-reinstall") && sa.includes("--no-deps") && sa.indexOf("--force-reinstall") < sa.indexOf("-c") && SDKP.every((x) => sb.includes(x)) && sb.includes("anyio==4.15.1") && sb.length === SDKP.length + 1 && !fs.existsSync(sdkForce(sc2)), sb);
    const sabt = rig({ behave: (bin, args) => (args.includes("pip") && args.includes(SDKP[0]) ? { hang: true, out: SINST } : { code: 0 }) });
    const psab = sabt.S.ensure().catch((e) => e);
    for (let k = 0; k < 2000 && !(sabt.S.busy() && sabt.S.snapshot().dl.installing); k++) await new Promise((x) => setTimeout(x, 2));
    await sabt.S.abort(); await psab;
    ok("SDK 那條在安裝階段被我們 abort:不留 .blave-sdk.force", !fs.existsSync(sdkForce(sabt))); }
  // 複核 P2-7:查建立時間是非同步的(不卡主行程)
  { const SRC = fs.readFileSync(path.join(SHELL, "enginesetup.js"), "utf8");
    const pr = E.procStartOf(process.pid), t = await pr, bad = await E.procStartOf(-1);
    ok("procStartOf 回 Promise、對自己這支查得到(與現在差 1 天內)、壞 pid 回 null;原始碼沒有 execFileSync", pr && typeof pr.then === "function" && t != null && Math.abs(Date.now() - t) < 86400e3 && bad === null && !/execFileSync/.test(SRC), { t }); }

  // 開發版量冷快取:pip 帶 --isolated 不吃 PIP_CACHE_DIR,改由 BLAVE_PIP_CACHE_DIR 給 --cache-dir;沒給就不帶(用 pip 預設快取),打包版不認
  { const cd = rig({ pipCacheDir: "/tmp/blave-pipcache" }); await cd.S.ensure(); await cd.settle();
    const plain = rig(); await plain.S.ensure(); await plain.settle();
    ok("pipCacheDir:有給時每一條 pip 都帶 --cache-dir <它>(在 -c 之前);沒給時不帶", pipCalls(cd).every((c) => { const i = c.args.indexOf("--cache-dir"); return i > 0 && c.args[i + 1] === "/tmp/blave-pipcache" && i < c.args.indexOf("-c"); })
      && pipCalls(plain).every((c) => !c.args.includes("--cache-dir")) && batches(cd).join("|") === batches(plain).join("|"));
    ok("接線:main.js 只在開發版、絕對路徑時把 BLAVE_PIP_CACHE_DIR 交給 enginesetup;分段條的每組預估 MB(PKG_MB)也交進去",
      /pipCacheDir: !app\.isPackaged && path\.isAbsolute\(process\.env\.BLAVE_PIP_CACHE_DIR \|\| ""\) \? process\.env\.BLAVE_PIP_CACHE_DIR : null,/.test(MAIN_SRC)
      && /groupMB: PKG_MB,/.test(MAIN_SRC) && /const PKG_MB = \{ core: firstRunMB\(\) - 105, us: 13 \};/.test(MAIN_SRC)); }

  // 開發版:每次都重拷官方檔(改了 lib/ 重啟就生效)
  { let copies = 0; const d = rig(); await d.S.ensure();
    const S2 = E.createEngineSetup({ fs, path, spawn: () => { throw new Error("不該跑"); }, base: d.base, ws: d.ws, venvPy: d.venvPy, venvBin: "bin", win: false, basePython: () => "x", envPath: async () => "", pyEnv: {}, copyOfficial: () => { copies++; }, isPackaged: false,
      sdkPins: SDK, deps: DEPS, firstRunMB: 200, venvMs: 1, engineMs: 1, pkgMs: 1, onChange: () => {}, log: () => {} });
    await S2.ensure(); ok("開發版:沒事可做也重拷官方檔", copies === 1); }

  // ── 間接相依的鎖(稽核 2026-10-02 P2-4):只進 -c,不裝、不進記號檔;main.js 那份要跟現在的直接相依對得上 ──
  { const L = ["six==1.17.0", "urllib3==2.8.0"], k = rig({ lock: L }); await k.S.ensure();
    const pf = path.join(venvDir(k), ".blave-pins.txt");
    ok("lock:-c 那份 = 直接相依 + 鎖(SDK 那條叫起來時就在)", pipCalls(k)[0].pins === [...DEPS, ...L].join("\n") + "\n" && fs.readFileSync(pf, "utf8") === [...DEPS, ...L].join("\n") + "\n");
    ok("lock:鎖裡的不會被當成要裝的(pip 只裝 SDK 與清單)、記號檔照舊只有清單", pinsOf(k).join() === [...SDKP, ...DEPS].join() && !pipCalls(k).some((c) => L.some((l) => c.args.includes(l)))
      && fs.readFileSync(path.join(venvDir(k), ".blave-deps-1"), "utf8") === DEPS.join("\n"), pinsOf(k));
    // 更新:清單換了一個版本、SDK 也換了 → 補裝與 SDK 重裝的 -c 都不帶鎖(不把既有間接相依降回鎖定版)
    const u = rig({ base: k.base, lock: L, deps: [bump(DEPS[0]), ...DEPS.slice(1)], sdk: SDK2 }); await u.S.ensure();
    ok("lock:更新 / 補裝(既有 venv)不帶鎖,-c 只有直接相依", u.S.snapshot().kind === "update" && pipCalls(u).length >= 2
      && pipCalls(u).every((c) => c.pins === [bump(DEPS[0]), ...DEPS.slice(1)].join("\n") + "\n"), pipCalls(u).map((c) => c.pins)); }
  { const LOCK = vm.runInNewContext(lit(/const WORKSPACE_LOCK = (\[[\s\S]*?\]);/)), FOR = vm.runInNewContext(lit(/const WORKSPACE_LOCK_FOR = ("[^"]+");/));
    const nn = (p) => p.split("==")[0].toLowerCase().replace(/[-_.]+/g, "-"), direct = new Set([...MAIN_DEPS, ...SDK.split(" ")].map(nn));
    ok("WORKSPACE_LOCK_FOR 對得上現在的 SDK_PINS + WORKSPACE_DEPS(對不上 = 換了直接相依沒重解鎖:跑 node shell/tools/lock-deps.js 貼回 main.js)", FOR === E.lockKey(SDK, MAIN_DEPS), { FOR, now: E.lockKey(SDK, MAIN_DEPS) });
    ok("WORKSPACE_LOCK:每行都是 名字==版本、不重複、不含直接相依(那些已經在清單裡)", LOCK.length >= 30 && LOCK.every((l) => /^[a-z0-9][a-z0-9._-]*==[0-9][0-9A-Za-z.+!-]*$/.test(l)) && new Set(LOCK.map(nn)).size === LOCK.length && !LOCK.some((l) => direct.has(nn(l))), LOCK.filter((l) => direct.has(nn(l))));
    ok("lockKey:SDK 或清單任一個換了就不一樣", E.lockKey(SDK, MAIN_DEPS) !== E.lockKey(SDK2, MAIN_DEPS) && E.lockKey(SDK, MAIN_DEPS) !== E.lockKey(SDK, [bump(MAIN_DEPS[0]), ...MAIN_DEPS.slice(1)]) && E.lockKey(SDK, MAIN_DEPS) === E.lockKey(SDK, [...MAIN_DEPS]));
    ok("接線:main.js 只在 WORKSPACE_LOCK_FOR 對得上時才帶鎖,對不上帶空的", /lock: WORKSPACE_LOCK_FOR === require\("\.\/enginesetup"\)\.lockKey\(SDK_PINS, WORKSPACE_DEPS\) \? WORKSPACE_LOCK : \[\],/.test(MAIN_SRC)); }

  // ── 舊 pip(21.2.4 實測)不認 --progress-bar=raw:解析參數就 exit 2、沒裝東西 → 拿掉旗標重跑同一條,之後每條都不帶 ──
  { const OLD = "Usage:\n  python -m pip install [options] <requirement specifier> ...\n\noption --progress-bar: invalid choice: 'raw' (choose from 'off', 'on', 'ascii', 'pretty', 'emoji')\n";
    const k = rig({ behave: (bin, args) => (args.includes("--progress-bar=raw") ? { code: 2, err: OLD } : { code: 0 }) });
    let err = null; try { await k.S.ensure(); } catch (e) { err = e; }
    const pc = pipCalls(k), raw = pc.map((c) => c.args.includes("--progress-bar=raw"));
    ok("舊 pip:ensure 成功;第一條帶 raw 被拒後原樣重跑一次(不帶),之後那條一開始就不帶", err === null && k.S.snapshot().phase === "done" && raw.join() === "true,false,false"
      && batchOf(pc[0]).join(" ") === batchOf(pc[1]).join(" ") && k.logs.some((l) => /retrying without it/.test(l)), { err: err && err.message, raw });
    const n = rig({ behave: (bin, args) => (args.includes(pin("numpy")) ? { code: 1, err: "ERROR: No matching distribution found for numpy" } : { code: 0 }) });
    let e2 = null; try { await n.S.ensure(); } catch (e) { e2 = e; }
    ok("別的失敗不重跑、照舊報錯,旗標也不拿掉", e2 && pipCalls(n).length === 2 && pipCalls(n).every((c) => c.args.includes("--progress-bar=raw")), pipCalls(n).length); }

  for (const d of TMPS) fs.rmSync(d, { recursive: true, force: true });
  process.exit(red ? 1 : 0);
})();
process.on("beforeExit", () => { console.log("FAIL  非同步測試沒有跑到結尾"); process.exit(1); });
