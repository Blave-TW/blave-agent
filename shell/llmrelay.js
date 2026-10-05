// Blave 電腦版 — 自帶 API 金鑰的本機轉送口(主行程用;tests/check_shell_apikey_isolation.js)。
//
// 為什麼長這樣:
//   - 引擎子行程(CLI、agent 的 Bash、被換掉的 CLI 執行檔)跟用戶同一個系統用戶,環境與 argv 互相讀得到(`ps eww`)。
//     所以真金鑰不進任何子行程:引擎拿到的只有 127.0.0.1 的位址和一顆只活一輪的 token,轉出去時才換成真金鑰。
//   - 金鑰送去哪(origin、路徑前綴、認證 header 名稱)只認這個檔裡寫死的表(打包後在 asar 裡、受完整性驗證)。
//     **這個檔不讀 fs、不讀 process.env**:userData 與環境都是 agent 寫得到的,讓它們影響目的地 = agent 改一個字就把金鑰送到它那裡。
//   - 拿到轉送 token 的 agent 只能在這一輪、經這個轉送口、打這一家、受下面的上限約束;stop() 之後 token 作廢、port 關閉。
//   - 自己擋下的(token 錯、上限到)一律帶 `x-should-retry: false`:CLI 遇 401/429 會退避重試好幾分鐘(CLI 先看這個 header)。
//     上游自己回的 429 照原樣轉回,那種重試是對的。
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { StringDecoder } = require("string_decoder");

/* 每一家上架前都要過自家 e2e(G2)。thinking 一律照引擎帶的轉(Wei:思考模式常開、深度跟著模型選單的 low/high/max),
   轉送口不補也不改(空回應重試見 startRelay 裡的 retryOr)。name / keysUrl 給畫面(連結表單與模型選單),不是秘密。 */
const PRESETS = Object.freeze({
  deepseek: Object.freeze({
    origin: "https://api.deepseek.com",
    prefix: "/anthropic",
    authHeader: "x-api-key",
    models: Object.freeze(["deepseek-v4-pro", "deepseek-v4-flash"]),
    defaultModel: "deepseek-v4-pro",
    name: "DeepSeek",
    modelNames: Object.freeze({ "deepseek-v4-pro": "DeepSeek V4 Pro", "deepseek-v4-flash": "DeepSeek V4 Flash" }),
    keysUrl: "https://platform.deepseek.com/api_keys",
  }),
});

/* emptyRetries / emptyBackoffMs:DeepSeek 思考模式偶爾整則只有 thinking(或什麼都沒有)就收尾,引擎拿到會當這輪結束、用戶看到沒回覆。
   重送同一請求就好;每次重送都算進 maxRequests / maxOutputTokens。 */
const DEFAULT_LIMITS = Object.freeze({ maxRequests: 150, maxOutputTokens: 400000, maxBodyBytes: 32 * 1024 * 1024, emptyRetries: 2, emptyBackoffMs: 1000 });
const UPSTREAM_TIMEOUT_MS = 300000;
const PING_EVERY_MS = 10000;
const PING = 'event: ping\ndata: {"type": "ping"}\n\n';
const DROP_HEADERS = /^(transfer-encoding|connection|content-encoding|content-length|set-cookie)$/i;
const hasText = (x) => typeof x === "string" && /\S/.test(x);

/* 串流的一個事件算不算「已經有輸出」:算了就放行,之後不能再重送。看不懂的一律算(不攔自己不懂的東西)。
   回 true = 有輸出;字串 = message_delta 的 stop_reason;undefined = 還沒有(message_start、ping、thinking…) */
function sseEventState(raw) {
  const line = raw.split("\n").find((l) => l.startsWith("data:"));
  if (!line) return undefined;
  let d;
  try { d = JSON.parse(line.slice(5)); } catch (_) { return true; }
  if (!d || typeof d !== "object") return true;
  if (d.type === "error") return true;
  if (d.type === "content_block_start") {
    const b = d.content_block || {};
    return b.type === "tool_use" || b.type === "server_tool_use" || (b.type === "text" && hasText(b.text)) ? true : undefined;
  }
  if (d.type === "content_block_delta") {
    const x = d.delta || {};
    return x.type === "input_json_delta" || (x.type === "text_delta" && hasText(x.text)) ? true : undefined;
  }
  if (d.type === "message_delta") return d.delta && typeof d.delta.stop_reason === "string" ? d.delta.stop_reason : undefined;
  return undefined;
}

