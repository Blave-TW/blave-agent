// Blave 電腦版 — 雲端宿主(主行程用)。線 B 第一刀:讀用戶雲端主機的狀態,**唯讀**。
// 契約:blave-canon output/backend/2026-09-21-desktop-cloud-state-contract.md
//
// 為什麼長這樣:
//   - 雲端主機回報的那一包跟本機的 state/local_status.json 是同一支 build_report() 的輸出,所以 status() 回的形狀
//     刻意跟 daemon.js 的 status() 一樣({ alive, report, … }):renderer 的 trade.js 換一個來源就能畫,不必認得兩種資料。
//   - 兩顆憑證(帳號 token + app_secret)只在主行程:帳號 token 會進 agent 的環境,單獨拿它讀不到部位與權益——
//     這是硬要求。所以這個檔**不把憑證交給任何人**:不進 renderer、不進子行程的環境、不寫檔、不 log。
//   - 雲端來的字串是雲端那台機器上的策略碼寫得進去的東西:一律當成不可信輸入,這裡原樣往上交,renderer 只能用 textContent 畫。
//     回應也**不落地**(不寫 workspace、不寫 userData):agent 讀得到 workspace,落地就等於把部位交給它。
//   - 停機的主機會留著 24 小時的舊快取:alive 只在「主機運行中而且回報夠新」時為真,否則舊快取會被畫成下單中。
//
// 這個檔不 require electron;HTTP 由呼叫端注入(測試用假的)。
const ENDPOINT = "/oauth/desktop/cloud/state";
const EVENTS_ENDPOINT = "/oauth/desktop/cloud/events";
const STRATEGY_ENDPOINT = "/oauth/desktop/cloud/strategy";
const OVERVIEW_ENDPOINT = "/oauth/desktop/cloud/overview";
const PERFORMANCE_ENDPOINT = "/oauth/desktop/cloud/performance";
const EVENTS_MAX = 500;
const UNREACHABLE = () => ({ code: "UNREACH", events: [] });
const STRATEGY_UNREACHABLE = () => ({ code: "UNREACH", strategy: null });
const OVERVIEW_UNREACHABLE = () => ({ code: "UNREACH", curve: null });
const PERF_UNREACHABLE = () => ({ code: "UNREACH", perf: null });
const METRIC_KEYS = ["cumulative_return", "max_drawdown", "annual_return", "volatility", "sharpe", "trade_count"];
const METRIC_STATUS = ["ok", "estimate", "accumulating"];
const EVENTS_MIN_GAP_MS = 5 * 1000;
const POLL_FOREGROUND_MS = 15 * 1000, POLL_BACKGROUND_MS = 60 * 1000, BACKOFF_MS = 60 * 1000, MIN_GAP_MS = 5 * 1000;
const MACHINE_STATES = ["none", "starting", "running", "stopped"];

/* 回應 → 畫面用的狀態(純函式)。code:
     OK | NO_LOGIN(沒登入 Blave)| NO_APP_SECRET(舊登入,要重新登入)| REVOKED(憑證被撤銷)| RATE_LIMITED | OFFLINE | BAD_RESPONSE */
