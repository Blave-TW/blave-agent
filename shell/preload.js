const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("blave", {
  // 聊天附件檔名上限:主行程 shell/attach.js 的 ATTACH_NAME_MAX,經 webPreferences.additionalArguments 進來(數字只寫在那一處)。0 = 沒拿到:畫面不擋,仍由主行程擋
  attachNameMax: Number(((process.argv || []).find((a) => a.indexOf("--blave-attach-name-max=") === 0) || "").split("=")[1]) || 0,
  platform: process.platform,   // app.js 掛到 <html data-platform>:Windows 的捲軸樣式只認這個記號
  detectAgents: () => ipcRenderer.invoke("detect-agents"),
  saveConnection: (choice) => ipcRenderer.invoke("save-connection", choice),
  loadConnection: () => ipcRenderer.invoke("load-connection"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  getLocale: () => ipcRenderer.invoke("get-locale"),
  deleteStrategy: (name) => ipcRenderer.invoke("delete-strategy", name),
  listSessions: () => ipcRenderer.invoke("list-sessions"),
  loadSessionImages: (id) => ipcRenderer.invoke("load-session-images", id),
  // 聊天結果卡(renderer/results.js):每輪一列 { ts, items },主行程驗形狀才落地
  saveTurnResults: (id, entry) => ipcRenderer.invoke("save-turn-results", id, entry),
  loadTurnResults: (id) => ipcRenderer.invoke("load-turn-results", id),
  loadSession: (id) => ipcRenderer.invoke("load-session", id),
  deleteSession: (id) => ipcRenderer.invoke("delete-session", id),
  listStrategies: () => ipcRenderer.invoke("list-strategies"),
  loadStrategy: (name) => ipcRenderer.invoke("load-strategy", name),
  // 轉出檔「下載…」:主行程讀檔 + 開存檔框。ref = { session, id }(對話裡那張卡的快照)或 { strategy, target }(程式碼分頁);不過內容、不過路徑
  saveExport: (ref) => ipcRenderer.invoke("save-export", ref ? { session: ref.session, id: ref.id, strategy: ref.strategy, target: ref.target } : null),
  revealExport: (token) => ipcRenderer.invoke("reveal-export", token),   // 只收 saveExport 回的 token
  loadSessionExports: (id) => ipcRenderer.invoke("load-session-exports", id),
  // 策略版本(renderer/versions.js):這台電腦讀 strategies/<name>/versions/;雲端走 /cloud/version
  loadVersion: (name, n) => ipcRenderer.invoke("load-version", name, n),
  compareVersions: (name, a, b) => ipcRenderer.invoke("compare-versions", name, a, b),
  cloudVersion: (q) => ipcRenderer.invoke("cloud-version", { name: q && q.name, op: q && q.op, n: q && q.n, a: q && q.a, b: q && q.b }),
  accountStatus: () => ipcRenderer.invoke("account-status"),
  balance: () => ipcRenderer.invoke("balance"),   // Blave 餘額:{ balance, trial } 或 null(讀不到);憑證在主行程
  planStart: (opts) => ipcRenderer.invoke("plan-start", opts),
  publicPricing: () => ipcRenderer.invoke("public-pricing"),
  txfQuote: () => ipcRenderer.invoke("txf-quote"),   // 台指期指數(雲端視角口數列的參考金額);問不到 = null
  tradeLabels: (labels) => ipcRenderer.send("trade-labels", labels),
  cloudStatus: () => ipcRenderer.invoke("cloud-status"),
  cloudRefresh: () => ipcRenderer.invoke("cloud-refresh"),
  onCloudState: (fn) => ipcRenderer.on("cloud-state", (_e, s) => fn(s)),
  cloudEvents: (q) => ipcRenderer.invoke("cloud-events", q),
  cloudOverview: (q) => ipcRenderer.invoke("cloud-overview", q),
  cloudPerformance: (q) => ipcRenderer.invoke("cloud-performance", q),
  cloudStrategy: (name) => ipcRenderer.invoke("cloud-strategy", { name }),
  // 雲端的報告清單 / 本體(renderer/reports.js):主行程打 api、圖換成 data URI 才交過來;force = 送出「新增報告」後的輪詢,跳過 5 分鐘快取
  cloudReports: (force) => ipcRenderer.invoke("cloud-reports", force),
  cloudReport: (id, ver) => ipcRenderer.invoke("cloud-report", id, ver),   // ver = 清單的 stored_at(同 id 覆寫後換一份)
  // 報告公開分享(renderer/report-share.js):view = "local" | "cloud";回 { code, share?, displayName? }(穩定代號,沒有憑證)
  shareState: (view, id) => ipcRenderer.invoke("share-state", view, id),
  sharePublish: (view, id, a) => ipcRenderer.invoke("share-publish", view, id, { byline: a && a.byline, confirmed: !!a && a.confirmed === true, update: !!a && a.update === true }),
  shareRevoke: (view, id) => ipcRenderer.invoke("share-revoke", view, id),
  // 設定 › 公開連結(renderer/report-sharelist.js):這個帳號所有公開中的報告;取消只給代碼
  shareList: () => ipcRenderer.invoke("share-list"),
  shareRevokeCode: (code) => ipcRenderer.invoke("share-revoke-code", code),
  // 報告存成 PDF(renderer/report-pdf.js):主行程開存檔框、自己讀報告、自己寫檔;回 { code: OK | CANCELED | BUSY | FAIL };OK 另帶 { dir, token }(token 給 revealExport)
  reportPdf: (view, id, ver, lang) => ipcRenderer.invoke("report-pdf", view, id, ver, lang),
  onReportPdfSaving: (fn) => ipcRenderer.on("report-pdf-saving", () => fn()),   // 存檔框按了儲存、開始產
  // 雲端寫入:只有指令名與參數過得來(金鑰不走這支,主行程也拒收);requestId = 重試時沿用上一趟那顆
  cloudSend: (cmd, args, requestId) => ipcRenderer.invoke("cloud-send", cmd, args, requestId),
  // 雲端連交易所:金鑰只走這一支(cloud-send 拒收 credentials);回應只有 { ok, code, detail },沒有金鑰值
  cloudConnect: (a) => ipcRenderer.invoke("cloud-connect", { venue: a && a.venue, apiKey: a && a.apiKey, secret: a && a.secret, passphrase: a && a.passphrase }),
  // 雲端群益開通(cloud_capital.js):憑證檔由主行程開對話框讀進記憶體,這裡只拿得到檔名與代號
  capitalPick: () => ipcRenderer.invoke("capital-pick"),
  capitalCreds: (id, pw) => ipcRenderer.invoke("capital-creds", { id, pw }),
  capitalStep: (name) => ipcRenderer.invoke("capital-step", name),
  capitalUpload: (pw) => ipcRenderer.invoke("capital-upload", pw),
  capitalUnbind: () => ipcRenderer.invoke("capital-unbind"),
  capitalForget: () => ipcRenderer.invoke("capital-forget"),
  // 統一本機開通(president_local.js):密碼送進主行程一次,這裡拿得回來的只有代號、張數、到期日、帳號
  presidentInfo: () => ipcRenderer.invoke("president-info"),
  presidentCreds: (account, password) => ipcRenderer.invoke("president-creds", { account, password }),
  presidentScan: () => ipcRenderer.invoke("president-scan"),
  presidentPick: () => ipcRenderer.invoke("president-pick"),
  presidentTcem: () => ipcRenderer.invoke("president-tcem"),
  presidentCert: (caPassword, source) => ipcRenderer.invoke("president-cert", { caPassword, source }),
  presidentStep: (name, o) => ipcRenderer.invoke("president-step", name, o || {}),
  presidentUnbind: () => ipcRenderer.invoke("president-unbind"),
  // 最低版本閘:{ blocked, min, current, checked_at };被擋時 trade-send 的啟動類回 UPDATE_REQUIRED、send-message 回 { blocked: "UPDATE_REQUIRED" }
  minVersionState: () => ipcRenderer.invoke("min-version-state"),
  onMinVersionState: (fn) => ipcRenderer.on("min-version-state", (_e, st) => fn(st)),
  // app 選單「顯示」的兩項:"local" | "cloud"
  onEnvSwitch: (fn) => ipcRenderer.on("env-switch", (_e, env) => fn(env)),
  updateState: () => ipcRenderer.invoke("update-state"),
  updateCheck: () => ipcRenderer.invoke("update-check"),
  updateInstall: () => ipcRenderer.invoke("update-install"),
  updateShowBackup: () => ipcRenderer.invoke("update-show-backup"),   // 換版時備份的資料夾:主行程開 Finder(路徑不經畫面)
  onUpdateState: (fn) => ipcRenderer.on("update-state", (_e, st) => fn(st)),
  telemetryGet: () => ipcRenderer.invoke("telemetry-get"),
  telemetrySet: (on) => ipcRenderer.invoke("telemetry-set", on),
  telemetryInstallId: () => ipcRenderer.invoke("telemetry-install-id"),
  trackFeature: (name) => ipcRenderer.send("track-feature", name),   // 功能被使用:只有白名單裡的名字會落表(主行程驗)
  trackEvent: (ev, props) => ipcRenderer.send("track-event", ev, props),   // 卡在哪一步:事件與屬性值都由主行程對白名單驗
  featureFlags: () => ipcRenderer.invoke("feature-flags"),
  // 自帶資料來源:金鑰的值只經過 dataSrcSave 一次;其餘三支只有名稱
  dataSrcList: () => ipcRenderer.invoke("datasrc-list"),
  dataSrcSave: (input) => ipcRenderer.invoke("datasrc-save", input),
  dataSrcBlockers: (name) => ipcRenderer.invoke("datasrc-blockers", name),
  dataSrcRemove: (name) => ipcRenderer.invoke("datasrc-remove", name),
  // 設定 › Agent 規則:這台電腦的常駐規則與回覆語言。存檔回的是本機 daemon 的結果
  rulesState: () => ipcRenderer.invoke("rules-state"),
  rulesSave: (rules, base) => ipcRenderer.invoke("rules-save", { rules, base }),
  replyLangSave: (lang, custom) => ipcRenderer.invoke("reply-lang-save", { lang, custom }),
  // Binance 真錢連接:金鑰只經過 binanceConnect 一次(主行程查過權限才存);其餘三支不碰金鑰
  binanceIp: () => ipcRenderer.invoke("binance-ip"),
  binanceState: () => ipcRenderer.invoke("binance-state"),
  binanceRecheck: () => ipcRenderer.invoke("binance-recheck"),
  binanceConnect: (apiKey, secret) => ipcRenderer.invoke("binance-connect", { apiKey, secret }),
  // OKX / BingX / Gate.io / Bybit 綁在這台電腦:金鑰只經過這一次(主行程驗形狀、送 daemon),回應只有代號
  venueConnect: (a) => ipcRenderer.invoke("venue-connect", { venue: a && a.venue, apiKey: a && a.apiKey, secret: a && a.secret, passphrase: a && a.passphrase }),
  onBinanceState: (fn) => ipcRenderer.on("binance-state", (_e, st) => fn(st)),
  tradeStatus: () => ipcRenderer.invoke("trade-status"),
  tradeEvents: (q) => ipcRenderer.invoke("trade-events", q),
  tradeEquity: (q) => ipcRenderer.invoke("trade-equity", q),
  tradeSend: (cmd, args, requestId, intent) => ipcRenderer.invoke("trade-send", cmd, args, requestId, intent),   // 參數順序同 renderer 的 envApi.tradeSend;intent = "release" 時主行程不記「開始下單」
  modelOptions: (kind) => ipcRenderer.invoke("model-options", kind),
  loadModelPrefs: () => ipcRenderer.invoke("load-model-prefs"),
  saveModelPrefs: (prefs) => ipcRenderer.invoke("save-model-prefs", prefs),
  startOAuth: (lang, intent) => ipcRenderer.invoke("start-oauth", lang, intent),
  cancelOAuth: () => ipcRenderer.invoke("cancel-oauth"),
  clearConnection: () => ipcRenderer.invoke("clear-connection"),
  hasBlaveToken: () => ipcRenderer.invoke("has-blave-token"),
  // 自帶 API 金鑰(renderer/apikey.js):金鑰值只經過 apikeySet 一次(主行程先打供應商驗過才存);test 重驗已存的那把、remove 刪掉、cancel 中止驗證。
  // **沒有讀出金鑰的路**:回應只有 { ok, code, status },存了哪一家跟著 detectAgents 回來(apikey.saved)
  apikeySet: (a) => ipcRenderer.invoke("apikey-set", { preset: a && a.preset, key: a && a.key, connect: !!a && a.connect === true }),
  apikeyTest: () => ipcRenderer.invoke("apikey-test"),
  apikeyRemove: () => ipcRenderer.invoke("apikey-remove"),
  apikeyCancel: () => ipcRenderer.invoke("apikey-cancel"),
  // 策略庫(renderer/library.js):清單由主行程打 api(畫面的 CSP 不外連);購買帶登入憑證、只在主行程;已安裝對照表存 userData
  libraryList: (lang, force) => ipcRenderer.invoke("library-list", lang, force),
  libraryReport: (id, lang) => ipcRenderer.invoke("library-report", id, lang),
  libraryNote: (id) => ipcRenderer.invoke("library-note", id),
  libraryPurchase: (id, confirmTopup) => ipcRenderer.invoke("library-purchase", id, confirmTopup),
  libraryInstalled: (patch) => ipcRenderer.invoke("library-installed", patch),
  libraryDownload: (id) => ipcRenderer.invoke("library-download", id),
  // 本機報告(renderer/reports.js):信封清單 / 一份本體 + sidecar 圖(data URI);renderer 不碰 fs
  reportsList: () => ipcRenderer.invoke("reports-list"),
  reportLoad: (id) => ipcRenderer.invoke("report-load", id),
  cancelAgentLogin: () => ipcRenderer.invoke("cancel-agent-login"),
  agentLogin: (kind) => ipcRenderer.invoke("agent-login", kind),
  signOutBlave: () => ipcRenderer.invoke("sign-out-blave"),
  ensureEngine: () => ipcRenderer.invoke("ensure-engine"),
  sendMessage: (payload) => ipcRenderer.invoke("send-message", payload),
  stopTurn: () => ipcRenderer.invoke("stop-turn"),   // true = 停止旗標寫下了;結果照樣等 turn-end
  // 安裝進度(renderer/engine.js):主行程那一份快照,拉一次 + 之後每次變動推過來
  engineState: () => ipcRenderer.invoke("engine-state"),
  onEngineState: (fn) => ipcRenderer.on("engine-state", (_e, s) => fn(s)),
  onTurnEvent: (fn) => ipcRenderer.on("turn-event", (_e, c) => fn(c)),
  onTurnEnd: (fn) => ipcRenderer.on("turn-end", (_e, r) => fn(r)),
  onWindowActive: (fn) => ipcRenderer.on("window-active", (_e, on) => fn(on === true)),
  // 內建瀏覽器(renderer/browser.js):只送分頁 id、中欄 bounds、用戶動作;網址只有用戶在網址列自己打的
  onBrowserEvent: (fn) => ipcRenderer.on("browser-event", (_e, ev) => fn(ev)),
  browserExpand: (id, bounds) => ipcRenderer.invoke("browser-expand", id, bounds),
  browserBounds: (bounds) => ipcRenderer.send("browser-bounds", bounds),
  browserCollapse: () => ipcRenderer.invoke("browser-collapse"),
  browserTakeover: (id) => ipcRenderer.invoke("browser-takeover", id),
  browserHandback: (id) => ipcRenderer.invoke("browser-handback", id),
  browserUserDone: (id, choice) => ipcRenderer.invoke("browser-user-done", id, choice),
  browserNavigate: (id, url) => ipcRenderer.invoke("browser-navigate", id, url),
  browserReload: (id) => ipcRenderer.invoke("browser-reload", id),
  browserOpenLive: (sessionId, snapshotId) => ipcRenderer.invoke("browser-open-live", sessionId, snapshotId),
  browserShowLive: (url) => ipcRenderer.invoke("browser-show-live", url),   // 點瀏覽卡:開即時頁(分頁還在就切過去)
  browserSnapshot: (sessionId, snapshotId) => ipcRenderer.invoke("browser-snapshot", sessionId, snapshotId),
  browserHistory: (sessionId) => ipcRenderer.invoke("browser-history", sessionId),
  browserBlockVisible: (on) => ipcRenderer.send("browser-block-visible", on),
  browserOpenExternal: (id) => ipcRenderer.invoke("browser-open-external", id),
  browserPrefs: () => ipcRenderer.invoke("browser-prefs"),
  browserPrefsSet: (p) => ipcRenderer.invoke("browser-prefs-set", p),
  browserClear: () => ipcRenderer.invoke("browser-clear"),
  pineInstall: (ref) => ipcRenderer.invoke("pine-install", ref ? { session: ref.session, id: ref.id, strategy: ref.strategy } : null),
});
