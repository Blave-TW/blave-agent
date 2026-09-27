// 報告公開分享(spec-share-0.1.8 DT1–DT5)+ 引用圖來源行(spec-report-image-cite-0.1.8 §2)。
//   ① 純邏輯(從 renderer/report-share.js 切出來跑):閘門、分享網址、「內容已更新」判定(本機 mtime 容差 / 雲端兩個收件時間)、lead 首句(= web leadSentence)、錯誤代號 → 字。
//   ② shell/reportshare.js:每支端點的 body 欄位逐一列舉(api 對多出的欄位回 400)、聲明 / 條款版本由主行程加、本機才帶全文與圖、
//      沒登入 / 舊登入不出門、請求途中換帳號丟掉、status → 代號。有 api 原始碼(monorepo 或 BLAVE_API_DIR)時對照 api 的欄位白名單;有 web 時對照條款版本。
//   ③ main.js reportForShare:本體原樣 + image block 引用的 sidecar 圖(base64)、壞檔名 / 缺檔跳過。
//   ④ 用隨包的 Electron 開真的 index.html(window.blave 換成假的):頁首「分享」只給能公開的類型 → 確認框(勾了才能送、名字讀不到就停用)→
//      送出的只有 view / id / 掛名 / 勾 → 公開列 + 埋點 → stale 行 → 取消分享(「繼續分享」/「取消分享」、埋點、回到未公開)→ 引用圖的來源行。
// 跑法:node tests/check_shell_report_share.js
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer"), MONO = path.join(__dirname, "..", "..");
const GATE = require("./_electron_gate");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 1500))); if (!c) red++; };
const read = (f) => fs.readFileSync(f, "utf8");
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };

