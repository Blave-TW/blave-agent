// Blave 電腦版 — 帳號 token 輪替(主行程用;tests/check_shell_token_rotate.js)。
//
// 為什麼要輪替:帳號 token 會進 agent 的回合環境,agent 讀得到就可能外流。api 0.1.16 起 POST /oauth/desktop/rotate
// 用 token + app_secret(app_secret 從來不進子行程)換一顆 24 小時的新 token,舊值只再活 10 分鐘——
// 0.1.15 以前放進 agent 環境的永不過期字串,在這裡第一次輪替之後就作廢。
//
// 伺服器端不防並發:同一顆 token 同時送兩次 rotate,兩邊都回 200、先回來的那顆已經失效。所以這裡
// **同一時間只有一個 rotate 在途**(單一 promise),其餘呼叫共用它。
//
// 期限存在旁邊的明文小檔(不改 blave-token.bin 的格式:降回 0.1.15 時它照樣把那個檔當成裸 token 讀)。
// 檔案 agent 寫得到:刪掉 = 多輪替一次;改成很久以後 = 拖到伺服器 24 小時期限、被拒時走補救那條,傷害有上限。
// 檔裡綁著 token 指紋,不是這顆 token 的期限一律當沒有期限(= 立刻輪替)。
//
// 任何失敗(503 api 還沒跑 SQL、連不上、限速、401)都不清 token、不登出:照用手上那顆,稍後再試。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ENDPOINT = "/oauth/desktop/rotate";
const EXP_FILE = "blave-token-exp.json";
const GRACE_MS = 10 * 60 * 1000;           // 同 api PREV_GRACE_MINUTES
const BACKOFF_MS = 5 * 60 * 1000;          // 連不上 / 5xx / 409 / 429
const UNAVAILABLE_MS = 30 * 60 * 1000;     // 503 ROTATE_UNAVAILABLE:SQL 還沒跑,不必常敲
const SAVE_RETRY_MS = 60 * 1000;           // 新值寫不進 Keychain:趁舊值還在寬限內再換一次
const TOKEN_RE = /^acct-[A-Za-z0-9_\-]{32,128}$/;   // 同 api _ACCOUNT_TOKEN_RE:進 Keychain 之前先驗形狀

/* 憑證是哪一次登入的(main.js 的 getCreds 帶 who:輪替不變、重新登入才換)。沒帶 who 的呼叫端退回 token */
const whoOf = (c) => (c && c.token ? c.who || c.token : null);
const fp = (t) => crypto.createHash("sha256").update(t).digest("hex").slice(0, 16);

/* opts:{ dir, apiBase, post(url, body) → Promise<{status, body}>, loadToken(), saveToken(t) → bool, loadSecret(),
          beforeSave?(), afterSave?(), now?(), log?(msg) }
   beforeSave / afterSave:換檔前後的掛勾(main.js 用來讓連結紀錄跟著綁到新 token)。 */