function interpret(res) {
  if (!res || !res.status) return { code: "OFFLINE" };
  if (res.status === 401) return { code: res.body && res.body.error_code === "APP_SECRET_REQUIRED" ? "NO_APP_SECRET" : "REVOKED" };
  if (res.status === 429) return { code: "RATE_LIMITED" };
  const b = res.body;
  if (res.status !== 200 || !b || typeof b !== "object" || !b.machine || typeof b.machine !== "object") return { code: res.status >= 500 ? "OFFLINE" : "BAD_RESPONSE" };
  const state = MACHINE_STATES.indexOf(b.machine.state) >= 0 ? b.machine.state : "none";
  const stale = b.portfolio_stale !== false;   // 缺席或不是 false 一律當舊的:寧可說「不是現況」,不可把舊快取畫成下單中
  const report = b.portfolio && typeof b.portfolio === "object" ? b.portfolio : null;
  return {
    code: "OK",
    machine: { state, os_type: typeof b.machine.os_type === "string" ? b.machine.os_type : null,
      public_ip: state === "running" && typeof b.machine.public_ip === "string" && /^[0-9a-fA-F.:]{3,45}$/.test(b.machine.public_ip) ? b.machine.public_ip : null },   // 停機的主機沒有固定 IP,舊 IP 可能已屬於別人:只在運行中才往上交
    alive: state === "running" && !stale && !!report,
    stale, report,
    reported_at: typeof b.portfolio_reported_at === "number" ? b.portfolio_reported_at : null,
    server_time: typeof b.server_time === "number" ? b.server_time : null,
    fx_rates: b.fx_rates && typeof b.fx_rates === "object" ? b.fx_rates : null,
    currency: typeof b.currency === "string" ? b.currency : null,
    strategies: Array.isArray(b.strategies_summary) ? b.strategies_summary.filter((s) => s && typeof s === "object" && typeof s.name === "string") : [],
    /* 「讀到空的清單」跟「這一份沒帶清單」是兩件事(spec-desktop-cloud-s4 §1.1 ②):金額是整份覆蓋,
       把缺席當成空清單,存檔會把整個組合移出。畫面只在這個旗標為真時才算清單已載入。 */
    /* summary 是 array|null(null = 索引讀不回)。只擋 null:strategies_partial === true(有名字缺 summary,大策略可能長期如此)
       照樣放行畫金額表(Wei 拍板)——雲端永遠不從「不在清單上」推論移出(trade.js trSendAmounts),缺的那幾支金額原樣帶著送,
       表下另講「有 N 支暫時讀不到」。Redis 淘汰時 api 仍可能回 [](分不出),由 trCloudListOk 擋「空清單卻有金額」 */
    strategies_ok: Array.isArray(b.strategies_summary),
    strategies_partial: b.strategies_partial === true,
    config_version: typeof b.config_version === "string" ? b.config_version : null,
    latest_config_version: typeof b.latest_config_version === "string" ? b.latest_config_version : null,
    data_sources: Array.isArray(b.data_sources) ? b.data_sources.filter((n) => typeof n === "string") : [],
  };
}

/* 事件清單的回應 → { code, events }(純函式)。**「讀不到」與「真的沒有事件」是兩件事**:
   401 / 429 / 5xx / 形狀不對 / 連不上一律 UNREACH,畫面得說自己讀不到,不可以畫成「這段期間沒有事件」
   (同權益曲線的先例:讀不到就不畫,不斷言)。只有真的拿到 200 + events 陣列才是 OK——空陣列就是真的沒有。
   最新在前(api 的順序),所以取前面 EVENTS_MAX 筆。 */
function interpretEvents(res) {
  const b = res && res.status === 200 ? res.body : null;
  if (!b || typeof b !== "object" || !Array.isArray(b.events)) return { code: "UNREACH", events: [] };
  return { code: "OK", events: b.events
    .filter((e) => e && typeof e === "object" && typeof e.ts === "number" && typeof e.type === "string")
    .slice(0, EVENTS_MAX)
    .map((e) => ({ ts: e.ts, type: e.type, data: e.data && typeof e.data === "object" ? e.data : {} })) };
}

/* 單支策略的回應 → { code, strategy }(純函式)。同事件清單:讀不到與「沒有這支」是兩件事——
   200 + `strategy: null` 才是「雲端現在沒有這一份」(api 的契約:沒這個名字 / 物件被逐出 / 沒主機都是這個);
   其餘一律 UNREACH。物件是雲端那台機器上的策略碼寫得進去的東西:欄位逐個驗型別,只留報告要畫的那幾欄
   (形狀對齊主行程 loadStrategy:{ name, displayName, description, stats, scan, code }),renderer 一律 textContent。
   scan = 參數掃描(機器端 scan.json 經 api 併進來):只驗到「是物件」,逐欄的型別檢查在 report-robust.js 的 sanitizeScan(本機那份同一套)。 */
