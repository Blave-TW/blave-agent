// 0.1.55 Windows 第一次開 app 黑畫面的四道防線(shell/bootguard.js、shell/mainlog.js 與 main.js 的接線),不起 Electron:
//   ① 主行程 log:時間戳、多行縮排、逐行遮蔽、輪替與份數上限、寫不了不拋、console.error 照舊印
//   ② 首次安裝等主視窗 did-finish-load、保底逾時、app 結束中不起;官方檔第一次拷改非同步
//   ③ GPU 退路:只有 Windows、GPU、非 clean-exit、這次第一格畫出來之前才記;旗標讀寫;ready 之前關硬體加速;結束中不記;
//     復原(關著正常結束 3 次或 30 天清旗標,第二次記到就只剩 30 天)
//   ④ 主視窗一律 show:false,ready-to-show 才顯示、保底強制顯示;HEADLESS 與隱藏重開那一扇不顯示
// 跑法:node tests/check_shell_bootguard.js(BLAVE_HOME 有給就把暫存檔放那底下)
const fs = require("fs"), os = require("os"), path = require("path"), { EventEmitter } = require("events");
const SHELL = path.join(__dirname, "..", "shell");
const G = require(path.join(SHELL, "bootguard.js")), L = require(path.join(SHELL, "mainlog.js"));
const src = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
const cfg = fs.readFileSync(path.join(SHELL, "electron-builder.config.js"), "utf8");
let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || d === undefined ? "" : "  ← " + JSON.stringify(d).slice(0, 600))); if (!ok) red++; };
const cut = (s, head) => { const i = s.indexOf(head); if (i < 0) throw new Error("找不到 " + head); let d = 0; for (let k = s.indexOf("{", s.indexOf(")", i)); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("切不出 " + head); };
const TMP_BASE = path.isAbsolute(process.env.BLAVE_HOME || "") ? process.env.BLAVE_HOME : os.tmpdir();
fs.mkdirSync(TMP_BASE, { recursive: true });
const ROOT = fs.mkdtempSync(path.join(TMP_BASE, "bootguard-"));
// 假計時器:手動推進
function clock() {
  const q = []; let now = 0;
  return { setTimeout: (fn, ms) => { const h = { at: now + ms, fn, live: true }; q.push(h); return h; }, clearTimeout: (h) => { if (h) h.live = false; },
    advance(ms) { now += ms; for (const h of q.filter((x) => x.live && x.at <= now)) { h.live = false; h.fn(); } }, pending: () => q.filter((x) => x.live).length };
}

try {
  // ── ① 主行程 log ──
  { const dir = path.join(ROOT, "logs1"); let ts = Date.UTC(2026, 10, 14, 1, 2, 3);
    const lg = L.createMainLog({ dir: () => dir, now: () => ts });
    const tok = "sk-ant-api03-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    t("寫得進去:檔在 userData/logs/main.log", lg.write("[boot] app ready") === true && fs.existsSync(path.join(dir, "main.log")));
    lg.write("[engine] pip install failed\nERROR: x\n  Authorization: Bearer " + tok + "\n/Users/somebody/Blave/venv api_key=" + tok);
    const txt = fs.readFileSync(path.join(dir, "main.log"), "utf8");
    t("時間戳開頭、接續行縮兩格", /^2026-11-14T01:02:03\.000Z \[boot\] app ready\n2026-11-14T01:02:03\.000Z \[engine\] pip install failed\n  ERROR: x\n  /.test(txt), txt);
    t("redact:金鑰與 Bearer token 不落地、家目錄換成 ~", !txt.includes(tok) && !txt.includes("somebody") && txt.includes("~/Blave/venv") && txt.includes("⟦R⟧"), txt);
    // 一整段滿是長 hash 的 pip stderr 逐行遮:不會因為整則超過遮罩上限變成 EXCLUDED,ERROR 那一行留著
    const hashes = Array.from({ length: 12 }, (_, i) => "    --hash=sha256:" + (i + "f".repeat(63)).slice(0, 64)).join("\n");
    lg.write("ERROR: THESE PACKAGES DO NOT MATCH THE HASHES\n" + hashes);
    t("多行逐行遮:滿是 hash 的 stderr 不整則消失", fs.readFileSync(path.join(dir, "main.log"), "utf8").includes("ERROR: THESE PACKAGES DO NOT MATCH THE HASHES"));
    lg.write(Array.from({ length: 500 }, (_, i) => "line " + i).join("\n"));
    const last = fs.readFileSync(path.join(dir, "main.log"), "utf8");
    t("太長的訊息只留最後 LINES_MAX 行(死因在結尾),註明省略幾行", last.includes("(" + (500 - L.LINES_MAX) + " lines omitted)") && last.includes("line 499") && !last.includes("line 0\n"));
    if (process.platform !== "win32") t("檔案權限 0600、目錄 0700", (fs.statSync(path.join(dir, "main.log")).mode & 0o777) === 0o600 && (fs.statSync(dir).mode & 0o777) === 0o700); }
  { const dir = path.join(ROOT, "logs2");
    const lg = L.createMainLog({ dir, maxBytes: 300, keep: 3 });
    for (let i = 0; i < 40; i++) lg.write("[x] line " + i + " " + "z".repeat(20));
    const names = fs.readdirSync(dir).sort();
    const sizes = names.map((n) => fs.statSync(path.join(dir, n)).size);
    t("輪替:main.log + .1 + .2,最多 keep 份,每份不超過上限", JSON.stringify(names) === JSON.stringify(["main.log", "main.log.1", "main.log.2"]) && sizes.every((s) => s <= 300), { names, sizes });
    t("最新的在 main.log,最舊的被丟掉", fs.readFileSync(path.join(dir, "main.log"), "utf8").includes("line 39") && !names.some((n) => fs.readFileSync(path.join(dir, n), "utf8").includes("line 0 "))); }
  { // 寫不了(目錄位置是一個檔、rename 失敗)不拋
    const f = path.join(ROOT, "not-a-dir"); fs.writeFileSync(f, "x");
    const lg = L.createMainLog({ dir: path.join(f, "logs") });
    let threw = false; try { t("目錄建不起來:回 false、不拋", lg.write("x") === false); } catch (_) { threw = true; } t("…真的沒拋", !threw);
    const dir = path.join(ROOT, "logs3"); const realFs = require("fs");
    const fakeFs = { ...realFs, renameSync: () => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); } };
    const lg2 = L.createMainLog({ dir, fs: fakeFs, maxBytes: 100 });
    let ok = true; for (let i = 0; i < 10; i++) ok = lg2.write("line " + i + " " + "y".repeat(40)) && ok;
    t("輪替的 rename 失敗(第二份 app 開著檔):照樣接著寫、不拋", ok && fs.readFileSync(path.join(dir, "main.log"), "utf8").includes("line 9")); }
  { const dir = path.join(ROOT, "logs4"), lg = L.createMainLog({ dir });
    const printed = []; const con = { error: (...a) => printed.push(a) };
    lg.hook(con); con.error("[mobile]", "upload failed", 3);
    t("hook:console.error 照舊印(原參數)、多參數照 util.format 接成一行寫進檔", printed.length === 1 && printed[0].length === 3 && /\[mobile\] upload failed 3\n$/.test(fs.readFileSync(path.join(dir, "main.log"), "utf8")));
    const bad = L.createMainLog({ dir: () => { throw new Error("no userData"); } }); const con2 = { error: () => {} }; bad.hook(con2);
    let threw = false; try { con2.error("x"); } catch (_) { threw = true; } t("hook:寫檔那一側壞了 console.error 也不拋", !threw); }
  t("接線:mainlog 在 setName 之後、第一個 console.error 之前掛上;目錄是 userData/logs",
    src.indexOf('if (app.isPackaged) app.setName("Blave");') < src.indexOf("mainLog.hook(console);") && src.indexOf("mainLog.hook(console);") < src.indexOf("console.error(")
    && /createMainLog\(\{ dir: \(\) => path\.join\(app\.getPath\("userData"\), "logs"\) \}\)/.test(src));
  t("接線:關鍵點各一行(process start / app ready / createWindow / did-finish-load / child-process-gone / render-process-gone)",
    ["[boot] process start", "[boot] app ready", "[boot] createWindow", "[boot] main window did-finish-load", "[boot] main window ready-to-show", "[proc] child-process-gone type=", "[proc] render-process-gone reason="].every((s) => src.includes(s)));
  { const es = fs.readFileSync(path.join(SHELL, "enginesetup.js"), "utf8");
    t("引擎每一步開始、結束各寫一行(經 o.log → console.error → main.log)", /o\.log\(`\[engine\] \$\{S\.kind\} step \$\{k\} start`\)/.test(es) && /step \$\{k\} done in/.test(es)); }

  // ── ② 首次安裝等主視窗載完 ──
  { const c = clock(), wc = new EventEmitter(); wc.isDestroyed = () => false; let ran = 0; const logs = [];
    G.afterLoad(wc, { setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, what: "engine", log: (m) => logs.push(m), cancelled: () => false }, () => ran++);
    t("afterLoad:載完之前不起", ran === 0);
    wc.emit("did-finish-load"); c.advance(10000); wc.emit("did-finish-load");
    t("…did-finish-load 才起、只起一次、保底計時器收掉", ran === 1 && c.pending() === 0 && logs.join() === "[boot] engine start (did-finish-load)", logs); }
  { const c = clock(), wc = new EventEmitter(); wc.isDestroyed = () => false; let ran = 0;
    G.afterLoad(wc, { setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, cancelled: () => false }, () => ran++);
    c.advance(G.ENGINE_WAIT_MS - 1); const before = ran; c.advance(1); wc.emit("did-finish-load");
    t("afterLoad:頁面一直沒載完,保底 ENGINE_WAIT_MS 照起,只起一次", before === 0 && ran === 1 && G.ENGINE_WAIT_MS === 5000); }
  { const c = clock(), wc = new EventEmitter(); wc.isDestroyed = () => false; let ran = 0, closing = false; const logs = [];
    G.afterLoad(wc, { setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, what: "engine", log: (m) => logs.push(m), cancelled: () => closing }, () => ran++);
    closing = true; c.advance(G.ENGINE_WAIT_MS);
    t("afterLoad:等的期間 app 開始結束 → 不起(不留孤兒 pip)、記一行", ran === 0 && /not started \(app closing\)/.test(logs.join())); }
  { let ran = 0; G.afterLoad(undefined, { cancelled: () => false }, () => ran++); const d = new EventEmitter(); d.isDestroyed = () => true; G.afterLoad(d, { cancelled: () => false }, () => ran++);
    t("afterLoad:沒有視窗、視窗已銷毀 → 當場起", ran === 2); }
  t("接線:engine 那一步仍在 workspace sync 之後、只有拿到鎖的那份、等主視窗 did-finish-load、結束中不起;engineKick 本體不變(仍走 ensureEngineShared)",
    /if \(app\.hasSingleInstanceLock\(\)\) startStep\("engine", \(\) => require\("\.\/bootguard"\)\.afterLoad\(mainWin && mainWin\.webContents, \{ what: "engine", log: \(m\) => mainLog\.write\(m\), cancelled: \(\) => quitting \|\| quitDone \}, \(\) => startStep\("engine", engineKick\)\)\);/.test(src)
    && src.indexOf('startStep("workspace sync", syncOfficialOnUpdate)') < src.indexOf('startStep("engine", () => require("./bootguard").afterLoad(')
    && /const mainWin = createWindow\(\);/.test(src) && /win\.loadFile\(path\.join\(__dirname, "renderer", "index\.html"\)\);\n  return win;\n\}/.test(src));
  { const cp = cut(src, "async function copyOfficialAsync(");
    t("首次安裝的官方檔改非同步拷(fs.promises.cp),規則與順序同 copyOfficial:VERSION 最後、清單在它之前;引擎安裝拿的是這一版、更新同步那條照舊同步",
      /await fs\.promises\.cp\(path\.join\(REPO, d\), path\.join\(WS, d\), \{ recursive: true \}\)/.test(cp) && /if \(f === "VERSION"\) writeOfficialManifest\(\); await fs\.promises\.cp\(path\.join\(REPO, f\), path\.join\(WS, f\)\);/.test(cp)
      && !/cpSync/.test(cp) && /copyOfficial: copyOfficialAsync,/.test(src) && /\n    copyOfficial\(\);\n/.test(cut(src, "function syncOfficialOnUpdate(")));
    const es = fs.readFileSync(path.join(SHELL, "enginesetup.js"), "utf8");
    t("enginesetup 等 copyOfficial 拷完(await)", (es.match(/await o\.copyOfficial\(\)/g) || []).length === 2 && !/[^t] o\.copyOfficial\(\)/.test(es)); }

  // ── ③ GPU 退路(Wei 拍板收窄:只記這次啟動第一次 ready-to-show 之前掛的;加復原) ──
  t("gpuOffMark:只有 win32 + GPU + 非 clean-exit + 第一格畫出來之前 + 這次沒關著硬體加速", G.gpuOffMark("win32", "GPU", "crashed", true, false) && G.gpuOffMark("win32", "GPU", "killed", true, false) && G.gpuOffMark("win32", "GPU", "launch-failed", true, false)
    && !G.gpuOffMark("win32", "GPU", "crashed", false, false) && !G.gpuOffMark("win32", "GPU", "crashed", undefined, false) && !G.gpuOffMark("win32", "GPU", "crashed", true, true)
    && !G.gpuOffMark("win32", "GPU", "clean-exit", true, false) && !G.gpuOffMark("darwin", "GPU", "crashed", true, false) && !G.gpuOffMark("win32", "Utility", "crashed", true, false) && !G.gpuOffMark("win32", "Renderer", "crashed", true, false));
  { const DAY = 86400000, NOW = Date.UTC(2026, 10, 14), B = (o) => G.gpuOffBoot(JSON.stringify(o), NOW), flag = (x) => ({ theme: "dark", gpuOff: { v: "0.1.55", reason: "crashed", at: NOW - DAY, ok: 0, ...x } });
    t("gpuOffBoot:沒有檔、壞 JSON、沒有鍵、鍵不是物件 → 不關、不清", [G.gpuOffBoot("", NOW), G.gpuOffBoot("{bad", NOW), G.gpuOffBoot("null", NOW), B({}), B({ gpuOff: true }), B({ gpuOff: null }), B({ gpuOff: [1] })].every((r) => !r.off && !r.clear));
    t("gpuOffBoot:旗標新、正常結束不到 3 次 → 這次關硬體加速", [0, 1, 2].every((ok) => { const r = B(flag({ ok })); return r.off && !r.clear; }));
    t("gpuOffBoot:關著正常結束滿 3 次 → 這次開回 GPU、清旗標(recovered)", (() => { const r = B(flag({ ok: G.GPU_OK_RUNS })); return !r.off && r.clear && r.why === "recovered"; })() && G.GPU_OK_RUNS === 3);
    t("gpuOffBoot:超過 30 天 → 開回 GPU、清旗標(expired);29 天還關著;時間戳壞掉或在未來也算過期", (() => { const a = B(flag({ at: NOW - 30 * DAY })), b = B(flag({ at: NOW - 29 * DAY })), c = B(flag({ at: "x" })), d = B(flag({ at: NOW + DAY })); return !a.off && a.clear && a.why === "expired" && b.off && !b.clear && c.clear && d.clear; })() && G.GPU_OFF_MAX_DAYS === 30);
    t("gpuOffBoot:同一台第二次記到(gpuOffTrips ≥ 2)→ 正常結束次數不再清,只剩 30 天那條", (() => { const s = { ...flag({ ok: 9 }), gpuOffTrips: 2 }, r = B(s), e = B({ ...s, gpuOff: { ...s.gpuOff, at: NOW - 31 * DAY } }); return r.off && !r.clear && e.clear && e.why === "expired"; })());
    const p1 = G.gpuOffPatch({ theme: "dark" }, "0.1.55", "crashed", NOW), p2 = G.gpuOffPatch({ gpuOffTrips: 1 }, "0.1.56", "killed", NOW);
    t("gpuOffPatch:新旗標 ok 從 0 算,trips 累加", JSON.stringify(p1) === JSON.stringify({ gpuOff: { v: "0.1.55", reason: "crashed", at: NOW, ok: 0 }, gpuOffTrips: 1 }) && p2.gpuOffTrips === 2);
    t("gpuOkPatch:ok + 1、其他欄位不動;沒有旗標回 null", G.gpuOkPatch(flag({ ok: 2 })).gpuOff.ok === 3 && G.gpuOkPatch(flag({ ok: 2 })).gpuOff.reason === "crashed" && G.gpuOkPatch({ gpuOff: null }) === null && G.gpuOkPatch({}) === null); }
  { // 整條來回:照 main.js 原文跑 childGoneNote / gpuOkRun / gpuBootClear 與 uiPrefsPatch,寫進真的 gpu-boot.json,啟動那一段用 gpuOffBoot 判;
    // ui-prefs.json 是 0.1.54 判新裝的記號之一(mainmarket INSTALL_MARKS),GPU 退路一個位元組都不能寫進去
    const dir = fs.mkdtempSync(path.join(ROOT, "ud-")), prefsFile = path.join(dir, "gpu-boot.json"), uiFile = path.join(dir, "ui-prefs.json"), UI = JSON.stringify({ theme: "dark" }); fs.writeFileSync(uiFile, UI);
    const logs = [], read = () => { try { return fs.readFileSync(prefsFile, "utf8"); } catch (_) { return ""; } }, boot = () => G.gpuOffBoot(read(), Date.now());
    const fns = ["function childGoneNote(", "function gpuBootClear(", "function gpuOkRun(", "function uiPrefsPatch("].map((h) => cut(src, h)).join("\n");
    const call = (name, arg, state = {}) => {
      const env = { process: { platform: state.platform || "win32" }, app: { getVersion: () => "0.1.55", hasSingleInstanceLock: () => state.lock !== false }, require: (m) => (m === "./bootguard" ? G : require(m)), mainLog: { write: (m) => logs.push(m) },
        fs, JSON, Date, Number, String, quitDone: false, quitting: false, quitConfirmed: false, restarting: null, mainFirstPaint: false, GPU_BOOT: { off: false, clear: false, why: null }, ...state,
        uiPrefsPath: () => uiFile, gpuBootPath: () => prefsFile };
      return new Function("env", "a", `with (env) { ${fns}\n return ${name}(a); }`)(env, arg);
    };
    const gone = (d, st) => call("childGoneNote", d, st);
    t("mac 上 GPU 掛:只記 log、不寫旗標", gone({ type: "GPU", reason: "crashed", exitCode: 3 }, { platform: "darwin" }) === false && !boot().off && logs.some((l) => l === "[proc] child-process-gone type=GPU reason=crashed exit=3"));
    t("Windows GPU clean-exit / 其他行程:不寫", gone({ type: "GPU", reason: "clean-exit" }) === false && gone({ type: "Utility", reason: "crashed" }) === false && !boot().off);
    t("第一格畫出來之後才掛(登出、驅動更新 TDR、遠端桌面重連):不寫", gone({ type: "GPU", reason: "crashed" }, { mainFirstPaint: true }) === false && gone({ type: "GPU", reason: "killed" }, { mainFirstPaint: true }) === false && !boot().off);
    t("結束中、更新重開時、第二份 app、這次已經關著:不寫", [{ quitting: true }, { quitDone: true }, { quitConfirmed: true }, { restarting: "x" }, { lock: false }, { GPU_BOOT: { off: true } }].every((st) => gone({ type: "GPU", reason: "killed" }, st) === false) && !boot().off);
    t("第一格之前 GPU 非正常結束:寫進 gpu-boot.json(trips 1)、ui-prefs.json 不動;下次啟動關硬體加速", gone({ type: "GPU", reason: "crashed", exitCode: -1 }) === true && boot().off && fs.readFileSync(uiFile, "utf8") === UI && JSON.parse(read()).gpuOffTrips === 1
      && logs.some((l) => /before first paint: hardware acceleration off from next launch/.test(l)));
    const off = { GPU_BOOT: { off: true, clear: false, why: null } };
    const r1 = call("gpuOkRun", null, off), r2 = call("gpuOkRun", null, off), mid = boot().off, r3 = call("gpuOkRun", null, off);
    t("關著正常結束三次:每次 ok + 1、記一行;第三次之後下次啟動判 recovered", r1 && r2 && r3 && mid && JSON.parse(read()).gpuOff.ok === 3 && boot().clear && boot().why === "recovered" && logs.filter((l) => /clean exit with hardware acceleration off/.test(l)).length === 3);
    t("沒關著、第二份 app:不算正常結束次數", call("gpuOkRun", null, {}) === false && call("gpuOkRun", null, { ...off, lock: false }) === false && JSON.parse(read()).gpuOff.ok === 3);
    const clr = { GPU_BOOT: boot() };
    t("gpuBootClear:判 recovered 的那次 ready 後清旗標、log 寫原因;trips 留著;第二份 app 不清", call("gpuBootClear", null, { ...clr, lock: false }) === false && call("gpuBootClear", null, clr) === true && !boot().off && !boot().clear && JSON.parse(read()).gpuOffTrips === 1
      && logs.some((l) => l === "[boot] GPU fallback flag cleared (recovered): hardware acceleration back on"));
    t("記、復原、清整輪下來 ui-prefs.json 原封不動,也沒留暫存檔", fs.readFileSync(uiFile, "utf8") === UI && !fs.readdirSync(dir).some((f) => /blave-tmp/.test(f)));
    t("復原後第一格之前又掛:再記(trips 2),之後正常結束再多次也不清,只剩 30 天", gone({ type: "GPU", reason: "crashed" }) === true && JSON.parse(read()).gpuOffTrips === 2
      && [1, 2, 3, 4].every(() => call("gpuOkRun", null, off)) && boot().off && !boot().clear);
    t("log 只寫列舉與數字,不寫 Electron 給的其他欄位(serviceName / name)", gone({ type: "Utility", reason: "crashed", exitCode: 1, serviceName: "C:\\Users\\SECRET", name: "SECRET" }, { platform: "darwin" }) === false && !logs.join().includes("SECRET")); }
  { const top = src.slice(0, src.indexOf("function headlessOn("));
    t("啟動:只有 win32 才讀旗標;在頂層同步讀 gpu-boot.json(ready 之前、不讀 ui-prefs.json)、不借 uiPrefsPath(那時還沒宣告);只有判 off 才關硬體加速",
      /if \(process\.platform === "win32"\) \{[\s\S]*?gpu-boot\.json[\s\S]*?GPU_BOOT = require\("\.\/bootguard"\)\.gpuOffBoot\(prefs, Date\.now\(\)\);\n  if \(GPU_BOOT\.off\) \{ app\.disableHardwareAcceleration\(\);/.test(top) && !/uiPrefsPath/.test(top.replace(/\/\/.*$/gm, "")) && (src.match(/disableHardwareAcceleration\(/g) || []).length === 1
      && !/ui-prefs\.json/.test(top.slice(top.indexOf("let GPU_BOOT"), top.indexOf("GPU_BOOT = require")).replace(/\/\/.*$/gm, "")));
    t("接線:主視窗第一次 ready-to-show 設 mainFirstPaint;childGoneNote 帶 !mainFirstPaint 與 GPU_BOOT.off;ready 後清、will-quit 記正常結束",
      /win\.once\("ready-to-show", \(\) => \{ mainFirstPaint = true;/.test(cut(src, "function createWindow(")) && /gpuOffMark\(process\.platform, type, reason, !mainFirstPaint, GPU_BOOT\.off\)/.test(src)
      && /startStep\("gpu flag", gpuBootClear\);/.test(cut(src, "app.whenReady().then(")) && /app\.on\("will-quit", \(\) => startStep\("gpu ok run", gpuOkRun\)\);/.test(src)
      && src.indexOf('startStep("gpu flag", gpuBootClear)') > src.indexOf("const mainWin = createWindow();"));
    t("寫旗標的那一支另外掛 listener;既有 crashWatch 那條原封不動(gpu_gone 遙測照舊)", /app\.on\("child-process-gone", \(_e, d\) => \{ try \{ childGoneNote\(d\); \} catch \(_\) \{/.test(src) && /app\.on\("child-process-gone", \(_e, d\) => \{ if \(!quitting\) crashWatch\(\)\.childGone\(d && d\.type, d && d\.reason\); \}\);/.test(src)); }

  // ── ④ 主視窗 show:false + ready-to-show + 保底 ──
  const win = (vis = false) => { const w = new EventEmitter(); w.shown = 0; w.isDestroyed = () => false; w.isVisible = () => vis || w.shown > 0; w.show = () => { w.shown++; }; return w; };
  { const c = clock(), w = win(), logs = [];
    G.showWhenReady(w, { setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, log: (m) => logs.push(m), skip: () => false });
    t("showWhenReady:ready-to-show 之前不顯示", w.shown === 0);
    w.emit("ready-to-show"); c.advance(10000); w.emit("ready-to-show");
    t("…ready-to-show 顯示一次、保底收掉、記一行", w.shown === 1 && c.pending() === 0 && logs.join() === "[boot] main window shown (ready-to-show)"); }
  { const c = clock(), w = win(), logs = [];
    G.showWhenReady(w, { setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, log: (m) => logs.push(m), skip: () => false });
    c.advance(G.SHOW_FALLBACK_MS - 1); const before = w.shown; c.advance(1); w.emit("ready-to-show");
    t("showWhenReady:ready-to-show 一直不來(GPU 掛了、頁面卡住),保底 3 秒強制顯示、只一次", before === 0 && w.shown === 1 && G.SHOW_FALLBACK_MS === 3000 && /fallback/.test(logs.join())); }
  { const c = clock(), w = win(); let closing = false;
    G.showWhenReady(w, { setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, skip: () => closing });
    closing = true; c.advance(G.SHOW_FALLBACK_MS);
    const c2 = clock(), w2 = win(); w2.isDestroyed = () => true; G.showWhenReady(w2, { setTimeout: c2.setTimeout, clearTimeout: c2.clearTimeout }); w2.emit("ready-to-show");
    const c3 = clock(), w3 = win(true); G.showWhenReady(w3, { setTimeout: c3.setTimeout, clearTimeout: c3.clearTimeout }); w3.emit("ready-to-show");
    t("showWhenReady:結束中、已銷毀不顯示;已經被 showMain 叫出來的不再 show 一次", w.shown === 0 && w2.shown === 0 && w3.shown === 0); }
  { const cw = cut(src, "function createWindow(");
    t("createWindow:一律 show:false + paintWhenInitiallyHidden;只有不是 HEADLESS 也不是隱藏重開那一扇才掛 showWhenReady(結束中不顯示)",
      /\n    show: false, paintWhenInitiallyHidden: true,\n/.test(cw) && /\n  if \(!HEADLESS && !bgBoot\) require\("\.\/bootguard"\)\.showWhenReady\(win, \{ log: \(m\) => mainLog\.write\(m\), skip: \(\) => quitting \|\| quitDone \}\);\n  bgBoot = false;/.test(cw)
      && (cw.match(/showWhenReady\(/g) || []).length === 1 && !/\.show\(\)/.test(cw)); }

  t("兩支新模組進包(electron-builder files;漏了打包版一開就炸)", /files:\s*\[[^\]]*"bootguard\.js"/.test(cfg) && /files:\s*\[[^\]]*"mainlog\.js"/.test(cfg));
} catch (e) { t("沒有例外", false, String((e && e.stack) || e)); }
finally { fs.rmSync(ROOT, { recursive: true, force: true }); }
console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0);
