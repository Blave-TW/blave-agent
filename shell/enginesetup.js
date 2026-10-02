/* 引擎安裝:建工作區 → 建 venv + 裝 SDK → 逐一裝策略套件,以及它的進度快照(mockup-desktop-first-run-progress)。
   主行程只有一份快照:每次變動整份交給 onChange;畫面晚進工作頁時用 snapshot() 拉現況——開 app 就在背景裝,
   用戶可能還在選 AI。重試接著上一次:上一次停在 fail 的快照沿用(步驟、時間、已下載量),做完的步驟與套件不重做。
   純函式(pipLine / pipError / failKind / depsTodo)另外匯出給 tests/check_shell_engine_setup.js。 */
"use strict";

// --progress-bar=raw:stdout 印「Progress <目前> of <總數>」(bytes;每個檔各自從 0 算,一秒最多四行)。
// 不能帶 -q:-q 會連這一行一起關掉。小於 512 KB 的檔 pip 不印 Progress,只有 Downloading 那一行的大小。
// --isolated:不吃用戶的 pip.conf 與 PIP_* 環境變數(PIP_INDEX_URL / PIP_NO_BINARY 都會讓引擎裝到別的東西)。
// --only-binary=:all::這個架構沒有 wheel 就兩秒內大聲失敗,不退到編原始碼(那條路在用戶機上跑幾分鐘然後死在看不到的地方)。
const PIP_INSTALL = ["-m", "pip", "--isolated", "--disable-pip-version-check", "install", "--only-binary=:all:", "--progress-bar=raw"];

const SIZE_UNIT = { bytes: 1, kB: 1e3, MB: 1e6, GB: 1e9 };
/* 一行 pip stdout 進到下載狀態 p = { done, file, installing, lastByteAt }。回 true = 畫面上的數字變了。
   done 只加下載完的檔(中途斷掉的那一個不算);同一次安裝的每一條 pip 都累加在同一個 p 上 */
function pipLine(p, line, now) {
  let m;
  if ((m = /^\s*Downloading (\S+) \(([\d.]+) (bytes|kB|MB|GB)\)\s*$/.exec(line))) {
    if (/\.metadata$/.test(m[1])) return false;
    fileDone(p);
    p.file = { bytes: 0, total: Math.round(parseFloat(m[2]) * SIZE_UNIT[m[3]]) };
    p.lastByteAt = now;
    return true;
  }
  if ((m = /^Progress (\d+) of (\d+)\s*$/.exec(line))) {
    if (!p.file) return false;
    const a = Number(m[1]), b = Number(m[2]);
    if (b > 0) p.file.total = b;
    if (a > p.file.bytes) { p.file.bytes = a; p.lastByteAt = now; return true; }
    return false;
  }
  if (/^Installing collected packages/.test(line)) { fileDone(p); p.installing = true; return true; }
  return false;
}
function fileDone(p) { if (p.file) { p.done += Math.max(p.file.total, p.file.bytes); p.file = null; } }

// pip 失敗的 stderr 常是整段 build / resolver log:只留 pip 自己的 ERROR 行(沒有就留最後三行)給失敗卡的「錯誤訊息」。
// 下載到一半斷掉時 ERROR 行只有「ERROR: Exception:」,原因在 traceback 最後一行:那種也留最後三行
function pipError(text) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const err = lines.filter((l) => l.startsWith("ERROR:")).map((l) => l.replace(/ \(from versions:.*\)$/, ""));
  const bare = err.length === 1 && /^ERROR: Exception:?$/.test(err[0]);
  return (err.length && !bare ? err : lines.slice(-3)).join("\n").slice(0, 600);
}
/* 失敗原因只分三種:超時(我們自己停的)、網路、說不出來。先看 ERROR 行與最後一行(traceback 的結尾):那裡有連線字樣就是網路、
   有別的明確原因(磁碟滿、hash 不符)就不是——前面曾經「WARNING: Retrying」過、後來死在別的原因的,不能算網路。
   ERROR 行只有「Could not find a version … (from versions: none)」時原因不在那裡,才退回去看整段的 Retrying 行(斷線實測 pip 25.0.1) */
