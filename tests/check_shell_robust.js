// 報告頁「參數掃描」分頁(shell/renderer/report-robust.js,雲端工作頁 robust 段的移植)。
//   ① 純函式(node 直接 vm 載入):sanitizeScan 壞輸入 → null、目前參數先從策略碼的頂層常數找、
//      找不到才用 scan.current 並依 generated_at < "Generated At" 判過時、robWhere 五態、缺 nbr_mean / peak / plateau 自算。
//   ② 用隨包的 Electron 開真的 index.html,真的 renderRobust 一次:空狀態(鈕、busy 停用、送出後鎖成「已送出」)、
//      有 scan(tag、三列比較表、熱圖 R×C 格、目前參數虛線格、可 focus 的角色格、鄰域平均切換、meta 的「掃描 R×C」、
//      欄數多時把標記格捲進可視範圍);「已送出」不跨回合、本機 / 雲端不互污染(robSync 就地改鈕)。
//   ③ 主行程:loadStrategy 帶出 scan.json、listStrategies 的 mtime 把 scan.json 算進去;cloud.js 白名單留 scan。
// 跑法:node tests/check_shell_robust.js(找不到 shell/node_modules 的 Electron 時 ② SKIP,①③ 照跑)
const path = require("path"), fs = require("fs"), vm = require("vm");
const SHELL = path.join(__dirname, "..", "shell");
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };

// 3×3:尖峰 (0,0) 孤立高;(1..2, 1..2) 平原;(2,0) 沒交易
const SCAN = { row_param: "A", col_param: "B", row_vals: [10, 20, 30], col_vals: [0.5, 0.7, 0.9],
  grid: [[3.0, 0.2, 0.1], [0.3, 1.4, 1.5], [null, 1.5, 1.6]], window: 1, fee: 0.0005, start: "2025-01-01", end: "2025-06-01", generated_at: 100 };

