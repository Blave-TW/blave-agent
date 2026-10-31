/* Codex 引擎隨包(spec codex-bundled-engine-2026-10-31):對話跑的是我們抓的那顆 codex,不再追用戶裝在哪
   (OpenAI 一直換裝法:npm、PowerShell 安裝器、ChatGPT app 搬位置、Store、VS Code 擴充套件)。同 Claude 那邊跑 SDK 隨包的 claude。
   來源是 OpenAI 在 GitHub release 發的平台套件(Homebrew cask codex 裝的同一顆),SHA256 對同一個 release 的校驗檔;
   解在 <BASE>/codex/<版>/、原地跑:codex 靠執行檔旁邊的 codex-path/、codex-resources/ 找 rg 與輔助程式,不能單獨搬走。
   版本只有一個來源:runtime/CODEX_VERSION(main.js 的 CODEX_PIN 由測試釘住)。I/O 全走注入,純邏輯在 tests/check_shell_codexpkg.js 跑 */
const nodePath = require("path");
const { waitPidLock, pidAlive, procStartOf } = require("./enginesetup");

const TRIPLES = { "darwin/arm64": "aarch64-apple-darwin", "darwin/x64": "x86_64-apple-darwin", "win32/x64": "x86_64-pc-windows-msvc" };
const tripleOf = (platform, arch) => TRIPLES[platform + "/" + arch] || null;
// 套件大小(MB,rust-v0.166.0 實測):畫面「約 N MB」與沒有 Content-Length 時算總上限的退路
const PKG_MB = { "aarch64-apple-darwin": 166, "x86_64-apple-darwin": 180, "x86_64-pc-windows-msvc": 203 };
const SUMS = "codex-package_SHA256SUMS";
const HOSTS = ["github.com", "githubusercontent.com"];   // release 的檔 302 到 objects.／release-assets.githubusercontent.com
const VER_RE = /^\d+\.\d+\.\d+$/;
// 解開後 Mac 約 420 MB、Windows 約 600 MB,加上 tarball 本身與升版時新舊並存:下載前就擋
const DISK_MIN = 1.5e9;
const MAX_BYTES = 400 * 1024 * 1024, IDLE_MS = 120000, MIN_RATE = 40000, EXTRACT_MS = 600000;
const RENAME_TRIES = 10, RENAME_WAIT_MS = 500;
// 上架前那一次 --version:Windows Defender 第一次掃剛解開的 ~200 MB codex.exe,慢機要好幾十秒(登入檢查的 20 秒不夠)
const VERIFY_MS = 90000;
// staging 裡解好、tarball 校驗過的記號(內容是 sha256):--version 逾時時留著,下一次 ensure 不重新下載、直接再驗
const EXTRACTED = ".extracted";
const P = (win) => (win ? nodePath.win32 : nodePath.posix);
// 失敗分類:kind ∈ net／disk／checksum／other(engine_opt_fail 的 codex_<kind>)
const pkgErr = (kind, msg) => Object.assign(new Error(msg || kind), { kind, pkg: true });
// 4xx(CODEX_VERSION 指到不存在的版本、GitHub 拒絕)不是網路問題,另歸 http;斷線、逾時、5xx 才是 net
const netErr = (e) => { const m = String((e && e.message) || ""); return m === "TOO_LARGE" ? pkgErr("other", m) : e && e.code === "ENOSPC" ? pkgErr("disk", "ENOSPC")
  : /^HTTP_4\d\d$/.test(m) ? pkgErr("http", m) : pkgErr("net", (e && (e.code || e.message)) || "net"); };
// tar 失敗時看 stderr 尾巴歸類:磁碟滿了是 disk,其他 other
const tarErr = (x) => (/no space|ENOSPC|disk (is )?full|not enough space/i.test(x.err || "") ? pkgErr("disk", "tar ENOSPC") : pkgErr("other", "tar " + x.code + ": " + String(x.err || "").slice(-300)));

