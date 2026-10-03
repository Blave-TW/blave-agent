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
// web 的 zh / en 譯文(分享框的字兩邊逐字相同):找得到帶這個 msgid 的 web 樹才比,找不到 → null(呼叫端 SKIP)
// 有設 BLAVE_WEB_DIR 就只看那一棵(不默默退回別棵舊樹);沒設才看 monorepo 的 ../web
const WEB_DIRS = [process.env.BLAVE_WEB_DIR || path.join(MONO, "web")];
const webPo = (msgid) => { for (const d of WEB_DIRS) { const out = {}; for (const lang of ["zh", "en"]) { const f = path.join(d, "app", "translations", lang, "LC_MESSAGES", "messages.po"); if (!fs.existsSync(f)) break;
  const m = new RegExp('^msgid "' + msgid + '"\\nmsgstr ((?:"(?:[^"\\\\]|\\\\.)*"\\n)+)', "m").exec(read(f)); if (!m) break;
  out[lang] = m[1].trim().split("\n").map((x) => JSON.parse(x)).join(""); } if (out.zh !== undefined && out.en !== undefined) return out; } return null; };
const sameAsWeb = (label, STR, key, msgid) => { const w = webPo(msgid); if (!w) { console.log("SKIP  " + label + "(找不到帶 " + msgid + " 的 web 譯文;可設 BLAVE_WEB_DIR)"); return; }
  ok(label, STR.zh[key] === w.zh && STR.en[key] === w.en, JSON.stringify([STR.zh[key], w.zh, STR.en[key], w.en])); };
const cutFn = (s, name) => { const i = s.indexOf("function " + name + "("); if (i < 0) throw new Error("no " + name); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("unbalanced " + name); };

