// 0.1.52 新人流失調查補的五個埋點(spec desktop-telemetry-gaps):data_card_shown、app_quit、app_crash、turn_fail_why,
// 以及 engine_setup 的 first_abort。engine_fail 的判定與 pre 在 tests/check_shell_engine_setup.js(spec 指定的位置)。
// 不起 Electron:主行程那幾段從 main.js 原文切出來,在假的 app / 視窗上跑。
// 跑法:node tests/check_shell_telemetry_gaps.js(BLAVE_API_DIR 指 api 那一份時另比對白名單;BLAVE_HOME 有給就把暫存檔放那底下)
const fs = require("fs"), os = require("os"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const T = require(path.join(SHELL, "telemetry.js"));
const { EVENTS, FROM_RENDERER } = T;
let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || d === undefined ? "" : "  ← " + JSON.stringify(d).slice(0, 800))); if (!ok) red++; };
const mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8"), appSrc = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
const tmSrc = fs.readFileSync(path.join(SHELL, "telemetry.js"), "utf8");
const cut = (src, head) => { const i = src.indexOf(head); if (i < 0) throw new Error("找不到 " + head); let d = 0; for (let k = src.indexOf("{", src.indexOf(")", i)); k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } throw new Error("切不出 " + head); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// run_all 給的 BLAVE_HOME 還沒建出來,先建父目錄
const TMP_BASE = path.isAbsolute(process.env.BLAVE_HOME || "") ? process.env.BLAVE_HOME : os.tmpdir();
fs.mkdirSync(TMP_BASE, { recursive: true });
const ROOT = fs.mkdtempSync(path.join(TMP_BASE, "tel-gaps-"));

const NEW = {
  data_card_shown: ["state", ["trial", "no_trial"]],
  app_quit: ["screen", ["connect", "workspace", "library", "settings", "other"]],
  app_crash: ["kind", ["rend_crash", "rend_oom", "rend_killed", "rend_launch", "gpu_gone", "main_exc", "main_rej", "unresp", "unclean_exit"]],
  engine_fail: ["why", ["pre", "ws_disk", "ws_perm", "ws_other", "venv_spawn", "venv_ensurepip", "venv_exit", "venv_timeout", "sdk_net", "sdk_nowheel", "sdk_resolve", "sdk_hash", "sdk_disk", "sdk_perm", "sdk_other", "sdk_timeout", "pkg_net", "pkg_nowheel", "pkg_resolve", "pkg_hash", "pkg_disk", "pkg_perm", "pkg_other", "pkg_timeout"]],
  turn_fail_why: ["why", ["no_reply", "exit_nonzero", "err_chunk", "err_card", "timeout", "network"]],
};

(async () => { try {
  // ── 白名單:外殼這份、api 那份逐字逐序相同;名字與值 ≤16 字;每日去重;只有兩個准畫面送 ──
  t("五個事件在外殼白名單上:一個屬性、值逐序、名字與值 ≤16 字", Object.keys(NEW).every((ev) => JSON.stringify(EVENTS[ev]) === JSON.stringify({ [NEW[ev][0]]: NEW[ev][1] }) && ev.length <= 16 && NEW[ev][1].every((v) => v.length <= 16)));
  t("engine_setup 的最後一個值是 first_abort", EVENTS.engine_setup.result[EVENTS.engine_setup.result.length - 1] === "first_abort");
  t("五個都每日去重(DAILY)、不是 ONCE", Object.keys(NEW).every((ev) => new RegExp('const DAILY = \\[[^\\]]*"' + ev + '"').test(tmSrc) && !new RegExp('const ONCE = \\[[^\\]]*"' + ev + '"').test(tmSrc)));
  t("畫面只准送 data_card_shown / turn_fail_why;app_quit / app_crash / engine_fail 由主行程送", FROM_RENDERER.includes("data_card_shown") && FROM_RENDERER.includes("turn_fail_why") && !["app_quit", "app_crash", "engine_fail"].some((e) => FROM_RENDERER.includes(e)));
  const apiPy = path.join(process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), "openclaw", "desktop_telemetry.py");
  if (!fs.existsSync(apiPy)) console.log("SKIP  api 白名單比對(設 BLAVE_API_DIR 或用 monorepo 版面)");
  else {
    const got = {};
    for (const m of fs.readFileSync(apiPy, "utf8").matchAll(/"([a-z_]+)": \{"props": \{"([a-z_]+)": \(([^()]*)\)\}, "once": (True|False)\}/g)) got[m[1]] = { key: m[2], vals: [...m[3].matchAll(/"([^"]+)"/g)].map((v) => v[1]), once: m[4] === "True" };
    t("api desktop_telemetry.EVENTS 的五個事件 = 外殼這份(屬性名、值、順序、once=False)——api 還沒上就紅,出貨順序 api 先", Object.keys(NEW).every((ev) => got[ev] && got[ev].key === NEW[ev][0] && JSON.stringify(got[ev].vals) === JSON.stringify(EVENTS[ev][NEW[ev][0]]) && got[ev].once === false), Object.keys(NEW).map((ev) => [ev, got[ev]]));
    t("api 的 engine_setup = 外殼這份(含 first_abort,逐序)", !!got.engine_setup && JSON.stringify(got.engine_setup.vals) === JSON.stringify(EVENTS.engine_setup.result));
  }
  // track() 真的送得出去、表外的值擋掉
  { const sent = [], tm = T.createTelemetry({ dir: fs.mkdtempSync(path.join(ROOT, "tm-")), endpoint: "https://x/t", appVersion: "0.1.52", osVersion: "15.5", lang: "zh-TW", post: (u, b) => { sent.push(b); return Promise.resolve({ status: 200 }); } });
    const okAll = Object.keys(NEW).every((ev) => NEW[ev][1].every((v) => tm.track(ev, { [NEW[ev][0]]: v, msg: "SECRET" }) === true));
    const bad = Object.keys(NEW).every((ev) => tm.track(ev, { [NEW[ev][0]]: "C:\\Users\\SECRET" }) === false);
    await sleep(5);
    t("每個值都出得了門、表外的值不送、多塞的欄位不出門", okAll && bad && sent.length > 0 && sent.every((b) => Object.keys(b.props).length === 1 && !JSON.stringify(b).includes("SECRET")));
    t("…同日同值不重送", tm.track("app_quit", { screen: "connect" }) === false); }

  // ── app_crash:renderer 掛掉的分類與「只自動重載一次」──
  { const R = T.rendGoneKind;
    t("rendGoneKind:crashed / abnormal-exit / integrity-failure / 沒見過的 → rend_crash;oom、memory-eviction → rend_oom;killed;launch-failed;clean-exit 不算",
      R("crashed") === "rend_crash" && R("abnormal-exit") === "rend_crash" && R("integrity-failure") === "rend_crash" && R("something-new") === "rend_crash" && R("oom") === "rend_oom" && R("memory-eviction") === "rend_oom"
      && R("killed") === "rend_killed" && R("launch-failed") === "rend_launch" && R("clean-exit") === null);
    const kinds = [], reloads = [];
    const w = T.createCrashWatch({ track: (k) => kinds.push(k), reload: (x) => reloads.push(x) });
    const r1 = w.rendGone("crashed", "wc"), r2 = w.rendGone("oom", "wc"), r3 = w.rendGone("crashed", "wc");
    t("第一次掉:記一則 + 重新載入;第二次、第三次:只記、不再重載", r1 === true && r2 === false && r3 === false && reloads.length === 1 && kinds.join() === "rend_crash,rend_oom,rend_crash", { kinds, reloads });
    const w2 = T.createCrashWatch({ track: (k) => kinds.push(k), reload: () => reloads.push("x") }); const n0 = kinds.length;
    t("clean-exit:不記、不重載(也不吃掉那一次重載的額度)", w2.rendGone("clean-exit", "wc") === false && kinds.length === n0 && w2.rendGone("crashed", "wc") === true);
    const w3 = T.createCrashWatch({ track: () => { throw new Error("down"); }, reload: () => { throw new Error("gone"); } });
    t("追蹤或重載拋例外都不往外丟", (() => { try { return w3.rendGone("crashed", "wc") === false; } catch (_) { return false; } })());
    const g = []; const w4 = T.createCrashWatch({ track: (k) => g.push(k), reload: () => {} });
    w4.childGone("GPU", "crashed"); w4.childGone("GPU", "clean-exit"); w4.childGone("Utility", "crashed");
    t("child-process-gone:只有 GPU 而且不是 clean-exit 才記 gpu_gone", g.join() === "gpu_gone"); }

  // main.js 的 rendGone:只認主視窗、結束中不算;真的切出來跑
  { const SRC = ["function crashTrack(", "function crashWatch(", "function rendGone("].map((h) => cut(mainSrc, h)).join("\n");
    const rig = (o = {}) => {
      const tracked = [], reloads = [];
      const ctx = { quitDone: false, quitting: false, quitConfirmed: false, restarting: null, _crash: null, isOurPageUrl: (u) => u === "file:///index.html",
        app: { isReady: () => o.ready !== false, once: (ev, f) => { if (ev === "ready") ctx.later = f; } },
        tm: () => ({ track: (ev, p) => tracked.push(ev + ":" + p.kind) }), require: (m) => (m === "./telemetry" ? T : require(m)), ...o.ctx };
      new Function("ctx", "with (ctx) { " + SRC + "\n ctx.rendGone = rendGone; ctx.crashTrack = crashTrack; }")(ctx);
      const wc = (url, destroyed) => ({ getURL: () => url, isDestroyed: () => !!destroyed, reload: () => reloads.push(url) });
      return { ctx, tracked, reloads, wc };
    };
    let r = rig();
    r.ctx.rendGone(r.wc("file:///index.html"), { reason: "crashed" }); r.ctx.rendGone(r.wc("file:///index.html"), { reason: "crashed" });
    t("主視窗掉兩次:記兩則、只重載第一次", r.tracked.join() === "app_crash:rend_crash,app_crash:rend_crash" && r.reloads.length === 1, r);
    r = rig(); r.ctx.rendGone(r.wc("https://example.com/"), { reason: "crashed" });
    t("內建瀏覽器／別的頁:不記、不重載", r.tracked.length === 0 && r.reloads.length === 0);
    for (const k of ["quitting", "quitConfirmed", "restarting"]) {
      r = rig({ ctx: { [k]: k === "restarting" ? "installing" : true } }); r.ctx.rendGone(r.wc("file:///index.html"), { reason: "killed" });
      t("結束中(" + k + "):不記、不重載", r.tracked.length === 0 && r.reloads.length === 0);
    }
    r = rig(); r.ctx.rendGone(r.wc("file:///index.html", true), { reason: "crashed" });
    t("webContents 已經沒了:不碰它", r.tracked.length === 0 && r.reloads.length === 0);
    r = rig({ ctx: { quitDone: true } }); r.ctx.rendGone(r.wc("file:///index.html"), { reason: "crashed" }); r.ctx.crashTrack("gpu_gone");
    t("will-quit 之後(一般結束、沒有東西要收的那條):掛掉的不記、不重載", r.tracked.length === 0 && r.reloads.length === 0);
    r = rig({ ready: false }); r.ctx.crashTrack("main_exc");
    t("ready 之前發生的:等 ready 再送(tm() 建立時要讀 getLocale)", r.tracked.length === 0 && typeof r.ctx.later === "function" && (r.ctx.later(), r.tracked.join() === "app_crash:main_exc")); }

  // 主行程的接線:只聽不改(Monitor、warning),不掛 uncaughtException / unhandledRejection 的處理器
  t("接線:render-process-gone → rendGone、child-process-gone → childGone、視窗 unresponsive → unresp(只認主視窗)",
    /app\.on\("render-process-gone", \(_e, wc, d\) => \{ try \{ rendGone\(wc, d\); \}/.test(mainSrc) && /app\.on\("child-process-gone", \(_e, d\) => \{ if \(!quitting\) crashWatch\(\)\.childGone\(d && d\.type, d && d\.reason\); \}\);/.test(mainSrc)
    && /win\.on\("unresponsive", \(\) => \{ try \{ if \(isOurPageUrl\(win\.webContents\.getURL\(\)\)\) crashTrack\("unresp"\); \}/.test(mainSrc));
  t("接線:未接的例外用 uncaughtExceptionMonitor(origin 分 main_exc / main_rej)、warn 模式的 Promise 聽 warning;沒有掛會改變預設行為的處理器",
    /process\.on\("uncaughtExceptionMonitor", \(_err, origin\) => crashTrack\(origin === "unhandledRejection" \? "main_rej" : "main_exc"\)\);/.test(mainSrc)
    && /process\.on\("warning", \(w\) => \{ if \(w && w\.name === "UnhandledPromiseRejectionWarning"\) crashTrack\("main_rej"\); \}\);/.test(mainSrc)
    && !/process\.on\("uncaughtException"/.test(mainSrc) && !/process\.on\("unhandledRejection"/.test(mainSrc));

  // ── unclean_exit:session 檔 ──
  { const f = path.join(ROOT, "s1", "state", "session.json");
    t("沒有檔(新安裝、舊版升上來):不算沒正常結束;寫成 clean:false", T.sessionOpen(f) === false && JSON.parse(fs.readFileSync(f, "utf8")).clean === false);
    t("上次沒走到 will-quit(檔還是 false)→ 這次 true", T.sessionOpen(f) === true);
    T.sessionClose(f);
    t("正常結束寫回 true → 下次 false", JSON.parse(fs.readFileSync(f, "utf8")).clean === true && T.sessionOpen(f) === false);
    fs.writeFileSync(f, "{broken");
    t("檔壞了:當成正常、照樣重寫", T.sessionOpen(f) === false && JSON.parse(fs.readFileSync(f, "utf8")).clean === false);
    t("寫不了(路徑上有同名檔)不拋", (() => { try { const blk = path.join(ROOT, "blk"); fs.writeFileSync(blk, "x"); T.sessionOpen(path.join(blk, "state", "session.json")); T.sessionClose(path.join(blk, "state", "session.json")); return true; } catch (_) { return false; } })());
    t("接線:ready 後拿到單一實例鎖才開(第二份 app 讀到的是第一份那筆)、will-quit 與 Windows session-end 寫回、檔在 BASE/state",
      /if \(app\.hasSingleInstanceLock\(\)\) startStep\("session mark", sessionBoot\);/.test(mainSrc)
      && /app\.on\("will-quit", \(\) => \{ quitDone = true; if/.test(mainSrc)
      && /app\.on\("will-quit", \(\) => \{ quitDone = true; if \(app\.hasSingleInstanceLock\(\)\) require\("\.\/telemetry"\)\.sessionClose\(sessionFile\(\)\); \}\);/.test(mainSrc)
      && /win\.on\("session-end", \(\) => \{ if \(app\.hasSingleInstanceLock\(\)\) require\("\.\/telemetry"\)\.sessionClose\(sessionFile\(\)\); \}\);/.test(mainSrc)
      && /const sessionFile = \(\) => path\.join\(BASE, "state", "session\.json"\);/.test(mainSrc)
      && mainSrc.indexOf('startStep("session mark"') > mainSrc.indexOf("app.whenReady().then(() => {"));
    // sessionBoot 真的切出來跑:上次沒正常結束 → 補一則 unclean_exit;新安裝 BASE 還不在 → 建成 0700(同引擎安裝那一步)
    const boot = (base) => { const tracked = []; const ctx = { BASE: base, fs, require: (m) => (m === "./telemetry" ? T : require(m)), sessionFile: () => path.join(base, "state", "session.json"), crashTrack: (k) => tracked.push(k) };
      new Function("ctx", "with (ctx) { " + cut(mainSrc, "function sessionBoot(") + "\n ctx.boot = sessionBoot; }")(ctx); ctx.boot(); return tracked; };
    const nb = path.join(ROOT, "newhome", "Blave");
    t("sessionBoot:新安裝不報;再開一次(上一次沒走到 will-quit)報 unclean_exit", boot(nb).length === 0 && boot(nb).join() === "unclean_exit");
    if (process.platform !== "win32") t("…BASE 由它先建時是 0700", (fs.statSync(nb).mode & 0o777) === 0o700, (fs.statSync(nb).mode & 0o777).toString(8)); }

  // ── app_quit + first_abort:before-quit 那段等待 ──
  { const SRC = ["function quitScreenRead(", "function quitTelOnce(", "function quitTelemetry("].map((h) => cut(mainSrc, h)).join("\n");
    const rig = (o = {}) => {
      const sent = [];
      const win = o.win === null ? null : { isDestroyed: () => false, webContents: { executeJavaScript: (js) => (o.hangPage ? new Promise(() => {}) : /quitScreen\(\)/.test(js) ? Promise.resolve(o.screen || "workspace") : Promise.resolve(null)) } };
      const ctx = { QUIT_TEL_MS: o.ms || 1500, quitScreenSeen: o.seen || null, quitTelSent: false, draftMainWin: () => win, telemetryLive: () => o.live !== false,
        _engineSetup: o.eng ? { snapshot: () => o.eng } : null,
        tm: () => ({ isEnabled: () => o.enabled !== false, track: (ev, p, done) => { if (o.off) return false; sent.push(ev + ":" + Object.values(p)[0]); if (!o.hangPost) setTimeout(() => done({ status: 200 }), 5); return true; } }) };
      new Function("ctx", "with (ctx) { " + SRC + "\n ctx.quitScreenRead = quitScreenRead; ctx.quitTelOnce = quitTelOnce; ctx.quitTelemetry = quitTelemetry; }")(ctx);
      return { ctx, sent };
    };
    // 「沒等滿」不量牆鐘上限(並行跑時機器忙會假紅):把等待窗開到 60 秒,10 秒內收尾就是沒等滿
    const within = (p) => Promise.race([p.then(() => true), sleep(10000).then(() => false)]);
    let r = rig({ screen: "connect", eng: { phase: "run", kind: "first" }, ms: 60000 }); let t0 = Date.now(); const fast = await within(r.ctx.quitTelemetry());
    t("第一次安裝裝到一半、停在選引擎畫面結束:送 app_quit connect + engine_setup first_abort,送完就走(不等滿)", fast && r.sent.sort().join() === "app_quit:connect,engine_setup:first_abort", r.sent);
    r = rig({ eng: { phase: "run", kind: "update" } }); await r.ctx.quitTelemetry();
    t("更新的安裝被關掉不是 first_abort", r.sent.join() === "app_quit:workspace", r.sent);
    r = rig({ eng: { phase: "done", kind: "first" } }); await r.ctx.quitTelemetry();
    t("裝好了才結束:不送 first_abort", r.sent.join() === "app_quit:workspace");
    r = rig({ win: null, seen: "settings" }); await r.ctx.quitTelemetry();
    t("按視窗關閉鈕結束(走到 before-quit 頁面已經沒了):用關窗那一下讀到的畫面", r.sent.join() === "app_quit:settings", r.sent);
    r = rig({ win: null }); await r.ctx.quitTelemetry();
    t("…也沒讀到:other", r.sent.join() === "app_quit:other");
    r = rig({ hangPage: true, ms: 60000 }); t0 = Date.now(); const hp = await within(r.ctx.quitTelemetry());
    t("頁面不回(卡住):半秒後用 other 照送", hp && r.sent.join() === "app_quit:other" && Date.now() - t0 >= 450, Date.now() - t0);
    r = rig({ hangPost: true, ms: 300 }); t0 = Date.now(); const hq = await within(r.ctx.quitTelemetry()); const dt = Date.now() - t0;
    t("送不出去(post 一直沒回):等滿 QUIT_TEL_MS 就走", hq && r.sent.length === 1 && dt >= 280, dt);
    r = rig({ off: true, ms: 60000 });
    t("track 沒排出門(關了):不等", (await within(r.ctx.quitTelemetry())) && r.sent.length === 0);
    t("quitTelOnce:開發版(不送)/ 追蹤關著 → 不擋;會送 → 整次結束只擋一次", rig({ live: false }).ctx.quitTelOnce() === false && rig({ enabled: false }).ctx.quitTelOnce() === false
      && (() => { const x = rig(); return x.ctx.quitTelOnce() === true && x.ctx.quitTelOnce() === false; })());
    const seenR = rig({ screen: "library" }); await seenR.ctx.quitScreenRead({ isDestroyed: () => false, webContents: { executeJavaScript: () => Promise.resolve("library") } });
    t("quitScreenRead(win) 讀到的記下來,之後頁面沒了照用", seenR.ctx.quitScreenSeen === "library"); }

  // before-quit 本體:問過的框都過了,先擋一次等埋點、再 app.quit();第二輪照舊;更新重開不擋
  { const BQ = cut(mainSrc, 'app.on("before-quit", (e) =>');
    const rig = (o = {}) => {
      const log = [];
      let once = o.once !== false;
      const ctx = { restarting: o.restarting || null, quitting: false, quitConfirmed: false, draftOk: true, quitAsking: false, moveAsking: false,
        tradeMaybeLive: () => null, twLots: () => ({ held: false }), anyTurnOrQueued: () => false, _tradeHost: null, _engineSetup: null, _codexPkg: null,
        engineAbort: () => Promise.resolve(false), app: { quit: () => log.push("app.quit"), on: (_n, f) => { ctx.handler = f; } },
        quitTelOnce: () => { const v = once; once = false; return v; }, quitTelemetry: () => { log.push("tel"); return Promise.resolve(); } };
      new Function("ctx", "with (ctx) { " + BQ + "); }")(ctx);
      const fire = () => { const e = { prevented: false, preventDefault() { this.prevented = true; } }; ctx.handler(e); return e; };
      return { ctx, log, fire };
    };
    let r = rig(); const e1 = r.fire(); await sleep(5); const e2 = r.fire();
    t("沒有東西要收:第一輪擋下、等埋點、再 app.quit();第二輪(app.quit 回來)照常放行", e1.prevented && r.log.join() === "tel,app.quit" && !e2.prevented, r.log);
    r = rig({ restarting: "installing" }); const e3 = r.fire();
    t("更新重開(quitAndInstall)途中:不為埋點擋,不送", !e3.prevented && r.log.length === 0, r.log);
    r = rig({ once: false }); const e4 = r.fire();
    t("開發版／追蹤關著:不擋(跟以前一樣)", !e4.prevented && r.log.length === 0);
    t("接線:關窗那一下(真的要關的那條)先讀畫面,在 draftGate 之前", /e\.preventDefault\(\);\n\s*if \(typeof quitScreenRead === "function"\) quitScreenRead\(win\);[^\n]*\n\s*if \(!quitAsking && !moveAsking\) draftGate\(win\)/.test(cut(mainSrc, 'app.on("browser-window-created", (_e, win) => {\n  win.on("show"'))); }

  // ── 畫面:renderer/app.js quitScreen ──
  { const f = new Function("document", cut(appSrc, "function quitScreen(") + "; return quitScreen;");
    const doc = (vis) => ({ getElementById: (id) => (id in vis ? { hidden: !vis[id] } : null) });
    const q = (vis) => f(doc(vis))();
    t("quitScreen:連結畫面優先;設定框;策略庫;工作頁;都不是 → other", q({ "view-connect": true, "view-ws": false }) === "connect" && q({ "view-connect": false, "set-scrim": true, "view-ws": true }) === "settings"
      && q({ "view-connect": false, "set-scrim": false, lib: true, "view-ws": true }) === "library" && q({ "view-connect": false, "set-scrim": false, lib: false, "view-ws": true }) === "workspace" && q({}) === "other");
    t("…回傳的值都在 app_quit 白名單上", [{ "view-connect": true }, { "set-scrim": true }, { lib: true }, { "view-ws": true }, {}].every((v) => EVENTS.app_quit.screen.includes(q(v)))); }

  // ── turn_fail_why:renderer/app.js turnFailWhy ──
  { const re = appSrc.match(/\nconst TURN_NET_RE = [^\n]+/)[0];
    const f = new Function(re + "\n" + cut(appSrc, "function turnFailWhy(") + "; return turnFailWhy;")();
    const C = [[[1, "Error: connect ECONNREFUSED 127.0.0.1:443", false, false], "network"], [[0, "", true, true], "err_card"], [[0, "", false, true], "err_chunk"],
      [[1, "Traceback (most recent call last):\n  await asyncio.wait_for(x, timeout=30)\nRuntimeError: boom\n", false, false], "exit_nonzero"],
      [[1, "  r = fetch(url)  # Connection error handling\nValueError: bad\n", false, false], "exit_nonzero"],
      [[1, "Traceback ...\nasyncio.exceptions.TimeoutError\n", false, false], "timeout"],
      [[1, "Traceback ...\nRuntimeError: boom", false, false], "exit_nonzero"], [[0, "", false, false], "no_reply"], [[1, "spawn timed out after 30s", false, false], "timeout"],
      [[1, "getaddrinfo ENOTFOUND api.blave.org", true, true], "network"], [[0, undefined, false, false], "no_reply"]];
    t("turnFailWhy:errTail 最後一行的連線字樣 → network、逾時 → timeout(前面的原始碼行不算),其次錯誤卡 > error chunk > 非 0 結束 > 沒有真的回覆", C.every(([a, want]) => f(...a) === want), C.map(([a]) => f(...a)));
    const outs = new Set(); for (const code of [0, 1]) for (const tail of ["", "ECONNRESET", "timed out", "x"]) for (const fa of [true, false]) for (const er of [true, false]) outs.add(f(code, tail, fa, er));
    t("…列舉出來的值 = api 白名單那六個(一個不多、一個不少)", outs.size === EVENTS.turn_fail_why.why.length && [...outs].every((v) => EVENTS.turn_fail_why.why.includes(v)), [...outs]);
    t("送出點:只在 turn_failed 記 other 的那一輪另送,緊接在 turn_failed 之後", /if \(reason\) trackEvent\("turn_failed", \{ reason \}\);\n\s*if \(reason === "other"\) \{ const why = turnFailWhy\(r\.code, r\.errTail, turnFaulted, turnErrored\); trackEvent\("turn_fail_why", \{ why \}\); \}/.test(appSrc)); }

  // ── data_card_shown:renderer/app.js dataCardState 的兩態 + dataCardSync 送出 ──
  { const st = cut(appSrc, "function dataCardState(");
    t("dataCardState:有試用資格又沒卡那態標 trial、沒有含資料的方案那態標 no_trial;其他態不標",
      /if \(da === "plan_required" && acctOffer\(acct\)\) \{\n\s*return \{ calm: true, text: "", \.\.\.gateBtn\(g\), shown: "trial",/.test(st) && /if \(da === "plan_required"\) return \{ text: t\("data\.noPlan"\), \.\.\.gateBtn\(g\), shown: "no_trial" \};/.test(st)
      && (st.match(/shown: "/g) || []).length === 2 && [...st.matchAll(/shown: "([a-z_]+)"/g)].every((m) => EVENTS.data_card_shown.state.includes(m[1])));
    const sync = cut(appSrc, "function dataCardSync(");
    const run = (states) => {
      const sent = []; let i = 0;
      const ctx = { dataCard: { set: () => {}, b1: null }, hasData: () => false, dataCardState: () => states[Math.min(i, states.length - 1)], sysLz: (f) => f(), hasToken: true, authRevoked: () => false, t: (k) => k,
        trackEvent: (ev, p) => sent.push(ev + ":" + p.state) };
      new Function("ctx", "with (ctx) { " + sync + "\n ctx.sync = dataCardSync; }")(ctx);
      for (; i < states.length; i++) ctx.sync({});
      return sent;
    };
    t("卡真的畫上去(字變了)才送;同一態重畫不重送;沒標的態不送", run([{ text: "", label: "bind", shown: "trial" }, { text: "", label: "bind", shown: "trial" }, { text: "a" }, { text: "data.noPlan", label: "plan", shown: "no_trial" }]).join() === "data_card_shown:trial,data_card_shown:no_trial"); }
} catch (e) { console.log("FAIL  例外:" + ((e && e.stack) || e)); red++; } finally { fs.rmSync(ROOT, { recursive: true, force: true }); }
  console.log(red ? red + " 紅" : "ALL PASS");
  process.exit(red ? 1 : 0);
})();