if (!process.versions.electron) {
  // ── ① 純函式 ──
  const sb = { window: {}, console };
  vm.runInNewContext(fs.readFileSync(path.join(SHELL, "renderer", "report-robust.js"), "utf8"), sb);
  const R = sb.window.BlaveReport._rob;
  const sc = R.sanitizeScan(SCAN, null, "");
  ok("① 合法 scan(缺 nbr_mean / peak / plateau):自算 → 尖峰 (0,0)、穩健 = 鄰域平均最高 (2,2)、rd/cd 小數位 0/1", !!sc && sc.peak.i === 0 && sc.peak.j === 0 && sc.plateau.i === 2 && sc.plateau.j === 2 && sc.rd === 0 && sc.cd === 1 && sc.nbr[2][0] === null && Math.abs(sc.nbr[1][1] - (3.0 + 0.2 + 0.1 + 0.3 + 1.4 + 1.5 + 1.5 + 1.6) / 8) < 1e-9);
  ok("① scan 自帶 peak / plateau / nbr_mean:以機器端為準,不重算", (() => { const s = R.sanitizeScan({ ...SCAN, peak: { i: 1, j: 1 }, plateau: { i: 1, j: 2 }, nbr_mean: [[9, 9, 9], [9, 9, 9], [9, 9, 9]] }, null, ""); return s.peak.i === 1 && s.plateau.j === 2 && s.nbr[0][0] === 9; })());
  ok("① 索引出界的 peak / 形狀不對的 nbr_mean:退回自算,不丟例外", (() => { const s = R.sanitizeScan({ ...SCAN, peak: { i: 7, j: 0 }, nbr_mean: [[1, 2]] }, null, ""); return s.peak.i === 0 && s.nbr.length === 3; })());
  const BAD = [null, 7, "x", [], {}, { ...SCAN, row_param: "" }, { ...SCAN, col_param: "x".repeat(65) }, { ...SCAN, row_vals: [10, "20", 30] }, { ...SCAN, row_vals: [10, NaN, 30] },
    { ...SCAN, col_vals: [] }, { ...SCAN, col_vals: Array.from({ length: 41 }, (_, i) => i) }, { ...SCAN, grid: [[1, 2, 3], [1, 2, 3]] }, { ...SCAN, grid: [[1, 2], [1, 2], [1, 2]] }, { ...SCAN, grid: "no" },
    { ...SCAN, grid: [[null, null, null], [null, null, null], [null, null, null]] }];
  ok("① 壞輸入一律 null(缺 / 型別錯 / 參數名 >64 / 軸 >40 / 空軸 / 網格形狀不合 / 全格沒交易):" + BAD.length + " 種", BAD.every((b) => R.sanitizeScan(b, null, "") === null));
  ok("① 每格非有限值視為缺(NaN 經 JSON 是 null;字串也當缺)", R.sanitizeScan({ ...SCAN, grid: [[3.0, "x", 0.1], [0.3, 1.4, 1.5], [null, 1.5, 1.6]] }, null, "").grid[0][1] === null);
  ok("① 目前參數先從策略碼頂層常數找(取最後一個;行尾註解照收;縮排 / 算式不認)", (() => {
    const a = R.sanitizeScan(SCAN, null, "A = 10\nA = 20  # tuned\nB = 0.7\n"); const b = R.sanitizeScan(SCAN, null, "    A = 20\nB = 0.7 * 2\n");
    return a.cur && a.cur.i === 1 && a.cur.j === 1 && b.cur === null && R.constFromCode("A = 1e3", "A") === 1000 && R.constFromCode("A = -.5", "A") === -0.5 && R.constFromCode("A = 1", "a b") === null; })());
  ok("① 常數不在軸上 → 不在掃描範圍({i:null, vals})→ outscan", (() => { const s = R.sanitizeScan(SCAN, null, "A = 99\nB = 0.7"); return s.cur && s.cur.i === null && s.cur.vals[0] === 99 && R.robWhere(s) === "outscan"; })());
  ok("① 策略碼讀不到常數才用 scan.current;scan 早於回測(generated_at < Generated At)→ 過時、current 丟掉", (() => {
    const cur = { ...SCAN, current: { i: 0, j: 0, vals: [10, 0.5] } };
    const fresh = R.sanitizeScan(cur, { "Generated At": 50 }, ""), stale = R.sanitizeScan(cur, { "Generated At": 200 }, ""), noBt = R.sanitizeScan(cur, null, "");
    return !fresh.stale && fresh.cur.i === 0 && stale.stale && stale.cur === null && R.robWhere(stale) === "stale" && !noBt.stale && noBt.cur.i === 0; })());
  ok("① 策略碼有常數就不看時間戳(採用穩健參數重跑後 scan.current 才是舊的)", !R.sanitizeScan({ ...SCAN, current: { i: 0, j: 0 } }, { "Generated At": 200 }, "A = 30\nB = 0.9").stale);
  ok("① scan.current 出界但帶 vals → 不在掃描範圍;vals 不是兩個數 → 未知", (() => { const a = R.sanitizeScan({ ...SCAN, current: { i: null, j: null, vals: [1, 2] } }, null, ""), b = R.sanitizeScan({ ...SCAN, current: { vals: [1] } }, null, ""); return a.cur.i === null && a.cur.vals[1] === 2 && b.cur === null && R.robWhere(b) === "outscan"; })());
  const at = (i, j) => R.sanitizeScan({ ...SCAN, current: { i, j } }, null, "");
  ok("① robWhere 五態:尖峰上 / 就是穩健格 → inside / 鄰域內 → inside / 區外 / outscan", R.robWhere(at(0, 0)) === "peak" && R.robWhere(at(2, 2)) === "inside" && R.robWhere(at(1, 1)) === "inside" && R.robWhere(at(0, 2)) === "outside" && R.robWhere(R.sanitizeScan(SCAN, null, "")) === "outscan");
  ok("① 尖峰 = 穩健同格時是 inside 不是 peak(穩健格本身優先)", R.robWhere(R.sanitizeScan({ ...SCAN, peak: { i: 2, j: 2 }, current: { i: 2, j: 2 } }, null, "")) === "inside");
  ok("① window 不是正整數 / 超過每軸上限 → 1;window 2 時鄰域擴到 5×5", R.sanitizeScan({ ...SCAN, window: 0 }, null, "").w === 1 && R.sanitizeScan({ ...SCAN, window: 41 }, null, "").w === 1 && R.sanitizeScan({ ...SCAN, window: 2.5 }, null, "").w === 1 && R.sanitizeScan({ ...SCAN, window: 2 }, null, "").w === 2 && R.robWhere(R.sanitizeScan({ ...SCAN, window: 2, current: { i: 0, j: 2 } }, null, "")) === "inside");
  ok("① 格式:負號用 U+2212(科學記號的指數負號也換)、缺值 —", R.pv(-0.5, 2) === "−0.50" && R.pv(1e-7, 2) === "1e−7" && R.f2(null) === "—" && R.f2(-0.001) === "0.00" && R.f2(1.234) === "1.23");
  ok("① 送出簽章只看 scan / code / Generated At(整份 stats 每根 K 都會變)", R.sentSig({ scan: SCAN, code: "x", stats: { "Generated At": 1, "Sharpe Ratio": 2 } }) === R.sentSig({ scan: SCAN, code: "x", stats: { "Generated At": 1, "Sharpe Ratio": 3 } }) && R.sentSig({ scan: SCAN, code: "x", stats: null }) !== R.sentSig({ scan: SCAN, code: "y", stats: null }));

  // ── ③ 主行程 / cloud.js ──
  const main = fs.readFileSync(path.join(SHELL, "main.js"), "utf8"), fn = (n) => main.slice(main.indexOf("function " + n + "("), main.indexOf("\n}\n", main.indexOf("function " + n + "(")));
  ok("③ loadStrategy 讀 strategies/<name>/scan.json,不是物件 → null;回傳帶 scan", /"scan\.json"/.test(fn("loadStrategy")) && /Array\.isArray\(scan\)\) scan = null;/.test(fn("loadStrategy")) && /return \{ name, stats, scan, code,/.test(fn("loadStrategy")));
  ok("③ listStrategies 的 mtime 把 scan.json 算進去(只掃描沒回測的那一輪結束後 stratRefresh(true) 才會重載)", /scMtime = fs\.statSync\(path\.join\(dir, "scan\.json"\)\)\.mtimeMs/.test(fn("listStrategies")) && /Math\.max\(mtime, sMtime, scMtime\)/.test(fn("listStrategies")) && (fn("listStrategies").match(/mtime: touched/g) || []).length === 2);
  const { interpretStrategy } = require(path.join(SHELL, "cloud.js"));
  const body = (s) => ({ status: 200, body: { strategy: { name: "m", code: "", ...s } } });
  ok("③ cloud.js interpretStrategy 留 scan(物件才給,否則 null)", interpretStrategy(body({ scan: SCAN }), "m").strategy.scan.row_param === "A" && interpretStrategy(body({ scan: [1] }), "m").strategy.scan === null && interpretStrategy(body({}), "m").strategy.scan === null);
  const app = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8"), html = fs.readFileSync(path.join(SHELL, "renderer", "index.html"), "utf8");
  ok("③ app.js:rpShowTab / rpBodyPaint 的分頁清單含 rob,rob 交給 renderRobust(t / busy / onScan / buildMeta 都從外面交進去);index.html 有分頁鈕、面板、css、js", (app.match(/\["bt", "tr", "rob", "code"\]/g) || []).length === 2
    && /R\.renderRobust\(\$\("rp-rob"\), \{ stats: B\.data\.stats, scan: B\.data\.scan \|\| null, code: B\.data\.code, name: B\.name \}, rpRobOpts\(\)\)/.test(app)
    && /return \{ t, busy: running, turn: turnSeq, scope: rpBag\(\) === RPC \? "cloud" : "local", onScan: rpRobAsk, buildMeta: R\.buildMeta \};/.test(app)
    && /data-tab="rob" data-i18n="rp\.tab\.rob"/.test(html) && /id="rp-rob" role="tabpanel" hidden/.test(html) && /report-robust\.css/.test(html) && /<script src="report-robust\.js"><\/script>\s*(?:<script src="(?:report-blocks|reports|newstrategy)\.js"><\/script>\s*)*<script src="trade\.js">/.test(html));
  ok("③ app.js:掃描鈕走確認框 → submitMessage(不覆寫 viewing:chatViewing 在雲端視角本來就回 env:cloud + strategy)、resolve 回合序號;回合開始 / 結束三處都叫 rpRobSync(就地改鈕,不重畫);每輪 turnSeq++",
    /onOk: \(\) => submitMessage\(t\("rob\.msgScan", \{ name \}\)\)\.then\(\(ok\) => \{ if \(ok\) trackFeature\("scan_requested"\); resolve\(ok \? turnSeq : false\); \}\)/.test(app) && !/viewing/.test(app.slice(app.indexOf("function rpRobAsk"), app.indexOf("function rpRobSync"))) && (app.match(/rpRobSync\(\);/g) || []).length === 3
    && /R\.robSync\(\$\("rp-rob"\), rpRobOpts\(\)\)/.test(app) && /UPD\.turnCloud = false; turnSeq\+\+;/.test(app));
  ok("③ app.js onTurnEnd:碰過雲端的回合結束 → 雲端那支的報告背景重抓(rpCloudSelect force),而且在 upTurnEnded 歸零 UPD.turnCloud 之前先記下", (() => { const s = app.slice(app.indexOf("window.blave.onTurnEnd("), app.indexOf("/* 側欄 / 聊天欄")); return /const cloudTurn = UPD\.turnCloud;/.test(s) && s.indexOf("const cloudTurn = UPD.turnCloud;") < s.indexOf("upTurnEnded(faulted);") && /if \(cloudTurn && RPC\.name\) rpCloudSelect\(RPC\.name, true\);/.test(s) && s.indexOf("rpRobSync();") < s.indexOf("rpCloudSelect(RPC.name, true)"); })());
  const css = fs.readFileSync(path.join(SHELL, "renderer", "report-robust.css"), "utf8"), tok = fs.readFileSync(path.join(SHELL, "renderer", "tokens.css"), "utf8");
  ok("③ 設計稽核:圖例色塊不叫 .sw(撞 app.css 的開關);風險 tag 用 tokens 的 redLight / redBlack(亮暗各一組);比較表 overflow-x:auto;glyph 貼左上角(置中會壓到數字,設計師複核 09-25);空狀態那一句 13px",
    !/\.rob-legend \.sw\b/.test(css) && /\.rob-legend \.rob-sw \{/.test(css) && /\.rob-tag\.is-risk \{\s*background: var\(--color-redLight\);\s*color: var\(--color-redBlack\);/.test(css)
    && (tok.match(/--color-redLight:/g) || []).length === 2 && (tok.match(/--color-redBlack:/g) || []).length === 2 && /\.rob-cmp \{[^}]*overflow-x: auto;/.test(css)
    && /\.rob-tbl td \.rob-glyph \{[^}]*position: absolute;\s*left: 4px;\s*top: 2px;/.test(css) && /\.rob-empty-txt \{[^}]*font-size: 13px;[^}]*color: var\(--ink-3\);/.test(css) && !/\.rob-tipwrap/.test(css));

  // ── ② 交給 Electron ──
  const bin = path.join(SHELL, "node_modules", ".bin", "electron");
  if (!fs.existsSync(bin)) { console.log("SKIP  ② 找不到 shell/node_modules 的 Electron(先 cd shell && npm install)"); console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
  const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
  const sub = r.status == null ? 1 : r.status;
  console.log(red || sub ? `\n${red + sub} 紅` : "\nALL PASS");
  process.exit(red || sub ? 1 : 0);
}

const { app, BrowserWindow } = require("electron");
const os = require("os");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-robust-")));
const STUB = `window.blave = new Proxy({}, { get: (_, k) => typeof k !== "string" ? undefined
  : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {}
  : async () => ({ getLocale: "zh-TW", loadConnection: { kind: "claude" }, detectAgents: { claude: { installed: true, loggedIn: true }, codex: { installed: false } },
      listStrategies: [], listSessions: [], loadSession: [], loadSessionImages: [], updateState: { phase: "idle", current: "0.0.0" } })[k] });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  ② 逾時(60 秒)"); process.exit(1); }, 60000).unref();

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const pre = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(pre, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload: pre, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1000);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const STATS = { symbol: "BTCUSDT", interval: "1h", start: "2025-01-01", end: "2025-06-01", "fee [%]": 0.05, "Generated At": 50 };
  // 一次畫進 #rp-rob 的複本(同 CSS 環境);opts 由測試自己給:t 用畫面上那顆、onScan 記下呼叫並回 true
  await js(`window.__calls = []; window.__turn = 1; window.__box = document.createElement("div"); document.body.appendChild(window.__box);
    window.__opts = (busy, turn, scope) => ({ t, busy, turn: turn == null ? window.__turn : turn, scope: scope || "local", buildMeta: window.BlaveReport.buildMeta, onScan: (name, opener) => { window.__calls.push([name, opener && opener.tagName]); return new Promise((r) => setTimeout(() => r(window.__turn), 5)); } });   // 同 app:resolve 時才知道跑起來的是哪一輪
    window.__render = (data, busy, turn, scope) => window.BlaveReport.renderRobust(window.__box, data, window.__opts(busy, turn, scope));
    window.__sync = (busy, turn, scope) => window.BlaveReport.robSync(window.__box, window.__opts(busy, turn, scope)); 0;`);

  // 空狀態
  let r = await js(`(() => { window.__render({ stats: ${JSON.stringify(STATS)}, scan: null, code: "", name: "s1" }, false);
    const b = window.__box.querySelector(".rob-empty button.btn-fill"), p = window.__box.querySelector(".rob-empty .rob-empty-txt"); return { has: !!b, dis: b && b.disabled, txt: b && b.textContent, line: p && p.textContent, before: p && p.nextElementSibling === b, cap: !!window.__box.querySelector(".rob-cap"), heat: !!window.__box.querySelector(".rob-tbl") }; })()`);
  ok("② 沒有 scan:空狀態 = 一句「還沒掃過參數。」+ 一顆「開始掃描」填色鈕(句在鈕前)、可按、沒有熱圖", r.has && !r.dis && r.txt === (await js(`t("rob.btnScan")`)) && r.line === (await js(`t("rob.empty")`)) && r.before && !r.cap && !r.heat);
  r = await js(`(() => { window.__render({ stats: ${JSON.stringify(STATS)}, scan: null, code: "", name: "s1" }, true);
    const b = window.__box.querySelector(".rob-empty button.btn-fill"); return { dis: b.disabled, txt: b.textContent, cap: (window.__box.querySelector(".rob-cap") || {}).textContent }; })()`);
  ok("② 回合進行中:鈕停用 + 一行「agent 正在回覆上一則訊息」;文字仍是「開始掃描」", r.dis && r.txt === (await js(`t("rob.btnScan")`)) && r.cap === (await js(`t("rob.busy")`)));
  r = await js(`(async () => { window.__render({ stats: ${JSON.stringify(STATS)}, scan: null, code: "", name: "s1" }, false);
    const b0 = window.__box.querySelector(".rob-empty button"); b0.focus(); b0.click();
    window.__turn = 7; window.__sync(true);   // 送出 → app 那邊回合開始:busy + 新序號(promise 還沒回來)
    const mid = { dis: b0.disabled, txt: b0.textContent, cap: !!window.__box.querySelector(".rob-cap") };
    await new Promise((r) => setTimeout(r, 30));
    const b = window.__box.querySelector(".rob-empty button.btn-fill");
    return { calls: window.__calls, mid, same: b === b0, dis: b.disabled, txt: b.textContent, cap: !!window.__box.querySelector(".rob-cap") }; })()`);
  // 焦點:Chromium 把 focus 中的鈕設成 disabled 就會自己掉到 body(真 disabled 的規格行為,web 同),節點不重建能保的是不閃、不 reflow
  ok("② 按下 → 回合開始先鎖鈕 + 忙碌說明 → onScan 回來(回合序號)→ 同一顆鈕就地改成「已送出，看對話」(不重建、說明收掉)",
    JSON.stringify(r.calls) === '[["s1","BUTTON"]]' && r.mid.dis && r.mid.txt === (await js(`t("rob.btnScan")`)) && r.mid.cap && r.same && r.dis && r.txt === (await js(`t("rob.btnSent")`)) && !r.cap);
  r = await js(`(() => { window.__render({ stats: ${JSON.stringify(STATS)}, scan: null, code: "", name: "s1" }, true); const b = window.__box.querySelector(".rob-empty button"); return b.textContent; })()`);
  ok("② 同一支、簽章沒變、同一回合還在跑:整塊重畫仍是「已送出」", r === (await js(`t("rob.btnSent")`)));
  r = await js(`(() => { window.__sync(false); const a = window.__box.querySelector(".rob-empty button"); const r1 = [a.textContent, a.disabled, !!window.__box.querySelector(".rob-cap")];
    window.__turn = 8; window.__sync(true); const b = window.__box.querySelector(".rob-empty button"); return { r1, r2: [b.textContent, b.disabled, !!window.__box.querySelector(".rob-cap")], same: a === b }; })()`);
  ok("② 回合結束沒產出:就地解鎖回「開始掃描」;下一輪無關的回合開始:只是停用 + 忙碌說明,不再變回「已送出」(不跨回合)", r.r1[0] === (await js(`t("rob.btnScan")`)) && r.r1[1] === false && !r.r1[2] && r.r2[0] === (await js(`t("rob.btnScan")`)) && r.r2[1] === true && r.r2[2] && r.same);
  r = await js(`(() => { window.__turn = 7; window.__render({ stats: ${JSON.stringify(STATS)}, scan: null, code: "", name: "s1" }, true, 7, "cloud"); return window.__box.querySelector(".rob-empty button").textContent; })()`);
  ok("② 雲端視角的同名策略(同 sig、同回合):不吃本機那份的「已送出」", r === (await js(`t("rob.btnScan")`)));
  r = await js(`(() => { window.__render({ stats: ${JSON.stringify(STATS)}, scan: ${JSON.stringify(SCAN)}, code: "", name: "s1" }, false); window.__sync(true); return !window.__box.querySelector(".rob-empty") && !!window.__box.querySelector(".rob-tbl"); })()`);
  ok("② 有掃描結果的頁:robSync 什麼都不做(沒有鈕可改、不重畫)", r);

  // 有 scan:目前參數在尖峰上(策略碼 A=10 / B=0.5)
  const full = (code) => js(`(() => { window.__render({ stats: ${JSON.stringify(STATS)}, scan: ${JSON.stringify(SCAN)}, code: ${JSON.stringify(code)}, name: "s1" }, false);
    const q = (s) => [...window.__box.querySelectorAll(s)];
    const cur = q(".rob-tbl td.is-current")[0];
    return { meta: (window.__box.querySelector(".bt-meta") || {}).textContent, tag: (window.__box.querySelector(".rob-tag") || {}).className, verdict: (window.__box.querySelector(".rob-verdict") || {}).textContent,
      rows: q(".rob-cmp-tbl tbody tr").map((tr) => [...tr.children].map((td) => td.textContent)), cells: q(".rob-tbl td").length, cur: cur ? [cur.dataset.i, cur.dataset.j] : null,
      focusable: q(".rob-tbl td[tabindex='0']").map((td) => td.dataset.i + td.dataset.j), na: q(".rob-tbl td.is-na").map((td) => td.textContent), glyphs: q(".rob-tbl td .rob-glyph").map((g) => g.className),
      c00: q(".rob-tbl td")[0].textContent, bg00: q(".rob-tbl td")[0].style.background, aria: q(".rob-tbl td")[0].getAttribute("aria-label"), legend: q(".rob-legend .it").length, sw: q(".rob-legend .rob-sw").length, oldSw: q(".rob-legend .sw").length }; })()`);
  r = await full("A = 10\nB = 0.5\n");
  const tf = (k, v) => js(`t(${JSON.stringify(k)}, ${JSON.stringify(v || {})})`);
  ok("② meta 列:回測那一行 + 「掃描 3×3」", r.meta && r.meta.includes("BTCUSDT") && r.meta.endsWith((await tf("rob.metaScan")) + "3×3"));
  ok("② 尖峰上:風險 tag + 尖峰那句;比較表只有尖峰 / 穩健兩列(目前就是尖峰列)", /is-risk/.test(r.tag) && r.verdict === (await tf("rob.verdict.peak")) && r.rows.length === 2 && r.rows[0][1] === "10 / 0.5" && r.rows[0][2] === "3.00" && r.rows[1][1] === "30 / 0.9");
  ok("② 熱圖 3×3 = 9 格;目前參數虛線格在 (0,0);可 focus 的只有有角色的格(尖峰=目前 (0,0)、穩健 (2,2));沒交易那格「—」", r.cells === 9 && JSON.stringify(r.cur) === '["0","0"]' && r.focusable.join() === "00,22" && r.na.join() === "—");
  ok("② 格內:▲ / ● 是 CSS 幾何 glyph、數字兩位小數、底色是 token + alpha 現算(不是 hex)、aria-label 帶參數對 / 值 / 角色", r.glyphs.join() === "rob-glyph peak,rob-glyph plateau" && r.c00 === "3.00" && /^rgba\(/.test(r.bg00) && r.aria.startsWith("A 10 · B 0.5: ") && r.aria.includes("(") && r.legend === 4 && r.sw === 3 && r.oldSw === 0);
  r = await full("A = 10\nB = 0.9\n");
  ok("② 區外:中性 tag、三列(多「目前」列 10 / 0.9)、虛線格在 (0,2)", /is-neutral/.test(r.tag) && r.verdict === (await tf("rob.verdict.outside")) && r.rows.length === 3 && r.rows[2][1] === "10 / 0.9" && JSON.stringify(r.cur) === '["0","2"]' && r.focusable.join() === "00,02,22");
  r = await full("A = 99\nB = 0.5\n");
  ok("② 不在掃描範圍:目前列參數照寫、兩個值 —、沒有虛線格", r.verdict === (await tf("rob.verdict.outscan")) && r.rows[2][1] === "99 / 0.5" && r.rows[2][2] === "—" && r.rows[2][3] === "—" && r.cur === null);
  r = await js(`(() => { const q = (s) => [...window.__box.querySelectorAll(s)]; q(".rob-seg button")[1].click();
    const P = window.BlaveReport._rob, want = P.f2(P.sanitizeScan(${JSON.stringify(SCAN)}, null, "").nbr[0][0]);
    return { lbl: window.__box.querySelector(".rob-heat-label").textContent, c00: q(".rob-tbl td")[0].textContent, want, pressed: q(".rob-seg button").map((b) => b.getAttribute("aria-pressed")).join(), glyph: !!q(".rob-tbl td")[0].querySelector(".rob-glyph") }; })()`);
  ok("② 切到鄰域平均:label 換、(0,0) 從 3.00 變成鄰域平均(" + r.want + ")、標記不動", r.lbl === (await tf("rob.heatNbr", { k: "3" })) && r.c00 === r.want && r.c00 !== "3.00" && r.pressed === "false,true" && r.glyph);
  r = await js(`(() => { const td = [...window.__box.querySelectorAll(".rob-tbl td")][8]; td.focus(); td.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    const tip = document.querySelector(".rob-tip"); const on = tip && tip.classList.contains("is-on") && tip.getAttribute("aria-hidden") === "false" && tip.textContent;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); return { on, off: !tip.classList.contains("is-on"), hover: !td.classList.contains("is-hover") }; })()`);
  ok("② 鍵盤 focus 到穩健格:body 層的 .tip 單例亮起、內容帶參數對與角色字;Esc 收", r.on && r.on.includes("A 30") && r.on.includes(await tf("rob.role.plateau")) && r.off && r.hover);
  r = await js(`(() => { const b = window.__box.querySelector(".rob-cmp-tbl th button.mp-tip"); b.focus(); b.dispatchEvent(new FocusEvent("focus"));
    const tip = document.querySelector(".rob-tip"); const on = tip.classList.contains("is-on") && tip.textContent; b.dispatchEvent(new FocusEvent("blur"));
    return { on, off: !tip.classList.contains("is-on"), inline: window.__box.querySelectorAll(".rob-cmp-tbl .tip").length, aria: b.getAttribute("aria-describedby") === tip.id }; })()`);
  ok("② 比較表欄頭「鄰域平均」的說明也走同一顆 body 層單例(表可橫捲不會裁到它);blur 收;沒有行內 .tip", r.on === (await tf("rob.cmp.nbrTip", { k: "3" })) && r.off && r.inline === 0 && r.aria);
  r = await js(`(() => { window.__box.style.width = "400px"; const cols = Array.from({ length: 12 }, (_, i) => Math.round(10 * (i + 1)) / 100); const row = cols.map((_, j) => (j === 11 ? 2.5 : 0.3));
    window.__render({ stats: ${JSON.stringify(STATS)}, scan: { row_param: "A", col_param: "B", row_vals: [1, 2], col_vals: cols, grid: [row, row.map((v) => v * 0.9)], window: 1 }, code: "A = 1\\nB = 1.2", name: "s1" }, false);
    const f = window.__box.querySelector(".rob-frame"); const td = window.__box.querySelector(".rob-tbl td.is-current"); const r = td.getBoundingClientRect(), fr = f.getBoundingClientRect();
    const out = { sl: f.scrollLeft, canScroll: f.scrollWidth > f.clientWidth, visible: r.right <= fr.right + 1 && r.left >= fr.left }; window.__box.style.width = ""; return out; })()`);
  ok("② 12 欄、400 寬:標記在最右欄 → frame 自己捲到看得見它(不縮格)", r.canScroll && r.sl > 0 && r.visible);
  r = await js(`(() => { window.__render({ stats: ${JSON.stringify(STATS)}, scan: ${JSON.stringify({ ...SCAN, current: { i: 0, j: 0 }, generated_at: 10 })}, code: "", name: "s1" }, false);
    return { tag: !!window.__box.querySelector(".rob-tag"), verdict: window.__box.querySelector(".rob-verdict").textContent, cur: !!window.__box.querySelector(".rob-tbl td.is-current") }; })()`);
  ok("② 過時(scan 早於回測、策略碼讀不到常數):沒有 tag、結論「回測已重跑」、沒有虛線格", !r.tag && r.verdict === (await tf("rob.verdict.stale")) && !r.cur);
  r = await js(`(() => { window.__render({ stats: ${JSON.stringify(STATS)}, scan: { row_param: "<img onerror=x>", col_param: "B", row_vals: [1], col_vals: [1], grid: [[1]] }, code: "", name: "s1" }, false);
    return { img: window.__box.querySelectorAll("img").length, txt: window.__box.querySelector(".rob-tbl th.corner").textContent }; })()`);
  ok("② 參數名是雲端 / agent 來的字串:只進 textContent,不變成元素", r.img === 0 && r.txt.includes("<img onerror=x>"));

  console.log(red ? `\n② ${red} 紅` : "\n② ALL PASS");
  app.exit(red ? 1 : 0);
});
