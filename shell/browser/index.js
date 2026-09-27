// 電腦版內建瀏覽器(主行程):分頁(WebContentsView)、隔離 session、網路層政策、agent 工具、畫面事件、快照。
// 契約:.claude/output/specs/desktop-browser-agent-tools-2026-09-26.md(工具與安全)、
//       .claude/output/specs/desktop-browser-mcp-interface-2026-09-26.md(MCP 介面,凍結)、
//       .claude/output/designer/spec-desktop-browser-2026-09-26.md §7(畫面事件)。
// renderer 不持有任何頁面物件:只收 browser-event、只送 id 與 bounds。
"use strict";
const policy = require("./policy");
const gate = require("./gate");
const C = require("./content");
const { createTabs } = require("./tabs");
const { createPage } = require("./cdp");
const { createPace } = require("./pace");
const { createMcpServer } = require("./mcp");
const { createSnapshots } = require("./snapshots");
const { createCapture } = require("./capture");
const { TOOLS, INSTRUCTIONS } = require("./tools");
const IP = require("./inpage");

const PARTITION = "persist:agent-browser";
const LOAD_TIMEOUT_MS = 20000, WAIT_MAX_MS = 25000, AGENT_WINDOW_MS = 3000, SEARCH_LOAD_MS = 12000, CAPTCHA_WAIT_MS = 20000;
const THUMB_EVERY_MS = 2000, THUMB_W = 240;
const PARK_X = 20000;   // 不在畫面上的分頁停在視窗外(實測:沒掛上視窗的 view 拍不到縮圖,掛在視窗外可以)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * o: { electron: { WebContentsView, session, nativeImage }, stateDir, getWin(), uiLang(), openWeb(url), track(name),
 *      loadPrefs() → {enabled}, savePrefs(p), version, reducedMotion() }
 */