/* 非串流的整則回應是不是空的:content 是陣列、裡面沒有 tool_use 也沒有非空白 text。看不懂的形狀不算空。 */
function jsonIsEmpty(m) {
  if (!m || typeof m !== "object" || !Array.isArray(m.content)) return false;
  return !m.content.some((b) => b && (b.type === "tool_use" || b.type === "server_tool_use" || (b.type === "text" && hasText(b.text))));
}
const FWD_HEADERS = ["anthropic-version", "accept"];

function anthropicError(res, status, type, message, noRetry) {
  const h = { "content-type": "application/json" };
  if (noRetry) h["x-should-retry"] = "false";
  res.writeHead(status, h);
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

function tokenOk(req, token) {
  const a = req.headers["authorization"], k = req.headers["x-api-key"];
  const got = typeof k === "string" && k ? k : typeof a === "string" && /^Bearer /.test(a) ? a.slice(7) : "";
  const g = Buffer.from(got), t = Buffer.from(token);
  return g.length === t.length && crypto.timingSafeEqual(g, t);
}

/* opts:{ preset: 名稱, key: 真金鑰, limits?, onEvent?(e) };presets 只給測試換成指向 mock 的表,主行程不帶。
   回 Promise<{ url, token, port, stop(), stats }> */
function startRelay(opts, presets = PRESETS) {
  const p = Object.prototype.hasOwnProperty.call(presets, opts.preset) ? presets[opts.preset] : null;
  if (!p) return Promise.reject(new Error("UNKNOWN_PRESET"));
  if (typeof opts.key !== "string" || !opts.key || /[\u0000-\u001f\u007f\s]/.test(opts.key)) return Promise.reject(new Error("BAD_KEY"));
  const key = opts.key;
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
  const onEvent = typeof opts.onEvent === "function" ? opts.onEvent : () => {};
  const token = crypto.randomBytes(32).toString("hex");
  const up = new URL(p.origin);
  const agent = up.protocol === "https:" ? https : http;
  const stats = { requests: 0, outputTokens: 0, capHit: false, rewrites: 0, rejected: 0, emptyRetries: 0 };
  let revoked = false, port = 0;

  const srv = http.createServer((req, res) => {
    // Host 釘死:擋 DNS rebinding(內建瀏覽器裡的網頁把自己的網域解析成 127.0.0.1 打進來)
    if (req.headers.host !== `127.0.0.1:${port}` || typeof req.url !== "string" || req.url[0] !== "/") {
      stats.rejected++; return anthropicError(res, 400, "invalid_request_error", "bad request target", true);
    }
    if (revoked || !tokenOk(req, token)) { stats.rejected++; return anthropicError(res, 403, "permission_error", "relay token invalid", true); }
    const pathname = req.url.split("?")[0];
    if (req.method !== "POST" || pathname !== "/v1/messages") { stats.rejected++; return anthropicError(res, 404, "not_found_error", "not found", true); }
    if (stats.requests >= limits.maxRequests || stats.outputTokens >= limits.maxOutputTokens) {
      stats.capHit = true; onEvent({ type: "cap", requests: stats.requests, outputTokens: stats.outputTokens });
      return anthropicError(res, 429, "rate_limit_error", "turn usage limit reached", true);
    }
    stats.requests++;
    const bufs = []; let size = 0, tooBig = false;
    req.on("data", (c) => { size += c.length; if (size > limits.maxBodyBytes) { tooBig = true; req.destroy(); return; } bufs.push(c); });
    req.on("end", () => {
      if (tooBig) return;
      let body;
      try { body = JSON.parse(Buffer.concat(bufs).toString("utf8")); } catch (_) { body = null; }
      if (!body || typeof body !== "object" || Array.isArray(body)) return anthropicError(res, 400, "invalid_request_error", "body must be a JSON object", true);
      // 型錄外的 id(CLI 的旁支請求可能帶別的)改寫成預設、不回 400:回 400 整輪就死,花費一樣受上限約束
      if (p.models.indexOf(body.model) < 0) { onEvent({ type: "model_rewrite", from: String(body.model).slice(0, 80), to: p.defaultModel }); stats.rewrites++; body.model = p.defaultModel; }
      const out = Buffer.from(JSON.stringify(body));
      const headers = { "content-type": "application/json", "content-length": out.length };
      for (const h of FWD_HEADERS) if (typeof req.headers[h] === "string") headers[h] = req.headers[h];
      if (!headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01";
      headers[p.authHeader] = p.authHeader === "authorization" ? "Bearer " + key : key;

      let curReq = null, timer = null, gone = false;
      res.on("close", () => { if (!res.writableFinished) { gone = true; clearTimeout(timer); if (curReq) curReq.destroy(); } });
      // held:{ status, headers, chunks } 一則還沒交給引擎的空回應;重送不成就把它原樣交出去
      const replay = (held) => {
        if (!res.headersSent) res.writeHead(held.status, held.headers);
        for (const c of held.chunks) res.write(c);
        res.end();
      };
      const retryOr = (n, held, stopReason) => {
        // 撞到長度上限的空回應重送也是一樣的結果,只會再燒一次
        if (stopReason === "max_tokens" || gone) return replay(held);
        if (n >= limits.emptyRetries) { onEvent({ type: "empty_giveup", attempts: n + 1 }); return replay(held); }
        if (stats.requests >= limits.maxRequests || stats.outputTokens >= limits.maxOutputTokens) {
          // 引擎拿到空回應多半就收尾、不會再來撞 429:在這裡就記上限,turn_failed 才會是 cap 而不是沒回覆
          stats.capHit = true; onEvent({ type: "cap", requests: stats.requests, outputTokens: stats.outputTokens });
          return replay(held);
        }
        stats.requests++; stats.emptyRetries++;
        onEvent({ type: "empty_retry", attempt: n + 1 });
        timer = setTimeout(() => send(n + 1, held), limits.emptyBackoffMs * (n + 1));
      };
      const send = (n, prev) => {
        if (gone) return;
        const upReq = curReq = agent.request({ protocol: up.protocol, hostname: up.hostname, port: up.port || undefined,
          method: "POST", path: p.prefix + "/v1/messages", headers, timeout: UPSTREAM_TIMEOUT_MS }, (upRes) => {
          const status = upRes.statusCode || 502, rh = {};
          for (const [k, v] of Object.entries(upRes.headers)) if (!DROP_HEADERS.test(k)) rh[k] = v;
          const ct = String(upRes.headers["content-type"] || "");
          // output_tokens:message_delta 帶的是這則訊息的累計值,取最大;只算數,不改內容
          let maxOut = 0, tail = "", counted = false;
          const count = () => { if (!counted) { counted = true; stats.outputTokens += maxOut; } };
          const sniff = (c) => {
            const t = tail + c.toString("latin1");
            for (const m of t.matchAll(/"output_tokens"\s*:\s*(\d+)/g)) maxOut = Math.max(maxOut, Number(m[1]));
            tail = t.slice(-40);
          };
          upRes.on("close", count);   // 中途斷掉的那一筆也算進上限
          const ok = status >= 200 && status < 300, sse = /text\/event-stream/i.test(ct), json = /application\/json/i.test(ct);

          // 重送回來的不是同一種(錯誤、或串流換成 JSON):交出前一則
          if (!ok || (!sse && !json) || (prev && res.headersSent && !sse)) {
            if (prev) { upRes.on("data", sniff); upRes.on("end", count); upRes.on("error", () => {}); return replay(prev); }
            res.writeHead(status, rh);
            upRes.on("data", (c) => { sniff(c); res.write(c); });
            upRes.on("end", () => { count(); res.end(); });
            upRes.on("error", () => res.destroy());
            return;
          }
          const held = { status, headers: rh, chunks: [] };

          if (json) {
            upRes.on("data", (c) => { sniff(c); held.chunks.push(c); });
            upRes.on("end", () => {
              count();
              let m = null;
              try { m = JSON.parse(Buffer.concat(held.chunks).toString("utf8")); } catch (_) { m = null; }
              if (!jsonIsEmpty(m)) return replay(held);
              retryOr(n, held, m.stop_reason);
            });
            upRes.on("error", () => (prev ? replay(prev) : res.destroy()));
            return;
          }

          // 串流:有輸出之前先扣著(期間每 10 秒補一個 ping,SDK 會略過),有輸出就把扣著的一起放、之後原樣轉
          if (!res.headersSent) res.writeHead(status, rh);
          const dec = new StringDecoder("utf8");
          let buf = "", live = false, stopReason = null, lastPing = Date.now();
          const goLive = () => { live = true; for (const c of held.chunks) res.write(c); held.chunks = []; };
          upRes.on("data", (c) => {
            sniff(c);
            if (live) return res.write(c);
            held.chunks.push(c);
            buf += dec.write(c).replace(/\r/g, "");
            let i;
            while (!live && (i = buf.indexOf("\n\n")) >= 0) {
              const st = sseEventState(buf.slice(0, i)); buf = buf.slice(i + 2);
              if (st === true) goLive(); else if (st) stopReason = st;
            }
            if (!live && Date.now() - lastPing >= PING_EVERY_MS) { lastPing = Date.now(); res.write(PING); }
          });
          upRes.on("end", () => {
            count();
            if (live) return res.end();
            if (buf.trim() && sseEventState(buf) === true) { goLive(); return res.end(); }
            retryOr(n, held, stopReason);
          });
          upRes.on("error", () => { if (!live) goLive(); res.destroy(); });
        });
        upReq.on("timeout", () => upReq.destroy(new Error("upstream timeout")));
        upReq.on("error", (e) => {
          if (gone) return;
          onEvent({ type: "upstream_error", code: e && e.code ? String(e.code) : "ERR" });
          if (prev && !upReq.res) return replay(prev);
          if (!res.headersSent) anthropicError(res, 502, "api_error", "upstream unreachable", false); else res.destroy();
        });
        upReq.end(out);
      };
      send(0, null);
    });
  });

  return new Promise((resolve, reject) => {
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      port = srv.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`, token, port, stats,
        stop() { if (revoked) return; revoked = true; srv.close(); if (srv.closeAllConnections) srv.closeAllConnections(); },
      });
    });
  });
}

/* 「測試並連結」:主行程拿用戶剛貼的金鑰直接打供應商一次最小請求(不經轉送口、不經 agent),驗過才存。
   回 { code, status } —— 沒有金鑰、沒有回應內文(錯誤字串可能夾著金鑰的片段)。
   code:OK / KEY(401、403)/ CREDIT(402)/ RATE(429)/ NET(連不到、逾時)/ CANCELED / OTHER(其餘狀態碼,帶 status) */
const VERIFY_TIMEOUT_MS = 20000;
function verifyKey(preset, key, opts = {}, presets = PRESETS) {
  const p = Object.prototype.hasOwnProperty.call(presets, preset) ? presets[preset] : null;
  if (!p) return Promise.resolve({ code: "OTHER", status: 0 });
  if (typeof key !== "string" || !key || /[\u0000-\u001f\u007f\s]/.test(key)) return Promise.resolve({ code: "KEY", status: 0 });
  const up = new URL(p.origin), agent = up.protocol === "https:" ? https : http;
  const out = Buffer.from(JSON.stringify({ model: p.defaultModel, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }));
  const headers = { "content-type": "application/json", "content-length": out.length, "anthropic-version": "2023-06-01" };
  headers[p.authHeader] = p.authHeader === "authorization" ? "Bearer " + key : key;
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const r = agent.request({ protocol: up.protocol, hostname: up.hostname, port: up.port || undefined, method: "POST",
      path: p.prefix + "/v1/messages", headers, timeout: opts.timeoutMs || VERIFY_TIMEOUT_MS, signal: opts.signal }, (res) => {
      res.resume();
      const st = res.statusCode || 0;
      res.on("end", () => finish({ code: st >= 200 && st < 300 ? "OK" : st === 401 || st === 403 ? "KEY" : st === 402 ? "CREDIT" : st === 429 ? "RATE" : "OTHER", status: st }));
      res.on("error", () => finish({ code: "NET", status: 0 }));
    });
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", (e) => finish({ code: e && e.name === "AbortError" ? "CANCELED" : "NET", status: 0 }));
    r.end(out);
  });
}

module.exports = { startRelay, verifyKey, PRESETS, DEFAULT_LIMITS };