function interpretStrategy(res, name) {
  const b = res && res.status === 200 ? res.body : null;
  if (!b || typeof b !== "object" || !("strategy" in b)) return STRATEGY_UNREACHABLE();
  const s = b.strategy;
  if (s === null) return { code: "OK", strategy: null };
  if (!s || typeof s !== "object" || s.name !== name) return STRATEGY_UNREACHABLE();
  const str = (v) => (typeof v === "string" ? v : "");
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
  return { code: "OK", strategy: { name, displayName: str(s.display_name) || name, description: str(s.description), stats: obj(s.backtest), scan: obj(s.scan), code: str(s.code) } };
}

/* 權益曲線的回應 → { code, curve }(純函式)。同事件清單:讀不到與「還沒有紀錄」是兩件事——只有 200 + `overview.curve`
   是陣列才是 OK,空陣列就是真的還沒有點;其餘一律 UNREACH。
   形狀對齊這台電腦那一份(daemon.js equity()):{ curve: [{ ts, equity, basis }], currency, baseline_ts, today, unrealized },
   trade.js 換一個來源就能畫。api 的 `equity_usdt` 是舊欄名,值已折成回應頂層 `currency`;`today.pnl` 跨過資金異動時 api 回 null。
   basis:這台電腦用它標「口徑換過」(曲線在那裡斷開、累積損益只從最後一段起算);雲端沒有口徑,但有 api 的
   `anomalies`(出入金 / 綁解綁一個所:跨過它的損益 api 自己就不算)——每一個異動之後的點換一個 basis,
   同一條斷線規則就把它畫對(累積損益不會把入金當成獲利)。
   `currency` = 畫面釘住的計價幣(帳戶回報的幣別):api 折不出那一幣(fx 表沒有)會退回別的幣、如實寫在回應裡,
   那份數字跟畫面上的單位對不起來 → 當讀不到,不畫錯單位的數字。 */
function interpretOverview(res, currency) {
  const b = res && res.status === 200 ? res.body : null;
  const o = b && typeof b === "object" && b.overview && typeof b.overview === "object" ? b.overview : null;
  if (!o || !Array.isArray(o.curve)) return OVERVIEW_UNREACHABLE();
  const ccy = typeof o.currency === "string" && o.currency ? o.currency.toUpperCase() : null;
  if (currency && ccy !== String(currency).toUpperCase()) return OVERVIEW_UNREACHABLE();
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const anomalies = (Array.isArray(o.anomalies) ? o.anomalies : [])
    .filter((a) => a && typeof a === "object" && num(a.ts) != null).map((a) => ({ ts: a.ts, note: typeof a.note === "string" ? a.note : "" })).sort((x, y) => x.ts - y.ts);
  const curve = o.curve.filter((p) => p && typeof p === "object" && num(p.ts) != null && num(p.equity_usdt) != null)
    .map((p) => ({ ts: p.ts, equity: p.equity_usdt, basis: "flow" + anomalies.filter((a) => a.ts <= p.ts).length }));
  const td = o.today && typeof o.today === "object" ? o.today : null;
  const today = td && num(td.pnl) != null && num(td.start_equity) != null ? { pnl: td.pnl, start_equity: td.start_equity } : null;
  return { code: "OK", curve: { curve, currency: ccy || "USDT", baseline_ts: num(o.baseline_ts), today, unrealized: null, anomalies } };
}

/* 組合績效的回應 → { code, perf }(純函式)。同權益曲線:只有 200 + `performance.metrics` 物件 + `pnl_curve` 陣列才是 OK;
   計價幣跟畫面釘住的對不上 → 讀不到。六格逐格驗型別(status 不認得就當 accumulating、value 不是有限數就 null),
   只留畫面會讀的欄位(value / status / reason / window_days / sample_hours);`pnl_curve` 的 null 點(資金異動)照留——
   畫面靠它知道那裡剔除過跳變。網頁工作頁 GET /openclaw/agent/performance 的同一份。 */
