// 雲端 tab 側欄的旗標與拖拉排序寫回(0.1.29;spec desktop-strat-flags-2026-10 §3 行為 1、7、8)。不起 Electron。
//   ① cloud.js setStratPrefs:只送有帶的那一鍵(+ token / app_secret,不帶 base_currency);壞形狀不打 api;
//      成功把值補進 snapshot;舊 api(400 BAD_CURRENCY)→ UNSUPPORTED、這個帳號之後不再送、換人才重試;429 / 5xx 下次照送
//   ② renderer stratflags.js 的雲端覆蓋層:api 那份(stale)上疊本機剛改的;300ms trailing debounce 一包、只帶改過的鍵、整份送;
//      寫失敗 / 舊 api → 覆蓋留著(fail-soft);成功且信封追上 → 放手、之後跟 api(網頁再改也跟得上);換帳號清掉
//      寫回成功時作廢在途的狀態請求(舊信封晚到不蓋回去);一次只送一包(前一包落地才送下一包);
//      epoch 對不上 / 鑰匙圈換人但信封還沒換 → NO_LOGIN 不送
//   ③ sfCloudHold:拖拉中擋重建、只排一次補畫;拖完 waiters 跑完
//   ④ 送出前修剪(清單完整時丟掉不存在的旗標名、≤200)、429 / 失敗補送一次、送出中又改過的鍵不放手;preload 只轉四個鍵
//   ⑤ 資料夾 strat_groups(spec strategy-sidebar-folders §3 舊 api):只帶 groups 回 BAD_CURRENCY → 只關資料夾寫回;帶了順序 → 200 但回應沒 strat_groups
//      → groupsOff、不標已同步(覆蓋留著,下一輪輪詢不把資料夾洗掉);關掉後順序與旗標照寫;換帳號重試;修剪只在清單完整時;刪策略清 map
// 跑法:node tests/check_shell_cloud_strat_prefs.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const SHELL = path.join(__dirname, "..", "shell"), R = path.join(SHELL, "renderer");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 600))); if (!c) red++; };
const J = JSON.stringify;
const sfSrc = fs.readFileSync(path.join(R, "stratflags.js"), "utf8");
const cut = (s, head) => { const i = s.indexOf(head); if (i < 0) throw new Error("no " + head); let d = 0; for (let k = s.indexOf("{", i); k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) return s.slice(i, s[k + 1] === ";" ? k + 2 : k + 1); } throw new Error("unbalanced " + head); };
const { createCloudHost, PREFS_ENDPOINT } = require(path.join(SHELL, "cloud.js"));
const env = (o) => ({ status: 200, body: Object.assign({ machine: { state: "running" }, portfolio: { config: {} }, portfolio_stale: false, strategies_summary: [], strat_order: ["a", "b"], strat_flags: { a: 1 } }, o || {}) });