const NOT_NET_RE = /No space left on device|THESE PACKAGES DO NOT MATCH THE HASHES|Permission denied|Errno 13|Errno 28/i;
const NET_RE = /HTTPS?ConnectionPool|NewConnectionError|Failed to establish a new connection|ConnectTimeout|ReadTimeout|Read timed out|ProxyError|SSLError|RemoteDisconnected|IncompleteRead|ChunkedEncodingError|Connection (?:reset|refused|aborted)|Network is unreachable|No route to host|nodename nor servname|Name or service not known|Temporary failure in name resolution|getaddrinfo failed/i;
function failKind(e) {
  if (e && e.timedOut) return "timeout";
  if (e && e.idle) return "net";   // 太久沒收到資料:我們停的,但原因是網路
  const all = String((e && e.stderr) || ""), lines = all.split("\n").map((l) => l.trim()).filter(Boolean);
  const tail = lines.filter((l) => l.startsWith("ERROR:")).concat(lines.slice(-1)).join("\n");
  if (NET_RE.test(tail)) return "net";
  if (NOT_NET_RE.test(tail)) return "other";
  return NET_RE.test(all) ? "net" : "other";
}

const markLines = (s) => String(s || "").split("\n").map((l) => l.trim()).filter(Boolean);
/* 還要裝哪些(照清單原順序)。complete = 整份清單裝完時寫的記號檔內容;partial = 裝到一半時逐個寫的那份。
   兩份都算「裝過」:清單換了某一個的版本,只裝那一個;拿掉的不必理 */
function depsTodo(deps, complete, partial) {
  if (String(complete || "") === deps.join("\n")) return [];
  const have = new Set([...markLines(complete), ...markLines(partial)]);
  return deps.filter((p) => !have.has(p));
}
const pipName = (pin) => String(pin).split("==")[0].toLowerCase().replace(/[-_.]+/g, "-");
/* 清單分組:optional 每一組用套件名(不帶版本)點名,點到的是那一組,其餘一律是核心。
   用名字不用另一份清單:版本只寫在 WORKSPACE_DEPS 一個地方。清單新加的套件沒被點名就當核心——裝不起來照樣擋,不會被靜靜跳過 */
function depGroups(deps, optional) {
  const groups = [], taken = new Set();
  for (const g of optional || []) {
    const names = new Set(g.names.map(pipName));
    const pins = deps.filter((p) => !taken.has(p) && names.has(pipName(p)));
    pins.forEach((p) => taken.add(p));
    if (pins.length) groups.push({ id: g.id, pins, optional: true });
  }
  return [{ id: "core", pins: deps.filter((p) => !taken.has(p)), optional: false }, ...groups];
}

