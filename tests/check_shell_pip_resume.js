// 0.1.55 斷線從斷點接續(Wei 選 A):隨包 pip wheel 離線升級 venv 的 pip、PIP_INSTALL 帶 --resume-retries 20、舊 pip 不認就拿掉重跑。
//   ① 進度解析吃 pip 26.2.2 的實測輸出(本機 Range／不給 Range 兩種斷線伺服器各跑一次抄下來):接續不重算、從頭重下不重算
//   ② stderr 的斷線警告 → 快照 dl.resuming,畫面寫「網路不穩,自動接續下載」;位元組再往上走就收掉
//   ③ 旗標被拒(實測舊 pip 的「no such option: --resume-retries」):拿掉那一組重跑,之後都不帶;raw 與 resume 各自拿
//   ④ 升級:建完 venv 先 --no-index 裝隨包 wheel、寫記號檔、下次跳過;失敗照裝(留舊 pip);被硬停在中間 → 下次先 ensurepip 補回;wheel 不在 → 不升級
//   ⑤ 包:extraResources 收 vendor/pip-wheel、NOTICE 有 pip 的 MIT
// 跑法:node tests/check_shell_pip_resume.js
const fs = require("fs"), path = require("path"), os = require("os"), { EventEmitter } = require("events");
const SHELL = path.join(__dirname, "..", "shell");
const E = require(path.join(SHELL, "enginesetup.js"));
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + JSON.stringify(d).slice(0, 600))); if (!c) red++; };
const TMPS = []; const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "blave-pipres-")); TMPS.push(d); return d; };

// ── ① 實測輸出(pip 26.2.2;stdout 與 stderr 分開抄) ──
const RANGE_OUT = ["Looking in indexes: http://127.0.0.1:18731/simple/", "Collecting pip==26.2.2", "  Downloading pip-26.2.2-py3-none-any.whl (1.8 MB)", "Progress 0 of 1819850", "Progress 262144 of 1819850",
  "  Resuming download pip-26.2.2-py3-none-any.whl (716 kB/1.8 MB)", "Progress 716800 of 1819850", "Progress 978944 of 1819850", "Progress 1819850 of 1819850", "Saved /x/pip-26.2.2-py3-none-any.whl"];
const NORANGE_OUT = ["Collecting pip==26.2.2", "  Downloading pip-26.2.2-py3-none-any.whl (1.8 MB)", "Progress 0 of 1819850", "Progress 262144 of 1819850",
  "  Downloading pip-26.2.2-py3-none-any.whl (1.8 MB)", "Progress 0 of 1819850", "Progress 262144 of 1819850", "Progress 1819850 of 1819850"];
const ERR = ["  WARNING: Connection interrupted while downloading.", "  WARNING: Attempting to resume incomplete download (716 kB/1.8 MB, attempt 1)"];
// pip 26 主檔那一行沒有縮排、metadata 那一行有(實測 pyarrow 25.0.1)
const PIP26 = ["Collecting pyarrow==25.0.1", "  Downloading pyarrow-25.0.1-cp312-cp312-macosx_12_0_arm64.whl.metadata (3.0 kB)", "Downloading pyarrow-25.0.1-cp312-cp312-macosx_12_0_arm64.whl (35.9 MB)", "Progress 0 of 35861559", "Progress 35861559 of 35861559", "Installing collected packages: pyarrow"];
const feed = (lines, p = { done: 0, file: null, installing: false, lastByteAt: 0 }) => { lines.forEach((l, i) => E.pipLine(p, l, i + 1)); return p; };
{ const p = feed(RANGE_OUT.slice(0, 5));
  const before = JSON.stringify(p.file);
  E.pipLine(p, RANGE_OUT[5], 9);
  ok("接續那一行:同一個檔、不結算、bytes 不歸零", JSON.stringify(p.file) === before && p.done === 0 && p.file.bytes === 262144, p);
  feed(RANGE_OUT.slice(6), p); E.pipLine(p, "Installing collected packages: pip", 99);
  ok("Range 接續:Progress 從斷點的絕對位元組數接著走,結算時已下載量 = 檔案大小一次(不重算)", p.done === 1819850 && p.file === null, p); }
{ const p = feed(NORANGE_OUT); E.pipLine(p, "Installing collected packages: pip", 99);
  ok("不給 Range、pip 從頭重下(同一個檔又 Downloading 一次):前一段不算,已下載量 = 檔案大小一次", p.done === 1819850, p); }
{ const p = feed(["  Downloading a-1.0-py3-none-any.whl (1.0 MB)", "Progress 1000000 of 1000000", "  Downloading b-1.0-py3-none-any.whl (2.0 MB)", "Progress 2000000 of 2000000", "Installing collected packages: a, b"]);
  ok("不同檔照舊逐個結算(沒有被同檔判斷吃掉)", p.done === 3000000, p); }
{ const p = feed(PIP26);
  ok("pip 26 的輸出格式(主檔沒縮排、metadata 有縮排):照樣解析、metadata 不算", p.done === 35861559 && p.installing === true && E.pipCurName(PIP26[2]) === "pyarrow" && E.pipWheel(PIP26[2]).version === "25.0.1", p); }
