// 搜尋等用戶過機器人驗證:引擎那一端不能先把呼叫切掉,呼叫結束之後畫面不能還停在「等你操作」(e2e 0.1.8 #197 #198,稽核 P2-7 P2-13)。
//   ① 設定檔(不開視窗):`blave_browser` 那一格帶 `timeout`,跟 Codex 那條同一個數,而且高於外殼自己的上限;`blave` 那一格不帶
//   ② mcp.js(真 HTTP):超過上限的工具由外殼回一個講得出原因的結果;呼叫的那一端斷線,實作看得到(connected() = false)
//   ③ 真 Electron(隱藏視窗)+ 假驗證頁的開關:等超過 60 秒之後才過假頁,同一次搜尋照樣接得上;呼叫的那一端不等了 / 回合結束,
//      「等你操作」「你在操作」都收掉;並行的 browser_wait until=user_done 不吃掉驗證頁的按鈕結果
// 絕不連真的搜尋引擎:假頁與搜尋結果都由測試行程自己的本機代理供應,https 一律被它記下並拒絕。③ 裡扮演用戶的是測試(把分頁導回搜尋頁),
// 外殼與 agent 的工具都沒有碰那一頁。
// 跑法:node tests/check_shell_search_verify_wait.js(③ 要 BLAVE_TEST_WINDOW=1,約 70 秒)
const path = require("path"), fs = require("fs"), os = require("os"), http = require("http");
const SHELL = path.join(__dirname, "..", "shell");
const GATE = require("./_electron_gate");
const VF = require(path.join(SHELL, "browser", "verify.js"));
const DV = require(path.join(SHELL, "browser", "devverify.js"));
let red = 0, last = null; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok ? "" : "  " + JSON.stringify(d === undefined ? last : d).slice(0, 600))); if (!ok) red++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ENGINE_CUT_MS = 60000;   // Claude Code 沒設 timeout 時切掉 HTTP MCP 呼叫的時間(CLI 2.1.239 vMf)

async function pure() {
  // ---- ① 設定檔
  const M = require(path.join(SHELL, "mcpcode.js"));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "blave-svw-"));
  const f = M.writeConfig(path.join(base, "mcp"), { accessCode: "blv_" + "a".repeat(24), url: "https://mcp.blave.org/mcp" }, { url: "http://127.0.0.1:1/mcp", token: "tok" });
  const cfg = JSON.parse(fs.readFileSync(f, "utf8")).mcpServers;
  fs.rmSync(base, { recursive: true, force: true });
  t("設定檔:blave_browser 那一格帶 timeout(毫秒、整數);blave 那一格不帶(照 CLI 的預設)",
    cfg.blave_browser.timeout === M.BROWSER_TOOL_TIMEOUT_MS && Number.isInteger(cfg.blave_browser.timeout) && !("timeout" in cfg.blave), cfg);
  const codex = fs.readFileSync(path.join(__dirname, "..", "runtime", "codex_engine.py"), "utf8");
  const sec = Number((/mcp_servers\.blave_browser\.tool_timeout_sec=(\d+)/.exec(codex) || [])[1]);
  t("兩條引擎同一個數:Claude 的 timeout = Codex 的 tool_timeout_sec", M.BROWSER_TOOL_TIMEOUT_MS === sec * 1000, [M.BROWSER_TOOL_TIMEOUT_MS, sec]);
  const src = fs.readFileSync(path.join(SHELL, "browser", "index.js"), "utf8");
  const m = /const SEARCH_TAIL_MS = (\d+), SEARCH_HARD_MAX_MS = VF\.SEARCH_CALL_MAX_MS \+ (\d+);/.exec(src) || [];
  const tail = Number(m[1]), hard = VF.SEARCH_CALL_MAX_MS + Number(m[2]);
  t("用戶有規格寫的那麼久:沒人理 120 秒、動手後再 120 秒,都在引擎原本切掉的 60 秒之後、在呼叫期限之內",
    VF.VERIFY_WAIT_MS === 120000 && VF.VERIFY_TOUCHED_MS === 120000 && VF.VERIFY_WAIT_MS > ENGINE_CUT_MS && VF.VERIFY_WAIT_MS + VF.VERIFY_TOUCHED_MS <= VF.SEARCH_CALL_MAX_MS);
  t("單次搜尋的上限一層包一層:等驗證的期限 < 不再開新一輪 < 外殼硬上限 < 引擎端的逾時(留 4 分鐘以上)",
    tail > 0 && VF.SEARCH_CALL_MAX_MS + tail < hard && hard + 240000 <= M.BROWSER_TOOL_TIMEOUT_MS, [tail, hard]);
  t("接線:搜尋的硬上限交給 mcp.js;過了期限不再開新的一輪;呼叫的那一端不等了就停",
    src.includes('maxMs: (name) => (name === "browser_search" ? SEARCH_HARD_MAX_MS : 0)') && src.includes("if (Date.now() > deadline + SEARCH_TAIL_MS)")
    && src.includes('if (name === "browser_search") return doSearch(args, ctx);') && /alive: \(\) => cur === c && here\(\) &&/.test(src));

  // ---- ② mcp.js
  const { createMcpServer, CALL_MAX_MS } = require(path.join(SHELL, "browser", "mcp.js"));
  t("其他工具的上限不跟著引擎端放寬:一支最久 90 秒", CALL_MAX_MS === 90000 && CALL_MAX_MS < VF.SEARCH_CALL_MAX_MS);
  const seen = {};
  const srv = createMcpServer({ version: "test", tools: [{ name: "slow" }, { name: "stuck" }, { name: "quick" }], maxMs: (n) => (n === "stuck" ? 300 : 0),
    call: async (name, _a, ctx) => {
      seen[name] = { at0: ctx.connected() };
      if (name !== "quick") { await sleep(name === "stuck" ? 700 : 600); seen[name].after = ctx.connected(); seen[name].done = true; }
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, name }) }], isError: false };
    } });
  const port = await srv.start(), tok = srv.beginTurn(1);
  const post = (name, abortAfter) => new Promise((resolve) => {
    const data = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok, "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => resolve(JSON.parse(s)));
    });
    req.on("error", () => resolve(null));
    req.end(data);
    if (abortAfter) setTimeout(() => req.destroy(), abortAfter);
  });
  let r = await post("quick");
  t("正常的呼叫:結果照回,實作看到的是「那一端還在等」", !!r && r.result.isError === false && seen.quick.at0 === true, r);
  const t0 = Date.now(); r = await post("stuck");
  const body = r && JSON.parse(r.result.content[0].text);
  t("超過上限的工具:外殼到時間就回,結果講得出原因(不是引擎切出來的無名失敗)", !!body && r.result.isError === true && body.ok === false && body.error === "timeout" && /stuck/.test(body.message) && Date.now() - t0 < 650, [body, Date.now() - t0]);
  await sleep(500);
  t("被外殼收掉的那一支:實作看得到沒有人在等了", seen.stuck.done === true && seen.stuck.at0 === true && seen.stuck.after === false, seen.stuck);
  r = await post("slow", 150);
  await sleep(600);
  t("呼叫的那一端先斷線(引擎自己逾時、回合被中斷):實作看得到 connected() = false", r === null && seen.slow.done === true && seen.slow.at0 === true && seen.slow.after === false, seen.slow);
  srv.close();
}

