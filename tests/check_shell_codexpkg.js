// shell/codexpkg.js(Codex 引擎隨包;spec codex-bundled-engine-2026-10-31 §4.1/§4.6)與 fetchbuf.js 的 fetchToFile、enginesetup.js 的 waitPidLock。
// 全部走注入:假的 fs(記憶體)、假的 fetch、假的 spawn、假的 sleep。不連網、不下載也不執行任何 codex。
// 跑法:node tests/check_shell_codexpkg.js
const path = require("path"), crypto = require("crypto"), { EventEmitter } = require("events"), { PassThrough } = require("stream");
const C = require("../shell/codexpkg");
const { waitPidLock } = require("../shell/enginesetup");
let red = 0; const t = (n, ok, info) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || info === undefined ? "" : "  " + JSON.stringify(info))); if (!ok) red++; };

// ── 純函式 ──
t("tripleOf:Mac arm64／x64、Windows x64 各一個 triple;Windows arm64、Linux 不做(null)",
  C.tripleOf("darwin", "arm64") === "aarch64-apple-darwin" && C.tripleOf("darwin", "x64") === "x86_64-apple-darwin" && C.tripleOf("win32", "x64") === "x86_64-pc-windows-msvc"
  && C.tripleOf("win32", "arm64") === null && C.tripleOf("linux", "x64") === null);
t("PKG_MB 三個平台 166／180／203", JSON.stringify(C.PKG_MB) === '{"aarch64-apple-darwin":166,"x86_64-apple-darwin":180,"x86_64-pc-windows-msvc":203}');
{ const u = C.assetUrls("0.166.0", "aarch64-apple-darwin");
  t("assetUrls:GitHub release rust-v<版> 底下的套件與 codex-package_SHA256SUMS", u.pkg === "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-aarch64-apple-darwin.tar.gz"
    && u.sums === "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package_SHA256SUMS"); }
const H = "a".repeat(64), H2 = "B".repeat(64);
const SUMS = `${"0".repeat(64)}  codex-package-x86_64-pc-windows-msvc.tar.gz\n${H}  codex-package-aarch64-apple-darwin.tar.gz\n${H2} *codex-package-x86_64-apple-darwin.tar.gz\r\n`;
t("pickSum:有那一行 → 那行的 sha256(小寫;兩個空白或 * 都收)", C.pickSum(SUMS, "codex-package-aarch64-apple-darwin.tar.gz") === H && C.pickSum(SUMS, "codex-package-x86_64-apple-darwin.tar.gz") === H2.toLowerCase());
t("pickSum:沒那一行 → null;同名前綴不算(…darwin.tar.gz.sig)", C.pickSum(SUMS, "codex-package-aarch64-pc-windows-msvc.tar.gz") === null && C.pickSum(H + "  codex-package-aarch64-apple-darwin.tar.gz.sig", "codex-package-aarch64-apple-darwin.tar.gz") === null);
t("pickSum:格式錯(63 個 hex、非 hex、空)→ null", C.pickSum("a".repeat(63) + "  x.tar.gz", "x.tar.gz") === null && C.pickSum("z".repeat(64) + "  x.tar.gz", "x.tar.gz") === null && C.pickSum("", "x") === null && C.pickSum(null, "x") === null);
t("pkgDir／binOf:<BASE>/codex/<版>/bin/codex(Windows codex.exe、path.win32)", C.pkgDir("/b", "0.166.0", false) === "/b/codex/0.166.0" && C.binOf("/b/codex/0.166.0", false) === "/b/codex/0.166.0/bin/codex"
  && C.binOf(C.pkgDir("C:\\Users\\u\\Blave", "0.166.0", true), true) === "C:\\Users\\u\\Blave\\codex\\0.166.0\\bin\\codex.exe");

