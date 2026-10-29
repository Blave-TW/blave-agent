// Blave 電腦版 — 帳號轉送口(主行程用;tests/check_shell_account_relay.js)。
//
// 為什麼要有它(0.1.37 對話分頁並行,技術方案 chat-tabs-parallel-tech §1.3):
//   - 帳號 token 每 24 小時輪替、舊值只再活 10 分鐘(tokenrotate.js)。以前那顆直接放進回合環境,回合中就不能換;
//     多條對話接力重疊時永遠等不到空檔,token 到期就失效。
//   - 現在回合環境裡只有一顆「這一輪」的轉送 token 和 127.0.0.1 的位址;轉出去時才從 Keychain 讀**當下那顆**帳號 token 換上。
//     輪替跟回合完全脫鉤,agent 也從此讀不到帳號 token(輪替本來就是因為它讀得到)。
//   - 只放行回合真的會打的兩組路徑:/openclaw/proxy/(LLM、摘要、型錄)與 /openclaw/agent/report/(lib/report.py 的驗證)。
//     目的地是呼叫端給的 apiBase(main.js 寫死的 API_BASE),這個檔不讀 fs、不讀 process.env:兩者 agent 都寫得到。
//   - 被 api 拒(401、403 ACCOUNT_TOKEN_INVALID)時照 rotator().recover() 補救一次再重送;只在還沒寫任何東西給客戶端時做得到,
//     所以請求內文整份先收著(上限 MAX_BODY),回應是 401/403 才先收著看,其餘原樣串流。
//
// 這個檔不 require electron;上游可以注入(測試用假的)。
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const PATHS = ["/openclaw/proxy/", "/openclaw/agent/report/"];
const MAX_BODY = 32 * 1024 * 1024;        // 同 llmrelay 的量級:1M context 純文字約 4MB,其餘留給圖片
const UPSTREAM_TIMEOUT_MS = 300000;        // 串流中途沉默這麼久才斷(同 llmrelay)
const AUTH_PEEK_MAX = 64 * 1024;           // 401/403 的內文只看這麼多(判 error_code)
// 跟帳號 token 同一個前綴:lib/report.py 看到 acct- 就不送平台驗證(電腦版本來就不送),轉送 token 也要落在同一條路
const TOKEN_PREFIX = "acct-relay-";
const HOP = /^(host|connection|keep-alive|proxy-connection|transfer-encoding|upgrade|te|trailer|content-length|x-api-key|authorization|origin|cookie)$/i;
const DROP_DOWN = /^(connection|keep-alive|transfer-encoding|upgrade|set-cookie)$/i;
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");

function deny(res, status, message) {
  res.writeHead(status, { "content-type": "application/json", "x-should-retry": "false" });
  res.end(JSON.stringify({ type: "error", error: { type: status === 401 ? "authentication_error" : "permission_error", message } }));
}
// 路徑只認那兩組前綴,不收 `..`、編碼過的斜線與點(繞過前綴的老招)
function pathOk(raw) {
  if (typeof raw !== "string" || raw[0] !== "/" || raw.length > 4096) return false;
  const p = raw.split("?")[0];
  if (/%2e|%2f|%5c|\\/i.test(p) || p.split("/").some((seg) => seg === "." || seg === "..")) return false;
  return PATHS.some((x) => p.startsWith(x));
}
function presented(req) {
  const k = req.headers["x-api-key"], a = req.headers["authorization"];
  const v = typeof k === "string" && k ? k : typeof a === "string" && /^Bearer /.test(a) ? a.slice(7) : "";
  return v.startsWith("proxy-") ? v.slice(6) : v;
}

/* opts:{ apiBase, loadToken() → 帳號 token | null, recover(rejected) → Promise<bool>(換到新的了), log?(msg), upstream?(測試換 http) }
   回 { start() → Promise<port>, issue(sid) → { token, base }, revoke(token), active(), stop() } */