if (!process.versions.electron) {
  (async () => {
    // ── ① 純邏輯 ──
    const src = read(path.join(R, "report-share.js")), A = "/* ── 純邏輯", B = "/* ── 純邏輯到此 ── */";
    const P = {}; vm.runInNewContext(src.slice(src.indexOf(A), src.indexOf(B)) + "\nObject.assign(this, { shrGate, shrUrl, shrStale, shrLead, shrKind, shrErrKey, SHR_CLOCK_SLACK_MS, SHR_TYPES, SHR_OG_PREFIX, SHR_OG_TAG, SHR_OG_LABELLED, SHR_IMG_MAX_COUNT, SHR_IMG_MAX_MB });", P);
    const STR0 = (() => { const sb = {}; vm.runInNewContext(read(path.join(R, "strings.js")) + "\nthis.S = STRINGS;", sb); return sb.S; })();
    ok("① 閘門 = 類型白名單:research / morning / performance 出入口;缺 type、不認得的類型、沒有 blocks 的不出", ["research", "morning", "performance"].every((k) => P.shrGate({ type: k, blocks: [] }) && P.shrKind(k) === k)
      && !P.shrGate({ blocks: [] }) && !P.shrGate({ type: "journal", blocks: [] }) && !P.shrGate({ type: "constructor", blocks: [] }) && !P.shrGate({ type: "research" }) && !P.shrGate(null) && P.shrKind("journal") === null && P.shrKind(undefined) === null);
    { const WEB_SH2 = WEB_DIRS.map((d) => path.join(d, "app", "static", "js", "agent", "report_share.js")).find((f) => fs.existsSync(f) && /var SHAREABLE = /.test(read(f)));
      if (!WEB_SH2) console.log("SKIP  ① 類型白名單與 web 比對(需要含 SHAREABLE 的 web 原始碼;可設 BLAVE_WEB_DIR)");
      else ok("① 類型白名單 = web report_share.js 的 SHAREABLE", JSON.stringify(JSON.parse(/var SHAREABLE = (\[[^\]]*\]);/.exec(read(WEB_SH2))[1])) === JSON.stringify(Array.from(P.SHR_TYPES)), JSON.stringify(P.SHR_TYPES)); }
    ok("① 預覽卡的類型詞:三類各一組 key、兩語都在;performance 的固定圖不帶標籤行", Array.from(P.SHR_TYPES).every((k) => STR0.zh[P.SHR_OG_PREFIX[k]] && STR0.en[P.SHR_OG_PREFIX[k]] && STR0.zh[P.SHR_OG_TAG[k]] && STR0.en[P.SHR_OG_TAG[k]])
      && Array.from(P.SHR_OG_LABELLED).join() === "research,morning" && STR0.zh["shr.ogPrefix.performance"] === "績效報告｜" && STR0.en["shr.ogPrefix.performance"] === "Performance report | "
      && STR0.zh["shr.ogTag.performance"] === "績效報告 · 由用戶的 Blave Agent 產出" && STR0.en["shr.ogTag.performance"] === "Performance report · Produced by a user's Blave Agent");
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
    const codes = ["UNREACH", "RELOGIN", "RATE_LIMITED", "IMAGE_QUOTA", "NO_MACHINE", "NOT_SHAREABLE", "BAD_CONTENT", "TOO_LARGE", "BAD_REQUEST", "NO_REPORT", "BAD_ARGS", "WHATEVER"];
    ok("① 錯誤代號 → 字:連不上 = 檢查網路那句、雲端沒在跑 = web 那句、配額 / 速率 / 重新登入各自一句、驗不過 = 不能公開;每個 key 兩語都在", P.shrErrKey("UNREACH") === "shr.failed" && P.shrErrKey("WHATEVER") === "shr.failed" && P.shrErrKey("NO_MACHINE") === "shr.failedCloud" && P.shrErrKey("IMAGE_QUOTA") === "shr.quota" && P.shrErrKey("RELOGIN") === "conn.expired" && P.shrErrKey("NOT_SHAREABLE") === "shr.notShareable" && P.shrErrKey("BAD_CONTENT") === "shr.badContent" && P.shrErrKey("TOO_LARGE") === "shr.tooLarge" && P.shrErrKey("BAD_REQUEST") === "shr.failed"
      && codes.every((c) => STR.zh[P.shrErrKey(c)] && STR.en[P.shrErrKey(c)]));
    ok("① 第三行不提推薦碼(zh / en 定稿)", STR.zh["shr.ack3"] === "我不是投顧／期顧從業人員，沒有因此收取報酬，也不用它招攬付費策略或收費服務"
      && STR.en["shr.ack3"] === "I am not affiliated with a securities or futures advisory enterprise; I received no compensation for publishing this and won't use it to solicit anyone to paid strategies, paid groups, or other paid services.");
    for (const n of [1, 2, 3]) sameAsWeb("① shr.ack" + n + " 逐字同 web workspace_share_ack_" + n, STR, "shr.ack" + n, "workspace_share_ack_" + n);
    ok("① 確認框三行 + 標題照 W1 定稿(zh / en)", STR.zh["shr.ack2"] === "內容由我的 Blave Agent 產出，公開是我的決定，後果由我負責；Blave 未審核" && STR.en["shr.ack2"] === "This content was produced by my Blave Agent; publishing it is my decision and my responsibility, and Blave has not reviewed it."
      && STR.zh["shr.dlgTitle"] === "公開這份報告" && STR.en["shr.dlgTitle"] === "Publish this report" && STR.zh["shr.revokeTitle"] === "取消分享這份報告？" && STR.en["shr.revokeTitle"] === "Stop sharing this report?");

    ok("① 績效報告提醒句照定稿(zh / en)", STR.zh["shr.perfNote"] === "這份報告含你的帳戶資產與部位，公開後拿到連結的人都看得到。" && STR.en["shr.perfNote"] === "This report shows your account balance and positions. Once it's public, anyone with the link can see them.");
    sameAsWeb("① shr.perfNote 逐字同 web workspace_share_perf_note", STR, "shr.perfNote", "workspace_share_perf_note");

    ok("① 掛名說明:名稱會原樣公開;帳號沒有名稱那句(zh / en 定稿)", STR.zh["shr.nameHint"] === "名稱會原樣公開" && STR.en["shr.nameHint"] === "Your name is shown exactly as it is."
      && STR.zh["shr.noName"] === "這個帳號還沒有名稱。要掛名，先到 blave.org 的帳號設定填上名稱。" && STR.en["shr.noName"] === "This account has no name yet. To be credited, add one in your account settings on blave.org.");
    sameAsWeb("① shr.nameHint 逐字同 web workspace_share_name_hint", STR, "shr.nameHint", "workspace_share_name_hint");

    ok("① 拒絕訊息照 A4 定稿(zh / en):先講「沒有公開」、再講怎麼辦;太大那句的數字是佔位,不寫死", STR.zh["shr.badContent"] === "這份報告有一處格式自動修不好，沒有公開。請在聊天裡請 agent「重新整理這份報告」，整理好再公開。"
      && STR.en["shr.badContent"] === "One part of this report couldn't be fixed automatically, so it wasn't published. In chat, ask the agent to \"tidy up this report\", then publish again."
      && STR.zh["shr.tooLarge"] === "這份報告太大，沒有公開。圖片最多 {n} 張、合計 {mb} MB 以內；請 agent 減少圖片或縮短內容，再公開。"
      && STR.en["shr.tooLarge"] === "This report is too large, so it wasn't published. It can hold up to {n} images, {mb} MB in total. Ask the agent to use fewer images or shorten it, then publish again.");
    sameAsWeb("① shr.badContent 逐字同 web workspace_share_bad_content", STR, "shr.badContent", "workspace_share_bad_content");
    sameAsWeb("① shr.tooLarge 逐字同 web workspace_share_too_large", STR, "shr.tooLarge", "workspace_share_too_large");
    { const shPy = [process.env.BLAVE_API_DIR, path.join(MONO, "api")].filter(Boolean).map((d) => path.join(d, "openclaw", "agent_report_share.py")).find((f) => fs.existsSync(f) && /^LOCAL_IMG_MAX_COUNT = /m.test(read(f)));
      if (!shPy) console.log("SKIP  ① 太大那句的兩個數對照 api(找不到帶 LOCAL_IMG_MAX_COUNT 的 agent_report_share.py;可設 BLAVE_API_DIR)");
      else { const a = read(shPy), n = /^LOCAL_IMG_MAX_COUNT = (\d+)$/m.exec(a), mb = /^LOCAL_IMG_TOTAL_MAX_BYTES = (\d+) \* 1024 \* 1024$/m.exec(a);
        ok("① {n} / {mb} = api 的 LOCAL_IMG_MAX_COUNT / LOCAL_IMG_TOTAL_MAX_BYTES", !!n && !!mb && Number(n[1]) === P.SHR_IMG_MAX_COUNT && Number(mb[1]) === P.SHR_IMG_MAX_MB, JSON.stringify([n && n[1], mb && mb[1]])); } }

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
    { const names = ["User_AB12CD34", "Wei AB12CD34", "分析師 Wei"], got = [];
      for (const n of names) got.push((await mk({ res: { status: 200, body: { share: null, display_name: n } } }).c.state("local", "x")).displayName);
      ok("② state:名稱原樣轉交——系統預設名、含推薦碼的名稱都不排除(只有空的才是沒有名稱);外殼裡沒有挑名字的規則", got.join("|") === names.join("|") && !/User_|referral/i.test(read(path.join(SHELL, "reportshare.js")) + read(path.join(R, "report-share.js"))), got.join("|")); }
    m = mk(); r = await m.c.publish("local", "tw-1", { byline: "name", confirmed: true });
    const pb = m.calls[0] && m.calls[0].b;
    ok("② publish(本機):/share/publish;body = 憑證兩欄 + view / id + 勾選紀錄四欄 + report / images(本機檔原樣),聲明版本 rs-ack-2026.09.28", m.calls[0].u.endsWith("/oauth/desktop/share/publish") && keys(pb) === "app_secret,byline,confirmed,disclaimer_version,id,images,report,token,tos_version,view"
      && pb.confirmed === true && pb.byline === "name" && pb.disclaimer_version === "rs-ack-2026.09.28" && RS.DISCLAIMER_VERSION === "rs-ack-2026.09.28" && pb.tos_version === RS.TOS_VERSION && pb.report.id === "tw-1" && pb.images["a.png"] === "QUJD" && r.code === "OK" && r.share.code === "Abcd1234", JSON.stringify(pb));
    { const onDisk = { id: "tw-2", blocks: [{ type: "meta" }, { type: "footnote", items: [{ id: "src", text: "日 K 為 TWSE 未還原價" }, { id: "src", text: "指數:TWSE 日資料。" }] }] };
      const was = JSON.stringify(onDisk);
      m = mk({ readLocal: () => ({ report: onDisk, images: {} }) }); await m.c.publish("local", "tw-2", { byline: "anonymous", confirmed: true });
      const sent = m.calls[0].b.report.blocks[1].items;
      ok("② publish(本機):尾註 id 重複的舊報告,送出的那份併成一列;讀進來的那份不動(規則見 tests/check_report_footnotes.py)",
        sent.length === 1 && sent[0].id === "src" && sent[0].text === "日 K 為 TWSE 未還原價。指數:TWSE 日資料。" && JSON.stringify(onDisk) === was, JSON.stringify(sent)); }
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
    ok("② 讀不到 error_code(舊 api)照狀態碼:409 已公開 / 422 不能公開 / 507 配額 / 401 重新登入 / 429 / 403 雲端沒在跑 / 5xx 與連不上 = UNREACH / 沒有代號的 400 = 內容被拒 / 413 = 太大 / 404 分 publish 與 update·revoke",
      fc(409) === "ALREADY" && fc(422) === "NOT_SHAREABLE" && fc(507) === "IMAGE_QUOTA" && fc(401) === "RELOGIN" && fc(429) === "RATE_LIMITED" && fc(429, { error_code: "ERR429" }) === "RATE_LIMITED" && fc(403) === "NO_MACHINE" && fc(502) === "UNREACH" && RS.failCode(null) === "UNREACH" && RS.failCode({}) === "UNREACH"
      && fc(400, { error: "blocks[3]: bad" }) === "BAD_CONTENT" && fc(400, "<html>") === "BAD_CONTENT" && fc(413) === "TOO_LARGE" && fc(413, { error_code: "BODY_TOO_LARGE" }) === "TOO_LARGE" && fc(401, { error_code: "INVALID_CREDENTIALS" }) === "RELOGIN"
      && fc(404, {}, "publish") === "NOT_SHAREABLE" && fc(404, {}, "update") === "NOT_PUBLIC" && fc(404, {}, "revoke") === "NOT_PUBLIC");
    const API_CODES = { BAD_CONTENT: [400, "BAD_CONTENT"], BAD_IMAGE: [400, "BAD_CONTENT"], BAD_REQUEST: [400, "BAD_REQUEST"], NO_DISPLAY_NAME: [400, "NO_DISPLAY_NAME"], TOO_LARGE: [413, "TOO_LARGE"], NOT_SHAREABLE: [422, "NOT_SHAREABLE"],
      LIVE_LIMIT: [429, "LIVE_LIMIT"], DAILY_LIMIT: [429, "DAILY_LIMIT"], IMAGE_QUOTA: [507, "IMAGE_QUOTA"] };
    const offc = Object.keys(API_CODES).filter((k) => fc(API_CODES[k][0], { error: "x", error_code: k }) !== API_CODES[k][1]);
    ok("② api 的 error_code 優先於狀態碼:九個代號各對到自己的那一句(BAD_IMAGE 講 BAD_CONTENT 那句);狀態碼跟代號對不上時聽代號", offc.length === 0 && fc(400, { error_code: "TOO_LARGE" }) === "TOO_LARGE" && fc(413, { error_code: "BAD_CONTENT" }) === "BAD_CONTENT" && fc(422, { error_code: "BAD_CONTENT" }) === "BAD_CONTENT", offc.join());
    ok("② 不認得的代號不上畫面:400 帶別的代號(UNKNOWN_FIELD…)= 外殼送錯 BAD_REQUEST;5xx 帶什麼代號都是連不上;代號不是字串 / 是物件原型上的名字當沒給",
      fc(400, { error_code: "UNKNOWN_FIELD" }) === "BAD_REQUEST" && fc(400, { error_code: "ID_REQUIRED" }) === "BAD_REQUEST" && fc(503, { error_code: "BAD_CONTENT" }) === "UNREACH" && fc(500, { error_code: "TOO_LARGE" }) === "UNREACH"
      && fc(400, { error_code: 5 }) === "BAD_CONTENT" && fc(422, { error_code: "constructor" }) === "NOT_SHAREABLE" && fc(409, { error_code: "toString" }) === "ALREADY");
    { const shPy = [process.env.BLAVE_API_DIR, path.join(MONO, "api")].filter(Boolean).map((d) => path.join(d, "openclaw", "agent_report_share.py")).find((f) => fs.existsSync(f) && /"TOO_LARGE"/.test(read(f)));
      if (!shPy) console.log("SKIP  ② api 的代號逐一對照(需要會回 TOO_LARGE 的 api 原始碼;可設 BLAVE_API_DIR)");
      else { const a = read(shPy), seen = [...new Set([...a.matchAll(/"([A-Z][A-Z_]{3,})"\)?(?:, \d+)?\)?$|"error_code": "([A-Z_]+)"|, (?:\d+, )?(?:code=)?"([A-Z][A-Z_]+)"\)/gm)].map((x) => x[1] || x[2] || x[3]))].filter((k) => k !== "CODE_REQUIRED");
        const known = Object.keys(API_CODES), miss = seen.filter((k) => known.indexOf(k) < 0);
        ok("② api 公開 / 更新會回的代號外殼都認得", seen.length >= 8 && miss.length === 0, JSON.stringify([seen, miss])); } }
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
    const legal = WEB_DIRS.map((d) => path.join(d, "app", "legal.py")).find((f) => fs.existsSync(f));
    if (!legal) console.log("SKIP  ② 條款版本對照 web(找不到 web 的 app/legal.py;可設 BLAVE_WEB_DIR)");
    else ok("② TOS_VERSION = web/app/legal.py 的 TOS_VERSION(兩邊送同一版)", new RegExp('^TOS_VERSION = "' + RS.TOS_VERSION.replace(/\./g, "\\.") + '"$', "m").test(read(legal)));
    { const dv = WEB_DIRS.map((d) => path.join(d, "app", "static", "js", "agent", "report_share.js")).filter((f) => fs.existsSync(f)).map((f) => /var DISCLAIMER_VERSION = "([^"]*)";/.exec(read(f))).find(Boolean);
      if (!dv) console.log("SKIP  ② 聲明版本對照 web(找不到 web 的 report_share.js;可設 BLAVE_WEB_DIR)");
      else ok("② DISCLAIMER_VERSION = web report_share.js 的 DISCLAIMER_VERSION(三行字面同、版本同值同批)", dv[1] === RS.DISCLAIMER_VERSION, dv[1] + " / " + RS.DISCLAIMER_VERSION); }

    // ── ③ main.js reportForShare ──
    const mainSrc = read(path.join(SHELL, "main.js"));
    const consts = ["RPT_ID_RE", "RPT_BYTES_MAX", "RPT_TS_MIN", "RPT_EXT_MIME"].map((k) => { const mm = new RegExp("const [^\\n]*\\b" + k + " = [^\\n]*").exec(mainSrc); return mm[0]; });
    const WS = fs.mkdtempSync(path.join(os.tmpdir(), "blave-shr-")), dir = path.join(WS, "reports");
    process.on("exit", () => fs.rmSync(WS, { recursive: true, force: true }));   // 稽核 P2-12:跑完不留暫存目錄
    fs.mkdirSync(path.join(dir, "r1.files"), { recursive: true });
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
      const logged = [], applog = [];
      const mk2 = (o) => { const calls = []; const c = RS.createShareClient({ apiBase: "https://api.x", getCreds: () => ({ token: "tok", appSecret: "sec" }), readLocal: (id) => ({ report: { id, blocks: [] }, images: {}, mtime: 5000 }),
        logError: (id, msg) => logged.push([id, msg]), log: (msg) => applog.push(msg), store: o.store, post: async (u, b) => { calls.push({ u, b }); return o.res(u, b); } }); return { c, calls }; };
      let x = mk2({ res: () => ({ status: 400, body: { error: "blocks[3].source.url:\n must be an https URL" + "x".repeat(400) } }) });
      let q = await x.c.publish("local", "tw-9", { byline: "anonymous", confirmed: true });
      ok("#2 api 拒收(400):回給畫面的只有代號 BAD_CONTENT,api 的原文不出主行程;原文(控制字元收掉、≤300 字)寫 upload_errors.log 與主行程 log", q.code === "BAD_CONTENT" && Object.keys(q).join() === "code"
        && logged.length === 1 && logged[0][0] === "tw-9" && logged[0][1].startsWith("share refused (400): blocks[3].source.url: must be an https URL") && !/[\n\r]/.test(logged[0][1]) && logged[0][1].length === "share refused (400): ".length + 300
        && applog.length === 1 && applog[0].startsWith("local tw-9: share refused (400): blocks[3].source.url"), JSON.stringify([q, logged, applog]));
      ok("P1-3 送給 api 的 body 沒有多帶 mtime / detail(api 對多的欄位回 400)", keys(x.calls[0].b) === "app_secret,byline,confirmed,disclaimer_version,id,images,report,token,tos_version,view");
      logged.length = 0; applog.length = 0; x = mk2({ res: () => ({ status: 422, body: { error: "performance reports cannot be shared" } }) });
      q = await x.c.publish("cloud", "tw-9", { byline: "anonymous", confirmed: true });
      ok("#2 雲端視角被拒(422):只回代號;原文進主行程 log,不寫這台電腦的 upload_errors.log(那份報告不在這裡)", q.code === "NOT_SHAREABLE" && Object.keys(q).join() === "code" && logged.length === 0
        && applog.length === 1 && applog[0] === "cloud tw-9: share refused (422): performance reports cannot be shared", JSON.stringify([q, logged, applog]));
      applog.length = 0;
      x = mk2({ res: () => ({ status: 401, body: { error: "unauthorized" } }) }); q = await x.c.publish("local", "tw-9", { byline: "anonymous", confirmed: true });
      ok("P1-3 不是內容問題的失敗(401)不帶 detail、不寫 log", q.code === "RELOGIN" && q.detail === undefined && logged.length === 0 && applog.length === 0, JSON.stringify(q));
      const live = { code: "Abcd1234", published_at: 1790000000, byline: null, source_stored_at: null, report_stored_at: null };
      x = mk2({ res: (u) => { if (u.endsWith("/share/publish")) throw new Error("timeout"); return { status: 200, body: { share: live, display_name: null } }; } });
      q = await x.c.publish("local", "tw-9", { byline: "anonymous", confirmed: true });
      ok("P2-8 publish 等不到回應:先問一次狀態,已經公開 → 照成功回(不是「公開失敗」)", q.code === "OK" && q.share.code === "Abcd1234" && x.calls.map((k) => k.u.split("/").pop()).join() === "publish,state", JSON.stringify(q));
      x = mk2({ res: (u) => { if (u.endsWith("/share/publish")) throw new Error("timeout"); return { status: 200, body: { share: null, display_name: null } }; } });
      q = await x.c.publish("local", "tw-9", { byline: "anonymous", confirmed: true });
      ok("P2-8 …問了還是沒公開 → UNREACH", q.code === "UNREACH", JSON.stringify(q));
      const sfDir = fs.mkdtempSync(path.join(os.tmpdir(), "blave-shrstore-")); process.on("exit", () => fs.rmSync(sfDir, { recursive: true, force: true }));
      const sf = path.join(sfDir, "state", "report-shares.json"), store = RS.createShareStore(sf);
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
      const L = { fs, path, WS, wsfile: require("../shell/wsfile") };
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
      ok("#2 畫面:api 的原文不上畫面(renderer 不讀 detail / error、樣式拿掉);shr.notShareable 字不改", !/\.detail\b/.test(js) && !/\.error\b/.test(js) && !/shr-detail/.test(js + css)
        && STR.zh["shr.notShareable"] === "這份報告目前不能公開。" && STR.en["shr.notShareable"] === "This report can't be published.");
      logged.length = 0; applog.length = 0; x = mk2({ res: () => ({ status: 413, body: { error: "at most 20 images per shared report", error_code: "TOO_LARGE" } }) });
      q = await x.c.publish("local", "tw-9", { byline: "anonymous", confirmed: true });
      ok("#6 太大(413 TOO_LARGE):只回代號;原文兩個 log 都寫(agent 讀得到是哪個上限)", q.code === "TOO_LARGE" && Object.keys(q).join() === "code" && logged.length === 1 && logged[0][1] === "share refused (413): at most 20 images per shared report" && applog.length === 1, JSON.stringify([q, logged, applog]));
      logged.length = 0; applog.length = 0; x = mk2({ res: () => ({ status: 400, body: { error: "body.tos_version: must match", error_code: "BAD_REQUEST" } }) });
      q = await x.c.publish("local", "tw-9", { byline: "anonymous", confirmed: true });
      ok("#6 外殼送錯(400 BAD_REQUEST):只回代號;原文只進主行程 log,不寫報告的 upload_errors.log(不是 agent 改報告改得掉的)", q.code === "BAD_REQUEST" && Object.keys(q).join() === "code" && logged.length === 0 && applog.length === 1 && applog[0] === "local tw-9: share refused (400): body.tos_version: must match", JSON.stringify([q, logged, applog]));
      logged.length = 0; applog.length = 0; x = mk2({ res: () => ({ status: 429, body: { error: "too many public reports", error_code: "LIVE_LIMIT", limit: 50 } }) });
      q = await x.c.publish("local", "tw-9", { byline: "anonymous", confirmed: true });
      ok("#6 上限(429 LIVE_LIMIT):代號 + 上限的數字,照舊", JSON.stringify(q) === '{"code":"LIVE_LIMIT","limit":50}' && logged.length === 0, JSON.stringify(q));
      // 稽核 T3(第八批 #2 後):原文只進 log;會被記下原文的代號對到的都是拒收句,沒有一個是「請檢查網路」
      const DC = /const DETAIL_CODES = (\[[^\]]*\]);/.exec(read(path.join(SHELL, "reportshare.js")));
      ok("T3 記原文的代號(BAD_CONTENT / TOO_LARGE / NOT_SHAREABLE / IMAGE_QUOTA)對到的都是拒收句", !!DC && JSON.parse(DC[1]).every((c) => P.shrErrKey(c) !== "shr.failed" && P.shrErrKey(c) !== "shr.failedCloud")
        && JSON.parse(DC[1]).join() === "BAD_CONTENT,TOO_LARGE,NOT_SHAREABLE,IMAGE_QUOTA", DC && DC[1]);
      // 稽核 L5:取消失敗另開的單鈕框,標題寫結果(不再是問句)、內文講連結還在;RELOGIN 內文照舊。閱讀頁與清單兩處同一組 key
      const sl = read(path.join(R, "report-sharelist.js")), failBox = /confirmBox\(\{ title: t\("shr\.revokeFailTitle"\), lines: \[t\(code === "RELOGIN" \? "conn\.expired" : "shr\.revokeFailBody"\)\], ok: t\("cdel\.gotIt"\), single: true,/;
      ok("L5 取消失敗框:標題「沒有取消分享」、內文「連結仍然有效。請稍後再試一次。」(zh / en 定稿字面);閱讀頁與清單都換;舊 key 拿掉", failBox.test(js) && failBox.test(sl)
        && STR.zh["shr.revokeFailTitle"] === "沒有取消分享" && STR.en["shr.revokeFailTitle"] === "Couldn't stop sharing" && STR.zh["shr.revokeFailBody"] === "連結仍然有效。請稍後再試一次。" && STR.en["shr.revokeFailBody"] === "The link is still live. Try again in a while."
        && STR.zh["shr.revokeFailed"] === undefined && !/shr\.revokeFailed/.test(js + sl));
    }

    const bin = GATE.bin(SHELL, "④");
    if (!bin) { console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0); }
    // Electron 那段的 userData 由這一層開、這一層收(Electron 關閉時還會往 userData 寫檔)
    const eTmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-shr-e-"));
    const sub = require("child_process").spawnSync(bin, [__filename], { stdio: "inherit", env: { ...process.env, BLAVE_TEST_USERDATA: eTmp } }).status;
    fs.rmSync(eTmp, { recursive: true, force: true });
    const n = red + (sub == null ? 1 : sub);
    console.log(n ? `\n${n} 紅` : "\nALL PASS"); process.exit(n ? 1 : 0);
  })();
  return;
}