// 記憶體 fs:檔案與資料夾放在一張表,只做 codexpkg 會用到的那幾支
function memFs(win) {
  const P = win ? path.win32 : path.posix, files = new Map(), dirs = new Set(), log = [];
  const parent = (p) => P.dirname(p);
  const mkdirp = (d) => { while (d && !dirs.has(d)) { dirs.add(d); const u = parent(d); if (u === d) break; d = u; } };
  const err = (code) => Object.assign(new Error(code), { code });
  const fx = {
    files, dirs, log, hooks: {},
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => { if (!files.has(p)) throw err("ENOENT"); return files.get(p); },
    writeFileSync: (p, d, opt) => { const wx = opt && opt.flag === "wx"; if (wx) log.push("wx " + p); if (wx && fx.hooks.wx) fx.hooks.wx(p);
      if (wx && files.has(p)) throw err("EEXIST"); mkdirp(parent(p)); files.set(p, String(d)); },
    unlinkSync: (p) => { if (!files.delete(p)) throw err("ENOENT"); },
    mkdirSync: (p) => { mkdirp(p); },
    readdirSync: (p) => { if (!dirs.has(p)) throw err("ENOENT"); const out = new Set(); for (const x of [...files.keys(), ...dirs]) if (parent(x) === p && x !== p) out.add(P.basename(x)); return [...out]; },
    rmSync: (p) => { if (fx.hooks.rm) fx.hooks.rm(p); log.push("rm " + p); for (const k of [...files.keys()]) if (k === p || k.startsWith(p + P.sep)) files.delete(k); for (const k of [...dirs]) if (k === p || k.startsWith(p + P.sep)) dirs.delete(k); },
    renameSync: (a, b) => { if (fx.hooks.rename) fx.hooks.rename(a, b); log.push("rename " + a + " -> " + b);
      for (const k of [...files.keys()]) if (k === a || k.startsWith(a + P.sep)) { files.set(b + k.slice(a.length), files.get(k)); files.delete(k); }
      for (const k of [...dirs]) if (k === a || k.startsWith(a + P.sep)) { dirs.add(b + k.slice(a.length)); dirs.delete(k); } },
    statfsSync: () => fx.hooks.statfs ? fx.hooks.statfs() : { bavail: 1e7, bsize: 4096 },
  };
  return fx;
}
const T = "aarch64-apple-darwin";
const putPkg = (fx, dir, ver, over = {}, win = false) => {
  const P = win ? path.win32 : path.posix;
  fx.writeFileSync(P.join(dir, "bin", win ? "codex.exe" : "codex"), "bin");
  fx.writeFileSync(P.join(dir, "codex-package.json"), JSON.stringify({ version: ver, target: T, variant: "codex", entrypoint: "bin/codex", ...over }));
  fx.mkdirSync(P.join(dir, "codex-path"));
};
{ const fx = memFs(false);
  putPkg(fx, "/b/codex/0.166.0", "0.166.0");
  t("pkgOk:執行檔在、json 版本／variant／target 都對 → 執行檔路徑", C.pkgOk("/b/codex/0.166.0", "0.166.0", T, false, fx) === "/b/codex/0.166.0/bin/codex");
  t("pkgOk:版本不符／variant 不對／target 不對／json 壞掉／執行檔不在 → null", C.pkgOk("/b/codex/0.166.0", "0.165.0", T, false, fx) === null
    && (() => { const f = memFs(false); putPkg(f, "/d", "1.0.0", { variant: "codex-alpha" }); return C.pkgOk("/d", "1.0.0", T, false, f) === null; })()
    && (() => { const f = memFs(false); putPkg(f, "/d", "1.0.0", { target: "x86_64-apple-darwin" }); return C.pkgOk("/d", "1.0.0", T, false, f) === null; })()
    && (() => { const f = memFs(false); putPkg(f, "/d", "1.0.0"); f.writeFileSync("/d/codex-package.json", "{"); return C.pkgOk("/d", "1.0.0", T, false, f) === null; })()
    && (() => { const f = memFs(false); putPkg(f, "/d", "1.0.0"); f.unlinkSync("/d/bin/codex"); return C.pkgOk("/d", "1.0.0", T, false, f) === null; })());
  let rd = 0; const fy = { ...fx, readdirSync: (p) => { rd++; return fx.readdirSync(p); } };
  const a = C.installed("/b", "0.166.0", T, false, fy);
  t("installed:釘版在 → 釘版、pinned:true,不列目錄", a && a.path === "/b/codex/0.166.0/bin/codex" && a.version === "0.166.0" && a.pinned === true && rd === 0, a);
  const f2 = memFs(false); putPkg(f2, "/b/codex/0.164.0", "0.164.0"); putPkg(f2, "/b/codex/0.165.0", "0.165.0"); putPkg(f2, "/b/codex/0.99.0", "0.99.0"); f2.mkdirSync("/b/codex/.staging-0.166.0"); f2.mkdirSync("/b/codex/junk");
  const b = C.installed("/b", "0.166.0", T, false, f2);
  t("installed:釘版不在、有 0.165.0／0.164.0／0.99.0 → 0.165.0(逐段比數字)、pinned:false", b && b.version === "0.165.0" && b.pinned === false && b.path === "/b/codex/0.165.0/bin/codex", b);
  const f3 = memFs(false); putPkg(f3, "/b/codex/0.165.0", "0.164.0"); putPkg(f3, "/b/codex/0.166.0", "0.166.0", { target: "x86_64-pc-windows-msvc" });
  t("installed:資料夾名跟 json 版本不符、釘版 target 不對 → null;codex 資料夾不在 → null", C.installed("/b", "0.166.0", T, false, f3) === null && C.installed("/b", "0.166.0", T, false, memFs(false)) === null); }
{ const ex = (set) => ({ existsSync: (p) => set.includes(p) });
  t("tarBin:Mac /usr/bin/tar;Windows %SystemRoot%\\System32\\tar.exe(缺 SystemRoot 用 C:\\Windows)", C.tarBin("darwin", {}) === "/usr/bin/tar" && C.tarBin("win32", { SystemRoot: "D:\\WinNT" }) === "D:\\WinNT\\System32\\tar.exe" && C.tarBin("win32", {}) === "C:\\Windows\\System32\\tar.exe");
  t("unsupported:arch(Windows arm64)/ tar(Windows 太舊、沒有 tar.exe)/ null", C.unsupported("win32", "arm64", {}, ex([])) === "arch" && C.unsupported("win32", "x64", { SystemRoot: "C:\\W" }, ex([])) === "tar"
    && C.unsupported("win32", "x64", { SystemRoot: "C:\\W" }, ex(["C:\\W\\System32\\tar.exe"])) === null && C.unsupported("darwin", "arm64", {}, ex(["/usr/bin/tar"])) === null); }

