// shell/cloud.js:讀雲端主機狀態(唯讀)。不打真的 api(post 是假的)。
// 跑法:node tests/check_shell_cloud.js
const fs = require("fs"), path = require("path");
const { createCloudHost, interpret, interpretStrategy, interpretOverview, interpretPerformance, ENDPOINT, EVENTS_ENDPOINT, STRATEGY_ENDPOINT, OVERVIEW_ENDPOINT, PERFORMANCE_ENDPOINT, EVENTS_MIN_GAP_MS, MIN_GAP_MS, POLL_BACKGROUND_MS, POLL_FOREGROUND_MS, BACKOFF_MS } = require("../shell/cloud.js");
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
  // S4 §1.1 ②:清單缺席 ≠ 空清單(把缺席當空的,存金額會把整個組合移出)
  t("strategies_summary 缺席 → strategies_ok false;空陣列 → true", (() => { const b = body(); delete b.strategies_summary;
    return interpret({ status: 200, body: b }).strategies_ok === false && interpret({ status: 200, body: body({ strategies_summary: [] }) }).strategies_ok === true
      && interpret({ status: 200, body: body({ strategies_summary: "x" }) }).strategies_ok === false; })());
  t("M1(Wei 拍板):只擋 summary null;partial true 照樣放行(雲端不從缺席推論移出),並把 partial 往上交給表下那句",
    interpret({ status: 200, body: body({ strategies_summary: null, strategies_partial: false }) }).strategies_ok === false
    && interpret({ status: 200, body: body({ strategies_partial: true }) }).strategies_ok === true
    && interpret({ status: 200, body: body({ strategies_partial: true }) }).strategies_partial === true
    && interpret({ status: 200, body: body({ strategies_partial: null }) }).strategies_partial === false
    && interpret({ status: 200, body: body({ strategies_partial: false }) }).strategies_ok === true
    && interpret({ status: 200, body: body() }).strategies_ok === true);
  t("雲端「從 app 按更新」的讀數(turn_active / update)不再往上交:這個 app 不送 update(用本機 app 不觸發雲端 agent 回合)",
    !("update" in interpret({ status: 200, body: body({ update: { state: "done", result: "updated" } }) })) && !("turn_active" in interpret({ status: 200, body: body({ turn_active: true }) })));

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
  // 第 5 個 = cloudCmd() 的 getCreds(對雲端主機下指令;同樣只交給 cloudcmd.js 去打 api——tests/check_shell_cloud_cmd.js)
  t("main.js:loadAppSecret( 的出現次數沒有變多(第六處 = 策略庫購買 libraryPurchase,同 planStart 那一級)", (mainSrc.match(/loadAppSecret\(/g) || []).length === 6
    && /createMcpCode\(\{ apiBase: API_BASE, post: \(u, b\) => postJSON\(u, b\),\s*getCreds: \(\) => \{ const token = loadToken\(\); return token \? \{ token, appSecret: loadAppSecret\(\) \} : null; \} \}\);/.test(mainSrc));
  t("main.js:登出時清掉雲端宿主手上的東西(讀、寫兩支都要:在途的指令回來時是上一個人的)",
    /if \(_cloud\) _cloud\.reset\(\);/.test(mainSrc) && /if \(_cloudCmd\) _cloudCmd\.reset\(\);/.test(mainSrc));
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

  /* ── 單支策略的報告(第三支點擊驅動的端點:雲端視角側欄點一支 → 中欄畫報告)────────────
     同事件清單:不留在主行程、不落地、不動世代;OK + null = 雲端現在沒有這一份(不是錯誤);其餘壞回應一律 UNREACH。
     物件是雲端那台機器上的策略碼寫得進去的東西:逐欄驗型別、只留報告要畫的那幾欄(形狀對齊主行程 loadStrategy)。 */
  const stBody = (o = {}) => ({ machine_state: "running", server_time: 130, strategy: { name: "momo", display_name: "Momentum", description: "MARKER-DESC", status: "draft", code: "MODE = 'backtest'", backtest: { "Sharpe Ratio": 1.2, candles: [[1, 2, 3, 4, 5, 6]] }, images: [{ hash: "x" }] }, ...o });
  { const r = interpretStrategy({ status: 200, body: stBody() }, "momo");
    t("策略:OK,只留 name / displayName / description / stats(= 整份 backtest)/ scan / code;images 與 status 不往上交", r.code === "OK" && JSON.stringify(Object.keys(r.strategy)) === '["name","displayName","description","stats","scan","code"]'
      && r.strategy.displayName === "Momentum" && r.strategy.stats["Sharpe Ratio"] === 1.2 && r.strategy.stats.candles.length === 1 && r.strategy.code === "MODE = 'backtest'");
    t("策略:scan(參數掃描)是物件才原樣往上交,缺 / 陣列 / 字串 → null(逐欄檢查在 report-robust.js 的 sanitizeScan)", r.strategy.scan === null
      && interpretStrategy({ status: 200, body: stBody({ strategy: { name: "momo", scan: { row_param: "A", grid: [[1]] } } }) }, "momo").strategy.scan.row_param === "A"
      && interpretStrategy({ status: 200, body: stBody({ strategy: { name: "momo", scan: [1] } }) }, "momo").strategy.scan === null
      && interpretStrategy({ status: 200, body: stBody({ strategy: { name: "momo", scan: "x" } }) }, "momo").strategy.scan === null);
    t("策略:雲端沒有這一份 = OK + null(api 的契約:沒這個名字 / 被逐出 / 沒主機都是 200 + null)", JSON.stringify(interpretStrategy({ status: 200, body: stBody({ strategy: null }) }, "momo")) === '{"code":"OK","strategy":null}');
    const bad = (s) => interpretStrategy({ status: 200, body: stBody({ strategy: s }) }, "momo");
    t("策略:display_name / description / code 不是字串 → 退回 name / 空字串;backtest 不是物件 → stats null(還沒回測過:只有程式碼可看)",
      bad({ name: "momo", display_name: 7, description: null, code: ["x"], backtest: "nope" }).strategy.displayName === "momo" && bad({ name: "momo", backtest: [1] }).strategy.stats === null && bad({ name: "momo" }).strategy.code === "" && bad({ name: "momo", display_name: "" }).strategy.displayName === "momo");
    t("策略:物件的 name 對不上要的名字(key 是截短雜湊,撞到就是別支)→ 讀不到,不畫成那支", bad({ name: "other", code: "x" }).code === "UNREACH" && bad("momo").code === "UNREACH" && bad(7).code === "UNREACH");
    for (const b of [{ status: 401, body: {} }, { status: 429, body: {} }, { status: 500, body: {} }, { status: 200, body: {} }, { status: 200, body: null }, { status: 200, body: "x" }, null])
      t("策略:壞回應 → UNREACH + strategy null(" + (b ? b.status + "/" + JSON.stringify(b.body) : "連不上") + ")", (() => { const r = interpretStrategy(b, "momo"); return r.code === "UNREACH" && r.strategy === null; })()); }
  { const stCalls = []; let stCreds = { token: "acct-S", appSecret: "appsec-S" }, stReply = { status: 200, body: stBody() };
    const h = createCloudHost({ apiBase: "https://x", getCreds: () => stCreds, post: async (u, b) => { stCalls.push({ u, b }); if (stReply instanceof Error) throw stReply; return stReply; }, now: () => clock, setTimer: () => 0, clearTimer: () => {} });
    const r0 = await h.strategy("momo");
    t("策略:POST 到契約的路徑,body 只有兩顆憑證 + name(原樣,api 只當比對 key)", stCalls.length === 1 && stCalls[0].u === "https://x" + STRATEGY_ENDPOINT && JSON.stringify(Object.keys(stCalls[0].b).sort()) === '["app_secret","name","token"]' && stCalls[0].b.name === "momo" && r0.code === "OK");
    t("策略:回應不進主行程手上那一份(snapshot / status 都沒有它的字);憑證不出現在回上去的東西裡", !JSON.stringify(h.snapshot()).includes("MARKER-DESC") && !JSON.stringify(h.status()).includes("MARKER-DESC") && !JSON.stringify(r0).includes("acct-S") && !JSON.stringify(r0).includes("appsec-S"));
    t("策略:壞名字(空 / 非字串 / 超長)不發請求", (await h.strategy("")).code === "UNREACH" && (await h.strategy(null)).code === "UNREACH" && (await h.strategy("x".repeat(201))).code === "UNREACH" && stCalls.length === 1);
    // 連點兩支不可以被節流成「讀不到」:沒有最小間隔,重複打只靠「同一支在途共用」擋
    stReply = { status: 200, body: stBody({ strategy: { name: "other", code: "y" } }) };
    t("策略:緊接著點另一支照樣打(不節流;讀不到會被畫成收掉選取)", (await h.strategy("other")).code === "OK" && stCalls.length === 2);
    { let release; const gate = new Promise((r) => { release = r; }); let c2 = 0;
      const h2 = createCloudHost({ apiBase: "https://x", getCreds: () => stCreds, post: async () => { c2++; await gate; return { status: 200, body: stBody() }; }, now: () => clock, setTimer: () => 0, clearTimer: () => {} });
      const a = h2.strategy("momo"), b2 = h2.strategy("momo"); release(); const [ra, rb] = [await a, await b2];
      t("策略:同一支在途時共用同一個請求(只打一次)", c2 === 1 && ra === rb && ra.code === "OK");
      t("策略:在途那一份結束後,下一次問得動", (await h2.strategy("momo")).code === "OK" && c2 === 2); }
    { let release; const gate = new Promise((r) => { release = r; }); let who = { token: "acct-A", appSecret: "sa" };
      const h3 = createCloudHost({ apiBase: "https://x", getCreds: () => who, post: async () => { await gate; return { status: 200, body: stBody() }; }, now: () => clock, setTimer: () => 0, clearTimer: () => {} });
      const p = h3.strategy("momo"); await Promise.resolve(); who = null; release();
      t("策略:請求在路上時登出 / 換帳號 → 這份不交給畫面(算讀不到)", (await p).code === "UNREACH"); }
    let n = stCalls.length; stCreds = { token: "acct-S", appSecret: null };
    t("策略:沒有 app_secret / 沒登入:不發請求,也算讀不到", (await h.strategy("momo")).code === "UNREACH" && (stCreds = null, (await h.strategy("momo")).code === "UNREACH") && stCalls.length === n);
    stCreds = { token: "acct-A", appSecret: "sa" }; stReply = new Error("offline");
    t("策略:連不上 → UNREACH,不拋", (await h.strategy("momo")).code === "UNREACH"); }
  t("main.js:cloud-strategy 走 handle()(只收自家頁面),拒絕時回 { code: UNREACH, strategy: null };preload 只多暴露 cloudStrategy 一支",
    /\n  handle\("cloud-strategy", \(_e, q\) => cloudHost\(\)\.strategy\(q && q\.name\), \{ code: "UNREACH", strategy: null \}\);/.test(mainSrc)
    && /cloudStrategy: \(name\) => ipcRenderer\.invoke\("cloud-strategy", \{ name \}\)/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "preload.js"), "utf8")));

  /* ── 權益曲線與當日損益(總覽分頁的第三支端點)────────────────────────
     api 回的是網頁 GET /openclaw/agent/overview 那一份(包在 overview 底下);這裡對成這台電腦那一份的形狀,trade.js 換來源就能畫 */
  const ovBody = (o = {}) => ({ machine_state: "running", server_time: 130, overview: {
    curve: [{ ts: 100, equity_usdt: 1000 }, { ts: 3700, equity_usdt: 1010 }, { ts: 7300, equity_usdt: 2010 }, { ts: 10900, equity_usdt: 2030 }, { ts: "x", equity_usdt: 1 }, { ts: 5, equity_usdt: null }, null, "nope"],
    period: { start_ts: 100, end_ts: 10900, start_equity: 1000, end_equity: 2030, net_flows: 1000, pnl: null },
    today: { start_ts: 100, start_equity: 1000, net_flows: 0, pnl: 12.5 },
    currency: "USDT", anomalies: [{ ts: 7300, note: "flow_detected" }, { ts: "x", note: "flow_detected" }, null], baseline_ts: 100, unrealized_usdt: null, ...o } });
  { const r = interpretOverview({ status: 200, body: ovBody() }, "USDT");
    t("曲線:形狀對成這台電腦那一份(equity_usdt → equity、壞點濾掉、today 只留 pnl / start_equity、unrealized null、baseline_ts)",
      r.code === "OK" && r.curve.curve.length === 4 && r.curve.curve[0].equity === 1000 && r.curve.curve[0].ts === 100 && r.curve.currency === "USDT" && r.curve.baseline_ts === 100
      && JSON.stringify(r.curve.today) === '{"pnl":12.5,"start_equity":1000}' && r.curve.unrealized === null && r.curve.anomalies.length === 1 && r.curve.anomalies[0].ts === 7300);
    t("曲線:資金異動之後的點換一個 basis(斷線規則跟這台電腦的口徑換過同一條;異動那一格自己是新段的第一點)", r.curve.curve.map((p) => p.basis).join() === "flow0,flow0,flow1,flow1");
    t("曲線:今天的損益跨過資金異動時 api 回 null → today null(畫「—」,不是 0)", interpretOverview({ status: 200, body: ovBody({ today: { start_ts: 100, start_equity: 1000, net_flows: 0, pnl: null } }) }, "USDT").curve.today === null
      && interpretOverview({ status: 200, body: ovBody({ today: null }) }, "USDT").curve.today === null);
    t("曲線:真的還沒有點 = OK + 空陣列(不是讀不到);沒有異動 = 全部同一段", (() => { const x = interpretOverview({ status: 200, body: ovBody({ curve: [], anomalies: [] }) }, "USDT"); return x.code === "OK" && x.curve.curve.length === 0; })()
      && interpretOverview({ status: 200, body: ovBody({ anomalies: [] }) }, "USDT").curve.curve.every((p) => p.basis === "flow0"));
    t("曲線:計價幣跟畫面釘住的對不上(api 折不出那一幣退回別的)→ 當讀不到,不畫錯單位的數字;沒釘就照收", interpretOverview({ status: 200, body: ovBody({ currency: "TWD" }) }, "USDT").code === "UNREACH"
      && interpretOverview({ status: 200, body: ovBody({ currency: "usdt" }) }, "USDT").code === "OK" && interpretOverview({ status: 200, body: ovBody({ currency: "TWD" }) }, null).curve.currency === "TWD");
    for (const b of [{ status: 401, body: {} }, { status: 429, body: {} }, { status: 500, body: {} }, { status: 200, body: {} }, { status: 200, body: { overview: null } }, { status: 200, body: { overview: { curve: "nope" } } }, { status: 200, body: null }, null])
      t("曲線:壞回應 → UNREACH + curve null(" + (b ? b.status + "/" + JSON.stringify(b.body) : "連不上") + ")", (() => { const x = interpretOverview(b, "USDT"); return x.code === "UNREACH" && x.curve === null; })()); }
  { const ovCalls = []; let ovCreds = { token: "acct-O", appSecret: "appsec-O" }, ovReply = { status: 200, body: ovBody() };
    // 曲線那一支會等最小間隔(不是回讀不到):假的 timer 把時鐘推過去、馬上叫
    const slept = []; const ovTimer = (fn, ms) => { slept.push(ms); clock += ms; fn(); return 0; };
    const h = createCloudHost({ apiBase: "https://x", getCreds: () => ovCreds, post: async (u, b) => { ovCalls.push({ u, b }); if (ovReply instanceof Error) throw ovReply; return ovReply; }, now: () => clock, setTimer: ovTimer, clearTimer: () => {} });
    const ask = (d, c) => { tick(EVENTS_MIN_GAP_MS); return h.overview(d, c); };
    const r0 = await h.overview(30, "USDT");
    t("曲線:POST 到契約的路徑,body 只有兩顆憑證 + days + 釘住的計價幣", ovCalls.length === 1 && ovCalls[0].u === "https://x" + OVERVIEW_ENDPOINT && JSON.stringify(Object.keys(ovCalls[0].b).sort()) === '["app_secret","currency","days","token"]'
      && ovCalls[0].b.days === 30 && ovCalls[0].b.currency === "USDT" && r0.code === "OK" && r0.curve.curve.length === 4);
    t("曲線:回應不進主行程手上那一份(snapshot / status 都沒有它);憑證不出現在回上去的東西裡", !JSON.stringify(h.snapshot()).includes("2030") && !JSON.stringify(h.status()).includes("2030") && !JSON.stringify(r0).includes("acct-O") && !JSON.stringify(r0).includes("appsec-O"));
    await ask(0); await ask(500); await ask("x"); await ask(7, "usdt"); await ask(7, "not a currency"); await ask(7, 5);
    const ds = ovCalls.slice(1).map((c) => c.b.days), cs = ovCalls.slice(1).map((c) => ("currency" in c.b ? c.b.currency : "-"));
    t("曲線:days 夾在 1–90(0 / 壞值 → 30);計價幣大寫、不像幣別代碼的不帶", ds.join() === "30,90,30,7,7,7" && cs.join() === "-,-,-,USDT,-,-");
    { const n = ovCalls.length; tick(EVENTS_MIN_GAP_MS - 1000); slept.length = 0; const r = await h.overview(30);
      t("曲線:最小間隔內再問不是回讀不到(切區間就是會 5 秒內連問兩次),而是等滿間隔再打一次", r.code === "OK" && ovCalls.length === n + 1 && slept.join() === "1000");
      slept.length = 0; tick(EVENTS_MIN_GAP_MS); await h.overview(30); t("曲線:過了最小間隔就直接打、不等", slept.length === 0 && ovCalls.length === n + 2); }
    for (const bad of [{ status: 401, body: {} }, { status: 429, body: {} }, { status: 500, body: {} }, { status: 200, body: {} }, new Error("offline")]) {
      ovReply = bad; const r = await ask(30);
      t("曲線:讀不到 → UNREACH(不是空曲線),不拋(" + (bad instanceof Error ? "連不上" : bad.status + "/" + JSON.stringify(bad.body)) + ")", r.code === "UNREACH" && r.curve === null); }
    ovReply = { status: 200, body: ovBody() };
    { let release; const gate = new Promise((r) => { release = r; }); let c2 = 0;
      const days2 = [];
      const h2 = createCloudHost({ apiBase: "https://x", getCreds: () => ovCreds, post: async (_u, b) => { c2++; days2.push(b.days); await gate; return { status: 200, body: ovBody() }; }, now: () => clock, setTimer: ovTimer, clearTimer: () => {} });
      const a = h2.overview(30), b2 = h2.overview(30), c3 = h2.overview(7); const oneSoFar = c2 === 1;   // 三個呼叫只有一個出門(第三個在排隊)
      release(); const [ra, rb] = [await a, await b2];
      t("曲線:同一個區間在途時共用同一個請求(只打一次)", oneSoFar && ra === rb && ra.code === "OK");
      const rc = await c3;
      t("曲線:不同區間排在在途那份後面、自己打自己的(每一份都是自己那個區間的)", rc.code === "OK" && rc !== ra && c2 === 2 && days2.join() === "30,7");
      tick(EVENTS_MIN_GAP_MS); t("曲線:在途那一份結束後,下一次問得動(inflight 有清掉)", (await h2.overview(30)).code === "OK" && c2 === 3); }
    { let release; const gate = new Promise((r) => { release = r; }); let who = { token: "acct-A", appSecret: "sa" };
      const h3 = createCloudHost({ apiBase: "https://x", getCreds: () => who, post: async () => { await gate; return { status: 200, body: ovBody() }; }, now: () => clock, setTimer: ovTimer, clearTimer: () => {} });
      const p = h3.overview(30); await Promise.resolve(); who = null; release();
      t("曲線:請求在路上時登出 / 換帳號 → 這份不交給畫面(算讀不到)", (await p).code === "UNREACH" && (await p).curve === null); }
    { const n = ovCalls.length; ovCreds = { token: "acct-O", appSecret: null }; tick(EVENTS_MIN_GAP_MS);
      const a = await h.overview(30); ovCreds = null; tick(EVENTS_MIN_GAP_MS); const b2 = await h.overview(30);
      t("曲線:沒有 app_secret / 沒登入:不發請求,也算讀不到", a.code === "UNREACH" && b2.code === "UNREACH" && ovCalls.length === n); }
    // 事件與曲線各自的節流桶:曲線剛打過不擋事件(總覽一次載入要兩支一起問)
    { ovCreds = { token: "acct-O", appSecret: "appsec-O" }; tick(EVENTS_MIN_GAP_MS); const n = ovCalls.length;
      const a = await h.overview(30); ovReply = { status: 200, body: evBody() }; const e = await h.events(30);
      t("曲線與事件各自節流,一起問不互相擋", a.code === "OK" && e.code === "OK" && ovCalls.length === n + 2); } }
  /* ── 組合績效(總覽分頁的第四支端點)── 網頁 GET /openclaw/agent/performance 那一份包在 performance 底下 */
  const pfBody = (o = {}) => ({ machine_state: "running", server_time: 130, performance: {
    metrics: { cumulative_return: { value: 0.12, status: "ok" }, max_drawdown: { value: 0.06, status: "ok", window_days: 12 }, annual_return: { value: null, status: "accumulating", reason: "insufficient_time" },
      volatility: { value: 0.4, status: "estimate", reason: "insufficient_time", sample_hours: 30.7 }, sharpe: { value: "x", status: "weird", reason: 7 }, trade_count: { value: 5, status: "ok" } },
    pnl_curve: [{ ts: 200, pnl_usdt: 10 }, { ts: 100, pnl_usdt: 0 }, { ts: 150, pnl_usdt: null }, { ts: "x", pnl_usdt: 1 }, null], currency: "USDT", baseline_ts: 100, ...o } });
  { const r = interpretPerformance({ status: 200, body: pfBody() }, "USDT");
    t("績效:六格逐格驗型別(value 非有限數 → null、status 不認得 → accumulating、reason 只留字串、window_days / sample_hours 帶著)、pnl_curve 排序且 null 點照留",
      r.code === "OK" && r.perf.metrics.cumulative_return.value === 0.12 && r.perf.metrics.max_drawdown.window_days === 12 && r.perf.metrics.annual_return.value === null && r.perf.metrics.annual_return.reason === "insufficient_time"
      && r.perf.metrics.volatility.status === "estimate" && r.perf.metrics.volatility.sample_hours === 30.7 && r.perf.metrics.sharpe.status === "accumulating" && r.perf.metrics.sharpe.value === null && !("reason" in r.perf.metrics.sharpe)
      && r.perf.metrics.trade_count.value === 5 && JSON.stringify(r.perf.pnl_curve) === '[{"ts":100,"pnl":0},{"ts":150,"pnl":null},{"ts":200,"pnl":10}]' && r.perf.currency === "USDT" && r.perf.baseline_ts === 100);
    t("績效:缺一格也給空格(accumulating、value null),畫面照畫六格", (() => { const b = pfBody(); delete b.performance.metrics.sharpe; const x = interpretPerformance({ status: 200, body: b }, "USDT"); return x.code === "OK" && x.perf.metrics.sharpe.status === "accumulating" && x.perf.metrics.sharpe.value === null; })());
    t("績效:計價幣對不上 → 讀不到;沒釘就照收", interpretPerformance({ status: 200, body: pfBody({ currency: "TWD" }) }, "USDT").code === "UNREACH" && interpretPerformance({ status: 200, body: pfBody({ currency: "TWD" }) }, null).perf.currency === "TWD");
    for (const b of [{ status: 401, body: {} }, { status: 429, body: {} }, { status: 500, body: {} }, { status: 200, body: {} }, { status: 200, body: { performance: null } }, { status: 200, body: { performance: { metrics: {} } } }, { status: 200, body: { performance: { metrics: "x", pnl_curve: [] } } }, null])
      t("績效:壞回應 → UNREACH + perf null(" + (b ? b.status + "/" + JSON.stringify(b.body) : "連不上") + ")", (() => { const x = interpretPerformance(b, "USDT"); return x.code === "UNREACH" && x.perf === null; })()); }
  { const pfCalls = []; let pfCreds = { token: "acct-P", appSecret: "appsec-P" }, pfReply = { status: 200, body: pfBody() };
    const slept = []; const pfTimer = (fn, ms) => { slept.push(ms); clock += ms; fn(); return 0; };
    const h = createCloudHost({ apiBase: "https://x", getCreds: () => pfCreds, post: async (u, b) => { pfCalls.push({ u, b }); if (pfReply instanceof Error) throw pfReply; return pfReply; }, now: () => clock, setTimer: pfTimer, clearTimer: () => {} });
    tick(EVENTS_MIN_GAP_MS); const r0 = await h.performance(7, "USDT");
    t("績效:POST 到契約的路徑,body 只有兩顆憑證 + days + 釘住的計價幣", pfCalls.length === 1 && pfCalls[0].u === "https://x" + PERFORMANCE_ENDPOINT && JSON.stringify(Object.keys(pfCalls[0].b).sort()) === '["app_secret","currency","days","token"]' && pfCalls[0].b.days === 7 && r0.code === "OK");
    t("績效:回應不進主行程手上那一份;憑證不出現在回上去的東西裡", !JSON.stringify(h.snapshot()).includes("0.12") && !JSON.stringify(h.status()).includes("0.12") && !JSON.stringify(r0).includes("acct-P") && !JSON.stringify(r0).includes("appsec-P"));
    // 跟權益曲線各自一份在途 / 節流(同一個 readDetail 做法):曲線剛打過不擋績效,績效自己的最小間隔照等
    { const n = pfCalls.length; pfReply = { status: 200, body: ovBody() }; const o = await h.overview(7, "USDT"); pfReply = { status: 200, body: pfBody() }; slept.length = 0; const p = await h.performance(7, "USDT");
      t("績效與曲線各自節流:曲線剛打過,績效不被擋、但自己等滿間隔", o.code === "OK" && p.code === "OK" && pfCalls.length === n + 2 && slept.join() === String(EVENTS_MIN_GAP_MS)); }
    for (const bad of [{ status: 401, body: {} }, { status: 500, body: {} }, new Error("offline")]) { pfReply = bad; tick(EVENTS_MIN_GAP_MS); const r = await h.performance(7, "USDT");
      t("績效:讀不到 → UNREACH(不是空的六格),不拋(" + (bad instanceof Error ? "連不上" : bad.status) + ")", r.code === "UNREACH" && r.perf === null); }
    pfReply = { status: 200, body: pfBody() };
    { const n = pfCalls.length; pfCreds = null; tick(EVENTS_MIN_GAP_MS); t("績效:沒登入不發請求,也算讀不到", (await h.performance(7)).code === "UNREACH" && pfCalls.length === n); } }
  t("main.js:cloud-performance 走 handle()(只收自家頁面),拒絕時回 { code: UNREACH, perf: null };preload 多暴露 cloudPerformance 一支",
    /\n  handle\("cloud-performance", \(_e, q\) => cloudHost\(\)\.performance\(q && q\.days, q && q\.currency\), \{ code: "UNREACH", perf: null \}\);/.test(mainSrc)
    && /cloudPerformance: \(q\) => ipcRenderer\.invoke\("cloud-performance", q\)/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "preload.js"), "utf8")));
  t("main.js:cloud-overview 走 handle()(只收自家頁面),拒絕時回 { code: UNREACH, curve: null };preload 多暴露 cloudOverview 一支",
    /\n  handle\("cloud-overview", \(_e, q\) => cloudHost\(\)\.overview\(q && q\.days, q && q\.currency\), \{ code: "UNREACH", curve: null \}\);/.test(mainSrc)
    && /cloudOverview: \(q\) => ipcRenderer\.invoke\("cloud-overview", q\)/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "preload.js"), "utf8")));

  { // 版本變了要推給畫面(關於那一行要跟上主機回報的版本)
    let rep = { status: 200, body: body({ config_version: "1.1.80" }) }, seen = [], ck = 5e6;
    const h = createCloudHost({ apiBase: "https://x", getCreds: () => ({ token: "u", appSecret: "s" }), post: async () => rep,
      onChange: (s) => seen.push(s.config_version), now: () => ck, setTimer: () => 0, clearTimer: () => {} });
    await h.refresh(true); ck += MIN_GAP_MS;
    rep = { status: 200, body: body({ config_version: "1.1.83" }) };
    await h.refresh(true);
    t("config_version 變了就推(不等 60 秒那一輪)", seen.join(",") === "1.1.80,1.1.83", seen.join(",")); }

  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