const pkgName = (triple) => `codex-package-${triple}.tar.gz`;
function assetUrls(version, triple) {
  const b = `https://github.com/openai/codex/releases/download/rust-v${version}/`;
  return { pkg: b + pkgName(triple), sums: b + SUMS };
}
// 校驗檔一行「<sha256>  <檔名>」;找不到那個檔名就 null(呼叫端整個失敗,不准跳過校驗)
function pickSum(text, filename) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64}) [ *]?(\S+)$/);
    if (m && m[2] === filename) return m[1].toLowerCase();
  }
  return null;
}
const pkgDir = (base, version, win) => P(win).join(base, "codex", version);
const binOf = (dir, win) => P(win).join(dir, "bin", win ? "codex.exe" : "codex");
// 這個資料夾是不是我們要的那一包:執行檔在、codex-package.json 的版本／變體／平台都對上 → 執行檔路徑
function pkgOk(dir, version, triple, win, fsx) {
  const bin = binOf(dir, win);
  try {
    if (!fsx.existsSync(bin)) return null;
    const j = JSON.parse(fsx.readFileSync(P(win).join(dir, "codex-package.json"), "utf8"));
    return j && j.version === version && j.variant === "codex" && j.target === triple ? bin : null;
  } catch (_) { return null; }
}
const verNum = (v) => v.split(".").map(Number);
const newer = (a, b) => { const x = verNum(a), y = verNum(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
/* 現在能用的那一顆:釘版在就是它;不在(升版、還在抓新版)就拿已經裝好的最高版,對話不斷線。readdir 只在釘版不在時發生(每一則訊息都會走到) */
function installed(base, pin, triple, win, fsx) {
  const p = pkgOk(pkgDir(base, pin, win), pin, triple, win, fsx);
  if (p) return { path: p, version: pin, pinned: true };
  let names; try { names = fsx.readdirSync(P(win).join(base, "codex")); } catch (_) { return null; }
  const vs = names.filter((n) => VER_RE.test(n) && n !== pin).sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0));
  for (const v of vs) { const q = pkgOk(pkgDir(base, v, win), v, triple, win, fsx); if (q) return { path: q, version: v, pinned: false }; }
  return null;
}
// Windows 10 build 17063 起系統自帶 bsdtar;Mac 一定有。不加 -P:bsdtar 預設拒絕 ..、去掉開頭 /、不跟 symlink 改向
const tarBin = (platform, env) => (platform === "win32" ? nodePath.win32.join((env && env.SystemRoot) || "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar");
function unsupported(platform, arch, env, fsx) {
  if (!tripleOf(platform, arch)) return "arch";
  try { if (!fsx.existsSync(tarBin(platform, env))) return "tar"; } catch (_) { return "tar"; }
  return null;
}
/* 刪舊版與殘留的 .staging-*。只在開 app 時叫:ensure 成功那一刻可能有回合正握著舊版(Windows 刪不掉、Mac 刪得掉但回合中途找不到 rg)。
   keep = 留著的版本(釘版,加上釘版還沒裝好時現在在用的那一版——不然換版後第一次開 app 就把唯一能跑的刪了)。
   另一份 app 正持鎖在下載就不碰 staging。每一個各自 try,刪不掉只記 log */
function sweep(base, keep, o) {
  const fsx = o.fs, win = o.win, dir = P(win).join(base, "codex"), gone = [];
  let names; try { names = fsx.readdirSync(dir); } catch (_) { return gone; }
  let busyOther = false;
  try { const lk = JSON.parse(fsx.readFileSync(P(win).join(dir, ".lock"), "utf8")); busyOther = Number.isInteger(lk.pid) && lk.pid !== process.pid && (o.alive || pidAlive)(lk.pid); } catch (_) { /* 沒有鎖 */ }
  for (const n of names) {
    const sv = (n.match(/^\.staging-(.+)$/) || [])[1];
    // 解好、等再驗的那一包(--version 逾時留下的)留給下一次 ensure,不讓開 app 把它刪掉又重抓
    const resumable = sv && keep.includes(sv) && fsx.existsSync(P(win).join(dir, n, EXTRACTED));
    const old = VER_RE.test(n) && !keep.includes(n), staging = !!sv && !busyOther && !resumable;
    if (!old && !staging) continue;
    try { fsx.rmSync(P(win).join(dir, n), { recursive: true, force: true }); gone.push(n); }
    catch (e) { if (o.log) o.log(`[codexpkg] could not remove ${n}: ${(e && e.code) || e}`); }
  }
  return gone;
}

/* 主流程:o = { fs, spawn, fetchBuffer, fetchToFile, base, pin, triple, win, platform, env, now, sleep, alive, log, track, onChange, versionMs, lockWaitMs }。
   同一時間只跑一條(第二個呼叫者拿同一個 Promise)。快照 { phase, bytes, total, version, size, fail, unsupported }:fail 只放可重試的
   net／http／disk／checksum／other;我們自己收掉的(abort)不算失敗、不寫 fail、不送埋點 */
function createCodexPkg(o) {
  const fsx = o.fs, win = o.win, J = P(win).join;
  const now = o.now || Date.now, sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))), log = o.log || (() => {});
  const root = J(o.base, "codex"), lockFile = J(root, ".lock");
  // size = 套件大約幾 MB(畫面「會下載 Codex 引擎(約 N MB)」用)
  const S = { phase: "idle", bytes: 0, total: 0, version: o.pin, size: PKG_MB[o.triple] || null, fail: null, unsupported: o.unsupported || null };
  let inflight = null, gen = 0, child = null, req = null, lastEmit = 0;
  const snapshot = () => JSON.parse(JSON.stringify(S));
  const emit = () => { lastEmit = now(); try { if (o.onChange) o.onChange(snapshot()); } catch (e) { log("[codexpkg] onChange failed: " + (e && e.message)); } };
  const set = (x) => { Object.assign(S, x); emit(); };
  const track = (ev, props) => { try { if (o.track) o.track(ev, props); } catch (_) { /* 送不出去就算了 */ } };
  const stop = (my) => { if (my !== gen) { const e = pkgErr("other", "stopped (app closing)"); e.aborted = true; throw e; } };

  // 子行程一律有上限;回 { code, out, err, timedOut }(開不起來 code 是錯誤碼字串)。stdout／stderr 都讀掉只留尾巴:不讀的 pipe 滿了子行程會卡住
  function spawnWait(my, bin, args, ms, cwd) {
    stop(my);
    return new Promise((resolve) => {
      let c, out = "", err = "", done = false, timedOut = false;
      try { c = o.spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(cwd ? { cwd } : {}) }); } catch (e) { resolve({ code: (e && e.code) || "SPAWN", out, err, timedOut }); return; }
      child = c;
      const tm = setTimeout(() => { timedOut = true; try { c.kill(); } catch (_) { /* 已經結束 */ } }, ms);
      const fin = (code) => { if (done) return; done = true; clearTimeout(tm); if (child === c) child = null; resolve({ code, out, err, timedOut }); };
      if (c.stdout) c.stdout.on("data", (d) => { out = (out + d).slice(-4096); });
      if (c.stderr) c.stderr.on("data", (d) => { err = (err + d).slice(-4096); });
      c.on("error", (e) => fin((e && e.code) || "SPAWN"));
      c.on("close", (code) => fin(code));
    });
  }

  async function run(opts) {
    if (S.unsupported) return { ok: false, kind: "other", aborted: false };
    const my = gen, dir = pkgDir(o.base, o.pin, win), staging = J(root, ".staging-" + o.pin);
    const have = () => { const h = installed(o.base, o.pin, o.triple, win, fsx); return h && h.pinned ? h.path : null; };
    if (!opts.reinstall && have()) return { ok: true, path: have() };
    let locked = false;
    set({ phase: "download", bytes: 0, total: (PKG_MB[o.triple] || 0) * 1e6, fail: null });
    try {
      try {
        fsx.mkdirSync(root, { recursive: true });
        const st = fsx.statfsSync(root);
        if (st.bavail * st.bsize < DISK_MIN) throw pkgErr("disk");
      } catch (e) { throw e && e.pkg ? e : pkgErr("other", (e && e.code) || "statfs"); }
      // 互斥:wx 建檔,搶輸(EEXIST)就回去再等一輪。持鎖 pid 活著但啟動時間晚於鎖檔 = pid 被別的程式重用(當掉留下的鎖),當成死了接手
      for (let tries = 0; !locked; tries++) {
        const w = await waitPidLock(fsx, lockFile, { now, sleep, alive: o.alive, procStart: o.procStart || procStartOf, waitMs: o.lockWaitMs || 180000,
          log: (pid) => log(`[codexpkg] another app (pid ${pid}) is installing Codex; waiting for it`) });
        if (w.timedOut || tries >= 5) throw pkgErr("other", "lock");
        stop(my);
        try { fsx.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: now() }), { flag: "wx" }); locked = true; }
        catch (e) { if (!e || e.code !== "EEXIST") throw pkgErr("other", "lock " + ((e && e.code) || e)); }
      }
      // 等鎖的時候另一份 app 可能已經裝好了
      if (!opts.reinstall && have()) { set({ phase: "idle", fail: null }); return { ok: true, path: have() }; }
      if (opts.reinstall) fsx.rmSync(dir, { recursive: true, force: true });
      // 上一次 --version 逾時留下、已校驗解好的那一包:直接再驗,不重新下載
      const resume = !opts.reinstall && fsx.existsSync(J(staging, EXTRACTED)) && !!pkgOk(staging, o.pin, o.triple, win, fsx);
      for (const n of fsx.readdirSync(root)) if (/^\.staging-/.test(n) && !(resume && J(root, n) === staging)) fsx.rmSync(J(root, n), { recursive: true, force: true });
      if (!resume) await fetchAndExtract(my, staging);
      set({ phase: "verify" });
      if (!pkgOk(staging, o.pin, o.triple, win, fsx)) throw pkgErr("other", "layout");
      const v = await spawnWait(my, binOf(staging, win), ["--version"], o.versionMs || VERIFY_MS);
      stop(my);
      // 逾時(防毒還在掃)跟答錯分開:逾時留著解好的那一包,〔再試一次〕不重抓 200 MB;版號不對或跑不起來才整包丟掉
      if (v.timedOut) { const e = pkgErr("other", "version timed out"); e.keepStaging = true; throw e; }
      if (v.code !== 0 || !String(v.out).includes(o.pin)) throw pkgErr("other", "version " + v.code);
      fsx.rmSync(J(staging, EXTRACTED), { force: true });
      // 壞掉或版本不符的舊目錄可能還在(reinstall、pkgOk 不過的半包);別的版本不在這裡刪(交 sweep)
      try { fsx.rmSync(dir, { recursive: true, force: true }); } catch (e) { throw pkgErr("other", "rm " + ((e && e.code) || e)); }
      // Windows Defender／索引在解壓後幾秒常握著 codex.exe:固定間隔重試,不指數退避
      for (let i = 0; ; i++) {
        try { fsx.renameSync(staging, dir); break; } catch (e) {
          if (i >= RENAME_TRIES) throw pkgErr("other", "rename " + ((e && e.code) || e));
          stop(my); await sleep(RENAME_WAIT_MS); stop(my);
        }
      }
      set({ phase: "idle", fail: null });
      track("feature_used", { name: "codex_pkg_done" });
      return { ok: true, path: binOf(dir, win) };
    } catch (e) {
      const aborted = !!(e && e.aborted) || my !== gen;
      const kind = e && e.pkg ? e.kind : (e && e.code) === "ENOSPC" ? "disk" : "other";
      // 沒拿到鎖(等滿)時 staging 是另一份 app 正在寫的,不碰;--version 逾時的那一包留著再驗
      if (locked && !(e && e.keepStaging)) { try { fsx.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* 下次開 app 的 sweep／下一次 ensure 再清 */ } }
      log(`[codexpkg] ${aborted ? "stopped" : "failed (" + kind + ")"}: ${(e && e.message) || e}`);
      if (aborted) { set({ phase: "idle" }); return { ok: false, kind, aborted: true }; }
      set({ phase: "idle", fail: { kind } });
      track("engine_opt_fail", { result: "codex_" + kind });
      return { ok: false, kind, aborted: false };
    } finally {
      if (locked) { try { const lk = JSON.parse(fsx.readFileSync(lockFile, "utf8")); if (lk.pid === process.pid) fsx.unlinkSync(lockFile); } catch (_) { /* 已經沒了 */ } }
    }
  }
  // 抓校驗檔 → 串流下載(邊算 sha256)→ 對校驗 → tar 解在 staging(cwd + 相對路徑:Windows 使用者名稱含非 ASCII 時不進 argv)→ 留記號
  async function fetchAndExtract(my, staging) {
    const tgz = J(staging, "pkg.tar.gz");
    const urls = assetUrls(o.pin, o.triple);
    let sums;
    try { sums = await o.fetchBuffer(urls.sums, 64 * 1024, { host: HOSTS }); } catch (e) { throw netErr(e); }
    stop(my);
    const want = pickSum(sums.toString("utf8"), pkgName(o.triple));
    if (!want) throw pkgErr("checksum", "no line for " + pkgName(o.triple));
    fsx.mkdirSync(staging, { recursive: true });
    let got;
    try {
      got = await o.fetchToFile(urls.pkg, tgz, {
        max: MAX_BYTES, idleMs: IDLE_MS, host: HOSTS, onReq: (r) => { req = r; },
        // 整條上限:Content-Length(沒給用 PKG_MB;以 400 MB 封頂,回一個超大的長度不能把上限撐到幾十小時)在 40 KB/s 下的時間再寬 20%
        totalMs: (len) => Math.ceil((Math.min(len || (PKG_MB[o.triple] || 250) * 1e6, MAX_BYTES) / MIN_RATE) * 1.2 * 1000),
        onBytes: (n, len) => { S.bytes = n; if (len) S.total = len; if (now() - lastEmit >= 250) emit(); },
      }, fsx);
    } catch (e) { stop(my); throw netErr(e); } finally { req = null; }
    stop(my);
    if (got.sha256 !== want) throw pkgErr("checksum");
    set({ phase: "extract", bytes: got.bytes, total: got.bytes });
    const x = await spawnWait(my, tarBin(o.platform, o.env), ["-xzf", "pkg.tar.gz", "-C", "."], EXTRACT_MS, staging);
    stop(my);
    if (x.code !== 0) throw tarErr(x);
    fsx.rmSync(tgz, { force: true });
    fsx.writeFileSync(J(staging, EXTRACTED), got.sha256);
  }
  function ensure(opts) {
    if (!inflight) inflight = run(opts || {}).finally(() => { inflight = null; });
    return inflight;
  }
  const busy = () => !!inflight;
  // 結束 app:加代數(之後不再起子行程、rename 重試跳出)、殺 tar／--version、關 socket,最多等 5 秒
  function abort() {
    gen++;
    const p = inflight;
    try { if (child) child.kill(); } catch (_) { /* 已經結束 */ }
    try { if (req) req.destroy(new Error("ABORTED")); } catch (_) { /* 已經關了 */ }
    if (!p) return Promise.resolve(false);
    return Promise.race([p.then(() => true, () => true), sleep(5000).then(() => false)]);
  }
  return { ensure, busy, abort, snapshot };
}

module.exports = { createCodexPkg, tripleOf, PKG_MB, assetUrls, pickSum, pkgDir, binOf, pkgOk, installed, tarBin, unsupported, sweep, HOSTS, DISK_MIN };
