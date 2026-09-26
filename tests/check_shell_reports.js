// 報告區(shell/renderer/reports.js + report-blocks.js 搬運 + main.js 的 reportsList / reportLoad / cloudReports / cloudReport + cloud.js 的三支 interpret;spec-desktop-0.1.6 §1)。
//   ① 純邏輯(從原文切出來跑,不碰 DOM):時間格式、類型字、排序(本機新到舊 / 雲端照 api)、rptAskState 五態、rptCompose zh / en(= web rpCompose 一次性分支)、新 id。
//   ② 主行程:reportsList 掃 <WS>/reports(+ sent/):.tmp / 子目錄 / 壞檔名 / 壞 JSON / id 對不上 / 沒標題都略過、同 id drop dir 為準、新到舊;
//      reportLoad:本體 + sidecar 圖 → data URI(檔名 regex、mime 白名單、2 MB、去重);cloud.js 三支 interpret 的形狀;cloudReport 的圖逐張換、去重、上限 20、單張失敗不擋、5 分鐘快取綁 token。
//   ③ 接線(原文):index.html 的入口 / 視圖 / modal 骨架 / 載入順序;preload 四支;main 四個 handle;envShowMain / trOpen / stratSelect / rpCloudSelect / onTurnEnd / escTop / hasToken 翻轉;
//      渲染器搬運的三處 delta 與 CSS token 對照;telemetry 白名單;字串表 rpt.* / rb.* 齊、rb.* 與範本句逐字同 web。
//   ④ 用隨包的 Electron 開真的 index.html:清單(列 / 份數 / 空態 / 13 份出「更早」/ 讀不到 + 重試)→ 閱讀(fixture 各型別 block 畫出來、markdown 接 mdPaint、
//      尾註上標、圖缺檔失敗框、返回焦點)→ 新增報告 modal(chip 填欄、空描述不送、送出 → 逐字那句 → 關框(對話不貼 sys 回音)→ 工具列「agent 寫作中…」;失敗留框)
//      → turn-end(多出新報告自動打開 / 沒有就灰字)→ 雲端視角(照 api 順序、停機閘門、三處記號、讀不到 + 重試、輪詢)→ 兩袋各記各的 → en 組句。
// 跑法:node tests/check_shell_reports.js(找不到 shell/node_modules 的 Electron 時 ④ SKIP,①②③ 照跑)
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer"), FIX = path.join(__dirname, "fixtures");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 2000))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const src = read(path.join(R, "reports.js")), appSrc = read(path.join(R, "app.js")), trSrc = read(path.join(R, "trade.js")), libSrc = read(path.join(R, "library.js")), rbSrc = read(path.join(R, "report-blocks.js")), rbCss = read(path.join(R, "report-blocks.css"));
const html = read(path.join(R, "index.html")), strings = read(path.join(R, "strings.js")), mainSrc = read(path.join(SHELL, "main.js")), pre = read(path.join(SHELL, "preload.js")), cloudSrc = read(path.join(SHELL, "cloud.js"));
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };
const STR = (() => { const sb = {}; vm.runInNewContext(strings + "\nthis.S = STRINGS;", sb); return sb.S; })();
const WEEKLY = JSON.parse(read(path.join(FIX, "report_weekly.json"))), MCPT = JSON.parse(read(path.join(FIX, "report_mcpt.json")));
// web 的字(逐字;web/app/translations/*/LC_MESSAGES/messages.po 的 workspace_rp_msg_lead / _once、workspace_report_*、workspace_rp_tpl_*,2026-09-25 抄下)
const WEB = {
  zh: { lead: "幫我建立報告", once: "這份只要產出一次，不用建立排程。", rb: { originScheduled: "排程任務產出", originChat: "對話產出", machine: "主機", metaPeriod: "期間", metaAum: "AUM", metaBenchmark: "基準", calloutRisk: "風險", footnoteRef: "註", imageError: "圖片載入失敗", segOther: "其他" },
    tpl: { tw: "台股大盤晨報：加權指數與量能、三大法人、融資餘額、台指期與外資期貨淨多單，加上今天的判讀與觀察重點（該留意哪些指標、在什麼條件下）。", crypto: "加密市場晨報：BTC/ETH 走勢、資金費率、清算與 Blave 市場指標，加上今天的判讀。" } },
  en: { lead: "Write me a report", once: "Produce it once — no schedule needed.", rb: { metaPeriod: "Period", metaAum: "AUM", metaBenchmark: "Benchmark", calloutRisk: "Risk", footnoteRef: "Note", imageError: "Image failed to load", segOther: "Other" },
    tpl: { tw: "TW market brief: TAIEX and volume, the three institutional investors, margin balance, TAIEX futures and foreign net long positions, plus today's read and what to watch (which indicators, under what conditions).", crypto: "Crypto market brief: BTC/ETH price action, funding rates, liquidations and Blave market indicators, plus today's read." } },
};
const LIST = [{ id: "wk-2026-08-31", title: "績效週報 08/25–08/31", type: "performance", created_at: 1788220800 }, { id: "mcpt-2317", title: "MCPT 研究", type: "research", created_at: 1788134400 }, { id: "am-0901", title: "晨報 <img onerror=x>", type: "weird", created_at: 1788048000 }];