// ── ④ Electron ──
const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.env.BLAVE_TEST_USERDATA || fs.mkdtempSync(path.join(os.tmpdir(), "blave-shr-e-")));
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const NOW = Math.floor(Date.now() / 1000);
const doc = (id, type, extra) => ({ report: { schema_version: "1.6", id, type, title: "T-" + id, created_at: NOW - 3600, blocks: [{ type: "meta", title: "標題 " + id, origin: "chat" }, { type: "text", variant: "lead", markdown: "第一句。第二句。" }].concat(extra || []) }, images: { "c.gif": GIF } });
const CITE = [{ type: "image", file: "c.gif", alt: "引用圖", caption: "作者的說明", source: { name: "Glassnode", url: "https://studio.glassnode.com/charts/x" } },
  { type: "image", file: "c.gif", alt: "壞連結", source: { name: "Evil", url: "javascript:alert(1)" } }, { type: "image", file: "nope.gif", alt: "缺的圖", source: { name: "Site", url: "https://www.example.com/p" } }, { type: "image", file: "c.gif", alt: "自產圖" }];
const LIST = [{ id: "res", title: "R", type: "research", created_at: NOW - 100, mtime: (NOW - 100) * 1000 }, { id: "perf", title: "P", type: "performance", created_at: NOW - 200, mtime: (NOW - 200) * 1000 }, { id: "odd", title: "O", type: "journal", created_at: NOW - 250, mtime: (NOW - 250) * 1000 }, { id: "pperf", title: "PP", type: "performance", created_at: NOW - 400, mtime: (NOW - 10) * 1000 },
  { id: "pub", title: "Pub", type: "morning", created_at: NOW - 300, mtime: (NOW - 10) * 1000 }];
