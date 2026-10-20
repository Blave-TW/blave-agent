// 在手機 App 上查看這台電腦的部位(shell/mobileview.js + main.js / preload / renderer 的接線)。不打真的 api(get / post 是假的),不開視窗。
// 契約:blave-canon output/backend/2026-10-20-desktop-portfolio-upload-contract.md
//   1. 平台旗標關、讀不到、形狀不對:零上傳、零 closing、設定頁不出這一區
//   2. 旗標開:上傳帶兩顆憑證 + 衍生的裝置代號(不是 install_id 原值);送出去的只有允許清單、路徑／網址參數／長亂碼遮掉
//   3. 上傳回 403 MOBILE_VIEW_OFF → 當場當成關
//   4. 關掉開關 → 呼叫刪除、之後不再上傳;刪不成 → 記待刪、待刪期間絕不上傳、每一輪重送;打開時先刪再立刻傳一份
//   5. closing 送不出去(卡住)不卡結束流程;待刪 / 關掉 / 沒傳過不送 closing
//   6. 登出:先刪再撤 token;上傳失敗只寫 log,不碰 daemon
//   7. 憑證不出主行程:IPC 回的沒有憑證、狀態檔只有三個布林
//   8. 允許清單與 api 那份逐項相同(要 monorepo 版面)
// 跑法:node tests/check_shell_mobileview.js
const fs = require("fs"), os = require("os"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const MV = require(path.join(SHELL, "mobileview.js"));
const mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8"), preload = fs.readFileSync(path.join(SHELL, "preload.js"), "utf8");
const app = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8"), mvSrc = fs.readFileSync(path.join(SHELL, "mobileview.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const API = "https://api.test", INSTALL = "11111111-2222-4333-8444-555555555555";
const HOME = "/Users/wei";
const REPORT = () => ({
  config: { amounts: { momo: 1000 } }, states: { momo: { position: 1 } }, halt: { halted: false },
  last_reconcile: { ts: "2026-10-20T01:00:00", target: {}, actual: {} },
  account: { read_at: 1, venues: { binance: { ok: false, error: { msg: "FileNotFoundError: '/Users/wei/Blave/workspace/.env'" } } } },
  order_errors: [{ ts: "t", error: "ConnectionError https://fapi.binance.com/fapi/v1/order?symbol=BTCUSDT&signature=" + "f".repeat(64) + " key AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" }],
  orders: [], venues: { binance: { credentials: true, pair: true, order: true, account: true } },
  daemon: { pid: 4242, started_at: 1, heartbeat_at: 2, version: "2026-10-20-q", reconciler: { wanted: true, running: true, orphan: false, pid: 4343 } },
  events: [{ payload: { error: "/Users/wei/x" } }], tg_chat_ids: [1], tg_pair_gen: "g", strategy_kinds: { momo: {} },
  president_local: { secrets: true }, resources: { disk_pct: 3 }, workspace_update: { backup_dir: "/Users/wei/Blave/bak" },
  manager: { backtest: { daily_dates: [] } }, platform: "Darwin", reported_at: 1,
});

function mk(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blave-mv-"));
  const calls = [], logs = [];
  let creds = o.creds === undefined ? { token: "acct-A", appSecret: "appsec-A", who: "w-A" } : o.creds;
  let flagReply = o.flag === undefined ? { status: 200, body: { enabled: true } } : o.flag;
  let postReply = o.post || ((u) => ({ status: 200, body: { ok: true } }));
  let report = REPORT(), t = 1e9;
  const h = MV.createMobileView({
    dir, apiBase: API, home: HOME, installId: () => INSTALL, now: () => t, log: (m) => logs.push(m),
    get: async (u) => { calls.push(["GET", u]); if (typeof flagReply === "function") return flagReply(); return flagReply; },
    post: async (u, b) => { calls.push(["POST", u, b]); return postReply(u, b); },
    getCreds: () => creds, status: () => ({ running: true, alive: true, report }),
    line: () => ({ money: "real", venue: "binance", state: "on" }),
  });
  return { h, dir, calls, logs, posts: () => calls.filter((c) => c[0] === "POST"),
    setFlag: (f) => { flagReply = f; }, setPost: (f) => { postReply = f; }, setCreds: (c) => { creds = c; },
    setReport: (r) => { report = r; }, tick: (ms) => { t += ms; }, file: () => JSON.parse(fs.readFileSync(path.join(dir, "mobile-view.json"), "utf8")) };
}
const isReport = (c) => c[1] === API + MV.REPORT_ENDPOINT, isDelete = (c) => c[1] === API + MV.DELETE_ENDPOINT;

// 模組的逾時計時器是 unref 的(不讓它撐住 app 結束):測試要自己撐住事件迴圈,否則「卡住的請求」那一格會讓 node 靜靜地以 0 結束
const keepAlive = setInterval(() => {}, 1000);
let finished = false;
process.on("exit", () => { if (!finished) { console.log("FAIL  測試沒跑完就結束了"); process.exitCode = 1; } });
(async () => {
  // ---- 1. 旗標關 / 讀不到
  for (const [name, flag] of [["enabled false", { status: 200, body: { enabled: false } }], ["404(api 還沒部署)", { status: 404, body: {} }],
    ["500", { status: 500, body: {} }], ["enabled 是字串 \"true\"", { status: 200, body: { enabled: "true" } }],
    ["連不上(get 丟例外)", () => { throw new Error("ECONNRESET"); }], ["回應不是物件", null]]) {
    const m = mk({ flag });
    await m.h.tick(); m.tick(60000); const kicked = m.h.kick(); await m.h.closing();
    ok(`旗標${name} → 當關:零 POST(不上傳、不送 closing)、kick 不送`, m.posts().length === 0 && kicked === false, m.calls);
    ok(`…${name}:visible false(設定頁不出這一區)、不想送 closing`, m.h.state().visible === false && m.h.wantsClosing() === false);
  }
  { const m = mk(); await m.h.tick();
    ok("每一輪先讀旗標(GET /oauth/desktop/local/enabled,沒有憑證)", m.calls[0][0] === "GET" && m.calls[0][1] === API + "/oauth/desktop/local/enabled" && m.calls[0].length === 2); }
  { const m = mk({ flag: { status: 200, body: { enabled: false } } }); await m.h.tick(); await m.h.setOn(false);
    ok("旗標關又從沒傳過:關掉開關也不送任何請求", m.posts().length === 0, m.calls); }

  // ---- 2. 旗標開:上傳
  { const m = mk(); await m.h.tick(); const p = m.posts();
    ok("旗標開:一輪送一次上傳", p.length === 1 && isReport(p[0]), m.calls);
    const b = p[0][2];
    ok("body:兩顆憑證 + device + closing false + report + local_line", b.token === "acct-A" && b.app_secret === "appsec-A" && b.closing === false
      && b.local_line.state === "on" && Object.keys(b).sort().join() === "app_secret,closing,device,local_line,report,token");
    ok("device 是衍生的 32 位 hex,不是 install_id 原值", /^[0-9a-f]{32}$/.test(b.device) && b.device !== INSTALL && b.device === MV.deviceOf(INSTALL)
      && !JSON.stringify(b).includes(INSTALL));
    const r = b.report, blob = JSON.stringify(r);
    ok("只送允許清單的頂層鍵", Object.keys(r).every((k) => MV.ALLOWED_KEYS.includes(k)), Object.keys(r));
    ok("events / tg_* / strategy_kinds / president_local / resources / workspace_update / manager / platform 不出門",
      ["events", "tg_chat_ids", "tg_pair_gen", "strategy_kinds", "president_local", "resources", "workspace_update", "manager", "platform"].every((k) => !(k in r)));
    ok("daemon 只留 version 與監督者三個 bool(沒有 pid)", JSON.stringify(r.daemon) === JSON.stringify({ version: "2026-10-20-q", reconciler: { wanted: true, running: true, orphan: false } }));
    ok("本機路徑遮成 ~、網址參數遮掉、錯誤訊息裡的長亂碼遮掉", !blob.includes("/Users/wei") && !blob.includes("signature=") && !blob.includes("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")
      && r.account.venues.binance.error.msg.includes("~/Blave"), blob.slice(0, 300));
    ok("Windows 路徑也遮", MV.cleanReport({ halt: { reason: "C:\\Users\\Wei\\Blave\\state\\HALT" } }, "C:\\Users\\Wei").halt.reason === "~\\Blave\\state\\HALT");
    ok("不是自由文字的欄位不套長亂碼規則(策略名照送)", MV.cleanReport({ config: { amounts: { ["x".repeat(40)]: 1 } } }).config.amounts["x".repeat(40)] === 1);
    ok("上傳成功後記「傳過」(結束時才送 closing)", m.file().uploaded === true && m.h.wantsClosing() === true); }
  { const m = mk({ creds: null }); await m.h.tick();
    ok("沒登入:不上傳;設定頁 signedIn false", m.posts().length === 0 && m.h.state().signedIn === false); }
  { const m = mk({ creds: { token: "acct-A", appSecret: "" } }); await m.h.tick();
    ok("舊登入沒有 app_secret:不上傳", m.posts().length === 0); }
  { const m = mk(); const big = REPORT(); big.config.pad = "x".repeat(MV.REPORT_MAX_BYTES); m.setReport(big); await m.h.tick();
    ok("清過之後超過 64 KB:不送、寫一行 log(api 也會回 413 不存)", m.posts().length === 0 && m.logs.some((l) => l.includes("64 KB"))); }
  { const m = mk(); const big = REPORT(); big.events = [{ payload: { error: "x".repeat(200000) } }]; m.setReport(big); await m.h.tick();
    ok("被剝掉的欄位不算(events 再大也照送)", m.posts().filter(isReport).length === 1); }

  // ---- 3. 403 MOBILE_VIEW_OFF
  { const m = mk({ post: () => ({ status: 403, body: { error_code: "MOBILE_VIEW_OFF" } }) }); await m.h.tick();
    m.tick(60000); m.setReport(Object.assign(REPORT(), { halt: { halted: true } }));
    ok("上傳回 403 MOBILE_VIEW_OFF:當場當成關(visible false、kick 不再送)", m.h.state().visible === false && m.h.kick() === false && m.posts().length === 1); }

  // ---- kick(提早送)
  { const m = mk(); await m.h.tick(); m.tick(60000);
    ok("狀態沒有值得講的變動:不提早送", m.h.kick() === false && m.posts().length === 1);
    m.setReport(Object.assign(REPORT(), { halt: { halted: true } })); m.tick(-50000);
    ok("有變動但距上次不到 20 秒:不送", m.h.kick() === false);
    m.tick(50000); ok("有變動、過了 20 秒:提早送一次", m.h.kick() === true); await new Promise((r) => setImmediate(r));
    ok("…真的送出去了", m.posts().length === 2); }

  // ---- 4. 開關
  { const m = mk(); await m.h.tick(); const s = await m.h.setOn(false);
    ok("關掉:呼叫刪除(帶兩顆憑證 + device)", isDelete(m.posts()[1]) && m.posts()[1][2].device === MV.deviceOf(INSTALL) && m.posts()[1][2].app_secret === "appsec-A");
    ok("…刪成功:不是待刪、不想送 closing", s.on === false && s.pending === false && m.h.wantsClosing() === false);
    await m.h.tick(); ok("關掉之後不再上傳", m.posts().filter(isReport).length === 1); }
  { const m = mk(); await m.h.tick(); m.setPost((u) => (u.endsWith("/delete") ? { status: 503, body: {} } : { status: 200, body: { ok: true } }));
    const s = await m.h.setOn(false);
    ok("關掉當下刪不成:記待刪(設定頁「刪除沒成功」狀態)", s.pending === true && m.file().pending === true);
    await m.h.tick(); await m.h.tick();
    ok("待刪期間每一輪重送刪除、一次都不上傳", m.posts().filter(isDelete).length === 3 && m.posts().filter(isReport).length === 1);
    const back = await m.h.setOn(true);
    ok("待刪中又打開:先重送刪除;刪不成就還是不上傳", back.pending === true && m.posts().filter(isReport).length === 1 && m.posts().filter(isDelete).length === 4);
    m.setPost(() => ({ status: 200, body: { ok: true } }));
    await m.h.tick();
    const p = m.posts(); const iDel = p.map(isDelete).lastIndexOf(true), iUp = p.map(isReport).lastIndexOf(true);
    ok("連上之後:先刪成功、才上傳", iDel >= 0 && iUp > iDel && m.h.state().pending === false); }
  { const m = mk(); await m.h.tick(); await m.h.setOn(false); const n = m.posts().length; await m.h.setOn(true);
    ok("打開時立刻傳一份,不等下一個 2 分鐘", m.posts().length === n + 1 && isReport(m.posts()[n])); }
  { const m = mk(); await m.h.tick(); m.setPost((u) => (u.endsWith("/delete") ? { status: 401, body: {} } : { status: 200, body: {} }));
    const s = await m.h.setOn(false); ok("刪除回 401(憑證已失效):不留待刪(平台讀取會濾掉那台)", s.pending === false); }
  { const m = mk(); await m.h.tick(); m.setPost(() => { throw new Error("offline"); }); await m.h.setOn(false);
    const m2 = MV.createMobileView({ dir: m.dir, apiBase: API, home: HOME, installId: () => INSTALL, get: async () => ({ status: 200, body: { enabled: true } }),
      post: async () => ({ status: 200, body: {} }), getCreds: () => ({ token: "acct-A", appSecret: "appsec-A" }), status: () => null, line: () => null });
    ok("待刪記在檔裡:重開 app 也記得", m2.state().pending === true && m2.state().on === false); }

  // ---- 5. closing
  { const m = mk(); await m.h.tick(); await m.h.closing(); const c = m.posts()[1];
    ok("正常結束:送 closing true、report null", isReport(c) && c[2].closing === true && c[2].report === null); }
  { const m = mk(); await m.h.tick(); m.setPost(() => new Promise(() => {}));
    const t0 = Date.now(); const r = await m.h.closing(); const dt = Date.now() - t0;
    ok("closing 卡住:3 秒內放手、回 false,不卡結束流程", r === false && dt < MV.CLOSING_TIMEOUT_MS + 1500 && dt >= MV.CLOSING_TIMEOUT_MS - 50, dt); }
  { const m = mk(); await m.h.closing(); ok("沒傳過:不送 closing", m.posts().length === 0); }
  { const m = mk(); await m.h.tick(); await m.h.setOn(false); const n = m.posts().length; await m.h.closing(); ok("關掉了:不送 closing", m.posts().length === n); }
  ok("main.js 結束時:closing 跟收工一起等,而且只在 wantsClosing 時", /const closingMv = !quitting && typeof _mv !== "undefined" && !!_mv && _mv\.wantsClosing\(\);/.test(mainSrc) && /closingMv \? _mv\.closing\(\)\.catch/.test(mainSrc));

  // ---- 6. 登出 / 失敗不擋
  { const m = mk(); await m.h.tick(); await m.h.signOut();
    ok("登出:送刪除、清掉傳過 / 待刪", isDelete(m.posts()[1]) && m.file().uploaded === false && m.file().pending === false); }
  { const so = mainSrc.slice(mainSrc.indexOf("async function signOutBlave()"), mainSrc.indexOf("function postJSON("));
    ok("登出流程:先刪平台上這台的快照,再撤 token(撤了就刪不了)", so.indexOf("mobileView().signOut()") > 0 && so.indexOf("mobileView().signOut()") < so.indexOf("/oauth/desktop/revoke")); }
  { const m = mk({ post: () => { throw new Error("ECONNRESET"); } }); let threw = false;
    try { await m.h.tick(); } catch (_) { threw = true; }
    ok("上傳失敗:不丟例外、只寫一行 log", !threw && m.logs.some((l) => l.includes("upload failed"))); }
  { const m = mk(); m.setReport(null); const st = m.h; let threw = false; try { await st.tick(); } catch (_) { threw = true; }
    ok("狀態檔還沒寫出來:不送、不炸", !threw && m.posts().length === 0); }
  ok("mobileview.js 不碰 daemon、子行程、electron(上傳失敗不可能影響下單)", !/require\(["'](\.\/daemon|child_process|electron)/.test(mvSrc));

  // ---- 7. 憑證不出主行程
  { const m = mk(); await m.h.tick(); const s = m.h.state();
    ok("state() 只有 visible / on / pending / signedIn", Object.keys(s).sort().join() === "on,pending,signedIn,visible");
    ok("狀態檔只有三個布林,沒有憑證", Object.keys(m.file()).sort().join() === "on,pending,uploaded" && !JSON.stringify(m.file()).includes("acct-"));
    ok("log 不帶憑證", !m.logs.join("\n").includes("acct-A") && !m.logs.join("\n").includes("appsec-A")); }
  ok("IPC:mobile-view-state 回 state + 電腦名稱(沒有憑證),mobile-view-set 只收 boolean、旗標關不收",
    /const mobileViewState = \(\) => \(\{ \.\.\.mobileView\(\)\.state\(\), name: deviceLabel\(\) \}\);/.test(mainSrc)
    && /handle\("mobile-view-set", async \(e, on\) => \{\s*if \(typeof on !== "boolean" \|\| !mobileView\(\)\.isVisible\(\)\) return mobileViewState\(\);/.test(mainSrc)
    && preload.includes('mobileViewState: () => ipcRenderer.invoke("mobile-view-state")'));
  ok("電腦名稱跟登入時送給授權頁的同一個字串(同一支 deviceLabel)", mainSrc.includes("device_label: deviceLabel(),") && /function deviceLabel\(\) \{ try \{ return os\.hostname\(\)\.replace\(\/\\\.local\$\/, ""\)\.slice\(0, 64\)/.test(mainSrc));
  ok("埋點:真的切換了才送 mobile_view_on / off(白名單裡有)", /if \(was !== on\) tm\(\)\.track\("feature_used", \{ name: on \? "mobile_view_on" : "mobile_view_off" \}\);/.test(mainSrc)
    && /"mobile_view_on", "mobile_view_off"[,\]]/.test(fs.readFileSync(path.join(SHELL, "telemetry.js"), "utf8")));
  ok("設定頁:旗標關(visible 不是 true)整區不出;登出確認框那一句也只在開著時出",
    app.includes("const mvShown = () => !!(MV && MV.visible === true);") && /if \(!mvShown\(\)\) return null;/.test(app)
    && app.includes('const mvOn = typeof mvShown === "function" && mvShown() && MV.on === true;') && app.includes('mvOn ? [t("acct.out.5")] : []'));
  ok("第二份 app 不上傳(同一個裝置代號)", /if \(app\.hasSingleInstanceLock\(\)\) startStep\("mobile view", \(\) => mobileView\(\)\.start\(\)\);/.test(mainSrc));

  // ---- 9. 稽核 2026-10-20(e02b827c／2921be4)
  { // P2-1:關開關時有一筆上傳在路上 → 等它落地,最後一個送到 api 的是刪除
    const order = []; let release;
    const m = mk({ post: (u) => (u.endsWith("/delete") ? (order.push("delete"), { status: 200, body: {} })
      : new Promise((r) => { order.push("upload-sent"); release = () => { order.push("upload-landed"); r({ status: 200, body: { ok: true } }); }; })) });
    const tk = m.h.tick(); await new Promise((r) => setTimeout(r, 20));
    const off = m.h.setOn(false); await new Promise((r) => setTimeout(r, 20));
    ok("P2-1 上傳還在路上:刪除先不送", order.join() === "upload-sent", order);
    release(); await tk; const s = await off;
    ok("P2-1 上傳落地之後才送刪除(最後一個是刪除)、不留待刪", order.join() === "upload-sent,upload-landed,delete" && s.pending === false, order);
    await m.h.tick(); ok("P2-1 之後不再上傳", m.posts().filter(isReport).length === 1); }
  { // P2-1:上傳拿到 200 時開關已經關了(刪除送不出去)→ 記待刪、下一輪重送刪除
    let release; const m = mk({ post: (u) => (u.endsWith("/delete") ? { status: 503, body: {} }
      : new Promise((r) => { release = () => r({ status: 200, body: { ok: true } }); })) });
    const tk = m.h.tick(); await new Promise((r) => setTimeout(r, 20));
    const off = m.h.setOn(false); await new Promise((r) => setTimeout(r, 20)); release(); await tk; const s = await off;
    ok("P2-1 刪除送不出去:記待刪", s.pending === true && m.file().pending === true);
    m.setPost(() => ({ status: 200, body: {} })); await m.h.tick();
    ok("P2-1 下一輪重送刪除成功、沒有上傳", m.h.state().pending === false && isDelete(m.posts()[m.posts().length - 1])
      && m.posts().filter(isReport).length === 1); }
  { // P3-2:closing 先停計時器、上閂、等在途上傳;之後的一般上傳一律不送
    const order = []; let release;
    const m = mk({ post: (u, b) => (b.closing ? (order.push("closing"), { status: 200, body: {} })
      : new Promise((r) => { order.push("upload-sent"); release = () => { order.push("upload-landed"); r({ status: 200, body: {} }); }; })) });
    m.setPost((u, b) => (b.closing ? (order.push("closing"), { status: 200, body: {} }) : { status: 200, body: {} }));
    await m.h.tick();   // 先傳成功一次,才會想送 closing
    m.setPost((u, b) => (b.closing ? (order.push("closing"), { status: 200, body: {} })
      : new Promise((r) => { order.push("upload-sent"); release = () => { order.push("upload-landed"); r({ status: 200, body: {} }); }; })));
    m.tick(60000); m.setReport(Object.assign(REPORT(), { halt: { halted: true } })); m.h.kick();
    await new Promise((r) => setTimeout(r, 20));
    const c = m.h.closing(); await new Promise((r) => setTimeout(r, 50));
    ok("P3-2 closing 等在途那一筆", order.join() === "upload-sent", order);
    release(); const sent = await c;
    ok("P3-2 在途那一筆落地之後才送 closing", sent === true && order.join() === "upload-sent,upload-landed,closing", order);
    const n = m.posts().length; await m.h.tick(); m.tick(60000); m.setReport(REPORT()); const k = m.h.kick();
    ok("P3-2 closing 之後:tick / kick 都不再上傳,也不再想送 closing", m.posts().length === n && k === false && m.h.wantsClosing() === false); }
  { // P3-4:送出之後回應逾時(沒拿到 200)也算「可能傳過」:之後關開關照樣送刪除
    const m = mk({ post: (u) => (u.endsWith("/delete") ? { status: 200, body: {} } : null) });
    await m.h.tick();
    ok("P3-4 送出後沒有回應:記「可能傳過」", m.file().uploaded === true);
    ok("P3-4 …但這次啟動沒有一筆確定成功:結束時不送 closing", m.h.wantsClosing() === false);
    m.setFlag({ status: 200, body: { enabled: false } }); await m.h.tick(); await m.h.setOn(false);
    ok("P3-4 旗標後來關了、再關開關:照樣送刪除", m.posts().filter(isDelete).length === 1); }
  { // P3-1:長亂碼遮蔽不只認鍵名;沒有 scheme 的網址也遮
    const r = MV.cleanReport({ halt: { detail: "binance said: invalid key AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" },
      order_errors: [{ note: "ConnectionError with url: /fapi/v1/order?symbol=BTCUSDT&signature=" + "a".repeat(64) }],
      config: { amounts: { ["s".repeat(40)]: 1 } }, states: { x: { sig: "z".repeat(40) } } });
    ok("P3-1 不認得的鍵、帶空白的句子:長亂碼照樣遮", !JSON.stringify(r).includes("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789") && r.halt.detail.includes("…"));
    ok("P3-1 `with url: /path?…`(沒有 scheme)的 query 遮掉", !JSON.stringify(r).includes("signature=") && r.order_errors[0].note.includes("/fapi/v1/order?…"));
    ok("P3-1 不帶空白的代號 / 策略名不動", r.config.amounts["s".repeat(40)] === 1 && r.states.x.sig === "z".repeat(40)); }
  { // P3-1 列舉:真實形狀的狀態檔(tests/fixtures/local_status_sample.json,開發版三份)清過之後,每一個字串葉節點都不帶 32 字以上的亂碼。
    // reporter 新增了帶長代號的欄位會在這裡紅:看過它是不是祕密,再決定遮或不遮
    const sample = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "local_status_sample.json"), "utf8")), hits = [];
    const walk = (v, p) => { if (typeof v === "string") { if (/[A-Za-z0-9+/=_-]{32,}/.test(v)) hits.push(p); return; }
      if (Array.isArray(v)) { v.forEach((x) => walk(x, p + "[]")); return; } if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k], p + "." + k); };
    sample.forEach((rep) => walk(MV.cleanReport(rep, HOME), ""));
    ok("P3-1 列舉:fixture 三份、每個字串葉節點清過之後都沒有長亂碼", sample.length === 3 && hits.length === 0, hits.slice(0, 5));
    // 每個字串葉節點換成一句帶金鑰片段的例外原文,不管鍵名是什麼都要被遮
    const leaks = [];
    const poison = (v) => (typeof v === "string" ? "boom key AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 at /Users/wei/x" : Array.isArray(v) ? v.map(poison)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, poison(x)])) : v);
    sample.forEach((rep) => { const s = JSON.stringify(MV.cleanReport(poison(rep), HOME)); if (s.includes("AbCdEfGhIjKl") || s.includes("/Users/wei")) leaks.push(1); });
    ok("P3-1 列舉:每一個字串葉節點都換成例外原文,清過之後一個都沒漏", leaks.length === 0); }

  // ---- 8. 兩端允許清單
  const apiPy = path.join(process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), "openclaw", "desktop_portfolio.py");
  if (!fs.existsSync(apiPy)) console.log("SKIP  api 允許清單比對(需要 monorepo 版面:../api/openclaw/desktop_portfolio.py)");
  else {
    const py = fs.readFileSync(apiPy, "utf8"), blk = /ALLOWED_KEYS = \(([\s\S]*?)\)/.exec(py);
    const keys = blk ? [...blk[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];
    ok("允許清單 = api desktop_portfolio.ALLOWED_KEYS(逐項、同順序)", JSON.stringify(keys) === JSON.stringify(MV.ALLOWED_KEYS), keys);
    ok("上限 = api desktop_portfolio.MAX_BYTES / STORED_MAX_BYTES", /\nMAX_BYTES = 512 \* 1024/.test(py) && MV.MAX_BYTES === 512 * 1024
      && /\nSTORED_MAX_BYTES = 64 \* 1024/.test(py) && MV.REPORT_MAX_BYTES === 64 * 1024);
  }

  finished = true; clearInterval(keepAlive);
  console.log(red ? `\n${red} FAIL` : "\nall pass");
  process.exit(red ? 1 : 0);
})();