const STEP_ORDER = ["ws", "engine", "pkgs"];
function createEngineSetup(o) {
  const { fs, path, spawn } = o;
  const now = o.now || Date.now;
  const venvDir = path.join(o.base, "venv");
  const sdkMark = path.join(venvDir, ".blave-sdk");
  // 每一組一個記號檔,整組裝完才寫;核心那組沿用 .blave-deps-1(同 0.1.11 以前的意思,既有 venv 照樣認得)。
  // <記號檔>.part:裝到一半時逐個記,重試從這裡接。分開記:一組失敗不會讓另一組重裝
  const markOf = (id) => path.join(venvDir, id === "core" ? ".blave-deps-1" : ".blave-deps-" + id);
  const depsMark = markOf("core");
  // 選用的那一組裝不起來:這次啟動不再試(不然每送一句話都要再等一輪 pip),下次開 app 再試
  const skipped = new Set();
  const pinsFile = path.join(venvDir, ".blave-pins.txt");
  const sdkName = o.sdkPins.split(" ")[0].split("==")[0];
  const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch (_) { return null; } };
  let S = { phase: "idle" };
  const emit = () => { try { o.onChange(snapshot()); } catch (e) { o.log("[engine] onChange failed: " + (e && e.message)); } };
  // 使用追蹤(telemetry.js 的 engine_setup / engine_opt_fail;值全是列舉):追蹤壞了不能讓安裝跟著壞
  const track = (ev, result) => { try { if (o.track) o.track(ev, { result }); } catch (_) { /* 送不出去就算了 */ } };
  const kindTag = () => (S.kind === "update" ? "upd" : "first");
  function snapshot() { return JSON.parse(JSON.stringify(S)); }

  /* 正在跑的子行程(abort 收它)與 venv 下的鎖檔:結束 app / 為了更新重開之前先收掉 pip;收不到的(當掉、被強制結束)
     下次開 app 時看鎖檔,那支 pip 還活著就先等它結束,不讓兩支 pip 同時寫同一個 venv(也擋開發版與打包版共用 ~/Blave 時同時裝) */
  let child = null, childDone = null;
  const lockFile = path.join(venvDir, ".blave-install.lock");
  const alive = o.alive || ((pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); } });
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  async function waitLock() {
    let lk = null; try { lk = JSON.parse(fs.readFileSync(lockFile, "utf8")); } catch (_) { return; }
    const until = now() + (o.lockWaitMs || 180000);
    let said = false;
    // 不殺它:鎖檔裡的 pid 可能已經被別的程式重用(當掉之後很久才開 app),殺錯行程比多等幾分鐘糟。等到它結束或等滿就往下走
    while (lk && Number.isInteger(lk.pid) && lk.pid !== process.pid && alive(lk.pid) && now() < until) {
      if (!said) { said = true; o.log(`[engine] another installer (pid ${lk.pid}) is still writing the venv; waiting for it`); }
      await sleep(1000);
    }
    try { fs.unlinkSync(lockFile); } catch (_) { /* 已經沒了 */ }
  }
  function abort() {
    if (!child) return Promise.resolve(false);
    const c = child, done = childDone;
    c.aborted = true;
    try { c.kill(); } catch (_) { /* 已經結束 */ }
    return Promise.race([done.then(() => true), sleep(5000).then(() => false)]);
  }
  const busy = () => !!child;

  // 子行程:逐行讀 stdout(進度)、stderr 留尾巴(失敗時要)。兩道停:
  //   totalMs = 這一條的總上限(只防真的卡死);idleMs = 多久沒有新的輸出就停(下載中才算;安裝階段 pip 本來就不出聲,不算)
  // 逾時的訊息固定成「timed out after Ns」/「no data for Ns」,不放整條指令(含用戶 home 路徑)
  function run(bin, args, envPath, timeoutMs, onLine, idle) {
    return new Promise((resolve, reject) => {
      let out = "", err = "", timedOut = false, idled = false, c;
      try {
        c = spawn(bin, args, { windowsHide: true, env: { ...process.env, ...o.pyEnv, PATH: envPath, PYTHONUNBUFFERED: "1" } });
      } catch (e) { reject(Object.assign(new Error(String((e && e.message) || e)), { stderr: "" })); return; }
      child = c; childDone = new Promise((r) => c.once("close", r));
      try { fs.mkdirSync(venvDir, { recursive: true }); fs.writeFileSync(lockFile, JSON.stringify({ pid: c.pid, at: now() })); } catch (_) { /* 鎖檔寫不了不擋安裝 */ }
      const stop = () => { try { c.kill(); } catch (_) { /* 已經結束 */ } };
      const tm = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      const iw = idle ? setInterval(() => { if (idle.quiet() > idle.ms) { idled = true; stop(); } }, o.watchMs || 1000) : null;
      c.stdout.on("data", (d) => {
        out += d;
        let i;
        while ((i = out.indexOf("\n")) >= 0) { const l = out.slice(0, i).replace(/\r$/, ""); out = out.slice(i + 1); if (onLine) onLine(l); }
        if (out.length > 65536) out = out.slice(-65536);
      });
      c.stderr.on("data", (d) => { err = (err + d).slice(-65536); });
      const end = () => { clearTimeout(tm); clearInterval(iw); if (child === c) { child = null; try { fs.unlinkSync(lockFile); } catch (_) { /* 沒有就算了 */ } } };
      c.on("error", (e) => { end(); reject(Object.assign(new Error(String((e && e.code) || e)), { stderr: err })); });
      c.on("close", (code) => {
        end();
        if (code === 0 && !timedOut && !idled) return resolve();
        const msg = c.aborted ? "stopped (app closing)" : timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s`
          : idled ? `no data for ${Math.round(idle.ms / 1000)}s` : err || `exit ${code}`;
        reject(Object.assign(new Error(msg), { stderr: err, timedOut: timedOut && !idled, idle: idled, aborted: !!c.aborted }));
      });
    });
  }
  async function pip(args, envPath, timeoutMs) {
    const p = S.dl;
    let lastLine = now();
    p.file = null; p.installing = false; p.lastByteAt = now();
    // 沒有新資料:最近一次有輸出(解析、Downloading、Progress)起算;進了安裝階段就不算(那時 pip 不出聲是正常的)
    const idle = { ms: o.idleMs, quiet: () => (p.installing ? 0 : now() - Math.max(lastLine, p.lastByteAt)) };
    try {
      await run(o.venvPy, [...PIP_INSTALL, ...args], envPath, timeoutMs, (l) => { lastLine = now(); if (pipLine(p, l, now())) emit(); }, o.idleMs ? idle : null);
      fileDone(p);
    } catch (e) {
      p.file = null;
      o.log("[engine] pip install failed: " + args.join(" ") + "\n" + String((e && e.stderr) || (e && e.message) || e));
      const x = new Error(e.timedOut || e.idle || e.aborted ? e.message : pipError(e.stderr || e.message));
      x.kind = failKind(e); x.limitMs = timeoutMs; x.aborted = !!e.aborted;
      throw x;
    }
  }

  function begin(keys, kind) {
    const t = now();
    if (S.phase === "fail") {
      // 接著上一次:時間、已下載量照算,做完的那幾步照樣列著。這一輪要走的設回等待;上一次沒有的(同一次啟動裡 venv 又不見了)
      // 補進來,照固定順序排;上一次列著、這一輪不必走的算做完了
      S.acc += S.tEnd - S.t0;
      const had = new Map(S.steps.map((st) => [st.k, st]));
      S.steps = STEP_ORDER.filter((k) => had.has(k) || keys.includes(k))
        .map((k) => ({ k, st: keys.includes(k) ? "wait" : "done", ms: had.has(k) ? had.get(k).ms : 0, t0: null }));
    } else {
      S = { kind, sizeMB: kind === "first" ? o.firstRunMB : null, acc: 0, steps: keys.map((k) => ({ k, st: "wait", ms: 0, t0: null })),
        dl: { done: 0, file: null, installing: false, lastByteAt: t } };
    }
    Object.assign(S, { phase: "run", t0: t, tEnd: null, cur: null, err: null, warn: null, show: S.kind !== "relink" });
    emit();
  }
  async function step(k, fn) {
    const st = S.steps.find((x) => x.k === k);
    st.st = "run"; st.t0 = now(); S.cur = { step: k, sub: null, i: 0, n: 0, name: null, t0: st.t0, limitMs: null }; emit();
    await fn();
    st.ms += now() - st.t0; st.t0 = null; st.st = "done"; emit();
  }

  async function ensure() {
    const envPath = await o.envPath();
    await waitLock();
    const fresh = !fs.existsSync(o.ws);
    const needVenv = !fs.existsSync(o.venvPy);
    const needSdk = read(sdkMark) !== o.sdkPins;
    const groups = depGroups(o.deps, o.optional).map((g) => ({ ...g, mark: markOf(g.id),
      todo: skipped.has(g.id) ? [] : depsTodo(g.pins, read(markOf(g.id)), read(markOf(g.id) + ".part")) }));
    const todo = groups.flatMap((g) => g.todo);
    if (!fresh && !o.isPackaged) o.copyOfficial();   // 開發版:每次都重拷,改了 lib/ 或 AGENTS.md 重啟就生效
    if (!fresh && !needVenv && !needSdk && !todo.length) {
      for (const d of ["state", "config"]) fs.mkdirSync(path.join(o.base, d), { recursive: true });
      // 上一輪失敗、這一輪卻沒事可做(上次死在寫最後那個記號檔之前,其實都裝好了):卡不能一直停在失敗
      if (S.phase === "fail") { Object.assign(S, { phase: "done", tEnd: now(), cur: null, err: null }); emit(); }
      return;
    }
    const keys = [fresh && "ws", (needVenv || needSdk) && "engine", todo.length && "pkgs"].filter(Boolean);
    // 只有 venv 的連結斷了(.app 換了位置):幾秒就修好,不是第一次也不是更新,不出卡
    const kind = fresh ? "first" : !needSdk && !todo.length ? "relink" : read(depsMark) !== null ? "update" : "first";
    begin(keys, kind);
    try {
      if (fresh) await step("ws", () => {
        // 0700:裡面有 session.db(對話)、.env(金鑰)、狀態檔,同一台電腦的其他用戶不該讀得到(稽核 R9)。
        // 只在我們自己建立的時候設;用戶既有的目錄不動他的權限。
        if (!fs.existsSync(o.base)) fs.mkdirSync(o.base, { recursive: true, mode: 0o700 });
        fs.mkdirSync(o.ws, { recursive: true });
        o.copyOfficial();
      });
      for (const d of ["state", "config"]) fs.mkdirSync(path.join(o.base, d), { recursive: true });
      // 每一條 pip(SDK 那條與每個策略套件)都拿整份 WORKSPACE_DEPS 當 -c,所以在引擎那一步之前就寫好:
      // SDK 換版時它的相依不能把核心套件悄悄升級掉——那樣之後記號檔看起來都裝好了,漂移永遠修不回來;真的衝突就當場失敗。
      // 套件一個一個裝時,依賴版本也跟一次全裝解出來的一樣(兩種裝法的 pip freeze 實測相同);選用的那組也不能換掉核心的版本
      fs.mkdirSync(venvDir, { recursive: true });
      fs.writeFileSync(pinsFile, o.deps.join("\n") + "\n");
      if (needVenv || needSdk) await step("engine", async () => {
        if (needVenv) {
          Object.assign(S.cur, { sub: "venv", t0: now(), limitMs: o.venvMs, idleMs: null }); emit();
          // .app 被搬走 / 改名 / 被 Gatekeeper translocate 之後,venv/bin/python* 是斷掉的連結,venv 模組撞到會直接報錯(實測)。
          // 先清掉斷的,site-packages 留著,重建只要幾秒。Windows 的 venv 沒有連結(Scripts\python.exe 是 launcher):整段跳過
          const vbin = path.join(venvDir, o.venvBin);
          for (const n of !o.win && fs.existsSync(vbin) ? fs.readdirSync(vbin) : []) {
            const f = path.join(vbin, n);
            if (fs.lstatSync(f).isSymbolicLink() && !fs.existsSync(f)) fs.unlinkSync(f);
          }
          try { await run(o.basePython(), ["-m", "venv", venvDir], envPath, o.venvMs); } catch (e) {
            o.log("[engine] venv failed\n" + String(e.stderr || e.message));
            throw Object.assign(new Error(e.timedOut ? e.message : pipError(e.stderr || e.message)), { kind: e.timedOut ? "timeout" : "other", limitMs: o.venvMs });
          }
        }
        if (needSdk) {
          // 記號檔而不是「venv 在就當裝好了」:pip 中途失敗(斷網)時 venv 已經在,下次要重試
          Object.assign(S.cur, { sub: null, name: sdkName, t0: now(), limitMs: o.engineMs, idleMs: o.idleMs || null }); emit();
          await pip(["-c", pinsFile, ...o.sdkPins.split(" ")], envPath, o.engineMs);
          fs.writeFileSync(sdkMark, o.sdkPins);
        }
      });
      if (todo.length) await step("pkgs", async () => {
        // 一個一個裝(「第 n / N 個」),-c 用的是上面寫好的整份清單
        // 「第 i / N 個」:N = 整份清單(兩組合起來),i = 已經裝好的(含以前裝過、這次不必裝的)+1。更新後只補新加的幾個時從中間開始,
        // 分段條也照這個填——前面那幾個本來就在
        const left = new Set(todo);
        for (const g of groups) {
          if (!g.todo.length) continue;
          const done = new Set(markLines(read(g.mark + ".part")));
          try {
            for (const pin of g.todo) {
              Object.assign(S.cur, { i: o.deps.length - left.size + 1, n: o.deps.length, name: pin.split("==")[0], t0: now(), limitMs: o.pkgMs, idleMs: o.idleMs || null }); emit();
              await pip(["-c", pinsFile, pin], envPath, o.pkgMs);
              done.add(pin); left.delete(pin);
              fs.writeFileSync(g.mark + ".part", g.pins.filter((p) => done.has(p)).join("\n"));
            }
            fs.writeFileSync(g.mark, g.pins.join("\n"));
            try { fs.unlinkSync(g.mark + ".part"); } catch (_) { /* 沒有就算了 */ }
          } catch (e) {
            if (e.aborted) throw e;   // 關 app / 更新重開時我們自己收掉的:不是這組裝不起來,不記 warn、不送 engine_opt_fail
            if (!g.optional) throw e;
            // 選用的那組(美股資料):不擋引擎、不往外丟。完整 stderr 已經由 pip() 記了;這一組剩下的不再試
            skipped.add(g.id);
            g.todo.forEach((p) => left.delete(p));
            S.warn = { group: g.id, kind: e.kind || "other", msg: String(e.message || e).slice(0, 600), name: S.cur.name };
            o.log(`[engine] optional packages "${g.id}" not installed; retry on next launch: ${e.message}`);
            track("engine_opt_fail", g.id + "_" + S.warn.kind);
            emit();
          }
        }
      });
      Object.assign(S, { phase: "done", tEnd: now(), cur: null });
      emit();
      if (S.kind !== "relink") track("engine_setup", kindTag() + "_done");
    } catch (e) {
      const st = S.steps.find((x) => x.st === "run");
      const t = now();
      if (st) { st.ms += t - st.t0; st.t0 = null; st.st = "err"; }
      S.err = { kind: e.kind || "other", msg: String(e.message || e).slice(0, 600), step: st ? st.k : null, name: (S.cur && S.cur.name) || null, limitMs: e.limitMs || null };
      Object.assign(S, { phase: "fail", tEnd: t });
      emit();
      if (S.kind !== "relink" && !e.aborted) track("engine_setup", kindTag() + "_" + S.err.kind);   // 關 app 時我們自己收掉的不算失敗
      throw e;
    }
  }
  return { ensure, snapshot, abort, busy };
}

module.exports = { createEngineSetup, pipLine, pipError, failKind, depsTodo, depGroups, PIP_INSTALL };
