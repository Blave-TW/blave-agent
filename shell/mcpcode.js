// Blave 電腦版 — 替 agent 掛上 `blave` MCP 用的接入碼(主行程用)。
// 契約:blave-canon output/backend/2026-09-21-desktop-agent-cloud-handoff-draft.md 第二部分 + 檔尾 Wei 拍板。
//
// 為什麼長這樣:
//   - 接入碼是第三顆、另一類憑證:用帳號 token + app_secret 去換(那兩顆都不進 agent),換出來的 `blv_…` 能讓 agent
//     經 MCP 拿到用戶雲端主機的 SSH。所以它**只活在這個閉包的記憶體裡**:不寫檔、不進 safeStorage、不進 renderer、不 log。
//     唯一落地的那一下是交給 CLI 的單次設定檔(writeConfig:workspace 以外、0600、回合結束就刪)——CLI 沒有別的入口。
//   - 伺服器每呼叫一次就「發新撤舊」,帳號桶每小時 12 次:**不可以每一輪都打**。有效期內重用手上那顆,過了 renew_after(一半)才續;
//     續失敗而舊的還沒過期就繼續用舊的(伺服器只在成功時才撤舊)。
//   - 時間只用「拿到之後過了多久」(相對值)配伺服器給的 expires_in / renew_after,不拿本機時鐘去比伺服器的 expires_at:
//     本機時鐘可以是錯的。過了多久是負的(時鐘被往回調)= 當成過期。
//   - 失敗要退讓,而且**不擋回合**:沒主機(409)、還沒上線(404 / 503)、被限速(429)、連不上 → 這一輪不掛,過一陣子才再問。
//   - 這顆碼是誰的(比照 cloud.js):綁著換它的那顆 token;token 換了(登出、換帳號)= 整個丟掉,在途的回應回來時世代對不上也丟——
//     A 的碼不會掛到 B 的回合上。
//
// 這個檔不 require electron;HTTP 由呼叫端注入(測試用假的)。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ENDPOINT = "/oauth/desktop/cloud/mcp_code";
const CODE_RE = /^blv_[A-Za-z0-9_-]{16,200}$/;
const SAFETY_MS = 60 * 1000;          // 離過期不到這麼久就不拿來掛(一個回合可能跑幾分鐘;真的過期時 MCP 那邊會叫 agent 請用戶再送一次)
const BACKOFF_MS = { NO_MACHINE: 10 * 60 * 1000, UNAVAILABLE: 10 * 60 * 1000, RATE_LIMITED: 30 * 60 * 1000, AUTH: 10 * 60 * 1000, OFFLINE: 60 * 1000, BAD_RESPONSE: 10 * 60 * 1000 };

/* 回應 → { code: "OK", accessCode, url, expiresInMs, renewAfterMs } 或 { code: 失敗代號 }(純函式)。
   mcp_url 只認 https 而且主機在 blave.org 底下:這個網址會連同 Bearer 一起交給 CLI——伺服器回應被動過手腳時,碼不能被送去別的地方。 */
function interpret(res) {
  if (!res || !res.status) return { code: "OFFLINE" };
  if (res.status === 401) return { code: "AUTH" };
  if (res.status === 409) return { code: "NO_MACHINE" };
  if (res.status === 429) return { code: "RATE_LIMITED" };
  if (res.status === 404 || res.status === 503) return { code: "UNAVAILABLE" };   // 端點還沒部署 / DB 欄位還沒加 / Redis 壞:不掛,回合照常
  const b = res.body;
  if (res.status !== 200 || !b || typeof b !== "object") return { code: res.status >= 500 ? "OFFLINE" : "BAD_RESPONSE" };
  let u = null; try { u = new URL(String(b.mcp_url)); } catch (_) { /* 不是網址 */ }
  const hostOk = u && u.protocol === "https:" && !u.username && !u.password && (u.hostname === "blave.org" || u.hostname.endsWith(".blave.org"));
  const exp = Number(b.expires_in), ren = Number(b.renew_after);
  if (typeof b.access_code !== "string" || !CODE_RE.test(b.access_code) || !hostOk || !(exp > 120 && exp <= 7 * 24 * 3600)) return { code: "BAD_RESPONSE" };
  return { code: "OK", accessCode: b.access_code, url: u.href, expiresInMs: exp * 1000, renewAfterMs: (ren > 0 && ren < exp ? ren : exp / 2) * 1000 };
}