function interpretPerformance(res, currency) {
  const b = res && res.status === 200 ? res.body : null;
  const o = b && typeof b === "object" && b.performance && typeof b.performance === "object" ? b.performance : null;
  if (!o || !o.metrics || typeof o.metrics !== "object" || !Array.isArray(o.pnl_curve)) return PERF_UNREACHABLE();
  const ccy = typeof o.currency === "string" && o.currency ? o.currency.toUpperCase() : null;
  if (currency && ccy !== String(currency).toUpperCase()) return PERF_UNREACHABLE();
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const metrics = {};
  METRIC_KEYS.forEach((k) => {
    const m = o.metrics[k] && typeof o.metrics[k] === "object" ? o.metrics[k] : {};
    const out = { value: num(m.value), status: METRIC_STATUS.indexOf(m.status) >= 0 ? m.status : "accumulating" };
    if (typeof m.reason === "string" && m.reason) out.reason = m.reason;
    if (num(m.window_days) != null) out.window_days = m.window_days;
    if (num(m.sample_hours) != null) out.sample_hours = m.sample_hours;
    metrics[k] = out;
  });
  const pnl_curve = o.pnl_curve.filter((p) => p && typeof p === "object" && num(p.ts) != null)
    .map((p) => ({ ts: p.ts, pnl: num(p.pnl_usdt) })).sort((x, y) => x.ts - y.ts);
  return { code: "OK", perf: { metrics, pnl_curve, currency: ccy || "USDT", baseline_ts: num(o.baseline_ts) } };
}

/* opts:{ apiBase, getCreds() → { token, appSecret } | null, post(url, body) → Promise<{status, body}>, onChange?(snapshot), now?, setTimer?, clearTimer? }
   onChange 在狀態的「摘要」變了才叫(切換器上的另一邊狀態靠它),不是每次輪詢都叫。

   **這份 snapshot 是誰的**(稽核 M1、M2):手上的東西綁著「拿到它的那顆 token」(只在這個閉包的記憶體裡比對,不往外交)。
     - 這一輪要用的 token 跟手上那份的 owner 不同 = 換了人(登出、重新登入成別的帳號):先整包丟掉並通知畫面,才去打。
     - 每次 reset / 換人世代 +1;在途的請求回來時世代對不上就整包丟——登出的那一刻還在路上的回應,不會把上一個人的部位寫回來。
     - 連不上時「留著上一份」只限同一個 owner。
   所以呼叫端就算漏叫 reset(),也不會把 A 的部位畫給 B 看。 */
