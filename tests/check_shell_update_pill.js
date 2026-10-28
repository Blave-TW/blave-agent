// 電腦版更新膠囊＋排程自動更新(spec desktop-update-pill-2026-10-28 r2)§10 單元測試:
//   §3.1 膠囊純函式各狀態;§4.2 主行程↔畫面往返(取消的各種情況、之後 Cmd+Q／選單列「結束」仍有效);
//   §4.3 更新說明的請求與解析(0.1.34 的真 body);§5.2 十個條件各一個反例、窗外、醒來窗已過、換版失敗不再排同一版;
//   scheduledInstall 照做的順序;畫面那一端的更新 modal、upIdleUi;開發版假更新只在沒打包時生效。
// 從原文切出來配假的 electron 物件跑,不開 Electron。跑法:node tests/check_shell_update_pill.js
const fs = require("fs"), path = require("path"), EventEmitter = require("events");
const SHELL = path.join(__dirname, "..", "shell");
const src = fs.readFileSync(path.join(SHELL, "main.js"), "utf8"), app = fs.readFileSync(path.join(SHELL, "renderer", "app.js"), "utf8");
const pre = fs.readFileSync(path.join(SHELL, "preload.js"), "utf8");
const cut = (s, head) => { const i = s.indexOf(head); if (i < 0) throw new Error("找不到 " + head); let d = 0; for (let k = s.indexOf("{", s.indexOf(")", i)); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, k + 1); } throw new Error("切不出 " + head); };
let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || d === undefined ? "" : "  " + JSON.stringify(d))); if (!ok) red++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 有一個 promise 永遠沒回(取消沒接上)時 node 會靜默結束:當成紅
let finished = false;
process.on("exit", () => { if (!finished) { console.log("FAIL  測試沒跑完:有一個等待永遠沒回(取消沒接上)"); process.exitCode = 1; } });
const { parseNotes, fetchNotes } = require("../shell/relnotes.js");
const { schedPlan, schedBoot } = require("../shell/schedupdate.js");
const U = require("../shell/updater.js");

// desktop-v0.1.34 的 Release body(GitHub API 原樣,2026-10-28 取)
const BODY_0134 = "- 新增「成交測試」分頁，在樣本外驗證和程式碼之間\n- 看晚幾根成交、成本高一點，結果會差多少\n- 按〔開始測試〕看結果。要重算，按〔重新測試〕\n- 歡迎頁第一步換成三張現成策略卡，取代原本的起手句\n- 選一張按〔安裝並回測〕就開始\n- Binance 期貨下單結果不明時，不再誤報拒單，也不重送。該標的暫停開倉、平倉照常，查到結果自動接續\n- 通知講清楚：這筆單可能已成交，不要手動補單\n- 按〔暫停並關閉部位〕時，列出哪筆單沒有一起平倉\n- Bitget 跟單或帶單帳戶的金鑰，直接講要換哪種金鑰。不再誤報帳戶模式不支援\n- 視窗不在前面時回覆好了，響跟網頁同一聲提示音\n- 設定 › 一般新增「提示音」開關，跟通知分開設\n- 樣本外驗證分頁不再整頁置中\n\n下載：Mac 用 `.dmg`（通用版），Windows 用 `Blave-Setup-0.1.34.exe`。\n已安裝的版本會自動提示更新。\n\n---\n\n- Find the new Fill Test tab, between Out-of-Sample and Code\n- See how late fills and higher costs change your result\n- Press Start Test to see the result. Press Rerun Test to run it again\n- Start from three ready-made strategy cards on the welcome page, in place of the starter prompts\n- Pick one and press Install & Backtest to begin\n- Stop getting a false rejection or a resent order when a Binance futures order's outcome is unknown. That symbol pauses new entries, stops and closes keep running, and it resumes once the result is found\n- Read a clear notice: the order may have filled, so don't place it again yourself\n- See which orders were left out when you press Pause and close positions\n- Get told which key to use if your Bitget key is from a copy-trading or elite-trader account. No more false \"account mode not supported\"\n- Hear the same sound as the web workspace when a reply is done and the window isn't in front\n- Turn that sound on or off on its own, in Settings › General › Sound\n- See the Out-of-Sample tab laid out normally, no longer centered on the page\n\nDownload: `.dmg` for Mac (universal), `Blave-Setup-0.1.34.exe` for Windows.\nInstalled versions will prompt you to update.\n";

