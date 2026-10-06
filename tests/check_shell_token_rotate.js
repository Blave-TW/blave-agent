// 帳號 token 輪替(shell/tokenrotate.js + main.js 的接線)。不打真的 api:post 接到一個照 api desktop_rotate 語意寫的假伺服器
// (現值 / 寬限內舊值 / 撤銷 / 503 / 連不上),時鐘是假的。
// 釘住:同時觸發只送一次;503 與連不上不登出、稍後再試;新值被拒時拿寬限內的舊值補救;沒有期限的舊 token 一開就換;
// 登出 / 重新登入清掉寬限舊值並作廢在途的回應;輪替後雲端模組不把同一個人當成換了人。
// 跑法:node tests/check_shell_token_rotate.js
const fs = require("fs"), os = require("os"), path = require("path");
const SHELL = path.join(__dirname, "..", "shell");
const R = require(path.join(SHELL, "tokenrotate.js"));
let red = 0; const t = (n, ok, d) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || d === undefined ? "" : "  " + JSON.stringify(d))); if (!ok) red++; };
const H = 3600 * 1000;
let seq = 0; const mint = () => "acct-" + String(++seq).padStart(4, "0") + "x".repeat(40);

/* 假 api:同 desktop_rotate。hold = true 時請求停在半路,release() 才回 */
function fakeApi(start) {
  const s = { cur: start, prev: null, prevUntil: 0, revoked: false, mode: "ok", posts: [], held: [], hold: false };
  s.handle = (b) => {
    if (s.mode === "503") return { status: 503, body: { error_code: "ROTATE_UNAVAILABLE" } };
    if (s.mode === "throw") throw new Error("ECONNRESET");
    if (s.revoked || b.app_secret !== "appsec-1") return { status: 401, body: { error_code: "INVALID_CREDENTIALS" } };
    const nt = mint();
    if (b.token === s.cur) { s.prev = s.cur; s.prevUntil = s.clock() + R.GRACE_MS; s.cur = nt; }
    else if (b.token === s.prev && s.clock() < s.prevUntil) { s.cur = nt; }
    else return { status: 401, body: { error_code: "INVALID_CREDENTIALS" } };
    return { status: 200, body: { access_token: nt, token_type: "bearer", expires_in: 86400 } };
  };
  s.post = async (u, b) => {
    s.posts.push({ u, b });
    if (s.hold) await new Promise((r) => s.held.push(r));
    return s.handle(b);
  };
  s.release = () => { const h = s.held.splice(0); h.forEach((r) => r()); };
  return s;
}
function world(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rot-"));
  const w = { clock: 1e12, token: o.token === undefined ? mint() : o.token, secret: o.secret === undefined ? "appsec-1" : o.secret, saveOk: true, saves: 0, hooks: [] };
  w.api = fakeApi(w.token); w.api.clock = () => w.clock;
  w.rot = R.createRotator({ dir, apiBase: "https://api.test", post: w.api.post, now: () => w.clock,
    loadToken: () => (w.readNull ? null : w.token), saveToken: (v) => { w.saves++; if (w.saveThrow) throw new Error("ENOSPC"); if (!w.saveOk) return false; w.token = v; return true; },
    loadSecret: () => w.secret, beforeSave: () => w.hooks.push("before:" + w.token), afterSave: () => w.hooks.push("after:" + w.token) });
  w.expFile = path.join(dir, R.EXP_FILE);
  w.writeExp = (tok, ms) => fs.writeFileSync(w.expFile, JSON.stringify({ fp: require("crypto").createHash("sha256").update(tok).digest("hex").slice(0, 16), exp: w.clock + ms }));
  return w;
}
const tick = () => new Promise((r) => setImmediate(r));
process.exitCode = 1;   // 哪個 await 掛住、事件迴圈空了就會靜靜地以 0 結束:沒跑到最後一行不算過