if (!process.versions.electron) {
  pure().then(() => {
    const bin = GATE.bin(SHELL, "③");
    if (!bin) { console.log(red ? `\n${red} FAILED` : "\nALL PASS"); process.exit(red ? 1 : 0); }
    const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
    const code = (r.status == null ? 1 : r.status) || (red ? 1 : 0);
    console.log(code ? "\nFAILED" : "\nALL PASS"); process.exit(code);
  }).catch((e) => { console.log("FAIL  " + (e && e.stack)); process.exit(1); });
} else {
  const electron = require("electron");
  const { app, BrowserWindow, session } = electron;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-svw-"));
  app.setPath("userData", tmp);
  const J = (r) => (last = JSON.parse(r.content[0].text));
  const until = async (fn, ms) => { const end = Date.now() + (ms || 8000); while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); } return null; };
  const RESULTS = (q) => `<!doctype html><html><head><title>${q} - results</title></head><body><div id="rso">
<div><a href="http://news-a.test/one"><h3>First result for ${q}</h3></a><div>snippet one about it, long enough to count as a snippet text here</div></div>
<div><a href="http://news-b.test/two"><h3>Second result</h3></a><div>snippet two about it, long enough to count as a snippet text here</div></div></div></body></html>`;
  const DDG = (q) => `<!doctype html><html><head><title>${q} at ddg</title></head><body><div class="result"><a class="result__a" href="http://news-c.test/three">Third result</a><a class="result__snippet">snip</a></div></body></html>`;
  const hits = [];
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1200, height: 800, show: false });
    await win.loadURL("data:text/html,<p>host</p>");
    const page = fs.readFileSync(DV.PAGE);
    // 本機替身:假頁(開發版帶的那一頁原檔)、假頁過了之後的搜尋結果、退路的搜尋結果。其他一律是一頁普通文字;https 記下並拒絕
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, "http://" + req.headers.host); hits.push(req.method + " " + u.host + u.pathname);
      const html = (b) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(b); };
      if (u.host === DV.FAKE_HOST && u.pathname === "/sorry/fake") return html(page);
      if (u.host === DV.FAKE_HOST && u.pathname === "/search") return html(RESULTS(u.searchParams.get("q")));
      if (u.host === "d.test") return html(DDG(u.searchParams.get("q")));
      return html("<title>page</title><p>" + "text ".repeat(80) + "</p>");
    });
    srv.on("connect", (req, sock) => { hits.push("CONNECT " + req.url); sock.destroy(); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const ses = session.fromPartition("persist:agent-browser");
    await ses.setProxy({ proxyRules: "http=127.0.0.1:" + srv.address().port + ";https=127.0.0.1:" + srv.address().port, proxyBypassRules: "<-loopback>" });
    const sent = [];
    const realSend = win.webContents.send.bind(win.webContents);
    win.webContents.send = (ch, ev) => { if (ch === "browser-event") sent.push(ev); return realSend(ch, ev); };
    // 假頁的開關給的判別表(Google 那一列多認假頁的網域、每一輪第一次搜尋去假頁);退路換成本機的,Google 沒 arm 的搜尋也留在本機
    const fake = DV.create({ env: { BLAVE_DEV_FAKE_VERIFY: "1" }, isPackaged: false });
    const gUrl = fake.engines.google.url;
    const engines = {
      google: Object.assign({}, fake.engines.google, { url: (q, hl, n) => { const u = gUrl(q, hl, n); return u.includes(DV.FAKE_HOST) ? u : "http://" + DV.FAKE_HOST + "/search?q=" + encodeURIComponent(q); } }),
      ddg: { name: "DuckDuckGo", host: /^d\.test$/, search: /^\//, url: (q) => "http://d.test/html/?q=" + encodeURIComponent(q), verify: VF.ENGINES.ddg.verify },
    };
    const B = require(path.join(SHELL, "browser")).createBrowser({ electron, stateDir: path.join(tmp, "snaps"), reportsDir: path.join(tmp, "reports"), getWin: () => win, uiLang: () => "zh", track: () => {}, version: "test",
      reducedMotion: () => true, engines, userPresent: () => true, notify: () => {} });
    const call = (n, a, ctx) => B._call(n, a || {}, ctx || { live: () => true, connected: () => true });
    const pageOf = (id) => electron.webContents.getAllWebContents().find((w) => w.session === ses && w.getURL().includes(DV.FAKE_HOST + "/sorry/fake") && w.getURL().includes(id));
    const needOf = () => sent.find((e) => e.type === "need_user" && e.kind === "captcha");

    // ── 場景 A:等超過 60 秒才過假頁 → 同一次搜尋自動回結果
    fake.arm();
    await B.beginTurn(win, "desktop-svw1");
    const t0 = Date.now();
    let settled = null;
    const pending = call("browser_search", { query: "cpi-a", count: 3 }).then(J).then((r) => (settled = r));
    const need = await until(needOf, 15000);
    t("A 第一次搜尋落在假頁 → 發 need_user(captcha)", !!need && need.summary === "Google", sent.map((e) => e.type));
    const tab = B._tabs.get(need.id), wc = pageOf("cpi-a");
    t("A 分頁停在開發版帶的那一頁假驗證頁", !!wc && wc.getTitle() === "測試用的假驗證頁", wc && wc.getURL());
    await sleep(Math.max(0, 40000 - (Date.now() - t0)));
    B.takeover(tab.id);   // 用戶第 40 秒才動手
    await sleep(Math.max(0, ENGINE_CUT_MS + 3000 - (Date.now() - t0)));
    t("A 過了 60 秒:這次搜尋還在等用戶,那一格還是「要你操作」(沒有被切掉、沒有先回)", settled === null && !!tab.need && tab.need.kind === "captcha" && tab.verify === "google" && Date.now() - t0 > ENGINE_CUT_MS, [settled, tab.need]);
    await wc.loadURL("http://" + DV.FAKE_HOST + "/search?q=cpi-a");   // 測試扮演用戶:過了假頁,分頁到了搜尋結果(本機替身)
    const res = await Promise.race([pending, sleep(15000).then(() => null)]);
    t("A 第 60 秒之後才過 → 同一次呼叫自動回結果,用戶不用再做任何事", !!res && res.ok === true && res.source === "google" && res.untrusted_content.results.length === 2 && res.untrusted_content.results[0].url === "http://news-a.test/one", res);
    t("A 過了之後畫面收乾淨:need_clear、自動交還,那一格不再是驗證中 / 用戶接手", sent.some((e) => e.type === "need_clear" && e.id === tab.id) && sent.some((e) => e.type === "handback" && e.id === tab.id && e.auto === true) && !tab.verify && !tab.userControl && !tab.need);
    console.log("      (A 等了 " + (Date.now() - t0) + " ms)");
    B.endTurn();

    // ── 場景 B:呼叫的那一端不等了(引擎逾時、回合被中斷)→ 搜尋收掉,「等你操作」跟著收
    sent.length = 0; fake.arm();
    await B.beginTurn(win, "desktop-svw2");
    let connected = true, settledB = null;
    const pB = call("browser_search", { query: "cpi-b" }, { live: () => true, connected: () => connected }).then(J).then((r) => (settledB = r));
    const needB = await until(needOf, 15000);
    const tabB = needB && B._tabs.get(needB.id);
    B.takeover(tabB.id);
    t("B 等驗證中,用戶已經接手", !!tabB && !!tabB.need && tabB.userControl === true && settledB === null);
    connected = false;
    await Promise.race([pB, sleep(3000)]);
    t("B 那一端不等了 → 這次搜尋馬上結束,不再往退路搜", !!settledB && settledB.ok === false && settledB.error === "cancelled" && !hits.some((h) => h.startsWith("GET d.test")), [settledB, hits]);
    t("B 「等你操作」收掉:發了 need_clear,那一格沒有 need;它仍然是驗證頁(agent 的工具碰不到)", sent.some((e) => e.type === "need_clear" && e.id === tabB.id) && !tabB.need
      && J(await call("browser_read", { tab: tabB.alias })).error === "needs_user_verification");
    B.endTurn();

    // ── 場景 C:用戶接手之後回合結束 → 「你在操作／交還 agent」收掉
    sent.length = 0; fake.arm();
    await B.beginTurn(win, "desktop-svw3");
    const pC = call("browser_search", { query: "cpi-c" }).then(J);
    const needC = await until(needOf, 15000);
    const tabC = needC && B._tabs.get(needC.id);
    B.takeover(tabC.id);
    t("C 用戶接手中", !!tabC && tabC.userControl === true && sent.some((e) => e.type === "user_takeover" && e.id === tabC.id));
    B.endTurn();
    const rC = await Promise.race([pC, sleep(3000).then(() => null)]);
    t("C 回合結束 → 這次搜尋收掉", !!rC && rC.ok === false, rC);
    t("C 回合結束 → 那一格不再是「你在操作」、沒有 need:發了 handback(auto) 與 need_clear;頁面留著", tabC.userControl === false && !tabC.need && tabC.status !== "closed"
      && sent.some((e) => e.type === "handback" && e.id === tabC.id && e.auto === true) && sent.some((e) => e.type === "need_clear" && e.id === tabC.id), sent.map((e) => e.type));

    // ── 場景 D:並行的 browser_wait until=user_done 不吃掉驗證頁的按鈕結果(稽核 P2-7)
    sent.length = 0; fake.arm();
    await B.beginTurn(win, "desktop-svw4");
    const pD = call("browser_search", { query: "cpi-d" }).then(J);
    const needD = await until(needOf, 15000);
    const tabD = needD && B._tabs.get(needD.id);
    let r = J(await call("browser_wait", { until: "user_done", timeout_s: 1 }));
    t("D 只有驗證頁在等的時候 browser_wait until=user_done → 照其他工具的說法拒絕,不讀也不清那一格", r.ok === false && r.error === "needs_user_verification" && !!tabD.need && !tabD.userDone, r);
    const other = J(await call("browser_open", { url: "http://news-a.test/one" }));
    B.userDone(tabD.id, "ddg");   // 用戶按了「改用 DuckDuckGo」;同一刻 agent 並行等所有分頁
    r = J(await call("browser_wait", { until: "user_done", timeout_s: 1 }));
    t("D 並行的 browser_wait 只回別的分頁,驗證頁那一格不在清單裡", r.ok === true && r.tabs.length === 1 && r.tabs[0].tab === other.tab, r);
    const rD = await Promise.race([pD, sleep(15000).then(() => null)]);
    t("D 按鈕結果沒有被吃掉:搜尋馬上退到 DuckDuckGo 拿到結果(不是空等到逾時)", !!rD && rD.ok === true && rD.source === "ddg" && rD.fallback_reason === "captcha", rD);
    B.endTurn();

    t("全程沒有連到任何真的搜尋引擎(https 一律經 CONNECT,被本機代理記下並拒絕)", !hits.some((h) => h.startsWith("CONNECT")) && !hits.some((h) => /google|duckduckgo/.test(h)), hits.filter((h) => h.startsWith("CONNECT")));
    srv.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* userData 還鎖著 */ }
    console.log(red ? `\n${red} FAILED` : "\nALL PASS(③)");
    app.exit(red ? 1 : 0);
  }).catch((e) => { console.log("FAIL  " + (e && e.stack) + "\n      last: " + JSON.stringify(last).slice(0, 500)); app.exit(1); });
}