if (!process.versions.electron) {
  // ── ① 純邏輯 ──
  const a = src.indexOf("/* ── 純邏輯("), b = src.indexOf("/* ── 純邏輯到此");
  if (a < 0 || b < 0) throw new Error("找不到純邏輯區塊的標記");
  const block = src.slice(a, b);
  ok("① 純邏輯區塊不碰 DOM / i18n", !/\bdocument\b|\$\(|window\.|\bt\(/.test(block.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  const P = {}; vm.createContext(P); vm.runInContext(block.replace(/^const /gm, "var "), P);
  { const d = new Date(1788220800 * 1000), p2 = (n) => String(n).padStart(2, "0");
    ok("① 時間 MM/DD HH:MM(本地時區);壞值 \"\"", P.rptFmtStamp(1788220800) === p2(d.getMonth() + 1) + "/" + p2(d.getDate()) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes()) && P.rptFmtStamp(null) === "" && P.rptFmtStamp("x") === "" && P.rptFmtStamp(Infinity) === "" && P.rptFmtStamp(1e13) === "" && P.rptFmtStamp(-1e13) === ""); }   // B4:超過 Date 範圍的整數不能印出 NaN
  ok("① 類型字只認三種;缺 / 認不得 → null", P.rptTypeKey("performance") === "rpt.type.performance" && P.rptTypeKey("morning") === "rpt.type.morning" && P.rptTypeKey("research") === "rpt.type.research" && P.rptTypeKey("weird") === null && P.rptTypeKey(null) === null && P.rptTypeKey("toString") === null);
  ok("① 本機排序 created_at 新到舊、同時間照原順序、壞值當 0;雲端照 api 的順序不動;壞項目丟掉", P.rptSort([{ id: "a", created_at: 1 }, { id: "b", created_at: 3 }, { id: "c", created_at: 3 }, { id: "d" }, null, { created_at: 9 }], "local").map((r) => r.id).join() === "b,c,a,d"
    && P.rptSort([{ id: "a", created_at: 1 }, { id: "b", created_at: 3 }], "cloud").map((r) => r.id).join() === "a,b" && P.rptSort(null, "local").length === 0);
  const A = (c) => P.rptAskState(Object.assign({ running: false, env: "local", cloud: null, pending: false }, c));
  ok("① 鈕的態:pending > busy > stopped / stale(只在雲端)> free", A({ pending: true, running: true }) === "pending" && A({ running: true }) === "busy" && A({ env: "cloud", cloud: "stopped" }) === "stopped" && A({ env: "cloud", cloud: "stale" }) === "stale" && A({ env: "cloud", cloud: null }) === "stale"
    && A({ env: "cloud", cloud: "live" }) === "free" && A({ env: "local", cloud: "stopped" }) === "free" && A({ env: "cloud", cloud: "stopped", running: true }) === "busy" && A({}) === "free");
  ["zh", "en"].forEach((L) => ok(`① ${L} rpt.new.msgLead / msgOnce 逐字同 web 的 workspace_rp_msg_lead / _once`, STR[L]["rpt.new.msgLead"] === WEB[L].lead && STR[L]["rpt.new.msgOnce"] === WEB[L].once));
  const S = (L) => ({ lead: STR[L]["rpt.new.msgLead"], once: STR[L]["rpt.new.msgOnce"] });
  ok("① 組句 zh:全形「」：。、desc 只 trim;en 半形引號句號、尾句前一個空格;空 → \"\"", P.rptCompose("  每天收盤後做台股晨報 ", "zh", S("zh")) === "幫我建立報告：「每天收盤後做台股晨報」。這份只要產出一次，不用建立排程。"
    && P.rptCompose("daily TW brief", "en", S("en")) === 'Write me a report: "daily TW brief". Produce it once — no schedule needed.' && P.rptCompose("  ", "zh", S("zh")) === "" && P.rptCompose(null, "en", S("en")) === "");
  ok("① 版本鍵 = id@mtime(本機)/ id@stored_at(雲端)/ id@(都沒有);新報告 = 版本鍵不在送出前那一袋的——同 id 覆寫(mtime 變)也算新,順序照清單、壞項目丟", P.rptKey({ id: "a", mtime: 5 }) === "a@5" && P.rptKey({ id: "a", stored_at: 7 }) === "a@7" && P.rptKey({ id: "a" }) === "a@"
    && P.rptNewEntries(new Set(["a@1", "b@2"]), [{ id: "c", mtime: 3 }, { id: "a", mtime: 1 }, { id: "a", mtime: 9 }, { id: "d" }, null, { mtime: 1 }]).map((r) => r.id + ":" + r.mtime).join() === "c:3,a:9,d:undefined" && P.rptNewEntries(new Set(), []).length === 0 && P.rptNewEntries(new Set(["a@"]), null).length === 0);

  // ── ② 主行程:本機檔案 ──
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "blave-rpt-")), rd = path.join(ws, "reports");
  fs.mkdirSync(path.join(rd, "sent"), { recursive: true }); fs.mkdirSync(path.join(rd, "failed")); fs.mkdirSync(path.join(rd, "f.files")); fs.mkdirSync(path.join(rd, "img.files"));
  const W = (rel, obj) => fs.writeFileSync(path.join(rd, rel), typeof obj === "string" ? obj : JSON.stringify(obj));
  W("a.json", { id: "a", title: "  A  題目\u0000x ", type: "performance", created_at: 2000000000, blocks: [{ type: "meta", title: "A" }] });
  W("b.json", { title: "B", created_at: "x", blocks: [] });   // 沒 id → 用檔名;created_at 壞 → mtime
  W("c.json", { id: "zzz", title: "C", blocks: [] });   // id 對不上 → 略過
  W("d.json", { id: "d", blocks: [] });   // 沒標題 → 略過
  W("e.json.tmp", { id: "e", title: "E", blocks: [] });
  W("bad.json", "{ not json");
  W("Bad Name!.json", { title: "N", blocks: [] });
  W("arr.json", [1, 2]);
  W("huge.json", JSON.stringify({ id: "huge", title: "H", blocks: [], pad: "x".repeat(2 * 1024 * 1024) }));
  W("sent/g.json", { id: "g", title: "G", type: "morning", created_at: 1900000000, blocks: [] });
  W("big.json", { id: "big", title: "BIG", created_at: 1e13, blocks: [] });   // B4:超出 2000–2100 → 用 mtime
  W("sent/a.json", { id: "a", title: "A-sent", created_at: 2100000000, blocks: [] });   // 同 id:drop dir 那份為準
  W("failed/h.json", { id: "h", title: "H", blocks: [] });
  W("img.json", { id: "img", title: "IMG", created_at: 1, blocks: [{ type: "image", file: "p.png", alt: "p" }, { type: "image", file: "../a.json", alt: "x" }, { type: "image", file: "missing.png", alt: "m" }, { type: "image", file: "p.png", alt: "dup" }, { type: "image", file: "t.txt", alt: "t" }, { type: "image", file: "both.png", sha256: "a".repeat(64), alt: "b" }, { type: "image", sha256: "b".repeat(64), alt: "s" }] });
  fs.writeFileSync(path.join(rd, "img.files", "p.png"), Buffer.from("PNGDATA")); fs.writeFileSync(path.join(rd, "img.files", "t.txt"), "text"); fs.writeFileSync(path.join(rd, "img.files", "both.png"), Buffer.from("X"));
  const M = {}; vm.createContext(M);
  const lines = (re) => mainSrc.split("\n").filter((l) => re.test(l)).map((l) => l.replace(/^(const|let) /, "var ")).join("\n");
  vm.runInContext("var fs = require('fs'), path = require('path'), WS = " + JSON.stringify(ws) + ", ACCT_FRESH_MS = 300000;\n" + lines(/^const RPT_|^const rptDirs = |^let rptCloudList|^const rptCloudDocs/) + "\n"
    + ["rptEnvelope", "rptReadDoc", "rptImageUri", "reportsList", "reportLoad", "rptCloudInvalidate"].map((n) => cutFn(mainSrc, n)).join("\n") + "\n" + ["cloudReports", "cloudReport"].map((n) => "async " + cutFn(mainSrc, n)).join("\n"), Object.assign(M, { require }));
  const L = M.reportsList();
  ok("② reportsList:只認 <id>.json(.tmp / 子目錄 / 壞檔名 / 壞 JSON / 陣列 / 超過 2 MB 略過)、id 缺用檔名、id 對不上與沒標題略過、sent/ 也掃、同 id 以 drop dir 為準、failed/ 不掃;新到舊;標題去控制字元 / 截 200",
    L.reports.map((r) => r.id).join().replace("big,b", "b,big").replace("b,big", "b,big") && L.reports.slice(0, 2).map((r) => r.id).join() === "a,g" && L.reports.slice(2, 4).map((r) => r.id).sort().join() === "b,big" && L.reports[4].id === "img" && L.reports[0].title === "A 題目 x" && L.reports[0].type === "performance" && L.reports[1].type === "morning" && L.reports[2].type === null
    && L.reports.slice(2, 4).every((r) => Number.isInteger(r.created_at) && r.created_at > 1700000000 && r.created_at < 4102444800) && L.reports.every((r) => Number.isInteger(r.mtime) && r.mtime > 1.7e12), JSON.stringify(L));
  ok("② 沒有目錄 = 空清單,不丟", (() => { M.WS = path.join(ws, "nope"); const r = M.reportsList(); M.WS = ws; return r.reports.length === 0; })());
  const D = M.reportLoad("img");
  ok("② reportLoad:本體原樣 + mtime + sidecar 圖 → data URI(副檔名決定 mime、去重、路徑 / 缺檔 / 非圖 / 兩個都給 / 只有 sha256 都不解析)", D && D.report.id === "img" && Number.isInteger(D.mtime) && D.mtime === L.reports.find((r) => r.id === "img").mtime && D.report.blocks.length === 7 && Object.keys(D.images).join() === "p.png" && D.images["p.png"] === "data:image/png;base64," + Buffer.from("PNGDATA").toString("base64"), JSON.stringify(D && D.images));
  ok("② reportLoad:sent/ 那份也讀得到;沒這份 / 壞 JSON / 壞 id / 路徑 → null;a 讀 drop dir 那份", M.reportLoad("g").report.title === "G" && M.reportLoad("nope") === null && M.reportLoad("bad") === null && M.reportLoad("../a") === null && M.reportLoad("c") === null && M.reportLoad(5) === null && M.reportLoad("a").report.title.startsWith("  A"));
  fs.rmSync(ws, { recursive: true, force: true });

  // ── ② cloud.js 三支 interpret ──
  const C = require(path.join(SHELL, "cloud.js"));
  ok("② cloud.js 匯出三支端點與三支 interpret", C.REPORTS_ENDPOINT === "/oauth/desktop/cloud/reports" && C.REPORT_ENDPOINT === "/oauth/desktop/cloud/report" && C.IMAGE_ENDPOINT === "/oauth/desktop/cloud/strategy_image" && [C.interpretReports, C.interpretReport, C.interpretImage].every((f) => typeof f === "function"));
  const rr = C.interpretReports({ status: 200, body: { reports: [{ id: "a", title: "A\u0000 x", type: "performance", created_at: 1788220805, stored_at: 1788220806, bytes: 9 }, { id: "bad id", title: "B" }, { id: "c", title: "" }, null, { id: "d", title: "D", created_at: "x" }] } });
  ok("② interpretReports:200 + reports 陣列才 OK;每筆只留信封、壞 id / 空標題丟、標題去控制字元;其餘 UNREACH", rr.code === "OK" && rr.reports.map((r) => r.id).join() === "a,d" && rr.reports[0].title === "A x" && rr.reports[0].stored_at === 1788220806 && !("bytes" in rr.reports[0]) && rr.reports[1].created_at === null
    && C.interpretReports({ status: 200, body: { reports: [{ id: "z", title: "Z", created_at: 1e13, stored_at: -1 }] } }).reports[0].created_at === null && C.interpretReports({ status: 200, body: { reports: [{ id: "z", title: "Z", created_at: 1e13 }] } }).reports[0].stored_at === null
    && C.interpretReports({ status: 200, body: { reports: [] } }).reports.length === 0 && C.interpretReports({ status: 200, body: {} }).code === "UNREACH" && C.interpretReports({ status: 401, body: { reports: [] } }).code === "UNREACH" && C.interpretReports(null).code === "UNREACH");
  ok("② interpretReports:上限 200 筆", C.interpretReports({ status: 200, body: { reports: Array.from({ length: 250 }, (_, i) => ({ id: "r" + i, title: "t" })) } }).reports.length === 200);
  ok("② interpretReport:200 + report null = 平台沒這份(OK);本體 id 對得上、blocks 是陣列才 OK;其餘 UNREACH", C.interpretReport({ status: 200, body: { report: null } }, "x").report === null && C.interpretReport({ status: 200, body: { report: null } }, "x").code === "OK"
    && C.interpretReport({ status: 200, body: { report: { id: "x", title: "T", blocks: [] } } }, "x").code === "OK" && C.interpretReport({ status: 200, body: { report: { id: "y", blocks: [] } } }, "x").code === "UNREACH" && C.interpretReport({ status: 200, body: { report: { id: "x" } } }, "x").code === "UNREACH"
    && C.interpretReport({ status: 200, body: {} }, "x").code === "UNREACH" && C.interpretReport({ status: 500, body: { report: null } }, "x").code === "UNREACH");
  ok("② interpretImage:{ image: { mime, b64 } } 只認白名單 mime 與 base64 字元;null = 沒這張;其餘 UNREACH", C.interpretImage({ status: 200, body: { image: { mime: "image/png", b64: "QUJD" } } }).image.b64 === "QUJD" && C.interpretImage({ status: 200, body: { image: null } }).image === null
    && C.interpretImage({ status: 200, body: { image: { mime: "text/html", b64: "QUJD" } } }).code === "UNREACH" && C.interpretImage({ status: 200, body: { image: { mime: "image/png", b64: "<script>" } } }).code === "UNREACH" && C.interpretImage({ status: 200, body: {} }).code === "UNREACH");
  // 宿主的三支:同 strategy() 的做法(不留、不落地、換人就丟)
  (async () => {
    const calls = []; let creds = { token: "T", appSecret: "S" };
    const h = C.createCloudHost({ apiBase: "https://x", getCreds: () => creds, post: async (u, b) => { calls.push({ u, b }); return u.endsWith("/reports") ? { status: 200, body: { reports: [{ id: "a", title: "A" }] } } : u.endsWith("/report") ? { status: 200, body: { report: { id: b.id, title: "A", blocks: [] } } } : { status: 200, body: { image: { mime: "image/png", b64: "QUJD" } } }; }, now: () => 1e6, setTimer: () => 0, clearTimer: () => {} });
    const r1 = await h.reports(), r2 = await h.report("a"), r3 = await h.image("c".repeat(64)), r4 = await h.report("bad id"), r5 = await h.image("zz");
    ok("② 宿主:reports / report / image 各打自己的端點、兩顆憑證只在 body、壞 id / 壞 hash 不發請求", r1.code === "OK" && r1.reports.length === 1 && r2.code === "OK" && r2.report.id === "a" && r3.image.mime === "image/png" && r4.code === "UNREACH" && r5.code === "UNREACH" && calls.length === 3
      && calls.map((c) => c.u.replace("https://x", "")).join() === "/oauth/desktop/cloud/reports,/oauth/desktop/cloud/report,/oauth/desktop/cloud/strategy_image" && JSON.stringify(Object.keys(calls[1].b).sort()) === '["app_secret","id","token"]' && calls[2].b.hash === "c".repeat(64));
    creds = null; ok("② 宿主:沒登入 → 三支都 UNREACH、不發請求", (await h.reports()).code === "UNREACH" && (await h.report("a")).code === "UNREACH" && (await h.image("c".repeat(64))).code === "UNREACH" && calls.length === 3);
    // main.js 的 cloudReports / cloudReport:快取 5 分鐘綁 token、圖逐張換 / 去重 / 上限 20 / 單張失敗不擋
    const img = (i) => ({ type: "image", sha256: String(i).padStart(64, "0"), alt: "x" });
    const hostCalls = []; let tok = "T", now = 1e6;
    M.loadToken = () => tok; M.Date = { now: () => now };
    M.cloudHost = () => ({ reports: async () => { hostCalls.push("reports"); return { code: "OK", reports: [{ id: "a", title: "A" }] }; },
      report: async (id) => { hostCalls.push("report:" + id); return id === "a" ? { code: "OK", report: { id: "a", blocks: [img(1), img(2), img(1), { type: "text", markdown: "x" }].concat(Array.from({ length: 25 }, (_, i) => img(10 + i))) } } : id === "none" ? { code: "OK", report: null } : { code: "UNREACH", report: null }; },
      image: async (sha) => { hostCalls.push("image:" + sha.slice(-2)); return sha.endsWith("02") ? { code: "UNREACH", image: null } : sha.endsWith("11") ? { code: "OK", image: null } : { code: "OK", image: { mime: "image/png", b64: "QUJD" } }; } });
    const c1 = await M.cloudReports(false), c2 = await M.cloudReports(false), c3 = await M.cloudReports(true);
    ok("② cloudReports:第一次打、5 分鐘內不再打、force 再打", c1.code === "OK" && c1.reports.length === 1 && c2 === c1 && c3 !== c1 && hostCalls.filter((x) => x === "reports").length === 2);
    const d1 = await M.cloudReport("a");
    ok("② cloudReport:圖逐張打 /strategy_image(去重、最多 20 張)、失敗那張跳過、null 那張跳過、其餘 data URI;本體原樣", d1.code === "OK" && d1.report.blocks.length === 29 && hostCalls.filter((x) => x.startsWith("image:")).length === 20 && Object.keys(d1.images).length === 18
      && d1.images["0".repeat(63) + "1"] === "data:image/png;base64,QUJD" && !("0".repeat(63) + "2" in d1.images) && !("0".repeat(62) + "11" in d1.images), JSON.stringify([hostCalls.length, Object.keys(d1.images).length]));
    const before = hostCalls.length; const d2 = await M.cloudReport("a");
    ok("② cloudReport:5 分鐘內同 id 不再打;沒這份 → OK + report null(不進快取,下次再問);UNREACH → 打不到的形狀;壞 id 不打", d2 === d1 && hostCalls.length === before && (await M.cloudReport("none")).report === null && (await M.cloudReport("none")).code === "OK" && (await M.cloudReport("zz")).code === "UNREACH" && (await M.cloudReport("../a")).code === "UNREACH" && hostCalls.filter((x) => x === "report:none").length === 2, JSON.stringify(hostCalls));
    const d1v = await M.cloudReport("a", 5), d1v2 = await M.cloudReport("a", 5), d1v3 = await M.cloudReport("a", 6);
    ok("② cloudReport:帶版本(stored_at)的快取 key 分開——同 id 換版本就重打(B1),同版本不打", d1v !== d1 && d1v2 === d1v && d1v3 !== d1v && hostCalls.filter((x) => x === "report:a").length === 3);
    { const n0 = hostCalls.filter((x) => x.startsWith("image:")).length; M.Date = { now: () => { now += 31000; return now; } };   // 每問一次時鐘走 31 秒:預算 60 秒內只放得下兩張
      const dB = await M.cloudReport("a", 99); M.Date = { now: () => now };
      ok("② 圖的總預算 60 秒:超時就不再逐張打、報告照回(剩下的留給失敗框)", dB.code === "OK" && hostCalls.filter((x) => x.startsWith("image:")).length - n0 <= 3 && Object.keys(dB.images).length <= 3, JSON.stringify(hostCalls.length - n0)); }
    for (let i = 0; i < 12; i++) await M.cloudReport("a", 100 + i);
    ok("② 本體快取上限 8 份(每份含 base64 圖),多的淘汰最舊", M.rptCloudDocs.size === 8 && !M.rptCloudDocs.has("a|5"));
    tok = "U"; const d3 = await M.cloudReport("a"), c4 = await M.cloudReports(false);
    ok("② 換了帳號(token 不同):清單與本體都重打", d3 !== d1 && c4 !== c3 && hostCalls.filter((x) => x === "report:a").length === 17);
    now += 300001; const c5 = await M.cloudReports(false); tok = null;
    ok("② 過了 5 分鐘重打;沒登入 → UNREACH 不打;rptCloudInvalidate 清掉之後再問就重打", c5 !== c4 && (await M.cloudReports(false)).code === "UNREACH" && (() => { tok = "U"; M.rptCloudInvalidate(); const n = hostCalls.length; return M.cloudReports(false).then((c6) => c6 !== c5 && hostCalls.length === n + 1); })());
  })().then(() => {
    // ── ③ 接線 ──
    ok("③ index.html:側欄「報告」#rpt-nav 在「策略庫」後、同一個 #side-nav 裡;#rpt 在 #lib 後、#main-empty 前;兩個 css;script 順序 report-robust → report-blocks → reports → newstrategy → trade",
      html.indexOf('id="rpt-nav"') > html.indexOf('id="lib-nav"') && html.indexOf('id="rpt-nav"') < html.indexOf("</nav>") && html.indexOf('id="rpt"') > html.indexOf('id="lib"') && html.indexOf('id="rpt"') < html.indexOf('id="main-empty"')
      && /<link rel="stylesheet" href="report-blocks\.css">\s*<link rel="stylesheet" href="reports\.css">/.test(html) && /<script src="report-robust\.js"><\/script>\s*<script src="report-blocks\.js"><\/script>\s*<script src="reports\.js"><\/script>\s*<script src="newstrategy\.js"><\/script>\s*<script src="trade\.js">/.test(html));
    ok("③ #rpt 的骨架:region + aria-labelledby 到 h5、h5 tabindex=-1、工具列份數 + #rpt-ask(aria-haspopup、aria-label rpt.askAria、字由 JS 寫)、#rpt-msg、返回鈕(hidden)、#rpt-body tabindex=0、#rpt-state role=status、#rpt-read(hidden)",
      /<div class="rpt" id="rpt" role="region" aria-labelledby="rpt-h" hidden>/.test(html) && /<h5 class="main-head-name" id="rpt-h" tabindex="-1" data-i18n="rpt\.nav">/.test(html) && /<span class="rpt-count" id="rpt-count"><\/span>/.test(html)
      && /<button class="btn-out has-ic" id="rpt-ask" type="button" aria-haspopup="dialog" data-i18n-aria="rpt\.askAria"><svg[^>]*>[\s\S]*?<\/svg><span id="rpt-ask-t"><\/span><\/button>/.test(html) && !/id="rpt-ask-t" data-i18n/.test(html)
      && /<p class="rpt-msg" id="rpt-msg" hidden>/.test(html) && /<button class="rpt-back" id="rpt-back" type="button" hidden>/.test(html) && /<div class="rpt-body" id="rpt-body" tabindex="0">/.test(html) && /<div class="rpt-state" id="rpt-state" role="status" hidden>/.test(html) && /<div class="rpt-read" id="rpt-read" hidden>/.test(html));
    ok("③ 新增報告 modal 的骨架:#rpn-scrim(dialog、hidden)> form#rpn-modal.set-modal.del-modal;描述欄 .f-area#rpn-desc、5 顆 .pf-act chip(data-tpl 是 key)、誠實句 #rpn-honest(字由 JS 寫)、腳 .foot-msg + .del-where + 取消 + submit",
      /<div class="scrim" id="rpn-scrim" role="dialog" aria-modal="true" aria-labelledby="rpn-title" hidden>\s*<form class="set-modal del-modal" id="rpn-modal">/.test(html) && /<textarea class="f-area" id="rpn-desc" data-i18n-ph="rpt\.new\.descPh"><\/textarea>/.test(html)
      && (html.match(/<button type="button" class="pf-act" data-tpl="rpt\.new\.tpl\.(tw|close|crypto|symbol|research)" data-i18n="rpt\.new\.chip\.\1">/g) || []).length === 5 && /<p class="ns-hint" id="rpn-honest"><\/p>/.test(html)
      && /<span class="foot-msg" id="rpn-msg" role="status"><\/span>\s*<span class="del-where" id="rpn-where" hidden><\/span>/.test(html) && /<button type="submit" class="btn-fill" id="rpn-send" data-i18n="rpt\.new\.send">/.test(html));
    ok("③ preload 四支;main 四個 handle(只收自家頁面)、登出清雲端報告快取、libraryList 回 why", /reportsList: \(\) => ipcRenderer\.invoke\("reports-list"\)/.test(pre) && /reportLoad: \(id\) => ipcRenderer\.invoke\("report-load", id\)/.test(pre) && /cloudReports: \(force\) => ipcRenderer\.invoke\("cloud-reports", force\)/.test(pre) && /cloudReport: \(id, ver\) => ipcRenderer\.invoke\("cloud-report", id, ver\)/.test(pre)
      && /handle\("reports-list", \(\) => reportsList\(\), \{ reports: \[\] \}\);/.test(mainSrc) && /handle\("report-load", \(_e, id\) => reportLoad\(id\), null\);/.test(mainSrc) && /handle\("cloud-reports", \(_e, force\) => cloudReports\(force === true\), \{ code: "UNREACH", reports: \[\] \}\);/.test(mainSrc) && /handle\("cloud-report", \(_e, id, ver\) => cloudReport\(id, ver\), \{ code: "UNREACH", report: null, images: \{\} \}\);/.test(mainSrc)
      && /rptCloudInvalidate\(\);/.test(cutFn(mainSrc, "clearToken")) && /const why = dataAccess === "none" \? dataAccessWhy\(signedIn\) : null;/.test(cutFn(mainSrc, "libraryList")) && (cutFn(mainSrc, "libraryList").match(/dataAccess, why \}/g) || []).length === 2);
    ok("③ 視圖互斥:envShowMain 兩個分支都在 libShowMain 後問 rptShowMain;trOpen / stratSelect / rpCloudSelect / libOpen 都 rptLeave;rptOpen 先 libLeave", /libShowMain\(gate\);[^\n]*\n\s*if \(typeof rptShowMain === "function"\) rptShowMain\(gate\);/.test(cutFn(trSrc, "envShowMain")) && /if \(typeof rptShowMain === "function"\) rptShowMain\(false\);\n\}$/.test(cutFn(trSrc, "envShowMain"))
      && /if \(typeof rptLeave === "function"\) rptLeave\(S\.env\);/.test(cutFn(trSrc, "trOpen")) && /if \(name && typeof rptLeave === "function"\) rptLeave\("local"\);/.test(cutFn(appSrc, "stratSelect")) && /if \(name && typeof rptLeave === "function"\) rptLeave\("cloud"\);/.test(cutFn(appSrc, "rpCloudSelect"))
      && /if \(typeof rptLeave === "function"\) rptLeave\(\);/.test(cutFn(libSrc, "libOpen")) && /if \(typeof libLeave === "function"\) libLeave\(\);/.test(cutFn(src, "rptOpen"))
      && ["ns-scrim", "rpn-scrim"].every((id) => cutFn(trSrc, "envCanSwitch").includes('$("' + id + '").hidden')));   // 兩個表單框開著不切視角(app 選單那條不經 DOM 的 inert)
    ok("③ 稽核必修:pending 每袋一份;turn-end 已在輪詢就不重開窗(B5)、rptLoad 回布林且失效不靜默(S3)、自動打開前再檢查視角仍是本機且袋開著(B3);本體快取與新報告都比版本鍵(B1);cloud-report IPC 帶 ver;created_at 兩端夾 2000–2100(B4)",
      /pending: \{ local: null, cloud: null \}/.test(src) && /if \(RPT\.pending\.cloud && !RPT\.poll\) rptCloudPollStart\(RPT\.pending\.cloud\);/.test(cutFn(src, "rptTurnEnd")) && (cutFn(src, "rptLoad").match(/console\.warn\("\[reports\] load superseded"/g) || []).length === 2 && /return true;\n\}$/.test(cutFn(src, "rptLoad"))
      && /rptOpen\(\)\.then\(\(opened\) => \{ if \(opened && libEnv\(\) === "local" && rptBag\("local"\)\.open\) rptShowRead\(fresh\[0\]\.id\); \}\);/.test(cutFn(src, "rptTurnEnd")) && /key = env \+ "\|" \+ ver, cached = RPT\.docs\.get\(key\);/.test(cutFn(src, "rptFetch"))
      && /new Set\(\(RPT\.data\[env\] \|\| \[\]\)\.map\(rptKey\)\)/.test(cutFn(src, "rptSend")) && /cloudReport: \(id, ver\) => ipcRenderer\.invoke\("cloud-report", id, ver\)/.test(pre) && /const RPT_TS_MIN = 946684800, RPT_TS_MAX = 4102444800;/.test(mainSrc) && /v >= 946684800 && v <= 4102444800/.test(cutFn(cloudSrc, "interpretReports")));
    ok("③ 回合:三個出口都 rptSync;turn-end 在 libTurnEnd 之後叫 rptTurnEnd;hasToken 翻轉的三處都 rptInvalidate;applyStatic 叫 rptRepaint;escTop 鏈在 del 之後就是 #rpn-scrim;trapTab 圈到 input / textarea",
      (appSrc.match(/if \(typeof rptSync === "function"\) rptSync\(\);/g) || []).length === 3 && /if \(typeof libTurnEnd === "function"\) libTurnEnd\(\); if \(typeof rptTurnEnd === "function"\) rptTurnEnd\(\);/.test(appSrc) && (appSrc.match(/if \(typeof rptInvalidate === "function"\) rptInvalidate\(\);/g) || []).length === 3
      && /if \(typeof rptRepaint === "function"\) rptRepaint\(\);/.test(cutFn(appSrc, "applyStatic")) && /delClose\(false\) : !\$\("rpn-scrim"\)\.hidden \? rptNewClose :/.test(cutFn(appSrc, "escTop")) && /"button, select, input, textarea"/.test(cutFn(appSrc, "trapTab")));
    ok("③ 渲染器搬運(§1.7):整支沒有 innerHTML / insertAdjacentHTML / eval / new Function;三處 delta——image 的參照 sha256 || file、makeCtx 收 markdown 且 mdFragment 先問它、中文字面改跳脫;NodeFilter 走 global;marked / DOMPurify 沒被引進 index.html",
      !/innerHTML\s*=|insertAdjacentHTML|\beval\(|new Function/.test(rbSrc) && /var ref = sha \|\| str\(b\.file\);/.test(rbSrc) && /ctx\.imageUrl\(ref\)/.test(rbSrc) && /markdown: markdown,/.test(rbSrc) && /if \(ctx\.markdown\) \{/.test(cutFn(rbSrc, "mdFragment")) && !/[一-鿿]/.test(rbSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))
      && /global\.NodeFilter\.SHOW_TEXT/.test(rbSrc) && !/\bNodeFilter\.SHOW_TEXT/.test(rbSrc.replace(/global\.NodeFilter/g, "")) && !/marked|purify/i.test(html) && /global\.renderAgentReport = renderAgentReport;/.test(rbSrc));
    const rbCode = rbCss.replace(/\/\*[\s\S]*?\*\//g, "");
    ok("③ report-blocks.css:token 換成語意角色——沒有 --color-dark* / greyLightMedium / greyMedium;greyDark 只剩 .is-na 一處;沒有 hex;熱圖 td nowrap;沒有 768 斷點", !/--color-dark|--color-greyLightMedium|--color-greyMedium/.test(rbCode) && (rbCode.match(/--color-greyDark/g) || []).length === 1 && /\.rb-heat td\.is-na \{\s*color: var\(--color-greyDark\);/.test(rbCode)
      && !/#[0-9a-fA-F]{3,6}\b/.test(rbCss) && /\.rb-report \.rb-heat td \{[^}]*white-space: nowrap;/.test(rbCss) && !/@media \(max-width: 768px\)/.test(rbCss) && /var\(--color-watermark\)/.test(rbCss));
    { const tok = read(path.join(R, "tokens.css"));
      ok("③ tokens.css:--color-watermark 兩態(light = greyLight、dark = darkBorder);程式碼高亮四色兩態", /--color-watermark: #d5dde4;/.test(tok) && /--color-watermark: #2d383e;/.test(tok) && ["keyword", "string", "number", "comment"].every((k) => (tok.match(new RegExp("--color-code-" + k + ": #")) || []).length === 1 && (tok.match(new RegExp("--color-code-" + k + ":", "g")) || []).length === 2)); }
    ok("③ reports.js / reports.css:沒有 innerHTML、不寫 localStorage;埋點 reports_list(rptOpen)/ reports_read(畫出 article)/ reports_ask(r.started 之後)三個都在 telemetry.js 白名單;reports.css 只引變數", !/innerHTML|insertAdjacentHTML|Storage/.test(src) && /libTrack\("reports_list"\)/.test(cutFn(src, "rptOpen")) && /libTrack\("reports_read"\)/.test(cutFn(src, "rptRender"))
      && /if \(!ok\) \{[^\n]*return; \}[^\n]*\n[\s\S]*?libTrack\("reports_ask"\)/.test(cutFn(src, "rptSend")) && /rptNewLock\(true\);[\s\S]*?await submitMessage[\s\S]*?rptNewLock\(false\);/.test(cutFn(src, "rptSend")) && /\["rpn-send", "rpn-cancel", "rpn-close"\]/.test(src) && ["reports_list", "reports_read", "reports_ask"].every((n) => require(path.join(SHELL, "telemetry.js")).EVENTS.feature_used.name.includes(n)) && !/#[0-9a-fA-F]{3,6}\b/.test(read(path.join(R, "reports.css"))));
    { const keys = [...new Set([...src.matchAll(/\bt\("((?:rpt|rb|modal)\.[^"]+)"/g)].map((m) => m[1]).concat([...html.matchAll(/data-(?:i18n(?:-aria|-ph)?|tpl)="((?:rpt|rb)\.[^"]+)"/g)].map((m) => m[1])))];
      const missing = keys.filter((k) => !(k in STR.zh) || !(k in STR.en));
      ok("③ 用到的 " + keys.length + " 個 rpt.* / rb.* / modal.* key zh / en 都齊;zh 全形標點", missing.length === 0 && Object.keys(STR.zh).filter((k) => /^(rpt|rb|modal)\./.test(k)).every((k) => !/[一-鿿][,.?:;!]/.test(STR.zh[k])), missing);
      ok("③ rb.* zh 逐字同 web 的 workspace_report_*(腳注兩句改帶 {where});範本句逐字同 web 的 workspace_rp_tpl_*;12 個 key 對齊渲染器的 DEFAULT_I18N", Object.keys(WEB.zh.rb).every((k) => STR.zh["rb." + k] === WEB.zh.rb[k]) && Object.keys(WEB.en.rb).every((k) => STR.en["rb." + k] === WEB.en.rb[k])
        && STR.zh["rb.footChat"] === "本報告由{where}的 agent 對話產出" && STR.zh["rb.footScheduled"] === "本報告由{where}的 agent 排程產出" && ["zh", "en"].every((L) => STR[L]["rpt.new.tpl.tw"] === WEB[L].tpl.tw && STR[L]["rpt.new.tpl.crypto"] === WEB[L].tpl.crypto)
        && [...rbSrc.matchAll(/^\s{4}(\w+): "[^"]*",$/gm)].map((m) => m[1]).slice(0, 12).every((k) => ("rb." + k) in STR.zh)); }

    // ── ④ 交給 Electron ──
    const bin = path.join(SHELL, "node_modules", ".bin", "electron");
    if (!fs.existsSync(bin)) { console.log("SKIP  ④ 找不到 shell/node_modules 的 Electron(先 cd shell && npm install)"); console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
    const r = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" });
    const sub = r.status == null ? 1 : r.status;
    console.log(red || sub ? `\n${red + sub} 紅` : "\nALL PASS");
    process.exit(red || sub ? 1 : 0);
  });
  return;
}

const { app, BrowserWindow } = require("electron");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-reports-")));
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const STUB = `window.__r = { list: ${JSON.stringify({ reports: LIST })}, docs: ${JSON.stringify({ "wk-2026-08-31": { report: WEEKLY, images: {} }, "mcpt-2317": { report: MCPT, images: {} } })}, calls: [], cloudList: { code: "UNREACH", reports: [] }, cloudDocs: {}, cloudCalls: [],
  sent: [], sendResult: { started: true }, tracked: [] };
const __fixed = {
  getLocale: async () => "zh-TW", loadConnection: async () => ({ kind: "claude" }), detectAgents: async () => ({ claude: { installed: true, loggedIn: true }, codex: { installed: false } }),
  listStrategies: async () => [], listSessions: async () => [], loadSession: async () => [], loadSessionImages: async () => [], updateState: async () => ({ phase: "idle", current: "0.0.0" }),
  hasBlaveToken: async () => true, ensureEngine: async () => ({}), libraryList: async () => ({ strategies: [], signedIn: true, dataAccess: "included" }),
  reportsList: async () => { window.__r.calls.push("list"); return window.__r.list; }, reportLoad: async (id) => { window.__r.calls.push("load:" + id); return window.__r.docs[id] || null; },
  cloudReports: async (force) => { window.__r.cloudCalls.push("list:" + force); return window.__r.cloudList; }, cloudReport: async (id) => { window.__r.cloudCalls.push("load:" + id); return window.__r.cloudDocs[id] || { code: "UNREACH", report: null, images: {} }; },
  sendMessage: async (p) => { window.__r.sent.push(p); return window.__r.sendResult; }, trackFeature: (n) => { window.__r.tracked.push(n); },
};
window.blave = new Proxy(__fixed, { get: (o, k) => (k in o ? o[k] : typeof k !== "string" ? undefined : k.startsWith("on") ? () => {} : k === "tradeLabels" ? () => {} : async () => undefined) });`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  ④ 逾時(120 秒)"); process.exit(1); }, 120000).unref();

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const preload = path.join(app.getPath("userData"), "stub.js"); fs.writeFileSync(preload, STUB);
  const w = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, preload, contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(SHELL, "renderer", "index.html"));
  await wait(1200);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  const T = (k, v) => js(`t(${JSON.stringify(k)}, ${JSON.stringify(v || {})})`);
  const Q = `const q = (x) => [...document.querySelectorAll(x)], g = (id) => document.getElementById(id);`;
  const view = () => js(`(() => { ${Q} return { on: !g("rpt").hidden, cur: g("rpt-nav").getAttribute("aria-current"), lib: g("lib").hidden, tr: g("tr").hidden, empty: g("main-empty").hidden, headList: g("rpt-head-list").hidden, back: g("rpt-back").hidden, read: g("rpt-read").hidden,
    ids: q("#rpt-rows .rpt-row").map((b) => b.dataset.id).join(), count: g("rpt-count").textContent, countVis: getComputedStyle(g("rpt-count")).visibility, ask: g("rpt-ask-t").textContent, askDis: g("rpt-ask").disabled, msg: g("rpt-msg").hidden ? null : g("rpt-msg").textContent, msgErr: g("rpt-msg").classList.contains("err"), mark: q("#rpt-msg .fault-mark").length,
    state: g("rpt-state").hidden ? null : g("rpt-state").textContent, stateCls: g("rpt-state").className, stateBtns: q("#rpt-state button").length, more: q("#rpt-rows .rpt-more").map((b) => b.textContent).join(), sk: q("#rpt-rows .rpt-sk").length, article: q("#rpt-read article.rb-report").length,
    focus: document.activeElement && (document.activeElement.id || document.activeElement.dataset.id || document.activeElement.className), current: q('#rpt-rows .rpt-row[aria-current="true"]').map((b) => b.dataset.id).join() }; })()`);
  const rowOf = (id) => js(`(() => { ${Q} const b = q('#rpt-rows .rpt-row[data-id="${id}"]')[0]; return { t: b.querySelector(".t").textContent, title: b.querySelector(".t").title, m: b.querySelector(".m").textContent, mono: b.querySelector(".m .mono").textContent, imgs: b.querySelectorAll("img").length, h: b.getBoundingClientRect().height }; })()`);

  // 開
  await js(`(async () => { document.getElementById("rpt-nav").click(); await new Promise((r) => setTimeout(r, 120)); })()`); await wait(60);
  let v = await view(), row = await rowOf("am-0901");
  ok("④ 側欄「報告」→ #rpt 出、入口 aria-current、歡迎頁 / 策略庫 / 自動下單收;三列照 created_at 新到舊;份數「3 份報告」;鈕「新增報告」可按;焦點在鈕;reports_list", v.on && v.cur === "page" && v.lib && v.tr && v.empty && !v.headList && v.back && v.read && v.ids === "wk-2026-08-31,mcpt-2317,am-0901" && v.count === (await T("rpt.count.other", { n: 3 })) && v.countVis === "visible"
    && v.ask === (await T("rpt.ask")) && !v.askDis && v.msg === null && v.focus === "rpt-ask" && (await js("window.__r.tracked.includes('reports_list')")), JSON.stringify(v));
  ok("④ 列:標題(agent 的字只進 textContent、全文放 title)、第二行 MM/DD HH:MM(.mono)+ 類型字;認不得的類型不出字;列高 ≥ 48", row.t === "晨報 <img onerror=x>" && row.title === row.t && row.imgs === 0 && /^\d\d\/\d\d \d\d:\d\d$/.test(row.mono) && row.m === row.mono && row.h >= 52 && (await rowOf("wk-2026-08-31")).m.endsWith(" · " + (await T("rpt.type.performance"))), JSON.stringify(row));
  { const edge = (narrow) => js(`(() => { const g = (x) => document.getElementById(x), p = g("rpt"); if (${narrow}) { p.style.flex = "none"; p.style.width = "480px"; }
      const r0 = document.querySelector("#rpt-rows .rpt-row"), body = g("rpt-body"), o = { t: r0.querySelector(".t").getBoundingClientRect().left, h: g("rpt-h").getBoundingClientRect().left, count: g("rpt-count").getBoundingClientRect().left, rowH: r0.getBoundingClientRect().height, fill: r0.getBoundingClientRect().left, sw: body.scrollWidth, cw: body.clientWidth, w: p.getBoundingClientRect().width };
      p.style.flex = ""; p.style.width = ""; return o; })()`);
    const wide = await edge(false), nar = await edge(true), fine = (e) => Math.abs(e.t - e.h) <= 1 && Math.abs(e.t - e.count) <= 1 && e.sw <= e.cw && Math.round(e.rowH) === 52 && Math.round(e.t - e.fill) === 12;
    ok("④ 列留白(spec-report-row-padding §2):第一列 .t 的 left = 頁首 h5 = 份數(±1)、填色外擴 12、.rpt-body 無橫向溢出、列高 52;寬欄與中欄 480 各量一次", fine(wide) && fine(nar), JSON.stringify({ wide, nar })); }
  // 空狀態
  await js(`window.__r.list = { reports: [] }; rptLoad("local", true);`); await wait(120); v = await view();
  ok("④ 空狀態(可按):兩行置中、沒有第二顆鈕;份數藏字留位(visibility hidden);工具列照常", v.state === (await T("rpt.empty")) + (await T("rpt.emptyHint")) && /rpt-empty/.test(v.stateCls) && v.stateBtns === 0 && v.ids === "" && v.countVis === "hidden" && !v.askDis, JSON.stringify(v));
  // 13 份 → 更早
  const many = Array.from({ length: 13 }, (_, i) => ({ id: "r" + i, title: "R" + i, type: "research", created_at: 1788000000 - i }));
  await js(`window.__r.list = { reports: ${JSON.stringify(many)} }; rptLoad("local", true);`); await wait(120); v = await view();
  ok("④ 13 份:平鋪 12 份 + 「更早的報告 · 1 份」", v.ids.split(",").length === 12 && v.more === (await T("rpt.more", { n: 1 })) && v.count === (await T("rpt.count.other", { n: 13 })), JSON.stringify(v));
  await js(`document.querySelector("#rpt-rows .rpt-more").click();`); v = await view();
  ok("④ 點「更早」→ 原地再開、13 列、鈕消失、焦點接到第 13 列", v.ids.split(",").length === 13 && v.more === "" && v.focus === "r12", JSON.stringify(v));
  // 讀不到(本機 JSON 壞 → 主行程回 null)+ 重新查看
  await js(`window.__r.list = { reports: ${JSON.stringify(LIST)} }; rptLoad("local", true);`); await wait(120);
  await js(`window.__r.docs["am-0901"] = null; document.querySelector('#rpt-rows .rpt-row[data-id="am-0901"]').click();`); await wait(450); v = await view();
  let e = await js(`(() => { ${Q} return { err: q("#rpt-read .plan-err").map((x) => x.textContent).join(), mark: q("#rpt-read .plan-err .fault-mark").length, btn: q("#rpt-read .btn-out").map((b) => b.textContent).join() }; })()`);
  ok("④ 讀不到:頁首只剩返回鈕、一句 rpt.readErr + 灰記號 + 「重新查看」;焦點在返回鈕", v.headList && !v.back && !v.read && e.err === (await T("rpt.readErr")) && e.mark === 1 && e.btn === (await T("plan.recheck")) && v.focus === "rpt-back" && v.article === 0, JSON.stringify([v, e]));
  await js(`window.__r.docs["am-0901"] = { report: ${JSON.stringify(Object.assign({}, WEEKLY, { id: "am-0901" }))}, images: {} }; document.querySelector("#rpt-read .btn-out").click();`); await wait(450); v = await view();
  ok("④ 「重新查看」→ 畫出 article;reports_read", v.article === 1 && (await js("window.__r.tracked.includes('reports_read')")), JSON.stringify(v));
  // 閱讀:週報 fixture 各型別
  await js(`(() => { document.getElementById("rpt-back").click(); document.querySelector('#rpt-rows .rpt-row[data-id="wk-2026-08-31"]').click(); })()`); await wait(450);
  let a = await js(`(() => { ${Q} const A = g("rpt-read").querySelector("article.rb-report"); return { title: A.querySelector(".rb-title").textContent, kpi: A.querySelectorAll(".rb-kpi-cell").length, charts: A.querySelectorAll("svg.rb-chart").length, heat: A.querySelectorAll(".rb-heat td").length, table: A.querySelectorAll(".rb-table tbody tr").length, metrics: A.querySelectorAll(".rb-metric-row").length,
    callout: A.querySelectorAll(".rb-callout").length, lead: A.querySelector(".rb-lead p") && A.querySelector(".rb-lead p").textContent, code: A.querySelectorAll(".rb-lead code").length, bars: A.querySelectorAll(".rb-bar-seg").length, foot: A.querySelector(".rb-foot") && A.querySelector(".rb-foot").textContent, wm: A.querySelectorAll(".rb-wm").length,
    w: A.getBoundingClientRect().width, over: g("rpt-body").scrollWidth - g("rpt-body").clientWidth, html: A.querySelectorAll("script, iframe").length, wmColor: getComputedStyle(A.querySelector(".rb-wm")).fill, tok: getComputedStyle(document.documentElement).getPropertyValue("--color-watermark").trim() }; })()`);
  { const meta = WEEKLY.blocks[0]; const foot = meta.origin ? await T(meta.origin === "scheduled" ? "rb.footScheduled" : "rb.footChat", { where: await T("lib.where.local") }) : null;
    ok("④ 週報:標題、kpi 六格、折線 + 回撤(+ bar)SVG、熱圖、明細表、metric 表、callout、lead 段(markdown 接 mdPaint:行內 code 是 <code>)、多空敞口條、腳注帶「這台電腦」;寬 680、不橫溢;浮水印吃 --color-watermark", a.title.startsWith("績效週報") && a.kpi === WEEKLY.blocks.find((b) => b.type === "kpi_row").items.length && a.charts >= 2 && a.heat > 0 && a.table > 0 && a.metrics > 0 && a.callout === 1 && a.lead && a.lead.startsWith("本週 +1.82%") && a.code >= 1 && a.bars >= 2
      && a.foot === foot && a.wm >= 2 && Math.round(a.w) <= 680 && a.w > 400 && a.over <= 0 && a.html === 0 && a.wmColor !== "" && a.tok !== "", JSON.stringify(a)); }
  // 圖:file 缺檔 → 失敗框(alt);有 data URI → img
  await js(`window.__r.docs["mcpt-2317"] = { report: ${JSON.stringify(Object.assign({}, MCPT, { blocks: MCPT.blocks.concat([{ type: "image", file: "nope.png", alt: "缺的圖" }, { type: "image", file: "ok.gif", alt: "有的圖" }, { type: "wtf_block", x: 1 }]) }))}, images: { "ok.gif": ${JSON.stringify(GIF)} } };
    document.getElementById("rpt-back").click(); document.querySelector('#rpt-rows .rpt-row[data-id="mcpt-2317"]').click();`); await wait(600);
  a = await js(`(() => { ${Q} const A = g("rpt-read").querySelector("article.rb-report"); const fn = A.querySelectorAll("a.rb-fnref"); const before = location.href; fn[0].click(); return { h2: [...A.querySelectorAll(".rb-text h2")].map((x) => x.textContent).join("|"), strong: A.querySelectorAll(".rb-text strong").length, ol: A.querySelectorAll(".rb-text ol li").length, code: A.querySelectorAll(".rb-text code").length,
    fnref: fn.length, fnText: [...fn].map((x) => x.textContent).join(), fnHref: [...fn].map((x) => x.getAttribute("href")).join(), links: A.querySelectorAll("a:not(.rb-fnref)").length, fns: A.querySelectorAll(".rb-footnotes .rb-fn").length, jumped: document.activeElement && document.activeElement.id, nav: location.href === before,
    fail: [...A.querySelectorAll(".rb-image-fail")].map((x) => x.textContent).join("|"), img: [...A.querySelectorAll(".rb-image img")].map((x) => x.src.slice(0, 15) + "|" + x.alt).join(), hist: A.querySelectorAll(".rb-hist-bar").length, box: A.querySelectorAll(".rb-box").length, pts: A.querySelectorAll(".rb-pt1, .rb-pt2").length, quote: A.querySelectorAll(".rb-quote").length, codeBlk: A.querySelectorAll(".rb-code .rb-tok-c, .rb-code .rb-tok-n").length, mono: A.querySelectorAll(".rb-text .mono").length }; })()`);
  ok("④ MCPT:markdown 走外殼的 mdPaint(h2「方法」、粗體、有序清單、行內 code)、尾註引用 [^id] → a.rb-fnref(序號、#fn-id、點了跳到那條註解且不導覽)、契約不支援的連結沒有 <a>、尾註 3 條、直方圖 / 箱形 / 散點 / 引言 / Python 高亮、敘事段自動 .mono;圖:缺檔 → 失敗框(alt)、有 data URI → <img>;不認得的 block 跳過",
    a.h2.includes("方法") && a.strong >= 2 && a.ol >= 3 && a.code >= 1 && a.fnref >= 2 && a.fnText.startsWith("1,2") && a.fnHref.startsWith("#fn-1,#fn-2") && a.links === 0 && a.fns === 3 && a.jumped === "fn-1" && a.nav
    && a.fail === (await T("rb.imageError")) + "缺的圖" && a.img.startsWith("data:image/gif") && a.img.endsWith("|有的圖") && a.hist > 0 && a.box > 0 && a.pts > 0 && a.quote === 1 && a.codeBlk > 0 && a.mono > 0, JSON.stringify(a));
  // 返回:清單不重畫(捲動、選中列留著)、焦點回那一列
  await js(`document.getElementById("rpt-back").click();`); v = await view();
  ok("④ 返回:回清單、剛讀的那份 aria-current、焦點回那一列、鈕照常", !v.headList && v.back && v.read && v.ids === "wk-2026-08-31,mcpt-2317,am-0901" && v.current === "mcpt-2317" && v.focus === "mcpt-2317" && v.article === 0, JSON.stringify(v));
  // 新增報告 modal
  const box = () => js(`(() => { ${Q} const sc = g("rpn-scrim"), f = g("rpn-modal"); return { open: !sc.hidden, cloud: f.querySelector(".modal-head").classList.contains("cloud"), env: g("rpn-env").hidden, where: g("rpn-where").hidden, honest: g("rpn-honest").textContent, chips: q("#rpn-modal .pf-act").map((b) => b.textContent).join("|"), desc: g("rpn-desc").value, descH: g("rpn-desc").getBoundingClientRect().height,
    dis: g("rpn-send").disabled, msg: g("rpn-msg").textContent, busy: q("#rpn-msg .cf-busy .spin16").length, focus: document.activeElement && document.activeElement.id, inert: g("view-ws").inert, w: f.getBoundingClientRect().width, send: g("rpn-send").textContent }; })()`);
  await js(`(async () => { document.getElementById("rpt-ask").click(); await new Promise((r) => setTimeout(r, 120)); })()`); await wait(60); let bx = await box();
  ok("④ 「新增報告」→ 開框:440、焦點在描述欄、5 顆 .pf-act 範例 chip、誠實句(不帶目的地)、送出鈕「請 agent 建立」常態可按、本機不掛雲端記號、底下 inert", bx.open && Math.round(bx.w) === 440 && bx.focus === "rpn-desc" && bx.chips.split("|").length === 5 && bx.chips.startsWith(await T("rpt.new.chip.tw")) && bx.honest === (await T("rpt.new.honest"))
    && !bx.dis && bx.send === (await T("rpt.new.send")) && !bx.cloud && bx.env && bx.where && bx.inert && bx.msg === "", JSON.stringify(bx));
  const h0 = bx.descH;
  await js(`document.querySelector('#rpn-modal [data-tpl="rpt.new.tpl.research"]').click();`); bx = await box();
  ok("④ 點範例 chip → 範本填進描述欄(逐字 = web 的 workspace_rp_tpl_research)、欄撐高、焦點回描述欄", bx.desc === (await T("rpt.new.tpl.research")) && bx.descH > h0 && bx.focus === "rpn-desc", JSON.stringify(bx));
  const n0 = await js("window.__r.sent.length");
  await js(`document.getElementById("rpn-desc").value = "  "; document.getElementById("rpt-h").focus(); document.getElementById("rpn-send").click();`); bx = await box();
  ok("④ 描述欄空著按送出:不送、焦點回描述欄、不出錯字、框留著", bx.open && (await js("window.__r.sent.length")) === n0 && bx.focus === "rpn-desc" && bx.msg === "", JSON.stringify(bx));
  // 失敗:framework 回 false → 框留著、欄位不清、腳那一句、鈕回復
  await js(`window.__r.sendResult = { started: false }; document.getElementById("rpn-desc").value = "台股晨報"; document.getElementById("rpn-send").click();`); await wait(150); bx = await box();
  ok("④ 送出失敗:框留著、描述不清、腳「送不出去…」、鈕回復;沒記 pending、沒有 reports_ask", bx.open && bx.desc === "台股晨報" && bx.msg === (await T("modal.sendFailed")) && !bx.dis && (await js("RPT.pending.local === null && !window.__r.tracked.includes('reports_ask')")), JSON.stringify(bx));
  // 成功:逐字那句、關框、清欄、pending、對話不貼回音、工具列「agent 寫作中…」、reports_ask
  await js(`window.__r.sendResult = new Promise((res) => { window.__r.release = () => res({ started: true }); }); running = false; RPT.fail = false; document.getElementById("rpn-send").click();`); await wait(120);
  const lock = await js(`(() => ({ send: document.getElementById("rpn-send").disabled, cancel: document.getElementById("rpn-cancel").disabled, x: document.getElementById("rpn-close").disabled, busy: document.querySelectorAll("#rpn-msg .cf-busy .spin16").length, open: !document.getElementById("rpn-scrim").hidden }))()`);
  ok("④ 送出中:送出 / 取消 / ✕ 三顆都 disabled、圓環 + 送出中…、框留著(設計稽核 必-4)", lock.send && lock.cancel && lock.x && lock.busy === 1 && lock.open, JSON.stringify(lock));
  await js(`window.__r.release();`); await wait(200); bx = await box(); v = await view();
  let s = await js(`(() => { ${Q} const m = window.__r.sent[window.__r.sent.length - 1]; const msgs = q("#chat-scroll .msg"); return { msg: m.message, env: m.viewing.env, last: msgs[msgs.length - 1].className + ":" + msgs[msgs.length - 1].textContent, pending: RPT.pending.local && RPT.pending.local.env + ":" + [...RPT.pending.local.before].join(), tracked: window.__r.tracked.includes("reports_ask") }; })()`);
  ok("④ 送出成功:對話收到「幫我建立報告：「台股晨報」。這份只要產出一次，不用建立排程。」(viewing.env=local)、關框、欄清空、焦點退到 h5(開它的鈕已停用);pending 記著送出前的三個 id;對話最後一行是用戶那句(不貼 sys 回音);工具列鈕「agent 寫作中…」disabled + rpt.note.pending;reports_ask",
    s.msg === "幫我建立報告：「台股晨報」。這份只要產出一次，不用建立排程。" && s.env === "local" && !bx.open && bx.desc === "" && bx.focus === "rpt-h" && s.pending === "local:wk-2026-08-31@,mcpt-2317@,am-0901@" && s.last === "msg you:" + s.msg && s.tracked
    && v.ask === (await T("rpt.asking")) && v.askDis && v.msg === (await T("rpt.note.pending")) && !v.msgErr, JSON.stringify([s, bx, v]));
  a = await js(`(() => { const keep = RPT.data.local; RPT.data.local = []; rptPaintList(); const o = { l1: document.querySelectorAll("#rpt-state.rpt-empty .l1").length, l2: document.querySelectorAll(".rpt-empty .l2").length, msg: document.getElementById("rpt-msg").textContent }; RPT.data.local = keep; rptPaintList(); return o; })()`);
  ok("④ 空＋寫作中:訊息槽 rpt.note.pending、空狀態只剩名詞句(.rpt-empty .l2 不存在)", a.l1 === 1 && a.l2 === 0 && a.msg === (await T("rpt.note.pending")), JSON.stringify(a));
  // turn-end:多出新報告 → 自動打開
  const NEW = Object.assign({}, WEEKLY, { id: "new1", title: "新的報告" });
  await js(`window.__r.list = { reports: ${JSON.stringify([{ id: "new1", title: "新的報告", type: "performance", created_at: 1799999999 }].concat(LIST))} }; window.__r.docs.new1 = { report: ${JSON.stringify(NEW)}, images: {} }; running = false; rptTurnEnd();`); await wait(700); v = await view();
  a = await js(`(() => ({ reading: rptBag("local").reading, pending: RPT.pending.local, title: document.querySelector("#rpt-read .rb-title") && document.querySelector("#rpt-read .rb-title").textContent, loaded: window.__r.calls.filter((x) => x === "load:new1").length }))()`);
  ok("④ turn-end:本機多出 new1 → 自動跳到閱讀頁(bag.reading = new1、讀了 new1、article 畫出:標題由 meta block 給)、pending 收掉、鈕回「新增報告」、焦點在返回鈕", a.reading === "new1" && a.pending === null && a.loaded === 1 && a.title === WEEKLY.blocks[0].title && v.article === 1 && v.headList && !v.back && v.focus === "rpt-back", JSON.stringify([a, v]));
  // 沒新報告:灰字;離開視圖就清
  await js(`document.getElementById("rpt-back").click(); RPT.pending.local = { env: "local", before: new Set(RPT.data.local.map(rptKey)) }; rptTurnEnd();`); await wait(300); v = await view();
  ok("④ turn-end 沒多出東西:工具列鈕回原樣、灰記號 + rpt.err.noNew", v.ask === (await T("rpt.ask")) && !v.askDis && v.msg === (await T("rpt.err.noNew")) && v.msgErr && v.mark === 1, JSON.stringify(v));
  // B1:同 id 覆寫(mtime 變、本體換)→ 算新報告、自動打開、讀到新本體(不是快取的舊的)
  await js(`RPT.pending.local = { env: "local", before: new Set(RPT.data.local.map(rptKey)) }; window.__r.list = { reports: ${JSON.stringify([{ id: "new1", title: "新的報告(改過)", type: "performance", created_at: 1799999999, mtime: 2 }].concat(LIST))} };
    window.__r.docs.new1 = { report: ${JSON.stringify(Object.assign({}, NEW, { blocks: [Object.assign({}, WEEKLY.blocks[0], { title: "改過的標題" })].concat(WEEKLY.blocks.slice(1)) }))}, images: {} }; rptTurnEnd();`); await wait(700); v = await view();
  a = await js(`(() => ({ reading: rptBag("local").reading, title: document.querySelector("#rpt-read .rb-title") && document.querySelector("#rpt-read .rb-title").textContent, noNew: RPT.noNew }))()`);
  ok("④ B1 同 id 覆寫:mtime 變了就算新報告 → 自動打開、畫的是新本體(標題換了)、上一輪的 noNew 灰字清掉", a.reading === "new1" && a.title.startsWith("改過的標題") && a.noNew === null && v.article === 1 && v.msg === null, JSON.stringify([a, v]));
  // 設計稽核:等待期間人在別的視圖(自動下單)→ 不拉回,側欄入口只做記號;回到報告區記號收掉
  await js(`(async () => { await trOpen("over"); RPT.pending.local = { env: "local", before: new Set(RPT.data.local.map(rptKey)) }; window.__r.list = { reports: ${JSON.stringify([{ id: "new2", title: "又一份", type: "research", created_at: 1799999998 }, { id: "new1", title: "新的報告(改過)", type: "performance", created_at: 1799999999, mtime: 2 }].concat(LIST))} }; rptTurnEnd(); })()`); await wait(500);
  a = await js(`(() => ({ tr: !document.getElementById("tr").hidden, rpt: !document.getElementById("rpt").hidden, mark: document.getElementById("rpt-nav-new").hidden, reading: rptBag("local").reading }))()`);
  await js(`(async () => { document.getElementById("rpt-nav").click(); await new Promise((r) => setTimeout(r, 150)); })()`); await wait(60);
  const b6 = await js(`(() => { const mark = document.getElementById("rpt-nav-new").hidden, reading = rptBag("local").reading; document.getElementById("rpt-back").click(); return { rpt: !document.getElementById("rpt").hidden, mark, reading, ids: [...document.querySelectorAll("#rpt-rows .rpt-row")].map((b) => b.dataset.id).join() }; })()`);
  ok("④ 等待期間切到自動下單:報告好了不拉回(仍在自動下單、報告區收著、仍記著上次在讀 new1)、側欄「報告」出記號;點進報告 → 回到原本在讀的那份、記號收掉、返回清單有 new2", a.tr && !a.rpt && !a.mark && a.reading === "new1" && b6.rpt && b6.mark && b6.reading === "new1" && b6.ids === "new1,new2,wk-2026-08-31,mcpt-2317,am-0901", JSON.stringify([a, b6]));
  await js(`(async () => { await libOpen(); await new Promise((r) => setTimeout(r, 60)); document.getElementById("rpt-nav").click(); await new Promise((r) => setTimeout(r, 120)); })()`); await wait(60); v = await view();
  ok("④ 開策略庫(互斥:#rpt 收、入口 aria-current 拿掉)再回來:灰字清掉、清單重問(5 份)", v.on && v.msg === null && v.ids.split(",").length === 5 && v.count === (await T("rpt.count.other", { n: 5 })), JSON.stringify(v));
  // 回合中:鈕 disabled + turn.busy
  await js(`running = true; rptSync();`); v = await view(); const busyOk = v.askDis && v.msg === (await T("turn.busy")); await js(`running = false; rptSync();`);
  ok("④ 回合中:「新增報告」disabled + turn.busy;結束回復", busyOk && !(await view()).askDis, JSON.stringify(v));
  // 兩袋:本機在讀 new1;切到雲端(停機)→ 雲端清單照 api 順序、鈕 disabled + ho.gate.stopped;切回本機仍在讀 new1
  await js(`document.querySelector('#rpt-rows .rpt-row[data-id="new1"]').click();`); await wait(450);
  await js(`window.__r.cloudList = { code: "OK", reports: [{ id: "c-old", title: "雲端舊", type: "morning", created_at: 1, stored_at: 9 }, { id: "c-new", title: "雲端新", type: "research", created_at: 5, stored_at: 8 }] };
    ENV.cur = "cloud"; TR_BAGS.cloud.st = { cloud: { code: "OK", machine: { state: "stopped" } } }; document.getElementById("cv-empty").hidden = true; envShowMain();`); await wait(60);
  v = await view();
  ok("④ 切到雲端:雲端那袋沒開 → #rpt 收(本機那袋還記著在讀 new1)", !v.on && (await js(`rptBag("local").reading`)) === "new1" && (await js(`rptBag("cloud").open`)) === false, JSON.stringify(v));
  await js(`(async () => { await rptOpen(); await new Promise((r) => setTimeout(r, 120)); })()`); await wait(60); v = await view();
  ok("④ 雲端視角開報告:清單照 api 的順序(不重排)、鈕 disabled + ho.gate.stopped(平台有本體,清單照畫)、焦點退到 h5", v.on && v.ids === "c-old,c-new" && v.askDis && v.msg === (await T("ho.gate.stopped")) && v.focus === "rpt-h" && (await js("window.__r.cloudCalls.join()")).includes("list:false"), JSON.stringify(v));
  await js(`rptNewOpen(document.getElementById("rpt-h"));`); await wait(100); bx = await box();
  ok("④ 雲端的新增報告框:標題列 .cloud + 「雲端」記號 + 腳的目的地句、誠實句與本機同一句;停機 → 送出 disabled + ho.gate.stopped", bx.open && bx.cloud && !bx.env && !bx.where && bx.honest === (await T("rpt.new.honest")) && bx.dis && bx.msg === (await T("ho.gate.stopped")), JSON.stringify(bx));
  await js(`rptNewClose();`);
  // 雲端讀一份:走 cloudReport
  await js(`window.__r.cloudDocs["c-new"] = { code: "OK", report: ${JSON.stringify(Object.assign({}, WEEKLY, { id: "c-new" }))}, images: {} }; document.querySelector('#rpt-rows .rpt-row[data-id="c-new"]').click();`); await wait(450); v = await view();
  a = await js(`(() => ({ foot: document.querySelector("#rpt-read .rb-foot") && document.querySelector("#rpt-read .rb-foot").textContent, calls: window.__r.cloudCalls.filter((x) => x === "load:c-new").length }))()`);
  { const meta = WEEKLY.blocks[0]; const foot = meta.origin ? await T(meta.origin === "scheduled" ? "rb.footScheduled" : "rb.footChat", { where: await T("lib.where.cloud") }) : null;
    ok("④ 雲端讀一份:走 cloudReport、article 畫出、腳注帶「雲端主機」", v.article === 1 && a.calls === 1 && a.foot === foot, JSON.stringify([v, a])); }
  // 雲端讀不到清單(沒有舊清單)→ 錯誤 + 重試;有舊清單就照畫舊的
  await js(`window.__r.cloudList = { code: "UNREACH", reports: [] }; rptLoad("cloud", true);`); await wait(120); v = await view();
  const kept = v.article === 1;   // 在讀:清單失敗不動閱讀頁
  await js(`document.getElementById("rpt-back").click(); rptLoad("cloud", true);`); await wait(120); v = await view();
  ok("④ 雲端清單讀不到:手上有舊清單就照畫舊的(不蓋掉)", kept && v.ids === "c-old,c-new" && v.state === null, JSON.stringify(v));
  await js(`RPT.data.cloud = null; rptLoad("cloud", true);`); await wait(120); v = await view();
  ok("④ 沒有舊清單 → 「讀不到雲端的報告清單。」+ 重試", v.state === (await T("rpt.error")) + (await T("rpt.retry")) && v.stateBtns === 1 && v.ids === "", JSON.stringify(v));
  await js(`window.__r.cloudList = { code: "OK", reports: [{ id: "c-old", title: "雲端舊", type: "morning", created_at: 1 }] }; document.querySelector("#rpt-state .btn-out").click();`); await wait(450); v = await view();
  ok("④ 重試成功 → 一列", v.ids === "c-old" && v.state === null, JSON.stringify(v));
  // 雲端 turn-end:輪詢,新 id 出現就停、pending 收掉
  // B5:輪詢中再來一次 turn-end 不重開 10 分鐘窗;B2:雲端 pending 與本機 pending 各一份、互不蓋
  await js(`RPT.pending.cloud = { env: "cloud", before: new Set(["c-old@"]) }; RPT.pending.local = { env: "local", before: new Set() }; window.__r.cloudList = { code: "OK", reports: [{ id: "c-old", title: "雲端舊", created_at: 1 }] }; window.__r.list = { reports: [] }; rptTurnEnd();`); await wait(300);
  a = await js(`(() => ({ until: RPT.poll && RPT.poll.until, pendingCloud: !!RPT.pending.cloud, pendingLocal: RPT.pending.local, noNew: RPT.noNew }))()`);
  await js(`RPT.pending.local = { env: "local", before: new Set() }; rptTurnEnd();`); await wait(300);
  const b5 = await js(`(() => ({ until: RPT.poll && RPT.poll.until, pendingCloud: !!RPT.pending.cloud }))()`);
  ok("④ B5 / B2:雲端 pending 進輪詢;本機那份 turn-end 各走各的(本機沒新報告 → noNew,雲端 pending 還在);再一次 turn-end 不重開窗(until 不變)", a.until > 0 && a.pendingCloud && a.pendingLocal === null && a.noNew === "local" && b5.until === a.until && b5.pendingCloud, JSON.stringify([a, b5]));
  await js(`rptCloudPollStop(); RPT.noNew = null; RPT.pending.cloud = { env: "cloud", before: new Set(["c-old@"]) }; window.__r.cloudList = { code: "OK", reports: [{ id: "c-old", title: "雲端舊", created_at: 1 }, { id: "c-x", title: "X", created_at: 1e13 }] }; rptTurnEnd();`); await wait(300);
  a = await js(`(() => ({ pending: RPT.pending.cloud, poll: RPT.poll, ids: [...document.querySelectorAll("#rpt-rows .rpt-row")].map((b) => b.dataset.id).join(), reading: rptBag("cloud").reading, stamp: document.querySelector('#rpt-rows .rpt-row[data-id="c-x"] .m .mono').textContent }))()`);
  ok("④ 雲端 turn-end:第一次輪詢就看到新 id → 停、pending 收掉、清單多一列、不自動打開(雲端);印不出的時間戳畫 —(B4)", a.pending === null && a.poll === null && a.ids === "c-old,c-x" && a.reading === null && a.stamp === "—", JSON.stringify(a));
  // 切回本機:仍在讀 new1
  await js(`ENV.cur = "local"; TR_BAGS.cloud.st = null; envShowMain();`); await wait(60); v = await view();
  ok("④ 切回本機:回到本機那袋——仍在讀 new1、article 畫出", v.on && v.headList && !v.back && v.article === 1 && (await js(`rptBag("local").reading`)) === "new1", JSON.stringify(v));
  // en:組句
  await js(`(async () => { setLang("en"); applyStatic(); document.getElementById("rpt-back").click(); RPT.pending.local = null; running = false; rptSync(); document.getElementById("rpt-ask").click(); await new Promise((r) => setTimeout(r, 100)); document.getElementById("rpn-desc").value = "daily brief"; document.getElementById("rpn-send").click(); })()`); await wait(250);
  s = await js(`(() => { const m = window.__r.sent[window.__r.sent.length - 1]; const out = { msg: m.message, h: document.getElementById("rpt-h").textContent, ask: document.getElementById("rpt-ask-t").textContent }; setLang("zh"); applyStatic(); return out; })()`);
  ok("④ en:送出的是 web 的英文句、頁首與鈕換字", s.msg === 'Write me a report: "daily brief". Produce it once — no schedule needed.' && s.h === "Reports" && s.ask === "Agent is writing…", JSON.stringify(s));
  ok("④ 整個流程沒有開過外部瀏覽器、reports.js 的字只進 textContent(#rpt-rows 沒有 img / script)", (await js(`document.querySelectorAll("#rpt-rows img, #rpt-rows script").length`)) === 0);

  console.log(red ? `\n④ ${red} 紅` : "\n④ ALL PASS");
  app.exit(red ? 1 : 0);
});