function createCloudHost(opts) {
  const now = opts.now || (() => Date.now());
  const setT = opts.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
  const clearT = opts.clearTimer || clearTimeout;
  const EMPTY = () => ({ code: "NO_LOGIN" });
  let snap = EMPTY(), owner = null, gen = 0, fetchedAt = 0, lastOkAt = 0, lastTryAt = 0, timer = null, foreground = true, running = false, inflight = null, lastKey = "";
  let epoch = 0;   // 換人 / 登出一次 +1:畫面拿它判斷「手上那些雲端的在途狀態是不是上一個人的」
  let evInflight = null, evLastTryAt = 0;   // 事件那一支自己的節流(它不共用上面那組:兩支走不同的速率桶)
  /* 總覽那兩支(權益曲線、組合績效)共用的讀法,各自一份在途 / 節流狀態。
     同一個區間在途就共用;不同區間排在它後面(切區間切得快,每一份都要是自己那個區間的——畫面靠 days 對號)。
     最小間隔不像事件那樣直接回讀不到:切區間就是會在 5 秒內連問兩次,回讀不到會讓曲線掛一分鐘的「讀不到」——
     改成等到間隔滿了再打(等的期間仍算在途,後到的共用 / 排隊),請求數不會比原本多。 */
  function readDetail(endpoint, interpretFn, unreachable) {
    let inflight = null, key = null, lastTryAt = 0;
    return async function (days, currency) {
      const d = Math.max(1, Math.min(Math.floor(Number(days) > 0 ? Number(days) : 30), 90));
      const ccy = typeof currency === "string" && /^[A-Za-z]{2,8}$/.test(currency) ? currency.toUpperCase() : null;
      const mine = d + "|" + (ccy || "");
      while (inflight) { if (key === mine) return inflight; await inflight.catch(() => {}); }
      key = mine;
      inflight = (async () => {
        const wait = EVENTS_MIN_GAP_MS - (now() - lastTryAt);
        if (wait > 0) await new Promise((r) => setT(r, wait));
        lastTryAt = now();
        let c = null; try { c = opts.getCreds(); } catch (_) { /* Keychain 讀不到:當成沒登入 */ }
        const tok = c && c.token ? c.token : null;
        if (!tok || !c.appSecret) return unreachable();                 // 沒登入 / 舊登入也是「讀不到」,不是「還沒有紀錄」
        let res = null;
        try { res = await opts.post(opts.apiBase + endpoint, { token: tok, app_secret: c.appSecret, days: d, ...(ccy ? { currency: ccy } : {}) }); } catch (_) { /* 連不上 */ }
        let cur = null; try { cur = opts.getCreds(); } catch (_) { /* 讀不到 = 沒登入 */ }
        if ((cur && cur.token ? cur.token : null) !== tok) return unreachable();
        return interpretFn(res, ccy);
      })().finally(() => { inflight = null; key = null; });
      return inflight;
    };
  }
  let stInflight = null, stName = null;   // 單支策略:同一支在途共用。不另設最小間隔——那會把「連點兩支」畫成讀不到;重複打由在途共用擋,速率由 api 的明細桶擋

  const summaryKey = (s) => [s.code, s.transient, s.machine && s.machine.state, s.alive, s.stale,
    s.report && s.report.halt && s.report.halt.halted, s.report && s.report.reconciler && s.report.reconciler.alive, (s.strategies || []).length,
    // 版本也要推:看這台電腦時畫面 60 秒才問一次,「關於」那一行要跟上主機回報的版本
    s.config_version, s.latest_config_version].join("|");
  const publicSnapshot = () => ({ ...snap, fetched_at: fetchedAt, last_ok_at: lastOkAt, epoch });
  function emit() { const key = summaryKey(snap); if (key === lastKey) return; lastKey = key; if (opts.onChange) try { opts.onChange(publicSnapshot()); } catch (_) { /* 畫面壞掉不影響輪詢 */ } }
  function drop(next) { gen++; epoch++; owner = null; snap = next || EMPTY(); fetchedAt = now(); lastOkAt = 0; emit(); }

  async function refresh(force) {
    // 在途時又被要求「現在就要」(登入成功那一刻):等在途那份回來;它若因為換了人被丟掉(owner 被清空),馬上替現在這個人再打一次
    if (inflight) return force ? inflight.then(() => (owner === null && !inflight ? refresh(true) : snap)) : inflight;
    // renderer 寫壞的迴圈不能繞過退讓把帳號的速率桶打爆:兩次真的請求之間至少隔 MIN_GAP_MS(輪詢自己不受影響——它的間隔本來就比這個長)
    if (!force && now() - lastTryAt < MIN_GAP_MS) return snap;
    inflight = (async () => {
      let creds = null; try { creds = opts.getCreds(); } catch (_) { /* Keychain 讀不到:當成沒登入 */ }
      const tok = creds && creds.token ? creds.token : null;
      if (tok !== owner && owner !== null) drop();            // 換了人:先丟掉上一個人的東西
      if (!tok) { if (snap.code !== "NO_LOGIN") drop(); return snap; }
      if (!creds.appSecret) { gen++; owner = tok; snap = { code: "NO_APP_SECRET" }; fetchedAt = now(); emit(); return snap; }
      const mine = ++gen; owner = tok; lastTryAt = now();
      let res = null;
      try { res = await opts.post(opts.apiBase + ENDPOINT, { token: tok, app_secret: creds.appSecret }); } catch (_) { /* 連不上 */ }
      if (mine !== gen) return snap;                           // 這段期間登出 / 換人了:這份回應不是現在這個人的,整包丟
      // 沒有人叫 reset() 也一樣(稽核 N1):回應回來時再看一次現在是誰——請求在路上的時候換了帳號,這份就是上一個人的
      let cur = null; try { cur = opts.getCreds(); } catch (_) { /* 讀不到 = 沒登入 */ }
      if ((cur && cur.token ? cur.token : null) !== tok) { drop(); return snap; }
      let next = interpret(res);
      // 連不上 / 被限速 / 非預期的 4xx·5xx:留著**同一個人**的上一份畫面(標成不是現況),不要把畫面清空。401 不留——憑證被撤銷了
      const soft = next.code === "OFFLINE" || next.code === "RATE_LIMITED" || next.code === "BAD_RESPONSE";
      if (soft && snap.code === "OK") next = { ...snap, alive: false, stale: true, transient: next.code };
      if (next.code === "OK" && !next.transient) lastOkAt = now();
      snap = next; fetchedAt = now(); emit();
      return snap;
    })().finally(() => { inflight = null; });
    return inflight;
  }
  function delay() {
    if (snap.transient === "RATE_LIMITED" || snap.code === "RATE_LIMITED") return BACKOFF_MS;
    // 401 / 沒登入:不狂打。下一次是給「用戶剛重新登入」用的(登入路徑會直接叫 refresh,不必等這個)
    if (snap.code !== "OK" || snap.transient) return POLL_BACKGROUND_MS;
    if (snap.machine.state === "none") return POLL_BACKGROUND_MS;   // 沒有雲端主機的人不必 15 秒問一次
    return foreground ? POLL_FOREGROUND_MS : POLL_BACKGROUND_MS;
  }
  // 全程只准有一條輪詢(稽核 N2):排下一次之前先清掉手上那個 timer——多出來的迴圈 stop() 清不到,會一直打到 app 結束
  function schedule() { if (timer) clearT(timer); timer = setT(() => { timer = null; loop(); }, delay()); }
  function loop() { if (!running) return; refresh(true).catch(() => {}).then(() => { if (running) schedule(); }); }
  // 電腦睡眠醒來:timer 沒跑、手上那份其實很舊了。太久沒成功同步就不算 alive,不管 snap 上怎麼寫
  const fresh = () => lastOkAt > 0 && now() - lastOkAt <= 3 * POLL_BACKGROUND_MS;

  return {
    // 懶啟動:第一次有人要雲端狀態才開始輪詢(還沒打開雲端視角的人不該每分鐘打 4 次 api)
    start() { if (running) return false; running = true; loop(); return true; },
    stop() { running = false; if (timer) clearT(timer); timer = null; },
    isRunning: () => running,
    // 回前景立刻要一份新的——但在途的那份本來就是新的(不重入)、剛打過不再打(快速切視窗)、被限速時乖乖等完退讓
    setForeground(on) { const was = foreground; foreground = !!on;
      if (!running || !foreground || was || inflight || now() - lastTryAt < MIN_GAP_MS || snap.code === "RATE_LIMITED" || snap.transient === "RATE_LIMITED") return;
      if (timer) clearT(timer); timer = null; loop(); },
    refresh: (force) => refresh(force === true),
    // 跟 daemon.js 的 status() 同形狀:trade.js 直接吃(report 只放這一份,不在 cloud 裡再複製一次)
    status() { const s = publicSnapshot(), report = s.report || null; delete s.report; const alive = !!snap.alive && fresh();
      return { alive, running: snap.code === "OK" && snap.machine.state === "running", report, lastExit: null, restarts: 0, cloud: { ...s, alive } }; },
    snapshot: publicSnapshot,
    /* 事件清單(點擊驅動:畫面問一次打一次)。跟狀態輪詢是兩個速率桶,所以不共用上面那組 inflight / 退讓。
       手上不留一份:不寫進這個閉包、不進 snapshot()、當然也不落地——直接回給呼叫端(同檔頭第 10 行)。
       **不碰 gen / owner**:動了的話,在途的那一輪狀態輪詢回來會對不上世代、把自己丟掉。
       換人只用本地的 token 比對(請求在路上時登出 / 換帳號 → 這份是上一個人的,丟掉)。
       自己的節流(同 refresh 的 MIN_GAP_MS,只是另一個桶):在途時共用同一個請求、兩次真的請求之間至少隔
       EVENTS_MIN_GAP_MS——renderer 寫壞的迴圈不能把 detail 桶打到 429(那會讓畫面長期停在「讀不到」)。
       擋下來的那一次回 UNREACH:這一輪確實沒讀到,但**不是**「沒有事件」。唯一的呼叫點自己就有 60 秒的閘,平常碰不到這裡。 */
    async events(days) {
      if (evInflight) return evInflight;
      let c = null; try { c = opts.getCreds(); } catch (_) { /* Keychain 讀不到:當成沒登入 */ }
      const tok = c && c.token ? c.token : null;
      if (!tok || !c.appSecret) return UNREACHABLE();                 // 沒登入 / 舊登入也是「讀不到」,不是「沒有事件」
      if (now() - evLastTryAt < EVENTS_MIN_GAP_MS) return UNREACHABLE();
      evLastTryAt = now();
      const d = Math.max(1, Math.min(Math.floor(Number(days) > 0 ? Number(days) : 30), 90));
      evInflight = (async () => {
        let res = null;
        try { res = await opts.post(opts.apiBase + EVENTS_ENDPOINT, { token: tok, app_secret: c.appSecret, days: d }); } catch (_) { /* 連不上 */ }
        let cur = null; try { cur = opts.getCreds(); } catch (_) { /* 讀不到 = 沒登入 */ }
        if ((cur && cur.token ? cur.token : null) !== tok) return UNREACHABLE();
        return interpretEvents(res);
      })().finally(() => { evInflight = null; });
      return evInflight;
    },
    /* 權益曲線與當日損益、組合績效(總覽分頁開著時 60 秒各問一次、切區間再問一次)。做法同事件清單:不留在這個閉包、
       不進 snapshot()、不落地;不碰 gen / owner;換人只用本地的 token 比對;各自的最小間隔 + 在途共用(readDetail)。
       回 { code: "OK" | "UNREACH", curve } / { code, perf }。 */
    overview: readDetail(OVERVIEW_ENDPOINT, interpretOverview, OVERVIEW_UNREACHABLE),
    performance: readDetail(PERFORMANCE_ENDPOINT, interpretPerformance, PERF_UNREACHABLE),
    /* 單支策略的報告(點擊驅動:側欄點一支打一次)。跟事件清單同一種做法:不留在這個閉包、不進 snapshot()、不落地,
       直接回給呼叫端;不碰 gen / owner;換人只用本地的 token 比對。名字是 renderer 給的雲端字串,原樣進 body(api 只當比對 key)。 */
    async strategy(name) {
      if (typeof name !== "string" || !name || name.length > 200) return STRATEGY_UNREACHABLE();
      if (stInflight && stName === name) return stInflight;
      let c = null; try { c = opts.getCreds(); } catch (_) { /* Keychain 讀不到:當成沒登入 */ }
      const tok = c && c.token ? c.token : null;
      if (!tok || !c.appSecret) return STRATEGY_UNREACHABLE();
      stName = name;
      stInflight = (async () => {
        let res = null;
        try { res = await opts.post(opts.apiBase + STRATEGY_ENDPOINT, { token: tok, app_secret: c.appSecret, name }); } catch (_) { /* 連不上 */ }
        let cur = null; try { cur = opts.getCreds(); } catch (_) { /* 讀不到 = 沒登入 */ }
        if ((cur && cur.token ? cur.token : null) !== tok) return STRATEGY_UNREACHABLE();
        return interpretStrategy(res, name);
      })().finally(() => { stInflight = null; stName = null; });
      return stInflight;
    },
    // 登出:立刻把手上的東西丟掉、通知畫面清掉,而且作廢還在路上的請求
    reset() { drop(); },
    _delay: delay,
  };
}

module.exports = { createCloudHost, interpret, interpretEvents, interpretStrategy, interpretOverview, interpretPerformance, ENDPOINT, EVENTS_ENDPOINT, STRATEGY_ENDPOINT, OVERVIEW_ENDPOINT, PERFORMANCE_ENDPOINT, EVENTS_MAX, EVENTS_MIN_GAP_MS, POLL_FOREGROUND_MS, POLL_BACKGROUND_MS, BACKOFF_MS, MIN_GAP_MS };