/* opts:{ apiBase, getCreds() → { token, appSecret } | null, post(url, body) → Promise<{status, body}>, now? } */
function createMcpCode(opts) {
  const now = opts.now || (() => Date.now());
  let held = null, owner = null, gen = 0, inflight = null, retryAt = 0, lastFail = null;

  const creds = () => { let c = null; try { c = opts.getCreds(); } catch (_) { /* Keychain 讀不到 = 沒登入 */ } return c && c.token && c.appSecret ? c : null; };
  const age = () => (held ? now() - held.at : Infinity);
  const usable = () => !!held && age() >= 0 && age() < held.expiresInMs - SAFETY_MS;
  // 退讓**不跟著清**(稽核登記):帳號桶是 12 次 / 小時,而 drop() 在換人 / 登出時會被叫到——歸零的話,
  // 登出再登入就能把剛被 429 擋下的那一次立刻再送一次。碼本身該丟的照丟
  function drop() { gen++; held = null; owner = null; lastFail = null; }

  async function fetchOne(c) {
    const mine = ++gen; owner = c.token;
    let res = null; try { res = await opts.post(opts.apiBase + ENDPOINT, { token: c.token, app_secret: c.appSecret }); } catch (_) { /* 連不上 */ }
    const cur = creds();
    if (mine !== gen || !cur || cur.token !== c.token) return;       // 這段期間登出 / 換人了:這份回應不是現在這個人的
    const r = interpret(res);
    if (r.code === "OK") { held = { accessCode: r.accessCode, url: r.url, expiresInMs: r.expiresInMs, renewAfterMs: r.renewAfterMs, at: now() }; retryAt = 0; lastFail = null; return; }
    lastFail = r.code; retryAt = now() + (BACKOFF_MS[r.code] || BACKOFF_MS.OFFLINE);
    if (r.code === "AUTH" || r.code === "NO_MACHINE") held = null;   // 憑證被撤 / 主機沒了:手上那顆也不該再用
  }

  return {
    /* 這一輪要掛的那顆:{ accessCode, url } 或 null(= 不掛,回合照常)。永遠不拋。 */
    async get() {
      const c = creds();
      if (!c) { if (held || owner) drop(); return null; }
      if (owner !== null && owner !== c.token) drop();               // 換了人:先丟掉上一個人的
      const needs = !usable() || age() >= held.renewAfterMs;
      if (needs && now() >= retryAt) {
        if (!inflight) inflight = fetchOne(c).catch(() => {}).finally(() => { inflight = null; });
        await inflight;
      }
      const again = creds();
      if (!again || again.token !== c.token) { drop(); return null; }
      return usable() ? { accessCode: held.accessCode, url: held.url } : null;
    },
    reset() { drop(); },                                             // 登出:立刻丟掉,並作廢還在路上的請求
    state: () => ({ has: usable(), lastFail, retryInMs: Math.max(0, retryAt - now()) }),   // 給 log / 測試看的:沒有碼本身
  };
}

/* 交給 Claude Code 的單次 MCP 設定檔。dir = workspace **以外**的 app 私有目錄(0700);檔名隨機、0600、不跟著符號連結走("wx")。
   回檔案路徑;寫不進去回 null(= 這一輪不掛)。 */
function writeConfig(dir, mount) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
    const file = path.join(dir, crypto.randomBytes(16).toString("hex") + ".json");
    const body = JSON.stringify({ mcpServers: { blave: { type: "http", url: mount.url, headers: { Authorization: "Bearer " + mount.accessCode } } } });
    const fd = fs.openSync(file, "wx", 0o600); try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
    return file;
  } catch (_) { return null; }
}
function removeConfig(file) { try { if (file) fs.unlinkSync(file); } catch (_) { /* 已經不在了 */ } }
/* app 啟動時清空那個目錄:上一次回合中途 crash 留下來的檔(裡面是一顆可能還沒過期的碼) */
function sweep(dir) { try { for (const n of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, n)); } catch (_) { /* 下次再清 */ } } } catch (_) { /* 目錄還不存在 */ } }

module.exports = { createMcpCode, interpret, writeConfig, removeConfig, sweep, ENDPOINT, SAFETY_MS, BACKOFF_MS };