function createAccountRelay(opts) {
  const up = new URL(opts.apiBase);
  const agent = opts.upstream || (up.protocol === "https:" ? https : http);
  const log = opts.log || (() => {});
  const tokens = new Map();   // sha256(token) → sid
  let srv = null, port = 0, starting = null;

  function forward(req, res, body, acct, retried) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.test(k)) headers[k] = v;
    headers["x-api-key"] = "proxy-" + acct;
    headers["content-length"] = body.length;
    let gone = false;
    res.on("close", () => { if (!res.writableFinished) { gone = true; upReq.destroy(); } });
    const upReq = agent.request({ protocol: up.protocol, hostname: up.hostname, port: up.port || undefined, method: req.method,
      path: req.url, headers, timeout: UPSTREAM_TIMEOUT_MS }, (upRes) => {
      const status = upRes.statusCode || 502;
      const out = {};
      for (const [k, v] of Object.entries(upRes.headers)) if (!DROP_DOWN.test(k)) out[k] = v;
      if ((status === 401 || status === 403) && !retried) {
        const bufs = []; let n = 0;
        upRes.on("data", (c) => { n += c.length; if (n <= AUTH_PEEK_MAX) bufs.push(c); });
        upRes.on("end", async () => {
          const raw = Buffer.concat(bufs);
          let code = ""; try { code = String((JSON.parse(raw.toString("utf8")) || {}).error_code || ""); } catch (_) { code = ""; }
          // 401 = 這顆不認得;403 只認 ACCOUNT_TOKEN_INVALID(餘額、方案的 403 是別的事,補救也沒用)
          const rejected = status === 401 || code === "ACCOUNT_TOKEN_INVALID";
          let fresh = null;
          if (rejected && !gone) {
            let ok = false; try { ok = await opts.recover(acct); } catch (_) { ok = false; }
            const now = ok ? opts.loadToken() : null;
            if (now && now !== acct) fresh = now;
          }
          if (gone) return;
          if (fresh) { log("account relay: retried after token recover"); return forward(req, res, body, fresh, true); }
          delete out["content-length"];   // 超過 AUTH_PEEK_MAX 的部分沒收,長度改由 Node 重算
          res.writeHead(status, out); res.end(raw);
        });
        upRes.on("error", () => res.destroy());
        return;
      }
      res.writeHead(status, out);
      upRes.pipe(res);
      upRes.on("error", () => res.destroy());
    });
    upReq.on("timeout", () => upReq.destroy(new Error("upstream timeout")));
    upReq.on("error", () => {
      if (gone) return;
      if (!res.headersSent) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream unreachable" } })); }
      else res.destroy();
    });
    upReq.end(body);
  }

  function onRequest(req, res) {
    // Host 釘死、帶 Origin 的一律拒:擋內建瀏覽器裡的網頁(DNS rebinding、fetch 到 127.0.0.1)
    if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin !== undefined) return deny(res, 403, "bad request target");
    const t = presented(req);
    if (!t || !tokens.has(sha(t))) return deny(res, 401, "relay token invalid");
    if (!pathOk(req.url)) return deny(res, 404, "not found");
    const bufs = []; let size = 0, tooBig = false;
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { tooBig = true; bufs.length = 0; if (size > 4 * MAX_BODY) req.destroy(); return; } bufs.push(c); });
    req.on("end", () => {
      if (tooBig) return deny(res, 413, "request body too large");
      if (!tokens.has(sha(t))) return deny(res, 401, "relay token invalid");   // 收內文的期間這一輪結束了
      const acct = opts.loadToken();
      if (!acct) return deny(res, 401, "not signed in");   // 登出了:不替任何人送
      forward(req, res, Buffer.concat(bufs), acct, false);
    });
  }

  return {
    start() {
      if (port) return Promise.resolve(port);
      if (starting) return starting;
      starting = new Promise((resolve, reject) => {
        srv = http.createServer(onRequest);
        srv.headersTimeout = 10000;
        srv.on("error", (e) => { starting = null; reject(e); });
        srv.listen(0, "127.0.0.1", () => { port = srv.address().port; resolve(port); });
      });
      return starting;
    },
    /* 一輪一顆。base 已含 http://127.0.0.1:<port>,呼叫端自己接 /openclaw/proxy 與 /openclaw/agent/report */
    issue(sid) {
      if (!port) throw new Error("account relay not started");
      const token = TOKEN_PREFIX + crypto.randomBytes(32).toString("hex");
      tokens.set(sha(token), sid);
      return { token, base: `http://127.0.0.1:${port}` };
    },
    revoke(token) { if (typeof token === "string") tokens.delete(sha(token)); },
    active: () => tokens.size,
    stop() { tokens.clear(); if (srv) { srv.close(); if (srv.closeAllConnections) srv.closeAllConnections(); } srv = null; port = 0; starting = null; },
  };
}

module.exports = { createAccountRelay, pathOk, PATHS, TOKEN_PREFIX, MAX_BODY };
