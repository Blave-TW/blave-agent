// 連結畫面的 Codex / Claude 登入(0.1.32 方案 B):偵測分得出「跑不起來」「沒有回應」「沒登入」,claude 的 PATH 那顆跑不起來改試 SDK 隨包那顆,
// Codex 只有隨包那一顆(0.1.41),登入回結束碼,「已在瀏覽器開啟」等 1 秒才講,沒登入那一列的鈕叫「連結」。
// 起因:cmux 開發版 PATH 上的 codex 包裝腳本回 127,被當成沒登入、叫用戶去登入。
// 主行程那半用 main.js 原文 + 真的子行程跑假的 bin(假 HOME、假 PATH、假的隨包 codex;不碰真的 codex / claude、不讀任何憑證檔)。
// 跑法:node tests/check_shell_codex_login.js
const fs = require("fs"), path = require("path"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell");
const src = fs.readFileSync(path.join(SHELL, "main.js"), "utf8"), app = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
const STR = eval(fs.readFileSync(path.join(SHELL, "renderer", "strings.js"), "utf8") + ";STRINGS");
let red = 0; const t = (n, ok, info) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || info === undefined ? "" : "  " + JSON.stringify(info))); if (!ok) red++; };
const grab = (s, re, name) => { const m = s.match(re); if (!m) { console.log("FAIL  找不到 " + name); process.exit(1); } return m[0]; };
const fnOf = (s, name) => grab(s, new RegExp("^(?:async )?function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n\\}", "m"), name);
const constOf = (s, name) => grab(s, new RegExp("^const " + name + " = .*$", "m"), name);

// ── 字串:新狀態兩張表都有、文案照 mockup ──
const KEYS = ["row.opened", "row.failed", "row.orCmd", "row.orBrowser", "row.reinstall", "st.cantRun", "st.noResp"];
t("字串:七個新 key 在 en / zh 都有", KEYS.every((k) => STR.en[k] && STR.zh[k]));
t("字串:zh「無法啟動」「沒有回應」「已在瀏覽器開啟登入頁」「登入沒有完成。」;「連結」沿用 cn.connect",
  STR.zh["st.cantRun"] === "無法啟動" && STR.zh["st.noResp"] === "沒有回應" && STR.zh["row.opened"] === "已在瀏覽器開啟登入頁" && STR.zh["row.failed"] === "登入沒有完成。" && STR.zh["cn.connect"] === "連結");
t("字串:ChatGPT app 那句退路兩語都刪了(row.orApp)", STR.en["row.orApp"] === undefined && STR.zh["row.orApp"] === undefined);
// 「無法啟動」那一列的退路(設計師稽核 D3,Wei 拍板):重裝那一顆,回前景會自動重新偵測
t("字串:「無法啟動」退路 zh「重新安裝 {name} 後回到這裡。」、en「Reinstall {name}, then come back.」(不帶 here)", STR.zh["row.reinstall"] === "重新安裝 {name} 後回到這裡。" && STR.en["row.reinstall"] === "Reinstall {name}, then come back.", [STR.zh["row.reinstall"], STR.en["row.reinstall"]]);
t("字串:終端機那一句帶 {cmd} 佔位(兩語)", /\{cmd\}/.test(STR.zh["row.orCmd"]) && /\{cmd\}/.test(STR.en["row.orCmd"]));

// ── 主行程:原文切出來,配假的 loginShellPath / BASE,子行程是真的 ──
const POSIX = process.platform !== "win32";
const PIECES = [constOf(src, "cmdWrap"), constOf(src, "WIN_ENV_DROP"), fnOf(src, "probeEnv"), fnOf(src, "run"), fnOf(src, "which"), "const LOGIN_CHECK_MS = 2000;", fnOf(src, "binKind"), constOf(src, "runRec"), constOf(src, "cantRun"),
  fnOf(src, "detectWhy"), grab(src, /^const BAD_BIN = .*$/m, "BAD_BIN"), fnOf(src, "claudePath"), fnOf(src, "codexBundled"), constOf(src, "codexHome"), "let codexRan = null, lastDetected = null;", fnOf(src, "timedOutPath"), grab(src, /^function codexCredOk\(bin, home, fsx = fs\) \{[\s\S]*?\n\}/m, "codexCredOk"), fnOf(src, "detectAgentsRaw"), constOf(src, "DETECT_TOTAL_MS"), "let detectShared = null;", fnOf(src, "detectAgents"),
  "let loginChild = null;", fnOf(src, "agentLogin"), fnOf(src, "cancelAgentLogin")].join("\n");
// pkgBin = 隨包那顆(假的 codexpkg.installed 回它,codexBundled 跑原文);bundled = SDK 隨包的 claude
// o.execFile／o.spawn／o.installed 換掉真的那支(同步 throw 的案例)
function mkMain(envPath, pkgBin, bundled, o = {}) {
  const logged = [];
  const api = new Function("execFile", "spawn", "fs", "path", "process", "loginShellPath", "bundledClaude", "BASE", "WIN", "detectLogWrite",
    "winOnPath", "pickWinBin", "cliAuthHow", "codexpkg", "CODEX_PIN", "TRIPLE", "os",
    (o.loginMs ? PIECES.replace("const LOGIN_CHECK_MS = 2000;", "const LOGIN_CHECK_MS = " + o.loginMs + ";") : PIECES) + "\nreturn { detectAgents, agentLogin, cancelAgentLogin, claudePath, codexBundled, BAD_BIN };")(
    o.execFile || require("child_process").execFile, o.spawn || require("child_process").spawn, fs, path, o.process || process, async () => envPath, () => bundled, "/b", false, (f, e) => logged.push(e),
    (s) => s, o.pickWinBin || (() => null), require(path.join(SHELL, "telemetry.js")).cliAuthHow, { installed: o.installed || (() => (pkgBin ? { path: pkgBin } : null)) }, "0.0.0", "x", os);
  api.logged = logged; return api;
}
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "blave-codex-login-"));
const HOME = path.join(ROOT, "home"); fs.mkdirSync(HOME);
process.env.HOME = HOME;   // 假 bin 只看得到這個 HOME;本機真的 ~/.codex 不在任何一步裡
const script = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body, { mode: 0o755 }); return p; };
const binDir = (name) => { const d = path.join(ROOT, name); fs.mkdirSync(d, { recursive: true }); return d; };
const PATH_OF = (d) => d + ":/usr/bin:/bin";
// 假 codex:`login status` 看假 HOME 裡的記號檔(不是真的憑證格式,只是「登入過」這件事);`login` 等一下、寫記號、回 0
const CODEX_OK = `#!/bin/sh
if [ "$1" = "login" ] && [ "$2" = "status" ]; then [ -f "$HOME/signed" ] && exit 0; exit 1; fi
if [ "$1" = "login" ]; then sleep 1.3; : > "$HOME/signed"; exit 0; fi
exit 2
`;