(async () => {
  // ── §3.1 膠囊 ──
  { const upPillPlan = new Function(cut(app, "function upPillPlan(") + "\nreturn upPillPlan;")();
    const P = (up, localTurn) => JSON.stringify(upPillPlan({ up, localTurn }));
    t("§3.1 ready → 一般(可按,不帶「…」)", P({ phase: "ready" }) === '{"show":true,"kind":"ready","ask":false,"disabled":false}');
    t("§3.1 blocked(下單中,含模擬)→ 下單中(ask,字尾「…」)", P({ phase: "blocked" }) === '{"show":true,"kind":"trading","ask":true,"disabled":false}');
    t("§3.1 回合中 → busy(鎖住,ask 照下單狀態)", P({ phase: "ready" }, true) === '{"show":true,"kind":"busy","ask":false,"disabled":true}' && P({ phase: "blocked" }, true) === '{"show":true,"kind":"busy","ask":true,"disabled":true}');
    t("§3.1 重新啟動中(restarting)壓過一切,含回合中與 phase 已不是 ready", [["blocked", false], ["ready", true], ["error", false]].every(([ph, tu]) => P({ phase: ph, restarting: true }, tu) === '{"show":true,"kind":"restarting","ask":false,"disabled":true}'));
    t("§3.1 checking / downloading / staging / idle / off / error / 沒有狀態 → 不出", ["checking", "downloading", "staging", "idle", "off", "error"].every((ph) => JSON.parse(P({ phase: ph })).show === false) && upPillPlan({ up: null }).show === false && upPillPlan({}).show === false);
    t("§3.1 不讀 upPlan 的 slot(雲端更新中時 slot 會蓋掉它)", !/slot|upPlan|applying/.test(cut(app, "function upPillPlan("))); }

  // ── §4.3 更新說明 ──
  { const p = parseNotes(BODY_0134);
    t("§4.3 0.1.34 真 body:zh 取 --- 前段開頭是「- 」的前三條", JSON.stringify(p.zh) === JSON.stringify(["新增「成交測試」分頁，在樣本外驗證和程式碼之間", "看晚幾根成交、成本高一點，結果會差多少", "按〔開始測試〕看結果。要重算，按〔重新測試〕"]), p.zh);
    t("§4.3 …en 取後段英文三條(不混到 zh 段、不收下載那行)", JSON.stringify(p.en) === JSON.stringify(["Find the new Fill Test tab, between Out-of-Sample and Code", "See how late fills and higher costs change your result", "Press Start Test to see the result. Press Rerun Test to run it again"]), p.en);
    t("§4.3 \\r\\n 一樣解", JSON.stringify(parseNotes(BODY_0134.replace(/\n/g, "\r\n"))) === JSON.stringify(p));
    t("§4.3 沒有 --- → 兩邊都空;沒有條列 → 空", JSON.stringify(parseNotes("- a\n- b")) === '{"zh":[],"en":[]}' && JSON.stringify(parseNotes("說明\n---\nnotes only")) === '{"zh":[],"en":[]}' && JSON.stringify(parseNotes(null)) === '{"zh":[],"en":[]}');
    const evil = parseNotes("- 新\u202e版\u2066本\u200b`rm`\u0007\n---\n- Fix\u202d it\u2069 `now`");
    t("§4.3 去掉控制字元、bidi(U+200B–U+202E、U+2066–U+2069)與反引號", evil.zh[0] === "新版本rm" && evil.en[0] === "Fix it now", evil);
    const punct = parseNotes("- 修正——不再「卡住」…\n---\n- Don\u2019t \u201cstall\u201d \u2014 ever\u2026");
    t("§4.3 一般標點(— … ’ “ ”)照留,只去看不見的字", punct.zh[0] === "修正——不再「卡住」…" && punct.en[0] === "Don\u2019t \u201cstall\u201d \u2014 ever\u2026", punct);
    const long = parseNotes("- " + "字".repeat(41) + "\n- " + "字".repeat(40) + "\n---\n- " + Array(26).fill("w").join(" ") + "\n- " + Array(25).fill("w").join(" "));
    t("§4.3 zh 每條截 40 字、en 截 25 words,超過加「…」;剛好不加", long.zh[0] === "字".repeat(40) + "…" && long.zh[1] === "字".repeat(40) && long.en[0] === Array(25).fill("w").join(" ") + "…" && long.en[1] === Array(25).fill("w").join(" "), long);
    t("§4.3 「-」後沒空白、縮排的不算條列", JSON.stringify(parseNotes("-a\n  - b\n- c\n---\n- d").zh) === '["c"]'); }
  { const reqs = [];
    // 假 https.get:回 { statusCode, chunks } 或不回(逾時)
    const fakeGet = (resp) => (url, opts, cb) => {
      const req = new EventEmitter(); req.destroyed = false; req.destroy = () => { req.destroyed = true; }; reqs.push({ url, opts, req });
      if (resp) setImmediate(() => { const res = new EventEmitter(); res.statusCode = resp.status || 200; res.resume = () => {}; cb(res); setImmediate(() => { (resp.chunks || []).forEach((c) => res.emit("data", Buffer.from(c))); res.emit("end"); }); });
      return req;
    };
    const ok = (o) => JSON.stringify({ tag_name: "desktop-v0.1.34", body: BODY_0134, ...(o || {}) });
    reqs.length = 0; const r = await fetchNotes("0.1.34", { get: fakeGet({ chunks: [ok()] }) });
    t("§4.3 請求:releases/tags/desktop-v{v}、帶 User-Agent、不帶 token", reqs.length === 1 && reqs[0].url === "https://api.github.com/repos/Blave-TW/blave-agent/releases/tags/desktop-v0.1.34" && reqs[0].opts.headers["User-Agent"] && !reqs[0].opts.headers.Authorization && r && r.zh.length === 3 && r.en.length === 3 && r.v === "0.1.34", reqs.map((x) => x.opts));
    reqs.length = 0;
    t("§4.3 版號不過 ^\\d+\\.\\d+\\.\\d+$ 就不抓", (await Promise.all(["0.1.34-beta", "../x", "0.1", "", null, "v0.1.34", "0.1.34\n"].map((v) => fetchNotes(v, { get: fakeGet({ chunks: [ok()] }) })))).every((x) => x === null) && reqs.length === 0);
    t("§4.3 tag_name 不等於 desktop-v{v} 就丟掉", (await fetchNotes("0.1.34", { get: fakeGet({ chunks: [ok({ tag_name: "desktop-v0.1.33" })] }) })) === null && (await fetchNotes("0.1.34", { get: fakeGet({ chunks: [ok({ tag_name: "v0.1.34" })] }) })) === null);
    t("§4.3 404(測試軌沒有 Release、正式軌 Release 還沒建)／限流 403 → null", (await fetchNotes("0.1.34", { get: fakeGet({ status: 404, chunks: ["{}"] }) })) === null && (await fetchNotes("0.1.34", { get: fakeGet({ status: 403, chunks: ["{}"] }) })) === null);
    reqs.length = 0; const bigJson = ok({ pad: "x".repeat(300 * 1024) }), big = await fetchNotes("0.1.34", { get: fakeGet({ chunks: [bigJson.slice(0, 200 * 1024), bigJson.slice(200 * 1024)] }) });
    t("§4.3 回應超過 256KB → null、請求收掉", big === null && reqs[0].req.destroyed === true);
    reqs.length = 0; const t0 = Date.now(), slow = await fetchNotes("0.1.34", { get: fakeGet(null), timeoutMs: 60 });
    t("§4.3 逾時 → null、請求收掉;預設逾時 5 秒", slow === null && Date.now() - t0 < 1000 && reqs[0].req.destroyed === true && /TIMEOUT_MS = 5000/.test(fs.readFileSync(path.join(SHELL, "relnotes.js"), "utf8")) && /MAX_BYTES = 256 \* 1024/.test(fs.readFileSync(path.join(SHELL, "relnotes.js"), "utf8")));
    t("§4.3 壞 JSON、沒有條列 → null", (await fetchNotes("0.1.34", { get: fakeGet({ chunks: ["{bad"] }) })) === null && (await fetchNotes("0.1.34", { get: fakeGet({ chunks: [ok({ body: "no bullets\n---\nnone" })] }) })) === null);
    const errGet = () => { const req = new EventEmitter(); req.destroy = () => {}; setImmediate(() => req.emit("error", new Error("ENOTFOUND"))); return req; };
    t("§4.3 離線(請求 error)→ null、不拋", (await fetchNotes("0.1.34", { get: errGet })) === null);
    t("§4.3 說明不放進 update-state 廣播;畫面用 invoke(update-notes)取,過 fromOurPage", !/_upNotes|notes/.test(src.split("\n").filter((l) => /send\("update-state"/.test(l)).join("\n")) && /handle\("update-notes", \(\) => upNotesGet\(\), null\);/.test(src)
      && /updateNotes: \(\) => ipcRenderer\.invoke\("update-notes"\)/.test(pre));
    t("§4.3 何時抓:updater 進 ready／blocked 時抓一次(onState → upNotesKick),開 §4.1 那一刻沒拿到再抓(upNotesGet → upNotesKick,最多兩次)", /if \(st\.phase === "ready" \|\| st\.phase === "blocked"\) upNotesKick\(st\.version\);/.test(src) && /_upNotes\.tries >= 2/.test(cut(src, "function upNotesKick("))); }

  // ── §5.2 排程:十個條件 ──
  { const at = (h, m) => new Date(2026, 9, 29, h, m, 0).getTime(), NOW = at(6, 5);
    const ok = { now: NOW, on: true, phase: "ready", version: "0.1.36", failed: null, trading: false, turn: false, idleSec: 900, twHeld: false, asking: false, engineBusy: false,
      reports: { running: false, next_due_at: null }, dirty: false, uiBusy: false };
    const go = (x) => schedPlan({ ...ok, ...x });
    t("§5.2 全部成立 → 重開", go({}).go === true);
    const NO = [
      ["1 phase 不是 ready(blocked／downloading／error／off)", [{ phase: "blocked" }, { phase: "downloading" }, { phase: "error" }, { phase: "off" }]],
      ["2 tradeMaybeLive 為真(含模擬)", [{ trading: true }]],
      ["3 對話在回覆(activeTurn／turnStarting)", [{ turn: true }]],
      ["4 最近 10 分鐘有人操作(idle < 600)", [{ idleSec: 599 }, { idleSec: 0 }, { idleSec: NaN }, { idleSec: undefined }]],
      ["5 策略組合有草稿,逾時或出錯(null)一律當有", [{ dirty: true }, { dirty: null }, { dirty: undefined }]],
      ["6 輸入框不空或有框開著,逾時(null)當有", [{ uiBusy: true }, { uiBusy: null }]],
      ["7 統一／群益有部位或讀不到(twLots().held)", [{ twHeld: true }]],
      ["8 有框開著或正在收工(quitAsking／moveAsking／restarting／quitConfirmed／quitting)", [{ asking: true }]],
      ["9 引擎在安裝(engineSetup().busy()／_engineRun)", [{ engineBusy: true }]],
      ["10 報告在跑、10 分鐘內到期、或讀不到欄位", [{ reports: { running: true, next_due_at: null } }, { reports: { running: false, next_due_at: new Date(NOW + 5 * 60000).toISOString() } },
        { reports: { running: false, next_due_at: new Date(NOW + 10 * 60000).toISOString() } }, { reports: { running: false, next_due_at: new Date(NOW - 60000).toISOString() } }, { reports: undefined }, { reports: null }, { reports: {} },
        { reports: { running: false } }, { reports: { next_due_at: null } }, { reports: { running: "false", next_due_at: null } }, { reports: { running: false, next_due_at: "soon" } }, { reports: { running: false, next_due_at: 123 } }]],
    ];
    for (const [name, xs] of NO) t("§5.2 條件 " + name + " → 不重開", xs.every((x) => go(x).go === false), xs.map((x) => go(x).why));
    t("§5.2 條件 10 反面:下一個報告在 10 分鐘之後、或沒有排程(null)→ 可以", go({ reports: { running: false, next_due_at: new Date(NOW + 11 * 60000).toISOString() } }).go === true && go({ reports: { running: false, next_due_at: null } }).go === true);
    t("§5.2 開關關著 → 不重開", go({ on: false }).go === false);
    t("§5.2 窗外不重開:05:59、06:30、06:31、12:00、隔天 05:00 都不動;06:00 與 06:29 動", [at(5, 59), at(6, 30), at(6, 31), at(12, 0), at(5, 0)].every((n) => go({ now: n }).go === false) && go({ now: at(6, 0) }).go && go({ now: at(6, 29) }).go);
    t("§5.2 醒來窗已過不補做:08:15 醒來那一輪(其他全成立)不動、也沒有「待補」狀態", go({ now: at(8, 15) }).go === false && go({ now: at(8, 15) }).why === "window");
    t("§5.2 換版失敗:同一版不再排(failed === version);出了更新一版才又可以", go({ failed: "0.1.36" }).go === false && go({ failed: "0.1.36", version: "0.1.37" }).go === true);
    t("§5.2 已暫存的版號讀不到 → 不重開(不寫不出的目標版號)", go({ version: null }).go === false && go({ version: "" }).go === false);
    t("§5.2 在下單的人永遠不會被自動重開:trading 一真,其他怎樣都不動", [{}, { idleSec: 1e9 }, { reports: { running: false, next_due_at: null } }].every((x) => go({ ...x, trading: true }).go === false));
    // 防無限重開:啟動時對版號
    t("§5.2 啟動時目前版號追上目標(或超過):刪記號、不送失敗", JSON.stringify(schedBoot({ current: "0.1.36", target: "0.1.36", failed: null })) === '{"target":null,"failed":null,"report":false}'
      && JSON.stringify(schedBoot({ current: "0.1.37", target: "0.1.36", failed: null })) === '{"target":null,"failed":null,"report":false}');
    t("§5.2 啟動時沒追上(換版失敗):記成失敗版號、送一次 update_failed stage=install", JSON.stringify(schedBoot({ current: "0.1.35", target: "0.1.36", failed: null })) === '{"target":null,"failed":"0.1.36","report":true}');
    t("§5.2 之後的啟動:失敗版號還沒追上就留著、不重送;追上就清", JSON.stringify(schedBoot({ current: "0.1.35", target: null, failed: "0.1.36" })) === '{"target":null,"failed":"0.1.36","report":false}'
      && JSON.stringify(schedBoot({ current: "0.1.36", target: null, failed: "0.1.36" })) === '{"target":null,"failed":null,"report":false}' && JSON.stringify(schedBoot({ current: "0.1.35", target: "x", failed: null })) === '{"target":null,"failed":null,"report":false}'); }

  // ── scheduledInstall 照做(main.js)──
  { const SCHED = cut(src, "async function scheduledInstall("), PA = cut(src, "async function pageAsk(");
    const rig = (o) => {
      const log = [], prefs = {};
      const at6 = new Date(2026, 9, 29, 6, 5).getTime();
      const ctx = { _schedRunning: false, draftOk: false, quitAsking: false, moveAsking: false, restarting: null, quitConfirmed: false, quitting: false, activeTurn: null, turnStarting: false, _engineRun: null,
        updater: () => ({ state: () => ({ phase: o.phase || "ready", version: "0.1.36" }), install: () => { log.push("install"); return o.installRes || { ok: true }; } }),
        _tradeHost: { status: () => ({ alive: o.alive !== false, report: { daemon: { reports: o.reports === undefined ? { running: false, next_due_at: null } : o.reports } } }) },
        updAutoGet: () => o.on !== false, updSchedRec: () => ({ target: null, failed: o.failed || null }), tradeMaybeLive: () => (o.trading ? { venue: "x" } : null), twLots: () => ({ held: !!o.twHeld }),
        engineSetup: () => ({ busy: () => false }), require: (m) => (m === "electron" ? { powerMonitor: { getSystemIdleTime: () => (o.idle === undefined ? 900 : o.idle) } } : require(path.join(SHELL, m))),
        pageAsk: async (expr) => { log.push(/trUnsavedAny/.test(expr) ? "ask:draft" : "ask:ui"); if (o.onAsk) o.onAsk(ctx); return /trUnsavedAny/.test(expr) ? (o.dirty === undefined ? false : o.dirty) : o.idleUi === undefined ? true : o.idleUi; },
        tm: () => ({ track: (ev, p) => log.push("track:" + ev + ":" + (p.name || p.stage)) }), engineAbort: async () => { log.push("engineAbort"); },
        uiPrefsPatch: (p) => { Object.assign(prefs, p); log.push("prefs:" + JSON.stringify(p)); }, Date: { now: () => at6 } };
      const fn = new Function("ctx", "with (ctx) { " + SCHED + "\n return scheduledInstall; }")(ctx);
      return { run: () => fn(at6), log, prefs, ctx };
    };
    { const r = rig({}), res = await r.run();
      t("全部成立:先問畫面(草稿、輸入框與框)→ 送 upd_sched_run → 收引擎 → install → 才寫目標版號", res.go === true && r.log.join() === 'ask:draft,ask:ui,track:feature_used:upd_sched_run,engineAbort,install,prefs:{"updSchedTarget":"0.1.36"}', r.log);
      t("…不送 update_restart、設 draftOk(quitAndInstall 關窗時不再問草稿)", !r.log.some((x) => /update_restart/.test(x)) && r.ctx.draftOk === true); }
    { const r = rig({ installRes: { ok: false, error: "TRADING" } }), res = await r.run();
      t("install 回 TRADING／失敗:不寫目標版號(已寫的刪掉)、收回 draftOk", res.go === false && r.prefs.updSchedTarget === null && r.ctx.draftOk === false && !r.log.some((x) => /0\.1\.36"\}$/.test(x)), r.log); }
    for (const [why, o] of [["畫面草稿逾時／出錯(null)", { dirty: null }], ["有草稿", { dirty: true }], ["輸入框或框逾時(null)", { idleUi: null }], ["輸入框不空", { idleUi: false }]]) {
      const r = rig(o), res = await r.run();
      t("畫面那兩問:" + why + " → 不重開、不送 upd_sched_run、不寫記號", res.go === false && !r.log.includes("install") && !r.log.some((x) => /upd_sched_run|prefs/.test(x)), r.log); }
    { const r = rig({ onAsk: (c) => { c.tradeMaybeLive = () => ({ venue: "x" }); } }), res = await r.run();
      t("問畫面那段時間開始下單:重判一次,不重開", res.go === false && res.why === "trading" && !r.log.includes("install"), r.log); }
    { const r = rig({ onAsk: (c) => { c.activeTurn = {}; } }), res = await r.run();
      t("…開始回合:同上", res.go === false && !r.log.includes("install")); }
    for (const [why, o] of [["daemon 不新鮮(alive false,報告欄位不可信)", { alive: false }], ["狀態檔沒有 daemon.reports(舊 runtime)", { reports: null }], ["引擎在跑", {}]]) {
      const r = rig(o); if (why === "引擎在跑") r.ctx._engineRun = Promise.resolve();
      const res = await r.run();
      t("主行程收集的條件:" + why + " → 不重開,也不去問畫面", res.go === false && !r.log.some((x) => /^ask:/.test(x)), [res, r.log]); }
    { const r = rig({}); r.ctx._schedRunning = true; const res = await r.run();
      t("上一輪還在問畫面:這一輪不疊", res.why === "running" && r.log.length === 0); }
    // pageAsk:逾時或出錯回 null;沒有我們的頁 = false(沒有草稿、沒有框)
    const paRig = (w) => new Function("ctx", "with (ctx) { " + PA + "\n return pageAsk; }")({ draftMainWin: () => w, setTimeout, Promise });
    const W = (fn) => ({ webContents: { executeJavaScript: fn } });
    t("pageAsk:回 true／false 照回;reject → null;卡住 1.5 秒 → null;沒有頁 → false", (await paRig(W(() => Promise.resolve(true)))("x")) === true && (await paRig(W(() => Promise.resolve(false)))("x")) === false
      && (await paRig(W(() => Promise.reject(new Error("gone"))))("x")) === null && (await paRig(W(() => new Promise(() => {})))("x")) === null && (await paRig(null)("x")) === false
      && (await paRig(W(() => { throw new Error("destroyed"); }))("x")) === null);
    t("每分鐘一次、只在 06:00–06:30 判(schedupdate.inWindow);第二份 app 不排;啟動時先對版號(updSchedBoot)", /if \(app\.hasSingleInstanceLock\(\)\) startStep\("update schedule", \(\) => \{\n    updSchedBoot\(\);\n    const t = setInterval\(\(\) => \{ scheduledInstall\(\)\.catch\(/.test(src) && /\}, 60000\);/.test(src)
      && /getHours\(\) === WINDOW_HOUR && d\.getMinutes\(\) < WINDOW_MIN/.test(fs.readFileSync(path.join(SHELL, "schedupdate.js"), "utf8")));
    t("updSchedBoot:沒追上就送 update_failed stage=install(主行程送,經 schedBoot)", /if \(b\.report\) \{ try \{ tm\(\)\.track\("update_failed", \{ stage: "install" \}\); \}/.test(cut(src, "function updSchedBoot(")));
    t("預設開、存 ui-prefs autoUpdate(缺 = 開,舊版升上來也是開)", /autoUpdate !== false; \} catch \(_\) \{ return true; \}/.test(src) && /handle\("update-auto-set", \(_e, on\) => updAutoSet\(on === true\), null\);/.test(src));
    t("條件 10 讀的是 runtime 寫的 daemon.reports(runtime/local_daemon.py write_status),daemon 不新鮮就不信", /host && host\.alive && host\.report && host\.report\.daemon \? host\.report\.daemon\.reports : undefined/.test(SCHED)
      && /doc\["daemon"\]\["reports"\] = self\.cl\.report_activity\(\)/.test(fs.readFileSync(path.join(SHELL, "..", "runtime", "local_daemon.py"), "utf8"))); }

  // ── §4.2 主行程↔畫面往返(updAsk)與取消後 Cmd+Q／選單列「結束」仍有效 ──
  { const UA = cut(src, "function updAsk("), BQ = cut(src, 'app.on("before-quit", (e) => {');
    const mkWin = (url) => { const w = new EventEmitter(), wc = new EventEmitter(); wc.sent = []; wc.send = (ch, a) => wc.sent.push([ch, a]); wc.getURL = () => url; w.webContents = wc; w.destroyed = false; w.isDestroyed = () => w.destroyed; return w; };
    const rig = (o) => {
      const log = [], win = o && o.noWin ? null : mkWin("file:///app/index.html");
      const ctx = { _upAsk: null, _upAskSeq: 0, quitAsking: false, UP_ASK_PICKUP_MS: (o && o.pickupMs) || 200, showMain: () => log.push("showMain"), draftMainWin: () => win, setTimeout, clearTimeout, Promise,
        // before-quit 用的(同 check_shell_update_restart.js 的 quitRig)
        restarting: null, quitting: false, quitConfirmed: false, draftOk: false, draftNote: false, draftNoted: (d) => d, moveAsking: false, activeTurn: null, turnStarting: false,
        draftDirty: () => { log.push("draftDirty"); return new Promise(() => {}); }, tradeMaybeLive: () => null, twLots: () => ({ held: false }), _tradeHost: null, _engineSetup: null, engineAbort: () => Promise.resolve(),
        app: { on: (ev, fn) => { ctx.handler = fn; }, quit: () => { log.push("app.quit"); } }, console: { error: () => {} } };
      const updAsk = new Function("ctx", "with (ctx) { " + UA + "\n return updAsk; }")(ctx);
      new Function("ctx", "with (ctx) { " + BQ + "); }")(ctx);
      const quit = () => { const e = { prevented: false, preventDefault() { this.prevented = true; } }; log.push("before-quit"); ctx.handler(e); return e; };
      return { ctx, win, log, ask: (k, d) => updAsk(k, d), quit, pick: (wc) => (ctx._upAsk && ctx._upAsk.pickedBy(wc) ? { id: ctx._upAsk.id, kind: ctx._upAsk.kind, data: ctx._upAsk.data } : null),
        answer: (wc, id, ok) => { if (ctx._upAsk && ctx._upAsk.id === id && ctx._upAsk.pickedBy(wc)) ctx._upAsk.done(ok === true); } };
    };
    { const r = rig(), p = r.ask("trading", { venue: "Binance" });
      t("開框:先 showMain、立 quitAsking、送 update-ask 叫我們那一頁來拿(資料不經廣播)", r.log[0] === "showMain" && r.ctx.quitAsking === true && r.win.webContents.sent.length === 1 && r.win.webContents.sent[0][0] === "update-ask" && r.win.webContents.sent[0][1] === undefined);
      const other = mkWin("file:///app/index.html").webContents;
      t("別的 webContents 來拿／來答:不給、不算數", r.pick(other) === null && (r.answer(other, 1, true), r.ctx._upAsk !== null));
      const a = r.pick(r.win.webContents); r.answer(r.win.webContents, a.id + 99, true);
      t("我們那一頁來拿:拿到 kind 與主行程算好的資料;id 不對的答案不算", a.kind === "trading" && a.data.venue === "Binance" && r.ctx._upAsk !== null);
      r.answer(r.win.webContents, a.id, true); const res = await p;
      t("答〔重新啟動〕→ true;quitAsking 放回 false、監聽都拆掉", res === true && r.ctx.quitAsking === false && r.win.listenerCount("closed") === 0 && r.win.listenerCount("hide") === 0 && r.win.webContents.listenerCount("render-process-gone") === 0 && r.win.webContents.listenerCount("did-start-navigation") === 0); }
    { const r = rig(), p = r.ask("plain", { v: "0.1.36" }); const a = r.pick(r.win.webContents); r.answer(r.win.webContents, a.id, false);
      t("答取消 → false、quitAsking false", (await p) === false && r.ctx.quitAsking === false); }
    const CANCELS = [
      ["視窗 destroyed(closed)", (r) => { r.win.destroyed = true; r.win.emit("closed"); }],
      ["視窗被關／藏起來(紅燈在下單時只收視窗)", (r) => r.win.emit("hide")],
      ["webContents destroyed", (r) => r.win.webContents.emit("destroyed")],
      ["render-process-gone", (r) => r.win.webContents.emit("render-process-gone", {}, { reason: "crashed" })],
      ["重新載入(新版 Electron:details 物件)", (r) => r.win.webContents.emit("did-start-navigation", { url: "file:///app/index.html", isMainFrame: true, isSameDocument: false })],
      ["重新載入(舊版簽名:event, url, isInPlace, isMainFrame)", (r) => r.win.webContents.emit("did-start-navigation", {}, "file:///app/index.html", false, true)],
    ];
    for (const [name, fire] of CANCELS) {
      const r = rig(), p = r.ask("trading", {}); r.pick(r.win.webContents);
      const during = r.quit();
      fire(r); const res = await p;
      t("§4.2 " + name + " → 一律當取消、quitAsking 放回 false", res === false && r.ctx.quitAsking === false && r.ctx._upAsk === null, { res, q: r.ctx.quitAsking });
      t("…等待期間按 Cmd+Q 不疊框(quitAsking 擋著);取消之後再按 Cmd+Q／選單列「結束」= before-quit 照常往下走(問草稿、會結束)", during.prevented && !r.log.slice(0, r.log.indexOf("before-quit") + 1).includes("draftDirty")
        && (r.quit(), r.log.filter((x) => x === "draftDirty").length === 1), r.log); }
    { const r = rig(), p = r.ask("trading", {}); r.pick(r.win.webContents);
      r.win.webContents.emit("did-start-navigation", { url: "file:///app/index.html#x", isMainFrame: true, isSameDocument: true });
      r.win.webContents.emit("did-start-navigation", { url: "about:blank", isMainFrame: false, isSameDocument: false });
      t("同一頁的 hash、子框架的導航不算重新載入", r.ctx._upAsk !== null && r.ctx.quitAsking === true); r.win.emit("hide"); await p; }
    { const r = rig({ pickupMs: 40 }), p = r.ask("trading", {}); const res = await p;
      t("頁 10 秒內沒來拿(畫面卡死、還沒載好又壞掉):當取消、quitAsking 放回;預設 10 秒", res === false && r.ctx.quitAsking === false && /const UP_ASK_PICKUP_MS = 10000;/.test(src) && (r.quit(), r.log.includes("draftDirty"))); }
    { const r = rig({ noWin: true, pickupMs: 40 }), res = await r.ask("plain", {});
      t("找不到我們那一頁(只剩藏著的 PDF 視窗):等到期限當取消,quitAsking 放回", res === false && r.ctx.quitAsking === false); }
    { const r = rig(), p = r.ask("trading", {}); r.pick(r.win.webContents); r.win.emit("hide"); await p;
      t("主行程那邊取消時通知畫面把框收掉(update-ask-close + id)", r.win.webContents.sent.some((x) => x[0] === "update-ask-close" && x[1] === 1)); }
    t("選單列「結束」= app.quit() → 走同一個 before-quit(上面那幾條就是它)", /\{ label: m\.quit, click: \(\) => app\.quit\(\) \}/.test(cut(src, "function trayMenu(")));
    t("找頁只用 draftMainWin(isOurPageUrl 那一個),不用 getAllWindows()[0]", /win = draftMainWin\(\);/.test(UA) && !/getAllWindows/.test(UA));
    t("IPC:update-ask-get／update-ask-answer 走 handle(過 fromOurPage),而且只認主行程正在等的那一頁與 id", /handle\("update-ask-get", \(e\) => \(_upAsk && _upAsk\.pickedBy\(e\.sender\)/.test(src) && /handle\("update-ask-answer", \(e, id, ok\) => \{ if \(_upAsk && _upAsk\.id === id && _upAsk\.pickedBy\(e\.sender\)\) _upAsk\.done\(ok === true\);/.test(src)
      && /const handle = \(channel, fn, denied = null\) => ipcMain\.handle\(channel, \(e, \.\.\.a\) => \(fromOurPage\(e\) \? fn\(e, \.\.\.a\) : denied\)\);/.test(src));
    t("preload:updateInstall 只送 { confirmed: boolean }、其餘欄位不帶", /updateInstall: \(opts\) => ipcRenderer\.invoke\("update-install", \{ confirmed: !!\(opts && opts\.confirmed === true\) \}\)/.test(pre)); }

  // ── 畫面那一端:更新 modal、upIdleUi ──
  { const mk = () => { const n = { hidden: false, children: [], className: "", textContent: "", value: "", isConnected: true, parentNode: null,
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; }, insertBefore(c, ref) { this.children = [c, ...this.children.filter((x) => x !== c)]; c.parentNode = this; return c; } }; Object.defineProperty(n, "firstChild", { get() { return n.children[0] || null; } }); return n; };
    const dom = {}, boxes = [], tracked = [], answers = [];
    let notes = null, unsaved = false, LANGV = "zh";
    const env = { $: (id) => dom[id] || (dom[id] = mk()), document: { createElement: () => mk(), querySelector: (q) => env.modalOpen ? {} : null }, modalOpen: false,
      t: (k, v) => k + (v ? JSON.stringify(v) : ""), trackFeature: (n) => tracked.push(n), get LANG() { return LANGV; }, delCtx: null,
      confirmBox: (o) => { boxes.push(o); env.delCtx = { onCancel: o.onCancel, onOk: o.onOk }; env.$("del-scrim").hidden = false; if (o.extra) env.$("del-body").appendChild(o.extra); },
      delClose: () => { const c = env.delCtx; env.delCtx = null; env.$("del-scrim").hidden = true; if (c && c.onCancel && !c.acted) c.onCancel(); },
      trUnsavedAny: () => unsaved, window: { blave: { updateNotes: () => Promise.resolve(notes), updateAskGet: () => Promise.resolve(env.pending), updateAskAnswer: (id, ok) => { answers.push([id, ok]); return Promise.resolve(true); } } }, pending: null, UP_BOX: null };
    env.$("del-scrim").hidden = true;
    const fns = ["upModal", "upBoxClose", "upAskPull", "upIdleUi"].map((n) => cut(app, (n === "upAskPull" ? "async " : "") + "function " + n + "(")).concat([cut(app, "async function upNotesFill(")]);
    const R = new Function("env", "with (env) { " + fns.join("\n") + "\n return { upModal, upBoxClose, upAskPull, upIdleUi }; }")(env);
    const okClick = () => { const c = env.delCtx; c.acted = true; env.delClose(); c.onOk(); };
    let done = []; unsaved = true;
    R.upModal("plain", { v: "0.1.36" }, null, (ok) => done.push(ok));
    let b = boxes[0];
    t("§4.1:標題 up.md.title{v}、主鈕 up.md.go、有草稿加 tm.unsavedNote;說明槽先藏著", b.title === 'up.md.title{"v":"0.1.36"}' && b.ok === "up.md.go" && JSON.stringify(b.lines) === '["tm.unsavedNote"]' && b.extra.hidden === true);
    okClick();
    t("§4.1 按〔重新啟動〕→ done(true) 一次、不記取消", JSON.stringify(done) === "[true]" && tracked.length === 0);
    done = []; boxes.length = 0; unsaved = false;
    notes = { v: "0.1.36", zh: ["新\u202e<img src=x onerror=alert(1)>", "二", "三", "四"], en: ["One", "Two"] };
    R.upModal("plain", { v: "0.1.36" }, null, (ok) => done.push(ok)); await sleep(5);
    b = boxes[0]; const ul = b.extra.children[0];
    t("§4.1 說明拿到再補上:最多 3 條、只用 textContent(標籤原樣當字)、放到內文最上面;沒草稿就沒有草稿那句", b.lines.length === 0 && b.extra.hidden === false && ul && ul.className === "up-notes" && ul.children.length === 3
      && ul.children[0].textContent === "新\u202e<img src=x onerror=alert(1)>" && env.$("del-body").firstChild === b.extra && !/innerHTML|upRich|\bt\(/.test(cut(app, "async function upNotesFill(")));
    env.delClose();
    t("§4.1 Esc／✕／取消／框外 → upd_cf_cancel 一次、done(false)", JSON.stringify(done) === "[false]" && tracked.join() === "upd_cf_cancel");
    done = []; boxes.length = 0; tracked.length = 0; LANGV = "en";
    R.upModal("plain", { v: "0.1.36" }, null, (ok) => done.push(ok)); await sleep(5);
    t("§4.1 en 介面取 en 那段", boxes[0].extra.children[0].children.map((x) => x.textContent).join() === "One,Two");
    R.upBoxClose();
    t("程式收掉(phase 變了／主行程已取消):done(false)、不記 upd_cf_cancel", JSON.stringify(done) === "[false]" && tracked.length === 0 && env.$("del-scrim").hidden === true);
    done = []; boxes.length = 0; LANGV = "zh";
    R.upModal("trading", { venue: "Binance", cloud: true, unsaved: true }, null, (ok) => done.push(ok));
    t("§4.2:標題 tm.quitTitle、內文兩句後果(tm.updateBody{venue}、up.md.stay)＋雲端句＋草稿句;不列改了什麼;主鈕 up.md.go", boxes[0].title === "tm.quitTitle" && JSON.stringify(boxes[0].lines) === JSON.stringify(['tm.updateBody{"venue":"Binance"}', "up.md.stay", "tm.quitCloudNote", "tm.unsavedNote"]) && !boxes[0].extra && boxes[0].ok === "up.md.go");
    R.upBoxClose(); boxes.length = 0;
    R.upModal("trading", { venue: 5, cloud: "yes", unsaved: 1 }, null, () => {});
    t("§4.2 資料形狀不對:交易所名留空、雲端句與草稿句不出(只認 === true)", JSON.stringify(boxes[0].lines) === JSON.stringify(['tm.updateBody{"venue":""}', "up.md.stay"])); R.upBoxClose();
    boxes.length = 0; answers.length = 0; env.pending = { id: 7, kind: "trading", data: { venue: "OKX" } };
    await R.upAskPull(); await R.upAskPull();
    t("主行程叫畫面開框:upAskPull 拿到就開(同一個 id 不開第二次)", boxes.length === 1 && boxes[0].title === "tm.quitTitle");
    okClick(); await sleep(1);
    t("…按〔重新啟動〕→ update-ask-answer(id, true)", JSON.stringify(answers) === "[[7,true]]");
    boxes.length = 0; answers.length = 0; env.pending = { id: 8, kind: "trading", data: {} }; await R.upAskPull(); env.delClose(); await sleep(1);
    t("…取消 → update-ask-answer(id, false)", JSON.stringify(answers) === "[[8,false]]");
    boxes.length = 0; env.pending = null; await R.upAskPull();
    t("…沒有待問的(null)什麼都不開", boxes.length === 0);
    t("onUpdateState:框開著時 phase 不再是已暫存或進入重新啟動中 → 收掉(§9);update-ask-close 只收同一個 id", /if \(UP_BOX && \(st\.restarting \|\| \(st\.phase !== "ready" && st\.phase !== "blocked"\)\)\) upBoxClose\(\);/.test(app) && /onUpdateAskClose\(\(id\) => \{ if \(UP_BOX && UP_BOX\.id === id\) upBoxClose\(\); \}\);/.test(app));
    // upIdleUi(條件 6)
    env.$("ta").value = ""; env.$("attach-chips").hidden = true; env.$("mp-panel").hidden = true; env.modalOpen = false;
    const idle0 = R.upIdleUi();
    env.$("ta").value = " x "; const typed = R.upIdleUi(); env.$("ta").value = "  ";
    env.modalOpen = true; const modal = R.upIdleUi(); env.modalOpen = false;
    env.$("mp-panel").hidden = false; const mp = R.upIdleUi(); env.$("mp-panel").hidden = true;
    env.$("attach-chips").hidden = false; env.$("attach-chips").children = [mk()]; const chips = R.upIdleUi();
    t("條件 6 upIdleUi:空輸入框、沒框 → true;有字／有附件／[aria-modal=true]:not([hidden])／#mp-panel 開著 → false", idle0 === true && typed === false && modal === false && mp === false && chips === false
      && /document\.querySelector\('\[aria-modal="true"\]:not\(\[hidden\]\)'\)/.test(cut(app, "function upIdleUi("))); }

  // ── 開發版假更新 ──
  { t("BLAVE_DEV_FAKE_UPDATE 只在 !app.isPackaged 生效", U.devFakeVersion({ BLAVE_DEV_FAKE_UPDATE: "1" }, true) === null && U.devFakeVersion({ BLAVE_DEV_FAKE_UPDATE: "0.1.40" }, true) === null
      && U.devFakeVersion({ BLAVE_DEV_FAKE_UPDATE: "1" }, false) === "9.9.9" && U.devFakeVersion({ BLAVE_DEV_FAKE_UPDATE: "0.1.40" }, false) === "0.1.40" && U.devFakeVersion({}, false) === null && U.devFakeVersion(null, false) === null);
    t("main.js 拿 app.isPackaged 判,沒打包才換成假的", /const fake = require\("\.\/updater"\)\.devFakeVersion\(process\.env, app\.isPackaged\);/.test(src));
    let trading = false; const st = []; const f = U.createDevFake({ version: "9.9.9", currentVersion: "0.1.36", isTrading: () => trading, onState: (s) => st.push(s.phase) });
    t("假更新:沒在下單 ready、下單中 blocked;install 不真的重開(沒有 quitAndInstall)", f.state().phase === "ready" && ((trading = true), f.state().phase === "blocked") && f.install().error === "TRADING" && ((trading = false), f.install().ok === true)
      && !/quitAndInstall/.test(cut(fs.readFileSync(path.join(SHELL, "updater.js"), "utf8"), "function createDevFake("))); }

  finished = true;
  console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
})();