(async () => {
  // ── 沒有期限的舊 token(0.1.15 以前)一開就換;舊值進寬限、寬限過後伺服器不認 ──
  { const w = world(), old = w.token;
    const r = await w.rot.ensure(12 * H);
    t("沒有期限檔 → 輪替;送的是 token + app_secret、打 /oauth/desktop/rotate", r === "rotated" && w.api.posts.length === 1
      && w.api.posts[0].u === "https://api.test/oauth/desktop/rotate" && w.api.posts[0].b.token === old && w.api.posts[0].b.app_secret === "appsec-1", { r, posts: w.api.posts });
    t("存的是新值,伺服器的現值 = 本機存的", w.token !== old && w.token === w.api.cur);
    t("期限檔記的是新 token 的指紋與 24 小時", (() => { const j = JSON.parse(fs.readFileSync(w.expFile, "utf8")); return j.exp === w.clock + 86400 * 1000; })());
    t("換檔前後的掛勾各叫一次(連結紀錄 reseal 靠它)", w.hooks.length === 2 && w.hooks[0] === "before:" + old && w.hooks[1] === "after:" + w.token, w.hooks);
    t("舊值在寬限內伺服器還認(prev)、寬限後不認", w.api.prev === old && w.api.prevUntil === w.clock + R.GRACE_MS);
    t("剛換完再檢查 → fresh,不送", (await w.rot.ensure(12 * H)) === "fresh" && w.api.posts.length === 1);
    w.clock += 13 * H;
    t("剩不到 12 小時 → 再換", (await w.rot.ensure(12 * H)) === "rotated" && w.api.posts.length === 2); }

  { const w = world(); w.writeExp(mint(), 20 * H);
    t("期限檔是別顆 token 的(指紋對不上)→ 當沒有期限、輪替", (await w.rot.ensure(12 * H)) === "rotated"); }
  { const w = world(); w.writeExp(w.token, 20 * H);
    t("這顆的期限還有 20 小時 → 不送", (await w.rot.ensure(12 * H)) === "fresh" && w.api.posts.length === 0); }
  { const w = world(); fs.writeFileSync(w.expFile, "{not json");
    t("期限檔壞掉 → 當沒有期限、輪替", (await w.rot.ensure(12 * H)) === "rotated"); }

  // ── 序列化:同時觸發只送一次 ──
  { const w = world(); w.api.hold = true; const old = w.token;
    const ps = [w.rot.ensure(12 * H), w.rot.ensure(12 * H), w.rot.ensure(1), w.rot.recover(old), w.rot.ensure(12 * H)];
    await tick();
    t("五個同時觸發,在途只有一個 rotate", w.api.posts.length === 1 && w.rot.state().inflight, w.api.posts.length);
    w.api.release(); const rs = await Promise.all(ps);
    t("全部共用同一個結果;伺服器現值 = 本機存的(沒有被第二支擠掉)", w.api.posts.length === 1 && w.token === w.api.cur && rs.slice(0, 3).every((x) => x === "rotated") && rs[3] === true, rs); }

  // ── 503 / 連不上:照用現有 token、不登出、稍後再試 ──
  { const w = world(), old = w.token; w.api.mode = "503";
    const r = await w.rot.ensure(12 * H);
    t("503 ROTATE_UNAVAILABLE → token 不動、沒有存檔(不清不登出)", r === "unavailable" && w.token === old && w.saves === 0);
    t("503 後退讓 30 分鐘:這段期間不再送", (await w.rot.ensure(12 * H)) === "skipped" && w.api.posts.length === 1 && w.rot.state().backoffMs === R.UNAVAILABLE_MS);
    w.clock += R.UNAVAILABLE_MS; w.api.mode = "ok";
    t("退讓過後再試,SQL 跑完就換得到", (await w.rot.ensure(12 * H)) === "rotated" && w.api.posts.length === 2 && w.token !== old); }
  { const w = world(), old = w.token; w.api.mode = "throw";
    const r = await w.rot.ensure(12 * H);
    t("連不上 → token 不動、不清、退讓 5 分鐘", r === "retry" && w.token === old && w.saves === 0 && w.rot.state().backoffMs === R.BACKOFF_MS);
    w.clock += R.BACKOFF_MS; w.api.mode = "ok";
    t("5 分鐘後再試成功", (await w.rot.ensure(12 * H)) === "rotated"); }
  { const w = world(), old = w.token; w.api.revoked = true;
    t("401(撤銷了)→ token 不動、不清;這顆不再自動重試", (await w.rot.ensure(12 * H)) === "auth" && w.token === old && w.saves === 0
      && (await w.rot.ensure(12 * H)) === "skipped" && w.api.posts.length === 1); }
  { const w = world({ secret: null });
    t("沒有 app_secret(很舊的登入)→ 不送、token 不動", (await w.rot.ensure(12 * H)) === "no_secret" && w.api.posts.length === 0); }

  // ── 新值寫不進 Keychain:伺服器把檔裡那顆當寬限舊值,稍後拿它再換 ──
  { const w = world(), old = w.token; w.saveOk = false;
    const r = await w.rot.ensure(12 * H);
    t("新值存不進去 → 檔裡還是舊的、短退讓", r === "save_failed" && w.token === old && w.rot.state().backoffMs > 0);
    w.saveOk = true; w.clock += 61 * 1000;
    const r2 = await w.rot.ensure(12 * H);
    t("一分鐘後拿舊值再換:伺服器走寬限分支發新的,本機存的 = 伺服器現值", r2 === "rotated" && w.api.posts[1].b.token === old && w.token === w.api.cur, { r2 }); }

  { const w = world(), old = w.token; w.saveThrow = true;   // 稽核 P1:writeFileSync 中途拋(磁碟滿 / 防毒鎖檔)
    const r = await w.rot.ensure(12 * H);
    t("saveToken 拋例外 → 當 save_failed:檔裡還是舊的、短退讓,不穿出去", r === "save_failed" && w.token === old && w.rot.state().backoffMs === R.SAVE_RETRY_MS && w.api.cur !== old, { r });
    t("退讓期間不再送", (await w.rot.ensure(12 * H)) === "skipped" && w.api.posts.length === 1);
    w.saveThrow = false; w.clock += R.SAVE_RETRY_MS + 1;
    t("一分鐘後拿寬限內的舊值再換成功,本機存的 = 伺服器現值", (await w.rot.ensure(12 * H)) === "rotated" && w.api.posts[1].b.token === old && w.token === w.api.cur); }

  // ── Keychain 那一刻讀不到(稽核 P2):不是換了人,不當 stale 丟掉;一分鐘後拿寬限舊值再換 ──
  { const w = world(), old = w.token; w.api.hold = true;
    const p = w.rot.ensure(12 * H); await tick();
    w.readNull = true; w.api.hold = false; w.api.release(); const r = await p;
    t("200 回來時 loadToken 回 null → unreadable:不存、不當 stale、短退讓", r === "unreadable" && w.saves === 0 && w.token === old && w.rot.state().backoffMs === R.SAVE_RETRY_MS, { r });
    w.readNull = false;
    t("退讓期間不再送", (await w.rot.ensure(12 * H)) === "skipped" && w.api.posts.length === 1);
    w.clock += R.SAVE_RETRY_MS + 1;
    t("一分鐘後拿檔裡那顆(伺服器的寬限舊值)再換成功", (await w.rot.ensure(12 * H)) === "rotated" && w.api.posts[1].b.token === old && w.token === w.api.cur); }
  { const w = world(); w.api.hold = true;
    const p = w.rot.ensure(12 * H); await tick();
    w.token = mint(); w.api.release();
    t("真的換了顆(重新登入)仍是 stale,不退讓", (await p) === "stale" && w.rot.state().backoffMs === 0); }

  // ── 登出前 pause(稽核 P2):撤銷等網路的這段期間 ensure / recover 都不送;reset 解除 ──
  { const w = world(), cur = w.token; w.rot.pause();
    t("pause 後 ensure 不送(回 paused)、recover 回 false 不送", (await w.rot.ensure(12 * H)) === "paused" && (await w.rot.recover(cur)) === false && w.api.posts.length === 0 && w.rot.state().paused === true);
    w.rot.reset();
    t("reset 解除暫停,之後照常輪替", w.rot.state().paused === false && (await w.rot.ensure(12 * H)) === "rotated"); }

  // ── 新值第一次被拒:拿寬限內的舊值補救;每顆只補救一次 ──
  { const w = world(), A = w.token;
    await w.rot.ensure(12 * H); const B = w.token;
    w.api.cur = "acct-someoneelse" + "z".repeat(40);   // 伺服器的現值不是我們存的 B(例:回應沒收到時又被換過)
    const ok = await w.rot.recover(B);
    t("B 被拒 → 送的是寬限內的舊值 A,換到新的 C", ok === true && w.api.posts[1].b.token === A && w.token !== B && w.token === w.api.cur, w.api.posts.map((p) => p.b.token));
    const C = w.token; w.api.revoked = true;
    t("C 也被拒(撤銷)→ 補救一次換不到就停,不登出", (await w.rot.recover(C)) === false && w.token === C);
    t("同一顆不重複補救", (await w.rot.recover(C)) === false && w.api.posts.length === 3);
    t("被拒的那顆已經換掉了 → 直接算補救成功、不送", (await w.rot.recover(B)) === true && w.api.posts.length === 3); }
  { const w = world(); await w.rot.ensure(12 * H); const B = w.token;
    w.clock += R.GRACE_MS + 1;
    t("寬限過了 → 拿被拒的那顆自己換(過期未撤銷換得動)", (await w.rot.recover(B)) === true && w.api.posts[1].b.token === B); }

  // ── 登出 / 重新登入:清掉寬限舊值、作廢在途、刪期限檔 ──
  { const w = world(); await w.rot.ensure(12 * H);
    t("換完之後記憶體裡有寬限舊值", w.rot.state().prev === true && fs.existsSync(w.expFile));
    w.rot.reset();
    t("reset → 寬限舊值與期限檔都清掉", w.rot.state().prev === false && !fs.existsSync(w.expFile)); }
  { const w = world(); w.api.hold = true; const old = w.token;
    const p = w.rot.ensure(12 * H); await tick();
    w.rot.reset(); w.token = null;   // 在途時登出
    w.api.release(); const r = await p;
    t("在途時登出 → 回來的新值不存(不會把 token 寫回已登出的電腦)", r === "stale" && w.token === null && w.saves === 0 && old); }
  { const w = world(); w.api.hold = true;
    const p = w.rot.ensure(12 * H); await tick();
    w.token = mint();   // 在途時重新登入成另一顆
    const relog = w.token; w.api.release();
    t("在途時換了 token → 回來的值不蓋掉新登入的那顆", (await p) === "stale" && w.token === relog && w.saves === 0); }
  { const w = world(); w.api.hold = true;
    const p = w.rot.ensure(12 * H); await tick();
    let settled = false; const s = w.rot.settle().then(() => { settled = true; });
    await tick();
    t("settle 等在途的 rotate 落地(登出前叫:撤的是換完那顆)", settled === false);
    w.api.release(); await p; await s;
    t("落地後 settle 才回", settled === true && w.token === w.api.cur); }
  { const w = world(); w.rot.noteLogin(w.token, 86400);
    t("登入回應有 expires_in → 記期限(不必輪替)", (await w.rot.ensure(12 * H)) === "fresh");
    w.rot.noteLogin(w.token, undefined);
    t("登入回應沒有 expires_in(舊 api / SQL 沒跑)→ 不編期限,下次照舊式 token 輪替", !fs.existsSync(w.expFile) && (await w.rot.ensure(12 * H)) === "rotated"); }

  t("回應的 access_token 形狀不對 → 不存", await (async () => { const w = world(), old = w.token;
    w.api.handle = () => ({ status: 200, body: { access_token: "acct-\nevil", expires_in: 86400 } });
    const r = await w.rot.ensure(12 * H); return r === "retry" && w.token === old && w.saves === 0; })());

  // ── 身分:輪替換 token 但不換 who;雲端模組不把同一個人當成換了人 ──
  t("whoOf:有 who 用 who、沒有退回 token、沒 token 是 null", R.whoOf({ token: "a", who: "w" }) === "w" && R.whoOf({ token: "a" }) === "a" && R.whoOf(null) === null && R.whoOf({ who: "w" }) === null);
  { const CMD = require(path.join(SHELL, "cloudcmd.js"));
    let creds = { token: "acct-OLD", appSecret: "appsec-1", who: "W1" }, release; const gate = new Promise((r) => { release = r; });
    const c = CMD.createCloudCmd({ apiBase: "https://x", now: () => 0, getCreds: () => creds, setTimer: (fn) => { fn(); return 0; },
      post: async (u) => { if (u.indexOf("/ack") < 0) { await gate; return { status: 200, body: { status: "queued", id: "9b1c" + "0".repeat(28) } }; }
        return { status: 200, body: { status: "done", ok: true, result: { halted: true } } }; } });
    const p = c.send("halt", {}); await tick();
    creds = { token: "acct-NEW", appSecret: "appsec-1", who: "W1" };   // 回應在路上時 token 輪替了
    release(); const r = await p;
    t("雲端指令在途時 token 輪替 → 照樣拿到回條(不是 ACCOUNT_CHANGED/結果不明)", r.ok === true, r); }
  { const CMD = require(path.join(SHELL, "cloudcmd.js"));
    let creds = { token: "acct-OLD", appSecret: "appsec-1", who: "W1" }, release; const gate = new Promise((r) => { release = r; });
    const c = CMD.createCloudCmd({ apiBase: "https://x", now: () => 0, getCreds: () => creds, setTimer: (fn) => { fn(); return 0; },
      post: async () => { await gate; return { status: 200, body: { status: "queued", id: "9b1c" + "0".repeat(28) } }; } });
    const p = c.send("halt", {}); await tick();
    creds = { token: "acct-NEW", appSecret: "appsec-2", who: "W2" };   // 換了帳號
    release(); const r = await p;
    t("換了帳號(who 不同)→ 照舊丟掉在途的回應", r.ok === false && r.error === "ACCOUNT_CHANGED", r); }
  { const CL = require(path.join(SHELL, "cloud.js"));
    let creds = { token: "acct-OLD", appSecret: "appsec-1", who: "W1" }, release, hold = false;
    const body = { machine: { state: "running" }, alive: true, report: null, strategies: [] };
    const host = CL.createCloudHost({ apiBase: "https://x", now: () => 1e6, getCreds: () => creds, setTimer: () => 0, clearTimer: () => {},
      post: async () => { if (hold) await new Promise((r) => { release = r; }); return { status: 200, body }; } });
    await host.refresh(true); const before = host.snapshot();
    hold = true; const p = host.refresh(true); await tick();
    creds = { token: "acct-NEW", appSecret: "appsec-1", who: "W1" }; release(); await p;
    const after = host.snapshot();
    t("雲端狀態在途時 token 輪替 → 不整包丟掉、epoch 不變(畫面不閃成沒登入)", before.code === after.code && after.epoch === before.epoch && after.code !== "NO_LOGIN", { before: before.code, after: after.code, e: [before.epoch, after.epoch] }); }
  { const MC = require(path.join(SHELL, "mcpcode.js"));
    let creds = { token: "acct-OLD", appSecret: "appsec-1", who: "W1" }, n = 0;
    const m = MC.createMcpCode({ apiBase: "https://x", now: () => 1e6, getCreds: () => creds,
      post: async () => { n++; return { status: 200, body: { access_code: "blv_" + "a".repeat(40), mcp_url: "https://api.blave.org/mcp", expires_in: 3600, renew_after: 1800 } }; } });
    const a = await m.get(); creds = { token: "acct-NEW", appSecret: "appsec-1", who: "W1" }; const b = await m.get();
    t("接入碼:token 輪替後沿用手上那顆,不重換(不吃每小時 12 次的桶)", !!a && !!b && a.accessCode === b.accessCode && n === 1, { a, b, n }); }
  { const B = require(path.join(SHELL, "balance.js"));
    let creds = { token: "acct-OLD", appSecret: "appsec-1", who: "W1" }, release, hold = false;
    const h = B.createBalance({ apiBase: "https://x", now: () => 1, getCreds: () => creds, post: async () => { if (hold) await new Promise((r) => { release = r; }); return { status: 200, body: { balance: 5, trial_ai_credit_left: null } }; } });
    hold = true; const p = h.read(); await tick(); creds = { token: "acct-NEW", appSecret: "appsec-1", who: "W1" }; release();
    t("餘額:在途時 token 輪替 → 數字照樣交給畫面", (await p) && (await p).balance === 5); }

  // ── main.js 接線(原文檢查:Electron 起不來的部分) ──
  const main = fs.readFileSync(path.join(SHELL, "main.js"), "utf8");
  const body = (name) => { const i = main.indexOf("function " + name + "("); let d = 0; for (let k = main.indexOf("{", main.indexOf(")", i)); k < main.length; k++) { if (main[k] === "{") d++; else if (main[k] === "}" && --d === 0) return main.slice(i, k + 1); } return ""; };
  const so = body("signOutBlave");
  t("登出:先 settle 在途的輪替、pause 住定期檢查,才讀要撤銷的 token;clearToken(reset)在撤銷之後", so.indexOf("rotator().settle()") >= 0 && so.indexOf("rotator().settle()") < so.indexOf("rotator().pause()")
    && so.indexOf("rotator().pause()") < so.indexOf("loadToken()") && so.indexOf("oauth/desktop/revoke") < so.indexOf("clearToken()"));
  t("saveToken 寫旁邊再 rename(原子;寫到一半失敗不留空檔 / 半截)", /const tmp = tokenPath\(\) \+ "\.tmp";\n  fs\.writeFileSync\(tmp, safeStorage\.encryptString\(tok\), \{ mode: 0o600 \}\);\n  fs\.renameSync\(tmp, tokenPath\(\)\);/.test(body("saveToken")));
  t("clearToken 清掉輪替器(寬限舊值、期限檔)", body("clearToken").indexOf("rotator().reset()") >= 0);
  const oa = body("startOAuth");
  t("登入:/token 帶 expiring: true;settle 後才讀上一顆;存檔後 reset + noteLogin(expires_in)", /expiring: true/.test(oa)
    && oa.indexOf("rotator().settle()") < oa.indexOf("const prevToken = loadToken()")
    && oa.indexOf("rotator().reset()") > oa.indexOf("saveToken(r.body.access_token)") && /noteLogin\(r\.body\.access_token, r\.body\.expires_in\)/.test(oa));
  const rt = body("runTurn");
  t("回合開始前先確保剩 12 小時,才讀要進環境的那顆", rt.indexOf("rotator().ensure(ROTATE_MIN_LEFT_MS)") >= 0
    && rt.indexOf("rotator().ensure(ROTATE_MIN_LEFT_MS)") < rt.indexOf("const acct = plan.proxyToken ? loadToken() : null"));
  t("定期檢查回合進行中不換、只在拿到單一實例鎖的那份跑", /if \(app\.hasSingleInstanceLock\(\)\) startStep\("token rotate"/.test(main) && /if \(!\(activeTurn \|\| turnStarting\)\) rotator\(\)\.ensure\(ROTATE_MIN_LEFT_MS\)/.test(main));
  t("getCreds 一律走 blaveCreds(帶 who);沒有殘留只帶 token 的寫法", !/getCreds: \(\) => \{ const token = loadToken\(\)/.test(main) && (main.match(/getCreds: blaveCreds/g) || []).length === 5);
  t("account_status 被拒(403 ACCOUNT_TOKEN_INVALID)→ recover 一次再問", /ACCOUNT_TOKEN_INVALID" && await rotator\(\)\.recover\(acct\)\) return accountStatus\(true\)/.test(body("accountStatus")));
  t("換檔掛勾:先 load 連結紀錄、換完 reseal", /beforeSave: \(\) => connStore\(\)\.load\(\), afterSave: \(\) => connStore\(\)\.reseal\(\)/.test(main));

  process.exit(red ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