// ── ② stderr 警告 → resuming ──
{ const p = feed(RANGE_OUT.slice(0, 5));
  const a = E.pipErrLine(p, ERR[0]), b = E.pipErrLine(p, ERR[1]);
  ok("斷線警告(實測兩行):第一行就設 resuming、第二行不重複通知", a === true && b === false && p.resuming === true);
  E.pipLine(p, RANGE_OUT[5], 10); const still = p.resuming; E.pipLine(p, RANGE_OUT[6], 11);
  ok("接續後位元組往上走才收掉 resuming", still === true && p.resuming === false);
  ok("沒有在下載的檔、或別的 stderr 行:不設", E.pipErrLine({ file: null }, ERR[0]) === false && E.pipErrLine(feed(RANGE_OUT.slice(0, 4)), "ERROR: boom") === false); }

// ── ③④ rig ──
function rig(o) {
  const base = o.base || tmpDir(), ws = path.join(base, "workspace"), venvPy = path.join(base, "venv", "bin", "python");
  const calls = [], snaps = [], logs = [];
  const spawn = (bin, args) => {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = 6000 + calls.length; c.kill = () => { c.aborted = true; setImmediate(() => c.emit("close", null)); };
    calls.push({ bin, args });
    const b = (o.behave && o.behave(args, calls.length, S)) || { code: 0 };
    setImmediate(() => {
      if (args.includes("venv")) { fs.mkdirSync(path.dirname(venvPy), { recursive: true }); fs.writeFileSync(venvPy, ""); }
      for (const l of b.out || []) c.stdout.emit("data", l + "\n");
      for (const l of b.errLines || []) c.stderr.emit("data", l + "\n");
      if (b.err) c.stderr.emit("data", b.err);
      if (b.hang) return;
      c.emit("close", b.code === undefined ? 0 : b.code);
    });
    return c;
  };
  const S = E.createEngineSetup({ fs, path, spawn, base, ws, venvPy, venvBin: "bin", win: false, basePython: () => "/bundled/python3", envPath: async () => "/usr/bin",
    pyEnv: {}, copyOfficial: async () => { fs.mkdirSync(path.join(ws, "lib"), { recursive: true }); }, isPackaged: true, pipWheel: o.pipWheel,
    sdkPins: "claude-agent-sdk==1.0", deps: ["numpy==2.0"], optional: [], firstRunMB: 200, venvMs: 300000, engineMs: 600000, pkgMs: 600000,
    alive: () => false, setPriority: () => {}, netRetryMs: [], onChange: (s) => snaps.push(JSON.parse(JSON.stringify(s))), log: (m) => logs.push(m), track: () => {} });
  const isUp = (c) => c.args.includes("--no-index"), isInstall = (c) => c.args.includes("pip") && !isUp(c);
  return { S, base, calls, snaps, logs, ups: () => calls.filter(isUp), installs: () => calls.filter(isInstall), venvDir: path.join(base, "venv") };
}
const WHL_DIR = tmpDir(), WHL = path.join(WHL_DIR, "pip-26.2.2-py3-none-any.whl"); fs.writeFileSync(WHL, "fake wheel");
(async () => {
  { const r = rig({ behave: (args, n) => (args.includes("--resume-retries") && !args.includes("--no-index") ? { code: 2, err: "\nUsage:   \n  python -m pip install [options] <requirement specifier> ...\n\nno such option: --resume-retries\n" } : { code: 0 }) });
    await r.S.ensure();
    const ins = r.installs();
    ok("旗標被拒(舊 pip 實測那一句):同一條拿掉 --resume-retries 與後面的 20 重跑、裝好", r.snaps[r.snaps.length - 1].phase === "done" && ins.length === 3 && ins[0].args.includes("--resume-retries") && !ins[1].args.includes("--resume-retries") && !ins[1].args.includes("20") && ins[1].args.includes("--retries"), ins.map((c) => c.args.length));
    ok("…之後的 pip 也不帶、只拿掉那一組(raw、--retries、--timeout 照帶)、記一行 log", !ins[2].args.includes("--resume-retries") && ins[2].args.includes("--progress-bar=raw") && ins[2].args.includes("--timeout") && r.logs.filter((l) => /has no --resume-retries; retrying without it/.test(l)).length === 1); }
  { let k = 0; const r = rig({ behave: (args) => { if (args.includes("--no-index") || args.includes("venv")) return { code: 0 }; k++; if (k === 1) return { code: 2, err: "error: --progress-bar: invalid choice: 'raw'" }; if (k === 2) return { code: 2, err: "no such option: --resume-retries" }; return { code: 0 }; } });
    await r.S.ensure(); const ins = r.installs();
    ok("兩個旗標都不認:各拿一次(raw 先、resume 後),第三次才裝", ins.length === 4 && ins[2].args.every((a) => a !== "--progress-bar=raw" && a !== "--resume-retries") && r.snaps[r.snaps.length - 1].phase === "done", ins.length); }
  { const r = rig({ behave: (args) => (args.includes("venv") ? { code: 0 } : { code: 1, err: "ERROR: no such option in a message that is not argv parsing: --resume-retries" }) });
    let err = null; try { await r.S.ensure(); } catch (e) { err = e; }
    ok("不是那一句(真的失敗):不拿旗標、照舊失敗", err && r.installs().length === 1); }
  // ④ 升級
  { const r = rig({ pipWheel: WHL });
    await r.S.ensure();
    const ups = r.ups(), firstPip = r.calls.findIndex((c) => c.args.includes("pip"));
    ok("建完 venv、第一條 pip 之前:用 venv 的 python --no-index 裝隨包 wheel(不碰網路)", ups.length === 1 && r.calls[firstPip] === ups[0] && ups[0].bin.endsWith(path.join("venv", "bin", "python"))
      && ups[0].args.join(" ") === ["-m", "pip", "--isolated", "--disable-pip-version-check", "install", "--no-index", "--no-deps", "--no-compile", WHL].join(" "), ups.map((c) => c.args));
    ok("升級成功:寫 .blave-pip、.run 收掉、記一行;之後的 pip 帶 --resume-retries 20", fs.readFileSync(path.join(r.venvDir, ".blave-pip"), "utf8") === path.basename(WHL) && !fs.existsSync(path.join(r.venvDir, ".blave-pip.run"))
      && r.logs.some((l) => /pip upgraded from the bundled pip-26\.2\.2/.test(l)) && r.installs().every((c) => c.args.join(" ").includes("--resume-retries 20")));
    // 下一次(新的 instance、同一個 venv、記號對得上):不再升級
    fs.unlinkSync(path.join(r.venvDir, ".blave-deps-1"));
    const r2 = rig({ base: r.base, pipWheel: WHL }); await r2.S.ensure();
    ok("記號檔對得上:下次不再升級", r2.ups().length === 0 && r2.installs().length === 1); }
  { const r = rig({ pipWheel: WHL, behave: (args) => (args.includes("--no-index") ? { code: 1, err: "ERROR: Could not install packages due to an OSError: [Errno 13] Permission denied" } : { code: 0 }) });
    await r.S.ensure();
    ok("升級失敗:不擋安裝(SDK 與套件照裝)、記一行、不寫記號、.run 收掉;這次啟動不再試", r.snaps[r.snaps.length - 1].phase === "done" && r.installs().length === 2 && r.ups().length === 1
      && r.logs.some((l) => /bundled pip upgrade failed; keeping the venv's pip/.test(l)) && !fs.existsSync(path.join(r.venvDir, ".blave-pip")) && !fs.existsSync(path.join(r.venvDir, ".blave-pip.run"))); }
  { // 升級中關 app(abort):.run 留著;下次先 ensurepip 補回 pip 再升級
    const r = rig({ pipWheel: WHL, behave: (args, n, S) => (args.includes("--no-index") ? (setImmediate(() => S.abort()), { hang: true }) : { code: 0 }) });
    let err = null; try { await r.S.ensure(); } catch (e) { err = e; }
    ok("升級中被收掉:這一輪當成我們自己停的、.blave-pip.run 留著、沒寫記號", err && /app closing/.test(String(err.message)) && fs.existsSync(path.join(r.venvDir, ".blave-pip.run")) && !fs.existsSync(path.join(r.venvDir, ".blave-pip")) && r.installs().length === 0, String(err && err.message));
    const r2 = rig({ base: r.base, pipWheel: WHL }); await r2.S.ensure();
    const ep = r2.calls.findIndex((c) => c.args.join(" ") === "-m ensurepip --default-pip"), up = r2.calls.findIndex((c) => c.args.includes("--no-index"));
    ok("下次:先用 ensurepip(離線)補回 pip、再升級、再裝;.run 收掉", ep >= 0 && up > ep && r2.installs().length >= 1 && r2.calls.indexOf(r2.installs()[0]) > up && !fs.existsSync(path.join(r2.venvDir, ".blave-pip.run")) && fs.existsSync(path.join(r2.venvDir, ".blave-pip"))); }
  { const r = rig({ pipWheel: path.join(WHL_DIR, "pip-missing.whl") }); await r.S.ensure();
    ok("wheel 不在(開發版沒抓、包壞了):不升級、記一行、照裝", r.ups().length === 0 && r.installs().length === 2 && r.logs.some((l) => /bundled pip wheel not found/.test(l))); }
  { const r = rig({}); await r.S.ensure();
    ok("沒給 pipWheel:完全不升級(既有行為)", r.ups().length === 0 && !r.calls.some((c) => c.args.includes("ensurepip"))); }
  { // 整條:斷線 → resuming 進快照 → 接續 → 結算一次
    const r = rig({ behave: (args) => (args.includes("numpy==2.0") ? { code: 0, out: ["Collecting numpy==2.0", ...RANGE_OUT.slice(2, 5)], errLines: ERR } : { code: 0 }) });
    await r.S.ensure();
    ok("整條跑:stderr 的斷線警告讓快照帶 dl.resuming(畫面講自動接續)", r.snaps.some((s) => s.dl && s.dl.resuming === true && s.dl.file)); }
  // ⑤ 畫面、字串、包
  { const es = fs.readFileSync(path.join(SHELL, "renderer", "engine.js"), "utf8");
    const engView = new Function(es.slice(es.indexOf("const ENG_STALL_MS"), es.indexOf("/* 完成後留下的那一行 */")) + "\nreturn engView;")();
    const tr = { t: (k, v) => k + (v ? JSON.stringify(v) : ""), dur: (s) => s + "s" };
    const snap = (dl) => ({ show: true, phase: "run", kind: "first", sizeMB: 200, acc: 0, t0: 0, steps: [{ k: "pkgs", st: "run", ms: 0, t0: 0 }], dl, cur: { step: "pkgs", name: "pyarrow", t0: 0, limitMs: 600000 } });
    const file = { name: "pyarrow.whl", bytes: 10e6, total: 35.9e6 };
    const v1 = engView(snap({ done: 0, file, lastByteAt: 0, resuming: true }), 60000, tr, false), v2 = engView(snap({ done: 0, file, lastByteAt: 0, resuming: false }), 60000, tr, false);
    ok("畫面:接續中那一格寫「網路不穩,自動接續下載」(蓋過「沒有收到資料」);MB／總 MB 那一列照舊", v1.slot && v1.slot.text === "eng.resume" && v1.rows[0].meta && /eng\.bytes/.test(v1.rows[0].meta.left) && (!v2.slot || v2.slot.text !== "eng.resume"), [v1.slot, v2.slot]);
    const po = (f) => fs.readFileSync(path.join(SHELL, "i18n", f), "utf8");
    ok("字串兩語都有", /msgid "eng\.resume"\nmsgstr "網路不穩，自動接續下載。"/.test(po("zh.po")) && /msgid "eng\.resume"\nmsgstr "[^"]+"/.test(po("en.po")) && fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8").includes("eng.resume")); }
  { const cfg = fs.readFileSync(path.join(SHELL, "electron-builder.config.js"), "utf8"), notice = fs.readFileSync(path.join(__dirname, "..", "NOTICE"), "utf8");
    const main = fs.readFileSync(path.join(SHELL, "main.js"), "utf8"), fp = fs.readFileSync(path.join(SHELL, "tools", "fetch-python.sh"), "utf8");
    ok("包:共用 extraResources 收 vendor/pip-wheel(三個平台都帶;Python 讀不到 asar 裡的檔,不能放 files)", /extraResources: \[\n    \{ from: "\.\.", to: "agent", filter: tracked \},\n[^\]]*\{ from: "vendor\/pip-wheel", to: "pip-wheel", filter: \["pip-\*\.whl"\] \}/.test(cfg));
    ok("fetch-python.sh 釘 pip ≥ 25.2 的 wheel 與 sha256、抓完驗;main.js 交給 enginesetup", /PIP_WHL="pip-(\d+)\.(\d+)[^"]*"/.test(fp) && (() => { const [, a, b] = /PIP_WHL="pip-(\d+)\.(\d+)/.exec(fp); return +a > 25 || (+a === 25 && +b >= 2); })()
      && /PIP_SHA256="[0-9a-f]{64}"/.test(fp) && /\[ "\$GOT" != "\$PIP_SHA256" \]/.test(fp) && /^fetch_pip$/m.test(fp) && /pipWheel: PIP_WHEEL,/.test(main));
    ok("NOTICE 寫了 pip 的 MIT 授權與著作權人", /pip wheel[\s\S]*MIT License, Copyright \(c\) 2008-present The pip\s+developers/.test(notice)); }
  for (const d of TMPS) fs.rmSync(d, { recursive: true, force: true });
  console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  例外 " + (e && e.stack)); process.exit(1); });
