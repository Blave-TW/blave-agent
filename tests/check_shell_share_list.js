// 設定 › 公開連結 + 分享框達上限 + 閱讀層頁首的「存成 PDF」鈕(spec-share-list-0.1.8 A1 / C / D / E;spec-report-pdf-0.1.8 DT1 / DT2)。
//   ① 純邏輯(從 renderer/report-sharelist.js 切出來跑):來源三值、標題可不可點、原因行、公開時間、上限判定。
//   ② shell/reportshare.js:share/list 與「只憑代碼取消」送出的欄位逐一列舉(api 對多的欄位 / 混用指名方式回 400)、
//      列的形狀清理、state 帶四個數、429 先看 error_code。有 api 原始碼時對照端點與代號。
//   ③ 接線:IPC、白名單、字串(spec E 逐字)。
//   ④ 用隨包的 Electron(看不見的視窗)開真的 index.html(window.blave 換成假的):分類位置、四態、列、複製、取消、開報告、
//      分享框達上限、PDF 鈕的位置與狀態。
// 跑法:node tests/check_shell_share_list.js
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os");
const GATE = require("./_electron_gate");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer"), MONO = path.join(__dirname, "..", "..");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 1500))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const keys = (o) => Object.keys(o).sort().join();

if (!process.versions.electron) {
  (async () => {
    // ── ① 純邏輯 ──
    const src = read(path.join(R, "report-sharelist.js")), A = "/* ── 純邏輯", B = "/* ── 純邏輯到此 ── */";
    const P = {}; vm.runInNewContext(src.slice(src.indexOf(A), src.indexOf(B)) + "\nObject.assign(this, { shlSource, shlOpenable, shlWhyKey, shlFmtTime, shlLimit, shlLimitFromCode, SHL_FLASH_MS, SHL_KIND_KEYS });", P);
    const here = { origin: "desktop", local: true, reportId: "a", sourceExists: null }, away = { origin: "desktop", local: false, reportId: "a", sourceExists: null };
    const cl = { origin: "cloud", local: false, reportId: "b", sourceExists: true }, clGone = { origin: "cloud", local: false, reportId: "b", sourceExists: false }, clUnk = { origin: "cloud", local: false, reportId: "b", sourceExists: null };
    ok("① 來源三個值:desktop 袋且這台找得到 = 這台電腦;找不到 = 電腦版;cloud 袋 = 雲端", [here, away, cl, clGone].map(P.shlSource).join() === "here,desktop,cloud,cloud");
    ok("① 標題可點:這台找得到的、雲端原報告在且主機在跑的;其餘純文字(沒有 report_id 也是)", P.shlOpenable(here, false) && !P.shlOpenable(away, true) && P.shlOpenable(cl, true) && !P.shlOpenable(cl, false) && !P.shlOpenable(clGone, true) && !P.shlOpenable(clUnk, true) && !P.shlOpenable({ ...here, reportId: null }, true));
    ok("① 原因行:電腦版找不到原檔 / 雲端原報告被移除各一句;雲端只是現在開不了(主機沒在跑)不加說明行;api 不知道在不在(索引讀不到)也不講「已被移除」", P.shlWhyKey(away) === "shl.gone" && P.shlWhyKey(clGone) === "shl.goneCloud" && P.shlWhyKey(here) === null && P.shlWhyKey(cl) === null && P.shlWhyKey(clUnk) === null);
    const now = new Date(2026, 8, 28, 10, 0).getTime(), sec = (y, m, d, h, mi) => Math.floor(new Date(y, m - 1, d, h, mi).getTime() / 1000);
    ok("① 公開時間:今年 MM/DD HH:mm;不是今年加年份;壞值 → 空", P.shlFmtTime(sec(2026, 9, 26, 8, 12), now) === "09/26 08:12" && P.shlFmtTime(sec(2025, 12, 31, 23, 5), now) === "2025/12/31 23:05" && P.shlFmtTime(NaN, now) === "" && P.shlFmtTime("x", now) === "");
    const L = (a, b, c, d) => ({ liveCount: a, liveLimit: b, todayCount: c, dailyLimit: d });
    ok("① 上限:50 份滿 → live;今天 20 次滿 → daily;兩個都滿先講每日(同 web 與 api:撤了也公開不了)", JSON.stringify(P.shlLimit(L(50, 50, 3, 20), "new")) === '{"kind":"live","n":50}' && JSON.stringify(P.shlLimit(L(49, 50, 20, 20), "new")) === '{"kind":"daily","n":20}' && P.shlLimit(L(50, 50, 20, 20), "new").kind === "daily" && P.shlLimit(L(49, 50, 19, 20), "new") === null);
    ok("① 「更新公開版本」不佔份數:50 份上限不擋更新,每日次數照擋", P.shlLimit(L(50, 50, 3, 20), "update") === null && P.shlLimit(L(50, 50, 20, 20), "update").kind === "daily");
    ok("① 數字沒給(舊 api / 形狀不對)= 不擋,送出時 api 再守", P.shlLimit(null, "new") === null && P.shlLimit(L(null, null, null, null), "new") === null && P.shlLimit(L(60, 0, 1, 0), "new") === null);
    ok("① 送出時才被擋:代號 → 同一個形狀;api 沒給數字就拿開框時問到的上限", JSON.stringify(P.shlLimitFromCode("LIVE_LIMIT", 50, null)) === '{"kind":"live","n":50}' && P.shlLimitFromCode("DAILY_LIMIT", null, L(1, 50, 20, 20)).n === 20 && P.shlLimitFromCode("RATE_LIMITED", 5, null) === null);

    // ── ② reportshare.js ──
    const RS = require(path.join(SHELL, "reportshare.js"));
    const row = (o) => ({ code: "Abcd1234", origin: "desktop", report_id: "tw-1", title: "台股晨報", type: "morning", published_at: 1790000000, byline: null, url_path: "/r/Abcd1234", source_exists: null, ...o });
    const mk = (res, creds) => { const calls = []; let cur = creds === undefined ? { token: "tok", appSecret: "sec" } : creds;
      const c = RS.createShareClient({ apiBase: "https://api.x", getCreds: () => cur, readLocal: () => null, post: async (u, b) => { calls.push({ u, b }); return typeof res === "function" ? res(u, b) : res; } }); return { c, calls, swap: (n) => { cur = n; } }; };
    let x = mk({ status: 200, body: { shares: [row({}), row({ code: "Cloud999", origin: "cloud", source_exists: true, byline: " Wei ", type: null }), row({ code: "bad code!" }), row({ code: "Zzzz1111", origin: "web" }), row({ code: "Yyyy2222", published_at: "x" }), null], live_count: 2, live_limit: 50, today_count: 1, daily_limit: 20 } });
    let r = await x.c.list();
    ok("② share/list:body 只有 token 與 app_secret;端點 /oauth/desktop/share/list", x.calls.length === 1 && x.calls[0].u === "https://api.x/oauth/desktop/share/list" && keys(x.calls[0].b) === "app_secret,token", JSON.stringify(x.calls));
    ok("② 列的形狀:代碼 / 來源 / 時間不對的那一列丟掉;byline null = 匿名、字串 trim;source_exists 只有 cloud 袋有意義;url_path 不轉交(網址由畫面拿代碼自己組)", r.code === "OK" && r.shares.length === 2 && keys(r.shares[0]) === "byline,code,origin,published_at,reportId,sourceExists,title,type"
      && r.shares[0].sourceExists === null && RS.cleanListRow(row({ origin: "cloud", source_exists: null })).sourceExists === null && RS.cleanListRow(row({ origin: "cloud", source_exists: false })).sourceExists === false && r.shares[0].byline === null && r.shares[1].sourceExists === true && r.shares[1].byline === "Wei" && r.shares[1].type === null, JSON.stringify(r.shares));
    ok("② 類型:research / morning / performance 原樣;不認得的類型 → null(那一列照畫,只是不出類型字)", ["research", "morning", "performance"].every((k) => RS.cleanListRow(row({ type: k })).type === k) && RS.cleanListRow(row({ type: "journal" })).type === null && RS.cleanListRow(row({ type: 5 })).type === null);
    ok("① 清單的類型字:三類各一個 key", JSON.stringify(P.SHL_KIND_KEYS) === '{"research":"shl.kind.research","morning":"shl.kind.morning","performance":"shl.kind.performance"}');
    ok("② 整包帶四個數(份數 / 上限 / 今天次數 / 每日上限);不是非負整數的當沒給", JSON.stringify(r.limits) === '{"liveCount":2,"liveLimit":50,"todayCount":1,"dailyLimit":20}' && JSON.stringify(RS.cleanLimits({ live_count: -1, live_limit: "50", today_count: 1.5 })) === '{"liveCount":null,"liveLimit":null,"todayCount":null,"dailyLimit":null}');
    ok("② 標題裡的控制字元收成空白、最長 200", RS.cleanListRow(row({ title: " a\n\tb " + "x".repeat(300) })).title.length === 200 && RS.cleanListRow(row({ title: "a\nb" })).title === "a b" && RS.cleanListRow(row({ title: 5 })).title === "");
    ok("② shares 不是陣列 → UNREACH(畫「讀不到」);沒登入 / 舊登入不出門", (await mk({ status: 200, body: {} }).c.list()).code === "UNREACH" && (await mk({ status: 200, body: {} }, null).c.list()).code === "NO_LOGIN" && (await mk({ status: 200, body: {} }, { token: "t" }).c.list()).code === "RELOGIN");
    x = mk({ status: 200, body: { shares: [] } }); const p = x.c.list(); x.swap({ token: "other", appSecret: "s" });
    ok("② 請求途中換了帳號 → 丟掉(那份清單是上一個人的)", (await p).code === "UNREACH");
    x = mk({ status: 200, body: {} }); r = await x.c.revokeCode("Abcd1234");
    ok("② 清單上的取消:只給 { code }(不帶 view / id / origin——混用 api 回 400)", r.code === "OK" && x.calls[0].u.endsWith("/oauth/desktop/share/revoke") && keys(x.calls[0].b) === "app_secret,code,token" && x.calls[0].b.code === "Abcd1234", JSON.stringify(x.calls));
    x = mk({ status: 200, body: {} });
    ok("② 代碼形狀不對 → 不出門;404 = 別處已經取消(NOT_PUBLIC)", (await x.c.revokeCode("../x")).code === "BAD_ARGS" && (await x.c.revokeCode(7)).code === "BAD_ARGS" && x.calls.length === 0 && (await mk({ status: 404, body: {} }).c.revokeCode("Abcd1234")).code === "NOT_PUBLIC");
    x = mk({ status: 200, body: {} }); await x.c.revoke("local", "tw-1");
    ok("② 閱讀頁的取消照舊:{ view, id }", keys(x.calls[0].b) === "app_secret,id,token,view");
    x = mk({ status: 200, body: { share: null, display_name: "Wei", live_count: 50, live_limit: 50, today_count: 0, daily_limit: 20 } }); r = await x.c.state("local", "tw-1");
    ok("② share/state 帶回四個數(開分享框時就知道滿了沒有)", r.code === "OK" && r.limits.liveCount === 50 && r.limits.liveLimit === 50 && r.limits.dailyLimit === 20, JSON.stringify(r));
    const F = (status, body) => RS.failCode({ status, body }, "publish");
    ok("② 429 先看 error_code:LIVE_LIMIT / DAILY_LIMIT 各自的代號,ERR429 與其餘才是每分鐘限流", F(429, { error_code: "LIVE_LIMIT" }) === "LIVE_LIMIT" && F(429, { error_code: "DAILY_LIMIT" }) === "DAILY_LIMIT" && F(429, { error_code: "ERR429" }) === "RATE_LIMITED" && F(429, {}) === "RATE_LIMITED" && F(429, "x") === "RATE_LIMITED");
    x = mk({ status: 429, body: { error_code: "DAILY_LIMIT", limit: 20, current: 20, resets_at: 1790000000 } }); r = await x.c.publish("cloud", "tw-1", { byline: "anonymous", confirmed: true, update: true });
    ok("② 送出被上限擋:代號 + 上限的數字(畫面那一句要用)", JSON.stringify(r) === '{"code":"DAILY_LIMIT","limit":20}', JSON.stringify(r));
    const API = [process.env.BLAVE_API_DIR, path.join(MONO, "api"), path.join(MONO, "api-integ-018")].filter(Boolean).map((d) => path.join(d, "openclaw", "desktop_auth.py")).find((f) => fs.existsSync(f) && /share\/list/.test(read(f)));
    if (!API) console.log("SKIP  ② 與 api 對照(需要含 share/list 的 api 原始碼:monorepo 版面或 BLAVE_API_DIR)");
    else { const a = read(API) + read(path.join(path.dirname(API), "agent_report_share.py"));
      ok("② api 有這支端點與這幾個代號 / 欄位(" + path.relative(MONO, API) + ")", /route\("\/share\/list", methods=\["POST"\]\)/.test(a) && /"code" if "code" in body/.test(a) && /LIVE_LIMIT/.test(a) && /DAILY_LIMIT/.test(a) && /live_count/.test(a) && /daily_limit/.test(a) && /source_exists/.test(a) && /url_path/.test(a)); }

    // ── ③ 接線 ──
    const mainSrc = read(path.join(SHELL, "main.js")), pre = read(path.join(SHELL, "preload.js"));
    ok("③ IPC:清單與取消都不從畫面收憑證;取消只收代碼;「在不在這台電腦」由主行程看檔", /handle\("share-list", \(\) => shareList\(\), \{ code: "UNREACH" \}\)/.test(mainSrc) && /handle\("share-revoke-code", \(_e, code\) => shareClient\(\)\.revokeCode\(code\)/.test(mainSrc)
      && /shareList: \(\) => ipcRenderer\.invoke\("share-list"\)/.test(pre) && /shareRevokeCode: \(code\) => ipcRenderer\.invoke\("share-revoke-code", code\)/.test(pre) && /local: x\.origin === "desktop" && rptLocalHas\(x\.reportId\)/.test(mainSrc));
    ok("③ 埋點 share_list_open 在外殼白名單(≤ 16 字);送出點在切到分類那一層,不在畫", require(path.join(SHELL, "telemetry.js")).EVENTS.feature_used.name.indexOf("share_list_open") >= 0 && "share_list_open".length <= 16 && /function shlOpen\(\) \{\s*libTrack\("share_list_open"\);/.test(src) && !/libTrack\("share_list_open"\)/.test(src.slice(src.indexOf("function shlPaint"))));
    const STR = (() => { const sb = {}; vm.runInNewContext(read(path.join(R, "strings.js")) + "\nthis.S = STRINGS;", sb); return sb.S; })();
    const E = { "set.cat.shares": ["公開連結", "Public links"], "shl.title": ["公開中的報告", "Public reports"], "shl.count": ["{n}／{max}", "{n} / {max}"], "shl.kind.research": ["研究報告", "Research report"], "shl.kind.morning": ["市場報告", "Market report"], "shl.kind.performance": ["績效報告", "Performance report"],
      "shl.src.here": ["這台電腦", "This computer"], "shl.src.desktop": ["電腦版", "Desktop"], "shl.src.cloud": ["雲端", "Cloud"], "shl.gone": ["這台電腦上找不到原檔，公開版本仍有效。", "The original file isn't on this computer; the public version is still live."],
      "shl.empty": ["目前沒有公開中的報告。要公開，打開一份報告按「分享」。", "No public reports right now. To publish one, open a report and choose Share."], "shl.loadFail": ["讀不到公開連結，請檢查網路後再試。", "Couldn't load your public links. Check your connection and try again."],
      "shl.gate": ["公開連結掛在你的 Blave 帳號下，登入後才看得到。", "Public links are tied to your Blave account. Sign in to see them."], "shl.countAria": ["公開中 {n} 份，上限 {max} 份", "{n} of {max} public reports"],
      "shr.limitLive": ["公開中的報告已達 {n} 份上限。先取消幾份，再公開這一份。", "You've reached the limit of {n} public reports. Stop sharing a few, then publish this one."], "shr.limitLiveGo": ["看公開連結", "View public links"],
      "shr.limitDaily": ["今天已經公開 {n} 次，達到每日上限。請明天再試。", "You've published {n} times today, the daily limit. Try again tomorrow."],
      "pdf.btn": ["存成 PDF", "Save as PDF"], "pdf.saving": ["存成中…", "Saving…"], "pdf.saved": ["已存成", "Saved"], "pdf.failTitle": ["沒有存成 PDF", "Couldn't save the PDF"], "pdf.failBody": ["檔案沒有寫進去。換個位置，或稍後再試一次。", "The file wasn't saved. Try another location, or try again later."] };
    const off = Object.keys(E).filter((k) => STR.zh[k] !== E[k][0] || STR.en[k] !== E[k][1]);
    ok("③ 字串逐字同 spec(清單 E 表、上限 D 表的數字改成 {n}、PDF 的 DT2 表)", off.length === 0, off.join());
    const WEB_PO = path.join(MONO, "web", "app", "translations");
    if (!fs.existsSync(WEB_PO)) console.log("SKIP  ③ 雲端原報告被移除那一句與 web 逐字比對(需要 monorepo 版面)");
    else { const g = (lang) => { const m = /msgid "workspace_share_source_gone"\nmsgstr "([^"]*)"/.exec(read(path.join(WEB_PO, lang, "LC_MESSAGES", "messages.po"))); return m && m[1]; };
      ok("③ shl.goneCloud 逐字同 web workspace_share_source_gone", STR.zh["shl.goneCloud"] === g("zh") && STR.en["shl.goneCloud"] === g("en"), JSON.stringify([STR.zh["shl.goneCloud"], g("zh")])); }

    ok("③ 取消確認框的取消鈕(shr.keep;報告頁與公開連結清單共用):繼續分享 / Keep sharing", STR.zh["shr.keep"] === "繼續分享" && STR.en["shr.keep"] === "Keep sharing" && /cancel: t\("shr\.keep"\)/.test(src) && /cancel: t\("shr\.keep"\)/.test(read(path.join(R, "report-share.js"))));

    const bin = GATE.bin(SHELL, "④");
    if (!bin) { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
    const sub = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" }).status;
    const n = red + (sub == null ? 1 : sub);
    console.log(n ? `\n${n} 紅` : "\nALL PASS"); process.exit(n ? 1 : 0);
  })();
  return;
}

// ── ④ Electron(看不見的視窗)──
const { app, BrowserWindow } = require("electron");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-shl-e-")));
const NOW = Math.floor(Date.now() / 1000);
const doc = (id, type) => ({ report: { schema_version: "1.6", id, type, title: "T-" + id, created_at: NOW - 3600, blocks: [{ type: "meta", title: "標題 " + id, origin: "chat" }, { type: "text", variant: "lead", markdown: "第一句。" }] }, images: {} });
const LIST = [{ id: "res", title: "R", type: "research", created_at: NOW - 100, mtime: (NOW - 100) * 1000 }, { id: "perf", title: "P", type: "performance", created_at: NOW - 200, mtime: (NOW - 200) * 1000 }, { id: "odd", title: "O", type: "journal", created_at: NOW - 250, mtime: (NOW - 250) * 1000 }, { id: "pub", title: "Pub", type: "morning", created_at: NOW - 300, mtime: (NOW - 300) * 1000 }];
const SHARE = { code: "Pubb1234", published_at: NOW - 3600, byline: null, source_stored_at: null, report_stored_at: null };
const ROWS = [
  { code: "Old11111", origin: "cloud", local: false, reportId: "c-gone", title: "BTC 週報", type: "morning", published_at: NOW - 86400 * 400, byline: null, sourceExists: false },
  { code: "Pubb1234", origin: "desktop", local: true, reportId: "pub", title: "台股晨報 <b>x</b> " + "長".repeat(80), type: "morning", published_at: NOW - 3600, byline: null, sourceExists: null },
  { code: "Away2222", origin: "desktop", local: false, reportId: "away", title: "加密收盤報", type: null, published_at: NOW - 7200, byline: "Wei", sourceExists: null },
  { code: "Cld33333", origin: "cloud", local: false, reportId: "c-1", title: "融資研究", type: "research", published_at: NOW - 9000, byline: null, sourceExists: true }];
const STUB = `window.__s = { calls: [], tracked: [], copied: [], list: { code: "OK", shares: ${JSON.stringify(ROWS)}, limits: { liveCount: 4, liveLimit: 50, todayCount: 1, dailyLimit: 20 } }, listDelay: 0, revoke: { code: "OK" }, pdf: { code: "OK" }, pdfHold: null, saving: null,
  state: { res: { code: "OK", share: null, displayName: null, limits: { liveCount: 50, liveLimit: 50, todayCount: 1, dailyLimit: 20 } }, pub: { code: "OK", share: ${JSON.stringify(SHARE)}, displayName: null, limits: { liveCount: 4, liveLimit: 50, todayCount: 20, dailyLimit: 20 } } } };
const __fixed = {
  getLocale: async () => "zh-TW", loadConnection: async () => ({ kind: "claude" }), detectAgents: async () => ({ claude: { installed: true, loggedIn: true }, codex: { installed: false } }),
  listStrategies: async () => [], listSessions: async () => [], loadSession: async () => [], loadSessionImages: async () => [], updateState: async () => ({ phase: "idle", current: "0.0.0" }),
  hasBlaveToken: async () => true, ensureEngine: async () => ({}), libraryList: async () => ({ strategies: [], signedIn: true, dataAccess: "included" }),
  reportsList: async () => ({ reports: ${JSON.stringify(LIST)} }), reportLoad: async (id) => (${JSON.stringify({ res: doc("res", "research"), perf: doc("perf", "performance"), odd: doc("odd", "journal"), pub: doc("pub", "morning") })})[id] || null,
  shareState: async (view, id) => window.__s.state[id] || { code: "UNREACH" },
  sharePublish: async (view, id, a) => { window.__s.calls.push(["publish", view, id, a]); return { code: "LIVE_LIMIT", limit: 50 }; },
  shareList: async () => { window.__s.calls.push(["list"]); if (window.__s.listDelay) await new Promise((r) => setTimeout(r, window.__s.listDelay)); return window.__s.list; },
  shareRevokeCode: async (code) => { window.__s.calls.push(["revokeCode", code]); return window.__s.revoke; },
  reportPdf: async (view, id, ver, lang) => { window.__s.calls.push(["pdf", view, id, ver, lang]); if (window.__s.pdfHold) await new Promise((r) => { window.__s.pdfHold = r; }); return window.__s.pdf; },
  onReportPdfSaving: (fn) => { window.__s.saving = fn; },
  openExternal: async (u) => { window.__s.calls.push(["ext", u]); return true; }, trackFeature: (n) => { window.__s.tracked.push(n); },
};
window.blave = new Proxy(__fixed, { get: (o, k) => (k in o ? o[k] : typeof k !== "string" ? undefined : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {} : async () => undefined) });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  ④ 逾時(90 秒)"); process.exit(1); }, 90000).unref();

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const preload = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(preload, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1200);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  await js(`Object.defineProperty(navigator, "clipboard", { value: { writeText: async (x) => { window.__s.copied.push(x); } }, configurable: true })`);
  const T = (k, v) => js(`t(${JSON.stringify(k)}, ${JSON.stringify(v || {})})`);
  const calls = (name) => js(`JSON.stringify(window.__s.calls.filter((c) => c[0] === ${JSON.stringify(name)}))`).then(JSON.parse);
  const openCat = async () => { await js(`(async () => { if (document.getElementById("set-scrim").hidden) await setOpen(); setCat("shares"); })()`); };
  const pane = () => js(`(() => { const b = document.getElementById("set-shares"), q = (s) => b.querySelector(s), all = (s) => [...b.querySelectorAll(s)];
    return { hidden: b.hidden, head: q(".shl-head h6") && q(".shl-head h6").textContent, count: q(".shl-count") ? q(".shl-count").textContent : null, aria: q(".shl-count") ? q(".shl-count").getAttribute("aria-label") : null, sk: all(".shl-sk").length, msg: q(".shl-msg") ? q(".shl-msg").textContent : null,
      mark: all(".fault-mark").length, btn: q(".shl-msgrow .btn-out") ? q(".shl-msgrow .btn-out").textContent : null,
      rows: all(".shl-row").map((r) => { const n = r.querySelector(".shl-name"), g = r.querySelector(".shl-gone"), a = [...r.querySelectorAll(".shl-acts button")]; return { tag: n.tagName, name: n.textContent, html: n.children.length, sub: r.querySelector(".shl-sub").textContent, mono: r.querySelector(".shl-sub .mono").textContent,
        gone: g ? g.textContent : null, acts: a.map((x) => x.className + ":" + x.textContent).join("|"), clip: n.scrollWidth > n.clientWidth, w: Math.round(r.getBoundingClientRect().width), h: Math.round(a[0].getBoundingClientRect().height) }; }) }; })()`);

  // 分類
  const cats = await js(`[...document.querySelectorAll("#set-cats .set-cat")].map((b) => b.dataset.setCat).join()`);
  ok("④ 設定分類六個:「公開連結」排在帳號與方案後、隱私前", cats === "display,model,src,plan,shares,priv", cats);

  // 載入中 → 有資料
  await js(`window.__s.listDelay = 700`); await openCat(); await wait(100);
  let p = await pane();
  ok("④ 載入 200ms 內不畫骨架;小標常駐、載入中不顯示份數", !p.hidden && p.head === (await T("shl.title")) && p.sk === 0 && p.count === null && p.rows.length === 0, JSON.stringify(p));
  await wait(300); p = await pane();
  ok("④ 超過 200ms:骨架三列", p.sk === 3 && p.count === null, JSON.stringify(p));
  await wait(700); p = await pane();
  await js(`window.__s.listDelay = 0`);
  const yr = new Date((NOW - 86400 * 400) * 1000).getFullYear();
  ok("④ 有資料:四列、公開時間新到舊;份數「4／50」、可及名稱是整句", p.sk === 0 && p.rows.length === 4 && p.rows.map((r) => r.name.slice(0, 4)).join() === "台股晨報,加密收盤,融資研究,BTC " && p.count === "4／50" && p.aria === (await T("shl.countAria", { n: "4", max: "50" })), JSON.stringify(p));
  ok("④ 標題:這台找得到 = 鈕;電腦版找不到 / 雲端(主機沒在跑、原報告不在)= 純文字;不可信字串當字畫、單行截斷", p.rows.map((r) => r.tag).join() === "BUTTON,SPAN,SPAN,SPAN" && p.rows[0].html === 0 && p.rows[0].name.includes("<b>x</b>") && p.rows[0].clip, JSON.stringify(p.rows.map((r) => [r.tag, r.html, r.clip])));
  ok("④ meta 行:類型 · 來源 · 公開時間 · 署名;類型缺就不出;不是今年的加年份;匿名用既有那個字", p.rows[0].sub === "市場報告 · 這台電腦 · " + p.rows[0].mono + " · 匿名" && /^\d\d\/\d\d \d\d:\d\d$/.test(p.rows[0].mono) && p.rows[1].sub === "電腦版 · " + p.rows[1].mono + " · Wei" && p.rows[2].sub.startsWith("研究報告 · 雲端 · ") && p.rows[3].mono.startsWith(yr + "/"), JSON.stringify(p.rows.map((r) => r.sub)));
  ok("④ 原因行:電腦版找不到原檔、雲端原報告被移除;雲端只是現在開不了不加", p.rows[0].gone === null && p.rows[1].gone === (await T("shl.gone")) && p.rows[2].gone === null && p.rows[3].gone === (await T("shl.goneCloud")), JSON.stringify(p.rows.map((r) => r.gone)));
  ok("④ 動作:複製連結(btn-out 32 高)+ 取消分享(btn-quiet);列不超出內容欄", p.rows.every((r) => r.acts === "btn-out:複製連結|btn-quiet:取消分享" && r.h === 32 && r.w <= 440), JSON.stringify(p.rows.map((r) => [r.acts, r.h, r.w])));
  ok("④ 埋點:切到這一類送 share_list_open", (await js(`JSON.stringify(window.__s.tracked)`)).includes("share_list_open"));

  // 複製
  const cp = await js(`(async () => { const b = document.querySelector("#set-shares .shl-row .btn-out"), w0 = b.offsetWidth; b.click(); await new Promise((r) => setTimeout(r, 60)); return { text: b.textContent, w0, w1: b.offsetWidth, copied: window.__s.copied.slice(), live: document.getElementById("sr-live").textContent, tracked: window.__s.tracked.slice() }; })()`);
  ok("④ 複製連結:網址由代碼組(blave.org/zh/r/<代碼>?src=research_link)、鈕字換「已複製」且寬度不變、讀屏念一次、埋點 share_copy", cp.copied.join() === "https://blave.org/zh/r/Pubb1234?src=research_link" && cp.text === "已複製" && cp.w0 === cp.w1 && cp.live === "已複製" && cp.tracked.includes("share_copy"), JSON.stringify(cp));
  await wait(1300);
  ok("④ 1.2 秒後回「複製連結」", (await js(`document.querySelector("#set-shares .shl-row .btn-out").textContent`)) === "複製連結");

  // 取消分享(第二列:原檔不在這台電腦)
  await js(`document.querySelectorAll("#set-shares .shl-row")[1].querySelector(".btn-quiet").click()`); await wait(200);
  let c = await js(`(() => { const g = (x) => document.getElementById(x), ps = [...g("del-body").children]; return { open: !g("del-scrim").hidden, title: g("del-title").textContent, first: ps[0].textContent, firstCls: ps[0].className, fw: getComputedStyle(ps[0]).fontWeight, second: ps[1] && ps[1].textContent, n: ps.length, ok: g("del-ok").textContent, okCls: g("del-ok").className, cancel: g("del-cancel").textContent, focus: document.activeElement && document.activeElement.id }; })()`);
  ok("④ 取消確認:沿用既有取消框的字,內文第一行是那一份的標題(600);焦點在「繼續分享」、確認鈕中性填色", c.open && c.title === (await T("shr.revokeTitle")) && c.first === "加密收盤報" && c.fw === "600" && c.second === (await T("shr.revokeBody")) && c.n === 2 && c.ok === (await T("shr.revokeOk")) && c.okCls === "btn-fill" && c.cancel === (await T("shr.keep")) && c.focus === "del-cancel", JSON.stringify(c));
  await js(`document.getElementById("del-cancel").click()`); await wait(150);
  ok("④ 「繼續分享」:不送、列還在", (await calls("revokeCode")).length === 0 && (await pane()).rows.length === 4);
  await js(`window.__s.revoke = { code: "UNREACH" }; document.querySelectorAll("#set-shares .shl-row")[1].querySelector(".btn-quiet").click()`); await wait(150);
  await js(`document.getElementById("del-ok").click()`); await wait(300);
  c = await js(`(() => { const g = (x) => document.getElementById(x); return { open: !g("del-scrim").hidden, title: g("del-title").textContent, body: g("del-body").textContent, single: g("del-cancel").hidden }; })()`);
  ok("④ 取消失敗:標題寫結果「沒有取消分享」、內文「連結仍然有效…」,列與份數不動", c.open && c.title === (await T("shr.revokeFailTitle")) && c.body === (await T("shr.revokeFailBody")) && c.single && (await pane()).count === "4／50", JSON.stringify(c));
  await js(`document.getElementById("del-ok").click()`); await wait(150);
  await js(`window.__s.revoke = { code: "OK" }; window.__s.tracked = []; document.querySelectorAll("#set-shares .shl-row")[1].querySelector(".btn-quiet").click()`); await wait(150);
  await js(`document.getElementById("del-ok").click()`); await wait(300);
  p = await pane();
  const rv = await calls("revokeCode");
  ok("④ 取消成功:只送代碼、該列移除、份數減一、讀屏念一次、埋點 share_revoke;確認框關了、設定還開著", JSON.stringify(rv[rv.length - 1]) === '["revokeCode","Away2222"]' && p.rows.length === 3 && p.count === "3／50" && !p.rows.some((r) => r.name === "加密收盤報")
    && (await js(`document.getElementById("sr-live").textContent`)) === (await T("shl.revoked")) && (await js(`JSON.stringify(window.__s.tracked)`)) === '["share_revoke"]' && (await js(`document.getElementById("del-scrim").hidden && !document.getElementById("set-scrim").hidden`)), JSON.stringify([rv, p.count]));

  // 空 / 讀不到 / 未登入
  await js(`window.__s.list = { code: "OK", shares: [], limits: { liveCount: 0, liveLimit: 50 } }; setCat("acct"); setCat("shares")`); await wait(200); p = await pane();
  ok("④ 每次切到這一類重抓;空:一句引導、不顯示份數", (await calls("list")).length === 2 && p.rows.length === 0 && p.msg === (await T("shl.empty")) && p.count === null && p.btn === null, JSON.stringify(p));
  await js(`window.__s.list = { code: "UNREACH" }; setCat("shares")`); await wait(200); p = await pane();
  ok("④ 讀不到:錯誤記號 + 一句 +「重新載入」", p.msg === (await T("shl.loadFail")) && p.mark === 1 && p.btn === (await T("br.reload")) && p.count === null, JSON.stringify(p));
  await js(`window.__s.list = { code: "OK", shares: ${JSON.stringify(ROWS.slice(1))}, limits: { liveCount: 3, liveLimit: 50 } }; document.querySelector("#set-shares .shl-msgrow .btn-out").click()`); await wait(200);
  ok("④ 「重新載入」重抓一次", (await pane()).rows.length === 3);
  await js(`window.__s.list = { code: "NO_LOGIN" }; setCat("shares")`); await wait(200); p = await pane();
  ok("④ 未登入:一句 +「登入 Blave」(沒有錯誤記號)", p.msg === (await T("shl.gate")) && p.mark === 0 && p.btn === (await T("cn.blave.btn")), JSON.stringify(p));
  await js(`document.querySelector("#set-shares .shl-msgrow .btn-out").click()`); await wait(100);
  ok("④ …點了切到「帳號與方案」", (await js(`document.querySelector('.set-cat[aria-current="true"]').dataset.setCat`)) === "plan");

  // 標題 = 打開報告
  await js(`window.__s.list = { code: "OK", shares: ${JSON.stringify(ROWS)}, limits: { liveCount: 4, liveLimit: 50 } }; setCat("shares")`); await wait(200);
  await js(`document.querySelector("#set-shares button.shl-name").click()`); await wait(900);
  const go = await js(`(() => { const g = (x) => document.getElementById(x); return { set: g("set-scrim").hidden, rpt: !g("rpt").hidden, read: !g("rpt-read").hidden, title: (g("rpt-read").querySelector(".rb-title") || {}).textContent, well: !!document.querySelector("#rpt-read > .shr-well") }; })()`);
  ok("④ 點標題:關設定、開那份報告的閱讀頁(本機視角)", go.set && go.rpt && go.read && go.title === "標題 pub" && go.well, JSON.stringify(go));

  // 閱讀頁正開著同一份 → 從清單取消,公開列同步收起
  await openCat(); await wait(200);
  await js(`document.querySelector("#set-shares .shl-row .btn-quiet").click()`); await wait(150);
  await js(`document.getElementById("del-ok").click()`); await wait(300);
  ok("④ 閱讀頁開著同一份:清單取消後公開列同步收起", (await js(`!document.querySelector("#rpt-read > .shr-well") && !document.getElementById("rpt-share").hidden`)));
  await js(`window.__s.list = { code: "OK", shares: [${JSON.stringify({ code: "Perf5555", origin: "desktop", local: false, reportId: "p-1", title: "九月績效", type: "performance", published_at: NOW - 60, byline: "User_AB12CD34", sourceExists: null })}, ${JSON.stringify({ code: "Jour6666", origin: "cloud", local: false, reportId: "j-1", title: "J", type: "constructor", published_at: NOW - 90, byline: null, sourceExists: null })}], limits: { liveCount: 2, liveLimit: 50 } }; setCat("acct"); setCat("shares")`); await wait(250); p = await pane();
  ok("④ 績效報告那一列:類型字「績效報告」、署名原樣;不認得的類型不出類型字(不是空白、null 或 undefined)", p.rows.length === 2 && p.rows[0].sub === "績效報告 · 電腦版 · " + p.rows[0].mono + " · User_AB12CD34" && p.rows[1].sub === "雲端 · " + p.rows[1].mono + " · 匿名", JSON.stringify(p.rows.map((r) => r.sub)));
  await js(`setClose()`); await wait(100);

  // PDF 鈕
  const hd = () => js(`(() => { const g = (x) => document.getElementById(x), r = (n) => n.getBoundingClientRect(), s = g("rpt-share"), p = g("rpt-pdf");
    return { share: !s.hidden, pdf: !p.hidden, text: p.textContent, dis: p.disabled, shareDis: s.disabled, cls: p.className, h: Math.round(r(p).height), edge: Math.round(r(p).right - r(g("rpt-read")).right), gap: s.hidden ? null : Math.round(r(p).left - r(s).right), left: Math.round(r(p).left) }; })()`);
  const openRead = async (id) => { await js(`(async () => { if (!rptBag().open) await rptOpen(); await new Promise((r) => setTimeout(r, 150)); rptShowRead(${JSON.stringify(id)}); })()`); await wait(500); };
  await js(`rptBack()`); await wait(100);
  ok("④ 清單模式:「存成 PDF」不出", !(await hd()).pdf);
  await openRead("res"); let h = await hd(); const leftRes = h.left;
  ok("④ 未公開的研究報告:〔分享〕〔存成 PDF〕,PDF 在最右、右緣對齊內容欄、間距 8、32 高外框鈕", h.share && h.pdf && h.text === "存成 PDF" && h.cls === "btn-out" && h.h === 32 && Math.abs(h.edge) <= 1 && h.gap === 8, JSON.stringify(h));
  await openRead("odd"); h = await hd();
  ok("④ 沒有分享入口的報告(類型不在白名單上):只有「存成 PDF」,位置不變", !h.share && h.pdf && h.left === leftRes, JSON.stringify(h));
  await js(`window.__s.state.pub = { code: "OK", share: ${JSON.stringify(SHARE)}, displayName: null, limits: { liveCount: 4, liveLimit: 50, todayCount: 20, dailyLimit: 20 } }`);
  await openRead("pub"); h = await hd();
  ok("④ 公開中(分享收起、公開列出現):「存成 PDF」照出,位置不變", !h.share && h.pdf && h.left === leftRes && (await js(`!!document.querySelector("#rpt-read > .shr-well")`)), JSON.stringify(h));
  await js(`window.__s.pdfHold = true; document.getElementById("rpt-pdf").click()`); await wait(100); h = await hd();
  const pc = await calls("pdf");
  ok("④ 按下:只送 view / id / 版本 / 語言;存檔框開著的那段鈕字不變", JSON.stringify(pc[0]) === '["pdf","local","pub",null,"zh"]' && h.text === "存成 PDF" && !h.dis, JSON.stringify([pc, h]));
  await js(`document.getElementById("rpt-pdf").click()`); await wait(50);
  ok("④ 存檔框開著時再按不重送", (await calls("pdf")).length === 1);
  await js(`window.__s.saving()`); await wait(50); h = await hd();
  ok("④ 按了儲存、開始產:「存成中…」,頁首兩顆都停用", h.text === "存成中…" && h.dis && h.shareDis, JSON.stringify(h));
  // 回饋不放在鈕上(canon › 列印／PDF › 入口;batch 5 F):存檔中間隔著系統存檔框,鈕上閃「已存成」人看不到,也答不了「存到哪」
  const sv = () => js(`(() => { const b = document.getElementById("rpt-saved"), rv = document.getElementById("rpt-reveal");
    return { on: !b.hidden, d: b.querySelector(".d").textContent, rv: rv.hidden ? null : rv.textContent, sr: document.getElementById("sr-live").textContent, box: !document.getElementById("del-scrim").hidden,
      left: b.getBoundingClientRect().right <= document.querySelector(".rpt-acts").getBoundingClientRect().left + 1 }; })()`);
  await js(`window.__s.pdf = { code: "OK", dir: "報告", token: "tk1" }; window.__s.pdfHold()`); await wait(100); h = await hd();
  let s1 = await sv();
  ok("④ 成功:鈕直接回「存成 PDF」(不閃「已存成」)、可按;頁首同一列、動作群左邊出「已存到「報告」」＋「在 Finder 中顯示」;讀屏念那一句;不跳框",
    h.text === "存成 PDF" && !h.dis && !h.shareDis && s1.on && s1.d === "已存到「報告」" && s1.rv === "在 Finder 中顯示" && s1.sr === "已存到「報告」" && !s1.box && s1.left, JSON.stringify([h, s1]));
  await wait(1600); s1 = await sv();
  ok("④ 不計時:1.6 秒後那一句還在,鈕字沒變", s1.on && s1.d === "已存到「報告」" && (await hd()).text === "存成 PDF", JSON.stringify(s1));
  await js(`window.__s.pdfHold = null; window.__s.pdf = { code: "CANCELED" }; document.getElementById("rpt-pdf").click()`); await wait(150);
  ok("④ 取消 = 什麼都沒發生", (await hd()).text === "存成 PDF" && (await js(`document.getElementById("del-scrim").hidden`)));
  await js(`window.__s.pdf = { code: "FAIL" }; document.getElementById("rpt-pdf").click()`); await wait(200);
  c = await js(`(() => { const g = (x) => document.getElementById(x); return { open: !g("del-scrim").hidden, title: g("del-title").textContent, body: g("del-body").textContent, single: g("del-cancel").hidden, ok: g("del-ok").textContent }; })()`);
  ok("④ 失敗:440 單鈕框(標題 / 內文 / 知道了),鈕回原字、報告還在", c.open && c.title === "沒有存成 PDF" && c.body === "檔案沒有寫進去。換個位置，或稍後再試一次。" && c.single && c.ok === (await T("cdel.gotIt")) && (await hd()).text === "存成 PDF" && (await js(`!!document.querySelector("#rpt-read .rb-title")`)), JSON.stringify(c));
  await js(`document.getElementById("del-ok").click()`); await wait(150);

  // 分享框達上限
  const dlg = () => js(`(() => { const g = (x) => document.getElementById(x), m = g("shr-msg"), b = m.querySelector("button"); return { open: !g("shr-scrim").hidden, msg: m.textContent, mono: [...m.querySelectorAll(".mono")].map((x) => x.textContent).join(), go: b ? b.textContent : null, send: g("shr-send").disabled, desc: g("shr-send").getAttribute("aria-describedby"), ack: g("shr-ack").disabled }; })()`);
  await openRead("res"); await js(`document.getElementById("rpt-share").click()`); await wait(300);
  let d = await dlg();
  ok("④ 開框時已滿 50 份:那一句在訊息槽(數字由參數帶入、mono)、帶出口「看公開連結」、主鈕停用並指到那一句;勾選照常可勾", d.open && d.msg === (await T("shr.limitLive", { n: "50" })) + " " + (await T("shr.limitLiveGo")) && d.mono === "50" && d.go === "看公開連結" && d.send && d.desc === "shr-msg" && !d.ack, JSON.stringify(d));
  await js(`document.getElementById("shr-ack").click()`); await wait(50);
  ok("④ 勾了主鈕還是停用、送不出去", (await dlg()).send && (await js(`(async () => { await shrSubmit(); return window.__s.calls.filter((c) => c[0] === "publish").length; })()`)) === 0);
  await js(`document.querySelector("#shr-msg button").click()`); await wait(400);
  ok("④ 「看公開連結」:關分享框、開設定 › 公開連結", (await js(`document.getElementById("shr-scrim").hidden && !document.getElementById("set-scrim").hidden && document.querySelector('.set-cat[aria-current="true"]').dataset.setCat === "shares" && !document.getElementById("set-shares").hidden`)));
  await js(`setClose()`); await wait(100);
  await js(`window.__s.state.res = { code: "OK", share: null, displayName: null, limits: { liveCount: 3, liveLimit: 50, todayCount: 20, dailyLimit: 20 } }`);
  await openRead("perf"); await openRead("res"); await js(`document.getElementById("rpt-share").click()`); await wait(300); d = await dlg();
  ok("④ 今天 20 次用完:每日那一句、沒有出口、主鈕停用", d.msg === (await T("shr.limitDaily", { n: "20" })) && d.go === null && d.send && d.mono === "20", JSON.stringify(d));
  await js(`shrClose()`); await wait(100);
  await js(`window.__s.state.res = { code: "OK", share: null, displayName: null, limits: { liveCount: 3, liveLimit: 50, todayCount: 2, dailyLimit: 20 } }`);
  await openRead("perf"); await openRead("res"); await js(`document.getElementById("rpt-share").click()`); await wait(300); d = await dlg();
  ok("④ 沒滿:訊息槽是空的、勾了就能送", d.msg === "" && d.desc === null && d.send && (await js(`(() => { document.getElementById("shr-ack").click(); return !document.getElementById("shr-send").disabled; })()`)), JSON.stringify(d));
  await js(`shrSubmit()`); await wait(300); d = await dlg();
  ok("④ 送出時才被擋(api LIVE_LIMIT):同一句放同一個位置、框留著、主鈕停用", d.open && d.msg.startsWith((await T("shr.limitLive", { n: "50" }))) && d.go === "看公開連結" && d.send && (await calls("publish")).length === 1, JSON.stringify(d));

  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  app.exit(red ? 1 : 0);
});
