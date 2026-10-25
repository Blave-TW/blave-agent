// 連結畫面的 Codex / Claude 登入(0.1.32 方案 B):偵測分得出「跑不起來」「沒有回應」「沒登入」,PATH 上那顆跑不起來改試退路那顆
// (ChatGPT.app 內附的 codex、SDK 隨包的 claude),登入回結束碼,「已在瀏覽器開啟」等 1 秒才講,沒登入那一列的鈕叫「連結」。
// 起因:cmux 開發版 PATH 上的 codex 包裝腳本回 127,被當成沒登入、叫用戶去登入。
// 主行程那半用 main.js 原文 + 真的子行程跑假的 bin(假 HOME、假 PATH、假 ChatGPT.app;不碰真的 codex / claude、不讀任何憑證檔)。
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
const KEYS = ["row.opened", "row.failed", "row.orCmd", "row.orApp", "st.cantRun", "st.noResp"];
t("字串:六個新 key 在 en / zh 都有", KEYS.every((k) => STR.en[k] && STR.zh[k]));
t("字串:zh「無法啟動」「沒有回應」「已在瀏覽器開啟登入頁」「登入沒有完成。」;「連結」沿用 cn.connect",
  STR.zh["st.cantRun"] === "無法啟動" && STR.zh["st.noResp"] === "沒有回應" && STR.zh["row.opened"] === "已在瀏覽器開啟登入頁" && STR.zh["row.failed"] === "登入沒有完成。" && STR.zh["cn.connect"] === "連結");
t("字串:終端機那一句帶 {cmd} 佔位(兩語)", /\{cmd\}/.test(STR.zh["row.orCmd"]) && /\{cmd\}/.test(STR.en["row.orCmd"]));

// ── 主行程:原文切出來,配假的 loginShellPath / BASE,子行程是真的 ──
const POSIX = process.platform !== "win32";
const PIECES = [constOf(src, "cmdWrap"), fnOf(src, "run"), fnOf(src, "which"), "const LOGIN_CHECK_MS = 400;", fnOf(src, "binKind"), constOf(src, "runRec"), constOf(src, "cantRun"),
  fnOf(src, "detectWhy"), grab(src, /^const BAD_BIN = .*$/m, "BAD_BIN"), fnOf(src, "codexPath"), fnOf(src, "claudePath"), fnOf(src, "detectAgents"),
  "let loginChild = null;", fnOf(src, "agentLogin"), fnOf(src, "cancelAgentLogin")].join("\n");
function mkMain(envPath, chatgpt, bundled) {
  const logged = [];
  const api = new Function("execFile", "spawn", "fs", "path", "process", "loginShellPath", "CODEX_IN_CHATGPT", "bundledClaude", "BASE", "WIN", "detectLogWrite",
    "winRealExe", "storeCodexPath", "winOnPath", "pickWinBin",
    PIECES + "\nreturn { detectAgents, agentLogin, cancelAgentLogin, codexPath, claudePath, BAD_BIN };")(
    require("child_process").execFile, require("child_process").spawn, fs, path, process, async () => envPath, chatgpt, () => bundled, "/b", false, (f, e) => logged.push(e),
    (b) => b, async () => null, (s) => s, () => null);
  api.logged = logged; return api;
}
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "blave-codex-login-"));
const HOME = path.join(ROOT, "home"); fs.mkdirSync(HOME);
process.env.HOME = HOME;   // 假 bin 只看得到這個 HOME;本機真的 ~/.codex 不在任何一步裡
const script = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body, { mode: 0o755 }); return p; };
const binDir = (name) => { const d = path.join(ROOT, name); fs.mkdirSync(d, { recursive: true }); return d; };
const PATH_OF = (d) => d + ":/usr/bin:/bin";
const FAKE_APP = path.join(ROOT, "Applications", "ChatGPT.app", "Contents", "Resources", "codex");
const MISSING_APP = path.join(ROOT, "nope", "ChatGPT.app", "Contents", "Resources", "codex");
// 假 codex:`login status` 看假 HOME 裡的記號檔(不是真的憑證格式,只是「登入過」這件事);`login` 等一下、寫記號、回 0
const CODEX_OK = `#!/bin/sh
if [ "$1" = "login" ] && [ "$2" = "status" ]; then [ -f "$HOME/signed" ] && exit 0; exit 1; fi
if [ "$1" = "login" ]; then sleep 1.3; : > "$HOME/signed"; exit 0; fi
exit 2
`;