if (!process.versions.electron) {
  (async () => {
    // ── ① 純邏輯 ──
    const src = read(path.join(R, "report-share.js")), A = "/* ── 純邏輯", B = "/* ── 純邏輯到此 ── */";
    const P = {}; vm.runInNewContext(src.slice(src.indexOf(A), src.indexOf(B)) + "\nObject.assign(this, { shrGate, shrUrl, shrStale, shrLead, shrKind, shrErrKey, SHR_CLOCK_SLACK_MS });", P);
    ok("① 閘門:research / morning / 缺 type 出入口,performance 與沒有 blocks 的不出", P.shrGate({ type: "research", blocks: [] }) && P.shrGate({ type: "morning", blocks: [] }) && P.shrGate({ blocks: [] }) && !P.shrGate({ type: "performance", blocks: [] }) && !P.shrGate({ type: "research" }) && !P.shrGate(null));
    ok("① 分享網址 = blave.org/<app 語言>/r/<代碼>?src=research_link(代碼 encode)", P.shrUrl("zh", "k7Q") === "https://blave.org/zh/r/k7Q?src=research_link" && P.shrUrl("en", "a b") === "https://blave.org/en/r/a%20b?src=research_link" && P.shrUrl("xx", "c") === "https://blave.org/en/r/c?src=research_link");
    const pub = 1790000000, S = { published_at: pub, source_stored_at: null, report_stored_at: null };
    const within = P.shrStale("local", S, pub * 1000 + P.SHR_CLOCK_SLACK_MS), past = P.shrStale("local", S, pub * 1000 + P.SHR_CLOCK_SLACK_MS + 1000);
    ok("① 本機:mtime 比公開時間晚不到一分鐘不算更新(兩邊的鐘不同);晚過一分鐘 → { time: mtime 秒, day: 公開時間 };沒有 mtime → 不判斷", within === null && past && past.time === pub + 61 && past.day === pub && P.shrStale("local", S, null) === null && P.SHR_CLOCK_SLACK_MS === 60000, JSON.stringify(past));
    ok("① 雲端:report_stored_at > source_stored_at 才算更新(同 web shareState);缺一個 / 相等 → null", JSON.stringify(P.shrStale("cloud", { published_at: pub, source_stored_at: 10, report_stored_at: 20 }, 9e15)) === '{"time":20,"day":10}' && P.shrStale("cloud", { published_at: pub, source_stored_at: 10, report_stored_at: 10 }) === null && P.shrStale("cloud", { published_at: pub, source_stored_at: 10, report_stored_at: null }) === null);
    const leads = ["融資連續 5 天增加。之後二十天中位數不變", "**BTC** 資金費率 `0.01%` 轉正[^a]!後面", "- 第一點\n- 第二點", "Plain English lead. Second sentence.", "x".repeat(200)];
    const rep = (md) => ({ blocks: [{ type: "meta" }, { type: "text", variant: "lead", markdown: md }] });
    const WEB_SH = path.join(MONO, "web", "app", "static", "js", "agent", "report_share.js");
    if (!fs.existsSync(WEB_SH)) console.log("SKIP  ① lead 首句與 web 逐樣本比對(需要 monorepo 版面)");
    else { const W = {}; vm.runInNewContext(cutFn(read(WEB_SH), "leadSentence") + "\nthis.f = leadSentence;", W);
      ok("① lead 首句 = web leadSentence(五個樣本:中文句號、markdown 記號與尾註、清單、英文句點、超長截 120)", leads.every((m) => P.shrLead(rep(m)) === W.f(rep(m))), JSON.stringify(leads.map((m) => [P.shrLead(rep(m)), W.f(rep(m))]))); }
    const STR = (() => { const sb = {}; vm.runInNewContext(read(path.join(R, "strings.js")) + "\nthis.S = STRINGS;", sb); return sb.S; })();
    const codes = ["UNREACH", "RELOGIN", "RATE_LIMITED", "IMAGE_QUOTA", "NO_MACHINE", "NOT_SHAREABLE", "NO_REPORT", "BAD_ARGS", "WHATEVER"];
    ok("① 錯誤代號 → 字:連不上 = 檢查網路那句、雲端沒在跑 = web 那句、配額 / 速率 / 重新登入各自一句、驗不過 = 不能公開;每個 key 兩語都在", P.shrErrKey("UNREACH") === "shr.failed" && P.shrErrKey("WHATEVER") === "shr.failed" && P.shrErrKey("NO_MACHINE") === "shr.failedCloud" && P.shrErrKey("IMAGE_QUOTA") === "shr.quota" && P.shrErrKey("RELOGIN") === "conn.expired" && P.shrErrKey("NOT_SHAREABLE") === "shr.notShareable"
      && codes.every((c) => STR.zh[P.shrErrKey(c)] && STR.en[P.shrErrKey(c)]));
    ok("① 確認框三行 + 標題照 W1 定稿(zh / en)", STR.zh["shr.ack2"] === "內容由我的 Blave Agent 產出，公開是我的決定，後果由我負責；Blave 未審核" && STR.en["shr.ack2"] === "This content was produced by my Blave Agent; publishing it is my decision and my responsibility, and Blave has not reviewed it."
      && STR.zh["shr.dlgTitle"] === "公開這份報告" && STR.en["shr.dlgTitle"] === "Publish this report" && STR.zh["shr.revokeTitle"] === "取消分享這份報告？" && STR.en["shr.revokeTitle"] === "Stop sharing this report?");

    // ── ② reportshare.js ──
    const RS = require(path.join(SHELL, "reportshare.js"));
    const mk = (o = {}) => { const calls = []; let creds = o.creds === undefined ? { token: "tok", appSecret: "sec" } : o.creds;
      const c = RS.createShareClient({ apiBase: "https://api.x", getCreds: () => creds, readLocal: o.readLocal || ((id) => ({ report: { id, blocks: [] }, images: { "a.png": "QUJD" } })),
        post: async (u, b) => { calls.push({ u, b }); if (o.swap) creds = { token: "other", appSecret: "sec" }; return typeof o.res === "function" ? o.res(u, b) : o.res || { status: 200, body: { share: { code: "Abcd1234", published_at: 1790000000, byline: null, source_stored_at: null, report_stored_at: null }, display_name: "Wei" } }; } });
      return { c, calls }; };
    const keys = (b) => Object.keys(b).sort().join();
    let m = mk(); let r = await m.c.state("local", "tw-market-20260926");
    ok("② state:打 /share/state,body 只有 token / app_secret / view / id;回 share(整理過)+ displayName", m.calls[0].u === "https://api.x/oauth/desktop/share/state" && keys(m.calls[0].b) === "app_secret,id,token,view" && r.code === "OK" && r.share.code === "Abcd1234" && r.displayName === "Wei", JSON.stringify([m.calls, r]));
    m = mk({ res: { status: 200, body: { share: null, display_name: "  " } } }); r = await m.c.state("cloud", "x");
    ok("② state:沒公開 → share null;空白名字 → displayName null(署名選項停用)", r.code === "OK" && r.share === null && r.displayName === null);
    m = mk(); r = await m.c.publish("local", "tw-1", { byline: "name", confirmed: true });
    const pb = m.calls[0] && m.calls[0].b;
    ok("② publish(本機):/share/publish;body = 憑證兩欄 + view / id + 勾選紀錄四欄 + report / images(本機檔原樣),聲明版本 rs-ack-2026.09.27", m.calls[0].u.endsWith("/oauth/desktop/share/publish") && keys(pb) === "app_secret,byline,confirmed,disclaimer_version,id,images,report,token,tos_version,view"
      && pb.confirmed === true && pb.byline === "name" && pb.disclaimer_version === "rs-ack-2026.09.27" && pb.tos_version === RS.TOS_VERSION && pb.report.id === "tw-1" && pb.images["a.png"] === "QUJD" && r.code === "OK" && r.share.code === "Abcd1234", JSON.stringify(pb));
    m = mk(); await m.c.publish("cloud", "tw-1", { byline: "anonymous", confirmed: true, update: true });
    ok("② update(雲端):/share/update;雲端不帶 report / images(api 對雲端帶這兩欄回 400)", m.calls[0].u.endsWith("/oauth/desktop/share/update") && keys(m.calls[0].b) === "app_secret,byline,confirmed,disclaimer_version,id,token,tos_version,view");
    m = mk(); r = await m.c.revoke("local", "tw-1");
    ok("② revoke:/share/revoke,body 只有四欄", m.calls[0].u.endsWith("/oauth/desktop/share/revoke") && keys(m.calls[0].b) === "app_secret,id,token,view" && r.code === "OK");
    const refused = [];
    for (const [why, fn] of [["沒勾", (c) => c.publish("local", "x", { byline: "anonymous", confirmed: false })], ["掛名不是二選一", (c) => c.publish("local", "x", { byline: "Wei 顧問", confirmed: true })],
      ["view 不認得", (c) => c.state("web", "x")], ["id 帶路徑", (c) => c.state("local", "../x")]]) { m = mk(); r = await fn(m.c); if (m.calls.length || r.code !== "BAD_ARGS") refused.push(why + ":" + r.code); }
    m = mk({ readLocal: () => null }); r = await m.c.publish("local", "x", { byline: "anonymous", confirmed: true }); if (m.calls.length || r.code !== "NO_REPORT") refused.push("本機檔讀不到:" + r.code);
    m = mk({ creds: null }); r = await m.c.state("local", "x"); if (m.calls.length || r.code !== "NO_LOGIN") refused.push("沒登入:" + r.code);
    m = mk({ creds: { token: "t", appSecret: null } }); r = await m.c.state("local", "x"); if (m.calls.length || r.code !== "RELOGIN") refused.push("沒有 app_secret:" + r.code);
    ok("② 不出門的七種:沒勾、掛名不是二選一、view 不認得、id 帶路徑、本機檔讀不到、沒登入、舊登入沒有 app_secret", refused.length === 0, refused.join(" / "));
    m = mk({ swap: true }); r = await m.c.state("local", "x");
    ok("② 請求途中換了帳號:回應是上一個人的,丟掉(UNREACH)", r.code === "UNREACH");
    const fc = (status, body, op) => RS.failCode({ status, body }, op);
    ok("② status → 代號:409 已公開 / 422 不能公開 / 507 配額 / 401 重新登入 / 429 / 403 雲端沒在跑 / 5xx 與連不上 = UNREACH / 400 NO_DISPLAY_NAME / 其餘 400·413 = 不能公開 / 404 分 publish 與 update·revoke",
      fc(409) === "ALREADY" && fc(422) === "NOT_SHAREABLE" && fc(507) === "IMAGE_QUOTA" && fc(401) === "RELOGIN" && fc(429) === "RATE_LIMITED" && fc(403) === "NO_MACHINE" && fc(502) === "UNREACH" && RS.failCode(null) === "UNREACH"
      && fc(400, { error_code: "NO_DISPLAY_NAME" }) === "NO_DISPLAY_NAME" && fc(400, { error: "blocks[3]: bad" }) === "NOT_SHAREABLE" && fc(413) === "NOT_SHAREABLE" && fc(404, {}, "publish") === "NOT_SHAREABLE" && fc(404, {}, "update") === "NOT_PUBLIC" && fc(404, {}, "revoke") === "NOT_PUBLIC");
    m = mk({ res: { status: 200, body: { share: { code: "<x>", published_at: 1 } } } }); r = await m.c.publish("cloud", "x", { byline: "anonymous", confirmed: true });
    ok("② 200 但 share 形狀不對(代碼字元集 / 時間範圍)→ 不當成功", r.code === "UNREACH");
    const apiDir = process.env.BLAVE_API_DIR || path.join(MONO, "api"), apiPy = path.join(apiDir, "openclaw", "desktop_auth.py");
    const apiSrc = fs.existsSync(apiPy) ? read(apiPy) : "";
    if (!/"\/share\/state"/.test(apiSrc)) console.log("SKIP  ② 對照 api 的欄位白名單(找不到帶 /share/* 的 desktop_auth.py;可設 BLAVE_API_DIR)");
    else { const shPy = path.join(apiDir, "openclaw", "agent_report_share.py"), shSrc = fs.existsSync(shPy) ? read(shPy) : "";
      const tup = (src, name) => { const mm = new RegExp("^" + name + " = (?:frozenset\\()?\\(([^)]*)\\)", "m").exec(src); return mm ? [...mm[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : []; };
      const base = /^_SHARE_BASE = _SHARE_CREDS \| \{"view", "id"\}$/m.test(apiSrc) ? [...tup(apiSrc, "_SHARE_CREDS"), "view", "id"] : [];
      const allowed = new Set([...base, ...tup(shSrc, "CONSENT_FIELDS"), "report", "images"]);
      ok("② 外殼送出的每一欄都在 api 的白名單裡(_SHARE_CREDS + view / id + agent_report_share.CONSENT_FIELDS + report / images)", allowed.size === 10 && /SH\.CONSENT_FIELDS \+ \("report", "images"\)/.test(apiSrc) && Object.keys(pb).every((k) => allowed.has(k)), [...allowed].join()); }
    const legal = path.join(MONO, "web", "app", "legal.py");
    if (!fs.existsSync(legal)) console.log("SKIP  ② 條款版本對照 web(需要 monorepo 版面)");
    else ok("② TOS_VERSION = web/app/legal.py 的 TOS_VERSION(兩邊送同一版)", new RegExp('^TOS_VERSION = "' + RS.TOS_VERSION.replace(/\./g, "\\.") + '"$', "m").test(read(legal)));
    const webSh = fs.existsSync(WEB_SH) ? read(WEB_SH) : "";
    if (webSh && webSh.indexOf('"' + RS.DISCLAIMER_VERSION + '"') < 0) console.log("NOTE  web report_share.js 的 DISCLAIMER_VERSION 還不是 " + RS.DISCLAIMER_VERSION + "(W1 那批 web 上了之後兩邊才一致)");

    // ── ③ main.js reportForShare ──
    const mainSrc = read(path.join(SHELL, "main.js"));
    const consts = ["RPT_ID_RE", "RPT_BYTES_MAX", "RPT_TS_MIN", "RPT_EXT_MIME"].map((k) => { const mm = new RegExp("const [^\\n]*\\b" + k + " = [^\\n]*").exec(mainSrc); return mm[0]; });
    const WS = fs.mkdtempSync(path.join(os.tmpdir(), "blave-shr-")), dir = path.join(WS, "reports"); fs.mkdirSync(path.join(dir, "r1.files"), { recursive: true });
    const doc = { id: "r1", title: "T", type: "research", blocks: [{ type: "meta" }, { type: "image", file: "a.png", alt: "x" }, { type: "image", file: "a.png", alt: "dup" }, { type: "image", file: "gone.png", alt: "y" }, { type: "image", file: "../evil.png", alt: "z" }] };
    fs.writeFileSync(path.join(dir, "r1.json"), JSON.stringify(doc)); fs.writeFileSync(path.join(dir, "r1.files", "a.png"), "PNGDATA");
    const M = { fs, path, WS };
    vm.runInNewContext(consts.join("\n") + "\nconst RPT_DIR = () => path.join(WS, 'reports');\nconst rptDirs = () => [RPT_DIR(), path.join(RPT_DIR(), 'sent')];\n"
      + ["rptEnvelope", "rptReadDoc", "rptImageB64", "reportForShare"].map((n) => cutFn(mainSrc, n)).join("\n") + "\nthis.f = reportForShare;", M);
    const got = M.f("r1");
    ok("③ reportForShare:本體原樣(未改 image block)、圖 = { 檔名: base64 }、同檔去重、缺檔與帶路徑的檔名跳過;壞 id / 沒這份 → null",
      got && JSON.stringify(got.report) === JSON.stringify(doc) && JSON.stringify(got.images) === JSON.stringify({ "a.png": Buffer.from("PNGDATA").toString("base64") }) && M.f("../r1") === null && M.f("nope") === null, JSON.stringify(got));
    ok("③ IPC 接線:三支 handle 只把 view / id / 掛名 / 勾 / 更新交給 reportshare;preload 同一組", /handle\("share-publish", \(_e, view, id, a\) => shareClient\(\)\.publish\(view, id, \{ byline: a && a\.byline, confirmed: !!a && a\.confirmed === true, update: !!a && a\.update === true \}\)/.test(mainSrc)
      && /handle\("share-state", \(_e, view, id\) => shareClient\(\)\.state\(view, id\)/.test(mainSrc) && /handle\("share-revoke", \(_e, view, id\) => shareClient\(\)\.revoke\(view, id\)/.test(mainSrc)
      && /sharePublish: \(view, id, a\) => ipcRenderer\.invoke\("share-publish", view, id, \{ byline: a && a\.byline, confirmed: !!a && a\.confirmed === true, update: !!a && a\.update === true \}\)/.test(read(path.join(SHELL, "preload.js"))));
    ok("③ 打包清單有 reportshare.js(main.js require 它,漏了打包版一按分享就炸)", /files:\s*\[[^\]]*"reportshare\.js"/.test(read(path.join(SHELL, "electron-builder.config.js"))));

    // ── 0.1.8 稽核修正(audit-share-cite P1-3 / P2-5 / P2-6 / P2-8;設計稽核 S1–S8;spec-share-list E 定稿一)──
    {
      const logged = [];
      const mk2 = (o) => { const calls = []; const c = RS.createShareClient({ apiBase: "https://api.x", getCreds: () => ({ token: "tok", appSecret: "sec" }), readLocal: (id) => ({ report: { id, blocks: [] }, images: {}, mtime: 5000 }),
        logError: (id, msg) => logged.push([id, msg]), store: o.store, post: async (u, b) => { calls.push({ u, b }); return o.res(u, b); } }); return { c, calls }; };
      let x = mk2({ res: () => ({ status: 400, body: { error: "blocks[3].source.url:\n must be an https URL" + "x".repeat(400) } }) });
      let q = await x.c.publish("local", "tw-9", { byline: "anonymous", confirmed: true });
      ok("P1-3 api 拒收(400):代號 NOT_SHAREABLE + detail = api 那一句(控制字元收掉、≤300 字);本機報告另寫一行 upload_errors.log", q.code === "NOT_SHAREABLE" && q.detail.startsWith("blocks[3].source.url: must be an https URL") && q.detail.length === 300 && !/[\n\r]/.test(q.detail)
        && logged.length === 1 && logged[0][0] === "tw-9" && logged[0][1].startsWith("share refused (400): blocks[3].source.url"), JSON.stringify([q, logged]));
      ok("P1-3 送給 api 的 body 沒有多帶 mtime / detail(api 對多的欄位回 400)", keys(x.calls[0].b) === "app_secret,byline,confirmed,disclaimer_version,id,images,report,token,tos_version,view");
      logged.length = 0; x = mk2({ res: () => ({ status: 422, body: { error: "performance reports cannot be shared" } }) });
      q = await x.c.publish("cloud", "tw-9", { byline: "anonymous", confirmed: true });
      ok("P1-3 雲端視角被拒:detail 照回,但不寫這台電腦的 upload_errors.log(那份報告不在這裡)", q.code === "NOT_SHAREABLE" && q.detail === "performance reports cannot be shared" && logged.length === 0, JSON.stringify([q, logged]));
      x = mk2({ res: () => ({ status: 401, body: { error: "unauthorized" } }) }); q = await x.c.publish("local", "tw-9", { byline: "anonymous", confirmed: true });
      ok("P1-3 不是內容問題的失敗(401)不帶 detail、不寫 log", q.code === "RELOGIN" && q.detail === undefined && logged.length === 0, JSON.stringify(q));
      const live = { code: "Abcd1234", published_at: 1790000000, byline: null, source_stored_at: null, report_stored_at: null };
      x = mk2({ res: (u) => { if (u.endsWith("/share/publish")) throw new Error("timeout"); return { status: 200, body: { share: live, display_name: null } }; } });
      q = await x.c.publish("local", "tw-9", { byline: "anonymous", confirmed: true });
      ok("P2-8 publish 等不到回應:先問一次狀態,已經公開 → 照成功回(不是「公開失敗」)", q.code === "OK" && q.share.code === "Abcd1234" && x.calls.map((k) => k.u.split("/").pop()).join() === "publish,state", JSON.stringify(q));
      x = mk2({ res: (u) => { if (u.endsWith("/share/publish")) throw new Error("timeout"); return { status: 200, body: { share: null, display_name: null } }; } });
      q = await x.c.publish("local", "tw-9", { byline: "anonymous", confirmed: true });
      ok("P2-8 …問了還是沒公開 → UNREACH", q.code === "UNREACH", JSON.stringify(q));
      const sf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "blave-shrstore-")), "state", "report-shares.json"), store = RS.createShareStore(sf);
      x = mk2({ store, res: () => ({ status: 200, body: { share: live, display_name: null } }) });
      q = await x.c.publish("local", "tw-9", { byline: "anonymous", confirmed: true });
      const st2 = await x.c.state("local", "tw-9"), st3 = await x.c.state("cloud", "tw-9");
      ok("P2-6 本機公開成功 → 記下那份檔的 mtime;之後 state 帶 local_mtime;代碼對不上 / 雲端視角不帶", q.share.local_mtime === 5000 && st2.share.local_mtime === 5000 && st3.share.local_mtime === undefined && store.get("tw-9", "Other999") === null && store.get("nope", "Abcd1234") === null, JSON.stringify([q, st2, st3]));
      fs.writeFileSync(sf, "{broken"); ok("P2-6 紀錄檔壞了 = 沒有紀錄(不丟錯)", store.get("tw-9", "Abcd1234") === null);
      const S2 = { published_at: pub, local_mtime: pub * 1000 - 3600e3 };
      ok("P2-6 shrStale(本機,有 local_mtime):只跟公開當下那份檔的 mtime 比——這台的鐘慢一小時也判得出改過;同一份不算", JSON.stringify(P.shrStale("local", S2, S2.local_mtime + 1)) === JSON.stringify({ time: Math.floor((S2.local_mtime + 1) / 1000), day: pub }) && P.shrStale("local", S2, S2.local_mtime) === null
        && P.shrStale("local", { published_at: pub, local_mtime: pub * 1000 + 90e3 }, pub * 1000 + 90e3) === null);
      // P2-5:symlink 不讀
      const out = path.join(WS, "outside.png"); fs.writeFileSync(out, "SECRET");
      fs.symlinkSync(out, path.join(dir, "r1.files", "link.png"));
      fs.mkdirSync(path.join(WS, "elsewhere")); fs.writeFileSync(path.join(WS, "elsewhere", "b.png"), "SECRET2"); fs.symlinkSync(path.join(WS, "elsewhere"), path.join(dir, "r2.files"));
      fs.writeFileSync(path.join(WS, "real.json"), JSON.stringify({ id: "r3", title: "T", blocks: [] })); fs.symlinkSync(path.join(WS, "real.json"), path.join(dir, "r3.json"));
      fs.writeFileSync(path.join(dir, "r1.json"), JSON.stringify({ id: "r1", title: "T", type: "research", blocks: [{ type: "meta" }, { type: "image", file: "a.png", alt: "x" }, { type: "image", file: "link.png", alt: "y" }] }));
      fs.writeFileSync(path.join(dir, "r2.json"), JSON.stringify({ id: "r2", title: "T", type: "research", blocks: [{ type: "meta" }, { type: "image", file: "b.png", alt: "x" }] }));
      const g1 = M.f("r1"), g2 = M.f("r2");
      ok("P2-5 圖檔是 symlink / <id>.files 是 symlink / 報告本體是 symlink → 都不讀(不會把 workspace 外的檔公開出去)", g1 && Object.keys(g1.images).join() === "a.png" && g2 && Object.keys(g2.images).length === 0 && M.f("r3") === null && typeof g1.mtime === "number", JSON.stringify([g1 && g1.images, g2 && g2.images]));
      // upload_errors.log 的格式 = lib/report.py _last_error 找的那一行(" <id>: ")
      const L = { fs, path, WS };
      vm.runInNewContext("const RPT_DIR = () => path.join(WS, 'reports');\n" + /const RPT_ERRLOG_MAX = [^\n]*/.exec(mainSrc)[0] + "\n" + cutFn(mainSrc, "rptLogError") + "\nthis.f = rptLogError;", L);
      L.f("tw-9", "share refused (400): blocks[3].source.url:\n bad"); for (let i = 0; i < 900; i++) L.f("big-" + i, "y".repeat(100));
      const lg = fs.readFileSync(path.join(dir, "upload_errors.log"), "utf8").split("\n").filter(Boolean);
      L.f("tw-9", "share refused (400): again");
      const lg2 = fs.readFileSync(path.join(dir, "upload_errors.log"), "utf8").split("\n").filter(Boolean);
      ok("P1-3 upload_errors.log:一行 = 「<UTC 時間>Z <id>: <訊息>」(同 report_uploader);超過 64KB 只留最後 200 行", lg.length <= 900 && lg.length >= 200 && lg2.every((l) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ [A-Za-z0-9_-]+: \S/.test(l)) && lg2[lg2.length - 1].endsWith(" tw-9: share refused (400): again") && fs.statSync(path.join(dir, "upload_errors.log")).size <= 64 * 1024 + 200, lg.length + " / " + lg2[lg2.length - 1]);
      ok("P2-8 分享的上傳用放長的逾時(postJSON 的 extra 蓋得過預設 20 秒)", /timeout: 20000,\s*\.\.\.\(extra \|\| \{\}\)/.test(mainSrc) && /\/share\\\/\(publish\|update\)\$\/\.test\(u\) \? \{ timeout: SHARE_UPLOAD_TIMEOUT_MS \}/.test(mainSrc) && /SHARE_UPLOAD_TIMEOUT_MS = 90 \* 1000/.test(mainSrc));
      // 設計稽核 S1–S8
      const css = read(path.join(R, "report-share.css")), html = read(path.join(R, "index.html")), js = read(path.join(R, "report-share.js"));
      ok("S1 作者 radio 選中是墨色(--control-fill),不是橘", /\.shr-rad input:checked \{ background: var\(--control-fill\); border-color: var\(--control-fill\); \}/.test(css) && /\.shr-rad input:checked::after \{[^}]*background: var\(--control-fill-text\)/.test(css) && !/shr-rad[^{]*\{[^}]*color-primary/.test(css));
      ok("S2 沒有名字:radio 組整組收起來、換純文字「匿名」;停用 radio 的兩條樣式拿掉", /<span class="shr-anon-only" id="shr-anon-only" data-i18n="shr\.anon" hidden><\/span>/.test(html) && /id="shr-radios"/.test(html) && /\$\("shr-radios"\)\.hidden = !on; \$\("shr-anon-only"\)\.hidden = on;/.test(js) && !/input:disabled/.test(css) && /\.shr-radios\[hidden\], \.shr-anon-only\[hidden\] \{ display: none; \}/.test(css));
      ok("S3 .shr-url min-width 120;S4 .shr-tlnk margin 0", /\.shr-url \{ flex: 1; min-width: 120px;/.test(css) && /\.shr-tlnk \{ padding: 0; margin: 0;/.test(css));
      const foot = html.slice(html.indexOf('<div class="modal-foot">', html.indexOf('id="shr-modal"')));
      ok("S5 腳的順序:條款句 → 訊息槽 → 鈕", foot.indexOf('class="shr-tos"') > 0 && foot.indexOf('class="shr-tos"') < foot.indexOf('id="shr-msg"') && foot.indexOf('id="shr-msg"') < foot.indexOf('id="shr-cancel"'));
      ok("S6 雲端視角:分享 / 更新框掛 envm + 灰標題列,取消分享與它的失敗框帶 env", /<span class="envm" id="shr-env" hidden><\/span>\s*<h6 id="shr-title">/.test(html) && /classList\.toggle\("cloud", cloud\);\s*\$\("shr-env"\)\.hidden = !cloud;/.test(js) && (js.match(/env: c\.env/g) || []).length === 2);
      ok("S7 / S8 shr.quota(zh / en)與 shr.rate(en)", STR.zh["shr.quota"] === "這個帳號的圖片空間已滿，這份報告沒有公開。" && STR.en["shr.quota"] === "Your account's image storage is full, so this report wasn't published." && STR.en["shr.rate"] === "Too many attempts. Try again in a while." && STR.zh["shr.rate"] === "按得太頻繁了，請過一陣子再試。");
      ok("本機揭露小字 = spec-share-list E 定稿一(含 Wei 拍板那句)", STR.zh["shr.noteLocal"] === "已轉貼或被預覽快取的內容收不回。公開的是上傳當下的快照，之後修改這份報告不會變更公開版本。刪掉這台電腦的檔案不會取消公開，要收回請按取消分享；刪除雲端主機或帳號會一併取消。"
        && STR.en["shr.noteLocal"] === "Reposted or preview-cached copies can't be recalled. What goes public is a snapshot taken at upload; later edits to this report won't change the public version. Deleting the file on this computer doesn't stop sharing — use Stop sharing to take it down; deleting your cloud machine or your account removes it too.");
      ok("P1-3 畫面:detail 接在訊息槽那一句後面(textContent 建的 span)", /fm\.appendChild\(libEl\("span", "shr-detail mono", r\.detail\)\)/.test(js) && /\.shr-detail \{/.test(css));
      // 稽核 T3:那一行是要被讀、被複製給 agent 的字 → ink-2;只在 api 指名欄位的代號才帶,上面那一句是對應的拒收句,不是「請檢查網路」
      const DC = /const DETAIL_CODES = (\[[^\]]*\]);/.exec(read(path.join(SHELL, "reportshare.js")));
      ok("T3 .shr-detail 墨色 ink-2;帶 detail 的代號(NOT_SHAREABLE / IMAGE_QUOTA)對到的都是拒收句,沒有一個是「請檢查網路」", /\.shr-detail \{[^}]*color: var\(--ink-2\);/.test(css)
        && !!DC && JSON.parse(DC[1]).length > 0 && JSON.parse(DC[1]).every((c) => P.shrErrKey(c) !== "shr.failed" && P.shrErrKey(c) !== "shr.failedCloud") && JSON.parse(DC[1]).join() === "NOT_SHAREABLE,IMAGE_QUOTA", DC && DC[1]);
      // 稽核 L5:取消失敗另開的單鈕框,標題寫結果(不再是問句)、內文講連結還在;RELOGIN 內文照舊。閱讀頁與清單兩處同一組 key
      const sl = read(path.join(R, "report-sharelist.js")), failBox = /confirmBox\(\{ title: t\("shr\.revokeFailTitle"\), lines: \[t\(code === "RELOGIN" \? "conn\.expired" : "shr\.revokeFailBody"\)\], ok: t\("cdel\.gotIt"\), single: true,/;
      ok("L5 取消失敗框:標題「沒有取消分享」、內文「連結仍然有效。請稍後再試一次。」(zh / en 定稿字面);閱讀頁與清單都換;舊 key 拿掉", failBox.test(js) && failBox.test(sl)
        && STR.zh["shr.revokeFailTitle"] === "沒有取消分享" && STR.en["shr.revokeFailTitle"] === "Couldn't stop sharing" && STR.zh["shr.revokeFailBody"] === "連結仍然有效。請稍後再試一次。" && STR.en["shr.revokeFailBody"] === "The link is still live. Try again in a while."
        && STR.zh["shr.revokeFailed"] === undefined && !/shr\.revokeFailed/.test(js + sl));
    }

    const bin = GATE.bin(SHELL, "④");
    if (!bin) { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
    const sub = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit" }).status;
    const n = red + (sub == null ? 1 : sub);
    console.log(n ? `\n${n} 紅` : "\nALL PASS"); process.exit(n ? 1 : 0);
  })();
  return;
}

// ── ④ Electron ──
const { app, BrowserWindow } = require("electron");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "blave-shr-e-")));
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const NOW = Math.floor(Date.now() / 1000);
const doc = (id, type, extra) => ({ report: { schema_version: "1.6", id, type, title: "T-" + id, created_at: NOW - 3600, blocks: [{ type: "meta", title: "標題 " + id, origin: "chat" }, { type: "text", variant: "lead", markdown: "第一句。第二句。" }].concat(extra || []) }, images: { "c.gif": GIF } });
const CITE = [{ type: "image", file: "c.gif", alt: "引用圖", caption: "作者的說明", source: { name: "Glassnode", url: "https://studio.glassnode.com/charts/x" } },
  { type: "image", file: "c.gif", alt: "壞連結", source: { name: "Evil", url: "javascript:alert(1)" } }, { type: "image", file: "nope.gif", alt: "缺的圖", source: { name: "Site", url: "https://www.example.com/p" } }, { type: "image", file: "c.gif", alt: "自產圖" }];
const LIST = [{ id: "res", title: "R", type: "research", created_at: NOW - 100, mtime: (NOW - 100) * 1000 }, { id: "perf", title: "P", type: "performance", created_at: NOW - 200, mtime: (NOW - 200) * 1000 },
  { id: "pub", title: "Pub", type: "morning", created_at: NOW - 300, mtime: (NOW - 10) * 1000 }];
const SHARE = { code: "Abcd1234", published_at: NOW - 3600, byline: null, source_stored_at: null, report_stored_at: null };
const STUB = `window.__s = { calls: [], tracked: [], copied: [], state: { res: { code: "OK", share: null, displayName: null }, pub: { code: "OK", share: ${JSON.stringify(SHARE)}, displayName: "Wei" } }, pub: { code: "OK", share: { code: "New98765", published_at: ${NOW}, byline: null, source_stored_at: null, report_stored_at: null } }, revoke: { code: "OK" } };
const __fixed = {
  getLocale: async () => "zh-TW", loadConnection: async () => ({ kind: "claude" }), detectAgents: async () => ({ claude: { installed: true, loggedIn: true }, codex: { installed: false } }),
  listStrategies: async () => [], listSessions: async () => [], loadSession: async () => [], loadSessionImages: async () => [], updateState: async () => ({ phase: "idle", current: "0.0.0" }),
  hasBlaveToken: async () => true, ensureEngine: async () => ({}), libraryList: async () => ({ strategies: [], signedIn: true, dataAccess: "included" }),
  reportsList: async () => ({ reports: ${JSON.stringify(LIST)} }), reportLoad: async (id) => (${JSON.stringify({ res: doc("res", "research", CITE), perf: doc("perf", "performance"), pub: doc("pub", "morning") })})[id] || null,
  shareState: async (view, id) => { window.__s.calls.push(["state", view, id]); return window.__s.state[id] || { code: "UNREACH" }; },
  sharePublish: async (view, id, a) => { window.__s.calls.push(["publish", view, id, a]); return window.__s.pub; },
  shareRevoke: async (view, id) => { window.__s.calls.push(["revoke", view, id]); return window.__s.revoke; },
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
  // 離屏視窗沒有焦點,真的剪貼簿會拒絕;換成記下寫了什麼(app 裡由主行程的權限 handler 放行 clipboard-sanitized-write)
  await js(`Object.defineProperty(navigator, "clipboard", { value: { writeText: async (x) => { window.__s.copied.push(x); } }, configurable: true })`);
  const T = (k, v) => js(`t(${JSON.stringify(k)}, ${JSON.stringify(v || {})})`);
  const openRead = async (id) => { await js(`(async () => { if (!rptBag().open) await rptOpen(); await new Promise((r) => setTimeout(r, 150)); rptShowRead(${JSON.stringify(id)}); })()`); await wait(500); };
  const st = () => js(`(() => { const g = (x) => document.getElementById(x), well = document.querySelector("#rpt-read > .shr-well");
    return { btn: !g("rpt-share").hidden, btnText: g("rpt-share").textContent, well: !!well, first: g("rpt-read").firstElementChild && g("rpt-read").firstElementChild.className, url: well && well.querySelector(".shr-url").textContent,
      stale: well ? well.querySelectorAll(".shr-stale").length : 0, staleBtn: well ? well.querySelectorAll(".shr-stale .btn-out").length : 0, dlg: !g("shr-scrim").hidden,
      edge: Math.round(g("rpt-share").parentElement.getBoundingClientRect().right - g("rpt-read").getBoundingClientRect().right), backEdge: Math.round(g("rpt-back").getBoundingClientRect().left - g("rpt-read").getBoundingClientRect().left) }; })()`);

  await openRead("perf"); let s = await st();
  ok("④ performance 報告:頁首沒有「分享」、沒有公開列", !s.btn && !s.well, JSON.stringify(s));
  await openRead("res"); s = await st();
  ok("④ research(未公開):頁首右側「分享」、動作群(分享 + 存成 PDF)右緣對齊內容欄右緣(返回鈕照舊外擠 4);問了一次 state(view=local)", s.btn && s.btnText === (await T("shr.btn")) && !s.well && Math.abs(s.edge) <= 1 && s.backEdge === -4 && (await js(`JSON.stringify(window.__s.calls.filter((c) => c[0] === "state"))`)).includes('["state","local","res"]'), JSON.stringify(s));
  // 引用圖(同一份報告)
  const im = await js(`(() => { const A = document.querySelector("#rpt-read article.rb-report"), W = [...A.querySelectorAll(".rb-image")];
    return W.map((x) => { const l = x.querySelector(".rb-image-src"), a = l && l.querySelector("a.rb-xlink"), img = x.querySelector("img"), cap = x.nextElementSibling;
      return { cited: x.classList.contains("is-cited"), line: l ? l.textContent : null, pre: l && l.firstElementChild.textContent, href: a && a.getAttribute("href"), rel: a && a.rel, dom: a && a.querySelector(".rb-xlink-dom") && a.querySelector(".rb-xlink-dom").textContent,
        nm: a && a.querySelector(".rb-xlink-nm") && a.querySelector(".rb-xlink-nm").textContent, plain: l && l.querySelector(".rb-image-src-nm") && l.querySelector(".rb-image-src-nm").textContent, fail: !!x.querySelector(".rb-image-fail"), lastIsSrc: x.lastElementChild === l,
        cap: cap && cap.classList.contains("rb-cap") ? cap.textContent : null, capGap: cap && cap.classList.contains("rb-cap") ? getComputedStyle(cap).marginTop : null, fs: l && getComputedStyle(l).fontSize, mh: img && getComputedStyle(img).maxHeight }; }); })()`);
  const pre = await T("rb.imageSource");
  ok("④ 引用圖:圖下一行「來源」+ 名稱連結(底線)+ mono 網域(去 www)、rel noopener noreferrer nofollow、12px;caption 在來源行之後、間距 4", im[0].cited && im[0].pre === pre && im[0].nm === "Glassnode" && im[0].dom === "studio.glassnode.com" && im[0].href === "https://studio.glassnode.com/charts/x" && im[0].rel === "noopener noreferrer nofollow" && im[0].fs === "12px" && im[0].cap === "作者的說明" && im[0].capGap === "4px", JSON.stringify(im[0]));
  ok("④ 連結 scheme 驗不過 → 名稱純文字、沒有 <a>、不顯示網域", im[1].cited && im[1].href === null && im[1].plain === "Evil" && im[1].line === pre + "Evil", JSON.stringify(im[1]));
  ok("④ 圖載入失敗:換成失敗框,來源行照留在框外(那時連結是唯一出口)", im[2].fail && im[2].lastIsSrc && im[2].dom === "example.com", JSON.stringify(im[2]));
  ok("④ 沒有 source 的圖不畫來源行;全部 image max-height 480", !im[3].cited && im[3].line === null && im.filter((x) => x.mh).every((x) => x.mh === "480px"), JSON.stringify(im[3]));
  await js(`document.querySelector("#rpt-read .rb-image-src a.rb-xlink").click()`); await wait(80);
  ok("④ 點來源連結 → 交給 openExternal(系統瀏覽器),不在 app 裡導覽", (await js(`JSON.stringify(window.__s.calls.filter((c) => c[0] === "ext"))`)).includes("studio.glassnode.com"));

  // 確認框
  await js(`document.getElementById("rpt-share").click()`); await wait(300);
  let d = await js(`(() => { const g = (x) => document.getElementById(x); return { open: !g("shr-scrim").hidden, title: g("shr-title").textContent, send: g("shr-send").disabled, sendText: g("shr-send").textContent, named: g("shr-named").disabled, anon: g("shr-anon").checked, radios: g("shr-radios").hidden, plain: g("shr-anon-only").hidden ? null : g("shr-anon-only").textContent,
    hint: g("shr-hint").textContent, must: g("shr-must").textContent, tt: g("shr-tt").textContent, ds: g("shr-ds").textContent, tag: g("shr-og-tag").textContent, same: g("shr-same").hidden, three: [...document.querySelectorAll(".shr-three li")].map((x) => x.textContent), focus: document.activeElement && document.activeElement.id,
    order: [...g("shr-modal").querySelectorAll(".shr-three, #shr-ack")].map((x) => x.id || x.className).join() }; })()`);
  ok("④ 確認框:標題「公開這份報告」、主鈕未勾前 disabled、預設匿名、名字讀不到 → radio 組收起來、純文字「匿名」+ 去改名那句;揭露小字 = 本機版;預覽 = 研究報告前綴 + meta 標題 + lead 首句;三行在勾選之前;焦點在勾選框",
    d.open && d.title === (await T("shr.dlgTitle")) && d.send && d.sendText === (await T("shr.send")) && d.named && d.anon && d.hint === (await T("shr.noName")) && d.must === (await T("shr.noteLocal")) && d.tt === (await T("shr.ogPrefix.research")) + "標題 res"
      && d.ds === "第一句。" && d.tag === (await T("shr.ogTag.research")) && d.same && d.three.length === 3 && d.three[1] === (await T("shr.ack2")) && d.order === "shr-three,shr-ack" && d.focus === "shr-ack" && d.radios && d.plain === (await T("shr.anon")), JSON.stringify(d));
  await js(`document.getElementById("shr-tos").click()`); await wait(50);
  ok("④ 條款連結 → openExternal 到 blave.org/zh/…terms_of_service#ugc", (await js(`JSON.stringify(window.__s.calls.filter((c) => c[0] === "ext").pop())`)).includes("https://blave.org/disclaimer/zh/terms_of_service#ugc"));
  await js(`document.getElementById("shr-ack").click()`);
  ok("④ 勾了才能送", !(await js(`document.getElementById("shr-send").disabled`)));
  await js(`document.getElementById("shr-send").click()`); await wait(300);
  s = await st();
  const pubCall = await js(`JSON.stringify(window.__s.calls.filter((c) => c[0] === "publish"))`);
  ok("④ 送出:只給 view / id / 掛名 / 勾 / 更新(沒有憑證、沒有報告本體)→ 關框、頁首鈕收起、公開列在內容最上方(新代碼)、share_publish", pubCall === '[["publish","local","res",{"byline":"anonymous","confirmed":true,"update":false}]]' && !s.dlg && !s.btn && s.well && s.first === "shr-well" && s.url === "blave.org/zh/r/New98765?src=research_link"
    && (await js(`window.__s.tracked.includes("share_publish") && window.__s.copied[0] === "https://blave.org/zh/r/New98765?src=research_link"`)) && (await js(`document.activeElement && document.activeElement.classList.contains("shr-copy")`)), JSON.stringify([pubCall, s]));
  // 失敗:框留著、欄位不動、一句
  await openRead("res"); await js(`window.__s.pub = { code: "UNREACH" }; document.getElementById("rpt-share").click();`); await wait(200);
  await js(`document.getElementById("shr-ack").click(); document.getElementById("shr-send").click();`); await wait(250);
  d = await js(`({ open: !$("shr-scrim").hidden, msg: $("shr-msg").textContent, ack: $("shr-ack").checked, send: $("shr-send").disabled, cancel: $("shr-cancel").disabled })`);
  ok("④ 送出失敗:框留著、勾選保留、主鈕可再按、腳一句「公開失敗，請檢查網路後再試。」", d.open && d.msg === (await T("shr.failed")) && d.ack && !d.send && !d.cancel, JSON.stringify(d));
  await js(`window.__s.pub = { code: "NO_DISPLAY_NAME" }; __s.state.res.displayName = "Wei"; shrClose();`); await wait(100);
  await openRead("res"); await js(`document.getElementById("rpt-share").click()`); await wait(250);
  d = await js(`({ named: $("shr-named").disabled, nm: $("shr-nm").textContent, hint: $("shr-hint").textContent, radios: $("shr-radios").hidden, plain: $("shr-anon-only").hidden })`);
  ok("④ 名字讀得到:兩顆 radio 都在、顯示名稱可選、帶名字、hint 是只能用顯示名稱那句", !d.named && !d.radios && d.plain && d.nm === "Wei" && d.hint === (await T("shr.nameHint")), JSON.stringify(d));
  await js(`$("shr-named").click(); $("shr-ack").click(); $("shr-send").click();`); await wait(250);
  d = await js(`({ open: !$("shr-scrim").hidden, named: $("shr-named").disabled, anon: $("shr-anon").checked, radios: $("shr-radios").hidden, hint: $("shr-hint").textContent, ack: $("shr-ack").checked, msg: $("shr-msg").textContent, last: JSON.stringify(__s.calls.filter((c) => c[0] === "publish").pop()) })`);
  ok("④ api 回 NO_DISPLAY_NAME:退回匿名、radio 組收起來、hint 換去改名那句、勾選保留;送出的那一次是 byline=name", d.open && d.named && d.radios && d.anon && d.hint === (await T("shr.noName")) && d.ack && d.msg === "" && d.last.includes('"byline":"name"'), JSON.stringify(d));
  await js(`shrClose()`); await wait(100);

  // 公開中 + stale + 取消分享
  await openRead("pub"); s = await st();
  ok("④ 已公開的晨報:頁首沒有「分享」、公開列(舊代碼)、本機檔比公開版本新 → stale 行 + 「檢查後更新公開版本」", !s.btn && s.well && s.url === "blave.org/zh/r/Abcd1234?src=research_link" && s.stale === 1 && s.staleBtn === 1, JSON.stringify(s));
  await js(`document.querySelector("#rpt-read .shr-stale .btn-out").click()`); await wait(250);
  d = await js(`({ title: $("shr-title").textContent, same: $("shr-same").hidden, send: $("shr-send").textContent, tt: $("shr-tt").textContent })`);
  ok("④ 更新模式:標題與主鈕「更新公開版本」、「連結不變。」、預覽前綴 = 市場報告", d.title === (await T("shr.dlgTitleUpdate")) && !d.same && d.send === (await T("shr.sendUpdate")) && d.tt.startsWith(await T("shr.ogPrefix.morning")), JSON.stringify(d));
  await js(`shrClose()`); await wait(100);
  await js(`document.querySelector("#rpt-read .shr-copy").click()`); await wait(100);
  ok("④ 複製連結 → 寫進剪貼簿的是完整網址、鈕字暫換「已複製」、share_copy", await js(`window.__s.tracked.includes("share_copy") && __s.copied.pop() === "https://blave.org/zh/r/Abcd1234?src=research_link" && document.querySelector("#rpt-read .shr-copy").textContent === t("shr.copied")`));
  await js(`document.querySelector("#rpt-read .shr-well .btn-quiet").click()`); await wait(200);
  d = await js(`({ open: !$("del-scrim").hidden, title: $("del-title").textContent, cancel: $("del-cancel").textContent, ok: $("del-ok").textContent })`);
  ok("④ 取消分享 → 確認框:標題「取消分享這份報告？」、鈕「繼續分享」/「取消分享」", d.open && d.title === (await T("shr.revokeTitle")) && d.cancel === (await T("shr.keep")) && d.ok === (await T("shr.revokeOk")), JSON.stringify(d));
  await js(`$("del-ok").click()`); await wait(250); s = await st();
  ok("④ 確認 → shareRevoke(local, pub)、share_revoke、公開列拿掉、「分享」回來;確認框的取消鈕字回到「取消」", !s.well && s.btn && (await js(`JSON.stringify(__s.calls.filter((c) => c[0] === "revoke"))`)) === '[["revoke","local","pub"]]' && (await js(`__s.tracked.includes("share_revoke")`)) && (await js(`$("del-cancel").textContent`)) === (await T("del.cancel")), JSON.stringify(s));
  // 未登入:按分享 → 守門框
  await js(`hasToken = false; shrClear();`); await openRead("res"); await js(`document.getElementById("rpt-share").click()`); await wait(200);
  d = await js(`({ shr: !$("shr-scrim").hidden, del: !$("del-scrim").hidden, body: $("del-body").textContent, ok: $("del-ok").textContent })`);
  ok("④ 未登入(本機):鈕照出,按下開守門框「先登入才能公開」+「去登入」,不開確認框", !d.shr && d.del && d.body === (await T("shr.gate")) && d.ok === (await T("shr.gateGo")), JSON.stringify(d));
  await js(`delClose(false)`);
  console.log(red ? `\n④ ${red} 紅` : "\n④ ALL PASS");
  app.exit(red ? 1 : 0);
});
