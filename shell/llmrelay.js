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
//     排隊滿、等太久的 429 例外:帶 `x-should-retry: true` + `retry-after`,那是塞車不是上限,CLI 該退避再來。
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { StringDecoder } = require("string_decoder");

/* 每一家上架前都要過自家 e2e(G2)。思考規則見 thinkingPolicy(跟 api proxy 同一條判準);空回應重試見 startRelay 裡的 retryOr。
   name / keysUrl 給畫面(連結表單與模型選單),不是秘密。 */
const PRESETS = Object.freeze({
  deepseek: Object.freeze({
    origin: "https://api.deepseek.com",
    prefix: "/anthropic",
    authHeader: "x-api-key",
    models: Object.freeze(["deepseek-v4-pro", "deepseek-v4-flash"]),
    defaultModel: "deepseek-v4-pro",
    cheapModel: "deepseek-v4-flash",   // 幕後請求一律改寫成這顆(見 thinkingPolicy)
    name: "DeepSeek",
    modelNames: Object.freeze({ "deepseek-v4-pro": "DeepSeek V4 Pro", "deepseek-v4-flash": "DeepSeek V4 Flash" }),
    keysUrl: "https://platform.deepseek.com/api_keys",
  }),
});

/* 每輪上限:
   - maxOutputTokens 靠預扣守住:每筆送出前把 max_tokens 夾到「上限 − 已用 − 在途預扣」以下並預扣,結束時照實際用量多退少補;
     沒正常收尾的(中途斷、逾時、引擎先掛掉)照預扣值算——上游多半已經照它生成的收錢,寧可多算。
     剩不到 minOutputTokens:有別筆在途就排隊等它們退回預扣,沒有就是到上限。
   - maxConcurrent:同時在途幾筆,其餘排隊(最多 maxQueued 筆、最久 maxQueueMs)。排不進、等太久回 429 讓 CLI 退避重試
     (帶 retry-after;不是 x-should-retry: false——這不是上限,是塞車)。不直接全回 429:CLI 的平行子任務會被當成失敗。
     等太久的界線要短於 CLI 等回應 header 的逾時(undici 預設 300 秒),排隊期間什麼都還沒送出去。
   - maxBodyBytes 16MB:DeepSeek V4 的 context 是 1M token,純文字整段塞滿約 4MB,剩下留給圖片。
   emptyRetries / emptyBackoffMs:DeepSeek 思考模式偶爾整則只有 thinking(或什麼都沒有)就收尾,引擎拿到會當這輪結束、用戶看到沒回覆。
   重送同一請求就好;每次重送都算進 maxRequests,也照上面一樣預扣。 */
const DEFAULT_LIMITS = Object.freeze({ maxRequests: 150, maxOutputTokens: 400000, minOutputTokens: 1024, maxBodyBytes: 16 * 1024 * 1024,
  maxConcurrent: 4, maxQueued: 16, maxQueueMs: 120000, emptyRetries: 2, emptyBackoffMs: 1000, pingMs: 10000 });
const UPSTREAM_TIMEOUT_MS = 300000;

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

/* 思考規則(Wei 拍板,跟 api proxy 同一組判準):
   - 幕後雜事一律走便宜那顆、關思考:型錄外的 id(runtime 把引擎的 small/fast 設成 deepseek/deepseek-background,
     標題、WebFetch 摘要都走它——不設的話引擎沿用主模型 id、分不出來)、請求自己帶 thinking disabled
     (主回合實錄一律送 adaptive)、或呼叫端標了 x-blave-purpose: background。
   - 其餘是主回合:一律開思考,強度(output_config.effort)照引擎帶的;沒帶 thinking 就補 adaptive。
   直接改 body;回 true = 幕後 */
function thinkingPolicy(p, body, purpose) {
  const off = !!body.thinking && typeof body.thinking === "object" && body.thinking.type === "disabled";
  const background = p.models.indexOf(body.model) < 0 || off || String(purpose || "").toLowerCase() === "background";
  if (background) {
    body.model = p.cheapModel;
    body.thinking = { type: "disabled" };
  } else if (!body.thinking || typeof body.thinking !== "object") {
    body.thinking = { type: "adaptive" };
  }
  return background;
}