function createRotator(opts) {
  const now = opts.now || (() => Date.now());
  const log = opts.log || (() => {});
  const expFile = path.join(opts.dir, EXP_FILE);
  let inflight = null, gen = 0, prev = null, backoffUntil = 0, deadFor = null, recovered = null, paused = false;

  function readExp(tok) {
    try {
      const j = JSON.parse(fs.readFileSync(expFile, "utf8"));
      return j && j.fp === fp(tok) && Number.isFinite(j.exp) ? j.exp : null;
    } catch (_) { return null; }
  }
  function writeExp(tok, expiresIn) {
    // 回應沒有 expires_in = 不過期的舊式 token:不自己編期限,下次照「沒有期限」輪替
    if (!(Number.isFinite(expiresIn) && expiresIn > 0)) { clearExp(); return; }
    try { fs.writeFileSync(expFile, JSON.stringify({ fp: fp(tok), exp: now() + expiresIn * 1000 }), { mode: 0o600 }); } catch (_) { /* 寫不進去:下次多輪替一次 */ }
  }
  function clearExp() { try { fs.unlinkSync(expFile); } catch (_) {} }
  const prevLive = () => (prev && now() < prev.until ? prev.token : null);

  async function once(present, cur) {
    const secret = opts.loadSecret();
    if (!secret) { deadFor = cur; return "no_secret"; }   // 很舊的登入沒有 app_secret:換不了,要重新登入才會有
    const mine = gen;
    let res = null;
    try { res = await opts.post(opts.apiBase + ENDPOINT, { token: present, app_secret: secret }); } catch (_) { /* 連不上 */ }
    // 在途時登出 / 重新登入 / 別人換掉了檔:這份回應不是現在手上這顆的
    if (mine !== gen) return "stale";
    const held = opts.loadToken();
    // Keychain 這一刻讀不到(鑰匙圈鎖住、safeStorage 暫時不可用)不是換了人:檔裡還是 cur,伺服器已把它排進寬限——
    // 不存、不當 stale,一分鐘後拿它再換(寬限分支會再發一顆);當 stale 丟掉的話寬限過了就只剩重新登入
    if (held === null) { backoffUntil = now() + SAVE_RETRY_MS; log("rotate: token unreadable"); return "unreadable"; }
    if (held !== cur) return "stale";
    const st = res && res.status, b = (res && res.body) || {};
    if (st === 200 && typeof b.access_token === "string" && TOKEN_RE.test(b.access_token)) {
      try { if (opts.beforeSave) opts.beforeSave(); } catch (_) { /* 掛勾壞掉不影響換檔 */ }
      // 寫不進去(回 false 或拋:磁碟滿、鎖檔):檔裡還是 cur,伺服器把它當寬限內的舊值——稍後拿它再換一次(伺服器會再發一顆蓋掉這顆沒存下來的)
      let saved = false; try { saved = opts.saveToken(b.access_token); } catch (_) { saved = false; }
      if (!saved) { backoffUntil = now() + SAVE_RETRY_MS; log("rotate: save failed"); return "save_failed"; }
      writeExp(b.access_token, Number(b.expires_in));
      prev = { token: cur, until: now() + GRACE_MS };
      backoffUntil = 0; deadFor = null;
      try { if (opts.afterSave) opts.afterSave(); } catch (_) { /* 同上 */ }
      return "rotated";
    }
    if (st === 401) { deadFor = cur; log("rotate: 401 " + (b.error_code || "")); return "auth"; }
    backoffUntil = now() + (st === 503 ? UNAVAILABLE_MS : BACKOFF_MS);
    log("rotate: " + (st || "offline"));
    return st === 503 ? "unavailable" : "retry";
  }

  /* 送一次 rotate(present 預設 = 檔裡那顆)。已有在途的就共用那一個,不另送 */
  function rotate(present) {
    if (inflight) return inflight;
    const cur = opts.loadToken();
    if (!cur) return Promise.resolve("none");
    inflight = once(present || cur, cur).catch(() => "retry").finally(() => { inflight = null; });
    return inflight;
  }

  return {
    /* 剩不到 minLeftMs(或沒有期限)就輪替。退讓中、這顆 401 過、沒有 app_secret → 不送 */
    ensure(minLeftMs) {
      if (paused) return Promise.resolve("paused");
      const cur = opts.loadToken();
      if (!cur) return Promise.resolve("none");
      const exp = readExp(cur);
      if (exp !== null && exp - now() >= minLeftMs) return Promise.resolve("fresh");
      if (inflight) return inflight;
      if (deadFor === cur || now() < backoffUntil) return Promise.resolve("skipped");
      return rotate();
    },
    /* 這顆被 api 拒了(403 ACCOUNT_TOKEN_INVALID / 401)。每顆只補救一次:寬限內的舊值優先(伺服器沒把我們存的
       那顆當現值時,只有舊值換得動),沒有就拿被拒的這顆換(過期未撤銷的照樣換得動)。回 true = 換到新的了 */
    async recover(rejected) {
      while (inflight) await inflight.catch(() => {});
      if (paused) return false;
      const cur = opts.loadToken();
      if (!cur) return false;
      if (cur !== rejected) return true;          // 已經換過了
      if (recovered === cur) return false;
      recovered = cur;
      inflight = once(prevLive() || cur, cur).catch(() => "retry").finally(() => { inflight = null; });
      return (await inflight) === "rotated";
    },
    /* 等在途的 rotate 落地(登出 / 重新登入前叫:要撤銷的是換完之後那顆) */
    settle: () => (inflight ? inflight.then(() => {}, () => {}) : Promise.resolve()),
    /* 登出前(settle 之後、撤銷之前)叫:撤銷在等網路的這段期間 ensure / recover 都不送——換了,撤銷比的就是舊值,
       伺服器留一列沒人持有的。reset()(登出完成 / 重新登入)解除 */
    pause() { paused = true; },
    /* 登出 / 換帳號:丟掉記憶體裡的舊值、作廢在途的回應、刪期限檔、解除暫停 */
    reset() { gen++; prev = null; backoffUntil = 0; deadFor = null; recovered = null; paused = false; clearExp(); },
    /* 登入拿到新 token 時記期限(沒有 expires_in 就清掉,下次啟動照舊式 token 輪替) */
    noteLogin(tok, expiresIn) { writeExp(tok, Number(expiresIn)); },
    state: () => ({ prev: !!prevLive(), backoffMs: Math.max(0, backoffUntil - now()), inflight: !!inflight, paused }),   // 給測試看的:沒有 token 本身
  };
}

module.exports = { createRotator, whoOf, ENDPOINT, EXP_FILE, GRACE_MS, BACKOFF_MS, UNAVAILABLE_MS, SAVE_RETRY_MS };