(async () => {
  // ── ① cloud.js ──
  let creds = { token: "t", appSecret: "s", who: "u1" }, reply = null; const posts = [];
  const post = async (url, body) => {
    if (url.endsWith(PREFS_ENDPOINT)) { posts.push(body); return reply(body); }
    return env();
  };
  const h = createCloudHost({ apiBase: "https://x", getCreds: () => creds, post, now: () => Date.now(), setTimer: () => 0, clearTimer: () => {} });
  await h.refresh(true);
  const sp = (q) => h.setStratPrefs(q && typeof q === "object" && !Array.isArray(q) ? { ...q, epoch: h.snapshot().epoch } : q);
  reply = (b) => ({ status: 200, body: { status: "ok", ...(b.strat_flags ? { strat_flags: b.strat_flags } : {}), ...(b.strat_order ? { strat_order: b.strat_order } : {}) } });
  let r = await sp({ strat_flags: { b: 3 } });
  ok("① 只送 strat_flags 一鍵 + token / app_secret(沒有 base_currency、沒有 strat_order)", r.ok === true && posts.length === 1 && J(Object.keys(posts[0]).sort()) === J(["app_secret", "strat_flags", "token"]) && J(posts[0].strat_flags) === J({ b: 3 }), J({ r, posts }));
  ok("① 成功:snapshot 的 strat_flags 換上、strat_order 不動", J(h.snapshot().strat_flags) === J({ b: 3 }) && J(h.snapshot().strat_order) === J(["a", "b"]), J(h.snapshot()));
  r = await sp({ strat_order: ["b", "a"] });
  ok("① 只送 strat_order 一鍵", r.ok && J(Object.keys(posts[1]).sort()) === J(["app_secret", "strat_order", "token"]) && J(h.snapshot().strat_order) === J(["b", "a"]), J(posts[1]));
  const n0 = posts.length;
  const bad = [await sp({ strat_flags: { a: 9 } }), await sp({ strat_order: ["a", 3] }), await sp({ strat_flags: [1] }), await sp(null), await sp({ base_currency: "TWD" })];
  ok("① 壞形狀(旗標 9、名字非字串、flags 是陣列、null、只帶幣別)→ BAD,不打 api", bad.every((x) => x.ok === false && x.code === "BAD") && posts.length === n0, J(bad));
  reply = () => ({ status: 429, body: {} });
  r = await sp({ strat_order: ["a"] });
  reply = () => ({ status: 500 });
  const r5 = await sp({ strat_order: ["a"] });
  reply = () => ({ status: 400, body: { error_code: "BAD_STRAT_GROUPS" } });
  const r4 = await sp({ strat_order: ["a"] });
  ok("① 429 → RATE_LIMITED、500 → FAIL、其他 4xx → REJECTED(內容被拒,補送也一樣),三次都真的送了", r.code === "RATE_LIMITED" && r5.code === "FAIL" && r4.code === "REJECTED" && posts.length === n0 + 3);
  reply = () => ({ status: 400, body: { error_code: "BAD_CURRENCY", options: ["USD"] } });
  r = await sp({ strat_flags: { a: 2 } });
  const r2 = await sp({ strat_order: ["b"] });
  ok("① 舊 api(400 BAD_CURRENCY)→ UNSUPPORTED;之後同一個帳號不再送(不燒指令那一桶)", r.code === "UNSUPPORTED" && r2.code === "UNSUPPORTED" && posts.length === n0 + 4, J({ r, r2, n: posts.length - n0 }));
  ok("① 失敗不動 snapshot", J(h.snapshot().strat_order) === J(["b", "a"]) && J(h.snapshot().strat_flags) === J({ b: 3 }));
  h.reset(); creds = { token: "t2", appSecret: "s2", who: "u2" }; reply = () => ({ status: 200, body: { status: "ok" } });
  r = await sp({ strat_order: ["x"] });
  ok("① 換帳號(reset)後重新試(新部署的 api 或另一個人)", r.ok === true && posts.length === n0 + 5);
  creds = null;
  ok("① 沒登入 → NO_LOGIN,不打 api", (await sp({ strat_order: ["x"] })).code === "NO_LOGIN" && posts.length === n0 + 5);
  {
    // 寫回成功作廢在途的狀態請求 / 一次一包 / epoch 與換人
    let cr = { token: "t", appSecret: "s", who: "u1" }, serverPrefs = { strat_order: ["a", "b"], strat_flags: { a: 1 } }, stateGate = null, prefGate = null;
    const pp = [];
    const post2 = async (url, body) => {
      if (url.endsWith(PREFS_ENDPOINT)) {
        pp.push(body); if (prefGate) await prefGate;
        if (body.strat_order) serverPrefs = { ...serverPrefs, strat_order: body.strat_order };
        return { status: 200, body: { status: "ok", ...(body.strat_order ? { strat_order: body.strat_order } : {}), ...(body.strat_flags ? { strat_flags: body.strat_flags } : {}) } };
      }
      const old = serverPrefs; if (stateGate) await stateGate;   // 寫入前就送出的那一份:帶的是寫之前的偏好
      return env(old);
    };
    const g = createCloudHost({ apiBase: "https://x", getCreds: () => cr, post: post2, now: () => Date.now(), setTimer: () => 0, clearTimer: () => {} });
    await g.refresh(true);
    let open; stateGate = new Promise((res) => { open = res; });
    const inflight = g.refresh(true);
    const w = await g.setStratPrefs({ strat_order: ["b", "a"], epoch: g.snapshot().epoch });
    stateGate = null; open(); await inflight;
    ok("① 狀態請求在途時寫回成功,舊信封晚到 → snapshot 仍是新值(gen++ 作廢在途那份)", w.ok === true && J(g.snapshot().strat_order) === J(["b", "a"]), J({ w, o: g.snapshot().strat_order }));
    let rel; prefGate = new Promise((res) => { rel = res; });
    const ep = g.snapshot().epoch, A = g.setStratPrefs({ strat_order: ["a", "b"], epoch: ep }), B = g.setStratPrefs({ strat_order: ["b", "a", "c"], epoch: ep });
    await new Promise((res) => setTimeout(res, 5));
    const before = pp.length;
    prefGate = null; rel(); const ra = await A, rb = await B;
    ok("① 一次只送一包:第一包落地前第二包不送;落地順序 = 送出順序,伺服器留最後那包", before === 2 && ra.ok && rb.ok && pp.length === 3
      && J(pp[1].strat_order) === J(["a", "b"]) && J(pp[2].strat_order) === J(["b", "a", "c"]) && J(serverPrefs.strat_order) === J(["b", "a", "c"]), J({ before, n: pp.length, s: serverPrefs }));
    const n1 = pp.length;
    const e1 = await g.setStratPrefs({ strat_order: ["a"], epoch: ep + 1 }), e2 = await g.setStratPrefs({ strat_order: ["a"] });
    cr = { token: "t9", appSecret: "s9", who: "u9" };   // 鑰匙圈換人了,輪詢還沒 drop(信封仍是 u1 的)
    const e3 = await g.setStratPrefs({ strat_order: ["a"], epoch: ep });
    ok("① epoch 對不上 / 沒帶 epoch / 鑰匙圈換人但信封還是上一個人的 → NO_LOGIN,不打 api", [e1, e2, e3].every((x) => x.code === "NO_LOGIN") && pp.length === n1, J([e1, e2, e3]));
  }

  // ── ② renderer 覆蓋層 ──
  const timers = [], sent = [], epochs = []; let answer = { ok: true, code: "OK" };
  const ctx = {
    console, JSON, Object, Promise, Date,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    $: () => ({}), t: (k) => k, sfPopClose: () => {},
    window: { blave: { cloudStratPrefsSet: (p) => { const c = JSON.parse(J(p)); epochs.push(c.epoch); delete c.epoch; sent.push(c); return typeof answer === "function" ? answer() : Promise.resolve(answer); } } },
  };
  vm.runInNewContext([
    "const SF = { dragActive: false, waiters: [], popStore: null };",
    /^const SF_SAVE_MS = .*$/m.exec(sfSrc)[0], /^const SF_RETRY_MS = .*$/m.exec(sfSrc)[0],
    /^const SFC = .*$/m.exec(sfSrc)[0], /^const SFC_KEYS = .*$/m.exec(sfSrc)[0], /^const sgEditing = .*$/m.exec(sfSrc)[0],
    cut(sfSrc, "function sfApplyOrder("), cut(sfSrc, "function sfCloudPrefs("), cut(sfSrc, "function sfCloudSave("), cut(sfSrc, "function sfCloudArm("), cut(sfSrc, "function sfCloudTrim("), cut(sfSrc, "function sfCloudFlush("), cut(sfSrc, "function sfCloudForget("),
    cut(sfSrc, "const SF_CLOUD = {"), cut(sfSrc, "function sfCloudHold("),
    "this.SF = SF; this.SFC = SFC; this.SF_CLOUD = SF_CLOUD; this.prefs = sfCloudPrefs; this.apply = sfApplyOrder; this.forget = sfCloudForget; this.hold = sfCloudHold;",
  ].join("\n"), ctx);
  const flush = async () => { const due = timers.splice(0); due.forEach((x) => x.fn && x.fn()); await new Promise((res) => setTimeout(res, 0)); };
  const L = (...n) => n.map((name) => ({ name })), names = (l) => l.map((x) => x.name).join();
  let snap = { epoch: 1, fetched_at: 100, strat_order: ["b", "a"], strat_flags: { a: 1 } };
  let p = ctx.prefs(snap);
  const OF = (x) => J({ order: x.order, flags: x.flags });
  ok("② 沒改過 = api 那一份;套序 order 內的先、新策略 append", OF(p) === J({ order: ["b", "a"], flags: { a: 1 } }) && J(p.groups) === '{"v":1,"folders":[],"map":{}}' && names(ctx.apply(L("a", "b", "c"), p.order)) === "b,a,c", J(p));
  ctx.SF_CLOUD.moved(["c", "a", "b"]); ctx.SF_CLOUD.setFlag("b", 3); ctx.SF_CLOUD.setFlag("a", null);
  p = ctx.prefs(snap);
  ok("② 剛拖 / 剛掛:舊信封上疊本機值(重畫不跳回去)", OF(p) === J({ order: ["c", "a", "b"], flags: { b: 3 } }) && names(ctx.apply(L("a", "b", "c"), p.order)) === "c,a,b", J(p));
  ok("② debounce:300ms 之前一包都沒送", sent.length === 0 && timers.filter((x) => x.fn).length === 1 && timers.filter((x) => x.fn)[0].ms === 300);
  await flush();
  ok("② 300ms 後一包、帶兩個改過的鍵、整份送;帶信封的 epoch", sent.length === 1 && J(sent[0]) === J({ strat_order: ["c", "a", "b"], strat_flags: { b: 3 } }) && epochs[0] === 1, J({ sent, epochs }));
  ok("② 成功但信封還沒追上 → 照覆蓋畫", J(ctx.prefs(snap).flags) === J({ b: 3 }));
  snap = { ...snap, strat_order: ["c", "a", "b"], strat_flags: { b: 3 } };
  ctx.prefs(snap);
  ok("② 信封追上(值相同)→ 放手", !("order" in ctx.SFC.over) && !("flags" in ctx.SFC.over), J(ctx.SFC.over));
  snap = { ...snap, fetched_at: 200, strat_flags: { c: 2 } };
  ok("② 放手之後網頁再改 → 跟 api", J(ctx.prefs(snap).flags) === J({ c: 2 }));
  ctx.SF_CLOUD.setFlag("a", 1); await flush();
  ok("② 只改旗標 → 那一包只帶 strat_flags", J(sent[1]) === J({ strat_flags: { c: 2, a: 1 } }), J(sent[1]));
  answer = { ok: false, code: "UNSUPPORTED" };
  ctx.SF_CLOUD.moved(["a", "b", "c"]); await flush();
  snap = { ...snap, fetched_at: 99999 };
  ok("② 舊 api / 寫失敗 → 不回滾:之後的信封(再新也一樣)照畫本機值", J(ctx.prefs(snap).order) === J(["a", "b", "c"]) && J(sent[2]) === J({ strat_order: ["a", "b", "c"] }), J({ p: ctx.prefs(snap), s: sent[2] }));
  answer = { ok: true, code: "OK" };
  ctx.SF_CLOUD.setFlag("b", 2); ctx.forget("b"); await flush();
  ok("② 刪除成功清名字:order 與 flags 都拿掉、跟還沒送的旗標併成一包", sent.length === 4 && J(sent[3]) === J({ strat_flags: { c: 2, a: 1 }, strat_order: ["a", "c"] }), J(sent.slice(3)));
  ctx.SF_CLOUD.setFlag("z", 2);
  ok("② 沒有信封(還沒第一份)不算換帳號:覆蓋不清", J(ctx.prefs({}).flags) === J({ c: 2, a: 1, z: 2 }) && J(ctx.prefs(undefined).flags) === J({ c: 2, a: 1, z: 2 })
    && J(ctx.SF_CLOUD.flags()) === J({ c: 2, a: 1, z: 2 }), J({ p: ctx.prefs({}), cur: ctx.SF_CLOUD.flags() }));
  ok("② 換帳號(epoch 變了)→ 覆蓋清掉、還沒送的那包作廢", OF(ctx.prefs({ epoch: 2, strat_order: [], strat_flags: {} })) === J({ order: [], flags: {} }) && timers.every((x) => !x.fn));
  // ── ④ 修剪 / 補送 / 送出中又改 ──
  answer = { ok: true, code: "OK" }; sent.length = 0; timers.length = 0;
  snap = { epoch: 2, fetched_at: 300, strat_order: [], strat_flags: { a: 1, gone: 2 }, strategies_ok: true, strategies_partial: false, strategies: [{ name: "a" }, { name: "b" }] };
  ctx.prefs(snap); ctx.SF_CLOUD.setFlag("b", 3); await flush();
  ok("④ 清單完整:送出前丟掉已不存在的策略的旗標(覆蓋本身不動)", J(sent[0]) === J({ strat_flags: { a: 1, b: 3 } }) && "gone" in ctx.SFC.over.flags, J(sent[0]));
  const many = {}; for (let i = 0; i < 250; i++) many["s" + i] = 1;
  ctx.prefs({ ...snap, epoch: 22, fetched_at: 400, strat_flags: many, strategies_partial: true }); ctx.SF_CLOUD.setFlag("a", 2); await flush();
  ok("④ 清單讀不全:不濾名字(不吃真的旗標),但截到 200(不然主行程永遠 BAD)", Object.keys(sent[1].strat_flags).length === 200 && sent[1].strat_flags.s0 === 1, Object.keys(sent[1].strat_flags).length);
  ctx.prefs({ ...snap, epoch: 3, fetched_at: 500, strat_flags: {} }); sent.length = 0; timers.length = 0;
  answer = { ok: false, code: "RATE_LIMITED" };
  ctx.SF_CLOUD.setFlag("a", 1); await flush();
  ok("④ 429 → 排一次 5 秒後的補送", sent.length === 1 && timers.filter((x) => x.fn).length === 1 && timers.filter((x) => x.fn)[0].ms === 5000, J(timers.map((x) => [!!x.fn, x.ms])));
  answer = { ok: false, code: "FAIL" }; await flush();
  ok("④ 補送同一包;再失敗不再排(只補一次)", sent.length === 2 && J(sent[1]) === J(sent[0]) && timers.every((x) => !x.fn), J({ sent, t: timers.map((x) => [!!x.fn, x.ms]) }));
  answer = { ok: false, code: "UNSUPPORTED" }; ctx.SF_CLOUD.setFlag("b", 2); await flush();
  ok("④ 舊 api / NO_LOGIN 不補送", sent.length === 3 && timers.every((x) => !x.fn));
  answer = { ok: false, code: "REJECTED" }; ctx.SF_CLOUD.setFlag("b", 3); await flush();
  ok("④ 4xx 被拒(REJECTED)不補送(同網頁:只補 429 / 5xx / 連不上)", sent.length === 4 && timers.every((x) => !x.fn));
  let resolveA; answer = () => new Promise((res) => { resolveA = res; });
  ctx.SF_CLOUD.setFlag("a", 3); const due = timers.splice(0); due.forEach((x) => x.fn && x.fn());
  answer = { ok: true, code: "OK" };
  ctx.SF_CLOUD.setFlag("a", 2);   // 第一包還在路上又改了
  resolveA({ ok: true, code: "OK" }); await new Promise((res) => setTimeout(res, 0));
  ok("④ 送出中又改過的鍵:第一包成功也不放手(下一包還沒送)", !ctx.SFC.syncedAt.flags && J(ctx.prefs({ ...snap, epoch: 3, fetched_at: 99999, strat_flags: { a: 3 } }).flags.a) === "2", J({ s: ctx.SFC.syncedAt, f: ctx.SFC.over.flags }));
  { const preSrc = fs.readFileSync(path.join(SHELL, "preload.js"), "utf8"), calls = []; let api = null;
    vm.runInNewContext(preSrc, { require: () => ({ contextBridge: { exposeInMainWorld: (_n, o) => { api = o; } }, ipcRenderer: { invoke: (...a) => { calls.push(a); return Promise.resolve(); }, on: () => {}, send: () => {}, removeListener: () => {} } }),
      process: { platform: "darwin", argv: [] }, console });
    api.cloudStratPrefsSet({ strat_order: ["a"], strat_flags: { a: 1 }, epoch: 4, token: "x", app_secret: "y", base_currency: "TWD" });
    api.cloudStratPrefsSet({ strat_groups: { v: 1, folders: [], map: {} }, epoch: 4 });
    ok("④ preload 只轉 strat_order / strat_flags / strat_groups / epoch 四個鍵到 cloud-strat-prefs", calls.length === 2 && calls[0][0] === "cloud-strat-prefs" && J(Object.keys(calls[0][1]).sort()) === J(["epoch", "strat_flags", "strat_groups", "strat_order"])
      && J(calls[1][1].strat_groups) === '{"v":1,"folders":[],"map":{}}', J(calls)); }
  // ── ⑤ 資料夾 ──
  {
    const GR = (map) => ({ v: 1, folders: [{ id: "fok0001", name: "主力", emoji: "🪙" }], map: map || { a: "fok0001" } });
    let cr = { token: "t", appSecret: "s", who: "u1" }, rep = null; const pp = [];
    const post3 = async (url, body) => (url.endsWith(PREFS_ENDPOINT) ? (pp.push(body), rep(body)) : env());
    const k = createCloudHost({ apiBase: "https://x", getCreds: () => cr, post: post3, now: () => Date.now(), setTimer: () => 0, clearTimer: () => {} });
    await k.refresh(true);
    const sg = (q) => k.setStratPrefs({ ...q, epoch: k.snapshot().epoch });
    rep = (b) => ({ status: 200, body: { status: "ok", ...(b.strat_groups ? { strat_groups: { ...b.strat_groups, map: {} } } : {}) } });
    let r = await sg({ strat_groups: GR() });
    ok("⑤ 新 api:只送 strat_groups 一鍵(不認得的 emoji 原樣送,權威在 api);snapshot 換成 api 回的清過值", r.ok === true && !r.groupsOff && J(Object.keys(pp[0]).sort()) === J(["app_secret", "strat_groups", "token"])
      && pp[0].strat_groups.folders[0].emoji === "🪙" && J(k.snapshot().strat_groups.map) === "{}", J({ r, s: k.snapshot().strat_groups }));
    const n0 = pp.length;
    const bad = [await sg({ strat_groups: { v: 1, folders: [{ id: "fok0001", name: "x", emoji: "123456789" }], map: {} } }), await sg({ strat_groups: { v: 2, folders: [], map: {} } }), await sg({ strat_groups: { folders: "x", map: {} } })];
    ok("⑤ 形狀不對(emoji 過長、v 不是 1、folders 不是陣列)→ BAD,不打 api", bad.every((x) => x.code === "BAD") && pp.length === n0, J(bad));
    // 舊 api 第一種:只帶 groups → 400 BAD_CURRENCY
    rep = (b) => (b.strat_order || b.strat_flags ? { status: 200, body: { status: "ok", ...(b.strat_order ? { strat_order: b.strat_order } : {}) } } : { status: 400, body: { error_code: "BAD_CURRENCY" } });
    r = await sg({ strat_groups: GR() });
    const r2 = await sg({ strat_groups: GR() });
    ok("⑤ 舊 api(只帶 groups → 400 BAD_CURRENCY):UNSUPPORTED,之後只帶 groups 不再送", r.code === "UNSUPPORTED" && r2.code === "UNSUPPORTED" && pp.length === n0 + 1, J({ r, r2, n: pp.length - n0 }));
    r = await sg({ strat_order: ["b", "a"], strat_groups: GR() });
    ok("⑤ 資料夾關了、順序照寫:body 拿掉 strat_groups(不設 stratPrefsOff)", r.ok === true && !("strat_groups" in pp[pp.length - 1]) && J(pp[pp.length - 1].strat_order) === J(["b", "a"]), J(pp[pp.length - 1]));
    k.reset(); cr = { token: "t2", appSecret: "s2", who: "u2" }; await k.refresh(true);
    // 舊 api 第二種:帶了順序 → 200、靜默丟掉 groups(回應沒有 strat_groups 鍵)
    const before = J(k.snapshot().strat_groups);
    r = await sg({ strat_order: ["a"], strat_groups: GR() });
    ok("⑤ 換帳號後重試;舊 api 第二種(帶順序 → 200 沒回 strat_groups):ok + groupsOff、snapshot 的資料夾不動", r.ok === true && r.groupsOff === true && "strat_groups" in pp[pp.length - 1] && J(k.snapshot().strat_groups) === before, J({ r, s: k.snapshot().strat_groups }));
    const n1 = pp.length, r3 = await sg({ strat_groups: GR() }), r4 = await sg({ strat_flags: { a: 1 }, strat_groups: GR() });
    ok("⑤ groupsOff 之後:只帶 groups → UNSUPPORTED 不送;帶旗標照送、不帶 groups", r3.code === "UNSUPPORTED" && r4.ok === true && pp.length === n1 + 1 && !("strat_groups" in pp[n1]), J({ r3, r4 }));
    // 更舊的 api:連順序都不收(BAD_CURRENCY)→ 整個關(既有行為)
    k.reset(); cr = { token: "t3", appSecret: "s3", who: "u3" }; await k.refresh(true);
    rep = () => ({ status: 400, body: { error_code: "BAD_CURRENCY" } });
    r = await sg({ strat_order: ["a"], strat_groups: GR() });
    const n2 = pp.length, r5 = await sg({ strat_order: ["b"] });
    ok("⑤ 帶了順序也 BAD_CURRENCY(連順序都不收的 api):整個關掉,之後順序也不送", r.code === "UNSUPPORTED" && r5.code === "UNSUPPORTED" && pp.length === n2);
  }
  {
    // renderer 覆蓋層:送出、修剪、groupsOff 不放手、刪策略清 map
    sent.length = 0; timers.length = 0; answer = { ok: true, code: "OK" };
    const full = { epoch: 7, fetched_at: 1000, strat_order: [], strat_flags: {}, strat_groups: { v: 1, folders: [], map: {} }, strategies_ok: true, strategies_partial: false, strategies: [{ name: "a" }, { name: "b" }] };
    ctx.prefs(full);
    const G1 = { v: 1, folders: [{ id: "fok0001", name: "主力", emoji: "⭐" }], map: { a: "fok0001", gone: "fok0001" } };
    ctx.SF_CLOUD.setGroups(G1); await flush();
    ok("⑤ setGroups → 300ms 後一包 strat_groups;清單完整時 map 丟掉不存在的策略(覆蓋本身不動)", sent.length === 1 && J(sent[0]) === J({ strat_groups: { v: 1, folders: G1.folders, map: { a: "fok0001" } } }) && "gone" in ctx.SFC.over.groups.map, J(sent));
    ctx.prefs({ ...full, epoch: 8, strategies_partial: true }); sent.length = 0;
    ctx.SF_CLOUD.setGroups(G1); await flush();
    ok("⑤ 清單讀不全(strategies_partial):不修剪 map(不吃真的歸屬)", J(sent[0].strat_groups.map) === J({ a: "fok0001", gone: "fok0001" }), J(sent[0]));
    ctx.prefs({ ...full, epoch: 9, strategies: [] }); sent.length = 0;
    ctx.SF_CLOUD.setGroups(G1); await flush();
    ok("⑤ 主機停機 / 清單空:不修剪", J(sent[0].strat_groups.map) === J({ a: "fok0001", gone: "fok0001" }));
    answer = { ok: true, code: "OK", groupsOff: true }; sent.length = 0;
    ctx.prefs({ ...full, epoch: 10 }); ctx.SF_CLOUD.setGroups(G1); ctx.SF_CLOUD.moved(["b", "a"]); await flush();
    const later = ctx.prefs({ ...full, epoch: 10, fetched_at: 999999, strat_order: ["b", "a"] });
    ok("⑤ 回 groupsOff:順序照常放手、資料夾不標已同步——之後更新的信封(沒有資料夾)也照畫本機的資料夾", !ctx.SFC.syncedAt.groups && "groups" in ctx.SFC.over && !("order" in ctx.SFC.over) && J(later.groups.folders) === J(G1.folders), J({ s: ctx.SFC.syncedAt, g: later.groups }));
    answer = { ok: true, code: "OK" }; sent.length = 0;
    ctx.prefs({ ...full, epoch: 11, strat_groups: { v: 1, folders: G1.folders, map: { a: "fok0001", b: "fok0001" } } });
    ctx.forget("a"); await flush();
    ok("⑤ 刪策略成功:map 拿掉那個名字", J(sent[0].strat_groups.map) === J({ b: "fok0001" }) && !("a" in ctx.SFC.cur.groups.map), J(sent));
    ctx.SF.dragActive = false;
  }
  // ── ③ sfCloudHold ──
  let repaints = 0;
  ctx.SF.dragActive = true;
  const h1 = ctx.hold(() => repaints++), h2 = ctx.hold(() => repaints++);
  ctx.SF.dragActive = false; ctx.SF.waiters.splice(0).forEach((w) => w());
  ok("③ 拖拉中:擋重建、只排一次補畫;拖完補畫一次;不拖時不擋", h1 === true && h2 === true && repaints === 1 && ctx.hold(() => repaints++) === false && repaints === 1, J({ h1, h2, repaints }));

  console.log(red ? `\n${red} 紅` : "\n全綠");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  例外 " + (e && e.stack)); process.exit(1); });