function createBrowser(o) {
  const E = o.electron;
  // 背景分頁一律用桌機視窗排版(agent 讀到桌機版內容、縮圖也是桌機版);只有顯示到中欄時才換成中欄大小
  let ses = null, win = null, cur = null, seq = 0;
  // OAuth 登入子視窗(白名單身分提供者的 window.open;細節與邊界見 oauth.js)
  const oauth = require("./oauth").createOauth({ electron: E, session: () => session(), getWin: () => o.getWin(), registrable: policy.registrable });
  let pendingOauth = null;   // setWindowOpenHandler 放行的那一個(did-create-window 接管時比對)
  // canon 第 4 條裁定:@eN ref 標籤對用戶不顯示(只留 1.5px 墨色目標 outline);
  // 標籤退到開發模式旗標——環境變數,預設關(除錯 agent 的元素定位時才開)
  const DEV_MARKS = process.env.BLAVE_BROWSER_DEV_MARKS === "1";
  const parkSize = { width: 1280, height: 800 };
  let expanded = null, blockVisible = false, thumbTimer = null;
  const views = new Map();          // tab id → { view, wc, page, loadTimer, lastReq, http }
  const wcTab = new Map();          // webContents id → tab id
  const agentUntil = new Map();     // webContents id → 時間戳:這之前的導覽/POST 算 agent 觸發
  const backstop = new Map();       // webContents id → { kind, detail }
  const snaps = createSnapshots(o.stateDir);
  let prefs = Object.assign({ enabled: true }, (o.loadPrefs && o.loadPrefs()) || {});
  let mcp = null;

  const tabs = createTabs({ create: createView, destroy: destroyView, emit: (type, p) => emit(type, p) });

  function emit(type, payload) {
    const w = win || (o.getWin && o.getWin());
    if (!w || w.isDestroyed()) return;
    const sid = payload && payload.session_id !== undefined ? payload.session_id : cur ? cur.sessionId : null;
    try { w.webContents.send("browser-event", Object.assign({ type, session_id: sid, turn: tabs.turn(), seq: ++seq }, payload || {})); } catch (_) { /* 視窗正在關 */ }
  }

  // ── session:獨立 partition,權限全拒,網路層政策,下載全擋 ──
  function session() {
    if (ses) return ses;
    ses = E.session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    for (const ev of ["select-hid-device", "select-serial-port", "select-usb-device"]) ses.on(ev, (e, _d, cb) => { e.preventDefault(); try { cb(ev === "select-serial-port" ? "" : null); } catch (_) { /* 版本差異 */ } });
    ses.on("will-download", (e, item, wc) => {
      e.preventDefault(); try { item.cancel(); } catch (_) { /* 已取消 */ }
      const id = wc && wcTab.get(wc.id);
      const name = C.scrub(item.getFilename ? item.getFilename() : "", 200);
      if (id) { emit("page_blocked", { id, kind: "download", detail: name }); if (wc && agentActive(wc.id)) backstop.set(wc.id, { kind: "download", detail: name }); }
    });
    ses.webRequest.onBeforeRequest((d, cb) => {
      const main = d.resourceType === "mainFrame";
      const frame = main || d.resourceType === "subFrame";
      const bad = policy.network(d.url, main ? "main" : "sub");
      const wcId = d.webContentsId, id = wcId !== undefined ? wcTab.get(wcId) : null;
      const blockPrivate = (host) => { if (main && id) emit("page_blocked", { id, kind: "scheme", reason: "private_address", like: null, detail: C.scrub(host || "", 200) }); cb({ cancel: true }); };
      if (bad) { if (main && id) emit("page_blocked", { id, kind: bad.reason === "ads" ? "domain" : "scheme", reason: bad.reason, like: bad.like || null, detail: C.scrub(bad.host || "", 200) }); return cb({ cancel: true }); }
      // 主機名不是 IP、但解析到內網(`192.168.1.1.nip.io`、指到 127.x 的公開網域):頁面層級的請求先解析一次再放行(複審 B-1)
      if (frame) {
        let host = ""; try { const u = new URL(d.url); if (u.protocol === "http:" || u.protocol === "https:") host = u.hostname; } catch (_) { /* 非 URL */ }
        if (host && !/^[\d.]+$/.test(host) && !host.includes(":")) {
          return dnsPrivate(host, d.url).then((priv) => (priv ? blockPrivate(host) : proceed()), () => proceed());
        }
      }
      return proceed();
      function proceed() {
      if (main && id && holdForConfirm(tabs.get(id), d.url)) { if (wcId !== undefined) backstop.set(wcId, { kind: "confirm" }); return cb({ cancel: true }); }
      if (id) {
        const v = views.get(id); if (v) v.lastReq = Date.now();
        // 後盾(spec §3.2 第 6 條):agent 動作後 3 秒內,同一分頁的文件層 POST 與 agent 不能去的網址由 cdp.guard(Fetch)以 Aborted 取消
        // (原頁不動)。webRequest 比 Fetch 先看到請求(實測),所以守門開著時這裡放行給它;守門沒開起來才在這裡取消
        // (會留一張錯誤頁,但不會送出去)。非文件請求(XHR / fetch)帶檔案上傳 Fetch 不管,一律在這裡擋。
        if (agentActive(wcId)) {
          if (!frame && (d.uploadData || []).some((u) => u && u.file)) { backstop.set(wcId, { kind: "file" }); return cb({ cancel: true }); }
          if (frame && !(v && v.page.guarded())) {
            if (d.method !== "GET" && d.method !== "HEAD") { backstop.set(wcId, { kind: "submit" }); return cb({ cancel: true }); }
            if (main) { const a = policy.agent(d.url); if (a) { backstop.set(wcId, { kind: "blocked", reason: a.reason, host: a.host }); return cb({ cancel: true }); } }
          }
        }
      }
      cb({});
      }
    });
    // 後盾(DNS rebinding:解析時是公網、連線時換成內網):頁面層級的回應真的來自內網位址 → 停掉、標成擋下
    ses.webRequest.onResponseStarted(async (d) => {
      if (d.resourceType !== "mainFrame" && d.resourceType !== "subFrame") return;
      if (!d.ip || !policy.resolvesPrivate([{ address: d.ip }])) return;
      let host = ""; try { host = new URL(d.url).hostname; } catch (_) { return; }
      if (policy.privateHost(host)) return;   // 網址本身就是內網位址的,前面 network() 已經擋了,不會走到這裡
      // 走代理時 d.ip 是代理本身(常常就是 127.0.0.1 的 Clash),不代表網站在內網
      try { if (typeof ses.resolveProxy === "function" && (await ses.resolveProxy(d.url)) !== "DIRECT") return; } catch (_) { return; }
      const id = d.webContentsId !== undefined ? wcTab.get(d.webContentsId) : null, v = id ? views.get(id) : null;
      if (v) { try { v.wc.stop(); v.wc.loadURL("about:blank"); } catch (_) { /* 已關 */ } if (d.resourceType === "mainFrame") emit("page_blocked", { id, kind: "scheme", reason: "private_address", like: null, detail: C.scrub(host, 200) }); }
      else if (d.webContentsId !== undefined && oauth.owns(d.webContentsId)) oauth.abortPrivate();   // 稽核 B-P2-2:OAuth 子視窗不在 wcTab,rebinding 後盾也要蓋到
    });
    return ses;
  }
  // 主機名 → 是否解析到內網,快取 60 秒(Chromium 自己也有 DNS 快取,這裡只省掉重複的 IPC)
  const dnsCache = new Map(), DNS_TTL_MS = 60000;
  // 走代理時(公司代理、本機的 Clash 等)瀏覽器自己不解析,本機的 DNS 答案不代表連到哪裡:不判;DNS 慢就放行(後盾還在)
  async function dnsPrivate(host, url) {
    const hit = dnsCache.get(host); if (hit && Date.now() - hit.at < DNS_TTL_MS) return hit.priv;
    if (!ses || typeof ses.resolveHost !== "function") return false;
    if (typeof ses.resolveProxy === "function" && (await ses.resolveProxy(url)) !== "DIRECT") return false;
    const r = await within(ses.resolveHost(host), 2000);
    const priv = policy.resolvesPrivate(r && r.endpoints);
    dnsCache.set(host, { priv, at: Date.now() }); if (dnsCache.size > 500) dnsCache.clear();
    return priv;
  }
  const agentActive = (wcId) => (agentUntil.get(wcId) || 0) > Date.now();
  // ── 外送檢查(複審 B-2):agent 的分頁要導去這一輪沒出現過的網域、網址又帶著長參數或讀過的字 → 先停,請用戶確認 ──
  const READ_TEXT_MAX = 200000;
  function seeHost(url) { if (!cur) return; try { cur.seen.add(policy.registrable(new URL(String(url)).hostname)); } catch (_) { /* 非網址 */ } }
  /** onBeforeRequest(頁面主框架)呼叫:回 true = 這一次導覽先擋下、改成請用戶確認 */
  function holdForConfirm(t, url) {
    if (!cur || !t || t.by !== "agent" || t.userControl) return false;
    if (t.allowOnce && t.allowOnce === url) { t.allowOnce = null; seeHost(url); return false; }
    const x = policy.exfilRisk(url, cur.seen, cur.readText);
    if (!x) { seeHost(url); return false; }
    t.heldUrl = url;
    needUser(t, "confirm", null, x.host, null, url);
    return true;
  }
  /** agent 動手前開守門。回 false = 守門開不起來,這個動作不做(寧可不動,不要沒有後盾地動)。 */
  async function markAgent(t) {
    const v = views.get(t.id); if (!v) return false;
    agentUntil.set(v.wc.id, Date.now() + AGENT_WINDOW_MS); backstop.delete(v.wc.id); v.agentInputAt = Date.now();
    const wcId = v.wc.id;
    return v.page.guard(AGENT_WINDOW_MS, (req) => {
      if (req.method !== "GET" && req.method !== "HEAD") { backstop.set(wcId, { kind: "submit" }); return false; }
      if (req.main) { const a = policy.agent(req.url); if (a) { backstop.set(wcId, { kind: "blocked", reason: a.reason, host: a.host }); return false; } }
      return true;
    }).then(() => true, () => false);
  }

  // ── 分頁的 view ──
  /* captureBeyondViewport 會暫時改掉頁面的 viewport;還原時偶爾停在錯的尺寸,之後這一頁就一直用那個窄寬度排版
     (實測:中欄 544 寬,頁面 innerWidth 卻是 240,排成手機版)。每次擷取後、每次放到中欄時都清一次 */
  function unEmulate(v) { v.parkEmu = false; v.emuGen = (v.emuGen || 0) + 1; try { v.wc.debugger.sendCommand("Emulation.clearDeviceMetricsOverride").catch(() => {}); } catch (_) { /* 沒掛 debugger */ } }
  /* parked 分頁常駐 1280×800 override:視窗外的 view 會被裁到 0 寬(實測 innerWidth = 0),
     頁面用 0 視口排版就出行動版(TradingView 連 Pine Editor 入口都沒有、SPA 路由也會壞)。
     設一次不再動,不會閃;進中欄時 bounds() 的 unEmulate 清掉、用真實大小。 */
  function parkEmulate(v) {
    if (v.parkEmu) return;   // 成功才設 flag(先設再清會跟 attach 之後的補設 race,補設看到 flag 提前 return)
    // 世代計數(稽核 A-P2-1):送出 override 後、promise 回來前用戶展開(unEmulate)→ resolve 不能
    // 把 flag 設回 true,不然 CDP 端是 clear、flag 卻是 true,之後每次 park 都提前 return
    const g = v.emuGen = (v.emuGen || 0) + 1;
    try { v.wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: parkSize.width, height: parkSize.height, deviceScaleFactor: 0, mobile: false }).then(() => { if (v.emuGen === g) v.parkEmu = true; }, () => { /* 還沒掛 debugger:下一次 park / attach 之後補設 */ }); }
    catch (_) { /* 同上 */ }
  }
  function park(v, i) { try { v.view.setBounds({ x: PARK_X + (i || 0) * (parkSize.width + 50), y: 0, width: parkSize.width, height: parkSize.height }); } catch (_) { /* 已銷毀 */ } parkEmulate(v); }
  function createView(t) {
    win = o.getWin(); if (!win || win.isDestroyed()) { tabs.failed(t.id, "network"); return; }
    const view = new E.WebContentsView({ webPreferences: {
      session: session(), sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false, disableDialogs: true, spellcheck: false,
      safeDialogs: true, devTools: false, navigateOnDragDrop: false, autoplayPolicy: "document-user-activation-required",
    } });
    const wc = view.webContents;
    const v = { view, wc, page: createPage(wc), pace: createPace(), loadTimer: null, lastReq: Date.now(), http: 0, agentInputAt: 0 };
    views.set(t.id, v); wcTab.set(wc.id, t.id);
    win.contentView.addChildView(view); park(v, views.size);
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(({ url }) => {
      // 稽核 S7:頁面自己開的 popup(不在 agent 動作窗口內、也不是用戶在操作)一律不開,不能拿來佔滿 8 格
      const by = agentActive(wc.id) ? "agent" : t.userControl ? "user" : null;
      // OAuth 例外(Wei 實測 Google 登入沒反應):白名單身分提供者放行成受控視窗(oauth.js,
      // allow 路線保住 window.opener/postMessage——GSI 型流程要;did-create-window 下面接管)。
      // 只認用戶手勢(稽核 B-P3):agent 的 3 秒窗不開——走到這裡的多半是頁面腳本趁窗口 window.open
      if (by === "user" && oauth.isIdp(url)) {
        const opts = oauth.allowOptions();
        if (opts) { pendingOauth = { url: String(url), opener: wc.getURL() || t.url }; return opts; }
        return { action: "deny" };   // 已有一個登入視窗:聚焦它,不疊第二個
      }
      // 其餘 popup 一律不開新視窗;過了網路層就在瀏覽器裡開一個新分頁(計入名額)
      if (!policy.network(url, "main")) {
        if (!by) return { action: "deny" };
        if (by === "agent" && policy.agent(url)) return { action: "deny" };
        let host = ""; try { host = policy.registrable(new URL(url).hostname); } catch (_) { return { action: "deny" }; }
        setImmediate(() => tabs.open(url, host, by));
      }
      return { action: "deny" };
    });
    wc.on("did-create-window", (childWin, details) => {
      // 只有上面 IdP 分支會 allow;保險:不是剛放行的那個就關掉
      if (pendingOauth && details && details.url === pendingOauth.url) { const po = pendingOauth; pendingOauth = null; oauth.adopt(childWin, po.url, po.opener); }
      else try { childWin.destroy(); } catch (_) { /* 已關 */ }
    });
    wc.on("will-attach-webview", (e) => e.preventDefault());
    wc.on("login", (e, _d, _a, cb) => { e.preventDefault(); cb(); });
    wc.on("select-bluetooth-device", (e, _l, cb) => { e.preventDefault(); cb(""); });
    wc.on("did-start-navigation", (d) => {
      if (!d.isMainFrame || d.isSameDocument) return;
      // 首次 park override 只能下在這裡:renderer 已經在了、文件還沒解析(createView 當下就下會
      // SIGSEGV——沒載過東西的 webContents 碰 emulation 會炸,實測;之後的 park() 再下都安全)
      if (!t.visible) parkEmulate(v);
      v.http = 0; t.snapshotId = null; t.read = false; t.thumbDone = false; t.thumbsAfterRead = 0;
      if (t.status === "ready") {   // 點連結 / 回上一頁 / 用戶在網址列換頁:回到載入中,逾時照 20 秒算
        t.status = "loading"; t.partial = false;
        if (v.loadTimer) clearTimeout(v.loadTimer);
        v.loadTimer = setTimeout(() => { v.loadTimer = null; if (t.status === "loading") { t.partial = true; tabs.loaded(t.id, C.scrub(wc.getTitle(), 300)); emit("page_loaded", { id: t.id, title: t.title, partial: true }); } }, LOAD_TIMEOUT_MS);
      }
    });
    wc.on("did-navigate", (_e, url, code) => { t.url = url; v.http = code || 0; emit("page_nav", { id: t.id, url: C.scrub(url, 2000), http: v.http }); });
    wc.on("page-favicon-updated", (_e, favs) => { fetchFavicon(t, v, favs).catch(() => {}); });
    wc.on("page-title-updated", (_e, title) => { t.title = C.scrub(title, 300); emit("page_title", { id: t.id, title: t.title }); });
    wc.on("did-stop-loading", () => {
      if (v.loadTimer) { clearTimeout(v.loadTimer); v.loadTimer = null; }
      if (wc.getURL()) t.hadDoc = true;
      if (t.status === "loading") { tabs.loaded(t.id, C.scrub(wc.getTitle(), 300)); emit("page_loaded", { id: t.id, title: t.title, url: C.scrub(wc.getURL(), 2000) }); }
      v.page.quiet().catch(() => {});
      fetchFavicon(t, v, []).catch(() => {});
    });
    wc.on("did-fail-load", (_e, code, _desc, url, isMain) => {
      if (!isMain || code === -3) return;                          // -3 = 被新的導覽取代
      if (code === -20 || code === -27) {                          // 我們自己取消的(網路層政策 / 後盾;已發 page_blocked 或由工具回報)
        if (v.loadTimer) { clearTimeout(v.loadTimer); v.loadTimer = null; }
        // 已經有一份文件(導覽被取消,原頁還在)→ 回到 ready;第一次載入就被擋 → 這一格是擋下頁
        if (t.status === "loading") { if (t.hadDoc || (t.need && t.need.kind === "confirm")) t.status = "ready"; else { t.status = "blocked"; t.reason = "policy"; } }
        return;
      }
      const reason = code === -105 || code === -137 ? "dns" : code === -7 || code === -118 ? "timeout" : "network";
      if (t.status === "loading" || t.status === "ready") { emit("page_fail", { id: t.id, reason }); tabs.failed(t.id, reason); }
    });
    wc.on("render-process-gone", () => { if (t.status === "loading" || t.status === "ready") { emit("page_fail", { id: t.id, reason: "network" }); tabs.failed(t.id, "network"); } });
    // 接手:用戶在展開的那一頁點或打字(agent 自己的輸入 300ms 內不算)
    wc.on("input-event", (_e, inp) => {
      if (v.agentInputting || Date.now() - v.agentInputAt < 600) return;
      if (inp.type !== "mouseMove") v.userInputAt = Date.now();   // 用戶 3 秒內碰過這一頁 → 讀取帶不跟著捲
      if (!t.visible || t.userControl) return;
      if (inp.type === "mouseDown" || inp.type === "rawKeyDown" || inp.type === "keyDown") takeover(t.id);
    });
    v.loadTimer = setTimeout(() => {
      v.loadTimer = null;
      if (t.status === "loading") { t.partial = true; tabs.loaded(t.id, C.scrub(wc.getTitle(), 300)); emit("page_loaded", { id: t.id, title: t.title, partial: true, url: C.scrub(wc.getURL(), 2000) }); }
    }, LOAD_TIMEOUT_MS);
    v.page.attach().catch(() => {});
    wc.loadURL(t.url).catch(() => { /* did-fail-load 會處理 */ });
  }
  function destroyView(t) {
    const v = views.get(t.id); if (!v) return;
    views.delete(t.id); wcTab.delete(v.wc.id); agentUntil.delete(v.wc.id); backstop.delete(v.wc.id);
    if (v.loadTimer) clearTimeout(v.loadTimer);
    if (expanded === t.id) expanded = null;
    v.page.detach();
    try { if (win && !win.isDestroyed()) win.contentView.removeChildView(v.view); } catch (_) { /* 已移除 */ }
    try { v.wc.close(); } catch (_) { /* 已關 */ }
    if (t.status === "discarded") emit("page_discarded", { id: t.id, snapshot_id: t.snapshotId || null });
  }

  // ── 接手 / 交還 / 請求卡 ──
  function takeover(id) {
    const t = tabs.get(id); if (!t || t.userControl) return;
    t.userControl = true; emit("user_takeover", { id });
    const v = views.get(id); if (v) v.page.run(IP.mark, ["clear"]).catch(() => {});
  }
  function handback(id) {
    const t = tabs.get(id); if (!t) return;
    t.userControl = false;
    if (t.need) { t.userDone = "done"; t.need = null; }
    emit("handback", { id });
  }
  function needUser(t, kind, ref, summary, box, url) {
    t.need = { kind, ref: ref || null, summary: summary || "" }; t.userDone = null;
    // url:確認網址那一態要顯示的是「被擋下的那個網址」,不是分頁現在的頁(用戶要看的就是它帶了什麼)
    emit("need_user", Object.assign({ id: t.id, kind, target_ref: ref || null, summary: C.scrub(summary || "", 300) }, url ? { url: C.scrub(url, 2000) } : {}));
    const v = views.get(t.id);
    if (v && box) v.page.run(IP.mark, ["need", { box, label: o.uiLang() === "zh" ? "由你按" : "Your turn" }]).catch(() => {});
  }

  // ── 縮圖(只在聊天區塊看得到時拍;每 2 秒一輪)──
  function thumbs() {
    if (thumbTimer || !blockVisible) return;
    thumbTimer = setInterval(async () => {
      if (!blockVisible) { clearInterval(thumbTimer); thumbTimer = null; return; }
      for (const [id] of views) {
        const t = tabs.get(id); if (!t || t.status !== "loading" && t.status !== "ready") continue;
        if (t.read && t.thumbDone) continue;   // 讀完、而且之後沒再動過的頁不再拍
        await captureThumb(id);
      }
    }, THUMB_EVERY_MS);
  }
  async function captureThumb(id) {
    const t = tabs.get(id), v = views.get(id); if (!t || !v) return;
    t.thumbAt = Date.now();
    // 縮圖走 CDP Page.captureScreenshot:分頁停在視窗外、或視窗被別的 app 蓋住時,capturePage 回空圖 / UnknownVizError(實測),
    // CDP 仍拍得到。直接在 CDP 端縮到縮圖寬,不經過全尺寸 PNG。拍不到再退 capturePage。
    try {
      const data = await withoutMarks(v, async () => {
        try {
          const m = await within(v.wc.debugger.sendCommand("Page.getLayoutMetrics"), 2000);
          const vp = m.cssLayoutViewport || m.layoutViewport || { clientWidth: 1280, clientHeight: 800 };
          const w = Math.max(1, vp.clientWidth), h = Math.max(1, vp.clientHeight);
          const r = await within(v.wc.debugger.sendCommand("Page.captureScreenshot", { format: "jpeg", quality: 60, clip: { x: vp.pageX || 0, y: vp.pageY || 0, width: w, height: h, scale: THUMB_W / w } }), 3000);
          if (r && r.data) return r.data;
        } catch (_) { /* 退 capturePage */ }
        const img = await within(v.wc.capturePage(undefined, { stayHidden: true }), 3000);
        return img.isEmpty() ? null : img.resize({ width: THUMB_W }).toJPEG(60).toString("base64");
      });
      if (!data) return;
      emit("thumb", { id, dataURI: data });
      // 讀完之後再多拍兩輪才停:讀取常在頁面第一次畫完之前就結束,只拍一張會停在空白畫面(實測)
      if (t.read && (t.thumbsAfterRead = (t.thumbsAfterRead || 0) + 1) >= 3) t.thumbDone = true;
    } catch (_) { /* 還沒畫出來 */ }
  }
  /* 每個動作或讀取之後補拍一張(同一分頁至少隔 500ms),而且重新開始拍——讀過的頁之後又被點、被捲,縮圖不能凍在舊畫面 */
  function bumpThumb(t) {
    t.thumbDone = false; t.thumbsAfterRead = 0;
    if (!blockVisible || t.thumbPending) return;
    const wait = Math.max(0, 500 - (Date.now() - (t.thumbAt || 0)));
    t.thumbPending = true;
    setTimeout(() => { t.thumbPending = false; captureThumb(t.id); }, wait + 120);
  }
  /* agent 為了「讓用戶看得到」多等的時間:只花在展開在看的那一頁,每輪累計 3 秒封頂,超過就改瞬間模式 */
  const EXTRA_WAIT_MS = 3000;
  function spend(t, ms) {
    if (!cur || !t.visible || (o.reducedMotion && o.reducedMotion())) return false;
    if ((cur.extra || 0) + ms > EXTRA_WAIT_MS) return false;
    cur.extra = (cur.extra || 0) + ms; return true;
  }
  function viewSize(v) { try { const b = v.view.getBounds(); return { vw: b.width, vh: b.height }; } catch (_) { return { vw: 1280, vh: 800 }; } }

  // ── 工具 ──
  const R = (obj, isError) => ({ content: [{ type: "text", text: JSON.stringify(obj) }], isError: !!isError });
  const ERR = (error, message, extra) => R(Object.assign({ ok: false, error, message }, extra || {}), error !== "needs_user" && error !== "still_waiting");
  const MSG = {
    not_found: "no such tab in this turn; call browser_tabs",
    user_in_control: "the user is operating this tab; wait for them to hand it back or work on another tab",
    stale_ref: "the ref is out of date; call browser_snapshot again",
    obscured: "the element is covered by another element (often a cookie banner or popup); close that first",
    browser_off: "the user turned the built-in browser off",
    confirm_url: "this address goes to a site not seen in this turn and carries a long query or text read from a page; the user must confirm it before it opens. Tell them what the link is for, then browser_wait until=user_done",
  };
  const blockedMsg = (r) => ({ sensitive_domain: "exchange/broker account areas, banks and payment pages are off limits to the agent", blocklist: "this site is on the harmful-site list", blave: "use lib/data.py for Blave data instead of the Blave website", private_address: "local and private network addresses are blocked", scheme: "only http(s) pages can be opened", port: "only ports 80/443 are allowed", credentials_in_url: "URLs with credentials are blocked", ads: "ad/tracking domains are blocked", lookalike: "this address imitates a protected site (possible phishing)", oauth: "sign-in and app-authorization pages are for the user to handle" }[r] || "blocked by policy");

  /** 搜尋引擎的結果頁只能經 browser_search 開(它才有 Google 每分鐘 4 次的速率、驗證頁處理與退路) */
  function searchUrl(raw) {
    let u; try { u = new URL(String(raw || "")); } catch (_) { return false; }
    const h = u.hostname.toLowerCase();
    return (/(^|\.)google\.[a-z.]+$/.test(h) && /^\/(search|webhp)/.test(u.pathname)) || /(^|\.)duckduckgo\.com$/.test(h) || (/(^|\.)bing\.com$/.test(h) && u.pathname.startsWith("/search"));
  }
  function tabFor(alias) {
    const t = tabs.byAlias(alias);
    if (!t) return { e: ERR("not_found", MSG.not_found) };
    if (t.userControl) return { e: ERR("user_in_control", MSG.user_in_control, { tab: t.alias }) };
    if (t.status === "blocked") return { e: ERR("blocked_policy", blockedMsg(t.reason), { tab: t.alias, reason: t.reason }) };
    if (t.status === "failed") return { e: ERR("load_failed", "the page could not be opened", { tab: t.alias, reason: t.reason }) };
    if (t.status === "discarded" || t.status === "queued") return { e: ERR("not_found", t.status === "queued" ? "the tab is still queued; call browser_wait" : "the tab was closed to free memory; open the URL again", { tab: t.alias }) };
    const v = views.get(t.id); if (!v) return { e: ERR("not_found", MSG.not_found) };
    const a = policy.agent(v.wc.getURL() || t.url);
    if (a) return { e: ERR("blocked_policy", blockedMsg(a.reason), { tab: t.alias, reason: a.reason, host: a.host }) };
    return { t, v };
  }
  function firstUse() {
    if (cur && !cur.used) { cur.used = true; cur.usedAt = Date.now(); emit("block_open", { anchor: "turn" }); if (o.track) o.track("browser_agent"); }
  }
  function openUrl(url, by) {
    let u; try { u = new URL(String(url || "").slice(0, 2000)); } catch (_) { return { error: "invalid_args" }; }
    const a = by === "agent" ? policy.agent(u.href) : policy.network(u.href, "main");
    const host = policy.registrable(u.hostname);
    if (a) {
      const t = tabs.addBlocked(u.href, host, by, a.reason);
      emit("page_blocked", { id: t.id, kind: ["private_address", "scheme", "port", "credentials_in_url", "lookalike"].includes(a.reason) ? "scheme" : "domain", reason: a.reason, like: a.like || null, detail: C.scrub(u.hostname, 200) });
      return { tab: t, blocked: a };
    }
    const r = tabs.open(u.href, host, by);
    return r.error ? r : { tab: r.tab };
  }
  async function settle(v, ms) {
    await sleep(ms || 700);
    const b = backstop.get(v.wc.id); if (b) backstop.delete(v.wc.id);
    return b || null;
  }
  async function afterAction(t, v, before) {
    const b = await settle(v);
    if (b) {
      if (b.kind === "blocked") return ERR("blocked_policy", blockedMsg(b.reason), { tab: t.alias, reason: b.reason, host: b.host });
      if (b.kind === "download") return ERR("download_blocked", "downloads are blocked; tell the user the file name if they want it", { filename: b.detail || "" });
      if (b.kind === "confirm") return ERR("needs_user", MSG.confirm_url, { kind: "confirm", tab: t.alias });
      needUser(t, b.kind === "file" ? "file" : "submit", null, b.kind === "file" ? "upload" : "form submission");
      return ERR("needs_user", "this action submits data; the user must do it themselves. Explain what you prepared and wait with browser_wait until=user_done", { kind: b.kind === "file" ? "file" : "submit", tab: t.alias });
    }
    const url = v.wc.getURL();
    // 稽核 S5b:動作後以「當下」網址重判——SPA pushState 進後台、bfcache 回到後台都沒有網路請求,只有這裡接得到
    const now = policy.agent(url);
    if (now) return ERR("blocked_policy", blockedMsg(now.reason), { tab: t.alias, reason: now.reason, host: now.host });
    let snap = null; try { const s = await v.page.snapshot({ interactive_only: true }, gate.sensitiveField); snap = s.text ? s.text.slice(0, 4000) : ""; } catch (_) { /* 還在載 */ }
    return R(C.envelope(url, v.wc.getTitle(), snap || "", { tab: t.alias, url: C.scrub(url, 2000), navigated: url !== before }));
  }
  async function waitLoaded(t, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (t.status !== "loading" && t.status !== "queued") return; await sleep(200); }
  }
  function status(t) {
    if (t.userControl) return "user_control";
    if (t.need && !t.userDone) return "needs_user";
    return { loading: "loading", queued: "queued", ready: "ready", failed: "failed", blocked: "blocked", discarded: "ready", closed: "failed" }[t.status] || t.status;
  }
  // 稽核 S9:用戶接手中、或當下網址被政策擋的分頁,只回主機名、不回標題
  const tabInfo = (t) => {
    const v = views.get(t.id), url = v ? v.wc.getURL() || t.url : t.url;
    const hide = t.userControl || !!policy.agent(url);
    let host = ""; try { host = new URL(url).hostname; } catch (_) { /* 不是網址 */ }
    return { tab: t.alias, status: status(t), url: hide ? host : C.scrub(url, 2000), title: hide ? "" : C.scrub(t.title, 300), partial: !!t.partial, http_status: v && v.http >= 400 ? v.http : undefined, reason: t.reason || undefined };
  };

  async function doSearch(args) {
    const query = String(args.query || "").trim().slice(0, 500);
    if (!query) return ERR("invalid_args", "query is required");
    const count = Math.max(1, Math.min(10, Math.floor(Number(args.count) || 5)));
    let engine = cur.skipGoogle ? "ddg" : "google", fallback = cur.skipGoogle ? "captcha_twice" : null;
    const lim = tabs.search(engine);
    if (lim && lim.scope === "turn") return ERR("rate_limited", "search limit for this turn reached", { retry_in_s: 0 });
    if (lim) { engine = "ddg"; fallback = "google_rate"; tabs.search("ddg"); }
    const hl = o.uiLang() === "zh" ? "zh-TW" : "en";
    const urlFor = (e) => e === "google" ? "https://www.google.com/search?hl=" + hl + "&num=" + Math.min(10, count + 3) + "&q=" + encodeURIComponent(query) : "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
    const r = openUrl(urlFor(engine), "agent");
    if (r.error) return ERR(r.error, "search could not open a tab", { retry_in_s: r.retry_in_s });
    let t = r.tab;
    await waitLoaded(t, SEARCH_LOAD_MS);
    let raw = null;
    for (let round = 0; round < 3; round++) {
      const v = views.get(t.id);
      if (!v || t.status === "failed" || t.status === "blocked") { raw = null; break; }
      try { raw = await v.page.serp(engine); } catch (_) { raw = null; }
      if (raw && engine === "google" && raw.consent) {
        // 同意頁:只按「全部拒絕」(spec §3.2 允許的 cookie 橫幅動作);找不到 → 交給用戶
        const ok = await v.page.run(function () { const b = Array.from(document.querySelectorAll("button,input[type=submit]")).find((x) => /reject all|全部拒絕|全部拒绝|alle ablehnen|tout refuser/i.test(x.innerText || x.value || "")); if (!b) return false; b.click(); return true; }).catch(() => false);
        if (ok) { t.status = "loading"; await sleep(500); await waitLoaded(t, SEARCH_LOAD_MS); t.status = "ready"; continue; }
      }
      if (raw && raw.captcha) {
        if (engine === "google") { cur.captchas = (cur.captchas || 0) + 1; if (cur.captchas >= 2) cur.skipGoogle = true; }
        needUser(t, "captcha", null, engine === "google" ? "Google" : "DuckDuckGo");
        const end = Date.now() + CAPTCHA_WAIT_MS;
        while (Date.now() < end && !t.userDone) await sleep(250);
        // 稽核 B3:逾時只收掉請求卡;用戶若已經在那一格操作,接手狀態留給他自己交還
        const choice = t.userDone; t.need = null; t.userDone = null;
        emit("need_clear", { id: t.id });
        if (choice === "done") { await waitLoaded(t, SEARCH_LOAD_MS); continue; }
        if (engine === "google") {
          engine = "ddg"; fallback = cur.skipGoogle ? "captcha_twice" : "captcha";
          if (t.userControl) {   // 那一格是用戶的了:退路另開一格,不動他正在操作的頁
            const r2 = openUrl(urlFor("ddg"), "agent"); if (r2.error || r2.blocked) { raw = null; break; }
            t = r2.tab;
          } else { t.status = "loading"; v.wc.loadURL(urlFor("ddg")).catch(() => {}); }
          await waitLoaded(t, SEARCH_LOAD_MS); continue;
        }
        raw = null; break;
      }
      if (raw && engine === "google") await resolveGoto(raw.items, count);   // 只解要回的那幾筆:每一筆都是一次 google.com 請求
      const res = C.normalizeSerp(raw, count);
      if (!res.length && engine === "google") { engine = "ddg"; fallback = "parse_failed"; t.status = "loading"; v.wc.loadURL(urlFor("ddg")).catch(() => {}); await waitLoaded(t, SEARCH_LOAD_MS); continue; }
      tabs.markRead(t.id); t.isSearch = true;
      emit("search", { id: t.id, source: engine, results: res.map((x) => ({ rank: x.rank, title: C.scrub(x.title, 300), url: C.scrub(x.url, 2000) })) });
      for (const x of res) seeHost(x.url);   // 搜尋結果裡的網站算這一輪出現過
      emit("page_done", { id: t.id, snapshot_id: null });
      return R(C.envelope(v.wc.getURL(), v.wc.getTitle(), { results: res }, { source: engine, tab: t.alias, fallback_reason: fallback }));
    }
    return ERR("search_unavailable", "web search is not available right now (Google and DuckDuckGo both failed or asked for a robot check)");
  }

  /* Google 結果連結現在是不透明的 /goto?url=…(真網址不在 DOM 裡,只有 cite 的主機名)。用同一個 session 問一次它的轉址目標,
     不跟過去(redirect: manual,拿到 Location 就中止)——結果清單回真網址,agent 開的時候照樣過網址政策。問不到的那筆丟掉。 */
  function resolveGoto(items, max) {
    const gotoRe = /^https:\/\/www\.google\.[a-z.]+\/goto\?/;
    const one = (it) => new Promise((resolve) => {
      let done = false; const fin = (u) => { if (!done) { done = true; resolve(u); } };
      try {
        const rq = E.net.request({ url: it.href, session: session(), redirect: "manual" });
        rq.on("redirect", (_st, _m, url) => { fin(url); try { rq.abort(); } catch (_) { /* 已結束 */ } });
        rq.on("response", () => fin(null)); rq.on("error", () => fin(null));
        rq.end(); setTimeout(() => { fin(null); try { rq.abort(); } catch (_) { /* 已結束 */ } }, 5000);
      } catch (_) { fin(null); }
    }).then((u) => { it.href = u || ""; });
    return Promise.all(items.filter((it) => !it.ad && gotoRe.test(it.href)).slice(0, max).map(one)).then(() => {
      for (const it of items) if (gotoRe.test(it.href)) it.href = "";
    });
  }

  async function doWait(args) {
    const ids = Array.isArray(args.tabs) ? args.tabs : args.tab ? [args.tab] : tabs.thisTurn().map((t) => t.alias);
    const list = ids.map((a) => tabs.byAlias(a)).filter(Boolean);
    if (!list.length) return ERR("not_found", MSG.not_found);
    const until = args.until || "load";
    const ms = Math.min(WAIT_MAX_MS, Math.max(1000, (Number(args.timeout_s) || 20) * 1000));
    if (until === "ms") { await sleep(Math.min(WAIT_MAX_MS, Math.max(0, Number(args.value) || 1000))); return R({ ok: true, tabs: list.map(tabInfo) }); }
    const end = Date.now() + ms;
    const done = async (t) => {
      if (t.userControl) return until !== "user_done" ? true : false;
      if (until === "user_done") return !t.need || !!t.userDone;
      if (t.status === "loading" || t.status === "queued") return false;
      if (t.status !== "ready") return true;
      if (until === "networkidle") { const v = views.get(t.id); return !v || Date.now() - v.lastReq > 500; }
      if (until === "text") {
        const v = views.get(t.id);
        if (!v || policy.agent(v.wc.getURL())) return true;   // 被擋的頁不拿來逐字試探(稽核 S5b)
        try { return await v.page.hasText(String(args.value || "")); } catch (_) { return false; }
      }
      return true;
    };
    while (Date.now() < end) {
      let all = true; for (const t of list) if (!(await done(t))) { all = false; break; }
      if (all) {
        const out = list.map(tabInfo);
        for (const t of list) if (until === "user_done" && t.userDone) { if (t.userDone === "skip") out.find((x) => x.tab === t.alias).status = "skipped"; t.userDone = null; t.need = null; }
        return R({ ok: true, tabs: out });
      }
      await sleep(250);
    }
    return ERR("still_waiting", "not done yet; call browser_wait again", { tabs: list.map(tabInfo) });
  }

  async function doRead(t, v, args) {
    let ex; try { ex = await v.page.extract(); } catch (_) { return ERR("load_failed", "could not read the page", { tab: t.alias, reason: "network" }); }
    const r = C.readPart(ex, args, (n) => tabs.readBudget(n));
    if (cur && r && typeof r.content === "string") cur.readText = (cur.readText + "\n" + r.content).slice(-READ_TEXT_MAX);
    if (r.error) return ERR(r.error, r.message, { tab: t.alias });
    const part = args.part || "full";
    const reduced = o.reducedMotion ? o.reducedMotion() : false;
    if (part === "full" || part === "section") {
      // 讀取計數用區塊數(不是字元數);讀取帶只畫這一次真的讀進來的那幾塊,依文件順序重播,不讓 agent 等
      const [s0, s1] = r.span || [0, 0], blocks = ex.blocks || [];
      const read = blocks.filter((b) => b.end > s0 && b.at < s1), last = read[read.length - 1];
      const n = blocks.filter((b) => b.at < s1).length;
      const pos = last && ex.view ? Math.min(1, Math.max(0, (last.top - ex.view.sy) / Math.max(1, ex.view.vh))) : null;
      emit("page_progress", { id: t.id, n, total: blocks.length, pos });
      if (t.visible && read.length) {
        // 密集判定(pace.js;canon 第 9 條):讀也算動作。密集=讀取帶不掃動直接落定(per 0)、不跟著捲
        const pace = v.pace.arrive();
        if (pace.cut) v.page.run(IP.mark, ["settle"]).catch(() => {});
        const inst = pace.mode === "instant";
        const per = inst ? 0 : Math.min(240, Math.floor(1600 / read.length));
        const follow = !reduced && !inst && Date.now() - (v.userInputAt || 0) > 3000;
        v.page.run(IP.mark, ["read", { rects: read.map((b) => ({ top: b.top, h: b.h, left: b.left, w: b.w })), per, follow }, reduced]).catch(() => {});
        // 「結束」=帶落定;瞬間/減少動態=事件當下就算落定
        if (inst || reduced || !per) v.pace.end();
        else setTimeout(() => v.pace.end(), Math.min(1600, read.length * per) + 60);
      }
      const line = ex.meta.description || (ex.headings[0] && ex.headings[0].text) || ex.meta.title;
      if (line) emit("page_extract", { id: t.id, line: C.scrub(line, 140) });
    } else if (part === "outline") {
      emit("page_act", { id: t.id, kind: "outline" });
      if (t.visible) v.page.run(IP.mark, ["frames", { rects: (ex.headings || []).map((h) => h.r).filter(Boolean), stagger: 60, hold: 600 }, reduced]).catch(() => {});
    } else if (part === "links") {
      emit("page_act", { id: t.id, kind: "links" });
      if (t.visible) v.page.run(IP.mark, ["frames", { rects: ex.linkRects || [], stagger: 0, hold: 600 }, reduced]).catch(() => {});
    } else if (part === "meta") emit("page_act", { id: t.id, kind: "meta" });
    bumpThumb(t);
    await noteRead(t, v, ex);
    return R(C.envelope(v.wc.getURL(), ex.meta.title || v.wc.getTitle(), r.content, { tab: t.alias, part, next_offset: r.next_offset === undefined ? undefined : r.next_offset, total_chars: r.total_chars }));
  }
  // 任何一種 browser_read(與 browser_capture:引用圖的出處頁)都算「讀了」:存快照、進這一輪的來源清單——摘要列的「讀了 N 頁」就是數這份清單(renderer brTakeSources)
  async function noteRead(t, v, ex) {
    if (!t.snapshotId) await saveSnapshot(t, v, ex);
    const relay = C.isRelay(ex, v.wc.getTitle());   // 只停在中繼頁:不進來源、不算讀過(回合紀錄也不記 done)
    if (!relay) t.readEver = true;   // 讀過就算,之後這一格再導覽也不收回
    if (cur && !relay && t.snapshotId && !cur.sources.some((x) => x.snapshot_id === t.snapshotId)) {
      const src = { id: t.id, url: C.scrub(v.wc.getURL(), 2000), title: C.scrub(ex.meta.title || v.wc.getTitle(), 300), snapshot_id: t.snapshotId };
      const same = cur.sources.findIndex((x) => x.url === src.url); if (same >= 0) cur.sources[same] = src; else cur.sources.push(src);
    }
    tabs.markRead(t.id);
    emit("page_done", Object.assign({ id: t.id, snapshot_id: t.snapshotId || null, read: true }, relay ? { relay: true } : {}));
  }

  // 報告引用圖(browser_capture):流程在 capture.js
  const doCapture = createCapture({
    nativeImage: E.nativeImage, reportsDir: o.reportsDir, getWin: () => o.getWin && o.getWin(), uiLang: () => o.uiLang(), reducedMotion: () => (o.reducedMotion ? o.reducedMotion() : false),
    ERR, R, MSG, blockedMsg, emit, viewSize, withMask, noteRead, cur: () => cur, expanded: () => expanded,
  }).doCapture;
  // 截圖一律 best-effort:拍不到就只留文字,絕不擋工具結果(分級與網域規則才是不能壞的)
  const within = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error("timeout"); })]);
  /* 稽核 S2:截圖前把有值的敏感欄位(同 fill 拒填那份判定)與金流商 iframe 蓋掉,拍完拿掉。
     列不出欄位、或蓋掉的數量對不上 → 回 null,呼叫端不拍。 */
  const PAY_IFRAME_RE = "(^|\\.)(stripe\\.com|stripe\\.network|paypal\\.com|paypalobjects\\.com|braintreegateway\\.com|braintree-api\\.com|adyen\\.com|checkout\\.com|ecpay\\.com\\.tw|newebpay\\.com|tappaysdk\\.com|squareup\\.com|klarna\\.com)$";
  let lastMasked = -1;   // 測試看得到這一次蓋了幾格
  async function withoutMarks(v, fn, force) {
    // 展開在中欄的那頁不做藏/放:每次擷取(縮圖 2 秒一輪+每動作補拍)都把即時頁上的游標/外框層
    // 藏了又放,就是「開著瀏覽器畫面閃來閃去」的來源(量測:操作 8 秒 marks 層翻動 18 次;
    // view bounds 與頁面 resize 都是 0)。代價:這頁操作中的縮圖/快照帶著標記層——縮圖上本來
    // 就有 app 自畫的游標層,回合結束的整頁升級多半已 park、照樣拍乾淨版
    const live = !force && wcTab.get(v.wc.id) === expanded;   // force(回合結束整頁升級,一次性)照藏:快照別把標記烤進去(稽核 A-P2-2)
    if (!live) await v.page.run(IP.marksVisible, [false]).catch(() => {});
    try { return await fn(); } finally { if (!live) await v.page.run(IP.marksVisible, [true]).catch(() => {}); }
  }
  async function withMask(v, fn, force) {
    let list; try { list = await v.page.run(IP.fieldCandidates); } catch (_) { return null; }
    const idx = (list || []).filter((d) => gate.sensitiveField(d)).map((d) => d.i);
    let n; try { n = await v.page.run(IP.maskFields, [idx, PAY_IFRAME_RE]); } catch (_) { return null; }
    lastMasked = n;
    try {
      if (n !== idx.length) return null;
      return await withoutMarks(v, fn, force);
    } finally { await v.page.run(IP.unmaskFields).catch(() => {}); }
  }
  async function saveSnapshot(t, v, ex) {
    if (!cur) return;
    const image = await withMask(v, () => captureSnapshotImage(v));
    t.snapshotId = snaps.save(cur.sessionId, { url: v.wc.getURL(), title: ex.meta.title || v.wc.getTitle(), markdown: ex.markdown, image, turn: cur.turnKey });
  }
  async function captureSnapshotImage(v, full) {
    // 操作中(browser_read 存快照)只拍當下視口:captureBeyondViewport 會動 viewport、整頁 reflow,
    // agent 打字點擊時高頻觸發就是畫面一直閃的原因(Wei 實測 TradingView)。整頁版只在回合結束升級一次。
    if (!full) {
      try { const shot = await within(v.wc.debugger.sendCommand("Page.captureScreenshot", { format: "webp", quality: 70 }), 5000); return { data: Buffer.from(shot.data, "base64"), ext: "webp" }; }
      catch (_) { return null; }
    }
    let image = null;
    try {
      const shot = await within(v.wc.debugger.sendCommand("Page.captureScreenshot", { format: "webp", quality: 70, captureBeyondViewport: true, clip: await fullClip(v) }), 8000);
      image = { data: Buffer.from(shot.data, "base64"), ext: "webp" };
    } catch (_) {
      try { const shot = await within(v.wc.debugger.sendCommand("Page.captureScreenshot", { format: "webp", quality: 70 }), 5000); image = { data: Buffer.from(shot.data, "base64"), ext: "webp" }; }
      catch (_e) { /* 只留文字 */ }
    } finally {
      unEmulate(v);   // 全頁擷取逾時或拋錯時一樣要清:它可能已經把 viewport 改掉了(複審 P2-6)
    }
    return image;
  }
  async function fullClip(v) {
    const m = await within(v.wc.debugger.sendCommand("Page.getLayoutMetrics"), 5000);
    const cs = m.cssContentSize || m.contentSize;
    return { x: 0, y: 0, width: Math.min(cs.width, 1600), height: Math.min(cs.height, 12000), scale: 1 };
  }

  async function doAct(name, t, v, args) {
    const w = tabs.action(); if (w) return ERR("rate_limited", "too many actions; slow down", { retry_in_s: w });
    const before = v.wc.getURL();
    if (name === "browser_scroll") {
      const dir = args.direction === "up" ? "up" : "down";
      emit("page_act", { id: t.id, kind: "scroll" });
      const paceS = v.pace.arrive();   // 密集判定(pace.js):密集=捲動瞬間完成
      if (paceS.cut) v.page.run(IP.mark, ["settle"]).catch(() => {});
      const pos = await v.page.scroll(dir, args.amount === "half" ? "half" : "page", paceS.mode === "instant" ? 0 : spend(t, 300) ? 300 : 0);   // 展開在看的那一頁有過程地捲
      v.pace.end();   // 捲完=結束
      bumpThumb(t);
      return R({ ok: true, tab: t.alias, url: C.scrub(before, 2000), scroll_y: pos.y, scroll_max: pos.max });
    }
    if (name === "browser_back") {
      if (!v.wc.navigationHistory.canGoBack()) return ERR("invalid_args", "no page to go back to");
      if (!(await markAgent(t))) return ERR("internal", "could not arm the navigation guard; try again");
      v.wc.navigationHistory.goBack(); await waitNav(v);
      return afterAction(t, v, before);
    }
    if (name === "browser_press") {
      const key = String(args.key || "");
      const f = await v.page.focused().catch(() => null);
      const g = gate.classify("press", f ? f.desc : { inForm: false }, key);
      if (!g.ok) { needUser(t, g.kind, null, "Enter"); return ERR("needs_user", "pressing Enter here submits a form; the user must do it", { kind: g.kind, tab: t.alias }); }
      if (!(await markAgent(t))) return ERR("internal", "could not arm the navigation guard; try again");
      emit("page_act", { id: t.id, kind: "press", text: key });
      if (t.visible && f && f.backendNodeId !== undefined) {   // 焦點欄位框一下
        try { const q = await v.page.center(f.backendNodeId, false); if (!q.error) await v.page.run(IP.mark, ["ref", { box: q.box, label: key, tag: true }, false]); } catch (_) { /* 看不到就不框 */ }   // 按鍵小標(「Enter」)照常顯示:那是給用戶看的動作,不是 @eN 內部代號(canon 第 4 條裁定)
      }
      const onScreenK = await pageVisible(t, v);
      const r = await agentInput(v, () => v.page.press(key, onScreenK));
      bumpThumb(t);
      if (r.error) return ERR("invalid_args", "unsupported key");
      return afterAction(t, v, before);
    }
    const b = v.page.node(args.ref);
    if (b === null) return ERR("stale_ref", MSG.stale_ref, { tab: t.alias });
    let d; try { d = await v.page.describe(b); } catch (_) { return ERR("stale_ref", MSG.stale_ref, { tab: t.alias }); }
    const action = name === "browser_click" ? "click" : name === "browser_type" ? "type" : "fill";
    const g = gate.classify(action, d);
    // 真滑鼠只在「頁面真的看得到」時送:視窗被蓋住、縮小、在背景時頁面是 hidden,Chromium 不送 mousedown(實測),點擊會無聲落空
    const onScreen = await pageVisible(t, v);
    let pos = null; try { pos = await v.page.center(b, onScreen); } catch (_) { pos = { error: "obscured" }; }
    if (!g.ok) {
      if (g.error === "sensitive_field") return ERR("sensitive_field", "passwords, one-time codes, card and ID numbers are typed by the user, not by you", { tab: t.alias, ref: args.ref });
      needUser(t, g.kind, args.ref, d.name || d.label || "", pos && !pos.error ? pos.box : null);
      return ERR("needs_user", g.kind === "file" ? "uploads are done by the user" : "the user must press this themselves; tell them what you filled in and what to check, then browser_wait until=user_done", { kind: g.kind, tab: t.alias, ref: args.ref });
    }
    // 打字不走座標(Input.insertText 打進焦點),量不到中心點不擋:Monaco / CodeMirror 的
    // 打字入口是 1px 隱藏 textarea,center() 對它一定 not_visible / obscured——只有點擊真的要座標
    if (pos.error && action === "click") return ERR(pos.error === "not_visible" ? "invalid_args" : "obscured", pos.error === "not_visible" ? "the element is not visible" : MSG.obscured, { tab: t.alias });
    if (pos.error) pos = null;
    const label = String(args.ref);
    const reduced = o.reducedMotion ? o.reducedMotion() : false;
    const text = String(args.text == null ? "" : args.text).slice(0, 5000);
    // 展開在看的那一頁:游標真的滑過去(mouseMoved 路徑,在 agentInput 窗內,不算用戶接手)、到點才出點擊環;
    // 背景分頁沒有滑鼠可演,只把目標框位置交給畫面,由縮圖那層畫游標與點擊環
    // 密集判定(pace.js;canon 第 9 條):密集=瞬間模式(游標直接出現、不滑行、字一次填入、環只留靜止單幀)
    const pace = v.pace.arrive();
    if (pace.cut) await v.page.run(IP.mark, ["settle"]).catch(() => {});
    const inst = pace.mode === "instant";
    const glide = !inst && onScreen && spend(t, 300) ? 260 : 0;
    if (pos) {
      await v.page.run(IP.mark, ["ref", { box: pos.box, label, tag: DEV_MARKS }, reduced]).catch(() => {});
      if (t.visible) await v.page.run(IP.mark, ["move", { x: pos.x, y: pos.y, ms: glide }, reduced]).catch(() => {});
    }
    emit("page_act", Object.assign({ id: t.id, kind: action === "click" ? "click" : "type", ref: label, text: action === "click" ? C.scrub(d.name || d.text, 80) : C.scrub(text, 80), box: pos ? pos.box : null }, viewSize(v)));
    if (!(await markAgent(t))) return ERR("internal", "could not arm the navigation guard; try again");
    if (action === "click") {
      const c = await agentInput(v, () => v.page.click(b, pos, glide));
      v.pace.end();   // 點擊落地=結束(不含環的 0.45s;沒按下去也算收掉)
      if (c.error) {
        // 沒按下去:這個動作不存在,守門與 agent 窗口立刻收掉——不然接下來 3 秒內用戶自己按的送出會被當成 agent 觸發而取消
        agentUntil.delete(v.wc.id); await v.page.disarm().catch(() => {});
        await v.page.run(IP.mark, ["clear"]).catch(() => {});
        return ERR("obscured", MSG.obscured, { tab: t.alias });
      }
      if (t.visible) await v.page.run(IP.mark, ["click", { x: pos.x, y: pos.y, instant: inst }, reduced]).catch(() => {});
    } else {
      // browser_type 40 字內逐字(給只認逐字輸入事件的欄位;reduced-motion 不影響它)。
      // 密集(瞬間模式)收成一次填入是拍板過的收斂:連續操作時逐字本身就是「畫面一直在動」;
      // 長文字(貼 code)一律一次 insertText 進——逐鍵幾千字打不完,Monaco 一類編輯器也收 insertText。
      // browser_fill 只在展開在看、40 字內、還有多等額度時逐字(35ms/字),其餘一次填入
      const perChar = !inst && text.length <= 40 && (action === "type" || spend(t, text.length * 35));   // 瞬間模式:字一次填入
      const f = await agentInput(v, () => v.page.fill(b, text, d, { clear: action === "fill", perChar, delay: 35 }));
      v.pace.end();   // 填完=結束
      if (f.error) return ERR(f.error, f.message, { tab: t.alias });
    }
    bumpThumb(t);
    return afterAction(t, v, before);
  }
  /** agent 自己送的輸入在送出期間與之後 600ms 不算用戶接手(CDP 的輸入也會觸發 input-event,而且可能晚到)。 */
  async function agentInput(v, fn) {
    v.agentInputting = true;
    try { return await fn(); } finally { v.agentInputting = false; v.agentInputAt = Date.now(); }
  }
  async function pageVisible(t, v) {
    if (!t.visible) return false;
    try { return (await v.page.run(function () { return document.visibilityState; })) === "visible"; } catch (_) { return false; }
  }
  async function waitNav(v) { await sleep(300); const end = Date.now() + 8000; while (Date.now() < end && v.wc.isLoading()) await sleep(200); }

  async function call(name, args, ctx) {
    if (!cur || !ctx.live()) return ERR("browser_off", "this turn has ended");
    if (!prefs.enabled) return ERR("browser_off", MSG.browser_off);
    firstUse();
    if (name === "browser_search") return doSearch(args);
    if (name === "browser_open") {
      if (searchUrl(args.url)) return ERR("invalid_args", "use browser_search for web searches");
      if (args.tab) {
        const x = tabFor(args.tab); if (x.e) return x.e;
        const a = policy.agent(String(args.url || "")); if (a) return ERR("blocked_policy", blockedMsg(a.reason), { reason: a.reason, host: a.host, like: a.like });
        let host = ""; try { host = policy.registrable(new URL(String(args.url)).hostname); } catch (_) { return ERR("invalid_args", "url must be an absolute http(s) URL"); }
        const w = tabs.chargePage(host); if (w) return ERR(w.error, "too many pages opened; slow down", { retry_in_s: w.retry_in_s });   // 稽核 S6:在既有分頁導覽也扣開頁速率
        x.t.status = "loading"; x.v.wc.loadURL(String(args.url)).catch(() => {});
        return R({ ok: true, tab: x.t.alias, url: C.scrub(args.url, 2000), status: "loading" });
      }
      const r = openUrl(args.url, "agent");
      if (r.error === "invalid_args") return ERR("invalid_args", "url must be an absolute http(s) URL");
      if (r.error) return ERR(r.error, "too many pages opened; slow down", { retry_in_s: r.retry_in_s });
      if (r.blocked) return ERR("blocked_policy", blockedMsg(r.blocked.reason), { tab: r.tab.alias, reason: r.blocked.reason, host: r.blocked.host, like: r.blocked.like });
      return R({ ok: true, tab: r.tab.alias, url: C.scrub(r.tab.url, 2000), status: r.tab.status === "queued" ? "queued" : "loading" });
    }
    if (name === "browser_open_many") {
      const urls = Array.isArray(args.urls) ? args.urls.slice(0, 8) : [];
      if (!urls.length) return ERR("invalid_args", "urls must be a non-empty array (max 8)");
      if (urls.some(searchUrl)) return ERR("invalid_args", "use browser_search for web searches");
      const out = [];
      for (const u of urls) {
        const r = openUrl(u, "agent");
        if (r.error) out.push({ url: C.scrub(u, 2000), status: "blocked", error: r.error, retry_in_s: r.retry_in_s });
        else if (r.blocked) out.push({ tab: r.tab.alias, url: C.scrub(u, 2000), status: "blocked", error: "blocked_policy", reason: r.blocked.reason });
        else out.push({ tab: r.tab.alias, url: C.scrub(r.tab.url, 2000), status: r.tab.status === "queued" ? "queued" : "loading" });
      }
      return R({ ok: true, tabs: out });
    }
    if (name === "browser_wait") return doWait(args);
    if (name === "browser_tabs") return R({ ok: true, tabs: tabs.thisTurn().map(tabInfo), queued: tabs.queued() });
    if (name === "browser_close") { const t = tabs.byAlias(args.tab); if (!t) return ERR("not_found", MSG.not_found); if (t.userControl) return ERR("user_in_control", MSG.user_in_control, { tab: t.alias }); tabs.close(t.id); emit("page_closed", { id: t.id }); return R({ ok: true }); }
    const x = tabFor(args.tab); if (x.e) return x.e;
    const { t, v } = x;
    if (name === "browser_snapshot") {
      emit("page_act", { id: t.id, kind: "snapshot" });
      const s = await v.page.snapshot({ scope: args.scope, interactive_only: !!args.interactive_only }, gate.sensitiveField);
      if (s.error) return ERR(s.error, MSG[s.error], { tab: t.alias });
      return R(C.envelope(v.wc.getURL(), v.wc.getTitle(), s.text, { tab: t.alias, refs: s.refs, truncated: s.truncated }));
    }
    if (name === "browser_read") return doRead(t, v, args);
    if (name === "browser_get") {
      const what = args.what;
      if (what === "url") return R(C.envelope(v.wc.getURL(), v.wc.getTitle(), v.wc.getURL(), { tab: t.alias }));
      if (what === "title") return R(C.envelope(v.wc.getURL(), v.wc.getTitle(), v.wc.getTitle(), { tab: t.alias }));
      let val = "";
      if (!args.ref) { if (what !== "text") return ERR("invalid_args", "ref is required"); val = await v.page.run(function () { return String(document.body ? document.body.innerText : "").slice(0, 12000); }); }
      else {
        const b = v.page.node(args.ref); if (b === null) return ERR("stale_ref", MSG.stale_ref, { tab: t.alias });
        const d = await v.page.describe(b).catch(() => null); if (!d) return ERR("stale_ref", MSG.stale_ref, { tab: t.alias });
        if (what === "value" && gate.sensitiveField(d)) val = "";
        else if (what === "attr" && /^(value)$/i.test(String(args.name || "")) && gate.sensitiveField(d)) val = "";
        else val = await v.page.callOn(b, function (w, n) { if (w === "text") return String(this.innerText || this.textContent || "").slice(0, 12000); if (w === "value") return String(this.value == null ? "" : this.value).slice(0, 12000); return String(this.getAttribute(String(n)) || "").slice(0, 12000); }, [what, String(args.name || "")]);
      }
      const n = tabs.readBudget(String(val).length); if (String(val).length && !n) return ERR("budget_exhausted", "read budget used up");
      return R(C.envelope(v.wc.getURL(), v.wc.getTitle(), String(val).slice(0, n), { tab: t.alias }));
    }
    if (name === "browser_screenshot") {
      const got = await withMask(v, async () => {
        let d = await v.page.screenshot(!!args.annotate);
        if (!d) { try { const img = await within(v.wc.capturePage(undefined, { stayHidden: true }), 5000); if (!img.isEmpty()) d = img.toPNG().toString("base64"); } catch (_) { /* 拍不到 */ } }
        return { d };
      });
      if (!got) return ERR("sensitive_field", "a password / card / code field on this page has a value that could not be hidden, so no screenshot was taken; use browser_snapshot or browser_read", { tab: t.alias });
      let data = got.d;
      if (!data) return ERR("screenshot_failed", "could not capture this tab right now; use browser_snapshot or browser_read instead", { tab: t.alias });
      try { const img = E.nativeImage.createFromBuffer(Buffer.from(data, "base64")); const s = img.getSize(); if (Math.max(s.width, s.height) > 1280) data = (s.width >= s.height ? img.resize({ width: 1280 }) : img.resize({ height: 1280 })).toPNG().toString("base64"); } catch (_) { /* 原圖 */ }
      const meta = C.envelope(v.wc.getURL(), v.wc.getTitle(), "", { tab: t.alias });
      return { content: [{ type: "text", text: JSON.stringify(meta) }, { type: "image", mimeType: "image/png", data }], isError: false };
    }
    if (name === "browser_capture") return doCapture(t, v, args);
    if (["browser_click", "browser_fill", "browser_type", "browser_press", "browser_scroll", "browser_back"].includes(name)) return doAct(name, t, v, args);
    return ERR("invalid_args", "unknown tool");
  }

  /* 「匯整成報告」只在這一輪真的有報告寫進 workspace/reports/ 時才顯示(canon 設計系統 第 1 條):
     看的是檔案系統事件,不是猜 agent 在做什麼。一輪只發一次。 */
  let reportWatch = null;
  function watchReports(c) {
    if (!o.reportsDir) return;
    try { require("fs").mkdirSync(o.reportsDir, { recursive: true }); } catch (_) { return; }
    try {
      reportWatch = require("fs").watch(o.reportsDir, (_ev, name) => {
        if (cur !== c || c.reported || !/^[A-Za-z0-9_-]{1,64}\.json$/.test(String(name || ""))) return;
        c.reported = true; emit("report_write", {});
      });
      reportWatch.on("error", () => { /* 目錄被刪:這一輪就不顯示 */ });
    } catch (_) { reportWatch = null; }
  }

  /* favicon(canon 第 2、8 條:字母格 / favicon)。Electron 不會自己下載 favicon(實測:頁面宣告了 icon,伺服器 0 次請求),
     所以要畫就得替這個網站發一次請求——跟一般瀏覽器載入頁面時抓 favicon 是同一件事:同一個 partition(同 cookie / 快取)、
     每個網站這次啟動只抓一次、先用快取。FAVICON_FETCH = false 就只畫字母格。
     favicon 是不可信內容:只收 image/*、≤64KB、轉成 data URL(renderer 不拿遠端網址當 <img src>),存進快照目錄(0600、跟快照一起清)。 */
  const FAVICON_FETCH = true, FAVICON_MAX = 64 * 1024;
  const favCache = new Map(), favPending = new Map(), favTried = new Map();
  const FAV_MIME = /^image\/(png|x-icon|vnd\.microsoft\.icon|jpeg|gif|webp|svg\+xml|avif|bmp)$/i;
  async function fetchFavicon(t, v, favs) {
    let host; try { host = new URL(v.wc.getURL() || t.url).host; } catch (_) { return; }
    const known = favCache.get(host);
    if (known) { emit("page_favicon", { id: t.id, dataURI: known.data, plate: known.plate }); return; }
    if (!FAVICON_FETCH || favPending.has(host) || favTried.get(host) >= 2) return;
    favPending.set(host, true);
    // 頁面自己宣告的 <link rel=icon> 優先(讀 DOM,不發請求);Electron 給的候選常只有預設的 /favicon.ico
    // app 只有暗色主題:網站宣告了暗色版(media="(prefers-color-scheme: dark)")就排第一
    let declared = []; try { declared = await v.page.run(function () { return Array.from(document.querySelectorAll('link[rel~="icon" i], link[rel="shortcut icon" i], link[rel="apple-touch-icon" i]')).map((l) => ({ href: l.href, dark: /prefers-color-scheme\s*:\s*dark/i.test(l.media || "") })).slice(0, 8); }); } catch (_) { /* 讀不到就用候選 */ }
    declared = (declared || []).sort((a, b) => (b.dark ? 1 : 0) - (a.dark ? 1 : 0)).map((d) => d.href);
    // 稽核 R8:只抓跟頁面同一個可註冊網域的 icon(頁面可以在 <link> 寫任何第三方網址——不能讓網頁指使 app 替用戶打別人);agent 不能去的網址也不抓
    const pageReg = policy.registrable(new URL(v.wc.getURL() || t.url).hostname);
    const sameSite = (f) => { try { const u = new URL(f); return policy.registrable(u.hostname) === pageReg; } catch (_) { return false; } };
    const cands = [...new Set((declared || []).concat(favs || []))].filter((f) => /^https?:\/\//i.test(String(f)) && sameSite(f) && !policy.network(f, "sub") && !policy.agent(f));
    try {
      for (const url of cands) {
        if ((favTried.get(host) || 0) >= 2) break;   // 每個網站最多試兩個網址
        favTried.set(host, (favTried.get(host) || 0) + 1);
        const data = await fetchIcon(url);
        if (!data) continue;
        const got = { data, plate: needsPlate(data) };
        favCache.set(host, got);
        if (cur) snaps.saveFavicon(cur.sessionId, host, got.data, got.plate);
        emit("page_favicon", { id: t.id, dataURI: got.data, plate: got.plate });
        return;
      }
    } finally { favPending.delete(host); }
  }
  /* 深色 favicon 在暗底上看不見:算不透明像素的平均亮度,對暗底(--color-darkCard #1a2328)對比 <3:1 才墊淺底。
     解不開的格式(svg、部分 ico)不墊。 */
  /** PNG / JPEG 標頭裡的寬高(不解碼);讀不到回 null */
  function imageSize(buf) {
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      for (let i = 2; i + 9 < buf.length;) {
        if (buf[i] !== 0xff) return null;
        const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
    return null;
  }
  function needsPlate(dataURI) {
    try {
      // 先讀標頭尺寸:超過 256×256 就不解碼(小小的 64KB 也能宣告成解碼後吃掉大量記憶體的圖)
      const raw = Buffer.from(String(dataURI).split(",")[1] || "", "base64"), dim = imageSize(raw);
      if (!dim || dim.w > 256 || dim.h > 256 || !dim.w || !dim.h) return false;
      const img = E.nativeImage.createFromDataURL(dataURI); if (img.isEmpty()) return false;
      const bm = img.resize({ width: 16, height: 16 }).toBitmap();   // BGRA
      let sum = 0, n = 0;
      const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      for (let i = 0; i + 3 < bm.length; i += 4) { if (bm[i + 3] < 128) continue; sum += 0.2126 * lin(bm[i + 2]) + 0.7152 * lin(bm[i + 1]) + 0.0722 * lin(bm[i]); n++; }
      if (!n) return false;
      const bg = 0.2126 * lin(0x1a) + 0.7152 * lin(0x23) + 0.0722 * lin(0x28);
      return (sum / n + 0.05) / (bg + 0.05) < 3;
    } catch (_) { return false; }
  }
  /* 不帶 cookie、不跟轉址(轉到哪裡都不管,直接放棄)、5 秒逾時真的中止、邊讀邊數,超過 64KB 立刻中止 */
  async function fetchIcon(url) {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 5000);
    try {
      const res = await session().fetch(url, { cache: "force-cache", credentials: "omit", redirect: "manual", signal: ac.signal });
      const mime = String(res.headers.get("content-type") || "").split(";")[0].trim();
      const len = Number(res.headers.get("content-length") || 0);
      if (res.status !== 200 || !FAV_MIME.test(mime) || len > FAVICON_MAX || !res.body) { ac.abort(); return null; }
      const reader = res.body.getReader(), parts = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > FAVICON_MAX) { ac.abort(); return null; }
        parts.push(Buffer.from(value));
      }
      const buf = Buffer.concat(parts);
      if (!buf.length) return null;
      return "data:" + mime.toLowerCase() + ";base64," + buf.toString("base64");
    } catch (_) { return null; } finally { clearTimeout(timer); }   // 拿不到就畫字母格
  }

  // 「送進 TradingView」的診斷 log:一次結果一行 JSON;超過 256KB 換檔(留一份 .1)。寫不進去就算了
  function pineLog(entry) {
    if (!o.pineLog) return;
    const fs = require("fs");
    try {
      fs.mkdirSync(require("path").dirname(o.pineLog), { recursive: true });
      try { if (fs.statSync(o.pineLog).size > 256 * 1024) fs.renameSync(o.pineLog, o.pineLog + ".1"); } catch (_) { /* 還沒有檔 */ }
      fs.appendFileSync(o.pineLog, JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch (_) { /* 唯讀磁碟、沒權限 */ }
  }
  /* 「送進 TradingView」(pine.js):外殼自己的確定性流程,不經 agent 工具、不佔 agent 的 alias 與速率。
     分頁是 user 分頁;動手前照樣開導覽守門(動作後 3 秒內的文件層送出一律取消),交接時收掉——
     之後用戶自己按的送出與登入子視窗才不會被當成程式觸發 */
  const pine = require("./pine").createPine({
    open: (url) => openUrl(url, "user"), tab: (id) => tabs.get(id), view: (id) => views.get(id) || null,
    waitLoaded, visible: pageVisible, input: agentInput, arm: markAgent,
    disarm: (t) => { const v = views.get(t.id); if (!v) return null; agentUntil.delete(v.wc.id); backstop.delete(v.wc.id); return v.page.disarm(); },
    emit, sensitive: gate.sensitiveField, enabled: () => !!prefs.enabled, lang: () => o.uiLang(), reduced: () => (o.reducedMotion ? o.reducedMotion() : false), sleep,
    log: pineLog,
  });

  // ── 對外 ──
  return {
    PARTITION,
    pineInstall: (job) => { win = o.getWin() || win; return pine.install(job); },
    pineCheck: (id) => pine.check(id), pineRead: (id) => pine.read(id),
    enabled: () => !!prefs.enabled,
    /** 回合開始:設定開著才回 { url, token };主行程把它寫進單次設定檔 / Codex 環境。 */
    async beginTurn(w, sessionId) {
      if (!prefs.enabled) return null;
      win = w;
      if (!mcp) { mcp = createMcpServer({ tools: TOOLS, call, instructions: INSTRUCTIONS, version: o.version }); await mcp.start(); }
      const turnKey = Date.now();
      // seen / readText:外送檢查用(policy.exfilRisk)——這一輪開過的網域、讀過的字
      cur = { sessionId, turnKey, used: false, captchas: 0, skipGoogle: false, sources: [], seen: new Set(), readText: "" };
      tabs.newTurn();
      for (const v of views.values()) v.pace.newTurn();   // 跨回合重置:每回合第一動作完整效果(canon 第 9 條)
      watchReports(cur);
      return { url: mcp.url(), token: mcp.beginTurn(turnKey) };
    },
    /** 回合結束:作廢 token、把這一輪的分頁與來源記下來(重開 app 時重建聊天區塊)、發 turn_sources。 */
    endTurn() {
      if (mcp) mcp.endTurn();
      if (reportWatch) { try { reportWatch.close(); } catch (_) { /* 已關 */ } reportWatch = null; }
      if (!cur) return;
      const c = cur; cur = null;
      if (!c.used) return;
      const favOf = (u) => { try { return favCache.get(new URL(u).host) || null; } catch (_) { return null; } };
      const rows = tabs.thisTurnAll().filter((t) => t.status !== "closed" || t.readEver).map((t) => ({ id: t.id, url: C.scrub(t.url, 2000), title: C.scrub(t.title, 300), status: t.status === "blocked" ? "blocked" : t.status === "failed" ? "failed" : t.readEver ? "done" : "open", snapshot_id: t.snapshotId || null, search: !!t.isSearch }));
      const sources = c.sources.slice();
      // ts = agent 第一次用瀏覽器的時間,不是回合開始:回合開始比 runtime 寫進逐字稿的那句用戶訊息早,
      // 重開對話時區塊會排到那句的上面
      snaps.logTurn(c.sessionId, { ts: (c.usedAt || c.turnKey) / 1000, end: Date.now() / 1000, tabs: rows, sources });
      const withFav = (a) => a.map((r) => { const f = favOf(r.url); return Object.assign({}, r, { fav: f ? f.data : null, plate: !!(f && f.plate) }); });
      emit("turn_sources", { session_id: c.sessionId, sources: withFav(sources), tabs: withFav(rows) });
      for (const t of tabs.thisTurn()) { if (t.need && !t.userDone) { t.need = null; emit("need_clear", { id: t.id }); } }
      // 快照圖升級成整頁版(beyond-viewport 只在這裡做:一輪一次;操作中存的是視口版,見 captureSnapshotImage)
      (async () => {
        for (const r of rows) {
          if (!r.snapshot_id) continue;
          const v = views.get(r.id); if (!v) continue;
          const image = await withMask(v, () => captureSnapshotImage(v, true), true);
          if (image) snaps.updateImage(c.sessionId, r.snapshot_id, image);
          if (expanded !== r.id) parkEmulate(v);   // 整頁擷取的 unEmulate 也清掉 park override,補回去(不然頁面回到 0 寬行動版)
        }
      })().catch(() => {});
    },
    active: () => !!cur,
    // ── renderer 的 IPC(main.js 用 fromOurPage 的 handle() 註冊)──
    expand(id, bounds) {
      const t = tabs.get(String(id || "")); if (!t) return { error: "NOT_FOUND" };
      if (expanded && expanded !== t.id) { const pv = views.get(expanded); if (pv) park(pv, 0); }
      tabs.setVisible(t.id, true); expanded = t.id;
      const v = views.get(t.id);
      if (!v) return { id: t.id, live: false, status: t.status, url: C.scrub(t.url, 2000), title: t.title, snapshot_id: t.snapshotId || null, reason: t.reason || null };
      this.bounds(bounds);
      return { id: t.id, live: true, status: status(t), url: C.scrub(v.wc.getURL() || t.url, 2000), title: t.title, user: !!t.userControl, need: t.need ? { kind: t.need.kind, summary: C.scrub(t.need.summary, 300) } : null };
    },
    bounds(b) {
      if (!expanded) return;
      const v = views.get(expanded); if (!v) return;
      const ok = b && [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n)) && b.width > 40 && b.height > 40;
      if (!ok) { park(v, 0); return; }
      // 稽核 B2:renderer 量的是 CSS px,setBounds 要 DIP;主視窗被縮放(Cmd+=)時乘上縮放倍率
      let z = 1; try { const w = o.getWin(); z = (w && !w.isDestroyed() && w.webContents.getZoomFactor()) || 1; } catch (_) { /* 用 1 */ }
      const nb = { x: Math.round(b.x * z), y: Math.round(b.y * z), width: Math.round(b.width * z), height: Math.round(b.height * z) };
      // 位置沒變就不動:setBounds 會打斷觸控板的捲動手勢(macOS 上捲到一半就停住),畫面每次重畫都送一次 bounds
      try { const cb = v.view.getBounds(); if (cb.x !== nb.x || cb.y !== nb.y || cb.width !== nb.width || cb.height !== nb.height) { v.view.setBounds(nb); unEmulate(v); } } catch (_) { /* 已關 */ }
    },
    collapse() { if (expanded) { const v = views.get(expanded); if (v) park(v, 0); } tabs.setVisible(null, false); expanded = null; },
    takeover, handback,
    userDone(id, choice) { const t = tabs.get(String(id || "")); if (!t) return;
      if (choice === "open") {   // 外送檢查的「仍要開啟」:這個網址放行一次
        if (!t.heldUrl) return;
        t.allowOnce = t.heldUrl; t.heldUrl = null; t.userDone = "done"; emit("need_clear", { id: t.id });
        const v = views.get(t.id); if (v) { t.status = "loading"; v.wc.loadURL(t.allowOnce).catch(() => {}); }
        return;
      }
      t.userDone = choice === "skip" ? "skip" : choice === "ddg" ? "ddg" : "done"; if (choice !== "done") t.userControl = false; emit("need_clear", { id: t.id }); const v = views.get(t.id); if (v) v.page.run(IP.mark, ["clear"]).catch(() => {}); },
    navigate(id, url) {
      const t = tabs.get(String(id || "")); if (!t) return { error: "NOT_FOUND" };
      let u; try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(String(url)) ? String(url) : "https://" + String(url)); } catch (_) { return { error: "BAD_URL" }; }
      const bad = policy.network(u.href, "main"); if (bad) return { error: "BLOCKED", reason: bad.reason };
      const v = views.get(t.id); if (!v) return { error: "NOT_LIVE" };
      takeover(t.id); t.status = "loading"; v.wc.loadURL(u.href).catch(() => {});
      return { ok: true };
    },
    /** 重新載入;被收成快照的分頁照名額重開(同一個 id);失敗的分頁開一個新分頁(回新 id)。 */
    reload(id) {
      const t = tabs.get(String(id || "")); if (!t) return false;
      const v = views.get(t.id); if (v) { v.wc.reload(); return true; }
      if (t.status === "discarded") return tabs.revive(t.id);
      if (t.status === "failed") { const r = openUrl(t.url, "user"); return r.tab && !r.blocked ? r.tab.id : false; }
      return false;
    },
    openLive(sessionId, snapshotId) { const s = snaps.load(sessionId, snapshotId); if (!s) return null; const r = openUrl(s.url, "user"); return r.tab && !r.blocked ? r.tab.id : null; },
    /** 點開就是要看即時頁(Wei 2026-09-27):這個網址的分頁還活著就切過去,不在了(收成快照、關掉、重開 app)
     *  就重新導覽——user 分頁、照樣走網路層政策;外送擋只看 agent 分頁,用戶自己點的來源不會誤觸發確認卡。 */
    showLive(url) {
      url = String(url || "");
      for (const t of tabs.all()) if (t.url === url && views.has(t.id) && t.status !== "blocked" && t.status !== "failed") return { id: t.id, existing: true };
      const r = openUrl(url, "user");
      return r.tab && !r.blocked ? { id: r.tab.id, existing: false } : null;
    },
    snapshot: (sessionId, snapshotId) => snaps.load(sessionId, snapshotId),
    /** 每輪紀錄 + 各列的 favicon(快照目錄裡存的 data URL;沒有就是 null,畫字母格) */
    history(sessionId) {
      const favs = snaps.favicons(sessionId), fav = (u) => { try { return favs[new URL(u).host] || null; } catch (_) { return null; } };
      const add = (x) => { const f = fav(x.url); return Object.assign({}, x, { fav: f ? f.data : null, plate: !!(f && f.plate) }); };
      return snaps.turns(sessionId).map((r) => Object.assign({}, r, { tabs: (r.tabs || []).map(add), sources: (r.sources || []).map(add) }));
    },
    removeSession: (sessionId) => snaps.removeSession(sessionId),
    externalUrl(id) { const t = tabs.get(String(id || "")); return t ? t.url : null; },
    setBlockVisible(on) { blockVisible = !!on; if (on) thumbs(); },
    _captureThumb: (id) => captureThumb(id),
    prefs: () => ({ enabled: !!prefs.enabled }),
    setPrefs(p) { if (p && typeof p.enabled === "boolean") prefs.enabled = p.enabled; if (o.savePrefs) o.savePrefs(prefs); return { enabled: prefs.enabled }; },
    async clearData() {
      for (const t of tabs.all()) tabs.close(t.id);
      oauth.close();   // 清瀏覽資料連登入視窗一起收(它的 cookie 就在這個 partition)
      await session().clearStorageData(); await session().clearCache(); snaps.clearAll();
      favCache.clear(); favTried.clear();   // 看過哪些網站也是瀏覽資料
      return true;
    },
    _tabs: tabs, _call: call, _oauth: oauth,   // 測試用
    _agentActive: (id) => { const v = views.get(id); return !!v && agentActive(v.wc.id); },
    _imageSize: (b) => imageSize(b), _needsPlate: (d) => needsPlate(d),
    _viewBounds: (id) => { const v = views.get(id); return v ? v.view.getBounds() : null; },
    _maskProbe: async (alias) => {
      const t = tabs.byAlias(alias), v = t && views.get(t.id); if (!v) return null;
      let inside = null;
      const r = await withMask(v, async () => { inside = await v.page.run(function () { return !!document.getElementById("__blave_mask"); }); return true; });
      const after = await v.page.run(function () { return !!document.getElementById("__blave_mask"); });
      const list = await v.page.run(IP.fieldCandidates);
      return { ran: !!r, masked: lastMasked, maskedDuring: inside, gone: !after, candidates: list.length };
    },
  };
}

module.exports = { createBrowser, PARTITION };