const SHARE = { code: "Abcd1234", published_at: NOW - 3600, byline: null, source_stored_at: null, report_stored_at: null };
const STUB = `window.__s = { calls: [], tracked: [], copied: [], state: { res: { code: "OK", share: null, displayName: null }, perf: { code: "OK", share: null, displayName: null }, odd: { code: "OK", share: null, displayName: null }, pperf: { code: "OK", share: ${JSON.stringify(Object.assign({}, SHARE, { code: "Perf5678" }))}, displayName: null }, pub: { code: "OK", share: ${JSON.stringify(SHARE)}, displayName: "Wei" } }, pub: { code: "OK", share: { code: "New98765", published_at: ${NOW}, byline: null, source_stored_at: null, report_stored_at: null } }, revoke: { code: "OK" } };
const __fixed = {
  getLocale: async () => "zh-TW", loadConnection: async () => ({ kind: "claude" }), detectAgents: async () => ({ claude: { installed: true, loggedIn: true }, codex: { installed: false } }),
  listStrategies: async () => [], listSessions: async () => [], loadSession: async () => [], loadSessionImages: async () => [], updateState: async () => ({ phase: "idle", current: "0.0.0" }),
  hasBlaveToken: async () => true, ensureEngine: async () => ({}), libraryList: async () => ({ strategies: [], signedIn: true, dataAccess: "included" }),
  reportsList: async () => ({ reports: ${JSON.stringify(LIST)} }), reportLoad: async (id) => (${JSON.stringify({ res: doc("res", "research", CITE), perf: doc("perf", "performance"), odd: doc("odd", "journal"), pperf: doc("pperf", "performance"), pub: doc("pub", "morning") })})[id] || null,
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

  await openRead("odd"); let s = await st();
  ok("④ 不在白名單上的類型:頁首沒有「分享」、沒有公開列", !s.btn && !s.well, JSON.stringify(s));
  await openRead("perf"); s = await st();
  await js(`document.getElementById("rpt-share").click()`); await wait(300);
  let pf = await js(`(() => { const g = (x) => document.getElementById(x); return { open: !g("shr-scrim").hidden, tt: g("shr-tt").textContent, tag: getComputedStyle(g("shr-og-tag")).display, lk: !!document.querySelector("#shr-modal .shr-og-lk"),
    note: g("shr-perf").hidden ? null : g("shr-perf").textContent, first: document.querySelector("#shr-modal .shr-agree").firstElementChild.id, next: g("shr-perf").nextElementSibling.id, after: g("shr-must").nextElementSibling.className,
    color: getComputedStyle(g("shr-perf")).color, ink: getComputedStyle(g("shr-tt")).color, mustColor: getComputedStyle(g("shr-must")).color, same: ["fontSize", "lineHeight", "marginBottom", "fontWeight"].every((k) => getComputedStyle(g("shr-perf"))[k] === getComputedStyle(g("shr-must"))[k]),
    plain: getComputedStyle(g("shr-perf")).backgroundColor + "|" + getComputedStyle(g("shr-perf")).borderTopWidth + "|" + g("shr-perf").children.length, send: g("shr-send").disabled }; })()`);
  ok("④ performance 的確認框:提醒句是同意區第一段、在揭露小字之前、三行之前;段落樣式同揭露小字、字色是主要文字色(比小字高一階);沒有圖示、底色、框;不擋主鈕以外的東西(勾了才能送照舊)",
    pf.note === (await T("shr.perfNote")) && pf.first === "shr-perf" && pf.next === "shr-must" && pf.after === "shr-three" && pf.same && pf.color === pf.ink && pf.color !== pf.mustColor && pf.plain === "rgba(0, 0, 0, 0)|0px|0" && pf.send, JSON.stringify(pf));
  ok("④ performance 報告:頁首有「分享」;確認框的預覽 = 績效報告前綴 + 標題,縮圖只有 lockup、沒有類型標籤行(公開頁用預設圖)", s.btn && !s.well && pf.open && pf.tt === (await T("shr.ogPrefix.performance")) + "標題 perf" && pf.tag === "none" && pf.lk, JSON.stringify([s, pf]));
  await js(`document.getElementById("shr-ack").click(); document.getElementById("shr-send").click();`); await wait(300);
  ok("④ performance 報告公開:送出的一樣只有 view / id / 掛名 / 勾 / 更新;埋點 share_publish(不帶類型)", (await js(`JSON.stringify(window.__s.calls.filter((c) => c[0] === "publish"))`)) === '[["publish","local","perf",{"byline":"anonymous","confirmed":true,"update":false}]]' && (await js(`window.__s.tracked.includes("share_publish")`)), await js(`JSON.stringify([window.__s.calls, window.__s.tracked])`));
  await openRead("pperf");
  await js(`document.querySelector("#rpt-read .shr-stale .btn-out").click()`); await wait(250);
  pf = await js(`({ title: $("shr-title").textContent, note: $("shr-perf").hidden ? null : $("shr-perf").textContent, tt: $("shr-tt").textContent })`);
  ok("④ performance 的「更新公開版本」:stale 行有更新鈕(不再被當成不能公開的類型)、提醒句照出", pf.title === (await T("shr.dlgTitleUpdate")) && pf.note === (await T("shr.perfNote")) && pf.tt.startsWith(await T("shr.ogPrefix.performance")), JSON.stringify(pf));
  await js(`shrClose()`); await wait(100);
  await js(`window.__s.calls = []; window.__s.tracked = []; window.__s.copied = [];`);
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
    hint: g("shr-hint").textContent, must: g("shr-must").textContent, tt: g("shr-tt").textContent, ds: g("shr-ds").textContent, tag: g("shr-og-tag").textContent, tagShown: !g("shr-og-tag").hidden, perf: g("shr-perf").hidden, same: g("shr-same").hidden, three: [...document.querySelectorAll(".shr-three li")].map((x) => x.textContent), focus: document.activeElement && document.activeElement.id,
    order: [...g("shr-modal").querySelectorAll(".shr-three, #shr-ack")].map((x) => x.id || x.className).join() }; })()`);
  ok("④ 確認框:標題「公開這份報告」、主鈕未勾前 disabled、預設匿名、名字讀不到 → radio 組收起來、純文字「匿名」+ 去填名稱那句;揭露小字 = 本機版;預覽 = 研究報告前綴 + meta 標題 + lead 首句;三行在勾選之前;焦點在 ✕(沒有名字可選時不給捲動區最下面的勾選框,DF12)",
    d.open && d.title === (await T("shr.dlgTitle")) && d.send && d.sendText === (await T("shr.send")) && d.named && d.anon && d.hint === (await T("shr.noName")) && d.must === (await T("shr.noteLocal")) && d.tt === (await T("shr.ogPrefix.research")) + "標題 res"
      && d.ds === "第一句。" && d.tag === (await T("shr.ogTag.research")) && d.tagShown && d.perf && d.same && d.three.length === 3 && d.three[1] === (await T("shr.ack2")) && d.order === "shr-three,shr-ack" && d.focus === "shr-close" && d.radios && d.plain === (await T("shr.anon")), JSON.stringify(d));
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
  await js(`window.__s.pub = { code: "TOO_LARGE", detail: "at most 20 images per shared report", error: "at most 20 images per shared report" }; document.getElementById("shr-send").click();`); await wait(250);
  d = await js(`({ open: !$("shr-scrim").hidden, msg: $("shr-msg").textContent, mono: [...$("shr-msg").querySelectorAll(".mono")].map((x) => x.textContent).join(), ack: $("shr-ack").checked, send: $("shr-send").disabled })`);
  ok("④ 太大:腳一句 shr.tooLarge,20 張 / 20 MB 由程式帶入;api 的原文不上畫面;框留著、勾選保留", d.open && d.msg === (await T("shr.tooLarge", { n: "20", mb: "20" })) && d.msg.includes("20") && !/\{|images per/.test(d.msg) && d.mono === "20,20" && d.ack && !d.send, JSON.stringify(d));
  await js(`window.__s.pub = { code: "BAD_CONTENT", error: "blocks[3].source.url: must be an https URL" }; document.getElementById("shr-send").click();`); await wait(250);
  d = await js(`({ msg: $("shr-msg").textContent })`);
  ok("④ 內容被拒:腳一句 shr.badContent(上一句被換掉,不疊);api 的原文不上畫面", d.msg === (await T("shr.badContent")) && !/blocks\[/.test(d.msg), JSON.stringify(d));
  await js(`window.__s.pub = { code: "NO_DISPLAY_NAME" }; __s.state.res.displayName = "User_AB12CD34"; shrClose();`); await wait(100);
  await openRead("res"); await js(`document.getElementById("rpt-share").click()`); await wait(250);
  d = await js(`({ named: $("shr-named").disabled, nm: $("shr-nm").textContent, hint: $("shr-hint").textContent, radios: $("shr-radios").hidden, plain: $("shr-anon-only").hidden })`);
  ok("④ 名字讀得到(系統預設名也算):兩顆 radio 都在、顯示名稱可選、名字原樣、hint 是「名稱會原樣公開」", !d.named && !d.radios && d.plain && d.nm === "User_AB12CD34" && d.hint === (await T("shr.nameHint")), JSON.stringify(d));
  await js(`$("shr-named").click(); $("shr-ack").click(); $("shr-send").click();`); await wait(250);
  d = await js(`({ open: !$("shr-scrim").hidden, named: $("shr-named").disabled, anon: $("shr-anon").checked, radios: $("shr-radios").hidden, hint: $("shr-hint").textContent, ack: $("shr-ack").checked, msg: $("shr-msg").textContent, last: JSON.stringify(__s.calls.filter((c) => c[0] === "publish").pop()) })`);
  ok("④ api 回 NO_DISPLAY_NAME:退回匿名、radio 組收起來、hint 換去填名稱那句、勾選保留;送出的那一次是 byline=name", d.open && d.named && d.radios && d.anon && d.hint === (await T("shr.noName")) && d.ack && d.msg === "" && d.last.includes('"byline":"name"'), JSON.stringify(d));
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