(async () => {
  if (!POSIX) { console.log("SKIP  假 bin 是 sh 腳本,Windows 閘門只跑上面的字串檢查"); }
  else {
    // 1. 127:隨包那顆跑不起來
    { const d = binDir("b127"); const p127 = script(path.join(d, "codex"), "#!/bin/sh\nexit 127\n");
      const m = mkMain(PATH_OF(binDir("empty")), p127, null), r = await m.detectAgents();
      t("127 → installed、沒登入、why=codex_cantrun(不是 nonzero)、via=pkg、BAD_BIN.codex 記它", r.codex.installed && !r.codex.loggedIn && r.codex.why === "codex_cantrun" && r.codex.via === "pkg" && r.codex.path === p127 && m.BAD_BIN.codex === p127 && m.codexBundled(true) === null, r.codex);
      t("…detect.log 記的是 code=127、沒有路徑", m.logged[0].codex.code === 127 && !JSON.stringify(m.logged).includes(ROOT), m.logged[0].codex);
      const l = await m.agentLogin("codex");
      t("…替他按登入:回 code=127、cantRun=true、ok=false", l.ok === false && l.code === 127 && l.cantRun === true && l.cancelled === false, l); }
    // 2. 用戶自己的 codex 在 PATH 上,好好的:從此不看、不跑(uid 33959 那種卡在中間的路拿掉了)
    { const d = binDir("bmine"); script(path.join(d, "codex"), `#!/bin/sh\n: > "$HOME/mine-ran"\nexit 0\n`);
      const none = await mkMain(PATH_OF(d), null, null).detectAgents();
      t("PATH 上有一顆能跑的 codex、隨包沒抓 → 還是 installed=false、why=codex_none,不看 PATH", !none.codex.installed && none.codex.why === "codex_none" && none.codex.via === null && !fs.existsSync(path.join(HOME, "mine-ran")), none.codex);
      const pkg = script(path.join(ROOT, "pkg127", "codex"), "#!/bin/sh\nexit 127\n"), r = await mkMain(PATH_OF(d), pkg, null).detectAgents();
      t("…隨包跑不起來也不退到 PATH 那顆:why=codex_cantrun、path 是隨包", r.codex.why === "codex_cantrun" && r.codex.path === pkg && !fs.existsSync(path.join(HOME, "mine-ran")), r.codex); }
    // 3. 找不到檔:隨包沒抓;另一種是檔在、shebang 指到不存在的直譯器(開不起來 = ENOENT)
    { const m = mkMain(PATH_OF(binDir("empty")), null, null), r = await m.detectAgents();
      t("找不到檔 → installed=false、why=codex_none", !r.codex.installed && r.codex.why === "codex_none" && r.codex.via === null, r.codex);
      const d = binDir("benoent"), p = script(path.join(d, "codex"), "#!/nonexistent/interp\n");
      const m2 = mkMain(PATH_OF(d), p, null), r2 = await m2.detectAgents(), l = await m2.agentLogin("codex");
      t("檔在、開不起來(ENOENT)→ why=codex_cantrun;登入回 code=ENOENT、cantRun=true", r2.codex.why === "codex_cantrun" && l.code === "ENOENT" && l.cantRun === true && l.ok === false, { why: r2.codex.why, l }); }
    // 3b. spawn 同步 throw(uid 33959 的 detect.log:hung:true、err:EPERM):Node 只有五種錯誤走 error 事件,EPERM 是 throw。
    //     以前整次偵測 reject → 兩列都 *_timeout「沒有回應」。現在只有那一條壞,另一條照常
    { const EPERM = () => { throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" }); }, real = require("child_process").execFile;
      const THROW_ON = (p) => (...a) => (a[0] === p ? EPERM() : real(...a));
      const d = binDir("beperm"), good = path.join(d, "codex"), okClaude = script(path.join(d, "claude"), "#!/bin/sh\necho '{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}'\n");
      script(good, CODEX_OK);
      const a = mkMain(PATH_OF(d), good, null, { execFile: THROW_ON(good) }), ra = await a.detectAgents();
      t("Codex 那顆 spawn 同步 throw EPERM:Claude 照常已登入;Codex why=codex_cantrun、不是 timeout;沒寫 hung;BAD_BIN.codex 記它",
        ra.claude.loggedIn === true && ra.claude.why === null && ra.codex.installed && ra.codex.why === "codex_cantrun" && !a.logged.some((e) => e.hung) && a.logged[0].codex.code === "EPERM" && a.BAD_BIN.codex === good, { ra, log: a.logged });
      const b = mkMain(PATH_OF(d), good, null, { execFile: THROW_ON(okClaude) }), rb = await b.detectAgents();
      t("Claude 那顆 spawn 同步 throw EPERM:Codex 照常(沒登入 → codex_nonzero);Claude why=claude_cantrun;沒寫 hung", rb.codex.why === "codex_nonzero" && rb.claude.why === "claude_cantrun" && !b.logged.some((e) => e.hung), { rb, log: b.logged });
      // win-test-6 實測:非 PE 檔是 code=UNKNOWN 的同步 throw;沒帶 code 的也不能倒。Claude 踩雷、Codex 正常(33959 的形狀)
      const orphans = []; const onU = (e) => orphans.push(String(e && e.code)); process.on("unhandledRejection", onU);
      for (const code of ["UNKNOWN", undefined]) {
        const m = mkMain(PATH_OF(d), good, null, { execFile: (...a) => { if (a[0] === okClaude) throw Object.assign(new Error("spawn"), code ? { code } : {}); return real(...a); } }), rx = await m.detectAgents();
        t("Claude 那顆同步 throw(code=" + code + "):Codex 照常、沒寫 hung;Claude " + (code ? "claude_cantrun" : "不是 timeout"), rx.codex.why === "codex_nonzero" && !m.logged.some((e) => e.hung) && !/timeout/.test(rx.claude.why) && (!code || rx.claude.why === "claude_cantrun"), rx); }
      await new Promise((res) => setTimeout(res, 50)); process.removeListener("unhandledRejection", onU);
      t("…rawP(對照組)沒有 unhandled rejection", orphans.length === 0, orphans);
      const c = mkMain(PATH_OF(d), good, null, { spawn: EPERM }), lc = await c.agentLogin("codex"), lc2 = await c.agentLogin("codex");
      t("登入的 spawn 同步 throw:回 code=EPERM、cantRun=true;loginChild 放掉,下一次不是 busy", lc.code === "EPERM" && lc.cantRun === true && lc.ok === false && lc.cancelled === false && lc2.busy !== true, { lc, lc2 });
      const e = mkMain(PATH_OF(d), good, null, { installed: () => { throw Object.assign(new Error("x /Users/u"), { code: "EIO" }); } }), re = await e.detectAgents();
      t("一條在 find 就 reject:只影響自己(codex_none、rec.err 記碼不記訊息),Claude 照常,沒寫 hung", re.claude.loggedIn === true && re.codex.why === "codex_none" && e.logged[0].codex.err === "EIO" && !e.logged.some((x) => x.hung) && !JSON.stringify(e.logged).includes("/Users/u"), { re, log: e.logged }); }
    // 3c. 不確定之後按〔連結〕／〔登入〕:路徑用上次偵測的,不再多等一輪(只在那一條逾時時)
    { const d = binDir("bslow2"), p = script(path.join(d, "codex"), `#!/bin/sh\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then exec sleep 8; fi\nif [ "$1" = "login" ]; then exit 0; fi\nexit 2\n`);
      const m = mkMain(PATH_OF(d), p, null); await m.detectAgents(); const before = m.logged.length, t0 = Date.now(), l = await m.agentLogin("codex");
      t("不確定之後按登入:不重跑偵測(detect.log 沒多一行)、直接 spawn", l.ok === true && m.logged.length === before && Date.now() - t0 < 1500, { l, n: m.logged.length }); }
    // 4. 逾時:login status 不回(上限在這支測試裡縮成 2 秒)
    { const d = binDir("bslow"), p = script(path.join(d, "codex"), "#!/bin/sh\nexec sleep 8\n");
      const t0 = Date.now(), r = await mkMain(PATH_OF(d), p, null).detectAgents();
      t("逾時 → why=codex_timeout(畫面「沒有回應」),不會等滿 8 秒", r.codex.installed && !r.codex.loggedIn && r.codex.why === "codex_timeout" && Date.now() - t0 < 6000, r.codex); }
    // 5. 正常登入:沒登入 → 替他跑 `codex login`(活過 1 秒、回 0)→ 再偵測就是已登入
    { const d = binDir("bok"), p = script(path.join(d, "codex"), CODEX_OK);
      const m = mkMain(PATH_OF(d), p, null), r = await m.detectAgents();
      t("正常、沒登入 → why=codex_nonzero(畫面〔連結〕)", r.codex.installed && !r.codex.loggedIn && r.codex.why === "codex_nonzero", r.codex);
      const l = await m.agentLogin("codex"), r2 = await m.detectAgents();
      t("…登入回 ok、code=0、cantRun=false;再偵測已登入", l.ok === true && l.code === 0 && l.cantRun === false && r2.codex.loggedIn === true && r2.codex.why === null, { l, c: r2.codex });
      fs.rmSync(path.join(HOME, "signed"), { force: true });
      const p2 = m.agentLogin("codex"); await new Promise((res) => setTimeout(res, 200)); m.cancelAgentLogin(); const cx = await p2;
      t("…按「取消等待」→ cancelled=true、ok=false、不是 cantRun", cx.cancelled === true && cx.ok === false && cx.cantRun === false, cx); }
    // 7. 偵測途中按「取消等待」:spawn 之前也要算數(稽核 P2-3)——登入行程不起、回 cancelled;偵測中第二個登入回 busy
    { const d = binDir("bcancel"), p = script(path.join(d, "codex"), `#!/bin/sh
if [ "$1" = "login" ] && [ "$2" = "status" ]; then sleep 1.5; exit 1; fi
if [ "$1" = "login" ]; then : > "$HOME/login-ran"; exit 0; fi
exit 2
`);
      const m = mkMain(PATH_OF(d), p, null);
      const going = m.agentLogin("codex"); await new Promise((res) => setTimeout(res, 200));
      const second = await m.agentLogin("codex"), cut = m.cancelAgentLogin(), r = await going;
      await new Promise((res) => setTimeout(res, 300));
      t("偵測中按取消 → cancelAgentLogin 回 true、結果 cancelled、登入行程沒起來;同時第二個登入回 busy",
        cut === true && r.cancelled === true && r.ok === false && r.cantRun === false && !fs.existsSync(path.join(HOME, "login-ran")) && second.busy === true, { cut, r, second, ran: fs.existsSync(path.join(HOME, "login-ran")) });
      const again = await m.agentLogin("codex");
      t("…取消後佔位放掉:下一次登入照常跑", again.ok === true && fs.existsSync(path.join(HOME, "login-ran")), again);
      fs.rmSync(path.join(HOME, "login-ran"), { force: true });
      const p3 = m.agentLogin("claude"); await new Promise((res) => setTimeout(res, 200)); m.cancelAgentLogin(); const nb = await p3;
      t("…偵測中取消、偵測完那一顆又沒找到 → 仍回 cancelled(不是失敗)", nb.cancelled === true && nb.ok === false, nb); }
    // 6. Claude 同一套:PATH 上的 claude 跑不起來 → 改用 SDK 隨包那顆
    { const d = binDir("bclaude"); script(path.join(d, "claude"), "#!/bin/sh\nexit 127\n");
      const bundled = script(path.join(ROOT, "venv", "claude_agent_sdk", "_bundled", "claude"), "#!/bin/sh\necho '{\"loggedIn\":true,\"authMethod\":\"x\"}'\n");
      const m = mkMain(PATH_OF(d), null, bundled), r = await m.detectAgents();
      t("claude 127 → 退到隨包那顆、已登入;表外的 authMethod → how other(cli_auth)", r.claude.loggedIn && r.claude.path === bundled && r.claude.why === null && m.BAD_BIN.claude === path.join(d, "claude") && r.claude.how === "other", r.claude);
      const m2 = mkMain(PATH_OF(d), null, null), r2 = await m2.detectAgents();
      t("…沒有隨包那顆 → claude_cantrun;JSON 讀不出來 how 留 null(不送 cli_auth)", r2.claude.installed && r2.claude.why === "claude_cantrun" && r2.claude.how === null, r2.claude); }
    // 6c. 偵測途中按〔連結〕(回前景那一輪不清列,鈕按得到):agentLogin 要的偵測跟進行中那一輪共用,不再開第二輪去搶 BAD_BIN
    { const d = binDir("bshare"), cnt = path.join(HOME, "status-count");
      script(path.join(d, "claude"), `#!/bin/sh\nif [ "$1" = "auth" ] && [ "$2" = "login" ]; then exit 0; fi\necho x >> "${cnt}"\nsleep 0.6\necho '{"loggedIn":false}'\nexit 1\n`);
      const m = mkMain(PATH_OF(d), null, null, { loginMs: 15000 }), first = m.detectAgents();   // 這段不驗逾時:機器忙時 2 秒的上限會假紅
      await new Promise((res) => setTimeout(res, 150));
      const [r1, lg] = await Promise.all([first, m.agentLogin("claude")]);
      const n = fs.readFileSync(cnt, "utf8").split("\n").filter(Boolean).length;
      t("偵測中按登入:只跑一輪(auth status 2 次 = 正式＋對照組)、detect.log 一行;登入照常跑完", n === 2 && m.logged.length === 1 && r1.claude.why === "claude_nonzero" && lg.ok === true, { n, logs: m.logged.length, lg });
      fs.rmSync(cnt, { force: true });
      await m.detectAgents(); const n2 = fs.readFileSync(cnt, "utf8").split("\n").filter(Boolean).length;
      t("…那一輪結束後再偵測是新的一輪(不拿舊結果)", n2 === 2 && m.logged.length === 2, { n2, logs: m.logged.length }); fs.rmSync(cnt, { force: true }); }
    // 6b. Windows 模擬(macOS 上跑:process.platform 換成 win32,where.exe 換成假的,.cmd 是 sh 腳本、經 shell 跑的路徑跟 Windows 同一條):
    //     npm 的 claude.cmd 被拒絕執行時是 cmd.exe 回 1、只在 stderr 講(win-test-6 拒絕 RX 實測 code 1),以前當成沒登入畫〔登入〕、不退隨包
    { const real = require("child_process").execFile, d = binDir("bcmd"), calls = [];
      const warns = [], onW = (w) => warns.push(w.code); process.on("warning", onW);   // Node 一個 process 只發一次:從這一段第一個 .cmd 起就聽
      const WINP = { platform: "win32", env: { ...process.env, USERPROFILE: HOME } };
      const winMain = (cmd, bundled, spawnSpy) => mkMain(PATH_OF(d), null, bundled, { loginMs: 15000, process: WINP, pickWinBin: () => cmd,
        execFile: (f, a, o, cb) => { calls.push({ f, a, shell: o.shell }); return /where\.exe$/i.test(f) ? cb(null, cmd + "\r\n", "") : real(f, a, o, cb); }, spawn: spawnSpy });
      const denied = script(path.join(d, "claude.cmd"), "#!/bin/sh\necho 'Access is denied.' >&2\nexit 1\n");
      const bundled = script(path.join(ROOT, "venv2", "claude_agent_sdk", "_bundled", "claude"), "#!/bin/sh\necho '{\"loggedIn\":false}'\nexit 1\n");
      const m = winMain(denied, bundled), r = await m.detectAgents();
      t("(Windows 模擬)被拒的 claude.cmd(cmd.exe 回 1、只有 stderr)→ 算跑不起來、退到隨包那顆:隨包沒登入 = 〔登入〕走隨包;detect.log 記 refused、不記 stderr 原文",
        r.claude.path === bundled && r.claude.why === "claude_nonzero" && m.BAD_BIN.claude === denied && m.logged[0].claude.alt === "bundled" && !JSON.stringify(m.logged).includes("denied"), { c: r.claude, log: m.logged[0].claude });
      const m2 = winMain(denied, null), r2 = await m2.detectAgents();
      t("(Windows 模擬)…沒有隨包那顆 → claude_cantrun(畫面「無法啟動」＋重新安裝),不是〔登入〕", r2.claude.installed && r2.claude.why === "claude_cantrun" && m2.logged[0].claude.refused === true, r2.claude);
      const out = script(path.join(d, "claude-out.cmd"), "#!/bin/sh\necho '{\"loggedIn\":false}'\necho 'warn' >&2\nexit 1\n"), r3 = await winMain(out, bundled).detectAgents();
      t("(Windows 模擬)….cmd 有在 stdout 回答「沒登入」(exit 1)→ 照舊 claude_nonzero、用它自己,不退隨包", r3.claude.path === out && r3.claude.why === "claude_nonzero", r3.claude);
      // DEP0190:shell 配非空 args 才警告。走 shell 的那一支 args 一律是空陣列,命令列是 Node 自己會接出來的那一行
      calls.length = 0; await winMain(out, bundled).detectAgents();
      const sh = calls.filter((c) => c.shell);
      t("(Windows 模擬)….cmd 經 shell 時 execFile 的 args 是空陣列(不觸發 DEP0190),整行是「\"路徑\" --setting-sources= auth status」",
        sh.length >= 1 && sh.every((c) => Array.isArray(c.a) && c.a.length === 0) && sh.some((c) => c.f === '"' + out + '" --setting-sources= auth status'), sh);
      let sp = null; const spy = (f, a, o) => { sp = { f, a, shell: o.shell }; throw Object.assign(new Error("x"), { code: "EPERM" }); };
      const lg = await winMain(out, null, spy).agentLogin("claude");
      t("(Windows 模擬)…登入的 spawn 同理:args 空陣列、shell=true、整行帶 auth login;同步 throw 照舊接住(cantRun)",
        sp && sp.shell === true && sp.a.length === 0 && sp.f === '"' + out + '" auth login' && lg.cantRun === true && lg.code === "EPERM", { sp, lg });
      const major = Number(process.versions.node.split(".")[0]);
      await new Promise((res) => setTimeout(res, 50)); process.removeListener("warning", onW);
      if (major >= 24) t("(Windows 模擬、Node " + major + ")…這一段的偵測與登入都沒有 DEP0190", !warns.includes("DEP0190"), warns);
      else console.log("SKIP  DEP0190 實際警告要 Node 24(現在 " + process.versions.node + "),上面的 args 斷言照跑");
    }
  }

  // ── 畫面:原文切出來配假的 DOM ──
  const mkEl = (tag) => {
    const n = { tag, children: [], dataset: {}, attrs: {}, className: "", disabled: false, parent: null, _txt: "", _html: "",
      append: (...xs) => xs.forEach((x) => { if (typeof x === "string") n.children.push({ text: x }); else if (x.frag) x.children.forEach((c) => { c.parent = n; n.children.push(c); }); else { x.parent = n; n.children.push(x); } }),
      appendChild: (x) => { n.append(x); return x; },
      addEventListener: (ev, fn) => { if (ev === "click") n.onclick = fn; },
      setAttribute: (k, v) => { n.attrs[k] = String(v); }, querySelector: () => null, focus: () => {},
      querySelectorAll: (q) => { const out = []; const walk = (x) => (x.children || []).forEach((c) => { if (q === "button" && c.tag === "button") out.push(c); walk(c); }); walk(n); return out; },
      closest: (q) => { const k = (q.match(/data-kind="([^"]+)"/) || [])[1]; let p = n; while (p) { if (k && p.dataset && p.dataset.kind === k) return p; if (q === ".cn-opts" && p.className === "cn-opts") return p; p = p.parent; } return null; } };
    Object.defineProperty(n, "textContent", { get: () => n.children.map((c) => c.text !== undefined ? c.text : c.textContent).join("") + n._txt, set: (v) => { n.children.length = 0; n._txt = v; } });
    Object.defineProperty(n, "innerHTML", { get: () => n._html, set: (v) => { n._html = v; n.children.length = 0; if (!v) return; const s = mkEl("span"); s.className = "n"; s.parent = n; n.children.push(s); n._first = s; } });
    Object.defineProperty(n, "firstChild", { get: () => n._first });
    return n;
  };
  const document = { createElement: (tag) => mkEl(tag), createDocumentFragment: () => { const f = mkEl("#frag"); f.frag = true; return f; } };
  const dom = {}; const $ = (id) => dom[id] || (dom[id] = mkEl("div"));
  let LANG = "zh";
  const tr = (k, v) => { let s = STR[LANG][k] || k; for (const x of Object.keys(v || {})) s = s.split("{" + x + "}").join(v[x]); return s; };
  const RSTATE = {};
  const R = new Function("document", "$", "t", "getLang", "window", "state",
    `let LANG; const sync = () => { LANG = getLang(); };
     let loginPending = null, oauthPending = false, lastDetect = null, cur = null, HINT = null, detects = 0, said = [];
     let loginSpawned = null;
     const MDL = { busy: false }, mdlPaint = () => {}, paintBlaveBtn = () => {}, connect = (k) => { state.connected = k; }, srSay = (x) => said.push(x), trackEvent = () => {}, trackFeature = () => {}, LAI_INSTALL = { claude: "x" };
     ${fnOf(app, "cmdLine")}
     function detectFresh() { return detect(); }
     function detect(quiet) { detects++; state.quiet = quiet; detectAt = Date.now(); if (state.next) lastDetect = state.next; }
     function setHint(h) { HINT = h || null; }
     let detectAt = 0;
     ${constOf(app, "ROWMSG")}
     ${constOf(app, "REDETECT_GAP_MS")}
     const resendState = (card, okText) => ({ calm: true, text: typeof okText === "function" ? okText() : okText, resend: true });
     ${app.match(/^function sysLz\(fn\)[^\n]*$/m)[0]}
     ${constOf(app, "LOCAL_FAULTS")}
     ${fnOf(app, "localFaultsLive")}
     ${fnOf(app, "localFaultsRecheck")}
     ${fnOf(app, "localLoginFlow")}
     function laiOn() { return false; }   // 額度用完卡片開的 modal(check_shell_local_ai_card.js 驗)
     ${fnOf(app, "focusRedetect")}
     ${constOf(app, "whyState")}
     ${constOf(app, "authUnknown")}
     const PKG = { snap: null, redetect: false };   // Codex 引擎隨包的快照還沒拉到:Codex 那一列照舊畫
     ${fnOf(app, "codexPkgRow")}
     ${fnOf(app, "mdlNeedsRedetect")}
     ${fnOf(app, "row")}
     ${fnOf(app, "btn")}
     ${fnOf(app, "paintRows")}
     ${fnOf(app, "rowMsg")}
     ${constOf(app, "LOGIN_CMD")}
     ${constOf(app, "LOGIN_OPENED_MS")}
     ${fnOf(app, "agentLoginRun")}
     ${fnOf(app, "hintFill")}
     ${constOf(app, "rowMsgText")}
     ${fnOf(app, "localLogin")}
     return { sync, paintRows, rowMsg, cmdLine, agentLoginRun, hintFill, focusRedetect, localLoginFlow, LOCAL_FAULTS, whyState, localLogin,
       set: (k, v) => { eval(k + " = v"); }, get: (k) => eval(k), ROWMSG, said };`)(document, $, (k, v) => tr(k, v), () => LANG, { blave: { cancelAgentLogin: () => {}, agentLogin: (k) => RSTATE.login(k) } }, RSTATE);
  R.sync();
  const rows = () => $("agent-rows").children.map((r) => {
    const st = (r._html.match(/class="cn-st[^"]*">(?:<span class="dot"><\/span>)?([^<]*)/) || [, ""])[1];
    const msg = (r.firstChild.children.find((c) => c.className === "msg") || {}).textContent || "";
    const b = r.children.find((c) => c.tag === "button");
    return [r.dataset.kind, r.className.includes("off") ? "off" : "", st, msg, b ? b.textContent + (b.disabled ? "(x)" : "") : ""].join("|");
  });
  const D = (claude, codex) => ({ claude: { installed: true, ...claude }, codex: { installed: true, via: "pkg", ...codex } });
  R.set("lastDetect", D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: false, why: "codex_cantrun" })); R.paintRows(R.get("lastDetect"));
  t("連結畫面:沒登入 → 〔連結〕;127、快照還沒到 → 「無法啟動」、列變灰、沒有鈕,不叫他重新安裝 Codex(自己裝的不看)", JSON.stringify(rows()) === JSON.stringify(["claude|||" + "|連結", "codex|off|無法啟動||"]), rows());
  R.set("lastDetect", D({ loggedIn: false, why: "claude_cantrun" }, { loggedIn: true })); R.paintRows(R.get("lastDetect"));
  t("…Claude 跑不起來照舊:名字底下一句「重新安裝 Claude Code 後回到這裡。」", rows()[0] === "claude|off|無法啟動|重新安裝 Claude Code 後回到這裡。|", rows());
  R.set("lastDetect", D({ loggedIn: true, why: null }, { loggedIn: false, why: "codex_timeout" })); R.paintRows(R.get("lastDetect"));
  t("…整次偵測超時(沒有 path)→ 「沒有回應」、沒有鈕;已登入 → 「已登入」+〔連結〕", JSON.stringify(rows()) === JSON.stringify(["claude||已登入||連結", "codex|off|沒有回應||"]), rows());
  R.set("lastDetect", D({ loggedIn: false, why: "claude_timeout", path: "/x/claude" }, { loggedIn: false, why: "codex_timeout", path: "/x/codex" })); R.paintRows(R.get("lastDetect"));
  t("…登入檢查逾時(有 path)→ 不擋路:一句「查不到登入狀態」+〔連結〕,Claude、Codex 同一種", JSON.stringify(rows()) === JSON.stringify(["claude|||查不到登入狀態，送出訊息就知道|連結", "codex|||查不到登入狀態，送出訊息就知道|連結"]), rows());
  R.set("lastDetect", D({ installed: false }, { loggedIn: false, why: "codex_nonzero" })); R.set("loginPending", "codex"); R.ROWMSG.codex = "opened"; R.paintRows(R.get("lastDetect"));
  t("…等瀏覽器:那一列名字底下「已在瀏覽器開啟登入頁」、鈕是「取消等待」", JSON.stringify(rows()) === JSON.stringify(["claude|off|未偵測到||安裝(x)", "codex|||已在瀏覽器開啟登入頁|取消等待"]), rows());
  R.set("loginPending", null); R.ROWMSG.codex = "failed"; R.paintRows(R.get("lastDetect"));
  t("…失敗:Codex 不在 PATH 上(codex login 是死路)→ 只講會開瀏覽器(不點名鈕:三個表面那時的鈕都是〔再試一次〕)", rows()[1] === "codex|||登入沒有完成。會開瀏覽器完成登入。|再試一次", rows());
  LANG = "en"; R.sync(); R.paintRows(R.get("lastDetect"));
  t("…en:兩句中間有一個空格", rows()[1] === "codex|||Sign-in didn’t finish. This opens your browser to finish signing in.|Try Again", rows());
  R.ROWMSG.claude = "failed"; R.set("lastDetect", D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: true })); R.paintRows(R.get("lastDetect"));
  t("…Claude 失敗給 claude auth login;登入成功的那一列訊息清掉", rows()[0] === "claude|||Sign-in didn’t finish. Or run claude auth login in a terminal.|Try Again" && R.ROWMSG.codex === null, rows());
  LANG = "zh"; R.sync(); R.ROWMSG.claude = null;
  R.set("lastDetect", D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: false, why: "codex_nonzero" })); R.set("loginPending", "claude"); R.paintRows(R.get("lastDetect"));
  t("…等登入中:別的列的鈕鎖住,只有那一列的「取消等待」能按", JSON.stringify(rows()) === JSON.stringify(["claude||||取消等待", "codex||||連結(x)"]), rows());
  R.set("loginPending", null);

  // 登入指令本身跑不起來(agentLogin 回 cantRun),偵測卻只看到「沒登入」:兩個表面都改「無法啟動」,不出「登入沒有完成」(稽核 P2-4)
  { const inSet = () => { const o = mkEl("div"); o.className = "cn-opts"; const b = mkEl("button"); o.append(b); return b; };
    const go = async (b, res) => { RSTATE.login = async () => res; RSTATE.next = D({ installed: false }, { loggedIn: false, why: "codex_nonzero" }); R.set("HINT", null); R.ROWMSG.codex = null; await R.localLogin("codex", b); return R.get("lastDetect").codex; };
    R.said.length = 0; const a = await go(inSet(), { ok: false, cancelled: false, code: 127, cantRun: true }), aHint = R.get("HINT"), aSaid = R.said.slice();
    const c = await go(inSet(), { ok: false, cancelled: false, code: 1, cantRun: false }), cHint = R.get("HINT");
    const e = await go(mkEl("button"), { ok: false, cancelled: false, code: "ENOENT", cantRun: true });
    t("localLogin:設定 › 模型接入 127 → 那一列改 why=codex_cantrun、讀屏念「無法啟動」、沒有「登入沒有完成」;一般失敗(1)照舊出失敗句",
      a.why === "codex_cantrun" && aHint === null && aSaid.includes("Codex 引擎無法啟動，再試一次會重新下載") && c.why === "codex_nonzero" && cHint && cHint.text === "Codex 登入沒有完成。" && cHint.cmd === "codex", { a, aHint, aSaid, c, cHint });
    t("…連結畫面 ENOENT → 那一列「無法啟動」、沒有鈕、沒有失敗訊息", e.why === "codex_cantrun" && R.ROWMSG.codex === null && rows()[1] === "codex|off|無法啟動||", rows());
    // 那一列沒有鈕了,焦點不能掉到 body(設計師 D2):連結畫面給 .cn-head 的「重新偵測」(#btn-redetect),設定給本機那組底下的「重新偵測」
    const focused = []; $("btn-redetect").focus = () => focused.push("cn-head");
    await go(mkEl("button"), { ok: false, cancelled: false, code: 127, cantRun: true });
    const spy = { focus: () => focused.push("set-model") }, setModel = $("set-model"), qs0 = setModel.querySelector;
    setModel.querySelector = (q) => (q === '[data-kind="redetect"] button' ? spy : null);
    await go(inSet(), { ok: false, cancelled: false, code: 127, cantRun: true });
    setModel.querySelector = qs0;
    t("…變「無法啟動」之後焦點有落點:連結畫面 → .cn-head 的重新偵測、設定 › 模型接入 → 那一頁的重新偵測", JSON.stringify(focused) === JSON.stringify(["cn-head", "set-model"]), focused);
    RSTATE.next = null; R.set("loginPending", null); }

  // 共用訊息格(三個表面同一支 hintFill):中文句尾全形標點後不補空格,英文補一個
  { const fill = (lang, h) => { LANG = lang; R.sync(); R.set("HINT", h); const n = mkEl("p"); R.hintFill(n); return n.textContent; };
    t("hintFill:zh「Claude Code 登入沒有完成。」接退路不多空格;en 補一個;沒有 cmd 不補;沒有訊息不畫",
      fill("zh", { text: "Claude Code 登入沒有完成。", cmd: "claude" }) === "Claude Code 登入沒有完成。或在終端機執行 claude auth login。" && fill("en", { text: "Claude Code sign-in didn’t finish.", cmd: "claude" }) === "Claude Code sign-in didn’t finish. Or run claude auth login in a terminal."
      && fill("en", { text: "x" }) === "x" && fill("zh", null) === "", [fill("zh", { text: "Claude Code 登入沒有完成。", cmd: "claude" }), fill("en", { text: "Claude Code sign-in didn’t finish.", cmd: "claude" })]);
    // 設定 › 模型接入與工作頁失效卡的退路(cmdLine)跟連結畫面那一列(rowMsg)同一句(設計師 D1)
    // via 不算數:隨包那顆是 pkg、整次偵測超時是 null,Codex 都不給 codex login 這條死路
    const line = (lang, via, kind) => { LANG = lang; R.sync(); R.set("lastDetect", D({}, { loggedIn: false, why: "codex_nonzero", via })); const n = mkEl("p"); n.append(R.cmdLine(kind)); return n.textContent; };
    const same = ["zh", "en"].every((lang) => line(lang, "pkg", "codex") === STR[lang]["row.orBrowser"] && line(lang, null, "codex") === STR[lang]["row.orBrowser"]
      && line(lang, "pkg", "claude") === STR[lang]["row.orCmd"].replace("{cmd}", "claude auth login"));
    t("cmdLine:Codex(via=pkg、逾時的 null)= row.orBrowser、Claude = row.orCmd(兩語),跟連結畫面同一句", same, [line("zh", "pkg", "codex"), line("zh", null, "codex"), line("en", "pkg", "claude")]);
    t("…舊的 login.failedCodex / login.failedCmd 兩語都刪掉了", ["login.failedCodex", "login.failedCmd"].every((k) => STR.en[k] === undefined && STR.zh[k] === undefined));
    LANG = "zh"; R.sync();
    t("三處接字(setHint、模型接入、帳號訊息格)都走 hintFill,不再自己接空格",
      !/HINT\.text \+ \(HINT\.cmd \? " " : ""\)/.test(app) && (app.match(/hintFill\((n|p|hint)\);/g) || []).length === 3); }

  // 「已在瀏覽器開啟」等 1 秒,從主行程 spawn 那一刻(agent-login-spawned)起算(稽核 P2-2)
  const LISTEN = grab(app, /^window\.blave\.onAgentLoginSpawned\(.*$/m, "onAgentLoginSpawned 掛勾");
  // blave = 假的 preload:agentLogin(kind, emit) 由呼叫端決定何時送 spawned、何時結束
  const mkRun = (login) => { let listener = null; let pending = "codex";
    const blave = { onAgentLoginSpawned: (fn) => { listener = fn; }, agentLogin: (k) => login(k, () => listener && listener()) };
    const f = new Function("window", "LOGIN_OPENED_MS", "getPending",
      "let loginSpawned = null; const lp = () => getPending();\n" + LISTEN + "\n" + fnOf(app, "agentLoginRun").replace(/loginPending/g, "lp()") + "\nreturn agentLoginRun;")({ blave }, 1000, () => pending);
    return async (kind) => { let opened = 0; const r = await f(kind, () => opened++); return { opened, r }; }; };
  { const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const fake = (spawnAt, endAt, res) => mkRun(async (_k, emit) => { if (spawnAt !== null) { await wait(spawnAt); emit(); } await wait(endAt - (spawnAt || 0)); return res; });
    const [fast, slow, lateSpawn127, noSpawn] = await Promise.all([fake(0, 50, { ok: false, code: 127, cantRun: true })("codex"), fake(0, 1300, { ok: true, code: 0 })("codex"),
      fake(1500, 1600, { ok: false, code: 127, cantRun: true })("codex"), fake(null, 1300, { ok: false, cancelled: true })("codex")]);
    t("agentLoginRun:spawn 後 1 秒內結束(127)→ 不講;活過 1 秒 → 講一次", fast.opened === 0 && fast.r.code === 127 && slow.opened === 1 && slow.r.ok === true, { fast, slow });
    t("…偵測拖了 1.5 秒才 spawn、接著 127 → 不講(從按下去算會在 1 秒時提早講);沒 spawn 就結束(取消、busy)→ 不講",
      lateSpawn127.opened === 0 && lateSpawn127.r.code === 127 && noSpawn.opened === 0, { lateSpawn127, noSpawn }); }
  if (POSIX) {
    // 主行程原文接畫面原文:偵測慢(login status 睡 1.5 秒),登入行程一起來就 127 → 不講;活 1.3 秒 → 講
    const d = binDir("bslowdetect"), p = path.join(d, "codex"); const m = mkMain(PATH_OF(d), p, null);
    const body = (login) => `#!/bin/sh\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then sleep 1.5; exit 1; fi\nif [ "$1" = "login" ]; then ${login}; fi\nexit 2\n`;
    script(p, body("exit 127")); const a = await mkRun((k, emit) => m.agentLogin(k, emit))("codex");
    script(p, body("sleep 1.3; exit 0")); const b = await mkRun((k, emit) => m.agentLogin(k, emit))("codex");
    t("…真的主行程:偵測慢、登入行程 127 → 不講「已開啟」;登入行程活過 1 秒 → 講", a.opened === 0 && a.r.code === 127 && b.opened === 1 && b.r.ok === true, { a, b });
  }
  // 工作頁的登入失效卡(localLoginFlow)走同一支 agentLoginRun:偵測慢、spawn 後馬上 127 → 不講「已開啟」
  { const flow = (spawnAt, endAt, res) => { const sets = []; let listener = null;
      const blave = { onAgentLoginSpawned: (fn) => { listener = fn; }, cancelAgentLogin: () => {},
        agentLogin: async () => { if (spawnAt !== null) { await new Promise((r) => setTimeout(r, spawnAt)); listener(); } await new Promise((r) => setTimeout(r, endAt - (spawnAt || 0))); return res; } };
      const f = new Function("window", "t", "LOGIN_OPENED_MS", "cmdLine", "resendState", "trackEvent", "trackFeature",
        "let loginPending = null, oauthPending = false, loginSpawned = null; const LOCAL_FAULTS = [];\n" + LISTEN + "\n" + fnOf(app, "agentLoginRun") + "\n" + app.match(/^function sysLz\(fn\)[^\n]*$/m)[0] + "\n" + fnOf(app, "localLoginFlow") + "\nreturn localLoginFlow;")(
        { blave }, (k, v) => tr(k, v), 1000, (k) => k, () => ({ text: "ok" }), () => {}, () => {});
      const card = { set: (st) => sets.push(st) };
      f(card, "codex"); sets[0].on();   // 卡先畫失效句,按〔登入〕
      return new Promise((r) => setTimeout(r, endAt + 300)).then(() => sets.map((x) => x.text)); };
    const OPENED = tr("login.opened", { name: "Codex" });
    const [late127, ok] = await Promise.all([flow(1500, 1600, { ok: false, cancelled: false, code: 127, cantRun: true }), flow(0, 1300, { ok: true, code: 0 })]);
    t("localLoginFlow:spawn 前偵測拖 1.5 秒、接著 127 → 不講「已在瀏覽器開啟」;活過 1 秒 → 講一次", !late127.includes(OPENED) && ok.filter((x) => x === OPENED).length === 1, { late127, ok }); }
  t("…主行程在 spawn 之後才送 agent-login-spawned,只送給按的那個畫面", /loginChild = child;\n[^\n]*\n    if \(onSpawn\) onSpawn\(\);/.test(src)
    && /handle\("agent-login", \(e, kind\) => agentLogin\(String\(kind \|\| ""\),\s*\(\) => \{ if \(!e\.sender\.isDestroyed\(\)\) e\.sender\.send\("agent-login-spawned"\); \}\)\);/.test(src));

  // 回到前景重偵測:只在連結畫面(或模型接入)開著、有不能用的、沒在等登入、15 秒內不重來
  { $("view-connect").hidden = false; $("set-scrim").hidden = true; $("set-model").hidden = true;
    R.set("lastDetect", D({ loggedIn: true }, { loggedIn: false, why: "codex_nonzero" })); R.set("detectAt", 0); R.set("detects", 0);
    const a = R.focusRedetect(), b = R.focusRedetect();
    R.set("detectAt", 0); R.set("loginPending", "codex"); const c = R.focusRedetect(); R.set("loginPending", null);
    $("view-connect").hidden = true; const d = R.focusRedetect();
    $("set-scrim").hidden = false; $("set-model").hidden = false; const e = R.focusRedetect();
    R.set("detectAt", 0); R.set("lastDetect", D({ loggedIn: true }, { loggedIn: true })); const f = R.focusRedetect();
    t("focusRedetect:第一次重偵測、15 秒內不再;等登入中不碰;連結畫面與模型接入都關著不碰;模型接入開著會;兩個都就緒不碰",
      a === true && b === false && c === false && d === false && e === true && f === false && R.get("detects") === 2, { a, b, c, d, e, f, n: R.get("detects") });
    R.set("detectAt", 0); R.set("loginPending", null); $("view-connect").hidden = false; R.set("lastDetect", D({ loggedIn: true }, { loggedIn: false, why: "codex_timeout", path: "/x/codex" }));
    const unk = R.focusRedetect(), q1 = RSTATE.quiet;
    R.set("detectAt", 0); R.set("lastDetect", D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: false, why: "codex_cantrun", path: "/x/codex" })); const bad = R.focusRedetect(), q2 = RSTATE.quiet;
    t("focusRedetect:不確定、Codex 跑不起來都照樣重偵測,一律走不清列的那一種(detect(true));列與鈕留著,見 check_shell_focus_redetect",
      unk === true && bad === true && q1 === true && q2 === true, { unk, bad, q1, q2 }); $("view-connect").hidden = true;
    t("…掛在 window 的 focus 上", /window\.addEventListener\("focus", focusRedetect\);/.test(app)); }

  // 工作頁的登入失效卡也回前景重新偵測(設計師 D1):卡上那句「回到這裡」才成立。lastDetect 可能還是回合開始前那份(說已登入),
  // 不能拿 mdlNeedsRedetect 擋;偵測到已登入就把卡換成「已登入」+ 重送
  { const tick = () => new Promise((r) => setTimeout(r, 0));
    $("view-connect").hidden = true; $("set-scrim").hidden = true; $("set-model").hidden = true;
    R.set("cur", "codex"); R.set("loginPending", null); R.set("detects", 0);
    R.set("lastDetect", D({ loggedIn: true }, { loggedIn: true }));   // 舊的那份:說兩個都就緒
    const sets = [], el = { isConnected: true }, card = { el, set: (st) => sets.push(st) };
    R.localLoginFlow(card, "codex");
    RSTATE.next = D({ loggedIn: true }, { loggedIn: false, why: "codex_nonzero" });
    R.set("detectAt", 0); const a = R.focusRedetect(); await tick();
    const stillFault = sets[sets.length - 1].text === tr("fault.localAuth", { name: "Codex" }) && R.LOCAL_FAULTS.length === 1;
    const b = R.focusRedetect();                                        // 15 秒內不重來
    R.set("detectAt", 0); R.set("loginPending", "codex"); const c = R.focusRedetect(); R.set("loginPending", null);
    R.set("cur", "claude"); const d = R.focusRedetect(); R.set("cur", "codex");   // 換了引擎:那張卡講的不是現在這條
    el.isConnected = false; const e = R.focusRedetect(); el.isConnected = true;   // 卡已經不在畫面上(開新對話)
    t("失效卡回前景:舊 lastDetect 說已登入也會重偵測;還沒登入卡不動;15 秒內、等登入中、換了引擎、卡不在畫面上都不跑",
      a === true && stillFault && b === false && c === false && d === false && e === false && R.get("detects") === 1, { a, stillFault, b, c, d, e, n: R.get("detects") });
    R.localLoginFlow(card, "codex");
    RSTATE.next = D({ loggedIn: true }, { loggedIn: true, why: null });
    R.set("detectAt", 0); const f = R.focusRedetect(); await tick();
    const last = sets[sets.length - 1];
    t("…偵測到已登入 → 卡換成 login.ok + 重送,不再登記", f === true && last.resend === true && last.text === tr("login.ok", { name: "Codex" }) && R.LOCAL_FAULTS.length === 0, { f, last, n: R.LOCAL_FAULTS.length });
    R.set("detectAt", 0); const g = R.focusRedetect();
    t("…換好之後回前景不再為它偵測(兩個都就緒)", g === false, g);
    RSTATE.next = null; R.LOCAL_FAULTS.length = 0; }

  // 回合結束的登入失效判斷:跑不起來 / 沒有回應不出登入卡
  t("回合結束:loggedOut 排除 whyState(跑不起來、沒有回應)", /loggedOut = !!\(d && d\[cur\] && d\[cur\]\.installed && !d\[cur\]\.loggedIn && !whyState\(d\[cur\]\)\);/.test(app));
  t("連結畫面登入成功直接連上(方案 B):localLogin 在列裡成功 → connect(額度用完卡片開的 modal 那一列同一條)", /if \(\(inRow \|\| inLai\) && r\.ok && x\.installed && x\.loggedIn\) \{\n[^\n]*\n    return connect\(kind, x\);/.test(app));
  t("設定 › 模型接入保留〔登入〕(mdlOptions 仍用 cn.signIn)", /"cn\.signIn" : null\) : curKind === kind/.test(app));

  // CSS 註解不能巢狀:多一個 /* 會把前一條規則的說明吞進去(稽核 P2-6),renderer 每支 css 都掃
  { const RD = path.join(SHELL, "renderer"), bad = [];
    for (const f of fs.readdirSync(RD).filter((x) => x.endsWith(".css"))) {
      const css = fs.readFileSync(path.join(RD, f), "utf8");
      for (const m of css.matchAll(/\/\*[\s\S]*?\*\//g)) if (m[0].slice(2).includes("/*")) bad.push(f + ":" + css.slice(0, m.index).split("\n").length); }
    t("renderer css:沒有註解裡又開一個 /*", bad.length === 0, bad); }

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