function anthropicError(res, status, type, message, noRetry, extra) {
  const h = { "content-type": "application/json", ...(extra || {}) };
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
  const stats = { requests: 0, outputTokens: 0, reserved: 0, inflight: 0, capHit: false, rewrites: 0, rejected: 0, emptyRetries: 0, queued: 0, background: 0 };
  let revoked = false, port = 0;
  const queue = [];

  const capHard = () => stats.requests >= limits.maxRequests || stats.outputTokens + limits.minOutputTokens > limits.maxOutputTokens;
  const avail = () => limits.maxOutputTokens - stats.outputTokens - stats.reserved;
  const capReply = (res) => {
    stats.capHit = true; onEvent({ type: "cap", requests: stats.requests, outputTokens: stats.outputTokens });
    anthropicError(res, 429, "rate_limit_error", "turn usage limit reached", true);
  };
  const busyReply = (res) => anthropicError(res, 429, "rate_limit_error", "relay busy", false, { "x-should-retry": "true", "retry-after": "5" });
  /* 預扣一筆:回 { max, done(used, completed) };done 只算一次。沒有空間回 null */
  const reserve = (want) => {
    const max = Math.min(want, avail());
    if (max < limits.minOutputTokens && max < want) return null;
    stats.reserved += max;
    let settled = false;
    return { max, done(used, completed) {
      if (settled) return; settled = true;
      stats.reserved -= max;
      stats.outputTokens += completed ? used : Math.max(used, max);
    } };
  };
  /* 排隊的請求依序放行:先看硬上限(筆數、已用),再看在途預扣是不是把額度佔滿(佔滿就等它們退回) */
  const pump = () => {
    while (queue.length && stats.inflight < limits.maxConcurrent) {
      const job = queue[0];
      if (job.gone) { queue.shift(); continue; }
      if (capHard()) { queue.shift(); clearTimeout(job.timer); capReply(job.res); continue; }
      const r = reserve(job.want);
      if (!r) { if (stats.inflight > 0) break; queue.shift(); clearTimeout(job.timer); capReply(job.res); continue; }
      queue.shift(); clearTimeout(job.timer);
      stats.inflight++;
      job.start(r, () => { stats.inflight--; pump(); });
    }
  };

  const srv = http.createServer((req, res) => {
    // Host 釘死:擋 DNS rebinding(內建瀏覽器裡的網頁把自己的網域解析成 127.0.0.1 打進來)
    if (req.headers.host !== `127.0.0.1:${port}` || typeof req.url !== "string" || req.url[0] !== "/") {
      stats.rejected++; return anthropicError(res, 400, "invalid_request_error", "bad request target", true);
    }
    if (revoked || !tokenOk(req, token)) { stats.rejected++; return anthropicError(res, 403, "permission_error", "relay token invalid", true); }
    const pathname = req.url.split("?")[0];
    if (req.method !== "POST" || pathname !== "/v1/messages") { stats.rejected++; return anthropicError(res, 404, "not_found_error", "not found", true); }
    if (capHard()) return capReply(res);
    // 太大:讀完丟掉再回 413(邊讀邊回,客戶端還在寫會收到 reset 而不是 413);大到離譜才直接斷
    const bufs = []; let size = 0, tooBig = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > limits.maxBodyBytes) { tooBig = true; bufs.length = 0; if (size > 4 * limits.maxBodyBytes) req.destroy(); return; }
      bufs.push(c);
    });
    req.on("end", () => {
      if (tooBig) { stats.rejected++; return anthropicError(res, 413, "request_too_large", "request body too large", true); }
      let body;
      try { body = JSON.parse(Buffer.concat(bufs).toString("utf8")); } catch (_) { body = null; }
      if (!body || typeof body !== "object" || Array.isArray(body)) return anthropicError(res, 400, "invalid_request_error", "body must be a JSON object", true);
      // 型錄外的 id 不回 400(回 400 整輪就死),跟其他幕後請求一起改寫成便宜那顆、關思考
      const from = body.model;
      if (thinkingPolicy(p, body, req.headers["x-blave-purpose"])) stats.background++;
      if (from !== body.model) { onEvent({ type: "model_rewrite", from: String(from).slice(0, 80), to: body.model }); stats.rewrites++; }
      // 沒有 max_tokens 就沒辦法預扣;上游本來也會 400
      if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return anthropicError(res, 400, "invalid_request_error", "max_tokens must be a positive integer", true);
      const base = { "content-type": "application/json" };
      for (const h of FWD_HEADERS) if (typeof req.headers[h] === "string") base[h] = req.headers[h];
      if (!base["anthropic-version"]) base["anthropic-version"] = "2023-06-01";
      base[p.authHeader] = p.authHeader === "authorization" ? "Bearer " + key : key;

      // resv / resvSent:目前這筆的預扣與它送出去了沒(退避中的重送已預扣、還沒送)
      let curReq = null, timer = null, gone = false, resv = null, resvSent = false, release = null, pinger = null;
      const stopPing = () => { clearInterval(pinger); pinger = null; };
      const finish = () => { stopPing(); if (release) { const r = release; release = null; r(); } };
      res.on("close", () => {
        if (res.writableFinished) return finish();
        gone = true; clearTimeout(timer);
        if (resv && !resvSent) resv.done(0, true);   // 送出去的由上游那條路結算(照預扣或實際,取大)
        if (curReq) curReq.destroy();
        finish();
      });
      res.on("finish", finish);
      // held:{ status, headers, chunks } 一則還沒交給引擎的空回應;重送不成就把它原樣交出去
      const replay = (held) => {
        stopPing();
        if (!res.headersSent) res.writeHead(held.status, held.headers);
        for (const c of held.chunks) res.write(c);
        res.end();
      };
      const retryOr = (n, held, stopReason) => {
        // 撞到長度上限的空回應重送也是一樣的結果,只會再燒一次
        if (stopReason === "max_tokens" || gone) return replay(held);
        if (n >= limits.emptyRetries) { onEvent({ type: "empty_giveup", attempts: n + 1 }); return replay(held); }
        if (!capHard() && avail() < limits.minOutputTokens && stats.inflight > 1) return replay(held);   // 額度被別筆的預扣佔著:不算到上限
        const r = capHard() ? null : reserve(body.max_tokens);
        if (!r) {
          // 引擎拿到空回應多半就收尾、不會再來撞 429:在這裡就記上限,turn_failed 才會是 cap 而不是沒回覆
          stats.capHit = true; onEvent({ type: "cap", requests: stats.requests, outputTokens: stats.outputTokens });
          return replay(held);
        }
        stats.emptyRetries++;
        onEvent({ type: "empty_retry", attempt: n + 1 });
        resv = r; resvSent = false;
        timer = setTimeout(() => send(n + 1, held, r), limits.emptyBackoffMs * (n + 1));
      };
      const send = (n, prev, r) => {
        if (gone) { r.done(0, true); return; }
        resv = r; resvSent = true; stats.requests++;
        const out = Buffer.from(JSON.stringify({ ...body, max_tokens: r.max }));
        const headers = { ...base, "content-length": out.length };
        let sent = false;
        const upReq = curReq = agent.request({ protocol: up.protocol, hostname: up.hostname, port: up.port || undefined,
          method: "POST", path: p.prefix + "/v1/messages", headers, timeout: UPSTREAM_TIMEOUT_MS }, (upRes) => {
          const status = upRes.statusCode || 502, rh = {};
          for (const [k, v] of Object.entries(upRes.headers)) if (!DROP_HEADERS.test(k)) rh[k] = v;
          const ct = String(upRes.headers["content-type"] || "");
          // output_tokens:message_delta 帶的是這則訊息的累計值,取最大;只算數,不改內容
          let maxOut = 0, tail = "", ended = false;
          const count = () => { resv = null; r.done(maxOut, ended); };
          const sniff = (c) => {
            const t = tail + c.toString("latin1");
            for (const m of t.matchAll(/"output_tokens"\s*:\s*(\d+)/g)) maxOut = Math.max(maxOut, Number(m[1]));
            tail = t.slice(-40);
          };
          upRes.on("end", () => { ended = true; });   // 掛在最前面:下面各分支的 end 會先看到 ended
          upRes.on("close", count);   // 中途斷掉的那一筆照預扣值算
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

          // 串流:有輸出之前先扣著,有輸出就把扣著的一起放、之後原樣轉。扣著時 header 連同第一個 ping 立刻出去
          // (沒寫內文 Node 不送 header),之後每 pingMs 一個、重送退避期間也送;SDK 會略過 ping
          if (!res.headersSent) { res.writeHead(status, rh); res.write(PING); }
          if (!pinger) pinger = setInterval(() => { if (!res.writableEnded) res.write(PING); }, limits.pingMs);
          const dec = new StringDecoder("utf8");
          let buf = "", live = false, stopReason = null;
          const goLive = () => { live = true; stopPing(); for (const c of held.chunks) res.write(c); held.chunks = []; };
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
          });
          upRes.on("end", () => {
            count();
            if (live) return res.end();
            if (buf.trim() && sseEventState(buf) === true) { goLive(); return res.end(); }
            retryOr(n, held, stopReason);
          });
          upRes.on("error", () => { if (!live) goLive(); res.destroy(); });
        });
        upReq.on("finish", () => { sent = true; });   // 請求整個寫出去了:之後的錯,上游可能已經在生成
        upReq.on("timeout", () => upReq.destroy(new Error("upstream timeout")));
        upReq.on("error", (e) => {
          // 連上之前就失敗(連不到、DNS)= 上游沒生成;連上之後的錯照預扣值算
          if (!upReq.res) { resv = null; r.done(0, !sent); }
          if (gone) return;
          onEvent({ type: "upstream_error", code: e && e.code ? String(e.code) : "ERR" });
          if (prev && !upReq.res) return replay(prev);
          if (!res.headersSent) anthropicError(res, 502, "api_error", "upstream unreachable", false); else res.destroy();
        });
        upReq.end(out);
      };
      const job = { res, want: body.max_tokens, gone: false, timer: null,
        start(r, rel) { release = rel; if (gone) { r.done(0, true); return finish(); } send(0, null, r); } };
      if (queue.length >= limits.maxQueued) return busyReply(res);
      res.on("close", () => { job.gone = true; clearTimeout(job.timer); });
      job.timer = setTimeout(() => { job.gone = true; if (!res.headersSent) busyReply(res); }, limits.maxQueueMs);
      queue.push(job); stats.queued = Math.max(stats.queued, queue.length);
      pump();
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

/* 「連結」:主行程拿用戶剛貼的金鑰直接打供應商一次最小請求(不經轉送口、不經 agent),驗過才存。
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

module.exports = { startRelay, verifyKey, thinkingPolicy, PRESETS, DEFAULT_LIMITS };