(async () => {
  if (!POSIX) { console.log("SKIP  假 bin 是 sh 腳本,Windows 閘門只跑上面的字串檢查"); }
  else {
    // 1. 127:PATH 上的 codex 是包裝腳本、裡面那顆不見了;沒有 ChatGPT.app
    { const d = binDir("b127"); const p127 = script(path.join(d, "codex"), "#!/bin/sh\nexit 127\n");
      const m = mkMain(PATH_OF(d), MISSING_APP, null), r = await m.detectAgents();
      t("127、沒有退路 → installed、沒登入、why=codex_cantrun(不是 nonzero)、via=cli", r.codex.installed && !r.codex.loggedIn && r.codex.why === "codex_cantrun" && r.codex.via === "cli" && r.codex.path === p127, r.codex);
      t("…detect.log 記的是 code=127、沒有路徑", m.logged[0].codex.code === 127 && !JSON.stringify(m.logged).includes(ROOT), m.logged[0].codex);
      const l = await m.agentLogin("codex");
      t("…替他按登入:回 code=127、cantRun=true、ok=false", l.ok === false && l.code === 127 && l.cantRun === true && l.cancelled === false, l); }
    // 2. 127 + ChatGPT.app 內附那顆:改用它,而且之後每一則訊息(codexPath 不帶 seen)也拿它
    { const d = binDir("b127app"); const p127 = script(path.join(d, "codex"), "#!/bin/sh\nexit 127\n");
      script(FAKE_APP, "#!/bin/sh\n[ \"$1 $2\" = \"login status\" ] && exit 0\nexit 2\n");
      const m = mkMain(PATH_OF(d), FAKE_APP, null), r = await m.detectAgents();
      t("127、有 ChatGPT.app → 退到 app 內附那顆:已登入、path 是它、via=app、why=null", r.codex.installed && r.codex.loggedIn && r.codex.path === FAKE_APP && r.codex.via === "app" && r.codex.why === null, r.codex);
      t("…記下 PATH 那顆跑不起來;codexBinNow 那條(codexPath 不帶 seen)跳過它、拿 app 那顆", m.BAD_BIN.codex === p127 && await m.codexPath(PATH_OF(d)) === FAKE_APP);
      t("…detect.log:bin=chatgpt、alt=chatgpt、found=posix(PATH 上找到的檔種)", m.logged[0].codex.bin === "chatgpt" && m.logged[0].codex.alt === "chatgpt" && m.logged[0].codex.found === "posix", m.logged[0].codex);
      fs.writeFileSync(p127, CODEX_OK, { mode: 0o755 });
      const r2 = await m.detectAgents();
      t("…PATH 那顆修好了:重新偵測重設 BAD_BIN、改回用 PATH 那顆", m.BAD_BIN.codex === null && r2.codex.path === p127 && r2.codex.via === "cli" && r2.codex.why === "codex_nonzero", r2.codex);
      fs.rmSync(path.dirname(path.dirname(path.dirname(FAKE_APP))), { recursive: true, force: true }); }
    // 3. 找不到檔:PATH 上沒有、ChatGPT.app 也沒有;另一種是檔在、shebang 指到不存在的直譯器(開不起來 = ENOENT)
    { const m = mkMain(PATH_OF(binDir("empty")), MISSING_APP, null), r = await m.detectAgents();
      t("找不到檔 → installed=false、why=codex_none", !r.codex.installed && r.codex.why === "codex_none" && r.codex.via === null, r.codex);
      const d = binDir("benoent"); script(path.join(d, "codex"), "#!/nonexistent/interp\n");
      const m2 = mkMain(PATH_OF(d), MISSING_APP, null), r2 = await m2.detectAgents(), l = await m2.agentLogin("codex");
      t("檔在、開不起來(ENOENT)→ why=codex_cantrun;登入回 code=ENOENT、cantRun=true", r2.codex.why === "codex_cantrun" && l.code === "ENOENT" && l.cantRun === true && l.ok === false, { why: r2.codex.why, l }); }
    // 4. 逾時:login status 不回(上限在這支測試裡縮成 400ms)
    { const d = binDir("bslow"); script(path.join(d, "codex"), "#!/bin/sh\nexec sleep 5\n");
      const t0 = Date.now(), r = await mkMain(PATH_OF(d), MISSING_APP, null).detectAgents();
      t("逾時 → why=codex_timeout(畫面「沒有回應」),不會等滿 5 秒", r.codex.installed && !r.codex.loggedIn && r.codex.why === "codex_timeout" && Date.now() - t0 < 3000, r.codex); }
    // 5. 正常登入:沒登入 → 替他跑 `codex login`(活過 1 秒、回 0)→ 再偵測就是已登入
    { const d = binDir("bok"); script(path.join(d, "codex"), CODEX_OK);
      const m = mkMain(PATH_OF(d), MISSING_APP, null), r = await m.detectAgents();
      t("正常、沒登入 → why=codex_nonzero(畫面〔連結〕)", r.codex.installed && !r.codex.loggedIn && r.codex.why === "codex_nonzero", r.codex);
      const l = await m.agentLogin("codex"), r2 = await m.detectAgents();
      t("…登入回 ok、code=0、cantRun=false;再偵測已登入", l.ok === true && l.code === 0 && l.cantRun === false && r2.codex.loggedIn === true && r2.codex.why === null, { l, c: r2.codex });
      fs.rmSync(path.join(HOME, "signed"), { force: true });
      const p2 = m.agentLogin("codex"); await new Promise((res) => setTimeout(res, 200)); m.cancelAgentLogin(); const cx = await p2;
      t("…按「取消等待」→ cancelled=true、ok=false、不是 cantRun", cx.cancelled === true && cx.ok === false && cx.cantRun === false, cx); }
    // 6. Claude 同一套:PATH 上的 claude 跑不起來 → 改用 SDK 隨包那顆
    { const d = binDir("bclaude"); script(path.join(d, "claude"), "#!/bin/sh\nexit 127\n");
      const bundled = script(path.join(ROOT, "venv", "claude_agent_sdk", "_bundled", "claude"), "#!/bin/sh\necho '{\"loggedIn\":true,\"authMethod\":\"x\"}'\n");
      const m = mkMain(PATH_OF(d), MISSING_APP, bundled), r = await m.detectAgents();
      t("claude 127 → 退到隨包那顆、已登入", r.claude.loggedIn && r.claude.path === bundled && r.claude.why === null && m.BAD_BIN.claude === path.join(d, "claude"), r.claude);
      const m2 = mkMain(PATH_OF(d), MISSING_APP, null), r2 = await m2.detectAgents();
      t("…沒有隨包那顆 → claude_cantrun", r2.claude.installed && r2.claude.why === "claude_cantrun", r2.claude); }
  }

  // ── 畫面:原文切出來配假的 DOM ──
  const mkEl = (tag) => {
    const n = { tag, children: [], dataset: {}, attrs: {}, className: "", disabled: false, parent: null, _txt: "", _html: "",
      append: (...xs) => xs.forEach((x) => { if (typeof x === "string") n.children.push({ text: x }); else if (x.frag) x.children.forEach((c) => { c.parent = n; n.children.push(c); }); else { x.parent = n; n.children.push(x); } }),
      appendChild: (x) => { n.append(x); return x; },
      addEventListener: (ev, fn) => { if (ev === "click") n.onclick = fn; },
      setAttribute: (k, v) => { n.attrs[k] = String(v); },
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
  const R = new Function("document", "$", "t", "getLang", "window", "state",
    `let LANG; const sync = () => { LANG = getLang(); };
     let loginPending = null, oauthPending = false, lastDetect = null, cur = null, HINT = null, detects = 0, said = [];
     const MDL = { busy: false }, mdlPaint = () => {}, paintBlaveBtn = () => {}, connect = (k) => { state.connected = k; }, srSay = (x) => said.push(x), trackEvent = () => {};
     const cmdLine = (k) => k;
     function detect() { detects++; detectAt = Date.now(); }
     let detectAt = 0;
     ${constOf(app, "ROWMSG")}
     ${constOf(app, "REDETECT_GAP_MS")}
     ${fnOf(app, "focusRedetect")}
     ${constOf(app, "whyState")}
     ${fnOf(app, "mdlNeedsRedetect")}
     ${fnOf(app, "row")}
     ${fnOf(app, "btn")}
     ${fnOf(app, "paintRows")}
     ${fnOf(app, "rowMsg")}
     ${constOf(app, "LOGIN_CMD")}
     ${constOf(app, "LOGIN_OPENED_MS")}
     ${fnOf(app, "agentLoginRun")}
     ${fnOf(app, "hintFill")}
     return { sync, paintRows, rowMsg, agentLoginRun, hintFill, focusRedetect, whyState,
       set: (k, v) => { eval(k + " = v"); }, get: (k) => eval(k), ROWMSG, said };`)(document, $, (k, v) => tr(k, v), () => LANG, { blave: { cancelAgentLogin: () => {} } }, {});
  R.sync();
  const rows = () => $("agent-rows").children.map((r) => {
    const st = (r._html.match(/class="cn-st[^"]*">(?:<span class="dot"><\/span>)?([^<]*)/) || [, ""])[1];
    const msg = (r.firstChild.children.find((c) => c.className === "msg") || {}).textContent || "";
    const b = r.children.find((c) => c.tag === "button");
    return [r.dataset.kind, r.className.includes("off") ? "off" : "", st, msg, b ? b.textContent + (b.disabled ? "(x)" : "") : ""].join("|");
  });
  const D = (claude, codex) => ({ claude: { installed: true, ...claude }, codex: { installed: true, via: "cli", ...codex } });
  R.set("lastDetect", D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: false, why: "codex_cantrun" })); R.paintRows(R.get("lastDetect"));
  t("連結畫面:沒登入 → 〔連結〕;127 → 「無法啟動」、列變灰、沒有鈕", JSON.stringify(rows()) === JSON.stringify(["claude|||" + "|連結", "codex|off|無法啟動||"]), rows());
  R.set("lastDetect", D({ loggedIn: true, why: null }, { loggedIn: false, why: "codex_timeout" })); R.paintRows(R.get("lastDetect"));
  t("…逾時 → 「沒有回應」、沒有鈕;已登入 → 「已登入」+〔連結〕", JSON.stringify(rows()) === JSON.stringify(["claude||已登入||連結", "codex|off|沒有回應||"]), rows());
  R.set("lastDetect", D({ installed: false }, { loggedIn: false, why: "codex_nonzero" })); R.set("loginPending", "codex"); R.ROWMSG.codex = "opened"; R.paintRows(R.get("lastDetect"));
  t("…等瀏覽器:那一列名字底下「已在瀏覽器開啟登入頁」、鈕是「取消等待」", JSON.stringify(rows()) === JSON.stringify(["claude|off|未偵測到||", "codex|||已在瀏覽器開啟登入頁|取消等待"]), rows());
  R.set("loginPending", null); R.ROWMSG.codex = "failed"; R.paintRows(R.get("lastDetect"));
  t("…失敗 · CLI 版:「登入沒有完成。或在終端機執行 codex login。」(句號後不多一個空格)、鈕「再試一次」", rows()[1] === "codex|||登入沒有完成。或在終端機執行 codex login。|再試一次", rows());
  R.set("lastDetect", D({ installed: false }, { loggedIn: false, why: "codex_nonzero", via: "app" })); R.paintRows(R.get("lastDetect"));
  t("…失敗 · ChatGPT app 版:退路是在 app 裡登入,不給 codex login", rows()[1] === "codex|||登入沒有完成。或在 ChatGPT app 裡登入，再按重新偵測。|再試一次", rows());
  LANG = "en"; R.sync(); R.set("lastDetect", D({ installed: false }, { loggedIn: false, why: "codex_nonzero", via: "cli" })); R.paintRows(R.get("lastDetect"));
  t("…en:兩句中間有一個空格", rows()[1] === "codex|||Sign-in didn’t finish. Or run codex login in a terminal.|Try Again", rows());
  R.ROWMSG.claude = "failed"; R.set("lastDetect", D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: true })); R.paintRows(R.get("lastDetect"));
  t("…Claude 失敗給 claude auth login;登入成功的那一列訊息清掉", rows()[0] === "claude|||Sign-in didn’t finish. Or run claude auth login in a terminal.|Try Again" && R.ROWMSG.codex === null, rows());
  LANG = "zh"; R.sync(); R.ROWMSG.claude = null;
  R.set("lastDetect", D({ loggedIn: false, why: "claude_nonzero" }, { loggedIn: false, why: "codex_nonzero" })); R.set("loginPending", "claude"); R.paintRows(R.get("lastDetect"));
  t("…等登入中:別的列的鈕鎖住,只有那一列的「取消等待」能按", JSON.stringify(rows()) === JSON.stringify(["claude||||取消等待", "codex||||連結(x)"]), rows());
  R.set("loginPending", null);

  // 共用訊息格(三個表面同一支 hintFill):中文句尾全形標點後不補空格,英文補一個
  { const fill = (lang, h) => { LANG = lang; R.sync(); R.set("HINT", h); const n = mkEl("p"); R.hintFill(n); return n.textContent; };
    t("hintFill:zh「Codex 登入沒有完成。」接退路不多空格;en 補一個;沒有 cmd 不補;沒有訊息不畫",
      fill("zh", { text: "Codex 登入沒有完成。", cmd: "codex" }) === "Codex 登入沒有完成。codex" && fill("en", { text: "Codex sign-in didn’t finish.", cmd: "codex" }) === "Codex sign-in didn’t finish. codex"
      && fill("en", { text: "x" }) === "x" && fill("zh", null) === "");
    LANG = "zh"; R.sync();
    t("三處接字(setHint、模型接入、帳號訊息格)都走 hintFill,不再自己接空格",
      !/HINT\.text \+ \(HINT\.cmd \? " " : ""\)/.test(app) && (app.match(/hintFill\((n|p|hint)\);/g) || []).length === 3); }

  // 「已在瀏覽器開啟」等 1 秒:跑不起來的子行程在那之前就結束,不講
  { const run = async (ms, res) => { let opened = 0; R.set("loginPending", "codex");
      const w = { agentLogin: () => new Promise((r) => setTimeout(() => r(res), ms)) };
      const f = new Function("window", "loginPending", "LOGIN_OPENED_MS", fnOf(app, "agentLoginRun") + "\nreturn agentLoginRun;")({ blave: w }, "codex", 1000);
      const r = await f("codex", () => opened++); return { opened, r }; };
    const fast = await run(50, { ok: false, code: 127, cantRun: true }), slow = await run(1300, { ok: true, code: 0 });
    t("agentLoginRun:127 在 1 秒內結束 → 不講「已開瀏覽器」、結果照回;活過 1 秒 → 講一次", fast.opened === 0 && fast.r.code === 127 && slow.opened === 1 && slow.r.ok === true, { fast, slow });
    R.set("loginPending", null); }

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
    t("…掛在 window 的 focus 上", /window\.addEventListener\("focus", focusRedetect\);/.test(app)); }

  // 回合結束的登入失效判斷:跑不起來 / 沒有回應不出登入卡
  t("回合結束:loggedOut 排除 whyState(跑不起來、沒有回應)", /loggedOut = !!\(d\[cur\] && d\[cur\]\.installed && !d\[cur\]\.loggedIn && !whyState\(d\[cur\]\)\);/.test(app));
  t("連結畫面登入成功直接連上(方案 B):localLogin 在列裡成功 → connect", /if \(inRow && r\.ok && x\.installed && x\.loggedIn\) return connect\(kind, x\);/.test(app));
  t("設定 › 模型接入保留〔登入〕(mdlOptions 仍用 cn.signIn)", /"cn\.signIn" : null\) : curKind === kind/.test(app));

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
