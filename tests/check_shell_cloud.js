// shell/cloud.js:讀雲端主機狀態(唯讀)。不打真的 api(post 是假的)。
// 跑法:node tests/check_shell_cloud.js
const fs = require("fs"), path = require("path");
const { createCloudHost, interpret, ENDPOINT, EVENTS_ENDPOINT, EVENTS_MIN_GAP_MS, MIN_GAP_MS, POLL_BACKGROUND_MS, POLL_FOREGROUND_MS, BACKOFF_MS } = require("../shell/cloud.js");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const body = (o = {}) => ({ machine: { state: "running", os_type: "linux", public_ip: "1.2.3.4" }, portfolio: { reported_at: 100, halt: { halted: false }, reconciler: { alive: true }, venues: {} },
  portfolio_reported_at: 100, portfolio_stale: false, server_time: 130, fx_rates: { USD: 1 }, currency: "USDT",
  strategies_summary: [{ name: "a", status: "ok" }, null, { nope: 1 }], config_version: "2026-09-21", latest_config_version: "2026-09-21-c", data_sources: ["polygon", 7], ...o });
(async () => {
  let r = interpret({ status: 200, body: body() });
  t("正常:OK、alive、壞的策略列被濾掉、資料來源只留字串", r.code === "OK" && r.alive === true && r.strategies.length === 1 && r.data_sources.join() === "polygon" && r.machine.public_ip === "1.2.3.4");
  t("停機主機的舊快取:不算 alive(不能畫成下單中),報告照留", (() => { const x = interpret({ status: 200, body: body({ machine: { state: "stopped", os_type: "linux", public_ip: "1.2.3.4" }, portfolio_stale: true }) }); return x.alive === false && x.stale === true && !!x.report; })());
  t("停機的主機不往上交 IP(沒有固定 IP,舊 IP 可能已屬於別人)", interpret({ status: 200, body: body({ machine: { state: "stopped", public_ip: "1.2.3.4" }, portfolio_stale: true }) }).machine.public_ip === null);
  t("portfolio_stale 缺席或不是 false → 一律當舊的", interpret({ status: 200, body: (() => { const b = body(); delete b.portfolio_stale; return b; })() }).alive === false && interpret({ status: 200, body: body({ portfolio_stale: "false" }) }).alive === false);
  t("運行中但沒有回報(portfolio null)→ 不 alive", interpret({ status: 200, body: body({ portfolio: null }) }).alive === false);
  t("沒有主機不是錯誤:OK + state none", (() => { const x = interpret({ status: 200, body: body({ machine: { state: "none", os_type: null, public_ip: null }, portfolio: null, portfolio_stale: true }) }); return x.code === "OK" && x.machine.state === "none" && !x.alive; })());
  t("不認得的 machine.state 當 none", interpret({ status: 200, body: body({ machine: { state: "weird" } }) }).machine.state === "none");
  t("401 兩種、429、5xx、連不上、形狀不對", interpret({ status: 401, body: { error_code: "INVALID_CREDENTIALS" } }).code === "REVOKED" && interpret({ status: 401, body: { error_code: "APP_SECRET_REQUIRED" } }).code === "NO_APP_SECRET"
    && interpret({ status: 429, body: {} }).code === "RATE_LIMITED" && interpret({ status: 502, body: "x" }).code === "OFFLINE" && interpret(null).code === "OFFLINE" && interpret({ status: 200, body: {} }).code === "BAD_RESPONSE");

  // 宿主(時鐘是假的:refresh 有最小間隔,每一步自己把時間往前推)
  const calls = []; let clock = 1e6, creds = { token: "acct-T", appSecret: "appsec-S" }, reply = { status: 200, body: body() }, changes = [];
  const tick = (ms) => { clock += ms === undefined ? MIN_GAP_MS : ms; };
  const mk = (post) => createCloudHost({ apiBase: "https://x", getCreds: () => creds, post, onChange: (s) => { changes.push(s); }, now: () => clock, setTimer: () => 0, clearTimer: () => {} });
  const host = mk(async (u, b) => { calls.push({ u, b }); if (reply instanceof Error) throw reply; return reply; });
  await host.refresh();
  t("請求:POST 到契約的路徑、兩顆憑證只在 body", calls.length === 1 && calls[0].u === "https://x" + ENDPOINT && JSON.stringify(Object.keys(calls[0].b).sort()) === '["app_secret","token"]');
  const st = host.status();
  t("status() 跟本機宿主同形狀({alive, running, report}),trade.js 直接吃;策略清單在 cloud.strategies", st.alive === true && st.running === true && st.report.reconciler.alive === true && "lastExit" in st && "restarts" in st && st.cloud.strategies.length === 1 && !("report" in st.cloud));
  t("憑證不出現在任何往上交的東西裡", !JSON.stringify(host.snapshot()).includes("acct-T") && !JSON.stringify(st).includes("appsec-S") && !JSON.stringify(changes).includes("acct-T") && !JSON.stringify(changes).includes("appsec-S"));
  tick(); await host.refresh(); t("狀態摘要沒變不重複通知", changes.length === 1);
  let n = calls.length; tick(MIN_GAP_MS - 1); await host.refresh(); await host.refresh();
  t("renderer 連打 refresh:最小間隔內不發請求(打不爆帳號的速率桶)", calls.length === n);
  tick(1); await host.refresh(); t("過了最小間隔才再打", calls.length === n + 1);
  tick(); reply = { status: 200, body: body({ portfolio: { halt: { halted: true }, reconciler: { alive: true } } }) }; await host.refresh();
  t("另一邊出事(HALT)→ 通知一次(切換器上的狀態靠它)", changes.length === 2);
  tick(); reply = new Error("offline"); await host.refresh();
  t("連不上:留著上一份畫面但標成不是現況,不清空", host.snapshot().code === "OK" && host.status().alive === false && host.snapshot().transient === "OFFLINE" && !!host.status().report);
  tick(); reply = { status: 200, body: body() }; await host.refresh(); tick(3 * POLL_BACKGROUND_MS + 1);
  t("睡眠醒來:太久沒成功同步就不算 alive,不管手上那份怎麼寫", host.snapshot().alive === true && host.status().alive === false && host.status().cloud.alive === false);
  creds = { token: "acct-T", appSecret: null }; n = calls.length; await host.refresh();
  t("沒有 app_secret(舊登入):不發請求,回 NO_APP_SECRET", calls.length === n && host.snapshot().code === "NO_APP_SECRET");
  tick(); creds = null; await host.refresh(); t("沒登入:不發請求,回 NO_LOGIN", calls.length === n && host.snapshot().code === "NO_LOGIN");
  tick(); creds = { token: "acct-T", appSecret: "appsec-S" }; reply = { status: 200, body: body() }; await host.refresh();
  const before = changes.length; host.reset();
  t("reset():登出後不留上一個人的部位,而且通知畫面清掉", host.status().report === null && host.snapshot().code === "NO_LOGIN" && changes.length === before + 1 && changes[changes.length - 1].code === "NO_LOGIN");
  tick(); n = calls.length; const p1 = host.refresh(), p2 = host.refresh(); await Promise.all([p1, p2]);
  t("同時兩個 refresh 只打一次", calls.length === n + 1);

  // 稽核 M1:登出的那一刻還在路上的回應,不可以把上一個人的部位寫回來
  { let release; const gate = new Promise((r) => { release = r; }); changes = []; creds = { token: "acct-A", appSecret: "sa" };
    const h = mk(async () => { await gate; return { status: 200, body: body() }; });
    const p = h.refresh(); await Promise.resolve(); creds = null; h.reset(); release(); await p;
    t("M1 在途登出:回應回來後整包丟,部位不寫回、也不推給畫面", h.snapshot().code === "NO_LOGIN" && h.status().report === null && changes.every((c) => c.code !== "OK")); }
  // 稽核 M2:換帳號(呼叫端沒叫 reset)+ 換完剛好連不上 → 不可以留著上一個人的畫面
  { let who = "A", down = false; changes = []; creds = { token: "acct-A", appSecret: "sa" };
    const h = mk(async (u, b) => { if (down) throw new Error("offline"); return { status: 200, body: body({ currency: b.token === "acct-A" ? "A-ONLY" : "B-ONLY" }) }; });
    await h.refresh(); tick(); creds = { token: "acct-B", appSecret: "sb" }; down = true; await h.refresh();
    t("M2 換帳號後離線:不留 A 的部位給 B 看", h.snapshot().code === "OFFLINE" && h.status().report === null && h.snapshot().currency !== "A-ONLY");
    t("M2 換帳號當下就通知畫面清掉(不等請求回來)", changes.some((c) => c.code === "NO_LOGIN"));
    tick(); down = false; await h.refresh(); t("M2 連上後拿到的是 B 的", h.snapshot().currency === "B-ONLY"); void who; }
  // 同一個人離線才留畫面
  { let down = false; creds = { token: "acct-A", appSecret: "sa" }; const h = mk(async () => { if (down) throw new Error("x"); return { status: 200, body: body() }; });
    await h.refresh(); tick(); down = true; await h.refresh(); t("同一顆 token 離線:畫面留著", h.snapshot().code === "OK" && h.snapshot().transient === "OFFLINE"); }
  // 稽核 N1:A 的輪詢在途 → B 登入完成(呼叫端只叫 refresh(true)、沒叫 reset)→ A 的回應不可落地,而且要馬上替 B 打一次
  { let release; const gate = new Promise((r) => { release = r; }); let first = true; changes = []; creds = { token: "acct-A", appSecret: "sa" };
    const h = mk(async (u, b) => { if (first) { first = false; await gate; } return { status: 200, body: body({ currency: b.token === "acct-A" ? "A-ONLY" : "B-ONLY" }) }; });
    const pa = h.refresh(); await Promise.resolve(); creds = { token: "acct-B", appSecret: "sb" }; const pb = h.refresh(true); release(); await pa; await pb;
    t("N1 在途換帳號:A 的回應不落地、不推給畫面", changes.every((c) => c.currency !== "A-ONLY"));
    t("N1 登入那次 refresh(true) 不被在途請求吞掉:回來時手上是 B 的", h.snapshot().currency === "B-ONLY"); }
  // 稽核 N2:輪詢在途時切前景,不可以多疊一條輪詢
  { let release; let gate = new Promise((r) => { release = r; }); const timers = []; creds = { token: "acct-A", appSecret: "sa" };
    const h = createCloudHost({ apiBase: "https://x", getCreds: () => creds, post: async () => { await gate; return { status: 200, body: body() }; }, now: () => clock,
      setTimer: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; }, clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].live = false; } });
    h.start(); await Promise.resolve(); tick();   /* 過了最小間隔:擋住重入的只剩「在途就不重入」那一條 */ h.setForeground(false); h.setForeground(true); h.setForeground(false); h.setForeground(true);
    release(); await new Promise((r) => setImmediate(r));
    t("N2 在途時切前景三次:一輪結束後只排了 1 個 timer", timers.filter((x) => x.live).length === 1 && timers.length === 1);
    h.setForeground(false); h.setForeground(true); await new Promise((r) => setImmediate(r));   // 離上次夠久:回前景真的重打一次
    const sent = timers.length; h.setForeground(false); h.setForeground(true); await new Promise((r) => setImmediate(r));
    t("N2 剛打過就切回前景:不重打(快速切視窗)", timers.filter((x) => x.live).length === 1 && timers.length === sent);
    h.stop(); t("stop() 之後沒有活著的 timer", timers.filter((x) => x.live).length === 0); }
  // 輪詢間隔四個數字釘住
  { const at = async (rep, fg) => { creds = { token: "acct-A", appSecret: "sa" }; const h = mk(async () => rep); await h.refresh(); h.setForeground(fg); return h._delay(); };
    t("間隔:前景 15 秒、背景 60 秒", await at({ status: 200, body: body() }, true) === POLL_FOREGROUND_MS && await at({ status: 200, body: body() }, false) === POLL_BACKGROUND_MS);
    t("間隔:429 退讓、401 不狂打、沒有主機走慢速", await at({ status: 429, body: {} }, true) === BACKOFF_MS && await at({ status: 401, body: {} }, true) === POLL_BACKGROUND_MS
      && await at({ status: 200, body: body({ machine: { state: "none" }, portfolio: null }) }, true) === POLL_BACKGROUND_MS); }
  t("IP 欄不是 IP 長相的不往上交", interpret({ status: 200, body: body({ machine: { state: "running", public_ip: "<img src=x>" } }) }).machine.public_ip === null && interpret({ status: 200, body: body({ machine: { state: "running", public_ip: "2001:db8::1" } }) }).machine.public_ip === "2001:db8::1");
  { creds = { token: "acct-A", appSecret: "sa" }; let c = 0; const h = mk(async () => { c++; return { status: 200, body: body() }; });
    t("懶啟動:建立宿主不發請求,start() 才開始,第二次 start() 不重複", c === 0 && h.isRunning() === false && h.start() === true && h.start() === false); await h.refresh(); h.stop(); t("start() 後只打了一次", c === 1); }

  const src = fs.readFileSync(path.join(__dirname, "..", "shell", "cloud.js"), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  t("這個檔不寫檔、不 log、不 require electron / fs(回應不落地:agent 讀得到 workspace)", !/require\(/.test(src) && !/console\.|writeFile|appendFile/.test(src));
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
  // 列舉:main.js 裡每一支 cloud-* IPC 都要先過 fromOurPage(新增一支忘了加就紅)
  // (handle() 這個包裝自己就先過 fromOurPage;直接用 ipcMain.handle 的要自己寫那一行)
  const cloudIpc = mainSrc.match(/(ipcMain\.)?handle\("cloud-[a-z-]+",[^\n]*/g) || [];
  t("main.js:每一支 cloud IPC 都只收自家頁面(回的是部位與權益)", cloudIpc.length >= 3
    && cloudIpc.every((l) => (l.startsWith("ipcMain.") ? /\(e\) => \{ if \(!fromOurPage\(e\)\) return null;/.test(l) : /^handle\("/.test(l))));
  t("main.js:雲端狀態只推給自家頁面的視窗", /isOurPageUrl\(w\.webContents\.getURL\(\)\)\) w\.webContents\.send\("cloud-state"/.test(mainSrc));
  t("main.js:不在啟動時就開始輪詢(懶啟動)", !/^\s*cloudHost\(\)\.start\(\);/m.test(mainSrc));
  // 列舉:app_secret 讀出來的地方就這幾個(多一個就要有人看過它交給了誰)
  // 第 4 個 = mcpCode() 的 getCreds(換 `blave` MCP 的接入碼;只交給 mcpcode.js 去打 api,不進 agent、不進 renderer——tests/check_shell_mcp_code.js)
  t("main.js:loadAppSecret( 的出現次數沒有變多", (mainSrc.match(/loadAppSecret\(/g) || []).length === 4
    && /createMcpCode\(\{ apiBase: API_BASE, post: \(u, b\) => postJSON\(u, b\),\s*getCreds: \(\) => \{ const token = loadToken\(\); return token \? \{ token, appSecret: loadAppSecret\(\) \} : null; \} \}\);/.test(mainSrc));
  t("main.js:登出時清掉雲端宿主手上的東西", /if \(_cloud\) _cloud\.reset\(\);/.test(mainSrc));
  t("main.js:app_secret 只交給 cloudHost 與 planStart,不出現在任何 webContents.send / env 裡", !/webContents\.send\([^)]*appSecret/.test(mainSrc) && !/env:[^}]*loadAppSecret/.test(mainSrc));

  /* ── 事件清單(點擊驅動的第二支端點)────────────────────────────── */
  const evBody = (o = {}) => ({ machine_state: "running", server_time: 130, events: [
    { ts: 120, type: "desktop_action", data: { action: "halt", device: "Wei 的 MacBook" } },
    { ts: 110, type: "halt", data: { source: "reconciler", reason: "MARKER-REASON" } },
    { ts: "x", type: "halt", data: {} }, { ts: 100, type: 7 }, null, "nope",
    { ts: 90, type: "resume" },
  ], ...o });
  { const evCalls = []; let evCreds = { token: "acct-E", appSecret: "appsec-E" }, evReply = { status: 200, body: evBody() };
    const h = createCloudHost({ apiBase: "https://x", getCreds: () => evCreds, post: async (u, b) => { evCalls.push({ u, b }); if (evReply instanceof Error) throw evReply; return evReply; },
      now: () => clock, setTimer: () => 0, clearTimer: () => {} });
    // 事件那一支有自己的最小間隔(它不共用狀態輪詢那組):每次問之前先把假時鐘推過那個間隔
    const ask = (d) => { tick(EVENTS_MIN_GAP_MS); return h.events(d); };
    const res0 = await h.events(30), out = res0.events;
    t("事件:POST 到契約的路徑,body 只有兩顆憑證 + days", evCalls.length === 1 && evCalls[0].u === "https://x" + EVENTS_ENDPOINT
      && JSON.stringify(Object.keys(evCalls[0].b).sort()) === '["app_secret","days","token"]' && evCalls[0].b.days === 30);
    // ts 的單位是**秒**(api 的 agent_overview._epoch;畫面 ev.ts * 1000):這裡原樣往上交,不縮放
    t("事件:讀到了就是 OK;壞的列濾掉,欄位整成 { ts, type, data },ts 原樣是秒", res0.code === "OK" && out.length === 3 && out[0].ts === 120 && out[0].type === "desktop_action" && out[0].data.action === "halt" && out[2].type === "resume" && JSON.stringify(out[2].data) === "{}");
    // 「真的沒有事件」是 OK + 空陣列,跟「讀不到」不是同一件事(畫面各講各的話)
    { evReply = { status: 200, body: evBody({ events: [] }) }; const r = await ask(30);
      t("事件:真的沒有事件 = OK + 空陣列(不是讀不到)", r.code === "OK" && r.events.length === 0); evReply = { status: 200, body: evBody() }; }
    t("事件:days 夾在 1–90(下界也夾:0<days<1 不可以送 0),沒給走預設 30", await ask(999).then(() => evCalls[evCalls.length - 1].b.days) === 90
      && await ask(0).then(() => evCalls[evCalls.length - 1].b.days) === 30 && await ask(1.9).then(() => evCalls[evCalls.length - 1].b.days) === 1
      && await ask(0.5).then(() => evCalls[evCalls.length - 1].b.days) === 1);
    // 不落地:主行程手上那一份(snapshot / status)不可以留著事件的任何字
    t("事件:回應不進主行程手上那一份(snapshot / status 都沒有它的字)", !JSON.stringify(h.snapshot()).includes("MARKER-REASON") && !JSON.stringify(h.status()).includes("MARKER-REASON"));
    t("事件:憑證不出現在回上去的東西裡", !JSON.stringify(res0).includes("acct-E") && !JSON.stringify(res0).includes("appsec-E"));
    // 七種壞回應各自釘成「讀不到」——不是「這段期間沒有事件」(畫面會照 code 說自己讀不到)
    for (const bad of [{ status: 401, body: {} }, { status: 429, body: {} }, { status: 500, body: {} }, { status: 200, body: {} }, { status: 200, body: { events: "nope" } }, { status: 200, body: null }, new Error("offline")]) {
      evReply = bad; const r = await ask(30);
      t("事件:讀不到 → UNREACH(不是空清單),不拋(" + (bad instanceof Error ? "連不上" : bad.status + "/" + JSON.stringify(bad.body)) + ")", r.code === "UNREACH" && Array.isArray(r.events) && r.events.length === 0);
    }
    evReply = { status: 200, body: evBody() };
    let n = evCalls.length; evCreds = { token: "acct-E", appSecret: null };
    t("事件:沒有 app_secret / 沒登入:不發請求,也算讀不到", (await ask(30)).code === "UNREACH" && (evCreds = null, (await ask(30)).code === "UNREACH") && evCalls.length === n);
    /* 自己的最小間隔:renderer 寫壞的迴圈不可以把 detail 桶打到 429(429 會讓畫面長期停在「讀不到」)。
       擋下來的那一次回 UNREACH——這一輪確實沒讀到,但不是「沒有事件」。 */
    { evCreds = { token: "acct-E", appSecret: "appsec-E" }; evReply = { status: 200, body: evBody() };
      tick(EVENTS_MIN_GAP_MS); await h.events(30); const m = evCalls.length;
      tick(EVENTS_MIN_GAP_MS - 1); const spam = [await h.events(30), await h.events(30), await h.events(30)];
      t("事件:最小間隔內連打不發請求,而且回 UNREACH(不是空清單)", evCalls.length === m && spam.every((r) => r.code === "UNREACH" && r.events.length === 0));
      tick(1); t("事件:過了最小間隔才再打", (await h.events(30)).code === "OK" && evCalls.length === m + 1); }
    // 在途時共用同一個請求(兩處同時重畫只打一次)
    { evCreds = { token: "acct-A", appSecret: "sa" }; let release; const gate = new Promise((r) => { release = r; }); let c2 = 0;
      const h4 = createCloudHost({ apiBase: "https://x", getCreds: () => evCreds, post: async () => { c2++; await gate; return { status: 200, body: evBody() }; }, now: () => clock, setTimer: () => 0, clearTimer: () => {} });
      const a = h4.events(30), b2 = h4.events(30); release(); const [ra, rb] = [await a, await b2];
      t("事件:在途時共用同一個請求(只打一次,兩邊拿到同一份)", c2 === 1 && ra === rb && ra.code === "OK");
      tick(EVENTS_MIN_GAP_MS); t("事件:在途那一份結束後,下一次問得動(inflight 有清掉)", (await h4.events(30)).code === "OK" && c2 === 2); }
    // 在途換人:這一份是上一個人的,整包丟
    { evCreds = { token: "acct-A", appSecret: "sa" }; let release; const gate = new Promise((r) => { release = r; });
      const h2 = createCloudHost({ apiBase: "https://x", getCreds: () => evCreds, post: async () => { await gate; return { status: 200, body: evBody() }; }, now: () => clock, setTimer: () => 0, clearTimer: () => {} });
      const p = h2.events(30); await Promise.resolve(); evCreds = null; release();
      t("事件:請求在路上時登出 / 換帳號 → 這份不交給畫面(算讀不到)", (await p).code === "UNREACH" && (await p).events.length === 0); }
    // gen 不可以被事件那一支動到:動了的話在途的狀態輪詢回來會把自己丟掉(畫面永遠停在上一份)
    { evCreds = { token: "acct-A", appSecret: "sa" }; let release; const gate = new Promise((r) => { release = r; });
      const h3 = createCloudHost({ apiBase: "https://x", getCreds: () => evCreds,
        post: async (u) => { if (u.endsWith(ENDPOINT)) { await gate; return { status: 200, body: body({ currency: "LANDED" }) }; } return { status: 200, body: evBody() }; },
        now: () => clock, setTimer: () => 0, clearTimer: () => {} });
      const pr = h3.refresh(); await Promise.resolve(); await h3.events(30); release(); await pr;
      t("事件:讀事件不動世代——在途的狀態輪詢照樣落地", h3.snapshot().currency === "LANDED"); } }

  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