// ── ensure:假 fetch／spawn／sleep ──
const PKG_BYTES = Buffer.from("fake tarball bytes"), PKG_SHA = crypto.createHash("sha256").update(PKG_BYTES).digest("hex");
function rig(o = {}) {
  const fx = o.fx || memFs(false), calls = [], tracked = [], snaps = [], sleeps = [];
  const sums = o.sums !== undefined ? o.sums : `${PKG_SHA}  codex-package-${T}.tar.gz\n`;
  const P = path.posix;
  const spawn = (bin, args, sopt) => {
    calls.push([bin, ...args].join(" ") + (sopt && sopt.cwd ? " @" + sopt.cwd : ""));
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => { c.killed = true; setImmediate(() => c.emit("close", null)); };
    if (o.spawnThrow) throw Object.assign(new Error("x"), { code: "ENOENT" });
    setImmediate(() => {
      if (bin === "/usr/bin/tar") {
        if (o.tarHang) return;
        if (o.tarCode) { if (o.tarErr) c.stderr.emit("data", o.tarErr); c.emit("close", o.tarCode); return; }
        const staging = sopt.cwd;
        if (!o.tarNoLayout) putPkg(fx, staging, o.layoutVer || "0.166.0");
        c.emit("close", 0); return;
      }
      if (args[0] === "--version" && (o.versionHang && o.versionHang())) return;   // 防毒還在掃:不回,等 spawnWait 的上限殺掉
      if (args[0] === "--version") { c.stdout.emit("data", o.versionOut !== undefined ? o.versionOut : "codex-cli 0.166.0\n"); c.emit("close", o.versionCode || 0); return; }
      c.emit("close", 9);
    });
    return c;
  };
  const S = C.createCodexPkg({
    fs: fx, spawn, base: "/b", pin: "0.166.0", triple: T, win: false, platform: "darwin", env: {}, unsupported: o.unsupported || null,
    fetchBuffer: async (url, max, opts) => { calls.push("fetchBuffer " + url + " max=" + max + " host=" + opts.host.join(",")); if (o.sumsErr) throw o.sumsErr; return Buffer.from(sums); },
    fetchToFile: async (url, file, opts) => {
      calls.push("fetchToFile " + url + " -> " + file + " max=" + opts.max + " idle=" + opts.idleMs + " host=" + opts.host.join(","));
      if (o.dlErr) throw o.dlErr;
      if (o.dlHook) await o.dlHook(opts);
      fx.writeFileSync(file, PKG_BYTES); opts.onBytes(PKG_BYTES.length, PKG_BYTES.length);
      return { sha256: o.badSha ? "0".repeat(64) : PKG_SHA, bytes: PKG_BYTES.length, totalMs: opts.totalMs(null) };
    },
    now: () => (o.clock ? o.clock.t : 0), sleep: async (ms) => { sleeps.push(ms); if (o.clock) o.clock.t += ms; if (o.onSleep) o.onSleep(); },
    alive: o.alive || (() => false), procStart: o.procStart || (async () => null), lockWaitMs: o.lockWaitMs, versionMs: o.versionMs,
    log: () => {}, track: (ev, p) => tracked.push(ev + ":" + (p.name || p.result)), onChange: (s) => snaps.push(s),
  });
  return { fx, S, calls, tracked, snaps, sleeps };
}
const stagingLeft = (fx) => [...fx.dirs, ...fx.files.keys()].some((k) => k.includes(".staging-"));
(async () => {
  { const r = rig(); putPkg(r.fx, "/b/codex/0.165.0", "0.165.0"); r.fx.mkdirSync("/b/codex/.staging-0.160.0");
    const out = await r.S.ensure();
    const order = r.calls.map((c) => c.split(" ")[0]);
    t("ensure 成功:校驗檔 → 套件 → tar → --version,回 {ok, path}", out.ok === true && out.path === "/b/codex/0.166.0/bin/codex" && JSON.stringify(order) === '["fetchBuffer","fetchToFile","/usr/bin/tar","/b/codex/.staging-0.166.0/bin/codex"]', { out, calls: r.calls });
    t("…校驗檔上限 64 KB、套件上限 400 MB、閒置 120 秒,兩條都鎖 github.com／githubusercontent.com", r.calls[0].endsWith("max=65536 host=github.com,githubusercontent.com") && r.calls[1].endsWith("max=419430400 idle=120000 host=github.com,githubusercontent.com"), r.calls.slice(0, 2));
    t("…tar 在 staging 裡跑、只帶相對路徑 -xzf pkg.tar.gz -C .(Windows 使用者名稱含非 ASCII 時不進 argv;沒有 -P)", r.calls[2] === "/usr/bin/tar -xzf pkg.tar.gz -C . @/b/codex/.staging-0.166.0" && !/ -P\b/.test(r.calls[2]), r.calls[2]);
    t("…鎖用 wx 建檔(互斥)", r.fx.log.includes("wx /b/codex/.lock"), r.fx.log.filter((l) => l.startsWith("wx")));
    t("…上架:先刪舊的釘版資料夾再 rename staging → pkgDir;舊版 0.165.0 沒刪(交 sweep)", r.fx.log.includes("rm /b/codex/0.166.0") && r.fx.log.includes("rename /b/codex/.staging-0.166.0 -> /b/codex/0.166.0")
      && r.fx.log.indexOf("rm /b/codex/0.166.0") < r.fx.log.indexOf("rename /b/codex/.staging-0.166.0 -> /b/codex/0.166.0") && r.fx.existsSync("/b/codex/0.165.0/bin/codex") && !r.fx.log.some((l) => l === "rm /b/codex/0.165.0"), r.fx.log);
    t("…先清殘留的 .staging-*(已持鎖);tarball 解完就刪;鎖放掉", r.fx.log.includes("rm /b/codex/.staging-0.160.0") && !r.fx.existsSync("/b/codex/0.166.0/pkg.tar.gz") && !r.fx.existsSync("/b/codex/.lock"), r.fx.log);
    t("…送 feature_used:codex_pkg_done;快照走過 download → extract → verify → idle、fail 仍 null", r.tracked.join() === "feature_used:codex_pkg_done"
      && ["download", "extract", "verify"].every((p) => r.snaps.some((s) => s.phase === p)) && r.S.snapshot().phase === "idle" && r.S.snapshot().fail === null, { tracked: r.tracked, phases: r.snaps.map((s) => s.phase) });
    const again = await r.S.ensure();
    t("…裝好之後再 ensure:不下載,直接回路徑", again.ok && r.calls.length === 4); }
  const failCase = async (name, o, kind) => {
    const r = rig(o), out = await r.S.ensure();
    t("失敗 " + name + " → kind=" + kind + "、staging 清掉、fail 寫進快照、送 engine_opt_fail:codex_" + kind + "、鎖放掉",
      out.ok === false && out.kind === kind && !out.aborted && !stagingLeft(r.fx) && r.S.snapshot().fail && r.S.snapshot().fail.kind === kind && r.S.snapshot().phase === "idle"
      && r.tracked.join() === "engine_opt_fail:codex_" + kind && !r.fx.existsSync("/b/codex/.lock"), { out, snap: r.S.snapshot(), tracked: r.tracked });
    return r;
  };
  await failCase("校驗檔 404(CODEX_VERSION 指到不存在的版本)→ 不算網路", { sumsErr: new Error("HTTP_404") }, "http");
  await failCase("套件 403", { dlErr: new Error("HTTP_403") }, "http");
  await failCase("校驗檔 503(GitHub 暫時掛了)", { sumsErr: new Error("HTTP_503") }, "net");
  await failCase("套件下載斷線", { dlErr: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }, "net");
  await failCase("sha256 對不上", { badSha: true }, "checksum");
  await failCase("校驗檔沒有這個平台那一行", { sums: `${PKG_SHA}  codex-package-x86_64-apple-darwin.tar.gz\n` }, "checksum");
  await failCase("tar 非 0", { tarCode: 1, tarErr: "tar: Error opening archive: Unrecognized archive format\n" }, "other");
  await failCase("tar 非 0、stderr 說磁碟滿了", { tarCode: 1, tarErr: "tar: bin/codex: Write failed: No space left on device\n" }, "disk");
  await failCase("解出來的佈局不對", { tarNoLayout: true }, "other");
  await failCase("--version 非 0", { versionCode: 1 }, "other");
  { // P2-1:--version 逾時(Windows Defender 第一次掃新 codex.exe)跟答錯分開
    let hang = true; const r = rig({ versionMs: 30, versionHang: () => hang }), out = await r.S.ensure();
    t("--version 逾時 → other、失敗寫進快照,但解好的 staging 留著(帶 .extracted 記號、tarball 已刪)", out.ok === false && out.kind === "other" && r.S.snapshot().fail.kind === "other"
      && r.fx.existsSync("/b/codex/.staging-0.166.0/bin/codex") && r.fx.existsSync("/b/codex/.staging-0.166.0/.extracted") && !r.fx.existsSync("/b/codex/.staging-0.166.0/pkg.tar.gz"), { out, files: [...r.fx.files.keys()] });
    hang = false; const n0 = r.calls.length, again = await r.S.ensure(), more = r.calls.slice(n0);
    t("…〔再試一次〕不重新下載(沒有 fetchBuffer／fetchToFile／tar),只再跑一次 --version 就上架;記號沒帶進 pkgDir", again.ok === true && more.length === 1 && /--version/.test(more[0]) && !r.fx.existsSync("/b/codex/0.166.0/.extracted") && !r.fx.existsSync("/b/codex/.staging-0.166.0"), { again, more });
    const r2 = rig({ versionMs: 30, versionHang: () => true }); await r2.S.ensure();
    const gone = C.sweep("/b", ["0.166.0"], { fs: r2.fx, win: false, alive: () => false });
    t("…開 app 的 sweep 不刪這包等再驗的 staging", gone.length === 0 && r2.fx.existsSync("/b/codex/.staging-0.166.0/.extracted"), gone);
    const r3 = rig({ versionOut: "codex-cli 0.165.0" }); await r3.S.ensure();
    t("…版號不對 → staging 整包刪掉(下次重抓)", !stagingLeft(r3.fx)); }
  { const fx = memFs(false); const r = rig({ fx, versionMs: 30, versionHang: () => true }); await r.S.ensure();
    const r2 = rig({ fx }), out = await r2.S.ensure({ reinstall: true });
    t("…reinstall 不吃留下來的 staging,照樣重抓", out.ok === true && r2.calls.some((c) => c.startsWith("fetchToFile"))); }
  await failCase("--version 輸出沒有版號", { versionOut: "codex-cli 0.165.0" }, "other");
  await failCase("下載寫檔 ENOSPC", { dlErr: Object.assign(new Error("no space"), { code: "ENOSPC" }) }, "disk");
  { const fx = memFs(false); fx.hooks.statfs = () => ({ bavail: 1000, bsize: 4096 });
    const r = await failCase("磁碟剩 4 MB(< 1.5 GB)", { fx }, "disk");
    t("…磁碟不夠時沒有發出任何下載", r.calls.length === 0, r.calls); }
  { const r = rig({ unsupported: "tar" }), out = await r.S.ensure();
    t("unsupported(tar)→ 直接回 {ok:false, kind:other}、不下載、fail 仍 null、不送埋點", out.ok === false && out.kind === "other" && r.calls.length === 0 && r.S.snapshot().fail === null && r.S.snapshot().unsupported === "tar" && r.tracked.length === 0, { out, snap: r.S.snapshot() }); }
  { const fx = memFs(false); let n = 0; fx.hooks.rename = () => { if (n++ < 2) throw Object.assign(new Error("busy"), { code: "EPERM" }); };
    const r = rig({ fx }), out = await r.S.ensure();
    t("rename EPERM 兩次後成功:sleep 兩次、每次 500 ms(注入的,不真等)", out.ok === true && r.sleeps.length === 2 && r.sleeps.every((x) => x === 500), { out, sleeps: r.sleeps }); }
  { const fx = memFs(false); fx.hooks.rename = () => { throw Object.assign(new Error("busy"), { code: "EPERM" }); };
    const r = await failCase("rename 一直 EPERM", { fx }, "other");
    t("…固定間隔 500 ms × 10 次(總共 5 秒,不指數退避)", r.sleeps.length === 10 && r.sleeps.every((x) => x === 500), r.sleeps); }
  { const fx = memFs(false); let r; fx.hooks.rename = () => { throw Object.assign(new Error("busy"), { code: "EPERM" }); };
    r = rig({ fx, onSleep: () => { if (r.sleeps.length === 2) r.S.abort(); } });
    const out = await r.S.ensure();
    t("abort 在 rename 重試中 → aborted:true、不寫 fail、不送埋點、不再重試", out.ok === false && out.aborted === true && r.S.snapshot().fail === null && r.tracked.length === 0 && r.sleeps.filter((x) => x === 500).length === 2, { out, sleeps: r.sleeps, tracked: r.tracked }); }
  { let release; const gate = new Promise((res) => { release = res; });
    const r = rig({ dlHook: () => gate });
    const a = r.S.ensure(), b = r.S.ensure();
    t("兩個呼叫者同時 ensure:同一個 Promise、busy() 為真", a === b && r.S.busy() === true);
    release(); const [x, y] = await Promise.all([a, b]);
    t("…只下載一次;跑完 busy() 為假", x.ok && y.ok && r.calls.filter((c) => c.startsWith("fetchToFile")).length === 1 && r.S.busy() === false); }
  { const fx = memFs(false); fx.writeFileSync("/b/codex/.lock", JSON.stringify({ pid: 424242, at: 0 }));
    const clock = { t: 0 }, r = rig({ fx, clock, alive: (pid) => pid === 424242, lockWaitMs: 5000 });
    const out = await r.S.ensure();
    t("鎖的 pid 活著:等滿(5 秒)回 other、沒有下載、沒刪別人的鎖", out.ok === false && out.kind === "other" && r.calls.length === 0 && r.fx.existsSync("/b/codex/.lock") && clock.t >= 5000, { out, t: clock.t }); }
  { const fx = memFs(false); fx.writeFileSync("/b/codex/.lock", JSON.stringify({ pid: 424242, at: 0 }));
    const r = rig({ fx, alive: () => false }), out = await r.S.ensure();
    t("鎖的 pid 死了:刪鎖、接手裝好", out.ok === true, out); }
  { // 互斥:兩份 app 同時通過 waitPidLock,晚一步的 wx 撞到 EEXIST → 回去等,不跟對方一起寫 staging
    const fx = memFs(false), clock = { t: 0 }; let first = true, holderAlive = true;
    fx.hooks.wx = (p) => { if (first) { first = false; fx.files.set(p, JSON.stringify({ pid: 555, at: 0 })); } };
    const r = rig({ fx, clock, alive: (pid) => pid === 555 && holderAlive, onSleep: () => { if (clock.t >= 3000) holderAlive = false; } }), out = await r.S.ensure();
    t("鎖 wx 搶輸(EEXIST)→ 等對方結束再搶;只有搶到之後才下載", out.ok === true && r.fx.log.filter((l) => l === "wx /b/codex/.lock").length === 2 && r.sleeps.length >= 3
      && r.calls[0].startsWith("fetchBuffer"), { out, wx: r.fx.log.filter((l) => l.startsWith("wx")), sleeps: r.sleeps.length }); }
  { // 當掉留下的鎖、pid 被別的程式重用:啟動時間晚於鎖檔 → 接手,不等 3 分鐘
    const fx = memFs(false), clock = { t: 100000 }; fx.writeFileSync("/b/codex/.lock", JSON.stringify({ pid: 424242, at: 1000 }));
    const r = rig({ fx, clock, alive: () => true, procStart: async () => 50000, lockWaitMs: 5000 }), out = await r.S.ensure();
    t("pid 被重用(行程啟動 50000 晚於鎖 1000)→ 立刻接手裝好、沒有等", out.ok === true && r.sleeps.filter((x) => x === 1000).length === 0, { out, sleeps: r.sleeps });
    const fy = memFs(false), c2 = { t: 100000 }; fy.writeFileSync("/b/codex/.lock", JSON.stringify({ pid: 424242, at: 1000 }));
    const r2 = rig({ fx: fy, clock: c2, alive: () => true, procStart: async () => 900, lockWaitMs: 5000 }), out2 = await r2.S.ensure();
    t("…啟動時間早於鎖(真的是持鎖那支)→ 照樣等滿回 other", out2.ok === false && out2.kind === "other" && r2.calls.length === 0); }
  { const fx = memFs(false); putPkg(fx, "/b/codex/0.166.0", "0.166.0", { target: "x86_64-apple-darwin" });
    const r = rig({ fx }), out = await r.S.ensure();
    t("釘版資料夾在但 pkgOk 不過(半包／平台不對)→ 重抓,上架前先刪掉它", out.ok === true && r.fx.log.includes("rm /b/codex/0.166.0") && JSON.parse(r.fx.readFileSync("/b/codex/0.166.0/codex-package.json")).target === T); }
  { const fx = memFs(false); putPkg(fx, "/b/codex/0.166.0", "0.166.0");
    const r = rig({ fx }), out = await r.S.ensure({ reinstall: true });
    t("reinstall:釘版在也重抓(隨包那顆 cantRun 時的〔再試一次〕)", out.ok === true && r.calls.some((c) => c.startsWith("fetchToFile"))); }
  { const r = rig(); await r.S.ensure();
    const k = rig({ dlHook: () => new Promise(() => {}) }); const p = k.S.ensure(); await new Promise((res) => setImmediate(res));
    const ab = await k.S.abort();
    t("abort 時沒有在跑的 ensure → 回 false;在下載中 abort 也不會等超過注入的 5 秒", (await r.S.abort()) === false && ab === false && k.S.busy() === true); p.catch(() => {}); }

  // ── sweep ──
  { const fx = memFs(false); ["0.164.0", "0.165.0", "0.166.0"].forEach((v) => putPkg(fx, "/b/codex/" + v, v)); fx.mkdirSync("/b/codex/.staging-0.166.0"); fx.mkdirSync("/b/codex/notes");
    let bad = true; fx.hooks.rm = (p) => { if (p.endsWith("0.164.0") && bad) { bad = false; throw Object.assign(new Error("x"), { code: "EBUSY" }); } };
    const logs = [], gone = C.sweep("/b", ["0.166.0"], { fs: fx, win: false, log: (m) => logs.push(m), alive: () => false });
    t("sweep:刪 keep 以外的版本與 .staging-*;刪不掉的那個只記 log、不擋其他;不碰非版本名的資料夾", JSON.stringify(gone.sort()) === '[".staging-0.166.0","0.165.0"]'
      && fx.existsSync("/b/codex/0.166.0/bin/codex") && fx.existsSync("/b/codex/0.164.0/bin/codex") && fx.existsSync("/b/codex/notes") && logs.length === 1 && /EBUSY/.test(logs[0]), { gone, logs }); }
  { const fx = memFs(false); ["0.165.0"].forEach((v) => putPkg(fx, "/b/codex/" + v, v));
    const gone = C.sweep("/b", ["0.166.0", "0.165.0"], { fs: fx, win: false, alive: () => false });
    t("sweep:換版後第一次開 app,釘版還沒抓、現在在用的 0.165.0 也在 keep 裡 → 不刪(抓新版期間對話不斷線)", gone.length === 0 && fx.existsSync("/b/codex/0.165.0/bin/codex")); }
  { const fx = memFs(false); fx.mkdirSync("/b/codex/.staging-0.166.0"); fx.writeFileSync("/b/codex/.lock", JSON.stringify({ pid: 424242 }));
    const gone = C.sweep("/b", ["0.166.0"], { fs: fx, win: false, alive: () => true });
    t("sweep:另一份 app 持鎖在下載 → 不碰它的 staging", gone.length === 0 && fx.existsSync("/b/codex/.staging-0.166.0")); }
  t("sweep:codex 資料夾不在 → 空、不拋", C.sweep("/nope", ["0.166.0"], { fs: memFs(false), win: false }).length === 0);

  // ── waitPidLock(enginesetup.js 匯出,兩邊共用)──
  { const fx = memFs(false), clock = { t: 0 }, logs = [];
    fx.writeFileSync("/l", JSON.stringify({ pid: 777 }));
    const w = await waitPidLock(fx, "/l", { now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, alive: () => true, waitMs: 3000, log: (pid) => logs.push(pid) });
    t("waitPidLock:持鎖的活著 → 等滿回 {timedOut:true},鎖不刪、log 只講一次", w.timedOut === true && fx.existsSync("/l") && clock.t >= 3000 && JSON.stringify(logs) === "[777]", { w, logs });
    let n = 0; const w2 = await waitPidLock(fx, "/l", { now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, alive: () => n++ < 2, waitMs: 60000 });
    t("waitPidLock:持鎖的結束了 → {timedOut:false} 並刪鎖", w2.timedOut === false && !fx.existsSync("/l"), w2);
    const w3 = await waitPidLock(fx, "/l", { alive: () => true });
    t("waitPidLock:沒有鎖檔 → {timedOut:false, held:false},立刻回", w3.timedOut === false && w3.held === false);
    fx.writeFileSync("/l", JSON.stringify({ pid: process.pid })); const w4 = await waitPidLock(fx, "/l", { alive: () => true });
    t("waitPidLock:鎖是自己這個行程的(上次當掉留下)→ 不等、刪鎖", w4.timedOut === false && !fx.existsSync("/l"));
    fx.writeFileSync("/l", JSON.stringify({ pid: 777, at: 5000 })); const c5 = { t: 0 };
    const w5 = await waitPidLock(fx, "/l", { now: () => c5.t, sleep: async (ms) => { c5.t += ms; }, alive: () => true, waitMs: 3000, procStart: async () => 9000 });
    t("waitPidLock:給了 procStart、持鎖 pid 的啟動時間晚於鎖檔 at(pid 被重用)→ 不等、刪鎖", w5.timedOut === false && !fx.existsSync("/l") && c5.t === 0, { w5, t: c5.t });
    fx.writeFileSync("/l", JSON.stringify({ pid: 777, at: 5000 }));
    const w6 = await waitPidLock(fx, "/l", { now: () => c5.t, sleep: async (ms) => { c5.t += ms; }, alive: () => true, waitMs: 3000 });
    t("waitPidLock:沒給 procStart(引擎安裝)→ 行為不變,照樣等滿", w6.timedOut === true && fx.existsSync("/l")); }

  // ── fetchToFile(fetchbuf.js):換掉 https.get,假 res 是真的 Readable ──
  { const https = require("https"), os = require("os"), fs = require("fs"), realGet = https.get;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blave-codexpkg-")), routes = {}, reqs = [];
    https.get = (url, opt, cb) => {
      const req = new EventEmitter(); req.opt = opt; req.url = String(url); reqs.push(req);
      req.destroy = (e) => { req.destroyed = true; if (req.res) req.res.destroy(e); else setImmediate(() => req.emit("error", e)); };
      const r = routes[String(url)] || { status: 404 };
      setImmediate(() => {
        const res = new PassThrough(); res.statusCode = r.status; res.headers = r.location ? { location: r.location } : r.len ? { "content-length": String(r.len) } : {}; req.res = res;
        cb(res);
        if (r.status !== 200) return;
        if (r.idle) { setTimeout(() => req.emit("timeout"), 20); return; }
        (async () => { for (const c of r.chunks) { if (req.destroyed) return; res.write(Buffer.from(c)); await new Promise((z) => setImmediate(z)); } res.end(); })();
      });
      return req;
    };
    delete require.cache[require.resolve("../shell/fetchbuf")];
    const { fetchToFile } = require("../shell/fetchbuf");
    const A = "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-aarch64-apple-darwin.tar.gz";
    const OBJ = "https://objects.githubusercontent.com/github-production-release-asset/x";
    const chunks = ["abc", "defgh", "ij"], want = crypto.createHash("sha256").update("abcdefghij").digest("hex");
    const opts = (o = {}) => ({ max: 100, idleMs: 120000, host: ["github.com", "githubusercontent.com"], totalMs: (len) => (len ? len * 10 : 999), ...o });
    routes[A] = { status: 302, location: OBJ }; routes[OBJ] = { status: 200, chunks, len: 10 };
    const seen = []; const got = await fetchToFile(A, path.join(dir, "a.tgz"), opts({ onBytes: (n, len) => seen.push(n + "/" + len) })).catch((e) => ({ err: e.message }));
    t("fetchToFile:redirect 到 objects.githubusercontent.com 放行;sha256 邊讀邊算、檔案內容對得上", got.sha256 === want && got.bytes === 10 && fs.readFileSync(path.join(dir, "a.tgz"), "utf8") === "abcdefghij", got);
    t("…onBytes 依序回報、帶 Content-Length;totalMs 由 Content-Length 算;socket 逾時 = idleMs", seen.join() === "3/10,8/10,10/10" && got.totalMs === 100 && reqs.every((r) => r.opt.timeout === 120000), { seen, totalMs: got.totalMs });
    const fail = async (o, file) => { try { await fetchToFile(A, path.join(dir, file), o); return "resolved"; } catch (e) { return e.message; } };
    routes[A] = { status: 302, location: "https://evil.example.com/x" };
    t("…redirect 到別的網域 → REDIRECT", (await fail(opts(), "b.tgz")) === "REDIRECT");
    routes[A] = { status: 302, location: "https://githubusercontent.com.evil.io/x" };
    t("…長得像的網域(githubusercontent.com.evil.io)也擋", (await fail(opts(), "b2.tgz")) === "REDIRECT");
    routes[A] = { status: 200, chunks: ["x".repeat(60), "y".repeat(60)] };
    t("…超過 max 就停 → TOO_LARGE", (await fail(opts(), "c.tgz")) === "TOO_LARGE");
    routes[A] = { status: 200, idle: true };
    t("…閒置(socket timeout)→ TIMEOUT", (await fail(opts(), "d.tgz")) === "TIMEOUT");
    routes[A] = { status: 200, chunks: ["ab"] };
    const r0 = await fetchToFile(A, path.join(dir, "e.tgz"), opts());
    t("…沒有 Content-Length → totalMs(null)(呼叫端用 PKG_MB 退路)", r0.totalMs === 999, r0);
    https.get = realGet; fs.rmSync(dir, { recursive: true, force: true }); }

  // ── ensure 的總上限算式:Content-Length(沒有就 PKG_MB)/ 40 KB/s × 1.2 ──
  { let tot = null; const r = rig({ dlHook: (o) => { tot = [o.totalMs(null), o.totalMs(203e6)]; } }); await r.S.ensure();
    t("ensure:總上限 = 大小 / 40 KB/s × 1.2(Mac arm64 沒有 Content-Length → 166 MB ≈ 83 分鐘;203 MB ≈ 101 分鐘)", tot && tot[0] === 4980000 && tot[1] === 6090000, tot); }
  { let tot = null; const r = rig({ dlHook: (o) => { tot = o.totalMs(10e9); } }); await r.S.ensure();
    t("ensure:Content-Length 以 400 MB 封頂(回 10 GB 也只給 400 MB 的時間,約 3.5 小時)", tot === Math.ceil(419430400 / 40000 * 1.2 * 1000), tot); }
  // ── 接線(main.js／preload.js／renderer):原文檢查 ──
  { const fs = require("fs"), SH = path.join(__dirname, "..", "shell");
    const main = fs.readFileSync(path.join(SH, "main.js"), "utf8"), pre = fs.readFileSync(path.join(SH, "preload.js"), "utf8"), app = fs.readFileSync(path.join(SH, "renderer", "app.js"), "utf8");
    const STR = eval(fs.readFileSync(path.join(SH, "renderer", "strings.js"), "utf8") + ";STRINGS");
    t("回合閘三碼:正在抓 → AGENT_BIN_DOWNLOADING(重抓途中 BAD_BIN 還在,要排前面);上次偵測判隨包跑不起來 → AGENT_BIN_BROKEN;否則 AGENT_BIN_MISSING(三條都在 useCodex 之前)",
      /if \(conn\.kind === "codex" && !codexBin && _codexPkg && _codexPkg\.busy\(\)\) throw new Error\("AGENT_BIN_DOWNLOADING"\);\n\s*if \(conn\.kind === "codex" && !codexBin && BAD_BIN\.codex\) throw new Error\("AGENT_BIN_BROKEN"\);\n\s*if \(conn\.kind === "codex" && !codexBin\) throw new Error\("AGENT_BIN_MISSING"\);/.test(main)
      && main.indexOf('throw new Error("AGENT_BIN_DOWNLOADING")') < main.indexOf("const useCodex = !!codexBin;"));
    t("結束 app:installing 算上 codexpkg.busy();收工的 Promise.all 帶 codexpkg.abort()", /installing = !!\(_engineSetup && \(_engineSetup\.busy\(\) \|\| _engineSetup\.compiling\(\)\)\) \|\| !!\(_codexPkg && _codexPkg\.busy\(\)\);/.test(main)
      && /engineAbort\(\), _codexPkg \? _codexPkg\.abort\(\)\.catch\(\(\) => false\) : null,/.test(main));
    t("開 app:codexKick 只在拿到單一實例鎖時跑(第二份 app 不起下載、不刪版本);沒有在跑的回合才 sweep;連的是 Codex 才背景 ensure",
      /if \(app\.hasSingleInstanceLock\(\)\) startStep\("codex engine", codexKick\);/.test(main) && /function codexKick\(\) \{\n\s*if \(liveTurnCount\(\) > 0\) return;/.test(main)
      && /codexpkg\.sweep\(BASE, cur \? \[CODEX_PIN, cur\.version\] : \[CODEX_PIN\]/.test(main) && /if \(\(loadConnection\(\) \|\| \{\}\)\.kind === "codex"\) codexPkg\(\)\.ensure\(\)/.test(main));
    t("IPC:codex-pkg-ensure／codex-pkg-state 走 handle()(fromOurPage 閘門);reinstall 只認 === true、而且沒有回合在跑才算;進度推 codex-pkg-state 給自家頁面",
      /handle\("codex-pkg-ensure", \(_e, opts\) => codexPkg\(\)\.ensure\(\{ reinstall: !!\(opts && opts\.reinstall === true\) && liveTurnCount\(\) === 0 \}\)\);/.test(main) && /handle\("codex-pkg-state", \(\) => codexPkg\(\)\.snapshot\(\)\);/.test(main)
      && /isOurPageUrl\(w\.webContents\.getURL\(\)\)\) w\.webContents\.send\("codex-pkg-state", s\)/.test(main) && !/ipcMain\.handle\("codex-pkg/.test(main));
    t("--version 上限 90 秒(codexpkg VERIFY_MS;main.js 不再傳 20 秒的 LOGIN_CHECK_MS 進來)、unsupported 開 app 算一次、PKG_MB 不解構進 main.js",
      /^const VERIFY_MS = 90000;$/m.test(fs.readFileSync(path.join(SH, "codexpkg.js"), "utf8")) && /o\.versionMs \|\| VERIFY_MS/.test(fs.readFileSync(path.join(SH, "codexpkg.js"), "utf8")) && !/versionMs:/.test(main) && /unsupported: codexpkg\.unsupported\(process\.platform, process\.arch, process\.env, fs\)/.test(main) && (main.match(/^const PKG_MB = /gm) || []).length === 1 && !/PKG_MB \} = /.test(main));
    t("preload:codexPkgEnsure(只轉 reinstall:true)/ codexPkgState / onCodexPkgState", /codexPkgEnsure: \(o\) => ipcRenderer\.invoke\("codex-pkg-ensure", o && o\.reinstall === true \? \{ reinstall: true \} : null\),/.test(pre)
      && /codexPkgState: \(\) => ipcRenderer\.invoke\("codex-pkg-state"\),/.test(pre) && /onCodexPkgState: \(fn\) => ipcRenderer\.on\("codex-pkg-state", \(_e, s\) => fn\(s\)\),/.test(pre));
    t("renderer:先掛 onCodexPkgState 再拉一次快照(同 engine.js)", app.indexOf("window.blave.onCodexPkgState(codexPkgOnState);") > 0 && app.indexOf("window.blave.onCodexPkgState(codexPkgOnState);") < app.indexOf("window.blave.codexPkgState()"));
    t("renderer:回合錯誤卡與系統通知摘錄都認得 AGENT_BIN_DOWNLOADING／AGENT_BIN_BROKEN(字串 key 就是那一碼)", /\/AGENT_BIN_BROKEN\/\.test\(tail\) \? t\("AGENT_BIN_BROKEN"\)/.test(app) && /\/AGENT_BIN_DOWNLOADING\/\.test\(tail\) \? t\("AGENT_BIN_DOWNLOADING"\)/.test(app)
      && /\(\(r\.errTail \|\| ""\)\.match\(\/AGENT_BIN_\(MISSING\|DOWNLOADING\|BROKEN\)\/\) \|\| \[\]\)\[0\] \|\| false/.test(app) && /binMissing \? t\(binMissing\)/.test(app));
    t("focusRedetect:Codex 引擎下載中不重偵測(裝好那一刻自己會)", /if \(PKG\.snap && PKG\.snap\.phase !== "idle"\) return false;/.test(app.slice(app.indexOf("function focusRedetect()"), app.indexOf("function focusRedetect()") + 600)));
    const KEYS = ["cn.pkgSize", "cn.pkgDl", "cn.pkgInstall", "cn.pkgTar", "cn.pkgNet", "cn.pkgDisk", "cn.pkgFail", "cn.pkgBad", "cn.retry", "row.orBrowser", "AGENT_BIN_DOWNLOADING", "AGENT_BIN_BROKEN", "AGENT_BIN_MISSING", "cn.pkgArch"];
    t("字串:新 key 兩語都有;佔位 {size}／{a}／{b} 兩語一致", KEYS.every((k) => STR.zh[k] && STR.en[k]) && ["zh", "en"].every((l) => /\{size\}/.test(STR[l]["cn.pkgSize"]) && /\{a\}/.test(STR[l]["cn.pkgDl"]) && /\{b\}/.test(STR[l]["cn.pkgDl"])), KEYS.filter((k) => !STR.zh[k] || !STR.en[k]));
    t("字串:回合兩句指到連結畫面的鈕;cn.pkgTar 不再叫人自行安裝(自己裝的不看)", STR.zh.AGENT_BIN_MISSING === "還沒下載 Codex 引擎，到連結畫面按〔連結〕" && STR.zh.AGENT_BIN_BROKEN === "Codex 引擎無法啟動，到連結畫面按〔再試一次〕"
      && STR.zh[`cn.connect`] === "連結" && STR.zh["cn.retry"] === "再試一次" && STR.en["cn.connect"] === "Connect" && STR.en["cn.retry"] === "Try Again" && /press Connect$/.test(STR.en.AGENT_BIN_MISSING) && /press Try Again$/.test(STR.en.AGENT_BIN_BROKEN)
      && !/自行安裝/.test(STR.zh["cn.pkgTar"]) && !/yourself/.test(STR.en["cn.pkgTar"]), [STR.zh.AGENT_BIN_MISSING, STR.en.AGENT_BIN_MISSING]);
    const cfg = fs.readFileSync(path.join(SH, "electron-builder.config.js"), "utf8");
    t("打包:codexpkg.js 在 files 裡(main.js require 它)", /files:\s*\[[^\]]*"codexpkg\.js"/.test(cfg)); }
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
process.on("beforeExit", () => { console.log("FAIL  非同步測試沒有跑到結尾"); process.exit(1); });
